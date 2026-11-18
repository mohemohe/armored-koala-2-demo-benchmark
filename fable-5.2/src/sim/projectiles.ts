/**
 * Projectiles: machine-gun bullets (analytic parabola), guided missiles, enemy bullets, and the
 * hitscan beam (docs/SPEC.md §2.3, §4.1, §4.3–§4.5, §9; docs/ARCHITECTURE.md §4 "projectiles.ts").
 *
 * Time model
 *   A projectile is spawned at the current `sim.time` with age 0 and is NOT moved by the sub-step that
 *   spawned it. `advanceProjectiles(sim, t0, t1)` then moves it over its own part of every later
 *   sub-step: [max(t0, spawnTime), min(t1, spawnTime + life)]. The interval that reaches the life end is
 *   clamped to it, collision-tested like any other, and only then is the projectile removed (§4.5, §9).
 *
 * Motion
 *   mg      closed form origin + v0·a + ½·g·a² in absolute time (a = age); the chord from the previous
 *           position is what gets tested (≤ g·h²/8 ≈ 1.6e-4 m off the curve at h = 1/120 s).
 *           Never steered, never inherits the mech velocity (§4.1, §4.3).
 *   enemy   closed form origin + v0·a (straight, no gravity, no guidance — §2.3).
 *   missile heading turned towards the guidance direction by at most 120°/s · h at the start of the
 *           interval, then a straight move at exactly 45 m/s (§4.4).
 *
 * Collision (continuous, §4.5)
 *   The chord prevPos→pos is tested against the stage (world.raycast) and, in relative motion over the
 *   same time interval, against the moving hit volumes: every living enemy sphere for player projectiles,
 *   the player's box for enemy bullets. Player projectiles never test the player; enemy bullets never test
 *   enemies. All contacts of a sub-step are applied in order of their contact time, so "the earliest
 *   contact wins" also holds between projectiles (a bullet that would reach an enemy after another
 *   projectile destroyed it in the same sub-step flies on and is re-tested against everything else).
 *   Exactly equal contact times resolve to the stage first, then the lower enemy index.
 *
 * Garbage: bullets allocate nothing per sub-step (scratch vectors, a reused ray hit, the interval in a
 * typed array). Only a live, steering missile does (the result object of `solveLinearIntercept`, a few
 * hundred bytes per sub-step; at most 4 missiles can be in flight), plus the events of actual hits.
 */
import { ENEMIES, PLAYER, TIME_EPS, WEAPONS } from '../config';
import { clone, v3, type V3 } from '../core/vec';
import {
  ballisticPosition,
  raySphere,
  rotateTowards,
  solveLinearIntercept,
  sweepPointBox,
  sweepPointSphere,
} from './ballistics';
import type { Sim } from './sim';
import type { EnemyState, Projectile, ProjectileKind } from './types';
import type { RayHit } from './world';

const MG = WEAPONS.machinegun;
const MISSILE = WEAPONS.missile;
/** Missile turn-rate limit in rad/s (120°/s). */
const MISSILE_TURN_RATE = (MISSILE.turnRateDeg * Math.PI) / 180;

const CONTACT_NONE = 0;
const CONTACT_WORLD = 1;
const CONTACT_ENEMY = 2;
const CONTACT_PLAYER = 3;

// ───────────────────────────── module scratch (the simulation is single-threaded) ─────────────────────────────
const sDelta = v3();
const sC0 = v3();
const sC1 = v3();
const sAim = v3();
const sDir = v3();
/** Reused world.raycast result (created by the first hit). */
let rayScratch: RayHit | undefined;

/**
 * Interval of the projectile handed to computeInterval(). Kept in a typed array (not in module-level
 * `let`s): storing a double into a module variable allocates a boxed number on every write.
 */
const iv = new Float64Array(5);
/** Start / end time of the interval. */
const IV_START = 0;
const IV_END = 1;
/** Age at the end of the interval (exactly `lifeSeconds` on the last one). */
const IV_AGE = 2;
/** Position of the interval inside the sub-step [t0, t1] as fractions (0 and 1 for a whole sub-step). */
const IV_F0 = 3;
const IV_F1 = 4;

