/**
 * 敵 AI（警備ロボット・固定砲台・試験用標的）。仕様 §2.3、ARCHITECTURE §3.8。
 *
 * - 索敵: 距離（敵中心→プレイヤー中心）≤ 索敵距離 かつ 銃口→プレイヤー中心の線分が遮蔽されていない。
 *   カメラ・プレイヤーの向き・先制攻撃には依存しない。
 * - 攻撃スケジュール: 初回は射線取得 t0 + firstShotDelay にバースト開始。バーストは burstCount 発を burstInterval
 *   間隔、次のバースト開始は前の開始 + burstPeriod。射線を失った間は「次にバーストを開始できる時刻」
 *   （nextBurstStartAt）を保持し、再露出時刻 te で burstStartAt = max(nextBurstStartAt, te + telegraph)。
 *   記憶（memorySeconds）が切れたら警戒解除し、次の発見は初回扱い。
 * - 各発は発射時刻に銃口からの射線を再確認し、遮蔽なら撃たずにスケジュールだけ進める。
 *   銃口が遮蔽物の中にある場合（壁際に置かれた砲台など）は砲塔の回転中心／機体中心を射線と発射の起点にする。
 * - 偏差: solveLinearLead（上限 leadMaxSeconds）。解なしなら t = min(|r|/弾速, 上限)。ばらつき ≤ aimSpreadDeg。
 * - 警備ロボットの移動は速度ベース＋重力＋ world.moveBox（滑り）＋敵同士の簡易分離（固定砲台も避ける）。
 *   分離の押し戻しは 1 ステップあたりの量を制限し、報告する速度（(pos − start)/h）が移動速度を大きく越えない。
 * - 経路は nav.findPathToward（目標が別の床面・空中でも自分の床面へ投影。到達不能なら最も近い地点まで）。
 *   経路の末尾に着いても目標に届かない場合は側方へ回り込む（障害物へ押し付き続けない）。
 * - 一時停止中はこのクラスが呼ばれないので、全タイマーは ctx.time / h 基準で自然に停止する。
 *
 * Three.js / DOM に依存しない。
 */
import { ENEMIES } from '../params';
import type { CollisionWorld, EnemyDef, EnemyKind, EnemyView, HittableSphere, SimEvent, TargetInfo, Vec3 } from '../types';
import { solveLinearLead } from './ballistics';
import type { NavGrid } from './nav';
import type { Projectiles } from './projectiles';
import type { Rng } from './rng';
import { add, addScaled, copy, cross, degToRad, distance, distanceXZ, dot, forwardFromYaw, length, normalize, rotateToward, rotateY, scale, sub, yawFromDirection } from './vec';

export interface EnemyContext {
  time: number;
  world: CollisionWorld;
  player: { center: Vec3; velocity: Vec3; alive: boolean; feet: Vec3; halfExtents: Vec3 };
  projectiles: Projectiles;
  events: SimEvent[];
}

/** 警備ロボット・固定砲台に共通する戦闘パラメーター */
type CombatStats = typeof ENEMIES.guard | typeof ENEMIES.turret;

/** 射撃時刻の比較許容 [s] */
const TIME_EPS = 1e-9;
/** 砲塔・銃の向きを見た目上回す速度 [rad/s]（射撃方向は常に厳密な計算値） */
const GUN_TURN_RATE = degToRad(240);
/** 移動判断用の射線喪失の保持時間 [s]（扉の縁で射線が明滅しても追跡/後退を交互に繰り返さない。射撃判断には使わない） */
const MOVE_LOS_HYSTERESIS = 0.1;
/** 後退が壁で塞がれた後、側方移動へ切り替える時間 [s] */
const RETREAT_BLOCKED_SECONDS = 0.6;
/** 側方移動の左右切り替え間隔 [s]（乱数） */
const STRAFE_FLIP_MIN = 1.5;
const STRAFE_FLIP_MAX = 2.5;
/** 側方移動中に距離帯の中央へ寄せる半径方向成分の重み */
const STRAFE_RADIAL_WEIGHT = 0.25;
/** 側方移動で射線を保てるかを先読みする時間 [s]（失う側なら反転、両側で失うなら停止して撃つ） */
const STRAFE_LOS_LOOKAHEAD = 0.3;
/** 最後の確認位置にこれより近づいても射線がなければ回り込む [m] */
const FLANK_DISTANCE = 3;
/** 経路の再計算間隔 [s] と、目標がこれ以上動いたら再計算する距離 [m] */
const PATH_RECOMPUTE_SECONDS = 0.5;
const PATH_GOAL_TOLERANCE = 3;
/** 目標の移動・壁接触による再計算でも、これより短い間隔では再計算しない [s]（A* の呼び出し頻度の上限） */
const PATH_MIN_RECOMPUTE_SECONDS = 0.25;
/** 経路の末尾から目標までがこの距離（セル数）以内なら「目標に到達する経路」とみなす */
const PATH_ARRIVAL_CELLS = 1.5;
/** 敵同士の分離距離（XZ）[m] */
const SEPARATION_DISTANCE = 2.2;
/** 分離の押し戻し速度の上限 [m/s]（1 ステップの押し戻し量 ≤ SEPARATION_SPEED·h） */
const SEPARATION_SPEED = 4;
/** 警備ロボット中心と固定砲台中心の最小 XZ 距離 [m]（両者の移動 AABB 半径の和＋余裕） */
const TURRET_CLEARANCE = ENEMIES.guard.halfExtents[0] + ENEMIES.turret.halfExtents[0] + 0.2;
/** 銃口が遮蔽物の中にあるかを調べる微小箱の半径 [m] */
const MUZZLE_PROBE_HALF: Vec3 = [0.01, 0.01, 0.01];
/** 共有の再送信間隔 [s]（射線が続いている間） */
const SHARE_INTERVAL = 1;

