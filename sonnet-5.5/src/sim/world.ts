/**
 * Static collision world made of AABBs (walls, floors, crates, barriers...).
 *
 * Every box is stored in a bounding-volume hierarchy (binned-SAH build, flat typed arrays). Boxes can be
 * switched on/off at run time (barriers opening): the tree always contains every box, each node keeps a
 * count of its enabled boxes, and queries skip empty subtrees / disabled boxes.
 *
 * Conventions (identical to the original linear-scan reference implementation):
 *  - raycast / segmentBlocked / sweepSphere treat boxes as closed sets. A ray that is exactly parallel to a face
 *    (|d| < 1e-15) and within 1e-7 of that face counts as a MISS (so sliding along a face is never blocked).
 *  - sweepAABB: touching is not a hit for motion away from / parallel to the face, motion into a touching face
 *    hits at t = 0.
 *  - Boxes with non-finite coordinates or min > max are never solid (they are left out of the index).
 *  - Query arguments containing NaN / Infinity return "no hit" instead of fabricating NaN results.
 *  - The box coordinates are copied at construction: mutating `boxes` afterwards is not supported.
 */
import type { BoxDef, IWorld, RayHit, SweepHit, V3 } from './types';

/** distance within which a face counts as "touching" (sliding / resting contact) */
const EPS_TOUCH = 1e-7;
/** |direction component| below this is treated as exactly parallel to the slab */
const PAR_EPS = 1e-15;
const LEAF_MAX = 4;
const SAH_BINS = 16;
/** below this depth SAH splits are used, deeper levels fall back to median splits (bounds the tree depth) */
const SAH_MAX_DEPTH = 32;

// ---------------------------------------------------------------------------------------------
// module-level scratch results (queries are synchronous and never nested)
// ---------------------------------------------------------------------------------------------
let S_tn = 0; // slab entry
let S_tf = 0; // slab exit
let S_ax = -1; // entry axis (-1: no non-parallel axis)
let S_sg = 0; // sign of the entry face normal
let H_s = 0; // hit parameter
let H_ax = 0; // hit normal axis (-1: use H_n*)
let H_sg = 0;
let H_nx = 0;
let H_ny = 0;
let H_nz = 0;
const BP = new Float64Array(10); // breakpoints for the rounded-box solver

/**
 * Ray/segment vs AABB slab test (o + t*d). Parallel axes touching (within EPS_TOUCH of the boundary) MISS.
 * Writes S_tn / S_tf / S_ax / S_sg. `pe` is the |d| threshold under which an axis is considered parallel.
 */
function slabBox(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  pe: number,
  mnx: number, mny: number, mnz: number,
  mxx: number, mxy: number, mxz: number,
): boolean {
  let tn = -Infinity;
  let tf = Infinity;
  let ax = -1;
  let sg = 0;
  if (Math.abs(dx) < pe) {
    if (ox <= mnx + EPS_TOUCH || ox >= mxx - EPS_TOUCH) return false;
  } else {
    let t1 = (mnx - ox) / dx;
    let t2 = (mxx - ox) / dx;
    let s = -1;
    if (t1 > t2) {
      const t = t1;
      t1 = t2;
      t2 = t;
      s = 1;
    }
    if (t1 > tn) {
      tn = t1;
      ax = 0;
      sg = s;
    }
    if (t2 < tf) tf = t2;
    if (tn > tf) return false;
  }
  if (Math.abs(dy) < pe) {
    if (oy <= mny + EPS_TOUCH || oy >= mxy - EPS_TOUCH) return false;
  } else {
    let t1 = (mny - oy) / dy;
    let t2 = (mxy - oy) / dy;
    let s = -1;
    if (t1 > t2) {
      const t = t1;
      t1 = t2;
      t2 = t;
      s = 1;
    }
    if (t1 > tn) {
      tn = t1;
      ax = 1;
      sg = s;
    }
    if (t2 < tf) tf = t2;
    if (tn > tf) return false;
  }
  if (Math.abs(dz) < pe) {
    if (oz <= mnz + EPS_TOUCH || oz >= mxz - EPS_TOUCH) return false;
  } else {
    let t1 = (mnz - oz) / dz;
    let t2 = (mxz - oz) / dz;
    let s = -1;
    if (t1 > t2) {
      const t = t1;
      t1 = t2;
      t2 = t;
      s = 1;
    }
    if (t1 > tn) {
      tn = t1;
      ax = 2;
      sg = s;
    }
    if (t2 < tf) tf = t2;
    if (tn > tf) return false;
  }
  S_tn = tn;
  S_tf = tf;
  S_ax = ax;
  S_sg = sg;
  return true;
}

/**
 * Conservative node test (bounds inflated by ex/ey/ez). Returns the entry parameter (may be negative / -Infinity)
 * or +Infinity when the node cannot contain a hit. Uses the same arithmetic as slabBox, so a box that passes
 * slabBox always passes the tests of all its ancestors.
 */
function nodeEntry(
  nb: Float64Array, b: number,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  parx: boolean, pary: boolean, parz: boolean,
  ex: number, ey: number, ez: number,
  strictEnd: boolean,
): number {
  let tn = -Infinity;
  let tf = Infinity;
  if (parx) {
    if (ox < nb[b] - ex || ox > nb[b + 3] + ex) return Infinity;
  } else {
    let t1 = (nb[b] - ex - ox) / dx;
    let t2 = (nb[b + 3] + ex - ox) / dx;
    if (t1 > t2) {
      const t = t1;
      t1 = t2;
      t2 = t;
    }
    if (t1 > tn) tn = t1;
    if (t2 < tf) tf = t2;
  }
  if (pary) {
    if (oy < nb[b + 1] - ey || oy > nb[b + 4] + ey) return Infinity;
  } else {
    let t1 = (nb[b + 1] - ey - oy) / dy;
    let t2 = (nb[b + 4] + ey - oy) / dy;
    if (t1 > t2) {
      const t = t1;
      t1 = t2;
      t2 = t;
    }
    if (t1 > tn) tn = t1;
    if (t2 < tf) tf = t2;
  }
  if (parz) {
    if (oz < nb[b + 2] - ez || oz > nb[b + 5] + ez) return Infinity;
  } else {
    let t1 = (nb[b + 2] - ez - oz) / dz;
    let t2 = (nb[b + 5] + ez - oz) / dz;
    if (t1 > t2) {
      const t = t1;
      t1 = t2;
      t2 = t;
    }
    if (t1 > tn) tn = t1;
    if (t2 < tf) tf = t2;
  }
  if (tn > tf) return Infinity;
  if (tf < 0 || (strictEnd && tf === 0)) return Infinity;
  return tn;
}

