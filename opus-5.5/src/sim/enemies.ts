// 敵（警備ロボット・固定砲台）のAI、攻撃タイマー、偏差射撃、敵弾。
import { BULLET_RADIUS, ENEMY, GUARD_AI, PLAYER, TURRET, type EnemySpec } from '../config';
import { DEG, orthoBasis, vnorm, type V3 } from '../math';
import type { Rng } from '../rng';
import type { EnemyDef } from '../stage/types';
import type { NavGraph } from './nav';
import type { Player } from './player';
import { CollisionWorld } from './world';

export interface EnemyBullet {
  pos: V3;
  prev: V3;
  vel: V3;
  life: number;
  damage: number;
  kind: 'guard' | 'turret';
  ownerId: string;
  alive: boolean;
  uid: number;
  /** 発射ステップ内で残っている移動時間（発射時刻の端数補正） */
  firstStep?: number;
}

export type SimEvent =
  | { type: 'enemyShot'; id: string; pos: V3; kind: 'guard' | 'turret' }
  | { type: 'playerHit'; dir: V3; damage: number; from: V3; ownerId: string }
  | { type: 'impact'; pos: V3; normal: V3; kind: 'enemyBullet' | 'mg' | 'beam' | 'missile' }
  | { type: 'enemyHit'; id: string; pos: V3; damage: number }
  | { type: 'enemyKilled'; id: string; pos: V3; kind: 'guard' | 'turret'; control: boolean }
  | { type: 'barrierOpened'; id: string }
  | { type: 'gateOpened' }
  | { type: 'beam'; from: V3; to: V3 }
  | { type: 'missileFired'; pos: V3 }
  | { type: 'qb'; dir: [number, number] }
  | { type: 'message'; text: string; kind: 'warn' | 'info' };

type GuardMode = 'idle' | 'engage' | 'pursue' | 'search';

export class Enemy {
  readonly def: EnemyDef;
  readonly spec: EnemySpec;
  readonly id: string;
  readonly kind: 'guard' | 'turret';
  pos: V3;
  vel: V3 = [0, 0, 0];
  hp: number;
  alive = true;
  yaw = 0;
  aimDir: V3 = [0, 0, -1];
  grounded = true;

  hasLOS = false;
  alert = false;
  seenThisAlert = false;
  lastSeenPos: V3 | null = null;
  lastSeenAt: number | null = null;
  memoryUntil = -Infinity;
  losLostAt: number | null = null;

  nextBurstAt: number | null = null;
  telegraphStart: number | null = null;
  burstLeft = 0;
  nextShotAt = 0;
  shotsFired = 0;
  lastShotAt: number | null = null;

  // 警備ロボット移動
  mode: GuardMode = 'idle';
  node = -1;
  nodeCheckAt = 0;
  path: number[] | null = null;
  pathIdx = 0;
  repathAt = 0;
  pathGoal: V3 | null = null;
  strafeSign: 1 | -1 = 1;
  strafeFlipAt = 0;
  stuckTime = 0;
  patrolWaitUntil = 0;
  lastShareAt = -Infinity;
  flankSide: 1 | -1 = 1;
  searchUntil = 0;
  walkPhase = 0;

  constructor(def: EnemyDef) {
    this.def = def;
    this.id = def.id;
    this.kind = def.kind;
    this.spec = ENEMY[def.kind];
    this.pos = [def.pos[0], def.pos[1], def.pos[2]];
    this.hp = this.spec.hp;
  }

  /** 当たり判定中心 */
  center(): V3 {
    if (this.kind === 'guard') return [this.pos[0], this.pos[1] + GUARD_AI.hitCenterHeight, this.pos[2]];
    return [this.pos[0], this.pos[1] + TURRET.hitCenterOffset, this.pos[2]];
  }

  get telegraphing(): boolean {
    return this.telegraphStart !== null;
  }
}

export interface PlayerTargetPoints {
  center: V3;
  upper: V3;
}

