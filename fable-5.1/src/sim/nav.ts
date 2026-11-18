/**
 * 警備ロボット用の経路探索グリッド（ARCHITECTURE §3.8 NavGrid）。
 *
 * - 衝突ワールドの bounds() を cellSize で XZ 格子に区切り、床面高さ（floorLevels または自動検出）ごとに
 *   「エージェントの AABB がその位置に立てるか」（重なりなし かつ 直下に床あり）を判定して歩行可能セルを集める。
 * - 8 近傍 A*（斜めは両隣の直交セルが歩行可能なときのみ）。隣接セル間の線分（エージェント中央高さ）が
 *   遮蔽されていれば通れない（薄い壁・閉鎖中の隔壁の検出。隔壁は開放後に通れるようになる）。
 * - 歩行可能性の判定は隔壁・ゲート（tag が 'barrier:' / 'gate:'）を除いた静的ワールドで行う。
 *   辺の遮蔽は生成時に静的ワールドで判定してビットマスクに保存し、隔壁・ゲートの箱をまたぐ辺だけ
 *   探索時に実ワールドで再判定する（隔壁の開閉は再生成なしで反映され、A* の 1 展開は数回の配列参照で済む）。
 * - メモリは床面ごとの Set<歩行可能セル番号> と、セルごとの辺ビットマスク（Uint8Array × 2）。
 * - findPath / pathDistance は厳密（別の床面・到達不能なら null。共有判定に使う）。
 *   findPathToward は追跡用で、目標が別の床面・空中・歩行不能セル上でも移動側の床面へ XZ 投影して探索し、
 *   到達不能でも「探索した中で最も目標に近いセル」までの経路を返す（探索数に上限あり。長い停止を防ぐ）。
 *
 * Three.js / DOM に依存しない。
 */
import type { AABB, CollisionWorld, ColliderEntry, Vec3 } from '../types';
import { createCollisionWorld } from './collision';

export interface NavBuildOptions {
  cellSize: number;
  agentHalfExtents: Vec3;
  /** 床面高さの候補（省略時は自動検出） */
  floorLevels?: number[];
}

/** 自動検出で床とみなすコライダー上面の最小面積 [m²] */
const MIN_FLOOR_TOP_AREA = 4;
/** 上面高さをまとめる許容差 [m] */
const FLOOR_CLUSTER_EPS = 0.3;
/** 歩行可能判定でエージェント箱を床から浮かせる高さ [m] */
const HOVER = 0.05;
/** 直下の床を探す深さ [m] */
const PROBE_DEPTH = 0.3;
/** 点をどの床面に対応付けるかの高さ許容 [m] */
const LEVEL_TOLERANCE = 3.0;
/** 最寄りの歩行可能セルを探す範囲（セル数） */
const NEAREST_SEARCH_CELLS = 6;
/** 追跡目標を床面へ投影するときの探索範囲（セル数。広い台・デッキの中央に立つ目標の縁を見つけるため広め） */
const PROJECT_SEARCH_CELLS = 16;
/** findPathToward の A* 展開数上限（到達不能な目標で床面全体を走査しないための上限） */
const TOWARD_MAX_EXPANSIONS = 8000;
/** 経路の直線化で先読みする経由点数の上限 */
const SMOOTH_LOOKAHEAD = 40;
const SQRT2 = Math.SQRT2;

interface Level {
  y: number;
  /** 歩行可能セル（キー = ix * nz + iz） */
  walkable: Set<number>;
  /** セルごとの「静的に開いている辺」のビットマスク（bit k = NEIGHBOURS[k] 方向） */
  staticOpen: Uint8Array;
  /** セルごとの「隔壁・ゲートの箱をまたぐ辺」のビットマスク（探索時に実ワールドで再判定する） */
  dynamic: Uint8Array;
}

interface Cell {
  ix: number;
  iz: number;
}

/** 二分ヒープ（f 昇順） */
class MinHeap {
  private keys: number[] = [];
  private fs: number[] = [];

  get size(): number {
    return this.keys.length;
  }

