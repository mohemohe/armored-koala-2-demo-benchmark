/**
 * SPEC §4.6 separated firing-test scenarios. OWNER: combat agent.
 *
 * An obstacle-free arena (a scaffold box under the player plus the flat arena floor), the muzzle at m = (0, 20, 0) and a
 * radius-0.5 scripted target (EnemyState.scripted: no AI, no firing, constant velocity, moved by enemyIntegrate).
 * The real Game, FCS, weapons, projectiles and hit detection run unchanged: nothing here weakens or replaces them.
 * The scenario only places things so that, at the shot tick, the target is at m + r with velocity v.
 */
import { DEFAULT_LOADOUT, PLAYER, SIM, TEST_TARGET_RADIUS } from '../config';
import { playerMuzzlePosition, updateCamera } from './camera';
import { Game } from './game';
import { add, addScaled, clone, distance, forwardFromYaw, normalize, rightFromYaw, sub } from './math';
import { computeEffectiveStats } from './stats';
import { buildTestArenaStage } from './testArena';
import type { EnemyState, Loadout, V3, WeaponId } from './types';

/** SPEC §4.6: the muzzle position of every separated test */
export const SCENARIO_MUZZLE: V3 = { x: 0, y: 20, z: 0 };
export const SCENARIO_TARGET_ID = 'TGT';
/** the scaffold the player stands on (size x, z) */
const PLATFORM_SIZE = 12;
const TIME_EPS = 1e-9;

/** a scripted test dummy: alive, huge HP, no AI, constant velocity (SPEC §4.5: radius 0.5 m is the TEST target's value) */
export function makeScriptedTarget(id: string, pos: V3, vel: V3, radius: number = TEST_TARGET_RADIUS): EnemyState {
  return {
    id,
    kind: 'guard',
    isGateControl: false,
    controlIndex: null,
    barrierId: null,
    sectorId: 'T00',
    pos: clone(pos),
    prevPos: clone(pos),
    vel: clone(vel),
    yaw: 0,
    hitRadius: radius,
    maxHp: 1e6,
    hp: 1e6,
    alive: true,
    alert: false,
    hasLineOfSight: false,
    shotsFired: 0,
    lastShotAt: null,
    telegraph: 0,
    hitFlash: 0,
    scripted: true,
    internal: {},
  };
}

export interface ScenarioSpec {
  /** target center relative to the muzzle at the shot tick (SPEC §4.6 r) */
  r: V3;
  /** target velocity, fixed for the whole run (SPEC §4.6 v) */
  v: V3;
  loadout?: Loadout;
  /** ticks between the earliest lock-complete tick and the shot tick (tests use 0..19) */
  delayTicks?: number;
  /** weapon selected at sortie (default machinegun) */
  weapon?: WeaponId;
  viewportW?: number;
  viewportH?: number;
}

export interface Scenario {
  game: Game;
  targetId: string;
  /** nominal muzzle position m (the real muzzle equals it to float precision, verified at creation) */
  muzzle: V3;
  /** the shot must be pressed at the START of this tick index (state.tick === fireTick), i.e. at time fireTime */
  fireTick: number;
  fireTime: number;
  /** ticks the lock takes: stats.lockSeconds / dt rounded up (tolerance 1e-9) */
  lockTicks: number;
  /** target center at the shot tick = m + r */
  targetAtFire: V3;
  /** target center at tick 0 (back-computed so that r, v hold at the shot tick) */
  targetStart: V3;
}

/** first tick index at which a lock-complete shot can be fired: the target is first seen at the end of tick 0 (elapsed 0) */
export function earliestLockedFireTick(lockSeconds: number): number {
  return Math.ceil(lockSeconds / SIM.DT - TIME_EPS) + 1;
}

/** player center that puts the muzzle (yaw-frame fixed offset) at `m` for the given yaw */
function centerForMuzzle(m: V3, yaw: number): V3 {
  const f = forwardFromYaw(yaw);
  const r = rightFromYaw(yaw);
  const o = PLAYER.MUZZLE_OFFSET;
  return { x: m.x - r.x * o.right - f.x * o.forward, y: m.y - o.up, z: m.z - r.z * o.right - f.z * o.forward };
}

