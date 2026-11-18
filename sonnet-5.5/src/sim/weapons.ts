/** Player weapons: switching, firing, fire-control solutions. OWNER: combat agent. SPEC §4 */
import { FCS, LIMITS, SIM, WEAPON_ORDER, WEAPONS } from '../config';
import { solveConstantSpeedIntercept, solveMachinegun } from './ballistics';
import { freeFireDirection, playerMuzzlePosition } from './camera';
import { damageEnemy, findEnemy, pushEvent } from './combat';
import { revalidateLock } from './fcs';
import { addScaled, clone, distance, dot, isFiniteV3, normalize, scale, sub } from './math';
import { emitBodyWallImpact } from './projectiles';
import { inactiveFireControl } from './types';
import type { EnemyState, FireControlState, GameState, IWorld, Notices, PlayerBullet, Missile, RayHit, ShotRecord, V3, WeaponId } from './types';

/** time comparison tolerance (docs/ARCH.md §3) */
const TIME_EPS = 1e-9;
/** a refusal notice event is emitted once per refusal streak (a streak = consecutive ticks with the trigger held) */
const NOTICE_STREAK_GAP = 1.5 * SIM.DT;

/**
 * The single fire-control solution. HUD (state.fc), the real shot and the snapshot all use this result.
 * `initialVelocity` is the velocity actually given to the projectile (machinegun v0, missile 45*dir); null for the beam
 * and for `inactive`.
 */
export interface FireSolution extends FireControlState {
  initialVelocity: V3 | null;
}

/** strip the projectile-only field so state.fc is a plain FireControlState */
export function toFireControlState(sol: FireSolution): FireControlState {
  return {
    status: sol.status,
    weapon: sol.weapon,
    targetId: sol.targetId,
    evaluatedAtSeconds: sol.evaluatedAtSeconds,
    muzzlePosition: sol.muzzlePosition ? clone(sol.muzzlePosition) : null,
    targetPosition: sol.targetPosition ? clone(sol.targetPosition) : null,
    targetVelocity: sol.targetVelocity ? clone(sol.targetVelocity) : null,
    launchDirection: sol.launchDirection ? clone(sol.launchDirection) : null,
    predictedFlightSeconds: sol.predictedFlightSeconds,
    predictedInterceptPosition: sol.predictedInterceptPosition ? clone(sol.predictedInterceptPosition) : null,
    aimPoint: sol.aimPoint ? clone(sol.aimPoint) : null,
    residualMeters: sol.residualMeters,
  };
}

/**
 * Fire-control solution for `weapon` against a lock-complete `target` (null => no lock => `inactive`, no correction).
 * m = muzzle, p = target hit-box center, v = target actual velocity, all at state.time (SPEC §4.2/§4.3).
 *  - machinegun: solveMachinegun (intercept + gravity); no root => no_solution, direct aim, 1 round is still spent
 *  - beam: instant hit => normalize(p - m), t = 0, residual 0
 *  - missile: constant-speed intercept (45 m/s, t <= 4); no root => no_solution, aim at the current position
 */
