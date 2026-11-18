/**
 * Navigation for guards. OWNER: enemy agent.
 *
 * A sparse, lazily built grid over the static AABB world:
 *  - 2 m cells; every (ix, iz) column holds one node per walkable floor (top face of a box that has body clearance above it),
 *    so multi-storey stages work. Nodes are created only where a query (or the spawn flood-fill) touches them, which keeps
 *    the build limited to the region the enemies can actually reach.
 *  - Body clearance = the guard's hit sphere as an AABB (horizontal radius + margin, floor+0.3 .. floor+2.8), so head room and
 *    side room are both checked. Height differences up to MAX_STEP (0.3 m) are walkable, everything else is a wall or a drop.
 *  - Barrier / gate boxes are NOT baked into the grid. A node whose body overlaps a barrier box remembers the box indices and
 *    is passable only while every one of them is disabled (checked at query time), so opening a barrier changes paths without
 *    a rebuild. The grid is cached per World (see getNav), so a re-sortie re-uses it.
 *  - findPath = A* on the grid + string-pulling with exact body sweeps (walkProbe), so paths never clip corners.
 *  - Floor edges: a floor box is a closed region, so a point exactly on a seam (the shared face of two boxes) or on a rim counts as
 *    floor - but the guard's centre only has to drift 0.1 m off such a line and the ground under it is gone. Paths must therefore
 *    never run along an edge. Planning (nodes, string-pulled legs: any query with the body half extent BODY_HALF) requires the
 *    whole square footprint of half extent SUPPORT_PLAN around a point to stand on floor, so nodes and legs keep SUPPORT_PLAN
 *    from every drop (the seam between two boxes with the same top is not an edge: both sides support the footprint).
 *    Steering and integration (MOVE_HALF) keep the old point-on-floor rule, so a guard that is off the planned line by up to
 *    SUPPORT_PLAN (corner cutting, separation, sliding) still moves, and a goal on a rim can still be walked to.
 *
 * Limits worth knowing: the lattice is 2 m, the body needs 2.7 m of width, so a passage is guaranteed to be found from 4.7 m
 * width upwards (the stage's minimum corridor is 5 m); narrower gaps may or may not contain a lattice line.
 *
 * Incremental search: one findPath can expand ~8500 nodes (2-6 ms), more than a 120 Hz tick can spare. beginPath() runs the very same
 * search (same expansion order, same smoothing, so the result equals findPath's) as a PathJob that is advanced with a work budget per
 * call, so the AI can spread it over several ticks. A job keeps its search scratch in its own cell fields (j*), so plain findPath /
 * pathLength calls in between cannot disturb it (running two jobs alternately stays correct but restarts the search each time).
 */
import { ENEMIES } from '../config';
import type { IWorld, StageDef, V3 } from './types';

export const NAV = {
  /** grid cell size [m] */
  CELL: 2,
  /** spatial bucket size for the box index [m] */
  BUCKET: 16,
  /** clearance half extent used for planning (hit radius + margin) */
  BODY_HALF: ENEMIES.guard.hitRadius + 0.15,
  /** clearance half extent used for local steering (a little tighter than planning) */
  MOVE_HALF: ENEMIES.guard.hitRadius + 0.05,
  /** the hit sphere spans this height range above the floor: obstacles lower than BODY_BOTTOM are stepped over */
  BODY_BOTTOM: ENEMIES.guard.centerHeight - ENEMIES.guard.hitRadius,
  BODY_TOP: ENEMIES.guard.centerHeight + ENEMIES.guard.hitRadius + 0.1,
  /** max floor height difference between two neighbouring nodes / samples. = BODY_BOTTOM: the hit sphere hovers that far above the
   *  floor, so exactly the obstacles it passes over are the steps it can take (anything taller is a wall for the body test) */
  MAX_STEP: ENEMIES.guard.centerHeight - ENEMIES.guard.hitRadius,
  /** floor support of planning queries (half = BODY_HALF): half extent of the square footprint that must stand on floor [m].
   *  Larger than the corner cutting of the path follower (WAYPOINT_RADIUS 0.4 in enemies.ts) plus half a probe sample (SAMPLE / 2) */
  SUPPORT_PLAN: 0.75,
  /** floor support of steering / movement queries (half = MOVE_HALF): the point itself must be on floor */
  SUPPORT_MOVE: 0,
  /** sampling distance of straight-walk probes [m]: between two samples a box corner can poke at most ~0.35 * SAMPLE into the
   *  swept body box (0.14 m < the 0.15 m margin BODY_HALF has over the hit radius) */
  SAMPLE: 0.4,
  /** A* expansion cap per query (a query that exhausts it reports "no path") */
  MAX_EXPANSIONS: 60000,
  /** hard cap of nodes created by the spawn flood-fill */
  MAX_CELLS: 400000,
  /** PathJob work units: one A* node expansion = 1, one floor sample of a straight-walk probe (string pulling, start / goal
   *  resolution) = PROBE_WORK (a sample costs about a quarter of an expansion), resolving start and goal = RESOLVE_WORK on top */
  PROBE_WORK: 0.25,
  RESOLVE_WORK: 40,
} as const;

export interface NavPath {
  /** ground positions (feet-level floor points) from the start to the goal (or to the nearest reachable point when partial) */
  points: V3[];
  /** polyline length [m] */
  length: number;
  /** true when the goal was not reached: unreachable (the path leads to the reachable node closest to it) or not a spot the body can
   *  stand on (the path leads to the node nearest to it). The exact goal point is then not appended */
  partial: boolean;
}

export interface FindPathOptions {
  /** prune nodes whose A* estimate exceeds this grid cost [m] (bounded search) */
  maxCost?: number;
  /** when the goal is unreachable - or cannot be stood on (a player hugging a wall) - return a path to the closest reachable node instead of null */
  partial?: boolean;
  /** override of NAV.MAX_EXPANSIONS */
  maxExpansions?: number;
  /** heuristic weight (>= 1): 1 = optimal grid path, larger = fewer expansions, slightly longer paths */
  weight?: number;
  /** how far below the goal point a floor may lie and still count as "the ground under the goal" [m] */
  goalMaxBelow?: number;
}

