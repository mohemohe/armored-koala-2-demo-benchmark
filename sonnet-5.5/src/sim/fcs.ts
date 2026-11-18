/** FCS lock logic + HUD fire-control solution. OWNER: combat agent. SPEC §5, §4.2 */
import { FCS } from '../config';
import { playerMuzzlePosition } from './camera';
import { findEnemy, pushEvent } from './combat';
import { distance } from './math';
import { projectToScreen } from './project';
import { lockRadiusCssPx } from './stats';
import { inactiveFireControl } from './types';
import type { EnemyState, GameState, IWorld, V3 } from './types';
import { computeFireSolution, toFireControlState } from './weapons';

/** slack for the 120 m range test [m]: the same 1e-9 tolerance every other threshold uses (docs/ARCH.md §3) */
const RANGE_EPS = 1e-9;
/** slack for the circle test [css px] */
const CIRCLE_EPS = 1e-9;
/** lock completes when the continuous valid time reaches lockSeconds (time comparisons carry 1e-9, docs/ARCH.md §3) */
const TIME_EPS = 1e-9;

/**
 * Distance of the enemy's hit-box center from the screen center [css px] when the enemy satisfies every lock-candidate
 * condition (SPEC §5), else null. The judged point is ALWAYS the current hit-box center, never a predicted/corrected point.
 */
function candidateScreenDistance(state: GameState, world: IWorld, enemy: EnemyState, muzzle: V3, radiusPx: number): number | null {
  if (!enemy.alive) return null;
  if (distance(muzzle, enemy.pos) > FCS.RANGE + RANGE_EPS) return null;
  const sp = projectToScreen(state.camera, enemy.pos);
  if (!sp.inFront) return null;
  const d = Math.hypot(sp.x, sp.y);
  if (!(d <= radiusPx + CIRCLE_EPS)) return null;
  // both the camera and the muzzle must see the target center
  if (world.segmentBlocked(state.camera.pos, enemy.pos)) return null;
  if (world.segmentBlocked(muzzle, enemy.pos)) return null;
  return d;
}

/** keep state.lock.radiusCssPx in step with the viewport (the drawn circle and the tested circle are the same number) */
function syncRadius(state: GameState): number {
  const r = lockRadiusCssPx(state.loadout, state.camera.viewportW, state.camera.viewportH);
  state.lock.radiusCssPx = r;
  return r;
}

/** discard the target and its progress; the next target starts from 0 (SPEC §5) */
function dropLock(state: GameState): void {
  const lock = state.lock;
  if (lock.state === 'locked') {
    pushEvent(state, { type: 'notice', time: state.time, kind: 'lockLost', weapon: state.player.weapon });
  }
  lock.state = 'none';
  lock.targetId = null;
  lock.progress = 0;
  lock.elapsed = 0;
  state.fc = inactiveFireControl(state.player.weapon);
}

/**
 * Step C (end of tick, state at T+dt): validate the current target, pick a new one if none, advance progress by dt
 * (only while the same target stays valid), and refresh state.lock + state.fc for the HUD/snapshot.
 *
 * Progress is the time the SAME target has been continuously valid, measured between validity samples: the sample that
 * first selects a target has elapsed = 0, every following tick adds dt, so a lock never completes earlier than lockSeconds.
 */
export function updateFcs(state: GameState, world: IWorld, dt: number): void {
  const lock = state.lock;
  const radius = syncRadius(state);
  const muzzle = playerMuzzlePosition(state.player);
  const wasLocked = lock.state === 'locked';

  let target: EnemyState | undefined = findEnemy(state, lock.targetId);
  if (target && candidateScreenDistance(state, world, target, muzzle, radius) !== null) {
    lock.elapsed += dt; // same target, still valid
  } else {
    if (lock.targetId !== null && wasLocked) {
      pushEvent(state, { type: 'notice', time: state.time, kind: 'lockLost', weapon: state.player.weapon });
    }
    lock.targetId = null;
    lock.elapsed = 0;
    target = undefined;
    // no target: choose the candidate closest to the screen center (ties -> lowest id)
    let bestD = Infinity;
    for (const e of state.enemies) {
      const d = candidateScreenDistance(state, world, e, muzzle, radius);
      if (d === null) continue;
      if (d < bestD - 1e-9 || (Math.abs(d - bestD) <= 1e-9 && target !== undefined && e.id < target.id)) {
        bestD = d;
        target = e;
      }
    }
    if (target) lock.targetId = target.id;
  }

  if (!target) {
    lock.state = 'none';
    lock.progress = 0;
    lock.elapsed = 0;
  } else if (lock.elapsed >= state.stats.lockSeconds - TIME_EPS) {
    lock.state = 'locked';
    lock.progress = 1;
    if (!wasLocked) pushEvent(state, { type: 'notice', time: state.time, kind: 'lockAcquired', weapon: state.player.weapon });
  } else {
    lock.state = 'acquiring';
    lock.progress = Math.min(1, Math.max(0, lock.elapsed / state.stats.lockSeconds));
  }

  // HUD / snapshot solution: the same function the real shot uses, only once the lock is complete
  if (lock.state === 'locked' && target) {
    state.fc = toFireControlState(computeFireSolution(state, world, state.player.weapon, target, muzzle));
  } else {
    state.fc = inactiveFireControl(state.player.weapon);
  }
}

/**
 * Recompute the HUD / snapshot solution (state.fc) from the CURRENT pose without running a tick: used by Game.look(), whose yaw
 * change moves the yaw-frame muzzle, so the last updateFcs solution would otherwise be up to one look step older than the real
 * shot (which always recomputes from the newest state). Only refreshes a lock-complete solution whose target is alive, with the
 * same computeFireSolution the shot uses. It neither advances the lock progress nor validates / drops the lock: that stays the
 * job of updateFcs (end of tick) and revalidateLock (at fire time).
 */
export function refreshFireSolution(state: GameState, world: IWorld): void {
  const lock = state.lock;
  if (lock.state !== 'locked' || lock.targetId === null) return;
  const target = findEnemy(state, lock.targetId);
  if (!target || !target.alive) return;
  state.fc = toFireControlState(computeFireSolution(state, world, state.player.weapon, target, playerMuzzlePosition(state.player)));
}

/**
 * Step A2 (before firing, state at T): re-verify that the locked target is still a valid lock candidate
 * (alive, <=120 m from the muzzle, in front of camera, inside the FCS circle, camera+muzzle LOS clear).
 * If not: DISCARD lock + target immediately (state.lock -> none). Does NOT advance progress. Returns true when locked & valid.
 */
export function revalidateLock(state: GameState, world: IWorld): boolean {
  const lock = state.lock;
  const radius = syncRadius(state);
  if (lock.targetId === null) return false;
  const target = findEnemy(state, lock.targetId);
  const muzzle = playerMuzzlePosition(state.player);
  if (!target || candidateScreenDistance(state, world, target, muzzle, radius) === null) {
    dropLock(state);
    return false;
  }
  return lock.state === 'locked';
}

/** true when `enemy` satisfies every lock-candidate condition right now (SPEC §5) */
export function isLockCandidate(state: GameState, world: IWorld, enemy: EnemyState): boolean {
  const radius = lockRadiusCssPx(state.loadout, state.camera.viewportW, state.camera.viewportH);
  return candidateScreenDistance(state, world, enemy, playerMuzzlePosition(state.player), radius) !== null;
}
