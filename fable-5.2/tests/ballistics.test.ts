/**
 * Tests of src/sim/ballistics.ts (docs/SPEC.md §4.3, §4.4, §4.5, §4.6, §2.3).
 *
 * Everything here calls the real functions; the "brute force" references are independent
 * implementations (dense sampling, bisection, ternary search, candidate enumeration) that share no
 * code with the module under test.
 *
 * Set VITE_AK2_VERBOSE=1 to print the measured statistics of the property tests.
 */
import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import type { V3 } from '../src/core/vec';
import {
  DEGENERATE_RANGE,
  INTERCEPT_RESIDUAL_LIMIT,
  ROOT_TOLERANCE,
  ballisticPosition,
  gravityInterceptMiss,
  gravityInterceptQuartic,
  raySphere,
  rotateTowards,
  solveGravityIntercept,
  solveLinearIntercept,
  sweepPointBox,
  sweepPointSphere,
  type GravitySolution,
} from '../src/sim/ballistics';

const VERBOSE = import.meta.env.VITE_AK2_VERBOSE === '1';
const report = (...args: unknown[]): void => {
  if (VERBOSE) console.log('[ballistics]', ...args);
};

// ───────────────────────────── independent helpers ─────────────────────────────
const V = (x: number, y: number, z: number): V3 => ({ x, y, z });
const vadd = (a: V3, b: V3): V3 => V(a.x + b.x, a.y + b.y, a.z + b.z);
const vsub = (a: V3, b: V3): V3 => V(a.x - b.x, a.y - b.y, a.z - b.z);
const vscale = (a: V3, k: number): V3 => V(a.x * k, a.y * k, a.z * k);
const vdot = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const vcross = (a: V3, b: V3): V3 => V(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const vlen = (a: V3): number => Math.hypot(a.x, a.y, a.z);
const vnorm = (a: V3): V3 => vscale(a, 1 / vlen(a));
const vlerp = (a: V3, b: V3, u: number): V3 => V(a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u, a.z + (b.z - a.z) * u);
const angleBetween = (a: V3, b: V3): number => Math.atan2(vlen(vcross(a, b)), vdot(a, b));
const allFinite = (...vs: Array<V3 | number>): boolean =>
  vs.every((v) => (typeof v === 'number' ? Number.isFinite(v) : Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)));

function randUnit(rng: Rng): V3 {
  const z = rng.range(-1, 1);
  const phi = rng.range(0, 2 * Math.PI);
  const s = Math.sqrt(Math.max(0, 1 - z * z));
  return V(s * Math.cos(phi), z, s * Math.sin(phi));
}
function randVec(rng: Rng, minLen: number, maxLen: number): V3 {
  return vscale(randUnit(rng), rng.range(minLen, maxLen));
}

/** Independent signed miss distance |r + v t + (0, G/2, 0) t²| − s t (metres). */
function missFn(r: V3, v: V3, s: number, G: number): (t: number) => number {
  return (t: number) => Math.hypot(r.x + v.x * t, r.y + v.y * t + 0.5 * G * t * t, r.z + v.z * t) - s * t;
}

/** Bisection on g(a) > 0 >= g(b); returns the first abscissa where g <= 0 (to float resolution). */
function bisect(g: (t: number) => number, a: number, b: number): number {
  let lo = a;
  let hi = b;
  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (lo + hi);
    if (mid <= lo || mid >= hi) break;
    if (g(mid) > 0) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** Ternary search for the minimum of a unimodal function on [a, b]. */
function ternaryMin(g: (t: number) => number, a: number, b: number): number {
  let lo = a;
  let hi = b;
  for (let i = 0; i < 200; i++) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    if (g(m1) <= g(m2)) hi = m2;
    else lo = m1;
  }
  return 0.5 * (lo + hi);
}

type Brute =
  | { kind: 'cross'; t: number; nearTangent: boolean }
  | { kind: 'touch'; t: number; depth: number }
  | { kind: 'ambiguous'; t: number; depth: number }
  | { kind: 'none' };

/**
 * Reference: smallest root of g on (0, T] by a dense scan with N samples. Besides plain sign changes it
 * refines every sampled local minimum (ternary search), so that pairs of close roots between two samples
 * and touching double roots are classified as well:
 *   cross      g really becomes <= 0: refined by bisection
 *   touch      a local minimum with 0 <= g <= 0.5e-9 m (the solver must accept it: ROOT_TOLERANCE = 1e-9)
 *   ambiguous  a local minimum in (0.5e-9, 2e-9] m — too close to the tolerance to demand either outcome
 */
function bruteSmallestRoot(g: (t: number) => number, T: number, N: number): Brute {
  let t2 = 0;
  let g2 = g(0);
  let t1 = 0;
  let g1 = g2;
  const inspectMin = (a: number, b: number): Brute | null => {
    const tm = ternaryMin(g, a, b);
    const gm = g(tm);
    if (gm < 0) return { kind: 'cross', t: bisect(g, a, tm), nearTangent: gm > -1e-6 };
    if (gm <= 0.5e-9) return { kind: 'touch', t: tm, depth: gm };
    if (gm <= 2e-9) return { kind: 'ambiguous', t: tm, depth: gm };
    return null;
  };
  for (let i = 1; i <= N; i++) {
    const t = i === N ? T : (T * i) / N;
    const gt = g(t);
    if (gt <= 0) {
      // a local minimum just before this sample may hide an even earlier pair of roots
      if (i >= 2 && g1 <= g2) {
        const early = inspectMin(t2, t1);
        if (early) return early;
      }
      return { kind: 'cross', t: bisect(g, t1, t), nearTangent: false };
    }
    if (i >= 2 && g1 <= g2 && g1 <= gt) {
      const found = inspectMin(t2, t);
      if (found) return found;
    }
    t2 = t1;
    g2 = g1;
    t1 = t;
    g1 = gt;
  }
  // a minimum hiding in the last cell (g still decreasing at T)
  if (g1 < g2) {
    const found = inspectMin(t2, t1);
    if (found) return found;
  }
  return { kind: 'none' };
}

/** Independent validation of a returned solution against the spec's definitions. */
function expectValidSolution(
  sol: GravitySolution,
  m: V3,
  p: V3,
  v: V3,
  s: number,
  G: number,
  T: number,
  residualLimit: number,
): void {
  expect(allFinite(sol.t, sol.dir, sol.intercept, sol.aimPoint, sol.residual)).toBe(true);
  expect(sol.t).toBeGreaterThan(0);
  expect(sol.t).toBeLessThanOrEqual(T);
  // launch speed is exactly s
  const v0 = vscale(sol.dir, s);
  expect(Math.abs(vlen(v0) - s)).toBeLessThanOrEqual(1e-9 * Math.max(1, s));
  // analytic bullet position m + v0 t + 0.5 g t² versus the constant-velocity target p + v t
  const bullet = V(m.x + v0.x * sol.t, m.y + v0.y * sol.t - 0.5 * G * sol.t * sol.t, m.z + v0.z * sol.t);
  const target = vadd(p, vscale(v, sol.t));
  const miss = vlen(vsub(bullet, target));
  expect(miss).toBeLessThanOrEqual(residualLimit);
  expect(sol.residual).toBeLessThanOrEqual(residualLimit);
  expect(Math.abs(sol.residual - miss)).toBeLessThanOrEqual(1e-9 * Math.max(1, vlen(target)));
  // intercept and aim point definitions
  expect(vlen(vsub(sol.intercept, target))).toBeLessThanOrEqual(1e-9 * Math.max(1, vlen(target)));
  const aim = V(target.x, target.y + 0.5 * G * sol.t * sol.t, target.z);
  expect(vlen(vsub(sol.aimPoint, aim))).toBeLessThanOrEqual(1e-9 * Math.max(1, vlen(aim)));
  // the aim point lies on the initial muzzle line, s·t away from the muzzle
  const toAim = vsub(sol.aimPoint, m);
  expect(Math.abs(vlen(toAim) - s * sol.t)).toBeLessThanOrEqual(residualLimit + 1e-9 * s * sol.t);
  if (vlen(toAim) > 1e-3) expect(vlen(vcross(vnorm(toAim), sol.dir))).toBeLessThanOrEqual(1e-6);
}

// ───────────────────────────── §4.6 reference cases ─────────────────────────────
const MUZZLE = V(0, 20, 0);
const SPEED = 100;
const GRAVITY = 18;
const LIFE = 2;

const A_CASES: Array<{ id: string; r: V3; v: V3 }> = [
  { id: 'A01', r: V(0, 0, 20), v: V(0, 0, 0) },
  { id: 'A02', r: V(0, 0, 60), v: V(0, 0, 0) },
  { id: 'A03', r: V(0, 0, 100), v: V(0, 0, 0) },
  { id: 'A04', r: V(0, 0, 120), v: V(0, 0, 0) },
  { id: 'A05', r: V(0, 0, 100), v: V(8, 0, 0) },
  { id: 'A06', r: V(0, 0, 100), v: V(-8, 0, 0) },
  { id: 'A07', r: V(0, 0, 100), v: V(0, 0, 8) },
  { id: 'A08', r: V(0, 0, 100), v: V(0, 0, -8) },
  { id: 'A09', r: V(0, 16, 100), v: V(6, 0, 0) },
  { id: 'A10', r: V(0, -16, 100), v: V(-6, 0, 0) },
  { id: 'A11', r: V(0, 0, 100), v: V(6, 3, 0) },
  { id: 'A12', r: V(0, 0, 100), v: V(6, -3, 0) },
  { id: 'A13', r: V(0, 0, 120), v: V(6, 3, 4) },
];
const aCase = (id: string): { p: V3; r: V3; v: V3 } => {
  const c = A_CASES.find((k) => k.id === id);
  if (!c) throw new Error(`unknown case ${id}`);
  return { p: vadd(MUZZLE, c.r), r: c.r, v: c.v };
};
const solveA = (id: string): GravitySolution => {
  const c = aCase(id);
  const sol = solveGravityIntercept(MUZZLE, c.p, c.v, SPEED, GRAVITY, LIFE);
  if (!sol) throw new Error(`${id}: no solution`);
  return sol;
};

