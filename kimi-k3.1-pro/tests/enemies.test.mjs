import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { EnemySystem } from '../src/enemies.js';
import { WeaponSystem } from '../src/weapons.js';
import { PlayerController } from '../src/player.js';
import { createPlayerModel } from '../src/models.js';
import { DEFAULT_LOADOUT, FIXED_DT } from '../src/config.js';

function arena() {
  const floor = { min: [-200, -1, -200], max: [200, 0, 200], active: true };
  const stage = { colliders: [floor], sectors: [{ id: 'ARENA' }], connections: [], enemySpawns: [
    { id: 'G01', kind: 'guard', sectorId: 'ARENA', position: [-40, 1.55, 0], isGateControl: false },
    { id: 'G02', kind: 'guard', sectorId: 'ARENA', position: [40, 1.55, 0], isGateControl: false },
    { id: 'T01', kind: 'turret', sectorId: 'ARENA', position: [0, 1.7, 45], isGateControl: false },
  ] };
  const scene = new THREE.Scene(); const player = new PlayerController(createPlayerModel(), [floor], DEFAULT_LOADOUT);
  player.position.set(0, 2.2, 0); player.previousPosition = player.position.clone();
  const enemies = []; const fcs = { state: 'none', target: () => null };
  const weapons = new WeaponSystem({ scene, colliders: [floor], player, enemies, fcs, onEnemyDamage: () => {}, onPlayerDamage: amount => player.damage(amount), onNotice: () => {} });
  const system = new EnemySystem(scene, stage, player, enemies); system.weapons = weapons;
  return { player, enemies, weapons, system };
}

test('two guards and one turret independently destroy stationary HP1000 player within 15s', () => {
  const { player, enemies, weapons, system } = arena();
  let killedAt = null;
  for (let i = 0; i < 1800; i++) {
    const now = i * FIXED_DT; player.previousPosition = player.position.clone();
    system.update(FIXED_DT, now); weapons.update(FIXED_DT, now);
    if (player.hp <= 0) { killedAt = now; break; }
  }
  assert.ok(killedAt !== null && killedAt <= 15, `killedAt=${killedAt}`);
  assert.ok(enemies.every(e => e.shotsFired > 0));
});

test('guard initial shot, burst cadence and independent off-camera fire', () => {
  const { player, enemies, weapons, system } = arena();
  for (let i = 0; i < 240; i++) { const now = i * FIXED_DT; player.previousPosition = player.position.clone(); system.update(FIXED_DT, now); weapons.update(FIXED_DT, now); }
  const g = enemies[0], t = enemies[2];
  assert.ok(g.lastShotAtSeconds >= 0.50 && g.lastShotAtSeconds < 2);
  assert.ok(g.shotsFired >= 3); assert.ok(t.shotsFired >= 2);
  // There is no camera in this test at all: sensor range and LOS alone authorize attacks.
  assert.ok(enemies.every(e => e.alert));
});