export interface NavStats {
  columns: number;
  cells: number;
  queued: number;
  queries: number;
  expansions: number;
}

/** A path search that is advanced in slices (Nav.beginPath). Not tied to a tick or to real time: `budget` is in NAV work units. */
export interface PathJob {
  /** true once the search has finished (`result` is then valid) */
  readonly done: boolean;
  /** what findPath(from, to, opts) returns for the same arguments and world state (null = no path). Valid when `done` */
  readonly result: NavPath | null;
  /** work units spent so far (expansions + probe samples: see NAV.PROBE_WORK / RESOLVE_WORK) */
  readonly work: number;
  /** spend about `budget` work units (Infinity = run to the end); may overshoot by one node expansion / one smoothing anchor.
   *  Returns `done`. A finished job ignores further calls */
  step(budget: number): boolean;
}

export interface Nav {
  /** ground path from a to b (feet-level floor points), or null when unreachable (see FindPathOptions.partial) */
  findPath(from: V3, to: V3, opts?: FindPathOptions): NavPath | null;
  /** the same search as findPath, advanced in slices: see PathJob. Start and goal points are copied */
  beginPath(from: V3, to: V3, opts?: FindPathOptions): PathJob;
  /** length of the (smoothed) path, or null when there is none within maxLength */
  pathLength(from: V3, to: V3, maxLength?: number): number | null;
  /** walkable floor height at (x, z) within MAX_STEP of refY, or null (no floor or no body clearance). `half` = body clearance; the
   *  planning clearance (BODY_HALF) also demands the SUPPORT_PLAN footprint on floor, the default (MOVE_HALF) only the point itself */
  floorAt(x: number, z: number, refY: number, half?: number): number | null;
  /** highest floor with body clearance at (x, z) that is at most `y + MAX_STEP` and no more than `maxDrop` below y, or null */
  floorBelow(x: number, z: number, y: number, maxDrop?: number, half?: number): number | null;
  /** nearest standing spot (feet point) with full clearance within maxDist of (x, z) (used to fix up spawns that sit inside walls) */
  nearestFree(x: number, z: number, refY: number, maxDist?: number, half?: number): V3 | null;
  /** floor height reached at (x, z) when walking straight from `from` (feet point), or null when the walk is blocked */
  walkProbe(from: V3, x: number, z: number, half?: number): number | null;
  /** true when a straight walk between two feet points is possible (default: the planning clearance, so it stays off floor edges) */
  canStep(from: V3, to: V3, half?: number): boolean;
  /** true when the body has clearance when standing with its feet at (x, floorY, z) */
  isFree(x: number, floorY: number, z: number, half?: number): boolean;
  /** queue the region around a feet point for the background flood-fill (enemy spawn positions) */
  seed(p: V3): void;
  /** expand the flood-fill by up to maxCells nodes; returns the number of nodes still queued */
  warm(maxCells?: number): number;
  stats(): NavStats;
}

// ---------------------------------------------------------------------------------------------------------------------
// box index
// ---------------------------------------------------------------------------------------------------------------------
const BUCKET_OFF = 4096;
const bucketKey = (bx: number, bz: number): number => (bx + BUCKET_OFF) * 8192 + (bz + BUCKET_OFF);
const clampBucket = (b: number): number => (b < -BUCKET_OFF ? -BUCKET_OFF : b > BUCKET_OFF - 1 ? BUCKET_OFF - 1 : b);
const OVERLAP_EPS = 1e-4;
const SQRT2 = Math.SQRT2;
/** unit offsets of the footprint check points (corners and edge midpoints of the square around a standing point) */
const SUPPORT_RING: ReadonlyArray<readonly [number, number]> = [
  [1, 1], [1, -1], [-1, 1], [-1, -1],
  [1, 0], [-1, 0], [0, 1], [0, -1],
];
/** floor support radius for a body clearance: planning queries (BODY_HALF) keep off edges, steering/movement (MOVE_HALF) only need the point on floor */
const supportOf = (half: number): number => (half > NAV.MOVE_HALF + 1e-9 ? NAV.SUPPORT_PLAN : NAV.SUPPORT_MOVE);

class BoxIndex {
  readonly n: number;
  /** min xyz, max xyz per box */
  readonly b: Float64Array;
  readonly barrier: Uint8Array;
  private buckets = new Map<number, number[]>();
  private seen: Int32Array;
  private stamp = 0;
  /** reusable scratch for floor tops (+ their edge distances, see floorTops) / the y spans of the boxes covering one point */
  readonly tops: number[] = [];
  readonly edges = new Float64Array(64);
  private tops2: number[] = [];
  private spanLo = new Float64Array(64);
  private spanHi = new Float64Array(64);
  private spanEdge = new Float64Array(64);

  constructor(readonly world: IWorld, barrierIds: ReadonlySet<string>) {
    const boxes = world.boxes;
    this.n = boxes.length;
    this.b = new Float64Array(this.n * 6);
    this.barrier = new Uint8Array(this.n);
    this.seen = new Int32Array(this.n);
    for (let i = 0; i < this.n; i++) {
      const bx = boxes[i];
      const o = i * 6;
      this.b[o] = bx.min.x;
      this.b[o + 1] = bx.min.y;
      this.b[o + 2] = bx.min.z;
      this.b[o + 3] = bx.max.x;
      this.b[o + 4] = bx.max.y;
      this.b[o + 5] = bx.max.z;
      if (bx.barrierId !== undefined || barrierIds.has(bx.id)) this.barrier[i] = 1;
      if (!(bx.min.x <= bx.max.x && bx.min.y <= bx.max.y && bx.min.z <= bx.max.z)) continue; // also rejects NaN
      const x0 = clampBucket(Math.floor(bx.min.x / NAV.BUCKET));
      const x1 = clampBucket(Math.floor(bx.max.x / NAV.BUCKET));
      const z0 = clampBucket(Math.floor(bx.min.z / NAV.BUCKET));
      const z1 = clampBucket(Math.floor(bx.max.z / NAV.BUCKET));
      for (let ix = x0; ix <= x1; ix++) {
        for (let iz = z0; iz <= z1; iz++) {
          const k = bucketKey(ix, iz);
          const list = this.buckets.get(k);
          if (list) list.push(i);
          else this.buckets.set(k, [i]);
        }
      }
    }
  }

