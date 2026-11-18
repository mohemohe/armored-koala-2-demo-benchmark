import * as THREE from 'three';
import { PLAYER, GRAVITY, effectiveStats } from './config.js';
import { moveBody, isGrounded } from './collision.js';

const _desired = new THREE.Vector3();
const _target = new THREE.Vector3();
const _horizontal = new THREE.Vector3();
const _delta = new THREE.Vector3();

export function approachVector(current, target, maxDelta) {
  _delta.subVectors(target, current);
  const length = _delta.length();
  if (length <= maxDelta || length < 1e-10) current.copy(target);
  else current.addScaledVector(_delta, maxDelta / length);
}

export class PlayerController {
  constructor(model, colliders, loadout) {
    this.model = model;
    this.colliders = colliders;
    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.qbDirection = new THREE.Vector3();
    this.desiredHorizontalDirection = new THREE.Vector3();
    this.loadout = { ...loadout };
    this.stats = effectiveStats(loadout);
    this.reset(loadout);
  }

  reset(loadout = this.loadout) {
    this.loadout = { ...loadout };
    this.stats = effectiveStats(loadout);
    this.position.set(0, PLAYER.height / 2 + 0.02, 0);
    this.velocity.set(0, 0, 0);
    this.hp = PLAYER.maxHp;
    this.en = this.stats.maxEn;
    this.grounded = true;
    this.verticalMode = 'grounded';
    this.horizontalMode = 'walk';
    this.glideEnabled = false;
    this.desiredHorizontalDirection.set(0, 0, 0);
    this.qbDirection.set(0, 0, 0);
    this.qbSuccessfulCount = 0;
    this.qbLastStartedAt = null;
    this.qbImpulseRemaining = 0;
    this.lastEnSpentAt = null;
    this.spaceHeldSeconds = 0;
    this.spaceSequenceActive = false;
    this.spentThisStep = false;
    this.weapon = 'machinegun';
    this.ammo = { machinegun: 300, missile: 12 };
    this.weaponReadyAt = { machinegun: 0, beam: 0, missile: 0 };
    this.model.setLegs(loadout.legs);
    this.model.setWeapon('machinegun');
    this.syncModel(0, 0);
  }

  get maxEn() { return this.stats.maxEn; }
  qbCooldownRemaining(now) { return this.qbLastStartedAt === null ? 0 : Math.max(0, PLAYER.qbCooldown - (now - this.qbLastStartedAt)); }

  spendEn(amount, now) {
    if (amount <= 0) return 0;
    const spent = Math.min(this.en, amount);
    if (spent > 0) {
      this.en = Math.max(0, this.en - spent);
      this.lastEnSpentAt = now;
      this.spentThisStep = true;
    }
    return spent;
  }

  inputDirection(input, yaw) {
    const x = (input.down('KeyD') ? 1 : 0) - (input.down('KeyA') ? 1 : 0);
    const z = (input.down('KeyW') ? 1 : 0) - (input.down('KeyS') ? 1 : 0);
    if (x === 0 && z === 0) return null;
    // Camera forward is (sin(yaw), 0, -cos(yaw)); right is (cos(yaw), 0, sin(yaw)).
    _desired.set(Math.sin(yaw) * z + Math.cos(yaw) * x, 0, -Math.cos(yaw) * z + Math.sin(yaw) * x);
    return _desired.normalize();
  }

