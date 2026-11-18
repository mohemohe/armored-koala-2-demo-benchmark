// 静的・動的AABBによる衝突ワールド。XZ一様グリッドで広域判定を行う。
import type { V3 } from '../math';

export interface WBox {
  min: V3;
  max: V3;
  /** false の場合は衝突しない（開放済み隔壁など） */
  active: boolean;
  /** 隔壁やゲートのID（静的ボックスは null） */
  tag: string | null;
}

export interface RayHit {
  t: number;
  box: WBox;
  normal: V3;
}

const EPS = 1e-7;

export class CollisionWorld {
  boxes: WBox[] = [];
  private cellSize = 8;
  private ox = 0;
  private oz = 0;
  private nx = 1;
  private nz = 1;
  private cells: number[][] = [];
  private stamp: Uint32Array = new Uint32Array(0);
  private stampId = 1;

  constructor(boxes: WBox[], cellSize = 8) {
    this.boxes = boxes;
    this.cellSize = cellSize;
    this.rebuild();
  }

  rebuild() {
    let x0 = Infinity,
      z0 = Infinity,
      x1 = -Infinity,
      z1 = -Infinity;
    for (const b of this.boxes) {
      x0 = Math.min(x0, b.min[0]);
      z0 = Math.min(z0, b.min[2]);
      x1 = Math.max(x1, b.max[0]);
      z1 = Math.max(z1, b.max[2]);
    }
    if (!Number.isFinite(x0)) {
      x0 = z0 = -10;
      x1 = z1 = 10;
    }
    const cs = this.cellSize;
    this.ox = Math.floor(x0 / cs) * cs - cs;
    this.oz = Math.floor(z0 / cs) * cs - cs;
    this.nx = Math.ceil((x1 - this.ox) / cs) + 2;
    this.nz = Math.ceil((z1 - this.oz) / cs) + 2;
    this.cells = new Array(this.nx * this.nz);
    for (let i = 0; i < this.cells.length; i++) this.cells[i] = [];
    this.boxes.forEach((b, i) => {
      const [cx0, cz0] = this.cellOf(b.min[0], b.min[2]);
      const [cx1, cz1] = this.cellOf(b.max[0], b.max[2]);
      for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) this.cells[cz * this.nx + cx].push(i);
    });
    this.stamp = new Uint32Array(this.boxes.length);
  }

  private cellOf(x: number, z: number): [number, number] {
    const cs = this.cellSize;
    let cx = Math.floor((x - this.ox) / cs);
    let cz = Math.floor((z - this.oz) / cs);
    cx = cx < 0 ? 0 : cx >= this.nx ? this.nx - 1 : cx;
    cz = cz < 0 ? 0 : cz >= this.nz ? this.nz - 1 : cz;
    return [cx, cz];
  }

  private nextStamp() {
    this.stampId++;
    if (this.stampId >= 0xfffffff0) {
      this.stamp.fill(0);
      this.stampId = 1;
    }
    return this.stampId;
  }

  /** AABB と重なる有効ボックスを列挙（境界接触は含まない） */
  queryAABB(min: V3, max: V3, cb: (b: WBox) => boolean | void) {
    const s = this.nextStamp();
    const [cx0, cz0] = this.cellOf(min[0], min[2]);
    const [cx1, cz1] = this.cellOf(max[0], max[2]);
    for (let cz = cz0; cz <= cz1; cz++)
      for (let cx = cx0; cx <= cx1; cx++) {
        const list = this.cells[cz * this.nx + cx];
        for (let k = 0; k < list.length; k++) {
          const i = list[k];
          if (this.stamp[i] === s) continue;
          this.stamp[i] = s;
          const b = this.boxes[i];
          if (!b.active) continue;
          if (
            b.min[0] < max[0] &&
            b.max[0] > min[0] &&
            b.min[1] < max[1] &&
            b.max[1] > min[1] &&
            b.min[2] < max[2] &&
            b.max[2] > min[2]
          ) {
            if (cb(b) === true) return;
          }
        }
      }
  }

  overlapsAny(min: V3, max: V3): boolean {
    let hit = false;
    this.queryAABB(min, max, () => {
      hit = true;
      return true;
    });
    return hit;
  }

  /** 光線と箱。o は始点、d は方向（正規化不要）、[0, maxT] で最初の交差を返す */
  static rayBox(o: V3, d: V3, b: WBox, maxT: number): { t: number; axis: number; sign: number } | null {
    let tmin = 0;
    let tmax = maxT;
    let axis = -1;
    let sign = 0;
    for (let a = 0; a < 3; a++) {
      const da = d[a];
      if (Math.abs(da) < 1e-12) {
        if (o[a] <= b.min[a] || o[a] >= b.max[a]) return null;
      } else {
        const inv = 1 / da;
        let t1 = (b.min[a] - o[a]) * inv;
        let t2 = (b.max[a] - o[a]) * inv;
        let s = -1;
        if (t1 > t2) {
          const tmp = t1;
          t1 = t2;
          t2 = tmp;
          s = 1;
        }
        if (t1 > tmin) {
          tmin = t1;
          axis = a;
          sign = s;
        }
        if (t2 < tmax) tmax = t2;
        if (tmin > tmax) return null;
      }
    }
    return { t: tmin, axis, sign };
  }

  /** 光線判定（DDA）。d は正規化済みであること。 */
  raycast(o: V3, d: V3, maxT: number, filter?: (b: WBox) => boolean): RayHit | null {
    const cs = this.cellSize;
    const gx0 = this.ox,
      gz0 = this.oz,
      gx1 = this.ox + this.nx * cs,
      gz1 = this.oz + this.nz * cs;
    // 2Dスラブでグリッド範囲へクリップ
    let t0 = 0,
      t1 = maxT;
    if (Math.abs(d[0]) < 1e-12) {
      if (o[0] < gx0 || o[0] > gx1) return null;
    } else {
      let a = (gx0 - o[0]) / d[0],
        b = (gx1 - o[0]) / d[0];
      if (a > b) [a, b] = [b, a];
      t0 = Math.max(t0, a);
      t1 = Math.min(t1, b);
    }
    if (Math.abs(d[2]) < 1e-12) {
      if (o[2] < gz0 || o[2] > gz1) return null;
    } else {
      let a = (gz0 - o[2]) / d[2],
        b = (gz1 - o[2]) / d[2];
      if (a > b) [a, b] = [b, a];
      t0 = Math.max(t0, a);
      t1 = Math.min(t1, b);
    }
    if (t0 > t1) return null;

    const px = o[0] + d[0] * t0;
    const pz = o[2] + d[2] * t0;
    let [cx, cz] = this.cellOf(px, pz);
    const stepX = d[0] > 0 ? 1 : -1;
    const stepZ = d[2] > 0 ? 1 : -1;
    const tDeltaX = Math.abs(d[0]) < 1e-12 ? Infinity : cs / Math.abs(d[0]);
    const tDeltaZ = Math.abs(d[2]) < 1e-12 ? Infinity : cs / Math.abs(d[2]);
    let tMaxX =
      Math.abs(d[0]) < 1e-12
        ? Infinity
        : ((stepX > 0 ? gx0 + (cx + 1) * cs : gx0 + cx * cs) - o[0]) / d[0];
    let tMaxZ =
      Math.abs(d[2]) < 1e-12
        ? Infinity
        : ((stepZ > 0 ? gz0 + (cz + 1) * cs : gz0 + cz * cs) - o[2]) / d[2];

    const s = this.nextStamp();
    let best: RayHit | null = null;
    let bestT = maxT;
    for (let iter = 0; iter < 100000; iter++) {
      const list = this.cells[cz * this.nx + cx];
      for (let k = 0; k < list.length; k++) {
        const i = list[k];
        if (this.stamp[i] === s) continue;
        this.stamp[i] = s;
        const b = this.boxes[i];
        if (!b.active) continue;
        if (filter && !filter(b)) continue;
        const h = CollisionWorld.rayBox(o, d, b, bestT);
        if (h && h.t <= bestT) {
          bestT = h.t;
          const n: [number, number, number] = [0, 0, 0];
          if (h.axis >= 0) n[h.axis] = h.sign;
          best = { t: h.t, box: b, normal: n };
        }
      }
      const cellExit = Math.min(tMaxX, tMaxZ);
      if (best && bestT <= cellExit) break;
      if (cellExit > t1) break;
      if (tMaxX < tMaxZ) {
        cx += stepX;
        tMaxX += tDeltaX;
        if (cx < 0 || cx >= this.nx) break;
      } else {
        cz += stepZ;
        tMaxZ += tDeltaZ;
        if (cz < 0 || cz >= this.nz) break;
      }
    }
    return best;
  }

  /** a→b の線分が遮蔽されているか */
  segmentBlocked(a: V3, b: V3): boolean {
    const dx = b[0] - a[0],
      dy = b[1] - a[1],
      dz = b[2] - a[2];
    const L = Math.hypot(dx, dy, dz);
    if (L < 1e-9) return false;
    const d: V3 = [dx / L, dy / L, dz / L];
    return this.raycast(a, d, L) !== null;
  }

  /**
   * AABB（中心 x,z・足元 y、半幅 hw、高さ h）を1軸だけ移動させる。
   * 戻り値は実際の移動量。連続判定のため高速でもすり抜けない。
   */
  sweepAxis(pos: V3, hw: number, h: number, axis: 0 | 1 | 2, delta: number): number {
    if (delta === 0) return 0;
    const min: V3 = [pos[0] - hw, pos[1], pos[2] - hw];
    const max: V3 = [pos[0] + hw, pos[1] + h, pos[2] + hw];
    const qmin: V3 = [min[0], min[1], min[2]];
    const qmax: V3 = [max[0], max[1], max[2]];
    if (delta > 0) qmax[axis] += delta;
    else qmin[axis] += delta;
    let allowed = delta;
    const skin = 1e-4;
    this.queryAABB(qmin, qmax, (b) => {
      // 他の2軸で重なっているか
      for (let a = 0; a < 3; a++) {
        if (a === axis) continue;
        if (!(b.min[a] < max[a] - EPS && b.max[a] > min[a] + EPS)) return;
      }
      if (delta > 0) {
        if (b.min[axis] >= max[axis] - 1e-5) {
          const lim = b.min[axis] - max[axis] - skin;
          if (lim < allowed) allowed = Math.max(0, lim);
        }
      } else {
        if (b.max[axis] <= min[axis] + 1e-5) {
          const lim = b.max[axis] - min[axis] + skin;
          if (lim > allowed) allowed = Math.min(0, lim);
        }
      }
    });
    pos[axis] += allowed;
    return allowed;
  }

  /** 足元直下 dist 以内に支持面があるか */
  hasSupport(pos: V3, hw: number, dist = 0.02): boolean {
    return this.overlapsAny([pos[0] - hw + 0.01, pos[1] - dist, pos[2] - hw + 0.01], [
      pos[0] + hw - 0.01,
      pos[1] - 1e-6,
      pos[2] + hw - 0.01,
    ]);
  }

  /** 指定位置の直下の地面高さ（maxDrop以内）。無ければ null */
  groundBelow(x: number, y: number, z: number, hw: number, maxDrop: number): number | null {
    let best: number | null = null;
    this.queryAABB([x - hw, y - maxDrop, z - hw], [x + hw, y + 0.01, z + hw], (b) => {
      if (b.max[1] <= y + 0.01 && (best === null || b.max[1] > best)) best = b.max[1];
    });
    return best;
  }
}
