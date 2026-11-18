/**
 * ステージ検証ツール（仕様 §2.2 の規模要件を実際に計算して証明する）。
 *
 * 手法:
 * 1. solids + 全隔壁 + ゲートから CollisionWorld を構築する。
 * 2. 全体を 2 m のボクセルに分割し、「セル中心にプレイヤー AABB（底面をセル下面に合わせる）を置いて
 *    どのコライダーとも重ならない」セルを自由セルとする。26 近傍グラフ、辺の重みはユークリッド距離。
 *    重力も EN も速度も無視した「自由飛行」の格子最短経路であり、実際の移動より緩い制約で求める。
 *    ただし格子経路はセル中心を経由する分だけ連続空間の最短より長くなる（26 近傍で最大 ≈11 %）ので、
 *    格子経路をプレイヤー AABB の掃引衝突で紐張り（string pulling）した長さを最終値 shortestPathMeters とし、
 *    格子の値は gridPathMeters として併記する。紐張り後の値は格子経路と同じ経路類の連続最短の推定値であり、
 *    厳密な大域下限ではない（格子で見つからない別経路類は 2 m 格子の解像度で除外されている）。
 * 3. 進行段階 k=0..6 でダイクストラ: 段階 k では barriers[0..k-1] を開き、現在の始点集合（開始セル、または
 *    前段階の制御砲台の射撃可能セル集合とその累積距離）から、次の制御砲台の射撃可能セル集合（砲台中心から
 *    VERIFY_THRESHOLDS.firingRangeM 以内で射線が通る自由セル。射程はロック射程・ビーム射程・MG/ミサイルの
 *    直線到達上限の最大 = 自由射撃の MG 弾（100 m/s × 2 s ＋ 重力落下分）を含む）への最短距離を求める。
 *    6 段階の後、ゲートを開けて脱出領域へ。
 * 4. 歩行のみ（床の支えがあり 1 ホップの上昇が 2 m 以下）の到達判定で、飛行必須箇所が本当に必要であることを示す。
 * 5. 飛行必須箇所、区画、分岐、環状、アリーナ、交差射線（各敵の独立射線＋同時射線位置）、敵配置（隔壁閉の
 *    初期状態で判定）、開始地点の遮蔽、通行空間にある衝突なしの大型装飾を検査する。
 */
import { ENEMIES, FCS, GENERATORS, PLAYER, WEAPONS } from '../params';
import { createCollisionWorld } from '../sim/collision';
import { add, distance, distanceXZ, rotateY } from '../sim/vec';
import type { AABB, CollisionWorld, DecorDef, EnemyDef, MaterialKey, SectorDef, StageData, Vec3 } from '../types';

export interface FlightPointReport {
  id: string;
  sectorId: string;
  ok: boolean;
  heightDiff: number;
  horizontalGap: number;
  /** 必要推進時間 [s] = max(h/8, gap/12.8) */
  thrustSeconds: number;
  /** 必要 EN = 20 × thrustSeconds */
  enRequired: number;
  /** 許容 EN = 最小の最大EN / 1.25 */
  enBudget: number;
  fromSupported: boolean;
  toSupported: boolean;
  walkOnlyReachable: boolean;
  fromDistToPath: number;
  toDistToPath: number;
  errors: string[];
}

export interface StageReport {
  ok: boolean;
  errors: string[];
  warnings: string[];
  metrics: {
    sectorCount: number;
    kinds: string[];
    kindCount: number;
    /** 自由飛行の最短距離 [m]（開始 → 6 砲台の射撃位置 → 脱出領域）。格子経路を紐張りした連続推定値 */
    shortestPathMeters: number;
    /** 各段階の距離 [m]（T1 まで、T1→T2、…、T6→脱出）。紐張り後 */
    legMeters: number[];
    /** 2 m 格子（26 近傍）上の最短経路長 [m]。紐張り前の値で、shortestPathMeters 以上 */
    gridPathMeters: number;
    gridLegMeters: number[];
    /** 紐張り後の経路（足元位置） */
    pulledPath: Vec3[];
    /** 射撃可能セルの判定半径 [m] */
    firingRangeM: number;
    routeSectors: string[];
    pathSectorCount: number;
    branchCount: number;
    loopCount: number;
    flightPoints: FlightPointReport[];
    flightPointCount: number;
    /** 高度帯の数（floorLevels を 3 m を超える隙間で分けた帯） */
    layerCount: number;
    layerHeights: number[];
    /** 経路が実際に立つ床（床材質のソリッド上面）の高さ [m] と、その上の経路セル数 */
    floorLevels: number[];
    floorLevelCells: Record<string, number>;
    arenaCount: number;
    arenaSizes: Record<string, [number, number]>;
    crossfireCount: number;
    crossfireDetails: Record<string, string[]>;
    /** 区画ごとに、1 つの位置へ同時に射線を持つ敵数の最大 */
    crossfireSimultaneous: Record<string, number>;
    enemies: { total: number; guards: number; turrets: number; controls: number };
    /** 通行空間に入る衝突なしの大型装飾の数（0 でなければエラー） */
    decorInWalkableSpace: number;
    walkOnlyExitReachable: boolean;
    walkOnlyReachableCells: number;
    walkOnlyReachesFirstControl: boolean;
    startHasLos: boolean;
    nearestEnemyToStart: number;
    firingCellsOutsideSector: Record<string, number>;
    firingCellCounts: Record<string, number>;
    gridCells: number;
    freeCells: number;
    reachableCells: number;
    solidCount: number;
    /** 経路セル（間引き）: [x, y(底面), z] */
    pathSample: Vec3[];
    pathCellCount: number;
    elapsedMs: number;
  };
}

const CELL = 2;
const NEIGH_COUNT = 26;

// ---------------------------------------------------------------------------
// 二分ヒープ（遅延削除）
// ---------------------------------------------------------------------------
class MinHeap {
  private keys = new Float64Array(1 << 16);
  private vals = new Int32Array(1 << 16);
  size = 0;

  push(key: number, val: number): void {
    if (this.size === this.keys.length) {
      const nk = new Float64Array(this.keys.length * 2);
      nk.set(this.keys);
      this.keys = nk;
      const nv = new Int32Array(this.vals.length * 2);
      nv.set(this.vals);
      this.vals = nv;
    }
    let i = this.size++;
    const keys = this.keys;
    const vals = this.vals;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      keys[i] = keys[p];
      vals[i] = vals[p];
      i = p;
    }
    keys[i] = key;
    vals[i] = val;
  }

  /** 最小要素を取り出す。戻り値は値、キーは lastKey に入る */
  lastKey = 0;
  pop(): number {
    const keys = this.keys;
    const vals = this.vals;
    const top = vals[0];
    this.lastKey = keys[0];
    const n = --this.size;
    if (n > 0) {
      const key = keys[n];
      const val = vals[n];
      let i = 0;
      for (;;) {
        let c = i * 2 + 1;
        if (c >= n) break;
        if (c + 1 < n && keys[c + 1] < keys[c]) c++;
        if (keys[c] >= key) break;
        keys[i] = keys[c];
        vals[i] = vals[c];
        i = c;
      }
      keys[i] = key;
      vals[i] = val;
    }
    return top;
  }

  clear(): void {
    this.size = 0;
  }
}

// ---------------------------------------------------------------------------
// ボクセル格子
// ---------------------------------------------------------------------------
class Grid {
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly n: number;
  readonly x0: number;
  readonly y0: number;
  readonly z0: number;
  /** 26 近傍のインデックス差分・コスト・dy（セル単位） */
  readonly offs = new Int32Array(NEIGH_COUNT);
  readonly costs = new Float64Array(NEIGH_COUNT);
  readonly dys = new Int8Array(NEIGH_COUNT);

  constructor(bounds: AABB, margin: number) {
    this.x0 = Math.floor((bounds.min[0] - margin) / CELL) * CELL;
    this.y0 = Math.floor((bounds.min[1] - margin) / CELL) * CELL;
    this.z0 = Math.floor((bounds.min[2] - margin) / CELL) * CELL;
    this.nx = Math.ceil((bounds.max[0] + margin - this.x0) / CELL) + 1;
    this.ny = Math.ceil((bounds.max[1] + margin - this.y0) / CELL) + 1;
    this.nz = Math.ceil((bounds.max[2] + margin - this.z0) / CELL) + 1;
    this.n = this.nx * this.ny * this.nz;
    let m = 0;
    for (let dj = -1; dj <= 1; dj++)
      for (let dk = -1; dk <= 1; dk++)
        for (let di = -1; di <= 1; di++) {
          if (di === 0 && dj === 0 && dk === 0) continue;
          this.offs[m] = di + this.nx * (dk + this.nz * dj);
          this.costs[m] = CELL * Math.sqrt(di * di + dj * dj + dk * dk);
          this.dys[m] = dj;
          m++;
        }
  }

