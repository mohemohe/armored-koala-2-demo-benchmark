/**
 * 弾体の単体試験: MG 弾の解析放物線と掃引衝突、ミサイルの旋回上限と誘導、敵弾の掃引判定、ビーム。
 */
import { describe, expect, it } from 'vitest';
import { ENEMIES, WEAPONS } from '../src/params';
import { solveLinearLead, solveMachinegunLead } from '../src/sim/ballistics';
import { createCollisionWorld } from '../src/sim/collision';
import { Projectiles, type ProjectileContext } from '../src/sim/projectiles';
import { add, addScaled, degToRad, distance, dot, length, normalize, scale, sub } from '../src/sim/vec';
import type { CollisionWorld, HittableBox, HittableSphere, SimEvent, TargetInfo, Vec3, Weapon } from '../src/types';

const H = 1 / 120;
const M: Vec3 = [0, 20, 0];
const G = WEAPONS.machinegun.gravity;
const MG = WEAPONS.machinegun;
const MS = WEAPONS.missile;

interface DamageCall {
  id: string;
  amount: number;
  point: Vec3;
  weapon: Weapon;
}
interface PlayerDamageCall {
  amount: number;
  point: Vec3;
  dir: Vec3;
}

interface Harness {
  ctx: ProjectileContext;
  damage: DamageCall[];
  playerDamage: PlayerDamageCall[];
  events: SimEvent[];
  set targets(t: HittableSphere[]);
  set player(p: HittableBox | null);
  set infos(map: Record<string, TargetInfo | null>);
}

function makeHarness(world: CollisionWorld = createCollisionWorld()): Harness {
  const damage: DamageCall[] = [];
  const playerDamage: PlayerDamageCall[] = [];
  const events: SimEvent[] = [];
  let infos: Record<string, TargetInfo | null> = {};
  const ctx: ProjectileContext = {
    time: 0,
    world,
    targets: [],
    targetInfoById: (id) => infos[id] ?? null,
    player: null,
    damageEnemy: (id, amount, point, weapon) => {
      damage.push({ id, amount, point: [...point] as Vec3, weapon });
      // Game.damageEnemy と同様に enemyHit イベントを発生させる
      events.push({ type: 'enemyHit', enemyId: id, point: [...point] as Vec3, weapon });
    },
    damagePlayer: (amount, point, dir) => {
      playerDamage.push({ amount, point: [...point] as Vec3, dir: [...dir] as Vec3 });
      events.push({ type: 'playerHit', point: [...point] as Vec3, fromDirection: [...dir] as Vec3, damage: amount });
    },
    events,
  };
  return {
    ctx,
    damage,
    playerDamage,
    events,
    set targets(t: HittableSphere[]) {
      ctx.targets = t;
    },
    set player(p: HittableBox | null) {
      ctx.player = p;
    },
    set infos(map: Record<string, TargetInfo | null>) {
      infos = map;
    },
  };
}

function P(origin: Vec3, v0: Vec3, a: number): Vec3 {
  return addScaled(addScaled(origin, v0, a), G, 0.5 * a * a);
}

function sphere(id: string, prev: Vec3, cur: Vec3, radius = 0.5): HittableSphere {
  return { id, prevCenter: [...prev] as Vec3, center: [...cur] as Vec3, radius, alive: true };
}

/** 等速移動する標的に対して MG 弾を 1/120 刻みで進め、命中までの時刻を返す（なければ null） */
function runMgAgainstTarget(proj: Projectiles, hz: Harness, p: Vec3, v: Vec3, maxSeconds = 2.2, radius = 0.5): number | null {
  let t = 0;
  while (t < maxSeconds) {
    hz.targets = [sphere('t', addScaled(p, v, t), addScaled(p, v, t + H), radius)];
    hz.ctx.time = t;
    proj.integrate(H, t, hz.ctx);
    if (hz.damage.length > 0) return t;
    t += H;
  }
  return null;
}

const MG_CASES: { id: string; r: Vec3; v: Vec3 }[] = [
  { id: 'A03', r: [0, 0, 100], v: [0, 0, 0] },
  { id: 'A05', r: [0, 0, 100], v: [8, 0, 0] },
  { id: 'A09', r: [0, 16, 100], v: [6, 0, 0] },
  { id: 'A13', r: [0, 0, 120], v: [6, 3, 4] },
];

