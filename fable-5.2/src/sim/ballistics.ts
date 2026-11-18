/**
 * Pure ballistics / geometry maths shared by the player's FCS, the projectiles and the enemy AI.
 * No simulation state, no three.js, no randomness: plain deterministic functions on V3.
 *
 * Contents
 *  - solveGravityIntercept  machine-gun lead + drop solution (docs/SPEC.md §4.3)
 *  - solveLinearIntercept   constant-speed lead (missile §4.4, enemy fire §2.3)
 *  - rotateTowards          turn-rate limited steering of a unit vector (missile §4.4)
 *  - sweepPointSphere/Box   continuous point-vs-moving-volume tests (§4.5, §2.3)
 *  - raySphere, gravityInterceptMiss, gravityInterceptQuartic, ballisticPosition  small helpers
 *
 * Every function returns `null` / `-1` instead of NaN or Infinity when the input is degenerate.
 * The solvers and the swept / ray tests use only + − × ÷ and `Math.sqrt` (correctly rounded, hence
 * bit-identical on every JS engine); `rotateTowards` additionally needs sin / cos / atan2.
 */
import type { V3 } from '../core/vec';

/** §4.3: largest allowed distance (m) between bullet and predicted target centre at the adopted time. */
export const INTERCEPT_RESIDUAL_LIMIT = 0.01;
/** Muzzle-to-target distances (m) at or below this are degenerate: no launch direction can be defined. */
export const DEGENERATE_RANGE = 1e-6;
/**
 * Miss distance (m) at or below which a tangential (double) root or a root on the life-time boundary is
 * accepted even though the miss function does not change sign there. One nanometre: far above the
 * rounding noise of the evaluation (~1e-13 m at game scale), far below the 0.01 m spec limit.
 */
export const ROOT_TOLERANCE = 1e-9;

const EPS = Number.EPSILON;
const MAX_ITERATIONS = 200;
/** Largest |quantity| for which squares stay comfortably finite. */
const MAX_MAGNITUDE = 1e150;

// ───────────────────────────── scalar root finding ─────────────────────────────

/** Horner evaluation of c[0] + c[1] t + … + c[n] tⁿ. */
function polyEval(c: readonly number[], n: number, t: number): number {
  let y = c[n];
  for (let i = n - 1; i >= 0; i--) y = y * t + c[i];
  return y;
}

/**
 * Root of a continuous function inside a bracket [a, b] whose end values `fa`, `fb` have strictly opposite
 * signs. Newton steps are taken only while they stay inside the bracket and at least halve the previous
 * step; otherwise the bracket is bisected (the classic "rtsafe" safeguard), so the iteration always
 * converges. Returns the visited abscissa with the smallest |f| (machine precision for simple roots).
 */
function bracketedRoot(
  fn: (t: number) => number,
  dfn: (t: number) => number,
  a: number,
  b: number,
  fa: number,
  fb: number,
): number {
  let xNeg = fa < 0 ? a : b;
  let xPos = fa < 0 ? b : a;
  let best = a;
  let bestAbs = Math.abs(fa);
  if (Math.abs(fb) < bestAbs) {
    best = b;
    bestAbs = Math.abs(fb);
  }
  let t = a + 0.5 * (b - a);
  let prevStep = Math.abs(b - a);
  let finalPass = false;
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const f = fn(t);
    const af = Math.abs(f);
    if (!(af >= 0)) break; // NaN: keep the best finite estimate
    if (af < bestAbs) {
      bestAbs = af;
      best = t;
    }
    if (f === 0) return t;
    if (f < 0) xNeg = t;
    else xPos = t;
    if (finalPass) break;

    let next = xNeg + 0.5 * (xPos - xNeg);
    let step = 0.5 * Math.abs(xPos - xNeg);
    const df = dfn(t);
    if (df !== 0 && Number.isFinite(df)) {
      const newton = t - f / df;
      const newtonStep = Math.abs(newton - t);
      const lo = xNeg < xPos ? xNeg : xPos;
      const hi = xNeg < xPos ? xPos : xNeg;
      if (newton >= lo && newton <= hi && 2 * newtonStep <= prevStep) {
        next = newton;
        step = newtonStep;
      }
    }
    prevStep = step;
    if (next === t) break;
    if (step <= 2 * EPS * Math.abs(next)) finalPass = true; // one last evaluation, then stop
    t = next;
  }
  return best;
}

