import { Vector3 } from 'three';
import { ENEMY_STATS } from './config.js';
import { solveIntercept } from './ballistics.js';

const UP_TO_PLAYER_CENTER = new Vector3(0, 2.2, 0);
const EPSILON = 1e-8;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function strafeSign(id) {
  let hash = 0;
  for (const character of String(id)) hash = ((hash * 31) + character.charCodeAt(0)) | 0;
  return (hash & 1) ? 1 : -1;
}

export function createEnemies(world) {
  return world.enemySpawns.map((spawn) => {
    const stats = ENEMY_STATS[spawn.kind];
    const position = spawn.position.isVector3 ? spawn.position.clone() : new Vector3(...spawn.position);
    return {
      id: spawn.id,
      kind: spawn.kind,
      isGateControl: Boolean(spawn.isGateControl),
      sectorId: spawn.sectorId,
      barrierId: spawn.barrierId ?? null,
      position,
      previousPosition: position.clone(),
      velocity: new Vector3(),
      radius: stats.radius,
      height: 4,
      hp: stats.hp,
      alive: true,
      alert: false,
      hasLineOfSight: false,
      shotsFired: 0,
      lastShotAtSeconds: null,
      telegraph: 0,
      yaw: 0,
      lastSeenPosition: null,
      lastSeenVelocity: new Vector3(),
      lastSeenAtSeconds: null,
      nextBurstAtSeconds: null,
      burstStartedAtSeconds: null,
      burstShotIndex: 0,
      _wasVisible: false,
      _sightAtStepStart: false,
      _telegraphInterrupted: false,
      _nextShareAtSeconds: 0,
      _strafeSign: strafeSign(spawn.id),
      _stuckSeconds: 0,
      _grounded: true,
    };
  });
}

function targetAt(player, alpha) {
  return (player.previousPosition ?? player.position).clone().lerp(player.position, alpha).add(UP_TO_PLAYER_CENTER);
}

function muzzleAt(enemy, position, target) {
  const horizontal = target.clone().sub(position).setY(0);
  if (horizontal.lengthSq() > 1e-12) horizontal.normalize();
  else horizontal.set(Math.sin(enemy.yaw), 0, Math.cos(enemy.yaw));
  return position.clone().addScaledVector(horizontal, enemy.kind === 'guard' ? 1.8 : 2.1).add(new Vector3(0, .45, 0));
}

function visible(world, enemy, position, target) {
  if (position.distanceToSquared(target) > ENEMY_STATS[enemy.kind].range ** 2) return false;
  const muzzle = muzzleAt(enemy, position, target);
  // A long barrel must not make a guard see/fire through a thin wall when its
  // collision body is standing immediately behind that wall.
  return world.lineOfSight(position, muzzle) && world.lineOfSight(muzzle, target);
}

function remember(enemy, target, velocity, time) {
  if (!enemy.lastSeenPosition) enemy.lastSeenPosition = new Vector3();
  enemy.lastSeenPosition.copy(target);
  enemy.lastSeenVelocity.copy(velocity);
  enemy.lastSeenAtSeconds = time;
  enemy.alert = true;
}

function observe(enemy, player, target, time, world) {
  const stats = ENEMY_STATS[enemy.kind];
  const hasSight = visible(world, enemy, enemy.position, target);
  enemy._sightAtStepStart = hasSight;
  if (hasSight) {
    remember(enemy, target, player.velocity, time);
    if (enemy.nextBurstAtSeconds === null) {
      // The first-shot delay already includes the muzzle charge period.
      enemy.nextBurstAtSeconds = time + stats.initialDelay;
    } else if ((!enemy._wasVisible || enemy._telegraphInterrupted) && enemy.burstStartedAtSeconds === null) {
      // Keep the original weapon availability; brief cover never restarts the
      // initial delay. A charge that was hidden is shown again before firing.
      enemy.nextBurstAtSeconds = Math.max(enemy.nextBurstAtSeconds, time + stats.telegraph);
    }
    enemy._telegraphInterrupted = false;
  } else {
    enemy.alert = enemy.lastSeenAtSeconds !== null && time - enemy.lastSeenAtSeconds <= stats.memorySeconds;
  }
  enemy._wasVisible = hasSight;
}

function connectedWithin(world, from, to, distance) {
  if (from.distanceToSquared(to) > distance * distance) return false;
  if (world.isConnectedWithin) return world.isConnectedWithin(from, to, distance);
  if (world.pathDistance) return world.pathDistance(from, to, distance) <= distance;
  // Simple open-world test fixtures need no navigation graph. Real stages
  // provide path distance, so alerts never jump a closed partition or floor.
  return world.lineOfSight(from, to);
}

function shareAlerts(enemies, world, time) {
  for (const source of enemies) {
    if (!source.alive || source.kind !== 'guard' || !source._sightAtStepStart || time < source._nextShareAtSeconds) continue;
    source._nextShareAtSeconds = time + .25;
    for (const friend of enemies) {
      if (friend === source || !friend.alive || friend._sightAtStepStart) continue;
      if (!connectedWithin(world, source.position, friend.position, ENEMY_STATS.guard.alertShareRange)) continue;
      remember(friend, source.lastSeenPosition, source.lastSeenVelocity, source.lastSeenAtSeconds);
    }
  }
}

