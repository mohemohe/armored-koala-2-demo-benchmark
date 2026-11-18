import { describe, expect, it } from 'vitest';
import { PLAYER } from '../src/config';
import { Rng } from '../src/sim/rng';
import { buildTestArenaStage, createArenaGame } from '../src/sim/testArena';
import type { BoxDef, RayHit, SweepHit, V3 } from '../src/sim/types';
import { World } from '../src/sim/world';

// ---------------------------------------------------------------------------------------------
// Reference implementation: the original O(N) linear scan.
//  - raycast / sweepAABB / overlapAABB / pointInSolid are copied from the original first-cut World unchanged
//    (except that sweepAABB's "start slightly embedded" case is left out of the random comparisons: none occur).
//  - segmentBlocked is the closed-segment slab test in segment parameter space (exact at the end points).
//  - sweepSphere is an independent EXACT rounded-box sweep (3 face boxes + 12 edge cylinders + 8 corner spheres).
// ---------------------------------------------------------------------------------------------
const EPS_TOUCH = 1e-7;

interface SlabResult {
  tNear: number;
  tFar: number;
  axis: number;
  sign: number;
}

function slab(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  minx: number, miny: number, minz: number,
  maxx: number, maxy: number, maxz: number,
  parEps = 1e-15,
): SlabResult | null {
  let tNear = -Infinity;
  let tFar = Infinity;
  let axis = -1;
  let sign = 0;
  const o = [ox, oy, oz];
  const d = [dx, dy, dz];
  const mn = [minx, miny, minz];
  const mx = [maxx, maxy, maxz];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < parEps) {
      if (o[i] <= mn[i] + EPS_TOUCH || o[i] >= mx[i] - EPS_TOUCH) return null;
    } else {
      let t1 = (mn[i] - o[i]) / d[i];
      let t2 = (mx[i] - o[i]) / d[i];
      let s = -1;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
        s = 1;
      }
      if (t1 > tNear) {
        tNear = t1;
        axis = i;
        sign = s;
      }
      if (t2 < tFar) tFar = t2;
      if (tNear > tFar) return null;
    }
  }
  if (axis < 0) return { tNear: -Infinity, tFar: Infinity, axis: 0, sign: 1 };
  return { tNear, tFar, axis, sign };
}

const sq = (x: number): number => x * x;

function refSphereBox(a: V3, d: V3, r: number, b: BoxDef): { s: number; n: V3 } | null {
  const inf = slab(a.x, a.y, a.z, d.x, d.y, d.z, b.min.x - r, b.min.y - r, b.min.z - r, b.max.x + r, b.max.y + r, b.max.z + r);
  if (!inf || inf.tFar < 0 || inf.tNear > 1) return null;
  const A = [a.x, a.y, a.z];
  const D = [d.x, d.y, d.z];
  const mn = [b.min.x, b.min.y, b.min.z];
  const mx = [b.max.x, b.max.y, b.max.z];
  // start inside the rounded box (closed)
  const cp = A.map((v, i) => Math.min(mx[i], Math.max(mn[i], v)));
  const off = A.map((v, i) => v - cp[i]);
  const dist2 = off[0] * off[0] + off[1] * off[1] + off[2] * off[2];
  if (dist2 <= r * r) {
    const dist = Math.sqrt(dist2);
    const dl = Math.hypot(D[0], D[1], D[2]);
    let n: V3;
    if (dist > 1e-12) n = { x: off[0] / dist, y: off[1] / dist, z: off[2] / dist };
    else if (dl > 1e-12) n = { x: 0 - D[0] / dl, y: 0 - D[1] / dl, z: 0 - D[2] / dl };
    else n = { x: 0, y: 1, z: 0 };
    return { s: 0, n };
  }
  let best = Infinity;
  let bestN: V3 = { x: 0, y: 0, z: 0 };
  const consider = (s: number, n: number[]): void => {
    if (s >= 0 && s <= 1 && s < best) {
      best = s;
      bestN = { x: n[0], y: n[1], z: n[2] };
    }
  };
  // flat faces
  for (let k = 0; k < 3; k++) {
    const lo = mn.slice();
    const hi = mx.slice();
    lo[k] -= r;
    hi[k] += r;
    const s = slab(A[0], A[1], A[2], D[0], D[1], D[2], lo[0], lo[1], lo[2], hi[0], hi[1], hi[2]);
    if (s && s.tNear >= 0 && s.axis >= 0) {
      const n = [0, 0, 0];
      n[s.axis] = s.sign;
      consider(s.tNear, n);
    }
  }
  // edge cylinders
  for (let k = 0; k < 3; k++) {
    const i = (k + 1) % 3;
    const j = (k + 2) % 3;
    const AA = D[i] * D[i] + D[j] * D[j];
    if (AA < 1e-24) continue;
    for (const ci of [mn[i], mx[i]]) {
      for (const cj of [mn[j], mx[j]]) {
        const ui = A[i] - ci;
        const uj = A[j] - cj;
        const B = 2 * (ui * D[i] + uj * D[j]);
        const C = ui * ui + uj * uj - r * r;
        const disc = B * B - 4 * AA * C;
        if (disc < 0) continue;
        const s = (-B - Math.sqrt(disc)) / (2 * AA);
        const pk = A[k] + D[k] * s;
        if (pk >= mn[k] && pk <= mx[k]) {
          const n = [0, 0, 0];
          n[i] = (ui + D[i] * s) / r;
          n[j] = (uj + D[j] * s) / r;
          consider(s, n);
        }
      }
    }
  }
  // corner spheres
  const AA = D[0] * D[0] + D[1] * D[1] + D[2] * D[2];
  if (AA >= 1e-24) {
    for (const cx of [mn[0], mx[0]]) {
      for (const cy of [mn[1], mx[1]]) {
        for (const cz of [mn[2], mx[2]]) {
          const u = [A[0] - cx, A[1] - cy, A[2] - cz];
          const B = 2 * (u[0] * D[0] + u[1] * D[1] + u[2] * D[2]);
          const C = u[0] * u[0] + u[1] * u[1] + u[2] * u[2] - r * r;
          const disc = B * B - 4 * AA * C;
          if (disc < 0) continue;
          const s = (-B - Math.sqrt(disc)) / (2 * AA);
          consider(s, [(u[0] + D[0] * s) / r, (u[1] + D[1] * s) / r, (u[2] + D[2] * s) / r]);
        }
      }
    }
  }
  if (best === Infinity) return null;
  // the outward normal at the contact point is (contact centre - closest point on the box) / r; this also
  // resolves the exactly-on-a-seam cases where several primitives touch at the same time
  const P = A.map((v0, i) => v0 + D[i] * best);
  const Q = P.map((v0, i) => Math.min(mx[i], Math.max(mn[i], v0)));
  const nl = Math.hypot(P[0] - Q[0], P[1] - Q[1], P[2] - Q[2]);
  if (nl > 1e-9) bestN = { x: (P[0] - Q[0]) / nl, y: (P[1] - Q[1]) / nl, z: (P[2] - Q[2]) / nl };
  return { s: best, n: bestN };
}

class NaiveWorld {
  readonly boxes: readonly BoxDef[];
  private enabled: boolean[];
  constructor(boxes: readonly BoxDef[]) {
    this.boxes = boxes;
    this.enabled = boxes.map(() => true);
  }
  setBoxEnabled(i: number, e: boolean): void {
    this.enabled[i] = e;
  }

  raycast(origin: V3, dir: V3, maxDist: number): RayHit | null {
    let best: RayHit | null = null;
    let bestT = maxDist;
    for (let i = 0; i < this.boxes.length; i++) {
      if (!this.enabled[i]) continue;
      const b = this.boxes[i];
      const r = slab(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z);
      if (!r || r.tFar < 0) continue;
      const t = Math.max(0, r.tNear);
      if (t > bestT) continue;
      if (best && t >= best.t) continue;
      const n = { x: 0, y: 0, z: 0 };
      if (r.tNear < 0) {
        n.x = 0 - dir.x;
        n.y = 0 - dir.y;
        n.z = 0 - dir.z;
        if (n.x === 0 && n.y === 0 && n.z === 0) n.y = 1;
      } else if (r.axis === 0) n.x = r.sign;
      else if (r.axis === 1) n.y = r.sign;
      else n.z = r.sign;
      best = { t, point: { x: origin.x + dir.x * t, y: origin.y + dir.y * t, z: origin.z + dir.z * t }, normal: n, boxIndex: i };
      bestT = t;
    }
    return best;
  }

  segmentBlocked(a: V3, b: V3): boolean {
    const d = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
    const len = Math.hypot(d.x, d.y, d.z);
    if (len < 1e-9) return this.pointInSolid(a);
    for (let i = 0; i < this.boxes.length; i++) {
      if (!this.enabled[i]) continue;
      const bx = this.boxes[i];
      const r = slab(a.x, a.y, a.z, d.x, d.y, d.z, bx.min.x, bx.min.y, bx.min.z, bx.max.x, bx.max.y, bx.max.z, 1e-15 * len);
      if (r && r.tFar >= 0 && r.tNear <= 1) return true;
    }
    return false;
  }

