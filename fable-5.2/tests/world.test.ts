/**
 * World (static collision) tests — src/sim/world.ts.
 *
 * Layout of this file:
 *   1. helpers: stage builder, seeded scene generators
 *   2. RefWorld — brute-force reference implementation of the documented semantics (every query loops
 *      over all boxes, no spatial index, no shortcuts)
 *   3. independent oracles that do not share any formula with the implementation (sampling ray oracle on
 *      lattices, single-axis sweep, convex-room clamp)
 *   4. legacy — the previous brute-force world.ts, verbatim, to show what is unchanged and what was fixed
 *   5. targeted cases
 *   6. randomized equivalence World ⇔ RefWorld (within 1e-9), invariants
 *   7. benchmark
 */
import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import { v3, type V3 } from '../src/core/vec';
import type { Box, SectorDef, StageDef } from '../src/sim/types';
import { CONTACT_EPS, SKIN, World, type MoveResult, type RayHit, type WorldBox, type WorldOptions } from '../src/sim/world';
import { makeTestStage } from '../src/stage/testStages';

// ───────────────────────────── 1. helpers ─────────────────────────────

const TOL = 1e-9;
const PLAYER_HALF = v3(1.3, 2.0, 1.3);

function bx(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Box {
  return { min: v3(x0, y0, z0), max: v3(x1, y1, z1) };
}

interface BarrierSpec {
  id: string;
  box: Box;
}

/** Out of the way of every targeted scene (far below; Y is not part of the grid). */
const DEFAULT_GATE = bx(-0.5, -500, -0.5, 0.5, -499, 0.5);

function stageOf(solids: Box[], barriers: BarrierSpec[] = [], gate: Box = DEFAULT_GATE, sectors: SectorDef[] = []): StageDef {
  return {
    id: 'world-test',
    name: 'world test stage',
    bounds: { min: v3(-1000, -1000, -1000), max: v3(1000, 1000, 1000) },
    killY: -1000,
    sectors,
    solids: solids.map((b) => ({ min: b.min, max: b.max, material: 'concrete' as const })),
    decor: [],
    barriers: barriers.map((b) => ({ id: b.id, name: b.id, box: b.box, controlEnemyId: 'T00', fromSectorId: 'A', toSectorId: 'B' })),
    finalGate: { id: 'GATE', name: 'gate', box: gate },
    exitZone: bx(900, 900, 900, 901, 901, 901),
    playerStart: { position: v3(0, 2, 0), yaw: 0 },
    enemies: [],
    connections: [],
    route: [],
    flightSpots: [],
    branches: [],
    loops: [],
  };
}

function worldOf(solids: Box[], barriers: BarrierSpec[] = [], opts: WorldOptions = {}): World {
  return new World(stageOf(solids, barriers), opts);
}

function fail(msg: string): never {
  throw new Error(msg);
}

interface NodeProcessLike {
  env?: Record<string, string | undefined>;
  stdout?: { write(text: string): unknown };
}
const nodeProcess = (globalThis as { process?: NodeProcessLike }).process;

/** WORLD_SOAK=<n> multiplies the number of random queries (default 1) for long soak runs. */
const SOAK = Math.max(1, Number(nodeProcess?.env?.WORLD_SOAK ?? 1) || 1);

/** Prints even when the test runner hides console output of passing tests. */
function report(text: string): void {
  if (nodeProcess?.stdout) nodeProcess.stdout.write(`${text}\n`);
  else console.log(text);
}

function near(a: number, b: number, tol = TOL): boolean {
  if (a === b) return true; // also Infinity === Infinity
  return Math.abs(a - b) <= tol;
}

function fmt(v: V3): string {
  return `(${v.x}, ${v.y}, ${v.z})`;
}

// ───────────────────────────── 2. brute-force reference ─────────────────────────────

interface RefBox {
  lo: [number, number, number];
  hi: [number, number, number];
  active: boolean;
  barrierId: string | null;
}

interface RefHit {
  t: number;
  idx: number;
  axis: number;
  sign: number;
}

interface RefRayHit {
  dist: number;
  idx: number;
  normal: [number, number, number];
}

const arr = (v: V3): [number, number, number] => [v.x, v.y, v.z];

/**
 * Reference implementation of the semantics documented at the top of src/sim/world.ts.
 * Boxes are tested one by one in index order; "first wins" therefore means "lowest index wins".
 */
class RefWorld {
  readonly boxes: RefBox[] = [];

  constructor(stage: StageDef) {
    const add = (b: Box, id: string | null): void => {
      this.boxes.push({
        lo: [Math.min(b.min.x, b.max.x), Math.min(b.min.y, b.max.y), Math.min(b.min.z, b.max.z)],
        hi: [Math.max(b.min.x, b.max.x), Math.max(b.min.y, b.max.y), Math.max(b.min.z, b.max.z)],
        active: true,
        barrierId: id,
      });
    };
    for (const s of stage.solids) add(s, null);
    for (const b of stage.barriers) add(b.box, b.id);
    add(stage.finalGate.box, stage.finalGate.id);
  }

  setBarrierOpen(id: string, open: boolean): void {
    for (const b of this.boxes) if (b.barrierId === id) b.active = !open;
  }

  resetBarriers(): void {
    for (const b of this.boxes) if (b.barrierId !== null) b.active = true;
  }

  /**
   * First hit of one ray variant for parameters >= tMin. On an axis without motion the origin must be inside
   * the slab: side 0 → open slab (lo, hi), +1 → ray shifted towards +axis [lo, hi), -1 → towards -axis (lo, hi].
   */
  private firstHit(o: number[], d: number[], tMin: number, tMax: number, strict: boolean, side: number[]): RefHit | null {
    let best: RefHit | null = null;
    for (let i = 0; i < this.boxes.length; i++) {
      const b = this.boxes[i];
      if (!b.active) continue;
      let tEnter = -Infinity;
      let tExit = Infinity;
      let axis = 0;
      let sign = 0;
      let miss = false;
      for (let a = 0; a < 3; a++) {
        const lo = b.lo[a];
        const hi = b.hi[a];
        if (Math.abs(d[a]) < 1e-12) {
          const s = side[a];
          const inside = s === 0 ? o[a] > lo && o[a] < hi : s > 0 ? o[a] >= lo && o[a] < hi : o[a] > lo && o[a] <= hi;
          if (!inside) {
            miss = true;
            break;
          }
          continue;
        }
        let t1 = (lo - o[a]) / d[a];
        let t2 = (hi - o[a]) / d[a];
        let s = -1;
        if (t1 > t2) {
          const tmp = t1;
          t1 = t2;
          t2 = tmp;
          s = 1;
        }
        if (t1 > tEnter) {
          tEnter = t1;
          axis = a;
          sign = s;
        }
        if (t2 < tExit) tExit = t2;
        if (tEnter >= tExit) {
          miss = true;
          break;
        }
      }
      if (miss || tExit <= tMin) continue;
      const inside = tEnter < tMin;
      const t = inside ? tMin : tEnter;
      if (strict ? !(t < tMax) : !(t <= tMax)) continue;
      if (best === null || t < best.t) best = { t, idx: i, axis, sign: inside ? 0 : sign };
    }
    return best;
  }

  /**
   * Ray against the union of the boxes. Without a motionless axis this is the plain nearest-hit loop. With
   * one, the ray may lie in a face plane: it is blocked at t iff the rays shifted to every side of that
   * plane are all inside a box right after t.
   */
  private castRay(o: number[], d: number[], tMax: number, strict: boolean): RefHit | null {
    const axes = [0, 1, 2].filter((a) => Math.abs(d[a]) < 1e-12);
    if (axes.length === 0) return this.firstHit(o, d, 0, tMax, strict, [0, 0, 0]);
    const nVar = 1 << axes.length;
    let t = 0;
    for (;;) {
      const res: RefHit[] = [];
      let tNext = t;
      for (let v = 0; v < nVar; v++) {
        const side = [0, 0, 0];
        axes.forEach((a, k) => {
          side[a] = (v >> k) & 1 ? 1 : -1;
        });
        const h = this.firstHit(o, d, t, tMax, strict, side);
        if (!h) return null;
        res.push(h);
        if (h.t > tNext) tNext = h.t;
      }
      if (tNext === t) {
        const pick = res.find((h) => h.sign !== 0) ?? res[0];
        return { t, idx: pick.idx, axis: pick.axis, sign: pick.sign };
      }
      t = tNext;
    }
  }

  raycast(origin: V3, dir: V3, maxDist: number): RefRayHit | null {
    if (!(maxDist >= 0)) return null;
    const h = this.castRay(arr(origin), arr(dir), maxDist, false);
    if (!h) return null;
    const normal: [number, number, number] = [0, 0, 0];
    normal[h.axis] = h.sign;
    return { dist: h.t, idx: h.idx, normal };
  }

  segmentBlocked(a: V3, b: V3): boolean {
    const d = [b.x - a.x, b.y - a.y, b.z - a.z];
    if (!(d[0] * d[0] + d[1] * d[1] + d[2] * d[2] >= 1e-18)) return false;
    return this.castRay(arr(a), d, 1, true) !== null;
  }

  overlapsBox(center: V3, half: V3): boolean {
    return this.boxesInAabb(v3(center.x - half.x, center.y - half.y, center.z - half.z), v3(center.x + half.x, center.y + half.y, center.z + half.z)).length > 0;
  }

  boxesInAabb(min: V3, max: V3): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.boxes.length; i++) {
      const b = this.boxes[i];
      if (!b.active) continue;
      if (max.x > b.lo[0] && min.x < b.hi[0] && max.y > b.lo[1] && min.y < b.hi[1] && max.z > b.lo[2] && min.z < b.hi[2]) out.push(i);
    }
    return out;
  }

  moveBox(center: V3, half: V3, delta: V3): MoveResult {
    const out: MoveResult = { nx: 0, ny: 0, nz: 0 };
    const c = arr(center);
    const h = arr(half);
    const r = arr(delta);
    if (![...c, ...h, ...r].every(Number.isFinite)) return out;
    const n = [0, 0, 0];
    for (let a = 0; a < 3; a++) if (Math.abs(r[a]) < 1e-12) r[a] = 0;
    for (let iter = 0; iter < 4; iter++) {
      if (r[0] === 0 && r[1] === 0 && r[2] === 0) break;
      let bestT = Infinity;
      let bestAxis = -1;
      let bestSign = 0;
      for (const b of this.boxes) {
        if (!b.active) continue;
        let tEnter = -Infinity;
        let tExit = Infinity;
        let axis = -1;
        let sign = 0;
        let miss = false;
        for (let a = 0; a < 3; a++) {
          const lo = b.lo[a] - h[a];
          const hi = b.hi[a] + h[a];
          let o = c[a];
          // contact band: at most CONTACT_EPS inside a face counts as touching that face
          if (o > lo && o - lo <= CONTACT_EPS) o = lo;
          else if (o < hi && hi - o <= CONTACT_EPS) o = hi;
          if (r[a] === 0) {
            if (o <= lo || o >= hi) {
              miss = true;
              break;
            }
            continue;
          }
          let t1 = (lo - o) / r[a];
          let t2 = (hi - o) / r[a];
          let s = -1;
          if (t1 > t2) {
            const tmp = t1;
            t1 = t2;
            t2 = tmp;
            s = 1;
          }
          if (t1 > tEnter) {
            tEnter = t1;
            axis = a;
            sign = s;
          }
          if (t2 < tExit) tExit = t2;
          if (tEnter >= tExit) {
            miss = true;
            break;
          }
        }
        if (miss) continue;
        if (tExit <= 0) continue; // moving away / already past
        if (tEnter < 0) continue; // genuinely overlapping at the start: ignored
        if (tEnter > 1) continue;
        if (tEnter < bestT) {
          bestT = tEnter;
          bestAxis = axis;
          bestSign = sign;
        }
      }
      if (bestAxis < 0) {
        for (let a = 0; a < 3; a++) c[a] += r[a];
        break;
      }
      let t = bestT - SKIN / Math.abs(r[bestAxis]);
      if (!(t > 0)) t = 0;
      for (let a = 0; a < 3; a++) c[a] += r[a] * t;
      const rest = 1 - t;
      for (let a = 0; a < 3; a++) r[a] *= rest;
      r[bestAxis] = 0;
      n[bestAxis] = bestSign;
      for (let a = 0; a < 3; a++) if (Math.abs(r[a]) < 1e-12) r[a] = 0;
    }
    center.x = c[0];
    center.y = c[1];
    center.z = c[2];
    out.nx = n[0];
    out.ny = n[1];
    out.nz = n[2];
    return out;
  }

  probeGround(center: V3, half: V3, maxDist: number): number {
    if (!(maxDist >= 0)) return Infinity;
    const bottom = center.y - half.y;
    let best = Infinity;
    for (const b of this.boxes) {
      if (!b.active) continue;
      if (!(center.x - (b.lo[0] - half.x) > CONTACT_EPS && b.hi[0] + half.x - center.x > CONTACT_EPS)) continue;
      if (!(center.z - (b.lo[2] - half.z) > CONTACT_EPS && b.hi[2] + half.z - center.z > CONTACT_EPS)) continue;
      const gap = bottom - b.hi[1];
      if (gap < -CONTACT_EPS || gap > maxDist) continue;
      if (gap < best) best = gap;
    }
    return best < 0 ? 0 : best;
  }

  /** Deepest penetration of the box (center, half) into any active box (min over the axes of the overlap). */
  penetration(center: V3, half: V3): number {
    let worst = 0;
    const c = arr(center);
    const h = arr(half);
    for (const b of this.boxes) {
      if (!b.active) continue;
      let depth = Infinity;
      for (let a = 0; a < 3; a++) depth = Math.min(depth, Math.min(c[a] + h[a] - b.lo[a], b.hi[a] - (c[a] - h[a])));
      if (depth > worst) worst = depth;
    }
    return worst;
  }
}

// ───────────────────────────── 3. independent oracles ─────────────────────────────

/**
 * Sampling oracle for rays on lattice scenes (all coordinates multiples of 0.5, direction components in
 * {0, ±0.5, ±1, ±2}): the ray is blocked at the first event parameter t for which the point just after t
 * (sampled half-way to the next event) is strictly inside a box — for the ray itself and, when it does not
 * move along an axis, for the copies shifted by ±1/8 along that axis. Shares no code with the slab tests.
 */
function oracleRay(boxes: RefBox[], origin: V3, dir: V3, maxDist: number, strict: boolean): number | null {
  const o = arr(origin);
  const d = arr(dir);
  // every parameter at which the ray crosses a face plane of some box: nothing changes between two of them
  const events = new Set<number>([0]);
  for (const b of boxes) {
    if (!b.active) continue;
    for (let a = 0; a < 3; a++) {
      if (d[a] === 0) continue;
      for (const f of [b.lo[a], b.hi[a]]) {
        const t = (f - o[a]) / d[a];
        if (t > 0) events.add(t);
      }
    }
  }
  const parallel = [0, 1, 2].filter((a) => d[a] === 0);
  const variants: number[][] = [];
  for (let v = 0; v < 1 << parallel.length; v++) {
    const off = [0, 0, 0];
    parallel.forEach((a, k) => {
      off[a] = (v >> k) & 1 ? 0.125 : -0.125;
    });
    variants.push(off);
  }
  const insideSolid = (q: number[]): boolean =>
    boxes.some((b) => b.active && q[0] > b.lo[0] && q[0] < b.hi[0] && q[1] > b.lo[1] && q[1] < b.hi[1] && q[2] > b.lo[2] && q[2] < b.hi[2]);
  const sorted = [...events].sort((p, q) => p - q);
  for (let k = 0; k < sorted.length; k++) {
    const t = sorted[k];
    if (strict ? !(t < maxDist) : !(t <= maxDist)) break;
    // a point strictly between this event and the next one
    const ts = k + 1 < sorted.length ? (t + sorted[k + 1]) / 2 : t + 1;
    if (variants.every((off) => insideSolid([o[0] + d[0] * ts + off[0], o[1] + d[1] * ts + off[1], o[2] + d[2] * ts + off[2]]))) return t;
  }
  return null;
}

/**
 * Expected result of a move along one axis from a position that overlaps nothing: the box advances until
 * the nearest obstacle in its path (strict overlap on the two other axes), stopping SKIN short of it.
 */
function oracleAxisMove(boxes: RefBox[], center: V3, half: V3, axis: number, delta: number): { pos: number; hit: boolean } {
  const c = arr(center);
  const h = arr(half);
  const dirSign = delta > 0 ? 1 : -1;
  let gap = Infinity;
  for (const b of boxes) {
    if (!b.active) continue;
    let lateral = true;
    for (let a = 0; a < 3; a++) {
      if (a === axis) continue;
      if (!(c[a] + h[a] > b.lo[a] && c[a] - h[a] < b.hi[a])) lateral = false;
    }
    if (!lateral) continue;
    const g = dirSign > 0 ? b.lo[axis] - (c[axis] + h[axis]) : c[axis] - h[axis] - b.hi[axis];
    if (g >= 0 && g < gap) gap = g;
  }
  const dist = Math.abs(delta);
  if (gap > dist) return { pos: c[axis] + delta, hit: false };
  return { pos: c[axis] + dirSign * Math.max(0, gap - SKIN), hit: true };
}

// ───────────────────────────── 4. legacy implementation (previous world.ts, verbatim logic) ─────────────────────────────

interface LegacyBox {
  min: V3;
  max: V3;
  active: boolean;
}

function legacyBoxes(stage: StageDef): LegacyBox[] {
  const out: LegacyBox[] = [];
  for (const s of stage.solids) out.push({ min: { ...s.min }, max: { ...s.max }, active: true });
  for (const b of stage.barriers) out.push({ min: { ...b.box.min }, max: { ...b.box.max }, active: true });
  out.push({ min: { ...stage.finalGate.box.min }, max: { ...stage.finalGate.box.max }, active: true });
  return out;
}

function legacyRaycast(boxes: LegacyBox[], origin: V3, dir: V3, maxDist: number): { dist: number; idx: number; normal: V3 } | null {
  let best = maxDist;
  let bestBox = -1;
  let bestAxis = 0;
  let bestSign = 0;
  for (let bi = 0; bi < boxes.length; bi++) {
    const b = boxes[bi];
    if (!b.active) continue;
    let tEnter = -Infinity;
    let tExit = Infinity;
    let axis = 0;
    let sign = 0;
    let miss = false;
    for (let a = 0; a < 3; a++) {
      const o = a === 0 ? origin.x : a === 1 ? origin.y : origin.z;
      const d = a === 0 ? dir.x : a === 1 ? dir.y : dir.z;
      const lo = a === 0 ? b.min.x : a === 1 ? b.min.y : b.min.z;
      const hi = a === 0 ? b.max.x : a === 1 ? b.max.y : b.max.z;
      if (Math.abs(d) < 1e-12) {
        if (o <= lo || o >= hi) {
          miss = true;
          break;
        }
        continue;
      }
      let t1 = (lo - o) / d;
      let t2 = (hi - o) / d;
      let s = -1;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
        s = 1;
      }
      if (t1 > tEnter) {
        tEnter = t1;
        axis = a;
        sign = s;
      }
      if (t2 < tExit) tExit = t2;
      if (tEnter >= tExit) {
        miss = true;
        break;
      }
    }
    if (miss || tExit <= 0) continue;
    const t = tEnter < 0 ? 0 : tEnter;
    if (t <= best) {
      if (t === best && bestBox >= 0) continue;
      best = t;
      bestBox = bi;
      bestAxis = axis;
      bestSign = tEnter < 0 ? 0 : sign;
    }
  }
  if (bestBox < 0) return null;
  const normal = v3(0, 0, 0);
  if (bestAxis === 0) normal.x = bestSign;
  else if (bestAxis === 1) normal.y = bestSign;
  else normal.z = bestSign;
  return { dist: best, idx: bestBox, normal };
}

