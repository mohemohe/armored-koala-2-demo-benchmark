import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { FactoryStage } from '../src/stage.js';
import { Game } from '../src/game.js';
import { ENEMY, CONTROL_TURRETS, BARRIER_FOR_CONTROL } from '../src/config.js';

function fixture() {
  const stage = new FactoryStage(new THREE.Scene());
  const enemies = stage.enemySpawns.map(spawn => ({ ...spawn, position: new THREE.Vector3(...spawn.position), velocity: new THREE.Vector3(), hp: ENEMY[spawn.kind].hp, alive: true, model: { group: { visible: true } } }));
  const game = { state: 'playing', stage, enemies, controlsDestroyed: 0, objective: { gateOpen: false }, weapons: { addImpact: () => {} }, hud: { setNotice: () => {} } };
  return { stage, enemies, game };
}

test('six control turrets open their own barriers and then the final gate', () => {
  const { stage, enemies, game } = fixture();
  for (const id of CONTROL_TURRETS) {
    const enemy = enemies.find(e => e.id === id);
    Game.prototype.damageEnemy.call(game, enemy, 240, enemy.position);
    assert.equal(enemy.alive, false); assert.equal(stage.barriers.get(BARRIER_FOR_CONTROL[id]).open, true);
  }
  assert.equal(game.controlsDestroyed, 6); assert.equal(game.objective.gateOpen, true); assert.equal(stage.barriers.get('FINAL').open, true);
  assert.equal(stage.barriers.get('FINAL').collider.active, false);
});

test('ordinary enemies do not count as controls and stage reset closes every gate', () => {
  const { stage, enemies, game } = fixture();
  const guard = enemies.find(e => e.id === 'G01'); Game.prototype.damageEnemy.call(game, guard, 120, guard.position);
  assert.equal(game.controlsDestroyed, 0); assert.equal(game.objective.gateOpen, false);
  for (const id of CONTROL_TURRETS) { const enemy = enemies.find(e => e.id === id); Game.prototype.damageEnemy.call(game, enemy, 240, enemy.position); }
  stage.reset();
  for (const barrier of stage.barriers.values()) { assert.equal(barrier.open, false); assert.equal(barrier.collider.active, true); assert.equal(barrier.collider.mesh.visible, true); }
});
