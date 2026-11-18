/**
 * FCS ("Flight Control System" in this project): target acquisition / lock state machine and the
 * per-weapon fire-control solution (docs/SPEC.md §4.2–§4.4, §5; docs/ARCHITECTURE.md §4 "fcs.ts").
 *
 * Two independent pieces of state
 *   sim.lock          WHICH enemy is tracked and how far the lock has progressed. It is judged only from the
 *                     target's CURRENT hit-volume centre: alive, within 120 m of the muzzle, in front of the
 *                     camera, projected inside the lock circle, and visible from BOTH the camera and the
 *                     muzzle. Neither the predicted intercept nor the compensated aim point is ever tested
 *                     against the circle or the range (§4.3, §5).
 *   sim.fireControl   WHERE the selected weapon has to be pointed for that target right now ('solved'), or
 *                     the fact that no in-lifetime solution exists ('no_solution': the lock is kept and the
 *                     weapon aims straight at the current position). 'inactive' until the lock is complete.
 *
 * The solution is never cached: `computeFireSolution` is evaluated from the same-time state (sim.player.muzzle,
 * target.pos, target.vel) every sub-step for the HUD / gun model and again for every single shot (§4.2).
 * All three FCS parts and both leg types share this code path: parts only change the circle radius and the
 * lock time, never the accuracy.
 *
 * Nothing in here turns the camera, moves the mech or touches a projectile that is already in flight.
 */
import { FCS_RANGE, TIME_EPS, WEAPONS } from '../config';
import { clone, isFiniteV3, v3, type V3 } from '../core/vec';
import { DEGENERATE_RANGE, raySphere, solveGravityIntercept, solveLinearIntercept } from './ballistics';
import { projectToViewport, type ScreenPoint } from './camera';
import type { Sim } from './sim';
import type { AimState, EnemyState, FireSolution, LockState, Weapon } from './types';
import type { RayHit } from './world';

/**
 * Rounding guard of the inclusive "within 120 m of the muzzle" test, in metres: ONE NANOMETRE.
 *
 * Why it exists at all. The range limit is inclusive and SPEC §4.6 tests it on the boundary (A04 and A13 have
 * |r| = 120 exactly at the firing instant). A moving target reaches that point through a few hundred position
 * updates `pos += vel·h`, each rounded to the nearest double, so the distance the simulation really holds
 * differs from the exact 120 by rounding noise in either direction. Measured with the real Sim for targets
 * placed to be at exactly 120 m when the shot is due (lock times of all 18 loadouts, waits up to 21 s):
 * −3.6e-12 … +5.5e-12 m; a target receding along the line of fire came out "too far" in 108 of 108 runs.
 * With a bare `range <= 120` the lock of such a target would be dropped (or not) by the direction of a
 * rounding error — in the very sub-step of the shot.
 *
 * Why this size. Each update can add at most half a unit in the last place of a coordinate (7.1e-15 m below
 * 128 m), in the worst case always in the same direction, so 1e-9 m covers about 140 000 updates = a whole
 * 20 minute sortie at 120 Hz, while staying six orders of magnitude below the millimetres in which a stage is
 * laid out. It is not a range extension: a target 2 nm beyond 120 m is rejected
 * (tests/fcs.test.ts "the 120 m limit …").
 */
export const FCS_RANGE_TOLERANCE = 1e-9;

/** Distance (m) of the free-fire aim point along the camera-centre ray when the ray hits nothing. */
export const FREE_AIM_FAR = 300;

const MG = WEAPONS.machinegun;
const MISSILE = WEAPONS.missile;

// ───────────────────────────── state constructors ─────────────────────────────

/**
 * Radius of the lock circle in CSS pixels for the current loadout and viewport:
 * `stats.lockRadiusFactor × min(viewport.width, viewport.height)` (SPEC §5). The HUD draws exactly this.
 */
export function lockRadiusCssPx(sim: Sim): number {
  const r = sim.stats.lockRadiusFactor * Math.min(sim.viewport.width, sim.viewport.height);
  return Number.isFinite(r) && r > 0 ? r : 0;
}

