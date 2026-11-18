import * as THREE from 'three';
import { ENEMY } from './config.js';
import { createGuardModel, createTurretModel } from './models.js';
import { hasLineOfSight, moveBody, raycastBoxes } from './collision.js';
import { solveMissile } from './ballistics.js';

const _toPlayer = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _candidate = new THREE.Vector3();
const _muzzle = new THREE.Vector3();
const _direction = new THREE.Vector3();
const _previous = new THREE.Vector3();

function direct(from, to) { return _direction.subVectors(to, from).normalize(); }

export class EnemySystem {
  constructor(scene, stage, player, enemies = []) {
    this.scene = scene; this.stage = stage; this.player = player; this.enemies = enemies;
    this.weapons = null;
    this.adjacency = new Map();
    for (const s of stage.sectors) this.adjacency.set(s.id, new Set());
    for (const c of stage.connections) {
      this.adjacency.get(c.a)?.add(c.b); this.adjacency.get(c.b)?.add(c.a);
    }
    for (const spawn of stage.enemySpawns) {
      const model = spawn.kind === 'guard' ? createGuardModel() : createTurretModel(spawn.isGateControl);
      scene.add(model.group);
      const enemy = {
        ...spawn, initialPosition: [...spawn.position], position: new THREE.Vector3(...spawn.position),
        previousPosition: new THREE.Vector3(...spawn.position), velocity: new THREE.Vector3(),
        hp: ENEMY[spawn.kind].hp, alive: true, alert: false, hasLineOfSight: false,
        shotsFired: 0, lastShotAtSeconds: null, model,
        hitRadius: spawn.kind === 'guard' ? 1.25 : 1.55,
        radius: spawn.kind === 'guard' ? 0.85 : 1.2, height: spawn.kind === 'guard' ? 3.1 : 3.4,
        lastSeenPosition: new THREE.Vector3(...spawn.position), lastSeenVelocity: new THREE.Vector3(), lastSeenAt: -Infinity,
        nextBurstAt: null, burstRemaining: 0, nextShotAt: null, sensorAccumulator: 0,
        verticalVelocity: 0, grounded: true, shotFlashUntil: -1, strafeSign: Number(spawn.id.slice(1)) % 2 ? 1 : -1,
        avoidUntil: 0, avoidDirection: new THREE.Vector3(), recognizedBefore: false,
      };
      model.group.position.copy(enemy.position); model.group.updateMatrixWorld(true);
      enemies.push(enemy);
    }
  }

  reset() {
    for (const e of this.enemies) {
      e.position.set(...e.initialPosition); e.previousPosition.copy(e.position); e.velocity.set(0, 0, 0);
      e.hp = ENEMY[e.kind].hp; e.alive = true; e.alert = false; e.hasLineOfSight = false;
      e.shotsFired = 0; e.lastShotAtSeconds = null; e.model.group.visible = true; e.model.flash.visible = false;
      e.lastSeenPosition.copy(e.position); e.lastSeenVelocity.set(0, 0, 0); e.lastSeenAt = -Infinity;
      e.nextBurstAt = null; e.burstRemaining = 0; e.nextShotAt = null; e.sensorAccumulator = 0;
      e.verticalVelocity = 0; e.grounded = true; e.shotFlashUntil = -1; e.avoidUntil = 0; e.recognizedBefore = false;
      e.model.group.position.copy(e.position); e.model.group.quaternion.identity(); e.model.group.updateMatrixWorld(true);
      const spawn = this.stage.enemySpawns.find(s => s.id === e.id); if (spawn?.beacon) spawn.beacon.visible = true;
    }
  }

  shareAlert(source, now) {
    for (const ally of this.enemies) {
      if (ally === source || !ally.alive || ally.kind !== 'guard') continue;
      if (ally.position.distanceTo(source.position) > 60) continue;
      const connected = ally.sectorId === source.sectorId || this.adjacency.get(source.sectorId)?.has(ally.sectorId);
      if (!connected) continue;
      ally.alert = true; ally.lastSeenAt = now;
      ally.lastSeenPosition.copy(source.lastSeenPosition); ally.lastSeenVelocity.copy(source.lastSeenVelocity);
    }
  }