export function computeFireSolution(state: GameState, world: IWorld, weapon: WeaponId, target: EnemyState | null, muzzle: V3): FireSolution {
  void world;
  if (!target) return { ...inactiveFireControl(weapon), initialVelocity: null };
  const m = clone(muzzle);
  const p = clone(target.pos);
  const v = clone(target.vel);
  const head = {
    weapon,
    targetId: target.id,
    evaluatedAtSeconds: state.time,
    muzzlePosition: m,
    targetPosition: p,
    targetVelocity: v,
  };
  // direct aim at the current position (muzzle ~ target center: fall back to the camera forward, never divide by ~0)
  const direct = normalize(sub(p, m), state.camera.forward);

  if (weapon === 'beam') {
    return {
      ...head,
      status: 'solved',
      launchDirection: direct,
      initialVelocity: null,
      predictedFlightSeconds: 0,
      predictedInterceptPosition: clone(p),
      aimPoint: clone(p),
      residualMeters: 0,
    };
  }

  if (weapon === 'machinegun') {
    const s = solveMachinegun(m, p, v);
    if (
      s &&
      Number.isFinite(s.t) &&
      Number.isFinite(s.residual) &&
      isFiniteV3(s.direction) &&
      isFiniteV3(s.velocity) &&
      isFiniteV3(s.interceptPoint) &&
      isFiniteV3(s.aimPoint)
    ) {
      return {
        ...head,
        status: 'solved',
        launchDirection: clone(s.direction),
        initialVelocity: clone(s.velocity),
        predictedFlightSeconds: s.t,
        predictedInterceptPosition: clone(s.interceptPoint),
        aimPoint: clone(s.aimPoint),
        residualMeters: s.residual,
      };
    }
    return {
      ...head,
      status: 'no_solution',
      launchDirection: direct,
      initialVelocity: scale(direct, WEAPONS.machinegun.muzzleSpeed),
      predictedFlightSeconds: null,
      predictedInterceptPosition: null,
      aimPoint: clone(p),
      residualMeters: null,
    };
  }

  // missile
  const speed = WEAPONS.missile.speed;
  const s = solveConstantSpeedIntercept(m, p, v, speed, FCS.MISSILE_MAX_T);
  if (s && Number.isFinite(s.t) && isFiniteV3(s.direction)) {
    const intercept = addScaled(p, v, s.t);
    const missileAtT = addScaled(m, s.direction, speed * s.t);
    return {
      ...head,
      status: 'solved',
      launchDirection: clone(s.direction),
      initialVelocity: scale(s.direction, speed),
      predictedFlightSeconds: s.t,
      predictedInterceptPosition: intercept,
      aimPoint: clone(intercept),
      residualMeters: distance(missileAtT, intercept),
    };
  }
  return {
    ...head,
    status: 'no_solution',
    launchDirection: direct,
    initialVelocity: scale(direct, speed),
    predictedFlightSeconds: null,
    predictedInterceptPosition: null,
    aimPoint: clone(p),
    residualMeters: null,
  };
}

/** Step A1: consume state.input.weaponSelect (switching never resets ammo / EN / nextFireAt). */
export function requestWeaponSwitch(state: GameState): void {
  const w = state.input.weaponSelect;
  if (w && WEAPON_ORDER.includes(w)) {
    state.player.weapon = w;
  }
  state.input.weaponSelect = null;
}

type RefusalKind = 'noLock' | 'noEn' | 'noAmmo' | 'noSolution';
const NOTICE_FIELD: Record<RefusalKind, keyof Notices> = {
  noLock: 'noLockAt',
  noEn: 'noEnAt',
  noAmmo: 'noAmmoAt',
  noSolution: 'noSolutionAt',
};

/** stamp state.notices (HUD flash) and emit the notice event (once per streak unless `every`) */
function raiseNotice(state: GameState, kind: RefusalKind, every = false): void {
  const key = NOTICE_FIELD[kind];
  const prev = state.notices[key];
  state.notices[key] = state.time;
  if (every || prev === null || state.time - prev > NOTICE_STREAK_GAP) {
    pushEvent(state, { type: 'notice', time: state.time, kind, weapon: state.player.weapon });
  }
}

/** distance along the unit ray to the sphere surface (0 when the origin is inside), or null */
function raySphere(origin: V3, dir: V3, center: V3, radius: number): number | null {
  const oc = sub(origin, center);
  const c = dot(oc, oc) - radius * radius;
  if (c <= 0) return 0;
  const b = dot(oc, dir);
  if (b >= 0) return null;
  const disc = b * b - c;
  if (disc < 0) return null;
  return c / (-b + Math.sqrt(disc));
}

/**
 * First wall on the segment from the body centre to the muzzle (null when the way out is clear).
 * The muzzle is a fixed offset from the centre (PLAYER.MUZZLE_OFFSET: 1.25 m forward, 1.05 m right; the body half-width is 0.8 m),
 * so a wall thinner than that offset pressed against the body would end up BEHIND the muzzle and the round would start on its far
 * side. SPEC §4.5 forbids passing a wall in front of the muzzle and moving the launch point to the other side of it, so such a
 * wall is the first collision of the shot: the world's closed-set raycast, exactly like every other wall.
 */
