/**
 * Player movement, EN management, quick boost, glide, brake, jump and flight
 * (docs/SPEC.md §6, §7; docs/ARCHITECTURE.md §3 and §4 "player.ts").
 *
 * Time model
 *   `applyPlayerInputEdges` runs at the START time t0 of a sub-step (sim.time = t0) and performs the
 *   instantaneous actions: QB start, glide toggle, jump. `updatePlayer` then moves the player over
 *   [t0, t0 + h]. `playerNextEventTime` reports the instants at which the continuous motion changes regime
 *   (end of the QB impulse, Space hold reaching the flight threshold, start of EN regeneration); the
 *   scheduler ends sub-steps exactly there. `updatePlayer` additionally splits its own interval at the same
 *   instants, so a direct call that straddles one of them is integrated just as exactly.
 *
 * Horizontal motion
 *   Three modes: `quickboost` (0.15 s impulse: the velocity is held, only collisions change it; steering,
 *   brake and the glide toggle are not executed), `glide` and `walk` (brake = walk with target 0 and the
 *   glide switched off). In glide and walk the velocity VECTOR moves straight towards the target vector at
 *   a bounded rate. Inside a segment that motion is integrated in closed form (trapezoid, with the exact
 *   instant at which the target is reached), so the travelled distance does not depend on how time is cut:
 *   a flat-ground QB covers 80·0.15 + (80+22)/2·0.60 = 42.6 m in 0.75 s (× legs multiplier).
 *
 * Vertical motion
 *   Independent of the horizontal mode. Grounded: no vertical motion, contact is re-checked with
 *   `world.probeGround` after every move (walking off an edge starts a fall). Airborne: ballistic
 *   (`Δy = vy·h − ½·18·h²`, exact) or thrust (vy = 8 m/s for the affordable part of the segment, then
 *   ballistic from 8 m/s for the rest — no free climb). The legs multiplier never touches vertical numbers.
 *
 * EN
 *   QB: 36 at the press (first in the priority order). Flight: 20 EN/s out of `en − enReserve`, where the
 *   reserve is what a beam shot due at the end of the sub-step needs (QB → beam → flight). Glide: 0, always.
 *   Regeneration: grounded for the whole segment, nothing spent in it, and at least 0.75 s after the last
 *   actual expenditure; never in the air.
 *   The two continuous changes (regeneration, flight drain) are "ramps": while one runs, EN is evaluated in
 *   closed form from the instant it began (`en = en₀ + rate·(t − t₀)`) and stored on a fixed lattice of
 *   1/(120·2²³) EN (`quantizeEn`). Nothing is summed tick by tick, so no rounding error builds up: at the
 *   instant the tank should hold exactly 36 (or 8) it holds exactly 36 (8) and the strict `en >= cost`
 *   tests of the QB and the beam decide correctly. The thresholds themselves have no tolerance.
 *
 * Space hold
 *   `jumpHeldSince` is the time the current hold began (null while released). Flight needs the mech to be
 *   AIRBORNE with Space held for at least 0.20 s since that time. A hold never lifts a standing mech off
 *   the ground (leaving the ground takes a jump = a Space press edge while grounded), but it stays valid
 *   through a landing: a mech that walks off an edge with Space still down thrusts at once.
 */
import {
  DEFAULT_WEAPON,
  GLIDE_ACCEL_AIR,
  GLIDE_ACCEL_GROUND,
  GRAVITY,
  PLAYER,
  TICK,
  TICK_HZ,
  TIME_EPS,
  WEAPONS,
} from '../config';
import { clone, copy, forwardFromYaw, rightFromYaw, set, v3, type V3 } from '../core/vec';
import type { Sim } from './sim';
import type { PlayerState, QbRejectReason } from './types';
import { CONTACT_EPS, SKIN, type MoveResult } from './world';

interface Dir2 {
  x: number;
  z: number;
}

/**
 * Reach of the "am I standing on something" probe below the feet (m). Comfortably above SKIN (the gap a
 * landing leaves) and above the 1 mm at which stages place the spawn point over the floor. A grounded mech is
 * never moved vertically: a mech that stands still keeps its position — and its muzzle — exactly.
 */
