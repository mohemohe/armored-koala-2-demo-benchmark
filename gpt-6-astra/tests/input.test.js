import test from 'node:test';
import assert from 'node:assert/strict';
import { InputController } from '../src/input.js';
import { createPlayer, prepareMovement, updateMovement } from '../src/movement.js';
import { effectiveStats } from '../src/config.js';

const DT = 1 / 120;
const world = {
  moveBody(position, velocity, dt) {
    position.addScaledVector(velocity, dt);
    const grounded = position.y <= 1e-9;
    if (grounded) { position.y = 0; if (velocity.y < 0) velocity.y = 0; }
    return { grounded };
  },
};
function near(actual, expected, tolerance = 1e-8) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}
function key(code, repeat = false) { return { code, repeat, preventDefault() {} }; }
function tick(controller, player, time, dt = DT) {
  const input = controller.movementInput(0, time);
  prepareMovement(player, input, effectiveStats(), time);
  updateMovement(player, input, effectiveStats(), time, dt, world);
  return input;
}

test('actual held Q and five seconds of OS repeat produce exactly one QB', () => {
  const controller = new InputController();
  const player = createPlayer();
  controller.handleKeyDown(key('KeyQ'), 'playing', 0);
  let minimumEn = player.en;
  let atPoint75;
  for (let frame = 0; frame < 600; frame++) {
    const time = frame * DT;
    if (frame > 0 && frame % 6 === 0) controller.handleKeyDown(key('KeyQ', true), 'playing', time);
    tick(controller, player, time);
    minimumEn = Math.min(minimumEn, player.en);
    if (frame === 89) atPoint75 = { position: player.position.toArray(), en: player.en, count: player.movement.qbSuccessfulCount };
  }
  assert.equal(controller.keys.has('KeyQ'), true);
  assert.equal(player.movement.qbSuccessfulCount, 1);
  near(minimumEn, 84);
  near(player.movement.lastEnSpentAtSeconds, 0);
  near(player.position.z, 136.1);
  near(player.en, 120);
  near(atPoint75.position[2], 42.6);
  near(atPoint75.en, 84);
  console.log('Held-Q production input measurement', JSON.stringify({ heldSeconds: 5, repeats: 99, atPoint75, finalPosition: player.position.toArray(), finalEn: player.en, minimumEn, count: player.movement.qbSuccessfulCount }));
});

test('short Q tap released before the first update preserves the queued edge and inertia', () => {
  const controller = new InputController();
  const player = createPlayer();
  controller.handleKeyDown(key('KeyQ'), 'playing', 0);
  controller.handleKeyUp(key('KeyQ'));
  assert.equal(controller.keys.size, 0);
  for (let frame = 0; frame < 90; frame++) tick(controller, player, frame * DT);
  near(player.position.z, 42.6);
  near(player.velocity.z, 22);
  near(player.en, 84);
  assert.equal(player.movement.qbSuccessfulCount, 1);
  assert.equal(player.movement.glideEnabled, true);
  console.log('Short-tap production input measurement', JSON.stringify({ elapsed: 0.75, heldKeyCount: controller.keys.size, position: player.position.toArray(), en: player.en, mode: player.movement.horizontalMode }));
});

test('duplicate non-repeat keydown still requires release before a second QB', () => {
  const controller = new InputController();
  const player = createPlayer();
  controller.handleKeyDown(key('KeyQ'), 'playing', 0);
  for (let frame = 0; frame < 150; frame++) {
    controller.handleKeyDown(key('KeyQ'), 'playing', frame * DT);
    tick(controller, player, frame * DT);
  }
  assert.equal(player.movement.qbSuccessfulCount, 1);
  controller.handleKeyUp(key('KeyQ'));
  controller.handleKeyDown(key('KeyQ'), 'playing', 1.25);
  tick(controller, player, 1.25);
  assert.equal(player.movement.qbSuccessfulCount, 2);
});

test('pause clears input and held Q cannot reactivate on resume without keyup', () => {
  const controller = new InputController();
  const player = createPlayer();
  controller.handleKeyDown(key('KeyQ'), 'playing', 0);
  for (let frame = 0; frame < 24; frame++) tick(controller, player, frame * DT);
  controller.fireHeld = true;
  controller.clear();
  const paused = JSON.stringify({ position: player.position, en: player.en, movement: player.movement });
  // Thirty seconds of paused OS repeat. The simulation clock remains at0.2s.
  for (let repeat = 0; repeat < 300; repeat++) controller.handleKeyDown(key('KeyQ', true), 'paused', 0.2);
  assert.equal(JSON.stringify({ position: player.position, en: player.en, movement: player.movement }), paused);
  assert.equal(controller.fireHeld, false);
  assert.equal(controller.keys.size, 0);
  controller.clear(); // enterPlay also clears input.
  controller.handleKeyDown(key('KeyQ'), 'playing', 0.2);
  for (let frame = 24; frame < 150; frame++) tick(controller, player, frame * DT);
  assert.equal(player.movement.qbSuccessfulCount, 1);
  controller.handleKeyDown(key('KeyQ', true), 'playing', 1.25);
  assert.equal(controller.movementInput(0, 1.25).qPressed, false);
  controller.handleKeyUp(key('KeyQ'));
  controller.handleKeyDown(key('KeyQ'), 'playing', 1.25);
  tick(controller, player, 1.25);
  assert.equal(player.movement.qbSuccessfulCount, 2);
});