function navigate(world, from, target, radius) {
  const direction = world.navigationDirection
    ? world.navigationDirection(from, target, radius).clone()
    : target.clone().sub(from);
  direction.y = 0;
  return direction.lengthSq() > 1e-10 ? direction.normalize() : direction.set(0, 0, 0);
}

function moveGuard(enemy, enemies, world, dt) {
  if (!enemy.alert || !enemy.lastSeenPosition) {
    enemy.velocity.set(0, 0, 0);
    return;
  }
  const stats = ENEMY_STATS.guard;
  const toward = enemy.lastSeenPosition.clone().sub(enemy.position).setY(0);
  const distance = toward.length();
  const forward = distance > .001 ? toward.clone().divideScalar(distance) : new Vector3(Math.sin(enemy.yaw), 0, Math.cos(enemy.yaw));
  const sideways = new Vector3(forward.z, 0, -forward.x).multiplyScalar(enemy._strafeSign);
  let destination = enemy.lastSeenPosition.clone();
  let speed = stats.movementSpeed;
  if (!enemy._sightAtStepStart) {
    // Only the recorded position is used here, never the concealed player.
    if (distance < 2) destination.copy(enemy.position).addScaledVector(sideways, 8).addScaledVector(forward, 4);
  } else if (distance > 55) {
    speed = stats.movementSpeed;
  } else if (distance >= 25) {
    speed = stats.strafeSpeed;
    destination.copy(enemy.position).addScaledVector(sideways, 12);
  } else if (distance < 15) {
    destination.copy(enemy.position).addScaledVector(forward, -12);
  } else if (distance < 18) {
    speed = 4;
    destination.copy(enemy.position).addScaledVector(forward, -8);
  } else {
    speed = stats.strafeSpeed;
    destination.copy(enemy.position).addScaledVector(sideways, 10);
  }

  let direction = navigate(world, enemy.position, destination, enemy.radius);
  const separation = new Vector3();
  for (const other of enemies) {
    if (!other.alive || other === enemy || Math.abs(other.position.y - enemy.position.y) > 3) continue;
    const away = enemy.position.clone().sub(other.position).setY(0);
    const gap = away.length();
    const desired = enemy.radius + other.radius + .65;
    if (gap >= desired) continue;
    if (gap < .01) away.copy(sideways);
    else away.divideScalar(gap);
    separation.addScaledVector(away, (desired - gap) / desired * 2.5);
  }
  if (separation.lengthSq() > .001) {
    const separated = direction.clone().add(separation).normalize();
    direction = navigate(world, enemy.position, enemy.position.clone().addScaledVector(separated, 5), enemy.radius);
  }

  if (enemy._stuckSeconds > .35 && world.raycast) {
    // Try a clear lateral route while the navigator replans. This also avoids
    // two opposing guards indefinitely pinning each other in a passage.
    const recovery = new Vector3(direction.z, 0, -direction.x).multiplyScalar(enemy._strafeSign);
    for (const sign of [1, -1]) {
      const candidate = recovery.clone().multiplyScalar(sign).addScaledVector(direction, .3).normalize();
      if (!world.raycast(enemy.position, enemy.position.clone().addScaledVector(candidate, 4), enemy.radius)) {
        direction.copy(candidate);
        break;
      }
    }
  }

  const start = enemy.position.clone();
  const feet = start.clone().add(new Vector3(0, -enemy.height / 2, 0));
  const requestedVelocity = direction.multiplyScalar(speed);
  requestedVelocity.y = enemy._grounded ? -.1 : enemy.velocity.y - 18 * dt;
  if (world.moveBody) {
    const result = world.moveBody(feet, requestedVelocity, dt, enemy.radius, enemy.height);
    enemy._grounded = Boolean(result.grounded);
    enemy.position.copy(feet).add(new Vector3(0, enemy.height / 2, 0));
  } else {
    requestedVelocity.y = 0;
    enemy.position.addScaledVector(requestedVelocity, dt);
  }
  // Report the actual collision-center velocity, including wall sliding.
  enemy.velocity.copy(enemy.position).sub(start).divideScalar(dt);
  const horizontalTravel = Math.hypot(enemy.position.x - start.x, enemy.position.z - start.z);
  enemy._stuckSeconds = horizontalTravel < speed * dt * .18 ? enemy._stuckSeconds + dt : 0;
  if (enemy._stuckSeconds > 1.25) {
    enemy._strafeSign *= -1;
    enemy._stuckSeconds = 0;
  }
}

