// シミュレーション用の軽量ベクトル演算（Three.js非依存。ヘッドレス検証でも使用）

export type V3 = [number, number, number];

export const v3 = (x = 0, y = 0, z = 0): V3 => [x, y, z];
export const vcopy = (a: V3): V3 => [a[0], a[1], a[2]];
export const vset = (o: V3, x: number, y: number, z: number): V3 => {
  o[0] = x;
  o[1] = y;
  o[2] = z;
  return o;
};
export const vadd = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const vsub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const vscale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const vaddScaled = (a: V3, b: V3, s: number): V3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
export const vdot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const vcross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const vlen = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
export const vdist = (a: V3, b: V3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const vdistXZ = (a: V3, b: V3): number => Math.hypot(a[0] - b[0], a[2] - b[2]);
export const vnorm = (a: V3): V3 => {
  const l = vlen(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};
export const vlerp = (a: V3, b: V3, t: number): V3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

export const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);
export const DEG = Math.PI / 180;

/** yaw（ラジアン）からカメラ水平前方。yaw=0で -Z 方向 */
export function forwardFromYaw(yaw: number): [number, number] {
  return [-Math.sin(yaw), -Math.cos(yaw)];
}
/** yaw からカメラ水平右方向 */
export function rightFromYaw(yaw: number): [number, number] {
  return [Math.cos(yaw), -Math.sin(yaw)];
}

/** 方向ベクトル a を b へ最大 maxAngle ラジアン回転させる（単位ベクトル前提） */
export function rotateTowards(a: V3, b: V3, maxAngle: number): V3 {
  const d = clamp(vdot(a, b), -1, 1);
  const ang = Math.acos(d);
  if (ang <= maxAngle || ang < 1e-9) return vcopy(b);
  let axis = vcross(a, b);
  let al = vlen(axis);
  if (al < 1e-9) {
    // 反対方向: 任意の垂直軸
    axis = Math.abs(a[1]) < 0.9 ? vcross(a, [0, 1, 0]) : vcross(a, [1, 0, 0]);
    al = vlen(axis);
  }
  axis = vscale(axis, 1 / al);
  // ロドリゲスの回転公式
  const c = Math.cos(maxAngle);
  const s = Math.sin(maxAngle);
  const kxv = vcross(axis, a);
  const kdv = vdot(axis, a);
  return vnorm([
    a[0] * c + kxv[0] * s + axis[0] * kdv * (1 - c),
    a[1] * c + kxv[1] * s + axis[1] * kdv * (1 - c),
    a[2] * c + kxv[2] * s + axis[2] * kdv * (1 - c),
  ]);
}

/** 任意の単位ベクトルに垂直な2軸を返す */
export function orthoBasis(d: V3): [V3, V3] {
  const up: V3 = Math.abs(d[1]) < 0.95 ? [0, 1, 0] : [1, 0, 0];
  const u = vnorm(vcross(d, up));
  const w = vcross(u, d);
  return [u, w];
}

/** 数値を JSON 安全にする（NaN/Infinity を排除） */
export const finite = (x: number, fallback = 0) => (Number.isFinite(x) ? x : fallback);