describe('Projectiles: マシンガン弾', () => {
  for (const c of MG_CASES) {
    it(`${c.id}: solveMachinegunLead の v0 で発射した弾が等速移動する 0.5 m 標的に命中する`, () => {
      const sol = solveMachinegunLead(c.r, c.v, MG.speed, G, MG.solveMaxTime);
      expect(sol).not.toBeNull();
      const v0 = scale(sol!.direction, MG.speed);
      const proj = new Projectiles();
      const hz = makeHarness();
      proj.spawnMgBullet(M, v0, 0);
      const p = add(M, c.r);
      const hitAt = runMgAgainstTarget(proj, hz, p, c.v);
      expect(hitAt).not.toBeNull();
      expect(hz.damage).toHaveLength(1);
      expect(hz.damage[0].id).toBe('t');
      expect(hz.damage[0].amount).toBe(MG.damage);
      expect(hz.damage[0].weapon).toBe('machinegun');
      expect(hz.events.filter((e) => e.type === 'enemyHit')).toHaveLength(1);
      // 命中は中心到達時刻より僅かに前（標的半径 0.5 + 弾 0.08 → 約 0.006 s）
      expect(hitAt!).toBeLessThanOrEqual(sol!.t);
      expect(hitAt!).toBeGreaterThan(sol!.t - 0.02);
      // 命中で削除
      expect(proj.mgBullets).toHaveLength(0);
      // 追加の更新でも二重ダメージなし
      hz.targets = [];
      proj.integrate(H, hitAt! + H, hz.ctx);
      expect(hz.damage).toHaveLength(1);
    });
  }

  it('高速に横切る球には、終端位置だけの判定では外れるが掃引判定で命中する', () => {
    const proj = new Projectiles();
    const hz = makeHarness();
    const v0: Vec3 = [0, 0, MG.speed];
    proj.spawnMgBullet(M, v0, 0);
    // 0.5 s まで標的なしで進める
    let t = 0;
    const n = Math.round(0.5 / H);
    for (let i = 0; i < n; i++) {
      proj.integrate(H, t, hz.ctx);
      t += H;
    }
    expect(proj.mgBullets).toHaveLength(1);
    const p0 = P(M, v0, t);
    const p1 = P(M, v0, t + H);
    // この 1 刻みで x=-20 → +20 を横切る球（4800 m/s）。中心は弾道上（y は刻みの中央、z は刻みの中央）
    const y = 0.5 * (p0[1] + p1[1]);
    const z = 0.5 * (p0[2] + p1[2]);
    const prev: Vec3 = [-20, y, z];
    const cur: Vec3 = [20, y, z];
    // 終端位置だけの判定なら外れることを確認
    expect(distance(p1, cur)).toBeGreaterThan(0.5 + MG.radius);
    hz.targets = [sphere('x', prev, cur)];
    proj.integrate(H, t, hz.ctx);
    expect(hz.damage).toHaveLength(1);
    expect(hz.damage[0].id).toBe('x');
    expect(proj.mgBullets).toHaveLength(0);
  });

  it('壁で止まる（worldHit）。壁の向こうの標的にはダメージなし', () => {
    const world = createCollisionWorld();
    world.addCollider({ min: [-50, 0, 30], max: [50, 40, 31] }, 'wall');
    const hz = makeHarness(world);
    const proj = new Projectiles();
    const sol = solveMachinegunLead([0, 0, 100], [0, 0, 0], MG.speed, G, MG.solveMaxTime)!;
    proj.spawnMgBullet(M, scale(sol.direction, MG.speed), 0);
    const hitAt = runMgAgainstTarget(proj, hz, [0, 20, 100], [0, 0, 0]);
    expect(hitAt).toBeNull();
    expect(hz.damage).toHaveLength(0);
    const wh = hz.events.filter((e) => e.type === 'worldHit');
    expect(wh).toHaveLength(1);
    if (wh[0].type === 'worldHit') {
      expect(wh[0].source).toBe('machinegun');
      expect(wh[0].point[2]).toBeCloseTo(30 - MG.radius, 6);
      expect(wh[0].normal).toEqual([0, 0, -1]);
    }
    expect(proj.mgBullets).toHaveLength(0);
  });

  it('寿命 2 s の終端区間まで検査してから削除する', () => {
    const v0: Vec3 = [0, 0, MG.speed];
    // (1) 標的なし: 寿命終端の区間を処理した更新で削除される
    {
      const proj = new Projectiles();
      const hz = makeHarness();
      proj.spawnMgBullet(M, v0, 0);
      const steps = Math.round(MG.lifetime / H); // 240
      let t = 0;
      for (let i = 0; i < steps - 1; i++) {
        proj.integrate(H, t, hz.ctx);
        t += H;
        expect(proj.mgBullets).toHaveLength(1);
      }
      proj.integrate(H, t, hz.ctx);
      expect(proj.mgBullets).toHaveLength(0);
    }
    // (2) 終端 P(2) にある球は最後の区間で命中する（区間を跨ぐ大きな h でも寿命で打ち切る）
    {
      const proj = new Projectiles();
      const hz = makeHarness();
      proj.spawnMgBullet(M, v0, 0);
      const t0 = MG.lifetime - 0.01;
      // まず t0 まで一気に進める（標的なし）
      proj.integrate(t0, 0, hz.ctx);
      expect(proj.mgBullets).toHaveLength(1);
      const end = P(M, v0, MG.lifetime);
      hz.targets = [sphere('end', end, end)];
      proj.integrate(0.05, t0, hz.ctx); // a1 は 2.0 で打ち切り
      expect(hz.damage).toHaveLength(1);
      expect(hz.damage[0].id).toBe('end');
      expect(proj.mgBullets).toHaveLength(0);
    }
    // (3) 寿命を越えた先 P(2.02) の球には当たらない（寿命後まで飛ばさない）
    {
      const proj = new Projectiles();
      const hz = makeHarness();
      proj.spawnMgBullet(M, v0, 0);
      const t0 = MG.lifetime - 0.01;
      proj.integrate(t0, 0, hz.ctx);
      const beyond = P(M, v0, MG.lifetime + 0.02);
      expect(distance(beyond, P(M, v0, MG.lifetime))).toBeGreaterThan(0.5 + MG.radius);
      hz.targets = [sphere('beyond', beyond, beyond)];
      proj.integrate(0.05, t0, hz.ctx);
      expect(hz.damage).toHaveLength(0);
      expect(proj.mgBullets).toHaveLength(0);
    }
  });

  it('位置は解析的な放物線 origin + v0·a + 0.5·g·a² に従う（1e-9 以内）', () => {
    const sol = solveMachinegunLead([0, 0, 100], [8, 0, 0], MG.speed, G, MG.solveMaxTime)!;
    const v0 = scale(sol.direction, MG.speed);
    const proj = new Projectiles();
    const hz = makeHarness();
    proj.spawnMgBullet(M, v0, 0.25);
    const bullet = proj.mgBullets[0];
    expect(bullet.origin).toEqual(M);
    expect(bullet.v0).toEqual(v0);
    expect(bullet.firedAt).toBe(0.25);
    // 発射時刻から 1/120 刻みで進め、複数の年齢で比較
    let t = 0.25;
    const checkpoints = new Set([12, 60, 120, 204]);
    for (let i = 1; i <= 204; i++) {
      proj.integrate(H, t, hz.ctx);
      t += H;
      if (checkpoints.has(i)) {
        const a = t - 0.25;
        const exp = P(M, v0, a);
        expect(Math.abs(proj.mgBullets[0].pos[0] - exp[0])).toBeLessThan(1e-9);
        expect(Math.abs(proj.mgBullets[0].pos[1] - exp[1])).toBeLessThan(1e-9);
        expect(Math.abs(proj.mgBullets[0].pos[2] - exp[2])).toBeLessThan(1e-9);
      }
    }
    // 大きな 1 刻みでも同じ式
    const proj2 = new Projectiles();
    proj2.spawnMgBullet(M, v0, 0);
    proj2.integrate(0.37, 0, hz.ctx);
    const e2 = P(M, v0, 0.37);
    expect(distance(proj2.mgBullets[0].pos, e2)).toBeLessThan(1e-9);
    // views の方向は現在速度 v0 + g·a の向き
    const views = proj2.views();
    expect(views).toHaveLength(1);
    expect(views[0].kind).toBe('machinegun');
    expect(distance(views[0].direction, normalize(addScaled(v0, G, 0.37)))).toBeLessThan(1e-9);
  });

  it('発射後に標的が動いても弾は曲がらない（軌道は発射時の v0 だけで決まる）', () => {
    const sol = solveMachinegunLead([0, 0, 100], [8, 0, 0], MG.speed, G, MG.solveMaxTime)!;
    const v0 = scale(sol.direction, MG.speed);
    const proj = new Projectiles();
    const hz = makeHarness();
    proj.spawnMgBullet(M, v0, 0);
    // 標的が発射直後に急旋回して逆方向へ（弾は放物線を保ち、外れる）
    const p: Vec3 = [0, 20, 100];
    let t = 0;
    while (t < 1.5) {
      const vv: Vec3 = [-30, 0, 0];
      hz.targets = [sphere('t', addScaled(p, vv, t), addScaled(p, vv, t + H))];
      proj.integrate(H, t, hz.ctx);
      t += H;
      if (proj.mgBullets.length === 1) {
        expect(distance(proj.mgBullets[0].pos, P(M, v0, t))).toBeLessThan(1e-9);
      }
    }
    expect(hz.damage).toHaveLength(0);
  });
});

