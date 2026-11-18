/**
 * 正規攻略経路（STAGE_DATA.route）の実走試験（仕様 §2.2「全18通りの構成で通過可能」「飛行の必要時間とその消費、
 * 着地可能な足場を実際に確認」）。
 *
 * Game を実際に進める自動操縦で、開始地点から脱出領域までを最弱構成（recovery + quadruped: 最大 EN 90、
 * 空中水平速度 12.8 m/s）と既定構成（balanced + biped）で走破し、クリアできることを確認する。
 *
 * 守っていること:
 * - プレイヤーを瞬間移動させない。位置・EN・HP などの内部状態を書き換えない。移動は InputFrame と camera.yaw
 *   （マウス旋回に相当）だけで行い、Game.advance(1/60) で進める。
 * - 制御砲台 6 体は本物の射撃（FCS ロック → マシンガン）で破壊し、隔壁と最終ゲートは実際の仕組みで開く。
 * - 唯一の内部操作: 移動の検証に集中するため、制御砲台以外の 39 体を開始前に game.enemies.damage(id, 1e9) で
 *   無力化する（制御砲台は生きたまま反撃してくる）。
 * - 経路計画には NavGrid（ゲームの経路探索、プレイヤーの当たり判定サイズで生成）を読み取り専用で使う。
 *   同じ床面の区間は歩行経路を計画し、高低差のある区間（飛行・降下）は直進操縦で処理する。
 *
 * 自動操縦の規則（1 フレーム = 1/60 s）:
 * - 次の目標点への方向をカメラ水平面へ変換して moveForward / moveRight とし、camera.yaw を目標点へ向ける。
 * - 目標点が 2.5 m より高い場合、目標点の水平 5.5 m 以内（＝ダクト内）で Space を押し始めて保持し
 *   （ジャンプ → 0.2 s 後に飛行）、目標高さ + 0.5 m に達したら離す。
 * - 離陸前に EN が必要量未満なら接地したまま待つ（EN < 30 なら必ず待つ）。
 * - 長い平坦な区間ではグライド（Shift エッジ）を使う。
 * - 到達判定: 水平距離 2.0 m 未満 かつ |dy| 2.5 m 未満（次が飛行区間なら水平 1.0 m 未満）。
 * - 接地中に入力があるのに 0.5 s 動けなければ小ジャンプ（手すり越え）。
 * - 敵の発砲（enemyFire イベント。HUD が消費する公開イベント）を見たら 0.35 s だけ進行方向と直角へ跳び、
 *   発砲ごとに左右を反転する。敵弾は発射時のプレイヤー速度で偏差を取るので、これで大半が外れる
 *   （回避なしでは制御砲台 6 体の反撃で HP 1000 が尽きる）。
 * - 射撃位置では camera.lookAt で砲台を画面中央に置き、ロック完了中だけ発射する。TPS カメラか銃口の射線が
 *   開口の縁の壁に掛かるときは NavGrid で砲台まで歩行経路を引いて踏み込む（砲台へ直進すると壁面に沿って滑り
 *   開口から外れる）。左右移動は 1.5 m 先で射線が保てる側を選ぶ。
 * - 1 つの waypoint に 40 s（射撃位置では砲台破壊に 30 s）かかったら諦め、位置・モード・EN・周囲の障害物
 *   （raycast）を報告する。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_LOADOUT, DEFAULT_SEED, PLAYER } from '../src/params';
import { Game } from '../src/sim/game';
import { NavGrid } from '../src/sim/nav';
import { copy, distance, distanceXZ, dot, forwardFromYaw, rightFromYaw } from '../src/sim/vec';
import { STAGE_DATA } from '../src/stage/stageData';
import type { InputFrame, Loadout, RouteWaypoint, Vec3 } from '../src/types';
import { emptyInput } from '../src/types';

const VIEW = { width: 1280, height: 720 };
const DT = 1 / 60;

/** waypoint 到達判定 */
const REACH_XZ = 2.0;
const REACH_XZ_BEFORE_FLIGHT = 1.0;
const REACH_DY = 2.5;
/** 計画経路の中間点の到達判定 */
const SUB_REACH_XZ = 1.2;
/** これより高い目標点は飛行で登る */
const FLIGHT_THRESHOLD = 2.5;
/** 離陸を始める目標点までの水平距離（全ダクトの底の waypoint から頂上までの距離 4.5〜5 m を含む） */
const TAKEOFF_XZ = 5.5;
/** 目標高さに対する余裕（この高さに達したら Space を離す） */
const HOVER_MARGIN = 0.5;
/** 空中で目標高さより下へ落ちて押し直す不足量 */
const REPRESS_DEFICIT = 1.0;
/** 離陸前に最低限待つ EN */
const MIN_TAKEOFF_EN = 30;
const GLIDE_ON_DIST = 24;
const GLIDE_OFF_DIST = 8;
const STUCK_SPEED = 0.5;
const STUCK_SECONDS = 0.5;
const GIVE_UP_SECONDS = 40;
const SHOOT_GIVE_UP_SECONDS = 30;
/** 砲台を撃つ間、射撃が来なくても左右移動を切り替える周期 [s] */
const STRAFE_FLIP_PERIOD = 0.5;
/**
 * 敵の発砲（enemyFire イベント）を見て横へ跳ぶ時間 [s]。敵弾は発射時のプレイヤー速度で偏差を取るので、
 * 発砲直後に速度方向を変えれば外れる（仕様 §2.3「急な方向転換…による回避が成立する必要」）
 */
