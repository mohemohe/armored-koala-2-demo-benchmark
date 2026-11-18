import { describe, expect, it } from 'vitest';
import { FCS, GRAVITY, WEAPONS } from '../src/config';
import { mgPositionAt, solveConstantSpeedIntercept, solveMachinegun } from '../src/sim/ballistics';
import type { MgSolution } from '../src/sim/ballistics';
import { Rng } from '../src/sim/rng';
import type { V3 } from '../src/sim/types';

// ---------------------------------------------------------------------------
// independent helpers (do not share code with the solver)
// ---------------------------------------------------------------------------
const S = WEAPONS.machinegun.muzzleSpeed; // 100
const GVEC: V3 = { x: 0, y: -GRAVITY, z: 0 };
const M: V3 = { x: 0, y: 20, z: 0 }; // SPEC §4.6 muzzle
const v3 = (x: number, y: number, z: number): V3 => ({ x, y, z });
const add = (a: V3, b: V3): V3 => v3(a.x + b.x, a.y + b.y, a.z + b.z);
const sub = (a: V3, b: V3): V3 => v3(a.x - b.x, a.y - b.y, a.z - b.z);
const mul = (a: V3, k: number): V3 => v3(a.x * k, a.y * k, a.z * k);
const dot = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const len = (a: V3): number => Math.sqrt(dot(a, a));
const finiteV = (a: V3): boolean => Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z);

/** F(t) = |r + v t - 0.5 g t²|² - s² t²  (SPEC §4.3), written straight from the spec with vectors */
function oracleF(m: V3, p: V3, v: V3, t: number): number {
  const r = sub(p, m);
  const w = sub(add(r, mul(v, t)), mul(GVEC, 0.5 * t * t));
  return dot(w, w) - S * S * t * t;
}

/** first grid time in (0, tMax] with F <= 0, or null. Returns the grid step index too. */
function scanFirstNonPositive(m: V3, p: V3, v: V3, step: number, tMax = 2): { k: number; t: number } | null {
  const n = Math.round(tMax / step);
  for (let k = 1; k <= n; k++) {
    const t = k * step;
    if (oracleF(m, p, v, t) <= 0) return { k, t };
  }
  return null;
}