function bodyToMuzzleBlock(world: IWorld, center: V3, muzzle: V3): RayHit | null {
  const d = sub(muzzle, center);
  const len = Math.hypot(d.x, d.y, d.z);
  if (!(len > 1e-9)) return null;
  return world.raycast(center, { x: d.x / len, y: d.y / len, z: d.z / len }, len);
}

/**
 * Instant beam: first world surface or alive enemy sphere within range takes the single 40-damage hit.
 * `blocker` = a wall between the body and the muzzle (bodyToMuzzleBlock): that wall is the first hit, nothing is damaged.
 */
function resolveBeam(state: GameState, world: IWorld, origin: V3, dir: V3, blocker: RayHit | null): void {
  if (blocker) {
    pushEvent(state, { type: 'beamFire', time: state.time, origin: clone(origin), end: clone(blocker.point), hit: 'world', targetId: null });
    pushEvent(state, { type: 'hit', time: state.time, pos: clone(blocker.point), normal: clone(blocker.normal), on: 'world', weapon: 'beam' });
    return;
  }
  const range = WEAPONS.beam.range;
  const wh = world.raycast(origin, dir, range);
  let bestT = wh ? wh.t : Infinity;
  let hitEnemy: EnemyState | null = null;
  for (const e of state.enemies) {
    if (!e.alive) continue;
    const t = raySphere(origin, dir, e.pos, e.hitRadius);
    if (t === null || t > range || t >= bestT) continue; // ties go to the world
    bestT = t;
    hitEnemy = e;
  }
  const kind: 'none' | 'world' | 'enemy' = hitEnemy ? 'enemy' : wh ? 'world' : 'none';
  const end = addScaled(origin, dir, kind === 'none' ? range : bestT);
  pushEvent(state, { type: 'beamFire', time: state.time, origin: clone(origin), end: clone(end), hit: kind, targetId: hitEnemy ? hitEnemy.id : null });
  if (hitEnemy) {
    pushEvent(state, { type: 'hit', time: state.time, pos: clone(end), normal: normalize(sub(end, hitEnemy.pos), { x: -dir.x, y: -dir.y, z: -dir.z }), on: 'enemy', weapon: 'beam' });
    damageEnemy(state, hitEnemy, WEAPONS.beam.damage, 'beam');
  } else if (wh) {
    pushEvent(state, { type: 'hit', time: state.time, pos: clone(end), normal: clone(wh.normal), on: 'world', weapon: 'beam' });
  }
}

/**
 * Step A2 (state at time T = state.time, after playerBeginTick): if fire is held and the current weapon is ready,
 * revalidate the lock, compute the shot solution with the SAME-TIME muzzle/target values, pay ammo/EN
 * (beam EN is paid here, BEFORE flight EN in playerIntegrate), spawn bullet/missile (age 0) or resolve the beam
 * (instant raycast + enemy sphere test), record state.shots, emit events.
 *
 * Nothing is spent and no timer moves when the shot is refused (no ammo, EN < 8, missile without a valid lock complete).
 * The player's own velocity is never added to a projectile (SPEC §4.1).
 *
 * A wall on the segment body centre -> muzzle (thinner than the muzzle offset, so the muzzle sits behind it; SPEC §4.5) stops the
 * shot at that wall whether or not the lock corrects it: the beam ends there (beamFire.hit = 'world', nobody is damaged), the
 * machinegun / missile spawn no projectile and emit the wall impact instead. The shot still counts as fired (ammo / EN, timers,
 * ShotRecord) - only its flight is cut short, so the launch point is never moved to the far side of the wall.
 */