  /**
   * Distinct floor heights at (x, z): tops of enabled non-barrier boxes whose footprint contains the point and that are not buried
   * inside another such box (the slab under a low platform is not a floor). Unsorted; the returned array is reused.
   */
  floorTops(x: number, z: number, out: number[] = this.tops): number[] {
    out.length = 0;
    const list = this.buckets.get(bucketKey(clampBucket(Math.floor(x / NAV.BUCKET)), clampBucket(Math.floor(z / NAV.BUCKET))));
    if (!list) return out;
    const b = this.b;
    const world = this.world;
    const lo = this.spanLo;
    const hi = this.spanHi;
    let m = 0;
    for (let k = 0; k < list.length; k++) {
      const i = list[k];
      if (this.barrier[i]) continue;
      const o = i * 6;
      if (x < b[o] - 1e-6 || x > b[o + 3] + 1e-6 || z < b[o + 2] - 1e-6 || z > b[o + 5] + 1e-6) continue;
      if (!world.isBoxEnabled(i)) continue;
      if (m < lo.length) {
        lo[m] = b[o + 1];
        hi[m] = b[o + 4];
        m++;
      }
    }
    for (let a = 0; a < m; a++) {
      const top = hi[a];
      let buried = false;
      for (let c = 0; c < m; c++) {
        if (c !== a && lo[c] < top + 1e-3 && hi[c] > top + 1e-3) {
          buried = true;
          break;
        }
      }
      if (buried) continue;
      let dup = false;
      for (let j = 0; j < out.length; j++) {
        if (Math.abs(out[j] - top) < 1e-3) {
          dup = true;
          break;
        }
      }
      if (!dup) out.push(top);
    }
    return out;
  }

  /**
   * floorTops that also fills `this.edges` (parallel to the result; reused): edges[i] = the largest distance from (x, z) to the
   * footprint rim of a box carrying top i, i.e. a square of half extent <= edges[i] around the point lies entirely on that one box.
   * (A separate copy of the scan: the plain one stays lean for steering and integration, which never need the rim distance.)
   */
  floorTopsEdges(x: number, z: number): number[] {
    const out = this.tops;
    const edges = this.edges;
    out.length = 0;
    const list = this.buckets.get(bucketKey(clampBucket(Math.floor(x / NAV.BUCKET)), clampBucket(Math.floor(z / NAV.BUCKET))));
    if (!list) return out;
    const b = this.b;
    const world = this.world;
    const lo = this.spanLo;
    const hi = this.spanHi;
    const ed = this.spanEdge;
    let m = 0;
    for (let k = 0; k < list.length; k++) {
      const i = list[k];
      if (this.barrier[i]) continue;
      const o = i * 6;
      if (x < b[o] - 1e-6 || x > b[o + 3] + 1e-6 || z < b[o + 2] - 1e-6 || z > b[o + 5] + 1e-6) continue;
      if (!world.isBoxEnabled(i)) continue;
      if (m < lo.length) {
        lo[m] = b[o + 1];
        hi[m] = b[o + 4];
        let e = x - b[o];
        const e1 = b[o + 3] - x;
        const e2 = z - b[o + 2];
        const e3 = b[o + 5] - z;
        if (e1 < e) e = e1;
        if (e2 < e) e = e2;
        if (e3 < e) e = e3;
        ed[m] = e;
        m++;
      }
    }
    for (let a = 0; a < m; a++) {
      const top = hi[a];
      let buried = false;
      for (let c = 0; c < m; c++) {
        if (c !== a && lo[c] < top + 1e-3 && hi[c] > top + 1e-3) {
          buried = true;
          break;
        }
      }
      if (buried) continue;
      let dup = -1;
      for (let j = 0; j < out.length; j++) {
        if (Math.abs(out[j] - top) < 1e-3) {
          dup = j;
          break;
        }
      }
      if (dup < 0) {
        if (out.length < edges.length) edges[out.length] = ed[a];
        out.push(top);
      } else if (ed[a] > edges[dup]) edges[dup] = ed[a];
    }
    return out;
  }

  /** sort the result of the last default-scratch floorTops / floorTopsEdges call (insertion sort: there are 1-3 entries) */
  sortTops(descending: boolean, withEdges: boolean): void {
    const t = this.tops;
    const e = this.edges;
    for (let i = 1; i < t.length; i++) {
      const tv = t[i];
      const ev = withEdges ? e[i] : 0;
      let j = i - 1;
      while (j >= 0 && (descending ? t[j] < tv : t[j] > tv)) {
        t[j + 1] = t[j];
        if (withEdges) e[j + 1] = e[j];
        j--;
      }
      t[j + 1] = tv;
      if (withEdges) e[j + 1] = ev;
    }
  }

  /** is there a floor within MAX_STEP of `top` at (x, z)? (uses its own scratch: safe to call while the caller holds `tops`/`edges`) */
  private floorNear(x: number, z: number, top: number): boolean {
    const t = this.floorTops(x, z, this.tops2);
    for (let i = 0; i < t.length; i++) if (Math.abs(t[i] - top) <= NAV.MAX_STEP + 1e-6) return true;
    return false;
  }

  /**
   * Does the square footprint of half extent r around (x, z) stand on floor at (about) height `top`? `edge` is the rim distance
   * reported by floorTops for that top: when it is >= r the footprint lies on one box (no further lookups). Otherwise the eight
   * points around the centre (corners and edge midpoints) must all have floor: a rim, a drop or a hole of the footprint's size
   * fails, while the seam between two boxes carrying the same floor passes.
   */
  supported(x: number, z: number, top: number, edge: number, r: number): boolean {
    if (!(r > 0) || edge + 1e-9 >= r) return true;
    for (let k = 0; k < SUPPORT_RING.length; k++) {
      if (!this.floorNear(x + SUPPORT_RING[k][0] * r, z + SUPPORT_RING[k][1] * r, top)) return false;
    }
    return true;
  }

