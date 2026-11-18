/**
 * 軽量ベクトル演算（Vec3 = [x, y, z] タプル）。
 * シミュレーションは Three.js に依存せず、この関数群だけで計算する。
 */
import type { Vec3 } from '../types';

export const v3 = (x = 0, y = 0, z = 0): Vec3 => [x, y, z];
export const copy = (a: Vec3): Vec3 => [a[0], a[1], a[2]];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const addScaled = (a: Vec3, b: Vec3, s: number): Vec3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const lengthSq = (a: Vec3): number => a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
export const distance = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const distanceXZ = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[2] - b[2]);
export const lengthXZ = (a: Vec3): number => Math.hypot(a[0], a[2]);
export function normalize(a: Vec3): Vec3 {
  const l = length(a);
  if (l <= 1e-12) return [0, 0, 0];
  return [a[0] / l, a[1] / l, a[2] / l];
}
export const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
export const equals = (a: Vec3, b: Vec3, eps = 1e-9): boolean =>
  Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps && Math.abs(a[2] - b[2]) <= eps;
export const isFinite3 = (a: Vec3): boolean => Number.isFinite(a[0]) && Number.isFinite(a[1]) && Number.isFinite(a[2]);

/** Y軸回りの回転（yaw）。yaw=0 で前方は -Z（Three.js のカメラ規約と一致） */
export function rotateY(a: Vec3, yaw: number): Vec3 {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return [a[0] * c + a[2] * s, a[1], -a[0] * s + a[2] * c];
}

/** yaw から水平前方単位ベクトル（yaw=0 → (0,0,-1)） */
export const forwardFromYaw = (yaw: number): Vec3 => [-Math.sin(yaw), 0, -Math.cos(yaw)];
/** yaw から水平右方向単位ベクトル（yaw=0 → (1,0,0)） */
export const rightFromYaw = (yaw: number): Vec3 => [Math.cos(yaw), 0, -Math.sin(yaw)];
/** yaw/pitch から視線方向（pitch>0 で上向き） */
export function directionFromYawPitch(yaw: number, pitch: number): Vec3 {
  const cp = Math.cos(pitch);
  return [-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp];
}
/** 方向ベクトルから yaw を求める（forwardFromYaw の逆） */
export const yawFromDirection = (d: Vec3): number => Math.atan2(-d[0], -d[2]);
/** 方向ベクトルから pitch を求める */
export const pitchFromDirection = (d: Vec3): number => Math.atan2(d[1], Math.hypot(d[0], d[2]));

/**
 * 現在の速度ベクトルを目標速度ベクトルへ、最大変化量 maxDelta 以内で近づける（越えない）。
 * 水平成分 [x, z] にのみ使う想定だが Vec3 として扱う。
 */
export function approachVector(current: Vec3, target: Vec3, maxDelta: number): Vec3 {
  const d = sub(target, current);
  const l = length(d);
  if (l <= maxDelta || l <= 1e-12) return copy(target);
  return addScaled(current, d, maxDelta / l);
}

/** ベクトル a を軸 axis（単位）に向けて、最大角 maxAngle [rad] だけ回転させる（長さは保持） */
export function rotateToward(a: Vec3, target: Vec3, maxAngle: number): Vec3 {
  const la = length(a);
  if (la <= 1e-12) return copy(a);
  const ua = scale(a, 1 / la);
  const ut = normalize(target);
  if (length(ut) <= 1e-12) return copy(a);
  const cosang = Math.max(-1, Math.min(1, dot(ua, ut)));
  const ang = Math.acos(cosang);
  if (ang <= maxAngle) return scale(ut, la);
  let axis = cross(ua, ut);
  if (lengthSq(axis) < 1e-14) {
    // 反対方向：任意の直交軸
    axis = Math.abs(ua[1]) < 0.9 ? cross(ua, [0, 1, 0]) : cross(ua, [1, 0, 0]);
  }
  axis = normalize(axis);
  // ロドリゲスの回転公式
  const c = Math.cos(maxAngle);
  const s = Math.sin(maxAngle);
  const term1 = scale(ua, c);
  const term2 = scale(cross(axis, ua), s);
  const term3 = scale(axis, dot(axis, ua) * (1 - c));
  return scale(add(add(term1, term2), term3), la);
}

export const degToRad = (d: number): number => (d * Math.PI) / 180;
export const radToDeg = (r: number): number => (r * 180) / Math.PI;
export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