const DODGE_SECONDS = 0.35;
const REPLAN_INTERVAL = 1.0;
const MAX_SIM_SECONDS = 900;

interface FlightLog {
  flightPointId: string;
  takeoffAt: number;
  takeoffPos: Vec3;
  target: Vec3;
  takeoffEn: number;
  minEn: number;
  landEn: number | null;
  airSeconds: number;
  thrustSeconds: number;
  landPos: Vec3 | null;
}

interface TurretLog {
  id: string;
  fromWaypoint: number;
  seconds: number;
  hpBefore: number;
  hpAfter: number;
  mgAmmoUsed: number;
}

interface RunReport {
  loadout: Loadout;
  cleared: boolean;
  state: string;
  simSeconds: number;
  travelled3d: number;
  travelledXZ: number;
  minHp: number;
  hitsTaken: number;
  enemyShots: number;
  enWaitSeconds: number;
  hops: number;
  problems: string[];
  flights: FlightLog[];
  turrets: TurretLog[];
  waypointLog: string[];
  controlsDestroyed: number;
  visitedSectorIds: string[];
}

const f1 = (x: number): string => x.toFixed(1);
const f2 = (x: number): string => x.toFixed(2);
const fmtPos = (p: Vec3): string => `(${f1(p[0])}, ${f1(p[1])}, ${f1(p[2])})`;
const clamp1 = (v: number): number => (v < -1 ? -1 : v > 1 ? 1 : v);

class RoutePilot {
  readonly game: Game;
  readonly nav: NavGrid;
  readonly route: RouteWaypoint[] = STAGE_DATA.route;
  /** route[0] は開始地点 */
  wpIndex = 1;
  private wpStartTime = 0;
  private subPath: Vec3[] | null = null;
  private subIdx = 0;
  private lastPlanTime = -Infinity;
  private phase: 'move' | 'shoot' = 'move';
  private shootTurretId: string | null = null;
  private shootStart = 0;
  private shootHpBefore = 0;
  private shootAmmoBefore = 0;
  /** 射線が遮られたときに砲台へ踏み込む歩行経路（開口を正しく通る） */
  private shootPath: Vec3[] | null = null;
  private shootPathIdx = 0;
  private shootPathAt = -Infinity;
  private holdingSpace = false;
  private stuckSeconds = 0;
  private currentFlight: FlightLog | null = null;
  private done = false;
  private aborted = false;