export function createLockState(sim: Sim): LockState {
  return {
    state: 'none',
    targetId: null,
    progress: 0,
    heldSeconds: 0,
    radiusCssPx: sim.stats.lockRadiusFactor * Math.min(sim.viewport.width, sim.viewport.height),
  };
}

export function createAimState(): AimState {
  return { mode: 'free', dir: v3(0, 0, -1), point: v3(0, 0, -100) };
}

/** The "no lock" fire-control value: only status and weapon are set (docs/SPEC.md §10). */
export function inactiveSolution(weapon: Weapon): FireSolution {
  return {
    status: 'inactive',
    weapon,
    targetId: null,
    evaluatedAt: null,
    muzzle: null,
    targetPos: null,
    targetVel: null,
    launchDir: null,
    flightSeconds: null,
    intercept: null,
    aimPoint: null,
    residual: null,
  };
}

// ───────────────────────────── lock ─────────────────────────────

const sScreen: ScreenPoint = { x: 0, y: 0, depth: 0 };

/**
 * Lock-candidate test for one enemy with the CURRENT sim state (camera, muzzle, viewport, world):
 * alive, muzzle distance <= FCS_RANGE, in front of the camera, projected hit-centre inside the lock
 * circle, unobstructed from BOTH the camera and the muzzle. Returns the distance in CSS px from the
 * screen centre when it qualifies, otherwise -1.
 *
 * Pure: reads the state, changes nothing. The circle radius is taken from the current stats and viewport
 * (not from the cached lock.radiusCssPx), so a resize or a loadout change can never leave it stale.
 */
export function lockCandidateDistancePx(sim: Sim, enemy: EnemyState): number {
  if (!enemy.alive) return -1;
  const p = enemy.pos;
  const m = sim.player.muzzle;
  if (!isFiniteV3(p) || !isFiniteV3(m)) return -1;

  // Range: measured from the muzzle to the current hit-volume centre.
  const dx = p.x - m.x;
  const dy = p.y - m.y;
  const dz = p.z - m.z;
  const range = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!(range <= FCS_RANGE + FCS_RANGE_TOLERANCE)) return -1;

  // In front of the camera, and the projected centre inside the circle around the viewport centre.
  if (!projectToViewport(sim.camera, sim.viewport, p, sScreen)) return -1;
  const ox = sScreen.x - sim.viewport.width * 0.5;
  const oy = sScreen.y - sim.viewport.height * 0.5;
  const px = Math.sqrt(ox * ox + oy * oy);
  if (!(px <= lockRadiusCssPx(sim))) return -1; // also rejects NaN

  // Stage occlusion of the current centre, from the camera and from the muzzle (TPS parallax).
  if (sim.world.segmentBlocked(sim.camera.pos, p)) return -1;
  if (sim.world.segmentBlocked(m, p)) return -1;
  return px;
}

function clearLock(lock: LockState): void {
  lock.state = 'none';
  lock.targetId = null;
  lock.progress = 0;
  lock.heldSeconds = 0;
}

/** Derives state / progress from heldSeconds for a lock that has a target. */
function applyProgress(lock: LockState, lockSeconds: number): void {
  if (!(lockSeconds > 0) || lock.heldSeconds >= lockSeconds - TIME_EPS) {
    lock.state = 'locked';
    lock.progress = 1;
    return;
  }
  lock.state = 'acquiring';
  const f = lock.heldSeconds / lockSeconds;
  lock.progress = f > 0 ? (f < 1 ? f : 1) : 0;
}

/**
 * Advances the lock state machine to the current sim.time (`h` = length of the sub-step just simulated):
 * keeps the current target while it qualifies (progress += h / lockSeconds), drops target AND progress
 * the instant it does not, otherwise picks the candidate nearest to the screen centre (ties: id order)
 * and starts from 0.
 *
 * The lock time is `sim.stats.lockSeconds` (FCS base time ÷ legs lock-speed multiplier). A target that was
 * dropped never hands its progress to the next one, and a weapon switch is not an input of this function.
 *
 * `h = 0` judges the lock for the current instant without letting any time pass: the progress of a target
 * that still qualifies is untouched, one that does not is dropped, and a new one starts at 0. The simulation
 * does this wherever the judged state changes outside a sub-step: at t = 0 of a sortie (`Sim.reset`, so the
 * continuous time of a target that is in the circle from the start is counted from the start) and when the
 * display area changes (`Sim.setViewport`, so the lock never refers to a circle that is no longer displayed —
 * also while the app is paused and no sub-step runs).
 */
