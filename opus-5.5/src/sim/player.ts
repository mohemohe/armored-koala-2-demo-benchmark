// プレイヤー機体の移動（通常移動・グライド・QB・ジャンプ・飛行）とEN管理。
// 水平モード（walk/glide/quickboost）と垂直状態（grounded/rising/flying/falling）を分離して管理する。
import { GLIDE_RATE_AIR, GLIDE_RATE_GROUND, PLAYER, type EffectiveStats } from '../config';
import { forwardFromYaw, rightFromYaw, type V3 } from '../math';
import type { CollisionWorld } from './world';

export interface MoveInput {
  /** D - A */
  moveX: number;
  /** W - S */
  moveZ: number;
  yaw: number;
  spaceHeld: boolean;
  spaceEdge: boolean;
  qEdge: boolean;
  shiftEdge: boolean;
  ctrlHeld: boolean;
}

export type HorizontalMode = 'walk' | 'glide' | 'quickboost';
export type VerticalMode = 'grounded' | 'rising' | 'flying' | 'falling';
export type QbFailReason = 'en' | 'cooldown' | 'brake';

const EPS = 1e-9;

export class Player {
  pos: V3 = [0, 0, 0];
  vel: V3 = [0, 0, 0];
  grounded = true;
  hp: number = PLAYER.maxHp;
  en = 0;
  stats: EffectiveStats;

  glideEnabled = false;
  /** グライドの保存方向 [x,z]（単位ベクトル。未設定なら [0,0]） */
  glideDir: [number, number] = [0, 0];
  /** 現在の歩行入力方向（HUD/スナップショット用） */
  inputDir: [number, number] = [0, 0];

  qbImpulseRemaining = 0;
  qbDir: [number, number] = [0, 0];
  qbLastStartedAt: number | null = null;
  qbCount = 0;
  lastQbFail: { reason: QbFailReason; at: number } | null = null;

  lastEnSpentAt: number | null = null;
  /** 押下中のSpaceの押下時刻 */
  spacePressedAt: number | null = null;
  /** 直近ステップで飛行推進が働いたか */
  thrusting = false;
  lastEnShortAt: number | null = null;

  // ステップ内の一時状態
  private spentThisStep = false;
  private groundedAtStart = true;
  private impulseAtStart = false;
  private thrustOffset = 0;
  private thrustDur = 0;
  /** 移動アニメーション用：直近の実移動量 */
  lastMoveDist = 0;

  constructor(stats: EffectiveStats) {
    this.stats = stats;
    this.en = stats.maxEn;
  }

  reset(pos: V3, stats: EffectiveStats) {
    this.stats = stats;
    this.pos = [pos[0], pos[1], pos[2]];
    this.vel = [0, 0, 0];
    this.grounded = true;
    this.hp = PLAYER.maxHp;
    this.en = stats.maxEn;
    this.glideEnabled = false;
    this.glideDir = [0, 0];
    this.inputDir = [0, 0];
    this.qbImpulseRemaining = 0;
    this.qbDir = [0, 0];
    this.qbLastStartedAt = null;
    this.qbCount = 0;
    this.lastQbFail = null;
    this.lastEnSpentAt = null;
    this.spacePressedAt = null;
    this.thrusting = false;
    this.lastEnShortAt = null;
    this.lastMoveDist = 0;
  }

  get horizontalMode(): HorizontalMode {
    if (this.qbImpulseRemaining > 0) return 'quickboost';
    return this.glideEnabled ? 'glide' : 'walk';
  }

  get verticalMode(): VerticalMode {
    if (this.grounded) return 'grounded';
    if (this.thrusting) return 'flying';
    return this.vel[1] > 0 ? 'rising' : 'falling';
  }

  get desiredDirection(): [number, number] {
    if (this.qbImpulseRemaining > 0) return [this.qbDir[0], this.qbDir[1]];
    if (this.glideEnabled) return [this.glideDir[0], this.glideDir[1]];
    return [this.inputDir[0], this.inputDir[1]];
  }

