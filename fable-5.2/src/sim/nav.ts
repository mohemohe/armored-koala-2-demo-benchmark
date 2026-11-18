/**
 * NavGrid — walkable-floor navigation for the guard robots (docs/SPEC.md §2.3, docs/ARCHITECTURE.md §4).
 *
 * All positions are guard hit-sphere centres (floor height + ENEMIES.guard.centerHeight).
 *
 * MODEL
 *   The agent is the box of half extents (r, r, r), r = ENEMIES.guard.radius, around the hit-sphere centre.
 *   The stage is sampled on a square lattice (1 m by default) whose points are the cell centres. A lattice
 *   point is a NODE for every floor (top face of a solid that contains the point in its footprint) on which
 *   the agent box, standing with its centre exactly above the point, overlaps no solid. Stacked floors give
 *   several nodes per column ("levels"); two levels of one column are always more than r + centerHeight
 *   apart. Orthogonal neighbours are LINKED when their floors differ by at most 0.3 m — there is no
 *   climbing and no dropping off a ledge (a column without floor at that height simply has no node).
 *   A diagonal step needs the two orthogonal neighbours and the diagonal node: all four corners of the
 *   lattice square, usable (not under a closed barrier) and mutually linked.
 *
 *   Because the lattice spacing is smaller than the agent (cell <= 2r), the agent's footprint at any point
 *   of a lattice square is covered by its footprints at the square's four corners, and at any point of a
 *   lattice edge by those at its two ends. The WALKABLE AREA is therefore defined exactly as
 *     nodes ∪ edges between linked nodes ∪ squares whose four corners are usable and mutually linked,
 *   and on a flat floor everything inside it is collision-free by construction (no sampling): `isWalkable`,
 *   `segmentWalkable`, `walkableReach` and the smoothed paths of `findPath` all use this one definition.
 *   It is conservative by at most one cell next to obstacles and ledges: a spot where the agent would
 *   physically fit but that lies outside the hull of the surrounding nodes is "not walkable"; paths
 *   starting from such a spot first lead to the nearest node.
 *   Limits of the sampling: a hole in the floor that contains no lattice point (narrower than one cell) is
 *   not seen, and where linked floors differ in height (steps of at most 0.1 m pass the clearance test) an
 *   agent whose y is interpolated between two nodes can graze the higher step by less than that.
 *
 * BARRIERS
 *   The node set is built with every barrier / the final gate absent. Each closable box blocks the nodes
 *   whose agent box it overlaps while it is closed (`setBarrierOpen`, `reset` = all closed). The grid keeps
 *   its own barrier state; the World's state is restored after the build and never modified afterwards.
 *
 * SEARCH
 *   A* over the 8-connected nodes: XZ distance costs, octile heuristic (the exact metric of an empty
 *   8-connected grid, never below the straight line, consistent), binary heap with lazy deletion, bounded
 *   expansions. Successors whose f equals the f of the node being expanded skip the heap (LIFO stack): they
 *   would be popped next anyway, and it makes the search run straight at the goal across open floor.
 *   Connected regions are labelled (re-labelled lazily after a barrier change), so an unreachable goal is
 *   rejected without a search. The node path is pulled tight with the exact segment test. The usable
 *   neighbours of every node (orthogonal + diagonal, closed barriers removed) are kept in one table that is
 *   patched locally whenever a barrier changes, so no query ever tests a barrier.
 *
 * OBSTACLES AND AVOIDANCE (other enemies)
 *   A living fixed turret is a static obstacle for the guards: `setObstacle` blocks every node whose standing
 *   centre is nearer to it than the distance the guards keep, exactly like a closed barrier — so the walkable
 *   area, every path, every reach test and the region labels leave it out, and no guard is ever planned
 *   through it. Removing it (the turret was destroyed) frees the nodes again; the region labels are patched
 *   locally unless two regions merge.
 *   Guards move, so they are no part of the grid. `findPath(…, { avoid })` plans one path around the given
 *   spheres (the positions of the guards that are in the way right now): banned nodes are skipped by the
 *   search and no pulled segment may cut into a sphere.
 *
 * VANTAGE SEARCH
 *   `findVantage` floods the region of a guard in order of path length (Dijkstra) and returns the first
 *   standing spot within a given distance of a target from which the world has a clear line to it — the way
 *   a guard without any route to the player's floor closes in along its own gallery, or goes to look at a
 *   reported position. Without such a spot it can return the explored spot nearest to the target instead.
 *
 * The grid is built in the constructor when the stage contains guards (so that no frame of a sortie pays
 * for it), otherwise on first use (`build()` forces it); a stage without guards costs nothing. No query
 * allocates anything but its returned result (scratch buffers grow to their working size and are reused);
 * nothing here is random or time dependent, except `randomWalkableNear`, which draws from the generator
 * handed to it (sim.rng).
 */
import { ENEMIES } from '../config';
import type { V3 } from '../core/vec';
import type { StageDef } from './types';
import type { World, WorldBox } from './world';

export interface NavOptions {
  /** Lattice spacing in metres (default 1). Clamped to [0.25, 2 · guard radius]. */
  cellSize?: number;
  /** A* gives up (no path) after expanding this many nodes (default 80000). */
  maxExpansions?: number;
  /**
   * Upper bound on lattice columns (default 1.5 million, i.e. 1.2 km x 1.2 km at 1 m). A larger stage gets a
   * coarser lattice (up to 2 · guard radius) and, if that is still too many, only a square window around
   * its guards is covered — everything outside it is simply not walkable.
   */
  maxColumns?: number;
}

/** Layout and size of the built grid (diagnostics, tests, tools). */
export interface NavInfo {
  cellSize: number;
  /** World X / Z of the corner of cell (0, 0); the node of cell (i, j) is at origin + (i + 0.5, j + 0.5) · cellSize. */
  originX: number;
  originZ: number;
  nx: number;
  nz: number;
  nodes: number;
  /** Number of undirected orthogonal links. */
  links: number;
  /** Closable boxes groups (barriers + final gate). */
  barriers: number;
  /** Nodes currently blocked by closed barriers. */
  blockedNodes: number;
  /** Connected walkable regions with the current barrier state. */
  regions: number;
}

/** Anything with a `next()` returning a uniform float in [0, 1) — pass `sim.rng`. */
export interface NavRandom {
  next(): number;
}

/** A sphere no agent centre may enter (another enemy with the separation the guards keep): centre and radius. */
export interface NavDisc {
  x: number;
  y: number;
  z: number;
  r: number;
}

export interface NavPathOptions {
  /** Spheres to plan around (see NavDisc). A start inside one may only move out of it. */
  avoid?: readonly NavDisc[];
  /** Number of entries of `avoid` to use (default: all). */
  avoidCount?: number;
  /** Paths longer than this are not found (default: no limit). */
  maxLength?: number;
}

export interface NavVantageOptions {
  /** Height of the eye above the standing centre (ENEMIES.guard.muzzleUp). */
  eyeUp: number;
  /** A spot qualifies when its standing centre is at most this far (3D) from the target and its eye sees the target. */
  within: number;
  /** Only spots within this many metres of walkable path are explored. */
  maxCost: number;
  /**
   * Without a qualifying spot: 'visible' = the explored spot nearest to the target among those whose eye sees it,
   * 'nearest' = the explored spot nearest to the target whatever it sees, 'none' = nothing.
   */
  fallback: 'none' | 'visible' | 'nearest';
  /** The fallback spot must be at least this much nearer to the target than the start (m). */
  minGain: number;
  /** Upper bound on explored nodes (default 12000). */
  maxExpansions?: number;
  /** Upper bound on line-of-sight tests (default 1500). */
  maxSightTests?: number;
}

/** Results of NavGrid.findVantage. */
export const VANTAGE_NONE = 0;
export const VANTAGE_QUALIFIED = 1;
export const VANTAGE_FALLBACK = 2;

const AGENT_R = ENEMIES.guard.radius;
const AGENT_H = ENEMIES.guard.centerHeight;
/** Two walkable floors of one column are at least this far apart (lower floor → underside of the upper slab). */
const LEVEL_SEP = AGENT_H + AGENT_R;
/** Linked nodes: floor heights differ by at most this (no climbing, no dropping). */
const MAX_STEP = 0.3;
/** Floor tops closer together than the agent's ground clearance are one floor; the upper one counts. */
const MERGE_Y = Math.max(AGENT_H - AGENT_R, 0) + 1e-9;
/**
 * A position p "stands on" a floor when p.y is at most TOL_ABOVE above and at most TOL_BELOW below the exact
 * standing height floor + centerHeight (isWalkable / segmentWalkable / walkableReach / path starts).
 * Above: generous, so that the player's hit-box centre (0.7 m higher than a guard's) is accepted. Below: only
 * the agent's ground clearance — any lower and the agent box would be inside the floor it is said to stand on.
 * TOL_ABOVE + TOL_BELOW must stay below LEVEL_SEP so that the floor is unambiguous.
 */
const TOL_ABOVE = Math.min(1.0, LEVEL_SEP * 0.4);
const TOL_BELOW = Math.max(AGENT_H - AGENT_R, 0) + 1e-6;
/** Floor height tolerance when following one level through neighbouring columns. Must stay < LEVEL_SEP / 2. */
const LEVEL_TOL = Math.min(0.75, LEVEL_SEP * 0.3);
/** A coordinate this close to a lattice line (in cells) is on the line. */
const LINE_EPS = 1e-7;
/** Two line crossings this close together (segment parameter) happen at the same lattice point. */
const T_EPS = 1e-9;

const DEFAULT_CELL = 1;
const MIN_CELL = 0.25;
const MAX_CELL = 2 * AGENT_R;
/** Default upper bound on lattice columns; larger stages get a coarser lattice and finally a clipped window. */
const DEFAULT_MAX_COLUMNS = 1_500_000;
const DEFAULT_MAX_EXPANSIONS = 80_000;
const DEFAULT_VANTAGE_EXPANSIONS = 12_000;
const DEFAULT_VANTAGE_SIGHT_TESTS = 1_500;
/** A fallback vantage with a view must beat the best one so far by this much to be worth a sight test (m). */
const VANTAGE_STEP = 0.5;

/**
 * A start that is off the walkable area is snapped to a node within this horizontal distance whose standing
 * height is at most START_DOWN below the start (and not above it: a guard cannot hop up).
 */
const START_SNAP = 3;
const START_DOWN = Math.min(1.2, LEVEL_SEP * 0.48);
/** Default horizontal tolerance of findPath's goal. */
const GOAL_SNAP = 4;

/** Octile (8-connected) distance is at most this much longer than the straight line. */
const OCTILE_RATIO = 1.0823922002923940;
const SQRT2 = Math.SQRT2;
/** Octile distance = max(dx, dz) + OCT · min(dx, dz). */
const OCT = Math.SQRT2 - 1;
/** f values this close together are one plateau (absorbs floating-point noise of sums of 1 and √2). */
const F_EPS = 1e-9;

/**
 * Row of the node table: 8 neighbour slots — +X, −X, +Z, −Z, then the diagonals (+X+Z), (+X−Z), (−X+Z),
 * (−X−Z) — followed by the node's lattice indices i and j (kept in the row so that expanding a node touches
 * one piece of memory).
 */