export function updateLock(sim: Sim, h: number): void {
  const lock = sim.lock;
  lock.radiusCssPx = lockRadiusCssPx(sim);
  const lockSeconds = sim.stats.lockSeconds;

  if (lock.targetId != null) {
    const current = sim.enemyById.get(lock.targetId);
    if (current && lockCandidateDistancePx(sim, current) >= 0) {
      // Sticky: another enemy closer to the centre never steals a valid lock.
      if (h > 0 && Number.isFinite(h)) lock.heldSeconds += h;
      applyProgress(lock, lockSeconds);
      return;
    }
    clearLock(lock);
  }

  // No target: the candidate nearest to the screen centre, ties broken by the (stable) id order.
  let best: EnemyState | null = null;
  let bestPx = Number.POSITIVE_INFINITY;
  const enemies = sim.enemies;
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    const px = lockCandidateDistancePx(sim, e);
    if (px < 0) continue;
    if (best === null || px < bestPx || (px === bestPx && e.id < best.id)) {
      best = e;
      bestPx = px;
    }
  }
  if (best) {
    lock.targetId = best.id;
    lock.heldSeconds = 0;
    applyProgress(lock, lockSeconds);
  }
}

/**
 * Re-validates the lock against the current state right before a shot. Drops it when the target no
 * longer qualifies. Returns true when a completed lock is still valid.
 *
 * It never advances the progress and never asks for the lock time again while the target stays valid.
 */
export function revalidateLock(sim: Sim): boolean {
  const lock = sim.lock;
  lock.radiusCssPx = lockRadiusCssPx(sim);
  if (lock.targetId == null) {
    if (lock.state !== 'none') clearLock(lock);
    return false;
  }
  const target = sim.enemyById.get(lock.targetId);
  if (!target || lockCandidateDistancePx(sim, target) < 0) {
    clearLock(lock);
    return false;
  }
  return lock.state === 'locked';
}

/**
 * Time at which the running acquisition completes if the target keeps qualifying, when that is strictly in
 * the future (> sim.time + TIME_EPS); Infinity otherwise. The scheduler ends a sub-step exactly there, so
 * the lock takes exactly `lockSeconds` whatever the sub-step pattern is.
 */
export function lockCompletionTime(sim: Sim): number {
  const lock = sim.lock;
  if (lock.state !== 'acquiring' || lock.targetId == null) return Infinity;
  const t = sim.time + (sim.stats.lockSeconds - lock.heldSeconds);
  return t > sim.time + TIME_EPS && Number.isFinite(t) ? t : Infinity;
}

// ───────────────────────────── fire-control solution ─────────────────────────────

/**
 * Unit vector from `m` to `p`. When the two points practically coincide (no direction exists) the camera
 * forward is used instead — the shot then starts inside the target's hit volume and the normal collision
 * code resolves it at the muzzle (§4.3 "ゼロ除算を避け…"). Never NaN.
 */
function directAim(sim: Sim, m: V3, p: V3): V3 {
  const dx = p.x - m.x;
  const dy = p.y - m.y;
  const dz = p.z - m.z;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len > DEGENERATE_RANGE && Number.isFinite(len)) return v3(dx / len, dy / len, dz / len);
  return fallbackDirection(sim);
}

/** Camera forward as a unit vector; (0, 0, -1) if the camera state is unusable. */
function fallbackDirection(sim: Sim): V3 {
  const f = sim.camera.forward;
  const len = Math.sqrt(f.x * f.x + f.y * f.y + f.z * f.z);
  if (len > 1e-9 && Number.isFinite(len)) return v3(f.x / len, f.y / len, f.z / len);
  return v3(0, 0, -1);
}

