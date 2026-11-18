/**
 * src/sim/ballistics.ts の検証（仕様 §4.3 / §4.4 / §4.6）。
 * A01〜A13 は §4.6 の表そのまま。数値は params.ts から取る。
 */
import { describe, expect, it } from 'vitest';
import { WEAPONS } from '../src/params';
import { quarticRootsInRange, solveLinearLead, solveMachinegunLead } from '../src/sim/ballistics';
import { add, addScaled, distance, length, scale } from '../src/sim/vec';
import type { Vec3 } from '../src/types';

const MG_SPEED = WEAPONS.machinegun.speed;
const MG_GRAVITY: Vec3 = [...WEAPONS.machinegun.gravity] as Vec3;
const MG_MAX_T = WEAPONS.machinegun.solveMaxTime;
const MISSILE_SPEED = WEAPONS.missile.speed;
const MISSILE_MAX_T = WEAPONS.missile.solveMaxTime;

const MUZZLE: Vec3 = [0, 20, 0];

function expectNear(actual: number, expected: number, eps: number, label = ''): void {
  const diff = Math.abs(actual - expected);
  expect(diff, `${label} actual=${actual} expected=${expected} diff=${diff}`).toBeLessThanOrEqual(eps);
}

interface Case {
  id: string;
  r: Vec3;
  v: Vec3;
}

const CASES: Case[] = [
  { id: 'A01', r: [0, 0, 20], v: [0, 0, 0] },
  { id: 'A02', r: [0, 0, 60], v: [0, 0, 0] },
  { id: 'A03', r: [0, 0, 100], v: [0, 0, 0] },
  { id: 'A04', r: [0, 0, 120], v: [0, 0, 0] },
  { id: 'A05', r: [0, 0, 100], v: [8, 0, 0] },
  { id: 'A06', r: [0, 0, 100], v: [-8, 0, 0] },
  { id: 'A07', r: [0, 0, 100], v: [0, 0, 8] },
  { id: 'A08', r: [0, 0, 100], v: [0, 0, -8] },
  { id: 'A09', r: [0, 16, 100], v: [6, 0, 0] },
  { id: 'A10', r: [0, -16, 100], v: [-6, 0, 0] },
  { id: 'A11', r: [0, 0, 100], v: [6, 3, 0] },
  { id: 'A12', r: [0, 0, 100], v: [6, -3, 0] },
  { id: 'A13', r: [0, 0, 120], v: [6, 3, 4] },
];

/** 参考値（§4.6 / ARCHITECTURE §3.3）。許容 1e-6 */
const REFERENCE: Record<string, { t: number; v0?: Vec3 }> = {
  A03: { t: 1.004108529, v0: [0, 9.036976765, 99.590828147] },
  A05: { t: 1.007391236, v0: [8, 9.066521121, 99.266299391] },
  A13: { t: 1.266137996 },
};

/** 多項式（昇べき順）の積 */
function polyMul(a: number[], b: number[]): number[] {
  const out = new Array<number>(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) out[i + j] += a[i] * b[j];
  return out;
}

/** 昇べき順係数（長さ 5 に 0 埋め）を quarticRootsInRange へ渡す */
function rootsOf(coeffs: number[], maxT: number): number[] {
  const c = [...coeffs];
  while (c.length < 5) c.push(0);
  expect(c.length).toBe(5);
  return quarticRootsInRange(c[4], c[3], c[2], c[1], c[0], maxT);
}

