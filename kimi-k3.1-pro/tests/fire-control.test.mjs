import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PlayerController } from '../src/player.js';
import { createPlayerModel } from '../src/models.js';
import { FlightControlSystem } from '../src/fcs.js';
import { WeaponSystem } from '../src/weapons.js';
import { DEFAULT_LOADOUT, FIXED_DT } from '../src/config.js';

const CASES = [
  ['A01', [0, 0, 20], [0, 0, 0]], ['A02', [0, 0, 60], [0, 0, 0]],
  ['A03', [0, 0, 100], [0, 0, 0]], ['A04', [0, 0, 120], [0, 0, 0]],
  ['A05', [0, 0, 100], [8, 0, 0]], ['A06', [0, 0, 100], [-8, 0, 0]],
  ['A07', [0, 0, 100], [0, 0, 8]], ['A08', [0, 0, 100], [0, 0, -8]],
  ['A09', [0, 16, 100], [6, 0, 0]], ['A10', [0, -16, 100], [-6, 0, 0]],
  ['A11', [0, 0, 100], [6, 3, 0]], ['A12', [0, 0, 100], [6, -3, 0]],
  ['A13', [0, 0, 120], [6, 3, 4]],
];

function harness(weapon, onHit) {
  const scene = new THREE.Scene();
  const model = createPlayerModel();
  const player = new PlayerController(model, [], DEFAULT_LOADOUT);
  // Place the real model so its ordinary muzzle transform is exactly (0,20,0).
  model.group.position.set(-1.13, 20 - 1.63, 0.52); model.group.rotation.set(0, 0, 0); model.group.updateMatrixWorld(true);
  player.position.set(0, 20, 0); player.weapon = weapon; model.setWeapon(weapon); player.weaponReadyAt[weapon] = 0;
  const muzzle = player.getMuzzlePosition();
  const camera = new THREE.PerspectiveCamera(72, 16 / 9, 0.1, 500);
  const canvas = { clientWidth: 1280, clientHeight: 720 };
  const fcs = new FlightControlSystem(camera, canvas, []); fcs.configure(DEFAULT_LOADOUT, player.stats);
  const target = { id: 'TEST', kind: 'guard', isGateControl: false, sectorId: 'TEST', position: new THREE.Vector3(), previousPosition: new THREE.Vector3(), velocity: new THREE.Vector3(), hp: 1e9, alive: true, alert: false, hasLineOfSight: true, hitRadius: 0.5 };
  const weapons = new WeaponSystem({ scene, colliders: [], player, enemies: [target], fcs, onEnemyDamage: onHit, onPlayerDamage: () => {}, onNotice: () => {} });
  return { scene, model, player, muzzle, camera, fcs, target, weapons };
}

function runShot(weapon, r, v) {
  let hits = 0;
  const h = harness(weapon, () => { hits++; });
  const p = h.muzzle.clone().add(new THREE.Vector3(...r));
  h.camera.position.copy(h.muzzle).add(new THREE.Vector3(0, 0, -10)); h.camera.lookAt(p); h.camera.updateMatrixWorld(true);
  h.target.position.copy(p); h.target.previousPosition.copy(p); h.target.velocity.set(0, 0, 0);
  // Ordinary automatic FCS acquisition; no direct assignment of lock state.
  for (let i = 0; i < 100; i++) h.fcs.update(FIXED_DT, [h.target], h.player.getMuzzlePosition());
  assert.equal(h.fcs.state, 'locked');
  h.target.velocity.set(...v); h.player.weaponReadyAt[weapon] = 0;
  const fired = h.weapons.tryFire(0, h.camera); assert.equal(fired, true);
  const shot = h.weapons.recentPlayerShots[0];
  const residual = h.weapons.fireControl.residualMeters;
  assert.equal(shot.solutionStatus, 'solved');
  assert.equal(h.weapons.projectiles.length, weapon === 'beam' ? 0 : 1);
  if (weapon === 'machinegun') assert.ok(Math.abs(Math.hypot(...shot.initialVelocity) - 100) <= 0.001);
  let maxTurn = 0;
  for (let i = 0; i < 480 && hits === 0; i++) {
    h.target.previousPosition.copy(h.target.position); h.target.position.addScaledVector(h.target.velocity, FIXED_DT);
    const oldDirection = weapon === 'missile' && h.weapons.projectiles[0] ? h.weapons.projectiles[0].velocity.clone().normalize() : null;
    h.weapons.update(FIXED_DT, i * FIXED_DT);
    if (oldDirection && h.weapons.projectiles[0]) maxTurn = Math.max(maxTurn, oldDirection.angleTo(h.weapons.projectiles[0].velocity.clone().normalize()));
  }
  return { hits, shot, maxTurn, residual };
}

for (const [id, r, v] of CASES) {
  test(`${id}: machinegun 20/20 real projectile hits, residual <= 0.01m`, () => {
    let residual = 0;
    for (let n = 0; n < 20; n++) {
      const result = runShot('machinegun', r, v);
      assert.equal(result.hits, 1, `${id} shot ${n + 1}`); residual = Math.max(residual, result.residual);
    }
    assert.ok(residual <= 0.01);
  });
}

for (const [id, r, v] of CASES) {
  test(`${id}: beam hits the present center 20/20`, () => {
    for (let n = 0; n < 20; n++) assert.equal(runShot('beam', r, v).hits, 1);
  });
}

for (const [id, r, v] of CASES.slice(4, 7)) {
  test(`${id}: missile lead and limited-turn guidance hits 20/20`, () => {
    for (let n = 0; n < 20; n++) {
      const result = runShot('missile', r, v); assert.equal(result.hits, 1);
      assert.ok(Math.abs(Math.hypot(...result.shot.initialVelocity) - 45) < 1e-9);
      assert.ok(result.maxTurn <= 120 * Math.PI / 180 * FIXED_DT + 1e-5);
    }
  });
}

test('A05 during glide, flight and QB never inherits player velocity', () => {
  for (const velocity of [[22, 0, 0], [0, 8, 0], [80, 0, 0]]) {
    let hits = 0; const h = harness('machinegun', () => { hits++; });
    const r = [0, 0, 100], v = [8, 0, 0], p = h.muzzle.clone().add(new THREE.Vector3(...r));
    h.camera.position.copy(h.muzzle).add(new THREE.Vector3(0, 0, -10)); h.camera.lookAt(p); h.camera.updateMatrixWorld(true);
    h.target.position.copy(p); h.target.previousPosition.copy(p); h.target.velocity.set(0, 0, 0);
    for (let i = 0; i < 100; i++) h.fcs.update(FIXED_DT, [h.target], h.player.getMuzzlePosition());
    h.target.velocity.set(...v); h.player.velocity.set(...velocity); h.player.weaponReadyAt.machinegun = 0;
    h.weapons.tryFire(0, h.camera);
    const shot = h.weapons.recentPlayerShots[0];
    assert.ok(Math.abs(Math.hypot(...shot.initialVelocity) - 100) <= 0.001);
    for (let i = 0; i < 240 && !hits; i++) { h.target.previousPosition.copy(h.target.position); h.target.position.addScaledVector(h.target.velocity, FIXED_DT); h.weapons.update(FIXED_DT, i * FIXED_DT); }
    assert.equal(hits, 1);
  }
});
