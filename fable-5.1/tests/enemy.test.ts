/**
 * 敵 AI（src/sim/enemy.ts）の試験。仕様 §2.3 / ARCHITECTURE §3.8。
 * Game と同じ刻み（最大 1/120 s、nextEventTime で分割、境界で fireDue → beginStep → integrate）で回す。
 * 弾体は呼び出しを記録する偽 Projectiles に置き換える。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_LOADOUT, ENEMIES, PLAYER } from '../src/params';
import { solveLinearLead } from '../src/sim/ballistics';
import { createCollisionWorld } from '../src/sim/collision';
import { EnemyManager, type EnemyContext } from '../src/sim/enemy';
import { Game } from '../src/sim/game';
import { NavGrid } from '../src/sim/nav';
import type { Projectiles } from '../src/sim/projectiles';
import { Rng } from '../src/sim/rng';
import { add, addScaled, distance, distanceXZ, dot, forwardFromYaw, length, normalize, radToDeg, scale, sub } from '../src/sim/vec';
import { emptyInput, type AABB, type CollisionWorld, type EnemyDef, type SimEvent, type Vec3 } from '../src/types';
import { makeFlatStage } from './helpers/testStage';

const G = ENEMIES.guard;
const T = ENEMIES.turret;
const MAX_STEP = 1 / 120;

interface Spawn {
  origin: Vec3;
  direction: Vec3;
  speed: number;
  damage: number;
  lifetime: number;
  ownerId: string;
  time: number;
}

class FakeProjectiles {
  calls: Spawn[] = [];
  spawnEnemyBullet(origin: Vec3, direction: Vec3, speed: number, damage: number, lifetime: number, ownerId: string, time: number): void {
    this.calls.push({ origin: [...origin] as Vec3, direction: [...direction] as Vec3, speed, damage, lifetime, ownerId, time });
  }
  times(owner: string): number[] {
    return this.calls.filter((c) => c.ownerId === owner).map((c) => c.time);
  }
}

function box(min: Vec3, max: Vec3): AABB {
  return { min: [...min] as Vec3, max: [...max] as Vec3 };
}

/** 600×600 m の平坦な床（上面 y=0）＋任意の壁 */
function makeWorld(walls: AABB[] = []): CollisionWorld {
  const w = createCollisionWorld();
  w.addCollider(box([-300, -2, -300], [300, 0, 300]), 'floor');
  for (const b of walls) w.addCollider(b, 'wall');
  return w;
}

function guard(id: string, position: Vec3, yaw = 0): EnemyDef {
  return { id, kind: 'guard', position: [...position] as Vec3, yaw, sectorId: 's', isGateControl: false };
}

function turret(id: string, position: Vec3, yaw = 0): EnemyDef {
  return { id, kind: 'turret', position: [...position] as Vec3, yaw, sectorId: 's', isGateControl: false };
}

function angleDeg(a: Vec3, b: Vec3): number {
  return radToDeg(Math.acos(Math.max(-1, Math.min(1, dot(normalize(a), normalize(b))))));
}

interface HarnessOptions {
  walls?: AABB[];
  nav?: boolean;
  feet?: Vec3;
  velocity?: Vec3;
  seed?: number;
}

class Harness {
  readonly world: CollisionWorld;
  readonly proj = new FakeProjectiles();
  readonly events: SimEvent[] = [];
  readonly mgr: EnemyManager;
  readonly nav: NavGrid | null;
  time = 0;
  feet: Vec3;
  velocity: Vec3;
  alive = true;

  constructor(defs: EnemyDef[], opts: HarnessOptions = {}) {
    this.world = makeWorld(opts.walls);
    this.nav = opts.nav ? NavGrid.build(this.world, { cellSize: 2, agentHalfExtents: G.halfExtents }) : null;
    this.mgr = new EnemyManager(defs, this.world, this.nav, new Rng(opts.seed ?? 1), () => 's');
    this.feet = opts.feet ? ([...opts.feet] as Vec3) : [0, 0, 0];
    this.velocity = opts.velocity ? ([...opts.velocity] as Vec3) : [0, 0, 0];
  }

  center(): Vec3 {
    return add(this.feet, PLAYER.hitCenterOffset);
  }

  ctx(): EnemyContext {
    return {
      time: this.time,
      world: this.world,
      player: { center: this.center(), velocity: [...this.velocity] as Vec3, alive: this.alive, feet: [...this.feet] as Vec3, halfExtents: PLAYER.halfExtents },
      projectiles: this.proj as unknown as Projectiles,
      events: this.events,
    };
  }

  /** until までシミュレーションを進める。onStep は各サブステップの先頭（fireDue の前）と終端で呼ぶ */
  run(until: number, onStep?: (time: number) => void): void {
    let guardCount = 0;
    while (this.time < until - 1e-9 && guardCount++ < 1e6) {
      onStep?.(this.time);
      this.mgr.fireDue(this.ctx());
      let h = Math.min(MAX_STEP, until - this.time);
      const next = this.mgr.nextEventTime(this.time);
      if (next !== null && next > this.time + 1e-9 && next < this.time + h) h = next - this.time;
      this.mgr.beginStep();
      this.mgr.integrate(h, this.ctx());
      this.feet = addScaled(this.feet, this.velocity, h);
      this.time += h;
    }
    onStep?.(this.time);
    this.mgr.fireDue(this.ctx());
  }

  enemy(id: string) {
    const e = this.mgr.byId(id);
    if (!e) throw new Error('unknown enemy ' + id);
    return e;
  }

