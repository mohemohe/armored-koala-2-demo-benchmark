/**
 * ゲーム統括: 状態遷移、固定刻み＋イベント分割のシミュレーション、目標進行、スナップショット。
 * 描画・入力・DOM には依存しない（Node の vitest で丸ごと実行できる）。
 */
import { CAMERA, DIAG, ENEMIES, OBJECTIVE, PLAYER, SIM, SNAPSHOT_VERSION, WEAPONS, computeEffectiveStats } from '../params';
import type {
  EnemyView,
  FireSolution,
  GameState,
  HittableBox,
  HittableSphere,
  InputFrame,
  Loadout,
  PlayerView,
  ProjectileView,
  ShotRecord,
  SimEvent,
  Snapshot,
  StageData,
  TargetInfo,
  Vec3,
  Weapon,
} from '../types';
import { emptyInput } from '../types';
import { SimCamera } from './camera';
import { EnemyManager, type EnemyContext } from './enemy';
import { Fcs, computeFireSolution, type FcsContext } from './fcs';
import { raySphere } from './geom';
import { NavGrid } from './nav';
import { Player } from './player';
import { Projectiles, type ProjectileContext } from './projectiles';
import { Rng } from './rng';
import { StageRuntime } from './stage';
import { addScaled, copy, distance, normalize, sub } from './vec';
import { Weapons, type FireContext } from './weapons';

export interface GameOptions {
  stage: StageData;
  loadout: Loadout;
  seed: number;
  viewport: { width: number; height: number };
  /** 警備ロボットの経路探索グリッドを生成する（既定 true。射撃試験では false 可） */
  buildNav?: boolean;
}

export class Game {
  readonly stageData: StageData;
  readonly seed: number;
  loadout: Loadout;
  state: GameState = 'garage';
  /** ゲーム内経過時間 [s]（一時停止中は進まない） */
  time = 0;
  readonly rng: Rng;
  readonly stage: StageRuntime;
  nav: NavGrid | null = null;
  readonly camera: SimCamera;
  player: Player;
  fcs: Fcs;
  readonly weapons: Weapons;
  readonly projectiles: Projectiles;
  readonly enemies: EnemyManager;
  fireSolution: FireSolution;
  recentShots: ShotRecord[] = [];
  private shotSeq = 0;
  /** 描画・HUD が drainEvents() で消費する */
  private events: SimEvent[] = [];
  currentSectorId: string | null = null;
  visitedSectorIds: string[] = [];
  controlsDestroyed = 0;
  failReason: 'hp' | 'fall' | null = null;
  /** 自由射撃の照準点（カメラ中央レイ） */
  freeAimPoint: Vec3 = [0, 0, 0];
  /** 腕・武器の実際の射出方向（描画用。射撃解と一致） */
  aimDirection: Vec3 = [0, 0, -1];
  private input: InputFrame = emptyInput();
  private readonly buildNav: boolean;

  constructor(opts: GameOptions) {
    this.stageData = opts.stage;
    this.seed = opts.seed >>> 0;
    this.loadout = { ...opts.loadout };
    this.rng = new Rng(this.seed);
    this.stage = new StageRuntime(opts.stage);
    this.buildNav = opts.buildNav ?? true;
    this.camera = new SimCamera();
    this.camera.setViewport(opts.viewport.width, opts.viewport.height);
    this.player = new Player(this.loadout);
    const stats = computeEffectiveStats(this.loadout);
    this.fcs = new Fcs(this.loadout.fcs, stats.lockSeconds);
    this.weapons = new Weapons();
    this.projectiles = new Projectiles();
    if (this.buildNav) this.nav = NavGrid.build(this.stage.world, { cellSize: 2, agentHalfExtents: ENEMIES.guard.halfExtents, floorLevels: opts.stage.navFloorLevels });
    this.enemies = new EnemyManager(opts.stage.enemies, this.stage.world, this.nav, this.rng, (p) => this.stage.sectorAt(p));
    this.fireSolution = computeFireSolution(this.player.weapon, this.player.getMuzzlePosition(), null, this.time);
    this.resetRun();
  }

  // -------------------------------------------------------------------------
  // 状態遷移
  // -------------------------------------------------------------------------

  /** 格納庫でのみ構成を変更できる */
  setLoadout(loadout: Loadout): boolean {
    if (this.state !== 'garage') return false;
    this.loadout = { ...loadout };
    this.player = new Player(this.loadout);
    const stats = computeEffectiveStats(this.loadout);
    this.fcs = new Fcs(this.loadout.fcs, stats.lockSeconds);
    this.resetRun();
    return true;
  }

