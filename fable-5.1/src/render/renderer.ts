/**
 * GameRenderer: Three.js による全描画の統括。
 * シミュレーションのカメラ（SimCamera）が正で、毎フレーム位置・姿勢・視野角を写す。
 * 格納庫モードでは機体を正面から映す固定カメラ＋回転台に切り替える。
 */
import * as THREE from 'three';
import { CAMERA, SIM, PLAYER } from '../params';
import type { SimCamera } from '../sim/camera';
import type { EnemyView, LegsKind, PlayerView, ProjectileView, SimEvent, StageData, Vec3 } from '../types';
import { EffectsSystem } from './effects';
import { EnemySharedMaterials, createEnemyModel, type EnemyModel } from './enemyModels';
import { MaterialLibrary, disposeObject, standard } from './materials';
import { createPlayerMech, type MechModel } from './mech';
import { StageMeshes } from './stageMeshes';

export interface RenderFrame {
  dtReal: number;
  camera: SimCamera;
  player: PlayerView;
  enemies: EnemyView[];
  projectiles: ProjectileView[];
  missileTrails?: never;
  events: SimEvent[];
  time: number;
}

/** 廃工場の環境光（読みやすさを保つため暗すぎない） */
/** カメラが注視点にこれより近づいたら自機を非表示にする [m] */
const MECH_HIDE_CAMERA_DISTANCE = 1.6;
const HEMISPHERE_INTENSITY = 1.35;
const DIRECTIONAL_INTENSITY = 1.7;
const TONE_EXPOSURE = 1.5;
const FOG_COLOR = 0x1c2228;
const BACKGROUND_COLOR = 0x121619;
/** 歩行位相の進み [rad/m]（歩幅 ≈ 2.4 m） */
const WALK_PHASE_PER_METER = (Math.PI * 2) / 2.4;
/** 格納庫の回転台の角速度 [rad/s] */
const GARAGE_TURNTABLE_RATE = 0.45;

export class GameRenderer {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  private readonly container: HTMLElement;
  private readonly materials = new MaterialLibrary();
  private readonly enemyMaterials = new EnemySharedMaterials();
  private readonly effects = new EffectsSystem();
  private stage: StageMeshes | null = null;
  private mech: MechModel | null = null;
  private readonly enemies = new Map<string, EnemyModel>();
  private readonly hemi: THREE.HemisphereLight;
  private readonly sun: THREE.DirectionalLight;
  private readonly garage = new THREE.Group();
  private garageMode = false;
  private garageAngle = 0;
  private walkPhase = 0;
  private lastPlayerPos: Vec3 | null = null;
  /** 直前フレームの sim 時刻。進んでいなければ（一時停止・結果表示）効果・扉・歩行も進めない */
  private lastSimTime: number | null = null;
  /** 位置差分から求めた水平速度 [m/s]（sim が進まないフレームでは前回値を保持） */
  private lastMeasuredSpeed = 0;
  private garageLegs: LegsKind = 'biped';
  private readonly tmpVec = new THREE.Vector3();

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = TONE_EXPOSURE;
    this.renderer.shadowMap.enabled = false;
    const dpr = typeof window !== 'undefined' && window.devicePixelRatio ? Math.min(window.devicePixelRatio, 2) : 1;
    this.renderer.setPixelRatio(dpr);
    const w = Math.max(1, container.clientWidth || 1280);
    const h = Math.max(1, container.clientHeight || 720);
    this.renderer.setSize(w, h);
    const canvas = this.renderer.domElement;
    if (canvas && canvas.style) {
      canvas.style.display = 'block';
      canvas.style.width = '100%';
      canvas.style.height = '100%';
    }
    container.appendChild(canvas);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(BACKGROUND_COLOR);
    this.scene.fog = new THREE.Fog(FOG_COLOR, 90, 650);
    this.camera = new THREE.PerspectiveCamera(CAMERA.fovYDeg, w / h, CAMERA.near, CAMERA.far);
    this.camera.rotation.order = 'YXZ';
    this.scene.add(this.camera);