export class EnemyManager {
  enemies: Enemy[] = [];
  bullets: EnemyBullet[] = [];
  private bulletUid = 0;
  private world: CollisionWorld;
  private nav: NavGraph;
  private rng: Rng;
  private defs: EnemyDef[];
  events: SimEvent[] = [];

  constructor(defs: EnemyDef[], world: CollisionWorld, nav: NavGraph, rng: Rng) {
    this.defs = defs;
    this.world = world;
    this.nav = nav;
    this.rng = rng;
    this.reset();
  }

  reset() {
    this.enemies = this.defs.map((d) => new Enemy(d));
    this.bullets = [];
    this.bulletUid = 0;
    for (const e of this.enemies) {
      if (e.kind === 'guard') {
        e.node = this.nav.nearest(e.pos, 6, 1.5);
        e.strafeSign = this.rng.sign() as 1 | -1;
        e.patrolWaitUntil = this.rng.range(0.5, 3);
        e.yaw = this.rng.range(-Math.PI, Math.PI);
      }
    }
  }

  byId(id: string): Enemy | undefined {
    return this.enemies.find((e) => e.id === id);
  }

  /** 銃口位置（対象方向を向いた状態） */
  muzzleOf(e: Enemy, target: V3): V3 {
    if (e.kind === 'guard') {
      const dx = target[0] - e.pos[0],
        dz = target[2] - e.pos[2];
      const l = Math.hypot(dx, dz) || 1;
      return [e.pos[0] + (dx / l) * 1.1, e.pos[1] + 1.95, e.pos[2] + (dz / l) * 1.1];
    }
    const hc: V3 = [e.pos[0], e.pos[1] + TURRET.hitCenterOffset, e.pos[2]];
    const d = vnorm([target[0] - hc[0], target[1] - hc[1], target[2] - hc[2]]);
    return [hc[0] + d[0] * 1.3, hc[1] + d[1] * 1.3, hc[2] + d[2] * 1.3];
  }

  private losPoint(e: Enemy, pts: PlayerTargetPoints): V3 | null {
    for (const p of [pts.center, pts.upper]) {
      const m = this.muzzleOf(e, p);
      if (!this.world.segmentBlocked(m, p)) return p;
    }
    return null;
  }

  update(now: number, dt: number, player: Player, closed: Set<string>) {
    const pts: PlayerTargetPoints = {
      center: player.center(),
      upper: [player.pos[0], player.pos[1] + PLAYER.height - 0.3, player.pos[2]],
    };
    for (const e of this.enemies) {
      if (!e.alive) continue;
      this.perceive(e, now, player, pts, closed);
      this.attack(e, now, dt, player, pts);
      if (e.kind === 'guard') this.moveGuard(e, now, dt, player, closed);
      else this.aimTurret(e, dt, pts);
    }
    this.updateBullets(dt, player);
  }

  private perceive(e: Enemy, now: number, player: Player, pts: PlayerTargetPoints, closed: Set<string>) {
    const c = e.center();
    const dist = Math.hypot(pts.center[0] - c[0], pts.center[1] - c[1], pts.center[2] - c[2]);
    let seen: V3 | null = null;
    if (player.hp > 0 && dist <= e.spec.range) seen = this.losPoint(e, pts);
    const had = e.hasLOS;
    e.hasLOS = seen !== null;
    if (seen) {
      if (!e.seenThisAlert) {
        // 初めて有効な射線を得た：初回攻撃時刻を設定（既存の次回発射可能時刻より早めない）
        const first = now + e.spec.firstDelay;
        e.nextBurstAt = e.nextBurstAt === null ? first : Math.max(e.nextBurstAt, first);
        e.seenThisAlert = true;
      }
      e.alert = true;
      e.lastSeenPos = [player.pos[0], player.pos[1], player.pos[2]];
      e.lastSeenAt = now;
      e.memoryUntil = now + GUARD_AI.memorySeconds;
      e.losLostAt = null;
      if (e.kind === 'guard' && now - e.lastShareAt >= 0.25) {
        e.lastShareAt = now;
        this.share(e, now, closed);
      }
    } else {
      if (had) e.losLostAt = now;
      if (e.alert && now >= e.memoryUntil) {
        e.alert = false;
        e.seenThisAlert = false;
        e.lastSeenPos = null;
        e.losLostAt = null;
        e.mode = 'idle';
        e.path = null;
      }
    }
  }

