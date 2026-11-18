import test from 'node:test';
import assert from 'node:assert/strict';
import { solveMachinegun, solveMissile } from '../src/ballistics.js';

const m = [0, 0, 0];
const g = [0, -18, 0];

const acceptanceCases = [
  { id: 'A01', p: [0, 0, 20], v: [0, 0, 0] },
  { id: 'A02', p: [0, 0, 60], v: [0, 0, 0] },
  { id: 'A03', p: [0, 0, 100], v: [0, 0, 0], referenceTime: 1.0041085294793328 },
  { id: 'A04', p: [0, 0, 120], v: [0, 0, 0] },
  { id: 'A05', p: [0, 0, 100], v: [8, 0, 0], referenceTime: 1.0073912356316267 },
  { id: 'A06', p: [0, 0, 100], v: [-8, 0, 0] },
  { id: 'A07', p: [0, 0, 100], v: [0, 0, 8] },
  { id: 'A08', p: [0, 0, 100], v: [0, 0, -8] },
  { id: 'A09', p: [0, 16, 100], v: [6, 0, 0] },
  { id: 'A10', p: [0, -16, 100], v: [-6, 0, 0] },
  { id: 'A11', p: [0, 3, 100], v: [6, 0, 0] },
  { id: 'A12', p: [0, -3, 100], v: [6, 0, 0] },
  { id: 'A13', p: [0, 0, 120], v: [6, 3, 4], referenceTime: 1.2661379964495224 },
];

function assertValidSolution(result, p, v, s, gravity, maxTime) {
  assert.notEqual(result, null);
  assert.ok(result.t > 0 && result.t <= maxTime);
  assert.ok([
    result.t, result.residual,
    ...result.direction, ...result.initialVelocity,
    ...result.intercept, ...result.aimPoint,
  ].every(Number.isFinite));

  const speedError = Math.abs(Math.hypot(...result.initialVelocity) - s);
  assert.ok(speedError <= 0.001, `speed error: ${speedError}`);
  assert.ok(Math.abs(Math.hypot(...result.direction) - 1) <= 1e-12);

  const target = p.map((value, i) => value + v[i] * result.t);
  const bullet = m.map((value, i) => value + result.initialVelocity[i] * result.t +
    0.5 * gravity[i] * result.t * result.t);
  const measuredResidual = Math.hypot(...bullet.map((value, i) => value - target[i]));
  assert.ok(measuredResidual <= 0.01, `center residual: ${measuredResidual}`);
  assert.ok(Math.abs(result.residual - measuredResidual) <= 1e-9);

  target.forEach((value, i) => {
    assert.ok(Math.abs(result.intercept[i] - value) <= 1e-9);
    assert.ok(Math.abs(result.aimPoint[i] - (value - 0.5 * gravity[i] * result.t ** 2)) <= 1e-9);
    assert.ok(Math.abs(result.initialVelocity[i] - s * result.direction[i]) <= 1e-12);
  });
}

for (const item of acceptanceCases) {
  test(`${item.id}: machinegun intercept, speed, and geometry`, () => {
    const result = solveMachinegun({ m, p: item.p, v: item.v });
    assertValidSolution(result, item.p, item.v, 100, g, 2);
    if (item.referenceTime !== undefined) {
      assert.ok(Math.abs(result.t - item.referenceTime) <= 1e-12,
        `${item.id} time: ${result.t}, reference: ${item.referenceTime}`);
    }
  });
}

test('quartic tangent root is found even when it is at maxTime', () => {
  // The polynomial is (t - 1)^2 * (81*t^2 + 216*t + 208).
  const p = [-8, -12, 0];
  const v = [8, 3, 100];
  const result = solveMachinegun({ m, p, v, maxTime: 1 });
  assertValidSolution(result, p, v, 100, g, 1);
  assert.ok(Math.abs(result.t - 1) <= 1e-12);
  assert.ok(Math.abs(result.residual) <= 1e-9);
});

test('a simple root on the upper time boundary is retained', () => {
  const p = [0, 0, 200];
  const v = [0, 0, 0];
  const result = solveMachinegun({ m, p, v, g: [0, 0, 0], maxTime: 2 });
  assertValidSolution(result, p, v, 100, [0, 0, 0], 2);
  assert.equal(result.t, 2);
});

test('missile A05-A08: mirror symmetry and longitudinal reference times', () => {
  const results = acceptanceCases.slice(4, 8).map((item) =>
    solveMissile({ m, p: item.p, v: item.v }));
  results.forEach((result, i) => {
    const item = acceptanceCases[i + 4];
    assertValidSolution(result, item.p, item.v, 45, [0, 0, 0], 4);
  });

  assert.ok(Math.abs(results[0].t - results[1].t) <= 1e-12);
  assert.ok(Math.abs(results[0].direction[0] + results[1].direction[0]) <= 1e-12);
  assert.ok(Math.abs(results[0].direction[2] - results[1].direction[2]) <= 1e-12);
  assert.ok(Math.abs(results[0].t - 100 / Math.sqrt(45 ** 2 - 8 ** 2)) <= 1e-12);
  assert.ok(Math.abs(results[2].t - 100 / (45 - 8)) <= 1e-12);
  assert.ok(Math.abs(results[3].t - 100 / (45 + 8)) <= 1e-12);
});

test('missile handles exact linear degeneracy', () => {
  const p = [100, 0, 0];
  const v = [-60, 80, 0]; // |v| === s, so the quadratic coefficient is zero.
  const result = solveMissile({ m, p, v, s: 100, maxTime: 2 });
  assertValidSolution(result, p, v, 100, [0, 0, 0], 2);
  assert.ok(Math.abs(result.t - 5 / 6) <= 1e-12);
});

test('missile selects the smallest of two positive roots', () => {
  const p = [100, 0, 0];
  const v = [-120, 0, 0];
  const result = solveMissile({ m, p, v, s: 100, maxTime: 10 });
  assertValidSolution(result, p, v, 100, [0, 0, 0], 10);
  assert.ok(Math.abs(result.t - 5 / 11) <= 1e-12);
});

test('no-solution and invalid-input paths return null, never NaN', () => {
  assert.equal(solveMachinegun({ m, p: [0, 0, 500], v: [0, 0, 0] }), null);
  assert.equal(solveMissile({ m, p: [0, 0, 500], v: [0, 0, 0] }), null);
  assert.equal(solveMachinegun({ m, p: [NaN, 0, 0], v: [0, 0, 0] }), null);
  assert.equal(solveMissile({ m, p: [0, 0, 1], v: [0, 0, 0], maxTime: 0 }), null);
});
