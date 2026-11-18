import * as THREE from 'three';
import { WEAPONS, PLAYER } from './config.js';
import { solveMachinegun, solveMissile } from './ballistics.js';
import { raycastBoxes, sweptSphere, rayBox, hasLineOfSight } from './collision.js';

const _direction = new THREE.Vector3();
const _end = new THREE.Vector3();
const _relativeStart = new THREE.Vector3();
const _relativeDelta = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _axis = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const FORWARD = new THREE.Vector3(0, 0, -1);

function inactiveFireControl(weapon) {
  return { status: 'inactive', weapon, targetId: null, evaluatedAtSeconds: null, muzzlePosition: null, targetPosition: null, targetVelocity: null, launchDirection: null, predictedFlightSeconds: null, predictedInterceptPosition: null, aimPoint: null, residualMeters: null };
}

function sweepPlayer(start, end, previous, current) {
  _relativeStart.subVectors(start, previous);
  _relativeDelta.subVectors(end, start).sub(new THREE.Vector3().subVectors(current, previous));
  const box = { min: [-PLAYER.radius, -PLAYER.height / 2, -PLAYER.radius], max: [PLAYER.radius, PLAYER.height / 2, PLAYER.radius], active: true };
  return rayBox(_relativeStart, _relativeDelta, 1, box);
}

export class WeaponSystem {
  constructor({ scene, colliders, player, enemies, fcs, onEnemyDamage, onPlayerDamage, onNotice }) {
    this.scene = scene; this.colliders = colliders; this.player = player; this.enemies = enemies; this.fcs = fcs;
    this.onEnemyDamage = onEnemyDamage; this.onPlayerDamage = onPlayerDamage; this.onNotice = onNotice;
    this.projectiles = [];
    this.effects = [];
    this.recentPlayerShots = [];
    this.nextShotId = 1;
    this.nextProjectileId = 1;
    this.fireControl = inactiveFireControl(player.weapon);
    this.flashUntil = -1;
    this.materials = {
      mg: new THREE.MeshBasicMaterial({ color: 0xffe07a }),
      beam: new THREE.LineBasicMaterial({ color: 0x64f5ff, transparent: true, opacity: 1 }),
      missile: new THREE.MeshStandardMaterial({ color: 0xc9d2d4, emissive: 0x632000, emissiveIntensity: 0.5 }),
      enemy: new THREE.MeshBasicMaterial({ color: 0xff6b3e }),
      flame: new THREE.MeshBasicMaterial({ color: 0xffa12b }),
    };
    this.geometries = {
      mg: new THREE.BoxGeometry(0.08, 0.08, 0.85),
      enemy: new THREE.SphereGeometry(0.15, 8, 6),
      missile: new THREE.ConeGeometry(0.20, 0.9, 10),
      flame: new THREE.ConeGeometry(0.16, 0.7, 8),
    };
  }

  reset() {
    for (const p of this.projectiles) this.scene.remove(p.mesh);
    for (const e of this.effects) { this.scene.remove(e.mesh); e.mesh.geometry?.dispose(); if (e.ownMaterial) e.mesh.material?.dispose(); }
    this.projectiles.length = 0; this.effects.length = 0;
    this.recentPlayerShots.length = 0; this.nextShotId = 1; this.nextProjectileId = 1;
    this.fireControl = inactiveFireControl(this.player.weapon); this.flashUntil = -1;
  }

  switchWeapon(weapon) {
    if (!WEAPONS[weapon] || this.player.weapon === weapon) return;
    this.player.weapon = weapon;
    this.player.model.setWeapon(weapon);
    this.fireControl = inactiveFireControl(weapon);
  }

  directDirection(muzzle, point) {
    _direction.subVectors(point, muzzle);
    if (_direction.lengthSq() < 1e-14) _direction.copy(FORWARD);
    return _direction.normalize().clone();
  }

