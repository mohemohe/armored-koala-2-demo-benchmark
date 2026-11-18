/**
 * 静的 AABB 群の衝突ワールド（XZ 一様グリッドのブロードフェーズ付き）。
 * 隔壁・ゲートは addCollider / removeCollider で開閉する。Three.js・DOM に依存しない。
 *
 * ブロードフェーズ:
 * - セル 16 m の XZ グリッド。セルは Map<number, Node[]>（キーは ix・iz を合成した整数）で無制限。
 * - 極端に大きいコライダー（セル数が LARGE_CELL_COUNT を超える）は全問い合わせで必ず検査する別リストに置く。
 * - レイ/線分/掃引は XZ 平面で通過セルを順に辿り（DDA）、最初の衝突が確定した時点で打ち切る。
 *   球の掃引は半径分の近傍（3×3）も見る（半径 ≤ セル幅のとき正しい）。
 * - 同じコライダーを二重に検査しないよう問い合わせごとのスタンプで重複排除する。
 */
import type { AABB, ColliderEntry, CollisionWorld, MoveResult, RayHit, Vec3 } from '../types';
import { rayAABB, slabIntersect } from './geom';

/** グリッドのセル幅 [m] */
export const CELL_SIZE = 16;
/** 接触面の手前で停止する余裕 [m] */
export const CONTACT_MARGIN = 1e-4;
/**
 * moveBox の候補矩形の余裕 [m]。停止位置は接触面から CONTACT_MARGIN 手前なので、
 * 掃引範囲の CONTACT_MARGIN 先までにある面が結果に影響する。セル境界（16 m の倍数）に
 * 面を持つコライダーを取りこぼさないよう、丸め誤差込みで余裕を持たせる
 */
const GATHER_PAD = CONTACT_MARGIN * 2;
/** これを超えるセル数にまたがるコライダーはグリッドに登録せず常に検査する */
const LARGE_CELL_COUNT = 4096;
/** セルキー = ix * KEY_MUL + iz（|iz| < KEY_MUL/2 の範囲で一意。約 ±5×10^8 m まで） */
const KEY_MUL = 1 << 26;
/** DDA でセル境界と線分終点の一致を丸め誤差込みで判定する割合の余裕 */
const WALK_T_EPS = 1e-9;

interface Node {
  entry: ColliderEntry;
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  ix0: number;
  ix1: number;
  iz0: number;
  iz1: number;
  large: boolean;
  /** 問い合わせごとの重複排除用スタンプ */
  stamp: number;
}

function cellIndex(v: number): number {
  return Math.floor(v / CELL_SIZE);
}

function isFiniteVec3(v: Vec3): boolean {
  return Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]);
}

function cellKey(ix: number, iz: number): number {
  return ix * KEY_MUL + iz;
}

function makeHit(t: number, point: Vec3, normal: Vec3, node: Node): RayHit {
  const hit: RayHit = { t, point, normal, colliderId: node.entry.id };
  if (node.entry.tag !== undefined) hit.tag = node.entry.tag;
  return hit;
}

class GridCollisionWorld implements CollisionWorld {
  private readonly nodes = new Map<number, Node>();
  private readonly cells = new Map<number, Node[]>();
  private readonly largeNodes: Node[] = [];
  private nextId = 1;
  private stamp = 0;
  private listCache: ColliderEntry[] | null = null;
  private boundsCache: AABB | null = null;
  /** 矩形問い合わせ用の作業配列（問い合わせ間で再利用） */
  private readonly scratch: Node[] = [];

  // -------------------------------------------------------------------------
  // 登録
  // -------------------------------------------------------------------------

