import { Vector3 } from 'three';

// All projectile velocities are world velocities. These routines are shared by
// live fire and the deterministic checks in tests/combat.test.js.
const EPS = 1e-10;
const value = (c, x) => c.reduceRight((v, n) => v * x + n, 0);

/** Find every real root in [lo, hi], including stationary (even) roots. */
export function polynomialRootsInInterval(coefficients, lo, hi) {
  const c = coefficients.slice();
  while (c.length > 1 && Math.abs(c[c.length - 1]) < 1e-14) c.pop();
  if (c.length === 1) return [];
  if (c.length === 2) {
    const x = -c[0] / c[1];
    return Number.isFinite(x) && x >= lo - EPS && x <= hi + EPS ? [Math.max(lo, Math.min(hi, x))] : [];
  }
  const derivative = c.slice(1).map((n, i) => n * (i + 1));
  const critical = polynomialRootsInInterval(derivative, lo, hi);
  const cuts = [lo, ...critical.filter(x => x > lo + EPS && x < hi - EPS), hi];
  const roots = [];
  const scaleAt = x => c.reduce((s, a, i) => s + Math.abs(a) * Math.pow(Math.abs(x), i), 0);
  const add = x => { if (!roots.some(r => Math.abs(r - x) < 1e-8)) roots.push(x); };
  for (const x of cuts) {
    if (Math.abs(value(c, x)) <= 1e-11 * Math.max(1, scaleAt(x))) add(x);
  }
  for (let i = 0; i < cuts.length - 1; i++) {
    let a = cuts[i], b = cuts[i + 1], fa = value(c, a), fb = value(c, b);
    if (fa === 0 || fb === 0 || Math.sign(fa) === Math.sign(fb)) continue;
    for (let j = 0; j < 80; j++) {
      const mid = (a + b) / 2, fm = value(c, mid);
      if (Math.sign(fm) === Math.sign(fa)) { a = mid; fa = fm; }
      else { b = mid; fb = fm; }
    }
    add((a + b) / 2);
  }
  return roots.sort((a, b) => a - b);
}

function directionOrDefault(delta) {
  return delta.lengthSq() > EPS * EPS ? delta.clone().normalize() : new Vector3(0, 0, 1);
}

/** Pure fire-control calculation from the actual muzzle and target state. */
export function solveFireControl(weapon, muzzle, targetPosition, targetVelocity, maxTime = null) {
  const r = targetPosition.clone().sub(muzzle);
  const direct = directionOrDefault(r);
  const noSolution = () => ({ status: 'no_solution', direction: direct, time: null,
    intercept: null, aimPoint: targetPosition.clone(), residual: null });
  if (weapon === 'beam') {
    return { status: 'solved', direction: direct, time: 0,
      intercept: targetPosition.clone(), aimPoint: targetPosition.clone(), residual: 0 };
  }
  const speed = weapon === 'machinegun' ? 100 : 45;
  const limit = Math.min(weapon === 'machinegun' ? 2 : 4, maxTime ?? Infinity);
  // r + v*t - 0.5*g*t²; machinegun g = (0,-18,0).
  const gravityCorrection = weapon === 'machinegun' ? 9 : 0;
  const coefficients = [r.lengthSq(), 2 * r.dot(targetVelocity),
    targetVelocity.lengthSq() + 2 * gravityCorrection * r.y - speed * speed,
    2 * gravityCorrection * targetVelocity.y, gravityCorrection * gravityCorrection];
  const roots = polynomialRootsInInterval(coefficients, 0, limit);
  for (const time of roots) {
    if (!(time > 1e-8 && time <= limit + EPS)) continue;
    const intercept = targetPosition.clone().addScaledVector(targetVelocity, time);
    const aimPoint = intercept.clone().add(new Vector3(0, gravityCorrection * time * time, 0));
    const required = aimPoint.clone().sub(muzzle);
    if (required.lengthSq() < EPS * EPS) continue;
    const direction = required.normalize();
    const atTime = muzzle.clone().addScaledVector(direction, speed * time)
      .add(new Vector3(0, -gravityCorrection * time * time, 0));
    const residual = atTime.distanceTo(intercept);
    if (Number.isFinite(residual) && residual <= 0.01) {
      return { status: 'solved', direction, time, intercept, aimPoint, residual };
    }
  }
  return noSolution();
}

/** Analytic machinegun trajectory; no velocity inheritance or guidance. */
export function projectilePosition(shot, age) {
  return shot.origin.clone().addScaledVector(shot.velocity, age)
    .addScaledVector(shot.acceleration, 0.5 * age * age);
}

/** First contact fraction of simultaneous linear motion, or null. */
export function segmentMovingSphere(start, end, targetStart, targetEnd, radius) {
  const relativeStart = start.clone().sub(targetStart);
  const delta = end.clone().sub(start).sub(targetEnd.clone().sub(targetStart));
  const c = relativeStart.lengthSq() - radius * radius;
  if (c <= 0) return 0;
  const a = delta.lengthSq();
  if (a < EPS) return null;
  const b = 2 * relativeStart.dot(delta);
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return null;
  const t = (-b - Math.sqrt(discriminant)) / (2 * a);
  return t >= 0 && t <= 1 ? t : null;
}

/** Unit heading rotated toward desired by at most 120 degrees/second. */
export function steerMissile(direction, desired, dt) {
  const from = directionOrDefault(direction), to = directionOrDefault(desired);
  const angle = Math.acos(Math.max(-1, Math.min(1, from.dot(to))));
  const maxAngle = 2 * Math.PI / 3 * dt;
  if (angle <= maxAngle || angle < EPS) return to;
  let axis = new Vector3().crossVectors(from, to);
  if (axis.lengthSq() < EPS) {
    axis = new Vector3().crossVectors(from, Math.abs(from.y) < .9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0));
  }
  return from.applyAxisAngle(axis.normalize(), maxAngle).normalize();
}
