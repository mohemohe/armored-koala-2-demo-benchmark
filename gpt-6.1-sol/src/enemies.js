import { solveIntercept } from './ballistics.js';

// The values here are shared by AI and its renderable warning state. All times
// are game times: the caller must not invoke this update while paused.
export const ENEMY_STATS = Object.freeze({
  guard: Object.freeze({ hp: 120, range: 90, damage: 18, speed: 70, initialDelay: 0.50, burstCount: 3, shotInterval: 0.12, burstPeriod: 1.20, telegraph: 0.15, lifetime: 2 }),
  turret: Object.freeze({ hp: 240, range: 120, damage: 40, speed: 60, initialDelay: 0.70, burstCount: 2, shotInterval: 0.25, burstPeriod: 1.60, telegraph: 0.35, lifetime: 3 }),
});

const HALF = [1.1, 2.1, 1.1];
const EPS = 1e-9;
const MEMORY_SECONDS = 8;
const clone = value => structuredClone(value);
const length = v => Math.hypot(v[0], v[1], v[2]);
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const normalize = v => {
  const n = length(v);
  return n > EPS ? v.map(x => x / n) : [0, 0, 1];
};
const horizontal = v => {
  const n = Math.hypot(v[0], v[2]);
  return n > EPS ? [v[0] / n, 0, v[2] / n] : [0, 0, 0];
};
const subtract = (a, b) => a.map((x, i) => x - b[i]);
const lineOfSight = (world, a, b) => !world.lineOfSight || world.lineOfSight(a, b);

export function createEnemies(definitions) {
  return definitions.map((definition, index) => {
    const enemy = clone(definition);
    const kind = enemy.kind === 'turret' ? 'turret' : 'guard';
    return {
      ...enemy,
      id: enemy.id ?? `${kind}-${String(index + 1).padStart(2, '0')}`,
      kind,
      isGateControl: Boolean(enemy.isGateControl),
      position: (enemy.position ?? enemy.pos).slice(),
      previousPosition: (enemy.position ?? enemy.pos).slice(),
      velocity: [0, 0, 0],
      halfExtents: (enemy.halfExtents ?? HALF).slice(),
      hp: ENEMY_STATS[kind].hp,
      alive: true,
      alert: false,
      hasLineOfSight: false,
      warning: false,
      warningProgress: 0,
      shotsFired: 0,
      lastShotAtSeconds: null,
      firstSeenAtSeconds: null,
      lastSeenAtSeconds: null,
      lastSeenPosition: null,
      nextBurstAtSeconds: null,
      sightRegainedAtSeconds: null,
      lostSightAtSeconds: null,
      attackBurst: null,
      facingDirection: [0, 0, 1],
      strafeSign: index % 2 ? -1 : 1,
      blockedSeconds: 0,
      avoidRemainingSeconds: 0,
      grounded: true,
      fallVelocity: 0,
    };
  });
}

export function enemyMuzzle(enemy) {
  const offset = enemy.kind === 'turret' ? 1.8 : 1.25;
  return [
    enemy.position[0] + enemy.facingDirection[0] * offset,
    enemy.position[1] + (enemy.kind === 'turret' ? 0.4 : 0.25),
    enemy.position[2] + enemy.facingDirection[2] * offset,
  ];
}