/**
 * Start of an AABB sweep inside the (Minkowski-inflated) box. Blocks only motion that goes deeper:
 *  - if the start is within EPS_TOUCH of some face (resting contact) the box blocks only when EVERY such touching
 *    axis moves further in; moving away from / along any touching face slides free (same as an exact contact);
 *  - otherwise (deep overlap) only motion deeper along the minimum-penetration axis blocks.
 * Sets H_ax / H_sg (outward normal of the blocking face) and returns true when blocked.
 */
function aabbInside(
  cx: number, cy: number, cz: number,
  dx: number, dy: number, dz: number,
  minx: number, miny: number, minz: number,
  maxx: number, maxy: number, maxz: number,
): boolean {
  const x0 = cx - minx;
  const x1 = maxx - cx;
  const y0 = cy - miny;
  const y1 = maxy - cy;
  const z0 = cz - minz;
  const z1 = maxz - cz;
  const penX = x0 < x1 ? x0 : x1;
  const penY = y0 < y1 ? y0 : y1;
  const penZ = z0 < z1 ? z0 : z1;
  const sgX = x0 < x1 ? -1 : 1;
  const sgY = y0 < y1 ? -1 : 1;
  const sgZ = z0 < z1 ? -1 : 1;
  if (penX <= EPS_TOUCH || penY <= EPS_TOUCH || penZ <= EPS_TOUCH) {
    let ax = -1;
    let sg = 0;
    let best = 0;
    if (penX <= EPS_TOUCH) {
      const v = -dx * sgX;
      if (!(v > PAR_EPS)) return false;
      best = v;
      ax = 0;
      sg = sgX;
    }
    if (penY <= EPS_TOUCH) {
      const v = -dy * sgY;
      if (!(v > PAR_EPS)) return false;
      if (v > best) {
        best = v;
        ax = 1;
        sg = sgY;
      }
    }
    if (penZ <= EPS_TOUCH) {
      const v = -dz * sgZ;
      if (!(v > PAR_EPS)) return false;
      if (v > best) {
        best = v;
        ax = 2;
        sg = sgZ;
      }
    }
    H_ax = ax;
    H_sg = sg;
    return true;
  }
  let ax = 0;
  let pen = penX;
  if (penY < pen) {
    ax = 1;
    pen = penY;
  }
  if (penZ < pen) ax = 2;
  const sg = ax === 0 ? sgX : ax === 1 ? sgY : sgZ;
  const dd = ax === 0 ? dx : ax === 1 ? dy : dz;
  if (dd * sg >= 0) return false; // moving out
  H_ax = ax;
  H_sg = sg;
  return true;
}

/**
 * Per-box AABB sweep. `min*`/`max*` are the box bounds already inflated by the sweeping half extents.
 * On a hit sets H_s (0..1), H_ax, H_sg.
 */
function aabbBoxHit(
  cx: number, cy: number, cz: number,
  dx: number, dy: number, dz: number,
  minx: number, miny: number, minz: number,
  maxx: number, maxy: number, maxz: number,
): boolean {
  if (!slabBox(cx, cy, cz, dx, dy, dz, PAR_EPS, minx, miny, minz, maxx, maxy, maxz)) return false;
  if (S_tf <= 0 || S_tn > 1) return false;
  if (S_tn < 0) {
    if (!aabbInside(cx, cy, cz, dx, dy, dz, minx, miny, minz, maxx, maxy, maxz)) return false;
    H_s = 0;
    return true;
  }
  H_s = S_tn > 0 ? S_tn : 0;
  H_ax = S_ax;
  H_sg = S_sg;
  return true;
}

/** squared distance from p to the box */
function distSqToBox(
  px: number, py: number, pz: number,
  mnx: number, mny: number, mnz: number,
  mxx: number, mxy: number, mxz: number,
): number {
  const qx = px < mnx ? mnx - px : px > mxx ? px - mxx : 0;
  const qy = py < mny ? mny - py : py > mxy ? py - mxy : 0;
  const qz = pz < mnz ? mnz - pz : pz > mxz ? pz - mxz : 0;
  return qx * qx + qy * qy + qz * qz;
}

/** outward normal of the rounded box at p (p - closest point on the box), written to H_n*. Returns false if p is inside the box */
function roundedNormal(
  px: number, py: number, pz: number,
  mnx: number, mny: number, mnz: number,
  mxx: number, mxy: number, mxz: number,
): boolean {
  const vx = px < mnx ? px - mnx : px > mxx ? px - mxx : 0;
  const vy = py < mny ? py - mny : py > mxy ? py - mxy : 0;
  const vz = pz < mnz ? pz - mnz : pz > mxz ? pz - mxz : 0;
  const l = Math.sqrt(vx * vx + vy * vy + vz * vz);
  if (!(l > 1e-12)) return false;
  H_nx = vx / l;
  H_ny = vy / l;
  H_nz = vz / l;
  return true;
}

/**
 * First s in [s0, s1] with dist(a + d*s, box) <= r, or NaN. Exact: dist^2 is piecewise quadratic in s with
 * breakpoints where a coordinate crosses the box faces; the first root over the convex function is found interval by interval.
 */
