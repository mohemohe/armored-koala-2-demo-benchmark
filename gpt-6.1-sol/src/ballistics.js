import { CONFIG, WEAPONS } from './config.js';

// All positions, velocities and directions are world-space three-element arrays.
export const add = (a, b) => a.map((n, i) => n + b[i]);
export const sub = (a, b) => a.map((n, i) => n - b[i]);
export const scale = (a, s) => a.map(n => n * s);
export const dot = (a, b) => a.reduce((sum, n, i) => sum + n * b[i], 0);
export const length = a => Math.hypot(...a);
export function normalize(a, fallback = [0, 0, 1]) {
  const n = length(a);
  return n > 1e-12 && Number.isFinite(n) ? scale(a, 1 / n) : [...fallback];
}
const lerp = (a, b, t) => a.map((n, i) => n + (b[i] - n) * t);
const finiteVector = v => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
const evaluate = (p, t) => p.reduceRight((value, coefficient) => value * t + coefficient, 0);
const evaluationScale = (p, t) => p.reduceRight((value, coefficient) => value * Math.abs(t) + Math.abs(coefficient), 0);

// Derivative roots partition a polynomial into monotonic intervals. Checking the
// partition endpoints catches tangent (even multiplicity) roots as well as roots
// exactly at the lifetime boundary; bisection handles every crossing interval.
export function polynomialRootsInInterval(coefficients, lower, upper) {
  const p = [...coefficients];
  while (p.length > 1 && p.at(-1) === 0) p.pop();
  if (p.length <= 1 || !(upper >= lower)) return [];
  if (p.length === 2) {
    const root = -p[0] / p[1];
    return Number.isFinite(root) && root >= lower - 1e-12 && root <= upper + 1e-12
      ? [Math.max(lower, Math.min(upper, root))] : [];
  }
  const derivative = p.slice(1).map((n, i) => n * (i + 1));
  const stationary = polynomialRootsInInterval(derivative, lower, upper);
  const boundaries = [lower, ...stationary.filter(t => t > lower && t < upper), upper];
  const roots = [];
  const append = t => {
    if (!roots.some(r => Math.abs(t - r) <= 2e-10)) roots.push(t);
  };
  for (const t of boundaries) {
    if (Math.abs(evaluate(p, t)) <= 2e-12 * Math.max(1, evaluationScale(p, t))) append(t);
  }
  for (let i = 1; i < boundaries.length; i++) {
    let a = boundaries[i - 1], b = boundaries[i];
    let fa = evaluate(p, a), fb = evaluate(p, b);
    if (fa === 0 || fb === 0 || Math.sign(fa) === Math.sign(fb)) continue;
    for (let iteration = 0; iteration < 85 && b - a > 2e-13; iteration++) {
      const mid = (a + b) / 2;
      const fmid = evaluate(p, mid);
      if (fmid === 0) { a = b = mid; break; }
      if (Math.sign(fmid) === Math.sign(fa)) { a = mid; fa = fmid; }
      else { b = mid; fb = fmid; }
    }
    append((a + b) / 2);
  }
  return roots.sort((a, b) => a - b);
}

export function solveBallistic(m, p, v, s = WEAPONS.machinegun.speed, g = [0, -WEAPONS.machinegun.gravity, 0], maxTime = WEAPONS.machinegun.lifetime) {
  if (![m, p, v, g].every(finiteVector) || !(s > 0) || !(maxTime > 0)) return null;
  const r = sub(p, m), q = scale(g, -.5);
  const coefficients = [dot(r, r), 2 * dot(r, v), dot(v, v) + 2 * dot(r, q) - s * s, 2 * dot(v, q), dot(q, q)];
  for (const t of polynomialRootsInInterval(coefficients, 0, maxTime)) {
    if (!(t > 1e-9)) continue;
    const displacement = add(add(r, scale(v, t)), scale(q, t * t));
    const direction = normalize(displacement);
    const intercept = add(p, scale(v, t));
    const initialVelocity = scale(direction, s);
    const predicted = add(add(m, scale(initialVelocity, t)), scale(g, .5 * t * t));
    const residual = length(sub(predicted, intercept));
    if (Number.isFinite(residual) && residual <= .01 && Math.abs(length(initialVelocity) - s) <= .001) {
      return { direction, flightSeconds: t, intercept, aimPoint: add(intercept, scale(g, -.5 * t * t)), residual };
    }
  }
  return null;
}