/** Result details of findContact(). */
let foundKind = CONTACT_NONE;
let foundEnemy: EnemyState | null = null;

/** Contacts found in the current sub-step and not applied yet (parallel arrays, `pendCount` entries). */
const pendIndex: number[] = [];
const pendTime: number[] = [];
const pendFrac: number[] = [];
const pendKind: number[] = [];
const pendEnemy: Array<EnemyState | null> = [];
let pendCount = 0;

const finite3 = (a: V3): boolean => Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z);

// ───────────────────────────── spawning ─────────────────────────────

/**
 * Builds a projectile at `muzzle` with world velocity (vx, vy, vz) at the current sim.time and adds it to
 * sim.projectiles. If the launch state is not finite the projectile is returned dead and is NOT added
 * (the simulation state never holds NaN / Infinity).
 */
function launch(
  sim: Sim,
  kind: ProjectileKind,
  muzzle: V3,
  vx: number,
  vy: number,
  vz: number,
  lifeSeconds: number,
  damage: number,
): Projectile {
  const ok =
    finite3(muzzle) &&
    Number.isFinite(vx) &&
    Number.isFinite(vy) &&
    Number.isFinite(vz) &&
    Number.isFinite(sim.time) &&
    lifeSeconds > 0 &&
    Number.isFinite(lifeSeconds);
  const o = ok ? muzzle : v3();
  if (!ok) {
    vx = 0;
    vy = 0;
    vz = 0;
  }
  // Every projectile gets the same set of properties in the same order (one object shape).
  const p: Projectile = {
    id: sim.nextProjectileId++,
    kind,
    alive: ok,
    spawnTime: Number.isFinite(sim.time) ? sim.time : 0,
    lifeSeconds: ok ? lifeSeconds : 0,
    damage,
    origin: clone(o),
    v0: v3(vx, vy, vz),
    pos: clone(o),
    prevPos: clone(o),
    vel: v3(vx, vy, vz),
    ownerEnemyId: undefined,
    ownerKind: undefined,
    targetId: null,
    obsPos: null,
    obsVel: null,
    obsTime: null,
  };
  if (ok) sim.projectiles.push(p);
  return p;
}

/**
 * Spawns a machine-gun bullet at `muzzle` with world velocity `v0` at the current sim.time (age 0).
 * `v0` is stored exactly as given (no renormalisation, no mech velocity added). The bullet is first moved
 * by the next sub-step. A non-finite launch state yields a dead projectile that is not added.
 */
export function spawnMachinegunBullet(sim: Sim, muzzle: V3, v0: V3): Projectile {
  return launch(sim, 'mg', muzzle, v0.x, v0.y, v0.z, MG.lifeSeconds, MG.damage);
}

/**
 * Spawns a missile at `muzzle` flying along `dir` (normalised here) at exactly the missile speed, locked
 * to `targetId` for its whole life. Its first observation (obsPos / obsVel / obsTime) is the target's
 * state at launch, taken only if the target is alive and the stage does not block the line from the
 * muzzle to its centre — which a complete lock guarantees; a target that is hidden at launch is not
 * peeked at (the missile then flies straight until it sees it). A zero / non-finite `dir` yields a dead
 * projectile that is not added.
 */
export function spawnMissile(sim: Sim, muzzle: V3, dir: V3, targetId: string): Projectile {
  const len = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z);
  const k = len > 1e-12 && Number.isFinite(len) ? MISSILE.speed / len : Number.NaN;
  const p = launch(sim, 'missile', muzzle, dir.x * k, dir.y * k, dir.z * k, MISSILE.lifeSeconds, MISSILE.damage);
  p.targetId = targetId;
  const target = sim.enemyById.get(targetId);
  if (
    p.alive &&
    target &&
    target.alive &&
    finite3(target.pos) &&
    finite3(target.vel) &&
    !sim.world.segmentBlocked(p.pos, target.pos)
  ) {
    p.obsPos = clone(target.pos);
    p.obsVel = clone(target.vel);
    p.obsTime = p.spawnTime;
  }
  return p;
}