  readonly problems: string[] = [];
  readonly flights: FlightLog[] = [];
  readonly turrets: TurretLog[] = [];
  readonly waypointLog: string[] = [];
  private travelled3d = 0;
  private travelledXZ = 0;
  private minHp: number = PLAYER.maxHp;
  private lockDrops = 0;
  private wasLocked = false;
  /** 回避: 敵の発砲ごとに横方向を反転し、DODGE_SECONDS の間だけ横へ動く */
  private dodgeSign = 1;
  private dodgeUntil = -Infinity;
  private lastFlipAt = 0;
  private hitsTaken = 0;
  private enemyShots = 0;
  private enWaitSeconds = 0;
  private hops = 0;

  constructor(game: Game) {
    this.game = game;
    // 読み取り専用の経路計画: プレイヤーの当たり判定サイズで歩行可能格子を作る。
    // 隔壁・ゲートをまたぐ辺はゲームの実ワールドで再判定されるので、開いた後にだけ通る計画になる
    this.nav = NavGrid.build(game.stage.world, { cellSize: 2, agentHalfExtents: PLAYER.halfExtents, floorLevels: STAGE_DATA.navFloorLevels });
  }

  run(): RunReport {
    const g = this.game;
    const maxFrames = Math.ceil(MAX_SIM_SECONDS / DT);
    let frames = 0;
    while (g.state === 'playing' && !this.aborted && !this.done && frames < maxFrames) {
      this.step();
      frames++;
    }
    if (g.state === 'failed') {
      this.problems.push(`失敗 (${g.failReason}) at ${fmtPos(g.player.pos)} t=${f1(g.time)}s waypoint #${this.wpIndex + 1}`);
    } else if (g.state === 'playing' && !this.aborted) {
      this.problems.push(this.done ? `最終 waypoint に到達したがクリアしていない ${this.describe()}` : `模擬時間の上限 ${MAX_SIM_SECONDS}s に達した ${this.describe()}`);
    }
    const snap = g.getSnapshot();
    return {
      loadout: { ...g.loadout },
      cleared: g.state === 'cleared',
      state: g.state,
      simSeconds: g.time,
      travelled3d: this.travelled3d,
      travelledXZ: this.travelledXZ,
      minHp: this.minHp,
      hitsTaken: this.hitsTaken,
      enemyShots: this.enemyShots,
      enWaitSeconds: this.enWaitSeconds,
      hops: this.hops,
      problems: this.problems,
      flights: this.flights,
      turrets: this.turrets,
      waypointLog: this.waypointLog,
      controlsDestroyed: snap.objective.controlsDestroyed,
      visitedSectorIds: snap.stage.visitedSectorIds,
    };
  }

  // -------------------------------------------------------------------------

  private step(): void {
    const g = this.game;
    const p = g.player;
    const input = emptyInput();
    if (this.phase === 'shoot') this.stepShoot(input);
    else this.stepMove(input);
    if (this.aborted || this.done) return;

    const before = copy(p.pos);
    const enBefore = p.en;
    g.setInput(input);
    g.advance(DT);
    for (const ev of g.drainEvents()) {
      if (ev.type === 'enemyFire') {
        this.enemyShots++;
        this.dodgeSign = -this.dodgeSign;
        this.dodgeUntil = g.time + DODGE_SECONDS;
        this.lastFlipAt = g.time;
      } else if (ev.type === 'playerHit') {
        this.hitsTaken++;
      }
    }
    const after = p.pos;
    this.travelled3d += distance(before, after);
    this.travelledXZ += distanceXZ(before, after);
    this.minHp = Math.min(this.minHp, p.hp);

    const fl = this.currentFlight;
    if (fl) {
      fl.minEn = Math.min(fl.minEn, p.en, enBefore);
      fl.airSeconds += DT;
      if (p.thrusting) fl.thrustSeconds += DT;
      if (p.grounded) {
        fl.landEn = p.en;
        fl.landPos = copy(p.pos);
        this.currentFlight = null;
      }
    }
  }

  private currentWaypoint(): RouteWaypoint {
    return this.route[this.wpIndex];
  }

  private nextIsFlight(): boolean {
    const next = this.route[this.wpIndex + 1];
    return next !== undefined && next.position[1] - this.currentWaypoint().position[1] > FLIGHT_THRESHOLD;
  }

