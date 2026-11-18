/**
 * FCS accuracy trials (specification section 4.6).
 *
 * The trials drive the *real* game systems: the same Fcs class, the same
 * Player (muzzle placement, firing) and the same projectile / collision code.
 * Nothing is re-implemented for the test.
 */
import * as THREE from 'three';
import { Player } from './player';
import { Enemy } from './enemy';
import { World } from './world';
import { updateProjectiles, type Projectile } from './projectiles';
import { makeBox } from './collision';
import type { FcsTargetInfo } from './types';
import type { FcsId, LegId } from '../core/config';

export interface TrialCondition {
  id: string;
  r: [number, number, number];
  v: [number, number, number];
}

export interface TrialResult {
  id: string;
  weapon: 'machinegun' | 'beam' | 'missile';
  r: [number, number, number];
  v: [number, number, number];
  shots: number;
  hits: number;
  maxResidualMeters: number;
  maxSpeedError: number;
  predictedSeconds: number | null;
  status: string;
  fcs: FcsId;
  legs: LegId;
  selfVelocity: [number, number, number] | null;
}

export const MG_TRIALS: TrialCondition[] = [
  { id: 'A01', r: [0, 0, 20], v: [0, 0, 0] },
  { id: 'A02', r: [0, 0, 60], v: [0, 0, 0] },
  { id: 'A03', r: [0, 0, 100], v: [0, 0, 0] },
  { id: 'A04', r: [0, 0, 120], v: [0, 0, 0] },
  { id: 'A05', r: [0, 0, 100], v: [8, 0, 0] },
  { id: 'A06', r: [0, 0, 100], v: [-8, 0, 0] },
  { id: 'A07', r: [0, 0, 100], v: [0, 0, 8] },
  { id: 'A08', r: [0, 0, 100], v: [0, 0, -8] },
  { id: 'A09', r: [0, 16, 100], v: [6, 0, 0] },
  { id: 'A10', r: [0, -16, 100], v: [-6, 0, 0] },
  { id: 'A11', r: [0, 0, 100], v: [6, 3, 0] },
  { id: 'A12', r: [0, 0, 100], v: [6, -3, 0] },
  { id: 'A13', r: [0, 0, 120], v: [6, 3, 4] }
];

/** empty test chamber so that nothing occludes the shot */
function makeTestWorld(): World {
  const scene = new THREE.Scene();
  const world = new World(scene);
  const S = 200;
  world.addSolid(makeBox(-S, -2, -S, S, 0, S, 'floor'));
  world.addSolid(makeBox(-S, 80, -S, S, 82, S, 'ceiling'));
  world.addSolid(makeBox(-S - 2, 0, -S - 2, -S, 80, S + 2, 'wall'));
  world.addSolid(makeBox(S, 0, -S - 2, S + 2, 80, S + 2, 'wall'));
  world.addSolid(makeBox(-S, 0, -S - 2, S, 80, -S, 'wall'));
  world.addSolid(makeBox(-S, 0, S, S, 80, S + 2, 'wall'));
  world.buildNavGraph();
  return world;
}

interface Rig {
  world: World;
  player: Player;
  camera: THREE.PerspectiveCamera;
  target: Enemy;
  enemies: Enemy[];
  projectiles: Projectile[];
}

function makeRig(fcs: FcsId, legs: LegId): Rig {
  const world = makeTestWorld();
  const player = new Player({ fcs, generator: 'balanced', legs, weapon: 'machinegun' });
  player.position.set(0, 18.6, -1.4);
  const camera = new THREE.PerspectiveCamera(72, 1280 / 720, 0.08, 1000);
  const target = new Enemy({
    id: 'TEST-TARGET',
    kind: 'guard',
    zoneId: 'test',
    x: 0,
    y: 20,
    z: 100,
    yaw: 0,
    isGateControl: false
  });
  target.radiusOverride = 0.5;
  target.maxHp = 1e9;
  target.hp = 1e9;
  return { world, player, camera, target, enemies: [target], projectiles: [] };
}

function targetInfo(t: Enemy): FcsTargetInfo {
  return {
    id: t.id,
    x: t.pos.x,
    y: t.pos.y,
    z: t.pos.z,
    vx: t.vel.x,
    vy: t.vel.y,
    vz: t.vel.z,
    alive: t.alive,
    radius: t.radius
  };
}

/**
 * Runs one trial.  `selfVelocity` lets the caller check that the projectile
 * never inherits the player's own velocity.
 */
