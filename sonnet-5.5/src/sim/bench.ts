/**
 * window.AK2_BENCH.getSnapshot() (SPEC §10). Read-only: builds a deep copy of the real game state.
 * Never compute evaluation-only numbers here; everything comes from GameState.
 */
import { STAGE } from '../config';
import type { EnemyKind, GameState, SolutionStatus, V3, WeaponId } from './types';

type Vec3 = [number, number, number];
const t3 = (v: V3): Vec3 => [num(v.x), num(v.y), num(v.z)];
const t3n = (v: V3 | null): Vec3 | null => (v ? t3(v) : null);
const num = (x: number): number => (Number.isFinite(x) ? x : 0);
const numn = (x: number | null): number | null => (x === null || !Number.isFinite(x) ? null : x);

export interface Snapshot {
  version: 'AK2-1.2-candidate';
  seed: number;
  state: 'garage' | 'playing' | 'paused' | 'cleared' | 'failed';
  elapsedSeconds: number;
  loadout: { fcs: 'wide' | 'medium' | 'narrow'; generator: 'capacity' | 'balanced' | 'recovery'; legs: 'biped' | 'quadruped' };
  player: {
    position: Vec3;
    velocity: Vec3;
    grounded: boolean;
    hp: number;
    en: number;
    weapon: WeaponId;
    ammo: { machinegun: number; missile: number };
    movement: {
      horizontalMode: 'walk' | 'glide' | 'quickboost';
      verticalMode: 'grounded' | 'rising' | 'flying' | 'falling';
      glideEnabled: boolean;
      desiredHorizontalDirection: [number, number];
      qbSuccessfulCount: number;
      qbLastStartedAtSeconds: number | null;
      qbImpulseRemainingSeconds: number;
      qbCooldownRemainingSeconds: number;
      lastEnSpentAtSeconds: number | null;
    };
  };
  effectiveStats: { maxEn: number; regenPerSecond: number; lockSeconds: number; horizontalSpeedMultiplier: number };
  lock: { state: 'none' | 'acquiring' | 'locked'; targetId: string | null; progress: number; radiusCssPx: number };
  fireControl: {
    status: SolutionStatus;
    weapon: WeaponId;
    targetId: string | null;
    evaluatedAtSeconds: number | null;
    muzzlePosition: Vec3 | null;
    targetPosition: Vec3 | null;
    targetVelocity: Vec3 | null;
    launchDirection: Vec3 | null;
    predictedFlightSeconds: number | null;
    predictedInterceptPosition: Vec3 | null;
    aimPoint: Vec3 | null;
    residualMeters: number | null;
  };
  recentPlayerShots: Array<{
    id: number;
    firedAtSeconds: number;
    weapon: WeaponId;
    targetId: string | null;
    solutionStatus: SolutionStatus;
    muzzlePosition: Vec3;
    targetPositionAtFire: Vec3 | null;
    targetVelocityAtFire: Vec3 | null;
    launchDirection: Vec3;
    initialVelocity: Vec3 | null;
    accelerationAtFire: Vec3;
    predictedFlightSeconds: number | null;
    predictedInterceptPosition: Vec3 | null;
  }>;
  enemies: Array<{
    id: string;
    kind: EnemyKind;
    isGateControl: boolean;
    sectorId: string;
    position: Vec3;
    velocity: Vec3;
    hp: number;
    alive: boolean;
    alert: boolean;
    hasLineOfSight: boolean;
    shotsFired: number;
    lastShotAtSeconds: number | null;
  }>;
  objective: { controlsDestroyed: number; controlsRequired: 6; openBarrierIds: string[]; gateOpen: boolean };
  stage: { sectorCount: number; currentSectorId: string | null; visitedSectorIds: string[]; totalEnemies: 45 };
}

