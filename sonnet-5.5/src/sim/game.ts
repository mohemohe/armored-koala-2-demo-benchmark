/**
 * Game orchestrator: owns the fixed-step tick order (see docs/ARCH.md "Tick order").
 * Headless: no DOM / Three.js. The app layer feeds `input`, calls look()/advance() and renders `state`.
 */
import { CAMERA, DEFAULT_LOADOUT, DEFAULT_SEED, SIM } from '../config';
import { clamp, clone } from './math';
import { makeInitialCamera, updateCamera } from './camera';
import { enemyDecisionStep, enemyIntegrate, createEnemies, stepEnemyBullets, warmNavigation } from './enemies';
import { refreshFireSolution, updateFcs } from './fcs';
import { initProgress, updateProgress } from './objective';
import { createPlayerState, playerBeginTick, playerIntegrate } from './player';
import { stepPlayerProjectiles } from './projectiles';
import { Rng } from './rng';
import { computeEffectiveStats, lockRadiusCssPx } from './stats';
import { emptyInput, inactiveFireControl } from './types';
import type { GameEvent, GameMode, GameState, InputState, Loadout, StageDef } from './types';
import { playerFireStep, requestWeaponSwitch } from './weapons';
import { World } from './world';

export interface GameOptions {
  stage: StageDef;
  seed?: number;
  loadout?: Loadout;
  viewportW?: number;
  viewportH?: number;
}

export class Game {
  readonly stage: StageDef;
  readonly world: World;
  /** raw input levels written by the app (stable object; also referenced by state.input) */
  readonly input: InputState = emptyInput();
  state: GameState;
  private accumulator = 0;
  private viewportW: number;
  private viewportH: number;
  private loadout: Loadout;
  private seed: number;

  constructor(opts: GameOptions) {
    this.stage = opts.stage;
    this.world = new World(opts.stage.boxes);
    this.viewportW = opts.viewportW ?? 1280;
    this.viewportH = opts.viewportH ?? 720;
    this.loadout = { ...(opts.loadout ?? DEFAULT_LOADOUT) };
    this.seed = opts.seed ?? DEFAULT_SEED;
    this.state = this.freshState('garage');
  }

  private freshState(mode: GameMode): GameState {
    const stage = this.stage;
    for (let i = 0; i < this.world.boxes.length; i++) this.world.setBoxEnabled(i, true);
    Object.assign(this.input, emptyInput());
    const stats = computeEffectiveStats(this.loadout);
    const state: GameState = {
      mode,
      seed: this.seed,
      time: 0,
      tick: 0,
      loadout: { ...this.loadout },
      stats,
      input: this.input,
      player: createPlayerState(this.loadout, stats, stage.playerStart),
      camera: makeInitialCamera(this.viewportW, this.viewportH),
      lock: { state: 'none', targetId: null, progress: 0, elapsed: 0, radiusCssPx: lockRadiusCssPx(this.loadout, this.viewportW, this.viewportH) },
      fc: inactiveFireControl('machinegun'),
      shots: [],
      shotSeq: 0,
      enemies: createEnemies(stage),
      bullets: [],
      missiles: [],
      enemyBullets: [],
      events: [],
      damageIndicators: [],
      objective: { controlsDestroyed: 0, openBarrierIds: [], gateOpen: false },
      progress: { currentSectorId: null, visitedSectorIds: [] },
      notices: { noLockAt: null, noEnAt: null, noAmmoAt: null, noSolutionAt: null },
      endReason: null,
      killCount: 0,
      damageTaken: 0,
      nextProjectileId: 1,
      rng: new Rng(this.seed),
      world: this.world,
      stage,
    };
    updateCamera(state, this.world);
    initProgress(state);
    this.accumulator = 0;
    return state;
  }

  // ------------------------------------------------------------------ lifecycle
  /**
   * Prepare the guards' navigation grid ahead of the sortie (the lazy way spends it as a hitch on the first ticks). Optional: the game
   * behaves identically, tick for tick, with or without it. Idempotent. `maxWork` (about the number of nav nodes) bounds one call so
   * the app can spread the work over idle time; returns true once everything is done.
   */
  warmup(maxWork = Infinity): boolean {
    return warmNavigation(this.world, this.stage, maxWork);
  }

