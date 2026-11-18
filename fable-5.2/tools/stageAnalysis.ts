/**
 * Independent stage analysis for docs/SPEC.md §2.2 — everything is derived from the real collision boxes
 * (stage.solids + barriers + final gate) and the declared metadata. Used by tools/validateStage.ts (CLI) and
 * tests/stage.test.ts. Must not import three.js.
 *
 * ─── Voxel model ────────────────────────────────────────────────────────────────────────────────────────
 * Regular grid: 1 m cells in X/Z, `cellY` (default 0.5 m) in Y. Cell centres are at (k + 0.5) m in X/Z and at
 * multiples of cellY in Y, so the player's box bottom (centre - 2.0) falls on multiples of cellY.
 * Two occupancy masks are rasterised from the solids ("C-space obstacles" = solid inflated by the player's
 * half extents 1.3 / 2.0 / 1.3):
 *
 *   STRICT (S)  a cell is free when the player's box centred at the cell CENTRE overlaps no solid (the shared
 *               definition). Floods on S use 26-connectivity WITHOUT corner cutting (a diagonal move needs
 *               every cell of its 2x2(x2) block free), which makes every centre-to-centre move a
 *               collision-free sweep of the real box: S-reachability is a rigorous UNDER-approximation of
 *               what a free-flying player can do. Used to prove "possible".
 *
 *   LOOSE (L)   a cell is free when SOME point of its closed cube is a legal player centre (the cube is not
 *               entirely covered by the union of the open inflated solids — tested exactly, not by sampling).
 *               Every real player position lies in an L-free cell and any continuous motion visits a
 *               face-connected chain of L-free cells: L-reachability is a rigorous OVER-approximation of what
 *               a player could ever do (flight, QB, any shortcut; gravity and EN ignored). Used to prove
 *               "impossible / unavoidable".
 *
 * Cells whose centre is below stage.killY are not traversable. Closed barriers / the closed final gate are
 * solids. A STANDING cell is an S-free cell whose box rests on a solid (the cell below is blocked by a solid);
 * each standing cell counts as 1 m². "Reachable" = from the player start with every barrier and the gate open.
 *
 * ─── Checks (thresholds in LIMITS) ──────────────────────────────────────────────────────────────────────
 * V1  Sectors: count, unique ids, pairwise disjoint bounds, >= 150 m² of reachable standing cells (cell centre
 *     inside the sector bounds) in each. Kinds of space are MEASURED, not read from the labels: every sector's
 *     declared kind must hold as a geometric property of the sector (kindRule on sectorShape: corridor / road =
 *     narrow and long, shaft = taller than its floor is wide, tunnel = low and below ground level, multilevel = stacked
 *     floors, yard = open single-level floor with little tall equipment, factory / plant = >= 10 % of the floor
 *     under free-standing equipment taller than the mech, warehouse = rack rows; dock / gate are functional) and
 *     the count (>= 6) is taken over the geometric classes.
 * V2  Enemies: 30 guards + 15 turrets, unique ids, 6 control turrets <-> 6 barriers one-to-one, in 6 sectors;
 *     >= 15 sectors contain an enemy of their own; per enemy: centre inside its sector, sphere clear of
 *     solids/closed barriers, first surface straight below the centre at centerHeight ± 0.06 m, guards: >= 100 m²
 *     of 4-connected flat floor (1 m lattice, guard-sized box, same floor height) and — with the game's own
 *     NavGrid (src/sim/nav.ts) — the guard starts on a walkable node with >= 100 connected walkable lattice
 *     points within 12 m; attackable: a reachable S cell 4..100 m away whose centre AND muzzle (player facing
 *     the enemy) have a clear World.segmentBlocked line to the enemy centre (barriers open).
 *     Mobility (NavGrid, every barrier open): >= 24 guards have a region of >= 1000 m² that contains a waypoint
 *     of the recommended route (they can come for the player), >= 20 stand on the main floor of their sector,
 *     and every combat arena has such a guard on its main floor. A NavGrid exception fails the check.
 * V3  Shortest route start → exitZone with everything open. Reports Lgrid (Dijkstra on S, Euclidean weights
 *     on the 26 moves of a 1 m lattice plus the half steps in Y), LgridLoose (same on L), and
 *       proven bound  = H - 1, H = octagonal hop count on L (see VoxelGrid.hopDistance — a complete proof);
 *       voxel bound   = (LgridLoose - 2.5) / 1.12806 (worst-case chamfer/Euclid ratio; 2.5 m = end-point
 *                       rounding + float32 accumulation). Exact in open space; around obstacles it relies on
 *                       the grid path being able to hug the eroded (LOOSE) obstacles as tightly as a real path.
 *     lower bound = max(proven, voxel) must be >= 1500 m; a warning is issued when only the voxel bound gets
 *     there. An explicit feasible route (upper bound) is produced by string-pulling the S path with swept-box
 *     tests of the real World; lower <= upper is asserted.
 * V4  Mandatory sector: with every L cell blocked in which all legal centres lie inside the sector bounds, the
 *     exit is unreachable on L. >= 12 such sectors (start / exit sectors included).
 * V5  Each barrier alone closed → exit unreachable on L; gate alone closed → exit unreachable on L. For
 *     i = 1..6 with Bi..B6 + gate closed: control turret i is attackable (as in V2, range 120 m) from the S
 *     region; control turret i+1 is NOT attackable from the L region: (1) ray fan — 90 000 rays from the centre
 *     and 5 rim points of its sphere, marched up to 121.5 m; (2) every L-region cell within 121.5 m is tested
 *     with exact segments from its centre to the centre and 6 rim points of the sphere. Both are dense
 *     samplings (fine near the turret / uniform 1 m everywhere), not a proof against slits thinner than that.
 * V6  Flight spots (>= 6, from/to points of different spots >= 20 m apart). Per spot: height = to.y - from.y in
 *     6..16 m and equal to `height` ± 0.1; from / to are resting positions of the real box, each inside a
 *     6 x 6 m square of resting positions; (a) blocking the L cells whose legal centres all lie inside `cut`
 *     disconnects the exit; (b) the no-flight closure (VoxelGrid.noFlightClosure) seeded from every resting
 *     cell of the near side N — except the lip of the landing, i.e. cells within 1.81 m of the cut box — must
 *     not reach ANY cell beyond the cut (stricter than "must not reach the exit", which is also reported);
 *     (e) the declared take-off is the designer's choice, so the SMALLEST climb that crosses the cut is measured
 *     too: the same closure with a hypothetical jump of j m first crosses at j = minClimb (0.5 m steps); it must
 *     not cross with j = 6 - cellY, i.e. every crossing contains a continuous climb of >= 6 m;
 *     an analytic EN estimate for the weakest loadout must be <= 90.
 *     Separate climbs: the cut boxes are pairwise disjoint, no spot has its from / to on different sides of
 *     another spot's cut, and the near sides are strictly nested (one opening cannot be counted twice).
 * V6d The real Sim flies every spot (simulateFlightSpot: keyboard-level controller, real player physics) with
 *     all 6 generator x legs combinations — the FCS does not affect movement, so this covers the 18 loadouts;
 *     the weakest is generator 'recovery' (EN 90) + legs 'quadruped' (12.8 m/s in the air).
 * V7  Branches (>= 3, via mid-points >= 20 m apart): for both alternatives a no-corner-cutting S path
 *     from → via → to exists with the 12 m ball around the other via blocked; each >= 40 m; an alternative
 *     whose second leg retraces > 50 % of the first (via in a dead end) is rejected.
 *     Structure (branchSeparation): a passage cross-section through viaA and one through viaB (the L cells of a
 *     2 m slab through the via point, connected to it inside the slab) share no cell, neither alternative
 *     touches the other's section, and with BOTH sections closed `to` is unreachable from `from` on L — two
 *     separate passages and no third way. Open floor, or a hole in the separating wall, fails.
 *     Tactical difference, measured on each alternative's own section (samples > 8 m from the other path): the
 *     shorter alternative must be seen by more enemies, by more at once, and have >= 2x the firing lines per
 *     metre of the longer one ("short but under fire" vs "longer but covered").
 * V8  Loops (>= 2, centroids >= 20 m apart): >= 3 waypoints, consecutive legs connected on S, perimeter
 *     60..400 m, and for every waypoint the others stay connected (within 400 m) with an 8 m ball around it blocked.
 *     Structure: the plan polygon of the circuit encloses >= 50 m² of columns that cannot be walked on at the
 *     circuit's level (solid core or void), these are >= 25 % of everything it encloses, and no two
 *     non-adjacent waypoints are joined by a straight walk.
 * V9  Levels: floor heights of the reachable standing cells; a band = all floors within ± 1 m of a height;
 *     >= 3 bands >= 5 m apart with >= 400 m² each; >= 200 m² of columns with two major floors >= 5 m apart.
 * V10 Arenas: for combatArena sectors, the largest 8-connected component of the main floor (most frequent
 *     floor height) spans >= 60 and >= 50 cells and fills >= 45 % of its bounding rectangle; >= 5 sectors.
 * V11 In >= 5 arena sectors: >= 4 enemies assigned, and >= 15 % of the sector's standing cells are within range
 *     and LOS (muzzle = centre + 0.5 → floor + 2.0, barriers closed) of >= 4 of them spanning >= 90° of bearing.
 * V12 Start is a resting position; no enemy has range + LOS (barriers closed) to the centre, top centre or top
 *     corners of the player box on any standing cell of the start sector; the real box sweeps 60 m along the
 *     start yaw without contact over continuously supported floor.
 * V13 Everything inside stage.bounds, no degenerate boxes, solids/decor <= 3500, the L-reachable region does not
 *     touch the outermost layer of the grid, no decor box overlaps the player box at a reachable S cell unless
 *     it is thinner than 0.25 m and more than 5 m above the surface below it — and such thin decor must be
 *     mounted (<= 4.5 m below a ceiling, or a wall within 0.35 m): no cable across open flight space;
 *     no visible coplanar, same-facing, overlapping faces between solids (z-fighting).
 * V14 Walkthrough (V3–V8 are free-flight statements that ignore gravity and EN): every waypoint of stage.route
 *     is a resting position inside its declared sector; the recorded polyline can be followed AS DRAWN (level
 *     segment = straight walk over continuous floor, climb = straight up at its lower end and level to the
 *     landing, drop = level off the edge and straight down); and the real Sim, driven through keyboard-level
 *     input only (runWalkthrough), walks / drops / flies the route from the start into the exit zone with the
 *     weakest and with the default loadout. Two documented cheats: HP is refilled every tick, and shooting is
 *     replaced by "the next control turret in barrier order is destroyed once the grounded player has a clear
 *     line of <= 120 m from centre and muzzle". Required: Sim.status 'cleared', every waypoint reached in order,
 *     control turrets destroyed in barrier order, >= 12 sectors entered, >= 1500 m travelled. Routes passed in
 *     AnalyzeOptions.extraRoutes (the shipped stage: the detour side of every branch) are checked and played the
 *     same way with the weakest loadout.
 * V15 Route defence (static, initial enemy positions, all barriers open): the route as drawn is sampled every
 *     metre; outside the start sector no stretch longer than 100 m is without an enemy firing line, >= 60 % of
 *     it lies under at least one, and every sector on the route has an enemy with a line onto the route.
 * V16 Combat walkthrough: runWalkthrough with opts.combat — no cheats, the bot shoots with the real weapons and
 *     FCS against the real enemy AI (see runWalkthrough for its simple policy). Required: it clears the route
 *     with the default loadout for three seeds, destroying the six control turrets itself; HP at every barrier
 *     and damage per sector are reported.
 *
 * A check that cannot run (simulation disabled, player.ts / enemies.ts still stubs) is reported as NOT RUN and
 * makes the overall result INCOMPLETE — never PASS (AnalyzeOptions.allowSkips overrides this deliberately).
 * A simulation that throws is a FAILURE.
 */
import { CAMERA, DEFAULT_LOADOUT, ENEMIES, GENERATOR_PARTS, GRAVITY, LEGS_PARTS, PLAYER, TICK } from '../src/config';
import type { V3 } from '../src/core/vec';
import type { Box, EnemyState, GeneratorId, LegsId, Loadout, StageDef, Weapon } from '../src/sim/types';
import { Sim } from '../src/sim/sim';
import { NavGrid } from '../src/sim/nav';
import { World } from '../src/sim/world';
import { makeTestStage } from '../src/stage/testStages';

export const HX = PLAYER.half.x;
export const HY = PLAYER.half.y;
export const HZ = PLAYER.half.z;
const EPS = 1e-9;
const EPSI = 1e-7;
const PADX = 1;
const PADY = 2;

/**
 * Worst-case ratio between the 26-neighbour (chamfer 1, √2, √3) lattice metric and the Euclidean norm.
 * The lattice metric is the norm ‖v‖ = a + (√2-1)·b + (√3-√2)·c for |v| sorted a >= b >= c >= 0; maximising
 * it over the unit sphere gives sqrt(1 + (√2-1)² + (√3-√2)²) ≈ 1.12806 at v ∝ (1, 0.414, 0.318).
 */
export const CHAMFER_RATIO = Math.sqrt(1 + (Math.SQRT2 - 1) ** 2 + (Math.sqrt(3) - Math.SQRT2) ** 2);

export interface GridOptions {
  /** Vertical cell size (m): 0.5 (default) or 1. Horizontal cells are always 1 m. */
  cellY?: number;
  /** Margin (m) kept around the solids when stage.bounds is larger than the built geometry. */
  margin?: number;
  /** Refuse to build grids larger than this (cells). */
  maxCells?: number;
}

export interface Blocker {
  /** Cells blocked in the STRICT grid. */
  s: Int32Array;
  /** Cells blocked in the LOOSE grid. */
  l: Int32Array;
}

function boxUnion(a: Box | null, b: Box): Box {
  if (!a) return { min: { ...b.min }, max: { ...b.max } };
  return {
    min: { x: Math.min(a.min.x, b.min.x), y: Math.min(a.min.y, b.min.y), z: Math.min(a.min.z, b.min.z) },
    max: { x: Math.max(a.max.x, b.max.x), y: Math.max(a.max.y, b.max.y), z: Math.max(a.max.z, b.max.z) },
  };
}

/** Indices i for which a + i*step lies strictly inside (lo, hi). */
function openRange(lo: number, hi: number, a: number, step: number, n: number): [number, number] {
  let i0 = Math.floor((lo - a) / step + EPSI) + 1;
  let i1 = Math.ceil((hi - a) / step - EPSI) - 1;
  if (i0 < 0) i0 = 0;
  if (i1 > n - 1) i1 = n - 1;
  return [i0, i1];
}

// scratch for the exact cube-coverage test
let covXs = new Float64Array(64);
let covYs = new Float64Array(64);
let covZs = new Float64Array(64);

/**
 * True when every point of the closed cube [x0,x1]x[y0,y1]x[z0,z1] lies strictly inside at least one of the
 * k open boxes stored in `b` as (lox, loy, loz, hix, hiy, hiz).
 * Exact: if an uncovered point exists, sliding it towards -x, then -y, then -z until it is stopped (by the
 * cube face or by the max-face of a box) ends on an uncovered point whose coordinates all belong to the
 * candidate sets {cube min} ∪ {box max faces inside the cube}; so testing the candidate products suffices.
 */
export function cubeCovered(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, b: Float64Array, k: number): boolean {
  if (covXs.length < k + 2) {
    covXs = new Float64Array(2 * k + 2);
    covYs = new Float64Array(2 * k + 2);
    covZs = new Float64Array(2 * k + 2);
  }
  let nxs = 0;
  let nys = 0;
  let nzs = 0;
  covXs[nxs++] = x0;
  covYs[nys++] = y0;
  covZs[nzs++] = z0;
  covXs[nxs++] = x1;
  covYs[nys++] = y1;
  covZs[nzs++] = z1;
  for (let i = 0; i < k; i++) {
    const o = i * 6;
    const hx = b[o + 3];
    const hy = b[o + 4];
    const hz = b[o + 5];
    if (hx > x0 && hx < x1) covXs[nxs++] = hx;
    if (hy > y0 && hy < y1) covYs[nys++] = hy;
    if (hz > z0 && hz < z1) covZs[nzs++] = hz;
  }
  for (let a = 0; a < nxs; a++) {
    const x = covXs[a];
    for (let c = 0; c < nzs; c++) {
      const z = covZs[c];
      for (let d = 0; d < nys; d++) {
        const y = covYs[d];
        let inside = false;
        for (let i = 0; i < k; i++) {
          const o = i * 6;
          if (x > b[o] + EPS && x < b[o + 3] - EPS && y > b[o + 1] + EPS && y < b[o + 4] - EPS && z > b[o + 2] + EPS && z < b[o + 5] - EPS) {
            inside = true;
            break;
          }
        }
        if (!inside) return false;
      }
    }
  }
  return true;
}

export class VoxelGrid {
  readonly cy: number;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly n: number;
  readonly sz: number;
  readonly sy: number;
  /** World coordinate of the low face of cell column 0 (X/Z) and of the centre of cell layer 0 (Y). */
  readonly x0: number;
  readonly y0: number;
  readonly z0: number;
  /** Extent actually covered (stage.bounds clipped to the built geometry + margin). */
  readonly extent: Box;
  readonly clipped: boolean;
  /** 0 = free, 1 = blocked by a permanent solid, 2 = padding / below killY (never a support). */
  readonly baseS: Uint8Array;
  readonly baseL: Uint8Array;
  /**
   * Resting cells of the LOOSE model: cells whose cube contains a legal player position resting on a solid
   * (tested exactly); the value is index + 1 into `tops` of the highest such supporting surface.
   */
  readonly lStand: Uint16Array;
  readonly tops: Float64Array;
  /** 26-neighbourhood: axis moves first. */
  readonly off26: Int32Array;
  /** For each of the 26 moves: the other cells of its 2x2(x2) block (offsets), -> no corner cutting. */
  readonly mid26: Int32Array[];
  /** Vertical component (in cells) of each of the 26 moves. */
  readonly dy26: Int8Array;
  readonly looseAmbiguous: number;

  private readonly inf: Float64Array; // inflated solids (open boxes) 6 per solid
  private readonly raw: Float64Array; // raw solids 6 per solid
  private readonly bucketStart: Int32Array;
  private readonly bucketItems: Int32Array;
  private readonly bw: number;
  private readonly bh: number;
  private local = new Float64Array(6 * 64);
  private queue: Int32Array | null = null;
  private mark: Uint8Array | null = null;

