// ゲーム全体の状態管理と固定ステップシミュレーション（DOM非依存）。
import {
  CAMERA,
  DEFAULT_LOADOUT,
  DEFAULT_SEED,
  DEFAULT_WEAPON,
  GUARD_AI,
  NAV,
  PLAYER,
  SIM_DT,
  VERSION,
  WEAPON_ORDER,
  computeEffectiveStats,
  type EffectiveStats,
  type Loadout,
  type WeaponId,
} from '../config';
import { clamp, finite, type V3 } from '../math';
import { Rng } from '../rng';
import { buildStage, sectorAt, type StageData } from '../stage/build';
import { BARRIERS, ENEMIES, ESCAPE_ZONE, PORTALS, SECTORS, START } from '../stage/layout';
import type { AABB, EnemyDef } from '../stage/types';
import { computeCamera, cameraBasis, type CameraState } from './camera';
import { EnemyManager, type SimEvent } from './enemies';
import { NavGraph } from './nav';
import { Player, type MoveInput } from './player';
import { Fcs, PlayerWeapons, playerMuzzle, raySphere } from './weapons';
import { CollisionWorld, type WBox } from './world';

export type GameState = 'garage' | 'playing' | 'paused' | 'cleared' | 'failed';

export interface StepInput extends MoveInput {
  fireHeld: boolean;
  weaponSelect: WeaponId | null;
}

export const EMPTY_INPUT: StepInput = {
  moveX: 0,
  moveZ: 0,
  yaw: 0,
  spaceHeld: false,
  spaceEdge: false,
  qEdge: false,
  shiftEdge: false,
  ctrlHeld: false,
  fireHeld: false,
  weaponSelect: null,
};

export interface BarrierRuntime {
  id: string;
  label: string;
  controlId: string | null;
  closedBox: AABB;
  thinAxis: 0 | 1 | 2;
  openAxis: 'up' | 'side';
  wbox: WBox;
  open: boolean;
  progress: number;
}