function statsOf(kind: EnemyKind): CombatStats | null {
  if (kind === 'guard') return ENEMIES.guard;
  if (kind === 'turret') return ENEMIES.turret;
  return null;
}

function xzDirection(from: Vec3, to: Vec3): Vec3 {
  const dx = to[0] - from[0];
  const dz = to[2] - from[2];
  const l = Math.hypot(dx, dz);
  if (l <= 1e-9) return [0, 0, 0];
  return [dx / l, 0, dz / l];
}

export class Enemy {
  readonly id: string;
  readonly kind: EnemyKind;
  readonly def: EnemyDef;
  pos: Vec3;
  prevPos: Vec3;
  vel: Vec3 = [0, 0, 0];
  yaw: number;
  gunDirection: Vec3;
  hp: number;
  readonly maxHp: number;
  alive = true;
  alert = false;
  hasLineOfSight = false;
  /** 移動判断用の射線（ヒステリシス付き）と、その切り替え計時 */
  moveLos = false;
  moveLosLostAt: number | null = null;
  /** 後退が壁で塞がれたとき、この時刻まで側方移動に切り替える */
  retreatBlockedUntil = -Infinity;
  shotsFired = 0;
  lastShotAt: number | null = null;
  telegraphing = false;
  readonly radius: number;
  readonly centerOffset: Vec3;
  readonly halfExtents: Vec3;

  // --- 内部状態（EnemyManager が更新する。描画・HUD は読まない） ---
  /** 最後に確認したプレイヤーの当たり判定中心・足元・速度・時刻 */
  lastSeenPos: Vec3 | null = null;
  lastSeenFeet: Vec3 | null = null;
  lastSeenVel: Vec3 | null = null;
  lastSeenAt: number | null = null;
  /** 予定中のバースト開始時刻（null は予定なし） */
  burstStartAt: number | null = null;
  /** 次にバーストを開始できる最早時刻（射線喪失中も保持）。null は「この警戒期間で未射撃」 */
  nextBurstStartAt: number | null = null;
  /** 現在のバースト内で次に撃つ発の番号 */
  shotIndex = 0;
  /** 予告イベントを発行済みのバースト開始時刻 */
  telegraphedBurst: number | null = null;
  lastShareAt: number | null = null;
  /** 鉛直速度（重力）と接地 */
  vy = 0;
  grounded = false;
  strafeSide = 1;
  strafeFlipAt: number | null = null;
  path: Vec3[] | null = null;
  pathIndex = 0;
  pathGoal: Vec3 | null = null;
  pathComputedAt: number | null = null;
  /** 経路の末尾が目標に届いているか（false なら到達できる最寄り地点までの経路） */
  pathReached = false;
  /** 経路追従中に壁へ当たった（次の再計算機会で引き直す） */
  pathHitWall = false;

  constructor(def: EnemyDef) {
    this.id = def.id;
    this.kind = def.kind;
    this.def = def;
    const s = statsOf(def.kind);
    if (s) {
      this.maxHp = s.hp;
      this.radius = s.radius;
      this.centerOffset = copy(s.centerOffset);
      this.halfExtents = copy(s.halfExtents);
    } else {
      this.maxHp = ENEMIES.target.hp;
      this.radius = ENEMIES.target.radius;
      this.centerOffset = copy(ENEMIES.target.centerOffset);
      this.halfExtents = [this.radius, this.radius, this.radius];
    }
    this.hp = this.maxHp;
    this.pos = copy(def.position);
    this.prevPos = copy(def.position);
    this.yaw = def.yaw;
    this.gunDirection = forwardFromYaw(def.yaw);
    this.resetFromDef();
  }