  push(key: number, f: number): void {
    this.keys.push(key);
    this.fs.push(f);
    let i = this.keys.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.fs[p] <= this.fs[i]) break;
      this.swap(i, p);
      i = p;
    }
  }

  pop(): number {
    const top = this.keys[0];
    const lastKey = this.keys.pop() as number;
    const lastF = this.fs.pop() as number;
    if (this.keys.length > 0) {
      this.keys[0] = lastKey;
      this.fs[0] = lastF;
      let i = 0;
      const n = this.keys.length;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < n && this.fs[l] < this.fs[m]) m = l;
        if (r < n && this.fs[r] < this.fs[m]) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    const k = this.keys[a];
    this.keys[a] = this.keys[b];
    this.keys[b] = k;
    const f = this.fs[a];
    this.fs[a] = this.fs[b];
    this.fs[b] = f;
  }
}

const NEIGHBOURS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];
/** NEIGHBOURS[k] の逆方向の添字 */
const OPPOSITE: ReadonlyArray<number> = [1, 0, 3, 2, 7, 6, 5, 4];
/** 辺の判定を 1 回で済ませるための「前方」方向（逆方向は隣のセルへ写す） */
const FORWARD_DIRS: ReadonlyArray<number> = [0, 2, 4, 5];

/** 上面高さを許容差でまとめる（各グループの最大値を床面高さとする） */
function clusterLevels(ys: number[]): number[] {
  const sorted = ys.filter((y) => Number.isFinite(y)).sort((a, b) => a - b);
  const out: number[] = [];
  let groupStart: number | null = null;
  let groupMax = 0;
  for (const y of sorted) {
    if (groupStart === null || y - groupStart > FLOOR_CLUSTER_EPS) {
      if (groupStart !== null) out.push(groupMax);
      groupStart = y;
      groupMax = y;
    } else {
      groupMax = y;
    }
  }
  if (groupStart !== null) out.push(groupMax);
  return out;
}

function isBarrierTag(tag: string | undefined): boolean {
  return tag !== undefined && (tag.startsWith('barrier:') || tag.startsWith('gate:'));
}

export class NavGrid {
  readonly cellSize: number;
  readonly agentHalfExtents: Vec3;
  private readonly world: CollisionWorld;
  private readonly minX: number;
  private readonly minZ: number;
  private readonly nx: number;
  private readonly nz: number;
  private readonly levels: Level[];
  /** A* の作業領域（セル数分。stamp で探索ごとに初期化を省く。探索は同期的で再入しない） */
  private readonly scratchG: Float64Array;
  private readonly scratchCame: Int32Array;
  private readonly scratchState: Uint8Array;
  private readonly scratchStamp: Uint32Array;
  private searchStamp = 0;
  /** 直近の A* で閉じた（展開した）セル数（試験・診断用） */
  lastExpansions = 0;

  private constructor(world: CollisionWorld, cellSize: number, agentHalfExtents: Vec3, minX: number, minZ: number, nx: number, nz: number, levels: Level[]) {
    this.world = world;
    this.cellSize = cellSize;
    this.agentHalfExtents = [agentHalfExtents[0], agentHalfExtents[1], agentHalfExtents[2]];
    this.minX = minX;
    this.minZ = minZ;
    this.nx = nx;
    this.nz = nz;
    this.levels = levels;
    const n = nx * nz;
    this.scratchG = new Float64Array(n);
    this.scratchCame = new Int32Array(n);
    this.scratchState = new Uint8Array(n);
    this.scratchStamp = new Uint32Array(n);
  }