describe('Projectiles: ミサイル', () => {
  function infoOf(id: string, center: Vec3, velocity: Vec3, alive = true): TargetInfo {
    return { id, alive, center: [...center] as Vec3, velocity: [...velocity] as Vec3, radius: 0.5 };
  }

  it('旋回速度は 120°/s 以下に制限され、それでも到達できる標的には命中する', () => {
    const proj = new Projectiles();
    const hz = makeHarness();
    const center: Vec3 = [40, 20, 30];
    proj.spawnMissile(M, [0, 0, 1], 't', 0);
    const limit = degToRad(MS.turnRateDeg);
    let t = 0;
    let maxRate = 0;
    let hitAt: number | null = null;
    while (t < MS.lifetime + 0.1 && proj.missiles.length === 1) {
      const before = [...proj.missiles[0].dir] as Vec3;
      hz.infos = { t: infoOf('t', center, [0, 0, 0]) };
      hz.targets = [sphere('t', center, center)];
      hz.ctx.time = t;
      proj.integrate(H, t, hz.ctx);
      t += H;
      if (proj.missiles.length === 1) {
        const after = proj.missiles[0].dir;
        const ang = Math.acos(Math.max(-1, Math.min(1, dot(normalize(before), normalize(after)))));
        maxRate = Math.max(maxRate, ang / H);
        expect(ang).toBeLessThanOrEqual(limit * H + 1e-6);
        // 速度 45 m/s 固定（方向は単位）
        expect(length(after)).toBeCloseTo(1, 9);
      } else if (hz.damage.length > 0) {
        hitAt = t;
      }
    }
    expect(hitAt).not.toBeNull();
    expect(hz.damage).toHaveLength(1);
    expect(hz.damage[0].amount).toBe(MS.damage);
    expect(hz.damage[0].weapon).toBe('missile');
    // 初期方向から大きく曲がる必要があるので上限近くまで旋回している
    expect(maxRate).toBeGreaterThan(limit * 0.99);
  });

  it('A05 の偏差方向で発射し、8 m/s で横移動する 0.5 m 標的に誘導命中する', () => {
    const r: Vec3 = [0, 0, 100];
    const v: Vec3 = [8, 0, 0];
    const sol = solveLinearLead(r, v, MS.speed, MS.solveMaxTime);
    expect(sol).not.toBeNull();
    const proj = new Projectiles();
    const hz = makeHarness();
    proj.spawnMissile(M, sol!.direction, 't', 0);
    const p = add(M, r);
    let t = 0;
    let hitAt: number | null = null;
    while (t < MS.lifetime + 0.1 && proj.missiles.length === 1) {
      const c0 = addScaled(p, v, t);
      const c1 = addScaled(p, v, t + H);
      hz.infos = { t: infoOf('t', c0, v) };
      hz.targets = [sphere('t', c0, c1)];
      hz.ctx.time = t;
      proj.integrate(H, t, hz.ctx);
      t += H;
      if (hz.damage.length > 0) hitAt = t;
    }
    expect(hitAt).not.toBeNull();
    expect(hitAt!).toBeLessThan(MS.lifetime);
    expect(hitAt!).toBeCloseTo(sol!.t, 1);
    expect(hz.damage).toHaveLength(1);
    expect(hz.damage[0].id).toBe('t');
    expect(hz.damage[0].amount).toBe(MS.damage);
    expect(hz.events.filter((e) => e.type === 'missileExpired')).toHaveLength(0);
  });

  it('対象を失ったら直進し、別の敵へ乗り換えない。寿命 4 s で missileExpired', () => {
    const proj = new Projectiles();
    const hz = makeHarness();
    proj.spawnMissile(M, [0, 0, 1], 't', 0);
    const center: Vec3 = [30, 20, 80];
    let t = 0;
    // 0.5 s は誘導
    for (let i = 0; i < 60; i++) {
      hz.infos = { t: infoOf('t', center, [0, 0, 0]) };
      hz.targets = [sphere('t', center, center)];
      proj.integrate(H, t, hz.ctx);
      t += H;
    }
    expect(proj.missiles).toHaveLength(1);
    const dirAtLoss = [...proj.missiles[0].dir] as Vec3;
    expect(dirAtLoss[0]).toBeGreaterThan(0); // 標的方向へ曲がり始めている
    const posAtLoss = [...proj.missiles[0].pos] as Vec3;
    const tLoss = t;
    // 対象破壊: 別の敵 'other' がミサイルの近くにいても乗り換えない
    let expired: SimEvent | undefined;
    while (t < MS.lifetime + 0.1 && proj.missiles.length === 1) {
      hz.infos = { t: infoOf('t', center, [0, 0, 0], false), other: infoOf('other', [-50, 20, 60], [0, 0, 0]) };
      hz.targets = [];
      proj.integrate(H, t, hz.ctx);
      t += H;
      if (proj.missiles.length === 1) {
        expect(proj.missiles[0].targetLost).toBe(true);
        expect(distance(proj.missiles[0].dir, dirAtLoss)).toBeLessThan(1e-12);
        const expected = addScaled(posAtLoss, dirAtLoss, MS.speed * (t - tLoss));
        expect(distance(proj.missiles[0].pos, expected)).toBeLessThan(1e-6);
      }
      expired = hz.events.find((e) => e.type === 'missileExpired');
    }
    expect(proj.missiles).toHaveLength(0);
    expect(expired).toBeDefined();
    expect(hz.damage).toHaveLength(0);
    expect(t).toBeCloseTo(MS.lifetime, 2);
  });

  it('遮蔽中は最後の観測を等速外挿し、壁には衝突する', () => {
    const world = createCollisionWorld();
    // ミサイル進路上の壁（z=40）
    world.addCollider({ min: [-50, 0, 40], max: [50, 40, 41] }, 'wall');
    const proj = new Projectiles();
    const hz = makeHarness(world);
    proj.spawnMissile(M, [0, 0, 1], 't', 0);
    const p: Vec3 = [0, 20, 100];
    const v: Vec3 = [8, 0, 0];
    let t = 0;
    let lastObs: number | null = null;
    while (t < MS.lifetime && proj.missiles.length === 1) {
      const c0 = addScaled(p, v, t);
      hz.infos = { t: infoOf('t', c0, v) };
      hz.targets = [sphere('t', c0, addScaled(p, v, t + H))];
      proj.integrate(H, t, hz.ctx);
      // 壁の手前では観測が更新されないことを確認（最初から遮蔽されている）
      if (proj.missiles.length === 1) lastObs = proj.missiles[0].lastObservedAt;
      t += H;
    }
    expect(lastObs).toBeNull(); // 発射位置からも遮蔽されていたので一度も観測していない
    const wh = hz.events.filter((e) => e.type === 'worldHit');
    expect(wh).toHaveLength(1);
    if (wh[0].type === 'worldHit') {
      expect(wh[0].source).toBe('missile');
      expect(wh[0].point[2]).toBeCloseTo(40 - MS.radius, 6);
    }
    expect(hz.damage).toHaveLength(0);
    expect(proj.missiles).toHaveLength(0);

    // 観測後に遮蔽された場合: 観測値を保持し、等速外挿の方向へ旋回する
    const world2 = createCollisionWorld();
    const proj2 = new Projectiles();
    const hz2 = makeHarness(world2);
    proj2.spawnMissile(M, [0, 0, 1], 't', 0);
    const c: Vec3 = [20, 20, 60];
    hz2.infos = { t: infoOf('t', c, [0, 0, 5]) };
    hz2.targets = [sphere('t', c, c)];
    proj2.integrate(H, 0, hz2.ctx);
    expect(proj2.missiles[0].lastObservedAt).toBe(0);
    expect(proj2.missiles[0].lastObservedPos).toEqual(c);
    expect(proj2.missiles[0].lastObservedVel).toEqual([0, 0, 5]);
    // ここで遮蔽（ミサイルと対象の間に壁）。対象の実位置を大きく動かしても観測は更新されない
    const cid = world2.addCollider({ min: [-100, 0, 20], max: [100, 40, 21] }, 'wall');
    hz2.infos = { t: infoOf('t', [-50, 20, 60], [0, 0, 5]) };
    hz2.targets = [];
    const d0 = [...proj2.missiles[0].dir] as Vec3;
    proj2.integrate(H, H, hz2.ctx);
    expect(proj2.missiles[0].lastObservedAt).toBe(0);
    expect(proj2.missiles[0].lastObservedPos).toEqual(c);
    // 外挿位置（x>0）へ曲がる: x 成分が増える
    expect(proj2.missiles[0].dir[0]).toBeGreaterThan(d0[0]);
    world2.removeCollider(cid);
  });
});