  distTo(id: string): number {
    return distanceXZ(this.enemy(id).pos, this.feet);
  }
}

/** 幅 60 m・高さ 6 m の壁を z∈[-6,-5] に置く（プレイヤー (0,0,0) と -Z 側の敵の間） */
const BLOCKING_WALL = box([-30, 0, -6], [30, 6, -5]);

function expectTimes(actual: number[], expected: number[], tol = 0.01): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) expect(Math.abs(actual[i] - expected[i])).toBeLessThanOrEqual(tol);
}

describe('敵 AI: 攻撃スケジュール', () => {
  it('(1) 警備ロボット: 初回 0.50 s、バースト 0.12 s 間隔、周期 1.20 s', () => {
    const h = new Harness([guard('g1', [0, 0, -40])]);
    h.run(2.0);
    const times = h.proj.times('g1');
    console.log('guard shot times:', times.map((t) => t.toFixed(4)).join(', '));
    expectTimes(times, [0.5, 0.62, 0.74, 1.7, 1.82, 1.94]);
    expect(Math.abs(times[0] - G.firstShotDelay)).toBeLessThanOrEqual(0.01);
    const e = h.enemy('g1');
    expect(e.shotsFired).toBe(6);
    expect(e.lastShotAt).not.toBeNull();
    expect(Math.abs((e.lastShotAt as number) - 1.94)).toBeLessThanOrEqual(0.01);
    expect(e.alert).toBe(true);
    expect(e.hasLineOfSight).toBe(true);
    // 弾のパラメーターは params.ts の値
    for (const c of h.proj.calls) {
      expect(c.speed).toBe(G.bulletSpeed);
      expect(c.damage).toBe(G.damage);
      expect(c.lifetime).toBe(G.bulletLifetime);
      expect(Math.abs(length(c.direction) - 1)).toBeLessThan(1e-9);
    }
    // 予告イベントは各バーストの前に 1 回
    const telegraphs = h.events.filter((ev) => ev.type === 'enemyTelegraph');
    expect(telegraphs.length).toBe(2);
    const fires = h.events.filter((ev) => ev.type === 'enemyFire');
    expect(fires.length).toBe(6);
  });

  it('(1) 固定砲台: 初回 0.70 s、バースト 0.25 s 間隔、周期 1.60 s、移動しない', () => {
    const h = new Harness([turret('t1', [0, 0, 60])]);
    const start = [...h.enemy('t1').pos] as Vec3;
    h.run(3.0);
    const times = h.proj.times('t1');
    console.log('turret shot times:', times.map((t) => t.toFixed(4)).join(', '));
    expectTimes(times, [0.7, 0.95, 2.3, 2.55]);
    expect(Math.abs(times[0] - T.firstShotDelay)).toBeLessThanOrEqual(0.01);
    const e = h.enemy('t1');
    expect(e.pos).toEqual(start);
    expect(e.vel).toEqual([0, 0, 0]);
    for (const c of h.proj.calls) {
      expect(c.speed).toBe(T.bulletSpeed);
      expect(c.damage).toBe(T.damage);
      expect(c.lifetime).toBe(T.bulletLifetime);
      // 銃口 = pos + gunPivotOffset + gunDirection·gunLength（砲塔の回転中心から砲身長だけ離れている）
      expect(Math.abs(distance(c.origin, add(e.pos, T.gunPivotOffset)) - T.gunLength)).toBeLessThan(1e-6);
    }
  });

  it('予告状態は burstStartAt − telegraph から始まる', () => {
    const h = new Harness([guard('g1', [0, 0, -40])]);
    h.run(0.3);
    expect(h.enemy('g1').telegraphing).toBe(false);
    h.run(0.4);
    expect(h.enemy('g1').telegraphing).toBe(true);
    h.run(0.8);
    expect(h.enemy('g1').telegraphing).toBe(false);
    h.run(1.6);
    expect(h.enemy('g1').telegraphing).toBe(true);
  });
});

describe('敵 AI: 偏差射撃', () => {
  it('(2) 横に 10 m/s で動くプレイヤーへ迎撃時刻の位置を狙う（0.5° 以内）', () => {
    const v: Vec3 = [10, 0, 0];
    const h = new Harness([guard('g1', [0, 0, -40])], { velocity: v });
    h.run(0.55);
    const calls = h.proj.calls.filter((c) => c.ownerId === 'g1');
    expect(calls.length).toBe(1);
    const c = calls[0];
    // 発射時刻のプレイヤー中心
    const centerAtFire = add(addScaled([0, 0, 0], v, c.time), PLAYER.hitCenterOffset);
    const r = sub(centerAtFire, c.origin);
    const sol = solveLinearLead(r, v, G.bulletSpeed, G.leadMaxSeconds);
    expect(sol).not.toBeNull();
    const t = (sol as { t: number }).t;
    const expected = normalize(sub(addScaled(centerAtFire, v, t), c.origin));
    const err = angleDeg(c.direction, expected);
    const direct = angleDeg(c.direction, r);
    console.log(`lead: t=${t.toFixed(4)} s, error vs intercept ${err.toFixed(4)}°, vs current position ${direct.toFixed(3)}°`);
    expect(err).toBeLessThanOrEqual(G.aimSpreadDeg + 1e-6);
    // 現在位置ではなく予測位置を狙っている
    expect(direct).toBeGreaterThan(G.aimSpreadDeg + 1);
  });

  it('静止プレイヤーには現在位置を狙う（ばらつき 0.5° 以内、固定オフセットなし）', () => {
    const h = new Harness([guard('g1', [0, 0, -40]), turret('t1', [30, 0, 30])]);
    h.run(2.0);
    for (const c of h.proj.calls) {
      const r = sub(h.center(), c.origin);
      expect(angleDeg(c.direction, r)).toBeLessThanOrEqual(0.5 + 1e-6);
    }
    expect(h.proj.calls.length).toBeGreaterThan(0);
  });
});