function roundedEntry(
  ax: number, ay: number, az: number,
  dx: number, dy: number, dz: number,
  r: number,
  mnx: number, mny: number, mnz: number,
  mxx: number, mxy: number, mxz: number,
  s0: number, s1: number,
): number {
  let nb = 0;
  BP[nb++] = s0;
  if (Math.abs(dx) >= PAR_EPS) {
    const a = (mnx - ax) / dx;
    const b = (mxx - ax) / dx;
    if (a > s0 && a < s1) BP[nb++] = a;
    if (b > s0 && b < s1) BP[nb++] = b;
  }
  if (Math.abs(dy) >= PAR_EPS) {
    const a = (mny - ay) / dy;
    const b = (mxy - ay) / dy;
    if (a > s0 && a < s1) BP[nb++] = a;
    if (b > s0 && b < s1) BP[nb++] = b;
  }
  if (Math.abs(dz) >= PAR_EPS) {
    const a = (mnz - az) / dz;
    const b = (mxz - az) / dz;
    if (a > s0 && a < s1) BP[nb++] = a;
    if (b > s0 && b < s1) BP[nb++] = b;
  }
  BP[nb++] = s1;
  for (let i = 1; i < nb; i++) {
    const v = BP[i];
    let j = i - 1;
    while (j >= 0 && BP[j] > v) {
      BP[j + 1] = BP[j];
      j--;
    }
    BP[j + 1] = v;
  }
  const rr = r * r;
  for (let k = 0; k + 1 < nb; k++) {
    const lo = BP[k];
    const hi = BP[k + 1];
    const mid = 0.5 * (lo + hi);
    // f(s) = A s^2 + B s + C - rr, over the axes on which the sphere centre is outside the box slab
    let A = 0;
    let B = 0;
    let C = -rr;
    let p = ax + dx * mid;
    if (p < mnx) {
      const c = mnx - ax;
      A += dx * dx;
      B -= 2 * c * dx;
      C += c * c;
    } else if (p > mxx) {
      const c = ax - mxx;
      A += dx * dx;
      B += 2 * c * dx;
      C += c * c;
    }
    p = ay + dy * mid;
    if (p < mny) {
      const c = mny - ay;
      A += dy * dy;
      B -= 2 * c * dy;
      C += c * c;
    } else if (p > mxy) {
      const c = ay - mxy;
      A += dy * dy;
      B += 2 * c * dy;
      C += c * c;
    }
    p = az + dz * mid;
    if (p < mnz) {
      const c = mnz - az;
      A += dz * dz;
      B -= 2 * c * dz;
      C += c * c;
    } else if (p > mxz) {
      const c = az - mxz;
      A += dz * dz;
      B += 2 * c * dz;
      C += c * c;
    }
    if (A < 1e-30) {
      if (C <= 0) return lo;
      continue;
    }
    const disc = B * B - 4 * A * C;
    if (disc < 0) continue;
    const sq = Math.sqrt(disc);
    const q = -0.5 * (B + (B >= 0 ? sq : -sq));
    let sa = q / A;
    let sb = q !== 0 ? C / q : sa;
    if (sa > sb) {
      const t = sa;
      sa = sb;
      sb = t;
    }
    const tol = 1e-12;
    if (sb < lo - tol || sa > hi + tol) continue;
    let s = sa < lo ? lo : sa;
    if (s > hi) s = hi;
    return s;
  }
  return NaN;
}

/**
 * Per-box sphere sweep against the exact rounded box (box Minkowski-summed with a ball of radius r).
 * On a hit sets H_s (0..1) and either H_ax/H_sg (flat face) or H_ax = -1 with H_n* (rounded edge/corner or embedded start).
 */
function sphereBoxHit(
  ax: number, ay: number, az: number,
  dx: number, dy: number, dz: number,
  r: number,
  mnx: number, mny: number, mnz: number,
  mxx: number, mxy: number, mxz: number,
): boolean {
  if (!slabBox(ax, ay, az, dx, dy, dz, PAR_EPS, mnx - r, mny - r, mnz - r, mxx + r, mxy + r, mxz + r)) return false;
  if (S_tf < 0 || S_tn > 1) return false;
  let s0: number;
  if (S_tn < 0) {
    // the start lies inside the inflated AABB
    if (distSqToBox(ax, ay, az, mnx, mny, mnz, mxx, mxy, mxz) <= r * r) {
      H_s = 0;
      if (!roundedNormal(ax, ay, az, mnx, mny, mnz, mxx, mxy, mxz)) {
        const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (l > 1e-12) {
          H_nx = 0 - dx / l;
          H_ny = 0 - dy / l;
          H_nz = 0 - dz / l;
        } else {
          H_nx = 0;
          H_ny = 1;
          H_nz = 0;
        }
      }
      H_ax = -1;
      return true;
    }
    s0 = 0;
  } else {
    // entry through a face of the inflated AABB: flat part of the rounded box unless the entry point is beyond
    // the core box on another axis
    const t = S_tn;
    const px = ax + dx * t;
    const py = ay + dy * t;
    const pz = az + dz * t;
    const k = S_ax;
    let outside = 0;
    if (k !== 0 && (px < mnx || px > mxx)) outside++;
    if (k !== 1 && (py < mny || py > mxy)) outside++;
    if (k !== 2 && (pz < mnz || pz > mxz)) outside++;
    if (outside === 0) {
      H_s = t > 0 ? t : 0;
      H_ax = k;
      H_sg = S_sg;
      return true;
    }
    s0 = t;
  }
  const s1 = S_tf < 1 ? S_tf : 1;
  const s = roundedEntry(ax, ay, az, dx, dy, dz, r, mnx, mny, mnz, mxx, mxy, mxz, s0, s1);
  if (!(s >= 0)) return false;
  H_s = s;
  H_ax = -1;
  if (!roundedNormal(ax + dx * s, ay + dy * s, az + dz * s, mnx, mny, mnz, mxx, mxy, mxz)) {
    // numerically on / inside the core box: fall back to the entry face
    H_ax = S_tn >= 0 ? S_ax : 1;
    H_sg = S_tn >= 0 ? S_sg : 1;
  }
  return true;
}

