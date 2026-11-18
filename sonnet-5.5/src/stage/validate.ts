/**
 * Stage validator (SPEC §2.1 / §2.2 / §11).  OWNER: stagecheck agent.
 *
 * `validateStage(stage)` is a pure function: it builds the REAL collision world (`new World(stage.boxes)`) and checks the
 * stage requirements against real collision shapes and the REAL player physics (`Game` from src/sim is driven tick by tick
 * for the flight-climb checks).  Nothing here changes the stage or any simulation parameter.
 *
 * Method summary (limits are documented in docs/STAGE.md and the tool output):
 *  - shortest route: 3D voxel grid (player-AABB configuration space) -> A* whose every edge is re-verified with the exact
 *    continuous `sweepAABB` -> taut-string smoothing (also verified with `sweepAABB`).  The smoothed length is an UPPER bound of the
 *    true shortest length (a feasible route); a second run with a slightly thinner player gives an optimistic estimate.
 *  - topology: sector connection graph built from the real free space (voxel adjacency across sector borders, each opening
 *    re-verified with `sweepAABB`), cycles enumerated on the multigraph.
 *  - climbs: bot-driven `Game` runs on the stage's own boxes for all 18 loadouts (straight-up, diagonal and path-following
 *    controllers; the first one that lands wins).
 *
 * Limits (also written to docs/STAGE.md): the route length is an upper bound with a typical error < 1 % and up to ~2.5 % on
 * complex geometry; free-space gaps narrower than the grid step are only covered by the portal lane sweeps; branches / loops that
 * live entirely inside one sector are not visible to the sector graph.
 */
import { CAMERA, ENEMIES, FCS_PARTS, GENERATOR_PARTS, GRAVITY, LEGS_PARTS, PLAYER, SIM, STAGE } from '../config';
import type { FcsId, GeneratorId, LegsId } from '../config';
import { createEnemies, enemyMuzzlePosition } from '../sim/enemies';
import { Game } from '../sim/game';
import { World } from '../sim/world';
import type { AABB, ClimbDef, EnemyState, Loadout, PortalDef, SectorDef, StageDef, V3 } from '../sim/types';

// ---------------------------------------------------------------------------------------------------------------------
// Public report types
// ---------------------------------------------------------------------------------------------------------------------
export interface CheckResult {
  /** stable machine id, e.g. "route.length" */
  name: string;
  /** short Japanese label */
  label: string;
  pass: boolean;
  value: number | string | boolean;
  threshold: string;
  details: string;
  /** advisory checks are shown but do not affect `StageReport.pass` */
  advisory?: boolean;
}

export interface RouteReport {
  found: boolean;
  /** smoothed, sweepAABB-verified polyline (player-center coordinates) */
  points: V3[];
  /** length of `points` (upper bound of the true shortest route) */
  length: number;
  /** length of the raw grid A* polyline before smoothing */
  gridLength: number;
  /** optimistic estimate with a thinner player (null when not computed) */
  relaxedLength: number | null;
  /** straight-line distance start -> nearest point of the escape zone (lower bound) */
  straightLength: number;
  /** sectors the route centre passed through in order (objective.ts rule: first sector whose bounds contain the point) */
  sectors: string[];
  sectorEntries: { sectorId: string; atMeters: number }[];
  barrierCrossings: { barrierId: string; atMeters: number; point: V3 }[];
  gridStep: number;
  note: string;
}

export interface ConnectionInfo {
  id: string;
  a: string;
  b: string;
  center: V3;
  samples: number;
  portalId: string | null;
}

export interface TopologyStructure {
  sectors: string[];
  connectionIds: string[];
  /** real perimeter (portal chain, shortest free path inside each sector) */
  perimeter: number;
  /** the two routes (arcs) when the cycle is split at the two portals that maximise the shorter arc (each must be >= 40 m) */
  arcs: [number, number];
  /** fraction of each arc that is > 10 m away from the other arc (both must be >= 0.4: the two routes really differ) */
  separation: [number, number];
  qualifies: boolean;
}

export interface DeclaredRouteResult {
  id: string;
  ok: boolean;
  length: number;
  declaredLength: number | null;
  sectors: string[];
  problems: string[];
}

export interface DeclaredBranchResult {
  id: string;
  ok: boolean;
  split: string;
  merge: string;
  edgeDisjointPaths: number;
  routes: DeclaredRouteResult[];
  problems: string[];
}

export interface ClimbConfigResult {
  fcs: FcsId;
  generator: GeneratorId;
  legs: LegsId;
  success: boolean;
  strategy: string | null;
  enStart: number;
  enUsed: number;
  enMin: number;
  flightSeconds: number;
  timeSeconds: number;
  failure: string | null;
}

export interface ClimbResult {
  id: string;
  sectorId: string;
  from: V3;
  to: V3;
  declaredHeight: number;
  measuredHeight: number;
  heightOk: boolean;
  platformsOk: boolean;
  jumpMaxRise: number;
  jumpReaches: boolean;
  onPath: boolean;
  /** distance from the shortest route to the from->to segment (-1 when there is no route) */
  pathDistance: number;
  configs: ClimbConfigResult[];
  allConfigsOk: boolean;
  /** largest EN consumed over the 18 configurations */
  maxEnUsed: number;
  /** minimum max-EN over the configurations (90 for the recovery generator) */
  minMaxEn: number;
  notes: string[];
}

export interface CombatSectorInfo {
  sectorId: string;
  enemies: number;
  samples: number;
  /** max number of enemies (in this sector, in range) with line of sight to one floor sample */
  bestVisible: number;
  bestPoint: V3 | null;
  qualifies: boolean;
}

export interface ArenaInfo {
  sectorId: string;
  floorCells: number;
  bestRect: { width: number; depth: number } | null;
  has60x50: boolean;
  declaredCombat: boolean;
}

export interface EnemyCheckRow {
  id: string;
  kind: string;
  sectorId: string;
  problems: string[];
}

export interface BarrierStateRow {
  label: string;
  closed: string[];
  goalReachable: boolean;
  reachableSectors: string[];
  confirmedLength: number | null;
}

export interface StageReport {
  stageName: string;
  /** every non-advisory check passed */
  pass: boolean;
  checks: CheckResult[];
  route: RouteReport;
  connections: ConnectionInfo[];
  structures: TopologyStructure[];
  declaredBranches: DeclaredBranchResult[];
  declaredLoops: DeclaredRouteResult[];
  climbs: ClimbResult[];
  arenas: ArenaInfo[];
  combat: CombatSectorInfo[];
  enemyRows: EnemyCheckRow[];
  barrierStates: BarrierStateRow[];
  minSectorHops: { count: number; sectors: string[] };
  layers: { y: number; area: number }[];
  warnings: string[];
  timingsMs: Record<string, number>;
}

export interface ValidateOptions {
  /** voxel size of the coarse route grid [m] (default 2; auto-increased for very large stages) */
  gridStep?: number;
  /** run the bot-driven flight checks (default true) */
  runClimbBot?: boolean;
  /** also compute the optimistic (thin player) route length (default true) */
  relaxedRoute?: boolean;
  /** also run the route search on a 1.5x coarser grid and keep the shorter route (default true) */
  altRouteGrid?: boolean;
  /** restrict the flight bot to these loadouts (default: all 18) */
  loadouts?: Loadout[];
  /** progress callback */
  onProgress?: (msg: string) => void;
}

// ---------------------------------------------------------------------------------------------------------------------
// Constants (thresholds come from the SPEC; player/enemy numbers from config.ts)
// ---------------------------------------------------------------------------------------------------------------------
export const LIMITS_STAGE = {
  SECTOR_MIN: STAGE.SECTOR_MIN,
  KIND_MIN: 6,
  ROUTE_MIN_METERS: STAGE.ROUTE_MIN_METERS,
  ROUTE_SECTORS_MIN: 12,
  GUARDS: ENEMIES.guard.count,
  TURRETS: ENEMIES.turret.count,
  CONTROLS: STAGE.CONTROLS_REQUIRED,
  BRANCHES_MIN: 3,
  LOOPS_MIN: 2,
  BRANCH_ROUTE_MIN_METERS: 40,
  CLIMBS_MIN: 6,
  CLIMB_HEIGHT_MIN: 6,
  CLIMB_HEIGHT_MAX: 16,
  /** max jump height v²/2g (SPEC §7.4: 10 m/s, 18 m/s²) */
  JUMP_MAX_HEIGHT: (PLAYER.JUMP_SPEED * PLAYER.JUMP_SPEED) / (2 * GRAVITY),
  WIDE_ARENAS_MIN: 5,
  ARENA_W: 60,
  ARENA_D: 50,
  CROSSFIRE_SECTORS_MIN: 5,
  CROSSFIRE_ENEMIES_MIN: 4,
  PORTAL_MIN_WIDTH: 5,
  PORTAL_MIN_HEIGHT: 6,
  LAYERS_MIN: 3,
  /** a climb counts as "on the route" when the route passes within this distance of the from->to segment */
  CLIMB_ON_PATH_TOL: 12,
} as const;

/** horizontal clearance kept by the route */
const CLEAR = 0.02;
const HALF: V3 = { x: PLAYER.HALF.x, y: PLAYER.HALF.y, z: PLAYER.HALF.z };
/** route half extents: 2 cm side clearance (a route that only grazes a wall is not counted); no vertical margin so the player may stand on / touch a floor */
const HALF_C: V3 = { x: HALF.x + CLEAR, y: HALF.y, z: HALF.z + CLEAR };

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// ---------------------------------------------------------------------------------------------------------------------
// Small vector helpers (local, allocation-light)
// ---------------------------------------------------------------------------------------------------------------------
const vsub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const vadd = (a: V3, b: V3): V3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const vscale = (a: V3, s: number): V3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const vlerp = (a: V3, b: V3, t: number): V3 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
const vdist = (a: V3, b: V3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const vhdist = (a: V3, b: V3): number => Math.hypot(a.x - b.x, a.z - b.z);
const vclone = (a: V3): V3 => ({ x: a.x, y: a.y, z: a.z });
const vdot = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const vfinite = (a: V3): boolean => Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z);

function polylineLength(pts: readonly V3[]): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += vdist(pts[i - 1], pts[i]);
  return l;
}

/** closest point on segment ab to p */
function closestOnSegment(p: V3, a: V3, b: V3): V3 {
  const ab = vsub(b, a);
  const l2 = vdot(ab, ab);
  if (l2 < 1e-18) return vclone(a);
  const t = Math.max(0, Math.min(1, vdot(vsub(p, a), ab) / l2));
  return vadd(a, vscale(ab, t));
}

/** distance from p to the polyline, plus the arclength of the closest point */
function distToPolyline(p: V3, pts: readonly V3[]): { dist: number; at: number } {
  let best = Infinity;
  let bestAt = 0;
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const c = closestOnSegment(p, pts[i - 1], pts[i]);
    const d = vdist(p, c);
    if (d < best) {
      best = d;
      bestAt = acc + vdist(pts[i - 1], c);
    }
    acc += vdist(pts[i - 1], pts[i]);
  }
  if (pts.length === 1) {
    best = vdist(p, pts[0]);
  }
  return { dist: best, at: bestAt };
}

/** distance between segment pq and segment ab (3D, small closed form by sampling refinement) */
function segmentSegmentDistance(p: V3, q: V3, a: V3, b: V3): number {
  // closed form for two segments (Ericson, Real-Time Collision Detection 5.1.9)
  const d1 = vsub(q, p);
  const d2 = vsub(b, a);
  const r = vsub(p, a);
  const A = vdot(d1, d1);
  const E = vdot(d2, d2);
  const F = vdot(d2, r);
  let s: number;
  let t: number;
  const EPS = 1e-12;
  if (A <= EPS && E <= EPS) return vdist(p, a);
  if (A <= EPS) {
    s = 0;
    t = Math.max(0, Math.min(1, F / E));
  } else {
    const C = vdot(d1, r);
    if (E <= EPS) {
      t = 0;
      s = Math.max(0, Math.min(1, -C / A));
    } else {
      const B = vdot(d1, d2);
      const denom = A * E - B * B;
      s = denom > EPS ? Math.max(0, Math.min(1, (B * F - C * E) / denom)) : 0;
      t = (B * s + F) / E;
      if (t < 0) {
        t = 0;
        s = Math.max(0, Math.min(1, -C / A));
      } else if (t > 1) {
        t = 1;
        s = Math.max(0, Math.min(1, (B - C) / A));
      }
    }
  }
  return vdist(vadd(p, vscale(d1, s)), vadd(a, vscale(d2, t)));
}

const boxInside = (p: V3, b: AABB): boolean =>
  p.x >= b.min.x && p.x <= b.max.x && p.y >= b.min.y && p.y <= b.max.y && p.z >= b.min.z && p.z <= b.max.z;

function boxOverlapVolume(a: AABB, b: AABB): number {
  const dx = Math.min(a.max.x, b.max.x) - Math.max(a.min.x, b.min.x);
  const dy = Math.min(a.max.y, b.max.y) - Math.max(a.min.y, b.min.y);
  const dz = Math.min(a.max.z, b.max.z) - Math.max(a.min.z, b.min.z);
  return dx > 1e-6 && dy > 1e-6 && dz > 1e-6 ? dx * dy * dz : 0;
}

/** entry parameter (0..1) of segment a->b into box, or null */
function segmentBoxEntry(a: V3, b: V3, box: AABB): number | null {
  let t0 = 0;
  let t1 = 1;
  const o = [a.x, a.y, a.z];
  const d = [b.x - a.x, b.y - a.y, b.z - a.z];
  const mn = [box.min.x, box.min.y, box.min.z];
  const mx = [box.max.x, box.max.y, box.max.z];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-12) {
      if (o[i] < mn[i] || o[i] > mx[i]) return null;
    } else {
      let ta = (mn[i] - o[i]) / d[i];
      let tb = (mx[i] - o[i]) / d[i];
      if (ta > tb) {
        const tmp = ta;
        ta = tb;
        tb = tmp;
      }
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
      if (t0 > t1) return null;
    }
  }
  return t0;
}

function unionBox(boxes: readonly AABB[]): AABB | null {
  if (boxes.length === 0) return null;
  const mn = { x: Infinity, y: Infinity, z: Infinity };
  const mx = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const b of boxes) {
    mn.x = Math.min(mn.x, b.min.x);
    mn.y = Math.min(mn.y, b.min.y);
    mn.z = Math.min(mn.z, b.min.z);
    mx.x = Math.max(mx.x, b.max.x);
    mx.y = Math.max(mx.y, b.max.y);
    mx.z = Math.max(mx.z, b.max.z);
  }
  return { min: mn, max: mx };
}

// ---------------------------------------------------------------------------------------------------------------------
// Barrier states: every state gets its own World (real collision code) with the barrier boxes toggled like objective.ts does
// ---------------------------------------------------------------------------------------------------------------------
interface BarrierBoxes {
  /** barrier id -> box indices (union of BarrierDef.boxIds and boxes carrying barrierId) */
  byBarrier: Map<string, number[]>;
  /** boxes listed in BarrierDef.boxIds only (what objective.ts actually disables) */
  listedByBarrier: Map<string, number[]>;
}

function collectBarrierBoxes(stage: StageDef): BarrierBoxes {
  const idx = new Map<string, number>();
  stage.boxes.forEach((b, i) => idx.set(b.id, i));
  const byBarrier = new Map<string, number[]>();
  const listedByBarrier = new Map<string, number[]>();
  for (const br of stage.barriers) {
    const listed = new Set<number>();
    for (const id of br.boxIds) {
      const i = idx.get(id);
      if (i !== undefined) listed.add(i);
    }
    listedByBarrier.set(br.id, [...listed]);
    byBarrier.set(br.id, [...listed]);
  }
  stage.boxes.forEach((b, i) => {
    if (b.barrierId !== undefined) {
      const arr = byBarrier.get(b.barrierId) ?? [];
      if (!arr.includes(i)) arr.push(i);
      byBarrier.set(b.barrierId, arr);
    }
  });
  return { byBarrier, listedByBarrier };
}

/** World in which the barriers in `open` are opened (their boxes disabled) and all other barriers are closed */
function makeWorld(stage: StageDef, bb: BarrierBoxes, open: ReadonlySet<string> | 'all'): World {
  const w = new World(stage.boxes);
  for (const [bid, idxs] of bb.byBarrier) {
    const isOpen = open === 'all' || open.has(bid);
    if (isOpen) for (const i of idxs) w.setBoxEnabled(i, false);
  }
  return w;
}

// ---------------------------------------------------------------------------------------------------------------------
// Voxel grid (player-centre configuration space)
// ---------------------------------------------------------------------------------------------------------------------
const NEIGHBOUR_DIRS: { dx: number; dy: number; dz: number; len: number }[] = [];
for (let dz = -1; dz <= 1; dz++) {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0 && dz === 0) continue;
      NEIGHBOUR_DIRS.push({ dx, dy, dz, len: Math.hypot(dx, dy, dz) });
    }
  }
}
const DIR_INDEX = new Map<number, number>();
NEIGHBOUR_DIRS.forEach((d, i) => DIR_INDEX.set((d.dx + 1) * 9 + (d.dy + 1) * 3 + (d.dz + 1), i));
const dirIndexOf = (dx: number, dy: number, dz: number): number => DIR_INDEX.get((dx + 1) * 9 + (dy + 1) * 3 + (dz + 1)) ?? -1;

class Grid {
  readonly ox: number;
  readonly oy: number;
  readonly oz: number;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly n: number;
  readonly h: number;
  /** 1 = the player centre cannot be at this node (inside an inflated box) */
  blocked: Uint8Array;
  /** sector index (objective.ts rule: first sector whose bounds contain the node) or -1 */
  label: Int16Array;
  private g: Float32Array | null = null;
  private par: Int32Array | null = null;
  private closed: Uint8Array | null = null;
  private offs: Int32Array;
  private projOffs: Int32Array[];