/**
 * Sign-change roots of a polynomial (ascending coefficients) strictly inside (lo, hi), in ascending order.
 * They are isolated with the roots of the derivative (found recursively), between which the polynomial is
 * monotonic. Every root found at every recursion level — i.e. the roots of the polynomial and of all its
 * derivatives — is also appended to `sink`.
 */
function isolateRoots(c: readonly number[], lo: number, hi: number, sink: number[]): number[] {
  let n = c.length - 1;
  while (n > 0 && !(Math.abs(c[n]) > 0)) n--; // drop vanishing (or NaN) leading coefficients
  const roots: number[] = [];
  if (n <= 0) return roots;
  if (n === 1) {
    const t = -c[0] / c[1];
    if (t > lo && t < hi) {
      roots.push(t);
      sink.push(t);
    }
    return roots;
  }
  const d: number[] = new Array<number>(n);
  for (let i = 1; i <= n; i++) d[i - 1] = i * c[i];
  const critical = isolateRoots(d, lo, hi, sink);
  const fn = (t: number): number => polyEval(c, n, t);
  const dfn = (t: number): number => polyEval(d, n - 1, t);
  let x0 = lo;
  let y0 = fn(lo);
  for (let i = 0; i <= critical.length; i++) {
    const x1 = i < critical.length ? critical[i] : hi;
    const y1 = fn(x1);
    if (x1 > x0 && ((y0 < 0 && y1 > 0) || (y0 > 0 && y1 < 0))) {
      const t = bracketedRoot(fn, dfn, x0, x1, y0, y1);
      if (t > lo && t < hi) {
        roots.push(t);
        sink.push(t);
      }
    }
    x0 = x1;
    y0 = y1;
  }
  return roots;
}

// ───────────────────────────── machine gun: lead + gravity ─────────────────────────────

export interface GravitySolution {
  /** Flight time to the predicted target centre (0 < t <= maxTime). */
  t: number;
  /** Unit launch direction d = (r + v t - 0.5 g t²) / (s t). */
  dir: V3;
  /** Predicted hit point p + v t. */
  intercept: V3;
  /** Point on the initial muzzle line: p + v t - 0.5 g t² (above the intercept). */
  aimPoint: V3;
  /** |muzzle + s d t + 0.5 g t² - (p + v t)| re-evaluated from the returned dir (metres). */
  residual: number;
}

/**
 * Signed miss distance (metres) of the §4.3 problem at flight time `t`:
 *   |r + v t − 0.5 g t²| − s t,  r = targetPos − muzzle,  g = (0, −gravity, 0).
 * It is positive while the bullet cannot have reached the predicted target centre yet, zero exactly at a
 * solution, and has the same sign and roots (for t > 0) as the spec's quartic |…|² − s² t².
 */
export function gravityInterceptMiss(
  muzzle: V3,
  targetPos: V3,
  targetVel: V3,
  speed: number,
  gravity: number,
  t: number,
): number {
  const wx = targetPos.x - muzzle.x + targetVel.x * t;
  const wy = targetPos.y - muzzle.y + targetVel.y * t + 0.5 * gravity * t * t;
  const wz = targetPos.z - muzzle.z + targetVel.z * t;
  return Math.sqrt(wx * wx + wy * wy + wz * wz) - speed * t;
}

/**
 * Coefficients [c0, c1, c2, c3, c4] of the §4.3 quartic f(t) = |r + v t − 0.5 g t²|² − s² t²
 *   = (a·a) t⁴ + 2 (v·a) t³ + (v·v + 2 r·a − s²) t² + 2 (r·v) t + r·r,  a = −0.5 g = (0, gravity/2, 0).
 */
export function gravityInterceptQuartic(
  muzzle: V3,
  targetPos: V3,
  targetVel: V3,
  speed: number,
  gravity: number,
): [number, number, number, number, number] {
  const rx = targetPos.x - muzzle.x;
  const ry = targetPos.y - muzzle.y;
  const rz = targetPos.z - muzzle.z;
  const vx = targetVel.x;
  const vy = targetVel.y;
  const vz = targetVel.z;
  const ay = 0.5 * gravity;
  return [
    rx * rx + ry * ry + rz * rz,
    2 * (rx * vx + ry * vy + rz * vz),
    vx * vx + vy * vy + vz * vz + 2 * ry * ay - speed * speed,
    2 * vy * ay,
    ay * ay,
  ];
}