export class World implements IWorld {
  readonly boxes: readonly BoxDef[];
  private readonly n: number;
  private readonly enabled: Uint8Array;
  private readonly idIndex = new Map<string, number>();

  /** per-box bounds (minx,miny,minz,maxx,maxy,maxz) by original index */
  private readonly bb: Float64Array;
  /** per-box leaf node (-1 when the box is not indexed) */
  private readonly leafOf: Int32Array;

  // BVH (depth-first layout: the left child of node i is i+1)
  private nodeCount = 0;
  private nb: Float64Array = new Float64Array(0);
  /** internal: right child index; leaf: first slot in `order` */
  private nA: Int32Array = new Int32Array(0);
  /** leaf: box count (>0); internal: 0 */
  private nC: Int32Array = new Int32Array(0);
  private nParent: Int32Array = new Int32Array(0);
  /** number of enabled boxes in the subtree */
  private nEn: Int32Array = new Int32Array(0);
  private order: Int32Array = new Int32Array(0);
  private stack: Int32Array = new Int32Array(0);
  private stackT: Float64Array = new Float64Array(0);

  constructor(boxes: readonly BoxDef[]) {
    this.boxes = boxes;
    const n = boxes.length;
    this.n = n;
    this.enabled = new Uint8Array(n).fill(1);
    this.bb = new Float64Array(n * 6);
    this.leafOf = new Int32Array(n).fill(-1);
    for (let i = 0; i < n; i++) this.idIndex.set(boxes[i].id, i);
    this.buildIndex();
  }