  constructor(min: V3, max: V3, h: number, sectors: readonly SectorDef[]) {
    this.h = h;
    this.ox = min.x;
    this.oy = min.y;
    this.oz = min.z;
    this.nx = Math.max(2, Math.floor((max.x - min.x) / h) + 1);
    this.ny = Math.max(2, Math.floor((max.y - min.y) / h) + 1);
    this.nz = Math.max(2, Math.floor((max.z - min.z) / h) + 1);
    this.n = this.nx * this.ny * this.nz;
    this.blocked = new Uint8Array(this.n);
    this.label = new Int16Array(this.n).fill(-1);
    this.offs = new Int32Array(26);
    this.projOffs = [];
    const nxy = this.nx * this.ny;
    NEIGHBOUR_DIRS.forEach((d, i) => {
      this.offs[i] = d.dx + d.dy * this.nx + d.dz * nxy;
      const proj: number[] = [];
      const comps = [d.dx !== 0, d.dy !== 0, d.dz !== 0];
      const m = comps.filter(Boolean).length;
      if (m >= 2) {
        for (let mask = 1; mask < 8; mask++) {
          const pdx = mask & 1 ? d.dx : 0;
          const pdy = mask & 2 ? d.dy : 0;
          const pdz = mask & 4 ? d.dz : 0;
          if ((pdx !== 0 && !comps[0]) || (pdy !== 0 && !comps[1]) || (pdz !== 0 && !comps[2])) continue;
          const cnt = (pdx !== 0 ? 1 : 0) + (pdy !== 0 ? 1 : 0) + (pdz !== 0 ? 1 : 0);
          if (cnt === m) continue; // the neighbour itself
          proj.push(pdx + pdy * this.nx + pdz * nxy);
        }
      }
      this.projOffs.push(Int32Array.from(proj));
    });
    // sector labels: first sector whose (closed) bounds contain the node wins
    for (let si = 0; si < sectors.length; si++) {
      const b = sectors[si].bounds;
      const i0 = Math.max(0, Math.ceil((b.min.x - this.ox) / h - 1e-9));
      const i1 = Math.min(this.nx - 1, Math.floor((b.max.x - this.ox) / h + 1e-9));
      const j0 = Math.max(0, Math.ceil((b.min.y - this.oy) / h - 1e-9));
      const j1 = Math.min(this.ny - 1, Math.floor((b.max.y - this.oy) / h + 1e-9));
      const k0 = Math.max(0, Math.ceil((b.min.z - this.oz) / h - 1e-9));
      const k1 = Math.min(this.nz - 1, Math.floor((b.max.z - this.oz) / h + 1e-9));
      for (let k = k0; k <= k1; k++) {
        for (let j = j0; j <= j1; j++) {
          let idx = (k * this.ny + j) * this.nx + i0;
          for (let i = i0; i <= i1; i++, idx++) if (this.label[idx] < 0) this.label[idx] = si;
        }
      }
    }
  }

  idx(i: number, j: number, k: number): number {
    return (k * this.ny + j) * this.nx + i;
  }
  ci(node: number): number {
    return node % this.nx;
  }
  cj(node: number): number {
    return Math.floor(node / this.nx) % this.ny;
  }
  ck(node: number): number {
    return Math.floor(node / (this.nx * this.ny));
  }
  pos(node: number): V3 {
    return { x: this.ox + this.ci(node) * this.h, y: this.oy + this.cj(node) * this.h, z: this.oz + this.ck(node) * this.h };
  }
  inBounds(i: number, j: number, k: number): boolean {
    return i >= 0 && j >= 0 && k >= 0 && i < this.nx && j < this.ny && k < this.nz;
  }
  /** nearest node index of a point (clamped) */
  nearest(p: V3): number {
    const i = Math.max(0, Math.min(this.nx - 1, Math.round((p.x - this.ox) / this.h)));
    const j = Math.max(0, Math.min(this.ny - 1, Math.round((p.y - this.oy) / this.h)));
    const k = Math.max(0, Math.min(this.nz - 1, Math.round((p.z - this.oz) / this.h)));
    return this.idx(i, j, k);
  }

  /** rasterise the enabled boxes of `world` inflated by `half` (a node strictly inside an inflated box is blocked) */
  rebuildBlocked(world: World, half: V3): void {
    this.blocked.fill(0);
    const h = this.h;
    for (let bi = 0; bi < world.boxes.length; bi++) {
      if (!world.isBoxEnabled(bi)) continue;
      const b = world.boxes[bi];
      const lox = b.min.x - half.x, hix = b.max.x + half.x;
      const loy = b.min.y - half.y, hiy = b.max.y + half.y;
      const loz = b.min.z - half.z, hiz = b.max.z + half.z;
      const i0 = Math.max(0, Math.floor((lox - this.ox) / h) + 1);
      const i1 = Math.min(this.nx - 1, Math.ceil((hix - this.ox) / h) - 1);
      const j0 = Math.max(0, Math.floor((loy - this.oy) / h) + 1);
      const j1 = Math.min(this.ny - 1, Math.ceil((hiy - this.oy) / h) - 1);
      const k0 = Math.max(0, Math.floor((loz - this.oz) / h) + 1);
      const k1 = Math.min(this.nz - 1, Math.ceil((hiz - this.oz) / h) - 1);
      for (let k = k0; k <= k1; k++) {
        for (let j = j0; j <= j1; j++) {
          let idx = (k * this.ny + j) * this.nx + i0;
          for (let i = i0; i <= i1; i++, idx++) this.blocked[idx] = 1;
        }
      }
    }
  }

  /** free nodes reachable from the seeds by 6-connected steps */
  flood(seeds: readonly number[]): Uint8Array {
    const reach = new Uint8Array(this.n);
    const queue = new Int32Array(this.n);
    let qh = 0;
    let qt = 0;
    for (const s of seeds) {
      if (!this.blocked[s] && !reach[s]) {
        reach[s] = 1;
        queue[qt++] = s;
      }
    }
    const nx = this.nx;
    const nxy = this.nx * this.ny;
    while (qh < qt) {
      const node = queue[qh++];
      const i = node % nx;
      const jk = (node - i) / nx;
      const j = jk % this.ny;
      const k = (jk - j) / this.ny;
      if (i > 0 && !reach[node - 1] && !this.blocked[node - 1]) { reach[node - 1] = 1; queue[qt++] = node - 1; }
      if (i < nx - 1 && !reach[node + 1] && !this.blocked[node + 1]) { reach[node + 1] = 1; queue[qt++] = node + 1; }
      if (j > 0 && !reach[node - nx] && !this.blocked[node - nx]) { reach[node - nx] = 1; queue[qt++] = node - nx; }
      if (j < this.ny - 1 && !reach[node + nx] && !this.blocked[node + nx]) { reach[node + nx] = 1; queue[qt++] = node + nx; }
      if (k > 0 && !reach[node - nxy] && !this.blocked[node - nxy]) { reach[node - nxy] = 1; queue[qt++] = node - nxy; }
      if (k < this.nz - 1 && !reach[node + nxy] && !this.blocked[node + nxy]) { reach[node + nxy] = 1; queue[qt++] = node + nxy; }
    }
    return reach;
  }

  /**
   * A* over the 26-neighbourhood (a diagonal step needs all its axis projections free: no corner cutting).
   * `blockedEdges` holds edges (from*32+dir) that failed the exact sweep check earlier.
   * Returns the node sequence or null.
   */
  astar(
    seeds: readonly { node: number; cost: number }[],
    isGoal: (node: number) => boolean,
    heuristic: (x: number, y: number, z: number) => number,
    blockedEdges: ReadonlySet<number>,
    allowed: ((node: number) => boolean) | null,
  ): number[] | null {
    if (!this.g) {
      this.g = new Float32Array(this.n).fill(Infinity);
      this.par = new Int32Array(this.n).fill(-1);
      this.closed = new Uint8Array(this.n);
    }
    const g = this.g;
    const par = this.par as Int32Array;
    const closed = this.closed as Uint8Array;
    const touched: number[] = [];
    let cap = 1 << 16;
    let hk = new Float64Array(cap);
    let hv = new Int32Array(cap);
    let hs = 0;
    const push = (key: number, v: number): void => {
      if (hs === cap) {
        cap *= 2;
        const nk = new Float64Array(cap);
        nk.set(hk);
        hk = nk;
        const nv = new Int32Array(cap);
        nv.set(hv);
        hv = nv;
      }
      let i = hs++;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (hk[p] <= key) break;
        hk[i] = hk[p];
        hv[i] = hv[p];
        i = p;
      }
      hk[i] = key;
      hv[i] = v;
    };
    const pop = (): number => {
      const top = hv[0];
      hs--;
      if (hs > 0) {
        const key = hk[hs];
        const v = hv[hs];
        let i = 0;
        for (;;) {
          let c = 2 * i + 1;
          if (c >= hs) break;
          if (c + 1 < hs && hk[c + 1] < hk[c]) c++;
          if (hk[c] >= key) break;
          hk[i] = hk[c];
          hv[i] = hv[c];
          i = c;
        }
        hk[i] = key;
        hv[i] = v;
      }
      return top;
    };

    const nx = this.nx;
    const ny = this.ny;
    const nz = this.nz;
    const h = this.h;
    const hasBlockedEdges = blockedEdges.size > 0;
    for (const sd of seeds) {
      const s = sd.node;
      if (s < 0 || s >= this.n || this.blocked[s]) continue;
      if (sd.cost < g[s]) {
        if (g[s] === Infinity) touched.push(s);
        g[s] = sd.cost;
        par[s] = -1;
        push(sd.cost + heuristic(this.ox + (s % nx) * h, this.oy + (Math.floor(s / nx) % ny) * h, this.oz + Math.floor(s / (nx * ny)) * h), s);
      }
    }