  /**
   * Does the body box (half extent `half`, floor+BODY_BOTTOM .. floor+BODY_TOP) at (cx, cz) overlap a solid?
   *  live=true : uses the current enabled flags of every box (barriers included).
   *  live=false: build mode - barrier boxes never block, they are collected into `barriers` instead.
   */
  bodyBlocked(cx: number, cz: number, floor: number, half: number, live: boolean, barriers: number[] | null): boolean {
    const x0 = cx - half;
    const x1 = cx + half;
    const z0 = cz - half;
    const z1 = cz + half;
    const y0 = floor + NAV.BODY_BOTTOM;
    const y1 = floor + NAV.BODY_TOP;
    const bx0 = clampBucket(Math.floor(x0 / NAV.BUCKET));
    const bx1 = clampBucket(Math.floor(x1 / NAV.BUCKET));
    const bz0 = clampBucket(Math.floor(z0 / NAV.BUCKET));
    const bz1 = clampBucket(Math.floor(z1 / NAV.BUCKET));
    const multi = bx0 !== bx1 || bz0 !== bz1;
    const stamp = multi ? ++this.stamp : 0;
    const b = this.b;
    const world = this.world;
    for (let ix = bx0; ix <= bx1; ix++) {
      for (let iz = bz0; iz <= bz1; iz++) {
        const list = this.buckets.get(bucketKey(ix, iz));
        if (!list) continue;
        for (let k = 0; k < list.length; k++) {
          const i = list[k];
          if (multi) {
            if (this.seen[i] === stamp) continue;
            this.seen[i] = stamp;
          }
          const o = i * 6;
          if (
            b[o] < x1 - OVERLAP_EPS && b[o + 3] > x0 + OVERLAP_EPS &&
            b[o + 2] < z1 - OVERLAP_EPS && b[o + 5] > z0 + OVERLAP_EPS &&
            b[o + 1] < y1 - OVERLAP_EPS && b[o + 4] > y0 + OVERLAP_EPS
          ) {
            if (this.barrier[i] && !live) {
              if (barriers && !barriers.includes(i)) barriers.push(i);
              continue;
            }
            if (!world.isBoxEnabled(i)) continue;
            return true;
          }
        }
      }
    }
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// grid
// ---------------------------------------------------------------------------------------------------------------------
interface Cell {
  ix: number;
  iz: number;
  x: number;
  z: number;
  /** floor height (feet level) */
  y: number;
  /** barrier boxes overlapping the body here (null = none). Passable only while all of them are disabled */
  barriers: number[] | null;
  // A* scratch (findPath)
  stamp: number;
  g: number;
  f: number;
  parent: Cell | null;
  closed: boolean;
  // A* scratch of the incremental search (PathJob): a separate set, so a job survives findPath calls between its slices
  jStamp: number;
  jG: number;
  jF: number;
  jParent: Cell | null;
  jClosed: boolean;
  // flood-fill
  queued: boolean;
  /** neighbours in DIRS order (static geometry only; barrier state is checked at use), computed on first expansion */
  adj: (Cell | null)[] | null;
}

function makeCell(ix: number, iz: number, x: number, z: number, y: number, barriers: number[] | null): Cell {
  return {
    ix, iz, x, z, y, barriers,
    stamp: 0, g: 0, f: 0, parent: null, closed: false, jStamp: 0, jG: 0, jF: 0, jParent: null, jClosed: false, queued: false, adj: null,
  };
}
{
  // Cells are created by the tens of thousands and V8 keys their hidden class on the representation of every field: a number field that
  // starts as a small integer and later receives a fraction (y, g, f), or a null field that later receives an object (parent, adj,
  // barriers), gives all later cells a new class and leaves every earlier one on a deprecated one. Optimized search code that meets such
  // an old cell deoptimizes ("wrong map") and the search runs at interpreter speed for a while (a 4-6 ms tick on the first big search of a
  // session, and again whenever a search reaches a region created earlier). One throwaway cell that already holds the general values
  // settles the classes before the first real cell exists. No effect on any result.
  const c = makeCell(0, 0, 0, 0, 0, null);
  c.y = 0.5;
  c.g = 0.5;
  c.f = 0.5;
  c.jG = 0.5;
  c.jF = 0.5;
  c.parent = c;
  c.jParent = c;
  c.adj = [];
  c.barriers = [0];
}

const DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

const colKey = (ix: number, iz: number): number => (ix + 1048576) * 2097152 + (iz + 1048576);

class MinHeap {
  private a: Cell[] = [];
  get size(): number {
    return this.a.length;
  }
  clear(): void {
    this.a.length = 0;
  }
  push(c: Cell): void {
    const a = this.a;
    let i = a.length;
    a.push(c);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].f <= c.f) break;
      a[i] = a[p];
      i = p;
    }
    a[i] = c;
  }
  pop(): Cell | undefined {
    const a = this.a;
    if (a.length === 0) return undefined;
    const top = a[0];
    const last = a.pop() as Cell;
    if (a.length > 0) {
      let i = 0;
      const n = a.length;
      for (;;) {
        let l = 2 * i + 1;
        if (l >= n) break;
        if (l + 1 < n && a[l + 1].f < a[l].f) l++;
        if (a[l].f >= last.f) break;
        a[i] = a[l];
        i = l;
      }
      a[i] = last;
    }
    return top;
  }
}

/** MinHeap keyed by jF: the incremental search's own copy (the two searches must not share keys). Keep it in step with MinHeap, the
 *  expansion order decides the path and a PathJob's result must equal findPath's */
class MinHeapJ {
  private a: Cell[] = [];
  get size(): number {
    return this.a.length;
  }
  clear(): void {
    this.a.length = 0;
  }
  push(c: Cell): void {
    const a = this.a;
    let i = a.length;
    a.push(c);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].jF <= c.jF) break;
      a[i] = a[p];
      i = p;
    }
    a[i] = c;
  }
  pop(): Cell | undefined {
    const a = this.a;
    if (a.length === 0) return undefined;
    const top = a[0];
    const last = a.pop() as Cell;
    if (a.length > 0) {
      let i = 0;
      const n = a.length;
      for (;;) {
        let l = 2 * i + 1;
        if (l >= n) break;
        if (l + 1 < n && a[l + 1].jF < a[l].jF) l++;
        if (a[l].jF >= last.jF) break;
        a[i] = a[l];
        i = l;
      }
      a[i] = last;
    }
    return top;
  }
}