/**
 * Machine-gun lead + drop solution (docs/SPEC.md §4.3):
 *   |r + v t - 0.5 g t²|² - s² t² = 0,  0 < t <= maxTime,  g = (0, -gravity, 0)
 * Returns the smallest positive root (double roots and the t = maxTime boundary included) or null when
 * no root exists in range, the geometry is degenerate (|r| <= DEGENERATE_RANGE), an argument is not a
 * finite number (speed and maxTime must also be > 0) or the residual check (> 0.01 m) fails.
 *
 * Method. The quartic is strictly monotonic between consecutive real roots of its derivative. Those are
 * isolated exactly the same way from the roots of the second derivative, and so on down to the linear third
 * derivative. On every monotonic piece of (0, maxTime] the signed miss distance |w(t)| − s t (same sign and
 * roots as the quartic, but in metres and free of cancellation) is examined in ascending order:
 *   - a sign change brackets a simple root → safeguarded Newton/bisection to machine precision;
 *   - a value in [0, ROOT_TOLERANCE] at a split point without a following sign change is a tangential
 *     double root (two coinciding solutions), or the root sitting on the maxTime boundary;
 * and the first hit wins. The answer is then verified: 0 < t <= maxTime, unit direction, all outputs
 * finite, and the residual recomputed from the returned normalised direction must be <= 0.01 m
 * (in practice ~1e-13 m).
 */