describe('solveMachinegunLead: §4.6 A01-A13', () => {
  const lines: string[] = [];

  for (const c of CASES) {
    it(`${c.id} r=(${c.r.join(',')}) v=(${c.v.join(',')})`, () => {
      const sol = solveMachinegunLead(c.r, c.v, MG_SPEED, MG_GRAVITY, MG_MAX_T);
      expect(sol, `${c.id}: solution must exist`).not.toBeNull();
      if (!sol) return;
      const { t, direction, residualMeters } = sol;

      expect(Number.isFinite(t)).toBe(true);
      expect(t).toBeGreaterThan(0);
      expect(t).toBeLessThanOrEqual(MG_MAX_T);
      expectNear(length(direction), 1, 1e-9, `${c.id} |direction|`);

      const v0 = scale(direction, MG_SPEED);
      expectNear(length(v0), MG_SPEED, 0.001, `${c.id} |v0|`);
      expect(residualMeters).toBeLessThanOrEqual(0.01);
      expect(residualMeters).toBeLessThanOrEqual(1e-6);

      // 中心距離検査: 弾体 m + s d t + 0.5 g t² と 対象 p + v t
      const p = add(MUZZLE, c.r);
      const bullet = addScaled(addScaled(MUZZLE, v0, t), MG_GRAVITY, 0.5 * t * t);
      const target = addScaled(p, c.v, t);
      const centerDist = distance(bullet, target);
      expect(centerDist, `${c.id} center distance`).toBeLessThanOrEqual(0.01);
      expect(centerDist).toBeLessThanOrEqual(1e-6);

      const ref = REFERENCE[c.id];
      if (ref) {
        expectNear(t, ref.t, 1e-6, `${c.id} t`);
        if (ref.v0) {
          expectNear(v0[0], ref.v0[0], 1e-6, `${c.id} v0.x`);
          expectNear(v0[1], ref.v0[1], 1e-6, `${c.id} v0.y`);
          expectNear(v0[2], ref.v0[2], 1e-6, `${c.id} v0.z`);
        }
      }

      lines.push(
        `${c.id} r=(${c.r.join(',')}) v=(${c.v.join(',')}) t=${t.toFixed(9)} v0=(${v0.map((x) => x.toFixed(9)).join(', ')}) residual=${residualMeters.toExponential(3)} centerDist=${centerDist.toExponential(3)}`,
      );
    });
  }

  it('prints A01-A13 solutions for the README', () => {
    expect(lines.length).toBe(CASES.length);
    console.log(['[ballistics] machinegun solutions (speed=100, g=(0,-18,0), maxT=2):', ...lines].join('\n'));
  });
});