  static build(world: CollisionWorld, opts: NavBuildOptions): NavGrid {
    const cs = opts.cellSize > 0 && Number.isFinite(opts.cellSize) ? opts.cellSize : 2;
    const half = opts.agentHalfExtents;
    const bounds: AABB = world.bounds();
    const minX = bounds.min[0];
    const minZ = bounds.min[2];
    const nx = Math.max(1, Math.ceil((bounds.max[0] - minX) / cs));
    const nz = Math.max(1, Math.ceil((bounds.max[2] - minZ) / cs));
    const colliders = world.colliders();

    // 歩行可能性の判定は隔壁・ゲートを除いた静的ワールドで行う
    const staticWorld = createCollisionWorld();
    const barrierWorld = createCollisionWorld();
    const staticColliders: ColliderEntry[] = [];
    let barrierCount = 0;
    for (const c of colliders) {
      if (isBarrierTag(c.tag)) {
        barrierWorld.addCollider(c.box, c.tag);
        barrierCount++;
        continue;
      }
      staticWorld.addCollider(c.box, c.tag);
      staticColliders.push(c);
    }

    let levelYs: number[];
    if (opts.floorLevels && opts.floorLevels.length > 0) {
      levelYs = clusterLevels(opts.floorLevels);
    } else {
      const ys: number[] = [];
      for (const c of staticColliders) {
        const area = (c.box.max[0] - c.box.min[0]) * (c.box.max[2] - c.box.min[2]);
        if (area >= MIN_FLOOR_TOP_AREA) ys.push(c.box.max[1]);
      }
      levelYs = clusterLevels(ys);
    }

    const levels: Level[] = [];
    const probe: Vec3 = [0, -PROBE_DEPTH, 0];
    for (const y of levelYs) {
      const walkable = new Set<number>();
      const tested = new Set<number>();
      const centerY = y + half[1] + HOVER;
      const testCell = (ix: number, iz: number): void => {
        const key = ix * nz + iz;
        if (tested.has(key)) return;
        tested.add(key);
        const cx = minX + (ix + 0.5) * cs;
        const cz = minZ + (iz + 0.5) * cs;
        const center: Vec3 = [cx, centerY, cz];
        if (staticWorld.boxOverlaps(center, half)) return;
        const res = staticWorld.moveBox(center, half, probe);
        if (res.hitNegY) walkable.add(key);
      };
      // 上面がこの床面付近にあるコライダーの XZ 範囲だけを走査する（無ければ全域）
      const candidates = staticColliders.filter((c) => Math.abs(c.box.max[1] - y) <= FLOOR_CLUSTER_EPS + 1e-6);
      if (candidates.length === 0) {
        for (let ix = 0; ix < nx; ix++) for (let iz = 0; iz < nz; iz++) testCell(ix, iz);
      } else {
        for (const c of candidates) {
          const ix0 = Math.max(0, Math.floor((c.box.min[0] - minX) / cs) - 1);
          const ix1 = Math.min(nx - 1, Math.floor((c.box.max[0] - minX) / cs) + 1);
          const iz0 = Math.max(0, Math.floor((c.box.min[2] - minZ) / cs) - 1);
          const iz1 = Math.min(nz - 1, Math.floor((c.box.max[2] - minZ) / cs) + 1);
          for (let ix = ix0; ix <= ix1; ix++) for (let iz = iz0; iz <= iz1; iz++) testCell(ix, iz);
        }
      }
      // 辺の遮蔽（静的）と、隔壁・ゲートをまたぐ辺（動的）をビットマスクに保存する
      const staticOpen = new Uint8Array(nx * nz);
      const dynamic = new Uint8Array(nx * nz);
      const edgeY = centerY;
      for (const key of walkable) {
        const ix = Math.floor(key / nz);
        const iz = key % nz;
        const pa: Vec3 = [minX + (ix + 0.5) * cs, edgeY, minZ + (iz + 0.5) * cs];
        for (const k of FORWARD_DIRS) {
          const nix = ix + NEIGHBOURS[k][0];
          const niz = iz + NEIGHBOURS[k][1];
          if (nix < 0 || niz < 0 || nix >= nx || niz >= nz) continue;
          const nkey = nix * nz + niz;
          if (!walkable.has(nkey)) continue;
          const pb: Vec3 = [minX + (nix + 0.5) * cs, edgeY, minZ + (niz + 0.5) * cs];
          if (staticWorld.segmentBlocked(pa, pb)) continue;
          staticOpen[key] |= 1 << k;
          staticOpen[nkey] |= 1 << OPPOSITE[k];
          if (barrierCount > 0 && barrierWorld.segmentBlocked(pa, pb)) {
            dynamic[key] |= 1 << k;
            dynamic[nkey] |= 1 << OPPOSITE[k];
          }
        }
      }
      levels.push({ y, walkable, staticOpen, dynamic });
    }
    return new NavGrid(world, cs, half, minX, minZ, nx, nz, levels);
  }

  /** 床面の高さ一覧（試験・診断用） */
  floorLevels(): number[] {
    return this.levels.map((l) => l.y);
  }

