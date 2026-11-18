import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import {
  DEFAULT_SEED,
  DEFAULT_LOADOUT,
  PLAYER,
  SOLVER,
  VERSION,
  WEAPON_LIST,
  type WeaponId
} from '../core/config';
import { Rng, CosmeticRng, parseSeedFromLocation } from '../core/rng';
import { ENEMY_SPAWNS, PLAYER_START, CLEAR_POINT, BARRIERS, ZONES, ZONE_BY_ID } from './stage';
import { World } from './world';
import { Player, type Loadout } from './player';
import { Enemy, updateEnemies, type EnemyShot } from './enemy';
import {
  updateProjectiles,
  type MachinegunBullet,
  type Missile,
  type EnemyBullet,
  type Projectile
} from './projectiles';
import { buildGuard, buildTurret } from './models';
import { Input } from './input';
import { Hud, type HudDamageMark } from '../ui/hud';
import { moveAabb, raycastWorld, type Box } from './collision';
import type { FcsTargetInfo, ShotRecord } from './types';

export type GameState = 'garage' | 'playing' | 'paused' | 'cleared' | 'failed';

interface Effect {
  mesh: THREE.Object3D;
  life: number;
  maxLife: number;
  kind: 'beam' | 'impact' | 'explosion';
}

export class Game {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly garageScene = new THREE.Scene();
  readonly garageCamera: THREE.PerspectiveCamera;

  readonly world = new World(this.scene);
  player!: Player;
  enemies: Enemy[] = [];
  enemyModels = new Map<string, THREE.Object3D>();
  projectiles: Projectile[] = [];
  projectileModels = new Map<Projectile, THREE.Object3D>();
  effects: Effect[] = [];

  hud!: Hud;
  input!: Input;
  loadout: Loadout = { ...DEFAULT_LOADOUT };
  state: GameState = 'garage';
  elapsed = 0;
  seed = DEFAULT_SEED;
  rng!: Rng;
  cosmeticRng!: CosmeticRng;

  // objective
  controlsDestroyed = 0;
  openBarrierIds: string[] = [];
  gateOpen = false;
  cleared = false;
  failed = false;
  failureReason = '';
  visitedZones: string[] = [];
  currentZone: string | null = null;

  // runtime
  private accumulator = 0;
  private lastFrame = 0;
  private scratch: Box[] = [];
  private damageMarks: HudDamageMark[] = [];
  private enemyShots: EnemyShot[] = [];
  private projectileGeo: THREE.BufferGeometry;
  private missileGeo: THREE.BufferGeometry;
  private bulletMat: THREE.MeshBasicMaterial;
  private missileMat: THREE.MeshBasicMaterial;
  private enemyBulletMat: THREE.MeshBasicMaterial;
  private enemyTelegraph = false;
  private pendingNotices: string[] = [];
  private frameCount = 0;
  private fpsAccum = 0;
  private fps = 0;
  /** optional developer test scenario, selected with ?test=exposure */
  testMode: string | null = null;
  onStateChange: ((s: GameState) => void) | null = null;
  onResult: ((cleared: boolean, stats: string) => void) | null = null;

  constructor(canvas: HTMLCanvasElement, uiRoot: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance'
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.setClearColor(0x05070a, 1);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.camera = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.08, 2600);
    this.camera.position.set(0, 6, -12);