export function buildSnapshot(s: GameState): Snapshot {
  const p = s.player;
  const mv = p.mv;
  const fc = s.fc;
  return {
    version: 'AK2-1.2-candidate',
    seed: s.seed,
    state: s.mode,
    elapsedSeconds: num(s.time),
    loadout: { fcs: s.loadout.fcs, generator: s.loadout.generator, legs: s.loadout.legs },
    player: {
      position: t3(p.pos),
      velocity: t3(p.vel),
      grounded: p.grounded,
      hp: num(p.hp),
      en: num(p.en),
      weapon: p.weapon,
      ammo: { machinegun: p.ammo.machinegun, missile: p.ammo.missile },
      movement: {
        horizontalMode: mv.horizontalMode,
        verticalMode: mv.verticalMode,
        glideEnabled: mv.glideEnabled,
        desiredHorizontalDirection: [num(mv.desiredDir.x), num(mv.desiredDir.z)],
        qbSuccessfulCount: mv.qbSuccessCount,
        qbLastStartedAtSeconds: numn(mv.qbLastStartedAt),
        qbImpulseRemainingSeconds: num(mv.qbImpulseRemaining),
        qbCooldownRemainingSeconds: num(mv.qbCooldownRemaining),
        lastEnSpentAtSeconds: numn(mv.lastEnSpentAt),
      },
    },
    effectiveStats: {
      maxEn: s.stats.maxEn,
      regenPerSecond: s.stats.regenPerSecond,
      lockSeconds: s.stats.lockSeconds,
      horizontalSpeedMultiplier: s.stats.horizontalSpeedMultiplier,
    },
    lock: { state: s.lock.state, targetId: s.lock.targetId, progress: num(s.lock.progress), radiusCssPx: num(s.lock.radiusCssPx) },
    fireControl: {
      status: fc.status,
      weapon: fc.weapon,
      targetId: fc.targetId,
      evaluatedAtSeconds: numn(fc.evaluatedAtSeconds),
      muzzlePosition: t3n(fc.muzzlePosition),
      targetPosition: t3n(fc.targetPosition),
      targetVelocity: t3n(fc.targetVelocity),
      launchDirection: t3n(fc.launchDirection),
      predictedFlightSeconds: numn(fc.predictedFlightSeconds),
      predictedInterceptPosition: t3n(fc.predictedInterceptPosition),
      aimPoint: t3n(fc.aimPoint),
      residualMeters: numn(fc.residualMeters),
    },
    recentPlayerShots: s.shots.map((r) => ({
      id: r.id,
      firedAtSeconds: num(r.firedAtSeconds),
      weapon: r.weapon,
      targetId: r.targetId,
      solutionStatus: r.solutionStatus,
      muzzlePosition: t3(r.muzzlePosition),
      targetPositionAtFire: t3n(r.targetPositionAtFire),
      targetVelocityAtFire: t3n(r.targetVelocityAtFire),
      launchDirection: t3(r.launchDirection),
      initialVelocity: t3n(r.initialVelocity),
      accelerationAtFire: t3(r.accelerationAtFire),
      predictedFlightSeconds: numn(r.predictedFlightSeconds),
      predictedInterceptPosition: t3n(r.predictedInterceptPosition),
    })),
    enemies: s.enemies.map((e) => ({
      id: e.id,
      kind: e.kind,
      isGateControl: e.isGateControl,
      sectorId: e.sectorId,
      position: t3(e.pos),
      velocity: t3(e.vel),
      hp: num(e.hp),
      alive: e.alive,
      alert: e.alert,
      hasLineOfSight: e.hasLineOfSight,
      shotsFired: e.shotsFired,
      lastShotAtSeconds: numn(e.lastShotAt),
    })),
    objective: {
      controlsDestroyed: s.objective.controlsDestroyed,
      controlsRequired: STAGE.CONTROLS_REQUIRED,
      openBarrierIds: [...s.objective.openBarrierIds],
      gateOpen: s.objective.gateOpen,
    },
    stage: {
      sectorCount: s.stage.sectors.length,
      currentSectorId: s.progress.currentSectorId,
      visitedSectorIds: [...s.progress.visitedSectorIds],
      totalEnemies: 45,
    },
  };
}