  constructor(readonly stage: StageDef, opts: GridOptions = {}) {
    const cy = opts.cellY ?? 0.5;
    if (!(cy === 0.5 || cy === 1)) throw new Error('cellY must be 0.5 or 1');
    this.cy = cy;
    const margin = opts.margin ?? 8;
    // Extent: stage.bounds, clipped to the built geometry (+ margin) when the bounds are much larger.
    let geo: Box | null = null;
    for (const s of stage.solids) geo = boxUnion(geo, s);
    for (const b of stage.barriers) geo = boxUnion(geo, b.box);
    const sp = stage.playerStart.position;
    geo = boxUnion(geo, { min: { x: sp.x - HX, y: sp.y - HY, z: sp.z - HZ }, max: { x: sp.x + HX, y: sp.y + HY, z: sp.z + HZ } });
    const B = stage.bounds;
    const ext: Box = {
      min: { x: Math.max(B.min.x, geo.min.x - margin), y: Math.max(B.min.y, geo.min.y - margin), z: Math.max(B.min.z, geo.min.z - margin) },
      max: { x: Math.min(B.max.x, geo.max.x + margin), y: Math.min(B.max.y, geo.max.y + margin), z: Math.min(B.max.z, geo.max.z + margin) },
    };
    this.extent = ext;
    this.clipped = ext.min.x > B.min.x || ext.min.y > B.min.y || ext.min.z > B.min.z || ext.max.x < B.max.x || ext.max.y < B.max.y || ext.max.z < B.max.z;
    this.x0 = Math.floor(ext.min.x) - PADX;
    this.z0 = Math.floor(ext.min.z) - PADX;
    this.y0 = Math.floor(ext.min.y) - PADY * cy;
    this.nx = Math.ceil(ext.max.x) - Math.floor(ext.min.x) + 2 * PADX;
    this.nz = Math.ceil(ext.max.z) - Math.floor(ext.min.z) + 2 * PADX;
    this.ny = Math.ceil((ext.max.y - Math.floor(ext.min.y)) / cy) + 1 + 2 * PADY;
    this.n = this.nx * this.ny * this.nz;
    if (!(this.n > 0) || this.n > (opts.maxCells ?? 120e6)) {
      throw new Error(`voxel grid ${this.nx} x ${this.ny} x ${this.nz} is empty or too large`);
    }
    this.sz = this.nx;
    this.sy = this.nx * this.nz;
    const { nx, ny, nz, n, sz, sy } = this;
    const S = (this.baseS = new Uint8Array(n));
    const L = (this.baseL = new Uint8Array(n));

    // padding + kill zone
    for (let iy = 0; iy < ny; iy++) {
      const dead = iy < PADY || iy >= ny - PADY || this.Y(iy) < stage.killY;
      for (let iz = 0; iz < nz; iz++) {
        const row = (iy * nz + iz) * nx;
        if (dead || iz < PADX || iz >= nz - PADX) {
          S.fill(2, row, row + nx);
        } else {
          S[row] = 2;
          S[row + nx - 1] = 2;
        }
      }
    }
    L.set(S);

    // solids
    const ns = stage.solids.length;
    const inf = (this.inf = new Float64Array(ns * 6));
    const raw = (this.raw = new Float64Array(ns * 6));
    const ax = this.x0 + 0.5;
    const az = this.z0 + 0.5;
    const ay = this.y0;
    for (let i = 0; i < ns; i++) {
      const s = stage.solids[i];
      const o = i * 6;
      raw[o] = s.min.x;
      raw[o + 1] = s.min.y;
      raw[o + 2] = s.min.z;
      raw[o + 3] = s.max.x;
      raw[o + 4] = s.max.y;
      raw[o + 5] = s.max.z;
      inf[o] = s.min.x - HX;
      inf[o + 1] = s.min.y - HY;
      inf[o + 2] = s.min.z - HZ;
      inf[o + 3] = s.max.x + HX;
      inf[o + 4] = s.max.y + HY;
      inf[o + 5] = s.max.z + HZ;
      this.fill(S, 1, inf[o], inf[o + 3], inf[o + 1], inf[o + 4], inf[o + 2], inf[o + 5], false);
      this.fill(L, 1, inf[o] + 0.5, inf[o + 3] - 0.5, inf[o + 1] + cy / 2, inf[o + 4] - cy / 2, inf[o + 2] + 0.5, inf[o + 5] - 0.5, false);
    }

    // XZ buckets (4 m) of inflated solids, for local exact tests
    const bw = (this.bw = Math.ceil(nx / 4));
    const bh = (this.bh = Math.ceil(nz / 4));
    const counts = new Int32Array(bw * bh + 1);
    const span = (i: number): [number, number, number, number] => {
      const o = i * 6;
      const bx0 = Math.max(0, Math.floor((inf[o] - 0.5 - this.x0) / 4));
      const bx1 = Math.min(bw - 1, Math.floor((inf[o + 3] + 0.5 - this.x0) / 4));
      const bz0 = Math.max(0, Math.floor((inf[o + 2] - 0.5 - this.z0) / 4));
      const bz1 = Math.min(bh - 1, Math.floor((inf[o + 5] + 0.5 - this.z0) / 4));
      return [bx0, bx1, bz0, bz1];
    };
    for (let i = 0; i < ns; i++) {
      const [bx0, bx1, bz0, bz1] = span(i);
      for (let bz = bz0; bz <= bz1; bz++) for (let bx = bx0; bx <= bx1; bx++) counts[bz * bw + bx + 1]++;
    }
    for (let i = 0; i < bw * bh; i++) counts[i + 1] += counts[i];
    this.bucketStart = counts;
    const items = (this.bucketItems = new Int32Array(counts[bw * bh]));
    const cursor = counts.slice(0, bw * bh);
    for (let i = 0; i < ns; i++) {
      const [bx0, bx1, bz0, bz1] = span(i);
      for (let bz = bz0; bz <= bz1; bz++) for (let bx = bx0; bx <= bx1; bx++) items[cursor[bz * bw + bx]++] = i;
    }

    // exact resolution of the ambiguous cells (centre blocked, cube not inside a single inflated solid)
    let amb = 0;
    for (let iy = PADY; iy < ny - PADY; iy++) {
      const y = ay + iy * cy;
      for (let iz = PADX; iz < nz - PADX; iz++) {
        const row = (iy * nz + iz) * nx;
        const z = az + iz;
        for (let ix = PADX; ix < nx - PADX; ix++) {
          const c = row + ix;
          if (S[c] !== 1 || L[c] !== 0) continue;
          amb++;
          const x = ax + ix;
          const k = this.gatherLocal(ix, iz, x - 0.5, x + 0.5, y - cy / 2, y + cy / 2, z - 0.5, z + 0.5, 0);
          if (cubeCovered(x - 0.5, x + 0.5, y - cy / 2, y + cy / 2, z - 0.5, z + 0.5, this.local, k)) L[c] = 1;
        }
      }
    }
    this.looseAmbiguous = amb;

    // possible resting cells of the LOOSE model (exact supporting surface heights)
    const topsSet = new Set<number>();
    for (const s of stage.solids) topsSet.add(s.max.y);
    this.tops = Float64Array.from([...topsSet].sort((a, b) => a - b));
    if (this.tops.length > 65534) throw new Error('too many distinct surface heights');
    const topIndex = new Map<number, number>();
    this.tops.forEach((t, i) => topIndex.set(t, i + 1));
    const ls = (this.lStand = new Uint16Array(n));
    for (const s of stage.solids) {
      const ti = topIndex.get(s.max.y)!;
      const yc = s.max.y + HY;
      const [x0i, x1i] = openRange(s.min.x - HX - 0.5 - 1e-6, s.max.x + HX + 0.5 + 1e-6, ax, 1, nx);
      const [z0i, z1i] = openRange(s.min.z - HZ - 0.5 - 1e-6, s.max.z + HZ + 0.5 + 1e-6, az, 1, nz);
      const [y0i, y1i] = openRange(yc - cy / 2 - 1e-6, yc + cy / 2 + 1e-6, ay, cy, ny);
      for (let iy = y0i; iy <= y1i; iy++) {
        for (let iz = z0i; iz <= z1i; iz++) {
          const row = (iy * nz + iz) * nx;
          const rz0 = Math.max(az + iz - 0.5, s.min.z - HZ + 1e-6);
          const rz1 = Math.min(az + iz + 0.5, s.max.z + HZ - 1e-6);
          if (rz0 > rz1) continue;
          for (let ix = x0i; ix <= x1i; ix++) {
            const c = row + ix;
            if (L[c] !== 0 || ls[c] >= ti) continue;
            // exact: is there a legal resting position on this surface inside the cube? (positions at height
            // top + 2.0 whose footprint overlaps the surface and that no inflated solid covers)
            const rx0 = Math.max(ax + ix - 0.5, s.min.x - HX + 1e-6);
            const rx1 = Math.min(ax + ix + 0.5, s.max.x + HX - 1e-6);
            if (rx0 > rx1) continue;
            const k = this.gatherLocal(ix, iz, rx0, rx1, yc, yc, rz0, rz1, 0);
            if (!cubeCovered(rx0, rx1, yc, yc, rz0, rz1, this.local, k)) ls[c] = ti;
          }
        }
      }
    }

    // neighbourhoods
    const offs: number[] = [];
    const mids: Int32Array[] = [];
    const moves: Array<[number, number, number]> = [];
    for (let pass = 1; pass <= 3; pass++) {
      for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) === pass) moves.push([dx, dy, dz]);
      }
    }
    for (const [dx, dy, dz] of moves) {
      offs.push(dx + dz * sz + dy * sy);
      const m: number[] = [];
      for (const ex of dx ? [0, dx] : [0]) for (const ey of dy ? [0, dy] : [0]) for (const ez of dz ? [0, dz] : [0]) {
        if ((ex === 0 && ey === 0 && ez === 0) || (ex === dx && ey === dy && ez === dz)) continue;
        m.push(ex + ez * sz + ey * sy);
      }
      mids.push(Int32Array.from(m));
    }
    this.off26 = Int32Array.from(offs);
    this.mid26 = mids;
    this.dy26 = Int8Array.from(moves.map((m) => m[1]));
  }

  X(ix: number): number {
    return this.x0 + ix + 0.5;
  }
  Y(iy: number): number {
    return this.y0 + iy * this.cy;
  }
  Z(iz: number): number {
    return this.z0 + iz + 0.5;
  }
  ixOf(x: number): number {
    return Math.min(this.nx - 1, Math.max(0, Math.floor(x - this.x0)));
  }
  iyOf(y: number): number {
    return Math.min(this.ny - 1, Math.max(0, Math.round((y - this.y0) / this.cy)));
  }
  izOf(z: number): number {
    return Math.min(this.nz - 1, Math.max(0, Math.floor(z - this.z0)));
  }
  idx(ix: number, iy: number, iz: number): number {
    return (iy * this.nz + iz) * this.nx + ix;
  }
  cellOf(p: V3): number {
    return this.idx(this.ixOf(p.x), this.iyOf(p.y), this.izOf(p.z));
  }
  ix(c: number): number {
    return c % this.nx;
  }
  iz(c: number): number {
    return Math.floor(c / this.nx) % this.nz;
  }
  iy(c: number): number {
    return Math.floor(c / this.sy);
  }
  center(c: number): V3 {
    return { x: this.X(this.ix(c)), y: this.Y(this.iy(c)), z: this.Z(this.iz(c)) };
  }
  /** Cells of the outermost real (non padding) layer: a reachable cell there means the region leaks. */
  isBoundaryLayer(c: number): boolean {
    const ix = this.ix(c);
    const iy = this.iy(c);
    const iz = this.iz(c);
    return ix <= PADX || ix >= this.nx - PADX - 1 || iz <= PADX || iz >= this.nz - PADX - 1 || iy <= PADY || iy >= this.ny - PADY - 1;
  }

  /** Sets `v` on every cell whose centre is strictly inside the open box (or, closed = true, inside the closed box). */
  private fill(arr: Uint8Array, v: number, lx: number, hx: number, ly: number, hy: number, lz: number, hz: number, closed: boolean): void {
    const e = closed ? 1e-6 : 0;
    const [x0i, x1i] = openRange(lx - e, hx + e, this.x0 + 0.5, 1, this.nx);
    const [y0i, y1i] = openRange(ly - e, hy + e, this.y0, this.cy, this.ny);
    const [z0i, z1i] = openRange(lz - e, hz + e, this.z0 + 0.5, 1, this.nz);
    if (x1i < x0i) return;
    for (let iy = y0i; iy <= y1i; iy++) {
      for (let iz = z0i; iz <= z1i; iz++) {
        const row = (iy * this.nz + iz) * this.nx;
        arr.fill(v, row + x0i, row + x1i + 1);
      }
    }
  }

  /** Collects into this.local (starting at slot k0) the inflated solids that overlap the given cube. Returns the new count. */
  private gatherLocal(ix: number, iz: number, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, k0: number): number {
    const b = (iz >> 2) * this.bw + (ix >> 2);
    const inf = this.inf;
    let k = k0;
    for (let p = this.bucketStart[b]; p < this.bucketStart[b + 1]; p++) {
      const o = this.bucketItems[p] * 6;
      if (inf[o] < x1 && inf[o + 3] > x0 && inf[o + 1] < y1 && inf[o + 4] > y0 && inf[o + 2] < z1 && inf[o + 5] > z0) {
        if ((k + 1) * 6 > this.local.length) {
          const bigger = new Float64Array(this.local.length * 2);
          bigger.set(this.local);
          this.local = bigger;
        }
        const d = k * 6;
        for (let j = 0; j < 6; j++) this.local[d + j] = inf[o + j];
        k++;
      }
    }
    return k;
  }

  /** Shared BFS queue (large enough for every free cell). */
  getQueue(): Int32Array {
    if (!this.queue) {
      let free = 0;
      const L = this.baseL;
      for (let i = 0; i < this.n; i++) if (L[i] === 0) free++;
      this.queue = new Int32Array(free + 16);
    }
    return this.queue;
  }

  private getMark(): Uint8Array {
    if (!this.mark) this.mark = new Uint8Array(this.n);
    return this.mark;
  }

  /**
   * Cells blocked when `box` becomes a solid (closed barrier / gate). STRICT: the player's box at the cell
   * centre overlaps it. LOOSE: the cell cube is entirely covered by inflated solids ∪ the inflated box.
   */
  solidBlocker(box: Box): Blocker {
    const { nx, nz, cy } = this;
    const lo = [box.min.x - HX, box.min.y - HY, box.min.z - HZ];
    const hi = [box.max.x + HX, box.max.y + HY, box.max.z + HZ];
    const s: number[] = [];
    const l: number[] = [];
    const [x0i, x1i] = openRange(lo[0] - 0.5, hi[0] + 0.5, this.x0 + 0.5, 1, nx);
    const [y0i, y1i] = openRange(lo[1] - cy / 2, hi[1] + cy / 2, this.y0, cy, this.ny);
    const [z0i, z1i] = openRange(lo[2] - 0.5, hi[2] + 0.5, this.z0 + 0.5, 1, nz);
    for (let iy = y0i; iy <= y1i; iy++) {
      const y = this.Y(iy);
      for (let iz = z0i; iz <= z1i; iz++) {
        const z = this.Z(iz);
        for (let ix = x0i; ix <= x1i; ix++) {
          const x = this.X(ix);
          const c = (iy * nz + iz) * nx + ix;
          if (this.baseS[c] === 0 && x > lo[0] + EPS && x < hi[0] - EPS && y > lo[1] + EPS && y < hi[1] - EPS && z > lo[2] + EPS && z < hi[2] - EPS) s.push(c);
          if (this.baseL[c] !== 0) continue;
          let k = this.gatherLocal(ix, iz, x - 0.5, x + 0.5, y - cy / 2, y + cy / 2, z - 0.5, z + 0.5, 0);
          if ((k + 1) * 6 > this.local.length) {
            const bigger = new Float64Array(this.local.length * 2);
            bigger.set(this.local);
            this.local = bigger;
          }
          for (let j = 0; j < 3; j++) {
            this.local[k * 6 + j] = lo[j];
            this.local[k * 6 + 3 + j] = hi[j];
          }
          k++;
          if (cubeCovered(x - 0.5, x + 0.5, y - cy / 2, y + cy / 2, z - 0.5, z + 0.5, this.local, k)) l.push(c);
        }
      }
    }
    return { s: Int32Array.from(s), l: Int32Array.from(l) };
  }

  /**
   * LOOSE cells in which every legal player centre lies inside the region (union of closed boxes): a real
   * path that avoids the region can never visit such a cell, so blocking them is a rigorous way to ask
   * "does every route pass through the region?". The region must be >= 1 cell thick (2 m when not aligned
   * to the grid) to contain a full layer of cells.
   */
  regionBlockerL(boxes: Box[]): Int32Array {
    const { nx, nz, cy } = this;
    const mark = this.getMark();
    const out: number[] = [];
    const nb = boxes.length;
    for (const rb of boxes) {
      const [x0i, x1i] = openRange(rb.min.x - 0.5, rb.max.x + 0.5, this.x0 + 0.5, 1, nx);
      const [y0i, y1i] = openRange(rb.min.y - cy / 2, rb.max.y + cy / 2, this.y0, cy, this.ny);
      const [z0i, z1i] = openRange(rb.min.z - 0.5, rb.max.z + 0.5, this.z0 + 0.5, 1, nz);
      for (let iy = y0i; iy <= y1i; iy++) {
        const y = this.Y(iy);
        for (let iz = z0i; iz <= z1i; iz++) {
          const z = this.Z(iz);
          for (let ix = x0i; ix <= x1i; ix++) {
            const c = (iy * nz + iz) * nx + ix;
            if (this.baseL[c] !== 0 || mark[c]) continue;
            const x = this.X(ix);
            const e = 1e-6;
            let inside = x - 0.5 >= rb.min.x - e && x + 0.5 <= rb.max.x + e && y - cy / 2 >= rb.min.y - e && y + cy / 2 <= rb.max.y + e && z - 0.5 >= rb.min.z - e && z + 0.5 <= rb.max.z + e;
            if (!inside) {
              let k = this.gatherLocal(ix, iz, x - 0.5, x + 0.5, y - cy / 2, y + cy / 2, z - 0.5, z + 0.5, 0);
              if ((k + nb) * 6 > this.local.length) {
                const bigger = new Float64Array(Math.max(this.local.length * 2, (k + nb) * 6));
                bigger.set(this.local);
                this.local = bigger;
              }
              for (const q of boxes) {
                const d = k * 6;
                this.local[d] = q.min.x - e;
                this.local[d + 1] = q.min.y - e;
                this.local[d + 2] = q.min.z - e;
                this.local[d + 3] = q.max.x + e;
                this.local[d + 4] = q.max.y + e;
                this.local[d + 5] = q.max.z + e;
                k++;
              }
              inside = cubeCovered(x - 0.5, x + 0.5, y - cy / 2, y + cy / 2, z - 0.5, z + 0.5, this.local, k);
            }
            if (inside) {
              mark[c] = 1;
              out.push(c);
            }
          }
        }
      }
    }
    for (const c of out) mark[c] = 0;
    return Int32Array.from(out);
  }

  /** Cells whose cube touches the ball (centre distance <= r + half cube diagonal). Used to block more, never less. */
  ballCells(p: V3, r: number): Int32Array {
    const rr = r + Math.hypot(0.5, this.cy / 2, 0.5);
    const out: number[] = [];
    const [x0i, x1i] = openRange(p.x - rr, p.x + rr, this.x0 + 0.5, 1, this.nx);
    const [y0i, y1i] = openRange(p.y - rr, p.y + rr, this.y0, this.cy, this.ny);
    const [z0i, z1i] = openRange(p.z - rr, p.z + rr, this.z0 + 0.5, 1, this.nz);
    for (let iy = y0i; iy <= y1i; iy++) for (let iz = z0i; iz <= z1i; iz++) for (let ix = x0i; ix <= x1i; ix++) {
      if (Math.hypot(this.X(ix) - p.x, this.Y(iy) - p.y, this.Z(iz) - p.z) <= rr) out.push((iy * this.nz + iz) * this.nx + ix);
    }
    return Int32Array.from(out);
  }

  /** Cells whose centre lies inside the closed box (STRICT membership) or whose cube touches it (loose = true). */
  boxCells(b: Box, loose: boolean): Int32Array {
    const e = loose ? 0.5 : 0;
    const ey = loose ? this.cy / 2 : 0;
    const out: number[] = [];
    const [x0i, x1i] = openRange(b.min.x - e - 1e-6, b.max.x + e + 1e-6, this.x0 + 0.5, 1, this.nx);
    const [y0i, y1i] = openRange(b.min.y - ey - 1e-6, b.max.y + ey + 1e-6, this.y0, this.cy, this.ny);
    const [z0i, z1i] = openRange(b.min.z - e - 1e-6, b.max.z + e + 1e-6, this.z0 + 0.5, 1, this.nz);
    for (let iy = y0i; iy <= y1i; iy++) for (let iz = z0i; iz <= z1i; iz++) for (let ix = x0i; ix <= x1i; ix++) out.push((iy * this.nz + iz) * this.nx + ix);
    return Int32Array.from(out);
  }

  /** STRICT standing cell: free, and the player's box one cell lower would overlap a solid. */
  isStanding(c: number): boolean {
    return this.baseS[c] === 0 && this.baseS[c - this.sy] === 1;
  }

  /**
   * Height of the surface a player centred at cell `c` rests on / hovers over: the highest solid top under
   * the box footprint that is not above the box bottom. NaN when there is none within `maxGap`.
   */
  supportHeight(c: number, maxGap = this.cy + 1e-6): number {
    const x = this.X(this.ix(c));
    const z = this.Z(this.iz(c));
    const bottom = this.Y(this.iy(c)) - HY;
    const b = (this.iz(c) >> 2) * this.bw + (this.ix(c) >> 2);
    let best = NaN;
    for (let p = this.bucketStart[b]; p < this.bucketStart[b + 1]; p++) {
      const o = this.bucketItems[p] * 6;
      const r = this.raw;
      if (x + HX <= r[o] + EPS || x - HX >= r[o + 3] - EPS || z + HZ <= r[o + 2] + EPS || z - HZ >= r[o + 5] - EPS) continue;
      const top = r[o + 4];
      if (top > bottom + 1e-6 || top < bottom - maxGap) continue;
      if (!(best >= top)) best = top;
    }
    return best;
  }

  // ───────────────────────────── reachability ─────────────────────────────

  /**
   * Breadth-first flood through non-blocked cells with 26-connectivity. `tight` forbids corner cutting.
   * `six` restricts the moves to the 6 face neighbours: on the LOOSE grid this is still a rigorous
   * over-approximation, because cubes are closed — a real path that leaves a cube through an edge or a corner
   * point q is, at q, inside every cube that shares q, so all of them are LOOSE-free and face-connected.
   * `out` receives 1 for every reached cell. Returns the number of reached cells and the first target hit.
   */
  flood(
    blocked: Uint8Array,
    seeds: ArrayLike<number>,
    out: Uint8Array,
    opts: { tight?: boolean; six?: boolean; targets?: Uint8Array | null; stopAtTarget?: boolean } = {},
  ): { count: number; hit: number } {
    out.fill(0);
    const nk = opts.six ? 6 : 26;
    const q = this.getQueue();
    const off = this.off26;
    const mid = this.mid26;
    const tight = !!opts.tight;
    const targets = opts.targets ?? null;
    let qt = 0;
    let qh = 0;
    let hit = -1;
    for (let i = 0; i < seeds.length; i++) {
      const c = seeds[i];
      if (blocked[c] !== 0 || out[c] !== 0) continue;
      out[c] = 1;
      q[qt++] = c;
      if (targets && hit < 0 && targets[c] !== 0) hit = c;
    }
    if (hit >= 0 && opts.stopAtTarget) return { count: qt, hit };
    while (qh < qt) {
      const c = q[qh++];
      for (let k = 0; k < nk; k++) {
        const nb = c + off[k];
        if (out[nb] !== 0 || blocked[nb] !== 0) continue;
        if (tight && k >= 6) {
          const m = mid[k];
          let ok = true;
          for (let j = 0; j < m.length; j++) {
            if (blocked[c + m[j]] !== 0) {
              ok = false;
              break;
            }
          }
          if (!ok) continue;
        }
        out[nb] = 1;
        q[qt++] = nb;
        if (targets && hit < 0 && targets[nb] !== 0) {
          hit = nb;
          if (opts.stopAtTarget) return { count: qt, hit };
        }
      }
    }
    return { count: qt, hit };
  }

  private stencilOff: Int32Array | null = null;
  private stencilW: Float64Array | null = null;
  private stencilMid: Int32Array[] = [];

  /** Metric stencil: dx, dz in -1..1 and dy in -1 m..+1 m (all 26 isotropic 1 m moves plus the half steps). */
  private getStencil(): { off: Int32Array; w: Float64Array } {
    if (!this.stencilOff) {
      const m = Math.round(1 / this.cy);
      const off: number[] = [];
      const w: number[] = [];
      for (let dy = -m; dy <= m; dy++) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0 && (dy === 0 || Math.abs(dy) > 1)) continue;
        off.push(dx + dz * this.sz + dy * this.sy);
        w.push(Math.hypot(dx, dy * this.cy, dz));
        // every other cell of the block swept by the move (for the no-corner-cutting rule)
        const mids: number[] = [];
        const sgn = Math.sign(dy);
        for (const ex of dx ? [0, dx] : [0]) for (const ez of dz ? [0, dz] : [0]) for (let ey = 0; ey <= Math.abs(dy); ey++) {
          if ((ex === 0 && ez === 0 && ey === 0) || (ex === dx && ez === dz && ey === Math.abs(dy))) continue;
          mids.push(ex + ez * this.sz + ey * sgn * this.sy);
        }
        this.stencilMid.push(Int32Array.from(mids));
      }
      this.stencilOff = Int32Array.from(off);
      this.stencilW = Float64Array.from(w);
    }
    return { off: this.stencilOff, w: this.stencilW! };
  }

  /**
   * Exact Dijkstra (bucket queue, bucket width = smallest edge weight) over non-blocked cells with Euclidean
   * edge weights on the metric stencil. `dist` (Float32Array(n)) receives the distances (Infinity = not
   * reached). Stops when `targetCount` (default 1) targets have been popped (their distances are then final)
   * or beyond maxDist. `tight` forbids corner cutting (every cell of the block swept by a move must be free).
   * `local`: `dist` must be all-Infinity on entry and is not cleared; the touched cells are remembered so that
   * clearTouched() can restore it cheaply (for many short searches).
   */
  dijkstra(
    blocked: Uint8Array,
    seeds: ArrayLike<number>,
    dist: Float32Array,
    opts: { targets?: Uint8Array | null; targetCount?: number; maxDist?: number; tight?: boolean; local?: boolean } = {},
  ): { target: number; dist: number } {
    const { off, w } = this.getStencil();
    const mids = this.stencilMid;
    const tight = !!opts.tight;
    let remaining = opts.targetCount ?? 1;
    const ns = off.length;
    const inv = 1 / this.cy;
    const targets = opts.targets ?? null;
    const maxDist = opts.maxDist ?? Infinity;
    const local = !!opts.local;
    const touched = this.touched;
    if (!local) dist.fill(Infinity);
    // circular bucket queue: an entry popped from bucket b only creates entries in buckets b+1 … b+4
    const NB = 8;
    const buckets: Int32Array[] = [];
    const sizes = new Int32Array(NB);
    for (let i = 0; i < NB; i++) buckets.push(new Int32Array(1 << 14));
    let pending = 0;
    for (let i = 0; i < seeds.length; i++) {
      const c = seeds[i];
      if (blocked[c] !== 0 || dist[c] === 0) continue;
      dist[c] = 0;
      if (local) touched.push(c);
      if (sizes[0] === buckets[0].length) {
        const bigger = new Int32Array(buckets[0].length * 2);
        bigger.set(buckets[0]);
        buckets[0] = bigger;
      }
      buckets[0][sizes[0]++] = c;
      pending++;
    }
    for (let b = 0; pending > 0; b++) {
      if (b * this.cy > maxDist) break;
      const slot = b & (NB - 1);
      const list = buckets[slot];
      const cnt = sizes[slot];
      for (let i = 0; i < cnt; i++) {
        const c = list[i];
        const d = dist[c];
        if (Math.floor(d * inv) !== b) continue;
        if (targets && targets[c] !== 0) {
          // NOTE: a popped target is cleared from the (scratch) target mask so that it is counted once.
          targets[c] = 0;
          if (--remaining <= 0) return { target: c, dist: d };
        }
        for (let k = 0; k < ns; k++) {
          const nb = c + off[k];
          if (blocked[nb] !== 0) continue;
          const nd = Math.fround(d + w[k]);
          const old = dist[nb];
          if (nd < old) {
            if (tight) {
              const m = mids[k];
              let ok = true;
              for (let j = 0; j < m.length; j++) {
                if (blocked[c + m[j]] !== 0) {
                  ok = false;
                  break;
                }
              }
              if (!ok) continue;
            }
            dist[nb] = nd;
            if (local && old === Infinity) touched.push(nb);
            const s2 = Math.floor(nd * inv) & (NB - 1);
            let bl = buckets[s2];
            if (sizes[s2] === bl.length) {
              const bigger = new Int32Array(bl.length * 2);
              bigger.set(bl);
              bl = buckets[s2] = bigger;
            }
            bl[sizes[s2]++] = nb;
            pending++;
          }
        }
      }
      pending -= cnt;
      sizes[slot] = 0;
    }
    return { target: -1, dist: Infinity };
  }

  private readonly touched: number[] = [];
  /** Restores `dist` to all-Infinity after a `local` dijkstra(). */
  clearTouched(dist: Float32Array): void {
    const t = this.touched;
    for (let i = 0; i < t.length; i++) dist[t[i]] = Infinity;
    t.length = 0;
  }

  /**
   * Replaces every corner-cutting move of a cell path by axis-parallel unit moves through free cells of the
   * block it sweeps (such moves are always collision-free sweeps). Returns null when some move cannot be
   * repaired.
   */
  repairPath(path: number[], blocked: Uint8Array): number[] | null {
    const out: number[] = [path[0]];
    const { sz, sy } = this;
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1];
      const b = path[i];
      const dx = this.ix(b) - this.ix(a);
      const dy = this.iy(b) - this.iy(a);
      const dz = this.iz(b) - this.iz(a);
      const steps: number[] = [];
      if (dx) steps.push(dx);
      if (dz) steps.push(dz * sz);
      for (let k = 0; k < Math.abs(dy); k++) steps.push(Math.sign(dy) * sy);
      if (steps.length <= 1) {
        out.push(b);
        continue;
      }
      // try every ordering of the unit steps
      let found: number[] | null = null;
      const used = new Array<boolean>(steps.length).fill(false);
      const cur: number[] = [];
      const rec = (c: number): boolean => {
        if (cur.length === steps.length) {
          found = cur.slice();
          return true;
        }
        const tried = new Set<number>();
        for (let k = 0; k < steps.length; k++) {
          if (used[k] || tried.has(steps[k])) continue;
          tried.add(steps[k]);
          const nc = c + steps[k];
          if (blocked[nc] !== 0) continue;
          used[k] = true;
          cur.push(nc);
          if (rec(nc)) return true;
          cur.pop();
          used[k] = false;
        }
        return false;
      };
      if (!rec(a) || !found) return null;
      for (const c of found as number[]) out.push(c);
    }
    return out;
  }

  /** Cells of a shortest path found by dijkstra(), from a seed to `target` (inclusive). */
  tracePath(dist: Float32Array, target: number, blocked?: Uint8Array, tight = false): number[] {
    const { off, w } = this.getStencil();
    const mids = this.stencilMid;
    const path = [target];
    let c = target;
    let guard = 0;
    while (dist[c] > 0 && guard++ < 10_000_000) {
      let next = -1;
      for (let k = 0; k < off.length; k++) {
        const p = c - off[k];
        if (p < 0 || p >= this.n) continue;
        const dp = dist[p];
        if (dp < dist[c] && Math.fround(dp + w[k]) === dist[c]) {
          if (tight && blocked) {
            const m = mids[k];
            let ok = true;
            for (let j = 0; j < m.length; j++) {
              if (blocked[p + m[j]] !== 0) {
                ok = false;
                break;
              }
            }
            if (!ok) continue;
          }
          next = p;
          break;
        }
      }
      if (next < 0) break;
      path.push(next);
      c = next;
    }
    return path.reverse();
  }

  /** Sum of Euclidean centre distances along a cell path (float64). */
  pathLength(path: number[]): number {
    let len = 0;
    for (let i = 1; i < path.length; i++) {
      const a = this.center(path[i - 1]);
      const b = this.center(path[i]);
      len += Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    }
    return len;
  }

  /**
   * RIGOROUS lower bound helper ("octagonal hop count").
   * Sample any real path of length L at n = floor(L) + 1 equal arc steps (< 1 m each). Two consecutive
   * samples differ by less than 1 m along every unit direction, in particular along x, z, u = (x+z)/√2,
   * v = (x-z)/√2 and y. So their unit-interval indices (ix, iz, iu, iv, iy) change by at most 1 (the cellY
   * layers are merged into 1 m intervals for this). Nodes = (LOOSE-free cell, (iu, iv) strip pair that intersects the cell);
   * one hop = any such simultaneous index change. The BFS hop count H from the start to the target cells
   * therefore satisfies H <= floor(L) + 1, i.e.  L >= H - 1.  In open space H equals the octagonal norm
   * max(|dx|, |dz|, |du|, |dv|, |dy|) >= 0.924 x the horizontal Euclidean distance.
   * Returns H, or -1 when no target is reachable.
   */
  hopDistance(blocked: Uint8Array, start: V3, targets: Uint8Array): number {
    const { nx, nz, sy, sz } = this;
    const R = Math.SQRT1_2;
    const ncol = nx * nz;
    const iu0 = new Int32Array(ncol);
    const iv0 = new Int32Array(ncol);
    const valid = new Uint16Array(ncol);
    for (let iz = 0; iz < nz; iz++) {
      for (let ix = 0; ix < nx; ix++) {
        const col = iz * nx + ix;
        const uc = (ix + 0.5 + iz + 0.5) * R;
        const vc = (ix - iz) * R;
        const a = Math.floor(uc - R);
        const b = Math.floor(vc - R);
        iu0[col] = a;
        iv0[col] = b;
        let m = 0;
        for (let su = 0; su < 3; su++) {
          const du = Math.max(a + su - uc, 0, uc - (a + su + 1));
          for (let sv = 0; sv < 3; sv++) {
            const dv = Math.max(b + sv - vc, 0, vc - (b + sv + 1));
            if (du + dv <= R + 1e-9) m |= 1 << (su * 3 + sv);
          }
        }
        valid[col] = m;
      }
    }
    // transfer table: mask of sub-strips reachable in a neighbour column whose strip origin differs by (du0, dv0)
    const T = new Uint16Array(25 * 512);
    for (let du0 = -2; du0 <= 2; du0++) for (let dv0 = -2; dv0 <= 2; dv0++) {
      const base = ((du0 + 2) * 5 + (dv0 + 2)) * 512;
      for (let m = 1; m < 512; m++) {
        let t = 0;
        for (let su = 0; su < 3; su++) for (let sv = 0; sv < 3; sv++) {
          if (!(m & (1 << (su * 3 + sv)))) continue;
          for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
            const tu = su + a - du0;
            const tv = sv + b - dv0;
            if (tu >= 0 && tu < 3 && tv >= 0 && tv < 3) t |= 1 << (tu * 3 + tv);
          }
        }
        T[base + m] = t;
      }
    }
    // unit intervals in y: merge the cellY layers pairwise (a merged cell is free when any of its layers is)
    const f = Math.round(1 / this.cy);
    const nyc = Math.ceil(this.ny / f);
    const nc = nyc * sy;
    let blk = blocked;
    let tgt = targets;
    if (f > 1) {
      blk = new Uint8Array(nc).fill(1);
      tgt = new Uint8Array(nc);
      for (let iy = 0; iy < this.ny; iy++) {
        const src = iy * sy;
        const dst = Math.floor(iy / f) * sy;
        for (let i = 0; i < sy; i++) {
          if (blocked[src + i] === 0) blk[dst + i] = 0;
          if (targets[src + i] !== 0 && blocked[src + i] === 0) tgt[dst + i] = 1;
        }
      }
    }
    const reach = new Uint16Array(nc);
    const c0f = this.cellOf(start);
    if (blocked[c0f] !== 0) return -1;
    const c0 = Math.floor(this.iy(c0f) / f) * sy + (c0f % sy);
    const col0 = c0 % sy;
    const su0 = Math.floor((start.x - this.x0 + start.z - this.z0) * R) - iu0[col0];
    const sv0 = Math.floor((start.x - this.x0 - (start.z - this.z0)) * R) - iv0[col0];
    let m0 = su0 >= 0 && su0 < 3 && sv0 >= 0 && sv0 < 3 ? (1 << (su0 * 3 + sv0)) & valid[col0] : 0;
    if (!m0) m0 = valid[col0];
    reach[c0] = m0;
    if (tgt[c0] !== 0) return 0;
    let curC: number[] = [c0];
    let curM: number[] = [m0];
    let level = 0;
    while (curC.length > 0) {
      const nextC: number[] = [];
      const nextM: number[] = [];
      level++;
      for (let i = 0; i < curC.length; i++) {
        const c = curC[i];
        const m = curM[i];
        const col = c % sy;
        const u0 = iu0[col];
        const v0 = iv0[col];
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            const col2 = col + dx + dz * nx;
            const t = T[((iu0[col2] - u0 + 2) * 5 + (iv0[col2] - v0 + 2)) * 512 + m] & valid[col2];
            if (t === 0) continue;
            const base = c + dx + dz * sz;
            for (let dy = -1; dy <= 1; dy++) {
              const nb = base + dy * sy;
              if (blk[nb] !== 0) continue;
              const add = t & ~reach[nb];
              if (add === 0) continue;
              reach[nb] |= add;
              if (tgt[nb] !== 0) return level;
              nextC.push(nb);
              nextM.push(add);
            }
          }
        }
      }
      curC = nextC;
      curM = nextM;
    }
    return -1;
  }

  /**
   * No-flight closure (LOOSE model, over-approximation of everything a player can do WITHOUT flight thrust).
   * Seeds: every possible resting cell flagged in `seedMask`. From a resting surface at height s the player's
   * box bottom can rise to s + jump (jump apex); with that cap the player may move through any LOOSE-free
   * cell that contains a position whose box bottom is <= cap, with unlimited horizontal reach (jumps, falls,
   * glides and quick boosts are all covered). Whenever such a cell is a possible resting cell the cap is
   * re-based to max(cap, its surface + jump). `capIdx` (Uint16Array(n)) receives index + 1 into `tops` of the
   * surface defining the best cap of each reached cell (0 = not reached).
   * Vertical resolution: a ledge up to jump + cellY above a surface may be accepted as jumpable (conservative).
   * Face moves only (see flood(): rigorous on the LOOSE grid because cubes are closed).
   */
  noFlightClosure(
    blocked: Uint8Array,
    seedMask: Uint8Array,
    capIdx: Uint16Array,
    jump: number,
    far?: Uint8Array | null,
  ): { count: number; hitFar: number } {
    const { cy, sy, tops, lStand } = this;
    const nt = tops.length;
    capIdx.fill(0);
    const maxIy = new Int32Array(nt);
    for (let i = 0; i < nt; i++) maxIy[i] = Math.floor((tops[i] + jump + HY + cy / 2 - this.y0) / cy + EPSI);
    const buckets: number[][] = [];
    for (let i = 0; i < nt; i++) buckets.push([]);
    let hi = -1;
    let count = 0;
    let hitFar = -1;
    for (let c = 0; c < this.n; c++) {
      if (seedMask[c] === 0 || blocked[c] !== 0 || lStand[c] === 0) continue;
      capIdx[c] = lStand[c];
      buckets[lStand[c] - 1].push(c);
      if (lStand[c] - 1 > hi) hi = lStand[c] - 1;
      count++;
    }
    const off = this.off26;
    const dy26 = this.dy26;
    while (hi >= 0) {
      const bl = buckets[hi];
      if (bl.length === 0) {
        hi--;
        continue;
      }
      const c = bl.pop()!;
      if (capIdx[c] !== hi + 1) continue;
      const cur = hi;
      const iyc = Math.floor(c / sy);
      const lim = maxIy[cur];
      for (let k = 0; k < 6; k++) {
        const nb = c + off[k];
        if (blocked[nb] !== 0) continue;
        if (iyc + dy26[k] > lim) continue;
        let ni = cur;
        const ls = lStand[nb];
        if (ls !== 0 && ls - 1 > ni) ni = ls - 1;
        if (capIdx[nb] >= ni + 1) continue;
        if (capIdx[nb] === 0) {
          count++;
          if (far && hitFar < 0 && far[nb] !== 0) hitFar = nb;
        }
        capIdx[nb] = ni + 1;
        buckets[ni].push(nb);
        if (ni > hi) hi = ni;
      }
    }
    return { count, hitFar };
  }
}

// ───────────────────────────── report types ─────────────────────────────

export type CheckStatus = 'pass' | 'fail' | 'skipped';

export interface CheckResult {
  id: string;
  title: string;
  status: CheckStatus;
  ms: number;
  /** Measured numbers, human readable. */
  lines: string[];
  /** Reasons for a failure (empty when passing). */
  problems: string[];
  warnings: string[];
  data: Record<string, unknown>;
}

export interface StageReport {
  stageId: string;
  stageName: string;
  /** True only when no check failed AND none was skipped (unless AnalyzeOptions.allowSkips). */
  pass: boolean;
  /** 'PASS', 'FAIL' (a check failed) or 'INCOMPLETE' (nothing failed but checks were not run). */
  result: 'PASS' | 'FAIL' | 'INCOMPLETE';
  totalMs: number;
  grid: Record<string, unknown>;
  checks: CheckResult[];
}

export interface AnalyzeOptions extends GridOptions {
  /** Run only these checks (ids such as 'V3'). */
  only?: string[];
  /** Run the V6d flight simulation with the real Sim when player.ts is implemented (default true). */
  flightSim?: boolean;
  /** Count a run in which checks were skipped (not run) as passed. Default false: skipped checks make it INCOMPLETE. */
  allowSkips?: boolean;
  /**
   * Further routes that V14 plays with the weakest loadout in addition to stage.route (e.g. the detour side
   * of every branch). Each must start at the player start and end in the exit zone.
   */
  extraRoutes?: Array<{ name: string; route: StageDef['route'] }>;
  log?: (line: string) => void;
}

/** Every threshold of SPEC §2.2 as measured by V1–V13. Never weaken these. */
export const LIMITS = {
  sectors: 15,
  sectorArea: 150,
  sectorKinds: 6,
  guards: 30,
  turrets: 15,
  controls: 6,
  guardFloor: 100,
  /** Sectors that must contain at least one enemy of their own ("移動して探索・戦闘できる15区画以上"). */
  enemySectors: 15,
  /** Guards that must be able to walk to the route: NavGrid region (all barriers open) >= mobileGuardFloor m² containing a route waypoint. */
  mobileGuards: 24,
  mobileGuardFloor: 1000,
  /** Guards that must stand on the main floor of their sector. */
  mainFloorGuards: 20,
  attackRange: 100,
  routeMin: 1500,
  routeTarget: 1900,
  mandatorySectors: 12,
  controlRange: 120,
  flightSpots: 6,
  flightSeparation: 20,
  flightMin: 6,
  flightMax: 16,
  jumpApex: 2.8,
  landingSize: 6,
  branches: 3,
  branchAvoid: 12,
  branchMinLength: 40,
  /** Path samples farther than this from the other alternative form the alternative's own ("exclusive") section. */
  branchExclusive: 8,
  loops: 2,
  loopMin: 60,
  loopMax: 400,
  loopBall: 8,
  /** Area (m²) of columns enclosed by a loop on which the player cannot walk at the loop's level (solid core or void). */
  loopHole: 50,
  /** … and that area must be at least this share of everything the circuit encloses (a wide round about a small obstacle is no loop). */
  loopHoleShare: 0.25,
  /** Longest stretch (m) of the recommended route without any enemy firing line, outside the start sector. */
  routeGap: 100,
  /** Share of the recommended route (outside the start sector) that must lie under at least one firing line. */
  routeCovered: 0.6,
  bands: 3,
  bandGap: 5,
  bandArea: 400,
  stackedArea: 200,
  arenas: 5,
  arenaLong: 60,
  arenaShort: 50,
  arenaFill: 0.45,
  multiArenas: 5,
  multiEnemies: 4,
  multiFraction: 0.15,
  multiSpreadDeg: 90,
  startLane: 60,
  maxSolids: 3500,
  maxDecor: 3500,
} as const;

