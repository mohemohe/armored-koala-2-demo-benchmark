/**
 * 弾体: マシンガン弾（解析的放物線）、ハンドミサイル（制限付き誘導）、敵弾（直進）、ビーム（即時判定）。
 * 全弾体は更新区間 [t, t+h] の線分について、prev→cur へ動く対象との掃引衝突と、ステージの掃引球で判定する。
 * 生成時刻 firedAt が t より後ろの弾体は残りの区間 [firedAt, t+h] だけ進め、対象の運動もその部分区間に対応させる（§9）。
 * Three.js / DOM に依存しない。
 */
import { ENEMIES, WEAPONS } from '../params';
import type { CollisionWorld, HittableBox, HittableSphere, ProjectileView, SimEvent, TargetInfo, Vec3, Weapon } from '../types';
import { solveLinearLead } from './ballistics';
import { raySphere, sweptSphereVsMovingBox, sweptSphereVsMovingSphere } from './geom';
import { add, addScaled, copy, degToRad, length, lerp, normalize, rotateToward, scale, sub } from './vec';

export interface ProjectileContext {
  time: number;
  world: CollisionWorld;
  /** 生存中の敵の当たり判定球（prev = 区間始点 time、cur = 区間終点 time+h）。同一更新内で撃破された敵は alive=false に書き換える */
  targets: HittableSphere[];
  /** ミサイル誘導用（現在の中心・速度） */
  targetInfoById(id: string): TargetInfo | null;
  /** 死亡時 null */
  player: HittableBox | null;
  damageEnemy(id: string, amount: number, point: Vec3, weapon: Weapon): void;
  damagePlayer(amount: number, point: Vec3, fromDirection: Vec3): void;
  events: SimEvent[];
}

export interface MgBullet {
  origin: Vec3;
  v0: Vec3;
  firedAt: number;
  pos: Vec3;
}

export interface Missile {
  pos: Vec3;
  dir: Vec3;
  targetId: string;
  firedAt: number;
  lastObservedPos: Vec3 | null;
  lastObservedVel: Vec3 | null;
  lastObservedAt: number | null;
  targetLost: boolean;
}

export interface EnemyBullet {
  pos: Vec3;
  dir: Vec3;
  speed: number;
  damage: number;
  firedAt: number;
  lifetime: number;
  ownerId: string;
}

/**
 * 寿命の終端判定に使う時間の許容値 [s]。時刻は h の累積で得られるため、
 * ちょうど寿命に達する更新で丸め誤差により 1e-15 s 程度の余分な区間が生じるのを防ぐ（仕様値ではない）。
 */
const TIME_EPS = 1e-9;

/**
 * マシンガン弾の放物線を弦（線分）で掃引するときの、曲線からの最大ずれ [m]（§4.5「0.01m以下」）。
 * params.ts に対応する定数がないためここで定義する（contractIssues 参照）。
 */
const MG_MAX_CHORD_DEVIATION_METERS: number = WEAPONS.machinegun.maxChordDeviationMeters;

/**
 * 1 本の弦で覆える最大の年齢幅 [s]。等加速度運動の弦の矢高は |g|·Δa²/8 なので Δa ≤ sqrt(8·dev/|g|)。
 * |g| = 18 なら約 0.0667 s（Game の 1/120 s 刻みでは常に 1 本）。
 */
const MG_MAX_CHORD_SECONDS = (() => {
  const g = length(WEAPONS.machinegun.gravity);
  return g > 0 ? Math.sqrt((8 * MG_MAX_CHORD_DEVIATION_METERS) / g) : Infinity;
})();

/** マシンガン弾の解析的位置: origin + v0·a + 0.5·g·a² */
function mgPositionAt(b: MgBullet, age: number): Vec3 {
  const g = WEAPONS.machinegun.gravity;
  return [
    b.origin[0] + b.v0[0] * age + 0.5 * g[0] * age * age,
    b.origin[1] + b.v0[1] * age + 0.5 * g[1] * age * age,
    b.origin[2] + b.v0[2] * age + 0.5 * g[2] * age * age,
  ];
}

/**
 * 対象の prev→cur（区間 [time, time+h] の運動）のうち、弾体が実際に進む部分区間に対応する始点・終点。
 * f0, f1 は区間 [time, time+h] 内の割合（0..1）。
 */
function motionSpan(prev: Vec3, cur: Vec3, f0: number, f1: number): { a: Vec3; b: Vec3 } {
  const a = f0 <= 0 ? prev : lerp(prev, cur, Math.min(1, f0));
  const b = f1 >= 1 ? cur : lerp(prev, cur, Math.max(0, f1));
  return { a, b };
}

interface SphereHit {
  t: number;
  id: string;
}