describe('敵 AI: 遮蔽と記憶', () => {
  it('(3) 短い遮蔽（1.0〜1.3 s）: 遮蔽中は撃たず、次のバーストは max(nextBurstStartAt, te+予告) = 1.70', () => {
    const h = new Harness([guard('g1', [0, 0, -40])]);
    let wallId: number | null = null;
    h.run(2.2, (t) => {
      if (wallId === null && t >= 1.0 - 1e-6 && t < 1.3 - 1e-6) wallId = h.world.addCollider(BLOCKING_WALL, 'wall');
      if (wallId !== null && t >= 1.3 - 1e-6 && h.world.hasCollider(wallId)) h.world.removeCollider(wallId);
    });
    const times = h.proj.times('g1');
    console.log('occlusion 1.0-1.3 shot times:', times.map((t) => t.toFixed(4)).join(', '));
    expect(times.filter((t) => t > 1.0 - 1e-6 && t < 1.3 + 1e-6).length).toBe(0);
    expectTimes(times, [0.5, 0.62, 0.74, 1.7, 1.82, 1.94]);
  });

  it('(3) 長めの遮蔽（1.0〜1.65 s）: 再開は te + 予告 = 1.80（初回待ち時間 0.5 のやり直しではない）', () => {
    const h = new Harness([guard('g1', [0, 0, -40])]);
    let wallId: number | null = null;
    h.run(2.2, (t) => {
      if (wallId === null && t >= 1.0 - 1e-6 && t < 1.65 - 1e-6) wallId = h.world.addCollider(BLOCKING_WALL, 'wall');
      if (wallId !== null && t >= 1.65 - 1e-6 && h.world.hasCollider(wallId)) h.world.removeCollider(wallId);
    });
    const times = h.proj.times('g1');
    console.log('occlusion 1.0-1.65 shot times:', times.map((t) => t.toFixed(4)).join(', '));
    expect(times.filter((t) => t > 1.0 - 1e-6 && t < 1.65 + 1e-6).length).toBe(0);
    expectTimes(times, [0.5, 0.62, 0.74, 1.8, 1.92, 2.04]);
    // 1.65 + 0.5 = 2.15 に撃っていない
    expect(times.some((t) => Math.abs(t - 2.15) < 0.02)).toBe(false);
  });

  it('(4) 9 秒の遮蔽で警戒解除、再発見は初回扱い（0.50 s 後）', () => {
    const h = new Harness([guard('g1', [0, 0, -40])]);
    let wallId: number | null = null;
    const step = (t: number): void => {
      if (wallId === null && t >= 1.0 - 1e-6 && t < 10.0 - 1e-6) wallId = h.world.addCollider(BLOCKING_WALL, 'wall');
      if (wallId !== null && t >= 10.0 - 1e-6 && h.world.hasCollider(wallId)) h.world.removeCollider(wallId);
    };
    h.run(8.5, step);
    expect(h.enemy('g1').alert).toBe(true);
    expect(h.enemy('g1').hasLineOfSight).toBe(false);
    h.run(9.5, step);
    expect(h.enemy('g1').alert).toBe(false);
    h.run(11.0, step);
    const times = h.proj.times('g1');
    console.log('memory test shot times:', times.map((t) => t.toFixed(4)).join(', '));
    expect(times.filter((t) => t > 1.0 - 1e-6 && t < 10.0 + 1e-6).length).toBe(0);
    const after = times.filter((t) => t >= 10.0);
    expect(after.length).toBeGreaterThanOrEqual(3);
    expect(Math.abs(after[0] - 10.5)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(after[1] - 10.62)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(after[2] - 10.74)).toBeLessThanOrEqual(0.01);
  });

  it('各発ごとに射線を確認し、バースト途中で遮蔽された発は撃たない（スケジュールは進む）', () => {
    const h = new Harness([guard('g1', [0, 0, -40])]);
    let wallId: number | null = null;
    h.run(2.2, (t) => {
      if (wallId === null && t >= 0.55 - 1e-6 && t < 0.7 - 1e-6) wallId = h.world.addCollider(BLOCKING_WALL, 'wall');
      if (wallId !== null && t >= 0.7 - 1e-6 && h.world.hasCollider(wallId)) h.world.removeCollider(wallId);
    });
    const times = h.proj.times('g1');
    console.log('mid-burst occlusion shot times:', times.map((t) => t.toFixed(4)).join(', '));
    // 0.62 の発は遮蔽で欠け、0.74 は再露出後なので撃つ。次のバーストは 1.70 のまま
    expectTimes(times, [0.5, 0.74, 1.7, 1.82, 1.94]);
  });
});