function legacySegmentBlocked(boxes: LegacyBox[], a: V3, b: V3): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-9) return false;
  return legacyRaycast(boxes, a, v3(dx / len, dy / len, dz / len), len) !== null;
}

function legacyMoveBox(boxes: LegacyBox[], center: V3, half: V3, delta: V3): MoveResult {
  const out: MoveResult = { nx: 0, ny: 0, nz: 0 };
  let rx = delta.x;
  let ry = delta.y;
  let rz = delta.z;
  for (let iter = 0; iter < 4; iter++) {
    const len = Math.hypot(rx, ry, rz);
    if (len < 1e-10) break;
    let bestT = 1.0000001;
    let bestAxis = -1;
    let bestSign = 0;
    for (const b of boxes) {
      if (!b.active) continue;
      let tEnter = -Infinity;
      let tExit = Infinity;
      let axis = -1;
      let sign = 0;
      let miss = false;
      for (let a = 0; a < 3; a++) {
        const o = a === 0 ? center.x : a === 1 ? center.y : center.z;
        const d = a === 0 ? rx : a === 1 ? ry : rz;
        const h = a === 0 ? half.x : a === 1 ? half.y : half.z;
        const lo = (a === 0 ? b.min.x : a === 1 ? b.min.y : b.min.z) - h;
        const hi = (a === 0 ? b.max.x : a === 1 ? b.max.y : b.max.z) + h;
        if (Math.abs(d) < 1e-12) {
          if (o <= lo || o >= hi) {
            miss = true;
            break;
          }
          continue;
        }
        let t1 = (lo - o) / d;
        let t2 = (hi - o) / d;
        let s = -1;
        if (t1 > t2) {
          const tmp = t1;
          t1 = t2;
          t2 = tmp;
          s = 1;
        }
        if (t1 > tEnter) {
          tEnter = t1;
          axis = a;
          sign = s;
        }
        if (t2 < tExit) tExit = t2;
        if (tEnter >= tExit) {
          miss = true;
          break;
        }
      }
      if (miss || axis < 0) continue;
      if (tEnter < -1e-9) continue;
      if (tEnter < bestT) {
        bestT = tEnter;
        bestAxis = axis;
        bestSign = sign;
      }
    }
    if (bestAxis < 0 || bestT > 1) {
      center.x += rx;
      center.y += ry;
      center.z += rz;
      break;
    }
    const t = Math.max(0, bestT - SKIN / len);
    center.x += rx * t;
    center.y += ry * t;
    center.z += rz * t;
    const rest = 1 - t;
    rx *= rest;
    ry *= rest;
    rz *= rest;
    if (bestAxis === 0) {
      rx = 0;
      out.nx = bestSign;
    } else if (bestAxis === 1) {
      ry = 0;
      out.ny = bestSign;
    } else {
      rz = 0;
      out.nz = bestSign;
    }
  }
  return out;
}

function legacyOverlapsBox(boxes: LegacyBox[], center: V3, half: V3): boolean {
  for (const b of boxes) {
    if (!b.active) continue;
    if (
      center.x + half.x > b.min.x &&
      center.x - half.x < b.max.x &&
      center.y + half.y > b.min.y &&
      center.y - half.y < b.max.y &&
      center.z + half.z > b.min.z &&
      center.z - half.z < b.max.z
    ) {
      return true;
    }
  }
  return false;
}

function legacyProbeGround(boxes: LegacyBox[], center: V3, half: V3, maxDist: number): number {
  let best = Infinity;
  const bottom = center.y - half.y;
  for (const b of boxes) {
    if (!b.active) continue;
    if (center.x + half.x <= b.min.x || center.x - half.x >= b.max.x) continue;
    if (center.z + half.z <= b.min.z || center.z - half.z >= b.max.z) continue;
    const gap = bottom - b.max.y;
    if (gap < -1e-6 || gap > maxDist) continue;
    if (gap < best) best = Math.max(0, gap);
  }
  return best;
}

// ───────────────────────────── scene generators ─────────────────────────────

interface Scene {
  stage: StageDef;
  barrierIds: string[];
  /** Region the queries are drawn from. */
  ex: number;
  ez: number;
}

/**
 * Random float scene: small / tiny / wall / slab / pillar / huge boxes, a share of them closable barriers
 * (two ids own two boxes each), plus boxes split into two abutting halves (exact seams).
 * With `open` the wide slabs and huge boxes are left out and a single ground slab is added instead;
 * `huge` is the share of boxes that are larger than the whole query region (default 1 %).
 */
function randomScene(rng: Rng, n: number, ex: number, ez: number, opts: { open?: boolean; huge?: number } = {}): Scene {
  const open = opts.open ?? false;
  const hugeShare = opts.huge ?? 0.01;
  const solids: Box[] = [];
  const barriers: BarrierSpec[] = [];
  const barrierIds: string[] = [];
  const mk = (): Box => {
    // `open`: no slabs / huge boxes, so that plenty of free space remains for a moving box
    const kind = open ? rng.next() * 0.93 : rng.next();
    let sx: number;
    let sy: number;
    let sz: number;
    if (kind < 0.52) {
      sx = rng.range(0.3, 6);
      sy = rng.range(0.3, 6);
      sz = rng.range(0.3, 6);
    } else if (kind < 0.64) {
      sx = rng.range(0.005, 0.2);
      sy = rng.range(0.005, 0.2);
      sz = rng.range(0.005, 0.2);
    } else if (kind < 0.82) {
      const long = rng.range(8, 60);
      const thin = rng.range(0.2, 1);
      sy = rng.range(2, 12);
      if (rng.next() < 0.5) {
        sx = long;
        sz = thin;
      } else {
        sx = thin;
        sz = long;
      }
    } else if (kind < 0.93) {
      sx = rng.range(0.5, 2);
      sz = rng.range(0.5, 2);
      sy = rng.range(10, 40);
    } else if (kind < 1 - hugeShare) {
      sx = rng.range(15, 90);
      sz = rng.range(15, 90);
      sy = rng.range(0.2, 1);
    } else {
      sx = rng.range(150, 900);
      sz = rng.range(150, 900);
      sy = rng.next() < 0.8 ? rng.range(0.5, 2) : rng.range(5, 15);
    }
    const cx = rng.range(-ex, ex);
    const cy = rng.range(-5, 40);
    const cz = rng.range(-ez, ez);
    return bx(cx - sx / 2, cy - sy / 2, cz - sz / 2, cx + sx / 2, cy + sy / 2, cz + sz / 2);
  };
  let nextBarrier = 0;
  if (open) solids.push(bx(-ex * 2, -9, -ez * 2, ex * 2, -8, ez * 2));
  while (solids.length + barriers.length < n) {
    const b = mk();
    const roll = rng.next();
    if (roll < 0.08) {
      const id = `B${nextBarrier++}`;
      barrierIds.push(id);
      barriers.push({ id, box: b });
    } else if (roll < 0.2) {
      // split into two abutting halves along a random axis: an exact seam
      const axis = rng.int(3);
      const key = axis === 0 ? 'x' : axis === 1 ? 'y' : 'z';
      const cut = b.min[key] + (b.max[key] - b.min[key]) * rng.range(0.2, 0.8);
      const first: Box = { min: { ...b.min }, max: { ...b.max } };
      const second: Box = { min: { ...b.min }, max: { ...b.max } };
      first.max[key] = cut;
      second.min[key] = cut;
      solids.push(first);
      if (rng.next() < 0.3) {
        const id = `B${nextBarrier++}`;
        barrierIds.push(id);
        barriers.push({ id, box: second });
      } else {
        solids.push(second);
      }
    } else {
      solids.push(b);
    }
  }
  // two ids that own two boxes each
  for (let k = 0; k < 2 && barrierIds.length > 0; k++) barriers.push({ id: barrierIds[k % barrierIds.length], box: mk() });
  return { stage: stageOf(solids, barriers, mk()), barrierIds, ex, ez };
}

/** Lattice scene: every coordinate is an integer, boxes touch and overlap a lot; a tiled floor with seams. */
function latticeScene(rng: Rng, n: number): Scene {
  const solids: Box[] = [];
  const barriers: BarrierSpec[] = [];
  const barrierIds: string[] = [];
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) solids.push(bx(i * 6, -1, j * 6, i * 6 + 6, 0, j * 6 + 6));
  let nextBarrier = 0;
  for (let k = 0; k < n; k++) {
    const x0 = rng.int(22);
    const y0 = rng.int(7);
    const z0 = rng.int(22);
    const b = bx(x0, y0, z0, x0 + 1 + rng.int(5), y0 + 1 + rng.int(3), z0 + 1 + rng.int(5));
    if (rng.next() < 0.15) {
      const id = `B${nextBarrier++}`;
      barrierIds.push(id);
      barriers.push({ id, box: b });
    } else {
      solids.push(b);
    }
  }
  return { stage: stageOf(solids, barriers, bx(10, 0, 10, 12, 2, 12)), barrierIds, ex: 24, ez: 24 };
}

function randomUnit(rng: Rng): V3 {
  for (;;) {
    const x = rng.range(-1, 1);
    const y = rng.range(-1, 1);
    const z = rng.range(-1, 1);
    const l = Math.hypot(x, y, z);
    if (l > 0.05 && l <= 1) return v3(x / l, y / l, z / l);
  }
}

function randomPoint(rng: Rng, s: Scene): V3 {
  const m = rng.next() < 0.1 ? 1.6 : 1.05;
  return v3(rng.range(-s.ex * m, s.ex * m), rng.range(-8, 44), rng.range(-s.ez * m, s.ez * m));
}

/** World + reference built from the same stage, with helpers that keep their barrier state in sync. */
class Pair {
  readonly world: World;
  readonly ref: RefWorld;
  readonly scene: Scene;

  constructor(scene: Scene, opts: WorldOptions = {}) {
    this.scene = scene;
    this.world = new World(scene.stage, opts);
    this.ref = new RefWorld(scene.stage);
  }

  toggleRandom(rng: Rng): void {
    const ids = [...this.scene.barrierIds, 'GATE'];
    const roll = rng.next();
    if (roll < 0.1) {
      this.world.resetBarriers();
      this.ref.resetBarriers();
      return;
    }
    const count = 1 + rng.int(4);
    for (let k = 0; k < count; k++) {
      const id = ids[rng.int(ids.length)];
      const open = rng.next() < 0.5;
      if (roll < 0.25) {
        // toggling `active` on the boxes directly is part of the contract as well
        for (const b of this.world.boxes) if (b.barrierId === id) b.active = !open;
      } else {
        this.world.setBarrierOpen(id, open);
      }
      this.ref.setBarrierOpen(id, open);
    }
  }

  checkBarrierState(): void {
    for (let i = 0; i < this.ref.boxes.length; i++) {
      if (this.world.boxes[i].active !== this.ref.boxes[i].active) fail(`barrier state differs at box ${i}`);
    }
  }

  checkRay(o: V3, d: V3, maxDist: number, scratch?: RayHit): boolean {
    const w = this.world.raycast(o, d, maxDist, scratch);
    const r = this.ref.raycast(o, d, maxDist);
    const ctx = (): string => `ray o=${fmt(o)} d=${fmt(d)} max=${maxDist}`;
    if ((w === null) !== (r === null)) fail(`${ctx()}: world ${w ? `hit ${w.dist}` : 'null'} vs ref ${r ? `hit ${r.dist} box ${r.idx}` : 'null'}`);
    if (!w || !r) return false;
    if (!near(w.dist, r.dist)) fail(`${ctx()}: dist ${w.dist} vs ${r.dist}`);
    if (!(w.dist >= 0) || Object.is(w.dist, -0)) fail(`${ctx()}: bad dist ${w.dist}`);
    if (this.world.boxes[r.idx] !== w.box) fail(`${ctx()}: box ${this.world.boxes.indexOf(w.box)} vs ${r.idx} at dist ${w.dist}`);
    if (w.normal.x !== r.normal[0] || w.normal.y !== r.normal[1] || w.normal.z !== r.normal[2]) {
      fail(`${ctx()}: normal ${fmt(w.normal)} vs (${r.normal.join(', ')})`);
    }
    if (!near(w.point.x, o.x + d.x * r.dist) || !near(w.point.y, o.y + d.y * r.dist) || !near(w.point.z, o.z + d.z * r.dist)) {
      fail(`${ctx()}: point ${fmt(w.point)}`);
    }
    return true;
  }

  checkSegment(a: V3, b: V3): boolean {
    const w = this.world.segmentBlocked(a, b);
    const r = this.ref.segmentBlocked(a, b);
    if (w !== r) fail(`segment a=${fmt(a)} b=${fmt(b)}: world ${w} vs ref ${r}`);
    return w;
  }

  checkOverlap(c: V3, h: V3): boolean {
    const w = this.world.overlapsBox(c, h);
    const r = this.ref.overlapsBox(c, h);
    if (w !== r) fail(`overlap c=${fmt(c)} h=${fmt(h)}: world ${w} vs ref ${r}`);
    return w;
  }

  checkRegion(min: V3, max: V3, out: WorldBox[]): number {
    const w = this.world.boxesInAabb(min, max, out);
    const r = this.ref.boxesInAabb(min, max);
    if (w !== out) fail('boxesInAabb must return the array it was given');
    if (w.length !== r.length) fail(`region min=${fmt(min)} max=${fmt(max)}: ${w.length} boxes vs ${r.length}`);
    for (let k = 0; k < r.length; k++) if (w[k] !== this.world.boxes[r[k]]) fail(`region min=${fmt(min)} max=${fmt(max)}: entry ${k} differs`);
    return w.length;
  }

  /** Moves a copy of `c` in both; returns the world's result position and normals. */
  checkMove(c: V3, h: V3, d: V3, res: MoveResult): V3 {
    const cw = { ...c };
    const cr = { ...c };
    const w = this.world.moveBox(cw, h, d, res);
    const r = this.ref.moveBox(cr, h, d);
    const ctx = (): string => `move c=${fmt(c)} h=${fmt(h)} d=${fmt(d)}`;
    if (w !== res) fail('moveBox must return the result object it was given');
    if (!near(cw.x, cr.x) || !near(cw.y, cr.y) || !near(cw.z, cr.z)) fail(`${ctx()}: end ${fmt(cw)} vs ${fmt(cr)}`);
    if (w.nx !== r.nx || w.ny !== r.ny || w.nz !== r.nz) fail(`${ctx()}: normals (${w.nx}, ${w.ny}, ${w.nz}) vs (${r.nx}, ${r.ny}, ${r.nz})`);
    if (!Number.isFinite(cw.x + cw.y + cw.z)) fail(`${ctx()}: non-finite result ${fmt(cw)}`);
    return cw;
  }

  checkProbe(c: V3, h: V3, maxDist: number): number {
    const w = this.world.probeGround(c, h, maxDist);
    const r = this.ref.probeGround(c, h, maxDist);
    if (!near(w, r)) fail(`probe c=${fmt(c)} h=${fmt(h)} max=${maxDist}: ${w} vs ${r}`);
    return w;
  }
}

// ───────────────────────────── 5. targeted cases ─────────────────────────────

