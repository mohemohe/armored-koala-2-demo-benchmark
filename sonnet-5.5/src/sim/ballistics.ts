/**
 * Pure ballistic / interception solvers (no game-state access). OWNER: ballistics agent.
 * SPEC §4.3 (machinegun: intercept + gravity), §4.4 (missile constant-speed intercept), §2.3 (enemy intercept).
 *
 * Machinegun: with w(t) = r + v t - 0.5 g t², g = (0,-18,0), the hit condition |w|² = s² t² is the quartic
 *   F(t) = h² t⁴ + 2 h vy t³ + (v·v + 2 h ry - s²) t² + 2 (r·v) t + r·r = 0,   h = 9.
 * F(0) = r·r > 0 and the leading coefficient is a fixed positive constant, so the roots are isolated with the
 * critical points of F (roots of the cubic F', found recursively through the derivative chain). F is monotone
 * between them, so each piece holds at most one root, found with a bracketed safe-Newton iteration. Tangent
 * (double) roots and the t = maxT boundary are handled at the piece ends (see TANGENT_RESIDUAL).
 */
import { FCS, GRAVITY, WEAPONS } from '../config';
import type { V3 } from './types';

export interface MgSolution {
  /** time of flight to the predicted target center (smallest positive real root, 0 < t <= 2) */
  t: number;
  /** unit launch direction d = (r + v t - 0.5 g t²)/(s t) */
  direction: V3;
  /** initial velocity v0 = 100 * d */
  velocity: V3;
  /** predicted hit point p + v t */
  interceptPoint: V3;
  /** corrected aim point p + v t - 0.5 g t² (initial ray extended; ABOVE the intercept point) */
  aimPoint: V3;
  /** |projectile(t) - predictedTarget(t)| evaluated with the returned velocity (must be <= 0.01) */
  residual: number;
}

/** slack on the time bound (ARCH §3: time comparisons carry 1e-9 tolerance) */
const TIME_EPS = 1e-9;
/** |r|² below this (|r| < 1e-4 m): muzzle and target overlap -> no solution (caller aims directly) */
const MIN_R2 = 1e-8;
/**
 * A local minimum of F that stays positive but whose miss distance |w| - s t is below this is a tangent (double)
 * root whose sign is lost to rounding. Far below FCS.MAX_RESIDUAL_M, so it never weakens the 0.01 m guarantee.
 */
const TANGENT_RESIDUAL = 1e-7;

// ---------------------------------------------------------------------------
// generic 1-D root helpers
// ---------------------------------------------------------------------------

/** Horner evaluation, coefficients ascending (c[0] + c[1] x + ...). */
function horner(c: readonly number[], x: number): number {
  let r = 0;
  for (let i = c.length - 1; i >= 0; i--) r = r * x + c[i];
  return r;
}

function polyDerivative(c: readonly number[]): number[] {
  const d: number[] = [];
  for (let i = 1; i < c.length; i++) d.push(c[i] * i);
  return d;
}

/**
 * Bracketed Newton/bisection ("rtsafe"). f(x1) and f(x2) must have opposite signs (or one be 0).
 * Never leaves [x1, x2]; falls back to bisection whenever Newton is out of the bracket or converging slowly.
 */
function rootSafe(f: (x: number) => number, df: (x: number) => number, x1: number, x2: number, xacc: number): number {
  const fl0 = f(x1);
  if (fl0 === 0) return x1;
  const fh0 = f(x2);
  if (fh0 === 0) return x2;
  let xl: number;
  let xh: number;
  if (fl0 < 0) {
    xl = x1;
    xh = x2;
  } else {
    xl = x2;
    xh = x1;
  }
  let rts = 0.5 * (x1 + x2);
  let dxold = Math.abs(x2 - x1);
  let dx = dxold;
  let fv = f(rts);
  let dfv = df(rts);
  for (let j = 0; j < 200; j++) {
    if (((rts - xh) * dfv - fv) * ((rts - xl) * dfv - fv) > 0 || Math.abs(2 * fv) > Math.abs(dxold * dfv) || !Number.isFinite(dfv)) {
      dxold = dx;
      dx = 0.5 * (xh - xl);
      rts = xl + dx;
      if (xl === rts) return rts;
    } else {
      dxold = dx;
      dx = fv / dfv;
      const temp = rts;
      rts -= dx;
      if (temp === rts) return rts;
    }
    if (Math.abs(dx) < xacc) return rts;
    fv = f(rts);
    dfv = df(rts);
    if (fv === 0) return rts;
    if (fv < 0) xl = rts;
    else xh = rts;
  }
  return rts;
}