  /** Garage -> playing with a fresh state (also used for retry). Everything except the loadout is reinitialized. */
  sortie(loadout?: Loadout, seed?: number): void {
    if (loadout) this.loadout = { ...loadout };
    if (seed !== undefined) this.seed = seed >>> 0;
    this.state = this.freshState('playing');
  }
  /** Same loadout & seed, fresh state. */
  retry(): void {
    this.sortie();
  }
  toGarage(loadout?: Loadout): void {
    if (loadout) this.loadout = { ...loadout };
    this.state = this.freshState('garage');
  }
  setLoadout(loadout: Loadout): void {
    this.toGarage(loadout);
  }
  getLoadout(): Loadout {
    return { ...this.loadout };
  }
  pause(): void {
    if (this.state.mode !== 'playing') return;
    this.state.mode = 'paused';
    Object.assign(this.input, emptyInput());
    this.accumulator = 0;
  }
  resume(): void {
    if (this.state.mode !== 'paused') return;
    Object.assign(this.input, emptyInput());
    this.state.player.mv.prevInput = { qb: false, shift: false, jump: false };
    this.accumulator = 0;
    this.state.mode = 'playing';
  }
  setViewport(w: number, h: number): void {
    this.viewportW = w;
    this.viewportH = h;
    const s = this.state;
    s.camera.viewportW = w;
    s.camera.viewportH = h;
    s.lock.radiusCssPx = lockRadiusCssPx(s.loadout, w, h);
  }
  /** Mouse look (CSS pixel deltas). Updates the camera immediately so FCS/muzzle stay consistent. */
  look(dx: number, dy: number): void {
    const s = this.state;
    if (s.mode !== 'playing') return;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return; // never let NaN/Infinity into yaw/pitch
    s.player.yaw -= dx * CAMERA.SENSITIVITY;
    s.player.pitch = clamp(s.player.pitch - dy * CAMERA.SENSITIVITY, CAMERA.PITCH_MIN, CAMERA.PITCH_MAX);
    updateCamera(s, this.world);
    // the yaw-frame muzzle moved: refresh the HUD solution (state.fc) so it is never staler than the real shot
    refreshFireSolution(s, this.world);
  }
  /** Renderer calls this once per frame to receive and clear the event queue. */
  drainEvents(): GameEvent[] {
    const ev = this.state.events;
    this.state.events = [];
    return ev;
  }

  // ------------------------------------------------------------------ stepping
  /** Run as many fixed ticks as `realDtSeconds` (clamped) allows. Returns the number of ticks executed. */
  advance(realDtSeconds: number): number {
    if (this.state.mode !== 'playing') return 0;
    // a non-finite frame time must never poison the accumulator (NaN would freeze the simulation for good)
    const frameDt = Number.isNaN(realDtSeconds) ? 0 : Math.min(Math.max(realDtSeconds, 0), SIM.MAX_FRAME_SECONDS);
    this.accumulator += frameDt;
    let n = 0;
    while (this.accumulator >= SIM.DT - 1e-12 && this.state.mode === 'playing') {
      this.step();
      this.accumulator -= SIM.DT;
      n++;
    }
    return n;
  }

  /** One fixed tick T -> T+dt. Tick order is part of the spec conformance (see docs/ARCH.md). */
  step(): void {
    const s = this.state;
    if (s.mode !== 'playing') return;
    const w = this.world;

    // ---- A: decisions / firing at time T (all states are the values at T)
    requestWeaponSwitch(s);
    playerBeginTick(s); // QB start (EN 36) + edge inputs
    playerFireStep(s, w); // beam EN 8 is paid after QB and before flight
    enemyDecisionStep(s, w); // enemy AI: LOS, memory, bursts, spawn enemy bullets at T

    // ---- B: integrate T -> T+dt
    s.player.prevPos = clone(s.player.pos);
    for (const e of s.enemies) e.prevPos = clone(e.pos);
    playerIntegrate(s, w); // flight EN after QB+beam; movement; regen
    enemyIntegrate(s, w);
    stepPlayerProjectiles(s, w);
    stepEnemyBullets(s, w);

    // ---- C: post-update at T+dt
    s.tick += 1;
    s.time = s.tick * SIM.DT;
    for (const e of s.enemies) if (e.hitFlash > 0) e.hitFlash = Math.max(0, e.hitFlash - SIM.DT);
    updateCamera(s, w);
    updateFcs(s, w, SIM.DT);
    updateProgress(s);
  }
}