describe('敵 AI: 警備ロボットの移動', () => {
  it('(5) 55 m 超では 8 m/s で接近する', () => {
    const h = new Harness([guard('g1', [0, 0, -70])]);
    const start = [...h.enemy('g1').pos] as Vec3;
    h.run(1.0);
    const e = h.enemy('g1');
    const moved = sub(e.pos, start);
    console.log(`approach: moved ${length(moved).toFixed(3)} m in 1.0 s, pos ${e.pos.map((x) => x.toFixed(2)).join(',')}`);
    expect(Math.abs(length(moved) - G.approachSpeed)).toBeLessThanOrEqual(0.05);
    expect(moved[2]).toBeGreaterThan(7.9);
    expect(Math.abs(e.vel[2] - G.approachSpeed)).toBeLessThanOrEqual(0.05);
    expect(e.pos[1]).toBeCloseTo(0, 3); // 床上
  });

  it('(5) 25〜55 m では 6 m/s で側方移動する', () => {
    const h = new Harness([guard('g1', [0, 0, -40])]);
    const d0 = h.distTo('g1');
    const speeds: number[] = [];
    let first = true;
    h.run(1.0, () => {
      if (first) {
        first = false;
        return;
      }
      speeds.push(length(h.enemy('g1').vel));
    });
    const e = h.enemy('g1');
    const d1 = h.distTo('g1');
    console.log(`strafe: speed min ${Math.min(...speeds).toFixed(3)} max ${Math.max(...speeds).toFixed(3)} m/s, distance ${d0.toFixed(2)} -> ${d1.toFixed(2)} m, |x| ${Math.abs(e.pos[0]).toFixed(2)}`);
    for (const s of speeds) expect(Math.abs(s - G.strafeSpeed)).toBeLessThanOrEqual(0.05);
    // 主に横方向: 距離はほぼ保たれ、横位置が大きく変わる
    expect(Math.abs(d1 - d0)).toBeLessThan(1.5);
    expect(Math.abs(e.pos[0])).toBeGreaterThan(4);
    expect(d1).toBeGreaterThanOrEqual(G.strafeDistance);
    expect(d1).toBeLessThanOrEqual(G.farDistance);
  });

  it('側方移動は周期的に左右を切り替える', () => {
    const h = new Harness([guard('g1', [0, 0, -40])]);
    let minX = 0;
    let maxX = 0;
    h.run(6.0, () => {
      const x = h.enemy('g1').pos[0];
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
    });
    console.log(`strafe sides: x range ${minX.toFixed(2)} .. ${maxX.toFixed(2)}`);
    // 片側だけへ 36 m 進み続けない（切り替えがある）
    expect(maxX - minX).toBeLessThan(30);
    expect(maxX - minX).toBeGreaterThan(4);
  });

  it('(5) 15 m 未満では 8 m/s で後退し、15〜25 m で停止する', () => {
    const h = new Harness([guard('g1', [0, 0, -10])]);
    const d0 = h.distTo('g1');
    h.run(0.5);
    const d1 = h.distTo('g1');
    console.log(`retreat: distance ${d0.toFixed(2)} -> ${d1.toFixed(2)} m in 0.5 s`);
    expect(Math.abs(d1 - d0 - G.retreatSpeed * 0.5)).toBeLessThanOrEqual(0.05);
    h.run(2.0);
    const d2 = h.distTo('g1');
    console.log(`retreat: settled at ${d2.toFixed(2)} m`);
    expect(d2).toBeGreaterThanOrEqual(G.retreatDistance - 0.1);
    expect(d2).toBeLessThanOrEqual(G.strafeDistance);
    expect(length(h.enemy('g1').vel)).toBeLessThan(1e-6);
  });

  it('(5) 射線を失ったら 0.5 秒以内に最後の確認位置へ向かう', () => {
    const h = new Harness([guard('g1', [0, 0, -40])]);
    h.run(2.0);
    const lostAt = h.time;
    h.world.addCollider(BLOCKING_WALL, 'wall');
    const before = h.distTo('g1');
    h.run(lostAt + 0.5);
    const after = h.distTo('g1');
    console.log(`after LOS loss: distance to last seen ${before.toFixed(2)} -> ${after.toFixed(2)} m within 0.5 s`);
    expect(h.enemy('g1').hasLineOfSight).toBe(false);
    expect(h.enemy('g1').alert).toBe(true);
    expect(before - after).toBeGreaterThanOrEqual(3);
  });

  it('壁があっても nav 経路で最後の確認位置へ回り込む（壁へ押し付き続けない）', () => {
    // 壁 x∈[-12,12], z∈[-21,-20]。警備は壁の向こう (0,0,-40)、プレイヤーは (0,0,0)
    const wall = box([-12, 0, -21], [12, 6, -20]);
    const h = new Harness([guard('g1', [0, 0, -40])], { walls: [wall], nav: true });
    // 初期状態では壁越しで射線なし。共有で警戒状態にする代わりに、一瞬だけ壁を除いて発見させる
    // （ここでは別の手段: 発見用に壁を一旦外す）
    const ids = h.world.colliders().filter((c) => c.tag === 'wall').map((c) => c.id);
    for (const id of ids) h.world.removeCollider(id);
    h.run(MAX_STEP);
    expect(h.enemy('g1').hasLineOfSight).toBe(true);
    h.world.addCollider(wall, 'wall');
    const path = h.nav?.findPath(h.enemy('g1').pos, [0, 0, 0]);
    expect(path).not.toBeNull();
    const regained: { at: number | null } = { at: null };
    h.run(h.time + 4.0, (t) => {
      if (regained.at === null && t > 0.1 && h.enemy('g1').hasLineOfSight) regained.at = t;
    });
    const e = h.enemy('g1');
    console.log(`flank via nav: pos ${e.pos.map((x) => x.toFixed(2)).join(',')}, LOS ${e.hasLineOfSight}, regained at ${regained.at === null ? 'never' : regained.at.toFixed(2)}, shots ${e.shotsFired}`);
    // 直進なら (0,·,-21.9) で壁に張り付き続けるが、経路で壁の端（x≤-12）を回って射線を取り直し、撃つ
    expect(regained.at).not.toBeNull();
    expect(regained.at as number).toBeLessThan(3.5);
    expect(e.hasLineOfSight).toBe(true);
    expect(e.shotsFired).toBeGreaterThan(0);
    expect(Math.abs(e.pos[0]) < 12 && e.pos[2] < -21.5).toBe(false);
  });

  it('別の床面（台の上）のプレイヤーへも自分の床面の経路で回り込み、射線を取り直す（壁へ押し付き続けない）', () => {
    // 壁 x∈[-20,20] z∈[-50.5,-49.5]（高さ 6）、台 x∈[-10,10] z∈[-20,-10]（上面 y=6）。プレイヤーは台の上 (0,6,-15)、警備は壁の向こう
    const wall = box([-20, 0, -50.5], [20, 6, -49.5]);
    const platform = box([-10, 0, -20], [10, 6, -10]);
    const h = new Harness([guard('g1', [0, 0, -85])], { walls: [wall, platform], nav: true, feet: [0, 6, -15] });
    expect(h.nav?.floorLevels()).toEqual([0, 6]);
    // 厳密な findPath は別の床面なので null（共有判定用）。追跡用 findPathToward は自分の床面へ投影して経路を返す
    expect(h.nav?.findPath([0, 0, -85], [0, 6, -15])).toBeNull();
    expect(h.nav?.findPathToward([0, 0, -85], [0, 6, -15])).not.toBeNull();
    // 一瞬だけ壁を外して発見させ、壁を戻す
    const ids = h.world.colliders().filter((c) => c.box.min[2] === wall.min[2]).map((c) => c.id);
    for (const id of ids) h.world.removeCollider(id);
    h.run(MAX_STEP);
    expect(h.enemy('g1').hasLineOfSight).toBe(true);
    h.world.addCollider(wall, 'wall');
    let minX = 0;
    let maxX = 0;
    const regained: { at: number | null } = { at: null };
    h.run(h.time + 8.0, (t) => {
      const e = h.enemy('g1');
      minX = Math.min(minX, e.pos[0]);
      maxX = Math.max(maxX, e.pos[0]);
      if (regained.at === null && t > 0.1 && e.hasLineOfSight) regained.at = t;
    });
    const e = h.enemy('g1');
    console.log(`elevated target: pos ${e.pos.map((x) => x.toFixed(2)).join(',')}, x range ${minX.toFixed(1)}..${maxX.toFixed(1)}, regained at ${regained.at === null ? 'never' : regained.at.toFixed(2)}, shots ${e.shotsFired}`);
    // 直進なら (0,0,-51.4) で壁に張り付いたまま。壁の端（|x| ≥ 20）を回って射線を取り直し、撃つ
    expect(Math.max(-minX, maxX)).toBeGreaterThanOrEqual(20);
    expect(regained.at).not.toBeNull();
    // 壁まで約 35 m ＋ 端まで約 21 m を 8 m/s で回る（約 6 s）。8 s の走行内に射線を取り直す
    expect(regained.at as number).toBeLessThan(7.5);
    expect(e.shotsFired).toBeGreaterThan(0);
  });

  it('敵同士の分離で報告速度が跳ねない（|vel| ≤ 接近速度＋分離速度、vel = (pos − prevPos)/h）', () => {
    const run = (maxStep: number, seconds: number): number => {
      const h = new Harness([guard('a', [-1, 0, -70]), guard('b', [1, 0, -70])]);
      let maxV = 0;
      let n = 0;
      while (h.time < seconds - 1e-9 && n++ < 1e6) {
        h.mgr.fireDue(h.ctx());
        let step = Math.min(maxStep, seconds - h.time);
        const next = h.mgr.nextEventTime(h.time);
        if (next !== null && next > h.time + 1e-9 && next < h.time + step) step = next - h.time;
        h.mgr.beginStep();
        h.mgr.integrate(step, h.ctx());
        h.time += step;
        for (const id of ['a', 'b']) {
          const e = h.enemy(id);
          const measured = scale(sub(e.pos, e.prevPos), 1 / step);
          expect(distance(measured, e.vel)).toBeLessThan(1e-6);
          maxV = Math.max(maxV, length(e.vel));
        }
      }
      // 分離が働いている（重なりが解消される）
      expect(distanceXZ(h.enemy('a').pos, h.enemy('b').pos)).toBeGreaterThan(2.0);
      return maxV;
    };
    const v120 = run(MAX_STEP, 2.0);
    const vTiny = run(1e-6, 1e-4);
    console.log(`separation: max |vel| ${v120.toFixed(2)} m/s at 1/120 s, ${vTiny.toFixed(2)} m/s at 1e-6 s steps`);
    // 分離の押し戻しは 4 m/s 上限（接近 8 m/s と直交なら √(8²+4²) ≈ 8.94）
    const bound = Math.hypot(G.approachSpeed, 4) + 0.05;
    expect(v120).toBeLessThanOrEqual(bound);
    expect(vTiny).toBeLessThanOrEqual(bound);
  });

  it('警備ロボットは固定砲台を通り抜けず、避けて進む', () => {
    // 砲台 (0,0,-60) が警備 (0,0,-80) → プレイヤー (0,0,0) の直線上にある
    const h = new Harness([guard('g1', [0, 0, -80]), turret('t1', [0, 0, -60])]);
    let minD = Infinity;
    h.run(3.5, () => {
      minD = Math.min(minD, distanceXZ(h.enemy('g1').pos, h.enemy('t1').pos));
    });
    const e = h.enemy('g1');
    console.log(`turret avoidance: min XZ distance ${minD.toFixed(2)} m, guard at ${e.pos.map((x) => x.toFixed(2)).join(',')}`);
    // 移動 AABB 半径の和（0.9 + 1.4）より近づかない
    expect(minD).toBeGreaterThanOrEqual(G.halfExtents[0] + T.halfExtents[0] - 0.05);
    // 砲台の手前で止まらず、回り込んで先へ進んでいる
    expect(e.pos[2]).toBeGreaterThan(-58);
    // 砲台は動かない
    expect(h.enemy('t1').pos).toEqual([0, 0, -60]);
  });

  it('到達不能・移動中の目標でも A* の呼び出しは間隔制限される（毎サブステップ再計算しない）', () => {
    const measure = (walls: AABB[], feet: Vec3, velocity: Vec3, guardPos: Vec3, seconds: number): number => {
      const h = new Harness([guard('g1', guardPos)], { walls, nav: true, feet, velocity });
      const nav = h.nav as NavGrid;
      let calls = 0;
      const orig = nav.findPathToward.bind(nav);
      nav.findPathToward = (a: Vec3, b: Vec3) => {
        calls++;
        return orig(a, b);
      };
      // 一瞬だけ壁を外して発見させる
      const ids = h.world.colliders().filter((c) => c.tag === 'wall').map((c) => c.id);
      for (const id of ids) h.world.removeCollider(id);
      h.run(MAX_STEP);
      expect(h.enemy('g1').hasLineOfSight).toBe(true);
      for (const w of walls) h.world.addCollider(w, 'wall');
      calls = 0;
      h.run(h.time + seconds);
      expect(h.enemy('g1').alert).toBe(true);
      return calls / seconds;
    };
    // 囲われた 80×80 m の中を 15 m/s で動くプレイヤー（到達不能）
    const ring = [box([-40, 0, -40], [-39, 6, 40]), box([39, 0, -40], [40, 6, 40]), box([-40, 0, -40], [40, 6, -39]), box([-40, 0, 39], [40, 6, 40])];
    const unreachable = measure(ring, [-30, 0, 0], [15, 0, 0], [0, 0, -60], 4);
    // 見通しのよい平地で 22 m/s で滑走するプレイヤーを接近追跡
    const gliding = measure([], [0, 0, 0], [22, 0, 0], [0, 0, -80], 4);
    console.log(`path recompute rate: unreachable ${unreachable.toFixed(1)}/s, gliding target ${gliding.toFixed(1)}/s`);
    expect(unreachable).toBeLessThanOrEqual(2.5);
    expect(gliding).toBeLessThanOrEqual(4.5);
  });
});

