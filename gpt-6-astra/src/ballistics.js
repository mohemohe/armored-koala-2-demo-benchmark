import { Vector3 } from 'three';

const EPS = 1e-10;
const ZERO = new Vector3();

/** Real roots on a closed interval, isolated at every derivative root.
 * Splitting at extrema detects touching even-multiplicity roots as well as sign changes.
 */
export function polynomialRootsInInterval(coefficients, lower, upper) {
  const c = coefficients.slice();
  while (c.length > 1 && Math.abs(c[0]) < 1e-13) c.shift();
  if (c.length <= 1) return [];
  if (c.length === 2) {
    const r = -c[1] / c[0];
    return Number.isFinite(r) && r >= lower - EPS && r <= upper + EPS ? [Math.min(upper, Math.max(lower, r))] : [];
  }
  const value = (x) => c.reduce((acc, coefficient) => acc * x + coefficient, 0);
  const scaleAt = (x) => c.reduce((acc, coefficient) => acc * Math.abs(x) + Math.abs(coefficient), 0);
  const stationary = polynomialRootsInInterval(c.slice(0, -1).map((v, i) => v * (c.length - 1 - i)), lower, upper);
  const bounds = [lower, ...stationary.filter((r) => r > lower + EPS && r < upper - EPS), upper];
  const roots = [];
  const add = (x) => { if (!roots.some((r) => Math.abs(r - x) < 1e-8)) roots.push(x); };
  for (const x of bounds) if (Math.abs(value(x)) <= Math.max(1, scaleAt(x)) * 1e-11) add(x);
  for (let i = 0; i < bounds.length - 1; i++) {
    let a = bounds[i], b = bounds[i + 1], fa = value(a), fb = value(b);
    if (fa * fb >= 0) continue;
    for (let n = 0; n < 90 && b - a > 1e-12; n++) {
      const m = (a + b) * .5, fm = value(m);
      if (fa * fm <= 0) { b = m; fb = fm; } else { a = m; fa = fm; }
    }
    add((a + b) * .5);
  }
  return roots.sort((a, b) => a - b);
}

/** World-space launch solution; shooter velocity is deliberately absent. */
export function solveIntercept(muzzle, target, targetVelocity, speed, maxTime, gravity = ZERO) {
  const r = target.clone().sub(muzzle), h = gravity.clone().multiplyScalar(-.5);
  const coefficients = [
    h.dot(h), 2 * h.dot(targetVelocity),
    targetVelocity.lengthSq() + 2 * h.dot(r) - speed * speed,
    2 * r.dot(targetVelocity), r.lengthSq(),
  ];
  const roots = polynomialRootsInInterval(coefficients, 0, maxTime);
  for (const time of roots) {
    if (time <= 1e-9) continue;
    const intercept = target.clone().addScaledVector(targetVelocity, time);
    const aimPoint = intercept.clone().addScaledVector(gravity, -.5 * time * time);
    const direction = aimPoint.clone().sub(muzzle).normalize();
    const impact = muzzle.clone().addScaledVector(direction, speed * time).addScaledVector(gravity, .5 * time * time);
    const residual = impact.distanceTo(intercept);
    if (Number.isFinite(residual) && residual <= .01 && direction.lengthSq() > .99999) return { time, direction, intercept, aimPoint, residual };
  }
  return null;
}

/** Earliest continuous contact of a moving segment with a moving sphere. */
export function movingSphereIntersection(start, end, centerStart, centerEnd, radius) {
  const r = start.clone().sub(centerStart);
  const delta = end.clone().sub(start).sub(centerEnd.clone().sub(centerStart));
  const c = r.lengthSq() - radius * radius;
  if (c <= 0) return 0;
  const a = delta.lengthSq();
  if (a < 1e-18) return null;
  const b = 2 * r.dot(delta), discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return null;
  const t = (-b - Math.sqrt(Math.max(0, discriminant))) / (2 * a);
  return t >= -EPS && t <= 1 + EPS ? Math.max(0, Math.min(1, t)) : null;
}

/** Rotate through at most maxRadians, including the antiparallel case. */
export function turnDirection(current, desired, maxRadians) {
  const angle = Math.acos(Math.max(-1, Math.min(1, current.dot(desired))));
  if (angle <= maxRadians || angle < 1e-10) return desired.clone();
  const axis = current.clone().cross(desired);
  if (axis.lengthSq() < 1e-12) {
    axis.crossVectors(current, Math.abs(current.y) < .9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0));
  }
  return current.clone().applyAxisAngle(axis.normalize(), maxRadians).normalize();
}