const GROUND_PROBE = 0.02;
/**
 * A fall that ends at most this far above a supporting surface has landed (m). `moveBox` puts a landing
 * mech down SKIN above the floor and reports the contact only when the sweep would go below that height; a
 * fall whose sweep happens to end inside that gap is on (or below) its resting height all the same.
 * CONTACT_EPS is the world's own tolerance for "touching".
 */
const LANDING_GAP = SKIN + CONTACT_EPS;
/** Velocity differences below this (m/s) count as "target reached" (absorbs floating-point noise only). */
const SPEED_SNAP = 1e-9;
/** Thrusters do not fire for less EN than this (avoids a flickering zero-length thrust at an empty tank). */
const EN_MIN_THRUST = 1e-9;
/** Below this horizontal speed (m/s) a velocity has no usable direction. */
const DIR_MIN_SPEED = 1e-6;
/** Hard upper bound on the internal segments of one updatePlayer call (an over-long call ends in one big segment). */
const MAX_SEGMENTS = 4096;

const _f = v3();
const _r = v3();
const _delta = v3();
const _move: MoveResult = { nx: 0, ny: 0, nz: 0 };
const _in: Dir2 = { x: 0, z: 0 };
const _disp: Dir2 = { x: 0, z: 0 };

/**
 * EN is stored in steps of 1/EN_STEPS_PER_EN (≈ 9.9e-10 EN). Every amount that a whole tick can add or
 * remove (rate / 120 for the regeneration rates 20, 15, 11.25, 10, 7.5 EN/s and the flight drain of
 * 20 EN/s) and the costs 36 and 8 are exact multiples of that step, so a sequence of whole-tick actions
 * is exact arithmetic; integer amounts are exact floats.
 */
const EN_STEPS_PER_EN = TICK_HZ * 2 ** 23;

/** Nearest EN lattice value (see EN_STEPS_PER_EN). Only ever applied to a value that is being written. */
function quantizeEn(en: number): number {
  return Math.round(en * EN_STEPS_PER_EN) / EN_STEPS_PER_EN;
}

/**
 * State that is not part of the PlayerState contract: the running continuous EN change ("ramp").
 * `PlayerState.en` stays the one and only tank — the ramp merely remembers from where the current
 * regeneration / flight drain is being measured, and it starts afresh whenever anything else touched `en`.
 */
interface PlayerPrivate {
  /** EN/s of the ramp that covered the previous segment: > 0 regeneration, < 0 flight drain, 0 = none. */
  enRate: number;
  /** `en` and time at the start of that ramp. */
  enAnchor: number;
  enAnchorAt: number;
  /** End time of the segment the ramp was last applied to (a ramp only continues without a gap). */
  enRampEnd: number;
  /** `en` as the ramp last wrote it (a different value means a QB, a beam shot or a caller changed it). */
  enWritten: number;
}
const PRIVATE = new WeakMap<PlayerState, PlayerPrivate>();
function privateOf(p: PlayerState): PlayerPrivate {
  let s = PRIVATE.get(p);
  if (!s) {
    s = { enRate: 0, enAnchor: 0, enAnchorAt: 0, enRampEnd: 0, enWritten: 0 };
    PRIVATE.set(p, s);
  }
  return s;
}

/**
 * EN at `te` if the continuous change of `rate` EN/s lasts for the whole segment [ts, te]: the closed form
 * from the start of the ramp (not yet clamped or quantised). The ramp continues when the same rate was
 * applied up to `ts` and nobody else changed `en` since; otherwise it begins at (`p.en`, `ts`).
 */
function rampEn(st: PlayerPrivate, p: PlayerState, rate: number, ts: number, te: number): number {
  if (st.enRate !== rate || p.en !== st.enWritten || Math.abs(ts - st.enRampEnd) > TIME_EPS) {
    st.enRate = rate;
    st.enAnchor = p.en;
    st.enAnchorAt = ts;
  }
  st.enRampEnd = te;
  return st.enAnchor + rate * (te - st.enAnchorAt);
}

/** World-space muzzle for a player whose hit-box centre is `pos` and whose body yaw is `yaw`. */
export function computeMuzzle(pos: V3, yaw: number, out: V3): V3 {
  forwardFromYaw(yaw, _f);
  rightFromYaw(yaw, _r);
  const m = PLAYER.muzzleLocal;
  return set(
    out,
    pos.x + _r.x * m.right + _f.x * m.forward,
    pos.y + m.up,
    pos.z + _r.z * m.right + _f.z * m.forward,
  );
}