describe('Projectiles: 敵弾', () => {
  const half = [0.8, 1.5, 0.8] as Vec3;

  it('移動するプレイヤーの箱に掃引で命中し、damagePlayer を 1 回だけ呼ぶ', () => {
    const proj = new Projectiles();
    const hz = makeHarness();
    const origin: Vec3 = [0, 2, 0];
    const dir: Vec3 = [0, 0, 1];
    proj.spawnEnemyBullet(origin, dir, ENEMIES.guard.bulletSpeed, ENEMIES.guard.damage, ENEMIES.guard.bulletLifetime, 'g1', 0);
    expect(proj.enemyBullets).toHaveLength(1);
    // プレイヤー中心: (-2.5, 1.5, 35) から x 方向 +5 m/s → t=0.5 で x=0（弾も z=35 に到達）
    const c0: Vec3 = [-2.5, 1.5, 35];
    const pv: Vec3 = [5, 0, 0];
    let t = 0;
    let hitAt: number | null = null;
    while (t < 1.5) {
      hz.player = { prevCenter: addScaled(c0, pv, t), center: addScaled(c0, pv, t + H), halfExtents: half };
      proj.integrate(H, t, hz.ctx);
      t += H;
      if (hz.playerDamage.length > 0 && hitAt === null) hitAt = t;
    }
    expect(hitAt).not.toBeNull();
    expect(hz.playerDamage).toHaveLength(1);
    expect(hz.playerDamage[0].amount).toBe(ENEMIES.guard.damage);
    expect(hz.playerDamage[0].dir).toEqual(dir);
    expect(hz.playerDamage[0].point[2]).toBeCloseTo(35 - half[2] - ENEMIES.bulletRadius, 3);
    expect(proj.enemyBullets).toHaveLength(0);
    expect(hz.events.filter((e) => e.type === 'playerHit')).toHaveLength(1);
  });

  it('高速に横切るプレイヤーにも命中する（終端位置だけの判定では外れる）', () => {
    const proj = new Projectiles();
    const hz = makeHarness();
    proj.spawnEnemyBullet([0, 2, 0], [0, 0, 1], 70, 18, 2, 'g1', 0);
    // t=0.5 で弾は z=35。この刻みでプレイヤーが x=-30 → +30 を横切る
    const n = Math.round(0.5 / H);
    let t = 0;
    for (let i = 0; i < n; i++) {
      proj.integrate(H, t, hz.ctx);
      t += H;
    }
    const prev: Vec3 = [-30, 2, 35.3];
    const cur: Vec3 = [30, 2, 35.3];
    hz.player = { prevCenter: prev, center: cur, halfExtents: half };
    proj.integrate(H, t, hz.ctx);
    expect(hz.playerDamage).toHaveLength(1);
  });

  it('壁で止まり（worldHit source=enemy）、壁の向こうのプレイヤーにダメージはない', () => {
    const world = createCollisionWorld();
    world.addCollider({ min: [-50, 0, 20], max: [50, 40, 21] }, 'wall');
    const proj = new Projectiles();
    const hz = makeHarness(world);
    proj.spawnEnemyBullet([0, 2, 0], [0, 0, 1], 60, 40, 3, 'tur', 0);
    let t = 0;
    while (t < 1 && proj.enemyBullets.length === 1) {
      hz.player = { prevCenter: [0, 1.5, 35], center: [0, 1.5, 35], halfExtents: half };
      proj.integrate(H, t, hz.ctx);
      t += H;
    }
    expect(hz.playerDamage).toHaveLength(0);
    const wh = hz.events.filter((e) => e.type === 'worldHit');
    expect(wh).toHaveLength(1);
    if (wh[0].type === 'worldHit') {
      expect(wh[0].source).toBe('enemy');
      expect(wh[0].point[2]).toBeCloseTo(20 - ENEMIES.bulletRadius, 6);
    }
    expect(proj.enemyBullets).toHaveLength(0);
  });

  it('敵弾は敵に当たらず、プレイヤー死亡時（null）は誰にも当たらない。寿命で消える', () => {
    const proj = new Projectiles();
    const hz = makeHarness();
    proj.spawnEnemyBullet([0, 2, 0], [0, 0, 1], 70, 18, 2, 'g1', 0);
    let t = 0;
    while (t < 2.5 && proj.enemyBullets.length === 1) {
      const c: Vec3 = [0, 2, 10];
      hz.targets = [sphere('e', c, c, 1.3)];
      hz.player = null;
      proj.integrate(H, t, hz.ctx);
      t += H;
    }
    expect(hz.damage).toHaveLength(0);
    expect(hz.playerDamage).toHaveLength(0);
    expect(proj.enemyBullets).toHaveLength(0);
    expect(t).toBeCloseTo(2, 2);
  });
});