  beginStep(dt, now, input, yaw) {
    this.spentThisStep = false;
    const impulseActive = this.qbImpulseRemaining > 1e-9;
    if (input.consumePress('KeyQ') && !input.down('ControlLeft') && !input.down('ControlRight') && !impulseActive) {
      if (this.qbCooldownRemaining(now) <= 0 && this.en >= PLAYER.qbCost) {
        const direction = this.inputDirection(input, yaw);
        if (direction) this.qbDirection.copy(direction);
        else this.qbDirection.set(Math.sin(yaw), 0, -Math.cos(yaw));
        this.qbDirection.y = 0; this.qbDirection.normalize();
        const speed = PLAYER.qbSpeed * this.stats.horizontalSpeedMultiplier;
        this.velocity.x = this.qbDirection.x * speed;
        this.velocity.z = this.qbDirection.z * speed;
        this.qbImpulseRemaining = PLAYER.qbImpulse;
        this.qbSuccessfulCount++;
        this.qbLastStartedAt = now;
        this.spendEn(PLAYER.qbCost, now);
        this.desiredHorizontalDirection.copy(this.qbDirection);
      }
    }

    if (!impulseActive && this.qbImpulseRemaining <= 0 && input.consumePress('ShiftLeft')) {
      this.glideEnabled = !this.glideEnabled;
      if (this.glideEnabled) {
        const direction = this.inputDirection(input, yaw);
        if (direction) this.desiredHorizontalDirection.copy(direction);
        else if (this.desiredHorizontalDirection.lengthSq() < 1e-8) this.desiredHorizontalDirection.set(Math.sin(yaw), 0, -Math.cos(yaw));
      }
    }
    input.consumePress('ShiftRight'); // Right Shift intentionally has no gameplay binding.

    if (input.consumePress('Space')) {
      this.spaceHeldSeconds = 0;
      this.spaceSequenceActive = true;
      if (this.grounded) {
        this.velocity.y = PLAYER.jumpSpeed;
        this.grounded = false;
        this.verticalMode = 'rising';
      }
    }
    if (!input.down('Space')) {
      this.spaceHeldSeconds = 0;
      this.spaceSequenceActive = false;
    } else if (this.spaceSequenceActive) {
      this.spaceHeldSeconds += dt;
    }
  }

  updateMovement(dt, now, input, yaw) {
    const speedMul = this.stats.horizontalSpeedMultiplier;
    const horizontalBefore = { x: this.velocity.x, z: this.velocity.z };
    const wasImpulse = this.qbImpulseRemaining > 1e-9;
    const braking = input.down('ControlLeft') || input.down('ControlRight');

    if (wasImpulse) {
      this.horizontalMode = 'quickboost';
      this.qbImpulseRemaining = Math.max(0, this.qbImpulseRemaining - dt);
      if (this.qbImpulseRemaining <= 1e-9) {
        this.qbImpulseRemaining = 0;
        this.glideEnabled = true;
        this.horizontalMode = 'glide';
      }
    } else {
      if (braking) this.glideEnabled = false;
      const direction = this.inputDirection(input, yaw);
      if (this.glideEnabled && !braking) {
        this.horizontalMode = 'glide';
        if (direction) this.desiredHorizontalDirection.copy(direction);
        if (this.desiredHorizontalDirection.lengthSq() < 1e-8) this.desiredHorizontalDirection.set(Math.sin(yaw), 0, -Math.cos(yaw));
        const targetSpeed = (this.grounded ? PLAYER.groundGlideSpeed : PLAYER.airSpeed) * speedMul;
        _target.copy(this.desiredHorizontalDirection).setY(0).normalize().multiplyScalar(targetSpeed);
        _horizontal.set(this.velocity.x, 0, this.velocity.z);
        const base = this.grounded ? PLAYER.groundGlideSpeed : PLAYER.airSpeed;
        const maxDelta = (PLAYER.qbSpeed - base) / PLAYER.qbDecelerationSeconds * speedMul * dt;
        approachVector(_horizontal, _target, maxDelta);
        this.velocity.x = _horizontal.x; this.velocity.z = _horizontal.z;
      } else {
        this.horizontalMode = 'walk';
        const targetSpeed = (this.grounded ? PLAYER.walkSpeed : PLAYER.airSpeed) * speedMul;
        if (direction && !braking) _target.copy(direction).multiplyScalar(targetSpeed);
        else _target.set(0, 0, 0);
        _horizontal.set(this.velocity.x, 0, this.velocity.z);
        approachVector(_horizontal, _target, PLAYER.walkAcceleration * speedMul * dt);
        this.velocity.x = _horizontal.x; this.velocity.z = _horizontal.z;
        if (braking) this.desiredHorizontalDirection.set(0, 0, 0);
      }
    }

    // Vertical motion uses analytic constant-acceleration displacement. Flight EN is paid after QB/beam in Game.step.
    const wantsFlight = this.spaceSequenceActive && input.down('Space') && this.spaceHeldSeconds + 1e-9 >= PLAYER.flyHoldSeconds && !this.grounded && this.en > 0;
    let verticalDisplacement;
    if (wantsFlight) {
      const requested = PLAYER.flyEnPerSecond * dt;
      const paid = this.spendEn(requested, now);
      const poweredDt = Math.min(dt, paid / PLAYER.flyEnPerSecond);
      const remaining = dt - poweredDt;
      verticalDisplacement = PLAYER.flyRiseSpeed * poweredDt;
      if (remaining > 1e-10) verticalDisplacement += PLAYER.flyRiseSpeed * remaining + 0.5 * GRAVITY * remaining * remaining;
      this.velocity.y = PLAYER.flyRiseSpeed + GRAVITY * remaining;
      this.verticalMode = remaining > 1e-10 ? 'falling' : 'flying';
    } else {
      const initialY = this.grounded && this.velocity.y <= 0 ? 0 : this.velocity.y;
      verticalDisplacement = this.grounded && initialY === 0 ? 0 : initialY * dt + 0.5 * GRAVITY * dt * dt;
      this.velocity.y = this.grounded && initialY === 0 ? 0 : initialY + GRAVITY * dt;
      this.verticalMode = this.grounded ? 'grounded' : (this.velocity.y > 0.01 ? 'rising' : 'falling');
    }

    const collisionVelocity = this.velocity.clone();
    // Trapezoidal integration preserves the specified finite-acceleration distance exactly at 120 Hz.
    if (dt > 0) {
      collisionVelocity.x = (horizontalBefore.x + this.velocity.x) / 2;
      collisionVelocity.z = (horizontalBefore.z + this.velocity.z) / 2;
      collisionVelocity.y = verticalDisplacement / dt;
    }
    const result = moveBody(this.position, collisionVelocity, dt, PLAYER.radius, PLAYER.height, this.colliders);
    if (result.hitX) this.velocity.x = 0;
    if (result.hitZ) this.velocity.z = 0;
    if (result.hitY) this.velocity.y = 0;
    this.grounded = result.grounded || (this.velocity.y <= 0 && isGrounded(this.position, PLAYER.radius, PLAYER.height, this.colliders));
    if (this.grounded && this.velocity.y <= 0) {
      this.velocity.y = 0;
      if (!wantsFlight) this.verticalMode = 'grounded';
    } else if (!wantsFlight) {
      this.verticalMode = this.velocity.y > 0.01 ? 'rising' : 'falling';
    }

    if (this.grounded && !this.spentThisStep) {
      const regenStart = this.lastEnSpentAt === null ? now : this.lastEnSpentAt + PLAYER.regenDelay;
      const regenDt = Math.min(dt, Math.max(0, now + dt - Math.max(now, regenStart)));
      if (regenDt > 0) this.en = Math.min(this.maxEn, this.en + this.stats.regenPerSecond * regenDt);
    }
    this.en = Math.max(0, Math.min(this.maxEn, this.en));
  }

