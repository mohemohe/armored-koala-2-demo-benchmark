import * as THREE from 'three';
import {
  solveMachinegun,
  solveConstantSpeedLead,
  vsub,
  vnorm,
  vadd,
  vscale,
  type Vec3Like
} from '../core/ballistics';
import { FCS_LIST, LOCK, SOLVER, WEAPON_LIST, type FcsId, type WeaponId } from '../core/config';
import { raycastWorld } from './collision';
import type { World } from './world';
import { emptyFireControl, type FireControl, type FcsTargetInfo, type LockState } from './types';

export interface LockStateInfo {
  state: LockState;
  targetId: string | null;
  progress: number;
  radiusCssPx: number;
}

export interface FcsContext {
  now: number;
  camera: THREE.Camera;
  cameraPos: THREE.Vector3;
  cameraDir: THREE.Vector3;
  muzzlePos: THREE.Vector3;
  viewWidth: number;
  viewHeight: number;
  targets: FcsTargetInfo[];
  world: World;
  /** free aim point (camera centre ray hit) */
  freeAimPoint: THREE.Vector3;
}

/**
 * Flight Control System: target acquisition, lock progression and the
 * firing solution (lead + gravity compensation) used by every weapon.
 */
export class Fcs {
  fcsId: FcsId = 'medium';
  state: LockState = 'none';
  targetId: string | null = null;
  progress = 0;
  radiusCssPx = 0;

  private lastTargetPos: THREE.Vector3 | null = null;
  private lastTargetVel: THREE.Vector3 | null = null;

  setFcs(id: FcsId): void {
    if (this.fcsId === id) return;
    this.fcsId = id;
    this.reset();
  }

  reset(): void {
    this.state = 'none';
    this.targetId = null;
    this.progress = 0;
    this.lastTargetPos = null;
    this.lastTargetVel = null;
  }

  get spec() {
    return FCS_LIST.find((f) => f.id === this.fcsId)!;
  }

  /** effective lock time after the leg multiplier */
  lockSeconds(lockSpeedMultiplier: number): number {
    return this.spec.baseLockSeconds / lockSpeedMultiplier;
  }

  radiusPx(width: number, height: number): number {
    const d = Math.min(width, height);
    return this.spec.radiusFactor * d;
  }

  private isValidTarget(ctx: FcsContext, t: FcsTargetInfo): boolean {
    if (!t.alive) return false;
    const mx = ctx.muzzlePos.x;
    const my = ctx.muzzlePos.y;
    const mz = ctx.muzzlePos.z;
    const dist = Math.hypot(t.x - mx, t.y - my, t.z - mz);
    // 1e-6 tolerance so that a target exactly at 120 m is still lockable
    if (dist > LOCK.maxRange + 1e-6) {
      return false;
    }
    // in front of the camera?
    const dx = t.x - ctx.cameraPos.x;
    const dy = t.y - ctx.cameraPos.y;
    const dz = t.z - ctx.cameraPos.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    if ((dx * ctx.cameraDir.x + dy * ctx.cameraDir.y + dz * ctx.cameraDir.z) / len <= 0.05) {
      return false;
    }
    // screen projection inside the lock circle?
    const v = new THREE.Vector3(t.x, t.y, t.z);
    v.project(ctx.camera);
    if (v.z < -1 || v.z > 1) {
      return false;
    }
    const sx = (v.x * 0.5 + 0.5) * ctx.viewWidth;
    const sy = (1 - (v.y * 0.5 + 0.5)) * ctx.viewHeight;
    const cx = ctx.viewWidth / 2;
    const cy = ctx.viewHeight / 2;
    const r = this.radiusPx(ctx.viewWidth, ctx.viewHeight);
    if (Math.hypot(sx - cx, sy - cy) > r) {
      return false;
    }
    // line of sight from camera and muzzle
    if (!this.clearLine(ctx, ctx.cameraPos, t)) {
      return false;
    }
    if (!this.clearLine(ctx, ctx.muzzlePos, t)) {
      return false;
    }
    return true;
  }