describe('solveGravityIntercept — spec §4.6 reference values', () => {
  it('A03: stationary target at 100 m', () => {
    const sol = solveA('A03');
    expect(sol.t).toBeCloseTo(1.004108529, 9);
    expect(sol.dir.x * SPEED).toBeCloseTo(0, 9);
    expect(sol.dir.y * SPEED).toBeCloseTo(9.036976765, 8);
    expect(sol.dir.z * SPEED).toBeCloseTo(99.590828147, 8);
    // closed form of the biquadratic 81 u² − 10000 u + 10000 = 0, u = t²
    const u = (10000 - Math.sqrt(10000 * 10000 - 4 * 81 * 10000)) / (2 * 81);
    expect(Math.abs(sol.t - Math.sqrt(u))).toBeLessThan(1e-12);
  });

  it('A05: target crossing at 8 m/s', () => {
    const sol = solveA('A05');
    expect(sol.t).toBeCloseTo(1.007391236, 9);
    expect(sol.dir.x * SPEED).toBeCloseTo(8, 8);
    expect(sol.dir.y * SPEED).toBeCloseTo(9.066521121, 8);
    expect(sol.dir.z * SPEED).toBeCloseTo(99.266299391, 8);
    // mirrored case A06
    const mirrored = solveA('A06');
    expect(mirrored.t).toBe(sol.t);
    expect(mirrored.dir.x).toBe(-sol.dir.x);
    expect(mirrored.dir.y).toBe(sol.dir.y);
    expect(mirrored.dir.z).toBe(sol.dir.z);
  });

  it('A13: valid solution with a flight time above the enemy-AI cap of 1.20 s', () => {
    const sol = solveA('A13');
    expect(sol.t).toBeCloseTo(1.266137996, 9);
    expect(sol.t).toBeGreaterThan(1.2);
    expect(sol.t).toBeLessThanOrEqual(LIFE);
  });

  it('all 13 A-cases: residual <= 1e-6 m, |v0| = 100 ± 1e-9, bullet meets the target, smallest root', () => {
    let maxResidual = 0;
    let maxIndependentMiss = 0;
    let maxSpeedError = 0;
    for (const c of A_CASES) {
      const p = vadd(MUZZLE, c.r);
      const sol = solveGravityIntercept(MUZZLE, p, c.v, SPEED, GRAVITY, LIFE);
      expect(sol, c.id).not.toBeNull();
      if (!sol) continue;
      expect(sol.residual, c.id).toBeLessThanOrEqual(1e-6);
      const v0 = vscale(sol.dir, SPEED);
      const speedError = Math.abs(vlen(v0) - SPEED);
      expect(speedError, c.id).toBeLessThanOrEqual(1e-9);
      // independent check: m + v0 t + 0.5 g t² == p + v t
      const g = V(0, -GRAVITY, 0);
      const bullet = vadd(vadd(MUZZLE, vscale(v0, sol.t)), vscale(g, 0.5 * sol.t * sol.t));
      const target = vadd(p, vscale(c.v, sol.t));
      const miss = vlen(vsub(bullet, target));
      expect(miss, c.id).toBeLessThanOrEqual(1e-6);
      // d = (r + v t − 0.5 g t²) / (s t)
      const w = vsub(vadd(c.r, vscale(c.v, sol.t)), vscale(g, 0.5 * sol.t * sol.t));
      const dSpec = vscale(w, 1 / (SPEED * sol.t));
      expect(vlen(vsub(dSpec, sol.dir)), c.id).toBeLessThanOrEqual(1e-12);
      // the aim point is above the predicted hit point by 0.5·18·t²
      expect(sol.aimPoint.y - sol.intercept.y, c.id).toBeCloseTo(9 * sol.t * sol.t, 10);
      expect(sol.aimPoint.x, c.id).toBe(sol.intercept.x);
      expect(sol.aimPoint.z, c.id).toBe(sol.intercept.z);
      expectValidSolution(sol, MUZZLE, p, c.v, SPEED, GRAVITY, LIFE, 1e-6);
      // the quartic of the spec vanishes at the returned time (relative to its largest term)
      const q = gravityInterceptQuartic(MUZZLE, p, c.v, SPEED, GRAVITY);
      const t = sol.t;
      const f = (((q[4] * t + q[3]) * t + q[2]) * t + q[1]) * t + q[0];
      expect(Math.abs(f), c.id).toBeLessThanOrEqual(1e-9 * SPEED * SPEED * t * t);
      // it is the smallest positive root: a dense independent scan agrees
      const brute = bruteSmallestRoot(missFn(c.r, c.v, SPEED, GRAVITY), LIFE, 40000);
      expect(brute.kind, c.id).toBe('cross');
      if (brute.kind === 'cross') expect(Math.abs(brute.t - sol.t), c.id).toBeLessThanOrEqual(1e-10);
      maxResidual = Math.max(maxResidual, sol.residual);
      maxIndependentMiss = Math.max(maxIndependentMiss, miss);
      maxSpeedError = Math.max(maxSpeedError, speedError);
    }
    report('A01–A13 max residual', maxResidual, 'max independent miss', maxIndependentMiss, 'max |v0| error', maxSpeedError);
  });

  it('prints flight times that match hand-checkable limits', () => {
    // A01: t slightly above 20/100; A07 (receding) is slower than A03, A08 (closing) faster
    expect(solveA('A01').t).toBeGreaterThan(0.2);
    expect(solveA('A01').t).toBeLessThan(0.2001);
    expect(solveA('A07').t).toBeGreaterThan(solveA('A03').t);
    expect(solveA('A08').t).toBeLessThan(solveA('A03').t);
    // higher target needs more elevation than the lower one
    expect(solveA('A09').dir.y).toBeGreaterThan(solveA('A10').dir.y);
    // a pure "aim at the predicted hit point" would undershoot: the launch direction is above it
    for (const c of A_CASES) {
      const sol = solveA(c.id);
      const direct = vnorm(vsub(sol.intercept, MUZZLE));
      expect(sol.dir.y, c.id).toBeGreaterThan(direct.y);
    }
  });

  it('chooses the flat trajectory when a lofted one also fits into the life time', () => {
    // s = 20, G = 18, level target at 10 m: 81 u² − 400 u + 100 = 0, u = t² → t = 0.5097 s (flat) or 2.180 s (lofted)
    const p = V(0, 0, 10);
    const disc = Math.sqrt(400 * 400 - 4 * 81 * 100);
    const tFlat = Math.sqrt((400 - disc) / 162);
    const tLoft = Math.sqrt((400 + disc) / 162);
    expect(tLoft).toBeLessThan(4);
    const sol = solveGravityIntercept(V(0, 0, 0), p, V(0, 0, 0), 20, 18, 4);
    expect(sol).not.toBeNull();
    if (sol) {
      expect(sol.t).toBeCloseTo(tFlat, 13);
      expect(Math.atan2(sol.dir.y, sol.dir.z)).toBeLessThan(Math.PI / 4);
      expect(sol.residual).toBeLessThanOrEqual(1e-12);
    }
    // the lofted root is a real root too (the miss function vanishes there) but must never be returned
    expect(Math.abs(gravityInterceptMiss(V(0, 0, 0), p, V(0, 0, 0), 20, 18, tLoft))).toBeLessThan(1e-12);
  });

  it('handles vanishing and negative gravity consistently', () => {
    for (const c of A_CASES) {
      const p = vadd(MUZZLE, c.r);
      // gravity → 0 converges to the straight-line lead of solveLinearIntercept
      const lin = solveLinearIntercept(MUZZLE, p, c.v, SPEED, LIFE);
      const zero = solveGravityIntercept(MUZZLE, p, c.v, SPEED, 0, LIFE);
      const tiny = solveGravityIntercept(MUZZLE, p, c.v, SPEED, 1e-12, LIFE);
      expect(lin, c.id).not.toBeNull();
      expect(zero, c.id).not.toBeNull();
      expect(tiny, c.id).not.toBeNull();
      if (!lin || !zero || !tiny) continue;
      expect(Math.abs(zero.t - lin.t), c.id).toBeLessThanOrEqual(1e-13);
      expect(vlen(vsub(zero.dir, lin.dir)), c.id).toBeLessThanOrEqual(1e-13);
      expect(Math.abs(tiny.t - lin.t), c.id).toBeLessThanOrEqual(1e-11);
      expect(zero.aimPoint, c.id).toEqual(zero.intercept);
      // upward "gravity" is the mirror image of the downward problem
      const mirrorP = V(p.x, 2 * MUZZLE.y - p.y, p.z);
      const mirrorV = V(c.v.x, -c.v.y, c.v.z);
      const down = solveA(c.id);
      const up = solveGravityIntercept(MUZZLE, mirrorP, mirrorV, SPEED, -GRAVITY, LIFE);
      expect(up, c.id).not.toBeNull();
      if (!up) continue;
      expect(Math.abs(up.t - down.t), c.id).toBeLessThanOrEqual(1e-13);
      expect(Math.abs(up.dir.y + down.dir.y), c.id).toBeLessThanOrEqual(1e-13);
      expect(up.residual, c.id).toBeLessThanOrEqual(1e-9);
    }
  });

  it('is independent of the absolute muzzle position (translation invariance)', () => {
    for (const c of A_CASES) {
      const base = solveA(c.id);
      const m2 = V(-37.25, 3.5, 912.75);
      const sol = solveGravityIntercept(m2, vadd(m2, c.r), c.v, SPEED, GRAVITY, LIFE);
      expect(sol, c.id).not.toBeNull();
      if (!sol) continue;
      expect(Math.abs(sol.t - base.t), c.id).toBeLessThanOrEqual(1e-12);
      expect(vlen(vsub(sol.dir, base.dir)), c.id).toBeLessThanOrEqual(1e-12);
      expect(sol.residual, c.id).toBeLessThanOrEqual(1e-6);
    }
  });
});

// ───────────────────────────── property test against brute force ─────────────────────────────
interface Config {
  m: V3;
  p: V3;
  r: V3;
  v: V3;
  s: number;
  G: number;
  T: number;
}

function makeConfig(rng: Rng, regime: number): Config {
  const m = V(rng.range(-50, 50), rng.range(0, 40), rng.range(-50, 50));
  let s = 100;
  let G = 18;
  let T = 2;
  let r: V3;
  let v: V3;
  switch (regime) {
    case 0: // game-like engagement
      r = randVec(rng, 1, 150);
      v = randVec(rng, 0, 40);
      break;
    case 1: // around the edge of the 2 s envelope
      r = randVec(rng, 150, 260);
      v = randVec(rng, 0, 60);
      break;
    case 2: // fast targets, many faster than the bullet
      r = randVec(rng, 20, 200);
      v = randVec(rng, 60, 200);
      break;
    case 3: // arbitrary weapon parameters
      s = rng.range(10, 300);
      G = rng.range(0, 60);
      T = rng.range(0.2, 12);
      r = randVec(rng, 0.5, 400);
      v = randVec(rng, 0, 150);
      break;
    case 4: // no gravity (quartic degenerates to a quadratic)
      G = 0;
      s = rng.range(20, 150);
      T = rng.range(0.5, 6);
      r = randVec(rng, 1, 300);
      v = randVec(rng, 0, 160);
      break;
    default: {
      // families built around a tangential contact at a chosen time t*: d·(v + G t* ŷ) = s·(1 + δ)
      // δ = 0 is an exact double root; small |δ| gives two nearly coinciding roots or a narrow miss.
      T = rng.range(1, 3);
      const tStar = rng.range(0.15, 0.95) * T;
      const d = randUnit(rng);
      d.y = Math.abs(d.y) * 0.9 + 0.1;
      const dn = vnorm(d);
      const delta = rng.sign() * 10 ** rng.range(-9, -2);
      const along = s * (1 + delta) - G * tStar * dn.y;
      const side = vcross(dn, randUnit(rng));
      v = vadd(vscale(dn, along), vscale(side, rng.range(0, 30)));
      // r = s t* d − v t* − a t*²
      r = vsub(vsub(vscale(dn, s * tStar), vscale(v, tStar)), V(0, 0.5 * G * tStar * tStar, 0));
      break;
    }
  }
  return { m, p: vadd(m, r), r: vsub(vadd(m, r), m), v, s, G, T };
}

describe('solveGravityIntercept — property test against a dense brute-force scan', () => {
  // VITE_AK2_PER_REGIME enlarges the run for soak testing (default: 6 × 1500 configurations, ~7 s).
  const PER_REGIME = Math.max(1500, Number(import.meta.env.VITE_AK2_PER_REGIME ?? 0) || 0);
  const PROPERTY_TIMEOUT_MS = Math.max(120_000, PER_REGIME * 20);

  it('returns exactly the smallest root in (0, maxTime], and null when there is none', { timeout: PROPERTY_TIMEOUT_MS }, () => {
    const rng = new Rng(0xa2b17c3);
    const SAMPLES = 20000;
    const stats = { solved: 0, none: 0, touch: 0, ambiguous: 0, bruteMissed: 0, maxResidual: 0, maxDt: 0, nearTangent: 0 };
    const perRegime: string[] = [];
    for (let regime = 0; regime < 6; regime++) {
      let solvedHere = 0;
      for (let k = 0; k < PER_REGIME; k++) {
        const c = makeConfig(rng, regime);
        const label = `regime ${regime} #${k}`;
        const g = missFn(c.r, c.v, c.s, c.G);
        const brute = bruteSmallestRoot(g, c.T, SAMPLES);
        const sol = solveGravityIntercept(c.m, c.p, c.v, c.s, c.G, c.T);
        if (sol) {
          // whatever the reference says, a returned solution must be a real one
          expectValidSolution(sol, c.m, c.p, c.v, c.s, c.G, c.T, 1e-8);
          expect(Math.abs(g(sol.t)), label).toBeLessThanOrEqual(2e-9);
          stats.maxResidual = Math.max(stats.maxResidual, sol.residual);
        }
        if (brute.kind === 'cross') {
          expect(sol, label).not.toBeNull();
          if (!sol) continue;
          // A root is only as well defined as the crossing is steep: with a slope of σ m/s the ~1e-13 m
          // rounding noise of the miss function moves it by ~1e-13/σ seconds. Shallow crossings (pairs of
          // nearly coinciding roots) are compared with a correspondingly wider tolerance.
          const slope = Math.abs(g(brute.t + 1e-6) - g(brute.t - 1e-6)) / 2e-6;
          const nearTangent = brute.nearTangent || slope < 1e-2;
          const tol = nearTangent ? 1e-4 * Math.max(1, brute.t) : 1e-9 * Math.max(1, brute.t) + 1e-11 / slope;
          if (sol.t < brute.t - tol) {
            // the solver found a root the sampled scan stepped over
            stats.bruteMissed++;
          } else {
            expect(Math.abs(sol.t - brute.t), label).toBeLessThanOrEqual(tol);
            if (slope > 1) stats.maxDt = Math.max(stats.maxDt, Math.abs(sol.t - brute.t));
          }
          if (nearTangent) stats.nearTangent++;
          stats.solved++;
          solvedHere++;
        } else if (brute.kind === 'touch') {
          expect(sol, label).not.toBeNull();
          if (!sol) continue;
          if (sol.t < brute.t - 1e-4) stats.bruteMissed++;
          else expect(Math.abs(sol.t - brute.t), label).toBeLessThanOrEqual(1e-4);
          stats.touch++;
          solvedHere++;
        } else if (brute.kind === 'ambiguous') {
          stats.ambiguous++;
        } else {
          if (sol) stats.bruteMissed++;
          else stats.none++;
        }
      }
      perRegime.push(`${regime}:${solvedHere}/${PER_REGIME}`);
    }
    report('property test', JSON.stringify(stats), 'solved per regime', perRegime.join(' '));
    // the reference never had to be overruled, and both outcomes were exercised substantially
    expect(stats.bruteMissed).toBe(0);
    expect(stats.solved).toBeGreaterThan(2 * PER_REGIME);
    expect(stats.none).toBeGreaterThan(PER_REGIME);
    expect(stats.nearTangent + stats.touch).toBeGreaterThan(PER_REGIME / 4);
    expect(stats.ambiguous).toBeLessThan(PER_REGIME / 50);
    expect(stats.maxResidual).toBeLessThanOrEqual(1e-9);
    expect(stats.maxDt).toBeLessThanOrEqual(1e-9);
  });

  it('is deterministic (identical inputs → bit-identical outputs)', () => {
    const rng = new Rng(77);
    for (let k = 0; k < 200; k++) {
      const c = makeConfig(rng, k % 6);
      const a = solveGravityIntercept(c.m, c.p, c.v, c.s, c.G, c.T);
      const b = solveGravityIntercept({ ...c.m }, { ...c.p }, { ...c.v }, c.s, c.G, c.T);
      expect(b).toStrictEqual(a);
    }
  });
});