describe('World — construction and spatial index', () => {
  it('keeps the box order (solids, barriers, final gate) and freezes the geometry', () => {
    const w = worldOf([bx(0, 0, 0, 1, 1, 1), bx(5, 0, 0, 3, 2, 1)], [{ id: 'B1', box: bx(10, 0, 0, 11, 4, 4) }]);
    expect(w.boxes.length).toBe(4);
    expect(w.boxes.map((b) => b.barrierId)).toEqual([null, null, 'B1', 'GATE']);
    expect(w.boxes.map((b) => b.active)).toEqual([true, true, true, true]);
    // an inverted definition describes the same region
    expect(w.boxes[1].min).toEqual({ x: 3, y: 0, z: 0 });
    expect(w.boxes[1].max).toEqual({ x: 5, y: 2, z: 1 });
    expect(w.overlapsBox(v3(4, 1, 0.5), v3(0.1, 0.1, 0.1))).toBe(true);
    // geometry is immutable; only `active` may change
    expect(() => {
      w.boxes[0].max.y = 10;
    }).toThrow();
    expect(() => {
      w.boxes.push(w.boxes[0]);
    }).toThrow();
    w.boxes[0].active = false;
    expect(w.overlapsBox(v3(0.5, 0.5, 0.5), v3(0.1, 0.1, 0.1))).toBe(false);
  });

  it('does not copy stage boxes by reference', () => {
    const solid = bx(0, 0, 0, 1, 1, 1);
    const stage = stageOf([solid]);
    const w = new World(stage);
    expect(w.boxes[0].min).not.toBe(stage.solids[0].min);
    expect(Object.isFrozen(stage.solids[0].min)).toBe(false);
  });

  it('keeps huge slabs out of the grid cells and the index small', () => {
    const w = new World(makeTestStage({ solids: [{ min: v3(3, 0, 3), max: v3(5, 2, 5), material: 'wall' }] }));
    const g = w.getGridInfo();
    expect(g.cellSize).toBe(8);
    expect(g.largeBoxes).toBe(1); // the 800 m floor slab
    expect(g.griddedBoxes).toBe(2);
    expect(g.entries).toBeLessThanOrEqual(8);
    expect(g.nx * g.nz).toBeLessThanOrEqual(1 << 18);
    // the slab still collides everywhere
    expect(w.raycast(v3(-390, 5, 390), v3(0, -1, 0), 10)?.dist).toBe(5);
    expect(w.overlapsBox(v3(200, 0.5, -300), v3(1, 1, 1))).toBe(true);
    expect(w.probeGround(v3(-399, 2.5, 0), PLAYER_HALF, 1)).toBeCloseTo(0.5, 12);
  });

  it('bounds the number of grid entries however many big boxes there are', () => {
    const rng = new Rng(11);
    const solids: Box[] = [];
    for (let i = 0; i < 3000; i++) {
      const x = rng.range(-200, 200);
      const z = rng.range(-200, 200);
      const y = rng.range(0, 300);
      solids.push(bx(x - 125, y, z - 125, x + 125, y + 0.05, z + 125));
    }
    const stage = stageOf(solids);
    const w = new World(stage);
    const g = w.getGridInfo();
    expect(g.entries).toBeLessThanOrEqual(1 << 21);
    expect(g.griddedBoxes + g.largeBoxes).toBe(3001);
    const pair = new Pair({ stage, barrierIds: [], ex: 300, ez: 300 });
    const out: WorldBox[] = [];
    const res: MoveResult = { nx: 0, ny: 0, nz: 0 };
    for (let k = 0; k < 150; k++) {
      const o = v3(rng.range(-350, 350), rng.range(-5, 305), rng.range(-350, 350));
      pair.checkRay(o, randomUnit(rng), 200);
      pair.checkOverlap(o, v3(1, 1, 1));
      pair.checkRegion(v3(o.x - 3, o.y - 3, o.z - 3), v3(o.x + 3, o.y + 3, o.z + 3), out);
      pair.checkMove(o, v3(0.5, 0.5, 0.5), v3(rng.range(-5, 5), rng.range(-5, 5), rng.range(-5, 5)), res);
      pair.checkProbe(o, v3(0.5, 0.5, 0.5), 20);
    }
  });

  it('enlarges the cells instead of allocating a giant grid for enormous extents', () => {
    const solids = [bx(-1e7, 0, -1e7, -1e7 + 4, 4, -1e7 + 4), bx(1e7 - 4, 0, 1e7 - 4, 1e7, 4, 1e7), bx(-2, 0, -2, 2, 4, 2)];
    const stage = stageOf(solids);
    const w = new World(stage);
    const g = w.getGridInfo();
    expect(g.nx * g.nz).toBeLessThanOrEqual(1 << 18);
    expect(g.cellSize).toBeGreaterThan(8);
    expect(w.raycast(v3(-100, 2, 0), v3(1, 0, 0), 500)?.dist).toBe(98);
    expect(w.raycast(v3(1e7 - 50, 2, 1e7 - 2), v3(1, 0, 0), 500)?.dist).toBeCloseTo(46, 6);
    expect(w.overlapsBox(v3(-1e7 + 2, 2, -1e7 + 2), v3(1, 1, 1))).toBe(true);
    expect(w.overlapsBox(v3(500, 2, 500), v3(1, 1, 1))).toBe(false);
  });

  it('handles infinite boxes and ignores boxes with NaN coordinates', () => {
    const solids = [
      bx(-Infinity, -1, -Infinity, Infinity, 0, Infinity), // infinite ground plane
      bx(NaN, 0, 0, 5, 5, 5), // broken definition: never collides
      bx(10, 0, -Infinity, 11, 6, Infinity), // infinite wall
      bx(2, 0, 2, 4, 2, 4),
    ];
    const w = worldOf(solids);
    const g = w.getGridInfo();
    expect(g.deadBoxes).toBe(1);
    expect(g.largeBoxes).toBe(2);
    expect(w.raycast(v3(1e6, 50, -1e6), v3(0, -1, 0), 100)?.dist).toBe(50);
    expect(w.raycast(v3(0, 1, 12345), v3(1, 0, 0), 100)?.dist).toBe(10);
    expect(w.raycast(v3(-3, 1, 2.5), v3(1, 0, 0), 100)?.box).toBe(w.boxes[3]); // not the NaN box
    expect(w.overlapsBox(v3(1, 3, 1), v3(0.5, 0.5, 0.5))).toBe(false);
    expect(w.overlapsBox(v3(10.5, 3, -7e5), v3(0.1, 0.1, 0.1))).toBe(true);
    const c = v3(0, 3, 0);
    const r = w.moveBox(c, v3(1, 1, 1), v3(50, -50, 0));
    expect(c.x).toBeCloseTo(9 - SKIN, 9);
    expect(c.y).toBeCloseTo(1 + SKIN, 9);
    expect(r).toEqual({ nx: -1, ny: 1, nz: 0 });
    expect(w.probeGround(v3(77777, 3, -88888), v3(1, 1, 1), 5)).toBe(2);
    for (const v of [c.x, c.y, c.z]) expect(Number.isFinite(v)).toBe(true);
  });

  it('survives the wrap-around of the per-query stamp counter', () => {
    const rng = new Rng(64);
    const pair = new Pair(randomScene(rng, 300, 40, 40));
    // jump close to the 32-bit limit; the following queries cross it
    (pair.world as unknown as { queryId: number }).queryId = 0xffffffff - 40;
    const res: MoveResult = { nx: 0, ny: 0, nz: 0 };
    const out: WorldBox[] = [];
    let hits = 0;
    for (let k = 0; k < 400; k++) {
      const o = randomPoint(rng, pair.scene);
      if (pair.checkRay(o, randomUnit(rng), 150)) hits++;
      pair.checkSegment(o, randomPoint(rng, pair.scene));
      pair.checkMove(o, PLAYER_HALF, v3(rng.range(-9, 9), rng.range(-9, 9), rng.range(-9, 9)), res);
      pair.checkRegion(v3(o.x - 4, o.y - 4, o.z - 4), v3(o.x + 4, o.y + 4, o.z + 4), out);
      pair.checkProbe(o, PLAYER_HALF, 30);
    }
    expect(hits).toBeGreaterThan(100);
    const id = (pair.world as unknown as { queryId: number }).queryId;
    expect(id).toBeGreaterThan(0);
    expect(id).toBeLessThan(5000); // wrapped
  });

  it('works for a stage whose only box is the final gate', () => {
    const w = new World(stageOf([], [], bx(0, 0, 0, 2, 2, 2)));
    expect(w.raycast(v3(-5, 1, 1), v3(1, 0, 0), 10)?.dist).toBe(5);
    expect(w.raycast(v3(-5, 3, 1), v3(1, 0, 0), 10)).toBeNull();
    w.setBarrierOpen('GATE', true);
    expect(w.raycast(v3(-5, 1, 1), v3(1, 0, 0), 10)).toBeNull();
    expect(w.overlapsBox(v3(1, 1, 1), v3(1, 1, 1))).toBe(false);
    const c = v3(-5, 1, 1);
    w.moveBox(c, v3(0.5, 0.5, 0.5), v3(10, 0, 0));
    expect(c.x).toBe(5);
  });
});

describe('World.raycast', () => {
  const cube = worldOf([bx(-1, -2, -3, 1, 2, 3)]);

  it('reports distance, point, face normal and box for each of the six faces', () => {
    const cases: Array<[V3, V3, number, V3]> = [
      [v3(-10, 0.5, 0.25), v3(1, 0, 0), 9, v3(-1, 0, 0)],
      [v3(10, 0.5, 0.25), v3(-1, 0, 0), 9, v3(1, 0, 0)],
      [v3(0.5, -10, 0.25), v3(0, 1, 0), 8, v3(0, -1, 0)],
      [v3(0.5, 10, 0.25), v3(0, -1, 0), 8, v3(0, 1, 0)],
      [v3(0.5, 0.25, -10), v3(0, 0, 1), 7, v3(0, 0, -1)],
      [v3(0.5, 0.25, 10), v3(0, 0, -1), 7, v3(0, 0, 1)],
    ];
    for (const [o, d, dist, n] of cases) {
      const hit = cube.raycast(o, d, 100);
      expect(hit).not.toBeNull();
      expect(hit!.dist).toBe(dist);
      expect(hit!.normal).toEqual(n);
      expect(hit!.point).toEqual({ x: o.x + d.x * dist, y: o.y + d.y * dist, z: o.z + d.z * dist });
      expect(hit!.box).toBe(cube.boxes[0]);
    }
  });

  it('picks the face that is entered last on oblique rays', () => {
    const s = Math.SQRT1_2;
    // towards the +x face from the upper right: enters the y slab first, then crosses x = 1
    const hit = cube.raycast(v3(4, 4, 0), v3(-s, -s, 0), 100)!;
    expect(hit.normal).toEqual({ x: 1, y: 0, z: 0 });
    expect(hit.dist).toBeCloseTo(3 / s, 12);
    expect(hit.point.x).toBeCloseTo(1, 12);
    expect(hit.point.y).toBeCloseTo(1, 12);
    // steeper: reaches the top face first
    const d = v3(-0.2, -1, 0);
    const l = Math.hypot(d.x, d.y, d.z);
    const top = cube.raycast(v3(1.5, 6, 0), v3(d.x / l, d.y / l, d.z / l), 100)!;
    expect(top.normal).toEqual({ x: 0, y: 1, z: 0 });
    expect(top.point.y).toBeCloseTo(2, 12);
  });

  it('returns dist 0 and a zero normal when starting inside a box', () => {
    for (const d of [v3(1, 0, 0), v3(0, -1, 0), randomUnit(new Rng(3))]) {
      const hit = cube.raycast(v3(0.3, -1.2, 2.5), d, 50)!;
      expect(hit.dist).toBe(0);
      expect(Object.is(hit.dist, -0)).toBe(false);
      expect(hit.normal).toEqual({ x: 0, y: 0, z: 0 });
      expect(hit.point).toEqual({ x: 0.3, y: -1.2, z: 2.5 });
    }
    // maxDist 0 still reports the box the origin is in, and nothing else
    expect(cube.raycast(v3(0, 0, 0), v3(1, 0, 0), 0)?.dist).toBe(0);
    expect(cube.raycast(v3(-1.5, 0, 0), v3(1, 0, 0), 0)).toBeNull();
  });

  it('starting exactly on a face: hit at 0 when going in, no hit when leaving', () => {
    const goingIn = cube.raycast(v3(-1, 0, 0), v3(1, 0, 0), 10)!;
    expect(goingIn.dist).toBe(0);
    expect(goingIn.normal).toEqual({ x: -1, y: 0, z: 0 });
    expect(cube.raycast(v3(-1, 0, 0), v3(-1, 0, 0), 10)).toBeNull();
    expect(cube.raycast(v3(0, 2, 0), v3(0, 1, 0), 10)).toBeNull();
    const s = Math.SQRT1_2;
    expect(cube.raycast(v3(1, 0, 0), v3(s, s, 0), 10)).toBeNull();
    expect(cube.raycast(v3(1, 0, 0), v3(-s, s, 0), 10)?.dist).toBe(0);
  });

  it('grazing rays do not hit: along a face, along an edge, through an edge or a corner', () => {
    // in the plane of a face
    expect(cube.raycast(v3(-10, 2, 0), v3(1, 0, 0), 100)).toBeNull(); // top face plane
    expect(cube.raycast(v3(-10, -2, 0), v3(1, 0, 0), 100)).toBeNull(); // bottom face plane
    expect(cube.raycast(v3(1, 0, -10), v3(0, 0, 1), 100)).toBeNull();
    expect(cube.raycast(v3(-1, -10, 1), v3(0, 1, 0), 100)).toBeNull();
    // oblique ray inside a face plane
    const s = Math.SQRT1_2;
    expect(cube.raycast(v3(-10, 2, -10), v3(s, 0, s), 100)).toBeNull();
    // along an edge
    expect(cube.raycast(v3(-10, 2, 3), v3(1, 0, 0), 100)).toBeNull();
    // touching an edge / a corner in passing (exact arithmetic: unnormalised power-of-two direction)
    expect(cube.raycast(v3(-3, 0, 0), v3(1, 1, 0), 100)).toBeNull(); // passes through the edge (-1, 2) and on outside
    expect(cube.raycast(v3(-3, 0, 1), v3(1, 1, 1), 100)).toBeNull(); // passes through the corner (-1, 2, 3)
    expect(cube.raycast(v3(-3, 4, 0), v3(1, -1, 0), 100)?.dist).toBe(2); // through the same edge INTO the box
    // a hair inside is a hit
    expect(cube.raycast(v3(-10, 2 - 1e-9, 0), v3(1, 0, 0), 100)?.dist).toBe(9);
    expect(cube.raycast(v3(-3, -1e-6, 0), v3(1, 1, 0), 100)).not.toBeNull();
  });

  it('a ray along a floor surface is free until it runs into the foot of a wall standing on that floor', () => {
    const solids = [bx(-50, -1, -50, 50, 0, 50), bx(10, 0, -5, 11, 6, 5)];
    const w = worldOf(solids);
    expect(w.raycast(v3(-20, 0, 0), v3(1, 0, 0), 25)).toBeNull(); // stops short of the wall
    expect(w.raycast(v3(-20, 0, 20), v3(1, 0, 0), 100)).toBeNull(); // passes beside the wall
    // floor top = wall bottom: at the wall the plane y = 0 is a seam with solid matter on both sides
    const foot = w.raycast(v3(-20, 0, 0), v3(1, 0, 0), 100)!;
    expect(foot.dist).toBe(30);
    expect(foot.box).toBe(w.boxes[1]);
    expect(foot.normal).toEqual({ x: -1, y: 0, z: 0 });
    expect(w.raycast(v3(-20, 1e-9, 0), v3(1, 0, 0), 100)?.dist).toBe(30);
    // the previous implementation let a ray at exactly floor height pass under every wall
    expect(legacyRaycast(legacyBoxes(stageOf(solids)), v3(-20, 0, 0), v3(1, 0, 0), 100)).toBeNull();
    expect(w.raycast(v3(10, 3, -20), v3(0, 0, 1), 100)).toBeNull(); // along the wall face
    expect(w.raycast(v3(10, 0, -20), v3(0, 0, 1), 100)).toBeNull(); // along the wall/floor edge (air on one side)
    expect(w.raycast(v3(10.5, 0, -20), v3(0, 0, 1), 100)?.dist).toBe(15); // under the wall: solid all around
  });

  it('a ray inside the seam between two abutting boxes is blocked (no leak through a split wall)', () => {
    // one wall built from two halves that meet at x = 0, plus a floor
    const solids = [bx(-50, -1, -50, 50, 0, 50), bx(-4, 0, 10, 0, 5, 10.5), bx(0, 0, 10, 4, 5, 10.5)];
    const w = worldOf(solids);
    const hit = w.raycast(v3(0, 2, 0), v3(0, 0, 1), 100)!;
    expect(hit).not.toBeNull();
    expect(hit.dist).toBe(10);
    expect(hit.normal).toEqual({ x: 0, y: 0, z: -1 });
    expect(hit.box === w.boxes[1] || hit.box === w.boxes[2]).toBe(true);
    expect(w.segmentBlocked(v3(0, 2, 0), v3(0, 2, 30))).toBe(true);
    expect(w.segmentBlocked(v3(0, 2, 30), v3(0, 2, 0))).toBe(true);
    // the previous implementation let exactly this ray through
    expect(legacyRaycast(legacyBoxes(stageOf(solids)), v3(0, 2, 0), v3(0, 0, 1), 100)).toBeNull();
    // oblique inside the seam plane
    const l = Math.hypot(1, 3);
    expect(w.raycast(v3(0, 1, 0), v3(0, 1 / l, 3 / l), 100)?.dist).toBeCloseTo((10 * l) / 3, 12);
    // starting inside the seam, inside the wall
    const inside = w.raycast(v3(0, 2, 10.25), v3(0, 0, 1), 100)!;
    expect(inside.dist).toBe(0);
    expect(inside.normal).toEqual({ x: 0, y: 0, z: 0 });
    // seam between stacked boxes, horizontal ray at the seam height
    const stacked = worldOf([bx(5, 0, -3, 6, 2, 3), bx(5, 2, -3, 6, 4, 3)]);
    expect(stacked.raycast(v3(0, 2, 0), v3(1, 0, 0), 100)?.dist).toBe(5);
    // vertical ray through the point where four floor tiles meet
    const tiles = worldOf([bx(-5, -1, -5, 0, 0, 0), bx(0, -1, -5, 5, 0, 0), bx(-5, -1, 0, 0, 0, 5), bx(0, -1, 0, 5, 0, 5)]);
    expect(tiles.raycast(v3(0, 3, 0), v3(0, -1, 0), 100)?.dist).toBe(3);
    expect(tiles.raycast(v3(0, 3, 2), v3(0, -1, 0), 100)?.dist).toBe(3);
    // with one of the four tiles missing the same ray grazes the inner corner and is free
    const three = worldOf([bx(-5, -1, -5, 0, 0, 0), bx(0, -1, -5, 5, 0, 0), bx(-5, -1, 0, 0, 0, 5)]);
    expect(three.raycast(v3(0, 3, 0), v3(0, -1, 0), 100)).toBeNull();
  });

  it('a seam is only solid while both sides are: opening one half turns the ray into a grazing ray', () => {
    const w = worldOf([bx(-4, 0, 10, 0, 5, 10.5)], [{ id: 'B1', box: bx(0, 0, 10, 4, 5, 10.5) }]);
    expect(w.raycast(v3(0, 2, 0), v3(0, 0, 1), 100)?.dist).toBe(10);
    w.setBarrierOpen('B1', true);
    expect(w.raycast(v3(0, 2, 0), v3(0, 0, 1), 100)).toBeNull();
    expect(w.segmentBlocked(v3(0, 2, 0), v3(0, 2, 30))).toBe(false);
    w.resetBarriers();
    expect(w.segmentBlocked(v3(0, 2, 0), v3(0, 2, 30))).toBe(true);
  });

  it('a seam ray is stopped by the first place where both sides are solid, not before', () => {
    // pillars alternate on the two sides of the plane x = 0; only at z = 40 do both sides have one
    const solids = [
      bx(0, 0, 10, 2, 5, 12), // +x side only
      bx(-2, 0, 20, 0, 5, 22), // -x side only
      bx(0, 0, 30, 2, 5, 32), // +x side only
      bx(-2, 0, 40, 0, 5, 42),
      bx(0, 0, 41, 2, 5, 43), // both sides solid from z = 41
    ];
    const w = worldOf(solids);
    const hit = w.raycast(v3(0, 2, 0), v3(0, 0, 1), 100)!;
    expect(hit.dist).toBe(41);
    expect(hit.box).toBe(w.boxes[4]);
    expect(hit.normal).toEqual({ x: 0, y: 0, z: -1 });
    expect(w.raycast(v3(0, 2, 0), v3(0, 0, 1), 40.5)).toBeNull();
    expect(w.segmentBlocked(v3(0, 2, 0), v3(0, 2, 41))).toBe(false);
    expect(w.segmentBlocked(v3(0, 2, 0), v3(0, 2, 41.5))).toBe(true);
  });

  it('respects maxDist: a hit at exactly maxDist counts, anything beyond does not', () => {
    expect(cube.raycast(v3(-10, 0, 0), v3(1, 0, 0), 9)?.dist).toBe(9);
    expect(cube.raycast(v3(-10, 0, 0), v3(1, 0, 0), 8.999999)).toBeNull();
    expect(cube.raycast(v3(-10, 0, 0), v3(1, 0, 0), Infinity)?.dist).toBe(9);
    expect(cube.raycast(v3(-10, 0, 0), v3(-1, 0, 0), Infinity)).toBeNull();
    expect(cube.raycast(v3(-1e5, 0, 0), v3(1, 0, 0), Infinity)?.dist).toBe(99999);
  });

  it('resolves equal distances by the lowest box index and returns the nearest box otherwise', () => {
    // two coplanar overlapping boxes: same distance
    const w = worldOf([bx(5, 0, -1, 6, 4, 3), bx(5, 0, -3, 7, 4, 1), bx(20, 0, -5, 21, 4, 5)]);
    expect(w.raycast(v3(0, 1, 0), v3(1, 0, 0), 100)?.box).toBe(w.boxes[0]);
    const flipped = worldOf([bx(20, 0, -5, 21, 4, 5), bx(5, 0, -3, 7, 4, 1), bx(5, 0, -1, 6, 4, 3)]);
    expect(flipped.raycast(v3(0, 1, 0), v3(1, 0, 0), 100)?.box).toBe(flipped.boxes[1]);
    expect(flipped.raycast(v3(0, 1, 2), v3(1, 0, 0), 100)?.box).toBe(flipped.boxes[2]);
    expect(flipped.raycast(v3(0, 1, 4), v3(1, 0, 0), 100)?.box).toBe(flipped.boxes[0]);
  });

  it('finds hits across many grid cells, from outside the grid and for vertical rays', () => {
    const w = worldOf([bx(100, 0, 100, 101, 10, 101), bx(-80, 20, -80, -70, 21, -70)]);
    const d = v3(1, 0, 1);
    const hit = w.raycast(v3(-49.5, 5, -49.5), v3(d.x / Math.SQRT2, 0, d.z / Math.SQRT2), 400)!;
    expect(hit.dist).toBeCloseTo(149.5 * Math.SQRT2, 9);
    expect(w.raycast(v3(-5000, 5, 100.5), v3(1, 0, 0), 1e5)?.dist).toBe(5100);
    expect(w.raycast(v3(-5000, 5, 100.5), v3(1, 0, 0), 5099)).toBeNull();
    expect(w.raycast(v3(-75, 500, -75), v3(0, -1, 0), 1000)?.dist).toBe(479);
    expect(w.raycast(v3(-75, -500, -75), v3(0, 1, 0), 1000)?.dist).toBe(520);
    expect(w.raycast(v3(-75, 500, -65), v3(0, -1, 0), 1000)).toBeNull();
  });

  it('fills a caller-provided result object instead of allocating', () => {
    const out: RayHit = { dist: -1, point: v3(), normal: v3(9, 9, 9), box: cube.boxes[0] };
    const point = out.point;
    const hit = cube.raycast(v3(0, 10, 0), v3(0, -1, 0), 100, out);
    expect(hit).toBe(out);
    expect(out.point).toBe(point);
    expect(out.dist).toBe(8);
    expect(out.normal).toEqual({ x: 0, y: 1, z: 0 });
    expect(cube.raycast(v3(0, 10, 0), v3(0, 1, 0), 100, out)).toBeNull();
  });

  it('never returns NaN: invalid input yields null', () => {
    expect(cube.raycast(v3(NaN, 0, 0), v3(1, 0, 0), 10)).toBeNull();
    expect(cube.raycast(v3(0, 0, 0), v3(NaN, 0, 0), 10)).toBeNull();
    expect(cube.raycast(v3(0, 0, 0), v3(1, 0, 0), NaN)).toBeNull();
    expect(cube.raycast(v3(0, 0, 0), v3(1, 0, 0), -1)).toBeNull();
    expect(cube.raycast(v3(Infinity, 0, 0), v3(-1, 0, 0), 10)).toBeNull();
    // a zero direction is a point query
    expect(cube.raycast(v3(0, 0, 0), v3(0, 0, 0), 10)?.dist).toBe(0);
    expect(cube.raycast(v3(5, 0, 0), v3(0, 0, 0), 10)).toBeNull();
    expect(cube.raycast(v3(1, 0, 0), v3(0, 0, 0), Infinity)).toBeNull();
  });
});