  // ------------------------------------------------------------------ build
  private buildIndex(): void {
    const boxes = this.boxes;
    const n = this.n;
    const bb = this.bb;
    const cen = new Float64Array(n * 3);
    const ids = new Int32Array(n);
    let m = 0;
    for (let i = 0; i < n; i++) {
      const b = boxes[i];
      const o = i * 6;
      const a = b.min.x, c = b.min.y, d = b.min.z, e = b.max.x, f = b.max.y, g = b.max.z;
      bb[o] = a;
      bb[o + 1] = c;
      bb[o + 2] = d;
      bb[o + 3] = e;
      bb[o + 4] = f;
      bb[o + 5] = g;
      const sum = a + c + d + e + f + g;
      if (sum - sum !== 0 || a > e || c > f || d > g) continue; // non-finite or inverted: never solid
      cen[i * 3] = 0.5 * (a + e);
      cen[i * 3 + 1] = 0.5 * (c + f);
      cen[i * 3 + 2] = 0.5 * (d + g);
      ids[m++] = i;
    }
    if (m === 0) return;

    const maxNodes = 2 * m;
    const nb = new Float64Array(maxNodes * 6);
    const nA = new Int32Array(maxNodes);
    const nC = new Int32Array(maxNodes);
    const nParent = new Int32Array(maxNodes);
    let nodeCount = 0;
    let maxDepth = 0;

    // binned SAH scratch
    const binCnt = new Int32Array(SAH_BINS);
    const binMin = new Float64Array(SAH_BINS * 3);
    const binMax = new Float64Array(SAH_BINS * 3);
    const leftArea = new Float64Array(SAH_BINS);
    const leftCnt = new Int32Array(SAH_BINS);
    const area = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number => {
      const ex = x1 - x0;
      const ey = y1 - y0;
      const ez = z1 - z0;
      return 2 * (ex * ey + ey * ez + ez * ex);
    };

    const rec = (start: number, end: number, depth: number, parent: number): number => {
      const node = nodeCount++;
      if (depth > maxDepth) maxDepth = depth;
      nParent[node] = parent;
      const nbo = node * 6;
      let bx0 = Infinity, by0 = Infinity, bz0 = Infinity, bx1 = -Infinity, by1 = -Infinity, bz1 = -Infinity;
      let cx0 = Infinity, cy0 = Infinity, cz0 = Infinity, cx1 = -Infinity, cy1 = -Infinity, cz1 = -Infinity;
      for (let k = start; k < end; k++) {
        const id = ids[k];
        const o = id * 6;
        if (bb[o] < bx0) bx0 = bb[o];
        if (bb[o + 1] < by0) by0 = bb[o + 1];
        if (bb[o + 2] < bz0) bz0 = bb[o + 2];
        if (bb[o + 3] > bx1) bx1 = bb[o + 3];
        if (bb[o + 4] > by1) by1 = bb[o + 4];
        if (bb[o + 5] > bz1) bz1 = bb[o + 5];
        const cx = cen[id * 3], cy = cen[id * 3 + 1], cz = cen[id * 3 + 2];
        if (cx < cx0) cx0 = cx;
        if (cy < cy0) cy0 = cy;
        if (cz < cz0) cz0 = cz;
        if (cx > cx1) cx1 = cx;
        if (cy > cy1) cy1 = cy;
        if (cz > cz1) cz1 = cz;
      }
      nb[nbo] = bx0;
      nb[nbo + 1] = by0;
      nb[nbo + 2] = bz0;
      nb[nbo + 3] = bx1;
      nb[nbo + 4] = by1;
      nb[nbo + 5] = bz1;
      const count = end - start;
      const makeLeaf = (): number => {
        nA[node] = start;
        nC[node] = count;
        return node;
      };
      if (count <= 1) return makeLeaf();

      // ---- choose a split
      let mid = -1;
      const cext = [cx1 - cx0, cy1 - cy0, cz1 - cz0];
      const cmin = [cx0, cy0, cz0];
      if (depth < SAH_MAX_DEPTH) {
        const parentArea = area(bx0, by0, bz0, bx1, by1, bz1);
        let bestCost = Infinity;
        let bestAxis = -1;
        let bestSplit = -1;
        for (let axis = 0; axis < 3; axis++) {
          const ext = cext[axis];
          if (!(ext > 1e-12)) continue;
          const lo = cmin[axis];
          const scale = SAH_BINS / ext;
          binCnt.fill(0);
          for (let q = 0; q < SAH_BINS; q++) {
            binMin[q * 3] = binMin[q * 3 + 1] = binMin[q * 3 + 2] = Infinity;
            binMax[q * 3] = binMax[q * 3 + 1] = binMax[q * 3 + 2] = -Infinity;
          }
          for (let k = start; k < end; k++) {
            const id = ids[k];
            let bi = ((cen[id * 3 + axis] - lo) * scale) | 0;
            if (bi >= SAH_BINS) bi = SAH_BINS - 1;
            if (bi < 0) bi = 0;
            binCnt[bi]++;
            const o = id * 6;
            const q3 = bi * 3;
            if (bb[o] < binMin[q3]) binMin[q3] = bb[o];
            if (bb[o + 1] < binMin[q3 + 1]) binMin[q3 + 1] = bb[o + 1];
            if (bb[o + 2] < binMin[q3 + 2]) binMin[q3 + 2] = bb[o + 2];
            if (bb[o + 3] > binMax[q3]) binMax[q3] = bb[o + 3];
            if (bb[o + 4] > binMax[q3 + 1]) binMax[q3 + 1] = bb[o + 4];
            if (bb[o + 5] > binMax[q3 + 2]) binMax[q3 + 2] = bb[o + 5];
          }
          // prefix (left) areas
          let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
          let cnt = 0;
          for (let q = 0; q < SAH_BINS - 1; q++) {
            if (binCnt[q] > 0) {
              cnt += binCnt[q];
              if (binMin[q * 3] < x0) x0 = binMin[q * 3];
              if (binMin[q * 3 + 1] < y0) y0 = binMin[q * 3 + 1];
              if (binMin[q * 3 + 2] < z0) z0 = binMin[q * 3 + 2];
              if (binMax[q * 3] > x1) x1 = binMax[q * 3];
              if (binMax[q * 3 + 1] > y1) y1 = binMax[q * 3 + 1];
              if (binMax[q * 3 + 2] > z1) z1 = binMax[q * 3 + 2];
            }
            leftCnt[q] = cnt;
            leftArea[q] = cnt > 0 ? area(x0, y0, z0, x1, y1, z1) : 0;
          }
          // suffix (right) sweep
          x0 = y0 = z0 = Infinity;
          x1 = y1 = z1 = -Infinity;
          cnt = 0;
          for (let q = SAH_BINS - 1; q >= 1; q--) {
            if (binCnt[q] > 0) {
              cnt += binCnt[q];
              if (binMin[q * 3] < x0) x0 = binMin[q * 3];
              if (binMin[q * 3 + 1] < y0) y0 = binMin[q * 3 + 1];
              if (binMin[q * 3 + 2] < z0) z0 = binMin[q * 3 + 2];
              if (binMax[q * 3] > x1) x1 = binMax[q * 3];
              if (binMax[q * 3 + 1] > y1) y1 = binMax[q * 3 + 1];
              if (binMax[q * 3 + 2] > z1) z1 = binMax[q * 3 + 2];
            }
            const nL = leftCnt[q - 1];
            if (nL === 0 || cnt === 0) continue;
            const cost = leftArea[q - 1] * nL + area(x0, y0, z0, x1, y1, z1) * cnt;
            if (cost < bestCost) {
              bestCost = cost;
              bestAxis = axis;
              bestSplit = q - 1;
            }
          }
        }
        if (bestAxis >= 0) {
          const splitCost = 1 + (parentArea > 0 ? bestCost / parentArea : count);
          if (count <= LEAF_MAX && splitCost >= count) return makeLeaf();
          // partition by bin
          const lo = cmin[bestAxis];
          const scale = SAH_BINS / cext[bestAxis];
          let i = start;
          let j = end - 1;
          while (i <= j) {
            let bi = ((cen[ids[i] * 3 + bestAxis] - lo) * scale) | 0;
            if (bi >= SAH_BINS) bi = SAH_BINS - 1;
            if (bi < 0) bi = 0;
            if (bi <= bestSplit) i++;
            else {
              const t = ids[i];
              ids[i] = ids[j];
              ids[j] = t;
              j--;
            }
          }
          if (i > start && i < end) mid = i;
        }
      }
      if (mid < 0) {
        // median split along the widest centroid axis (also used when SAH is degenerate / too deep)
        let axis = 0;
        if (cext[1] > cext[axis]) axis = 1;
        if (cext[2] > cext[axis]) axis = 2;
        if (count <= 2 && depth < SAH_MAX_DEPTH) return makeLeaf();
        if (cext[axis] > 0) {
          const sub = Array.from(ids.subarray(start, end));
          sub.sort((p, q) => cen[p * 3 + axis] - cen[q * 3 + axis]);
          ids.set(sub, start);
        }
        mid = (start + end) >> 1;
      }
      rec(start, mid, depth + 1, node);
      const right = rec(mid, end, depth + 1, node);
      nA[node] = right;
      nC[node] = 0;
      return node;
    };
    rec(0, m, 0, -1);

    this.nodeCount = nodeCount;
    this.nb = nb.subarray(0, nodeCount * 6);
    this.nA = nA.subarray(0, nodeCount);
    this.nC = nC.subarray(0, nodeCount);
    this.nParent = nParent.subarray(0, nodeCount);
    this.order = ids.subarray(0, m);
    const nEn = new Int32Array(nodeCount);
    for (let i = nodeCount - 1; i >= 0; i--) {
      if (this.nC[i] > 0) {
        nEn[i] = this.nC[i];
        for (let k = this.nA[i]; k < this.nA[i] + this.nC[i]; k++) this.leafOf[this.order[k]] = i;
      } else {
        nEn[i] = nEn[i + 1] + nEn[this.nA[i]];
      }
    }
    this.nEn = nEn;
    this.stack = new Int32Array((maxDepth + 4) * 2);
    this.stackT = new Float64Array((maxDepth + 4) * 2);
  }