const r1 = (v: number): number => Math.round(v * 10) / 10;
const r2 = (v: number): number => Math.round(v * 100) / 100;
const fmtV = (p: V3): string => `(${r1(p.x)}, ${r1(p.y)}, ${r1(p.z)})`;
const dist3 = (a: V3, b: V3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const inBox = (p: V3, b: Box, e = 1e-6): boolean =>
  p.x >= b.min.x - e && p.x <= b.max.x + e && p.y >= b.min.y - e && p.y <= b.max.y + e && p.z >= b.min.z - e && p.z <= b.max.z + e;
const boxInBox = (a: Box, b: Box, e = 1e-6): boolean => inBox(a.min, b, e) && inBox(a.max, b, e);
const boxesOverlap = (a: Box, b: Box, e = 1e-6): boolean =>
  a.min.x < b.max.x - e && a.max.x > b.min.x + e && a.min.y < b.max.y - e && a.max.y > b.min.y + e && a.min.z < b.max.z - e && a.max.z > b.min.z + e;
const sphereHitsBox = (c: V3, r: number, b: Box): boolean => {
  const dx = Math.max(b.min.x - c.x, 0, c.x - b.max.x);
  const dy = Math.max(b.min.y - c.y, 0, c.y - b.max.y);
  const dz = Math.max(b.min.z - c.z, 0, c.z - b.max.z);
  return dx * dx + dy * dy + dz * dz < (r - 1e-6) * (r - 1e-6);
};

/** Deterministic, well spread unit directions (Fibonacci sphere). */
function sphereDirs(n: number): Float64Array {
  const out = new Float64Array(n * 3);
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    out[i * 3] = Math.cos(ga * i) * r;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = Math.sin(ga * i) * r;
  }
  return out;
}

/** Enemies (initial positions) with range and line of sight to a set of sample points (StageAnalyzer.exposure). */
export interface Exposure {
  /** Distinct enemies that see at least one sample. */
  enemies: number;
  /** Largest number of enemies that see one sample. */
  maxSimultaneous: number;
  /** Average number of enemies that see a sample (firing lines per metre of path). */
  mean: number;
  ids: string[];
}

/** One alternative of a branch (StageAnalyzer.branchAlternative). */
export interface BranchAlternative {
  length: number;
  retrace: number;
  exposure: Exposure;
  /** Cells of the path from → via → to. */
  cells: number[];
}

/** Where a guard can walk (StageAnalyzer.guardMobility). */
export interface GuardMobility {
  /** Area (m²) of the guard's NavGrid region with every barrier and the gate open. */
  area: number;
  /** The region contains a waypoint of the recommended route. */
  onRoute: boolean;
  /** The guard stands on the main floor (V10) of its sector. */
  onMainFloor: boolean;
  /** area >= LIMITS.mobileGuardFloor and onRoute. */
  mobile: boolean;
}

/** Measured shape of a sector (StageAnalyzer.sectorShape). */
export interface SectorShape {
  footprint: number;
  spanX: number;
  spanZ: number;
  openSquare: number;
  height: number;
  top: number;
  bands: number;
  stacked: number;
  mainHeight: number;
  mainLong: number;
  mainShort: number;
  mainFill: number;
  tallFraction: number;
  tallRows: number;
  elevated: number;
}

class Check {
  readonly lines: string[] = [];
  readonly problems: string[] = [];
  readonly warnings: string[] = [];
  readonly data: Record<string, unknown> = {};
  skipped = false;
  private readonly t0 = performance.now();
  constructor(readonly id: string, readonly title: string) {}
  line(s: string): void {
    this.lines.push(s);
  }
  fail(s: string): void {
    this.problems.push(s);
  }
  warn(s: string): void {
    this.warnings.push(s);
  }
  /** Records a measured requirement: fails unless `ok`. */
  need(ok: boolean, text: string): void {
    this.lines.push(`${ok ? 'ok  ' : 'FAIL'} ${text}`);
    if (!ok) this.problems.push(text);
  }
  done(): CheckResult {
    return {
      id: this.id,
      title: this.title,
      status: this.problems.length > 0 ? 'fail' : this.skipped ? 'skipped' : 'pass',
      ms: Math.round(performance.now() - this.t0),
      lines: this.lines,
      problems: this.problems,
      warnings: this.warnings,
      data: this.data,
    };
  }
}

// ───────────────────────────── analyzer ─────────────────────────────

export class StageAnalyzer {
  readonly world: World;
  readonly grid: VoxelGrid;
  /** Barrier ids in progression order (= order of stage.barriers) followed by the final gate id. */
  readonly closable: string[];
  readonly blockers = new Map<string, Blocker>();
  readonly startS: number;
  readonly startL: number;
  readonly exitS: Uint8Array;
  readonly exitL: Uint8Array;
  readonly exitCellsS: Int32Array;
  readonly exitCellsL: Int32Array;
  /** Free-flight reachable region with every barrier and the gate open (STRICT under- / LOOSE over-approximation). */
  readonly RS: Uint8Array;
  readonly RL: Uint8Array;
  readonly countRS: number;
  readonly countRL: number;
  /** Reachable STRICT standing cells and the exact height of the surface under each. */
  readonly standing: Int32Array;
  readonly standH: Float32Array;
  /** Indices into `standing` per sector index. */
  readonly sectorStanding: number[][];
  readonly setupMs: number;
  private readonly workS: Uint8Array;
  private readonly workL: Uint8Array;
  private readonly pool: Uint8Array[] = [];
  private distBuf: Float32Array | null = null;
  private readonly log: (s: string) => void;

  constructor(readonly stage: StageDef, readonly opts: AnalyzeOptions = {}) {
    const t0 = performance.now();
    this.log = opts.log ?? (() => {});
    this.world = new World(stage);
    this.grid = new VoxelGrid(stage, opts);
    const g = this.grid;
    this.log(`grid ${g.nx} x ${g.ny} x ${g.nz} = ${g.n} cells (1 m x ${g.cy} m x 1 m), built in ${Math.round(performance.now() - t0)} ms`);
    this.closable = [...stage.barriers.map((b) => b.id), stage.finalGate.id];
    for (const b of stage.barriers) this.blockers.set(b.id, g.solidBlocker(b.box));
    this.blockers.set(stage.finalGate.id, g.solidBlocker(stage.finalGate.box));
    this.workS = new Uint8Array(g.n);
    this.workL = new Uint8Array(g.n);

    // start cells
    const sp = stage.playerStart.position;
    this.startL = g.cellOf(sp);
    let best = -1;
    let bestD = Infinity;
    const ix = g.ixOf(sp.x);
    const iy = g.iyOf(sp.y);
    const iz = g.izOf(sp.z);
    for (let dy = -2; dy <= 2; dy++) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const c = g.idx(ix + dx, iy + dy, iz + dz);
      if (c < 0 || c >= g.n || g.baseS[c] !== 0) continue;
      const d = dist3(g.center(c), sp);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    this.startS = best;

    // exit cells
    this.exitCellsS = g.boxCells(stage.exitZone, false).filter((c) => g.baseS[c] === 0);
    this.exitCellsL = g.boxCells(stage.exitZone, true).filter((c) => g.baseL[c] === 0);
    this.exitS = new Uint8Array(g.n);
    this.exitL = new Uint8Array(g.n);
    for (const c of this.exitCellsS) this.exitS[c] = 1;
    for (const c of this.exitCellsL) this.exitL[c] = 1;

    // reachable regions, all barriers and the gate open
    this.RS = new Uint8Array(g.n);
    this.RL = new Uint8Array(g.n);
    this.countRS = this.startS >= 0 ? g.flood(g.baseS, [this.startS], this.RS, { tight: true }).count : 0;
    this.countRL = g.flood(g.baseL, [this.startL], this.RL, { six: true }).count;

    // standing cells
    const st: number[] = [];
    const RS = this.RS;
    for (let c = g.sy * PADY; c < g.n - g.sy * PADY; c++) if (RS[c] !== 0 && g.baseS[c - g.sy] === 1) st.push(c);
    this.standing = Int32Array.from(st);
    this.standH = new Float32Array(st.length);
    this.sectorStanding = stage.sectors.map(() => []);
    for (let i = 0; i < st.length; i++) {
      const h = g.supportHeight(st[i]);
      this.standH[i] = Number.isNaN(h) ? g.Y(g.iy(st[i])) - HY : h;
      const si = this.sectorIndexAt(g.center(st[i]));
      if (si >= 0) this.sectorStanding[si].push(i);
    }
    this.setupMs = Math.round(performance.now() - t0);
    this.log(`reachable: ${this.countRS} strict / ${this.countRL} loose cells, ${st.length} standing cells; setup ${this.setupMs} ms`);
  }

  sectorIndexAt(p: V3): number {
    const secs = this.stage.sectors;
    for (let i = 0; i < secs.length; i++) for (const b of secs[i].bounds) if (inBox(p, b, 0)) return i;
    return -1;
  }

  take(): Uint8Array {
    return this.pool.pop() ?? new Uint8Array(this.grid.n);
  }
  give(a: Uint8Array): void {
    this.pool.push(a);
  }
  private distClean = false;
  /** Distance buffer for a full dijkstra() (which clears it itself). */
  dist(): Float32Array {
    if (!this.distBuf) this.distBuf = new Float32Array(this.grid.n);
    this.distClean = false;
    return this.distBuf;
  }
  /** All-Infinity distance buffer for `local` searches (restore it with grid.clearTouched after each one). */
  localDist(): Float32Array {
    if (!this.distBuf) this.distBuf = new Float32Array(this.grid.n);
    if (!this.distClean) {
      this.distBuf.fill(Infinity);
      this.distClean = true;
    }
    return this.distBuf;
  }
  /** Blocks `cells` in `mask`; returns the previous values for unblock(). */
  block(mask: Uint8Array, cells: Int32Array): Uint8Array {
    const saved = new Uint8Array(cells.length);
    for (let i = 0; i < cells.length; i++) {
      saved[i] = mask[cells[i]];
      mask[cells[i]] = 1;
    }
    return saved;
  }
  unblock(mask: Uint8Array, cells: Int32Array, saved: Uint8Array): void {
    for (let i = 0; i < cells.length; i++) mask[cells[i]] = saved[i];
  }

  /** STRICT occupancy with the given closable ids closed (+ extra blocked cells). Shared buffer. */
  maskS(closed: Iterable<string> = [], extra: Int32Array[] = []): Uint8Array {
    const m = this.workS;
    m.set(this.grid.baseS);
    for (const id of closed) for (const c of this.blockers.get(id)!.s) m[c] = 1;
    for (const e of extra) for (let i = 0; i < e.length; i++) m[e[i]] = 1;
    return m;
  }

  /** LOOSE occupancy with the given closable ids closed (+ extra blocked cells). Shared buffer. */
  maskL(closed: Iterable<string> = [], extra: Int32Array[] = []): Uint8Array {
    const m = this.workL;
    m.set(this.grid.baseL);
    for (const id of closed) for (const c of this.blockers.get(id)!.l) m[c] = 1;
    for (const e of extra) for (let i = 0; i < e.length; i++) m[e[i]] = 1;
    return m;
  }

  /** Opens / closes the barriers of the real World used for exact line-of-sight and sweep queries. */
  setWorld(closed: Iterable<string>): void {
    const set = new Set(closed);
    for (const id of this.closable) this.world.setBarrierOpen(id, !set.has(id));
  }

  /** Nearest STRICT-free cell of the reachable region to a declared point (within ~1.5 m), or -1. */
  cellNear(p: V3, region: Uint8Array = this.RS): number {
    const g = this.grid;
    const ix = g.ixOf(p.x);
    const iy = g.iyOf(p.y);
    const iz = g.izOf(p.z);
    let best = -1;
    let bestD = Infinity;
    for (let dy = -2; dy <= 2; dy++) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const x = ix + dx;
      const y = iy + dy;
      const z = iz + dz;
      if (x < 0 || y < 0 || z < 0 || x >= g.nx || y >= g.ny || z >= g.nz) continue;
      const c = g.idx(x, y, z);
      if (region[c] === 0) continue;
      const d = dist3(g.center(c), p);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return best;
  }

  /** True when the real player box can be translated straight from a to b (collision skin 1e-4 m). */
  sweepFree(a: V3, b: V3): boolean {
    const half = { x: HX - 1e-4, y: HY - 1e-4, z: HZ - 1e-4 };
    const c = { x: a.x, y: a.y, z: a.z };
    if (this.world.overlapsBox(c, half)) return false;
    const res = this.world.moveBox(c, half, { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z });
    return res.nx === 0 && res.ny === 0 && res.nz === 0 && dist3(c, b) < 1e-6;
  }

  /** Player muzzle for a player centred at `p` facing `target` horizontally (ARCHITECTURE §2). */
  muzzleFacing(p: V3, target: V3): V3 {
    let fx = target.x - p.x;
    let fz = target.z - p.z;
    const l = Math.hypot(fx, fz);
    if (l < 1e-9) {
      fx = 0;
      fz = -1;
    } else {
      fx /= l;
      fz /= l;
    }
    const m = PLAYER.muzzleLocal;
    // right = (cos yaw, 0, -sin yaw) with forward = (-sin yaw, 0, -cos yaw)  →  right = (-fz, 0, fx)
    return { x: p.x - fz * m.right + fx * m.forward, y: p.y + m.up, z: p.z + fx * m.right + fz * m.forward };
  }

  /**
   * Searches a cell of `region` from which the sphere at `target` can be attacked, by marching rays from the
   * target. strict = true (proving "possible"): the cell centre must be within `range`, and both the player
   * centre and the player's muzzle (facing the target) must have a clear line to the target CENTRE.
   * strict = false (proving "not attackable", sampling): rays also start from the rim of the sphere, any
   * marched point inside a region cell within range + 1.5 m counts.
   * The World barrier state must be set by the caller.
   */
  findAttackCell(region: Uint8Array, target: V3, radius: number, range: number, nDirs: number, strict: boolean): { cell: number; dist: number } | null {
    const g = this.grid;
    const w = this.world;
    const dirs = sphereDirs(nDirs);
    const origins: V3[] = [target];
    if (!strict) {
      const q = radius * 0.95;
      origins.push(
        { x: target.x, y: target.y + q, z: target.z },
        { x: target.x + q, y: target.y, z: target.z },
        { x: target.x - q, y: target.y, z: target.z },
        { x: target.x, y: target.y, z: target.z + q },
        { x: target.x, y: target.y, z: target.z - q },
      );
    }
    const reach = strict ? range : range + 1.5;
    const d = { x: 0, y: 0, z: 0 };
    const p = { x: 0, y: 0, z: 0 };
    let last = -1;
    for (let oi = 0; oi < origins.length; oi++) {
      const o = origins[oi];
      const n = oi === 0 ? nDirs : Math.floor(nDirs / 4);
      const stride = oi === 0 ? 1 : 4;
      for (let i = 0; i < n; i++) {
        d.x = dirs[i * stride * 3];
        d.y = dirs[i * stride * 3 + 1];
        d.z = dirs[i * stride * 3 + 2];
        const hit = w.raycast(o, d, reach);
        const tmax = hit ? hit.dist : reach;
        // strict witnesses start 4 m away so that the player's box does not sit inside the enemy
        for (let t = strict ? 4.25 : 0.25; t <= tmax; t += 0.5) {
          p.x = o.x + d.x * t;
          p.y = o.y + d.y * t;
          p.z = o.z + d.z * t;
          const c = g.cellOf(p);
          if (c === last || region[c] === 0) continue;
          last = c;
          if (!strict) return { cell: c, dist: t };
          const pc = g.center(c);
          const dd = dist3(pc, target);
          if (dd > range) continue;
          const mz = this.muzzleFacing(pc, target);
          if (dist3(mz, target) > range) continue;
          if (w.segmentBlocked(pc, target) || w.segmentBlocked(mz, target)) continue;
          return { cell: c, dist: dd };
        }
      }
    }
    return null;
  }

  /**
   * Exact-segment visibility of a sphere from every cell of `region` whose centre is within `range` of it:
   * a cell "sees" the target when the straight line from the cell centre to the sphere centre or to one of
   * six rim points is unobstructed. Returns the first such cell (-1 = none) and the number of cells tested.
   * The World barrier state must be set by the caller.
   */
  denseVisibleCell(region: Uint8Array, target: V3, radius: number, range: number): { cell: number; tested: number } {
    const g = this.grid;
    const w = this.world;
    const q = radius * 0.98;
    const pts: V3[] = [
      target,
      { x: target.x, y: target.y + q, z: target.z },
      { x: target.x, y: target.y - q, z: target.z },
      { x: target.x + q, y: target.y, z: target.z },
      { x: target.x - q, y: target.y, z: target.z },
      { x: target.x, y: target.y, z: target.z + q },
      { x: target.x, y: target.y, z: target.z - q },
    ];
    const [x0i, x1i] = openRange(target.x - range, target.x + range, g.x0 + 0.5, 1, g.nx);
    const [y0i, y1i] = openRange(target.y - range, target.y + range, g.y0, g.cy, g.ny);
    const [z0i, z1i] = openRange(target.z - range, target.z + range, g.z0 + 0.5, 1, g.nz);
    const p = { x: 0, y: 0, z: 0 };
    let tested = 0;
    for (let iy = y0i; iy <= y1i; iy++) {
      p.y = g.Y(iy);
      for (let iz = z0i; iz <= z1i; iz++) {
        p.z = g.Z(iz);
        const row = (iy * g.nz + iz) * g.nx;
        for (let ix = x0i; ix <= x1i; ix++) {
          if (region[row + ix] === 0) continue;
          p.x = g.X(ix);
          if (dist3(p, target) > range) continue;
          tested++;
          for (let k = 0; k < pts.length; k++) if (!w.segmentBlocked(p, pts[k])) return { cell: row + ix, tested };
        }
      }
    }
    return { cell: -1, tested };
  }

  // ───────────────────────────── V1 ─────────────────────────────
  checkSectors(): CheckResult {
    const ck = new Check('V1', 'Sectors: >= 15, disjoint, each >= 150 m² reachable standing floor, >= 6 kinds');
    const secs = this.stage.sectors;
    ck.need(secs.length >= LIMITS.sectors, `sector count ${secs.length} >= ${LIMITS.sectors}`);
    const ids = new Set(secs.map((s) => s.id));
    ck.need(ids.size === secs.length, `sector ids unique (${ids.size}/${secs.length})`);
    const overlaps: string[] = [];
    for (let i = 0; i < secs.length; i++) for (let j = i + 1; j < secs.length; j++) {
      if (secs[i].bounds.some((a) => secs[j].bounds.some((b) => boxesOverlap(a, b)))) overlaps.push(`${secs[i].id}/${secs[j].id}`);
    }
    ck.need(overlaps.length === 0, `sector bounds pairwise disjoint${overlaps.length ? ` — overlapping: ${overlaps.join(', ')}` : ''}`);
    const areas: Record<string, number> = {};
    const small: string[] = [];
    secs.forEach((s, i) => {
      const a = this.sectorStanding[i].length;
      areas[s.id] = a;
      if (a < LIMITS.sectorArea) small.push(`${s.id}=${a}`);
    });
    ck.line(`standing area per sector (m²): ${secs.map((s) => `${s.id} ${areas[s.id]}`).join(' · ')}`);
    ck.need(small.length === 0, `every sector has >= ${LIMITS.sectorArea} m² of reachable standing cells${small.length ? ` — too small: ${small.join(', ')}` : ''}`);
    // Kinds of space: the declared kind of every sector must hold as a measured, geometric property of the
    // sector (kindRule), and the count is taken over geometric classes, not over labels.
    const kinds = new Set(secs.map((s) => s.kind));
    const classes = new Map<string, string[]>();
    const wrongKind: string[] = [];
    const shapes: Record<string, unknown> = {};
    secs.forEach((s, i) => {
      const sh = this.sectorShape(i);
      const rule = this.kindRule(i, sh);
      shapes[s.id] = { kind: s.kind, class: rule.cls, ok: rule.ok, rule: rule.text, ...sh };
      ck.line(`${rule.ok ? 'ok  ' : 'FAIL'} ${s.id} ${s.kind} → ${rule.cls}: ${rule.text}`);
      if (!rule.ok) wrongKind.push(`${s.id} (${s.kind})`);
      else if (rule.cls !== 'functional') classes.set(rule.cls, [...(classes.get(rule.cls) ?? []), s.id]);
    });
    ck.need(wrongKind.length === 0, `the declared kind of every sector is a measured property of its geometry${wrongKind.length ? ` — not met: ${wrongKind.join(', ')}` : ''}`);
    ck.need(classes.size >= LIMITS.sectorKinds, `geometrically distinct kinds of space ${classes.size} >= ${LIMITS.sectorKinds} (${[...classes].map(([c, ids]) => `${c}: ${ids.join(' ')}`).join(' · ')})`);
    let unassigned = 0;
    for (let i = 0; i < this.standing.length; i++) if (this.sectorIndexAt(this.grid.center(this.standing[i])) < 0) unassigned++;
    ck.line(`reachable standing area total ${this.standing.length} m², outside every sector ${unassigned} m²`);
    // floor altitudes of each sector: standing area per supporting-surface height (0.5 m bins)
    const floors: Record<string, Array<[number, number]>> = {};
    secs.forEach((s, i) => {
      const bins = new Map<number, number>();
      for (const k of this.sectorStanding[i]) {
        const h = Math.round(this.standH[k] * 2) / 2;
        bins.set(h, (bins.get(h) ?? 0) + 1);
      }
      floors[s.id] = [...bins.entries()].sort((a, b) => a[0] - b[0]);
    });
    ck.data.floors = floors;
    ck.data.areas = areas;
    ck.data.kinds = [...kinds];
    ck.data.classes = [...classes].map(([c, ids]) => ({ class: c, sectors: ids }));
    ck.data.shapes = shapes;
    ck.data.standingTotal = this.standing.length;
    ck.data.standingOutsideSectors = unassigned;
    return ck.done();
  }


  /**
   * Floor levels among the standing cells `idx` (indices into this.standing): bands = floor heights >= bandGap
   * apart whose level (all floors within ± 1 m) has >= minArea m²; stacked = XZ columns with two such floors
   * >= bandGap apart.
   */
  levelStats(idx: ArrayLike<number>, minArea: number = LIMITS.bandArea): { bands: Array<{ height: number; area: number }>; stacked: number; keys: number[]; bins: Map<number, number> } {
    const g = this.grid;
    const bins = new Map<number, number>();
    for (let k = 0; k < idx.length; k++) {
      const b = Math.round(this.standH[idx[k]] * 2);
      bins.set(b, (bins.get(b) ?? 0) + 1);
    }
    const levelArea = (b: number): number => {
      let a = 0;
      for (let d = -2; d <= 2; d++) a += bins.get(b + d) ?? 0;
      return a;
    };
    const keys = [...bins.keys()].sort((a, b) => a - b);
    const bands: Array<{ height: number; area: number }> = [];
    let last = -Infinity;
    for (const b of keys) {
      const a = levelArea(b);
      if (a >= minArea && (b - last) / 2 >= LIMITS.bandGap) {
        bands.push({ height: b / 2, area: a });
        last = b;
      }
    }
    const order = Array.from(idx as ArrayLike<number>).sort((a, b) => (this.standing[a] % g.sy) - (this.standing[b] % g.sy));
    let stacked = 0;
    let i = 0;
    while (i < order.length) {
      const col = this.standing[order[i]] % g.sy;
      let lo = Infinity;
      let hi = -Infinity;
      while (i < order.length && this.standing[order[i]] % g.sy === col) {
        const h = this.standH[order[i]];
        if (levelArea(Math.round(h * 2)) >= minArea) {
          lo = Math.min(lo, h);
          hi = Math.max(hi, h);
        }
        i++;
      }
      if (hi - lo >= LIMITS.bandGap) stacked++;
    }
    return { bands, stacked, keys, bins };
  }

  private readonly shapeCache = new Map<number, SectorShape>();