  /** 出撃（格納庫・クリア・失敗から）。全状態を初期化して playing へ */
  launch(): boolean {
    if (this.state === 'playing' || this.state === 'paused') return false;
    this.resetRun();
    this.state = 'playing';
    return true;
  }

  pause(): boolean {
    if (this.state !== 'playing') return false;
    this.state = 'paused';
    this.input = emptyInput();
    return true;
  }

  resume(): boolean {
    if (this.state !== 'paused') return false;
    this.state = 'playing';
    this.input = emptyInput();
    return true;
  }

  returnToGarage(): void {
    this.state = 'garage';
    this.input = emptyInput();
    this.resetRun();
  }

  setViewport(width: number, height: number): void {
    this.camera.setViewport(width, height);
  }

  private resetRun(): void {
    this.time = 0;
    this.rng.reset();
    this.stage.reset();
    const start = this.stageData.start;
    this.player.reset(copy(start.position), start.yaw);
    this.camera.yaw = start.yaw;
    this.camera.pitch = 0;
    this.camera.follow(this.player.pos, this.stage.world);
    this.player.yaw = this.camera.yaw;
    this.fcs.reset();
    this.weapons.reset();
    this.projectiles.reset();
    this.enemies.reset();
    this.recentShots = [];
    this.shotSeq = 0;
    this.events = [];
    this.currentSectorId = null;
    this.visitedSectorIds = [];
    this.controlsDestroyed = 0;
    this.failReason = null;
    this.input = emptyInput();
    this.updateSector();
    this.updateFreeAim();
    this.fireSolution = computeFireSolution(this.player.weapon, this.player.getMuzzlePosition(), null, this.time);
    this.aimDirection = normalize(sub(this.freeAimPoint, this.player.getMuzzlePosition()));
  }

  // -------------------------------------------------------------------------
  // 入力と更新
  // -------------------------------------------------------------------------

  /** 描画フレームごとの入力を設定する。エッジは次の advance() の先頭で一度だけ消費される */
  setInput(frame: InputFrame): void {
    this.input = { ...frame };
  }

  /**
   * 実時間 realDt [s] だけシミュレーションを進める（playing 中のみ）。
   * 1/120 秒以下の固定刻みで進め、QB噴射終了・EN回復開始・射撃時刻などのイベント時刻で分割する。
   */
  advance(realDt: number): void {
    if (this.state !== 'playing') return;
    let remaining = Math.min(Math.max(0, realDt), SIM.maxFrameSeconds);
    if (!Number.isFinite(remaining)) return;
    this.applyFrameInput();
    let guard = 0;
    while (remaining > 1e-9 && this.state === 'playing' && guard++ < 10000) {
      this.processDueEvents();
      if (this.state !== 'playing') break;
      let h = Math.min(remaining, SIM.maxStep);
      const next = this.nextEventTime();
      if (next !== null && next > this.time + 1e-9 && next < this.time + h) h = next - this.time;
      this.stepOnce(h);
      remaining -= h;
    }
    if (this.state === 'playing') this.processDueEvents();
  }

  /** フレーム先頭: 視点、武器切り替え、エッジ入力（QB/Shift/Space） */
  private applyFrameInput(): void {
    const input = this.input;
    if (input.lookDeltaX !== 0 || input.lookDeltaY !== 0) {
      this.camera.applyLook(input.lookDeltaX, input.lookDeltaY);
      this.camera.follow(this.player.pos, this.stage.world);
      this.player.yaw = this.camera.yaw;
    }
    if (input.weaponSelect !== null && input.weaponSelect !== this.player.weapon) {
      this.player.weapon = input.weaponSelect;
      this.updateFireSolution();
    }
    this.player.applyEdgeInput(input, this.camera.yaw, this.time, this.events);
    // 視点・武器が変わった同じフレームの射撃が最新の照準点・補正解を使うように更新
    this.updateFreeAim();
    this.updateFireSolution();
    // エッジは消費済み
    this.input = { ...input, qbPressed: false, shiftPressed: false, spacePressed: false, weaponSelect: null, lookDeltaX: 0, lookDeltaY: 0 };
  }

  /** 現在時刻以降の最も近いイベント時刻（なければ null） */
  private nextEventTime(): number | null {
    let next: number | null = null;
    const consider = (t: number | null) => {
      if (t === null || !Number.isFinite(t)) return;
      if (t < this.time) return;
      if (next === null || t < next) next = t;
    };
    consider(this.player.nextEventTime(this.time, this.input));
    consider(this.weapons.nextFireTime(this.player, this.input, this.time));
    consider(this.enemies.nextEventTime(this.time));
    return next;
  }