describe('solveMachinegunLead: root selection and boundaries', () => {
  it('chooses the smallest of two positive roots (low arc)', () => {
    // 遅い弾（10 m/s）で 5 m 先: 81 t⁴ − 100 t² + 25 = 0 → t² = (100 ± √1900)/162 → 2 つの正の根が (0,2] にある
    const speed = 10;
    const r: Vec3 = [0, 0, 5];
    const roots = quarticRootsInRange(81, 0, -100, 0, 25, 2);
    expect(roots.length).toBe(2);
    const tLow = Math.sqrt((100 - Math.sqrt(100 * 100 - 4 * 81 * 25)) / 162);
    const tHigh = Math.sqrt((100 + Math.sqrt(100 * 100 - 4 * 81 * 25)) / 162);
    expectNear(roots[0], tLow, 1e-9, 'low root');
    expectNear(roots[1], tHigh, 1e-9, 'high root');

    const sol = solveMachinegunLead(r, [0, 0, 0], speed, MG_GRAVITY, 2);
    expect(sol).not.toBeNull();
    if (!sol) return;
    expectNear(sol.t, tLow, 1e-9, 'chosen t');
    expect(sol.t).toBeLessThan(tHigh);
    expect(sol.residualMeters).toBeLessThanOrEqual(1e-9);
  });

  it('returns null when the target is too far (r=(0,0,300))', () => {
    expect(solveMachinegunLead([0, 0, 300], [0, 0, 0], MG_SPEED, MG_GRAVITY, MG_MAX_T)).toBeNull();
  });

  it('returns null for a target receding at 150 m/s', () => {
    expect(solveMachinegunLead([0, 0, 100], [0, 0, 150], MG_SPEED, MG_GRAVITY, MG_MAX_T)).toBeNull();
  });

  it('respects the maxT boundary: root slightly above maxT → null, root exactly at maxT → accepted', () => {
    const base = solveMachinegunLead([0, 0, 100], [0, 0, 0], MG_SPEED, MG_GRAVITY, MG_MAX_T);
    expect(base).not.toBeNull();
    if (!base) return;
    const tStar = base.t;
    // 唯一の根が maxT を僅かに超える
    expect(solveMachinegunLead([0, 0, 100], [0, 0, 0], MG_SPEED, MG_GRAVITY, tStar - 1e-6)).toBeNull();
    expect(solveMachinegunLead([0, 0, 100], [0, 0, 0], MG_SPEED, MG_GRAVITY, 1.0)).toBeNull();
    // 根がちょうど端点
    const atEdge = solveMachinegunLead([0, 0, 100], [0, 0, 0], MG_SPEED, MG_GRAVITY, tStar);
    expect(atEdge).not.toBeNull();
    if (atEdge) expectNear(atEdge.t, tStar, 1e-9, 'edge t');
  });

  it('never returns NaN/Infinity for tiny |r|', () => {
    expect(solveMachinegunLead([0, 0, 0], [0, 0, 0], MG_SPEED, MG_GRAVITY, MG_MAX_T)).toBeNull();
    expect(solveMachinegunLead([1e-9, 0, 0], [1, 0, 0], MG_SPEED, MG_GRAVITY, MG_MAX_T)).toBeNull();
    const tiny = solveMachinegunLead([1e-4, 0, 0], [0, 0, 0], MG_SPEED, MG_GRAVITY, MG_MAX_T);
    if (tiny) {
      expect(Number.isFinite(tiny.t)).toBe(true);
      expect(tiny.direction.every((x) => Number.isFinite(x))).toBe(true);
      expect(Number.isFinite(tiny.residualMeters)).toBe(true);
      expectNear(length(tiny.direction), 1, 1e-9);
      expect(tiny.residualMeters).toBeLessThanOrEqual(0.01);
    }
    expect(solveMachinegunLead([Number.NaN, 0, 100], [0, 0, 0], MG_SPEED, MG_GRAVITY, MG_MAX_T)).toBeNull();
    expect(solveMachinegunLead([0, 0, 100], [0, 0, 0], MG_SPEED, [0, Number.POSITIVE_INFINITY, 0], MG_MAX_T)).toBeNull();
  });

  it('reduces to the linear-lead quadratic when gravity is zero', () => {
    const r: Vec3 = [0, 0, 100];
    const v: Vec3 = [8, 0, 0];
    const mg = solveMachinegunLead(r, v, MG_SPEED, [0, 0, 0], MG_MAX_T);
    const lin = solveLinearLead(r, v, MG_SPEED, MG_MAX_T);
    expect(mg).not.toBeNull();
    expect(lin).not.toBeNull();
    if (!mg || !lin) return;
    expectNear(mg.t, lin.t, 1e-9, 'gravity-free t');
    expectNear(mg.direction[0], lin.direction[0], 1e-9);
    expectNear(mg.direction[1], lin.direction[1], 1e-9);
    expectNear(mg.direction[2], lin.direction[2], 1e-9);
  });
});