describe('World.segmentBlocked', () => {
  const w = worldOf([bx(-50, -1, -50, 50, 0, 50), bx(10, 0, -5, 10.5, 6, 5)]);

  it('detects walls between the end points and nothing else', () => {
    expect(w.segmentBlocked(v3(0, 2, 0), v3(20, 2, 0))).toBe(true);
    expect(w.segmentBlocked(v3(20, 2, 0), v3(0, 2, 0))).toBe(true);
    expect(w.segmentBlocked(v3(0, 2, 0), v3(9.99, 2, 0))).toBe(false);
    expect(w.segmentBlocked(v3(0, 2, 0), v3(20, 2, 30))).toBe(false); // passes beside the wall
    expect(w.segmentBlocked(v3(0, 2, 0), v3(20, 12, 0))).toBe(false); // passes over it (y = 7 at the wall)
    expect(w.segmentBlocked(v3(0, 2, 0), v3(20, 9.9, 0))).toBe(true); // clips its top corner (y = 5.95 at x = 10)
    expect(w.segmentBlocked(v3(0, 2, 0), v3(0, -3, 0))).toBe(true); // through the floor
    expect(w.segmentBlocked(v3(10.2, 1, 0), v3(10.3, 2, 1))).toBe(true); // entirely inside the wall
    expect(w.segmentBlocked(v3(10.2, 1, 0), v3(30, 2, 1))).toBe(true); // starts inside
  });

  it('a zero-length segment is never blocked', () => {
    expect(w.segmentBlocked(v3(3, 2, 3), v3(3, 2, 3))).toBe(false);
    expect(w.segmentBlocked(v3(10.2, 1, 0), v3(10.2, 1, 0))).toBe(false); // even inside a wall
    expect(w.segmentBlocked(v3(10.2, 1, 0), v3(10.2 + 1e-10, 1, 0))).toBe(false);
    expect(w.segmentBlocked(v3(10.2, 1, 0), v3(10.2 + 1e-8, 1, 0))).toBe(true);
  });

  it('an end point that only touches a surface is not blocked, in either direction', () => {
    expect(w.segmentBlocked(v3(0, 2, 0), v3(10, 2, 0))).toBe(false); // ends on the wall face
    expect(w.segmentBlocked(v3(10, 2, 0), v3(0, 2, 0))).toBe(false);
    expect(w.segmentBlocked(v3(3, 5, 3), v3(4, 0, 2))).toBe(false); // ends on the floor
    expect(w.segmentBlocked(v3(4, 0, 2), v3(3, 5, 3))).toBe(false);
    expect(w.segmentBlocked(v3(0, 2, 0), v3(10 + 1e-7, 2, 0))).toBe(true);
    expect(w.segmentBlocked(v3(3, 5, 3), v3(4, -1e-7, 2))).toBe(true);
    // lying on the floor surface
    expect(w.segmentBlocked(v3(-5, 0, 3), v3(9, 0, -2))).toBe(false);
  });

  it('never throws or blocks on invalid input', () => {
    expect(w.segmentBlocked(v3(NaN, 0, 0), v3(1, 1, 1))).toBe(false);
    expect(w.segmentBlocked(v3(0, 2, 0), v3(Infinity, 2, 0))).toBe(false);
  });
});

describe('World.overlapsBox / boxesInAabb', () => {
  const w = worldOf([bx(0, 0, 0, 4, 2, 4), bx(4, 0, 0, 8, 6, 4)], [{ id: 'B1', box: bx(0, 2, 0, 4, 3, 4) }]);

  it('touching faces, edges and corners are not an overlap', () => {
    expect(w.overlapsBox(v3(2, 4, 2), v3(1, 1, 1))).toBe(false); // rests on the barrier top (y = 3)
    expect(w.overlapsBox(v3(2, 3.999999, 2), v3(1, 1, 1))).toBe(true);
    expect(w.overlapsBox(v3(-1, 1, 2), v3(1, 1, 1))).toBe(false); // face to face at x = 0
    expect(w.overlapsBox(v3(-1, -1, 2), v3(1, 1, 1))).toBe(false); // edge to edge
    expect(w.overlapsBox(v3(-1, -1, -1), v3(1, 1, 1))).toBe(false); // corner to corner
    expect(w.overlapsBox(v3(-1 + 1e-9, 1, 2), v3(1, 1, 1))).toBe(true);
    expect(w.overlapsBox(v3(2, 1, 2), v3(0.1, 0.1, 0.1))).toBe(true); // fully inside
    expect(w.overlapsBox(v3(4, 3, 2), v3(100, 100, 100))).toBe(true); // fully containing
    expect(w.overlapsBox(v3(20, 1, 2), v3(1, 1, 1))).toBe(false);
    expect(w.overlapsBox(v3(NaN, 1, 2), v3(1, 1, 1))).toBe(false);
  });

  it('boxesInAabb returns the active overlapping boxes in index order and reuses the array', () => {
    const out: WorldBox[] = [w.boxes[0]];
    expect(w.boxesInAabb(v3(-100, -100, -100), v3(100, 100, 100), out)).toBe(out);
    expect(out).toEqual([w.boxes[0], w.boxes[1], w.boxes[2]]);
    w.boxesInAabb(v3(3, 0.5, 1), v3(5, 1.5, 3), out);
    expect(out).toEqual([w.boxes[0], w.boxes[1]]);
    w.boxesInAabb(v3(1, 2, 1), v3(3, 2.5, 3), out); // touches box 0 from above, inside the barrier
    expect(out).toEqual([w.boxes[2]]);
    w.setBarrierOpen('B1', true);
    w.boxesInAabb(v3(1, 2, 1), v3(3, 2.5, 3), out);
    expect(out).toEqual([]);
    w.boxesInAabb(v3(-Infinity, -Infinity, -Infinity), v3(Infinity, Infinity, Infinity), out);
    expect(out).toEqual([w.boxes[0], w.boxes[1], w.boxes[3]]); // everything active, the gate included
    w.resetBarriers();
    w.boxesInAabb(v3(NaN, 0, 0), v3(1, 1, 1), out);
    expect(out).toEqual([]);
  });
});