  /** 現在時刻に到来している射撃イベントを処理する */
  private processDueEvents(): void {
    // プレイヤーの射撃
    if (this.input.fireDown && this.player.alive) {
      const w = this.player.weapon;
      if (this.time + 1e-9 >= this.weapons.nextFireAt[w]) {
        const rec = this.weapons.tryFire(this.makeFireContext());
        if (rec) {
          this.recentShots.push(rec);
          if (this.recentShots.length > DIAG.recentShots) this.recentShots.splice(0, this.recentShots.length - DIAG.recentShots);
          // 即時命中（ビーム）で対象が破壊された場合に備え、ロックを再検証してから補正解を更新
          this.fcs.update(0, this.makeFcsContext());
          this.updateFireSolution();
        }
      }
    }
    // 敵の射撃
    this.enemies.fireDue(this.makeEnemyContext());
  }

  private stepOnce(h: number): void {
    const t0 = this.time;
    const playerPrevBox = this.player.getHitBox();
    this.enemies.beginStep();
    const enemyCtx = this.makeEnemyContext();
    this.enemies.integrate(h, enemyCtx);
    this.player.integrate(h, t0, this.input, this.camera.yaw, this.stage.world, this.events);
    const projCtx = this.makeProjectileContext(playerPrevBox);
    this.projectiles.integrate(h, t0, projCtx);
    this.time = t0 + h;

    this.camera.follow(this.player.pos, this.stage.world);
    this.player.yaw = this.camera.yaw;
    this.updateFreeAim();
    this.fcs.update(h, this.makeFcsContext());
    this.updateFireSolution();
    this.updateSector();

    // 失敗をクリアより優先
    if (this.player.hp <= 0) {
      this.fail('hp');
      return;
    }
    if (this.player.pos[1] < this.stageData.killY) {
      this.fail('fall');
      return;
    }
    if (this.stage.gateOpen && this.stage.isInExitZone(this.player.getHitCenter())) {
      this.state = 'cleared';
      this.events.push({ type: 'cleared' });
    }
  }

  private fail(reason: 'hp' | 'fall'): void {
    this.state = 'failed';
    this.failReason = reason;
    this.events.push({ type: 'failed', reason });
  }

  // -------------------------------------------------------------------------
  // コンテキスト生成
  // -------------------------------------------------------------------------

  private makeFcsContext(): FcsContext {
    return {
      time: this.time,
      camera: this.camera,
      muzzle: this.player.getMuzzlePosition(),
      targets: this.enemies.targetInfos(),
      world: this.stage.world,
    };
  }

  private makeFireContext(): FireContext {
    return {
      time: this.time,
      player: this.player,
      fcs: this.fcs,
      camera: this.camera,
      world: this.stage.world,
      targets: this.enemies.targetInfos(),
      projectiles: this.projectiles,
      freeAimPoint: this.freeAimPoint,
      events: this.events,
      damageEnemy: (id, amount, point, weapon) => this.damageEnemy(id, amount, point, weapon),
      nextShotId: () => ++this.shotSeq,
    };
  }

  private makeEnemyContext(): EnemyContext {
    return {
      time: this.time,
      world: this.stage.world,
      player: {
        center: this.player.getHitCenter(),
        velocity: copy(this.player.vel),
        alive: this.player.alive,
        feet: copy(this.player.pos),
        halfExtents: PLAYER.halfExtents,
      },
      projectiles: this.projectiles,
      events: this.events,
    };
  }

  private makeProjectileContext(playerPrevBox: { center: Vec3; halfExtents: Vec3 }): ProjectileContext {
    const cur = this.player.getHitBox();
    const player: HittableBox | null = this.player.alive
      ? { prevCenter: playerPrevBox.center, center: cur.center, halfExtents: cur.halfExtents }
      : null;
    return {
      time: this.time,
      world: this.stage.world,
      targets: this.enemies.hittables(),
      targetInfoById: (id: string) => this.enemies.targetInfo(id),
      player,
      damageEnemy: (id, amount, point, weapon) => this.damageEnemy(id, amount, point, weapon),
      damagePlayer: (amount, point, fromDirection) => this.damagePlayer(amount, point, fromDirection),
      events: this.events,
    };
  }

  // -------------------------------------------------------------------------
  // ダメージと目標
  // -------------------------------------------------------------------------

