/** Axis aligned box collision primitives + spatial hash. */

export interface Box {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  /** optional visual tag */
  tag?: string;
}

export function makeBox(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, tag?: string): Box {
  return { minX, minY, minZ, maxX, maxY, maxZ, tag };
}

export function boxOverlaps(a: Box, b: Box): boolean {
  return (
    a.minX < b.maxX &&
    a.maxX > b.minX &&
    a.minY < b.maxY &&
    a.maxY > b.minY &&
    a.minZ < b.maxZ &&
    a.maxZ > b.minZ
  );
}

export function pointInBox(x: number, y: number, z: number, b: Box, pad = 0): boolean {
  return x >= b.minX - pad && x <= b.maxX + pad && y >= b.minY - pad && y <= b.maxY + pad && z >= b.minZ - pad && z <= b.maxZ + pad;
}

/** Slab test: distance along `d` (unit) where the ray enters the box, or -1. */
export function rayBox(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  b: Box,
  maxT: number
): number {
  let tmin = 0;
  let tmax = maxT;
  // X
  if (Math.abs(dx) < 1e-9) {
    if (ox < b.minX || ox > b.maxX) return -1;
  } else {
    const inv = 1 / dx;
    let t1 = (b.minX - ox) * inv;
    let t2 = (b.maxX - ox) * inv;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  // Y
  if (Math.abs(dy) < 1e-9) {
    if (oy < b.minY || oy > b.maxY) return -1;
  } else {
    const inv = 1 / dy;
    let t1 = (b.minY - oy) * inv;
    let t2 = (b.maxY - oy) * inv;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  // Z
  if (Math.abs(dz) < 1e-9) {
    if (oz < b.minZ || oz > b.maxZ) return -1;
  } else {
    const inv = 1 / dz;
    let t1 = (b.minZ - oz) * inv;
    let t2 = (b.maxZ - oz) * inv;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  return tmin;
}

/** Uniform grid over the XZ plane; boxes are stored in every cell they touch. */
export class SpatialHash {
  private cell = 18;
  private map = new Map<number, Box[]>();

  private key(cx: number, cz: number): number {
    return (cx + 4096) * 16384 + (cz + 4096);
  }

  insert(box: Box): void {
    const x0 = Math.floor(box.minX / this.cell);
    const x1 = Math.floor(box.maxX / this.cell);
    const z0 = Math.floor(box.minZ / this.cell);
    const z1 = Math.floor(box.maxZ / this.cell);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const k = this.key(cx, cz);
        let arr = this.map.get(k);
        if (!arr) {
          arr = [];
          this.map.set(k, arr);
        }
        arr.push(box);
      }
    }
  }

  /** All boxes in the cells overlapped by the given XZ rect. */
  queryRect(minX: number, minZ: number, maxX: number, maxZ: number, out: Box[] = []): Box[] {
    out.length = 0;
    const x0 = Math.floor(minX / this.cell);
    const x1 = Math.floor(maxX / this.cell);
    const z0 = Math.floor(minZ / this.cell);
    const z1 = Math.floor(maxZ / this.cell);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const arr = this.map.get(this.key(cx, cz));
        if (!arr) continue;
        for (const b of arr) if (!out.includes(b)) out.push(b);
      }
    }
    return out;
  }

  /** Boxes along a ray segment (XZ cell walk). */
  queryRay(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number, out: Box[] = []): Box[] {
    out.length = 0;
    const ex = ox + dx * maxT;
    const ez = oz + dz * maxT;
    const minX = Math.min(ox, ex);
    const maxX = Math.max(ox, ex);
    const minZ = Math.min(oz, ez);
    const maxZ = Math.max(oz, ez);
    const x0 = Math.floor(minX / this.cell);
    const x1 = Math.floor(maxX / this.cell);
    const z0 = Math.floor(minZ / this.cell);
    const z1 = Math.floor(maxZ / this.cell);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const arr = this.map.get(this.key(cx, cz));
        if (!arr) continue;
        for (const b of arr) if (!out.includes(b)) out.push(b);
      }
    }
    return out;
  }
}

export interface RayHit {
  hit: boolean;
  distance: number;
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  box: Box | null;
}

const NO_HIT: RayHit = { hit: false, distance: Infinity, x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, box: null };