/**
 * All real roots of the polynomial c (ascending, non-zero leading coefficient) inside [lo, hi] where it changes sign
 * or is exactly 0, ascending. Uses the roots of the derivative as monotone-piece boundaries (recursive).
 */
function polyRoots(c: readonly number[], lo: number, hi: number): number[] {
  const n = c.length - 1;
  if (n < 1) return [];
  if (n === 1) {
    if (c[1] === 0) return [];
    const x = -c[0] / c[1];
    return x >= lo && x <= hi ? [x] : [];
  }
  const d = polyDerivative(c);
  const crit = polyRoots(d, lo, hi);
  const roots: number[] = [];
  const f = (x: number) => horner(c, x);
  const df = (x: number) => horner(d, x);
  let a = lo;
  let fa = f(a);
  if (fa === 0) roots.push(a);
  for (let i = 0; i <= crit.length; i++) {
    const b = i < crit.length ? crit[i] : hi;
    if (b <= a) continue;
    const fb = f(b);
    if (fb === 0) roots.push(b);
    else if (fa !== 0 && fa < 0 !== fb < 0) roots.push(rootSafe(f, df, a, b, 1e-15));
    a = b;
    fa = fb;
  }
  return roots;
}

// ---------------------------------------------------------------------------
// machinegun
// ---------------------------------------------------------------------------

/** Machinegun solution (muzzle speed 100, gravity (0,-18,0), 0<t<=2). Returns null when no valid solution exists. */
export function solveMachinegun(muzzle: V3, targetPos: V3, targetVel: V3): MgSolution | null {
  const s = WEAPONS.machinegun.muzzleSpeed;
  const g = WEAPONS.machinegun.gravity;
  const h = 0.5 * g;
  const maxT = FCS.MG_MAX_T;
  const vx = targetVel.x;
  const vy = targetVel.y;
  const vz = targetVel.z;
  const rx = targetPos.x - muzzle.x;
  const ry = targetPos.y - muzzle.y;
  const rz = targetPos.z - muzzle.z;
  const c0 = rx * rx + ry * ry + rz * rz;
  if (!Number.isFinite(c0) || !Number.isFinite(vx + vy + vz)) return null;
  if (c0 < MIN_R2) return null; // muzzle ~ target center: direct aim by the caller

  const s2 = s * s;
  const vv = vx * vx + vy * vy + vz * vz;
  const rv = rx * vx + ry * vy + rz * vz;
  const c1 = 2 * rv;
  const c2 = vv + 2 * h * ry - s2;
  const c3 = 2 * h * vy;
  const c4 = h * h;
  if (!Number.isFinite(c1 + c2 + c3)) return null;

  // w(t) = r + v t - 0.5 g t²  (0.5*g*t² is subtracted upward: +h t² in y)
  const F = (t: number): number => {
    const wx = rx + vx * t;
    const wy = ry + vy * t + h * t * t;
    const wz = rz + vz * t;
    return wx * wx + wy * wy + wz * wz - s2 * t * t;
  };
  const dF = (t: number): number => {
    const wx = rx + vx * t;
    const wy = ry + vy * t + h * t * t;
    const wz = rz + vz * t;
    return 2 * (wx * vx + wy * (vy + 2 * h * t) + wz * vz) - 2 * s2 * t;
  };
  /** miss distance |w| - s t for F(t) >= 0 (== F / (|w| + s t)) */
  const missAt = (t: number): number => {
    const f = F(t);
    const wx = rx + vx * t;
    const wy = ry + vy * t + h * t * t;
    const wz = rz + vz * t;
    return f / (Math.sqrt(wx * wx + wy * wy + wz * wz) + s * t);
  };

  const tHi = maxT + TIME_EPS;
  const crit = polyRoots([c1, 2 * c2, 3 * c3, 4 * c4], 0, tHi);

  // Walk the monotone pieces of F from t = 0; the first piece that reaches F <= 0 holds the smallest root.
  let root = NaN;
  let a = 0;
  let fa = c0;
  for (let i = 0; i <= crit.length; i++) {
    const b = i < crit.length ? crit[i] : tHi;
    if (!(b > a)) continue;
    const fb = F(b);
    if (fb <= 0) {
      root = rootSafe(F, dF, a, b, 1e-15);
      break;
    }
    if (fb < fa && missAt(b) <= TANGENT_RESIDUAL) {
      root = b; // tangent (double) root or root sitting exactly on the time bound, sign lost to rounding
      break;
    }
    a = b;
    fa = fb;
  }
  if (!Number.isFinite(root)) return null;
  return buildMgSolution(muzzle, targetPos, targetVel, Math.min(root, maxT), maxT);
}

