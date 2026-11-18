/**
 * Ballistic solvers used by the FCS (Flight Control System).
 *
 * Machinegun: the target keeps moving at a constant world velocity `v`, the
 * projectile is launched at a fixed world speed `s` and falls with `g`.
 * We need the smallest positive `t` with
 *
 *     | r + v*t - 0.5*g*t^2 |^2 - s^2 * t^2 = 0 ,   0 < t <= life
 *
 * which expands into a quartic in `t`.  The solver isolates the real roots
 * with a derivative based bracketing so that tangential (double) roots and
 * the life-time boundary are handled as well.
 */

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface BallisticSolution {
  /** predicted time of flight to the target centre [s] */
  t: number;
  /** unit launch direction (world space) */
  direction: Vec3Like;
  /** initial velocity = speed * direction (world space) */
  velocity: Vec3Like;
  /** corrected aim point = p + v*t - 0.5*g*t^2 (on the initial ray) */
  aimPoint: Vec3Like;
  /** predicted intercept = p + v*t */
  intercept: Vec3Like;
  /** |projectile(t) - intercept| in meters */
  residual: number;
  /** |v0| - speed (m/s) */
  speedError: number;
}

const EPS = 1e-12;

/* ------------------------------------------------------------------ */
/* small vector helpers                                               */
/* ------------------------------------------------------------------ */

export function v3(x = 0, y = 0, z = 0): Vec3Like {
  return { x, y, z };
}

export function vclone(a: Vec3Like): Vec3Like {
  return { x: a.x, y: a.y, z: a.z };
}