  qbCooldownRemaining(now: number): number {
    if (this.qbLastStartedAt === null) return 0;
    return Math.max(0, PLAYER.qbCooldownSeconds - (now - this.qbLastStartedAt));
  }

  /** WASD をカメラ水平面の単位方向へ。入力なしは null */
  static inputToWorld(moveX: number, moveZ: number, yaw: number): [number, number] | null {
    if (moveX === 0 && moveZ === 0) return null;
    const f = forwardFromYaw(yaw);
    const r = rightFromYaw(yaw);
    const x = f[0] * moveZ + r[0] * moveX;
    const z = f[1] * moveZ + r[1] * moveX;
    const l = Math.hypot(x, z);
    if (l < 1e-9) return null;
    return [x / l, z / l];
  }

  /** ステップ開始処理とQB判定（EN優先順位1） */
  beginStep(now: number, input: MoveInput) {
    this.spentThisStep = false;
    this.groundedAtStart = this.grounded;
    this.impulseAtStart = this.qbImpulseRemaining > 0;
    this.thrustOffset = 0;
    this.thrustDur = 0;
    const dir = Player.inputToWorld(input.moveX, input.moveZ, input.yaw);
    this.inputDir = dir ? [dir[0], dir[1]] : [0, 0];

    // Space 押下（ジャンプ・飛行計時）
    if (input.spaceEdge) {
      this.spacePressedAt = now;
      if (this.grounded) {
        this.vel[1] = PLAYER.jumpVelocity;
        this.grounded = false;
      }
    }
    if (!input.spaceHeld) this.spacePressedAt = null;

    // QB（Qの押下エッジでのみ判定。予約しない）
    if (input.qEdge) {
      if (input.ctrlHeld) {
        this.lastQbFail = { reason: 'brake', at: now };
      } else if (this.qbLastStartedAt !== null && now - this.qbLastStartedAt < PLAYER.qbCooldownSeconds - EPS) {
        this.lastQbFail = { reason: 'cooldown', at: now };
      } else if (this.en < PLAYER.qbEnCost - EPS) {
        this.lastQbFail = { reason: 'en', at: now };
        this.lastEnShortAt = now;
      } else {
        this.spend(now, PLAYER.qbEnCost);
        const d = dir ?? forwardFromYaw(input.yaw);
        const sp = PLAYER.qbSpeed * this.stats.horizontalSpeedMultiplier;
        this.vel[0] = d[0] * sp;
        this.vel[2] = d[1] * sp;
        this.qbDir = [d[0], d[1]];
        this.qbImpulseRemaining = PLAYER.qbImpulseSeconds;
        this.qbLastStartedAt = now;
        this.qbCount++;
        this.lastQbFail = null;
      }
    }
  }

  /** EN を一括消費（呼び出し側で残量確認済み） */
  spend(now: number, amount: number) {
    this.en = Math.max(0, this.en - amount);
    if (this.en < 1e-9) this.en = 0;
    this.lastEnSpentAt = now;
    this.spentThisStep = true;
  }

  /** 飛行のEN連続消費（EN優先順位3）。実際に推進できる時間を確定する */
  computeFlight(now: number, dt: number, input: MoveInput) {
    this.thrustOffset = 0;
    this.thrustDur = 0;
    if (!input.spaceHeld || this.spacePressedAt === null) return;
    const startT = this.spacePressedAt + PLAYER.flightHoldSeconds;
    if (now + dt <= startT + EPS) return;
    const off = Math.max(0, startT - now);
    const avail = dt - off;
    if (avail <= EPS) return;
    if (this.en <= EPS) {
      this.lastEnShortAt = now;
      return;
    }
    const need = PLAYER.flightEnPerSecond * avail;
    let dur: number;
    if (this.en >= need - EPS) {
      dur = avail;
      this.en = Math.max(0, this.en - need);
      if (this.en < 1e-9) this.en = 0;
    } else {
      dur = this.en / PLAYER.flightEnPerSecond;
      this.en = 0;
      this.lastEnShortAt = now;
    }
    this.thrustOffset = off;
    this.thrustDur = dur;
    this.lastEnSpentAt = now + off + dur;
    this.spentThisStep = true;
  }

