/**
 * プレイヤー機体: 水平移動（通常/グライド/QB）、垂直運動（ジャンプ/飛行/重力）、EN 管理、衝突。
 * 仕様 §6, §7 を実装する。Three.js・DOM に依存しない。
 *
 * 時間の扱い:
 * - 全ての変化は刻み幅 h と開始時刻 time に基づく（描画頻度非依存）。
 * - QB 噴射終了・EN 回復開始・飛行開始・飛行 EN 枯渇は nextEventTime() で統括側に分割点を知らせるが、
 *   分割されずに区間をまたいだ場合も integrate() 内で区間を分けて厳密に処理する。
 * - 目標水平速度への到達は区分線形の解析積分で厳密に扱う（分割不要）。
 */
import { DEFAULT_WEAPON, PLAYER, WEAPONS, computeEffectiveStats, type EffectiveStats } from '../params';
import type {
  CollisionWorld,
  HorizontalMode,
  InputFrame,
  Loadout,
  MoveResult,
  SimEvent,
  Vec2,
  Vec3,
  VerticalMode,
  Weapon,
} from '../types';
import { add, approachVector, copy, forwardFromYaw, rightFromYaw, rotateY } from './vec';

/** 時刻比較の丸め誤差許容 [s] */
const TIME_EPS = 1e-9;
/** EN 比較の丸め誤差許容 */
const EN_EPS = 1e-9;
/** 接地プローブの下向き距離 [m] */
const GROUND_PROBE = 0.05;