describe('Projectiles: ビーム', () => {
  it('遮蔽物と敵のうち最も近いものに当たり、射程 120 m を超えない', () => {
    const world = createCollisionWorld();
    world.addCollider({ min: [-50, 0, 50], max: [50, 40, 51] }, 'wall');
    const proj = new Projectiles();
    const dir: Vec3 = [0, 0, 1];
    const near: TargetInfo = { id: 'near', alive: true, center: [0, 20, 30], velocity: [0, 0, 0], radius: 0.5 };
    const behind: TargetInfo = { id: 'behind', alive: true, center: [0, 20, 80], velocity: [0, 0, 0], radius: 0.5 };
    const dead: TargetInfo = { id: 'dead', alive: false, center: [0, 20, 10], velocity: [0, 0, 0], radius: 0.5 };
    // 手前の敵
    let hit = proj.fireBeam(M, dir, world, [dead, behind, near]);
    expect(hit.hitEnemyId).toBe('near');
    expect(hit.distance).toBeCloseTo(30 - 0.5, 9);
    expect(hit.point[2]).toBeCloseTo(29.5, 9);
    // 壁の向こうの敵には当たらない（壁で止まる）
    hit = proj.fireBeam(M, dir, world, [dead, behind]);
    expect(hit.hitEnemyId).toBeNull();
    expect(hit.distance).toBeCloseTo(50, 9);
    expect(hit.point).toEqual([0, 20, 50]);
    // 射程外
    const far: TargetInfo = { id: 'far', alive: true, center: [0, 20, 130], velocity: [0, 0, 0], radius: 0.5 };
    hit = proj.fireBeam(M, dir, createCollisionWorld(), [far]);
    expect(hit.hitEnemyId).toBeNull();
    expect(hit.distance).toBe(WEAPONS.beam.range);
    expect(hit.point).toEqual([0, 20, WEAPONS.beam.range]);
    // 射程ぎりぎり内側
    const edge: TargetInfo = { id: 'edge', alive: true, center: [0, 20, 120.3], velocity: [0, 0, 0], radius: 0.5 };
    hit = proj.fireBeam(M, dir, createCollisionWorld(), [edge]);
    expect(hit.hitEnemyId).toBe('edge');
    expect(hit.distance).toBeCloseTo(119.8, 9);
    // 方向が正規化されていなくても同じ結果
    hit = proj.fireBeam(M, [0, 0, 7], createCollisionWorld(), [edge]);
    expect(hit.hitEnemyId).toBe('edge');
  });
});

