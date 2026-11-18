// プレイヤーの3武器（マシンガン・ビーム・ハンドミサイル）とFCSロック。
import { BEAM, CHEST_OFFSET, LOCK, MG, MISSILE, MUZZLE_OFFSET, WEAPONS, type WeaponId, type EffectiveStats } from '../config';
import { DEG, forwardFromYaw, rightFromYaw, rotateTowards, vnorm, type V3 } from '../math';
import { project, type CameraState } from './camera';
import type { Enemy, EnemyManager, SimEvent } from './enemies';
import type { Player } from './player';
import type { CollisionWorld } from './world';

export interface MgBullet {
  pos: V3;
  prev: V3;
  vel: V3;
  life: number;
  alive: boolean;
}

export interface Missile {
  pos: V3;
  prev: V3;
  dir: V3;
  life: number;
  targetId: string;
  alive: boolean;
  trailSeed: number;
}

export type LockState = 'none' | 'acquiring' | 'locked';

/** 光線と球の交差。d は正規化方向。最初の t（[0,maxT]）を返す */
export function raySphere(o: V3, d: V3, c: V3, r: number, maxT: number): number | null {
  const ox = o[0] - c[0],
    oy = o[1] - c[1],
    oz = o[2] - c[2];
  const b = ox * d[0] + oy * d[1] + oz * d[2];
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  if (cc <= 0) return 0;
  const disc = b * b - cc;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  if (t < 0 || t > maxT) return null;
  return t;
}

/**
 * FCS射撃管制（マシンガン）：ロック対象の現在位置 P・現在速度 V と、弾速・重力から迎撃方向を求める。
 * 弾は M + u·s·t − ½g·t²ŷ を進むので、|P + V·t − M + ½g·t²ŷ| = s·t を満たす最小の t を固定点反復で解く。
 * 方向は発射時に一度だけ決定し、発射後の誘導は行わない。解が弾の寿命内に無ければ null。
 */
export function ballisticLead(M: V3, P: V3, V: V3, speed: number, gravity: number, maxT: number): V3 | null {
  const at = (t: number): V3 => [P[0] + V[0] * t - M[0], P[1] + V[1] * t - M[1] + 0.5 * gravity * t * t, P[2] + V[2] * t - M[2]];
  let t = Math.hypot(P[0] - M[0], P[1] - M[1], P[2] - M[2]) / speed;
  for (let i = 0; i < 30; i++) {
    const d = at(t);
    const nt = Math.hypot(d[0], d[1], d[2]) / speed;
    const done = Math.abs(nt - t) < 1e-7;
    t = nt;
    if (done) break;
  }
  if (!Number.isFinite(t) || t <= 0 || t > maxT) return null;
  const d = at(t);
  const L = Math.hypot(d[0], d[1], d[2]);
  if (Math.abs(L - speed * t) > 1e-3 * Math.max(1, L)) return null;
  return [d[0] / L, d[1] / L, d[2] / L];
}

export function playerMuzzle(p: Player, yaw: number): V3 {
  const f = forwardFromYaw(yaw);
  const r = rightFromYaw(yaw);
  return [
    p.pos[0] + r[0] * MUZZLE_OFFSET.right + f[0] * MUZZLE_OFFSET.forward,
    p.pos[1] + MUZZLE_OFFSET.up,
    p.pos[2] + r[1] * MUZZLE_OFFSET.right + f[1] * MUZZLE_OFFSET.forward,
  ];
}

export function playerChest(p: Player): V3 {
  return [p.pos[0], p.pos[1] + CHEST_OFFSET.up, p.pos[2]];
}

export class Fcs {
  targetId: string | null = null;
  lockTime = 0;
  lockSeconds = 0.8;
  radiusPx = 0;

  reset(stats: EffectiveStats) {
    this.targetId = null;
    this.lockTime = 0;
    this.lockSeconds = stats.lockSeconds;
  }

  get progress(): number {
    if (!this.targetId) return 0;
    return Math.min(1, this.lockTime / this.lockSeconds);
  }

  get state(): LockState {
    if (!this.targetId) return 'none';
    return this.lockTime >= this.lockSeconds - 1e-9 ? 'locked' : 'acquiring';
  }