  sweepSphere(a: V3, b: V3, radius: number): RayHit | null {
    const d = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
    const len = Math.hypot(d.x, d.y, d.z);
    let best: { s: number; n: V3; i: number } | null = null;
    for (let i = 0; i < this.boxes.length; i++) {
      if (!this.enabled[i]) continue;
      const h = refSphereBox(a, d, radius, this.boxes[i]);
      if (!h) continue;
      if (best && h.s >= best.s) continue;
      best = { s: h.s, n: h.n, i };
    }
    if (!best) return null;
    return {
      t: best.s * len,
      point: { x: a.x + d.x * best.s, y: a.y + d.y * best.s, z: a.z + d.z * best.s },
      normal: best.n,
      boxIndex: best.i,
    };
  }

  sweepAABB(center: V3, half: V3, delta: V3): SweepHit | null {
    let best: SweepHit | null = null;
    for (let i = 0; i < this.boxes.length; i++) {
      if (!this.enabled[i]) continue;
      const b = this.boxes[i];
      const minx = b.min.x - half.x, miny = b.min.y - half.y, minz = b.min.z - half.z;
      const maxx = b.max.x + half.x, maxy = b.max.y + half.y, maxz = b.max.z + half.z;
      const r = slab(center.x, center.y, center.z, delta.x, delta.y, delta.z, minx, miny, minz, maxx, maxy, maxz);
      if (!r || r.tFar <= 0 || r.tNear > 1) continue;
      if (r.tNear < 0) {
        const pen = [
          Math.min(center.x - minx, maxx - center.x),
          Math.min(center.y - miny, maxy - center.y),
          Math.min(center.z - minz, maxz - center.z),
        ];
        if (pen[0] <= EPS_TOUCH || pen[1] <= EPS_TOUCH || pen[2] <= EPS_TOUCH) continue;
        let ax = 0;
        if (pen[1] < pen[ax]) ax = 1;
        if (pen[2] < pen[ax]) ax = 2;
        const c = [center.x, center.y, center.z][ax];
        const lo = [minx, miny, minz][ax];
        const hi = [maxx, maxy, maxz][ax];
        const sgn = c - lo < hi - c ? -1 : 1;
        const dd = [delta.x, delta.y, delta.z][ax];
        if (dd * sgn >= 0) continue;
        const n = { x: 0, y: 0, z: 0 };
        if (ax === 0) n.x = sgn;
        else if (ax === 1) n.y = sgn;
        else n.z = sgn;
        if (!best || 0 < best.t) best = { t: 0, normal: n, boxIndex: i };
        continue;
      }
      if (best && r.tNear >= best.t) continue;
      const n = { x: 0, y: 0, z: 0 };
      if (r.axis === 0) n.x = r.sign;
      else if (r.axis === 1) n.y = r.sign;
      else n.z = r.sign;
      best = { t: r.tNear, normal: n, boxIndex: i };
    }
    return best;
  }

  overlapAABB(center: V3, half: V3, margin = 1e-4): boolean {
    for (let i = 0; i < this.boxes.length; i++) {
      if (!this.enabled[i]) continue;
      const b = this.boxes[i];
      if (
        center.x + half.x - b.min.x > margin && b.max.x - (center.x - half.x) > margin &&
        center.y + half.y - b.min.y > margin && b.max.y - (center.y - half.y) > margin &&
        center.z + half.z - b.min.z > margin && b.max.z - (center.z - half.z) > margin
      ) return true;
    }
    return false;
  }