export interface Snapshot {
  version: typeof VERSION;
  seed: number;
  state: GameState;
  elapsedSeconds: number;
  loadout: Loadout;
  player: {
    position: [number, number, number];
    velocity: [number, number, number];
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
  enemies: Array<{
    id: string;
    kind: 'guard' | 'turret';
    isGateControl: boolean;
    sectorId: string;
    position: [number, number, number];
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

export interface GameOptions {
  seed?: number;
  enemies?: EnemyDef[];
  /** 検証用：隔壁を無効にする（ヘッドレステスト専用。ブラウザ実行では使用しない） */
  stageOverride?: { stage: StageData; start: V3; startYaw: number };
}

export class Game {
  state: GameState = 'garage';
  seed: number;
  rng: Rng;
  loadout: Loadout = { ...DEFAULT_LOADOUT };
  stats: EffectiveStats = computeEffectiveStats(DEFAULT_LOADOUT);
  startWeapon: WeaponId = DEFAULT_WEAPON;
  steps = 0;
  player: Player;
  yaw = START.yaw;
  pitch = -0.08;
  cam: CameraState;
  viewport = { w: 1280, h: 720 };
  stage: StageData;
  world: CollisionWorld;
  nav: NavGraph;
  enemies: EnemyManager;
  weapons = new PlayerWeapons();
  fcs = new Fcs();
  barriers: BarrierRuntime[] = [];
  gateOpen = false;
  controlsDestroyed = 0;
  currentSectorId: string | null = null;
  visited: string[] = [];
  events: SimEvent[] = [];
  aimPoint: V3 = [0, 0, 0];
  failReason: 'hp' | 'fall' | null = null;
  kills = 0;
  private startPos: V3;
  private startYaw: number;
  private enemyDefs: EnemyDef[];

  constructor(opts: GameOptions = {}) {
    this.seed = (opts.seed ?? DEFAULT_SEED) >>> 0;
    this.rng = new Rng(this.seed);
    this.stage = opts.stageOverride?.stage ?? buildStage();
    this.startPos = opts.stageOverride?.start ?? START.pos;
    this.startYaw = opts.stageOverride?.startYaw ?? START.yaw;
    this.enemyDefs = opts.enemies ?? ENEMIES;

    const boxes: WBox[] = this.stage.boxes.map((b) => ({ min: [...b.min] as V3, max: [...b.max] as V3, active: true, tag: null }));
    for (const b of this.stage.barriers) {
      const wb: WBox = { min: [...b.box.min] as V3, max: [...b.box.max] as V3, active: false, tag: b.def.id };
      boxes.push(wb);
      this.barriers.push({
        id: b.def.id,
        label: b.def.label,
        controlId: b.def.controlId,
        closedBox: b.box,
        thinAxis: b.thinAxis,
        openAxis: b.def.openAxis,
        wbox: wb,
        open: false,
        progress: 0,
      });
    }
    this.world = new CollisionWorld(boxes, 8);
    // ナビグラフは隔壁を開いた状態で構築し、隔壁位置のノードに印を付ける
    this.nav = new NavGraph(NAV.spacing);
    const portalBoxes = opts.stageOverride ? [] : PORTALS.map((p) => p.box);
    this.nav.build(
      this.world,
      this.stage.bounds,
      this.stage.sectors,
      portalBoxes,
      this.barriers.map((b) => ({ id: b.id, box: b.closedBox })),
      GUARD_AI.halfWidth,
      GUARD_AI.height,
      NAV.maxStep,
    );
    for (const b of this.barriers) b.wbox.active = true;

    this.player = new Player(this.stats);
    this.player.reset(this.startPos, this.stats);
    this.enemies = new EnemyManager(this.enemyDefs, this.world, this.nav, this.rng);
    this.cam = computeCamera(this.startPos, this.yaw, this.pitch, this.world);
  }

  get elapsedSeconds() {
    return this.steps * SIM_DT;
  }

  closedBarriers(): Set<string> {
    const s = new Set<string>();
    for (const b of this.barriers) if (!b.open || b.progress < 1) s.add(b.id);
    return s;
  }

  /** 出撃・再出撃：選択構成以外を全て初期化 */
  sortie(loadout: Loadout, weapon: WeaponId = DEFAULT_WEAPON) {
    this.loadout = { ...loadout };
    this.stats = computeEffectiveStats(loadout);
    this.startWeapon = weapon;
    this.rng.reset(this.seed);
    this.steps = 0;
    this.player.reset(this.startPos, this.stats);
    this.yaw = this.startYaw;
    this.pitch = -0.08;
    this.weapons.reset(weapon);
    this.fcs.reset(this.stats);
    for (const b of this.barriers) {
      b.open = false;
      b.progress = 0;
      b.wbox.min = [...b.closedBox.min] as V3;
      b.wbox.max = [...b.closedBox.max] as V3;
      b.wbox.active = true;
    }
    this.gateOpen = false;
    this.controlsDestroyed = 0;
    this.enemies.reset();
    this.enemies.events = [];
    this.events = [];
    this.failReason = null;
    this.kills = 0;
    this.currentSectorId = null;
    this.visited = [];
    this.updateSector();
    this.cam = computeCamera(this.player.pos, this.yaw, this.pitch, this.world);
    this.computeAim();
    this.state = 'playing';
  }

  toGarage() {
    this.state = 'garage';
  }

  /** 格納庫での構成選択（出撃後は変更不可） */
  setLoadout(l: Loadout) {
    if (this.state !== 'garage') return;
    this.loadout = { ...l };
    this.stats = computeEffectiveStats(l);
  }

  setLook(yaw: number, pitch: number) {
    this.yaw = yaw;
    this.pitch = clamp(pitch, CAMERA.minPitch, CAMERA.maxPitch);
  }

  /** 1固定ステップ（SIM_DT秒）を進める */
  step(input: StepInput) {
    if (this.state !== 'playing') return;
    const dt = SIM_DT;
    const now = this.steps * dt;
    const p = this.player;
    const inp: StepInput = { ...input, yaw: this.yaw };

    if (inp.weaponSelect && WEAPON_ORDER.includes(inp.weaponSelect)) this.weapons.current = inp.weaponSelect;

    // EN支出の優先順位：QB開始費用 → ビーム発射費用 → 飛行の連続消費
    const qbBefore = p.qbCount;
    p.beginStep(now, inp);
    if (p.qbCount !== qbBefore) this.events.push({ type: 'qb', dir: [p.qbDir[0], p.qbDir[1]] });
    if (inp.fireHeld) {
      this.weapons.fire(now, p, this.yaw, this.aimPoint, this.fcs, this.enemies, this.world, this.events);
    }
    p.computeFlight(now, dt, inp);
    p.move(now, dt, inp, this.world);

    this.cam = computeCamera(p.pos, this.yaw, this.pitch, this.world);
    this.fcs.update(dt, this.cam, playerMuzzle(p, this.yaw), this.viewport.w, this.viewport.h, this.stats, this.enemies, this.world);
    this.weapons.updateProjectiles(dt, this.enemies, this.world, this.events);
    this.enemies.update(now, dt, p, this.closedBarriers());
    this.processEnemyEvents();
    this.updateBarriers(dt);
    this.updateSector();
    this.computeAim();

    this.steps++;
    // 失敗判定を優先（同一更新でクリア条件とHP0以下が成立した場合は失敗）
    if (p.hp <= 0) {
      this.failReason = 'hp';
      this.state = 'failed';
    } else if (p.pos[1] < PLAYER.fallFailY) {
      this.failReason = 'fall';
      this.state = 'failed';
    } else if (this.gateOpen && this.inEscapeZone()) {
      this.state = 'cleared';
    }
  }

  private inEscapeZone(): boolean {
    const c = this.player.center();
    const z = ESCAPE_ZONE;
    return c[0] >= z.min[0] && c[0] <= z.max[0] && c[1] >= z.min[1] && c[1] <= z.max[1] && c[2] >= z.min[2] && c[2] <= z.max[2];
  }

  private processEnemyEvents() {
    const ev = this.enemies.events;
    for (const e of ev) {
      this.events.push(e);
      if (e.type === 'enemyKilled') {
        this.kills++;
        if (this.fcs.targetId === e.id) {
          this.fcs.targetId = null;
          this.fcs.lockTime = 0;
        }
        if (e.control) {
          const b = this.barriers.find((x) => x.controlId === e.id);
          if (b && !b.open) {
            b.open = true;
            this.controlsDestroyed++;
            this.events.push({ type: 'barrierOpened', id: b.id });
          }
          if (this.controlsDestroyed >= 6 && !this.gateOpen) {
            this.gateOpen = true;
            const g = this.barriers.find((x) => x.id === 'GATE');
            if (g) g.open = true;
            this.events.push({ type: 'gateOpened' });
          }
        }
      }
    }
    this.enemies.events = [];
  }

  private updateBarriers(dt: number) {
    for (const b of this.barriers) {
      if (!b.open || b.progress >= 1) continue;
      b.progress = Math.min(1, b.progress + dt / 1.2);
      const cb = b.closedBox;
      if (b.openAxis === 'up') {
        const h = cb.max[1] - cb.min[1];
        b.wbox.min = [cb.min[0], cb.min[1] + h * b.progress, cb.min[2]];
      } else {
        const w = cb.max[0] - cb.min[0];
        b.wbox.min = [cb.min[0] + w * b.progress, cb.min[1], cb.min[2]];
      }
      if (b.progress >= 1) b.wbox.active = false;
    }
  }

  private updateSector() {
    const s = sectorAt(this.player.pos);
    if (s) {
      this.currentSectorId = s.id;
      if (!this.visited.includes(s.id)) this.visited.push(s.id);
    }
  }

  /** カメラ中央の照準点（カメラから前方へ。機体より手前は無視） */
  computeAim() {
    const cam = this.cam;
    const f = cam.forward;
    const pv = cam.pivot;
    const t0 = Math.max(0, (pv[0] - cam.pos[0]) * f[0] + (pv[1] - cam.pos[1]) * f[1] + (pv[2] - cam.pos[2]) * f[2]);
    const o: V3 = [cam.pos[0] + f[0] * t0, cam.pos[1] + f[1] * t0, cam.pos[2] + f[2] * t0];
    const maxT = 500;
    const wh = this.world.raycast(o, f, maxT);
    let best = wh ? wh.t : maxT;
    for (const e of this.enemies.enemies) {
      if (!e.alive) continue;
      const t = raySphere(o, f, e.center(), e.spec.hitRadius, best);
      if (t !== null && t < best) best = t;
    }
    this.aimPoint = [o[0] + f[0] * best, o[1] + f[1] * best, o[2] + f[2] * best];
  }

  cameraBasis() {
    return cameraBasis(this.yaw, this.pitch);
  }

  lockRadiusPx() {
    return this.stats.lockRadiusFactor * Math.min(this.viewport.w, this.viewport.h);
  }

  getSnapshot(): Snapshot {
    const p = this.player;
    const now = this.elapsedSeconds;
    const v3 = (a: V3): [number, number, number] => [finite(a[0]), finite(a[1]), finite(a[2])];
    const openIds = this.barriers.filter((b) => b.open && b.id !== 'GATE').map((b) => b.id);
    const dd = p.desiredDirection;
    return {
      version: VERSION,
      seed: this.seed,
      state: this.state,
      elapsedSeconds: finite(now),
      loadout: { ...this.loadout },
      player: {
        position: v3(p.pos),
        velocity: v3(p.vel),
        grounded: p.grounded,
        hp: finite(p.hp),
        en: finite(p.en),
        weapon: this.weapons.current,
        ammo: { machinegun: this.weapons.ammo.machinegun, missile: this.weapons.ammo.missile },
        movement: {
          horizontalMode: p.horizontalMode,
          verticalMode: p.verticalMode,
          glideEnabled: p.glideEnabled,
          desiredHorizontalDirection: [finite(dd[0]), finite(dd[1])],
          qbSuccessfulCount: p.qbCount,
          qbLastStartedAtSeconds: p.qbLastStartedAt === null ? null : finite(p.qbLastStartedAt),
          qbImpulseRemainingSeconds: finite(p.qbImpulseRemaining),
          qbCooldownRemainingSeconds: finite(p.qbCooldownRemaining(now)),
          lastEnSpentAtSeconds: p.lastEnSpentAt === null ? null : finite(p.lastEnSpentAt),
        },
      },
      effectiveStats: {
        maxEn: this.stats.maxEn,
        regenPerSecond: this.stats.regenPerSecond,
        lockSeconds: this.stats.lockSeconds,
        horizontalSpeedMultiplier: this.stats.horizontalSpeedMultiplier,
      },
      lock: {
        state: this.fcs.state,
        targetId: this.fcs.targetId,
        progress: finite(this.fcs.progress),
        radiusCssPx: finite(this.lockRadiusPx()),
      },
      enemies: this.enemies.enemies.map((e) => ({
        id: e.id,
        kind: e.kind,
        isGateControl: e.def.isGateControl,
        sectorId: e.def.sectorId,
        position: v3(e.pos),
        hp: finite(e.hp),
        alive: e.alive,
        alert: e.alert,
        hasLineOfSight: e.hasLOS,
        shotsFired: e.shotsFired,
        lastShotAtSeconds: e.lastShotAt === null ? null : finite(e.lastShotAt),
      })),
      objective: {
        controlsDestroyed: this.controlsDestroyed,
        controlsRequired: 6,
        openBarrierIds: openIds,
        gateOpen: this.gateOpen,
      },
      stage: {
        sectorCount: SECTORS.length,
        currentSectorId: this.currentSectorId,
        visitedSectorIds: [...this.visited],
        totalEnemies: 45,
      },
    };
  }
}

export { BARRIERS };
