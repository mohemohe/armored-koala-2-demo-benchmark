/**
 * Guard navigation (src/sim/nav.ts): grid build, A* + smoothing, clearance / step rules, barrier state at query time,
 * caching per World, cost of the flood-fill on a stage-sized map. The World is the real World class.
 */
import { describe, expect, it } from 'vitest';
import { ENEMIES } from '../src/config';
import { NAV, buildNav, getNav } from '../src/sim/nav';
import type { FindPathOptions, PathJob } from '../src/sim/nav';
import { Rng } from '../src/sim/rng';
import type { BoxDef, V3 } from '../src/sim/types';
import { World } from '../src/sim/world';

let seq = 0;
function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, extra: Partial<BoxDef> = {}): BoxDef {
  return { id: `nb${seq++}`, min: { x: x0, y: y0, z: z0 }, max: { x: x1, y: y1, z: z1 }, mat: 'concrete', sectorId: 'N', ...extra };
}
const floor = (): BoxDef => box(-300, -2, -300, 300, 0, 300);
const P = (x: number, z: number, y = 0): V3 => ({ x, y, z });
const dist = (a: V3, b: V3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const HR = ENEMIES.guard.hitRadius;

/** independent check with the World's own overlap test: the guard's hit sphere (as an AABB) never touches a solid along the path */
function pathIsClear(world: World, pts: V3[], step = 0.25): boolean {
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const n = Math.max(1, Math.ceil(dist(a, b) / step));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const c = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t + ENEMIES.guard.centerHeight, z: a.z + (b.z - a.z) * t };
      if (world.overlapAABB(c, { x: HR, y: HR, z: HR }, 0.001)) return false;
    }
  }
  return true;
}
/** boxes of a wall across z = 0 (full width of the floor, 2 m thick, 12 m high) with a gap [gx0, gx1] */
function wallWithGap(gx0: number, gx1: number, extra: BoxDef[] = []): BoxDef[] {
  return [box(-300, 0, -1, gx0, 12, 1), box(gx1, 0, -1, 300, 12, 1), ...extra];
}
const pathLen = (pts: V3[]): number => pts.slice(1).reduce((s, p, i) => s + dist(pts[i], p), 0);