export function solveGravityIntercept(
  muzzle: V3,
  targetPos: V3,
  targetVel: V3,
  speed: number,
  gravity: number,
  maxTime: number,
): GravitySolution | null {
  const s = speed;
  const T = maxTime;
  if (!(s > 0) || !(T > 0) || !Number.isFinite(s) || !Number.isFinite(T) || !Number.isFinite(gravity)) return null;

  const rx = targetPos.x - muzzle.x;
  const ry = targetPos.y - muzzle.y;
  const rz = targetPos.z - muzzle.z;
  const vx = targetVel.x;
  const vy = targetVel.y;
  const vz = targetVel.z;
  const ay = 0.5 * gravity; // a = −0.5 g = (0, ay, 0)

  const rLen = Math.sqrt(rx * rx + ry * ry + rz * rz);
  const vLen = Math.sqrt(vx * vx + vy * vy + vz * vz);
  if (!(rLen > DEGENERATE_RANGE)) return null; // also rejects NaN
  // Largest magnitude any intermediate vector can reach on [0, T]; keeps every square finite.
  const scale = rLen + vLen * T + Math.abs(ay) * T * T + s * T;
  if (!(scale < MAX_MAGNITUDE)) return null;

  /** Signed miss distance in metres (see gravityInterceptMiss). */
  const miss = (t: number): number => {
    const wx = rx + vx * t;
    const wy = ry + vy * t + ay * t * t;
    const wz = rz + vz * t;
    return Math.sqrt(wx * wx + wy * wy + wz * wz) - s * t;
  };
  const missSlope = (t: number): number => {
    const wx = rx + vx * t;
    const wy = ry + vy * t + ay * t * t;
    const wz = rz + vz * t;
    const wl = Math.sqrt(wx * wx + wy * wy + wz * wz);
    if (!(wl > 0)) return Number.NaN; // forces a bisection step
    return (wx * vx + wy * (vy + 2 * ay * t) + wz * vz) / wl - s;
  };
  /** Scale-aware acceptance threshold for a non-crossing root at time t. */
  const toleranceAt = (t: number): number =>
    ROOT_TOLERANCE + 64 * EPS * (rLen + vLen * t + Math.abs(ay) * t * t + s * t);

  // Split points: the roots of f', f'' and f''' inside (0, T) in ascending order, then T itself.
  const c = gravityInterceptQuartic(muzzle, targetPos, targetVel, s, gravity);
  if (!Number.isFinite(c[0] + c[1] + c[2] + c[3] + c[4])) return null;
  const splits: number[] = [];
  isolateRoots([c[1], 2 * c[2], 3 * c[3], 4 * c[4]], 0, T, splits);
  splits.sort((p, q) => p - q);
  splits.push(T);

  // Ascending scan. `lastPos` is the latest abscissa with a strictly positive miss (starts at t = 0).
  let lastPos = 0;
  let lastPosMiss = rLen;
  let root = -1;
  let touch = -1;
  let touchMiss = Number.POSITIVE_INFINITY;
  for (let i = 0; i < splits.length; i++) {
    const x = splits[i];
    if (!(x > lastPos)) continue;
    const gx = miss(x);
    if (!Number.isFinite(gx)) return null;
    if (gx < 0) {
      root = bracketedRoot(miss, missSlope, lastPos, x, lastPosMiss, gx);
      break;
    }
    if (gx === 0) {
      root = x;
      break;
    }
    if (gx <= toleranceAt(x)) {
      // Numerically touching zero. Keep the closest approach of this run; a real crossing right
      // after it (handled by the branch above) still takes precedence.
      if (gx < touchMiss) {
        touch = x;
        touchMiss = gx;
      }
    } else if (touch >= 0) {
      break; // touched and moved away again: a tangential double root at `touch`
    }
    lastPos = x;
    lastPosMiss = gx;
  }
  if (root < 0) root = touch;
  if (!(root > 0)) return null;
  const t = root > T ? T : root;

  // Build the answer from the adopted time and verify it.
  const wx = rx + vx * t;
  const wy = ry + vy * t + ay * t * t;
  const wz = rz + vz * t;
  const wl = Math.sqrt(wx * wx + wy * wy + wz * wz);
  if (!(wl > 0) || !Number.isFinite(wl)) return null;
  let dx = wx / wl;
  let dy = wy / wl;
  let dz = wz / wl;
  const dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
  dx /= dl;
  dy /= dl;
  dz /= dl;
  const speedError = Math.abs(s * Math.sqrt(dx * dx + dy * dy + dz * dz) - s);
  if (!(speedError <= 1e-9 * s)) return null;

  const ix = targetPos.x + vx * t;
  const iy = targetPos.y + vy * t;
  const iz = targetPos.z + vz * t;
  const drop = ay * t * t; // = −0.5 g_y t²
  const ex = muzzle.x + s * dx * t - ix;
  const ey = muzzle.y + s * dy * t - drop - iy;
  const ez = muzzle.z + s * dz * t - iz;
  const residual = Math.sqrt(ex * ex + ey * ey + ez * ez);
  if (!(residual <= INTERCEPT_RESIDUAL_LIMIT)) return null; // also rejects NaN / Infinity
  if (!Number.isFinite(ix) || !Number.isFinite(iy) || !Number.isFinite(iz) || !Number.isFinite(iy + drop)) return null;
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(dz)) return null;

  return {
    t,
    dir: { x: dx, y: dy, z: dz },
    intercept: { x: ix, y: iy, z: iz },
    aimPoint: { x: ix, y: iy + drop, z: iz },
    residual,
  };
}

/**
 * Closed-form position of a projectile launched from `origin` with velocity `v0` under a downward
 * gravity of magnitude `gravity`, at age `age`: origin + v0·age + ½ g·age², g = (0, −gravity, 0)
 * (docs/SPEC.md §4.3 "解析的位置"). Writes to `out` (which may alias `origin`).
 */
export function ballisticPosition(origin: V3, v0: V3, gravity: number, age: number, out: V3): V3 {
  out.x = origin.x + v0.x * age;
  out.y = origin.y + v0.y * age - 0.5 * gravity * age * age;
  out.z = origin.z + v0.z * age;
  return out;
}

// ───────────────────────────── constant-speed lead ─────────────────────────────

export interface LinearSolution {
  t: number;
  /** Unit direction normalize(r + v t). */
  dir: V3;
  /** p + v t */
  intercept: V3;
}

