import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG, FCS, GENERATORS, LEGS, effectiveStats } from '../src/config.js';
import { createPlayer, beginMovementInput, stepMovement, spendEn } from '../src/movement.js';

const close = (actual, expected, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const loadout = (legs = 'biped', generator = 'balanced', fcs = 'medium') => ({ legs, generator, fcs });
const noInput = { direction: [0, 0], cameraForward: [1, 0] };

function simulate(player, seconds, fps, makeInput, stats = effectiveStats()) {
  let time = 0;
  while (time < seconds - 1e-10) {
    const dt = Math.min(1 / fps, seconds - time);
    stepMovement(player, makeInput(time), dt, time, stats);
    time += dt;
  }
  return player;
}

test('all 18 loadouts retain generator products and exact leg corrections', () => {
  let count = 0;
  for (const fcs of Object.keys(FCS)) for (const generator of Object.keys(GENERATORS)) for (const legs of Object.keys(LEGS)) {
    const stats = effectiveStats({ fcs, generator, legs });
    close(GENERATORS[generator].maxEn * GENERATORS[generator].regenPerSecond, 1800);
    close(stats.lockSeconds, FCS[fcs].lockSeconds / LEGS[legs].lockSpeedMultiplier);
    close(stats.regenPerSecond, GENERATORS[generator].regenPerSecond * LEGS[legs].regenMultiplier);
    close(stats.qbSpeed, 80 * LEGS[legs].horizontalSpeedMultiplier);
    count++;
  }
  assert.equal(count, 18);
  close(effectiveStats(loadout('quadruped')).lockSeconds, 0.8 / 1.5);
  close(effectiveStats(loadout('quadruped')).regenPerSecond, 11.25);
});

test('single Q then all input released covers exact 42.6 / 34.08m across 30/60/120fps', () => {
  for (const fps of [30, 60, 120]) for (const legs of ['biped', 'quadruped']) {
    const stats = effectiveStats(loadout(legs));
    const player = createPlayer(loadout(legs));
    simulate(player, 0.75, fps, (time) => ({ ...noInput, qbPressed: time === 0 }), stats);
    close(player.position[0] - 10, legs === 'biped' ? 42.6 : 34.08);
    close(player.velocity[0], stats.glideSpeed);
    close(player.en, stats.maxEn - 36);
    assert.equal(player.movement.qbSuccessfulCount, 1);
    assert.equal(player.movement.horizontalMode, 'glide');
    assert.equal(player.movement.glideEnabled, true);
    close(player.movement.qbImpulseRemainingSeconds, 0);
    close(player.movement.qbCooldownRemainingSeconds, 0.25);
    close(player.movement.lastEnSpentAtSeconds, 0);
  }
});

test('held Q state does not repeat edge and established glide regenerates after 0.75s', () => {
  const player = createPlayer();
  simulate(player, 5, 60, (time) => ({ ...noInput, qbHeld: true, qbPressed: time === 0 }));
  assert.equal(player.movement.qbSuccessfulCount, 1);
  close(player.position[0] - 10, 42.6 + 22 * 4.25);
  close(player.en, 120);
  close(player.movement.lastEnSpentAtSeconds, 0);
  const costOnly = createPlayer();
  simulate(costOnly, 5, 120, (time) => ({ ...noInput, qbHeld: true, qbPressed: time === 0 }), { ...effectiveStats(), regenPerSecond: 0 });
  close(costOnly.en, 84);
  assert.equal(costOnly.movement.qbSuccessfulCount, 1);
});

test('EN35 rejects QB without reserving it; EN36 commits motion at zero EN', () => {
  const denied = createPlayer();
  denied.en = 35;
  stepMovement(denied, { ...noInput, qbPressed: true }, 0.5, 0, effectiveStats());
  assert.equal(denied.movement.qbSuccessfulCount, 0);
  assert.equal(denied.movement.qbLastStartedAtSeconds, null);
  assert.equal(denied.movement.lastEnSpentAtSeconds, null);
  close(denied.en, 42.5);
  close(denied.position[0], 10);
  stepMovement(denied, noInput, 1, 0.5, effectiveStats());
  assert.equal(denied.movement.qbSuccessfulCount, 0);

  const accepted = createPlayer();
  accepted.en = 36;
  simulate(accepted, 0.75, 30, (time) => ({ ...noInput, qbPressed: time === 0 }));
  close(accepted.en, 0);
  close(accepted.position[0] - 10, 42.6);
  assert.equal(accepted.movement.glideEnabled, true);
  stepMovement(accepted, noInput, 0.25, 0.75, effectiveStats());
  close(accepted.en, 3.75);
  close(accepted.position[0] - 10, 48.1);
});

test('zero-EN manual glide starts, turns with limited acceleration, and stays free', () => {
  const player = createPlayer();
  player.en = 0;
  player.movement.lastEnSpentAtSeconds = 0;
  stepMovement(player, { ...noInput, glidePressed: true }, 0.75, 0, effectiveStats());
  assert.equal(player.movement.horizontalMode, 'glide');
  close(player.en, 0);
  close(player.velocity[0], 22);
  stepMovement(player, { ...noInput, direction: [-1, 0] }, 0.1, 0.75, effectiveStats());
  assert.ok(player.velocity[0] > 0, 'opposite input must not instantly reverse');
  close(player.en, 1.5);
  stepMovement(player, { ...noInput, cameraForward: [0, 1] }, 0.5, 0.85, effectiveStats());
  close(player.velocity[0], -22);
  close(player.velocity[2], 0);
  close(player.en, 9);
});

test('brake rejects new QB, is ignored during impulse, then smoothly stops', () => {
  const player = createPlayer();
  beginMovementInput(player, { ...noInput, qbPressed: true, brake: true }, 0, effectiveStats());
  close(player.en, 120);
  assert.equal(player.movement.qbSuccessfulCount, 0);
  stepMovement(player, { ...noInput, qbPressed: true }, 0.1, 0, effectiveStats());
  stepMovement(player, { ...noInput, brake: true, glidePressed: true }, 0.05, 0.1, effectiveStats());
  close(player.position[0] - 10, 12);
  close(player.velocity[0], 80);
  assert.equal(player.movement.glideEnabled, true);
  stepMovement(player, { ...noInput, brake: true }, 0.1, 0.15, effectiveStats());
  close(player.velocity[0], 68);
  assert.equal(player.movement.horizontalMode, 'walk');
  assert.equal(player.movement.glideEnabled, false);
});

test('ordinary input normalizes diagonals and jump is independent from horizontal legs', () => {
  for (const legs of ['biped', 'quadruped']) {
    const stats = effectiveStats(loadout(legs));
    const player = createPlayer(loadout(legs));
    stepMovement(player, { ...noInput, direction: [1, 1] }, 1, 0, stats);
    close(Math.hypot(player.velocity[0], player.velocity[2]), stats.walkSpeed);
    stepMovement(player, { ...noInput, jumpPressed: true }, 0.1, 1, stats);
    close(player.velocity[1], 8.2);
    const initialY = player.position[1];
    stepMovement(player, { ...noInput, jumpPressed: true }, 0.1, 1.1, stats);
    close(player.velocity[1], 6.4);
    assert.ok(player.position[1] > initialY);
  }
});

test('flight transition, per-second cost, exhaustion, and gravity agree across frame rates', () => {
  for (const fps of [30, 60, 120]) {
    const player = createPlayer();
    simulate(player, 1.2, fps, (time) => ({ ...noInput, jumpPressed: time === 0, spaceHeld: true, spaceHeldSeconds: time }));
    close(player.en, 100);
    close(player.velocity[1], 8);
    // 0.2s jump: 10*.2 - 9*.2²; followed by exactly one second at 8m/s.
    close(player.position[1], 2.1 + 1.64 + 8);
    assert.equal(player.movement.verticalMode, 'flying');
    stepMovement(player, noInput, 0.25, 1.2, effectiveStats());
    close(player.velocity[1], 3.5);
    close(player.en, 100);

    const exhausted = createPlayer();
    exhausted.en = 1;
    exhausted.grounded = false;
    exhausted.position[1] = 20;
    stepMovement(exhausted, { ...noInput, spaceHeld: true, spaceHeldSeconds: 0.2 }, 0.1, 0, effectiveStats());
    close(exhausted.en, 0);
    close(exhausted.velocity[1], 7.1);
    close(exhausted.position[1], 20 + 8 * 0.05 + 8 * 0.05 - 9 * 0.05 ** 2);
    close(exhausted.movement.lastEnSpentAtSeconds, 0.05);
    assert.equal(exhausted.movement.verticalMode, 'rising');
  }
});

test('shared EN prioritizes QB then beam then flight and failed spend changes no timers', () => {
  const player = createPlayer();
  player.en = 45;
  player.grounded = false;
  player.position[1] = 30;
  player.velocity[1] = -2;
  const input = { ...noInput, qbPressed: true, spaceHeld: true, spaceHeldSeconds: 0.2 };
  assert.equal(beginMovementInput(player, input, 0, effectiveStats()), true);
  close(player.velocity[1], -2, 0);
  assert.equal(spendEn(player, 8, 0), true);
  stepMovement(player, { ...input, edgesHandled: true }, 0.1, 0, effectiveStats());
  close(player.en, 0);
  close(player.velocity[0], 80);
  close(player.velocity[1], 7.1);
  close(player.movement.lastEnSpentAtSeconds, 0.05);
  assert.equal(spendEn(player, 8, 0.1), false);
  close(player.movement.lastEnSpentAtSeconds, 0.05);
});

test('collision removes impulse velocity and does not reapply QB speed through wall', () => {
  const wall = {
    moveBody(position, velocity, dt, halfExtents) {
      const proposed = position.map((value, index) => value + velocity[index] * dt);
      const resultVelocity = [...velocity];
      const normals = [];
      if (proposed[0] + halfExtents[0] >= 15) {
        proposed[0] = 15 - halfExtents[0];
        resultVelocity[0] = 0;
        normals.push([-1, 0, 0]);
      }
      return { position: proposed, velocity: resultVelocity, grounded: true, collisionNormals: normals };
    },
  };
  const player = createPlayer();
  stepMovement(player, { ...noInput, qbPressed: true }, 0.1, 0, effectiveStats(), wall);
  close(player.position[0], 13.9);
  close(player.velocity[0], 0);
  stepMovement(player, noInput, 0.04, 0.1, effectiveStats(), wall);
  close(player.position[0], 13.9);
  close(player.velocity[0], 0);
  close(player.en, 84);
  assert.equal(player.movement.qbSuccessfulCount, 1);
});

test('new sortie starts with a clean movement and EN state', () => {
  const old = createPlayer();
  stepMovement(old, { ...noInput, qbPressed: true }, 0.6, 0, effectiveStats());
  const fresh = createPlayer(loadout('quadruped', 'recovery', 'narrow'));
  close(fresh.en, 90);
  assert.equal(fresh.movement.glideEnabled, false);
  assert.equal(fresh.movement.qbSuccessfulCount, 0);
  assert.equal(fresh.movement.qbLastStartedAtSeconds, null);
  assert.equal(fresh.movement.lastEnSpentAtSeconds, null);
  assert.deepEqual(fresh.velocity, [0, 0, 0]);
  assert.deepEqual(fresh.ammo, { machinegun: 300, missile: 12 });
});