  // ------------------------------------------------------------------ enable flags
  setBoxEnabled(index: number, enabled: boolean): void {
    if (!(index >= 0 && index < this.n) || index !== Math.floor(index)) return;
    const v = enabled ? 1 : 0;
    if (this.enabled[index] === v) return;
    this.enabled[index] = v;
    const leaf = this.leafOf[index];
    if (leaf < 0) return;
    const delta = v ? 1 : -1;
    const nEn = this.nEn;
    const nParent = this.nParent;
    for (let nd = leaf; nd >= 0; nd = nParent[nd]) nEn[nd] += delta;
  }
  isBoxEnabled(index: number): boolean {
    return index >= 0 && index < this.n && this.enabled[index] === 1;
  }
  indexOfBox(id: string): number {
    return this.idIndex.get(id) ?? -1;
  }

  // ------------------------------------------------------------------ raycast
  raycast(origin: V3, dir: V3, maxDist: number): RayHit | null {
    const ox = origin.x, oy = origin.y, oz = origin.z;
    const dx = dir.x, dy = dir.y, dz = dir.z;
    const chk = ox + oy + oz + dx + dy + dz;
    if (chk - chk !== 0 || !(maxDist >= 0)) return null;
    if (this.nodeCount === 0) return null;
    const parx = Math.abs(dx) < PAR_EPS;
    const pary = Math.abs(dy) < PAR_EPS;
    const parz = Math.abs(dz) < PAR_EPS;
    const nb = this.nb, nA = this.nA, nC = this.nC, nEn = this.nEn, order = this.order;
    const bb = this.bb, en = this.enabled, stack = this.stack, stackT = this.stackT;

    let bestT = maxDist < 1e30 ? maxDist : 1e30; // maxDist = Infinity means "unbounded"
    let bestIdx = -1;
    let bestTn = 0;
    let bestAx = 0;
    let bestSg = 0;
    let sp = 0;
    if (nEn[0] > 0) {
      const t0 = nodeEntry(nb, 0, ox, oy, oz, dx, dy, dz, parx, pary, parz, 0, 0, 0, false);
      if (t0 <= bestT) {
        stack[0] = 0;
        stackT[0] = t0;
        sp = 1;
      }
    }
    while (sp > 0) {
      sp--;
      if (stackT[sp] > bestT) continue;
      const node = stack[sp];
      const cnt = nC[node];
      if (cnt > 0) {
        const first = nA[node];
        for (let k = first; k < first + cnt; k++) {
          const bi = order[k];
          if (en[bi] === 0) continue;
          const o = bi * 6;
          if (!slabBox(ox, oy, oz, dx, dy, dz, PAR_EPS, bb[o], bb[o + 1], bb[o + 2], bb[o + 3], bb[o + 4], bb[o + 5])) continue;
          if (S_tf < 0) continue;
          const t = S_tn > 0 ? S_tn : 0;
          if (t > bestT || (t === bestT && bestIdx >= 0 && bi > bestIdx)) continue;
          bestT = t;
          bestIdx = bi;
          bestTn = S_tn;
          bestAx = S_ax;
          bestSg = S_sg;
        }
      } else {
        const l = node + 1;
        const r = nA[node];
        const tl = nEn[l] > 0 ? nodeEntry(nb, l * 6, ox, oy, oz, dx, dy, dz, parx, pary, parz, 0, 0, 0, false) : Infinity;
        const tr = nEn[r] > 0 ? nodeEntry(nb, r * 6, ox, oy, oz, dx, dy, dz, parx, pary, parz, 0, 0, 0, false) : Infinity;
        if (tl <= tr) {
          if (tr <= bestT) {
            stack[sp] = r;
            stackT[sp++] = tr;
          }
          if (tl <= bestT) {
            stack[sp] = l;
            stackT[sp++] = tl;
          }
        } else {
          if (tl <= bestT) {
            stack[sp] = l;
            stackT[sp++] = tl;
          }
          if (tr <= bestT) {
            stack[sp] = r;
            stackT[sp++] = tr;
          }
        }
      }
    }
    if (bestIdx < 0) return null;
    let nx = 0, ny = 0, nz = 0;
    if (bestTn < 0) {
      // origin inside the box
      nx = 0 - dx;
      ny = 0 - dy;
      nz = 0 - dz;
      if (nx === 0 && ny === 0 && nz === 0) ny = 1;
    } else if (bestAx === 0) nx = bestSg;
    else if (bestAx === 1) ny = bestSg;
    else nz = bestSg;
    return {
      t: bestT,
      point: { x: ox + dx * bestT, y: oy + dy * bestT, z: oz + dz * bestT },
      normal: { x: nx, y: ny, z: nz },
      boxIndex: bestIdx,
    };
  }

  // ------------------------------------------------------------------ segmentBlocked
  segmentBlocked(a: V3, b: V3): boolean {
    const ox = a.x, oy = a.y, oz = a.z;
    const dx = b.x - ox;
    const dy = b.y - oy;
    const dz = b.z - oz;
    const chk = ox + oy + oz + dx + dy + dz;
    if (chk - chk !== 0) return false;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-9) return this.pointInSolid(a);
    if (this.nodeCount === 0) return false;
    const pe = PAR_EPS * len;
    const parx = Math.abs(dx) < pe;
    const pary = Math.abs(dy) < pe;
    const parz = Math.abs(dz) < pe;
    const nb = this.nb, nA = this.nA, nC = this.nC, nEn = this.nEn, order = this.order;
    const bb = this.bb, en = this.enabled, stack = this.stack;