/** string pulling in progress: the node path, the pulled points so far and the anchor */
interface SmoothState {
  raw: V3[];
  out: V3[];
  i: number;
}

/** PathJob implementation: plain state, GridNav.jobSlice does the work */
class PathJobImpl implements PathJob {
  done = false;
  result: NavPath | null = null;
  work = 0;
  /** 0 = start / goal not resolved yet, 1 = A*, 2 = string pulling */
  phase = 0;
  readonly from: V3;
  readonly to: V3;
  start!: Cell;
  goal!: Cell;
  endY = 0;
  approx = false;
  maxExp = 0;
  maxCost = 0;
  wgt = 1;
  /** stamp of the A* in progress (0 = not begun) */
  sid = 0;
  readonly heap = new MinHeapJ();
  found: Cell | null = null;
  nearest!: Cell;
  nearestH = 0;
  expansions = 0;
  partial = false;
  sm: SmoothState | null = null;

  readonly opts: FindPathOptions;

  constructor(private readonly nav: GridNav, from: V3, to: V3, opts: FindPathOptions) {
    this.from = { x: from.x, y: from.y, z: from.z };
    this.to = { x: to.x, y: to.y, z: to.z };
    this.opts = { ...opts };
  }

  step(budget: number): boolean {
    return this.nav.stepJob(this, budget);
  }

  finish(result: NavPath | null): void {
    this.result = result;
    this.done = true;
  }
}

class GridNav implements Nav {
  private idx: BoxIndex;
  private columns = new Map<number, Cell[]>();
  private cellCount = 0;
  private queue: Cell[] = [];
  private queueHead = 0;
  private searchId = 0;
  private heap = new MinHeap();
  private nQueries = 0;
  private nExpansions = 0;
  /** floor samples taken by straight-walk probes (the work measure of string pulling, see PathJob) */
  private nSamples = 0;
  /** incremental searches: last stamp handed out / stamp of the job that owns the j* scratch of the cells right now */
  private jobSearchId = 0;
  private jobOwner = 0;

  constructor(private world: IWorld, barrierIds: ReadonlySet<string>) {
    this.idx = new BoxIndex(world, barrierIds);
  }

  // ------------------------------------------------------------------ columns / cells
  private getColumn(ix: number, iz: number): Cell[] {
    const key = colKey(ix, iz);
    let col = this.columns.get(key);
    if (col) return col;
    col = [];
    const x = ix * NAV.CELL;
    const z = iz * NAV.CELL;
    const tops = this.idx.floorTopsEdges(x, z);
    const edges = this.idx.edges;
    this.idx.sortTops(false, true);
    for (let oi = 0; oi < tops.length; oi++) {
      const top = tops[oi];
      const barriers: number[] = [];
      if (this.idx.bodyBlocked(x, z, top, NAV.BODY_HALF, false, barriers)) continue;
      if (edges[oi] + 1e-9 < NAV.SUPPORT_PLAN && !this.idx.supported(x, z, top, edges[oi], NAV.SUPPORT_PLAN)) continue; // on / next to an edge: not a node
      col.push(makeCell(ix, iz, x, z, top, barriers.length > 0 ? barriers : null));
      this.cellCount++;
    }
    this.columns.set(key, col);
    return col;
  }

  private passable(c: Cell): boolean {
    const bs = c.barriers;
    if (bs === null) return true;
    for (let i = 0; i < bs.length; i++) if (this.world.isBoxEnabled(bs[i])) return false;
    return true;
  }

  private neighbor(c: Cell, dx: number, dz: number, ignoreBarriers: boolean): Cell | null {
    const col = this.getColumn(c.ix + dx, c.iz + dz);
    let best: Cell | null = null;
    let bd = Infinity;
    for (let i = 0; i < col.length; i++) {
      const n = col[i];
      const d = Math.abs(n.y - c.y);
      if (d <= NAV.MAX_STEP + 1e-6 && d < bd && (ignoreBarriers || this.passable(n))) {
        best = n;
        bd = d;
      }
    }
    return best;
  }

  /**
   * The 8 neighbours of a node in DIRS order, ignoring barrier state (cached: the geometry never changes). Diagonals honour the
   * "no corner cutting" rule (both orthogonal neighbours must exist).
   */
  private adjacency(c: Cell): (Cell | null)[] {
    if (c.adj) return c.adj;
    const a: (Cell | null)[] = new Array(8);
    for (let d = 0; d < 4; d++) a[d] = this.neighbor(c, DIRS[d][0], DIRS[d][1], true);
    for (let d = 4; d < 8; d++) {
      const dx = DIRS[d][0];
      const dz = DIRS[d][1];
      const ox = dx > 0 ? 0 : 1; // index of (dx, 0) in DIRS
      const oz = dz > 0 ? 2 : 3; // index of (0, dz)
      a[d] = a[ox] !== null && a[oz] !== null ? this.neighbor(c, dx, dz, true) : null;
    }
    c.adj = a;
    return a;
  }

  /** neighbour of c in direction index d that can be entered right now (barrier state read live), or null */
  private enter(c: Cell, a: (Cell | null)[], d: number): Cell | null {
    const n = a[d];
    if (n === null || !this.passable(n)) return null;
    if (d >= 4) {
      const ox = DIRS[d][0] > 0 ? 0 : 1;
      const oz = DIRS[d][1] > 0 ? 2 : 3;
      if (!this.passable(a[ox] as Cell) || !this.passable(a[oz] as Cell)) return null;
    }
    return n;
  }

  // ------------------------------------------------------------------ precise local queries (live world state)
  isFree(x: number, floorY: number, z: number, half: number = NAV.MOVE_HALF): boolean {
    return !this.idx.bodyBlocked(x, z, floorY, half, true, null);
  }