/** 入力軸の値を有限かつ [-1, 1] に正規化する（NaN/Infinity は 0 扱い） */
function sanitizeAxis(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

/** 入力（WASD）をカメラ水平面の単位方向へ変換する。入力がなければ null */
function inputDirection(input: InputFrame, cameraYaw: number): Vec2 | null {
  const mf = sanitizeAxis(input.moveForward);
  const mr = sanitizeAxis(input.moveRight);
  if (mf === 0 && mr === 0) return null;
  const f = forwardFromYaw(cameraYaw);
  const r = rightFromYaw(cameraYaw);
  const x = f[0] * mf + r[0] * mr;
  const z = f[2] * mf + r[2] * mr;
  const l = Math.hypot(x, z);
  if (l <= 1e-12) return null;
  return [x / l, z / l];
}

export class Player {
  readonly loadout: Loadout;
  readonly stats: EffectiveStats;

  /** 足元位置 */
  pos: Vec3 = [0, 0, 0];
  vel: Vec3 = [0, 0, 0];
  yaw = 0;
  grounded = true;
  hp: number = PLAYER.maxHp;
  en: number;

  weapon: Weapon = DEFAULT_WEAPON;
  ammo: { machinegun: number; missile: number } = { machinegun: WEAPONS.machinegun.ammo, missile: WEAPONS.missile.ammo };

  horizontalMode: HorizontalMode = 'walk';
  verticalMode: VerticalMode = 'grounded';
  glideEnabled = false;
  /** 保存された水平移動方向 [x, z]（単位。なければ [0, 0]） */
  desiredDir: Vec2 = [0, 0];

  qbSuccessfulCount = 0;
  qbLastStartedAt: number | null = null;
  qbImpulseRemaining = 0;
  lastEnSpentAt: number | null = null;
  /** 飛行推進中 */
  thrusting = false;

  /** Space の押下開始時刻（離されていれば null。着地で解除され、飛行には押し直しが必要） */
  private spaceHeldSince: number | null = null;
  /**
   * reset() 直後は接地状態をワールドで検証していない。最初の integrate() のプローブで確定する。
   * 未検証のうちに来た接地ジャンプ要求は pendingJump に保留し、検証後に接地していれば実行する。
   */
  private groundedVerified = false;
  private pendingJump = false;

  constructor(loadout: Loadout) {
    this.loadout = { ...loadout };
    this.stats = computeEffectiveStats(this.loadout);
    this.en = this.stats.maxEn;
  }

  get alive(): boolean {
    return this.hp > 0;
  }

  private get legMul(): number {
    return this.stats.horizontalSpeedMultiplier;
  }

  /** HP/EN/弾/全モード/タイマーを初期化する */
  reset(spawnPos: Vec3, yaw: number): void {
    this.pos = copy(spawnPos);
    this.vel = [0, 0, 0];
    this.yaw = yaw;
    // 出撃位置は床の上面（仕様）。実際の接地は最初の更新のプローブで検証する
    this.grounded = true;
    this.groundedVerified = false;
    this.pendingJump = false;
    this.hp = PLAYER.maxHp;
    this.en = this.stats.maxEn;
    this.weapon = DEFAULT_WEAPON;
    this.ammo = { machinegun: WEAPONS.machinegun.ammo, missile: WEAPONS.missile.ammo };
    this.horizontalMode = 'walk';
    this.verticalMode = 'grounded';
    this.glideEnabled = false;
    this.desiredDir = [0, 0];
    this.qbSuccessfulCount = 0;
    this.qbLastStartedAt = null;
    this.qbImpulseRemaining = 0;
    this.lastEnSpentAt = null;
    this.thrusting = false;
    this.spaceHeldSince = null;
  }

  // -------------------------------------------------------------------------
  // エッジ入力（フレーム先頭で一度だけ）
  // -------------------------------------------------------------------------

  /** Q/Shift/Space のエッジを処理する */
  applyEdgeInput(input: InputFrame, cameraYaw: number, time: number, events: SimEvent[]): void {
    // --- QB（Q の押下エッジ）---
    if (input.qbPressed) {
      const cooldownOk = this.qbLastStartedAt === null || time - this.qbLastStartedAt >= PLAYER.qb.cooldownSeconds - TIME_EPS;
      if (!input.ctrlDown && this.en >= PLAYER.qb.cost - EN_EPS && cooldownOk) {
        const dir = inputDirection(input, cameraYaw) ?? this.cameraForwardDir(cameraYaw);
        const speed = PLAYER.qb.speed * this.legMul;
        // 水平速度を「設定」する（加算しない）。垂直速度は変更しない
        this.vel = [dir[0] * speed, this.vel[1], dir[1] * speed];
        this.en = this.clampEn(this.en - PLAYER.qb.cost);
        this.lastEnSpentAt = time;
        this.qbLastStartedAt = time;
        this.qbImpulseRemaining = PLAYER.qb.impulseSeconds;
        this.horizontalMode = 'quickboost';
        this.desiredDir = [dir[0], dir[1]];
        this.qbSuccessfulCount++;
        events.push({ type: 'qbStart', position: copy(this.pos), direction: [dir[0], 0, dir[1]] });
      }
      // 不成立の押下は何も変えない（予約もタイマー更新もしない）
    }

    // --- Shift（グライド切り替え）: 噴射中は無視 ---
    if (input.shiftPressed && this.qbImpulseRemaining <= 0) {
      if (this.glideEnabled) {
        this.glideEnabled = false;
        this.horizontalMode = 'walk';
      } else {
        this.glideEnabled = true;
        this.horizontalMode = 'glide';
        const dir = inputDirection(input, cameraYaw) ?? this.cameraForwardDir(cameraYaw);
        this.desiredDir = [dir[0], dir[1]];
      }
    }

    // --- Space（ジャンプ / 飛行の押下開始）---
    if (input.spacePressed) {
      this.spaceHeldSince = time;
      if (this.grounded) {
        if (this.groundedVerified) {
          this.jump(events);
        } else {
          // reset() 直後で接地が未検証: 最初の更新で検証してから実行する
          this.pendingJump = true;
        }
      }
    }
    if (!input.spaceDown && !input.spacePressed) {
      this.spaceHeldSince = null;
      this.thrusting = false;
    }
    this.updateVerticalMode();
  }

  private jump(events: SimEvent[]): void {
    this.vel[1] = PLAYER.jumpSpeed;
    this.grounded = false;
    events.push({ type: 'jump', position: copy(this.pos) });
  }

  private cameraForwardDir(cameraYaw: number): Vec2 {
    const f = forwardFromYaw(cameraYaw);
    return [f[0], f[2]];
  }

  // -------------------------------------------------------------------------
  // イベント時刻
  // -------------------------------------------------------------------------

  /** 次に状態が不連続に変わる時刻（≥ time）。なければ null */
  nextEventTime(time: number, input: InputFrame): number | null {
    let next: number | null = null;
    const consider = (t: number): void => {
      if (!Number.isFinite(t) || t < time) return;
      if (next === null || t < next) next = t;
    };
    // QB 噴射終了
    if (this.qbImpulseRemaining > 0 && this.qbLastStartedAt !== null) {
      consider(this.qbLastStartedAt + PLAYER.qb.impulseSeconds);
    }
    // EN 回復開始
    if (this.grounded && this.lastEnSpentAt !== null && this.en < this.stats.maxEn) {
      const t = this.lastEnSpentAt + PLAYER.enRegenDelaySeconds;
      if (t > time) consider(t);
    }
    // 飛行（空中でのみ）
    if (!this.grounded && this.spaceHeldSince !== null && input.spaceDown && this.en > EN_EPS) {
      const startAt = this.spaceHeldSince + PLAYER.flightHoldSeconds;
      const active = this.thrusting || time + TIME_EPS >= startAt;
      if (!active) {
        consider(startAt);
      } else {
        // EN 枯渇時刻
        consider(time + this.en / PLAYER.flightEnPerSecond);
      }
    }
    return next;
  }

  // -------------------------------------------------------------------------
  // 更新
  // -------------------------------------------------------------------------

  integrate(h: number, time: number, input: InputFrame, cameraYaw: number, world: CollisionWorld, events: SimEvent[]): void {
    if (!(h > 0)) return;
    const legMul = this.legMul;
    const half = PLAYER.halfExtents;

    // reset() 後の最初の更新: 接地をワールドで検証し、保留中のジャンプを処理する
    if (!this.groundedVerified) {
      this.groundedVerified = true;
      const probe0 = world.moveBox(add(this.pos, PLAYER.hitCenterOffset), half, [0, -GROUND_PROBE, 0]);
      this.grounded = this.vel[1] <= 0 && probe0.hitNegY;
      if (this.grounded) {
        this.pos[1] = probe0.position[1] - PLAYER.hitCenterOffset[1];
        this.vel[1] = 0;
        if (this.pendingJump) this.jump(events);
      }
      this.pendingJump = false;
    }

    const groundedStart = this.grounded;
    const vOld: Vec3 = copy(this.vel);
    const endTime = time + h;

    // ---------------------------------------------------------------------
    // 水平: QB 噴射区間と通常区間に分ける
    // ---------------------------------------------------------------------
    let impulseT = 0;
    let finalizeImpulse = false;
    if (this.qbImpulseRemaining > 0 && this.qbLastStartedAt !== null) {
      const impulseEnd = this.qbLastStartedAt + PLAYER.qb.impulseSeconds;
      impulseT = Math.min(h, Math.max(0, impulseEnd - time));
      if (impulseEnd - endTime <= TIME_EPS) {
        // この更新で噴射が終わる
        finalizeImpulse = true;
        impulseT = Math.min(h, impulseT);
      }
    }
    const rest = h - impulseT;
    let vxNew = vOld[0];
    let vzNew = vOld[2];
    /** 通常区間のうち、速度が線形に変化する時間（以後は目標速度で等速） */
    let rampT = rest;

    if (impulseT > 0 || (this.qbImpulseRemaining > 0 && !finalizeImpulse)) {
      this.horizontalMode = 'quickboost';
    }
    if (finalizeImpulse) {
      // 噴射終了: 必ずグライドへ。速度ベクトルはそのまま引き継ぐ
      this.qbImpulseRemaining = 0;
      this.glideEnabled = true;
      this.horizontalMode = 'glide';
    } else if (this.qbImpulseRemaining > 0 && this.qbLastStartedAt !== null) {
      this.qbImpulseRemaining = Math.max(0, this.qbLastStartedAt + PLAYER.qb.impulseSeconds - endTime);
    }

    if (rest > 1e-12 && this.qbImpulseRemaining <= 0) {
      const inDir = inputDirection(input, cameraYaw);
      let target: Vec2 | null = [0, 0];
      let rate: number;
      if (input.ctrlDown) {
        // ブレーキ: グライド解除、目標 0（WASD より優先）
        this.glideEnabled = false;
        this.horizontalMode = 'walk';
        target = [0, 0];
        rate = PLAYER.walkAccel * legMul;
      } else if (this.glideEnabled) {
        this.horizontalMode = 'glide';
        if (inDir) this.desiredDir = [inDir[0], inDir[1]];
        const base = groundedStart ? PLAYER.glideGroundSpeed : PLAYER.airSpeed;
        const speed = base * legMul;
        target = [this.desiredDir[0] * speed, this.desiredDir[1] * speed];
        rate = ((PLAYER.qb.speed - base) / PLAYER.qb.decelSeconds) * legMul;
      } else {
        this.horizontalMode = 'walk';
        rate = PLAYER.walkAccel * legMul;
        if (inDir) {
          const speed = (groundedStart ? PLAYER.walkSpeed : PLAYER.airSpeed) * legMul;
          target = [inDir[0] * speed, inDir[1] * speed];
        } else if (groundedStart) {
          target = [0, 0];
        } else {
          // 空中で入力なし: 慣性（現在速度を保持）
          target = null;
        }
      }
      if (target !== null) {
        const v = approachVector([vOld[0], 0, vOld[2]], [target[0], 0, target[1]], rate * rest);
        vxNew = v[0];
        vzNew = v[2];
        // 目標到達時刻（区間内なら以後は等速）。速度は目標へ直線的に近づくので各成分は区分線形
        const dist = Math.hypot(target[0] - vOld[0], target[1] - vOld[2]);
        rampT = rate > 0 ? Math.min(rest, dist / rate) : rest;
      }
    }
    // 噴射区間は等速、通常区間は「線形変化区間の台形則 + 到達後の等速」（区分線形速度の厳密積分）
    const dx = vOld[0] * impulseT + ((vOld[0] + vxNew) / 2) * rampT + vxNew * (rest - rampT);
    const dz = vOld[2] * impulseT + ((vOld[2] + vzNew) / 2) * rampT + vzNew * (rest - rampT);

    // ---------------------------------------------------------------------
    // 垂直: 重力 / 飛行推進（区間 [a, b] のみ推進）。推進は空中でのみ開始する
    // ---------------------------------------------------------------------
    if (!input.spaceDown) {
      this.spaceHeldSince = null;
      this.thrusting = false;
    }
    let a = h;
    let b = h;
    if (!groundedStart && this.spaceHeldSince !== null && input.spaceDown && this.en > EN_EPS) {
      let ra = this.spaceHeldSince + PLAYER.flightHoldSeconds - time;
      if (ra < TIME_EPS) ra = 0;
      if (ra < h) {
        const dur = Math.min(h - ra, this.en / PLAYER.flightEnPerSecond);
        a = ra;
        b = ra + dur;
      }
    }
    let vy = vOld[1];
    let dy = 0;
    let airborne = !groundedStart;
    let thrustHappened = false;
    const gravitySegment = (s: number): void => {
      if (s <= 0) return;
      if (!airborne && vy <= 0) {
        vy = 0;
        return;
      }
      const vn = vy - PLAYER.gravity * s;
      dy += ((vy + vn) / 2) * s;
      vy = vn;
    };
    gravitySegment(a);
    if (b > a) {
      const dur = b - a;
      vy = PLAYER.flightRiseSpeed;
      dy += PLAYER.flightRiseSpeed * dur;
      this.en = this.clampEn(this.en - PLAYER.flightEnPerSecond * dur);
      this.lastEnSpentAt = time + b;
      airborne = true;
      thrustHappened = true;
    }
    gravitySegment(h - b);
    this.thrusting = thrustHappened && h - b <= 1e-12 && this.en > EN_EPS && input.spaceDown;

    // ---------------------------------------------------------------------
    // 衝突移動
    // ---------------------------------------------------------------------
    const center = add(this.pos, PLAYER.hitCenterOffset);
    const res: MoveResult = world.moveBox(center, half, [dx, dy, dz]);
    this.pos = [res.position[0] - PLAYER.hitCenterOffset[0], res.position[1] - PLAYER.hitCenterOffset[1], res.position[2] - PLAYER.hitCenterOffset[2]];
    if (res.hitPosX || res.hitNegX) vxNew = 0;
    if (res.hitPosZ || res.hitNegZ) vzNew = 0;
    if (res.hitPosY) vy = Math.min(vy, 0);
    if (res.hitNegY) vy = 0;
    // 接地プローブ: 下向き 0.05 m 以内に床があれば接地とし、その接触位置へ寄せる
    // （移動が床へ届かなかった遅い降下や、床のわずか上の出現でも実際の接触高さに揃える）
    const probe = world.moveBox(res.position, half, [0, -GROUND_PROBE, 0]);
    const grounded = vy <= 0 && probe.hitNegY;
    if (grounded) {
      this.pos[1] = probe.position[1] - PLAYER.hitCenterOffset[1];
      vy = 0;
    }
    if (grounded && !this.grounded) {
      events.push({ type: 'landed', position: copy(this.pos) });
      // 着地で飛行の押下は失効する（再び飛ぶには押し直しが必要。地上からの推進開始はしない）
      this.spaceHeldSince = null;
    }
    this.grounded = grounded;
    if (grounded) this.thrusting = false;
    this.vel = [vxNew, vy, vzNew];

    // ---------------------------------------------------------------------
    // EN 回復: 区間全体で接地、この更新で消費なし、最後の消費から 0.75 秒以上
    // ---------------------------------------------------------------------
    if (groundedStart && this.grounded && !thrustHappened && this.en < this.stats.maxEn) {
      const regenStart = this.lastEnSpentAt === null ? time : Math.max(time, this.lastEnSpentAt + PLAYER.enRegenDelaySeconds);
      const dur = endTime - regenStart;
      if (dur > 1e-12) this.en = this.clampEn(this.en + this.stats.regenPerSecond * dur);
    }

    this.updateVerticalMode();
  }

  private updateVerticalMode(): void {
    if (this.grounded) this.verticalMode = 'grounded';
    else if (this.thrusting) this.verticalMode = 'flying';
    else if (this.vel[1] > 0) this.verticalMode = 'rising';
    else this.verticalMode = 'falling';
  }

  private clampEn(v: number): number {
    if (v <= EN_EPS) return 0;
    if (v >= this.stats.maxEn) return this.stats.maxEn;
    return v;
  }

  // -------------------------------------------------------------------------
  // EN / HP
  // -------------------------------------------------------------------------

  /** EN を消費する。不足なら false（何も変えない）。費用 0 は常に成立し、回復待ち時間を更新しない */
  spendEn(amount: number, time: number): boolean {
    if (!(amount >= 0)) return false;
    if (amount === 0) return true;
    if (this.en < amount - EN_EPS) return false;
    this.en = this.clampEn(this.en - amount);
    this.lastEnSpentAt = time;
    return true;
  }

  takeDamage(amount: number): void {
    if (!(amount > 0)) return;
    this.hp = Math.max(0, this.hp - amount);
  }

  /** 今 Q を押した場合に QB が成立するか（HUD 表示用。applyEdgeInput と同じ条件） */
  canQuickBoost(time: number, ctrlDown: boolean): boolean {
    if (ctrlDown) return false;
    if (this.en < PLAYER.qb.cost - EN_EPS) return false;
    return this.qbLastStartedAt === null || time - this.qbLastStartedAt >= PLAYER.qb.cooldownSeconds - EN_EPS;
  }

  qbCooldownRemaining(time: number): number {
    if (this.qbLastStartedAt === null) return 0;
    return Math.max(0, this.qbLastStartedAt + PLAYER.qb.cooldownSeconds - time);
  }

  // -------------------------------------------------------------------------
  // 幾何
  // -------------------------------------------------------------------------

  getMuzzlePosition(): Vec3 {
    return add(this.pos, rotateY(PLAYER.muzzleOffset, this.yaw));
  }

  getHitCenter(): Vec3 {
    return add(this.pos, PLAYER.hitCenterOffset);
  }

  getHitBox(): { center: Vec3; halfExtents: Vec3 } {
    return { center: this.getHitCenter(), halfExtents: copy(PLAYER.halfExtents) };
  }
}