  /** 通路でつながる60m以内の味方警備ロボットへ最後の確認位置を共有 */
  private share(src: Enemy, now: number, closed: Set<string>) {
    if (!src.lastSeenPos) return;
    const n0 = src.node >= 0 ? src.node : this.nav.nearest(src.pos, 6, 1.5);
    if (n0 < 0) return;
    let reach: Set<number> | null = null;
    for (const o of this.enemies) {
      if (o === src || !o.alive || o.kind !== 'guard' || o.hasLOS) continue;
      const dx = o.pos[0] - src.pos[0],
        dy = o.pos[1] - src.pos[1],
        dz = o.pos[2] - src.pos[2];
      if (dx * dx + dy * dy + dz * dz > GUARD_AI.shareRadius * GUARD_AI.shareRadius) continue;
      if (!reach) reach = this.nav.withinPathDistance(n0, GUARD_AI.shareRadius, closed);
      const on = o.node >= 0 ? o.node : this.nav.nearest(o.pos, 6, 1.5);
      if (on < 0 || !reach.has(on)) continue;
      if (!o.alert) o.losLostAt = now;
      o.alert = true;
      o.lastSeenPos = [src.lastSeenPos[0], src.lastSeenPos[1], src.lastSeenPos[2]];
      o.memoryUntil = Math.max(o.memoryUntil, now + GUARD_AI.memorySeconds);
    }
  }

  private attack(e: Enemy, now: number, dt: number, player: Player, pts: PlayerTargetPoints) {
    const s = e.spec;
    if (e.burstLeft <= 0) {
      if (e.hasLOS && e.nextBurstAt !== null) {
        if (e.telegraphStart === null && now >= e.nextBurstAt - s.telegraph - 1e-9) e.telegraphStart = now;
        if (e.telegraphStart !== null && now >= e.nextBurstAt - 1e-9 && now - e.telegraphStart >= s.telegraph - 1e-9) {
          e.burstLeft = s.burstCount;
          e.nextShotAt = now;
          e.nextBurstAt = now + s.burstPeriod;
          e.telegraphStart = null;
        }
      } else {
        e.telegraphStart = null;
      }
    }
    // 予定発射時刻がこのステップ内にある発を、その正確な時刻で発射する（ステップ幅による量子化を避ける）
    while (e.burstLeft > 0 && e.nextShotAt < now + dt - 1e-9) {
      const ts = Math.max(now, e.nextShotAt);
      this.fireShot(e, ts, now + dt - ts, player, pts);
      e.burstLeft--;
      e.nextShotAt += s.burstInterval;
    }
  }