export function solveIntercept(m, p, v, s = WEAPONS.missile.speed, maxTime = WEAPONS.missile.lifetime) {
  if (![m, p, v].every(finiteVector) || !(s > 0) || !(maxTime > 0)) return null;
  const r = sub(p, m), a = dot(v, v) - s * s, b = 2 * dot(r, v), c = dot(r, r);
  const coefficientScale = Math.max(1, dot(v, v), s * s);
  let roots;
  if (Math.abs(a) <= 1e-12 * coefficientScale) {
    roots = Math.abs(b) > 1e-12 ? [-c / b] : [];
  } else {
    let discriminant = b * b - 4 * a * c;
    const tolerance = 2e-12 * Math.max(1, b * b, Math.abs(4 * a * c));
    if (discriminant < -tolerance) return null;
    discriminant = Math.max(0, discriminant);
    const root = Math.sqrt(discriminant);
    const q = -.5 * (b + (b < 0 ? -root : root));
    roots = q === 0 ? [-b / (2 * a)] : [q / a, c / q];
  }
  const t = roots.filter(n => Number.isFinite(n) && n > 1e-9 && n <= maxTime + 1e-12).sort((a, b) => a - b)[0];
  if (t === undefined) return null;
  const intercept = add(p, scale(v, t)), direction = normalize(sub(intercept, m));
  const residual = length(sub(add(m, scale(direction, s * t)), intercept));
  if (residual > .01) return null;
  return { direction, flightSeconds: Math.min(t, maxTime), intercept, aimPoint: [...intercept], residual };
}

export function projectilePosition(shot, age) {
  const origin = shot.origin ?? shot.muzzlePosition;
  const velocity = shot.initialVelocity ?? shot.velocity;
  const acceleration = shot.acceleration ?? shot.accelerationAtFire ?? [0, 0, 0];
  return add(add(origin, scale(velocity, age)), scale(acceleration, .5 * age * age));
}

// Swept sphere collision in relative coordinates: both the projectile and the
// target move over the very same time interval. Returns the first contact.
export function segmentSphere(from, to, targetPrevious, targetCurrent, radius) {
  const start = sub(from, targetPrevious);
  const delta = sub(sub(to, from), sub(targetCurrent, targetPrevious));
  const c = dot(start, start) - radius * radius;
  if (c <= 0) return 0;
  const a = dot(delta, delta);
  if (a < 1e-20) return null;
  const b = 2 * dot(start, delta), discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return null;
  const t = (-b - Math.sqrt(discriminant)) / (2 * a);
  return t >= -1e-12 && t <= 1 + 1e-12 ? Math.max(0, Math.min(1, t)) : null;
}

export function segmentMovingBox(from, to, previous, current, halfExtents) {
  const start = sub(from, previous), delta = sub(sub(to, from), sub(current, previous));
  let enter = 0, exit = 1;
  for (let axis = 0; axis < 3; axis++) {
    if (Math.abs(delta[axis]) < 1e-12) {
      if (Math.abs(start[axis]) > halfExtents[axis]) return null;
    } else {
      const a = (-halfExtents[axis] - start[axis]) / delta[axis];
      const b = (halfExtents[axis] - start[axis]) / delta[axis];
      enter = Math.max(enter, Math.min(a, b));
      exit = Math.min(exit, Math.max(a, b));
      if (enter > exit) return null;
    }
  }
  return enter >= 0 && enter <= 1 ? enter : null;
}

export function turnToward(direction, target, maxRadians) {
  const d = normalize(direction), t = normalize(target, d);
  const cosine = Math.max(-1, Math.min(1, dot(d, t))), angle = Math.acos(cosine);
  if (angle <= maxRadians + 1e-12) return t;
  if (!(maxRadians > 0)) return d;
  let tangent = sub(t, scale(d, cosine));
  if (length(tangent) < 1e-10) {
    const axis = Math.abs(d[0]) < .8 ? [1, 0, 0] : [0, 1, 0];
    tangent = sub(axis, scale(d, dot(axis, d)));
  }
  tangent = normalize(tangent);
  return normalize(add(scale(d, Math.cos(maxRadians)), scale(tangent, Math.sin(maxRadians))));
}

function worldContact(world, from, to) {
  const contact = world?.traceSegment?.(from, to);
  if (contact == null) return null;
  if (typeof contact === 'number') { const point = lerp(from, to, contact); return { type: 'world', fraction: contact, point, position: point }; }
  const fraction = contact.fraction ?? contact.t;
  const point = contact.point ?? contact.position ?? lerp(from, to, fraction);
  return Number.isFinite(fraction) ? { ...contact, type: 'world', fraction, point, position: point } : null;
}

export function traceBeam(muzzle, direction, enemies, world, range = WEAPONS.beam.range) {
  const end = add(muzzle, scale(normalize(direction), range));
  let hit = worldContact(world, muzzle, end);
  for (const enemy of enemies) {
    if (enemy.alive === false || enemy.hp <= 0) continue;
    const fraction = segmentSphere(muzzle, end, enemy.position, enemy.position, enemy.radius ?? 1.6);
    if (fraction !== null && (!hit || fraction < hit.fraction)) { const point = lerp(muzzle, end, fraction); hit = { type: 'enemy', enemy, fraction, point, position: point }; }
  }
  return hit;
}