// ───────────────────────────── double roots ─────────────────────────────
describe('solveGravityIntercept — tangential double roots', () => {
  // Stationary target exactly at the maximum ballistic range on level ground: R = s²/G. The low and the
  // high trajectory coincide (45° launch), t* = √2·s/G, and the quartic only touches zero.
  const s = 20;
  const G = 18;
  const R = (s * s) / G;
  const tStar = (Math.SQRT2 * s) / G;
  const m = V(1, 2, 3);

  it('finds the double root of a target at exactly the maximum range', () => {
    expect(tStar).toBeLessThan(2);
    const sol = solveGravityIntercept(m, V(1, 2, 3 + R), V(0, 0, 0), s, G, 2);
    expect(sol).not.toBeNull();
    if (!sol) return;
    expect(Math.abs(sol.t - tStar)).toBeLessThanOrEqual(1e-6);
    expect(sol.dir.x).toBeCloseTo(0, 9);
    expect(sol.dir.y).toBeCloseTo(Math.SQRT1_2, 6);
    expect(sol.dir.z).toBeCloseTo(Math.SQRT1_2, 6);
    expect(sol.residual).toBeLessThanOrEqual(1e-9);
    expectValidSolution(sol, m, V(1, 2, 3 + R), V(0, 0, 0), s, G, 2, 1e-9);
  });

  it('returns the touching root where a pure sign-change scan sees nothing', () => {
    // 1e-11 m beyond the maximum range: the miss distance stays strictly positive everywhere (there is no
    // sign change at all) but touches zero to within 1e-11 m — numerically a double root.
    const p = V(1, 2, 3 + R + 1e-11);
    const g = missFn(vsub(p, m), V(0, 0, 0), s, G);
    let minMiss = Infinity;
    let crossings = 0;
    for (let i = 1; i <= 400000; i++) {
      const gi = g((2 * i) / 400000);
      if (gi <= 0) crossings++;
      minMiss = Math.min(minMiss, gi);
    }
    const tm = ternaryMin(g, tStar - 0.01, tStar + 0.01);
    minMiss = Math.min(minMiss, g(tm));
    expect(crossings).toBe(0);
    expect(minMiss).toBeGreaterThan(0);
    expect(minMiss).toBeLessThan(ROOT_TOLERANCE);

    const sol = solveGravityIntercept(m, p, V(0, 0, 0), s, G, 2);
    expect(sol).not.toBeNull();
    if (!sol) return;
    expect(Math.abs(sol.t - tStar)).toBeLessThanOrEqual(1e-5);
    expect(sol.residual).toBeLessThanOrEqual(ROOT_TOLERANCE);
    expect(sol.residual).toBeLessThanOrEqual(INTERCEPT_RESIDUAL_LIMIT);
    expectValidSolution(sol, m, p, V(0, 0, 0), s, G, 2, ROOT_TOLERANCE);
  });

  it('does not invent a solution for a target genuinely out of range, and picks the lower of two close roots inside it', () => {
    // 1 µm beyond the maximum range: closest approach ~0.7 µm ≫ tolerance → no solution
    expect(solveGravityIntercept(m, V(1, 2, 3 + R + 1e-6), V(0, 0, 0), s, G, 2)).toBeNull();
    // 1 µm inside: two roots straddle t*; the smaller (flatter trajectory) must be returned
    const p = V(1, 2, 3 + R - 1e-6);
    const sol = solveGravityIntercept(m, p, V(0, 0, 0), s, G, 2);
    expect(sol).not.toBeNull();
    if (!sol) return;
    expect(sol.t).toBeLessThan(tStar);
    expect(tStar - sol.t).toBeLessThan(1e-3);
    expect(sol.dir.y).toBeLessThan(Math.SQRT1_2);
    const brute = bruteSmallestRoot(missFn(vsub(p, m), V(0, 0, 0), s, G), 2, 40000);
    expect(brute.kind).toBe('cross');
    if (brute.kind === 'cross') expect(Math.abs(brute.t - sol.t)).toBeLessThanOrEqual(1e-7);
    expect(sol.residual).toBeLessThanOrEqual(1e-9);
  });

  it('finds a constructed double root for a moving target (machine-gun parameters)', () => {
    // Choose the launch direction d and the time t*, then a target velocity with d·(v + G t* ŷ) = s:
    // f(t*) = 0 and f'(t*) = 0, and f'' > 0 because d points upwards → the two roots coincide at t*.
    const d = vnorm(V(0.3, 0.5, 0.8));
    const tS = 1.2;
    const along = SPEED - GRAVITY * tS * d.y;
    const side = vnorm(vcross(d, V(0, 1, 0)));
    const v = vadd(vscale(d, along), vscale(side, 7));
    const r = vsub(vsub(vscale(d, SPEED * tS), vscale(v, tS)), V(0, 0.5 * GRAVITY * tS * tS, 0));
    const p = vadd(MUZZLE, r);
    const g = missFn(r, v, SPEED, GRAVITY);
    // it is a tangential contact: zero value, zero slope, positive curvature, no earlier root
    expect(Math.abs(g(tS))).toBeLessThan(1e-11);
    expect(Math.abs(g(tS + 1e-4) - g(tS - 1e-4)) / 2e-4).toBeLessThan(1e-6);
    expect(g(tS - 1e-2)).toBeGreaterThan(1e-5);
    expect(g(tS + 1e-2)).toBeGreaterThan(1e-5);
    for (let i = 1; i < 20000; i++) {
      const t = (1.19 * i) / 20000;
      expect(g(t)).toBeGreaterThan(0);
    }

    const sol = solveGravityIntercept(MUZZLE, p, v, SPEED, GRAVITY, 2);
    expect(sol).not.toBeNull();
    if (!sol) return;
    expect(Math.abs(sol.t - tS)).toBeLessThanOrEqual(1e-5);
    expect(vlen(vsub(sol.dir, d))).toBeLessThanOrEqual(1e-5);
    expect(sol.residual).toBeLessThanOrEqual(1e-9);
    expectValidSolution(sol, MUZZLE, p, v, SPEED, GRAVITY, 2, 1e-9);

    // pushed 1e-11 m away along d: strictly positive miss everywhere, still accepted as the double root
    const pFar = vadd(p, vscale(d, 1e-11));
    const gFar = missFn(vsub(pFar, MUZZLE), v, SPEED, GRAVITY);
    const tm = ternaryMin(gFar, tS - 0.05, tS + 0.05);
    expect(gFar(tm)).toBeGreaterThan(0);
    expect(gFar(tm)).toBeLessThan(ROOT_TOLERANCE);
    const solFar = solveGravityIntercept(MUZZLE, pFar, v, SPEED, GRAVITY, 2);
    expect(solFar).not.toBeNull();
    if (solFar) {
      expect(Math.abs(solFar.t - tS)).toBeLessThanOrEqual(1e-4);
      expect(solFar.residual).toBeLessThanOrEqual(ROOT_TOLERANCE);
    }
    // pushed 1e-5 m away: a real miss → no solution up to t = 1.5 (verified independently)
    const pMiss = vadd(p, vscale(d, 1e-5));
    expect(bruteSmallestRoot(missFn(vsub(pMiss, MUZZLE), v, SPEED, GRAVITY), 1.5, 40000).kind).toBe('none');
    expect(solveGravityIntercept(MUZZLE, pMiss, v, SPEED, GRAVITY, 1.5)).toBeNull();
  });

  it('finds roots of higher multiplicity (stationary inflection and fourth-order contact)', () => {
    // Fourth-order contact: f(t) = 81 (t − 1)⁴ ≥ 0. It needs v_y = −G t*, |r| = G t*²/2, r·v = −G² t*³/2 and
    // v·v + G r_y − s² = 1.5 G² t*². With G = 18, t* = 1: r = (0, 0, 9), v = (0, −18, −18), s = √162.
    const s4 = Math.sqrt(162);
    const q = gravityInterceptQuartic(V(0, 0, 0), V(0, 0, 9), V(0, -18, -18), s4, 18);
    expect(q[0]).toBeCloseTo(81, 10);
    expect(q[1]).toBeCloseTo(-324, 10);
    expect(q[2]).toBeCloseTo(486, 10);
    expect(q[3]).toBeCloseTo(-324, 10);
    expect(q[4]).toBeCloseTo(81, 10);
    const g4 = missFn(V(0, 0, 9), V(0, -18, -18), s4, 18);
    for (let i = 1; i <= 2000; i++) expect(g4(i / 1000) >= -1e-13).toBe(true); // never crosses
    const sol4 = solveGravityIntercept(V(0, 0, 0), V(0, 0, 9), V(0, -18, -18), s4, 18, 2);
    expect(sol4).not.toBeNull();
    if (sol4) {
      // |t − 1| is only defined up to (tolerance / 3.2)^(1/4) ≈ 4e-3 for a fourth-order contact
      expect(Math.abs(sol4.t - 1)).toBeLessThanOrEqual(5e-3);
      expect(sol4.residual).toBeLessThanOrEqual(ROOT_TOLERANCE);
      expectValidSolution(sol4, V(0, 0, 0), V(0, 0, 9), V(0, -18, -18), s4, 18, 2, ROOT_TOLERANCE);
    }

    // Stationary inflection (triple root): d·(v + G t* ŷ) = s and |v + G t* ŷ|² = s² − s t* G d_y with d_y < 0.
    const d = V(0, -0.6, 0.8);
    const n = Math.sqrt(100 * 1 * 18 * 0.6);
    const v = V(n, -60 - 18, 80);
    const r = vsub(vsub(vscale(d, 100), v), V(0, 9, 0));
    const g3 = missFn(r, v, 100, 18);
    expect(Math.abs(g3(1))).toBeLessThan(1e-11);
    expect(Math.abs(g3(1 + 1e-3)) + Math.abs(g3(1 - 1e-3))).toBeLessThan(1e-5); // flat to second order
    const brute = bruteSmallestRoot(g3, 2, 40000);
    const sol3 = solveGravityIntercept(MUZZLE, vadd(MUZZLE, r), v, 100, 18, 2);
    expect(brute.kind === 'cross' || brute.kind === 'touch').toBe(true);
    expect(sol3).not.toBeNull();
    if (sol3 && (brute.kind === 'cross' || brute.kind === 'touch')) {
      expect(Math.abs(sol3.t - brute.t)).toBeLessThanOrEqual(1e-3);
      expect(sol3.residual).toBeLessThanOrEqual(ROOT_TOLERANCE);
      expectValidSolution(sol3, MUZZLE, vadd(MUZZLE, r), v, 100, 18, 2, ROOT_TOLERANCE);
    }
  });

  it('handles random exact double-root constructions', () => {
    const rng = new Rng(424242);
    let checked = 0;
    for (let k = 0; k < 400; k++) {
      const T = rng.range(1, 3);
      const tS = rng.range(0.2, 0.9) * T;
      const d0 = randUnit(rng);
      const d = vnorm(V(d0.x, Math.abs(d0.y) * 0.8 + 0.2, d0.z));
      const s = rng.range(40, 160);
      const G = rng.range(5, 30);
      const along = s - G * tS * d.y;
      const v = vadd(vscale(d, along), vscale(vcross(d, randUnit(rng)), rng.range(0, 20)));
      const r = vsub(vsub(vscale(d, s * tS), vscale(v, tS)), V(0, 0.5 * G * tS * tS, 0));
      if (vlen(r) < 1) continue;
      const g = missFn(r, v, s, G);
      // keep only constructions whose contact is the first one on (0, T]
      let earlier = false;
      for (let i = 1; i < 4000 && !earlier; i++) if (g((tS * i) / 4000) < 1e-7 && i < 3990) earlier = true;
      if (earlier) continue;
      const m = V(rng.range(-20, 20), rng.range(0, 30), rng.range(-20, 20));
      const sol = solveGravityIntercept(m, vadd(m, r), v, s, G, T);
      expect(sol, `#${k}`).not.toBeNull();
      if (!sol) continue;
      expect(Math.abs(sol.t - tS), `#${k}`).toBeLessThanOrEqual(1e-4);
      expect(sol.residual, `#${k}`).toBeLessThanOrEqual(2e-9);
      expect(vlen(vsub(sol.dir, d)), `#${k}`).toBeLessThanOrEqual(1e-4);
      checked++;
    }
    report('random exact double roots checked', checked);
    expect(checked).toBeGreaterThan(200);
  });
});