describe('敵 AI: 索敵条件', () => {
  it('(6) 背後・カメラ外のプレイヤーも距離と射線だけで攻撃する', () => {
    // 警備は yaw=0（前方 -Z）でプレイヤーは +Z 側＝背後
    const h = new Harness([guard('g1', [0, 0, -40], 0)]);
    const toPlayer = normalize(sub(h.center(), h.enemy('g1').center()));
    expect(dot(forwardFromYaw(0), toPlayer)).toBeLessThan(0);
    h.run(0.8);
    expect(h.proj.times('g1').length).toBe(3);
  });

  it('索敵距離外では攻撃しない', () => {
    const h = new Harness([guard('g1', [0, 0, -95]), turret('t1', [0, 0, 125])]);
    h.run(2.0);
    expect(h.proj.calls.length).toBe(0);
    expect(h.enemy('g1').alert).toBe(false);
    expect(h.enemy('t1').alert).toBe(false);
  });

  it('壁際に置かれた砲台（砲身先端が壁の中）も回転中心から索敵し、砲身を向け直して撃つ', () => {
    // 砲台 (0,0,-40) yaw=0（前方 -Z）、壁 z∈[-42.5,-41.5] は砲台の箱の 0.1 m 手前。初期の砲身先端 (0,2,-41.6) は壁の中
    const wall = box([-10, 0, -42.5], [10, 6, -41.5]);
    const h = new Harness([turret('t1', [0, 0, -40], 0)], { walls: [wall] });
    expect(h.world.boxOverlaps(h.enemy('t1').muzzle(), [0.01, 0.01, 0.01])).toBe(true);
    const los: { at: number | null } = { at: null };
    h.run(3.0, (t) => {
      if (los.at === null && h.enemy('t1').hasLineOfSight) los.at = t;
    });
    const e = h.enemy('t1');
    console.log(`turret at wall: LOS at ${los.at === null ? 'never' : los.at.toFixed(3)}, shots ${e.shotsFired}, muzzle ${e.muzzle().map((x) => x.toFixed(2)).join(',')}`);
    expect(los.at).not.toBeNull();
    expect(los.at as number).toBeLessThanOrEqual(MAX_STEP + 1e-9);
    expect(e.alert).toBe(true);
    expect(e.hasLineOfSight).toBe(true);
    expectTimes(h.proj.times('t1'), [0.7, 0.95, 2.3, 2.55]);
    // 発射位置は遮蔽物の中ではない（砲身が壁の中なら回転中心から）
    for (const c of h.proj.calls) expect(h.world.boxOverlaps(c.origin, [0.01, 0.01, 0.01])).toBe(false);
    // 砲身はプレイヤー側（+Z）へ向き直っている
    expect(e.gunDirection[2]).toBeGreaterThan(0.9);
  });

  it('死亡したプレイヤーは索敵しない', () => {
    const h = new Harness([guard('g1', [0, 0, -40])]);
    h.alive = false;
    h.run(2.0);
    expect(h.proj.calls.length).toBe(0);
    expect(h.enemy('g1').alert).toBe(false);
  });
});