/**
 * Fire-control solution for `weapon` from the CURRENT state (same-time muzzle, target centre and actual
 * target velocity). 'inactive' unless the lock is complete. Never reuses values of an earlier target.
 *
 *   machinegun  lead + drop: smallest root in (0, 2 s] of |r + v t − ½ g t²|² − s² t² = 0, s = 100, g = 18
 *               (§4.3). launchDir = (r + v t − ½ g t²)/(s t), intercept = p + v t, aimPoint = p + v t − ½ g t².
 *   beam        hitscan: launchDir = normalize(p − m), flight time 0, residual 0, aimPoint = intercept = p (§4.4).
 *   missile     45 m/s lead: smallest root in (0, 4 s] of (v·v − s²) t² + 2 (r·v) t + r·r = 0,
 *               launchDir = normalize(r + v t), aimPoint = intercept = p + v t (§4.4).
 *
 * No root in the weapon's life time → 'no_solution': the lock is kept, launchDir aims straight at the
 * current centre, aimPoint = p, and flightSeconds / intercept / residual are null. Whether the straight line
 * or the parabola is obstructed by the stage has no influence on the status.
 *
 * The returned object and every vector in it are fresh copies. Does not modify the simulation.
 */
export function computeFireSolution(sim: Sim, weapon: Weapon): FireSolution {
  const lock = sim.lock;
  if (lock.state !== 'locked' || lock.targetId == null) return inactiveSolution(weapon);
  const target = sim.enemyById.get(lock.targetId);
  if (!target || !target.alive) return inactiveSolution(weapon);
  const m = sim.player.muzzle;
  const p = target.pos;
  const v = target.vel;
  if (!isFiniteV3(m) || !isFiniteV3(p) || !isFiniteV3(v)) return inactiveSolution(weapon);

  const sol: FireSolution = {
    status: 'no_solution',
    weapon,
    targetId: target.id,
    evaluatedAt: sim.time,
    muzzle: clone(m),
    targetPos: clone(p),
    targetVel: clone(v),
    launchDir: null,
    flightSeconds: null,
    intercept: null,
    aimPoint: null,
    residual: null,
  };

  if (weapon === 'machinegun') {
    // The enemy AI's 1.2 s prediction cap does not apply here: the bound is the bullet's own life (2 s).
    const g = solveGravityIntercept(m, p, v, MG.speed, MG.gravity, MG.lifeSeconds);
    if (g) {
      sol.status = 'solved';
      sol.launchDir = clone(g.dir);
      sol.flightSeconds = g.t;
      sol.intercept = clone(g.intercept);
      sol.aimPoint = clone(g.aimPoint);
      sol.residual = g.residual;
      return sol;
    }
  } else if (weapon === 'beam') {
    sol.status = 'solved';
    sol.launchDir = directAim(sim, m, p);
    sol.flightSeconds = 0;
    sol.intercept = clone(p);
    sol.aimPoint = clone(p);
    sol.residual = 0;
    return sol;
  } else {
    const l = solveLinearIntercept(m, p, v, MISSILE.speed, MISSILE.lifeSeconds);
    if (l) {
      // Distance between the missile flying straight along the lead direction and the predicted centre.
      const ex = m.x + MISSILE.speed * l.dir.x * l.t - l.intercept.x;
      const ey = m.y + MISSILE.speed * l.dir.y * l.t - l.intercept.y;
      const ez = m.z + MISSILE.speed * l.dir.z * l.t - l.intercept.z;
      const residual = Math.sqrt(ex * ex + ey * ey + ez * ez);
      if (Number.isFinite(residual)) {
        sol.status = 'solved';
        sol.launchDir = clone(l.dir);
        sol.flightSeconds = l.t;
        sol.intercept = clone(l.intercept);
        sol.aimPoint = clone(l.intercept);
        sol.residual = residual;
        return sol;
      }
    }
  }

  // No valid solution within the weapon's life: direct aim at the current position, lock untouched.
  sol.launchDir = directAim(sim, m, p);
  sol.aimPoint = clone(p);
  return sol;
}