export function vadd(a: Vec3Like, b: Vec3Like): Vec3Like {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function vsub(a: Vec3Like, b: Vec3Like): Vec3Like {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function vscale(a: Vec3Like, s: number): Vec3Like {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

export function vdot(a: Vec3Like, b: Vec3Like): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function vlen(a: Vec3Like): number {
  return Math.sqrt(vdot(a, a));
}

export function vnorm(a: Vec3Like): Vec3Like {
  const l = vlen(a);
  if (l < 1e-9) return { x: 0, y: 0, z: 0 };
  return { x: a.x / l, y: a.y / l, z: a.z / l };
}

export function vdist(a: Vec3Like, b: Vec3Like): number {
  return vlen(vsub(a, b));
}

/* ------------------------------------------------------------------ */
/* polynomial helpers                                                 */
/* ------------------------------------------------------------------ */

function evalPoly(coeffs: number[], x: number): number {
  let r = 0;
  for (let i = 0; i < coeffs.length; i++) r = r * x + coeffs[i];
  return r;
}

function derivPoly(coeffs: number[]): number[] {
  if (coeffs.length <= 1) return [0];
  const out: number[] = [];
  for (let i = 0; i < coeffs.length - 1; i++) out.push(coeffs[i] * (coeffs.length - 1 - i));
  return out;
}

/** Real roots of a*t^2 + b*t + c (numerically stable form). */
export function quadraticRoots(a: number, b: number, c: number): number[] {
  if (Math.abs(a) < 1e-14) {
    if (Math.abs(b) < 1e-14) return [];
    return [-c / b];
  }
  const disc = b * b - 4 * a * c;
  if (disc < 0) return [];
  if (disc === 0) return [-b / (2 * a)];
  const sq = Math.sqrt(disc);
  const q = -0.5 * (b + (b >= 0 ? sq : -sq));
  const r1 = q / a;
  const r2 = Math.abs(q) > 1e-300 ? c / q : r1;
  return r1 === r2 ? [r1] : [r1, r2].sort((p, q2) => p - q2);
}

/** Sign-change bracketing bisection; returns NaN when no sign change. */
function bisect(f: (x: number) => number, x0: number, x1: number, iterations = 120): number {
  let f0 = f(x0);
  let f1 = f(x1);
  if (f0 === 0) return x0;
  if (f1 === 0) return x1;
  if (f0 * f1 > 0) return NaN;
  let lo = x0;
  let hi = x1;
  for (let i = 0; i < iterations; i++) {
    const mid = 0.5 * (lo + hi);
    if (mid === lo || mid === hi) break;
    const fm = f(mid);
    if (fm === 0) return mid;
    if (fm < 0 === f0 < 0) {
      lo = mid;
      f0 = fm;
    } else {
      hi = mid;
    }
  }
  return 0.5 * (lo + hi);
}

/**
 * All real roots of a polynomial (descending coefficients) inside [lo,hi].
 * Uses critical point isolation so tangential roots are found too.
 */
export function polyRootsInRange(coeffsIn: number[], lo: number, hi: number): number[] {
  let coeffs = coeffsIn.slice();
  while (coeffs.length > 1 && Math.abs(coeffs[0]) < 1e-12) coeffs.shift();
  if (coeffs.length <= 1) return [];

  const deg = coeffs.length - 1;
  const f = (x: number) => evalPoly(coeffs, x);

  if (deg === 1) {
    const r = -coeffs[1] / coeffs[0];
    return r >= lo && r <= hi ? [r] : [];
  }
  if (deg === 2) {
    return quadraticRoots(coeffs[0], coeffs[1], coeffs[2]).filter((r) => r >= lo && r <= hi);
  }

  // critical points of the polynomial itself (roots of the derivative)
  const d = derivPoly(coeffs);
  let crit: number[] = [];
  if (d.length - 1 === 2) {
    crit = quadraticRoots(d[0], d[1], d[2]);
  } else if (d.length - 1 === 3) {
    // derivative is cubic -> find its roots with the same bracketing method
    const df = derivPoly(d);
    const dcrit = quadraticRoots(df[0], df[1], df[2]);
    const pts = [lo, ...dcrit.filter((r) => r > lo && r < hi), hi].sort((a, b) => a - b);
    for (let i = 0; i < pts.length - 1; i++) {
      const r = bisect((x) => evalPoly(d, x), pts[i], pts[i + 1]);
      if (!Number.isNaN(r)) crit.push(r);
    }
    for (const c of dcrit) {
      if (c > lo && c < hi && Math.abs(evalPoly(d, c)) < 1e-9 * Math.max(1, Math.abs(d[0]))) crit.push(c);
    }
  }
  crit = crit.filter((r) => r > lo && r < hi).sort((a, b) => a - b);

  const breaks = [lo, ...crit, hi];
  const roots: number[] = [];
  for (const b of breaks) {
    if (Math.abs(f(b)) < 1e-12) roots.push(b);
  }
  for (let i = 0; i < breaks.length - 1; i++) {
    const r = bisect(f, breaks[i], breaks[i + 1]);
    if (!Number.isNaN(r)) roots.push(r);
  }
  roots.sort((a, b) => a - b);
  // remove duplicates
  const out: number[] = [];
  for (const r of roots) {
    if (out.length === 0 || Math.abs(r - out[out.length - 1]) > 1e-9) out.push(r);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* machinegun gravity-compensated lead                                 */
/* ------------------------------------------------------------------ */

/**
 * Solve the machinegun firing solution.
 *
 * @param muzzle  actual muzzle position (world)
 * @param target  target hit-centre position (world)
 * @param tvel    actual target velocity (world)
 * @param speed   projectile speed (100 m/s)
 * @param gravity downward acceleration magnitude (18 m/s^2)
 * @param maxTime maximum flight time (bullet life)
 */
export function solveMachinegun(
  muzzle: Vec3Like,
  target: Vec3Like,
  tvel: Vec3Like,
  speed: number,
  gravity: number,
  maxTime: number
): BallisticSolution | null {
  const r = vsub(target, muzzle);
  const u = { x: 0, y: gravity * 0.5, z: 0 }; // -0.5 * g
  const ru = vdot(r, u);
  const vu = vdot(tvel, u);
  const uu = vdot(u, u);

  // |r + v t + u t^2|^2 - s^2 t^2
  const coeffs = [
    uu,
    2 * vu,
    vdot(tvel, tvel) + 2 * ru - speed * speed,
    2 * vdot(r, tvel),
    vdot(r, r)
  ];

  const R = (t: number): Vec3Like => ({
    x: r.x + tvel.x * t + u.x * t * t,
    y: r.y + tvel.y * t + u.y * t * t,
    z: r.z + tvel.z * t + u.z * t * t
  });

  // f(t) = |R(t)| - s*t   (same roots as the quartic, better conditioned)
  const f = (t: number) => vlen(R(t)) - speed * t;

  let best = NaN;
  let bestIsTangent = false;

  // 1) tangential (double) roots: critical points of the quartic where f ~ 0
  const dpoly = derivPoly(coeffs);
  let crit: number[] = [];
  if (dpoly.length - 1 === 2) {
    crit = quadraticRoots(dpoly[0], dpoly[1], dpoly[2]);
  } else if (dpoly.length - 1 === 3) {
    const df = derivPoly(dpoly);
    const dcrit = quadraticRoots(df[0], df[1], df[2]);
    const pts = [0, ...dcrit.filter((r) => r > 0 && r < maxTime), maxTime].sort((a, b) => a - b);
    for (let i = 0; i < pts.length - 1; i++) {
      const r = bisect((x) => evalPoly(dpoly, x), pts[i], pts[i + 1]);
      if (!Number.isNaN(r)) crit.push(r);
    }
  }
  for (const c of crit) {
    if (c <= 0 || c > maxTime) continue;
    if (Math.abs(f(c)) <= 1e-5) {
      // refine with a local golden section on |f|
      const span = Math.min(0.05, maxTime * 0.25);
      const refined = refineMinimum(f, c, span);
      if (Math.abs(f(refined)) < Math.abs(f(c))) {
        if (Number.isNaN(best) || refined < best) {
          best = refined;
          bestIsTangent = true;
        }
      } else if (Number.isNaN(best) || c < best) {
        best = c;
        bestIsTangent = true;
      }
    }
  }

  // 2) simple roots
  const simple = polyRootsInRange(coeffs, 0, maxTime);
  for (const r of simple) {
    if (r <= 1e-9) continue;
    if (Number.isNaN(best) || r < best) {
      best = r;
      bestIsTangent = false;
    }
  }

  if (Number.isNaN(best) || best <= 0) return null;

  // 3) polish (Newton on the quartic) for simple roots
  if (!bestIsTangent) {
    let t = best;
    for (let i = 0; i < 12; i++) {
      const q = evalPoly(coeffs, t);
      const dq = evalPoly(dpoly, t);
      if (Math.abs(dq) < 1e-14) break;
      const step = q / dq;
      const tn = t - step;
      if (!Number.isFinite(tn) || tn <= 0 || tn > maxTime) break;
      if (Math.abs(evalPoly(coeffs, tn)) > Math.abs(q)) break;
      t = tn;
    }
    best = t;
  }

  const t = best;
  const Rv = R(t);
  const st = speed * t;
  if (!(st > EPS)) return null;

  // d = R(t) / (s t)  (not normalised: this keeps the intercept exact)
  const dir = { x: Rv.x / st, y: Rv.y / st, z: Rv.z / st };
  const velocity = { x: dir.x * speed, y: dir.y * speed, z: dir.z * speed };

  // corrected aim point: the point on the initial ray, gravity corrected
  const aimPoint = {
    x: muzzle.x + dir.x * st,
    y: muzzle.y + dir.y * st,
    z: muzzle.z + dir.z * st
  };
  // predicted intercept: p + v*t
  const intercept = {
    x: target.x + tvel.x * t,
    y: target.y + tvel.y * t,
    z: target.z + tvel.z * t
  };

  // projectile position at t = m + v0 t + 0.5 g t^2
  const proj = {
    x: muzzle.x + velocity.x * t,
    y: muzzle.y + velocity.y * t - 0.5 * gravity * t * t,
    z: muzzle.z + velocity.z * t
  };
  const residual = vdist(proj, intercept);
  const speedError = vlen(velocity) - speed;

  if (!Number.isFinite(residual) || !Number.isFinite(speedError)) return null;

  return { t, direction: dir, velocity, aimPoint, intercept, residual, speedError };
}

/** Golden-section style refinement of a local minimum of |f| around `c`. */
function refineMinimum(f: (x: number) => number, c: number, span: number): number {
  const phi = 0.6180339887498949;
  let a = Math.max(0, c - span);
  let b = c + span;
  let x1 = b - phi * (b - a);
  let x2 = a + phi * (b - a);
  let f1 = Math.abs(f(x1));
  let f2 = Math.abs(f(x2));
  for (let i = 0; i < 80; i++) {
    if (f1 < f2) {
      b = x2;
      x2 = x1;
      f2 = f1;
      x1 = b - phi * (b - a);
      f1 = Math.abs(f(x1));
    } else {
      a = x1;
      x1 = x2;
      f1 = f2;
      x2 = a + phi * (b - a);
      f2 = Math.abs(f(x2));
    }
    if (b - a < 1e-12) break;
  }
  return f1 < f2 ? x1 : x2;
}

/* ------------------------------------------------------------------ */
/* constant-speed lead (missiles and enemy AI)                          */
/* ------------------------------------------------------------------ */

/**
 * Solve   (v.v - s^2) t^2 + 2 (r.v) t + r.r = 0   for the smallest positive
 * root with 0 < t <= maxTime.  Returns null when no positive root exists.
 */
export function solveConstantSpeedLead(
  r: Vec3Like,
  v: Vec3Like,
  speed: number,
  maxTime: number
): number | null {
  const a = vdot(v, v) - speed * speed;
  const b = 2 * vdot(r, v);
  const c = vdot(r, r);
  if (Math.abs(a) < 1e-9) {
    // linear: b t + c = 0
    if (Math.abs(b) < 1e-12) return null;
    const t = -c / b;
    if (t > 0 && t <= maxTime) return t;
    return null;
  }
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  const q = -0.5 * (b + (b >= 0 ? sq : -sq));
  const roots = [q / a, Math.abs(q) > 1e-300 ? c / q : q / a].sort((x, y) => x - y);
  for (const t of roots) {
    if (t > 0 && t <= maxTime) return t;
  }
  return null;
}

/** Missile initial direction: normalize(r + v t) for the lead solution `t`. */
export function missileLaunchDirection(r: Vec3Like, v: Vec3Like, t: number): Vec3Like {
  return vnorm({ x: r.x + v.x * t, y: r.y + v.y * t, z: r.z + v.z * t });
}