describe('quarticRootsInRange', () => {
  it('detects a tangent (double) root: (t−a)²(t−b)(t−c)', () => {
    const a = 0.7;
    const b = 1.5;
    const c = 3.0; // 範囲外
    const coeffs = polyMul(polyMul([a * a, -2 * a, 1], [-b, 1]), [-c, 1]);
    const roots = rootsOf(coeffs, 2);
    expect(roots.length).toBe(2);
    expectNear(roots[0], a, 1e-7, 'double root');
    expectNear(roots[1], b, 1e-9, 'simple root');
  });

  it('detects a double root when the polynomial never changes sign: (t−a)²(t²+1)', () => {
    const a = 1.25;
    const coeffs = polyMul([a * a, -2 * a, 1], [1, 0, 1]);
    const roots = rootsOf(coeffs, 2);
    expect(roots.length).toBe(1);
    expectNear(roots[0], a, 1e-7, 'double root without sign change');
  });

  it('includes a root exactly at t=maxT and excludes t=0', () => {
    // t (t−2)(t−5)(t²+1)
    const coeffs = polyMul(polyMul([0, 1], [-2, 1]), [-5, 1]);
    const roots = rootsOf(coeffs, 2);
    expect(roots.length).toBe(1);
    expectNear(roots[0], 2, 1e-9, 'root at maxT');
    const above = rootsOf(coeffs, 1.999999);
    expect(above.length).toBe(0);
  });

  it('returns four simple roots in ascending order', () => {
    const rs = [0.3, 0.9, 1.4, 1.9];
    let coeffs = [1];
    for (const x of rs) coeffs = polyMul(coeffs, [-x, 1]);
    const roots = rootsOf(coeffs, 2);
    expect(roots.length).toBe(4);
    for (let i = 0; i < 4; i++) expectNear(roots[i], rs[i], 1e-9, `root ${i}`);
  });

  it('handles degenerate degrees (c4=0 cubic, quadratic, linear, all-zero)', () => {
    // 3 次: (t−0.5)(t−1)(t−1.8)
    const cubic = polyMul(polyMul([-0.5, 1], [-1, 1]), [-1.8, 1]);
    const r3 = rootsOf(cubic, 2);
    expect(r3.length).toBe(3);
    expectNear(r3[0], 0.5, 1e-9);
    expectNear(r3[1], 1, 1e-9);
    expectNear(r3[2], 1.8, 1e-9);
    // 2 次: (t−0.25)(t−1.75)
    const r2 = rootsOf(polyMul([-0.25, 1], [-1.75, 1]), 2);
    expect(r2.length).toBe(2);
    expectNear(r2[0], 0.25, 1e-9);
    expectNear(r2[1], 1.75, 1e-9);
    // 2 次の重根: (t−1.1)²
    const r2d = rootsOf(polyMul([-1.1, 1], [-1.1, 1]), 2);
    expect(r2d.length).toBe(1);
    expectNear(r2d[0], 1.1, 1e-7);
    // 1 次: 3t − 4.5
    const r1 = rootsOf([-4.5, 3], 2);
    expect(r1.length).toBe(1);
    expectNear(r1[0], 1.5, 1e-12);
    // 定数・恒等 0
    expect(rootsOf([5], 2)).toEqual([]);
    expect(rootsOf([0], 2)).toEqual([]);
    // 無効な maxT
    expect(quarticRootsInRange(1, 0, 0, 0, -1, 0)).toEqual([]);
  });
});