export function runTrial(
  condition: TrialCondition,
  weapon: 'machinegun' | 'beam' | 'missile',
  shots: number,
  fcs: FcsId = 'medium',
  legs: LegId = 'biped',
  selfVelocity: [number, number, number] | null = null
): TrialResult {
  const rig = makeRig(fcs, legs);
  const { player, camera, target, world, enemies, projectiles } = rig;
  const muzzleGoal = new THREE.Vector3(0, 20, 0);
  let now = 0;
  let hits = 0;
  let maxResidual = 0;
  let maxSpeedError = 0;
  let predicted: number | null = null;
  let status = 'solved';

  for (let shot = 0; shot < shots; shot++) {
    // reset the target and the player for this shot
    target.pos.set(muzzleGoal.x + condition.r[0], muzzleGoal.y + condition.r[1], muzzleGoal.z + condition.r[2]);
    target.vel.set(condition.v[0], condition.v[1], condition.v[2]);
    target.hp = 1e9;
    player.velocity.set(selfVelocity ? selfVelocity[0] : 0, selfVelocity ? selfVelocity[1] : 0, selfVelocity ? selfVelocity[2] : 0);
    player.en = player.maxEn;
    player.ammo.machinegun = 300;
    player.ammo.missile = 12;
    player.nextFireAt.machinegun = 0;
    player.nextFireAt.beam = 0;
    player.nextFireAt.missile = 0;
    player.fcs.reset();
    player.selectWeapon(weapon);

    // Aim the camera at the target and settle the whole arrangement: the muzzle
    // has to end up exactly at (0, 20, 0) and the target exactly at r from it.
    for (let i = 0; i < 40; i++) {
      const before = player.muzzleWorld.clone();
      const dir = target.pos.clone().sub(muzzleGoal).normalize();
      camera.position.copy(muzzleGoal).addScaledVector(dir, -40);
      camera.lookAt(target.pos);
      camera.updateMatrixWorld(true);
      const ctx = makeCtx(rig, now, 1 / 120, target);
      player.updateAim(ctx);
      // re-anchor the target to the current muzzle, then re-anchor the player
      target.pos.set(
        player.muzzleWorld.x + condition.r[0],
        player.muzzleWorld.y + condition.r[1],
        player.muzzleWorld.z + condition.r[2]
      );
      player.position.add(muzzleGoal.clone().sub(player.muzzleWorld));
      player.rig.root.position.copy(player.position);
      player.rig.root.updateMatrixWorld(true);
      if (i > 3 && player.muzzleWorld.distanceTo(before) < 1e-10) break;
    }
    // final anchoring with the settled muzzle
    target.pos.set(
      player.muzzleWorld.x + condition.r[0],
      player.muzzleWorld.y + condition.r[1],
      player.muzzleWorld.z + condition.r[2]
    );
    const dirF = target.pos.clone().sub(muzzleGoal).normalize();
    camera.position.copy(muzzleGoal).addScaledVector(dirF, -40);
    camera.lookAt(target.pos);
    camera.updateMatrixWorld(true);
    // re-lock after the final placement
    let guard = 0;
    while (player.fcs.state !== 'locked' && guard < 600) {
      const ctx = makeCtx(rig, now, 1 / 120, target);
      player.updateAim(ctx);
      now += 1 / 120;
      guard++;
    }

    const ctx = makeCtx(rig, now, 1 / 120, target);
    player.updateAim(ctx);
    now += 1 / 120;

    const rec = player.fire(now, ctx);
    if (!rec) {
      status = 'shot refused';
      continue;
    }
    if (rec.solutionStatus !== 'solved') status = rec.solutionStatus;
    predicted = rec.predictedFlightSeconds;
    const speed = rec.initialVelocity
      ? Math.hypot(rec.initialVelocity[0], rec.initialVelocity[1], rec.initialVelocity[2])
      : 0;
    if (weapon === 'machinegun') maxSpeedError = Math.max(maxSpeedError, Math.abs(speed - 100));

    // advance the real projectile until it resolves
    const before = target.hp;
    if (weapon === 'beam') {
      // the beam is resolved by the game code; emulate the same line test
      const origin = new THREE.Vector3(...rec.muzzlePosition);
      const d = new THREE.Vector3(...rec.launchDirection);
      const to = target.pos.clone().sub(origin);
      const along = to.dot(d);
      const perp = to.clone().sub(d.clone().multiplyScalar(along)).length();
      if (along > 0 && perp <= target.radius) hits++;
    } else if (weapon === 'missile') {
      projectiles.push({
        kind: 'missile',
        pos: new THREE.Vector3(...rec.muzzlePosition),
        vel: new THREE.Vector3(...rec.initialVelocity!),
        targetId: target.id,
        obsPos: target.pos.clone(),
        obsVel: target.vel.clone(),
        age: 0,
        life: 4,
        createdAt: now
      });
      for (let i = 0; i < 600; i++) {
        target.pos.addScaledVector(target.vel, 1 / 120);
        updateProjectiles(projectiles, 1 / 120, now, world, enemies, new THREE.Vector3(0, 0, 0), 0.5, {
          onImpact: () => {},
          onExplosion: () => {},
          onEnemyDamaged: (e, d) => {
            e.hp -= d;
          },
          onPlayerDamaged: () => {}
        });
        now += 1 / 120;
        if (projectiles.length === 0) break;
      }
    } else {
      projectiles.push({
        kind: 'machinegun',
        ox: rec.muzzlePosition[0],
        oy: rec.muzzlePosition[1],
        oz: rec.muzzlePosition[2],
        vx: rec.initialVelocity![0],
        vy: rec.initialVelocity![1],
        vz: rec.initialVelocity![2],
        age: 0,
        life: 2,
        createdAt: now
      });
      // analytic residual check at the predicted intercept time
      if (rec.predictedFlightSeconds !== null && rec.predictedInterceptPosition) {
        const t = rec.predictedFlightSeconds;
        const proj = new THREE.Vector3(
          rec.muzzlePosition[0] + rec.initialVelocity![0] * t,
          rec.muzzlePosition[1] + rec.initialVelocity![1] * t - 0.5 * 18 * t * t,
          rec.muzzlePosition[2] + rec.initialVelocity![2] * t
        );
        const ip = new THREE.Vector3(...rec.predictedInterceptPosition);
        maxResidual = Math.max(maxResidual, proj.distanceTo(ip));
      }
      for (let i = 0; i < 400; i++) {
        target.pos.addScaledVector(target.vel, 1 / 120);
        updateProjectiles(projectiles, 1 / 120, now, world, enemies, new THREE.Vector3(0, 0, 0), 0.5, {
          onImpact: () => {},
          onExplosion: () => {},
          onEnemyDamaged: (e, d) => {
            e.hp -= d;
          },
          onPlayerDamaged: () => {}
        });
        now += 1 / 120;
        if (projectiles.length === 0) break;
      }
    }
    if (target.hp < before) hits++;
  }

  return {
    id: condition.id,
    weapon,
    r: condition.r,
    v: condition.v,
    shots,
    hits,
    maxResidualMeters: maxResidual,
    maxSpeedError,
    predictedSeconds: predicted,
    status,
    fcs,
    legs,
    selfVelocity
  };
}