/** Fresh player at the stage's start position with full HP/EN/ammo for sim.loadout. */
export function createPlayer(sim: Sim): PlayerState {
  const start = sim.stage.playerStart;
  const pos = clone(start.position);
  // A start point in mid-air (isolated tests) begins falling instead of pretending to stand.
  const grounded = sim.world ? sim.world.probeGround(pos, PLAYER.half, GROUND_PROBE) !== Infinity : true;
  const p: PlayerState = {
    pos,
    prevPos: clone(pos),
    vel: v3(),
    grounded,
    hp: PLAYER.maxHp,
    en: sim.stats.maxEn,
    yaw: start.yaw,
    pitch: 0,
    weapon: DEFAULT_WEAPON,
    ammo: { machinegun: WEAPONS.machinegun.ammo, missile: WEAPONS.missile.ammo },
    nextFireAt: { machinegun: 0, beam: 0, missile: 0 },
    horizontalMode: 'walk',
    verticalMode: grounded ? 'grounded' : 'falling',
    glideEnabled: false,
    desiredDir: { x: 0, z: 0 },
    glideDir: { x: 0, z: 0 },
    qbDir: { x: 0, z: 0 },
    qbImpulseRemaining: 0,
    qbSuccessfulCount: 0,
    qbLastStartedAt: null,
    lastEnSpentAt: null,
    jumpHeldSince: null,
    flying: false,
    braking: false,
    muzzle: v3(),
  };
  computeMuzzle(p.pos, p.yaw, p.muzzle);
  privateOf(p);
  return p;
}

// ───────────────────────────── directions ─────────────────────────────

const finiteOr0 = (x: number): number => (Number.isFinite(x) ? x : 0);

/** Camera forward projected on the horizontal plane (unit XZ). Independent of the pitch. */
function cameraForward(p: PlayerState, out: Dir2): Dir2 {
  const yaw = finiteOr0(p.yaw);
  // "+ 0" turns a -0 into +0 so that directions print and compare cleanly.
  out.x = -Math.sin(yaw) + 0;
  out.z = -Math.cos(yaw) + 0;
  return out;
}

/**
 * WASD mapped through the camera yaw to a horizontal unit direction (diagonals normalised, pitch ignored).
 * Returns false (and leaves `out` alone) when there is no movement input.
 */
function inputDirection(sim: Sim, out: Dir2): boolean {
  const mx = finiteOr0(sim.input.moveX);
  const mz = finiteOr0(sim.input.moveZ);
  if (mx === 0 && mz === 0) return false;
  const yaw = finiteOr0(sim.player.yaw);
  const s = Math.sin(yaw);
  const c = Math.cos(yaw);
  // right = (cos yaw, -sin yaw), forward = (-sin yaw, -cos yaw)
  const x = c * mx - s * mz;
  const z = -s * mx - c * mz;
  const l = Math.hypot(x, z);
  if (!(l > 1e-9)) return false;
  out.x = x / l + 0;
  out.z = z / l + 0;
  return true;
}

function setDir(out: Dir2, x: number, z: number): void {
  out.x = x;
  out.z = z;
}

// ───────────────────────────── quick boost ─────────────────────────────

/** Absolute end time of the running impulse (`t` = current time, only used if the start time is unknown). */
function impulseEndTime(p: PlayerState, t: number): number {
  return p.qbLastStartedAt != null ? p.qbLastStartedAt + PLAYER.qbImpulseSeconds : t + p.qbImpulseRemaining;
}

/** Seconds until the next QB may start (0 when the cooldown is over or no QB was made yet). */
export function qbCooldownRemaining(sim: Sim): number {
  const last = sim.player.qbLastStartedAt;
  if (last == null) return 0;
  const r = last + PLAYER.qbCooldownSeconds - sim.time;
  return r > TIME_EPS ? r : 0;
}

/**
 * Why a QB requested at sim.time would be refused, or null when it would start. This is the very test the
 * Q press uses (HUD "QB ready" may call it; it changes nothing).
 */
