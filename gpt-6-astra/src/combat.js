import { Vector3 } from 'three';
import { FCS, WEAPONS, effectiveStats } from './config.js';
import { spendEn } from './movement.js';
import { solveIntercept, movingSphereIntersection, turnDirection } from './ballistics.js';
import { createEnemies, updateEnemiesAI } from './enemy-ai.js';

const GRAVITY = new Vector3(0, -WEAPONS.machinegun.gravity, 0);
const ZERO = new Vector3();
const EPS = 1e-8;
const STEP = 1 / 120;

export function getMuzzle(player, yaw = player.yaw || 0) {
  return player.position.clone().add(new Vector3(Math.cos(yaw) * 1.35 + Math.sin(yaw) * 1.4, 3.1, -Math.sin(yaw) * 1.35 + Math.cos(yaw) * 1.4));
}
const inactiveControl = (weapon) => ({ status: 'inactive', weapon, targetId: null, evaluatedAtSeconds: null, muzzlePosition: null, targetPosition: null, targetVelocity: null, launchDirection: null, predictedFlightSeconds: null, predictedInterceptPosition: null, aimPoint: null, residualMeters: null });
const copyJSON = (value) => {
  if (value?.isVector3) return value.toArray();
  if (Array.isArray(value)) return value.map(copyJSON);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, copyJSON(v)]));
  return value;
};
const directionTo = (origin, point, fallback = new Vector3(0, 0, 1)) => {
  const direction = point.clone().sub(origin);
  return direction.lengthSq() < 1e-16 ? fallback.clone().normalize() : direction.normalize();
};