test('Q initially pressed while not playing is blocked until physical release', () => {
  for (const state of ['garage', 'paused', 'cleared', 'failed']) {
    const controller = new InputController();
    controller.handleKeyDown(key('KeyQ'), state, 0);
    controller.clear();
    controller.handleKeyDown(key('KeyQ'), 'playing', 0);
    assert.equal(controller.movementInput(0, 0).qPressed, false);
    controller.handleKeyUp(key('KeyQ'));
    controller.handleKeyDown(key('KeyQ'), 'playing', 0);
    assert.equal(controller.movementInput(0, 0).qPressed, true);
    assert.equal(controller.movementInput(0, 0).qPressed, false);
  }
});

test('Shift toggles only on its edge and key release does not stop glide', () => {
  const controller = new InputController();
  const player = createPlayer();
  controller.handleKeyDown(key('ShiftLeft'), 'playing', 0);
  tick(controller, player, 0);
  for (let frame = 1; frame < 60; frame++) {
    controller.handleKeyDown(key('ShiftLeft', true), 'playing', frame * DT);
    tick(controller, player, frame * DT);
  }
  assert.equal(player.movement.glideEnabled, true);
  controller.handleKeyUp(key('ShiftLeft'));
  tick(controller, player, 0.5);
  assert.equal(player.movement.glideEnabled, true);
  controller.handleKeyDown(key('ShiftLeft'), 'playing', 0.5 + DT);
  tick(controller, player, 0.5 + DT);
  assert.equal(player.movement.glideEnabled, false);
  assert.ok(player.velocity.z > 0, 'Disabling glide preserves deceleration inertia');
});

test('Space edge is consumed once and held duration uses simulation time', () => {
  const controller = new InputController();
  controller.handleKeyDown(key('Space'), 'playing', 1);
  let input = controller.movementInput(0, 1);
  assert.equal(input.jumpPressed, true);
  assert.equal(input.spaceHeld, true);
  near(input.spaceHeldSeconds, 0);
  controller.handleKeyDown(key('Space', true), 'playing', 1.1);
  input = controller.movementInput(0, 1.2);
  assert.equal(input.jumpPressed, false);
  near(input.spaceHeldSeconds, 0.2);
  controller.handleKeyUp(key('Space'));
  input = controller.movementInput(0, 1.2);
  assert.equal(input.spaceHeld, false);
  near(input.spaceHeldSeconds, 0);
  controller.handleKeyDown(key('Space'), 'playing', 1.3);
  near(controller.movementInput(0, 1.3).spaceHeldSeconds, 0);
});

test('movement, brake, weapon selection and fire retain existing main contract', () => {
  const controller = new InputController();
  let prevented = 0;
  controller.handleKeyDown({ code: 'KeyW', preventDefault() { prevented++; } }, 'playing', 0);
  controller.handleKeyDown(key('KeyD'), 'playing', 0);
  controller.handleKeyDown(key('ControlLeft'), 'playing', 0);
  controller.fireHeld = true;
  const input = controller.movementInput(0.4, 0);
  assert.equal(input.forward, 1);
  assert.equal(input.right, 1);
  assert.equal(input.brake, true);
  assert.equal(input.fire, true);
  assert.equal(input.yaw, 0.4);
  assert.equal(prevented, 1);
  assert.equal(controller.handleKeyDown(key('Digit1'), 'playing', 0), 'machinegun');
  assert.equal(controller.handleKeyDown(key('Digit2'), 'playing', 0), 'beam');
  assert.equal(controller.handleKeyDown(key('Digit3'), 'playing', 0), 'missile');
  assert.equal(controller.handleKeyDown(key('Digit3'), 'paused', 0), null);
  controller.clear();
  assert.deepEqual(controller.movementInput(0, 0), {
    forward: 0, right: 0, yaw: 0, qPressed: false, shiftPressed: false, jumpPressed: false,
    spaceHeld: false, spaceHeldSeconds: 0, brake: false, fire: false,
  });
});
