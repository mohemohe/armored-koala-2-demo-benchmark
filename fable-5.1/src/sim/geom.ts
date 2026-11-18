/**
 * 幾何プリミティブ（レイ/線分と AABB・球、掃引球と移動する球/AABB）。
 * Three.js に依存しない。すべて Vec3 = [x, y, z] タプル。
 */
import type { AABB, Vec3 } from '../types';

/** 方向成分がこの値未満なら「その軸に平行」とみなす */
const PARALLEL_EPS = 1e-12;

export interface SlabHit {
  /** 開始点からの割合（線分）または距離（レイ）。開始時に内部なら 0 */
  t: number;
  /** 進入した面の法線（軸に平行な単位ベクトル） */
  normal: Vec3;
}

/** 方向 d の絶対値が最大の軸へ、d と逆向きの単位軸ベクトル。d が零なら +Y */
function backAlongDominantAxis(dx: number, dy: number, dz: number): Vec3 {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  const az = Math.abs(dz);
  if (ax === 0 && ay === 0 && az === 0) return [0, 1, 0];
  if (ax >= ay && ax >= az) return [dx > 0 ? -1 : 1, 0, 0];
  if (ay >= az) return [0, dy > 0 ? -1 : 1, 0];
  return [0, 0, dz > 0 ? -1 : 1];
}

/**
 * スラブ法の中核。開始点 (ox,oy,oz) から方向 (dx,dy,dz) へ t∈[0, tLimit] の範囲で
 * AABB [min,max] との最初の交差を求める。
 * - 開始点が内部（境界含む）にあり、かつ内部へ進む/滑る場合は t=0（法線は進行方向の主軸の逆向き）。
 *   tLimit=0 でも内部なら t=0（内部判定は tLimit で切らないスラブ脱出割合で行う）
 * - 境界上にあって離れていく場合は null
 * - 境界上にあって進入する場合は t=0 で進入面の法線
 * - 境界は閉じている（面に沿って滑る・辺や角をかすめる・終点が面に触れる線分も「交差」）。
 *   LOS/弾体の掃引には保守的で安全な扱い（隣接する 2 箱の継ぎ目の平面に沿う線分も遮蔽になる）
 * - 開始点または方向に非有限（NaN/±Infinity）の成分があれば null
 */
export function slabIntersect(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
  tLimit: number,
): SlabHit | null {
  if (
    !(
      Number.isFinite(ox) &&
      Number.isFinite(oy) &&
      Number.isFinite(oz) &&
      Number.isFinite(dx) &&
      Number.isFinite(dy) &&
      Number.isFinite(dz)
    )
  ) {
    return null;
  }
  let tmin = -Infinity;
  // スラブの脱出割合。tLimit で切らずに保持し、「内部/境界上」の判定に使う
  let tmax = Infinity;
  let axis = -1;
  let axisSign = 0;

  // X
  if (Math.abs(dx) < PARALLEL_EPS) {
    if (ox < minX || ox > maxX) return null;
  } else {
    const inv = 1 / dx;
    let t1 = (minX - ox) * inv;
    let t2 = (maxX - ox) * inv;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > tmin) {
      tmin = t1;
      axis = 0;
      axisSign = dx > 0 ? -1 : 1;
    }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  // Y
  if (Math.abs(dy) < PARALLEL_EPS) {
    if (oy < minY || oy > maxY) return null;
  } else {
    const inv = 1 / dy;
    let t1 = (minY - oy) * inv;
    let t2 = (maxY - oy) * inv;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > tmin) {
      tmin = t1;
      axis = 1;
      axisSign = dy > 0 ? -1 : 1;
    }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  // Z
  if (Math.abs(dz) < PARALLEL_EPS) {
    if (oz < minZ || oz > maxZ) return null;
  } else {
    const inv = 1 / dz;
    let t1 = (minZ - oz) * inv;
    let t2 = (maxZ - oz) * inv;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > tmin) {
      tmin = t1;
      axis = 2;
      axisSign = dz > 0 ? -1 : 1;
    }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }

  if (tmax < 0) return null; // 箱は後方
  if (tmin < 0) {
    // 開始点が内部または境界上。境界上で離れていくなら交差なし（tLimit に依存しない）
    if (tmax <= 0) return null;
    return { t: 0, normal: backAlongDominantAxis(dx, dy, dz) };
  }
  if (tmin > tLimit) return null; // 進入が範囲外
  if (axis < 0) {
    // 全軸に平行で内部（方向が零）
    return { t: 0, normal: backAlongDominantAxis(dx, dy, dz) };
  }
  const normal: Vec3 = [0, 0, 0];
  normal[axis] = axisSign;
  return { t: tmin, normal };
}

/** レイ（単位方向 dir、最大距離 maxDist）と AABB の最初の交点。原点が内部なら t=0 */
export function rayAABB(origin: Vec3, dir: Vec3, box: AABB, maxDist: number): { t: number; normal: Vec3 } | null {
  if (!(maxDist >= 0)) return null;
  return slabIntersect(
    origin[0],
    origin[1],
    origin[2],
    dir[0],
    dir[1],
    dir[2],
    box.min[0],
    box.min[1],
    box.min[2],
    box.max[0],
    box.max[1],
    box.max[2],
    maxDist,
  );
}

