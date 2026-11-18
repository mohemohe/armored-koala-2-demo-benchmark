/**
 * Which direction the mech's arm / weapon must point (SPEC §4.2: 見た目と実弾の一致).
 *
 *  - FCS lock complete AND a fire-control solution exists for the SELECTED weapon (`fc.status !== 'inactive'`, i.e. `solved`
 *    or `no_solution`): the real shot goes along `fc.launchDirection` (for `no_solution` that is the direct aim at the target).
 *  - otherwise (no lock / acquiring / target lost / the solution is for another weapon): the free-fire direction from the muzzle
 *    to the camera-centre aim point.
 *
 * The sim (weapons.ts) fires along exactly these two directions, so the drawn barrel, the muzzle flash, the tracer / beam / missile
 * and the HUD marker all agree.
 */
import { freeFireDirection } from '../sim/camera';
import type { GameState, V3 } from '../sim/types';

const finite3 = (v: V3): boolean => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);

/** true when the renderer must use the FCS launch direction instead of the free-fire direction */
export function usesFcsDirection(state: GameState): boolean {
  const fc = state.fc;
  return state.lock.state === 'locked' && fc.status !== 'inactive' && fc.weapon === state.player.weapon && fc.launchDirection !== null && finite3(fc.launchDirection);
}

export function visualAimDirection(state: GameState, muzzle: V3): V3 {
  if (usesFcsDirection(state)) return state.fc.launchDirection as V3;
  return freeFireDirection(state, state.world, muzzle);
}