  floorAt(x: number, z: number, refY: number, half: number = NAV.MOVE_HALF): number | null {
    const support = supportOf(half);
    const tops = support > 0 ? this.idx.floorTopsEdges(x, z) : this.idx.floorTops(x, z);
    const edges = this.idx.edges;
    const n = Math.min(tops.length, 30);
    // try the candidates closest to refY first (n is tiny: repeated selection with a used-mask)
    let used = 0;
    for (let tried = 0; tried < n; tried++) {
      let bi = -1;
      let bd = Infinity;
      for (let i = 0; i < n; i++) {
        if (used & (1 << i)) continue;
        const d = Math.abs(tops[i] - refY);
        if (d < bd) {
          bd = d;
          bi = i;
        }
      }
      if (bi < 0 || bd > NAV.MAX_STEP + 1e-6) return null;
      used |= 1 << bi;
      const top = tops[bi];
      if (!this.idx.bodyBlocked(x, z, top, half, true, null) && (support <= 0 || edges[bi] + 1e-9 >= support || this.idx.supported(x, z, top, edges[bi], support))) return top;
    }
    return null;
  }

  floorBelow(x: number, z: number, y: number, maxDrop = 6, half: number = NAV.MOVE_HALF): number | null {
    const support = supportOf(half);
    const tops = support > 0 ? this.idx.floorTopsEdges(x, z) : this.idx.floorTops(x, z);
    const edges = this.idx.edges;
    this.idx.sortTops(true, support > 0);
    for (let oi = 0; oi < tops.length; oi++) {
      const top = tops[oi];
      if (top > y + NAV.MAX_STEP + 1e-6) continue;
      if (top < y - maxDrop) return null;
      if (!this.idx.bodyBlocked(x, z, top, half, true, null) && (support <= 0 || edges[oi] + 1e-9 >= support || this.idx.supported(x, z, top, edges[oi], support))) return top;
    }
    return null;
  }

  nearestFree(x: number, z: number, refY: number, maxDist = 6, half: number = NAV.BODY_HALF): V3 | null {
    const STEP = 0.5;
    const n = Math.ceil(maxDist / STEP);
    const offs: { dx: number; dz: number; d: number }[] = [];
    for (let i = -n; i <= n; i++) {
      for (let j = -n; j <= n; j++) {
        const d = Math.hypot(i, j) * STEP;
        if (d <= maxDist) offs.push({ dx: i * STEP, dz: j * STEP, d });
      }
    }
    offs.sort((a, b) => a.d - b.d);
    for (const o of offs) {
      const f = this.floorBelow(x + o.dx, z + o.dz, refY, 2, half);
      if (f !== null) return { x: x + o.dx, y: f, z: z + o.dz };
    }
    return null;
  }