function yawPitchOf(dir: V3): { yaw: number; pitch: number } {
  return { yaw: Math.atan2(-dir.x, -dir.z), pitch: Math.asin(Math.max(-1, Math.min(1, dir.y))) };
}

/**
 * Build a playing Game for one separated test shot. Nothing is fired: the caller runs `game.step()` `fireTick` times, presses
 * `game.input.fire` for exactly one tick and keeps stepping. The lock is completed by the normal FCS, then the shot uses the
 * normal fire-control solution, projectile update and swept hit detection.
 */
export function createScenarioGame(spec: ScenarioSpec): Scenario {
  const loadout = spec.loadout ?? { ...DEFAULT_LOADOUT };
  const stats = computeEffectiveStats(loadout);
  const m = SCENARIO_MUZZLE;
  const lockTicks = earliestLockedFireTick(stats.lockSeconds) - 1;
  const fireTick = earliestLockedFireTick(stats.lockSeconds) + (spec.delayTicks ?? 0);
  const fireTime = fireTick * SIM.DT; // same product as Game.step (time = tick * dt)
  const targetAtFire = add(m, spec.r);
  const targetStart = addScaled(targetAtFire, spec.v, -fireTime);
  // the camera aims at the middle of the target's path during the lock so the target stays well inside the FCS circle
  const aimRef = addScaled(targetAtFire, spec.v, -fireTime / 2);

  const buildGame = (platformTop: number, center: V3, yaw: number): Game => {
    const stage = buildTestArenaStage({
      platforms: [{ id: 'scaffold', top: { x: center.x, y: platformTop, z: center.z }, sizeX: PLATFORM_SIZE, sizeZ: PLATFORM_SIZE }],
      start: { pos: clone(center), yaw },
    });
    const g = new Game({ stage, loadout, viewportW: spec.viewportW, viewportH: spec.viewportH });
    g.sortie(loadout);
    return g;
  };

  // 1) aim: the muzzle depends on yaw and the camera depends on yaw/pitch -> fixed-point iteration
  const first = yawPitchOf(normalize(sub(aimRef, m), { x: 0, y: 0, z: -1 }));
  let yaw = first.yaw;
  let pitch = first.pitch;
  const probe = buildGame(m.y - PLAYER.MUZZLE_OFFSET.up - PLAYER.HALF.y, centerForMuzzle(m, yaw), yaw);
  for (let i = 0; i < 100; i++) {
    const ps = probe.state.player;
    ps.pos = centerForMuzzle(m, yaw);
    ps.yaw = yaw;
    ps.pitch = pitch;
    updateCamera(probe.state, probe.world);
    const next = yawPitchOf(normalize(sub(aimRef, probe.state.camera.pos), { x: 0, y: 0, z: -1 }));
    const converged = Math.abs(next.yaw - yaw) < 1e-14 && Math.abs(next.pitch - pitch) < 1e-14;
    yaw = next.yaw;
    pitch = next.pitch;
    if (converged) break;
  }
  const center = centerForMuzzle(m, yaw);

  // 2) calibrate the resting height: the player physics may leave a hairline gap on the scaffold. Let a probe settle and raise
  //    or lower the scaffold so the RESTING muzzle is exactly m (the shot then uses m = (0, 20, 0) to float precision).
  const nominalTop = center.y - PLAYER.HALF.y;
  const settle = buildGame(nominalTop, center, yaw);
  settle.state.player.pitch = pitch;
  for (let i = 0; i < 4; i++) settle.step();
  const restDy = settle.state.player.pos.y - center.y;
  const top = nominalTop - restDy;

  // 3) the real game: the player starts at its resting pose, the scripted target at its back-computed start
  const game = buildGame(top, center, yaw);
  const s = game.state;
  s.player.yaw = yaw;
  s.player.pitch = pitch;
  s.player.weapon = spec.weapon ?? 'machinegun';
  updateCamera(s, game.world);
  s.enemies.push(makeScriptedTarget(SCENARIO_TARGET_ID, targetStart, spec.v));
  const actual = playerMuzzlePosition(s.player);
  if (distance(actual, m) > 1e-6) throw new Error(`scenario muzzle calibration failed: ${JSON.stringify(actual)}`);
  return { game, targetId: SCENARIO_TARGET_ID, muzzle: clone(m), fireTick, fireTime, lockTicks, targetAtFire, targetStart };
}