  pointInSolid(p: V3): boolean {
    for (let i = 0; i < this.boxes.length; i++) {
      if (!this.enabled[i]) continue;
      const b = this.boxes[i];
      if (p.x > b.min.x && p.x < b.max.x && p.y > b.min.y && p.y < b.max.y && p.z > b.min.z && p.z < b.max.z) return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------
const v = (x: number, y: number, z: number): V3 => ({ x, y, z });
const box = (id: string, min: V3, max: V3, extra: Partial<BoxDef> = {}): BoxDef => ({ id, min, max, mat: 'concrete', sectorId: 'T', ...extra });
const unit = (a: V3): V3 => {
  const l = Math.hypot(a.x, a.y, a.z);
  return l > 0 ? v(a.x / l, a.y / l, a.z / l) : v(0, 0, 1);
};
const HALF = PLAYER.HALF;

/** a box given by center and full size */
const cbox = (id: string, c: V3, s: V3, extra: Partial<BoxDef> = {}): BoxDef =>
  box(id, v(c.x - s.x / 2, c.y - s.y / 2, c.z - s.z / 2), v(c.x + s.x / 2, c.y + s.y / 2, c.z + s.z / 2), extra);

function randomUnit(rng: Rng, axisAlignedChance = 0.1): V3 {
  if (rng.next() < axisAlignedChance) {
    const ax = rng.int(0, 2);
    const sg = rng.next() < 0.5 ? -1 : 1;
    return v(ax === 0 ? sg : 0, ax === 1 ? sg : 0, ax === 2 ? sg : 0);
  }
  for (;;) {
    const p = v(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1));
    const l = Math.hypot(p.x, p.y, p.z);
    if (l > 0.1 && l <= 1) return v(p.x / l, p.y / l, p.z / l);
  }
}

/** mixed random scene: small props, thin walls, big slabs and a few giant boxes */
function randomScene(rng: Rng, n: number, extent: number): BoxDef[] {
  const out: BoxDef[] = [];
  for (let i = 0; i < n; i++) {
    const k = rng.next();
    const c = v(rng.range(-extent, extent), rng.range(-extent * 0.5, extent * 0.5), rng.range(-extent, extent));
    let s: V3;
    if (k < 0.6) s = v(rng.range(0.3, 6), rng.range(0.3, 6), rng.range(0.3, 6));
    else if (k < 0.85) {
      const big = () => rng.range(2, 40);
      const th = rng.range(0.05, 0.4);
      const ax = rng.int(0, 2);
      s = v(ax === 0 ? th : big(), ax === 1 ? th : big(), ax === 2 ? th : big());
    } else if (k < 0.985) s = v(rng.range(30, 150), rng.range(0.5, 2), rng.range(30, 100));
    else s = v(rng.range(40, 120), rng.range(40, 120), rng.range(40, 120));
    out.push(cbox('r' + i, c, s));
  }
  return out;
}

/** integer-aligned scene: lots of touching / coplanar / abutting boxes */
function gridScene(rng: Rng, n: number, size: number): BoxDef[] {
  const out: BoxDef[] = [];
  for (let i = 0; i < n; i++) {
    const mn = v(rng.int(0, size - 1), rng.int(0, size - 1), rng.int(0, size - 1));
    const sz = v(rng.int(1, 3), rng.int(1, 3), rng.int(1, 3));
    out.push(box('g' + i, mn, v(mn.x + sz.x, mn.y + sz.y, mn.z + sz.z)));
  }
  return out;
}

const close = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol * (1 + Math.abs(a) + Math.abs(b));

function vecClose(a: V3, b: V3, tol: number): boolean {
  return Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol && Math.abs(a.z - b.z) <= tol;
}

interface Mismatch {
  kind: string;
  detail: string;
}

function hitDiff(kind: string, got: RayHit | null, ref: RayHit | null, exact: boolean, ctx: unknown): Mismatch | null {
  const fail = (m: string): Mismatch => ({ kind, detail: `${m}\ngot=${JSON.stringify(got)}\nref=${JSON.stringify(ref)}\nctx=${JSON.stringify(ctx)}` });
  if (!got && !ref) return null;
  if (!got || !ref) return fail('null mismatch');
  const tol = exact ? 0 : 1e-6;
  if (exact ? got.t !== ref.t : !close(got.t, ref.t, tol)) return fail('t');
  if (got.boxIndex !== ref.boxIndex) return fail('boxIndex');
  if (!vecClose(got.normal, ref.normal, exact ? 0 : 1e-6)) return fail('normal');
  if (!vecClose(got.point, ref.point, exact ? 0 : 1e-6 * (1 + Math.abs(ref.t)))) return fail('point');
  return null;
}

function sweepDiff(got: SweepHit | null, ref: SweepHit | null, ctx: unknown): Mismatch | null {
  const fail = (m: string): Mismatch => ({ kind: 'sweepAABB', detail: `${m}\ngot=${JSON.stringify(got)}\nref=${JSON.stringify(ref)}\nctx=${JSON.stringify(ctx)}` });
  if (!got && !ref) return null;
  if (!got || !ref) return fail('null mismatch');
  if (got.t !== ref.t) return fail('t');
  if (got.boxIndex !== ref.boxIndex) return fail('boxIndex');
  if (!vecClose(got.normal, ref.normal, 0)) return fail('normal');
  return null;
}

function expectNoMismatch(list: Mismatch[]): void {
  if (list.length > 0) {
    throw new Error(`${list.length} mismatches. first:\n${list[0].kind}: ${list[0].detail}`);
  }
}

/** random enable/disable toggling applied identically to both worlds */
function toggleSome(rng: Rng, w: World, ref: NaiveWorld, count: number): void {
  const n = w.boxes.length;
  for (let k = 0; k < count; k++) {
    const i = rng.int(0, n - 1);
    const e = rng.next() < 0.5;
    w.setBoxEnabled(i, e);
    ref.setBoxEnabled(i, e);
    expect(w.isBoxEnabled(i)).toBe(e);
  }
}

// ---------------------------------------------------------------------------------------------
// differential tests vs the linear-scan reference
// ---------------------------------------------------------------------------------------------
interface SceneCfg {
  name: string;
  make: (rng: Rng) => BoxDef[];
  /** query generators */
  point: (rng: Rng) => V3;
  dirs: (rng: Rng) => V3;
  maxRay: (rng: Rng) => number;
  seg: (rng: Rng, a: V3) => V3;
  sphere: (rng: Rng) => { a: V3; b: V3; r: number };
  aabb: (rng: Rng) => { c: V3; h: V3; d: V3 };
  n: number;
}

const scenes: SceneCfg[] = [
  {
    name: 'random mixed (continuous)',
    make: (rng) => randomScene(rng, 400, 120),
    point: (rng) => v(rng.range(-150, 150), rng.range(-80, 80), rng.range(-150, 150)),
    dirs: (rng) => randomUnit(rng),
    maxRay: (rng) => rng.range(0.5, 400),
    seg: (rng, a) => {
      const d = randomUnit(rng, 0.05);
      const l = rng.next() < 0.05 ? 0 : rng.range(0, 150);
      return v(a.x + d.x * l, a.y + d.y * l, a.z + d.z * l);
    },
    sphere: (rng) => {
      const a = v(rng.range(-150, 150), rng.range(-80, 80), rng.range(-150, 150));
      const d = randomUnit(rng, 0.1);
      const l = rng.next() < 0.7 ? rng.range(0.1, 1) : rng.range(0, 60);
      return { a, b: v(a.x + d.x * l, a.y + d.y * l, a.z + d.z * l), r: rng.range(0.05, 1.2) };
    },
    aabb: (rng) => {
      const d = randomUnit(rng, 0.15);
      const l = rng.range(0, 1.5);
      return {
        c: v(rng.range(-150, 150), rng.range(-80, 80), rng.range(-150, 150)),
        h: rng.next() < 0.5 ? v(HALF.x, HALF.y, HALF.z) : v(rng.range(0.1, 2), rng.range(0.1, 2), rng.range(0.1, 2)),
        d: v(d.x * l, d.y * l, d.z * l),
      };
    },
    n: 6000,
  },
  {
    name: 'integer grid (touching, coplanar, parallel)',
    make: (rng) => gridScene(rng, 250, 14),
    point: (rng) => v(rng.int(-4, 32) / 2, rng.int(-4, 32) / 2, rng.int(-4, 32) / 2),
    dirs: (rng) => {
      for (;;) {
        const d = v(rng.int(-2, 2), rng.int(-2, 2), rng.int(-2, 2));
        if (d.x !== 0 || d.y !== 0 || d.z !== 0) return unit(d);
      }
    },
    maxRay: (rng) => rng.int(1, 30),
    seg: (rng, a) => v(a.x + rng.int(-8, 8) / 2, a.y + rng.int(-8, 8) / 2, a.z + rng.int(-8, 8) / 2),
    sphere: (rng) => {
      const a = v(rng.int(-4, 32) / 2, rng.int(-4, 32) / 2, rng.int(-4, 32) / 2);
      return { a, b: v(a.x + rng.int(-6, 6) / 2, a.y + rng.int(-6, 6) / 2, a.z + rng.int(-6, 6) / 2), r: rng.next() < 0.5 ? 0.5 : 0.25 };
    },
    aabb: (rng) => ({
      c: v(rng.int(-4, 32) / 2, rng.int(-4, 32) / 2, rng.int(-4, 32) / 2),
      h: rng.next() < 0.5 ? v(0.5, 0.5, 0.5) : v(0.25, 0.75, 0.5),
      d: v(rng.int(-6, 6) / 2, rng.int(-6, 6) / 2, rng.int(-6, 6) / 2),
    }),
    n: 6000,
  },
];

describe('World vs linear-scan reference (differential)', () => {
  for (const cfg of scenes) {
    describe(cfg.name, () => {
      const rng = new Rng(12345);
      const boxes = cfg.make(rng);
      const w = new World(boxes);
      const ref = new NaiveWorld(boxes);
      const rounds = 3;

      it('raycast: identical t / point / normal / boxIndex', () => {
        const bad: Mismatch[] = [];
        let hits = 0;
        let total = 0;
        for (let round = 0; round < rounds; round++) {
          if (round > 0) toggleSome(rng, w, ref, 40);
          for (let i = 0; i < cfg.n / rounds; i++) {
            const o = cfg.point(rng);
            const d = cfg.dirs(rng);
            const m = cfg.maxRay(rng);
            const g = w.raycast(o, d, m);
            total++;
            if (g) hits++;
            const m1 = hitDiff('raycast', g, ref.raycast(o, d, m), true, { o, d, m });
            if (m1) bad.push(m1);
          }
        }
        expectNoMismatch(bad);
        expect(hits).toBeGreaterThan(total * 0.1); // the comparison is not vacuous
        expect(hits).toBeLessThan(total * 0.98);
      });

      it('segmentBlocked: identical', () => {
        const bad: Mismatch[] = [];
        let blocked = 0;
        let total = 0;
        for (let round = 0; round < rounds; round++) {
          if (round > 0) toggleSome(rng, w, ref, 40);
          for (let i = 0; i < cfg.n / rounds; i++) {
            const a = cfg.point(rng);
            const b = cfg.seg(rng, a);
            const g = w.segmentBlocked(a, b);
            const r = ref.segmentBlocked(a, b);
            total++;
            if (g) blocked++;
            if (g !== r) bad.push({ kind: 'segmentBlocked', detail: JSON.stringify({ a, b, g, r }) });
          }
        }
        expectNoMismatch(bad);
        expect(blocked).toBeGreaterThan(total * 0.1);
        expect(blocked).toBeLessThan(total * 0.98);
      });

      it('sweepSphere: exact rounded-box sweep matches the independent reference', () => {
        const bad: Mismatch[] = [];
        let hits = 0;
        let misses = 0;
        let rounded = 0; // hits where the exact rounded box differs from the inflated AABB
        for (let round = 0; round < rounds; round++) {
          if (round > 0) toggleSome(rng, w, ref, 40);
          for (let i = 0; i < cfg.n / rounds / 2; i++) {
            const q = cfg.sphere(rng);
            const g = w.sweepSphere(q.a, q.b, q.r);
            const r = ref.sweepSphere(q.a, q.b, q.r);
            if (g) hits++;
            else misses++;
            if (g && g.t > 0) {
              const bx = boxes[g.boxIndex];
              const dl = Math.hypot(q.b.x - q.a.x, q.b.y - q.a.y, q.b.z - q.a.z);
              const inf = slab(q.a.x, q.a.y, q.a.z, q.b.x - q.a.x, q.b.y - q.a.y, q.b.z - q.a.z, bx.min.x - q.r, bx.min.y - q.r, bx.min.z - q.r, bx.max.x + q.r, bx.max.y + q.r, bx.max.z + q.r);
              if (inf && Math.abs(inf.tNear * dl - g.t) > 1e-9) rounded++;
            }
            const m1 = hitDiff('sweepSphere', g, r, false, q);
            if (m1) bad.push(m1);
          }
        }
        expectNoMismatch(bad);
        expect(hits).toBeGreaterThan(50);
        expect(misses).toBeGreaterThan(50);
        expect(rounded).toBeGreaterThan(cfg.name.startsWith('random') ? 5 : 1);
      });

      it('sweepAABB: identical t / normal / boxIndex', () => {
        const bad: Mismatch[] = [];
        let hits = 0;
        let misses = 0;
        let zeroT = 0;
        for (let round = 0; round < rounds; round++) {
          if (round > 0) toggleSome(rng, w, ref, 40);
          for (let i = 0; i < cfg.n / rounds; i++) {
            const q = cfg.aabb(rng);
            const g = w.sweepAABB(q.c, q.h, q.d);
            const r = ref.sweepAABB(q.c, q.h, q.d);
            if (g) hits++;
            else misses++;
            if (g && g.t === 0) zeroT++;
            const m1 = sweepDiff(g, r, q);
            if (m1) bad.push(m1);
          }
        }
        expectNoMismatch(bad);
        expect(hits).toBeGreaterThan(50);
        expect(misses).toBeGreaterThan(50);
        if (cfg.name.startsWith('integer')) expect(zeroT).toBeGreaterThan(20); // touching starts are exercised
      });

      it('overlapAABB / pointInSolid: identical', () => {
        const bad: Mismatch[] = [];
        let overlaps = 0;
        let inside = 0;
        let total = 0;
        for (let round = 0; round < rounds; round++) {
          if (round > 0) toggleSome(rng, w, ref, 40);
          for (let i = 0; i < cfg.n / rounds; i++) {
            const q = cfg.aabb(rng);
            const margin = rng.next() < 0.5 ? 1e-4 : rng.range(-0.2, 0.5);
            const og = w.overlapAABB(q.c, q.h, margin);
            if (og !== ref.overlapAABB(q.c, q.h, margin)) bad.push({ kind: 'overlap', detail: JSON.stringify({ q, margin }) });
            const p = cfg.point(rng);
            const pg = w.pointInSolid(p);
            if (pg !== ref.pointInSolid(p)) bad.push({ kind: 'point', detail: JSON.stringify(p) });
            total++;
            if (og) overlaps++;
            if (pg) inside++;
          }
        }
        expectNoMismatch(bad);
        expect(overlaps).toBeGreaterThan(total * 0.05);
        expect(overlaps).toBeLessThan(total * 0.98);
        expect(inside).toBeGreaterThan(total * 0.02);
        expect(inside).toBeLessThan(total * 0.98);
      });
    });
  }

  it('all boxes disabled / re-enabled behaves like an empty / full world', () => {
    const rng = new Rng(777);
    const boxes = randomScene(rng, 200, 100);
    const w = new World(boxes);
    for (let i = 0; i < boxes.length; i++) w.setBoxEnabled(i, false);
    for (let i = 0; i < 2000; i++) {
      const o = v(rng.range(-100, 100), rng.range(-50, 50), rng.range(-100, 100));
      const d = randomUnit(rng);
      expect(w.raycast(o, d, 1000)).toBeNull();
      expect(w.segmentBlocked(o, v(o.x + d.x * 50, o.y + d.y * 50, o.z + d.z * 50))).toBe(false);
      expect(w.sweepSphere(o, v(o.x + d.x, o.y + d.y, o.z + d.z), 0.3)).toBeNull();
      expect(w.sweepAABB(o, HALF, d)).toBeNull();
      expect(w.overlapAABB(o, HALF)).toBe(false);
      expect(w.pointInSolid(o)).toBe(false);
    }
    const ref = new NaiveWorld(boxes);
    for (let i = 0; i < boxes.length; i++) w.setBoxEnabled(i, true);
    const bad: Mismatch[] = [];
    for (let i = 0; i < 3000; i++) {
      const o = v(rng.range(-100, 100), rng.range(-50, 50), rng.range(-100, 100));
      const d = randomUnit(rng);
      const m1 = hitDiff('raycast', w.raycast(o, d, 500), ref.raycast(o, d, 500), true, { o, d });
      if (m1) bad.push(m1);
    }
    expectNoMismatch(bad);
  });
});

// ---------------------------------------------------------------------------------------------
// raycast
// ---------------------------------------------------------------------------------------------
describe('raycast', () => {
  const w = new World([
    box('floor', v(-50, -2, -50), v(50, 0, 50)),
    box('wall', v(10, 0, -5), v(11, 8, 5)),
  ]);

  it('hits the floor from above: t, point, normal +Y', () => {
    const h = w.raycast(v(3, 5, 4), v(0, -1, 0), 100)!;
    expect(h.t).toBeCloseTo(5, 12);
    expect(h.point).toEqual(v(3, 0, 4));
    expect(h.normal).toEqual(v(0, 1, 0));
    expect(h.boxIndex).toBe(0);
  });

  it('respects maxDist (inclusive) and returns null beyond it', () => {
    expect(w.raycast(v(3, 5, 4), v(0, -1, 0), 4.999)).toBeNull();
    expect(w.raycast(v(3, 5, 4), v(0, -1, 0), 5)?.t).toBe(5);
    expect(w.raycast(v(0, 3, 0), v(1, 0, 0), 100)?.t).toBeCloseTo(10, 12);
    expect(w.raycast(v(0, 3, 0), v(1, 0, 0), 100)?.normal).toEqual(v(-1, 0, 0));
  });

  it('origin inside a box gives t = 0 and normal opposite to the ray', () => {
    const h = w.raycast(v(10.5, 4, 0), unit(v(1, 1, 0)), 50)!;
    expect(h.t).toBe(0);
    expect(h.boxIndex).toBe(1);
    expect(h.normal.x).toBeCloseTo(-Math.SQRT1_2, 12);
    expect(h.normal.y).toBeCloseTo(-Math.SQRT1_2, 12);
    expect(h.point).toEqual(v(10.5, 4, 0));
  });

  it('a ray running exactly along a face does not hit it', () => {
    // along the top of the floor (y = 0) and along the wall face (x = 10)
    expect(w.raycast(v(-5, 0, 0), v(1, 0, 0), 4)).toBeNull();
    expect(w.raycast(v(10, 3, -20), v(0, 0, 1), 100)).toBeNull();
    expect(w.raycast(v(10.5, 3, -20), v(0, 0, 1), 100)?.t).toBeCloseTo(15, 12);
  });

  it('ignores disabled boxes and finds the next one behind', () => {
    const w2 = new World([box('a', v(1, -1, -1), v(2, 1, 1)), box('b', v(5, -1, -1), v(6, 1, 1))]);
    expect(w2.raycast(v(0, 0, 0), v(1, 0, 0), 100)?.boxIndex).toBe(0);
    w2.setBoxEnabled(0, false);
    expect(w2.raycast(v(0, 0, 0), v(1, 0, 0), 100)?.boxIndex).toBe(1);
    w2.setBoxEnabled(1, false);
    expect(w2.raycast(v(0, 0, 0), v(1, 0, 0), 100)).toBeNull();
    w2.setBoxEnabled(0, true);
    expect(w2.raycast(v(0, 0, 0), v(1, 0, 0), 100)?.boxIndex).toBe(0);
  });

  it('equal-distance hits resolve to the lowest box index', () => {
    const w2 = new World([box('hi', v(0, 0, 0), v(2, 2, 2)), box('lo', v(0, 0, 0), v(2, 2, 2)), box('x', v(-9, 5, 5), v(-8, 6, 6))]);
    expect(w2.raycast(v(-3, 1, 1), v(1, 0, 0), 50)?.boxIndex).toBe(0);
    w2.setBoxEnabled(0, false);
    expect(w2.raycast(v(-3, 1, 1), v(1, 0, 0), 50)?.boxIndex).toBe(1);
  });

  it('does not miss a giant slab among many small boxes and never leaks through abutting seams', () => {
    const boxes: BoxDef[] = [box('slab', v(-500, -2, -500), v(500, 0, 500))];
    for (let i = 0; i < 500; i++) boxes.push(cbox('c' + i, v((i % 25) * 4 - 50, 30 + (i % 7), Math.floor(i / 25) * 4 - 40), v(1, 1, 1)));
    const w2 = new World(boxes);
    const rng = new Rng(5);
    for (let i = 0; i < 2000; i++) {
      const o = v(rng.range(-400, 400), rng.range(1, 200), rng.range(-400, 400));
      const h = w2.raycast(o, v(0, -1, 0), 1000);
      expect(h).not.toBeNull();
      expect(h!.t).toBeLessThanOrEqual(o.y + 1e-9);
    }
    // 2 abutting floor tiles: rays straight down through the seam must hit one of them
    const tiles = new World([box('l', v(-10, -1, -10), v(0, 0, 10)), box('r', v(0, -1, -10), v(10, 0, 10))]);
    for (const x of [-1e-3, -1e-6, 1e-6, 1e-3]) expect(tiles.raycast(v(x, 5, 0), v(0, -1, 0), 100)?.t).toBeCloseTo(5, 9);
    // non-parallel rays crossing the seam plane exactly at the seam still hit
    for (const x of [-1e-9, 0, 1e-9]) expect(tiles.raycast(v(x, 5, 0), unit(v(1e-3, -1, 0)), 100)?.t).toBeCloseTo(5, 3);
  });

  it('convention: a ray running exactly along a face (within 1e-7) is a miss, even along the seam of two abutting boxes', () => {
    const tiles = new World([box('l', v(-10, -1, -10), v(0, 0, 10)), box('r', v(0, -1, -10), v(10, 0, 10))]);
    expect(tiles.raycast(v(0, 5, 0), v(0, -1, 0), 100)).toBeNull();
  });

  it('rejects NaN / Infinity inputs instead of returning NaN hits', () => {
    expect(w.raycast(v(NaN, 5, 0), v(0, -1, 0), 100)).toBeNull();
    expect(w.raycast(v(0, 5, 0), v(0, NaN, 0), 100)).toBeNull();
    expect(w.raycast(v(0, 5, 0), v(0, -1, 0), NaN)).toBeNull();
    expect(w.raycast(v(0, 5, 0), v(0, -1, 0), -1)).toBeNull();
    expect(w.raycast(v(0, 5, 0), v(0, -1, 0), Infinity)?.t).toBeCloseTo(5, 12);
    expect(w.segmentBlocked(v(0, 5, 0), v(0, Infinity, 0))).toBe(false);
    expect(w.sweepAABB(v(0, 5, 0), HALF, v(NaN, 0, 0))).toBeNull();
    expect(w.sweepSphere(v(0, 5, 0), v(0, 0, 0), NaN)).toBeNull();
    expect(w.pointInSolid(v(NaN, 0, 0))).toBe(false);
    expect(w.overlapAABB(v(NaN, 0, 0), HALF)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// segmentBlocked
// ---------------------------------------------------------------------------------------------
describe('segmentBlocked', () => {
  const w = new World([box('b', v(0, 0, 0), v(2, 2, 2))]);

  it('closed segment: an end point exactly on a face counts as blocked', () => {
    expect(w.segmentBlocked(v(-3, 1, 1), v(0, 1, 1))).toBe(true);
    expect(w.segmentBlocked(v(-3, 1, 1), v(-1e-6, 1, 1))).toBe(false);
    expect(w.segmentBlocked(v(-3, 1, 1), v(-0.1, 1, 1))).toBe(false);
    expect(w.segmentBlocked(v(-3, 1, 1), v(5, 1, 1))).toBe(true);
    expect(w.segmentBlocked(v(5, 1, 1), v(-3, 1, 1))).toBe(true);
  });

  it('a segment starting or ending inside is blocked, degenerate segments test the point', () => {
    expect(w.segmentBlocked(v(1, 1, 1), v(10, 10, 10))).toBe(true);
    expect(w.segmentBlocked(v(1, 1, 1), v(1, 1, 1))).toBe(true);
    expect(w.segmentBlocked(v(9, 9, 9), v(9, 9, 9))).toBe(false);
  });

  it('a segment sliding along a face is not blocked', () => {
    expect(w.segmentBlocked(v(0, -5, 1), v(0, 5, 1))).toBe(false);
    expect(w.segmentBlocked(v(0.5, 2, -5), v(0.5, 2, 5))).toBe(false);
  });

  it('long diagonals across a giant thin slab are always blocked', () => {
    const s = new World([box('slab', v(-500, -1, -500), v(500, 0, 500)), cbox('c', v(3, 3, 3), v(1, 1, 1))]);
    const rng = new Rng(9);
    for (let i = 0; i < 3000; i++) {
      const a = v(rng.range(-400, 400), rng.range(0.5, 50), rng.range(-400, 400));
      const b = v(rng.range(-400, 400), rng.range(-50, -0.5), rng.range(-400, 400));
      expect(s.segmentBlocked(a, b)).toBe(true);
      expect(s.segmentBlocked(b, a)).toBe(true);
    }
  });

  it('a gap between two boxes lets a segment through, closing it blocks', () => {
    const g = new World([box('l', v(-5, 0, -5), v(-0.01, 10, 5)), box('r', v(0.01, 0, -5), v(5, 10, 5))]);
    expect(g.segmentBlocked(v(0, 5, -20), v(0, 5, 20))).toBe(false);
    const g2 = new World([box('l', v(-5, 0, -5), v(0, 10, 5)), box('r', v(0, 0, -5), v(5, 10, 5))]);
    expect(g2.segmentBlocked(v(0, 5, -20), v(0, 5, 20))).toBe(false); // exactly along the shared plane
    expect(g2.segmentBlocked(v(-1, 5, -20), v(1, 5, 20))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// sweepSphere
// ---------------------------------------------------------------------------------------------
describe('sweepSphere', () => {
  const cube = new World([box('cube', v(0, 0, 0), v(2, 2, 2))]);

  it('flat face: t = distance minus radius, centre point, axis normal', () => {
    const h = cube.sweepSphere(v(-5, 1, 1), v(5, 1, 1), 0.5)!;
    expect(h.t).toBeCloseTo(4.5, 12);
    expect(h.point.x).toBeCloseTo(-0.5, 12);
    expect(h.normal).toEqual(v(-1, 0, 0));
  });

  it('a path that only the inflated AABB would hit passes the rounded edge (t is later / null)', () => {
    // edge x=0,y=2 (along z): path at y = 2.45 clips the rounded edge at x = -sqrt(0.25 - 0.45^2)
    const h = cube.sweepSphere(v(-5, 2.45, 1), v(5, 2.45, 1), 0.5)!;
    expect(h.t).toBeCloseTo(5 - Math.sqrt(0.25 - 0.45 * 0.45), 10);
    const nx = -Math.sqrt(0.25 - 0.45 * 0.45) / 0.5;
    expect(h.normal.x).toBeCloseTo(nx, 10);
    expect(h.normal.y).toBeCloseTo(0.9, 10);
    expect(h.normal.z).toBeCloseTo(0, 12);
    // along the edge line at distance sqrt(2)*0.4 = 0.566 > r: never touches
    expect(cube.sweepSphere(v(-5, -0.4, -0.4), v(5, -0.4, -0.4), 0.5)).toBeNull();
    // ... while at 0.3/0.3 (distance 0.424 < r) it does
    expect(cube.sweepSphere(v(-5, -0.3, -0.3), v(5, -0.3, -0.3), 0.5)).not.toBeNull();
  });

  it('corner: hits the corner sphere with the diagonal normal', () => {
    const dir = unit(v(1, 1, 1));
    const a = v(-3, -3, -3);
    const b = v(a.x + dir.x * 10, a.y + dir.y * 10, a.z + dir.z * 10);
    const h = cube.sweepSphere(a, b, 0.5)!;
    expect(h.t).toBeCloseTo(3 * Math.sqrt(3) - 0.5, 10);
    expect(h.normal.x).toBeCloseTo(-Math.SQRT1_2 / Math.sqrt(1.5), 9);
    expect(Math.hypot(h.normal.x, h.normal.y, h.normal.z)).toBeCloseTo(1, 12);
    expect(h.normal.x).toBeCloseTo(h.normal.y, 12);
    expect(h.normal.y).toBeCloseTo(h.normal.z, 12);
    expect(h.normal.x).toBeLessThan(0);
  });

  it('thin wall at bullet speed is never tunnelled (0.06 m bullet, 0.02 m wall, 0.83 m per tick)', () => {
    const w = new World([box('thin', v(10, -50, -50), v(10.02, 50, 50))]);
    const rng = new Rng(21);
    for (let i = 0; i < 3000; i++) {
      const p = v(rng.range(-5, 9.9), rng.range(-20, 20), rng.range(-20, 20));
      const dir = randomUnit(rng, 0);
      dir.x = Math.abs(dir.x) + 0.05;
      const d = unit(dir);
      const step = 100 / 120;
      const q = v(p.x + d.x * step, p.y + d.y * step, p.z + d.z * step);
      const crosses = q.x > 10 - 0.06;
      const h = w.sweepSphere(p, q, 0.06);
      if (crosses) expect(h, `p=${JSON.stringify(p)} q=${JSON.stringify(q)}`).not.toBeNull();
      if (h) expect(h.t).toBeLessThanOrEqual(step + 1e-9);
    }
  });

  it('a start that already overlaps hits at t = 0 with an outward normal', () => {
    const h = cube.sweepSphere(v(-0.2, 1, 1), v(-5, 1, 1), 0.5)!;
    expect(h.t).toBe(0);
    expect(h.normal).toEqual(v(-1, 0, 0));
    const inside = cube.sweepSphere(v(1, 1, 1), v(1, 1, 5), 0.1)!;
    expect(inside.t).toBe(0);
    expect(inside.normal).toEqual(v(0, 0, -1));
  });

  it('zero-length sweep is a static overlap test', () => {
    expect(cube.sweepSphere(v(-0.4, 1, 1), v(-0.4, 1, 1), 0.5)?.t).toBe(0);
    expect(cube.sweepSphere(v(-0.6, 1, 1), v(-0.6, 1, 1), 0.5)).toBeNull();
    const n = cube.sweepSphere(v(-0.4, 1, 1), v(-0.4, 1, 1), 0.5)!.normal;
    expect(Math.hypot(n.x, n.y, n.z)).toBeCloseTo(1, 12);
  });

  it('camera-style sweep against a wall behind the player stops before the wall by the margin', () => {
    const w = new World([box('back', v(-20, 0, 5), v(20, 30, 6))]);
    const pivot = v(0, 4.2, 0);
    const desired = v(1.4, 4.2 + 2, 8.5); // behind the wall plane z = 5
    const h = w.sweepSphere(pivot, desired, 0.35)!;
    const len = Math.hypot(desired.x - pivot.x, desired.y - pivot.y, desired.z - pivot.z);
    expect(h.t).toBeGreaterThan(0);
    expect(h.t).toBeLessThan(len);
    expect(h.point.z).toBeCloseTo(5 - 0.35, 9);
  });
});

// ---------------------------------------------------------------------------------------------
// sweepAABB
// ---------------------------------------------------------------------------------------------
describe('sweepAABB', () => {
  const H = v(HALF.x, HALF.y, HALF.z);
  const w = new World([
    box('floor', v(-50, -2, -50), v(50, 0, 50)),
    box('wall', v(10, 0, -50), v(12, 30, 50)),
    box('thin', v(-20, 0, -50), v(-19.98, 30, 50)),
  ]);

  it('approach with a gap: t is the exact fraction and the normal is the face normal', () => {
    const h = w.sweepAABB(v(5, 1.5, 0), H, v(6, 0, 0))!; // right face at x = 5.8, wall at 10 -> 10-0.8-5 = 4.2 of 6
    expect(h.t).toBeCloseTo(4.2 / 6, 12);
    expect(h.normal).toEqual(v(-1, 0, 0));
    expect(h.boxIndex).toBe(1);
  });

  it('diagonal approach to a pillar: the face with the later entry time is reported', () => {
    const p = new World([box('pillar', v(0, 0, 0), v(2, 2, 2))]);
    const h = p.sweepAABB(v(-2, -2, 1), v(0.5, 0.5, 0.5), v(4, 2, 0))!;
    expect(h.t).toBeCloseTo(0.75, 12); // y enters at 0.75, x already entered at 0.375
    expect(h.normal).toEqual(v(0, -1, 0));
    const h2 = p.sweepAABB(v(-2, -2, 1), v(0.5, 0.5, 0.5), v(2, 4, 0))!;
    expect(h2.t).toBeCloseTo(0.75, 12); // x enters at 0.75 (y at 0.375)
    expect(h2.normal).toEqual(v(-1, 0, 0));
    // passing the pillar with a 0.01 m margin is not a hit
    expect(p.sweepAABB(v(-2, -1.001, 1), v(0.5, 0.5, 0.5), v(8, 0, 0))).toBeNull();
  });

  it('landing: standing on the floor and moving down hits at t = 0 with normal +Y', () => {
    const h = w.sweepAABB(v(0, 1.5, 0), H, v(0, -0.01, 0))!;
    expect(h.t).toBe(0);
    expect(h.normal).toEqual(v(0, 1, 0));
    const fall = w.sweepAABB(v(0, 4, 0), H, v(0, -5, 0))!;
    expect(fall.t).toBeCloseTo(2.5 / 5, 12);
    expect(fall.normal).toEqual(v(0, 1, 0));
  });

  it('sliding along touching faces is not a hit (floor and wall), moving away is not a hit', () => {
    expect(w.sweepAABB(v(0, 1.5, 0), H, v(3, 0, 2))).toBeNull(); // on the floor
    expect(w.sweepAABB(v(9.2, 1.5, 0), H, v(0, 0, 5))).toBeNull(); // pressed against the wall
    expect(w.sweepAABB(v(9.2, 1.5, 0), H, v(-1, 0.5, 3))).toBeNull(); // leaving the wall
    expect(w.sweepAABB(v(0, 1.5, 0), H, v(1, 5, 0))).toBeNull(); // jumping off the floor
    expect(w.sweepAABB(v(9.2, 1.5, 0), H, v(0.5, 0, 0))!.t).toBe(0); // pushing into the wall
    expect(w.sweepAABB(v(9.2, 1.5, 0), H, v(0.5, 0, 0))!.normal).toEqual(v(-1, 0, 0));
  });

  it('a pure vertical / horizontal slide with a 1e-16 leftover component does not stick', () => {
    expect(w.sweepAABB(v(9.2, 1.5, 0), H, v(1e-16, 0, 4))).toBeNull();
    expect(w.sweepAABB(v(0, 1.5, 0), H, v(3, -1e-17, 0))).toBeNull();
  });

  it('no tunnelling through a 2 cm wall at 80 m/s (0.67 m per tick) from any side or angle', () => {
    const rng = new Rng(31);
    const step = 80 / 120;
    const wallMinX = -20 - 0.8; // inflated by the player half width
    const wallMaxX = -19.98 + 0.8;
    let hitsL = 0;
    let hitsR = 0;
    for (let i = 0; i < 4000; i++) {
      const fromLeft = i % 2 === 0;
      const c = v(fromLeft ? rng.range(wallMinX - 0.6, wallMinX - 0.001) : rng.range(wallMaxX + 0.001, wallMaxX + 0.6), rng.range(3, 20), rng.range(-30, 30));
      const dir = randomUnit(rng, 0);
      dir.x = (Math.abs(dir.x) + 0.02) * (fromLeft ? 1 : -1);
      const d = unit(dir);
      const delta = v(d.x * step, d.y * step, d.z * step);
      const endX = c.x + delta.x;
      const reaches = fromLeft ? endX > wallMinX : endX < wallMaxX;
      const h = w.sweepAABB(c, H, delta);
      if (reaches) {
        expect(h, JSON.stringify({ c, delta })).not.toBeNull();
        expect(h!.boxIndex).toBe(2);
        expect(h!.normal).toEqual(v(fromLeft ? -1 : 1, 0, 0));
        expect(h!.t).toBeGreaterThan(0);
        expect(h!.t).toBeLessThanOrEqual(1);
        if (fromLeft) hitsL++;
        else hitsR++;
      } else {
        expect(h).toBeNull();
      }
    }
    expect(hitsL).toBeGreaterThan(200);
    expect(hitsR).toBeGreaterThan(200);
    // gap 0.18 m to the (inflated) wall: hit after 0.18 / 0.667 of the step
    const back = w.sweepAABB(v(-19, 5, 0), H, v(-step, 0, 0))!;
    expect(back.normal).toEqual(v(1, 0, 0));
    expect(back.t).toBeCloseTo(0.18 / step, 9);
  });

  it('starting embedded by a hair: escaping / parallel motion is free, motion deeper hits t = 0', () => {
    for (const depth of [1e-13, 1e-9, 5e-8]) {
      // embedded in the floor by `depth`
      const c = v(0, 1.5 - depth, 0);
      expect(w.sweepAABB(c, H, v(2, 0, 0))).toBeNull();
      expect(w.sweepAABB(c, H, v(2, 3, 0))).toBeNull();
      const down = w.sweepAABB(c, H, v(0, -1, 0))!;
      expect(down.t).toBe(0);
      expect(down.normal).toEqual(v(0, 1, 0));
      // embedded in the wall by `depth`, pressed into the corner between floor and wall
      const c2 = v(10 - 0.8 + depth, 1.5 - depth, 0);
      expect(w.sweepAABB(c2, H, v(-1, 2, 3))).toBeNull();
      expect(w.sweepAABB(c2, H, v(0, 0, 3))).toBeNull();
      const into = w.sweepAABB(c2, H, v(1, 0, 0))!;
      expect(into.t).toBe(0);
      expect(into.normal).toEqual(v(-1, 0, 0));
      // the corner: moving both into the wall and down reports one of them (t = 0)
      const both = w.sweepAABB(c2, H, v(1, -1, 0))!;
      expect(both.t).toBe(0);
    }
  });

  it('embedded in two faces by different hairs: the wall still blocks even if the floor is the shallower one', () => {
    // 1e-13 into the floor (min-penetration axis is y) but 1e-9 into the wall: pushing into the wall must hit the wall
    const c = v(10 - 0.8 + 1e-9, 1.5 - 1e-13, 0);
    const into = w.sweepAABB(c, H, v(1, 0, 0))!;
    expect(into.t).toBe(0);
    expect(into.boxIndex).toBe(1);
    expect(into.normal).toEqual(v(-1, 0, 0));
    expect(w.sweepAABB(c, H, v(0, 0, 3))).toBeNull(); // sliding along the wall is still free
    // mirrored: deeper into the floor than into the wall
    const c2 = v(10 - 0.8 + 1e-13, 1.5 - 1e-9, 0);
    const down = w.sweepAABB(c2, H, v(0, -1, 0))!;
    expect(down.t).toBe(0);
    expect(down.boxIndex).toBe(0);
    expect(down.normal).toEqual(v(0, 1, 0));
    expect(w.sweepAABB(c2, H, v(0, 0, 3))).toBeNull();
  });

  it('touching two faces of the same box (top edge of the wall): blocks only when both move further in', () => {
    const top = 30 + HALF.y; // standing on top of the wall, right edge exactly on its side face, both embedded by a hair
    const c = v(10 - 0.8 + 1e-9, top - 1e-13, 0);
    expect(w.sweepAABB(c, H, v(1, 0, 0))).toBeNull(); // walking onto the top
    expect(w.sweepAABB(c, H, v(-1, -1, 0))).toBeNull(); // beside the wall, moving away from its side
    expect(w.sweepAABB(c, H, v(0, -1, 0))).toBeNull(); // sliding down along the side face
    expect(w.sweepAABB(c, H, v(1, 1, 0))).toBeNull();
    const both = w.sweepAABB(c, H, v(1, -1, 0))!;
    expect(both.t).toBe(0);
    expect(both.boxIndex).toBe(1);
    expect(Math.abs(both.normal.x) + Math.abs(both.normal.y)).toBe(1);
  });

  it('deeply embedded: only motion further in along the shortest exit blocks', () => {
    const c = v(0, 1.0, 0); // 0.5 into the floor
    expect(w.sweepAABB(c, H, v(0, 1, 0))).toBeNull();
    expect(w.sweepAABB(c, H, v(0, -1, 0))?.t).toBe(0);
  });

  it('zero delta never hits', () => {
    expect(w.sweepAABB(v(0, 1.5, 0), H, v(0, 0, 0))).toBeNull();
    expect(w.sweepAABB(v(11, 5, 0), H, v(0, 0, 0))).toBeNull();
  });

  it('ties between abutting floor tiles pick the lowest index, both report +Y at t = 0', () => {
    const t = new World([box('a', v(-10, -1, -10), v(0, 0, 10)), box('b', v(0, -1, -10), v(10, 0, 10))]);
    const h = t.sweepAABB(v(0, 1.5, 0), H, v(1, -0.5, 0))!;
    expect(h.t).toBe(0);
    expect(h.boxIndex).toBe(0);
    expect(h.normal).toEqual(v(0, 1, 0));
  });
});

// ---------------------------------------------------------------------------------------------
// overlapAABB / pointInSolid
// ---------------------------------------------------------------------------------------------
describe('overlapAABB / pointInSolid', () => {
  const w = new World([box('b', v(0, 0, 0), v(2, 2, 2)), box('far', v(100, 100, 100), v(101, 101, 101))]);
  it('margin semantics', () => {
    expect(w.overlapAABB(v(-0.5, 1, 1), v(0.5, 0.5, 0.5))).toBe(false); // exactly touching
    expect(w.overlapAABB(v(-0.5 + 2e-4, 1, 1), v(0.5, 0.5, 0.5))).toBe(true);
    expect(w.overlapAABB(v(-0.5 + 2e-4, 1, 1), v(0.5, 0.5, 0.5), 1e-3)).toBe(false);
    expect(w.overlapAABB(v(100.5, 100.5, 100.5), v(0.1, 0.1, 0.1))).toBe(true);
    w.setBoxEnabled(1, false);
    expect(w.overlapAABB(v(100.5, 100.5, 100.5), v(0.1, 0.1, 0.1))).toBe(false);
    w.setBoxEnabled(1, true);
  });
  it('pointInSolid is strict at the boundary and honours disabling', () => {
    expect(w.pointInSolid(v(1, 1, 1))).toBe(true);
    expect(w.pointInSolid(v(0, 1, 1))).toBe(false);
    expect(w.pointInSolid(v(2, 1, 1))).toBe(false);
    expect(w.pointInSolid(v(2.0001, 1, 1))).toBe(false);
    w.setBoxEnabled(0, false);
    expect(w.pointInSolid(v(1, 1, 1))).toBe(false);
    w.setBoxEnabled(0, true);
    expect(w.pointInSolid(v(1, 1, 1))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// API details / robustness
// ---------------------------------------------------------------------------------------------
describe('World API', () => {
  it('indexOfBox / isBoxEnabled / out-of-range indices', () => {
    const boxes = [box('a', v(0, 0, 0), v(1, 1, 1)), box('b', v(2, 0, 0), v(3, 1, 1))];
    const w = new World(boxes);
    expect(w.boxes).toBe(boxes);
    expect(w.indexOfBox('a')).toBe(0);
    expect(w.indexOfBox('b')).toBe(1);
    expect(w.indexOfBox('zzz')).toBe(-1);
    expect(w.isBoxEnabled(0)).toBe(true);
    w.setBoxEnabled(0, false);
    expect(w.isBoxEnabled(0)).toBe(false);
    w.setBoxEnabled(0, false); // idempotent
    w.setBoxEnabled(0, true);
    w.setBoxEnabled(0, true);
    expect(w.isBoxEnabled(0)).toBe(true);
    w.setBoxEnabled(7, false);
    w.setBoxEnabled(-1, false);
    w.setBoxEnabled(NaN, false);
    expect(w.isBoxEnabled(7)).toBe(false);
    expect(w.isBoxEnabled(-1)).toBe(false);
    expect(w.pointInSolid(v(0.5, 0.5, 0.5))).toBe(true);
    expect(w.boxes.length).toBe(2);
  });

  it('empty world and degenerate / invalid boxes', () => {
    const e = new World([]);
    expect(e.raycast(v(0, 0, 0), v(1, 0, 0), 10)).toBeNull();
    expect(e.segmentBlocked(v(0, 0, 0), v(5, 0, 0))).toBe(false);
    expect(e.sweepAABB(v(0, 0, 0), HALF, v(1, 0, 0))).toBeNull();
    expect(e.sweepSphere(v(0, 0, 0), v(1, 0, 0), 0.3)).toBeNull();
    expect(e.overlapAABB(v(0, 0, 0), HALF)).toBe(false);
    expect(e.pointInSolid(v(0, 0, 0))).toBe(false);
    const bad = new World([
      box('nan', v(NaN, 0, 0), v(1, 1, 1)),
      box('inf', v(0, 0, 0), v(Infinity, 1, 1)),
      box('inverted', v(5, 5, 5), v(4, 6, 6)),
      box('ok', v(10, 0, 0), v(11, 1, 1)),
    ]);
    expect(bad.raycast(v(-5, 0.5, 0.5), v(1, 0, 0), 100)?.boxIndex).toBe(3);
    expect(bad.pointInSolid(v(0.5, 0.5, 0.5))).toBe(false);
    expect(bad.segmentBlocked(v(-5, 0.5, 0.5), v(9, 0.5, 0.5))).toBe(false);
    bad.setBoxEnabled(0, false); // not indexed, must not corrupt anything
    bad.setBoxEnabled(0, true);
    expect(bad.raycast(v(-5, 0.5, 0.5), v(1, 0, 0), 100)?.boxIndex).toBe(3);
  });

  it('many identical boxes (degenerate BVH) and a 1-box world work', () => {
    const boxes: BoxDef[] = [];
    for (let i = 0; i < 2000; i++) boxes.push(box('d' + i, v(0, 0, 0), v(1, 1, 1)));
    const w = new World(boxes);
    expect(w.raycast(v(-2, 0.5, 0.5), v(1, 0, 0), 10)?.boxIndex).toBe(0);
    for (let i = 0; i < 1999; i++) w.setBoxEnabled(i, false);
    expect(w.raycast(v(-2, 0.5, 0.5), v(1, 0, 0), 10)?.boxIndex).toBe(1999);
    expect(w.segmentBlocked(v(-2, 0.5, 0.5), v(3, 0.5, 0.5))).toBe(true);
    w.setBoxEnabled(1999, false);
    expect(w.segmentBlocked(v(-2, 0.5, 0.5), v(3, 0.5, 0.5))).toBe(false);
  });

  it('works inside a real Game (arena with platform)', () => {
    const g = createArenaGame(undefined, { platforms: [{ id: 'p1', top: v(30, 10, 0), sizeX: 20, sizeZ: 20 }] });
    expect(g.world).toBeInstanceOf(World);
    expect(g.world.indexOfBox('p1')).toBe(1);
    const down = g.world.raycast(v(30, 20, 0), v(0, -1, 0), 100)!;
    expect(down.t).toBeCloseTo(10, 12);
    expect(g.world.boxes[down.boxIndex].id).toBe('p1');
    g.world.setBoxEnabled(1, false);
    expect(g.world.raycast(v(30, 20, 0), v(0, -1, 0), 100)?.t).toBeCloseTo(20, 12);
    for (let i = 0; i < 120; i++) g.step();
    expect(g.state.tick).toBe(120);
    const stage = buildTestArenaStage();
    expect(new World(stage.boxes).sweepAABB(v(0, 1.5, 0), H(), v(0, -2, 0))?.t).toBe(0);
  });
});

function H(): V3 {
  return v(HALF.x, HALF.y, HALF.z);
}

// ---------------------------------------------------------------------------------------------
// a player-like mover built only on World: never penetrates, never tunnels, never sticks
// ---------------------------------------------------------------------------------------------
describe('mover stability (slide loop on sweepAABB)', () => {
  function buildRoom(): BoxDef[] {
    const T = 0.1; // thin walls on purpose
    const boxes: BoxDef[] = [
      box('floor', v(-60, -2, -50), v(60, 0, 50)),
      box('ceil', v(-60, 40, -50), v(60, 40 + T, 50)),
      box('wx0', v(-60 - T, -2, -50), v(-60, 40 + T, 50)),
      box('wx1', v(60, -2, -50), v(60 + T, 40 + T, 50)),
      box('wz0', v(-60, -2, -50 - T), v(60, 40 + T, -50)),
      box('wz1', v(-60, -2, 50), v(60, 40 + T, 50 + T)),
      // seam-split copy of the floor top: two abutting tiles at the same height
      box('tileA', v(-10, 0, -10), v(0, 1, 10)),
      box('tileB', v(0, 0, -10), v(10, 1, 10)),
    ];
    const rng = new Rng(4242);
    for (let i = 0; i < 60; i++) {
      boxes.push(cbox('p' + i, v(rng.range(-55, 55), rng.range(1, 30), rng.range(-45, 45)), v(rng.range(0.5, 6), rng.range(0.5, 12), rng.range(0.5, 6))));
    }
    return boxes;
  }

  it('20000 ticks of 80 m/s bounces, gravity and wall pushing: no overlap, always inside the room', () => {
    const boxes = buildRoom();
    const w = new World(boxes);
    const rng = new Rng(99);
    const dt = 1 / 120;
    let pos = v(-40, 30, -40);
    // find a free spawn
    while (w.overlapAABB(pos, H(), 1e-6)) pos = v(rng.range(-50, 50), rng.range(5, 35), rng.range(-40, 40));
    let vel = v(0, 0, 0);
    let contacts = 0;
    let maxIter = 0;
    for (let tick = 0; tick < 20000; tick++) {
      if (tick % 90 === 0) {
        const dir = randomUnit(rng, 0.2);
        const sp = rng.next() < 0.5 ? 80 : rng.range(5, 30);
        vel = v(dir.x * sp, dir.y * sp * 0.5, dir.z * sp);
      }
      vel.y -= 18 * dt;
      let delta = v(vel.x * dt, vel.y * dt, vel.z * dt);
      let iter = 0;
      for (; iter < 8; iter++) {
        const hit = w.sweepAABB(pos, H(), delta);
        if (!hit) {
          pos = v(pos.x + delta.x, pos.y + delta.y, pos.z + delta.z);
          break;
        }
        contacts++;
        pos = v(pos.x + delta.x * hit.t, pos.y + delta.y * hit.t, pos.z + delta.z * hit.t);
        const rem = 1 - hit.t;
        let rx = delta.x * rem, ry = delta.y * rem, rz = delta.z * rem;
        const dn = rx * hit.normal.x + ry * hit.normal.y + rz * hit.normal.z;
        if (dn < 0) {
          rx -= hit.normal.x * dn;
          ry -= hit.normal.y * dn;
          rz -= hit.normal.z * dn;
        }
        const vn = vel.x * hit.normal.x + vel.y * hit.normal.y + vel.z * hit.normal.z;
        if (vn < 0) vel = v(vel.x - hit.normal.x * vn, vel.y - hit.normal.y * vn, vel.z - hit.normal.z * vn);
        delta = v(rx, ry, rz);
      }
      maxIter = Math.max(maxIter, iter);
      // invariants
      if (w.overlapAABB(pos, H(), 1e-6)) throw new Error(`penetrating at tick ${tick}: ${JSON.stringify(pos)}`);
      if (!(pos.x > -59.2 - 1e-6 && pos.x < 59.2 + 1e-6 && pos.z > -49.2 - 1e-6 && pos.z < 49.2 + 1e-6 && pos.y > 1.49 && pos.y < 38.5 + 1e-6)) {
        throw new Error(`escaped the room at tick ${tick}: ${JSON.stringify(pos)}`);
      }
    }
    expect(contacts).toBeGreaterThan(1000);
    expect(maxIter).toBeLessThan(8); // the slide loop always converges (no endless t = 0 ping-pong)
  });
});

// ---------------------------------------------------------------------------------------------
// performance
// ---------------------------------------------------------------------------------------------
/** stage-like world: 5x4 rooms of 60x40x20, 2 m thick shell, ~294 props each => 6000 boxes */
function stageLikeBoxes(rng: Rng): BoxDef[] {
  const boxes: BoxDef[] = [];
  const RW = 60, RD = 50, RH = 20, T = 2;
  for (let gx = 0; gx < 5; gx++) {
    for (let gz = 0; gz < 4; gz++) {
      const x0 = gx * RW, z0 = gz * RD;
      const id = `R${gx}${gz}`;
      boxes.push(box(id + 'f', v(x0, -T, z0), v(x0 + RW, 0, z0 + RD)));
      boxes.push(box(id + 'c', v(x0, RH, z0), v(x0 + RW, RH + T, z0 + RD)));
      boxes.push(box(id + 'w0', v(x0, 0, z0), v(x0 + T, RH, z0 + RD)));
      boxes.push(box(id + 'w1', v(x0 + RW - T, 0, z0), v(x0 + RW, RH, z0 + RD)));
      boxes.push(box(id + 'w2', v(x0 + T, 0, z0), v(x0 + RW - T, RH, z0 + T)));
      boxes.push(box(id + 'w3', v(x0 + T, 0, z0 + RD - T), v(x0 + RW - T, RH, z0 + RD)));
      for (let i = 0; i < 294; i++) {
        const s = v(rng.range(0.5, 8), rng.range(0.5, 10), rng.range(0.5, 8));
        boxes.push(cbox(`${id}p${i}`, v(x0 + rng.range(6, RW - 6), rng.range(0, RH - 2) + s.y / 2, z0 + rng.range(6, RD - 6)), s));
      }
    }
  }
  return boxes;
}

describe('performance (loose thresholds; numbers are printed)', () => {
  const rng = new Rng(2024);
  const boxes = stageLikeBoxes(rng);
  let w: World;
  const N = 100_000;

  /** free-space point (not inside any box) inside a room */
  const free = (r: Rng): V3 => {
    for (;;) {
      const p = v(r.range(2, 298), r.range(1, 19), r.range(2, 198));
      if (!w.pointInSolid(p)) return p;
    }
  };
  const inRoom = (): V3 => free(rng);

  it('builds a 6000-box index quickly', () => {
    expect(boxes.length).toBe(6000);
    const t0 = performance.now();
    w = new World(boxes);
    const ms = performance.now() - t0;
    console.log(`[perf] build ${boxes.length} boxes: ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(1500);
  });

  const measure = (name: string, fn: () => number, limitMs: number): void => {
    // warm up JIT
    fn();
    const t0 = performance.now();
    const hits = fn();
    const ms = performance.now() - t0;
    console.log(`[perf] ${name}: ${N} queries in ${ms.toFixed(1)} ms (${((ms * 1000) / N).toFixed(2)} us/query), hits=${hits}`);
    expect(ms).toBeLessThan(limitMs);
  };

  it('raycast x100k', () => {
    const r = new Rng(1);
    const os: V3[] = [], ds: V3[] = [];
    for (let i = 0; i < N; i++) {
      os.push(free(r));
      ds.push(randomUnit(r));
    }
    measure('raycast (maxDist 500)', () => {
      let h = 0;
      for (let i = 0; i < N; i++) if (w.raycast(os[i], ds[i], 500)) h++;
      return h;
    }, 4000);
  });

  it('segmentBlocked x100k (LOS-like, up to 120 m)', () => {
    const r = new Rng(2);
    const as: V3[] = [], bs: V3[] = [];
    for (let i = 0; i < N; i++) {
      const a = free(r);
      const d = randomUnit(r);
      const l = r.range(5, 120);
      as.push(a);
      bs.push(v(a.x + d.x * l, a.y + d.y * l, a.z + d.z * l));
    }
    measure('segmentBlocked', () => {
      let h = 0;
      for (let i = 0; i < N; i++) if (w.segmentBlocked(as[i], bs[i])) h++;
      return h;
    }, 4000);
  });

  it('sweepSphere x100k (bullets: 0.06-0.3 m over one tick)', () => {
    const r = new Rng(3);
    const as: V3[] = [], bs: V3[] = [], rs: number[] = [];
    for (let i = 0; i < N; i++) {
      const a = free(r);
      const d = randomUnit(r);
      const l = r.range(0.3, 0.9);
      as.push(a);
      bs.push(v(a.x + d.x * l, a.y + d.y * l, a.z + d.z * l));
      rs.push(r.range(0.06, 0.3));
    }
    measure('sweepSphere (one tick)', () => {
      let h = 0;
      for (let i = 0; i < N; i++) if (w.sweepSphere(as[i], bs[i], rs[i])) h++;
      return h;
    }, 4000);
  });

  it('sweepAABB x100k (player-like, up to 0.67 m)', () => {
    const r = new Rng(4);
    const cs: V3[] = [], ds: V3[] = [];
    for (let i = 0; i < N; i++) {
      cs.push(free(r));
      const d = randomUnit(r);
      const l = r.range(0, 0.67);
      ds.push(v(d.x * l, d.y * l, d.z * l));
    }
    measure('sweepAABB', () => {
      let h = 0;
      for (let i = 0; i < N; i++) if (w.sweepAABB(cs[i], H(), ds[i])) h++;
      return h;
    }, 4000);
  });

  it('overlapAABB / pointInSolid x100k', () => {
    const r = new Rng(5);
    const cs: V3[] = [];
    for (let i = 0; i < N; i++) cs.push(free(r));
    measure('overlapAABB', () => {
      let h = 0;
      for (let i = 0; i < N; i++) if (w.overlapAABB(cs[i], H())) h++;
      return h;
    }, 4000);
    const rp = new Rng(8);
    const ps: V3[] = [];
    for (let i = 0; i < N; i++) ps.push(v(rp.range(2, 298), rp.range(1, 19), rp.range(2, 198)));
    measure('pointInSolid', () => {
      let h = 0;
      for (let i = 0; i < N; i++) if (w.pointInSolid(ps[i])) h++;
      return h;
    }, 4000);
  });

  it('is much faster than the linear scan and agrees with it on sampled queries', () => {
    const ref = new NaiveWorld(boxes);
    const r = new Rng(6);
    const M = 3000;
    const os: V3[] = [], ds: V3[] = [];
    for (let i = 0; i < M; i++) {
      os.push(inRoom());
      ds.push(randomUnit(r));
    }
    let t0 = performance.now();
    const refHits = os.map((o, i) => ref.raycast(o, ds[i], 500));
    const naiveMs = performance.now() - t0;
    t0 = performance.now();
    const hits = os.map((o, i) => w.raycast(o, ds[i], 500));
    const fastMs = performance.now() - t0;
    console.log(`[perf] ${M} raycasts: linear ${naiveMs.toFixed(1)} ms vs indexed ${fastMs.toFixed(1)} ms`);
    const bad: Mismatch[] = [];
    for (let i = 0; i < M; i++) {
      const m1 = hitDiff('raycast', hits[i], refHits[i], true, { o: os[i], d: ds[i] });
      if (m1) bad.push(m1);
    }
    expectNoMismatch(bad);
    expect(fastMs).toBeLessThan(naiveMs);
  });

  it('enable/disable toggling is cheap and keeps results consistent', () => {
    const ref = new NaiveWorld(boxes);
    const local = new World(boxes);
    const r = new Rng(7);
    const t0 = performance.now();
    for (let k = 0; k < 200_000; k++) local.setBoxEnabled(r.int(0, boxes.length - 1), r.next() < 0.5);
    const ms = performance.now() - t0;
    console.log(`[perf] 200000 setBoxEnabled: ${ms.toFixed(1)} ms`);
    for (let i = 0; i < boxes.length; i++) ref.setBoxEnabled(i, local.isBoxEnabled(i));
    const bad: Mismatch[] = [];
    for (let i = 0; i < 1500; i++) {
      const o = inRoom();
      const d = randomUnit(r);
      const m1 = hitDiff('raycast', local.raycast(o, d, 300), ref.raycast(o, d, 300), true, { o, d });
      if (m1) bad.push(m1);
    }
    expectNoMismatch(bad);
    expect(ms).toBeLessThan(2000);
  });
});
