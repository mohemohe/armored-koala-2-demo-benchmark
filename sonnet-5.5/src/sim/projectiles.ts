/** Player projectile advance (machinegun bullets + missiles), swept vs world and moving enemy spheres. OWNER: combat agent */
import { SIM, WEAPONS } from '../config';
import { mgPositionAt, solveConstantSpeedIntercept } from './ballistics';
import { damageEnemy, findEnemy, pushEvent } from './combat';
import { DEG2RAD, addScaled, clone, cross, distance, dot, lerp, normalize, scale, sub } from './math';
import type { EnemyState, GameState, IWorld, Missile, PlayerBullet, RayHit, V3 } from './types';

/** age comparison tolerance (docs/ARCH.md §3) */
const TIME_EPS = 1e-9;
/** visual size hints for the explosion event (renderer only) */
const MISSILE_IMPACT_SIZE = 2.2;
const MISSILE_EXPIRE_SIZE = 1.4;

/**
 * A shot stopped by a wall between the body centre and the muzzle (weapons.ts bodyToMuzzleBlock, SPEC §4.5): no projectile exists,
 * so the wall impact is reported here with the same events a projectile hitting that wall would emit (machinegun: hit;
 * missile: hit + explosion). Nothing takes damage.
 */
export function emitBodyWallImpact(state: GameState, weapon: 'machinegun' | 'missile', hit: RayHit): void {
  pushEvent(state, { type: 'hit', time: state.time, pos: clone(hit.point), normal: clone(hit.normal), on: 'world', weapon });
  if (weapon === 'missile') pushEvent(state, { type: 'explosion', time: state.time, pos: clone(hit.point), size: MISSILE_IMPACT_SIZE });
}

interface Contact {
  /** fraction (0..1) of the tick [T, T+dt] at which the projectile first touches something */
  u: number;
  kind: 'world' | 'enemy';
  enemy: EnemyState | null;
  /** projectile center at the contact */
  point: V3;
  normal: V3;
}

/**
 * First time u in [0,1] at which a point moving a0 -> a1 comes within `radius` of a sphere center moving c0 -> c1
 * (both linear over the same interval). Exact: relative position d(u) = d0 + w u, solve |d|^2 = radius^2.
 * Returns 0 when already in contact at u = 0 (e.g. a muzzle overlapping the target), null when there is no contact.
 */
export function firstSphereContact(a0: V3, a1: V3, c0: V3, c1: V3, radius: number): number | null {
  const d0 = sub(a0, c0);
  const w = sub(sub(a1, a0), sub(c1, c0));
  const c = dot(d0, d0) - radius * radius;
  if (c <= 0) return 0;
  const a = dot(w, w);
  if (a < 1e-18) return null;
  const b = dot(d0, w);
  if (b >= 0) return null; // separating
  const disc = b * b - a * c;
  if (disc < 0) return null;
  const u = c / (-b + Math.sqrt(disc)); // = (-b - sqrt(disc)) / a without cancellation
  return u <= 1 + 1e-12 ? Math.min(1, u) : null;
}

/** earliest contact of a sphere of `radius` moving a0 -> a1 with the static world or any alive (moving) enemy sphere */
function firstContact(state: GameState, world: IWorld, a0: V3, a1: V3, radius: number): Contact | null {
  const chord = distance(a0, a1);
  let best: Contact | null = null;
  const wh = world.sweepSphere(a0, a1, radius);
  if (wh) {
    best = { u: chord > 1e-12 ? Math.min(1, wh.t / chord) : 0, kind: 'world', enemy: null, point: clone(wh.point), normal: clone(wh.normal) };
  }
  for (const e of state.enemies) {
    if (!e.alive) continue;
    const u = firstSphereContact(a0, a1, e.prevPos, e.pos, e.hitRadius + radius);
    if (u === null) continue;
    if (best && u >= best.u) continue; // ties go to the world
    const point = lerp(a0, a1, u);
    const center = lerp(e.prevPos, e.pos, u);
    best = { u, kind: 'enemy', enemy: e, point, normal: normalize(sub(point, center), { x: 0, y: 1, z: 0 }) };
  }
  return best;
}

function compact<T extends { alive: boolean }>(arr: T[]): void {
  let j = 0;
  for (let i = 0; i < arr.length; i++) if (arr[i].alive) arr[j++] = arr[i];
  arr.length = j;
}

// ---------------------------------------------------------------------------
// machinegun bullets
// ---------------------------------------------------------------------------
function stepBullet(state: GameState, world: IWorld, b: PlayerBullet): void {
  const cfg = WEAPONS.machinegun;
  const age0 = b.age;
  const age1 = Math.min(age0 + SIM.DT, cfg.lifetime);
  // analytic position m + v0 a + 0.5 g a^2; the chord over one tick deviates at most g dt^2 / 8 = 0.00016 m
  const a0 = mgPositionAt(b.origin, b.v0, age0);
  const a1 = mgPositionAt(b.origin, b.v0, age1);
  b.prevPos = a0;
  const c = firstContact(state, world, a0, a1, cfg.bulletRadius);
  if (c) {
    b.pos = clone(c.point);
    b.age = age0 + c.u * (age1 - age0);
    b.alive = false;
    pushEvent(state, { type: 'hit', time: state.time, pos: clone(c.point), normal: c.normal, on: c.kind, weapon: 'machinegun' });
    if (c.enemy) damageEnemy(state, c.enemy, b.damage, 'machinegun');
    return;
  }
  b.pos = a1;
  b.age = age1;
  // the final interval has been checked above; only now may the bullet expire
  if (age1 >= cfg.lifetime - TIME_EPS) b.alive = false;
}