  private clearLine(ctx: FcsContext, from: THREE.Vector3, t: FcsTargetInfo): boolean {
    const dx = t.x - from.x;
    const dy = t.y - from.y;
    const dz = t.z - from.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 0.001) return true;
    const hit = raycastWorld(ctx.world.hash, from.x, from.y, from.z, dx / len, dy / len, dz / len, len - 0.05);
    return !hit.hit;
  }

  /** advance the lock state machine */
  update(ctx: FcsContext, dt: number, lockSpeedMultiplier: number): void {
    this.radiusCssPx = this.radiusPx(ctx.viewWidth, ctx.viewHeight);
    const current = ctx.targets.find((t) => t.id === this.targetId) ?? null;

    if (current && this.isValidTarget(ctx, current)) {
      this.progress += dt / this.lockSeconds(lockSpeedMultiplier);
      if (this.progress >= 1) {
        this.progress = 1;
        this.state = 'locked';
      } else {
        this.state = 'acquiring';
      }
      this.lastTargetPos = new THREE.Vector3(current.x, current.y, current.z);
      this.lastTargetVel = new THREE.Vector3(current.vx, current.vy, current.vz);
      return;
    }

    // current target invalid -> drop it completely
    if (this.targetId !== null) {
      this.targetId = null;
      this.progress = 0;
      this.state = 'none';
      this.lastTargetPos = null;
      this.lastTargetVel = null;
    }

    // pick the candidate closest to the screen centre (stable id order on ties)
    let best: FcsTargetInfo | null = null;
    let bestDist = Infinity;
    for (const t of ctx.targets) {
      if (!this.isValidTarget(ctx, t)) continue;
      const v = new THREE.Vector3(t.x, t.y, t.z);
      v.project(ctx.camera);
      const sx = (v.x * 0.5 + 0.5) * ctx.viewWidth;
      const sy = (1 - (v.y * 0.5 + 0.5)) * ctx.viewHeight;
      const d = Math.hypot(sx - ctx.viewWidth / 2, sy - ctx.viewHeight / 2);
      if (d < bestDist - 0.001 || (Math.abs(d - bestDist) <= 0.001 && best && t.id < best.id)) {
        bestDist = d;
        best = t;
      }
    }
    if (!best) return;
    this.targetId = best.id;
    this.progress = 0;
    this.state = 'acquiring';
    this.lastTargetPos = new THREE.Vector3(best.x, best.y, best.z);
    this.lastTargetVel = new THREE.Vector3(best.vx, best.vy, best.vz);
  }

  get locked(): boolean {
    return this.state === 'locked' && this.targetId !== null;
  }

  /**
   * Compute the firing solution for the given weapon.
   *  - locked + solvable  -> "solved"     (lead + gravity compensation)
   *  - locked + unsolvable-> "no_solution"(direct aim at the current position)
   *  - not locked         -> "inactive"   (free fire at the camera aim point)
   */
  computeSolution(
    weapon: WeaponId,
    ctx: FcsContext,
    lockedTarget: FcsTargetInfo | null
  ): FireControl {
    const fc = emptyFireControl(weapon);
    fc.evaluatedAtSeconds = ctx.now;
    fc.muzzlePosition = [ctx.muzzlePos.x, ctx.muzzlePos.y, ctx.muzzlePos.z];

    if (!lockedTarget) {
      // free fire: aim at the camera centre point
      const d = vsub(ctx.freeAimPoint, ctx.muzzlePos);
      const dir = vnorm(d);
      fc.status = 'inactive';
      fc.launchDirection = [dir.x, dir.y, dir.z];
      fc.aimPoint = [ctx.freeAimPoint.x, ctx.freeAimPoint.y, ctx.freeAimPoint.z];
      return fc;
    }

    fc.targetId = lockedTarget.id;
    fc.targetPosition = [lockedTarget.x, lockedTarget.y, lockedTarget.z];
    fc.targetVelocity = [lockedTarget.vx, lockedTarget.vy, lockedTarget.vz];

    const m: Vec3Like = { x: ctx.muzzlePos.x, y: ctx.muzzlePos.y, z: ctx.muzzlePos.z };
    const p: Vec3Like = { x: lockedTarget.x, y: lockedTarget.y, z: lockedTarget.z };
    const v: Vec3Like = { x: lockedTarget.vx, y: lockedTarget.vy, z: lockedTarget.vz };
    const r = vsub(p, m);

    if (weapon === 'beam') {
      const dir = vnorm(r);
      fc.status = 'solved';
      fc.launchDirection = [dir.x, dir.y, dir.z];
      fc.aimPoint = [p.x, p.y, p.z];
      fc.predictedFlightSeconds = 0;
      fc.predictedInterceptPosition = [p.x, p.y, p.z];
      fc.residualMeters = 0;
      return fc;
    }

    if (weapon === 'missile') {
      const t = solveConstantSpeedLead(r, v, SOLVER.missileSpeed, SOLVER.missileLife);
      const useT = t !== null ? t : 0;
      const dir = t !== null ? vnorm(vadd(r, vscale(v, useT))) : vnorm(r);
      fc.status = 'solved';
      fc.launchDirection = [dir.x, dir.y, dir.z];
      const aim = t !== null ? vadd(p, vscale(v, useT)) : p;
      fc.aimPoint = [aim.x, aim.y, aim.z];
      fc.predictedFlightSeconds = t;
      fc.predictedInterceptPosition = t !== null ? [aim.x, aim.y, aim.z] : null;
      fc.residualMeters = 0;
      return fc;
    }

    // machinegun : lead + gravity compensation
    const sol = solveMachinegun(m, p, v, SOLVER.mgSpeed, SOLVER.mgGravity, SOLVER.mgLife);
    if (!sol) {
      const dir = vnorm(r);
      fc.status = 'no_solution';
      fc.launchDirection = [dir.x, dir.y, dir.z];
      fc.aimPoint = [p.x, p.y, p.z];
      return fc;
    }
    fc.status = 'solved';
    fc.launchDirection = [sol.direction.x, sol.direction.y, sol.direction.z];
    fc.predictedFlightSeconds = sol.t;
    fc.predictedInterceptPosition = [sol.intercept.x, sol.intercept.y, sol.intercept.z];
    fc.aimPoint = [sol.aimPoint.x, sol.aimPoint.y, sol.aimPoint.z];
    fc.residualMeters = sol.residual;
    return fc;
  }

  /** the weapon spec table entry */
  static weaponSpec(weapon: WeaponId) {
    return WEAPON_LIST.find((w) => w.id === weapon)!;
  }
}