    let sp = 0;
    if (nEn[0] > 0) {
      const t0 = nodeEntry(nb, 0, ox, oy, oz, dx, dy, dz, parx, pary, parz, 0, 0, 0, false);
      if (t0 <= 1) stack[sp++] = 0;
    }
    while (sp > 0) {
      const node = stack[--sp];
      const cnt = nC[node];
      if (cnt > 0) {
        const first = nA[node];
        for (let k = first; k < first + cnt; k++) {
          const bi = order[k];
          if (en[bi] === 0) continue;
          const o = bi * 6;
          if (!slabBox(ox, oy, oz, dx, dy, dz, pe, bb[o], bb[o + 1], bb[o + 2], bb[o + 3], bb[o + 4], bb[o + 5])) continue;
          if (S_tf < 0 || S_tn > 1) continue;
          return true;
        }
      } else {
        const l = node + 1;
        const r = nA[node];
        const tl = nEn[l] > 0 ? nodeEntry(nb, l * 6, ox, oy, oz, dx, dy, dz, parx, pary, parz, 0, 0, 0, false) : Infinity;
        const tr = nEn[r] > 0 ? nodeEntry(nb, r * 6, ox, oy, oz, dx, dy, dz, parx, pary, parz, 0, 0, 0, false) : Infinity;
        // nearer child is popped first
        if (tl <= tr) {
          if (tr <= 1) stack[sp++] = r;
          if (tl <= 1) stack[sp++] = l;
        } else {
          if (tl <= 1) stack[sp++] = l;
          if (tr <= 1) stack[sp++] = r;
        }
      }
    }
    return false;
  }

  // ------------------------------------------------------------------ sweepSphere
  /**
   * First hit of a sphere swept a→b against the exact rounded boxes (edges and corners are rounded).
   * `t` is the travelled distance, `point` the sphere CENTRE at first contact, `normal` the outward surface normal
   * at the contact point. A start that already touches/overlaps a box hits at t = 0.
   */
  sweepSphere(a: V3, b: V3, radius: number): RayHit | null {
    const ox = a.x, oy = a.y, oz = a.z;
    const dx = b.x - ox;
    const dy = b.y - oy;
    const dz = b.z - oz;
    const chk = ox + oy + oz + dx + dy + dz + radius;
    if (chk - chk !== 0 || !(radius >= 0)) return null;
    if (this.nodeCount === 0) return null;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const parx = Math.abs(dx) < PAR_EPS;
    const pary = Math.abs(dy) < PAR_EPS;
    const parz = Math.abs(dz) < PAR_EPS;
    const nb = this.nb, nA = this.nA, nC = this.nC, nEn = this.nEn, order = this.order;
    const bb = this.bb, en = this.enabled, stack = this.stack, stackT = this.stackT;
    const r = radius;

    let bestS = 1;
    let bestIdx = -1;
    let bAx = 0, bSg = 0, bNx = 0, bNy = 0, bNz = 0;
    let sp = 0;
    if (nEn[0] > 0) {
      const t0 = nodeEntry(nb, 0, ox, oy, oz, dx, dy, dz, parx, pary, parz, r, r, r, false);
      if (t0 <= bestS) {
        stack[0] = 0;
        stackT[0] = t0;
        sp = 1;
      }
    }
    while (sp > 0) {
      sp--;
      if (stackT[sp] > bestS) continue;
      const node = stack[sp];
      const cnt = nC[node];
      if (cnt > 0) {
        const first = nA[node];
        for (let k = first; k < first + cnt; k++) {
          const bi = order[k];
          if (en[bi] === 0) continue;
          const o = bi * 6;
          if (!sphereBoxHit(ox, oy, oz, dx, dy, dz, r, bb[o], bb[o + 1], bb[o + 2], bb[o + 3], bb[o + 4], bb[o + 5])) continue;
          const s = H_s;
          if (s > bestS || (s === bestS && bestIdx >= 0 && bi > bestIdx)) continue;
          bestS = s;
          bestIdx = bi;
          bAx = H_ax;
          bSg = H_sg;
          bNx = H_nx;
          bNy = H_ny;
          bNz = H_nz;
        }
      } else {
        const l = node + 1;
        const rr = nA[node];
        const tl = nEn[l] > 0 ? nodeEntry(nb, l * 6, ox, oy, oz, dx, dy, dz, parx, pary, parz, r, r, r, false) : Infinity;
        const tr = nEn[rr] > 0 ? nodeEntry(nb, rr * 6, ox, oy, oz, dx, dy, dz, parx, pary, parz, r, r, r, false) : Infinity;
        if (tl <= tr) {
          if (tr <= bestS) {
            stack[sp] = rr;
            stackT[sp++] = tr;
          }
          if (tl <= bestS) {
            stack[sp] = l;
            stackT[sp++] = tl;
          }
        } else {
          if (tl <= bestS) {
            stack[sp] = l;
            stackT[sp++] = tl;
          }
          if (tr <= bestS) {
            stack[sp] = rr;
            stackT[sp++] = tr;
          }
        }
      }
    }
    if (bestIdx < 0) return null;
    let nx = bNx, ny = bNy, nz = bNz;
    if (bAx >= 0) {
      nx = 0;
      ny = 0;
      nz = 0;
      if (bAx === 0) nx = bSg;
      else if (bAx === 1) ny = bSg;
      else nz = bSg;
    }
    return {
      t: bestS * len,
      point: { x: ox + dx * bestS, y: oy + dy * bestS, z: oz + dz * bestS },
      normal: { x: nx, y: ny, z: nz },
      boxIndex: bestIdx,
    };
  }

  // ------------------------------------------------------------------ sweepAABB
  sweepAABB(center: V3, half: V3, delta: V3): SweepHit | null {
    const cx = center.x, cy = center.y, cz = center.z;
    const hx = half.x, hy = half.y, hz = half.z;
    const dx = delta.x, dy = delta.y, dz = delta.z;
    const chk = cx + cy + cz + hx + hy + hz + dx + dy + dz;
    if (chk - chk !== 0) return null;
    if (this.nodeCount === 0) return null;
    const parx = Math.abs(dx) < PAR_EPS;
    const pary = Math.abs(dy) < PAR_EPS;
    const parz = Math.abs(dz) < PAR_EPS;
    const nb = this.nb, nA = this.nA, nC = this.nC, nEn = this.nEn, order = this.order;
    const bb = this.bb, en = this.enabled, stack = this.stack, stackT = this.stackT;

    let bestS = 1;
    let bestIdx = -1;
    let bAx = 0, bSg = 0;
    let sp = 0;
    if (nEn[0] > 0) {
      const t0 = nodeEntry(nb, 0, cx, cy, cz, dx, dy, dz, parx, pary, parz, hx, hy, hz, true);
      if (t0 <= bestS) {
        stack[0] = 0;
        stackT[0] = t0;
        sp = 1;
      }
    }
    while (sp > 0) {
      sp--;
      if (stackT[sp] > bestS) continue;
      const node = stack[sp];
      const cnt = nC[node];
      if (cnt > 0) {
        const first = nA[node];
        for (let k = first; k < first + cnt; k++) {
          const bi = order[k];
          if (en[bi] === 0) continue;
          const o = bi * 6;
          if (!aabbBoxHit(cx, cy, cz, dx, dy, dz, bb[o] - hx, bb[o + 1] - hy, bb[o + 2] - hz, bb[o + 3] + hx, bb[o + 4] + hy, bb[o + 5] + hz)) continue;
          const s = H_s;
          if (s > bestS || (s === bestS && bestIdx >= 0 && bi > bestIdx)) continue;
          bestS = s;
          bestIdx = bi;
          bAx = H_ax;
          bSg = H_sg;
        }
      } else {
        const l = node + 1;
        const r = nA[node];
        const tl = nEn[l] > 0 ? nodeEntry(nb, l * 6, cx, cy, cz, dx, dy, dz, parx, pary, parz, hx, hy, hz, true) : Infinity;
        const tr = nEn[r] > 0 ? nodeEntry(nb, r * 6, cx, cy, cz, dx, dy, dz, parx, pary, parz, hx, hy, hz, true) : Infinity;
        if (tl <= tr) {
          if (tr <= bestS) {
            stack[sp] = r;
            stackT[sp++] = tr;
          }
          if (tl <= bestS) {
            stack[sp] = l;
            stackT[sp++] = tl;
          }
        } else {
          if (tl <= bestS) {
            stack[sp] = l;
            stackT[sp++] = tl;
          }
          if (tr <= bestS) {
            stack[sp] = r;
            stackT[sp++] = tr;
          }
        }
      }
    }
    if (bestIdx < 0) return null;
    const n = { x: 0, y: 0, z: 0 };
    if (bAx === 0) n.x = bSg;
    else if (bAx === 1) n.y = bSg;
    else n.z = bSg;
    return { t: bestS, normal: n, boxIndex: bestIdx };
  }

  // ------------------------------------------------------------------ overlap / point
  overlapAABB(center: V3, half: V3, margin = 1e-4): boolean {
    const cx = center.x, cy = center.y, cz = center.z;
    const hx = half.x, hy = half.y, hz = half.z;
    const chk = cx + cy + cz + hx + hy + hz + margin;
    if (chk - chk !== 0) return false;
    if (this.nodeCount === 0) return false;
    const nb = this.nb, nA = this.nA, nC = this.nC, nEn = this.nEn, order = this.order;
    const bb = this.bb, en = this.enabled, stack = this.stack;
    const x1 = cx + hx, y1 = cy + hy, z1 = cz + hz;
    const x0 = cx - hx, y0 = cy - hy, z0 = cz - hz;

    let sp = 0;
    stack[sp++] = 0;
    while (sp > 0) {
      const node = stack[--sp];
      if (nEn[node] === 0) continue;
      const o = node * 6;
      if (
        !(x1 - nb[o] > margin && nb[o + 3] - x0 > margin &&
          y1 - nb[o + 1] > margin && nb[o + 4] - y0 > margin &&
          z1 - nb[o + 2] > margin && nb[o + 5] - z0 > margin)
      ) continue;
      const cnt = nC[node];
      if (cnt > 0) {
        const first = nA[node];
        for (let k = first; k < first + cnt; k++) {
          const bi = order[k];
          if (en[bi] === 0) continue;
          const q = bi * 6;
          if (
            x1 - bb[q] > margin && bb[q + 3] - x0 > margin &&
            y1 - bb[q + 1] > margin && bb[q + 4] - y0 > margin &&
            z1 - bb[q + 2] > margin && bb[q + 5] - z0 > margin
          ) return true;
        }
      } else {
        stack[sp++] = nA[node];
        stack[sp++] = node + 1;
      }
    }
    return false;
  }

  pointInSolid(p: V3): boolean {
    const px = p.x, py = p.y, pz = p.z;
    const chk = px + py + pz;
    if (chk - chk !== 0) return false;
    if (this.nodeCount === 0) return false;
    const nb = this.nb, nA = this.nA, nC = this.nC, nEn = this.nEn, order = this.order;
    const bb = this.bb, en = this.enabled, stack = this.stack;

    let sp = 0;
    stack[sp++] = 0;
    while (sp > 0) {
      const node = stack[--sp];
      if (nEn[node] === 0) continue;
      const o = node * 6;
      if (!(px > nb[o] && px < nb[o + 3] && py > nb[o + 1] && py < nb[o + 4] && pz > nb[o + 2] && pz < nb[o + 5])) continue;
      const cnt = nC[node];
      if (cnt > 0) {
        const first = nA[node];
        for (let k = first; k < first + cnt; k++) {
          const bi = order[k];
          if (en[bi] === 0) continue;
          const q = bi * 6;
          if (px > bb[q] && px < bb[q + 3] && py > bb[q + 1] && py < bb[q + 4] && pz > bb[q + 2] && pz < bb[q + 5]) return true;
        }
      } else {
        stack[sp++] = nA[node];
        stack[sp++] = node + 1;
      }
    }
    return false;
  }
}