  static radiusFor(stats: EffectiveStats, width: number, height: number) {
    return stats.lockRadiusFactor * Math.min(width, height);
  }

  /** ロック候補条件（生存・銃口から120m以内・カメラ前方・円内・カメラと銃口の双方から遮蔽なし） */
  isCandidate(e: Enemy, cam: CameraState, muzzle: V3, w: number, h: number, world: CollisionWorld): number | null {
    if (!e.alive) return null;
    const c = e.center();
    const dm = Math.hypot(c[0] - muzzle[0], c[1] - muzzle[1], c[2] - muzzle[2]);
    if (dm > LOCK.maxDistance) return null;
    const pr = project(cam, c, w, h);
    if (!pr.inFront) return null;
    if (pr.distPx > this.radiusPx) return null;
    if (world.segmentBlocked(cam.pos, c)) return null;
    if (world.segmentBlocked(muzzle, c)) return null;
    return pr.distPx;
  }

  update(dt: number, cam: CameraState, muzzle: V3, w: number, h: number, stats: EffectiveStats, enemies: EnemyManager, world: CollisionWorld) {
    this.lockSeconds = stats.lockSeconds;
    this.radiusPx = Fcs.radiusFor(stats, w, h);
    if (this.targetId) {
      const e = enemies.byId(this.targetId);
      if (!e || this.isCandidate(e, cam, muzzle, w, h, world) === null) {
        // 範囲外・遮蔽・破壊・距離外：対象と進捗を即座に破棄
        this.targetId = null;
        this.lockTime = 0;
      } else {
        this.lockTime = Math.min(this.lockSeconds, this.lockTime + dt);
      }
    }
    if (!this.targetId) {
      let best: Enemy | null = null;
      let bestD = Infinity;
      for (const e of enemies.enemies) {
        if (!e.alive) continue;
        const c = e.center();
        const dm = Math.hypot(c[0] - muzzle[0], c[1] - muzzle[1], c[2] - muzzle[2]);
        if (dm > LOCK.maxDistance) continue;
        const d = this.isCandidate(e, cam, muzzle, w, h, world);
        if (d === null) continue;
        if (d < bestD - 1e-9 || (Math.abs(d - bestD) <= 1e-9 && best && e.id < best.id)) {
          best = e;
          bestD = d;
        }
      }
      if (best) {
        this.targetId = best.id;
        this.lockTime = 0;
      }
    }
  }
}

export class PlayerWeapons {
  current: WeaponId = 'machinegun';
  ammo = { machinegun: 300, missile: 12 };
  nextFireAt: Record<WeaponId, number> = { machinegun: 0, beam: 0, missile: 0 };
  mgBullets: MgBullet[] = [];
  missiles: Missile[] = [];
  lastDenied: { reason: 'noLock' | 'noAmmo' | 'noEn'; weapon: WeaponId; at: number } | null = null;
  shotsFired = 0;
  private missileSeed = 0;

  reset(weapon: WeaponId) {
    this.current = weapon;
    this.ammo = { machinegun: WEAPONS.machinegun.ammo!, missile: WEAPONS.missile.ammo! };
    this.nextFireAt = { machinegun: 0, beam: 0, missile: 0 };
    this.mgBullets = [];
    this.missiles = [];
    this.lastDenied = null;
    this.shotsFired = 0;
    this.missileSeed = 0;
  }

