/**
 * Sim — the authoritative, headless, deterministic game simulation.
 *
 * Time stepping (docs/ARCHITECTURE.md §3):
 *   advance(dt) runs whole 1/120 s ticks. Inside a tick the time interval is cut into sub-steps so that
 *   every discrete event (player shot, enemy shot/telegraph, QB impulse end, flight threshold, EN regen
 *   start …) falls exactly on a sub-step boundary. Within one sub-step [t0, t1]:
 *
 *     1. input edges are applied at t0 (weapon switch, QB, glide toggle, jump)
 *     2. the player moves t0 → t1 (EN order: QB cost → beam reservation → flight)
 *     3. enemies move t0 → t1
 *     4. existing projectiles advance t0 → t1 with swept tests against the world, the moving enemies
 *        and the moving player
 *     5. time := t1
 *     6. camera and FCS lock are updated for t1
 *     7. enemy perception + enemy shots scheduled at <= t1 (bullets spawned at t1, not advanced yet)
 *     8. the player's shot at t1 (lock re-validated, solution computed from the t1 state)
 *     9. the fire-control solution shown by the HUD / used by the gun model is refreshed
 *    10. sector tracking and outcome (failure has priority over clear)
 *
 * Pausing is done by simply not calling advance(); every timer lives in simulation time.
 */
import {
  CAMERA,
  CONTROLS_REQUIRED,
  DEFAULT_LOADOUT,
  DEFAULT_SEED,
  MAX_FRAME_DT,
  TICK,
  TIME_EPS,
  computeEffectiveStats,
  type EffectiveStats,
} from '../config';
import { Rng } from '../core/rng';
import { clone, set, v3, type V3 } from '../core/vec';
import { updateCamera, createCameraState } from './camera';
import { createEnemies, enemiesNextEventTime, moveEnemies, onEnemyDamaged, updateEnemies } from './enemies';
import { createAimState, createLockState, inactiveSolution, refreshFireControl, updateLock } from './fcs';
import { createGuideState, updateGuide, type GuideState } from './guide';
import { NavGrid } from './nav';
import { applyPlayerInputEdges, createPlayer, playerNextEventTime, updatePlayer } from './player';
import { advanceProjectiles } from './projectiles';
import type {
  AimState,
  CameraState,
  EnemyState,
  FailReason,
  FireSolution,
  InputState,
  Loadout,
  LockState,
  ObjectiveState,
  ObjectiveTarget,
  PlayerState,
  Projectile,
  ShotRecord,
  SimEvent,
  SimStatus,
  StageDef,
  Viewport,
} from './types';
import { applyWeaponSwitch, beamEnReserve, processPlayerFire, weaponsNextEventTime } from './weapons';
import { World } from './world';

export interface SimOptions {
  loadout?: Loadout;
  seed?: number;
  viewport?: Viewport;
}

export function createInputState(): InputState {
  return {
    moveX: 0,
    moveZ: 0,
    jump: false,
    brake: false,
    fire: false,
    qbPressed: false,
    glideTogglePressed: false,
    jumpPressed: false,
    weaponSelect: null,
  };
}

export class Sim {
  readonly stage: StageDef;
  readonly world: World;
  readonly nav: NavGrid;

  loadout: Loadout = { ...DEFAULT_LOADOUT };
  stats: EffectiveStats = computeEffectiveStats(DEFAULT_LOADOUT);
  seed: number = DEFAULT_SEED;
  /** Gameplay random stream (re-seeded on every reset). */
  rng: Rng = new Rng(DEFAULT_SEED);

  /** Simulation time in seconds since the sortie began. */
  time = 0;
  tickIndex = 0;
  /** Real time accumulated but not yet simulated (< TICK). Renderers may extrapolate by this amount. */
  accumulator = 0;
  status: SimStatus = 'playing';
  failReason: FailReason = null;

  viewport: Viewport = { width: 1280, height: 720 };
  input: InputState = createInputState();
  player!: PlayerState;
  camera!: CameraState;
  enemies: EnemyState[] = [];
  enemyById: Map<string, EnemyState> = new Map();
  projectiles: Projectile[] = [];
  nextProjectileId = 1;
  lock!: LockState;
  fireControl!: FireSolution;
  aim!: AimState;
  /** Recent successful player shots, oldest first (max RECENT_SHOTS_MAX). */
  shots: ShotRecord[] = [];
  nextShotId = 1;
  objective!: ObjectiveState;
  currentSectorId: string | null = null;
  visitedSectorIds: string[] = [];
  /** Events produced since the last drainEvents() call. */
  events: SimEvent[] = [];
  /** Number of control turrets in this stage (6 in the shipped stage). */
  controlsRequired: number = CONTROLS_REQUIRED;
  /**
   * Route guidance for the HUD (src/sim/guide.ts). Derived state only: nothing in the simulation reads it,
   * it never uses `rng` and never emits events.
   */
  guide!: GuideState;