    // ---- lighting ----
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.75;
    pmrem.dispose();
    const hemi = new THREE.HemisphereLight(0xa8ccE6, 0x30363c, 1.6);
    this.scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xe8f0fa, 1.35);
    dir.position.set(0.5, 1, 0.35);
    this.scene.add(dir);
    const rim = new THREE.DirectionalLight(0x63b6e6, 0.55);
    rim.position.set(-0.6, 0.4, -0.7);
    this.scene.add(rim);
    const fill = new THREE.DirectionalLight(0xffc48a, 0.35);
    fill.position.set(-0.2, -0.8, 0.4);
    this.scene.add(fill);

    this.scene.background = new THREE.Color(0x05070a);
    this.scene.fog = new THREE.Fog(0x0a0f14, 260, 1500);

    // ---- garage preview scene ----
    this.garageCamera = new THREE.PerspectiveCamera(38, 1.4, 0.1, 100);
    this.garageCamera.position.set(0, 1.6, 5.2);
    this.garageCamera.lookAt(0, 1.1, 0);
    const gHemi = new THREE.HemisphereLight(0xbcd8f0, 0x1a1f24, 1.5);
    this.garageScene.add(gHemi);
    const gKey = new THREE.DirectionalLight(0xffffff, 2.2);
    gKey.position.set(2.2, 3.4, 3.2);
    this.garageScene.add(gKey);
    const gFill = new THREE.DirectionalLight(0x66c8ff, 0.9);
    gFill.position.set(-2.5, 1.2, 1.4);
    this.garageScene.add(gFill);
    const gFloor = new THREE.Mesh(
      new THREE.CircleGeometry(6, 48),
      new THREE.MeshStandardMaterial({ color: 0x11161c, roughness: 0.9 })
    );
    gFloor.rotation.x = -Math.PI / 2;
    gFloor.position.y = -0.02;
    this.garageScene.add(gFloor);

    this.projectileGeo = new THREE.SphereGeometry(0.13, 8, 6);
    this.missileGeo = new THREE.ConeGeometry(0.18, 0.85, 8);
    this.bulletMat = new THREE.MeshBasicMaterial({ color: 0xffe07a });
    this.missileMat = new THREE.MeshBasicMaterial({ color: 0xff8a3a });
    this.enemyBulletMat = new THREE.MeshBasicMaterial({ color: 0xff4a4a });

    const seedParam = parseSeedFromLocation(window.location.search);
    this.seed = Number.isFinite(seedParam) ? (seedParam as number) : DEFAULT_SEED;
    const params = new URLSearchParams(window.location.search);
    this.testMode = params.get('test');
    this.rng = new Rng(this.seed);
    this.cosmeticRng = new CosmeticRng(this.seed);

    this.hud = new Hud(uiRoot);
    this.input = new Input(canvas);

    this.buildStage();
    this.resetRun();
  }

  /* ------------------------------------------------------------------ */
  /* stage construction                                                 */
  /* ------------------------------------------------------------------ */

  buildStage(): void {
    this.world.buildDoors();
    this.world.buildGeometry();
    const avoid = ENEMY_SPAWNS.map((sp) => ({ x: sp.x, z: sp.z, r: 5 }));
    avoid.push({ x: PLAYER_START.x, z: PLAYER_START.z, r: 16 });
    // keep a clear launch lane in front of the start position
    const clearRects = [
      { x0: PLAYER_START.x - 9, x1: PLAYER_START.x + 9, z0: PLAYER_START.z, z1: PLAYER_START.z + 95 }
    ];
    if (this.testMode === 'exposure') {
      // the exposure arena must be free of cover
      clearRects.push({ x0: 170, x1: 320, z0: 660, z1: 790 });
    } else if (this.testMode === 'shaft') {
      clearRects.push({ x0: 500, x1: 600, z0: 610, z1: 790 });
    } else if (this.testMode === 'barrier') {
      clearRects.push({ x0: 400, x1: 500, z0: 620, z1: 740 });
    } else if (this.testMode === 'clear') {
      clearRects.push({ x0: CLEAR_POINT.x - 60, x1: CLEAR_POINT.x + 20, z0: CLEAR_POINT.z - 70, z1: CLEAR_POINT.z + 20 });
    }
    this.world.buildProps(this.seed, avoid, clearRects);
    this.world.buildBarriers();
    this.world.buildNavGraph();

    // enemies
    for (const spawn of ENEMY_SPAWNS) {
      const zone = ZONE_BY_ID.get(spawn.zone)!;
      const level = zone.levels[spawn.level ?? 0];
      const e = new Enemy({
        id: spawn.id,
        kind: spawn.kind,
        zoneId: spawn.zone,
        x: spawn.x,
        y: level.y,
        z: spawn.z,
        yaw: spawn.yaw ?? 0,
        isGateControl: !!spawn.control
      });
      this.enemies.push(e);
    }
  }

  resetRun(): void {
    this.rng.reset(this.seed);
    this.elapsed = 0;
    this.accumulator = 0;
    this.projectiles.length = 0;
    this.enemyShots.length = 0;
    this.effects.length = 0;
    this.damageMarks.length = 0;
    this.controlsDestroyed = 0;
    this.openBarrierIds.length = 0;
    this.gateOpen = false;
    this.cleared = false;
    this.failed = false;
    this.failureReason = '';
    this.visitedZones = [];
    this.currentZone = null;

    if (!this.player) {
      this.player = new Player(this.loadout);
      this.scene.add(this.player.rig.root);
    } else {
      this.player.loadout.fcs = this.loadout.fcs;
      this.player.loadout.generator = this.loadout.generator;
      this.player.loadout.legs = this.loadout.legs;
      this.player.fcs.setFcs(this.loadout.fcs);
      this.player.reset();
      // rebuild the mech when the leg count changed
      const old = this.player.rig.root;
      this.scene.remove(old);
      this.player = new Player(this.loadout);
      this.scene.add(this.player.rig.root);
    }
    this.player.selectWeapon(this.loadout.weapon);

    const zone = ZONE_BY_ID.get(PLAYER_START.zone)!;
    this.player.position.set(PLAYER_START.x, zone.levels[0].y + 0.02, PLAYER_START.z);
    this.player.yaw = PLAYER_START.yaw;
    this.player.pitch = 0;

    // reset enemies
    for (const e of this.enemies) {
      const spawn = ENEMY_SPAWNS.find((s) => s.id === e.id)!;
      const z = ZONE_BY_ID.get(spawn.zone)!;
      const level = z.levels[spawn.level ?? 0];
      e.reset();
      e.pos.set(spawn.x, level.y + e.spec.height / 2, spawn.z);
      e.yaw = spawn.yaw ?? 0;
    }
    if (this.testMode === 'exposure') {
      // stationary player in the open with two guards and one turret in range
      this.player.position.set(215, 0.02, 700);
      const yawParam = new URLSearchParams(window.location.search).get('yaw');
      this.player.yaw = yawParam !== null ? Number(yawParam) : 0;
      const arena: [string, number, number][] = [
        ['E-GRD-01', 218, 748],
        ['E-GRD-02', 248, 742],
        ['E-TUR-15', 182, 745]
      ];
      for (const e of this.enemies) {
        const spot = arena.find((a) => a[0] === e.id);
        if (spot) e.pos.set(spot[1], e.spec.height / 2, spot[2]);
      }
    } else if (this.testMode === 'shaft') {
      // the player stands under the opening of transfer shaft A
      this.player.position.set(550, 0.02, 700);
      this.player.yaw = 0;
    } else if (this.testMode === 'barrier') {
      // the player faces the first control turret inside the rolling mill
      this.player.position.set(450, 0.02, 630);
      this.player.yaw = 0;
      const e = this.enemies.find((x) => x.id === 'E-TUR-01');
      if (e) e.pos.set(450, e.spec.height / 2, 700);
    } else if (this.testMode === 'clear') {
      // all six control turrets in front of the player, who stands in the
      // evacuation zone so the final clear condition can be evaluated
      this.player.position.set(CLEAR_POINT.x, 24.02, CLEAR_POINT.z);
      this.player.yaw = Math.PI;
      const ids = ['E-TUR-01', 'E-TUR-03', 'E-TUR-06', 'E-TUR-07', 'E-TUR-08', 'E-TUR-09'];
      ids.forEach((id, i) => {
        const e = this.enemies.find((x) => x.id === id);
        if (e) {
          e.pos.set(CLEAR_POINT.x - 7.5 + i * 3, 24 + e.spec.height / 2, CLEAR_POINT.z - 55);
          e.passive = true;
        }
      });
    }

    // rebuild enemy models
    for (const [, m] of this.enemyModels) this.scene.remove(m);
    this.enemyModels.clear();
    for (const e of this.enemies) this.ensureEnemyModel(e);

    // reset barriers and the final gate
    this.rebuildBarrierVisuals();
    this.world.resetBarriers();
    this.hud.clearNotices();
    this.hud.notice('SORTIE START');
  }

  private rebuildBarrierVisuals(): void {
    // barriers are rebuilt by recreating their meshes/boxes
    this.world.barrierGroup.clear();
    this.world.barrierBoxes.clear();
    for (const spec of BARRIERS) {
      const door = this.world.doors.find((d) => d.barrierId === spec.id);
      if (!door) continue;
      const geo =
        door.axis === 'x'
          ? new THREE.BoxGeometry(1.0, door.height, door.width)
          : new THREE.BoxGeometry(door.width, door.height, 1.0);
      const mesh = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({ color: 0xff5a2b, emissive: 0x501200, roughness: 0.5, metalness: 0.4 })
      );
      mesh.position.set(door.x, door.y + door.height / 2, door.z);
      this.world.barrierGroup.add(mesh);
    }
  }

  setLoadout(loadout: Loadout): void {
    this.loadout = { ...loadout };
  }

  /* ------------------------------------------------------------------ */
  /* state transitions                                                  */
  /* ------------------------------------------------------------------ */

  startRun(): void {
    this.resetRun();
    this.setState('playing');
    this.input.requestPointerLock();
  }

  setState(s: GameState): void {
    if (this.state === s) return;
    this.state = s;
    this.hud.show(s === 'playing' || s === 'paused');
    if (s !== 'playing') {
      this.input.resetEdges();
      this.input.exitPointerLock();
    }
    this.onStateChange?.(s);
  }

  pause(): void {
    if (this.state === 'playing') this.setState('paused');
  }

  resume(): void {
    if (this.state === 'paused') {
      this.input.resetEdges();
      this.setState('playing');
      this.input.requestPointerLock();
    }
  }

  /* ------------------------------------------------------------------ */
  /* main loop                                                          */
  /* ------------------------------------------------------------------ */

  frame(nowMs: number): void {
    const now = nowMs / 1000;
    let dt = this.lastFrame === 0 ? 0 : now - this.lastFrame;
    this.lastFrame = now;
    if (!Number.isFinite(dt) || dt < 0) dt = 0;
    dt = Math.min(dt, 0.2);

    this.fpsAccum += dt;
    this.frameCount++;
    if (this.fpsAccum > 0.5) {
      this.fps = this.frameCount / this.fpsAccum;
      this.frameCount = 0;
      this.fpsAccum = 0;
    }

    if (this.state === 'playing') {
      this.applyLook(dt);
      this.input.updateSpaceHold(dt);
      this.accumulator += dt;
      let steps = 0;
      while (this.accumulator >= 1 / 120 && steps < 24) {
        this.step(1 / 120);
        this.accumulator -= 1 / 120;
        steps++;
      }
      if (steps >= 24) this.accumulator = 0;
      this.updateVisuals(dt);
      this.updateHud();
    } else if (this.state === 'garage') {
      this.updateGarage(dt);
    }

    this.input.endFrame();
  }

  private applyLook(dt: number): void {
    const sens = PLAYER.mouseSensitivity;
    if (this.input.pointerLocked) {
      this.player.yaw -= this.input.mouseDx * sens;
      this.player.pitch -= this.input.mouseDy * sens;
    }
    this.player.pitch = Math.max(PLAYER.pitchMin, Math.min(PLAYER.pitchMax, this.player.pitch));
    const w = this.input.weaponRequest();
    if (w) this.player.selectWeapon(w);
    if (this.input.pauseEdge) this.pause();
  }

  /** one fixed simulation step */
  private step(dt: number): void {
    const now = this.elapsed;

    // 1) projectiles advance first (they were created in the previous step)
    const playerCenter = new THREE.Vector3(
      this.player.position.x,
      this.player.position.y + PLAYER.height / 2,
      this.player.position.z
    );
    updateProjectiles(
      this.projectiles,
      dt,
      now,
      this.world,
      this.enemies,
      playerCenter,
      PLAYER.radius,
      {
        onImpact: (x, y, z, nx, ny, nz, friendly) => this.spawnImpact(x, y, z, nx, ny, nz, friendly),
        onExplosion: (x, y, z) => this.spawnExplosion(x, y, z),
        onEnemyDamaged: (e, dmg) => this.damageEnemy(e, dmg),
        onPlayerDamaged: (dmg, sx, sy, sz) => this.damagePlayer(dmg, sx, sy, sz)
      }
    );
    this.syncProjectileModels();

    // 2) quick boost (consumes EN first)
    const ctx = this.buildCtx(dt, now);
    this.player.beginStep(ctx);

    // 3) enemies
    this.enemyShots.length = 0;
    updateEnemies({
      dt,
      now,
      world: this.world,
      playerPos: this.player.position,
      playerVel: this.player.velocity,
      playerCenter,
      rng: this.rng,
      shots: this.enemyShots,
      enemies: this.enemies,
      sharedContact: null
    });
    for (const s of this.enemyShots) {
      const bullet: EnemyBullet = {
        kind: 'enemy',
        pos: new THREE.Vector3(s.x, s.y, s.z),
        vel: new THREE.Vector3(s.vx, s.vy, s.vz),
        life: s.life,
        damage: s.damage,
        createdAt: s.createdAt
      };
      this.projectiles.push(bullet);
    }
    this.enemyTelegraph = this.enemies.some((e) => e.alive && e.telegraphing);

    // 4) player movement (the flight reserves the beam cost)
    const pendingBeam =
      this.player.weapon === 'beam' && this.input.mouseDown && this.player.canFire(now) && this.player.en >= 8 ? 8 : 0;
    const moveCtx = this.buildCtx(dt, now);
    this.player.moveStep(moveCtx, pendingBeam);

    // 5) camera + aim
    this.updateCamera();
    const aimCtx = this.buildCtx(dt, now);
    this.player.updateAim(aimCtx);

    // 6) firing
    if (this.input.mouseDown && this.player.weapon !== 'missile') {
      const rec = this.player.fire(now, aimCtx);
      if (rec) this.spawnPlayerProjectile(rec);
      else {
        const reason = this.player.refusalReason(now);
        if (reason === 'NOT ENOUGH EN' || reason === 'OUT OF AMMO') this.hud.notice(reason);
      }
    } else if (this.input.mouseDown && this.player.weapon === 'missile') {
      const rec = this.player.fire(now, aimCtx);
      if (rec) this.spawnPlayerProjectile(rec);
      else {
        const reason = this.player.refusalReason(now);
        if (reason) this.hud.notice(reason);
      }
    }

    // 7) flight energy is paid after the beam
    this.player.commitFlightEnergy(aimCtx);

    // 8) guard movement integration (with collision)
    this.moveEnemies(dt);

    // 9) sector tracking
    const zoneId = this.world.zoneAt(this.player.position.x, this.player.position.y, this.player.position.z);
    if (zoneId) {
      this.currentZone = zoneId;
      if (!this.visitedZones.includes(zoneId)) this.visitedZones.push(zoneId);
      this.world.visited.add(zoneId);
    }

    // 10) objectives
    this.updateObjectives(dt);

    // 11) clock
    this.elapsed += dt;
  }

  private buildCtx(dt: number, now: number) {
    const cameraDir = new THREE.Vector3();
    this.camera.getWorldDirection(cameraDir);
    const freeAimPoint = this.computeFreeAimPoint();
    const targets: FcsTargetInfo[] = this.enemies.map((e) => ({
      id: e.id,
      x: e.pos.x,
      y: e.pos.y,
      z: e.pos.z,
      vx: e.vel.x,
      vy: e.vel.y,
      vz: e.vel.z,
      alive: e.alive,
      radius: e.radius
    }));
    return {
      input: this.input,
      world: this.world,
      camera: this.camera,
      cameraPos: this.camera.position,
      cameraDir,
      freeAimPoint,
      targets,
      viewWidth: this.renderer.domElement.clientWidth || window.innerWidth,
      viewHeight: this.renderer.domElement.clientHeight || window.innerHeight,
      dt,
      now
    };
  }

  private computeFreeAimPoint(): THREE.Vector3 {
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    const origin = this.camera.position;
    const maxDist = 400;
    const hit = raycastWorld(this.world.hash, origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, maxDist);
    let dist = hit.hit ? hit.distance : maxDist;
    // the nearest enemy along the ray
    for (const e of this.enemies) {
      if (!e.alive) continue;
      const to = e.pos.clone().sub(origin);
      const along = to.dot(dir);
      if (along <= 0 || along > dist) continue;
      const perp = to.clone().sub(dir.clone().multiplyScalar(along)).length();
      if (perp <= e.radius) dist = along;
    }
    return origin.clone().addScaledVector(dir, dist);
  }

  private updateCamera(): void {
    const p = this.player;
    const yaw = p.yaw;
    const pitch = p.pitch;
    const dir = new THREE.Vector3(
      Math.sin(yaw) * Math.cos(pitch),
      Math.sin(pitch),
      Math.cos(yaw) * Math.cos(pitch)
    );
    const anchor = new THREE.Vector3(p.position.x, p.position.y + 1.72, p.position.z);
    const desired = anchor.clone().addScaledVector(dir, -PLAYER.cameraDistance);
    desired.y += 0.62;
    // slight over-the-shoulder offset so the mech does not block the sight line
    const right = new THREE.Vector3(-Math.cos(yaw), 0, Math.sin(yaw));
    desired.addScaledVector(right, 1.15);
    const toCam = desired.clone().sub(anchor);
    const len = toCam.length();
    if (len > 0.01) {
      const hit = raycastWorld(
        this.world.hash,
        anchor.x,
        anchor.y,
        anchor.z,
        toCam.x / len,
        toCam.y / len,
        toCam.z / len,
        len
      );
      if (hit.hit) {
        desired.copy(anchor).addScaledVector(toCam.clone().normalize(), Math.max(0.6, hit.distance - 0.25));
      }
    }
    this.camera.position.copy(desired);
    // the camera looks along -Z in its own frame, so the yaw is offset by pi
    this.camera.quaternion.setFromEuler(new THREE.Euler(pitch, yaw + Math.PI, 0, 'YXZ'));
  }

  private moveEnemies(dt: number): void {
    for (const e of this.enemies) {
      if (!e.alive || e.kind === 'turret') continue;
      const feetY = e.pos.y - e.spec.height / 2;
      const res = moveAabb(
        this.world.hash,
        e.pos.x,
        feetY + e.spec.height / 2,
        e.pos.z,
        e.spec.radius,
        e.spec.height / 2,
        e.spec.radius,
        e.vel.x,
        0,
        e.vel.z,
        dt,
        this.scratch
      );
      e.pos.x = res.x;
      e.pos.z = res.z;
      e.vel.x = res.vx;
      e.vel.z = res.vz;
    }
  }

  /* ------------------------------------------------------------------ */
  /* damage & objectives                                                */
  /* ------------------------------------------------------------------ */

  private damageEnemy(e: Enemy, dmg: number): void {
    if (!e.alive) return;
    e.hp -= dmg;
    e.alert = true;
    if (e.hp <= 0) {
      e.hp = 0;
      e.alive = false;
      this.spawnExplosion(e.pos.x, e.pos.y, e.pos.z);
      const model = this.enemyModels.get(e.id);
      if (model) {
        this.scene.remove(model);
        this.enemyModels.delete(e.id);
      }
      if (e.isGateControl) {
        this.controlsDestroyed++;
        const spec = BARRIERS.find((b) => b.controlEnemyId === e.id);
        if (spec) {
          this.world.openBarrier(spec.id);
          if (!this.openBarrierIds.includes(spec.id)) this.openBarrierIds.push(spec.id);
          this.hud.notice(`${spec.label} opened`);
        }
        if (this.controlsDestroyed >= BARRIERS.length) {
          this.world.openFinalGate();
          this.gateOpen = true;
          this.hud.notice('FINAL EVACUATION GATE OPENED');
        }
      }
    }
  }

  private damagePlayer(dmg: number, sx: number, sy: number, sz: number): void {
    if (this.state !== 'playing') return;
    this.player.hp -= dmg;
    const dir = new THREE.Vector3(sx - this.player.position.x, 0, sz - this.player.position.z);
    const camDir = new THREE.Vector3();
    this.camera.getWorldDirection(camDir);
    const camRight = new THREE.Vector3(camDir.z, 0, -camRightSafe(camDir));
    camRight.normalize();
    const forward = new THREE.Vector3(camDir.x, 0, camDir.z);
    forward.normalize();
    const angle = Math.atan2(dir.dot(camRight), dir.dot(forward));
    this.damageMarks.push({ angle, life: 1 });
    if (this.player.hp <= 0) {
      this.player.hp = 0;
      this.fail('Armor integrity lost');
    }
  }

  private updateObjectives(dt: number): void {
    for (const m of this.damageMarks) m.life -= dt * 1.4;
    this.damageMarks = this.damageMarks.filter((m) => m.life > 0);

    // falling out of the world
    if (this.player.position.y < -60) {
      this.fail('Fell out of the plant');
      return;
    }
    // the clear condition
    if (
      this.gateOpen &&
      this.currentZone === CLEAR_POINT.zone &&
      Math.hypot(this.player.position.x - CLEAR_POINT.x, this.player.position.z - CLEAR_POINT.z) < 14 &&
      Math.abs(this.player.position.y - 24) < 8
    ) {
      this.cleared = true;
      this.setState('cleared');
      this.onResult?.(true, this.resultStats());
    }
  }

  private fail(reason: string): void {
    if (this.failed || this.cleared) return;
    this.failed = true;
    this.failureReason = reason;
    this.setState('failed');
    this.onResult?.(false, `${reason} / ${this.resultStats()}`);
  }

  private resultStats(): string {
    return `Elapsed ${this.elapsed.toFixed(1)} s / destroyed ${this.enemies.filter((e) => !e.alive).length} / control turrets ${this.controlsDestroyed}/6`;
  }

  /* ------------------------------------------------------------------ */
  /* projectiles & effects                                               */
  /* ------------------------------------------------------------------ */

  private spawnPlayerProjectile(rec: ShotRecord): void {
    if (!rec) return;
    if (!rec) return;
    if (rec.weapon === 'machinegun') {
      const b: MachinegunBullet = {
        kind: 'machinegun',
        ox: rec.muzzlePosition[0],
        oy: rec.muzzlePosition[1],
        oz: rec.muzzlePosition[2],
        vx: rec.initialVelocity![0],
        vy: rec.initialVelocity![1],
        vz: rec.initialVelocity![2],
        age: 0,
        life: SOLVER.mgLife,
        createdAt: rec.firedAtSeconds
      };
      this.projectiles.push(b);
    } else if (rec.weapon === 'missile') {
      const m: Missile = {
        kind: 'missile',
        pos: new THREE.Vector3(rec.muzzlePosition[0], rec.muzzlePosition[1], rec.muzzlePosition[2]),
        vel: new THREE.Vector3(rec.initialVelocity![0], rec.initialVelocity![1], rec.initialVelocity![2]),
        targetId: rec.targetId,
        obsPos: rec.targetPositionAtFire
          ? new THREE.Vector3(rec.targetPositionAtFire[0], rec.targetPositionAtFire[1], rec.targetPositionAtFire[2])
          : null,
        obsVel: rec.targetVelocityAtFire
          ? new THREE.Vector3(rec.targetVelocityAtFire[0], rec.targetVelocityAtFire[1], rec.targetVelocityAtFire[2])
          : null,
        age: 0,
        life: SOLVER.missileLife,
        createdAt: rec.firedAtSeconds
      };
      this.projectiles.push(m);
    } else {
      // beam : draw a beam trace
      const dir = new THREE.Vector3(rec.launchDirection[0], rec.launchDirection[1], rec.launchDirection[2]);
      const target = rec.weapon === 'beam' ? this.beamEndPoint(rec) : null;
      const len = target ? target.distanceTo(new THREE.Vector3(...rec.muzzlePosition)) : 120;
      const geo = new THREE.CylinderGeometry(0.09, 0.16, len, 8, 1, true);
      geo.rotateX(Math.PI / 2);
      geo.translate(0, 0, len / 2);
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x8ef0ff, transparent: true, opacity: 0.9 }));
      mesh.position.set(rec.muzzlePosition[0], rec.muzzlePosition[1], rec.muzzlePosition[2]);
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
      this.scene.add(mesh);
      this.effects.push({ mesh, life: 0.18, maxLife: 0.18, kind: 'beam' });
      this.applyBeamDamage(rec);
    }
  }

  private beamEndPoint(rec: ShotRecord): THREE.Vector3 | null {
    const origin = new THREE.Vector3(...rec.muzzlePosition);
    const dir = new THREE.Vector3(...rec.launchDirection);
    const hit = raycastWorld(this.world.hash, origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, SOLVER.beamRange);
    let dist = hit.hit ? hit.distance : SOLVER.beamRange;
    for (const e of this.enemies) {
      if (!e.alive) continue;
      const to = e.pos.clone().sub(origin);
      const along = to.dot(dir);
      if (along <= 0 || along > dist) continue;
      const perp = to.clone().sub(dir.clone().multiplyScalar(along)).length();
      if (perp <= e.radius) dist = along;
    }
    return origin.clone().addScaledVector(dir, dist);
  }

  private applyBeamDamage(rec: ShotRecord): void {
    const origin = new THREE.Vector3(...rec.muzzlePosition);
    const dir = new THREE.Vector3(...rec.launchDirection);
    const hit = raycastWorld(this.world.hash, origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, SOLVER.beamRange);
    let dist = hit.hit ? hit.distance : SOLVER.beamRange;
    let target: Enemy | null = null;
    for (const e of this.enemies) {
      if (!e.alive) continue;
      const to = e.pos.clone().sub(origin);
      const along = to.dot(dir);
      if (along <= 0 || along > dist) continue;
      const perp = to.clone().sub(dir.clone().multiplyScalar(along)).length();
      if (perp <= e.radius) {
        dist = along;
        target = e;
      }
    }
    if (target) this.damageEnemy(target, WEAPON_LIST.find((w) => w.id === 'beam')!.damage);
  }

  private syncProjectileModels(): void {
    const seen = new Set<Projectile>();
    for (const p of this.projectiles) {
      seen.add(p);
      let mesh = this.projectileModels.get(p);
      if (!mesh) {
        if (p.kind === 'machinegun') {
          mesh = new THREE.Mesh(this.projectileGeo, this.bulletMat);
        } else if (p.kind === 'missile') {
          mesh = new THREE.Mesh(this.missileGeo, this.missileMat);
        } else {
          mesh = new THREE.Mesh(this.projectileGeo, this.enemyBulletMat);
        }
        this.scene.add(mesh);
        this.projectileModels.set(p, mesh);
      }
      if (p.kind === 'machinegun') {
        const a = p.age;
        mesh.position.set(
          p.ox + p.vx * a,
          p.oy + p.vy * a - 0.5 * SOLVER.mgGravity * a * a,
          p.oz + p.vz * a
        );
      } else {
        mesh.position.copy(p.pos);
        if (p.kind === 'missile') {
          const d = p.vel.clone().normalize();
          mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d);
        }
      }
    }
    for (const [p, mesh] of Array.from(this.projectileModels)) {
      if (!seen.has(p)) {
        this.scene.remove(mesh);
        this.projectileModels.delete(p);
      }
    }
  }

  private spawnImpact(x: number, y: number, z: number, nx: number, ny: number, nz: number, friendly: boolean): void {
    const geo = new THREE.SphereGeometry(0.28, 8, 6);
    const mat = new THREE.MeshBasicMaterial({ color: friendly ? 0xffd070 : 0xff6040, transparent: true, opacity: 0.95 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x + nx * 0.1, y + ny * 0.1, z + nz * 0.1);
    this.scene.add(mesh);
    this.effects.push({ mesh, life: 0.22, maxLife: 0.22, kind: 'impact' });
  }

  private spawnExplosion(x: number, y: number, z: number): void {
    const geo = new THREE.SphereGeometry(0.9, 12, 10);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0.9 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    this.scene.add(mesh);
    this.effects.push({ mesh, life: 0.4, maxLife: 0.4, kind: 'explosion' });
  }

  private updateVisuals(dt: number): void {
    // effects
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const e = this.effects[i];
      e.life -= dt;
      const t = Math.max(0, e.life / e.maxLife);
      const m = e.mesh as THREE.Mesh;
      (m.material as THREE.MeshBasicMaterial).opacity = t;
      if (e.kind === 'explosion') m.scale.setScalar(1 + (1 - t) * 2.2);
      if (e.kind === 'impact') m.scale.setScalar(0.6 + (1 - t) * 1.4);
      if (e.life <= 0) {
        this.scene.remove(e.mesh);
        const em = e.mesh as THREE.Mesh;
        em.geometry.dispose();
        const emat = em.material as THREE.Material | THREE.Material[];
        if (Array.isArray(emat)) emat.forEach((mm) => mm.dispose());
        else emat.dispose();
        this.effects.splice(i, 1);
      }
    }

    // mech animation
    this.animateMech(dt);

    // enemy models
    for (const e of this.enemies) {
      const model = this.enemyModels.get(e.id);
      if (!model) continue;
      if (e.kind === 'turret') {
        model.position.set(e.pos.x, e.pos.y - e.spec.height / 2, e.pos.z);
        model.rotation.y = e.yaw;
        const head = model.children[2] as THREE.Group;
        if (head) {
          const d = this.player.position.clone().sub(e.pos);
          head.rotation.y = Math.atan2(d.x, d.z) - e.yaw;
          head.rotation.x = Math.atan2(d.y, Math.hypot(d.x, d.z));
        }
        const glow = e.telegraphing ? 1 : 0;
        const eye = this.enemyLamp(e);
        if (eye) {
          const mat = eye.material as THREE.MeshStandardMaterial;
          mat.emissiveIntensity = glow ? 5 : 1;
          mat.emissive.setHex(glow ? 0xffaa22 : 0x220000);
          mat.color.setHex(glow ? 0xffe066 : 0xff4d4d);
        }
      } else {
        model.position.set(e.pos.x, e.pos.y - e.spec.height / 2, e.pos.z);
        model.rotation.y = e.yaw;
        const speed = Math.hypot(e.vel.x, e.vel.z);
        const legs = model.children.slice(-2) as THREE.Group[];
        legs.forEach((leg, i) => {
          leg.rotation.x = Math.sin(this.player.walkPhase * 3 + i * Math.PI) * 0.5 * Math.min(1, speed / 6);
        });
        const lamp = this.enemyLamp(e);
        if (lamp) {
          const mat = lamp.material as THREE.MeshStandardMaterial;
          mat.emissive.setHex(e.telegraphing ? 0xffaa22 : 0x220000);
          mat.emissiveIntensity = e.telegraphing ? 5 : 1;
          mat.color.setHex(e.telegraphing ? 0xffe066 : 0x552222);
        }
      }
    }
  }

  private animateMech(dt: number): void {
    const rig = this.player.rig;
    rig.root.position.copy(this.player.position);
    rig.root.rotation.y = this.player.yaw;
    const speed = Math.hypot(this.player.velocity.x, this.player.velocity.z);
    this.player.walkPhase += speed * dt * 2.4;
    const amp = Math.min(1, speed / 8) * 0.55;
    rig.legPivots.forEach((leg, i) => {
      const phase = this.player.walkPhase + (i % 2 === 0 ? 0 : Math.PI) + (i >= 2 ? Math.PI * 0.5 : 0);
      leg.rotation.x = Math.sin(phase) * amp;
    });
    // thruster glow while boosting / flying
    const active = this.player.qbImpulseRemainingSeconds > 0 || this.player.verticalMode === 'flying';
    for (const t of rig.thrusters) {
      const mat = t.material as THREE.MeshStandardMaterial;
      mat.emissive = mat.emissive ?? new THREE.Color();
      mat.emissive.setHex(active ? 0xff7a2a : 0x000000);
    }
  }

  private ensureEnemyModel(e: Enemy): void {
    if (this.enemyModels.has(e.id)) return;
    const model = e.kind === 'turret' ? buildTurret().root : buildGuard().root;
    model.position.set(e.pos.x, e.pos.y - e.spec.height / 2, e.pos.z);
    this.scene.add(model);
    this.enemyModels.set(e.id, model);
  }

  /** the telegraph lamp of a hostile (null for models without one) */
  private enemyLamp(e: Enemy): THREE.Mesh | null {
    const model = this.enemyModels.get(e.id);
    if (!model) return null;
    if (e.kind === 'turret') {
      const head = model.children[2] as THREE.Group | undefined;
      const eye = head?.children[2] as THREE.Mesh | undefined;
      return eye ?? null;
    }
    const lamp = model.children.find((c) => c.type === 'Mesh' && (c as THREE.Mesh).geometry.type === 'SphereGeometry');
    return (lamp as THREE.Mesh) ?? null;
  }

  /* ------------------------------------------------------------------ */
  /* HUD                                                                 */
  /* ------------------------------------------------------------------ */

  private updateHud(): void {
    const p = this.player;
    const fc = p.fireControl;
    const w = window.innerWidth;
    const h = window.innerHeight;

    const project = (x: number, y: number, z: number) => {
      const v = new THREE.Vector3(x, y, z);
      v.project(this.camera);
      if (v.z < -1 || v.z > 1) return null;
      return { x: (v.x * 0.5 + 0.5) * w, y: (1 - (v.y * 0.5 + 0.5)) * h };
    };

    const locked = p.lockedTarget();
    const targetPoint = locked ? project(locked.x, locked.y, locked.z) : null;
    const aimPoint =
      fc.aimPoint && fc.status !== 'inactive' ? project(fc.aimPoint[0], fc.aimPoint[1], fc.aimPoint[2]) : null;

    const beamSpec = WEAPON_LIST.find((x) => x.id === 'beam')!;
    const ammoLabel =
      p.weapon === 'beam' ? 'UNLIMITED' : p.weapon === 'missile' ? `${p.ammo.missile} rounds` : `${p.ammo.machinegun} rounds`;

    const zoneName = this.currentZone ? ZONE_BY_ID.get(this.currentZone)?.name ?? '-' : '-';

    this.hud.update(
      {
        weapon: p.weapon,
        weaponLabel: '',
        ammo: p.weapon === 'missile' ? p.ammo.missile : p.ammo.machinegun,
        ammoLabel,
        beamEnCost: beamSpec.enCost,
        en: p.en,
        maxEn: p.maxEn,
        hp: p.hp,
        maxHp: PLAYER.maxHp,
        horizontalMode: p.horizontalMode,
        verticalMode: p.verticalMode,
        glideEnabled: p.glideEnabled,
        qbReady: p.qbCooldownRemainingSeconds <= 0 && p.en >= PLAYER.qbEnCost,
        qbCooldown: p.qbCooldownRemainingSeconds,
        qbCost: PLAYER.qbEnCost,
        lockState: p.fcs.state,
        lockProgress: p.fcs.progress,
        lockRadiusPx: p.fcs.radiusCssPx,
        lockTargetLabel: locked ? locked.id : null,
        solutionStatus: fc.status,
        aimPointScreen: aimPoint,
        targetPointScreen: targetPoint,
        targetOffscreen: !targetPoint && !!locked,
        sectorName: zoneName,
        objectiveText: this.objectiveText(),
        controlsDestroyed: this.controlsDestroyed,
        controlsRequired: BARRIERS.length,
        barrierText: this.barrierText(),
        gateOpen: this.gateOpen,
        elapsed: this.elapsed,
        fps: this.fps,
        telegraphActive: this.enemyTelegraph,
        damageMarks: this.damageMarks,
        notices: [],
        lockSeconds: p.lockSeconds,
        regenPerSecond: p.regenPerSecond,
        speedMultiplier: p.speedMultiplier,
        maxEnEffective: p.maxEn
      },
      this.elapsed
    );
  }

  private objectiveText(): string {
    if (this.gateOpen) return 'Evacuation gate open - reach the evacuation zone';
    const next = BARRIERS.find((b) => !this.openBarrierIds.includes(b.id));
    if (next) return `Destroy the control turret to open ${next.label}`;
    return 'Destroy the next control turret';
  }

  private barrierText(): string {
    const open = BARRIERS.filter((b) => this.openBarrierIds.includes(b.id)).map((b) => b.id);
    return open.length ? `OPEN BARRIERS: ${open.join(', ')}` : 'OPEN BARRIERS: none';
  }

  /* ------------------------------------------------------------------ */
  /* garage                                                              */
  /* ------------------------------------------------------------------ */

  private garageMech: THREE.Object3D | null = null;
  private garageAngle = 0;

  setGarageMech(rig: THREE.Object3D): void {
    if (this.garageMech) this.garageScene.remove(this.garageMech);
    this.garageMech = rig;
    this.garageScene.add(rig);
  }

  private updateGarage(dt: number): void {
    this.garageAngle += dt * 0.45;
    if (this.garageMech) {
      this.garageMech.position.y = 0;
      this.garageMech.rotation.y = this.garageAngle;
      const legs = this.garageMech.children[0]?.children.filter((c) => c.type === 'Group') ?? [];
      void legs;
    }
    this.garageCamera.lookAt(0, 1.05, 0);
  }

  renderGarage(viewWidth: number, viewHeight: number): void {
    this.garageCamera.aspect = viewWidth / Math.max(1, viewHeight);
    this.garageCamera.updateProjectionMatrix();
    this.renderer.setSize(viewWidth, viewHeight, false);
    this.renderer.render(this.garageScene, this.garageCamera);
  }

  resize(): void {
    this.camera.aspect = window.innerWidth / Math.max(1, window.innerHeight);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
  }

  render(): void {
    if (this.state === 'garage') {
      this.renderGarage(window.innerWidth, window.innerHeight);
      return;
    }
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.render(this.scene, this.camera);
  }

  /* ------------------------------------------------------------------ */
  /* snapshot API                                                        */
  /* ------------------------------------------------------------------ */

  getSnapshot() {
    const p = this.player;
    const fc = p.fireControl;
    const locked = p.lockedTarget();
    return {
      version: VERSION,
      seed: this.seed,
      state: this.state,
      elapsedSeconds: this.elapsed,
      loadout: {
        fcs: p.loadout.fcs,
        generator: p.loadout.generator,
        legs: p.loadout.legs
      },
      player: {
        position: [p.position.x, p.position.y, p.position.z] as [number, number, number],
        velocity: [p.velocity.x, p.velocity.y, p.velocity.z] as [number, number, number],
        grounded: p.grounded,
        hp: p.hp,
        en: p.en,
        weapon: p.weapon,
        ammo: { machinegun: p.ammo.machinegun, missile: p.ammo.missile },
        movement: {
          horizontalMode: p.horizontalMode,
          verticalMode: p.verticalMode,
          glideEnabled: p.glideEnabled,
          desiredHorizontalDirection: [p.desiredHorizontalDirection.x, p.desiredHorizontalDirection.y] as [number, number],
          qbSuccessfulCount: p.qbSuccessfulCount,
          qbLastStartedAtSeconds: p.qbLastStartedAtSeconds,
          qbImpulseRemainingSeconds: p.qbImpulseRemainingSeconds,
          qbCooldownRemainingSeconds: p.qbCooldownRemainingSeconds,
          lastEnSpentAtSeconds: p.lastEnSpentAtSeconds
        }
      },
      effectiveStats: {
        maxEn: p.maxEn,
        regenPerSecond: p.regenPerSecond,
        lockSeconds: p.lockSeconds,
        horizontalSpeedMultiplier: p.speedMultiplier
      },
      lock: {
        state: p.fcs.state,
        targetId: p.fcs.targetId,
        progress: p.fcs.progress,
        radiusCssPx: p.fcs.radiusCssPx
      },
      fireControl: {
        status: fc.status,
        weapon: fc.weapon,
        targetId: fc.targetId,
        evaluatedAtSeconds: fc.evaluatedAtSeconds,
        muzzlePosition: fc.muzzlePosition,
        targetPosition: fc.targetPosition,
        targetVelocity: fc.targetVelocity,
        launchDirection: fc.launchDirection,
        predictedFlightSeconds: fc.predictedFlightSeconds,
        predictedInterceptPosition: fc.predictedInterceptPosition,
        aimPoint: fc.aimPoint,
        residualMeters: fc.residualMeters
      },
      recentPlayerShots: p.recentShots.map((s) => ({
        id: s.id,
        firedAtSeconds: s.firedAtSeconds,
        weapon: s.weapon,
        targetId: s.targetId,
        solutionStatus: s.solutionStatus,
        muzzlePosition: [...s.muzzlePosition] as [number, number, number],
        targetPositionAtFire: s.targetPositionAtFire ? ([...s.targetPositionAtFire] as [number, number, number]) : null,
        targetVelocityAtFire: s.targetVelocityAtFire ? ([...s.targetVelocityAtFire] as [number, number, number]) : null,
        launchDirection: [...s.launchDirection] as [number, number, number],
        initialVelocity: s.initialVelocity ? ([...s.initialVelocity] as [number, number, number]) : null,
        accelerationAtFire: [...s.accelerationAtFire] as [number, number, number],
        predictedFlightSeconds: s.predictedFlightSeconds,
        predictedInterceptPosition: s.predictedInterceptPosition
          ? ([...s.predictedInterceptPosition] as [number, number, number])
          : null
      })),
      enemies: this.enemies.map((e) => ({
        id: e.id,
        kind: e.kind,
        isGateControl: e.isGateControl,
        sectorId: e.zoneId,
        position: [e.pos.x, e.pos.y, e.pos.z] as [number, number, number],
        velocity: [e.vel.x, e.vel.y, e.vel.z] as [number, number, number],
        hp: e.hp,
        alive: e.alive,
        alert: e.alert,
        hasLineOfSight: e.hasLos,
        shotsFired: e.shotsFired,
        lastShotAtSeconds: e.lastShotAt
      })),
      objective: {
        controlsDestroyed: this.controlsDestroyed,
        controlsRequired: BARRIERS.length,
        openBarrierIds: [...this.openBarrierIds],
        gateOpen: this.gateOpen
      },
      stage: {
        sectorCount: ZONES.length,
        currentSectorId: this.currentZone,
        visitedSectorIds: [...this.visitedZones],
        totalEnemies: this.enemies.length
      }
    };
  }
}

function camRightSafe(dir: THREE.Vector3): number {
  return dir.x;
}