// ───────────────────────────── life-time boundary ─────────────────────────────
describe('solveGravityIntercept — root on the maxTime boundary', () => {
  it('accepts a root exactly at t = maxTime (stationary target)', () => {
    // r = s T d − a T² with d = (0, 0.6, 0.8), T = 2: w(2) = (0, 120, 160), |w| = 200 = s·T exactly.
    const p = vadd(MUZZLE, V(0, 84, 160));
    const sol = solveGravityIntercept(MUZZLE, p, V(0, 0, 0), SPEED, GRAVITY, 2);
    expect(sol).not.toBeNull();
    if (!sol) return;
    expect(sol.t).toBe(2);
    expect(sol.dir.x).toBe(0);
    expect(sol.dir.y).toBeCloseTo(0.6, 14);
    expect(sol.dir.z).toBeCloseTo(0.8, 14);
    expect(sol.residual).toBeLessThanOrEqual(1e-12);
    expect(sol.intercept).toEqual(p);
    expect(sol.aimPoint.y - p.y).toBeCloseTo(36, 12);
    // closed form: 81 u² − 8488 u + 32656 = 0 → u = 4 is the smaller root
    expect((8488 - Math.sqrt(8488 * 8488 - 4 * 81 * 32656)) / 162).toBeCloseTo(4, 10);
  });

  it('accepts a root exactly at t = maxTime (moving target) and respects the limit on both sides', () => {
    // w(2) = r + 2 v + (0, 36, 0) = (0, 120, 160) with v = (3, −2, 5) → r = (−6, 88, 150)
    const v = V(3, -2, 5);
    const r = V(-6, 88, 150);
    const p = vadd(MUZZLE, r);
    expect(bruteSmallestRoot(missFn(r, v, SPEED, GRAVITY), 1.9999, 40000).kind).toBe('none');
    const sol = solveGravityIntercept(MUZZLE, p, v, SPEED, GRAVITY, 2);
    expect(sol).not.toBeNull();
    if (!sol) return;
    expect(sol.t).toBe(2);
    expect(sol.residual).toBeLessThanOrEqual(1e-12);
    expect(sol.intercept).toEqual(V(0, 104, 160)); // p + 2 v = (−6, 108, 150) + (6, −4, 10)
    // a shorter life must not be stretched
    expect(solveGravityIntercept(MUZZLE, p, v, SPEED, GRAVITY, 1.999999)).toBeNull();
    expect(solveGravityIntercept(MUZZLE, p, v, SPEED, GRAVITY, 1.99)).toBeNull();
    // a longer life finds the same root as an interior one
    const longer = solveGravityIntercept(MUZZLE, p, v, SPEED, GRAVITY, 2.000001);
    expect(longer).not.toBeNull();
    if (longer) expect(Math.abs(longer.t - 2)).toBeLessThanOrEqual(1e-12);
    const muchLonger = solveGravityIntercept(MUZZLE, p, v, SPEED, GRAVITY, 30);
    expect(muchLonger).not.toBeNull();
    if (muchLonger) expect(Math.abs(muchLonger.t - 2)).toBeLessThanOrEqual(1e-12);
  });

  it('random constructions with the first intercept exactly at maxTime', () => {
    const rng = new Rng(9001);
    let atBoundary = 0;
    let earlier = 0;
    for (let k = 0; k < 900; k++) {
      // machine-gun parameters, or a slow projectile whose steep (high-arc) solutions also fit into T
      const slow = k % 3 === 2;
      const s = slow ? rng.range(15, 40) : SPEED;
      const T = k % 3 === 0 ? 2 : rng.range(0.5, 4);
      const d = randUnit(rng);
      if (slow) d.y = Math.abs(d.y);
      const v = randVec(rng, 0, slow ? 5 : 40);
      // r = s T d − v T − a T²
      const r = vsub(vsub(vscale(d, s * T), vscale(v, T)), V(0, 0.5 * GRAVITY * T * T, 0));
      if (vlen(r) < 0.5) continue;
      const m = V(rng.range(-30, 30), rng.range(0, 30), rng.range(-30, 30));
      const p = vadd(m, r);
      const g = missFn(r, v, s, GRAVITY);
      const slope = Math.abs(g(T) - g(T - 1e-6)) / 1e-6;
      if (slope < 1e-2) continue; // (nearly) tangential at T: covered by the double-root tests
      const sol = solveGravityIntercept(m, p, v, s, GRAVITY, T);
      expect(sol, `#${k}`).not.toBeNull();
      if (!sol) continue;
      expectValidSolution(sol, m, p, v, s, GRAVITY, T, 1e-9);
      // reference: is there a root clearly before T? (stop where the miss is still ~1e-7 m ≫ tolerance)
      const before = bruteSmallestRoot(g, T - 1e-9 - 1e-7 / slope, 20000);
      if (before.kind === 'none') {
        expect(Math.abs(sol.t - T), `#${k}`).toBeLessThanOrEqual(1e-9 + 1e-10 / slope);
        expect(vlen(vsub(sol.dir, d)), `#${k}`).toBeLessThanOrEqual(1e-7);
        atBoundary++;
      } else {
        // T was the second root of this geometry: the earlier one must be returned
        expect(sol.t, `#${k}`).toBeLessThan(T);
        if (before.kind === 'cross' && !before.nearTangent) {
          expect(Math.abs(sol.t - before.t), `#${k}`).toBeLessThanOrEqual(1e-6);
        }
        earlier++;
      }
    }
    report('boundary constructions: root at maxTime', atBoundary, 'earlier root', earlier);
    expect(atBoundary).toBeGreaterThan(500);
    expect(earlier).toBeGreaterThan(20);
  });
});

// ───────────────────────────── no solution / degenerate / extreme ─────────────────────────────
describe('solveGravityIntercept — no solution, degenerate and extreme inputs', () => {
  it('returns null when the target cannot be reached within the bullet life', () => {
    // level reach in 2 s: √(200² − 36²) = 196.73 m
    expect(solveGravityIntercept(MUZZLE, vadd(MUZZLE, V(0, 0, 250)), V(0, 0, 0), SPEED, GRAVITY, LIFE)).toBeNull();
    expect(solveGravityIntercept(MUZZLE, vadd(MUZZLE, V(0, 0, 196.8)), V(0, 0, 0), SPEED, GRAVITY, LIFE)).toBeNull();
    const inside = solveGravityIntercept(MUZZLE, vadd(MUZZLE, V(0, 0, 196.7)), V(0, 0, 0), SPEED, GRAVITY, LIFE);
    expect(inside).not.toBeNull();
    if (inside) {
      expect(inside.t).toBeGreaterThan(1.99);
      expect(inside.t).toBeLessThanOrEqual(2);
    }
    // straight up: 100 t − 9 t² = 164 m at t = 2
    expect(solveGravityIntercept(MUZZLE, vadd(MUZZLE, V(0, 170, 0)), V(0, 0, 0), SPEED, GRAVITY, LIFE)).toBeNull();
    const up = solveGravityIntercept(MUZZLE, vadd(MUZZLE, V(0, 160, 0)), V(0, 0, 0), SPEED, GRAVITY, LIFE);
    expect(up).not.toBeNull();
    if (up) {
      expect(up.dir.y).toBeCloseTo(1, 12);
      // 9 t² − 100 t + 160 = 0
      expect(up.t).toBeCloseTo((100 - Math.sqrt(10000 - 4 * 9 * 160)) / 18, 12);
    }
    // the solution exists mathematically but only after the life time
    const late = aCase('A13');
    expect(solveGravityIntercept(MUZZLE, late.p, late.v, SPEED, GRAVITY, 1.2)).toBeNull();
    expect(solveGravityIntercept(MUZZLE, late.p, late.v, SPEED, GRAVITY, 1.26)).toBeNull();
    expect(solveGravityIntercept(MUZZLE, late.p, late.v, SPEED, GRAVITY, 1.27)).not.toBeNull();
  });

  it('returns null for a target receding at or above the bullet speed', () => {
    expect(solveGravityIntercept(MUZZLE, vadd(MUZZLE, V(0, 0, 50)), V(0, 0, 120), SPEED, GRAVITY, LIFE)).toBeNull();
    expect(solveGravityIntercept(MUZZLE, vadd(MUZZLE, V(0, 0, 50)), V(0, 0, 100), SPEED, GRAVITY, LIFE)).toBeNull();
    expect(solveGravityIntercept(MUZZLE, vadd(MUZZLE, V(30, 5, -40)), V(90, 20, -120), SPEED, GRAVITY, LIFE)).toBeNull();
    // even with an unlimited-looking life
    expect(solveGravityIntercept(MUZZLE, vadd(MUZZLE, V(0, 0, 50)), V(0, 0, 120), SPEED, GRAVITY, 1000)).toBeNull();
  });

  it('returns null for a degenerate geometry (muzzle on the target centre) without dividing by zero', () => {
    const vs = [V(0, 0, 0), V(8, 0, 0), V(-3, 4, 12), V(0, -50, 0)];
    for (const v of vs) {
      expect(solveGravityIntercept(MUZZLE, { ...MUZZLE }, v, SPEED, GRAVITY, LIFE)).toBeNull();
      expect(solveGravityIntercept(MUZZLE, vadd(MUZZLE, V(1e-9, 0, 0)), v, SPEED, GRAVITY, LIFE)).toBeNull();
      expect(solveGravityIntercept(MUZZLE, vadd(MUZZLE, V(0, -5e-7, 5e-7)), v, SPEED, GRAVITY, LIFE)).toBeNull();
    }
    expect(DEGENERATE_RANGE).toBe(1e-6);
    // just outside the degenerate ball the solution is regular again
    for (const r of [V(0, 0, 1e-3), V(1e-4, -1e-4, 0), V(0, 2e-6, 0), V(0, 0.5, 0)]) {
      const p = vadd(V(0, 0, 0), r);
      const sol = solveGravityIntercept(V(0, 0, 0), p, V(5, 1, -3), SPEED, GRAVITY, LIFE);
      expect(sol).not.toBeNull();
      if (!sol) continue;
      expectValidSolution(sol, V(0, 0, 0), p, V(5, 1, -3), SPEED, GRAVITY, LIFE, 1e-9);
      expect(sol.t).toBeLessThan((vlen(r) / SPEED) * 1.2);
    }
  });

  it('rejects invalid scalar parameters and non-finite vectors', () => {
    const p = vadd(MUZZLE, V(0, 0, 100));
    const z = V(0, 0, 0);
    expect(solveGravityIntercept(MUZZLE, p, z, 0, GRAVITY, LIFE)).toBeNull();
    expect(solveGravityIntercept(MUZZLE, p, z, -100, GRAVITY, LIFE)).toBeNull();
    expect(solveGravityIntercept(MUZZLE, p, z, NaN, GRAVITY, LIFE)).toBeNull();
    expect(solveGravityIntercept(MUZZLE, p, z, Infinity, GRAVITY, LIFE)).toBeNull();
    expect(solveGravityIntercept(MUZZLE, p, z, SPEED, NaN, LIFE)).toBeNull();
    expect(solveGravityIntercept(MUZZLE, p, z, SPEED, Infinity, LIFE)).toBeNull();
    expect(solveGravityIntercept(MUZZLE, p, z, SPEED, GRAVITY, 0)).toBeNull();
    expect(solveGravityIntercept(MUZZLE, p, z, SPEED, GRAVITY, -1)).toBeNull();
    expect(solveGravityIntercept(MUZZLE, p, z, SPEED, GRAVITY, NaN)).toBeNull();
    expect(solveGravityIntercept(MUZZLE, p, z, SPEED, GRAVITY, Infinity)).toBeNull();
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(solveGravityIntercept(V(bad, 20, 0), p, z, SPEED, GRAVITY, LIFE)).toBeNull();
      expect(solveGravityIntercept(MUZZLE, V(0, bad, 100), z, SPEED, GRAVITY, LIFE)).toBeNull();
      expect(solveGravityIntercept(MUZZLE, p, V(0, 0, bad), SPEED, GRAVITY, LIFE)).toBeNull();
    }
    // gravity 0 is legal: a straight shot
    const straight = solveGravityIntercept(MUZZLE, p, z, SPEED, 0, LIFE);
    expect(straight).not.toBeNull();
    if (straight) {
      expect(straight.t).toBeCloseTo(1, 14);
      expect(straight.dir).toEqual(V(0, 0, 1));
      expect(straight.aimPoint).toEqual(straight.intercept);
    }
  });

  it('never produces NaN/Infinity for huge velocities and coordinates', () => {
    const p = vadd(MUZZLE, V(0, 0, 100));
    const huge = [
      V(1e6, -2e6, 3e6),
      V(0, 0, 1e9),
      V(0, 0, -1e9),
      V(1e12, 1e12, 1e12),
      V(0, 1e155, 0),
      V(1e200, 0, 0),
      V(-1e308, 1e308, 1e308),
      V(Number.MAX_VALUE, 0, 0),
    ];
    for (const v of huge) {
      const sol = solveGravityIntercept(MUZZLE, p, v, SPEED, GRAVITY, LIFE);
      if (sol) {
        expect(allFinite(sol.t, sol.dir, sol.intercept, sol.aimPoint, sol.residual)).toBe(true);
        expect(sol.residual).toBeLessThanOrEqual(INTERCEPT_RESIDUAL_LIMIT);
        expect(sol.t).toBeGreaterThan(0);
        expect(sol.t).toBeLessThanOrEqual(LIFE);
      }
    }
    expect(solveGravityIntercept(MUZZLE, p, V(1e6, -2e6, 3e6), SPEED, GRAVITY, LIFE)).toBeNull();
    expect(solveGravityIntercept(MUZZLE, p, V(1e200, 0, 0), SPEED, GRAVITY, LIFE)).toBeNull();
    expect(solveGravityIntercept(MUZZLE, V(1e200, 0, 0), V(0, 0, 0), SPEED, GRAVITY, LIFE)).toBeNull();
    expect(solveGravityIntercept(V(1e300, 0, 0), V(-1e300, 0, 0), V(0, 0, 0), SPEED, GRAVITY, LIFE)).toBeNull();

    // a target rushing at the muzzle at 99.9 km/s from 100 km away: intercept after ~1 s, far away
    const far = solveGravityIntercept(V(0, 0, 0), V(0, 0, 1e5), V(0, 0, -99900), SPEED, GRAVITY, LIFE);
    expect(far).not.toBeNull();
    if (far) {
      expectValidSolution(far, V(0, 0, 0), V(0, 0, 1e5), V(0, 0, -99900), SPEED, GRAVITY, LIFE, 1e-6);
      expect(far.t).toBeGreaterThan(0.99);
      expect(far.t).toBeLessThan(1.01);
    }
  });

  it('constructed intercepts with very fast targets are found (or an earlier valid one)', () => {
    const rng = new Rng(31337);
    let solved = 0;
    let maxResidual = 0;
    for (let k = 0; k < 2000; k++) {
      const t0 = rng.range(0.01, 1.99);
      const d = randUnit(rng);
      const v = randVec(rng, 1e3, 10 ** rng.range(3, 7));
      const r = vsub(vsub(vscale(d, SPEED * t0), vscale(v, t0)), V(0, 0.5 * GRAVITY * t0 * t0, 0));
      const m = V(rng.range(-10, 10), rng.range(0, 30), rng.range(-10, 10));
      const p = vadd(m, r);
      const sol = solveGravityIntercept(m, p, v, SPEED, GRAVITY, LIFE);
      // a root at t0 exists by construction (up to the rounding of p, ≲ 1e-9 m at these magnitudes)
      expect(sol, `#${k}`).not.toBeNull();
      if (!sol) continue;
      expect(allFinite(sol.t, sol.dir, sol.intercept, sol.aimPoint, sol.residual), `#${k}`).toBe(true);
      expect(sol.t, `#${k}`).toBeGreaterThan(0);
      expect(sol.t, `#${k}`).toBeLessThanOrEqual(t0 * (1 + 1e-9));
      expect(sol.residual, `#${k}`).toBeLessThanOrEqual(INTERCEPT_RESIDUAL_LIMIT);
      expect(Math.abs(vlen(vscale(sol.dir, SPEED)) - SPEED), `#${k}`).toBeLessThanOrEqual(1e-9);
      maxResidual = Math.max(maxResidual, sol.residual);
      solved++;
    }
    report('fast-target constructions solved', solved, 'max residual', maxResidual);
    expect(maxResidual).toBeLessThanOrEqual(1e-6);
  });
});

