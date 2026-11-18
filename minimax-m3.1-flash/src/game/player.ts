import * as THREE from 'three';
import {
  GENERATOR_LIST,
  FCS_LIST,
  LEG_LIST,
  PLAYER,
  SOLVER,
  WEAPON_LIST,
  type FcsId,
  type GeneratorId,
  type LegId,
  type WeaponId
} from '../core/config';
import { buildMech, type MechRig } from './models';
import { Fcs } from './fcs';
import type { FireControl, FcsTargetInfo, ShotRecord } from './types';
import { moveAabb, type Box } from './collision';
import type { World } from './world';
import type { Input } from './input';

export interface Loadout {
  fcs: FcsId;
  generator: GeneratorId;
  legs: LegId;
  weapon: WeaponId;
}

export interface PlayerStepContext {
  input: Input;
  world: World;
  camera: THREE.Camera;
  cameraPos: THREE.Vector3;
  cameraDir: THREE.Vector3;
  freeAimPoint: THREE.Vector3;
  targets: FcsTargetInfo[];
  viewWidth: number;
  viewHeight: number;
  dt: number;
  now: number;
}

export class Player {
  readonly loadout: Loadout;
  readonly rig: MechRig;
  readonly fcs = new Fcs();

  position = new THREE.Vector3();
  velocity = new THREE.Vector3();
  grounded = false;
  hp = PLAYER.maxHp;
  en = 0;
  weapon: WeaponId;

  ammo = { machinegun: 300, missile: 12 };

  // movement state
  glideEnabled = false;
  horizontalMode: 'walk' | 'glide' | 'quickboost' = 'walk';
  verticalMode: 'grounded' | 'rising' | 'flying' | 'falling' = 'grounded';
  desiredHorizontalDirection = new THREE.Vector2(0, 0);
  qbSuccessfulCount = 0;
  qbLastStartedAtSeconds: number | null = null;
  qbImpulseRemainingSeconds = 0;
  qbCooldownRemainingSeconds = 0;
  lastEnSpentAtSeconds: number | null = null;

  // camera / aim
  yaw = 0;
  pitch = 0;

  // weapons
  nextFireAt: Record<WeaponId, number> = { machinegun: 0, beam: 0, missile: 0 };
  fireControl: FireControl;
  recentShots: ShotRecord[] = [];
  private shotCounter = 0;

  // internal
  private glideDir = new THREE.Vector3(0, 0, 1);
  private qbDir = new THREE.Vector3(0, 0, 1);
  private flightActive = false;
  private flightCharge = 0;
  private pendingBeamCost = 0;
  private scratch: Box[] = [];
  muzzleWorld = new THREE.Vector3();
  walkPhase = 0;
  private lastTargetInfo: FcsTargetInfo | null = null;

  constructor(loadout: Loadout) {
    this.loadout = loadout;
    this.weapon = loadout.weapon;
    this.fcs.setFcs(loadout.fcs);
    this.rig = buildMech(loadout.legs);
    this.en = this.maxEn;
    this.fireControl = this.emptyControl();
  }