/** 線分 a→b（半径 r）と全ての生存対象との最初の接触。対象の運動は割合 [f0, f1] の部分区間だけを使う */
function earliestSphereHit(a: Vec3, b: Vec3, r: number, targets: HittableSphere[], f0: number, f1: number): SphereHit | null {
  let best: SphereHit | null = null;
  for (const s of targets) {
    if (!s.alive) continue;
    const span = motionSpan(s.prevCenter, s.center, f0, f1);
    const t = sweptSphereVsMovingSphere(a, b, r, span.a, span.b, s.radius);
    if (t !== null && (best === null || t < best.t)) best = { t, id: s.id };
  }
  return best;
}

function findSphere(targets: HittableSphere[], id: string): HittableSphere | null {
  for (const s of targets) if (s.id === id) return s;
  return null;
}

export class Projectiles {
  mgBullets: MgBullet[] = [];
  missiles: Missile[] = [];
  enemyBullets: EnemyBullet[] = [];
  /** 最後に integrate した区間の終端時刻（views() の方向計算用） */
  private lastTime = 0;

  reset(): void {
    this.mgBullets = [];
    this.missiles = [];
    this.enemyBullets = [];
    this.lastTime = 0;
  }

  spawnMgBullet(origin: Vec3, initialVelocity: Vec3, time: number): void {
    this.mgBullets.push({ origin: copy(origin), v0: copy(initialVelocity), firedAt: time, pos: copy(origin) });
    if (time > this.lastTime) this.lastTime = time;
  }

  spawnMissile(origin: Vec3, direction: Vec3, targetId: string, time: number): void {
    const d = normalize(direction);
    this.missiles.push({
      pos: copy(origin),
      dir: d[0] === 0 && d[1] === 0 && d[2] === 0 ? [0, 0, -1] : d,
      targetId,
      firedAt: time,
      lastObservedPos: null,
      lastObservedVel: null,
      lastObservedAt: null,
      targetLost: false,
    });
    if (time > this.lastTime) this.lastTime = time;
  }

  /**
   * ビーム（§4.4）: 銃口から direction へ最大 120 m のレイ。ステージ遮蔽物と生存中の敵の当たり判定球のうち最も近いもの。
   */
  fireBeam(origin: Vec3, direction: Vec3, world: CollisionWorld, targets: TargetInfo[]): { hitEnemyId: string | null; point: Vec3; distance: number } {
    const range: number = WEAPONS.beam.range;
    const dir = normalize(direction);
    let best: number = range;
    let hitEnemyId: string | null = null;
    const wall = world.raycast(origin, dir, range);
    if (wall && wall.t < best) best = wall.t;
    for (const t of targets) {
      if (!t.alive) continue;
      const d = raySphere(origin, dir, t.center, t.radius, best);
      if (d !== null && d < best) {
        best = d;
        hitEnemyId = t.id;
      }
    }
    return { hitEnemyId, point: addScaled(origin, dir, best), distance: best };
  }

  spawnEnemyBullet(origin: Vec3, direction: Vec3, speed: number, damage: number, lifetime: number, ownerId: string, time: number): void {
    const d = normalize(direction);
    this.enemyBullets.push({
      pos: copy(origin),
      dir: d[0] === 0 && d[1] === 0 && d[2] === 0 ? [0, 0, -1] : d,
      speed,
      damage,
      firedAt: time,
      lifetime,
      ownerId,
    });
    if (time > this.lastTime) this.lastTime = time;
  }

  /**
   * 区間 [time, time+h] を進める。生成時刻が time より後ろの弾体は [firedAt, time+h] だけ進め、
   * 対象の prev→cur の運動もその部分区間に対応する割合だけを使う（生成したばかりの弾を余分に進めない）。
   */
  integrate(h: number, time: number, ctx: ProjectileContext): void {
    if (!(h > 0)) return;
    this.integrateMg(h, time, ctx);
    this.integrateMissiles(h, time, ctx);
    this.integrateEnemyBullets(h, time, ctx);
    this.lastTime = time + h;
  }

  /**
   * 敵への命中処理。撃破された（targetInfoById が alive=false を返す）場合は、この更新の残りの弾体が
   * 貫通するように同じ ctx.targets の球を alive=false にする（次の更新以降は hittables に含まれないため一貫する）。
   */
  private hitEnemy(ctx: ProjectileContext, id: string, amount: number, point: Vec3, weapon: Weapon): void {
    ctx.damageEnemy(id, amount, point, weapon);
    const info = ctx.targetInfoById(id);
    if (info && !info.alive) {
      const s = findSphere(ctx.targets, id);
      if (s) s.alive = false;
    }
  }