/**
 * Spawns a straight enemy bullet from `muzzle` along `dir` (normalised here) with the shooter's
 * speed / damage / life (ENEMIES[enemy.kind]). The origin and the shooter are recorded for the damage
 * report. A zero / non-finite `dir` yields a dead projectile that is not added.
 */
export function spawnEnemyBullet(sim: Sim, enemy: EnemyState, muzzle: V3, dir: V3): Projectile {
  const cfg = ENEMIES[enemy.kind];
  const len = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z);
  const k = len > 1e-12 && Number.isFinite(len) ? cfg.bulletSpeed / len : Number.NaN;
  const p = launch(sim, 'enemy', muzzle, dir.x * k, dir.y * k, dir.z * k, cfg.bulletLife, cfg.damage);
  p.ownerEnemyId = enemy.id;
  p.ownerKind = enemy.kind;
  return p;
}

// ───────────────────────────── per-sub-step update ─────────────────────────────

/**
 * Part of the sub-step [t0, t1] during which projectile `p` exists: from its spawn time (or t0) to its
 * life end (or t1). Fills `iv` (IV_START … IV_F1); returns false when there is nothing to
 * simulate (spawned at or after t1 — e.g. by the sub-step that is ending — or already at its life end).
 */
function computeInterval(p: Projectile, t0: number, t1: number, invH: number): boolean {
  const lifeEnd = p.spawnTime + p.lifeSeconds;
  const last = !(t1 < lifeEnd - TIME_EPS);
  const start = p.spawnTime > t0 ? p.spawnTime : t0;
  const end = last ? lifeEnd : t1;
  if (!(end > start)) return false;
  iv[IV_START] = start;
  iv[IV_END] = end;
  iv[IV_AGE] = last ? p.lifeSeconds : end - p.spawnTime;
  iv[IV_F0] = start === t0 ? 0 : (start - t0) * invH;
  iv[IV_F1] = end === t1 ? 1 : (end - t0) * invH;
  return true;
}

/** out = a + (b − a)·f */
function lerpInto(out: V3, a: V3, b: V3, f: number): V3 {
  out.x = a.x + (b.x - a.x) * f;
  out.y = a.y + (b.y - a.y) * f;
  out.z = a.z + (b.z - a.z) * f;
  return out;
}

/**
 * Missile guidance at the start of the interval in `iv` (time IV_START, fraction IV_F0 of the sub-step), §4.4:
 * observe the target when it is alive and the stage does not block the line from the missile to its
 * centre; aim at the lead point of the observed (or, while hidden, the constant-velocity extrapolated)
 * state bounded by the remaining life, or straight at that position when there is no solution; turn the
 * heading towards it by at most MISSILE_TURN_RATE · dt. A destroyed (or unknown) target means no
 * steering at all; the target id is never changed.
 */
function steerMissile(sim: Sim, p: Projectile): void {
  if (p.targetId == null) return;
  const target = sim.enemyById.get(p.targetId);
  if (!target || !target.alive) return;
  const start = iv[IV_START];
  const dt = iv[IV_END] - start;
  const f0 = iv[IV_F0];

  // Target centre at the start of the interval (prevPos is its position at t0).
  const tpos = f0 === 0 ? target.prevPos : lerpInto(sC0, target.prevPos, target.pos, f0);
  if (finite3(tpos) && finite3(target.vel) && !sim.world.segmentBlocked(p.pos, tpos)) {
    if (p.obsPos) {
      p.obsPos.x = tpos.x;
      p.obsPos.y = tpos.y;
      p.obsPos.z = tpos.z;
    } else {
      p.obsPos = clone(tpos);
    }
    if (p.obsVel) {
      p.obsVel.x = target.vel.x;
      p.obsVel.y = target.vel.y;
      p.obsVel.z = target.vel.z;
    } else {
      p.obsVel = clone(target.vel);
    }
    p.obsTime = start;
  }
  const obsPos = p.obsPos;
  const obsVel = p.obsVel;
  if (!obsPos || !obsVel || p.obsTime == null) return; // never seen: nothing to steer by

  // Where the missile believes the target is now (the true position is not consulted while hidden).
  const since = start - p.obsTime;
  sAim.x = obsPos.x + obsVel.x * since;
  sAim.y = obsPos.y + obsVel.y * since;
  sAim.z = obsPos.z + obsVel.z * since;

  const remaining = p.spawnTime + p.lifeSeconds - start;
  const sol = solveLinearIntercept(p.pos, sAim, obsVel, MISSILE.speed, remaining);
  if (sol) {
    sDir.x = sol.dir.x;
    sDir.y = sol.dir.y;
    sDir.z = sol.dir.z;
  } else {
    sDir.x = sAim.x - p.pos.x;
    sDir.y = sAim.y - p.pos.y;
    sDir.z = sAim.z - p.pos.z;
  }
  // rotateTowards leaves the heading untouched for a degenerate (zero / non-finite) desired direction.
  rotateTowards(p.vel, sDir, MISSILE_TURN_RATE * dt, sDir);
  if (sDir.x !== 0 || sDir.y !== 0 || sDir.z !== 0) {
    p.vel.x = sDir.x * MISSILE.speed;
    p.vel.y = sDir.y * MISSILE.speed;
    p.vel.z = sDir.z * MISSILE.speed;
  }
}