  constructor(stage: StageDef, opts: SimOptions = {}) {
    this.stage = stage;
    this.world = new World(stage);
    this.nav = new NavGrid(this.world, stage);
    if (opts.viewport) {
      // Same rule as setViewport(): only finite sizes are accepted (the state never holds NaN / Infinity).
      const { width, height } = opts.viewport;
      if (Number.isFinite(width)) this.viewport.width = Math.max(1, width);
      if (Number.isFinite(height)) this.viewport.height = Math.max(1, height);
    }
    this.reset(opts.loadout ?? DEFAULT_LOADOUT, opts.seed ?? DEFAULT_SEED);
  }

  /** Full re-initialisation for a (re-)sortie. Only the chosen loadout and seed are taken from outside. */
  reset(loadout: Loadout = this.loadout, seed: number = this.seed): void {
    this.loadout = { fcs: loadout.fcs, generator: loadout.generator, legs: loadout.legs };
    this.stats = computeEffectiveStats(this.loadout);
    this.seed = seed >>> 0;
    this.rng = new Rng(this.seed);
    this.time = 0;
    this.tickIndex = 0;
    this.accumulator = 0;
    this.status = 'playing';
    this.failReason = null;
    this.world.resetBarriers();
    this.nav.reset();
    this.input = createInputState();
    this.events = [];
    this.projectiles = [];
    this.nextProjectileId = 1;
    this.shots = [];
    this.nextShotId = 1;
    this.controlsRequired = this.stage.enemies.filter((e) => e.isGateControl).length;
    this.objective = {
      controlsDestroyed: 0,
      controlsRequired: this.controlsRequired,
      openBarrierIds: [],
      gateOpen: false,
    };
    this.player = createPlayer(this);
    this.enemies = createEnemies(this);
    this.enemyById = new Map(this.enemies.map((e) => [e.id, e]));
    this.camera = createCameraState();
    this.lock = createLockState(this);
    this.fireControl = inactiveSolution(this.player.weapon);
    this.aim = createAimState();
    this.currentSectorId = null;
    this.visitedSectorIds = [];
    updateCamera(this);
    // The lock is judged at t = 0 as well (no time has passed: progress 0), so a target that satisfies the
    // conditions from the first instant is locked exactly `lockSeconds` after the sortie began.
    updateLock(this, 0);
    refreshFireControl(this);
    this.updateSector();
    this.guide = createGuideState(this);
    this.events.length = 0;
  }

  /** Display area size in CSS pixels (drives the camera aspect and the FCS lock circle). */
  setViewport(width: number, height: number): void {
    // A non-finite size (e.g. a layout that has not been measured yet) is ignored for that axis: the last
    // valid size stays in force, so neither the viewport nor the camera aspect can ever become NaN / Infinity.
    this.viewport = {
      width: Number.isFinite(width) ? Math.max(1, width) : this.viewport.width,
      height: Number.isFinite(height) ? Math.max(1, height) : this.viewport.height,
    };
    this.lock.radiusCssPx = this.stats.lockRadiusFactor * Math.min(this.viewport.width, this.viewport.height);
    updateCamera(this);
    // The judged circle is the displayed circle at every instant, also between two ticks and while the app is
    // paused: the lock is re-judged against the new circle now, with no time passing (a target outside it is
    // dropped at once, nothing advances), and the fire-control value follows. A finished sortie stays frozen.
    if (this.status === 'playing') {
      updateLock(this, 0);
      refreshFireControl(this);
    }
  }

  /** Mouse look. Positive dYaw turns left, positive dPitch looks up. Ignored unless playing. */
  applyLook(dYaw: number, dPitch: number): void {
    if (this.status !== 'playing') return;
    const p = this.player;
    if (!Number.isFinite(dYaw) || !Number.isFinite(dPitch)) return;
    p.yaw += dYaw;
    if (p.yaw > Math.PI) p.yaw -= 2 * Math.PI * Math.ceil((p.yaw - Math.PI) / (2 * Math.PI));
    if (p.yaw < -Math.PI) p.yaw += 2 * Math.PI * Math.ceil((-Math.PI - p.yaw) / (2 * Math.PI));
    p.pitch = Math.min(CAMERA.pitchMax, Math.max(CAMERA.pitchMin, p.pitch + dPitch));
  }

