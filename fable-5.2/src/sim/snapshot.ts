/**
 * Read-only evaluation snapshot (docs/SPEC.md §10) — the data behind `window.__AK2__.getSnapshot()`.
 *
 * buildSnapshot() only READS the simulation: it never advances time, never recomputes a fire solution,
 * never re-validates the lock and never touches the random stream. Every value is copied out of the state
 * the game itself uses:
 *   - `fireControl` is `sim.fireControl`, the very solution the weapons fire with and the HUD draws
 *     (refreshed by every sub-step and by every shot);
 *   - `recentPlayerShots` are `sim.shots`, the records written at the instant of each real shot;
 *   - `qbCooldownRemainingSeconds` comes from the same function the Q press is judged with.
 * Nothing is recomputed "for diagnosis" and nothing is rounded.
 *
 * The returned object is built from fresh plain objects / arrays on every call and shares no reference
 * with the simulation, so callers may mutate it freely. Numbers are always finite (unused times are null,
 * never NaN / Infinity), which also makes the snapshot JSON-serialisable without loss.
 */
import {
  CONTROLS_REQUIRED,
  RECENT_SHOTS_MAX,
  TOTAL_ENEMIES,
  VERSION,
  computeEffectiveStats,
  type EffectiveStats,
} from '../config';
import type { V3 } from '../core/vec';
import { qbCooldownRemaining } from './player';
import type { Sim } from './sim';
import type { AppState, EnemyState, FireSolution, Loadout, ShotRecord, Snapshot, Vec3Tuple } from './types';

/** Finite number or the fallback (the API must never expose NaN / Infinity). */
function num(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

/** Finite number, or null for "no such time / value". */
function numOrNull(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) ? value : null;
}

function tuple(v: V3): Vec3Tuple {
  return [num(v.x), num(v.y), num(v.z)];
}

function tupleOrNull(v: V3 | null | undefined): Vec3Tuple | null {
  return v ? tuple(v) : null;
}

function fireControlSnapshot(fc: FireSolution): Snapshot['fireControl'] {
  if (fc.status === 'inactive') {
    // No complete lock: only the status and the selected weapon carry information.
    return {
      status: 'inactive',
      weapon: fc.weapon,
      targetId: null,
      evaluatedAtSeconds: null,
      muzzlePosition: null,
      targetPosition: null,
      targetVelocity: null,
      launchDirection: null,
      predictedFlightSeconds: null,
      predictedInterceptPosition: null,
      aimPoint: null,
      residualMeters: null,
    };
  }
  const solved = fc.status === 'solved';
  return {
    status: fc.status,
    weapon: fc.weapon,
    targetId: fc.targetId,
    evaluatedAtSeconds: numOrNull(fc.evaluatedAt),
    muzzlePosition: tupleOrNull(fc.muzzle),
    targetPosition: tupleOrNull(fc.targetPos),
    targetVelocity: tupleOrNull(fc.targetVel),
    // 'no_solution': the direct aim at the current centre and its aim point are still reported …
    launchDirection: tupleOrNull(fc.launchDir),
    // … but the arrival time, the predicted hit point and the residual do not exist.
    predictedFlightSeconds: solved ? numOrNull(fc.flightSeconds) : null,
    predictedInterceptPosition: solved ? tupleOrNull(fc.intercept) : null,
    aimPoint: tupleOrNull(fc.aimPoint),
    residualMeters: solved ? numOrNull(fc.residual) : null,
  };
}

function shotSnapshot(s: ShotRecord): Snapshot['recentPlayerShots'][number] {
  return {
    id: s.id,
    firedAtSeconds: num(s.firedAt),
    weapon: s.weapon,
    targetId: s.targetId,
    solutionStatus: s.solutionStatus,
    muzzlePosition: tuple(s.muzzle),
    targetPositionAtFire: tupleOrNull(s.targetPosAtFire),
    targetVelocityAtFire: tupleOrNull(s.targetVelAtFire),
    launchDirection: tuple(s.launchDir),
    initialVelocity: tupleOrNull(s.initialVelocity),
    accelerationAtFire: tuple(s.accelerationAtFire),
    predictedFlightSeconds: numOrNull(s.flightSeconds),
    predictedInterceptPosition: tupleOrNull(s.intercept),
  };
}

function enemySnapshot(e: EnemyState): Snapshot['enemies'][number] {
  return {
    id: e.id,
    kind: e.kind,
    isGateControl: e.isGateControl,
    sectorId: e.sectorId,
    position: tuple(e.pos),
    velocity: tuple(e.vel),
    hp: num(e.hp),
    alive: e.alive,
    alert: e.alert,
    hasLineOfSight: e.hasLos,
    shotsFired: e.shotsFired,
    lastShotAtSeconds: numOrNull(e.lastShotAt),
  };
}