describe('World.moveBox — targeted cases', () => {
  const H = PLAYER_HALF;

  /** A 100 m long floor made of 5 m tiles (seams every 5 m), top at y = 0. */
  function tiledFloor(): Box[] {
    const tiles: Box[] = [];
    for (let i = -10; i < 10; i++) for (let j = -2; j < 2; j++) tiles.push(bx(i * 5, -1, j * 5, i * 5 + 5, 0, j * 5 + 5));
    return tiles;
  }

  it('free movement applies the whole delta and reports no contact', () => {
    const w = worldOf(tiledFloor());
    const c = v3(0, 10, 0);
    const res = w.moveBox(c, H, v3(3, 2, -4));
    expect(c).toEqual({ x: 3, y: 12, z: -4 });
    expect(res).toEqual({ nx: 0, ny: 0, nz: 0 });
  });

  it('lands on a floor SKIN above it and reports ny = +1', () => {
    const w = worldOf(tiledFloor());
    const c = v3(1, 12, 1);
    const res = w.moveBox(c, H, v3(0, -30, 0));
    expect(res).toEqual({ nx: 0, ny: 1, nz: 0 });
    expect(c.y).toBeCloseTo(2 + SKIN, 12);
    expect(c.x).toBe(1);
    expect(w.probeGround(c, H, 0.05)).toBeCloseTo(SKIN, 12);
    expect(w.overlapsBox(c, H)).toBe(false);
    // diagonal landing: the gap is SKIN along the normal whatever the approach angle, x keeps its full motion
    const d = v3(-40, 12, 0);
    const r2 = w.moveBox(d, H, v3(60, -10.5, 0));
    expect(r2.ny).toBe(1);
    expect(d.y).toBeCloseTo(2 + SKIN, 12);
    expect(d.x).toBeCloseTo(20, 9);
  });

  it('lands on a small platform and falls past it when not above it', () => {
    const w = worldOf([...tiledFloor(), bx(10, 7.5, -2, 14, 8, 2)]);
    const c = v3(12, 20, 0);
    expect(w.moveBox(c, H, v3(0, -30, 0)).ny).toBe(1);
    expect(c.y).toBeCloseTo(10 + SKIN, 12);
    // only touching the platform's side face in x: falls to the floor
    const d = v3(10 - 1.3, 20, 0);
    expect(w.moveBox(d, H, v3(0, -30, 0)).ny).toBe(1);
    expect(d.y).toBeCloseTo(2 + SKIN, 12);
    // overlapping the platform footprint by 1 mm: lands on it
    const e = v3(10 - 1.3 + 1e-3, 20, 0);
    w.moveBox(e, H, v3(0, -30, 0));
    expect(e.y).toBeCloseTo(10 + SKIN, 12);
  });

  it('rests on a tiled floor and slides across the seams without sticking', () => {
    const w = worldOf(tiledFloor());
    const c = v3(-45, 2 + SKIN, 0.3);
    const res: MoveResult = { nx: 0, ny: 0, nz: 0 };
    let x = c.x;
    // one tick at glide speed with the gravity term of a tick: 400 ticks ≈ 73 m across 14 seams
    for (let i = 0; i < 400; i++) {
      w.moveBox(c, H, v3(22 / 120, -9 / (120 * 120), 0.001), res);
      x += 22 / 120;
      expect(res).toEqual({ nx: 0, ny: 1, nz: 0 });
      expect(c.x).toBeCloseTo(x, 9);
      expect(c.y).toBeCloseTo(2 + SKIN, 9);
    }
    expect(c.z).toBeCloseTo(0.3 + 0.4, 9);
    // with no downward component nothing is touched and nothing is reported
    w.moveBox(c, H, v3(5, 0, 0), res);
    expect(res).toEqual({ nx: 0, ny: 0, nz: 0 });
    expect(c.x).toBeCloseTo(x + 5, 9);
  });

  it('a contact at t = 0 on one axis does not eat motion along the others', () => {
    const w = worldOf(tiledFloor());
    for (const gap of [0, 1e-7, SKIN / 2, SKIN, 5 * SKIN]) {
      const c = v3(-3, 2 + gap, 0);
      const res = w.moveBox(c, H, v3(7.5, -0.02, -2.5));
      expect(res).toEqual({ nx: 0, ny: 1, nz: 0 });
      expect(c.x).toBeCloseTo(4.5, 12);
      expect(c.z).toBeCloseTo(-2.5, 12);
      // never pushed closer than it was, never further away than SKIN
      expect(c.y - 2).toBeCloseTo(Math.min(gap, SKIN), 12);
    }
  });

  it('floor tiles whose tops differ by floating-point noise do not act as a step', () => {
    // the second tile is one ulp (4.4e-16 m) "higher" — e.g. the same height computed in two different ways
    const solids = [bx(-10, -1, -5, 0, 0.5, 5), bx(0, -1, -5, 10, 0.5 + 2 ** -51, 5)];
    expect(solids[1].max.y + 2).toBeGreaterThan(solids[0].max.y + 2);
    const w = worldOf(solids);
    const c = v3(-5, 0.5 + 2, 0); // resting exactly on the first tile
    const res: MoveResult = { nx: 0, ny: 0, nz: 0 };
    for (let i = 0; i < 60; i++) w.moveBox(c, H, v3(10 / 60, -9 / (120 * 120), 0), res);
    expect(c.x).toBeCloseTo(5, 9);
    expect(res.nx).toBe(0);
    expect(c.y).toBe(2.5);
    // the previous implementation got stuck at the seam (contact on x with the side of the second tile)
    const legacy = legacyBoxes(stageOf(solids));
    const lc = v3(-5, 0.5 + 2, 0);
    let stuck = false;
    for (let i = 0; i < 60; i++) if (legacyMoveBox(legacy, lc, H, v3(10 / 60, -9 / (120 * 120), 0)).nx !== 0) stuck = true;
    expect(stuck).toBe(true);
    expect(lc.x).toBeLessThan(-1.2);
    // a real step (1 mm) does block
    const step = worldOf([bx(-10, -1, -5, 0, 0, 5), bx(0, -1, -5, 10, 0.001, 5)]);
    const sc = v3(-5, 2 + SKIN, 0);
    expect(step.moveBox(sc, H, v3(10, 0, 0)).nx).toBe(-1);
    expect(sc.x).toBeCloseTo(-1.3 - SKIN, 12);
  });

  it('slides along a wall: the blocked component is removed, the rest continues', () => {
    const w = worldOf([...tiledFloor(), bx(10, 0, -10, 10.5, 8, 10)]);
    const c = v3(5, 2 + SKIN, -3);
    const res = w.moveBox(c, H, v3(6, 0, 4));
    expect(res).toEqual({ nx: -1, ny: 0, nz: 0 });
    expect(c.x).toBeCloseTo(10 - 1.3 - SKIN, 12);
    expect(c.z).toBeCloseTo(1, 12); // full z motion
    // keeps sliding when pushed into the wall again and again; the gap never shrinks
    for (let i = 0; i < 50; i++) {
      const r = w.moveBox(c, H, v3(0.5, -0.001, 0.1));
      expect(r).toEqual({ nx: -1, ny: 1, nz: 0 });
    }
    expect(c.x).toBeCloseTo(10 - 1.3 - SKIN, 12);
    expect(c.z).toBeCloseTo(6, 9);
    // from the other side the normal flips
    const d = v3(15, 2 + SKIN, 0);
    expect(w.moveBox(d, H, v3(-6, 0, 1))).toEqual({ nx: 1, ny: 0, nz: 0 });
    expect(d.x).toBeCloseTo(10.5 + 1.3 + SKIN, 12);
    // and along z
    const zw = worldOf([bx(-10, 0, 10, 10, 8, 10.5)]);
    const e = v3(0, 3, 5);
    expect(zw.moveBox(e, H, v3(2, 0, 9))).toEqual({ nx: 0, ny: 0, nz: -1 });
    expect(e.z).toBeCloseTo(10 - 1.3 - SKIN, 12);
    expect(e.x).toBeCloseTo(2, 12);
  });

  it('stops in a corner with all three contact normals', () => {
    const w = worldOf([...tiledFloor(), bx(10, 0, -10, 10.5, 8, 10), bx(-10, 0, 8, 10.5, 8, 8.5)]);
    const c = v3(5, 6, 3);
    const res = w.moveBox(c, H, v3(20, -20, 20));
    expect(res).toEqual({ nx: -1, ny: 1, nz: -1 });
    expect(c.x).toBeCloseTo(10 - 1.3 - SKIN, 12);
    expect(c.y).toBeCloseTo(2 + SKIN, 12);
    expect(c.z).toBeCloseTo(8 - 1.3 - SKIN, 12);
    // pushing further into the corner changes nothing
    const before = { ...c };
    expect(w.moveBox(c, H, v3(3, -3, 3))).toEqual({ nx: -1, ny: 1, nz: -1 });
    expect(c).toEqual(before);
    // leaving the corner is free
    expect(w.moveBox(c, H, v3(-1, 1, -1))).toEqual({ nx: 0, ny: 0, nz: 0 });
    expect(c.x).toBeCloseTo(before.x - 1, 12);
  });

  it('hits a ceiling with ny = -1 and keeps its horizontal motion', () => {
    const w = worldOf([...tiledFloor(), bx(-50, 10, -10, 50, 11, 10)]);
    const c = v3(0, 5, 0);
    const res = w.moveBox(c, H, v3(2, 8, 1));
    expect(res).toEqual({ nx: 0, ny: -1, nz: 0 });
    expect(c.y).toBeCloseTo(10 - 2 - SKIN, 12);
    expect(c.x).toBeCloseTo(2, 12);
    expect(c.z).toBeCloseTo(1, 12);
  });

  it('never tunnels: 200 m (and far longer) deltas through thin 0.5 m walls stop at the first wall', () => {
    const solids = tiledFloor();
    for (let k = 0; k < 12; k++) solids.push(bx(8 + k * 6, 0, -10, 8.5 + k * 6, 8, 10));
    const w = worldOf(solids);
    for (const len of [200, 1e4, 1e9, 1e300]) {
      const c = v3(-20, 2 + SKIN, 0);
      const res = w.moveBox(c, H, v3(len, 0, 0));
      expect(res).toEqual({ nx: -1, ny: 0, nz: 0 });
      expect(c.x).toBeCloseTo(8 - 1.3 - SKIN, 9);
      expect(w.overlapsBox(c, H)).toBe(false);
    }
    // diagonally: stops at the wall in x, slides in z and y, ends on the floor
    const c = v3(-20, 5, -6);
    const res = w.moveBox(c, H, v3(200, -200, 3));
    expect(res).toEqual({ nx: -1, ny: 1, nz: 0 });
    expect(c.x).toBeCloseTo(8 - 1.3 - SKIN, 9);
    expect(c.y).toBeCloseTo(2 + SKIN, 9);
    expect(c.z).toBeCloseTo(-3, 9);
    // a 1 mm sheet, a 200 m step per call
    const sheet = worldOf([bx(100, -50, -50, 100.001, 50, 50)]);
    const p = v3(0, 0, 0);
    expect(sheet.moveBox(p, v3(0.01, 0.01, 0.01), v3(200, 37, -41))).toEqual({ nx: -1, ny: 0, nz: 0 });
    expect(p.x).toBeCloseTo(100 - 0.01 - SKIN, 9);
    expect(p.y).toBeCloseTo(37, 9);
    expect(p.z).toBeCloseTo(-41, 9);
    // straight down from very high through a thin catwalk
    const cat = worldOf([bx(-5, 30, -5, 5, 30.05, 5), ...tiledFloor()]);
    const q = v3(0, 5000, 0);
    expect(cat.moveBox(q, H, v3(0, -1e6, 0)).ny).toBe(1);
    expect(q.y).toBeCloseTo(32.05 + SKIN, 9);
  });

  it('a box that exactly fits a doorway passes through it', () => {
    // doorway of exactly 2.6 m between x = -1.3 and x = 1.3, lintel exactly 4 m above the floor
    const solids = [bx(-20, -1, -20, 20, 0, 20), bx(-20, 0, 5, -1.3, 8, 6), bx(1.3, 0, 5, 20, 8, 6), bx(-1.3, 4, 5, 1.3, 8, 6)];
    const w = worldOf(solids);
    const c = v3(0, 2, 0); // touching the floor, will touch both jambs and the lintel
    const res = w.moveBox(c, H, v3(0, 0, 12));
    expect(res).toEqual({ nx: 0, ny: 0, nz: 0 });
    expect(c).toEqual({ x: 0, y: 2, z: 12 });
    // pushing sideways inside the doorway is blocked at once; the forward motion continues
    const d = v3(0, 2, 5.5);
    expect(w.moveBox(d, H, v3(0.5, -0.5, 3))).toEqual({ nx: -1, ny: 1, nz: 0 });
    expect(d).toEqual({ x: 0, y: 2, z: 8.5 });
    // 1 mm off-centre: the jamb blocks
    const e = v3(0.001, 2, 0);
    expect(w.moveBox(e, H, v3(0, 0, 12)).nz).toBe(-1);
    expect(e.z).toBeCloseTo(5 - 1.3 - SKIN, 12);
    // a box that is 1 mm too wide does not pass either
    const f = v3(0, 2, 0);
    expect(w.moveBox(f, v3(1.3005, 2, 1.3), v3(0, 0, 12)).nz).toBe(-1);
    // 2 mm of clearance: free again
    const g = v3(0, 2, 0);
    expect(w.moveBox(g, v3(1.299, 2, 1.3), v3(0, 0, 12)).nz).toBe(0);
    expect(g.z).toBe(12);
  });

  it('ignores boxes it genuinely overlaps at the start (no sticking) but still collides with the others', () => {
    const w = worldOf([bx(-50, -1, -50, 50, 0, 50), bx(-2, 0, -2, 2, 6, 2), bx(10, 0, -10, 10.5, 8, 10)]);
    expect(w.overlapsBox(v3(0, 2.5, 0), H)).toBe(true);
    const c = v3(0, 2.5, 0); // inside the pillar
    const res = w.moveBox(c, H, v3(20, 0, 0));
    expect(res).toEqual({ nx: -1, ny: 0, nz: 0 });
    expect(c.x).toBeCloseTo(10 - 1.3 - SKIN, 12); // left the pillar, stopped by the wall
    // once outside, the pillar is solid again
    const back = w.moveBox(c, H, v3(-20, 0, 0));
    expect(back.nx).toBe(1);
    expect(c.x).toBeCloseTo(2 + 1.3 + SKIN, 12);
    // sunk 1 cm into the floor: the floor is ignored, so the box can be lifted out
    const d = v3(20, 1.99, 20);
    expect(w.moveBox(d, H, v3(1, 0.5, 0))).toEqual({ nx: 0, ny: 0, nz: 0 });
    expect(d).toEqual({ x: 21, y: 2.49, z: 20 });
  });

  it('contact band: a penetration at floating-point-noise level still blocks, in every later step', () => {
    const top = 0.5;
    const solids = [bx(-200, -1, -50, 200, top, 50)];
    const w = worldOf(solids);
    // one ulp below top + 2: the box starts 4.4e-16 m inside the floor (rounding noise of some earlier step)
    const y0 = top + 2 - 2 ** -51;
    expect(y0 - (top + 2)).toBeLessThan(0);
    expect(y0 - (top + 2)).toBeGreaterThan(-1e-15);
    const c = v3(0, y0, 0);
    const steps = [v3(0, -9e-8, 0), v3(0, -6.25e-4, 0), v3(0.2, -6.25e-4, 0), v3(0, -1, 0), v3(0, -9e-12, 0), v3(3, -200, 0)];
    for (let round = 0; round < 20; round++) {
      for (const s of steps) {
        const res = w.moveBox(c, H, s);
        expect(res.ny).toBe(1);
        expect(c.y).toBe(y0);
      }
    }
    expect(c.x).toBeCloseTo(20 * 3.2, 9);
    // the previous implementation lost the floor after one short sub-step and fell through it
    const legacy = legacyBoxes(stageOf(solids));
    const lc = v3(0, y0, 0);
    for (const s of steps) legacyMoveBox(legacy, lc, H, s);
    expect(lc.y).toBeLessThan(-150);
    // everywhere inside the band (up to CONTACT_EPS deep) the floor holds, deeper is a real overlap
    for (const depth of [1e-12, 1e-9, 5e-7, 0.99e-6]) {
      const p = v3(0, top + 2 - depth, 0);
      expect(w.moveBox(p, H, v3(1, -1, 0)).ny).toBe(1);
      expect(p.y).toBe(top + 2 - depth);
      expect(p.x).toBeCloseTo(1, 12);
      expect(w.probeGround(p, H, 1)).toBe(0);
    }
    const deep = v3(0, top + 2 - 2e-6, 0);
    expect(w.moveBox(deep, H, v3(0, -1, 0)).ny).toBe(0);
    expect(deep.y).toBeCloseTo(top + 1, 5);
  });

  it('displacements below 1e-12 m are dropped, and invalid input moves nothing', () => {
    const w = worldOf([bx(-50, -1, -50, 50, 0, 50)]);
    const c = v3(1, 2, 3);
    expect(w.moveBox(c, H, v3(5e-13, -5e-13, 5e-13))).toEqual({ nx: 0, ny: 0, nz: 0 });
    expect(c).toEqual({ x: 1, y: 2, z: 3 });
    expect(w.moveBox(c, H, v3(NaN, 0, 0))).toEqual({ nx: 0, ny: 0, nz: 0 });
    expect(w.moveBox(c, H, v3(Infinity, 0, 0))).toEqual({ nx: 0, ny: 0, nz: 0 });
    expect(c).toEqual({ x: 1, y: 2, z: 3 });
    const res: MoveResult = { nx: 5, ny: 5, nz: 5 };
    expect(w.moveBox(c, H, v3(0, 0, 0), res)).toBe(res);
    expect(res).toEqual({ nx: 0, ny: 0, nz: 0 });
  });

  it('walking off a ledge: support ends when the footprint leaves the platform, then the box falls and lands', () => {
    const w = worldOf([bx(-50, -1, -50, 50, 0, 50), bx(-10, 0, -4, 10, 6, 4)]); // a 6 m high platform on the floor
    const c = v3(0, 8 + SKIN, 0);
    const res: MoveResult = { nx: 0, ny: 0, nz: 0 };
    const h = 1 / 120;
    let vy = 0;
    let leftAt = -1;
    let landedAt = -1;
    for (let i = 0; i < 600 && landedAt < 0; i++) {
      const grounded = w.probeGround(c, H, 0.02) !== Infinity;
      if (!grounded && leftAt < 0) {
        leftAt = i;
        // the whole footprint is beyond the platform edge (x = 10), not a moment earlier
        expect(c.x - 1.3).toBeGreaterThanOrEqual(10 - 1e-6);
        expect(c.x - 1.3).toBeLessThan(10 + 10 * h + 1e-9);
      }
      if (grounded) vy = 0;
      w.moveBox(c, H, v3(10 * h, grounded ? 0 : vy * h - 9 * h * h, 0), res);
      if (!grounded) {
        vy -= 18 * h;
        if (res.ny === 1) landedAt = i;
      } else {
        expect(c.y).toBeCloseTo(8 + SKIN, 9);
      }
    }
    expect(leftAt).toBeGreaterThan(100);
    expect(landedAt).toBeGreaterThan(leftAt);
    // 6 m of free fall = sqrt(2*6/18) s ≈ 0.816 s ≈ 98 ticks
    expect(landedAt - leftAt).toBe(Math.ceil(Math.sqrt(12 / 18) * 120) - 1);
    expect(c.y).toBeCloseTo(2 + SKIN, 9);
    expect(w.probeGround(c, H, 0.02)).toBeCloseTo(SKIN, 9);
    // back towards the platform: its side wall blocks
    expect(w.moveBox(c, H, v3(-30, 0, 0)).nx).toBe(1);
    expect(c.x).toBeCloseTo(10 + 1.3 + SKIN, 9);
  });

  it('a long fall with sideways drift ends on the floor with full sideways motion', () => {
    const w = worldOf([bx(-500, -1, -500, 500, 0, 500)]);
    // simulate 3 s of ballistic flight in 1/120 s ticks
    const c = v3(0, 40, 0);
    let vy = 0;
    const h = 1 / 120;
    let landedAt = -1;
    const res: MoveResult = { nx: 0, ny: 0, nz: 0 };
    for (let i = 0; i < 360; i++) {
      w.moveBox(c, H, v3(16 * h, vy * h - 9 * h * h, -3 * h), res);
      vy -= 18 * h;
      if (res.ny === 1) {
        if (landedAt < 0) landedAt = i;
        vy = 0;
      }
    }
    expect(landedAt).toBeGreaterThan(0);
    // free fall of 38 m takes sqrt(2*38/18) = 2.055 s = tick 246
    expect(landedAt).toBe(Math.ceil(Math.sqrt((2 * 38) / 18) * 120) - 1);
    expect(c.y).toBeCloseTo(2 + SKIN, 9);
    expect(c.x).toBeCloseTo(48, 9);
    expect(c.z).toBeCloseTo(-9, 9);
  });
});

describe('World.probeGround', () => {
  const H = PLAYER_HALF;
  const w = worldOf([bx(-20, -1, -20, 20, 0, 20), bx(5, 0, 5, 9, 3, 9), bx(-9, 10, -9, -5, 11, -5)]);

  it('measures the gap below the bottom face and returns Infinity out of reach', () => {
    expect(w.probeGround(v3(0, 2, 0), H, 1)).toBe(0);
    expect(w.probeGround(v3(0, 2 + SKIN, 0), H, 1)).toBeCloseTo(SKIN, 12);
    expect(w.probeGround(v3(0, 2.5, 0), H, 1)).toBeCloseTo(0.5, 12);
    expect(w.probeGround(v3(0, 2.5, 0), H, 0.5)).toBeCloseTo(0.5, 12); // exactly at maxDist
    expect(w.probeGround(v3(0, 2.5, 0), H, 0.4999)).toBe(Infinity);
    expect(w.probeGround(v3(0, 50, 0), H, Infinity)).toBe(48);
    expect(w.probeGround(v3(100, 2, 0), H, 10)).toBe(Infinity); // beside the floor
    expect(w.probeGround(v3(0, -3, 0), H, 10)).toBe(Infinity); // below the floor
    expect(w.probeGround(v3(0, 2, 0), H, NaN)).toBe(Infinity);
    expect(w.probeGround(v3(NaN, 2, 0), H, 1)).toBe(Infinity);
  });

  it('takes the highest surface under the footprint, including partial support', () => {
    expect(w.probeGround(v3(7, 5.5, 7), H, 10)).toBeCloseTo(0.5, 12); // on the crate
    expect(w.probeGround(v3(4, 5.5, 7), H, 10)).toBeCloseTo(0.5, 12); // overhanging but supported
    expect(w.probeGround(v3(5 - 1.3, 5.5, 7), H, 10)).toBeCloseTo(3.5, 12); // only touching the crate's side
    expect(w.probeGround(v3(5 - 1.3 + 1e-3, 5.5, 7), H, 10)).toBeCloseTo(0.5, 12);
    expect(w.probeGround(v3(-7, 14, -7), H, 5)).toBeCloseTo(1, 12); // on the platform
    expect(w.probeGround(v3(-7, 6, -7), H, 50)).toBeCloseTo(4, 12); // under the platform: the floor
  });

  it('uses the same contact band as moveBox', () => {
    expect(w.probeGround(v3(0, 2 - 0.9e-6, 0), H, 1)).toBe(0); // noise-deep: still resting
    expect(w.probeGround(v3(0, 2 - 2e-6, 0), H, 1)).toBe(Infinity); // genuinely inside the floor
    expect(w.probeGround(v3(0, 1.5, 0), H, 1)).toBe(Infinity);
    // what probeGround reports is what a downward move does
    const rng = new Rng(5);
    for (let k = 0; k < 300; k++) {
      const c = v3(rng.range(-22, 22), rng.range(1.5, 16), rng.range(-22, 22));
      if (w.overlapsBox(c, H)) continue;
      const gap = w.probeGround(c, H, 30);
      const moved = { ...c };
      const res = w.moveBox(moved, H, v3(0, -30, 0));
      if (gap === Infinity) {
        expect(res.ny).toBe(0);
        expect(moved.y).toBeCloseTo(c.y - 30, 9);
      } else {
        expect(res.ny).toBe(1);
        expect(c.y - moved.y).toBeCloseTo(Math.max(0, gap - SKIN), 9);
      }
    }
  });
});

describe('World — barriers', () => {
  function make(): World {
    return worldOf(
      [bx(-50, -1, -50, 50, 0, 50)],
      [
        { id: 'B1', box: bx(10, 0, -5, 11, 8, 5) },
        { id: 'B2', box: bx(20, 0, -5, 21, 8, 5) },
        { id: 'B2', box: bx(20, 8, -5, 21, 12, 5) }, // an id may own several boxes
      ],
    );
  }
  const H = PLAYER_HALF;

  it('closed barriers block every query; opened barriers are skipped by every query', () => {
    const w = make();
    expect(w.isBarrierOpen('B1')).toBe(false);
    expect(w.raycast(v3(0, 2, 0), v3(1, 0, 0), 100)?.dist).toBe(10);
    expect(w.raycast(v3(0, 2, 0), v3(1, 0, 0), 100)?.box.barrierId).toBe('B1');
    expect(w.segmentBlocked(v3(0, 2, 0), v3(15, 2, 0))).toBe(true);
    expect(w.overlapsBox(v3(10.5, 2, 0), H)).toBe(true);
    expect(w.probeGround(v3(10.5, 10, 0), v3(0.2, 2, 0.2), 5)).toBe(0);
    const c = v3(0, 2 + SKIN, 0);
    expect(w.moveBox(c, H, v3(50, 0, 0)).nx).toBe(-1);
    expect(c.x).toBeCloseTo(10 - 1.3 - SKIN, 12);

    w.setBarrierOpen('B1', true);
    expect(w.isBarrierOpen('B1')).toBe(true);
    expect(w.isBarrierOpen('B2')).toBe(false);
    expect(w.boxes[1].active).toBe(false);
    expect(w.raycast(v3(0, 2, 0), v3(1, 0, 0), 100)?.dist).toBe(20);
    expect(w.segmentBlocked(v3(0, 2, 0), v3(15, 2, 0))).toBe(false);
    expect(w.overlapsBox(v3(10.5, 2, 0), H)).toBe(false);
    expect(w.probeGround(v3(10.5, 10, 0), v3(0.2, 2, 0.2), 5)).toBe(Infinity);
    const out: WorldBox[] = [];
    expect(w.boxesInAabb(v3(9, 1, -1), v3(12, 3, 1), out)).toEqual([]);
    const d = v3(0, 2 + SKIN, 0);
    expect(w.moveBox(d, H, v3(50, 0, 0)).nx).toBe(-1);
    expect(d.x).toBeCloseTo(20 - 1.3 - SKIN, 12); // passed B1, stopped by B2

    w.setBarrierOpen('B2', true);
    expect(w.isBarrierOpen('B2')).toBe(true);
    expect(w.raycast(v3(0, 2, 0), v3(1, 0, 0), 100)).toBeNull();
    expect(w.raycast(v3(0, 10, 0), v3(1, 0, 0), 100)).toBeNull(); // both boxes of B2 are gone
    const e = v3(0, 2 + SKIN, 0);
    expect(w.moveBox(e, H, v3(45, 0, 0))).toEqual({ nx: 0, ny: 0, nz: 0 });
    expect(e.x).toBe(45);

    w.setBarrierOpen('B1', false);
    expect(w.isBarrierOpen('B1')).toBe(false);
    expect(w.raycast(v3(0, 2, 0), v3(1, 0, 0), 100)?.dist).toBe(10);
  });

  it('resetBarriers closes everything again, including the final gate', () => {
    const w = make();
    w.setBarrierOpen('B1', true);
    w.setBarrierOpen('B2', true);
    w.setBarrierOpen('GATE', true);
    expect(w.isBarrierOpen('GATE')).toBe(true);
    expect(w.boxes.filter((b) => !b.active).length).toBe(4);
    w.resetBarriers();
    expect(w.boxes.every((b) => b.active)).toBe(true);
    expect(w.isBarrierOpen('B1')).toBe(false);
    expect(w.isBarrierOpen('B2')).toBe(false);
    expect(w.isBarrierOpen('GATE')).toBe(false);
    expect(w.raycast(v3(0, 10, 0), v3(1, 0, 0), 100)?.dist).toBe(20);
  });

  it('an id with several boxes is open only when all of them are; unknown ids are harmless', () => {
    const w = make();
    w.boxes[2].active = false; // one of the two B2 boxes, toggled directly
    expect(w.isBarrierOpen('B2')).toBe(false);
    expect(w.raycast(v3(0, 2, 0), v3(1, 0, 0), 100)?.dist).toBe(10);
    w.setBarrierOpen('B1', true);
    expect(w.raycast(v3(0, 2, 0), v3(1, 0, 0), 100)).toBeNull(); // the lower B2 box is inactive
    expect(w.raycast(v3(0, 10, 0), v3(1, 0, 0), 100)?.dist).toBe(20); // the upper one is not
    w.boxes[3].active = false;
    expect(w.isBarrierOpen('B2')).toBe(true);
    expect(w.isBarrierOpen('nope')).toBe(false);
    w.setBarrierOpen('nope', true);
    expect(w.boxes.filter((b) => !b.active).length).toBe(3);
  });

  it('the shared isolated test stage: floor slab everywhere, far-away gate that can be opened', () => {
    const stage = makeTestStage();
    const w = new World(stage);
    expect(w.boxes.length).toBe(2);
    expect(w.probeGround(stage.playerStart.position, H, 0.05)).toBeCloseTo(0.001, 12);
    expect(w.overlapsBox(stage.playerStart.position, H)).toBe(false);
    expect(w.raycast(v3(123, 7, -321), v3(0, -1, 0), 50)?.dist).toBe(7);
    expect(w.segmentBlocked(v3(0, 20, 0), v3(0, 20, 120))).toBe(false);
    const g = stage.finalGate.box;
    const mid = v3((g.min.x + g.max.x) / 2, (g.min.y + g.max.y) / 2, (g.min.z + g.max.z) / 2);
    expect(w.isBarrierOpen('GATE')).toBe(false);
    expect(w.overlapsBox(mid, v3(0.1, 0.1, 0.1))).toBe(true);
    w.setBarrierOpen('GATE', true);
    expect(w.isBarrierOpen('GATE')).toBe(true);
    expect(w.overlapsBox(mid, v3(0.1, 0.1, 0.1))).toBe(false);
  });
});

