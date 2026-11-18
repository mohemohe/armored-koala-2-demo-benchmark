/**
 * NavGrid（src/sim/nav.ts）の試験: 内壁の迂回、到達不能、床面の分離、生成時間。
 */
import { describe, expect, it } from 'vitest';
import { ENEMIES } from '../src/params';
import { createCollisionWorld } from '../src/sim/collision';
import { NavGrid } from '../src/sim/nav';
import type { AABB, CollisionWorld, Vec3 } from '../src/types';

const HALF = ENEMIES.guard.halfExtents;
const CELL = 2;

function box(min: Vec3, max: Vec3): AABB {
  return { min: [...min] as Vec3, max: [...max] as Vec3 };
}

/** 60×60 m の床（上面 y=0）＋任意の壁 */
function makeRoom(walls: AABB[] = []): CollisionWorld {
  const w = createCollisionWorld();
  w.addCollider(box([-30, -2, -30], [30, 0, 30]), 'floor');
  for (const b of walls) w.addCollider(b, 'wall');
  return w;
}

function raise(p: Vec3, dy: number): Vec3 {
  return [p[0], p[1] + dy, p[2]];
}

function pathLength(path: Vec3[]): number {
  let s = 0;
  for (let i = 1; i < path.length; i++) s += Math.hypot(path[i][0] - path[i - 1][0], path[i][2] - path[i - 1][2]);
  return s;
}