  /** 移動処理（水平→垂直）と EN 回復 */
  move(now: number, dt: number, input: MoveInput, world: CollisionWorld) {
    const before: V3 = [this.pos[0], this.pos[1], this.pos[2]];
    this.moveHorizontal(dt, input, world);
    this.moveVertical(dt, world);
    this.regen(now, dt);
    this.lastMoveDist = Math.hypot(this.pos[0] - before[0], this.pos[2] - before[2]);
  }

  private moveXZ(dx: number, dz: number, world: CollisionWorld) {
    const hw = PLAYER.halfWidth,
      h = PLAYER.height;
    if (dx !== 0) {
      const got = world.sweepAxis(this.pos, hw, h, 0, dx);
      if (Math.abs(got - dx) > 1e-7) this.vel[0] = 0;
    }
    if (dz !== 0) {
      const got = world.sweepAxis(this.pos, hw, h, 2, dz);
      if (Math.abs(got - dz) > 1e-7) this.vel[2] = 0;
    }
  }

  private moveHorizontal(dt: number, input: MoveInput, world: CollisionWorld) {
    const mult = this.stats.horizontalSpeedMultiplier;
    let remaining = dt;

    // QB噴射：速度一定（衝突で失われた成分は再付与しない）
    if (this.qbImpulseRemaining > 0) {
      const tau = Math.min(this.qbImpulseRemaining, remaining);
      this.moveXZ(this.vel[0] * tau, this.vel[2] * tau, world);
      this.qbImpulseRemaining -= tau;
      remaining -= tau;
      if (this.qbImpulseRemaining <= EPS) {
        this.qbImpulseRemaining = 0;
        // 噴射終了：必ずグライドへ移行し、速度ベクトルをそのまま引き継ぐ
        this.glideEnabled = true;
        this.glideDir = [this.qbDir[0], this.qbDir[1]];
      }
    }
    if (remaining <= EPS) return;

    const dir = this.inputDir[0] !== 0 || this.inputDir[1] !== 0 ? this.inputDir : null;
    let tx = 0,
      tz = 0,
      rate = 0;
    if (input.ctrlHeld) {
      // ブレーキ：グライド解除、通常移動状態で0へ減速（WASDより優先）
      this.glideEnabled = false;
      rate = PLAYER.walkAccel * mult;
    } else {
      if (input.shiftEdge && !this.impulseAtStart) {
        if (!this.glideEnabled) {
          this.glideEnabled = true;
          const d = dir ?? forwardFromYaw(input.yaw);
          this.glideDir = [d[0], d[1]];
        } else {
          this.glideEnabled = false;
        }
      }
      const ground = this.grounded;
      if (this.glideEnabled) {
        if (dir) this.glideDir = [dir[0], dir[1]];
        const sp = (ground ? PLAYER.glideSpeedGround : PLAYER.airSpeed) * mult;
        tx = this.glideDir[0] * sp;
        tz = this.glideDir[1] * sp;
        rate = (ground ? GLIDE_RATE_GROUND : GLIDE_RATE_AIR) * mult;
      } else {
        const sp = (ground ? PLAYER.walkSpeed : PLAYER.airSpeed) * mult;
        if (dir) {
          tx = dir[0] * sp;
          tz = dir[1] * sp;
        }
        rate = (ground ? PLAYER.walkAccel : PLAYER.walkAccel * 0.5) * mult;
      }
    }

    // 目標速度へ一定加速度で近づける（解析的積分・到達時刻で分割・越えない）
    const vx = this.vel[0],
      vz = this.vel[2];
    const ddx = tx - vx,
      ddz = tz - vz;
    const dist = Math.hypot(ddx, ddz);
    let px: number, pz: number;
    if (dist < 1e-9 || rate <= 0) {
      px = vx * remaining;
      pz = vz * remaining;
    } else {
      const ax = (ddx / dist) * rate,
        az = (ddz / dist) * rate;
      const tReach = dist / rate;
      if (tReach >= remaining) {
        px = vx * remaining + 0.5 * ax * remaining * remaining;
        pz = vz * remaining + 0.5 * az * remaining * remaining;
        this.vel[0] = vx + ax * remaining;
        this.vel[2] = vz + az * remaining;
      } else {
        px = vx * tReach + 0.5 * ax * tReach * tReach + tx * (remaining - tReach);
        pz = vz * tReach + 0.5 * az * tReach * tReach + tz * (remaining - tReach);
        this.vel[0] = tx;
        this.vel[2] = tz;
      }
    }
    this.moveXZ(px, pz, world);
  }

