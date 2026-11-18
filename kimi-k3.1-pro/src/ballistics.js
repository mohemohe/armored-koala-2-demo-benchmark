const EPSILON = Number.EPSILON;

function isVec3(value) {
  return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
}

function evaluate(coefficients, x) {
  let value = 0;
  for (let i = coefficients.length - 1; i >= 0; i -= 1) {
    value = value * x + coefficients[i];
  }
  return value;
}

function evaluationTolerance(coefficients, x) {
  let sum = 0;
  let power = 1;
  for (const coefficient of coefficients) {
    sum += Math.abs(coefficient) * power;
    power *= x;
  }
  return 32 * EPSILON * Math.max(1, sum);
}

function normalizePolynomial(coefficients) {
  let degree = coefficients.length - 1;
  while (degree > 0 && coefficients[degree] === 0) degree -= 1;

  const trimmed = coefficients.slice(0, degree + 1);
  const scale = Math.max(...trimmed.map(Math.abs));
  if (!Number.isFinite(scale) || scale === 0) return null;
  return trimmed.map((coefficient) => coefficient / scale);
}

function addRoot(roots, root) {
  if (!Number.isFinite(root) || root <= 0 || root > 1) return;
  roots.push(root);
}

function uniqueSortedRoots(roots) {
  roots.sort((a, b) => a - b);
  const unique = [];
  for (const root of roots) {
    const previous = unique[unique.length - 1];
    if (previous !== undefined &&
        Math.abs(root - previous) <= 16 * EPSILON * Math.max(1, Math.abs(root))) {
      continue;
    }
    unique.push(root);
  }
  return unique;
}

// The coefficients are normalized and the independent variable is in [0, 1].
function quadraticRoots(coefficients) {
  const c = coefficients[0];
  if (coefficients.length === 1) return [];

  const b = coefficients[1];
  if (coefficients.length === 2) {
    const roots = [];
    addRoot(roots, -c / b);
    if (Math.abs(evaluate(coefficients, 1)) <= evaluationTolerance(coefficients, 1)) {
      addRoot(roots, 1);
    }
    return roots;
  }

  const a = coefficients[2];
  const discriminant = b * b - 4 * a * c;
  const discriminantScale = b * b + Math.abs(4 * a * c);
  const discriminantTolerance = 32 * EPSILON * discriminantScale;
  if (discriminant < -discriminantTolerance) return [];

  const roots = [];
  if (discriminant <= discriminantTolerance) {
    addRoot(roots, -b / (2 * a));
  } else {
    const squareRoot = Math.sqrt(discriminant);
    // This form avoids cancellation for the root nearest to zero.
    const q = -0.5 * (b + (b >= 0 ? squareRoot : -squareRoot));
    addRoot(roots, q / a);
    addRoot(roots, c / q);
  }

  // A root exactly at maxTime must not be lost to a one-ulp round-off.
  if (Math.abs(evaluate(coefficients, 1)) <= evaluationTolerance(coefficients, 1)) {
    addRoot(roots, 1);
  }
  return uniqueSortedRoots(roots);
}

function oppositeSigns(a, b) {
  return (a < 0 && b > 0) || (a > 0 && b < 0);
}

function bracketedRoot(coefficients, derivative, lower, upper, fLower, fUpper) {
  let a = lower;
  let b = upper;
  let fa = fLower;
  let fb = fUpper;
  let x = (a + b) / 2;
  let best = x;
  let bestError = Infinity;

  for (let iteration = 0; iteration < 64; iteration += 1) {
    const fx = evaluate(coefficients, x);
    const error = Math.abs(fx);
    if (error < bestError) {
      best = x;
      bestError = error;
    }
    if (fx === 0) return x;

    if (oppositeSigns(fa, fx)) {
      b = x;
      fb = fx;
    } else {
      a = x;
      fa = fx;
    }

    const slope = evaluate(derivative, x);
    let next = slope !== 0 ? x - fx / slope : NaN;
    if (!Number.isFinite(next) || next <= a || next >= b) next = (a + b) / 2;
    if (next === x || (next === a && next === b)) break;
    x = next;
  }

  const midpoint = (a + b) / 2;
  const midpointError = Math.abs(evaluate(coefficients, midpoint));
  return midpointError < bestError ? midpoint : best;
}

