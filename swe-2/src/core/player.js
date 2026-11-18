// Player unit simulation: movement (walk/glide/QB/flight), EN resources,
// collision. Environment-agnostic — no three.js/DOM. All times in sim seconds.

import { PARAMS } from './params.js';

const P = PARAMS.player;

export class Player {
  constructor(loadout, stats, start) {
    this.stats = stats; // effectiveStats(loadout)
    this.reset(start);
  }

  reset(start) {
    this.pos = start.pos.slice();      // feet position (bottom of AABB)
    this.vel = [0, 0, 0];
    this.yaw = start.yaw;
    this.grounded = true;
    this.hp = P.maxHp;
    this.en = this.stats.maxEn;
    this.weapon = 'machinegun';
    this.ammo = { machinegun: PARAMS.weapons.machinegun.ammo, missile: PARAMS.weapons.missile.ammo };

    this.glideEnabled = false;
    this.glideDir = [0, 0];            // preserved XZ glide direction
    this.qbDir = [0, 1];
    this.qbImpulseRemaining = 0;
    this.qbLastStartedAt = null;
    this.qbSuccessfulCount = 0;
    this.lastEnSpentAt = null;
    this.flying = false;               // thrust currently applied
    this.spacePressedAt = null;        // for hold-to-fly timing
    this.walkPhase = 0;
  }

  get horizontalMode() {
    if (this.qbImpulseRemaining > 0) return 'quickboost';
    return this.glideEnabled ? 'glide' : 'walk';
  }

  get verticalMode() {
    if (this.grounded) return 'grounded';
    if (this.flying) return 'flying';
    return this.vel[1] > 0.1 ? 'rising' : 'falling';
  }

  center() { return [this.pos[0], this.pos[1] + P.hitCenterY, this.pos[2]]; }

  muzzle() {
    // right-arm gun tip in world space (mech faces `yaw`)
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    // local: right=+X? mech faces +Z locally; right vector = (cy,0,-sy)
    const fx = sy, fz = cy;           // forward = (sin yaw, 0, cos yaw)
    const rx = cy, rz = -sy;          // right
    return [
      this.pos[0] + rx * P.muzzleRight + fx * P.muzzleFwd,
      this.pos[1] + P.muzzleUp,
      this.pos[2] + rz * P.muzzleRight + fz * P.muzzleFwd,
    ];
  }

  spendEn(amount, now) {
    if (amount <= 0) return true;
    if (this.en < amount - 1e-9) return false;
    this.en -= amount;
    this.lastEnSpentAt = now;
    return true;
  }