function observe(enemies, player, world, time) {
  const observers = [];
  for (const enemy of enemies) {
    if (!enemy.alive || enemy.hp <= 0) {
      enemy.alive = false;
      enemy.velocity = [0, 0, 0];
      enemy.alert = enemy.hasLineOfSight = enemy.warning = false;
      enemy.warningProgress = 0;
      continue;
    }
    const stats = ENEMY_STATS[enemy.kind];
    const withinRange = distance(enemy.position, player.position) <= stats.range + EPS;
    const centerVisible = withinRange && lineOfSight(world, enemy.position, player.position);
    if (centerVisible) {
      const facing = horizontal(subtract(player.position, enemy.position));
      if (length(facing) > EPS) enemy.facingDirection = facing;
    }
    const visible = centerVisible && lineOfSight(world, enemyMuzzle(enemy), player.position);
    if (visible) {
      if (!enemy.hasLineOfSight) enemy.sightRegainedAtSeconds = time;
      enemy.lastSeenAtSeconds = time;
      enemy.lastSeenPosition = player.position.slice();
      enemy.lostSightAtSeconds = null;
      if (enemy.firstSeenAtSeconds === null) {
        enemy.firstSeenAtSeconds = time;
        enemy.nextBurstAtSeconds = time + stats.initialDelay;
      }
      if (enemy.kind === 'guard') observers.push(enemy);
    } else {
      if (enemy.hasLineOfSight) enemy.lostSightAtSeconds = time;
      enemy.sightRegainedAtSeconds = null;
    }
    enemy.hasLineOfSight = visible;
    enemy.alert = enemy.lastSeenAtSeconds !== null && time - enemy.lastSeenAtSeconds <= MEMORY_SECONDS + EPS;
  }
  // Only a guard which sees the player can publish a position. Recipients do
  // not relay that message, so one observation cannot flood the entire stage.
  for (const source of observers) {
    for (const recipient of enemies) {
      if (source === recipient || recipient.kind !== 'guard' || !recipient.alive || recipient.hasLineOfSight) continue;
      if (distance(source.position, recipient.position) > 60 + EPS) continue;
      let pathLength;
      if (world.pathDistance) pathLength = world.pathDistance(source.position, recipient.position);
      else {
        const connected = source.sectorId === recipient.sectorId || (world.areSectorsConnected?.(source.sectorId, recipient.sectorId) ?? false);
        pathLength = connected && lineOfSight(world, source.position, recipient.position) ? distance(source.position, recipient.position) : Infinity;
      }
      if (pathLength > 60 + EPS) continue;
      recipient.lastSeenPosition = source.lastSeenPosition.slice();
      recipient.lastSeenAtSeconds = time;
      recipient.alert = true;
    }
  }
}

function burstStart(enemy) {
  if (!enemy.hasLineOfSight || enemy.nextBurstAtSeconds === null) return Infinity;
  return Math.max(enemy.nextBurstAtSeconds, enemy.sightRegainedAtSeconds + ENEMY_STATS[enemy.kind].telegraph);
}

function emitShot(enemy, player, world, time, spawnProjectile) {
  const stats = ENEMY_STATS[enemy.kind];
  const muzzle = enemyMuzzle(enemy);
  // A shot is a separate LOS decision. A wall entered after the first burst
  // round blocks its remaining rounds without resetting the weapon timer.
  if (!enemy.hasLineOfSight || !lineOfSight(world, muzzle, player.position)) return;
  const targetVelocity = (player.velocity ?? [0, 0, 0]).slice();
  const intercept = solveIntercept(muzzle, player.position, targetVelocity, stats.speed, stats.lifetime);
  const flight = Math.min(intercept?.flightSeconds ?? 0, 1.2);
  const predicted = player.position.map((x, i) => x + targetVelocity[i] * flight);
  const direction = normalize(subtract(predicted, muzzle));
  const velocity = direction.map(x => x * stats.speed);
  spawnProjectile({
    owner: 'enemy', enemyId: enemy.id, weapon: enemy.kind,
    position: muzzle.slice(), muzzle: muzzle.slice(), origin: muzzle.slice(), previousPosition: muzzle.slice(),
    direction: direction.slice(), velocity: velocity.slice(), initialVelocity: velocity.slice(), acceleration: [0, 0, 0],
    speed: stats.speed, damage: stats.damage, lifetime: stats.lifetime, maxAge: stats.lifetime, age: 0,
    firedAtSeconds: time,
  });
  enemy.shotsFired += 1;
  enemy.lastShotAtSeconds = time;
}

function attack(enemies, player, world, time, spawnProjectile) {
  for (const enemy of enemies) {
    if (!enemy.alive) continue;
    const stats = ENEMY_STATS[enemy.kind];
    if (!enemy.attackBurst && burstStart(enemy) <= time + EPS) {
      const start = burstStart(enemy);
      enemy.attackBurst = { startAtSeconds: start, nextShot: 0 };
    }
    if (enemy.attackBurst) {
      const burst = enemy.attackBurst;
      while (burst.nextShot < stats.burstCount) {
        const fireAt = burst.startAtSeconds + burst.nextShot * stats.shotInterval;
        if (fireAt > time + EPS) break;
        emitShot(enemy, player, world, fireAt, spawnProjectile);
        burst.nextShot += 1;
      }
      if (burst.nextShot === stats.burstCount) {
        enemy.nextBurstAtSeconds = burst.startAtSeconds + stats.burstPeriod;
        enemy.attackBurst = null;
      }
    }
    const start = burstStart(enemy);
    const warningStart = Math.max(enemy.sightRegainedAtSeconds ?? Infinity, start - stats.telegraph);
    enemy.warning = !enemy.attackBurst && enemy.hasLineOfSight && time + EPS >= warningStart && time < start - EPS;
    enemy.warningProgress = enemy.warning ? Math.max(0, Math.min(1, (time - warningStart) / stats.telegraph)) : 0;
  }
}