  solveFor(weapon, target, muzzle, now) {
    const base = inactiveFireControl(weapon);
    base.targetId = target.id; base.evaluatedAtSeconds = now;
    base.muzzlePosition = muzzle.toArray(); base.targetPosition = target.position.toArray(); base.targetVelocity = target.velocity.toArray();
    let solution = null;
    if (weapon === 'machinegun') solution = solveMachinegun({ m: muzzle.toArray(), p: target.position.toArray(), v: target.velocity.toArray() });
    else if (weapon === 'missile') solution = solveMissile({ m: muzzle.toArray(), p: target.position.toArray(), v: target.velocity.toArray() });
    else solution = { t: 0, direction: this.directDirection(muzzle, target.position).toArray(), initialVelocity: null, intercept: target.position.toArray(), aimPoint: target.position.toArray(), residual: 0 };
    if (solution) {
      base.status = 'solved'; base.launchDirection = [...solution.direction];
      base.predictedFlightSeconds = solution.t; base.predictedInterceptPosition = [...solution.intercept];
      base.aimPoint = [...solution.aimPoint]; base.residualMeters = solution.residual;
      base.solution = solution;
    } else {
      base.status = 'no_solution';
      base.launchDirection = this.directDirection(muzzle, target.position).toArray();
      base.aimPoint = target.position.toArray();
    }
    return base;
  }

  updateFireControl(now) {
    const target = this.fcs.state === 'locked' ? this.fcs.target(this.enemies) : null;
    if (!target || !target.alive) {
      this.fireControl = inactiveFireControl(this.player.weapon);
      return this.fireControl;
    }
    const muzzle = this.player.getMuzzlePosition();
    this.fireControl = this.solveFor(this.player.weapon, target, muzzle, now);
    return this.fireControl;
  }

  cameraAimPoint(camera, range) {
    camera.getWorldDirection(_direction);
    const origin = camera.position;
    const stageHit = raycastBoxes(origin, _direction, range, this.colliders);
    let nearest = stageHit ? stageHit.distance : range;
    let point = stageHit ? stageHit.point.clone() : origin.clone().addScaledVector(_direction, range);
    const rayEnd = origin.clone().addScaledVector(_direction, range);
    for (const enemy of this.enemies) {
      if (!enemy.alive) continue;
      const t = sweptSphere(origin, rayEnd, enemy.position, enemy.position, enemy.hitRadius);
      if (t !== null && t * range < nearest) {
        nearest = t * range;
        point = origin.clone().addScaledVector(_direction, nearest);
      }
    }
    return point;
  }

