// Collision world: static axis-aligned boxes with a XZ spatial hash broadphase.
// Used by BOTH the browser game and the Node test harness — no DOM/three deps.

export class World {
  constructor() {
    this.boxes = [];       // {min:[x,y,z], max:[x,y,z], kind, sectorId, disabled, barrierId}
    this.cell = 25;        // broadphase cell size
    this.grid = new Map(); // "cx,cz" -> [boxIndex]
  }

  addBox(min, max, opts = {}) {
    const box = {
      min: [min[0], min[1], min[2]],
      max: [max[0], max[1], max[2]],
      kind: opts.kind || 'wall',
      sectorId: opts.sectorId || null,
      barrierId: opts.barrierId || null,
      disabled: false,
    };
    this.boxes.push(box);
    return box;
  }

  finalize() {
    this.grid.clear();
    for (let i = 0; i < this.boxes.length; i++) {
      const b = this.boxes[i];
      const cx0 = Math.floor(b.min[0] / this.cell), cx1 = Math.floor(b.max[0] / this.cell);
      const cz0 = Math.floor(b.min[2] / this.cell), cz1 = Math.floor(b.max[2] / this.cell);
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cz = cz0; cz <= cz1; cz++) {
          const k = cx + ',' + cz;
          let arr = this.grid.get(k);
          if (!arr) { arr = []; this.grid.set(k, arr); }
          arr.push(i);
        }
      }
    }
  }

  _candidatesForAABB(minX, minZ, maxX, maxZ, out) {
    const cx0 = Math.floor(minX / this.cell), cx1 = Math.floor(maxX / this.cell);
    const cz0 = Math.floor(minZ / this.cell), cz1 = Math.floor(maxZ / this.cell);
    out.length = 0;
    const seen = this._seen || (this._seen = new Set());
    seen.clear();
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const arr = this.grid.get(cx + ',' + cz);
        if (!arr) continue;
        for (const i of arr) {
          if (!seen.has(i)) { seen.add(i); out.push(i); }
        }
      }
    }
    return out;
  }

  // Ray vs single box (slab test). Returns t in [0,1] and axis of hit, or -1.
  static rayBox(px, py, pz, dx, dy, dz, min, max) {
    let tmin = 0, tmax = 1, axis = -1, sign = 0;
    const p = [px, py, pz], d = [dx, dy, dz];
    for (let a = 0; a < 3; a++) {
      const inv = 1 / d[a];
      let t0 = (min[a] - p[a]) * inv;
      let t1 = (max[a] - p[a]) * inv;
      let s = -1;
      if (t0 > t1) { const tt = t0; t0 = t1; t1 = tt; s = 1; }
      if (t0 > tmin) { tmin = t0; axis = a; sign = s; }
      if (t1 < tmax) tmax = t1;
      if (tmin > tmax) return -1;
    }
    if (axis === -1) return -1; // started inside
    return tmin;
  }

  // Nearest static hit along segment p0->p1. Returns {t, point:[x,y,z], normal:[..], box} or null.
  raycastSegment(p0, p1) {
    const dx = p1[0] - p0[0], dy = p1[1] - p0[1], dz = p1[2] - p0[2];
    const minX = Math.min(p0[0], p1[0]) - 0.5, maxX = Math.max(p0[0], p1[0]) + 0.5;
    const minZ = Math.min(p0[2], p1[2]) - 0.5, maxZ = Math.max(p0[2], p1[2]) + 0.5;
    const cand = this._candidatesForAABB(minX, minZ, maxX, maxZ, this._tmp1 || (this._tmp1 = []));
    let best = -1, bestBox = null;
    const minY = Math.min(p0[1], p1[1]), maxY = Math.max(p0[1], p1[1]);
    for (const i of cand) {
      const b = this.boxes[i];
      if (b.disabled) continue;
      if (b.max[1] < minY || b.min[1] > maxY) continue;
      const t = World.rayBox(p0[0], p0[1], p0[2], dx, dy, dz, b.min, b.max);
      if (t >= 0 && (best < 0 || t < best)) { best = t; bestBox = b; }
    }
    if (best < 0) return null;
    // normal at hit point
    const hx = p0[0] + dx * best, hy = p0[1] + dy * best, hz = p0[2] + dz * best;
    const n = [0, 0, 0];
    const b = bestBox;
    const eps = 1e-4;
    if (Math.abs(hx - b.min[0]) < eps) n[0] = -1; else if (Math.abs(hx - b.max[0]) < eps) n[0] = 1;
    else if (Math.abs(hy - b.min[1]) < eps) n[1] = -1; else if (Math.abs(hy - b.max[1]) < eps) n[1] = 1;
    else if (Math.abs(hz - b.min[2]) < eps) n[2] = -1; else if (Math.abs(hz - b.max[2]) < eps) n[2] = 1;
    return { t: best, point: [hx, hy, hz], normal: n, box: b };
  }

  lineOfSight(p0, p1) {
    const dx = p1[0] - p0[0], dy = p1[1] - p0[1], dz = p1[2] - p0[2];
    const minX = Math.min(p0[0], p1[0]) - 0.5, maxX = Math.max(p0[0], p1[0]) + 0.5;
    const minZ = Math.min(p0[2], p1[2]) - 0.5, maxZ = Math.max(p0[2], p1[2]) + 0.5;
    const cand = this._candidatesForAABB(minX, minZ, maxX, maxZ, this._tmp2 || (this._tmp2 = []));
    const minY = Math.min(p0[1], p1[1]), maxY = Math.max(p0[1], p1[1]);
    for (const i of cand) {
      const b = this.boxes[i];
      if (b.disabled) continue;
      if (b.max[1] < minY || b.min[1] > maxY) continue;
      if (World.rayBox(p0[0], p0[1], p0[2], dx, dy, dz, b.min, b.max) >= 0) return false;
    }
    return true;
  }

  // Move an AABB (min corner `pos`, size `ext`) by delta [dx,dy,dz], axis-sequential swept.
  // Returns { pos:[newMin], hitX, hitYPos(hitTop), hitYNeg(hitFloor), grounded, hitWall }
  // delta applied component-wise; each axis clamps at first contact.
  sweepAABB(pos, ext, delta, skin = 0.001) {
    const out = pos.slice();
    let hitWall = false, grounded = false, hitCeil = false;
    // per-axis swept move, processed in order: X, Z, Y
    for (const a of [0, 2, 1]) {
      const d = delta[a];
      if (d === 0) continue;
      const pmin = [out[0], out[1], out[2]];
      const pmax = [out[0] + ext[0], out[1] + ext[1], out[2] + ext[2]];
      const sw0 = a === 0 ? Math.min(pmin[0], pmin[0] + d) - 1 : pmin[0] - 1;
      const sw1 = a === 0 ? Math.max(pmax[0], pmax[0] + d) + 1 : pmax[0] + 1;
      const sz0 = a === 2 ? Math.min(pmin[2], pmin[2] + d) - 1 : pmin[2] - 1;
      const sz1 = a === 2 ? Math.max(pmax[2], pmax[2] + d) + 1 : pmax[2] + 1;
      const cand = this._candidatesForAABB(sw0, sz0, sw1, sz1, this._tmp3 || (this._tmp3 = []));
      const o1 = (a + 1) % 3, o2 = (a + 2) % 3;
      let tMin = 1, hitBox = null;
      for (const i of cand) {
        const b = this.boxes[i];
        if (b.disabled) continue;
        // overlap required in the other two axes
        if (pmin[o1] >= b.max[o1] - 1e-9 || pmax[o1] <= b.min[o1] + 1e-9) continue;
        if (pmin[o2] >= b.max[o2] - 1e-9 || pmax[o2] <= b.min[o2] + 1e-9) continue;
        let entry;
        if (d > 0) entry = (b.min[a] - pmax[a]) / d;
        else entry = (b.max[a] - pmin[a]) / d;
        if (entry < 0) {
          // already overlapping the slab: blocks immediately
          if (pmax[a] > b.min[a] && pmin[a] < b.max[a]) entry = 0;
          else continue;
        }
        if (entry < tMin) { tMin = entry; hitBox = b; }
      }
      if (tMin < 1 && hitBox) {
        out[a] = pos[a] + d * Math.max(0, tMin) - Math.sign(d) * skin;
        if (a === 1) { if (d < 0) grounded = true; else hitCeil = true; }
        else hitWall = true;
      } else {
        out[a] += d;
      }
    }
    // resting-contact probe: when the Y axis wasn't swept (or was swept with
    // no downward hit), still report grounded if something supports us.
    if (!grounded && delta[1] <= 0) {
      const pmin = [out[0], out[1], out[2]];
      const pmax = [out[0] + ext[0], out[1] + ext[1], out[2] + ext[2]];
      const cand = this._candidatesForAABB(pmin[0] - 1, pmin[2] - 1, pmax[0] + 1, pmax[2] + 1,
        this._tmp6 || (this._tmp6 = []));
      for (const i of cand) {
        const b = this.boxes[i];
        if (b.disabled) continue;
        if (pmin[0] >= b.max[0] - 1e-9 || pmax[0] <= b.min[0] + 1e-9) continue;
        if (pmin[2] >= b.max[2] - 1e-9 || pmax[2] <= b.min[2] + 1e-9) continue;
        if (pmin[1] >= b.max[1] - skin * 10 && pmin[1] <= b.max[1] + skin * 10) { grounded = true; break; }
      }
    }
    return { pos: out, grounded, hitCeil, hitWall };
  }

  // Highest floor top at (x,z) with top <= refY + maxStepUp.
  groundHeightAt(x, z, refY, maxStepUp = 1.0) {
    let best = -Infinity;
    const cand = this._candidatesForAABB(x - 0.1, z - 0.1, x + 0.1, z + 0.1, this._tmp4 || (this._tmp4 = []));
    for (const i of cand) {
      const b = this.boxes[i];
      if (b.disabled) continue;
      if (x < b.min[0] || x > b.max[0] || z < b.min[2] || z > b.max[2]) continue;
      const top = b.max[1];
      if (top <= refY + maxStepUp && top > best) best = top;
    }
    return best;
  }

  isPointInSolid(x, y, z) {
    const cand = this._candidatesForAABB(x, z, x, z, this._tmp5 || (this._tmp5 = []));
    for (const i of cand) {
      const b = this.boxes[i];
      if (b.disabled) continue;
      if (x >= b.min[0] && x <= b.max[0] && y >= b.min[1] && y <= b.max[1] && z >= b.min[2] && z <= b.max[2]) return true;
    }
    return false;
  }
}

// Swept point vs linearly-moving sphere. Point travels p0->p1, sphere center c0->c1.
// Returns earliest tau in [0,1] or null.
export function sweptPointSphere(p0, p1, c0, c1, radius) {
  const rx = p0[0] - c0[0], ry = p0[1] - c0[1], rz = p0[2] - c0[2];
  const vx = (p1[0] - p0[0]) - (c1[0] - c0[0]);
  const vy = (p1[1] - p0[1]) - (c1[1] - c0[1]);
  const vz = (p1[2] - p0[2]) - (c1[2] - c0[2]);
  const a = vx * vx + vy * vy + vz * vz;
  const r0 = rx * rx + ry * ry + rz * rz - radius * radius;
  if (r0 <= 0) return 0; // already touching
  if (a < 1e-12) return null;
  const b = 2 * (rx * vx + ry * vy + rz * vz);
  if (b >= 0) return null; // moving away
  const disc = b * b - 4 * a * r0;
  if (disc < 0) return null;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  if (t < 0 || t > 1) return null;
  return t;
}