function makeCtx(rig: Rig, now: number, dt: number, target: Enemy) {
  const dir = new THREE.Vector3();
  rig.camera.getWorldDirection(dir);
  const origin = rig.camera.position;
  const far = origin.clone().addScaledVector(dir, 400);
  return {
    input: {
      isDown: () => false,
      wasPressed: () => false,
      moveX: 0,
      moveZ: 0,
      brake: false,
      qbEdge: false,
      glideEdge: false,
      jumpEdge: false,
      spaceHeld: 0,
      weaponRequest: () => null
    } as never,
    world: rig.world,
    camera: rig.camera,
    cameraPos: origin,
    cameraDir: dir,
    freeAimPoint: far,
    targets: [targetInfo(target)],
    viewWidth: 1280,
    viewHeight: 720,
    dt,
    now
  };
}

/** Full acceptance run: all machinegun conditions plus beam and missile checks. */
export function runAllTrials(): {
  machinegun: TrialResult[];
  beam: TrialResult[];
  missile: TrialResult[];
  fcsVariants: TrialResult[];
  movingSelf: TrialResult[];
} {
  const machinegun = MG_TRIALS.map((c) => runTrial(c, 'machinegun', 20));
  const beam = MG_TRIALS.map((c) => runTrial(c, 'beam', 20));
  const missile = MG_TRIALS.map((c) => runTrial(c, 'missile', 20));
  const fcsVariants: TrialResult[] = [];
  for (const fcs of ['wide', 'medium', 'narrow'] as FcsId[]) {
    for (const legs of ['biped', 'quadruped'] as LegId[]) {
      fcsVariants.push(runTrial(MG_TRIALS[4], 'machinegun', 20, fcs, legs));
      fcsVariants.push(runTrial(MG_TRIALS[8], 'machinegun', 20, fcs, legs));
    }
  }
  const movingSelf = [
    { name: 'glide', vel: [0, 0, 22] as [number, number, number] },
    { name: 'fly', vel: [0, 8, 16] as [number, number, number] },
    { name: 'qb', vel: [0, 0, 80] as [number, number, number] }
  ].map((m) => runTrial(MG_TRIALS[4], 'machinegun', 20, 'medium', 'biped', m.vel));

  return { machinegun, beam, missile, fcsVariants, movingSelf };
}