function nextAttackEvent(enemies, time) {
  let result = Infinity;
  for (const enemy of enemies) {
    if (!enemy.alive) continue;
    const stats = ENEMY_STATS[enemy.kind];
    const next = enemy.attackBurst
      ? enemy.attackBurst.startAtSeconds + enemy.attackBurst.nextShot * stats.shotInterval
      : burstStart(enemy);
    if (next > time + EPS) result = Math.min(result, next);
    const warning = next - stats.telegraph;
    if (!enemy.attackBurst && warning > time + EPS) result = Math.min(result, warning);
  }
  return result;
}

function desiredVelocity(enemy, world) {
  if (enemy.kind === 'turret' || !enemy.alert || !enemy.lastSeenPosition) return [0, 0, 0];
  const target = enemy.lastSeenPosition;
  const delta = subtract(target, enemy.position);
  const dist = length(delta);
  const flatToward = horizontal(delta);
  const toward = length(flatToward) > EPS ? flatToward : enemy.facingDirection.slice();
  const side = [-toward[2] * enemy.strafeSign, 0, toward[0] * enemy.strafeSign];
  let destination;
  let speed;
  if (enemy.avoidRemainingSeconds > EPS) {
    destination = enemy.position.map((x, i) => x + side[i] * 14 + toward[i] * 3);
    speed = dist >= 25 && dist <= 55 && enemy.hasLineOfSight ? 6 : 8;
  } else if (!enemy.hasLineOfSight) {
    speed = 8;
    destination = dist > 3 ? target : enemy.position.map((x, i) => x + side[i] * 14);
  } else if (dist > 55) {
    destination = target;
    speed = 8;
  } else if (dist >= 25) {
    destination = enemy.position.map((x, i) => x + side[i] * 14);
    speed = 6;
  } else if (dist < 15) {
    destination = enemy.position.map((x, i) => x - toward[i] * 14);
    speed = 8;
  } else if (dist < 19) {
    destination = enemy.position.map((x, i) => x - toward[i] * 8);
    speed = 4;
  } else if (dist > 23) {
    destination = target;
    speed = 4;
  } else {
    destination = enemy.position.map((x, i) => x + side[i] * 10);
    speed = 4;
  }
  let direction = world.navDirection ? world.navDirection(enemy.position, destination, enemy.sectorId) : horizontal(subtract(destination, enemy.position));
  direction = horizontal(direction);
  if (length(direction) < EPS && world.navDirection) {
    const alternate = enemy.position.map((x, i) => x - side[i] * 14);
    direction = horizontal(world.navDirection(enemy.position, alternate, enemy.sectorId));
  }
  return direction.map(x => x * speed);
}

function segmentBox(from, to, center, half) {
  let first = 0;
  let last = 1;
  let axis = -1;
  let sign = 0;
  for (let i = 0; i < 3; i++) {
    const change = to[i] - from[i];
    const lo = center[i] - half[i];
    const hi = center[i] + half[i];
    if (Math.abs(change) < EPS) {
      if (from[i] <= lo || from[i] >= hi) return null;
      continue;
    }
    let a = (lo - from[i]) / change;
    let b = (hi - from[i]) / change;
    const normal = change > 0 ? -1 : 1;
    if (a > b) [a, b] = [b, a];
    if (a > first) { first = a; axis = i; sign = normal; }
    last = Math.min(last, b);
    if (first > last) return null;
  }
  return axis >= 0 && first >= 0 && first <= 1 ? { fraction: first, axis, sign } : null;
}

