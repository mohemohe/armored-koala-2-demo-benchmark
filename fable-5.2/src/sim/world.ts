/**
 * World — static collision of the stage: axis-aligned boxes only (solids + closable barriers + final gate).
 *
 * Everything that blocks movement also blocks bullets, beams, missiles and line of sight, exactly as drawn.
 * Queries: raycast, segment (LOS) test, box overlap, swept-box collide-and-slide, ground probe, region
 * query, sector lookup.
 *
 * CONTRACT (other modules rely on these exact signatures — keep them; you may add more):
 *   - `boxes[i].active === false` means "not there" (an opened barrier). `active` is read at query time, so
 *     toggling it directly or through setBarrierOpen / resetBarriers both work.
 *   - Touching faces never count as overlap/hit, so a box resting on a floor can slide along it.
 *   - No query allocates on the hot path beyond its returned result object.
 *   - The geometry is immutable after construction (`boxes`, `box.min`, `box.max` are frozen); only
 *     `box.active` may change. Build a new World for a different set of boxes.
 *
 * SEMANTICS (tests/world.test.ts keeps a brute-force reference that implements exactly these rules and
 * compares every query against it):
 *   - Solids are closed boxes; a query only reports contact with their interior.
 *       · overlapsBox / boxesInAabb: strict inequalities on all three axes.
 *       · raycast: slab test with open intervals; the nearest entry distance wins, equal distances are
 *         resolved by the lowest box index (= order of `boxes`), a ray starting inside a box hits at
 *         dist 0 with a zero normal. A hit at exactly `maxDist` counts.
 *       · A ray that runs exactly inside a face plane (direction component ~0 and origin on the plane)
 *         grazes an isolated box without hitting it, but it IS blocked where the plane is the seam between
 *         abutting boxes (both sides solid). Without this a ray could pass between the two halves of a wall.
 *       · segmentBlocked(a, b): true iff the segment enters solid matter strictly before b. An end point
 *         that merely touches a surface is not blocked, so the test is symmetric in a and b.
 *   - moveBox: continuous sweep of the box against every active box (never tunnels), earliest contact first,
 *     stop with a gap of SKIN measured along the contact normal, remove that component, slide on.
 *     A box that already overlaps the moving box at the start by more than CONTACT_EPS on all three axes is
 *     ignored (no sticking); a penetration of at most CONTACT_EPS (floating-point noise) counts as touching.
 *   - probeGround uses the same contact band as moveBox.
 *
 * ACCELERATION: a uniform grid over XZ (cell size 8 m by default) built once in the constructor. Boxes that
 * would cover more than `largeBoxCells` cells (huge floor slabs) are kept in a short always-tested list
 * instead. Rays walk the grid with a 2D DDA and stop as soon as the best hit lies before the next cell
 * boundary; box queries visit the cells under their (swept) bounds. Candidates are de-duplicated with a
 * per-query stamp array; all scratch storage is preallocated.
 */
import { v3, type V3 } from '../core/vec';
import type { Box, SolidMaterial, StageDef } from './types';

export interface WorldBox extends Box {
  active: boolean;
  /** BarrierDef.id / FinalGateDef.id for closable boxes, null for permanent solids. */
  barrierId: string | null;
  material: SolidMaterial;
}

export interface RayHit {
  /** Distance from the ray origin (>= 0). */
  dist: number;
  point: V3;
  /** Axis-aligned surface normal at the hit; (0, 0, 0) when the ray started inside the box. */
  normal: V3;
  box: WorldBox;
}

export interface MoveResult {
  /**
   * Axis-aligned contact normals met during the move: each is -1, 0 or +1.
   * ny = +1 → landed on / pressed against a floor, ny = -1 → hit a ceiling,
   * nx / nz ≠ 0 → hit a wall whose normal points along that sign.
   */
  nx: number;
  ny: number;
  nz: number;
}

/** Tuning of the spatial index (tests and tools; the game uses the defaults). */
export interface WorldOptions {
  /** Edge length of a grid cell in metres (default 8). Enlarged automatically for enormous stages. */
  cellSize?: number;
  /** A box covering more grid cells than this is kept in the always-tested list (default 1024). */
  largeBoxCells?: number;
  /**
   * Offset of the cell boundaries from multiples of the cell size, as a fraction of a cell (default
   * ~0.16 so that boundaries do not coincide with the round coordinates stages are built on).
   */
  originFraction?: number;
}

export interface WorldGridInfo {
  cellSize: number;
  originX: number;
  originZ: number;
  nx: number;
  nz: number;
  /** Boxes stored in grid cells / in the always-tested list / ignored because of NaN coordinates. */
  griddedBoxes: number;
  largeBoxes: number;
  deadBoxes: number;
  /** Total number of (cell, box) entries. */
  entries: number;
}

/** Gap kept between a moved box and the surface it collided with (measured along the contact normal). */
export const SKIN = 1e-4;

/**
 * Contact band of moveBox / probeGround: a moving box that is at most this deep inside a face of an
 * obstacle is treated as touching that face (blocked when it pushes in, free to leave or slide), deeper
 * than this on all three axes is a real overlap that moveBox ignores.
 */
export const CONTACT_EPS = 1e-6;

/** A direction / displacement component smaller than this is treated as exactly zero. */
const PARALLEL_EPS = 1e-12;
const DEFAULT_CELL_SIZE = 8;
const DEFAULT_LARGE_BOX_CELLS = 1024;
const DEFAULT_ORIGIN_FRACTION = 0.1618033988749895;
/** Upper bounds that keep the index small whatever the stage looks like. */
const MAX_GRID_CELLS = 1 << 18;
const MAX_GRID_ENTRIES = 1 << 21;

// Slots of the ray scratch array `rf`: origin, direction, parameter range, parameter of the best hit so far.
const R_OX = 0;
const R_OY = 1;
const R_OZ = 2;
const R_DX = 3;
const R_DY = 4;
const R_DZ = 5;
const R_TMIN = 6;
const R_TMAX = 7;
const R_BEST = 8;

