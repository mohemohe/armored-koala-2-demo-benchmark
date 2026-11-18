import { Vector3 } from 'three';
import { DEFAULT_LOADOUT, effectiveStats, PHYSICS, WEAPONS } from './config.js';

const EPS = 1e-10;

export function createPlayer(loadout = DEFAULT_LOADOUT, position = new Vector3()) {
  return {
    position: position.clone(), previousPosition: position.clone(), velocity: new Vector3(),
    grounded: true, hp: PHYSICS.maxHp, en: effectiveStats(loadout).maxEn,
    yaw: 0, radius: PHYSICS.playerRadius, height: PHYSICS.playerHeight,
    weapon: 'machinegun', ammo: { machinegun: WEAPONS.machinegun.ammo, missile: WEAPONS.missile.ammo },
    movement: {
      horizontalMode: 'walk', verticalMode: 'grounded', glideEnabled: false,
      desiredHorizontalDirection: [0, 0], qbSuccessfulCount: 0,
      qbLastStartedAtSeconds: null, qbImpulseRemainingSeconds: 0,
      qbCooldownRemainingSeconds: 0, lastEnSpentAtSeconds: null,
    },
    _qbEnd: null, lastFeedback: '', feedbackUntil: 0,
    lastHitDirection: new Vector3(), lastHitAt: null,
  };
}

// Shared transaction used by QB, beams and flight, in that order.
export function spendEn(player, amount, time) {
  if (amount < 0 || !Number.isFinite(amount)) throw new Error('Invalid EN cost');
  if (player.en + EPS < amount) return false;
  if (amount > 0) {
    player.en = Math.max(0, player.en - amount);
    player.movement.lastEnSpentAtSeconds = time;
  }
  return true;
}

function inputDirection(input) {
  const forward = input.forward || 0;
  const right = input.right || 0;
  const yaw = input.yaw || 0;
  // Camera forward is +Z: camera/screen right is (-cos(yaw),0,sin(yaw)).
  const x = Math.sin(yaw) * forward - Math.cos(yaw) * right;
  const z = Math.cos(yaw) * forward + Math.sin(yaw) * right;
  const length = Math.hypot(x, z);
  return length > EPS ? [x / length, z / length] : null;
}

function cameraDirection(input) { return [Math.sin(input.yaw || 0), Math.cos(input.yaw || 0)]; }

function updateTimers(player, time) {
  const movement = player.movement;
  movement.qbImpulseRemainingSeconds = player._qbEnd === null ? 0 : Math.max(0, player._qbEnd - time);
  movement.qbCooldownRemainingSeconds = movement.qbLastStartedAtSeconds === null ? 0
    : Math.max(0, movement.qbLastStartedAtSeconds + PHYSICS.quickboostCooldown - time);
  if (player._qbEnd !== null && time + EPS >= player._qbEnd) {
    player._qbEnd = null;
    movement.qbImpulseRemainingSeconds = 0;
    movement.glideEnabled = true;
    movement.horizontalMode = 'glide';
  }
}

function feedback(player, message, time) {
  player.lastFeedback = message;
  player.feedbackUntil = time + 1.2;
}

// Called once at the current simulation instant, before weapon expenditure.
// The input adapter supplies edge presses (not key state or OS key repeat).
export function prepareMovement(player, input, stats, time) {
  updateTimers(player, time);
  const movement = player.movement;
  const direction = inputDirection(input);
  if (input.qPressed) {
    if (input.brake) feedback(player, 'BRAKE — QB不可', time);
    else if (movement.qbCooldownRemainingSeconds > EPS) feedback(player, 'QB COOLDOWN', time);
    else if (!spendEn(player, PHYSICS.quickboostCost, time)) feedback(player, 'EN不足 — QB 36 EN', time);
    else {
      const qbDirection = direction || cameraDirection(input);
      movement.desiredHorizontalDirection = [...qbDirection];
      player.velocity.x = qbDirection[0] * PHYSICS.quickboostSpeed * stats.horizontalSpeedMultiplier;
      player.velocity.z = qbDirection[1] * PHYSICS.quickboostSpeed * stats.horizontalSpeedMultiplier;
      player._qbEnd = time + PHYSICS.quickboostDuration;
      movement.qbLastStartedAtSeconds = time;
      movement.qbSuccessfulCount++;
      movement.horizontalMode = 'quickboost';
      updateTimers(player, time);
    }
  }

  // Neither a mode edge nor held brake cancels an already-started impulse.
  if (player._qbEnd === null) {
    if (input.shiftPressed) {
      movement.glideEnabled = !movement.glideEnabled;
      if (movement.glideEnabled) movement.desiredHorizontalDirection = direction || cameraDirection(input);
    }
    if (input.brake) movement.glideEnabled = false;
    movement.horizontalMode = movement.glideEnabled ? 'glide' : 'walk';
  }
  if (input.jumpPressed && player.grounded) {
    player.velocity.y = PHYSICS.jumpSpeed;
    player.grounded = false;
    movement.verticalMode = 'rising';
  }
}

