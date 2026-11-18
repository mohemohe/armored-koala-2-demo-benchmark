import test from 'node:test';
import assert from 'node:assert/strict';
import {
  add, sub, scale, dot, length, normalize, solveBallistic, solveIntercept,
  polynomialRootsInInterval, projectilePosition, segmentSphere, turnToward,
  createPlayerProjectile, advancePlayerProjectile, advanceLinearProjectile, traceBeam,
} from '../src/ballistics.js';
import { updateLock, makeFireControl } from '../src/fire-control.js';
import { FCS, GENERATORS, LEGS, effectiveStats } from '../src/config.js';

const DT = 1 / 120;
const M = [0, 20, 0];
const OPEN_WORLD = { lineOfSight: () => true, traceSegment: () => null };
const CASES = [
  ...[20, 60, 100, 120].map((range, i) => ({ id: `A0${i + 1}`, r: [0, 0, range], v: [0, 0, 0] })),
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
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function cameraToward(muzzle, currentTarget) {
  const position = add(muzzle, [-4, 3, -10]);
  const forward = normalize(sub(currentTarget, position));
  const right = normalize(cross([0, 1, 0], forward)), up = cross(forward, right);
  return {
    position, forward, width: 1280, height: 720,
    project(p) {
      const relative = sub(p, position), depth = dot(relative, forward), focal = 360 / Math.tan(Math.PI / 6);
      return { x: 640 + dot(relative, right) / depth * focal, y: 360 - dot(relative, up) / depth * focal, depth };
    },
  };
}

// Each firing fixture acquires its moving target through the normal production
// FCS. Camera follows its CURRENT centre and never follows a predicted aim point.
function acquire({ r, v }, muzzle = M, seconds = .8, radius = 144) {
  const firePosition = add(muzzle, r);
  const enemy = {
    id: 'test-target', hp: 120, alive: true, radius: .5, velocity: [...v],
    position: sub(firePosition, scale(v, seconds)), previousPosition: sub(firePosition, scale(v, seconds)),
  };
  const lock = { state: 'none', targetId: null, progress: 0 };
  updateLock(lock, [enemy], muzzle, cameraToward(muzzle, enemy.position), OPEN_WORLD, 0, seconds, radius);
  for (let frame = 1; frame <= Math.round(seconds / DT); frame++) {
    enemy.previousPosition = [...enemy.position];
    enemy.position = add(sub(firePosition, scale(v, seconds)), scale(v, frame * DT));
    updateLock(lock, [enemy], muzzle, cameraToward(muzzle, enemy.position), OPEN_WORLD, DT, seconds, radius);
  }
  assert.equal(lock.state, 'locked');
  assert.equal(lock.progress, 1);
  assert.ok(length(sub(enemy.position, firePosition)) < 1e-8);
  return { enemy, lock };
}

function fireAndSimulate(weapon, condition, muzzle = M, lockSeconds = .8, radius = 144) {
  const { enemy, lock } = acquire(condition, muzzle, lockSeconds, radius);
  const control = makeFireControl(weapon, lock, [enemy], muzzle, .8);
  assert.equal(control.status, 'solved');
  if (weapon === 'beam') {
    const hit = traceBeam(muzzle, control.launchDirection, [enemy], OPEN_WORLD);
    assert.equal(hit?.enemy?.id, enemy.id);
    assert.equal(control.predictedFlightSeconds, 0);
    assert.equal(control.residualMeters, 0);
    assert.deepEqual(control.aimPoint, enemy.position);
    return { control, hit, maxTurn: 0 };
  }
  const shot = createPlayerProjectile(weapon, muzzle, control.launchDirection, enemy, .8);
  assert.deepEqual(shot.origin, muzzle);
  assert.ok(Math.abs(length(shot.initialVelocity) - (weapon === 'missile' ? 45 : 100)) <= .001);
  assert.ok(control.residualMeters <= .01);
  const firePosition = [...enemy.position];
  let maxTurn = 0;
  for (let frame = 0; frame < Math.ceil(shot.maxAge / DT); frame++) {
    const time = frame * DT;
    enemy.previousPosition = add(firePosition, scale(enemy.velocity, time));
    enemy.position = add(firePosition, scale(enemy.velocity, time + DT));
    const before = [...shot.direction];
    const result = advancePlayerProjectile(shot, DT, [enemy], OPEN_WORLD, .8 + time);
    const turn = Math.acos(Math.max(-1, Math.min(1, dot(before, shot.direction))));
    maxTurn = Math.max(maxTurn, turn / DT);
    if (weapon === 'missile') assert.ok(turn <= 2 * Math.PI / 3 * DT + 1e-9);
    if (result.hit) {
      assert.equal(result.hit.type, 'enemy');
      assert.equal(result.hit.enemy.id, enemy.id);
      return { control, hit: result.hit, maxTurn, hitAge: shot.age };
    }
    if (result.expired) break;
  }
  assert.fail(`${weapon} ${condition.id} did not hit radius .5 m moving target`);
}

test('A01–A13: 20 normal-lock machinegun launches each hit using actual gravity and relative swept collisions', t => {
  for (const condition of CASES) {
    let largestResidual = 0, hits = 0, flight = 0;
    for (let repetition = 0; repetition < 20; repetition++) {
      const result = fireAndSimulate('machinegun', condition);
      largestResidual = Math.max(largestResidual, result.control.residualMeters);
      flight = result.control.predictedFlightSeconds;
      if (result.hit) hits++;
    }
    assert.equal(hits, 20);
    if (condition.id === 'A13') assert.ok(flight > 1.2 && flight <= 2);
    t.diagnostic(`${condition.id}: ${hits}/20 swept hits; max centre residual ${largestResidual.toExponential(6)} m; predicted t ${flight.toFixed(9)} s`);
  }
});

test('A01–A13: 20 normal-lock beam shots each hit the current position with zero lead', t => {
  for (const condition of CASES) {
    let hits = 0;
    for (let repetition = 0; repetition < 20; repetition++) if (fireAndSimulate('beam', condition).hit) hits++;
    assert.equal(hits, 20);
    t.diagnostic(`${condition.id}: ${hits}/20 immediate current-position beam hits`);
  }
});

test('A05–A07: 20 missiles each hit with speed45 initial lead and <=120°/s homing', t => {
  for (const condition of CASES.slice(4, 7)) {
    let hits = 0, maxTurn = 0;
    for (let repetition = 0; repetition < 20; repetition++) {
      const result = fireAndSimulate('missile', condition);
      if (result.hit) hits++;
      maxTurn = Math.max(maxTurn, result.maxTurn);
      if (condition.id !== 'A07') assert.ok(Math.abs(result.control.launchDirection[0]) > .1);
    }
    assert.equal(hits, 20);
    t.diagnostic(`${condition.id}: ${hits}/20 swept missile hits; max measured turn ${(maxTurn * 180 / Math.PI).toFixed(6)}°/s`);
  }
});

test('FCS uses latest muzzle in glide, flight and QB; launch speed never inherits player velocity', t => {
  const condition = CASES[4];
  for (const [mode, muzzle, playerVelocity] of [
    ['glide', [22, 20, 0], [22, 0, 0]],
    ['flight', [16, 30, 0], [16, 10, 0]],
    ['quickboost', [12, 20, 0], [80, 0, 0]],
  ]) {
    let hits = 0;
    for (let repetition = 0; repetition < 20; repetition++) {
      const result = fireAndSimulate('machinegun', condition, muzzle);
      const velocity = scale(result.control.launchDirection, 100);
      assert.ok(Math.abs(velocity[0] - 8) < 1e-7);
      assert.notDeepEqual(velocity, add(velocity, playerVelocity));
      if (result.hit) hits++;
    }
    t.diagnostic(`${mode}, muzzle [${muzzle}], player velocity [${playerVelocity}]: ${hits}/20 swept hits, initial world speed100 m/s`);
  }
});

test('all18 loadouts use their real lock time/radius and identical ballistic precision', () => {
  for (const fcs of Object.keys(FCS)) for (const generator of Object.keys(GENERATORS)) for (const legs of Object.keys(LEGS)) {
    const stats = effectiveStats({ fcs, generator, legs });
    const result = fireAndSimulate('machinegun', CASES[4], M, stats.lockSeconds, FCS[fcs].radiusRatio * 720);
    assert.ok(result.control.residualMeters <= .01);
    assert.ok(Math.abs(result.control.predictedFlightSeconds - 1.007391236) < 1e-8);
  }
});

test('quartic handles tangent roots, minimal positive root, exact lifetime and unavailable solutions', () => {
  assert.deepEqual(polynomialRootsInInterval([1, -2, 1], 0, 2), [1]);
  const tangent = solveBallistic(M, add(M, [0, -9, 0]), [0, 0, 100]);
  assert.ok(tangent);
  assert.ok(Math.abs(tangent.flightSeconds - 1) < 1e-8);
  const boundary = solveBallistic(M, add(M, [0, -36, 200]), [0, 0, 0]);
  assert.ok(Math.abs(boundary.flightSeconds - 2) < 1e-9);
  assert.equal(solveBallistic(M, add(M, [0, 0, 120]), [0, 0, 101]), null);
  assert.equal(solveBallistic(M, M, [0, 0, 0]), null);
  const many = polynomialRootsInInterval([24, -50, 35, -10, 1], 0, 5);
  assert.equal(many.length, 4);
  many.forEach((root, i) => assert.ok(Math.abs(root - (i + 1)) < 1e-8));
  const reference = solveBallistic(M, add(M, [0, 0, 100]), [8, 0, 0]);
  assert.ok(Math.abs(reference.flightSeconds - 1.007391236) < 1e-8);
  const initial = scale(reference.direction, 100);
  assert.ok(length(sub(initial, [8, 9.066521121, 99.266299391])) < 1e-7);
});

test('intercept quadratic handles linear degeneration and no-solution without nonfinite values', () => {
  const linear = solveIntercept([0, 0, 0], [100, 0, 0], [-45, 0, 0], 45, 4);
  assert.ok(Math.abs(linear.flightSeconds - 100 / 90) < 1e-10);
  assert.equal(solveIntercept([0, 0, 0], [100, 0, 0], [45, 0, 0], 45, 4), null);
  assert.equal(solveIntercept([0, 0, 0], [100, 0, 0], [0, 0, 0], 45, 2), null);
});

test('lock remains stable, rejects both forms of occlusion and resets progress on target invalidation', () => {
  const { enemy, lock } = acquire(CASES[4]);
  const other = { ...enemy, id: 'closer', position: add(M, [0, 0, 50]), previousPosition: add(M, [0, 0, 50]) };
  const camera = cameraToward(M, other.position);
  updateLock(lock, [enemy, other], M, camera, OPEN_WORLD, DT, .8, 144);
  assert.equal(lock.targetId, enemy.id);
  enemy.alive = false;
  updateLock(lock, [enemy, other], M, camera, OPEN_WORLD, DT, .8, 144);
  assert.equal(lock.targetId, other.id);
  assert.equal(lock.progress, 0);
  assert.equal(lock.state, 'acquiring');
  const muzzleOccluded = { lineOfSight: from => from !== M, traceSegment: () => null };
  updateLock(lock, [other], M, camera, muzzleOccluded, DT, .8, 144);
  assert.equal(lock.targetId, null);
  assert.equal(lock.progress, 0);
  const cameraOccluded = { lineOfSight: from => from === M, traceSegment: () => null };
  updateLock(lock, [other], M, camera, cameraOccluded, DT, .8, 144);
  assert.equal(lock.state, 'none');
});

test('inactive schema is all null; no-solution holds lock and reports direct aim; switches retain lock', () => {
  const { enemy, lock } = acquire(CASES[4]);
  const inactive = makeFireControl('missile', { state: 'acquiring', targetId: enemy.id }, [enemy], M, 2);
  for (const [key, value] of Object.entries(inactive)) if (key !== 'status' && key !== 'weapon') assert.equal(value, null);
  enemy.velocity = [0, 0, 101];
  const missing = makeFireControl('machinegun', lock, [enemy], M, 2);
  assert.equal(missing.status, 'no_solution');
  assert.equal(lock.state, 'locked');
  assert.equal(missing.predictedFlightSeconds, null);
  assert.deepEqual(missing.aimPoint, enemy.position);
  const beam = makeFireControl('beam', lock, [enemy], M, 2);
  assert.equal(beam.status, 'solved');
  assert.equal(lock.state, 'locked');
});

test('relative sweep catches moving crossings and wall contact wins; end-of-life segment is tested', () => {
  assert.equal(segmentSphere([0, 0, 0], [10, 0, 0], [5, -5, 0], [5, 5, 0], .5) !== null, true);
  assert.equal(segmentSphere([0, 0, 0], [10, 0, 0], [5, 5, 0], [5, 5, 0], .5), null);
  const enemy = { id: 'wall-behind', hp: 120, alive: true, radius: .5, position: [0, 0, 10], previousPosition: [0, 0, 10], velocity: [0, 0, 0] };
  const wall = { traceSegment: (from, to) => from[2] <= 5 && to[2] >= 5 ? { fraction: (5 - from[2]) / (to[2] - from[2]) } : null };
  assert.equal(traceBeam([0, 0, 0], [0, 0, 1], [enemy], wall).type, 'world');
  const shot = createPlayerProjectile('missile', [0, 0, 0], [0, 0, 1], enemy, 0);
  assert.equal(advancePlayerProjectile(shot, 1, [enemy], wall, 0).hit.type, 'world');
  const linear = { position: [0, 0, 0], velocity: [100, 0, 0], lifetime: .01 };
  const player = { previousPosition: [1, 0, 0], position: [1, 0, 0], radius: .1 };
  assert.equal(advanceLinearProjectile(linear, .1, player, OPEN_WORLD).hit.type, 'player');
});

test('machinegun trajectory is immutable after target turn and lock loss', () => {
  const { enemy, lock } = acquire(CASES[4]);
  const fire = makeFireControl('machinegun', lock, [enemy], M, .8);
  const shot = createPlayerProjectile('machinegun', M, fire.launchDirection, enemy, .8);
  const expected = projectilePosition(shot, .5);
  enemy.velocity = [80, 20, 0]; enemy.previousPosition = [...enemy.position]; enemy.position = add(enemy.position, [40, 10, 0]);
  lock.state = 'none'; lock.targetId = null;
  const result = advancePlayerProjectile(shot, .5, [enemy], OPEN_WORLD, .8);
  assert.equal(result.hit, null);
  assert.ok(length(sub(shot.position, expected)) < 1e-10);
  assert.deepEqual(shot.acceleration, [0, -18, 0]);
});

test('limited turn handles antipodal directions and missile occlusion preserves last observation', () => {
  const angle = .1, turned = turnToward([0, 0, 1], [0, 0, -1], angle);
  assert.ok(Math.abs(Math.acos(dot(turned, [0, 0, 1])) - angle) < 1e-10);
  const target = { id: 'tracked', hp: 120, alive: true, radius: .5, position: [0, 0, 100], previousPosition: [0, 0, 100], velocity: [8, 0, 0] };
  const direction = solveIntercept([0, 0, 0], target.position, target.velocity).direction;
  const shot = createPlayerProjectile('missile', [0, 0, 0], direction, target, 0);
  const last = structuredClone(shot.observation);
  target.position = [0, 100, 100]; target.previousPosition = [0, 100, 100]; target.velocity = [0, 100, 0];
  const hidden = { lineOfSight: () => false, traceSegment: () => null };
  advancePlayerProjectile(shot, .1, [target], hidden, 0);
  assert.deepEqual(shot.observation, last);
  assert.equal(shot.targetId, 'tracked');
  assert.ok(Math.abs(length(shot.direction) - 1) < 1e-10);
  target.position = [100, 0, 0]; target.previousPosition = [100, 0, 0]; target.velocity = [0, 0, 0];
  const directionBeforeSharpTurn = [...shot.direction];
  advancePlayerProjectile(shot, DT, [target], OPEN_WORLD, .1);
  const actualTurn = Math.acos(Math.max(-1, Math.min(1, dot(directionBeforeSharpTurn, shot.direction))));
  assert.ok(Math.abs(actualTurn - 2 * Math.PI / 3 * DT) < 1e-10);
  target.alive = false;
  const before = [...shot.direction];
  advancePlayerProjectile(shot, .1, [target], OPEN_WORLD, .1);
  assert.deepEqual(shot.direction, before);
});