describe('Projectiles: reset / views', () => {
  it('reset で全弾体を破棄し、views は各種弾体を返す', () => {
    const proj = new Projectiles();
    proj.spawnMgBullet(M, [0, 0, 100], 0);
    proj.spawnMissile(M, [0, 0, 1], 't', 0);
    proj.spawnEnemyBullet([5, 2, 5], [1, 0, 0], 70, 18, 2, 'g', 0);
    const views = proj.views();
    expect(views.map((v) => v.kind).sort()).toEqual(['enemy', 'machinegun', 'missile']);
    for (const v of views) expect(length(v.direction)).toBeCloseTo(1, 9);
    proj.reset();
    expect(proj.mgBullets).toHaveLength(0);
    expect(proj.missiles).toHaveLength(0);
    expect(proj.enemyBullets).toHaveLength(0);
    expect(proj.views()).toHaveLength(0);
  });
});

describe('Projectiles: 回帰（レビュー指摘）生成時刻が区間の途中の弾体は残りの区間だけ進める（§9）', () => {
  it('MG 弾: firedAt = time + h/2 の弾は integrate(h, time) で年齢 h/2 だけ進み、次の区間で 3h/2 になる', () => {
    const proj = new Projectiles();
    const hz = makeHarness();
    const v0: Vec3 = [0, 0, MG.speed];
    proj.spawnMgBullet(M, v0, H / 2);
    proj.integrate(H, 0, hz.ctx);
    expect(distance(proj.mgBullets[0].pos, P(M, v0, H / 2))).toBeLessThan(1e-9);
    proj.integrate(H, H, hz.ctx);
    expect(distance(proj.mgBullets[0].pos, P(M, v0, 1.5 * H))).toBeLessThan(1e-9);
  });

  it('ミサイル・敵弾: firedAt = time + h/2 なら speed·h/2 だけ進む（h 全体ではない）', () => {
    const proj = new Projectiles();
    const hz = makeHarness();
    proj.spawnMissile(M, [0, 0, 1], 't', H / 2);
    proj.spawnEnemyBullet(M, [0, 0, 1], 70, 10, 2, 'e1', H / 2);
    hz.infos = {}; // 対象なし → 直進
    proj.integrate(H, 0, hz.ctx);
    expect(proj.missiles[0].pos[2]).toBeCloseTo(M[2] + (MS.speed * H) / 2, 9);
    expect(proj.enemyBullets[0].pos[2]).toBeCloseTo(M[2] + (70 * H) / 2, 9);
    proj.integrate(H, H, hz.ctx);
    expect(proj.missiles[0].pos[2]).toBeCloseTo(M[2] + MS.speed * 1.5 * H, 9);
    expect(proj.enemyBullets[0].pos[2]).toBeCloseTo(M[2] + 70 * 1.5 * H, 9);
  });

  it('区間終端以降に生成された弾体は進めずに保持する', () => {
    const proj = new Projectiles();
    const hz = makeHarness();
    proj.spawnMgBullet(M, [0, 0, MG.speed], 2 * H);
    proj.spawnMissile(M, [0, 0, 1], 't', 2 * H);
    proj.spawnEnemyBullet(M, [0, 0, 1], 70, 10, 2, 'e1', 2 * H);
    proj.integrate(H, 0, hz.ctx);
    expect(proj.mgBullets).toHaveLength(1);
    expect(proj.missiles).toHaveLength(1);
    expect(proj.enemyBullets).toHaveLength(1);
    expect(proj.mgBullets[0].pos).toEqual(M);
    expect(proj.missiles[0].pos).toEqual(M);
    expect(proj.enemyBullets[0].pos).toEqual(M);
  });

  it('部分区間では対象の運動も同じ部分区間だけを使う（弾の生成前に通過した標的には当たらず、生成後に通過する標的には当たる）', () => {
    const run = (prev: Vec3, cur: Vec3): number => {
      const proj = new Projectiles();
      const hz = makeHarness();
      proj.spawnMgBullet(M, [0, 0, MG.speed], H / 2); // 区間 [0, H] の中央で生成
      hz.targets = [sphere('t', prev, cur, 0.3)];
      proj.integrate(H, 0, hz.ctx);
      return hz.damage.length;
    };
    // 標的は x 方向に横切る。区間の 1/4（弾の生成前）に弾道を通過 → 生成時には既に 1 m 離れている
    expect(run([-1, 20, 0.2], [3, 20, 0.2])).toBe(0);
    // 区間の 3/4（弾の生成後）に弾道を通過 → 命中
    expect(run([-3, 20, 0.2], [1, 20, 0.2])).toBe(1);
  });
});