export function qbBlockReason(sim: Sim): QbRejectReason | null {
  if (sim.input.brake) return 'brake';
  if (qbCooldownRemaining(sim) > 0) return 'cooldown';
  if (!(sim.player.en >= PLAYER.qbCost)) return 'no-en';
  return null;
}

function tryQuickBoost(sim: Sim, p: PlayerState, t: number): void {
  const reason = qbBlockReason(sim);
  if (reason) {
    // A failed press changes nothing: no EN, no cooldown, no recovery delay, and it is not remembered.
    sim.emit({ type: 'qb-rejected', reason });
    return;
  }
  if (!inputDirection(sim, _in)) cameraForward(p, _in);
  setDir(p.qbDir, _in.x, _in.z);
  // The horizontal velocity is SET (never added) to the boost speed; the vertical velocity is untouched.
  p.vel.x = _in.x * sim.stats.qbSpeed;
  p.vel.z = _in.z * sim.stats.qbSpeed;
  // (EN lattice value − 36 is exact in floating point; the max only guards a tank poked from outside.)
  p.en = Math.max(0, p.en - PLAYER.qbCost);
  p.lastEnSpentAt = t;
  p.qbLastStartedAt = t;
  p.qbSuccessfulCount++;
  p.qbImpulseRemaining = PLAYER.qbImpulseSeconds;
  p.horizontalMode = 'quickboost';
  p.braking = false;
  setDir(p.desiredDir, _in.x, _in.z);
  sim.emit({ type: 'qb', dir: { x: _in.x, z: _in.z }, airborne: !p.grounded });
}

/** End of the impulse: glide is forced on and inherits the velocity exactly as it is. */
function finishImpulse(sim: Sim, p: PlayerState): void {
  p.qbImpulseRemaining = 0;
  p.glideEnabled = true;
  const speed = Math.hypot(p.vel.x, p.vel.z);
  if (speed > DIR_MIN_SPEED) setDir(p.glideDir, p.vel.x / speed + 0, p.vel.z / speed + 0);
  else setDir(p.glideDir, p.qbDir.x, p.qbDir.z);
  p.horizontalMode = 'glide';
  p.braking = false;
  setDir(p.desiredDir, p.glideDir.x, p.glideDir.z);
  sim.emit({ type: 'glide', enabled: true, auto: true });
}

// ───────────────────────────── glide toggle / jump hold ─────────────────────────────

function toggleGlide(sim: Sim, p: PlayerState): void {
  // No mode change during the impulse; while Left Ctrl is held the brake keeps the glide off.
  if (p.qbImpulseRemaining > 0 || sim.input.brake) return;
  if (p.glideEnabled) {
    p.glideEnabled = false;
    p.horizontalMode = 'walk';
    sim.emit({ type: 'glide', enabled: false, auto: false });
    return;
  }
  if (!inputDirection(sim, _in)) cameraForward(p, _in);
  p.glideEnabled = true;
  setDir(p.glideDir, _in.x, _in.z);
  p.horizontalMode = 'glide';
  sim.emit({ type: 'glide', enabled: true, auto: false });
}

/** Keeps `jumpHeldSince` in step with the Space level (and with a press edge when there is one). */
function trackJumpHold(sim: Sim, p: PlayerState, t: number, pressed: boolean): void {
  if (!sim.input.jump) {
    p.jumpHeldSince = null;
    return;
  }
  if (pressed || p.jumpHeldSince == null || !Number.isFinite(p.jumpHeldSince) || p.jumpHeldSince > t + TIME_EPS) {
    // A new hold begins now (press edge, or the level went up without an edge).
    p.jumpHeldSince = t;
  }
}

// ───────────────────────────── edges ─────────────────────────────

/**
 * Consumes the edge inputs (qbPressed, glideTogglePressed, jumpPressed) at the current sim.time (= start
 * of the sub-step): QB start (cost 36 EN, cooldown, brake/impulse rules), glide toggle, jump.
 * Edges are always cleared, successful or not (never queued for later).
 */