  private damageEnemy(id: string, amount: number, point: Vec3, weapon: Weapon): void {
    const res = this.enemies.damage(id, amount);
    if (!res) return;
    this.events.push({ type: 'enemyHit', enemyId: id, point: copy(point), weapon });
    if (res.killed) {
      const e = res.enemy;
      if (e.kind !== 'target') {
        this.events.push({ type: 'enemyDestroyed', enemyId: id, kind: e.kind, position: copy(e.pos) });
      }
      if (e.def.isGateControl && e.def.controlsBarrierId) {
        if (this.stage.openBarrier(e.def.controlsBarrierId)) {
          this.events.push({ type: 'barrierOpened', barrierId: e.def.controlsBarrierId });
        }
        this.controlsDestroyed++;
        if (this.controlsDestroyed >= OBJECTIVE.controlsRequired && this.stage.openGate()) {
          this.events.push({ type: 'gateOpened' });
        }
      }
    }
  }

  private damagePlayer(amount: number, point: Vec3, fromDirection: Vec3): void {
    if (!this.player.alive) return;
    this.player.takeDamage(amount);
    this.events.push({ type: 'playerHit', point: copy(point), fromDirection: copy(fromDirection), damage: amount });
  }

  private updateSector(): void {
    const id = this.stage.sectorAt(this.player.getHitCenter());
    if (id !== null && id !== this.currentSectorId) {
      this.currentSectorId = id;
      if (!this.visitedSectorIds.includes(id)) this.visitedSectorIds.push(id);
    }
  }

  /** カメラ中央レイの照準点（ステージと敵の最初の衝突、なければ遠方点） */
  private updateFreeAim(): void {
    const origin = this.camera.position;
    const dir = this.camera.forward();
    let best: number = CAMERA.freeAimDistance;
    const hit = this.stage.world.raycast(origin, dir, best);
    if (hit) best = hit.t;
    for (const t of this.enemies.targetInfos()) {
      if (!t.alive) continue;
      const d = raySphere(origin, dir, t.center, t.radius, best);
      if (d !== null && d < best) best = d;
    }
    this.freeAimPoint = addScaled(origin, dir, best);
  }

  /** 現在の補正解（HUD・スナップショット・腕の向き）を更新 */
  private updateFireSolution(): void {
    const muzzle = this.player.getMuzzlePosition();
    const target = this.fcs.lockedTarget(this.enemies.targetInfos());
    this.fireSolution = computeFireSolution(this.player.weapon, muzzle, target, this.time);
    if (this.fireSolution.status !== 'inactive' && this.fireSolution.launchDirection) {
      this.aimDirection = copy(this.fireSolution.launchDirection);
    } else {
      const d = normalize(sub(this.freeAimPoint, muzzle));
      this.aimDirection = d[0] === 0 && d[1] === 0 && d[2] === 0 ? this.camera.forward() : d;
    }
  }

  // -------------------------------------------------------------------------
  // 公開ビュー
  // -------------------------------------------------------------------------

  drainEvents(): SimEvent[] {
    const ev = this.events;
    this.events = [];
    return ev;
  }

  playerView(): PlayerView {
    const p = this.player;
    return {
      position: copy(p.pos),
      velocity: copy(p.vel),
      yaw: p.yaw,
      aimDirection: copy(this.aimDirection),
      muzzlePosition: p.getMuzzlePosition(),
      legs: this.loadout.legs,
      weapon: p.weapon,
      grounded: p.grounded,
      horizontalMode: p.horizontalMode,
      verticalMode: p.verticalMode,
      glideEnabled: p.glideEnabled,
      boosting: p.qbImpulseRemaining > 0,
      thrusting: p.thrusting,
      alive: p.alive,
    };
  }

  enemyViews(): EnemyView[] {
    return this.enemies.views();
  }

  projectileViews(): ProjectileView[] {
    return this.projectiles.views();
  }

  /** 対象の TargetInfo（HUD マーカー用） */
  targetInfo(id: string): TargetInfo | null {
    return this.enemies.targetInfo(id);
  }

  distanceToLockedTarget(): number | null {
    const t = this.fcs.lockedTarget(this.enemies.targetInfos());
    return t ? distance(t.center, this.player.getMuzzlePosition()) : null;
  }

  // -------------------------------------------------------------------------
  // スナップショット（§10）。全て新規オブジェクトのコピーを返す
  // -------------------------------------------------------------------------

