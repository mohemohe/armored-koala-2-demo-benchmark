import * as THREE from 'three';
import { Player } from '../src/game/player';
import { Enemy } from '../src/game/enemy';
import { makeBox, raycastWorld } from '../src/game/collision';
import { World } from '../src/game/world';

const R: [number, number, number] = [0, 0, 120];

const S = 200;
const scene = new THREE.Scene();
const world = new World(scene);
world.addSolid(makeBox(-S, -2, -S, S, 0, S, 'floor'));
world.addSolid(makeBox(-S, 80, -S, S, 82, S, 'ceiling'));
world.addSolid(makeBox(-S - 2, 0, -S - 2, -S, 80, S + 2, 'wall'));
world.addSolid(makeBox(S, 0, -S - 2, S + 2, 80, S + 2, 'wall'));
world.addSolid(makeBox(-S, 0, -S - 2, S, 80, -S, 'wall'));
world.addSolid(makeBox(-S, 0, S, S, 80, S + 2, 'wall'));

const player = new Player({ fcs: 'medium', generator: 'balanced', legs: 'biped', weapon: 'machinegun' });
player.position.set(0, 18.6, -1.4);
const camera = new THREE.PerspectiveCamera(72, 1280 / 720, 0.08, 1000);
const target = new Enemy({ id: 'T', kind: 'guard', zoneId: 'test', x: 0, y: 20, z: 120, yaw: 0, isGateControl: false });
target.radiusOverride = 0.5;

const muzzleGoal = new THREE.Vector3(0, 20, 0);
let now = 0;
const mkCtx = () => ({
  input: { isDown: () => false, moveX: 0, moveZ: 0, brake: false, qbEdge: false, glideEdge: false, jumpEdge: false, spaceHeld: 0, weaponRequest: () => null } as never,
  world, camera,
  cameraPos: camera.position,
  cameraDir: new THREE.Vector3(0, 0, 1),
  freeAimPoint: camera.position.clone().addScaledVector(new THREE.Vector3(0, 0, 1), 400),
  targets: [{ id: 'T', x: target.pos.x, y: target.pos.y, z: target.pos.z, vx: 0, vy: 0, vz: 0, alive: true, radius: 0.5 }],
  viewWidth: 1280, viewHeight: 720, dt: 1 / 120, now
});

target.pos.set(muzzleGoal.x + R[0], muzzleGoal.y + R[1], muzzleGoal.z + R[2]);
for (let i = 0; i < 40; i++) {
  const before = player.muzzleWorld.clone();
  const dir = target.pos.clone().sub(muzzleGoal).normalize();
  camera.position.copy(muzzleGoal).addScaledVector(dir, -40);
  camera.lookAt(target.pos);
  camera.updateMatrixWorld(true);
  player.updateAim(mkCtx());
  target.pos.set(player.muzzleWorld.x + R[0], player.muzzleWorld.y + R[1], player.muzzleWorld.z + R[2]);
  player.position.add(muzzleGoal.clone().sub(player.muzzleWorld));
  player.rig.root.position.copy(player.position);
  player.rig.root.updateMatrixWorld(true);
  if (i > 3 && player.muzzleWorld.distanceTo(before) < 1e-10) {
    console.log('converged at iter', i);
    break;
  }
}
target.pos.set(player.muzzleWorld.x + R[0], player.muzzleWorld.y + R[1], player.muzzleWorld.z + R[2]);
const dirF = target.pos.clone().sub(muzzleGoal).normalize();
camera.position.copy(muzzleGoal).addScaledVector(dirF, -40);
camera.lookAt(target.pos);
camera.updateMatrixWorld(true);

console.log('muzzle', player.muzzleWorld.toArray());
console.log('target', target.pos.toArray());
const d = Math.hypot(target.pos.x - player.muzzleWorld.x, target.pos.y - player.muzzleWorld.y, target.pos.z - player.muzzleWorld.z);
console.log('dist', d, 'over?', d > 120 + 1e-6);

for (let i = 0; i < 5; i++) {
  const ctx = mkCtx();
  player.updateAim(ctx);
  now += 1 / 120;
  const t = ctx.targets[0];
  const dist = Math.hypot(t.x - player.muzzleWorld.x, t.y - player.muzzleWorld.y, t.z - player.muzzleWorld.z);
  const v = new THREE.Vector3(t.x, t.y, t.z);
  v.project(camera);
  const sx = (v.x * 0.5 + 0.5) * 1280;
  const sy = (1 - (v.y * 0.5 + 0.5)) * 720;
  const to = new THREE.Vector3(t.x - camera.position.x, t.y - camera.position.y, t.z - camera.position.z);
  const len = to.length();
  const camHit = raycastWorld(world.hash, camera.position.x, camera.position.y, camera.position.z, to.x / len, to.y / len, to.z / len, len - 0.05);
  const mHit = raycastWorld(world.hash, player.muzzleWorld.x, player.muzzleWorld.y, player.muzzleWorld.z, to.x / len, to.y / len, to.z / len, len - 0.05);
  console.log(
    `step ${i} state=${player.fcs.state} prog=${player.fcs.progress.toFixed(4)} dist=${dist.toFixed(9)} sx=${sx.toFixed(2)} sy=${sy.toFixed(2)} ndcZ=${v.z.toFixed(6)} camLOS=${camHit.hit} muzLOS=${mHit.hit}`
  );
}
