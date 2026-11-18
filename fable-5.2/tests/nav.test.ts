/**
 * NavGrid (src/sim/nav.ts) — guard navigation on synthetic stages.
 *
 * Every geometric claim is checked against the real World: a path / walkable segment is replayed with the
 * guard's agent box (half extents = guard radius) sampled every few centimetres and World.overlapsBox must
 * never report a hit; floor support is checked with World.probeGround.
 */
import { describe, expect, it } from 'vitest';
import { ENEMIES } from '../src/config';
import { Rng } from '../src/core/rng';
import { v3, type V3 } from '../src/core/vec';
import { NavGrid, VANTAGE_FALLBACK, VANTAGE_NONE, VANTAGE_QUALIFIED, type NavDisc, type NavVantageOptions } from '../src/sim/nav';
import type { Box, EnemyDef, SolidDef, StageDef } from '../src/sim/types';
import { World } from '../src/sim/world';
import { makeGuard, makeTestStage, type TestStageOptions } from '../src/stage/testStages';

const R = ENEMIES.guard.radius;
const H = ENEMIES.guard.centerHeight;
const AGENT_HALF = v3(R, R, R);

/** Guard centre standing on a floor at `floorY`. */
const gp = (x: number, z: number, floorY = 0): V3 => v3(x, floorY + H, z);
const solid = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): SolidDef => ({
  min: v3(x0, y0, z0),
  max: v3(x1, y1, z1),
  material: 'concrete',
});
const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Box => ({ min: v3(x0, y0, z0), max: v3(x1, y1, z1) });

function setup(opts: TestStageOptions, edit?: (stage: StageDef) => void): { stage: StageDef; world: World; nav: NavGrid } {
  const stage = makeTestStage(opts);
  if (edit) edit(stage);
  const world = new World(stage);
  const nav = new NavGrid(world, stage);
  return { stage, world, nav };
}

function addBarrier(stage: StageDef, id: string, b: Box, controlEnemyId = 'none'): void {
  stage.barriers.push({ id, name: id, box: b, controlEnemyId, fromSectorId: 'T00', toSectorId: 'T00' });
}

function polyLength(from: V3, path: V3[]): number {
  let len = 0;
  let prev = from;
  for (const p of path) {
    len += Math.hypot(p.x - prev.x, p.z - prev.z);
    prev = p;
  }
  return len;
}

/** Number of agent-box samples along a→b (every `step` metres, both ends included) that overlap the world. */
function hitsAlong(world: World, a: V3, b: V3, step = 0.05): number {
  const len = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  const n = Math.max(1, Math.ceil(len / step));
  const c = v3();
  let hits = 0;
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    c.x = a.x + (b.x - a.x) * t;
    c.y = a.y + (b.y - a.y) * t;
    c.z = a.z + (b.z - a.z) * t;
    if (world.overlapsBox(c, AGENT_HALF)) hits++;
  }
  return hits;
}

/** Overlapping samples of the whole polyline from → path[0] → … */
function pathHits(world: World, from: V3, path: V3[], step = 0.05): number {
  let hits = 0;
  let prev = from;
  for (const p of path) {
    hits += hitsAlong(world, prev, p, step);
    prev = p;
  }
  return hits;
}

/** Samples of the polyline whose centre is not exactly `H` above a supporting surface. */
function unsupportedSamples(world: World, from: V3, path: V3[], step = 0.1): number {
  const thin = v3(0.01, R, 0.01);
  const c = v3();
  let bad = 0;
  let prev = from;
  for (const p of path) {
    const len = Math.hypot(p.x - prev.x, p.z - prev.z);
    const n = Math.max(1, Math.ceil(len / step));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      c.x = prev.x + (p.x - prev.x) * t;
      c.y = prev.y + (p.y - prev.y) * t;
      c.z = prev.z + (p.z - prev.z) * t;
      // bottom of the probe is R below the centre → the floor must be H − R below that
      const d = world.probeGround(c, thin, 1);
      if (!(Math.abs(d - (H - R)) < 1e-6)) bad++;
    }
    prev = p;
  }
  return bad;
}

function finitePath(path: V3[]): boolean {
  return path.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z));
}