describe('敵 AI: 共有', () => {
  it('(7) 経路距離 60 m 以内の警備ロボットへ最後の確認位置を共有する（nav あり）', () => {
    const h = new Harness([guard('a', [0, 0, -50]), guard('b', [0, 0, -100]), guard('c', [0, 0, -250])], { nav: true });
    h.run(MAX_STEP);
    expect(h.enemy('a').hasLineOfSight).toBe(true);
    expect(h.enemy('b').alert).toBe(true);
    expect(h.enemy('b').hasLineOfSight).toBe(false);
    expect(h.enemy('c').alert).toBe(false);
    const bz0 = h.enemy('b').pos[2];
    h.run(1.0);
    // 受信者は位置へ向かうが、自分の射線がないので撃たない
    expect(h.enemy('b').pos[2] - bz0).toBeGreaterThan(6);
    expect(h.enemy('b').shotsFired).toBe(0);
    expect(h.enemy('c').alert).toBe(false);
    h.run(3.0);
    // 自分の射線を得た後に撃つ
    expect(h.enemy('b').shotsFired).toBeGreaterThan(0);
    expect(h.enemy('c').alert).toBe(false);
    expect(h.enemy('c').shotsFired).toBe(0);
    console.log(`share: b moved ${(h.enemy('b').pos[2] - bz0).toFixed(1)} m, b shots ${h.enemy('b').shotsFired}, c alert ${h.enemy('c').alert}`);
  });

  it('(7) nav が null なら直線距離で共有する', () => {
    const h = new Harness([guard('a', [0, 0, -50]), guard('b', [0, 0, -100]), guard('c', [0, 0, -250])]);
    h.run(MAX_STEP);
    expect(h.enemy('b').alert).toBe(true);
    expect(h.enemy('c').alert).toBe(false);
  });

  it('壁で隔てられ経路距離が 60 m を超える味方には共有しない', () => {
    // b は a から直線 30 m だが、長い壁で経路が大きく迂回する
    const wall = box([-80, 0, -66], [80, 6, -65]);
    const h = new Harness([guard('a', [0, 0, -50]), guard('b', [0, 0, -80])], { walls: [wall], nav: true });
    h.run(MAX_STEP);
    expect(h.enemy('a').hasLineOfSight).toBe(true);
    expect(h.enemy('b').alert).toBe(false);
  });

  it('固定砲台は共有の対象外', () => {
    // 砲台は索敵距離 120 m の外（125 m）、警備 a から 55 m
    const h = new Harness([guard('a', [0, 0, -70]), turret('t', [0, 0, -125])]);
    h.run(MAX_STEP);
    expect(h.enemy('a').hasLineOfSight).toBe(true);
    expect(h.enemy('t').hasLineOfSight).toBe(false);
    expect(h.enemy('t').alert).toBe(false);
  });
});

