/** TPS camera rig, muzzle position and free-fire aim point. OWNER: combat agent. SPEC §4.2, §4.5, §7.4 */
import { CAMERA, PLAYER } from '../config';
import { addScaled, cross, dirFromYawPitch, dot, forwardFromYaw, length, normalize, rightFromYaw, sub } from './math';
import type { CameraState, GameState, IWorld, PlayerState, V3 } from './types';

/**
 * Fixed muzzle position: player center + yaw-frame offset (right, up, forward).
 * Independent of the view pitch and of the aim / correction direction (SPEC §4.2: the muzzle never moves because of aiming).
 */
export function playerMuzzlePosition(p: PlayerState): V3 {
  const f = forwardFromYaw(p.yaw);
  const r = rightFromYaw(p.yaw);
  const o = PLAYER.MUZZLE_OFFSET;
  return {
    x: p.pos.x + r.x * o.right + f.x * o.forward,
    y: p.pos.y + o.up,
    z: p.pos.z + r.z * o.right + f.z * o.forward,
  };
}

export function makeInitialCamera(viewportW: number, viewportH: number): CameraState {
  return {
    pos: { x: 0, y: 0, z: 0 },
    forward: { x: 0, y: 0, z: -1 },
    right: { x: 1, y: 0, z: 0 },
    up: { x: 0, y: 1, z: 0 },
    fovYDeg: CAMERA.FOV_Y_DEG,
    near: CAMERA.NEAR,
    far: CAMERA.FAR,
    viewportW,
    viewportH,
  };
}

/** number of times the wall margin is halved when the pivot already sits inside the margin of a surface */
const MARGIN_RETRIES = 4;

/**
 * Recompute state.camera from the player's pose. Called every tick and after mouse look.
 * The camera sits behind / right of a pivot above the player center; the pivot->camera segment is swept with a sphere
 * (IWorld.sweepSphere) so the camera never ends up inside or behind a wall. The basis is right-handed (up = right x forward).
 */
export function updateCamera(state: GameState, world: IWorld): void {
  const p = state.player;
  const cam = state.camera;
  const fwd = dirFromYawPitch(p.yaw, p.pitch);
  const right = rightFromYaw(p.yaw);
  const up = cross(right, fwd);
  const pivot: V3 = { x: p.pos.x, y: p.pos.y + CAMERA.PIVOT_UP, z: p.pos.z };
  const desired = addScaled(addScaled(pivot, fwd, -CAMERA.DISTANCE), right, CAMERA.SHOULDER);
  const off = sub(desired, pivot);
  const len = length(off);
  const dir = normalize(off, { x: -fwd.x, y: -fwd.y, z: -fwd.z });

  // Sweep with the full wall margin. If the pivot itself is already inside that margin (e.g. flying up against a
  // ceiling) the sweep reports contact at distance 0 whatever the direction, so retry with a smaller margin.
  let dist = len;
  let margin: number = CAMERA.COLLISION_MARGIN;
  for (let i = 0; i <= MARGIN_RETRIES; i++) {
    const hit = world.sweepSphere(pivot, desired, margin);
    if (!hit) {
      dist = len;
      break;
    }
    dist = Math.max(0, Math.min(len, hit.t));
    if (dist > 1e-6) break;
    margin *= 0.5;
  }
  cam.pos = addScaled(pivot, dir, dist);
  cam.forward = fwd;
  cam.right = right;
  cam.up = up;
}

/** Free-fire aim point: first hit of the camera-center ray (world or alive enemy sphere) or a far point on the ray. */
export function computeAimPoint(state: GameState, world: IWorld): V3 {
  const cam = state.camera;
  const hit = world.raycast(cam.pos, cam.forward, CAMERA.AIM_RANGE);
  let best = hit ? hit.t : CAMERA.AIM_RANGE;
  for (const e of state.enemies) {
    if (!e.alive) continue;
    const oc = sub(cam.pos, e.pos);
    const b = dot(oc, cam.forward);
    const c = dot(oc, oc) - e.hitRadius * e.hitRadius;
    const disc = b * b - c;
    if (disc < 0) continue;
    const t = -b - Math.sqrt(disc);
    if (t > 0 && t < best) best = t;
  }
  return addScaled(cam.pos, cam.forward, best);
}

/** aim points closer than this along the camera forward axis (measured from the muzzle) are treated as degenerate [m] */
const MIN_AIM_AHEAD = 0.5;

/**
 * Direction from the muzzle to the free-fire aim point. The shot always starts at the muzzle (never at the camera), so a wall
 * between the muzzle and the aim point stops it. Falls back to the camera forward when the aim point is degenerate
 * (not ahead of the muzzle, or coincident with it).
 */
export function freeFireDirection(state: GameState, world: IWorld, muzzle: V3): V3 {
  const fwd = state.camera.forward;
  const aim = computeAimPoint(state, world);
  const d = sub(aim, muzzle);
  if (!(dot(d, fwd) > MIN_AIM_AHEAD)) return { x: fwd.x, y: fwd.y, z: fwd.z };
  return normalize(d, fwd);
}