describe('quarticRootsInRange: regression (reviewer issues)', () => {
  /** 与えられた 2 点で厳密に符号が変わることを確認（真の根を挟むことの保証） */
  function expectBracketedRoot(coeffs: number[], root: number, halfWidth: number): void {
    const f = (t: number) => coeffs.reduce((acc, c, i) => acc + c * Math.pow(t, i), 0);
    const fa = f(root - halfWidth);
    const fb = f(root + halfWidth);
    expect(fa !== 0 && fb !== 0 && (fa < 0) !== (fb < 0), `sign change around ${root}`).toBe(true);
  }

  it('near-double root: returns exactly the two genuine roots, not the critical point between them', () => {
    // (t−1.25)²(t²+1) − 2e-8: 真の根は 1.25 ± 8.83e-5。1.25 は根ではない（f(1.25) = −2e-8）
    const coeffs = polyMul([1.5625, -2.5, 1], [1, 0, 1]);
    coeffs[0] -= 2e-8;
    const roots = rootsOf(coeffs, 2);
    expect(roots.length).toBe(2);
    expectNear(roots[0], 1.2499116509707164, 1e-9, 'lower root');
    expectNear(roots[1], 1.2500883414143118, 1e-9, 'upper root');
    for (const r of roots) expectBracketedRoot(coeffs, r, 1e-7);
    expect(roots.some((r) => Math.abs(r - 1.25) < 1e-6)).toBe(false);
  });

  it('near-double root in the real machinegun quartic (speed 10, R = Rmax(1−1e-9)) yields two roots and the smaller is chosen', () => {
    const speed = 10;
    const g = 18;
    const rMax = (speed * speed) / g;
    const R = rMax * (1 - 1e-9);
    // 81 t⁴ − 100 t² + R² = 0 → t² = (100 ± √(10⁴ − 324 R²)) / 162
    const disc = Math.sqrt(100 * 100 - 4 * 81 * R * R);
    const tLow = Math.sqrt((100 - disc) / 162);
    const tHigh = Math.sqrt((100 + disc) / 162);
    expect(tHigh - tLow).toBeGreaterThan(1e-5);
    const roots = quarticRootsInRange(81, 0, -100, 0, R * R, 2);
    expect(roots.length).toBe(2);
    expectNear(roots[0], tLow, 1e-9, 'low root');
    expectNear(roots[1], tHigh, 1e-9, 'high root');

    const sol = solveMachinegunLead([0, 0, R], [0, 0, 0], speed, [0, -g, 0], 2);
    expect(sol).not.toBeNull();
    if (!sol) return;
    expectNear(sol.t, tLow, 1e-9, 'chosen t');
    expect(sol.residualMeters).toBeLessThanOrEqual(1e-9);
  });

  it('still detects the exact tangent (max-range) root for the machinegun quartic', () => {
    const speed = 10;
    const g = 18;
    const rMax = (speed * speed) / g;
    const roots = quarticRootsInRange(81, 0, -100, 0, rMax * rMax, 2);
    expect(roots.length).toBeGreaterThanOrEqual(1);
    expect(roots.length).toBeLessThanOrEqual(2);
    for (const r of roots) expectNear(r, Math.sqrt(100 / 162), 1e-6, 'tangent root');
    const sol = solveMachinegunLead([0, 0, rMax], [0, 0, 0], speed, [0, -g, 0], 2);
    expect(sol).not.toBeNull();
    if (!sol) return;
    expectNear(sol.t, Math.sqrt(100 / 162), 1e-6, 'tangent t');
    expectNear(sol.direction[1], Math.SQRT1_2, 1e-6, '45° elevation');
    expect(sol.residualMeters).toBeLessThanOrEqual(0.01);
  });

  it('does not fabricate a root for a polynomial with no real roots, regardless of maxT', () => {
    // (t−1)⁴ + 1e-3: 最小値 1e-3 > 0
    for (const maxT of [2, 4, 10, 100, 1000, 1e4]) {
      expect(quarticRootsInRange(1, -4, 6, -4, 1.001, maxT), `maxT=${maxT}`).toEqual([]);
    }
    // (t−1.25)²(t²+1) + 5e-8: 最小値 5e-8 > 0
    const coeffs = polyMul([1.5625, -2.5, 1], [1, 0, 1]);
    coeffs[0] += 5e-8;
    expect(rootsOf(coeffs, 2)).toEqual([]);
    // 同じ形の機関銃 4 次式で射程を 1e-6 相対だけ超える（解なし）
    const speed = 10;
    const g = 18;
    const R = ((speed * speed) / g) * (1 + 1e-6);
    expect(quarticRootsInRange(81, 0, -100, 0, R * R, 2)).toEqual([]);
    expect(solveMachinegunLead([0, 0, R], [0, 0, 0], speed, [0, -g, 0], 2)).toBeNull();
  });

  it('accepts a root exactly at maxT without duplicating a bracketed root just inside', () => {
    // (t−0.5)(t−1.2)(t−2)(t+1) with maxT=2 → 3 roots; maxT = 2 − 1e-7 → root 2 is outside → 2 roots
    let coeffs = [1];
    for (const x of [0.5, 1.2, 2, -1]) coeffs = polyMul(coeffs, [-x, 1]);
    const atEdge = rootsOf(coeffs, 2);
    expect(atEdge.length).toBe(3);
    expectNear(atEdge[2], 2, 1e-9, 'root at maxT');
    const inside = rootsOf(coeffs, 2 - 1e-7);
    expect(inside.length).toBe(2);
  });
});