export function raycastWorld(
  hash: SpatialHash,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxT: number,
  skip?: (b: Box) => boolean
): RayHit {
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-9) return NO_HIT;
  dx /= len;
  dy /= len;
  dz /= len;
  const candidates = hash.queryRay(ox, oy, oz, dx, dy, dz, maxT);
  let best = maxT;
  let bestBox: Box | null = null;
  for (const b of candidates) {
    if (skip && skip(b)) continue;
    const t = rayBox(ox, oy, oz, dx, dy, dz, b, best);
    if (t >= 0 && t < best) {
      best = t;
      bestBox = b;
    }
  }
  if (!bestBox) return { ...NO_HIT, distance: maxT };
  const x = ox + dx * best;
  const y = oy + dy * best;
  const z = oz + dz * best;
  // face normal from the closest point on the box
  const cx = Math.max(bestBox.minX, Math.min(x, bestBox.maxX));
  const cy = Math.max(bestBox.minY, Math.min(y, bestBox.maxY));
  const cz = Math.max(bestBox.minZ, Math.min(z, bestBox.maxZ));
  let nx = 0;
  let ny = 0;
  let nz = 0;
  const eps = 1e-4;
  if (Math.abs(x - cx) < eps) nx = x - bestBox.minX < bestBox.maxX - x ? -1 : 1;
  else if (Math.abs(y - cy) < eps) ny = y - bestBox.minY < bestBox.maxY - y ? -1 : 1;
  else if (Math.abs(z - cz) < eps) nz = z - bestBox.minZ < bestBox.maxZ - z ? -1 : 1;
  else nx = -dx;
  return { hit: true, distance: best, x, y, z, nx, ny, nz, box: bestBox };
}

/** Move an AABB by (vx,vy,vz) resolving axis by axis. */
export interface MoveResult {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  grounded: boolean;
  hitWall: boolean;
  hitCeiling: boolean;
}

export function moveAabb(
  hash: SpatialHash,
  x: number,
  y: number,
  z: number,
  hx: number,
  hy: number,
  hz: number,
  vx: number,
  vy: number,
  vz: number,
  dt: number,
  scratch: Box[]
): MoveResult {
  let px = x;
  let py = y;
  let pz = z;
  let grounded = false;
  let hitWall = false;
  let hitCeiling = false;

  const probe = (cx: number, cy: number, cz: number): Box | null => {
    const cand = hash.queryRect(cx - hx, cz - hz, cx + hx, cz + hz, scratch);
    for (const b of cand) {
      if (boxOverlaps(b, { minX: cx - hx, minY: cy - hy, minZ: cz - hz, maxX: cx + hx, maxY: cy + hy, maxZ: cz + hz })) {
        return b;
      }
    }
    return null;
  };

  // --- Y ---
  const ny = py + vy * dt;
  let hit = probe(px, ny, pz);
  if (hit) {
    if (vy <= 0) {
      py = hit.maxY + hy;
      grounded = true;
    } else {
      py = hit.minY - hy;
      hitCeiling = true;
    }
    vy = 0;
  } else {
    py = ny;
  }

  // --- X ---
  const nx = px + vx * dt;
  hit = probe(nx, py, pz);
  if (hit) {
    if (vx > 0) px = hit.minX - hx;
    else px = hit.maxX + hx;
    vx = 0;
    hitWall = true;
  } else {
    px = nx;
  }

  // --- Z ---
  const nz = pz + vz * dt;
  hit = probe(px, py, nz);
  if (hit) {
    if (vz > 0) pz = hit.minZ - hz;
    else pz = hit.maxZ + hz;
    vz = 0;
    hitWall = true;
  } else {
    pz = nz;
  }

  return { x: px, y: py, z: pz, vx, vy, vz, grounded, hitWall, hitCeiling };
}

/** Segment vs sphere test (used for bullets vs hit spheres). */
export function segmentSphere(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
  radius: number
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const fx = ax - cx;
  const fy = ay - cy;
  const fz = az - cz;
  const a = dx * dx + dy * dy + dz * dz;
  if (a < 1e-12) return fx * fx + fy * fy + fz * fz <= radius * radius ? 0 : -1;
  const b = 2 * (fx * dx + fy * dy + fz * dz);
  const c = fx * fx + fy * fy + fz * fz - radius * radius;
  let disc = b * b - 4 * a * c;
  if (disc < 0) return -1;
  disc = Math.sqrt(disc);
  const t1 = (-b - disc) / (2 * a);
  const t2 = (-b + disc) / (2 * a);
  if (t1 >= 0 && t1 <= 1) return t1;
  if (t2 >= 0 && t2 <= 1) return t2;
  return -1;
}