    let result: number[] | null = null;
    while (hs > 0) {
      const node = pop();
      if (closed[node]) continue;
      closed[node] = 1;
      if (isGoal(node)) {
        const path: number[] = [];
        let c = node;
        while (c >= 0) {
          path.push(c);
          c = par[c];
        }
        path.reverse();
        result = path;
        break;
      }
      const i = node % nx;
      const jk = (node - i) / nx;
      const j = jk % ny;
      const k = (jk - j) / ny;
      const gn = g[node];
      for (let d = 0; d < 26; d++) {
        const nd = NEIGHBOUR_DIRS[d];
        const ni = i + nd.dx;
        const nj = j + nd.dy;
        const nk = k + nd.dz;
        if (ni < 0 || nj < 0 || nk < 0 || ni >= nx || nj >= ny || nk >= nz) continue;
        const nn = node + this.offs[d];
        if (closed[nn] || this.blocked[nn]) continue;
        if (allowed !== null && !allowed(nn)) continue;
        const proj = this.projOffs[d];
        let ok = true;
        for (let q = 0; q < proj.length; q++) {
          if (this.blocked[node + proj[q]]) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        if (hasBlockedEdges && blockedEdges.has(node * 32 + d)) continue;
        const ng = gn + nd.len * h;
        if (ng < g[nn]) {
          if (g[nn] === Infinity) touched.push(nn);
          g[nn] = ng;
          par[nn] = node;
          push(ng + heuristic(this.ox + ni * h, this.oy + nj * h, this.oz + nk * h), nn);
        }
      }
    }
    for (const t of touched) {
      g[t] = Infinity;
      par[t] = -1;
      closed[t] = 0;
    }
    return result;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Exact (sweepAABB-verified) path search + smoothing
// ---------------------------------------------------------------------------------------------------------------------
interface PathEnv {
  grid: Grid;
  world: World;
  half: V3;
}

/** true when the box can move center -> center + delta (ending in resting contact is fine: sweepAABB reports t = 1 there) */
function sweepFree(world: World, center: V3, half: V3, delta: V3): boolean {
  if (Math.abs(delta.x) + Math.abs(delta.y) + Math.abs(delta.z) < 1e-12) return true;
  const h = world.sweepAABB(center, half, delta);
  return h === null || h.t >= 1 - 1e-9;
}

const freeMove = (env: PathEnv, a: V3, b: V3): boolean => sweepFree(env.world, a, env.half, vsub(b, a));

/** grid nodes near p that the centre can reach in a straight collision-free move */
function seedsFor(env: PathEnv, p: V3, allowed: ((node: number) => boolean) | null): { node: number; cost: number }[] {
  const g = env.grid;
  if (env.world.overlapAABB(p, env.half, 1e-4)) return [];
  const i0 = Math.round((p.x - g.ox) / g.h);
  const j0 = Math.round((p.y - g.oy) / g.h);
  const k0 = Math.round((p.z - g.oz) / g.h);
  for (const R of [1, 2, 3]) {
    const found: { node: number; cost: number }[] = [];
    for (let k = k0 - R; k <= k0 + R; k++) {
      for (let j = j0 - R; j <= j0 + R; j++) {
        for (let i = i0 - R; i <= i0 + R; i++) {
          if (!g.inBounds(i, j, k)) continue;
          const node = g.idx(i, j, k);
          if (g.blocked[node]) continue;
          if (allowed !== null && !allowed(node)) continue;
          const q = g.pos(node);
          if (!freeMove(env, p, q)) continue;
          found.push({ node, cost: vdist(p, q) });
        }
      }
    }
    if (found.length > 0) {
      found.sort((a, b) => a.cost - b.cost);
      return found.slice(0, 12);
    }
  }
  return [];
}

interface SearchResult {
  points: V3[];
  nodes: number[];
  iterations: number;
}

/**
 * A* on the grid, then every edge is verified with the exact sweep; failing edges are banned and the search restarts.
 * `isGoal(node)` decides the goal nodes; the returned polyline starts at the exact `start` point.
 */
function exactSearch(
  env: PathEnv,
  start: V3,
  isGoal: (node: number) => boolean,
  heuristic: (x: number, y: number, z: number) => number,
  allowed: ((node: number) => boolean) | null,
  maxIter = 60,
): SearchResult | null {
  const seeds = seedsFor(env, start, allowed);
  if (seeds.length === 0) return null;
  const banned = new Set<number>();
  for (let iter = 1; iter <= maxIter; iter++) {
    const nodes = env.grid.astar(seeds, isGoal, heuristic, banned, allowed);
    if (!nodes) return null;
    let bad = 0;
    for (let i = 1; i < nodes.length; i++) {
      const a = env.grid.pos(nodes[i - 1]);
      const b = env.grid.pos(nodes[i]);
      if (!freeMove(env, a, b)) {
        const d = dirIndexOf(env.grid.ci(nodes[i]) - env.grid.ci(nodes[i - 1]), env.grid.cj(nodes[i]) - env.grid.cj(nodes[i - 1]), env.grid.ck(nodes[i]) - env.grid.ck(nodes[i - 1]));
        if (d >= 0) banned.add(nodes[i - 1] * 32 + d);
        bad++;
      }
    }
    if (bad === 0) {
      const pts: V3[] = [vclone(start), ...nodes.map((n) => env.grid.pos(n))];
      return { points: pts, nodes, iterations: iter };
    }
  }
  return null;
}

/**
 * Candidate taut-string bends: for each of the 12 edges of the box inflated by `half`, points along the edge sorted by
 * |a-c|+|c-b| (the unconstrained optimum first, then uniform samples: other boxes may limit the usable part of the edge),
 * nudged 1 mm outward.
 */
function boxEdgeSamples(box: AABB, half: V3, a: V3, b: V3): V3[][] {
  const lo = [box.min.x - half.x, box.min.y - half.y, box.min.z - half.z];
  const hi = [box.max.x + half.x, box.max.y + half.y, box.max.z + half.z];
  const out: V3[][] = [];
  const NUDGE = 1e-3;
  const N = 24;
  for (let axis = 0; axis < 3; axis++) {
    const u = (axis + 1) % 3;
    const w = (axis + 2) % 3;
    for (const cu of [0, 1]) {
      for (const cw of [0, 1]) {
        const at = (t: number): V3 => {
          const c = [0, 0, 0];
          c[axis] = lo[axis] + (hi[axis] - lo[axis]) * t;
          c[u] = (cu ? hi[u] : lo[u]) + (cu ? NUDGE : -NUDGE);
          c[w] = (cw ? hi[w] : lo[w]) + (cw ? NUDGE : -NUDGE);
          return { x: c[0], y: c[1], z: c[2] };
        };
        let l = 0;
        let r = 1;
        for (let i = 0; i < 40; i++) {
          const m1 = l + (r - l) / 3;
          const m2 = r - (r - l) / 3;
          if (vdist(a, at(m1)) + vdist(at(m1), b) < vdist(a, at(m2)) + vdist(at(m2), b)) r = m2;
          else l = m1;
        }
        const ts = [(l + r) / 2];
        for (let i = 0; i <= N; i++) ts.push(i / N);
        out.push(ts.map(at).sort((p, q) => vdist(a, p) + vdist(p, b) - (vdist(a, q) + vdist(q, b))));
      }
    }
  }
  return out;
}

/** taut-string smoothing: greedy shortcut, bend tightening, and bend insertion around the blocking box; every move is sweep-verified */
function smoothPath(env: PathEnv, pts0: V3[], segOk: ((a: V3, b: V3) => boolean) | null, lastMove: ((prev: V3, cur: V3) => V3 | null) | null): V3[] {
  const ok = (a: V3, b: V3): boolean => freeMove(env, a, b) && (segOk === null || segOk(a, b));
  // 1. greedy shortcut with a bounded look-ahead
  const K = 48;
  const pts: V3[] = [pts0[0]];
  let i = 0;
  const last = pts0.length - 1;
  while (i < last) {
    let j = Math.min(last, i + K);
    while (j > i + 1 && !ok(pts0[i], pts0[j])) j--;
    pts.push(pts0[j]);
    i = j;
  }
  // 2. tighten
  const tighten = (maxPass: number): void => {
    for (let pass = 0; pass < maxPass; pass++) {
      let gain = 0;
      if (lastMove && pts.length >= 2) {
        const cand = lastMove(pts[pts.length - 2], pts[pts.length - 1]);
        if (cand && vdist(pts[pts.length - 2], cand) < vdist(pts[pts.length - 2], pts[pts.length - 1]) - 1e-6 && ok(pts[pts.length - 2], cand)) {
          gain += vdist(pts[pts.length - 2], pts[pts.length - 1]) - vdist(pts[pts.length - 2], cand);
          pts[pts.length - 1] = cand;
        }
      }
      for (let v = 1; v < pts.length - 1; v++) {
        const a = pts[v - 1];
        const c = pts[v];
        const b = pts[v + 1];
        if (ok(a, b)) {
          gain += vdist(a, c) + vdist(c, b) - vdist(a, b);
          pts.splice(v, 1);
          v--;
          continue;
        }
        const m = closestOnSegment(c, a, b);
        if (vdist(m, c) < 1e-4) continue;
        const before = vdist(a, c) + vdist(c, b);
        let bestT = 0;
        if (ok(a, m) && ok(m, b)) {
          bestT = 1;
        } else {
          let lo = 0;
          let hi = 1;
          for (let s = 0; s < 9; s++) {
            const mid = (lo + hi) / 2;
            const q = vlerp(c, m, mid);
            if (ok(a, q) && ok(q, b)) lo = mid;
            else hi = mid;
          }
          bestT = lo;
        }
        if (bestT > 1e-3) {
          const q = vlerp(c, m, bestT);
          const after = vdist(a, q) + vdist(q, b);
          if (after < before - 1e-6) {
            pts[v] = q;
            gain += before - after;
          }
        }
      }
      if (gain < 0.02) break;
    }
  };
  // shortest bend sequence a -> ... -> b around the boxes that block the straight move (depth- and beam-limited)
  let wrapBudget = 0;
  const wrap = (a: V3, b: V3, depth: number): V3[] | null => {
    if (ok(a, b)) return [b];
    if (depth <= 0 || wrapBudget <= 0) return null;
    wrapBudget--;
    const hit = env.world.sweepAABB(a, env.half, vsub(b, a));
    if (!hit) return null;
    const box = env.world.boxes[hit.boxIndex];
    const valid: { c: V3; f: number }[] = [];
    for (const edge of boxEdgeSamples(box, env.half, a, b)) {
      for (const c of edge) {
        if (vdist(a, c) < 0.02 || vdist(c, b) < 0.02) continue;
        if (ok(a, c)) {
          valid.push({ c, f: vdist(a, c) + vdist(c, b) });
          break;
        }
      }
    }
    valid.sort((p, q) => p.f - q.f);
    let best: V3[] | null = null;
    let bestLen = Infinity;
    for (const { c } of valid.slice(0, 4)) {
      const rest = wrap(c, b, depth - 1);
      if (!rest) continue;
      const l = vdist(a, c) + polylineLength([c, ...rest]);
      if (l < bestLen) {
        bestLen = l;
        best = [c, ...rest];
      }
    }
    return best;
  };
  tighten(80);
  for (let round = 0; round < 4; round++) {
    let changed = false;
    for (let v = 1; v < pts.length - 1; v++) {
      const a = pts[v - 1];
      const c = pts[v];
      const b = pts[v + 1];
      if (ok(a, b)) continue;
      const before = vdist(a, c) + vdist(c, b);
      wrapBudget = 40;
      const w = wrap(a, b, 3);
      if (!w) continue;
      const len = polylineLength([a, ...w]);
      if (len < before - 0.05) {
        pts.splice(v, 1, ...w.slice(0, -1));
        v += w.length - 2;
        changed = true;
      }
    }
    if (!changed) break;
    tighten(40);
  }
  return pts;
}

// ---------------------------------------------------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------------------------------------------------
interface Ctx {
  stage: StageDef;
  bb: BarrierBoxes;
  worldOpen: World;
  worldClosed: World;
  grid: Grid | null;
  gridNote: string;
  states: EnemyState[];
  warnings: string[];
  timings: Record<string, number>;
  log: (msg: string) => void;
  checks: CheckResult[];
}

function addCheck(ctx: Ctx, c: CheckResult): void {
  ctx.checks.push(c);
}

function timed<T>(ctx: Ctx, key: string, fn: () => T): T {
  const t0 = now();
  const r = fn();
  ctx.timings[key] = (ctx.timings[key] ?? 0) + (now() - t0);
  return r;
}

function sectorIndexAt(stage: StageDef, p: V3): number {
  for (let i = 0; i < stage.sectors.length; i++) if (boxInside(p, stage.sectors[i].bounds)) return i;
  return -1;
}

function fmt(n: number, d = 1): string {
  return Number.isFinite(n) ? n.toFixed(d) : String(n);
}
const fv = (p: V3, d = 1): string => `(${fmt(p.x, d)}, ${fmt(p.y, d)}, ${fmt(p.z, d)})`;

/** voxel grid covering all boxes + start with a margin (so an opening to the outside is visible as reachable "outside" nodes) */
function makeGrid(stage: StageDef, step: number): { grid: Grid | null; note: string } {
  const bounds = unionBox([...stage.boxes.map((b) => ({ min: b.min, max: b.max })), { min: stage.playerStart.pos, max: stage.playerStart.pos }]);
  if (!bounds || !vfinite(bounds.min) || !vfinite(bounds.max)) return { grid: null, note: 'no finite geometry' };
  const margin = 8;
  const min = { x: Math.floor(bounds.min.x) - margin, y: Math.floor(bounds.min.y) - margin, z: Math.floor(bounds.min.z) - margin };
  const max = { x: Math.ceil(bounds.max.x) + margin, y: Math.ceil(bounds.max.y) + margin, z: Math.ceil(bounds.max.z) + margin };
  let h = Math.max(1, step);
  const count = (hh: number): number => (Math.floor((max.x - min.x) / hh) + 1) * (Math.floor((max.y - min.y) / hh) + 1) * (Math.floor((max.z - min.z) / hh) + 1);
  const LIMIT = 16e6;
  while (count(h) > LIMIT && h < 6) h *= 1.1;
  if (count(h) > LIMIT) return { grid: null, note: `grid too large even at ${fmt(h, 2)} m (${count(h)} nodes)` };
  const grid = new Grid(min, max, h, stage.sectors);
  return { grid, note: `grid ${grid.nx}x${grid.ny}x${grid.nz} @ ${fmt(h, 2)} m (${grid.n} nodes)` };
}

// ---------------------------------------------------------------------------------------------------------------------
// Route (item 3)
// ---------------------------------------------------------------------------------------------------------------------
function zoneHeuristic(zone: AABB): (x: number, y: number, z: number) => number {
  return (x, y, z) => {
    const dx = Math.max(zone.min.x - x, 0, x - zone.max.x);
    const dy = Math.max(zone.min.y - y, 0, y - zone.max.y);
    const dz = Math.max(zone.min.z - z, 0, z - zone.max.z);
    return Math.hypot(dx, dy, dz);
  };
}

interface RouteRun {
  found: boolean;
  points: V3[];
  length: number;
  gridLength: number;
  note: string;
}

function computeRoute(ctx: Ctx, half: V3, gridOverride: Grid | null = null): RouteRun {
  const grid = gridOverride ?? ctx.grid;
  const stage = ctx.stage;
  if (!grid) return { found: false, points: [], length: 0, gridLength: 0, note: ctx.gridNote };
  grid.rebuildBlocked(ctx.worldOpen, half);
  const env: PathEnv = { grid, world: ctx.worldOpen, half };
  const zone = stage.escapeZone;
  const hz = zoneHeuristic(zone);
  const isGoal = (node: number): boolean => {
    const p = grid.pos(node);
    return boxInside(p, zone);
  };
  const res = exactSearch(env, stage.playerStart.pos, isGoal, hz, null);
  if (!res) return { found: false, points: [], length: 0, gridLength: 0, note: 'no collision-free route from the start to the escape zone (all barriers open)' };
  const gridLength = polylineLength(res.points);
  const inset = 0.01;
  const lastMove = (prev: V3, cur: V3): V3 | null => {
    const q = {
      x: Math.min(Math.max(prev.x, zone.min.x + inset), zone.max.x - inset),
      y: Math.min(Math.max(prev.y, zone.min.y + inset), zone.max.y - inset),
      z: Math.min(Math.max(prev.z, zone.min.z + inset), zone.max.z - inset),
    };
    return vdist(q, cur) < 1e-6 ? null : q;
  };
  const pts = smoothPath(env, res.points, null, lastMove);
  return { found: true, points: pts, length: polylineLength(pts), gridLength, note: `A* iterations ${res.iterations}` };
}

function sampleAlong(pts: readonly V3[], step: number, fn: (p: V3, at: number) => void): void {
  let acc = 0;
  if (pts.length === 0) return;
  fn(pts[0], 0);
  let nextAt = step;
  for (let i = 1; i < pts.length; i++) {
    const l = vdist(pts[i - 1], pts[i]);
    while (nextAt <= acc + l + 1e-9) {
      const t = l > 1e-12 ? (nextAt - acc) / l : 0;
      fn(vlerp(pts[i - 1], pts[i], t), nextAt);
      nextAt += step;
    }
    acc += l;
  }
  fn(pts[pts.length - 1], acc);
}

function routeSectors(stage: StageDef, pts: readonly V3[]): { sectors: string[]; entries: { sectorId: string; atMeters: number }[] } {
  const entries: { sectorId: string; atMeters: number }[] = [];
  const seen = new Set<string>();
  sampleAlong(pts, 0.5, (p, at) => {
    const i = sectorIndexAt(stage, p);
    if (i >= 0) {
      const id = stage.sectors[i].id;
      if (!seen.has(id)) {
        seen.add(id);
        entries.push({ sectorId: id, atMeters: at });
      }
    }
  });
  return { sectors: entries.map((e) => e.sectorId), entries };
}

function barrierCrossings(ctx: Ctx, pts: readonly V3[]): { barrierId: string; atMeters: number; point: V3 }[] {
  const out: { barrierId: string; atMeters: number; point: V3 }[] = [];
  for (const br of ctx.stage.barriers) {
    const idxs = ctx.bb.byBarrier.get(br.id) ?? [];
    let best: { at: number; p: V3 } | null = null;
    let acc = 0;
    for (let i = 1; i < pts.length; i++) {
      const l = vdist(pts[i - 1], pts[i]);
      for (const bi of idxs) {
        const b = ctx.stage.boxes[bi];
        const t = segmentBoxEntry(pts[i - 1], pts[i], b);
        if (t !== null) {
          const at = acc + t * l;
          if (!best || at < best.at) best = { at, p: vlerp(pts[i - 1], pts[i], t) };
        }
      }
      acc += l;
    }
    if (best) out.push({ barrierId: br.id, atMeters: best.at, point: best.p });
  }
  return out.sort((a, b) => a.atMeters - b.atMeters);
}

// ---------------------------------------------------------------------------------------------------------------------
// Connection graph from real free space (items 4/5/11)
// ---------------------------------------------------------------------------------------------------------------------
interface Conn extends ConnectionInfo {
  ia: number;
  ib: number;
}

function buildConnections(ctx: Ctx, reach: Uint8Array): { conns: Conn[]; outsideContacts: number } {
  const grid = ctx.grid as Grid;
  const env: PathEnv = { grid, world: ctx.worldOpen, half: HALF_C };
  const stage = ctx.stage;
  const cand = new Map<string, { a: V3; b: V3 }[]>();
  let outside = 0;
  const nx = grid.nx;
  const nxy = grid.nx * grid.ny;
  for (let n = 0; n < grid.n; n++) {
    if (!reach[n]) continue;
    const i = n % nx;
    const jk = (n - i) / nx;
    const j = jk % grid.ny;
    const k = (jk - j) / grid.ny;
    const la = grid.label[n];
    const nbs = [i < nx - 1 ? n + 1 : -1, j < grid.ny - 1 ? n + nx : -1, k < grid.nz - 1 ? n + nxy : -1];
    for (const m of nbs) {
      if (m < 0 || !reach[m]) continue;
      const lb = grid.label[m];
      if (la === lb) continue;
      if (la < 0 || lb < 0) {
        outside++;
        continue;
      }
      const key = la < lb ? `${la}|${lb}` : `${lb}|${la}`;
      let arr = cand.get(key);
      if (!arr) {
        arr = [];
        cand.set(key, arr);
      }
      arr.push({ a: grid.pos(n), b: grid.pos(m) });
    }
  }
  const conns: Conn[] = [];
  const R = 10;
  for (const [key, arr] of cand) {
    const [sa, sb] = key.split('|').map(Number);
    // single-linkage clustering (spatial hash)
    const parent = arr.map((_, i) => i);
    const find = (x: number): number => {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]];
        x = parent[x];
      }
      return x;
    };
    const cells = new Map<string, number[]>();
    const cellOf = (p: V3): [number, number, number] => [Math.floor(p.x / R), Math.floor(p.y / R), Math.floor(p.z / R)];
    arr.forEach((c, idx) => {
      const mid = vlerp(c.a, c.b, 0.5);
      const [cx, cy, cz] = cellOf(mid);
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dz = -1; dz <= 1; dz++) {
            const list = cells.get(`${cx + dx}|${cy + dy}|${cz + dz}`);
            if (!list) continue;
            for (const o of list) {
              const om = vlerp(arr[o].a, arr[o].b, 0.5);
              if (vdist(om, mid) <= R) parent[find(idx)] = find(o);
            }
          }
      const ck = `${cx}|${cy}|${cz}`;
      const l = cells.get(ck);
      if (l) l.push(idx);
      else cells.set(ck, [idx]);
    });
    const groups = new Map<number, number[]>();
    arr.forEach((_, idx) => {
      const r = find(idx);
      const g = groups.get(r);
      if (g) g.push(idx);
      else groups.set(r, [idx]);
    });
    for (const members of groups.values()) {
      const sampleN = Math.min(8, members.length);
      const okMids: V3[] = [];
      for (let s = 0; s < sampleN; s++) {
        const c = arr[members[Math.floor((s * members.length) / sampleN)]];
        if (freeMove(env, c.a, c.b)) okMids.push(vlerp(c.a, c.b, 0.5));
      }
      if (okMids.length === 0) continue;
      const sum = okMids.reduce((acc, p) => vadd(acc, p), { x: 0, y: 0, z: 0 });
      const center = vscale(sum, 1 / okMids.length);
      const A = stage.sectors[sa].id;
      const B = stage.sectors[sb].id;
      // matching declared portal (same sector pair, nearest centre)
      let portalId: string | null = null;
      let bestD = Infinity;
      for (const p of stage.portals) {
        if (!((p.a === A && p.b === B) || (p.a === B && p.b === A))) continue;
        const d = vdist(p.center, center);
        const tol = Math.max(8, p.width / 2 + 4);
        if (d <= tol && d < bestD) {
          bestD = d;
          portalId = p.id;
        }
      }
      conns.push({ id: '', a: A, b: B, center, samples: members.length, portalId, ia: sa, ib: sb });
    }
  }
  conns.sort((p, q) => p.ia - q.ia || p.ib - q.ib || p.center.x - q.center.x || p.center.z - q.center.z);
  conns.forEach((c, i) => (c.id = `C${String(i + 1).padStart(2, '0')}`));
  return { conns, outsideContacts: outside };
}

function bfsHops(nSectors: number, conns: readonly Conn[], from: number, to: number): number[] | null {
  if (from < 0 || to < 0) return null;
  const adj: number[][] = Array.from({ length: nSectors }, () => []);
  for (const c of conns) {
    adj[c.ia].push(c.ib);
    adj[c.ib].push(c.ia);
  }
  const prev = new Int32Array(nSectors).fill(-2);
  prev[from] = -1;
  const q = [from];
  for (let h = 0; h < q.length; h++) {
    const v = q[h];
    if (v === to) break;
    for (const w of adj[v]) {
      if (prev[w] === -2) {
        prev[w] = v;
        q.push(w);
      }
    }
  }
  if (prev[to] === -2) return null;
  const path: number[] = [];
  for (let v = to; v !== -1; v = prev[v]) path.push(v);
  return path.reverse();
}

/** number of edge-disjoint paths between two sectors (unit-capacity max flow on the undirected multigraph) */
function edgeDisjointPaths(nSectors: number, conns: readonly Conn[], s: number, t: number): number {
  if (s < 0 || t < 0 || s === t) return 0;
  // arcs: for each undirected edge two arcs with capacity 1 each
  const head: number[] = [];
  const cap: number[] = [];
  const adj: number[][] = Array.from({ length: nSectors }, () => []);
  const addArc = (u: number, v: number): void => {
    adj[u].push(head.length);
    head.push(v);
    cap.push(1);
  };
  for (const c of conns) {
    // arc 2e: a->b ; arc 2e+1: b->a ; each is the reverse of the other (undirected unit edge)
    addArc(c.ia, c.ib);
    addArc(c.ib, c.ia);
  }
  let flow = 0;
  for (;;) {
    const prevArc = new Int32Array(nSectors).fill(-1);
    const seen = new Uint8Array(nSectors);
    seen[s] = 1;
    const q = [s];
    for (let h = 0; h < q.length && !seen[t]; h++) {
      const u = q[h];
      for (const a of adj[u]) {
        if (cap[a] > 0 && !seen[head[a]]) {
          seen[head[a]] = 1;
          prevArc[head[a]] = a;
          q.push(head[a]);
        }
      }
    }
    if (!seen[t]) break;
    for (let v = t; v !== s; ) {
      const a = prevArc[v];
      cap[a] -= 1;
      cap[a ^ 1] += 1;
      v = head[a ^ 1];
    }
    flow++;
    if (flow > 64) break;
  }
  return flow;
}

interface RawCycle {
  verts: number[];
  edges: number[];
}

/** simple cycles of a multigraph (edge lists); each cycle is reported once */
function enumerateCycles(n: number, conns: readonly Conn[], cap: number): { cycles: RawCycle[]; truncated: boolean } {
  const adj: { edge: number; to: number }[][] = Array.from({ length: n }, () => []);
  conns.forEach((c, e) => {
    adj[c.ia].push({ edge: e, to: c.ib });
    adj[c.ib].push({ edge: e, to: c.ia });
  });
  const out: RawCycle[] = [];
  const seen = new Set<string>();
  let truncated = false;
  for (let s = 0; s < n && !truncated; s++) {
    const visited = new Uint8Array(n);
    const pv: number[] = [s];
    const pe: number[] = [];
    visited[s] = 1;
    const dfs = (v: number): void => {
      if (truncated) return;
      for (const { edge, to } of adj[v]) {
        if (pe.length > 0 && edge === pe[pe.length - 1]) continue;
        if (to === s) {
          if (pe.length >= 1 && !(pe.length === 1 && edge === pe[0])) {
            const edges = [...pe, edge];
            const key = [...edges].sort((a, b) => a - b).join(',');
            if (!seen.has(key)) {
              seen.add(key);
              out.push({ verts: [...pv], edges });
              if (out.length >= cap) {
                truncated = true;
                return;
              }
            }
          }
          continue;
        }
        if (to < s || visited[to]) continue;
        visited[to] = 1;
        pv.push(to);
        pe.push(edge);
        dfs(to);
        pe.pop();
        pv.pop();
        visited[to] = 0;
        if (truncated) return;
      }
    };
    dfs(s);
  }
  return { cycles: out, truncated };
}

