/**
 * Player movement / EN / QB / glide / flight. OWNER: player agent. SPEC §6, §7.
 * State lives in GameState.player (PlayerState / MovementState in types.ts).
 *
 * Tick contract (docs/ARCH.md §4): playerBeginTick (edge inputs at time T) -> [beam pays EN] -> playerIntegrate (T -> T+dt).
 * Positions are integrated with the mean velocity (trapezoid rule), exact for the constant-acceleration segments used here.
 */
import { GLIDE_ACCEL_AIR, GLIDE_ACCEL_GROUND, GRAVITY, PLAYER, SIM, WEAPONS } from '../config';
import { pushEvent } from './combat';
import { clamp, forwardFromYaw, isFiniteV3, rightFromYaw } from './math';
import type { EffectiveStats, GameState, IWorld, Loadout, PlayerState, V2, V3 } from './types';

/** time / EN comparison tolerance (docs/ARCH.md §3) */
const TIME_EPS = 1e-9;
const EN_EPS = 1e-9;
/**
 * The collision box is PLAYER.HALF shrunk by SHRINK so a pose that merely touches a surface (e.g. spawned exactly on a floor)
 * is outside the swept box (the world treats <=1e-7 penetration as touching and would let us through).
 */
const SHRINK = 5e-5;
/** after each contact we stand SKIN off the surface, so float noise can never leave us inside the swept box */
const SKIN = 1e-5;
const COLLIDE_HALF: V3 = { x: PLAYER.HALF.x - SHRINK, y: PLAYER.HALF.y - SHRINK, z: PLAYER.HALF.z - SHRINK };
const MAX_SLIDE_ITER = 5;
/** leg animation: metres of ground travelled per walkPhase cycle (cosmetic only, not a gameplay parameter) */
const WALK_STRIDE_M = 2.4;

export function createPlayerState(_loadout: Loadout, stats: EffectiveStats, start: { pos: V3; yaw: number }): PlayerState {
  return {
    pos: { ...start.pos },
    prevPos: { ...start.pos },
    vel: { x: 0, y: 0, z: 0 },
    yaw: start.yaw,
    pitch: -0.1,
    bodyYaw: start.yaw,
    grounded: true,
    hp: PLAYER.MAX_HP,
    en: stats.maxEn,
    weapon: 'machinegun',
    ammo: { machinegun: WEAPONS.machinegun.totalAmmo, missile: WEAPONS.missile.totalAmmo },
    nextFireAt: { machinegun: 0, beam: 0, missile: 0 },
    mv: {
      horizontalMode: 'walk',
      verticalMode: 'grounded',
      glideEnabled: false,
      desiredDir: { x: 0, z: 0 },
      glideDir: { x: 0, z: 0 },
      qbSuccessCount: 0,
      qbLastStartedAt: null,
      qbImpulseRemaining: 0,
      qbDir: { x: 0, z: 0 },
      qbCooldownRemaining: 0,
      lastEnSpentAt: null,
      prevInput: { qb: false, shift: false, jump: false },
      jumpHeldSeconds: 0,
      thrusting: false,
      braking: false,
    },
    walkPhase: 0,
    internal: {},
  };
}

/** WASD -> unit horizontal direction in the camera's yaw frame ({0,0} when there is no net input). Pitch is ignored on purpose. */
function inputDirection(state: GameState): V2 {
  const inp = state.input;
  const ix = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
  const iz = (inp.forward ? 1 : 0) - (inp.back ? 1 : 0);
  if (ix === 0 && iz === 0) return { x: 0, z: 0 };
  const f = forwardFromYaw(state.player.yaw);
  const r = rightFromYaw(state.player.yaw);
  const x = f.x * iz + r.x * ix;
  const z = f.z * iz + r.z * ix;
  const l = Math.hypot(x, z);
  if (!(l > 1e-12)) return { x: 0, z: 0 };
  return { x: x / l, z: z / l };
}

const hasDir = (d: V2): boolean => d.x !== 0 || d.z !== 0;