  /** 歩行可能セル数（試験・診断用） */
  walkableCount(): number {
    let n = 0;
    for (const l of this.levels) n += l.walkable.size;
    return n;
  }

  /**
   * from → to の足元経由点列（セル中心、床面高さ）。到達不能・別の床面・格子外なら null。
   */
  findPath(from: Vec3, to: Vec3): Vec3[] | null {
    const lf = this.levelFor(from);
    const lt = this.levelFor(to);
    if (lf === null || lt === null || lf !== lt) return null;
    const level = this.levels[lf];
    const a = this.nearestCell(level, from);
    const b = this.nearestCell(level, to);
    if (!a || !b) return null;
    const res = this.astar(level, a, b, Infinity, Infinity, false);
    if (!res) return null;
    const cells = this.smooth(level, res.cells);
    return cells.map((c) => this.cellCenter(level, c));
  }

  /**
   * from から to へ向かう追跡用の経路。to が別の床面・空中・歩行不能セル上でも、from の床面へ XZ 投影した
   * 最寄りの歩行可能セル（PROJECT_SEARCH_CELLS 以内）を目標にする。到達不能または探索上限に達した場合は、
   * 探索した中で目標に最も近いセルまでの経路を reached=false で返す。from が格子に対応付けられない、
   * または投影先が見つからない場合のみ null。
   */
  findPathToward(from: Vec3, to: Vec3): { path: Vec3[]; reached: boolean } | null {
    const lf = this.levelFor(from);
    if (lf === null) return null;
    const level = this.levels[lf];
    const a = this.nearestCell(level, from);
    const b = this.nearestCell(level, to, PROJECT_SEARCH_CELLS);
    if (!a || !b) return null;
    const res = this.astar(level, a, b, Infinity, TOWARD_MAX_EXPANSIONS, true);
    if (!res) return null;
    const cells = this.smooth(level, res.cells);
    return { path: cells.map((c) => this.cellCenter(level, c)), reached: res.reached };
  }

  /** 経路長 [m]（from→最初のセル、セル間、最後のセル→to を含む）。maxDistance を超えるか到達不能なら null */
  pathDistance(from: Vec3, to: Vec3, maxDistance: number): number | null {
    if (!(maxDistance >= 0)) return null;
    const straight = Math.hypot(to[0] - from[0], to[2] - from[2]);
    if (straight > maxDistance) return null;
    const lf = this.levelFor(from);
    const lt = this.levelFor(to);
    if (lf === null || lt === null || lf !== lt) return null;
    const level = this.levels[lf];
    const a = this.nearestCell(level, from);
    const b = this.nearestCell(level, to);
    if (!a || !b) return null;
    const ca = this.cellCenter(level, a);
    const cb = this.cellCenter(level, b);
    const head = Math.hypot(ca[0] - from[0], ca[2] - from[2]);
    const tail = Math.hypot(cb[0] - to[0], cb[2] - to[2]);
    const res = this.astar(level, a, b, Math.max(0, maxDistance - head - tail), Infinity, false);
    if (!res) return null;
    const total = head + res.cost + tail;
    return total <= maxDistance + 1e-9 ? total : null;
  }

  /** 最寄りの歩行可能セル中心（床面高さ）。無ければ null */
  nearest(pos: Vec3): Vec3 | null {
    const li = this.levelFor(pos);
    if (li === null) return null;
    const level = this.levels[li];
    const c = this.nearestCell(level, pos);
    return c ? this.cellCenter(level, c) : null;
  }

  // -------------------------------------------------------------------------

  private levelFor(p: Vec3): number | null {
    let best: number | null = null;
    let bestDy = Infinity;
    for (let i = 0; i < this.levels.length; i++) {
      const dy = Math.abs(p[1] - this.levels[i].y);
      if (dy < bestDy) {
        bestDy = dy;
        best = i;
      }
    }
    return best !== null && bestDy <= LEVEL_TOLERANCE ? best : null;
  }

  private cellCenter(level: Level, c: Cell): Vec3 {
    return [this.minX + (c.ix + 0.5) * this.cellSize, level.y, this.minZ + (c.iz + 0.5) * this.cellSize];
  }

  private key(ix: number, iz: number): number {
    return ix * this.nz + iz;
  }