  /** 定義から全状態を復元する（ID・順序は不変） */
  resetFromDef(): void {
    this.pos = copy(this.def.position);
    this.prevPos = copy(this.def.position);
    this.vel = this.kind === 'target' && this.def.velocity ? copy(this.def.velocity) : [0, 0, 0];
    this.yaw = this.def.yaw;
    this.gunDirection = forwardFromYaw(this.def.yaw);
    this.hp = this.maxHp;
    this.alive = true;
    this.alert = false;
    this.hasLineOfSight = false;
    this.moveLos = false;
    this.moveLosLostAt = null;
    this.retreatBlockedUntil = -Infinity;
    this.shotsFired = 0;
    this.lastShotAt = null;
    this.telegraphing = false;
    this.lastSeenPos = null;
    this.lastSeenFeet = null;
    this.lastSeenVel = null;
    this.lastSeenAt = null;
    this.burstStartAt = null;
    this.nextBurstStartAt = null;
    this.shotIndex = 0;
    this.telegraphedBurst = null;
    this.lastShareAt = null;
    this.vy = 0;
    this.grounded = false;
    this.strafeSide = 1;
    this.strafeFlipAt = null;
    this.path = null;
    this.pathIndex = 0;
    this.pathGoal = null;
    this.pathComputedAt = null;
    this.pathReached = false;
    this.pathHitWall = false;
  }

  /** 当たり判定球の中心 */
  center(): Vec3 {
    return add(this.pos, this.centerOffset);
  }

  /** 銃口位置。警備: pos + rotateY(muzzleOffset, yaw)。砲台: pos + gunPivotOffset + gunDirection·gunLength */
  muzzle(): Vec3 {
    if (this.kind === 'guard') return add(this.pos, rotateY(ENEMIES.guard.muzzleOffset, this.yaw));
    if (this.kind === 'turret') return addScaled(add(this.pos, ENEMIES.turret.gunPivotOffset), this.gunDirection, ENEMIES.turret.gunLength);
    return this.center();
  }

  /** 移動衝突 AABB の中心（足元 + 半径 Y） */
  moveBoxCenter(): Vec3 {
    return [this.pos[0], this.pos[1] + this.halfExtents[1], this.pos[2]];
  }
}

export class EnemyManager {
  readonly enemies: Enemy[];
  private readonly world: CollisionWorld;
  private readonly nav: NavGrid | null;
  private readonly rng: Rng;
  readonly sectorOf: (p: Vec3) => string | null;
  private readonly byIdMap = new Map<string, Enemy>();

  constructor(defs: EnemyDef[], world: CollisionWorld, nav: NavGrid | null, rng: Rng, sectorOf: (p: Vec3) => string | null) {
    this.enemies = defs.map((d) => new Enemy(d));
    this.world = world;
    this.nav = nav;
    this.rng = rng;
    this.sectorOf = sectorOf;
    for (const e of this.enemies) this.byIdMap.set(e.id, e);
  }

  reset(): void {
    for (const e of this.enemies) e.resetFromDef();
  }

  beginStep(): void {
    for (const e of this.enemies) e.prevPos = copy(e.pos);
  }

  /** 次の予定射撃時刻（予告開始も含む）。予定がなければ null */
  nextEventTime(time: number): number | null {
    let next: number | null = null;
    const consider = (t: number): void => {
      if (!Number.isFinite(t)) return;
      const tt = t < time ? time : t;
      if (next === null || tt < next) next = tt;
    };
    for (const e of this.enemies) {
      if (!e.alive || e.burstStartAt === null) continue;
      const s = statsOf(e.kind);
      if (!s) continue;
      consider(e.burstStartAt + e.shotIndex * s.burstInterval);
      if (e.shotIndex === 0) {
        const tel = e.burstStartAt - s.telegraphSeconds;
        if (tel >= time) consider(tel);
      }
    }
    return next;
  }

  /** ctx.time に到来した射撃を実行する（各発ごとに射線を再確認） */
  fireDue(ctx: EnemyContext): void {
    for (const e of this.enemies) {
      if (!e.alive || e.burstStartAt === null) continue;
      const s = statsOf(e.kind);
      if (!s) continue;
      let guard = 0;
      while (e.burstStartAt !== null && guard++ < 64) {
        const shotTime = e.burstStartAt + e.shotIndex * s.burstInterval;
        if (shotTime > ctx.time + TIME_EPS) break;
        this.tryShot(e, s, ctx);
        e.shotIndex++;
        if (e.shotIndex >= s.burstCount) {
          // バースト完了: 次の開始は前の開始 + 周期（予告は周期に含まれる）
          e.nextBurstStartAt = e.burstStartAt + s.burstPeriod;
          e.burstStartAt = e.nextBurstStartAt;
          e.shotIndex = 0;
        }
      }
    }
  }