  syncModel(time, yaw, aimDirection = null) {
    this.model.group.position.set(this.position.x, this.position.y - PLAYER.height / 2, this.position.z);
    this.model.group.rotation.y = -yaw;
    if (aimDirection) this.model.setAimDirection(aimDirection, -yaw);
    this.model.animate(time, Math.hypot(this.velocity.x, this.velocity.z), this.grounded, this.verticalMode, this.horizontalMode);
    this.model.group.updateMatrixWorld(true);
  }

  getMuzzlePosition(out = new THREE.Vector3()) {
    this.model.group.updateMatrixWorld(true);
    return this.model.muzzle.getWorldPosition(out);
  }

  damage(amount) { this.hp = Math.max(0, this.hp - amount); }

  snapshot(now) {
    return {
      position: this.position.toArray(), velocity: this.velocity.toArray(), grounded: this.grounded,
      hp: this.hp, en: this.en, weapon: this.weapon, ammo: { ...this.ammo },
      movement: {
        horizontalMode: this.horizontalMode,
        verticalMode: this.verticalMode,
        glideEnabled: this.glideEnabled,
        desiredHorizontalDirection: [this.desiredHorizontalDirection.x, this.desiredHorizontalDirection.z],
        qbSuccessfulCount: this.qbSuccessfulCount,
        qbLastStartedAtSeconds: this.qbLastStartedAt,
        qbImpulseRemainingSeconds: this.qbImpulseRemaining,
        qbCooldownRemainingSeconds: this.qbCooldownRemaining(now),
        lastEnSpentAtSeconds: this.lastEnSpentAt,
      },
    };
  }
}