  /** firstStep: 発射時刻からこのステップ終了までの時間（弾の初回移動量） */
  private fireShot(e: Enemy, now: number, firstStep: number, player: Player, pts: PlayerTargetPoints) {
    if (player.hp <= 0) return;
    // 各発ごとに銃口からの射線を確認。射線がなければ発射しない。
    const c = e.center();
    const d0 = Math.hypot(pts.center[0] - c[0], pts.center[1] - c[1], pts.center[2] - c[2]);
    if (d0 > e.spec.range) return;
    const P = this.losPoint(e, pts);
    if (!P) return;
    const M = this.muzzleOf(e, P);
    const V = player.vel;
    const sp = e.spec.bulletSpeed;
    const D: V3 = [P[0] - M[0], P[1] - M[1], P[2] - M[2]];
    // 迎撃時刻 |D + V t| = s t
    const a = V[0] * V[0] + V[1] * V[1] + V[2] * V[2] - sp * sp;
    const b = 2 * (V[0] * D[0] + V[1] * D[1] + V[2] * D[2]);
    const cc = D[0] * D[0] + D[1] * D[1] + D[2] * D[2];
    let t: number;
    if (Math.abs(a) < 1e-9) t = b !== 0 ? -cc / b : Math.sqrt(cc) / sp;
    else {
      const disc = b * b - 4 * a * cc;
      if (disc < 0) t = Math.sqrt(cc) / sp;
      else {
        const sq = Math.sqrt(disc);
        const t1 = (-b - sq) / (2 * a);
        const t2 = (-b + sq) / (2 * a);
        const cands = [t1, t2].filter((x) => x > 0);
        t = cands.length ? Math.min(...cands) : Math.sqrt(cc) / sp;
      }
    }
    if (!Number.isFinite(t) || t < 0) t = Math.sqrt(cc) / sp;
    t = Math.min(t, GUARD_AI.maxLeadSeconds);
    const aim: V3 = [P[0] + V[0] * t, P[1] + V[1] * t, P[2] + V[2] * t];
    let dir = vnorm([aim[0] - M[0], aim[1] - M[1], aim[2] - M[2]]);
    // 照準のばらつき（最大0.5度、円錐内一様）
    const maxA = GUARD_AI.aimSpreadDeg * DEG;
    const ang = maxA * Math.sqrt(this.rng.next());
    const phi = this.rng.next() * Math.PI * 2;
    const [u, w] = orthoBasis(dir);
    const sa = Math.sin(ang),
      ca = Math.cos(ang);
    dir = vnorm([
      dir[0] * ca + (u[0] * Math.cos(phi) + w[0] * Math.sin(phi)) * sa,
      dir[1] * ca + (u[1] * Math.cos(phi) + w[1] * Math.sin(phi)) * sa,
      dir[2] * ca + (u[2] * Math.cos(phi) + w[2] * Math.sin(phi)) * sa,
    ]);
    e.aimDir = dir;
    this.bullets.push({
      pos: [M[0], M[1], M[2]],
      prev: [M[0], M[1], M[2]],
      vel: [dir[0] * sp, dir[1] * sp, dir[2] * sp],
      life: e.spec.bulletLife,
      damage: e.spec.damage,
      kind: e.kind,
      ownerId: e.id,
      alive: true,
      uid: ++this.bulletUid,
      firstStep,
    });
    e.shotsFired++;
    e.lastShotAt = now;
    this.events.push({ type: 'enemyShot', id: e.id, pos: M, kind: e.kind });
  }

  private aimTurret(e: Enemy, dt: number, pts: PlayerTargetPoints) {
    if (!e.alert) return;
    const tgt = e.hasLOS ? pts.center : e.lastSeenPos;
    if (!tgt) return;
    const want = Math.atan2(-(tgt[0] - e.pos[0]), -(tgt[2] - e.pos[2]));
    let d = want - e.yaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    const maxT = 6 * dt;
    e.yaw += Math.max(-maxT, Math.min(maxT, d));
    if (e.hasLOS) e.aimDir = vnorm([tgt[0] - e.pos[0], tgt[1] - (e.pos[1] + TURRET.hitCenterOffset), tgt[2] - e.pos[2]]);
  }