function integrateSegment(player, input, stats, time, duration, world, flying) {
  const movement = player.movement;
  const multiplier = stats.horizontalSpeedMultiplier;
  const before = player.velocity.clone();
  let goalX = before.x;
  let goalZ = before.z;
  let acceleration = 0;
  if (player._qbEnd === null) {
    if (input.brake) movement.glideEnabled = false;
    movement.horizontalMode = movement.glideEnabled ? 'glide' : 'walk';
    const direction = inputDirection(input);
    if (movement.glideEnabled) {
      if (direction) movement.desiredHorizontalDirection = direction;
      const speed = (player.grounded ? PHYSICS.glideSpeed : PHYSICS.airSpeed) * multiplier;
      goalX = movement.desiredHorizontalDirection[0] * speed;
      goalZ = movement.desiredHorizontalDirection[1] * speed;
      acceleration = (PHYSICS.quickboostSpeed - (player.grounded ? PHYSICS.glideSpeed : PHYSICS.airSpeed))
        / PHYSICS.glideTransitionSeconds * multiplier;
    } else {
      const desired = input.brake ? [0, 0] : direction || [0, 0];
      movement.desiredHorizontalDirection = desired;
      const speed = (player.grounded ? PHYSICS.walkSpeed : PHYSICS.airSpeed) * multiplier;
      goalX = desired[0] * speed;
      goalZ = desired[1] * speed;
      acceleration = PHYSICS.walkAcceleration * multiplier;
    }
  }
  const dx = goalX - before.x;
  const dz = goalZ - before.z;
  const difference = Math.hypot(dx, dz);
  // Split exactly when the target is reached; trapezoidal integration then
  // represents a linear acceleration, never an end-of-tick velocity shortcut.
  const reachTime = acceleration > 0 ? difference / acceleration : Infinity;
  const step = reachTime > EPS && reachTime < duration ? reachTime : duration;
  const amount = difference > EPS ? Math.min(1, acceleration * step / difference) : 0;
  const after = before.clone();
  after.x += dx * amount;
  after.z += dz * amount;
  if (flying) { before.y = PHYSICS.flightSpeed; after.y = PHYSICS.flightSpeed; }
  else if (player.grounded) { before.y = 0; after.y = 0; }
  else after.y -= PHYSICS.gravity * step;
  const average = before.clone().add(after).multiplyScalar(0.5);
  const requested = average.clone();
  const wasGrounded = player.grounded;
  const result = world.moveBody(player.position, average, step, player.radius, player.height);
  player.grounded = result.grounded;
  // moveBody projects velocity out of contacts. Preserve that projection rather
  // than reapplying the pre-contact QB impulse on the next simulator update.
  for (const axis of ['x', 'y', 'z']) {
    player.velocity[axis] = Math.abs(average[axis] - requested[axis]) > EPS ? average[axis] : after[axis];
  }
  if (player.grounded && player.velocity.y < 0) player.velocity.y = 0;
  if (flying) spendEn(player, Math.min(player.en, PHYSICS.flightCostPerSecond * step), time + step);
  else if (wasGrounded && player.grounded) {
    const lastSpent = movement.lastEnSpentAtSeconds;
    const eligibleAt = lastSpent === null ? time : lastSpent + PHYSICS.regenDelaySeconds;
    const recoveryTime = Math.max(0, time + step - Math.max(time, eligibleAt));
    player.en = Math.min(stats.maxEn, player.en + stats.regenPerSecond * recoveryTime);
  }
  movement.verticalMode = player.grounded ? 'grounded'
    : flying && player.en > EPS ? 'flying' : player.velocity.y > 0 ? 'rising' : 'falling';
  return step;
}

// Advance [time,time+dt]. Event boundaries are split even when callers supply
// a long frame; position and EN therefore do not depend on display frequency.
export function updateMovement(player, input, stats, time, dt, world) {
  let consumed = 0;
  while (consumed < dt - EPS) {
    const now = time + consumed;
    updateTimers(player, now);
    let duration = Math.min(dt - consumed, PHYSICS.fixedStep);
    if (player._qbEnd !== null) duration = Math.min(duration, player._qbEnd - now);
    const heldSeconds = (input.spaceHeldSeconds || 0) + consumed;
    let flying = !!input.spaceHeld && heldSeconds + EPS >= PHYSICS.flightHoldSeconds && player.en > EPS;
    if (input.spaceHeld && heldSeconds < PHYSICS.flightHoldSeconds - EPS) {
      duration = Math.min(duration, PHYSICS.flightHoldSeconds - heldSeconds);
    }
    if (flying) {
      player.grounded = false;
      duration = Math.min(duration, player.en / PHYSICS.flightCostPerSecond);
    }
    consumed += integrateSegment(player, input, stats, now, duration, world, flying);
  }
  player.en = Math.max(0, Math.min(stats.maxEn, player.en));
  updateTimers(player, time + dt);
}