const ROW = 10;
const NB_E = 0;
const NB_W = 1;
const NB_S = 2;
const NB_N = 3;
const NB_SE = 4;
const NB_I = 8;
const NB_J = 9;

const LOS_NONE = 0;
const LOS_PREFER = 1;
const LOS_REQUIRE = 2;

const EMPTY_I32 = new Int32Array(0);
const EMPTY_F64 = new Float64Array(0);
const EMPTY_U8 = new Uint8Array(0);

function finite3(v: V3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

export class NavGrid {
  readonly world: World;
  readonly stage: StageDef;

  private readonly reqCell: number;
  private readonly maxExpansions: number;
  private readonly maxColumns: number;

  // ── lattice ──
  private built = false;
  private cs = DEFAULT_CELL;
  private invCs = 1 / DEFAULT_CELL;
  private ox = 0;
  private oz = 0;
  private nx = 0;
  private nz = 0;
  private nodeCount = 0;
  private linkCount = 0;
  /** Nodes of column c = j·nx + i are colStart[c] .. colStart[c + 1] − 1, ascending floor height. */
  private colStart: Int32Array = EMPTY_I32;
  /** Floor height under each node. */
  private nodeY: Float64Array = EMPTY_F64;
  /** Static orthogonal links, 4 per node: +X, −X, +Z, −Z (−1 = none). Barriers are ignored here. */
  private base: Int32Array = EMPTY_I32;
  /**
   * Node table, ROW entries per node: the usable neighbours (see NB_*; −1 = none) and the lattice indices.
   * A neighbour slot is filled only when the neighbour is not blocked and, for a diagonal, when both
   * orthogonal neighbours are usable too. A blocked node has no incoming entries, so it can only be touched
   * as the first node of a query (checked there).
   */
  private nbr: Int32Array = EMPTY_I32;
  /** Number of closed barriers overlapping the agent box at each node (0 = usable). */
  private blocked: Uint8Array = EMPTY_U8;

  // ── barriers ──
  private readonly barrierIds: string[] = [];
  private readonly barrierIndex = new Map<string, number>();
  private readonly barrierOpen: boolean[] = [];
  private barrierNodes: Int32Array[] = [];

  // ── static obstacle spheres (living turrets): key → the nodes each one blocks ──
  private readonly obstacleNodes = new Map<number, Int32Array>();

  // ── spheres to avoid in the current findPath (other guards): per-node stamp + the list for segment tests ──
  private ban: Int32Array = EMPTY_I32;
  private banId = 0;
  private banOn = false;
  private banDiscs: readonly NavDisc[] = [];
  private banCount = 0;

  // ── connected regions (lazy) ──
  private comp: Int32Array = EMPTY_I32;
  private compDirty = true;
  private compCount = 0;
  private queue: Int32Array = EMPTY_I32;

  // ── A* scratch (allocated on first search) ──
  /**
   * One 16-byte record per node, seen through two views of one buffer: recI[4n] = stamp (query id · 2,
   * +1 once expanded), recI[4n + 1] = parent node, recF[2n + 1] = cost from the start.
   */
  private recI: Int32Array = EMPTY_I32;
  private recF: Float64Array = EMPTY_F64;
  /** Binary min-heap on f (parallel arrays; superseded entries are skipped when popped). Grows by doubling. */
  private heapF: Float64Array = new Float64Array(1024);
  private heapN: Int32Array = new Int32Array(1024);
  /** Nodes of the current f plateau waiting to be expanded (LIFO). Grows by doubling. */
  private stack: Int32Array = new Int32Array(1024);
  private queryId = 0;
  private pathBuf: Int32Array = new Int32Array(256);
  private pathLen = 0;
  /** Diagnostics of the most recent findPath / pathDistance: nodes expanded by A* (0 when no search ran). */
  lastExpansions = 0;
  /** Diagnostics: cost in metres of the node-to-node grid path A* found (0 when no search ran or it failed). */
  lastGridCost = 0;
  /** Diagnostics of the most recent findVantage: nodes explored, sight tests made, path cost of the returned spot. */
  lastVantageExpansions = 0;
  lastVantageSightTests = 0;
  lastVantageCost = 0;

  // ── path assembly scratch: raw points (lattice coordinates + floor height) and the kept indices ──
  private ptU: Float64Array = new Float64Array(258);
  private ptV: Float64Array = new Float64Array(258);
  private ptY: Float64Array = new Float64Array(258);
  private outIdx: Int32Array = new Int32Array(258);
  private outCount = 0;
  private outExactEnd = false;

  // ── results of walk() ──
  private wT = 0;
  private wNode = -1;
  // ── results of resolve() ──
  private rNode = -1;
  private rExact = false;
  private rU = 0;
  private rV = 0;
  private rY = 0;

  private readonly tmpA: V3 = { x: 0, y: 0, z: 0 };
  private readonly tmpB: V3 = { x: 0, y: 0, z: 0 };
  private readonly agentHalf: V3 = { x: AGENT_R, y: AGENT_R, z: AGENT_R };

  constructor(world: World, stage: StageDef, opts: NavOptions = {}) {
    this.world = world;
    this.stage = stage;
    const c = opts.cellSize;
    this.reqCell = c !== undefined && Number.isFinite(c) && c > 0 ? Math.min(MAX_CELL, Math.max(MIN_CELL, c)) : DEFAULT_CELL;
    const m = opts.maxExpansions;
    this.maxExpansions = m !== undefined && m >= 1 ? Math.floor(m) : DEFAULT_MAX_EXPANSIONS;
    const mc = opts.maxColumns;
    this.maxColumns = mc !== undefined && mc >= 16 ? Math.floor(mc) : DEFAULT_MAX_COLUMNS;
    // Barrier registry (works before the grid exists): every closable box of the world, closed.
    for (const b of world.boxes) if (b.barrierId !== null) this.registerBarrier(b.barrierId);
    for (const b of stage.barriers) this.registerBarrier(b.id);
    this.registerBarrier(stage.finalGate.id);
    // Guards need the grid on their first update: build now rather than in the middle of a frame.
    for (const e of stage.enemies) {
      if (e.kind === 'guard' && !e.test?.passive) {
        this.build();
        break;
      }
    }
  }

  private registerBarrier(id: string): void {
    if (this.barrierIndex.has(id)) return;
    this.barrierIndex.set(id, this.barrierIds.length);
    this.barrierIds.push(id);
    this.barrierOpen.push(false);
  }

  // ───────────────────────────── construction ─────────────────────────────

  /** Builds the grid if it does not exist yet (idempotent). Every query calls this implicitly. */
  build(): void {
    if (this.built) return;
    this.built = true;
    const world = this.world;

    // Static boxes: everything that can collide (`obstacles`), and among those the ones that can carry a
    // floor (`floors`). Closable boxes are kept apart.
    const obstacles: WorldBox[] = [];
    const floors: WorldBox[] = [];
    const closable: WorldBox[] = [];
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const b of world.boxes) {
      if (b.barrierId !== null) {
        closable.push(b);
        continue;
      }
      const mn = b.min;
      const mx = b.max;
      // A box with a NaN coordinate never collides in the World either.
      if (mn.x !== mn.x || mn.y !== mn.y || mn.z !== mn.z || mx.x !== mx.x || mx.y !== mx.y || mx.z !== mx.z) continue;
      obstacles.push(b);
      // A floor needs a footprint with an area and a finite top.
      if (!(mx.x > mn.x && mx.z > mn.z) || !(mx.y < Infinity) || !(mx.y > -Infinity)) continue;
      floors.push(b);
      if (Number.isFinite(mn.x) && mn.x < minX) minX = mn.x;
      if (Number.isFinite(mx.x) && mx.x > maxX) maxX = mx.x;
      if (Number.isFinite(mn.z) && mn.z < minZ) minZ = mn.z;
      if (Number.isFinite(mx.z) && mx.z > maxZ) maxZ = mx.z;
    }

    if (minX <= maxX && minZ <= maxZ) {
      // ── lattice layout ──
      let cs = this.reqCell;
      const maxColumns = this.maxColumns;
      const columns = (s: number, sx: number, sz: number): number => (Math.ceil(sx / s) + 1) * (Math.ceil(sz / s) + 1);
      if (columns(cs, maxX - minX, maxZ - minZ) > maxColumns) {
        cs = Math.min(MAX_CELL, Math.max(cs, Math.sqrt(((maxX - minX) * (maxZ - minZ)) / maxColumns) * 1.05));
      }
      if (columns(cs, maxX - minX, maxZ - minZ) > maxColumns) {
        // Absurdly large stage: keep a window around the guards (or the middle of the stage).
        let fx = (minX + maxX) / 2;
        let fz = (minZ + maxZ) / 2;
        let sx = 0;
        let sz = 0;
        let cnt = 0;
        for (const e of this.stage.enemies) {
          if (e.kind !== 'guard' || !finite3(e.position)) continue;
          sx += e.position.x;
          sz += e.position.z;
          cnt++;
        }
        if (cnt > 0) {
          fx = sx / cnt;
          fz = sz / cnt;
        }
        const halfSide = Math.max(1, Math.floor(Math.sqrt(maxColumns)) - 2) * cs * 0.5;
        if (maxX - minX > 2 * halfSide) {
          fx = Math.min(maxX - halfSide, Math.max(minX + halfSide, fx));
          minX = fx - halfSide;
          maxX = fx + halfSide;
        }
        if (maxZ - minZ > 2 * halfSide) {
          fz = Math.min(maxZ - halfSide, Math.max(minZ + halfSide, fz));
          minZ = fz - halfSide;
          maxZ = fz + halfSide;
        }
      }
      this.cs = cs;
      this.invCs = 1 / cs;
      // Cell boundaries on multiples of the cell size → nodes on half multiples, whatever the stage extent.
      this.ox = Math.floor(minX / cs) * cs;
      this.oz = Math.floor(minZ / cs) * cs;
      this.nx = Math.max(1, Math.ceil((maxX - this.ox) / cs));
      this.nz = Math.max(1, Math.ceil((maxZ - this.oz) / cs));

      // The clearance queries must not see the barriers: open them for the duration of the build.
      const saved: boolean[] = [];
      for (const b of closable) {
        saved.push(b.active);
        b.active = false;
      }
      try {
        this.buildNodes(floors, obstacles);
      } finally {
        for (let k = 0; k < closable.length; k++) closable[k].active = saved[k];
      }
      this.buildLinks();
    }

    const n = this.nodeCount;
    this.blocked = new Uint8Array(n);
    this.comp = new Int32Array(n);
    this.compDirty = true;
    this.buildBarrierNodes(closable);
    for (let k = 0; k < this.barrierIds.length; k++) {
      if (this.barrierOpen[k]) continue;
      const list = this.barrierNodes[k];
      for (let q = 0; q < list.length; q++) this.blocked[list[q]]++;
    }
    for (let q = 0; q < n; q++) this.refreshRow(q);
  }

  /** Recomputes the usable-neighbour row of node `n` from the static links and the blocked counters. */
  private refreshRow(n: number): void {
    const base = this.base;
    const blocked = this.blocked;
    const nbr = this.nbr;
    const r = n * ROW;
    const b = n * 4;
    let e = base[b];
    let w = base[b + 1];
    let s = base[b + 2];
    let nn = base[b + 3];
    if (e >= 0 && blocked[e] !== 0) e = -1;
    if (w >= 0 && blocked[w] !== 0) w = -1;
    if (s >= 0 && blocked[s] !== 0) s = -1;
    if (nn >= 0 && blocked[nn] !== 0) nn = -1;
    nbr[r] = e;
    nbr[r + 1] = w;
    nbr[r + 2] = s;
    nbr[r + 3] = nn;
    // Diagonal: both orthogonal neighbours usable, and both lead to the same usable corner.
    let d = -1;
    if (e >= 0 && s >= 0) {
      d = base[e * 4 + 2];
      if (d >= 0 && (blocked[d] !== 0 || base[s * 4] !== d)) d = -1;
    }
    nbr[r + 4] = d;
    d = -1;
    if (e >= 0 && nn >= 0) {
      d = base[e * 4 + 3];
      if (d >= 0 && (blocked[d] !== 0 || base[nn * 4] !== d)) d = -1;
    }
    nbr[r + 5] = d;
    d = -1;
    if (w >= 0 && s >= 0) {
      d = base[w * 4 + 2];
      if (d >= 0 && (blocked[d] !== 0 || base[s * 4 + 1] !== d)) d = -1;
    }
    nbr[r + 6] = d;
    d = -1;
    if (w >= 0 && nn >= 0) {
      d = base[w * 4 + 3];
      if (d >= 0 && (blocked[d] !== 0 || base[nn * 4 + 1] !== d)) d = -1;
    }
    nbr[r + 7] = d;
  }

  /** Refreshes the rows of every node whose usable neighbours may depend on node `n` (n and its 3×3 ring). */
  private refreshAround(n: number): void {
    const base = this.base;
    this.refreshRow(n);
    for (let d1 = 0; d1 < 4; d1++) {
      const a = base[n * 4 + d1];
      if (a < 0) continue;
      this.refreshRow(a);
      // The two diagonal neighbours on this side (reached through a; the other route is covered by the other side).
      const p0 = d1 < 2 ? 2 : 0;
      for (let d2 = p0; d2 < p0 + 2; d2++) {
        const c = base[a * 4 + d2];
        if (c >= 0) this.refreshRow(c);
      }
    }
  }

  /** Floor candidates per column → merged, clearance-tested nodes (colStart, nodeY, lattice indices in the node table). */
  private buildNodes(solids: WorldBox[], obstacles: WorldBox[]): void {
    const world = this.world;
    const cs = this.cs;
    const inv = this.invCs;
    const ox = this.ox;
    const oz = this.oz;
    const nx = this.nx;
    const nz = this.nz;
    const ncol = nx * nz;

    // First / last lattice index whose point lies inside [lo, hi] (closed), clamped to the grid.
    const first = (lo: number, o: number, n: number): number => {
      let i = Math.ceil((lo - o) * inv - 0.5);
      if (!(i > 0)) i = 0;
      if (i > n) i = n;
      while (i > 0 && o + (i - 0.5) * cs >= lo) i--;
      while (i < n && o + (i + 0.5) * cs < lo) i++;
      return i;
    };
    const last = (hi: number, o: number, n: number): number => {
      let i = Math.floor((hi - o) * inv - 0.5);
      if (!(i < n - 1)) i = n - 1;
      if (i < -1) i = -1;
      while (i < n - 1 && o + (i + 1.5) * cs <= hi) i++;
      while (i >= 0 && o + (i + 0.5) * cs > hi) i--;
      return i;
    };

    // Pass 1: count the floor candidates of every column (top faces whose footprint contains the point).
    const ns = solids.length;
    const range = new Int32Array(ns * 4);
    const cStart = new Int32Array(ncol + 1);
    for (let k = 0; k < ns; k++) {
      const b = solids[k];
      const i0 = first(b.min.x, ox, nx);
      const i1 = last(b.max.x, ox, nx);
      const j0 = first(b.min.z, oz, nz);
      const j1 = last(b.max.z, oz, nz);
      range[k * 4] = i0;
      range[k * 4 + 1] = i1;
      range[k * 4 + 2] = j0;
      range[k * 4 + 3] = j1;
      for (let j = j0; j <= j1; j++) {
        const row = j * nx + 1;
        for (let c = row + i0; c <= row + i1; c++) cStart[c]++;
      }
    }
    for (let c = 0; c < ncol; c++) cStart[c + 1] += cStart[c];
    // Pass 2: fill.
    const ys = new Float64Array(cStart[ncol]);
    const cursor = cStart.slice(0, ncol);
    for (let k = 0; k < ns; k++) {
      const top = solids[k].max.y;
      const i0 = range[k * 4];
      const i1 = range[k * 4 + 1];
      const j0 = range[k * 4 + 2];
      const j1 = range[k * 4 + 3];
      for (let j = j0; j <= j1; j++) {
        const row = j * nx;
        for (let c = row + i0; c <= row + i1; c++) ys[cursor[c]++] = top;
      }
    }

    // Columns whose agent footprint is reached by one static box only: that box is the floor itself, and an
    // agent standing on a floor never overlaps it, so those columns need no clearance query (this is most of
    // an open floor). The index ranges use the very comparisons of World.overlapsBox.
    const cover = new Uint8Array(ncol);
    const skipSingles = AGENT_H >= AGENT_R;
    if (skipSingles) {
      for (let k = 0; k < obstacles.length; k++) {
        const b = obstacles[k];
        let i0 = Math.floor((b.min.x - AGENT_R - ox) * inv - 0.5) - 1;
        let i1 = Math.ceil((b.max.x + AGENT_R - ox) * inv - 0.5) + 1;
        let j0 = Math.floor((b.min.z - AGENT_R - oz) * inv - 0.5) - 1;
        let j1 = Math.ceil((b.max.z + AGENT_R - oz) * inv - 0.5) + 1;
        if (!(i0 > 0)) i0 = 0;
        if (!(j0 > 0)) j0 = 0;
        if (!(i1 < nx - 1)) i1 = nx - 1;
        if (!(j1 < nz - 1)) j1 = nz - 1;
        while (i0 <= i1 && !(ox + (i0 + 0.5) * cs + AGENT_R > b.min.x)) i0++;
        while (i1 >= i0 && !(ox + (i1 + 0.5) * cs - AGENT_R < b.max.x)) i1--;
        while (j0 <= j1 && !(oz + (j0 + 0.5) * cs + AGENT_R > b.min.z)) j0++;
        while (j1 >= j0 && !(oz + (j1 + 0.5) * cs - AGENT_R < b.max.z)) j1--;
        for (let j = j0; j <= j1; j++) {
          const row = j * nx;
          for (let c = row + i0; c <= row + i1; c++) if (cover[c] < 2) cover[c]++;
        }
      }
    }

    // Pass 3: per column sort, merge, clearance test; survivors are compacted to the front of the column.
    const kept = new Int32Array(ncol + 1);
    const centre = this.tmpA;
    const half = this.agentHalf;
    let total = 0;
    for (let j = 0; j < nz; j++) {
      centre.z = oz + (j + 0.5) * cs;
      const row = j * nx;
      for (let i = 0; i < nx; i++) {
        const c = row + i;
        const s = cStart[c];
        const e = cStart[c + 1];
        if (s === e) continue;
        for (let k = s + 1; k < e; k++) {
          const v = ys[k];
          let q = k - 1;
          while (q >= s && ys[q] > v) {
            ys[q + 1] = ys[q];
            q--;
          }
          ys[q + 1] = v;
        }
        if (cover[c] === 1) {
          // single box in reach: its top is the only candidate and nothing can be in the way
          ys[s] = ys[e - 1];
          kept[c] = 1;
          total++;
          continue;
        }
        centre.x = ox + (i + 0.5) * cs;
        let w = s;
        for (let k = s; k < e; k++) {
          const y = ys[k];
          // A higher top within the ground clearance (or the same top of an abutting box) replaces this one.
          if (k + 1 < e && ys[k + 1] - y <= MERGE_Y) continue;
          centre.y = y + AGENT_H;
          if (!world.overlapsBox(centre, half)) ys[w++] = y;
        }
        kept[c] = w - s;
        total += w - s;
      }
    }

    const colStart = new Int32Array(ncol + 1);
    const nodeY = new Float64Array(total);
    const table = new Int32Array(total * ROW);
    let n = 0;
    for (let j = 0; j < nz; j++) {
      const row = j * nx;
      for (let i = 0; i < nx; i++) {
        const c = row + i;
        colStart[c] = n;
        const s = cStart[c];
        const cnt = kept[c];
        for (let k = 0; k < cnt; k++) {
          nodeY[n] = ys[s + k];
          table[n * ROW + NB_I] = i;
          table[n * ROW + NB_J] = j;
          n++;
        }
      }
    }
    colStart[ncol] = n;
    this.colStart = colStart;
    this.nodeY = nodeY;
    this.nbr = table;
    this.nodeCount = total;
  }

  private buildLinks(): void {
    const n = this.nodeCount;
    const nx = this.nx;
    const nz = this.nz;
    const colStart = this.colStart;
    const nodeY = this.nodeY;
    const link = new Int32Array(n * 4).fill(-1);
    let links = 0;
    for (let j = 0; j < nz; j++) {
      const row = j * nx;
      for (let i = 0; i < nx; i++) {
        const c = row + i;
        const s = colStart[c];
        const e = colStart[c + 1];
        if (s === e) continue;
        for (let a = s; a < e; a++) {
          const y = nodeY[a];
          if (i + 1 < nx) {
            const e2 = colStart[c + 2];
            for (let b = e; b < e2; b++) {
              const d = nodeY[b] - y;
              if (d <= MAX_STEP && d >= -MAX_STEP) {
                link[a * 4] = b;
                link[b * 4 + 1] = a;
                links++;
                break;
              }
            }
          }
          if (j + 1 < nz) {
            const s2 = colStart[c + nx];
            const e2 = colStart[c + nx + 1];
            for (let b = s2; b < e2; b++) {
              const d = nodeY[b] - y;
              if (d <= MAX_STEP && d >= -MAX_STEP) {
                link[a * 4 + 2] = b;
                link[b * 4 + 3] = a;
                links++;
                break;
              }
            }
          }
        }
      }
    }
    this.base = link;
    this.linkCount = links;
  }

  /** For every barrier id: the nodes whose agent box overlaps one of its boxes (same strict test as World.overlapsBox). */
  private buildBarrierNodes(closable: WorldBox[]): void {
    const lists: number[][] = this.barrierIds.map(() => []);
    const n = this.nodeCount;
    if (n > 0) {
      const cs = this.cs;
      const inv = this.invCs;
      const nx = this.nx;
      const nz = this.nz;
      const colStart = this.colStart;
      const nodeY = this.nodeY;
      const mark = new Int32Array(n).fill(-1);
      for (const b of closable) {
        const k = this.barrierIndex.get(b.barrierId as string);
        if (k === undefined) continue;
        const list = lists[k];
        let i0 = Math.floor((b.min.x - AGENT_R - this.ox) * inv - 0.5) - 1;
        let i1 = Math.ceil((b.max.x + AGENT_R - this.ox) * inv - 0.5) + 1;
        let j0 = Math.floor((b.min.z - AGENT_R - this.oz) * inv - 0.5) - 1;
        let j1 = Math.ceil((b.max.z + AGENT_R - this.oz) * inv - 0.5) + 1;
        if (!(i0 > 0)) i0 = 0;
        if (!(j0 > 0)) j0 = 0;
        if (!(i1 < nx - 1)) i1 = nx - 1;
        if (!(j1 < nz - 1)) j1 = nz - 1;
        for (let j = j0; j <= j1; j++) {
          const cz = this.oz + (j + 0.5) * cs;
          if (!(cz + AGENT_R > b.min.z && cz - AGENT_R < b.max.z)) continue;
          for (let i = i0; i <= i1; i++) {
            const cx = this.ox + (i + 0.5) * cs;
            if (!(cx + AGENT_R > b.min.x && cx - AGENT_R < b.max.x)) continue;
            const c = j * nx + i;
            for (let q = colStart[c]; q < colStart[c + 1]; q++) {
              const cy = nodeY[q] + AGENT_H;
              if (cy + AGENT_R > b.min.y && cy - AGENT_R < b.max.y && mark[q] !== k) {
                mark[q] = k;
                list.push(q);
              }
            }
          }
        }
      }
    }
    this.barrierNodes = lists.map((l) => Int32Array.from(l));
  }

  /** Layout and size of the grid (builds it if necessary). */
  getInfo(): NavInfo {
    this.build();
    this.ensureComponents();
    let blockedNodes = 0;
    for (let n = 0; n < this.nodeCount; n++) if (this.blocked[n] !== 0) blockedNodes++;
    return {
      cellSize: this.cs,
      originX: this.ox,
      originZ: this.oz,
      nx: this.nx,
      nz: this.nz,
      nodes: this.nodeCount,
      links: this.linkCount,
      barriers: this.barrierIds.length,
      blockedNodes,
      regions: this.compCount,
    };
  }

  // ───────────────────────────── barriers ─────────────────────────────

  /**
   * Restores the initial barrier state (all closed). Called on every sortie. The obstacles are left alone:
   * whoever registered them (the enemy module, from the living turrets) brings them up to date itself.
   */
  reset(): void {
    for (let k = 0; k < this.barrierIds.length; k++) this.setBarrierIndexOpen(k, false);
  }

  /** Opening a barrier makes the cells it covered walkable (and vice versa). Unknown ids are ignored. */
  setBarrierOpen(id: string, open: boolean): void {
    const k = this.barrierIndex.get(id);
    if (k !== undefined) this.setBarrierIndexOpen(k, !!open);
  }

  /** The grid's own state of a barrier / the final gate (false for unknown ids). */
  isBarrierOpen(id: string): boolean {
    const k = this.barrierIndex.get(id);
    return k !== undefined && this.barrierOpen[k];
  }

  private setBarrierIndexOpen(k: number, open: boolean): void {
    if (this.barrierOpen[k] === open) return;
    this.barrierOpen[k] = open;
    if (!this.built) return;
    const list = this.barrierNodes[k];
    const blocked = this.blocked;
    if (open) for (let q = 0; q < list.length; q++) blocked[list[q]]--;
    else for (let q = 0; q < list.length; q++) blocked[list[q]]++;
    for (let q = 0; q < list.length; q++) this.refreshAround(list[q]);
    if (list.length > 0) this.compDirty = true;
  }

  // ───────────────────────────── obstacles ─────────────────────────────

  /**
   * Registers the static obstacle `key` (a living fixed turret): no agent centre may come nearer than `radius`
   * (3D) to `center`, so every node whose standing centre is nearer is blocked — exactly like a node under a
   * closed barrier — until the obstacle is removed with `center` = null (or by `clearObstacles` / `reset`).
   * Registering an existing key replaces it. Builds the grid if necessary.
   */
  setObstacle(key: number, center: V3 | null, radius = 0): void {
    const old = this.obstacleNodes.get(key);
    if (old !== undefined) {
      this.obstacleNodes.delete(key);
      this.unblock(old);
    }
    if (center === null || !finite3(center) || !(radius > 0)) return;
    this.build();
    const list = this.nodesInSphere(center.x, center.y, center.z, radius);
    this.obstacleNodes.set(key, list);
    if (list.length === 0) return;
    const blocked = this.blocked;
    for (let q = 0; q < list.length; q++) blocked[list[q]]++;
    for (let q = 0; q < list.length; q++) this.refreshAround(list[q]);
    // Blocking can split a region.
    this.compDirty = true;
  }

  /** Removes every obstacle. */
  clearObstacles(): void {
    if (this.obstacleNodes.size === 0) return;
    const lists = [...this.obstacleNodes.values()];
    this.obstacleNodes.clear();
    for (const list of lists) this.unblock(list);
  }

  /** Number of registered obstacles. */
  get obstacleCount(): number {
    return this.obstacleNodes.size;
  }

  /** True while obstacle `key` is registered. */
  hasObstacle(key: number): boolean {
    return this.obstacleNodes.has(key);
  }

  /** Keys of the registered obstacles (a copy). */
  obstacleKeys(): number[] {
    return [...this.obstacleNodes.keys()];
  }

  /** Nodes whose standing centre is nearer than `r` (3D) to (x, y, z). */
  private nodesInSphere(x: number, y: number, z: number, r: number): Int32Array {
    const out: number[] = [];
    if (this.nodeCount === 0) return EMPTY_I32;
    const cs = this.cs;
    const nx = this.nx;
    let i0 = Math.ceil((x - r - this.ox) * this.invCs - 0.5);
    let i1 = Math.floor((x + r - this.ox) * this.invCs - 0.5);
    let j0 = Math.ceil((z - r - this.oz) * this.invCs - 0.5);
    let j1 = Math.floor((z + r - this.oz) * this.invCs - 0.5);
    if (!(i0 > 0)) i0 = 0;
    if (!(j0 > 0)) j0 = 0;
    if (!(i1 < nx - 1)) i1 = nx - 1;
    if (!(j1 < this.nz - 1)) j1 = this.nz - 1;
    const r2 = r * r;
    const colStart = this.colStart;
    const nodeY = this.nodeY;
    for (let j = j0; j <= j1; j++) {
      const dz = this.oz + (j + 0.5) * cs - z;
      for (let i = i0; i <= i1; i++) {
        const dx = this.ox + (i + 0.5) * cs - x;
        const d2 = dx * dx + dz * dz;
        if (d2 >= r2) continue;
        const c = j * nx + i;
        for (let q = colStart[c]; q < colStart[c + 1]; q++) {
          const dy = nodeY[q] + AGENT_H - y;
          if (d2 + dy * dy < r2) out.push(q);
        }
      }
    }
    return Int32Array.from(out);
  }

  /**
   * Takes one blocking count off every node of `list`. The region labels are patched in place when each
   * freed patch touches at most one existing region (the usual case: an obstacle in the middle of a floor);
   * only a patch that joins two regions asks for a full re-labelling.
   */
  private unblock(list: Int32Array): void {
    if (list.length === 0) return;
    const blocked = this.blocked;
    for (let q = 0; q < list.length; q++) blocked[list[q]]--;
    for (let q = 0; q < list.length; q++) this.refreshAround(list[q]);
    if (this.compDirty) return;
    const comp = this.comp;
    const nbr = this.nbr;
    const PENDING = -2;
    const SEEN = -3;
    for (let q = 0; q < list.length; q++) if (blocked[list[q]] === 0) comp[list[q]] = PENDING;
    const patch: number[] = [];
    for (let q = 0; q < list.length; q++) {
      const s = list[q];
      if (comp[s] !== PENDING) continue;
      patch.length = 0;
      patch.push(s);
      comp[s] = SEEN;
      let label = -1;
      for (let head = 0; head < patch.length; head++) {
        const a = patch[head] * ROW;
        for (let d = 0; d < 4; d++) {
          const b = nbr[a + d];
          if (b < 0) continue;
          const cb = comp[b];
          if (cb === PENDING) {
            comp[b] = SEEN;
            patch.push(b);
          } else if (cb >= 0) {
            if (label === -1) label = cb;
            else if (label !== cb) {
              // Two regions meet here: label everything afresh on the next query.
              this.compDirty = true;
              return;
            }
          }
        }
      }
      if (label === -1) label = this.compCount++;
      for (let k = 0; k < patch.length; k++) comp[patch[k]] = label;
    }
  }

  // ───────────────────────────── lattice primitives ─────────────────────────────

  /** Lattice coordinate (node i is at exactly i) of a world coordinate, snapped onto a lattice line when within LINE_EPS. */
  private lat(w: number, origin: number): number {
    const u = (w - origin) * this.invCs - 0.5;
    const r = Math.round(u);
    const d = u - r;
    return d <= LINE_EPS && d >= -LINE_EPS ? r : u;
  }

  /** Node of column (i, j) whose floor lies in [floorY − below, floorY + above] (the nearest one to floorY), or −1. */
  private nodeAt(i: number, j: number, floorY: number, below: number, above: number): number {
    if (!(i >= 0 && i < this.nx && j >= 0 && j < this.nz)) return -1;
    const c = j * this.nx + i;
    const colStart = this.colStart;
    const nodeY = this.nodeY;
    let best = -1;
    let bestD = Infinity;
    for (let q = colStart[c]; q < colStart[c + 1]; q++) {
      const d = nodeY[q] - floorY;
      if (d > above || d < -below) continue;
      const a = d < 0 ? -d : d;
      if (a < bestD) {
        bestD = a;
        best = q;
      }
    }
    return best;
  }

  /**
   * True when the lattice cell with base node `n` supports a point inside it: `n` itself, plus its +X
   * neighbour unless the point is on the lattice line u = i, plus its +Z neighbour unless on v = j, plus the
   * diagonal corner when neither — all present, unblocked and mutually linked (which is exactly what the
   * corresponding slot of the usable-neighbour table says).
   */
  private supportOk(n: number, iLine: boolean, jLine: boolean): boolean {
    if (this.blocked[n] !== 0) return false;
    if (iLine) return jLine || this.nbr[n * ROW + NB_S] >= 0;
    return this.nbr[n * ROW + (jLine ? NB_E : NB_SE)] >= 0;
  }

  /**
   * Exact walkability of the straight segment (u0, v0) → (u1, v1) in lattice coordinates on the level whose
   * floor at the start lies in [floorY − below, floorY + above]. The segment is cut where it crosses lattice
   * lines; every piece must lie in a supported cell (see supportOk). Returns true when the whole segment is
   * walkable. `wT` is the parameter (0..1) up to which it is walkable and `wNode` the base node of the last
   * supported cell (−1 when not even the start is walkable).
   */
  private walk(u0: number, v0: number, u1: number, v1: number, floorY: number, below: number, above: number): boolean {
    this.wT = 0;
    this.wNode = -1;
    const du = u1 - u0;
    const dv = v1 - v0;
    let i: number;
    let j: number;
    /** Slot of the neighbour table that must be filled for a piece: the diagonal, or one edge, or none (−1). */
    let need = NB_SE;
    /** Lattice lines still to cross / the next one. */
    let nI = 0;
    let nJ = 0;
    let kU = 0;
    let kV = 0;
    if (du > 0) {
      i = Math.floor(u0);
      nI = Math.ceil(u1) - 1 - i;
      kU = i + 1;
    } else if (du < 0) {
      i = Math.ceil(u0) - 1;
      nI = i - Math.floor(u1);
      kU = i;
    } else {
      i = Math.floor(u0);
      if (u0 === i) need = NB_S;
    }
    if (dv > 0) {
      j = Math.floor(v0);
      nJ = Math.ceil(v1) - 1 - j;
      kV = j + 1;
    } else if (dv < 0) {
      j = Math.ceil(v0) - 1;
      nJ = j - Math.floor(v1);
      kV = j;
    } else {
      j = Math.floor(v0);
      if (v0 === j) need = need === NB_S ? -1 : NB_E;
    }
    let n = this.nodeAt(i, j, floorY, below, above);
    if (n < 0 || this.blocked[n] !== 0) return false;
    const nbr = this.nbr;
    for (;;) {
      // Support of the current piece (base node n is known to be usable).
      if (need >= 0 && nbr[n * ROW + need] < 0) return false;
      this.wNode = n;
      if (nI <= 0 && nJ <= 0) {
        this.wT = 1;
        return true;
      }
      const tU = nI > 0 ? (kU - u0) / du : Infinity;
      const tV = nJ > 0 ? (kV - v0) / dv : Infinity;
      let stepU = true;
      let stepV = true;
      if (tU - tV > T_EPS) {
        stepU = false;
        this.wT = tV;
      } else if (tV - tU > T_EPS) {
        stepV = false;
        this.wT = tU;
      } else {
        // Through a lattice point: go straight to the diagonal cell (the two cells beside it are not entered).
        this.wT = tU < tV ? tU : tV;
      }
      // Positive steps first: the node passed on the way is then a corner of both cells.
      if (stepU && du > 0) {
        n = nbr[n * ROW + NB_E];
        kU++;
        nI--;
        if (n < 0) return false;
      }
      if (stepV && dv > 0) {
        n = nbr[n * ROW + NB_S];
        kV++;
        nJ--;
        if (n < 0) return false;
      }
      if (stepU && du < 0) {
        n = nbr[n * ROW + NB_W];
        kU--;
        nI--;
        if (n < 0) return false;
      }
      if (stepV && dv < 0) {
        n = nbr[n * ROW + NB_N];
        kV--;
        nJ--;
        if (n < 0) return false;
      }
    }
  }

  // ───────────────────────────── point / segment queries ─────────────────────────────

  /**
   * True when a guard-sized agent can stand with its hit-sphere centre at `p`: `p` is inside the walkable
   * area of a level and `p.y` is that level's standing height (floor + centerHeight; up to 1 m above it and
   * 0.1 m below it are accepted), with no closed barrier in the way. Conservative by up to one cell next to
   * obstacles and ledges (see the header).
   */
  isWalkable(p: V3): boolean {
    if (!finite3(p)) return false;
    this.build();
    if (this.nodeCount === 0) return false;
    const u = this.lat(p.x, this.ox);
    const v = this.lat(p.z, this.oz);
    const i = Math.floor(u);
    const j = Math.floor(v);
    const n = this.nodeAt(i, j, p.y - AGENT_H, TOL_ABOVE, TOL_BELOW);
    return n >= 0 && this.supportOk(n, u === i, v === j);
  }

  /**
   * True when a guard can walk the straight segment a→b: every point of it is walkable on one level (same
   * floor, followed cell by cell — no obstacle, no closed barrier, no ledge, no level change) and `b.y`
   * matches that level. Exact for the grid's walkable area, not sampled.
   */
  segmentWalkable(a: V3, b: V3): boolean {
    if (!finite3(a) || !finite3(b)) return false;
    this.build();
    if (this.nodeCount === 0) return false;
    if (!this.walk(this.lat(a.x, this.ox), this.lat(a.z, this.oz), this.lat(b.x, this.ox), this.lat(b.z, this.oz), a.y - AGENT_H, TOL_ABOVE, TOL_BELOW)) {
      return false;
    }
    // b must stand on the level the walk arrived on.
    const d = b.y - (this.nodeY[this.wNode] + AGENT_H);
    return d <= TOL_ABOVE + MAX_STEP && d >= -(TOL_BELOW + MAX_STEP);
  }

  /**
   * Walks from `a` straight towards `b` (horizontally) as far as the walkable area allows. Writes the
   * farthest reachable point (a guard centre, still walkable) to `out` and returns its horizontal distance
   * from `a`: |b − a| when the whole segment is walkable, 0 (out = a) when `a` is not walkable or the
   * walkable area ends right at `a` in that direction.
   * Use it for strafing / backing off "as far as possible in this direction".
   */
  walkableReach(a: V3, b: V3, out: V3 = { x: 0, y: 0, z: 0 }): number {
    const ax = a.x;
    const ay = a.y;
    const az = a.z;
    out.x = ax;
    out.y = ay;
    out.z = az;
    if (!finite3(a) || !finite3(b)) return 0;
    this.build();
    if (this.nodeCount === 0) return 0;
    const dx = b.x - ax;
    const dz = b.z - az;
    const ok = this.walk(this.lat(ax, this.ox), this.lat(az, this.oz), this.lat(b.x, this.ox), this.lat(b.z, this.oz), ay - AGENT_H, TOL_ABOVE, TOL_BELOW);
    if (this.wNode < 0) return 0;
    const t = ok ? 1 : this.wT;
    out.x = ax + dx * t;
    out.z = az + dz * t;
    out.y = this.nodeY[this.wNode] + AGENT_H;
    return Math.sqrt(dx * dx + dz * dz) * t;
  }

  // ───────────────────────────── snapping ─────────────────────────────

  /** True when the world has a clear line from `p` to the centre of an agent standing on node `n`. */
  private losTo(p: V3, n: number): boolean {
    const b = this.tmpB;
    b.x = this.ox + (this.nbr[n * ROW + NB_I] + 0.5) * this.cs;
    b.y = this.nodeY[n] + AGENT_H;
    b.z = this.oz + (this.nbr[n * ROW + NB_J] + 0.5) * this.cs;
    return !this.world.segmentBlocked(p, b);
  }

  /**
   * Nearest usable node to `p` within the horizontal `radius` (score = squared 3D distance between `p` and
   * the standing centre, which may be at most `up` above / `down` below `p`; region `comp` only when >= 0;
   * score below `limit`). With LOS_PREFER a node the world can see from `p` wins over a nearer hidden one;
   * with LOS_REQUIRE hidden nodes are rejected. Returns the node or −1.
   */
  private scanNearest(p: V3, u: number, v: number, radius: number, up: number, down: number, comp: number, limit: number, los: number): number {
    const best = this.scanDisc(p, u, v, radius, up, down, comp, limit, false);
    if (best < 0 || los === LOS_NONE || this.losTo(p, best)) return best;
    const visible = this.scanDisc(p, u, v, radius, up, down, comp, limit, true);
    if (visible >= 0) return visible;
    return los === LOS_PREFER ? best : -1;
  }

  /** One pass of scanNearest; with `needLos` only nodes the world can see from `p` count. */
  private scanDisc(p: V3, u: number, v: number, radius: number, up: number, down: number, comp: number, limit: number, needLos: boolean): number {
    const cs = this.cs;
    const nx = this.nx;
    const rc = radius * this.invCs;
    let i0 = Math.ceil(u - rc);
    let i1 = Math.floor(u + rc);
    let j0 = Math.ceil(v - rc);
    let j1 = Math.floor(v + rc);
    if (!(i0 > 0)) i0 = 0;
    if (!(j0 > 0)) j0 = 0;
    if (!(i1 < nx - 1)) i1 = nx - 1;
    if (!(j1 < this.nz - 1)) j1 = this.nz - 1;
    const colStart = this.colStart;
    const nodeY = this.nodeY;
    const blocked = this.blocked;
    const comps = this.comp;
    const r2 = radius * radius;
    const yStand = p.y - AGENT_H;
    let best = -1;
    let bestS = limit;
    for (let j = j0; j <= j1; j++) {
      const dv = (j - v) * cs;
      for (let i = i0; i <= i1; i++) {
        const du = (i - u) * cs;
        const d2 = du * du + dv * dv;
        if (d2 > r2 || d2 >= bestS) continue;
        const c = j * nx + i;
        for (let q = colStart[c]; q < colStart[c + 1]; q++) {
          if (blocked[q] !== 0 || (comp >= 0 && comps[q] !== comp)) continue;
          const dy = nodeY[q] - yStand;
          if (dy > up || dy < -down) continue;
          const s = d2 + dy * dy;
          if (s >= bestS) continue;
          if (needLos && !this.losTo(p, q)) continue;
          bestS = s;
          best = q;
        }
      }
    }
    return best;
  }

  /**
   * Resolves a world point to a standing position on the grid.
   *   - If `p` (horizontally) lies in the walkable area of a level, the position is `p` itself on that level
   *     (rExact = true); among several levels the one nearest in height wins.
   *   - Otherwise (or when a node is nearer in 3D than the level found) the nearest node within `radius`.
   * The standing centre may be at most `up` above / `down` below `p`; `comp` >= 0 restricts to one region
   * (the regions must be up to date). Results: rNode (node to start / end the search at), rExact, rU / rV
   * (lattice coordinates of the position), rY (its floor height). Returns false when nothing qualifies.
   */
  private resolve(p: V3, radius: number, up: number, down: number, comp: number, los: number): boolean {
    this.rNode = -1;
    this.rExact = false;
    if (!finite3(p) || this.nodeCount === 0) return false;
    const u = this.lat(p.x, this.ox);
    const v = this.lat(p.z, this.oz);
    const i = Math.floor(u);
    const j = Math.floor(v);
    const iLine = u === i;
    const jLine = v === j;
    const yStand = p.y - AGENT_H;
    let base = -1;
    let baseS = Infinity;
    let baseDy = 0;
    if (i >= 0 && i < this.nx && j >= 0 && j < this.nz) {
      const c = j * this.nx + i;
      const colStart = this.colStart;
      const nodeY = this.nodeY;
      const comps = this.comp;
      for (let q = colStart[c]; q < colStart[c + 1]; q++) {
        const dy = nodeY[q] - yStand;
        if (dy > up || dy < -down) continue;
        const s = dy * dy;
        if (s >= baseS) continue;
        if (!this.supportOk(q, iLine, jLine)) continue;
        if (comp >= 0 && comps[q] !== comp) continue;
        baseS = s;
        base = q;
        baseDy = dy;
      }
    }
    // p stands on that level (see TOL_ABOVE / TOL_BELOW): that is the answer. Otherwise look around for a
    // node that is nearer in 3D than the level found in p's own column (if any).
    let snapped = -1;
    if (!(base >= 0 && baseDy <= TOL_BELOW && baseDy >= -TOL_ABOVE)) {
      snapped = this.scanNearest(p, u, v, radius, up, down, comp, baseS, los);
    }
    if (snapped >= 0) {
      this.rNode = snapped;
      this.rU = this.nbr[snapped * ROW + NB_I];
      this.rV = this.nbr[snapped * ROW + NB_J];
      this.rY = this.nodeY[snapped];
      return true;
    }
    if (base < 0) return false;
    // Nearest corner of the supporting cell.
    let n = base;
    if (!iLine && u - i > 0.5) n = this.nbr[n * ROW + NB_E];
    if (!jLine && v - j > 0.5) n = this.nbr[n * ROW + NB_S];
    this.rNode = n;
    this.rExact = true;
    this.rU = u;
    this.rV = v;
    this.rY = this.nodeY[n];
    return true;
  }

  // ───────────────────────────── regions ─────────────────────────────

  private ensureComponents(): void {
    if (!this.compDirty) return;
    this.compDirty = false;
    const n = this.nodeCount;
    const comp = this.comp;
    const blocked = this.blocked;
    const nbr = this.nbr;
    if (this.queue.length < n) this.queue = new Int32Array(n);
    const queue = this.queue;
    comp.fill(-1);
    let count = 0;
    for (let s = 0; s < n; s++) {
      if (comp[s] !== -1 || blocked[s] !== 0) continue;
      comp[s] = count;
      let head = 0;
      let tail = 0;
      queue[tail++] = s;
      while (head < tail) {
        const a = queue[head++] * ROW;
        // Orthogonal slots only: a diagonal never joins what the orthogonal steps do not.
        for (let d = 0; d < 4; d++) {
          const b = nbr[a + d];
          if (b >= 0 && comp[b] === -1) {
            comp[b] = count;
            queue[tail++] = b;
          }
        }
      }
      count++;
    }
    this.compCount = count;
  }

  // ───────────────────────────── A* ─────────────────────────────

  /**
   * A* from node `start` to node `goal` over the node table (8-connected; a diagonal exists only through a
   * fully usable lattice square). Paths costing more than `maxCost` are not found. On success the node
   * sequence start..goal is in pathBuf[0 .. pathLen).
   *
   * Heuristic: octile distance, which is consistent, so a node is final when it is expanded and f never
   * decreases along a path. Nodes of the plateau f = `level` (the key of the last heap pop) are kept on a
   * stack and expanded before the heap is consulted again; everything else goes through the binary heap.
   */
  private search(start: number, goal: number, maxCost: number): boolean {
    if (start === goal) {
      this.pathBuf[0] = start;
      this.pathLen = 1;
      return true;
    }
    const total = this.nodeCount;
    if (this.recI.length < total * 4) {
      const buf = new ArrayBuffer(total * 16);
      this.recI = new Int32Array(buf);
      this.recF = new Float64Array(buf);
      this.queryId = 0;
    }
    if (this.queryId >= 0x3ffffff0) {
      this.recI.fill(0);
      this.queryId = 0;
    }
    const open = ++this.queryId * 2;
    const closed = open + 1;
    const recI = this.recI;
    const recF = this.recF;
    const nbr = this.nbr;
    let heapF = this.heapF;
    let heapN = this.heapN;
    let stack = this.stack;
    const cs = this.cs;
    const diag = cs * SQRT2;
    const gi = nbr[goal * ROW + NB_I];
    const gj = nbr[goal * ROW + NB_J];
    const limit = this.maxExpansions;
    // Nodes inside a sphere to avoid are never entered (the start may stand in one).
    const ban = this.banOn ? this.ban : null;
    const banId = this.banId;
    if (ban !== null && ban[goal] === banId) return false;

    let di = nbr[start * ROW + NB_I] - gi;
    let dj = nbr[start * ROW + NB_J] - gj;
    if (di < 0) di = -di;
    if (dj < 0) dj = -dj;
    /** f of the plateau being expanded. */
    let level = (di > dj ? di + OCT * dj : dj + OCT * di) * cs;
    if (level > maxCost) return false;
    recI[start * 4] = open;
    recI[start * 4 + 1] = -1;
    recF[start * 2 + 1] = 0;
    stack[0] = start;
    let sp = 1;
    let size = 0;
    let expansions = 0;
    for (;;) {
      let n: number;
      if (sp > 0) {
        n = stack[--sp];
      } else if (size > 0) {
        // ── pop the smallest f ──
        n = heapN[0];
        level = heapF[0];
        size--;
        if (size > 0) {
          const lf = heapF[size];
          const ln = heapN[size];
          let pos = 0;
          for (;;) {
            let child = pos * 2 + 1;
            if (child >= size) break;
            if (child + 1 < size && heapF[child + 1] < heapF[child]) child++;
            if (heapF[child] >= lf) break;
            heapF[pos] = heapF[child];
            heapN[pos] = heapN[child];
            pos = child;
          }
          heapF[pos] = lf;
          heapN[pos] = ln;
        }
      } else {
        break;
      }
      if (recI[n * 4] === closed) continue; // superseded entry of a node that was expanded already
      if (n === goal) {
        this.lastExpansions = expansions;
        this.lastGridCost = recF[goal * 2 + 1];
        let len = 0;
        for (let q = goal; q >= 0; q = recI[q * 4 + 1]) len++;
        if (this.pathBuf.length < len) this.pathBuf = new Int32Array(Math.max(len, this.pathBuf.length * 2));
        const buf = this.pathBuf;
        let w = len;
        for (let q = goal; q >= 0; q = recI[q * 4 + 1]) buf[--w] = q;
        this.pathLen = len;
        return true;
      }
      recI[n * 4] = closed;
      if (++expansions > limit) break;
      const g = recF[n * 2 + 1];
      const row = n * ROW;
      const ni = nbr[row + NB_I] - gi;
      const nj = nbr[row + NB_J] - gj;
      const tie = level + F_EPS;
      for (let k = 0; k < 8; k++) {
        const m = nbr[row + k];
        if (m < 0) continue;
        const st = recI[m * 4];
        if (st === closed) continue;
        if (ban !== null && ban[m] === banId) continue;
        // Cost and goal offset of the neighbour in slot k.
        let g2: number;
        di = ni;
        dj = nj;
        switch (k) {
          case 0:
            g2 = g + cs;
            di++;
            break;
          case 1:
            g2 = g + cs;
            di--;
            break;
          case 2:
            g2 = g + cs;
            dj++;
            break;
          case 3:
            g2 = g + cs;
            dj--;
            break;
          case 4:
            g2 = g + diag;
            di++;
            dj++;
            break;
          case 5:
            g2 = g + diag;
            di++;
            dj--;
            break;
          case 6:
            g2 = g + diag;
            di--;
            dj++;
            break;
          default:
            g2 = g + diag;
            di--;
            dj--;
            break;
        }
        if (st === open && g2 >= recF[m * 2 + 1]) continue;
        if (di < 0) di = -di;
        if (dj < 0) dj = -dj;
        const f = g2 + (di > dj ? di + OCT * dj : dj + OCT * di) * cs;
        // Out of budget: left unmarked, a cheaper route may still reach it later.
        if (f > maxCost) continue;
        recI[m * 4] = open;
        recI[m * 4 + 1] = n;
        recF[m * 2 + 1] = g2;
        if (f <= tie) {
          // Same plateau: expanded before anything in the heap (an older entry of m is skipped later).
          if (sp === stack.length) {
            const ns = new Int32Array(sp * 2);
            ns.set(stack);
            this.stack = stack = ns;
          }
          stack[sp++] = m;
          continue;
        }
        // ── push ──
        if (size === heapF.length) {
          const nf = new Float64Array(size * 2);
          const nn = new Int32Array(size * 2);
          nf.set(heapF);
          nn.set(heapN);
          this.heapF = heapF = nf;
          this.heapN = heapN = nn;
        }
        let pos = size++;
        while (pos > 0) {
          const up = (pos - 1) >> 1;
          if (heapF[up] <= f) break;
          heapF[pos] = heapF[up];
          heapN[pos] = heapN[up];
          pos = up;
        }
        heapF[pos] = f;
        heapN[pos] = m;
      }
    }
    this.lastExpansions = expansions;
    return false;
  }

  // ───────────────────────────── paths ─────────────────────────────

  /**
   * Common part of findPath / pathDistance. Leaves the smoothed way points as indices `outIdx[0 .. outCount)`
   * into the raw point arrays ptU / ptV / ptY (lattice coordinates, floor height) and returns the horizontal
   * path length in metres, or −1 when there is no path (or none within `maxLen`).
   *
   * strict = false (findPath): the goal is the standing position nearest to `to` (3D) among those of the
   *   start's region within `goalSnap` horizontally.
   * strict = true (pathDistance): both ends must resolve on their own (within START_SNAP, world line of
   *   sight to the node when off the walkable area) and lie in the same region.
   */
  private solve(from: V3, to: V3, goalSnap: number, maxLen: number, strict: boolean): number {
    this.outCount = 0;
    this.outExactEnd = false;
    this.lastExpansions = 0;
    this.lastGridCost = 0;
    if (!finite3(from) || !finite3(to)) return -1;
    this.build();
    if (this.nodeCount === 0) return -1;
    const cs = this.cs;
    const nodeY = this.nodeY;
    const nbr = this.nbr;

    // ── start ──
    if (!this.resolve(from, START_SNAP, TOL_BELOW, START_DOWN, -1, strict ? LOS_REQUIRE : LOS_PREFER)) return -1;
    let sNode = this.rNode;
    const sExact = this.rExact;
    const sY = this.rY;
    // An off-grid start keeps its real position as point 0; the hop to the node is part of the path.
    const sU = sExact ? this.rU : (from.x - this.ox) * this.invCs - 0.5;
    const sV = sExact ? this.rV : (from.z - this.oz) * this.invCs - 0.5;
    this.ensureComponents();
    const region = this.comp[sNode];

    // ── goal ──
    if (strict) {
      if (!this.resolve(to, START_SNAP, TOL_BELOW, START_DOWN, -1, LOS_REQUIRE)) return -1;
      if (this.comp[this.rNode] !== region) return -1;
    } else if (!this.resolve(to, goalSnap >= 0 ? goalSnap : 0, Infinity, Infinity, region, LOS_NONE)) {
      return -1;
    }
    const gNode = this.rNode;
    const gExact = this.rExact;
    const gY = this.rY;
    // Same convention for an off-grid goal of the strict mode: the hop from the node to the real position counts.
    const gOff = strict && !gExact;
    const gU = gOff ? (to.x - this.ox) * this.invCs - 0.5 : this.rU;
    const gV = gOff ? (to.z - this.oz) * this.invCs - 0.5 : this.rV;
    this.outExactEnd = gExact || gOff;

    // Nothing can be shorter than the straight line.
    const straight = Math.hypot(gU - sU, gV - sV) * cs;
    if (straight > maxLen) return -1;

    // ── straight shot ──
    if (sExact && !gOff && this.walk(sU, sV, gU, gV, sY, LEVEL_TOL, LEVEL_TOL) && Math.abs(nodeY[this.wNode] - gY) <= LEVEL_TOL && this.banFree(sU, sV, gU, gV, sY)) {
      this.ptU[0] = sU;
      this.ptV[0] = sV;
      this.ptY[0] = sY;
      this.ptU[1] = gU;
      this.ptV[1] = gV;
      this.ptY[1] = gY;
      this.outIdx[0] = 1;
      this.outCount = 1;
      return straight;
    }

    // ── grid search ──
    // A start node inside a sphere to avoid: leave from a free neighbour the start position can walk to instead.
    if (this.banOn && this.ban[sNode] === this.banId) {
      let alt = -1;
      let altD = Infinity;
      for (let k = 0; k < 8; k++) {
        const m = nbr[sNode * ROW + k];
        if (m < 0 || this.ban[m] === this.banId) continue;
        const mu = nbr[m * ROW + NB_I];
        const mv = nbr[m * ROW + NB_J];
        const d = Math.hypot(mu - sU, mv - sV);
        if (d >= altD) continue;
        if (sExact && !(this.walk(sU, sV, mu, mv, sY, LEVEL_TOL, LEVEL_TOL) && this.banFree(sU, sV, mu, mv, sY))) continue;
        alt = m;
        altD = d;
      }
      if (alt >= 0) sNode = alt;
    }
    const hopS = Math.hypot(nbr[sNode * ROW + NB_I] - sU, nbr[sNode * ROW + NB_J] - sV) * cs;
    const hopG = Math.hypot(nbr[gNode * ROW + NB_I] - gU, nbr[gNode * ROW + NB_J] - gV) * cs;
    // The grid optimum is at most OCTILE_RATIO times (plus a few cells) longer than the pulled path.
    const maxCost = maxLen === Infinity ? Infinity : (maxLen - hopS - hopG) * OCTILE_RATIO + 4 * cs;
    if (!this.search(sNode, gNode, maxCost)) return -1;

    // ── raw points: start position, node centres, exact goal (unless it is the last node centre itself) ──
    const tail = gOff || (gExact && hopG > 1e-12);
    const m = this.pathLen + 1 + (tail ? 1 : 0);
    if (this.ptU.length < m) {
      const cap = Math.max(m, this.ptU.length * 2);
      this.ptU = new Float64Array(cap);
      this.ptV = new Float64Array(cap);
      this.ptY = new Float64Array(cap);
      this.outIdx = new Int32Array(cap);
    }
    const ptU = this.ptU;
    const ptV = this.ptV;
    const ptY = this.ptY;
    const outIdx = this.outIdx;
    const path = this.pathBuf;
    ptU[0] = sU;
    ptV[0] = sV;
    ptY[0] = sY;
    for (let k = 0; k < this.pathLen; k++) {
      const q = path[k];
      ptU[k + 1] = nbr[q * ROW + NB_I];
      ptV[k + 1] = nbr[q * ROW + NB_J];
      ptY[k + 1] = nodeY[q];
    }
    if (tail) {
      ptU[m - 1] = gU;
      ptV[m - 1] = gV;
      ptY[m - 1] = gY;
    }

    // ── string pulling: keep a point only where the next one cannot be walked to in a straight line ──
    // The hops between an off-grid end and its node are fixed legs: nothing is pulled across them.
    const lastIdx = m - 1;
    const pullEnd = gOff ? lastIdx - 1 : lastIdx;
    let count = 0;
    let anchor = 0;
    if (!sExact) {
      outIdx[count++] = 1;
      anchor = 1;
    } else if (hopS <= 1e-12 && m > 2) {
      anchor = 1; // the start is the first node centre: no zero-length leg
    }
    let k = anchor + 1;
    while (k <= pullEnd) {
      if (this.walk(ptU[anchor], ptV[anchor], ptU[k], ptV[k], ptY[anchor], LEVEL_TOL, LEVEL_TOL) && Math.abs(nodeY[this.wNode] - ptY[k]) <= LEVEL_TOL && this.banFree(ptU[anchor], ptV[anchor], ptU[k], ptV[k], ptY[anchor])) {
        k++;
        continue;
      }
      // Consecutive raw points are always mutually walkable, so k − 1 > anchor here; the guard only
      // protects the loop against an inconsistency.
      const keep = k - 1 > anchor ? k - 1 : k;
      outIdx[count++] = keep;
      anchor = keep;
      k = keep + 1;
    }
    if (anchor !== pullEnd) outIdx[count++] = pullEnd;
    if (gOff) outIdx[count++] = lastIdx;
    // Second pass: drop every way point whose two neighbours can be joined directly (the greedy pass stops
    // at the first failure and can keep a point that a later one makes unnecessary).
    const head = sExact ? 0 : 1;
    const tailFixed = gOff ? 2 : 1;
    for (let pass = 0; pass < 2; pass++) {
      let w = head;
      let prev = head === 0 ? 0 : outIdx[0];
      const end = count - tailFixed; // way points [head, end) may go
      for (let q = head; q < count; q++) {
        const idx = outIdx[q];
        if (q < end) {
          const next = outIdx[q + 1];
          if (this.walk(ptU[prev], ptV[prev], ptU[next], ptV[next], ptY[prev], LEVEL_TOL, LEVEL_TOL) && Math.abs(nodeY[this.wNode] - ptY[next]) <= LEVEL_TOL && this.banFree(ptU[prev], ptV[prev], ptU[next], ptV[next], ptY[prev])) continue;
        }
        outIdx[w++] = idx;
        prev = idx;
      }
      if (w === count) break;
      count = w;
    }
    this.outCount = count;

    let len = 0;
    let pu = sU;
    let pv = sV;
    for (let q = 0; q < count; q++) {
      const idx = outIdx[q];
      len += Math.hypot(ptU[idx] - pu, ptV[idx] - pv);
      pu = ptU[idx];
      pv = ptV[idx];
    }
    len *= cs;
    return len > maxLen ? -1 : len;
  }

  /**
   * Shortest walkable path from `from` to `to` as a list of waypoints (hit-sphere centres), excluding
   * the start and ending at (or as near as walkable to) `to`. Null when unreachable.
   *
   * - `from` is a guard position (y = floor + centerHeight; up to 1.2 m above / 0.1 m below is tolerated).
   *   If it is off the walkable area but within 3 m of a node, the first waypoint is that node (one in plain
   *   view of `from` if there is any).
   * - `to` may be any point (the player's centre, a point in mid-air …). The path ends at `to` itself (x, z)
   *   when that is walkable and connected to the start, otherwise at the connected standing position
   *   nearest to `to` (3D distance, any level) within `goalSnap` metres horizontally (default 4); null when
   *   there is none — e.g. behind a closed barrier or on an unconnected floor far from any edge.
   * - Consecutive waypoints (and `from` → first) are joined by walkable straight segments (see
   *   segmentWalkable); waypoint y is floor + centerHeight. The result is never empty.
   * - The grid route is optimal for 8-connected moves; pulling it tight makes it at most that long.
   *   Null is also returned when A* exceeds `maxExpansions`.
   * - `opts.avoid`: spheres no part of the path may enter (other enemies with the distance to keep from their
   *   centres): nodes inside one are not used, pulled segments do not cut into one. A step between two
   *   neighbouring nodes that both lie outside a sphere can still dip into it by r − √(r² − cell²/2) (9 cm at
   *   r = 2.9 m on the 1 m lattice), so pass radii that include that slack. A start that stands inside a
   *   sphere may only move out of it; a goal inside one is unreachable (null). `opts.maxLength` bounds the
   *   path length (and with it the search): null when the shortest such path is longer.
   */
  findPath(from: V3, to: V3, goalSnap: number = GOAL_SNAP, opts?: NavPathOptions): V3[] | null {
    let maxLen = Infinity;
    if (opts !== undefined) {
      if (opts.maxLength !== undefined && opts.maxLength >= 0) maxLen = opts.maxLength;
      if (opts.avoid !== undefined) this.setBans(opts.avoid, opts.avoidCount ?? opts.avoid.length);
    }
    let len: number;
    try {
      len = this.solve(from, to, goalSnap, maxLen, false);
    } finally {
      this.banOn = false;
    }
    if (len < 0) return null;
    const count = this.outCount;
    const res: V3[] = new Array<V3>(count);
    const cs = this.cs;
    for (let q = 0; q < count; q++) {
      const idx = this.outIdx[q];
      const y = this.ptY[idx] + AGENT_H;
      if (q === count - 1 && this.outExactEnd) res[q] = { x: to.x, y, z: to.z };
      else res[q] = { x: this.ox + (this.ptU[idx] + 0.5) * cs, y, z: this.oz + (this.ptV[idx] + 0.5) * cs };
    }
    return res;
  }

  /**
   * Walkable path length from a to b (the length of the path findPath would return, measured
   * horizontally); Infinity when unreachable or longer than `maxDist`. Both points must be guard positions:
   * on the walkable area, or within 3 m and in plain view of a node (the hop to that node is included in
   * the length) — no "nearest reachable spot" is substituted, so two guards separated by a closed barrier
   * or standing on unconnected floors are never connected.
   */
  pathDistance(a: V3, b: V3, maxDist: number): number {
    if (!(maxDist >= 0) || !finite3(a) || !finite3(b)) return Infinity;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    if (dx * dx + dz * dz > maxDist * maxDist) return Infinity;
    const len = this.solve(a, b, 0, maxDist, true);
    return len < 0 ? Infinity : len;
  }

  // ───────────────────────────── avoidance (spheres around other enemies) ─────────────────────────────

  /** Marks the nodes inside the first `count` spheres of `discs` as banned for the next search. */
  private setBans(discs: readonly NavDisc[], count: number): void {
    this.build();
    const n = Math.min(count, discs.length);
    this.banOn = false;
    if (!(n > 0) || this.nodeCount === 0) return;
    if (this.ban.length < this.nodeCount) {
      this.ban = new Int32Array(this.nodeCount);
      this.banId = 0;
    }
    if (this.banId >= 0x7ffffff0) {
      this.ban.fill(0);
      this.banId = 0;
    }
    const id = ++this.banId;
    const ban = this.ban;
    const cs = this.cs;
    const nx = this.nx;
    const colStart = this.colStart;
    const nodeY = this.nodeY;
    let any = false;
    for (let k = 0; k < n; k++) {
      const d = discs[k];
      const r = d.r;
      if (!(r > 0) || !Number.isFinite(d.x + d.y + d.z + r)) continue;
      any = true;
      let i0 = Math.ceil((d.x - r - this.ox) * this.invCs - 0.5);
      let i1 = Math.floor((d.x + r - this.ox) * this.invCs - 0.5);
      let j0 = Math.ceil((d.z - r - this.oz) * this.invCs - 0.5);
      let j1 = Math.floor((d.z + r - this.oz) * this.invCs - 0.5);
      if (!(i0 > 0)) i0 = 0;
      if (!(j0 > 0)) j0 = 0;
      if (!(i1 < nx - 1)) i1 = nx - 1;
      if (!(j1 < this.nz - 1)) j1 = this.nz - 1;
      const r2 = r * r;
      for (let j = j0; j <= j1; j++) {
        const dz = this.oz + (j + 0.5) * cs - d.z;
        for (let i = i0; i <= i1; i++) {
          const dx = this.ox + (i + 0.5) * cs - d.x;
          const d2 = dx * dx + dz * dz;
          if (d2 >= r2) continue;
          const c = j * nx + i;
          for (let q = colStart[c]; q < colStart[c + 1]; q++) {
            const dy = nodeY[q] + AGENT_H - d.y;
            if (d2 + dy * dy < r2) ban[q] = id;
          }
        }
      }
    }
    if (!any) return;
    this.banOn = true;
    this.banDiscs = discs;
    this.banCount = n;
  }

  /**
   * True when the straight segment (u0, v0) → (u1, v1) (lattice coordinates, floor height `floorY`) keeps out
   * of every sphere to avoid. A segment that starts inside a sphere is accepted when it leads straight out of
   * it (it never gets nearer to the centre than its start). Always true when nothing is to be avoided.
   */
  private banFree(u0: number, v0: number, u1: number, v1: number, floorY: number): boolean {
    if (!this.banOn) return true;
    const cs = this.cs;
    const ax = this.ox + (u0 + 0.5) * cs;
    const az = this.oz + (v0 + 0.5) * cs;
    const sx = (u1 - u0) * cs;
    const sz = (v1 - v0) * cs;
    const sl2 = sx * sx + sz * sz;
    const y = floorY + AGENT_H;
    const discs = this.banDiscs;
    for (let k = 0; k < this.banCount; k++) {
      const d = discs[k];
      const dy = y - d.y;
      const rr = d.r * d.r - dy * dy;
      if (!(rr > 0)) continue;
      const cx = ax - d.x;
      const cz = az - d.z;
      const along = cx * sx + cz * sz;
      if (cx * cx + cz * cz < rr) {
        // Starts inside: only straight out.
        if (along < 0) return false;
        continue;
      }
      if (along >= 0 || !(sl2 > 0)) continue; // moving away: the start is the nearest point
      const t = -along >= sl2 ? 1 : -along / sl2;
      const px = cx + sx * t;
      const pz = cz + sz * t;
      if (px * px + pz * pz < rr) return false;
    }
    return true;
  }

  // ───────────────────────────── vantage search ─────────────────────────────

  /**
   * Explores the walkable region of `from` in order of increasing path length (Dijkstra over the node table,
   * at most `opts.maxCost` metres of path) for a standing spot to look at `target` from:
   *   - VANTAGE_QUALIFIED: the first spot (shortest path) whose standing centre is within `opts.within` of the
   *     target and whose eye (centre + eyeUp) has a clear line to it in the world;
   *   - VANTAGE_FALLBACK: there is none, and `opts.fallback` names a second choice (the explored spot nearest
   *     to the target, with or without a view of it) that is at least `opts.minGain` nearer than `from`;
   *   - VANTAGE_NONE: nothing (also when `from` has no standing position).
   * The spot (a node: x, standing height, z) is written to `out`; `findPath(from, out, 1)` leads there.
   * Sight tests are made on every third node of a diagonal pattern (each row and column of the lattice has
   * one every 3 cells) and are bounded by `opts.maxSightTests`, so the cost of a query stays within a few ms.
   * Deterministic; allocates nothing.
   */
  findVantage(from: V3, target: V3, opts: NavVantageOptions, out: V3): number {
    this.lastVantageExpansions = 0;
    this.lastVantageSightTests = 0;
    this.lastVantageCost = 0;
    if (!finite3(from) || !finite3(target)) return VANTAGE_NONE;
    this.build();
    if (this.nodeCount === 0) return VANTAGE_NONE;
    if (!this.resolve(from, START_SNAP, TOL_BELOW, START_DOWN, -1, LOS_PREFER)) return VANTAGE_NONE;
    const start = this.rNode;
    const total = this.nodeCount;
    if (this.recI.length < total * 4) {
      const buf = new ArrayBuffer(total * 16);
      this.recI = new Int32Array(buf);
      this.recF = new Float64Array(buf);
      this.queryId = 0;
    }
    if (this.queryId >= 0x3ffffff0) {
      this.recI.fill(0);
      this.queryId = 0;
    }
    const open = ++this.queryId * 2;
    const closed = open + 1;
    const recI = this.recI;
    const recF = this.recF;
    const nbr = this.nbr;
    const nodeY = this.nodeY;
    let heapF = this.heapF;
    let heapN = this.heapN;
    const cs = this.cs;
    const diag = cs * SQRT2;
    const ox = this.ox + 0.5 * cs;
    const oz = this.oz + 0.5 * cs;
    const world = this.world;
    const eye = this.tmpA;
    const tx = target.x;
    const ty = target.y;
    const tz = target.z;
    const within2 = opts.within * opts.within;
    const maxCost = opts.maxCost;
    const limit = opts.maxExpansions !== undefined && opts.maxExpansions >= 1 ? opts.maxExpansions : DEFAULT_VANTAGE_EXPANSIONS;
    const sightLimit = opts.maxSightTests !== undefined && opts.maxSightTests >= 0 ? opts.maxSightTests : DEFAULT_VANTAGE_SIGHT_TESTS;
    const wantVisible = opts.fallback === 'visible';
    const wantNearest = opts.fallback === 'nearest';
    const startD = Math.hypot(from.x - tx, from.y - ty, from.z - tz);
    /** Fallback candidate: must end up at least minGain nearer than the start. */
    let best = -1;
    let bestD = startD - (opts.minGain > 0 ? opts.minGain : 0);
    let bestCost = 0;
    let sights = 0;
    let expansions = 0;
    let found = -1;

    recI[start * 4] = open;
    recF[start * 2 + 1] = 0;
    heapF[0] = 0;
    heapN[0] = start;
    let size = 1;
    while (size > 0) {
      const n = heapN[0];
      const g = heapF[0];
      size--;
      if (size > 0) {
        const lf = heapF[size];
        const ln = heapN[size];
        let pos = 0;
        for (;;) {
          let child = pos * 2 + 1;
          if (child >= size) break;
          if (child + 1 < size && heapF[child + 1] < heapF[child]) child++;
          if (heapF[child] >= lf) break;
          heapF[pos] = heapF[child];
          heapN[pos] = heapN[child];
          pos = child;
        }
        heapF[pos] = lf;
        heapN[pos] = ln;
      }
      if (recI[n * 4] === closed) continue;
      recI[n * 4] = closed;
      if (++expansions > limit) break;
      const row = n * ROW;
      const ni = nbr[row + NB_I];
      const nj = nbr[row + NB_J];
      // ── evaluate the spot ──
      const px = ox + ni * cs;
      const py = nodeY[n] + AGENT_H;
      const pz = oz + nj * cs;
      const dx = px - tx;
      const dy = py - ty;
      const dz = pz - tz;
      const d2 = dx * dx + dy * dy + dz * dz;
      const inside = d2 <= within2;
      if (wantNearest && d2 < bestD * bestD) {
        best = n;
        bestD = Math.sqrt(d2);
        bestCost = g;
      }
      const better = wantVisible && bestD > VANTAGE_STEP && d2 < (bestD - VANTAGE_STEP) * (bestD - VANTAGE_STEP);
      if ((inside || better) && sights < sightLimit && (ni + nj) % 3 === 0) {
        sights++;
        eye.x = px;
        eye.y = py + opts.eyeUp;
        eye.z = pz;
        if (!world.segmentBlocked(eye, target)) {
          if (inside) {
            found = n;
            bestCost = g;
            break;
          }
          best = n;
          bestD = Math.sqrt(d2);
          bestCost = g;
        }
      }
      // ── neighbours ──
      for (let k = 0; k < 8; k++) {
        const m = nbr[row + k];
        if (m < 0) continue;
        const st = recI[m * 4];
        if (st === closed) continue;
        const g2 = g + (k < 4 ? cs : diag);
        if (g2 > maxCost || (st === open && g2 >= recF[m * 2 + 1])) continue;
        recI[m * 4] = open;
        recF[m * 2 + 1] = g2;
        if (size === heapF.length) {
          const nf = new Float64Array(size * 2);
          const nn = new Int32Array(size * 2);
          nf.set(heapF);
          nn.set(heapN);
          this.heapF = heapF = nf;
          this.heapN = heapN = nn;
        }
        let pos = size++;
        while (pos > 0) {
          const up = (pos - 1) >> 1;
          if (heapF[up] <= g2) break;
          heapF[pos] = heapF[up];
          heapN[pos] = heapN[up];
          pos = up;
        }
        heapF[pos] = g2;
        heapN[pos] = m;
      }
    }
    this.lastVantageExpansions = expansions;
    this.lastVantageSightTests = sights;
    const pick = found >= 0 ? found : best;
    if (pick < 0) return VANTAGE_NONE;
    this.lastVantageCost = bestCost;
    out.x = ox + nbr[pick * ROW + NB_I] * cs;
    out.y = nodeY[pick] + AGENT_H;
    out.z = oz + nbr[pick * ROW + NB_J] * cs;
    return found >= 0 ? VANTAGE_QUALIFIED : VANTAGE_FALLBACK;
  }

  // ───────────────────────────── helpers for the AI ─────────────────────────────

  /**
   * Nearest standing position to `p`: `p` itself (y corrected to floor + centerHeight) when it is walkable,
   * otherwise the nearest node within `maxDist` metres horizontally (3D distance; a node in plain view of
   * `p` is preferred over a nearer one behind a wall). Null when there is none.
   */
  nearestWalkable(p: V3, maxDist: number = START_SNAP, out: V3 = { x: 0, y: 0, z: 0 }): V3 | null {
    this.build();
    if (!this.resolve(p, maxDist >= 0 ? maxDist : 0, Infinity, Infinity, -1, LOS_PREFER)) return null;
    if (this.rExact) {
      out.x = p.x;
      out.z = p.z;
    } else {
      out.x = this.ox + (this.rU + 0.5) * this.cs;
      out.z = this.oz + (this.rV + 0.5) * this.cs;
    }
    out.y = this.rY + AGENT_H;
    return out;
  }

  /**
   * A random standing position near `p`: the node nearest to a uniformly drawn point of the disc of `radius`
   * metres around `p` (so at most half a cell diagonal outside it), in the walkable region of `p` and on p's
   * floor (within 0.75 m of its height). Deterministic for a given generator state: draws two numbers per
   * attempt, at most 24 attempts. Null when `p` has no standing position nearby or no attempt hit a usable
   * node (try again or shrink the radius).
   */
  randomWalkableNear(p: V3, radius: number, rng: NavRandom, out: V3 = { x: 0, y: 0, z: 0 }): V3 | null {
    this.build();
    if (!(radius >= 0) || !this.resolve(p, START_SNAP, TOL_BELOW, START_DOWN, -1, LOS_PREFER)) return null;
    this.ensureComponents();
    const region = this.comp[this.rNode];
    const floorY = this.rY;
    const u = (p.x - this.ox) * this.invCs - 0.5;
    const v = (p.z - this.oz) * this.invCs - 0.5;
    const rc = radius * this.invCs;
    for (let attempt = 0; attempt < 24; attempt++) {
      const ang = rng.next() * 2 * Math.PI;
      const r = rc * Math.sqrt(rng.next());
      const i = Math.round(u + Math.cos(ang) * r);
      const j = Math.round(v + Math.sin(ang) * r);
      const n = this.nodeAt(i, j, floorY, LEVEL_TOL, LEVEL_TOL);
      if (n < 0 || this.blocked[n] !== 0 || this.comp[n] !== region) continue;
      out.x = this.ox + (i + 0.5) * this.cs;
      out.y = this.nodeY[n] + AGENT_H;
      out.z = this.oz + (j + 0.5) * this.cs;
      return out;
    }
    return null;
  }

  /**
   * True when `a` and `b` (guard positions, resolved like pathDistance's end points) lie in the same
   * walkable region with the current barrier state — i.e. some path joins them, whatever its length.
   */
  connected(a: V3, b: V3): boolean {
    this.build();
    if (!this.resolve(a, START_SNAP, TOL_BELOW, START_DOWN, -1, LOS_REQUIRE)) return false;
    const na = this.rNode;
    if (!this.resolve(b, START_SNAP, TOL_BELOW, START_DOWN, -1, LOS_REQUIRE)) return false;
    this.ensureComponents();
    return this.comp[na] === this.comp[this.rNode];
  }
}