  // ---------------------------------------------------------------- 警備ロボット移動
  private moveGuard(e: Enemy, now: number, dt: number, player: Player, closed: Set<string>) {
    if (now >= e.nodeCheckAt) {
      const n = this.nav.nearest(e.pos, 6, 1.5);
      if (n >= 0) e.node = n;
      e.nodeCheckAt = now + 0.2;
    }
    let wantX = 0,
      wantZ = 0;
    let speed = 0;
    let faceTarget: V3 | null = null;

    if (e.hasLOS) {
      e.mode = 'engage';
      e.path = null;
      faceTarget = player.pos;
      const dx = player.pos[0] - e.pos[0],
        dz = player.pos[2] - e.pos[2];
      const dist = Math.hypot(dx, player.pos[1] - e.pos[1], dz);
      const hl = Math.hypot(dx, dz) || 1;
      const tx = dx / hl,
        tz = dz / hl;
      const px = -tz * e.strafeSign,
        pz = tx * e.strafeSign;
      if (now >= e.strafeFlipAt) {
        e.strafeSign = this.rng.next() < 0.5 ? 1 : -1;
        e.strafeFlipAt = now + this.rng.range(1.2, 2.8);
      }
      if (dist > GUARD_AI.farDistance) {
        // 接近（通行可能な経路）
        const dir = this.followPathTo(e, now, player.pos, closed, true);
        if (dir) {
          wantX = dir[0];
          wantZ = dir[1];
        } else {
          wantX = px;
          wantZ = pz;
        }
        speed = GUARD_AI.approachSpeed;
      } else if (dist >= GUARD_AI.midDistance) {
        wantX = px;
        wantZ = pz;
        speed = GUARD_AI.strafeSpeed;
      } else if (dist >= GUARD_AI.nearDistance) {
        wantX = px * 0.8 - tx * 0.6;
        wantZ = pz * 0.8 - tz * 0.6;
        speed = GUARD_AI.strafeSpeed;
      } else {
        wantX = -tx + px * 0.35;
        wantZ = -tz + pz * 0.35;
        speed = GUARD_AI.retreatSpeed;
      }
    } else if (e.alert && e.lastSeenPos) {
      // 最後の確認位置へ接近または側方へ回り込む（遮蔽直後から開始）
      if (e.mode !== 'pursue' && e.mode !== 'search') {
        e.mode = 'pursue';
        e.flankSide = this.rng.sign() as 1 | -1;
        e.path = null;
        e.repathAt = now;
      }
      const lp = e.lastSeenPos;
      const hd = Math.hypot(lp[0] - e.pos[0], lp[2] - e.pos[2]);
      if (e.mode === 'pursue') {
        // 回り込み：最後の確認位置の横にずらした目標
        let goal: V3 = lp;
        if (hd > 14) {
          const ddx = lp[0] - e.pos[0],
            ddz = lp[2] - e.pos[2];
          const l = Math.hypot(ddx, ddz) || 1;
          goal = [lp[0] + (-ddz / l) * 8 * e.flankSide, lp[1], lp[2] + (ddx / l) * 8 * e.flankSide];
        }
        const dir = this.followPathTo(e, now, goal, closed, false);
        if (dir) {
          wantX = dir[0];
          wantZ = dir[1];
          speed = GUARD_AI.approachSpeed;
        }
        if (hd < 4 || (e.path && e.pathIdx >= e.path.length)) {
          e.mode = 'search';
          e.searchUntil = 0;
        }
        faceTarget = lp;
      } else {
        // 捜索：最後の確認位置の周辺を巡回
        if (now >= e.searchUntil || !e.path || e.pathIdx >= e.path.length) {
          const c = e.node >= 0 ? this.nav.nodes[e.node].comp : -1;
          const n = this.nav.randomNear(lp, 12, c, () => this.rng.next());
          if (n >= 0 && e.node >= 0) {
            e.path = this.nav.findPath(e.node, n, closed, 2500);
            e.pathIdx = this.pathStartIndex(e, e.path);
          }
          e.searchUntil = now + this.rng.range(1.5, 3);
        }
        const dir = this.pathDir(e);
        if (dir) {
          wantX = dir[0];
          wantZ = dir[1];
          speed = 5;
        }
      }
    } else {
      e.mode = 'idle';
      // 巡回
      if (now >= e.patrolWaitUntil && (!e.path || e.pathIdx >= e.path.length)) {
        const c = e.node >= 0 ? this.nav.nodes[e.node].comp : -1;
        const n = this.nav.randomNear(e.def.pos, 18, c, () => this.rng.next());
        if (n >= 0 && e.node >= 0) {
          e.path = this.nav.findPath(e.node, n, closed, 1500);
          e.pathIdx = this.pathStartIndex(e, e.path);
        }
        e.patrolWaitUntil = now + this.rng.range(3, 7);
      }
      const dir = this.pathDir(e);
      if (dir) {
        wantX = dir[0];
        wantZ = dir[1];
        speed = GUARD_AI.patrolSpeed;
      }
    }

    // 味方との分離
    for (const o of this.enemies) {
      if (o === e || !o.alive || o.kind !== 'guard') continue;
      const dx = e.pos[0] - o.pos[0],
        dz = e.pos[2] - o.pos[2];
      const d2 = dx * dx + dz * dz;
      if (d2 < 9 && d2 > 1e-6 && Math.abs(e.pos[1] - o.pos[1]) < 2) {
        const d = Math.sqrt(d2);
        wantX += (dx / d) * (3 - d) * 0.6;
        wantZ += (dz / d) * (3 - d) * 0.6;
        if (speed === 0) speed = 3;
      }
    }

    const wl = Math.hypot(wantX, wantZ);
    let tvx = 0,
      tvz = 0;
    if (wl > 1e-6 && speed > 0) {
      tvx = (wantX / wl) * speed;
      tvz = (wantZ / wl) * speed;
    }
    // 速度を目標へ加速
    const ax = tvx - e.vel[0],
      az = tvz - e.vel[2];
    const al = Math.hypot(ax, az);
    const maxDv = GUARD_AI.accel * dt;
    if (al <= maxDv) {
      e.vel[0] = tvx;
      e.vel[2] = tvz;
    } else {
      e.vel[0] += (ax / al) * maxDv;
      e.vel[2] += (az / al) * maxDv;
    }

    // 段差からの転落防止と衝突
    const hw = GUARD_AI.halfWidth,
      h = GUARD_AI.height;
    const intended = Math.hypot(e.vel[0], e.vel[2]) * dt;
    let moved = 0;
    for (const axis of [0, 2] as const) {
      const d = e.vel[axis] * dt;
      if (d === 0) continue;
      const nx = axis === 0 ? e.pos[0] + d * 4 : e.pos[0];
      const nz = axis === 2 ? e.pos[2] + d * 4 : e.pos[2];
      const g = this.world.groundBelow(nx, e.pos[1] + 0.3, nz, 0.35, 1.2);
      if (g === null) {
        e.vel[axis] = 0;
        continue;
      }
      const got = this.world.sweepAxis(e.pos, hw, h, axis, d);
      moved += Math.abs(got);
      if (Math.abs(got - d) > 1e-7) e.vel[axis] = 0;
    }
    // 重力
    e.vel[1] -= PLAYER.gravity * dt;
    const dy = e.vel[1] * dt;
    const gy = this.world.sweepAxis(e.pos, hw, h, 1, dy);
    if (Math.abs(gy - dy) > 1e-7 && dy < 0) {
      e.vel[1] = 0;
      e.grounded = true;
    } else e.grounded = false;

    // 詰まり検出：進めなければ向きを変える・経路を引き直す
    if (intended > 1e-4 && moved < intended * 0.25) {
      e.stuckTime += dt;
      if (e.stuckTime > 0.3) {
        e.strafeSign = e.strafeSign === 1 ? -1 : 1;
        e.strafeFlipAt = now + this.rng.range(1.0, 2.2);
        e.repathAt = now;
        if (e.path && e.pathIdx < e.path.length) e.pathIdx++;
        e.stuckTime = 0;
      }
    } else e.stuckTime = 0;

    e.walkPhase += Math.hypot(e.vel[0], e.vel[2]) * dt * 1.4;
    // 向き
    if (faceTarget) {
      e.yaw = Math.atan2(-(faceTarget[0] - e.pos[0]), -(faceTarget[2] - e.pos[2]));
    } else if (Math.hypot(e.vel[0], e.vel[2]) > 0.5) {
      e.yaw = Math.atan2(-e.vel[0], -e.vel[2]);
    }
    if (e.hasLOS) e.aimDir = vnorm([player.pos[0] - e.pos[0], player.pos[1] + 1.5 - (e.pos[1] + 1.95), player.pos[2] - e.pos[2]]);
  }