describe('World.sectorAt', () => {
  const sectors: SectorDef[] = [
    { id: 'S01', name: '搬入口', nameEn: 'Dock', kind: 'dock', bounds: [bx(0, 0, 0, 10, 5, 10)] },
    { id: 'S02', name: '資材ヤード', nameEn: 'Yard', kind: 'yard', bounds: [bx(10, 0, 0, 30, 20, 10), bx(10, 0, 10, 20, 20, 30)] },
    { id: 'S03', name: '縦坑', nameEn: 'Shaft', kind: 'shaft', bounds: [bx(0, 5, 0, 10, 40, 10)] },
  ];
  const w = new World(stageOf([bx(0, -1, 0, 30, 0, 30)], [], DEFAULT_GATE, sectors));

  it('returns the sector that contains the point, or null', () => {
    expect(w.sectorAt(v3(5, 2, 5))).toBe('S01');
    expect(w.sectorAt(v3(25, 2, 5))).toBe('S02');
    expect(w.sectorAt(v3(15, 2, 25))).toBe('S02'); // second bounds box of the same sector
    expect(w.sectorAt(v3(5, 20, 5))).toBe('S03');
    expect(w.sectorAt(v3(25, 2, 25))).toBeNull();
    expect(w.sectorAt(v3(5, -3, 5))).toBeNull();
    expect(w.sectorAt(v3(NaN, 2, 5))).toBeNull();
  });

  it('bounds are inclusive and the first sector in stage order wins on shared faces', () => {
    expect(w.sectorAt(v3(0, 0, 0))).toBe('S01');
    expect(w.sectorAt(v3(10, 5, 10))).toBe('S01'); // on the faces shared with S02 and S03
    expect(w.sectorAt(v3(10, 5.0001, 10))).toBe('S02');
    expect(w.sectorAt(v3(9.9999, 5.0001, 10))).toBe('S03');
    expect(w.sectorAt(v3(30, 20, 10))).toBe('S02');
    expect(w.sectorAt(v3(30.0001, 20, 10))).toBeNull();
  });
});

// ───────────────────────────── 6. randomized equivalence ─────────────────────────────

/** Random float queries of every kind against one world/reference pair. Returns how many of each were hits. */
function runRandomQueries(pair: Pair, rng: Rng, count: number): Record<string, number> {
  const s = pair.scene;
  const world = pair.world;
  const stats: Record<string, number> = { rays: 0, rayHits: 0, degenerateRays: 0, segs: 0, segBlocked: 0, overlaps: 0, overlapHits: 0, regions: 0, moves: 0, moveContacts: 0, probes: 0, probeHits: 0 };
  const scratchHit: RayHit = { dist: 0, point: v3(), normal: v3(), box: world.boxes[0] };
  const res: MoveResult = { nx: 0, ny: 0, nz: 0 };
  const out: WorldBox[] = [];
  const nBoxes = world.boxes.length;
  const keys = ['x', 'y', 'z'] as const;
  const anyBox = (): WorldBox => world.boxes[rng.int(nBoxes)];
  const pointIn = (b: WorldBox, grow: number): V3 =>
    v3(rng.range(b.min.x - grow, b.max.x + grow), rng.range(b.min.y - grow, b.max.y + grow), rng.range(b.min.z - grow, b.max.z + grow));

  for (let q = 0; q < count; q++) {
    if (q % 40 === 0) {
      pair.toggleRandom(rng);
      pair.checkBarrierState();
    }

    // ── ray ──
    {
      let o = randomPoint(rng, s);
      let d = randomUnit(rng);
      const kind = rng.next();
      if (kind < 0.12) {
        d = v3(0, 0, 0);
        d[keys[rng.int(3)]] = rng.sign();
      } else if (kind < 0.24) {
        d[keys[rng.int(3)]] = 0;
        const l = Math.hypot(d.x, d.y, d.z) || 1;
        d = v3(d.x / l, d.y / l, d.z / l);
      } else if (kind < 0.3) {
        d[keys[rng.int(3)]] = rng.next() < 0.5 ? 5e-13 : 3e-12; // just below / above the "parallel" threshold
      } else if (kind < 0.45) {
        // lies exactly in a face plane of some box and runs along / into it (grazing or seam)
        const b = anyBox();
        const a = keys[rng.int(3)];
        o = pointIn(b, 12);
        o[a] = rng.next() < 0.5 ? b.min[a] : b.max[a];
        const target = pointIn(b, 0.5);
        d = v3(target.x - o.x, target.y - o.y, target.z - o.z);
        d[a] = 0;
        const l = Math.hypot(d.x, d.y, d.z);
        if (l > 1e-6) d = v3(d.x / l, d.y / l, d.z / l);
        else d = v3(a === 'x' ? 0 : 1, 0, a === 'x' ? 1 : 0);
        stats.degenerateRays++;
      } else if (kind < 0.55) {
        // aimed at a box so that hits are frequent even in sparse scenes
        const target = pointIn(anyBox(), 0.2);
        const l = Math.hypot(target.x - o.x, target.y - o.y, target.z - o.z);
        if (l > 1e-6) d = v3((target.x - o.x) / l, (target.y - o.y) / l, (target.z - o.z) / l);
      }
      const m = rng.next();
      const maxDist = m < 0.4 ? 120 : m < 0.7 ? rng.range(0, 400) : m < 0.8 ? Infinity : m < 0.9 ? rng.range(0, 2) : 0;
      stats.rays++;
      if (pair.checkRay(o, d, maxDist, rng.next() < 0.3 ? scratchHit : undefined)) stats.rayHits++;
    }

    // ── segment ──
    {
      const a = randomPoint(rng, s);
      let b: V3;
      const kind = rng.next();
      if (kind < 0.04) b = { ...a };
      else if (kind < 0.08) b = v3(a.x + rng.range(-1, 1) * 1e-9, a.y, a.z + rng.range(-1, 1) * 1e-9);
      else if (kind < 0.3) {
        const d = randomUnit(rng);
        const l = rng.range(0, 5);
        b = v3(a.x + d.x * l, a.y + d.y * l, a.z + d.z * l);
      } else if (kind < 0.45) {
        // ends exactly on a face plane of a box
        const box = anyBox();
        const ax = keys[rng.int(3)];
        b = pointIn(box, 0.5);
        b[ax] = rng.next() < 0.5 ? box.min[ax] : box.max[ax];
      } else if (kind < 0.55) {
        // inside a face plane
        const box = anyBox();
        const ax = keys[rng.int(3)];
        const plane = rng.next() < 0.5 ? box.min[ax] : box.max[ax];
        a[ax] = plane;
        b = pointIn(box, 6);
        b[ax] = plane;
      } else b = randomPoint(rng, s);
      stats.segs++;
      if (pair.checkSegment(a, b)) stats.segBlocked++;
      if (rng.next() < 0.25) pair.checkSegment(b, a);
    }

    // ── overlap + region ──
    {
      let c = randomPoint(rng, s);
      const kind = rng.next();
      const h =
        kind < 0.3
          ? { ...PLAYER_HALF }
          : kind < 0.6
            ? v3(rng.range(0.01, 1.5), rng.range(0.01, 1.5), rng.range(0.01, 1.5))
            : kind < 0.75
              ? v3(rng.range(0, 0.01), rng.range(0, 0.01), rng.range(0, 0.01))
              : kind < 0.93
                ? v3(rng.range(2, 40), rng.range(2, 40), rng.range(2, 40))
                : v3(rng.range(100, 800), rng.range(10, 100), rng.range(100, 800));
      if (rng.next() < 0.2) {
        // face to face with a box
        const b = anyBox();
        const a = keys[rng.int(3)];
        c = pointIn(b, 1);
        c[a] = rng.next() < 0.5 ? b.min[a] - h[a] : b.max[a] + h[a];
      }
      // nonsense input must still give the answer of the plain formulas
      if (rng.next() < 0.03) h[keys[rng.int(3)]] *= -1;
      stats.overlaps++;
      if (pair.checkOverlap(c, h)) stats.overlapHits++;
      if (q % 3 === 0) {
        stats.regions += pair.checkRegion(v3(c.x - h.x, c.y - h.y, c.z - h.z), v3(c.x + h.x, c.y + h.y, c.z + h.z), out);
      }
    }

    // ── move ──
    {
      let c = randomPoint(rng, s);
      const hk = rng.next();
      const h = hk < 0.5 ? { ...PLAYER_HALF } : hk < 0.9 ? v3(rng.range(0.05, 3), rng.range(0.05, 3), rng.range(0.05, 3)) : v3(rng.range(0, 1), 0, rng.range(0, 1));
      const dk = rng.next();
      const mag = dk < 0.1 ? 10 ** rng.range(-13, -3) : dk < 0.6 ? rng.range(0, 2) : dk < 0.9 ? rng.range(2, 40) : rng.range(40, 400);
      const u = randomUnit(rng);
      const d = v3(u.x * mag, u.y * mag, u.z * mag);
      if (rng.next() < 0.3) d[keys[rng.int(3)]] = 0;
      if (rng.next() < 0.1) d[keys[rng.int(3)]] = 0;
      if (rng.next() < 0.02) h[keys[rng.int(3)]] *= -1;
      const sk = rng.next();
      if (sk < 0.35) {
        // start touching, slightly apart from, or slightly inside a face of some box
        const b = anyBox();
        const a = keys[rng.int(3)];
        const offsets = [0, 0, 0, SKIN, SKIN / 2, 1e-7, -1e-12, -5e-7, -CONTACT_EPS, -2e-6, -1e-3];
        const off = offsets[rng.int(offsets.length)];
        c = pointIn(b, 1);
        c[a] = rng.next() < 0.5 ? b.min[a] - h[a] - off : b.max[a] + h[a] + off;
      }
      stats.moves++;
      const end = pair.checkMove(c, h, d, res);
      if (res.nx !== 0 || res.ny !== 0 || res.nz !== 0) stats.moveContacts++;
      // the result never leaves the bounds of the sweep and never moves against the delta
      for (const a of keys) {
        const moved = end[a] - c[a];
        if (moved * d[a] < 0 || Math.abs(moved) > Math.abs(d[a]) + 1e-9) fail(`move c=${fmt(c)} d=${fmt(d)}: displacement ${moved} on ${a}`);
      }
      const nrm = [res.nx, res.ny, res.nz];
      const sane = h.x >= 0 && h.y >= 0 && h.z >= 0; // (a negative half extent has no meaningful normals)
      keys.forEach((a, i) => {
        if (nrm[i] === 0) {
          if (Math.abs(d[a]) >= 1e-12 && !near(end[a] - c[a], d[a], 1e-9 + Math.abs(d[a]) * 1e-12)) fail(`move c=${fmt(c)} d=${fmt(d)}: axis ${a} lost motion without a contact`);
        } else if (sane && nrm[i] !== -Math.sign(d[a])) fail(`move c=${fmt(c)} d=${fmt(d)}: normal ${nrm[i]} on ${a}`);
      });
    }

    // ── ground probe ──
    {
      let c = randomPoint(rng, s);
      const h = rng.next() < 0.6 ? { ...PLAYER_HALF } : v3(rng.range(0.05, 3), rng.range(0.05, 3), rng.range(0.05, 3));
      const m = rng.next();
      const maxDist = m < 0.3 ? 0.05 : m < 0.5 ? 1 : m < 0.8 ? rng.range(0, 60) : m < 0.9 ? Infinity : 0;
      if (rng.next() < 0.4) {
        const b = anyBox();
        const offsets = [0, 0, SKIN, 1e-7, -5e-7, -CONTACT_EPS, -2e-6, 0.03, 0.5];
        c = pointIn(b, 1);
        c.y = b.max.y + h.y + offsets[rng.int(offsets.length)];
        if (rng.next() < 0.3) c.x = b.min.x - h.x + [0, 5e-7, 2e-6][rng.int(3)];
      }
      if (rng.next() < 0.02) h[keys[rng.int(3)]] *= -1;
      stats.probes++;
      if (pair.checkProbe(c, h, maxDist) !== Infinity) stats.probeHits++;
    }
  }
  return stats;
}

describe('World ⇔ brute-force reference (randomized, 1e-9)', () => {
  const configs: Array<{ name: string; opts: WorldOptions }> = [
    { name: 'default grid', opts: {} },
    { name: '2 m cells', opts: { cellSize: 2 } },
    { name: '64 m cells', opts: { cellSize: 64 } },
    { name: 'almost everything in the always-tested list', opts: { largeBoxCells: 2 } },
    { name: 'boundaries on round coordinates', opts: { cellSize: 4, originFraction: 0 } },
    { name: 'tiny cells, nothing kept out of the grid', opts: { cellSize: 1.5, largeBoxCells: 1e9 } },
  ];

  configs.forEach((cfg, ci) => {
    it(`dense float scene, ${cfg.name}`, () => {
      const rng = new Rng(1000 + ci);
      const pair = new Pair(randomScene(rng, 400, 60, 45), cfg.opts);
      const stats = runRandomQueries(pair, rng, 2500 * SOAK);
      // the mix must really exercise hits and misses of every kind
      expect(stats.rayHits).toBeGreaterThan(1000);
      expect(stats.rays - stats.rayHits).toBeGreaterThan(300);
      expect(stats.degenerateRays).toBeGreaterThan(250);
      expect(stats.segBlocked).toBeGreaterThan(1000);
      expect(stats.segs - stats.segBlocked).toBeGreaterThan(300);
      expect(stats.overlapHits).toBeGreaterThan(800);
      expect(stats.overlaps - stats.overlapHits).toBeGreaterThan(400);
      expect(stats.moveContacts).toBeGreaterThan(600);
      expect(stats.moves - stats.moveContacts).toBeGreaterThan(600);
      expect(stats.probeHits).toBeGreaterThan(700);
      expect(stats.probes - stats.probeHits).toBeGreaterThan(700);
      expect(stats.regions).toBeGreaterThan(5000);
    });
  });

  it('large sparse scene (3000 boxes over 450 x 350 m), default grid', () => {
    const rng = new Rng(77);
    const pair = new Pair(randomScene(rng, 3000, 225, 175, { huge: 0.002 }));
    const g = pair.world.getGridInfo();
    expect(g.largeBoxes).toBeGreaterThanOrEqual(3);
    expect(g.griddedBoxes).toBeGreaterThan(2500);
    const stats = runRandomQueries(pair, rng, 2000 * SOAK);
    expect(stats.rayHits).toBeGreaterThan(600);
    expect(stats.rays - stats.rayHits).toBeGreaterThan(200);
    expect(stats.moveContacts).toBeGreaterThan(300);
  });

  it('several small scenes with few boxes (including empty space around them)', () => {
    for (let seed = 0; seed < 12; seed++) {
      const rng = new Rng(500 + seed);
      const pair = new Pair(randomScene(rng, 3 + seed * 4, 20 + seed * 15, 15 + seed * 10), seed % 2 === 0 ? {} : { cellSize: 3 + seed });
      runRandomQueries(pair, rng, 300 * SOAK);
    }
  });

  it('a walker that keeps moving stays in step with the reference and never ends up inside anything', () => {
    for (let seed = 0; seed < 4; seed++) {
      const rng = new Rng(9000 + seed);
      const pair = new Pair(randomScene(rng, 500, 50, 40, { open: true }), seed === 3 ? { cellSize: 3 } : {});
      const h = { ...PLAYER_HALF };
      // find a free start
      let cw = v3();
      let tries = 0;
      for (;;) {
        cw = v3(rng.range(-50, 50), rng.range(0, 30), rng.range(-40, 40));
        if (pair.ref.penetration(cw, h) === 0 && !pair.world.overlapsBox(cw, h)) break;
        if (++tries > 10000) fail('no free start position found');
      }
      const cr = { ...cw };
      const res: MoveResult = { nx: 0, ny: 0, nz: 0 };
      let heading = randomUnit(rng);
      let contacts = 0;
      let worst = 0;
      for (let step = 0; step < 4000 * SOAK; step++) {
        if (step % 25 === 0) heading = randomUnit(rng);
        const speed = step % 400 < 40 ? 80 : 22; // "quick boost" phases
        const dt = step % 7 === 3 ? 10 ** rng.range(-9, -3) : 1 / 120; // event-cut sub-steps
        const d = v3(heading.x * speed * dt, (heading.y * 12 - 3) * dt - 9 * dt * dt, heading.z * speed * dt);
        const w = pair.world.moveBox(cw, h, d, res);
        const r = pair.ref.moveBox(cr, h, d);
        if (!near(cw.x, cr.x) || !near(cw.y, cr.y) || !near(cw.z, cr.z) || w.nx !== r.nx || w.ny !== r.ny || w.nz !== r.nz) {
          fail(`walker ${seed} diverged at step ${step}: ${fmt(cw)} vs ${fmt(cr)}`);
        }
        if (w.nx !== 0 || w.ny !== 0 || w.nz !== 0) contacts++;
        // barriers stay closed here: from a free start the box must never be inside any box
        const pen = pair.ref.penetration(cw, h);
        if (pen > worst) worst = pen;
        if (pen > 1e-9) fail(`walker ${seed} penetrates by ${pen} at step ${step} ${fmt(cw)}`);
        // keep it in the populated region
        if (Math.abs(cw.x) > 70 || Math.abs(cw.z) > 60 || cw.y < -10 || cw.y > 50) {
          heading = v3(-cw.x, 15 - cw.y, -cw.z);
          const l = Math.hypot(heading.x, heading.y, heading.z);
          heading = v3(heading.x / l, heading.y / l, heading.z / l);
        }
      }
      expect(contacts).toBeGreaterThan(200);
      expect(worst).toBeLessThanOrEqual(1e-9);
    }
  });
});