  private stepMove(input: InputFrame): void {
    const g = this.game;
    const p = g.player;
    const pos = p.pos;
    const wp = this.currentWaypoint();

    const reachXZ = this.nextIsFlight() ? REACH_XZ_BEFORE_FLIGHT : REACH_XZ;
    if (distanceXZ(pos, wp.position) < reachXZ && Math.abs(pos[1] - wp.position[1]) < REACH_DY) {
      this.onWaypointReached();
      if (this.phase === 'shoot' || this.done || this.aborted) {
        input.ctrlDown = true;
        return;
      }
    }
    if (g.time - this.wpStartTime > GIVE_UP_SECONDS) {
      this.problems.push(`waypoint #${this.wpIndex + 1} ${wp.note ?? ''} ${fmtPos(wp.position)} に ${GIVE_UP_SECONDS}s 以内に到達できない: ${this.describe()}`);
      this.aborted = true;
      return;
    }

    if (p.grounded && this.subPath === null && g.time - this.lastPlanTime >= REPLAN_INTERVAL) this.plan();

    let target: Vec3 = wp.position;
    if (this.subPath) {
      while (this.subIdx < this.subPath.length && distanceXZ(pos, this.subPath[this.subIdx]) < SUB_REACH_XZ) this.subIdx++;
      if (this.subIdx >= this.subPath.length) this.subPath = null;
      else target = this.subPath[this.subIdx];
    }

    const dx = target[0] - pos[0];
    const dz = target[2] - pos[2];
    const dist = Math.hypot(dx, dz);
    const dir: Vec3 = dist > 1e-6 ? [dx / dist, 0, dz / dist] : forwardFromYaw(g.camera.yaw);
    const yaw = Math.atan2(-dir[0], -dir[2]);
    g.camera.yaw = yaw;
    g.camera.pitch = 0;
    input.moveForward = clamp1(dot(dir, forwardFromYaw(yaw)));
    input.moveRight = clamp1(dot(dir, rightFromYaw(yaw)));

    const higher = target[1] - pos[1] > FLIGHT_THRESHOLD;
    let moving = true;
    // 回避: 接地中に敵が発砲した直後は進行方向と直角へ跳ぶ（カメラは進行方向を向いているので moveRight が横）
    const dodging = p.grounded && g.time < this.dodgeUntil;
    if (dodging) {
      input.moveForward = 0;
      input.moveRight = this.dodgeSign;
    }
    if (p.grounded) {
      this.holdingSpace = false;
      if (higher && dist <= TAKEOFF_XZ) {
        const need = this.enNeeded(target[1] + HOVER_MARGIN - pos[1]);
        if (p.en + 1e-9 < need) {
          // 接地したまま EN を待つ（ブレーキでグライドを解除し、その場に留まる）
          moving = false;
          input.moveForward = 0;
          input.moveRight = 0;
          input.ctrlDown = true;
          this.enWaitSeconds += DT;
        } else {
          input.spacePressed = true;
          input.spaceDown = true;
          this.holdingSpace = true;
          this.beginFlight(target);
        }
      }
    } else {
      const needRise = target[1] + HOVER_MARGIN - pos[1];
      if (this.holdingSpace) {
        if (needRise > 0) input.spaceDown = true;
        else this.holdingSpace = false;
      } else if (needRise > REPRESS_DEFICIT && p.en > 1e-6) {
        input.spacePressed = true;
        input.spaceDown = true;
        this.holdingSpace = true;
      }
    }

    // グライド: 長い平坦区間だけ。目標点に近づいたら、また飛行区間・待機中は解除する
    const wantGlide = moving && !higher && dist > GLIDE_ON_DIST;
    if (wantGlide && !p.glideEnabled) input.shiftPressed = true;
    else if (!wantGlide && p.glideEnabled && (!moving || higher || dist < GLIDE_OFF_DIST)) input.shiftPressed = true;

    // 引っかかり検出: 接地・入力あり・水平速度ほぼ 0 が続いたら小ジャンプ（手すり越え）
    if (moving && !dodging && p.grounded && !input.spacePressed) {
      if (Math.hypot(p.vel[0], p.vel[2]) < STUCK_SPEED) this.stuckSeconds += DT;
      else this.stuckSeconds = 0;
      if (this.stuckSeconds >= STUCK_SECONDS) {
        input.spacePressed = true;
        input.spaceDown = true;
        this.stuckSeconds = 0;
        this.hops++;
        this.waypointLog.push(`  t=${f1(g.time)}s 引っかかり → 小ジャンプ at ${fmtPos(pos)} 目標 ${fmtPos(target)}`);
      }
    } else {
      this.stuckSeconds = 0;
    }
  }

