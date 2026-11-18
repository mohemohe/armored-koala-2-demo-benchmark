import { CONFIG, WEAPONS, effectiveStats, createPlayer, stepMovement, beginMovementInput, spendEn } from './movement.js';
import { FCS } from './config.js';
import { STAGE, createWorld } from './stage.js';
import { createEnemies, updateEnemies } from './enemies.js';
import { updateLock, makeFireControl } from './fire-control.js';
import { createPlayerProjectile, advancePlayerProjectile, advanceLinearProjectile, traceBeam } from './ballistics.js';

const clone = value => structuredClone(value);
const normalized = v => { const n = Math.hypot(...v); return n > 1e-10 ? v.map(x => x / n) : [1, 0, 0]; };
const inactive = weapon => ({ status: 'inactive', weapon, targetId: null, evaluatedAtSeconds: null, muzzlePosition: null, targetPosition: null, targetVelocity: null, launchDirection: null, predictedFlightSeconds: null, predictedInterceptPosition: null, aimPoint: null, residualMeters: null });

export class Game {
  constructor({ seed = 20260908, stage = STAGE, loadout = { fcs: 'medium', generator: 'balanced', legs: 'biped' }, cameraProvider = null, muzzleProvider = null } = {}) {
    this.seed = seed >>> 0;
    this.stage = stage;
    this.loadout = { ...loadout };
    this.cameraProvider = cameraProvider;
    this.muzzleProvider = muzzleProvider;
    this.state = 'garage';
    this.yaw = 0;
    this.pitch = -0.10;
    this.reset();
  }

  reset() {
    this.stats = effectiveStats(this.loadout);
    this.world = createWorld(this.stage);
    this.player = createPlayer(this.loadout, this.stage.startPosition);
    this.enemies = createEnemies(this.stage.enemies);
    this.elapsedSeconds = 0;
    this.projectiles = [];
    this.effects = [];
    this.recentPlayerShots = [];
    this.shotId = 0;
    this.projectileId = 0;
    this.nextFire = { machinegun: 0, beam: 0, missile: 0 };
    this.lock = { state: 'none', targetId: null, progress: 0, radiusCssPx: 0 };
    this.fireControl = inactive('machinegun');
    this.weaponAimDirection = [1,0,0];
    this.objective = { controlsDestroyed: 0, controlsRequired: 6, openBarrierIds: [], gateOpen: false };
    this.visitedSectorIds = new Set();
    this.currentSectorId = this.world.sectorAt(this.player.position)?.id ?? null;
    if (this.currentSectorId) this.visitedSectorIds.add(this.currentSectorId);
    this.message = '';
    this.messageUntil = 0;
    this.damageAngle = null;
    this.damageUntil = 0;
    this.yaw = 0;
    this.pitch = -0.10;
  }

  notify(message, seconds = 1.8) { this.message = message; this.messageUntil = this.elapsedSeconds + seconds; }
  getMuzzle() {
    if (this.muzzleProvider) return this.muzzleProvider(this);
    const p = this.player.position, f = [Math.cos(this.yaw), 0, Math.sin(this.yaw)];
    return [p[0] + f[0] * 1.3 - f[2] * 1.4, p[1] + 1, p[2] + f[2] * 1.3 + f[0] * 1.4];
  }
  cameraInfo() {
    if (this.cameraProvider) return this.cameraProvider(this);
    return { position: this.player.position.slice(), forward: [Math.cos(this.yaw), 0, Math.sin(this.yaw)], width: 1280, height: 720, project: () => ({ x: 640, y: 360, depth: 1 }) };
  }
  switchWeapon(weapon) { if (WEAPONS[weapon]) { this.player.weapon = weapon; this.refreshFireControl(); } }
  refreshFireControl(dt = 0) {
    const camera = this.cameraInfo();
    const radius = Math.min(camera.width, camera.height) * FCS[this.loadout.fcs].radiusRatio;
    this.lock.radiusCssPx = radius;
    const result = updateLock(this.lock, this.enemies, this.getMuzzle(), camera, this.world, dt, this.stats.lockSeconds, radius);
    if (result) this.lock = result;
    this.lock.radiusCssPx = radius;
    this.fireControl = makeFireControl(this.player.weapon, this.lock, this.enemies, this.getMuzzle(), this.elapsedSeconds);
    this.weaponAimDirection = this.fireControl.launchDirection?.slice() ?? this.freeDirection(this.getMuzzle());
  }

  freeDirection(muzzle) {
    const camera = this.cameraInfo();
    const end = camera.position.map((x, i) => x + camera.forward[i] * 120);
    const hit = traceBeam(camera.position, camera.forward, this.enemies, this.world, 120);
    const aim = hit?.position ?? hit?.point ?? end;
    return normalized(aim.map((x, i) => x - muzzle[i]));
  }