function bisectF(m: V3, p: V3, v: V3, lo: number, hi: number): number {
  // F(lo) > 0, F(hi) <= 0
  for (let i = 0; i < 100; i++) {
    const mid = 0.5 * (lo + hi);
    if (oracleF(m, p, v, mid) > 0) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/** every property SPEC §4.3 requires of an adopted solution, checked independently of sol.residual */
function expectValidSolution(m: V3, p: V3, v: V3, sol: MgSolution): void {
  for (const x of [sol.t, sol.residual, ...Object.values(sol.direction), ...Object.values(sol.velocity), ...Object.values(sol.aimPoint), ...Object.values(sol.interceptPoint)]) {
    expect(Number.isFinite(x)).toBe(true);
  }
  expect(sol.t).toBeGreaterThan(0);
  expect(sol.t).toBeLessThanOrEqual(FCS.MG_MAX_T);
  // speed
  expect(Math.abs(len(sol.velocity) - S)).toBeLessThanOrEqual(0.001);
  expect(len(sol.direction)).toBeCloseTo(1, 12);
  expect(len(sub(mul(sol.direction, S), sol.velocity))).toBeLessThan(1e-9);
  // projectile vs predicted target at t (projectile formula m + v0 t + 0.5 g t²)
  const bullet = add(add(m, mul(sol.velocity, sol.t)), mul(GVEC, 0.5 * sol.t * sol.t));
  const target = add(p, mul(v, sol.t));
  const miss = len(sub(bullet, target));
  expect(miss).toBeLessThanOrEqual(FCS.MAX_RESIDUAL_M);
  expect(Math.abs(sol.residual - miss)).toBeLessThan(1e-9);
  expect(sol.residual).toBeLessThanOrEqual(FCS.MAX_RESIDUAL_M);
  // reported points
  expect(len(sub(sol.interceptPoint, target))).toBeLessThan(1e-9);
  const aim = sub(target, mul(GVEC, 0.5 * sol.t * sol.t));
  expect(len(sub(sol.aimPoint, aim))).toBeLessThan(1e-9);
  expect(sol.aimPoint.y).toBeGreaterThan(sol.interceptPoint.y);
  // d = (r + v t - 0.5 g t²) / (s t)
  const d = mul(sub(aim, m), 1 / (S * sol.t));
  expect(len(sub(d, sol.direction))).toBeLessThan(1e-6);
}

/** SPEC §4.6 table */
const A_CASES: { id: string; r: V3; v: V3 }[] = [
  { id: 'A01', r: v3(0, 0, 20), v: v3(0, 0, 0) },
  { id: 'A02', r: v3(0, 0, 60), v: v3(0, 0, 0) },
  { id: 'A03', r: v3(0, 0, 100), v: v3(0, 0, 0) },
  { id: 'A04', r: v3(0, 0, 120), v: v3(0, 0, 0) },
  { id: 'A05', r: v3(0, 0, 100), v: v3(8, 0, 0) },
  { id: 'A06', r: v3(0, 0, 100), v: v3(-8, 0, 0) },
  { id: 'A07', r: v3(0, 0, 100), v: v3(0, 0, 8) },
  { id: 'A08', r: v3(0, 0, 100), v: v3(0, 0, -8) },
  { id: 'A09', r: v3(0, 16, 100), v: v3(6, 0, 0) },
  { id: 'A10', r: v3(0, -16, 100), v: v3(-6, 0, 0) },
  { id: 'A11', r: v3(0, 0, 100), v: v3(6, 3, 0) },
  { id: 'A12', r: v3(0, 0, 100), v: v3(6, -3, 0) },
  { id: 'A13', r: v3(0, 0, 120), v: v3(6, 3, 4) },
];

// ---------------------------------------------------------------------------
describe('solveMachinegun: SPEC §4.6 conditions A01-A13', () => {
  for (const c of A_CASES) {
    it(`${c.id} has a valid smallest-root solution`, () => {
      const p = add(M, c.r);
      const sol = solveMachinegun(M, p, c.v);
      expect(sol).not.toBeNull();
      if (!sol) return;
      expectValidSolution(M, p, c.v, sol);
      // t is the smallest root: F > 0 on a fine grid before t, and F(t) ~ 0
      const step = 1e-4;
      for (let k = 1; k * step < sol.t - 1e-9; k++) expect(oracleF(M, p, c.v, k * step)).toBeGreaterThan(0);
      // gravity compensation: the launch ray points above the straight line to the current target center
      const direct = sub(p, M);
      expect(sol.direction.y).toBeGreaterThan(direct.y / len(direct));
    });
  }

  it('matches the SPEC reference values (A03, A05, A13)', () => {
    const a03 = solveMachinegun(M, add(M, v3(0, 0, 100)), v3(0, 0, 0))!;
    expect(a03.t).toBeCloseTo(1.004108529, 8);
    expect(a03.velocity.x).toBeCloseTo(0, 9);
    expect(a03.velocity.y).toBeCloseTo(9.036976765, 8);
    expect(a03.velocity.z).toBeCloseTo(99.590828147, 8);

    const a05 = solveMachinegun(M, add(M, v3(0, 0, 100)), v3(8, 0, 0))!;
    expect(a05.t).toBeCloseTo(1.007391236, 8);
    expect(a05.velocity.x).toBeCloseTo(8, 8);
    expect(a05.velocity.y).toBeCloseTo(9.066521121, 8);
    expect(a05.velocity.z).toBeCloseTo(99.266299391, 8);

    const a13 = solveMachinegun(M, add(M, v3(0, 0, 120)), v3(6, 3, 4))!;
    expect(a13.t).toBeCloseTo(1.266137996, 8);
    // the 1.20 s enemy horizon must NOT limit the player's solver
    expect(a13.t).toBeGreaterThan(1.2);
  });

  it('is independent of world yaw and translation (rotated/translated A-cases give rotated solutions)', () => {
    const rng = new Rng(77);
    for (const c of A_CASES) {
      const base = solveMachinegun(M, add(M, c.r), c.v)!;
      for (let i = 0; i < 20; i++) {
        const yaw = rng.range(-Math.PI, Math.PI);
        const cs = Math.cos(yaw);
        const sn = Math.sin(yaw);
        const rot = (a: V3): V3 => v3(a.x * cs + a.z * sn, a.y, -a.x * sn + a.z * cs); // rotation about +Y
        const off = v3(rng.range(-500, 500), rng.range(-50, 300), rng.range(-500, 500));
        const m = add(off, v3(0, 0, 0));
        const p = add(m, rot(c.r));
        const v = rot(c.v);
        const sol = solveMachinegun(m, p, v)!;
        expect(sol).not.toBeNull();
        expectValidSolution(m, p, v, sol);
        expect(sol.t).toBeCloseTo(base.t, 9);
        expect(len(sub(sol.velocity, rot(base.velocity)))).toBeLessThan(1e-7);
        expect(sol.velocity.y).toBeCloseTo(base.velocity.y, 7);
      }
    }
  });

  it('every result is finite and a firing solution is a real parabola (independent Euler integration agrees)', () => {
    const p = add(M, v3(0, 16, 100));
    const v = v3(6, 0, 0);
    const sol = solveMachinegun(M, p, v)!;
    // symplectic Euler, dt=1e-5, independent of mgPositionAt
    let pos = { ...M };
    let vel = { ...sol.velocity };
    const dt = 1e-5;
    const n = Math.round(sol.t / dt);
    for (let i = 0; i < n; i++) {
      vel = add(vel, mul(GVEC, dt));
      pos = add(pos, mul(vel, dt));
    }
    const target = add(p, mul(v, n * dt));
    expect(len(sub(pos, target))).toBeLessThan(2e-3);
    // and mgPositionAt is the closed form of the same motion
    const closed = mgPositionAt(M, sol.velocity, n * dt);
    expect(len(sub(closed, pos))).toBeLessThan(2e-3);
  });
});

// ---------------------------------------------------------------------------
describe('solveMachinegun: randomized cross-check against a dense scan', () => {
  function randomCase(rng: Rng, vMax: number): { m: V3; p: V3; v: V3 } {
    const m = v3(rng.range(-300, 300), rng.range(0, 200), rng.range(-300, 300));
    const dist = rng.range(1, 120);
    const ang = rng.range(0, Math.PI * 2);
    const dy = rng.range(-16, 16);
    const p = add(m, v3(Math.cos(ang) * dist, dy, Math.sin(ang) * dist));
    const sp = rng.range(0, vMax);
    const th = rng.range(0, Math.PI * 2);
    const el = rng.range(-Math.PI / 4, Math.PI / 4);
    const v = v3(Math.cos(th) * Math.cos(el) * sp, Math.sin(el) * sp, Math.sin(th) * Math.cos(el) * sp);
    return { m, p, v };
  }

  function runBatch(seed: number, count: number, vMax: number): { solved: number; none: number } {
    const rng = new Rng(seed);
    let solved = 0;
    let none = 0;
    const step = 2e-4;
    for (let i = 0; i < count; i++) {
      const { m, p, v } = randomCase(rng, vMax);
      const sol = solveMachinegun(m, p, v);
      const first = scanFirstNonPositive(m, p, v, step);
      if (sol) {
        solved++;
        expectValidSolution(m, p, v, sol);
        // no positive root smaller than sol.t: F > 0 on every earlier grid point
        for (let k = 1; k * step < sol.t - 1e-9; k++) {
          if (!(oracleF(m, p, v, k * step) > 0)) throw new Error(`smaller root exists before t=${sol.t} (case ${i}, k=${k})`);
        }
      } else {
        none++;
        // null -> the scan must not see any root either
        if (first) throw new Error(`solver returned null but F(${first.t}) <= 0 (case ${i})`);
      }
      if (first) {
        // scan found a root bracket -> solver must return that (smallest) root
        expect(sol).not.toBeNull();
        if (!sol) continue;
        const lo = (first.k - 1) * step;
        expect(sol.t).toBeLessThanOrEqual(first.t + 1e-9);
        expect(sol.t).toBeGreaterThan(lo - 1e-9);
        const ref = bisectF(m, p, v, lo, first.t);
        expect(Math.abs(sol.t - ref)).toBeLessThan(1e-8);
      }
    }
    return { solved, none };
  }

  it('range 1-120 m, height +-16 m, target speed 0-30 m/s (3000 cases)', () => {
    const r = runBatch(20260908, 3000, 30);
    expect(r.solved).toBeGreaterThan(2900); // realistic conditions are almost always solvable
  });

  it('fast targets 0-140 m/s: both solvable and unsolvable cases occur and agree with the scan (3000 cases)', () => {
    const r = runBatch(12345, 3000, 140);
    expect(r.solved).toBeGreaterThan(300);
    expect(r.none).toBeGreaterThan(300);
  });

  it('never returns NaN/Infinity for odd inputs and always returns a valid solution or null', () => {
    const rng = new Rng(99);
    for (let i = 0; i < 5000; i++) {
      const scale = Math.pow(10, rng.range(-6, 4));
      const m = v3(rng.range(-1, 1) * scale, rng.range(-1, 1) * scale, rng.range(-1, 1) * scale);
      const p = v3(rng.range(-1, 1) * scale * 10, rng.range(-1, 1) * scale * 10, rng.range(-1, 1) * scale * 10);
      const v = v3(rng.range(-1, 1) * scale * 5, rng.range(-1, 1) * scale * 5, rng.range(-1, 1) * scale * 5);
      const sol = solveMachinegun(m, p, v);
      if (sol) expectValidSolution(m, p, v, sol);
    }
  });
});

// ---------------------------------------------------------------------------
describe('solveMachinegun: tangent (double root) and time-limit boundaries', () => {
  const H = GRAVITY / 2;

  /** exact double root at t0: F(t0) = 0 and F'(t0) = 0 by construction */
  function doubleRootCase(rng: Rng): { m: V3; p: V3; v: V3; t0: number } {
    const t0 = rng.range(0.3, 1.9);
    const th = rng.range(0, Math.PI * 2);
    const el = rng.range(-0.6, 0.6);
    const u = v3(Math.cos(th) * Math.cos(el), Math.sin(el), Math.sin(th) * Math.cos(el));
    const k = S - 2 * H * t0 * u.y; // u·v so that u·(v + 2 h t0 y) = s
    // random vector perpendicular to u
    let q = v3(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1));
    q = sub(q, mul(u, dot(q, u)));
    q = mul(q, rng.range(0, 40) / Math.max(1e-9, len(q)));
    const v = add(mul(u, k), q);
    const r = sub(sub(mul(u, S * t0), mul(v, t0)), v3(0, H * t0 * t0, 0));
    const m = v3(rng.range(-100, 100), rng.range(0, 100), rng.range(-100, 100));
    return { m, p: add(m, r), v, t0 };
  }

  it('finds exact tangent (double) roots (200 constructed cases)', () => {
    const rng = new Rng(4242);
    let isolated = 0;
    for (let i = 0; i < 200; i++) {
      const { m, p, v, t0 } = doubleRootCase(rng);
      // sanity of the construction with the independent oracle
      expect(Math.abs(oracleF(m, p, v, t0))).toBeLessThan(1e-6);
      const sol = solveMachinegun(m, p, v);
      expect(sol, `case ${i}`).not.toBeNull();
      if (!sol) continue;
      expectValidSolution(m, p, v, sol);
      expect(sol.t).toBeLessThanOrEqual(t0 + 1e-6);
      const first = scanFirstNonPositive(m, p, v, 1e-4);
      if (!first) {
        // the tangent root is the only root: it must be found at t0
        isolated++;
        expect(Math.abs(sol.t - t0)).toBeLessThan(1e-5);
      } else {
        expect(sol.t).toBeLessThanOrEqual(first.t + 1e-9);
      }
    }
    expect(isolated).toBeGreaterThan(20); // the tangent branch itself was exercised
  });

  it('lifting a tangent case out of reach gives null, sinking it gives the crossing root (scan-consistent)', () => {
    const rng = new Rng(555);
    let nulls = 0;
    let crossings = 0;
    for (let i = 0; i < 200; i++) {
      const { m, p, v, t0 } = doubleRootCase(rng);
      // move the target 0.05 m along +/- the bullet-facing line of the tangent point to shrink/grow the miss
      const dir = sub(add(p, mul(v, t0)), m); // ~ s t0 u + gravity term (points at the intercept)
      const ud = mul(dir, 1 / len(dir));
      for (const sgn of [+1, -1]) {
        const p2 = add(p, mul(ud, 0.05 * sgn));
        const sol = solveMachinegun(m, p2, v);
        const first = scanFirstNonPositive(m, p2, v, 1e-4);
        if (sol) {
          expectValidSolution(m, p2, v, sol);
          if (first) crossings++;
        } else {
          nulls++;
          expect(first).toBeNull();
        }
        if (first) expect(sol).not.toBeNull();
      }
    }
    expect(nulls).toBeGreaterThan(20);
    expect(crossings).toBeGreaterThan(20);
  });

  it('a target fleeing at almost the bullet speed sits on the boundary: solvable on one side, null beyond the time limit', () => {
    // bisect on the flee speed; the boundary is the t = 2 limit, so the boundary solution has t ~= 2
    const p0 = (dz: number) => add(M, v3(0, 0, dz));
    for (const R of [20, 60, 100, 120]) {
      const ok = (vz: number) => solveMachinegun(M, p0(R), v3(0, 0, vz));
      let lo = 0;
      let hi = 400;
      expect(ok(lo)).not.toBeNull();
      expect(ok(hi)).toBeNull();
      for (let i = 0; i < 200; i++) {
        const mid = 0.5 * (lo + hi);
        if (ok(mid)) lo = mid;
        else hi = mid;
      }
      const edge = ok(lo)!;
      expectValidSolution(M, p0(R), v3(0, 0, lo), edge);
      expect(edge.t).toBeGreaterThan(1.999);
      expect(edge.t).toBeLessThanOrEqual(2);
      // just beyond: F stays positive on the whole grid
      expect(scanFirstNonPositive(M, p0(R), v3(0, 0, hi + 1e-6), 1e-4)).toBeNull();
    }
  });

  it('root exactly at t = 2 is accepted; roots at 2 +- small offsets follow the time limit (with the 1e-9 slack)', () => {
    const rng = new Rng(31337);
    /** target built so that the bullet fired along `d` reaches it exactly at time T */
    const atTime = (m: V3, d: V3, v: V3, T: number): V3 => {
      const hit = add(add(m, mul(d, S * T)), mul(GVEC, 0.5 * T * T));
      return sub(hit, mul(v, T));
    };
    let exactHits = 0;
    for (let i = 0; i < 300; i++) {
      const m = v3(rng.range(-50, 50), rng.range(0, 60), rng.range(-50, 50));
      const th = rng.range(0, Math.PI * 2);
      const el = rng.range(-0.3, 0.3);
      const d = v3(Math.cos(th) * Math.cos(el), Math.sin(el), Math.sin(th) * Math.cos(el));
      const v = mul(d, rng.range(0, 60)); // fleeing along the line of fire: the t = 2 root is the first one
      for (const T of [2, 2 - 1e-6, 2 - 1e-3, 2 + 5e-10]) {
        const p = atTime(m, d, v, T);
        const sol = solveMachinegun(m, p, v);
        const first = scanFirstNonPositive(m, p, v, 1e-4);
        expect(sol, `T=${T}`).not.toBeNull();
        if (!sol) continue;
        expectValidSolution(m, p, v, sol);
        expect(sol.t).toBeLessThanOrEqual(2);
        if (!first) {
          // no earlier root: the solution is the boundary one
          expect(sol.t).toBeGreaterThan(T - 1e-4);
          if (T === 2) exactHits++;
        }
      }
      // clearly beyond the limit: null unless an earlier root exists
      for (const T of [2 + 1e-3, 2.5]) {
        const p = atTime(m, d, v, T);
        const sol = solveMachinegun(m, p, v);
        const first = scanFirstNonPositive(m, p, v, 1e-4);
        if (first) expect(sol).not.toBeNull();
        else expect(sol).toBeNull();
      }
    }
    expect(exactHits).toBeGreaterThan(50);
  });
});

// ---------------------------------------------------------------------------
describe('solveMachinegun: degenerate input', () => {
  it('returns null when the muzzle and target center coincide (caller aims directly)', () => {
    expect(solveMachinegun(M, { ...M }, v3(0, 0, 0))).toBeNull();
    expect(solveMachinegun(M, { ...M }, v3(5, 1, -3))).toBeNull();
    expect(solveMachinegun(M, add(M, v3(1e-6, 0, 0)), v3(0, 0, 10))).toBeNull();
  });

  it('is still solvable at 0.5 m and 1 m with sane output', () => {
    for (const d of [0.5, 1]) {
      const sol = solveMachinegun(M, add(M, v3(0, 0, d)), v3(0, 0, 0))!;
      expect(sol).not.toBeNull();
      expectValidSolution(M, add(M, v3(0, 0, d)), v3(0, 0, 0), sol);
    }
  });

  it('rejects NaN / Infinity inputs', () => {
    const bad = [NaN, Infinity, -Infinity];
    for (const b of bad) {
      expect(solveMachinegun(v3(b, 0, 0), v3(0, 0, 100), v3(0, 0, 0))).toBeNull();
      expect(solveMachinegun(M, v3(0, b, 100), v3(0, 0, 0))).toBeNull();
      expect(solveMachinegun(M, v3(0, 0, 100), v3(0, 0, b))).toBeNull();
    }
    expect(solveMachinegun(M, v3(1e200, 0, 0), v3(0, 0, 0))).toBeNull();
    expect(solveMachinegun(M, v3(100, 0, 0), v3(1e200, 0, 0))).toBeNull();
  });

  it('returns null for targets that are out of range in time (400 m static, or fleeing faster than the bullet)', () => {
    expect(solveMachinegun(M, add(M, v3(0, 0, 400)), v3(0, 0, 0))).toBeNull();
    expect(solveMachinegun(M, add(M, v3(0, 0, 100)), v3(0, 0, 150))).toBeNull();
  });

  it('solves a target directly above and below (steep angles) and one approaching faster than the bullet', () => {
    for (const r of [v3(0, 16, 0.01), v3(0, -16, 0.01), v3(0.5, 90, 0), v3(0, -90, 0.5)]) {
      const p = add(M, r);
      const sol = solveMachinegun(M, p, v3(0, 0, 0));
      expect(sol).not.toBeNull();
      if (sol) expectValidSolution(M, p, v3(0, 0, 0), sol);
    }
    // incoming supersonic-to-bullet target: t is short
    const p = add(M, v3(0, 0, 100));
    const v = v3(0, 0, -150);
    const sol = solveMachinegun(M, p, v)!;
    expect(sol).not.toBeNull();
    expectValidSolution(M, p, v, sol);
    expect(sol.t).toBeLessThan(0.5);
  });
});

// ---------------------------------------------------------------------------
describe('mgPositionAt', () => {
  it('is m + v0 a + 0.5 g a^2 with g = (0,-18,0)', () => {
    const p = mgPositionAt(v3(1, 2, 3), v3(4, 5, 6), 2);
    expect(p.x).toBeCloseTo(9, 12);
    expect(p.y).toBeCloseTo(2 + 10 - 36, 12);
    expect(p.z).toBeCloseTo(15, 12);
    const q = mgPositionAt(v3(1, 2, 3), v3(4, 5, 6), 0);
    expect(q).toEqual(v3(1, 2, 3));
  });
});

// ---------------------------------------------------------------------------
describe('solveConstantSpeedIntercept (missile / enemy bullets)', () => {
  const O = v3(0, 0, 0);

  function expectIntercept(m: V3, p: V3, v: V3, speed: number, maxT: number, sol: { t: number; direction: V3 }): void {
    expect(Number.isFinite(sol.t)).toBe(true);
    expect(finiteV(sol.direction)).toBe(true);
    expect(sol.t).toBeGreaterThan(0);
    expect(sol.t).toBeLessThanOrEqual(maxT);
    expect(len(sol.direction)).toBeCloseTo(1, 12);
    // missile flies along direction*speed for t and meets the target
    const missile = add(m, mul(sol.direction, speed * sol.t));
    const target = add(p, mul(v, sol.t));
    expect(len(sub(missile, target))).toBeLessThan(1e-6);
    // direction = normalize(r + v t)
    const w = add(sub(p, m), mul(v, sol.t));
    expect(len(sub(sol.direction, mul(w, 1 / len(w))))).toBeLessThan(1e-9);
  }

  it('static target: t = distance / speed, direction = straight at it', () => {
    const sol = solveConstantSpeedIntercept(O, v3(0, 0, 90), O, 45, 4)!;
    expect(sol.t).toBeCloseTo(2, 12);
    expect(sol.direction.z).toBeCloseTo(1, 12);
    const sol2 = solveConstantSpeedIntercept(v3(1, 2, 3), v3(1, 2 + 30, 3 + 40), O, 45, 4)!;
    expect(sol2.t).toBeCloseTo(50 / 45, 12);
    expect(sol2.direction.y).toBeCloseTo(0.6, 12);
    expect(sol2.direction.z).toBeCloseTo(0.8, 12);
  });

  it('crossing target (SPEC A05/A06/A07 with the missile): lead direction', () => {
    for (const v of [v3(8, 0, 0), v3(-8, 0, 0), v3(0, 0, 8)]) {
      const p = add(M, v3(0, 0, 100));
      const sol = solveConstantSpeedIntercept(M, p, v, WEAPONS.missile.speed, FCS.MISSILE_MAX_T)!;
      expect(sol).not.toBeNull();
      expectIntercept(M, p, v, WEAPONS.missile.speed, FCS.MISSILE_MAX_T, sol);
    }
    // closed form for A05: (64 - 2025) t² + 10000 = 0 -> t = 100 / sqrt(2025 - 64)
    const a05 = solveConstantSpeedIntercept(M, add(M, v3(0, 0, 100)), v3(8, 0, 0), 45, 4)!;
    expect(a05.t).toBeCloseTo(100 / Math.sqrt(2025 - 64), 12);
    expect(a05.direction.x).toBeGreaterThan(0); // leads to +x
  });

  it('receding slower than the projectile: catches up (50 + 20 t = 45 t -> t = 2)', () => {
    const sol = solveConstantSpeedIntercept(O, v3(0, 0, 50), v3(0, 0, 20), 45, 4)!;
    expect(sol.t).toBeCloseTo(2, 12);
    expectIntercept(O, v3(0, 0, 50), v3(0, 0, 20), 45, 4, sol);
  });

  it('approaching target: 50 - 20 t = 45 t -> t = 50/65', () => {
    const sol = solveConstantSpeedIntercept(O, v3(0, 0, 50), v3(0, 0, -20), 45, 4)!;
    expect(sol.t).toBeCloseTo(50 / 65, 12);
  });

  it('target faster than the projectile but head-on: smallest of two positive roots (0.952 s, not 6.67 s)', () => {
    const v = v3(0, 0, -60);
    const p = v3(0, 0, 100);
    const sol = solveConstantSpeedIntercept(O, p, v, 45, 10)!;
    expect(sol.t).toBeCloseTo(100 / 105, 12);
    expectIntercept(O, p, v, 45, 10, sol);
    // with maxT below the first root there is no solution
    expect(solveConstantSpeedIntercept(O, p, v, 45, 0.9)).toBeNull();
  });

  it('cannot catch: fleeing faster than the projectile, or too fast sideways -> null', () => {
    expect(solveConstantSpeedIntercept(O, v3(0, 0, 50), v3(0, 0, 60), 45, 4)).toBeNull();
    expect(solveConstantSpeedIntercept(O, v3(0, 0, 50), v3(0, 0, 45), 45, 4)).toBeNull(); // equal speed away: no root
    expect(solveConstantSpeedIntercept(O, v3(0, 0, 50), v3(60, 0, 0), 45, 4)).toBeNull();
    expect(solveConstantSpeedIntercept(O, v3(0, 0, 50), v3(0, 0, 100), 70, 1.2)).toBeNull();
  });

  it('linear case (v·v = speed²): 2 (r·v) t + r·r = 0', () => {
    const v = v3(45, 0, 0);
    const r = v3(-30, 0, 40);
    const sol = solveConstantSpeedIntercept(O, r, v, 45, 4)!;
    expect(sol.t).toBeCloseTo(2500 / (2 * 1350), 12);
    expectIntercept(O, r, v, 45, 4, sol);
    // moving away with |v| = speed: no root
    expect(solveConstantSpeedIntercept(O, v3(30, 0, 40), v, 45, 4)).toBeNull();
    // slightly off exact: still finite and consistent
    for (const eps of [1e-9, -1e-9, 1e-13, -1e-13]) {
      const v2 = v3(45 + eps, 0, 0);
      const s2 = solveConstantSpeedIntercept(O, r, v2, 45, 4)!;
      expect(s2).not.toBeNull();
      expectIntercept(O, r, v2, 45, 4, s2);
      expect(s2.t).toBeCloseTo(sol.t, 6);
    }
  });

  it('time limit: root exactly at maxT is accepted, beyond it is rejected', () => {
    expect(solveConstantSpeedIntercept(O, v3(0, 0, 180), O, 45, 4)!.t).toBeCloseTo(4, 9);
    expect(solveConstantSpeedIntercept(O, v3(0, 0, 180.5), O, 45, 4)).toBeNull();
    // enemy bullets (70 m/s, 1.2 s): 84 m static
    expect(solveConstantSpeedIntercept(O, v3(0, 0, 84), O, 70, 1.2)!.t).toBeCloseTo(1.2, 9);
    expect(solveConstantSpeedIntercept(O, v3(0, 0, 84.5), O, 70, 1.2)).toBeNull();
    // target faster than the projectile and moving sideways: disc < 0 -> null
    expect(solveConstantSpeedIntercept(O, v3(0, 0, 100), v3(60, 0, -60), 45, 10)).toBeNull();
  });

  it('exact tangent of the intercept cone is found (double root)', () => {
    // r=(0,0,R), v=(vx,0,vz): disc = (R vz)² - (vx²+vz²-s²) R² = R² (s² - vx²) -> 0 at vx = s (target faster than s overall)
    const sol = solveConstantSpeedIntercept(O, v3(0, 0, 100), v3(45, 0, -30), 45, 10);
    // vx = s exactly: a = 900 > 0, disc = 0 -> t = -hb/a = 3000/900... = 100*30/900 = 3.3333
    expect(sol).not.toBeNull();
    if (sol) {
      expect(sol.t).toBeCloseTo(100 * 30 / 900, 9);
      expectIntercept(O, v3(0, 0, 100), v3(45, 0, -30), 45, 10, sol);
    }
  });

  it('overlapping muzzle/target and invalid parameters -> null', () => {
    expect(solveConstantSpeedIntercept(O, O, v3(3, 0, 0), 45, 4)).toBeNull();
    expect(solveConstantSpeedIntercept(O, v3(0, 0, 10), O, 0, 4)).toBeNull();
    expect(solveConstantSpeedIntercept(O, v3(0, 0, 10), O, -45, 4)).toBeNull();
    expect(solveConstantSpeedIntercept(O, v3(0, 0, 10), O, 45, 0)).toBeNull();
    expect(solveConstantSpeedIntercept(O, v3(NaN, 0, 10), O, 45, 4)).toBeNull();
    expect(solveConstantSpeedIntercept(O, v3(0, 0, 10), v3(0, Infinity, 0), 45, 4)).toBeNull();
    expect(solveConstantSpeedIntercept(O, v3(0, 0, 10), O, NaN, 4)).toBeNull();
  });

  it('randomized: agrees with a dense scan for missile (45, 4 s), enemy guard (70, 1.2 s) and turret (60, 1.2 s) bullets', () => {
    const rng = new Rng(2468);
    const params = [
      { speed: 45, maxT: 4 },
      { speed: 70, maxT: 1.2 },
      { speed: 60, maxT: 1.2 },
    ];
    let solved = 0;
    let none = 0;
    for (let i = 0; i < 6000; i++) {
      const { speed, maxT } = params[i % 3];
      const m = v3(rng.range(-100, 100), rng.range(0, 60), rng.range(-100, 100));
      const dist = rng.range(1, 120);
      const th = rng.range(0, Math.PI * 2);
      const p = add(m, v3(Math.cos(th) * dist, rng.range(-16, 16), Math.sin(th) * dist));
      const sp = rng.range(0, 90);
      const ph = rng.range(0, Math.PI * 2);
      const el = rng.range(-0.7, 0.7);
      const v = v3(Math.cos(ph) * Math.cos(el) * sp, Math.sin(el) * sp, Math.sin(ph) * Math.cos(el) * sp);
      const sol = solveConstantSpeedIntercept(m, p, v, speed, maxT);
      // scan G(t) = |r + v t|² - speed² t²
      const step = 1e-3;
      let first = -1;
      const r = sub(p, m);
      for (let k = 1; k * step <= maxT; k++) {
        const t = k * step;
        const w = add(r, mul(v, t));
        if (dot(w, w) - speed * speed * t * t <= 0) {
          first = k;
          break;
        }
      }
      if (sol) {
        solved++;
        expectIntercept(m, p, v, speed, maxT, sol);
        for (let k = 1; k * step < sol.t - 1e-9; k++) {
          const t = k * step;
          const w = add(r, mul(v, t));
          if (!(dot(w, w) - speed * speed * t * t > 0)) throw new Error(`smaller root before ${sol.t} (case ${i})`);
        }
      } else {
        none++;
        if (first !== -1) throw new Error(`null but G<=0 at t=${first * step} (case ${i})`);
      }
      if (first !== -1) {
        expect(sol).not.toBeNull();
        if (sol) expect(sol.t).toBeLessThanOrEqual(first * step + 1e-9);
      }
    }
    expect(solved).toBeGreaterThan(1000);
    expect(none).toBeGreaterThan(1000);
  });
});

// ---------------------------------------------------------------------------
describe('no NaN / Infinity from either solver', () => {
  it('sweeps extreme magnitudes and degenerate geometry', () => {
    const rng = new Rng(8080);
    const vals = [0, 1e-12, 1e-6, 1, 45, 100, 1e3, 1e6, -1e-6, -45, -100, -1e6];
    let count = 0;
    for (const a of vals) {
      for (const b of vals) {
        for (const c of vals) {
          const p = v3(a, b, c);
          const v = v3(c, a, b);
          const mg = solveMachinegun(M, p, v);
          if (mg) {
            expectValidSolution(M, p, v, mg);
            count++;
          }
          for (const sp of [45, 60, 70]) {
            const ic = solveConstantSpeedIntercept(M, p, v, sp, 4);
            if (ic) {
              expect(Number.isFinite(ic.t)).toBe(true);
              expect(finiteV(ic.direction)).toBe(true);
            }
          }
        }
      }
    }
    expect(count).toBeGreaterThan(50);
    // random unit-scale soup
    for (let i = 0; i < 3000; i++) {
      const p = v3(rng.range(-200, 200), rng.range(-50, 50), rng.range(-200, 200));
      const v = v3(rng.range(-120, 120), rng.range(-60, 60), rng.range(-120, 120));
      const mg = solveMachinegun(M, p, v);
      if (mg) expectValidSolution(M, p, v, mg);
      const ic = solveConstantSpeedIntercept(M, p, v, 45, 4);
      if (ic) {
        expect(Number.isFinite(ic.t)).toBe(true);
        expect(finiteV(ic.direction)).toBe(true);
      }
    }
  });
});
