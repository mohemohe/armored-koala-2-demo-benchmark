import { add, sub, scale, dot, length, normalize, solveBallistic, solveIntercept } from './ballistics.js';
import { CONFIG, WEAPONS } from './config.js';

const alive = enemy => enemy && enemy.alive !== false && enemy.hp > 0;

export function lockCandidate(enemy, muzzle, camera, world, radiusCssPx) {
  if (!alive(enemy) || length(sub(enemy.position, muzzle)) > CONFIG.lockRange + 1e-9) return null;
  if (dot(sub(enemy.position, camera.position), camera.forward) <= 0) return null;
  const screen = camera.project(enemy.position);
  if (!screen || !Number.isFinite(screen.x) || !Number.isFinite(screen.y) || !Number.isFinite(screen.depth) || screen.depth <= 0) return null;
  const squaredDistance = (screen.x - camera.width / 2) ** 2 + (screen.y - camera.height / 2) ** 2;
  if (squaredDistance > radiusCssPx ** 2 + 1e-9) return null;
  if (world?.lineOfSight?.(camera.position, enemy.position) === false || world?.lineOfSight?.(muzzle, enemy.position) === false) return null;
  return { enemy, squaredDistance };
}

export function updateLock(lock, enemies, muzzle, camera, world, dt, lockSeconds, radiusCssPx) {
  lock.radiusCssPx = radiusCssPx;
  let candidate = enemies.find(enemy => enemy.id === lock.targetId);
  if (!lockCandidate(candidate, muzzle, camera, world, radiusCssPx)) {
    lock.state = 'none'; lock.targetId = null; lock.progress = 0;
    const candidates = enemies.map(enemy => lockCandidate(enemy, muzzle, camera, world, radiusCssPx)).filter(Boolean);
    candidates.sort((a, b) => a.squaredDistance - b.squaredDistance || String(a.enemy.id).localeCompare(String(b.enemy.id), 'en'));
    candidate = candidates[0]?.enemy;
    if (!candidate) return lock;
    lock.targetId = candidate.id;
    lock.state = 'acquiring';
    return lock; // A new target starts at zero and never inherits previous progress.
  }
  lock.progress = Math.min(1, Math.max(0, lock.progress + Math.max(0, dt) / lockSeconds));
  lock.state = lock.progress >= 1 - 1e-12 ? 'locked' : 'acquiring';
  if (lock.state === 'locked') lock.progress = 1;
  return lock;
}

export function makeFireControl(weapon, lock, enemies, muzzle, time) {
  const inactive = {
    status: 'inactive', weapon, targetId: null, evaluatedAtSeconds: null, muzzlePosition: null,
    targetPosition: null, targetVelocity: null, launchDirection: null, predictedFlightSeconds: null,
    predictedInterceptPosition: null, aimPoint: null, residualMeters: null,
  };
  if (lock.state !== 'locked') return inactive;
  const target = enemies.find(enemy => enemy.id === lock.targetId && alive(enemy));
  if (!target) return inactive;
  const p = target.position, v = target.velocity;
  const solution = weapon === 'machinegun' ? solveBallistic(muzzle, p, v)
    : weapon === 'missile' ? solveIntercept(muzzle, p, v)
      : { direction: normalize(sub(p, muzzle)), flightSeconds: 0, intercept: [...p], aimPoint: [...p], residual: 0 };
  return {
    status: solution ? 'solved' : 'no_solution', weapon, targetId: target.id, evaluatedAtSeconds: time,
    muzzlePosition: [...muzzle], targetPosition: [...p], targetVelocity: [...v],
    launchDirection: [...(solution?.direction ?? normalize(sub(p, muzzle)))],
    predictedFlightSeconds: solution?.flightSeconds ?? null,
    predictedInterceptPosition: solution ? [...solution.intercept] : null,
    aimPoint: [...(solution?.aimPoint ?? p)], residualMeters: solution?.residual ?? null,
  };
}

export function freeAimDirection(muzzle, cameraPosition, cameraForward, enemies, world) {
  // Camera-centre first collision becomes the aim point, while the actual ray is
  // still emitted from the muzzle and therefore can hit a nearby intervening wall.
  const end = add(cameraPosition, scale(cameraForward, WEAPONS.beam.range));
  const worldHit = world?.traceSegment?.(cameraPosition, end);
  let fraction = typeof worldHit === 'number' ? worldHit : worldHit?.fraction ?? worldHit?.t ?? 1;
  const relative = sub(end, cameraPosition);
  for (const enemy of enemies) {
    if (!alive(enemy)) continue;
    const offset = sub(enemy.position, cameraPosition), along = dot(offset, cameraForward);
    const perpendicularSquared = dot(offset, offset) - along * along, radius = enemy.radius ?? 1.6;
    if (along > 0 && perpendicularSquared <= radius * radius) {
      const distance = along - Math.sqrt(Math.max(0, radius * radius - perpendicularSquared));
      fraction = Math.min(fraction, distance / WEAPONS.beam.range);
    }
  }
  return normalize(sub(add(cameraPosition, scale(relative, fraction)), muzzle));
}