  /**
   * Measured shape of a sector, from the reachable STRICT cells whose centre lies inside its bounds:
   *   footprint   XZ columns (m²) that contain such a cell; spanX / spanZ = clear extents (player box included)
   *   openSquare  side (m, clear width) of the largest axis-aligned square of footprint columns
   *   height      clear height above the main floor (top of the navigable volume - main floor height)
   *   top         top of the navigable volume (highest box top)
   *   bands / stacked   floor levels >= 5 m apart with >= 400 m² each / m² of columns with two of them
   *   main*       main floor (V10): largest component of the most frequent floor height
   *   tallFraction  share of the main floor's bounding rectangle under free-standing obstacles in which the
   *                 player cannot be lower than 4.5 m above the main floor (machines, tanks, pillars taller than
   *                 the mech; groups of blocked columns that touch the rectangle's border — walls — do not count)
   *   tallRows    free-standing obstacles >= 8 m high, >= 20 m long and <= 8 m wide (racks)
   *   elevated    area (m²) of walkways: columns with a floor at main-floor height and another >= 5 m above it
   */
  sectorShape(si: number): SectorShape {
    const cached = this.shapeCache.get(si);
    if (cached) return cached;
    const g = this.grid;
    const { nx, nz } = g;
    const RS = this.RS;
    const minIy = new Int16Array(nx * nz).fill(32767);
    let x0 = nx;
    let x1 = -1;
    let z0 = nz;
    let z1 = -1;
    let yHi = -1;
    let footprint = 0;
    for (const b of this.stage.sectors[si].bounds) {
      const [bx0, bx1] = openRange(b.min.x - 1e-6, b.max.x + 1e-6, g.x0 + 0.5, 1, nx);
      const [by0, by1] = openRange(b.min.y - 1e-6, b.max.y + 1e-6, g.y0, g.cy, g.ny);
      const [bz0, bz1] = openRange(b.min.z - 1e-6, b.max.z + 1e-6, g.z0 + 0.5, 1, nz);
      for (let iy = by0; iy <= by1; iy++) {
        for (let iz = bz0; iz <= bz1; iz++) {
          const row = (iy * nz + iz) * nx;
          const colRow = iz * nx;
          for (let ix = bx0; ix <= bx1; ix++) {
            if (RS[row + ix] === 0) continue;
            const col = colRow + ix;
            if (minIy[col] === 32767) {
              footprint++;
              if (ix < x0) x0 = ix;
              if (ix > x1) x1 = ix;
              if (iz < z0) z0 = iz;
              if (iz > z1) z1 = iz;
            }
            if (iy < minIy[col]) minIy[col] = iy;
            if (iy > yHi) yHi = iy;
          }
        }
      }
    }
    const mf = this.arenaFloor(si);
    const st = this.levelStats(this.sectorStanding[si]);
    // walkways: columns with a floor at main-floor height AND a floor >= bandGap above it (a machine top has no
    // floor underneath and does not count)
    let elevated = 0;
    {
      const low = new Set<number>();
      const high = new Set<number>();
      for (const k of this.sectorStanding[si]) {
        const col = this.standing[k] % g.sy;
        if (Math.abs(this.standH[k] - mf.height) <= 0.3) low.add(col);
        else if (this.standH[k] >= mf.height + LIMITS.bandGap) high.add(col);
      }
      for (const col of high) if (low.has(col)) elevated++;
    }
    const shape: SectorShape = {
      footprint,
      spanX: 0,
      spanZ: 0,
      openSquare: 0,
      height: 0,
      top: 0,
      bands: st.bands.length,
      stacked: st.stacked,
      mainHeight: mf.height,
      mainLong: mf.long,
      mainShort: mf.short,
      mainFill: mf.fill,
      tallFraction: 0,
      tallRows: 0,
      elevated,
    };
    if (footprint > 0) {
      const fw = x1 - x0 + 1;
      const fd = z1 - z0 + 1;
      const clear = 2 * HX - 1; // n cell centres in a row = n - 1 + 2·HX metres of clear width
      shape.spanX = fw + clear;
      shape.spanZ = fd + clear;
      shape.top = g.Y(yHi) + HY;
      shape.height = shape.top - mf.height;
      // largest square of footprint columns
      let prev = new Int16Array(fw + 1);
      let cur = new Int16Array(fw + 1);
      let open = 0;
      for (let iz = z0; iz <= z1; iz++) {
        cur[0] = 0;
        for (let k = 1; k <= fw; k++) {
          cur[k] = minIy[iz * nx + x0 + k - 1] !== 32767 ? Math.min(prev[k], prev[k - 1], cur[k - 1]) + 1 : 0;
          if (cur[k] > open) open = cur[k];
        }
        const t = prev;
        prev = cur;
        cur = t;
      }
      shape.openSquare = open + clear;
      // columns of the main floor's bounding rectangle where the player cannot be within `t` m of the main floor
      const blockedBelow = (ix: number, iz: number, t: number): boolean => g.Y(minIy[iz * nx + ix]) > mf.height + HY + t + 1e-6 || minIy[iz * nx + ix] === 32767;
      x0 = mf.x0;
      x1 = mf.x1;
      z0 = mf.z0;
      z1 = mf.z1;
      const w = x1 - x0 + 1;
      const d = z1 - z0 + 1;
      // free-standing obstacles: 4-connected groups of blocked columns that do not touch the rectangle's border
      // (walls, door jambs and everything attached to them are not "equipment")
      const groups = (t: number): Array<{ n: number; lw: number; ld: number }> => {
        const out: Array<{ n: number; lw: number; ld: number }> = [];
        const seen = new Uint8Array(Math.max(0, w * d));
        for (let iz = z0; iz <= z1; iz++) {
          for (let ix = x0; ix <= x1; ix++) {
            const k0 = (iz - z0) * w + (ix - x0);
            if (seen[k0] !== 0 || !blockedBelow(ix, iz, t)) continue;
            seen[k0] = 1;
            const stack = [k0];
            let n = 0;
            let ax0 = ix;
            let ax1 = ix;
            let az0 = iz;
            let az1 = iz;
            while (stack.length > 0) {
              const k = stack.pop()!;
              n++;
              const cx = x0 + (k % w);
              const cz = z0 + Math.floor(k / w);
              if (cx < ax0) ax0 = cx;
              if (cx > ax1) ax1 = cx;
              if (cz < az0) az0 = cz;
              if (cz > az1) az1 = cz;
              for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
                const ex = cx + dx;
                const ez = cz + dz;
                if (ex < x0 || ex > x1 || ez < z0 || ez > z1) continue;
                const e = (ez - z0) * w + (ex - x0);
                if (seen[e] !== 0 || !blockedBelow(ex, ez, t)) continue;
                seen[e] = 1;
                stack.push(e);
              }
            }
            if (ax0 > x0 && ax1 < x1 && az0 > z0 && az1 < z1) out.push({ n, lw: ax1 - ax0 + 1, ld: az1 - az0 + 1 });
          }
        }
        return out;
      };
      let tall = 0;
      for (const q of groups(4.5)) tall += q.n;
      shape.tallFraction = w > 0 && d > 0 ? tall / (w * d) : 0;
      for (const q of groups(8)) if (Math.max(q.lw, q.ld) >= 20 && Math.min(q.lw, q.ld) <= 8) shape.tallRows++;
    }
    this.shapeCache.set(si, shape);
    return shape;
  }

  /**
   * The geometric property a sector must have to carry its declared kind, and the geometric class the kind
   * counts as ('functional' kinds — dock, gate — are defined by what they contain and are not counted).
   */
  kindRule(si: number, sh: SectorShape): { ok: boolean; cls: string; text: string } {
    const s = this.stage.sectors[si];
    const st = this.stage;
    const len = Math.max(sh.spanX, sh.spanZ);
    const span = `${r1(sh.spanX)} x ${r1(sh.spanZ)} m`;
    const pct = (v: number): string => `${r1(v * 100)} %`;
    const inSector = (p: V3): boolean => s.bounds.some((b) => inBox(p, b));
    const mid = (b: Box): V3 => ({ x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2, z: (b.min.z + b.max.z) / 2 });
    switch (s.kind) {
      case 'corridor':
        return { ok: sh.openSquare <= 20 && len >= 60, cls: 'narrow passage', text: `widest free square ${r1(sh.openSquare)} m <= 20 m, length ${r1(len)} m >= 60 m` };
      case 'road':
        return { ok: sh.openSquare <= 30 && len >= 200, cls: 'narrow passage', text: `widest free square ${r1(sh.openSquare)} m <= 30 m, length ${r1(len)} m >= 200 m` };
      case 'shaft': {
        // width of the shaft proper = larger extent of its main floor (an annex such as a landing does not count)
        const width = sh.mainLong + 2 * HX - 1;
        return { ok: sh.height >= width && sh.height >= 30, cls: 'vertical shaft', text: `clear height ${r1(sh.height)} m above its floor >= the floor's larger extent ${r1(width)} m, and >= 30 m (footprint ${span})` };
      }
      case 'tunnel':
        return { ok: sh.top <= 0 && sh.height <= 10, cls: 'underground tunnel', text: `ceiling at ${r1(sh.top)} m <= 0 (below ground level), clear height ${r1(sh.height)} m <= 10 m` };
      case 'multilevel':
        return { ok: sh.bands >= 2 && sh.stacked >= LIMITS.stackedArea, cls: 'stacked floors', text: `${sh.bands} floor levels >= ${LIMITS.bandGap} m apart with >= ${LIMITS.bandArea} m² each, ${sh.stacked} m² stacked >= ${LIMITS.stackedArea} m²` };
      case 'yard':
        return {
          ok: sh.mainLong >= LIMITS.arenaLong && sh.mainShort >= LIMITS.arenaShort && sh.mainFill >= LIMITS.arenaFill && sh.tallFraction <= 0.08 && sh.bands === 1,
          cls: 'open yard',
          text: `single floor level, main floor ${sh.mainLong} x ${sh.mainShort} m, only ${pct(sh.tallFraction)} (<= 8 %) of it under free-standing obstacles taller than the mech (4.5 m)`,
        };
      case 'factory':
        return { ok: sh.tallFraction >= 0.1, cls: 'equipment hall', text: `${pct(sh.tallFraction)} (>= 10 %) of the floor rectangle under free-standing machinery / structures taller than the mech (4.5 m)` };
      case 'plant':
        return { ok: sh.tallFraction >= 0.1 && sh.elevated >= LIMITS.bandArea, cls: 'equipment hall', text: `${pct(sh.tallFraction)} (>= 10 %) of the floor rectangle under free-standing equipment taller than the mech, ${sh.elevated} m² (>= ${LIMITS.bandArea}) of service walkways >= ${LIMITS.bandGap} m over the floor` };
      case 'warehouse':
        return { ok: sh.tallRows >= 3, cls: 'rack warehouse', text: `${sh.tallRows} (>= 3) free-standing rack rows >= 8 m high, >= 20 m long, <= 8 m wide` };
      case 'dock':
        return { ok: inSector(st.playerStart.position), cls: 'functional', text: 'contains the player start' };
      case 'gate':
        return { ok: inSector(mid(st.finalGate.box)) && inSector(mid(st.exitZone)), cls: 'functional', text: 'contains the final gate and the exit zone' };
      default:
        return { ok: false, cls: 'unknown', text: 'unknown kind' };
    }
  }

  // ───────────────────────────── V2 ─────────────────────────────
  checkEnemies(): CheckResult {
    const ck = new Check('V2', 'Enemies: 30 guards + 15 turrets, 6 control turrets, legal placement, all attackable');
    const st = this.stage;
    const g = this.grid;
    const en = st.enemies;
    const guards = en.filter((e) => e.kind === 'guard');
    const turrets = en.filter((e) => e.kind === 'turret');
    ck.need(guards.length === LIMITS.guards, `guards ${guards.length} = ${LIMITS.guards}`);
    ck.need(turrets.length === LIMITS.turrets, `turrets ${turrets.length} = ${LIMITS.turrets}`);
    ck.need(new Set(en.map((e) => e.id)).size === en.length, `enemy ids unique`);
    ck.need(en.every((e) => !e.test), `no enemy uses isolated-test overrides`);
    const controls = en.filter((e) => e.isGateControl);
    ck.need(controls.length === LIMITS.controls && controls.every((e) => e.kind === 'turret'), `control turrets ${controls.length} = ${LIMITS.controls} (all of kind turret)`);
    ck.need(st.barriers.length === LIMITS.controls, `barriers ${st.barriers.length} = ${LIMITS.controls}`);
    const link: string[] = [];
    const bids = new Set<string>();
    for (const c of controls) {
      const b = st.barriers.find((q) => q.id === c.barrierId);
      if (!b) link.push(`${c.id}: barrier ${c.barrierId} missing`);
      else if (b.controlEnemyId !== c.id) link.push(`${c.id}: barrier ${b.id} points to ${b.controlEnemyId}`);
      if (c.barrierId) bids.add(c.barrierId);
    }
    for (const b of st.barriers) if (!controls.some((c) => c.id === b.controlEnemyId)) link.push(`barrier ${b.id}: control ${b.controlEnemyId} is not a control turret`);
    ck.need(link.length === 0 && bids.size === controls.length, `control turret <-> barrier links are one-to-one${link.length ? ` — ${link.join('; ')}` : ''}`);
    const csec = new Set(controls.map((c) => c.sectorId));
    ck.need(csec.size === controls.length, `control turrets lie in ${csec.size} different sectors (${controls.map((c) => `${c.id}@${c.sectorId}`).join(', ')})`);

    const closables: Box[] = [...st.barriers.map((b) => b.box), st.finalGate.box];
    const bad: string[] = [];
    const unreachable: string[] = [];
    let minArea = Infinity;
    const down = { x: 0, y: -1, z: 0 };
    for (const e of en) {
      const spec = ENEMIES[e.kind];
      const sec = st.sectors.find((s) => s.id === e.sectorId);
      if (!sec) bad.push(`${e.id}: unknown sector ${e.sectorId}`);
      else if (!sec.bounds.some((b) => inBox(e.position, b))) bad.push(`${e.id}: position ${fmtV(e.position)} outside its sector ${e.sectorId}`);
      if (st.solids.some((s) => sphereHitsBox(e.position, spec.radius, s)) || closables.some((b) => sphereHitsBox(e.position, spec.radius, b))) {
        bad.push(`${e.id}: hit sphere overlaps a solid`);
        continue;
      }
      // support: first surface straight below the centre must be centerHeight away (initial state: barriers closed)
      this.setWorld(this.closable);
      const hit = this.world.raycast(e.position, down, 6);
      if (!hit || Math.abs(hit.dist - spec.centerHeight) > 0.06) {
        bad.push(`${e.id}: ${e.kind} is not resting on a surface (gap below centre ${hit ? r2(hit.dist) : '> 6'} m, expected ${spec.centerHeight})`);
      } else if (e.kind === 'guard') {
        const area = this.guardFloorArea(e.position, LIMITS.guardFloor);
        minArea = Math.min(minArea, area);
        if (area < LIMITS.guardFloor) bad.push(`${e.id}: only ${area} m² of connected walkable floor (< ${LIMITS.guardFloor})`);
      }
      // attackable from the reachable region (all barriers open)
      this.setWorld([]);
      let wit = this.findAttackCell(this.RS, e.position, spec.radius, LIMITS.attackRange, 800, true);
      if (!wit) wit = this.findAttackCell(this.RS, e.position, spec.radius, LIMITS.attackRange, 6000, true);
      if (!wit) unreachable.push(e.id);
    }
    this.setWorld(this.closable);
    ck.need(bad.length === 0, `every enemy is placed legally (inside its sector, clear of solids, resting on a surface, guards on >= ${LIMITS.guardFloor} m² floor)${bad.length ? ` — ${bad.slice(0, 12).join('; ')}${bad.length > 12 ? ` … +${bad.length - 12}` : ''}` : ''}`);
    ck.need(unreachable.length === 0, `every enemy can be attacked from a reachable cell within ${LIMITS.attackRange} m with a clear line${unreachable.length ? ` — not attackable: ${unreachable.join(', ')}` : ''}`);
    if (Number.isFinite(minArea)) ck.line(`smallest connected guard floor found: ${minArea >= LIMITS.guardFloor ? `>= ${LIMITS.guardFloor}` : minArea} m²`);
    // Cross-check with the game's own navigation grid (src/sim/nav.ts, initial barrier state): every guard must
    // start on a walkable node, with >= 100 walkable 1 m lattice points connected to it within 12 m.
    if (guards.length > 0) {
      try {
        const nav = new NavGrid(new World(st), st);
        nav.build();
        nav.reset();
        const offNav: string[] = [];
        const navAreas: Record<string, number> = {};
        const q = { x: 0, y: 0, z: 0 };
        for (const e of guards) {
          if (!nav.isWalkable(e.position)) {
            offNav.push(`${e.id}: not on a walkable NavGrid node`);
            continue;
          }
          let area = 0;
          q.y = e.position.y;
          for (let dz = -12; dz <= 12; dz++) for (let dx = -12; dx <= 12; dx++) {
            q.x = Math.floor(e.position.x) + 0.5 + dx;
            q.z = Math.floor(e.position.z) + 0.5 + dz;
            if (nav.isWalkable(q) && nav.connected(e.position, q)) area++;
          }
          navAreas[e.id] = area;
          if (area < LIMITS.guardFloor) offNav.push(`${e.id}: only ${area} m² of connected NavGrid floor within 12 m`);
        }
        const least = Object.entries(navAreas).sort((a, b) => a[1] - b[1])[0];
        ck.need(offNav.length === 0, `every guard starts on the game's NavGrid with >= ${LIMITS.guardFloor} m² of connected walkable floor within 12 m${least ? ` (smallest: ${least[0]} ${least[1]} m²)` : ''}${offNav.length ? ` — ${offNav.slice(0, 8).join('; ')}` : ''}`);
        ck.data.navAreas = navAreas;
        ck.data.navInfo = nav.getInfo();
        // Mobility: with every barrier and the gate open, the guard's NavGrid region must be large and contain a
        // waypoint of the recommended route — otherwise it can never close in on or pursue the player (SPEC §2.3).
        const mob = this.guardMobility();
        const mobile = guards.filter((e) => mob.get(e.id)?.mobile);
        const stuck = guards.filter((e) => !mob.get(e.id)?.mobile);
        const onMain = guards.filter((e) => mob.get(e.id)?.onMainFloor);
        ck.need(mobile.length >= Math.min(LIMITS.mobileGuards, guards.length), `guards that can walk to the route (NavGrid region >= ${LIMITS.mobileGuardFloor} m² containing a route waypoint, all barriers open): ${mobile.length} >= ${Math.min(LIMITS.mobileGuards, guards.length)}${stuck.length ? ` — confined: ${stuck.map((e) => `${e.id} ${mob.get(e.id)?.area ?? 0} m²${mob.get(e.id)?.onRoute ? '' : ', off the route'}`).join('; ')}` : ''}`);
        ck.need(onMain.length >= Math.min(LIMITS.mainFloorGuards, guards.length), `guards standing on the main floor of their sector: ${onMain.length} >= ${Math.min(LIMITS.mainFloorGuards, guards.length)}`);
        const bare = st.sectors.filter((s, si) => s.combatArena && !guards.some((e) => e.sectorId === s.id && mob.get(e.id)?.mobile && mob.get(e.id)?.onMainFloor && Math.abs(e.position.y - ENEMIES.guard.centerHeight - this.arenaFloor(si).height) <= 0.3)).map((s) => s.id);
        ck.need(bare.length === 0, `every combat arena has a mobile guard on its main floor${bare.length ? ` — none in ${bare.join(', ')}` : ''}`);
        const small = [...mob.entries()].sort((a, b) => a[1].area - b[1].area)[0];
        if (small) ck.line(`smallest guard region: ${small[0]} ${small[1].area} m²; regions (m²): ${guards.map((e) => `${e.id} ${mob.get(e.id)?.area ?? 0}${mob.get(e.id)?.onMainFloor ? '' : '*'}`).join(' ')}  (* = not on the sector's main floor)`);
        ck.data.guardMobility = Object.fromEntries(mob);
      } catch (err) {
        ck.fail(`the NavGrid cross-check threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const perSector: Record<string, number> = {};
    for (const e of en) perSector[e.sectorId] = (perSector[e.sectorId] ?? 0) + 1;
    const occupied = st.sectors.filter((s) => (perSector[s.id] ?? 0) > 0).length;
    if (st.sectors.length >= LIMITS.enemySectors) ck.need(occupied >= LIMITS.enemySectors, `sectors that contain at least one enemy: ${occupied} >= ${LIMITS.enemySectors} (empty: ${st.sectors.filter((s) => !perSector[s.id]).map((s) => s.id).join(', ') || '-'})`);
    ck.line(`enemies per sector: ${st.sectors.map((s) => `${s.id} ${perSector[s.id] ?? 0}`).join(' · ')}`);
    ck.data.perSector = perSector;
    ck.data.sectorsWithEnemies = occupied;
    ck.data.problems = bad;
    ck.data.notAttackable = unreachable;
    return ck.done();
  }

  private mobilityCache: Map<string, GuardMobility> | null = null;

  /**
   * Where every guard can walk according to the game's NavGrid with EVERY barrier and the gate open:
   * area of its connected region (m², flood over the lattice nodes at the guard's standing height), whether
   * the region contains a waypoint of the recommended route, and whether the guard stands on the main floor
   * (V10) of its sector. mobile = area >= LIMITS.mobileGuardFloor and on the route.
   */
  guardMobility(): Map<string, GuardMobility> {
    if (this.mobilityCache) return this.mobilityCache;
    const st = this.stage;
    const out = new Map<string, GuardMobility>();
    const guards = st.enemies.filter((e) => e.kind === 'guard');
    if (guards.length === 0) return (this.mobilityCache = out);
    const nav = new NavGrid(new World(st), st);
    nav.build();
    nav.reset();
    for (const id of this.closable) nav.setBarrierOpen(id, true);
    const info = nav.getInfo();
    const cs = info.cellSize;
    const regions: Array<{ seed: V3; area: number; onRoute: boolean; cells: Set<number> }> = [];
    const q = { x: 0, y: 0, z: 0 };
    for (const e of guards) {
      const si = st.sectors.findIndex((s) => s.id === e.sectorId);
      const floorY = e.position.y - ENEMIES.guard.centerHeight;
      const onMainFloor = si >= 0 && Math.abs(floorY - this.arenaFloor(si).height) <= 0.3;
      if (!nav.isWalkable(e.position)) {
        out.set(e.id, { area: 0, onRoute: false, onMainFloor, mobile: false });
        continue;
      }
      let reg = regions.find((r) => Math.abs(r.seed.y - e.position.y) <= 0.31 && nav.connected(r.seed, e.position));
      if (!reg) {
        // flood the lattice nodes of this region (flat floors: one standing height)
        const i0 = Math.floor((e.position.x - info.originX) / cs);
        const j0 = Math.floor((e.position.z - info.originZ) / cs);
        const key = (i: number, j: number): number => (j + 2) * (info.nx + 4) + (i + 2);
        const cells = new Set<number>();
        const stack: Array<[number, number]> = [];
        q.y = e.position.y;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          q.x = info.originX + (i0 + di + 0.5) * cs;
          q.z = info.originZ + (j0 + dj + 0.5) * cs;
          if (!cells.has(key(i0 + di, j0 + dj)) && nav.isWalkable(q) && nav.connected(e.position, q)) {
            cells.add(key(i0 + di, j0 + dj));
            stack.push([i0 + di, j0 + dj]);
          }
        }
        while (stack.length > 0) {
          const [i, j] = stack.pop()!;
          for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            const a = i + di;
            const b = j + dj;
            if (a < 0 || b < 0 || a >= info.nx || b >= info.nz || cells.has(key(a, b))) continue;
            q.x = info.originX + (a + 0.5) * cs;
            q.z = info.originZ + (b + 0.5) * cs;
            if (!nav.isWalkable(q) || !nav.connected(e.position, q)) continue;
            cells.add(key(a, b));
            stack.push([a, b]);
          }
        }
        let onRoute = false;
        const w = { x: 0, y: 0, z: 0 };
        for (const wp of st.route) {
          w.x = wp.position.x;
          w.y = wp.position.y - HY + ENEMIES.guard.centerHeight;
          w.z = wp.position.z;
          if (Math.abs(w.y - e.position.y) > 0.31) continue;
          const n = nav.nearestWalkable(w, 2.5);
          if (n && Math.abs(n.y - e.position.y) <= 0.31 && nav.connected(e.position, n)) {
            onRoute = true;
            break;
          }
        }
        reg = { seed: { ...e.position }, area: Math.round(cells.size * cs * cs), onRoute, cells };
        regions.push(reg);
      }
      out.set(e.id, { area: reg.area, onRoute: reg.onRoute, onMainFloor, mobile: reg.onRoute && reg.area >= LIMITS.mobileGuardFloor });
    }
    return (this.mobilityCache = out);
  }

  /** Connected flat floor (m², 1 m lattice, 4-connected) a guard standing at `pos` can walk on; stops at `limit`. */
  guardFloorArea(pos: V3, limit: number): number {
    const w = this.world;
    const half = { x: ENEMIES.guard.radius, y: ENEMIES.guard.radius, z: ENEMIES.guard.radius };
    const down = { x: 0, y: -1, z: 0 };
    const p = { x: 0, y: pos.y, z: 0 };
    const ok = (i: number, k: number): boolean => {
      p.x = pos.x + i;
      p.z = pos.z + k;
      if (w.overlapsBox(p, half)) return false;
      const hit = w.raycast(p, down, 3);
      return !!hit && Math.abs(hit.dist - ENEMIES.guard.centerHeight) <= 0.06;
    };
    const R = 48;
    const seen = new Set<number>();
    const key = (i: number, k: number): number => (i + R) * (2 * R + 1) + (k + R);
    if (!ok(0, 0)) return 0;
    const stack: Array<[number, number]> = [[0, 0]];
    seen.add(key(0, 0));
    let area = 0;
    while (stack.length > 0 && area < limit) {
      const [i, k] = stack.pop()!;
      area++;
      for (const [di, dk] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const a = i + di;
        const b = k + dk;
        if (Math.abs(a) > R || Math.abs(b) > R || seen.has(key(a, b))) continue;
        seen.add(key(a, b));
        if (ok(a, b)) stack.push([a, b]);
      }
    }
    return area;
  }

  /** Greedy any-angle shortening of a polyline; every kept segment is a verified collision-free sweep. */
  stringPull(pts: V3[], free: (a: V3, b: V3) => boolean = (a, b) => this.sweepFree(a, b)): { points: V3[]; length: number; valid: boolean } {
    let cur = pts;
    for (let pass = 0; pass < 4; pass++) {
      if (cur.length < 3) break;
      const out: V3[] = [cur[0]];
      let a = 0;
      for (let j = 1; j < cur.length - 1; j++) {
        if (!free(cur[a], cur[j + 1])) {
          out.push(cur[j]);
          a = j;
        }
      }
      out.push(cur[cur.length - 1]);
      const same = out.length === cur.length;
      cur = out;
      if (same) break;
    }
    let length = 0;
    let valid = true;
    for (let i = 1; i < cur.length; i++) {
      length += dist3(cur[i - 1], cur[i]);
      if (!free(cur[i - 1], cur[i])) valid = false;
    }
    return { points: cur, length, valid };
  }

  // ───────────────────────────── V3 ─────────────────────────────
  checkRoute(): CheckResult {
    const ck = new Check('V3', `Shortest start→exit route with every barrier and the gate open: lower bound >= ${LIMITS.routeMin} m`);
    const g = this.grid;
    const st = this.stage;
    const sp = st.playerStart.position;
    if (this.startS < 0) ck.fail('the player start is not inside a free cell');
    if (this.exitCellsS.length === 0) ck.fail('the exit zone contains no free cell');
    const dist = this.dist();
    const tgt = this.take();
    let lgrid = NaN;
    let pulled: { points: V3[]; length: number; valid: boolean } | null = null;
    let tightRoute = false;
    const sectorSeq: string[] = [];
    if (this.startS >= 0 && this.exitCellsS.length > 0) {
      const mS = this.maskS();
      tgt.set(this.exitS);
      const r = g.dijkstra(mS, [this.startS], dist, { targets: tgt });
      if (r.target < 0) {
        ck.fail('the exit zone is not reachable from the start (STRICT grid, all barriers open)');
      } else {
        let path = g.tracePath(dist, r.target);
        lgrid = g.pathLength(path) + dist3(sp, g.center(this.startS));
        this.setWorld([]);
        // corner-cutting grid moves are replaced by axis-parallel moves through free cells, which makes every
        // centre-to-centre move a collision-free sweep of the real box
        const repaired = g.repairPath(path, mS);
        pulled = this.stringPull([{ ...sp }, ...(repaired ?? path).map((c) => g.center(c))]);
        if (!pulled.valid) {
          // last resort: search again without corner cutting
          tgt.set(this.exitS);
          const rt = g.dijkstra(mS, [this.startS], dist, { targets: tgt, tight: true });
          if (rt.target >= 0) {
            path = g.tracePath(dist, rt.target, mS, true);
            pulled = this.stringPull([{ ...sp }, ...path.map((c) => g.center(c))]);
            tightRoute = true;
          }
        }
        this.setWorld(this.closable);
        let last = '';
        for (const c of path) {
          const si = this.sectorIndexAt(g.center(c));
          const id = si >= 0 ? st.sectors[si].id : '';
          if (id && id !== last) {
            sectorSeq.push(id);
            last = id;
          }
        }
      }
    }
    // LOOSE grid: over-approximates the free space, so its shortest path under-estimates the truth
    const mL = this.maskL();
    tgt.set(this.exitL);
    const rl = g.dijkstra(mL, [this.startL], dist, { targets: tgt });
    let lloose = NaN;
    if (rl.target >= 0) lloose = g.pathLength(g.tracePath(dist, rl.target));
    this.give(tgt);
    const hops = rl.target >= 0 ? g.hopDistance(mL, sp, this.exitL) : -1;
    // 0.5 m: float32 accumulation of the distance field; 2 m: start / end points vs. their cell centres
    const lbChamfer = Number.isFinite(lloose) ? (lloose - 2.5) / CHAMFER_RATIO : NaN;
    const lbHop = hops >= 0 ? hops - 1 : NaN;
    const lower = Math.max(Number.isFinite(lbChamfer) ? lbChamfer : -Infinity, Number.isFinite(lbHop) ? lbHop : -Infinity);
    ck.line(`(a) Lgrid = ${r1(lgrid)} m  — shortest 26-neighbour grid path through STRICT-free cells (player box centred on each cell)`);
    ck.line(`    LgridLoose = ${r1(lloose)} m — same metric on the LOOSE (over-approximated) free space`);
    ck.line(`(b) lower bounds of the true Euclidean shortest path:`);
    ck.line(`    proven hop bound      = ${r1(lbHop)} m  (octagonal hop count ${hops} - 1 on the LOOSE grid; valid for every continuous path)`);
    ck.line(`    voxel-model bound     = ${r1(lbChamfer)} m  ((LgridLoose - 2.5) / ${CHAMFER_RATIO.toFixed(5)})`);
    if (pulled) ck.line(`(c) explicit feasible route (string-pulled${tightRoute ? ' from the no-corner-cutting path' : ''}, every segment swept with the real collision World) = ${r1(pulled.length)} m in ${pulled.points.length - 1} segments${pulled.valid ? '' : ' — NOT VALID'}`);
    ck.need(lower >= LIMITS.routeMin, `lower bound ${r1(lower)} m >= ${LIMITS.routeMin} m`);
    if (Number.isFinite(lbHop) && lbHop < LIMITS.routeMin && lower >= LIMITS.routeMin) {
      ck.warn(`only the voxel-model bound reaches ${LIMITS.routeMin} m; the proven hop bound is ${r1(lbHop)} m`);
    }
    if (Number.isFinite(lgrid) && lgrid < LIMITS.routeTarget) ck.warn(`Lgrid ${r1(lgrid)} m is below the design target ${LIMITS.routeTarget} m`);
    if (pulled && !pulled.valid) ck.warn('the string-pulled route failed its final sweep verification (upper bound not usable)');
    if (pulled && pulled.valid && lower > pulled.length + 1e-6) ck.fail(`inconsistent bounds: lower ${r1(lower)} > feasible route ${r1(pulled.length)}`);
    if (sectorSeq.length) ck.line(`sectors along the grid path: ${sectorSeq.join(' → ')}`);
    ck.data.lgrid = lgrid;
    ck.data.lgridLoose = lloose;
    ck.data.hopCount = hops;
    ck.data.lowerBoundProven = lbHop;
    ck.data.lowerBoundVoxel = lbChamfer;
    ck.data.lowerBound = lower;
    ck.data.feasibleRouteLength = pulled ? pulled.length : null;
    ck.data.feasibleRouteValid = pulled ? pulled.valid : false;
    ck.data.feasibleRoute = pulled ? pulled.points.map((p) => [r2(p.x), r2(p.y), r2(p.z)]) : [];
    ck.data.sectorSequence = sectorSeq;
    return ck.done();
  }

  // ───────────────────────────── V4 ─────────────────────────────
  checkMandatorySectors(): CheckResult {
    const ck = new Check('V4', `Mandatory sectors: >= ${LIMITS.mandatorySectors} sectors that every start→exit route must cross`);
    const g = this.grid;
    const exitReach = this.exitCellsL.some((c) => this.RL[c] !== 0);
    if (!exitReach) {
      ck.fail('the exit is not reachable at all, mandatory sectors cannot be measured');
      return ck.done();
    }
    const out = this.take();
    const mandatory: string[] = [];
    const optional: string[] = [];
    for (const s of this.stage.sectors) {
      const blk = g.regionBlockerL(s.bounds);
      const m = this.maskL([], [blk]);
      const cut = m[this.startL] !== 0 || g.flood(m, [this.startL], out, { six: true, targets: this.exitL, stopAtTarget: true }).hit < 0;
      (cut ? mandatory : optional).push(s.id);
    }
    this.give(out);
    ck.need(mandatory.length >= LIMITS.mandatorySectors, `mandatory sectors ${mandatory.length} >= ${LIMITS.mandatorySectors}`);
    ck.line(`mandatory: ${mandatory.join(', ') || '-'}`);
    ck.line(`optional:  ${optional.join(', ') || '-'}`);
    ck.data.mandatory = mandatory;
    ck.data.optional = optional;
    return ck.done();
  }

  // ───────────────────────────── V5 ─────────────────────────────
  checkProgression(): CheckResult {
    const ck = new Check('V5', 'Progression: every barrier and the gate is a true cut; control turrets are attackable in order only');
    const g = this.grid;
    const st = this.stage;
    const gate = st.finalGate.id;
    const out = this.take();
    const reach = (closed: string[]): boolean => {
      const m = this.maskL(closed);
      return m[this.startL] === 0 && g.flood(m, [this.startL], out, { six: true, targets: this.exitL, stopAtTarget: true }).hit >= 0;
    };
    ck.need(reach([]), 'exit reachable with every barrier and the gate open');
    const leaks = st.barriers.filter((b) => reach([b.id])).map((b) => b.id);
    ck.need(leaks.length === 0, `closing any single barrier makes the exit unreachable${leaks.length ? ` — NOT a cut: ${leaks.join(', ')}` : ''}`);
    ck.need(!reach([gate]), 'closing only the final gate makes the exit unreachable (exit zone lies beyond the gate)');
    const info: Array<Record<string, unknown>> = [];
    const n = st.barriers.length;
    for (let i = 0; i < n; i++) {
      const closed = [...st.barriers.slice(i).map((b) => b.id), gate];
      const b = st.barriers[i];
      const turret = st.enemies.find((e) => e.id === b.controlEnemyId);
      if (!turret) {
        ck.fail(`barrier ${b.id}: control enemy ${b.controlEnemyId} does not exist`);
        continue;
      }
      this.setWorld(closed);
      let cells = 0;
      let wit: { cell: number; dist: number } | null = null;
      if (this.startS >= 0) {
        const mS = this.maskS(closed);
        cells = mS[this.startS] === 0 ? g.flood(mS, [this.startS], out, { tight: true }).count : 0;
        if (cells > 0) {
          wit = this.findAttackCell(out, turret.position, ENEMIES.turret.radius, LIMITS.controlRange, 4000, true);
          if (!wit) wit = this.findAttackCell(out, turret.position, ENEMIES.turret.radius, LIMITS.controlRange, 40000, true);
        }
      }
      ck.need(!!wit, `stage ${i + 1} (${closed.join(', ')} closed): control turret ${turret.id} attackable from the reachable region${wit ? ` — e.g. from ${fmtV(g.center(wit.cell))} at ${r1(wit.dist)} m` : ''}`);
      const rec: Record<string, unknown> = { stage: i + 1, closed, turret: turret.id, strictCells: cells, witness: wit ? { from: g.center(wit.cell), dist: wit.dist } : null };
      if (i + 1 < n) {
        const next = st.enemies.find((e) => e.id === st.barriers[i + 1].controlEnemyId);
        if (next) {
          const mL = this.maskL(closed);
          g.flood(mL, [this.startL], out, { six: true });
          const viol = this.findAttackCell(out, next.position, ENEMIES.turret.radius, LIMITS.controlRange, 40000, false);
          // second, independent test: exact segments from every region cell within range (uniform 1 m resolution at
          // any distance, where the ray fan gets coarse) to the centre and six rim points of the turret
          const dense = viol ? null : this.denseVisibleCell(out, next.position, ENEMIES.turret.radius, LIMITS.controlRange + 1.5);
          const seenFrom = viol ? g.center(viol.cell) : dense && dense.cell >= 0 ? g.center(dense.cell) : null;
          ck.need(!seenFrom, `stage ${i + 1}: the next control turret ${next.id} is NOT attackable while ${b.id} is closed${seenFrom ? ` — visible from ${fmtV(seenFrom)}` : ` (ray fan + ${dense ? dense.tested : 0} region cells within range tested by exact segments)`}`);
          rec.nextTurret = next.id;
          rec.nextTurretVisibleFrom = seenFrom;
          rec.nextTurretCellsTested = dense ? dense.tested : 0;
        }
      }
      info.push(rec);
    }
    this.setWorld(this.closable);
    this.give(out);
    ck.data.stages = info;
    return ck.done();
  }

  /** True when the real player box can rest with its centre at `p` (free, supported within 2 cm). */
  standsAt(p: V3): boolean {
    const half = { x: HX, y: HY, z: HZ };
    if (this.world.overlapsBox({ x: p.x, y: p.y + 2e-4, z: p.z }, half)) return false;
    return this.world.probeGround({ x: p.x, y: p.y + 2e-4, z: p.z }, half, 0.1) <= 0.02;
  }

  /** True when a size x size m square of standing positions (1 m lattice, same height) contains `p`. */
  hasStandingSquare(p: V3, size: number): boolean {
    const ok: boolean[][] = [];
    for (let i = -size; i <= size; i++) {
      const row: boolean[] = [];
      for (let k = -size; k <= size; k++) row.push(this.standsAt({ x: p.x + i, y: p.y, z: p.z + k }));
      ok.push(row);
    }
    for (let a = 0; a <= size; a++) for (let b = 0; b <= size; b++) {
      let all = true;
      for (let i = a; i <= a + size && all; i++) for (let k = b; k <= b + size; k++) {
        if (!ok[i][k]) {
          all = false;
          break;
        }
      }
      if (all) return true;
    }
    return false;
  }

  // ───────────────────────────── V6 ─────────────────────────────
  checkFlightSpots(): CheckResult {
    const ck = new Check('V6', `Flight spots: >= ${LIMITS.flightSpots} separate mandatory climbs (${LIMITS.flightMin}–${LIMITS.flightMax} m) that cannot be crossed without flight`);
    const g = this.grid;
    const spots = this.stage.flightSpots;
    ck.need(spots.length >= LIMITS.flightSpots, `declared flight spots ${spots.length} >= ${LIMITS.flightSpots}`);
    let minSep = Infinity;
    for (let i = 0; i < spots.length; i++) for (let j = i + 1; j < spots.length; j++) {
      for (const a of [spots[i].from, spots[i].to]) for (const b of [spots[j].from, spots[j].to]) minSep = Math.min(minSep, dist3(a, b));
    }
    if (spots.length > 1) ck.need(minSep >= LIMITS.flightSeparation, `spots pairwise >= ${LIMITS.flightSeparation} m apart (closest pair of from/to points ${r1(minSep)} m)`);
    const N = this.take();
    const far = this.take();
    const seeds = this.take();
    const capIdx = new Uint16Array(g.n);
    const RL = this.RL;
    const gen = GENERATOR_PARTS.recovery.maxEn;
    const air = PLAYER.airSpeed * LEGS_PARTS.quadruped.speedMult;
    const info: Array<Record<string, unknown>> = [];
    // per spot: size of its near side and, for every spot, on which side of this cut its from / to points lie
    const nearCount: number[] = [];
    const sides: Array<Array<{ from: number; to: number }>> = [];
    this.setWorld([]);
    for (const s of spots) {
      const bad: string[] = [];
      const h = s.to.y - s.from.y;
      let minClimb = NaN;
      let lowAt: V3 | null = null;
      if (h < LIMITS.flightMin - 1e-6 || h > LIMITS.flightMax + 1e-6) bad.push(`height ${r2(h)} m outside ${LIMITS.flightMin}–${LIMITS.flightMax} m`);
      if (Math.abs(h - s.height) > 0.1) bad.push(`declared height ${s.height} differs from to.y - from.y = ${r2(h)}`);
      if (!this.standsAt(s.from)) bad.push(`'from' ${fmtV(s.from)} is not a standing position`);
      else if (!this.hasStandingSquare(s.from, LIMITS.landingSize)) bad.push(`no ${LIMITS.landingSize} x ${LIMITS.landingSize} m standing area around 'from'`);
      if (!this.standsAt(s.to)) bad.push(`'to' ${fmtV(s.to)} is not a standing position`);
      else if (!this.hasStandingSquare(s.to, LIMITS.landingSize)) bad.push(`no ${LIMITS.landingSize} x ${LIMITS.landingSize} m standing area around 'to'`);
      // (a) the cut is crossed by every route
      const blk = g.regionBlockerL([s.cut]);
      let isCut = false;
      let needsFlight = false;
      let closureReachesExit = false;
      let hitAt: V3 | null = null;
      if (blk.length === 0) {
        bad.push('the cut box contains no full cell (make it >= 2 m thick, or >= 1 m aligned to the 1 m / 0.5 m grid)');
      } else {
        const m = this.maskL([], [blk]);
        isCut = m[this.startL] === 0 && g.flood(m, [this.startL], N, { six: true, targets: this.exitL }).hit < 0;
        if (!isCut) bad.push('(a) blocking the cut does not disconnect the exit — some route avoids it');
        else {
          // (b) no-flight closure from every resting cell of the near side must not get beyond the cut
          for (let c = 0; c < g.n; c++) far[c] = RL[c] !== 0 && N[c] === 0 ? 1 : 0;
          for (let i = 0; i < blk.length; i++) far[blk[i]] = 0;
          if (N[g.cellOf(s.from)] === 0) bad.push(`'from' is not on the start side of the cut`);
          if (N[g.cellOf(s.to)] !== 0) bad.push(`'to' is on the start side of the cut (it must be inside or beyond the cut)`);
          // Seeds: every possible resting cell of the near side, except the lip of the landing itself — resting
          // positions within (player half width + half a cell) of the cut box (a box overhanging the edge of a
          // platform that the cut covers). The closure still propagates through those cells, so reaching the lip
          // by jumping from anywhere else is detected.
          seeds.set(N);
          const lip: Box = {
            min: { x: s.cut.min.x - HX - 0.51, y: s.cut.min.y - g.cy, z: s.cut.min.z - HZ - 0.51 },
            max: { x: s.cut.max.x + HX + 0.51, y: s.cut.max.y + g.cy, z: s.cut.max.z + HZ + 0.51 },
          };
          const lipCells = g.boxCells(lip, true);
          for (let i = 0; i < lipCells.length; i++) seeds[lipCells[i]] = 0;
          if (seeds[this.startL] === 0) bad.push('the player start lies inside / next to the cut box');
          const res = g.noFlightClosure(this.maskL(), seeds, capIdx, LIMITS.jumpApex, far);
          needsFlight = res.hitFar < 0;
          closureReachesExit = this.exitCellsL.some((c) => capIdx[c] !== 0);
          if (!needsFlight) {
            hitAt = g.center(res.hitFar);
            bad.push(`(b) the far side of the cut can be reached WITHOUT flight (jump-only closure arrives at ${fmtV(hitAt)})`);
          }
          // (e) smallest climb that crosses the cut: the same closure with a hypothetical "super jump" of j m (and
          // unlimited horizontal reach) first gets beyond the cut at j = minClimb (0.5 m resolution: a riser R is
          // accepted when R <= j + cellY/2). It must not cross with j = flightMin - cellY, i.e. every crossing
          // contains a continuous climb of at least flightMin m above some resting place.
          if (needsFlight) {
            const low = g.noFlightClosure(this.maskL(), seeds, capIdx, LIMITS.flightMin - g.cy, far);
            if (low.hitFar >= 0) {
              lowAt = g.center(low.hitFar);
              minClimb = LIMITS.flightMin - g.cy;
              bad.push(`(e) the cut can be crossed with a climb of less than ${LIMITS.flightMin} m (a ${LIMITS.flightMin - g.cy} m rise above some resting place reaches ${fmtV(lowAt)})`);
            } else {
              for (let j: number = LIMITS.flightMin; j <= LIMITS.flightMax + 4; j += g.cy) {
                if (g.noFlightClosure(this.maskL(), seeds, capIdx, j, far).hitFar >= 0) {
                  minClimb = j;
                  break;
                }
              }
            }
          }
          nearCount.push(res.count >= 0 ? this.countMask(N) : 0);
          sides.push(spots.map((q) => ({ from: this.sideOf(q.from, N, blk), to: this.sideOf(q.to, N, blk) })));
        }
      }
      if (nearCount.length < info.length + 1) {
        nearCount.push(-1);
        sides.push([]);
      }
      // analytic EN estimate for the weakest loadout (EN 90, 12.8 m/s): jump, 0.2 s hold, climb 8 m/s to 0.5 m above the landing
      const yHold = PLAYER.jumpSpeed * PLAYER.flyHoldSeconds - 0.5 * GRAVITY * PLAYER.flyHoldSeconds ** 2;
      let tThrust = Math.max(0, (h + 0.5 - yHold) / PLAYER.flyClimbSpeed);
      const coast = (PLAYER.flyClimbSpeed + Math.sqrt(PLAYER.flyClimbSpeed ** 2 + 2 * GRAVITY * 0.5)) / GRAVITY;
      const dh = Math.hypot(s.to.x - s.from.x, s.to.z - s.from.z);
      const reachH = air * (PLAYER.flyHoldSeconds + tThrust + coast);
      if (dh > reachH) tThrust += (dh - reachH) / air;
      const enEst = tThrust * PLAYER.flyEnPerSecond;
      if (enEst > gen) bad.push(`estimated flight EN ${r1(enEst)} exceeds the smallest max EN ${gen}`);
      ck.need(bad.length === 0, `${s.id} (${s.sectorId}) declared climb ${r2(h)} m, smallest climb that crosses the cut ${Number.isFinite(minClimb) ? `${r1(minClimb)} m` : '-'}, horizontal ${r1(dh)} m, est. EN ${r1(enEst)}/${gen}: cut ${isCut ? 'ok' : 'NO'}, flight required ${needsFlight ? 'yes' : 'NO'}${bad.length ? ` — ${bad.join('; ')}` : ''}`);
      info.push({ id: s.id, height: h, horizontal: dh, isCut, needsFlight, closureReachesExit, closureArrivesAt: hitAt, minClimb: Number.isFinite(minClimb) ? minClimb : null, lowClimbArrivesAt: lowAt, enEstimate: enEst, problems: bad });
    }
    // Separate climbs: the cut boxes are pairwise disjoint, no spot straddles another spot's cut, and the near
    // sides are strictly nested (each climb lies beyond all the previous ones) — one opening cannot be counted twice.
    if (spots.length > 1) {
      const overlapping: string[] = [];
      for (let i = 0; i < spots.length; i++) for (let j = i + 1; j < spots.length; j++) if (boxesOverlap(spots[i].cut, spots[j].cut)) overlapping.push(`${spots[i].id}/${spots[j].id}`);
      ck.need(overlapping.length === 0, `the cut boxes are pairwise disjoint${overlapping.length ? ` — overlapping: ${overlapping.join(', ')}` : ''}`);
      const straddle: string[] = [];
      for (let i = 0; i < spots.length; i++) {
        if (sides[i].length === 0) continue;
        for (let j = 0; j < spots.length; j++) {
          if (i === j) continue;
          const sd = sides[i][j];
          if (sd.from !== sd.to || sd.from === 0) straddle.push(`${spots[j].id} vs cut ${spots[i].id}`);
        }
      }
      ck.need(straddle.length === 0, `no spot has its take-off and landing on different sides of (or inside) another spot's cut${straddle.length ? ` — ${straddle.join(', ')}` : ''}`);
      const order = spots.map((_, i) => i).filter((i) => nearCount[i] > 0).sort((a, b) => nearCount[a] - nearCount[b]);
      const notNested: string[] = [];
      for (let k = 1; k < order.length; k++) {
        const a = order[k - 1];
        const b = order[k];
        // b lies beyond a: b's points are on the far side of cut a, a's points on the near side of cut b
        const ok = nearCount[b] > nearCount[a] && sides[a][b].from === 2 && sides[a][b].to === 2 && sides[b][a].from === 1 && sides[b][a].to === 1;
        if (!ok) notNested.push(`${spots[a].id}/${spots[b].id}`);
      }
      ck.need(notNested.length === 0 && order.length === spots.length, `the climbs come one after the other: near sides strictly nested in the order ${order.map((i) => spots[i].id).join(' < ')}${notNested.length ? ` — not nested: ${notNested.join(', ')}` : ''}`);
      ck.data.order = order.map((i) => spots[i].id);
    }
    this.setWorld(this.closable);
    this.give(N);
    this.give(far);
    this.give(seeds);
    ck.data.spots = info;
    ck.data.minSeparation = Number.isFinite(minSep) ? minSep : null;
    return ck.done();
  }

  private countMask(m: Uint8Array): number {
    let n = 0;
    for (let i = 0; i < m.length; i++) if (m[i] !== 0) n++;
    return n;
  }

  /** Side of a cut a point lies on: 1 = near side region `near`, 0 = inside the blocked cut cells, 2 = beyond. */
  private sideOf(p: V3, near: Uint8Array, cut: Int32Array): number {
    const c = this.grid.cellOf(p);
    if (near[c] !== 0) return 1;
    for (let i = 0; i < cut.length; i++) if (cut[i] === c) return 0;
    return 2;
  }

  /** Enemies (initial positions) with range + line of sight (muzzle = centre + 0.5 m) to sample points. */
  exposure(points: V3[]): Exposure {
    const w = this.world;
    const counts = new Int32Array(points.length);
    const ids: string[] = [];
    for (const e of this.stage.enemies) {
      const spec = ENEMIES[e.kind];
      const mz = { x: e.position.x, y: e.position.y + spec.muzzleUp, z: e.position.z };
      let seen = false;
      for (let i = 0; i < points.length; i++) {
        if (dist3(e.position, points[i]) > spec.range) continue;
        if (w.segmentBlocked(mz, points[i])) continue;
        counts[i]++;
        seen = true;
      }
      if (seen) ids.push(e.id);
    }
    let mx = 0;
    let sum = 0;
    for (let i = 0; i < counts.length; i++) {
      mx = Math.max(mx, counts[i]);
      sum += counts[i];
    }
    return { enemies: ids.length, maxSimultaneous: mx, mean: counts.length > 0 ? sum / counts.length : 0, ids };
  }

  private tgtBuf: Uint8Array | null = null;
  /** All-zero scratch target mask (callers must leave it all-zero). */
  private tgt(): Uint8Array {
    if (!this.tgtBuf) this.tgtBuf = new Uint8Array(this.grid.n);
    return this.tgtBuf;
  }
  private readonly zeroBufs: Array<Uint8Array | null> = [null, null];
  /** Two more all-zero scratch masks (the pool of take() hands out dirty buffers); callers must leave them all-zero. */
  private zero(k: 0 | 1): Uint8Array {
    return (this.zeroBufs[k] ??= new Uint8Array(this.grid.n));
  }

  /**
   * One alternative of a branch: shortest collision-free grid route from → via → to that stays `avoidR` away
   * from `avoid`. Returns null when it does not exist.
   */
  branchAlternative(from: V3, to: V3, via: V3, avoid: V3, avoidR: number): BranchAlternative | null {
    const g = this.grid;
    const cf = this.cellNear(from);
    const ct = this.cellNear(to);
    const cv = this.cellNear(via);
    if (cf < 0 || ct < 0 || cv < 0) return null;
    const m = this.maskS();
    const ball = g.ballCells(avoid, avoidR);
    const saved = this.block(m, ball);
    const dist = this.localDist();
    const finish = (): void => {
      g.clearTouched(dist);
      this.unblock(m, ball, saved);
    };
    if (m[cf] !== 0 || m[ct] !== 0 || m[cv] !== 0) {
      finish();
      return null;
    }
    const t = this.tgt();
    t[cf] = 1;
    t[ct] = 1;
    const r = g.dijkstra(m, [cv], dist, { targets: t, targetCount: cf === ct ? 1 : 2, tight: true, maxDist: 2000, local: true });
    t[cf] = 0;
    t[ct] = 0;
    if (r.target < 0) {
      finish();
      return null;
    }
    const leg1 = g.tracePath(dist, cf, m, true);
    const leg2 = g.tracePath(dist, ct, m, true);
    finish();
    const length = g.pathLength(leg1) + g.pathLength(leg2);
    // retrace: share of the second leg that runs within ~2 m of the first one (a dead-end detour retraces itself)
    const key = (c: number): number => {
      const p = g.center(c);
      return (Math.floor(p.x / 2) * 4096 + Math.floor(p.z / 2)) * 512 + Math.floor(p.y / 2);
    };
    const seen = new Set<number>();
    for (const c of leg1) seen.add(key(c));
    let shared = 0;
    for (const c of leg2) if (seen.has(key(c))) shared++;
    const retrace = leg2.length > 0 ? shared / leg2.length : 1;
    const cells: number[] = [];
    for (let i = leg1.length - 1; i >= 0; i--) cells.push(leg1[i]);
    for (let i = 1; i < leg2.length; i++) cells.push(leg2[i]);
    const pts: V3[] = [];
    for (let i = 0; i < cells.length; i += 2) pts.push(g.center(cells[i]));
    return { length, retrace, exposure: this.exposure(pts), cells };
  }

  /**
   * Passage cross-section through `p`: the LOOSE-free cells that lie completely inside the 2 m thick slab
   * through p perpendicular to `axis` (0 = x, 1 = y, 2 = z) and are face-connected to p's cell inside the slab.
   * Blocking them closes the passage p lies in — and nothing else, provided the slab cuts across the passage.
   */
  crossSection(p: V3, axis: 0 | 1 | 2): Int32Array {
    const g = this.grid;
    const e = g.extent;
    const slab: Box = { min: { x: e.min.x - 4, y: e.min.y - 4, z: e.min.z - 4 }, max: { x: e.max.x + 4, y: e.max.y + 4, z: e.max.z + 4 } };
    const key = (['x', 'y', 'z'] as const)[axis];
    slab.min[key] = p[key] - 1;
    slab.max[key] = p[key] + 1;
    const cells = g.regionBlockerL([slab]);
    const mark = this.zero(0);
    for (let i = 0; i < cells.length; i++) mark[cells[i]] = 1;
    // seed: p's own cell, or the nearest slab cell next to it
    let seed = -1;
    const c0 = g.cellOf(p);
    if (mark[c0] !== 0) seed = c0;
    else {
      let best = Infinity;
      for (let k = 0; k < 26; k++) {
        const nb = c0 + g.off26[k];
        if (nb < 0 || nb >= g.n || mark[nb] === 0) continue;
        const d = dist3(g.center(nb), p);
        if (d < best) {
          best = d;
          seed = nb;
        }
      }
    }
    const out: number[] = [];
    if (seed >= 0) {
      mark[seed] = 2;
      out.push(seed);
      for (let h = 0; h < out.length; h++) {
        const c = out[h];
        for (let k = 0; k < 6; k++) {
          const nb = c + g.off26[k];
          if (mark[nb] !== 1) continue;
          mark[nb] = 2;
          out.push(nb);
        }
      }
    }
    for (let i = 0; i < cells.length; i++) mark[cells[i]] = 0;
    return Int32Array.from(out);
  }

  /**
   * Structural test of a branch: are the two alternatives separate passages? Looks for a cross-section through
   * viaA and one through viaB (any of the three axes each) such that
   *   - the two sections share no cell (they are different pieces of space),
   *   - alternative A does not touch B's section and B does not touch A's (each survives closing the other),
   *   - with BOTH sections closed `to` cannot be reached from `from` on the LOOSE grid (rigorous): every route
   *     from the split to the rejoin point uses one passage or the other.
   * An open floor fails (one section closes everything or the two together close nothing); so does a pair of
   * passages whose separating wall has a hole the player fits through.
   */
  branchSeparation(from: V3, to: V3, viaA: V3, viaB: V3, pathA: number[], pathB: number[]): { ok: boolean; reason: string; axisA: string; axisB: string; cellsA: number; cellsB: number } {
    const g = this.grid;
    const names = ['x', 'y', 'z'];
    const secA = ([0, 1, 2] as const).map((ax) => this.crossSection(viaA, ax));
    const secB = ([0, 1, 2] as const).map((ax) => this.crossSection(viaB, ax));
    const mark = this.zero(1);
    // A section that cuts ACROSS a passage contains only the few cells where the alternative's own path crosses
    // the 2 m slab; a slab that runs along the passage contains a long stretch of the path and is not tried.
    const crossing = (sec: Int32Array, path: number[]): number => {
      for (let i = 0; i < sec.length; i++) mark[sec[i]] = 1;
      let n = 0;
      for (let i = 0; i < path.length; i++) if (mark[path[i]] !== 0) n++;
      for (let i = 0; i < sec.length; i++) mark[sec[i]] = 0;
      return n;
    };
    const okA = secA.map((sec) => sec.length > 0 && crossing(sec, pathA) >= 1 && crossing(sec, pathA) <= 10);
    const okB = secB.map((sec) => sec.length > 0 && crossing(sec, pathB) >= 1 && crossing(sec, pathB) <= 10);
    const pairs: Array<[number, number]> = [];
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) if (okA[a] && okB[b]) pairs.push([a, b]);
    pairs.sort((p, q) => secA[p[0]].length + secB[p[1]].length - (secA[q[0]].length + secB[q[1]].length));
    const out = this.take();
    const tgt = this.tgt();
    const cf = g.cellOf(from);
    const ct = g.cellOf(to);
    let reason = 'viaA / viaB do not lie in a passage that their alternative crosses (no cross-section found)';
    let result = { ok: false, reason, axisA: '-', axisB: '-', cellsA: 0, cellsB: 0 };
    for (const [a, b] of pairs) {
      const A = secA[a];
      const B = secB[b];
      for (let i = 0; i < A.length; i++) mark[A[i]] = 1;
      let shared = false;
      for (let i = 0; i < B.length && !shared; i++) if (mark[B[i]] !== 0) shared = true;
      let bTouchesA = false;
      for (let i = 0; i < pathB.length && !bTouchesA; i++) if (mark[pathB[i]] !== 0) bTouchesA = true;
      for (let i = 0; i < A.length; i++) mark[A[i]] = 0;
      for (let i = 0; i < B.length; i++) mark[B[i]] = 1;
      let aTouchesB = false;
      for (let i = 0; i < pathA.length && !aTouchesB; i++) if (mark[pathA[i]] !== 0) aTouchesB = true;
      for (let i = 0; i < B.length; i++) mark[B[i]] = 0;
      if (shared) {
        reason = 'the cross-sections through viaA and viaB are the same piece of space (no structure between the alternatives)';
        continue;
      }
      if (aTouchesB || bTouchesA) {
        reason = `closing the passage of alternative ${aTouchesB ? 'B' : 'A'} also closes alternative ${aTouchesB ? 'A' : 'B'} (the two share a passage)`;
        continue;
      }
      const m = this.maskL([], [A, B]);
      tgt[ct] = 1;
      const joined = m[cf] === 0 && m[ct] === 0 && g.flood(m, [cf], out, { six: true, targets: tgt, stopAtTarget: true }).hit >= 0;
      tgt[ct] = 0;
      if (joined) {
        reason = 'with the passages through viaA and viaB both closed the rejoin point is still reachable (the via points are not in the two passages of a split)';
        continue;
      }
      result = { ok: true, reason: '', axisA: names[a], axisB: names[b], cellsA: A.length, cellsB: B.length };
      break;
    }
    if (!result.ok) result.reason = reason;
    this.give(out);
    return result;
  }

  /** Samples (every 2nd cell) of `path` that are farther than `d` from every cell of `other`. */
  exclusiveSamples(path: number[], other: number[], d: number): V3[] {
    const g = this.grid;
    const b = 8;
    const buckets = new Map<number, number[]>();
    const key = (x: number, y: number, z: number): number => (Math.floor(x / b) * 4096 + Math.floor(z / b)) * 1024 + Math.floor((y + 256) / b);
    for (const c of other) {
      const q = g.center(c);
      const k = key(q.x, q.y, q.z);
      const l = buckets.get(k);
      if (l) l.push(c);
      else buckets.set(k, [c]);
    }
    const out: V3[] = [];
    for (let i = 0; i < path.length; i += 2) {
      const p = g.center(path[i]);
      let near = false;
      for (let dx = -1; dx <= 1 && !near; dx++) for (let dz = -1; dz <= 1 && !near; dz++) for (let dy = -1; dy <= 1 && !near; dy++) {
        const l = buckets.get(key(p.x + dx * b, p.y + dy * b, p.z + dz * b));
        if (!l) continue;
        for (const c of l) {
          if (dist3(g.center(c), p) <= d) {
            near = true;
            break;
          }
        }
      }
      if (!near) out.push(p);
    }
    return out;
  }

  // ───────────────────────────── V7 ─────────────────────────────
  checkBranches(): CheckResult {
    const ck = new Check('V7', `Branches: >= ${LIMITS.branches} split-and-rejoin structures with two genuinely different alternatives`);
    const brs = this.stage.branches;
    ck.need(brs.length >= LIMITS.branches, `declared branches ${brs.length} >= ${LIMITS.branches}`);
    const mid = (b: (typeof brs)[number]): V3 => ({ x: (b.viaA.x + b.viaB.x) / 2, y: (b.viaA.y + b.viaB.y) / 2, z: (b.viaA.z + b.viaB.z) / 2 });
    let minSep = Infinity;
    for (let i = 0; i < brs.length; i++) for (let j = i + 1; j < brs.length; j++) minSep = Math.min(minSep, dist3(mid(brs[i]), mid(brs[j])));
    if (brs.length > 1) ck.need(minSep >= 20, `branches are at different places (closest pair of via mid-points ${r1(minSep)} m >= 20 m)`);
    this.setWorld([]);
    const info: Array<Record<string, unknown>> = [];
    for (const b of brs) {
      const A = this.branchAlternative(b.from, b.to, b.viaA, b.viaB, LIMITS.branchAvoid);
      const B = this.branchAlternative(b.from, b.to, b.viaB, b.viaA, LIMITS.branchAvoid);
      const bad: string[] = [];
      if (!A) bad.push(`no route from → viaA → to that stays ${LIMITS.branchAvoid} m away from viaB`);
      if (!B) bad.push(`no route from → viaB → to that stays ${LIMITS.branchAvoid} m away from viaA`);
      for (const [name, alt] of [['A', A], ['B', B]] as const) {
        if (!alt) continue;
        if (alt.length < LIMITS.branchMinLength) bad.push(`alternative ${name} is only ${r1(alt.length)} m long (< ${LIMITS.branchMinLength})`);
        if (alt.retrace > 0.5) bad.push(`alternative ${name} retraces ${Math.round(alt.retrace * 100)} % of itself (via point in a dead end)`);
      }
      let sep: ReturnType<StageAnalyzer['branchSeparation']> | null = null;
      let ownA: Exposure | null = null;
      let ownB: Exposure | null = null;
      let ownLenA = 0;
      let ownLenB = 0;
      if (A && B) {
        // (1) structure: two separate passages, and every route from the split to the rejoin uses one of them
        sep = this.branchSeparation(b.from, b.to, b.viaA, b.viaB, A.cells, B.cells);
        if (!sep.ok) bad.push(`the alternatives are not separate passages: ${sep.reason}`);
        // (2) tactical difference, measured on each alternative's own section (the stretches near the split and
        // the rejoin point are shared): the shorter alternative must be exposed to more enemies than the longer one
        const sa = this.exclusiveSamples(A.cells, B.cells, LIMITS.branchExclusive);
        const sb = this.exclusiveSamples(B.cells, A.cells, LIMITS.branchExclusive);
        ownA = this.exposure(sa);
        ownB = this.exposure(sb);
        ownLenA = sa.length * 2;
        ownLenB = sb.length * 2;
        if (sa.length < 10 || sb.length < 10) bad.push(`the alternatives have no section of their own (A ${ownLenA} m, B ${ownLenB} m farther than ${LIMITS.branchExclusive} m from the other)`);
        const [short, long, sn, ln] = A.length <= B.length ? [ownA, ownB, 'A', 'B'] : [ownB, ownA, 'B', 'A'];
        // "short but under fire from several directions" vs "longer but covered": more enemies, more of them at
        // once, and at least twice the firing lines per metre on the shorter alternative
        if (!(short.enemies > long.enemies && short.maxSimultaneous > long.maxSimultaneous && short.mean >= 2 * long.mean && short.mean > 0)) {
          bad.push(`no clear tactical difference: the shorter alternative ${sn} has ${short.enemies} enemies / max ${short.maxSimultaneous} at once / ${r2(short.mean)} firing lines per metre on its own section, the longer ${ln} ${long.enemies} / ${long.maxSimultaneous} / ${r2(long.mean)} (the shorter one must be clearly the more exposed)`);
        }
      }
      const d = (alt: typeof A, own: typeof ownA, len: number): string => (alt ? `${r1(alt.length)} m, own section ${len} m: ${own ? own.enemies : '-'} enemies with a firing line, max ${own ? own.maxSimultaneous : '-'} at once, ${own ? r2(own.mean) : '-'} per metre` : 'none');
      ck.need(bad.length === 0, `${b.id}: A ${d(A, ownA, ownLenA)} | B ${d(B, ownB, ownLenB)}${sep && sep.ok ? ` | separate passages (cross-sections ⟂ ${sep.axisA} / ⟂ ${sep.axisB}; both closed → rejoin point unreachable)` : ''}${bad.length ? ` — ${bad.join('; ')}` : ''}`);
      const strip = (alt: typeof A): unknown => (alt ? { length: alt.length, retrace: alt.retrace, exposure: alt.exposure } : null);
      info.push({ id: b.id, A: strip(A), B: strip(B), ownA, ownB, ownLengthA: ownLenA, ownLengthB: ownLenB, separation: sep, noteA: b.noteA, noteB: b.noteB, problems: bad });
    }
    this.setWorld(this.closable);
    ck.data.branches = info;
    return ck.done();
  }

  private colFloors: Map<number, number[]> | null = null;
  /** Floor heights of the reachable standing cells per XZ column. */
  private floorsByColumn(): Map<number, number[]> {
    if (!this.colFloors) {
      const m = new Map<number, number[]>();
      const sy = this.grid.sy;
      for (let i = 0; i < this.standing.length; i++) {
        const col = this.standing[i] % sy;
        const l = m.get(col);
        if (l) l.push(this.standH[i]);
        else m.set(col, [this.standH[i]]);
      }
      this.colFloors = m;
    }
    return this.colFloors;
  }

  /**
   * Area (m²) of the XZ columns strictly inside the plan polygon of a closed cell path (`inside`) and of those
   * among them on which the player cannot stand at the circuit's level (`hole`): no reachable standing cell
   * whose floor lies between the lowest waypoint floor - jumpApex and the highest waypoint floor + jumpApex.
   */
  enclosedHole(circuit: number[], points: V3[]): { hole: number; inside: number } {
    const g = this.grid;
    if (circuit.length < 3) return { hole: 0, inside: 0 };
    const xs: number[] = [];
    const zs: number[] = [];
    const onPath = new Set<number>();
    for (const c of circuit) {
      const ix = g.ix(c);
      const iz = g.iz(c);
      onPath.add(iz * g.nx + ix);
      if (xs.length > 0 && xs[xs.length - 1] === ix && zs[zs.length - 1] === iz) continue;
      xs.push(ix);
      zs.push(iz);
    }
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of points) {
      lo = Math.min(lo, p.y - HY);
      hi = Math.max(hi, p.y - HY);
    }
    lo -= LIMITS.jumpApex;
    hi += LIMITS.jumpApex;
    const floors = this.floorsByColumn();
    const x0 = Math.min(...xs);
    const x1 = Math.max(...xs);
    const z0 = Math.min(...zs);
    const z1 = Math.max(...zs);
    const m = xs.length;
    let hole = 0;
    let insideCount = 0;
    for (let iz = z0; iz <= z1; iz++) {
      for (let ix = x0; ix <= x1; ix++) {
        const col = iz * g.nx + ix;
        if (onPath.has(col)) continue;
        // even-odd rule, ray towards +x (vertices are integer cell indices; the test point is offset by a
        // quarter cell in z so that it never lies on a vertex or a horizontal edge)
        const pz = iz + 0.25;
        let inside = false;
        for (let a = 0, b = m - 1; a < m; b = a++) {
          if (zs[a] > pz !== zs[b] > pz && ix < ((xs[b] - xs[a]) * (pz - zs[a])) / (zs[b] - zs[a]) + xs[a]) inside = !inside;
        }
        if (!inside) continue;
        insideCount++;
        const fl = floors.get(col);
        if (!fl || !fl.some((h) => h >= lo && h <= hi)) hole++;
      }
    }
    return { hole, inside: insideCount };
  }

  /**
   * True when the player can walk straight from a to b: the two resting positions are level (± 0.3 m), the real
   * box sweeps freely and the floor is continuous under the centre line (0.5 m foot, sampled every 0.5 m).
   * The World barrier state must be set by the caller.
   */
  straightWalk(a: V3, b: V3): boolean {
    if (Math.abs(a.y - b.y) > 0.3) return false;
    const p = { x: a.x, y: a.y + 2e-4, z: a.z };
    const q = { x: b.x, y: a.y + 2e-4, z: b.z };
    if (!this.sweepFree(p, q)) return false;
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.max(1, Math.ceil(len / 0.5));
    const probe = { x: 0, y: p.y, z: 0 };
    const foot = { x: 0.5, y: HY, z: 0.5 };
    for (let i = 0; i <= n; i++) {
      probe.x = a.x + ((b.x - a.x) * i) / n;
      probe.z = a.z + ((b.z - a.z) * i) / n;
      if (!(this.world.probeGround(probe, foot, 0.1) <= 0.02)) return false;
    }
    return true;
  }

  // ───────────────────────────── V8 ─────────────────────────────
  checkLoops(): CheckResult {
    const ck = new Check('V8', `Loops: >= ${LIMITS.loops} local circuits (${LIMITS.loopMin}–${LIMITS.loopMax} m) that survive blocking any waypoint`);
    const g = this.grid;
    const loops = this.stage.loops;
    ck.need(loops.length >= LIMITS.loops, `declared loops ${loops.length} >= ${LIMITS.loops}`);
    const cen = (pts: V3[]): V3 => ({ x: pts.reduce((a, p) => a + p.x, 0) / pts.length, y: pts.reduce((a, p) => a + p.y, 0) / pts.length, z: pts.reduce((a, p) => a + p.z, 0) / pts.length });
    let minSep = Infinity;
    for (let i = 0; i < loops.length; i++) for (let j = i + 1; j < loops.length; j++) {
      if (loops[i].points.length && loops[j].points.length) minSep = Math.min(minSep, dist3(cen(loops[i].points), cen(loops[j].points)));
    }
    if (loops.length > 1) ck.need(minSep >= 20, `loops are at different places (closest pair of centroids ${r1(minSep)} m >= 20 m)`);
    const dist = this.localDist();
    const t = this.tgt();
    const mS = this.maskS();
    const info: Array<Record<string, unknown>> = [];
    for (const lp of loops) {
      const bad: string[] = [];
      const n = lp.points.length;
      const cells = lp.points.map((p) => this.cellNear(p));
      let perimeter = 0;
      let hole = 0;
      let enclosed = 0;
      const circuit: number[] = [];
      if (n < 3) bad.push(`only ${n} waypoints (need >= 3)`);
      else if (cells.some((c) => c < 0)) bad.push(`waypoint(s) ${cells.map((c, i) => (c < 0 ? i : -1)).filter((i) => i >= 0).join(', ')} not in a reachable free cell`);
      else if (new Set(cells).size !== n) bad.push('waypoints share a cell');
      else {
        for (let i = 0; i < n; i++) {
          const a = cells[i];
          const b = cells[(i + 1) % n];
          t[b] = 1;
          const r = g.dijkstra(mS, [a], dist, { targets: t, tight: true, maxDist: LIMITS.loopMax + 50, local: true });
          const leg = r.target < 0 ? [] : g.tracePath(dist, b, mS, true);
          g.clearTouched(dist);
          t[b] = 0;
          if (r.target < 0) {
            bad.push(`waypoints ${i} → ${(i + 1) % n} are not connected within ${LIMITS.loopMax + 50} m`);
            perimeter = Infinity;
            break;
          }
          perimeter += r.dist;
          for (let k = 0; k < leg.length - 1; k++) circuit.push(leg[k]);
        }
        if (Number.isFinite(perimeter)) {
          if (perimeter < LIMITS.loopMin || perimeter > LIMITS.loopMax) bad.push(`perimeter ${r1(perimeter)} m outside ${LIMITS.loopMin}–${LIMITS.loopMax} m`);
          for (let i = 0; i < n; i++) {
            const ball = g.ballCells(lp.points[i], LIMITS.loopBall);
            const saved = this.block(mS, ball);
            const others = cells.filter((_, j) => j !== i);
            if (others.some((c) => mS[c] !== 0)) {
              bad.push(`a waypoint lies within ${LIMITS.loopBall} m of waypoint ${i}`);
              this.unblock(mS, ball, saved);
              continue;
            }
            for (let j = 1; j < others.length; j++) t[others[j]] = 1;
            const r = g.dijkstra(mS, [others[0]], dist, { targets: t, targetCount: others.length - 1, tight: true, maxDist: LIMITS.loopMax, local: true });
            g.clearTouched(dist);
            this.unblock(mS, ball, saved);
            for (let j = 1; j < others.length; j++) t[others[j]] = 0;
            if (r.target < 0) bad.push(`blocking ${LIMITS.loopBall} m around waypoint ${i} disconnects the other waypoints (dead-end, not a circuit)`);
          }
          // Structure: the circuit must go AROUND something. (1) The plan polygon traced by the circuit encloses
          // >= loopHole m² of columns on which the player cannot walk at the circuit's level (a solid core, or a
          // void between catwalks), and they are >= loopHoleShare of everything it encloses — an open floor
          // encloses none, a wide round about a crate or a low wall too little. (2) No two non-adjacent waypoints
          // are joined by a straight walk (free sweep over continuous floor).
          const eh = this.enclosedHole(circuit, lp.points);
          hole = eh.hole;
          enclosed = eh.inside;
          if (hole < LIMITS.loopHole) bad.push(`the circuit encloses only ${hole} m² that cannot be walked on at its level (< ${LIMITS.loopHole} m²): it does not go around anything`);
          else if (hole < LIMITS.loopHoleShare * enclosed) bad.push(`only ${Math.round((100 * hole) / enclosed)} % of the ${enclosed} m² the circuit encloses cannot be walked on (< ${LIMITS.loopHoleShare * 100} %): a wide round on open floor, it does not go around anything`);
          this.setWorld([]);
          const open: string[] = [];
          for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
            if (i === 0 && j === n - 1) continue;
            if (this.straightWalk(lp.points[i], lp.points[j])) open.push(`${i}–${j}`);
          }
          this.setWorld(this.closable);
          if (open.length > 0) bad.push(`waypoints ${open.join(', ')} are joined by a straight walk across the inside of the circuit`);
        }
      }
      ck.need(bad.length === 0, `${lp.id}: ${n} waypoints, perimeter ${Number.isFinite(perimeter) ? r1(perimeter) : '∞'} m, encloses ${enclosed} m² of which ${hole} m² (${enclosed > 0 ? Math.round((100 * hole) / enclosed) : 0} %) cannot be walked on at its level${bad.length ? ` — ${bad.join('; ')}` : ''}`);
      info.push({ id: lp.id, waypoints: n, perimeter: Number.isFinite(perimeter) ? perimeter : null, hole, enclosed, problems: bad, note: lp.note });
    }
    ck.data.loops = info;
    return ck.done();
  }

  // ───────────────────────────── V9 ─────────────────────────────
  checkLevels(): CheckResult {
    const ck = new Check('V9', `Levels: >= ${LIMITS.bands} altitude bands >= ${LIMITS.bandGap} m apart with >= ${LIMITS.bandArea} m² each, >= ${LIMITS.stackedArea} m² of stacked floors`);
    const all = new Int32Array(this.standing.length);
    for (let i = 0; i < all.length; i++) all[i] = i;
    const { bands, stacked, keys, bins } = this.levelStats(all);
    ck.need(bands.length >= LIMITS.bands, `altitude bands ${bands.length} >= ${LIMITS.bands} (floor heights ${bands.map((b) => `${b.height} m: ${b.area} m²`).join(', ') || '-'})`);
    ck.need(stacked >= LIMITS.stackedArea, `stacked floor area ${stacked} m² >= ${LIMITS.stackedArea} m² (columns with two major floors >= ${LIMITS.bandGap} m apart)`);
    const hs = keys.map((b) => b / 2);
    ck.line(`standing floor heights from ${hs.length ? hs[0] : '-'} m to ${hs.length ? hs[hs.length - 1] : '-'} m`);
    ck.data.bands = bands;
    ck.data.stackedArea = stacked;
    ck.data.histogram = keys.map((b) => [b / 2, bins.get(b)]);
    return ck.done();
  }

  /** Largest 8-connected main-floor component of a sector: extents (cells = m) and fill of its bounding rectangle. */
  arenaFloor(si: number): { long: number; short: number; fill: number; area: number; height: number; x0: number; x1: number; z0: number; z1: number } {
    const g = this.grid;
    const idxs = this.sectorStanding[si];
    const bins = new Map<number, number>();
    for (const i of idxs) {
      const b = Math.round(this.standH[i] * 2);
      bins.set(b, (bins.get(b) ?? 0) + 1);
    }
    let main = 0;
    let mainN = -1;
    for (const [b, n] of bins) if (n > mainN) {
      mainN = n;
      main = b;
    }
    const cells = new Map<number, boolean>();
    for (const i of idxs) if (Math.round(this.standH[i] * 2) === main) cells.set(this.standing[i] % g.sy, false);
    let best = { long: 0, short: 0, fill: 0, area: 0, height: main / 2, x0: 0, x1: -1, z0: 0, z1: -1 };
    for (const [start, seen] of cells) {
      if (seen) continue;
      cells.set(start, true);
      const stack = [start];
      let n = 0;
      let x0 = Infinity;
      let x1 = -Infinity;
      let z0 = Infinity;
      let z1 = -Infinity;
      while (stack.length) {
        const c = stack.pop()!;
        n++;
        const x = c % g.nx;
        const z = Math.floor(c / g.nx);
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        z0 = Math.min(z0, z);
        z1 = Math.max(z1, z);
        for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
          const nb = c + dx + dz * g.nx;
          if (cells.get(nb) === false) {
            cells.set(nb, true);
            stack.push(nb);
          }
        }
      }
      if (n > best.area) {
        const w = x1 - x0 + 1;
        const d = z1 - z0 + 1;
        best = { long: Math.max(w, d), short: Math.min(w, d), fill: n / (w * d), area: n, height: main / 2, x0, x1, z0, z1 };
      }
    }
    return best;
  }

  // ───────────────────────────── V10 ─────────────────────────────
  checkArenas(): CheckResult {
    const ck = new Check('V10', `Arenas: >= ${LIMITS.arenas} combat sectors whose main floor spans >= ${LIMITS.arenaLong} x ${LIMITS.arenaShort} m with >= ${LIMITS.arenaFill * 100} % fill`);
    const secs = this.stage.sectors;
    let good = 0;
    const info: Array<Record<string, unknown>> = [];
    secs.forEach((s, i) => {
      if (!s.combatArena) return;
      const f = this.arenaFloor(i);
      const ok = f.long >= LIMITS.arenaLong && f.short >= LIMITS.arenaShort && f.fill >= LIMITS.arenaFill;
      if (ok) good++;
      ck.line(`${ok ? 'ok  ' : 'no  '} ${s.id} ${s.nameEn}: main floor y=${f.height} m, ${f.long} x ${f.short} m, fill ${Math.round(f.fill * 100)} %, ${f.area} m²`);
      info.push({ id: s.id, ...f, ok });
    });
    ck.need(good >= LIMITS.arenas, `qualifying arenas ${good} >= ${LIMITS.arenas} (declared combatArena: ${info.length})`);
    ck.data.arenas = info;
    return ck.done();
  }

  // ───────────────────────────── V11 ─────────────────────────────
  checkMultiDirectional(): CheckResult {
    const ck = new Check('V11', `Multi-directional attack: >= ${LIMITS.multiArenas} arenas where >= ${LIMITS.multiFraction * 100} % of the floor is covered by >= ${LIMITS.multiEnemies} enemies spanning >= ${LIMITS.multiSpreadDeg}°`);
    const g = this.grid;
    const w = this.world;
    this.setWorld(this.closable);
    let good = 0;
    const info: Array<Record<string, unknown>> = [];
    const p = { x: 0, y: 0, z: 0 };
    const bearings: number[] = [];
    this.stage.sectors.forEach((s, si) => {
      if (!s.combatArena) return;
      const en = this.stage.enemies.filter((e) => e.sectorId === s.id);
      const idxs = this.sectorStanding[si];
      let covered = 0;
      if (en.length >= LIMITS.multiEnemies) {
        const mz = en.map((e) => ({ x: e.position.x, y: e.position.y + ENEMIES[e.kind].muzzleUp, z: e.position.z }));
        for (const i of idxs) {
          const c = this.standing[i];
          p.x = g.X(g.ix(c));
          p.z = g.Z(g.iz(c));
          p.y = this.standH[i] + HY;
          bearings.length = 0;
          for (let k = 0; k < en.length; k++) {
            if (dist3(en[k].position, p) > ENEMIES[en[k].kind].range) continue;
            if (w.segmentBlocked(mz[k], p)) continue;
            bearings.push(Math.atan2(en[k].position.z - p.z, en[k].position.x - p.x));
          }
          if (bearings.length < LIMITS.multiEnemies) continue;
          bearings.sort((a, b) => a - b);
          let gap = bearings[0] + 2 * Math.PI - bearings[bearings.length - 1];
          for (let k = 1; k < bearings.length; k++) gap = Math.max(gap, bearings[k] - bearings[k - 1]);
          if (((2 * Math.PI - gap) * 180) / Math.PI >= LIMITS.multiSpreadDeg - 1e-9) covered++;
        }
      }
      const frac = idxs.length > 0 ? covered / idxs.length : 0;
      const ok = en.length >= LIMITS.multiEnemies && frac >= LIMITS.multiFraction;
      if (ok) good++;
      ck.line(`${ok ? 'ok  ' : 'no  '} ${s.id} ${s.nameEn}: ${en.length} enemies, ${Math.round(frac * 100)} % of ${idxs.length} m² under fire from >= ${LIMITS.multiEnemies} of them over >= ${LIMITS.multiSpreadDeg}°`);
      info.push({ id: s.id, enemies: en.length, coveredFraction: frac, standingArea: idxs.length, ok });
    });
    ck.need(good >= LIMITS.multiArenas, `arenas with multi-directional fire ${good} >= ${LIMITS.multiArenas}`);
    ck.data.arenas = info;
    return ck.done();
  }

  // ───────────────────────────── V12 ─────────────────────────────
  checkStart(): CheckResult {
    const ck = new Check('V12', `Start: sheltered standing position with a free ${LIMITS.startLane} m quick-boost lane`);
    const g = this.grid;
    const w = this.world;
    const st = this.stage;
    const sp = st.playerStart.position;
    this.setWorld(this.closable);
    ck.need(this.standsAt(sp), `the player start ${fmtV(sp)} is a standing position`);
    const si = this.sectorIndexAt(sp);
    ck.need(si >= 0, `the player start lies in a sector (${si >= 0 ? st.sectors[si].id : 'none'})`);
    const seenBy = new Map<string, V3>();
    if (si >= 0) {
      const offs = [
        [0, 0, 0],
        [0, 1.9, 0],
        [1.25, 1.9, 1.25],
        [-1.25, 1.9, 1.25],
        [1.25, 1.9, -1.25],
        [-1.25, 1.9, -1.25],
      ];
      const p = { x: 0, y: 0, z: 0 };
      for (const e of st.enemies) {
        const spec = ENEMIES[e.kind];
        const mz = { x: e.position.x, y: e.position.y + spec.muzzleUp, z: e.position.z };
        outer: for (const i of this.sectorStanding[si]) {
          const c = this.standing[i];
          const cx = g.X(g.ix(c));
          const cz = g.Z(g.iz(c));
          const cyy = this.standH[i] + HY;
          if (Math.hypot(cx - e.position.x, cyy - e.position.y, cz - e.position.z) > spec.range + 3) continue;
          for (const o of offs) {
            p.x = cx + o[0];
            p.y = cyy + o[1];
            p.z = cz + o[2];
            if (dist3(e.position, p) <= spec.range && !w.segmentBlocked(mz, p)) {
              seenBy.set(e.id, { x: cx, y: cyy, z: cz });
              break outer;
            }
          }
        }
      }
      ck.need(seenBy.size === 0, `no enemy has range + line of sight to any standing cell of the start sector ${st.sectors[si].id} (${this.sectorStanding[si].length} m²)${seenBy.size ? ` — exposed to ${[...seenBy].slice(0, 6).map(([id, q]) => `${id} at ${fmtV(q)}`).join(', ')}` : ''}`);
    }
    // quick-boost lane
    const yaw = st.playerStart.yaw;
    const dir = { x: -Math.sin(yaw), y: 0, z: -Math.cos(yaw) };
    const from = { x: sp.x, y: sp.y + 2e-4, z: sp.z };
    const to = { x: from.x + dir.x * LIMITS.startLane, y: from.y, z: from.z + dir.z * LIMITS.startLane };
    const c = { ...from };
    const res = w.moveBox(c, { x: HX, y: HY, z: HZ }, { x: to.x - from.x, y: 0, z: to.z - from.z });
    const travelled = Math.hypot(c.x - from.x, c.z - from.z);
    let floorOk: number = LIMITS.startLane;
    for (let s = 0; s <= LIMITS.startLane; s += 0.5) {
      const gap = w.probeGround({ x: from.x + dir.x * s, y: from.y, z: from.z + dir.z * s }, { x: HX, y: HY, z: HZ }, 0.1);
      if (!(gap <= 0.02)) {
        floorOk = s;
        break;
      }
    }
    ck.need(res.nx === 0 && res.ny === 0 && res.nz === 0 && travelled >= LIMITS.startLane - 1e-6, `the player box sweeps ${r1(travelled)} m along the start yaw without contact (need ${LIMITS.startLane} m)`);
    ck.need(floorOk >= LIMITS.startLane, `continuous flat floor under the lane for ${r1(floorOk)} m (need ${LIMITS.startLane} m)`);
    ck.data.exposedTo = [...seenBy.keys()];
    ck.data.laneFree = travelled;
    ck.data.laneFloor = floorOk;
    return ck.done();
  }

  // ───────────────────────────── V13 ─────────────────────────────
  checkGeometry(): CheckResult {
    const ck = new Check('V13', 'Geometry sanity: inside bounds, enclosed building, decor outside the player volume, box budget');
    const g = this.grid;
    const st = this.stage;
    const B = st.bounds;
    const outside: string[] = [];
    st.solids.forEach((s, i) => {
      if (!boxInBox(s, B)) outside.push(`solid #${i}${s.tag ? ` (${s.tag})` : ''}`);
    });
    st.decor.forEach((s, i) => {
      if (!boxInBox(s, B)) outside.push(`decor #${i}`);
    });
    for (const s of st.sectors) if (!s.bounds.every((b) => boxInBox(b, B))) outside.push(`sector ${s.id}`);
    for (const e of st.enemies) if (!inBox(e.position, B)) outside.push(`enemy ${e.id}`);
    for (const b of st.barriers) if (!boxInBox(b.box, B)) outside.push(`barrier ${b.id}`);
    if (!boxInBox(st.finalGate.box, B)) outside.push('final gate');
    if (!boxInBox(st.exitZone, B)) outside.push('exit zone');
    if (!inBox(st.playerStart.position, B)) outside.push('player start');
    ck.need(outside.length === 0, `everything lies inside stage.bounds${outside.length ? ` — outside: ${outside.slice(0, 10).join(', ')}${outside.length > 10 ? ` … +${outside.length - 10}` : ''}` : ''}`);
    const degenerate = st.solids.filter((s) => !(s.max.x > s.min.x && s.max.y > s.min.y && s.max.z > s.min.z)).length + st.decor.filter((s) => !(s.max.x > s.min.x && s.max.y > s.min.y && s.max.z > s.min.z)).length;
    ck.need(degenerate === 0, `no degenerate (empty or inverted) boxes (${degenerate})`);
    ck.need(st.solids.length <= LIMITS.maxSolids, `solids ${st.solids.length} <= ${LIMITS.maxSolids}`);
    ck.need(st.decor.length <= LIMITS.maxDecor, `decor ${st.decor.length} <= ${LIMITS.maxDecor}`);
    // enclosure: the LOOSE reachable region must not touch the outermost layer of the grid
    let leaks = 0;
    let first = -1;
    const RL = this.RL;
    const test = (c: number): void => {
      if (RL[c] !== 0) {
        leaks++;
        if (first < 0) first = c;
      }
    };
    for (let iz = PADX; iz < g.nz - PADX; iz++) for (let ix = PADX; ix < g.nx - PADX; ix++) {
      test(g.idx(ix, PADY, iz));
      test(g.idx(ix, g.ny - PADY - 1, iz));
    }
    for (let iy = PADY; iy < g.ny - PADY; iy++) {
      for (let ix = PADX; ix < g.nx - PADX; ix++) {
        test(g.idx(ix, iy, PADX));
        test(g.idx(ix, iy, g.nz - PADX - 1));
      }
      for (let iz = PADX; iz < g.nz - PADX; iz++) {
        test(g.idx(PADX, iy, iz));
        test(g.idx(g.nx - PADX - 1, iy, iz));
      }
    }
    ck.need(leaks === 0, `the reachable region is enclosed (boundary-layer cells reached: ${leaks}${first >= 0 ? `, e.g. at ${fmtV(g.center(first))}` : ''})`);
    if (g.clipped) ck.line(`note: stage.bounds is larger than the built geometry; the grid covers ${fmtV(g.extent.min)} … ${fmtV(g.extent.max)}`);
    ck.line(`reachable volume: ${Math.round(this.countRS * g.cy)} m³ strict / ${Math.round(this.countRL * g.cy)} m³ loose`);
    // decor must stay out of the volume the player's box can occupy
    this.setWorld([]);
    const RS = this.RS;
    const intr: string[] = [];
    const loose: string[] = [];
    let thinInside = 0;
    const down = { x: 0, y: -1, z: 0 };
    st.decor.forEach((d, i) => {
      const [x0i, x1i] = openRange(d.min.x - HX, d.max.x + HX, g.x0 + 0.5, 1, g.nx);
      const [y0i, y1i] = openRange(d.min.y - HY, d.max.y + HY, g.y0, g.cy, g.ny);
      const [z0i, z1i] = openRange(d.min.z - HZ, d.max.z + HZ, g.z0 + 0.5, 1, g.nz);
      let hit = -1;
      for (let iy = y0i; iy <= y1i && hit < 0; iy++) for (let iz = z0i; iz <= z1i && hit < 0; iz++) for (let ix = x0i; ix <= x1i; ix++) {
        if (RS[g.idx(ix, iy, iz)] !== 0) {
          hit = g.idx(ix, iy, iz);
          break;
        }
      }
      if (hit < 0) return;
      const thin = Math.min(d.max.x - d.min.x, d.max.y - d.min.y, d.max.z - d.min.z) < 0.25;
      if (thin) {
        const o = { x: (d.min.x + d.max.x) / 2, y: d.min.y, z: (d.min.z + d.max.z) / 2 };
        const h = this.world.raycast(o, down, 400);
        if (!h || h.dist > 5) {
          // allowed only when mounted: hanging at most 4.5 m below the ceiling (lamps, beacons) or clamped to a
          // wall (a solid within 0.35 m of its centre line) — never a cable across open flight space
          thinInside++;
          const top = { x: o.x, y: d.max.y - 1e-3, z: o.z };
          const up = this.world.raycast(top, { x: 0, y: 1, z: 0 }, 400);
          const hung = !!up && up.dist + (d.max.y - d.min.y) <= 4.5 + 1e-6;
          let walled = false;
          if (!hung) {
            const c = { x: o.x, y: (d.min.y + d.max.y) / 2, z: o.z };
            for (const [dx, dz, half] of [[1, 0, (d.max.x - d.min.x) / 2], [-1, 0, (d.max.x - d.min.x) / 2], [0, 1, (d.max.z - d.min.z) / 2], [0, -1, (d.max.z - d.min.z) / 2]] as const) {
              const hit = this.world.raycast(c, { x: dx, y: 0, z: dz }, half + 0.35);
              if (hit) walled = true;
            }
          }
          if (hung || walled) return;
          loose.push(`decor #${i} ${fmtV(d.min)}–${fmtV(d.max)}`);
          return;
        }
      }
      intr.push(`decor #${i} ${fmtV(d.min)}–${fmtV(d.max)}`);
    });
    ck.need(intr.length === 0, `decor does not intrude into the player's volume (${intr.length} offending${intr.length ? `: ${intr.slice(0, 5).join('; ')}` : ''})`);
    ck.need(loose.length === 0, `thin decor inside the player's volume (${thinInside} lamps / cables / plates, all thinner than 0.25 m and > 5 m above the floor) is mounted: <= 4.5 m below a ceiling or clamped to a wall (${loose.length} free-hanging${loose.length ? `: ${loose.slice(0, 5).join('; ')}` : ''})`);
    // Coplanar faces: two solids whose faces lie in the same plane, face the same way and overlap flicker when
    // drawn (z-fighting) unless the shared patch is covered by a third solid.
    const zf = this.coplanarFaces();
    ck.need(zf.length === 0, `no visible coplanar overlapping faces between solids (${zf.length}${zf.length ? `: ${zf.slice(0, 6).join('; ')}` : ''})`);
    ck.data.coplanarFaces = zf.length;
    ck.data.thinDecorInside = thinInside;
    this.setWorld(this.closable);
    ck.data.outside = outside;
    ck.data.leakCells = leaks;
    ck.data.decorIntrusions = intr.length;
    return ck.done();
  }

  /**
   * Pairs of solids with coplanar, same-facing, overlapping faces of which a part is exposed (not covered by a
   * third solid just outside the plane). Barriers and the gate are tested against the solids as well.
   */
  coplanarFaces(): string[] {
    const st = this.stage;
    const boxes: Array<{ b: Box; name: string }> = st.solids.map((s, i) => ({ b: s, name: `#${i}${s.tag ? ` ${s.tag}` : ''}` }));
    for (const br of st.barriers) boxes.push({ b: br.box, name: br.id });
    boxes.push({ b: st.finalGate.box, name: st.finalGate.id });
    const order = boxes.map((_, i) => i).sort((a, b) => boxes[a].b.min.x - boxes[b].b.min.x);
    const out: string[] = [];
    const axes = ['x', 'y', 'z'] as const;
    const tiny = { x: 0.005, y: 0.005, z: 0.005 };
    const w = new World(st); // every barrier closed
    const covered = (p: V3): boolean => w.overlapsBox(p, tiny);
    for (let oi = 0; oi < order.length; oi++) {
      const A = boxes[order[oi]];
      for (let oj = oi + 1; oj < order.length; oj++) {
        const B = boxes[order[oj]];
        if (B.b.min.x > A.b.max.x + 1e-6) break;
        const a = A.b;
        const b = B.b;
        if (a.min.y > b.max.y + 1e-6 || b.min.y > a.max.y + 1e-6 || a.min.z > b.max.z + 1e-6 || b.min.z > a.max.z + 1e-6) continue;
        let found = false;
        for (let k = 0; k < 3 && !found; k++) {
          const u = axes[(k + 1) % 3];
          const v = axes[(k + 2) % 3];
          const n = axes[k];
          const u0 = Math.max(a.min[u], b.min[u]);
          const u1 = Math.min(a.max[u], b.max[u]);
          const v0 = Math.max(a.min[v], b.min[v]);
          const v1 = Math.min(a.max[v], b.max[v]);
          if (u1 - u0 < 0.05 || v1 - v0 < 0.05) continue;
          for (const side of ['min', 'max'] as const) {
            if (Math.abs(a[side][n] - b[side][n]) > 1e-6) continue;
            // the shared patch is visible when some sample just outside the plane is in free space
            const off = side === 'max' ? 0.02 : -0.02;
            let visible = false;
            for (const fu of [0.5, 0.1, 0.9]) {
              for (const fv of [0.5, 0.1, 0.9]) {
                const p = { x: 0, y: 0, z: 0 };
                p[n] = a[side][n] + off;
                p[u] = u0 + (u1 - u0) * fu;
                p[v] = v0 + (v1 - v0) * fv;
                if (!covered(p)) visible = true;
              }
            }
            if (visible) {
              out.push(`${A.name} / ${B.name} at ${n} = ${r2(a[side][n])} (${r1((u1 - u0) * (v1 - v0))} m²)`);
              found = true;
              break;
            }
          }
        }
      }
    }
    return out;
  }

  /** Free-flight polyline from → to (string-pulled with real sweeps; `closed` barriers are solid), or null. */
  flightPlan(from: V3, to: V3, closed: string[] = []): V3[] | null {
    const g = this.grid;
    const a = this.cellNear(from);
    const b = this.cellNear(to);
    if (a < 0 || b < 0) return null;
    const t = this.tgt();
    const m = this.maskS(closed);
    if (m[a] !== 0 || m[b] !== 0) return null;
    const dist = this.localDist();
    t[b] = 1;
    const r = g.dijkstra(m, [a], dist, { targets: t, tight: true, maxDist: 400, local: true });
    t[b] = 0;
    const path = r.target < 0 ? null : g.tracePath(dist, b, m, true);
    g.clearTouched(dist);
    if (!path) return null;
    this.setWorld(closed);
    const pulled = this.stringPull([{ ...from }, ...path.map((c) => g.center(c)), { ...to }]);
    this.setWorld(this.closable);
    return pulled.valid ? pulled.points : null;
  }

  /**
   * Walkable polyline from → to on ONE floor level (both are resting positions of the player box at the same
   * height ± 0.3 m): shortest 8-connected path (no corner cutting) through the STRICT standing cells of that
   * level, preferring cells that are not next to a drop, pulled tight with segments along which a box 0.15 m
   * wider than the player's sweeps freely and whose centre line is supported all the way. `closed` barriers
   * are solid. Null when the two points are not connected on that level.
   */
  groundPlan(from: V3, to: V3, closed: string[] = []): V3[] | null {
    const g = this.grid;
    const iy = g.iyOf(from.y);
    if (Math.abs(g.Y(iy) - from.y) > 0.2 || Math.abs(to.y - from.y) > 0.3) return null;
    const m = this.maskS(closed);
    const { nx, nz, sy } = g;
    const base = iy * sy;
    const S = g.baseS;
    const stand = (col: number): boolean => m[base + col] === 0 && S[base + col - sy] === 1;
    const drop = (col: number): boolean => m[base + col] === 0 && S[base + col - sy] !== 1;
    const safe = (col: number): boolean => stand(col) && !drop(col + 1) && !drop(col - 1) && !drop(col + nx) && !drop(col - nx);
    const nearest = (p: V3): number => {
      const ix = g.ixOf(p.x);
      const iz = g.izOf(p.z);
      let best = -1;
      let bestD = Infinity;
      for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
        const x = ix + dx;
        const z = iz + dz;
        if (x < 1 || z < 1 || x >= nx - 1 || z >= nz - 1) continue;
        const col = z * nx + x;
        if (!stand(col)) continue;
        const d = Math.hypot(g.X(x) - p.x, g.Z(z) - p.z);
        if (d < bestD) {
          bestD = d;
          best = col;
        }
      }
      return best;
    };
    const a = nearest(from);
    const b = nearest(to);
    if (a < 0 || b < 0) return null;
    const ncol = nx * nz;
    const dist = new Float32Array(ncol);
    const prev = new Int32Array(ncol);
    const DX = [1, -1, 0, 0, 1, 1, -1, -1];
    const DZ = [0, 0, 1, -1, 1, -1, 1, -1];
    let cells: number[] | null = null;
    for (const pred of [safe, stand]) {
      const ok = (col: number): boolean => col === a || col === b || pred(col);
      dist.fill(Infinity);
      prev.fill(-1);
      // binary heap of (f, col) pairs, A* with the straight-line heuristic
      const hf: number[] = [];
      const hc: number[] = [];
      const bx = b % nx;
      const bz = Math.floor(b / nx);
      const push = (f: number, c: number): void => {
        let i = hf.length;
        hf.push(f);
        hc.push(c);
        while (i > 0) {
          const q = (i - 1) >> 1;
          if (hf[q] <= f) break;
          hf[i] = hf[q];
          hc[i] = hc[q];
          i = q;
        }
        hf[i] = f;
        hc[i] = c;
      };
      const pop = (): number => {
        const top = hc[0];
        const f = hf.pop()!;
        const c = hc.pop()!;
        const n = hf.length;
        if (n > 0) {
          let i = 0;
          for (;;) {
            let ch = 2 * i + 1;
            if (ch >= n) break;
            if (ch + 1 < n && hf[ch + 1] < hf[ch]) ch++;
            if (hf[ch] >= f) break;
            hf[i] = hf[ch];
            hc[i] = hc[ch];
            i = ch;
          }
          hf[i] = f;
          hc[i] = c;
        }
        return top;
      };
      dist[a] = 0;
      push(0, a);
      let found = false;
      while (hf.length > 0) {
        const c = pop();
        if (c === b) {
          found = true;
          break;
        }
        const cx = c % nx;
        const cz = Math.floor(c / nx);
        const d = dist[c];
        for (let k = 0; k < 8; k++) {
          const x = cx + DX[k];
          const z = cz + DZ[k];
          if (x < 1 || z < 1 || x >= nx - 1 || z >= nz - 1) continue;
          const nb = z * nx + x;
          if (!ok(nb)) continue;
          if (k >= 4 && !(ok(cz * nx + x) && ok(z * nx + cx))) continue;
          const nd = d + (k >= 4 ? Math.SQRT2 : 1);
          if (nd < dist[nb] - 1e-4) {
            dist[nb] = nd;
            prev[nb] = c;
            push(nd + Math.hypot(x - bx, z - bz), nb);
          }
        }
      }
      if (found) {
        cells = [];
        for (let c = b; c >= 0; c = prev[c]) cells.push(c);
        cells.reverse();
        break;
      }
    }
    if (!cells) return null;
    const y = from.y;
    const pts: V3[] = [{ x: from.x, y, z: from.z }, ...cells.map((c) => ({ x: g.X(c % nx), y, z: g.Z(Math.floor(c / nx)) })), { x: to.x, y, z: to.z }];
    this.setWorld(closed);
    const w = this.world;
    const probe = { x: 0, y: y + 2e-4, z: 0 };
    const foot = { x: 0.3, y: HY, z: 0.3 };
    // Shortcuts are only taken where a box 0.15 m wider on every side still passes (the bot does not track a
    // line to the millimetre); the cell-centre path itself always remains as the fallback.
    const fat = { x: HX + 0.15, y: HY - 1e-4, z: HZ + 0.15 };
    const walkFree = (p: V3, q: V3): boolean => {
      const c = { x: p.x, y: p.y, z: p.z };
      if (w.overlapsBox(c, fat)) return false;
      const res = w.moveBox(c, fat, { x: q.x - p.x, y: 0, z: q.z - p.z });
      if (res.nx !== 0 || res.ny !== 0 || res.nz !== 0 || dist3(c, q) > 1e-6) return false;
      const len = Math.hypot(q.x - p.x, q.z - p.z);
      const n = Math.max(1, Math.ceil(len / 0.5));
      for (let i = 0; i <= n; i++) {
        probe.x = p.x + ((q.x - p.x) * i) / n;
        probe.z = p.z + ((q.z - p.z) * i) / n;
        if (!(w.probeGround(probe, foot, 0.1) <= 0.02)) return false;
      }
      return true;
    };
    const pulled = this.stringPull(pts, walkFree);
    this.setWorld(this.closable);
    return pulled.points;
  }

  // ───────────────────────────── V6d ─────────────────────────────
  checkFlightSim(): CheckResult {
    const ck = new Check('V6d', 'Flight feasibility simulated with the real Sim: all 6 generator x legs combinations (weakest: recovery EN 90 + quadruped)');
    if (this.opts.flightSim === false) {
      ck.skipped = true;
      ck.line('NOT RUN: disabled by option');
      return ck.done();
    }
    const ps = playerMovementStatus();
    if (ps.state === 'error') {
      ck.fail(`the simulation threw while probing player movement: ${ps.message}`);
      return ck.done();
    }
    if (ps.state === 'stub') {
      ck.skipped = true;
      ck.line(`NOT RUN: src/sim/player.ts is still a stub (${ps.message}) — flight feasibility is NOT verified`);
      return ck.done();
    }
    const info: Array<Record<string, unknown>> = [];
    for (const s of this.stage.flightSpots) {
      const plan = this.flightPlan(s.from, s.to);
      const runs: Array<Record<string, unknown>> = [];
      const failed: string[] = [];
      let weakest: FlightSimResult | null = null;
      let standard: FlightSimResult | null = null;
      let worstShare = 0;
      for (const lo of MOVEMENT_LOADOUTS) {
        const res = simulateFlightSpot(this.stage, s, plan ?? undefined, lo);
        const maxEn = GENERATOR_PARTS[lo.generator].maxEn;
        runs.push({ generator: lo.generator, legs: lo.legs, maxEn, ...res });
        if (!res.ok) failed.push(`${lo.generator}+${lo.legs}: ${res.reason}`);
        else worstShare = Math.max(worstShare, res.enUsed / maxEn);
        if (lo.generator === WEAKEST_LOADOUT.generator && lo.legs === WEAKEST_LOADOUT.legs) weakest = res;
        if (lo.generator === DEFAULT_LOADOUT.generator && lo.legs === DEFAULT_LOADOUT.legs) standard = res;
      }
      const d = (r: FlightSimResult | null, maxEn: number): string => (r && r.ok ? `EN ${r1(r.enUsed)}/${maxEn} in ${r2(r.seconds)} s` : `FAILED (${r ? r.reason : 'not run'})`);
      ck.need(
        failed.length === 0,
        `${s.id}: weakest (recovery + quadruped) ${d(weakest, GENERATOR_PARTS.recovery.maxEn)}, landed at ${weakest ? fmtV(weakest.landed) : '-'} · default (balanced + biped) ${d(standard, GENERATOR_PARTS.balanced.maxEn)} · ${MOVEMENT_LOADOUTS.length - failed.length}/${MOVEMENT_LOADOUTS.length} combinations land, worst EN share ${Math.round(worstShare * 100)} %${failed.length ? ` — ${failed.join('; ')}` : ''}`,
      );
      info.push({ id: s.id, ...(weakest ?? {}), planned: !!plan, runs });
    }
    if (this.stage.flightSpots.length === 0) ck.fail('no flight spots declared');
    ck.data.spots = info;
    return ck.done();
  }

  /**
   * The path the documentation promises between two consecutive route waypoints: straight when they are level
   * (± 0.3 m); for a climb straight up at the lower end to 0.25 m above the landing, level to above the landing
   * and down onto it; for a drop level at the upper height to above the lower waypoint and straight down.
   */
  segmentPath(a: V3, b: V3): V3[] {
    if (Math.abs(a.y - b.y) <= 0.3) return [a, b];
    if (b.y > a.y) return [a, { x: a.x, y: b.y + 0.25, z: a.z }, { x: b.x, y: b.y + 0.25, z: b.z }, b];
    return [a, { x: b.x, y: a.y, z: b.z }, b];
  }

  /** Checks that every segment of a route can be followed as drawn (see segmentPath). All barriers open. */
  routeSegmentProblems(route: StageDef['route']): { level: number; climbs: number; drops: number; problems: string[] } {
    const out = { level: 0, climbs: 0, drops: 0, problems: [] as string[] };
    this.setWorld([]);
    for (let i = 1; i < route.length; i++) {
      const a = route[i - 1].position;
      const b = route[i].position;
      const name = `#${i - 1} ${fmtV(a)} → #${i} ${fmtV(b)}`;
      if (Math.abs(a.y - b.y) <= 0.3) {
        out.level++;
        if (!this.straightWalk(a, b)) out.problems.push(`${name}: not a straight walk (${this.sweepFree({ x: a.x, y: a.y + 2e-4, z: a.z }, { x: b.x, y: a.y + 2e-4, z: b.z }) ? 'no continuous floor' : 'blocked'})`);
        continue;
      }
      if (b.y > a.y) out.climbs++;
      else out.drops++;
      const path = this.segmentPath({ x: a.x, y: a.y + 2e-4, z: a.z }, { x: b.x, y: b.y + 2e-4, z: b.z });
      for (let k = 1; k < path.length; k++) {
        if (!this.sweepFree(path[k - 1], path[k])) {
          out.problems.push(`${name}: ${b.y > a.y ? 'climb' : 'drop'} blocked between ${fmtV(path[k - 1])} and ${fmtV(path[k])}`);
          break;
        }
      }
    }
    this.setWorld(this.closable);
    return out;
  }

  /**
   * Designer's helper (validateStage.ts --refine-route): for every pair of consecutive key waypoints that are
   * level but not joined by a straight walk, the corner points of a walkable ground path between them (every
   * resulting segment verified with straightWalk). Returns the table keyed "x,y,z>x,y,z" that
   * src/stage/route.ts stores as ROUTE_VIAS, and the pairs that could not be resolved.
   */
  refineRoute(keys: Array<{ position: V3 }>): { vias: Record<string, Array<[number, number, number]>>; problems: string[] } {
    const vias: Record<string, Array<[number, number, number]>> = {};
    const problems: string[] = [];
    const k3 = (p: V3): string => `${p.x},${p.y},${p.z}`;
    for (let i = 1; i < keys.length; i++) {
      const a = keys[i - 1].position;
      const b = keys[i].position;
      const name = `${fmtV(a)} → ${fmtV(b)}`;
      if (Math.abs(a.y - b.y) > 0.3) {
        this.setWorld([]);
        const path = this.segmentPath({ x: a.x, y: a.y + 2e-4, z: a.z }, { x: b.x, y: b.y + 2e-4, z: b.z });
        for (let k = 1; k < path.length; k++) {
          if (!this.sweepFree(path[k - 1], path[k])) {
            problems.push(`${name}: ${b.y > a.y ? 'climb' : 'drop'} elbow blocked between ${fmtV(path[k - 1])} and ${fmtV(path[k])}`);
            break;
          }
        }
        this.setWorld(this.closable);
        continue;
      }
      this.setWorld([]);
      const direct = this.straightWalk(a, b);
      this.setWorld(this.closable);
      if (direct) continue;
      const plan = this.groundPlan(a, b, []);
      if (!plan) {
        problems.push(`${name}: no walkable ground path on this level`);
        continue;
      }
      // drop corner points that are not needed (straightWalk is stricter than the planner's own test, so only
      // shortcuts that pass it are taken)
      this.setWorld([]);
      const pts = plan.map((q) => ({ x: q.x, y: a.y, z: q.z }));
      const out: V3[] = [pts[0]];
      let at = 0;
      while (at < pts.length - 1) {
        let next = at + 1;
        for (let j = pts.length - 1; j > at + 1; j--) {
          if (this.straightWalk(pts[at], pts[j])) {
            next = j;
            break;
          }
        }
        if (!this.straightWalk(pts[at], pts[next])) problems.push(`${name}: the planned step ${fmtV(pts[at])} → ${fmtV(pts[next])} is not a straight walk`);
        out.push(pts[next]);
        at = next;
      }
      this.setWorld(this.closable);
      const mid = out.slice(1, -1);
      if (mid.length > 0) vias[`${k3(a)}>${k3(b)}`] = mid.map((q) => [r2(q.x), r2(q.y), r2(q.z)]);
    }
    return { vias, problems };
  }

  // ───────────────────────────── V15 ─────────────────────────────
  checkRouteDefence(): CheckResult {
    const ck = new Check('V15', `Route defence: no stretch of the recommended route longer than ${LIMITS.routeGap} m without an enemy firing line, >= ${LIMITS.routeCovered * 100} % of it under fire`);
    const st = this.stage;
    const w = this.world;
    if (st.route.length < 2) {
      ck.fail('stage.route has fewer than 2 waypoints');
      return ck.done();
    }
    // samples every metre along the route as drawn (level segments straight, climbs / drops as elbows)
    const pts: V3[] = [];
    let carry = 0;
    for (let i = 1; i < st.route.length; i++) {
      const path = this.segmentPath(st.route[i - 1].position, st.route[i].position);
      for (let k = 1; k < path.length; k++) {
        const a = path[k - 1];
        const b = path[k];
        const l = dist3(a, b);
        let t = carry;
        for (; t <= l; t += 1) pts.push({ x: a.x + ((b.x - a.x) * t) / Math.max(l, 1e-9), y: a.y + ((b.y - a.y) * t) / Math.max(l, 1e-9), z: a.z + ((b.z - a.z) * t) / Math.max(l, 1e-9) });
        carry = t - l;
      }
    }
    this.setWorld([]);
    const n = pts.length;
    const counts = new Int16Array(n);
    const sector = pts.map((p) => this.sectorIndexAt(p));
    const seenIn: Array<Set<string>> = st.sectors.map(() => new Set<string>());
    const never: string[] = [];
    for (const e of st.enemies) {
      const spec = ENEMIES[e.kind];
      const mz = { x: e.position.x, y: e.position.y + spec.muzzleUp, z: e.position.z };
      let any = false;
      for (let i = 0; i < n; i++) {
        if (dist3(e.position, pts[i]) > spec.range) continue;
        if (w.segmentBlocked(mz, pts[i])) continue;
        counts[i]++;
        any = true;
        if (sector[i] >= 0) seenIn[sector[i]].add(e.id);
      }
      if (!any) never.push(e.id);
    }
    this.setWorld(this.closable);
    const startSi = this.sectorIndexAt(st.playerStart.position);
    // gaps: runs of samples without any firing line, outside the start sector
    const gaps: Array<{ from: number; length: number; sectors: string[] }> = [];
    let total = 0;
    let covered = 0;
    let two = 0;
    let four = 0;
    let most = 0;
    let run = 0;
    let runStart = 0;
    const flush = (end: number): void => {
      if (run >= 20) {
        const ids: string[] = [];
        for (let k = runStart; k < end; k++) {
          const id = sector[k] >= 0 ? st.sectors[sector[k]].id : '?';
          if (ids[ids.length - 1] !== id) ids.push(id);
        }
        gaps.push({ from: runStart, length: run, sectors: ids });
      }
      run = 0;
    };
    for (let i = 0; i < n; i++) {
      if (sector[i] === startSi) {
        flush(i);
        continue;
      }
      total++;
      if (counts[i] > 0) {
        covered++;
        flush(i);
      } else {
        if (run === 0) runStart = i;
        run++;
      }
      if (counts[i] >= 2) two++;
      if (counts[i] >= 4) four++;
      if (counts[i] > most) most = counts[i];
    }
    flush(n);
    gaps.sort((a, b) => b.length - a.length);
    const longest = gaps.length > 0 ? gaps[0].length : 0;
    // per sector
    const rows: Array<{ id: string; length: number; uncovered: number; assigned: number; seeing: number; ids: string[] }> = [];
    st.sectors.forEach((s, si) => {
      let l = 0;
      let u = 0;
      for (let i = 0; i < n; i++) {
        if (sector[i] !== si) continue;
        l++;
        if (counts[i] === 0) u++;
      }
      if (l > 0) rows.push({ id: s.id, length: l, uncovered: u, assigned: st.enemies.filter((e) => e.sectorId === s.id).length, seeing: seenIn[si].size, ids: [...seenIn[si]].sort() });
    });
    const share = total > 0 ? covered / total : 0;
    ck.need(longest <= LIMITS.routeGap, `longest stretch without any enemy firing line (outside the start sector) ${longest} m <= ${LIMITS.routeGap} m${gaps.length ? ` — stretches >= 20 m: ${gaps.slice(0, 8).map((q) => `${q.length} m in ${q.sectors.join('/')}`).join(', ')}` : ''}`);
    ck.need(share >= LIMITS.routeCovered, `${Math.round(share * 100)} % of the route outside the start sector (${covered} of ${total} m) lies under at least one firing line (need >= ${LIMITS.routeCovered * 100} %)`);
    const quiet = rows.filter((r) => st.sectors.findIndex((s) => s.id === r.id) !== startSi && r.seeing === 0).map((r) => r.id);
    ck.need(quiet.length === 0, `every sector on the route (except the start sector) has an enemy with a firing line onto the route${quiet.length ? ` — none in ${quiet.join(', ')}` : ''}`);
    ck.line(`route sampled every metre as drawn: ${n} m; under >= 2 firing lines ${Math.round((100 * two) / Math.max(1, total))} %, >= 4 ${Math.round((100 * four) / Math.max(1, total))} %, most at one point ${most}`);
    ck.line(`per sector (route m / m without a firing line / enemies stationed / enemies with a line onto the route there): ${rows.map((r) => `${r.id} ${r.length}/${r.uncovered}/${r.assigned}/${r.seeing}`).join(' · ')}`);
    if (never.length) ck.line(`enemies without a firing line onto the route from their initial position: ${never.join(' ')}`);
    ck.data.samples = n;
    ck.data.longestGap = longest;
    ck.data.gaps = gaps.map((q) => ({ length: q.length, sectors: q.sectors, at: pts[q.from] }));
    ck.data.coveredShare = share;
    ck.data.share2 = total > 0 ? two / total : 0;
    ck.data.share4 = total > 0 ? four / total : 0;
    ck.data.maxSimultaneous = most;
    ck.data.sectors = rows;
    ck.data.neverSeeRoute = never;
    return ck.done();
  }

  // ───────────────────────────── V14 ─────────────────────────────
  checkWalkthrough(): CheckResult {
    const ck = new Check('V14', 'Walkthrough: the recommended route is played to the exit by the real Sim (weakest and default loadout)');
    const st = this.stage;
    // documentation consistency of the route
    const wrong: string[] = [];
    st.route.forEach((w, i) => {
      const si = this.sectorIndexAt(w.position);
      const id = si >= 0 ? st.sectors[si].id : 'none';
      if (id !== w.sectorId) wrong.push(`#${i} ${fmtV(w.position)} is in ${id}, declared ${w.sectorId}`);
      else if (!this.standsAt(w.position)) wrong.push(`#${i} ${fmtV(w.position)} is not a standing position`);
    });
    ck.need(st.route.length >= 2 && wrong.length === 0, `the ${st.route.length} route waypoints are standing positions inside their declared sectors${wrong.length ? ` — ${wrong.slice(0, 6).join('; ')}` : ''}`);
    let len = 0;
    for (let i = 1; i < st.route.length; i++) len += dist3(st.route[i - 1].position, st.route[i].position);
    ck.line(`polyline length of the recommended route: ${r1(len)} m`);
    ck.data.routePolyline = len;
    // The recorded coordinates must be followable exactly as drawn (all barriers open): a level segment is a
    // straight walk (free sweep of the real box over continuous floor), a climb rises at its lower end and then
    // flies level to the landing, a drop walks level off the edge and falls at its far end.
    const drawn = this.routeSegmentProblems(st.route);
    ck.need(drawn.problems.length === 0, `every segment of the recorded route can be followed as drawn: ${drawn.level} level segments walk straight over continuous floor, ${drawn.climbs} climbs and ${drawn.drops} drops are collision-free elbows${drawn.problems.length ? ` — ${drawn.problems.slice(0, 8).join('; ')}${drawn.problems.length > 8 ? ` … +${drawn.problems.length - 8}` : ''}` : ''}`);
    ck.data.routeSegments = drawn;
    if (this.opts.flightSim === false) {
      ck.skipped = true;
      ck.line('NOT RUN: simulation disabled by option');
      return ck.done();
    }
    const ps = playerMovementStatus();
    if (ps.state === 'error') {
      ck.fail(`the simulation threw while probing player movement: ${ps.message}`);
      return ck.done();
    }
    if (ps.state === 'stub') {
      ck.skipped = true;
      ck.line(`NOT RUN: src/sim/player.ts is still a stub (${ps.message}) — the walkthrough is NOT verified`);
      return ck.done();
    }
    const runs: Array<Record<string, unknown>> = [];
    const order = st.barriers.map((b) => b.controlEnemyId).join(' → ');
    const plays: Array<{ name: string; loadout: Loadout; route: StageDef['route']; main: boolean }> = [
      { name: 'weakest (recovery + quadruped)', loadout: WEAKEST_LOADOUT, route: st.route, main: true },
      { name: 'default (balanced + biped)', loadout: DEFAULT_LOADOUT, route: st.route, main: true },
    ];
    for (const x of this.opts.extraRoutes ?? []) {
      const bad: string[] = [];
      x.route.forEach((w, i) => {
        const si = this.sectorIndexAt(w.position);
        const id = si >= 0 ? st.sectors[si].id : 'none';
        if (id !== w.sectorId) bad.push(`#${i} ${fmtV(w.position)} is in ${id}, declared ${w.sectorId}`);
        else if (!this.standsAt(w.position)) bad.push(`#${i} ${fmtV(w.position)} is not a standing position`);
      });
      ck.need(bad.length === 0, `route "${x.name}": its ${x.route.length} waypoints are standing positions inside their declared sectors${bad.length ? ` — ${bad.slice(0, 6).join('; ')}` : ''}`);
      const xd = this.routeSegmentProblems(x.route);
      ck.need(xd.problems.length === 0, `route "${x.name}": every segment can be followed as drawn (${xd.level} level, ${xd.climbs} climbs, ${xd.drops} drops)${xd.problems.length ? ` — ${xd.problems.slice(0, 8).join('; ')}${xd.problems.length > 8 ? ` … +${xd.problems.length - 8}` : ''}` : ''}`);
      plays.push({ name: `${x.name}, weakest loadout`, loadout: WEAKEST_LOADOUT, route: x.route, main: false });
    }
    for (const { name, loadout: lo, route, main } of plays) {
      const r = runWalkthrough(this, lo, 1800, route);
      const got = r.controls.map((c) => c.id).join(' → ');
      ck.need(
        r.ok,
        `${name}: ${r.ok ? `cleared in ${r1(r.seconds)} s of simulated time, ${r1(r.distance)} m travelled, ${r.waypointsReached}/${r.waypoints} waypoints, ${r.flights} flights (max ${r1(r.maxFlightEn)} EN, total ${r1(r.flightEn)} EN), lowest EN ${r1(r.minEn)}, ${r1(r.enWaitSeconds)} s waiting for EN, ${r.replans} re-plans, ${r.visitedSectors.length} sectors entered` : r.reason}`,
      );
      if (r.ok) {
        ck.need(got === order, `${name}: control turrets destroyed in barrier order (${got})`);
        const missed = r.arrivals.map((t, i) => (Number.isNaN(t) ? i : -1)).filter((i) => i >= 0);
        ck.need(missed.length === 0, `${name}: every route waypoint reached in order${missed.length ? ` — missed ${missed.join(', ')}` : ''}`);
        ck.need(r.visitedSectors.length >= LIMITS.mandatorySectors, `${name}: sectors entered ${r.visitedSectors.length} >= ${LIMITS.mandatorySectors} (${r.visitedSectors.join(' ')})`);
        ck.need(r.distance >= LIMITS.routeMin, `${name}: distance travelled ${r1(r.distance)} m >= ${LIMITS.routeMin} m`);
      }
      runs.push({ name, main, routeWaypoints: route.length, ...r, path: r.path.length > 4000 ? r.path.filter((_, i) => i % 2 === 0) : r.path });
    }
    const first = runs[0] as unknown as WalkthroughResult | undefined;
    if (first && first.controls) {
      for (const c of first.controls) ck.line(`    ${c.id} (${c.barrierId}) destroyed at t = ${r1(c.time)} s from ${fmtV(c.from)}, ${r1(c.dist)} m away, on the way to waypoint #${c.waypoint}`);
    }
    ck.data.runs = runs;
    return ck.done();
  }

  // ───────────────────────────── V16 ─────────────────────────────
  checkCombat(): CheckResult {
    const ck = new Check('V16', 'Combat walkthrough: a plain fighting bot clears the recommended route against the real enemy AI without cheats');
    const st = this.stage;
    if (this.opts.flightSim === false) {
      ck.skipped = true;
      ck.line('NOT RUN: simulation disabled by option');
      return ck.done();
    }
    const ps = playerMovementStatus();
    if (ps.state === 'error') {
      ck.fail(`the simulation threw while probing player movement: ${ps.message}`);
      return ck.done();
    }
    if (ps.state === 'stub') {
      ck.skipped = true;
      ck.line(`NOT RUN: src/sim/player.ts is still a stub (${ps.message})`);
      return ck.done();
    }
    // The simulation is deterministic for a seed; three seeds (the game's default and two more) show that the
    // result does not hinge on one lucky sequence of enemy aim jitter.
    const plays: Array<{ name: string; loadout: Loadout; required: boolean; seed?: number }> = [
      { name: 'default loadout (medium FCS + balanced + biped), default seed', loadout: DEFAULT_LOADOUT, required: true },
      { name: 'default loadout, seed 1000', loadout: DEFAULT_LOADOUT, required: true, seed: 1000 },
      { name: 'default loadout, seed 32676', loadout: DEFAULT_LOADOUT, required: true, seed: 32676 },
      { name: 'weakest loadout (medium FCS + recovery + quadruped), default seed', loadout: WEAKEST_LOADOUT, required: false },
    ];
    const runs: Array<Record<string, unknown>> = [];
    let worst = Infinity;
    for (const play of plays) {
      const r = runWalkthrough(this, play.loadout, 2400, st.route, play.seed === undefined ? { combat: true } : { combat: true, seed: play.seed });
      const c = r.combat!;
      if (c.enemyShots === 0) {
        ck.skipped = true;
        ck.line(`NOT RUN: no enemy fired a single shot during the run — src/sim/enemies.ts does not attack yet, survivability is NOT verified`);
        return ck.done();
      }
      const text = `${play.name}: ${r.ok ? 'CLEARED' : `FAILED — ${r.reason}`} after ${r1(r.seconds)} s (${r1(c.fightSeconds)} s of it fighting), HP ${Math.round(c.hpEnd)}/${PLAYER.maxHp} at the end, ${Math.round(c.damageTaken)} damage taken from ${c.enemyShots} enemy shots, ${c.kills.length}/${st.enemies.length} enemies destroyed, shots MG ${c.shots.machinegun} / beam ${c.shots.beam} / missile ${c.shots.missile}`;
      if (play.required) {
        ck.need(r.ok, text);
        if (r.ok) worst = Math.min(worst, c.hpEnd);
      } else ck.line(`info ${text}`);
      ck.line(`    HP when each barrier opened: ${c.hpAtBarrier.map((b) => `${b.barrierId} ${Math.round(b.hp)} (t = ${r1(b.time)} s)`).join(' · ') || '-'}`);
      ck.line(`    damage taken per sector: ${st.sectors.filter((s) => c.damageBySector[s.id]).map((s) => `${s.id} ${Math.round(c.damageBySector[s.id])}`).join(' · ') || '-'}`);
      if (play.required && r.ok) {
        ck.need(r.controls.length === st.barriers.length, `${play.name}: all ${st.barriers.length} control turrets were destroyed by the bot's own fire (${r.controls.map((q) => q.id).join(' → ')})`);
      }
      runs.push({ name: play.name, required: play.required, seed: play.seed ?? null, ok: r.ok, reason: r.reason, seconds: r.seconds, distance: r.distance, waypointsReached: r.waypointsReached, waypoints: r.waypoints, visitedSectors: r.visitedSectors, stoppedAt: r.stoppedAt, controls: r.controls, ...c });
    }
    if (Number.isFinite(worst)) ck.line(`lowest final HP of the required runs: ${Math.round(worst)}/${PLAYER.maxHp}`);
    ck.data.worstFinalHp = Number.isFinite(worst) ? worst : null;
    ck.data.runs = runs;
    return ck.done();
  }

  /** Runs every check (or the ids listed in opts.only). A check that throws is reported as failed. */
  runAll(): CheckResult[] {
    const table: Array<[string, () => CheckResult]> = [
      ['V1', () => this.checkSectors()],
      ['V2', () => this.checkEnemies()],
      ['V3', () => this.checkRoute()],
      ['V4', () => this.checkMandatorySectors()],
      ['V5', () => this.checkProgression()],
      ['V6', () => this.checkFlightSpots()],
      ['V6d', () => this.checkFlightSim()],
      ['V7', () => this.checkBranches()],
      ['V8', () => this.checkLoops()],
      ['V9', () => this.checkLevels()],
      ['V10', () => this.checkArenas()],
      ['V11', () => this.checkMultiDirectional()],
      ['V12', () => this.checkStart()],
      ['V13', () => this.checkGeometry()],
      ['V14', () => this.checkWalkthrough()],
      ['V15', () => this.checkRouteDefence()],
      ['V16', () => this.checkCombat()],
    ];
    const out: CheckResult[] = [];
    for (const [id, fn] of table) {
      if (this.opts.only && !this.opts.only.includes(id)) continue;
      const t0 = performance.now();
      let r: CheckResult;
      try {
        r = fn();
      } catch (e) {
        const msg = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
        r = { id, title: 'analysis error', status: 'fail', ms: Math.round(performance.now() - t0), lines: [], problems: [`analysis threw: ${msg}`], warnings: [], data: {} };
      }
      this.log(`${id} ${r.status.toUpperCase()} in ${r.ms} ms`);
      out.push(r);
    }
    return out;
  }
}