  updateSensors(e, now) {
    const spec = ENEMY[e.kind];
    const distance = e.position.distanceTo(this.player.position);
    const wasVisible = e.hasLineOfSight;
    const visible = distance <= spec.range && hasLineOfSight(e.position, this.player.position, this.stage.colliders);
    e.hasLineOfSight = visible;
    if (visible) {
      e.alert = true; e.lastSeenAt = now;
      e.lastSeenPosition.copy(this.player.position); e.lastSeenVelocity.copy(this.player.velocity);
      if (e.nextBurstAt === null) e.nextBurstAt = now + spec.initialDelay;
      else if (!wasVisible && e.burstRemaining === 0 && e.nextBurstAt < now + spec.telegraph) e.nextBurstAt = now + spec.telegraph;
      if (!e.recognizedBefore) {
        if (e.kind === 'guard') this.shareAlert(e, now);
        e.recognizedBefore = true;
      }
    } else if (e.alert && now - e.lastSeenAt > 8) {
      e.alert = false; e.recognizedBefore = false; e.nextBurstAt = null; e.burstRemaining = 0; e.nextShotAt = null;
    }
  }

  navigationDirection(e, desired, now) {
    if (desired.lengthSq() < 1e-8) return desired;
    const baseAngle = Math.atan2(desired.x, desired.z);
    const offsets = [0, e.strafeSign * Math.PI / 4, -e.strafeSign * Math.PI / 4, e.strafeSign * Math.PI / 2, -e.strafeSign * Math.PI / 2, e.strafeSign * Math.PI * 0.75, -e.strafeSign * Math.PI * 0.75];
    for (const offset of offsets) {
      _candidate.set(Math.sin(baseAngle + offset), 0, Math.cos(baseAngle + offset));
      const hit = raycastBoxes(e.position, _candidate, 3.2, this.stage.colliders, box => box.kind !== 'stage' || box.max[1] > e.position.y - 1.0);
      if (!hit) return _candidate.clone();
    }
    return new THREE.Vector3();
  }

  updateGuardMovement(e, dt, now) {
    _desired.set(0, 0, 0);
    if (e.alert) {
      const target = e.hasLineOfSight ? this.player.position : e.lastSeenPosition;
      _toPlayer.subVectors(target, e.position); _toPlayer.y = 0;
      const distance = _toPlayer.length();
      if (distance > 0.01) _toPlayer.multiplyScalar(1 / distance);
      let speed = 0;
      if (!e.hasLineOfSight) {
        // Start reacquisition immediately, comfortably inside the required 0.50 s.
        _desired.copy(_toPlayer); speed = 8;
        if (distance < 5) { _desired.set(_toPlayer.z * e.strafeSign, 0, -_toPlayer.x * e.strafeSign); speed = 6; }
      } else if (distance > 55) { _desired.copy(_toPlayer); speed = 8; }
      else if (distance >= 25) {
        _desired.set(_toPlayer.z * e.strafeSign, 0, -_toPlayer.x * e.strafeSign);
        _desired.addScaledVector(_toPlayer, distance > 48 ? 0.2 : -0.08).normalize(); speed = 6;
      } else if (distance < 15) { _desired.copy(_toPlayer).multiplyScalar(-1); speed = 8; }
      else {
        _desired.copy(_toPlayer).multiplyScalar(distance > 20 ? 1 : -1); speed = 4;
      }
      if (speed > 0) {
        const navigated = this.navigationDirection(e, _desired, now);
        _desired.copy(navigated).multiplyScalar(speed);
      }
    }
    _previous.copy(e.position);
    e.verticalVelocity = e.grounded ? Math.min(0, e.verticalVelocity) : e.verticalVelocity - 18 * dt;
    const velocity = new THREE.Vector3(_desired.x, e.grounded ? -1 : e.verticalVelocity, _desired.z);
    const result = moveBody(e.position, velocity, dt, e.radius, e.height, this.stage.colliders);
    e.grounded = result.grounded;
    if (result.hitY) e.verticalVelocity = 0;
    e.velocity.subVectors(e.position, _previous).multiplyScalar(1 / dt);
    e.model.group.position.copy(e.position);
    if (e.alert) {
      const target = e.hasLineOfSight ? this.player.position : e.lastSeenPosition;
      direct(e.position, target); e.model.aim(_direction);
    } else if (_desired.lengthSq() > 0.01) {
      direct(new THREE.Vector3(), _desired); e.model.aim(_direction);
    }
    e.model.group.updateMatrixWorld(true);
  }