export function createPlayerProjectile(weapon, muzzle, direction, target = null, time = 0) {
  const missile = weapon === 'missile', spec = WEAPONS[weapon], speed = spec.speed;
  const d = normalize(direction);
  return {
    weapon, origin: [...muzzle], position: [...muzzle], previousPosition: [...muzzle], direction: d,
    initialVelocity: scale(d, speed), acceleration: [0, spec.gravity ? -spec.gravity : 0, 0],
    speed, age: 0, maxAge: spec.lifetime, firedAtSeconds: time,
    targetId: missile ? target?.id ?? null : null,
    observation: missile && target ? { position: [...target.position], velocity: [...target.velocity], observedAtSeconds: time } : null,
  };
}

// The game uses substeps <= 1/120 s. These helpers additionally subdivide larger
// calls to retain < .01 m chord error for gravity and accurate limited homing.
export function advancePlayerProjectile(shot, dt, enemies, world, time) {
  const duration = Math.min(dt, Math.max(0, shot.maxAge - shot.age));
  const oldAge = shot.age;
  const frameStart = [...shot.position];
  shot.previousPosition = frameStart;
  const count = Math.max(1, Math.ceil(duration / CONFIG.simulationStep));
  const interval = duration / count;
  for (let index = 0; index < count; index++) {
    const progressStart = duration > 0 ? index / count * duration / dt : 0;
    const progressEnd = duration > 0 ? (index + 1) / count * duration / dt : 0;
    const from = [...shot.position];
    if (shot.weapon === 'missile') {
      const target = enemies.find(enemy => enemy.id === shot.targetId && enemy.alive !== false && enemy.hp > 0);
      if (target) {
        const current = lerp(target.previousPosition ?? target.position, target.position, progressStart);
        const now = time + index * interval;
        if (world?.lineOfSight?.(from, current) !== false) {
          shot.observation = { position: current, velocity: [...target.velocity], observedAtSeconds: now };
        }
        if (shot.observation) {
          const observationAge = Math.max(0, now - shot.observation.observedAtSeconds);
          const predictedCurrent = add(shot.observation.position, scale(shot.observation.velocity, observationAge));
          const solution = solveIntercept(from, predictedCurrent, shot.observation.velocity, shot.speed, shot.maxAge - shot.age);
          const desired = solution?.direction ?? normalize(sub(predictedCurrent, from), shot.direction);
          shot.direction = turnToward(shot.direction, desired, WEAPONS.missile.turnRateRad * interval);
        }
      }
      shot.position = add(from, scale(shot.direction, shot.speed * interval));
    } else {
      shot.position = projectilePosition(shot, oldAge + (index + 1) * interval);
    }
    let hit = worldContact(world, from, shot.position);
    for (const enemy of enemies) {
      if (enemy.alive === false || enemy.hp <= 0) continue;
      const previous = enemy.previousPosition ?? enemy.position;
      const before = lerp(previous, enemy.position, progressStart), after = lerp(previous, enemy.position, progressEnd);
      const fraction = segmentSphere(from, shot.position, before, after, enemy.radius ?? 1.6);
      if (fraction !== null && (!hit || fraction < hit.fraction)) {
        const point = lerp(from, shot.position, fraction);
        hit = { type: 'enemy', enemy, fraction, point, position: point };
      }
    }
    if (hit) {
      shot.position = [...hit.point];
      shot.age = oldAge + index * interval + interval * hit.fraction;
      return { hit, expired: true };
    }
    shot.age = oldAge + (index + 1) * interval;
  }
  return { hit: null, expired: shot.age >= shot.maxAge - 1e-12 };
}

export function advanceLinearProjectile(shot, dt, player, world) {
  shot.age ??= 0;
  shot.maxAge ??= shot.lifetime ?? 3;
  shot.initialVelocity ??= [...shot.velocity];
  shot.acceleration ??= [0, 0, 0];
  shot.origin ??= sub(shot.position, scale(shot.initialVelocity, shot.age));
  const duration = Math.min(dt, Math.max(0, shot.maxAge - shot.age));
  const from = [...shot.position], to = projectilePosition(shot, shot.age + duration);
  shot.previousPosition = from;
  let hit = worldContact(world, from, to);
  const before = player.previousPosition ?? player.position;
  const after = lerp(before, player.position, dt > 0 ? duration / dt : 0);
  const fraction = player.halfExtents
    ? segmentMovingBox(from, to, before, after, player.halfExtents)
    : segmentSphere(from, to, before, after, player.radius ?? 1.6);
  if (fraction !== null && (!hit || fraction < hit.fraction)) { const point = lerp(from, to, fraction); hit = { type: 'player', fraction, point, position: point }; }
  shot.position = hit ? [...hit.point] : to;
  shot.age += duration * (hit?.fraction ?? 1);
  return { hit, expired: Boolean(hit) || shot.age >= shot.maxAge - 1e-12 };
}