// ───────────────────────────── flight simulation (V6d) ─────────────────────────────

let playerStatus: { state: 'ok' | 'stub' | 'error'; message: string } | null = null;
/**
 * State of src/sim/player.ts, probed by holding W for 0.5 s on a flat test stage: 'ok' (the player moves),
 * 'stub' (the simulation runs but the player does not move) or 'error' (the simulation threw — a defect,
 * never a reason to skip a check).
 */
export function playerMovementStatus(): { state: 'ok' | 'stub' | 'error'; message: string } {
  if (playerStatus === null) {
    try {
      const sim = new Sim(makeTestStage({ floorSize: 200 }));
      sim.input.moveZ = 1;
      sim.runFor(0.5);
      const moved = Math.hypot(sim.player.pos.x, sim.player.pos.z);
      playerStatus = moved > 0.5 ? { state: 'ok', message: '' } : { state: 'stub', message: `holding W for 0.5 s moved the player ${r2(moved)} m` };
    } catch (e) {
      playerStatus = { state: 'error', message: e instanceof Error ? e.message : String(e) };
    }
  }
  return playerStatus;
}
/** True when src/sim/player.ts really moves the player. */
export function playerMovementImplemented(): boolean {
  return playerMovementStatus().state === 'ok';
}

/** The loadout with the least EN and the slowest air speed: generator 'recovery' (EN 90) + legs 'quadruped' (x 0.8). */
export const WEAKEST_LOADOUT: Loadout = { fcs: 'medium', generator: 'recovery', legs: 'quadruped' };
/** The 6 combinations that differ in movement (the FCS does not affect movement, so these cover all 18 loadouts). */
export const MOVEMENT_LOADOUTS: Loadout[] = (['recovery', 'balanced', 'capacity'] as GeneratorId[]).flatMap((generator) =>
  (['quadruped', 'biped'] as LegsId[]).map((legs) => ({ fcs: 'medium' as const, generator, legs })),
);