  /** 離陸に必要な EN（ジャンプで得る高さ約 1.6 m を差し引き、上昇 8 m/s・20 EN/s、余裕 10） */
  private enNeeded(rise: number): number {
    const jumpRise = PLAYER.jumpSpeed * PLAYER.flightHoldSeconds - 0.5 * PLAYER.gravity * PLAYER.flightHoldSeconds * PLAYER.flightHoldSeconds;
    const thrustSeconds = Math.max(0, rise - jumpRise) / PLAYER.flightRiseSpeed;
    const need = PLAYER.flightEnPerSecond * thrustSeconds + 10;
    return Math.min(this.game.player.stats.maxEn, Math.max(MIN_TAKEOFF_EN, need));
  }

  private beginFlight(target: Vec3): void {
    const p = this.game.player;
    const fp = STAGE_DATA.flightPoints.find((f) => distanceXZ(f.from, p.pos) <= 12 && distanceXZ(f.to, target) <= 12);
    const log: FlightLog = {
      flightPointId: fp ? fp.id : '(記録外)',
      takeoffAt: this.game.time,
      takeoffPos: copy(p.pos),
      target: copy(target),
      takeoffEn: p.en,
      minEn: p.en,
      landEn: null,
      airSeconds: 0,
      thrustSeconds: 0,
      landPos: null,
    };
    this.flights.push(log);
    this.currentFlight = log;
    this.waypointLog.push(`  t=${f1(this.game.time)}s 離陸 ${log.flightPointId} at ${fmtPos(p.pos)} → ${fmtPos(target)} EN=${f1(p.en)}`);
  }

  private plan(): void {
    const g = this.game;
    const pos = g.player.pos;
    const wp = this.currentWaypoint().position;
    this.lastPlanTime = g.time;
    if (Math.abs(pos[1] - wp[1]) > 3) return; // 別の床面: 直進（飛行・降下）
    const path = this.nav.findPath(pos, wp);
    if (!path) return;
    const pts = this.straighten([copy(pos), ...path, copy(wp)], wp[1]);
    this.subPath = pts;
    this.subIdx = 0;
  }

  /** 経路の折れ点を、プレイヤー箱（余裕 0.25 m）の直線掃引が実ワールドで通り、床が続く範囲で間引く */
  private straighten(pts: Vec3[], levelY: number): Vec3[] {
    const out: Vec3[] = [];
    let i = 0;
    while (i < pts.length - 1) {
      let best = i + 1;
      for (let j = pts.length - 1; j > i + 1; j--) {
        if (this.lineClear(pts[i], pts[j], levelY)) {
          best = j;
          break;
        }
      }
      out.push(pts[best]);
      i = best;
    }
    return out;
  }