export function playerFireStep(state: GameState, world: IWorld): void {
  if (!state.input.fire) return;
  const p = state.player;
  const w = p.weapon;
  if (p.nextFireAt[w] > state.time + TIME_EPS) return; // not ready (survives weapon switches)

  // resources first: a refused shot changes no timer, ammo or EN
  if (w === 'machinegun' && p.ammo.machinegun <= 0) return raiseNotice(state, 'noAmmo');
  if (w === 'missile' && p.ammo.missile <= 0) return raiseNotice(state, 'noAmmo');
  if (w === 'beam' && p.en < WEAPONS.beam.enCost - TIME_EPS) return raiseNotice(state, 'noEn');

  // lock revalidation at time T: an invalid target is dropped now (no stale correction)
  const lockOk = revalidateLock(state, world);
  const target = lockOk ? findEnemy(state, state.lock.targetId) ?? null : null;
  if (w === 'missile' && !target) return raiseNotice(state, 'noLock');

  const muzzle = playerMuzzlePosition(p);
  const blocker = bodyToMuzzleBlock(world, p.pos, muzzle);
  const solution = computeFireSolution(state, world, w, target, muzzle);
  const dir = solution.launchDirection ?? freeFireDirection(state, world, muzzle);
  state.fc = target ? toFireControlState(solution) : inactiveFireControl(w);

  let initialVelocity: V3 | null = null;
  if (w === 'machinegun') {
    initialVelocity = clone(solution.initialVelocity ?? scale(dir, WEAPONS.machinegun.muzzleSpeed));
    p.ammo.machinegun -= 1;
    if (!blocker) {
      const bullet: PlayerBullet = {
        id: state.nextProjectileId++,
        pos: clone(muzzle),
        prevPos: clone(muzzle),
        origin: clone(muzzle),
        v0: clone(initialVelocity),
        age: 0,
        damage: WEAPONS.machinegun.damage,
        alive: true,
      };
      state.bullets.push(bullet);
    }
    pushEvent(state, { type: 'mgFire', time: state.time, origin: clone(muzzle), dir: clone(dir) });
    if (blocker) emitBodyWallImpact(state, 'machinegun', blocker);
  } else if (w === 'beam') {
    p.en = Math.max(0, p.en - WEAPONS.beam.enCost);
    p.mv.lastEnSpentAt = state.time; // paid after QB (A2a) and before flight (B1)
    resolveBeam(state, world, muzzle, dir, blocker);
  } else if (target) {
    initialVelocity = clone(solution.initialVelocity ?? scale(dir, WEAPONS.missile.speed));
    p.ammo.missile -= 1;
    if (!blocker) {
      const missile: Missile = {
        id: state.nextProjectileId++,
        pos: clone(muzzle),
        prevPos: clone(muzzle),
        vel: clone(initialVelocity),
        age: 0,
        life: WEAPONS.missile.lifetime,
        damage: WEAPONS.missile.damage,
        targetId: target.id,
        lastSeenPos: clone(target.pos),
        lastSeenVel: clone(target.vel),
        lastSeenAt: state.time,
        alive: true,
      };
      state.missiles.push(missile);
    }
    pushEvent(state, { type: 'missileFire', time: state.time, origin: clone(muzzle), dir: clone(dir) });
    if (blocker) emitBodyWallImpact(state, 'missile', blocker);
  }
  p.nextFireAt[w] = state.time + WEAPONS[w].interval;

  const rec: ShotRecord = {
    id: ++state.shotSeq,
    firedAtSeconds: state.time,
    weapon: w,
    targetId: target ? target.id : null,
    solutionStatus: target ? solution.status : 'inactive',
    muzzlePosition: clone(muzzle),
    targetPositionAtFire: target && solution.targetPosition ? clone(solution.targetPosition) : null,
    targetVelocityAtFire: target && solution.targetVelocity ? clone(solution.targetVelocity) : null,
    launchDirection: clone(dir),
    initialVelocity,
    accelerationAtFire: w === 'machinegun' ? { x: 0, y: -WEAPONS.machinegun.gravity, z: 0 } : { x: 0, y: 0, z: 0 },
    predictedFlightSeconds: target ? solution.predictedFlightSeconds : null,
    predictedInterceptPosition: target && solution.predictedInterceptPosition ? clone(solution.predictedInterceptPosition) : null,
  };
  state.shots.push(rec);
  if (state.shots.length > LIMITS.RECENT_SHOTS) state.shots.splice(0, state.shots.length - LIMITS.RECENT_SHOTS);

  if (target && solution.status === 'no_solution') raiseNotice(state, 'noSolution', true);
}
