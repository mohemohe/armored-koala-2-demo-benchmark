import { WEAPONS } from './ballistics.js';

export const FCS = Object.freeze({
  wide: { radius: 0.30, seconds: 1.20 },
  medium: { radius: 0.20, seconds: 0.80 },
  narrow: { radius: 0.10, seconds: 0.40 }
});
export const GENERATORS = Object.freeze({
  capacity: { maxEn: 180, regen: 10 },
  balanced: { maxEn: 120, regen: 15 },
  recovery: { maxEn: 90, regen: 20 }
});
export const LEGS = Object.freeze({
  biped: { speed: 1, regen: 1, lockSpeed: 1 },
  quadruped: { speed: 0.8, regen: 0.75, lockSpeed: 1.5 }
});
export const MOVEMENT = Object.freeze({
  walk: 10, glide: 22, air: 16, quickboost: 80,
  acceleration: 120, impulseSeconds: 0.15, coastSeconds: 0.60,
  qbEn: 36, cooldown: 1, regenDelay: 0.75,
  jump: 10, climb: 8, gravity: 18, flightDelay: 0.20, enPerFlightSecond: 20,
  radius: 0.86, height: 3.35, hp: 1000
});

export function stats(loadout) {
  const gen = GENERATORS[loadout.generator], legs = LEGS[loadout.legs];
  return {
    maxEn: gen.maxEn, regenPerSecond: gen.regen * legs.regen,
    lockSeconds: FCS[loadout.fcs].seconds / legs.lockSpeed,
    horizontalSpeedMultiplier: legs.speed
  };
}

export function createPlayer(loadout, spawn) {
  const effectiveStats = stats(loadout);
  return {
    loadout: { ...loadout }, stats: effectiveStats, pos: spawn.clone(),
    vel: spawn.clone().set(0, 0, 0), hp: MOVEMENT.hp, en: effectiveStats.maxEn,
    grounded: true, weapon: 'machinegun', ammo: { machinegun: WEAPONS.machinegun.ammo, missile: WEAPONS.missile.ammo },
    movement: {
      horizontalMode: 'walk', verticalMode: 'grounded', glideEnabled: false,
      desiredHorizontalDirection: [0, 0], qbSuccessfulCount: 0,
      qbLastStartedAtSeconds: null, qbImpulseRemainingSeconds: 0,
      qbCooldownRemainingSeconds: 0, lastEnSpentAtSeconds: null
    },
    spaceHeldSeconds: 0, delta: spawn.clone().set(0, 0, 0)
  };
}

export function spendEN(p, cost, time) {
  if (cost > p.en || cost < 0) return false;
  if (cost > 0) {
    p.en -= cost;
    p.movement.lastEnSpentAtSeconds = time;
  }
  return true;
}

// Record physical edges even when simulation is suspended. Held inputs are
// suppressed across resume until a fresh physical press occurs.
export class KeyInput {
  held = new Set();
  active = new Set();
  edges = new Set();
  down(code, playing, repeat = false) {
    if (repeat || this.held.has(code)) return;
    this.held.add(code);
    if (playing) {
      this.active.add(code);
      this.edges.add(code);
    }
  }
  up(code) { this.held.delete(code); this.active.delete(code); }
  clear() { this.active.clear(); this.edges.clear(); }
  sample(forward) {
    const held = code => Number(this.active.has(code));
    const fw = held('KeyW') - held('KeyS'), side = held('KeyD') - held('KeyA');
    const out = {
      x: forward.x * fw - forward.z * side,
      z: forward.z * fw + forward.x * side,
      q: this.edges.has('KeyQ'),
      shift: this.edges.has('ShiftLeft') || this.edges.has('ShiftRight'),
      jump: this.edges.has('Space'), space: !!held('Space'),
      brake: !!held('ControlLeft'), forward
    };
    this.edges.clear();
    return out;
  }
}

const EPS = 1e-10;
function storeDirection(m, x, z) {
  const length = Math.hypot(x, z);
  m.desiredHorizontalDirection[0] = length ? x / length : 0;
  m.desiredHorizontalDirection[1] = length ? z / length : 0;
}

function setPressedDirection(m, input) {
  if (input.x || input.z) storeDirection(m, input.x, input.z);
  else storeDirection(m, input.forward?.x || 0, input.forward?.z ?? -1);
}

function applyCommands(p, input, time) {
  const m = p.movement;
  if (input.jump && p.grounded) {
    p.grounded = false;
    p.vel.y = MOVEMENT.jump;
  }
  if (input.jump || !input.space) p.spaceHeldSeconds = 0;
  if (input.q && !input.brake &&
      (m.qbLastStartedAtSeconds === null || time + EPS >= m.qbLastStartedAtSeconds + MOVEMENT.cooldown) &&
      spendEN(p, MOVEMENT.qbEn, time)) {
    setPressedDirection(m, input);
    const speed = MOVEMENT.quickboost * p.stats.horizontalSpeedMultiplier;
    p.vel.x = m.desiredHorizontalDirection[0] * speed;
    p.vel.z = m.desiredHorizontalDirection[1] * speed;
    m.qbImpulseRemainingSeconds = MOVEMENT.impulseSeconds;
    m.qbLastStartedAtSeconds = time;
    m.qbSuccessfulCount++;
    m.horizontalMode = 'quickboost';
  }
  if (m.qbImpulseRemainingSeconds > EPS) return;
  if (input.shift) {
    m.glideEnabled = !m.glideEnabled;
    if (m.glideEnabled) setPressedDirection(m, input);
  }
}