  private emptyControl(): FireControl {
    return {
      status: 'inactive',
      weapon: this.weapon,
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

  /* ---------------- stats ---------------- */

  get maxEn(): number {
    return GENERATOR_LIST.find((g) => g.id === this.loadout.generator)!.maxEn;
  }

  get regenPerSecond(): number {
    const g = GENERATOR_LIST.find((x) => x.id === this.loadout.generator)!.regenPerSecond;
    const l = LEG_LIST.find((x) => x.id === this.loadout.legs)!.regenMultiplier;
    return g * l;
  }

  get speedMultiplier(): number {
    return LEG_LIST.find((x) => x.id === this.loadout.legs)!.speedMultiplier;
  }

  get lockSpeedMultiplier(): number {
    return LEG_LIST.find((x) => x.id === this.loadout.legs)!.lockSpeedMultiplier;
  }

  get lockSeconds(): number {
    return FCS_LIST.find((f) => f.id === this.loadout.fcs)!.baseLockSeconds / this.lockSpeedMultiplier;
  }

  reset(): void {
    this.position.set(0, 0, 0);
    this.velocity.set(0, 0, 0);
    this.grounded = false;
    this.hp = PLAYER.maxHp;
    this.en = this.maxEn;
    this.ammo.machinegun = WEAPON_LIST.find((w) => w.id === 'machinegun')!.ammo;
    this.ammo.missile = WEAPON_LIST.find((w) => w.id === 'missile')!.ammo;
    this.glideEnabled = false;
    this.horizontalMode = 'walk';
    this.verticalMode = 'falling';
    this.desiredHorizontalDirection.set(0, 0);
    this.qbSuccessfulCount = 0;
    this.qbLastStartedAtSeconds = null;
    this.qbImpulseRemainingSeconds = 0;
    this.qbCooldownRemainingSeconds = 0;
    this.lastEnSpentAtSeconds = null;
    this.nextFireAt = { machinegun: 0, beam: 0, missile: 0 };
    this.recentShots = [];
    this.shotCounter = 0;
    this.fcs.reset();
    this.fireControl = this.emptyControl();
    this.glideDir.set(0, 0, 1);
    this.qbDir.set(0, 0, 1);
    this.flightActive = false;
    this.flightCharge = 0;
    this.pendingBeamCost = 0;
    this.lastTargetInfo = null;
    this.yaw = 0;
    this.pitch = 0;
  }

  /* ---------------- energy ---------------- */

  private spendEn(amount: number, now: number): void {
    if (amount <= 0) return;
    this.en = Math.max(0, this.en - amount);
    this.lastEnSpentAtSeconds = now;
  }

  private regenerate(dt: number, now: number): void {
    if (!this.grounded) return;
    if (this.lastEnSpentAtSeconds !== null && now - this.lastEnSpentAtSeconds < PLAYER.enRegenDelay) return;
    if (this.en >= this.maxEn) return;
    this.en = Math.min(this.maxEn, this.en + this.regenPerSecond * dt);
  }

  /* ---------------- quick boost ---------------- */

  private tryQuickBoost(ctx: PlayerStepContext): boolean {
    const { input } = ctx;
    if (!input.consumeQbEdge()) return false;
    if (input.brake) return false; // a new QB while braking is invalid
    if (this.qbCooldownRemainingSeconds > 0) return false;
    if (this.en < PLAYER.qbEnCost) return false;
    // direction: WASD in the camera plane, otherwise the camera forward
    const dir = this.inputDirection(ctx);
    this.qbDir.copy(dir.lengthSq() > 0 ? dir : this.cameraForwardFlat(ctx));
    this.qbDir.normalize();
    this.spendEn(PLAYER.qbEnCost, ctx.now);
    this.qbSuccessfulCount++;
    this.qbLastStartedAtSeconds = ctx.now;
    this.qbImpulseRemainingSeconds = PLAYER.qbImpulseSeconds;
    this.qbCooldownRemainingSeconds = PLAYER.qbCooldown;
    this.horizontalMode = 'quickboost';
    const s = PLAYER.qbSpeed * this.speedMultiplier;
    this.velocity.x = this.qbDir.x * s;
    this.velocity.z = this.qbDir.z * s;
    this.glideDir.copy(this.qbDir);
    this.glideEnabled = true; // the glide takes over when the burn ends
    return true;
  }

  private cameraForwardFlat(ctx: PlayerStepContext): THREE.Vector3 {
    const f = new THREE.Vector3(
      Math.sin(this.yaw) * Math.cos(this.pitch),
      0,
      Math.cos(this.yaw) * Math.cos(this.pitch)
    );
    f.normalize();
    return f;
  }

  /** movement input in world space (camera relative), normalised */
  private inputDirection(ctx: PlayerStepContext): THREE.Vector3 {
    const { input } = ctx;
    const ix = input.moveX;
    const iz = input.moveZ;
    if (ix === 0 && iz === 0) return new THREE.Vector3(0, 0, 0);
    const fwd = this.cameraForwardFlat(ctx);
    // screen-right for a camera that looks along +Z at yaw 0
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const d = new THREE.Vector3()
      .addScaledVector(fwd, iz)
      .addScaledVector(right, ix);
    if (d.lengthSq() > 0) d.normalize();
    return d;
  }

  /* ---------------- movement ---------------- */

  /** Called at the beginning of the fixed step: timers and the QB request. */
  beginStep(ctx: PlayerStepContext): void {
    this.qbImpulseRemainingSeconds = Math.max(0, this.qbImpulseRemainingSeconds - ctx.dt);
    this.qbCooldownRemainingSeconds = Math.max(0, this.qbCooldownRemainingSeconds - ctx.dt);
    this.tryQuickBoost(ctx);
  }

  /**
   * Applies the horizontal / vertical movement for one step.
   * `pendingBeamCost` reserves the EN for a beam shot that is fired later in
   * the same step so the QB -> beam -> flight budget order is respected.
   */
  moveStep(ctx: PlayerStepContext, pendingBeamCost: number): void {
    const dt = ctx.dt;
    const { input } = ctx;
    const mult = this.speedMultiplier;

    // ---- input direction ----
    const inputDir = this.inputDirection(ctx);
    this.desiredHorizontalDirection.set(inputDir.x, inputDir.z);

    // ---- flight state ----
    const wantFlight = !this.grounded && input.spaceHeld >= PLAYER.flightHoldSeconds;
    let flightPossible = false;
    let flightTime = 0;
    if (wantFlight) {
      const affordable = Math.max(0, this.en - pendingBeamCost);
      flightTime = Math.min(dt, affordable / PLAYER.flyEnPerSecond);
      flightPossible = flightTime > 0;
    }
    this.flightActive = flightPossible && wantFlight;
    this.flightCharge = flightPossible ? flightTime * PLAYER.flyEnPerSecond : 0;

    // ---- horizontal target ----
    let targetSpeed = 0;
    let targetDir = new THREE.Vector3(0, 0, 0);
    let limit = PLAYER.accel * mult;

    const braking = input.brake;

    if (this.qbImpulseRemainingSeconds > 0) {
      // burn phase: keep the QB velocity, ignore mode changes
      this.horizontalMode = 'quickboost';
      targetSpeed = 0;
      targetDir.set(0, 0, 0);
      limit = 0;
    } else {
      if (this.qbImpulseRemainingSeconds <= 0 && this.horizontalMode === 'quickboost') {
        // the burn ended -> automatically continue as a glide
        this.horizontalMode = 'glide';
        this.glideEnabled = true;
      }

      if (braking) {
        // brake wins over WASD
        this.glideEnabled = false;
        this.horizontalMode = 'walk';
        targetSpeed = 0;
        targetDir.set(0, 0, 0);
        limit = PLAYER.accel * mult;
      } else if (this.glideEnabled) {
        if (inputDir.lengthSq() > 0) this.glideDir.copy(inputDir);
        this.horizontalMode = 'glide';
        targetDir = this.glideDir;
        targetSpeed = (this.grounded ? PLAYER.glideSpeed : PLAYER.airSpeed) * mult;
        limit = (this.grounded ? PLAYER.glideAccel : PLAYER.airGlideAccel) * mult;
      } else if (this.flightActive) {
        this.horizontalMode = 'walk';
        targetDir = inputDir.lengthSq() > 0 ? inputDir : this.glideDir;
        if (targetDir.lengthSq() === 0) targetDir = this.cameraForwardFlat(ctx);
        targetSpeed = PLAYER.flySpeed * mult;
        limit = PLAYER.accel * mult;
      } else {
        this.horizontalMode = 'walk';
        targetDir = inputDir;
        targetSpeed = (this.grounded ? PLAYER.walkSpeed : PLAYER.airSpeed) * mult;
        limit = PLAYER.accel * mult;
      }
    }

    // ---- accelerate the horizontal velocity towards the target ----
    const targetVX = targetDir.x * targetSpeed;
    const targetVZ = targetDir.z * targetSpeed;
    if (limit > 0) {
      const dvx = targetVX - this.velocity.x;
      const dvz = targetVZ - this.velocity.z;
      const dist = Math.hypot(dvx, dvz);
      const maxStep = limit * dt;
      if (dist <= maxStep || dist < 1e-6) {
        this.velocity.x = targetVX;
        this.velocity.z = targetVZ;
      } else {
        this.velocity.x += (dvx / dist) * maxStep;
        this.velocity.z += (dvz / dist) * maxStep;
      }
    }

    // ---- manual glide toggle ----
    if (input.consumeGlideEdge() && this.qbImpulseRemainingSeconds <= 0) {
      this.glideEnabled = !this.glideEnabled;
      if (this.glideEnabled) {
        const d = this.inputDirection(ctx);
        this.glideDir.copy(d.lengthSq() > 0 ? d : this.cameraForwardFlat(ctx));
        this.horizontalMode = 'glide';
      } else {
        this.horizontalMode = 'walk';
      }
    }

    // ---- jump ----
    if (input.consumeJumpEdge() && this.grounded && this.qbImpulseRemainingSeconds <= 0) {
      this.velocity.y = PLAYER.jumpSpeed;
      this.grounded = false;
    }

    // ---- vertical integration ----
    if (this.flightActive) {
      const frac = flightTime / dt;
      const gravityVy = this.velocity.y + PLAYER.gravity * dt;
      this.velocity.y = PLAYER.flyRiseSpeed * frac + gravityVy * (1 - frac);
    } else {
      this.velocity.y += PLAYER.gravity * dt;
      if (this.velocity.y < -60) this.velocity.y = -60;
    }

    // ---- collision ----
    const res = moveAabb(
      ctx.world.hash,
      this.position.x,
      this.position.y + PLAYER.height / 2,
      this.position.z,
      PLAYER.radius,
      PLAYER.height / 2,
      PLAYER.radius,
      this.velocity.x,
      this.velocity.y,
      this.velocity.z,
      dt,
      this.scratch
    );
    const wasGrounded = this.grounded;
    this.position.x = res.x;
    this.position.y = res.y - PLAYER.height / 2;
    this.position.z = res.z;
    this.velocity.x = res.vx;
    this.velocity.z = res.vz;
    if (res.grounded) {
      this.velocity.y = 0;
      this.grounded = true;
    } else {
      this.grounded = false;
      if (wasGrounded && this.velocity.y <= 0 && !this.flightActive) {
        // walked off a ledge
        this.velocity.y = Math.min(0, this.velocity.y);
      }
    }
    if (res.hitCeiling && this.velocity.y > 0) this.velocity.y = 0;

    // ---- vertical mode ----
    if (this.grounded) this.verticalMode = 'grounded';
    else if (this.flightActive) this.verticalMode = 'flying';
    else if (this.velocity.y > 0.01) this.verticalMode = 'rising';
    else this.verticalMode = 'falling';

    // ---- walk animation phase ----
    const hs = Math.hypot(this.velocity.x, this.velocity.z);
    this.walkPhase += hs * dt * 2.4;

    // ---- regeneration ----
    this.regenerate(dt, ctx.now);
  }

  /** Commits the energy spent by the flight thrusters (after the beam). */
  commitFlightEnergy(ctx: PlayerStepContext): void {
    if (this.flightCharge > 0) {
      this.spendEn(this.flightCharge, ctx.now);
    }
    this.flightCharge = 0;
  }

  /* ---------------- aim / lock ---------------- */

  private poseArm(dir: THREE.Vector3): void {
    const aim = this.rig.aim;
    const parent = aim.parent!;
    parent.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(parent.matrixWorld).invert();
    const local = dir.clone().transformDirection(inv);
    const yaw = Math.atan2(local.x, local.z);
    const pitch = Math.asin(Math.max(-1, Math.min(1, local.y)));
    aim.rotation.set(pitch, yaw, 0, 'YXZ');
  }

  /** updates the rig transform, the lock and the firing solution */
  updateAim(ctx: PlayerStepContext): void {
    this.rig.root.position.copy(this.position);
    this.rig.root.rotation.y = this.yaw;
    this.rig.root.updateMatrixWorld(true);

    const fcsCtx = {
      now: ctx.now,
      camera: ctx.camera,
      cameraPos: ctx.cameraPos,
      cameraDir: ctx.cameraDir,
      muzzlePos: this.muzzleWorld,
      viewWidth: ctx.viewWidth,
      viewHeight: ctx.viewHeight,
      targets: ctx.targets,
      world: ctx.world,
      freeAimPoint: ctx.freeAimPoint
    };

    this.fcs.update(fcsCtx, ctx.dt, this.lockSpeedMultiplier);

    // resolve the locked target from the current target list
    this.lastTargetInfo = this.fcs.targetId
      ? ctx.targets.find((t) => t.id === this.fcs.targetId && t.alive) ?? null
      : null;
    const locked = this.lockedTarget();

    // iterate: aim -> muzzle -> aim
    let dir = this.desiredDirection(ctx, locked);
    for (let i = 0; i < 5; i++) {
      this.poseArm(dir);
      this.rig.root.updateMatrixWorld(true);
      this.muzzleWorld.setFromMatrixPosition(this.rig.muzzleAnchor.matrixWorld);
      fcsCtx.muzzlePos = this.muzzleWorld;
      const sol = this.fcs.computeSolution(this.weapon, fcsCtx, locked);
      this.fireControl = sol;
      dir = this.directionOf(sol, ctx, locked);
    }
    this.rig.root.updateMatrixWorld(true);
  }

  private directionOf(sol: FireControl, ctx: PlayerStepContext, locked: FcsTargetInfo | null): THREE.Vector3 {
    if (sol.launchDirection) {
      return new THREE.Vector3(sol.launchDirection[0], sol.launchDirection[1], sol.launchDirection[2]).normalize();
    }
    if (locked) {
      return new THREE.Vector3(locked.x, locked.y, locked.z).sub(this.muzzleWorld).normalize();
    }
    return ctx.freeAimPoint.clone().sub(this.muzzleWorld).normalize();
  }

  private desiredDirection(ctx: PlayerStepContext, locked: FcsTargetInfo | null): THREE.Vector3 {
    if (locked) {
      const d = new THREE.Vector3(locked.x, locked.y, locked.z).sub(this.muzzleWorld);
      if (d.lengthSq() > 1e-6) return d.normalize();
    }
    return ctx.freeAimPoint.clone().sub(this.muzzleWorld).normalize();
  }

  lockedTarget(): FcsTargetInfo | null {
    if (this.fcs.state !== 'locked' || !this.fcs.targetId) return null;
    return this.lastTargetInfo;
  }

  /* ---------------- weapons ---------------- */

  selectWeapon(weapon: WeaponId): void {
    this.weapon = weapon;
    this.fireControl = this.emptyControl();
    this.fireControl.weapon = weapon;
  }

  canFire(now: number): boolean {
    return now >= this.nextFireAt[this.weapon];
  }

  /** Returns a reason string when the shot is refused, otherwise null. */
  refusalReason(now: number): string | null {
    if (!this.canFire(now)) return 'RECHARGING';
    if (this.weapon === 'missile') {
      if (this.ammo.missile <= 0) return 'OUT OF AMMO';
      if (!this.fcs.locked) return 'NO LOCK';
      if (!this.lockedTarget()) return 'TARGET LOST';
      return null;
    }
    if (this.weapon === 'beam') {
      if (this.en < WEAPON_LIST.find((w) => w.id === 'beam')!.enCost) return 'NOT ENOUGH EN';
      return null;
    }
    if (this.ammo.machinegun <= 0) return 'OUT OF AMMO';
    return null;
  }

  /** Called when the trigger is pulled. Returns the created shot record. */
  fire(now: number, ctx: PlayerStepContext): ShotRecord | null {
    const reason = this.refusalReason(now);
    if (reason) return null;
    const spec = WEAPON_LIST.find((w) => w.id === this.weapon)!;
    const locked = this.lockedTarget();
    const sol = this.fireControl;
    const muzzle = new THREE.Vector3().setFromMatrixPosition(this.rig.muzzleAnchor.matrixWorld);
    const dir = sol.launchDirection
      ? new THREE.Vector3(sol.launchDirection[0], sol.launchDirection[1], sol.launchDirection[2]).normalize()
      : ctx.freeAimPoint.clone().sub(muzzle).normalize();

    let initialVelocity: [number, number, number] | null = null;
    let acceleration: [number, number, number] = [0, 0, 0];
    let predictedFlight: number | null = null;
    let intercept: [number, number, number] | null = null;

    if (this.weapon === 'machinegun') {
      this.ammo.machinegun--;
      const speed = SOLVER.mgSpeed;
      initialVelocity = [dir.x * speed, dir.y * speed, dir.z * speed];
      acceleration = [0, -SOLVER.mgGravity, 0];
      predictedFlight = sol.predictedFlightSeconds;
      intercept = sol.predictedInterceptPosition;
    } else if (this.weapon === 'beam') {
      this.spendEn(spec.enCost, now);
      acceleration = [0, 0, 0];
    } else {
      this.ammo.missile--;
      const speed = SOLVER.missileSpeed;
      initialVelocity = [dir.x * speed, dir.y * speed, dir.z * speed];
      acceleration = [0, 0, 0];
      predictedFlight = sol.predictedFlightSeconds;
      intercept = sol.predictedInterceptPosition;
    }

    this.nextFireAt[this.weapon] = now + spec.interval;

    const rec: ShotRecord = {
      id: ++this.shotCounter,
      firedAtSeconds: now,
      weapon: this.weapon,
      targetId: locked ? locked.id : null,
      solutionStatus: sol.status,
      muzzlePosition: [muzzle.x, muzzle.y, muzzle.z],
      targetPositionAtFire: locked ? [locked.x, locked.y, locked.z] : null,
      targetVelocityAtFire: locked ? [locked.vx, locked.vy, locked.vz] : null,
      launchDirection: [dir.x, dir.y, dir.z],
      initialVelocity,
      accelerationAtFire: acceleration,
      predictedFlightSeconds: predictedFlight,
      predictedInterceptPosition: intercept
    };
    this.recentShots.push(rec);
    if (this.recentShots.length > 32) this.recentShots.shift();
    return rec;
  }

  /** current effective stats for the HUD */
  stats() {
    return {
      maxEn: this.maxEn,
      regenPerSecond: this.regenPerSecond,
      lockSeconds: this.lockSeconds,
      horizontalSpeedMultiplier: this.speedMultiplier
    };
  }
}
