// Three.js の描画統括：出撃中のシーンと格納庫シーン。
import * as THREE from 'three';
import { CAMERA, type LegsId } from '../config';
import type { SimEvent } from '../sim/enemies';
import type { Game } from '../sim/game';
import { playerMuzzle } from '../sim/weapons';
import { Effects } from './effects';
import { EnemyView } from './enemyMesh';
import { MechView } from './mech';
import { StageView } from './stageMesh';
import { textures } from './textures';

export class GameRenderer {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  garageScene = new THREE.Scene();
  garageCamera: THREE.PerspectiveCamera;
  private stage: StageView;
  mech: MechView;
  garageMech: MechView;
  private enemies: EnemyView[] = [];
  effects: Effects;
  private game: Game;
  private garageTurn = 0;
  private boostTimer = 0;

  constructor(canvas: HTMLCanvasElement, game: Game) {
    this.game = game;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;

    // 出撃シーン
    this.scene.background = new THREE.Color(0x283038);
    this.scene.fog = new THREE.Fog(0x283038, 130, 560);
    this.scene.add(new THREE.HemisphereLight(0xd6e2ff, 0x8a7c6c, 2.4));
    const sun = new THREE.DirectionalLight(0xfff0dc, 1.5);
    sun.position.set(0.4, 1, 0.25);
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0xbcd4ff, 0.8);
    fill.position.set(-0.5, 0.5, -0.7);
    this.scene.add(fill);
    this.scene.add(new THREE.AmbientLight(0x505866, 0.8));
    this.camera = new THREE.PerspectiveCamera(CAMERA.fovDeg, 16 / 9, CAMERA.near, CAMERA.far);
    this.camera.rotation.order = 'YXZ';

    this.stage = new StageView(game.stage, this.scene);
    this.stage.addBarriers(game.barriers);
    this.mech = new MechView(game.loadout.legs);
    this.scene.add(this.mech.root);
    for (const e of game.enemies.enemies) {
      const v = new EnemyView(e);
      this.enemies.push(v);
      this.scene.add(v.root);
    }
    this.effects = new Effects(this.scene);