// ───────────────────────────── helpers exported by the module ─────────────────────────────
describe('ballistics helpers', () => {
  it('gravityInterceptMiss is the signed miss distance and vanishes at the solution', () => {
    for (const c of A_CASES) {
      const p = vadd(MUZZLE, c.r);
      const sol = solveA(c.id);
      expect(Math.abs(gravityInterceptMiss(MUZZLE, p, c.v, SPEED, GRAVITY, sol.t)), c.id).toBeLessThanOrEqual(1e-12);
      expect(gravityInterceptMiss(MUZZLE, p, c.v, SPEED, GRAVITY, 0), c.id).toBeCloseTo(vlen(c.r), 12);
      expect(gravityInterceptMiss(MUZZLE, p, c.v, SPEED, GRAVITY, sol.t * 0.5), c.id).toBeGreaterThan(0);
      const tq = sol.t * 0.7;
      expect(gravityInterceptMiss(MUZZLE, p, c.v, SPEED, GRAVITY, tq), c.id).toBeCloseTo(missFn(c.r, c.v, SPEED, GRAVITY)(tq), 10);
    }
  });

  it('gravityInterceptQuartic matches |r + v t − 0.5 g t²|² − s² t²', () => {
    const rng = new Rng(5);
    for (let k = 0; k < 200; k++) {
      const c = makeConfig(rng, 3);
      const q = gravityInterceptQuartic(c.m, c.p, c.v, c.s, c.G);
      const t = rng.range(0, c.T);
      const w = V(c.r.x + c.v.x * t, c.r.y + c.v.y * t + 0.5 * c.G * t * t, c.r.z + c.v.z * t);
      const direct = vdot(w, w) - c.s * c.s * t * t;
      const poly = q[0] + q[1] * t + q[2] * t * t + q[3] * t ** 3 + q[4] * t ** 4;
      const magnitude = vdot(w, w) + c.s * c.s * t * t + Math.abs(q[0]) + Math.abs(q[2]) * t * t + Math.abs(q[4]) * t ** 4;
      expect(Math.abs(direct - poly)).toBeLessThanOrEqual(1e-9 * magnitude);
    }
    expect(gravityInterceptQuartic(MUZZLE, vadd(MUZZLE, V(0, 0, 100)), V(0, 0, 0), 100, 18)).toEqual([10000, 0, -10000, 0, 81]);
  });

  it('ballisticPosition follows m + v0 a + 0.5 g a² and reaches the predicted intercept', () => {
    const out = V(0, 0, 0);
    expect(ballisticPosition(V(1, 2, 3), V(10, 20, -30), 18, 0, out)).toEqual(V(1, 2, 3));
    expect(ballisticPosition(V(1, 2, 3), V(10, 20, -30), 18, 2, out)).toEqual(V(21, 2 + 40 - 36, -57));
    for (const c of A_CASES) {
      const sol = solveA(c.id);
      const v0 = vscale(sol.dir, SPEED);
      const pos = ballisticPosition(MUZZLE, v0, GRAVITY, sol.t, V(0, 0, 0));
      expect(vlen(vsub(pos, sol.intercept)), c.id).toBeLessThanOrEqual(1e-9);
    }
    // aliasing out === origin
    const o = V(5, 5, 5);
    ballisticPosition(o, V(1, 0, 0), 18, 1, o);
    expect(o).toEqual(V(6, -4, 5));
  });

  it('raySphere returns the entry distance, 0 inside, −1 for misses and beyond maxDist', () => {
    const c = V(0, 0, 10);
    expect(raySphere(V(0, 0, 0), V(0, 0, 1), c, 2, 100)).toBeCloseTo(8, 14);
    expect(raySphere(V(0, 0, 0), V(0, 0, 5), c, 2, 100)).toBeCloseTo(8, 14); // non-unit direction → metres
    expect(raySphere(V(0, 0, 0), V(0, 0, 1), c, 2, 7.9)).toBe(-1);
    expect(raySphere(V(0, 0, 0), V(0, 0, 1), c, 2, 8)).toBeCloseTo(8, 14);
    expect(raySphere(V(0, 0, 0), V(0, 0, -1), c, 2, 100)).toBe(-1); // behind
    expect(raySphere(V(0, 0, 9), V(1, 0, 0), c, 2, 100)).toBe(0); // inside
    expect(raySphere(V(0, 0, 8), V(1, 0, 0), c, 2, 100)).toBe(0); // on the surface
    expect(raySphere(V(0, 2, 0), V(0, 0, 1), c, 2, 100)).toBeCloseTo(10, 12); // tangent
    expect(raySphere(V(0, 2.0001, 0), V(0, 0, 1), c, 2, 100)).toBe(-1);
    expect(raySphere(V(0, 0, 0), V(0, 0, 0), c, 2, 100)).toBe(-1); // zero direction
    expect(raySphere(V(0, 0, 0), V(0, 0, 1), c, -1, 100)).toBe(-1);
    expect(raySphere(V(0, 0, 0), V(0, 0, 1), c, NaN, 100)).toBe(-1);
    // consistency with the swept test along the same segment
    const rng = new Rng(11);
    for (let k = 0; k < 2000; k++) {
      const o = randVec(rng, 0, 20);
      const dir = randUnit(rng);
      const centre = randVec(rng, 0, 20);
      const radius = rng.range(0.2, 6);
      const maxDist = rng.range(1, 60);
      const dist = raySphere(o, dir, centre, radius, maxDist);
      const u = sweepPointSphere(o, vadd(o, vscale(dir, maxDist)), centre, centre, radius);
      if (dist < 0) expect(u).toBe(-1);
      else expect(Math.abs(u * maxDist - dist)).toBeLessThanOrEqual(1e-9);
    }
  });
});