/**
 * mv.desiredDir = the direction the horizontal movement system is currently heading (unit vector in the world x/z frame, i.e. the
 * camera-yaw-based direction that was resolved when it was set), reported as snapshot.player.movement.desiredHorizontalDirection.
 * SPEC §10 "方向がなければ[0, 0]" is about the absence of a movement direction (not of key presses): §7.2 keeps the mech moving
 * along the QB direction with every key released, and §7.1/§7.3 keep the last direction while gliding. So:
 *  - brake active (Ctrl held, not in the QB impulse): the target velocity is 0 (brake beats WASD, §7.3) -> [0, 0]
 *  - QB impulse: the QB direction (WASD cannot change it, §7.2)
 *  - WASD held: that direction (walk target, or the new glide target once the impulse is over)
 *  - no WASD but glide on (manual Shift glide or the automatic glide after a QB, incl. the inertial deceleration): the held
 *    glideDir; walking with no input: [0, 0]
 */
function headingDirection(mv: PlayerState['mv'], input: V2, braking: boolean): V2 {
  if (braking) return { x: 0, z: 0 };
  if (mv.qbImpulseRemaining > TIME_EPS) return { x: mv.qbDir.x, z: mv.qbDir.z };
  if (hasDir(input)) return { x: input.x, z: input.z };
  if (mv.glideEnabled) return { x: mv.glideDir.x, z: mv.glideDir.z };
  return { x: 0, z: 0 };
}

/** brake decides the horizontal target (SPEC §7.3): Ctrl held and not inside the QB impulse (the impulse ignores the brake) */
const brakeActive = (ctrl: boolean, mv: PlayerState['mv']): boolean => ctrl && mv.qbImpulseRemaining <= TIME_EPS;

function cooldownRemainingAt(mv: PlayerState['mv'], now: number): number {
  if (mv.qbLastStartedAt === null) return 0;
  const r = mv.qbLastStartedAt + PLAYER.QB.COOLDOWN - now;
  return r > TIME_EPS ? r : 0;
}

/**
 * Step A2a (state at time T = state.time): handle EDGE-triggered inputs using state.input levels vs mv.prevInput:
 * QB start (pay 36 EN first, sets qbImpulseRemaining, direction, cooldown, lastEnSpentAt = T), glide toggle, jump start.
 * MUST run before playerFireStep so the EN order is QB -> beam -> flight (SPEC §6).
 */
export function playerBeginTick(state: GameState): void {
  const p = state.player;
  const mv = p.mv;
  const inp = state.input;
  const T = state.time;
  const mult = state.stats.horizontalSpeedMultiplier;

  p.en = clamp(p.en, 0, state.stats.maxEn);

  const qbEdge = inp.qb && !mv.prevInput.qb;
  const shiftEdge = inp.shift && !mv.prevInput.shift;
  const jumpEdge = inp.jump && !mv.prevInput.jump;

  const dir = inputDirection(state);
  const fwd = forwardFromYaw(p.yaw);

  // ---- QB: only on the rising edge of Q. A failed attempt changes nothing and is never queued.
  if (qbEdge) {
    const offCooldown = mv.qbLastStartedAt === null || T - mv.qbLastStartedAt >= PLAYER.QB.COOLDOWN - TIME_EPS;
    const canStart = offCooldown && p.en >= PLAYER.QB.COST - EN_EPS && !inp.ctrl && mv.qbImpulseRemaining <= TIME_EPS;
    if (canStart) {
      const d: V2 = hasDir(dir) ? dir : { x: fwd.x, z: fwd.z };
      const speed = PLAYER.QB.SPEED * mult;
      // SET (never add) the horizontal velocity; vertical velocity is untouched.
      p.vel.x = d.x * speed;
      p.vel.z = d.z * speed;
      p.en = Math.max(0, p.en - PLAYER.QB.COST);
      mv.lastEnSpentAt = T;
      mv.qbLastStartedAt = T;
      mv.qbSuccessCount += 1;
      mv.qbImpulseRemaining = PLAYER.QB.DURATION;
      mv.qbDir = { x: d.x, z: d.z };
      mv.horizontalMode = 'quickboost';
      mv.braking = false;
      pushEvent(state, { type: 'qb', time: T, pos: { ...p.pos }, dir: { x: d.x, y: 0, z: d.z } });
    }
  }

  // ---- Shift: glide toggle (ignored during the QB impulse; brake has priority while Ctrl is held)
  if (shiftEdge && mv.qbImpulseRemaining <= TIME_EPS && !inp.ctrl) {
    if (!mv.glideEnabled) {
      mv.glideEnabled = true;
      const d: V2 = hasDir(dir) ? dir : { x: fwd.x, z: fwd.z };
      mv.glideDir = { x: d.x, z: d.z };
    } else {
      mv.glideEnabled = false;
    }
  }

  // ---- Space: hold timer restarts on every press; a jump only happens on the press edge while grounded
  if (!inp.jump || jumpEdge) mv.jumpHeldSeconds = 0;
  if (jumpEdge && p.grounded) {
    p.vel.y = PLAYER.JUMP_SPEED;
    p.grounded = false;
    mv.verticalMode = 'rising';
    pushEvent(state, { type: 'jump', time: T, pos: { ...p.pos } });
  }

  mv.prevInput.qb = inp.qb;
  mv.prevInput.shift = inp.shift;
  mv.prevInput.jump = inp.jump;
  mv.qbCooldownRemaining = cooldownRemainingAt(mv, T);

  // heading after this tick's edge inputs (a QB / glide toggle just handled is already reflected); playerIntegrate refreshes it
  const heading = headingDirection(mv, dir, brakeActive(inp.ctrl, mv));
  mv.desiredDir.x = heading.x;
  mv.desiredDir.z = heading.z;
}

