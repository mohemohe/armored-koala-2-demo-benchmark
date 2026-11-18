import * as THREE from 'three';
import { FactoryStage } from './stage.js';
import { createPlayerModel } from './models.js';
import { PlayerController } from './player.js';
import { FlightControlSystem } from './fcs.js';
import { WeaponSystem } from './weapons.js';
import { EnemySystem } from './enemies.js';
import { InputController } from './input.js';
import { HUD, INSTRUCTIONS_HTML } from './hud.js';
import { VERSION, FIXED_DT, DEFAULT_LOADOUT, FCS, GENERATORS, LEGS, WEAPONS, BARRIER_FOR_CONTROL, effectiveStats } from './config.js';
import { raycastBoxes } from './collision.js';

export class Game {
  constructor(canvas, seed) {
    this.canvas = canvas; this.seed = seed;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.15;
    this.scene = new THREE.Scene(); this.scene.background = new THREE.Color(0x0b1319);
    this.scene.fog = new THREE.Fog(0x0b1319, 100, 430);
    this.camera = new THREE.PerspectiveCamera(72, 16 / 9, 0.12, 900);
    this.scene.add(new THREE.HemisphereLight(0xb8e5ef, 0x283022, 2.0));
    const ambient = new THREE.AmbientLight(0x8aa6b2, 1.15); this.scene.add(ambient);
    const sun = new THREE.DirectionalLight(0xffe4c0, 2.2); sun.position.set(-60, 120, 40); this.scene.add(sun);
    this.stage = new FactoryStage(this.scene);
    this.playerModel = createPlayerModel(DEFAULT_LOADOUT.legs); this.scene.add(this.playerModel.group);
    this.player = new PlayerController(this.playerModel, this.stage.colliders, DEFAULT_LOADOUT);
    this.enemies = [];
    this.fcs = new FlightControlSystem(this.camera, canvas, this.stage.colliders);
    this.weapons = new WeaponSystem({
      scene: this.scene, colliders: this.stage.colliders, player: this.player, enemies: this.enemies, fcs: this.fcs,
      onEnemyDamage: (e, amount, point) => this.damageEnemy(e, amount, point),
      onPlayerDamage: (amount, source, id) => this.damagePlayer(amount, source, id),
      onNotice: (title, detail) => this.hud?.setNotice(title, detail, this.elapsed),
    });
    this.enemySystem = new EnemySystem(this.scene, this.stage, this.player, this.enemies);
    this.enemySystem.weapons = this.weapons;
    this.hud = new HUD(document.getElementById('hud'), canvas);
    this.overlay = document.getElementById('overlay'); this.pointerMessage = document.getElementById('pointer-message');
    this.input = new InputController(canvas);
    this.input.onEscape = () => { if (this.state === 'playing') this.pause(); };
    this.input.onPause = () => { if (this.state === 'playing') this.pause(); };
    document.addEventListener('pointerlockchange', () => this.onPointerLockChange());
    document.addEventListener('pointerlockerror', () => { if (this.startRequested) this.pointerLockFailed(); });
    window.addEventListener('resize', () => this.resize());
    this.loadout = { ...DEFAULT_LOADOUT }; this.state = 'garage'; this.elapsed = 0;
    this.yaw = Math.PI / 2; this.pitch = -0.08; this.accumulator = 0; this.lastFrame = performance.now();
    this.startRequested = false; this.currentSectorId = 'S00'; this.visitedSectorIds = [];
    this.controlsDestroyed = 0; this.objective = { gateOpen: false };
    this.currentObjective = { label: '', position: null, id: null };
    this.createGarageEnvironment(); this.resize(); this.showGarage();
    this.loop = this.loop.bind(this); requestAnimationFrame(this.loop);
  }