/**
 * Constant-speed intercept without gravity (missile lead §4.4, enemy lead §2.3):
 *   (v·v - s²) t² + 2 (r·v) t + r·r = 0, smallest positive real root with t <= maxTime.
 * Handles the degenerate linear case (v·v == s²). Null when there is no such root, when the geometry is
 * degenerate (|r| <= DEGENERATE_RANGE) or when an argument is not a number (speed, maxTime must be > 0;
 * maxTime may be Infinity).
 *
 * The quadratic is solved with the cancellation-free form q = −(B + sign(B)·√D)/2, t = q/A or C/q.
 * A discriminant that is negative only by rounding noise counts as a double root; a root that exceeds
 * maxTime only by rounding noise (relative 1e-12) is clamped to maxTime.
 */
export function solveLinearIntercept(
  muzzle: V3,
  targetPos: V3,
  targetVel: V3,
  speed: number,
  maxTime: number,
): LinearSolution | null {
  const s = speed;
  if (!(s > 0) || !(maxTime > 0) || !Number.isFinite(s)) return null;
  const rx = targetPos.x - muzzle.x;
  const ry = targetPos.y - muzzle.y;
  const rz = targetPos.z - muzzle.z;
  const vx = targetVel.x;
  const vy = targetVel.y;
  const vz = targetVel.z;
  const C = rx * rx + ry * ry + rz * rz;
  if (!(C > DEGENERATE_RANGE * DEGENERATE_RANGE)) return null; // also rejects NaN
  const vv = vx * vx + vy * vy + vz * vz;
  const ss = s * s;
  const A = vv - ss;
  const B = 2 * (rx * vx + ry * vy + rz * vz);
  if (!Number.isFinite(A) || !Number.isFinite(B) || !Number.isFinite(C)) return null;

  let t = Number.POSITIVE_INFINITY;
  if (Math.abs(A) <= 16 * EPS * (vv + ss)) {
    // |v| == s: the quadratic term vanishes → B t + C = 0 (only a closing target can be caught).
    if (B < 0) t = -C / B;
  } else {
    let disc = B * B - 4 * A * C;
    if (disc < 0 && disc >= -64 * EPS * (B * B + Math.abs(4 * A * C))) disc = 0;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      const q = -0.5 * (B + (B >= 0 ? sq : -sq));
      const t1 = q / A;
      const t2 = q !== 0 ? C / q : Number.NaN;
      if (t1 > 0 && t1 < t) t = t1;
      if (t2 > 0 && t2 < t) t = t2;
    }
  }
  if (!(t > 0) || !Number.isFinite(t)) return null;
  if (t > maxTime) {
    if (t > maxTime * (1 + 1e-12)) return null;
    t = maxTime;
  }

  const wx = rx + vx * t;
  const wy = ry + vy * t;
  const wz = rz + vz * t;
  const wl = Math.sqrt(wx * wx + wy * wy + wz * wz);
  if (!(wl > 0) || !Number.isFinite(wl)) return null;
  // An unconverged time is never returned as a valid lead: the projectile must really meet the target.
  if (!(Math.abs(wl - s * t) <= INTERCEPT_RESIDUAL_LIMIT)) return null;
  const ix = targetPos.x + vx * t;
  const iy = targetPos.y + vy * t;
  const iz = targetPos.z + vz * t;
  if (!Number.isFinite(ix + iy + iz)) return null;
  return {
    t,
    dir: { x: wx / wl, y: wy / wl, z: wz / wl },
    intercept: { x: ix, y: iy, z: iz },
  };
}

// ───────────────────────────── steering ─────────────────────────────

/**
 * Rotates unit vector `current` towards unit vector `desired` by at most `maxAngle` radians
 * (great-circle rotation). Writes a unit vector to `out` (which may alias either input).
 *
 * - The inputs are normalised internally. If the angle between them is <= maxAngle the result is exactly
 *   the normalised `desired`; otherwise `current` turned by exactly `maxAngle` in the plane of both.
 * - maxAngle <= 0 (or NaN) → normalised `current`.
 * - Anti-parallel inputs have no unique rotation plane: the turn is then made deterministically about the
 *   world up axis (towards (c.z, 0, −c.x)), or about +X when `current` is vertical.
 * - A zero / non-finite `desired` leaves the heading unchanged; a zero / non-finite `current` yields the
 *   normalised `desired`; if both are unusable the zero vector is written (never NaN).
 */