/** Moves `p` over the interval described by `iv`: prevPos := old pos, pos / vel := new state. */
function integrate(sim: Sim, p: Projectile): void {
  const pos = p.pos;
  const prev = p.prevPos;
  prev.x = pos.x;
  prev.y = pos.y;
  prev.z = pos.z;
  if (p.kind === 'mg') {
    const age = iv[IV_AGE];
    ballisticPosition(p.origin, p.v0, MG.gravity, age, pos);
    p.vel.x = p.v0.x;
    p.vel.y = p.v0.y - MG.gravity * age;
    p.vel.z = p.v0.z;
  } else if (p.kind === 'enemy') {
    const age = iv[IV_AGE];
    pos.x = p.origin.x + p.v0.x * age;
    pos.y = p.origin.y + p.v0.y * age;
    pos.z = p.origin.z + p.v0.z * age;
  } else {
    steerMissile(sim, p);
    const dt = iv[IV_END] - iv[IV_START];
    pos.x += p.vel.x * dt;
    pos.y += p.vel.y * dt;
    pos.z += p.vel.z * dt;
  }
}

/**
 * Earliest contact of `p` on its chord prevPos→pos, which spans the fractions [f0, f1] of the current
 * sub-step. Returns the fraction of the chord (0..1) or -1; the kind of contact and the enemy are left in
 * foundKind / foundEnemy. Dead enemies are ignored.
 */
function findContact(sim: Sim, p: Projectile, f0: number, f1: number): number {
  const a = p.prevPos;
  const b = p.pos;
  foundKind = CONTACT_NONE;
  foundEnemy = null;
  let best = Number.POSITIVE_INFINITY;

  // Stage: ray along the unnormalised chord, so the hit parameter is directly the fraction.
  sDelta.x = b.x - a.x;
  sDelta.y = b.y - a.y;
  sDelta.z = b.z - a.z;
  const hit = sim.world.raycast(a, sDelta, 1, rayScratch);
  if (hit) {
    rayScratch = hit;
    best = hit.dist;
    foundKind = CONTACT_WORLD;
  }

  const whole = f0 === 0 && f1 === 1;
  if (p.kind === 'enemy') {
    const pl = sim.player;
    const u = whole
      ? sweepPointBox(a, b, pl.prevPos, pl.pos, PLAYER.half)
      : sweepPointBox(a, b, lerpInto(sC0, pl.prevPos, pl.pos, f0), lerpInto(sC1, pl.prevPos, pl.pos, f1), PLAYER.half);
    if (u >= 0 && u < best) {
      best = u;
      foundKind = CONTACT_PLAYER;
    }
  } else {
    const enemies = sim.enemies;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (!e.alive) continue;
      const u = whole
        ? sweepPointSphere(a, b, e.prevPos, e.pos, e.radius)
        : sweepPointSphere(a, b, lerpInto(sC0, e.prevPos, e.pos, f0), lerpInto(sC1, e.prevPos, e.pos, f1), e.radius);
      if (u >= 0 && u < best) {
        best = u;
        foundKind = CONTACT_ENEMY;
        foundEnemy = e;
      }
    }
  }
  return foundKind === CONTACT_NONE ? -1 : best;
}