  private walkableAt(level: Level, ix: number, iz: number): boolean {
    if (ix < 0 || iz < 0 || ix >= this.nx || iz >= this.nz) return false;
    return level.walkable.has(this.key(ix, iz));
  }

  /** 位置に最も近い歩行可能セル（周囲 maxCells セルまで探索） */
  private nearestCell(level: Level, p: Vec3, maxCells: number = NEAREST_SEARCH_CELLS): Cell | null {
    const fx = (p[0] - this.minX) / this.cellSize;
    const fz = (p[2] - this.minZ) / this.cellSize;
    const ix0 = Math.floor(fx);
    const iz0 = Math.floor(fz);
    let best: Cell | null = null;
    let bestD = Infinity;
    for (let r = 0; r <= maxCells; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const ix = ix0 + dx;
          const iz = iz0 + dz;
          if (!this.walkableAt(level, ix, iz)) continue;
          const d = Math.hypot(ix + 0.5 - fx, iz + 0.5 - fz);
          if (d < bestD) {
            bestD = d;
            best = { ix, iz };
          }
        }
      }
      // 環 r で見つかった最良は、環 r+1 以降の候補より近い可能性が高いが確実ではないため、1 環だけ余分に見る
      if (best && r >= Math.ceil(bestD)) break;
    }
    return best;
  }

  /**
   * セル (ix,iz) から NEIGHBOURS[k] 方向の辺が通れるか。静的な遮蔽は生成時のビットマスク、
   * 隔壁・ゲートをまたぐ辺だけ実ワールドの線分判定（エージェント中央高さ）で再確認する。
   */
  private edgeOpen(level: Level, ix: number, iz: number, k: number): boolean {
    const key = this.key(ix, iz);
    const bit = 1 << k;
    if ((level.staticOpen[key] & bit) === 0) return false;
    if ((level.dynamic[key] & bit) === 0) return true;
    const y = level.y + this.agentHalfExtents[1] + HOVER;
    const pa: Vec3 = [this.minX + (ix + 0.5) * this.cellSize, y, this.minZ + (iz + 0.5) * this.cellSize];
    const pb: Vec3 = [this.minX + (ix + NEIGHBOURS[k][0] + 0.5) * this.cellSize, y, this.minZ + (iz + NEIGHBOURS[k][1] + 0.5) * this.cellSize];
    return !this.world.segmentBlocked(pa, pb);
  }

  /**
   * 8 近傍 A*。maxCost を超える経路は探索しない。maxExpansions（閉じたセル数）に達するか到達不能なら、
   * allowPartial のとき「探索した中で目標に最も近い（h 最小、同点なら g 最小）セル」までの経路を reached=false で返し、
   * そうでなければ null。
   */
  private astar(level: Level, start: Cell, goal: Cell, maxCost: number, maxExpansions: number, allowPartial: boolean): { cost: number; cells: Cell[]; reached: boolean } | null {
    const cs = this.cellSize;
    const startKey = this.key(start.ix, start.iz);
    const goalKey = this.key(goal.ix, goal.iz);
    this.lastExpansions = 0;
    if (startKey === goalKey) return { cost: 0, cells: [start], reached: true };
    const h = (ix: number, iz: number): number => {
      const dx = Math.abs(ix - goal.ix);
      const dz = Math.abs(iz - goal.iz);
      return cs * (Math.max(dx, dz) + (SQRT2 - 1) * Math.min(dx, dz));
    };
    // 作業領域: stamp が一致するセルだけ有効（state 0=未訪問, 1=開, 2=閉）
    const stamp = ++this.searchStamp;
    const G = this.scratchG;
    const came = this.scratchCame;
    const state = this.scratchState;
    const stamps = this.scratchStamp;
    const touch = (k: number): void => {
      if (stamps[k] !== stamp) {
        stamps[k] = stamp;
        state[k] = 0;
        G[k] = Infinity;
        came[k] = -1;
      }
    };
    const open = new MinHeap();
    touch(startKey);
    G[startKey] = 0;
    state[startKey] = 1;
    open.push(startKey, h(start.ix, start.iz));
    const nz = this.nz;
    const buildCells = (endKey: number): Cell[] => {
      const cells: Cell[] = [];
      let k = endKey;
      while (k >= 0) {
        cells.push({ ix: Math.floor(k / nz), iz: k % nz });
        k = came[k];
      }
      cells.reverse();
      return cells;
    };
    let bestKey = startKey;
    let bestH = h(start.ix, start.iz);
    let bestG = 0;
    let expanded = 0;
    while (open.size > 0) {
      const cur = open.pop();
      if (state[cur] === 2) continue;
      state[cur] = 2;
      const gc = G[cur];
      if (cur === goalKey) {
        this.lastExpansions = expanded;
        return { cost: gc, cells: buildCells(cur), reached: true };
      }
      const ix = Math.floor(cur / nz);
      const iz = cur % nz;
      if (allowPartial) {
        const hc = h(ix, iz);
        if (hc < bestH - 1e-9 || (Math.abs(hc - bestH) <= 1e-9 && gc < bestG)) {
          bestH = hc;
          bestG = gc;
          bestKey = cur;
        }
      }
      if (++expanded > maxExpansions) break;
      for (let k = 0; k < 8; k++) {
        const dx = NEIGHBOURS[k][0];
        const dz = NEIGHBOURS[k][1];
        const nix = ix + dx;
        const niz = iz + dz;
        if (!this.walkableAt(level, nix, niz)) continue;
        const diagonal = dx !== 0 && dz !== 0;
        if (diagonal && !(this.walkableAt(level, ix + dx, iz) && this.walkableAt(level, ix, iz + dz))) continue;
        const nk = nix * nz + niz;
        touch(nk);
        if (state[nk] === 2) continue;
        const ng = gc + (diagonal ? cs * SQRT2 : cs);
        if (ng > maxCost) continue;
        if (G[nk] <= ng) continue;
        if (!this.edgeOpen(level, ix, iz, k)) continue;
        G[nk] = ng;
        came[nk] = cur;
        state[nk] = 1;
        open.push(nk, ng + h(nix, niz));
      }
    }
    this.lastExpansions = expanded;
    if (!allowPartial) return null;
    return { cost: bestG, cells: buildCells(bestKey), reached: false };
  }

  /**
   * 2 セル中心間の直線が歩行可能な帯（幅 1 セル）を通り、かつ遮蔽されていないか。
   * 経路の直線化（不要な経由点の除去）に使う保守的な判定。
   */
  private lineWalkable(level: Level, a: Cell, b: Cell): boolean {
    const cs = this.cellSize;
    const ax = a.ix + 0.5;
    const az = a.iz + 0.5;
    const bx = b.ix + 0.5;
    const bz = b.iz + 0.5;
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < 1e-9) return true;
    const ux = dx / len;
    const uz = dz / len;
    // 法線方向（セル座標系で ±0.5 セル）
    const nxo = -uz * 0.5;
    const nzo = ux * 0.5;
    const steps = Math.max(1, Math.ceil(len * 2));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const px = ax + dx * t;
      const pz = az + dz * t;
      if (!this.walkableAt(level, Math.floor(px), Math.floor(pz))) return false;
      if (!this.walkableAt(level, Math.floor(px + nxo), Math.floor(pz + nzo))) return false;
      if (!this.walkableAt(level, Math.floor(px - nxo), Math.floor(pz - nzo))) return false;
    }
    const y = level.y + this.agentHalfExtents[1] + HOVER;
    const pa: Vec3 = [this.minX + ax * cs, y, this.minZ + az * cs];
    const pb: Vec3 = [this.minX + bx * cs, y, this.minZ + bz * cs];
    return !this.world.segmentBlocked(pa, pb);
  }

  /** 直線で結べる経由点を飛ばして経路を短くする */
  private smooth(level: Level, cells: Cell[]): Cell[] {
    if (cells.length <= 2) return cells;
    const out: Cell[] = [cells[0]];
    let i = 0;
    while (i < cells.length - 1) {
      let best = i + 1;
      const limit = Math.min(cells.length - 1, i + SMOOTH_LOOKAHEAD);
      for (let j = limit; j > i + 1; j--) {
        if (this.lineWalkable(level, cells[i], cells[j])) {
          best = j;
          break;
        }
      }
      out.push(cells[best]);
      i = best;
    }
    return out;
  }
}