  walkProbe(from: V3, x: number, z: number, half: number = NAV.MOVE_HALF): number | null {
    const dx = x - from.x;
    const dz = z - from.z;
    const len = Math.hypot(dx, dz);
    const n = Math.max(1, Math.ceil(len / NAV.SAMPLE));
    this.nSamples += n;
    let ref = from.y;
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const f = this.floorAt(from.x + dx * t, from.z + dz * t, ref, half);
      if (f === null) return null;
      ref = f;
    }
    return ref;
  }

  canStep(from: V3, to: V3, half: number = NAV.BODY_HALF): boolean {
    const y = this.walkProbe(from, to.x, to.z, half);
    return y !== null && Math.abs(y - to.y) <= NAV.MAX_STEP + 1e-6;
  }

  // ------------------------------------------------------------------ start / goal resolution
  private candidates(p: V3, ring: number, maxBelow: number): { c: Cell; score: number }[] {
    const ix0 = Math.round(p.x / NAV.CELL);
    const iz0 = Math.round(p.z / NAV.CELL);
    const out: { c: Cell; score: number }[] = [];
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dz = -ring; dz <= ring; dz++) {
        const col = this.getColumn(ix0 + dx, iz0 + dz);
        for (let k = 0; k < col.length; k++) {
          const c = col[k];
          const dy = c.y - p.y;
          if (dy > NAV.MAX_STEP + 0.4 || dy < -maxBelow) continue;
          out.push({ c, score: Math.hypot(c.x - p.x, c.z - p.z) + 2 * Math.abs(dy) });
        }
      }
    }
    out.sort((a, b) => a.score - b.score);
    return out;
  }

  private resolveStart(p: V3): Cell | null {
    const cands = this.candidates(p, 2, 3);
    for (const { c } of cands) {
      if (Math.hypot(c.x - p.x, c.z - p.z) < 0.05) return c;
      if (this.walkProbe(p, c.x, c.z) !== null) return c;
    }
    return null;
  }

  /** nearest node to a goal point that can walk to it; `endY` = floor height at the goal point */
  private resolveGoal(p: V3, maxBelow: number): { cell: Cell; endY: number } | null {
    const cands = this.candidates(p, 3, maxBelow);
    for (const { c } of cands) {
      if (Math.hypot(c.x - p.x, c.z - p.z) < 0.05) return { cell: c, endY: c.y };
      const y = this.walkProbe({ x: c.x, y: c.y, z: c.z }, p.x, p.z);
      if (y !== null) return { cell: c, endY: y };
    }
    return null;
  }

  // ------------------------------------------------------------------ path search
  /** start node, goal node (+ the floor height at the goal point) of a query; null when there is nothing to search for */
  private resolveEndpoints(from: V3, to: V3, opts: FindPathOptions): { start: Cell; goalRes: { cell: Cell; endY: number }; approx: boolean } | null {
    const start = this.resolveStart(from);
    if (start === null) return null;
    const goalMaxBelow = opts.goalMaxBelow ?? 24;
    let goalRes = this.resolveGoal(to, goalMaxBelow);
    // the goal point is a spot the body cannot stand on (a player hugging a wall or a rack post): a partial query heads for the
    // node nearest to it instead of giving up (the guard then closes in as far as it can rather than freezing where it is)
    let approx = false;
    if (goalRes === null && opts.partial) {
      for (const { c } of this.candidates(to, 3, goalMaxBelow)) {
        if (!this.passable(c)) continue;
        goalRes = { cell: c, endY: c.y };
        approx = true;
        break;
      }
    }
    if (goalRes === null) return null;
    if (!this.passable(goalRes.cell)) return null;
    return { start, goalRes, approx };
  }

  /** the exact start / goal points join the node path when they can be walked to from the neighbouring node */
  private extendRaw(raw: V3[], from: V3, to: V3, partial: boolean, endY: number): void {
    if (Math.hypot(raw[0].x - from.x, raw[0].z - from.z) > 0.3) {
      const fy = this.floorAt(from.x, from.z, from.y);
      raw.unshift({ x: from.x, y: fy ?? from.y, z: from.z });
    }
    if (!partial && Math.hypot(raw[raw.length - 1].x - to.x, raw[raw.length - 1].z - to.z) > 0.3) {
      raw.push({ x: to.x, y: endY, z: to.z });
    }
  }

  private static pathOf(points: V3[], partial: boolean): NavPath {
    let length = 0;
    for (let i = 1; i < points.length; i++) {
      length += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y, points[i].z - points[i - 1].z);
    }
    return { points, length, partial };
  }

  findPath(from: V3, to: V3, opts: FindPathOptions = {}): NavPath | null {
    this.nQueries++;
    const ends = this.resolveEndpoints(from, to, opts);
    if (ends === null) return null;
    const { start, goalRes, approx } = ends;
    const goal = goalRes.cell;

    const maxExp = opts.maxExpansions ?? NAV.MAX_EXPANSIONS;
    const maxCost = opts.maxCost ?? Infinity;
    const sid = ++this.searchId;
    const heap = this.heap;
    heap.clear();
    const gix = goal.ix;
    const giz = goal.iz;
    const wgt = Math.max(1, opts.weight ?? 1);
    const hOf = (c: Cell): number => {
      const ddx = Math.abs(c.ix - gix);
      const ddz = Math.abs(c.iz - giz);
      return NAV.CELL * (Math.max(ddx, ddz) + (SQRT2 - 1) * Math.min(ddx, ddz));
    };
    start.stamp = sid;
    start.g = 0;
    start.f = wgt * hOf(start);
    start.parent = null;
    start.closed = false;
    heap.push(start);

    let found: Cell | null = null;
    let nearest: Cell = start;
    let nearestH = hOf(start);
    let expansions = 0;
    while (heap.size > 0) {
      const c = heap.pop() as Cell;
      if (c.closed) continue;
      c.closed = true;
      if (c === goal) {
        found = c;
        break;
      }
      if (++expansions > maxExp) break;
      const h = hOf(c);
      if (h < nearestH) {
        nearestH = h;
        nearest = c;
      }
      const adj = this.adjacency(c);
      for (let d = 0; d < 8; d++) {
        const n = this.enter(c, adj, d);
        if (n === null) continue;
        const g = c.g + (d >= 4 ? NAV.CELL * SQRT2 : NAV.CELL);
        if (n.stamp === sid) {
          if (n.closed || g >= n.g) continue;
        } else {
          n.stamp = sid;
          n.closed = false;
        }
        if (g + hOf(n) > maxCost) continue;
        const f = g + wgt * hOf(n);
        n.g = g;
        n.f = f;
        n.parent = c;
        heap.push(n);
      }
    }
    this.nExpansions += expansions;

    let partial = approx;
    let endCell: Cell;
    if (found) {
      endCell = found;
    } else if (opts.partial && nearest !== start) {
      endCell = nearest;
      partial = true;
    } else {
      return null;
    }

    const cells: Cell[] = [];
    for (let c: Cell | null = endCell; c !== null; c = c.parent) cells.push(c);
    cells.reverse();
    const raw: V3[] = cells.map((c) => ({ x: c.x, y: c.y, z: c.z }));
    this.extendRaw(raw, from, to, partial, goalRes.endY);
    return GridNav.pathOf(this.smooth(raw), partial);
  }

  /** string pulling with exact body sweeps: keep the farthest waypoint that can be walked to straight from the anchor */
  private smooth(raw: V3[]): V3[] {
    if (raw.length <= 2) return raw;
    const st: SmoothState = { raw, out: [raw[0]], i: 0 };
    while (!this.smoothStep(st));
    return st.out;
  }

  /** one anchor of the string pulling (the unit a PathJob slices at); true when the whole path has been pulled */
  private smoothStep(st: SmoothState): boolean {
    const raw = st.raw;
    const n = raw.length;
    const i = st.i;
    if (i >= n - 1) return true;
    const LOOK = 40;
    let j = Math.min(n - 1, i + LOOK);
    // the goal itself first: one straight leg when nothing is in the way, however far
    if (j < n - 1 && this.canStep(raw[i], raw[n - 1])) j = n - 1;
    else while (j > i + 1 && !this.canStep(raw[i], raw[j])) j--;
    st.out.push(raw[j]);
    st.i = j;
    return j >= n - 1;
  }

  // ------------------------------------------------------------------ incremental path search (PathJob)
  beginPath(from: V3, to: V3, opts: FindPathOptions = {}): PathJob {
    this.nQueries++;
    return new PathJobImpl(this, from, to, opts);
  }

  /** internal (PathJobImpl.step): advance a job by about `budget` work units */
  stepJob(j: PathJobImpl, budget: number): boolean {
    if (!j.done) j.work += this.jobSlice(j, budget);
    return j.done;
  }

  /** one slice of a job: returns the work spent. The A* loop is findPath's on the j* scratch (same order, same ties), paused between expansions */
  private jobSlice(j: PathJobImpl, budget: number): number {
    let spent = 0;
    if (j.phase === 0) {
      const s0 = this.nSamples;
      const ends = this.resolveEndpoints(j.from, j.to, j.opts);
      spent += NAV.RESOLVE_WORK + (this.nSamples - s0) * NAV.PROBE_WORK;
      if (ends === null) {
        j.finish(null);
        return spent;
      }
      j.start = ends.start;
      j.goal = ends.goalRes.cell;
      j.endY = ends.goalRes.endY;
      j.approx = ends.approx;
      j.maxExp = j.opts.maxExpansions ?? NAV.MAX_EXPANSIONS;
      j.maxCost = j.opts.maxCost ?? Infinity;
      j.wgt = Math.max(1, j.opts.weight ?? 1);
      j.phase = 1;
    }
    if (j.phase === 1) {
      const goal = j.goal;
      const gix = goal.ix;
      const giz = goal.iz;
      const wgt = j.wgt;
      const hOf = (c: Cell): number => {
        const ddx = Math.abs(c.ix - gix);
        const ddz = Math.abs(c.iz - giz);
        return NAV.CELL * (Math.max(ddx, ddz) + (SQRT2 - 1) * Math.min(ddx, ddz));
      };
      const heap = j.heap;
      if (j.sid === 0 || this.jobOwner !== j.sid) {
        // first slice, or another job has used the j* scratch since (two jobs stepped alternately): (re)start the search
        j.sid = ++this.jobSearchId;
        this.jobOwner = j.sid;
        heap.clear();
        const start = j.start;
        start.jStamp = j.sid;
        start.jG = 0;
        start.jF = wgt * hOf(start);
        start.jParent = null;
        start.jClosed = false;
        heap.push(start);
        j.found = null;
        j.nearest = start;
        j.nearestH = hOf(start);
        j.expansions = 0;
      }
      const sid = j.sid;
      const maxExp = j.maxExp;
      const maxCost = j.maxCost;
      const expansions0 = j.expansions;
      let found = j.found;
      let nearest = j.nearest;
      let nearestH = j.nearestH;
      let expansions = expansions0;
      let paused = false;
      while (heap.size > 0) {
        if (spent >= budget) {
          paused = true;
          break;
        }
        const c = heap.pop() as Cell;
        if (c.jClosed) continue;
        c.jClosed = true;
        if (c === goal) {
          found = c;
          break;
        }
        if (++expansions > maxExp) break;
        spent += 1;
        const h = hOf(c);
        if (h < nearestH) {
          nearestH = h;
          nearest = c;
        }
        const adj = this.adjacency(c);
        for (let d = 0; d < 8; d++) {
          const n = this.enter(c, adj, d);
          if (n === null) continue;
          const g = c.jG + (d >= 4 ? NAV.CELL * SQRT2 : NAV.CELL);
          if (n.jStamp === sid) {
            if (n.jClosed || g >= n.jG) continue;
          } else {
            n.jStamp = sid;
            n.jClosed = false;
          }
          if (g + hOf(n) > maxCost) continue;
          const f = g + wgt * hOf(n);
          n.jG = g;
          n.jF = f;
          n.jParent = c;
          heap.push(n);
        }
      }
      j.found = found;
      j.nearest = nearest;
      j.nearestH = nearestH;
      j.expansions = expansions;
      this.nExpansions += expansions - expansions0;
      if (paused) return spent;

      let partial = j.approx;
      let endCell: Cell;
      if (found) {
        endCell = found;
      } else if (j.opts.partial && nearest !== j.start) {
        endCell = nearest;
        partial = true;
      } else {
        j.finish(null);
        return spent;
      }
      const cells: Cell[] = [];
      for (let c: Cell | null = endCell; c !== null; c = c.jParent) cells.push(c);
      cells.reverse();
      const raw: V3[] = cells.map((c) => ({ x: c.x, y: c.y, z: c.z }));
      const s0 = this.nSamples;
      this.extendRaw(raw, j.from, j.to, partial, j.endY);
      spent += (this.nSamples - s0) * NAV.PROBE_WORK;
      j.partial = partial;
      heap.clear();
      if (raw.length <= 2) {
        j.finish(GridNav.pathOf(raw, partial));
        return spent;
      }
      j.sm = { raw, out: [raw[0]], i: 0 };
      j.phase = 2;
    }
    // phase 2: string pulling, one anchor at a time
    const sm = j.sm as SmoothState;
    let done = false;
    while (!done && spent < budget) {
      const s0 = this.nSamples;
      done = this.smoothStep(sm);
      spent += (this.nSamples - s0) * NAV.PROBE_WORK;
    }
    if (done) {
      j.finish(GridNav.pathOf(sm.out, j.partial));
      j.sm = null;
    }
    return spent;
  }

  pathLength(from: V3, to: V3, maxLength: number = Infinity): number | null {
    // grid cost overestimates the smoothed length by <= ~8 %: leave headroom, then check the real length
    const p = this.findPath(from, to, { maxCost: Number.isFinite(maxLength) ? maxLength * 1.2 + NAV.CELL * 2 : Infinity });
    if (p === null || p.partial) return null;
    return p.length <= maxLength ? p.length : null;
  }

  // ------------------------------------------------------------------ region flood-fill
  seed(p: V3): void {
    const c = this.resolveStart(p);
    if (c !== null && !c.queued) {
      c.queued = true;
      this.queue.push(c);
    }
  }

  warm(maxCells = 256): number {
    let budget = maxCells;
    while (budget > 0 && this.queueHead < this.queue.length && this.cellCount < NAV.MAX_CELLS) {
      const c = this.queue[this.queueHead++];
      budget--;
      const adj = this.adjacency(c);
      for (let d = 0; d < 8; d++) {
        const n = adj[d];
        if (n !== null && !n.queued) {
          n.queued = true;
          this.queue.push(n);
        }
      }
    }
    if (this.queueHead > 4096 && this.queueHead * 2 > this.queue.length) {
      this.queue = this.queue.slice(this.queueHead);
      this.queueHead = 0;
    }
    return this.queue.length - this.queueHead;
  }

  stats(): NavStats {
    return {
      columns: this.columns.size,
      cells: this.cellCount,
      queued: this.queue.length - this.queueHead,
      queries: this.nQueries,
      expansions: this.nExpansions,
    };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// construction / cache
// ---------------------------------------------------------------------------------------------------------------------
function barrierBoxIds(stage?: StageDef): Set<string> {
  const ids = new Set<string>();
  if (stage) for (const b of stage.barriers) for (const id of b.boxIds) ids.add(id);
  return ids;
}

/** Build a fresh navigation grid over `world` (cheap: only the box index is built up front, nodes are created on demand). */
export function buildNav(world: IWorld, stage?: StageDef): Nav {
  return new GridNav(world, barrierBoxIds(stage));
}

const cache = new WeakMap<IWorld, Nav>();

/** Nav cached per World: a re-sortie (new GameState, same World) re-uses the grid; barrier state is read at query time. */
export function getNav(world: IWorld, stage?: StageDef): Nav {
  let nav = cache.get(world);
  if (!nav) {
    nav = buildNav(world, stage);
    cache.set(world, nav);
  }
  return nav;
}