describe('敵 AI: 独立性・ダメージ・標的', () => {
  it('(8) 3 体が同じ 1 秒間にそれぞれのスケジュールで撃つ', () => {
    const h = new Harness([guard('g1', [-30, 0, -30]), guard('g2', [30, 0, -30]), turret('t1', [0, 0, 45])]);
    h.run(1.0);
    const counts: Record<string, number> = {};
    for (const c of h.proj.calls) counts[c.ownerId] = (counts[c.ownerId] ?? 0) + 1;
    console.log('spawns per owner in [0,1] s:', JSON.stringify(counts));
    expect(counts['g1']).toBe(3);
    expect(counts['g2']).toBe(3);
    expect(counts['t1']).toBe(2);
    for (const id of ['g1', 'g2']) expect(h.enemy(id).shotsFired).toBe(3);
    expect(h.enemy('t1').shotsFired).toBe(2);
  });

  it('(9) ダメージと撃破。死亡した敵は撃たず、hittables から除かれ、配列には残る', () => {
    const h = new Harness([guard('g1', [0, 0, -40]), guard('g2', [20, 0, -40])]);
    const r1 = h.mgr.damage('g1', 50);
    expect(r1).not.toBeNull();
    expect(r1?.killed).toBe(false);
    expect(h.enemy('g1').hp).toBe(G.hp - 50);
    const r2 = h.mgr.damage('g1', 70);
    expect(r2?.killed).toBe(true);
    expect(h.enemy('g1').alive).toBe(false);
    expect(h.mgr.damage('g1', 10)).toBeNull();
    expect(h.mgr.damage('nope', 10)).toBeNull();
    expect(h.mgr.hittables().map((x) => x.id)).toEqual(['g2']);
    expect(h.mgr.targetInfos().map((x) => `${x.id}:${x.alive}`)).toEqual(['g1:false', 'g2:true']);
    expect(h.mgr.aliveCount()).toBe(1);
    h.run(2.0);
    expect(h.proj.times('g1').length).toBe(0);
    expect(h.proj.times('g2').length).toBe(6);
    expect(h.mgr.enemies.map((e) => e.id)).toEqual(['g1', 'g2']);
    expect(h.mgr.views().map((v) => `${v.id}:${v.alive}`)).toEqual(['g1:false', 'g2:true']);
    // 砲台の HP
    const h2 = new Harness([turret('t1', [0, 0, 40])]);
    expect(h2.enemy('t1').maxHp).toBe(T.hp);
    expect(h2.mgr.damage('t1', T.hp)?.killed).toBe(true);
  });

  it('(10) target は定義の速度で等速移動し、速度を正確に報告する', () => {
    const v: Vec3 = [3, 0, -1];
    const def: EnemyDef = { id: 'tg', kind: 'target', position: [10, 20, 30], yaw: 0, sectorId: 's', isGateControl: false, velocity: v };
    const h = new Harness([def]);
    h.run(1.0);
    const e = h.enemy('tg');
    expect(e.pos[0]).toBeCloseTo(13, 9);
    expect(e.pos[1]).toBeCloseTo(20, 9);
    expect(e.pos[2]).toBeCloseTo(29, 9);
    expect(e.vel).toEqual(v);
    expect(h.mgr.targetInfo('tg')?.velocity).toEqual(v);
    expect(e.hp).toBe(ENEMIES.target.hp);
    expect(e.radius).toBe(ENEMIES.target.radius);
    expect(e.center()).toEqual(e.pos);
    expect(e.alert).toBe(false);
    expect(h.proj.calls.length).toBe(0);
    const hit = h.mgr.hittables()[0];
    expect(distance(hit.center, hit.prevCenter)).toBeCloseTo(length(v) * MAX_STEP, 9);
  });

  it('reset() で全敵を定義から復元する（ID・順序不変）', () => {
    const defs = [guard('g1', [0, 0, -40]), turret('t1', [0, 0, 60])];
    const h = new Harness(defs);
    h.run(2.0);
    h.mgr.damage('t1', 100);
    expect(h.enemy('g1').shotsFired).toBeGreaterThan(0);
    h.mgr.reset();
    expect(h.mgr.enemies.map((e) => e.id)).toEqual(['g1', 't1']);
    for (const e of h.mgr.enemies) {
      expect(e.pos).toEqual(e.def.position);
      expect(e.hp).toBe(e.maxHp);
      expect(e.alive).toBe(true);
      expect(e.alert).toBe(false);
      expect(e.hasLineOfSight).toBe(false);
      expect(e.shotsFired).toBe(0);
      expect(e.lastShotAt).toBeNull();
      expect(e.telegraphing).toBe(false);
      expect(e.vel).toEqual([0, 0, 0]);
    }
    // 再出撃後も同じスケジュール
    h.time = 0;
    h.proj.calls.length = 0;
    h.run(1.0);
    expectTimes(h.proj.times('g1'), [0.5, 0.62, 0.74]);
    expectTimes(h.proj.times('t1'), [0.7, 0.95]);
  });

  it('nextEventTime は最も近い予定射撃（または予告開始）時刻を返す', () => {
    const h = new Harness([guard('g1', [0, 0, -40]), turret('t1', [0, 0, 60])]);
    expect(h.mgr.nextEventTime(0)).toBeNull();
    h.run(MAX_STEP);
    // 警備の予告開始 0.35 が最初のイベント
    expect(h.mgr.nextEventTime(h.time)).toBeCloseTo(0.35, 9);
    h.run(0.4);
    expect(h.mgr.nextEventTime(h.time)).toBeCloseTo(0.5, 9);
    h.run(0.55);
    expect(h.mgr.nextEventTime(h.time)).toBeCloseTo(0.62, 9);
    h.run(0.8);
    expect(h.mgr.nextEventTime(h.time)).toBeCloseTo(0.95, 9);
  });
});