/** レイと球の最初の交点までの距離。原点が内部（表面含む）なら 0。交差しなければ null。非有限の入力は null */
export function raySphere(origin: Vec3, dir: Vec3, center: Vec3, radius: number, maxDist: number): number | null {
  if (!(maxDist >= 0)) return null;
  if (!(Number.isFinite(dir[0]) && Number.isFinite(dir[1]) && Number.isFinite(dir[2]))) return null;
  const mx = origin[0] - center[0];
  const my = origin[1] - center[1];
  const mz = origin[2] - center[2];
  const c = mx * mx + my * my + mz * mz - radius * radius;
  if (c <= 0) return 0;
  const b = mx * dir[0] + my * dir[1] + mz * dir[2];
  if (b > 0) return null; // 外側で遠ざかる
  const a = dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2];
  if (a < PARALLEL_EPS) return null;
  const disc = b * b - a * c;
  if (disc < 0) return null;
  const t = (-b - Math.sqrt(disc)) / a;
  if (!(t <= maxDist)) return null; // 範囲外、または入力に NaN が含まれていた
  return t < 0 ? 0 : t;
}

/** 線分 a→b と AABB の最初の交差（割合 t∈[0,1] と進入面法線）。開始点が内部なら t=0 */
export function segmentAABBHit(a: Vec3, b: Vec3, box: AABB): { t: number; normal: Vec3 } | null {
  return slabIntersect(
    a[0],
    a[1],
    a[2],
    b[0] - a[0],
    b[1] - a[1],
    b[2] - a[2],
    box.min[0],
    box.min[1],
    box.min[2],
    box.max[0],
    box.max[1],
    box.max[2],
    1,
  );
}

/** 線分 a→b が AABB と交差するか（接触を含む） */
export function segmentAABB(a: Vec3, b: Vec3, box: AABB): boolean {
  return segmentAABBHit(a, b, box) !== null;
}

/**
 * 線分 a→b（半径 r の球の掃引）と、prev→cur へ動く半径 R の球との最初の接触割合 t∈[0,1]。
 * 対象を prevCenter に固定し、対象の変位を線分から引いた相対運動で解く。開始時に重なって（接して）いれば 0
 */
export function sweptSphereVsMovingSphere(a: Vec3, b: Vec3, r: number, prevCenter: Vec3, curCenter: Vec3, R: number): number | null {
  // 相対変位 d = (b - a) - (cur - prev)
  const dx = b[0] - a[0] - (curCenter[0] - prevCenter[0]);
  const dy = b[1] - a[1] - (curCenter[1] - prevCenter[1]);
  const dz = b[2] - a[2] - (curCenter[2] - prevCenter[2]);
  const mx = a[0] - prevCenter[0];
  const my = a[1] - prevCenter[1];
  const mz = a[2] - prevCenter[2];
  const rr = r + R;
  const c = mx * mx + my * my + mz * mz - rr * rr;
  if (c <= 0) return 0; // 既に重なっている / 接している
  const aa = dx * dx + dy * dy + dz * dz;
  if (aa < PARALLEL_EPS) return null; // 相対運動なし
  const bb = mx * dx + my * dy + mz * dz;
  if (bb >= 0) return null; // 遠ざかる
  const disc = bb * bb - aa * c;
  if (disc < 0) return null;
  const t = (-bb - Math.sqrt(disc)) / aa;
  if (!(t <= 1)) return null; // 区間外、または入力に NaN が含まれていた
  return t < 0 ? 0 : t;
}

/**
 * 線分 a→b（半径 r の球の掃引）と、prev→cur へ動く AABB（半径 half）との最初の接触割合 t∈[0,1] と面法線。
 * 相対運動に直し、r だけ拡張した AABB に対する線分のスラブ判定で解く（角は丸めない近似）
 */
export function sweptSphereVsMovingBox(
  a: Vec3,
  b: Vec3,
  r: number,
  prevCenter: Vec3,
  curCenter: Vec3,
  half: Vec3,
): { t: number; normal: Vec3 } | null {
  const dx = b[0] - a[0] - (curCenter[0] - prevCenter[0]);
  const dy = b[1] - a[1] - (curCenter[1] - prevCenter[1]);
  const dz = b[2] - a[2] - (curCenter[2] - prevCenter[2]);
  const hx = half[0] + r;
  const hy = half[1] + r;
  const hz = half[2] + r;
  return slabIntersect(
    a[0],
    a[1],
    a[2],
    dx,
    dy,
    dz,
    prevCenter[0] - hx,
    prevCenter[1] - hy,
    prevCenter[2] - hz,
    prevCenter[0] + hx,
    prevCenter[1] + hy,
    prevCenter[2] + hz,
    1,
  );
}

/** AABB を全方向へ r だけ拡張した新しい AABB */
export function expandAABB(box: AABB, r: number): AABB {
  return {
    min: [box.min[0] - r, box.min[1] - r, box.min[2] - r],
    max: [box.max[0] + r, box.max[1] + r, box.max[2] + r],
  };
}

/** 2 つの AABB が重なるか（厳密な重なり。接触は重なりではない） */
export function aabbOverlap(a: AABB, b: AABB): boolean {
  return (
    a.min[0] < b.max[0] &&
    a.max[0] > b.min[0] &&
    a.min[1] < b.max[1] &&
    a.max[1] > b.min[1] &&
    a.min[2] < b.max[2] &&
    a.max[2] > b.min[2]
  );
}