describe('solveLinearLead (§4.4 / §2.3)', () => {
  it('handles the v·v = speed² linear case', () => {
    const r: Vec3 = [-30, 0, 40];
    const v: Vec3 = [MISSILE_SPEED, 0, 0];
    const sol = solveLinearLead(r, v, MISSILE_SPEED, MISSILE_MAX_T);
    expect(sol).not.toBeNull();
    if (!sol) return;
    const b = 2 * (r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
    const c = r[0] * r[0] + r[1] * r[1] + r[2] * r[2];
    expectNear(sol.t, -c / b, 1e-12, 'linear t');
    expectNear(length(sol.direction), 1, 1e-12);
    expect(sol.residualMeters).toBeLessThanOrEqual(1e-9);
    const w = addScaled(r, v, sol.t);
    expectNear(length(w), MISSILE_SPEED * sol.t, 1e-9, 'intercept consistency');
  });

  it('returns null in the linear case when r·v = 0 (no solution)', () => {
    expect(solveLinearLead([0, 0, 100], [MISSILE_SPEED, 0, 0], MISSILE_SPEED, MISSILE_MAX_T)).toBeNull();
  });

  it('solves the standard quadratic case (crossing target)', () => {
    const r: Vec3 = [0, 0, 100];
    const v: Vec3 = [8, 0, 0];
    const sol = solveLinearLead(r, v, MISSILE_SPEED, MISSILE_MAX_T);
    expect(sol).not.toBeNull();
    if (!sol) return;
    const a = 64 - MISSILE_SPEED * MISSILE_SPEED;
    const expected = Math.sqrt(-10000 / a);
    expectNear(sol.t, expected, 1e-9, 'quadratic t');
    expect(sol.t).toBeLessThanOrEqual(MISSILE_MAX_T);
    const w = addScaled(r, v, sol.t);
    expectNear(length(w), MISSILE_SPEED * sol.t, 1e-9, 'intercept consistency');
    expectNear(sol.direction[0], w[0] / length(w), 1e-12);
    expectNear(sol.direction[2], w[2] / length(w), 1e-12);
    expect(sol.residualMeters).toBeLessThanOrEqual(1e-9);
  });

  it('returns null when the target recedes faster than the projectile', () => {
    expect(solveLinearLead([0, 0, 100], [0, 0, 60], MISSILE_SPEED, MISSILE_MAX_T)).toBeNull();
  });

  it('returns null when the only root exceeds maxT', () => {
    // 静止標的 200 m、45 m/s → t = 4.44 > 4
    expect(solveLinearLead([0, 0, 200], [0, 0, 0], MISSILE_SPEED, MISSILE_MAX_T)).toBeNull();
    // 敵 AI の上限 1.2 秒: 100 m / 70 m/s = 1.43 > 1.2
    expect(solveLinearLead([0, 0, 100], [0, 0, 0], 70, 1.2)).toBeNull();
  });

  it('static target: t = |r| / speed', () => {
    const r: Vec3 = [30, -10, 80];
    const sol = solveLinearLead(r, [0, 0, 0], MISSILE_SPEED, MISSILE_MAX_T);
    expect(sol).not.toBeNull();
    if (!sol) return;
    expectNear(sol.t, length(r) / MISSILE_SPEED, 1e-12, 'static t');
    const n = length(r);
    expectNear(sol.direction[0], r[0] / n, 1e-12);
    expectNear(sol.direction[1], r[1] / n, 1e-12);
    expectNear(sol.direction[2], r[2] / n, 1e-12);
    expect(sol.residualMeters).toBeLessThanOrEqual(1e-9);
  });

  it('picks the smaller positive root when both are positive (approaching target)', () => {
    // 遅い弾（10 m/s）に対して 30 m/s で接近: a = 800, b = −6000 (r=(0,0,100), v=(0,0,−30)), c = 10000
    const r: Vec3 = [0, 0, 100];
    const v: Vec3 = [0, 0, -30];
    const sol = solveLinearLead(r, v, 10, 100);
    expect(sol).not.toBeNull();
    if (!sol) return;
    const a = 900 - 100;
    const b = 2 * -3000;
    const c = 10000;
    const disc = b * b - 4 * a * c;
    const t1 = (-b - Math.sqrt(disc)) / (2 * a);
    const t2 = (-b + Math.sqrt(disc)) / (2 * a);
    expect(t1).toBeGreaterThan(0);
    expect(t2).toBeGreaterThan(t1);
    expectNear(sol.t, t1, 1e-9, 'smaller root');
  });

  it('never returns NaN for r = 0 or invalid inputs', () => {
    expect(solveLinearLead([0, 0, 0], [1, 0, 0], MISSILE_SPEED, MISSILE_MAX_T)).toBeNull();
    expect(solveLinearLead([Number.NaN, 0, 0], [1, 0, 0], MISSILE_SPEED, MISSILE_MAX_T)).toBeNull();
    expect(solveLinearLead([0, 0, 10], [0, 0, 0], MISSILE_SPEED, 0)).toBeNull();
  });
});
