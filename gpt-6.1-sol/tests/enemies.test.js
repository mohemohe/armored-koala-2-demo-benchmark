import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnemies, updateEnemies, ENEMY_STATS } from '../src/enemies.js';
import { advanceLinearProjectile, solveIntercept } from '../src/ballistics.js';
import { STAGE, createWorld } from '../src/stage.js';

const dt = 1 / 120;
const near = (actual, expected, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const player = position => ({ position: position.slice(), previousPosition: position.slice(), velocity: [0, 0, 0], hp: 1000, halfExtents: [1.2, 2.1, 1.2] });
const definition = (id, kind, position, sectorId = 'A') => ({ id, kind, position, sectorId, isGateControl: false });
function openWorld() {
  return {
    lineOfSight: () => true,
    traceSegment: () => null,
    pathDistance: (a, b) => Math.hypot(...a.map((x, i) => x - b[i])),
    navDirection: (p, q) => { const d = [q[0] - p[0], 0, q[2] - p[2]], n = Math.hypot(d[0], d[2]); return n > 0 ? d.map(x => x / n) : [0, 0, 0]; },
    moveBody: (p, v, step) => ({ position: p.map((x, i) => x + v[i] * step), velocity: v.slice(), grounded: true }),
  };
}

function advanceAI(enemies, target, world, seconds, shots, start = 0) {
  let time = start;
  const end = start + seconds;
  while (time < end - 1e-10) {
    const step = Math.min(dt, end - time);
    updateEnemies(enemies, target, world, step, time, shot => shots.push(shot));
    time += step;
  }
  return time;
}

test('enemy definitions are copied and reset with exact health and independent state', () => {
  const defs = [definition('G-1', 'guard', [40, 2.1, 0]), definition('T-1', 'turret', [0, 2.1, 45])];
  const enemies = createEnemies(defs);
  assert.deepEqual(enemies.map(e => e.hp), [120, 240]);
  enemies[0].position[0] = 999;
  assert.equal(defs[0].position[0], 40);
  assert.equal(enemies[0].shotsFired, 0);
  assert.equal(enemies[0].lastShotAtSeconds, null);
  assert.equal(enemies[0].firstSeenAtSeconds, null);
  assert.equal(enemies[0].nextBurstAtSeconds, null);
  assert.deepEqual(createEnemies(defs)[0].position, defs[0].position);
});

test('independent initial delays, warning windows and exact repeated burst times', () => {
  const enemies = createEnemies([definition('G-1', 'guard', [40, 2.1, 0]), definition('G-2', 'guard', [-45, 2.1, 0]), definition('T-1', 'turret', [0, 2.1, 50])]);
  const target = player([0, 2.1, 0]), world = openWorld(), shots = [];
  // Eliminate movement only in this timing fixture, to isolate the schedule.
  world.moveBody = (p, v) => ({ position: p.slice(), velocity: [0, 0, 0] });
  advanceAI(enemies, target, world, .349, shots);
  assert.equal(enemies[0].warning, false);
  advanceAI(enemies, target, world, .002, shots, .349);
  assert.equal(enemies[0].warning, true);
  assert.equal(enemies[2].warning, true); // turret's .70 -.35 window
  assert.equal(shots.length, 0);
  advanceAI(enemies, target, world, 3.849, shots, .351);
  const expectedGuard = [.5, .62, .74, 1.7, 1.82, 1.94, 2.9, 3.02, 3.14, 4.1];
  const expectedTurret = [.7, .95, 2.3, 2.55, 3.9, 4.15];
  for (const id of ['G-1', 'G-2', 'T-1']) {
    const actual = shots.filter(s => s.enemyId === id);
    const expected = id === 'T-1' ? expectedTurret : expectedGuard;
    assert.equal(actual.length, expected.length);
    actual.forEach((shot, i) => near(shot.firedAtSeconds, expected[i]));
    assert.equal(enemies.find(e => e.id === id).shotsFired, actual.length);
    const spec = ENEMY_STATS[id === 'T-1' ? 'turret' : 'guard'];
    actual.forEach(shot => { near(Math.hypot(...shot.velocity), spec.speed); assert.equal(shot.damage, spec.damage); assert.equal(shot.lifetime, spec.lifetime); });
  }
});

test('enemy linear lead uses current velocity, caps prediction at 1.20s and has no gravity', () => {
  const enemies = createEnemies([definition('T-1', 'turret', [0, 2.1, 100])]);
  const target = player([0, 2.1, 0]);
  target.velocity = [30, 0, 0];
  const shots = [];
  advanceAI(enemies, target, openWorld(), .71, shots);
  assert.equal(shots.length, 1);
  const shot = shots[0];
  const solution = solveIntercept(shot.muzzle, target.position, target.velocity, 60, 3);
  assert.ok(solution.flightSeconds > 1.2);
  const aim = target.position.map((x, i) => x + target.velocity[i] * 1.2);
  const d = aim.map((x, i) => x - shot.muzzle[i]), n = Math.hypot(...d);
  shot.direction.forEach((x, i) => near(x, d[i] / n));
  assert.deepEqual(shot.acceleration, [0, 0, 0]);
  const before = shot.position.slice();
  advanceLinearProjectile(shot, .2, player([500, 2.1, 500]), openWorld());
  shot.position.forEach((x, i) => near(x, before[i] + shot.velocity[i] * .2));
});

test('enemy lead really hits a moving player and fired rounds retain their initial direction', () => {
  const enemies = createEnemies([definition('T-1', 'turret', [0, 2.1, 45])]);
  const target = player([0, 2.1, 0]), world = openWorld();
  target.velocity = [10, 0, 0];
  let shot = null, hit = false, time = 0;
  while (time < 2 && !hit) {
    target.previousPosition = target.position.slice();
    target.position[0] += 10 * dt;
    updateEnemies(enemies, target, world, dt, time, fired => { shot ??= fired; });
    if (shot) {
      const duration = Math.max(0, Math.min(dt, time + dt - shot.firedAtSeconds));
      const beforeDirection = shot.direction.slice();
      const result = advanceLinearProjectile(shot, duration, target, world);
      assert.deepEqual(shot.direction, beforeDirection);
      if (result.hit?.type === 'player') hit = true;
    }
    time += dt;
  }
  assert.equal(hit, true);
  assert.ok(shot.direction[0] > 0);
  assert.ok(time < 1.6);
  near(Math.hypot(...shot.initialVelocity), 60);
});

test('a shot between substep endpoints uses target position and velocity at its own fire time', () => {
  const enemies = createEnemies([definition('T-1', 'turret', [0, 2.1, 45])]);
  const target = player([0, 2.1, 0]), world = openWorld(), shots = [];
  advanceAI(enemies, target, world, .696, shots);
  assert.equal(shots.length, 0);
  target.previousPosition = [0, 2.1, 0];
  target.position = [.08, 2.1, 0];
  target.previousVelocity = [0, 0, 0];
  target.velocity = [20, 0, 0];
  updateEnemies(enemies, target, world, .008, .696, shot => shots.push(shot));
  assert.equal(shots.length, 1);
  near(shots[0].firedAtSeconds, .7);
  const expected = solveIntercept(shots[0].muzzle, [.04, 2.1, 0], [10, 0, 0], 60, 3);
  assert.ok(expected.flightSeconds < 1.2);
  shots[0].direction.forEach((x, i) => near(x, expected.direction[i]));
  const futureVelocity = solveIntercept(shots[0].muzzle, [.04, 2.1, 0], [20, 0, 0], 60, 3);
  assert.ok(Math.abs(shots[0].direction[0] - futureVelocity.direction[0]) > .1);
});

test('each burst shot checks muzzle LOS; brief cover preserves cooldown and memory', () => {
  const enemy = createEnemies([definition('G-1', 'guard', [40, 2.1, 0])])[0];
  const target = player([0, 2.1, 0]), world = openWorld(), shots = [];
  world.moveBody = (p, v) => ({ position: p.slice(), velocity: [0, 0, 0] });
  let visible = true;
  world.lineOfSight = () => visible;
  advanceAI([enemy], target, world, .51, shots);
  assert.equal(shots.length, 1);
  visible = false;
  const remembered = enemy.lastSeenPosition.slice();
  target.position = [30, 2.1, 30];
  target.previousPosition = target.position.slice();
  advanceAI([enemy], target, world, .30, shots, .51);
  assert.equal(shots.length, 1); // .62 and .74 rounds were occluded
  assert.equal(enemy.alert, true);
  assert.deepEqual(enemy.lastSeenPosition, remembered);
  near(enemy.nextBurstAtSeconds, 1.7);
  visible = true;
  advanceAI([enemy], target, world, .9, shots, .81);
  assert.equal(shots.length, 2);
  near(shots[1].firedAtSeconds, 1.7); // no repeated .50 second first wait
  visible = false;
  advanceAI([enemy], target, world, 8.1, shots, 1.71);
  assert.equal(enemy.alert, false);
});

test('cover after a completed burst resumes with required telegraph and retained ready time', () => {
  const enemies = createEnemies([definition('T-1', 'turret', [0, 2.1, 45])]);
  const target = player([0, 2.1, 0]), world = openWorld(), shots = [];
  let visible = true;
  world.lineOfSight = () => visible;
  advanceAI(enemies, target, world, 1, shots);
  visible = false;
  advanceAI(enemies, target, world, 2, shots, 1);
  assert.equal(shots.length, 2);
  near(enemies[0].nextBurstAtSeconds, 2.3);
  visible = true;
  advanceAI(enemies, target, world, .36, shots, 3);
  assert.equal(shots.length, 3);
  near(shots[2].firedAtSeconds, 3.35);
});

test('memory sharing is constrained by 60m walkable distance and does not grant wall shots', () => {
  const enemies = createEnemies([
    definition('G-seeing', 'guard', [-20, 2.1, 0]),
    definition('G-near', 'guard', [20, 2.1, 0]),
    definition('G-detour', 'guard', [22, 2.1, 8]),
    definition('G-unrelated', 'guard', [200, 2.1, 0], 'B'),
  ]);
  const target = player([0, 2.1, 35]), world = openWorld(), shots = [];
  world.lineOfSight = (a, b) => a[0] < 0;
  world.pathDistance = (a, b) => b[2] > 5 ? 80 : Math.hypot(...a.map((x, i) => x - b[i]));
  advanceAI(enemies, target, world, .2, shots);
  assert.equal(enemies[1].alert, true);
  assert.equal(enemies[1].hasLineOfSight, false);
  assert.ok(enemies[1].position[2] > 0); // moves to the reported last position
  assert.equal(enemies[2].alert, false); // close in space, >60m by a corridor
  assert.equal(enemies[3].alert, false);
  assert.equal(enemies[1].firstSeenAtSeconds, null);
  assert.equal(shots.length, 0);
});

test('guards use navigation immediately after cover and report physical center velocity', () => {
  const enemies = createEnemies([definition('G-1', 'guard', [60, 2.1, 0])]);
  const target = player([0, 2.1, 0]), world = openWorld(), shots = [];
  let visible = true, navigationCalls = 0;
  world.lineOfSight = () => visible;
  world.navDirection = () => { navigationCalls++; return [0, 0, 1]; };
  updateEnemies(enemies, target, world, dt, 0, s => shots.push(s));
  visible = false;
  target.position = [70, 2.1, -70];
  target.previousPosition = target.position.slice();
  const before = enemies[0].position.slice();
  updateEnemies(enemies, target, world, dt, dt, s => shots.push(s));
  assert.ok(navigationCalls >= 2);
  near(enemies[0].velocity[2], 8);
  near(enemies[0].position[2] - before[2], 8 * dt);
  assert.deepEqual(enemies[0].lastSeenPosition, [0, 2.1, 0]);
});

test('a guard walks around an allied body instead of pushing through or remaining stuck', () => {
  const enemies = createEnemies([definition('G-behind', 'guard', [70, 2.1, 0]), definition('T-blocking', 'turret', [63, 2.1, 0])]);
  const target = player([0, 2.1, 0]), world = openWorld();
  let time = 0;
  while (time < 2) {
    updateEnemies(enemies, target, world, dt, time, () => {});
    const a = enemies[0].position, b = enemies[1].position;
    assert.ok(Math.abs(a[0] - b[0]) >= 2.2 - 1e-6 || Math.abs(a[2] - b[2]) >= 2.2 - 1e-6);
    time += dt;
  }
  assert.ok(enemies[0].position[0] < 63, `guard stuck at ${enemies[0].position}`);
  assert.ok(Math.abs(enemies[0].position[2]) >= 2.2);
  assert.deepEqual(enemies[1].position, [63, 2.1, 0]);
});

test('ordinary AI plus swept projectile collision kills stationary HP1000 within 15 seconds', () => {
  const enemies = createEnemies([definition('G-1', 'guard', [40, 2.1, 0]), definition('G-2', 'guard', [-45, 2.1, 0]), definition('T-1', 'turret', [0, 2.1, 50])]);
  const target = player([0, 2.1, 0]), world = openWorld();
  // An unrelated camera cannot participate in distance, LOS, or attack timing.
  target.camera = { position: [9000, 9000, 9000], visibleEnemyIds: [] };
  let projectiles = [], time = 0, hits = 0;
  while (time < 15 && target.hp > 0) {
    const newShots = [];
    updateEnemies(enemies, target, world, dt, time, shot => newShots.push(shot));
    const survivors = [];
    for (const shot of [...projectiles, ...newShots]) {
      const elapsed = Math.max(0, Math.min(dt, time + dt - shot.firedAtSeconds));
      const result = advanceLinearProjectile(shot, elapsed, target, world);
      if (result.hit?.type === 'player') { target.hp -= shot.damage; hits++; }
      else if (!result.expired) survivors.push(shot);
    }
    projectiles = survivors;
    time += dt;
  }
  assert.ok(target.hp <= 0, `HP remaining: ${target.hp}`);
  assert.ok(time <= 15, `Killed at ${time}`);
  assert.ok(enemies.every(e => e.shotsFired > 0));
  assert.ok(hits > 30);
  console.log(`AK2 enemy danger: HP1000 defeated at ${time.toFixed(6)}s by ${hits} swept projectile hits; independent shots ${enemies.map(e => `${e.id}:${e.shotsFired}`).join(', ')}`);
});

test('enemy bullets hit stage cover before player, and are removed after one hit', () => {
  const enemies = createEnemies([definition('T-1', 'turret', [0, 2.1, 45])]);
  const target = player([0, 2.1, 0]), world = openWorld(), shots = [];
  advanceAI(enemies, target, world, .71, shots);
  const shot = shots[0];
  world.traceSegment = (a, b) => {
    if (a[2] >= 20 && b[2] <= 20) return { fraction: (a[2] - 20) / (a[2] - b[2]) };
    return null;
  };
  const result = advanceLinearProjectile(shot, 1, target, world);
  assert.equal(result.hit.type, 'world');
  assert.equal(result.expired, true);
  assert.equal(target.hp, 1000);
  near(shot.position[2], 20);
});

test('five real combat sectors allow four independent enemies to attack through actual stage LOS', () => {
  const fixtures = [
    ['S01', [30, 2.1, -13]],
    ['S03', [350, 18.1, -13]],
    ['S06', [830, 2.1, -13]],
    ['S09', [1310, 18.1, -25]],
    ['S12', [1790, 2.1, -13]],
  ];
  for (const [sectorId, position] of fixtures) {
    const enemies = createEnemies(STAGE.enemies);
    const target = player(position), world = createWorld(), shots = [];
    advanceAI(enemies, target, world, 1, shots);
    const local = enemies.filter(enemy => enemy.sectorId === sectorId);
    assert.equal(local.length, 4);
    assert.ok(local.every(enemy => enemy.shotsFired > 0), `${sectorId}: ${local.map(e => `${e.id}=${e.shotsFired}`).join(', ')}`);
    assert.equal(new Set(shots.filter(shot => local.some(enemy => enemy.id === shot.enemyId)).map(shot => shot.enemyId)).size, 4);
  }
});

test('a pursuing guard falls and lands when crossing a real downward stage doorway', () => {
  const world = createWorld();
  const connection = STAGE.connections.find(c => c.from === 'S04' && c.to === 'S05');
  world.openBarrierIds.add(connection.barrierId);
  const z = connection.position[2];
  const enemies = createEnemies([definition('G-descent', 'guard', [638.5, 18.1, z], 'S04')]);
  const target = player([705, 10.1, z]);
  advanceAI(enemies, target, world, 3, []);
  assert.ok(enemies[0].position[0] > 642.1);
  near(enemies[0].position[1], 10.10001, .001);
  assert.equal(enemies[0].grounded, true);
  assert.equal(enemies[0].sectorId, 'S05');
  near(enemies[0].velocity[1], 0);
});