  private followPathTo(e: Enemy, now: number, goal: V3, closed: Set<string>, toPlayer: boolean): [number, number] | null {
    if (now >= e.repathAt || !e.path) {
      e.repathAt = now + GUARD_AI.repathSeconds;
      const gn = toPlayer ? this.nav.nearestBelow(goal) : this.nav.nearest(goal, 12, 3);
      if (e.node >= 0 && gn >= 0) {
        e.path = this.nav.findPath(e.node, gn, closed, 5000);
        e.pathIdx = this.pathStartIndex(e, e.path);
        e.pathGoal = goal;
      } else e.path = null;
    }
    return this.pathDir(e);
  }

  /** 経路の引き直し後、機体の背後にある先頭ノードへ戻らないよう開始位置を決める */
  private pathStartIndex(e: Enemy, path: number[] | null): number {
    if (!path || path.length < 2) return 0;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < Math.min(4, path.length); i++) {
      const n = this.nav.nodes[path[i]];
      const d = Math.hypot(n.x - e.pos[0], n.z - e.pos[2]);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return Math.min(best + 1, path.length - 1);
  }

  private pathDir(e: Enemy): [number, number] | null {
    const p = e.path;
    if (!p) return null;
    while (e.pathIdx < p.length) {
      const n = this.nav.nodes[p[e.pathIdx]];
      const dx = n.x - e.pos[0],
        dz = n.z - e.pos[2];
      const d = Math.hypot(dx, dz);
      if (d < 1.3) {
        e.pathIdx++;
        continue;
      }
      return [dx / d, dz / d];
    }
    return null;
  }