  // ---------------------------------------------------------------------------
  // マシンガン弾
  // ---------------------------------------------------------------------------

  private integrateMg(h: number, time: number, ctx: ProjectileContext): void {
    const mg = WEAPONS.machinegun;
    const end = time + h;
    const keep: MgBullet[] = [];
    for (const b of this.mgBullets) {
      const start = Math.max(time, b.firedAt);
      if (end - start <= TIME_EPS) {
        // まだ生成時刻に達していない（Game では起きない）: 進めずに保持
        keep.push(b);
        continue;
      }
      const a0 = start - b.firedAt;
      if (a0 >= mg.lifetime - TIME_EPS) continue; // 既に寿命終端まで検査済み
      const span = end - start;
      const isFinal = a0 + span >= mg.lifetime - TIME_EPS;
      const a1 = isFinal ? Math.min(a0 + span, mg.lifetime) : a0 + span;

      // 放物線を最大ずれ 0.01 m 以下の弦に細分化して順に掃引する（Game の 1/120 s では 1 本）
      const n = Math.max(1, Math.ceil((a1 - a0) / MG_MAX_CHORD_SECONDS - 1e-9));
      let hit = false;
      let pPrev = mgPositionAt(b, a0);
      for (let k = 0; k < n && !hit; k++) {
        const ak0 = a0 + ((a1 - a0) * k) / n;
        const ak1 = k === n - 1 ? a1 : a0 + ((a1 - a0) * (k + 1)) / n;
        const p0 = pPrev;
        const p1 = mgPositionAt(b, ak1);
        pPrev = p1;
        const f0 = (b.firedAt + ak0 - time) / h;
        const f1 = (b.firedAt + ak1 - time) / h;

        let bestT = Infinity;
        let hitId: string | null = null;
        const sh = earliestSphereHit(p0, p1, mg.radius, ctx.targets, f0, f1);
        if (sh) {
          bestT = sh.t;
          hitId = sh.id;
        }
        const wh = ctx.world.sweepSphere(p0, p1, mg.radius);
        if (wh && wh.t < bestT) {
          const point = lerp(p0, p1, wh.t);
          b.pos = point;
          ctx.events.push({ type: 'worldHit', point: copy(point), normal: copy(wh.normal), source: 'machinegun' });
          hit = true;
          break;
        }
        if (hitId !== null) {
          const point = lerp(p0, p1, bestT);
          b.pos = point;
          this.hitEnemy(ctx, hitId, mg.damage, point, 'machinegun');
          hit = true;
          break;
        }
      }
      if (hit) continue;
      b.pos = pPrev;
      if (isFinal) continue; // 寿命終端の区間まで検査してから削除
      keep.push(b);
    }
    this.mgBullets = keep;
  }

  // ---------------------------------------------------------------------------
  // ミサイル
  // ---------------------------------------------------------------------------

  private integrateMissiles(h: number, time: number, ctx: ProjectileContext): void {
    const ms = WEAPONS.missile;
    const maxTurn = degToRad(ms.turnRateDeg);
    const end = time + h;
    const keep: Missile[] = [];
    for (const m of this.missiles) {
      const start = Math.max(time, m.firedAt);
      if (end - start <= TIME_EPS) {
        keep.push(m);
        continue;
      }
      const age = start - m.firedAt;
      const remaining = ms.lifetime - age;
      if (remaining <= TIME_EPS) {
        ctx.events.push({ type: 'missileExpired', point: copy(m.pos) });
        continue;
      }
      const span = end - start;
      const isFinal = span >= remaining - TIME_EPS;
      const step = isFinal ? Math.min(span, remaining) : span;
      const f0 = (start - time) / h;
      const f1 = (start + step - time) / h;

      // 誘導（§4.4）: 対象生存かつミサイルから遮蔽なしなら観測更新、遮蔽中は最後の観測を等速外挿、破壊後は直進。
      // 観測はミサイル位置と同じ時刻 start の対象中心で行う（ctx.targets の prev→cur を start に対応する割合で補間）。
      if (!m.targetLost) {
        const info = ctx.targetInfoById(m.targetId);
        if (!info || !info.alive) {
          m.targetLost = true;
        } else {
          const s = findSphere(ctx.targets, m.targetId);
          const centerNow = s && s.alive ? motionSpan(s.prevCenter, s.center, f0, f1).a : info.center;
          let predictedPos: Vec3 | null = null;
          let predictedVel: Vec3 | null = null;
          if (!ctx.world.segmentBlocked(m.pos, centerNow)) {
            m.lastObservedPos = copy(centerNow);
            m.lastObservedVel = copy(info.velocity);
            m.lastObservedAt = start;
            predictedPos = m.lastObservedPos;
            predictedVel = m.lastObservedVel;
          } else if (m.lastObservedPos && m.lastObservedVel && m.lastObservedAt !== null) {
            predictedPos = addScaled(m.lastObservedPos, m.lastObservedVel, start - m.lastObservedAt);
            predictedVel = m.lastObservedVel;
          }
          if (predictedPos && predictedVel) {
            const r = sub(predictedPos, m.pos);
            const sol = solveLinearLead(r, predictedVel, ms.speed, remaining);
            const wanted = sol ? sol.direction : normalize(r);
            if (!(wanted[0] === 0 && wanted[1] === 0 && wanted[2] === 0)) {
              m.dir = normalize(rotateToward(m.dir, wanted, maxTurn * step));
            }
          }
        }
      }

      const a = m.pos;
      const b = addScaled(a, m.dir, ms.speed * step);
      let bestT = Infinity;
      let hitId: string | null = null;
      const sh = earliestSphereHit(a, b, ms.radius, ctx.targets, f0, f1);
      if (sh) {
        bestT = sh.t;
        hitId = sh.id;
      }
      const wh = ctx.world.sweepSphere(a, b, ms.radius);
      if (wh && wh.t < bestT) {
        const point = lerp(a, b, wh.t);
        m.pos = point;
        ctx.events.push({ type: 'worldHit', point: copy(point), normal: copy(wh.normal), source: 'missile' });
        continue;
      }
      if (hitId !== null) {
        const point = lerp(a, b, bestT);
        m.pos = point;
        this.hitEnemy(ctx, hitId, ms.damage, point, 'missile');
        continue;
      }
      m.pos = b;
      if (isFinal) {
        ctx.events.push({ type: 'missileExpired', point: copy(b) });
        continue;
      }
      keep.push(m);
    }
    this.missiles = keep;
  }