function horizontalStep(p, input, dt) {
  const m = p.movement, delta = p.delta, vel = p.vel;
  if (m.qbImpulseRemainingSeconds > EPS) {
    delta.x = vel.x * dt;
    delta.z = vel.z * dt;
    return;
  }
  if (input.brake) {
    m.glideEnabled = false;
    storeDirection(m, 0, 0);
  } else if (input.x || input.z || !m.glideEnabled) {
    storeDirection(m, input.x || 0, input.z || 0);
  }
  const multiplier = p.stats.horizontalSpeedMultiplier;
  const steadySpeed = !p.grounded ? MOVEMENT.air : m.glideEnabled ? MOVEMENT.glide : MOVEMENT.walk;
  const accel = multiplier * (m.glideEnabled
    ? (MOVEMENT.quickboost - steadySpeed) / MOVEMENT.coastSeconds
    : MOVEMENT.acceleration);
  const dx = m.desiredHorizontalDirection[0] * steadySpeed * multiplier - vel.x;
  const dz = m.desiredHorizontalDirection[1] * steadySpeed * multiplier - vel.z;
  const dv = Math.hypot(dx, dz);
  const rampSeconds = Math.min(dt, dv / accel);
  const fraction = dv > 0 ? Math.min(1, accel * rampSeconds / dv) : 0;
  // Integrate the ramp until the target is reached, then the constant speed.
  delta.x = vel.x * dt + dx * fraction * (dt - 0.5 * rampSeconds);
  delta.z = vel.z * dt + dz * fraction * (dt - 0.5 * rampSeconds);
  vel.x += dx * fraction;
  vel.z += dz * fraction;
}

function advance(p, input, dt, time, world, flying) {
  const m = p.movement;
  if (flying) p.grounded = false;
  horizontalStep(p, input, dt);
  const groundedBefore = p.grounded;
  if (flying) {
    spendEN(p, Math.min(p.en, MOVEMENT.enPerFlightSecond * dt), time + dt);
    p.vel.y = MOVEMENT.climb;
    p.delta.y = p.vel.y * dt;
  } else {
    p.delta.y = p.vel.y * dt - 0.5 * MOVEMENT.gravity * dt * dt;
    p.vel.y -= MOVEMENT.gravity * dt;
  }
  p.grounded = world.move(p.pos, p.delta, p.vel, MOVEMENT.radius, MOVEMENT.height);
  if (m.qbImpulseRemainingSeconds > EPS) {
    m.qbImpulseRemainingSeconds = Math.max(0, m.qbImpulseRemainingSeconds - dt);
    if (m.qbImpulseRemainingSeconds <= EPS) {
      m.qbImpulseRemainingSeconds = 0;
      m.glideEnabled = true;
    }
  }
  if (input.space) p.spaceHeldSeconds += dt;
  if (groundedBefore && p.grounded && !flying) {
    const resume = m.lastEnSpentAtSeconds === null ? time : m.lastEnSpentAtSeconds + MOVEMENT.regenDelay;
    const duration = Math.max(0, time + dt - Math.max(time, resume));
    p.en = Math.min(p.stats.maxEn, p.en + p.stats.regenPerSecond * duration);
  }
  m.horizontalMode = m.qbImpulseRemainingSeconds > EPS ? 'quickboost' : m.glideEnabled ? 'glide' : 'walk';
  m.verticalMode = p.grounded ? 'grounded' : flying && p.en > 0 ? 'flying' : p.vel.y > 0 ? 'rising' : 'falling';
}

export function stepMovement(p, input, dt, time, world, beamCallback) {
  const m = p.movement;
  applyCommands(p, input, time);
  beamCallback?.();
  let offset = 0;
  while (offset < dt - EPS) {
    let slice = dt - offset;
    if (m.qbImpulseRemainingSeconds > EPS) slice = Math.min(slice, m.qbImpulseRemainingSeconds);
    const flightWait = MOVEMENT.flightDelay - p.spaceHeldSeconds;
    const flying = input.space && flightWait <= EPS && p.en > 0;
    if (input.space && flightWait > EPS) slice = Math.min(slice, flightWait);
    if (flying) slice = Math.min(slice, p.en / MOVEMENT.enPerFlightSecond);
    advance(p, input, slice, time + offset, world, flying);
    offset += slice;
  }
  m.qbCooldownRemainingSeconds = m.qbLastStartedAtSeconds === null ? 0
    : Math.max(0, MOVEMENT.cooldown - (time + dt - m.qbLastStartedAtSeconds));
}