export function applyPlayerInputEdges(sim: Sim): void {
  const inp = sim.input;
  const p = sim.player;
  const qb = inp.qbPressed === true;
  const toggle = inp.glideTogglePressed === true;
  const jump = inp.jumpPressed === true;
  inp.qbPressed = false;
  inp.glideTogglePressed = false;
  inp.jumpPressed = false;
  // Actions exist only while the sortie is being played; a press made otherwise is dropped, not kept.
  if (sim.status !== 'playing') return;

  const t = sim.time;
  // An impulse that is over at this instant must not swallow a Shift press made now.
  if (p.qbImpulseRemaining > 0 && impulseEndTime(p, t) - t <= TIME_EPS) finishImpulse(sim, p);

  if (qb) tryQuickBoost(sim, p, t);
  if (toggle) toggleGlide(sim, p);
  trackJumpHold(sim, p, t, jump);
  if (jump && p.grounded) {
    // Only ever from the ground: no upward kick is added in the air.
    p.vel.y = PLAYER.jumpSpeed;
    p.grounded = false;
    p.verticalMode = 'rising';
    sim.emit({ type: 'jump' });
  }
}

// ───────────────────────────── continuous motion ─────────────────────────────

/**
 * Moves the horizontal velocity (vx, vz) straight towards (tx, tz) at `accel` m/s² for `h` seconds and
 * returns the exact displacement in `disp` and the new velocity in `p.vel`. Never overshoots the target.
 */
function approachVelocity(p: PlayerState, tx: number, tz: number, accel: number, h: number, disp: Dir2): void {
  const vx = p.vel.x;
  const vz = p.vel.z;
  const dx = tx - vx;
  const dz = tz - vz;
  const dist = Math.hypot(dx, dz);
  const maxDv = accel * h;
  if (dist <= maxDv + SPEED_SNAP) {
    // Target reached after tau <= h: linear ramp for tau, then constant.
    const tau = accel > 0 ? Math.min(h, dist / accel) : 0;
    disp.x = 0.5 * (vx + tx) * tau + tx * (h - tau);
    disp.z = 0.5 * (vz + tz) * tau + tz * (h - tau);
    p.vel.x = tx;
    p.vel.z = tz;
  } else {
    const k = maxDv / dist;
    const nx = vx + dx * k;
    const nz = vz + dz * k;
    disp.x = 0.5 * (vx + nx) * h;
    disp.z = 0.5 * (vz + nz) * h;
    p.vel.x = nx;
    p.vel.z = nz;
  }
}