export interface FlightSimResult {
  ok: boolean;
  reason: string;
  enUsed: number;
  enLeft: number;
  seconds: number;
  landed: V3;
}

/** What the flight controller needs from a simulation (the real Sim, or a reference model in the unit tests). */
export interface FlightDriver {
  readonly pos: V3;
  readonly grounded: boolean;
  readonly en: number;
  readonly yaw: number;
  readonly time: number;
  /** null while the run can go on, otherwise why it ended (destroyed / fell). */
  readonly ended: string | null;
  /** W held (0/1), Space held, Space pressed this tick (edge). */
  setInput(moveZ: number, jumpHeld: boolean, jumpPressed: boolean): void;
  look(dYaw: number): void;
  tick(): void;
}

/**
 * Keyboard-level flight controller: jump, keep Space held (flight starts after 0.20 s in the air), climb in
 * place until the remaining climb fits into the remaining horizontal distance, follow the polyline `pts`
 * (pts[0] = take-off, last = `to`), release Space above the landing, stop and land.
 * Success = first touch-down is on `to`'s surface within 3.5 m of `to` with EN > 0.
 */
export function flyClimb(d: FlightDriver, to: V3, pts: V3[], airSpeed: number): FlightSimResult {
  const maxEn = d.en;
  const t0 = d.time;
  const result = (ok: boolean, reason: string): FlightSimResult => ({ ok, reason, enUsed: maxEn - d.en, enLeft: d.en, seconds: d.time - t0, landed: { ...d.pos } });
  if (!d.grounded) return result(false, 'the player does not rest on the take-off surface');
  const speedRatio = airSpeed / PLAYER.flyClimbSpeed;
  let k = 1;
  let started = false;
  let airborne = false;
  let held = false;
  for (let tick = 0; tick < 40 * 120; tick++) {
    if (d.ended) return result(false, `the sortie ended (${d.ended})`);
    const p = d.pos;
    if (started && !d.grounded) airborne = true;
    if (airborne && d.grounded) {
      const dl = Math.hypot(to.x - p.x, to.z - p.z);
      if (Math.abs(p.y - to.y) < 0.05 && dl <= 3.5) return result(d.en > 0, d.en > 0 ? 'landed' : 'landed with EN 0');
      return result(false, `touched down at (${r1(p.x)}, ${r1(p.y)}, ${r1(p.z)}) instead of the landing surface (EN left ${r1(d.en)})`);
    }
    if (started && !airborne && tick > 60) return result(false, 'the jump did not lift the player off the take-off surface');
    let tgt = pts[k];
    let dx = tgt.x - p.x;
    let dz = tgt.z - p.z;
    let dh = Math.hypot(dx, dz);
    while (k < pts.length - 1 && dh < 1.0 && p.y > tgt.y - 0.6) {
      k++;
      tgt = pts[k];
      dx = tgt.x - p.x;
      dz = tgt.z - p.z;
      dh = Math.hypot(dx, dz);
    }
    const final = k === pts.length - 1;
    if (dh > 0.25) {
      let dyaw = Math.atan2(-dx, -dz) - d.yaw;
      while (dyaw > Math.PI) dyaw -= 2 * Math.PI;
      while (dyaw < -Math.PI) dyaw += 2 * Math.PI;
      d.look(dyaw);
    }
    const overLanding = final && dh < 1.2;
    const wantY = final ? to.y + 0.7 : tgt.y + 0.3;
    const clearY = final ? to.y + 0.25 : tgt.y - 0.3;
    // advance horizontally only when the remaining climb fits into the remaining horizontal distance
    const canAdvance = p.y >= clearY || dh > speedRatio * (clearY - p.y) + 2.0;
    const moveZ = dh > 0.25 && canAdvance && !overLanding ? 1 : 0;
    const hold = !overLanding && p.y < wantY + (held ? 0.15 : 0);
    let pressed = false;
    if (!started) {
      pressed = true;
      held = true;
      started = true;
    } else if (hold && !held) {
      pressed = true;
      held = true;
    } else if (!hold) {
      held = false;
    }
    d.setInput(moveZ, held, pressed);
    d.tick();
  }
  return result(false, 'timeout (40 s)');
}