/** shortest free path between two points inside one sector (masked A*, exact-verified, smoothed) */
function sectorPath(ctx: Ctx, si: number, a: V3, b: V3): V3[] | null {
  const grid = ctx.grid as Grid;
  const env: PathEnv = { grid, world: ctx.worldOpen, half: HALF_C };
  const bounds = ctx.stage.sectors[si].bounds;
  const allowed = (n: number): boolean => grid.label[n] === si;
  if (vdist(a, b) < 1e-6) return [vclone(a)];
  const goalSeeds = seedsFor(env, b, allowed);
  if (goalSeeds.length === 0) return null;
  const goalSet = new Set(goalSeeds.map((s) => s.node));
  const slack = 2 * grid.h * 1.8;
  const res = exactSearch(env, a, (n) => goalSet.has(n), (x, y, z) => Math.max(0, Math.hypot(x - b.x, y - b.y, z - b.z) - slack), allowed, 30);
  if (!res) return null;
  const pts = [...res.points, vclone(b)];
  const segOk = (p: V3, q: V3): boolean => {
    const l = vdist(p, q);
    const n = Math.max(1, Math.ceil(l / 1));
    for (let i = 0; i <= n; i++) if (!boxInside(vlerp(p, q, i / n), bounds)) return false;
    return true;
  };
  return smoothPath(env, pts, segOk, null);
}

/** fraction of the samples of `pts` (every 2 m) that are farther than `threshold` from `other` */
function farFraction(pts: readonly V3[], other: readonly V3[], threshold: number): number {
  let n = 0;
  let far = 0;
  sampleAlong(pts, 2, (p) => {
    n++;
    if (distToPolyline(p, other).dist > threshold) far++;
  });
  return n ? far / n : 0;
}

function analyseTopology(
  ctx: Ctx,
  conns: readonly Conn[],
): { structures: TopologyStructure[]; rejected: TopologyStructure[]; truncated: boolean; cyclesFound: number } {
  const stage = ctx.stage;
  const n = stage.sectors.length;
  const { cycles, truncated } = enumerateCycles(n, conns, 4000);
  const cache = new Map<string, V3[]>();
  const pathIn = (si: number, ea: number, eb: number): V3[] => {
    const lo = Math.min(ea, eb);
    const hi = Math.max(ea, eb);
    const key = `${si}|${lo}|${hi}`;
    let hit = cache.get(key);
    if (!hit) {
      const a = conns[lo].center;
      const b = conns[hi].center;
      hit = sectorPath(ctx, si, a, b) ?? [vclone(a), vclone(b)];
      cache.set(key, hit);
    }
    // cached paths run from the lower edge id to the higher one; orient for the caller
    return ea <= eb ? hit : [...hit].reverse();
  };
  // rough (euclidean) perimeter used only for ordering
  const rough = (c: RawCycle): number => {
    let l = 0;
    for (let i = 0; i < c.edges.length; i++) l += vdist(conns[c.edges[i]].center, conns[c.edges[(i + 1) % c.edges.length]].center);
    return l;
  };
  const ordered = [...cycles].sort((x, y) => rough(x) - rough(y)).slice(0, 400);
  const evals: (TopologyStructure & { raw: RawCycle })[] = [];
  const MIN_FAR = 10;
  const MIN_FAR_FRACTION = 0.4;
  for (const c of ordered) {
    const m = c.verts.length;
    // traversal k: inside sector v_k from portal e_{k-1} to portal e_k
    const segs: V3[][] = [];
    for (let k = 0; k < m; k++) segs.push(pathIn(c.verts[k], c.edges[(k - 1 + m) % m], c.edges[k]));
    const total = segs.reduce((acc, sp) => acc + polylineLength(sp), 0);
    const concat = (idxs: number[]): V3[] => {
      const out: V3[] = [];
      for (const k of idxs) for (const p of segs[k]) if (out.length === 0 || vdist(out[out.length - 1], p) > 1e-9) out.push(p);
      return out;
    };
    let best: { min: number; arcs: [number, number]; sep: [number, number] } | null = null;
    let bestAny: { min: number; arcs: [number, number]; sep: [number, number] } | null = null;
    for (let i = 0; i < m; i++) {
      for (let j = i + 1; j < m; j++) {
        // portals e_i and e_j split the cycle: arc1 = traversals i+1..j, arc2 = the rest
        const idx1: number[] = [];
        for (let k = i + 1; k <= j; k++) idx1.push(k);
        const idx2: number[] = [];
        for (let k = j + 1; k < m; k++) idx2.push(k);
        for (let k = 0; k <= i; k++) idx2.push(k);
        const a1 = concat(idx1);
        const a2 = concat(idx2);
        const l1 = polylineLength(a1);
        const l2 = polylineLength(a2);
        const mn = Math.min(l1, l2);
        const sep: [number, number] = [farFraction(a1, a2, MIN_FAR), farFraction(a2, a1, MIN_FAR)];
        const cand = { min: mn, arcs: [l1, l2] as [number, number], sep };
        if (!bestAny || mn > bestAny.min) bestAny = cand;
        const sepOk = sep[0] >= MIN_FAR_FRACTION && sep[1] >= MIN_FAR_FRACTION;
        if (mn >= LIMITS_STAGE.BRANCH_ROUTE_MIN_METERS && sepOk && (!best || mn > best.min)) best = cand;
      }
    }
    const pick = best ?? bestAny ?? { min: 0, arcs: [0, 0] as [number, number], sep: [0, 0] as [number, number] };
    evals.push({
      raw: c,
      sectors: c.verts.map((v) => stage.sectors[v].id),
      connectionIds: c.edges.map((e) => conns[e].id),
      perimeter: total,
      arcs: pick.arcs,
      separation: pick.sep,
      qualifies: best !== null,
    });
  }
  const qual = evals.filter((e) => e.qualifies).sort((a, b) => a.perimeter - b.perimeter);
  // greedy independent set: GF(2)-independent cycles, each adding at least one edge not used before
  const basis: bigint[] = [];
  const reduce = (v: bigint): bigint => {
    for (const b of basis) {
      const hb = b & -b; // lowest set bit as pivot
      if (v & hb) v ^= b;
    }
    return v;
  };
  const used = new Set<number>();
  const chosen: TopologyStructure[] = [];
  for (const q of qual) {
    let vec = 0n;
    for (const e of q.raw.edges) vec |= 1n << BigInt(e);
    const r = reduce(vec);
    if (r === 0n) continue;
    if (!q.raw.edges.some((e) => !used.has(e))) continue;
    basis.push(r);
    for (const e of q.raw.edges) used.add(e);
    chosen.push({ sectors: q.sectors, connectionIds: q.connectionIds, perimeter: q.perimeter, arcs: q.arcs, separation: q.separation, qualifies: true });
  }
  const rejected = evals
    .filter((e) => !e.qualifies)
    .slice(0, 5)
    .map((e) => ({ sectors: e.sectors, connectionIds: e.connectionIds, perimeter: e.perimeter, arcs: e.arcs, separation: e.separation, qualifies: false }));
  return { structures: chosen, rejected, truncated, cyclesFound: cycles.length };
}