// ───────────────────────────── linear intercept ─────────────────────────────
describe('solveLinearIntercept', () => {
  const MS = 45; // missile speed
  const ML = 4; // missile life

  it('missile lead for A05/A06/A07 (§4.4)', () => {
    // A05: (64 − 2025) t² + 10000 = 0
    const a05 = aCase('A05');
    const s5 = solveLinearIntercept(MUZZLE, a05.p, a05.v, MS, ML);
    expect(s5).not.toBeNull();
    if (s5) {
      const t = Math.sqrt(10000 / (2025 - 64));
      expect(s5.t).toBeCloseTo(t, 13);
      expect(s5.intercept).toEqual(V(8 * s5.t, 20, 100));
      const d = vnorm(V(8 * t, 0, 100));
      expect(vlen(vsub(s5.dir, d))).toBeLessThanOrEqual(1e-14);
      expect(vlen(s5.dir)).toBeCloseTo(1, 14);
      // the missile flying straight along dir at 45 m/s is at the intercept at time t
      expect(vlen(vsub(vadd(MUZZLE, vscale(s5.dir, MS * s5.t)), s5.intercept))).toBeLessThanOrEqual(1e-12);
    }
    const a06 = aCase('A06');
    const s6 = solveLinearIntercept(MUZZLE, a06.p, a06.v, MS, ML);
    expect(s6).not.toBeNull();
    if (s6 && s5) {
      expect(s6.t).toBe(s5.t);
      expect(s6.dir.x).toBe(-s5.dir.x);
    }
    // A07: receding at 8 m/s along the line of sight → closing speed 37 m/s
    const a07 = aCase('A07');
    const s7 = solveLinearIntercept(MUZZLE, a07.p, a07.v, MS, ML);
    expect(s7).not.toBeNull();
    if (s7) {
      expect(s7.t).toBeCloseTo(100 / 37, 13);
      expect(s7.dir).toEqual(V(0, 0, 1));
      expect(s7.intercept.z).toBeCloseTo(100 + 800 / 37, 12);
    }
    // A08: closing at 8 m/s → 100 / 53
    const a08 = aCase('A08');
    const s8 = solveLinearIntercept(MUZZLE, a08.p, a08.v, MS, ML);
    expect(s8?.t).toBeCloseTo(100 / 53, 13);
  });

  it('stationary target: t = |r| / s, direction straight at it', () => {
    const sol = solveLinearIntercept(V(1, 2, 3), V(1, 2, 3 + 90), V(0, 0, 0), MS, ML);
    expect(sol).not.toBeNull();
    if (sol) {
      expect(sol.t).toBeCloseTo(2, 14);
      expect(sol.dir).toEqual(V(0, 0, 1));
      expect(sol.intercept).toEqual(V(1, 2, 93));
    }
  });

  it('degenerate |v| = s: the quadratic term vanishes and the linear equation is solved', () => {
    // closing head-on at exactly the missile speed: 2 (r·v) t + r·r = 0 → t = 90 / 90
    const headOn = solveLinearIntercept(V(0, 0, 0), V(0, 0, 90), V(0, 0, -45), MS, ML);
    expect(headOn).not.toBeNull();
    if (headOn) {
      expect(headOn.t).toBe(1);
      expect(headOn.dir).toEqual(V(0, 0, 1));
      expect(headOn.intercept).toEqual(V(0, 0, 45));
    }
    // oblique, |v| = √(27² + 36²) = 45 exactly: t = −r·r / (2 r·v)
    const r = V(-60, -20, 30);
    const v = V(27, 36, 0);
    const oblique = solveLinearIntercept(V(0, 0, 0), r, v, MS, ML);
    const tExpected = -vdot(r, r) / (2 * vdot(r, v));
    expect(tExpected).toBeGreaterThan(0);
    expect(tExpected).toBeLessThan(ML);
    expect(oblique).not.toBeNull();
    if (oblique) {
      expect(oblique.t).toBeCloseTo(tExpected, 13);
      expect(Math.abs(vlen(vadd(r, vscale(v, oblique.t))) - MS * oblique.t)).toBeLessThanOrEqual(1e-12);
      expect(vlen(oblique.dir)).toBeCloseTo(1, 14);
    }
    // receding or crossing at exactly the missile speed: never caught
    expect(solveLinearIntercept(V(0, 0, 0), V(0, 0, 90), V(0, 0, 45), MS, ML)).toBeNull();
    expect(solveLinearIntercept(V(0, 0, 0), V(0, 0, 90), V(45, 0, 0), MS, ML)).toBeNull();
    // |v| equal to s only up to rounding (0.1 + 0.2 style): still handled, same answer as the exact limit
    const s = Math.hypot(0.1, 0.2, 0.3) * 150;
    const nearly = solveLinearIntercept(V(0, 0, 0), V(-30, -55, -80), V(15, 30, 45), s, 10);
    expect(nearly).not.toBeNull();
    if (nearly) {
      const rr = V(-30, -55, -80);
      const vv = V(15, 30, 45);
      expect(nearly.t).toBeCloseTo(-vdot(rr, rr) / (2 * vdot(rr, vv)), 9);
    }
  });

  it('applies the maxTime cut-off (root exactly at the limit is accepted)', () => {
    // closing speed 40 m/s over 100 m → t = 2.5 exactly
    const p = V(0, 0, 100);
    const v = V(0, 0, 5);
    const at = solveLinearIntercept(V(0, 0, 0), p, v, MS, 2.5);
    expect(at).not.toBeNull();
    if (at) expect(at.t).toBe(2.5);
    expect(solveLinearIntercept(V(0, 0, 0), p, v, MS, 2.499999)).toBeNull();
    expect(solveLinearIntercept(V(0, 0, 0), p, v, MS, 2.4)).toBeNull();
    expect(solveLinearIntercept(V(0, 0, 0), p, v, MS, 2.6)?.t).toBe(2.5);
    expect(solveLinearIntercept(V(0, 0, 0), p, v, MS, Infinity)?.t).toBe(2.5);
    // A07 needs 2.7027 s: fine for a fresh missile (4 s), not with 2.5 s of life left
    const a07 = aCase('A07');
    expect(solveLinearIntercept(MUZZLE, a07.p, a07.v, MS, 4)).not.toBeNull();
    expect(solveLinearIntercept(MUZZLE, a07.p, a07.v, MS, 2.5)).toBeNull();
    // enemy lead cap 1.2 s at 70 m/s: 84 m is the limit for a static player
    expect(solveLinearIntercept(V(0, 0, 0), V(0, 0, 84), V(0, 0, 0), 70, 1.2)?.t).toBeCloseTo(1.2, 12);
    expect(solveLinearIntercept(V(0, 0, 0), V(0, 0, 84.1), V(0, 0, 0), 70, 1.2)).toBeNull();
  });

  it('returns null when no positive root exists and for degenerate / invalid input', () => {
    // faster target running away
    expect(solveLinearIntercept(V(0, 0, 0), V(0, 0, 50), V(0, 0, 60), MS, ML)).toBeNull();
    // faster target passing by too far to be cut off (negative discriminant)
    expect(solveLinearIntercept(V(0, 0, 0), V(100, 0, 100), V(0, 0, -200), MS, 100)).toBeNull();
    // faster target heading (almost) at the launcher: two positive roots, the smaller is used
    const two = solveLinearIntercept(V(0, 0, 0), V(0, 0, 100), V(0, 0, -200), MS, ML);
    expect(two?.t).toBeCloseTo(100 / 245, 13);
    // degenerate range
    expect(solveLinearIntercept(V(1, 2, 3), V(1, 2, 3), V(5, 0, 0), MS, ML)).toBeNull();
    expect(solveLinearIntercept(V(1, 2, 3), V(1, 2, 3 + 1e-9), V(5, 0, 0), MS, ML)).toBeNull();
    // invalid parameters
    const p = V(0, 0, 50);
    const z = V(0, 0, 0);
    expect(solveLinearIntercept(z, p, z, 0, ML)).toBeNull();
    expect(solveLinearIntercept(z, p, z, -5, ML)).toBeNull();
    expect(solveLinearIntercept(z, p, z, NaN, ML)).toBeNull();
    expect(solveLinearIntercept(z, p, z, Infinity, ML)).toBeNull();
    expect(solveLinearIntercept(z, p, z, MS, 0)).toBeNull();
    expect(solveLinearIntercept(z, p, z, MS, -1)).toBeNull();
    expect(solveLinearIntercept(z, p, z, MS, NaN)).toBeNull();
    expect(solveLinearIntercept(z, V(NaN, 0, 50), z, MS, ML)).toBeNull();
    expect(solveLinearIntercept(z, p, V(0, Infinity, 0), MS, ML)).toBeNull();
    expect(solveLinearIntercept(z, p, V(1e200, 0, 0), MS, ML)).toBeNull();
    expect(solveLinearIntercept(V(1e200, 0, 0), p, z, MS, ML)).toBeNull();
  });

  it('touching double root of a faster target (discriminant = 0) is found', () => {
    // target speed 75 > 45; it passes at the one geometry where interception is just possible:
    // sin(angle between −r and v) = s / |v| = 0.6 → v = 75·(0.6, 0, −0.8) for r = (0, 0, 100)
    const r = V(0, 0, 100);
    const v = V(45, 0, -60);
    const A = vdot(v, v) - MS * MS;
    const B = 2 * vdot(r, v);
    const C = vdot(r, r);
    expect(B * B - 4 * A * C).toBe(0);
    const sol = solveLinearIntercept(V(0, 0, 0), r, v, MS, ML);
    expect(sol).not.toBeNull();
    if (sol) {
      expect(sol.t).toBeCloseTo(-B / (2 * A), 12);
      expect(Math.abs(vlen(vadd(r, vscale(v, sol.t))) - MS * sol.t)).toBeLessThanOrEqual(1e-9);
    }
    // a slightly wider pass cannot be intercepted any more
    expect(solveLinearIntercept(V(0, 0, 0), r, V(45.01, 0, -60), MS, ML)).toBeNull();
  });

  it('matches brute force and the gravity solver with g = 0 on random configurations', () => {
    const rng = new Rng(0x11ea2);
    const stats = { solved: 0, none: 0, maxMiss: 0, maxDt: 0, skipped: 0 };
    for (let k = 0; k < 6000; k++) {
      const s = k % 2 === 0 ? 45 : rng.range(20, 120);
      const T = k % 2 === 0 ? 4 : rng.range(0.3, 8);
      const m = V(rng.range(-40, 40), rng.range(0, 30), rng.range(-40, 40));
      const r = randVec(rng, 1, 250);
      const v = randVec(rng, 0, k % 3 === 0 ? 150 : 40);
      const p = vadd(m, r);
      const g = missFn(vsub(p, m), v, s, 0);
      const brute = bruteSmallestRoot(g, T, 8000);
      const sol = solveLinearIntercept(m, p, v, s, T);
      const viaQuartic = solveGravityIntercept(m, p, v, s, 0, T);
      if (brute.kind === 'ambiguous' || brute.kind === 'touch' || (brute.kind === 'cross' && brute.nearTangent)) {
        stats.skipped++;
        continue;
      }
      if (brute.kind === 'none') {
        expect(sol, `#${k}`).toBeNull();
        expect(viaQuartic, `#${k}`).toBeNull();
        stats.none++;
        continue;
      }
      expect(sol, `#${k}`).not.toBeNull();
      expect(viaQuartic, `#${k}`).not.toBeNull();
      if (!sol || !viaQuartic) continue;
      expect(sol.t, `#${k}`).toBeGreaterThan(0);
      expect(sol.t, `#${k}`).toBeLessThanOrEqual(T);
      expect(Math.abs(sol.t - brute.t), `#${k}`).toBeLessThanOrEqual(1e-9 * Math.max(1, brute.t));
      expect(Math.abs(sol.t - viaQuartic.t), `#${k}`).toBeLessThanOrEqual(1e-9 * Math.max(1, brute.t));
      expect(vlen(vsub(sol.dir, viaQuartic.dir)), `#${k}`).toBeLessThanOrEqual(1e-9);
      expect(Math.abs(vlen(sol.dir) - 1), `#${k}`).toBeLessThanOrEqual(1e-14);
      const target = vadd(p, vscale(v, sol.t));
      expect(vlen(vsub(sol.intercept, target)), `#${k}`).toBeLessThanOrEqual(1e-10);
      const miss = vlen(vsub(vadd(m, vscale(sol.dir, s * sol.t)), target));
      expect(miss, `#${k}`).toBeLessThanOrEqual(1e-9);
      stats.maxMiss = Math.max(stats.maxMiss, miss);
      stats.maxDt = Math.max(stats.maxDt, Math.abs(sol.t - brute.t));
      stats.solved++;
    }
    report('linear property test', JSON.stringify(stats));
    expect(stats.solved).toBeGreaterThan(1500);
    expect(stats.none).toBeGreaterThan(1500);
    expect(stats.skipped).toBeLessThan(20);
  });
});

// ───────────────────────────── rotateTowards ─────────────────────────────
describe('rotateTowards', () => {
  const DEG = Math.PI / 180;

  it('snaps to the desired direction when it is within the limit', () => {
    const c = vnorm(V(0, 0, -1));
    const d = vnorm(V(0.1, 0.05, -1));
    const out = rotateTowards(c, d, 10 * DEG, V(0, 0, 0));
    expect(out).toEqual(d);
    // exactly at the limit
    const e = V(Math.sin(0.25), 0, -Math.cos(0.25));
    expect(vlen(vsub(rotateTowards(c, e, 0.25 + 1e-12, V(0, 0, 0)), e))).toBeLessThanOrEqual(1e-15);
    // infinite budget
    expect(rotateTowards(c, V(0, 1, 0), Infinity, V(0, 0, 0))).toEqual(V(0, 1, 0));
  });

  it('turns by exactly maxAngle in the plane of both vectors when the target is further away', () => {
    const c = V(0, 0, -1);
    const d = V(1, 0, 0);
    const out = rotateTowards(c, d, 30 * DEG, V(0, 0, 0));
    expect(out.x).toBeCloseTo(0.5, 14);
    expect(out.y).toBeCloseTo(0, 14);
    expect(out.z).toBeCloseTo(-Math.cos(30 * DEG), 14);
    const rng = new Rng(99);
    let maxAngleError = 0;
    for (let k = 0; k < 5000; k++) {
      const a = randUnit(rng);
      const b = randUnit(rng);
      const limit = rng.range(0, Math.PI);
      const theta = angleBetween(a, b);
      const o = rotateTowards(a, b, limit, V(0, 0, 0));
      expect(Math.abs(vlen(o) - 1)).toBeLessThanOrEqual(1e-14);
      const turned = angleBetween(a, o);
      const expected = Math.min(limit, theta);
      expect(Math.abs(turned - expected)).toBeLessThanOrEqual(1e-9);
      expect(turned).toBeLessThanOrEqual(limit + 1e-12);
      // the remaining angle shrinks by exactly the amount turned (same great circle)
      expect(Math.abs(angleBetween(o, b) - (theta - expected))).toBeLessThanOrEqual(1e-9);
      // coplanar with a and b
      const n = vcross(a, b);
      if (vlen(n) > 1e-6) expect(Math.abs(vdot(o, vnorm(n)))).toBeLessThanOrEqual(1e-9);
      maxAngleError = Math.max(maxAngleError, Math.abs(turned - expected));
    }
    report('rotateTowards max angle error (rad)', maxAngleError);
  });

  it('does not rotate for maxAngle <= 0 or NaN, and normalises its output', () => {
    const c = V(0, 3, 4);
    const d = V(1, 0, 0);
    expect(rotateTowards(c, d, 0, V(9, 9, 9))).toEqual(V(0, 0.6, 0.8));
    expect(rotateTowards(c, d, -1, V(9, 9, 9))).toEqual(V(0, 0.6, 0.8));
    expect(rotateTowards(c, d, NaN, V(9, 9, 9))).toEqual(V(0, 0.6, 0.8));
    // non-unit inputs are accepted
    const out = rotateTowards(V(0, 0, -7), V(250, 0, 0), 45 * DEG, V(0, 0, 0));
    expect(out.x).toBeCloseTo(Math.SQRT1_2, 14);
    expect(out.z).toBeCloseTo(-Math.SQRT1_2, 14);
  });

  it('handles parallel inputs', () => {
    const c = vnorm(V(1, 2, 3));
    expect(rotateTowards(c, { ...c }, 0.1, V(0, 0, 0))).toEqual(c);
    expect(vlen(vsub(rotateTowards(c, vscale(c, 5), 1e-9, V(0, 0, 0)), c))).toBeLessThanOrEqual(1e-15);
    expect(vlen(vsub(rotateTowards(c, vscale(c, 1e-6), 1e-9, V(0, 0, 0)), c))).toBeLessThanOrEqual(1e-15);
    // nearly parallel with a smaller budget than the angle: still a clean limited turn
    const d = vnorm(V(1 + 1e-7, 2, 3));
    const theta = angleBetween(c, d);
    const o = rotateTowards(c, d, theta / 2, V(0, 0, 0));
    expect(allFinite(o)).toBe(true);
    expect(Math.abs(vlen(o) - 1)).toBeLessThanOrEqual(1e-14);
    expect(angleBetween(c, o)).toBeLessThanOrEqual(theta);
  });

  it('handles anti-parallel inputs deterministically', () => {
    const limit = 20 * DEG;
    // horizontal heading: turns about the world up axis
    const c = V(0, 0, -1);
    const o1 = rotateTowards(c, V(0, 0, 1), limit, V(0, 0, 0));
    const o2 = rotateTowards(c, V(0, 0, 1), limit, V(0, 0, 0));
    expect(o1).toEqual(o2);
    expect(o1.y).toBe(0);
    expect(angleBetween(c, o1)).toBeCloseTo(limit, 12);
    expect(Math.abs(vlen(o1) - 1)).toBeLessThanOrEqual(1e-15);
    expect(o1.x).toBeCloseTo(-Math.sin(limit), 14); // towards (c.z, 0, −c.x) = (−1, 0, 0)
    // vertical heading: turns about +X
    const up = V(0, 1, 0);
    const o3 = rotateTowards(up, V(0, -1, 0), limit, V(0, 0, 0));
    expect(allFinite(o3)).toBe(true);
    expect(o3.x).toBe(0);
    expect(angleBetween(up, o3)).toBeCloseTo(limit, 12);
    // random anti-parallel pairs: a full reversal takes exactly π / limit steps and never produces NaN
    const rng = new Rng(4);
    for (let k = 0; k < 500; k++) {
      const a = randUnit(rng);
      const b = vscale(a, -1);
      const o = rotateTowards(a, b, limit, V(0, 0, 0));
      expect(allFinite(o)).toBe(true);
      expect(Math.abs(vlen(o) - 1)).toBeLessThanOrEqual(1e-14);
      expect(Math.abs(angleBetween(a, o) - limit)).toBeLessThanOrEqual(1e-9);
      const heading = { ...a };
      let steps = 0;
      while (angleBetween(heading, b) > 1e-12 && steps < 100) {
        rotateTowards(heading, b, limit, heading);
        steps++;
      }
      expect(steps).toBe(9); // 180° / 20°
      expect(vlen(vsub(heading, b))).toBeLessThanOrEqual(1e-9);
    }
  });

  it('supports aliasing and missile-style stepping at 120°/s', () => {
    const heading = V(0, 0, -1);
    const desired = vnorm(V(1, 0.2, 0.3));
    const total = angleBetween(heading, desired);
    const rate = 120 * DEG;
    const h = 1 / 120;
    let steps = 0;
    let prev = { ...heading };
    while (angleBetween(heading, desired) > 1e-12 && steps < 1000) {
      const res = rotateTowards(heading, desired, rate * h, heading); // out aliases current
      expect(res).toBe(heading);
      expect(angleBetween(prev, heading)).toBeLessThanOrEqual(rate * h + 1e-12);
      prev = { ...heading };
      steps++;
    }
    expect(steps).toBe(Math.ceil(total / (rate * h) - 1e-9));
    expect(vlen(vsub(heading, desired))).toBeLessThanOrEqual(1e-12);
    // out aliases desired
    const d2 = V(1, 0, 0);
    rotateTowards(V(0, 0, -1), d2, 30 * DEG, d2);
    expect(d2.x).toBeCloseTo(0.5, 14);
    expect(d2.z).toBeCloseTo(-Math.cos(30 * DEG), 14);
  });

  it('never returns NaN for unusable inputs', () => {
    expect(rotateTowards(V(0, 0, 0), V(0, 2, 0), 0.1, V(7, 7, 7))).toEqual(V(0, 1, 0));
    expect(rotateTowards(V(0, 0, -2), V(0, 0, 0), 0.1, V(7, 7, 7))).toEqual(V(0, 0, -1));
    expect(rotateTowards(V(0, 0, 0), V(0, 0, 0), 0.1, V(7, 7, 7))).toEqual(V(0, 0, 0));
    expect(rotateTowards(V(NaN, 0, 0), V(0, 0, 1), 0.1, V(7, 7, 7))).toEqual(V(0, 0, 1));
    expect(rotateTowards(V(0, 0, 1), V(NaN, 0, 0), 0.1, V(7, 7, 7))).toEqual(V(0, 0, 1));
    expect(allFinite(rotateTowards(V(Infinity, 0, 0), V(NaN, 0, 0), 0.1, V(7, 7, 7)))).toBe(true);
  });
});