  addCollider(box: AABB, tag?: string): number {
    const minX = Math.min(box.min[0], box.max[0]);
    const minY = Math.min(box.min[1], box.max[1]);
    const minZ = Math.min(box.min[2], box.max[2]);
    const maxX = Math.max(box.min[0], box.max[0]);
    const maxY = Math.max(box.min[1], box.max[1]);
    const maxZ = Math.max(box.min[2], box.max[2]);
    if (![minX, minY, minZ, maxX, maxY, maxZ].every((v) => Number.isFinite(v))) {
      throw new Error('addCollider: AABB must be finite');
    }
    const id = this.nextId++;
    const entry: ColliderEntry = { id, box: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] } };
    if (tag !== undefined) entry.tag = tag;
    const ix0 = cellIndex(minX);
    const ix1 = cellIndex(maxX);
    const iz0 = cellIndex(minZ);
    const iz1 = cellIndex(maxZ);
    const cellCount = (ix1 - ix0 + 1) * (iz1 - iz0 + 1);
    const node: Node = { entry, minX, minY, minZ, maxX, maxY, maxZ, ix0, ix1, iz0, iz1, large: cellCount > LARGE_CELL_COUNT, stamp: 0 };
    this.nodes.set(id, node);
    if (node.large) {
      this.largeNodes.push(node);
    } else {
      for (let ix = ix0; ix <= ix1; ix++) {
        for (let iz = iz0; iz <= iz1; iz++) {
          const key = cellKey(ix, iz);
          const list = this.cells.get(key);
          if (list) list.push(node);
          else this.cells.set(key, [node]);
        }
      }
    }
    this.listCache = null;
    this.boundsCache = null;
    return id;
  }

  removeCollider(id: number): void {
    const node = this.nodes.get(id);
    if (!node) return;
    this.nodes.delete(id);
    if (node.large) {
      const i = this.largeNodes.indexOf(node);
      if (i >= 0) this.largeNodes.splice(i, 1);
    } else {
      for (let ix = node.ix0; ix <= node.ix1; ix++) {
        for (let iz = node.iz0; iz <= node.iz1; iz++) {
          const key = cellKey(ix, iz);
          const list = this.cells.get(key);
          if (!list) continue;
          const i = list.indexOf(node);
          if (i >= 0) list.splice(i, 1);
          if (list.length === 0) this.cells.delete(key);
        }
      }
    }
    this.listCache = null;
    this.boundsCache = null;
  }

  hasCollider(id: number): boolean {
    return this.nodes.has(id);
  }

  colliders(): readonly ColliderEntry[] {
    if (!this.listCache) {
      const list: ColliderEntry[] = [];
      for (const n of this.nodes.values()) list.push(n.entry);
      this.listCache = list;
    }
    return this.listCache;
  }

  bounds(): AABB {
    if (!this.boundsCache) {
      if (this.nodes.size === 0) {
        this.boundsCache = { min: [0, 0, 0], max: [0, 0, 0] };
      } else {
        let minX = Infinity;
        let minY = Infinity;
        let minZ = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        let maxZ = -Infinity;
        for (const n of this.nodes.values()) {
          if (n.minX < minX) minX = n.minX;
          if (n.minY < minY) minY = n.minY;
          if (n.minZ < minZ) minZ = n.minZ;
          if (n.maxX > maxX) maxX = n.maxX;
          if (n.maxY > maxY) maxY = n.maxY;
          if (n.maxZ > maxZ) maxZ = n.maxZ;
        }
        this.boundsCache = { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
      }
    }
    const b = this.boundsCache;
    return { min: [b.min[0], b.min[1], b.min[2]], max: [b.max[0], b.max[1], b.max[2]] };
  }

  // -------------------------------------------------------------------------
  // ブロードフェーズ
  // -------------------------------------------------------------------------

  /** XZ 矩形（境界含む）に重なるセルのコライダーを重複なく scratch に集める（大型コライダーを含む） */
  private gatherRect(minX: number, minZ: number, maxX: number, maxZ: number): Node[] {
    const out = this.scratch;
    out.length = 0;
    const stamp = ++this.stamp;
    for (const n of this.largeNodes) {
      n.stamp = stamp;
      out.push(n);
    }
    if (this.cells.size === 0) return out;
    const ix0 = cellIndex(minX);
    const ix1 = cellIndex(maxX);
    const iz0 = cellIndex(minZ);
    const iz1 = cellIndex(maxZ);
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iz = iz0; iz <= iz1; iz++) {
        const list = this.cells.get(cellKey(ix, iz));
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          const n = list[i];
          if (n.stamp === stamp) continue;
          n.stamp = stamp;
          out.push(n);
        }
      }
    }
    return out;
  }

  /**
   * XZ 平面上の線分 (ax,az)→(bx,bz)（割合 t∈[0,1]）が通るセルを順に辿る。
   * pad>0 なら各セルの 3×3 近傍も訪問する（pad ≤ CELL_SIZE を前提）。
   * 各ステップで通過セル（と近傍）を visit した後、stopAfter(tExit) が true なら打ち切る。
   * tExit は線分がそのステップのセルを出る割合。近傍まで訪問済みなので、tExit 以前に起こり得る
   * 接触はすべて検査済みであることが保証される。
   * 全コライダーの包含矩形（pad 拡張）で線分を先にクリップし、範囲外の部分は辿らない。
   */
  private walkCells(
    ax: number,
    az: number,
    bx: number,
    bz: number,
    pad: number,
    visit: (ix: number, iz: number) => void,
    stopAfter: (tExit: number) => boolean,
  ): void {
    if (this.cells.size === 0) return;
    const b = this.boundsCache ?? this.computeBoundsCache();
    // Liang–Barsky で包含矩形にクリップ
    const rMinX = b.min[0] - pad - 1e-9;
    const rMaxX = b.max[0] + pad + 1e-9;
    const rMinZ = b.min[2] - pad - 1e-9;
    const rMaxZ = b.max[2] + pad + 1e-9;
    const dx = bx - ax;
    const dz = bz - az;
    let t0 = 0;
    let t1 = 1;
    if (Math.abs(dx) < 1e-12) {
      if (ax < rMinX || ax > rMaxX) return;
    } else {
      const inv = 1 / dx;
      let ta = (rMinX - ax) * inv;
      let tb = (rMaxX - ax) * inv;
      if (ta > tb) {
        const tmp = ta;
        ta = tb;
        tb = tmp;
      }
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
      if (t0 > t1) return;
    }
    if (Math.abs(dz) < 1e-12) {
      if (az < rMinZ || az > rMaxZ) return;
    } else {
      const inv = 1 / dz;
      let ta = (rMinZ - az) * inv;
      let tb = (rMaxZ - az) * inv;
      if (ta > tb) {
        const tmp = ta;
        ta = tb;
        tb = tmp;
      }
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
      if (t0 > t1) return;
    }

    const neighbor = pad > 0 ? 1 : 0;
    const visitStep = (ix: number, iz: number, tExit: number): boolean => {
      if (neighbor === 0) {
        visit(ix, iz);
      } else {
        for (let di = -1; di <= 1; di++) {
          for (let dj = -1; dj <= 1; dj++) visit(ix + di, iz + dj);
        }
      }
      return stopAfter(tExit);
    };

    // 開始セル
    const sx = ax + dx * t0;
    const sz = az + dz * t0;
    let ix = cellIndex(sx);
    let iz = cellIndex(sz);
    const ex = ax + dx * t1;
    const ez = az + dz * t1;
    const ixEnd = cellIndex(ex);
    const izEnd = cellIndex(ez);
    const maxSteps = Math.abs(ixEnd - ix) + Math.abs(izEnd - iz) + 2;

    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
    let tMaxX = Infinity;
    let tDeltaX = Infinity;
    if (stepX !== 0) {
      const boundary = (stepX > 0 ? ix + 1 : ix) * CELL_SIZE;
      tMaxX = (boundary - ax) / dx;
      tDeltaX = CELL_SIZE / Math.abs(dx);
    }
    let tMaxZ = Infinity;
    let tDeltaZ = Infinity;
    if (stepZ !== 0) {
      const boundary = (stepZ > 0 ? iz + 1 : iz) * CELL_SIZE;
      tMaxZ = (boundary - az) / dz;
      tDeltaZ = CELL_SIZE / Math.abs(dz);
    }

    for (let step = 0; step < maxSteps; step++) {
      const rawExit = tMaxX < tMaxZ ? tMaxX : tMaxZ;
      const tExit = rawExit > t1 ? t1 : rawExit;
      if (visitStep(ix, iz, tExit)) return;
      if (ix === ixEnd && iz === izEnd) return;
      // 終点がセル境界上（= 境界上のコライダー面に触れる）なら次のセルも辿る必要がある:
      // 丸め誤差込みで境界を確実に越えるまで打ち切らない（余分なセル訪問は無害）
      if (rawExit > t1 + WALK_T_EPS) return;
      if (tMaxX < tMaxZ - WALK_T_EPS) {
        ix += stepX;
        tMaxX += tDeltaX;
      } else if (tMaxZ < tMaxX - WALK_T_EPS) {
        iz += stepZ;
        tMaxZ += tDeltaZ;
      } else {
        // セルの角をちょうど通過する（45° など）: 角の点は 4 セル全ての閉境界に属し、
        // 角にだけ触れるコライダーは斜め隣のセルにしか登録されていないことがある。
        // 両側のセルも訪れてから斜めに進む（3×3 近傍を見る掃引では訪問済み）
        if (neighbor === 0) {
          visit(ix + stepX, iz);
          visit(ix, iz + stepZ);
        }
        ix += stepX;
        iz += stepZ;
        tMaxX += tDeltaX;
        tMaxZ += tDeltaZ;
      }
    }
  }

  private computeBoundsCache(): AABB {
    this.bounds();
    return this.boundsCache as AABB;
  }

  // -------------------------------------------------------------------------
  // 問い合わせ
  // -------------------------------------------------------------------------

  raycast(origin: Vec3, dir: Vec3, maxDist: number): RayHit | null {
    // maxDist=0 でも原点が内部なら t=0 を返す（負や NaN は null）。非有限の原点/方向は null
    if (!(maxDist >= 0)) return null;
    if (!isFiniteVec3(origin) || !isFiniteVec3(dir)) return null;
    if (!Number.isFinite(maxDist)) maxDist = 1e7;
    if (this.nodes.size === 0) return null;
    let best: RayHit | null = null;
    const stamp = ++this.stamp;
    const test = (n: Node): void => {
      const h = rayAABB(origin, dir, n.entry.box, maxDist);
      if (h && (best === null || h.t < best.t)) {
        best = makeHit(h.t, [origin[0] + dir[0] * h.t, origin[1] + dir[1] * h.t, origin[2] + dir[2] * h.t], h.normal, n);
      }
    };
    for (const n of this.largeNodes) {
      n.stamp = stamp;
      test(n);
    }
    // maxDist=0 のときは起こり得る衝突は t=0 のみ（invMax=0 で最初のセルの後に打ち切る）
    const invMax = maxDist > 0 ? 1 / maxDist : 0;
    this.walkCells(
      origin[0],
      origin[2],
      origin[0] + dir[0] * maxDist,
      origin[2] + dir[2] * maxDist,
      0,
      (ix, iz) => {
        const list = this.cells.get(cellKey(ix, iz));
        if (!list) return;
        for (let i = 0; i < list.length; i++) {
          const n = list[i];
          if (n.stamp === stamp) continue;
          n.stamp = stamp;
          test(n);
        }
      },
      (tExit) => best !== null && (best as RayHit).t * invMax <= tExit,
    );
    return best;
  }

  /**
   * 線分 a→b が遮蔽物と交差するか。境界は閉じている（面に沿って滑る・辺をかすめる・終点が面に
   * 触れる線分も遮蔽扱い）: LOS としては保守的で、隣接 2 箱の継ぎ目平面に沿う線分も通さない。
   * 非有限の端点があれば false（遮蔽なし）
   */
  segmentBlocked(a: Vec3, b: Vec3): boolean {
    if (this.nodes.size === 0) return false;
    if (!isFiniteVec3(a) || !isFiniteVec3(b)) return false;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const dz = b[2] - a[2];
    for (const n of this.largeNodes) {
      if (slabIntersect(a[0], a[1], a[2], dx, dy, dz, n.minX, n.minY, n.minZ, n.maxX, n.maxY, n.maxZ, 1) !== null) return true;
    }
    const stamp = ++this.stamp;
    let blocked = false;
    this.walkCells(
      a[0],
      a[2],
      b[0],
      b[2],
      0,
      (ix, iz) => {
        if (blocked) return;
        const list = this.cells.get(cellKey(ix, iz));
        if (!list) return;
        for (let i = 0; i < list.length; i++) {
          const n = list[i];
          if (n.stamp === stamp) continue;
          n.stamp = stamp;
          if (slabIntersect(a[0], a[1], a[2], dx, dy, dz, n.minX, n.minY, n.minZ, n.maxX, n.maxY, n.maxZ, 1) !== null) {
            blocked = true;
            return;
          }
        }
      },
      () => blocked,
    );
    return blocked;
  }

  sweepSphere(a: Vec3, b: Vec3, radius: number): RayHit | null {
    if (this.nodes.size === 0) return null;
    if (!isFiniteVec3(a) || !isFiniteVec3(b)) return null;
    const r = radius > 0 ? radius : 0;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const dz = b[2] - a[2];
    let best: RayHit | null = null;
    const test = (n: Node): void => {
      const h = slabIntersect(a[0], a[1], a[2], dx, dy, dz, n.minX - r, n.minY - r, n.minZ - r, n.maxX + r, n.maxY + r, n.maxZ + r, 1);
      if (h && (best === null || h.t < best.t)) {
        best = makeHit(h.t, [a[0] + dx * h.t, a[1] + dy * h.t, a[2] + dz * h.t], h.normal, n);
      }
    };
    if (r > CELL_SIZE) {
      // 近傍 3×3 では足りない大きさ: 矩形で全候補を集める
      const nodes = this.gatherRect(Math.min(a[0], b[0]) - r, Math.min(a[2], b[2]) - r, Math.max(a[0], b[0]) + r, Math.max(a[2], b[2]) + r);
      for (let i = 0; i < nodes.length; i++) test(nodes[i]);
      return best;
    }
    const stamp = ++this.stamp;
    for (const n of this.largeNodes) {
      n.stamp = stamp;
      test(n);
    }
    this.walkCells(
      a[0],
      a[2],
      b[0],
      b[2],
      r,
      (ix, iz) => {
        const list = this.cells.get(cellKey(ix, iz));
        if (!list) return;
        for (let i = 0; i < list.length; i++) {
          const n = list[i];
          if (n.stamp === stamp) continue;
          n.stamp = stamp;
          test(n);
        }
      },
      (tExit) => best !== null && (best as RayHit).t <= tExit,
    );
    return best;
  }

  moveBox(center: Vec3, halfExtents: Vec3, delta: Vec3): MoveResult {
    const c: Vec3 = [center[0], center[1], center[2]];
    const hx = halfExtents[0];
    const hy = halfExtents[1];
    const hz = halfExtents[2];
    const result: MoveResult = {
      position: c,
      hitNegX: false,
      hitPosX: false,
      hitNegY: false,
      hitPosY: false,
      hitNegZ: false,
      hitPosZ: false,
    };
    const ddx = Number.isFinite(delta[0]) ? delta[0] : 0;
    const ddy = Number.isFinite(delta[1]) ? delta[1] : 0;
    const ddz = Number.isFinite(delta[2]) ? delta[2] : 0;
    if (this.nodes.size === 0) {
      c[0] += ddx;
      c[1] += ddy;
      c[2] += ddz;
      return result;
    }
    // 開始・終了ボックスの XZ 包含矩形（GATHER_PAD だけ拡張）で候補を一度だけ集める。
    // 各軸の移動量は delta を超えず、停止位置に影響する面は掃引範囲の CONTACT_MARGIN 先まで
    const nodes = this.gatherRect(
      Math.min(c[0], c[0] + ddx) - hx - GATHER_PAD,
      Math.min(c[2], c[2] + ddz) - hz - GATHER_PAD,
      Math.max(c[0], c[0] + ddx) + hx + GATHER_PAD,
      Math.max(c[2], c[2] + ddz) + hz + GATHER_PAD,
    );
    const half: Vec3 = [hx, hy, hz];
    const deltas: Vec3 = [ddx, ddy, ddz];
    const order = [1, 0, 2] as const; // Y → X → Z
    for (const axis of order) {
      const d = deltas[axis];
      if (d === 0) continue;
      const j1 = axis === 0 ? 1 : 0;
      const j2 = axis === 2 ? 1 : 2;
      const lo1 = c[j1] - half[j1];
      const hi1 = c[j1] + half[j1];
      const lo2 = c[j2] - half[j2];
      const hi2 = c[j2] + half[j2];
      const lo = c[axis] - half[axis];
      const hi = c[axis] + half[axis];
      let move = d;
      let hit = false;
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        const bmin = n.entry.box.min;
        const bmax = n.entry.box.max;
        // 他の 2 軸で厳密に重なっていなければ無関係
        if (!(lo1 < bmax[j1] && hi1 > bmin[j1] && lo2 < bmax[j2] && hi2 > bmin[j2])) continue;
        const nmin = bmin[axis];
        const nmax = bmax[axis];
        // 移動軸で既に重なっているものは無視（押し出さない）
        if (lo < nmax && hi > nmin) continue;
        if (d > 0) {
          if (nmin < hi) continue; // 後方
          const allowed = nmin - hi - CONTACT_MARGIN;
          if (allowed < move) {
            move = allowed > 0 ? allowed : 0;
            hit = true;
          }
        } else {
          if (nmax > lo) continue; // 後方
          const allowed = lo - nmax - CONTACT_MARGIN;
          if (allowed < -move) {
            move = allowed > 0 ? -allowed : 0;
            hit = true;
          }
        }
      }
      c[axis] += move;
      if (hit) {
        if (axis === 0) {
          if (d > 0) result.hitPosX = true;
          else result.hitNegX = true;
        } else if (axis === 1) {
          if (d > 0) result.hitPosY = true;
          else result.hitNegY = true;
        } else if (d > 0) result.hitPosZ = true;
        else result.hitNegZ = true;
      }
    }
    return result;
  }

  boxOverlaps(center: Vec3, halfExtents: Vec3): boolean {
    if (this.nodes.size === 0) return false;
    const minX = center[0] - halfExtents[0];
    const minY = center[1] - halfExtents[1];
    const minZ = center[2] - halfExtents[2];
    const maxX = center[0] + halfExtents[0];
    const maxY = center[1] + halfExtents[1];
    const maxZ = center[2] + halfExtents[2];
    const nodes = this.gatherRect(minX, minZ, maxX, maxZ);
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (minX < n.maxX && maxX > n.minX && minY < n.maxY && maxY > n.minY && minZ < n.maxZ && maxZ > n.minZ) return true;
    }
    return false;
  }
}

/** types.ts の CollisionWorld を完全実装した衝突ワールドを生成する */
export function createCollisionWorld(): CollisionWorld {
  return new GridCollisionWorld();
}
