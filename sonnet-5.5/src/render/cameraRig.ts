/** Copies the simulation camera (CameraState) into a Three.js PerspectiveCamera from its basis vectors. */
import { Matrix4, PerspectiveCamera, Vector3 } from 'three';
import type { CameraState } from '../sim/types';

const _r = new Vector3();
const _u = new Vector3();
const _b = new Vector3();
const _m = new Matrix4();

/**
 * pos / orthonormal basis (right, up, back = -forward) / fov / near / far come straight from the sim - the yaw/pitch
 * Euler angles are never re-interpreted. `aspect` is the real canvas aspect. Returns true when the projection changed.
 */
export function applySimCamera(cam: PerspectiveCamera, c: CameraState, aspect: number): boolean {
  let changed = false;
  if (cam.fov !== c.fovYDeg || cam.near !== c.near || cam.far !== c.far || cam.aspect !== aspect) {
    cam.fov = c.fovYDeg;
    cam.near = c.near;
    cam.far = c.far;
    cam.aspect = aspect;
    cam.updateProjectionMatrix();
    changed = true;
  }
  _r.set(c.right.x, c.right.y, c.right.z);
  _u.set(c.up.x, c.up.y, c.up.z);
  _b.set(-c.forward.x, -c.forward.y, -c.forward.z);
  _m.makeBasis(_r, _u, _b);
  cam.quaternion.setFromRotationMatrix(_m);
  cam.position.set(c.pos.x, c.pos.y, c.pos.z);
  cam.updateMatrixWorld(true);
  return changed;
}