  tryFire(now, camera) {
    const weapon = this.player.weapon;
    const spec = WEAPONS[weapon];
    if (now + 1e-8 < this.player.weaponReadyAt[weapon]) return false;
    if (weapon !== 'beam' && this.player.ammo[weapon] <= 0) { this.onNotice('弾切れ', weapon === 'missile' ? 'ミサイル残弾0' : 'マシンガン残弾0'); return false; }
    if (weapon === 'beam' && this.player.en < spec.en) { this.onNotice('EN不足', 'ビームには8 EN必要'); return false; }

    const muzzle = this.player.getMuzzlePosition();
    let target = this.fcs.state === 'locked' ? this.fcs.target(this.enemies) : null;
    if (target && !this.fcs.validate(target, muzzle)) { this.fcs.clear(); target = null; }
    if (weapon === 'missile' && !target) { this.onNotice('発射拒否', 'ミサイルはロック完了後のみ発射可能'); return false; }

    let control;
    let launchDirection;
    let solution = null;
    if (target) {
      control = this.solveFor(weapon, target, muzzle, now);
      solution = control.solution || null;
      launchDirection = new THREE.Vector3(...control.launchDirection);
    } else {
      control = inactiveFireControl(weapon);
      const aim = this.cameraAimPoint(camera, weapon === 'beam' ? 120 : 200);
      launchDirection = this.directDirection(muzzle, aim);
    }
    this.fireControl = control;
    this.player.model.setAimDirection(launchDirection, this.player.model.group.rotation.y);
    this.player.model.group.updateMatrixWorld(true);

    if (weapon === 'beam') this.player.spendEn(spec.en, now);
    else this.player.ammo[weapon]--;
    this.player.weaponReadyAt[weapon] = now + spec.interval;
    this.player.model.muzzleFlash.visible = true; this.flashUntil = now + 0.045;

    const record = {
      id: this.nextShotId++, firedAtSeconds: now, weapon,
      targetId: target?.id || null, solutionStatus: control.status,
      muzzlePosition: muzzle.toArray(), targetPositionAtFire: target ? target.position.toArray() : null,
      targetVelocityAtFire: target ? target.velocity.toArray() : null,
      launchDirection: launchDirection.toArray(), initialVelocity: null,
      accelerationAtFire: weapon === 'machinegun' ? [0, -18, 0] : [0, 0, 0],
      predictedFlightSeconds: control.predictedFlightSeconds,
      predictedInterceptPosition: control.predictedInterceptPosition,
    };

    if (weapon === 'machinegun') {
      const initialVelocity = launchDirection.clone().multiplyScalar(spec.speed);
      record.initialVelocity = initialVelocity.toArray();
      this.spawnProjectile({ type: 'machinegun', fromEnemy: false, position: muzzle, velocity: initialVelocity, age: 0, life: spec.life, damage: spec.damage, targetId: null, initialPosition: muzzle.clone(), initialVelocity: initialVelocity.clone(), gravity: -18 });
    } else if (weapon === 'beam') {
      this.fireBeam(muzzle, launchDirection, spec.range, spec.damage);
    } else {
      const initialVelocity = launchDirection.clone().multiplyScalar(spec.speed);
      record.initialVelocity = initialVelocity.toArray();
      this.spawnProjectile({ type: 'missile', fromEnemy: false, position: muzzle, velocity: initialVelocity, age: 0, life: spec.life, damage: spec.damage, targetId: target.id, initialPosition: muzzle.clone(), initialVelocity: initialVelocity.clone(), gravity: 0, observedPosition: target.position.clone(), observedVelocity: target.velocity.clone(), observationAge: 0 });
    }
    this.recentPlayerShots.push(record);
    if (this.recentPlayerShots.length > 32) this.recentPlayerShots.shift();
    return true;
  }

  makeProjectileMesh(type, fromEnemy) {
    let mesh;
    if (type === 'missile') {
      mesh = new THREE.Group();
      const body = new THREE.Mesh(this.geometries.missile, this.materials.missile); body.rotation.x = -Math.PI / 2; mesh.add(body);
      const flame = new THREE.Mesh(this.geometries.flame, this.materials.flame); flame.rotation.x = Math.PI / 2; flame.position.z = 0.65; mesh.add(flame);
    } else {
      mesh = new THREE.Mesh(fromEnemy ? this.geometries.enemy : this.geometries.mg, fromEnemy ? this.materials.enemy : this.materials.mg);
    }
    return mesh;
  }

  spawnProjectile(data) {
    const p = { ...data, id: this.nextProjectileId++, position: data.position.clone(), previousPosition: data.position.clone(), velocity: data.velocity.clone(), mesh: this.makeProjectileMesh(data.type, data.fromEnemy) };
    p.mesh.position.copy(p.position); this.scene.add(p.mesh); this.projectiles.push(p);
    return p;
  }

  spawnEnemyProjectile(enemy, muzzle, direction, spec) {
    return this.spawnProjectile({ type: 'enemy', fromEnemy: true, position: muzzle, velocity: direction.clone().multiplyScalar(spec.speed), age: 0, life: spec.life, damage: spec.damage, targetId: 'PLAYER', gravity: 0, sourceId: enemy.id });
  }