/** One segment [ts, ts + h] during which no player event falls strictly inside. */
function stepSegment(sim: Sim, p: PlayerState, ts: number, h: number, enReserve: number): void {
  const inp = sim.input;
  const st = privateOf(p);
  const stats = sim.stats;
  const legs = stats.horizontalSpeedMultiplier;
  const te = ts + h;

  trackJumpHold(sim, p, ts, false);
  if (p.qbImpulseRemaining > 0 && impulseEndTime(p, ts) - ts <= TIME_EPS) finishImpulse(sim, p);
  const groundedAtStart = p.grounded;

  // ── horizontal ──
  if (p.qbImpulseRemaining > 0) {
    // Impulse: the velocity is held (only a collision below can change it). No steering, brake or toggle.
    p.horizontalMode = 'quickboost';
    p.braking = false;
    setDir(p.desiredDir, p.qbDir.x, p.qbDir.z);
    _disp.x = p.vel.x * h;
    _disp.z = p.vel.z * h;
  } else {
    const hasInput = inputDirection(sim, _in);
    let tx = 0;
    let tz = 0;
    let accel = PLAYER.walkAccel * legs;
    if (inp.brake) {
      // Brake: glide off, walk state, target 0; WASD is ignored while Left Ctrl is held.
      if (p.glideEnabled) {
        p.glideEnabled = false;
        sim.emit({ type: 'glide', enabled: false, auto: false });
      }
      p.braking = true;
      p.horizontalMode = 'walk';
      setDir(p.desiredDir, 0, 0);
    } else if (p.glideEnabled) {
      p.braking = false;
      p.horizontalMode = 'glide';
      // WASD replaces the stored direction; a camera turn alone never does.
      if (hasInput) setDir(p.glideDir, _in.x, _in.z);
      else if (!(Math.hypot(p.glideDir.x, p.glideDir.z) > 0.5)) cameraForward(p, p.glideDir);
      const speed = p.grounded ? stats.glideSpeed : stats.airSpeed;
      tx = p.glideDir.x * speed;
      tz = p.glideDir.z * speed;
      accel = (p.grounded ? GLIDE_ACCEL_GROUND : GLIDE_ACCEL_AIR) * legs;
      setDir(p.desiredDir, p.glideDir.x, p.glideDir.z);
    } else {
      p.braking = false;
      p.horizontalMode = 'walk';
      if (hasInput) {
        const speed = p.grounded ? stats.walkSpeed : stats.airSpeed;
        tx = _in.x * speed;
        tz = _in.z * speed;
        setDir(p.desiredDir, _in.x, _in.z);
      } else {
        setDir(p.desiredDir, 0, 0);
      }
    }
    approachVelocity(p, tx, tz, accel, h, _disp);
  }

  // ── vertical ──
  let dy = 0;
  let thrustTime = 0;
  if (p.grounded) {
    p.vel.y = 0;
  } else {
    let vy = p.vel.y;
    const holdStart = p.jumpHeldSince;
    // Airborne (this branch) with Space held for 0.20 s or more since the hold began.
    const wantsFlight = inp.jump && holdStart != null && ts >= holdStart + PLAYER.flyHoldSeconds - TIME_EPS;
    if (wantsFlight) {
      // Flight is last in the EN order: it may only use what the QB (already paid) and a due beam leave.
      const available = p.en - enReserve;
      if (available > EN_MIN_THRUST) {
        const drain = PLAYER.flyEnPerSecond;
        const enAtEnd = rampEn(st, p, -drain, ts, te);
        if (enAtEnd >= enReserve) {
          // Affordable for the whole segment.
          thrustTime = h;
          p.en = quantizeEn(enAtEnd);
          st.enWritten = p.en;
        } else {
          // The tank reaches the reserve inside the segment: thrust exactly until then, not a moment longer.
          const paidUntil = st.enAnchorAt + (st.enAnchor - enReserve) / drain;
          thrustTime = Math.min(h, paidUntil - ts);
          if (!(thrustTime > 0)) thrustTime = Math.min(h, available / drain);
          p.en -= available;
          st.enRate = 0;
        }
      }
    }
    if (thrustTime > 0) {
      // Climb at 8 m/s for the paid time, then fall ballistically from that velocity for the rest.
      const rest = h - thrustTime;
      vy = PLAYER.flyClimbSpeed;
      dy = vy * thrustTime;
      if (rest > 0) {
        dy += vy * rest - 0.5 * GRAVITY * rest * rest;
        vy -= GRAVITY * rest;
      }
      p.lastEnSpentAt = thrustTime >= h ? te : ts + thrustTime;
    } else {
      dy = vy * h - 0.5 * GRAVITY * h * h;
      vy -= GRAVITY * h;
    }
    p.vel.y = vy;
  }

  // ── swept collision; a contact removes the velocity component pointing into it, for good ──
  set(_delta, _disp.x, dy, _disp.z);
  const res = sim.world.moveBox(p.pos, PLAYER.half, _delta, _move);
  if (res.nx !== 0 && p.vel.x * res.nx < 0) p.vel.x = 0;
  if (res.nz !== 0 && p.vel.z * res.nz < 0) p.vel.z = 0;
  if (p.grounded) {
    // Walked off an edge (nothing within reach below the feet): free fall from vy = 0 in the next segment.
    if (sim.world.probeGround(p.pos, PLAYER.half, GROUND_PROBE) === Infinity) p.grounded = false;
  } else if (
    res.ny > 0 ||
    // No contact was reported, but the fall ended inside the gap a landing leaves above the floor: the mech
    // is at (or below) its resting height, so it HAS landed — it must not hang there "falling" for a tick.
    (res.ny === 0 && p.vel.y <= 0 && sim.world.probeGround(p.pos, PLAYER.half, LANDING_GAP) !== Infinity)
  ) {
    const speed = p.vel.y < 0 ? -p.vel.y : 0;
    p.vel.y = 0;
    p.grounded = true;
    sim.emit({ type: 'land', speed });
  } else if (res.ny < 0 && p.vel.y > 0) {
    p.vel.y = 0;
  }

  // ── EN regeneration ──
  if (
    groundedAtStart &&
    p.grounded &&
    thrustTime === 0 &&
    p.en < stats.maxEn &&
    stats.regenPerSecond > 0 &&
    (p.lastEnSpentAt == null || ts >= p.lastEnSpentAt + PLAYER.enRegenDelaySeconds - TIME_EPS)
  ) {
    p.en = quantizeEn(rampEn(st, p, stats.regenPerSecond, ts, te));
    if (p.en > stats.maxEn) p.en = stats.maxEn;
    st.enWritten = p.en;
  } else if (thrustTime === 0) {
    // Neither regeneration nor thrust in this segment: whatever comes next starts a new ramp.
    st.enRate = 0;
  }
  if (!(p.en >= 0)) p.en = 0;
  else if (p.en > stats.maxEn) p.en = stats.maxEn;

  // ── impulse clock (absolute, so it cannot drift) ──
  if (p.qbImpulseRemaining > 0) {
    const remaining = impulseEndTime(p, ts) - te;
    if (remaining <= TIME_EPS) finishImpulse(sim, p);
    else p.qbImpulseRemaining = Math.min(PLAYER.qbImpulseSeconds, remaining);
  }

  p.flying = thrustTime > 0;
  p.verticalMode = p.grounded ? 'grounded' : p.flying ? 'flying' : p.vel.y > 0 ? 'rising' : 'falling';
}