  createGarageEnvironment() {
    this.garageGroup = new THREE.Group(); this.scene.add(this.garageGroup);
    const floor = new THREE.Mesh(new THREE.CylinderGeometry(6, 6.5, 0.6, 48), new THREE.MeshStandardMaterial({ color: 0x1f3139, metalness: 0.8, roughness: 0.45 }));
    floor.position.set(3, -0.35, 0); this.garageGroup.add(floor);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(5.4, 0.08, 8, 64), new THREE.MeshBasicMaterial({ color: 0x61cbbb }));
    ring.rotation.x = Math.PI / 2; ring.position.set(3, 0.01, 0); this.garageGroup.add(ring);
    for (const x of [-2, 8]) {
      const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.6, 9, 0.6), new THREE.MeshStandardMaterial({ color: 0x32434b, metalness: 0.7 }));
      pillar.position.set(x, 4.5, 2.5); this.garageGroup.add(pillar);
    }
    const key = new THREE.SpotLight(0xc8fff2, 180, 30, 0.65, 0.5); key.position.set(5, 9, -7); key.target.position.set(3, 2, 0);
    this.garageGroup.add(key, key.target);
  }

  resize() {
    const width = this.canvas.clientWidth || innerWidth, height = this.canvas.clientHeight || innerHeight;
    this.renderer.setSize(width, height, false); this.camera.aspect = width / height; this.camera.updateProjectionMatrix();
  }

  updateCamera() {
    const forward = new THREE.Vector3(Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch)).normalize();
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, Math.sin(this.yaw));
    const target = this.player.position.clone().add(new THREE.Vector3(0, 1.1, 0));
    const desiredOffset = forward.clone().multiplyScalar(-7.2).addScaledVector(right, 1.5).add(new THREE.Vector3(0, 1.1, 0));
    const length = desiredOffset.length(), direction = desiredOffset.normalize();
    const hit = raycastBoxes(target, direction, length, this.stage.colliders);
    const distance = hit ? Math.max(0.3, hit.distance - 0.35) : length;
    this.camera.position.copy(target).addScaledVector(direction, distance);
    this.camera.lookAt(target.clone().addScaledVector(forward, 12)); this.camera.updateMatrixWorld(true);
  }

  visualAimDirection() {
    if (this.weapons.fireControl.launchDirection) return new THREE.Vector3(...this.weapons.fireControl.launchDirection);
    return this.camera.getWorldDirection(new THREE.Vector3());
  }

  updateObjective() {
    this.currentObjective = this.stage.getObjectiveTarget(this.enemies, this.controlsDestroyed);
    this.currentObjective.barrierId = BARRIER_FOR_CONTROL[this.currentObjective.id] || null;
  }

  step(dt) {
    const now = this.elapsed;
    this.player.previousPosition = this.player.position.clone();
    this.player.beginStep(dt, now, this.input, this.yaw);
    if (this.input.consumePress('Digit1')) this.weapons.switchWeapon('machinegun');
    if (this.input.consumePress('Digit2')) this.weapons.switchWeapon('beam');
    if (this.input.consumePress('Digit3')) this.weapons.switchWeapon('missile');
    this.updateCamera(); this.player.syncModel(now, this.yaw, this.visualAimDirection());
    this.fcs.update(dt, this.enemies, this.player.getMuzzlePosition());
    this.weapons.updateFireControl(now);
    this.player.syncModel(now, this.yaw, this.visualAimDirection());
    if (this.input.mouseDown) this.weapons.tryFire(now, this.camera);
    this.enemySystem.update(dt, now);
    this.player.updateMovement(dt, now, this.input, this.yaw);
    this.player.syncModel(now + dt, this.yaw, this.visualAimDirection());
    this.weapons.update(dt, now);

    const sector = this.stage.getSector(this.player.position);
    this.currentSectorId = sector?.id || null;
    if (sector && !this.visitedSectorIds.includes(sector.id)) this.visitedSectorIds.push(sector.id);
    this.updateObjective();
    this.elapsed += dt;
    // Failure wins if destruction and escape occur in the same simulation update.
    if (this.player.hp <= 0 || this.player.position.y < -40) this.finish(false);
    else if (this.objective.gateOpen && this.stage.isInsideEscape(this.player.position)) this.finish(true);
  }

  damageEnemy(enemy, amount, point) {
    if (!enemy.alive || this.state !== 'playing') return;
    enemy.hp = Math.max(0, enemy.hp - amount);
    if (enemy.hp <= 0) {
      enemy.alive = false; enemy.velocity.set(0, 0, 0); enemy.model.group.visible = false;
      const spawn = this.stage.enemySpawns.find(s => s.id === enemy.id); if (spawn?.beacon) spawn.beacon.visible = false;
      this.weapons.addImpact(point || enemy.position, enemy.isGateControl ? 0xffc04d : 0xff7138, enemy.isGateControl ? 0.7 : 0.42);
      if (enemy.isGateControl) {
        const id = this.stage.openBarrierForControl(enemy.id);
        this.controlsDestroyed++;
        this.hud.setNotice('隔壁制御を破壊', `${enemy.id} → ${id} 開放 (${this.controlsDestroyed}/6)`, this.elapsed);
        if (this.controlsDestroyed >= 6) {
          this.objective.gateOpen = true; this.stage.setFinalGateOpen(true);
          this.hud.setNotice('最終ゲート開放', '搬出ホールの先にある脱出領域へ', this.elapsed);
        }
      }
    }
  }

  damagePlayer(amount, sourcePosition) {
    if (this.state !== 'playing') return;
    this.player.damage(amount); this.hud.addDamage(sourcePosition, this);
  }

  resetSortie() {
    this.elapsed = 0; this.accumulator = 0; this.yaw = Math.PI / 2; this.pitch = -0.08;
    this.stage.reset(); this.enemySystem.reset(); this.player.reset(this.loadout); this.player.previousPosition = this.player.position.clone();
    this.weapons.reset(); this.fcs.configure(this.loadout, this.player.stats); this.hud.reset();
    this.controlsDestroyed = 0; this.objective = { gateOpen: false }; this.currentSectorId = 'S00'; this.visitedSectorIds = [];
    this.updateObjective(); this.input.clear();
  }

  deploy() {
    this.resetSortie();
    this.garageGroup.visible = false; this.stage.group.visible = true; this.playerModel.group.visible = true;
    for (const e of this.enemies) e.model.group.visible = e.alive;
    this.requestControl();
  }

  requestControl() {
    this.startRequested = true; this.input.clear(); this.pointerMessage.classList.add('hidden');
    try {
      const request = this.canvas.requestPointerLock();
      if (request?.catch) request.catch(() => this.pointerLockFailed());
    } catch { this.pointerLockFailed(); }
  }

  pointerLockFailed() {
    this.startRequested = false;
    this.state = 'paused';
    this.pointerMessage.textContent = 'ポインターロックを取得できません。画面をクリックして再試行してください。'; this.pointerMessage.classList.remove('hidden');
    this.showPause();
  }

  onPointerLockChange() {
    if (document.pointerLockElement === this.canvas) {
      if (this.startRequested) {
        this.startRequested = false; this.state = 'playing'; this.input.clear(); this.input.suppressInitialLook(); this.accumulator = 0; this.lastFrame = performance.now();
        this.overlay.className = ''; this.overlay.innerHTML = ''; document.getElementById('hud').classList.remove('hidden');
      }
    } else if (this.state === 'playing') this.pause(false);
  }

  pause(exitLock = true) {
    if (this.state !== 'playing') return;
    this.state = 'paused'; this.input.clear(); this.accumulator = 0; this.showPause();
    if (exitLock && document.pointerLockElement === this.canvas) document.exitPointerLock();
  }

  finish(cleared) {
    if (this.state !== 'playing') return;
    this.state = cleared ? 'cleared' : 'failed'; this.input.clear(); this.accumulator = 0;
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    this.showResult(cleared);
  }

  showGarage() {
    this.state = 'garage'; this.startRequested = false; this.input.clear(); this.accumulator = 0;
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    this.stage.group.visible = false; this.garageGroup.visible = true; this.playerModel.group.visible = true;
    for (const e of this.enemies) e.model.group.visible = false;
    this.player.reset(this.loadout); this.playerModel.group.position.x = 3; this.playerModel.group.rotation.y = 0;
    document.getElementById('hud').classList.add('hidden'); this.pointerMessage.classList.add('hidden');
    this.renderGarageMenu();
  }

  renderGarageMenu() {
    const stats = effectiveStats(this.loadout);
    const groups = [
      ['fcs', 'FCS / Flight Control System', FCS], ['generator', 'ジェネレーター', GENERATORS], ['legs', '脚部', LEGS],
    ];
    const choices = groups.map(([key, label, data]) => `<section class="part-group"><h3>${label}</h3><div class="choices">${Object.entries(data).map(([id, part]) => {
      let spec = key === 'fcs' ? `円半径 ${part.radius.toFixed(2)}D / ${part.lockSeconds.toFixed(2)}s` : key === 'generator' ? `${part.maxEn} EN / 回復 ${part.regen}/s` : `速度×${part.speed} / 回復×${part.regen} / ロック×${part.lock}`;
      return `<button class="choice ${this.loadout[key] === id ? 'selected' : ''}" data-key="${key}" data-value="${id}">${part.name}<small>${spec}<br>＋ ${part.merit}<br>− ${part.demerit}</small></button>`;
    }).join('')}</div></section>`).join('');
    this.overlay.className = 'active garage';
    this.overlay.innerHTML = `<div class="menu"><h1 class="title">ARMORED <em>KOALA 2</em></h1><div class="subtitle">DEMO / FACTORY ESCAPE / AK2-1.2</div><h2>機体構成 <small>18通り・出撃後変更不可</small></h2><div class="loadout-grid">${choices}</div>
      <div class="stats"><div class="stat"><small>最大EN（脚部補正後）</small><strong>${stats.maxEn}</strong></div><div class="stat"><small>EN回復率</small><strong>${stats.regenPerSecond}/s</strong></div><div class="stat"><small>ロック所要時間</small><strong>${stats.lockSeconds.toFixed(3)}s</strong></div><div class="stat"><small>水平速度倍率</small><strong>×${stats.horizontalSpeedMultiplier}</strong></div></div>
      <div class="menu-actions"><button id="deploy" class="primary">出 撃</button><span class="menu-foot">HP1000 / MG300 / MSL12 / 全3武器携行</span></div>
      <details class="details" open><summary>操作方法・FCS・QB</summary>${INSTRUCTIONS_HTML}</details></div>`;
    this.overlay.querySelectorAll('.choice').forEach(button => button.addEventListener('click', () => {
      this.loadout[button.dataset.key] = button.dataset.value;
      this.player.loadout = { ...this.loadout }; this.player.stats = effectiveStats(this.loadout); this.playerModel.setLegs(this.loadout.legs);
      this.renderGarageMenu();
    }));
    this.overlay.querySelector('#deploy').addEventListener('click', () => this.deploy());
    this.camera.position.set(0, 4.0, -10.5); this.camera.lookAt(0, 2.6, 0); this.camera.updateMatrixWorld(true);
  }

  showPause() {
    this.overlay.className = 'active';
    this.overlay.innerHTML = `<div class="menu compact"><h1 class="result" style="color:#d8efeb">PAUSED</h1><p>全ての戦闘・移動・EN・ロック・予告・慣性タイマーを停止しています。</p><div class="menu-actions"><button id="resume" class="primary">再開（ポインターロック）</button><button id="restart" class="secondary">同構成で再出撃</button><button id="garage" class="secondary">格納庫</button></div><details class="details" open><summary>操作方法</summary>${INSTRUCTIONS_HTML}</details></div>`;
    this.overlay.querySelector('#resume').addEventListener('click', () => this.requestControl());
    this.overlay.querySelector('#restart').addEventListener('click', () => this.deploy());
    this.overlay.querySelector('#garage').addEventListener('click', () => this.showGarage());
  }

  showResult(cleared) {
    const kills = this.enemies.filter(e => !e.alive).length;
    this.overlay.className = 'active';
    this.overlay.innerHTML = `<div class="menu compact"><h1 class="result ${cleared ? '' : 'failed'}">${cleared ? 'ESCAPED' : 'MACHINE LOST'}</h1><h2>${cleared ? '廃工場からの脱出に成功' : '脱出失敗'}</h2><p class="result-stats">経過 ${this.elapsed.toFixed(2)} 秒　/　撃破 ${kills}/45　/　制御 ${this.controlsDestroyed}/6<br>訪問区画 ${this.visitedSectorIds.length}/21　/　QB成功 ${this.player.qbSuccessfulCount} 回</p><div class="menu-actions"><button id="restart" class="primary">同構成で再出撃</button><button id="garage" class="secondary">格納庫へ戻る</button></div></div>`;
    this.overlay.querySelector('#restart').addEventListener('click', () => this.deploy());
    this.overlay.querySelector('#garage').addEventListener('click', () => this.showGarage());
  }

  loop(timestamp) {
    const realDt = Math.min(0.25, Math.max(0, (timestamp - this.lastFrame) / 1000)); this.lastFrame = timestamp;
    if (this.state === 'playing') {
      const [dx, dy] = this.input.consumeLook();
      this.yaw -= dx * 0.0021; this.pitch = Math.max(-1.12, Math.min(1.12, this.pitch - dy * 0.0021));
      this.accumulator += realDt;
      while (this.accumulator >= FIXED_DT && this.state === 'playing') { this.step(FIXED_DT); this.accumulator -= FIXED_DT; }
      this.updateCamera();
      this.playerModel.group.visible = this.camera.position.distanceTo(this.player.position) > 2.0;
      this.hud.update(this);
    } else if (this.state === 'garage') {
      this.playerModel.animate(timestamp / 1000, 0, true, 'grounded', 'walk');
      this.playerModel.group.updateMatrixWorld(true);
    }
    this.renderer.render(this.scene, this.camera); requestAnimationFrame(this.loop);
  }

  getSnapshot() {
    const openBarrierIds = [...this.stage.barriers.values()].filter(b => b.open).map(b => b.id);
    return structuredClone({
      version: VERSION, seed: this.seed, state: this.state, elapsedSeconds: this.elapsed, loadout: { ...this.loadout },
      player: this.player.snapshot(this.elapsed), effectiveStats: { ...this.player.stats },
      lock: this.fcs.snapshot(), fireControl: this.weapons.snapshotFireControl(), recentPlayerShots: this.weapons.snapshotShots(),
      enemies: this.enemySystem.snapshot(),
      objective: { controlsDestroyed: this.controlsDestroyed, controlsRequired: 6, openBarrierIds, gateOpen: this.objective.gateOpen },
      stage: { sectorCount: this.stage.sectors.length, currentSectorId: this.currentSectorId, visitedSectorIds: [...this.visitedSectorIds], totalEnemies: 45 },
    });
  }
}
