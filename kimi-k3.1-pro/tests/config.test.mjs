import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { FCS, GENERATORS, LEGS, DEFAULT_LOADOUT, effectiveStats } from '../src/config.js';
import { PlayerController } from '../src/player.js';
import { createPlayerModel } from '../src/models.js';
import { WeaponSystem } from '../src/weapons.js';

test('all 18 loadouts produce finite effective stats and working player models', () => {
  let count = 0;
  for (const fcs of Object.keys(FCS)) for (const generator of Object.keys(GENERATORS)) for (const legs of Object.keys(LEGS)) {
    const loadout = { fcs, generator, legs }, stats = effectiveStats(loadout);
    assert.equal(stats.maxEn, GENERATORS[generator].maxEn);
    assert.equal(stats.regenPerSecond, GENERATORS[generator].regen * LEGS[legs].regen);
    assert.ok(Math.abs(stats.lockSeconds - FCS[fcs].lockSeconds / LEGS[legs].lock) < 1e-12);
    assert.equal(stats.horizontalSpeedMultiplier, LEGS[legs].speed);
    const player = new PlayerController(createPlayerModel(legs), [], loadout);
    assert.equal(player.en, stats.maxEn); assert.equal(player.hp, 1000); assert.equal(player.ammo.machinegun, 300); assert.equal(player.ammo.missile, 12);
    assert.ok(Object.values(stats).every(Number.isFinite)); count++;
  }
  assert.equal(count, 18);
});

test('weapon switching preserves ammo, EN, per-weapon ready times and FCS progress', () => {
  const player = new PlayerController(createPlayerModel(), [], DEFAULT_LOADOUT);
  player.ammo.machinegun = 277; player.ammo.missile = 9; player.en = 73;
  player.weaponReadyAt = { machinegun: 4.2, beam: 7.1, missile: 9.3 };
  const fcs = { state: 'locked', targetId: 'G01', progress: 1, target: () => null };
  const weapons = new WeaponSystem({ scene: new THREE.Scene(), colliders: [], player, enemies: [], fcs, onEnemyDamage: () => {}, onPlayerDamage: () => {}, onNotice: () => {} });
  weapons.switchWeapon('beam'); weapons.switchWeapon('missile'); weapons.switchWeapon('machinegun');
  assert.equal(player.ammo.machinegun, 277); assert.equal(player.ammo.missile, 9); assert.equal(player.en, 73);
  assert.deepEqual(player.weaponReadyAt, { machinegun: 4.2, beam: 7.1, missile: 9.3 });
  assert.equal(fcs.targetId, 'G01'); assert.equal(fcs.progress, 1); assert.equal(fcs.state, 'locked');
});