  fire() {
    const weapon = this.player.weapon, spec = WEAPONS[weapon], time = this.elapsedSeconds;
    if (time + 1e-9 < this.nextFire[weapon]) return false;
    this.refreshFireControl();
    const target = this.enemies.find(e => e.id === this.lock.targetId && e.alive);
    if (weapon === 'missile' && (this.lock.state !== 'locked' || !target)) { this.notify('MISSILE REJECTED / ロック完了が必要'); return false; }
    if (weapon !== 'beam' && this.player.ammo[weapon] <= 0) { this.notify('AMMO DEPLETED / 弾切れ'); return false; }
    if (this.player.en + 1e-10 < (spec.enCost ?? 0)) { this.notify('INSUFFICIENT EN / EN不足'); return false; }
    const fc = this.fireControl, muzzle = this.getMuzzle();
    const direction = this.weaponAimDirection.slice();
    if (spec.enCost) spendEn(this.player, spec.enCost, time);
    if (weapon !== 'beam') this.player.ammo[weapon]--;
    this.nextFire[weapon] = time + spec.interval;
    const shot = weapon === 'beam' ? null : createPlayerProjectile(weapon, muzzle, direction, target, time);
    if (shot) { shot.id = ++this.projectileId; shot.owner = 'player'; shot.weapon = weapon; shot.damage = spec.damage; this.projectiles.push(shot); }
    const record = {
      id: ++this.shotId, firedAtSeconds: time, weapon, targetId: fc.targetId,
      solutionStatus: fc.status, muzzlePosition: muzzle.slice(),
      targetPositionAtFire: fc.targetPosition ? fc.targetPosition.slice() : null,
      targetVelocityAtFire: fc.targetVelocity ? fc.targetVelocity.slice() : null,
      launchDirection: direction.slice(), initialVelocity: shot ? shot.initialVelocity.slice() : null,
      accelerationAtFire: weapon === 'machinegun' ? [0, -18, 0] : [0, 0, 0],
      predictedFlightSeconds: fc.predictedFlightSeconds,
      predictedInterceptPosition: fc.predictedInterceptPosition ? fc.predictedInterceptPosition.slice() : null,
    };
    this.recentPlayerShots.push(record);
    if (this.recentPlayerShots.length > 32) this.recentPlayerShots.shift();
    this.effects.push({ type: 'muzzle', position: muzzle.slice(), remaining: .06, weapon });
    if (weapon === 'beam') {
      const hit = traceBeam(muzzle, direction, this.enemies, this.world, 120);
      const end = hit?.position ?? hit?.point ?? muzzle.map((x, i) => x + direction[i] * 120);
      this.effects.push({ type: 'beam', position: muzzle.slice(), end: end.slice(), remaining: .11, weapon });
      if (hit?.type === 'enemy') this.damageEnemy(hit.enemy, spec.damage, end);
      else if (hit) this.effects.push({ type: 'impact', position: end.slice(), remaining: .16 });
    }
    return true;
  }

  damageEnemy(enemy, amount, position) {
    if (!enemy.alive) return;
    enemy.hp = Math.max(0, enemy.hp - amount);
    this.effects.push({ type: 'impact', position: position.slice(), remaining: .18 });
    if (enemy.hp > 0) return;
    enemy.alive = false;
    enemy.velocity = [0, 0, 0];
    this.effects.push({ type: 'explosion', position: enemy.position.slice(), remaining: .75 });
    if (enemy.isGateControl) {
      this.objective.controlsDestroyed++;
      const barrier = this.stage.barriers.find(b => b.controlId === enemy.id);
      if (barrier) this.world.openBarrierIds.add(barrier.id);
      if (this.objective.controlsDestroyed === 6) {
        this.objective.gateOpen = true;
        this.world.openBarrierIds.add('FINAL-GATE');
        this.notify('ALL INTERLOCKS RELEASED / 搬出ゲート開放', 4);
      } else this.notify(`INTERLOCK RELEASED / 隔壁開放 ${this.objective.controlsDestroyed}/6`, 3);
      this.objective.openBarrierIds = [...this.world.openBarrierIds];
    }
  }