describe('World on integer lattices (ties, touching faces, seams, cell boundaries)', () => {
  const DIRS = [0, 0, 0.5, -0.5, 1, -1, 1, -1, 2, -2];
  const half = (rng: Rng): number => rng.int(53) * 0.5 - 1; // multiples of 0.5 in [-1, 25]

  const configs: Array<{ name: string; opts: WorldOptions }> = [
    { name: 'default grid', opts: {} },
    { name: 'cells aligned with the lattice (4 m)', opts: { cellSize: 4, originFraction: 0 } },
    { name: 'cells aligned with the lattice (1 m)', opts: { cellSize: 1, originFraction: 0 } },
    { name: 'cells aligned with the lattice (2 m), small always-tested threshold', opts: { cellSize: 2, originFraction: 0, largeBoxCells: 3 } },
  ];

  configs.forEach((cfg, ci) => {
    it(`rays and segments agree with the reference and with the sampling oracle — ${cfg.name}`, () => {
      const rng = new Rng(300 + ci);
      const pair = new Pair(latticeScene(rng, 70), cfg.opts);
      let hits = 0;
      let misses = 0;
      let planar = 0;
      for (let q = 0; q < 1800 * SOAK; q++) {
        if (q % 60 === 0) pair.toggleRandom(rng);
        const o = v3(half(rng), rng.int(21) * 0.5 - 1, half(rng));
        const d = v3(DIRS[rng.int(DIRS.length)], DIRS[rng.int(DIRS.length)], DIRS[rng.int(DIRS.length)]);
        if (rng.next() < 0.5) d.y = 0;
        const m = rng.next();
        const maxDist = m < 0.5 ? 100 : m < 0.8 ? rng.int(40) * 0.25 : m < 0.9 ? Infinity : 0;
        const isHit = pair.checkRay(o, d, maxDist);
        if (isHit) hits++;
        else misses++;
        if (d.x === 0 || d.y === 0 || d.z === 0) planar++;
        // independent oracle
        const expected = oracleRay(pair.ref.boxes, o, d, maxDist, false);
        const got = pair.world.raycast(o, d, maxDist);
        if ((expected === null) !== (got === null) || (got && expected !== null && !near(got.dist, expected))) {
          fail(`oracle: ray o=${fmt(o)} d=${fmt(d)} max=${maxDist}: world ${got ? got.dist : 'null'} vs oracle ${expected}`);
        }
        // the same as a segment
        if (d.x !== 0 || d.y !== 0 || d.z !== 0) {
          const scale = [0.5, 1, 2, 4, 8][rng.int(5)];
          const b = v3(o.x + d.x * scale, o.y + d.y * scale, o.z + d.z * scale);
          const blocked = pair.checkSegment(o, b);
          const exp = oracleRay(pair.ref.boxes, o, v3(b.x - o.x, b.y - o.y, b.z - o.z), 1, true) !== null;
          if (blocked !== exp) fail(`oracle: segment a=${fmt(o)} b=${fmt(b)}: world ${blocked} vs oracle ${exp}`);
          // symmetric
          if (pair.world.segmentBlocked(b, o) !== blocked) fail(`segment a=${fmt(o)} b=${fmt(b)} is not symmetric`);
        }
      }
      expect(hits).toBeGreaterThan(300);
      expect(misses).toBeGreaterThan(300);
      expect(planar).toBeGreaterThan(900);
    });

    it(`overlaps, regions, moves and ground probes agree with the reference — ${cfg.name}`, () => {
      const rng = new Rng(400 + ci);
      const pair = new Pair(latticeScene(rng, 70), cfg.opts);
      const res: MoveResult = { nx: 0, ny: 0, nz: 0 };
      const out: WorldBox[] = [];
      const HALVES = [0.5, 0.5, 1, 1.5];
      const JITTER = [0, 0, 0, 0, 1e-7, -1e-7, 5e-7, -5e-7, 1e-6, -1e-6, 2e-6, -2e-6, 1e-12, -1e-12, SKIN, -SKIN];
      let contacts = 0;
      let axisChecks = 0;
      for (let q = 0; q < 2500 * SOAK; q++) {
        if (q % 60 === 0) pair.toggleRandom(rng);
        const c = v3(half(rng), rng.int(21) * 0.5 - 1, half(rng));
        const h = v3(HALVES[rng.int(4)], HALVES[rng.int(4)], HALVES[rng.int(4)]);
        pair.checkOverlap(c, h);
        pair.checkRegion(v3(c.x - h.x, c.y - h.y, c.z - h.z), v3(c.x + h.x, c.y + h.y, c.z + h.z), out);
        pair.checkProbe(c, h, [0, 0.5, 1, 3, Infinity][rng.int(5)]);

        // moves with lattice deltas from lattice positions: contacts at t = 0, ties and touching everywhere
        const d = v3((rng.int(33) - 16) * 0.5, (rng.int(17) - 8) * 0.5, (rng.int(33) - 16) * 0.5);
        if (rng.next() < 0.3) d.x = 0;
        if (rng.next() < 0.3) d.z = 0;
        pair.checkMove(c, h, d, res);
        if (res.nx !== 0 || res.ny !== 0 || res.nz !== 0) contacts++;

        // single-axis move from a free position: independent expectation
        if (!pair.ref.overlapsBox(c, h)) {
          const axis = rng.int(3);
          const amount = (rng.int(40) + 1) * 0.5 * rng.sign();
          const dd = v3(axis === 0 ? amount : 0, axis === 1 ? amount : 0, axis === 2 ? amount : 0);
          const end = pair.checkMove(c, h, dd, res);
          const exp = oracleAxisMove(pair.ref.boxes, c, h, axis, amount);
          const got = axis === 0 ? end.x : axis === 1 ? end.y : end.z;
          const n = axis === 0 ? res.nx : axis === 1 ? res.ny : res.nz;
          if (!near(got, exp.pos) || (n !== 0) !== exp.hit) fail(`axis move c=${fmt(c)} h=${fmt(h)} d=${fmt(dd)}: ${got} (n=${n}) vs ${exp.pos} (hit=${exp.hit})`);
          axisChecks++;
        }

        // the same queries a hair off the lattice (inside / outside the contact band)
        const cj = v3(c.x + JITTER[rng.int(JITTER.length)], c.y + JITTER[rng.int(JITTER.length)], c.z + JITTER[rng.int(JITTER.length)]);
        pair.checkMove(cj, h, d, res);
        pair.checkProbe(cj, h, 1);
        pair.checkOverlap(cj, h);
      }
      expect(contacts).toBeGreaterThan(800);
      expect(axisChecks).toBeGreaterThan(300);
    });
  });

  it('rays through grid cell corners and along cell boundaries (DDA edge cases)', () => {
    const rng = new Rng(808);
    const pair = new Pair(randomScene(rng, 600, 60, 45));
    const g = pair.world.getGridInfo();
    let hits = 0;
    for (let q = 0; q < 3000 * SOAK; q++) {
      // a lattice point of the grid, approached diagonally / along a boundary line
      const cx = g.originX + (1 + rng.int(g.nx - 1)) * g.cellSize;
      const cz = g.originZ + (1 + rng.int(g.nz - 1)) * g.cellSize;
      const kind = rng.int(4);
      const y = rng.range(-5, 40);
      let o: V3;
      let d: V3;
      if (kind === 0) {
        const k = rng.range(1, 60) * rng.sign();
        const sz = rng.sign();
        o = v3(cx - k, y, cz - k * sz);
        d = v3(Math.sign(k) * Math.SQRT1_2, 0, Math.sign(k) * sz * Math.SQRT1_2);
      } else if (kind === 1) {
        o = v3(cx, y, cz - rng.range(-60, 60)); // along a boundary line x = const
        d = v3(0, 0, rng.sign());
      } else if (kind === 2) {
        o = v3(cx - rng.range(-60, 60), y, cz);
        d = v3(rng.sign(), 0, 0);
      } else {
        // through the corner with a random slope, exact corner hit not guaranteed in floats — that is the point
        const u = randomUnit(rng);
        const k = rng.range(1, 80);
        o = v3(cx - u.x * k, y - u.y * k, cz - u.z * k);
        d = u;
      }
      if (pair.checkRay(o, d, 200)) hits++;
      pair.checkSegment(o, v3(o.x + d.x * 150, o.y + d.y * 150, o.z + d.z * 150));
    }
    expect(hits).toBeGreaterThan(500);
  });
});

describe('World — convex room oracle for collide-and-slide', () => {
  it('inside a closed room the result is the per-axis clamp, whatever the length of the delta', () => {
    const rng = new Rng(4242);
    for (let room = 0; room < 30; room++) {
      const x0 = rng.range(-80, 0);
      const x1 = x0 + rng.range(6, 90);
      const y0 = rng.range(-10, 10);
      const y1 = y0 + rng.range(5, 40);
      const z0 = rng.range(-80, 0);
      const z1 = z0 + rng.range(6, 90);
      const t = 0.5;
      const w = worldOf(
        [
          bx(x0 - t, y0 - t, z0 - t, x1 + t, y0, z1 + t), // floor
          bx(x0 - t, y1, z0 - t, x1 + t, y1 + t, z1 + t), // ceiling
          bx(x0 - t, y0, z0 - t, x0, y1, z1 + t),
          bx(x1, y0, z0 - t, x1 + t, y1, z1 + t),
          bx(x0, y0, z0 - t, x1, y1, z0),
          bx(x0, y0, z1, x1, y1, z1 + t),
        ],
        [],
        room % 3 === 0 ? { cellSize: 5 } : {},
      );
      const h = v3(rng.range(0.2, 1.5), rng.range(0.2, 2), rng.range(0.2, 1.5));
      const lo = v3(x0 + h.x + SKIN, y0 + h.y + SKIN, z0 + h.z + SKIN);
      const hi = v3(x1 - h.x - SKIN, y1 - h.y - SKIN, z1 - h.z - SKIN);
      for (let k = 0; k < 200; k++) {
        const c = v3(rng.range(lo.x, hi.x), rng.range(lo.y, hi.y), rng.range(lo.z, hi.z));
        const mag = 10 ** rng.range(-2, 3.5);
        const u = randomUnit(rng);
        const d = v3(u.x * mag, u.y * mag, u.z * mag);
        if (rng.next() < 0.2) d.y = 0;
        const end = { ...c };
        const res = w.moveBox(end, h, d);
        const exp = v3(Math.min(hi.x, Math.max(lo.x, c.x + d.x)), Math.min(hi.y, Math.max(lo.y, c.y + d.y)), Math.min(hi.z, Math.max(lo.z, c.z + d.z)));
        if (!near(end.x, exp.x, 1e-8) || !near(end.y, exp.y, 1e-8) || !near(end.z, exp.z, 1e-8)) {
          fail(`room ${room}: c=${fmt(c)} d=${fmt(d)} → ${fmt(end)}, expected ${fmt(exp)}`);
        }
        const expN = [
          c.x + d.x > hi.x ? -1 : c.x + d.x < lo.x ? 1 : 0,
          c.y + d.y > hi.y ? -1 : c.y + d.y < lo.y ? 1 : 0,
          c.z + d.z > hi.z ? -1 : c.z + d.z < lo.z ? 1 : 0,
        ];
        if (res.nx !== expN[0] || res.ny !== expN[1] || res.nz !== expN[2]) {
          fail(`room ${room}: c=${fmt(c)} d=${fmt(d)} normals (${res.nx}, ${res.ny}, ${res.nz}), expected (${expN.join(', ')})`);
        }
        if (w.overlapsBox(end, h)) fail(`room ${room}: ends inside a wall`);
      }
    }
  });
});

describe('World — sampling oracle for the sweep (overlap tests only, no slab maths)', () => {
  it('nothing is crossed before the reported stop, and the reported contact is real', () => {
    const rng = new Rng(60606);
    let free = 0;
    let single = 0;
    let multi = 0;
    for (let sceneNo = 0; sceneNo < 3; sceneNo++) {
      const scene = randomScene(rng, 350, 40, 40, { open: true });
      const world = new World(scene.stage, sceneNo === 2 ? { cellSize: 3 } : {});
      const ref = new RefWorld(scene.stage);
      const keys = ['x', 'y', 'z'] as const;
      let done = 0;
      let tries = 0;
      while (done < 500 * SOAK) {
        if (++tries > 2_000_000) fail('could not find enough free start positions');
        const h = rng.next() < 0.5 ? { ...PLAYER_HALF } : v3(rng.range(0.2, 1.5), rng.range(0.2, 1.5), rng.range(0.2, 1.5));
        const c = v3(rng.range(-45, 45), rng.range(-6, 42), rng.range(-45, 45));
        // start clear of everything by 1 mm
        if (ref.penetration(c, v3(h.x + 1e-3, h.y + 1e-3, h.z + 1e-3)) > 0) continue;
        const len = rng.next() < 0.3 ? rng.range(0.05, 1) : rng.range(1, 40);
        const u = randomUnit(rng);
        const d = v3(u.x * len, u.y * len, u.z * len);
        const end = { ...c };
        const res = world.moveBox(end, h, d);
        done++;
        const nrm = [res.nx, res.ny, res.nz];
        const contacts = nrm.filter((v) => v !== 0).length;
        // parameter along the straight path up to which the box followed it
        let tStop = 1;
        let axis = -1;
        if (contacts === 1) {
          axis = nrm.findIndex((v) => v !== 0);
          const a = keys[axis];
          tStop = (end[a] - c[a]) / d[a];
          if (!(tStop >= 0 && tStop <= 1)) fail(`sweep oracle: c=${fmt(c)} d=${fmt(d)}: stop parameter ${tStop}`);
          single++;
        } else if (contacts === 0) {
          free++;
        } else {
          multi++;
          continue; // the first leg is not observable from outside
        }
        // (1) every sampled position before the stop is free: nothing was tunnelled through.
        //     The box is at least 0.4 m wide, so a 0.05 m sampling step cannot step over an obstacle.
        const steps = Math.max(1, Math.ceil((len * tStop) / 0.05));
        const q = v3();
        for (let k = 1; k <= steps; k++) {
          const t = (tStop * k) / steps;
          q.x = c.x + d.x * t;
          q.y = c.y + d.y * t;
          q.z = c.z + d.z * t;
          const pen = ref.penetration(q, h);
          if (pen > 1e-9) fail(`sweep oracle: c=${fmt(c)} h=${fmt(h)} d=${fmt(d)}: inside an obstacle by ${pen} at t=${t} (stop ${tStop})`);
        }
        if (contacts === 1) {
          const a = keys[axis];
          // (2) the stop is SKIN short of a real obstacle: a little further along the path the box is inside one
          const tIn = tStop + (SKIN + 5e-6) / Math.abs(d[a]);
          q.x = c.x + d.x * tIn;
          q.y = c.y + d.y * tIn;
          q.z = c.z + d.z * tIn;
          if (!(ref.penetration(q, h) > 0)) fail(`sweep oracle: c=${fmt(c)} h=${fmt(h)} d=${fmt(d)}: stopped at t=${tStop} without an obstacle ahead`);
          // ... and the slide kept the whole motion on the two other axes
          for (let b = 0; b < 3; b++) {
            if (b !== axis && !near(end[keys[b]] - c[keys[b]], d[keys[b]], 1e-9)) fail(`sweep oracle: c=${fmt(c)} d=${fmt(d)}: lost motion on ${keys[b]}`);
          }
          if (nrm[axis] !== -Math.sign(d[a])) fail(`sweep oracle: c=${fmt(c)} d=${fmt(d)}: normal sign`);
        } else if (!near(end.x, c.x + d.x) || !near(end.y, c.y + d.y) || !near(end.z, c.z + d.z)) {
          fail(`sweep oracle: c=${fmt(c)} d=${fmt(d)}: free move did not apply the whole delta`);
        }
        // the end position is never inside anything
        if (ref.penetration(end, h) > 1e-9) fail(`sweep oracle: c=${fmt(c)} d=${fmt(d)}: ends inside an obstacle`);
      }
    }
    expect(free).toBeGreaterThan(200);
    expect(single).toBeGreaterThan(300);
    expect(multi).toBeGreaterThan(30);
  });
});