  fireEnemyShot(e, now) {
    const spec = ENEMY[e.kind];
    direct(e.position, this.player.position); e.model.aim(_direction); e.model.group.updateMatrixWorld(true);
    e.model.muzzle.getWorldPosition(_muzzle);
    if (!hasLineOfSight(_muzzle, this.player.position, this.stage.colliders)) return false;
    const solution = solveMissile({ m: _muzzle.toArray(), p: this.player.position.toArray(), v: this.player.velocity.toArray(), s: spec.speed, maxTime: 1.20 });
    const direction = solution ? new THREE.Vector3(...solution.direction) : direct(_muzzle, this.player.position).clone();
    this.weapons.spawnEnemyProjectile(e, _muzzle, direction, spec);
    e.shotsFired++; e.lastShotAtSeconds = now; e.shotFlashUntil = now + 0.055;
    return true;
  }

  updateAttack(e, dt, now) {
    const spec = ENEMY[e.kind];
    if (e.nextBurstAt !== null && e.burstRemaining === 0 && e.hasLineOfSight && now + 1e-8 >= e.nextBurstAt) {
      e.burstRemaining = spec.burst;
      e.nextShotAt = e.nextBurstAt;
      e.nextBurstAt += spec.cycle;
    }
    if (e.burstRemaining > 0 && now + 1e-8 >= e.nextShotAt) {
      // Every individual round rechecks the real muzzle line. Occluded rounds are skipped, never wall-shot.
      if (e.hasLineOfSight) this.fireEnemyShot(e, now);
      e.burstRemaining--;
      e.nextShotAt += spec.shotInterval;
      if (e.burstRemaining === 0) e.nextShotAt = null;
    }
    const telegraphing = e.hasLineOfSight && e.nextBurstAt !== null && now >= e.nextBurstAt - spec.telegraph && now < e.nextBurstAt;
    e.model.flash.visible = telegraphing || now < e.shotFlashUntil;
    if (telegraphing) {
      const pulse = 1 + 0.45 * Math.sin(now * 55);
      e.model.flash.scale.setScalar(pulse);
    } else e.model.flash.scale.setScalar(1);
  }

  update(dt, now) {
    for (const e of this.enemies) {
      if (!e.alive) continue;
      e.previousPosition.copy(e.position);
      e.sensorAccumulator += dt;
      if (e.sensorAccumulator >= 1 / 30 - 1e-9) {
        e.sensorAccumulator %= 1 / 30;
        this.updateSensors(e, now);
      }
      if (e.kind === 'guard') this.updateGuardMovement(e, dt, now);
      else {
        e.velocity.set(0, 0, 0);
        if (e.alert) {
          const target = e.hasLineOfSight ? this.player.position : e.lastSeenPosition;
          direct(e.position, target); e.model.aim(_direction); e.model.group.updateMatrixWorld(true);
        }
      }
      this.updateAttack(e, dt, now);
    }
  }

  snapshot() {
    return this.enemies.map(e => ({
      id: e.id, kind: e.kind, isGateControl: e.isGateControl, sectorId: e.sectorId,
      position: e.position.toArray(), velocity: e.velocity.toArray(), hp: e.hp, alive: e.alive,
      alert: e.alert, hasLineOfSight: e.hasLineOfSight, shotsFired: e.shotsFired,
      lastShotAtSeconds: e.lastShotAtSeconds,
    }));
  }
}