  idx(i: number, j: number, k: number): number {
    return i + this.nx * (k + this.nz * j);
  }
  i(idx: number): number {
    return idx % this.nx;
  }
  k(idx: number): number {
    return Math.floor(idx / this.nx) % this.nz;
  }
  j(idx: number): number {
    return Math.floor(idx / (this.nx * this.nz));
  }
  /** セル中心（y はセル下面 + 1） */
  center(idx: number): Vec3 {
    return [this.x0 + this.i(idx) * CELL + CELL / 2, this.y0 + this.j(idx) * CELL + CELL / 2, this.z0 + this.k(idx) * CELL + CELL / 2];
  }
  /** セル下面の y */
  bottom(idx: number): number {
    return this.y0 + this.j(idx) * CELL;
  }
  /** 足元位置 p（y は床上面）を含むセル。y はセル下面 ≤ y < 下面+2 */
  cellOfFoot(p: Vec3): number {
    const i = Math.floor((p[0] - this.x0) / CELL);
    const j = Math.floor((p[1] - this.y0) / CELL + 1e-6);
    const k = Math.floor((p[2] - this.z0) / CELL);
    if (i < 0 || j < 0 || k < 0 || i >= this.nx || j >= this.ny || k >= this.nz) return -1;
    return this.idx(i, j, k);
  }
  inside(idx: number): boolean {
    return idx >= 0 && idx < this.n;
  }
}

interface Occupancy {
  /** 1 = プレイヤーが入れない */
  blocked: Uint8Array;
  /** 1 = 足元 2 m 以内に床の上面がある（立てる） */
  support: Uint8Array;
}

/** コライダー box をプレイヤー AABB で膨らませて格子に描く */
function rasterizeBlocked(g: Grid, box: AABB, out: Uint8Array): void {
  const hx = PLAYER.halfExtents[0];
  const hz = PLAYER.halfExtents[2];
  const h = PLAYER.halfExtents[1] * 2;
  const i0 = Math.max(0, Math.ceil((box.min[0] - hx - g.x0 - CELL / 2) / CELL + 1e-9));
  const i1 = Math.min(g.nx - 1, Math.floor((box.max[0] + hx - g.x0 - CELL / 2) / CELL - 1e-9));
  const k0 = Math.max(0, Math.ceil((box.min[2] - hz - g.z0 - CELL / 2) / CELL + 1e-9));
  const k1 = Math.min(g.nz - 1, Math.floor((box.max[2] + hz - g.z0 - CELL / 2) / CELL - 1e-9));
  const j0 = Math.max(0, Math.floor((box.min[1] - h - g.y0) / CELL + 1e-9) + 1);
  const j1 = Math.min(g.ny - 1, Math.ceil((box.max[1] - g.y0) / CELL - 1e-9) - 1);
  for (let j = j0; j <= j1; j++)
    for (let k = k0; k <= k1; k++) {
      const base = g.nx * (k + g.nz * j);
      for (let i = i0; i <= i1; i++) out[base + i] = 1;
    }
}

/** コライダーの上面が「セル下面の 0〜2 m 下」にあるセルを支え付きとして描く */
function rasterizeSupport(g: Grid, box: AABB, out: Uint8Array): void {
  const hx = PLAYER.halfExtents[0];
  const hz = PLAYER.halfExtents[2];
  const i0 = Math.max(0, Math.ceil((box.min[0] - hx - g.x0 - CELL / 2) / CELL + 1e-9));
  const i1 = Math.min(g.nx - 1, Math.floor((box.max[0] + hx - g.x0 - CELL / 2) / CELL - 1e-9));
  const k0 = Math.max(0, Math.ceil((box.min[2] - hz - g.z0 - CELL / 2) / CELL + 1e-9));
  const k1 = Math.min(g.nz - 1, Math.floor((box.max[2] + hz - g.z0 - CELL / 2) / CELL - 1e-9));
  const top = box.max[1];
  const j0 = Math.max(0, Math.ceil((top - g.y0) / CELL - 1e-9));
  const j1 = Math.min(g.ny - 1, Math.ceil((top + CELL - g.y0) / CELL - 1e-9) - 1);
  for (let j = j0; j <= j1; j++)
    for (let k = k0; k <= k1; k++) {
      const base = g.nx * (k + g.nz * j);
      for (let i = i0; i <= i1; i++) out[base + i] = 1;
    }
}

function cellsOfBox(g: Grid, box: AABB): Int32Array {
  const tmp = new Uint8Array(g.n);
  rasterizeBlocked(g, box, tmp);
  let c = 0;
  for (let i = 0; i < g.n; i++) if (tmp[i]) c++;
  const out = new Int32Array(c);
  c = 0;
  for (let i = 0; i < g.n; i++) if (tmp[i]) out[c++] = i;
  return out;
}

function markBoundary(g: Grid, blocked: Uint8Array): void {
  for (let j = 0; j < g.ny; j++)
    for (let k = 0; k < g.nz; k++)
      for (let i = 0; i < g.nx; i++) {
        if (i === 0 || j === 0 || k === 0 || i === g.nx - 1 || j === g.ny - 1 || k === g.nz - 1) blocked[g.idx(i, j, k)] = 1;
      }
}

interface DijkstraOptions {
  walkOnly?: boolean;
  /** 1 のセルだけ通れる */
  allowed?: Uint8Array | null;
  /** このセルに到達したら打ち切る（早期終了） */
  stopAt?: Uint8Array | null;
}

interface DijkstraResult {
  dist: Float64Array;
  pred: Int32Array;
  /** stopAt で止まった先のセル（なければ -1） */
  reached: number;
}

function dijkstra(g: Grid, blocked: Uint8Array, support: Uint8Array, sources: { idx: number; dist: number }[], opts: DijkstraOptions = {}): DijkstraResult {
  const n = g.n;
  const dist = new Float64Array(n).fill(Infinity);
  const pred = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  const heap = new MinHeap();
  const walkOnly = opts.walkOnly === true;
  const allowed = opts.allowed ?? null;
  const stopAt = opts.stopAt ?? null;
  for (const s of sources) {
    if (s.idx < 0 || blocked[s.idx]) continue;
    if (allowed && !allowed[s.idx]) continue;
    if (s.dist < dist[s.idx]) {
      dist[s.idx] = s.dist;
      heap.push(s.dist, s.idx);
    }
  }
  const offs = g.offs;
  const costs = g.costs;
  const dys = g.dys;
  let reached = -1;
  while (heap.size > 0) {
    const cur = heap.pop();
    const d = heap.lastKey;
    if (done[cur]) continue;
    done[cur] = 1;
    if (stopAt && stopAt[cur]) {
      reached = cur;
      break;
    }
    const curSupported = support[cur] === 1;
    for (let m = 0; m < NEIGH_COUNT; m++) {
      const nb = cur + offs[m];
      if (blocked[nb] || done[nb]) continue;
      if (allowed && !allowed[nb]) continue;
      if (walkOnly) {
        const dy = dys[m];
        // 支えのあるセルからは 1 段（2 m）の上昇まで、空中のセルからは水平移動と落下のみ
        if (curSupported) {
          if (dy > 1) continue;
        } else if (dy > 0) continue;
      }
      const nd = d + costs[m];
      if (nd < dist[nb]) {
        dist[nb] = nd;
        pred[nb] = cur;
        heap.push(nd, nb);
      }
    }
  }
  return { dist, pred, reached };
}

function backtrack(pred: Int32Array, end: number): number[] {
  const path: number[] = [];
  let c = end;
  let guard = 0;
  while (c >= 0 && guard++ < 10_000_000) {
    path.push(c);
    c = pred[c];
  }
  path.reverse();
  return path;
}

function pointInAABB(p: Vec3, b: AABB): boolean {
  return p[0] >= b.min[0] && p[0] <= b.max[0] && p[1] >= b.min[1] && p[1] <= b.max[1] && p[2] >= b.min[2] && p[2] <= b.max[2];
}

