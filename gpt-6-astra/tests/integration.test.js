import test from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveCamera, Vector3 } from 'three';
import { DEFAULT_LOADOUT, effectiveStats } from '../src/config.js';
import { createPlayer, prepareMovement, updateMovement } from '../src/movement.js';
import { createCombat, getMuzzle } from '../src/combat.js';
import { createKoalaMech, animateMech } from '../src/models.js';
import { GameRenderer } from '../src/renderer.js';
import { createStage } from '../src/stage.js';

const dt = 1 / 120;
const inputDefaults = { forward: 0, right: 0, yaw: 0, qPressed: false, shiftPressed: false, jumpPressed: false, spaceHeld: false, spaceHeldSeconds: 0, brake: false };
const openWorld = {
  enemySpawns: [], raycast: () => null, lineOfSight: () => true,
  moveBody(position, velocity, seconds) {
    position.addScaledVector(velocity, seconds);
    const grounded = position.y <= 0;
    if (grounded) { position.y = 0; velocity.y = Math.max(0, velocity.y); }
    return { grounded };
  },
};
function near(actual, expected, message, tolerance = 1e-8) {
  assert.ok(Math.abs(actual - expected) < tolerance, `${message}: ${actual} versus ${expected}`);
}

test('WASD uses the rendered camera horizontal right at every yaw', () => {
  const stats = effectiveStats();
  for (const yaw of [0, .7, Math.PI / 2, Math.PI, -1.6]) {
    const player = createPlayer();
    const camera = new PerspectiveCamera(64, 16 / 9, .1, 360);
    GameRenderer.prototype.updateCamera.call({ camera, world: openWorld }, player, yaw, -.06);
    const screenOrigin = player.position.clone().add(new Vector3(0, 2.2, 0));
    const before = screenOrigin.clone().project(camera);
    const input = { ...inputDefaults, yaw, right: 1 };
    prepareMovement(player, input, stats, 0);
    updateMovement(player, input, stats, 0, .1, openWorld);
    const after = screenOrigin.add(player.position).project(camera);
    assert.ok(after.x > before.x, `D must move screen-right at yaw ${yaw}`);
    near(player.position.y, 0, 'horizontal input stays grounded');
  }
});

test('rendered muzzle and barrel orientation match the actual shot origin and direction', () => {
  for (const legs of ['biped', 'quadruped']) {
    const model = createKoalaMech(legs);
    for (const yaw of [0, .7, Math.PI / 2, Math.PI, -1.6]) for (const weapon of ['machinegun', 'beam', 'missile']) {
      const player = createPlayer({ ...DEFAULT_LOADOUT, legs }, new Vector3(15, 21, -40));
      player.yaw = yaw;
      model.position.copy(player.position);
      model.rotation.y = yaw;
      const aimDirection = new Vector3(.3, .25, -.8).normalize();
      animateMech(model, { time: .23, speed: 80, glide: true, flying: true, quickboost: true, yaw, aimDirection, weapon });
      model.updateMatrixWorld(true);
      const renderedMuzzle = model.userData.gun.getWorldPosition(new Vector3());
      near(renderedMuzzle.distanceTo(getMuzzle(player)), 0, `${legs} ${weapon} muzzle origin`);
      const renderedDirection = model.userData.gun.getWorldDirection(new Vector3());
      near(renderedDirection.distanceTo(aimDirection), 0, `${legs} ${weapon} barrel direction`);
      for (const [name, part] of Object.entries(model.userData.gun.userData.variants)) assert.equal(part.visible, name === weapon);
    }
  }
});

test('real combat and movement share QB then beam then paid flight transactions', () => {
  for (const initialEn of [35, 36, 44.1]) {
    const player = createPlayer(DEFAULT_LOADOUT, new Vector3(0, 20, 0));
    player.grounded = false; player.en = initialEn; player.weapon = 'beam';
    const stats = effectiveStats();
    const combat = createCombat(openWorld, DEFAULT_LOADOUT);
    const camera = new PerspectiveCamera(64, 16 / 9, .1, 360);
    const input = { ...inputDefaults, qPressed: true, spaceHeld: true, spaceHeldSeconds: .2 };
    prepareMovement(player, input, stats, 0);
    GameRenderer.prototype.updateCamera.call({ camera, world: openWorld }, player, 0, 0);
    combat.updateLock(player, camera, 1280, 720, 0, dt);
    const fired = combat.fire(player, camera, 0, true);
    updateMovement(player, input, stats, 0, dt, openWorld);
    assert.equal(player.movement.qbSuccessfulCount, initialEn >= 36 ? 1 : 0);
    assert.equal(fired, initialEn !== 36);
    assert.equal(combat.recentPlayerShots.length, fired ? 1 : 0);
    if (initialEn === 35) near(player.en, 35 - 8 - 20 * dt, 'rejected QB preserves EN for beam and flight');
    else if (initialEn === 36) {
      near(player.en, 0, 'successful QB prevents unpaid beam and flight');
      near(player.position.y, 20 - 9 * dt * dt, 'no free upward thrust');
    } else {
      near(player.en, 0, 'fractional flight exhausts only the residual EN');
      const poweredSeconds = .1 / 20;
      const fallingSeconds = dt - poweredSeconds;
      near(player.position.y, 20 + 8 * dt - 9 * fallingSeconds ** 2, 'flight thrust applies only during paid time');
    }
  }
});

test('ordinary locked beam hits destroy an actual stage control and open only its own physical barrier', () => {
  const world = createStage();
  try {
    const combat = createCombat(world, DEFAULT_LOADOUT);
    const target = combat.enemies.find(enemy => enemy.id === 'control-1');
    const player = createPlayer(DEFAULT_LOADOUT, target.position.clone().add(new Vector3(15, -2, 0)));
    player.weapon = 'beam'; player.yaw = -Math.PI / 2;
    const camera = new PerspectiveCamera(64, 16 / 9, .1, 360);
    GameRenderer.prototype.updateCamera.call({ camera, world }, player, player.yaw, -.06);
    for (let i = 0; i <= 120; i++) combat.updateLock(player, camera, 1280, 720, i * dt, dt);
    assert.equal(combat.lock.targetId, target.id);
    assert.equal(combat.lock.state, 'locked');
    const barrier = world.barriers.find(gate => gate.controlId === target.id);
    for (let i = 0; i < 6; i++) {
      assert.equal(combat.fire(player, camera, 1 + i * .25, true), true);
      world.updateControls(combat.enemies);
      assert.equal(target.hp, 240 - 40 * (i + 1));
      assert.equal(barrier.open, i === 5);
      assert.equal(barrier.collider.active, i !== 5);
      assert.equal(barrier.mesh.visible, i !== 5);
    }
    assert.equal(target.alive, false);
    assert.equal(world.barriers.filter(gate => gate.open).length, 1);
    assert.equal(world.gateOpen, false);
    assert.equal(combat.recentPlayerShots.length, 6);
  } finally { world.dispose(); }
});