  /** 射撃要求。ビームのEN判定はQBの後・飛行の前に行う（呼び出し順で保証） */
  fire(
    now: number,
    player: Player,
    yaw: number,
    aimPoint: V3,
    fcs: Fcs,
    enemies: EnemyManager,
    world: CollisionWorld,
    events: SimEvent[],
  ) {
    const w = this.current;
    const spec = WEAPONS[w];
    if (now < this.nextFireAt[w] - 1e-9) return;
    const muzzle = playerMuzzle(player, yaw);
    const chest = playerChest(player);
    const locked = fcs.state === 'locked' ? enemies.byId(fcs.targetId!) : undefined;

    if (w === 'machinegun' && this.ammo.machinegun <= 0) {
      this.lastDenied = { reason: 'noAmmo', weapon: w, at: now };
      return;
    }
    if (w === 'missile') {
      if (this.ammo.missile <= 0) {
        this.lastDenied = { reason: 'noAmmo', weapon: w, at: now };
        return;
      }
      if (!locked || !locked.alive) {
        this.lastDenied = { reason: 'noLock', weapon: w, at: now };
        return;
      }
    }
    if (w === 'beam' && player.en < spec.enCost - 1e-9) {
      this.lastDenied = { reason: 'noEn', weapon: w, at: now };
      player.lastEnShortAt = now;
      return;
    }

    // 発射成立
    this.nextFireAt[w] = now + spec.interval;
    this.shotsFired++;
    this.lastDenied = null;
    const target = locked ? locked.center() : aimPoint;
    let dir = vnorm([target[0] - muzzle[0], target[1] - muzzle[1], target[2] - muzzle[2]]);
    if (w === 'machinegun' && locked) {
      // ロック完了時はFCSが偏差と弾道落下を計算して発射方向を決める
      const v: V3 = [locked.vel[0], locked.grounded ? 0 : locked.vel[1], locked.vel[2]];
      const lead = ballisticLead(muzzle, target, v, MG.speed, MG.gravity, MG.life);
      if (lead) dir = lead;
    }

    // 胴体から銃口までの遮蔽（銃口の前の壁）
    const cm = vnorm([muzzle[0] - chest[0], muzzle[1] - chest[1], muzzle[2] - chest[2]]);
    const cmLen = Math.hypot(muzzle[0] - chest[0], muzzle[1] - chest[1], muzzle[2] - chest[2]);
    const block = world.raycast(chest, cm, cmLen);

    if (w === 'machinegun') {
      this.ammo.machinegun--;
      if (block) {
        const at: V3 = [chest[0] + cm[0] * block.t, chest[1] + cm[1] * block.t, chest[2] + cm[2] * block.t];
        events.push({ type: 'impact', pos: at, normal: block.normal, kind: 'mg' });
        return;
      }
      this.mgBullets.push({
        pos: [...muzzle] as V3,
        prev: [...muzzle] as V3,
        vel: [dir[0] * MG.speed, dir[1] * MG.speed, dir[2] * MG.speed],
        life: MG.life,
        alive: true,
      });
    } else if (w === 'beam') {
      player.spend(now, spec.enCost);
      if (block) {
        const at: V3 = [chest[0] + cm[0] * block.t, chest[1] + cm[1] * block.t, chest[2] + cm[2] * block.t];
        events.push({ type: 'beam', from: muzzle, to: at });
        events.push({ type: 'impact', pos: at, normal: block.normal, kind: 'beam' });
        return;
      }
      // 銃口から射線上の最初の遮蔽物または敵まで（1射1回のダメージ）
      const wh = world.raycast(muzzle, dir, BEAM.range);
      let bestT = wh ? wh.t : BEAM.range;
      let hitE: Enemy | null = null;
      for (const e of enemies.enemies) {
        if (!e.alive) continue;
        const t = raySphere(muzzle, dir, e.center(), e.spec.hitRadius, bestT);
        if (t !== null && t < bestT) {
          bestT = t;
          hitE = e;
        }
      }
      const at: V3 = [muzzle[0] + dir[0] * bestT, muzzle[1] + dir[1] * bestT, muzzle[2] + dir[2] * bestT];
      events.push({ type: 'beam', from: muzzle, to: at });
      if (hitE) enemies.damage(hitE, spec.damage, at);
      else if (wh) events.push({ type: 'impact', pos: at, normal: wh.normal, kind: 'beam' });
    } else {
      this.ammo.missile--;
      if (block) {
        const at: V3 = [chest[0] + cm[0] * block.t, chest[1] + cm[1] * block.t, chest[2] + cm[2] * block.t];
        events.push({ type: 'impact', pos: at, normal: block.normal, kind: 'missile' });
        return;
      }
      this.missiles.push({
        pos: [...muzzle] as V3,
        prev: [...muzzle] as V3,
        dir,
        life: MISSILE.life,
        targetId: locked!.id,
        alive: true,
        trailSeed: ++this.missileSeed,
      });
      events.push({ type: 'missileFired', pos: muzzle });
    }
  }