function enemyCenter(e: EnemyDef): Vec3 {
  const off = e.kind === 'guard' ? ENEMIES.guard.centerOffset : e.kind === 'turret' ? ENEMIES.turret.centerOffset : ENEMIES.target.centerOffset;
  return add(e.position, off);
}

function enemyMuzzle(e: EnemyDef): Vec3 {
  if (e.kind === 'guard') return add(e.position, rotateY(ENEMIES.guard.muzzleOffset, e.yaw));
  return add(e.position, ENEMIES.turret.gunPivotOffset);
}

function enemyHalfExtents(e: EnemyDef): Vec3 {
  return e.kind === 'guard' ? ENEMIES.guard.halfExtents : ENEMIES.turret.halfExtents;
}

/** 最大長方形（ヒストグラム法）。grid[w*h]、戻り値は [幅セル, 高さセル] */
function maxRectangle(grid: Uint8Array, w: number, h: number): [number, number] {
  const heights = new Int32Array(w);
  let best: [number, number] = [0, 0];
  let bestArea = 0;
  const stack: number[] = [];
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) heights[c] = grid[r * w + c] ? heights[c] + 1 : 0;
    stack.length = 0;
    for (let c = 0; c <= w; c++) {
      const hh = c < w ? heights[c] : 0;
      while (stack.length > 0 && heights[stack[stack.length - 1]] >= hh) {
        const top = stack.pop() as number;
        const height = heights[top];
        const width = stack.length === 0 ? c : c - stack[stack.length - 1] - 1;
        const area = width * height;
        if (area > bestArea) {
          bestArea = area;
          best = [width, height];
        }
      }
      stack.push(c);
    }
  }
  return best;
}

/** 幅 w、奥行 d のセル格子で「短辺 ≥ minShort、長辺 ≥ minLong」を満たす最大長方形があるか（両向き） */
function fitsRectangle(grid: Uint8Array, w: number, h: number, longM: number, shortM: number): { ok: boolean; size: [number, number] } {
  // 最大面積長方形だけでは「60×50」を満たす別の長方形を見落とすので、短辺条件付きの探索を行う
  const needLong = Math.ceil(longM / CELL);
  const needShort = Math.ceil(shortM / CELL);
  // 条件を満たす長方形のうち最大面積のものを記録する。満たすものがなければ条件に最も近いもの（記録用）
  const heights = new Int32Array(w);
  let bestSize: [number, number] = [0, 0];
  let bestScore = 0;
  let okSize: [number, number] = [0, 0];
  let okArea = 0;
  let ok = false;
  const stack: number[] = [];
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) heights[c] = grid[r * w + c] ? heights[c] + 1 : 0;
    stack.length = 0;
    for (let c = 0; c <= w; c++) {
      const hh = c < w ? heights[c] : 0;
      while (stack.length > 0 && heights[stack[stack.length - 1]] >= hh) {
        const top = stack.pop() as number;
        const height = heights[top];
        const width = stack.length === 0 ? c : c - stack[stack.length - 1] - 1;
        const long = Math.max(width, height);
        const short = Math.min(width, height);
        if (long >= needLong && short >= needShort) {
          ok = true;
          if (width * height > okArea) {
            okArea = width * height;
            okSize = [width, height];
          }
        }
        const score = Math.min(long / needLong, short / needShort);
        if (score > bestScore) {
          bestScore = score;
          bestSize = [width, height];
        }
      }
      stack.push(c);
    }
  }
  return { ok, size: ok ? okSize : bestSize };
}

// ---------------------------------------------------------------------------
// 紐張り（格子経路 → 連続経路の推定）
// ---------------------------------------------------------------------------
const PULL_STEP = 0.2;

function feetOfCell(g: Grid, idx: number): Vec3 {
  const c = g.center(idx);
  return [c[0], g.bottom(idx), c[2]];
}

/** 足元位置 a→b へプレイヤー AABB を PULL_STEP 刻みで掃引し、どこでもコライダーと重ならなければ true */
function sweepClear(w: CollisionWorld, a: Vec3, b: Vec3): boolean {
  const n = Math.max(1, Math.ceil(distance(a, b) / PULL_STEP));
  const off = PLAYER.hitCenterOffset;
  const half = PLAYER.halfExtents;
  for (let s = 0; s <= n; s++) {
    const t = s / n;
    const c: Vec3 = [a[0] + (b[0] - a[0]) * t + off[0], a[1] + (b[1] - a[1]) * t + off[1], a[2] + (b[2] - a[2]) * t + off[2]];
    if (w.boxOverlaps(c, half)) return false;
  }
  return true;
}

/**
 * 貪欲な紐張り: 点 i から、掃引が衝突しない限り先の点へ直線で飛ばす。隣接点への掃引が衝突する場合
 * （格子の 26 近傍が角をかすめる場合）は格子どおり隣接点へ進むので、結果の長さは常に元の折れ線以下。
 * 端点は固定（射撃可能セル・開始セル・脱出セル）。
 */
function pullPath(points: Vec3[], w: CollisionWorld, passes = 3): Vec3[] {
  let pts = points;
  for (let p = 0; p < passes && pts.length > 2; p++) {
    const out: Vec3[] = [pts[0]];
    let i = 0;
    while (i < pts.length - 1) {
      let j = i + 1;
      while (j + 1 < pts.length && sweepClear(w, pts[i], pts[j + 1])) j++;
      out.push(pts[j]);
      i = j;
    }
    const same = out.length === pts.length;
    pts = out;
    if (same) break;
  }
  return pts;
}

function polylineLength(pts: Vec3[]): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += distance(pts[i - 1], pts[i]);
  return s;
}

/** 装飾の AABB（box / cylinder のみ。それ以外は null） */
function decorAABB(d: DecorDef): AABB | null {
  if (d.kind === 'box') return d.box ?? null;
  if (d.kind === 'cylinder' && d.position && d.radius !== undefined && d.height !== undefined) {
    const r = d.radius;
    const h = d.height / 2;
    const ax = d.axis ?? 'y';
    const ex: Vec3 = [ax === 'x' ? h : r, ax === 'y' ? h : r, ax === 'z' ? h : r];
    const p = d.position;
    return { min: [p[0] - ex[0], p[1] - ex[1], p[2] - ex[2]], max: [p[0] + ex[0], p[1] + ex[1], p[2] + ex[2]] };
  }
  return null;
}

/** 階層の判定に使う「床」の材質（配管・設備・木箱の上面は床として数えない） */
const FLOOR_MATERIALS: ReadonlySet<MaterialKey> = new Set<MaterialKey>(['concrete', 'concreteDark', 'floorPlate', 'grate', 'catwalk']);

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

export const VERIFY_THRESHOLDS = {
  minSectors: 15,
  minKinds: 6,
  minPathMeters: 1500,
  minPathSectors: 12,
  minBranches: 3,
  minLoops: 2,
  minFlightPoints: 6,
  minLayers: 3,
  minArenas: 5,
  arenaLongM: 60,
  arenaShortM: 50,
  minCrossfire: 5,
  crossfireEnemies: 4,
  flightMinDiff: 6,
  flightMaxDiff: 16,
  /** 最弱ジェネレーターの EN に対する余裕 */
  flightEnMargin: 1.25,
  /** 飛行地点が最短経路からこれ以内 [m] */
  flightNearPathM: 6,
  /** 開始地点から最も近い敵までの距離 [m]（警告） */
  startMinEnemyDistance: 25,
  /**
   * 「離れた場所から破壊する」射撃可能距離 [m]。ロック射程（120）、ビーム射程（120）、自由射撃の MG 弾の
   * 直線到達上限（100 m/s × 2 s ＋ ½·18·2² = 236 m。真下へ撃つ場合の上限で、他の方向はこれ未満）、
   * ミサイルの直線到達上限（45 × 4 = 180 m）の最大
   */
  firingRangeM: Math.max(
    FCS.range,
    WEAPONS.beam.range,
    WEAPONS.machinegun.speed * WEAPONS.machinegun.lifetime + 0.5 * Math.abs(WEAPONS.machinegun.gravity[1]) * WEAPONS.machinegun.lifetime ** 2,
    WEAPONS.missile.speed * WEAPONS.missile.lifetime,
  ),
  /** 衝突なしの装飾として許す太さ: シリンダー半径 / ボックス最小辺の半分 [m]。これを超える装飾が通行空間にあればエラー */
  decorThinRadius: 0.5,
  /** 高度帯として数えるために必要な、その床の上の経路セル数 */
  minLayerCells: 3,
  /** 隣接する床高さの差がこれ [m] を超えたら別の高度帯 */
  layerGapM: 3,
} as const;