function finite3(v: V3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

export class World {
  readonly stage: StageDef;
  /** Solids first (stage order), then the barriers (stage order), then the final gate. Frozen. */
  readonly boxes: WorldBox[] = [];
  private readonly barrierBoxes = new Map<string, WorldBox[]>();

  // ── flat copy of the geometry: minX, minY, minZ, maxX, maxY, maxZ per box ──
  private readonly bb: Float64Array;
  /** Always-tested boxes (too large for the grid, or infinite in X/Z). */
  private readonly large: Int32Array;
  /** Boxes stored in the grid (ascending index); used when a query covers most of the grid. */
  private readonly gridded: Int32Array;
  private readonly deadCount: number;

  // ── uniform XZ grid in compressed-row form: items of cell c are cellItems[cellStart[c] .. cellStart[c+1]) ──
  private readonly cellStart: Int32Array;
  private readonly cellItems: Int32Array;
  private readonly cs: number;
  private readonly invCs: number;
  private readonly gx0: number;
  private readonly gz0: number;
  private readonly nx: number;
  private readonly nz: number;
  /** Bounds of all gridded boxes, enlarged by a safety margin. Nothing in the grid lies outside. */
  private readonly bx0: number;
  private readonly bx1: number;
  private readonly by0: number;
  private readonly by1: number;
  private readonly bz0: number;
  private readonly bz1: number;
  /** Absolute tolerance (metres) that dwarfs floating-point noise at the scale of this stage. */
  private readonly pad: number;
  /** Estimated cost of visiting one cell, in box tests (decides when a plain loop over all boxes is cheaper). */
  private readonly cellCost: number;

  // ── per-query scratch (preallocated) ──
  private readonly stamp: Uint32Array;
  private queryId = 0;
  private readonly cand: Int32Array;

  /**
   * Floating-point state of the current ray (slots R_*). Internal routines exchange numbers through this
   * array and through `qf` instead of through parameters, so that the VM never has to box a number.
   */
  private readonly rf = new Float64Array(9);
  /** Region handed to gather(): minX, minY, minZ, maxX, maxY, maxZ. */
  private readonly qf = new Float64Array(6);
  // current ray: "no motion along this axis" flags, side convention for those axes, end-point rule
  private rPx = false;
  private rPy = false;
  private rPz = false;
  private rSideX = 0;
  private rSideY = 0;
  private rSideZ = 0;
  private rStrict = false;
  // best hit of the current cast (its parameter is rf[R_BEST])
  private hIdx = -1;
  private hAxis = 0;
  private hSign = 0;
  private hDegenerate = false;
  // per-variant results of the exact (degenerate ray) path
  private readonly vT = new Float64Array(8);
  private readonly vIdx = new Int32Array(8);
  private readonly vAxis = new Int32Array(8);
  private readonly vSign = new Int32Array(8);

  constructor(stage: StageDef, opts: WorldOptions = {}) {
    this.stage = stage;
    for (const s of stage.solids) this.addBox(s, null, s.material);
    for (const b of stage.barriers) this.addBox(b.box, b.id, 'hazard');
    this.addBox(stage.finalGate.box, stage.finalGate.id, 'hazard');
    Object.freeze(this.boxes);

    // ── flat geometry, classification, bounds ──
    const boxes = this.boxes;
    const n = boxes.length;
    const bb = new Float64Array(n * 6);
    /** 0 = grid candidate, 1 = always tested (infinite in X/Z), 2 = never collides (NaN coordinate). */
    const cls = new Uint8Array(n);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    let maxAbs = 0;
    let dead = 0;
    for (let i = 0; i < n; i++) {
      const b = boxes[i];
      const p = i * 6;
      bb[p] = b.min.x;
      bb[p + 1] = b.min.y;
      bb[p + 2] = b.min.z;
      bb[p + 3] = b.max.x;
      bb[p + 4] = b.max.y;
      bb[p + 5] = b.max.z;
      let nan = false;
      let xzFinite = true;
      for (let k = 0; k < 6; k++) {
        const v = bb[p + k];
        if (v !== v) nan = true;
        else if (v === Infinity || v === -Infinity) {
          if (k !== 1 && k !== 4) xzFinite = false;
        } else {
          const a = v < 0 ? -v : v;
          if (a > maxAbs) maxAbs = a;
        }
      }
      if (nan) {
        cls[i] = 2;
        dead++;
        continue;
      }
      if (!xzFinite) {
        cls[i] = 1;
        continue;
      }
      if (bb[p] < minX) minX = bb[p];
      if (bb[p + 3] > maxX) maxX = bb[p + 3];
      if (bb[p + 1] < minY) minY = bb[p + 1];
      if (bb[p + 4] > maxY) maxY = bb[p + 4];
      if (bb[p + 2] < minZ) minZ = bb[p + 2];
      if (bb[p + 5] > maxZ) maxZ = bb[p + 5];
    }
    if (minX > maxX) {
      // no box can go into the grid: a single empty cell at the origin
      minX = maxX = minY = maxY = minZ = maxZ = 0;
    }
    this.bb = bb;
    this.deadCount = dead;
    const pad = 1e-6 + 1e-9 * maxAbs;
    const margin = 1e-3 + 16 * pad;
    this.pad = pad;
    this.bx0 = minX - margin;
    this.bx1 = maxX + margin;
    this.by0 = minY - margin;
    this.by1 = maxY + margin;
    this.bz0 = minZ - margin;
    this.bz1 = maxZ + margin;

    // ── grid dimensions ──
    const csOpt = opts.cellSize;
    let cs = csOpt !== undefined && csOpt > 0 && Number.isFinite(csOpt) ? csOpt : DEFAULT_CELL_SIZE;
    const fracOpt = opts.originFraction;
    const frac = fracOpt !== undefined && fracOpt >= 0 && fracOpt < 1 ? fracOpt : DEFAULT_ORIGIN_FRACTION;
    let gx0 = 0;
    let gz0 = 0;
    let nx = 1;
    let nz = 1;
    for (;;) {
      gx0 = (Math.floor(this.bx0 / cs) - 1 + frac) * cs;
      gz0 = (Math.floor(this.bz0 / cs) - 1 + frac) * cs;
      nx = Math.floor((this.bx1 - gx0) / cs) + 1;
      nz = Math.floor((this.bz1 - gz0) / cs) + 1;
      if (nx * nz <= MAX_GRID_CELLS) break;
      cs *= 2;
    }
    this.cs = cs;
    this.invCs = 1 / cs;
    this.gx0 = gx0;
    this.gz0 = gz0;
    this.nx = nx;
    this.nz = nz;

    // ── cell ranges (boxes are registered with a small padding so that boundary cases are covered) ──
    const range = new Int32Array(n * 4);
    for (let i = 0; i < n; i++) {
      if (cls[i] !== 0) continue;
      const p = i * 6;
      range[i * 4] = this.cellX(bb[p] - pad);
      range[i * 4 + 1] = this.cellX(bb[p + 3] + pad);
      range[i * 4 + 2] = this.cellZ(bb[p + 2] - pad);
      range[i * 4 + 3] = this.cellZ(bb[p + 5] + pad);
    }
    // A box covering more than `threshold` cells goes to the always-tested list; the threshold is lowered
    // until the total number of (cell, box) entries fits the budget.
    const largeOpt = opts.largeBoxCells;
    let threshold = largeOpt !== undefined && largeOpt >= 1 ? Math.floor(largeOpt) : DEFAULT_LARGE_BOX_CELLS;
    let entries = 0;
    for (;;) {
      entries = 0;
      for (let i = 0; i < n; i++) {
        if (cls[i] !== 0) continue;
        const cells = (range[i * 4 + 1] - range[i * 4] + 1) * (range[i * 4 + 3] - range[i * 4 + 2] + 1);
        if (cells <= threshold) entries += cells;
      }
      if (entries <= MAX_GRID_ENTRIES || threshold <= 1) break;
      threshold = Math.floor(threshold / 2);
    }
    const cellStart = new Int32Array(nx * nz + 1);
    const large: number[] = [];
    const gridded: number[] = [];
    for (let i = 0; i < n; i++) {
      if (cls[i] === 2) continue;
      const i0 = range[i * 4];
      const i1 = range[i * 4 + 1];
      const j0 = range[i * 4 + 2];
      const j1 = range[i * 4 + 3];
      if (cls[i] === 1 || (i1 - i0 + 1) * (j1 - j0 + 1) > threshold) {
        large.push(i);
        continue;
      }
      gridded.push(i);
      for (let j = j0; j <= j1; j++) {
        const row = j * nx;
        for (let c = row + i0; c <= row + i1; c++) cellStart[c + 1]++;
      }
    }
    for (let c = 0; c < nx * nz; c++) cellStart[c + 1] += cellStart[c];
    const cellItems = new Int32Array(entries);
    const cursor = cellStart.slice(0, nx * nz);
    for (let k = 0; k < gridded.length; k++) {
      const i = gridded[k];
      const i0 = range[i * 4];
      const i1 = range[i * 4 + 1];
      const j0 = range[i * 4 + 2];
      const j1 = range[i * 4 + 3];
      for (let j = j0; j <= j1; j++) {
        const row = j * nx;
        for (let c = row + i0; c <= row + i1; c++) cellItems[cursor[c]++] = i;
      }
    }
    this.cellStart = cellStart;
    this.cellItems = cellItems;
    this.large = Int32Array.from(large);
    this.gridded = Int32Array.from(gridded);
    this.cellCost = entries / (nx * nz) + 2;
    this.stamp = new Uint32Array(n);
    this.cand = new Int32Array(n);
  }

  private addBox(src: Box, barrierId: string | null, material: SolidMaterial): void {
    // min/max are normalised so that an inverted definition still describes the same solid region.
    const wb: WorldBox = {
      min: Object.freeze(v3(Math.min(src.min.x, src.max.x), Math.min(src.min.y, src.max.y), Math.min(src.min.z, src.max.z))),
      max: Object.freeze(v3(Math.max(src.min.x, src.max.x), Math.max(src.min.y, src.max.y), Math.max(src.min.z, src.max.z))),
      active: true,
      barrierId,
      material,
    };
    this.boxes.push(wb);
    if (barrierId !== null) {
      const list = this.barrierBoxes.get(barrierId);
      if (list) list.push(wb);
      else this.barrierBoxes.set(barrierId, [wb]);
    }
  }

  /** Layout of the spatial index (diagnostics, tests, tools). */
  getGridInfo(): WorldGridInfo {
    return {
      cellSize: this.cs,
      originX: this.gx0,
      originZ: this.gz0,
      nx: this.nx,
      nz: this.nz,
      griddedBoxes: this.gridded.length,
      largeBoxes: this.large.length,
      deadBoxes: this.deadCount,
      entries: this.cellItems.length,
    };
  }

  /** Closes every barrier and the final gate (start of a sortie). */
  resetBarriers(): void {
    for (const list of this.barrierBoxes.values()) for (const b of list) b.active = true;
  }

  setBarrierOpen(id: string, open: boolean): void {
    const list = this.barrierBoxes.get(id);
    if (list) for (const b of list) b.active = !open;
  }

  isBarrierOpen(id: string): boolean {
    const list = this.barrierBoxes.get(id);
    return !!list && list.every((b) => !b.active);
  }

  /**
   * Nearest hit of the ray origin + dir*t (dir unit length, 0 <= t <= maxDist) with an active box, or null.
   * `maxDist` may be Infinity. Pass `out` to reuse a result object instead of allocating one.
   * (With a non-unit `dir`, `dist` and `maxDist` are simply measured in units of |dir|.)
   */
  raycast(origin: V3, dir: V3, maxDist: number, out?: RayHit): RayHit | null {
    if (!(maxDist >= 0) || !finite3(origin) || !finite3(dir)) return null;
    const rf = this.rf;
    rf[R_OX] = origin.x;
    rf[R_OY] = origin.y;
    rf[R_OZ] = origin.z;
    rf[R_DX] = dir.x;
    rf[R_DY] = dir.y;
    rf[R_DZ] = dir.z;
    rf[R_TMIN] = 0;
    rf[R_TMAX] = maxDist;
    this.rStrict = false;
    this.prepareRay();
    let found = this.cast(false);
    // The ray lies exactly in a face plane of some box: decide grazing vs. seam with the exact procedure.
    if (this.hDegenerate) found = this.castExact();
    if (!found) return null;
    const t = rf[R_BEST] + 0; // normalises -0
    const box = this.boxes[this.hIdx];
    const hit: RayHit = out ?? { dist: 0, point: v3(), normal: v3(), box };
    hit.dist = t;
    hit.point.x = origin.x + dir.x * t;
    hit.point.y = origin.y + dir.y * t;
    hit.point.z = origin.z + dir.z * t;
    const sign = this.hSign;
    const axis = this.hAxis;
    hit.normal.x = axis === 0 ? sign : 0;
    hit.normal.y = axis === 1 ? sign : 0;
    hit.normal.z = axis === 2 ? sign : 0;
    hit.box = box;
    return hit;
  }

  /**
   * True when the straight segment a→b is blocked by an active box. Line of sight = !segmentBlocked(a, b).
   * A segment shorter than 1e-9 m is never blocked; an end point that only touches a surface is not blocked.
   */
  segmentBlocked(a: V3, b: V3): boolean {
    if (!finite3(a) || !finite3(b)) return false;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    if (!(dx * dx + dy * dy + dz * dz >= 1e-18)) return false;
    // Parametrised over s in [0, 1] with the unnormalised direction, so the end point is exactly s = 1.
    const rf = this.rf;
    rf[R_OX] = a.x;
    rf[R_OY] = a.y;
    rf[R_OZ] = a.z;
    rf[R_DX] = dx;
    rf[R_DY] = dy;
    rf[R_DZ] = dz;
    rf[R_TMIN] = 0;
    rf[R_TMAX] = 1;
    this.rStrict = true;
    this.prepareRay();
    if (this.cast(true)) return true;
    return this.hDegenerate ? this.castExact() : false;
  }

  /** True when the box (center, half) overlaps an active box. Touching faces do not count. */
  overlapsBox(center: V3, half: V3): boolean {
    const x0 = center.x - half.x;
    const x1 = center.x + half.x;
    const y0 = center.y - half.y;
    const y1 = center.y + half.y;
    const z0 = center.z - half.z;
    const z1 = center.z + half.z;
    const bb = this.bb;
    const boxes = this.boxes;
    const large = this.large;
    for (let k = 0; k < large.length; k++) {
      const i = large[k];
      const p = i * 6;
      if (x1 > bb[p] && x0 < bb[p + 3] && y1 > bb[p + 1] && y0 < bb[p + 4] && z1 > bb[p + 2] && z0 < bb[p + 5] && boxes[i].active) {
        return true;
      }
    }
    // Outside the region of the gridded boxes (also catches NaN input).
    if (!(x1 > this.bx0 && x0 < this.bx1 && y1 > this.by0 && y0 < this.by1 && z1 > this.bz0 && z0 < this.bz1)) return false;
    // Cell range under the box (the min/max only matter for a negative half extent, which the comparisons
    // above accept as given). Indices are clamped into the grid.
    const gx0 = this.gx0;
    const gz0 = this.gz0;
    const inv = this.invCs;
    const nx = this.nx;
    const iMax = nx - 1;
    const jMax = this.nz - 1;
    let i0 = Math.floor(((x0 < x1 ? x0 : x1) - gx0) * inv);
    let i1 = Math.floor(((x0 < x1 ? x1 : x0) - gx0) * inv);
    let j0 = Math.floor(((z0 < z1 ? z0 : z1) - gz0) * inv);
    let j1 = Math.floor(((z0 < z1 ? z1 : z0) - gz0) * inv);
    if (i0 < 0) i0 = 0;
    else if (i0 > iMax) i0 = iMax;
    if (i1 > iMax) i1 = iMax;
    else if (i1 < 0) i1 = 0;
    if (j0 < 0) j0 = 0;
    else if (j0 > jMax) j0 = jMax;
    if (j1 > jMax) j1 = jMax;
    else if (j1 < 0) j1 = 0;
    if ((i1 - i0 + 1) * (j1 - j0 + 1) * this.cellCost > this.gridded.length) {
      const all = this.gridded;
      for (let k = 0; k < all.length; k++) {
        const i = all[k];
        const p = i * 6;
        if (x1 > bb[p] && x0 < bb[p + 3] && y1 > bb[p + 1] && y0 < bb[p + 4] && z1 > bb[p + 2] && z0 < bb[p + 5] && boxes[i].active) {
          return true;
        }
      }
      return false;
    }
    const cellStart = this.cellStart;
    const items = this.cellItems;
    for (let j = j0; j <= j1; j++) {
      const row = j * nx;
      for (let c = row + i0; c <= row + i1; c++) {
        const kEnd = cellStart[c + 1];
        for (let k = cellStart[c]; k < kEnd; k++) {
          const i = items[k];
          const p = i * 6;
          if (x1 > bb[p] && x0 < bb[p + 3] && y1 > bb[p + 1] && y0 < bb[p + 4] && z1 > bb[p + 2] && z0 < bb[p + 5] && boxes[i].active) {
            return true;
          }
        }
      }
    }
    return false;
  }

  /**
   * Fills `out` (previous content is discarded) with the active boxes that overlap the region [min, max]
   * (strictly, like overlapsBox: touching faces do not count), in ascending order of their index in `boxes`.
   * Returns `out`.
   */
  boxesInAabb(min: V3, max: V3, out: WorldBox[]): WorldBox[] {
    const x0 = min.x;
    const y0 = min.y;
    const z0 = min.z;
    const x1 = max.x;
    const y1 = max.y;
    const z1 = max.z;
    const qf = this.qf;
    qf[0] = x0 < x1 ? x0 : x1;
    qf[1] = y0 < y1 ? y0 : y1;
    qf[2] = z0 < z1 ? z0 : z1;
    qf[3] = x0 < x1 ? x1 : x0;
    qf[4] = y0 < y1 ? y1 : y0;
    qf[5] = z0 < z1 ? z1 : z0;
    const m = this.gather();
    const cand = this.cand;
    const bb = this.bb;
    let w = 0;
    for (let k = 0; k < m; k++) {
      const i = cand[k];
      const p = i * 6;
      if (x1 > bb[p] && x0 < bb[p + 3] && y1 > bb[p + 1] && y0 < bb[p + 4] && z1 > bb[p + 2] && z0 < bb[p + 5]) cand[w++] = i;
    }
    if (w > 64) {
      cand.subarray(0, w).sort();
    } else {
      // insertion sort: no allocation for the usual handful of boxes
      for (let k = 1; k < w; k++) {
        const v = cand[k];
        let j = k - 1;
        while (j >= 0 && cand[j] > v) {
          cand[j + 1] = cand[j];
          j--;
        }
        cand[j + 1] = v;
      }
    }
    // overwrite in place and trim, so that a reused array keeps its storage
    const boxes = this.boxes;
    const have = out.length;
    for (let k = 0; k < w; k++) {
      if (k < have) out[k] = boxes[cand[k]];
      else out.push(boxes[cand[k]]);
    }
    if (have > w) out.length = w;
    return out;
  }

  /**
   * Continuous collide-and-slide. Moves `center` (mutated) by `delta` as far as the active boxes allow:
   * on contact the box stops SKIN short of the surface, the blocked component of the remaining motion is
   * removed and the rest continues along the surface. Never tunnels, whatever the length of `delta`.
   * Boxes that genuinely overlap the moving box at its start position are ignored (see CONTACT_EPS).
   */
  moveBox(center: V3, half: V3, delta: V3, out: MoveResult = { nx: 0, ny: 0, nz: 0 }): MoveResult {
    out.nx = 0;
    out.ny = 0;
    out.nz = 0;
    if (!finite3(center) || !finite3(half) || !finite3(delta)) return out;
    let cx = center.x;
    let cy = center.y;
    let cz = center.z;
    const hx = half.x;
    const hy = half.y;
    const hz = half.z;
    let rx = delta.x;
    let ry = delta.y;
    let rz = delta.z;
    // A displacement below 1e-12 m is dropped (it could otherwise creep through the contact band unseen).
    if (rx > -PARALLEL_EPS && rx < PARALLEL_EPS) rx = 0;
    if (ry > -PARALLEL_EPS && ry < PARALLEL_EPS) ry = 0;
    if (rz > -PARALLEL_EPS && rz < PARALLEL_EPS) rz = 0;
    if (rx === 0 && ry === 0 && rz === 0) return out;

    // Every position reached during the slide stays inside the bounds of the full sweep: gather once.
    const slack =
      this.pad + 1e-12 * (Math.abs(cx) + Math.abs(cy) + Math.abs(cz) + Math.abs(rx) + Math.abs(ry) + Math.abs(rz));
    const gx = Math.abs(hx) + slack;
    const gy = Math.abs(hy) + slack;
    const gz = Math.abs(hz) + slack;
    const qf = this.qf;
    qf[0] = (rx < 0 ? cx + rx : cx) - gx;
    qf[1] = (ry < 0 ? cy + ry : cy) - gy;
    qf[2] = (rz < 0 ? cz + rz : cz) - gz;
    qf[3] = (rx > 0 ? cx + rx : cx) + gx;
    qf[4] = (ry > 0 ? cy + ry : cy) + gy;
    qf[5] = (rz > 0 ? cz + rz : cz) + gz;
    const m = this.gather();
    const cand = this.cand;
    const bb = this.bb;

    // Each contact removes one axis for good, so three contacts plus the final free move are the maximum.
    for (let iter = 0; iter < 4; iter++) {
      let bestT = Infinity;
      let bestIdx = -1;
      let bestAxis = 0;
      let bestSign = 0;
      for (let k = 0; k < m; k++) {
        const i = cand[k];
        const p = i * 6;
        let tEnter = -Infinity;
        let tExit = Infinity;
        let axis = 0;
        let sign = 0;

        // X slab of the obstacle grown by the half extents; positions inside the contact band snap to the face
        let lo = bb[p] - hx;
        let hi = bb[p + 3] + hx;
        let o = cx;
        if (o > lo && o - lo <= CONTACT_EPS) o = lo;
        else if (o < hi && hi - o <= CONTACT_EPS) o = hi;
        if (rx === 0) {
          if (o <= lo || o >= hi) continue;
        } else {
          let t1 = (lo - o) / rx;
          let t2 = (hi - o) / rx;
          let s = -1;
          if (t1 > t2) {
            const tmp = t1;
            t1 = t2;
            t2 = tmp;
            s = 1;
          }
          if (t1 > tEnter) {
            tEnter = t1;
            axis = 0;
            sign = s;
          }
          if (t2 < tExit) tExit = t2;
          if (tEnter >= tExit) continue;
        }

        // Y
        lo = bb[p + 1] - hy;
        hi = bb[p + 4] + hy;
        o = cy;
        if (o > lo && o - lo <= CONTACT_EPS) o = lo;
        else if (o < hi && hi - o <= CONTACT_EPS) o = hi;
        if (ry === 0) {
          if (o <= lo || o >= hi) continue;
        } else {
          let t1 = (lo - o) / ry;
          let t2 = (hi - o) / ry;
          let s = -1;
          if (t1 > t2) {
            const tmp = t1;
            t1 = t2;
            t2 = tmp;
            s = 1;
          }
          if (t1 > tEnter) {
            tEnter = t1;
            axis = 1;
            sign = s;
          }
          if (t2 < tExit) tExit = t2;
          if (tEnter >= tExit) continue;
        }

        // Z
        lo = bb[p + 2] - hz;
        hi = bb[p + 5] + hz;
        o = cz;
        if (o > lo && o - lo <= CONTACT_EPS) o = lo;
        else if (o < hi && hi - o <= CONTACT_EPS) o = hi;
        if (rz === 0) {
          if (o <= lo || o >= hi) continue;
        } else {
          let t1 = (lo - o) / rz;
          let t2 = (hi - o) / rz;
          let s = -1;
          if (t1 > t2) {
            const tmp = t1;
            t1 = t2;
            t2 = tmp;
            s = 1;
          }
          if (t1 > tEnter) {
            tEnter = t1;
            axis = 2;
            sign = s;
          }
          if (t2 < tExit) tExit = t2;
          if (tEnter >= tExit) continue;
        }

        // tExit <= 0: already past it / moving away. tEnter < 0: genuinely overlapping at the start → ignored.
        if (tExit <= 0 || tEnter < 0 || tEnter > 1) continue;
        if (tEnter < bestT || (tEnter === bestT && i < bestIdx)) {
          bestT = tEnter;
          bestIdx = i;
          bestAxis = axis;
          bestSign = sign;
        }
      }

      if (bestIdx < 0) {
        cx += rx;
        cy += ry;
        cz += rz;
        break;
      }
      // Stop where the gap along the contact normal is SKIN (or stay put when already closer than that).
      const ra = bestAxis === 0 ? rx : bestAxis === 1 ? ry : rz;
      let t = bestT - SKIN / (ra < 0 ? -ra : ra);
      if (!(t > 0)) t = 0;
      cx += rx * t;
      cy += ry * t;
      cz += rz * t;
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
      if (rx > -PARALLEL_EPS && rx < PARALLEL_EPS) rx = 0;
      if (ry > -PARALLEL_EPS && ry < PARALLEL_EPS) ry = 0;
      if (rz > -PARALLEL_EPS && rz < PARALLEL_EPS) rz = 0;
      if (rx === 0 && ry === 0 && rz === 0) break;
    }
    center.x = cx;
    center.y = cy;
    center.z = cz;
    return out;
  }

  /**
   * Distance from the bottom face of the box (center, half) down to the nearest supporting surface,
   * searching at most `maxDist`. Returns Infinity when nothing is within reach. ~SKIN when resting.
   * A surface supports the box when moveBox would stop a straight downward move on it: the footprints
   * overlap by more than CONTACT_EPS and the surface is not more than CONTACT_EPS above the bottom face.
   * A box that moveBox has put down rests between 0 and SKIN above the surface, so "am I standing on
   * something" should probe with a `maxDist` comfortably above SKIN (0.01 … 0.05 m).
   */
  probeGround(center: V3, half: V3, maxDist: number): number {
    if (!(maxDist >= 0) || !finite3(center) || !finite3(half)) return Infinity;
    const cx = center.x;
    const cz = center.z;
    const hx = half.x;
    const hz = half.z;
    const bottom = center.y - half.y;
    const slack = this.pad + 1e-12 * (Math.abs(cx) + Math.abs(bottom) + Math.abs(cz));
    const gx = Math.abs(hx) + slack;
    const gz = Math.abs(hz) + slack;
    const qf = this.qf;
    qf[0] = cx - gx;
    qf[1] = bottom - maxDist - slack;
    qf[2] = cz - gz;
    qf[3] = cx + gx;
    qf[4] = bottom + CONTACT_EPS + slack;
    qf[5] = cz + gz;
    const m = this.gather();
    const cand = this.cand;
    const bb = this.bb;
    let best = Infinity;
    for (let k = 0; k < m; k++) {
      const p = cand[k] * 6;
      if (!(cx - (bb[p] - hx) > CONTACT_EPS && bb[p + 3] + hx - cx > CONTACT_EPS)) continue;
      if (!(cz - (bb[p + 2] - hz) > CONTACT_EPS && bb[p + 5] + hz - cz > CONTACT_EPS)) continue;
      const gap = bottom - bb[p + 4];
      if (gap < -CONTACT_EPS || gap > maxDist) continue;
      if (gap < best) best = gap;
    }
    return best < 0 ? 0 : best;
  }

  /** Id of the sector containing the point, or null. */
  sectorAt(p: V3): string | null {
    for (const s of this.stage.sectors) {
      for (const b of s.bounds) {
        if (p.x >= b.min.x && p.x <= b.max.x && p.y >= b.min.y && p.y <= b.max.y && p.z >= b.min.z && p.z <= b.max.z) {
          return s.id;
        }
      }
    }
    return null;
  }

  // ───────────────────────────── internals ─────────────────────────────

  /** Grid column of a world X coordinate, clamped into the grid (construction only). */
  private cellX(x: number): number {
    const i = Math.floor((x - this.gx0) * this.invCs);
    return i >= this.nx ? this.nx - 1 : i > 0 ? i : 0;
  }

  /** Grid row of a world Z coordinate, clamped into the grid (construction only). */
  private cellZ(z: number): number {
    const j = Math.floor((z - this.gz0) * this.invCs);
    return j >= this.nz ? this.nz - 1 : j > 0 ? j : 0;
  }

  private nextQuery(): number {
    let q = this.queryId + 1;
    if (q > 0xffffffff) {
      this.stamp.fill(0);
      q = 1;
    }
    this.queryId = q;
    return q;
  }

  /**
   * Collects into `cand` the indices of the active boxes whose closed bounds intersect the closed region in
   * `qf` (each box once). The caller stores a region (min <= max) that is already enlarged by its tolerance.
   * Returns the count.
   */
  private gather(): number {
    const qf = this.qf;
    const x0 = qf[0];
    const y0 = qf[1];
    const z0 = qf[2];
    const x1 = qf[3];
    const y1 = qf[4];
    const z1 = qf[5];
    const bb = this.bb;
    const boxes = this.boxes;
    const cand = this.cand;
    let m = 0;
    const large = this.large;
    for (let k = 0; k < large.length; k++) {
      const i = large[k];
      const p = i * 6;
      if (bb[p] <= x1 && bb[p + 3] >= x0 && bb[p + 1] <= y1 && bb[p + 4] >= y0 && bb[p + 2] <= z1 && bb[p + 5] >= z0 && boxes[i].active) {
        cand[m++] = i;
      }
    }
    // Outside the region of the gridded boxes (also catches NaN input).
    if (!(x1 >= this.bx0 && x0 <= this.bx1 && y1 >= this.by0 && y0 <= this.by1 && z1 >= this.bz0 && z0 <= this.bz1)) return m;
    // cell range under the region, clamped into the grid
    const inv = this.invCs;
    const nx = this.nx;
    const iMax = nx - 1;
    const jMax = this.nz - 1;
    let i0 = Math.floor((x0 - this.gx0) * inv);
    let i1 = Math.floor((x1 - this.gx0) * inv);
    let j0 = Math.floor((z0 - this.gz0) * inv);
    let j1 = Math.floor((z1 - this.gz0) * inv);
    if (i0 < 0) i0 = 0;
    else if (i0 > iMax) i0 = iMax;
    if (i1 > iMax) i1 = iMax;
    else if (i1 < 0) i1 = 0;
    if (j0 < 0) j0 = 0;
    else if (j0 > jMax) j0 = jMax;
    if (j1 > jMax) j1 = jMax;
    else if (j1 < 0) j1 = 0;
    if ((i1 - i0 + 1) * (j1 - j0 + 1) * this.cellCost > this.gridded.length) {
      const all = this.gridded;
      for (let k = 0; k < all.length; k++) {
        const i = all[k];
        const p = i * 6;
        if (bb[p] <= x1 && bb[p + 3] >= x0 && bb[p + 1] <= y1 && bb[p + 4] >= y0 && bb[p + 2] <= z1 && bb[p + 5] >= z0 && boxes[i].active) {
          cand[m++] = i;
        }
      }
      return m;
    }
    const q = this.nextQuery();
    const stamp = this.stamp;
    const cellStart = this.cellStart;
    const items = this.cellItems;
    for (let j = j0; j <= j1; j++) {
      const row = j * nx;
      for (let c = row + i0; c <= row + i1; c++) {
        const kEnd = cellStart[c + 1];
        for (let k = cellStart[c]; k < kEnd; k++) {
          const i = items[k];
          if (stamp[i] === q) continue;
          stamp[i] = q;
          const p = i * 6;
          if (bb[p] <= x1 && bb[p + 3] >= x0 && bb[p + 1] <= y1 && bb[p + 4] >= y0 && bb[p + 2] <= z1 && bb[p + 5] >= z0 && boxes[i].active) {
            cand[m++] = i;
          }
        }
      }
    }
    return m;
  }

  /** Derives the "no motion along this axis" flags of the ray stored in `rf` and resets the side convention. */
  private prepareRay(): void {
    const rf = this.rf;
    const dx = rf[R_DX];
    const dy = rf[R_DY];
    const dz = rf[R_DZ];
    this.rPx = dx > -PARALLEL_EPS && dx < PARALLEL_EPS;
    this.rPy = dy > -PARALLEL_EPS && dy < PARALLEL_EPS;
    this.rPz = dz > -PARALLEL_EPS && dz < PARALLEL_EPS;
    this.rSideX = 0;
    this.rSideY = 0;
    this.rSideZ = 0;
  }

  /**
   * Exact slab test of the current ray against box i; keeps the best hit in rf[R_BEST] / hIdx / hAxis / hSign.
   *
   * The box is hit when the ray is inside its open interior for some parameter range (tEnter, tExit) that
   * reaches beyond tMin; the hit parameter is max(tEnter, tMin). Ties go to the lowest box index.
   * On an axis the ray does not move along, the origin must lie inside the slab. With side 0 the slab is
   * open and an origin exactly on a face only raises `hDegenerate`; side +1 / -1 evaluate the ray shifted
   * infinitesimally towards +axis / -axis (slab [lo, hi) / (lo, hi]) for the exact procedure.
   */
  private testRay(i: number): void {
    const bb = this.bb;
    const rf = this.rf;
    const p = i * 6;
    const tMin = rf[R_TMIN];
    let tEnter = -Infinity;
    let tExit = Infinity;
    let axis = 0;
    let sign = 0;

    // X
    let lo = bb[p];
    let hi = bb[p + 3];
    let o = rf[R_OX];
    if (this.rPx) {
      const side = this.rSideX;
      if (side === 0) {
        if (o <= lo || o >= hi) {
          if ((o === lo || o === hi) && lo < hi && this.boxes[i].active) this.hDegenerate = true;
          return;
        }
      } else if (side > 0 ? o < lo || o >= hi : o <= lo || o > hi) return;
    } else {
      const d = rf[R_DX];
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
        axis = 0;
        sign = s;
      }
      if (t2 < tExit) tExit = t2;
      if (tEnter >= tExit) return;
    }

    // Y
    lo = bb[p + 1];
    hi = bb[p + 4];
    o = rf[R_OY];
    if (this.rPy) {
      const side = this.rSideY;
      if (side === 0) {
        if (o <= lo || o >= hi) {
          if ((o === lo || o === hi) && lo < hi && this.boxes[i].active) this.hDegenerate = true;
          return;
        }
      } else if (side > 0 ? o < lo || o >= hi : o <= lo || o > hi) return;
    } else {
      const d = rf[R_DY];
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
        axis = 1;
        sign = s;
      }
      if (t2 < tExit) tExit = t2;
      if (tEnter >= tExit) return;
    }

    // Z
    lo = bb[p + 2];
    hi = bb[p + 5];
    o = rf[R_OZ];
    if (this.rPz) {
      const side = this.rSideZ;
      if (side === 0) {
        if (o <= lo || o >= hi) {
          if ((o === lo || o === hi) && lo < hi && this.boxes[i].active) this.hDegenerate = true;
          return;
        }
      } else if (side > 0 ? o < lo || o >= hi : o <= lo || o > hi) return;
    } else {
      const d = rf[R_DZ];
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
        axis = 2;
        sign = s;
      }
      if (t2 < tExit) tExit = t2;
      if (tEnter >= tExit) return;
    }

    if (tExit <= tMin) return; // behind the start / leaving through the face it starts on
    const inside = tEnter < tMin;
    const t = inside ? tMin : tEnter;
    const best = rf[R_BEST];
    if (t > best) return;
    if (this.rStrict && !(t < rf[R_TMAX])) return;
    if (t === best && this.hIdx >= 0 && i > this.hIdx) return;
    if (!this.boxes[i].active) return;
    rf[R_BEST] = t;
    this.hIdx = i;
    this.hAxis = axis;
    this.hSign = inside ? 0 : sign;
  }

  /**
   * First hit of the current ray for parameters in [rf[R_TMIN], rf[R_TMAX]] (with `rStrict` the hit must
   * begin before the end). `anyHit` returns at the first box found instead of the nearest one. Returns
   * whether there is a hit; the result is left in rf[R_BEST] / hIdx / hAxis / hSign and `hDegenerate` tells
   * that the exact procedure is needed.
   */
  private cast(anyHit: boolean): boolean {
    const rf = this.rf;
    const tMin = rf[R_TMIN];
    const tMax = rf[R_TMAX];
    rf[R_BEST] = tMax;
    this.hIdx = -1;
    this.hAxis = 0;
    this.hSign = 0;
    this.hDegenerate = false;

    const ox = rf[R_OX];
    const oy = rf[R_OY];
    const oz = rf[R_OZ];
    const dx = rf[R_DX];
    const dy = rf[R_DY];
    const dz = rf[R_DZ];
    const px = this.rPx;
    const pz = this.rPz;
    const bb = this.bb;

    // 1. always-tested boxes (skipped without a slab test when the bounds of the ray piece miss them)
    const large = this.large;
    const nLarge = large.length;
    if (nLarge > 0) {
      if (tMax < Infinity) {
        const span = tMax - tMin;
        const tol =
          this.pad +
          1e-12 * (Math.abs(ox) + Math.abs(oy) + Math.abs(oz) + (Math.abs(dx) + Math.abs(dy) + Math.abs(dz)) * (span > 0 ? span : 0));
        let x0 = ox + dx * tMin;
        let x1 = ox + dx * tMax;
        if (x0 > x1) {
          const tmp = x0;
          x0 = x1;
          x1 = tmp;
        }
        x0 -= tol;
        x1 += tol;
        let y0 = oy + dy * tMin;
        let y1 = oy + dy * tMax;
        if (y0 > y1) {
          const tmp = y0;
          y0 = y1;
          y1 = tmp;
        }
        y0 -= tol;
        y1 += tol;
        let z0 = oz + dz * tMin;
        let z1 = oz + dz * tMax;
        if (z0 > z1) {
          const tmp = z0;
          z0 = z1;
          z1 = tmp;
        }
        z0 -= tol;
        z1 += tol;
        for (let k = 0; k < nLarge; k++) {
          const i = large[k];
          const p = i * 6;
          if (bb[p + 1] > y1 || bb[p + 4] < y0 || bb[p] > x1 || bb[p + 3] < x0 || bb[p + 2] > z1 || bb[p + 5] < z0) continue;
          this.testRay(i);
          if (anyHit && this.hIdx >= 0) return true;
        }
      } else {
        for (let k = 0; k < nLarge; k++) {
          this.testRay(large[k]);
          if (anyHit && this.hIdx >= 0) return true;
        }
      }
    }
    const items = this.cellItems;
    if (items.length === 0) return this.hIdx >= 0;

    // 2. clip the parameter range to the region that contains every gridded box
    let t0 = tMin;
    let t1 = rf[R_BEST];
    if (px) {
      if (ox < this.bx0 || ox > this.bx1) return this.hIdx >= 0;
    } else {
      let a = (this.bx0 - ox) / dx;
      let b = (this.bx1 - ox) / dx;
      if (a > b) {
        const tmp = a;
        a = b;
        b = tmp;
      }
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
    }
    if (this.rPy) {
      if (oy < this.by0 || oy > this.by1) return this.hIdx >= 0;
    } else {
      let a = (this.by0 - oy) / dy;
      let b = (this.by1 - oy) / dy;
      if (a > b) {
        const tmp = a;
        a = b;
        b = tmp;
      }
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
    }
    if (pz) {
      if (oz < this.bz0 || oz > this.bz1) return this.hIdx >= 0;
    } else {
      let a = (this.bz0 - oz) / dz;
      let b = (this.bz1 - oz) / dz;
      if (a > b) {
        const tmp = a;
        a = b;
        b = tmp;
      }
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
    }
    if (!(t0 <= t1)) return this.hIdx >= 0;

    // 3. walk the cells along the ray (2D DDA in XZ)
    const gx0 = this.gx0;
    const gz0 = this.gz0;
    const cs = this.cs;
    const nx = this.nx;
    const nz = this.nz;
    const inv = this.invCs;
    let ci = Math.floor((ox + dx * t0 - gx0) * inv);
    let cj = Math.floor((oz + dz * t0 - gz0) * inv);
    if (!(ci > 0)) ci = 0;
    else if (ci >= nx) ci = nx - 1;
    if (!(cj > 0)) cj = 0;
    else if (cj >= nz) cj = nz - 1;
    let stepX = 0;
    let stepZ = 0;
    /** Parameter at which the ray leaves the current cell through its next X / Z boundary. */
    let tNextX = Infinity;
    let tNextZ = Infinity;
    if (!px) {
      if (dx > 0) {
        stepX = 1;
        tNextX = (gx0 + (ci + 1) * cs - ox) / dx;
      } else {
        stepX = -1;
        tNextX = (gx0 + ci * cs - ox) / dx;
      }
    }
    if (!pz) {
      if (dz > 0) {
        stepZ = 1;
        tNextZ = (gz0 + (cj + 1) * cs - oz) / dz;
      } else {
        stepZ = -1;
        tNextZ = (gz0 + cj * cs - oz) / dz;
      }
    }
    const cellStart = this.cellStart;
    const stamp = this.stamp;
    const q = this.nextQuery();
    const slack = this.pad + 1e-12 * (Math.abs(ox) + Math.abs(oy) + Math.abs(oz));
    let tIn = t0;
    for (;;) {
      let tOut = tNextX < tNextZ ? tNextX : tNextZ;
      if (tOut > t1) tOut = t1;
      if (tOut < tIn) tOut = tIn;
      const c = cj * nx + ci;
      let k = cellStart[c];
      const kEnd = cellStart[c + 1];
      if (k < kEnd) {
        // Bounds of the piece of the ray inside this cell (up to the best hit). A box whose hit point lies
        // on that piece necessarily touches these bounds, anything else is skipped without a slab test and
        // without being stamped (it may still matter in a later cell).
        const best = rf[R_BEST];
        const tHi = tOut < best ? tOut : best;
        let sx0 = ox + dx * tIn;
        let sx1 = ox + dx * tHi;
        if (sx0 > sx1) {
          const tmp = sx0;
          sx0 = sx1;
          sx1 = tmp;
        }
        sx0 -= slack;
        sx1 += slack;
        let sy0 = oy + dy * tIn;
        let sy1 = oy + dy * tHi;
        if (sy0 > sy1) {
          const tmp = sy0;
          sy0 = sy1;
          sy1 = tmp;
        }
        sy0 -= slack;
        sy1 += slack;
        let sz0 = oz + dz * tIn;
        let sz1 = oz + dz * tHi;
        if (sz0 > sz1) {
          const tmp = sz0;
          sz0 = sz1;
          sz1 = tmp;
        }
        sz0 -= slack;
        sz1 += slack;
        for (; k < kEnd; k++) {
          const i = items[k];
          const p = i * 6;
          if (bb[p + 1] > sy1 || bb[p + 4] < sy0 || bb[p] > sx1 || bb[p + 3] < sx0 || bb[p + 2] > sz1 || bb[p + 5] < sz0) continue;
          if (stamp[i] === q) continue;
          stamp[i] = q;
          this.testRay(i);
          if (anyHit && this.hIdx >= 0) return true;
        }
      }
      // Stop once the best hit lies strictly before the exit of this cell (an equal distance could still
      // be tied by a lower-index box in the next cell), or when the ray ends here.
      if (rf[R_BEST] < tOut || tOut >= t1) break;
      if (tNextX <= tNextZ) {
        ci += stepX;
        if (ci < 0 || ci >= nx) break;
        tNextX = (gx0 + (stepX > 0 ? ci + 1 : ci) * cs - ox) / dx;
      } else {
        cj += stepZ;
        if (cj < 0 || cj >= nz) break;
        tNextZ = (gz0 + (stepZ > 0 ? cj + 1 : cj) * cs - oz) / dz;
      }
      tIn = tOut;
    }
    return this.hIdx >= 0;
  }

  /**
   * Exact first hit for a ray that lies in a face plane of some box (only reached in that case).
   *
   * Such a ray is blocked at parameter t exactly when the rays shifted infinitesimally to every side of the
   * plane (2 sides per axis without motion: 2, 4 or 8 variants) are all inside a box right after t — i.e.
   * when it enters the interior of the union of the closed boxes. Each round casts every variant from the
   * current parameter; if all of them are blocked right there the ray is blocked, if one is never blocked
   * the ray is free, otherwise the search continues from the latest of the variants' hits.
   */
  private castExact(): boolean {
    const rf = this.rf;
    const px = this.rPx;
    const py = this.rPy;
    const pz = this.rPz;
    const nVar = 1 << ((px ? 1 : 0) + (py ? 1 : 0) + (pz ? 1 : 0));
    const vT = this.vT;
    const vIdx = this.vIdx;
    const vAxis = this.vAxis;
    const vSign = this.vSign;
    // Every advancing round moves to the entry parameter of another box, so this bound is never reached.
    const maxRounds = 2 * this.boxes.length + 4;
    let t = 0;
    let found = false;
    for (let round = 0; round < maxRounds; round++) {
      let tNext = t;
      let open = false;
      for (let v = 0; v < nVar; v++) {
        let bit = 0;
        this.rSideX = px ? ((v >> bit++) & 1 ? 1 : -1) : 0;
        this.rSideY = py ? ((v >> bit++) & 1 ? 1 : -1) : 0;
        this.rSideZ = pz ? ((v >> bit++) & 1 ? 1 : -1) : 0;
        rf[R_TMIN] = t;
        if (!this.cast(false)) {
          open = true;
          break;
        }
        const tv = rf[R_BEST];
        vT[v] = tv;
        vIdx[v] = this.hIdx;
        vAxis[v] = this.hAxis;
        vSign[v] = this.hSign;
        if (tv > tNext) tNext = tv;
      }
      if (open) break;
      if (tNext === t || round === maxRounds - 1) {
        // Blocked here. Report the surface entered at t (first variant that enters rather than is inside).
        let pick = 0;
        for (let v = 0; v < nVar; v++) {
          if (vSign[v] !== 0 && vT[v] === tNext) {
            pick = v;
            break;
          }
        }
        rf[R_BEST] = tNext;
        this.hIdx = vIdx[pick];
        this.hAxis = vAxis[pick];
        this.hSign = vT[pick] === tNext ? vSign[pick] : 0;
        found = true;
        break;
      }
      t = tNext;
    }
    rf[R_TMIN] = 0;
    this.rSideX = 0;
    this.rSideY = 0;
    this.rSideZ = 0;
    if (!found) this.hIdx = -1;
    return found;
  }
}
