import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PlayerController } from '../src/player.js';
import { createPlayerModel } from '../src/models.js';
import { FIXED_DT, DEFAULT_LOADOUT } from '../src/config.js';

class Input {
  constructor() { this.keys = new Set(); this.presses = new Set(); }
  down(code) { return this.keys.has(code); }
  consumePress(code) { const yes = this.presses.has(code); this.presses.delete(code); return yes; }
  press(code) { this.keys.add(code); this.presses.add(code); }
  release(code) { this.keys.delete(code); }
}
function setup(legs = 'biped') {
  const floor = { min: [-2000, -1, -2000], max: [2000, 0, 2000], active: true };
  const loadout = { ...DEFAULT_LOADOUT, legs };
  const player = new PlayerController(createPlayerModel(legs), [floor], loadout);
  return { player, input: new Input() };
}
function step(player, input, now) {
  player.beginStep(FIXED_DT, now, input, 0);
  player.previousPosition = player.position.clone();
  player.updateMovement(FIXED_DT, now, input, 0);
}

test('QB single edge: 42.6 m in 0.75 s, automatic glide, 36 EN', () => {
  const { player, input } = setup();
  const start = player.position.clone(); input.press('KeyQ');
  for (let i = 0; i < 90; i++) { step(player, input, i * FIXED_DT); if (i === 0) input.release('KeyQ'); }
  assert.ok(Math.abs(player.position.z + 42.6) < 0.02, player.position.z);
  assert.equal(player.qbSuccessfulCount, 1);
  assert.equal(player.horizontalMode, 'glide'); assert.equal(player.glideEnabled, true);
  assert.ok(Math.abs(player.velocity.length() - 22) < 1e-8);
  assert.ok(Math.abs(player.en - 84) < 1e-8);
  assert.ok(Math.abs(start.distanceTo(player.position) - 42.6) < 1e-9);
});

test('quadruped QB distance is 34.08 m', () => {
  const { player, input } = setup('quadruped'); input.press('KeyQ');
  for (let i = 0; i < 90; i++) { step(player, input, i * FIXED_DT); input.release('KeyQ'); }
  assert.ok(Math.abs(player.position.z + 34.08) < 0.02, player.position.z);
  assert.ok(Math.abs(Math.hypot(player.velocity.x, player.velocity.z) - 17.6) < 1e-8);
});

test('holding Q for five seconds produces one QB and no reserved retrigger', () => {
  const { player, input } = setup(); input.press('KeyQ');
  for (let i = 0; i < 600; i++) step(player, input, i * FIXED_DT);
  assert.equal(player.qbSuccessfulCount, 1); assert.equal(player.lastEnSpentAt, 0);
});

test('EN35 rejects without spending; EN36 succeeds and inertia continues at EN0', () => {
  const rejected = setup(); rejected.player.en = 35; rejected.input.press('KeyQ');
  step(rejected.player, rejected.input, 0);
  assert.equal(rejected.player.qbSuccessfulCount, 0); assert.ok(rejected.player.en >= 35); assert.equal(rejected.player.lastEnSpentAt, null);
  const accepted = setup(); accepted.player.en = 36; accepted.input.press('KeyQ');
  step(accepted.player, accepted.input, 0); accepted.input.release('KeyQ');
  assert.equal(accepted.player.qbSuccessfulCount, 1); assert.equal(accepted.player.en, 0);
  for (let i = 1; i < 45; i++) step(accepted.player, accepted.input, i * FIXED_DT);
  assert.ok(accepted.player.position.z < -20); assert.equal(accepted.player.glideEnabled, true);
});

test('ground glide uses zero EN and regenerates after the spending delay', () => {
  const { player, input } = setup(); input.press('ShiftLeft'); input.release('ShiftLeft');
  for (let i = 0; i < 240; i++) step(player, input, i * FIXED_DT);
  assert.equal(player.glideEnabled, true); assert.equal(player.en, 120);
  player.en = 0; player.lastEnSpentAt = 0;
  const before = player.en;
  for (let i = 240; i < 330; i++) step(player, input, i * FIXED_DT);
  assert.ok(player.en > before); assert.equal(player.horizontalMode, 'glide');
});