interface Approach {
  vx: number;
  vz: number;
  dx: number;
  dz: number;
}

/**
 * Move the horizontal velocity toward the target by at most maxAccel*h (vector-length limited, never overshoots) and
 * return the exact displacement over h (the velocity is linear until it arrives, then constant).
 */
function approachVelocity(vx: number, vz: number, tx: number, tz: number, maxAccel: number, h: number): Approach {
  const ex = tx - vx;
  const ez = tz - vz;
  const dist = Math.hypot(ex, ez);
  const maxDv = maxAccel * h;
  if (dist <= maxDv) {
    const tr = dist / maxAccel; // arrival time within the step
    return { vx: tx, vz: tz, dx: 0.5 * (vx + tx) * tr + tx * (h - tr), dz: 0.5 * (vz + tz) * tr + tz * (h - tr) };
  }
  const k = maxDv / dist;
  const nx = vx + ex * k;
  const nz = vz + ez * k;
  return { vx: nx, vz: nz, dx: 0.5 * (vx + nx) * h, dz: 0.5 * (vz + nz) * h };
}

/** vertical motion over one tick: gravity, then flight thrust (vy = ascent) during [thrustStart, thrustEnd], then gravity again */
function integrateVertical(vy0: number, dt: number, thrustStart: number, thrustEnd: number): { vy: number; dy: number } {
  let vy = vy0;
  let dy = 0;
  const a = thrustStart;
  if (a > 0) {
    dy += vy * a - 0.5 * GRAVITY * a * a;
    vy -= GRAVITY * a;
  }
  const b = thrustEnd - thrustStart;
  if (b > 0) {
    dy += PLAYER.FLIGHT_ASCENT * b;
    vy = PLAYER.FLIGHT_ASCENT;
  }
  const c = dt - thrustEnd;
  if (c > 1e-12) {
    dy += vy * c - 0.5 * GRAVITY * c * c;
    vy -= GRAVITY * c;
  }
  return { vy, dy };
}

interface MoveResult {
  floor: boolean;
  /** downward speed at the floor contact (0 when no floor contact) */
  impactSpeed: number;
}

/**
 * Swept AABB movement with sliding: on contact keep only the motion/velocity that is not into the surface
 * (no bounce, no wall-clipping). Mutates pos and vel.
 */