  private lineClear(a: Vec3, b: Vec3, levelY: number): boolean {
    const world = this.game.stage.world;
    const len = distanceXZ(a, b);
    const steps = Math.max(1, Math.ceil(len / 0.5));
    const half: Vec3 = [PLAYER.halfExtents[0] + 0.25, PLAYER.halfExtents[1] - 0.05, PLAYER.halfExtents[2] + 0.25];
    const cy = levelY + PLAYER.hitCenterOffset[1] + 0.1;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const c: Vec3 = [a[0] + (b[0] - a[0]) * t, cy, a[2] + (b[2] - a[2]) * t];
      if (world.boxOverlaps(c, half)) return false;
      const probe = world.moveBox(c, half, [0, -0.5, 0]);
      if (!probe.hitNegY) return false;
    }
    return true;
  }

  private onWaypointReached(): void {
    const g = this.game;
    const p = g.player;
    const wp = this.currentWaypoint();
    this.waypointLog.push(
      `#${this.wpIndex + 1} ${wp.note ?? ''} ${fmtPos(wp.position)} 到達 t=${f1(g.time)}s pos=${fmtPos(p.pos)} EN=${f1(p.en)} HP=${f1(p.hp)} 区画=${g.currentSectorId} 移動=${f1(this.travelled3d)}m`,
    );
    const m = /T-(\d\d) の射撃位置/.exec(wp.note ?? '');
    if (m) {
      const id = `t${m[1]}`;
      const info = g.targetInfo(id);
      if (info && info.alive) {
        this.phase = 'shoot';
        this.shootTurretId = id;
        this.shootStart = g.time;
        this.shootHpBefore = p.hp;
        this.shootAmmoBefore = p.ammo.machinegun;
        this.subPath = null;
        return;
      }
    }
    this.advanceWaypoint();
  }

  private advanceWaypoint(): void {
    this.wpIndex++;
    this.wpStartTime = this.game.time;
    this.subPath = null;
    this.subIdx = 0;
    this.lastPlanTime = -Infinity;
    this.stuckSeconds = 0;
    this.phase = 'move';
    this.shootTurretId = null;
    this.shootPath = null;
    if (this.wpIndex >= this.route.length) this.done = true;
  }

  private stepShoot(input: InputFrame): void {
    const g = this.game;
    const p = g.player;
    const id = this.shootTurretId as string;
    const info = g.targetInfo(id);
    if (!info || !info.alive) {
      const seconds = g.time - this.shootStart;
      this.turrets.push({ id, fromWaypoint: this.wpIndex + 1, seconds, hpBefore: this.shootHpBefore, hpAfter: p.hp, mgAmmoUsed: this.shootAmmoBefore - p.ammo.machinegun });
      this.waypointLog.push(
        `  制御砲台 ${id} 破壊 ${f1(seconds)}s HP ${f1(this.shootHpBefore)}→${f1(p.hp)} 射撃位置=${fmtPos(p.pos)} ロック喪失=${this.lockDrops}回 隔壁=${JSON.stringify(g.stage.openBarrierIds)} ゲート=${g.stage.gateOpen}`,
      );
      this.lockDrops = 0;
      this.wasLocked = false;
      this.advanceWaypoint();
      input.ctrlDown = true;
      return;
    }
    if (g.time - this.shootStart > SHOOT_GIVE_UP_SECONDS) {
      const muzzle = p.getMuzzlePosition();
      const world = g.stage.world;
      this.problems.push(
        `制御砲台 ${id} を waypoint #${this.wpIndex + 1} から ${SHOOT_GIVE_UP_SECONDS}s 以内に破壊できない: 距離=${f1(distance(muzzle, info.center))}m ` +
          `銃口→対象 遮蔽=${world.segmentBlocked(muzzle, info.center)} カメラ→対象 遮蔽=${world.segmentBlocked(g.camera.position, info.center)} ` +
          `lock=${g.fcs.state}/${g.fcs.targetId} 砲台HP=${g.enemies.byId(id)?.hp} ${this.describe()}`,
      );
      this.aborted = true;
      return;
    }
    // TPS カメラは注視方向で位置が変わるため、対象が画面中央に来るまで注視と追従を収束させる（tests/game.test.ts と同じ）
    for (let k = 0; k < 4; k++) {
      g.camera.lookAt(info.center);
      g.camera.follow(p.pos, g.stage.world);
    }
    const locked = g.fcs.state === 'locked' && g.fcs.targetId === id;
    if (this.wasLocked && !locked) this.lockDrops++;
    this.wasLocked = locked;
    input.fireDown = locked;
    if (p.glideEnabled) input.shiftPressed = true;
    const world = g.stage.world;
    const muzzle = p.getMuzzlePosition();
    const losOk = (offset: Vec3): boolean =>
      !world.segmentBlocked([g.camera.position[0] + offset[0], g.camera.position[1], g.camera.position[2] + offset[2]], info.center) &&
      !world.segmentBlocked([muzzle[0] + offset[0], muzzle[1], muzzle[2] + offset[2]], info.center);
    if (!losOk([0, 0, 0])) {
      // 射撃位置が開口の縁で、TPS カメラか銃口の射線が壁に掛かる: 歩行経路に沿って砲台へ踏み込む（人間なら部屋に入る）。
      // 砲台へ直進すると壁に押し付けられて面に沿って滑り、開口から外れることがあるので、開口を通る経路を計画する
      const foot = g.enemies.byId(id)?.pos ?? info.center;
      if (this.shootPath === null || g.time - this.shootPathAt >= REPLAN_INTERVAL) {
        const path = p.grounded ? this.nav.findPath(p.pos, foot) : null;
        this.shootPath = path ? this.straighten([copy(p.pos), ...path], p.pos[1]) : null;
        this.shootPathIdx = 0;
        this.shootPathAt = g.time;
      }
      let target: Vec3 = foot;
      if (this.shootPath) {
        while (this.shootPathIdx < this.shootPath.length && distanceXZ(p.pos, this.shootPath[this.shootPathIdx]) < SUB_REACH_XZ) this.shootPathIdx++;
        if (this.shootPathIdx < this.shootPath.length) target = this.shootPath[this.shootPathIdx];
      }
      const dx = target[0] - p.pos[0];
      const dz = target[2] - p.pos[2];
      const len = Math.hypot(dx, dz);
      if (len > 1e-6) {
        const dir: Vec3 = [dx / len, 0, dz / len];
        input.moveForward = clamp1(dot(dir, forwardFromYaw(g.camera.yaw)));
        input.moveRight = clamp1(dot(dir, rightFromYaw(g.camera.yaw)));
      }
      return;
    }
    this.shootPath = null;
    // 砲台の偏差射撃を外すため左右へ動く（ロック円は毎フレーム中央へ向け直すので維持される）。
    // 向きは敵の発砲ごとに反転し（step() で処理）、発砲がなくても STRAFE_FLIP_PERIOD ごとに反転する。
    // 横へ 1.5 m 動いた位置で射線が壁に掛かるなら逆側へ動く（開口越しの射線を保つ）
    if (g.time - this.lastFlipAt >= STRAFE_FLIP_PERIOD) {
      this.dodgeSign = -this.dodgeSign;
      this.lastFlipAt = g.time;
    }
    const right = rightFromYaw(g.camera.yaw);
    const probe = (sign: number): boolean => losOk([right[0] * sign * 1.5, 0, right[2] * sign * 1.5]);
    if (!probe(this.dodgeSign)) {
      if (probe(-this.dodgeSign)) this.dodgeSign = -this.dodgeSign;
      else {
        input.moveRight = 0;
        return;
      }
    }
    input.moveRight = this.dodgeSign;
  }

  /** 位置・モード・EN と周囲の障害物（raycast） */
  private describe(): string {
    const g = this.game;
    const p = g.player;
    const c = p.getHitCenter();
    const world = g.stage.world;
    const dirs: [string, Vec3][] = [
      ['+X', [1, 0, 0]],
      ['-X', [-1, 0, 0]],
      ['+Z', [0, 0, 1]],
      ['-Z', [0, 0, -1]],
      ['+Y', [0, 1, 0]],
      ['-Y', [0, -1, 0]],
    ];
    const around = dirs
      .map(([n, d]) => {
        const h = world.raycast(c, d, 15);
        return `${n}:${h ? `${f2(h.t)}m(${h.tag ?? '?'})` : 'free'}`;
      })
      .join(' ');
    const sub = this.subPath ? ` 計画中間点=${fmtPos(this.subPath[Math.min(this.subIdx, this.subPath.length - 1)])}` : ' 計画なし(直進)';
    return `pos=${fmtPos(p.pos)} vel=${fmtPos(p.vel)} grounded=${p.grounded} h=${p.horizontalMode} v=${p.verticalMode} EN=${f1(p.en)} HP=${f1(p.hp)} 区画=${g.currentSectorId} t=${f1(g.time)}s${sub} 周囲: ${around}`;
  }
}