/** Earliest player event strictly after `t`, or Infinity. */
function nextEventAfter(sim: Sim, p: PlayerState, t: number): number {
  let best = Infinity;
  const limit = t + TIME_EPS;
  if (p.qbImpulseRemaining > 0) {
    const e = impulseEndTime(p, t);
    if (e > limit && e < best) best = e;
  }
  // The hold only matters in the air (a standing mech does not take off when it completes).
  if (sim.input.jump && p.jumpHeldSince != null && !p.grounded) {
    const e = p.jumpHeldSince + PLAYER.flyHoldSeconds;
    if (e > limit && e < best) best = e;
  }
  if (p.lastEnSpentAt != null && p.en < sim.stats.maxEn) {
    const e = p.lastEnSpentAt + PLAYER.enRegenDelaySeconds;
    if (e > limit && e < best) best = e;
  }
  return best;
}

/**
 * Advances the player from sim.time by `h` seconds (h <= 1/120): horizontal mode logic with exact
 * (trapezoid) integration of the accel-limited velocity, vertical motion (jump / flight / gravity),
 * swept collision, EN flight cost limited to (en - enReserve), EN regeneration, muzzle update.
 * Sets prevPos at the start.
 */
export function updatePlayer(sim: Sim, h: number, enReserve: number): void {
  const p = sim.player;
  copy(p.prevPos, p.pos);
  const reserve = Number.isFinite(enReserve) && enReserve > 0 ? enReserve : 0;
  if (Number.isFinite(h) && h > 0) {
    let t = sim.time;
    let remaining = h;
    // At most one cut per event kind plus tick-sized chunks (the contract is h <= 1/120: one segment).
    const maxSegments = Math.min(MAX_SEGMENTS, Math.ceil(h / TICK) + 4);
    for (let i = 0; i < maxSegments && remaining > 0; i++) {
      let seg = remaining;
      // Cut at an event that falls strictly inside (the scheduler normally ends the sub-step there itself).
      const ev = nextEventAfter(sim, p, t) - t;
      if (ev < seg - TIME_EPS) seg = ev;
      if (seg > TICK + TIME_EPS) seg = TICK;
      if (i === maxSegments - 1) seg = remaining;
      stepSegment(sim, p, t, seg, reserve);
      t += seg;
      remaining -= seg;
    }
    // Last line of defence: the state must stay finite whatever was fed in.
    if (!(Number.isFinite(p.pos.x) && Number.isFinite(p.pos.y) && Number.isFinite(p.pos.z))) copy(p.pos, p.prevPos);
    if (!(Number.isFinite(p.vel.x) && Number.isFinite(p.vel.y) && Number.isFinite(p.vel.z))) set(p.vel, 0, 0, 0);
  }
  computeMuzzle(p.pos, p.yaw, p.muzzle);
}

/**
 * Earliest strictly-future time at which the player's continuous motion changes regime and a sub-step
 * must end exactly: QB impulse end, Space-hold reaching the flight threshold, EN regeneration start.
 * Infinity when there is none.
 */
export function playerNextEventTime(sim: Sim): number {
  return nextEventAfter(sim, sim.player, sim.time);
}