  private moveVertical(dt: number, world: CollisionWorld) {
    const g = PLAYER.gravity;
    let vy = this.vel[1];
    let dy = 0;
    const off = this.thrustOffset;
    const dur = this.thrustDur;
    this.thrusting = dur > 0;

    if (this.grounded && dur <= 0 && vy <= 0) {
      this.vel[1] = 0;
      if (!world.hasSupport(this.pos, PLAYER.halfWidth)) this.grounded = false;
      else return;
    }

    const gravSeg = (tau: number) => {
      if (tau <= 0) return;
      dy += vy * tau - 0.5 * g * tau * tau;
      vy -= g * tau;
    };
    const thrustSeg = (tau: number) => {
      if (tau <= 0) return;
      const target = PLAYER.flightRiseSpeed;
      if (vy < target) {
        const a = PLAYER.flightRiseAccel;
        const tr = Math.min(tau, (target - vy) / a);
        dy += vy * tr + 0.5 * a * tr * tr;
        vy += a * tr;
        if (tr < tau) {
          dy += target * (tau - tr);
          vy = target;
        }
      } else {
        const tr = Math.min(tau, (vy - target) / g);
        dy += vy * tr - 0.5 * g * tr * tr;
        vy -= g * tr;
        if (tr < tau) {
          dy += target * (tau - tr);
          vy = target;
        }
      }
    };
    if (dur > 0) {
      gravSeg(off);
      thrustSeg(dur);
      gravSeg(dt - off - dur);
    } else {
      gravSeg(dt);
    }
    this.grounded = false;
    const got = world.sweepAxis(this.pos, PLAYER.halfWidth, PLAYER.height, 1, dy);
    if (Math.abs(got - dy) > 1e-7) {
      if (dy < 0) {
        this.grounded = true;
        vy = 0;
      } else if (vy > 0) {
        vy = 0;
      }
    }
    this.vel[1] = vy;
    if (!this.grounded && vy <= 0 && world.hasSupport(this.pos, PLAYER.halfWidth)) {
      this.grounded = true;
      this.vel[1] = 0;
    }
  }

  private regen(now: number, dt: number) {
    if (this.spentThisStep) return;
    if (!this.groundedAtStart || !this.grounded) return;
    if (this.en >= this.stats.maxEn) return;
    const from = this.lastEnSpentAt === null ? now : Math.max(now, this.lastEnSpentAt + PLAYER.enRegenDelay);
    const tau = now + dt - from;
    if (tau <= 0) return;
    this.en = Math.min(this.stats.maxEn, this.en + this.stats.regenPerSecond * tau);
  }

  /** プレイヤーの当たり判定中心 */
  center(): V3 {
    return [this.pos[0], this.pos[1] + PLAYER.centerHeight, this.pos[2]];
  }
}