// ───────────────────────────── swept tests ─────────────────────────────
/** Exact, independent hit criterion: closest approach of the relative segment to the origin. */
function closestApproach(q0: V3, dq: V3): number {
  const a = vdot(dq, dq);
  const u = a > 0 ? Math.min(1, Math.max(0, -vdot(q0, dq) / a)) : 0;
  return vlen(vadd(q0, vscale(dq, u)));
}

describe('sweepPointSphere', () => {
  it('hand-checked cases', () => {
    const O = V(0, 0, 0);
    // straight through a static sphere
    expect(sweepPointSphere(V(-5, 0, 0), V(5, 0, 0), O, O, 1)).toBeCloseTo(0.4, 15);
    // too short
    expect(sweepPointSphere(V(-5, 0, 0), V(-2, 0, 0), O, O, 1)).toBe(-1);
    // ends exactly on the surface
    expect(sweepPointSphere(V(-5, 0, 0), V(-1, 0, 0), O, O, 1)).toBe(1);
    // moving away
    expect(sweepPointSphere(V(2, 0, 0), V(9, 0, 0), O, O, 1)).toBe(-1);
    // start inside / on the surface → 0
    expect(sweepPointSphere(V(0.2, 0.1, 0), V(9, 0, 0), O, O, 1)).toBe(0);
    expect(sweepPointSphere(V(1, 0, 0), V(9, 0, 0), O, O, 1)).toBe(0);
    expect(sweepPointSphere(V(0.2, 0.1, 0), V(0.2, 0.1, 0), O, O, 1)).toBe(0);
    // exact tangency (representable): the path y = 1 touches the unit sphere at x = 0
    expect(sweepPointSphere(V(-2, 1, 0), V(2, 1, 0), O, O, 1)).toBe(0.5);
    // sphere moving onto a resting point
    expect(sweepPointSphere(V(0, 0, 0), V(0, 0, 0), V(10, 0, 0), V(0, 0, 0), 2)).toBeCloseTo(0.8, 15);
    // both moving head-on at high speed: relative path 200 m, entry when |x| = √(0.5² − 0.3²) = 0.4
    const u = sweepPointSphere(V(-50, 0, 0), V(50, 0, 0), V(50, 0, 0.3), V(-50, 0, 0.3), 0.5);
    expect(u).toBeCloseTo((100 - 0.4) / 200, 14);
    // …while neither end position of the bullet is inside the sphere at its end position
    expect(vlen(vsub(V(50, 0, 0), V(-50, 0, 0.3)))).toBeGreaterThan(0.5);
    // moving together (zero relative motion): never hits from outside, 0 from inside
    expect(sweepPointSphere(V(1, 2, 3), V(4, 5, 6), V(10, 2, 3), V(13, 5, 6), 2)).toBe(-1);
    expect(sweepPointSphere(V(1, 2, 3), V(4, 5, 6), V(2, 2, 3), V(5, 5, 6), 2)).toBe(0);
    expect(sweepPointSphere(V(1, 2, 3), V(1, 2, 3), V(10, 2, 3), V(10, 2, 3), 2)).toBe(-1);
    // invalid radius / NaN never produce NaN
    expect(sweepPointSphere(V(-5, 0, 0), V(5, 0, 0), O, O, -1)).toBe(-1);
    expect(sweepPointSphere(V(-5, 0, 0), V(5, 0, 0), O, O, NaN)).toBe(-1);
    expect(sweepPointSphere(V(NaN, 0, 0), V(5, 0, 0), O, O, 1)).toBe(-1);
    expect(sweepPointSphere(V(-5, 0, 0), V(Infinity, 0, 0), O, O, 1)).toBe(-1);
    // zero radius: only an exact pass through the centre
    expect(sweepPointSphere(V(-5, 0, 0), V(5, 0, 0), O, O, 0)).toBe(0.5);
    expect(sweepPointSphere(V(-5, 1e-3, 0), V(5, 1e-3, 0), O, O, 0)).toBe(-1);
  });

  it('grazing passes: just inside hits, just outside misses', () => {
    const rng = new Rng(2024);
    for (let k = 0; k < 2000; k++) {
      const R = rng.range(0.3, 3);
      const c = randVec(rng, 0, 30);
      const dir = randUnit(rng);
      const n = vnorm(vcross(dir, randUnit(rng)));
      const L = rng.range(2, 40) + R;
      const delta = 10 ** rng.range(-8, -3);
      for (const sign of [-1, 1]) {
        const D = R + sign * delta;
        const p0 = vadd(vadd(c, vscale(n, D)), vscale(dir, -L));
        const p1 = vadd(vadd(c, vscale(n, D)), vscale(dir, L));
        const u = sweepPointSphere(p0, p1, c, c, R);
        if (sign > 0) {
          expect(u, `#${k} outside by ${delta}`).toBe(-1);
        } else {
          expect(u, `#${k} inside by ${delta}`).toBeGreaterThan(0);
          const half = Math.sqrt(R * R - D * D);
          expect(Math.abs(u - (L - half) / (2 * L)), `#${k}`).toBeLessThanOrEqual(1e-7);
          expect(Math.abs(vlen(vsub(vlerp(p0, p1, u), c)) - R), `#${k}`).toBeLessThanOrEqual(1e-9);
        }
      }
    }
  });

  it('agrees with dense sampling on random moving-point / moving-sphere configurations', () => {
    const rng = new Rng(0x5eed);
    const N = 4000;
    const stats = { hits: 0, misses: 0, inside: 0, maxSurfaceError: 0, tunnelled: 0 };
    for (let k = 0; k < 4000; k++) {
      const R = rng.range(0.3, 3);
      const c0 = randVec(rng, 0, 10);
      const c1 = vadd(c0, randVec(rng, 0, k % 4 === 0 ? 0 : 6));
      const p0 = k % 10 === 0 ? vadd(c0, randVec(rng, 0, R * 0.999)) : randVec(rng, 0, 16);
      let p1: V3;
      if (k % 7 === 0) {
        p1 = vadd(p0, vsub(c1, c0)); // zero relative motion
      } else if (k % 2 === 0) {
        // aimed at the neighbourhood of where the sphere is at fraction w: hits, near misses, short shots
        const w = rng.range(0.1, 1);
        const aim = vadd(vlerp(c0, c1, w), randVec(rng, 0, R * 1.6));
        const stretch = k % 6 === 0 ? rng.range(0.4, 2) : 1;
        p1 = vadd(p0, vscale(vsub(aim, p0), stretch / w));
      } else {
        p1 = vadd(p0, randVec(rng, 0, 30));
      }
      const u = sweepPointSphere(p0, p1, c0, c1, R);
      const dist = (w: number): number => vlen(vsub(vlerp(p0, p1, w), vlerp(c0, c1, w)));
      // dense sampling reference
      let first = -1;
      for (let i = 0; i <= N; i++) {
        if (dist(i / N) <= R) {
          first = i / N;
          break;
        }
      }
      // exact independent criterion
      const dMin = closestApproach(vsub(p0, c0), vsub(vsub(p1, p0), vsub(c1, c0)));
      if (Math.abs(dMin - R) > 1e-9) expect(u >= 0, `#${k}`).toBe(dMin < R);
      if (u < 0) {
        expect(first, `#${k}`).toBe(-1);
        stats.misses++;
        continue;
      }
      expect(u, `#${k}`).toBeLessThanOrEqual(1);
      if (dist(0) <= R) {
        expect(u, `#${k}`).toBe(0);
        expect(first, `#${k}`).toBe(0);
        stats.inside++;
        continue;
      }
      // on the surface at the reported fraction, outside just before it
      const err = Math.abs(dist(u) - R);
      expect(err, `#${k}`).toBeLessThanOrEqual(1e-9);
      expect(dist(u * (1 - 1e-6)), `#${k}`).toBeGreaterThan(R);
      stats.maxSurfaceError = Math.max(stats.maxSurfaceError, err);
      if (first >= 0) {
        expect(u, `#${k}`).toBeLessThanOrEqual(first + 1e-12);
        expect(u, `#${k}`).toBeGreaterThanOrEqual(first - 1 / N - 1e-12);
      } else {
        stats.tunnelled++; // the sampling stepped over a thin chord; the exact criterion above covered it
      }
      stats.hits++;
    }
    report('sweepPointSphere random', JSON.stringify(stats));
    expect(stats.hits).toBeGreaterThan(300);
    expect(stats.misses).toBeGreaterThan(300);
    expect(stats.inside).toBeGreaterThan(300);
  });

  it('never tunnels at very high relative speed', () => {
    const rng = new Rng(808);
    let maxErr = 0;
    let maxRatio = 0;
    let checked = 0;
    for (let k = 0; k < 3000; k++) {
      const R = rng.range(0.4, 2);
      const c0 = randVec(rng, 0, 50);
      const sphereStep = randVec(rng, 0, 10 ** rng.range(0, 5));
      const c1 = vadd(c0, sphereStep);
      // the point passes through a point of the sphere's interior at fraction w of the interval
      const w = rng.range(0.05, 0.95);
      const through = vadd(vlerp(c0, c1, w), randVec(rng, 0, R * 0.9));
      const travel = randVec(rng, 1e2, 10 ** rng.range(2, 7));
      const p0 = vsub(through, vscale(travel, w));
      const p1 = vadd(through, vscale(travel, 1 - w));
      if (vlen(vsub(p0, c0)) <= R) continue;
      const u = sweepPointSphere(p0, p1, c0, c1, R);
      expect(u, `#${k}`).toBeGreaterThan(0);
      expect(u, `#${k}`).toBeLessThanOrEqual(w + 1e-9);
      // error budget: only the rounding of coordinates of this magnitude (a few ulp)
      const magnitude = vlen(p0) + vlen(p1) + vlen(c0) + vlen(c1);
      const err = Math.abs(vlen(vsub(vlerp(p0, p1, u), vlerp(c0, c1, u))) - R);
      expect(err, `#${k}`).toBeLessThanOrEqual(2e-15 * magnitude + 1e-12);
      maxErr = Math.max(maxErr, err);
      maxRatio = Math.max(maxRatio, err / magnitude);
      checked++;
    }
    report('sweepPointSphere high-speed: checked', checked, 'max surface error', maxErr, 'max error/magnitude', maxRatio);
    expect(checked).toBeGreaterThan(2500);
  });
});