/** Polish t (Newton on |w| - s t, accepting only improvements), build the solution and verify it (SPEC §4.3). */
function buildMgSolution(m: V3, p: V3, v: V3, t0: number, maxT: number): MgSolution | null {
  const s = WEAPONS.machinegun.muzzleSpeed;
  const g = WEAPONS.machinegun.gravity;
  const h = 0.5 * g;
  const rx = p.x - m.x;
  const ry = p.y - m.y;
  const rz = p.z - m.z;
  const gap = (t: number): number => {
    const wx = rx + v.x * t;
    const wy = ry + v.y * t + h * t * t;
    const wz = rz + v.z * t;
    return Math.sqrt(wx * wx + wy * wy + wz * wz) - s * t;
  };
  const dgap = (t: number): number => {
    const wx = rx + v.x * t;
    const wy = ry + v.y * t + h * t * t;
    const wz = rz + v.z * t;
    const len = Math.sqrt(wx * wx + wy * wy + wz * wz);
    if (!(len > 1e-12)) return NaN;
    return (wx * v.x + wy * (v.y + 2 * h * t) + wz * v.z) / len - s;
  };

  let t = t0;
  let best = Math.abs(gap(t));
  for (let i = 0; i < 30 && best > 1e-12; i++) {
    const dg = dgap(t);
    if (!Number.isFinite(dg) || dg === 0) break;
    const tn = t - gap(t) / dg;
    if (!(tn > 0) || tn > maxT) break;
    const e = Math.abs(gap(tn));
    if (!(e < best)) break;
    t = tn;
    best = e;
  }
  if (!(t > 0) || t > maxT) return null;

  const wx = rx + v.x * t;
  const wy = ry + v.y * t + h * t * t;
  const wz = rz + v.z * t;
  const len = Math.sqrt(wx * wx + wy * wy + wz * wz);
  if (!(len > 1e-12) || !Number.isFinite(len)) return null;
  const direction: V3 = { x: wx / len, y: wy / len, z: wz / len };
  const velocity: V3 = { x: direction.x * s, y: direction.y * s, z: direction.z * s };
  const interceptPoint: V3 = { x: p.x + v.x * t, y: p.y + v.y * t, z: p.z + v.z * t };
  const aimPoint: V3 = { x: interceptPoint.x, y: interceptPoint.y + h * t * t, z: interceptPoint.z };

  // verify with the same position formula the projectile uses
  const bullet = mgPositionAt(m, velocity, t);
  const residual = Math.hypot(bullet.x - interceptPoint.x, bullet.y - interceptPoint.y, bullet.z - interceptPoint.z);
  const speed = Math.hypot(velocity.x, velocity.y, velocity.z);
  if (!Number.isFinite(residual) || residual > FCS.MAX_RESIDUAL_M) return null;
  if (!Number.isFinite(speed) || Math.abs(speed - s) > FCS.MAX_SPEED_ERR) return null;
  return { t, direction, velocity, interceptPoint, aimPoint, residual };
}

export interface InterceptSolution {
  t: number;
  /** unit direction normalize(r + v t) */
  direction: V3;
}