describe('NavGrid', () => {
  it('内壁を迂回する経路を返し、どの区間も遮蔽されない', () => {
    // 壁: x∈[-15,15]、z∈[-0.5,0.5]、高さ 6 m
    const wall = box([-15, 0, -0.5], [15, 6, 0.5]);
    const world = makeRoom([wall]);
    const nav = NavGrid.build(world, { cellSize: CELL, agentHalfExtents: HALF });
    // 床（y=0）に加え、壁の上面（30 m² ≥ 4 m²）も床面として自動検出される
    expect(nav.floorLevels()).toEqual([0, 6]);
    const from: Vec3 = [0, 0, -10];
    const to: Vec3 = [0, 0, 10];
    const path = nav.findPath(from, to);
    expect(path).not.toBeNull();
    const p = path as Vec3[];
    expect(p.length).toBeGreaterThanOrEqual(2);
    // 始点・終点はセル中心（from/to から 1 セル以内）
    expect(Math.hypot(p[0][0] - from[0], p[0][2] - from[2])).toBeLessThanOrEqual(CELL);
    expect(Math.hypot(p[p.length - 1][0] - to[0], p[p.length - 1][2] - to[2])).toBeLessThanOrEqual(CELL);
    // 全経由点は床面高さ
    for (const q of p) expect(q[1]).toBeCloseTo(0, 6);
    // エージェント高さ（中央）で各区間が遮蔽されない。壁の中を通らない
    const agentMid = HALF[1] + 0.05;
    for (let i = 1; i < p.length; i++) {
      expect(world.segmentBlocked(raise(p[i - 1], agentMid), raise(p[i], agentMid))).toBe(false);
      expect(world.segmentBlocked(raise(p[i - 1], 0.5), raise(p[i], 0.5))).toBe(false);
    }
    // 壁の端（|x| ≥ 15）を回る
    expect(Math.max(...p.map((q) => Math.abs(q[0])))).toBeGreaterThanOrEqual(15);
    // 経路長は直線距離より長い
    const straight = Math.hypot(to[0] - from[0], to[2] - from[2]);
    const len = pathLength(p);
    expect(len).toBeGreaterThan(straight * 1.5);
    const pd = nav.pathDistance(from, to, 1000);
    expect(pd).not.toBeNull();
    expect(pd as number).toBeGreaterThan(straight * 1.5);
    // 上限を下回る距離では null
    expect(nav.pathDistance(from, to, straight)).toBeNull();
    // 壁のない 2 点の経路距離はほぼ直線
    const open = nav.pathDistance([-20, 0, -20], [-20, 0, 20], 1000);
    expect(open).not.toBeNull();
    expect(open as number).toBeLessThan(40 + 2 * CELL);
    console.log(`nav: path around wall: ${p.length} waypoints, length ${len.toFixed(2)} m (straight ${straight.toFixed(2)} m), pathDistance ${(pd as number).toFixed(2)} m`);
  });

  it('到達不能なら null', () => {
    // 完全に囲われた領域 x∈[18,26], z∈[18,26]
    const walls = [box([17, 0, 17], [18, 6, 27]), box([26, 0, 17], [27, 6, 27]), box([17, 0, 17], [27, 6, 18]), box([17, 0, 26], [27, 6, 27])];
    const world = makeRoom(walls);
    const nav = NavGrid.build(world, { cellSize: CELL, agentHalfExtents: HALF });
    expect(nav.findPath([0, 0, 0], [22, 0, 22])).toBeNull();
    expect(nav.pathDistance([0, 0, 0], [22, 0, 22], 1000)).toBeNull();
    // 囲いの内側同士は通れる
    expect(nav.findPath([20, 0, 20], [24, 0, 24])).not.toBeNull();
    // 遠すぎる（直線でも上限超え）
    expect(nav.pathDistance([-25, 0, -25], [25, 0, 25], 30)).toBeNull();
  });

  it('二つの床面は別々に扱われる', () => {
    const world = makeRoom([box([-10, 5, -10], [10, 10, 10])]); // 上面 y=10 の台
    const nav = NavGrid.build(world, { cellSize: CELL, agentHalfExtents: HALF });
    expect(nav.floorLevels()).toEqual([0, 10]);
    // 地上 → 台の上は不可（飛行が必要）
    expect(nav.findPath([-25, 0, -25], [0, 10, 0])).toBeNull();
    expect(nav.pathDistance([-25, 0, -25], [0, 10, 0], 1000)).toBeNull();
    // 台の上同士は可
    const onTop = nav.findPath([-5, 10, -5], [5, 10, 5]);
    expect(onTop).not.toBeNull();
    for (const q of onTop as Vec3[]) expect(q[1]).toBeCloseTo(10, 6);
    // 台の下（地上）を通る経路も可（台の底は y=5 なので通れる）
    const under = nav.findPath([-25, 0, 0], [25, 0, 0]);
    expect(under).not.toBeNull();
    for (const q of under as Vec3[]) expect(q[1]).toBeCloseTo(0, 6);
    // nearest は最も近い床面のセル中心
    const n = nav.nearest([0.3, 10.4, 0.3]);
    expect(n).not.toBeNull();
    expect((n as Vec3)[1]).toBeCloseTo(10, 6);
    expect(Math.hypot((n as Vec3)[0] - 0.3, (n as Vec3)[2] - 0.3)).toBeLessThanOrEqual(CELL);
    // 台から 15 m 離れた空中（y=10）: 探索範囲（6 セル）内に歩行可能セルが無いので null
    expect(nav.nearest([25, 10, 25])).toBeNull();
    // 高さが床面から離れすぎている点も null
    expect(nav.nearest([0, 5, 0])).toBeNull();
  });

  it('壁際・壁の中は歩行不可、幅の狭い通路は通れない', () => {
    // 幅 1.5 m の隙間（エージェント幅 1.8 m）: 通れない
    const walls = [box([-30, 0, -0.5], [-0.75, 6, 0.5]), box([0.75, 0, -0.5], [30, 6, 0.5])];
    const world = makeRoom(walls);
    const nav = NavGrid.build(world, { cellSize: CELL, agentHalfExtents: HALF });
    expect(nav.findPath([0, 0, -10], [0, 0, 10])).toBeNull();
    // 幅 4 m の隙間: 通れる
    const walls2 = [box([-30, 0, -0.5], [-2, 6, 0.5]), box([2, 0, -0.5], [30, 6, 0.5])];
    const nav2 = NavGrid.build(makeRoom(walls2), { cellSize: CELL, agentHalfExtents: HALF });
    const p = nav2.findPath([0, 0, -10], [0, 0, 10]);
    expect(p).not.toBeNull();
    const mid = HALF[1] + 0.05;
    for (let i = 1; i < (p as Vec3[]).length; i++) {
      expect(makeRoom(walls2).segmentBlocked(raise((p as Vec3[])[i - 1], mid), raise((p as Vec3[])[i], mid))).toBe(false);
    }
  });

  it('隔壁（tag barrier:）は閉鎖中は通れず、開放後に通れる', () => {
    const world = makeRoom([box([-30, 0, -0.5], [-2, 6, 0.5]), box([2, 0, -0.5], [30, 6, 0.5])]);
    const barrierId = world.addCollider(box([-2, 0, -0.5], [2, 6, 0.5]), 'barrier:b1');
    const nav = NavGrid.build(world, { cellSize: CELL, agentHalfExtents: HALF });
    expect(nav.findPath([0, 0, -10], [0, 0, 10])).toBeNull();
    world.removeCollider(barrierId);
    expect(nav.findPath([0, 0, -10], [0, 0, 10])).not.toBeNull();
  });

  it('600×600 m・3 層のワールドを 2 秒未満で生成する', () => {
    const world = createCollisionWorld();
    world.addCollider(box([-300, -2, -300], [300, 0, 300]), 'floor0');
    world.addCollider(box([-200, 8, -200], [0, 10, 0]), 'floor1');
    world.addCollider(box([0, 18, 0], [200, 20, 200]), 'floor2');
    // 壁・設備 300 個
    let seed = 12345;
    const rnd = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < 300; i++) {
      const x = -290 + rnd() * 580;
      const z = -290 + rnd() * 580;
      const w = 1 + rnd() * 12;
      const d = 1 + rnd() * 12;
      const y = rnd() < 0.5 ? 0 : rnd() < 0.5 ? 10 : 20;
      world.addCollider(box([x, y, z], [x + w, y + 3 + rnd() * 5, z + d]), 'obstacle');
    }
    const t0 = performance.now();
    const nav = NavGrid.build(world, { cellSize: CELL, agentHalfExtents: HALF, floorLevels: [0, 10, 20] });
    const ms = performance.now() - t0;
    console.log(`nav: build 600x600 m, 3 levels: ${ms.toFixed(0)} ms, walkable cells ${nav.walkableCount()}`);
    expect(ms).toBeLessThan(2000);
    expect(nav.floorLevels()).toEqual([0, 10, 20]);
    // 長距離の経路探索も実用時間
    const t1 = performance.now();
    const p = nav.findPath([-280, 0, -280], [280, 0, 280]);
    const q = nav.pathDistance([-100, 10, -100], [-50, 10, -50], 200);
    const ms2 = performance.now() - t1;
    console.log(`nav: long path ${p ? p.length : 'null'} waypoints, level-1 distance ${q === null ? 'null' : q.toFixed(1)} in ${ms2.toFixed(0)} ms`);
    expect(p).not.toBeNull();
    expect(q).not.toBeNull();
    expect(ms2).toBeLessThan(1000);
  });

  it('findPathToward: 別の床面・空中・囲いの中の目標にも自分の床面の経路を返す（追跡用）', () => {
    // 台 x∈[-10,10] z∈[-10,10]（上面 y=6）。地上の (0,0,-25) から台の上 (0,6,0) へ
    const platform = box([-10, 0, -10], [10, 6, 10]);
    const world = makeRoom([platform]);
    const nav = NavGrid.build(world, { cellSize: CELL, agentHalfExtents: HALF });
    expect(nav.floorLevels()).toEqual([0, 6]);
    expect(nav.findPath([0, 0, -25], [0, 6, 0])).toBeNull(); // 厳密（共有判定用）は別の床面で null
    const r = nav.findPathToward([0, 0, -25], [0, 6, 0]);
    expect(r).not.toBeNull();
    const { path, reached } = r as { path: Vec3[]; reached: boolean };
    expect(reached).toBe(true);
    for (const q of path) expect(q[1]).toBeCloseTo(0, 6); // 全経由点は自分の床面
    const end = path[path.length - 1];
    // 末尾は台の外側（歩行可能）で、台の縁の近く
    expect(Math.abs(end[0]) >= 10 + HALF[0] || Math.abs(end[2]) >= 10 + HALF[2]).toBe(true);
    expect(Math.hypot(end[0], end[2])).toBeLessThanOrEqual(10 + 2 * CELL + HALF[0]);
    // 空中（y=4）の目標: 真下のセルへ
    const air = nav.findPathToward([-20, 0, 20], [-20, 4, 0]);
    expect(air).not.toBeNull();
    const airEnd = (air as { path: Vec3[] }).path.slice(-1)[0];
    expect(Math.hypot(airEnd[0] + 20, airEnd[2])).toBeLessThanOrEqual(CELL);
    expect((air as { reached: boolean }).reached).toBe(true);
    // 囲いの中（到達不能）: 探索した中で最も近いセルまでの経路（reached=false）。厳密な findPath は null のまま
    const walls = [box([17, 0, 17], [18, 6, 27]), box([26, 0, 17], [27, 6, 27]), box([17, 0, 17], [27, 6, 18]), box([17, 0, 26], [27, 6, 27])];
    const nav2 = NavGrid.build(makeRoom(walls), { cellSize: CELL, agentHalfExtents: HALF });
    expect(nav2.findPath([0, 0, 0], [22, 0, 22])).toBeNull();
    const t0 = performance.now();
    const r2 = nav2.findPathToward([0, 0, 0], [22, 0, 22]);
    const ms = performance.now() - t0;
    expect(r2).not.toBeNull();
    expect((r2 as { reached: boolean }).reached).toBe(false);
    const end2 = (r2 as { path: Vec3[] }).path.slice(-1)[0];
    console.log(`nav: findPathToward enclosed goal -> end ${end2.map((v) => v.toFixed(1)).join(',')} in ${ms.toFixed(1)} ms`);
    expect(Math.hypot(end2[0] - 22, end2[2] - 22)).toBeLessThanOrEqual(12);
    expect(end2[0] < 17 || end2[0] > 27 || end2[2] < 17 || end2[2] > 27).toBe(true);
  });

  it('findPathToward: 到達不能な目標でも探索数の上限で打ち切り、床面全体を走査しない', () => {
    // 600×600 m の床（90000 セル）で囲いの中を目標にする
    const world = createCollisionWorld();
    world.addCollider(box([-300, -2, -300], [300, 0, 300]), 'floor');
    for (const b of [box([17, 0, 17], [18, 6, 27]), box([26, 0, 17], [27, 6, 27]), box([17, 0, 17], [27, 6, 18]), box([17, 0, 26], [27, 6, 27])]) world.addCollider(b, 'wall');
    const nav = NavGrid.build(world, { cellSize: CELL, agentHalfExtents: HALF });
    nav.findPathToward([0, 0, 0], [22, 0, 22]); // ウォームアップ
    const t0 = performance.now();
    const n = 5;
    let r: ReturnType<typeof nav.findPathToward> = null;
    for (let i = 0; i < n; i++) r = nav.findPathToward([0, 0, 0], [22, 0, 22]);
    const ms = (performance.now() - t0) / n;
    console.log(`nav: capped unreachable findPathToward ${ms.toFixed(1)} ms/call, expansions ${nav.lastExpansions}, walkable ${nav.walkableCount()}`);
    expect(r).not.toBeNull();
    expect((r as { reached: boolean }).reached).toBe(false);
    expect(nav.lastExpansions).toBeLessThan(nav.walkableCount() / 4);
    expect(ms).toBeLessThan(60);
  });
});