/**
 * Flies one climb with the real simulation and the weakest loadout (generator 'recovery' = EN 90, legs
 * 'quadruped' = 12.8 m/s in the air) along the free-flight polyline `plan` (default: straight to `to`).
 * The stage copy has no enemies and no barriers; only the solids near the climb are kept.
 */
export function simulateFlightSpot(stage: StageDef, spot: { from: V3; to: V3 }, plan?: V3[], loadout: Loadout = WEAKEST_LOADOUT): FlightSimResult {
  const { from, to } = spot;
  const R = 70;
  const region: Box = {
    min: { x: Math.min(from.x, to.x) - R, y: Math.min(from.y, to.y) - 40, z: Math.min(from.z, to.z) - R },
    max: { x: Math.max(from.x, to.x) + R, y: Math.max(from.y, to.y) + 40, z: Math.max(from.z, to.z) + R },
  };
  const pts = plan && plan.length >= 2 ? plan : [from, to];
  const far = { x: region.min.x - 20, y: region.min.y - 20, z: region.min.z - 20 };
  const st: StageDef = {
    ...stage,
    id: `${stage.id}-flight`,
    bounds: { min: { x: region.min.x - 30, y: region.min.y - 30, z: region.min.z - 30 }, max: { x: region.max.x + 30, y: region.max.y + 30, z: region.max.z + 30 } },
    killY: Math.max(stage.killY, region.min.y),
    solids: stage.solids.filter((s) => boxesOverlap(s, region)),
    decor: [],
    enemies: [],
    barriers: [],
    finalGate: { id: stage.finalGate.id, name: 'removed', box: { min: far, max: { x: far.x + 0.1, y: far.y + 0.1, z: far.z + 0.1 } } },
    exitZone: { min: { x: far.x - 2, y: far.y - 2, z: far.z - 2 }, max: { x: far.x - 1, y: far.y - 1, z: far.z - 1 } },
    playerStart: { position: { x: from.x, y: from.y + 1e-3, z: from.z }, yaw: Math.atan2(-(pts[1].x - from.x), -(pts[1].z - from.z)) },
    connections: [],
    route: [],
    flightSpots: [],
    branches: [],
    loops: [],
  };
  const sim = new Sim(st, { loadout });
  sim.runFor(0.3);
  const driver: FlightDriver = {
    get pos() {
      return sim.player.pos;
    },
    get grounded() {
      return sim.player.grounded;
    },
    get en() {
      return sim.player.en;
    },
    get yaw() {
      return sim.player.yaw;
    },
    get time() {
      return sim.time;
    },
    get ended() {
      return sim.status === 'playing' ? null : (sim.failReason ?? sim.status);
    },
    setInput(moveZ, jumpHeld, jumpPressed) {
      sim.input.moveX = 0;
      sim.input.moveZ = moveZ;
      sim.input.jump = jumpHeld;
      if (jumpPressed) sim.input.jumpPressed = true;
    },
    look(dYaw) {
      sim.applyLook(dYaw, -sim.player.pitch);
    },
    tick() {
      sim.tick();
    },
  };
  return flyClimb(driver, to, pts, sim.stats.airSpeed);
}