function fireEnemy(enemy, player, time, start, dt, world, spawnProjectile, addEffect) {
  const stats = ENEMY_STATS[enemy.kind];
  const alpha = clamp((time - start) / dt, 0, 1);
  const position = enemy.previousPosition.clone().lerp(enemy.position, alpha);
  const target = targetAt(player, alpha);
  // Every round performs its own muzzle-to-target test, including rounds in
  // a burst already underway. No projectile is created through cover.
  if (!visible(world, enemy, position, target)) return false;
  const muzzle = muzzleAt(enemy, position, target);
  const solution = solveIntercept(muzzle, target, player.velocity, stats.speed, stats.maxLeadSeconds);
  let direction;
  if (solution) direction = solution.direction;
  else {
    let leadTime = Math.min(stats.maxLeadSeconds, muzzle.distanceTo(target) / stats.speed);
    for (let iteration = 0; iteration < 4; iteration++) {
      leadTime = Math.min(stats.maxLeadSeconds, muzzle.distanceTo(target.clone().addScaledVector(player.velocity, leadTime)) / stats.speed);
    }
    direction = target.clone().addScaledVector(player.velocity, leadTime).sub(muzzle).normalize();
  }
  spawnProjectile({
    kind: 'enemy', owner: enemy.id, enemyKind: enemy.kind,
    position: muzzle, velocity: direction.clone().multiplyScalar(stats.speed),
    damage: stats.damage, lifetime: stats.lifetime, firedAtSeconds: time,
  });
  enemy.shotsFired++;
  enemy.lastShotAtSeconds = time;
  enemy.yaw = Math.atan2(direction.x, direction.z);
  addEffect?.({ type: 'enemyMuzzle', position: muzzle.clone(), lifetime: .10, enemyKind: enemy.kind, firedAtSeconds: time });
  return true;
}

function updateWeapon(enemy, player, time, dt, world, spawnProjectile, addEffect) {
  const end = time + dt;
  const stats = ENEMY_STATS[enemy.kind];
  if (enemy.nextBurstAtSeconds === null) return;
  // Each enemy owns its schedule. All events in this interval are processed
  // at their scheduled timestamps, independent of rendering or other enemies.
  while (true) {
    if (enemy.burstStartedAtSeconds === null) {
      if (!enemy._sightAtStepStart || enemy.nextBurstAtSeconds > end + EPSILON) break;
      const burstTime = Math.max(time, enemy.nextBurstAtSeconds);
      const alpha = clamp((burstTime - time) / dt, 0, 1);
      const enemyPosition = enemy.previousPosition.clone().lerp(enemy.position, alpha);
      if (!visible(world, enemy, enemyPosition, targetAt(player, alpha))) {
        enemy._telegraphInterrupted = true;
        break;
      }
      enemy.burstStartedAtSeconds = burstTime;
      enemy.burstShotIndex = 0;
      enemy.nextBurstAtSeconds = burstTime + stats.burstPeriod;
    }
    const shotTime = enemy.burstStartedAtSeconds + enemy.burstShotIndex * stats.burstInterval;
    if (shotTime > end + EPSILON) break;
    fireEnemy(enemy, player, Math.max(time, shotTime), time, dt, world, spawnProjectile, addEffect);
    enemy.burstShotIndex++;
    if (enemy.burstShotIndex >= stats.burstShots) {
      enemy.burstStartedAtSeconds = null;
      enemy.burstShotIndex = 0;
    }
  }
  const chargeStarts = enemy.nextBurstAtSeconds - stats.telegraph;
  enemy.telegraph = enemy.hasLineOfSight && end >= chargeStarts && end <= enemy.nextBurstAtSeconds + EPSILON
    ? clamp((end - chargeStarts) / stats.telegraph, .05, 1)
    : enemy.hasLineOfSight && enemy.burstStartedAtSeconds !== null ? .35 : 0;
}

/** Advance independent enemy AI and firing over [time, time + dt]. */
export function updateEnemiesAI(enemies, player, time, dt, world, spawnProjectile, addEffect) {
  if (dt <= 0) return;
  const targetStart = targetAt(player, 0);
  for (const enemy of enemies) {
    enemy.previousPosition.copy(enemy.position);
    if (!enemy.alive) {
      enemy.velocity.set(0, 0, 0);
      enemy.alert = false;
      enemy.hasLineOfSight = false;
      enemy.telegraph = 0;
      continue;
    }
    observe(enemy, player, targetStart, time, world);
  }
  shareAlerts(enemies, world, time);
  for (const enemy of enemies) {
    if (!enemy.alive) continue;
    if (enemy.kind === 'guard') moveGuard(enemy, enemies, world, dt);
    else enemy.velocity.set(0, 0, 0);
    const targetEnd = targetAt(player, 1);
    enemy.hasLineOfSight = visible(world, enemy, enemy.position, targetEnd);
    if (enemy.hasLineOfSight) remember(enemy, targetEnd, player.velocity, time + dt);
    enemy.alert = enemy.lastSeenAtSeconds !== null && time + dt - enemy.lastSeenAtSeconds <= ENEMY_STATS[enemy.kind].memorySeconds;
    if (enemy.alert && enemy.lastSeenPosition) {
      const facing = enemy.lastSeenPosition.clone().sub(enemy.position);
      enemy.yaw = Math.atan2(facing.x, facing.z);
    }
    updateWeapon(enemy, player, time, dt, world, spawnProjectile, addEffect);
    const sector = world.sectorAt?.(enemy.position);
    if (sector) enemy.sectorId = sector.id;
  }
}