function runPlaythrough(loadout: Loadout): RunReport {
  const game = new Game({ stage: STAGE_DATA, loadout, seed: DEFAULT_SEED, viewport: VIEW, buildNav: false });
  expect(game.launch()).toBe(true);
  // 移動の検証に集中するため、制御砲台以外の 39 体を開始前に無力化する（唯一の内部操作。制御砲台 6 体は実射撃で破壊する）
  for (const e of STAGE_DATA.enemies) {
    if (!e.isGateControl) game.enemies.damage(e.id, 1e9);
  }
  expect(game.aliveEnemyCount()).toBe(6);
  const pilot = new RoutePilot(game);
  return pilot.run();
}

function printReport(title: string, r: RunReport): void {
  const lines: string[] = [];
  lines.push(`=== ${title}: ${JSON.stringify(r.loadout)} ===`);
  lines.push(...r.waypointLog);
  lines.push(`飛行地点ごとの EN（最弱構成でも許容 72 以内であること）:`);
  for (const f of r.flights) {
    lines.push(
      `  ${f.flightPointId}: 離陸 ${fmtPos(f.takeoffPos)} → 着地 ${f.landPos ? fmtPos(f.landPos) : '未着地'} ` +
        `EN 離陸時 ${f1(f.takeoffEn)} / 最小 ${f1(f.minEn)} / 着地時 ${f.landEn === null ? '-' : f1(f.landEn)} 消費 ${f1(f.takeoffEn - f.minEn)} ` +
        `滞空 ${f2(f.airSeconds)}s 推進 ${f2(f.thrustSeconds)}s`,
    );
  }
  lines.push(`制御砲台: ${r.turrets.map((t) => `${t.id} ${f1(t.seconds)}s HP${f1(t.hpBefore)}→${f1(t.hpAfter)} MG${t.mgAmmoUsed}発`).join(' | ')}`);
  lines.push(
    `結果 state=${r.state} 模擬時間=${f1(r.simSeconds)}s 移動距離 3D=${f1(r.travelled3d)}m XZ=${f1(r.travelledXZ)}m 最小HP=${f1(r.minHp)} 被弾=${r.hitsTaken}/${r.enemyShots}発 ` +
      `EN待ち=${f1(r.enWaitSeconds)}s 小ジャンプ=${r.hops} 制御砲台破壊=${r.controlsDestroyed} 通過区画=${r.visitedSectorIds.join(',')}`,
  );
  if (r.problems.length > 0) lines.push(`経路の問題:\n  ${r.problems.join('\n  ')}`);
  console.log(lines.join('\n'));
}