// ---------------------------------------------------------------------------
// missiles
// ---------------------------------------------------------------------------
/** rotate unit `cur` toward unit `des` by at most `maxAngle` [rad] (no overshoot, stays a unit vector) */
function turnToward(cur: V3, des: V3, maxAngle: number): V3 {
  const cosA = Math.min(1, Math.max(-1, dot(cur, des)));
  const angle = Math.acos(cosA);
  if (angle <= maxAngle) return clone(des);
  let axis = cross(cur, des);
  if (dot(axis, axis) < 1e-18) {
    // anti-parallel: any axis perpendicular to cur
    axis = Math.abs(cur.y) < 0.9 ? cross(cur, { x: 0, y: 1, z: 0 }) : cross(cur, { x: 1, y: 0, z: 0 });
  }
  axis = normalize(axis);
  const side = cross(axis, cur); // unit vector in the turn plane, perpendicular to cur, toward des
  return normalize(addScaled(scale(cur, Math.cos(maxAngle)), side, Math.sin(maxAngle)), cur);
}

/**
 * SPEC §4.4 guidance at the start of the tick (missile at time T). Updates the last observation when the missile itself has a
 * clear line to the target center, otherwise extrapolates the LAST observation with constant velocity (the hidden current
 * position is never used). A destroyed target => no guidance (straight flight, no re-targeting).
 */
function guideMissile(state: GameState, world: IWorld, m: Missile, remaining: number): void {
  const target = findEnemy(state, m.targetId);
  if (!target || !target.alive) return;
  const now = state.time;
  const atT = target.prevPos; // target center at time T (positions in B3 are already at T+dt)
  if (!world.segmentBlocked(m.pos, atT)) {
    m.lastSeenPos = clone(atT);
    m.lastSeenVel = clone(target.vel);
    m.lastSeenAt = now;
  }
  const elapsed = Math.max(0, now - m.lastSeenAt);
  const estPos = addScaled(m.lastSeenPos, m.lastSeenVel, elapsed);
  const cur = normalize(m.vel, { x: 0, y: 0, z: 1 });
  const speed = WEAPONS.missile.speed;
  const sol = remaining > TIME_EPS ? solveConstantSpeedIntercept(m.pos, estPos, m.lastSeenVel, speed, remaining) : null;
  const des = sol ? sol.direction : normalize(sub(estPos, m.pos), cur);
  const next = turnToward(cur, des, WEAPONS.missile.turnRateDeg * DEG2RAD * SIM.DT);
  m.vel = scale(next, speed);
}

function stepMissile(state: GameState, world: IWorld, m: Missile): void {
  const remaining = m.life - m.age;
  if (remaining <= TIME_EPS) {
    m.alive = false;
    return;
  }
  const h = Math.min(SIM.DT, remaining);
  guideMissile(state, world, m, remaining);
  const a0 = clone(m.pos);
  const a1 = addScaled(a0, m.vel, h);
  m.prevPos = a0;
  const c = firstContact(state, world, a0, a1, WEAPONS.missile.radius);
  if (c) {
    m.pos = clone(c.point);
    m.age += c.u * h;
    m.alive = false;
    pushEvent(state, { type: 'hit', time: state.time, pos: clone(c.point), normal: c.normal, on: c.kind, weapon: 'missile' });
    pushEvent(state, { type: 'explosion', time: state.time, pos: clone(c.point), size: MISSILE_IMPACT_SIZE });
    if (c.enemy) damageEnemy(state, c.enemy, m.damage, 'missile'); // only the directly hit target takes damage
    return;
  }
  m.pos = a1;
  m.age += h;
  if (m.life - m.age <= TIME_EPS) {
    m.alive = false;
    pushEvent(state, { type: 'explosion', time: state.time, pos: clone(m.pos), size: MISSILE_EXPIRE_SIZE });
  }
}

/** Step B3 (player side): advance every live bullet/missile over [T, T+dt] (dt = SIM.DT). Spawned this tick at age 0. */
export function stepPlayerProjectiles(state: GameState, world: IWorld): void {
  // projectiles created in A2b are already in the arrays at age 0: they advance by exactly this tick's dt, no extra frame
  for (const b of state.bullets) if (b.alive) stepBullet(state, world, b);
  for (const m of state.missiles) if (m.alive) stepMissile(state, world, m);
  compact(state.bullets);
  compact(state.missiles);
}