describe('Projectiles: 回帰（レビュー指摘）ミサイルの観測はミサイル位置と同じ時刻（区間始点）の対象中心', () => {
  it('lastObservedPos は ctx.targets の prevCenter（時刻 time の中心）、lastObservedAt は time。info.center（区間終点）は使わない', () => {
    const proj = new Projectiles();
    const hz = makeHarness();
    const t0 = 0.8;
    const v: Vec3 = [8, 0, 0];
    const c0: Vec3 = [6.4, 20, 60];
    const c1 = addScaled(c0, v, H);
    proj.spawnMissile(M, [0, 0, 1], 't', t0);
    hz.targets = [sphere('t', c0, c1)];
    // Game と同じく、targetInfoById は enemies.integrate 後（区間終点）の中心を返す
    hz.infos = { t: { id: 't', alive: true, center: [...c1] as Vec3, velocity: [...v] as Vec3, radius: 0.5 } };
    hz.ctx.time = t0;
    proj.integrate(H, t0, hz.ctx);
    const m = proj.missiles[0];
    expect(m.lastObservedAt).toBe(t0);
    expect(m.lastObservedPos).toEqual(c0);
    expect(m.lastObservedVel).toEqual(v);
    // 次の区間でも一貫: 観測時刻と観測位置の組は「その時刻の実位置」と一致する
    const c2 = addScaled(c0, v, 2 * H);
    hz.targets = [sphere('t', c1, c2)];
    hz.infos = { t: { id: 't', alive: true, center: [...c2] as Vec3, velocity: [...v] as Vec3, radius: 0.5 } };
    hz.ctx.time = t0 + H;
    proj.integrate(H, t0 + H, hz.ctx);
    expect(m.lastObservedAt).toBeCloseTo(t0 + H, 12);
    expect(distance(m.lastObservedPos!, addScaled(c0, v, m.lastObservedAt! - t0))).toBeLessThan(1e-9);
  });

  it('ctx.targets に球がない場合だけ info.center を観測位置として使う', () => {
    const proj = new Projectiles();
    const hz = makeHarness();
    const c: Vec3 = [20, 20, 60];
    proj.spawnMissile(M, [0, 0, 1], 't', 0);
    hz.targets = [];
    hz.infos = { t: { id: 't', alive: true, center: [...c] as Vec3, velocity: [0, 0, 5], radius: 0.5 } };
    proj.integrate(H, 0, hz.ctx);
    expect(proj.missiles[0].lastObservedAt).toBe(0);
    expect(proj.missiles[0].lastObservedPos).toEqual(c);
  });
});