/**
 * Builds the §10 snapshot for the current simulation state. Pure with respect to the simulation.
 *
 * @param appState      application state (garage / playing / paused / cleared / failed) — reported as is
 * @param garageLoadout only used while `appState` is 'garage': the loadout currently selected there. It is
 *                      reported as `loadout` together with ITS effective stats (computeEffectiveStats — the
 *                      same function the simulation uses on the next sortie) and ITS lock-circle radius for
 *                      the current viewport, instead of the values of the previous sortie. Everything else
 *                      (player, enemies, objective …) is the untouched simulation state.
 */
export function buildSnapshot(sim: Sim, appState: AppState, garageLoadout?: Loadout): Snapshot {
  const inGarage = appState === 'garage' && garageLoadout != null;
  const loadoutSrc = inGarage ? garageLoadout : sim.loadout;
  const loadout: Loadout = { fcs: loadoutSrc.fcs, generator: loadoutSrc.generator, legs: loadoutSrc.legs };
  const stats: EffectiveStats = inGarage ? computeEffectiveStats(loadout) : sim.stats;
  const p = sim.player;
  const lock = sim.lock;
  const radiusCssPx = inGarage
    ? stats.lockRadiusFactor * Math.min(sim.viewport.width, sim.viewport.height)
    : lock.radiusCssPx;
  // sim.shots is already capped by the weapons module; the slice only makes the bound unconditional.
  const shots = sim.shots.length > RECENT_SHOTS_MAX ? sim.shots.slice(-RECENT_SHOTS_MAX) : sim.shots;

  return {
    version: VERSION,
    seed: num(sim.seed) >>> 0,
    state: appState,
    elapsedSeconds: num(sim.time),
    loadout,
    player: {
      position: tuple(p.pos),
      velocity: tuple(p.vel),
      grounded: p.grounded,
      hp: num(p.hp),
      en: num(p.en),
      weapon: p.weapon,
      // The beam has no ammunition: it is not part of `ammo`.
      ammo: { machinegun: num(p.ammo.machinegun), missile: num(p.ammo.missile) },
      movement: {
        horizontalMode: p.horizontalMode,
        verticalMode: p.verticalMode,
        glideEnabled: p.glideEnabled,
        desiredHorizontalDirection: [num(p.desiredDir.x), num(p.desiredDir.z)],
        qbSuccessfulCount: num(p.qbSuccessfulCount),
        qbLastStartedAtSeconds: numOrNull(p.qbLastStartedAt),
        qbImpulseRemainingSeconds: Math.max(0, num(p.qbImpulseRemaining)),
        qbCooldownRemainingSeconds: Math.max(0, num(qbCooldownRemaining(sim))),
        lastEnSpentAtSeconds: numOrNull(p.lastEnSpentAt),
      },
    },
    effectiveStats: {
      maxEn: num(stats.maxEn),
      regenPerSecond: num(stats.regenPerSecond),
      lockSeconds: num(stats.lockSeconds),
      horizontalSpeedMultiplier: num(stats.horizontalSpeedMultiplier),
    },
    lock: {
      state: lock.state,
      targetId: lock.targetId,
      progress: Math.min(1, Math.max(0, num(lock.progress))),
      radiusCssPx: Math.max(0, num(radiusCssPx)),
    },
    fireControl: fireControlSnapshot(sim.fireControl),
    recentPlayerShots: shots.map(shotSnapshot),
    // Destroyed enemies stay listed (alive = false); order and ids are those of the stage definition.
    enemies: sim.enemies.map(enemySnapshot),
    objective: {
      controlsDestroyed: num(sim.objective.controlsDestroyed),
      // The number the gate logic really uses: the count of control turrets placed in the stage
      // (exactly six in the shipped stage — checked by the stage validator and by tests).
      controlsRequired: num(sim.objective.controlsRequired) as typeof CONTROLS_REQUIRED,
      openBarrierIds: [...sim.objective.openBarrierIds],
      gateOpen: sim.objective.gateOpen,
    },
    stage: {
      sectorCount: sim.stage.sectors.length,
      currentSectorId: sim.currentSectorId,
      visitedSectorIds: [...sim.visitedSectorIds],
      // Real number of enemies placed in the stage (45 in the shipped stage).
      totalEnemies: sim.enemies.length as typeof TOTAL_ENEMIES,
    },
  };
}
