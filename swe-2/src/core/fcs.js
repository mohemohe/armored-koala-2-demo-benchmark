// FCS (Flight Control System): target acquisition, lock progress and
// fire-control solutions (lead + gravity compensation) per weapon.

import { PARAMS } from './params.js';
import { solveMachinegun, solveBeam, solveMissile } from './ballistics.js';

const RANGE = PARAMS.fcs.lockRange;

export class FCS {
  constructor(stats) {
    this.stats = stats; // effectiveStats (lockSeconds, lockRadiusK)
    this.state = 'none';       // none | acquiring | locked
    this.target = null;        // Enemy ref
    this.progress = 0;
    this.radiusCssPx = 0;
    this.fireControl = null;   // last evaluated solution payload
  }

  reset() {
    this.state = 'none';
    this.target = null;
    this.progress = 0;
    this.fireControl = null;
  }

  // view: {project(pos)->{x,y,behind}|null, camPos, camForward, widthPx, heightPx}
  // returns {acquired:boolean}
  update(dt, ctx, view, weapon) {
    const minDim = Math.min(view.widthPx, view.heightPx);
    this.radiusCssPx = this.stats.lockRadiusK * minDim;
    const cx = view.widthPx / 2, cy = view.heightPx / 2;
    const muzzle = ctx.player.muzzle();

    // evaluate candidates
    let current = null, currentScore = Infinity;
    const validity = new Map();
    for (const en of ctx.enemies) {
      if (!en.alive) continue;
      const c = en.center();
      const dx = c[0] - muzzle[0], dy = c[1] - muzzle[1], dz = c[2] - muzzle[2];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist > RANGE) continue;
      // in front of camera
      const fx = c[0] - view.camPos[0], fy = c[1] - view.camPos[1], fz = c[2] - view.camPos[2];
      const dotF = fx * view.camForward[0] + fy * view.camForward[1] + fz * view.camForward[2];
      if (dotF <= 0.01) continue;
      const pr = view.project(c);
      if (!pr || pr.behind) continue;
      const sdx = pr.x - cx, sdy = pr.y - cy;
      const sd = Math.sqrt(sdx * sdx + sdy * sdy);
      if (sd > this.radiusCssPx) continue;
      // LOS from camera AND muzzle to target center
      if (!ctx.world.lineOfSight(view.camPos, c)) continue;
      if (!ctx.world.lineOfSight(muzzle, c)) continue;
      validity.set(en.id, { screenDist: sd });
      if (sd < currentScore || (sd === currentScore && current && en.id < current.id)) {
        current = en; currentScore = sd;
      }
    }

    // sticky target: keep while valid
    if (this.target && (!this.target.alive || !validity.has(this.target.id))) {
      this.target = null;
      this.progress = 0;
      this.state = 'none';
      this.fireControl = null;
    }
    if (!this.target && current) {
      this.target = current;
      this.progress = 0;
      this.state = 'acquiring';
    }
    if (this.target) {
      this.progress += dt;
      if (this.progress >= this.stats.lockSeconds) {
        this.state = 'locked';
        this.progress = this.stats.lockSeconds;
      } else {
        this.state = 'acquiring';
      }
      this.evaluateFireControl(ctx, weapon, muzzle);
    } else {
      this.fireControl = null;
    }
  }

  // Compute the firing solution for `weapon` vs current locked target.
  // Stored for HUD/snapshot and reused by the shooter at the same instant.
  evaluateFireControl(ctx, weapon, muzzle) {
    if (!this.target || this.state !== 'locked') {
      this.fireControl = null;
      return null;
    }
    const p = this.target.center();
    const v = this.target.vel;
    let sol;
    if (weapon === 'machinegun') sol = solveMachinegun(muzzle, p, v);
    else if (weapon === 'beam') sol = solveBeam(muzzle, p, v);
    else sol = solveMissile(muzzle, p, v);
    this.fireControl = {
      status: sol.status, weapon, targetId: this.target.id,
      evaluatedAtSeconds: ctx.now,
      muzzlePosition: muzzle.slice(), targetPosition: p.slice(), targetVelocity: v.slice(),
      launchDirection: sol.launchDirection,
      predictedFlightSeconds: sol.predictedFlightSeconds,
      predictedInterceptPosition: sol.predictedInterceptPosition,
      aimPoint: sol.aimPoint,
      residualMeters: sol.residualMeters,
      initialVelocity: sol.initialVelocity,
    };
    return this.fireControl;
  }

  // lock validity re-check at fire instant (same rules as candidate check)
  validateTarget(ctx, view) {
    if (!this.target || !this.target.alive) return false;
    const en = this.target;
    const muzzle = ctx.player.muzzle();
    const c = en.center();
    const dx = c[0] - muzzle[0], dy = c[1] - muzzle[1], dz = c[2] - muzzle[2];
    if (Math.sqrt(dx * dx + dy * dy + dz * dz) > RANGE) return false;
    const fx = c[0] - view.camPos[0], fy = c[1] - view.camPos[1], fz = c[2] - view.camPos[2];
    if (fx * view.camForward[0] + fy * view.camForward[1] + fz * view.camForward[2] <= 0.01) return false;
    const pr = view.project(c);
    if (!pr || pr.behind) return false;
    const cx = view.widthPx / 2, cy = view.heightPx / 2;
    const sd = Math.hypot(pr.x - cx, pr.y - cy);
    if (sd > this.radiusCssPx) return false;
    if (!ctx.world.lineOfSight(view.camPos, c)) return false;
    if (!ctx.world.lineOfSight(muzzle, c)) return false;
    return true;
  }
}