  /** 索敵・記憶・スケジュール・移動・予告状態・target の等速移動 */
  integrate(h: number, ctx: EnemyContext): void {
    if (!(h > 0)) return;
    const starts: Vec3[] = this.enemies.map((e) => copy(e.pos));
    for (const e of this.enemies) {
      if (!e.alive) continue;
      if (e.kind === 'target') {
        const v = e.def.velocity ?? [0, 0, 0];
        e.pos = addScaled(e.pos, v, h);
        e.vel = copy(v);
        continue;
      }
      const s = statsOf(e.kind);
      if (!s) continue;
      this.updatePerception(e, s, ctx);
      if (e.kind === 'guard') this.moveGuard(e, h, ctx);
      else this.turnTurret(e, h, ctx);
      this.updateTelegraph(e, s, ctx.time + h, ctx.events);
    }
    this.separateGuards(h, starts);
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i];
      if (!e.alive || e.kind === 'target') continue;
      if (e.kind === 'guard') e.vel = scale(sub(e.pos, starts[i]), 1 / h);
      else e.vel = [0, 0, 0];
    }
  }

  damage(id: string, amount: number): { killed: boolean; enemy: Enemy } | null {
    const e = this.byIdMap.get(id);
    if (!e || !e.alive) return null;
    e.hp -= amount;
    if (e.hp <= 0) {
      e.hp = 0;
      e.alive = false;
      e.telegraphing = false;
      e.hasLineOfSight = false;
      e.burstStartAt = null;
      return { killed: true, enemy: e };
    }
    return { killed: false, enemy: e };
  }

  byId(id: string): Enemy | undefined {
    return this.byIdMap.get(id);
  }

  targetInfos(): TargetInfo[] {
    return this.enemies.map((e) => this.infoOf(e));
  }

  targetInfo(id: string): TargetInfo | null {
    const e = this.byIdMap.get(id);
    return e ? this.infoOf(e) : null;
  }

  hittables(): HittableSphere[] {
    const out: HittableSphere[] = [];
    for (const e of this.enemies) {
      if (!e.alive) continue;
      out.push({ id: e.id, prevCenter: add(e.prevPos, e.centerOffset), center: e.center(), radius: e.radius, alive: true });
    }
    return out;
  }

  views(): EnemyView[] {
    return this.enemies.map((e) => ({
      id: e.id,
      kind: e.kind,
      position: copy(e.pos),
      yaw: e.yaw,
      gunDirection: copy(e.gunDirection),
      alive: e.alive,
      telegraphing: e.telegraphing,
      alert: e.alert,
      isGateControl: e.def.isGateControl,
      hp: e.hp,
      maxHp: e.maxHp,
      center: e.center(),
      radius: e.radius,
    }));
  }

  aliveCount(): number {
    let n = 0;
    for (const e of this.enemies) if (e.alive) n++;
    return n;
  }

  // -------------------------------------------------------------------------
  // 索敵・記憶・スケジュール
  // -------------------------------------------------------------------------

  private infoOf(e: Enemy): TargetInfo {
    return { id: e.id, alive: e.alive, center: e.center(), velocity: copy(e.vel), radius: e.radius };
  }

  /**
   * 射線と発射の起点。通常は銃口。銃口が遮蔽物の中にある場合（壁際に初期配置された砲台の砲身先端、
   * 壁に斜めに押し付いた警備ロボットなど）は砲塔の回転中心／機体中心を使い、永久に盲目にならないようにする。
   */
  private fireOrigin(e: Enemy, world: CollisionWorld): Vec3 {
    const m = e.muzzle();
    if (!world.boxOverlaps(m, MUZZLE_PROBE_HALF)) return m;
    if (e.kind === 'turret') return add(e.pos, ENEMIES.turret.gunPivotOffset);
    return e.center();
  }

  private canSee(e: Enemy, s: CombatStats, ctx: EnemyContext): boolean {
    const p = ctx.player;
    if (!p.alive) return false;
    if (distance(e.center(), p.center) > s.detectRange) return false;
    return !ctx.world.segmentBlocked(this.fireOrigin(e, ctx.world), p.center);
  }

  private updatePerception(e: Enemy, s: CombatStats, ctx: EnemyContext): void {
    const time = ctx.time;
    const wasVisible = e.hasLineOfSight;
    const visible = this.canSee(e, s, ctx);
    e.hasLineOfSight = visible;
    if (visible) {
      const p = ctx.player;
      e.alert = true;
      e.lastSeenPos = copy(p.center);
      e.lastSeenFeet = copy(p.feet);
      e.lastSeenVel = copy(p.velocity);
      e.lastSeenAt = time;
      if (!wasVisible) {
        if (e.burstStartAt === null) {
          // 初回発見（この警戒期間で未射撃）は firstShotDelay、再露出は保持した時刻と予告の両方を満たす
          const b = e.nextBurstStartAt === null ? time + s.firstShotDelay : Math.max(e.nextBurstStartAt, time + s.telegraphSeconds);
          e.burstStartAt = b;
          e.nextBurstStartAt = b;
          e.shotIndex = 0;
        }
        if (e.kind === 'guard') {
          this.shareObservation(e);
          e.lastShareAt = time;
        }
      } else if (e.kind === 'guard' && (e.lastShareAt === null || time - e.lastShareAt >= SHARE_INTERVAL)) {
        this.shareObservation(e);
        e.lastShareAt = time;
      }
    } else if (e.alert) {
      if (e.lastSeenAt !== null && time - e.lastSeenAt > s.memorySeconds) {
        this.forget(e);
      } else if (e.burstStartAt !== null && e.shotIndex === 0) {
        // 未開始のバーストは取り消し（nextBurstStartAt は保持）。進行中のバーストは各発で射線確認する
        e.burstStartAt = null;
      }
    }
  }

  private forget(e: Enemy): void {
    e.alert = false;
    e.lastSeenPos = null;
    e.lastSeenFeet = null;
    e.lastSeenVel = null;
    e.lastSeenAt = null;
    e.burstStartAt = null;
    e.nextBurstStartAt = null;
    e.shotIndex = 0;
    e.telegraphedBurst = null;
    e.lastShareAt = null;
    this.clearPath(e);
    e.strafeFlipAt = null;
  }

  private clearPath(e: Enemy): void {
    e.path = null;
    e.pathIndex = 0;
    e.pathGoal = null;
    e.pathComputedAt = null;
    e.pathReached = false;
    e.pathHitWall = false;
  }

  /** 認識した警備ロボットから、経路距離 ≤ shareRange の味方警備ロボットへ最後の確認位置を共有 */
  private shareObservation(e: Enemy): void {
    if (e.lastSeenPos === null || e.lastSeenFeet === null || e.lastSeenAt === null) return;
    const range = ENEMIES.guard.shareRange;
    for (const other of this.enemies) {
      if (other === e || !other.alive || other.kind !== 'guard') continue;
      if (other.hasLineOfSight) continue; // 自分の観測を優先
      if (distanceXZ(e.pos, other.pos) > range) continue;
      if (this.nav) {
        if (this.nav.pathDistance(e.pos, other.pos, range) === null) continue;
      } else if (distance(e.pos, other.pos) > range) {
        continue;
      }
      other.alert = true;
      other.lastSeenPos = copy(e.lastSeenPos);
      other.lastSeenFeet = copy(e.lastSeenFeet);
      other.lastSeenVel = e.lastSeenVel ? copy(e.lastSeenVel) : [0, 0, 0];
      other.lastSeenAt = e.lastSeenAt;
      this.clearPath(other);
    }
  }

  private updateTelegraph(e: Enemy, s: CombatStats, tEnd: number, events: SimEvent[]): void {
    const b = e.burstStartAt;
    if (b === null) {
      e.telegraphing = false;
      return;
    }
    const start = b - s.telegraphSeconds;
    const end = b + (s.burstCount - 1) * s.burstInterval;
    e.telegraphing = tEnd >= start - TIME_EPS && tEnd < end + TIME_EPS;
    if (e.telegraphing && e.telegraphedBurst !== b) {
      e.telegraphedBurst = b;
      events.push({ type: 'enemyTelegraph', enemyId: e.id });
    }
  }

  // -------------------------------------------------------------------------
  // 射撃
  // -------------------------------------------------------------------------

  private tryShot(e: Enemy, s: CombatStats, ctx: EnemyContext): void {
    const p = ctx.player;
    if (!p.alive) return;
    if (distance(e.center(), p.center) > s.detectRange) return;
    const muzzle = this.fireOrigin(e, ctx.world);
    if (ctx.world.segmentBlocked(muzzle, p.center)) return;
    const r = sub(p.center, muzzle);
    const v = p.velocity;
    const sol = solveLinearLead(r, v, s.bulletSpeed, s.leadMaxSeconds);
    const t = sol ? sol.t : Math.min(length(r) / s.bulletSpeed, s.leadMaxSeconds);
    const aim = addScaled(p.center, v, t);
    const exact = normalize(sub(aim, muzzle));
    if (exact[0] === 0 && exact[1] === 0 && exact[2] === 0) return;
    const dir = this.perturb(exact, degToRad(s.aimSpreadDeg));
    e.gunDirection = dir;
    ctx.projectiles.spawnEnemyBullet(copy(muzzle), copy(dir), s.bulletSpeed, s.damage, s.bulletLifetime, e.id, ctx.time);
    e.shotsFired++;
    e.lastShotAt = ctx.time;
    ctx.events.push({ type: 'enemyFire', enemyId: e.id, muzzle: copy(muzzle), direction: copy(dir) });
  }

  /** 方向 dir を最大 maxAngle [rad] だけ乱数で振る（角度・回転位相ともに一様） */
  private perturb(dir: Vec3, maxAngle: number): Vec3 {
    const ang = this.rng.range(0, maxAngle);
    const roll = this.rng.range(0, Math.PI * 2);
    const ref: Vec3 = Math.abs(dir[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u = normalize(cross(dir, ref));
    const w = cross(dir, u);
    const lateral = add(scale(u, Math.cos(roll)), scale(w, Math.sin(roll)));
    return normalize(add(scale(dir, Math.cos(ang)), scale(lateral, Math.sin(ang))));
  }

  // -------------------------------------------------------------------------
  // 移動
  // -------------------------------------------------------------------------

  private turnTurret(e: Enemy, h: number, ctx: EnemyContext): void {
    const target = e.hasLineOfSight ? ctx.player.center : e.lastSeenPos;
    if (!target) return;
    const pivot = add(e.pos, ENEMIES.turret.gunPivotOffset);
    const want = normalize(sub(target, pivot));
    if (want[0] === 0 && want[1] === 0 && want[2] === 0) return;
    e.gunDirection = normalize(rotateToward(e.gunDirection, want, GUN_TURN_RATE * h));
    e.yaw = yawFromDirection(e.gunDirection);
  }

  private moveGuard(e: Enemy, h: number, ctx: EnemyContext): void {
    const g = ENEMIES.guard;
    const time = ctx.time;
    let desired: Vec3 = [0, 0, 0];
    let strafing = false;
    let retreating = false;
    // 移動判断用の射線にはヒステリシスを設ける（扉の縁などで射線が明滅しても追跡/後退を交互に繰り返さない）。
    // 射撃判断（hasLineOfSight）はそのまま毎ステップの実射線を使う
    // 射線の取得は即座に反映し、喪失だけを短時間保持する（初動や側方移動の開始は遅らせない）
    if (e.hasLineOfSight) {
      e.moveLos = true;
      e.moveLosLostAt = null;
    } else {
      if (e.moveLosLostAt === null) e.moveLosLostAt = time;
      if (time - e.moveLosLostAt >= MOVE_LOS_HYSTERESIS) e.moveLos = false;
    }
    const moveLos = e.moveLos;
    if (e.alert) {
      const targetCenter = moveLos && e.hasLineOfSight ? ctx.player.center : e.lastSeenPos;
      const targetFeet = moveLos && e.hasLineOfSight ? ctx.player.feet : e.lastSeenFeet;
      if (targetCenter && targetFeet) {
        const toTarget = xzDirection(e.pos, targetCenter);
        const d = distanceXZ(e.pos, targetCenter);
        if (toTarget[0] !== 0 || toTarget[2] !== 0) {
          e.yaw = yawFromDirection(toTarget);
          const want = normalize(sub(targetCenter, e.muzzle()));
          if (want[0] !== 0 || want[1] !== 0 || want[2] !== 0) e.gunDirection = normalize(rotateToward(e.gunDirection, want, GUN_TURN_RATE * h));
        }
        // 経路の末尾に着いても目標に届かない（別の床面・到達不能）場合は回り込み（側方移動）に切り替える
        const pursue = (): void => {
          const dir = this.steerAlongPath(e, targetFeet, time);
          if (dir) {
            desired = scale(dir, g.approachSpeed);
          } else {
            desired = this.strafeVelocity(e, toTarget, d, time);
            strafing = true;
          }
        };
        if (moveLos) {
          if (d > g.farDistance) {
            pursue();
          } else if (d >= g.strafeDistance) {
            // 側方移動は射線を変えるためのもので、射線を失う方向へは動かない
            const playerCenter = ctx.player.center;
            const origin = this.fireOrigin(e, ctx.world);
            const keepsLos = (v: Vec3): boolean => !ctx.world.segmentBlocked(addScaled(origin, v, STRAFE_LOS_LOOKAHEAD), playerCenter);
            desired = this.strafeVelocity(e, toTarget, d, time, keepsLos);
            strafing = true;
          } else if (d < g.retreatDistance) {
            if (time < e.retreatBlockedUntil) {
              // 後退方向が壁で塞がれている: 側方移動で距離を取り直す
              desired = this.strafeVelocity(e, toTarget, d, time);
              strafing = true;
            } else {
              desired = scale(toTarget, -g.retreatSpeed);
              retreating = true;
            }
          }
          // retreatDistance〜strafeDistance: 停止（微調整なし）
        } else if (d > FLANK_DISTANCE) {
          // 射線喪失: 直ちに最後の確認位置へ（経路）
          pursue();
        } else {
          // 最後の確認位置付近で射線なし: 回り込み（側方移動）
          desired = this.strafeVelocity(e, toTarget, d, time);
          strafing = true;
        }
      }
    }
    // 重力と衝突移動（滑り）
    e.vy -= g.gravity * h;
    const delta: Vec3 = [desired[0] * h, e.vy * h, desired[2] * h];
    const res = ctx.world.moveBox(e.moveBoxCenter(), e.halfExtents, delta);
    e.pos = [res.position[0], res.position[1] - e.halfExtents[1], res.position[2]];
    if (res.hitNegY) {
      e.vy = 0;
      e.grounded = true;
    } else {
      e.grounded = false;
      if (res.hitPosY && e.vy > 0) e.vy = 0;
    }
    const wallHit = res.hitNegX || res.hitPosX || res.hitNegZ || res.hitPosZ;
    if (wallHit) {
      if (retreating) {
        // 後退で壁に当たった: しばらく側方移動へ切り替える（壁に押し付き続けない）
        e.retreatBlockedUntil = time + RETREAT_BLOCKED_SECONDS;
        e.strafeSide = -e.strafeSide;
      } else if (strafing) {
        e.strafeSide = -e.strafeSide;
        e.strafeFlipAt = time + this.rng.range(STRAFE_FLIP_MIN, STRAFE_FLIP_MAX);
      } else if (e.path) {
        // 経路追従中に壁へ当たった: 次の再計算機会（PATH_MIN_RECOMPUTE_SECONDS 以降）で経路を引き直す
        e.pathHitWall = true;
      }
    }
  }

  /**
   * 側方移動速度（プレイヤー方向に垂直。左右は周期的に切り替え、距離帯の中央へ僅かに寄せる）。
   * keepsLos を渡した場合、その側で射線を失うなら反転し、両側で失うなら停止する（その場で撃つ）。
   */
  private strafeVelocity(e: Enemy, toTarget: Vec3, d: number, time: number, keepsLos?: (v: Vec3) => boolean): Vec3 {
    const g = ENEMIES.guard;
    if (e.strafeFlipAt === null) {
      e.strafeFlipAt = time + this.rng.range(STRAFE_FLIP_MIN, STRAFE_FLIP_MAX);
    } else if (time >= e.strafeFlipAt) {
      e.strafeSide = -e.strafeSide;
      e.strafeFlipAt = time + this.rng.range(STRAFE_FLIP_MIN, STRAFE_FLIP_MAX);
    }
    const mid = (g.strafeDistance + g.farDistance) / 2;
    const halfBand = (g.farDistance - g.strafeDistance) / 2;
    const radial = Math.max(-1, Math.min(1, (d - mid) / halfBand)) * STRAFE_RADIAL_WEIGHT;
    const velocityFor = (side: number): Vec3 => {
      const perp: Vec3 = [-toTarget[2] * side, 0, toTarget[0] * side];
      return scale(normalize(addScaled(perp, toTarget, radial)), g.strafeSpeed);
    };
    let v = velocityFor(e.strafeSide);
    if (keepsLos && !keepsLos(v)) {
      e.strafeSide = -e.strafeSide;
      e.strafeFlipAt = time + this.rng.range(STRAFE_FLIP_MIN, STRAFE_FLIP_MAX);
      v = velocityFor(e.strafeSide);
      if (!keepsLos(v)) return [0, 0, 0];
    }
    return v;
  }

  /**
   * ナビ経路（あれば）に沿って goal（足元位置）へ向かう水平単位ベクトル。nav がなければ直進。
   * 目標が別の床面・空中・歩行不能セル上でも自分の床面へ投影した経路を使う。
   * 経路の末尾に着いても目標に届かない（到達不能・別の床面）場合は null（呼び出し側で回り込みへ）。
   * 再計算は PATH_RECOMPUTE_SECONDS ごと、または目標の移動・壁接触時（ただし PATH_MIN_RECOMPUTE_SECONDS 以上の間隔）。
   */
  private steerAlongPath(e: Enemy, goal: Vec3, time: number): Vec3 | null {
    const nav = this.nav;
    if (!nav) return xzDirection(e.pos, goal);
    const since = e.pathComputedAt === null ? Infinity : time - e.pathComputedAt;
    const drifted = e.pathGoal === null || distanceXZ(goal, e.pathGoal) > PATH_GOAL_TOLERANCE;
    const stale = since >= PATH_RECOMPUTE_SECONDS || (since >= PATH_MIN_RECOMPUTE_SECONDS && (drifted || e.pathHitWall));
    if (stale) {
      const res = nav.findPathToward(e.pos, goal);
      e.path = res ? res.path : null;
      e.pathIndex = 0;
      e.pathGoal = copy(goal);
      e.pathComputedAt = time;
      e.pathHitWall = false;
      e.pathReached = res !== null && res.reached && distanceXZ(res.path[res.path.length - 1], goal) <= nav.cellSize * PATH_ARRIVAL_CELLS;
    }
    const path = e.path;
    if (!path) return xzDirection(e.pos, goal); // 格子外など: 直進
    const reach = Math.max(1, nav.cellSize * 0.75);
    while (e.pathIndex < path.length && distanceXZ(e.pos, path[e.pathIndex]) < reach) e.pathIndex++;
    if (e.pathIndex < path.length) return xzDirection(e.pos, path[e.pathIndex]);
    // 経路の末尾: 目標に届く経路なら残りは直進、届かないなら回り込み
    return e.pathReached ? xzDirection(e.pos, goal) : null;
  }

  /**
   * 警備ロボットの簡易分離。警備同士は XZ 距離 < SEPARATION_DISTANCE なら互いに押し離し、
   * 生存中の固定砲台からは TURRET_CLEARANCE まで押し出す（砲台は衝突ワールドに無いので通り抜けを防ぐ）。
   * 押し戻し量は 1 ステップあたり上限付き（実位置の変化なので報告速度に含まれるが、移動速度を大きく越えない）。
   * 壁には moveBox で止まる。
   */
  private separateGuards(h: number, starts: Vec3[]): void {
    const n = this.enemies.length;
    const maxPush = SEPARATION_SPEED * h;
    const maxTurretPush = (ENEMIES.guard.approachSpeed + SEPARATION_SPEED) * h;
    for (let i = 0; i < n; i++) {
      const a = this.enemies[i];
      if (!a.alive || a.kind !== 'guard') continue;
      for (let j = i + 1; j < n; j++) {
        const b = this.enemies[j];
        if (!b.alive || b.kind !== 'guard') continue;
        if (Math.abs(a.pos[1] - b.pos[1]) > a.halfExtents[1] + b.halfExtents[1]) continue;
        const d = distanceXZ(a.pos, b.pos);
        if (d >= SEPARATION_DISTANCE) continue;
        let dir = xzDirection(b.pos, a.pos);
        if (dir[0] === 0 && dir[2] === 0) dir = forwardFromYaw(a.yaw);
        const push = Math.min((SEPARATION_DISTANCE - d) / 2, maxPush);
        this.pushGuard(a, dir, push);
        this.pushGuard(b, dir, -push);
      }
      // 固定砲台（静止）からの押し出し
      for (let j = 0; j < n; j++) {
        const t = this.enemies[j];
        if (!t.alive || t.kind !== 'turret') continue;
        if (Math.abs(a.pos[1] - t.pos[1]) > a.halfExtents[1] + t.halfExtents[1]) continue;
        const d = distanceXZ(a.pos, t.pos);
        if (d >= TURRET_CLEARANCE) continue;
        let dir = xzDirection(t.pos, a.pos);
        if (dir[0] === 0 && dir[2] === 0) dir = forwardFromYaw(a.yaw);
        // 正面から砲台へ向かっている（押し出しが移動と正反対）なら側方へ 45° ずらして回り込ませる
        const move = sub(a.pos, starts[i]);
        const moveLen = Math.hypot(move[0], move[2]);
        if (moveLen > 1e-9 && dot(dir, move) / moveLen < -0.9) {
          const perp: Vec3 = [-dir[2] * a.strafeSide, 0, dir[0] * a.strafeSide];
          dir = normalize(add(dir, perp));
        }
        this.pushGuard(a, dir, Math.min(TURRET_CLEARANCE - d, maxTurretPush));
      }
    }
  }

  private pushGuard(e: Enemy, dir: Vec3, amount: number): void {
    if (amount === 0) return;
    const r = this.world.moveBox(e.moveBoxCenter(), e.halfExtents, scale(dir, amount));
    e.pos = [r.position[0], r.position[1] - e.halfExtents[1], r.position[2]];
  }
}