describe('敵 AI: 露出時の危険性（Game で実行）', () => {
  it('警備2＋砲台1（35〜50 m）が静止 HP1000 のプレイヤーを 15 秒以内に撃破する', () => {
    const enemies: EnemyDef[] = [
      { id: 'g01', kind: 'guard', position: [-30, 0, -28], yaw: 0, sectorId: 'flat', isGateControl: false },
      { id: 'g02', kind: 'guard', position: [28, 0, -32], yaw: 0, sectorId: 'flat', isGateControl: false },
      { id: 't01', kind: 'turret', position: [0, 0, 48], yaw: 0, sectorId: 'flat', isGateControl: false },
    ];
    for (const e of enemies) {
      const d = Math.hypot(e.position[0], e.position[2]);
      expect(d).toBeGreaterThanOrEqual(35);
      expect(d).toBeLessThanOrEqual(50);
    }
    const stage = makeFlatStage({ enemies, start: [0, 0, 0], yaw: 0 });
    const game = new Game({ stage, loadout: DEFAULT_LOADOUT, seed: 20260908, viewport: { width: 1280, height: 720 }, buildNav: true });
    game.launch();
    const dt = 1 / 60;
    let t = 0;
    let died: number | null = null;
    let firstShot: number | null = null;
    let hits = 0;
    while (t < 20) {
      game.setInput(emptyInput());
      game.advance(dt);
      for (const ev of game.drainEvents()) {
        if (ev.type === 'enemyFire' && firstShot === null) firstShot = game.time;
        if (ev.type === 'playerHit') hits++;
      }
      t += dt;
      if (game.state === 'failed') {
        died = game.time;
        break;
      }
    }
    const snap = game.getSnapshot();
    console.log(`exposure (Game): first shot ${firstShot?.toFixed(3)}, died at ${died?.toFixed(2)}, hp ${snap.player.hp}, hits ${hits}, shots ${snap.enemies.map((e) => `${e.id}:${e.shotsFired}`).join(' ')}`);
    expect(PLAYER.maxHp).toBe(1000);
    expect(firstShot).not.toBeNull();
    expect(died).not.toBeNull();
    expect(died as number).toBeLessThanOrEqual(15);
    expect(snap.player.hp).toBeLessThanOrEqual(0);
    for (const e of snap.enemies) expect(e.shotsFired).toBeGreaterThan(0);
  });
});