// ---------------------------------------------------------------------------------------------------------------------
// Item 1: sectors
// ---------------------------------------------------------------------------------------------------------------------
function checkSectors(ctx: Ctx): void {
  const S = ctx.stage.sectors;
  const ids = S.map((s) => s.id);
  const uniqueIds = new Set(ids);
  const badBounds = S.filter((s) => !vfinite(s.bounds.min) || !vfinite(s.bounds.max) || s.bounds.min.x >= s.bounds.max.x || s.bounds.min.y >= s.bounds.max.y || s.bounds.min.z >= s.bounds.max.z);
  addCheck(ctx, {
    name: 'sectors.count',
    label: '区画数',
    pass: S.length >= LIMITS_STAGE.SECTOR_MIN,
    value: S.length,
    threshold: `>= ${LIMITS_STAGE.SECTOR_MIN}`,
    details: `sectors=${S.length}`,
  });
  addCheck(ctx, {
    name: 'sectors.ids',
    label: '区画IDの一意性と境界の妥当性',
    pass: uniqueIds.size === S.length && ids.every((i) => i.length > 0) && badBounds.length === 0,
    value: uniqueIds.size,
    threshold: `unique ids == ${S.length}, valid bounds`,
    details: uniqueIds.size !== S.length ? `duplicate ids: ${ids.filter((x, i) => ids.indexOf(x) !== i).join(',')}` : badBounds.length ? `invalid bounds: ${badBounds.map((b) => b.id).join(',')}` : 'ok',
  });
  const overlaps: string[] = [];
  for (let i = 0; i < S.length; i++)
    for (let j = i + 1; j < S.length; j++) {
      const v = boxOverlapVolume(S[i].bounds, S[j].bounds);
      if (v > 0) overlaps.push(`${S[i].id}&${S[j].id}(${fmt(v, 1)}m3)`);
    }
  addCheck(ctx, {
    name: 'sectors.overlap',
    label: '区画boundsが互いに重ならない',
    pass: overlaps.length === 0,
    value: overlaps.length,
    threshold: '0 overlapping pairs',
    details: overlaps.length ? overlaps.slice(0, 8).join(', ') : 'no overlaps',
  });
  const kinds = new Set(S.map((s) => s.kind));
  const names = new Set(S.map((s) => s.name));
  addCheck(ctx, {
    name: 'sectors.variety',
    label: '空間種別/名称の種類数',
    pass: kinds.size >= LIMITS_STAGE.KIND_MIN && names.size >= LIMITS_STAGE.KIND_MIN,
    value: kinds.size,
    threshold: `kinds >= ${LIMITS_STAGE.KIND_MIN} and names >= ${LIMITS_STAGE.KIND_MIN}`,
    details: `kinds=${[...kinds].join('/')} (${kinds.size}), distinct names=${names.size}/${S.length}`,
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Item 2: enemies (static checks; reachability is added after the flood fill)
// ---------------------------------------------------------------------------------------------------------------------
function distPointBox(p: V3, b: AABB): number {
  const dx = Math.max(b.min.x - p.x, 0, p.x - b.max.x);
  const dy = Math.max(b.min.y - p.y, 0, p.y - b.max.y);
  const dz = Math.max(b.min.z - p.z, 0, p.z - b.max.z);
  return Math.hypot(dx, dy, dz);
}

function checkEnemies(ctx: Ctx): EnemyCheckRow[] {
  const stage = ctx.stage;
  const spawns = stage.enemies;
  const states = ctx.states;
  const guards = spawns.filter((e) => e.kind === 'guard').length;
  const turrets = spawns.filter((e) => e.kind === 'turret').length;
  addCheck(ctx, {
    name: 'enemies.count',
    label: '敵の数(警備30・砲台15・計45)',
    pass: spawns.length === ENEMIES.TOTAL && guards === LIMITS_STAGE.GUARDS && turrets === LIMITS_STAGE.TURRETS,
    value: `${guards}+${turrets}=${spawns.length}`,
    threshold: `${LIMITS_STAGE.GUARDS} guards + ${LIMITS_STAGE.TURRETS} turrets = ${ENEMIES.TOTAL}`,
    details: `guards=${guards}, turrets=${turrets}`,
  });
  const idSet = new Set(spawns.map((e) => e.id));
  const hpBad = states.filter((s) => s.maxHp !== ENEMIES[s.kind].hp || s.hp !== ENEMIES[s.kind].hp);
  addCheck(ctx, {
    name: 'enemies.ids',
    label: '敵IDの一意性とHP(enemies.ts側の設定)',
    pass: idSet.size === spawns.length && hpBad.length === 0,
    value: idSet.size,
    threshold: `unique ids == ${spawns.length}; guard hp ${ENEMIES.guard.hp}, turret hp ${ENEMIES.turret.hp}`,
    details: idSet.size !== spawns.length ? 'duplicate enemy ids' : hpBad.length ? `hp mismatch: ${hpBad.map((s) => `${s.id}=${s.maxHp}`).join(',')}` : `hp from createEnemies(): guard=${ENEMIES.guard.hp}, turret=${ENEMIES.turret.hp}`,
  });

  // control turrets
  const controls = spawns.filter((e) => e.isGateControl);
  const problems: string[] = [];
  if (controls.length !== LIMITS_STAGE.CONTROLS) problems.push(`control turrets=${controls.length} (need ${LIMITS_STAGE.CONTROLS})`);
  for (const c of controls) if (c.kind !== 'turret') problems.push(`${c.id} is not a turret`);
  const controlIdx = new Set(controls.map((c) => c.controlIndex));
  for (let k = 0; k < LIMITS_STAGE.CONTROLS; k++) if (!controlIdx.has(k)) problems.push(`controlIndex ${k} missing`);
  const nonFinal = stage.barriers.filter((b) => !b.isFinal);
  const finals = stage.barriers.filter((b) => b.isFinal);
  if (nonFinal.length !== LIMITS_STAGE.CONTROLS) problems.push(`non-final barriers=${nonFinal.length} (need ${LIMITS_STAGE.CONTROLS})`);
  if (finals.length !== 1) problems.push(`final gates=${finals.length} (need 1)`);
  const barrierIds = new Set(stage.barriers.map((b) => b.id));
  if (barrierIds.size !== stage.barriers.length) problems.push('duplicate barrier ids');
  const usedControl = new Set<string>();
  for (const b of nonFinal) {
    const e = spawns.find((x) => x.id === b.controlEnemyId);
    if (!e) {
      problems.push(`${b.id}: control enemy ${b.controlEnemyId} not found`);
      continue;
    }
    if (!e.isGateControl || e.barrierId !== b.id) problems.push(`${b.id}: ${e.id} does not point back (barrierId=${e.barrierId}, isGateControl=${e.isGateControl})`);
    if (usedControl.has(e.id)) problems.push(`${e.id} controls two barriers`);
    usedControl.add(e.id);
  }
  for (const c of controls) if (!nonFinal.some((b) => b.controlEnemyId === c.id)) problems.push(`${c.id} controls no barrier`);
  for (const b of finals) if (b.controlEnemyId !== null) problems.push(`final gate ${b.id} must have no single control enemy`);
  const ctlSectors = new Set(controls.map((c) => c.sectorId));
  if (ctlSectors.size < LIMITS_STAGE.CONTROLS) problems.push(`control turrets are in only ${ctlSectors.size} distinct sectors`);
  addCheck(ctx, {
    name: 'enemies.controls',
    label: '制御砲台6体と隔壁の1対1対応・区画分散',
    pass: problems.length === 0,
    value: `${controls.length} controls / ${ctlSectors.size} sectors`,
    threshold: `${LIMITS_STAGE.CONTROLS} turrets <-> ${LIMITS_STAGE.CONTROLS} barriers 1:1, >= ${LIMITS_STAGE.CONTROLS} distinct sectors`,
    details: problems.length ? problems.join('; ') : `controls: ${controls.map((c) => `${c.id}@${c.sectorId}->${c.barrierId}`).join(', ')}`,
  });

  // spawn geometry
  const rows: EnemyCheckRow[] = [];
  for (const st of states) {
    const problemsE: string[] = [];
    const cfg = ENEMIES[st.kind];
    const sec = stage.sectors.find((x) => x.id === st.sectorId);
    if (!sec) problemsE.push(`unknown sector ${st.sectorId}`);
    else if (!boxInside(st.pos, sec.bounds)) problemsE.push(`position ${fv(st.pos)} outside sector ${sec.id} bounds`);
    if (ctx.worldClosed.pointInSolid(st.pos)) {
      problemsE.push('centre is inside a box');
    } else {
      let clear = Infinity;
      let who = '';
      for (const b of stage.boxes) {
        const d = distPointBox(st.pos, b);
        if (d < clear) {
          clear = d;
          who = b.id;
        }
      }
      if (clear < st.hitRadius - 0.1) problemsE.push(`hit sphere (r=${st.hitRadius}) penetrates ${who} (clearance ${fmt(clear, 2)} m)`);
    }
    const down = ctx.worldClosed.raycast(st.pos, { x: 0, y: -1, z: 0 }, 30);
    if (!down) problemsE.push('no floor below');
    else if (down.t < cfg.centerHeight - 0.6 || down.t > cfg.centerHeight + 0.6) problemsE.push(`floor is ${fmt(down.t, 2)} m below (expected about ${cfg.centerHeight})`);
    const up = ctx.worldClosed.raycast(st.pos, { x: 0, y: 1, z: 0 }, 3);
    if (up && up.t < 3) problemsE.push(`headroom only ${fmt(up.t, 2)} m`);
    rows.push({ id: st.id, kind: st.kind, sectorId: st.sectorId, problems: problemsE });
  }
  const bad = rows.filter((r) => r.problems.length > 0);
  addCheck(ctx, {
    name: 'enemies.spawns',
    label: '敵スポーンが埋まらず床の上にある',
    pass: bad.length === 0,
    value: bad.length,
    threshold: '0 buried / floating / low-headroom spawns',
    details: bad.length ? bad.slice(0, 6).map((r) => `${r.id}: ${r.problems.join(', ')}`).join(' | ') : `all ${rows.length} spawns are clear of boxes, on a floor, with >= 3 m headroom, inside their sector`,
  });
  return rows;
}

// ---------------------------------------------------------------------------------------------------------------------
// Item 7 / 8: floor arenas and crossfire
// ---------------------------------------------------------------------------------------------------------------------
interface ArenaGrid {
  ox: number;
  oz: number;
  W: number;
  D: number;
  free: Uint8Array;
  floorY: number;
}

function arenaGrid(stage: StageDef, sector: SectorDef): ArenaGrid {
  const b = sector.bounds;
  const ox = b.min.x;
  const oz = b.min.z;
  const W = Math.max(1, Math.ceil(b.max.x - b.min.x));
  const D = Math.max(1, Math.ceil(b.max.z - b.min.z));
  const fy = sector.floorY;
  const blocked = new Uint8Array(W * D);
  const support = new Uint8Array(W * D);
  for (const box of stage.boxes) {
    if (box.max.x <= b.min.x || box.min.x >= b.max.x || box.max.z <= b.min.z || box.min.z >= b.max.z) continue;
    if (box.max.y <= b.min.y || box.min.y >= b.max.y) continue;
    const i0 = Math.max(0, Math.floor(box.min.x - ox));
    const i1 = Math.min(W - 1, Math.ceil(box.max.x - ox) - 1);
    const k0 = Math.max(0, Math.floor(box.min.z - oz));
    const k1 = Math.min(D - 1, Math.ceil(box.max.z - oz) - 1);
    const obstructs = box.max.y > fy + 0.02 && box.min.y < fy + PLAYER.HALF.y * 2;
    const supports = Math.abs(box.max.y - fy) <= 0.05;
    if (!obstructs && !supports) continue;
    for (let k = k0; k <= k1; k++) {
      for (let i = i0; i <= i1; i++) {
        if (obstructs) blocked[k * W + i] = 1;
        if (supports) {
          const cx = ox + i + 0.5;
          const cz = oz + k + 0.5;
          if (cx > box.min.x && cx < box.max.x && cz > box.min.z && cz < box.max.z) support[k * W + i] = 1;
        }
      }
    }
  }
  const free = new Uint8Array(W * D);
  for (let i = 0; i < free.length; i++) free[i] = support[i] && !blocked[i] ? 1 : 0;
  return { ox, oz, W, D, free, floorY: fy };
}

/** exists an axis-aligned all-free rectangle with x-extent >= a and z-extent >= b (cells of 1 m) */
function rectExists(g: ArenaGrid, a: number, b: number): boolean {
  const h = new Int32Array(g.W);
  for (let k = 0; k < g.D; k++) {
    let run = 0;
    for (let i = 0; i < g.W; i++) {
      h[i] = g.free[k * g.W + i] ? h[i] + 1 : 0;
      if (h[i] >= b) {
        run++;
        if (run >= a) return true;
      } else run = 0;
    }
  }
  return false;
}

function bestRect(g: ArenaGrid): { width: number; depth: number } | null {
  const h = new Int32Array(g.W);
  let best: { width: number; depth: number } | null = null;
  let bestArea = 0;
  for (let k = 0; k < g.D; k++) {
    for (let i = 0; i < g.W; i++) h[i] = g.free[k * g.W + i] ? h[i] + 1 : 0;
    const stack: number[] = [];
    for (let i = 0; i <= g.W; i++) {
      const cur = i === g.W ? 0 : h[i];
      while (stack.length && h[stack[stack.length - 1]] >= cur) {
        const top = stack.pop() as number;
        const height = h[top];
        const left = stack.length ? stack[stack.length - 1] + 1 : 0;
        const width = i - left;
        if (height * width > bestArea) {
          bestArea = height * width;
          best = { width, depth: height };
        }
      }
      stack.push(i);
    }
  }
  return best;
}

function checkArenasAndCrossfire(ctx: Ctx): { arenas: ArenaInfo[]; combat: CombatSectorInfo[] } {
  const stage = ctx.stage;
  const arenas: ArenaInfo[] = [];
  const combat: CombatSectorInfo[] = [];
  const grids = new Map<string, ArenaGrid>();
  for (const sec of stage.sectors) {
    const g = arenaGrid(stage, sec);
    grids.set(sec.id, g);
    let cells = 0;
    for (let i = 0; i < g.free.length; i++) cells += g.free[i];
    const has = rectExists(g, LIMITS_STAGE.ARENA_W, LIMITS_STAGE.ARENA_D) || rectExists(g, LIMITS_STAGE.ARENA_D, LIMITS_STAGE.ARENA_W);
    arenas.push({ sectorId: sec.id, floorCells: cells, bestRect: bestRect(g), has60x50: has, declaredCombat: sec.combat });
  }
  const wide = arenas.filter((a) => a.has60x50);
  addCheck(ctx, {
    name: 'arena.wide',
    label: '広い戦闘空間(60x50m以上の空き床)の区画数',
    pass: wide.length >= LIMITS_STAGE.WIDE_ARENAS_MIN,
    value: wide.length,
    threshold: `>= ${LIMITS_STAGE.WIDE_ARENAS_MIN} sectors with an obstacle-free ${LIMITS_STAGE.ARENA_W}x${LIMITS_STAGE.ARENA_D} m rectangle`,
    details: `qualifying: ${wide.map((a) => `${a.sectorId}(${a.bestRect ? `${a.bestRect.width}x${a.bestRect.depth}` : '-'})`).join(', ') || 'none'}`,
  });

  // crossfire
  const byS = new Map<string, EnemyState[]>();
  for (const e of ctx.states) {
    const arr = byS.get(e.sectorId) ?? [];
    arr.push(e);
    byS.set(e.sectorId, arr);
  }
  for (const sec of stage.sectors) {
    const es = byS.get(sec.id) ?? [];
    const g = grids.get(sec.id) as ArenaGrid;
    let best = 0;
    let bestPoint: V3 | null = null;
    let samples = 0;
    if (es.length >= 1) {
      const muzzles = es.map((e) => ({ m: enemyMuzzlePosition(e), range: ENEMIES[e.kind].sensorRange }));
      for (let k = 2; k < g.D; k += 4) {
        for (let i = 2; i < g.W; i += 4) {
          if (!g.free[k * g.W + i]) continue;
          samples++;
          const p = { x: g.ox + i + 0.5, y: g.floorY + PLAYER.HALF.y, z: g.oz + k + 0.5 };
          let cnt = 0;
          for (const mm of muzzles) {
            if (vdist(mm.m, p) > mm.range) continue;
            if (!ctx.worldClosed.segmentBlocked(mm.m, p)) cnt++;
          }
          if (cnt > best) {
            best = cnt;
            bestPoint = p;
          }
        }
      }
    }
    combat.push({ sectorId: sec.id, enemies: es.length, samples, bestVisible: best, bestPoint, qualifies: best >= LIMITS_STAGE.CROSSFIRE_ENEMIES_MIN });
  }
  const okS = combat.filter((c) => c.qualifies);
  addCheck(ctx, {
    name: 'combat.crossfire',
    label: '複数方向の攻撃(4体以上が射線を取れる区画)',
    pass: okS.length >= LIMITS_STAGE.CROSSFIRE_SECTORS_MIN,
    value: okS.length,
    threshold: `>= ${LIMITS_STAGE.CROSSFIRE_SECTORS_MIN} sectors where some floor point is visible from >= ${LIMITS_STAGE.CROSSFIRE_ENEMIES_MIN} in-range enemies of that sector`,
    details: `qualifying: ${okS.map((c) => `${c.sectorId}(${c.bestVisible}/${c.enemies})`).join(', ') || 'none'}`,
  });
  return { arenas, combat };
}

// ---------------------------------------------------------------------------------------------------------------------
// Item 9: start safety
// ---------------------------------------------------------------------------------------------------------------------
function checkStart(ctx: Ctx): void {
  const stage = ctx.stage;
  const start = stage.playerStart.pos;
  const w = ctx.worldClosed;
  const targets: V3[] = [];
  for (const sx of [-1, 0, 1]) for (const sy of [-1, 0, 1]) for (const sz of [-1, 0, 1]) targets.push({ x: start.x + sx * HALF.x, y: start.y + sy * HALF.y, z: start.z + sz * HALF.z });
  const exposed: string[] = [];
  for (const e of ctx.states) {
    const m = enemyMuzzlePosition(e);
    if (targets.some((t) => !w.segmentBlocked(m, t))) exposed.push(e.id);
  }
  const overlap = w.overlapAABB(start, HALF, 1e-4);
  const floor = w.raycast(start, { x: 0, y: -1, z: 0 }, 5);
  const feetGap = floor ? floor.t - HALF.y : Infinity;
  const inSector = sectorIndexAt(stage, start) >= 0;
  addCheck(ctx, {
    name: 'start.safe',
    label: 'スタートの安全(全敵の銃口から射線が通らない・衝突なし)',
    pass: exposed.length === 0 && !overlap && feetGap <= 0.5 && feetGap >= -0.05 && inSector,
    value: exposed.length,
    threshold: '0 enemies with line of sight to any of the 27 player-box sample points; no overlap; standing on a floor',
    details: `exposed to: ${exposed.join(',') || 'none'}; overlap=${overlap}; feet gap=${Number.isFinite(feetGap) ? fmt(feetGap, 3) : 'no floor'}; inside a sector=${inSector}`,
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Items 10 / 11: shell, portals, barriers
// ---------------------------------------------------------------------------------------------------------------------
function faceContactAxis(sa: SectorDef, sb: SectorDef, center: V3): number {
  const lo = (b: AABB): number[] => [b.min.x, b.min.y, b.min.z];
  const hi = (b: AABB): number[] => [b.max.x, b.max.y, b.max.z];
  const A = sa.bounds;
  const B = sb.bounds;
  const c = [center.x, center.y, center.z];
  const cands: { axis: number; plane: number }[] = [];
  for (let t = 0; t < 3; t++) {
    const p1 = hi(A)[t];
    const p2 = hi(B)[t];
    const touching1 = Math.abs(p1 - lo(B)[t]) <= 0.5;
    const touching2 = Math.abs(p2 - lo(A)[t]) <= 0.5;
    if (!touching1 && !touching2) continue;
    let overlaps = true;
    for (let u = 0; u < 3; u++) {
      if (u === t) continue;
      if (Math.min(hi(A)[u], hi(B)[u]) - Math.max(lo(A)[u], lo(B)[u]) <= 0) overlaps = false;
    }
    if (overlaps) cands.push({ axis: t, plane: touching1 ? p1 : p2 });
  }
  if (cands.length === 1) return cands[0].axis;
  if (cands.length > 1) {
    cands.sort((p, q) => Math.abs(c[p.axis] - p.plane) - Math.abs(c[q.axis] - q.plane));
    return cands[0].axis;
  }
  const ca = { x: (A.min.x + A.max.x) / 2, y: (A.min.y + A.max.y) / 2, z: (A.min.z + A.max.z) / 2 };
  const cb = { x: (B.min.x + B.max.x) / 2, y: (B.min.y + B.max.y) / 2, z: (B.min.z + B.max.z) / 2 };
  const d = [Math.abs(cb.x - ca.x), Math.abs(cb.y - ca.y), Math.abs(cb.z - ca.z)];
  return d[0] >= d[1] && d[0] >= d[2] ? 0 : d[1] >= d[2] ? 1 : 2;
}

/** the player-box lanes through a portal opening (axis, lateral and vertical offsets) */
function portalLanes(p: PortalDef, axis: number): { start: V3; delta: V3 }[] {
  const D = 6;
  const step = 0.25;
  const lanes: { start: V3; delta: V3 }[] = [];
  const range = (halfSpan: number): number[] => {
    if (halfSpan <= 0) return [0];
    const n = Math.max(1, Math.ceil((2 * halfSpan) / step));
    return Array.from({ length: n + 1 }, (_, i) => -halfSpan + (2 * halfSpan * i) / n);
  };
  if (axis === 1) {
    const hx = p.width / 2 - HALF.x;
    const hz = p.width / 2 - HALF.z;
    for (const ox of range(hx)) {
      for (const oz of range(hz)) {
        lanes.push({ start: { x: p.center.x + ox, y: p.center.y - D, z: p.center.z + oz }, delta: { x: 0, y: 2 * D, z: 0 } });
      }
    }
    return lanes;
  }
  const latAxis = axis === 0 ? 2 : 0;
  const latHalf = p.width / 2 - (latAxis === 0 ? HALF.x : HALF.z);
  const vHalf = p.height / 2 - HALF.y;
  for (const o of range(latHalf)) {
    for (const oy of range(vHalf)) {
      const c = { x: p.center.x + (latAxis === 0 ? o : 0), y: p.center.y + oy, z: p.center.z + (latAxis === 2 ? o : 0) };
      const s = { x: c.x - (axis === 0 ? D : 0), y: c.y, z: c.z - (axis === 2 ? D : 0) };
      lanes.push({ start: s, delta: { x: axis === 0 ? 2 * D : 0, y: 0, z: axis === 2 ? 2 * D : 0 } });
    }
  }
  return lanes;
}

function checkPortalsAndBarriers(ctx: Ctx, conns: readonly Conn[]): void {
  const stage = ctx.stage;
  // ---- dimensions
  const dimBad = stage.portals.filter((p) => !(p.width >= LIMITS_STAGE.PORTAL_MIN_WIDTH) || !(p.height >= LIMITS_STAGE.PORTAL_MIN_HEIGHT));
  const refBad = stage.portals.filter((p) => !stage.sectors.some((s) => s.id === p.a) || !stage.sectors.some((s) => s.id === p.b) || (p.barrierId !== null && !stage.barriers.some((b) => b.id === p.barrierId)));
  addCheck(ctx, {
    name: 'portal.dimensions',
    label: 'portal開口寸法(幅>=5m・高さ>=6m)',
    pass: dimBad.length === 0 && refBad.length === 0 && stage.portals.length > 0,
    value: dimBad.length,
    threshold: `width >= ${LIMITS_STAGE.PORTAL_MIN_WIDTH}, height >= ${LIMITS_STAGE.PORTAL_MIN_HEIGHT}; valid sector/barrier references`,
    details: dimBad.length ? `too small: ${dimBad.map((p) => `${p.id}(${p.width}x${p.height})`).join(',')}` : refBad.length ? `bad references: ${refBad.map((p) => p.id).join(',')}` : `${stage.portals.length} portals; min width ${stage.portals.length ? fmt(Math.min(...stage.portals.map((p) => p.width))) : '-'} min height ${stage.portals.length ? fmt(Math.min(...stage.portals.map((p) => p.height))) : '-'}`,
  });

  // ---- open-state passability (real sweeps through the opening, all barriers open)
  const openFail: string[] = [];
  const axisOf = new Map<string, number>();
  for (const p of stage.portals) {
    const sa = stage.sectors.find((s) => s.id === p.a);
    const sb = stage.sectors.find((s) => s.id === p.b);
    if (!sa || !sb) {
      openFail.push(`${p.id}(bad sector)`);
      continue;
    }
    const axis = faceContactAxis(sa, sb, p.center);
    axisOf.set(p.id, axis);
    const lanes = portalLanes(p, axis);
    let pass = 0;
    for (const l of lanes) if (!ctx.worldOpen.overlapAABB(l.start, HALF, 1e-4) && sweepFree(ctx.worldOpen, l.start, HALF, l.delta)) pass++;
    if (pass === 0) openFail.push(`${p.id}(0/${lanes.length} lanes)`);
  }
  addCheck(ctx, {
    name: 'portal.open',
    label: '開いた状態でportalを実際に通行できる',
    pass: openFail.length === 0 && stage.portals.length > 0,
    value: openFail.length,
    threshold: 'every portal: at least one player-box lane passes through the opening (sweepAABB, barriers open)',
    details: openFail.length ? `blocked: ${openFail.join(', ')}` : `${stage.portals.length} portals passable`,
  });

  // ---- closed barriers must seal every portal that uses them
  const leakRows: string[] = [];
  let sealedLanes = 0;
  const barrierProblems: string[] = [];
  for (const br of stage.barriers) {
    const idxs = ctx.bb.byBarrier.get(br.id) ?? [];
    const listed = ctx.bb.listedByBarrier.get(br.id) ?? [];
    if (idxs.length === 0) barrierProblems.push(`${br.id}: no boxes`);
    if (idxs.length !== listed.length) barrierProblems.push(`${br.id}: boxes with barrierId but not in BarrierDef.boxIds`);
    for (const id of br.boxIds) if (ctx.worldOpen.indexOfBox(id) < 0) barrierProblems.push(`${br.id}: box ${id} does not exist`);
    const ps = stage.portals.filter((p) => p.barrierId === br.id);
    if (ps.length === 0) barrierProblems.push(`${br.id}: no portal uses this barrier`);
    const bw = new World(idxs.map((i) => stage.boxes[i]));
    for (const p of ps) {
      const axis = axisOf.get(p.id);
      if (axis === undefined) continue;
      const lanes = portalLanes(p, axis);
      let leaks = 0;
      for (const l of lanes) {
        if (sweepFree(bw, l.start, HALF, l.delta)) leaks++;
        else sealedLanes++;
      }
      if (leaks > 0) leakRows.push(`${br.id}@${p.id}: ${leaks}/${lanes.length} lanes pass while closed`);
    }
  }
  addCheck(ctx, {
    name: 'barrier.block',
    label: '隔壁の箱が開口を完全に塞いでいる(閉鎖時に通れない)',
    pass: leakRows.length === 0 && barrierProblems.length === 0 && stage.barriers.length > 0,
    value: leakRows.length + barrierProblems.length,
    threshold: '0 leaking lanes; every barrier has boxes and a portal',
    details: leakRows.length || barrierProblems.length ? [...leakRows, ...barrierProblems].join('; ') : `${stage.barriers.length} barriers sealed (${sealedLanes} lanes blocked)`,
  });

  // ---- declared portals vs real openings (advisory both ways; the strict undeclared-opening check lives in the shortcut group)
  const unmatched = stage.portals.filter((p) => !conns.some((c) => c.portalId === p.id));
  addCheck(ctx, {
    name: 'portal.matched',
    label: 'portal宣言と実際の開口の一致',
    pass: unmatched.length === 0,
    value: unmatched.length,
    threshold: 'every declared portal coincides with a real free-space connection',
    details: unmatched.length ? `no real connection near: ${unmatched.map((p) => p.id).join(',')}` : `${stage.portals.length} portals matched to ${conns.length} connections`,
    advisory: true,
  });
}


// ---------------------------------------------------------------------------------------------------------------------
// Reachability based checks (open state): enemies, floors, altitude layers, shell (roof / perimeter)
// ---------------------------------------------------------------------------------------------------------------------
function nearestReached(grid: Grid, reach: Uint8Array, p: V3, R: number): number {
  const rc = Math.ceil(R / grid.h);
  const i0 = Math.round((p.x - grid.ox) / grid.h);
  const j0 = Math.round((p.y - grid.oy) / grid.h);
  const k0 = Math.round((p.z - grid.oz) / grid.h);
  let best = Infinity;
  for (let k = k0 - rc; k <= k0 + rc; k++) {
    for (let j = j0 - rc; j <= j0 + rc; j++) {
      for (let i = i0 - rc; i <= i0 + rc; i++) {
        if (!grid.inBounds(i, j, k)) continue;
        const n = grid.idx(i, j, k);
        if (!reach[n]) continue;
        const d = Math.hypot(grid.ox + i * grid.h - p.x, grid.oy + j * grid.h - p.y, grid.oz + k * grid.h - p.z);
        if (d < best) best = d;
      }
    }
  }
  return best;
}

function reachSeeds(ctx: Ctx, world: World): number[] {
  const grid = ctx.grid as Grid;
  const env: PathEnv = { grid, world, half: HALF_C };
  return seedsFor(env, ctx.stage.playerStart.pos, null).map((s) => s.node);
}

function checkReachability(ctx: Ctx, reach: Uint8Array, rows: EnemyCheckRow[]): { layers: { y: number; area: number }[] } {
  const grid = ctx.grid as Grid;
  const stage = ctx.stage;
  // ---- enemies
  const unreachable: string[] = [];
  for (const e of ctx.states) {
    const d = nearestReached(grid, reach, e.pos, 6);
    const row = rows.find((r) => r.id === e.id);
    if (!(d <= 6)) {
      unreachable.push(e.id);
      row?.problems.push('no reachable player position within 6 m');
    }
  }
  addCheck(ctx, {
    name: 'reach.enemies',
    label: '到達不能な敵がない',
    pass: unreachable.length === 0,
    value: unreachable.length,
    threshold: '0 enemies without a start-reachable player position within 6 m',
    details: unreachable.length ? `unreachable: ${unreachable.join(',')}` : `all ${ctx.states.length} enemies are within 6 m of the start-reachable free space (barriers open)`,
  });

  // ---- floors: standing points on box tops per sector
  const stride = 6;
  let unreachSamples = 0;
  let totalSamples = 0;
  const sectorRows: string[] = [];
  let sectorFail = 0;
  const wOpen = ctx.worldOpen;
  for (const sec of stage.sectors) {
    const b = sec.bounds;
    let tot = 0;
    let unr = 0;
    for (let x = b.min.x + stride / 2; x < b.max.x; x += stride) {
      for (let z = b.min.z + stride / 2; z < b.max.z; z += stride) {
        const seenTop = new Set<number>();
        for (const box of stage.boxes) {
          if (x <= box.min.x || x >= box.max.x || z <= box.min.z || z >= box.max.z) continue;
          const top = box.max.y;
          if (top + HALF.y + 0.01 > b.max.y || top < b.min.y) continue;
          const key = Math.round(top * 100);
          if (seenTop.has(key)) continue;
          seenTop.add(key);
          const c = { x, y: top + HALF.y + 0.01, z };
          if (wOpen.overlapAABB(c, HALF, 1e-4)) continue;
          tot++;
          if (!(nearestReached(grid, reach, c, 3.5) <= 3.5)) unr++;
        }
      }
    }
    totalSamples += tot;
    unreachSamples += unr;
    if (tot > 0 && (tot - unr) / tot < 0.5) {
      sectorFail++;
      sectorRows.push(`${sec.id}: ${tot - unr}/${tot} reachable`);
    }
  }
  addCheck(ctx, {
    name: 'reach.floors',
    label: '到達不能な床がない',
    pass: sectorFail === 0 && totalSamples > 0,
    value: unreachSamples,
    threshold: 'in every sector >= 50% of the standing-surface samples are start-reachable',
    details: `standing samples=${totalSamples}, unreachable=${unreachSamples}${sectorRows.length ? `; sectors mostly unreachable: ${sectorRows.join(', ')}` : ''}`,
  });

  // ---- altitude layers
  const tops: { y: number; area: number }[] = [];
  for (const box of stage.boxes) {
    const w = box.max.x - box.min.x;
    const d = box.max.z - box.min.z;
    if (w < 4 || d < 4 || w * d < 100) continue;
    const c = { x: (box.min.x + box.max.x) / 2, y: box.max.y + HALF.y + 0.01, z: (box.min.z + box.max.z) / 2 };
    if (sectorIndexAt(stage, c) < 0) continue;
    if (wOpen.overlapAABB(c, HALF, 1e-4)) continue;
    if (!(nearestReached(grid, reach, c, 3.5) <= 3.5)) continue;
    tops.push({ y: box.max.y, area: w * d });
  }
  tops.sort((a, b) => a.y - b.y);
  const layers: { y: number; area: number }[] = [];
  for (const t of tops) {
    const last = layers[layers.length - 1];
    if (last && t.y - last.y <= 2.5) {
      last.area += t.area;
    } else layers.push({ y: t.y, area: t.area });
  }
  const bands = layers.filter((l) => l.area >= 250);
  addCheck(ctx, {
    name: 'layers.bands',
    label: '3層以上の高度帯(実際に立てる大きな床面)',
    pass: bands.length >= LIMITS_STAGE.LAYERS_MIN,
    value: bands.length,
    threshold: `>= ${LIMITS_STAGE.LAYERS_MIN} altitude bands (reachable box tops >= 100 m2 each, >= 250 m2 per band, clustered within 2.5 m)`,
    details: bands.map((l) => `y=${fmt(l.y)}(${fmt(l.area, 0)}m2)`).join(', ') || 'none',
  });
  return { layers: bands };
}

function checkShell(ctx: Ctx, reach: Uint8Array, outsideContacts: number): void {
  const grid = ctx.grid as Grid;
  // ---- perimeter: reachable free space must stay inside sector bounds
  let outside = 0;
  const samples: number[] = [];
  for (let n = 0; n < grid.n; n++) {
    if (reach[n] && grid.label[n] < 0) {
      outside++;
      if (samples.length < 3 && (outside === 1 || outside % 997 === 0)) samples.push(n);
    }
  }
  let confirmed: SearchResult | null = null;
  let confirmedAt: V3 | null = null;
  if (outside > 0) {
    const env: PathEnv = { grid, world: ctx.worldOpen, half: HALF_C };
    for (const t of samples) {
      const tp = grid.pos(t);
      const r = exactSearch(env, ctx.stage.playerStart.pos, (n) => n === t, (x, y, z) => Math.hypot(x - tp.x, y - tp.y, z - tp.z), null, 20);
      if (r) {
        confirmed = r;
        confirmedAt = tp;
        break;
      }
    }
  }
  addCheck(ctx, {
    name: 'shell.perimeter',
    label: '外周が閉じている(到達可能領域がbounds内)',
    pass: confirmed === null,
    value: confirmed ? outside : 0,
    threshold: '0 reachable free-space nodes outside every sector bounds',
    details: confirmed
      ? `the player can leave the sectors: reachable outside nodes=${outside}, verified route of ${fmt(polylineLength(confirmed.points))} m to ${fv(confirmedAt as V3)}`
      : outside > 0
        ? `flood fill touched ${outside} outside nodes but no sweep-verified route exists (thin gap suspect)`
        : `contacts with outside=${outsideContacts}; reachable region stays inside the sector bounds`,
  });
  if (outside > 0 && !confirmed) ctx.warnings.push(`perimeter: ${outside} outside nodes reachable by flood fill only (not confirmed by sweeps)`);

  // ---- roof: nothing reachable can look up into the open
  const open: V3[] = [];
  let columns = 0;
  const up = { x: 0, y: 1, z: 0 };
  for (let k = 0; k < grid.nz; k++) {
    for (let i = 0; i < grid.nx; i++) {
      let top = -1;
      for (let j = grid.ny - 1; j >= 0; j--) {
        if (reach[grid.idx(i, j, k)]) {
          top = j;
          break;
        }
      }
      if (top < 0) continue;
      const n = grid.idx(i, top, k);
      if (grid.label[n] < 0) continue;
      columns++;
      const p = grid.pos(n);
      if (ctx.worldOpen.raycast({ x: p.x + 0.0113, y: p.y, z: p.z + 0.0171 }, up, 1e4) === null) open.push(p);
    }
  }
  addCheck(ctx, {
    name: 'shell.roof',
    label: '各区画の上方に開口がない(屋根/天井が閉じている)',
    pass: open.length === 0 && columns > 0,
    value: open.length,
    threshold: '0 reachable columns whose upward ray escapes without hitting a roof/ceiling',
    details: open.length ? `open above at ${open.slice(0, 4).map((p) => fv(p, 0)).join(' ')} (+${Math.max(0, open.length - 4)} more)` : `${columns} reachable columns all covered`,
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Barrier-state reachability (item 4)
// ---------------------------------------------------------------------------------------------------------------------
function analyseBarrierStates(ctx: Ctx, route: RouteReport): { rows: BarrierStateRow[]; after: string[]; leakedAfter: string[] } {
  const grid = ctx.grid as Grid;
  const stage = ctx.stage;
  const zone = stage.escapeZone;
  const allIds = stage.barriers.map((b) => b.id);
  const states: { label: string; closed: string[] }[] = stage.barriers.map((b) => ({ label: `${b.id}のみ閉鎖(他は開放)`, closed: [b.id] }));
  states.push({ label: '全隔壁を閉鎖', closed: [...allIds] });
  const rows: BarrierStateRow[] = [];
  for (const st of states) {
    const world = makeWorld(stage, ctx.bb, new Set(allIds.filter((i) => !st.closed.includes(i))));
    grid.rebuildBlocked(world, HALF_C);
    const env: PathEnv = { grid, world, half: HALF_C };
    const seeds = seedsFor(env, stage.playerStart.pos, null);
    const reach = grid.flood(seeds.map((x) => x.node));
    // goal reached?
    let goalReach = false;
    const i0 = Math.max(0, Math.ceil((zone.min.x - grid.ox) / grid.h));
    const i1 = Math.min(grid.nx - 1, Math.floor((zone.max.x - grid.ox) / grid.h));
    const j0 = Math.max(0, Math.ceil((zone.min.y - grid.oy) / grid.h));
    const j1 = Math.min(grid.ny - 1, Math.floor((zone.max.y - grid.oy) / grid.h));
    const k0 = Math.max(0, Math.ceil((zone.min.z - grid.oz) / grid.h));
    const k1 = Math.min(grid.nz - 1, Math.floor((zone.max.z - grid.oz) / grid.h));
    for (let k = k0; k <= k1 && !goalReach; k++)
      for (let j = j0; j <= j1 && !goalReach; j++)
        for (let i = i0; i <= i1; i++)
          if (reach[grid.idx(i, j, k)]) {
            goalReach = true;
            break;
          }
    const count = new Map<number, number>();
    for (let n = 0; n < grid.n; n++) if (reach[n]) count.set(grid.label[n], (count.get(grid.label[n]) ?? 0) + 1);
    const reachableSectors = [...count.keys()].filter((l) => l >= 0).sort((a, b) => a - b).map((l) => stage.sectors[l].id);
    let confirmed: number | null = null;
    if (goalReach) {
      const r = exactSearch(env, stage.playerStart.pos, (n) => boxInside(grid.pos(n), zone), zoneHeuristic(zone), null, 30);
      if (r) confirmed = polylineLength(r.points);
    }
    rows.push({ label: st.label, closed: st.closed, goalReachable: confirmed !== null, reachableSectors, confirmedLength: confirmed });
    ctx.log(`barrier state "${st.label}": goal ${confirmed !== null ? 'REACHABLE' : goalReach ? 'flood-only' : 'sealed'}, ${reachableSectors.length} sectors reachable`);
  }
  // sectors entered by the open-state route after the first barrier must not be reachable with everything closed
  const all = rows[rows.length - 1];
  const first = route.barrierCrossings[0];
  const after = first ? route.sectorEntries.filter((e) => e.atMeters > first.atMeters + 1).map((e) => e.sectorId) : [];
  const leakedAfter = after.filter((sid) => all.reachableSectors.includes(sid));
  const leakChecks: string[] = [];
  for (const sid of leakedAfter) {
    const si = stage.sectors.findIndex((s) => s.id === sid);
    const world = makeWorld(stage, ctx.bb, new Set());
    grid.rebuildBlocked(world, HALF_C);
    const env: PathEnv = { grid, world, half: HALF_C };
    const r = exactSearch(env, stage.playerStart.pos, (n) => grid.label[n] === si, () => 0, null, 20);
    if (r) leakChecks.push(`${sid} (${fmt(polylineLength(r.points))} m)`);
  }
  return { rows, after, leakedAfter: leakChecks };
}

// ---------------------------------------------------------------------------------------------------------------------
// Declared routes (branches / loops / main route)
// ---------------------------------------------------------------------------------------------------------------------
function evalDeclaredPolyline(ctx: Ctx, id: string, pts: readonly V3[], declaredLength: number | null): DeclaredRouteResult {
  const problems: string[] = [];
  if (pts.length < 2) problems.push('fewer than 2 points');
  let length = polylineLength(pts);
  if (pts.some((p) => !vfinite(p))) {
    problems.push('non-finite point');
    length = 0;
  }
  if (problems.length === 0) {
    if (ctx.worldOpen.overlapAABB(pts[0], HALF, 1e-4)) problems.push(`start ${fv(pts[0])} overlaps a box`);
    for (let i = 1; i < pts.length; i++) {
      if (!sweepFree(ctx.worldOpen, pts[i - 1], HALF, vsub(pts[i], pts[i - 1]))) {
        problems.push(`segment ${i - 1}->${i} ${fv(pts[i - 1])}->${fv(pts[i])} is blocked`);
        break;
      }
    }
    if (declaredLength !== null && Math.abs(length - declaredLength) > Math.max(0.5, 0.005 * declaredLength)) {
      problems.push(`declared length ${fmt(declaredLength, 2)} != polyline length ${fmt(length, 2)}`);
    }
  }
  const sectors: string[] = [];
  if (problems.length === 0) {
    sampleAlong(pts, 1, (p) => {
      const si = sectorIndexAt(ctx.stage, p);
      if (si >= 0) {
        const sid = ctx.stage.sectors[si].id;
        if (!sectors.includes(sid)) sectors.push(sid);
      }
    });
  }
  return { id, ok: problems.length === 0, length, declaredLength, sectors, problems };
}

function divergentMeters(pts: readonly V3[], other: readonly V3[], threshold: number): number {
  let m = 0;
  sampleAlong(pts, 1, (p) => {
    if (distToPolyline(p, other).dist > threshold) m += 1;
  });
  return m;
}

function evalDeclaredBranches(ctx: Ctx, conns: readonly Conn[]): DeclaredBranchResult[] {
  const stage = ctx.stage;
  const out: DeclaredBranchResult[] = [];
  for (const br of stage.branches) {
    const problems: string[] = [];
    const routes = br.routes.map((r) => evalDeclaredPolyline(ctx, r.id, r.points, r.lengthMeters));
    if (br.routes.length < 2) problems.push('fewer than 2 routes');
    br.routes.forEach((r, i) => {
      const res = routes[i];
      if (res.length < LIMITS_STAGE.BRANCH_ROUTE_MIN_METERS) res.problems.push(`route shorter than ${LIMITS_STAGE.BRANCH_ROUTE_MIN_METERS} m (${fmt(res.length)} m)`);
      if (res.ok || res.sectors.length > 0) {
        if (res.sectors[0] !== br.splitSectorId) res.problems.push(`starts in ${res.sectors[0]} not split sector ${br.splitSectorId}`);
        if (res.sectors[res.sectors.length - 1] !== br.mergeSectorId) res.problems.push(`ends in ${res.sectors[res.sectors.length - 1]} not merge sector ${br.mergeSectorId}`);
        for (const sid of r.sectorIds) if (!res.sectors.includes(sid)) res.problems.push(`declared sector ${sid} is not traversed`);
        for (const sid of res.sectors) if (!r.sectorIds.includes(sid) && sid !== br.splitSectorId && sid !== br.mergeSectorId) res.problems.push(`traverses undeclared sector ${sid}`);
      }
      res.ok = res.problems.length === 0;
    });
    // distinctness
    for (let i = 0; i < br.routes.length; i++) {
      for (let j = i + 1; j < br.routes.length; j++) {
        const A = routes[i];
        const B = routes[j];
        if (!A.sectors.length || !B.sectors.length) continue;
        const inner = (r: DeclaredRouteResult): string => r.sectors.filter((s) => s !== br.splitSectorId && s !== br.mergeSectorId).sort().join(',');
        const div = Math.min(divergentMeters(br.routes[i].points, br.routes[j].points, 6), divergentMeters(br.routes[j].points, br.routes[i].points, 6));
        if (inner(A) === inner(B) && div < 20) problems.push(`routes ${A.id} and ${B.id} are not distinct (diverge only ${fmt(div, 0)} m)`);
      }
    }
    const s = stage.sectors.findIndex((x) => x.id === br.splitSectorId);
    const m = stage.sectors.findIndex((x) => x.id === br.mergeSectorId);
    const disjoint = edgeDisjointPaths(stage.sectors.length, conns, s, m);
    if (disjoint < 2) problems.push(`the real sector graph has only ${disjoint} edge-disjoint path(s) between ${br.splitSectorId} and ${br.mergeSectorId}`);
    const ok = problems.length === 0 && routes.every((r) => r.ok);
    out.push({ id: br.id, ok, split: br.splitSectorId, merge: br.mergeSectorId, edgeDisjointPaths: disjoint, routes, problems });
  }
  return out;
}

function evalDeclaredLoops(ctx: Ctx, conns: readonly Conn[]): DeclaredRouteResult[] {
  const out: DeclaredRouteResult[] = [];
  for (const lp of ctx.stage.loops) {
    const res = evalDeclaredPolyline(ctx, lp.id, lp.points, null);
    if (res.ok || res.length > 0) {
      const pts = lp.points;
      if (pts.length >= 2 && vdist(pts[0], pts[pts.length - 1]) > 3) res.problems.push(`loop is not closed (gap ${fmt(vdist(pts[0], pts[pts.length - 1]))} m)`);
      if (res.length < 2 * LIMITS_STAGE.BRANCH_ROUTE_MIN_METERS) res.problems.push(`loop shorter than ${2 * LIMITS_STAGE.BRANCH_ROUTE_MIN_METERS} m (${fmt(res.length)} m)`);
      // not a simple out-and-back: the two halves must be apart
      const half = res.length / 2;
      const first: V3[] = [];
      const second: V3[] = [];
      sampleAlong(pts, 1, (p, at) => (at <= half ? first : second).push(p));
      let apart = 0;
      for (const p of first) if (distToPolyline(p, second.length > 1 ? second : first).dist > 6) apart++;
      const frac = first.length ? apart / first.length : 0;
      if (frac < 0.4) res.problems.push(`loop retraces itself (only ${fmt(frac * 100, 0)}% of the first half is >6 m from the second half)`);
      // real graph: traversed sectors must contain a cycle
      const set = new Set(res.sectors);
      const edges = conns.filter((c) => set.has(c.a) && set.has(c.b));
      const V = set.size;
      // connected components among traversed sectors
      const par = new Map<string, string>();
      const find = (x: string): string => {
        let r = x;
        while (par.get(r) !== r) r = par.get(r) as string;
        return r;
      };
      for (const sname of set) par.set(sname, sname);
      for (const e of edges) par.set(find(e.a), find(e.b));
      const comps = new Set([...set].map(find)).size;
      if (edges.length - V + comps < 1) res.problems.push('the traversed sectors contain no cycle in the real connection graph');
      res.ok = res.problems.length === 0;
    }
    out.push(res);
  }
  return out;
}


// ---------------------------------------------------------------------------------------------------------------------
// Item 6: flight climbs (real Game physics, bot driven)
// ---------------------------------------------------------------------------------------------------------------------
export function allLoadouts(): Loadout[] {
  const out: Loadout[] = [];
  for (const fcs of Object.keys(FCS_PARTS) as FcsId[])
    for (const generator of Object.keys(GENERATOR_PARTS) as GeneratorId[])
      for (const legs of Object.keys(LEGS_PARTS) as LegsId[]) out.push({ fcs, generator, legs });
  return out;
}

/** the stage's own boxes around a climb (barriers open, no enemies) as a stage that `Game` can drive */
function climbSubStage(stage: StageDef, bb: BarrierBoxes, climb: ClimbDef): StageDef {
  const pad = 45;
  const minX = Math.min(climb.from.x, climb.to.x) - pad;
  const maxX = Math.max(climb.from.x, climb.to.x) + pad;
  const minZ = Math.min(climb.from.z, climb.to.z) - pad;
  const maxZ = Math.max(climb.from.z, climb.to.z) + pad;
  const minY = Math.min(climb.from.y, climb.to.y) - 15;
  const maxY = Math.max(climb.from.y, climb.to.y) + 45;
  const barrierIdx = new Set<number>();
  for (const idxs of bb.byBarrier.values()) for (const i of idxs) barrierIdx.add(i);
  const boxes = stage.boxes.filter((b, i) => !barrierIdx.has(i) && b.max.x > minX && b.min.x < maxX && b.max.z > minZ && b.min.z < maxZ && b.max.y > minY && b.min.y < maxY);
  return {
    ...stage,
    boxes,
    enemies: [],
    barriers: [],
    portals: [],
    branches: [],
    loops: [],
    climbs: [],
    playerStart: { pos: { x: climb.from.x, y: climb.from.y + HALF.y + 0.01, z: climb.from.z }, yaw: 0 },
  };
}

function aimYaw(game: Game, target: V3): void {
  const p = game.state.player;
  const dx = target.x - p.pos.x;
  const dz = target.z - p.pos.z;
  if (Math.hypot(dx, dz) < 1e-6) return;
  const yawT = Math.atan2(-dx, -dz);
  let d = p.yaw - yawT;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  if (Math.abs(d) > 1e-6) game.look(d / CAMERA.SENSITIVITY, 0);
}

type BotStrategy = 'vertical' | 'diagonal' | 'path';

interface BotRun {
  success: boolean;
  strategy: BotStrategy;
  enStart: number;
  enMin: number;
  thrustTicks: number;
  ticks: number;
  failure: string | null;
}

/** free-flight route from the standing spot of a climb to just above the landing spot, inside the climb's local geometry */
function climbWaypoints(sub: StageDef, climb: ClimbDef): V3[] | null {
  const pad = 30;
  const min = {
    x: Math.floor(Math.min(climb.from.x, climb.to.x) - pad),
    y: Math.floor(Math.min(climb.from.y, climb.to.y) - 4),
    z: Math.floor(Math.min(climb.from.z, climb.to.z) - pad),
  };
  const max = {
    x: Math.ceil(Math.max(climb.from.x, climb.to.x) + pad),
    y: Math.ceil(Math.max(climb.from.y, climb.to.y) + 24),
    z: Math.ceil(Math.max(climb.from.z, climb.to.z) + pad),
  };
  const grid = new Grid(min, max, 1, []);
  const world = new World(sub.boxes);
  grid.rebuildBlocked(world, HALF_C);
  const env: PathEnv = { grid, world, half: HALF_C };
  const start = { x: climb.from.x, y: climb.from.y + HALF.y + 0.01, z: climb.from.z };
  const goal = { x: climb.to.x, y: climb.to.y + HALF.y + 0.5, z: climb.to.z };
  const goalSeeds = seedsFor(env, goal, null);
  if (goalSeeds.length === 0) return null;
  const goalSet = new Set(goalSeeds.map((g) => g.node));
  const res = exactSearch(env, start, (n) => goalSet.has(n), (x, y, z) => Math.max(0, Math.hypot(x - goal.x, y - goal.y, z - goal.z) - 2), null, 20);
  if (!res) return null;
  const pts = smoothPath(env, [...res.points, goal], null, null);
  return pts;
}

/**
 * fly from the lower platform (Space held), clear the upper edge, move over the landing platform, release and land.
 * strategies: 'vertical' = straight up first, 'diagonal' = move toward the landing point while climbing,
 * 'path' = follow a collision-free free-flight route (carrot following) around obstacles.
 */
function runClimbBot(sub: StageDef, climb: ClimbDef, loadout: Loadout, strategy: BotStrategy, waypoints: V3[] | null = null): BotRun {
  const game = new Game({ stage: sub, loadout, seed: 1 });
  game.sortie(loadout);
  const s = game.state;
  const to = climb.to;
  const maxTicks = Math.round(20 / SIM.DT);
  const targetFeet = to.y + 0.8;
  const RELEASE = 2;
  let phase: 'ascend' | 'traverse' | 'follow' | 'land' = strategy === 'path' ? 'follow' : 'ascend';
  let landTicks = 0;
  let thrust = 0;
  let enMin = s.player.en;
  const enStart = s.player.en;
  let bestHd = Infinity;
  let bestHdTick = 0;
  let failure: string | null = null;
  let success = false;
  let tick = 0;
  const wps: V3[] = waypoints ?? [];
  let wpIdx = 1; // wps[0] is the start
  let lastProgressTick = 0;
  for (; tick < maxTicks; tick++) {
    const p = s.player;
    if (s.mode !== 'playing') {
      failure = `game ended (${s.endReason})`;
      break;
    }
    const feet = p.pos.y - HALF.y;
    const hd = Math.hypot(to.x - p.pos.x, to.z - p.pos.z);
    const vy = p.vel.y;
    const apex = feet + (vy > 0 ? (vy * vy) / (2 * GRAVITY) : 0);
    const inp = game.input;
    if (phase === 'ascend') {
      inp.jump = true;
      inp.forward = strategy === 'diagonal';
      if (strategy === 'diagonal') aimYaw(game, to);
      if (feet >= targetFeet) phase = 'traverse';
    }
    if (phase === 'traverse') {
      aimYaw(game, to);
      inp.forward = true;
      inp.jump = apex < targetFeet;
      if (hd < bestHd - 0.5) {
        bestHd = hd;
        bestHdTick = tick;
      }
      if (tick - bestHdTick > 360) {
        failure = `no horizontal progress toward the landing platform (stuck ${fmt(hd)} m away at feet y=${fmt(feet)})`;
        break;
      }
      if (hd <= RELEASE && feet >= to.y + 0.15) phase = 'land';
    }
    if (phase === 'follow') {
      if (wps.length < 2) {
        failure = 'no free-flight route between the platforms';
        break;
      }
      // carrot on the current segment
      while (wpIdx < wps.length - 1 && vdist(p.pos, wps[wpIdx]) < 1.2) {
        wpIdx++;
        lastProgressTick = tick;
      }
      const a = wps[wpIdx - 1];
      const b = wps[wpIdx];
      const ab = vsub(b, a);
      const len = Math.max(1e-6, Math.hypot(ab.x, ab.y, ab.z));
      const proj = Math.max(0, Math.min(len, vdot(vsub(p.pos, a), ab) / len));
      const carrotAt = Math.min(len, proj + 3);
      const carrot = vadd(a, vscale(ab, carrotAt / len));
      aimYaw(game, carrot);
      const hdc = Math.hypot(carrot.x - p.pos.x, carrot.z - p.pos.z);
      inp.forward = hdc > 0.4;
      const yDes = carrot.y - HALF.y; // desired feet height
      inp.jump = apex < yDes + 0.3;
      if (vdist(p.pos, b) < bestHd - 0.5) {
        bestHd = vdist(p.pos, b);
        lastProgressTick = tick;
      }
      if (tick - lastProgressTick > 360) {
        failure = `path following stalled near ${fv(p.pos)} (waypoint ${wpIdx}/${wps.length - 1})`;
        break;
      }
      if (wpIdx === wps.length - 1 && hd <= RELEASE && feet >= to.y + 0.15) phase = 'land';
    }
    if (phase === 'land') {
      inp.jump = false;
      inp.forward = false;
      landTicks++;
      if (p.grounded && landTicks > 3) {
        const support = game.world.raycast(p.pos, { x: 0, y: -1, z: 0 }, 3);
        const targetSupport = game.world.raycast({ x: to.x, y: to.y + 2, z: to.z }, { x: 0, y: -1, z: 0 }, 5);
        const sameBox = !!support && !!targetSupport && support.boxIndex === targetSupport.boxIndex;
        if (Math.abs(feet - to.y) <= 0.3 && (sameBox || hd <= 6)) success = true;
        else failure = `landed at feet y=${fmt(feet, 2)} (${fmt(hd)} m from the landing point), not on the upper platform y=${fmt(to.y, 2)}`;
        break;
      }
    }
    if (p.pos.y < sub.killY) {
      failure = 'fell out of the stage';
      break;
    }
    game.step();
    if (s.player.mv.thrusting) thrust++;
    if (s.player.en < enMin) enMin = s.player.en;
  }
  if (!success && failure === null) failure = phase === 'land' ? 'did not land in time' : `timeout in phase ${phase} (feet y=${fmt(s.player.pos.y - HALF.y)}, en=${fmt(s.player.en)})`;
  if (!success && s.player.en <= 1e-6 && failure) failure += ' [EN exhausted]';
  return { success, strategy, enStart, enMin, thrustTicks: thrust, ticks: tick, failure };
}

function runJumpTest(sub: StageDef, climb: ClimbDef): { maxRise: number; reaches: boolean } {
  let maxRise = 0;
  let reaches = false;
  for (const glide of [false, true]) {
    const game = new Game({ stage: sub, seed: 1 });
    game.sortie();
    const s = game.state;
    for (let t = 0; t < 360; t++) {
      const p = s.player;
      aimYaw(game, climb.to);
      game.input.forward = true;
      game.input.jump = t < 12; // a short tap: below the 0.20 s flight threshold
      game.input.shift = glide && t === 1;
      game.step();
      const feet = p.pos.y - HALF.y;
      maxRise = Math.max(maxRise, feet - climb.from.y);
      if (p.grounded && feet >= climb.to.y - 0.25 && Math.hypot(p.pos.x - climb.to.x, p.pos.z - climb.to.z) <= 8) reaches = true;
    }
  }
  return { maxRise, reaches };
}

function evaluateClimbs(ctx: Ctx, route: RouteReport, loadouts: Loadout[]): ClimbResult[] {
  const stage = ctx.stage;
  const out: ClimbResult[] = [];
  for (const c of stage.climbs) {
    const notes: string[] = [];
    const measured = c.to.y - c.from.y;
    const heightOk =
      c.heightMeters >= LIMITS_STAGE.CLIMB_HEIGHT_MIN && c.heightMeters <= LIMITS_STAGE.CLIMB_HEIGHT_MAX &&
      measured >= LIMITS_STAGE.CLIMB_HEIGHT_MIN - 1e-6 && measured <= LIMITS_STAGE.CLIMB_HEIGHT_MAX + 1e-6 &&
      Math.abs(measured - c.heightMeters) <= 0.05;
    if (!heightOk) notes.push(`height declared ${fmt(c.heightMeters, 2)} / measured ${fmt(measured, 2)} outside 6..16 m or inconsistent`);
    // both platforms: a floor at that height and space to stand
    let platformsOk = true;
    for (const [name, p] of [['from', c.from], ['to', c.to]] as [string, V3][]) {
      const down = ctx.worldOpen.raycast({ x: p.x, y: p.y + 2.5, z: p.z }, { x: 0, y: -1, z: 0 }, 6);
      const standing = { x: p.x, y: p.y + HALF.y + 0.01, z: p.z };
      if (!down || Math.abs(down.point.y - p.y) > 0.05) {
        platformsOk = false;
        notes.push(`${name} ${fv(p)}: no floor top at that height`);
      } else if (ctx.worldOpen.overlapAABB(standing, HALF, 1e-4)) {
        platformsOk = false;
        notes.push(`${name} ${fv(p)}: not enough room to stand`);
      }
    }
    // proximity to the shortest route
    const a = { x: c.from.x, y: c.from.y + HALF.y, z: c.from.z };
    const b = { x: c.to.x, y: c.to.y + HALF.y, z: c.to.z };
    let pathDistance = Infinity;
    for (let i = 1; i < route.points.length; i++) pathDistance = Math.min(pathDistance, segmentSegmentDistance(route.points[i - 1], route.points[i], a, b));
    const onPath = route.found && pathDistance <= LIMITS_STAGE.CLIMB_ON_PATH_TOL;
    if (!onPath) notes.push(`shortest route passes ${Number.isFinite(pathDistance) ? fmt(pathDistance) : 'n/a'} m from this climb`);
    const sub = climbSubStage(stage, ctx.bb, c);
    const jump = runJumpTest(sub, c);
    if (jump.reaches) notes.push('reachable with a normal jump / glide (no flight needed)');
    const configs: ClimbConfigResult[] = [];
    let wpCache: V3[] | null | undefined;
    const waypoints = (): V3[] | null => {
      if (wpCache === undefined) wpCache = climbWaypoints(sub, c);
      return wpCache;
    };
    for (const lo of loadouts) {
      let res = runClimbBot(sub, c, lo, 'vertical');
      const failures: string[] = [];
      if (!res.success) {
        failures.push(`vertical: ${res.failure}`);
        const alt = runClimbBot(sub, c, lo, 'diagonal');
        if (alt.success) res = alt;
        else {
          failures.push(`diagonal: ${alt.failure}`);
          const pathRun = runClimbBot(sub, c, lo, 'path', waypoints());
          if (pathRun.success) res = pathRun;
          else {
            failures.push(`path: ${pathRun.failure}`);
            res = { ...pathRun, failure: failures.join('; ') };
          }
        }
      }
      configs.push({
        fcs: lo.fcs,
        generator: lo.generator,
        legs: lo.legs,
        success: res.success,
        strategy: res.success ? res.strategy : null,
        enStart: res.enStart,
        enUsed: res.enStart - res.enMin,
        enMin: res.enMin,
        flightSeconds: res.thrustTicks * SIM.DT,
        timeSeconds: res.ticks * SIM.DT,
        failure: res.failure,
      });
    }
    out.push({
      id: c.id,
      sectorId: c.sectorId,
      from: c.from,
      to: c.to,
      declaredHeight: c.heightMeters,
      measuredHeight: measured,
      heightOk,
      platformsOk,
      jumpMaxRise: jump.maxRise,
      jumpReaches: jump.reaches,
      onPath,
      pathDistance: Number.isFinite(pathDistance) ? pathDistance : -1,
      configs,
      allConfigsOk: configs.every((x) => x.success),
      maxEnUsed: configs.reduce((m, x) => Math.max(m, x.enUsed), 0),
      minMaxEn: configs.reduce((m, x) => Math.min(m, x.enStart), Infinity),
      notes,
    });
    ctx.log(`climb ${c.id}: ${configs.filter((x) => x.success).length}/${configs.length} configs ok, jump rise ${fmt(jump.maxRise, 2)} m`);
  }
  return out;
}

function checkClimbs(ctx: Ctx, climbs: readonly ClimbResult[], ran: boolean): void {
  const stage = ctx.stage;
  const heightBad = climbs.filter((c) => !c.heightOk || !c.platformsOk);
  addCheck(ctx, {
    name: 'climb.height',
    label: '昇降の高低差(6〜16m)と前後の足場',
    pass: climbs.length > 0 && heightBad.length === 0,
    value: climbs.length,
    threshold: `heights ${LIMITS_STAGE.CLIMB_HEIGHT_MIN}..${LIMITS_STAGE.CLIMB_HEIGHT_MAX} m (declared = measured), standing platforms at both ends`,
    details: heightBad.length ? heightBad.map((c) => `${c.id}: ${c.notes.join('; ')}`).join(' | ') : `heights: ${climbs.map((c) => `${c.id}=${fmt(c.measuredHeight)}`).join(', ') || 'none'}`,
  });
  const jumpBad = climbs.filter((c) => c.jumpReaches || c.jumpMaxRise > LIMITS_STAGE.JUMP_MAX_HEIGHT + 0.3);
  addCheck(ctx, {
    name: 'climb.needsFlight',
    label: '通常ジャンプ(最大2.78m)では上がれない',
    pass: climbs.length > 0 && jumpBad.length === 0,
    value: fmt(climbs.reduce((m, c) => Math.max(m, c.jumpMaxRise), 0), 2),
    threshold: `real jump physics: max rise <= ${fmt(LIMITS_STAGE.JUMP_MAX_HEIGHT + 0.3, 2)} m and the upper platform is never reached`,
    details: jumpBad.length ? `jump reaches: ${jumpBad.map((c) => `${c.id}(rise ${fmt(c.jumpMaxRise, 2)}, reached=${c.jumpReaches})`).join(',')}` : `max jump rise ${fmt(climbs.reduce((m, c) => Math.max(m, c.jumpMaxRise), 0), 2)} m (theory ${fmt(LIMITS_STAGE.JUMP_MAX_HEIGHT, 2)} m)`,
  });
  // distinct places on the route
  const valid = climbs.filter((c) => c.heightOk && c.platformsOk && !c.jumpReaches && c.onPath);
  const clusters: V3[] = [];
  for (const c of valid) if (!clusters.some((p) => vdist(p, c.from) < 20)) clusters.push(c.from);
  addCheck(ctx, {
    name: 'climb.onPath',
    label: '飛行が必要な昇降箇所(別々の場所)が最短経路上に6か所以上',
    pass: clusters.length >= LIMITS_STAGE.CLIMBS_MIN,
    value: clusters.length,
    threshold: `>= ${LIMITS_STAGE.CLIMBS_MIN} distinct (>= 20 m apart) valid climbs within ${LIMITS_STAGE.CLIMB_ON_PATH_TOL} m of the start->escape route`,
    details: `valid climbs=${valid.length}/${stage.climbs.length}: ${valid.map((c) => `${c.id}(${fmt(c.pathDistance)}m off route)`).join(', ') || 'none'}; off-route: ${climbs.filter((c) => !c.onPath).map((c) => c.id).join(',') || 'none'}`,
  });
  if (!ran) {
    addCheck(ctx, { name: 'climb.flight18', label: '全18構成で飛行昇降が可能', pass: false, value: 'not run', threshold: '18 loadouts x every climb succeed', details: 'flight bot disabled by options' });
    return;
  }
  const failed: string[] = [];
  let runs = 0;
  let worstEn = 0;
  for (const c of climbs) {
    for (const r of c.configs) {
      runs++;
      worstEn = Math.max(worstEn, r.enUsed);
      if (!r.success) failed.push(`${c.id}/${r.fcs}-${r.generator}-${r.legs}: ${r.failure}`);
    }
  }
  const minMax = climbs.length ? Math.min(...climbs.map((c) => c.minMaxEn)) : 0;
  addCheck(ctx, {
    name: 'climb.flight18',
    label: '全18構成で飛行昇降が可能(実際のplayer物理で着地)',
    pass: climbs.length > 0 && failed.length === 0,
    value: `${runs - failed.length}/${runs}`,
    threshold: 'every climb x 18 loadouts: lower platform -> Space hold flight + horizontal move + release -> land on the upper platform',
    details: failed.length ? `failed ${failed.length}: ${failed.slice(0, 5).join(' | ')}` : `all ${runs} runs succeeded; max EN used ${fmt(worstEn)} of min max-EN ${fmt(minMax, 0)} (recovery generator = 90)`,
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------------------------------------------------
function guard(ctx: Ctx, name: string, fn: () => void): void {
  try {
    timed(ctx, name, fn);
  } catch (err) {
    const msg = err instanceof Error ? `${err.message}\n${(err.stack ?? '').split('\n').slice(1, 4).join('\n')}` : String(err);
    ctx.warnings.push(`internal error in ${name}: ${msg}`);
    addCheck(ctx, { name: `internal.${name}`, label: `検証器内部エラー(${name})`, pass: false, value: 'exception', threshold: 'no exception', details: msg });
  }
}

export function validateStage(stage: StageDef, options: ValidateOptions = {}): StageReport {
  const log = options.onProgress ?? ((): void => undefined);
  const bb = collectBarrierBoxes(stage);
  const ctx: Ctx = {
    stage,
    bb,
    worldOpen: makeWorld(stage, bb, 'all'),
    worldClosed: makeWorld(stage, bb, new Set()),
    grid: null,
    gridNote: '',
    states: createEnemies(stage),
    warnings: [],
    timings: {},
    log,
    checks: [],
  };

  let route: RouteReport = {
    found: false,
    points: [],
    length: 0,
    gridLength: 0,
    relaxedLength: null,
    straightLength: distPointBox(stage.playerStart.pos, stage.escapeZone),
    sectors: [],
    sectorEntries: [],
    barrierCrossings: [],
    gridStep: 0,
    note: '',
  };
  let conns: Conn[] = [];
  let structures: TopologyStructure[] = [];
  let declaredBranches: DeclaredBranchResult[] = [];
  let declaredLoops: DeclaredRouteResult[] = [];
  let climbs: ClimbResult[] = [];
  let arenas: ArenaInfo[] = [];
  let combat: CombatSectorInfo[] = [];
  let enemyRows: EnemyCheckRow[] = [];
  let barrierStates: BarrierStateRow[] = [];
  let minHops: { count: number; sectors: string[] } = { count: 0, sectors: [] };
  let layers: { y: number; area: number }[] = [];

  guard(ctx, 'sectors', () => checkSectors(ctx));
  guard(ctx, 'enemies', () => {
    enemyRows = checkEnemies(ctx);
  });

  // ---- grid + route (item 3)
  guard(ctx, 'grid', () => {
    const g = makeGrid(stage, options.gridStep ?? 2);
    ctx.grid = g.grid;
    ctx.gridNote = g.note;
    route.gridStep = g.grid ? g.grid.h : 0;
    log(g.note);
  });
  guard(ctx, 'route', () => {
    let run = computeRoute(ctx, HALF_C);
    let note = run.note;
    // more runs on other grids (another homotopy / smoothing start); the shortest feasible route is the best upper bound.
    // Near the limit the estimate error matters, so more grids are tried there.
    if (run.found && ctx.grid && options.altRouteGrid !== false) {
      const scales = run.length < LIMITS_STAGE.ROUTE_MIN_METERS * 1.1 ? [1.5, 0.75, 2.25] : [1.5];
      for (const sc of scales) {
        const alt = makeGrid(stage, ctx.grid.h * sc);
        if (!alt.grid) continue;
        const r2 = computeRoute(ctx, HALF_C, alt.grid);
        note += `; grid ${fmt(alt.grid.h, 2)} m: ${r2.found ? `${fmt(r2.length)} m` : 'no route'}`;
        if (r2.found && r2.length < run.length) run = { ...r2, note: run.note };
      }
    }
    route = { ...route, found: run.found, points: run.points, length: run.length, gridLength: run.gridLength, note };
    if (run.found) {
      const rs = routeSectors(stage, run.points);
      route.sectors = rs.sectors;
      route.sectorEntries = rs.entries;
      route.barrierCrossings = barrierCrossings(ctx, run.points);
      log(`route: ${fmt(run.length)} m (grid ${fmt(run.gridLength)} m), sectors ${rs.sectors.length}`);
    } else log(`route: not found (${run.note})`);
  });
  guard(ctx, 'route.checks', () => {
    addCheck(ctx, {
      name: 'route.length',
      label: '最短の実行可能経路長(飛行自由・全隔壁開放)',
      pass: route.found && route.length >= LIMITS_STAGE.ROUTE_MIN_METERS,
      value: route.found ? Math.round(route.length * 10) / 10 : 'no route',
      threshold: `>= ${LIMITS_STAGE.ROUTE_MIN_METERS} m`,
      details: route.found
        ? `smoothed sweep-verified route ${fmt(route.length)} m (upper bound of the true shortest; raw grid path ${fmt(route.gridLength)} m, straight-line lower bound ${fmt(route.straightLength)} m, ${ctx.gridNote}); ${route.note}${route.length < LIMITS_STAGE.ROUTE_MIN_METERS * 1.05 ? `; WARNING: within 5% of the ${LIMITS_STAGE.ROUTE_MIN_METERS} m limit while the estimate can exceed the true shortest length by ~2.5%` : ''}`
        : `${route.note} (${ctx.gridNote})`,
    });
    addCheck(ctx, {
      name: 'route.sectors',
      label: '必須経路で物理的に通過する区画数',
      pass: route.found && route.sectors.length >= LIMITS_STAGE.ROUTE_SECTORS_MIN,
      value: route.sectors.length,
      threshold: `>= ${LIMITS_STAGE.ROUTE_SECTORS_MIN}`,
      details: route.sectors.join(' -> ') || 'none',
    });
    const mr = stage.mainRoute;
    const declared = evalDeclaredPolyline(ctx, 'mainRoute', mr.points, null);
    addCheck(ctx, {
      name: 'route.declared',
      label: '記載された経路座標(mainRoute)が通行可能で最短経路以上の長さ',
      pass: declared.ok && (!route.found || declared.length >= route.length - 1),
      value: fmt(declared.length),
      threshold: 'declared waypoints connected by collision-free straight moves; length >= verified shortest route',
      details: declared.ok ? `declared route ${fmt(declared.length)} m vs verified ${route.found ? fmt(route.length) : 'n/a'} m` : declared.problems.join('; '),
      advisory: true,
    });
  });

  const gridReady = ctx.grid !== null && route.gridStep > 0;
  if (gridReady) {
    let reach: Uint8Array | null = null;
    let outsideContacts = 0;
    guard(ctx, 'flood', () => {
      const grid = ctx.grid as Grid;
      grid.rebuildBlocked(ctx.worldOpen, HALF_C);
      reach = grid.flood(reachSeeds(ctx, ctx.worldOpen));
      let n = 0;
      for (let i = 0; i < grid.n; i++) n += reach[i];
      log(`open-state reachable nodes: ${n}`);
    });
    if (reach) {
      const reachArr = reach as Uint8Array;
      guard(ctx, 'connections', () => {
        const b = buildConnections(ctx, reachArr);
        conns = b.conns;
        outsideContacts = b.outsideContacts;
        log(`connections: ${conns.length}`);
      });
      guard(ctx, 'reachability', () => {
        layers = checkReachability(ctx, reachArr, enemyRows).layers;
      });
      guard(ctx, 'shell', () => checkShell(ctx, reachArr, outsideContacts));
      guard(ctx, 'hops', () => {
        const from = sectorIndexAt(stage, stage.playerStart.pos);
        const zc = { x: (stage.escapeZone.min.x + stage.escapeZone.max.x) / 2, y: (stage.escapeZone.min.y + stage.escapeZone.max.y) / 2, z: (stage.escapeZone.min.z + stage.escapeZone.max.z) / 2 };
        const to = sectorIndexAt(stage, zc);
        const path = bfsHops(stage.sectors.length, conns, from, to);
        minHops = { count: path ? path.length : 0, sectors: path ? path.map((i) => stage.sectors[i].id) : [] };
        addCheck(ctx, {
          name: 'shortcut.minHops',
          label: '区画を飛ばす近道がない(区画グラフの最少通過区画数)',
          pass: path !== null && path.length >= LIMITS_STAGE.ROUTE_SECTORS_MIN,
          value: path ? path.length : 'unreachable',
          threshold: `>= ${LIMITS_STAGE.ROUTE_SECTORS_MIN} sectors on the fewest-sector path in the real connection graph`,
          details: path ? `fewest-sector path: ${minHops.sectors.join(' -> ')}` : 'start sector cannot reach the escape sector in the real connection graph',
        });
        const undeclared = conns.filter((c) => c.portalId === null);
        addCheck(ctx, {
          name: 'shortcut.undeclaredOpenings',
          label: '宣言されていない開口(抜け道)がない',
          pass: undeclared.length === 0,
          value: undeclared.length,
          threshold: '0 real openings between sectors that are not declared portals',
          details: undeclared.length ? undeclared.map((c) => `${c.a}<->${c.b} at ${fv(c.center)}`).join('; ') : `${conns.length} real connections, all declared`,
        });
      });
      guard(ctx, 'topology', () => {
        const t = analyseTopology(ctx, conns);
        structures = t.structures;
        addCheck(ctx, {
          name: 'topology.branches',
          label: '分岐して再合流する構造(実際の自由空間から)',
          pass: structures.length >= LIMITS_STAGE.BRANCHES_MIN,
          value: structures.length,
          threshold: `>= ${LIMITS_STAGE.BRANCHES_MIN} independent cycles whose two routes are each >= ${LIMITS_STAGE.BRANCH_ROUTE_MIN_METERS} m`,
          details: `${t.cyclesFound} cycles${t.truncated ? '+' : ''} in the sector graph (${conns.length} connections); counted: ${structures.map((c) => `[${c.sectors.join('>')} perimeter ${fmt(c.perimeter, 0)} arcs ${fmt(c.arcs[0], 0)}/${fmt(c.arcs[1], 0)} apart ${fmt(c.separation[0] * 100, 0)}%/${fmt(c.separation[1] * 100, 0)}%]`).join(' ') || 'none'}${t.rejected.length ? `; rejected (arcs < 40 m or the two routes run side by side): ${t.rejected.map((c) => `[${c.sectors.join('>')} arcs ${fmt(c.arcs[0], 0)}/${fmt(c.arcs[1], 0)} apart ${fmt(c.separation[0] * 100, 0)}%/${fmt(c.separation[1] * 100, 0)}%]`).join(' ')}` : ''}`,
        });
        addCheck(ctx, {
          name: 'topology.loops',
          label: '環状経路(単純往復でない閉路)',
          pass: structures.length >= LIMITS_STAGE.LOOPS_MIN,
          value: structures.length,
          threshold: `>= ${LIMITS_STAGE.LOOPS_MIN} independent cycles (the same structure may count as branch and loop, SPEC §2.2)`,
          details: `${structures.length} independent qualifying cycles`,
        });
      });
      guard(ctx, 'declared', () => {
        declaredBranches = evalDeclaredBranches(ctx, conns);
        declaredLoops = evalDeclaredLoops(ctx, conns);
        const okB = declaredBranches.filter((b) => b.ok).length;
        const okL = declaredLoops.filter((l) => l.ok).length;
        addCheck(ctx, {
          name: 'topology.declaredBranches',
          label: '宣言された分岐(branches)の経路が通行可能・長さ一致',
          pass: okB >= LIMITS_STAGE.BRANCHES_MIN && okB === declaredBranches.length,
          value: `${okB}/${declaredBranches.length}`,
          threshold: `>= ${LIMITS_STAGE.BRANCHES_MIN} declared branches and every declared branch valid`,
          details: declaredBranches.map((b) => (b.ok ? `${b.id} ok` : `${b.id}: ${[...b.problems, ...b.routes.flatMap((r) => r.problems.map((p) => `${r.id}: ${p}`))].join('; ')}`)).join(' | ') || 'no declared branches',
        });
        addCheck(ctx, {
          name: 'topology.declaredLoops',
          label: '宣言された環状経路(loops)が通行可能・閉じている',
          pass: okL >= LIMITS_STAGE.LOOPS_MIN && okL === declaredLoops.length,
          value: `${okL}/${declaredLoops.length}`,
          threshold: `>= ${LIMITS_STAGE.LOOPS_MIN} declared loops and every declared loop valid`,
          details: declaredLoops.map((l) => (l.ok ? `${l.id} ok (${fmt(l.length)} m)` : `${l.id}: ${l.problems.join('; ')}`)).join(' | ') || 'no declared loops',
        });
      });
      guard(ctx, 'portals', () => checkPortalsAndBarriers(ctx, conns));
    }
  } else {
    addCheck(ctx, { name: 'route.grid', label: 'ボクセル格子の構築', pass: false, value: 'unavailable', threshold: 'grid available', details: ctx.gridNote });
  }
  guard(ctx, 'arenas', () => {
    const r = checkArenasAndCrossfire(ctx);
    arenas = r.arenas;
    combat = r.combat;
  });
  guard(ctx, 'start', () => checkStart(ctx));

  // ---- flight climbs (item 6)
  const runBot = options.runClimbBot !== false;
  guard(ctx, 'climbs', () => {
    climbs = runBot ? evaluateClimbs(ctx, route, options.loadouts ?? allLoadouts()) : evaluateClimbs(ctx, route, []);
    checkClimbs(ctx, climbs, runBot);
  });

  // ---- barrier states (item 4) and the optimistic route: these rebuild the grid state, so they run last
  if (gridReady) {
    guard(ctx, 'barrierStates', () => {
      const r = analyseBarrierStates(ctx, route);
      barrierStates = r.rows;
      const leaking = barrierStates.filter((row) => row.goalReachable);
      addCheck(ctx, {
        name: 'shortcut.barrierLeak',
        label: '閉じた隔壁を迂回できない(各隔壁が必須)',
        pass: leaking.length === 0 && stage.barriers.length > 0 && r.leakedAfter.length === 0,
        value: leaking.length + r.leakedAfter.length,
        threshold: 'for every barrier: closed (all others open) => the escape zone is unreachable; all closed => no sector after the first barrier is reachable',
        details:
          leaking.length || r.leakedAfter.length
            ? `${leaking.map((x) => `${x.label}: goal reachable via a ${fmt(x.confirmedLength ?? 0)} m sweep-verified route`).join('; ')}${r.leakedAfter.length ? `; sectors after the first barrier reachable with everything closed: ${r.leakedAfter.join(', ')}` : ''}`
            : `${barrierStates.length - 1} single-barrier states and the all-closed state seal the escape zone; all-closed reachable sectors: ${barrierStates[barrierStates.length - 1]?.reachableSectors.join(', ') || 'none'}`,
      });
    });
    if (options.relaxedRoute !== false && route.found) {
      guard(ctx, 'relaxedRoute', () => {
        const thin = { x: HALF_C.x - 0.4, y: HALF_C.y - 0.4, z: HALF_C.z - 0.4 };
        const run = computeRoute(ctx, thin);
        route.relaxedLength = run.found ? run.length : null;
        if (run.found && run.length < LIMITS_STAGE.ROUTE_MIN_METERS) ctx.warnings.push(`optimistic route (player 0.4 m thinner) is only ${fmt(run.length)} m < ${LIMITS_STAGE.ROUTE_MIN_METERS} m: the strict route may be lengthened by tight squeezes`);
      });
    }
  }

  const pass = ctx.checks.filter((c) => !c.advisory).every((c) => c.pass);
  return {
    stageName: stage.name,
    pass,
    checks: ctx.checks,
    route,
    connections: conns.map((c) => ({ id: c.id, a: c.a, b: c.b, center: c.center, samples: c.samples, portalId: c.portalId })),
    structures,
    declaredBranches,
    declaredLoops,
    climbs,
    arenas,
    combat,
    enemyRows,
    barrierStates,
    minSectorHops: minHops,
    layers,
    warnings: ctx.warnings,
    timingsMs: ctx.timings,
  };
}

/** internals exposed for the validator's own tests / debugging (not part of the stage API) */
export const _internals = { Grid, smoothPath, exactSearch, seedsFor, freeMove, sweepFree, boxEdgeSamples, makeWorld, collectBarrierBoxes, HALF_C, polylineLength };
export type { PathEnv };