describe('経路探索 (A* + 平滑化)', () => {
  it('壁を迂回する: 壁を通らず、最短経路に近く、始点/終点が一致する', () => {
    const w = new World([floor(), box(-30, 0, -1, 0, 10, 1)]);
    const nav = buildNav(w);
    const from = P(-15, -20);
    const to = P(-15, 20);
    const p = nav.findPath(from, to)!;
    expect(p).not.toBeNull();
    expect(p.partial).toBe(false);
    expect(dist(p.points[0], from)).toBeLessThan(0.5);
    expect(dist(p.points[p.points.length - 1], to)).toBeLessThan(0.5);
    expect(pathIsClear(w, p.points)).toBe(true);
    // around the wall end x = 0 + body clearance: 2 * hypot(16.35, 18.65) + 2.7 ~ 52.3 m; the straight line would be 40 m
    expect(p.length).toBeCloseTo(pathLen(p.points), 9);
    expect(p.length).toBeGreaterThan(52);
    expect(p.length).toBeLessThan(57);
    // every leg of the smoothed path is a straight walk
    for (let i = 1; i < p.points.length; i++) expect(nav.canStep(p.points[i - 1], p.points[i], NAV.MOVE_HALF)).toBe(true);
    // deterministic
    expect(nav.findPath(from, to)).toEqual(p);
  });

  it('障害物が無ければ直線 (始点と終点だけ)', () => {
    const w = new World([floor()]);
    const p = buildNav(w).findPath(P(-40, -30), P(35, 22))!;
    expect(p.points.length).toBe(2);
    expect(p.length).toBeCloseTo(Math.hypot(75, 52), 6);
  });

  it('到達不能はnull (密閉された部屋)。partial指定なら到達可能な最寄り点までの経路', () => {
    const w = new World([
      floor(),
      box(20, 0, -20, 60, 10, -18), box(20, 0, 18, 60, 10, 20), box(20, 0, -20, 22, 10, 20), box(58, 0, -20, 60, 10, 20),
    ]);
    const nav = buildNav(w);
    expect(nav.findPath(P(0, 0), P(40, 0))).toBeNull(); // goal inside the sealed room
    expect(nav.findPath(P(40, 0), P(0, 0))).toBeNull(); // start inside the sealed room
    expect(nav.findPath(P(0, 0), P(-30, 5))).not.toBeNull(); // outside is connected
    const part = nav.findPath(P(0, 0), P(40, 0), { partial: true })!;
    expect(part.partial).toBe(true);
    const end = part.points[part.points.length - 1];
    expect(end.x).toBeLessThan(20); // stops at the wall
    expect(end.x).toBeGreaterThan(10); // ...as close as the body clearance allows
    expect(pathIsClear(w, part.points)).toBe(true);
  });

  it('隔壁(barrier)の開閉を問い合わせ時に反映する: 閉=null、開=通り抜ける、再び閉=null (グリッドは作り直さない)', () => {
    // wall across z = 0 with an 8 m doorway at x in [-4, 4] closed by a barrier box
    const door = box(-4, 0, -1, 4, 8, 1, { id: 'door', barrierId: 'B1' });
    const w = new World([floor(), ...wallWithGap(-4, 4, [box(-4, 8, -1, 4, 12, 1), door])]);
    const nav = buildNav(w);
    const a = P(0, -20);
    const b = P(0, 20);
    expect(nav.findPath(a, b)).toBeNull();
    w.setBoxEnabled(w.indexOfBox('door'), false);
    const open = nav.findPath(a, b)!;
    expect(open).not.toBeNull();
    expect(open.length).toBeCloseTo(40, 0); // straight through the doorway
    for (const pt of open.points) if (Math.abs(pt.z) < 2) expect(Math.abs(pt.x)).toBeLessThan(4);
    expect(pathIsClear(w, open.points)).toBe(true);
    w.setBoxEnabled(w.indexOfBox('door'), true);
    expect(nav.findPath(a, b)).toBeNull();
    // same Nav instance kept working through all toggles (barrier state is read per query, nothing is rebuilt)
    expect(getNav(w)).toBe(getNav(w));
  });

  it('barrierId が無くても StageDef の barriers[].boxIds で隔壁として扱える', () => {
    const w = new World([floor(), ...wallWithGap(-4, 4, [box(-4, 8, -1, 4, 12, 1), box(-4, 0, -1, 4, 8, 1, { id: 'plain-door' })])]);
    const stageLike = { barriers: [{ id: 'B1', boxIds: ['plain-door'], controlEnemyId: null, isFinal: false, label: '', pos: P(0, 0) }] } as never;
    const nav = buildNav(w, stageLike);
    expect(nav.findPath(P(0, -20), P(0, 20))).toBeNull();
    w.setBoxEnabled(w.indexOfBox('plain-door'), false);
    expect(nav.findPath(P(0, -20), P(0, 20))).not.toBeNull();
  });

  it('段差: 0.3m以下は歩ける(0.3m刻みの階段で上層へ)、それより高い面は壁。床の高さが経路のyになる', () => {
    const low = box(20, 0, -30, 40, 0.3, 30); // 0.3 m platform: within the step limit
    const mid = box(50, 0, -30, 70, 0.5, 30); // 0.5 m block: the hit sphere cannot pass over it
    const stairs = [0.3, 0.6, 0.9, 1.2].map((h, i) => box(80 + i * 6, 0, -30, 200, h, 30)); // 4 steps of 0.3 m
    const w = new World([floor(), low, mid, ...stairs]);
    const nav = buildNav(w);
    const p1 = nav.findPath(P(0, 0), P(30, 0, 0.3))!;
    expect(p1).not.toBeNull();
    expect(p1.points[p1.points.length - 1].y).toBeCloseTo(0.3, 6);
    expect(pathIsClear(w, p1.points)).toBe(true);
    // the 0.5 m block is a wall (and its top is not connected to anything walkable)
    expect(nav.findPath(P(0, 0), P(60, 0, 0.5))).toBeNull();
    const p2 = nav.findPath(P(0, 0), P(120, 0, 1.2))!;
    expect(p2).not.toBeNull();
    const ys = p2.points.map((q) => q.y);
    expect(Math.max(...ys)).toBeCloseTo(1.2, 6);
    expect(ys[ys.length - 1]).toBeCloseTo(1.2, 6);
    for (let i = 1; i < p2.points.length; i++) expect(nav.canStep(p2.points[i - 1], p2.points[i], NAV.MOVE_HALF)).toBe(true); // every leg is a walk with steps <= 0.3 m
  });

  it('身体クリアランス: 幅2mの隙間は通れず、十分な幅・頭上の空きがあれば通れる', () => {
    const wallsWithGap = (gap: number, lintelBottom: number | null): World => {
      const half = gap / 2;
      const bs = [floor(), ...wallWithGap(-half, half)];
      if (lintelBottom !== null) bs.push(box(-half, lintelBottom, -1, half, 12, 1));
      return new World(bs);
    };
    // (gap centered on x = 0; cell centers are on multiples of 2 m so x = 0 is on the lattice)
    expect(buildNav(wallsWithGap(2, null)).findPath(P(0, -15), P(0, 15))).toBeNull(); // 2 m < 2 * hit radius
    expect(buildNav(wallsWithGap(2.6, null)).findPath(P(0, -15), P(0, 15))).toBeNull(); // 2.6 m < 2.7 m body
    const ok = wallsWithGap(6, null);
    expect(buildNav(ok).findPath(P(0, -15), P(0, 15))).not.toBeNull();
    // head clearance: a lintel 2.5 m above the floor blocks (body top = floor + 2.8), 3.5 m does not
    expect(buildNav(wallsWithGap(8, 2.5)).findPath(P(0, -15), P(0, 15))).toBeNull();
    const high = wallsWithGap(8, 3.5);
    const p = buildNav(high).findPath(P(0, -15), P(0, 15))!;
    expect(p).not.toBeNull();
    expect(pathIsClear(high, p.points)).toBe(true);
  });

  it('始点・終点の解決: 空中の目標は真下の床へ、壁の中は不可、床から離れた始点はnull', () => {
    const w = new World([floor(), box(20, 0, -5, 30, 6, 5)]);
    const nav = buildNav(w);
    const air = nav.findPath(P(0, 0), P(-10, 8, 12))!; // goal 12 m above the floor
    expect(air).not.toBeNull();
    expect(air.points[air.points.length - 1].y).toBe(0);
    expect(nav.findPath(P(0, 0), P(25, 0, 3))).toBeNull(); // inside a solid block: no standing spot
    expect(nav.findPath({ x: 0, y: 8, z: 0 }, P(-10, 12))).toBeNull(); // start floating 8 m above the ground
    // goal on top of the block (unreachable: 6 m step)
    expect(nav.findPath(P(0, 0), P(25, 0, 6))).toBeNull();
  });

  it('pathLength: 上限内なら長さ、超えるか経路が無ければnull', () => {
    const w = new World([floor(), box(-30, 0, -1, 0, 10, 1)]);
    const nav = buildNav(w);
    const len = nav.pathLength(P(-15, -20), P(-15, 20))!;
    expect(len).toBeGreaterThan(52);
    expect(nav.pathLength(P(-15, -20), P(-15, 20), 60)).toBeCloseTo(len, 9);
    expect(nav.pathLength(P(-15, -20), P(-15, 20), 45)).toBeNull(); // route is longer than 45 m even though the straight line is 40 m
    expect(nav.pathLength(P(5, 10), P(35, 10), 60)).toBeCloseTo(30, 6);
    expect(nav.pathLength(P(5, 10), P(105, 10), 60)).toBeNull();
  });

  it('floorAt / walkProbe / isFree: 壁際のクリアランスと段差を正しく扱う', () => {
    const w = new World([floor(), box(10, 0, -20, 12, 8, 20), box(-20, 0, -20, -10, 0.3, 20)]);
    const nav = buildNav(w);
    expect(nav.floorAt(0, 0, 0)).toBe(0);
    expect(nav.floorAt(10 - HR - 0.3, 0, 0)).toBe(0); // 1.5 m from the wall face: room for the sphere
    expect(nav.floorAt(10 - HR, 0, 0)).toBeNull(); // sphere would touch the wall
    expect(nav.floorAt(11, 0, 0)).toBeNull(); // inside the wall
    expect(nav.floorAt(-15, 0, 0)).toBeCloseTo(0.3, 9); // 0.3 m step platform (top is within the step limit)
    expect(nav.floorAt(-15, 0, 3)).toBeNull(); // reference height far from any floor
    expect(nav.walkProbe(P(0, 0), 5, 0)).toBe(0);
    expect(nav.walkProbe(P(0, 0), 20, 0)).toBeNull(); // blocked by the wall
    expect(nav.isFree(0, 0, 0)).toBe(true);
    expect(nav.isFree(9.5, 0, 0)).toBe(false);
  });

  it('nearestFree: 壁にめり込んだスポーン位置を最寄りの立てる場所へ寄せる', () => {
    const w = new World([floor(), box(10, 0, -20, 12, 8, 20)]);
    const nav = buildNav(w);
    const spot = nav.nearestFree(11, 0, 0)!;
    expect(spot).not.toBeNull();
    expect(nav.isFree(spot.x, spot.y, spot.z, NAV.BODY_HALF)).toBe(true);
    expect(dist(spot, P(11, 0))).toBeLessThan(4);
    expect(nav.nearestFree(11, 0, 0, 0.5)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// floor edges (SPEC §2.3: no pressing against the rim of a floor): planning keeps SUPPORT_PLAN off every drop
// ---------------------------------------------------------------------------------------------------------------------
/** independent of the nav: is (x, z) on the closed footprint of a floor slab whose top is y = 0? */
function onFloorSlab(slabs: BoxDef[], x: number, z: number): boolean {
  return slabs.some((b) => b.max.y === 0 && x >= b.min.x - 1e-9 && x <= b.max.x + 1e-9 && z >= b.min.z - 1e-9 && z <= b.max.z + 1e-9);
}
/** the whole square footprint of half extent r (corners, edge midpoints, centre) stands on slabs */
function footprintOnSlabs(slabs: BoxDef[], x: number, z: number, r: number): boolean {
  for (const dx of [-r, 0, r]) for (const dz of [-r, 0, r]) if (!onFloorSlab(slabs, x + dx, z + dz)) return false;
  return true;
}
/** a wide floor A (x -22..0) and two wings B1 / B2 (x 0..8) with a 12 m gap between them: the wings' rim (the gap's edge) and
 *  the seam between A and the wings (x = 0) are lattice lines of the 2 m grid */
function wingedFloor(): BoxDef[] {
  const slab = (x0: number, z0: number, x1: number, z1: number): BoxDef => box(x0, -2, z0, x1, 0, z1);
  return [slab(-22, 0, 0, 150), slab(0, 0, 8, 60), slab(0, 72, 8, 150)];
}

describe('床の縁: 計画は縁から SUPPORT_PLAN 以上離れ、移動は点が床の上にあればよい', () => {
  it('floorAt: 移動用(既定)は縁の線上も床、計画用(BODY_HALF)は足跡が空洞に掛かる点・縁の線上を床としない。同じ高さの床の継ぎ目は縁ではない', () => {
    const w = new World(wingedFloor());
    const nav = buildNav(w);
    const PLAN = NAV.BODY_HALF;
    // seam A|B1 at x = 0, z = 30: both sides carry the footprint
    expect(nav.floorAt(0, 30, 0, PLAN)).toBe(0);
    expect(nav.floorAt(0.3, 30, 0, PLAN)).toBe(0);
    // the wing's end at z = 60: the rim of B1 (x > 0) is a drop; A (x <= 0) continues
    expect(nav.floorAt(4, 60, 0)).toBe(0); // on the rim line: floor for the point rule
    expect(nav.floorAt(4, 60.01, 0)).toBeNull(); // 1 cm beyond: nothing under the point
    expect(nav.floorAt(4, 60, 0, PLAN)).toBeNull(); // the footprint would hang over the gap
    expect(nav.floorAt(4, 60 - NAV.SUPPORT_PLAN + 0.01, 0, PLAN)).toBeNull(); // just short of the margin
    expect(nav.floorAt(4, 60 - NAV.SUPPORT_PLAN - 0.01, 0, PLAN)).toBe(0); // margin kept
    // the seam is an edge where the gap begins: x = 0 beside the gap needs A under the whole footprint, which it does not have to the east
    expect(nav.floorAt(0, 66, 0, PLAN)).toBeNull();
    expect(nav.floorAt(-NAV.SUPPORT_PLAN - 0.01, 66, 0, PLAN)).toBe(0);
    // steering and integration are unchanged: a walk straight along the rim is fine
    expect(nav.walkProbe(P(4, 20), 4, 60)).toBe(0);
    expect(nav.walkProbe(P(4, 20), 4, 60.5)).toBeNull();
    // floorBelow follows the same two rules (spawn / patrol points use the point rule)
    expect(nav.floorBelow(4, 60, 0.3, 2)).toBe(0);
    expect(nav.floorBelow(4, 60, 0.3, 2, PLAN)).toBeNull();
  });

  it('経路: 縁の線(継ぎ目・空洞の縁)に沿わず、全点で足跡が床に乗る。空洞の隣の翼へは広い床を回り込む', () => {
    const slabs = wingedFloor();
    const w = new World(slabs);
    const nav = buildNav(w);
    for (const [ax, bx] of [[1, 4], [4, 4], [7, 1], [7, 7]]) {
      const p = nav.findPath(P(ax, 30), P(bx, 78))!;
      expect(p, `wing to wing (${ax} -> ${bx})`).not.toBeNull();
      expect(p.partial).toBe(false);
      // around the gap through A: at least the 12 m of the gap's height plus the detour, and not absurdly long
      expect(p.length).toBeGreaterThan(48);
      expect(p.length).toBeLessThan(62);
      expect(pathIsClear(w, p.points)).toBe(true);
      for (let i = 1; i < p.points.length; i++) {
        const a = p.points[i - 1];
        const b = p.points[i];
        const n = Math.max(1, Math.ceil(dist(a, b) / 0.25));
        for (let k = 0; k <= n; k++) {
          const t = k / n;
          const x = a.x + (b.x - a.x) * t;
          const z = a.z + (b.z - a.z) * t;
          // the ends of the path are the start and goal points themselves (they may stand anywhere on the floor)
          if ((i === 1 && k === 0) || (i === p.points.length - 1 && k === n)) continue;
          expect(footprintOnSlabs(slabs, x, z, NAV.SUPPORT_PLAN - 0.2), `(${x.toFixed(2)}, ${z.toFixed(2)}) on leg ${i}`).toBe(true);
        }
      }
      // every leg is also a legal walk for steering / integration (the point rule)
      for (let i = 1; i < p.points.length; i++) expect(nav.canStep(p.points[i - 1], p.points[i], NAV.MOVE_HALF)).toBe(true);
    }
  });

  it('縁の上・縁ぎりぎりの目標や始点でも経路は取れる (最後の1区間だけが縁へ向かう)', () => {
    const slabs = wingedFloor();
    const w = new World(slabs);
    const nav = buildNav(w);
    // goal exactly on the rim of B1 (z = 60) and start on the rim of B2 (z = 72)
    const toRim = nav.findPath(P(4, 20), P(4, 60))!;
    expect(toRim).not.toBeNull();
    expect(toRim.partial).toBe(false);
    expect(dist(toRim.points[toRim.points.length - 1], P(4, 60))).toBeLessThan(1e-9);
    const fromRim = nav.findPath(P(4, 72), P(4, 120))!;
    expect(fromRim).not.toBeNull();
    expect(dist(fromRim.points[0], P(4, 72))).toBeLessThan(1e-9);
    expect(pathIsClear(w, toRim.points) && pathIsClear(w, fromRim.points)).toBe(true);
  });

  it('幅 2 x SUPPORT_PLAN 未満の細い足場は経路にならず、十分な幅があれば通れる (ノードは縁から離れた所にだけ作る)', () => {
    const bridge = (half: number): World => new World([box(-40, -2, -40, 40, 0, -10), box(-40, -2, 10, 40, 0, 40), box(-half, -2, -10, half, 0, 10)]);
    // 1 m wide: a knife edge for a 2.7 m body; 3 m wide: fine
    expect(buildNav(bridge(0.5)).findPath(P(0, -20), P(0, 20))).toBeNull();
    const wide = bridge(1.5);
    const p = buildNav(wide).findPath(P(0, -20), P(0, 20))!;
    expect(p).not.toBeNull();
    expect(pathIsClear(wide, p.points)).toBe(true);
    for (const q of p.points) if (q.z > -10 && q.z < 10) expect(Math.abs(q.x)).toBeLessThan(1.5 - NAV.SUPPORT_PLAN + 0.3);
  });

  it('立てない目標 (壁に密着したプレイヤー等): 通常のクエリはnull、partial は最寄りのノードへ向かう部分経路 (最後の点は目標そのものではない)', () => {
    const w = new World([floor(), box(20, 0, -6, 26, 8, 6)]);
    const nav = buildNav(w);
    const goal = P(20 - 0.9, 0); // 0.9 m from the pillar face: closer than the body clearance
    expect(nav.findPath(P(-30, 0), goal)).toBeNull();
    const part = nav.findPath(P(-30, 0), goal, { partial: true })!;
    expect(part).not.toBeNull();
    expect(part.partial).toBe(true);
    const end = part.points[part.points.length - 1];
    expect(dist(end, goal)).toBeGreaterThan(0.5); // not the goal itself...
    expect(dist(end, goal)).toBeLessThan(5); // ...but the standable spot next to it
    expect(pathIsClear(w, part.points)).toBe(true);
    // pathLength (which does not ask for partial paths) still says there is no way to stand there
    expect(nav.pathLength(P(-30, 0), goal)).toBeNull();
  });
});

describe('World単位のキャッシュとグリッドの遅延構築', () => {
  it('getNav は World ごとに1つ (再出撃で再利用) / 別Worldは別インスタンス', () => {
    const w1 = new World([floor()]);
    const w2 = new World([floor()]);
    expect(getNav(w1)).toBe(getNav(w1));
    expect(getNav(w1)).not.toBe(getNav(w2));
    expect(buildNav(w1)).not.toBe(getNav(w1));
  });

  it('seed + warm で生成した領域内のクエリは新しいセルを作らない (構築は一度きり)', () => {
    const w = new World([floor(), box(-30, 0, -1, 0, 10, 1), box(20, 0, 20, 30, 6, 30)]);
    const nav = buildNav(w);
    nav.seed(P(-15, -20));
    let left = 1;
    let guard = 0;
    while (left > 0 && guard++ < 10000) left = nav.warm(500);
    expect(left).toBe(0);
    const cells = nav.stats().cells;
    expect(cells).toBeGreaterThan(1000);
    for (const [a, b] of [[P(-15, -20), P(-15, 20)], [P(-100, -100), P(100, 100)], [P(50, 50), P(-50, -50)]] as [V3, V3][]) {
      expect(nav.findPath(a, b)).not.toBeNull();
    }
    expect(nav.stats().cells).toBe(cells);
    expect(nav.stats().queries).toBe(3);
  });
});

describe('ランダム地形: 独立した細かい格子BFSとの整合', () => {
  it('経路は常に実際に歩ける。BFSで到達不能な組はnull、到達可能な組の大半で経路が見つかる', () => {
    let pathsChecked = 0;
    let bfsReachable = 0;
    let navFound = 0;
    let unsoundness = 0;
    for (const seed of [5, 6, 7, 8]) {
      const rng = new Rng(seed);
      const boxes: BoxDef[] = [floor()];
      for (let i = 0; i < 30; i++) {
        const x = rng.range(-70, 60);
        const z = rng.range(-70, 60);
        if (rng.next() < 0.6) {
          const len = rng.range(15, 55);
          if (rng.next() < 0.5) boxes.push(box(x, 0, z, x + len, 10, z + 2));
          else boxes.push(box(x, 0, z, x + 2, 10, z + len));
        } else boxes.push(box(x, 0, z, x + rng.range(3, 10), rng.range(2, 8), z + rng.range(3, 10)));
      }
      const w = new World(boxes);
      const nav = buildNav(w);
      // reference: 1 m lattice, 8-connected, same body clearance, independent overlap test of the World
      const R = 90;
      const N = 2 * R + 1;
      const free = new Uint8Array(N * N);
      const bodyHalf = { x: NAV.BODY_HALF, y: (NAV.BODY_TOP - NAV.BODY_BOTTOM) / 2, z: NAV.BODY_HALF };
      const cy = (NAV.BODY_TOP + NAV.BODY_BOTTOM) / 2;
      for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) free[i * N + j] = w.overlapAABB({ x: i - R, y: cy, z: j - R }, bodyHalf, 1e-4) ? 0 : 1;
      const comp = new Int32Array(N * N).fill(-1);
      let nc = 0;
      for (let s = 0; s < N * N; s++) {
        if (!free[s] || comp[s] >= 0) continue;
        const stack = [s];
        comp[s] = nc;
        while (stack.length) {
          const c = stack.pop() as number;
          const ci = Math.floor(c / N);
          const cj = c % N;
          for (let di = -1; di <= 1; di++) {
            for (let dj = -1; dj <= 1; dj++) {
              const ni = ci + di;
              const nj = cj + dj;
              if ((di === 0 && dj === 0) || ni < 0 || nj < 0 || ni >= N || nj >= N) continue;
              const n = ni * N + nj;
              if (free[n] && comp[n] < 0 && (di === 0 || dj === 0 || (free[ci * N + nj] && free[ni * N + cj]))) {
                comp[n] = nc;
                stack.push(n);
              }
            }
          }
        }
        nc++;
      }
      for (let k = 0; k < 60; k++) {
        const pick = (): { i: number; j: number } => {
          for (;;) {
            const i = rng.int(20, N - 21);
            const j = rng.int(20, N - 21);
            if (free[i * N + j]) return { i, j };
          }
        };
        const a = pick();
        const b = pick();
        const reachable = comp[a.i * N + a.j] === comp[b.i * N + b.j];
        const A = P(a.i - R, a.j - R);
        const B = P(b.i - R, b.j - R);
        const p = nav.findPath(A, B, { maxExpansions: 200000 });
        pathsChecked++;
        if (reachable) bfsReachable++;
        if (p) {
          navFound++;
          if (!reachable) unsoundness++;
          expect(pathIsClear(w, p.points)).toBe(true);
          expect(p.length).toBeGreaterThanOrEqual(dist(A, B) - 1e-6);
        }
      }
    }
    console.info(`[nav vs BFS] pairs ${pathsChecked}, BFS-reachable ${bfsReachable}, nav found ${navFound}, nav paths where the 1 m lattice says unreachable ${unsoundness} (each verified clear)`);
    // (the lattice reference cannot follow a smooth path through a diagonal squeeze, so a few extra nav paths are legitimate;
    //  every returned path was verified against the World with pathIsClear above)
    expect(unsoundness).toBeLessThanOrEqual(Math.ceil(pathsChecked * 0.03));
    expect(navFound).toBeGreaterThanOrEqual(bfsReachable * 0.9);
    expect(bfsReachable).toBeGreaterThan(pathsChecked * 0.3);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// stage-scale cost
// ---------------------------------------------------------------------------------------------------------------------
/** 16 rooms of 110 x 90 m in a row, 8 m doorways alternating between two heights along z, crates, a barrier box in some doorways */
function chainStage(rooms: number): { boxes: BoxDef[]; barrierBoxIds: string[]; seed: V3; end: V3 } {
  const L = 110;
  const D = 90;
  const H = 32;
  const boxes: BoxDef[] = [];
  const barrierBoxIds: string[] = [];
  const doorZ = (i: number): number => (i % 2 === 0 ? 20 : 70);
  for (let i = 0; i < rooms; i++) {
    const x0 = i * L;
    const x1 = x0 + L;
    boxes.push(box(x0, -2, 0, x1, 0, D), box(x0, H, 0, x1, H + 2, D));
    boxes.push(box(x0, 0, -2, x1, H, 0), box(x0, 0, D, x1, H, D + 2));
    if (i === 0) boxes.push(box(x0 - 2, 0, 0, x0, H, D));
    // wall at the east end with a doorway [zc-4, zc+4] x [0, 7]
    if (i < rooms - 1) {
      const zc = doorZ(i);
      boxes.push(box(x1 - 1, 0, 0, x1 + 1, H, zc - 4), box(x1 - 1, 0, zc + 4, x1 + 1, H, D), box(x1 - 1, 7, zc - 4, x1 + 1, H, zc + 4));
      const id = `chain-door-${i}`;
      boxes.push(box(x1 - 1, 0, zc - 4, x1 + 1, 7, zc + 4, { id, barrierId: `B${i}` }));
      barrierBoxIds.push(id);
    } else boxes.push(box(x1, 0, 0, x1 + 2, H, D));
    for (const zc of [11, 79]) boxes.push(box(x0 + 50, 0, zc - 5, x0 + 60, 5, zc + 5));
    boxes.push(box(x0 + 30, 0, 40, x0 + 34, 12, 60)); // a pillar block in the middle
  }
  return { boxes, barrierBoxIds, seed: P(10, 45), end: P(rooms * L - 10, 45) };
}

describe('ステージ規模の構築コスト', () => {
  it('16室(1760m)の連結地形: 一度のflood-fillが数秒以内、その後のクエリは追加構築なし。隔壁を全て開けると全域を通れる', () => {
    const st = chainStage(16);
    const w = new World(st.boxes);
    const t0 = performance.now();
    const nav = buildNav(w);
    nav.seed(st.seed);
    let left = 1;
    let calls = 0;
    while (left > 0) {
      left = nav.warm(2000);
      calls++;
    }
    const buildMs = performance.now() - t0;
    const s = nav.stats();
    console.info(`[nav build] ${st.boxes.length} boxes, ${s.cells} nodes in ${s.columns} columns, flood-fill ${buildMs.toFixed(0)} ms (${calls} warm calls)`);
    expect(buildMs).toBeLessThan(3000);
    expect(s.cells).toBeGreaterThan(50000);
    // closed barriers: the chain is cut after room 0
    expect(nav.findPath(st.seed, st.end, { maxExpansions: 400000 })).toBeNull();
    const before = nav.stats().cells;
    for (const id of st.barrierBoxIds) w.setBoxEnabled(w.indexOfBox(id), false);
    const t1 = performance.now();
    const full = nav.findPath(st.seed, st.end, { maxExpansions: 600000 })!;
    const pathMs = performance.now() - t1;
    expect(full).not.toBeNull();
    expect(full.length).toBeGreaterThan(1700);
    expect(nav.stats().cells).toBe(before); // nothing new had to be built
    console.info(`[nav path] whole-stage route ${full.length.toFixed(0)} m, ${full.points.length} waypoints, ${pathMs.toFixed(0)} ms, ${nav.stats().expansions} expansions total`);
    // short queries (what the AI actually asks for) are cheap
    const t2 = performance.now();
    for (let k = 0; k < 200; k++) nav.findPath(P(300 + (k % 10), 30 + (k % 7)), P(360, 60), { partial: true });
    const shortMs = (performance.now() - t2) / 200;
    console.info(`[nav path] short (~60 m) query ${shortMs.toFixed(3)} ms avg`);
    expect(shortMs).toBeLessThan(5);
    expect(pathIsClear(w, full.points, 1)).toBe(true);
  });

  it('遅延構築のみ(seedなし)でも最初のクエリで必要な範囲だけを作る', () => {
    const st = chainStage(16);
    const w = new World(st.boxes);
    const nav = buildNav(w);
    const t0 = performance.now();
    const p = nav.findPath(P(20, 20), P(90, 60))!;
    const ms = performance.now() - t0;
    expect(p).not.toBeNull();
    expect(nav.stats().cells).toBeLessThan(8000); // far away rooms were never touched
    console.info(`[nav lazy] first query built ${nav.stats().cells} nodes in ${ms.toFixed(1)} ms`);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// incremental search (PathJob)
// ---------------------------------------------------------------------------------------------------------------------
/** run a job to the end with `budget` work units per step; returns the number of steps (the job must not be done before the first step) */
function runJob(job: PathJob, budget: number, maxSteps = 5_000_000): number {
  expect(job.done).toBe(false);
  let steps = 0;
  while (!job.done) {
    job.step(budget);
    steps++;
    if (steps > maxSteps) throw new Error('job did not finish');
  }
  return steps;
}

describe('段階実行の経路探索 (beginPath / PathJob)', () => {
  /** rooms with pillars, a wall with a gap, a sealed room, a platform: every kind of ending (found / partial / null) */
  function mixedWorld(): World {
    return new World([
      floor(),
      ...wallWithGap(-6, 6),
      box(-80, 0, 20, -60, 9, 60), // a block
      box(60, 0, 40, 100, 10, 42), box(60, 0, 78, 100, 10, 80), box(60, 0, 40, 62, 10, 80), box(98, 0, 40, 100, 10, 80), // sealed room
      box(40, 0, -60, 70, 8, -30), // a platform nobody can walk onto (8 m high)
    ]);
  }
  const QUERIES: { name: string; from: V3; to: V3; opts?: FindPathOptions }[] = [
    { name: '壁の隙間を回る', from: P(-40, -30), to: P(30, 40) },
    { name: '直線', from: P(-100, -100), to: P(100, -90) },
    { name: '密閉された部屋の中の目標: null', from: P(0, 30), to: P(80, 60) },
    { name: '同じ: partial (最寄りの点まで)', from: P(0, 30), to: P(80, 60), opts: { partial: true, maxExpansions: 15000, weight: 1.25 } },
    { name: '登れない台の上の目標: partial', from: P(-40, -30), to: P(55, -45, 8), opts: { partial: true, maxExpansions: 15000, weight: 1.25 } },
    { name: '展開数の上限で打ち切り: partial', from: P(-250, -250), to: P(250, 250), opts: { partial: true, maxExpansions: 300, weight: 1.25 } },
    { name: '展開数の上限で打ち切り: null', from: P(-250, -250), to: P(250, 250), opts: { maxExpansions: 300 } },
    { name: 'maxCost で打ち切り', from: P(-100, -100), to: P(100, 100), opts: { maxCost: 120 } },
    { name: 'weight 1 (最適)', from: P(-40, -30), to: P(30, 40), opts: { weight: 1 } },
    { name: '立てない目標 (ブロックに密着): partial', from: P(-40, 40), to: P(-59.5, 40), opts: { partial: true } },
    { name: '始点が壁の中: null', from: P(-70, 40), to: P(0, 0) },
  ];

  it('結果は findPath と完全に一致する (予約 1 / 7 / 100 / 無制限の作業量で区切っても同じ)', () => {
    const w = mixedWorld();
    const nav = buildNav(w);
    let found = 0;
    let partial = 0;
    let none = 0;
    for (const q of QUERIES) {
      const want = nav.findPath(q.from, q.to, q.opts);
      if (want === null) none++;
      else if (want.partial) partial++;
      else found++;
      for (const budget of [1, 7, 100, Infinity]) {
        const job = nav.beginPath(q.from, q.to, q.opts);
        expect(job.done, `${q.name}: not done before the first step`).toBe(false);
        expect(job.work, q.name).toBe(0);
        runJob(job, budget);
        expect(job.result, `${q.name} (budget ${budget})`).toEqual(want);
        expect(job.work, q.name).toBeGreaterThan(0);
      }
    }
    // the queries above really cover all three endings
    expect(found).toBeGreaterThanOrEqual(3);
    expect(partial).toBeGreaterThanOrEqual(3);
    expect(none).toBeGreaterThanOrEqual(2);
  });

  it('ランダム地形でも findPath と一致 (経路・長さ・partial の全フィールド)', () => {
    let compared = 0;
    let nonNull = 0;
    for (const seed of [11, 12, 13]) {
      const rng = new Rng(seed);
      const boxes: BoxDef[] = [floor()];
      for (let i = 0; i < 35; i++) {
        const x = rng.range(-90, 80);
        const z = rng.range(-90, 80);
        if (rng.next() < 0.6) {
          const len = rng.range(15, 60);
          if (rng.next() < 0.5) boxes.push(box(x, 0, z, x + len, 10, z + 2));
          else boxes.push(box(x, 0, z, x + 2, 10, z + len));
        } else boxes.push(box(x, 0, z, x + rng.range(3, 10), rng.range(2, 8), z + rng.range(3, 10)));
      }
      const nav = buildNav(new World(boxes));
      for (let k = 0; k < 40; k++) {
        const a = P(rng.range(-95, 95), rng.range(-95, 95));
        const b = P(rng.range(-95, 95), rng.range(-95, 95));
        const opts: FindPathOptions = k % 2 === 0 ? { partial: true, maxExpansions: 15000, weight: 1.25 } : { maxExpansions: 200000 };
        const want = nav.findPath(a, b, opts);
        const job = nav.beginPath(a, b, opts);
        runJob(job, [3, 50, 400][k % 3]);
        expect(job.result).toEqual(want);
        compared++;
        if (want) nonNull++;
      }
    }
    expect(compared).toBe(120);
    expect(nonNull).toBeGreaterThan(40);
  });

  it('1 回の step は予算をほぼ守り (超過は 1 ノード展開 / 平滑化の 1 区間分だけ)、終わった後の step は何もしない', () => {
    const w = new World([floor(), box(-100, 0, 40, 100, 10, 44)]); // a long wall: the search has to fan out
    const nav = buildNav(w);
    const job = nav.beginPath(P(0, 20), P(0, 70), { maxExpansions: 100000 });
    const deltas: number[] = [];
    let steps = 0;
    while (!job.done) {
      const before = job.work;
      job.step(200);
      deltas.push(job.work - before);
      steps++;
      expect(steps).toBeLessThan(1e6);
    }
    expect(steps).toBeGreaterThan(5); // it really was spread over many steps
    // the resolve phase (a fixed charge) and one smoothing anchor are the only things that can overshoot a small budget
    for (const d of deltas.slice(0, -1)) expect(d).toBeGreaterThanOrEqual(200 - 1e-9);
    for (const d of deltas) expect(d).toBeLessThan(200 + NAV.RESOLVE_WORK + 3000); // (one anchor probes up to 41 legs of ~100 m)
    expect(job.result).toEqual(nav.findPath(P(0, 20), P(0, 70), { maxExpansions: 100000 }));
    const work = job.work;
    const result = job.result;
    expect(job.step(1000)).toBe(true);
    expect(job.work).toBe(work);
    expect(job.result).toBe(result);
  });

  it('途中で findPath / pathLength が呼ばれても、進行中の探索は乱れない (探索用の作業領域は別)', () => {
    const w = mixedWorld();
    const nav = buildNav(w);
    const opts = { partial: true, maxExpansions: 15000, weight: 1.25 };
    const from = P(-200, -150);
    const to = P(200, 150);
    const want = nav.findPath(from, to, opts);
    expect(want).not.toBeNull();
    const job = nav.beginPath(from, to, opts);
    let steps = 0;
    while (!job.done) {
      job.step(60);
      // other queries in between, ones that use the same cells (other start / goal, bounded search)
      expect(nav.findPath(P(30, 40), P(-40, -30), { partial: true })).not.toBeNull();
      expect(nav.pathLength(P(-40, -30), P(-40, 30), 200)).not.toBeNull();
      steps++;
    }
    expect(steps).toBeGreaterThan(10);
    expect(job.result).toEqual(want);
  });

  it('別のジョブが探索領域を使った後に再開しても結果は同じ (最初からやり直す。交互に細かく進めると終わらないので 1 つずつ使うこと)', () => {
    const w = mixedWorld();
    const nav = buildNav(w);
    const opts = { partial: true, maxExpansions: 15000, weight: 1.25 };
    const fromA = P(-200, -150);
    const toA = P(200, 150);
    const fromB = P(-150, -100);
    const toB = P(120, 90);
    const want = nav.findPath(fromA, toA, opts);
    const a = nav.beginPath(fromA, toA, opts);
    a.step(300); // started, paused in the middle of the search (which covers the same cells as b's)
    expect(a.done).toBe(false);
    const b = nav.beginPath(fromB, toB, opts);
    runJob(b, Infinity); // b takes over the cells' scratch, and finishes
    expect(b.result).toEqual(nav.findPath(fromB, toB, opts));
    runJob(a, Infinity);
    expect(a.result).toEqual(want);
  });

  it('始点・終点はコピーされる (beginPath の後に呼び出し側が書き換えても影響しない)。統計 (queries / expansions) に数えられる', () => {
    const w = mixedWorld();
    const nav = buildNav(w);
    const from = P(-40, -30);
    const to = P(30, 40);
    const want = nav.findPath(from, to)!;
    const s0 = nav.stats();
    const job = nav.beginPath(from, to);
    from.x = 999;
    to.z = -999;
    runJob(job, 500);
    expect(job.result).toEqual(want);
    const s1 = nav.stats();
    expect(s1.queries - s0.queries).toBe(1);
    expect(s1.expansions - s0.expansions).toBeGreaterThan(50);
    // the same search as findPath: the same number of expansions
    const s2 = nav.stats();
    nav.findPath(P(-40, -30), P(30, 40));
    expect(nav.stats().expansions - s2.expansions).toBe(s1.expansions - s0.expansions);
  });

  it('隔壁の状態は各ステップで読む: 探索の途中で開いた隔壁は、その後の展開から通れる', () => {
    const door = box(-4, 0, -1, 4, 8, 1, { id: 'jdoor', barrierId: 'BJ' });
    const w = new World([floor(), ...wallWithGap(-4, 4, [box(-4, 8, -1, 4, 12, 1), door])]);
    const nav = buildNav(w);
    const a = P(0, -20);
    const b = P(0, 20);
    const closed = nav.beginPath(a, b);
    runJob(closed, Infinity);
    expect(closed.result).toBeNull();
    w.setBoxEnabled(w.indexOfBox('jdoor'), false);
    const open = nav.beginPath(a, b);
    runJob(open, 40);
    expect(open.result).toEqual(nav.findPath(a, b));
    expect(open.result).not.toBeNull();
  });
});