export function rotateTowards(current: V3, desired: V3, maxAngle: number, out: V3): V3 {
  let cx = current.x;
  let cy = current.y;
  let cz = current.z;
  let tx = desired.x;
  let ty = desired.y;
  let tz = desired.z;
  const cl = Math.sqrt(cx * cx + cy * cy + cz * cz);
  const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
  const cOk = cl > 1e-12 && Number.isFinite(cl);
  const tOk = tl > 1e-12 && Number.isFinite(tl);
  if (tOk) {
    tx /= tl;
    ty /= tl;
    tz /= tl;
  }
  if (!cOk) {
    out.x = tOk ? tx : 0;
    out.y = tOk ? ty : 0;
    out.z = tOk ? tz : 0;
    return out;
  }
  cx /= cl;
  cy /= cl;
  cz /= cl;
  if (!tOk || !(maxAngle > 0)) {
    out.x = cx;
    out.y = cy;
    out.z = cz;
    return out;
  }

  let cosTheta = cx * tx + cy * ty + cz * tz;
  if (cosTheta > 1) cosTheta = 1;
  else if (cosTheta < -1) cosTheta = -1;
  // e = part of `desired` perpendicular to `current`; |e| = sin(theta)
  let ex = tx - cx * cosTheta;
  let ey = ty - cy * cosTheta;
  let ez = tz - cz * cosTheta;
  let el = Math.sqrt(ex * ex + ey * ey + ez * ez);
  const theta = Math.atan2(el, cosTheta);
  if (theta <= maxAngle) {
    out.x = tx;
    out.y = ty;
    out.z = tz;
    return out;
  }
  if (el < 1e-12) {
    if (cosTheta > 0) {
      // Indistinguishable from parallel (theta < 1e-12 rad): nothing meaningful to turn.
      out.x = tx;
      out.y = ty;
      out.z = tz;
      return out;
    }
    // Anti-parallel: deterministic perpendicular.
    if (cx * cx + cz * cz > 1e-12) {
      ex = cz;
      ey = 0;
      ez = -cx;
    } else {
      ex = 0;
      ey = -cz;
      ez = cy;
    }
    el = Math.sqrt(ex * ex + ey * ey + ez * ez);
  }
  ex /= el;
  ey /= el;
  ez /= el;
  // Second Gram–Schmidt pass: for almost anti-parallel inputs e is a difference of nearly equal
  // vectors, and what is left of `current` in it would shorten the turn.
  const along = ex * cx + ey * cy + ez * cz;
  ex -= cx * along;
  ey -= cy * along;
  ez -= cz * along;
  el = Math.sqrt(ex * ex + ey * ey + ez * ez);
  ex /= el;
  ey /= el;
  ez /= el;
  const cosA = Math.cos(maxAngle);
  const sinA = Math.sin(maxAngle);
  const ox = cx * cosA + ex * sinA;
  const oy = cy * cosA + ey * sinA;
  const oz = cz * cosA + ez * sinA;
  const ol = Math.sqrt(ox * ox + oy * oy + oz * oz);
  out.x = ox / ol;
  out.y = oy / ol;
  out.z = oz / ol;
  return out;
}

// ───────────────────────────── swept / ray tests ─────────────────────────────

/**
 * Continuous test of a point moving p0→p1 against a sphere of `radius` whose centre moves c0→c1,
 * both linearly over the same time interval. Returns the earliest fraction u ∈ [0, 1] of the interval
 * at which the point is on/inside the sphere (0 when it starts inside), or -1 when it never is.
 *
 * Exact in relative motion: q(u) = (p0 − c0) + u·((p1 − p0) − (c1 − c0)), first u with |q(u)| <= radius.
 * The entry is computed from the closest approach of the relative path to the centre (offset e at
 * u_c = −q·d / d·d) as u_c − √((radius² − e²) / d·d). Unlike the textbook discriminant b² − a c this does
 * not lose the sphere in rounding when the relative travel is many orders of magnitude larger than the
 * radius, so very fast crossings stay accurate; zero relative motion is handled explicitly.
 */