  updateProjectiles(dt: number, enemies: EnemyManager, world: CollisionWorld, events: SimEvent[]) {
    // マシンガン弾（重力あり・移動区間で衝突判定）
    for (const b of this.mgBullets) {
      if (!b.alive) continue;
      const step = Math.min(dt, b.life);
      const np: V3 = [
        b.pos[0] + b.vel[0] * step,
        b.pos[1] + b.vel[1] * step - 0.5 * MG.gravity * step * step,
        b.pos[2] + b.vel[2] * step,
      ];
      b.prev = [b.pos[0], b.pos[1], b.pos[2]];
      this.segmentHit(b.pos, np, enemies, world, events, 'mg', WEAPONS.machinegun.damage, () => (b.alive = false));
      if (!b.alive) continue;
      b.pos = np;
      b.vel[1] -= MG.gravity * step;
      b.life -= step;
      if (b.life <= 1e-9) b.alive = false;
    }
    // ハンドミサイル（誘導・壁は貫通しない）
    const maxTurn = MISSILE.turnRateDeg * DEG;
    for (const m of this.missiles) {
      if (!m.alive) continue;
      const step = Math.min(dt, m.life);
      const t = enemies.byId(m.targetId);
      if (t && t.alive) {
        const c = t.center();
        const want = vnorm([c[0] - m.pos[0], c[1] - m.pos[1], c[2] - m.pos[2]]);
        m.dir = rotateTowards(m.dir, want, maxTurn * step);
      }
      const np: V3 = [
        m.pos[0] + m.dir[0] * MISSILE.speed * step,
        m.pos[1] + m.dir[1] * MISSILE.speed * step,
        m.pos[2] + m.dir[2] * MISSILE.speed * step,
      ];
      m.prev = [m.pos[0], m.pos[1], m.pos[2]];
      this.segmentHit(m.pos, np, enemies, world, events, 'missile', WEAPONS.missile.damage, () => (m.alive = false), MISSILE.radius);
      if (!m.alive) continue;
      m.pos = np;
      m.life -= step;
      if (m.life <= 1e-9) {
        m.alive = false;
        events.push({ type: 'impact', pos: np, normal: [0, 1, 0], kind: 'missile' });
      }
    }
    if (this.mgBullets.length) this.mgBullets = this.mgBullets.filter((b) => b.alive);
    if (this.missiles.length) this.missiles = this.missiles.filter((m) => m.alive);
  }

  private segmentHit(
    a: V3,
    b: V3,
    enemies: EnemyManager,
    world: CollisionWorld,
    events: SimEvent[],
    kind: 'mg' | 'missile',
    damage: number,
    kill: () => void,
    radius = 0,
  ) {
    const dx = b[0] - a[0],
      dy = b[1] - a[1],
      dz = b[2] - a[2];
    const L = Math.hypot(dx, dy, dz);
    if (L < 1e-9) return;
    const d: V3 = [dx / L, dy / L, dz / L];
    const wh = world.raycast(a, d, L);
    let bestT = wh ? wh.t : L;
    let hitE: Enemy | null = null;
    for (const e of enemies.enemies) {
      if (!e.alive) continue;
      const t = raySphere(a, d, e.center(), e.spec.hitRadius + radius, bestT);
      if (t !== null && t <= bestT) {
        bestT = t;
        hitE = e;
      }
    }
    if (hitE) {
      const at: V3 = [a[0] + d[0] * bestT, a[1] + d[1] * bestT, a[2] + d[2] * bestT];
      enemies.damage(hitE, damage, at);
      if (kind === 'missile') events.push({ type: 'impact', pos: at, normal: [0, 1, 0], kind });
      kill();
    } else if (wh) {
      const at: V3 = [a[0] + d[0] * wh.t, a[1] + d[1] * wh.t, a[2] + d[2] * wh.t];
      events.push({ type: 'impact', pos: at, normal: wh.normal, kind });
      kill();
    }
  }
}