  step(dt, input) {
    if (this.state !== 'playing') return;
    const time = this.elapsedSeconds;
    beginMovementInput(this.player, input, time, this.stats);
    this.refreshFireControl();
    if (input.fireHeld) this.fire();
    this.player.previousPosition = this.player.position.slice();
    this.player.previousVelocity = this.player.velocity.slice();
    for (const e of this.enemies) e.previousPosition = e.position.slice();
    stepMovement(this.player, { ...input, edgesHandled: true }, dt, time, this.stats, this.world);
    const newEnemyShots = [];
    updateEnemies(this.enemies, this.player, this.world, dt, time, shot => {
      shot.id = ++this.projectileId;
      shot.owner = 'enemy';
      newEnemyShots.push(shot);
    });
    const aliveShots = [];
    for (const shot of [...this.projectiles, ...newEnemyShots]) {
      const elapsed = Math.max(0, Math.min(dt, time + dt - (shot.firedAtSeconds ?? time)));
      let targetPlayer = this.player;
      if (shot.owner === 'enemy' && elapsed < dt) {
        const a = 1 - elapsed / dt;
        targetPlayer = { ...this.player, previousPosition: this.player.previousPosition.map((x, i) => x + (this.player.position[i] - x) * a) };
      }
      const result = shot.owner === 'enemy'
        ? advanceLinearProjectile(shot, elapsed, targetPlayer, this.world, time + dt - elapsed)
        : advancePlayerProjectile(shot, elapsed, this.enemies, this.world, time + dt - elapsed);
      if (result.hit) {
        const hit = result.hit, position = hit.position ?? hit.point ?? shot.position;
        if (shot.owner === 'enemy' && hit.type === 'player') {
          this.player.hp = Math.max(0, this.player.hp - shot.damage);
          this.damageAngle = Math.atan2(shot.origin[2] - this.player.position[2], shot.origin[0] - this.player.position[0]) - this.yaw;
          this.damageUntil = time + dt + .7;
          this.effects.push({ type: 'damage', position: this.player.position.slice(), remaining: .18 });
        } else if (hit.type === 'enemy' && shot.owner === 'player') this.damageEnemy(hit.enemy, shot.damage, position);
        else this.effects.push({ type: 'impact', position: position.slice(), remaining: .12 });
      } else if (!result.expired) aliveShots.push(shot);
    }
    this.projectiles = aliveShots;
    this.effects = this.effects.filter(effect => (effect.remaining -= dt) > 0);
    this.elapsedSeconds += dt;
    const sector = this.world.sectorAt(this.player.position);
    this.currentSectorId = typeof sector === 'string' ? sector : sector?.id ?? null;
    if (this.currentSectorId) this.visitedSectorIds.add(this.currentSectorId);
    this.refreshFireControl(dt);
    if (this.player.hp <= 0 || this.player.position[1] < -35) this.state = 'failed';
    else if (this.objective.gateOpen && this.inEscape()) this.state = 'cleared';
  }

  advance(delta, input) {
    let remaining = delta, first = true;
    while (remaining > 1e-9 && this.state === 'playing') {
      let dt = Math.min(CONFIG.simulationStep, remaining);
      const next = this.nextFire[this.player.weapon] - this.elapsedSeconds;
      if (input.fireHeld && next > 1e-8) dt = Math.min(dt, next);
      if (this.player.movement.qbImpulseRemainingSeconds > 1e-8) dt = Math.min(dt, this.player.movement.qbImpulseRemainingSeconds);
      const currentInput = { ...input, qbPressed: first && input.qbPressed, glidePressed: first && input.glidePressed, jumpPressed: first && input.jumpPressed, spaceHeldSeconds: (input.spaceHeldSeconds ?? 0) + (delta - remaining) };
      this.step(dt, currentInput);
      first = false;
      remaining -= dt;
    }
  }

  inEscape() {
    const b = this.stage.escapeBounds;
    return this.player.position.every((x, i) => x >= b.min[i] && x <= b.max[i]);
  }

  snapshot() {
    const p = this.player;
    return clone({
      version: 'AK2-1.2-candidate', seed: this.seed, state: this.state, elapsedSeconds: this.elapsedSeconds,
      loadout: this.loadout,
      player: { position: p.position, velocity: p.velocity, grounded: p.grounded, hp: p.hp, en: p.en, weapon: p.weapon, ammo: p.ammo, movement: p.movement },
      effectiveStats: { maxEn: this.stats.maxEn, regenPerSecond: this.stats.regenPerSecond, lockSeconds: this.stats.lockSeconds, horizontalSpeedMultiplier: this.stats.horizontalSpeedMultiplier },
      lock: { state: this.lock.state, targetId: this.lock.targetId, progress: this.lock.progress, radiusCssPx: this.lock.radiusCssPx },
      fireControl: this.fireControl, recentPlayerShots: this.recentPlayerShots,
      enemies: this.enemies.map(e => ({ id: e.id, kind: e.kind, isGateControl: e.isGateControl, sectorId: e.sectorId, position: e.position, velocity: e.velocity, hp: e.hp, alive: e.alive, alert: e.alert, hasLineOfSight: e.hasLineOfSight, shotsFired: e.shotsFired, lastShotAtSeconds: e.lastShotAtSeconds })),
      objective: this.objective,
      stage: { sectorCount: this.stage.sectors.length, currentSectorId: this.currentSectorId, visitedSectorIds: [...this.visitedSectorIds], totalEnemies: 45 },
    });
  }
}
