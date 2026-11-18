import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { DEFAULT_LOADOUT, effectiveStats, FCS, GENERATORS, LEGS, PHYSICS } from '../src/config.js';
import { createPlayer, prepareMovement, updateMovement, spendEn } from '../src/movement.js';

const baseInput = { forward: 0, right: 0, yaw: 0, qPressed: false, shiftPressed: false, jumpPressed: false, spaceHeld: false, spaceHeldSeconds: 0, brake: false };
const flatWorld = {
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
function step(player, time, dt, overrides = {}, world = flatWorld, stats = effectiveStats()) {
  const input = { ...baseInput, ...overrides };
  prepareMovement(player, input, stats, time);
  updateMovement(player, input, stats, time, dt, world);
}
function advance(player, start, seconds, input = {}, stats = effectiveStats(), frequency = 120, world = flatWorld) {
  let elapsed = 0;
  while (elapsed < seconds - 1e-10) {
    const dt = Math.min(seconds - elapsed, 1 / frequency);
    step(player, start + elapsed, dt, input, world, stats);
    elapsed += dt;
  }
}

test('all 18 configurations share effective gameplay definitions', () => {
  let count = 0;
  for (const fcs of Object.keys(FCS)) for (const generator of Object.keys(GENERATORS)) for (const legs of Object.keys(LEGS)) {
    const loadout = { fcs, generator, legs };
    const stats = effectiveStats(loadout);
    near(stats.maxEn * GENERATORS[generator].regenPerSecond, 1800);
    near(stats.regenPerSecond, GENERATORS[generator].regenPerSecond * LEGS[legs].regenMultiplier);
    near(stats.lockSeconds, FCS[fcs].lockSeconds / LEGS[legs].lockSpeedMultiplier);
    near(stats.horizontalSpeedMultiplier, LEGS[legs].speedMultiplier);
    near(createPlayer(loadout).en, stats.maxEn);
    count++;
  }
  assert.equal(count, 18);
  near(effectiveStats({ fcs: 'medium', generator: 'balanced', legs: 'quadruped' }).lockSeconds, 0.8 / 1.5);
});

for (const legs of ['biped', 'quadruped']) for (const frequency of [30, 60, 120]) {
  test(`${legs}: released Q, exact impulse and inertia at ${frequency}Hz`, () => {
    const loadout = { ...DEFAULT_LOADOUT, legs };
    const stats = effectiveStats(loadout);
    const player = createPlayer(loadout);
    step(player, 0, 0.15, { qPressed: true }, flatWorld, stats);
    near(player.position.z, 12 * stats.horizontalSpeedMultiplier);
    near(player.velocity.z, 80 * stats.horizontalSpeedMultiplier);
    near(player.en, 84);
    assert.equal(player.movement.horizontalMode, 'glide');
    advance(player, 0.15, 0.6, {}, stats, frequency);
    near(player.position.z, 42.6 * stats.horizontalSpeedMultiplier);
    near(player.velocity.z, 22 * stats.horizontalSpeedMultiplier);
    near(player.en, 84);
    assert.equal(player.movement.qbSuccessfulCount, 1);
    assert.equal(player.movement.glideEnabled, true);
    assert.equal(player.movement.lastEnSpentAtSeconds, 0);
    const measured = { legs, frequency, elapsed: 0.75, position: player.position.toArray(), en: player.en, qb: player.movement.qbSuccessfulCount };
    console.log('QB measurement', JSON.stringify(measured));
  });
}

test('one Q press followed by five seconds held/released input produces only one impulse', () => {
  const player = createPlayer();
  // qPressed is the production input adapter's non-repeat keydown edge.
  step(player, 0, 1 / 120, { qPressed: true });
  advance(player, 1 / 120, 5 - 1 / 120);
  assert.equal(player.movement.qbSuccessfulCount, 1);
  near(player.position.z, 42.6 + 22 * 4.25);
  near(player.en, 120);
  near(player.movement.lastEnSpentAtSeconds, 0);
  console.log('One-edge 5s measurement', JSON.stringify({ position: player.position.toArray(), en: player.en, lastEnSpent: player.movement.lastEnSpentAtSeconds, qbCount: player.movement.qbSuccessfulCount }));
});

test('QB EN boundary rejects 35 without reserving and accepts exactly 36', () => {
  const refused = createPlayer(); refused.en = 35;
  step(refused, 0, 0.1, { qPressed: true });
  assert.equal(refused.movement.qbSuccessfulCount, 0);
  assert.equal(refused.movement.qbLastStartedAtSeconds, null);
  assert.equal(refused.movement.lastEnSpentAtSeconds, null);
  advance(refused, 0.1, 1);
  assert.equal(refused.movement.qbSuccessfulCount, 0);
  const accepted = createPlayer(); accepted.en = 36;
  step(accepted, 0, 0.75, { qPressed: true });
  near(accepted.en, 0);
  near(accepted.position.z, 42.6);
  assert.equal(accepted.movement.glideEnabled, true);
  advance(accepted, 0.75, 1);
  near(accepted.en, 15);
  near(accepted.position.z, 64.6);
});

test('glide can toggle on at EN0, costs zero and regenerates while moving', () => {
  const player = createPlayer();
  player.en = 0; player.movement.lastEnSpentAtSeconds = 0;
  step(player, 0, 0.75, { shiftPressed: true });
  assert.equal(player.movement.glideEnabled, true);
  near(player.en, 0);
  advance(player, 0.75, 1);
  near(player.en, 15);
  near(player.velocity.z, 22);
  near(player.movement.lastEnSpentAtSeconds, 0);
});

test('glide preserves world direction when only the camera rotates', () => {
  const player = createPlayer();
  step(player, 0, 0.5, { shiftPressed: true });
  const before = player.position.clone();
  advance(player, 0.5, 1, { yaw: Math.PI / 2 });
  near(player.position.x, before.x);
  near(player.position.z - before.z, 22);
  assert.deepEqual(player.movement.desiredHorizontalDirection, [0, 1]);
});

test('brake and Shift cannot cancel impulse; brake then decelerates with inertia', () => {
  const player = createPlayer();
  step(player, 0, 0.05, { qPressed: true });
  step(player, 0.05, 0.1, { shiftPressed: true, brake: true, forward: -1 });
  near(player.position.z, 12);
  near(player.velocity.z, 80);
  step(player, 0.15, 0.1, { brake: true, forward: 1 });
  near(player.velocity.z, 68);
  assert.equal(player.movement.horizontalMode, 'walk');
  assert.equal(player.movement.glideEnabled, false);
  advance(player, 0.25, 1, { brake: true });
  near(player.velocity.length(), 0);
  const enBefore = player.en;
  step(player, 1.25, 0, { qPressed: true, brake: true });
  near(player.en, enBefore);
  assert.equal(player.movement.qbSuccessfulCount, 1);
});

test('normal and diagonal movement respect velocity cap and acceleration', () => {
  const player = createPlayer();
  advance(player, 0, 0.5, { forward: 1, right: 1 });
  near(Math.hypot(player.velocity.x, player.velocity.z), 10);
  assert.ok(player.velocity.x < 0, 'Screen-right is world -X when camera faces +Z');
  const before = player.position.clone();
  advance(player, 0.5, 0.5);
  near(player.velocity.length(), 0);
  assert.ok(player.position.distanceTo(before) > 0);
});

test('jump has one impulse, flight waits .20s, and thrust ends at actual EN depletion', () => {
  const player = createPlayer();
  step(player, 0, 0.1, { jumpPressed: true, spaceHeld: true, spaceHeldSeconds: 0 });
  near(player.position.y, 0.91);
  near(player.velocity.y, 8.2);
  step(player, 0.1, 0.1, { jumpPressed: true, spaceHeld: true, spaceHeldSeconds: 0.1 });
  near(player.position.y, 1.64);
  near(player.velocity.y, 6.4);
  near(player.en, 120);
  player.en = 0.05;
  step(player, 0.2, 0.01, { spaceHeld: true, spaceHeldSeconds: 0.2 });
  const thrustTime = 0.05 / 20;
  const gravityTime = 0.01 - thrustTime;
  near(player.position.y, 1.64 + 8 * 0.01 - 0.5 * 18 * gravityTime ** 2);
  near(player.velocity.y, 8 - 18 * gravityTime);
  near(player.en, 0);
  near(player.movement.lastEnSpentAtSeconds, 0.2 + thrustTime);
  assert.equal(player.movement.verticalMode, 'rising');
});

test('QB → beam → flight pays shared EN in order, including partial thrust', () => {
  const player = createPlayer();
  player.position.y = 10; player.grounded = false; player.en = 44.05;
  const input = { ...baseInput, qPressed: true, spaceHeld: true, spaceHeldSeconds: 0.3 };
  const stats = effectiveStats();
  prepareMovement(player, input, stats, 0);
  near(player.en, 8.05);
  assert.equal(spendEn(player, 8, 0), true);
  near(player.en, 0.05);
  updateMovement(player, input, stats, 0, 0.01, flatWorld);
  near(player.en, 0);
  near(player.position.z, 0.8);
  near(player.velocity.y, 8 - 18 * 0.0075);
  assert.equal(player.movement.qbSuccessfulCount, 1);
  const refused = createPlayer(); refused.en = 40;
  prepareMovement(refused, input, stats, 0);
  assert.equal(spendEn(refused, 8, 0), false);
  near(refused.en, 4);
});

test('all configurations can gain 16m without horizontal multiplier affecting ascent', () => {
  for (const fcs of Object.keys(FCS)) for (const generator of Object.keys(GENERATORS)) for (const legs of Object.keys(LEGS)) {
    const loadout = { fcs, generator, legs };
    const stats = effectiveStats(loadout);
    const player = createPlayer(loadout);
    step(player, 0, 0.2, { jumpPressed: true, spaceHeld: true }, flatWorld, stats);
    step(player, 0.2, 2, { spaceHeld: true, spaceHeldSeconds: 0.2 }, flatWorld, stats);
    near(player.position.y, 17.64);
    near(player.velocity.y, 8);
    near(player.en, stats.maxEn - 40);
    assert.equal(player.grounded, false);
  }
});

test('air QB retains vertical velocity and transitions to16m/s glide without free lift', () => {
  const player = createPlayer(DEFAULT_LOADOUT, new Vector3(0, 50, 0));
  player.grounded = false; player.velocity.y = 2;
  step(player, 0, 0.75, { qPressed: true });
  near(player.position.z, 40.8);
  near(player.velocity.z, 16);
  near(player.position.y, 50 + 2 * 0.75 - 9 * 0.75 ** 2);
  near(player.en, 84);
  assert.equal(player.movement.horizontalMode, 'glide');
});

test('wall collision removes QB velocity without reapplying impulse', () => {
  const wall = {
    moveBody(position, velocity, dt, radius) {
      const result = flatWorld.moveBody(position, velocity, dt);
      if (position.z > 5 - radius) { position.z = 5 - radius; velocity.z = 0; }
      return result;
    },
  };
  const player = createPlayer();
  step(player, 0, 0.08, { qPressed: true }, wall);
  near(player.position.z, 5 - PHYSICS.playerRadius);
  near(player.velocity.z, 0);
  step(player, 0.08, 0.05, {}, wall);
  near(player.position.z, 5 - PHYSICS.playerRadius);
  near(player.velocity.z, 0);
  assert.equal(player.movement.horizontalMode, 'quickboost');
});

test('fresh player resets all movement and weapon history', () => {
  const player = createPlayer({ fcs: 'wide', generator: 'capacity', legs: 'quadruped' });
  assert.equal(player.en, 180);
  assert.equal(player.hp, 1000);
  assert.deepEqual(player.ammo, { machinegun: 300, missile: 12 });
  assert.equal(player.movement.qbSuccessfulCount, 0);
  assert.equal(player.movement.qbLastStartedAtSeconds, null);
  assert.equal(player.movement.lastEnSpentAtSeconds, null);
  assert.equal(player.movement.glideEnabled, false);
  near(player.velocity.length(), 0);
});
