import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { createEnemies, updateEnemiesAI } from '../src/enemy-ai.js';
import { solveIntercept } from '../src/ballistics.js';

const STEP = 1 / 120;
const close = (actual, expected, tolerance = 1e-7) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const spawn = (id, kind, position) => ({ id, kind, sectorId: 'test', isGateControl: false, position });

function fixture(spawns) {
  const world = {
    enemySpawns: spawns,
    lineOfSight: () => true,
    raycast: () => null,
    navigationDirection: (from, to) => to.clone().sub(from).setY(0).normalize(),
    pathDistance: (from, to) => from.distanceTo(to),
    moveBody(position, velocity, dt) {
      position.addScaledVector(velocity, dt);
      // A physical floor is essential: guards probe downward and otherwise
      // correctly fall, eventually leaving their attack range.
      if (position.y <= 0) {
        position.y = 0;
        velocity.y = Math.max(0, velocity.y);
        return { grounded: true };
      }
      return { grounded: false };
    },
  };
  const player = { position: new Vector3(), previousPosition: new Vector3(), velocity: new Vector3() };
  return { world, player, enemies: createEnemies(world), shots: [], step: 0 };
}

function advance(f, until, beforeStep) {
  while (f.step * STEP < until - 1e-9) {
    const time = f.step * STEP;
    f.player.previousPosition.copy(f.player.position);
    beforeStep?.(time);
    updateEnemiesAI(f.enemies, f.player, time, STEP, f.world, projectile => f.shots.push(projectile));
    f.step++;
  }
}

test('all enemies independently charge and fire exact first-shot and burst schedules without any camera', () => {
  const f = fixture([
    spawn('guard-left', 'guard', [-20, 2, 40]),
    spawn('guard-right', 'guard', [20, 2, 40]),
    spawn('turret', 'turret', [0, 2, 48]),
  ]);
  advance(f, .34);
  assert.ok(f.enemies.every(enemy => enemy.telegraph === 0));
  advance(f, .375);
  assert.ok(f.enemies.every(enemy => enemy.telegraph > 0));
  assert.equal(f.shots.length, 0);
  advance(f, 3);
  for (const enemy of f.enemies) {
    const shots = f.shots.filter(shot => shot.owner === enemy.id);
    const expected = enemy.kind === 'guard' ? [.5, .62, .74, 1.7, 1.82, 1.94, 2.9] : [.7, .95, 2.3, 2.55];
    assert.equal(shots.length, expected.length);
    shots.forEach((shot, index) => {
      close(shot.firedAtSeconds, expected[index]);
      close(shot.velocity.length(), enemy.kind === 'guard' ? 70 : 60);
      assert.equal(shot.damage, enemy.kind === 'guard' ? 18 : 40);
      assert.equal(shot.lifetime, enemy.kind === 'guard' ? 2 : 3);
    });
    assert.equal(enemy.shotsFired, expected.length);
    assert.equal(enemy.hasLineOfSight, true);
  }
});

test('brief cover preserves availability and adds only the required charge on re-exposure', () => {
  const f = fixture([spawn('guard', 'guard', [0, 2, 40])]);
  let now = 0;
  f.world.lineOfSight = () => !(now >= .2 && now < .45);
  advance(f, 2, time => { now = time; });
  const expected = [.6, .72, .84, 1.8, 1.92];
  assert.equal(f.shots.length, expected.length);
  f.shots.forEach((shot, index) => close(shot.firedAtSeconds, expected[index]));
});

test('each individual burst round checks visibility and a hidden round is never emitted', () => {
  const f = fixture([spawn('guard', 'guard', [0, 2, 40])]);
  let now = 0;
  f.world.lineOfSight = () => !(now >= .6 && now < .7);
  advance(f, 2, time => { now = time; });
  const expected = [.5, .74, 1.7, 1.82, 1.94];
  assert.equal(f.shots.length, expected.length);
  f.shots.forEach((shot, index) => close(shot.firedAtSeconds, expected[index]));
});