/**
 * Constant-speed straight-line intercept (no gravity): smallest positive real root t in (0, maxT] of
 * (v·v - speed²) t² + 2 (r·v) t + r·r = 0, direction = normalize(r + v t).
 * Handles the linear case (|v·v - speed²| ~ 0). Returns null if no root in range.
 * Used by the missile (speed 45, maxT 4) and by enemy bullets (speed 70/60, maxT 1.2).
 */
export function solveConstantSpeedIntercept(muzzle: V3, targetPos: V3, targetVel: V3, speed: number, maxT: number): InterceptSolution | null {
  if (!(speed > 0) || !(maxT > 0) || !Number.isFinite(speed) || !Number.isFinite(maxT)) return null;
  const rx = targetPos.x - muzzle.x;
  const ry = targetPos.y - muzzle.y;
  const rz = targetPos.z - muzzle.z;
  const vx = targetVel.x;
  const vy = targetVel.y;
  const vz = targetVel.z;
  const c = rx * rx + ry * ry + rz * rz; // r·r
  if (!Number.isFinite(c) || !Number.isFinite(vx + vy + vz)) return null;
  if (c < MIN_R2) return null; // overlapping: caller aims directly
  const s2 = speed * speed;
  const a = vx * vx + vy * vy + vz * vz - s2; // (v·v - s²)
  const hb = rx * vx + ry * vy + rz * vz; // r·v (half of the linear coefficient)
  if (!Number.isFinite(a + hb)) return null;

  const tHi = maxT + TIME_EPS;
  const miss = (t: number): number => {
    const wx = rx + vx * t;
    const wy = ry + vy * t;
    const wz = rz + vz * t;
    return Math.sqrt(wx * wx + wy * wy + wz * wz) - speed * t;
  };

  let t = NaN;
  if (Math.abs(a) < 1e-12 * s2) {
    // linear: 2 (r·v) t + r·r = 0
    if (hb < 0) t = -c / (2 * hb);
  } else {
    const disc = hb * hb - a * c;
    if (disc >= 0) {
      // numerically stable pair of roots: t = q/a, t = c/q
      const q = -(hb + (hb < 0 ? -Math.sqrt(disc) : Math.sqrt(disc)));
      const cand: number[] = [];
      if (q !== 0) {
        cand.push(q / a, c / q);
      }
      for (const x of cand) {
        if (Number.isFinite(x) && x > 0 && x <= tHi && !(x >= t)) t = x;
      }
    } else if (a > 0) {
      // tangent case: target is faster than the projectile and just grazes the intercept cone
      const tc = -hb / a;
      if (tc > 0 && tc <= tHi && Math.abs(miss(tc)) <= TANGENT_RESIDUAL) t = tc;
    }
  }
  if (!Number.isFinite(t) || !(t > 0) || t > tHi) return null;
  t = Math.min(t, maxT);

  // Newton polish on |r + v t| - s t (accept improvements only)
  let best = Math.abs(miss(t));
  for (let i = 0; i < 20 && best > 1e-12; i++) {
    const wx = rx + vx * t;
    const wy = ry + vy * t;
    const wz = rz + vz * t;
    const len = Math.sqrt(wx * wx + wy * wy + wz * wz);
    if (!(len > 1e-12)) break;
    const dg = (wx * vx + wy * vy + wz * vz) / len - speed;
    if (!Number.isFinite(dg) || dg === 0) break;
    const tn = t - miss(t) / dg;
    if (!(tn > 0) || tn > maxT) break;
    const e = Math.abs(miss(tn));
    if (!(e < best)) break;
    t = tn;
    best = e;
  }
  if (!(best <= FCS.MAX_RESIDUAL_M)) return null;

  const wx = rx + vx * t;
  const wy = ry + vy * t;
  const wz = rz + vz * t;
  const len = Math.sqrt(wx * wx + wy * wy + wz * wz);
  if (!(len > 1e-12) || !Number.isFinite(len)) return null;
  return { t, direction: { x: wx / len, y: wy / len, z: wz / len } };
}

/** analytic machinegun bullet position: origin + v0*age + 0.5*g*age² with g=(0,-18,0) */
export function mgPositionAt(origin: V3, v0: V3, age: number): V3 {
  return { x: origin.x + v0.x * age, y: origin.y + v0.y * age - 0.5 * GRAVITY * age * age, z: origin.z + v0.z * age };
}
