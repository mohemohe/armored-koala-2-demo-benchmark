import type { WeaponId } from '../core/config';

export type Vec3Tuple = [number, number, number];
export type SolutionStatus = 'inactive' | 'solved' | 'no_solution';
export type LockState = 'none' | 'acquiring' | 'locked';

export interface FireControl {
  status: SolutionStatus;
  weapon: WeaponId;
  targetId: string | null;
  evaluatedAtSeconds: number | null;
  muzzlePosition: Vec3Tuple | null;
  targetPosition: Vec3Tuple | null;
  targetVelocity: Vec3Tuple | null;
  launchDirection: Vec3Tuple | null;
  predictedFlightSeconds: number | null;
  predictedInterceptPosition: Vec3Tuple | null;
  aimPoint: Vec3Tuple | null;
  residualMeters: number | null;
}

export function emptyFireControl(weapon: WeaponId): FireControl {
  return {
    status: 'inactive',
    weapon,
    targetId: null,
    evaluatedAtSeconds: null,
    muzzlePosition: null,
    targetPosition: null,
    targetVelocity: null,
    launchDirection: null,
    predictedFlightSeconds: null,
    predictedInterceptPosition: null,
    aimPoint: null,
    residualMeters: null
  };
}

/** Interface the FCS needs from a hostile. */
export interface FcsTargetInfo {
  id: string;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  alive: boolean;
  radius: number;
}

export interface ShotRecord {
  id: number;
  firedAtSeconds: number;
  weapon: WeaponId;
  targetId: string | null;
  solutionStatus: SolutionStatus;
  muzzlePosition: Vec3Tuple;
  targetPositionAtFire: Vec3Tuple | null;
  targetVelocityAtFire: Vec3Tuple | null;
  launchDirection: Vec3Tuple;
  initialVelocity: Vec3Tuple | null;
  accelerationAtFire: Vec3Tuple;
  predictedFlightSeconds: number | null;
  predictedInterceptPosition: Vec3Tuple | null;
}
