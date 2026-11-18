import test from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveCamera, Vector3 } from 'three';
import { createCombat, getMuzzle } from '../src/combat.js';
import { solveIntercept, polynomialRootsInInterval, movingSphereIntersection, turnDirection } from '../src/ballistics.js';
import { createPlayer, prepareMovement, updateMovement } from '../src/movement.js';
import { DEFAULT_LOADOUT, effectiveStats, FCS, GENERATORS, LEGS } from '../src/config.js';

const STEP = 1 / 120;
const M = new Vector3(0, 20, 0);
const cases = [
  ['A01', [0, 0, 20], [0, 0, 0]], ['A02', [0, 0, 60], [0, 0, 0]],
  ['A03', [0, 0, 100], [0, 0, 0]], ['A04', [0, 0, 120], [0, 0, 0]],
  ['A05', [0, 0, 100], [8, 0, 0]], ['A06', [0, 0, 100], [-8, 0, 0]],
  ['A07', [0, 0, 100], [0, 0, 8]], ['A08', [0, 0, 100], [0, 0, -8]],
  ['A09', [0, 16, 100], [6, 0, 0]], ['A10', [0, -16, 100], [-6, 0, 0]],
  ['A11', [0, 0, 100], [6, 3, 0]], ['A12', [0, 0, 100], [6, -3, 0]],
  ['A13', [0, 0, 120], [6, 3, 4]],
];
function emptyWorld(spawns = [{ id: 'target', kind: 'guard', isGateControl: false, sectorId: 'test', position: [0, 20, 100] }]) {
  return {
    enemySpawns: spawns, seed: 20260908, raycast: () => null, lineOfSight: () => true,
    moveBody(position, velocity, dt) { position.addScaledVector(velocity, dt); return { grounded: Math.abs(velocity.y) < 1e-10 }; },
    navigationDirection(from, to) { return to.clone().sub(from).setY(0).normalize(); },
    pathDistance(from, to) { return from.distanceTo(to); },
  };
}
function fixture(r, v, weapon = 'machinegun', loadout = DEFAULT_LOADOUT) {
  const world = emptyWorld(), combat = createCombat(world, loadout);
  const player = createPlayer(loadout, M.clone().sub(new Vector3(1.35, 3.1, 1.4)));
  player.weapon = weapon;
  const enemy = combat.enemies[0]; enemy.radius = .5; enemy.hp = 1000;
  enemy.velocity.fromArray(v);
  const finalTarget = M.clone().add(new Vector3(...r));
  const duration = effectiveStats(loadout).lockSeconds;
  const camera = new PerspectiveCamera(60, 1280 / 720, .1, 2000);
  for (let time = 0; time < duration + STEP * .5; time += STEP) {
    const exactTime = Math.min(time, duration);
    enemy.position.copy(finalTarget).addScaledVector(enemy.velocity, exactTime - duration);
    enemy.previousPosition.copy(enemy.position);
    camera.position.copy(M).add(new Vector3(0, 5, -12)); camera.lookAt(enemy.position); camera.updateMatrixWorld();
    combat.updateLock(player, camera, 1280, 720, exactTime, STEP);
  }
  // Lock times for quadrupeds may be off the fixed-step grid; evaluate exactly.
  enemy.position.copy(finalTarget); enemy.previousPosition.copy(finalTarget);
  camera.lookAt(enemy.position); camera.updateMatrixWorld();
  combat.updateLock(player, camera, 1280, 720, duration, 0);
  assert.equal(combat.lock.state, 'locked');
  return { world, combat, player, enemy, camera, time: duration };
}
function runShot(f) {
  assert.equal(f.combat.fire(f.player, f.camera, f.time, true), true);
  const shot = f.combat.recentPlayerShots.at(-1);
  const before = 1000;
  let time = f.time;
  for (let i = 0; i < 500 && f.combat.projectiles.length; i++) {
    f.enemy.previousPosition.copy(f.enemy.position);
    f.enemy.position.addScaledVector(f.enemy.velocity, STEP);
    f.player.previousPosition.copy(f.player.position);
    f.combat.updateProjectiles(f.player, time, STEP); time += STEP;
  }
  return { shot, hit: f.enemy.hp < before, flightEnd: time - f.time };
}
for (const [id, r, v] of cases) {
  test(`${id}: 20/20 normal-lock MG shots, real moving sphere collision radius .5`, () => {
    let hits = 0, maximumResidual = 0;
    for (let n = 0; n < 20; n++) {
      const f = fixture(r, v), result = runShot(f); hits += Number(result.hit);
      assert.equal(result.shot.solutionStatus, 'solved');
      assert.ok(Math.abs(result.shot.initialVelocity.length() - 100) < .001);
      const t = result.shot.predictedFlightSeconds;
      const impact = result.shot.muzzlePosition.clone().addScaledVector(result.shot.initialVelocity, t).add(new Vector3(0, -9 * t * t, 0));
      const target = result.shot.targetPositionAtFire.clone().addScaledVector(result.shot.targetVelocityAtFire, t);
      maximumResidual = Math.max(maximumResidual, impact.distanceTo(target));
      if (id === 'A13') assert.ok(t > 1.2 && t <= 2);
      if (id === 'A03') assert.ok(Math.abs(t - 1.004108529) < 1e-8);
    }
    assert.equal(hits, 20); assert.ok(maximumResidual <= .01);
    console.log(`${id} machinegun: ${hits}/20; maximum residual ${maximumResidual.toExponential(3)}m`);
  });
  test(`${id}: 20/20 beam current-position hits`, () => {
    for (let n = 0; n < 20; n++) {
      const f = fixture(r, v, 'beam'), result = runShot(f);
      assert.equal(result.hit, true); assert.equal(f.enemy.hp, 960); assert.equal(f.player.en, 112);
      assert.equal(result.shot.predictedFlightSeconds, 0); assert.equal(result.shot.initialVelocity, null);
      assert.ok(result.shot.launchDirection.angleTo(f.enemy.position.clone().sub(M).normalize()) < 1e-7);
    }
  });
}
for (const [id, r, v] of cases.slice(4, 7)) {
  test(`${id}: 20/20 missile lead and bounded guidance hits`, () => {
    for (let n = 0; n < 20; n++) {
      const f = fixture(r, v, 'missile');
      assert.equal(f.combat.fire(f.player, f.camera, f.time, true), true);
      const initial = f.combat.projectiles[0];
      assert.ok(Math.abs(initial.velocity.length() - 45) < 1e-10);
      const expected = solveIntercept(M, f.enemy.position, f.enemy.velocity, 45, 4);
      assert.ok(initial.velocity.clone().normalize().angleTo(expected.direction) < 1e-7);
      let time = f.time, previousDirection = initial.velocity.clone().normalize();
      for (let i = 0; i < 500 && f.combat.projectiles.length; i++) {
        f.enemy.previousPosition.copy(f.enemy.position); f.enemy.position.addScaledVector(f.enemy.velocity, STEP);
        f.combat.updateProjectiles(f.player, time, STEP); time += STEP;
        if (f.combat.projectiles.length) {
          const now = f.combat.projectiles[0].velocity.clone().normalize();
          assert.ok(previousDirection.angleTo(now) <= Math.PI * 2 / 3 * STEP + 1e-7); previousDirection = now;
        }
      }
      assert.equal(f.enemy.hp, 820);
    }
  });
}
test('quartic tangency, lifetime boundary, earliest root, linear intercept, no solution', () => {
  assert.deepEqual(polynomialRootsInInterval([1, -4, 6, -4, 1], 0, 2), [1]);
  const tangent = solveIntercept(new Vector3(), new Vector3(0, 9, 0), new Vector3(0, -18, 100), 100, 2, new Vector3(0, -18, 0));
  assert.ok(tangent); assert.ok(Math.abs(tangent.time - 1) < 1e-8);
  const boundary = solveIntercept(new Vector3(), new Vector3(0, 36, 0), new Vector3(0, -36, 100), 100, 2, new Vector3(0, -18, 0));
  assert.ok(boundary); assert.ok(Math.abs(boundary.time - 2) < 1e-8);
  const earliest = solveIntercept(new Vector3(), new Vector3(0, 0, 100), new Vector3(), 100, 20, new Vector3(0, -18, 0));
  assert.ok(earliest.time < 2);
  assert.ok(Math.abs(solveIntercept(new Vector3(), new Vector3(0, 0, 100), new Vector3(0, 0, -45), 45, 4).time - 100 / 90) < 1e-10);
  assert.equal(solveIntercept(new Vector3(), new Vector3(0, 0, 100), new Vector3(0, 0, 150), 100, 2, new Vector3(0, -18, 0)), null);
});
test('swept collision includes fast moving targets and exact end point', () => {
  assert.notEqual(movingSphereIntersection(new Vector3(-5, 0, 0), new Vector3(5, 0, 0), new Vector3(0, -5, 0), new Vector3(0, 5, 0), .5), null);
  assert.equal(movingSphereIntersection(new Vector3(), new Vector3(1, 0, 0), new Vector3(1.5, 0, 0), new Vector3(1.5, 0, 0), .5), 1);
  const current = new Vector3(0, 0, 1), desired = new Vector3(0, 0, -1);
  assert.ok(Math.abs(turnDirection(current, desired, .1).angleTo(current) - .1) < 1e-9);
});
test('all 18 loadouts use the same A05 correction and actual hit', () => {
  for (const fcs of Object.keys(FCS)) for (const generator of Object.keys(GENERATORS)) for (const legs of Object.keys(LEGS)) {
    const f = fixture([0, 0, 100], [8, 0, 0], 'machinegun', { fcs, generator, legs });
    assert.equal(runShot(f).hit, true);
  }
});
for (const mode of ['glide', 'flying', 'quickboost']) {
  test(`A05 ${mode}: 20/20 shots at current muzzle, no inherited shooter velocity`, () => {
    for (let n = 0; n < 20; n++) {
      const f = fixture([0, 0, 100], [8, 0, 0]);
      const input = { forward: 1, right: 0, yaw: 0, shiftPressed: mode === 'glide', qPressed: mode === 'quickboost', spaceHeld: mode === 'flying', spaceHeldSeconds: 1 };
      prepareMovement(f.player, input, effectiveStats(DEFAULT_LOADOUT), f.time);
      updateMovement(f.player, input, effectiveStats(DEFAULT_LOADOUT), f.time, STEP, f.world);
      f.time += STEP;
      const muzzle = getMuzzle(f.player); f.enemy.position.copy(muzzle).add(new Vector3(0, 0, 100)); f.enemy.previousPosition.copy(f.enemy.position);
      f.camera.position.copy(muzzle).add(new Vector3(0, 5, -12)); f.camera.lookAt(f.enemy.position); f.camera.updateMatrixWorld();
      f.combat.updateLock(f.player, f.camera, 1280, 720, f.time, 0);
      assert.ok(f.player.velocity.length() > 0);
      const result = runShot(f); assert.equal(result.hit, true);
      assert.ok(result.shot.muzzlePosition.distanceTo(muzzle) < 1e-12); assert.ok(Math.abs(result.shot.initialVelocity.length() - 100) < 1e-9);
    }
  });
}
test('muzzle and camera occlusion both invalidate lock; refusal consumes no ammo', () => {
  const f = fixture([0, 0, 100], [8, 0, 0], 'missile');
  f.world.lineOfSight = (from) => from.distanceTo(getMuzzle(f.player)) > 1e-6;
  const ammo = f.player.ammo.missile;
  assert.equal(f.combat.fire(f.player, f.camera, f.time, true), false);
  assert.equal(f.player.ammo.missile, ammo); assert.equal(f.combat.lock.state, 'none'); assert.equal(f.combat.fireControl.status, 'inactive');
  assert.equal(f.combat.recentPlayerShots.length, 0);
});
test('lock stays on valid target, resets immediately on exit, and survives weapon changes', () => {
  const f = fixture([10, 0, 100], [0, 0, 0]);
  f.player.weapon = 'beam'; f.combat.updateLock(f.player, f.camera, 1280, 720, f.time, 0);
  assert.equal(f.combat.lock.state, 'locked'); assert.equal(f.combat.fireControl.weapon, 'beam');
  f.enemy.position.z = 500; f.combat.updateLock(f.player, f.camera, 1280, 720, f.time, 0);
  assert.equal(f.combat.lock.state, 'none'); assert.equal(f.combat.lock.progress, 0); assert.equal(f.combat.fireControl.targetId, null);
});
test('no solution retains lock and fires ordinary unsteered ballistic shot', () => {
  const f = fixture([0, 0, 100], [0, 0, 0]); f.enemy.velocity.set(0, 0, 150);
  assert.equal(f.combat.fire(f.player, f.camera, f.time, true), true);
  assert.equal(f.combat.lock.state, 'locked'); assert.equal(f.combat.fireControl.status, 'no_solution');
  assert.equal(f.combat.fireControl.predictedFlightSeconds, null);
  const bullet = f.combat.projectiles[0], velocity = bullet.initialVelocity.clone();
  f.enemy.position.set(90, 20, 0);
  f.combat.updateProjectiles(f.player, f.time, .5);
  assert.ok(bullet.position.distanceTo(M.clone().addScaledVector(velocity, .5).add(new Vector3(0, -2.25, 0))) < 1e-9);
});
test('beam cooldown survives weapon switching; failed EN spend has no timer side effect', () => {
  const f = fixture([0, 0, 100], [0, 0, 0], 'beam');
  f.player.en = 7; assert.equal(f.combat.fire(f.player, f.camera, f.time, true), false);
  assert.equal(f.player.movement.lastEnSpentAtSeconds, null);
  f.player.en = 16; assert.equal(f.combat.fire(f.player, f.camera, f.time, true), true);
  f.player.weapon = 'machinegun'; assert.equal(f.combat.fire(f.player, f.camera, f.time + .01, true), true);
  f.player.weapon = 'beam'; assert.equal(f.combat.fire(f.player, f.camera, f.time + .1, true), false);
  assert.equal(f.combat.fire(f.player, f.camera, f.time + .25, true), true); assert.equal(f.player.en, 0);
});
test('snapshot is read only by copy; reset clears actual histories and timers', () => {
  const f = fixture([0, 0, 100], [8, 0, 0]); runShot(f);
  const snapshot = f.combat.snapshot(); snapshot.enemies[0].position[0] = 999; snapshot.recentPlayerShots[0].launchDirection[0] = 999;
  assert.notEqual(f.enemy.position.x, 999); assert.notEqual(f.combat.recentPlayerShots[0].launchDirection.x, 999);
  const stable = JSON.stringify(f.combat.snapshot()); f.combat.snapshot(); assert.equal(JSON.stringify(f.combat.snapshot()), stable);
  f.combat.reset(); assert.equal(f.combat.recentPlayerShots.length, 0); assert.equal(f.combat.projectiles.length, 0); assert.equal(f.combat.lock.state, 'none');
  assert.equal(f.combat.enemies[0].shotsFired, 0); assert.equal(f.combat.enemies[0].hp, 120);
});
test('ordinary independent AI: two guards and turret kill static HP1000 within15seconds', () => {
  const world = emptyWorld([
    { id: 'g1', kind: 'guard', sectorId: 'test', position: [-20, 2.2, 30] },
    { id: 'g2', kind: 'guard', sectorId: 'test', position: [20, 2.2, 35] },
    { id: 't1', kind: 'turret', sectorId: 'test', position: [0, 2.2, 45] },
  ]);
  world.moveBody = (position, velocity, dt) => {
    position.addScaledVector(velocity, dt);
    const grounded = position.y <= 0;
    if (grounded) { position.y = 0; velocity.y = Math.max(0, velocity.y); }
    return { grounded };
  };
  const combat = createCombat(world, DEFAULT_LOADOUT), player = createPlayer(DEFAULT_LOADOUT);
  let time = 0;
  for (; time < 15 && player.hp > 0; time += STEP) {
    player.previousPosition.copy(player.position); combat.updateEnemies(player, time, STEP); combat.updateProjectiles(player, time, STEP);
  }
  console.log(`Aggression measured: defeat ${time.toFixed(6)}s; enemy shot counts ${combat.enemies.map((e) => `${e.id}:${e.shotsFired}`).join(',')}`);
  assert.equal(player.hp, 0); assert.ok(time <= 15);
  assert.ok(combat.enemies.every((e) => e.shotsFired >= 2));
});