// ───────────────────────────── free fire ─────────────────────────────

const sStart = v3();
let sRayHit: RayHit | undefined;

/**
 * Free-fire aim: the point hit by the camera-centre ray (world or enemy; far point when nothing is hit),
 * and the unit direction from the muzzle to it.
 *
 * The ray is evaluated from the depth of the muzzle onwards, so geometry between the camera and the mech is
 * never picked. The result is only the place under the crosshair: no lead, no drop compensation, no snap to
 * an enemy centre. The shot itself still starts at the muzzle and is stopped by whatever stands in front of
 * it, even where the camera can see past that obstacle (§4.5).
 */
export function computeFreeAim(sim: Sim, outPoint: V3, outDir: V3): void {
  const c = sim.camera;
  const m = sim.player.muzzle;
  const f = fallbackDirection(sim);
  if (!isFiniteV3(c.pos) || !isFiniteV3(m)) {
    const o = isFiniteV3(m) ? m : isFiniteV3(c.pos) ? c.pos : v3();
    outPoint.x = o.x + f.x * FREE_AIM_FAR;
    outPoint.y = o.y + f.y * FREE_AIM_FAR;
    outPoint.z = o.z + f.z * FREE_AIM_FAR;
    outDir.x = f.x;
    outDir.y = f.y;
    outDir.z = f.z;
    return;
  }

  // Point of the camera-centre ray at the depth of the muzzle.
  let depth = (m.x - c.pos.x) * f.x + (m.y - c.pos.y) * f.y + (m.z - c.pos.z) * f.z;
  if (!(depth > 0)) depth = 0;
  sStart.x = c.pos.x + f.x * depth;
  sStart.y = c.pos.y + f.y * depth;
  sStart.z = c.pos.z + f.z * depth;

  let dist = FREE_AIM_FAR;
  const hit = sim.world.raycast(sStart, f, FREE_AIM_FAR, sRayHit);
  if (hit) {
    sRayHit = hit;
    if (hit.dist < dist) dist = hit.dist;
  }
  const enemies = sim.enemies;
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i];
    if (!e.alive) continue;
    const d = raySphere(sStart, f, e.pos, e.radius, dist);
    if (d >= 0 && d < dist) dist = d;
  }

  outPoint.x = sStart.x + f.x * dist;
  outPoint.y = sStart.y + f.y * dist;
  outPoint.z = sStart.z + f.z * dist;

  const dx = outPoint.x - m.x;
  const dy = outPoint.y - m.y;
  const dz = outPoint.z - m.z;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len > DEGENERATE_RANGE && Number.isFinite(len)) {
    outDir.x = dx / len;
    outDir.y = dy / len;
    outDir.z = dz / len;
  } else {
    outDir.x = f.x;
    outDir.y = f.y;
    outDir.z = f.z;
  }
}

/**
 * Refreshes sim.fireControl (HUD + snapshot) and sim.aim (gun model) for the current time.
 *
 * sim.fireControl = the solution of the selected weapon for the locked target ('inactive' with null fields
 * unless the lock is complete). sim.aim = that solution's launch direction and aim point (mode 'fcs'), or the
 * free-fire aim (mode 'free'). Runs every sub-step; changes nothing but these two.
 */
export function refreshFireControl(sim: Sim): void {
  const sol = computeFireSolution(sim, sim.player.weapon);
  sim.fireControl = sol;
  const aim = sim.aim;
  if (sol.status !== 'inactive' && sol.launchDir && sol.aimPoint) {
    aim.mode = 'fcs';
    aim.dir.x = sol.launchDir.x;
    aim.dir.y = sol.launchDir.y;
    aim.dir.z = sol.launchDir.z;
    aim.point.x = sol.aimPoint.x;
    aim.point.y = sol.aimPoint.y;
    aim.point.z = sol.aimPoint.z;
    return;
  }
  aim.mode = 'free';
  computeFreeAim(sim, aim.point, aim.dir);
}