/**
 * Independent reference for the box. The relative path can only enter the box at u = 0 or where it crosses
 * one of the six face planes, and between two consecutive such instants it is entirely inside or outside.
 *   'closed'  first candidate instant at which the point is within `eps` of the closed box (touching counts)
 *   'solid'   first candidate instant followed by a stretch inside the box shrunk by `eps` (real penetration)
 * Both agree unless the contact is a graze thinner than `eps`.
 */
function bruteBoxEntry(p0: V3, p1: V3, c0: V3, c1: V3, half: V3, eps: number, mode: 'closed' | 'solid'): number {
  const q0 = vsub(p0, c0);
  const dq = vsub(vsub(p1, p0), vsub(c1, c0));
  const candidates = [0];
  const axes: Array<[number, number, number]> = [
    [q0.x, dq.x, half.x],
    [q0.y, dq.y, half.y],
    [q0.z, dq.z, half.z],
  ];
  for (const [q, d, h] of axes) {
    if (d !== 0) {
      for (const plane of [-h, h]) {
        const u = (plane - q) / d;
        if (u > 0 && u <= 1) candidates.push(u);
      }
    }
  }
  candidates.sort((a, b) => a - b);
  const insideAt = (u: number, e: number): boolean => {
    const x = q0.x + dq.x * u;
    const y = q0.y + dq.y * u;
    const z = q0.z + dq.z * u;
    return Math.abs(x) <= half.x + e && Math.abs(y) <= half.y + e && Math.abs(z) <= half.z + e;
  };
  for (let i = 0; i < candidates.length; i++) {
    const u = candidates[i];
    if (mode === 'closed') {
      if (insideAt(u, eps)) return u;
    } else {
      const next = i + 1 < candidates.length ? candidates[i + 1] : 1;
      if (next > u ? insideAt(0.5 * (u + next), -eps) : candidates.length === 1 && insideAt(u, -eps)) return u;
    }
  }
  return -1;
}

describe('sweepPointBox', () => {
  const HALF = V(1.3, 2.0, 1.3); // the player's hit box
  const O = V(0, 0, 0);

  it('hand-checked cases', () => {
    // straight through the +x / −x faces
    expect(sweepPointBox(V(-5, 0, 0), V(5, 0, 0), O, O, HALF)).toBeCloseTo(0.37, 15);
    expect(sweepPointBox(V(0, 10, 0), V(0, -10, 0), O, O, HALF)).toBeCloseTo(0.4, 15);
    // stops short / moves away
    expect(sweepPointBox(V(-5, 0, 0), V(-1.4, 0, 0), O, O, HALF)).toBe(-1);
    expect(sweepPointBox(V(2, 0, 0), V(9, 0, 0), O, O, HALF)).toBe(-1);
    // ends exactly on the face
    expect(sweepPointBox(V(-5.3, 0, 0), V(-1.3, 0, 0), O, O, HALF)).toBe(1);
    // start inside / on the boundary → 0
    expect(sweepPointBox(V(0.5, -1.9, 1.2), V(40, 0, 0), O, O, HALF)).toBe(0);
    expect(sweepPointBox(V(1.3, 2, -1.3), V(40, 30, -20), O, O, HALF)).toBe(0);
    expect(sweepPointBox(V(0, 0, 0), V(0, 0, 0), O, O, HALF)).toBe(0);
    // sliding exactly along a face plane counts as contact once the other axes overlap
    expect(sweepPointBox(V(-5, 2, 0), V(5, 2, 0), O, O, HALF)).toBeCloseTo(0.37, 15);
    // parallel to a face but outside its slab
    expect(sweepPointBox(V(-5, 2.0001, 0), V(5, 2.0001, 0), O, O, HALF)).toBe(-1);
    // through an edge exactly
    expect(sweepPointBox(V(-2.3, 3, 0), V(-0.3, 1, 0), O, O, HALF)).toBe(0.5);
    // diagonal miss past a corner
    expect(sweepPointBox(V(-4, 3.5, 0), V(-0.5, 3.5 - 1.2, 0), O, O, HALF)).toBe(-1);
    // box moving onto a resting point (enemy bullet hovering, player boosting into it)
    expect(sweepPointBox(V(0, 0, 0), V(0, 0, 0), V(10, 0, 0), V(0, 0, 0), HALF)).toBeCloseTo(0.87, 15);
    // both moving head-on at high speed
    const u = sweepPointBox(V(-70, 0.5, 0), V(70, 0.5, 0), V(40, 0, 0.2), V(-40, 0, 0.2), HALF);
    expect(u).toBeCloseTo((110 - 1.3) / 220, 14);
    // moving together: zero relative motion
    expect(sweepPointBox(V(5, 0, 0), V(8, 1, 2), V(0, 0, 0), V(3, 1, 2), HALF)).toBe(-1);
    expect(sweepPointBox(V(1, 0, 0), V(4, 1, 2), V(0, 0, 0), V(3, 1, 2), HALF)).toBe(0);
    // invalid input never produces NaN
    expect(sweepPointBox(V(-5, 0, 0), V(5, 0, 0), O, O, V(-1, 1, 1))).toBe(-1);
    expect(sweepPointBox(V(-5, 0, 0), V(5, 0, 0), O, O, V(NaN, 1, 1))).toBe(-1);
    expect(sweepPointBox(V(NaN, 0, 0), V(5, 0, 0), O, O, HALF)).toBe(-1);
    expect(sweepPointBox(V(-5, 0, 0), V(5, Infinity, 0), O, O, HALF)).toBe(-1);
    // degenerate (flat) box still works as a closed set
    expect(sweepPointBox(V(0, 5, 0), V(0, -5, 0), O, O, V(1, 0, 1))).toBe(0.5);
  });

  it('agrees with candidate enumeration and dense sampling on random configurations', () => {
    const rng = new Rng(0xb0c5);
    const N = 2000;
    const stats = { hits: 0, misses: 0, inside: 0, grazing: 0, maxBoundaryError: 0 };
    for (let k = 0; k < 5000; k++) {
      const half = k % 2 === 0 ? HALF : V(rng.range(0.2, 4), rng.range(0.2, 4), rng.range(0.2, 4));
      const c0 = randVec(rng, 0, 10);
      const c1 = vadd(c0, randVec(rng, 0, k % 4 === 0 ? 0 : 5));
      const p0 =
        k % 9 === 0
          ? vadd(c0, V(rng.range(-1, 1) * half.x, rng.range(-1, 1) * half.y, rng.range(-1, 1) * half.z))
          : randVec(rng, 0, 16);
      let p1: V3;
      if (k % 11 === 0) {
        p1 = vadd(p0, vsub(c1, c0)); // zero relative motion
      } else if (k % 2 === 1) {
        // aimed at the neighbourhood of where the box is at fraction w: hits, near misses, short shots
        const w = rng.range(0.1, 1);
        const aim = vadd(
          vlerp(c0, c1, w),
          V(rng.range(-1.5, 1.5) * half.x, rng.range(-1.5, 1.5) * half.y, rng.range(-1.5, 1.5) * half.z),
        );
        const stretch = k % 6 === 1 ? rng.range(0.4, 2) : 1;
        p1 = vadd(p0, vscale(vsub(aim, p0), stretch / w));
      } else {
        p1 = vadd(p0, randVec(rng, 0, 30));
      }
      if (k % 13 === 0) p1 = V(p1.x, p0.y + (c1.y - c0.y), p1.z); // no relative motion along y
      const u = sweepPointBox(p0, p1, c0, c1, half);
      const rel = (w: number): V3 => vsub(vlerp(p0, p1, w), vlerp(c0, c1, w));
      const inside = (w: number, eps: number): boolean => {
        const q = rel(w);
        return Math.abs(q.x) <= half.x + eps && Math.abs(q.y) <= half.y + eps && Math.abs(q.z) <= half.z + eps;
      };
      /** Dense sampling: is any sample at a fraction < limit inside the box shrunk by 1e-9? */
      const sampledInsideBefore = (limit: number): boolean => {
        for (let i = 0; i <= N && i / N < limit; i++) if (inside(i / N, -1e-9)) return true;
        return false;
      };
      const expected = bruteBoxEntry(p0, p1, c0, c1, half, 1e-9, 'closed');
      const solid = bruteBoxEntry(p0, p1, c0, c1, half, 1e-9, 'solid');
      if (expected !== solid) {
        // a graze thinner than 1e-9 m: contact and no contact are both acceptable answers,
        // but a reported contact must lie on the box
        if (u >= 0) expect(inside(u, 1e-9), `#${k}`).toBe(true);
        stats.grazing++;
        continue;
      }
      if (expected < 0) {
        expect(u, `#${k}`).toBe(-1);
        expect(sampledInsideBefore(2), `#${k}`).toBe(false);
        stats.misses++;
        continue;
      }
      expect(u, `#${k}`).toBeGreaterThanOrEqual(0);
      expect(u, `#${k}`).toBeLessThanOrEqual(1);
      expect(Math.abs(u - expected), `#${k}`).toBeLessThanOrEqual(1e-9);
      expect(inside(u, 1e-9), `#${k}`).toBe(true);
      if (inside(0, 0)) {
        expect(u, `#${k}`).toBe(0);
        stats.inside++;
        continue;
      }
      // on the boundary at u (some coordinate is at its face), outside just before
      const q = rel(u);
      const boundary = Math.min(
        Math.abs(Math.abs(q.x) - half.x),
        Math.abs(Math.abs(q.y) - half.y),
        Math.abs(Math.abs(q.z) - half.z),
      );
      expect(boundary, `#${k}`).toBeLessThanOrEqual(1e-9);
      stats.maxBoundaryError = Math.max(stats.maxBoundaryError, boundary);
      if (u > 1e-6) expect(inside(u * (1 - 1e-6), -1e-12), `#${k}`).toBe(false);
      // dense sampling: nothing inside before u
      expect(sampledInsideBefore(u - 1e-9), `#${k}`).toBe(false);
      stats.hits++;
    }
    report('sweepPointBox random', JSON.stringify(stats));
    expect(stats.hits).toBeGreaterThan(300);
    expect(stats.misses).toBeGreaterThan(300);
    expect(stats.inside).toBeGreaterThan(300);
    expect(stats.grazing).toBeLessThan(10);
  });

  it('never tunnels at very high relative speed', () => {
    const rng = new Rng(606);
    for (let k = 0; k < 3000; k++) {
      const c0 = randVec(rng, 0, 50);
      const boxStep = randVec(rng, 0, 10 ** rng.range(0, 4));
      const c1 = vadd(c0, boxStep);
      const w = rng.range(0.05, 0.95);
      const through = vadd(
        vlerp(c0, c1, w),
        V(rng.range(-0.9, 0.9) * HALF.x, rng.range(-0.9, 0.9) * HALF.y, rng.range(-0.9, 0.9) * HALF.z),
      );
      const travel = randVec(rng, 1e2, 10 ** rng.range(2, 7));
      const p0 = vsub(through, vscale(travel, w));
      const p1 = vadd(through, vscale(travel, 1 - w));
      const q0 = vsub(p0, c0);
      if (Math.abs(q0.x) <= HALF.x && Math.abs(q0.y) <= HALF.y && Math.abs(q0.z) <= HALF.z) continue;
      const u = sweepPointBox(p0, p1, c0, c1, HALF);
      expect(u, `#${k}`).toBeGreaterThan(0);
      expect(u, `#${k}`).toBeLessThanOrEqual(w + 1e-9);
      const q = vsub(vlerp(p0, p1, u), vlerp(c0, c1, u));
      const slack = 1e-12 * vlen(vsub(travel, boxStep)) + 1e-9;
      expect(Math.abs(q.x), `#${k}`).toBeLessThanOrEqual(HALF.x + slack);
      expect(Math.abs(q.y), `#${k}`).toBeLessThanOrEqual(HALF.y + slack);
      expect(Math.abs(q.z), `#${k}`).toBeLessThanOrEqual(HALF.z + slack);
    }
  });
});