function moveWithCollision(world: IWorld, pos: V3, vel: V3, delta: V3): MoveResult {
  let rx = delta.x;
  let ry = delta.y;
  let rz = delta.z;
  let floor = false;
  let impactSpeed = 0;
  for (let i = 0; i < MAX_SLIDE_ITER; i++) {
    if (rx * rx + ry * ry + rz * rz < 1e-24) break;
    const hit = world.sweepAABB(pos, COLLIDE_HALF, { x: rx, y: ry, z: rz });
    if (!hit) {
      pos.x += rx;
      pos.y += ry;
      pos.z += rz;
      break;
    }
    const t = clamp(hit.t, 0, 1);
    const n = hit.normal;
    pos.x += rx * t + n.x * SKIN;
    pos.y += ry * t + n.y * SKIN;
    pos.z += rz * t + n.z * SKIN;
    const rest = 1 - t;
    rx *= rest;
    ry *= rest;
    rz *= rest;
    const dn = rx * n.x + ry * n.y + rz * n.z;
    if (dn < 0) {
      rx -= dn * n.x;
      ry -= dn * n.y;
      rz -= dn * n.z;
    }
    const vn = vel.x * n.x + vel.y * n.y + vel.z * n.z;
    if (vn < 0) {
      if (n.y > 0.5) impactSpeed = Math.max(impactSpeed, -vn);
      vel.x -= vn * n.x;
      vel.y -= vn * n.y;
      vel.z -= vn * n.z;
    }
    if (n.y > 0.5) floor = true;
  }
  return { floor, impactSpeed };
}

/**
 * Step B1: integrate the player over [T, T+dt] (dt = SIM.DT): horizontal target/accel limits, QB impulse -> auto glide,
 * jump/flight thrust (consumes remaining EN AFTER QB and beam), gravity, swept collision, grounded detection,
 * EN regeneration rules, mv.* bookkeeping, cooldown. Uses mean-velocity (trapezoid) position integration.
 */
