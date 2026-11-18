import fs from 'node:fs/promises';
import * as THREE from 'three';
import { PlayerController } from '../src/player.js';
import { createPlayerModel } from '../src/models.js';
import { DEFAULT_LOADOUT, FIXED_DT } from '../src/config.js';
import { solveMachinegun } from '../src/ballistics.js';
import { FactoryStage } from '../src/stage.js';
import { EnemySystem } from '../src/enemies.js';
import { WeaponSystem } from '../src/weapons.js';

class Input {
  constructor() { this.keys = new Set(); this.presses = new Set(); }
  down(code) { return this.keys.has(code); }
  consumePress(code) { const value = this.presses.has(code); this.presses.delete(code); return value; }
}
function measureQB(legs) {
  const floor = { min: [-2000, -1, -2000], max: [2000, 0, 2000], active: true };
  const player = new PlayerController(createPlayerModel(legs), [floor], { ...DEFAULT_LOADOUT, legs });
  const input = new Input(); input.keys.add('KeyQ'); input.presses.add('KeyQ');
  const start = player.position.clone();
  for (let i = 0; i < 90; i++) {
    player.beginStep(FIXED_DT, i * FIXED_DT, input, 0);
    player.updateMovement(FIXED_DT, i * FIXED_DT, input, 0);
    if (i === 0) input.keys.delete('KeyQ');
  }
  return { legs, seconds: 0.75, displacementMeters: start.distanceTo(player.position), position: player.position.toArray(), en: player.en, qbCount: player.qbSuccessfulCount, horizontalMode: player.horizontalMode, glideEnabled: player.glideEnabled, horizontalSpeed: Math.hypot(player.velocity.x, player.velocity.z) };
}

const CASES = [
  ['A01', [0, 0, 20], [0, 0, 0]], ['A02', [0, 0, 60], [0, 0, 0]], ['A03', [0, 0, 100], [0, 0, 0]], ['A04', [0, 0, 120], [0, 0, 0]],
  ['A05', [0, 0, 100], [8, 0, 0]], ['A06', [0, 0, 100], [-8, 0, 0]], ['A07', [0, 0, 100], [0, 0, 8]], ['A08', [0, 0, 100], [0, 0, -8]],
  ['A09', [0, 16, 100], [6, 0, 0]], ['A10', [0, -16, 100], [-6, 0, 0]], ['A11', [0, 0, 100], [6, 3, 0]], ['A12', [0, 0, 100], [6, -3, 0]], ['A13', [0, 0, 120], [6, 3, 4]],
];
const ballistics = CASES.map(([id, r, v]) => {
  const s = solveMachinegun({ m: [0, 20, 0], p: [0, 20, 0].map((value, i) => value + r[i]), v });
  return { id, flightSeconds: s.t, residualMeters: s.residual, speed: Math.hypot(...s.initialVelocity) };
});

function measureEnemyAggression() {
  const floor = { min: [-200, -1, -200], max: [200, 0, 200], active: true };
  const stage = { colliders: [floor], sectors: [{ id: 'ARENA' }], connections: [], enemySpawns: [
    { id: 'G01', kind: 'guard', sectorId: 'ARENA', position: [-40, 1.55, 0], isGateControl: false },
    { id: 'G02', kind: 'guard', sectorId: 'ARENA', position: [40, 1.55, 0], isGateControl: false },
    { id: 'T01', kind: 'turret', sectorId: 'ARENA', position: [0, 1.7, 45], isGateControl: false },
  ] };
  const scene = new THREE.Scene(); const player = new PlayerController(createPlayerModel(), [floor], DEFAULT_LOADOUT);
  player.position.set(0, 2.2, 0); player.previousPosition = player.position.clone();
  const enemies = []; const weapons = new WeaponSystem({ scene, colliders: [floor], player, enemies, fcs: { state: 'none', target: () => null }, onEnemyDamage: () => {}, onPlayerDamage: amount => player.damage(amount), onNotice: () => {} });
  const system = new EnemySystem(scene, stage, player, enemies); system.weapons = weapons;
  let killedAtSeconds = null;
  for (let i = 0; i < 1800; i++) {
    const now = i * FIXED_DT; player.previousPosition = player.position.clone(); system.update(FIXED_DT, now); weapons.update(FIXED_DT, now);
    if (player.hp <= 0) { killedAtSeconds = now; break; }
  }
  return { killedAtSeconds, hp: player.hp, shots: enemies.map(e => ({ id: e.id, shotsFired: e.shotsFired })) };
}

const stage = new FactoryStage(new THREE.Scene());
const result = {
  measuredAt: new Date().toISOString(), fixedStepHz: 120,
  qb: [measureQB('biped'), measureQB('quadruped')],
  ballistics,
  maxBallisticResidualMeters: Math.max(...ballistics.map(b => b.residualMeters)),
  enemyAggression: measureEnemyAggression(),
  stage: { sectorCount: stage.sectors.length, mainRouteSectors: 18, guards: stage.enemySpawns.filter(e => e.kind === 'guard').length, turrets: stage.enemySpawns.filter(e => e.kind === 'turret').length, controls: stage.enemySpawns.filter(e => e.isGateControl).map(e => ({ id: e.id, sectorId: e.sectorId, position: e.position })), portalLowerBoundMeters: stage.shortestPathMeters, floorBands: [...new Set(stage.sectors.map(s => s.floorY))].sort((a, b) => a - b) },
};
await fs.mkdir('artifacts', { recursive: true }); await fs.writeFile('artifacts/verification-results.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