    // 格納庫シーン
    this.garageScene.background = new THREE.Color(0x14181e);
    this.garageScene.fog = new THREE.Fog(0x14181e, 18, 60);
    this.garageScene.add(new THREE.HemisphereLight(0xdde6ff, 0x302820, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(-3, 6, -6);
    this.garageScene.add(key);
    const rim = new THREE.DirectionalLight(0x6fc8ff, 1.4);
    rim.position.set(4, 3, 5);
    this.garageScene.add(rim);
    const tx = textures();
    const floorTex = tx.hazard.clone();
    floorTex.repeat.set(1, 1);
    const floor = new THREE.Mesh(
      new THREE.CylinderGeometry(3.2, 3.4, 0.3, 48),
      new THREE.MeshStandardMaterial({ color: 0x3a4048, map: tx.grate, roughness: 0.6, metalness: 0.6 }),
    );
    floor.position.y = -0.15;
    this.garageScene.add(floor);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(3.3, 0.08, 8, 64), new THREE.MeshBasicMaterial({ color: 0xffb020, toneMapped: false }));
    ring.rotation.x = Math.PI / 2;
    this.garageScene.add(ring);
    const hangarFloor = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.MeshStandardMaterial({ color: 0x2c3036, map: tx.concrete, roughness: 0.9 }));
    hangarFloor.rotation.x = -Math.PI / 2;
    hangarFloor.position.y = -0.3;
    this.garageScene.add(hangarFloor);
    for (const x of [-7, 7]) {
      const gantry = new THREE.Mesh(new THREE.BoxGeometry(0.6, 9, 0.6), new THREE.MeshStandardMaterial({ color: 0x505860, map: tx.panel, metalness: 0.6, roughness: 0.5 }));
      gantry.position.set(x, 4.2, 2);
      this.garageScene.add(gantry);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(14.6, 0.6, 0.6), new THREE.MeshStandardMaterial({ color: 0x505860, metalness: 0.6, roughness: 0.5 }));
    beam.position.set(0, 8.7, 2);
    this.garageScene.add(beam);
    this.garageMech = new MechView(game.loadout.legs);
    this.garageScene.add(this.garageMech.root);
    this.garageCamera = new THREE.PerspectiveCamera(38, 16 / 9, 0.1, 200);
  }

  setLegs(legs: LegsId) {
    if (this.mech.legs !== legs) this.mech.setLegs(legs);
    if (this.garageMech.legs !== legs) this.garageMech.setLegs(legs);
  }

  resize(w: number, h: number) {
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.garageCamera.aspect = w / h;
    this.garageCamera.updateProjectionMatrix();
  }

  /** 新しい出撃のために描画側の一時オブジェクトを消去 */
  resetForSortie() {
    this.effects.clear();
    // 敵ビューを作り直す（撃破状態の見た目を初期化）
    for (const v of this.enemies) this.scene.remove(v.root);
    this.enemies = [];
    for (const e of this.game.enemies.enemies) {
      const v = new EnemyView(e);
      this.enemies.push(v);
      this.scene.add(v.root);
    }
  }

  handleEvents(events: SimEvent[]) {
    const V = (a: number[]) => new THREE.Vector3(a[0], a[1], a[2]);
    for (const ev of events) {
      switch (ev.type) {
        case 'impact':
          this.effects.impact(V(ev.pos), ev.kind);
          break;
        case 'beam':
          this.effects.beam(V(ev.from), V(ev.to));
          this.mech.kick();
          break;
        case 'enemyShot':
          this.effects.muzzle(V(ev.pos), ev.kind === 'turret' ? 0xff40a0 : 0xffa040, ev.kind === 'turret' ? 2.4 : 1.6);
          break;
        case 'enemyHit': {
          this.effects.hitEnemy(V(ev.pos), ev.damage >= 100);
          const v = this.enemies.find((x) => x.enemy.id === ev.id);
          v?.hit();
          break;
        }
        case 'enemyKilled':
          this.effects.explosion(V(ev.pos), ev.kind === 'turret' ? 1.6 : 1.2);
          break;
        case 'playerHit':
          this.effects.sparks(V(ev.from), 0xff6020, 8, 9, 0.4);
          break;
        case 'missileFired':
          this.effects.muzzle(V(ev.pos), 0xffa040, 2.2);
          this.mech.kick();
          break;
        case 'qb': {
          const p = this.game.player.pos;
          this.effects.boostBurst(new THREE.Vector3(p[0], p[1] + 1.8, p[2]), new THREE.Vector3(ev.dir[0], 0, ev.dir[1]));
          break;
        }
        default:
          break;
      }
    }
  }

  renderGame(frameDt: number, paused: boolean, firing: boolean) {
    const g = this.game;
    const p = g.player;
    const time = g.elapsedSeconds;
    // 機体
    this.mech.root.position.set(p.pos[0], p.pos[1], p.pos[2]);
    this.mech.root.rotation.y = g.yaw;
    const f = [-Math.sin(g.yaw), -Math.cos(g.yaw)];
    const r = [Math.cos(g.yaw), -Math.sin(g.yaw)];
    const localVel: [number, number] = [p.vel[0] * r[0] + p.vel[2] * r[1], p.vel[0] * f[0] + p.vel[2] * f[1]];
    this.mech.animate({
      localVel,
      speed: Math.hypot(p.vel[0], p.vel[2]),
      grounded: p.grounded,
      mode: p.horizontalMode,
      thrusting: p.thrusting,
      weapon: g.weapons.current,
      aimPitch: g.pitch,
      dt: paused ? 0 : frameDt,
      firing,
    });
    // ブースト残光
    if (!paused) {
      this.boostTimer -= frameDt;
      if ((p.horizontalMode === 'quickboost' || p.thrusting) && this.boostTimer <= 0) {
        this.boostTimer = 0.03;
        const back = new THREE.Vector3(p.pos[0] - f[0] * 1.3, p.pos[1] + 1.8, p.pos[2] - f[1] * 1.3);
        this.effects.trail(back, p.horizontalMode === 'quickboost' ? 0x9fe8ff : 0x5ab8ff, p.horizontalMode === 'quickboost' ? 1.3 : 0.8, 0.3);
      }
      if (firing && g.weapons.current === 'machinegun' && g.weapons.ammo.machinegun > 0) {
        const mz = playerMuzzle(p, g.yaw);
        if (Math.random() < 0.6) this.effects.muzzle(new THREE.Vector3(mz[0], mz[1], mz[2]), 0xffd070, 1.1);
      }
    }
    // 敵
    for (const v of this.enemies) v.update(time, paused ? 0 : frameDt);
    this.stage.update(time, this.mech.root.position);
    this.effects.update(paused ? 0 : frameDt, g.enemies.bullets, g.weapons.mgBullets, g.weapons.missiles, paused);
    // カメラ（シミュレーションと同じ位置・向き）
    const c = g.cam;
    this.camera.position.set(c.pos[0], c.pos[1], c.pos[2]);
    // 描画カメラはFCS判定の投影と完全に一致させる（揺れなし。被弾はHUDで表示）
    this.camera.rotation.set(g.pitch, g.yaw, 0, 'YXZ');
    this.renderer.render(this.scene, this.camera);
  }

  renderGarage(frameDt: number) {
    this.garageTurn += frameDt * 0.35;
    const a = Math.sin(this.garageTurn) * 0.55;
    this.garageMech.root.rotation.y = a;
    this.garageMech.animate({
      localVel: [0, 0],
      speed: 0,
      grounded: true,
      mode: 'walk',
      thrusting: false,
      weapon: this.game.startWeapon,
      aimPitch: -0.1,
      dt: frameDt,
      firing: false,
    });
    // 正面（-Z 側）から頭部を見る
    this.garageCamera.position.set(0.9, 3.2, -8.2);
    this.garageCamera.lookAt(0, 2.1, 0);
    this.renderer.render(this.garageScene, this.garageCamera);
  }
}