export function verifyStage(data: StageData): StageReport {
  const t0 = Date.now();
  const errors: string[] = [];
  const warnings: string[] = [];
  const err = (s: string) => errors.push(s);
  const warn = (s: string) => warnings.push(s);

  // ---- 1. 衝突ワールド -------------------------------------------------
  /** solids ＋ barriers[openCount..] ＋（gateOpen でなければ）ゲート */
  const buildWorld = (openCount: number, gateOpen: boolean): CollisionWorld => {
    const w = createCollisionWorld();
    for (const s of data.solids) w.addCollider(s.box, s.material);
    for (let b = openCount; b < data.barriers.length; b++) w.addCollider(data.barriers[b].box, 'barrier:' + data.barriers[b].id);
    if (!gateOpen) w.addCollider(data.gate.box, 'gate');
    return w;
  };
  const world: CollisionWorld = createCollisionWorld();
  for (const s of data.solids) world.addCollider(s.box, s.material);
  const barrierIds = new Map<string, number>();
  for (const bd of data.barriers) barrierIds.set(bd.id, world.addCollider(bd.box, 'barrier:' + bd.id));
  let gateId: number | null = world.addCollider(data.gate.box, 'gate');
  /** 初期状態（全隔壁・ゲート閉）のワールド。敵配置・交差射線・開始地点の判定に使う */
  const worldClosed: CollisionWorld = buildWorld(0, false);

  const bounds = world.bounds();
  const g = new Grid(bounds, 8);
  const sectorById = new Map<string, SectorDef>();
  for (const s of data.sectors) sectorById.set(s.id, s);
  const enemyById = new Map<string, EnemyDef>();
  for (const e of data.enemies) enemyById.set(e.id, e);

  // ---- 2. ボクセル化 ---------------------------------------------------
  const base: Uint8Array = new Uint8Array(g.n);
  const support: Uint8Array = new Uint8Array(g.n);
  for (const s of data.solids) {
    rasterizeBlocked(g, s.box, base);
    rasterizeSupport(g, s.box, support);
  }
  markBoundary(g, base);
  const barrierCells = data.barriers.map((bd) => cellsOfBox(g, bd.box));
  const gateCells = cellsOfBox(g, data.gate.box);
  let freeCells = 0;
  for (let i = 0; i < g.n; i++) if (!base[i]) freeCells++;

  /** 段階 k の占有（barriers[0..k-1] 開、k ≥ 6 ならゲートも開） */
  const occupancyForStage = (k: number): Uint8Array => {
    const out = base.slice();
    for (let b = k; b < data.barriers.length; b++) for (const c of barrierCells[b]) out[c] = 1;
    if (k < data.barriers.length) for (const c of gateCells) out[c] = 1;
    return out;
  };
  const allOpen = occupancyForStage(data.barriers.length);
  const allClosed = occupancyForStage(0);

  // セル → 区画（区画定義順で最初に含むもの。判定点はセル中心 xz、y = 下面 + 当たり判定中心高さ）
  const sectorOfCell = new Int16Array(g.n).fill(-1);
  const hitY = PLAYER.hitCenterOffset[1];
  data.sectors.forEach((s, si) => {
    for (const bx of s.bounds) {
      const i0 = Math.max(0, Math.ceil((bx.min[0] - g.x0 - CELL / 2) / CELL));
      const i1 = Math.min(g.nx - 1, Math.floor((bx.max[0] - g.x0 - CELL / 2) / CELL));
      const k0 = Math.max(0, Math.ceil((bx.min[2] - g.z0 - CELL / 2) / CELL));
      const k1 = Math.min(g.nz - 1, Math.floor((bx.max[2] - g.z0 - CELL / 2) / CELL));
      const j0 = Math.max(0, Math.ceil((bx.min[1] - hitY - g.y0) / CELL));
      const j1 = Math.min(g.ny - 1, Math.floor((bx.max[1] - hitY - g.y0) / CELL));
      for (let j = j0; j <= j1; j++)
        for (let k = k0; k <= k1; k++)
          for (let i = i0; i <= i1; i++) {
            const idx = g.idx(i, j, k);
            if (sectorOfCell[idx] < 0) sectorOfCell[idx] = si;
          }
    }
  });
  const sectorIndex = (id: string): number => data.sectors.findIndex((s) => s.id === id);

  // ---- 3. 進行段階ごとのダイクストラ ---------------------------------------
  const startCell = g.cellOfFoot(data.start.position);
  if (startCell < 0 || allClosed[startCell]) err(`開始地点 ${data.start.position} が自由セルではない`);
  const controlByBarrier = new Map<string, EnemyDef>();
  for (const e of data.enemies) if (e.isGateControl && e.controlsBarrierId) controlByBarrier.set(e.controlsBarrierId, e);

  const preds: Int32Array[] = [];
  const dists: Float64Array[] = [];
  const firingSets: Int32Array[] = [];
  const firingCellsOutsideSector: Record<string, number> = {};
  const firingCellCounts: Record<string, number> = {};
  let sources: { idx: number; dist: number }[] = [{ idx: startCell, dist: 0 }];
  let totalDistance = Infinity;
  let endCell = -1;
  let progressionOk = startCell >= 0;
  const removeBarrier = (id: string) => {
    const cid = barrierIds.get(id);
    if (cid !== undefined) {
      world.removeCollider(cid);
      barrierIds.delete(id);
    }
  };

  for (let k = 0; k <= data.barriers.length && progressionOk; k++) {
    const occ = occupancyForStage(k);
    const res = dijkstra(g, occ, support, sources);
    preds.push(res.pred);
    dists.push(res.dist);
    if (k < data.barriers.length) {
      const bd = data.barriers[k];
      const turret = controlByBarrier.get(bd.id);
      if (!turret) {
        err(`隔壁 ${bd.id} を制御する砲台がない`);
        progressionOk = false;
        break;
      }
      const center = enemyCenter(turret);
      const tSector = sectorIndex(turret.sectorId);
      // 射撃可能セル: firingRangeM 以内、到達可能、射線が通る
      const cells: number[] = [];
      const distsOut: number[] = [];
      let outside = 0;
      const r = VERIFY_THRESHOLDS.firingRangeM;
      const i0 = Math.max(0, Math.floor((center[0] - r - g.x0) / CELL));
      const i1 = Math.min(g.nx - 1, Math.ceil((center[0] + r - g.x0) / CELL));
      const j0 = Math.max(0, Math.floor((center[1] - r - g.y0) / CELL));
      const j1 = Math.min(g.ny - 1, Math.ceil((center[1] + r - g.y0) / CELL));
      const k0 = Math.max(0, Math.floor((center[2] - r - g.z0) / CELL));
      const k1 = Math.min(g.nz - 1, Math.ceil((center[2] + r - g.z0) / CELL));
      for (let j = j0; j <= j1; j++)
        for (let kk = k0; kk <= k1; kk++)
          for (let i = i0; i <= i1; i++) {
            const idx = g.idx(i, j, kk);
            if (occ[idx] || res.dist[idx] === Infinity) continue;
            const c = g.center(idx);
            if (distance(c, center) > r) continue;
            if (world.segmentBlocked(c, center)) continue;
            cells.push(idx);
            distsOut.push(res.dist[idx]);
            if (sectorOfCell[idx] !== tSector) outside++;
          }
      firingCellCounts[turret.id] = cells.length;
      firingCellsOutsideSector[turret.id] = outside;
      if (outside > 0) err(`制御砲台 ${turret.id} は自区画 ${turret.sectorId} の外から ${outside} セルで視認できる（狙撃可能）`);
      if (cells.length === 0) {
        err(`段階 ${k}: 制御砲台 ${turret.id}（隔壁 ${bd.id}）の射撃可能セルに到達できない`);
        progressionOk = false;
        break;
      }
      firingSets.push(Int32Array.from(cells));
      // 射撃可能セル集合（累積距離付き）が次段階の始点。巨大な集合をスプレッド展開しない
      sources = cells.map((idx, n) => ({ idx, dist: distsOut[n] }));
      removeBarrier(bd.id);
    } else {
      // 脱出領域
      let best = Infinity;
      for (let idx = 0; idx < g.n; idx++) {
        if (res.dist[idx] === Infinity) continue;
        const c = g.center(idx);
        if (pointInAABB(c, data.exitZone) && res.dist[idx] < best) {
          best = res.dist[idx];
          endCell = idx;
        }
      }
      if (endCell < 0) {
        err('脱出領域に到達できない');
        progressionOk = false;
      } else {
        totalDistance = best;
      }
    }
  }
  if (gateId !== null) {
    world.removeCollider(gateId);
    gateId = null;
  }

  // 経路の復元と紐張り（段階ごとに、その段階で閉じている隔壁・ゲートを含むワールドで掃引する）。
  // 段階別距離（gridLegMeters / legMeters）は復元した経路の各段階区間の長さ
  let pathCells: number[] = [];
  const legMeters: number[] = [];
  const gridLegMeters: number[] = [];
  const pulledPath: Vec3[] = [];
  let pulledDistance = Infinity;
  if (progressionOk && endCell >= 0) {
    let end = endCell;
    const segments: number[][] = [];
    for (let k = preds.length - 1; k >= 0; k--) {
      const seg = backtrack(preds[k], end);
      segments.push(seg);
      end = seg[0];
    }
    segments.reverse();
    for (const seg of segments) {
      if (pathCells.length > 0 && pathCells[pathCells.length - 1] === seg[0]) pathCells.push(...seg.slice(1));
      else pathCells.push(...seg);
    }
    // 経路長の再計算（検算）
    let sum = 0;
    for (let i = 1; i < pathCells.length; i++) sum += distance(g.center(pathCells[i - 1]), g.center(pathCells[i]));
    if (Math.abs(sum - totalDistance) > 1e-6 * Math.max(1, totalDistance) + 1e-6) warn(`経路長の検算差 ${Math.abs(sum - totalDistance).toFixed(3)} m`);
    pulledDistance = 0;
    segments.forEach((seg, k) => {
      const w = buildWorld(k, k >= data.barriers.length);
      const pts = pullPath(
        seg.map((c) => feetOfCell(g, c)),
        w,
      );
      const len = polylineLength(pts);
      const gridLen = polylineLength(seg.map((c) => feetOfCell(g, c)));
      if (len > gridLen + 1e-6) warn(`段階 ${k}: 紐張り後の経路 ${len.toFixed(1)} m が格子経路 ${gridLen.toFixed(1)} m より長い`);
      legMeters.push(len);
      gridLegMeters.push(gridLen);
      pulledDistance += len;
      for (let i = 0; i < pts.length; i++) {
        if (i === 0 && pulledPath.length > 0) continue; // 段階の継ぎ目は同じ点
        pulledPath.push(pts[i]);
      }
    });
  }
  const pathSet = new Uint8Array(g.n);
  for (const c of pathCells) pathSet[c] = 1;

  // 経路が通る区画
  const routeSectors: string[] = [];
  let outsideCount = 0;
  for (const c of pathCells) {
    const si = sectorOfCell[c];
    if (si < 0) {
      outsideCount++;
      continue;
    }
    const id = data.sectors[si].id;
    if (routeSectors.length === 0 || routeSectors[routeSectors.length - 1] !== id) routeSectors.push(id);
  }
  if (outsideCount > 0) err(`最短経路のうち ${outsideCount} セルがどの区画にも属さない`);
  const distinctRouteSectors = Array.from(new Set(routeSectors));
  if (progressionOk) {
    if (pulledDistance < VERIFY_THRESHOLDS.minPathMeters) err(`最短経路（紐張り後）${pulledDistance.toFixed(1)} m < ${VERIFY_THRESHOLDS.minPathMeters} m（格子 ${totalDistance.toFixed(1)} m）`);
    if (distinctRouteSectors.length < VERIFY_THRESHOLDS.minPathSectors) err(`必須経路の通過区画 ${distinctRouteSectors.length} < ${VERIFY_THRESHOLDS.minPathSectors}`);
  }

  // ---- 全開放時の到達性 --------------------------------------------------
  const reachAll = dijkstra(g, allOpen, support, [{ idx: startCell, dist: 0 }]);
  let reachableCells = 0;
  let boundaryLeak = 0;
  for (let idx = 0; idx < g.n; idx++) {
    if (reachAll.dist[idx] === Infinity) continue;
    reachableCells++;
    const i = g.i(idx);
    const j = g.j(idx);
    const k = g.k(idx);
    if (i <= 1 || j <= 1 || k <= 1 || i >= g.nx - 2 || j >= g.ny - 2 || k >= g.nz - 2) boundaryLeak++;
  }
  if (boundaryLeak > 0) err(`施設が密閉されていない: 外周まで到達できるセルが ${boundaryLeak} 個ある`);

  // ---- 4. 歩行のみの到達性 -----------------------------------------------
  const exitMask = new Uint8Array(g.n);
  for (let idx = 0; idx < g.n; idx++) if (!allOpen[idx] && pointInAABB(g.center(idx), data.exitZone)) exitMask[idx] = 1;
  const walk = dijkstra(g, allOpen, support, [{ idx: startCell, dist: 0 }], { walkOnly: true, stopAt: exitMask });
  const walkOnlyExitReachable = walk.reached >= 0;
  if (walkOnlyExitReachable) err('歩行・ジャンプのみで脱出領域に到達できる（飛行必須箇所が機能していない）');
  let walkOnlyReachableCells = 0;
  for (let idx = 0; idx < g.n; idx++) if (walk.dist[idx] < Infinity) walkOnlyReachableCells++;
  if (walkOnlyReachableCells < 100) err(`歩行のみで到達できるセルが ${walkOnlyReachableCells} 個しかない（歩行グラフが壊れている）`);
  // 最初の制御砲台の射撃位置までは歩行のみで到達できること（飛行を要求しない）
  let walkOnlyReachesFirstControl = false;
  if (firingSets.length > 0) for (const c of firingSets[0]) if (walk.dist[c] < Infinity) walkOnlyReachesFirstControl = true;
  if (!walkOnlyReachesFirstControl) err('最初の制御砲台の射撃位置へ歩行のみで到達できない');
  // 経路上の全セルを始点とする歩行到達性（警備ロボットの床が経路の床と歩いてつながっているか）
  const walkFromRoute = dijkstra(
    g,
    allOpen,
    support,
    pathCells.filter((c) => support[c]).map((idx) => ({ idx, dist: 0 })),
    { walkOnly: true },
  );

  // ---- 5. 飛行必須箇所 --------------------------------------------------
  const enBudget = Math.min(...Object.values(GENERATORS).map((x) => x.maxEn)) / VERIFY_THRESHOLDS.flightEnMargin;
  const flightReports: FlightPointReport[] = [];
  const distToPath = (p: Vec3): number => {
    let best = Infinity;
    for (const c of pathCells) {
      const d = distance(g.center(c), p);
      if (d < best) best = d;
    }
    return best;
  };
  for (const fp of data.flightPoints) {
    const fe: string[] = [];
    const h = fp.to[1] - fp.from[1];
    const gap = distanceXZ(fp.from, fp.to);
    const t = Math.max(h / PLAYER.flightRiseSpeed, gap / (PLAYER.airSpeed * 0.8));
    const en = PLAYER.flightEnPerSecond * t;
    if (Math.abs(h - fp.heightDiff) > 0.01) fe.push(`heightDiff 宣言 ${fp.heightDiff} と実測 ${h} が不一致`);
    if (h < VERIFY_THRESHOLDS.flightMinDiff || h > VERIFY_THRESHOLDS.flightMaxDiff) fe.push(`高低差 ${h} が 6〜16 の範囲外`);
    if (en > enBudget) fe.push(`必要 EN ${en.toFixed(1)} > 許容 ${enBudget.toFixed(1)}`);
    const fromCell = g.cellOfFoot(fp.from);
    const toCell = g.cellOfFoot(fp.to);
    const fromSupported = fromCell >= 0 && !allOpen[fromCell] && support[fromCell] === 1;
    const toSupported = toCell >= 0 && !allOpen[toCell] && support[toCell] === 1;
    if (!fromSupported) fe.push('離陸足場が自由セルでないか床がない');
    if (!toSupported) fe.push('着地足場が自由セルでないか床がない');
    let walkOnlyReachable = false;
    if (fromCell >= 0 && toCell >= 0) {
      const target = new Uint8Array(g.n);
      target[toCell] = 1;
      const w = dijkstra(g, allOpen, support, [{ idx: fromCell, dist: 0 }], { walkOnly: true, stopAt: target });
      walkOnlyReachable = w.reached >= 0;
      if (walkOnlyReachable) fe.push('歩行・ジャンプのみで離陸足場から着地足場へ到達できる');
    }
    const fd = distToPath(fp.from);
    const td = distToPath(fp.to);
    if (fd > VERIFY_THRESHOLDS.flightNearPathM) fe.push(`離陸足場が最短経路から ${fd.toFixed(1)} m 離れている`);
    if (td > VERIFY_THRESHOLDS.flightNearPathM) fe.push(`着地足場が最短経路から ${td.toFixed(1)} m 離れている`);
    if (!sectorById.has(fp.sectorId)) fe.push(`区画 ${fp.sectorId} が存在しない`);
    const ok = fe.length === 0;
    if (!ok) err(`飛行必須箇所 ${fp.id}: ${fe.join('; ')}`);
    flightReports.push({ id: fp.id, sectorId: fp.sectorId, ok, heightDiff: h, horizontalGap: gap, thrustSeconds: t, enRequired: en, enBudget, fromSupported, toSupported, walkOnlyReachable, fromDistToPath: fd, toDistToPath: td, errors: fe });
  }
  const okFlightPoints = flightReports.filter((f) => f.ok).length;
  if (okFlightPoints < VERIFY_THRESHOLDS.minFlightPoints) err(`有効な飛行必須箇所 ${okFlightPoints} < ${VERIFY_THRESHOLDS.minFlightPoints}`);
  // 別々の場所であること
  for (let a = 0; a < data.flightPoints.length; a++)
    for (let b = a + 1; b < data.flightPoints.length; b++)
      if (distance(data.flightPoints[a].from, data.flightPoints[b].from) < 10) err(`飛行必須箇所 ${data.flightPoints[a].id} と ${data.flightPoints[b].id} が同じ場所にある`);

  // ---- 6. 区画 ----------------------------------------------------------
  const kinds = Array.from(new Set(data.sectors.map((s) => s.kind)));
  if (data.sectors.length < VERIFY_THRESHOLDS.minSectors) err(`区画数 ${data.sectors.length} < ${VERIFY_THRESHOLDS.minSectors}`);
  if (kinds.length < VERIFY_THRESHOLDS.minKinds) err(`区画種別 ${kinds.length} < ${VERIFY_THRESHOLDS.minKinds}`);
  const ids = new Set<string>();
  for (const s of data.sectors) {
    if (ids.has(s.id)) err(`区画 ID 重複 ${s.id}`);
    ids.add(s.id);
    if (!(s.id in data.objectiveHints)) err(`区画 ${s.id} の objectiveHints がない`);
  }
  const sectorFree = new Int32Array(data.sectors.length);
  const sectorReach = new Int32Array(data.sectors.length);
  for (let idx = 0; idx < g.n; idx++) {
    const si = sectorOfCell[idx];
    if (si < 0 || allOpen[idx]) continue;
    sectorFree[si]++;
    if (reachAll.dist[idx] < Infinity) sectorReach[si]++;
  }
  data.sectors.forEach((s, si) => {
    if (sectorFree[si] === 0) err(`区画 ${s.id} に自由セルがない`);
    else if (sectorReach[si] === 0) err(`区画 ${s.id} に到達できない`);
  });

  // アリーナ
  const arenaSizes: Record<string, [number, number]> = {};
  let arenaCount = 0;
  for (const id of data.arenaSectorIds) {
    const si = sectorIndex(id);
    if (si < 0) {
      err(`アリーナ区画 ${id} が存在しない`);
      continue;
    }
    const s = data.sectors[si];
    let bi0 = Infinity;
    let bi1 = -Infinity;
    let bk0 = Infinity;
    let bk1 = -Infinity;
    let bj0 = Infinity;
    let bj1 = -Infinity;
    for (const bx of s.bounds) {
      bi0 = Math.min(bi0, Math.floor((bx.min[0] - g.x0) / CELL));
      bi1 = Math.max(bi1, Math.ceil((bx.max[0] - g.x0) / CELL));
      bk0 = Math.min(bk0, Math.floor((bx.min[2] - g.z0) / CELL));
      bk1 = Math.max(bk1, Math.ceil((bx.max[2] - g.z0) / CELL));
      bj0 = Math.min(bj0, Math.floor((bx.min[1] - g.y0) / CELL));
      bj1 = Math.max(bj1, Math.ceil((bx.max[1] - g.y0) / CELL));
    }
    bi0 = Math.max(0, bi0);
    bk0 = Math.max(0, bk0);
    bj0 = Math.max(0, bj0);
    bi1 = Math.min(g.nx - 1, bi1);
    bk1 = Math.min(g.nz - 1, bk1);
    bj1 = Math.min(g.ny - 1, bj1);
    const w = bi1 - bi0 + 1;
    const h = bk1 - bk0 + 1;
    let best: [number, number] = [0, 0];
    let ok = false;
    for (let j = bj0; j <= bj1 && !ok; j++) {
      const layer = new Uint8Array(w * h);
      let any = 0;
      for (let k = bk0; k <= bk1; k++)
        for (let i = bi0; i <= bi1; i++) {
          const idx = g.idx(i, j, k);
          if (!allOpen[idx] && support[idx] && sectorOfCell[idx] === si && reachAll.dist[idx] < Infinity) {
            layer[(k - bk0) * w + (i - bi0)] = 1;
            any++;
          }
        }
      if (any === 0) continue;
      const r = fitsRectangle(layer, w, h, VERIFY_THRESHOLDS.arenaLongM, VERIFY_THRESHOLDS.arenaShortM);
      if (r.size[0] * r.size[1] > best[0] * best[1]) best = r.size;
      if (r.ok) {
        ok = true;
        best = r.size;
      }
    }
    arenaSizes[id] = [best[0] * CELL, best[1] * CELL];
    if (ok) arenaCount++;
    else err(`アリーナ区画 ${id}: 60×50 m の空き床が取れない（最大 ${best[0] * CELL}×${best[1] * CELL} m）`);
  }
  if (arenaCount < VERIFY_THRESHOLDS.minArenas) err(`アリーナ区画 ${arenaCount} < ${VERIFY_THRESHOLDS.minArenas}`);

  // 交差射線（隔壁は全て閉じた初期状態で判定）
  const crossfireDetails: Record<string, string[]> = {};
  const crossfireSimultaneous: Record<string, number> = {};
  let crossfireCount = 0;
  let startHasLos = false;
  let nearestEnemyToStart = Infinity;
  {
    const w0 = worldClosed;
    for (const cf of data.crossfireSectors) {
      const si = sectorIndex(cf.sectorId);
      if (si < 0) {
        err(`交差射線区画 ${cf.sectorId} が存在しない`);
        continue;
      }
      const routeCells = pathCells.filter((c) => sectorOfCell[c] === si);
      const withLos: string[] = [];
      const shooters: { e: EnemyDef; m: Vec3; range: number }[] = [];
      for (const eid of cf.enemyIds) {
        const e = enemyById.get(eid);
        if (!e) {
          err(`交差射線区画 ${cf.sectorId} の敵 ${eid} が存在しない`);
          continue;
        }
        if (e.sectorId !== cf.sectorId) warn(`交差射線区画 ${cf.sectorId} の敵 ${eid} は区画 ${e.sectorId} に配置されている`);
        const m = enemyMuzzle(e);
        const range = e.kind === 'guard' ? ENEMIES.guard.detectRange : ENEMIES.turret.detectRange;
        shooters.push({ e, m, range });
        let has = false;
        for (const c of routeCells) {
          const p = g.center(c);
          if (distance(p, m) <= range && !w0.segmentBlocked(m, p)) {
            has = true;
            break;
          }
        }
        if (has) withLos.push(eid);
      }
      crossfireDetails[cf.sectorId] = withLos;
      // 同時射線: 1 つの位置に対して何体が同時に射線を持つか（まず経路セル、足りなければ区画内の床セル全て）
      const simultaneousAt = (cells: Iterable<number>): number => {
        let best = 0;
        for (const c of cells) {
          const p = g.center(c);
          let n = 0;
          for (const s of shooters) if (distance(p, s.m) <= s.range && !w0.segmentBlocked(s.m, p)) n++;
          if (n > best) best = n;
          if (best >= shooters.length) break;
        }
        return best;
      };
      let simul = simultaneousAt(routeCells);
      if (simul < VERIFY_THRESHOLDS.crossfireEnemies) {
        const floorCells: number[] = [];
        for (let idx = 0; idx < g.n; idx++) if (sectorOfCell[idx] === si && !allClosed[idx] && support[idx] && reachAll.dist[idx] < Infinity) floorCells.push(idx);
        simul = Math.max(simul, simultaneousAt(floorCells));
      }
      crossfireSimultaneous[cf.sectorId] = simul;
      if (withLos.length >= VERIFY_THRESHOLDS.crossfireEnemies && simul >= VERIFY_THRESHOLDS.crossfireEnemies) crossfireCount++;
      else if (withLos.length < VERIFY_THRESHOLDS.crossfireEnemies) err(`交差射線区画 ${cf.sectorId}: 経路へ射線を持つ敵 ${withLos.length} < ${VERIFY_THRESHOLDS.crossfireEnemies}（${withLos.join(',')}）`);
      else err(`交差射線区画 ${cf.sectorId}: 1 つの位置へ同時に射線を持つ敵の最大 ${simul} < ${VERIFY_THRESHOLDS.crossfireEnemies}`);
    }

    // 開始地点の遮蔽（初期状態）
    const startCenter = add(data.start.position, PLAYER.hitCenterOffset);
    let nearest = Infinity;
    for (const e of data.enemies) {
      const m = enemyMuzzle(e);
      const d = distance(m, startCenter);
      if (d < nearest) nearest = d;
      const range = e.kind === 'guard' ? ENEMIES.guard.detectRange : ENEMIES.turret.detectRange;
      if (d <= range && !w0.segmentBlocked(m, startCenter)) {
        startHasLos = true;
        err(`敵 ${e.id} が開始地点へ射線を持つ`);
      }
    }
    if (nearest < VERIFY_THRESHOLDS.startMinEnemyDistance) warn(`開始地点から最も近い敵まで ${nearest.toFixed(1)} m`);
    nearestEnemyToStart = nearest;
  }
  if (crossfireCount < VERIFY_THRESHOLDS.minCrossfire) err(`交差射線区画 ${crossfireCount} < ${VERIFY_THRESHOLDS.minCrossfire}`);

  // 分岐
  let branchCount = 0;
  const cellSector = (idx: number) => sectorOfCell[idx];
  for (const br of data.branches) {
    const split = sectorIndex(br.splitSectorId);
    const merge = sectorIndex(br.mergeSectorId);
    if (split < 0 || merge < 0) {
      err(`分岐 ${br.id}: 区画が存在しない`);
      continue;
    }
    if (br.routes.length < 2) {
      err(`分岐 ${br.id}: 経路が 2 本ない`);
      continue;
    }
    const routePaths: number[][] = [];
    const interSets: Set<string>[] = [];
    let ok = true;
    for (const rt of br.routes) {
      const allowedIdx = new Set(rt.sectorIds.map(sectorIndex));
      if (allowedIdx.has(-1)) {
        err(`分岐 ${br.id}: 経路の区画が存在しない (${rt.sectorIds.join(',')})`);
        ok = false;
        break;
      }
      const inter = new Set(rt.sectorIds.filter((x) => x !== br.splitSectorId && x !== br.mergeSectorId));
      interSets.push(inter);
      const allowed = new Uint8Array(g.n);
      const src: { idx: number; dist: number }[] = [];
      const target = new Uint8Array(g.n);
      for (let idx = 0; idx < g.n; idx++) {
        const si = cellSector(idx);
        if (si < 0 || allOpen[idx] || !allowedIdx.has(si)) continue;
        allowed[idx] = 1;
        if (si === split) src.push({ idx, dist: 0 });
        if (si === merge) target[idx] = 1;
      }
      const r = dijkstra(g, allOpen, support, src, { allowed, stopAt: target });
      if (r.reached < 0) {
        err(`分岐 ${br.id}: 経路 [${rt.sectorIds.join('→')}] が通れない`);
        ok = false;
        break;
      }
      routePaths.push(backtrack(r.pred, r.reached));
    }
    if (!ok) continue;
    // 中間区画が互いに素であること、経路セルを共有しないこと
    for (let a = 0; a < interSets.length && ok; a++)
      for (let b = a + 1; b < interSets.length && ok; b++) {
        for (const x of interSets[a]) if (interSets[b].has(x)) ok = false;
        if (!ok) err(`分岐 ${br.id}: 経路 ${a} と ${b} が中間区画を共有している`);
        const cellsA = new Set(routePaths[a].filter((c) => cellSector(c) !== split && cellSector(c) !== merge));
        for (const c of routePaths[b]) if (cellSector(c) !== split && cellSector(c) !== merge && cellsA.has(c)) ok = false;
        if (!ok) err(`分岐 ${br.id}: 経路 ${a} と ${b} が分岐点・合流点以外でセルを共有している`);
      }
    if (interSets.every((s) => s.size === 0)) {
      err(`分岐 ${br.id}: 全ての経路が中間区画を持たない（同じ扉の往復と区別できない）`);
      ok = false;
    }
    if (ok) branchCount++;
  }
  if (branchCount < VERIFY_THRESHOLDS.minBranches) err(`分岐 ${branchCount} < ${VERIFY_THRESHOLDS.minBranches}`);

  // 環状経路
  let loopCount = 0;
  for (const lp of data.loops) {
    const distinct = new Set(lp.sectorIds);
    if (distinct.size < 3 || distinct.size !== lp.sectorIds.length) {
      err(`環状経路 ${lp.id}: 3 区画以上の相異なる区画列が必要`);
      continue;
    }
    let ok = true;
    for (let n = 0; n < lp.sectorIds.length && ok; n++) {
      const a = sectorIndex(lp.sectorIds[n]);
      const c = sectorIndex(lp.sectorIds[(n + 1) % lp.sectorIds.length]);
      if (a < 0 || c < 0) {
        err(`環状経路 ${lp.id}: 区画が存在しない`);
        ok = false;
        break;
      }
      const allowed = new Uint8Array(g.n);
      const src: { idx: number; dist: number }[] = [];
      const target = new Uint8Array(g.n);
      for (let idx = 0; idx < g.n; idx++) {
        const si = cellSector(idx);
        if (allOpen[idx] || (si !== a && si !== c)) continue;
        allowed[idx] = 1;
        if (si === a) src.push({ idx, dist: 0 });
        else target[idx] = 1;
      }
      const r = dijkstra(g, allOpen, support, src, { allowed, stopAt: target });
      if (r.reached < 0) {
        err(`環状経路 ${lp.id}: ${lp.sectorIds[n]} と ${lp.sectorIds[(n + 1) % lp.sectorIds.length]} が直接つながっていない`);
        ok = false;
      }
    }
    if (ok) loopCount++;
  }
  if (loopCount < VERIFY_THRESHOLDS.minLoops) err(`環状経路 ${loopCount} < ${VERIFY_THRESHOLDS.minLoops}`);

  // ---- 7. 敵 ------------------------------------------------------------
  const guards = data.enemies.filter((e) => e.kind === 'guard');
  const turrets = data.enemies.filter((e) => e.kind === 'turret');
  const controls = turrets.filter((e) => e.isGateControl);
  if (data.enemies.length !== 45) err(`敵の総数 ${data.enemies.length} ≠ 45`);
  if (guards.length !== 30) err(`警備ロボット ${guards.length} ≠ 30`);
  if (turrets.length !== 15) err(`固定砲台 ${turrets.length} ≠ 15`);
  if (controls.length !== 6) err(`制御砲台 ${controls.length} ≠ 6`);
  for (const e of data.enemies) if (e.kind === 'target') err(`敵 ${e.id} が試験用標的 (target) になっている`);
  for (const e of data.enemies) if (e.isGateControl && e.kind !== 'turret') err(`制御装置 ${e.id} が固定砲台ではない`);
  {
    const seenBarrier = new Set<string>();
    const seenSector = new Set<string>();
    const barrierSet = new Set(data.barriers.map((bd) => bd.id));
    for (const c of controls) {
      if (!c.controlsBarrierId || !barrierSet.has(c.controlsBarrierId)) err(`制御砲台 ${c.id} の隔壁 ${c.controlsBarrierId} が存在しない`);
      else if (seenBarrier.has(c.controlsBarrierId)) err(`隔壁 ${c.controlsBarrierId} を複数の砲台が制御している`);
      else seenBarrier.add(c.controlsBarrierId);
      if (seenSector.has(c.sectorId)) err(`制御砲台 ${c.id} が他の制御砲台と同じ区画 ${c.sectorId} にある`);
      seenSector.add(c.sectorId);
    }
    for (const bd of data.barriers) {
      const t = enemyById.get(bd.controlTurretId);
      if (!t || !t.isGateControl || t.controlsBarrierId !== bd.id) err(`隔壁 ${bd.id} の controlTurretId ${bd.controlTurretId} が対応する制御砲台ではない`);
      if (!sectorById.has(bd.fromSectorId) || !sectorById.has(bd.toSectorId)) err(`隔壁 ${bd.id} の区画参照が不正`);
    }
    const idSet = new Set<string>();
    for (const e of data.enemies) {
      if (idSet.has(e.id)) err(`敵 ID 重複 ${e.id}`);
      idSet.add(e.id);
      if (!sectorById.has(e.sectorId)) err(`敵 ${e.id} の区画 ${e.sectorId} が存在しない`);
      const he = enemyHalfExtents(e);
      const center: Vec3 = [e.position[0], e.position[1] + he[1], e.position[2]];
      // 初期状態（隔壁・ゲート閉）のワールドで判定する: 閉じた隔壁の中に置かれた敵も検出する
      if (worldClosed.boxOverlaps(center, he)) err(`敵 ${e.id} がソリッド・隔壁・ゲートと重なっている (${e.position.join(',')})`);
      const cell = g.cellOfFoot(e.position);
      if (cell < 0 || allClosed[cell]) err(`敵 ${e.id} の足元セルが自由セルではない（隔壁閉の初期状態）(${e.position.join(',')})`);
      else if (reachAll.dist[cell] === Infinity) err(`敵 ${e.id} の足元セルに到達できない (${e.position.join(',')})`);
      else if (!support[cell]) err(`敵 ${e.id} の足元に床がない (${e.position.join(',')})`);
      else if (e.kind === 'guard' && walkFromRoute.dist[cell] === Infinity) err(`警備 ${e.id} の床が正規経路の床と歩行でつながっていない (${e.position.join(',')})`);
      // 宣言区画と実際の区画
      const si = sectorOfCell[cell >= 0 ? cell : 0];
      if (cell >= 0 && si >= 0 && data.sectors[si].id !== e.sectorId) warn(`敵 ${e.id} の宣言区画 ${e.sectorId} と位置の区画 ${data.sectors[si].id} が異なる`);
    }
  }

  // ---- 階層（経路の真下にある床の高さ） -----------------------------------
  // 各経路セルから同じ列を下へ辿り（壁・床を挟まない範囲で）最初に支えのあるセルを取り、その足元直下
  // （上面がセル下面の 0〜2 m 下）にある床材質のソリッドの上面高さを集める。自由飛行の経路は床の 1 セル上を
  // 通ることがあるので、経路セル自身の支えではなく真下の床を見る。配管・設備・木箱の上面は床として数えない。
  const layerHeights: number[] = [];
  const floorLevelCells: Record<string, number> = {};
  const floorLevels: number[] = [];
  {
    const hx = PLAYER.halfExtents[0];
    const hz = PLAYER.halfExtents[2];
    const floorSolids = data.solids.filter((s) => FLOOR_MATERIALS.has(s.material));
    const counts = new Map<number, number>();
    const colStride = g.nx * g.nz;
    for (const c of pathCells) {
      let stand = -1;
      let idx = c;
      for (let j = g.j(c); j >= 0; j--, idx -= colStride) {
        if (allOpen[idx] && idx !== c) break; // 壁・床を挟んだ下の空間は数えない
        if (support[idx]) {
          stand = idx;
          break;
        }
      }
      if (stand < 0) continue;
      const yb = g.bottom(stand);
      const p = g.center(stand);
      let best = -Infinity;
      for (const s of floorSolids) {
        const top = s.box.max[1];
        if (top > yb + 1e-6 || yb >= top + CELL) continue;
        if (p[0] < s.box.min[0] - hx || p[0] > s.box.max[0] + hx || p[2] < s.box.min[2] - hz || p[2] > s.box.max[2] + hz) continue;
        if (top > best) best = top;
      }
      if (best > -Infinity) counts.set(best, (counts.get(best) ?? 0) + 1);
    }
    for (const [h, n] of Array.from(counts.entries()).sort((a, b) => a[0] - b[0])) {
      floorLevelCells[String(h)] = n;
      if (n >= VERIFY_THRESHOLDS.minLayerCells) floorLevels.push(h);
    }
    // 隣接する床高さの差が layerGapM を超えたら別の高度帯（各帯の最低高さを記録）
    for (let n = 0; n < floorLevels.length; n++) {
      if (n === 0 || floorLevels[n] - floorLevels[n - 1] > VERIFY_THRESHOLDS.layerGapM) layerHeights.push(floorLevels[n]);
    }
  }
  if (layerHeights.length < VERIFY_THRESHOLDS.minLayers) err(`経路上の高度帯 ${layerHeights.length} < ${VERIFY_THRESHOLDS.minLayers}（床高さ ${floorLevels.join(', ')}）`);

  // ---- 通行空間にある衝突なしの大型装飾 -----------------------------------
  // 見た目と衝突を一致させる: 太い配管や箱を装飾（衝突なし）として通行空間に置くと、歩き抜け・撃ち抜けが起きる
  let decorInWalkableSpace = 0;
  data.decor.forEach((d, n) => {
    const box = decorAABB(d);
    if (!box) return;
    const thin = d.kind === 'cylinder' ? (d.radius ?? 0) <= VERIFY_THRESHOLDS.decorThinRadius : Math.min(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]) <= VERIFY_THRESHOLDS.decorThinRadius * 2;
    if (thin) return;
    let hit = 0;
    for (const c of cellsOfBox(g, box)) if (!allOpen[c] && reachAll.dist[c] < Infinity) hit++;
    if (hit > 0) {
      decorInWalkableSpace++;
      err(`装飾 #${n}（${d.kind} ${d.material ?? ''} ${d.sectorId ?? ''}）は衝突なしなのに通行空間に入っている（${hit} セル）。ソリッドにするか通行空間の外へ移すこと`);
    }
  });

  // ---- 経路サンプル -------------------------------------------------------
  const pathSample: Vec3[] = [];
  for (let n = 0; n < pathCells.length; n += 8) {
    const c = g.center(pathCells[n]);
    pathSample.push([c[0], g.bottom(pathCells[n]), c[2]]);
  }
  if (pathCells.length > 0) {
    const c = g.center(pathCells[pathCells.length - 1]);
    pathSample.push([c[0], g.bottom(pathCells[pathCells.length - 1]), c[2]]);
  }

  const report: StageReport = {
    ok: errors.length === 0,
    errors,
    warnings,
    metrics: {
      sectorCount: data.sectors.length,
      kinds,
      kindCount: kinds.length,
      shortestPathMeters: pulledDistance,
      legMeters,
      gridPathMeters: totalDistance,
      gridLegMeters,
      pulledPath,
      firingRangeM: VERIFY_THRESHOLDS.firingRangeM,
      routeSectors,
      pathSectorCount: distinctRouteSectors.length,
      branchCount,
      loopCount,
      flightPoints: flightReports,
      flightPointCount: okFlightPoints,
      layerCount: layerHeights.length,
      layerHeights,
      floorLevels,
      floorLevelCells,
      arenaCount,
      arenaSizes,
      crossfireCount,
      crossfireDetails,
      crossfireSimultaneous,
      enemies: { total: data.enemies.length, guards: guards.length, turrets: turrets.length, controls: controls.length },
      decorInWalkableSpace,
      walkOnlyExitReachable,
      walkOnlyReachableCells,
      walkOnlyReachesFirstControl,
      startHasLos,
      nearestEnemyToStart,
      firingCellsOutsideSector,
      firingCellCounts,
      gridCells: g.n,
      freeCells,
      reachableCells,
      solidCount: data.solids.length,
      pathSample,
      pathCellCount: pathCells.length,
      elapsedMs: Date.now() - t0,
    },
  };
  return report;
}
