// TPSカメラの位置・向き・投影（描画側のPerspectiveCameraと同じ定義を使う）。
import { CAMERA } from '../config';
import { vcross, type V3 } from '../math';
import type { CollisionWorld } from './world';

export interface CameraState {
  pos: V3;
  forward: V3;
  right: V3;
  up: V3;
  yaw: number;
  pitch: number;
  pivot: V3;
}

export function cameraBasis(yaw: number, pitch: number): { forward: V3; right: V3; up: V3 } {
  const cp = Math.cos(pitch);
  const forward: V3 = [-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp];
  const right: V3 = [Math.cos(yaw), 0, -Math.sin(yaw)];
  const up = vcross(right, forward);
  return { forward, right, up };
}

export function computeCamera(playerPos: V3, yaw: number, pitch: number, world: CollisionWorld): CameraState {
  const { forward, right, up } = cameraBasis(yaw, pitch);
  const pivot: V3 = [playerPos[0], playerPos[1] + CAMERA.pivotHeight, playerPos[2]];
  const desired: V3 = [
    pivot[0] + right[0] * CAMERA.offsetRight + up[0] * CAMERA.offsetUp - forward[0] * CAMERA.distance,
    pivot[1] + right[1] * CAMERA.offsetRight + up[1] * CAMERA.offsetUp - forward[1] * CAMERA.distance,
    pivot[2] + right[2] * CAMERA.offsetRight + up[2] * CAMERA.offsetUp - forward[2] * CAMERA.distance,
  ];
  const dx = desired[0] - pivot[0],
    dy = desired[1] - pivot[1],
    dz = desired[2] - pivot[2];
  const L = Math.hypot(dx, dy, dz);
  const d: V3 = [dx / L, dy / L, dz / L];
  const hit = world.raycast(pivot, d, L + CAMERA.collisionPadding);
  let t = L;
  if (hit) t = Math.max(0.25, hit.t - CAMERA.collisionPadding);
  const pos: V3 = [pivot[0] + d[0] * t, pivot[1] + d[1] * t, pivot[2] + d[2] * t];
  return { pos, forward, right, up, yaw, pitch, pivot };
}

export interface Projected {
  /** 画面中心からのCSSピクセル距離 */
  distPx: number;
  sx: number;
  sy: number;
  depth: number;
  inFront: boolean;
}

/** 点を画面（CSSピクセル）へ投影する。three.js の PerspectiveCamera（縦fov）と同一の式。 */
export function project(cam: CameraState, p: V3, width: number, height: number): Projected {
  const rx = p[0] - cam.pos[0],
    ry = p[1] - cam.pos[1],
    rz = p[2] - cam.pos[2];
  const depth = rx * cam.forward[0] + ry * cam.forward[1] + rz * cam.forward[2];
  const xc = rx * cam.right[0] + ry * cam.right[1] + rz * cam.right[2];
  const yc = rx * cam.up[0] + ry * cam.up[1] + rz * cam.up[2];
  const inFront = depth > CAMERA.near;
  const tanH = Math.tan((CAMERA.fovDeg * Math.PI) / 360);
  const aspect = width / height;
  const d = Math.max(depth, 1e-6);
  const ndcX = xc / (d * tanH * aspect);
  const ndcY = yc / (d * tanH);
  const sx = width / 2 + (ndcX * width) / 2;
  const sy = height / 2 - (ndcY * height) / 2;
  return { distPx: Math.hypot(sx - width / 2, sy - height / 2), sx, sy, depth, inFront };
}