function rayBox(start, end, min, max) {
  let near = 0, far = 1;
  for (const axis of ['x', 'y', 'z']) {
    const delta = end[axis] - start[axis];
    if (Math.abs(delta) < 1e-12) { if (start[axis] < min[axis] || start[axis] > max[axis]) return null; continue; }
    let a = (min[axis] - start[axis]) / delta, b = (max[axis] - start[axis]) / delta;
    if (a > b) [a, b] = [b, a];
    near = Math.max(near, a); far = Math.min(far, b); if (near > far) return null;
  }
  return { t: near, point: start.clone().lerp(end, near), normal: new Vector3() };
}
test('corrected ballistic arc stops on a beam above the direct line of sight', () => {
  const f = fixture([0, 0, 100], [0, 0, 0]);
  f.world.raycast = (a, b) => rayBox(a, b, new Vector3(-10, 21, 35), new Vector3(10, 23, 65));
  f.world.lineOfSight = (a, b) => !f.world.raycast(a, b);
  f.camera.position.copy(M).add(new Vector3(0, 0, -12)); f.camera.lookAt(f.enemy.position); f.camera.updateMatrixWorld();
  f.combat.updateLock(f.player, f.camera, 1280, 720, f.time, 0);
  assert.equal(f.combat.lock.state, 'locked'); assert.equal(f.combat.fireControl.status, 'solved');
  const result = runShot(f); assert.equal(result.hit, false); assert.equal(f.enemy.hp, 1000);
  assert.equal(f.combat.projectiles.length, 0); assert.ok(result.flightEnd < 1);
});
test('actual thin wall blocks muzzle while camera sees the target', () => {
  const f = fixture([0, 0, 100], [0, 0, 0], 'beam');
  f.world.raycast = (a, b) => rayBox(a, b, new Vector3(-.2, 19.8, 1), new Vector3(.2, 20.2, 2));
  f.world.lineOfSight = (a, b) => !f.world.raycast(a, b);
  assert.equal(f.world.lineOfSight(f.camera.position, f.enemy.position), true);
  assert.equal(f.world.lineOfSight(getMuzzle(f.player), f.enemy.position), false);
  assert.equal(f.combat.fire(f.player, f.camera, f.time, true), true); // ordinary free shot hits the wall
  assert.equal(f.combat.lock.state, 'none'); assert.equal(f.enemy.hp, 1000);
});
test('normal update applies no extra advance to projectiles born mid interval', () => {
  const f = fixture([0, 0, 100], [0, 0, 0]);
  assert.equal(f.combat.fire(f.player, f.camera, f.time + STEP * .75, true), true);
  const bullet = f.combat.projectiles[0], age = STEP * .25;
  f.combat.updateProjectiles(f.player, f.time, STEP);
  const expected = M.clone().addScaledVector(bullet.initialVelocity, age).addScaledVector(new Vector3(0, -18, 0), .5 * age * age);
  assert.ok(bullet.position.distanceTo(expected) < 1e-10); assert.ok(Math.abs(bullet.age - age) < 1e-10);
});
test('missile uses concealed observation memory, retains target and respects turn limit', () => {
  const f = fixture([0, 0, 100], [8, 0, 0], 'missile'); f.combat.fire(f.player, f.camera, f.time, true);
  const missile = f.combat.projectiles[0], observed = missile.lastObservedPosition.clone(), previous = missile.velocity.clone().normalize();
  f.world.lineOfSight = () => false;
  f.enemy.previousPosition.copy(f.enemy.position); f.enemy.position.set(-100, 50, 0); f.enemy.velocity.set(-50, 20, 0);
  f.combat.updateProjectiles(f.player, f.time, STEP);
  assert.ok(missile.lastObservedPosition.equals(observed)); assert.deepEqual(missile.lastObservedVelocity.toArray(), [8, 0, 0]);
  assert.equal(missile.targetId, f.enemy.id); assert.ok(previous.angleTo(missile.velocity.clone().normalize()) <= Math.PI * 2 / 3 * STEP + 1e-8);
  const beforeDeath = missile.velocity.clone(); f.enemy.alive = false;
  f.combat.updateProjectiles(f.player, f.time + STEP, STEP); assert.ok(missile.velocity.equals(beforeDeath));
});
test('new central candidate cannot steal an existing valid lock; acquisition restarts at zero', () => {
  const f = fixture([0, 0, 100], [0, 0, 0]);
  f.enemy.position.x += 5;
  const competitor = { ...f.enemy, id: 'competitor', position: M.clone().add(new Vector3(0, 0, 90)), previousPosition: M.clone().add(new Vector3(0, 0, 90)), velocity: new Vector3() };
  f.combat.enemies.push(competitor);
  f.combat.updateLock(f.player, f.camera, 1280, 720, f.time + STEP, STEP);
  assert.equal(f.combat.lock.targetId, 'target');
  f.enemy.alive = false; f.combat.updateLock(f.player, f.camera, 1280, 720, f.time + 2 * STEP, STEP);
  assert.equal(f.combat.lock.targetId, 'competitor'); assert.equal(f.combat.lock.progress, 0); assert.equal(f.combat.fireControl.status, 'inactive');
});
