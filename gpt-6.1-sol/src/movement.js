import { CONFIG, WEAPONS, effectiveStats } from './config.js';
export { CONFIG, FCS, GENERATORS, LEGS, WEAPONS, effectiveStats } from './config.js';

const EPS = 1e-10;
const direction2 = (value) => {
  const x = Number(value?.[0]) || 0;
  const z = Number(value?.[1]) || 0;
  const length = Math.hypot(x, z);
  return length > EPS ? [x / length, z / length] : [0, 0];
};
const forward2 = (input) => {
  const value = direction2(input.cameraForward ?? input.forward ?? [1, 0]);
  return Math.hypot(...value) > EPS ? value : [1, 0];
};

export function createPlayer(loadout = CONFIG.defaultLoadout, start = [10, 2.1, 0]) {
  const stats = effectiveStats(loadout);
  return {
    position: [...start],
    velocity: [0, 0, 0],
    halfExtents: [...CONFIG.playerHalfExtents],
    grounded: true,
    hp: CONFIG.maxHp,
    en: stats.maxEn,
    weapon: 'machinegun',
    ammo: { machinegun: WEAPONS.machinegun.ammo, missile: WEAPONS.missile.ammo },
    nextFireAt: { machinegun: 0, beam: 0, missile: 0 },
    movement: {
      horizontalMode: 'walk',
      verticalMode: 'grounded',
      glideEnabled: false,
      desiredHorizontalDirection: [0, 0],
      qbSuccessfulCount: 0,
      qbLastStartedAtSeconds: null,
      qbImpulseRemainingSeconds: 0,
      qbCooldownRemainingSeconds: 0,
      lastEnSpentAtSeconds: null,
    },
  };
}

export function spendEn(player, amount, time) {
  if (!Number.isFinite(amount) || amount < 0 || player.en + EPS < amount) return false;
  if (amount > 0) {
    player.en = Math.max(0, player.en - amount);
    player.movement.lastEnSpentAtSeconds = time;
  }
  return true;
}

function impulseRemaining(player, time) {
  const started = player.movement.qbLastStartedAtSeconds;
  return started === null ? 0 : Math.max(0, started + CONFIG.qbImpulseSeconds - time);
}

function endImpulse(player) {
  const movement = player.movement;
  if (movement.horizontalMode === 'quickboost') {
    movement.glideEnabled = true;
    movement.horizontalMode = 'glide';
  }
  movement.qbImpulseRemainingSeconds = 0;
}

// Execute Q/Shift/Space edges before the caller evaluates beam costs. Calling this
// explicitly and setting input.edgesHandled makes the common EN spending order
// QB -> beam -> continuous flight unambiguous.
export function beginMovementInput(player, input, time, stats) {
  const movement = player.movement;
  const direction = direction2(input.direction ?? input.movementDirection);
  if (impulseRemaining(player, time) <= EPS) endImpulse(player);
  let qbStarted = false;
  if (input.qbPressed && !input.brake && impulseRemaining(player, time) <= EPS) {
    const last = movement.qbLastStartedAtSeconds;
    if ((last === null || time - last + EPS >= CONFIG.qbCooldownSeconds) && spendEn(player, CONFIG.qbCost, time)) {
      const qbDirection = Math.hypot(...direction) > EPS ? direction : forward2(input);
      const speed = CONFIG.qbSpeed * stats.horizontalSpeedMultiplier;
      player.velocity[0] = qbDirection[0] * speed;
      player.velocity[2] = qbDirection[1] * speed;
      movement.desiredHorizontalDirection = [...qbDirection];
      movement.horizontalMode = 'quickboost';
      movement.qbSuccessfulCount += 1;
      movement.qbLastStartedAtSeconds = time;
      movement.qbImpulseRemainingSeconds = CONFIG.qbImpulseSeconds;
      movement.qbCooldownRemainingSeconds = CONFIG.qbCooldownSeconds;
      qbStarted = true;
    }
  }
  // Shift is ignored during a committed impulse, including the start instant.
  if (input.glidePressed && impulseRemaining(player, time) <= EPS) {
    movement.glideEnabled = !movement.glideEnabled;
    if (movement.glideEnabled) {
      movement.desiredHorizontalDirection = Math.hypot(...direction) > EPS ? direction : forward2(input);
    }
  }
  if (input.jumpPressed && player.grounded) {
    player.grounded = false;
    player.velocity[1] = CONFIG.jumpSpeed;
    movement.verticalMode = 'rising';
  }
  return qbStarted;
}