test('guards pursue the last observed point immediately, never read a concealed position, and forget after eight seconds', () => {
  const f = fixture([spawn('guard', 'guard', [0, 2, 40])]);
  advance(f, STEP);
  const enemy = f.enemies[0];
  const remembered = enemy.lastSeenPosition.clone();
  const oldDistance = enemy.position.distanceTo(remembered);
  f.world.lineOfSight = () => false;
  f.player.position.set(500, 0, 500);
  advance(f, .5);
  assert.equal(enemy.alert, true);
  assert.ok(enemy.position.distanceTo(remembered) < oldDistance - 3);
  assert.ok(enemy.lastSeenPosition.equals(remembered));
  close(Math.hypot(enemy.velocity.x, enemy.velocity.z), 8);
  assert.equal(f.shots.length, 0);
  advance(f, 8.1);
  assert.equal(enemy.alert, false);
  assert.equal(enemy.hasLineOfSight, false);
  assert.equal(enemy.velocity.length(), 0);
  assert.ok(enemy.lastSeenPosition.equals(remembered));
});

test('alert sharing reaches only locally connected allies, and recipients cannot shoot through walls', () => {
  const f = fixture([
    spawn('scout', 'guard', [0, 2, 0]),
    spawn('connected', 'guard', [40, 2, 0]),
    spawn('partitioned', 'guard', [0, 2, 45]),
    spawn('distant', 'guard', [80, 2, 0]),
  ]);
  f.player.position.z = -10;
  f.world.lineOfSight = (from, to) => from.distanceTo(to) < 3 || (Math.abs(from.x) < 5 && Math.abs(from.z) < 5);
  f.world.isConnectedWithin = (from, to, maxDistance) => from.distanceTo(to) <= maxDistance && to.z < 20;
  advance(f, .1);
  const [scout, connected, partitioned, distant] = f.enemies;
  assert.equal(scout.hasLineOfSight, true);
  assert.equal(connected.alert, true);
  assert.equal(connected.hasLineOfSight, false);
  assert.ok(connected.lastSeenPosition.equals(scout.lastSeenPosition));
  assert.ok(connected.position.x < 40);
  assert.equal(connected.shotsFired, 0);
  assert.equal(connected.nextBurstAtSeconds, null);
  assert.equal(partitioned.alert, false);
  assert.equal(distant.alert, false);
});

test('guard chase, strafe, and retreat use actual collision-center velocity', () => {
  for (const [distance, speed] of [[80, 8], [40, 6], [10, 8]]) {
    const f = fixture([spawn('guard', 'guard', [0, 2, distance])]);
    const start = f.enemies[0].position.clone();
    advance(f, STEP);
    const enemy = f.enemies[0];
    close(enemy.velocity.length(), speed);
    assert.ok(enemy.velocity.distanceTo(enemy.position.clone().sub(start).divideScalar(STEP)) < 1e-8);
    if (distance === 80) assert.ok(enemy.velocity.z < 0);
    if (distance === 10) assert.ok(enemy.velocity.z > 0);
    if (distance === 40) close(enemy.velocity.z, 0);
  }
});

test('enemy launch uses the visible current velocity and its own speed for bounded intercept lead', () => {
  const f = fixture([spawn('guard', 'guard', [0, 2, 40])]);
  f.player.velocity.set(6, 0, 0);
  advance(f, .5, time => { f.player.position.x = (time + STEP) * 6; });
  assert.equal(f.shots.length, 1);
  const shot = f.shots[0];
  const targetAtFire = new Vector3(3, 2.2, 0);
  const solution = solveIntercept(shot.position, targetAtFire, f.player.velocity, 70, 1.2);
  assert.ok(solution);
  assert.ok(solution.time <= 1.2);
  assert.ok(shot.velocity.clone().normalize().distanceTo(solution.direction) < 1e-8);
  assert.ok(solution.intercept.x > targetAtFire.x);
});