  /** Releases every held key/button and discards pending edges (pause, focus loss, results). */
  clearInput(): void {
    this.input = createInputState();
    // A held Space no longer counts towards the flight threshold after the input was dropped.
    this.player.jumpHeldSince = null;
  }

  /**
   * Feeds `dt` seconds of real time. Runs as many whole ticks as fit; the remainder stays in
   * `accumulator`. Returns the number of ticks executed.
   */
  advance(dt: number): number {
    if (this.status !== 'playing') return 0;
    if (!(dt > 0)) return 0;
    this.accumulator += Math.min(dt, MAX_FRAME_DT);
    let ticks = 0;
    while (this.accumulator >= TICK - 1e-12 && this.status === 'playing') {
      this.tick();
      this.accumulator -= TICK;
      ticks++;
    }
    if (this.accumulator < 0 || this.status !== 'playing') this.accumulator = 0;
    return ticks;
  }

  /**
   * Test / tool helper: simulates `seconds` of game time as whole ticks, ignoring the per-frame cap of
   * advance(). Stops early when the sortie ends. Returns the number of ticks executed.
   */
  runFor(seconds: number): number {
    const n = Math.round(seconds / TICK);
    let ticks = 0;
    for (let i = 0; i < n && this.status === 'playing'; i++) {
      this.tick();
      ticks++;
    }
    return ticks;
  }

  /** Runs exactly one 1/120 s tick (split into event-aligned sub-steps). */
  tick(): void {
    if (this.status !== 'playing') return;
    const tickEnd = (this.tickIndex + 1) * TICK;
    let guard = 0;
    while (this.status === 'playing' && this.time < tickEnd - TIME_EPS) {
      let t1 = Math.min(tickEnd, this.nextEventTime());
      // Modules must only report strictly future event times; never stall on a stale one.
      if (!(t1 > this.time + TIME_EPS)) t1 = tickEnd;
      if (++guard > 256) t1 = tickEnd;
      this.substep(t1);
    }
    this.tickIndex++;
    if (this.status === 'playing') this.time = tickEnd;
    // bookkeeping that no gameplay code depends on: route guidance for the HUD (once per tick)
    updateGuide(this);
  }

  /** Earliest future discrete event; sub-steps are cut there. */
  nextEventTime(): number {
    return Math.min(playerNextEventTime(this), weaponsNextEventTime(this), enemiesNextEventTime(this));
  }

  private substep(t1: number): void {
    const t0 = this.time;
    const h = t1 - t0;
    // 1. edges at t0
    applyWeaponSwitch(this);
    applyPlayerInputEdges(this);
    // 2. player motion. EN priority inside one update: QB (paid above) → beam (reserved) → flight.
    const reserve = beamEnReserve(this, t1);
    updatePlayer(this, h, reserve);
    // 3. enemy motion
    moveEnemies(this, h);
    // 4. projectiles over [t0, t1]
    advanceProjectiles(this, t0, t1);
    // 5. commit time
    this.time = t1;
    // 6. camera + lock at t1
    updateCamera(this);
    updateLock(this, h);
    // 7. enemy perception and shots due at t1
    updateEnemies(this, h);
    // 8. player's shot at t1
    processPlayerFire(this);
    // 9. HUD / gun fire-control solution
    refreshFireControl(this);
    // 10. bookkeeping
    this.updateSector();
    this.checkOutcome();
  }

  emit(e: SimEvent): void {
    // Hard cap so a consumer that never drains (headless tests) cannot grow memory without bound.
    if (this.events.length > 4096) this.events.splice(0, 2048);
    this.events.push(e);
  }