export function playerIntegrate(state: GameState, world: IWorld): void {
  const p = state.player;
  const mv = p.mv;
  const inp = state.input;
  const dt = SIM.DT;
  const T = state.time;
  const mult = state.stats.horizontalSpeedMultiplier;
  const startGrounded = p.grounded;

  const dir = inputDirection(state);

  // ---------------------------------------------------------------- flight thrust window (EN left after QB and beam)
  let thrustStart = dt;
  let thrustEnd = dt;
  let tau = 0;
  if (inp.jump && p.en > EN_EPS) {
    const untilFlight = PLAYER.FLIGHT_HOLD_SECONDS - mv.jumpHeldSeconds;
    const s = untilFlight > TIME_EPS ? untilFlight : 0;
    if (dt - s > TIME_EPS) {
      // only the affordable part of the tick is thrust; the rest stays under gravity (no free ascent)
      tau = Math.min(dt - s, p.en / PLAYER.FLIGHT_EN_PER_SEC);
      if (tau > 1e-12) {
        thrustStart = s;
        thrustEnd = s + tau;
      } else {
        tau = 0;
      }
    }
  }
  if (tau > 0) {
    const left = p.en - PLAYER.FLIGHT_EN_PER_SEC * tau;
    p.en = left <= EN_EPS ? 0 : left;
    mv.lastEnSpentAt = T + thrustEnd;
  }
  mv.thrusting = tau > 0;

  // ---------------------------------------------------------------- horizontal motion
  let vx = p.vel.x;
  let vz = p.vel.z;
  let dx = 0;
  let dz = 0;
  let left = dt;
  const boosting = mv.qbImpulseRemaining > TIME_EPS;
  let brakeThisTick = false;

  if (boosting) {
    // impulse: hold the current velocity (no acceleration, lost speed is never re-granted)
    let h = Math.min(left, mv.qbImpulseRemaining);
    if (left - h < TIME_EPS) h = left;
    dx += vx * h;
    dz += vz * h;
    left -= h;
    const rem = mv.qbImpulseRemaining - h;
    if (rem < TIME_EPS) {
      // impulse over: ALWAYS glide on, keep the velocity vector, glide direction = QB direction
      mv.qbImpulseRemaining = 0;
      mv.glideEnabled = true;
      mv.glideDir = { x: mv.qbDir.x, z: mv.qbDir.z };
    } else {
      mv.qbImpulseRemaining = rem;
    }
  }

  if (left > TIME_EPS) {
    const grounded = p.grounded;
    brakeThisTick = inp.ctrl && !boosting;
    let tx = 0;
    let tz = 0;
    let accel = PLAYER.WALK_ACCEL * mult;
    if (brakeThisTick) {
      // brake: glide off, decelerate to 0 (priority over WASD)
      mv.glideEnabled = false;
    } else if (mv.glideEnabled) {
      if (!boosting && hasDir(dir)) mv.glideDir = { x: dir.x, z: dir.z };
      const speed = (grounded ? PLAYER.GLIDE_SPEED_GROUND : PLAYER.AIR_SPEED) * mult;
      tx = mv.glideDir.x * speed;
      tz = mv.glideDir.z * speed;
      accel = (grounded ? GLIDE_ACCEL_GROUND : GLIDE_ACCEL_AIR) * mult;
    } else {
      const speed = (grounded ? PLAYER.WALK_SPEED : PLAYER.AIR_SPEED) * mult;
      tx = dir.x * speed;
      tz = dir.z * speed;
    }
    const a = approachVelocity(vx, vz, tx, tz, accel, left);
    vx = a.vx;
    vz = a.vz;
    dx += a.dx;
    dz += a.dz;
  }
  mv.braking = brakeThisTick;
  mv.horizontalMode = mv.qbImpulseRemaining > TIME_EPS ? 'quickboost' : brakeThisTick ? 'walk' : mv.glideEnabled ? 'glide' : 'walk';
  // where the horizontal system is heading at the end of this tick (SPEC §10 desiredHorizontalDirection, see headingDirection)
  const heading = headingDirection(mv, dir, brakeThisTick);
  mv.desiredDir.x = heading.x;
  mv.desiredDir.z = heading.z;

  // ---------------------------------------------------------------- vertical motion
  const vert = integrateVertical(p.vel.y, dt, thrustStart, thrustEnd);

  // ---------------------------------------------------------------- swept collision
  const pos: V3 = { x: p.pos.x, y: p.pos.y, z: p.pos.z };
  const vel: V3 = { x: vx, y: vert.vy, z: vz };
  const res = moveWithCollision(world, pos, vel, { x: dx, y: vert.dy, z: dz });
  if (!isFiniteV3(pos) || !isFiniteV3(vel)) {
    // never let NaN/Infinity into the state
    vel.x = 0;
    vel.y = 0;
    vel.z = 0;
    pos.x = p.pos.x;
    pos.y = p.pos.y;
    pos.z = p.pos.z;
  }
  const stepDist = Math.hypot(pos.x - p.pos.x, pos.z - p.pos.z);
  p.pos.x = pos.x;
  p.pos.y = pos.y;
  p.pos.z = pos.z;
  p.vel.x = vel.x;
  p.vel.y = vel.y;
  p.vel.z = vel.z;
  p.grounded = res.floor;
  if (res.floor && !startGrounded) {
    pushEvent(state, { type: 'land', time: T, pos: { ...p.pos }, impactSpeed: res.impactSpeed });
  }
  mv.verticalMode = p.grounded ? 'grounded' : mv.thrusting ? 'flying' : p.vel.y > 0 ? 'rising' : 'falling';
  if (p.grounded) p.walkPhase += (stepDist * (2 * Math.PI)) / WALK_STRIDE_M;

  // ---------------------------------------------------------------- EN regeneration (only while grounded, after the 0.75 s delay)
  if (startGrounded && p.grounded) {
    const from = mv.lastEnSpentAt === null ? T : Math.max(T, mv.lastEnSpentAt + PLAYER.EN_REGEN_DELAY);
    const secs = T + dt - from; // only the part of the tick after the delay counts
    if (secs > TIME_EPS) p.en += state.stats.regenPerSecond * Math.min(secs, dt);
  }
  p.en = clamp(p.en, 0, state.stats.maxEn);

  // ---------------------------------------------------------------- bookkeeping at time T+dt
  mv.jumpHeldSeconds = inp.jump ? mv.jumpHeldSeconds + dt : 0;
  mv.qbCooldownRemaining = cooldownRemainingAt(mv, T + dt);
}