  // ---------------------------------------------------------------- 敵弾
  private updateBullets(dt: number, player: Player) {
    const hw = PLAYER.halfWidth + BULLET_RADIUS;
    const pbox = {
      min: [player.pos[0] - hw, player.pos[1] - BULLET_RADIUS, player.pos[2] - hw] as V3,
      max: [player.pos[0] + hw, player.pos[1] + PLAYER.height + BULLET_RADIUS, player.pos[2] + hw] as V3,
      active: true,
      tag: null,
    };
    for (const b of this.bullets) {
      if (!b.alive) continue;
      const step = Math.min(b.firstStep ?? dt, b.life);
      b.firstStep = undefined;
      const sp = Math.hypot(b.vel[0], b.vel[1], b.vel[2]);
      const L = sp * step;
      const dir: V3 = [b.vel[0] / sp, b.vel[1] / sp, b.vel[2] / sp];
      b.prev = [b.pos[0], b.pos[1], b.pos[2]];
      const hw2 = this.world.raycast(b.pos, dir, L);
      const hp = player.hp > 0 ? CollisionWorld.rayBox(b.pos, dir, pbox, L) : null;
      if (hp && (!hw2 || hp.t <= hw2.t)) {
        player.hp -= b.damage;
        b.alive = false;
        const at: V3 = [b.pos[0] + dir[0] * hp.t, b.pos[1] + dir[1] * hp.t, b.pos[2] + dir[2] * hp.t];
        this.events.push({ type: 'playerHit', dir, damage: b.damage, from: at, ownerId: b.ownerId });
        continue;
      }
      if (hw2) {
        b.alive = false;
        const at: V3 = [b.pos[0] + dir[0] * hw2.t, b.pos[1] + dir[1] * hw2.t, b.pos[2] + dir[2] * hw2.t];
        this.events.push({ type: 'impact', pos: at, normal: hw2.normal, kind: 'enemyBullet' });
        continue;
      }
      b.pos = [b.pos[0] + b.vel[0] * step, b.pos[1] + b.vel[1] * step, b.pos[2] + b.vel[2] * step];
      b.life -= step;
      if (b.life <= 1e-9) b.alive = false;
    }
    // 寿命切れ・命中済みの弾を削除
    if (this.bullets.length > 0) this.bullets = this.bullets.filter((b) => b.alive);
  }

  /** 敵へのダメージ（プレイヤー武器から） */
  damage(e: Enemy, amount: number, at: V3): boolean {
    if (!e.alive) return false;
    e.hp -= amount;
    this.events.push({ type: 'enemyHit', id: e.id, pos: at, damage: amount });
    if (e.hp <= 0) {
      e.alive = false;
      e.hasLOS = false;
      e.telegraphStart = null;
      e.burstLeft = 0;
      this.events.push({ type: 'enemyKilled', id: e.id, pos: e.center(), kind: e.kind, control: e.def.isGateControl });
      return true;
    }
    return false;
  }
}
