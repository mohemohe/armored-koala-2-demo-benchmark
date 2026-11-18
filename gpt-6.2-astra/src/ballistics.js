import { Vector3 } from 'three';

export const WEAPONS = Object.freeze({
  machinegun: { damage: 12, interval: 0.10, speed: 100, gravity: -18, life: 2, ammo: 300 },
  beam: { damage: 40, interval: 0.25, cost: 8, range: 120 },
  missile: { damage: 180, interval: 1, speed: 45, gravity: 0, life: 4, turn: 2 * Math.PI / 3, ammo: 12 },
});
export const LOCK_RANGE = 120;
const value = (coefficients, t) => coefficients.reduceRight((y, c) => y * t + c, 0);

// Derivative roots partition the interval into monotone pieces. Testing the
// endpoints of all pieces captures grazing roots as well as the lifetime limit.
function roots(coefficients, lo, hi) {
  let c = coefficients;
  while (c.length > 1 && Math.abs(c.at(-1)) < 1e-14) c = c.slice(0, -1);
  if (c.length < 2) return [];
  if (c.length === 2) {
    const t = -c[0] / c[1];
    return t >= lo - 1e-12 && t <= hi + 1e-12 ? [Math.max(lo, Math.min(hi, t))] : [];
  }
  const critical = roots(c.slice(1).map((n, i) => n * (i + 1)), lo, hi);
  const boundaries = [lo, ...critical, hi];
  const found = [];
  for (let i = 0; i < boundaries.length; i++) {
    const a = boundaries[i], y = value(c, a);
    const tolerance = 4e-13 * (1 + value(c.map(Math.abs), Math.abs(a)));
    if (Math.abs(y) <= tolerance) found.push(a);
    if (i === 0) continue;
    let l = boundaries[i - 1], h = a;
    const negative = value(c, l) < 0;
    if (negative === (y < 0)) continue;
    for (let j = 0; j < 54; j++) {
      const m = (l + h) / 2;
      if ((value(c, m) < 0) === negative) l = m;
      else h = m;
    }
    found.push((h + l) / 2);
  }
  return found.sort((a, b) => a - b);
}

export function interceptTime(r, v, speed, maxTime) {
  const a = v.lengthSq() - speed * speed, b = 2 * r.dot(v), c = r.lengthSq();
  let candidates;
  if (Math.abs(a) < 1e-10) candidates = Math.abs(b) < 1e-12 ? [] : [-c / b];
  else {
    const d = b * b - 4 * a * c;
    if (d < -1e-12 * (1 + b * b + Math.abs(4 * a * c))) return null;
    const q = -0.5 * (b + (b >= 0 ? 1 : -1) * Math.sqrt(Math.max(0, d)));
    candidates = q === 0 ? [-b / (2 * a)] : [q / a, c / q];
  }
  const times = candidates.filter(t => t > 1e-10 && t <= maxTime + 1e-12);
  return times.length ? Math.min(maxTime, ...times) : null;
}

export function safeDirection(v, fallback = new Vector3(0, 0, 1)) {
  return v.lengthSq() > 1e-20 ? v.normalize() : v.copy(fallback);
}

export function inactive(weapon) {
  return { status: 'inactive', weapon, targetId: null, evaluatedAtSeconds: null, muzzlePosition: null,
    targetPosition: null, targetVelocity: null, launchDirection: null, predictedFlightSeconds: null,
    predictedInterceptPosition: null, aimPoint: null, residualMeters: null };
}

export function solve(weapon, muzzle, target, now, fallback) {
  const cfg = WEAPONS[weapon], p = target.pos, v = target.vel;
  const r = p.clone().sub(muzzle);
  let times = [];
  if (weapon === 'machinegun') {
    const k = -cfg.gravity / 2;
    times = roots([r.lengthSq(), 2 * r.dot(v), v.lengthSq() + 2*k*r.y - cfg.speed**2,
      2*k*v.y, k*k], 0, cfg.life).filter(t => t > 1e-10);
  } else if (weapon === 'missile') {
    const t = interceptTime(r, v, cfg.speed, cfg.life);
    if (t !== null) times.push(t);
  } else times.push(0);

  const base = { ...inactive(weapon), status: 'no_solution', targetId: target.id,
    evaluatedAtSeconds: now, muzzlePosition: muzzle.toArray(), targetPosition: p.toArray(), targetVelocity: v.toArray(),
    aimPoint: p.toArray(), launchDirection: safeDirection(r.clone(), fallback).toArray() };
  for (const t of times) {
    const intercept = p.clone().addScaledVector(v, t);
    const aim = intercept.clone();
    aim.y -= 0.5 * (cfg.gravity || 0) * t*t;
    const dir = safeDirection(aim.clone().sub(muzzle), fallback);
    let residual = 0;
    if (weapon !== 'beam') {
      const predicted = muzzle.clone().addScaledVector(dir, cfg.speed * t);
      predicted.y += 0.5 * cfg.gravity * t*t;
      residual = predicted.distanceTo(intercept);
    }
    if (!Number.isFinite(residual) || residual > 0.00001) continue;
    return { ...base, status: 'solved', launchDirection: dir.toArray(), predictedFlightSeconds: t,
      predictedInterceptPosition: intercept.toArray(), aimPoint: aim.toArray(), residualMeters: residual };
  }
  return base;
}

// First time along simultaneous shot and actor linear segments. In relative
// coordinates the sphere is stationary even when the actor crosses the shot.
export function sweepSphere(start, end, oldCenter, newCenter, radius) {
  const x = start.x-oldCenter.x, y = start.y-oldCenter.y, z = start.z-oldCenter.z;
  const c = x*x + y*y + z*z - radius*radius;
  if (c <= 0) return 0;
  const dx = (end.x-start.x) - (newCenter.x-oldCenter.x);
  const dy = (end.y-start.y) - (newCenter.y-oldCenter.y);
  const dz = (end.z-start.z) - (newCenter.z-oldCenter.z);
  const a = dx*dx + dy*dy + dz*dz;
  const b = x*dx + y*dy + z*dz;
  const discriminant = b*b - a*c;
  if (a === 0 || b >= 0 || discriminant < 0) return Infinity;
  const t = c / (-b + Math.sqrt(discriminant));
  return t >= 0 && t <= 1 ? t : Infinity;
}

export function turnToward(direction, goal, angleLimit) {
  const angle = direction.angleTo(goal);
  if (angle <= angleLimit) return direction.copy(goal);
  const axis = direction.clone().cross(goal);
  if (axis.lengthSq() < 1e-18) {
    axis.set(0, 1, 0);
    if (Math.abs(direction.y) > 0.9) axis.set(1, 0, 0);
    axis.cross(direction);
  }
  return direction.applyAxisAngle(axis.normalize(), angleLimit).normalize();
}