function assertCleared(r: RunReport): void {
  expect(r.problems).toEqual([]);
  expect(r.state).toBe('cleared');
  expect(r.cleared).toBe(true);
  expect(r.controlsDestroyed).toBe(6);
  expect(r.visitedSectorIds.length).toBeGreaterThanOrEqual(12);
  // 記録された飛行必須箇所 7 か所を全て実際に飛行で通過している
  const flown = new Set(r.flights.map((f) => f.flightPointId));
  for (const fp of STAGE_DATA.flightPoints) expect(flown.has(fp.id), `飛行地点 ${fp.id} を飛行していない`).toBe(true);
  for (const f of r.flights) {
    expect(f.landPos, `${f.flightPointId} が着地していない`).not.toBeNull();
    expect(f.minEn).toBeGreaterThanOrEqual(0);
  }
  expect(r.travelled3d).toBeGreaterThan(1500);
}

describe('正規経路の実走（Game 駆動の自動操縦、テレポートなし）', () => {
  it('最弱構成（generator=recovery, legs=quadruped: 最大 EN 90・空中 12.8 m/s）で開始地点から脱出領域までクリアできる', () => {
    const r = runPlaythrough({ fcs: 'medium', generator: 'recovery', legs: 'quadruped' });
    printReport('最弱構成', r);
    assertCleared(r);
    // 飛行の EN 消費が最弱構成の許容（90 / 1.25 = 72）以内
    for (const f of r.flights) expect(f.takeoffEn - f.minEn).toBeLessThanOrEqual(72);
  });

  it('既定構成（balanced + biped）で開始地点から脱出領域までクリアできる', () => {
    const r = runPlaythrough(DEFAULT_LOADOUT);
    printReport('既定構成', r);
    assertCleared(r);
  });
});