describe('World vs the previous brute-force implementation (what is unchanged, what was fixed)', () => {
  it('generic rays, segments, overlaps and ground probes give identical results', () => {
    const rng = new Rng(31337);
    const scene = randomScene(rng, 500, 60, 45);
    const world = new World(scene.stage);
    const legacy = legacyBoxes(scene.stage);
    let rayHits = 0;
    let blocked = 0;
    let probes = 0;
    for (let q = 0; q < 4000; q++) {
      if (q % 50 === 0) {
        const id = scene.barrierIds[rng.int(scene.barrierIds.length)];
        const open = rng.next() < 0.5;
        world.setBarrierOpen(id, open);
        world.boxes.forEach((b, i) => {
          legacy[i].active = b.active;
        });
      }
      const o = randomPoint(rng, scene);
      const d = randomUnit(rng);
      const maxDist = rng.next() < 0.5 ? 120 : rng.range(0, 300);
      const w = world.raycast(o, d, maxDist);
      const l = legacyRaycast(legacy, o, d, maxDist);
      if ((w === null) !== (l === null)) fail(`legacy ray differs: o=${fmt(o)} d=${fmt(d)}`);
      if (w && l) {
        rayHits++;
        if (!near(w.dist, l.dist) || world.boxes.indexOf(w.box) !== l.idx || w.normal.x !== l.normal.x || w.normal.y !== l.normal.y || w.normal.z !== l.normal.z) {
          fail(`legacy ray differs: o=${fmt(o)} d=${fmt(d)}: ${w.dist} vs ${l.dist}`);
        }
      }
      const b = randomPoint(rng, scene);
      const sb = world.segmentBlocked(o, b);
      if (sb !== legacySegmentBlocked(legacy, o, b)) fail(`legacy segment differs: a=${fmt(o)} b=${fmt(b)}`);
      if (sb) blocked++;
      const h = v3(rng.range(0.05, 3), rng.range(0.05, 3), rng.range(0.05, 3));
      const pw = world.probeGround(o, h, 50);
      if (!near(pw, legacyProbeGround(legacy, o, h, 50))) fail(`legacy probe differs at ${fmt(o)}`);
      if (pw !== Infinity) probes++;
      if (world.overlapsBox(o, h) !== legacyOverlapsBox(legacy, o, h)) fail(`legacy overlap differs at ${fmt(o)}`);
    }
    expect(rayHits).toBeGreaterThan(800);
    expect(blocked).toBeGreaterThan(800);
    expect(probes).toBeGreaterThan(800);
  });

  it('moveBox from free positions differs from the previous version only at the scale of SKIN', () => {
    const rng = new Rng(2718);
    const scene = randomScene(rng, 500, 60, 45);
    const world = new World(scene.stage);
    const ref = new RefWorld(scene.stage);
    const legacy = legacyBoxes(scene.stage);
    const h = { ...PLAYER_HALF };
    let compared = 0;
    let contacts = 0;
    let same = 0;
    let maxDiffWhenSame = 0;
    let tries = 0;
    while (compared < 3000) {
      if (++tries > 3_000_000) fail('could not find enough free start positions');
      const c = randomPoint(rng, scene);
      // well clear of everything, so that neither version starts inside a contact band
      if (ref.penetration(c, v3(h.x + 0.01, h.y + 0.01, h.z + 0.01)) > 0) continue;
      const mag = rng.next() < 0.6 ? rng.range(0, 3) : rng.range(3, 80);
      const u = randomUnit(rng);
      const d = v3(u.x * mag, u.y * mag, u.z * mag);
      const a = { ...c };
      const b = { ...c };
      const rw = world.moveBox(a, h, d);
      const rl = legacyMoveBox(legacy, b, h, d);
      compared++;
      if (rw.nx !== 0 || rw.ny !== 0 || rw.nz !== 0) contacts++;
      const diff = Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.z - b.z));
      if (rw.nx === rl.nx && rw.ny === rl.ny && rw.nz === rl.nz) {
        same++;
        if (diff > maxDiffWhenSame) maxDiffWhenSame = diff;
      }
    }
    expect(contacts).toBeGreaterThan(500);
    // same contacts → same place up to the stop gap (legacy: SKIN along the path, now: SKIN along the normal)
    expect(maxDiffWhenSame).toBeLessThanOrEqual(SKIN * 1.0001);
    // a different contact sequence needs a second obstacle within SKIN of the first stop: rare
    expect(same / compared).toBeGreaterThan(0.995);
  });
});

// ───────────────────────────── 7. benchmark ─────────────────────────────

/** ~5000 boxes over a 450 x 350 m area: two full-size slabs, hall floors on four levels, walls, machinery. */
function benchmarkStage(rng: Rng): StageDef {
  const solids: Box[] = [];
  const X = 450;
  const Z = 350;
  const levels = [0, 8, 16, 24];
  solids.push(bx(0, -1, 0, X, 0, Z)); // ground slab
  solids.push(bx(0, 40, 0, X, 41, Z)); // roof slab
  for (let k = 0; k < 40; k++) {
    const x = rng.range(0, X - 60);
    const z = rng.range(0, Z - 50);
    const y = levels[1 + rng.int(3)];
    solids.push(bx(x, y - 0.5, z, x + 60, y, z + 50));
  }
  for (let k = 0; k < 560; k++) {
    const len = rng.range(10, 60);
    const y = levels[rng.int(4)];
    const hgt = rng.range(4, 12);
    const x = rng.range(0, X - 60);
    const z = rng.range(0, Z - 60);
    if (rng.next() < 0.5) solids.push(bx(x, y, z, x + len, y + hgt, z + 0.5));
    else solids.push(bx(x, y, z, x + 0.5, y + hgt, z + len));
  }
  while (solids.length < 5000) {
    const sx = rng.range(0.5, 6);
    const sy = rng.range(0.5, 6);
    const sz = rng.range(0.5, 6);
    const x = rng.range(0, X - sx);
    const z = rng.range(0, Z - sz);
    const y = levels[rng.int(4)];
    solids.push(bx(x, y, z, x + sx, y + sy, z + sz));
  }
  const barriers: BarrierSpec[] = [];
  for (let k = 0; k < 6; k++) barriers.push({ id: `B${k + 1}`, box: bx(60 + k * 60, 0, 100, 60.5 + k * 60, 8, 112) });
  return stageOf(solids, barriers, bx(440, 0, 170, 441, 8, 182));
}

describe('World — no per-query allocations', () => {
  it('raycast (with a result object), segmentBlocked, overlapsBox and moveBox allocate nothing once warmed up', async () => {
    // V8 exposes the total number of bytes ever allocated on the JS heap; skip silently on other runtimes.
    const moduleName = 'node:v8';
    let heapStats: (() => Record<string, number>) | null = null;
    try {
      const v8 = (await import(/* @vite-ignore */ moduleName)) as { getHeapStatistics?: () => Record<string, number> };
      if (v8.getHeapStatistics && typeof v8.getHeapStatistics().total_allocated_bytes === 'number') {
        heapStats = v8.getHeapStatistics;
      }
    } catch {
      heapStats = null;
    }
    if (!heapStats) return;
    const stats = heapStats;

    const rng = new Rng(4711);
    const scene = randomScene(rng, 1500, 120, 100, { huge: 0 });
    // next to it a wall split along x = 400, so that the exact seam procedure runs as well
    const stage = stageOf([...scene.stage.solids, bx(380, -4, 60, 400, 30, 61), bx(400, -4, 60, 420, 30, 61)], [], bx(100, 0, 0, 101, 5, 5));
    const world = new World(stage);
    const N = 1024;
    const P: V3[] = [];
    const D: V3[] = [];
    for (let i = 0; i < N; i++) {
      P.push(v3(rng.range(-120, 120), rng.range(-5, 40), rng.range(-100, 100)));
      D.push(randomUnit(rng));
    }
    const hit: RayHit = { dist: 0, point: v3(), normal: v3(), box: world.boxes[0] };
    const res: MoveResult = { nx: 0, ny: 0, nz: 0 };
    const pos = v3();
    const end = v3();
    const seamO = v3(400, 3, 59);
    const seamD = v3(0, 0, 1);
    expect(world.raycast(seamO, seamD, 50)?.dist).toBe(1);
    let sink = 0;
    const cases: Array<[string, (i: number) => void]> = [
      ['(empty loop)', (i) => (P[i].x > D[i].y ? sink++ : 0)],
      ['raycast', (i) => (world.raycast(P[i], D[i], 120, hit) ? sink++ : 0)],
      ['raycast in a seam plane', () => (world.raycast(seamO, seamD, 50, hit) ? sink++ : 0)],
      [
        'segmentBlocked',
        (i) => {
          end.x = P[i].x + D[i].x * 60;
          end.y = P[i].y + D[i].y * 60;
          end.z = P[i].z + D[i].z * 60;
          if (world.segmentBlocked(P[i], end)) sink++;
        },
      ],
      ['overlapsBox', (i) => (world.overlapsBox(P[i], PLAYER_HALF) ? sink++ : 0)],
      [
        'moveBox',
        (i) => {
          pos.x = P[i].x;
          pos.y = P[i].y;
          pos.z = P[i].z;
          world.moveBox(pos, PLAYER_HALF, D[i], res);
          sink += res.ny;
        },
      ],
    ];
    // Unoptimised code boxes every intermediate number, so the figure only means something once the JIT has
    // settled: measure rounds of 100000 calls and keep the best one. Reading the counter itself accounts for
    // a few hundred kB (the current allocation buffer), which is why an empty loop already shows 1-3 bytes
    // per call. Code that really allocates per query cannot get below 16 bytes/call (one boxed number).
    const CALLS = 100000;
    const lines: string[] = [];
    for (const [name, fn] of cases) {
      let best = Infinity;
      for (let round = 0; round < 10 && best >= 4; round++) {
        const before = stats().total_allocated_bytes;
        for (let i = 0; i < CALLS; i++) fn(i & (N - 1));
        const perCall = (stats().total_allocated_bytes - before) / CALLS;
        if (perCall < best) best = perCall;
      }
      lines.push(`  ${name.padEnd(26)} ${best.toFixed(2)} bytes/call`);
      expect(best, name).toBeLessThan(8);
    }
    report(`World allocations per query (best round of ${CALLS} calls, measurement floor included):\n${lines.join('\n')}`);
    expect(sink).toBeGreaterThan(0);
  });
});

describe('World — benchmark (5000 boxes over 450 x 350 m)', () => {
  it('20000 raycasts of 120 m, 20000 moveBox calls, 200000 overlapsBox calls', () => {
    const rng = new Rng(20260908);
    const stage = benchmarkStage(rng);
    const t0 = performance.now();
    const world = new World(stage);
    const buildMs = performance.now() - t0;
    const ref = new RefWorld(stage);
    const legacy = legacyBoxes(stage); // the previous brute-force implementation, as the "before" figure
    const g = world.getGridInfo();
    expect(world.boxes.length).toBe(5007);

    const levels = [0, 8, 16, 24];
    // ── rays: enemy-eye-height origins, mostly level directions (lines of sight, bullets) ──
    const N_RAY = 20000;
    const rayO: V3[] = [];
    const rayD: V3[] = [];
    for (let i = 0; i < N_RAY; i++) {
      rayO.push(v3(rng.range(0, 450), levels[rng.int(4)] + rng.range(1, 5), rng.range(0, 350)));
      const yaw = rng.range(0, Math.PI * 2);
      const pitch = rng.range(-0.35, 0.35);
      rayD.push(v3(Math.cos(yaw) * Math.cos(pitch), Math.sin(pitch), Math.sin(yaw) * Math.cos(pitch)));
    }
    const scratch: RayHit = { dist: 0, point: v3(), normal: v3(), box: world.boxes[0] };
    // warm-up (JIT), then the measured pass
    for (let i = 0; i < 2000; i++) world.raycast(rayO[i], rayD[i], 120, scratch);
    let rayHits = 0;
    let distSum = 0;
    let t = performance.now();
    for (let i = 0; i < N_RAY; i++) {
      const hit = world.raycast(rayO[i], rayD[i], 120, scratch);
      if (hit) {
        rayHits++;
        distSum += hit.dist;
      }
    }
    const rayMs = performance.now() - t;

    t = performance.now();
    let segBlocked = 0;
    const end = v3();
    for (let i = 0; i < N_RAY; i++) {
      end.x = rayO[i].x + rayD[i].x * 120;
      end.y = rayO[i].y + rayD[i].y * 120;
      end.z = rayO[i].z + rayD[i].z * 120;
      if (world.segmentBlocked(rayO[i], end)) segBlocked++;
    }
    const segMs = performance.now() - t;

    // the previous brute-force implementation on a sample (scaled to the full count), for the speed-up figure
    const SAMPLE = 400;
    for (let i = 0; i < 50; i++) legacyRaycast(legacy, rayO[i], rayD[i], 120);
    t = performance.now();
    let legacyHits = 0;
    for (let i = 0; i < SAMPLE; i++) if (legacyRaycast(legacy, rayO[i], rayD[i], 120)) legacyHits++;
    const refRayMs = ((performance.now() - t) * N_RAY) / SAMPLE;
    // and a last equivalence check against the reference on the same sample
    let worldSampleHits = 0;
    for (let i = 0; i < SAMPLE; i++) {
      const w = world.raycast(rayO[i], rayD[i], 120);
      const r = ref.raycast(rayO[i], rayD[i], 120);
      if (w) worldSampleHits++;
      if ((w === null) !== (r === null) || (w && r && (!near(w.dist, r.dist) || world.boxes[r.idx] !== w.box))) fail(`benchmark ray ${i} differs from the reference`);
    }
    expect(worldSampleHits).toBe(legacyHits);

    // ── moves: a player-sized box at free positions, per-tick deltas (up to quick-boost speed) and longer ones ──
    const N_MOVE = 20000;
    const moveC: V3[] = [];
    const moveD: V3[] = [];
    while (moveC.length < N_MOVE) {
      const c = v3(rng.range(2, 448), levels[rng.int(4)] + 2 + rng.range(SKIN, 3), rng.range(2, 348));
      if (world.overlapsBox(c, PLAYER_HALF)) continue;
      moveC.push(c);
      const yaw = rng.range(0, Math.PI * 2);
      const len = rng.next() < 0.7 ? rng.range(0.05, 0.7) : rng.range(0.7, 5);
      moveD.push(v3(Math.cos(yaw) * len, rng.range(-0.3, 0.1), Math.sin(yaw) * len));
    }
    const res: MoveResult = { nx: 0, ny: 0, nz: 0 };
    const pos = v3();
    for (let i = 0; i < 2000; i++) {
      pos.x = moveC[i].x;
      pos.y = moveC[i].y;
      pos.z = moveC[i].z;
      world.moveBox(pos, PLAYER_HALF, moveD[i], res);
    }
    let moveContacts = 0;
    t = performance.now();
    for (let i = 0; i < N_MOVE; i++) {
      pos.x = moveC[i].x;
      pos.y = moveC[i].y;
      pos.z = moveC[i].z;
      world.moveBox(pos, PLAYER_HALF, moveD[i], res);
      if (res.nx !== 0 || res.ny !== 0 || res.nz !== 0) moveContacts++;
    }
    const moveMs = performance.now() - t;
    t = performance.now();
    for (let i = 0; i < SAMPLE; i++) {
      pos.x = moveC[i].x;
      pos.y = moveC[i].y;
      pos.z = moveC[i].z;
      legacyMoveBox(legacy, pos, PLAYER_HALF, moveD[i]);
    }
    const refMoveMs = ((performance.now() - t) * N_MOVE) / SAMPLE;
    for (let i = 0; i < SAMPLE; i++) {
      const a = { ...moveC[i] };
      const b = { ...moveC[i] };
      const rw = world.moveBox(a, PLAYER_HALF, moveD[i]);
      const rr = ref.moveBox(b, PLAYER_HALF, moveD[i]);
      if (!near(a.x, b.x) || !near(a.y, b.y) || !near(a.z, b.z) || rw.nx !== rr.nx || rw.ny !== rr.ny || rw.nz !== rr.nz) fail(`benchmark move ${i} differs from the reference`);
    }

    // ── ground probes for the same positions ──
    t = performance.now();
    let grounded = 0;
    for (let i = 0; i < N_MOVE; i++) if (world.probeGround(moveC[i], PLAYER_HALF, 0.05) !== Infinity) grounded++;
    const probeMs = performance.now() - t;

    // ── overlaps: voxel-sized boxes on a regular sweep (stage voxelisation) ──
    const N_OVER = 200000;
    const vh = v3(0.5, 0.5, 0.5);
    const vc = v3();
    for (let i = 0; i < 5000; i++) {
      vc.x = rng.range(0, 450);
      vc.y = rng.range(0, 30);
      vc.z = rng.range(0, 350);
      world.overlapsBox(vc, vh);
    }
    let solid = 0;
    t = performance.now();
    for (let i = 0; i < N_OVER; i++) {
      vc.x = 0.5 + (i % 450);
      vc.z = 0.5 + ((i * 7) % 350);
      vc.y = 0.5 + ((i * 13) % 30);
      if (world.overlapsBox(vc, vh)) solid++;
    }
    const overMs = performance.now() - t;
    let legacySolid = 0;
    let worldSolid = 0;
    const OS = 2000;
    t = performance.now();
    for (let i = 0; i < OS; i++) {
      vc.x = 0.5 + (i % 450);
      vc.z = 0.5 + ((i * 7) % 350);
      vc.y = 0.5 + ((i * 13) % 30);
      if (legacyOverlapsBox(legacy, vc, vh)) legacySolid++;
    }
    const refOverMs = ((performance.now() - t) * N_OVER) / OS;
    for (let i = 0; i < OS; i++) {
      vc.x = 0.5 + (i % 450);
      vc.z = 0.5 + ((i * 7) % 350);
      vc.y = 0.5 + ((i * 13) % 30);
      if (world.overlapsBox(vc, vh)) worldSolid++;
      if (world.overlapsBox(vc, vh) !== ref.overlapsBox(vc, vh)) fail(`benchmark overlap ${i} differs from the reference`);
    }
    expect(worldSolid).toBe(legacySolid);

    const line = (name: string, ms: number, n: number, refMs?: number): string =>
      `  ${name.padEnd(34)} ${ms.toFixed(1).padStart(8)} ms  ${((ms * 1e6) / n).toFixed(0).padStart(6)} ns/call` +
      (refMs !== undefined ? `   (previous brute force ≈ ${refMs.toFixed(0)} ms, ×${(refMs / ms).toFixed(0)})` : '');
    report(
      [
        `World benchmark — ${world.boxes.length} boxes, grid ${g.nx} x ${g.nz} cells of ${g.cellSize} m, ${g.entries} entries, ` +
          `${g.largeBoxes} always-tested boxes, built in ${buildMs.toFixed(1)} ms`,
        line(`${N_RAY} raycasts of 120 m`, rayMs, N_RAY, refRayMs) + `  hits ${rayHits}, mean hit dist ${(distSum / Math.max(1, rayHits)).toFixed(1)} m`,
        line(`${N_RAY} segmentBlocked of 120 m`, segMs, N_RAY) + `  blocked ${segBlocked}`,
        line(`${N_MOVE} moveBox`, moveMs, N_MOVE, refMoveMs) + `  with contact ${moveContacts}`,
        line(`${N_MOVE} probeGround`, probeMs, N_MOVE) + `  supported ${grounded}`,
        line(`${N_OVER} overlapsBox`, overMs, N_OVER, refOverMs) + `  solid ${solid}`,
      ].join('\n'),
    );

    expect(segBlocked).toBe(rayHits);
    expect(rayHits).toBeGreaterThan(N_RAY * 0.5);
    expect(moveContacts).toBeGreaterThan(1000);
    expect(solid).toBeGreaterThan(1000);
    expect(g.entries).toBeLessThan(100000);
    // Generous upper bounds: on a busy 2.5 GHz machine the measured values are 20-120 ms for the rays,
    // 10-70 ms for the moves and 30-230 ms for the overlaps, i.e. 40-500 times below these limits.
    expect(buildMs).toBeLessThan(5000);
    expect(rayMs).toBeLessThan(10000);
    expect(segMs).toBeLessThan(10000);
    expect(moveMs).toBeLessThan(10000);
    expect(probeMs).toBeLessThan(10000);
    expect(overMs).toBeLessThan(10000);
  });
});