    this.hemi = new THREE.HemisphereLight(0xb8c8d8, 0x5a4a3c, HEMISPHERE_INTENSITY);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffe2c0, DIRECTIONAL_INTENSITY);
    this.sun.position.set(40, 80, 25);
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    // 逆方向からの弱い補助光: 主光源の陰になる壁面（−X/−Z 向き）が真っ黒にならないようにする
    const fill = new THREE.DirectionalLight(0xc8d4e0, DIRECTIONAL_INTENSITY * 0.45);
    fill.position.set(-40, 60, -25);
    this.scene.add(fill);
    this.scene.add(fill.target);

    this.scene.add(this.effects.root);
    this.buildGarage();
    this.scene.add(this.garage);
    this.garage.visible = false;
    this.setPlayerLoadout('biped');
  }

  /** 格納庫の背景（回転台・照明・背板） */
  private buildGarage(): void {
    const g = this.garage;
    g.name = 'garage';
    const floorMat = standard(0x2a2e33, 0.8, 0.4);
    const padMat = standard(0x3c434a, 0.5, 0.7, 0x203040, 0.3);
    const wallMat = standard(0x1c2024, 0.9, 0.2);
    const stripeMat = standard(0xd9a400, 0.7, 0.2, 0x604000, 0.4);
    const floor = new THREE.Mesh(new THREE.CylinderGeometry(9, 9, 0.3, 32), floorMat);
    floor.position.y = -0.3;
    g.add(floor);
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.6, 0.16, 32), padMat);
    pad.position.y = -0.08;
    g.add(pad);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(2.7, 0.06, 6, 40), stripeMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.02;
    g.add(ring);
    const wall = new THREE.Mesh(new THREE.BoxGeometry(18, 8, 0.4), wallMat);
    wall.position.set(0, 3.6, 5.5);
    g.add(wall);
    for (const x of [-4, 4]) {
      const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.6, 8, 0.6), wallMat);
      pillar.position.set(x, 3.6, 5.0);
      g.add(pillar);
    }
    const keyLight = new THREE.PointLight(0xfff0e0, 60, 30, 2);
    keyLight.position.set(3, 5, -5);
    g.add(keyLight);
    const fillLight = new THREE.PointLight(0x80b0ff, 25, 30, 2);
    fillLight.position.set(-4, 3, -3);
    g.add(fillLight);
  }

  // -------------------------------------------------------------------------
  // 契約 API
  // -------------------------------------------------------------------------

  setStage(data: StageData): void {
    if (this.stage && this.stage.data === data) return;
    if (this.stage) {
      this.stage.dispose();
      this.stage = null;
    }
    for (const e of this.enemies.values()) e.dispose();
    this.enemies.clear();
    this.stage = new StageMeshes(data, this.materials);
    this.stage.root.visible = !this.garageMode;
    this.scene.add(this.stage.root);
  }

  setBarrierOpen(id: string, open: boolean): void {
    this.stage?.setBarrierOpen(id, open);
  }

  setGateOpen(open: boolean): void {
    this.stage?.setGateOpen(open);
  }

  setPlayerLoadout(legs: LegsKind): void {
    this.garageLegs = legs;
    if (this.mech && this.mech.legs === legs) return;
    if (this.mech) this.mech.dispose();
    this.mech = createPlayerMech(legs);
    this.scene.add(this.mech.root);
    if (this.garageMode) this.placeMechInGarage();
  }

  /** 再出撃時に前回の出撃の一時エフェクトと歩行状態を破棄する（格納庫を経由しない再出撃でも呼ぶ） */
  resetRun(): void {
    this.effects.clear();
    this.walkPhase = 0;
    this.lastPlayerPos = null;
    this.lastSimTime = null;
    this.lastMeasuredSpeed = 0;
  }

  setGarageMode(on: boolean): void {
    if (this.garageMode === on) return;
    this.garageMode = on;
    this.garage.visible = on;
    if (this.stage) this.stage.root.visible = !on;
    this.effects.root.visible = !on;
    for (const e of this.enemies.values()) e.root.visible = !on;
    if (on) {
      this.effects.clear();
      this.placeMechInGarage();
      this.scene.fog = null;
    } else {
      this.scene.fog = new THREE.Fog(FOG_COLOR, 90, 650);
      this.walkPhase = 0;
      this.lastPlayerPos = null;
      this.lastSimTime = null;
      this.lastMeasuredSpeed = 0;
    }
  }

  private placeMechInGarage(): void {
    if (!this.mech) return;
    this.mech.root.position.set(0, 0, 0);
    this.mech.root.rotation.set(0, this.garageAngle, 0);
    // 正面（−Z 側）からコアラの顔を見る固定カメラ
    this.camera.position.set(0, 2.1, -6.2);
    this.camera.lookAt(0, 1.7, 0);
    this.camera.fov = 45;
    this.camera.updateProjectionMatrix();
  }

  update(frame: RenderFrame): void {
    // 実時間は sim と同じ上限で切り詰める（長いフレームでも視覚タイマーが sim より遅れない）
    const dtReal = Math.min(Math.max(0, Number.isFinite(frame.dtReal) ? frame.dtReal : 0), SIM.maxFrameSeconds);
    if (this.garageMode) {
      this.updateGarage(dtReal);
      this.renderer.render(this.scene, this.camera);
      return;
    }
    // 視覚タイマーは sim 時刻の進みに同期する: 一時停止・結果表示で sim が止まれば効果・扉・煙も止まる。
    // 初回（sim 時刻が未知）と再出撃で時刻が巻き戻った場合は 0（巻き戻り）または実時間（初回）
    const simDt = this.lastSimTime === null ? dtReal : Math.min(Math.max(0, frame.time - this.lastSimTime), SIM.maxFrameSeconds);
    this.lastSimTime = frame.time;
    this.syncCamera(frame.camera);
    this.syncPlayer(frame.player, simDt);
    this.syncEnemies(frame.enemies, frame.time, simDt);
    for (const e of frame.events) this.effects.handleEvent(e, (id) => this.barrierCenter(id));
    this.effects.update(simDt, frame.projectiles);
    this.stage?.update(simDt);
    this.renderer.render(this.scene, this.camera);
  }

  private updateGarage(dt: number): void {
    this.garageAngle += dt * GARAGE_TURNTABLE_RATE;
    if (this.garageAngle > Math.PI * 2) this.garageAngle -= Math.PI * 2;
    if (!this.mech) return;
    // 回転台: 正面を基準に緩やかに回す（顔が見える時間を長く）
    const sway = Math.sin(this.garageAngle) * 0.9;
    this.mech.update({
      aimDirection: [0, 0, -1],
      yaw: sway,
      walkPhase: 0,
      speed: 0,
      boosting: false,
      thrusting: false,
      grounded: true,
      weapon: 'machinegun',
      gliding: false,
      alive: true,
    });
    this.mech.root.position.set(0, 0, 0);
    this.camera.position.set(0, 2.1, -6.2);
    this.camera.lookAt(0, 1.7, 0);
    if (this.camera.fov !== 45) {
      this.camera.fov = 45;
      this.camera.updateProjectionMatrix();
    }
  }

  private syncCamera(sim: SimCamera): void {
    const c = this.camera;
    c.position.set(sim.position[0], sim.position[1], sim.position[2]);
    c.rotation.set(sim.pitch, sim.yaw, 0, 'YXZ');
    let dirty = false;
    if (c.fov !== sim.fovYDeg) {
      c.fov = sim.fovYDeg;
      dirty = true;
    }
    if (Math.abs(c.aspect - sim.aspect) > 1e-6) {
      c.aspect = sim.aspect;
      dirty = true;
    }
    if (dirty) c.updateProjectionMatrix();
  }

  private syncPlayer(p: PlayerView, dt: number): void {
    if (!this.mech || this.mech.legs !== p.legs) this.setPlayerLoadout(p.legs);
    const mech = this.mech;
    if (!mech) return;
    mech.root.position.set(p.position[0], p.position[1], p.position[2]);
    // 壁を背にしてカメラが機体に密着したときは機体を非表示にして視界を確保する
    const camDist = Math.hypot(
      this.camera.position.x - (p.position[0] + PLAYER.cameraPivotOffset[0]),
      this.camera.position.y - (p.position[1] + PLAYER.cameraPivotOffset[1]),
      this.camera.position.z - (p.position[2] + PLAYER.cameraPivotOffset[2]),
    );
    mech.root.visible = this.garageMode || camDist > MECH_HIDE_CAMERA_DISTANCE;
    // 歩行の位相と速度はどちらも実際の位置差分から求める（壁に押し付けて velocity>0 でも位置が動かなければ歩かない）
    if (this.lastPlayerPos && dt > 0) {
      const moved = Math.hypot(p.position[0] - this.lastPlayerPos[0], p.position[2] - this.lastPlayerPos[2]);
      this.lastMeasuredSpeed = moved / dt;
      if (p.grounded && p.horizontalMode === 'walk') {
        this.walkPhase += moved * WALK_PHASE_PER_METER;
        if (this.walkPhase > Math.PI * 200) this.walkPhase -= Math.PI * 200;
      }
    } else if (!this.lastPlayerPos) {
      this.lastMeasuredSpeed = Math.hypot(p.velocity[0], p.velocity[2]);
    }
    // sim が進まないフレーム（一時停止・再出撃直後の巻き戻り）でも位置は記録し、再開時に瞬間移動分で歩かないようにする
    this.lastPlayerPos = [p.position[0], p.position[1], p.position[2]];
    mech.update({
      aimDirection: p.aimDirection,
      yaw: p.yaw,
      walkPhase: this.walkPhase,
      speed: this.lastMeasuredSpeed,
      boosting: p.boosting,
      thrusting: p.thrusting,
      grounded: p.grounded,
      weapon: p.weapon,
      gliding: p.horizontalMode === 'glide' || p.horizontalMode === 'quickboost',
      alive: p.alive,
    });
  }

  private syncEnemies(views: EnemyView[], time: number, dt: number): void {
    for (const v of views) {
      let model = this.enemies.get(v.id);
      if (!model || model.kind !== v.kind) {
        if (model) model.dispose();
        model = createEnemyModel(v, this.enemyMaterials);
        model.root.visible = !this.garageMode;
        this.enemies.set(v.id, model);
        this.scene.add(model.root);
      }
      model.update(v, time, dt);
    }
  }

  private barrierCenter(id: string): Vec3 | null {
    const box = this.stage?.barrierBox(id);
    if (!box) return null;
    return [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
  }

  resize(width: number, height: number): void {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** 診断用: 敵モデル数・効果数 */
  stats(): { enemies: number; effects: ReturnType<EffectsSystem['activeCounts']>; staticMeshes: number; pointLights: number } {
    return {
      enemies: this.enemies.size,
      effects: this.effects.activeCounts(),
      staticMeshes: this.stage?.staticMeshCount ?? 0,
      pointLights: this.stage?.pointLightCount ?? 0,
    };
  }

  /** 診断用: 現在の機体モデル */
  get playerMech(): MechModel | null {
    return this.mech;
  }

  dispose(): void {
    if (this.stage) {
      this.stage.dispose();
      this.stage = null;
    }
    for (const e of this.enemies.values()) e.dispose();
    this.enemies.clear();
    if (this.mech) {
      this.mech.dispose();
      this.mech = null;
    }
    this.effects.dispose();
    disposeObject(this.garage);
    this.garage.removeFromParent();
    this.enemyMaterials.dispose();
    this.materials.dispose();
    this.hemi.removeFromParent();
    this.sun.removeFromParent();
    this.renderer.dispose();
    const canvas = this.renderer.domElement;
    if (canvas && canvas.parentNode === this.container) this.container.removeChild(canvas);
    void this.garageLegs;
    void this.tmpVec;
  }
}