  // ---------------------------------------------------------------------------
  // 敵弾
  // ---------------------------------------------------------------------------

  private integrateEnemyBullets(h: number, time: number, ctx: ProjectileContext): void {
    const radius = ENEMIES.bulletRadius;
    const end = time + h;
    const keep: EnemyBullet[] = [];
    for (const eb of this.enemyBullets) {
      const start = Math.max(time, eb.firedAt);
      if (end - start <= TIME_EPS) {
        keep.push(eb);
        continue;
      }
      const age = start - eb.firedAt;
      const remaining = eb.lifetime - age;
      if (remaining <= TIME_EPS) continue;
      const span = end - start;
      const isFinal = span >= remaining - TIME_EPS;
      const step = isFinal ? Math.min(span, remaining) : span;
      const f0 = (start - time) / h;
      const f1 = (start + step - time) / h;
      const a = eb.pos;
      const b = addScaled(a, eb.dir, eb.speed * step);

      let bestT = Infinity;
      let playerHit = false;
      if (ctx.player) {
        const pm = motionSpan(ctx.player.prevCenter, ctx.player.center, f0, f1);
        const ph = sweptSphereVsMovingBox(a, b, radius, pm.a, pm.b, ctx.player.halfExtents);
        if (ph) {
          bestT = ph.t;
          playerHit = true;
        }
      }
      const wh = ctx.world.sweepSphere(a, b, radius);
      if (wh && wh.t < bestT) {
        const point = lerp(a, b, wh.t);
        eb.pos = point;
        ctx.events.push({ type: 'worldHit', point: copy(point), normal: copy(wh.normal), source: 'enemy' });
        continue;
      }
      if (playerHit) {
        const point = lerp(a, b, bestT);
        eb.pos = point;
        ctx.damagePlayer(eb.damage, point, copy(eb.dir));
        continue;
      }
      eb.pos = b;
      if (isFinal) continue;
      keep.push(eb);
    }
    this.enemyBullets = keep;
  }

  // ---------------------------------------------------------------------------
  // 描画用ビュー
  // ---------------------------------------------------------------------------

  views(): ProjectileView[] {
    const out: ProjectileView[] = [];
    const g = WEAPONS.machinegun.gravity;
    for (const b of this.mgBullets) {
      const age = Math.max(0, this.lastTime - b.firedAt);
      const vel = add(b.v0, scale(g, age));
      const d = normalize(vel);
      out.push({ kind: 'machinegun', position: copy(b.pos), direction: d[0] === 0 && d[1] === 0 && d[2] === 0 ? normalize(b.v0) : d });
    }
    for (const m of this.missiles) out.push({ kind: 'missile', position: copy(m.pos), direction: copy(m.dir) });
    for (const eb of this.enemyBullets) out.push({ kind: 'enemy', position: copy(eb.pos), direction: copy(eb.dir) });
    return out;
  }
}