describe('Projectiles: 回帰（レビュー指摘）放物線の弦の細分化（§4.5: 曲線からのずれ 0.01 m 以下）', () => {
  it('h = 0.1 s（1 本の弦なら矢高 0.0225 m）でも、かすめる標的に当たり、0.005 m 離れた標的には当たらない', () => {
    const v0: Vec3 = [0, 0, MG.speed];
    const h = 0.1;
    const pm = P(M, v0, h / 2); // 弦の中央に対応する放物線上の点
    const rs = 0.02;
    const run = (center: Vec3): number => {
      const proj = new Projectiles();
      const hz = makeHarness();
      proj.spawnMgBullet(M, v0, 0);
      hz.targets = [sphere('t', center, center, rs)];
      proj.integrate(h, 0, hz.ctx);
      return hz.damage.length;
    };
    // 放物線の上側を貫入 0.004 m でかすめる標的: 弦が放物線の 0.0225 m 下を通ると外れてしまう
    expect(run(add(pm, [0, MG.radius + rs - 0.004, 0]))).toBe(1);
    // 放物線の下側で 0.005 m 離れている標的: 弦が下を通ると誤って当たってしまう
    expect(run(add(pm, [0, -(MG.radius + rs + 0.005), 0]))).toBe(0);
    // 細分化しても解析位置は変わらない
    const proj = new Projectiles();
    const hz = makeHarness();
    proj.spawnMgBullet(M, v0, 0);
    proj.integrate(h, 0, hz.ctx);
    expect(distance(proj.mgBullets[0].pos, P(M, v0, h))).toBeLessThan(1e-9);
  });
});

describe('Projectiles: 回帰（レビュー指摘）同一更新内の撃破', () => {
  function killHarness(hp: number): { ctx: ProjectileContext; damage: DamageCall[]; alive: () => boolean } {
    const world = createCollisionWorld();
    const events: SimEvent[] = [];
    const damage: DamageCall[] = [];
    const center: Vec3 = [0, 20, 10];
    let alive = true;
    const ctx: ProjectileContext = {
      time: 0,
      world,
      targets: [sphere('t', center, center)],
      targetInfoById: (id) => (id === 't' ? { id, alive, center: [...center] as Vec3, velocity: [0, 0, 0], radius: 0.5 } : null),
      player: null,
      damageEnemy: (id, amount, point, weapon) => {
        // Game.damageEnemy / EnemyManager.damage と同様: 死亡後は何もしない
        if (!alive) return;
        damage.push({ id, amount, point: [...point] as Vec3, weapon });
        hp -= amount;
        if (hp <= 0) alive = false;
      },
      damagePlayer: () => {},
      events,
    };
    return { ctx, damage, alive: () => alive };
  }

  it('先の弾が敵を撃破したら、同じ更新の後続弾は貫通して飛び続ける（damageEnemy を呼ばず、消えもしない）', () => {
    const { ctx, damage, alive } = killHarness(MG.damage); // 1 発で撃破
    const proj = new Projectiles();
    const v0: Vec3 = [0, 0, MG.speed];
    proj.spawnMgBullet(M, v0, 0);
    proj.spawnMgBullet(M, v0, 0.005); // 0.5 m 後方
    proj.integrate(0.09, 0, ctx); // 標的の手前（z=9.0 / 8.5）まで
    expect(damage).toHaveLength(0);
    proj.integrate(0.02, 0.09, ctx); // 2 発とも標的を通過する区間
    expect(damage).toHaveLength(1);
    expect(alive()).toBe(false);
    expect(ctx.targets[0].alive).toBe(false);
    expect(proj.mgBullets).toHaveLength(1);
    expect(distance(proj.mgBullets[0].pos, P(M, v0, 0.105))).toBeLessThan(1e-9);
  });

  it('撃破に至らなければ同じ更新の後続弾も命中する', () => {
    const { ctx, damage, alive } = killHarness(1000);
    const proj = new Projectiles();
    const v0: Vec3 = [0, 0, MG.speed];
    proj.spawnMgBullet(M, v0, 0);
    proj.spawnMgBullet(M, v0, 0.005);
    proj.integrate(0.09, 0, ctx);
    proj.integrate(0.02, 0.09, ctx);
    expect(damage).toHaveLength(2);
    expect(alive()).toBe(true);
    expect(ctx.targets[0].alive).toBe(true);
    expect(proj.mgBullets).toHaveLength(0);
  });
});