function pushPending(index: number, time: number, frac: number, kind: number, enemy: EnemyState | null): void {
  const k = pendCount++;
  pendIndex[k] = index;
  pendTime[k] = time;
  pendFrac[k] = frac;
  pendKind[k] = kind;
  pendEnemy[k] = enemy;
}

/** Stops `p` at fraction `u` of its chord, removes it and applies the hit exactly once. */
function applyContact(sim: Sim, p: Projectile, u: number, kind: number, enemy: EnemyState | null): void {
  const a = p.prevPos;
  const b = p.pos;
  b.x = a.x + (b.x - a.x) * u;
  b.y = a.y + (b.y - a.y) * u;
  b.z = a.z + (b.z - a.z) * u;
  p.alive = false;
  if (kind === CONTACT_ENEMY && enemy) {
    sim.emit({ type: 'projectile-hit', kind: p.kind, pos: clone(b), target: 'enemy', enemyId: enemy.id });
    sim.damageEnemy(enemy, p.damage, b);
  } else if (kind === CONTACT_PLAYER) {
    sim.emit({ type: 'projectile-hit', kind: p.kind, pos: clone(b), target: 'player', enemyId: null });
    sim.damagePlayer(p.damage, p.origin, p.ownerEnemyId ?? null);
  } else {
    sim.emit({ type: 'projectile-hit', kind: p.kind, pos: clone(b), target: 'world', enemyId: null });
  }
}

/**
 * Advances every live projectile from t0 to t1 (sub-step): swept collision against the world, against
 * enemies moving prevPos→pos (player projectiles) and against the player box moving prevPos→pos (enemy
 * bullets); applies damage once; removes dead / expired projectiles after testing their last interval.
 *
 * Must be called after the player and the enemies have moved from t0 to t1 (their prevPos = position at
 * t0, pos = position at t1). Projectiles spawned at t1 (or later) are left untouched.
 */
export function advanceProjectiles(sim: Sim, t0: number, t1: number): void {
  const list = sim.projectiles;
  const n = list.length;
  if (n === 0) return;
  const h = t1 - t0;
  // An empty or invalid interval moves nothing (and must not expire anything either).
  if (!(h > 0) || !Number.isFinite(h)) return;
  const invH = 1 / h;

  // 1. Move everything and collect each projectile's earliest contact. No damage is applied yet, so the
  //    result does not depend on the order of the list (missiles steer by the state at the interval start).
  pendCount = 0;
  for (let i = 0; i < n; i++) {
    const p = list[i];
    if (!p.alive) continue;
    if (!computeInterval(p, t0, t1, invH)) continue;
    const start = iv[IV_START];
    const span = iv[IV_END] - start;
    const f0 = iv[IV_F0];
    const f1 = iv[IV_F1];
    integrate(sim, p);
    if (!finite3(p.pos) || !finite3(p.vel)) {
      // Cannot happen with finite inputs; never keep a non-finite projectile in the state.
      p.pos.x = p.prevPos.x;
      p.pos.y = p.prevPos.y;
      p.pos.z = p.prevPos.z;
      p.vel.x = 0;
      p.vel.y = 0;
      p.vel.z = 0;
      p.alive = false;
      continue;
    }
    const u = findContact(sim, p, f0, f1);
    if (u >= 0) pushPending(i, start + span * u, u, foundKind, foundEnemy);
  }

  // 2. Apply the contacts in order of contact time (ties: list order).
  while (pendCount > 0) {
    let k = 0;
    for (let j = 1; j < pendCount; j++) {
      if (pendTime[j] < pendTime[k] || (pendTime[j] === pendTime[k] && pendIndex[j] < pendIndex[k])) k = j;
    }
    const index = pendIndex[k];
    const frac = pendFrac[k];
    const kind = pendKind[k];
    const enemy = pendEnemy[k];
    const lastSlot = --pendCount;
    pendIndex[k] = pendIndex[lastSlot];
    pendTime[k] = pendTime[lastSlot];
    pendFrac[k] = pendFrac[lastSlot];
    pendKind[k] = pendKind[lastSlot];
    pendEnemy[k] = pendEnemy[lastSlot];
    pendEnemy[lastSlot] = null;

    const p = list[index];
    if (kind === CONTACT_ENEMY && enemy && !enemy.alive) {
      // Destroyed earlier in this sub-step by another projectile: fly on, look for the next contact.
      if (computeInterval(p, t0, t1, invH)) {
        const start = iv[IV_START];
        const span = iv[IV_END] - start;
        const u = findContact(sim, p, iv[IV_F0], iv[IV_F1]);
        if (u >= 0) pushPending(index, start + span * u, u, foundKind, foundEnemy);
      }
      continue;
    }
    applyContact(sim, p, frac, kind, enemy);
  }
  foundEnemy = null;

  // 3. Life end (its interval was tested above), then deterministic in-place compaction (order kept).
  const total = list.length;
  let w = 0;
  for (let r = 0; r < total; r++) {
    const p = list[r];
    if (p.alive && !(t1 < p.spawnTime + p.lifeSeconds - TIME_EPS)) {
      p.alive = false;
      sim.emit({ type: 'projectile-expired', kind: p.kind, pos: clone(p.pos) });
    }
    if (p.alive) {
      if (w !== r) list[w] = p;
      w++;
    }
  }
  if (w !== total) list.length = w;
}

