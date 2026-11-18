/** Deterministic movement and shared EN accounting. Coordinates are metres, y is up;
 * position is the player's feet. Call beginMovement once for input edges, perform
 * beam spending, then call stepMovement for continuous flight and regeneration. */
const EPS = 1e-10;
const unit = (x, z, fallback = { x: 0, z: 1 }) => {
  const n = Math.hypot(x, z);
  return n > EPS ? { x: x / n, z: z / n } : { ...fallback };
};
const hasDirection = d => d && Math.hypot(d.x, d.z) > EPS;

export function createMovement({ maxEn = 120, regenPerSecond = 15, speedMultiplier = 1, position = { x: 0, y: 0, z: 0 } } = {}) {
  return {
    position: { ...position }, velocity: { x: 0, y: 0, z: 0 }, grounded: true,
    en: maxEn, maxEn, regenPerSecond, speedMultiplier,
    glideEnabled: false, desiredHorizontalDirection: { x: 0, z: 0 },
    qbSuccessfulCount: 0, qbLastStartedAtSeconds: null, qbImpulseRemainingSeconds: 0,
    lastEnSpentAtSeconds: null, horizontalMode: 'walk', verticalMode: 'grounded'
  };
}

export function spendEnergy(state, amount, now) {
  if (amount <= 0) return true;
  if (state.en + EPS < amount) return false;
  state.en = Math.max(0, state.en - amount);
  state.lastEnSpentAtSeconds = now;
  return true;
}

export function qbCooldown(state, now) {
  return state.qbLastStartedAtSeconds === null ? 0 : Math.max(0, 1 - (now - state.qbLastStartedAtSeconds));
}

/** Input edge flags must occur only on an actual key-down transition. */
export function beginMovement(state, input, now) {
  const direction = input.direction || { x: 0, z: 0 };
  const forward = unit(input.forward?.x || 0, input.forward?.z || 0);
  const inImpulse = state.qbImpulseRemainingSeconds > EPS;
  if (input.qbPressed && !input.brake && !inImpulse && qbCooldown(state, now) <= EPS && spendEnergy(state, 36, now)) {
    const d = hasDirection(direction) ? unit(direction.x, direction.z) : forward;
    state.velocity.x = d.x * 80 * state.speedMultiplier;
    state.velocity.z = d.z * 80 * state.speedMultiplier;
    state.desiredHorizontalDirection = d;
    state.qbImpulseRemainingSeconds = 0.15;
    state.qbLastStartedAtSeconds = now;
    state.qbSuccessfulCount++;
    state.horizontalMode = 'quickboost';
  }
  if (state.qbImpulseRemainingSeconds <= EPS && input.shiftPressed) {
    state.glideEnabled = !state.glideEnabled;
    if (state.glideEnabled) state.desiredHorizontalDirection = hasDirection(direction) ? unit(direction.x, direction.z) : forward;
  }
  if (state.qbImpulseRemainingSeconds <= EPS && input.brake) state.glideEnabled = false;
  if (input.jumpPressed && state.grounded) {
    state.grounded = false;
    state.velocity.y = 10;
  }
}

function approachVector(vx, vz, tx, tz, maxChange) {
  const dx = tx - vx, dz = tz - vz, dist = Math.hypot(dx, dz);
  if (dist <= maxChange || dist < EPS) return { x: tx, z: tz, reachedIn: dist < EPS ? 0 : dist / maxChange };
  return { x: vx + dx / dist * maxChange, z: vz + dz / dist * maxChange, reachedIn: 1 };
}

/**
 * collision(state, displacement) optionally moves feet by displacement, clips the
 * velocity at walls/ceilings and sets grounded. Without a callback, a y=0 plane
 * is used. dt should be <= 1/120 s. now is the start of the interval.
 */
