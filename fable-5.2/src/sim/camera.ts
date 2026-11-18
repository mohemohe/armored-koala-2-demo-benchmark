/**
 * TPS camera rig: a boom behind and above the mech, shortened by stage collision so the camera never
 * ends up inside or behind a wall. The same function is used by the simulation (FCS lock tests,
 * free-fire aim point) and by the renderer (which may pass an extrapolated player position).
 */
import { CAMERA } from '../config';
import { cross, forwardFromYawPitch, normalize, set, v3, type V3 } from '../core/vec';
import type { Sim } from './sim';
import type { CameraState, Viewport } from './types';
import type { World } from './world';

export function createCameraState(): CameraState {
  return {
    pos: v3(),
    forward: v3(0, 0, -1),
    right: v3(1, 0, 0),
    up: v3(0, 1, 0),
    yaw: 0,
    pitch: 0,
    fovY: (CAMERA.fovYDeg * Math.PI) / 180,
    aspect: 16 / 9,
  };
}

const _pivot = v3();
const _back = v3();
const _worldUp = v3(0, 1, 0);

/**
 * Places the camera for a player whose hit-box centre is `playerCenter`.
 * pivot = centre + (0, pivotUp, 0); camera = pivot - forward * boom, boom shortened by collision.
 */
export function computeCameraRig(
  world: World,
  playerCenter: V3,
  yaw: number,
  pitch: number,
  aspect: number,
  out: CameraState,
): CameraState {
  out.yaw = yaw;
  out.pitch = pitch;
  out.aspect = aspect;
  out.fovY = (CAMERA.fovYDeg * Math.PI) / 180;
  forwardFromYawPitch(yaw, pitch, out.forward);
  normalize(cross(out.forward, _worldUp, out.right), out.right);
  normalize(cross(out.right, out.forward, out.up), out.up);

  set(_pivot, playerCenter.x, playerCenter.y + CAMERA.pivotUp, playerCenter.z);
  // The pivot itself may poke into a low ceiling: pull it down until it is free.
  const up = world.raycast(playerCenter, _worldUp, CAMERA.pivotUp + CAMERA.collisionPad);
  if (up) _pivot.y = playerCenter.y + Math.max(0, up.dist - CAMERA.collisionPad);

  set(_back, -out.forward.x, -out.forward.y, -out.forward.z);
  let boom: number = CAMERA.boomLength;
  const hit = world.raycast(_pivot, _back, CAMERA.boomLength + CAMERA.collisionPad);
  if (hit) boom = Math.max(CAMERA.minBoom, hit.dist - CAMERA.collisionPad);
  if (hit && hit.dist - CAMERA.collisionPad < CAMERA.minBoom) boom = Math.max(0.05, hit.dist * 0.8);
  set(out.pos, _pivot.x + _back.x * boom, _pivot.y + _back.y * boom, _pivot.z + _back.z * boom);
  return out;
}

/** Updates sim.camera from the player's current position and look angles. */
export function updateCamera(sim: Sim): void {
  const p = sim.player;
  computeCameraRig(sim.world, p.pos, p.yaw, p.pitch, sim.viewport.width / sim.viewport.height, sim.camera);
}

export interface ScreenPoint {
  /** CSS pixels from the left / top edge of the game display area. */
  x: number;
  y: number;
  /** Distance along the camera forward axis (metres). <= near means "behind the camera". */
  depth: number;
}

/**
 * Perspective projection of a world point to CSS pixels of the viewport (origin top-left).
 * Returns false (and still fills `out` with a mirrored-safe value) when the point is not in front
 * of the camera. Matches a three.js PerspectiveCamera with the same pose, fovY and aspect.
 */
export function projectToViewport(cam: CameraState, viewport: Viewport, p: V3, out: ScreenPoint): boolean {
  const dx = p.x - cam.pos.x;
  const dy = p.y - cam.pos.y;
  const dz = p.z - cam.pos.z;
  const depth = dx * cam.forward.x + dy * cam.forward.y + dz * cam.forward.z;
  const sx = dx * cam.right.x + dy * cam.right.y + dz * cam.right.z;
  const sy = dx * cam.up.x + dy * cam.up.y + dz * cam.up.z;
  out.depth = depth;
  const d = depth > CAMERA.near ? depth : CAMERA.near;
  const f = 1 / Math.tan(cam.fovY / 2);
  const ndcX = (sx * f) / (cam.aspect * d);
  const ndcY = (sy * f) / d;
  out.x = (ndcX * 0.5 + 0.5) * viewport.width;
  out.y = (0.5 - ndcY * 0.5) * viewport.height;
  return depth > CAMERA.near;
}