function floorOnlyMove(position, velocity, dt, halfExtents) {
  const next = position.map((value, index) => value + velocity[index] * dt);
  const nextVelocity = [...velocity];
  const grounded = next[1] <= halfExtents[1] + EPS && velocity[1] <= EPS;
  if (grounded) {
    next[1] = halfExtents[1];
    nextVelocity[1] = 0;
  }
  return { position: next, velocity: nextVelocity, grounded };
}

function horizontalTarget(player, input, stats, time) {
  const movement = player.movement;
  const multiplier = stats.horizontalSpeedMultiplier;
  const direction = direction2(input.direction ?? input.movementDirection);
  const impulse = impulseRemaining(player, time) > EPS;
  if (impulse) return { velocity: [player.velocity[0], player.velocity[2]], acceleration: 0 };
  if (input.brake) movement.glideEnabled = false;
  if (movement.glideEnabled) {
    if (Math.hypot(...direction) > EPS) movement.desiredHorizontalDirection = direction;
    const desired = movement.desiredHorizontalDirection;
    const speed = (player.grounded ? CONFIG.glideSpeed : CONFIG.airSpeed) * multiplier;
    movement.horizontalMode = 'glide';
    return {
      velocity: [desired[0] * speed, desired[1] * speed],
      acceleration: (player.grounded ? CONFIG.groundGlideAcceleration : CONFIG.airGlideAcceleration) * multiplier,
    };
  }
  movement.horizontalMode = 'walk';
  movement.desiredHorizontalDirection = input.brake ? [0, 0] : direction;
  const speed = (player.grounded ? CONFIG.walkSpeed : CONFIG.airSpeed) * multiplier;
  return {
    velocity: input.brake ? [0, 0] : [direction[0] * speed, direction[1] * speed],
    acceleration: CONFIG.walkAcceleration * multiplier,
  };
}

function moveCollision(player, averageVelocity, finalVelocity, seconds, world) {
  const moveBody = world?.moveBody ? world.moveBody.bind(world) : floorOnlyMove;
  const result = moveBody([...player.position], [...averageVelocity], seconds, player.halfExtents);
  player.position = [...result.position];
  // Collision solvers receive average velocity for exact displacement. Transfer
  // their clipped components to the end-of-interval physical velocity.
  if (result.collisionNormals?.length) {
    for (const normal of result.collisionNormals) {
      const dot = finalVelocity.reduce((sum, value, index) => sum + value * normal[index], 0);
      if (dot < 0) for (let index = 0; index < 3; index++) finalVelocity[index] -= normal[index] * dot;
    }
  } else {
    for (let index = 0; index < 3; index++) {
      if (Math.abs(result.velocity[index] - averageVelocity[index]) > EPS) {
        if (Math.abs(result.velocity[index]) < EPS) finalVelocity[index] = 0;
        else finalVelocity[index] *= result.velocity[index] / (averageVelocity[index] || 1);
      }
    }
  }
  player.velocity = finalVelocity;
  player.grounded = !!result.grounded;
  if (player.grounded && player.velocity[1] < 0) player.velocity[1] = 0;
}