  /** Returns and clears the pending events. */
  drainEvents(): SimEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  /** Applies damage to an enemy (no armour, no scaling). Handles death and objective progress. */
  damageEnemy(enemy: EnemyState, amount: number, hitPos?: V3): void {
    if (!enemy.alive || !(amount > 0)) return;
    enemy.hp = Math.max(0, enemy.hp - amount);
    this.emit({ type: 'enemy-damaged', enemyId: enemy.id, amount, pos: clone(hitPos ?? enemy.pos) });
    if (enemy.hp > 0) {
      onEnemyDamaged(this, enemy);
      return;
    }
    enemy.alive = false;
    enemy.destroyedAt = this.time;
    set(enemy.vel, 0, 0, 0);
    enemy.hasLos = false;
    enemy.alert = false;
    enemy.burstStartAt = null;
    enemy.telegraphStartAt = null;
    this.emit({
      type: 'enemy-destroyed',
      enemyId: enemy.id,
      kind: enemy.kind,
      pos: clone(enemy.pos),
      isGateControl: enemy.isGateControl,
    });
    if (enemy.isGateControl) this.onControlDestroyed(enemy);
  }

  private onControlDestroyed(enemy: EnemyState): void {
    const o = this.objective;
    o.controlsDestroyed++;
    for (const b of this.stage.barriers) {
      if (b.controlEnemyId !== enemy.id || o.openBarrierIds.includes(b.id)) continue;
      this.world.setBarrierOpen(b.id, true);
      this.nav.setBarrierOpen(b.id, true);
      o.openBarrierIds.push(b.id);
      this.emit({ type: 'barrier-opened', barrierId: b.id, controlEnemyId: enemy.id });
    }
    if (!o.gateOpen && o.controlsRequired > 0 && o.controlsDestroyed >= o.controlsRequired) {
      o.gateOpen = true;
      this.world.setBarrierOpen(this.stage.finalGate.id, true);
      this.nav.setBarrierOpen(this.stage.finalGate.id, true);
      this.emit({ type: 'gate-opened' });
    }
  }

  /** Applies damage to the player. Only projectiles that really reached the hit box call this. */
  damagePlayer(amount: number, sourcePos: V3, fromEnemyId: string | null): void {
    if (this.status !== 'playing' || !(amount > 0)) return;
    this.player.hp = Math.max(0, this.player.hp - amount);
    this.emit({ type: 'player-damaged', amount, sourcePos: clone(sourcePos), fromEnemyId });
  }

  /** What the HUD should guide the player towards. */
  getObjectiveTarget(): ObjectiveTarget {
    for (const b of this.stage.barriers) {
      const e = this.enemyById.get(b.controlEnemyId);
      if (e && e.alive) {
        const sector = this.stage.sectors.find((s) => s.id === e.sectorId);
        return {
          kind: 'control',
          id: e.id,
          position: clone(e.pos),
          label: `制御砲台 ${e.id} を破壊せよ（${sector ? sector.name : e.sectorId}）→ 隔壁 ${b.id} 開放`,
        };
      }
    }
    for (const e of this.enemies) {
      if (e.isGateControl && e.alive) {
        return { kind: 'control', id: e.id, position: clone(e.pos), label: `制御砲台 ${e.id} を破壊せよ` };
      }
    }
    const z = this.stage.exitZone;
    return {
      kind: 'exit',
      id: null,
      position: v3((z.min.x + z.max.x) / 2, (z.min.y + z.max.y) / 2, (z.min.z + z.max.z) / 2),
      label: '最終搬出ゲート開放 — 脱出領域へ向かえ',
    };
  }

  private updateSector(): void {
    const id = this.world.sectorAt(this.player.pos);
    if (id === this.currentSectorId) return;
    this.currentSectorId = id;
    if (id != null) {
      if (!this.visitedSectorIds.includes(id)) this.visitedSectorIds.push(id);
      this.emit({ type: 'sector-entered', sectorId: id });
    }
  }

  private checkOutcome(): void {
    if (this.status !== 'playing') return;
    const p = this.player;
    // Failure has priority over clearing when both happen in the same update.
    if (p.hp <= 0) {
      this.status = 'failed';
      this.failReason = 'destroyed';
      this.emit({ type: 'failed', reason: 'destroyed' });
      return;
    }
    if (p.pos.y < this.stage.killY) {
      this.status = 'failed';
      this.failReason = 'fell';
      this.emit({ type: 'failed', reason: 'fell' });
      return;
    }
    const z = this.stage.exitZone;
    if (
      this.objective.gateOpen &&
      p.pos.x >= z.min.x &&
      p.pos.x <= z.max.x &&
      p.pos.y >= z.min.y &&
      p.pos.y <= z.max.y &&
      p.pos.z >= z.min.z &&
      p.pos.z <= z.max.z
    ) {
      this.status = 'cleared';
      this.emit({ type: 'cleared' });
    }
  }
}