  fireBeam(muzzle, direction, range, damage) {
    const stageHit = raycastBoxes(muzzle, direction, range, this.colliders);
    let distance = stageHit?.distance ?? range;
    let hitEnemy = null;
    const end = muzzle.clone().addScaledVector(direction, range);
    for (const enemy of this.enemies) {
      if (!enemy.alive) continue;
      const t = sweptSphere(muzzle, end, enemy.position, enemy.position, enemy.hitRadius);
      if (t !== null && t * range < distance) { distance = t * range; hitEnemy = enemy; }
    }
    const hitPoint = muzzle.clone().addScaledVector(direction, distance);
    if (hitEnemy) this.onEnemyDamage(hitEnemy, damage, hitPoint);
    this.addBeamEffect(muzzle, hitPoint);
    this.addImpact(hitPoint, hitEnemy ? 0x80ffff : 0x67a9b5, 0.12);
  }

  addBeamEffect(start, end) {
    const geometry = new THREE.BufferGeometry().setFromPoints([start, end]);
    const material = this.materials.beam.clone();
    const line = new THREE.Line(geometry, material); this.scene.add(line);
    this.effects.push({ mesh: line, age: 0, life: 0.14, ownMaterial: true, update: e => { material.opacity = 1 - e.age / e.life; } });
  }