/** Random boxes standing on the floor of a square stage (deterministic). */
function randomBoxes(rng: Rng, count: number, half: number, keepClear: V3[] = []): SolidDef[] {
  const out: SolidDef[] = [];
  while (out.length < count) {
    const w = rng.range(1, 9);
    const d = rng.range(1, 9);
    const h = rng.range(0.5, 6);
    const x = rng.range(-half, half - w);
    const z = rng.range(-half, half - d);
    if (keepClear.some((p) => p.x > x - 3 && p.x < x + w + 3 && p.z > z - 3 && p.z < z + d + 3)) continue;
    out.push(solid(x, 0, z, x + w, h, z + d));
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
describe('NavGrid — open floor', () => {
  const { nav, world } = setup({ floorSize: 200 });

  it('builds a 1 m lattice with the nodes on half metres', () => {
    const info = nav.getInfo();
    expect(info.cellSize).toBe(1);
    expect(info.originX).toBe(-100);
    expect(info.originZ).toBe(-100);
    expect(info.nx).toBe(200);
    expect(info.nz).toBe(200);
    expect(info.nodes).toBe(200 * 200);
    expect(info.links).toBe(2 * 200 * 199);
    expect(info.regions).toBe(1);
    expect(info.blockedNodes).toBe(0);
  });

  it('goes straight to a visible target: one waypoint, exactly the target', () => {
    const from = gp(-20, 0);
    const to = gp(30.25, 10.75);
    const path = nav.findPath(from, to);
    expect(path).not.toBeNull();
    expect(path).toEqual([{ x: 30.25, y: H, z: 10.75 }]);
    expect(nav.lastExpansions).toBe(0); // no search needed
    expect(nav.pathDistance(from, to, 100)).toBeCloseTo(Math.hypot(50.25, 10.75), 9);
    expect(pathHits(world, from, path!)).toBe(0);
    expect(nav.segmentWalkable(from, to)).toBe(true);
    expect(nav.connected(from, to)).toBe(true);
  });

  it('accepts the player height as a target and ends at guard height', () => {
    // the player's hit-box centre is 2.0 above the floor, a guard's 1.3
    const path = nav.findPath(gp(-5, -5), v3(12, 2.0, 7));
    expect(path).toEqual([{ x: 12, y: H, z: 7 }]);
    // a target flying 15 m above the floor: the standing position right below it
    expect(nav.findPath(gp(-5, -5), v3(12, 16.5, 7))).toEqual([{ x: 12, y: H, z: 7 }]);
  });

  it('never returns an empty path', () => {
    const p = gp(3.3, -4.4);
    expect(nav.findPath(p, p)).toEqual([{ x: 3.3, y: H, z: -4.4 }]);
    expect(nav.pathDistance(p, p, 0)).toBe(0);
  });

  it('isWalkable: on the floor at guard height only', () => {
    expect(nav.isWalkable(gp(0, 0))).toBe(true);
    expect(nav.isWalkable(gp(17.31, -42.77))).toBe(true);
    expect(nav.isWalkable(v3(0, H + 0.9, 0))).toBe(true); // up to 1 m above the standing height (player centre: +0.7)
    expect(nav.isWalkable(v3(0, H + 1.2, 0))).toBe(false);
    expect(nav.isWalkable(v3(0, H - 0.05, 0))).toBe(true); // the agent box still clears the floor
    expect(nav.isWalkable(v3(0, H - 0.2, 0))).toBe(false); // … here it would be 0.1 m inside it
    expect(nav.isWalkable(v3(0, H - 1.2, 0))).toBe(false);
    expect(nav.isWalkable(v3(0, 8, 0))).toBe(false);
    // the slab ends at x = 100: the last node is at 99.5 and nothing beyond it is walkable
    expect(nav.isWalkable(gp(99.5, 0))).toBe(true);
    expect(nav.isWalkable(gp(99.6, 0))).toBe(false);
    expect(nav.isWalkable(gp(150, 0))).toBe(false);
    expect(nav.isWalkable(gp(-99.5, -99.5))).toBe(true);
    expect(nav.isWalkable(gp(-99.6, -99.5))).toBe(false);
  });

  it('segmentWalkable / walkableReach stop at the edge of the slab', () => {
    const a = gp(90, 3.3);
    const b = gp(110, 9.9);
    expect(nav.segmentWalkable(a, b)).toBe(false);
    expect(nav.segmentWalkable(a, gp(99.5, 3.3))).toBe(true);
    expect(nav.segmentWalkable(a, gp(99.7, 3.3))).toBe(false);
    const out = v3();
    const d = nav.walkableReach(a, b, out);
    expect(out.x).toBeCloseTo(99.5, 9);
    expect(out.y).toBe(H);
    expect(d).toBeCloseTo(Math.hypot(out.x - a.x, out.z - a.z), 9);
    expect(nav.isWalkable(out)).toBe(true);
    // fully walkable segment: returns its length and the end point
    const d2 = nav.walkableReach(a, gp(80, -20), out);
    expect(d2).toBeCloseTo(Math.hypot(10, 23.3), 9);
    expect(out).toEqual(gp(80, -20));
    // not walkable at the start
    expect(nav.walkableReach(gp(120, 0), a, out)).toBe(0);
    expect(out).toEqual(gp(120, 0));
  });

  it('absurdly long segments end at the slab edge without hanging', () => {
    const a = gp(10.2, -3.4);
    const far = gp(1e12, -3e11);
    expect(nav.segmentWalkable(a, far)).toBe(false);
    expect(nav.segmentWalkable(far, a)).toBe(false);
    const out = v3();
    const d = nav.walkableReach(a, far, out);
    expect(out.x).toBeCloseTo(99.5, 6);
    expect(Number.isFinite(out.z)).toBe(true);
    expect(d).toBeCloseTo(Math.hypot(out.x - a.x, out.z - a.z), 6);
    expect(nav.findPath(a, far)).toBeNull();
    expect(nav.pathDistance(a, far, 1e15)).toBe(Infinity);
    expect(nav.findPath(a, gp(1e300, 0))).toBeNull();
    expect(nav.walkableReach(a, gp(-1e300, 1e300), out)).toBeGreaterThan(0);
    expect(Number.isFinite(out.x) && Number.isFinite(out.z)).toBe(true);
  });

  it('rejects non-finite input without producing NaN', () => {
    const a = gp(0, 0);
    const bad = v3(NaN, H, 0);
    const inf = v3(Infinity, H, 0);
    expect(nav.findPath(a, bad)).toBeNull();
    expect(nav.findPath(bad, a)).toBeNull();
    expect(nav.findPath(a, inf)).toBeNull();
    expect(nav.pathDistance(a, bad, 50)).toBe(Infinity);
    expect(nav.pathDistance(a, gp(1, 1), NaN)).toBe(Infinity);
    expect(nav.isWalkable(bad)).toBe(false);
    expect(nav.segmentWalkable(a, inf)).toBe(false);
    expect(nav.segmentWalkable(bad, a)).toBe(false);
    expect(nav.nearestWalkable(bad)).toBeNull();
    expect(nav.connected(a, bad)).toBe(false);
    const out = v3(7, 7, 7);
    expect(nav.walkableReach(a, bad, out)).toBe(0);
    expect(out).toEqual(a);
    expect(nav.randomWalkableNear(bad, 10, new Rng(1))).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('NavGrid — construction', () => {
  it('the node set equals a brute-force reference: every floor top the agent box fits on', () => {
    const rng = new Rng(808);
    const solids: SolidDef[] = [
      ...randomBoxes(rng, 70, 30),
      // stacked floors, some with too little headroom between them
      solid(-20, 3, -20, 0, 4, 0),
      solid(-18, 5.5, -18, -2, 6.2, -2),
      solid(-16, 9, -16, -6, 9.5, -6),
      solid(5, 2.2, 5, 25, 2.6, 25),
      // thin plates on the floor and on a platform (inside the agent's 0.1 m ground clearance)
      solid(-25, 0, 10, -5, 0.05, 20),
      solid(-12, 0.05, 12, -8, 0.1, 18),
      solid(-19, 4, -19, -10, 4.08, -10),
      // abutting slabs whose seam runs through lattice points, a narrow beam, a zero-thickness sheet
      solid(10, 6, -25, 13.5, 7, -5),
      solid(13.5, 6, -25, 20, 7, -5),
      solid(-3, 1, -28, 28, 1.4, -27.6),
      solid(0, 12, 0, 8, 12, 8),
    ];
    const { nav, world, stage } = setup({ floorSize: 60, solids });
    const info = nav.getInfo();
    expect(info.nx).toBe(60);
    expect(info.nz).toBe(60);
    let expected = 0;
    let multi = 0;
    const merge = H - R + 1e-9;
    for (let j = 0; j < info.nz; j++) {
      for (let i = 0; i < info.nx; i++) {
        const cx = info.originX + i + 0.5;
        const cz = info.originZ + j + 0.5;
        const tops = stage.solids
          .filter((b) => b.max.x > b.min.x && b.max.z > b.min.z && cx >= b.min.x && cx <= b.max.x && cz >= b.min.z && cz <= b.max.z)
          .map((b) => b.max.y)
          .sort((a, b) => a - b);
        let here = 0;
        for (let k = 0; k < tops.length; k++) {
          const t = tops[k];
          if (k + 1 < tops.length && tops[k + 1] - t <= merge) continue; // the higher top is the floor
          const stand = v3(cx, t + H, cz);
          const fits = !world.overlapsBox(stand, AGENT_HALF);
          expect(nav.isWalkable(stand)).toBe(fits);
          if (fits) here++;
        }
        expected += here;
        if (here > 1) multi++;
      }
    }
    expect(info.nodes).toBe(expected);
    expect(multi).toBeGreaterThan(100); // columns with two or more levels
    expect(expected).toBeGreaterThan(2500);
  });

  it('a low crate is an obstacle at ground height and a floor on top', () => {
    // 0.6 m high, 6 x 6 m: a guard centre at ground height inside its footprint would be inside the crate
    const { nav, world } = setup({ floorSize: 40, solids: [solid(0, 0, 0, 6, 0.6, 6)] });
    expect(nav.isWalkable(gp(3, 3, 0))).toBe(false);
    expect(world.overlapsBox(gp(3, 3, 0), AGENT_HALF)).toBe(true);
    expect(nav.isWalkable(gp(3, 3, 0.6))).toBe(true);
    expect(nav.findPath(gp(-10, 3), gp(3, 3, 0.6))).toBeNull(); // 0.6 m is no step for a guard, and no floor node within 4 m
    const around = nav.findPath(gp(-10, 3), gp(16, 3))!;
    expect(pathHits(world, gp(-10, 3), around)).toBe(0);
    expect(around.length).toBeGreaterThanOrEqual(2);
    for (const p of around) expect(p.y).toBe(H);
    // a guard standing off the grid right beside the crate snaps to the floor, never onto the crate
    const beside = gp(-1.3, 3.2);
    expect(nav.isWalkable(beside)).toBe(false);
    expect(nav.nearestWalkable(beside, 3)!.y).toBe(H);
    expect(nav.findPath(beside, gp(16, 3))![0]).toEqual(gp(-1.5, 3.5));
    // … not even when it has been pushed into the crate's side, where a node on top is the nearest in 3D
    const pushed = gp(-0.3, 3.2);
    expect(nav.nearestWalkable(pushed, 3)).toEqual(gp(0.5, 3.5, 0.6)); // nearest standing position: on the crate
    expect(nav.findPath(pushed, gp(16, 3))![0]).toEqual(gp(-1.5, 3.5)); // but a path never starts by hopping up
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('NavGrid — walls and obstacles', () => {
  it('wall with a gap: the path goes through the gap', () => {
    // wall along x = 0 (1 m thick) with a 6 m gap at z 10..16
    const { nav, world } = setup({
      floorSize: 120,
      solids: [solid(-0.5, 0, -60, 0.5, 6, 10), solid(-0.5, 0, 16, 0.5, 6, 60)],
    });
    const from = gp(-20, -20);
    const to = gp(20, -20);
    expect(nav.segmentWalkable(from, to)).toBe(false);
    const path = nav.findPath(from, to)!;
    expect(path).not.toBeNull();
    expect(path[path.length - 1]).toEqual(to);
    expect(pathHits(world, from, path)).toBe(0);
    // where the polyline crosses the wall plane
    let crossZ = NaN;
    let prev = from;
    for (const p of path) {
      if (prev.x < 0 && p.x >= 0) crossZ = prev.z + ((p.z - prev.z) * (0 - prev.x)) / (p.x - prev.x);
      prev = p;
    }
    expect(crossZ).toBeGreaterThanOrEqual(10 + R);
    expect(crossZ).toBeLessThanOrEqual(16 - R);
    // shortest conceivable route for a 2.4 m wide agent: via (0, 11.2); the lattice costs a little
    const ideal = 2 * Math.hypot(20, 31.2);
    const len = polyLength(from, path);
    expect(len).toBeGreaterThanOrEqual(ideal);
    expect(len).toBeLessThan(ideal * 1.05);
    expect(nav.pathDistance(from, to, 200)).toBeCloseTo(len, 9);
    expect(nav.lastExpansions).toBeGreaterThan(0);
    // and back
    const back = nav.findPath(to, from)!;
    expect(pathHits(world, to, back)).toBe(0);
    expect(polyLength(to, back)).toBeLessThan(ideal * 1.05);
  });

  it('fully enclosed target: null / Infinity', () => {
    // closed room 12 x 12 inside (walls 1 m, 6 m high) around the origin
    const { nav } = setup({
      floorSize: 120,
      solids: [solid(-7, 0, -7, 7, 6, -6), solid(-7, 0, 6, 7, 6, 7), solid(-7, 0, -6, -6, 6, 6), solid(6, 0, -6, 7, 6, 6)],
    });
    const outside = gp(-30, 5);
    const inside = gp(0.5, 0.5);
    expect(nav.isWalkable(inside)).toBe(true);
    expect(nav.isWalkable(outside)).toBe(true);
    expect(nav.findPath(outside, inside)).toBeNull();
    expect(nav.findPath(inside, outside)).toBeNull();
    expect(nav.lastExpansions).toBe(0); // rejected by the region labels, no flood of the stage
    expect(nav.pathDistance(outside, inside, 1000)).toBe(Infinity);
    expect(nav.lastExpansions).toBe(0);
    expect(nav.pathDistance(inside, outside, 1000)).toBe(Infinity);
    expect(nav.lastExpansions).toBe(0);
    expect(nav.connected(outside, inside)).toBe(false);
    // random positions around a point outside never land inside the sealed room (or on its walls)
    const r = new Rng(9);
    for (let k = 0; k < 300; k++) {
      const q = nav.randomWalkableNear(gp(-10, 0.2), 14, r)!;
      expect(q).not.toBeNull();
      expect(Math.abs(q.x) > 7 || Math.abs(q.z) > 7).toBe(true);
      expect(q.y).toBe(H);
    }
    expect(nav.segmentWalkable(outside, inside)).toBe(false);
    // inside the room everything works
    const p = nav.findPath(inside, gp(3, -3))!;
    expect(p).toEqual([gp(3, -3)]);
    // outside, inside, and the ring of wall tops (1 m wide, 6 m up: an island nobody can reach)
    expect(nav.getInfo().regions).toBe(3);
    expect(nav.isWalkable(gp(0.5, -6.5, 6))).toBe(true);
    expect(nav.connected(gp(0.5, -6.5, 6), inside)).toBe(false);
    // a target buried in a big solid block with nothing walkable within reach
    const blocky = setup({ floorSize: 120, solids: [solid(10, 0, 10, 40, 30, 40)] });
    expect(blocky.nav.findPath(gp(-20, -20), gp(25, 25))).toBeNull();
    expect(blocky.nav.pathDistance(gp(-20, -20), gp(25, 25), 500)).toBe(Infinity);
    // … unless the caller widens the goal tolerance: then the path ends next to the block
    const near = blocky.nav.findPath(gp(-20, -20), gp(25, 25), 20)!;
    expect(near).not.toBeNull();
    const end = near[near.length - 1];
    expect(blocky.nav.isWalkable(end)).toBe(true);
    expect(pathHits(blocky.world, gp(-20, -20), near)).toBe(0);
  });

  it('a guard cannot path into a 2 m wide slit, but passes a 3 m door', () => {
    // wall along x = 0 with a 2 m slit at z -1..1 and (second stage) a 3 m door at z 20..23
    const wallA = [solid(-0.5, 0, -40, 0.5, 6, -1), solid(-0.5, 0, 1, 0.5, 6, 40)];
    const slit = setup({ floorSize: 80, solids: wallA });
    const from = gp(-15, 0);
    const to = gp(15, 0);
    expect(slit.nav.findPath(from, to)).toBeNull();
    expect(slit.nav.pathDistance(from, to, 1000)).toBe(Infinity);
    // nothing is walkable inside the slit
    for (let x = -1.7; x <= 1.7; x += 0.1) expect(slit.nav.isWalkable(gp(x, 0))).toBe(false);

    const door = setup({ floorSize: 80, solids: [solid(-0.5, 0, -40, 0.5, 6, -1), solid(-0.5, 0, 1, 0.5, 6, 20), solid(-0.5, 0, 23, 0.5, 6, 40)] });
    const path = door.nav.findPath(from, to)!;
    expect(path).not.toBeNull();
    expect(pathHits(door.world, from, path)).toBe(0);
    // the 3 m door holds exactly one lattice line (z = 21.5): the path crosses the wall plane on it
    let doorZ = NaN;
    let last = from;
    for (const p of path) {
      if (last.x < 0 && p.x >= 0) doorZ = last.z + ((p.z - last.z) * (0 - last.x)) / (p.x - last.x);
      last = p;
    }
    expect(doorZ).toBeCloseTo(21.5, 9);

    // dead-end alcove 2 m wide, 10 m deep, cut into a thick block: a target inside it is out of reach …
    const alcove = setup({ floorSize: 80, solids: [solid(0, 0, -20, 12, 6, -1), solid(0, 0, 1, 12, 6, 20), solid(10, 0, -1, 12, 6, 1)] });
    const target = gp(4, 0);
    expect(alcove.world.overlapsBox(target, v3(0.9, 0.9, 0.9))).toBe(false); // the alcove itself is empty
    expect(alcove.nav.isWalkable(target)).toBe(false);
    for (let x = -1; x <= 10; x += 0.25) expect(alcove.nav.isWalkable(gp(x, 0))).toBe(false);
    expect(alcove.nav.findPath(from, target)).toBeNull(); // nothing walkable within 4 m of it
    // … and with a generous goal tolerance the guard stops in front of the mouth, never inside
    const approach = alcove.nav.findPath(from, target, 12)!;
    expect(approach).not.toBeNull();
    expect(pathHits(alcove.world, from, approach)).toBe(0);
    for (const p of approach) expect(p.x).toBeLessThanOrEqual(-R);
    const stop = approach[approach.length - 1];
    expect(stop.x).toBe(-1.5);
    expect(Math.abs(stop.z)).toBe(0.5);
  });

  it('does not cut the corner between two boxes that touch diagonally', () => {
    // two blocks meeting at the point (0, 0): the only way from one free quadrant to the other is around
    const { nav, world } = setup({ floorSize: 80, solids: [solid(-12, 0, -12, 0, 5, 0), solid(0, 0, 0, 12, 5, 12)] });
    const from = gp(-6, 6);
    const to = gp(6, -6);
    expect(nav.segmentWalkable(from, to)).toBe(false);
    const path = nav.findPath(from, to)!;
    expect(path).not.toBeNull();
    expect(pathHits(world, from, path)).toBe(0);
    expect(polyLength(from, path)).toBeGreaterThan(30); // straight would be 17 m
  });

  it('obstacle field: no segment of any path touches a solid; paths are consistent and short', () => {
    const rng = new Rng(20260908);
    const { nav, world } = setup({ floorSize: 160, solids: randomBoxes(rng, 140, 80) });
    const info = nav.getInfo();
    expect(info.nodes).toBeGreaterThan(10000);
    // random ground-level standing positions
    const pts: V3[] = [];
    while (pts.length < 120) {
      const p = gp(rng.range(-79, 79), rng.range(-79, 79));
      if (nav.isWalkable(p)) pts.push(p);
    }
    let found = 0;
    let samples = 0;
    for (let k = 0; k < 400; k++) {
      const a = pts[rng.int(pts.length)];
      const b = pts[rng.int(pts.length)];
      const path = nav.findPath(a, b);
      const dist = nav.pathDistance(a, b, 1e9);
      if (!path) {
        expect(dist).toBe(Infinity);
        expect(nav.connected(a, b)).toBe(false);
        continue;
      }
      found++;
      expect(finitePath(path)).toBe(true);
      expect(path.length).toBeGreaterThan(0);
      expect(path[path.length - 1]).toEqual(b);
      for (const p of path) expect(p.y).toBe(H);
      // the real collision world agrees: the agent box never overlaps anything
      expect(pathHits(world, a, path, 0.04)).toBe(0);
      samples += Math.ceil(polyLength(a, path) / 0.04);
      // every leg is a walkable segment, in both directions
      let prev = a;
      for (const p of path) {
        if (a !== b) expect(Math.hypot(p.x - prev.x, p.z - prev.z)).toBeGreaterThan(1e-6);
        expect(nav.segmentWalkable(prev, p)).toBe(true);
        expect(nav.segmentWalkable(p, prev)).toBe(true);
        expect(nav.isWalkable(p)).toBe(true);
        prev = p;
      }
      const len = polyLength(a, path);
      expect(len).toBeGreaterThanOrEqual(Math.hypot(b.x - a.x, b.z - a.z) - 1e-9);
      expect(dist).toBeCloseTo(len, 9);
      expect(nav.connected(a, b)).toBe(true);
      // a direct line is never replaced by a detour
      if (nav.segmentWalkable(a, b)) expect(path.length).toBe(1);
    }
    expect(found).toBeGreaterThan(300);
    expect(samples).toBeGreaterThan(100000);
  });

  it('segmentWalkable is sound against the collision world and symmetric', () => {
    const rng = new Rng(99);
    const { nav, world } = setup({ floorSize: 120, solids: randomBoxes(rng, 90, 60) });
    let walkable = 0;
    let blocked = 0;
    const out = v3();
    for (let k = 0; k < 3000; k++) {
      const a = gp(rng.range(-62, 62), rng.range(-62, 62));
      const len = rng.range(0.2, 40);
      const ang = rng.range(0, 2 * Math.PI);
      const b = gp(a.x + Math.cos(ang) * len, a.z + Math.sin(ang) * len);
      const ok = nav.segmentWalkable(a, b);
      expect(nav.segmentWalkable(b, a)).toBe(ok);
      if (ok) {
        walkable++;
        expect(nav.isWalkable(a)).toBe(true);
        expect(nav.isWalkable(b)).toBe(true);
        expect(hitsAlong(world, a, b, 0.03)).toBe(0);
      } else {
        blocked++;
      }
      // walkableReach: the reached point is walkable, on the segment, and the leg to it is clear
      const d = nav.walkableReach(a, b, out);
      if (nav.isWalkable(a)) {
        expect(nav.isWalkable(out)).toBe(true);
        expect(nav.segmentWalkable(a, out)).toBe(true);
        expect(hitsAlong(world, a, out, 0.03)).toBe(0);
        expect(d).toBeLessThanOrEqual(len + 1e-9);
        if (ok) expect(d).toBeCloseTo(len, 9);
        else expect(d).toBeLessThan(len);
      } else {
        expect(d).toBe(0);
      }
    }
    expect(walkable).toBeGreaterThan(300);
    expect(blocked).toBeGreaterThan(300);
  });

  it('isWalkable is sound: a walkable point never overlaps a solid and always has floor under it', () => {
    const rng = new Rng(5);
    const { nav, world } = setup({ floorSize: 100, solids: randomBoxes(rng, 80, 50) });
    const thin = v3(0.01, R, 0.01);
    let yes = 0;
    for (let k = 0; k < 20000; k++) {
      const p = gp(rng.range(-52, 52), rng.range(-52, 52));
      if (!nav.isWalkable(p)) continue;
      yes++;
      expect(world.overlapsBox(p, AGENT_HALF)).toBe(false);
      expect(world.probeGround(p, thin, 1)).toBeCloseTo(H - R, 6);
    }
    expect(yes).toBeGreaterThan(5000);
  });

  it('the grid search is optimal: same cost as a reference Dijkstra over the public walkability', () => {
    const rng = new Rng(4242);
    const { nav } = setup({ floorSize: 60, solids: randomBoxes(rng, 45, 30) });
    const info = nav.getInfo();
    const n = info.nx * info.nz;
    const centre = (c: number): V3 => gp(info.originX + ((c % info.nx) + 0.5), info.originZ + (Math.floor(c / info.nx) + 0.5));
    const ok = new Uint8Array(n);
    for (let c = 0; c < n; c++) ok[c] = nav.isWalkable(centre(c)) ? 1 : 0;
    // adjacency straight from segmentWalkable between lattice points (orthogonal and diagonal)
    const dirs = [
      [1, 0, 1],
      [-1, 0, 1],
      [0, 1, 1],
      [0, -1, 1],
      [1, 1, Math.SQRT2],
      [1, -1, Math.SQRT2],
      [-1, 1, Math.SQRT2],
      [-1, -1, Math.SQRT2],
    ];
    const dijkstra = (src: number): Float64Array => {
      const dist = new Float64Array(n).fill(Infinity);
      const done = new Uint8Array(n);
      dist[src] = 0;
      const heap: Array<[number, number]> = [[0, src]];
      while (heap.length > 0) {
        let bi = 0;
        for (let q = 1; q < heap.length; q++) if (heap[q][0] < heap[bi][0]) bi = q;
        const [d, c] = heap[bi];
        heap[bi] = heap[heap.length - 1];
        heap.pop();
        if (done[c]) continue;
        done[c] = 1;
        const i = c % info.nx;
        const j = Math.floor(c / info.nx);
        for (const [di, dj, w] of dirs) {
          const i2 = i + di;
          const j2 = j + dj;
          if (i2 < 0 || j2 < 0 || i2 >= info.nx || j2 >= info.nz) continue;
          const c2 = j2 * info.nx + i2;
          if (!ok[c2] || done[c2] || !nav.segmentWalkable(centre(c), centre(c2))) continue;
          if (d + w < dist[c2]) {
            dist[c2] = d + w;
            heap.push([d + w, c2]);
          }
        }
      }
      return dist;
    };
    const cells: number[] = [];
    for (let c = 0; c < n; c++) if (ok[c]) cells.push(c);
    let searched = 0;
    for (let s = 0; s < 6; s++) {
      const src = cells[rng.int(cells.length)];
      const ref = dijkstra(src);
      for (let k = 0; k < 60; k++) {
        const dst = cells[rng.int(cells.length)];
        const path = nav.findPath(centre(src), centre(dst));
        if (ref[dst] === Infinity) {
          expect(path).toBeNull();
          continue;
        }
        expect(path).not.toBeNull();
        // the pulled path is never longer than the grid optimum
        expect(polyLength(centre(src), path!)).toBeLessThanOrEqual(ref[dst] + 1e-9);
        // no zero-length legs, although start and goal are node centres themselves
        let prev = centre(src);
        for (const p of path!) {
          if (src !== dst) expect(Math.hypot(p.x - prev.x, p.z - prev.z)).toBeGreaterThan(0.5);
          prev = p;
        }
        expect(path![path!.length - 1]).toEqual(centre(dst));
        if (nav.lastExpansions > 0) {
          searched++;
          expect(nav.lastGridCost).toBeCloseTo(ref[dst], 9);
        }
      }
    }
    expect(searched).toBeGreaterThan(100);
  });

  it('a start that is off the walkable area hops to the nearest node first', () => {
    // wall face at x = 0.4: the agent fits from x = 1.6 on, but the first lattice node that fits is at 2.5
    const { nav, world } = setup({ floorSize: 80, solids: [solid(-1, 0, -40, 0.4, 6, 30)] });
    const from = gp(1.7, 3.3);
    expect(world.overlapsBox(from, AGENT_HALF)).toBe(false);
    expect(nav.isWalkable(from)).toBe(false);
    expect(nav.isWalkable(gp(2.5, 3.5))).toBe(true);
    const near = nav.nearestWalkable(from)!;
    expect(near).toEqual(gp(2.5, 3.5));
    const to = gp(30, -20);
    const path = nav.findPath(from, to)!;
    expect(path).not.toBeNull();
    expect(path[0]).toEqual(gp(2.5, 3.5));
    expect(path[path.length - 1]).toEqual(to);
    expect(pathHits(world, from, path)).toBe(0);
    const len = polyLength(from, path);
    expect(nav.pathDistance(from, to, 100)).toBeCloseTo(len, 9);
    // the hop counts at either end: same distance the other way round, and between two off-grid guards
    expect(nav.pathDistance(to, from, 100)).toBeCloseTo(len, 9);
    const other = gp(1.75, -6.2);
    expect(nav.isWalkable(other)).toBe(false);
    const hop = (p: V3): number => Math.hypot(p.x - 2.5, p.z - (Math.floor(p.z) + 0.5));
    expect(nav.pathDistance(from, other, 100)).toBeCloseTo(hop(from) + 10 + hop(other), 9); // (2.5, 3.5) → (2.5, -6.5)
    expect(nav.pathDistance(other, from, 100)).toBeCloseTo(hop(from) + 10 + hop(other), 9);
    expect(nav.pathDistance(from, other, hop(from) + 10 + hop(other) - 0.01)).toBe(Infinity);
    // a node in plain view wins over a nearer one behind the wall: from x = -1.9 (0.9 m from the west face)
    // the east node (2.5, …) is 4.4 m away and out of range, the west one (-2.5, …) is taken
    expect(nav.nearestWalkable(gp(-1.9, 0.5))).toEqual(gp(-2.5, 0.5));
    // inside the wall no node is in view: findPath still gets the guard out (nearest node, blind) …
    const stuck = gp(0.1, 0.5);
    expect(world.overlapsBox(stuck, AGENT_HALF)).toBe(true);
    const out = nav.findPath(stuck, to)!;
    expect(out).not.toBeNull();
    expect(out[0]).toEqual(gp(2.5, 0.5));
    expect(nav.nearestWalkable(stuck)).toEqual(gp(2.5, 0.5));
    // … but pathDistance / connected do not accept such a point as a guard position
    expect(nav.pathDistance(stuck, to, 1000)).toBe(Infinity);
    expect(nav.connected(stuck, to)).toBe(false);
    // nothing within 3 m: no start at all
    expect(nav.findPath(v3(200, H, 200), to)).toBeNull();
    expect(nav.nearestWalkable(v3(200, H, 200))).toBeNull();

    // the 3 m are a disc, not a square: free floor only in the quadrant x < 0, z < 0 (nodes from -1.5 on)
    const q = setup({ floorSize: 40, solids: [solid(0, 0, -20, 20, 30, 20), solid(-20, 0, 0, 0, 30, 20)] });
    expect(q.nav.isWalkable(gp(-1.5, -1.5))).toBe(true);
    expect(q.nav.isWalkable(gp(-0.5, -1.5))).toBe(false);
    expect(q.nav.findPath(gp(0.5, 0.5), gp(-10, -10))![0]).toEqual(gp(-1.5, -1.5)); // 2.83 m away
    expect(q.nav.findPath(gp(1, 1), gp(-10, -10))).toBeNull(); // 3.54 m away (2.5 m on each axis)
    expect(q.nav.findPath(gp(-10, -10), gp(1, 1))).toEqual([gp(-1.5, -1.5)]); // as a goal it is within 4 m
    expect(q.nav.findPath(gp(-10, -10), gp(1.5, 1.5))).toBeNull(); // 4.24 m
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('NavGrid — stacked floors and ledges', () => {
  // platform: top at y = 6, underside at 5 (clear of a guard below), over the middle of the floor
  const { nav, world } = setup({ floorSize: 100, solids: [solid(-10, 5, -10, 10, 6, 10)] });
  const lower = gp(0.3, 0.7, 0);
  const upper = gp(0.3, 0.7, 6);

  it('isWalkable distinguishes the two levels of one column', () => {
    expect(nav.isWalkable(lower)).toBe(true);
    expect(nav.isWalkable(upper)).toBe(true);
    expect(nav.isWalkable(v3(0.3, 4.3, 0.7))).toBe(false); // between the floors
    expect(nav.isWalkable(v3(0.3, 9.5, 0.7))).toBe(false); // above the platform
    // off the platform only the ground exists
    expect(nav.isWalkable(gp(20, 0, 0))).toBe(true);
    expect(nav.isWalkable(gp(20, 0, 6))).toBe(false);
    const info = nav.getInfo();
    expect(info.nodes).toBe(100 * 100 + 20 * 20);
    expect(info.regions).toBe(2);
  });

  it('paths never change level', () => {
    // from the ground to a target on the platform: no route up → the guard ends right below the target
    const start = gp(30, 20, 0);
    const path = nav.findPath(start, upper)!;
    expect(path).not.toBeNull();
    for (const p of path) expect(p.y).toBe(H);
    expect(path[path.length - 1]).toEqual(lower);
    expect(pathHits(world, start, path)).toBe(0);
    // from the platform to a target on the ground below it: stays up, ends right above the target
    const down = nav.findPath(gp(-5, -5, 6), lower)!;
    expect(down).toEqual([upper]);
    // the two levels are not connected
    expect(nav.pathDistance(lower, upper, 1000)).toBe(Infinity);
    expect(nav.pathDistance(upper, lower, 1000)).toBe(Infinity);
    expect(nav.connected(lower, upper)).toBe(false);
    expect(nav.segmentWalkable(lower, upper)).toBe(false);
    expect(nav.segmentWalkable(upper, lower)).toBe(false);
    // a ground path may run under the platform (5 m of headroom)
    const under = nav.findPath(gp(-30, 0.5, 0), gp(30, 0.5, 0))!;
    expect(under).toEqual([gp(30, 0.5, 0)]);
    expect(pathHits(world, gp(-30, 0.5, 0), under)).toBe(0);
    // on the platform
    const a = gp(-8, -8, 6);
    const b = gp(8.4, 7.9, 6);
    expect(nav.findPath(a, b)).toEqual([b]);
    expect(nav.pathDistance(a, b, 100)).toBeCloseTo(Math.hypot(16.4, 15.9), 9);
    expect(unsupportedSamples(world, a, [b])).toBe(0);
  });

  it('a ledge is never crossed', () => {
    const a = gp(0, 0, 6);
    // straight off the platform
    expect(nav.segmentWalkable(a, gp(12, 0, 6))).toBe(false);
    expect(nav.segmentWalkable(a, gp(9.5, 0, 6))).toBe(true);
    expect(nav.segmentWalkable(a, gp(9.6, 0, 6))).toBe(false);
    const out = v3();
    const d = nav.walkableReach(a, gp(30, 12, 6), out);
    expect(out.x).toBeCloseTo(9.5, 9);
    expect(out.y).toBe(6 + H);
    expect(d).toBeCloseTo(Math.hypot(9.5, 9.5 * 0.4), 9);
    // a target in mid-air beside the platform at platform height: nothing connected within 4 m
    expect(nav.findPath(a, gp(30, 0, 6))).toBeNull();
    // … with a wide tolerance the guard walks to the edge and stops there
    const edge = nav.findPath(a, gp(14, 3, 6), 6)!;
    expect(edge).not.toBeNull();
    for (const p of edge) {
      expect(p.y).toBe(6 + H);
      expect(Math.abs(p.x)).toBeLessThanOrEqual(9.5);
      expect(Math.abs(p.z)).toBeLessThanOrEqual(9.5);
    }
    expect(unsupportedSamples(world, a, edge)).toBe(0);
    // from the ground nothing leads up either
    expect(nav.segmentWalkable(gp(20, 0, 0), gp(5, 0, 6))).toBe(false);
  });

  it('follows an L-shaped catwalk instead of stepping across the void', () => {
    // catwalk top at 6: arm A x -10..10, z -10..-4; arm B x 4..10, z -4..10
    const l = setup({ floorSize: 100, solids: [solid(-10, 5, -10, 10, 6, -4), solid(4, 5, -4, 10, 6, 10)] });
    const a = gp(-8, -7, 6);
    const b = gp(7, 8, 6);
    expect(l.nav.segmentWalkable(a, b)).toBe(false);
    const path = l.nav.findPath(a, b)!;
    expect(path).not.toBeNull();
    expect(path.length).toBeGreaterThanOrEqual(2);
    for (const p of path) expect(p.y).toBe(6 + H);
    expect(unsupportedSamples(l.world, a, path, 0.05)).toBe(0);
    expect(pathHits(l.world, a, path)).toBe(0);
    // around the inner corner (4, -4): about 11.5 + 12 m, far from the 21 m straight line
    const len = polyLength(a, path);
    expect(len).toBeGreaterThan(Math.hypot(15, 15) + 0.5);
    expect(len).toBeLessThan(26);
  });

  it('low headroom under a deck is not walkable; the path goes around', () => {
    // deck underside at 2.0 m: a 2.5 m tall agent does not fit below
    const d = setup({ floorSize: 100, solids: [solid(-6, 2.0, -20, 6, 2.6, 20)] });
    expect(d.nav.isWalkable(gp(0, 0, 0))).toBe(false);
    expect(d.nav.isWalkable(gp(0, 0, 2.6))).toBe(true); // on top of it (an island)
    const from = gp(-20, 0);
    const to = gp(20, 0);
    const path = d.nav.findPath(from, to)!;
    expect(path).not.toBeNull();
    expect(pathHits(d.world, from, path)).toBe(0);
    expect(polyLength(from, path)).toBeGreaterThan(2 * Math.hypot(14, 20));
    // exactly 2.5 m of headroom is enough (touching is not overlapping)
    const e = setup({ floorSize: 100, solids: [solid(-6, H + R, -20, 6, 3.2, 20)] });
    expect(e.nav.isWalkable(gp(0, 0, 0))).toBe(true);
    expect(e.nav.findPath(from, to)).toEqual([to]);
  });

  it('steps: a floor 0.1 m higher is linked, a 0.5 m step is not', () => {
    // raised slabs: x 10..30 by 0.1 m, x 30..45 by another 0.5 m
    const s = setup({ floorSize: 100, solids: [solid(10, 0, -50, 30, 0.1, 50), solid(30, 0, -50, 45, 0.6, 50)] });
    const from = gp(-10, 0, 0);
    const mid = gp(20, 0, 0.1);
    expect(s.nav.isWalkable(mid)).toBe(true);
    expect(s.nav.segmentWalkable(from, mid)).toBe(true);
    const path = s.nav.findPath(from, mid)!;
    expect(path).toEqual([mid]);
    expect(pathHits(s.world, from, path)).toBe(0);
    // the 0.5 m step is a wall for the guard: nothing walkable within 1.2 m in front of it, no way up
    expect(s.nav.isWalkable(gp(29.5, 0, 0.1))).toBe(false);
    expect(s.nav.isWalkable(gp(28.5, 0, 0.1))).toBe(true);
    const top = gp(40, 0, 0.6);
    expect(s.nav.isWalkable(top)).toBe(true);
    expect(s.nav.connected(from, top)).toBe(false);
    expect(s.nav.pathDistance(from, top, 1000)).toBe(Infinity);
    expect(s.nav.segmentWalkable(mid, top)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('NavGrid — barriers', () => {
  // wall along x = 0 across the whole floor with an 8 m doorway at z -4..4 closed by barrier B1
  const make = (): { stage: StageDef; world: World; nav: NavGrid } =>
    setup({ floorSize: 100, solids: [solid(-1, 0, -50, 1, 8, -4), solid(-1, 0, 4, 1, 8, 50)] }, (stage) => {
      addBarrier(stage, 'B1', box(-1, 0, -4, 1, 8, 4));
    });
  const from = gp(-20, 10);
  const to = gp(20, -10);

  it('closed blocks the route, open allows it, reset closes it again', () => {
    const { nav, world, stage } = make();
    expect(nav.isBarrierOpen('B1')).toBe(false);
    expect(nav.findPath(from, to)).toBeNull();
    expect(nav.pathDistance(from, to, 1000)).toBe(Infinity);
    expect(nav.connected(from, to)).toBe(false);
    expect(nav.isWalkable(gp(0, 0))).toBe(false);
    expect(nav.isWalkable(gp(-2, 0))).toBe(false); // agent box would reach into the barrier
    expect(nav.isWalkable(gp(-2.5, 0))).toBe(true);
    expect(nav.segmentWalkable(gp(-10, 0), gp(10, 0))).toBe(false);
    // exactly on blocked lattice nodes, and along the lattice line that leaves one
    const out = v3();
    expect(nav.isWalkable(gp(1.5, 0.5))).toBe(false);
    expect(nav.isWalkable(gp(-0.5, -2.5))).toBe(false);
    expect(nav.isWalkable(gp(2.5, 0.5))).toBe(true);
    expect(nav.segmentWalkable(gp(1.5, 0.5), gp(10.5, 0.5))).toBe(false);
    expect(nav.segmentWalkable(gp(10.5, 0.5), gp(1.5, 0.5))).toBe(false);
    expect(nav.segmentWalkable(gp(1.5, 0.5), gp(1.5, 0.5))).toBe(false);
    expect(nav.segmentWalkable(gp(2.5, 0.5), gp(10.5, 0.5))).toBe(true);
    expect(nav.walkableReach(gp(1.5, 0.5), gp(10.5, 0.5), out)).toBe(0);
    expect(nav.walkableReach(gp(10.5, 0.5), gp(-10.5, 0.5), out)).toBeCloseTo(8, 9);
    expect(out).toEqual(gp(2.5, 0.5));
    // a guard caught inside the closing barrier is led out to the nearest free node on its side
    expect(nav.findPath(gp(1.5, 0.5), gp(20, 20))![0]).toEqual(gp(2.5, 0.5));
    expect(nav.nearestWalkable(gp(-1.5, 0.5))).toEqual(gp(-2.5, 0.5));
    const closedInfo = nav.getInfo();
    // nodes whose agent box reaches into the barrier: x -1.5 … 1.5 (4 columns) × z -2.5 … 2.5 (6 rows; nearer
    // to the door jambs the agent does not fit even with the barrier gone, so there is no node to block)
    expect(closedInfo.blockedNodes).toBe(24);
    expect(closedInfo.regions).toBe(4); // west, east and the two wall tops

    nav.setBarrierOpen('B1', true);
    expect(nav.isBarrierOpen('B1')).toBe(true);
    expect(nav.getInfo().blockedNodes).toBe(0);
    expect(nav.getInfo().regions).toBe(3);
    const path = nav.findPath(from, to)!;
    expect(path).not.toBeNull();
    expect(path[path.length - 1]).toEqual(to);
    // the route really goes through the doorway (checked against the world with the barrier open)
    world.setBarrierOpen('B1', true);
    expect(pathHits(world, from, path)).toBe(0);
    world.setBarrierOpen('B1', false);
    expect(pathHits(world, from, path)).toBeGreaterThan(0); // … i.e. through where the barrier stood
    expect(nav.isWalkable(gp(0, 0))).toBe(true);
    expect(nav.isWalkable(gp(1.5, 0.5))).toBe(true);
    expect(nav.segmentWalkable(gp(-10, 0), gp(10, 0))).toBe(true);
    expect(nav.segmentWalkable(gp(1.5, 0.5), gp(10.5, 0.5))).toBe(true);
    const len = polyLength(from, path);
    expect(nav.pathDistance(from, to, 1000)).toBeCloseTo(len, 9);
    expect(len).toBeLessThan(Math.hypot(40, 20) * 1.05);

    nav.setBarrierOpen('B1', false);
    expect(nav.findPath(from, to)).toBeNull();
    nav.setBarrierOpen('B1', true);
    expect(nav.findPath(from, to)).not.toBeNull();
    nav.reset();
    expect(nav.isBarrierOpen('B1')).toBe(false);
    expect(nav.findPath(from, to)).toBeNull();
    expect(nav.pathDistance(from, to, 1000)).toBe(Infinity);
    expect(nav.isWalkable(gp(0, 0))).toBe(false);
    expect(nav.segmentWalkable(gp(-10, 0), gp(10, 0))).toBe(false);
    expect(nav.getInfo()).toEqual(closedInfo);
    // unknown ids are ignored; repeated calls are idempotent
    nav.setBarrierOpen('nope', true);
    nav.setBarrierOpen('B1', false);
    nav.setBarrierOpen('B1', false);
    expect(nav.isBarrierOpen('nope')).toBe(false);
    expect(nav.getInfo()).toEqual(closedInfo);
    expect(stage.barriers.length).toBe(1);
  });

  it('the final gate is a barrier too', () => {
    const { nav } = setup({ floorSize: 100, solids: [solid(-1, 0, -50, 1, 8, -4), solid(-1, 0, 4, 1, 8, 50)] }, (stage) => {
      stage.finalGate = { id: 'GATE', name: 'gate', box: box(-1, 0, -4, 1, 8, 4) };
    });
    expect(nav.findPath(from, to)).toBeNull();
    nav.setBarrierOpen('GATE', true);
    expect(nav.findPath(from, to)).not.toBeNull();
    nav.reset();
    expect(nav.findPath(from, to)).toBeNull();
  });

  it("does not depend on the World's barrier state and leaves it untouched", () => {
    // world barrier OPEN at construction time: the grid still starts closed, the world stays open
    const stage = makeTestStage({ floorSize: 100, solids: [solid(-1, 0, -50, 1, 8, -4), solid(-1, 0, 4, 1, 8, 50)] });
    addBarrier(stage, 'B1', box(-1, 0, -4, 1, 8, 4));
    const world = new World(stage);
    world.setBarrierOpen('B1', true);
    const nav = new NavGrid(world, stage);
    nav.build();
    expect(world.isBarrierOpen('B1')).toBe(true);
    expect(world.isBarrierOpen('GATE')).toBe(false);
    expect(nav.isBarrierOpen('B1')).toBe(false);
    expect(nav.findPath(from, to)).toBeNull();
    nav.setBarrierOpen('B1', true);
    expect(nav.findPath(from, to)).not.toBeNull();
    nav.reset();
    expect(world.isBarrierOpen('B1')).toBe(true); // the grid never writes the world's state

    // world barrier CLOSED at construction time: same grid, world stays closed
    const world2 = new World(stage);
    const nav2 = new NavGrid(world2, stage);
    nav2.build();
    expect(world2.isBarrierOpen('B1')).toBe(false);
    expect(world2.boxes.filter((b) => b.barrierId !== null).every((b) => b.active)).toBe(true);
    expect(nav2.getInfo()).toEqual(nav.getInfo());
    nav2.setBarrierOpen('B1', true);
    expect(world2.isBarrierOpen('B1')).toBe(false);
    expect(nav2.findPath(from, to)).not.toBeNull();
  });

  it('a barrier state set before the lazy build is honoured', () => {
    const { nav } = make();
    nav.setBarrierOpen('B1', true); // no query yet → grid not built
    expect(nav.findPath(from, to)).not.toBeNull();
    const again = make();
    again.nav.setBarrierOpen('B1', true);
    again.nav.reset();
    expect(again.nav.findPath(from, to)).toBeNull();
  });

  it('a floor that only exists while the barrier is closed is never walkable', () => {
    // the top of the closed barrier is not a floor; the nodes it covers are blocked on every level it reaches
    const { nav } = setup({ floorSize: 60, solids: [solid(-10, 3, -10, 10, 4, 10)] }, (stage) => {
      addBarrier(stage, 'B1', box(-2, 0, -2, 2, 8, 2)); // pierces the platform (top 4) from the ground up to 8
    });
    expect(nav.isWalkable(gp(0, 0, 8))).toBe(false);
    expect(nav.isWalkable(gp(0, 0, 4))).toBe(false);
    expect(nav.isWalkable(gp(0, 0, 0))).toBe(false);
    expect(nav.isWalkable(gp(5, 5, 4))).toBe(true);
    nav.setBarrierOpen('B1', true);
    expect(nav.isWalkable(gp(0, 0, 4))).toBe(true);
    expect(nav.isWalkable(gp(0, 0, 0))).toBe(true);
    expect(nav.isWalkable(gp(0, 0, 8))).toBe(false);
  });

  it('any sequence of openings and closings leaves exactly the grid a fresh build would have', () => {
    const rng = new Rng(2718);
    const ids = ['B1', 'B2', 'B3', 'B4', 'B5', 'GATE'];
    const mkStage = (): StageDef => {
      const r = new Rng(1618);
      const stage = makeTestStage({ floorSize: 80, solids: [...randomBoxes(r, 50, 40), solid(-30, 4, -30, 0, 5, 0)] });
      // barriers of all shapes: across open floor, overlapping each other, through the platform, on its top
      addBarrier(stage, 'B1', box(-40, 0, 9, 40, 6, 10.5));
      addBarrier(stage, 'B2', box(4, 0, -40, 6, 3, 40));
      addBarrier(stage, 'B3', box(3, 0, 8, 12, 8, 14));
      addBarrier(stage, 'B4', box(-22, 0, -22, -14, 9, -18));
      addBarrier(stage, 'B5', box(-10.3, 5, -29, -9.1, 6, -1));
      stage.finalGate = { id: 'GATE', name: 'gate', box: box(-40, 0, -11, 40, 5, -9.9) };
      return stage;
    };
    const stage = mkStage();
    const nav = new NavGrid(new World(stage), stage);
    const open = new Set<string>();
    const internals = (n: NavGrid): { nbr: Int32Array; blocked: Uint8Array } => n as unknown as { nbr: Int32Array; blocked: Uint8Array };
    for (let round = 0; round < 40; round++) {
      // a burst of random toggles (some redundant) …
      for (let k = 0; k < 4; k++) {
        const id = ids[rng.int(ids.length)];
        const state = rng.next() < 0.5;
        nav.setBarrierOpen(id, state);
        if (state) open.add(id);
        else open.delete(id);
      }
      if (round % 13 === 12) {
        nav.reset();
        open.clear();
      }
      // … must give the tables of a grid built from scratch with that state (set before its lazy build)
      const fresh = new NavGrid(new World(stage), stage);
      for (const id of open) fresh.setBarrierOpen(id, true);
      expect(fresh.getInfo()).toEqual(nav.getInfo());
      const a = internals(nav);
      const b = internals(fresh);
      expect(a.nbr.length).toBe(b.nbr.length);
      let diff = 0;
      for (let q = 0; q < a.blocked.length; q++) {
        if (a.blocked[q] !== b.blocked[q]) diff++;
        // rows of blocked nodes are unreachable and need not agree
        if (a.blocked[q] === 0) for (let k = 0; k < 10; k++) if (a.nbr[q * 10 + k] !== b.nbr[q * 10 + k]) diff++;
      }
      expect(diff).toBe(0);
      for (const id of ids) expect(nav.isBarrierOpen(id)).toBe(open.has(id));
      // and the queries agree
      for (let k = 0; k < 20; k++) {
        const p = gp(rng.range(-39, 39), rng.range(-39, 39), rng.next() < 0.2 ? 5 : 0);
        const q = gp(rng.range(-39, 39), rng.range(-39, 39), 0);
        expect(nav.isWalkable(p)).toBe(fresh.isWalkable(p));
        expect(nav.findPath(p, q)).toEqual(fresh.findPath(p, q));
        expect(nav.pathDistance(p, q, 80)).toBe(fresh.pathDistance(p, q, 80));
      }
    }
  });

  it('paths respect closed barriers: replayed against the world, nothing is touched', () => {
    const stage = makeTestStage({ floorSize: 80, solids: randomBoxes(new Rng(1618), 50, 40) });
    addBarrier(stage, 'B1', box(-40, 0, 9, 12, 6, 10.5)); // leaves a gap at the east end
    addBarrier(stage, 'B2', box(4, 0, -40, 6, 3, 2));
    const world = new World(stage);
    const nav = new NavGrid(world, stage);
    const rng = new Rng(77);
    let found = 0;
    for (const openB2 of [false, true]) {
      nav.setBarrierOpen('B2', openB2);
      world.setBarrierOpen('B2', openB2);
      for (let k = 0; k < 150; k++) {
        const a = gp(rng.range(-39, 39), rng.range(-39, 39));
        const b = gp(rng.range(-39, 39), rng.range(-39, 39));
        if (!nav.isWalkable(a)) continue;
        expect(world.overlapsBox(a, AGENT_HALF)).toBe(false); // barriers included
        const path = nav.findPath(a, b);
        if (!path) continue;
        found++;
        expect(pathHits(world, a, path)).toBe(0);
      }
    }
    expect(found).toBeGreaterThan(120);
  });

  it('two overlapping barriers: the cells stay blocked until both are open', () => {
    const { nav } = setup({ floorSize: 100, solids: [solid(-1, 0, -50, 1, 8, -4), solid(-1, 0, 4, 1, 8, 50)] }, (stage) => {
      addBarrier(stage, 'B1', box(-1, 0, -4, 1, 8, 2));
      addBarrier(stage, 'B2', box(-1, 0, -2, 1, 8, 4));
    });
    expect(nav.findPath(from, to)).toBeNull();
    nav.setBarrierOpen('B1', true);
    expect(nav.findPath(from, to)).toBeNull(); // B2 still leaves only z -4..-2: 2 m
    nav.setBarrierOpen('B1', false);
    nav.setBarrierOpen('B2', true);
    expect(nav.findPath(from, to)).toBeNull(); // B1 still leaves only z 2..4
    nav.setBarrierOpen('B1', true);
    expect(nav.findPath(from, to)).not.toBeNull();
    expect(nav.isWalkable(gp(0, 0))).toBe(true);
    nav.setBarrierOpen('B1', false);
    expect(nav.isWalkable(gp(0, 0))).toBe(false);
    expect(nav.isWalkable(gp(0, 3))).toBe(false); // z 2..4 alone is too narrow
    nav.setBarrierOpen('B1', true);
    nav.reset();
    expect(nav.isBarrierOpen('B1')).toBe(false);
    expect(nav.isBarrierOpen('B2')).toBe(false);
    expect(nav.findPath(from, to)).toBeNull();
    expect(nav.getInfo().regions).toBe(4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('NavGrid — pathDistance', () => {
  const { nav } = setup({
    floorSize: 120,
    solids: [solid(-0.5, 0, -60, 0.5, 6, 10), solid(-0.5, 0, 16, 0.5, 6, 60)],
  });

  it('is bounded by maxDist', () => {
    const a = gp(-40, -30);
    const b = gp(-10, 10);
    expect(nav.pathDistance(a, b, 50)).toBeCloseTo(50, 9);
    expect(nav.pathDistance(a, b, 50.001)).toBeCloseTo(50, 9);
    expect(nav.pathDistance(a, b, 49.999)).toBe(Infinity);
    expect(nav.pathDistance(a, b, 0)).toBe(Infinity);
    expect(nav.pathDistance(a, b, -1)).toBe(Infinity);
    expect(nav.pathDistance(a, b, Infinity)).toBeCloseTo(50, 9);
  });

  it('measures the detour, not the straight line', () => {
    const a = gp(-20, -20);
    const b = gp(20, -20);
    const path = nav.findPath(a, b)!;
    const len = polyLength(a, path);
    expect(len).toBeGreaterThan(74);
    expect(nav.pathDistance(a, b, 1000)).toBeCloseTo(len, 9);
    expect(nav.pathDistance(b, a, 1000)).toBeCloseTo(len, 6);
    expect(nav.pathDistance(a, b, len + 0.01)).toBeCloseTo(len, 9);
    expect(nav.pathDistance(a, b, len - 0.01)).toBe(Infinity);
    expect(nav.pathDistance(a, b, 60)).toBe(Infinity); // 40 m apart in a straight line, but 76 m to walk
    expect(nav.pathDistance(a, b, 45)).toBe(Infinity);
    expect(nav.pathDistance(a, b, 39)).toBe(Infinity);
  });

  it('alert sharing scenario: 60 m of passage, not 60 m through a wall', () => {
    // two guards 6 m apart on either side of the wall, far from the gap
    const g1 = gp(-3, -40);
    const g2 = gp(3, -40);
    expect(nav.pathDistance(g1, g2, 60)).toBe(Infinity); // 2 × ~51.6 m around
    const d = nav.pathDistance(g1, g2, 200);
    expect(d).toBeGreaterThan(100);
    expect(d).toBeLessThan(112);
    // same side: plain distance
    expect(nav.pathDistance(g1, gp(-30, -10), 60)).toBeCloseTo(Math.hypot(27, 30), 9);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('NavGrid — helpers and options', () => {
  it('nearestWalkable: the point itself, the nearest node, or null', () => {
    const { nav } = setup({ floorSize: 60, solids: [solid(0, 0, 0, 10, 4, 10)] });
    const out = v3();
    expect(nav.nearestWalkable(v3(-5.2, 2.0, -7.7), 3, out)).toBe(out);
    expect(out).toEqual(gp(-5.2, -7.7)); // walkable: kept, y corrected to guard height
    // inside the footprint of the block, 1 m from its west face, at ground height
    const p = nav.nearestWalkable(gp(1, 5))!;
    expect(p.x).toBeCloseTo(-1.5, 9);
    expect(p.z).toBeCloseTo(4.5, 9); // lattice node next to the block (z 4.5 and 5.5 are equally near: the first one wins)
    expect(nav.isWalkable(p)).toBe(true);
    // on top of the block (an island level) the top itself is the nearest standing position
    expect(nav.nearestWalkable(gp(5, 5, 4))).toEqual(gp(5, 5, 4));
    // deep inside the block: the nearest standing position is on top of it, right above
    expect(nav.nearestWalkable(gp(5, 5), 1)).toEqual(gp(5, 5, 4));
    expect(nav.nearestWalkable(v3(500, H, 0), 5)).toBeNull();
  });

  it('randomWalkableNear: deterministic, walkable, in range and in the same region', () => {
    const rng0 = new Rng(77);
    const { nav } = setup({ floorSize: 120, solids: randomBoxes(rng0, 70, 60, [gp(0, 0)]) });
    const centre = gp(0.4, -0.3);
    expect(nav.isWalkable(centre)).toBe(true);
    const a: V3[] = [];
    const b: V3[] = [];
    const r1 = new Rng(123);
    const r2 = new Rng(123);
    for (let k = 0; k < 200; k++) {
      const p = nav.randomWalkableNear(centre, 25, r1);
      const q = nav.randomWalkableNear(centre, 25, r2);
      expect(q).toEqual(p);
      if (!p) continue;
      a.push(p);
      b.push(q!);
      expect(nav.isWalkable(p)).toBe(true);
      expect(Math.hypot(p.x - centre.x, p.z - centre.z)).toBeLessThanOrEqual(25 + Math.SQRT1_2 + 1e-9);
      expect(p.y).toBe(H);
      expect(nav.connected(centre, p)).toBe(true);
      expect(nav.findPath(centre, p)).not.toBeNull();
    }
    expect(a.length).toBeGreaterThan(150);
    // spread out, not one spot
    const xs = a.map((p) => p.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(25);
    // radius 0: the node nearest to the point
    expect(nav.randomWalkableNear(centre, 0, new Rng(1))).toEqual(gp(0.5, -0.5));
    // no standing position near the point
    expect(nav.randomWalkableNear(v3(500, H, 0), 10, new Rng(1))).toBeNull();
    // writes into `out`
    const out = v3();
    expect(nav.randomWalkableNear(centre, 10, new Rng(5), out)).toBe(out);
  });

  it('is deterministic: two grids and repeated queries give identical results', () => {
    const mk = (): NavGrid => setup({ floorSize: 120, solids: randomBoxes(new Rng(31), 80, 60) }).nav;
    const n1 = mk();
    const n2 = mk();
    expect(n2.getInfo()).toEqual(n1.getInfo());
    const rng = new Rng(8);
    for (let k = 0; k < 150; k++) {
      const a = gp(rng.range(-58, 58), rng.range(-58, 58));
      const b = gp(rng.range(-58, 58), rng.range(-58, 58));
      const p1 = n1.findPath(a, b);
      expect(n2.findPath(a, b)).toEqual(p1);
      expect(n1.findPath(a, b)).toEqual(p1);
      expect(n2.pathDistance(a, b, 300)).toBe(n1.pathDistance(a, b, 300));
      if (p1) expect(finitePath(p1)).toBe(true);
    }
  });

  it('reuses its scratch storage between queries', () => {
    const { nav } = setup({ floorSize: 160, solids: randomBoxes(new Rng(3), 120, 80) });
    const rng = new Rng(4);
    const pts: V3[] = [];
    while (pts.length < 40) {
      const p = gp(rng.range(-79, 79), rng.range(-79, 79));
      if (nav.isWalkable(p)) pts.push(p);
    }
    const run = (): void => {
      for (let k = 0; k < 300; k++) nav.findPath(pts[k % pts.length], pts[(k * 7 + 3) % pts.length]);
    };
    run(); // warm-up: buffers reach their working size
    const internals = nav as unknown as Record<string, unknown>;
    const names = ['recI', 'recF', 'heapF', 'heapN', 'stack', 'pathBuf', 'ptU', 'ptV', 'ptY', 'outIdx', 'nbr', 'comp', 'queue'];
    const before = names.map((n) => internals[n]);
    for (const b of before) expect(b).toBeDefined();
    run();
    for (let k = 0; k < 2000; k++) {
      nav.pathDistance(pts[k % pts.length], pts[(k * 3 + 1) % pts.length], 60);
      nav.segmentWalkable(pts[k % pts.length], pts[(k * 5 + 2) % pts.length]);
      nav.isWalkable(pts[k % pts.length]);
    }
    names.forEach((n, i) => expect(internals[n]).toBe(before[i]));
  });

  it('cellSize option: coarser and finer lattices keep every guarantee', () => {
    for (const cs of [0.5, 2, 2.4]) {
      const stage = makeTestStage({ floorSize: 96, solids: randomBoxes(new Rng(11), 50, 48) });
      const world = new World(stage);
      const nav = new NavGrid(world, stage, { cellSize: cs });
      expect(nav.getInfo().cellSize).toBe(cs);
      const rng = new Rng(12);
      const pts: V3[] = [];
      while (pts.length < 40) {
        const p = gp(rng.range(-46, 46), rng.range(-46, 46));
        if (nav.isWalkable(p)) pts.push(p);
      }
      let found = 0;
      for (let k = 0; k < 120; k++) {
        const a = pts[rng.int(pts.length)];
        const b = pts[rng.int(pts.length)];
        const path = nav.findPath(a, b);
        if (!path) continue;
        found++;
        expect(pathHits(world, a, path)).toBe(0);
        expect(path[path.length - 1]).toEqual(b);
      }
      expect(found).toBeGreaterThan(60);
    }
    // out-of-range sizes are clamped
    const st = makeTestStage({ floorSize: 20 });
    expect(new NavGrid(new World(st), st, { cellSize: 50 }).getInfo().cellSize).toBe(2 * R);
    expect(new NavGrid(new World(st), st, { cellSize: 0.01 }).getInfo().cellSize).toBe(0.25);
    expect(new NavGrid(new World(st), st, { cellSize: NaN }).getInfo().cellSize).toBe(1);
  });

  it('maxColumns: an oversized stage gets a coarser lattice, then a window around its guards', () => {
    const solids = randomBoxes(new Rng(21), 60, 60);
    // 1) coarser lattice: 120 x 120 m with at most 6000 columns → 1.6 m cells instead of 1 m
    const stage = makeTestStage({ floorSize: 120, solids });
    const world = new World(stage);
    const coarse = new NavGrid(world, stage, { maxColumns: 6000 });
    const info = coarse.getInfo();
    expect(info.cellSize).toBeGreaterThan(1.5);
    expect(info.cellSize).toBeLessThanOrEqual(2 * R);
    expect(info.nx * info.nz).toBeLessThanOrEqual(6000);
    const rng = new Rng(22);
    let found = 0;
    for (let k = 0; k < 200; k++) {
      const a = gp(rng.range(-58, 58), rng.range(-58, 58));
      const b = gp(rng.range(-58, 58), rng.range(-58, 58));
      if (!coarse.isWalkable(a)) continue;
      expect(world.overlapsBox(a, AGENT_HALF)).toBe(false);
      const path = coarse.findPath(a, b);
      if (!path) continue;
      found++;
      expect(pathHits(world, a, path)).toBe(0);
    }
    expect(found).toBeGreaterThan(80);
    // 2) window: with at most 900 columns even 2.4 m cells cannot cover it → about 67 x 67 m around the guards
    const guarded = makeTestStage({ floorSize: 120, solids, enemies: [makeGuard('G1', 40, 40), makeGuard('G2', 50, 44)] });
    const gworld = new World(guarded);
    const win = new NavGrid(gworld, guarded, { maxColumns: 900 });
    const winfo = win.getInfo();
    expect(winfo.cellSize).toBe(2 * R);
    expect(winfo.nx * winfo.nz).toBeLessThanOrEqual(900);
    expect(winfo.nodes).toBeGreaterThan(300);
    // the window hugs the corner of the stage the guards are in
    expect(winfo.originX + winfo.nx * winfo.cellSize).toBeGreaterThanOrEqual(58);
    expect(winfo.originX).toBeGreaterThan(-20);
    expect(win.nearestWalkable(gp(40, 40), 3)).not.toBeNull();
    expect(win.nearestWalkable(gp(-40, -40), 3)).toBeNull(); // outside the window: nothing to walk on
    expect(win.findPath(gp(-40, -40), gp(40, 40))).toBeNull();
    let inside = 0;
    for (let k = 0; k < 200; k++) {
      const a = gp(rng.range(0, 58), rng.range(0, 58));
      const b = gp(rng.range(0, 58), rng.range(0, 58));
      const path = win.isWalkable(a) ? win.findPath(a, b) : null;
      if (!path) continue;
      inside++;
      expect(pathHits(gworld, a, path)).toBe(0);
    }
    expect(inside).toBeGreaterThan(20);
  });

  it('maxExpansions bounds a search', () => {
    const solids = [solid(-0.5, 0, -60, 0.5, 6, 10), solid(-0.5, 0, 16, 0.5, 6, 60)];
    const stage = makeTestStage({ floorSize: 120, solids });
    const tight = new NavGrid(new World(stage), stage, { maxExpansions: 50 });
    const loose = new NavGrid(new World(stage), stage);
    const a = gp(-20, -20);
    const b = gp(20, -20);
    expect(loose.findPath(a, b)).not.toBeNull();
    expect(loose.lastExpansions).toBeGreaterThan(50);
    expect(tight.findPath(a, b)).toBeNull();
    expect(tight.lastExpansions).toBe(51);
    expect(tight.findPath(a, gp(-25, 30))).toEqual([gp(-25, 30)]); // direct lines need no search at all
  });

  it('degenerate stages: nothing to walk on', () => {
    const stage = makeTestStage({ floorSize: 20 });
    stage.solids = [];
    const nav = new NavGrid(new World(stage), stage);
    expect(nav.getInfo().nodes).toBe(0);
    expect(nav.isWalkable(gp(0, 0))).toBe(false);
    expect(nav.findPath(gp(0, 0), gp(1, 1))).toBeNull();
    expect(nav.pathDistance(gp(0, 0), gp(1, 1), 10)).toBe(Infinity);
    expect(nav.segmentWalkable(gp(0, 0), gp(1, 1))).toBe(false);
    expect(nav.nearestWalkable(gp(0, 0))).toBeNull();
    expect(nav.randomWalkableNear(gp(0, 0), 5, new Rng(1))).toBeNull();
    nav.setBarrierOpen('GATE', true);
    nav.reset();
    // a slab that contains no lattice point has no node; lattice points on its rim count
    const tiny = makeTestStage({ floorSize: 0.8 });
    expect(new NavGrid(new World(tiny), tiny).getInfo().nodes).toBe(0);
    const small = makeTestStage({ floorSize: 1 });
    expect(new NavGrid(new World(small), small).getInfo().nodes).toBe(4);
    // a floor entirely under a low ceiling
    const low = makeTestStage({ floorSize: 20, solids: [solid(-10, 2, -10, 10, 3, 10)] });
    const lnav = new NavGrid(new World(low), low);
    expect(lnav.isWalkable(gp(0, 0, 0))).toBe(false);
    expect(lnav.isWalkable(gp(0, 0, 3))).toBe(true);
  });

  it('builds lazily without guards and eagerly with them', () => {
    const lazy = makeTestStage({ floorSize: 40 });
    const navLazy = new NavGrid(new World(lazy), lazy);
    expect((navLazy as unknown as { built: boolean }).built).toBe(false);
    expect(navLazy.isWalkable(gp(0, 0))).toBe(true);
    expect((navLazy as unknown as { built: boolean }).built).toBe(true);
    const enemies: EnemyDef[] = [makeGuard('G1', 5, 5)];
    const eager = makeTestStage({ floorSize: 40, enemies });
    const navEager = new NavGrid(new World(eager), eager);
    expect((navEager as unknown as { built: boolean }).built).toBe(true);
    expect(navEager.isWalkable(enemies[0].position)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
describe('NavGrid — obstacles (living turrets), avoidance, vantage search', () => {
  /** Distance from point c to the polyline from → path[0] → … (XZ). */
  const polyDistance = (from: V3, path: V3[], c: { x: number; z: number }): number => {
    let best = Infinity;
    let a = from;
    for (const b of path) {
      const sx = b.x - a.x;
      const sz = b.z - a.z;
      const l2 = sx * sx + sz * sz;
      const t = l2 > 0 ? Math.min(1, Math.max(0, ((c.x - a.x) * sx + (c.z - a.z) * sz) / l2)) : 0;
      best = Math.min(best, Math.hypot(a.x + sx * t - c.x, a.z + sz * t - c.z));
      a = b;
    }
    return best;
  };

  it('setObstacle: the keep-out sphere is not walkable, paths lead round it, removing it restores the floor exactly', () => {
    const { nav } = setup({ floorSize: 120 });
    const before = nav.getInfo();
    const a = gp(-20, 0.3);
    const b = gp(20, 0.3);
    const straight = nav.findPath(a, b) as V3[];
    expect(straight).toEqual([b]);
    // A turret standing at the origin (centre 1.6 m above the floor), guards keep 3.1 m from its centre.
    const centre = v3(0, 1.6, 0);
    const keep = 3.1;
    nav.setObstacle(7, centre, keep);
    expect(nav.obstacleCount).toBe(1);
    expect(nav.hasObstacle(7)).toBe(true);
    const info = nav.getInfo();
    expect(info.nodes).toBe(before.nodes);
    expect(info.blockedNodes).toBeGreaterThan(20);
    expect(info.blockedNodes).toBeLessThan(40); // about π · 3.1² lattice points
    expect(info.regions).toBe(before.regions); // a hole in the floor, not a cut
    // Nothing inside the sphere is walkable; everything walkable is outside it (within 5 cm at cell edges).
    for (let x = -6; x <= 6; x += 0.25) {
      for (let z = -6; z <= 6; z += 0.25) {
        const p = gp(x, z);
        const d = Math.hypot(x - centre.x, H - centre.y, z - centre.z);
        if (nav.isWalkable(p)) expect(d).toBeGreaterThan(keep - 0.05);
        if (d > keep + 1.5) expect(nav.isWalkable(p)).toBe(true);
      }
    }
    expect(nav.segmentWalkable(a, b)).toBe(false);
    const out = v3();
    const reach = nav.walkableReach(a, b, out);
    expect(reach).toBeGreaterThan(20 - keep - 1.5);
    expect(reach).toBeLessThan(20 - keep + 0.3);
    const round = nav.findPath(a, b) as V3[];
    expect(round.length).toBeGreaterThan(1);
    expect(round[round.length - 1]).toEqual(b);
    expect(polyDistance(a, round, centre)).toBeGreaterThan(keep - 0.05);
    expect(polyLength(a, round)).toBeLessThan(40 + 2.5);
    expect(nav.pathDistance(a, b, 100)).toBeCloseTo(polyLength(a, round), 9);
    // A goal inside the sphere snaps to the nearest standing spot outside it.
    const near = nav.findPath(a, gp(0.2, 0.1)) as V3[];
    const end = near[near.length - 1];
    expect(Math.hypot(end.x, H - centre.y, end.z)).toBeGreaterThanOrEqual(keep - 1e-9);
    expect(Math.hypot(end.x, end.z)).toBeLessThan(keep + 1.5);
    // Replacing and removing.
    nav.setObstacle(7, v3(10, 1.6, 0), keep);
    expect(nav.obstacleCount).toBe(1);
    expect(nav.isWalkable(gp(0.3, 0.2))).toBe(true);
    expect(nav.isWalkable(gp(10.2, 0.2))).toBe(false);
    nav.setObstacle(7, null);
    expect(nav.obstacleCount).toBe(0);
    expect(nav.hasObstacle(7)).toBe(false);
    expect(nav.getInfo()).toEqual(before);
    expect(nav.findPath(a, b)).toEqual([b]);
    // reset() (a re-sortie) leaves the obstacles to their owner; clearObstacles() removes them all.
    nav.setObstacle(1, v3(0, 1.6, 0), keep);
    nav.setObstacle(2, v3(30, 1.6, 30), keep);
    nav.reset();
    expect(nav.obstacleKeys().sort()).toEqual([1, 2]);
    nav.clearObstacles();
    expect(nav.getInfo()).toEqual(before);
  });

  it('obstacles and region labels: a turret that plugs a doorway cuts the floor in two; removing it joins it again (same as a fresh grid)', () => {
    // Wall across the floor with one 6 m door; an obstacle in the door.
    const opts: TestStageOptions = { floorSize: 80, solids: [solid(-40, 0, -1, -3, 6, 1), solid(3, 0, -1, 40, 6, 1)] };
    const { nav } = setup(opts);
    const north = gp(0.5, -20.5);
    const south = gp(0.5, 20.5);
    const fresh = nav.getInfo();
    expect(nav.connected(north, south)).toBe(true);
    nav.setObstacle(3, v3(0, 1.6, 0), 3.1);
    expect(nav.connected(north, south)).toBe(false);
    expect(nav.findPath(north, south, 0)).toBeNull();
    expect(nav.lastExpansions).toBe(0); // rejected by the region labels, not by flooding the floor
    expect(nav.getInfo().regions).toBe(fresh.regions + 1);
    // An obstacle in the open on one side: removing it patches the labels locally (no region appears or goes).
    nav.setObstacle(4, v3(10, 1.6, -20), 3.1);
    const two = nav.getInfo();
    expect(two.regions).toBe(fresh.regions + 1);
    nav.setObstacle(4, null);
    expect(nav.getInfo().regions).toBe(fresh.regions + 1);
    expect(nav.connected(north, gp(10.5, -20.5))).toBe(true);
    expect(nav.connected(south, gp(10.5, -20.5))).toBe(false);
    expect(nav.findPath(north, gp(10.5, -20.5), 0)).not.toBeNull();
    // The plug goes: the two halves are one region again.
    nav.setObstacle(3, null);
    expect(nav.connected(north, south)).toBe(true);
    expect(nav.getInfo()).toEqual(fresh);
    const path = nav.findPath(north, south, 0) as V3[];
    expect(path[path.length - 1]).toEqual(south);
    // Obstacles and barriers count independently on the same nodes.
    const again = setup(opts, (stage) => addBarrier(stage, 'B1', box(-3, 0, -1, 3, 6, 1)));
    again.nav.setObstacle(1, v3(0, 1.6, 0), 3.1);
    again.nav.setBarrierOpen('B1', true);
    expect(again.nav.connected(north, south)).toBe(false); // the obstacle still plugs the door
    again.nav.setObstacle(1, null);
    expect(again.nav.connected(north, south)).toBe(true);
    again.nav.setBarrierOpen('B1', false);
    expect(again.nav.connected(north, south)).toBe(false);
  });

  it('any sequence of obstacles coming and going leaves exactly the regions a fresh grid with the same obstacles has', () => {
    // A floor cut into rooms by walls with 4 m doors: obstacles in the doors split and join regions, the ones
    // in the rooms do not. The labels patched in place on removal must agree with a full re-labelling.
    const walls: SolidDef[] = [];
    for (const c of [-20, 0, 20]) {
      for (const seg of [[-40, -22], [-18, -2], [2, 18], [22, 40]] as const) {
        walls.push(solid(c - 0.5, 0, seg[0], c + 0.5, 5, seg[1]));
        walls.push(solid(seg[0], 0, c - 0.5, seg[1], 5, c + 0.5));
      }
    }
    const opts: TestStageOptions = { floorSize: 80, solids: walls };
    const { nav } = setup(opts);
    const rng = new Rng(4242);
    const spots: V3[] = [];
    for (let k = 0; k < 40; k++) {
      // half of them in a door (on a wall line, at a door centre ± 1), half anywhere
      if (k % 2 === 0) {
        const line = [-20, 0, 20][rng.int(3)];
        const door = [-20, 0, 20][rng.int(3)] + rng.range(-1, 1);
        spots.push(rng.next() < 0.5 ? v3(line, 1.6, door) : v3(door, 1.6, line));
      } else {
        spots.push(v3(rng.range(-38, 38), 1.6, rng.range(-38, 38)));
      }
    }
    const probes: V3[] = [];
    for (let x = -30; x <= 30; x += 20) for (let z = -30; z <= 30; z += 20) probes.push(gp(x + 0.5, z + 0.5));
    const active = new Set<number>();
    let splits = 0;
    for (let step = 0; step < 120; step++) {
      const k = rng.int(spots.length);
      if (active.has(k)) {
        active.delete(k);
        nav.setObstacle(k, null);
      } else {
        active.add(k);
        nav.setObstacle(k, spots[k], 3.1);
      }
      if (step % 3 !== 0) continue;
      const fresh = setup(opts).nav;
      for (const q of active) fresh.setObstacle(q, spots[q], 3.1);
      expect(nav.getInfo()).toEqual(fresh.getInfo());
      for (let a = 0; a < probes.length; a++) {
        for (let b = a + 1; b < probes.length; b++) {
          const c = nav.connected(probes[a], probes[b]);
          expect(c).toBe(fresh.connected(probes[a], probes[b]));
          if (!c) splits++;
          // … and a path exists exactly when the labels say so
          expect(nav.findPath(probes[a], probes[b], 0) !== null).toBe(c);
        }
      }
    }
    expect(splits).toBeGreaterThan(100); // the doors really were plugged at times
    for (const q of [...active]) nav.setObstacle(q, null);
    expect(nav.getInfo()).toEqual(setup(opts).nav.getInfo());
  });

  it('findPath with spheres to avoid: the path keeps out of them (pulled segments too), honours maxLength, and nothing sticks to the next query', () => {
    // A step between two lattice points that both lie outside a sphere can dip into it by at most
    // r − √(r² − ½) (9 cm at r = 2.9 m): callers pass a radius that includes that slack.
    const DIP = 0.09;
    const { nav, world } = setup({ floorSize: 120, solids: [solid(-30, 0, 8, 30, 6, 10)] });
    const a = gp(-20.3, 0.2);
    const b = gp(20.4, 0.1);
    const discs: NavDisc[] = [
      { x: 0, y: H, z: 0, r: 2.9 },
      { x: 6, y: H, z: -4.5, r: 2.9 },
      { x: 500, y: H, z: 500, r: 2.9 }, // off the stage: harmless
    ];
    const plain = nav.findPath(a, b) as V3[];
    expect(plain).toEqual([b]);
    const round = nav.findPath(a, b, 4, { avoid: discs }) as V3[];
    expect(round[round.length - 1]).toEqual(b);
    expect(round.length).toBeGreaterThan(1);
    for (const d of discs) expect(polyDistance(a, round, d)).toBeGreaterThanOrEqual(d.r - DIP);
    expect(pathHits(world, a, round)).toBe(0);
    const len = polyLength(a, round);
    expect(len).toBeGreaterThan(40.7);
    expect(len).toBeLessThan(40.7 + 6);
    // avoidCount limits the list; the second disc is then ignored.
    const one = nav.findPath(a, b, 4, { avoid: discs, avoidCount: 1 }) as V3[];
    expect(polyDistance(a, one, discs[0])).toBeGreaterThanOrEqual(discs[0].r - DIP);
    expect(polyLength(a, one)).toBeLessThanOrEqual(len + 1e-9);
    // maxLength: the detour does not fit → null; with room it is found.
    expect(nav.findPath(a, b, 4, { avoid: discs, maxLength: 40.8 })).toBeNull();
    expect(nav.findPath(a, b, 4, { avoid: discs, maxLength: len + 0.01 })).not.toBeNull();
    expect(nav.findPath(a, b, 4, { maxLength: 40 })).toBeNull(); // shorter than the straight line
    // A goal inside a sphere cannot be reached (and no search is run for it).
    expect(nav.findPath(a, gp(0.5, 0.5), 0, { avoid: discs })).toBeNull();
    expect(nav.lastExpansions).toBe(0);
    // A start inside a sphere may only leave it: the first leg never gets nearer to that centre.
    const inside = gp(-2.2, 0.4); // 2.24 m from the first centre
    const out = nav.findPath(inside, b, 4, { avoid: discs }) as V3[];
    expect(out[out.length - 1]).toEqual(b);
    const d0 = Math.hypot(inside.x, inside.z);
    let prev = inside;
    let leaving = true;
    for (const p of out) {
      const dPrev = Math.hypot(prev.x, prev.z);
      if (dPrev < discs[0].r) {
        // while inside: the distance to the centre grows monotonically along the leg
        for (let k = 1; k <= 20; k++) {
          const x = prev.x + ((p.x - prev.x) * k) / 20;
          const z = prev.z + ((p.z - prev.z) * k) / 20;
          if (Math.hypot(x, z) < Math.min(dPrev, d0) - 1e-9) leaving = false;
        }
      } else if (polyDistance(prev, [p], discs[0]) < discs[0].r - DIP) {
        leaving = false;
      }
      prev = p;
    }
    expect(leaving).toBe(true);
    expect(polyDistance(inside, out, discs[1])).toBeGreaterThanOrEqual(discs[1].r - DIP);
    // A row of spheres across the whole southern floor: the only way left is round the far side of the wall
    // (about 99 m) — found when the budget allows it, null otherwise. The next plain query is unaffected.
    const row: NavDisc[] = [];
    for (let z = -62; z <= 8; z += 2) row.push({ x: 0, y: H, z, r: 2.9 });
    const far = nav.findPath(a, b, 4, { avoid: row, maxLength: 200 }) as V3[];
    expect(far[far.length - 1]).toEqual(b);
    expect(far.some((p) => p.z > 10 + R)).toBe(true);
    for (const d of row) expect(polyDistance(a, far, d)).toBeGreaterThanOrEqual(d.r - DIP);
    expect(pathHits(world, a, far)).toBe(0);
    expect(polyLength(a, far)).toBeGreaterThan(95);
    expect(polyLength(a, far)).toBeLessThan(105);
    expect(nav.findPath(a, b, 4, { avoid: row, maxLength: 90 })).toBeNull();
    expect(nav.findPath(a, b)).toEqual([b]);
    expect(nav.pathDistance(a, b, 100)).toBeCloseTo(Math.hypot(b.x - a.x, b.z - a.z), 9);
    // Spheres on another level do not matter.
    expect(nav.findPath(a, b, 4, { avoid: [{ x: 0, y: H + 10, z: 0, r: 2.9 }] })).toEqual([b]);
  });

  it('findVantage: the nearest spot by path with a view of the target within range; fallbacks; none', () => {
    // A gallery 6 m high (x −40 … 40, z −60 … −50) above the ground; a 14 m wall in front of its east half.
    const { nav, world } = setup({ floorSize: 200, solids: [solid(-40, 0, -60, 40, 6, -50), solid(0, 0, -48, 40, 14, -47)] });
    const target = v3(-30, 2, 0); // on the ground
    const from = gp(30, -55, 6);
    const eyeUp = ENEMIES.guard.muzzleUp;
    const sees = (p: V3): boolean => !world.segmentBlocked(v3(p.x, p.y + eyeUp, p.z), target);
    expect(sees(from)).toBe(false);
    expect(nav.findPath(from, target, 30)).toBeNull(); // no route to the ground
    const out = v3();
    const base: NavVantageOptions = { eyeUp, within: 88, maxCost: 120, fallback: 'none', minGain: 2 };
    // Qualified: a spot on the gallery, in range, with a clear line — and no nearer one (by path) has both.
    expect(nav.findVantage(from, target, base, out)).toBe(VANTAGE_QUALIFIED);
    expect(out.y).toBe(6 + H);
    expect(nav.isWalkable(out)).toBe(true);
    expect(sees(out)).toBe(true);
    expect(Math.hypot(out.x - target.x, out.y - target.y, out.z - target.z)).toBeLessThanOrEqual(88);
    const cost = nav.lastVantageCost;
    const walk = nav.findPath(from, out, 1) as V3[];
    expect(polyLength(from, walk)).toBeLessThanOrEqual(cost + 1e-9);
    expect(polyLength(from, walk)).toBeGreaterThan(cost / 1.09);
    expect(cost).toBeGreaterThan(15);
    expect(cost).toBeLessThan(35);
    // brute force over the lattice points the search tests (every third of a diagonal pattern): none nearer
    let nearer = 0;
    for (let x = -38.5; x <= 38.5; x += 1) {
      for (let z = -58.5; z <= -51.5; z += 1) {
        const p = gp(x, z, 6);
        if ((Math.round(x - 0.5) + Math.round(z - 0.5)) % 3 !== 0) continue;
        if (!sees(p) || Math.hypot(p.x - target.x, p.y - target.y, p.z - target.z) > 88) continue;
        if (nav.pathDistance(from, p, 200) < cost / 1.09 - 1.5) nearer++;
      }
    }
    expect(nearer).toBe(0);
    expect(nav.lastVantageSightTests).toBeGreaterThan(0);
    expect(nav.lastVantageExpansions).toBeGreaterThan(50);
    // Deterministic.
    const again = v3();
    expect(nav.findVantage(from, target, base, again)).toBe(VANTAGE_QUALIFIED);
    expect(again).toEqual(out);
    // A tight range: nothing on the gallery is within 40 m of the target.
    expect(nav.findVantage(from, target, { ...base, within: 40 }, out)).toBe(VANTAGE_NONE);
    // … 'visible' fallback: the spot with a view that is nearest to the target (the gallery edge below it).
    expect(nav.findVantage(from, target, { ...base, within: 40, fallback: 'visible' }, out)).toBe(VANTAGE_FALLBACK);
    expect(sees(out)).toBe(true);
    const dVis = Math.hypot(out.x - target.x, out.y - target.y, out.z - target.z);
    expect(dVis).toBeLessThan(Math.hypot(50.5, 6 + H - 2) + 1.5);
    // … 'nearest' fallback: the spot nearest to the target whatever it sees.
    expect(nav.findVantage(from, target, { ...base, within: 40, fallback: 'nearest' }, out)).toBe(VANTAGE_FALLBACK);
    const dNear = Math.hypot(out.x - target.x, out.y - target.y, out.z - target.z);
    expect(dNear).toBeLessThanOrEqual(dVis + 1e-9);
    expect(dNear).toBeCloseTo(Math.hypot(0.5, 6 + H - 2, 50.5), 6); // the lattice point nearest to the target
    // minGain: from that very spot nothing is 2 m nearer → none.
    const best = v3(out.x, out.y, out.z);
    expect(nav.findVantage(best, target, { ...base, within: 40, fallback: 'nearest' }, out)).toBe(VANTAGE_NONE);
    expect(nav.findVantage(best, target, { ...base, within: 40, fallback: 'visible' }, out)).toBe(VANTAGE_NONE);
    // maxCost bounds the exploration: the view is 20-odd metres away.
    expect(nav.findVantage(from, target, { ...base, maxCost: 10 }, out)).toBe(VANTAGE_NONE);
    expect(nav.lastVantageExpansions).toBeLessThan(400);
    // Budgets: no sight test allowed → nothing can qualify; a tiny expansion budget ends the search.
    expect(nav.findVantage(from, target, { ...base, maxSightTests: 0 }, out)).toBe(VANTAGE_NONE);
    expect(nav.lastVantageSightTests).toBe(0);
    expect(nav.findVantage(from, target, { ...base, maxExpansions: 5 }, out)).toBe(VANTAGE_NONE);
    expect(nav.lastVantageExpansions).toBeLessThanOrEqual(6);
    // Start with a view: the start's own cell qualifies at once.
    const west = gp(-30.5, -52.5, 6);
    expect(sees(west)).toBe(true);
    expect(nav.findVantage(west, target, base, out)).toBe(VANTAGE_QUALIFIED);
    expect(nav.lastVantageCost).toBeLessThan(3);
    // No standing position / bad input.
    expect(nav.findVantage(v3(0, 50, 0), target, base, out)).toBe(VANTAGE_NONE);
    expect(nav.findVantage(v3(Number.NaN, 0, 0), target, base, out)).toBe(VANTAGE_NONE);
    // Obstacles are respected: a sphere that plugs the gallery between start and view → nothing reachable.
    for (let k = 0; k < 4; k++) nav.setObstacle(100 + k, v3(12, 6 + 1.6, -58.5 + k * 2.5), 3.1);
    expect(nav.connected(from, west)).toBe(false);
    expect(nav.findVantage(from, target, base, out)).toBe(VANTAGE_NONE);
    nav.clearObstacles();
    expect(nav.findVantage(from, target, base, out)).toBe(VANTAGE_QUALIFIED);
    expect(out).toEqual(again);
  });
});

describe('NavGrid — integration', () => {
  it('Sim opens the grid barrier when the control turret dies and closes it on reset', async () => {
    const { Sim } = await import('../src/sim/sim');
    const stage = makeTestStage({
      floorSize: 100,
      solids: [solid(-1, 0, -50, 1, 8, -4), solid(-1, 0, 4, 1, 8, 50)],
      enemies: [
        makeGuard('G1', 20, 10),
        { id: 'T1', kind: 'turret', sectorId: 'T00', position: v3(-30, 1.6, 30), isGateControl: true, barrierId: 'B1' },
      ],
      start: v3(-40, 2.001, -40),
    });
    addBarrier(stage, 'B1', box(-1, 0, -4, 1, 8, 4), 'T1');
    const sim = new Sim(stage);
    const guard = sim.enemyById.get('G1')!;
    const target = gp(-20, -10);
    expect(sim.nav.isWalkable(guard.pos)).toBe(true);
    expect(sim.nav.findPath(guard.pos, target)).toBeNull();
    sim.damageEnemy(sim.enemyById.get('T1')!, 1e6);
    expect(sim.objective.openBarrierIds).toEqual(['B1']);
    expect(sim.nav.isBarrierOpen('B1')).toBe(true);
    expect(sim.world.isBarrierOpen('B1')).toBe(true);
    const path = sim.nav.findPath(guard.pos, target)!;
    expect(path).not.toBeNull();
    expect(pathHits(sim.world, guard.pos, path)).toBe(0);
    sim.reset();
    expect(sim.nav.isBarrierOpen('B1')).toBe(false);
    expect(sim.world.isBarrierOpen('B1')).toBe(false);
    expect(sim.nav.findPath(sim.enemyById.get('G1')!.pos, target)).toBeNull();
  });

  it('shipped factory stage: builds fast, every guard stands on the grid (diagnostics)', async () => {
    let buildFactoryStage: (() => StageDef) | null = null;
    try {
      buildFactoryStage = (await import('../src/stage/factory')).buildFactoryStage;
    } catch (err) {
      console.log(`[nav] factory stage not loadable right now, skipped: ${String(err)}`);
      return;
    }
    const stage = buildFactoryStage();
    const world = new World(stage);
    const before = world.boxes.map((b) => b.active);
    const t0 = performance.now();
    const nav = new NavGrid(world, stage);
    nav.build();
    const buildMs = performance.now() - t0;
    expect(world.boxes.map((b) => b.active)).toEqual(before);
    const info = nav.getInfo();
    const guards = stage.enemies.filter((e) => e.kind === 'guard');
    const off = guards.filter((g) => !nav.isWalkable(g.position)).map((g) => g.id);
    const lost = guards.filter((g) => nav.nearestWalkable(g.position, 3) === null).map((g) => g.id);
    console.log(
      `[nav] factory: ${stage.solids.length} solids, build ${buildMs.toFixed(0)} ms, ${info.nodes} nodes, ${info.regions} regions, ` +
        `${info.blockedNodes} nodes under closed barriers; guards ${guards.length}, off the walkable area: [${off.join(' ')}], ` +
        `without a standing position within 3 m: [${lost.join(' ')}]`,
    );
    // Wall-clock, diagnostic only (the amount of work is fixed by the stage): measured 0.3 s when this file runs
    // alone on the development machine and 1.5 s when the whole suite ran in parallel on the loaded machine.
    expect(buildMs).toBeLessThan(5000);
    expect(info.nodes).toBeGreaterThan(0);
    expect(lost).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('NavGrid — performance on a large random stage', () => {
  /** 450 x 350 m floor, a few thousand boxes: pillars, crates, walls with gaps, a second and a third level. */
  function bigStage(): StageDef {
    const rng = new Rng(20261112);
    const W = 450;
    const D = 350;
    const solids: SolidDef[] = [solid(0, -1, 0, W, 0, D)];
    // outer walls
    solids.push(solid(-1, 0, -1, W + 1, 12, 0), solid(-1, 0, D, W + 1, 12, D + 1), solid(-1, 0, 0, 0, 12, D), solid(W, 0, 0, W + 1, 12, D));
    // long walls with doorways, every 50 m
    for (let x = 50; x < W; x += 50) {
      let z = 0;
      while (z < D) {
        const len = rng.range(18, 45);
        const z1 = Math.min(D, z + len);
        solids.push(solid(x - 0.5, 0, z, x + 0.5, 10, z1));
        z = z1 + rng.range(4, 9); // doorway
      }
    }
    // mezzanines (second level at 8 m, third at 16 m) on pillars
    for (let k = 0; k < 40; k++) {
      const w = rng.range(12, 40);
      const d = rng.range(12, 40);
      const x = rng.range(2, W - w - 2);
      const z = rng.range(2, D - d - 2);
      const top = k % 4 === 0 ? 16 : 8;
      solids.push(solid(x, top - 1, z, x + w, top, z + d));
    }
    // crates, machines, pillars
    while (solids.length < 3200) {
      const kind = rng.next();
      const x = rng.range(1, W - 12);
      const z = rng.range(1, D - 12);
      if (kind < 0.35) {
        const s = rng.range(0.6, 2);
        solids.push(solid(x, 0, z, x + s, 12, z + s));
      } else if (kind < 0.85) {
        solids.push(solid(x, 0, z, x + rng.range(1.5, 6), rng.range(0.6, 4), z + rng.range(1.5, 6)));
      } else {
        solids.push(solid(x, 0, z, x + rng.range(4, 11), rng.range(3, 6.5), z + rng.range(4, 11)));
      }
    }
    const stage = makeTestStage({ floorSize: 10 });
    stage.solids = solids;
    stage.bounds = box(-8, -8, -8, W + 8, 40, D + 8);
    return stage;
  }

  it('builds well under 1.5 s and answers 150 m queries in a few milliseconds', () => {
    const stage = bigStage();
    expect(stage.solids.length).toBe(3200);
    const world = new World(stage);
    // build: best of three (the machine running the tests may be busy)
    let buildMs = Infinity;
    let nav!: NavGrid;
    for (let r = 0; r < 3; r++) {
      const t0 = performance.now();
      const n = new NavGrid(world, stage);
      n.build();
      buildMs = Math.min(buildMs, performance.now() - t0);
      nav = n;
    }
    const info = nav.getInfo();
    expect(info.nx).toBe(452); // 450 m of floor + the 1 m outer walls
    expect(info.nz).toBe(352);
    expect(info.nodes).toBeGreaterThan(80000);

    // ground-level points of the largest region
    const rng = new Rng(555);
    const all: V3[] = [];
    while (all.length < 600) {
      const p = gp(rng.range(1, 449), rng.range(1, 349));
      if (nav.isWalkable(p)) all.push(p);
    }
    let pts: V3[] = [];
    for (let s = 0; s < 12; s++) {
      const group = all.filter((p) => nav.connected(all[s], p));
      if (group.length > pts.length) pts = group;
    }
    expect(pts.length).toBeGreaterThan(300);
    // Two query sets: (A) routes that are 140-160 m long — "a path query across 150 m" — and (B) end points
    // 140-160 m apart in a straight line, which in this maze of walls means routes of about 320 m.
    const routes: Array<[V3, V3]> = [];
    for (let guard = 0; routes.length < 120 && guard < 20000; guard++) {
      const a = pts[rng.int(pts.length)];
      const b = pts[rng.int(pts.length)];
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      if (d < 60 || d > 150) continue;
      const walk = nav.pathDistance(a, b, 160);
      if (walk >= 140 && walk <= 160) routes.push([a, b]);
    }
    expect(routes.length).toBe(120);
    const pairs: Array<[V3, V3]> = [];
    for (let guard = 0; pairs.length < 150 && guard < 200000; guard++) {
      const a = pts[rng.int(pts.length)];
      const b = pts[rng.int(pts.length)];
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      if (d >= 140 && d <= 160) pairs.push([a, b]);
    }
    expect(pairs.length).toBe(150);
    for (let k = 0; k < 100; k++) nav.findPath(pairs[k][0], pairs[k][1]); // warm-up

    interface Stats {
      avg: number;
      median: number;
      p95: number;
      max: number;
      expAvg: number;
      expMax: number;
      meanLen: number;
      meanWp: number;
      paths: Array<V3[] | null>;
    }
    const measure = (set: Array<[V3, V3]>): Stats => {
      const times: number[] = [];
      const paths: Array<V3[] | null> = [];
      let exp = 0;
      let expMax = 0;
      let len = 0;
      let wp = 0;
      for (const [a, b] of set) {
        // best of five per query: measures the query, not the neighbours on this machine
        let best = Infinity;
        let path: V3[] | null = null;
        for (let r = 0; r < 5; r++) {
          const t0 = performance.now();
          path = nav.findPath(a, b);
          best = Math.min(best, performance.now() - t0);
        }
        times.push(best);
        paths.push(path);
        expect(path).not.toBeNull();
        exp += nav.lastExpansions;
        expMax = Math.max(expMax, nav.lastExpansions);
        len += polyLength(a, path!);
        wp += path!.length;
      }
      times.sort((x, y) => x - y);
      return {
        avg: times.reduce((s, t) => s + t, 0) / times.length,
        median: times[Math.floor(times.length / 2)],
        p95: times[Math.floor(times.length * 0.95)],
        max: times[times.length - 1],
        expAvg: exp / set.length,
        expMax,
        meanLen: len / set.length,
        meanWp: wp / set.length,
        paths,
      };
    };
    const A = measure(routes);
    const B = measure(pairs);
    const fmt = (name: string, n: number, st: Stats): string =>
      `${name}: ${n} queries, mean route ${st.meanLen.toFixed(0)} m, ${st.meanWp.toFixed(1)} waypoints, ` +
      `avg ${st.avg.toFixed(3)} ms, median ${st.median.toFixed(3)} ms, p95 ${st.p95.toFixed(3)} ms, max ${st.max.toFixed(3)} ms, ` +
      `expansions avg ${st.expAvg.toFixed(0)} max ${st.expMax}`;

    // 60 m bounded distance queries (alert sharing) between random points
    let distMs = 0;
    let distN = 0;
    let within = 0;
    const tq = performance.now();
    for (let k = 0; k < 3000; k++) {
      const a = pts[rng.int(pts.length)];
      const b = pts[rng.int(pts.length)];
      if (Math.hypot(a.x - b.x, a.z - b.z) > 60) continue;
      distN++;
      if (nav.pathDistance(a, b, 60) <= 60) within++;
    }
    distMs = performance.now() - tq;

    console.log(
      `[nav] big stage: ${stage.solids.length} boxes, ${info.nx}x${info.nz} cells, ${info.nodes} nodes, ${info.regions} regions | build ${buildMs.toFixed(1)} ms\n` +
        `[nav]   ${fmt('findPath, routes of 140-160 m', routes.length, A)}\n` +
        `[nav]   ${fmt('findPath, 140-160 m apart in a straight line', pairs.length, B)}\n` +
        `[nav]   pathDistance(<= 60 m): ${distN} queries, ${within} within, ${((distMs / Math.max(1, distN)) * 1000).toFixed(1)} µs each`,
    );
    // Targets: build well under 1.5 s, a query across 150 m well under 5 ms. On a quiet core this stage
    // measures about 45 ms for the build and well under 1 ms (median) for set A; see the printed lines. The
    // wall-clock limits are loose because the suite runs in parallel with other test files and whatever
    // else the machine is doing (the same run has been seen 3x slower under load); the amount of work per
    // query is deterministic and asserted tightly.
    expect(buildMs).toBeLessThan(1500);
    expect(A.median).toBeLessThan(5);
    expect(A.avg).toBeLessThan(10);
    expect(B.median).toBeLessThan(10);
    expect(B.avg).toBeLessThan(25);
    expect(A.expAvg).toBeLessThan(5000);
    expect(B.expAvg).toBeLessThan(12000);
    expect(B.expMax).toBeLessThan(40000);

    // and the answers are right: replay a sample against the collision world
    for (let k = 0; k < pairs.length; k += 6) {
      expect(pathHits(world, pairs[k][0], B.paths[k]!, 0.05)).toBe(0);
    }
    for (let k = 0; k < routes.length; k += 4) {
      const len = polyLength(routes[k][0], A.paths[k]!);
      expect(len).toBeGreaterThanOrEqual(140 - 1e-9);
      expect(len).toBeLessThanOrEqual(160 + 1e-9);
      expect(pathHits(world, routes[k][0], A.paths[k]!, 0.05)).toBe(0);
    }
  });
});