  getSnapshot(): Snapshot {
    const p = this.player;
    const stats = computeEffectiveStats(this.loadout);
    const fs = this.fireSolution;
    const num = (x: number | null): number | null => (x === null || !Number.isFinite(x) ? null : x);
    const vec = (v: Vec3 | null): Vec3 | null => (v ? [v[0], v[1], v[2]] : null);
    return {
      version: SNAPSHOT_VERSION,
      seed: this.seed,
      state: this.state,
      elapsedSeconds: this.time,
      loadout: { ...this.loadout },
      player: {
        position: copy(p.pos),
        velocity: copy(p.vel),
        grounded: p.grounded,
        hp: p.hp,
        en: p.en,
        weapon: p.weapon,
        ammo: { machinegun: p.ammo.machinegun, missile: p.ammo.missile },
        movement: {
          horizontalMode: p.horizontalMode,
          verticalMode: p.verticalMode,
          glideEnabled: p.glideEnabled,
          desiredHorizontalDirection: [p.desiredDir[0], p.desiredDir[1]],
          qbSuccessfulCount: p.qbSuccessfulCount,
          qbLastStartedAtSeconds: num(p.qbLastStartedAt),
          qbImpulseRemainingSeconds: p.qbImpulseRemaining,
          qbCooldownRemainingSeconds: p.qbCooldownRemaining(this.time),
          lastEnSpentAtSeconds: num(p.lastEnSpentAt),
        },
      },
      effectiveStats: {
        maxEn: stats.maxEn,
        regenPerSecond: stats.regenPerSecond,
        lockSeconds: stats.lockSeconds,
        horizontalSpeedMultiplier: stats.horizontalSpeedMultiplier,
      },
      lock: {
        state: this.fcs.state,
        targetId: this.fcs.targetId,
        progress: this.fcs.progress,
        radiusCssPx: this.fcs.radiusCssPx(this.camera),
      },
      fireControl: {
        status: fs.status,
        weapon: fs.weapon,
        targetId: fs.targetId,
        evaluatedAtSeconds: num(fs.evaluatedAtSeconds),
        muzzlePosition: vec(fs.muzzlePosition),
        targetPosition: vec(fs.targetPosition),
        targetVelocity: vec(fs.targetVelocity),
        launchDirection: vec(fs.launchDirection),
        predictedFlightSeconds: num(fs.predictedFlightSeconds),
        predictedInterceptPosition: vec(fs.predictedInterceptPosition),
        aimPoint: vec(fs.aimPoint),
        residualMeters: num(fs.residualMeters),
      },
      recentPlayerShots: this.recentShots.map((s) => ({
        id: s.id,
        firedAtSeconds: s.firedAtSeconds,
        weapon: s.weapon,
        targetId: s.targetId,
        solutionStatus: s.solutionStatus,
        muzzlePosition: copy(s.muzzlePosition),
        targetPositionAtFire: vec(s.targetPositionAtFire),
        targetVelocityAtFire: vec(s.targetVelocityAtFire),
        launchDirection: copy(s.launchDirection),
        initialVelocity: vec(s.initialVelocity),
        accelerationAtFire: copy(s.accelerationAtFire),
        predictedFlightSeconds: num(s.predictedFlightSeconds),
        predictedInterceptPosition: vec(s.predictedInterceptPosition),
      })),
      enemies: this.enemies.enemies.map((e) => ({
        id: e.id,
        kind: (e.kind === 'target' ? 'turret' : e.kind) as 'guard' | 'turret',
        isGateControl: e.def.isGateControl,
        sectorId: e.def.sectorId,
        position: copy(e.pos),
        velocity: copy(e.vel),
        hp: e.hp,
        alive: e.alive,
        alert: e.alert,
        hasLineOfSight: e.hasLineOfSight,
        shotsFired: e.shotsFired,
        lastShotAtSeconds: num(e.lastShotAt),
      })),
      objective: {
        controlsDestroyed: this.controlsDestroyed,
        controlsRequired: OBJECTIVE.controlsRequired,
        openBarrierIds: [...this.stage.openBarrierIds],
        gateOpen: this.stage.gateOpen,
      },
      stage: {
        sectorCount: this.stageData.sectors.length,
        currentSectorId: this.currentSectorId,
        visitedSectorIds: [...this.visitedSectorIds],
        totalEnemies: OBJECTIVE.totalEnemies,
      },
    };
  }

  /** HUD 用: 弾体・敵の生存数など補助情報 */
  aliveEnemyCount(): number {
    return this.enemies.aliveCount();
  }

  /** HUD 用: ビームの EN 消費など */
  static readonly beamEnCost = WEAPONS.beam.enCost;
  static readonly qbCost = PLAYER.qb.cost;

  /** 試験用: ヒット判定リストを取得（読み取り専用） */
  hittables(): HittableSphere[] {
    return this.enemies.hittables();
  }
}