export function createCombat(world, loadout) {
  const stats = effectiveStats(loadout);
  let projectileSequence = 0, effectSequence = 0, shotSequence = 0;
  let lastTime = 0, cameraState = null, lockStartedAt = null;
  let nextFire = { machinegun: 0, beam: 0, missile: 0 };
  const combat = {
    enemies: createEnemies(world), projectiles: [], effects: [],
    lock: { state: 'none', targetId: null, progress: 0, radiusCssPx: 0 },
    fireControl: inactiveControl('machinegun'), recentPlayerShots: [],
    lastFeedback: '', feedbackUntil: 0, damageEvents: [],
  };
  const lineOfSight = (a, b) => world.lineOfSight ? world.lineOfSight(a, b) : !world.raycast(a, b);
  function addEffect(effect) {
    combat.effects.push({ id: ++effectSequence, age: 0, lifetime: .2, spawnedAtSeconds: effect.firedAtSeconds ?? lastTime, ...effect, position: effect.position.clone(), end: effect.end?.clone() });
  }
  function spawnProjectile(data) {
    const gravity = data.kind === 'machinegun' ? GRAVITY.clone() : ZERO.clone();
    const projectile = {
      id: ++projectileSequence, radius: 0, ...data,
      position: data.position.clone(), previousPosition: data.position.clone(), origin: data.position.clone(),
      velocity: data.velocity.clone(), initialVelocity: data.velocity.clone(), gravity,
      age: 0, lastUpdatedAtSeconds: data.firedAtSeconds, alive: true,
    };
    combat.projectiles.push(projectile);
    return projectile;
  }
  function resetLock() {
    combat.lock.state = 'none'; combat.lock.targetId = null; combat.lock.progress = 0;
    lockStartedAt = null;
  }
  function candidateDistance(enemy, player, camera, width, height) {
    if (!enemy?.alive) return null;
    const muzzle = getMuzzle(player);
    if (muzzle.distanceToSquared(enemy.position) > WEAPONS.machinegun.range ** 2 + 1e-6) return null;
    const cameraPosition = camera.getWorldPosition(new Vector3());
    const ahead = enemy.position.clone().sub(cameraPosition).dot(camera.getWorldDirection(new Vector3()));
    if (ahead <= 0) return null;
    const screen = enemy.position.clone().project(camera);
    if (screen.z < -1 || screen.z > 1 || Math.abs(screen.x) > 1 || Math.abs(screen.y) > 1) return null;
    const distance = Math.hypot(screen.x * width * .5, screen.y * height * .5);
    if (distance > combat.lock.radiusCssPx + EPS) return null;
    if (!lineOfSight(cameraPosition, enemy.position) || !lineOfSight(muzzle, enemy.position)) return null;
    return distance;
  }
  function validateLock(player, camera) {
    if (!cameraState || !combat.lock.targetId) return null;
    camera.updateMatrixWorld();
    const enemy = combat.enemies.find((item) => item.id === combat.lock.targetId);
    if (candidateDistance(enemy, player, camera, cameraState.width, cameraState.height) === null) {
      resetLock(); return null;
    }
    return enemy;
  }
  function evaluateControl(player, time, target) {
    const weapon = player.weapon;
    if (!target || combat.lock.state !== 'locked') { combat.fireControl = inactiveControl(weapon); return combat.fireControl; }
    const muzzle = getMuzzle(player), targetPosition = target.position.clone(), targetVelocity = target.velocity.clone();
    let solution;
    if (weapon === 'beam') {
      solution = { time: 0, direction: directionTo(muzzle, targetPosition), intercept: targetPosition.clone(), aimPoint: targetPosition.clone(), residual: 0 };
    } else {
      const weaponStats = WEAPONS[weapon];
      solution = solveIntercept(muzzle, targetPosition, targetVelocity, weaponStats.speed, weaponStats.lifetime, weapon === 'machinegun' ? GRAVITY : ZERO);
    }
    combat.fireControl = {
      status: solution ? 'solved' : 'no_solution', weapon, targetId: target.id, evaluatedAtSeconds: time,
      muzzlePosition: muzzle, targetPosition, targetVelocity,
      launchDirection: solution?.direction || directionTo(muzzle, targetPosition),
      predictedFlightSeconds: solution?.time ?? null,
      predictedInterceptPosition: solution?.intercept ?? null,
      aimPoint: solution?.aimPoint || targetPosition.clone(), residualMeters: solution?.residual ?? null,
    };
    return combat.fireControl;
  }
  combat.updateLock = (player, camera, width, height, time, dt) => {
    lastTime = time;
    camera.updateMatrixWorld();
    cameraState = { camera, width, height };
    combat.lock.radiusCssPx = FCS[loadout.fcs].radius * Math.min(width, height);
    let target = validateLock(player, camera);
    if (!target) {
      const candidates = combat.enemies.map((enemy) => ({ enemy, distance: candidateDistance(enemy, player, camera, width, height) })).filter((item) => item.distance !== null);
      candidates.sort((a, b) => a.distance - b.distance || a.enemy.id.localeCompare(b.enemy.id));
      target = candidates[0]?.enemy;
      if (target) {
        combat.lock.targetId = target.id; combat.lock.state = 'acquiring'; combat.lock.progress = 0; lockStartedAt = time;
      }
    }
    if (target) {
      combat.lock.progress = Math.min(1, Math.max(0, (time - lockStartedAt) / stats.lockSeconds));
      if (combat.lock.progress >= 1 - EPS) { combat.lock.progress = 1; combat.lock.state = 'locked'; }
    }
    evaluateControl(player, time, target);
  };
  function freeAim(player, camera) {
    const cameraOrigin = camera.getWorldPosition(new Vector3()), cameraDirection = camera.getWorldDirection(new Vector3());
    const end = cameraOrigin.clone().addScaledVector(cameraDirection, 200);
    let point = end, bestT = 1;
    const obstacle = world.raycast(cameraOrigin, end);
    if (obstacle) { point = obstacle.point; bestT = obstacle.t; }
    for (const enemy of combat.enemies) {
      if (!enemy.alive) continue;
      const t = movingSphereIntersection(cameraOrigin, end, enemy.position, enemy.position, enemy.radius);
      if (t !== null && t < bestT) { bestT = t; point = cameraOrigin.clone().lerp(end, t); }
    }
    return directionTo(getMuzzle(player), point, cameraDirection);
  }
  function damageEnemy(enemy, damage, position, time, sourceId) {
    enemy.hp = Math.max(0, enemy.hp - damage);
    combat.damageEvents.push({ targetId: enemy.id, damage, time, sourceId });
    if (combat.damageEvents.length > 64) combat.damageEvents.shift();
    if (enemy.hp === 0) { enemy.alive = false; enemy.velocity.set(0, 0, 0); enemy.telegraph = 0;
      if (combat.lock.targetId === enemy.id) { resetLock(); combat.fireControl = inactiveControl(combat.fireControl.weapon); }
      addEffect({ type: 'explosion', position, lifetime: .7 }); }
    else addEffect({ type: 'impact', position, lifetime: .2 });
  }
  function beamHit(muzzle, direction, damage, time, shotId) {
    const end = muzzle.clone().addScaledVector(direction, WEAPONS.beam.range), wall = world.raycast(muzzle, end);
    let firstT = wall?.t ?? 1, victim = null;
    for (const enemy of combat.enemies) {
      if (!enemy.alive) continue;
      const t = movingSphereIntersection(muzzle, end, enemy.position, enemy.position, enemy.radius);
      if (t !== null && t < firstT) { firstT = t; victim = enemy; }
    }
    const impact = muzzle.clone().lerp(end, firstT);
    addEffect({ type: 'beam', position: muzzle, end: impact, lifetime: .12 });
    if (victim) damageEnemy(victim, damage, impact, time, shotId);
    else if (wall) addEffect({ type: 'impact', position: impact, lifetime: .16 });
  }
  function refuse(message, time) { combat.lastFeedback = message; combat.feedbackUntil = time + 1; return false; }
  combat.fire = (player, camera, time, inputFire) => {
    lastTime = time;
    const target = validateLock(player, camera);
    const control = evaluateControl(player, time, target);
    if (!inputFire || player.hp <= 0) return false;
    const weapon = player.weapon, weaponStats = WEAPONS[weapon];
    if (time < nextFire[weapon] - EPS) return false;
    if (weapon === 'missile' && (!target || combat.lock.state !== 'locked')) return refuse('LOCK REQUIRED · ロック完了が必要です', time);
    if (weapon !== 'beam' && player.ammo[weapon] <= 0) return refuse('AMMO EMPTY · 弾切れ', time);
    if (weapon === 'beam' && !spendEn(player, weaponStats.cost, time)) return refuse('EN LOW · ビームには8 ENが必要です', time);
    if (weapon !== 'beam') player.ammo[weapon]--;
    nextFire[weapon] = time + weaponStats.interval;
    const muzzle = getMuzzle(player), direction = control.status === 'inactive' ? freeAim(player, camera) : control.launchDirection.clone();
    const initialVelocity = weapon === 'beam' ? null : direction.clone().multiplyScalar(weaponStats.speed);
    const shot = {
      id: ++shotSequence, firedAtSeconds: time, weapon, targetId: control.targetId, solutionStatus: control.status,
      muzzlePosition: muzzle.clone(), targetPositionAtFire: control.targetPosition?.clone() || null, targetVelocityAtFire: control.targetVelocity?.clone() || null,
      launchDirection: direction.clone(), initialVelocity: initialVelocity?.clone() || null, accelerationAtFire: weapon === 'machinegun' ? GRAVITY.clone() : ZERO.clone(),
      predictedFlightSeconds: control.predictedFlightSeconds, predictedInterceptPosition: control.predictedInterceptPosition?.clone() || null,
    };
    combat.recentPlayerShots.push(shot);
    if (combat.recentPlayerShots.length > 32) combat.recentPlayerShots.shift();
    addEffect({ type: 'muzzle', position: muzzle, lifetime: .065, weapon });
    if (weapon === 'beam') beamHit(muzzle, direction, weaponStats.damage, time, shot.id);
    else {
      const projectile = spawnProjectile({ kind: weapon, owner: 'player', position: muzzle, velocity: initialVelocity, damage: weaponStats.damage, lifetime: weaponStats.lifetime, firedAtSeconds: time, targetId: control.targetId, shotId: shot.id });
      if (weapon === 'missile') {
        projectile.lastObservedPosition = target.position.clone(); projectile.lastObservedVelocity = target.velocity.clone(); projectile.lastObservedAtSeconds = time;
      }
    }
    return true;
  };
  combat.updateEnemies = (player, time, dt) => {
    lastTime = time;
    updateEnemiesAI(combat.enemies, player, time, dt, world, spawnProjectile, addEffect);
  };
  function bodyAt(body, alpha, offset = ZERO) {
    return (body.previousPosition || body.position).clone().lerp(body.position, Math.max(0, Math.min(1, alpha))).add(offset);
  }
  function guideMissile(projectile, atTime, dt, intervalStart, intervalDt) {
    const target = combat.enemies.find((enemy) => enemy.id === projectile.targetId);
    if (!target?.alive) return;
    const position = bodyAt(target, intervalDt ? (atTime - intervalStart) / intervalDt : 1);
    if (lineOfSight(projectile.position, position)) {
      projectile.lastObservedPosition.copy(position); projectile.lastObservedVelocity.copy(target.velocity); projectile.lastObservedAtSeconds = atTime;
    }
    const estimate = projectile.lastObservedPosition.clone().addScaledVector(projectile.lastObservedVelocity, atTime - projectile.lastObservedAtSeconds);
    const solution = solveIntercept(projectile.position, estimate, projectile.lastObservedVelocity, WEAPONS.missile.speed, Math.max(0, projectile.lifetime - (atTime - projectile.firedAtSeconds)));
    const desired = solution?.direction || directionTo(projectile.position, estimate, projectile.velocity);
    const current = projectile.velocity.clone().normalize();
    projectile.velocity.copy(turnDirection(current, desired, WEAPONS.missile.turnRate * dt)).multiplyScalar(WEAPONS.missile.speed);
  }
  combat.updateProjectiles = (player, time, dt) => {
    lastTime = time;
    const intervalEnd = time + dt;
    for (const projectile of combat.projectiles) {
      projectile.previousPosition.copy(projectile.position);
      let fromTime = Math.max(projectile.firedAtSeconds, projectile.lastUpdatedAtSeconds, time);
      const endTime = Math.min(intervalEnd, projectile.firedAtSeconds + projectile.lifetime);
      while (projectile.alive && fromTime < endTime - 1e-12) {
        const toTime = Math.min(endTime, fromTime + STEP), step = toTime - fromTime;
        const start = projectile.position.clone();
        if (projectile.kind === 'missile') guideMissile(projectile, fromTime, step, time, dt);
        let end;
        if (projectile.kind === 'machinegun') {
          const age = toTime - projectile.firedAtSeconds;
          end = projectile.origin.clone().addScaledVector(projectile.initialVelocity, age).addScaledVector(GRAVITY, .5 * age * age);
          projectile.velocity.copy(projectile.initialVelocity).addScaledVector(GRAVITY, age);
        } else end = start.clone().addScaledVector(projectile.velocity, step);
        const wall = world.raycast(start, end, projectile.radius);
        let firstT = wall?.t ?? Infinity, victim = null;
        const alphaStart = dt ? (fromTime - time) / dt : 0, alphaEnd = dt ? (toTime - time) / dt : 1;
        if (projectile.owner === 'player') {
          for (const enemy of combat.enemies) {
            if (!enemy.alive) continue;
            const t = movingSphereIntersection(start, end, bodyAt(enemy, alphaStart), bodyAt(enemy, alphaEnd), enemy.radius + projectile.radius);
            if (t !== null && t < firstT) { firstT = t; victim = enemy; }
          }
        } else if (player.hp > 0) {
          const offset = new Vector3(0, 2.2, 0);
          const t = movingSphereIntersection(start, end, bodyAt(player, alphaStart, offset), bodyAt(player, alphaEnd, offset), 1.15 + projectile.radius);
          if (t !== null && t < firstT) { firstT = t; victim = player; }
        }
        if (firstT <= 1) {
          projectile.position.copy(start).lerp(end, firstT); projectile.alive = false;
          const hitTime = fromTime + step * firstT;
          if (victim === player) {
            player.hp = Math.max(0, player.hp - projectile.damage);
            player.lastHitDirection = projectile.velocity.clone().negate().normalize(); player.lastHitAt = hitTime;
            addEffect({ type: 'playerHit', position: projectile.position, lifetime: .22 });
          } else if (victim) damageEnemy(victim, projectile.damage, projectile.position, hitTime, projectile.shotId);
          else addEffect({ type: projectile.kind === 'missile' ? 'explosion' : 'impact', position: projectile.position, lifetime: .2 });
        } else projectile.position.copy(end);
        fromTime = toTime;
      }
      projectile.lastUpdatedAtSeconds = endTime;
      projectile.age = Math.max(0, endTime - projectile.firedAtSeconds);
      if (intervalEnd >= projectile.firedAtSeconds + projectile.lifetime - 1e-12) projectile.alive = false;
    }
    combat.projectiles = combat.projectiles.filter((projectile) => projectile.alive);
    combat.effects = combat.effects.filter((effect) => {
      effect.age = Math.max(0, intervalEnd - effect.spawnedAtSeconds); return effect.age < effect.lifetime;
    });
  };
  combat.reset = () => {
    projectileSequence = 0; effectSequence = 0; shotSequence = 0; lastTime = 0;
    nextFire = { machinegun: 0, beam: 0, missile: 0 };
    combat.enemies = createEnemies(world); combat.projectiles = []; combat.effects = []; combat.recentPlayerShots = []; combat.damageEvents = [];
    resetLock(); combat.fireControl = inactiveControl('machinegun'); cameraState = null;
    combat.lastFeedback = ''; combat.feedbackUntil = 0;
  };
  combat.snapshot = () => copyJSON({
    lock: combat.lock, fireControl: combat.fireControl, recentPlayerShots: combat.recentPlayerShots,
    enemies: combat.enemies.map(({ id, kind, isGateControl, sectorId, position, velocity, hp, alive, alert, hasLineOfSight, shotsFired, lastShotAtSeconds }) => ({ id, kind, isGateControl, sectorId, position, velocity, hp, alive, alert, hasLineOfSight, shotsFired, lastShotAtSeconds })),
  });
  return combat;
}
