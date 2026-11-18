/**
 * Minimal 3D vector helpers on plain `{x, y, z}` objects.
 *
 * The simulation never imports three.js (it must run headless in Node tests); THREE.Vector3 is
 * structurally compatible with V3, so render code can pass either.
 */
export interface V3 {
  x: number;
  y: number;
  z: number;
}

export const v3 = (x = 0, y = 0, z = 0): V3 => ({ x, y, z });
export const clone = (a: V3): V3 => ({ x: a.x, y: a.y, z: a.z });
export const set = (out: V3, x: number, y: number, z: number): V3 => {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
};
export const copy = (out: V3, a: V3): V3 => {
  out.x = a.x;
  out.y = a.y;
  out.z = a.z;
  return out;
};
export const add = (a: V3, b: V3, out: V3 = v3()): V3 => set(out, a.x + b.x, a.y + b.y, a.z + b.z);
export const sub = (a: V3, b: V3, out: V3 = v3()): V3 => set(out, a.x - b.x, a.y - b.y, a.z - b.z);
export const scale = (a: V3, s: number, out: V3 = v3()): V3 => set(out, a.x * s, a.y * s, a.z * s);
/** out = a + b * s */
export const addScaled = (a: V3, b: V3, s: number, out: V3 = v3()): V3 => set(out, a.x + b.x * s, a.y + b.y * s, a.z + b.z * s);
export const dot = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a: V3, b: V3, out: V3 = v3()): V3 =>
  set(out, a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
export const lengthSq = (a: V3): number => a.x * a.x + a.y * a.y + a.z * a.z;
export const length = (a: V3): number => Math.sqrt(lengthSq(a));
export const distance = (a: V3, b: V3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
export const distanceSq = (a: V3, b: V3): number => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
};
export const horizontalDistance = (a: V3, b: V3): number => Math.hypot(a.x - b.x, a.z - b.z);
/** Normalizes `a` into `out`. Returns the zero vector when |a| is ~0 (never NaN). */
export const normalize = (a: V3, out: V3 = v3()): V3 => {
  const l = length(a);
  if (l < 1e-12) return set(out, 0, 0, 0);
  return set(out, a.x / l, a.y / l, a.z / l);
};
export const lerp = (a: V3, b: V3, t: number, out: V3 = v3()): V3 =>
  set(out, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
export const isFiniteV3 = (a: V3): boolean => Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z);
export const toArray = (a: V3): [number, number, number] => [a.x, a.y, a.z];
export const fromArray = (a: readonly [number, number, number]): V3 => ({ x: a[0], y: a[1], z: a[2] });

export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

/**
 * Orientation convention (identical to three.js with Euler order 'YXZ'):
 *   yaw   = rotation about +Y; yaw 0 looks along -Z, positive yaw turns left (counter-clockwise from above).
 *   pitch = rotation about the local +X; positive pitch looks up.
 */
export const forwardFromYawPitch = (yaw: number, pitch: number, out: V3 = v3()): V3 => {
  const cp = Math.cos(pitch);
  return set(out, -Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
};
/** Horizontal forward for a yaw: (-sin yaw, 0, -cos yaw). */
export const forwardFromYaw = (yaw: number, out: V3 = v3()): V3 => set(out, -Math.sin(yaw), 0, -Math.cos(yaw));
/** Horizontal right for a yaw: (cos yaw, 0, -sin yaw). */
export const rightFromYaw = (yaw: number, out: V3 = v3()): V3 => set(out, Math.cos(yaw), 0, -Math.sin(yaw));
/** Yaw that makes the horizontal forward point along (dx, dz). */
export const yawFromDir = (dx: number, dz: number): number => Math.atan2(-dx, -dz);