export function stepMovement(state, input, dt, now, collision = null) {
  let left = dt, cursor = now;
  while (left > EPS) {
    const impulse = state.qbImpulseRemainingSeconds > EPS;
    const h = Math.min(left, impulse ? state.qbImpulseRemainingSeconds : left);
    const direction = input.direction || { x: 0, z: 0 };
    const vx0 = state.velocity.x, vz0 = state.velocity.z;
    let dx, dz;
    if (impulse) {
      state.horizontalMode = 'quickboost';
      dx = vx0 * h; dz = vz0 * h;
      state.qbImpulseRemainingSeconds = Math.max(0, state.qbImpulseRemainingSeconds - h);
    } else {
      if (input.brake) state.glideEnabled = false;
      if (state.glideEnabled && hasDirection(direction)) state.desiredHorizontalDirection = unit(direction.x, direction.z);
      let tx = 0, tz = 0, acceleration;
      if (state.glideEnabled && !input.brake) {
        state.horizontalMode = 'glide';
        const d = state.desiredHorizontalDirection;
        const speed = (state.grounded ? 22 : 16) * state.speedMultiplier;
        tx = d.x * speed; tz = d.z * speed;
        acceleration = (state.grounded ? (80 - 22) : (80 - 16)) / 0.60 * state.speedMultiplier;
      } else {
        state.horizontalMode = 'walk';
        if (!input.brake && hasDirection(direction)) {
          const d = unit(direction.x, direction.z);
          state.desiredHorizontalDirection = d;
          const speed = (state.grounded ? 10 : 16) * state.speedMultiplier;
          tx = d.x * speed; tz = d.z * speed;
        } else state.desiredHorizontalDirection = { x: 0, z: 0 };
        acceleration = 120 * state.speedMultiplier;
      }
      const next = approachVector(vx0, vz0, tx, tz, acceleration * h);
      state.velocity.x = next.x; state.velocity.z = next.z;
      // Integrate the part before reaching the target, then the constant-speed part.
      const t = h * next.reachedIn;
      dx = (vx0 + next.x) * 0.5 * t + next.x * (h - t);
      dz = (vz0 + next.z) * 0.5 * t + next.z * (h - t);
    }
    let dy = 0;
    let flyingTime = 0;
    if (input.spaceHeld && (input.spaceHeldSeconds || 0) >= 0.20 && !state.grounded && state.en > EPS) {
      flyingTime = Math.min(h, state.en / 20);
      if (flyingTime > EPS) {
        // Continuous EN expenditure is charged only for time actually propelled.
        state.en = Math.max(0, state.en - 20 * flyingTime);
        state.lastEnSpentAtSeconds = cursor + flyingTime;
        state.velocity.y = 8;
        dy += 8 * flyingTime;
      }
    }
    const gravityTime = h - flyingTime;
    if (!state.grounded && gravityTime > EPS) {
      dy += state.velocity.y * gravityTime - 9 * gravityTime * gravityTime;
      state.velocity.y -= 18 * gravityTime;
    }
    if (collision) {
      collision(state, { x: dx, y: dy, z: dz });
    } else {
      state.position.x += dx; state.position.y += dy; state.position.z += dz;
      if (state.position.y <= 0 && state.velocity.y <= 0) {
        state.position.y = 0; state.velocity.y = 0; state.grounded = true;
      } else state.grounded = false;
    }
    if (state.grounded && flyingTime === 0 && state.lastEnSpentAtSeconds !== null) {
      // Integrate only the portion after the recharge delay.
      const eligible = Math.max(0, cursor + h - Math.max(cursor, state.lastEnSpentAtSeconds + 0.75));
      state.en = Math.min(state.maxEn, state.en + state.regenPerSecond * eligible);
    } else if (state.grounded && flyingTime === 0 && state.lastEnSpentAtSeconds === null) {
      state.en = Math.min(state.maxEn, state.en + state.regenPerSecond * h);
    }
    if (impulse && state.qbImpulseRemainingSeconds <= EPS) {
      state.qbImpulseRemainingSeconds = 0;
      state.glideEnabled = true;
      state.horizontalMode = 'glide';
    }
    state.verticalMode = state.grounded ? 'grounded' : flyingTime > EPS ? 'flying' : state.velocity.y > 0 ? 'rising' : 'falling';
    cursor += h; left -= h;
  }
}