  addImpact(position, color = 0xffa04d, life = 0.24) {
    const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.28, 8, 6), material);
    mesh.position.copy(position); this.scene.add(mesh);
    this.effects.push({ mesh, age: 0, life, ownMaterial: true, update: e => { const k = 1 + e.age / e.life * 4; mesh.scale.setScalar(k); material.opacity = 0.9 * (1 - e.age / e.life); } });
  }

  updateMissileGuidance(p, dt) {
    const target = this.enemies.find(e => e.id === p.targetId);
    if (!target || !target.alive) return;
    let predicted, velocity;
    if (hasLineOfSight(p.position, target.position, this.colliders)) {
      p.observedPosition.copy(target.position); p.observedVelocity.copy(target.velocity); p.observationAge = 0;
      predicted = target.position; velocity = target.velocity;
    } else {
      p.observationAge += dt;
      predicted = p.observedPosition.clone().addScaledVector(p.observedVelocity, p.observationAge);
      velocity = p.observedVelocity;
    }
    const solution = solveMissile({ m: p.position.toArray(), p: predicted.toArray(), v: velocity.toArray(), maxTime: Math.max(0.001, p.life - p.age) });
    const desired = solution ? new THREE.Vector3(...solution.direction) : this.directDirection(p.position, predicted);
    const current = p.velocity.clone().normalize();
    const angle = current.angleTo(desired);
    if (angle > 1e-8) {
      const maxAngle = WEAPONS.missile.turnRate * dt;
      if (angle <= maxAngle) current.copy(desired);
      else {
        _axis.crossVectors(current, desired);
        if (_axis.lengthSq() < 1e-10) {
          _axis.crossVectors(current, UP);
          if (_axis.lengthSq() < 1e-10) _axis.set(1, 0, 0);
        }
        _axis.normalize();
        _quat.setFromAxisAngle(_axis, maxAngle); current.applyQuaternion(_quat);
      }
      p.velocity.copy(current.normalize().multiplyScalar(WEAPONS.missile.speed));
    }
  }

  update(dt, now) {
    this.player.model.muzzleFlash.visible = now < this.flashUntil;
    const remove = [];
    for (const p of this.projectiles) {
      p.previousPosition.copy(p.position);
      if (p.type === 'missile') this.updateMissileGuidance(p, dt);
      const step = Math.min(dt, Math.max(0, p.life - p.age));
      const nextAge = p.age + step;
      if (p.type === 'machinegun') {
        _end.copy(p.initialPosition).addScaledVector(p.initialVelocity, nextAge);
        _end.y += 0.5 * p.gravity * nextAge * nextAge;
      } else {
        _end.copy(p.position).addScaledVector(p.velocity, step);
      }
      const travel = p.position.distanceTo(_end);
      let hitT = 1, stageHit = null, hitEnemy = null, hitPlayer = false;
      if (travel > 1e-10) {
        _direction.subVectors(_end, p.position).multiplyScalar(1 / travel);
        stageHit = raycastBoxes(p.position, _direction, travel, this.colliders);
        if (stageHit) hitT = stageHit.distance / travel;
        if (p.fromEnemy) {
          const t = sweepPlayer(p.position, _end, this.player.previousPosition || this.player.position, this.player.position);
          if (t !== null && t < hitT) { hitT = t; hitPlayer = true; hitEnemy = null; }
        } else {
          for (const enemy of this.enemies) {
            if (!enemy.alive) continue;
            const t = sweptSphere(p.position, _end, enemy.previousPosition || enemy.position, enemy.position, enemy.hitRadius);
            if (t !== null && t < hitT) { hitT = t; hitEnemy = enemy; hitPlayer = false; }
          }
        }
      } else if (!p.fromEnemy) {
        // Zero-length final segments still resolve genuine muzzle overlap.
        for (const enemy of this.enemies) {
          if (enemy.alive && p.position.distanceTo(enemy.position) <= enemy.hitRadius) { hitEnemy = enemy; hitT = 0; break; }
        }
      }
      const collided = !!stageHit || !!hitEnemy || hitPlayer;
      if (collided) p.position.lerpVectors(p.position, _end, hitT);
      else p.position.copy(_end);
      p.age = nextAge;
      p.mesh.position.copy(p.position);
      if (p.velocity.lengthSq() > 1e-8) p.mesh.quaternion.setFromUnitVectors(FORWARD, p.velocity.clone().normalize());

      if (hitEnemy) { this.onEnemyDamage(hitEnemy, p.damage, p.position); this.addImpact(p.position, p.type === 'missile' ? 0xffa132 : 0xffe080, p.type === 'missile' ? 0.38 : 0.18); }
      else if (hitPlayer) { this.onPlayerDamage(p.damage, p.previousPosition, p.sourceId); this.addImpact(p.position, 0xff5838, 0.22); }
      else if (stageHit && collided) this.addImpact(p.position, 0xff9c52, 0.14);
      if (collided || p.age >= p.life - 1e-9) remove.push(p);
    }
    if (remove.length) {
      for (const p of remove) this.scene.remove(p.mesh);
      this.projectiles = this.projectiles.filter(p => !remove.includes(p));
    }
    const expired = [];
    for (const effect of this.effects) {
      effect.age += dt; effect.update?.(effect);
      if (effect.age >= effect.life) expired.push(effect);
    }
    for (const effect of expired) {
      this.scene.remove(effect.mesh); effect.mesh.geometry?.dispose(); if (effect.ownMaterial) effect.mesh.material?.dispose();
    }
    if (expired.length) this.effects = this.effects.filter(e => !expired.includes(e));
  }

  snapshotFireControl() {
    const fc = this.fireControl;
    return {
      status: fc.status, weapon: fc.weapon, targetId: fc.targetId, evaluatedAtSeconds: fc.evaluatedAtSeconds,
      muzzlePosition: fc.muzzlePosition ? [...fc.muzzlePosition] : null,
      targetPosition: fc.targetPosition ? [...fc.targetPosition] : null,
      targetVelocity: fc.targetVelocity ? [...fc.targetVelocity] : null,
      launchDirection: fc.launchDirection ? [...fc.launchDirection] : null,
      predictedFlightSeconds: fc.predictedFlightSeconds,
      predictedInterceptPosition: fc.predictedInterceptPosition ? [...fc.predictedInterceptPosition] : null,
      aimPoint: fc.aimPoint ? [...fc.aimPoint] : null,
      residualMeters: fc.residualMeters,
    };
  }

  snapshotShots() { return this.recentPlayerShots.map(s => structuredClone(s)); }
}