  // ---- per-step update -------------------------------------------------
  // input: {move:[x,z] camera-relative unit wish dir or null,
  //         jumpEdge, spaceHeld, spaceEdge, qbEdge, shiftEdge, brakeHeld}
  update(dt, input, now, world) {
    const mult = this.stats.horizontalSpeedMultiplier;

    // --- QB activation (edge only, cooldown, EN, brake veto) ---
    if (input.qbEdge && !input.brakeHeld) {
      const cdOk = this.qbLastStartedAt === null || (now - this.qbLastStartedAt) >= P.qbCooldown;
      if (cdOk && this.en >= P.qbCost - 1e-9) {
        this.en -= P.qbCost;
        this.lastEnSpentAt = now;
        this.qbLastStartedAt = now;
        this.qbImpulseRemaining = P.qbImpulse;
        this.qbSuccessfulCount++;
        let d = input.move;
        if (!d || (d[0] === 0 && d[1] === 0)) d = input.camForwardXZ;
        const l = Math.hypot(d[0], d[1]) || 1;
        this.qbDir = [d[0] / l, d[1] / l];
        const sp = P.qbSpeed * mult;
        this.vel[0] = this.qbDir[0] * sp;
        this.vel[2] = this.qbDir[1] * sp;
        this.qbFiredAt = now;
      }
    }

    // --- horizontal steering -------------------------------------------
    let t = dt;
    if (this.qbImpulseRemaining > 0) {
      const boost = Math.min(t, this.qbImpulseRemaining);
      const sp = P.qbSpeed * mult;
      this.vel[0] = this.qbDir[0] * sp;
      this.vel[2] = this.qbDir[1] * sp;
      this.qbImpulseRemaining -= boost;
      t -= boost;
      if (this.qbImpulseRemaining <= 0) {
        // mandatory transition into glide preserving momentum
        this.glideEnabled = true;
        const vl = Math.hypot(this.vel[0], this.vel[2]);
        if (vl > 1e-6) this.glideDir = [this.vel[0] / vl, this.vel[2] / vl];
        else this.glideDir = this.qbDir.slice();
      }
    }
    if (t > 0) {
      if (input.shiftEdge && this.qbImpulseRemaining <= 0) {
        this.glideEnabled = !this.glideEnabled;
        if (this.glideEnabled) {
          let d = input.move;
          if (!d || (d[0] === 0 && d[1] === 0)) d = input.camForwardXZ;
          const l = Math.hypot(d[0], d[1]) || 1;
          this.glideDir = [d[0] / l, d[1] / l];
        }
      }
      if (input.brakeHeld) this.glideEnabled = false;

      if (this.glideEnabled) {
        const spd = (this.grounded ? P.glideSpeed : P.airSpeed) * mult;
        const rate = (this.grounded ? P.glideRateGround : P.glideRateAir) * mult;
        let dir;
        if (input.move && (input.move[0] !== 0 || input.move[1] !== 0)) {
          const l = Math.hypot(input.move[0], input.move[1]);
          dir = [input.move[0] / l, input.move[1] / l];
          this.glideDir = dir;
        } else dir = this.glideDir;
        this._approach(dir[0] * spd, dir[1] * spd, rate * t);
      } else {
        const rate = P.walkAccel * mult;
        let tx = 0, tz = 0;
        if (!input.brakeHeld && input.move && (input.move[0] !== 0 || input.move[1] !== 0)) {
          const l = Math.hypot(input.move[0], input.move[1]);
          const spd = (this.grounded ? P.walkSpeed : P.airSpeed) * mult;
          tx = (input.move[0] / l) * spd; tz = (input.move[1] / l) * spd;
        } else if (!this.grounded && !input.brakeHeld) {
          tx = this.vel[0]; tz = this.vel[2]; // keep momentum in air
        }
        this._approach(tx, tz, rate * t);
      }
    }

    // --- vertical -------------------------------------------------------
    if (input.spaceEdge && this.grounded) {
      this.vel[1] = P.jumpVel;
      this.grounded = false;
    }
    // hold-to-fly: game computes hold duration; EN settled in step ordering
    this.flying = false;
    return input.spaceHeld && input.spaceHeldFor >= P.flyHoldTime;
  }

  // Apply vertical motion after EN budget decided powered time.
  applyVertical(dt, poweredTime, world) {
    const grav = P.gravity;
    if (!this.grounded || poweredTime > 0) {
      if (poweredTime > 0) {
        this.flying = true;
        this.grounded = false;
        this.vel[1] = P.flyRiseSpeed;
        const unpowered = dt - poweredTime;
        if (unpowered > 0) this.vel[1] = P.flyRiseSpeed - grav * unpowered;
      } else {
        this.vel[1] -= grav * dt;
      }
    } else if (this.grounded && this.vel[1] < 0) {
      this.vel[1] = 0;
    }
  }

  _approach(tx, tz, maxDelta) {
    const dx = tx - this.vel[0], dz = tz - this.vel[2];
    const d = Math.hypot(dx, dz);
    if (d <= maxDelta || d < 1e-9) { this.vel[0] = tx; this.vel[2] = tz; return; }
    const k = maxDelta / d;
    this.vel[0] += dx * k;
    this.vel[2] += dz * k;
  }

  // Integrate position with world collision. Returns collision info.
  move(dt, world) {
    const ext = [P.halfExtents.x * 2, P.halfExtents.y * 2, P.halfExtents.z * 2];
    const min = [this.pos[0] - P.halfExtents.x, this.pos[1], this.pos[2] - P.halfExtents.z];
    const delta = [this.vel[0] * dt, this.vel[1] * dt, this.vel[2] * dt];
    const r = world.sweepAABB(min, ext, delta);
    this.pos = [r.pos[0] + P.halfExtents.x, r.pos[1], r.pos[2] + P.halfExtents.z];
    const wasAir = !this.grounded;
    if (r.hitWall) {
      // remove the velocity component into the wall
      // (axis sweep already clamped position; drop matching axis velocity
      // by projecting out motion into the blocked direction)
    }
    if (r.grounded) {
      if (this.vel[1] <= 0) { this.vel[1] = 0; this.grounded = true; }
    } else {
      this.grounded = false;
    }
    if (r.hitCeil && this.vel[1] > 0) this.vel[1] = 0;
    return { ...r, landed: !wasAir && this.grounded };
  }

  // EN regen — call once per step after all spending.
  regen(dt, now) {
    const spentRecently = this.lastEnSpentAt !== null && (now - this.lastEnSpentAt) < P.regenDelay;
    if (this.grounded && !spentRecently) {
      this.en = Math.min(this.stats.maxEn, this.en + this.stats.regenPerSecond * dt);
    }
  }
}