export function sweepPointSphere(p0: V3, p1: V3, c0: V3, c1: V3, radius: number): number {
  if (!(radius >= 0)) return -1;
  const qx = p0.x - c0.x;
  const qy = p0.y - c0.y;
  const qz = p0.z - c0.z;
  const r2 = radius * radius;
  if (qx * qx + qy * qy + qz * qz - r2 <= 0) return 0; // starts on / inside
  const dx = p1.x - p0.x - (c1.x - c0.x);
  const dy = p1.y - p0.y - (c1.y - c0.y);
  const dz = p1.z - p0.z - (c1.z - c0.z);
  const b = qx * dx + qy * dy + qz * dz;
  if (!(b < 0)) return -1; // not approaching (includes zero relative motion and NaN)
  const a = dx * dx + dy * dy + dz * dz;
  if (!(a > 0)) return -1;
  const uc = -b / a; // closest approach of the infinite relative line (> 0)
  const ex = qx + dx * uc;
  const ey = qy + dy * uc;
  const ez = qz + dz * uc;
  const h2 = r2 - (ex * ex + ey * ey + ez * ez);
  if (!(h2 >= 0)) return -1; // passes outside
  const u = uc - Math.sqrt(h2 / a);
  if (!(u <= 1)) return -1; // reaches the sphere only after the interval
  return u > 0 ? u : 0;
}

/**
 * Continuous test of a point moving p0→p1 against an axis-aligned box of half extents `half` whose
 * centre moves c0→c1 (same interval). Returns the earliest fraction u ∈ [0, 1] at which the point is
 * on/inside the box (0 when it starts inside), or -1.
 *
 * Slab clipping of the relative path against the closed box [−half, +half] (touching counts as contact).
 */
export function sweepPointBox(p0: V3, p1: V3, c0: V3, c1: V3, half: V3): number {
  let enter = 0;
  let exit = 1;
  for (let axis = 0; axis < 3; axis++) {
    let q: number;
    let d: number;
    let h: number;
    if (axis === 0) {
      q = p0.x - c0.x;
      d = p1.x - p0.x - (c1.x - c0.x);
      h = half.x;
    } else if (axis === 1) {
      q = p0.y - c0.y;
      d = p1.y - p0.y - (c1.y - c0.y);
      h = half.y;
    } else {
      q = p0.z - c0.z;
      d = p1.z - p0.z - (c1.z - c0.z);
      h = half.z;
    }
    if (!(h >= 0) || !Number.isFinite(q) || !Number.isFinite(d)) return -1;
    if (d === 0) {
      if (!(q >= -h && q <= h)) return -1; // never inside this slab
      continue;
    }
    let u0 = (-h - q) / d;
    let u1 = (h - q) / d;
    if (u0 > u1) {
      const tmp = u0;
      u0 = u1;
      u1 = tmp;
    }
    if (u0 > enter) enter = u0;
    if (u1 < exit) exit = u1;
    if (!(enter <= exit)) return -1;
  }
  return enter;
}

/**
 * Ray versus sphere. `dir` need not be normalised (the result is always a distance in metres).
 * Returns the distance from `origin` to the first point on/inside the sphere (0 when the origin is
 * on/inside it), or -1 when the ray misses or the entry lies beyond `maxDist`.
 */
export function raySphere(origin: V3, dir: V3, center: V3, radius: number, maxDist: number): number {
  if (!(radius >= 0) || !(maxDist >= 0)) return -1;
  const qx = origin.x - center.x;
  const qy = origin.y - center.y;
  const qz = origin.z - center.z;
  const r2 = radius * radius;
  if (qx * qx + qy * qy + qz * qz - r2 <= 0) return 0;
  const a = dir.x * dir.x + dir.y * dir.y + dir.z * dir.z;
  const b = qx * dir.x + qy * dir.y + qz * dir.z;
  if (!(b < 0) || !(a > 0)) return -1;
  const uc = -b / a; // closest approach along the ray, in units of |dir|
  const ex = qx + dir.x * uc;
  const ey = qy + dir.y * uc;
  const ez = qz + dir.z * uc;
  const h2 = r2 - (ex * ex + ey * ey + ez * ez);
  if (!(h2 >= 0)) return -1;
  const dist = uc * Math.sqrt(a) - Math.sqrt(h2);
  if (!(dist <= maxDist)) return -1;
  return dist > 0 ? dist : 0;
}
