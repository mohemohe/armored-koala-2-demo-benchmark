/**
 * Minimal vector math for the headless simulation (no Three.js dependency so the
 * simulation can run in Node/vitest). Vectors are plain {x,y,z} objects.
 * All functions are pure and allocate a new object unless the name ends in "Into".
 */

export interface V3 {
  x: number;
  y: number;
  z: number;
}
export interface V2 {
  x: number;
  z: number;
}

export const v3 = (x = 0, y = 0, z = 0): V3 => ({ x, y, z });
export const zero = (): V3 => ({ x: 0, y: 0, z: 0 });
export const clone = (a: V3): V3 => ({ x: a.x, y: a.y, z: a.z });
export const copyInto = (out: V3, a: V3): V3 => {
  out.x = a.x;
  out.y = a.y;
  out.z = a.z;
  return out;
};
export const add = (a: V3, b: V3): V3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale = (a: V3, s: number): V3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
/** a + b*s */
export const addScaled = (a: V3, b: V3, s: number): V3 => ({ x: a.x + b.x * s, y: a.y + b.y * s, z: a.z + b.z * s });
export const dot = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a: V3, b: V3): V3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
export const lengthSq = (a: V3): number => a.x * a.x + a.y * a.y + a.z * a.z;
export const length = (a: V3): number => Math.sqrt(lengthSq(a));
export const distance = (a: V3, b: V3): number => length(sub(a, b));
export const distanceSq = (a: V3, b: V3): number => lengthSq(sub(a, b));
export const horizontalLength = (a: V3): number => Math.hypot(a.x, a.z);
export const lerp = (a: V3, b: V3, t: number): V3 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  z: a.z + (b.z - a.z) * t,
});
/** unit vector; returns fallback (default +Z) when |a| is ~0 so we never produce NaN */
export const normalize = (a: V3, fallback: V3 = { x: 0, y: 0, z: 1 }): V3 => {
  const l = length(a);
  if (!(l > 1e-12) || !Number.isFinite(l)) return clone(fallback);
  return { x: a.x / l, y: a.y / l, z: a.z / l };
};
export const isFiniteV3 = (a: V3): boolean => Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z);
export const toTuple = (a: V3): [number, number, number] => [a.x, a.y, a.z];
export const fromTuple = (t: readonly [number, number, number]): V3 => ({ x: t[0], y: t[1], z: t[2] });
export const angleBetween = (a: V3, b: V3): number => {
  const la = length(a);
  const lb = length(b);
  if (la < 1e-12 || lb < 1e-12) return 0;
  return Math.acos(Math.min(1, Math.max(-1, dot(a, b) / (la * lb))));
};

export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
export const lerpNum = (a: number, b: number, t: number): number => a + (b - a) * t;
export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

/**
 * Yaw convention (shared by sim, camera, render, HUD) == Three.js camera.rotation order 'YXZ':
 *   yaw = 0     -> forward is -Z;  positive yaw turns LEFT (counter-clockwise seen from above)
 *   forward(yaw)= (-sin yaw, 0, -cos yaw)
 *   right(yaw)  = ( cos yaw, 0, -sin yaw)      (right-handed world, Y up: right x up = -forward... i.e. camera basis is a proper rotation)
 * pitch > 0 looks UP.  view dir = (-sin yaw * cos pitch, sin pitch, -cos yaw * cos pitch)
 * Mouse move right (dx>0) => yaw -= dx*sens.  Mouse move down (dy>0) => pitch -= dy*sens.
 * The renderer copies CameraState.{pos,forward,right,up} into the Three camera via a basis matrix.
 */
export const forwardFromYaw = (yaw: number): V3 => ({ x: -Math.sin(yaw), y: 0, z: -Math.cos(yaw) });
export const rightFromYaw = (yaw: number): V3 => ({ x: Math.cos(yaw), y: 0, z: -Math.sin(yaw) });
export const dirFromYawPitch = (yaw: number, pitch: number): V3 => ({
  x: -Math.sin(yaw) * Math.cos(pitch),
  y: Math.sin(pitch),
  z: -Math.cos(yaw) * Math.cos(pitch),
});

/** move current toward target by at most maxDelta (vector-length limited) — never overshoots */
export const moveTowardV3 = (cur: V3, target: V3, maxDelta: number): V3 => {
  const d = sub(target, cur);
  const l = length(d);
  if (l <= maxDelta || l < 1e-12) return clone(target);
  return addScaled(cur, d, maxDelta / l);
};

/** Real roots of a*t² + b*t + c = 0 (handles a≈0). Returns sorted ascending. */
export const solveQuadratic = (a: number, b: number, c: number): number[] => {
  const EPS = 1e-12;
  if (Math.abs(a) < EPS) {
    if (Math.abs(b) < EPS) return [];
    return [-c / b];
  }
  const disc = b * b - 4 * a * c;
  if (disc < 0) return [];
  if (disc === 0) return [-b / (2 * a)];
  const sq = Math.sqrt(disc);
  // numerically stable form
  const q = -0.5 * (b + Math.sign(b || 1) * sq);
  const r1 = q / a;
  const r2 = c / q;
  return r1 < r2 ? [r1, r2] : [r2, r1];
};