// ───────────────────────────── walkthrough (V14) ─────────────────────────────

/** EN a climb of `h` m over `dh` m of horizontal distance needs (jump, 0.2 s hold, 8 m/s thrust to 0.5 m above the landing). */
export function estimateClimbEn(h: number, dh: number, airSpeed: number): number {
  const yHold = PLAYER.jumpSpeed * PLAYER.flyHoldSeconds - 0.5 * GRAVITY * PLAYER.flyHoldSeconds ** 2;
  let tThrust = Math.max(0, (h + 0.5 - yHold) / PLAYER.flyClimbSpeed);
  const coast = (PLAYER.flyClimbSpeed + Math.sqrt(PLAYER.flyClimbSpeed ** 2 + 2 * GRAVITY * 0.5)) / GRAVITY;
  const reachH = airSpeed * (PLAYER.flyHoldSeconds + tThrust + coast);
  if (dh > reachH) tThrust += (dh - reachH) / airSpeed;
  return tThrust * PLAYER.flyEnPerSecond;
}

export interface WalkthroughResult {
  ok: boolean;
  reason: string;
  loadout: Loadout;
  /** 'cleared' when the run reached the exit zone. */
  status: string;
  /** Simulated seconds from the sortie to the end of the run. */
  seconds: number;
  /** Length of the path the player's hit-box centre really travelled (m). */
  distance: number;
  minEn: number;
  /** Climbs flown with thrust / total EN spent on them / seconds spent standing still to regenerate EN. */
  flights: number;
  flightEn: number;
  maxFlightEn: number;
  enWaitSeconds: number;
  /** Times the bot was pressed against an obstacle for a second and had to plan its walk again (0 on a clean run). */
  replans: number;
  waypoints: number;
  waypointsReached: number;
  /** Simulated time at which each route waypoint was reached (NaN = not reached). */
  arrivals: number[];
  /** Control turrets in the order they were destroyed, with the position the player stood at. */
  controls: Array<{ id: string; barrierId: string; time: number; from: V3; dist: number; waypoint: number }>;
  /** Every climb the bot had to jump / fly (take-off position, target waypoint, EN really spent, duration). */
  climbs: Array<{ waypoint: number; from: V3; to: V3; height: number; horizontal: number; enUsed: number; seconds: number }>;
  visitedSectors: string[];
  stoppedAt: V3;
  /** The travelled path, one point about every 2 m. */
  path: Array<[number, number, number]>;
  /** Only for a combat run (WalkOptions.combat). */
  combat?: CombatStats;
}

export interface WalkOptions {
  /**
   * Fight instead of cheating: no HP refill, nothing is destroyed for free. The bot shoots with the real
   * weapons and the real FCS (see runWalkthrough).
   */
  combat?: boolean;
  /** Seed of the simulation's random stream (enemy aim jitter, AI choices). Default: the game's default seed. */
  seed?: number;
}

export interface CombatStats {
  hpEnd: number;
  hpMin: number;
  damageTaken: number;
  /** Enemies destroyed, in order. */
  kills: string[];
  shots: Record<Weapon, number>;
  ammoLeft: { machinegun: number; missile: number };
  /** HP when each barrier opened (its control turret destroyed). */
  hpAtBarrier: Array<{ barrierId: string; controlId: string; time: number; hp: number }>;
  damageBySector: Record<string, number>;
  /** Enemy shots fired during the run (0 = the enemy AI does not attack: nothing was tested). */
  enemyShots: number;
  /** Seconds spent standing and fighting instead of advancing. */
  fightSeconds: number;
}

/**
 * Plays the recommended route (stage.route) with the REAL simulation and real player physics:
 *   - keyboard-level control only (W, mouse yaw, Space): walk along a ground plan on the same floor level,
 *     walk off edges to drop, jump + hold Space to fly up (flyClimb) — never teleporting, never editing the
 *     player state except for the two documented cheats below;
 *   - cheat 1 (god mode): HP is refilled every tick, because this run tests the geometry, not the combat;
 *   - cheat 2 (shooting is replaced by a line-of-sight test): the next control turret in barrier order is
 *     destroyed through Sim.damageEnemy as soon as the grounded player is within 120 m and both the player's
 *     centre and muzzle (facing the turret) have an unobstructed line to its centre. The barrier / gate
 *     logic that follows is the real one.
 * Before a climb the bot stands still until it has the EN the climb needs (+10), which only works where the
 * stage offers a resting place in front of the climb. Success = Sim.status 'cleared'.
 * `route` (default: stage.route) lets a tool play a variant, e.g. the detour side of every branch.
 *
 * COMBAT RUN (opts.combat): neither cheat is used — HP is real and nothing dies for free. The bot is a plain,
 * deterministic "clear as you go" player:
 *   - target = the next control turret whenever it can be engaged, otherwise the nearest enemy that currently
 *     has a firing line on the player (EnemyState.hasLos) and that the player can engage (<= 118 m from the
 *     muzzle, clear line from the camera pivot and from the muzzle); the target is kept until it dies or is lost;
 *   - aim = mouse look so that the camera centre is on the target; the real FCS locks and corrects the shots;
 *   - weapons: beam while EN >= 60 (down to 16), otherwise machine gun (fired once locked, or under 25 m),
 *     missiles when the machine gun is empty;
 *   - while fighting it stands on its floor and strafes left / right, reversing every 0.35–0.65 s (never over
 *     an edge) — no glide, no quick boost, no use of cover; it does not fight while airborne;
 *   - a target that takes no damage for 8 s is ignored for 20 s.
 * It is a floor for what a player can do, not a model of a good one.
 */
export function runWalkthrough(an: StageAnalyzer, loadout: Loadout, maxSeconds = 1800, route: StageDef['route'] = an.stage.route, opts: WalkOptions = {}): WalkthroughResult {
  const stage = an.stage;
  const combat = !!opts.combat;
  const sim = new Sim(stage, opts.seed === undefined ? { loadout } : { loadout, seed: opts.seed });
  const p = sim.player;
  const maxEn = sim.stats.maxEn;
  const air = sim.stats.airSpeed;
  const arrivals: number[] = route.map(() => NaN);
  arrivals[0] = 0;
  const controls: WalkthroughResult['controls'] = [];
  const climbs: WalkthroughResult['climbs'] = [];
  const path: Array<[number, number, number]> = [[r2(p.pos.x), r2(p.pos.y), r2(p.pos.z)]];
  let distance = 0;
  let minEn = p.en;
  let flights = 0;
  let flightEn = 0;
  let maxFlightEn = 0;
  let enWait = 0;
  let replans = 0;
  let k = 1;
  const last = { ...p.pos };
  const lastSample = { ...p.pos };
  const closedIds = (): string[] => an.closable.filter((id) => !sim.world.isBarrierOpen(id));
  const cs: CombatStats = {
    hpEnd: p.hp,
    hpMin: p.hp,
    damageTaken: 0,
    kills: [],
    shots: { machinegun: 0, beam: 0, missile: 0 },
    ammoLeft: { machinegun: p.ammo.machinegun, missile: p.ammo.missile },
    hpAtBarrier: [],
    damageBySector: {},
    enemyShots: 0,
    fightSeconds: 0,
  };
  let lastHp = p.hp;

  const afterTick = (): void => {
    distance += dist3(p.pos, last);
    last.x = p.pos.x;
    last.y = p.pos.y;
    last.z = p.pos.z;
    if (dist3(p.pos, lastSample) >= 2) {
      lastSample.x = p.pos.x;
      lastSample.y = p.pos.y;
      lastSample.z = p.pos.z;
      path.push([r2(p.pos.x), r2(p.pos.y), r2(p.pos.z)]);
    }
    if (p.en < minEn) minEn = p.en;
    if (combat) {
      if (p.hp < lastHp) {
        const id = sim.currentSectorId ?? '?';
        cs.damageTaken += lastHp - p.hp;
        cs.damageBySector[id] = (cs.damageBySector[id] ?? 0) + (lastHp - p.hp);
      }
      lastHp = p.hp;
      if (p.hp < cs.hpMin) cs.hpMin = p.hp;
      for (const ev of sim.drainEvents()) {
        if (ev.type === 'player-shot') cs.shots[ev.weapon]++;
        else if (ev.type === 'enemy-destroyed') cs.kills.push(ev.enemyId);
        else if (ev.type === 'barrier-opened') {
          cs.hpAtBarrier.push({ barrierId: ev.barrierId, controlId: ev.controlEnemyId, time: sim.time, hp: p.hp });
          const e = sim.enemyById.get(ev.controlEnemyId);
          controls.push({ id: ev.controlEnemyId, barrierId: ev.barrierId, time: sim.time, from: { ...p.pos }, dist: e ? dist3(p.pos, e.pos) : 0, waypoint: k });
        }
      }
      return;
    }
    if (sim.status !== 'playing') return;
    p.hp = PLAYER.maxHp;
    if (!p.grounded) return;
    for (const b of stage.barriers) {
      const e = sim.enemyById.get(b.controlEnemyId);
      if (!e || !e.alive) continue;
      const d = dist3(p.pos, e.pos);
      if (d <= LIMITS.controlRange) {
        const mz = an.muzzleFacing(p.pos, e.pos);
        if (dist3(mz, e.pos) <= LIMITS.controlRange && !sim.world.segmentBlocked(p.pos, e.pos) && !sim.world.segmentBlocked(mz, e.pos)) {
          controls.push({ id: e.id, barrierId: b.id, time: sim.time, from: { ...p.pos }, dist: d, waypoint: k });
          sim.damageEnemy(e, e.hp + 1);
        }
      }
      break; // only the next control turret in barrier order
    }
  };
  const tick = (): void => {
    sim.tick();
    afterTick();
  };
  const idle = (): void => {
    sim.input.moveX = 0;
    sim.input.moveZ = 0;
    sim.input.jump = false;
    sim.input.fire = false;
  };

  // ── combat (opts.combat only) ──
  const C = { target: null as EnemyState | null, since: 0, hp0: 0, dir: 1, flipAt: 0, scanAt: 0, beam: false, rng: 0x9e3779b9, ignore: new Map<string, number>() };
  const rnd = (): number => {
    C.rng = (Math.imul(C.rng, 1664525) + 1013904223) >>> 0;
    return C.rng / 4294967296;
  };
  const pivot = { x: 0, y: 0, z: 0 };
  const half = { x: HX, y: HY, z: HZ };
  const foot = { x: 0.6, y: HY, z: 0.6 };
  const engageable = (e: EnemyState): boolean => {
    if (!e.alive || (C.ignore.get(e.id) ?? -1) > sim.time) return false;
    const mz = an.muzzleFacing(p.pos, e.pos);
    if (dist3(mz, e.pos) > 118) return false;
    pivot.x = p.pos.x;
    pivot.y = p.pos.y + CAMERA.pivotUp;
    pivot.z = p.pos.z;
    return !sim.world.segmentBlocked(pivot, e.pos) && !sim.world.segmentBlocked(mz, e.pos);
  };
  const pickTarget = (): EnemyState | null => {
    for (const b of stage.barriers) {
      const e = sim.enemyById.get(b.controlEnemyId);
      if (!e || !e.alive) continue;
      if (engageable(e)) return e;
      break; // only the next control turret in barrier order
    }
    let best: EnemyState | null = null;
    let bestD = Infinity;
    for (const e of sim.enemies) {
      if (!e.alive || !e.hasLos || !engageable(e)) continue;
      const d = dist3(p.pos, e.pos);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  };
  const safeStep = (dx: number, dz: number): boolean => {
    const q = { x: p.pos.x + dx * 2.2, y: p.pos.y + 2e-4, z: p.pos.z + dz * 2.2 };
    return !sim.world.overlapsBox(q, half) && sim.world.probeGround(q, foot, 0.3) <= 0.05;
  };
  /** One tick of fighting. False when there is nothing to fight (the caller goes on with the route). */
  const fight = (): boolean => {
    if (!combat || !p.grounded || sim.status !== 'playing') return false;
    if (sim.time >= C.scanAt) {
      C.scanAt = sim.time + 0.1;
      if (C.target && !engageable(C.target)) C.target = null;
      if (C.target && sim.time - C.since > 8) {
        if (C.target.hp > C.hp0 - 1) {
          C.ignore.set(C.target.id, sim.time + 20);
          C.target = null;
        } else {
          C.since = sim.time;
          C.hp0 = C.target.hp;
        }
      }
      if (!C.target) {
        C.target = pickTarget();
        if (C.target) {
          C.since = sim.time;
          C.hp0 = C.target.hp;
        }
      }
    }
    const e = C.target;
    if (!e || !e.alive) {
      C.target = null;
      sim.input.fire = false;
      return false;
    }
    // aim: the camera centre ray passes through the pivot, so look from the pivot at the target
    pivot.x = p.pos.x;
    pivot.y = p.pos.y + CAMERA.pivotUp;
    pivot.z = p.pos.z;
    const fx = e.pos.x - pivot.x;
    const fy = e.pos.y - pivot.y;
    const fz = e.pos.z - pivot.z;
    const fl = Math.hypot(fx, fy, fz) || 1;
    let dyaw = Math.atan2(-fx, -fz) - p.yaw;
    while (dyaw > Math.PI) dyaw -= 2 * Math.PI;
    while (dyaw < -Math.PI) dyaw += 2 * Math.PI;
    sim.applyLook(dyaw, Math.asin(Math.max(-1, Math.min(1, fy / fl))) - p.pitch);
    // weapon
    if (C.beam ? p.en < 16 : p.en >= 60) C.beam = !C.beam;
    const locked = sim.lock.state === 'locked' && sim.lock.targetId === e.id;
    let want: Weapon = C.beam ? 'beam' : p.ammo.machinegun > 0 ? 'machinegun' : p.ammo.missile > 0 ? 'missile' : 'beam';
    if (want === 'missile' && !locked && p.en >= 8) want = 'beam';
    if (p.weapon !== want) sim.input.weaponSelect = want;
    const d = dist3(p.pos, e.pos);
    sim.input.fire = p.weapon === want && (want === 'beam' ? p.en >= 8 : want === 'machinegun' ? locked || d < 25 : locked);
    // dodge: strafe left / right relative to the line to the target, never over an edge or into a wall
    if (sim.time >= C.flipAt) {
      C.dir = -C.dir;
      C.flipAt = sim.time + 0.35 + 0.3 * rnd();
    }
    const rx = Math.cos(p.yaw);
    const rz = -Math.sin(p.yaw);
    let mv = C.dir;
    if (!safeStep(rx * mv, rz * mv)) {
      if (safeStep(-rx * mv, -rz * mv)) {
        C.dir = -C.dir;
        mv = C.dir;
      } else mv = 0;
    }
    sim.input.moveX = mv;
    sim.input.moveZ = 0;
    sim.input.jump = false;
    tick();
    cs.fightSeconds += TICK;
    return true;
  };
  const steer = (x: number, z: number): number => {
    const dx = x - p.pos.x;
    const dz = z - p.pos.z;
    const dh = Math.hypot(dx, dz);
    if (dh > 0.05) {
      let dyaw = Math.atan2(-dx, -dz) - p.yaw;
      while (dyaw > Math.PI) dyaw -= 2 * Math.PI;
      while (dyaw < -Math.PI) dyaw += 2 * Math.PI;
      sim.applyLook(dyaw, -p.pitch);
    }
    return dh;
  };
  const driver: FlightDriver = {
    get pos() {
      return p.pos;
    },
    get grounded() {
      return p.grounded;
    },
    get en() {
      return p.en;
    },
    get yaw() {
      return p.yaw;
    },
    get time() {
      return sim.time;
    },
    get ended() {
      return sim.status === 'playing' ? null : (sim.failReason ?? sim.status);
    },
    setInput(moveZ, jumpHeld, jumpPressed) {
      sim.input.moveX = 0;
      sim.input.moveZ = moveZ;
      sim.input.jump = jumpHeld;
      if (jumpPressed) sim.input.jumpPressed = true;
    },
    look(dYaw) {
      sim.applyLook(dYaw, -p.pitch);
    },
    tick,
  };
  const result = (ok: boolean, reason: string): WalkthroughResult => ({
    ok,
    reason,
    loadout,
    status: sim.status,
    seconds: sim.time,
    distance,
    minEn,
    flights,
    flightEn,
    maxFlightEn,
    enWaitSeconds: enWait,
    replans,
    waypoints: route.length,
    waypointsReached: arrivals.filter((t) => !Number.isNaN(t)).length,
    arrivals,
    controls,
    climbs,
    visitedSectors: [...sim.visitedSectorIds],
    stoppedAt: { ...p.pos },
    path,
    ...(combat
      ? {
          combat: {
            ...cs,
            hpEnd: p.hp,
            ammoLeft: { machinegun: p.ammo.machinegun, missile: p.ammo.missile },
            enemyShots: sim.enemies.reduce((a, e) => a + e.shotsFired, 0),
          },
        }
      : {}),
  });
  const where = (): string => `${fmtV(p.pos)} in ${sim.currentSectorId ?? 'no sector'} at t = ${r1(sim.time)} s`;

  if (route.length < 2) return result(false, 'stage.route has fewer than 2 waypoints');
  if (dist3(route[0].position, stage.playerStart.position) > 1) return result(false, 'stage.route does not begin at the player start');
  sim.runFor(0.25);
  afterTick();
  if (!p.grounded) return result(false, 'the player does not rest on the floor at the start');

  let plan: V3[] | null = null;
  let pi = 0;
  let blockedFor = 0;
  let planKind: 'ground' | 'drop' = 'ground';
  let wasGrounded = true;
  let refT = sim.time;
  const ref = { ...p.pos };
  while (sim.status === 'playing' && sim.time < maxSeconds && k < route.length) {
    const T = route[k].position;
    const dy = T.y - p.pos.y;
    const dh = Math.hypot(T.x - p.pos.x, T.z - p.pos.z);
    if (p.grounded && dh < 0.75 && Math.abs(dy) < 0.3) {
      arrivals[k] = sim.time;
      k++;
      plan = null;
      continue;
    }
    // combat run: fight whatever threatens the bot before going on
    if (fight()) {
      plan = null;
      refT = sim.time;
      ref.x = p.pos.x;
      ref.y = p.pos.y;
      ref.z = p.pos.z;
      continue;
    }
    sim.input.fire = false;
    // watchdog: the bot must move at least 1 m every 4 s while it is trying to move
    if (sim.time - refT > 4) {
      if (dist3(p.pos, ref) < 1) return result(false, `stuck on the way to waypoint ${k} ${fmtV(T)} (${route[k].sectorId}) at ${where()}`);
      refT = sim.time;
      ref.x = p.pos.x;
      ref.y = p.pos.y;
      ref.z = p.pos.z;
    }
    if (p.grounded && !wasGrounded) plan = null; // landed: plan again from here
    wasGrounded = p.grounded;
    if (!p.grounded) {
      // falling after walking off an edge: keep following the drop plan (or head straight for the waypoint)
      let q = T;
      if (plan && planKind === 'drop') {
        while (pi < plan.length - 1 && Math.hypot(plan[pi].x - p.pos.x, plan[pi].z - p.pos.z) < 0.6) pi++;
        q = plan[pi];
      }
      const d = steer(q.x, q.z);
      sim.input.moveX = 0;
      sim.input.moveZ = d > 0.3 ? 1 : 0;
      sim.input.jump = false;
      tick();
      continue;
    }
    if (dy > 0.3) {
      // climb: wait for EN on the ground, then jump + fly
      const pts = an.flightPlan(p.pos, T, closedIds()) ?? [{ ...p.pos }, { ...T }];
      const need = Math.min(maxEn, estimateClimbEn(dy, dh, air) + 10);
      idle();
      let waited = 0;
      let fought = false;
      while (p.en < need - 1e-6 && sim.status === 'playing') {
        if (fight()) {
          fought = true;
          if (sim.time > maxSeconds) break;
          continue;
        }
        idle();
        tick();
        waited += TICK;
        if (waited > 60) return result(false, `EN does not regenerate to ${r1(need)} before the climb to waypoint ${k} at ${where()}`);
      }
      if (fought) {
        // the bot moved while fighting: plan the climb again from where it stands now
        plan = null;
        continue;
      }
      enWait += waited;
      const takeOff = { ...p.pos };
      const res = flyClimb(driver, T, pts, air);
      idle();
      if (!res.ok) return result(false, `climb of ${r1(dy)} m to waypoint ${k} ${fmtV(T)} (${route[k].sectorId}) failed: ${res.reason}; now at ${where()}`);
      climbs.push({ waypoint: k, from: takeOff, to: { ...T }, height: dy, horizontal: dh, enUsed: res.enUsed, seconds: res.seconds });
      if (res.enUsed > 0.01) {
        flights++;
        flightEn += res.enUsed;
        maxFlightEn = Math.max(maxFlightEn, res.enUsed);
      }
      plan = null;
      wasGrounded = p.grounded;
      refT = sim.time;
      ref.x = p.pos.x;
      ref.y = p.pos.y;
      ref.z = p.pos.z;
      continue;
    }
    if (!plan) {
      if (dy < -0.3) {
        // drop: follow the free-flight polyline horizontally and fall off the edge it crosses
        plan = an.flightPlan(p.pos, T, closedIds()) ?? [{ ...p.pos }, { ...T }];
        planKind = 'drop';
      } else {
        plan = an.groundPlan(p.pos, T, closedIds());
        planKind = 'ground';
        if (!plan) return result(false, `no walkable ground path to waypoint ${k} ${fmtV(T)} (${route[k].sectorId}) from ${where()} — closed: ${closedIds().join(', ') || 'none'}`);
      }
      pi = 1;
    }
    while (pi < plan.length - 1 && Math.hypot(plan[pi].x - p.pos.x, plan[pi].z - p.pos.z) < (planKind === 'drop' ? 0.6 : 0.3)) pi++;
    const q = plan[pi];
    let ax = q.x;
    let az = q.z;
    if (planKind === 'ground' && pi > 0) {
      // track the planned segment (aim 2.5 m ahead of the own projection onto it) instead of cutting towards its end
      const a = plan[pi - 1];
      const sx = q.x - a.x;
      const sz = q.z - a.z;
      const sl = Math.hypot(sx, sz);
      if (sl > 1e-6) {
        const t = Math.min(1, Math.max(0, ((p.pos.x - a.x) * sx + (p.pos.z - a.z) * sz) / (sl * sl)) + 2.5 / sl);
        ax = a.x + sx * t;
        az = a.z + sz * t;
      }
    }
    const d = steer(ax, az);
    sim.input.moveX = 0;
    sim.input.moveZ = d > 0.05 ? 1 : 0;
    sim.input.jump = false;
    const bx0 = p.pos.x;
    const bz0 = p.pos.z;
    tick();
    // pressed against something for a second: plan again from where the bot really is
    if (Math.hypot(p.pos.x - bx0, p.pos.z - bz0) < 0.2 * TICK) blockedFor += TICK;
    else blockedFor = 0;
    if (blockedFor > 1 && p.grounded) {
      plan = null;
      blockedFor = 0;
      replans++;
    }
  }
  idle();
  if (sim.status === 'cleared') {
    for (let i = k; i < route.length; i++) {
      // the run ends the moment the exit zone is entered; a last waypoint inside the zone counts as reached
      if (inBox(route[i].position, stage.exitZone) && i === route.length - 1) arrivals[i] = sim.time;
    }
    return result(true, 'cleared');
  }
  if (sim.status === 'failed') return result(false, `the sortie failed (${sim.failReason}) at ${where()}${combat ? ` on the way to waypoint ${k}` : ''}`);
  if (k >= route.length) return result(false, `the route ended at ${where()} without entering the exit zone (gate open: ${sim.objective.gateOpen})`);
  return result(false, `timeout after ${maxSeconds} s at ${where()}`);
}

// ───────────────────────────── entry points ─────────────────────────────

/** Runs the whole validation V1–V16 on a stage. Never throws: construction problems become a failed check. */
export function analyzeStage(stage: StageDef, opts: AnalyzeOptions = {}): StageReport {
  const t0 = performance.now();
  let an: StageAnalyzer;
  try {
    an = new StageAnalyzer(stage, opts);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      stageId: stage.id,
      stageName: stage.name,
      pass: false,
      result: 'FAIL',
      totalMs: Math.round(performance.now() - t0),
      grid: {},
      checks: [{ id: 'V0', title: 'voxel model', status: 'fail', ms: 0, lines: [], problems: [`the voxel model could not be built: ${msg}`], warnings: [], data: {} }],
    };
  }
  const checks = an.runAll();
  const g = an.grid;
  const failed = checks.length === 0 || checks.some((c) => c.status === 'fail');
  const skipped = checks.some((c) => c.status === 'skipped');
  const result: StageReport['result'] = failed ? 'FAIL' : skipped && !opts.allowSkips ? 'INCOMPLETE' : 'PASS';
  return {
    stageId: stage.id,
    stageName: stage.name,
    pass: result === 'PASS',
    result,
    totalMs: Math.round(performance.now() - t0),
    grid: {
      cells: [g.nx, g.ny, g.nz],
      cellSize: [1, g.cy, 1],
      extent: g.extent,
      clippedToGeometry: g.clipped,
      setupMs: an.setupMs,
      reachableStrictCells: an.countRS,
      reachableLooseCells: an.countRL,
      standingCells: an.standing.length,
      looseAmbiguousCells: g.looseAmbiguous,
      solids: stage.solids.length,
      decor: stage.decor.length,
    },
    checks,
  };
}

/** Human-readable report. */
export function formatReport(r: StageReport): string {
  const out: string[] = [];
  out.push(`=== Stage validation: ${r.stageId} — ${r.stageName} ===`);
  const g = r.grid as { cells?: number[]; cellSize?: number[]; setupMs?: number; reachableStrictCells?: number; reachableLooseCells?: number; standingCells?: number; solids?: number; decor?: number };
  if (g.cells) {
    out.push(`voxel grid ${g.cells.join(' x ')} cells of ${g.cellSize!.join(' x ')} m, ${g.solids} solids, ${g.decor} decor; setup ${g.setupMs} ms`);
    out.push(`reachable (all barriers open): ${g.reachableStrictCells} strict / ${g.reachableLooseCells} loose cells, ${g.standingCells} m² standing`);
  }
  for (const c of r.checks) {
    out.push('');
    out.push(`[${c.status === 'pass' ? 'PASS' : c.status === 'fail' ? 'FAIL' : 'SKIP'}] ${c.id} ${c.title}  (${c.ms} ms)`);
    for (const l of c.lines) out.push(`    ${l}`);
    for (const w of c.warnings) out.push(`    warning: ${w}`);
  }
  const failed = r.checks.filter((c) => c.status === 'fail').map((c) => c.id);
  const skipped = r.checks.filter((c) => c.status === 'skipped').map((c) => c.id);
  out.push('');
  out.push(`RESULT: ${r.result ?? (r.pass ? 'PASS' : 'FAIL')} — ${r.checks.length - failed.length - skipped.length} passed, ${failed.length} failed${failed.length ? ` (${failed.join(', ')})` : ''}, ${skipped.length} not run${skipped.length ? ` (${skipped.join(', ')})` : ''}; total ${(r.totalMs / 1000).toFixed(1)} s`);
  return out.join('\n');
}