function move(enemies, world, dt) {
  for (const enemy of enemies) {
    if (!enemy.alive) continue;
    const from = enemy.position.slice();
    let wanted = desiredVelocity(enemy, world);
    const falling = enemy.kind === 'guard' && !enemy.grounded;
    if (falling) wanted[1] = enemy.fallVelocity - 9 * dt;
    let body = world.moveBody
      ? world.moveBody(from, wanted, dt, enemy.halfExtents)
      : { position: from.map((x, i) => x + wanted[i] * dt), velocity: wanted, grounded: true };
    let position = (body.position ?? body).slice();
    // Enemies use swept body collision as well as the stage collision. They
    // cannot walk through allies; the side choice changes if movement stalls.
    let sweepStart = from.slice();
    for (let slide = 0; slide < 3; slide++) {
      let nearest = null;
      for (const other of enemies) {
        if (other === enemy || !other.alive) continue;
        const half = enemy.halfExtents.map((x, i) => x + other.halfExtents[i]);
        const collision = segmentBox(sweepStart, position, other.position, half);
        if (collision && (!nearest || collision.fraction < nearest.fraction)) nearest = collision;
      }
      if (!nearest) break;
      const fraction = Math.max(0, nearest.fraction - 1e-5);
      const contact = sweepStart.map((x, i) => x + (position[i] - x) * fraction);
      const remaining = position.map((x, i) => x - contact[i]);
      remaining[nearest.axis] = 0;
      const slidingBody = world.moveBody
        ? world.moveBody(contact, remaining, 1, enemy.halfExtents)
        : { position: contact.map((x, i) => x + remaining[i]) };
      position = (slidingBody.position ?? slidingBody).slice();
      sweepStart = contact;
      enemy.avoidRemainingSeconds = 0.75;
    }
    enemy.position = position;
    enemy.grounded = body.grounded ?? true;
    enemy.fallVelocity = enemy.kind === 'guard' && !enemy.grounded
      ? (falling ? enemy.fallVelocity - 18 * dt : 0)
      : 0;
    const moved = distance(from, position);
    enemy.blockedSeconds = length(wanted) > EPS && moved < length(wanted) * dt * 0.25 ? enemy.blockedSeconds + dt : 0;
    if (enemy.blockedSeconds >= 0.15) {
      enemy.strafeSign *= -1;
      enemy.blockedSeconds = 0;
      enemy.avoidRemainingSeconds = 0.75;
    }
    enemy.avoidRemainingSeconds = Math.max(0, enemy.avoidRemainingSeconds - dt);
    const sector = world.sectorAt?.(position);
    if (sector) enemy.sectorId = typeof sector === 'string' ? sector : sector.id;
  }
}

/**
 * Advance [time, time + dt]. If the player has previousPosition, those two
 * positions are the same interval's physical endpoints. Projectiles are
 * emitted at exact event times and must be advanced only from their fire time.
 */
export function updateEnemies(enemies, player, world, dt, time, spawnProjectile) {
  if (dt < 0 || !Number.isFinite(dt) || !Number.isFinite(time)) throw new RangeError('Invalid enemy update interval');
  const starts = enemies.map(enemy => enemy.position.slice());
  for (let i = 0; i < enemies.length; i++) enemies[i].previousPosition = starts[i].slice();
  const end = time + dt;
  const playerAt = at => {
    if (!player.previousPosition || dt <= EPS) return player;
    const fraction = Math.max(0, Math.min(1, (at - time) / dt));
    return {
      ...player,
      position: player.position.map((x, i) => player.previousPosition[i] + (x - player.previousPosition[i]) * fraction),
      velocity: player.previousVelocity
        ? player.velocity.map((x, i) => player.previousVelocity[i] + (x - player.previousVelocity[i]) * fraction)
        : player.velocity,
    };
  };
  let now = time;
  observe(enemies, playerAt(now), world, now);
  attack(enemies, playerAt(now), world, now, spawnProjectile);
  while (now < end - EPS) {
    const next = Math.min(end, now + 1 / 120, nextAttackEvent(enemies, now));
    move(enemies, world, next - now);
    now = next;
    observe(enemies, playerAt(now), world, now);
    attack(enemies, playerAt(now), world, now, spawnProjectile);
  }
  for (let i = 0; i < enemies.length; i++) {
    const enemy = enemies[i];
    enemy.velocity = dt > EPS && enemy.alive ? enemy.position.map((x, j) => (x - starts[i][j]) / dt) : [0, 0, 0];
  }
}