// Recursive derivative isolation: on every open interval the polynomial is
// monotone. Roots at critical points catch tangent double (and higher) roots.
function rootsInUnitInterval(inputCoefficients) {
  const coefficients = normalizePolynomial(inputCoefficients);
  if (coefficients === null) return [];
  if (coefficients.length <= 3) return quadraticRoots(coefficients);

  const derivative = [];
  for (let i = 1; i < coefficients.length; i += 1) {
    derivative.push(i * coefficients[i]);
  }

  const criticalPoints = rootsInUnitInterval(derivative)
    .filter((root) => root > 0 && root < 1);
  const points = [0, ...criticalPoints, 1];
  const roots = [];

  for (const point of criticalPoints) {
    if (Math.abs(evaluate(coefficients, point)) <= evaluationTolerance(coefficients, point)) {
      addRoot(roots, point);
    }
  }
  if (Math.abs(evaluate(coefficients, 1)) <= evaluationTolerance(coefficients, 1)) {
    addRoot(roots, 1);
  }

  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    if (b - a <= 16 * EPSILON) continue;
    const fa = evaluate(coefficients, a);
    const fb = evaluate(coefficients, b);
    if (oppositeSigns(fa, fb)) {
      addRoot(roots, bracketedRoot(coefficients, derivative, a, b, fa, fb));
    }
  }

  return uniqueSortedRoots(roots);
}

function earliestPositiveRoot(coefficients) {
  const roots = rootsInUnitInterval(coefficients);
  return roots.length === 0 ? null : roots[0];
}

function makeSolution(m, p, v, s, g, maxTime, unitTime) {
  const t = unitTime * maxTime;
  if (!Number.isFinite(t) || t <= 0 || t > maxTime) return null;

  const intercept = p.map((value, i) => value + v[i] * t);
  const aimPoint = intercept.map((value, i) => value - 0.5 * g[i] * t * t);
  const aimVector = aimPoint.map((value, i) => value - m[i]);
  const length = Math.hypot(...aimVector);
  if (!Number.isFinite(length) || length === 0) return null;

  const direction = aimVector.map((value) => value / length);
  const initialVelocity = direction.map((value) => s * value);
  const residual = Math.hypot(...initialVelocity.map((velocity, i) =>
    velocity * t - aimVector[i]));

  if (![...intercept, ...aimPoint, ...direction, ...initialVelocity, residual]
    .every(Number.isFinite)) {
    return null;
  }
  return { t, direction, initialVelocity, intercept, aimPoint, residual };
}

function solve({ m, p, v, s, g, maxTime }) {
  if (!isVec3(m) || !isVec3(p) || !isVec3(v) || !isVec3(g) ||
      !Number.isFinite(s) || s <= 0 || !Number.isFinite(maxTime) || maxTime <= 0) {
    return null;
  }

  const r = p.map((value, i) => value - m[i]);
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const t2 = maxTime * maxTime;
  const coefficients = [
    dot(r, r),
    2 * dot(r, v) * maxTime,
    (dot(v, v) - dot(r, g) - s * s) * t2,
    -dot(v, g) * t2 * maxTime,
    0.25 * dot(g, g) * t2 * t2,
  ];
  if (!coefficients.every(Number.isFinite)) return null;

  const root = earliestPositiveRoot(coefficients);
  return root === null ? null : makeSolution(m, p, v, s, g, maxTime, root);
}

export function solveMachinegun({ m, p, v, s = 100, g = [0, -18, 0], maxTime = 2 }) {
  return solve({ m, p, v, s, g, maxTime });
}

export function solveMissile({ m, p, v, s = 45, maxTime = 4 }) {
  return solve({ m, p, v, s, g: [0, 0, 0], maxTime });
}