// time is the interval's start time; input direction is already camera-relative
// and converted to a horizontal world direction. Physics always use <=1/120s.
export function stepMovement(player, input, dt, time, stats = effectiveStats(), world = null) {
  if (!Number.isFinite(dt) || dt < 0) throw new Error('Movement dt must be nonnegative');
  if (!input.edgesHandled) beginMovementInput(player, input, time, stats);
  const movement = player.movement;
  const heldAtStart = Math.max(0, Number(input.spaceHeldSeconds) || 0);
  let progressed = 0;
  while (progressed + EPS < dt) {
    const now = time + progressed;
    const impulse = impulseRemaining(player, now);
    if (impulse <= EPS) endImpulse(player);
    let seconds = Math.min(CONFIG.simulationStep, dt - progressed);
    if (impulse > EPS) seconds = Math.min(seconds, impulse);

    const heldSeconds = heldAtStart + progressed;
    if (input.spaceHeld && heldSeconds + EPS < CONFIG.flightHoldSeconds) {
      seconds = Math.min(seconds, CONFIG.flightHoldSeconds - heldSeconds);
    }
    const flying = !!input.spaceHeld && heldSeconds + EPS >= CONFIG.flightHoldSeconds && player.en > EPS;
    if (flying) seconds = Math.min(seconds, player.en / CONFIG.flightEnPerSecond);
    const groundedAtStart = player.grounded;
    if (flying) player.grounded = false;

    const target = horizontalTarget(player, input, stats, now);
    const horizontalDifference = [target.velocity[0] - player.velocity[0], target.velocity[1] - player.velocity[2]];
    const distanceToTarget = Math.hypot(...horizontalDifference);
    if (target.acceleration > 0 && distanceToTarget > EPS) {
      seconds = Math.min(seconds, distanceToTarget / target.acceleration);
    }
    const acceleration = target.acceleration > 0 && distanceToTarget > EPS
      ? horizontalDifference.map((value) => value / distanceToTarget * target.acceleration)
      : [0, 0];
    const finalVelocity = [...player.velocity];
    finalVelocity[0] += acceleration[0] * seconds;
    finalVelocity[2] += acceleration[1] * seconds;
    if (distanceToTarget <= target.acceleration * seconds + EPS && target.acceleration > 0) {
      finalVelocity[0] = target.velocity[0];
      finalVelocity[2] = target.velocity[1];
    }

    if (flying) {
      player.grounded = false;
      player.velocity[1] = CONFIG.flightSpeed;
      finalVelocity[1] = CONFIG.flightSpeed;
      spendEn(player, Math.min(player.en, CONFIG.flightEnPerSecond * seconds), now + seconds);
    } else if (player.grounded) {
      finalVelocity[1] = 0;
    } else {
      finalVelocity[1] -= CONFIG.gravity * seconds;
    }
    const averageVelocity = player.velocity.map((value, index) => (value + finalVelocity[index]) * 0.5);
    moveCollision(player, averageVelocity, finalVelocity, seconds, world);

    if (!flying && groundedAtStart && player.grounded) {
      const regenAt = movement.lastEnSpentAtSeconds === null ? -Infinity : movement.lastEnSpentAtSeconds + CONFIG.regenDelaySeconds;
      const recoverySeconds = Math.max(0, now + seconds - Math.max(now, regenAt));
      player.en = Math.min(stats.maxEn, player.en + recoverySeconds * stats.regenPerSecond);
    }
    movement.verticalMode = player.grounded ? 'grounded' : flying ? 'flying' : player.velocity[1] > 0 ? 'rising' : 'falling';
    progressed += seconds;
  }
  const endTime = time + dt;
  movement.qbImpulseRemainingSeconds = impulseRemaining(player, endTime);
  if (movement.qbImpulseRemainingSeconds <= EPS) endImpulse(player);
  movement.qbCooldownRemainingSeconds = movement.qbLastStartedAtSeconds === null
    ? 0 : Math.max(0, movement.qbLastStartedAtSeconds + CONFIG.qbCooldownSeconds - endTime);
  player.en = Math.min(stats.maxEn, Math.max(0, player.en));
  return player;
}
