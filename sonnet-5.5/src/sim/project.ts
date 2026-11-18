import type { CameraState, V3 } from './types';

export interface ScreenPoint {
  /** CSS px offset from the viewport CENTER: +x right, +y DOWN. (0,0) when the point is not in front of the camera */
  x: number;
  y: number;
  /** distance along the camera forward axis (m). <= 0 means behind the camera */
  depth: number;
  inFront: boolean;
  /** camera-space offsets (m) along right/up, useful for off-screen edge arrows even when behind */
  camRight: number;
  camUp: number;
  /** true when inFront and inside the viewport rectangle */
  onScreen: boolean;
}

/**
 * Perspective projection matching the Three.js camera built from CameraState (vertical FOV = fovYDeg,
 * square pixels). Used by the FCS (lock candidates) and the HUD (markers) so both agree exactly.
 */
export function projectToScreen(cam: CameraState, p: V3): ScreenPoint {
  const rx = p.x - cam.pos.x;
  const ry = p.y - cam.pos.y;
  const rz = p.z - cam.pos.z;
  const depth = rx * cam.forward.x + ry * cam.forward.y + rz * cam.forward.z;
  const camRight = rx * cam.right.x + ry * cam.right.y + rz * cam.right.z;
  const camUp = rx * cam.up.x + ry * cam.up.y + rz * cam.up.z;
  if (!(depth > 1e-6)) {
    return { x: 0, y: 0, depth, inFront: false, camRight, camUp, onScreen: false };
  }
  const halfH = cam.viewportH / 2;
  const scale = halfH / Math.tan((cam.fovYDeg * Math.PI) / 360);
  const x = (camRight / depth) * scale;
  const y = -(camUp / depth) * scale;
  const onScreen = Math.abs(x) <= cam.viewportW / 2 && Math.abs(y) <= halfH;
  return { x, y, depth, inFront: true, camRight, camUp, onScreen };
}