// ───────────────────────────── beam ─────────────────────────────

export interface BeamResult {
  /** End point of the beam (hit point, or muzzle + dir * range). */
  end: V3;
  /** Enemy hit first, if any. */
  enemy: EnemyState | null;
  /** True when stage geometry stopped the beam before any enemy. */
  hitWorld: boolean;
  /** Length of the beam in metres (|end − muzzle|, at most the beam range). */
  distance: number;
}

/**
 * Hitscan from `muzzle` along unit `dir` up to the beam range at the current sim.time. No damage applied here.
 *
 * The beam stops at the first of: the nearest stage surface (world.raycast) and the nearest entry into a
 * living enemy's hit sphere at its current position, both within WEAPONS.beam.range of the muzzle. An
 * enemy standing behind a wall is not hit; an enemy whose sphere begins beyond the range is not hit.
 * (`dir` is used as given when it is unit length, otherwise it is normalised; a zero / non-finite
 * direction hits nothing and ends at the muzzle.)
 */
export function castBeam(sim: Sim, muzzle: V3, dir: V3): BeamResult {
  const range = WEAPONS.beam.range;
  const len = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z);
  if (!finite3(muzzle) || !(len > 1e-12) || !Number.isFinite(len)) {
    return { end: finite3(muzzle) ? clone(muzzle) : v3(), enemy: null, hitWorld: false, distance: 0 };
  }
  const k = Math.abs(len - 1) <= 1e-9 ? 1 : 1 / len;
  sDir.x = dir.x * k;
  sDir.y = dir.y * k;
  sDir.z = dir.z * k;

  const hit = sim.world.raycast(muzzle, sDir, range, rayScratch);
  if (hit) rayScratch = hit;
  const worldDist = hit ? hit.dist : Number.POSITIVE_INFINITY;

  let enemy: EnemyState | null = null;
  let enemyDist = Number.POSITIVE_INFINITY;
  const enemies = sim.enemies;
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    if (!e.alive) continue;
    const d = raySphere(muzzle, sDir, e.pos, e.radius, range);
    if (d >= 0 && d < enemyDist) {
      enemyDist = d;
      enemy = e;
    }
  }

  if (enemy && enemyDist < worldDist) {
    return {
      end: v3(muzzle.x + sDir.x * enemyDist, muzzle.y + sDir.y * enemyDist, muzzle.z + sDir.z * enemyDist),
      enemy,
      hitWorld: false,
      distance: enemyDist,
    };
  }
  if (hit) return { end: clone(hit.point), enemy: null, hitWorld: true, distance: hit.dist };
  return {
    end: v3(muzzle.x + sDir.x * range, muzzle.y + sDir.y * range, muzzle.z + sDir.z * range),
    enemy: null,
    hitWorld: false,
    distance: range,
  };
}
