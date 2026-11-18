/**
 * GameRenderer — owns the WebGLRenderer and composes the whole 3D presentation:
 *
 *   game scene   : StageView (factory) + MechModel + one EnemyView per enemy + Effects + lights + blob shadow
 *   garage scene : a small hangar bay (its own StageView built from a hand-made StageDef) + the same MechModel
 *
 * The simulation is the single source of truth: every frame `renderGame` reads positions / orientations /
 * states from the Sim (extrapolated by `sim.accumulator` for smoothness), places the camera with the SAME
 * rig function the simulation's lock logic uses (`computeCameraRig`), and points the mech's weapon along
 * `sim.aim.dir` — the direction projectiles are really launched in (docs/SPEC.md §4.2, §7.4, §8).
 *
 * Canvas sizing: `resize()` only sets the drawing-buffer size; the element's displayed size is left to the
 * page's CSS (e.g. `position: fixed; inset: 0; width: 100%; height: 100%`). The drawing buffer is
 * CSS px × render pixel ratio, where the render pixel ratio is the device pixel ratio
 *   - capped at 2 and at a pixel budget of 2560 × 1440 (a 4K display is rendered at 1440p and scaled up), and
 *   - multiplied by the factor of the render-resolution governor (1 … 0.6, see `govern()`): when the real
 *     frame time stays above ≈ 22 ms the factor is lowered step by step, and raised again when there is headroom.
 * Both are purely a matter of how many pixels are shaded: the simulation, the camera, `projectToCss` (CSS px),
 * the HUD and the snapshot never see them.
 *
 * Per-frame cost outside the GPU: enemy views outside the view frustum (or beyond the draw distance) are
 * hidden as a whole; they then cost no scene-graph work and no posing, only the bookkeeping of their animation
 * state (see EnemyView.update).
 */
import * as THREE from 'three';
import { CAMERA, DEFAULT_WEAPON, ENEMIES, PLAYER, TICK } from '../config';
import type { V3 } from '../core/vec';
import { computeCameraRig, createCameraState, projectToViewport } from '../sim/camera';
import type { Sim } from '../sim/sim';
import type { CameraState, DecorDef, Loadout, SimEvent, SolidDef, SolidMaterial, StageDef, Weapon } from '../sim/types';
import type { RayHit } from '../sim/world';
import { Effects } from './effects';
import { EnemyView, type EnemyViewInput } from './enemyModels';
import { MechModel, worldDirToMechLocal, worldVelToMoveDirLocal, type MechAnimInput } from './mechModel';
import { StageView } from './stageView';

/** Haze colour (also the clear colour): a dim, slightly teal dust-in-the-air grey. */
const FOG_COLOR = 0x1f272d;
/** FogExp2 density: ≈ 16 % haze at 100 m, 50 % at 200 m — a 100 m hall stays readable end to end. */
const FOG_DENSITY = 0.0042;
/** Enemy views farther than this from the camera are neither posed nor drawn (they keep simulating). */
const ENEMY_DRAW_DISTANCE = 240;
/**
 * Radius (m, for an enemy of standard size) of the sphere around the hit centre that holds everything an
 * EnemyView can draw: mast and beacon flare of a control turret (5.6 m), barrels, charge glow, contact shadow.
 */
const ENEMY_CULL_RADIUS = 7;
/** Upper bound of the drawing buffer in device pixels (2560 × 1440). */
const MAX_RENDER_PIXELS = 2560 * 1440;

// ── render-resolution governor (see GameRenderer.govern) ──
/** Smoothed frame time (s) above which the picture counts as too slow: 22 ms ≈ 45 fps. */
const GOV_SLOW_FRAME = 0.022;
/** Smoothed frame time (s) below which there is headroom (a 60 Hz display delivers 16.7 ms when the GPU keeps up). */
const GOV_FAST_FRAME = 0.0185;
/** Frames longer than this (s) are hitches or a machine that resolution cannot rescue (< 5 fps): not sampled. */
const GOV_MAX_SAMPLE = 0.2;
/** Seconds the frame time must stay slow before the resolution is lowered one step. */
const GOV_LOWER_AFTER = 2;
/** Seconds of headroom before it is raised one step (doubles, up to GOV_RAISE_MAX, each time a raise had to be taken back). */
const GOV_RAISE_AFTER = 5;
const GOV_RAISE_MAX = 80;
const GOV_STEP = 0.1;
const GOV_MIN_SCALE = 0.6;
/** Playing seconds without sampling after a sortie starts / after the resolution or the window changed / after a pause. */
const GOV_GRACE_SORTIE = 3;
const GOV_GRACE_CHANGE = 1;
/** Time constant (s) of the frame-time smoothing. */
const GOV_SMOOTHING = 0.5;
const GARAGE_FOV_DEG = 30;
const GARAGE_PLATFORM_TOP = 0.5;
const DEG = Math.PI / 180;

export interface DebugCameraPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

export interface RendererDebugInfo {
  drawCalls: number;
  triangles: number;
  effects: number;
  geometries: number;
  textures: number;
  programs: number;
  /** Drawing-buffer pixels per CSS pixel (device pixel ratio after the caps × the governor's factor). */
  pixelRatio: number;
  /** Factor of the render-resolution governor: 1 = full resolution … 0.6. */
  resolutionScale: number;
}

// ───────────────────────────── hangar (garage scene) ─────────────────────────────
/** A small maintenance bay, expressed as a StageDef so it is drawn (and lit) by the same StageView as the factory. */
function buildHangarStage(): StageDef {
  const solids: SolidDef[] = [];
  const decor: DecorDef[] = [];
  const S = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, material: SolidMaterial): void => {
    solids.push({ min: { x: Math.min(x0, x1), y: Math.min(y0, y1), z: Math.min(z0, z1) }, max: { x: Math.max(x0, x1), y: Math.max(y0, y1), z: Math.max(z0, z1) }, material });
  };
  const D = (shape: DecorDef['shape'], material: DecorDef['material'], x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, blink = false): void => {
    const d: DecorDef = { shape, material, min: { x: Math.min(x0, x1), y: Math.min(y0, y1), z: Math.min(z0, z1) }, max: { x: Math.max(x0, x1), y: Math.max(y0, y1), z: Math.max(z0, z1) } };
    if (blink) d.blink = true;
    decor.push(d);
  };
  // shell
  S(-18, -2, -14, 18, 0, 26, 'floor');
  S(-18, 0, -14, 18, 14, -12, 'wall');
  S(-18, 0, -12, -16, 14, 26, 'wall');
  S(16, 0, -12, 18, 14, 26, 'wall');
  S(-18, 12, -12, 18, 14, 26, 'roof');
  // turntable platform with a hazard rim
  const top = GARAGE_PLATFORM_TOP;
  S(-3.6, 0, -3.6, 3.6, top, 3.6, 'catwalk');
  S(-4.4, 0, -4.4, 4.4, top - 0.14, -3.6, 'hazard');
  S(-4.4, 0, 3.6, 4.4, top - 0.14, 4.4, 'hazard');
  S(-4.4, 0, -3.6, -3.6, top - 0.14, 3.6, 'hazard');
  S(3.6, 0, -3.6, 4.4, top - 0.14, 3.6, 'hazard');
  // gantry: two towers behind the mech, a bridge across, docking arms
  for (const sx of [-1, 1]) {
    for (const z of [-4.2, -7.4]) S(sx * 6.2, 0, z, sx * 7.0, 9.4, z + 0.8, 'rust');
    for (const y of [2.6, 5.4, 8.2]) S(sx * 6.3, y, -6.6, sx * 6.9, y + 0.4, -4.2, 'rust');
    S(sx * 5.4, 0, -8.2, sx * 7.8, 0.5, -3.0, 'concrete');
    // docking arm + clamp (behind the mech, clear of the turntable sway)
    S(sx * 2.6, 2.9, -5.3, sx * 6.2, 3.3, -4.8, 'metal');
    S(sx * 2.2, 2.6, -5.5, sx * 2.9, 3.6, -3.4, 'metal');
    // tool cabinet and a crate stack in the wings (mostly behind the UI panels)
    S(sx * 9.4, 0, -11.6, sx * 13.4, 3.2, -8.8, 'machine');
    S(sx * 11.2, 0, -5.6, sx * 15.4, 2.8, -1.2, 'container');
    S(sx * 11.6, 2.8, -5.2, sx * 15.0, 5.4, -1.8, 'container');
    S(sx * 12.4, 0, 2.4, sx * 15.6, 2.4, 6.0, 'machine');
    // warning lights on the towers, cyan service strips on the tower fronts and beside the bay door
    D('box', 'light-red', sx * 6.35, 9.4, -3.95, sx * 6.85, 9.7, -3.45, true);
    D('box', 'light-cyan', sx * 8.1, 1.2, -12.0, sx * 8.5, 7.2, -11.85);
    // cyan work lights on the towers: the rim light on the mech's shoulders and ears
    D('box', 'light-cyan', sx * 5.3, 7.3, -3.5, sx * 6.2, 8.3, -3.3);
    // floor guide lines
    S(sx * 5.0, -0.4, 4.6, sx * 5.4, 0.012, 22, 'hazard');
  }
  S(-7.0, 9.4, -5.6, 7.0, 10.3, -4.6, 'metal');
  S(-7.0, 9.4, -7.4, 7.0, 9.9, -6.8, 'rust');
  D('box', 'hazard', -7.0, 9.36, -4.62, 7.0, 9.7, -4.56);
  // bay door in the back wall: hazard frame + dark corrugated shutter
  S(-7.2, 0, -12, -6.2, 9.2, -11.4, 'hazard');
  S(6.2, 0, -12, 7.2, 9.2, -11.4, 'hazard');
  S(-7.2, 8.2, -12, 7.2, 9.2, -11.4, 'hazard');
  S(-6.2, 0, -12, 6.2, 8.2, -11.8, 'roof');
  S(-6.2, 0, -11.8, 6.2, 0.7, -11.6, 'metal');
  // pipes and ducts under the roof, along the back wall
  S(-16, 10.6, -11.4, 16, 12, -9.6, 'pipe');
  D('cylinder-x', 'pipe', -16, 9.5, -11.3, -7.4, 10.3, -10.5);
  D('cylinder-x', 'pipe', 7.4, 9.5, -11.3, 16, 10.3, -10.5);
  D('cylinder-x', 'rust', -16, 9.7, -10.3, 16, 10.2, -9.8);
  D('cylinder-z', 'pipe', -15.4, 10.4, -12, -14.6, 11.2, 26);
  D('cylinder-z', 'metal', 14.7, 10.6, -12, 15.3, 11.2, 26);
  for (const z of [2, 10, 18]) {
    S(-16, 11.2, z - 0.3, 16, 12, z + 0.3, 'rust');
  }
  // lighting bar hung in front of the turntable: a strong warm key (left) and a small fill (right)
  S(-7.5, 9.7, 5.7, 7.5, 10.1, 6.3, 'rust');
  for (const x of [-7, 0, 7]) D('cylinder-y', 'metal', x - 0.08, 10.1, 5.92, x + 0.08, 12, 6.08);
  D('box', 'light-warm', -6.0, 9.55, 5.0, -2.6, 9.7, 7.0);
  D('box', 'light-warm', 3.4, 9.55, 5.6, 4.6, 9.7, 6.4);
  // ceiling panels further out (ambient pools on the floor)
  D('box', 'light-warm', -2, 11.85, -10, 2, 12, -8.8);
  D('box', 'light-warm', -2, 11.85, 15.4, 2, 12, 16.6);
  D('box', 'light-warm', -12, 11.85, 6, -8, 12, 7.2);
  D('box', 'light-warm', 8, 11.85, 6, 12, 12, 7.2);
  const far = { min: { x: 0, y: -500, z: 0 }, max: { x: 1, y: -499, z: 1 } };
  return {
    id: 'hangar',
    name: '格納庫',
    bounds: { min: { x: -18, y: -2, z: -14 }, max: { x: 18, y: 14, z: 26 } },
    killY: -100,
    sectors: [],
    solids,
    decor,
    barriers: [],
    finalGate: { id: 'HANGAR-GATE', name: '', box: far },
    exitZone: { min: { x: 0, y: -500, z: 0 }, max: { x: 0.1, y: -499.9, z: 0.1 } },
    playerStart: { position: { x: 0, y: top + PLAYER.half.y, z: 0 }, yaw: Math.PI },
    enemies: [],
    connections: [],
    route: [],
    flightSpots: [],
    branches: [],
    loops: [],
  };
}

interface LightRig {
  ambient: THREE.AmbientLight;
  hemi: THREE.HemisphereLight;
  key: THREE.DirectionalLight;
  fill: THREE.DirectionalLight;
}
/** Both scenes use the same light types and counts so every material compiles to one program. */
function addLightRig(scene: THREE.Scene): LightRig {
  const ambient = new THREE.AmbientLight(0xc8d0d8, 0.34);
  const hemi = new THREE.HemisphereLight(0xb4c2cf, 0x5a5046, 1.0);
  const key = new THREE.DirectionalLight(0xffe4c4, 0.9);
  key.position.set(-0.5, 1, 0.34);
  const fill = new THREE.DirectionalLight(0xc2e6f0, 0.62);
  scene.add(ambient, hemi, key, key.target, fill, fill.target);
  return { ambient, hemi, key, fill };
}

export class GameRenderer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly gameScene = new THREE.Scene();
  private readonly garageScene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly garageCamera: THREE.PerspectiveCamera;
  private readonly gameLights: LightRig;
  private readonly garageLights: LightRig;

  private stageDef: StageDef | null = null;
  private stageView: StageView | null = null;
  private hangar: StageView | null = null;
  private readonly mech: MechModel;
  private readonly effects = new Effects();
  private readonly enemyGroup = new THREE.Group();
  private enemyViews: EnemyView[] = [];
  private enemySmoke = new Float32Array(0);
  private readonly shadow: THREE.Mesh;
  private readonly shadowMaterial: THREE.ShaderMaterial;

  private cssWidth = 1280;
  private cssHeight = 720;
  /** Device pixel ratio after the caps (2, pixel budget), before the governor. */
  private basePixelRatio = 1;
  /** Pixel ratio the drawing buffer currently has (basePixelRatio × govScale). */
  private appliedPixelRatio = 0;
  // render-resolution governor
  private govEnabled = true;
  private govScale = 1;
  private govEma = 0;
  private govSlow = 0;
  private govFast = 0;
  private govGrace = GOV_GRACE_SORTIE;
  private govRaiseAfter = GOV_RAISE_AFTER;
  /** Playing seconds since the last raise (a step down soon after one means the raise was wrong). */
  private govSinceRaise = Infinity;
  /** Smoothed frame time at full resolution when the first step down was taken (0 = none). */
  private govBaseline = 0;
  /** Lowering the resolution did not help (CPU-bound, or a slow display): the governor stays out until the next sortie. */
  private govOff = false;
  private time = 0;
  private lastSimTime = 0;
  private pendingFired: Weapon | null = null;
  private readonly camState: CameraState = createCameraState();
  private hasGameCamera = false;
  private debugCamera: DebugCameraPose | null = null;
  private lastCalls = 0;
  private lastTriangles = 0;
  private disposed = false;

  // scratch (no per-frame allocations)
  private readonly renderPos = { x: 0, y: 0, z: 0 };
  private readonly rayHit: RayHit = { dist: 0, point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 0 }, box: null as unknown as RayHit['box'] };
  private readonly down = { x: 0, y: -1, z: 0 };
  private readonly garageFocus = { x: 0, y: 0, z: 0 };
  private readonly debugVec = new THREE.Vector3();
  private readonly viewProjection = new THREE.Matrix4();
  private readonly frustum = new THREE.Frustum();
  private readonly cullSphere = new THREE.Sphere();
  private readonly mechInput: MechAnimInput = {
    dt: 0,
    time: 0,
    grounded: true,
    horizontalSpeed: 0,
    moveDirLocal: { x: 0, z: 0 },
    horizontalMode: 'walk',
    verticalMode: 'grounded',
    braking: false,
    weapon: DEFAULT_WEAPON,
    aimDirLocal: { x: 0, y: 0, z: -1 },
    fired: null,
  };
  private readonly enemyInput: EnemyViewInput = { dt: 0, time: 0, alive: true, yaw: 0, aimDir: { x: 0, y: 0, z: -1 }, telegraph: 0, alert: false, hpFraction: 1, speed: 0 };

  constructor(canvas: HTMLCanvasElement) {
    // stencil: the player's mech marks its pixels, Effects draws the player's own tracers through it (effects.ts)
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', alpha: false, stencil: true });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.setClearColor(FOG_COLOR, 1);

    const fovY = CAMERA.fovYDeg;
    this.camera = new THREE.PerspectiveCamera(fovY, this.cssWidth / this.cssHeight, CAMERA.near, CAMERA.far);
    this.camera.rotation.order = 'YXZ';
    this.garageCamera = new THREE.PerspectiveCamera(GARAGE_FOV_DEG, this.cssWidth / this.cssHeight, 0.3, 200);

    for (const scene of [this.gameScene, this.garageScene]) {
      scene.background = new THREE.Color(FOG_COLOR);
      scene.fog = new THREE.FogExp2(FOG_COLOR, FOG_DENSITY);
    }
    this.gameLights = addLightRig(this.gameScene);
    this.garageLights = addLightRig(this.garageScene);
    // hangar presentation: dim global light (the bay is lit by its own lamps), key from the camera side
    this.garageLights.key.position.set(-5, 8, 12);
    this.garageLights.key.intensity = 0.7;
    this.garageLights.fill.position.set(8, 3, 10);
    this.garageLights.fill.intensity = 0.3;
    this.garageLights.hemi.intensity = 0.7;
    this.garageLights.ambient.intensity = 0.3;

    this.mech = new MechModel('biped');
    this.gameScene.add(this.mech.group);
    this.enemyGroup.name = 'enemies';
    this.gameScene.add(this.enemyGroup);
    this.gameScene.add(this.effects.group);

    // soft blob shadow that grounds the mech (no shadow maps)
    this.shadowMaterial = new THREE.ShaderMaterial({
      uniforms: { uOpacity: { value: 0.5 } },
      vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `uniform float uOpacity; varying vec2 vUv; void main() { float r = length(vUv * 2.0 - 1.0); float a = 1.0 - smoothstep(0.15, 1.0, r); gl_FragColor = vec4(0.0, 0.0, 0.0, a * a * uOpacity); }`,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      toneMapped: false,
    });
    const shadowGeo = new THREE.PlaneGeometry(1, 1);
    shadowGeo.rotateX(-Math.PI / 2);
    this.shadow = new THREE.Mesh(shadowGeo, this.shadowMaterial);
    this.shadow.name = 'mech-shadow';
    this.shadow.renderOrder = 1;
    this.gameScene.add(this.shadow);

    const w = canvas.clientWidth || canvas.width || 1280;
    const h = canvas.clientHeight || canvas.height || 720;
    this.resize(w, h, typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);
  }

  /**
   * Display size in CSS pixels + the device pixel ratio. The drawing buffer gets CSS px × the render pixel
   * ratio: the device pixel ratio capped at 2 and at the pixel budget (2560 × 1440), times the governor's factor.
   */
  resize(cssWidth: number, cssHeight: number, devicePixelRatio: number): void {
    this.cssWidth = Math.max(1, Math.floor(cssWidth));
    this.cssHeight = Math.max(1, Math.floor(cssHeight));
    const dpr = Math.min(2, Math.max(0.5, Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1));
    // (the small margin keeps an exact fit — 1280 × 720 at ratio 2 — from rounding down to 2559 px)
    const budget = Math.sqrt((MAX_RENDER_PIXELS * 1.0005) / (this.cssWidth * this.cssHeight));
    this.basePixelRatio = Math.min(dpr, Math.max(0.5, budget));
    this.applyPixelRatio(true);
    this.govGrace = Math.max(this.govGrace, GOV_GRACE_CHANGE);
    const aspect = this.cssWidth / this.cssHeight;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.garageCamera.aspect = aspect;
    this.garageCamera.updateProjectionMatrix();
  }

  /** Sets the drawing-buffer size from the CSS size, the capped device pixel ratio and the governor's factor. */
  private applyPixelRatio(sizeChanged: boolean): void {
    const pr = this.basePixelRatio * this.govScale;
    if (!sizeChanged && pr === this.appliedPixelRatio) return;
    this.appliedPixelRatio = pr;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(this.cssWidth, this.cssHeight, false);
  }

  /**
   * Render-resolution governor. Fed with the real frame time of every PLAYING frame (`realDt` > 0):
   *  - smoothed frame time above ≈ 22 ms for more than 2 s → the render pixel ratio drops by 10 % of the
   *    base ratio (never below 60 %);
   *  - below ≈ 18.5 ms for 5 s → it rises one step again. A raise that has to be taken back within 10 s
   *    doubles the wait before the next attempt (up to 80 s), so a scene at its limit does not flicker
   *    between two resolutions;
   *  - if the lowest step is not at least 15 % faster than full resolution was, the GPU's fill rate is not
   *    what limits the frame rate (CPU-bound, 30 Hz display …): full resolution is restored and the governor
   *    stays out until the next sortie.
   * Never sampled: frozen frames (paused / result screens call renderGame with 0), the garage, the first
   * 3 s of a sortie and 1 s after a resume / resize / change of resolution (shader warm-up, buffer
   * reallocation), frames longer than 0.2 s (hitches, a tab coming back, software rendering).
   * Only the number of shaded pixels changes: nothing here is visible to the simulation, the HUD
   * (CSS px) or the snapshot.
   */
  private govern(realDt: number): void {
    if (!(realDt > 0)) {
      // not playing: whatever comes next starts with a short grace period
      this.govGrace = Math.max(this.govGrace, GOV_GRACE_CHANGE);
      this.govSlow = 0;
      this.govFast = 0;
      return;
    }
    if (this.govOff || !this.govEnabled) return;
    if (realDt > GOV_MAX_SAMPLE) {
      this.govSlow = 0;
      this.govFast = 0;
      return;
    }
    if (this.govGrace > 0) {
      this.govGrace -= realDt;
      this.govEma = 0;
      this.govSlow = 0;
      this.govFast = 0;
      return;
    }
    this.govSinceRaise += realDt;
    this.govEma = this.govEma > 0 ? this.govEma + (realDt - this.govEma) * (1 - Math.exp(-realDt / GOV_SMOOTHING)) : realDt;
    if (this.govEma > GOV_SLOW_FRAME) {
      this.govSlow += realDt;
      this.govFast = 0;
    } else if (this.govEma < GOV_FAST_FRAME) {
      this.govFast += realDt;
      this.govSlow = 0;
    } else {
      this.govSlow = 0;
      this.govFast = 0;
    }
    if (this.govSlow > GOV_LOWER_AFTER) {
      this.govSlow = 0;
      if (this.govScale > GOV_MIN_SCALE + 1e-6) {
        if (this.govScale >= 1) this.govBaseline = this.govEma;
        // a raise that did not hold: wait longer before trying again
        if (this.govSinceRaise < 10) this.govRaiseAfter = Math.min(GOV_RAISE_MAX, this.govRaiseAfter * 2);
        this.setGovScale(Math.max(GOV_MIN_SCALE, this.govScale - GOV_STEP));
      } else if (this.govBaseline > 0 && this.govEma > this.govBaseline * 0.85) {
        // the lowest step changed (almost) nothing: resolution is not the bottleneck
        this.govOff = true;
        this.setGovScale(1);
      }
    } else if (this.govFast > this.govRaiseAfter && this.govScale < 1) {
      this.govFast = 0;
      this.govSinceRaise = 0;
      this.setGovScale(Math.min(1, this.govScale + GOV_STEP));
    }
  }

  /**
   * Switches the render-resolution governor on / off (default: on). Off restores full resolution at once.
   * A render option only — for harnesses that feed synthetic frame times and need reproducible pictures.
   */
  setResolutionGovernor(enabled: boolean): void {
    this.govEnabled = enabled;
    this.govSlow = 0;
    this.govFast = 0;
    this.govEma = 0;
    if (!enabled && this.govScale !== 1) this.setGovScale(1);
  }

  private setGovScale(scale: number): void {
    // (steps of 0.1 without accumulating rounding errors)
    this.govScale = Math.round(scale * 10) / 10;
    this.govGrace = GOV_GRACE_CHANGE;
    this.govEma = 0;
    this.applyPixelRatio(false);
  }

  /** Builds the StageView for a stage (cached: calling it again with the same StageDef is free). */
  setStage(stage: StageDef): void {
    if (this.stageDef === stage && this.stageView) return;
    if (this.stageView) {
      this.gameScene.remove(this.stageView.group);
      this.stageView.dispose();
    }
    this.stageDef = stage;
    this.stageView = new StageView(stage);
    this.stageView.poolGain = 1.4;
    this.gameScene.add(this.stageView.group);
  }

  /** New sortie: fresh enemy views, no effects, all doors closed, legs per loadout. Safe to call repeatedly. */
  resetForSortie(sim: Sim): void {
    this.setStage(sim.stage);
    // create the new views first so the shared enemy assets are never released and rebuilt in between
    const next: EnemyView[] = [];
    for (const e of sim.enemies) {
      const v = new EnemyView(e.kind, e.isGateControl);
      const base = e.kind === 'guard' ? ENEMIES.guard.radius : ENEMIES.turret.radius;
      if (Math.abs(e.radius - base) > 1e-6) v.group.scale.setScalar(e.radius / base);
      v.group.position.set(e.pos.x, e.pos.y, e.pos.z);
      this.enemyGroup.add(v.group);
      next.push(v);
    }
    for (const v of this.enemyViews) {
      this.enemyGroup.remove(v.group);
      v.dispose();
    }
    this.enemyViews = next;
    this.enemySmoke = new Float32Array(next.length);
    this.effects.clear();
    this.stageView!.resetBarriers();
    this.stageView!.setExitActive(false);
    if (this.mech.legs !== sim.loadout.legs) this.mech.setLegs(sim.loadout.legs);
    // the new sortie starts at rest: no glide stance, lean or thruster flames left over from the last one
    this.mech.reset();
    this.pendingFired = null;
    this.lastSimTime = sim.time;
    // the governor keeps the resolution it found for this machine but starts observing afresh
    this.govGrace = GOV_GRACE_SORTIE;
    this.govEma = 0;
    this.govSlow = 0;
    this.govFast = 0;
    this.govRaiseAfter = GOV_RAISE_AFTER;
    this.govSinceRaise = Infinity;
    this.govOff = false;
  }

  /** Forwards the simulation events of this frame to the effects, the doors and the mech's recoil. */
  handleEvents(events: readonly SimEvent[], sim: Sim): void {
    for (const e of events) {
      this.effects.handleEvent(e, sim);
      switch (e.type) {
        case 'barrier-opened':
          this.stageView?.setBarrierOpen(e.barrierId, true, true);
          break;
        case 'gate-opened':
          this.stageView?.setBarrierOpen(sim.stage.finalGate.id, true, true);
          this.stageView?.setExitActive(true);
          break;
        case 'player-shot':
          this.pendingFired = e.weapon;
          break;
        case 'beam':
          this.pendingFired = 'beam';
          break;
        default:
          break;
      }
    }
  }

  /** Syncs every view from the simulation (extrapolated by sim.accumulator) and draws the game scene. */
  renderGame(sim: Sim, realDt: number): void {
    if (this.disposed) return;
    // a stage change or a simulation that went back in time (re-sortie) without resetForSortie() is healed here
    if (this.stageDef !== sim.stage || !this.stageView || this.enemyViews.length !== sim.enemies.length || sim.time < this.lastSimTime - 1e-9) this.resetForSortie(sim);
    this.lastSimTime = sim.time;
    const stage = this.stageView!;
    this.govern(Number.isFinite(realDt) ? realDt : 0);
    const dt = Number.isFinite(realDt) && realDt > 0 ? Math.min(realDt, 0.1) : 0;
    this.time += dt;
    const lead = sim.status === 'playing' && Number.isFinite(sim.accumulator) ? Math.min(Math.max(sim.accumulator, 0), TICK) : 0;
    const p = sim.player;

    // ── player render position + camera (same rig as the simulation's lock logic) ──
    const rp = this.renderPos;
    rp.x = p.pos.x + p.vel.x * lead;
    rp.y = p.pos.y + p.vel.y * lead;
    rp.z = p.pos.z + p.vel.z * lead;
    const cam = this.camState;
    computeCameraRig(sim.world, rp, p.yaw, p.pitch, this.cssWidth / this.cssHeight, cam);
    this.hasGameCamera = true;
    const dbg = this.debugCamera;
    if (dbg) {
      this.camera.position.set(dbg.x, dbg.y, dbg.z);
      this.camera.rotation.set(dbg.pitch, dbg.yaw, 0, 'YXZ');
    } else {
      this.camera.position.set(cam.pos.x, cam.pos.y, cam.pos.z);
      this.camera.rotation.set(cam.pitch, cam.yaw, 0, 'YXZ');
    }
    const cp = this.camera.position;
    // view frustum of this frame (the test three.js itself uses), to cull enemy views as a whole
    this.camera.updateMatrixWorld(); // (a Camera refreshes matrixWorldInverse with it)
    this.frustum.setFromProjectionMatrix(this.viewProjection.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse));

    // camera-side fill light: whatever the player looks at keeps a readable front
    const fill = this.gameLights.fill;
    fill.position.set(cp.x - cam.forward.x * 6 + cam.up.x * 4, cp.y - cam.forward.y * 6 + cam.up.y * 4 + 2, cp.z - cam.forward.z * 6 + cam.up.z * 4);
    fill.target.position.set(cp.x + cam.forward.x * 20, cp.y + cam.forward.y * 20, cp.z + cam.forward.z * 20);
    const key = this.gameLights.key;
    key.position.set(rp.x - 30, rp.y + 60, rp.z + 20);
    key.target.position.set(rp.x, rp.y, rp.z);

    // ── mech ──
    const mech = this.mech;
    if (mech.group.parent !== this.gameScene) this.gameScene.add(mech.group);
    if (mech.legs !== sim.loadout.legs) mech.setLegs(sim.loadout.legs);
    mech.group.position.set(rp.x, rp.y - PLAYER.half.y, rp.z);
    mech.group.rotation.set(0, p.yaw, 0);
    const mi = this.mechInput;
    mi.dt = dt;
    mi.time = this.time;
    mi.grounded = p.grounded;
    mi.horizontalSpeed = Math.hypot(p.vel.x, p.vel.z);
    worldVelToMoveDirLocal(p.vel.x, p.vel.z, p.yaw, mi.moveDirLocal);
    mi.horizontalMode = p.horizontalMode;
    mi.verticalMode = p.verticalMode;
    mi.braking = p.braking;
    mi.weapon = p.weapon;
    const ad = sim.aim.dir;
    const al = ad.x * ad.x + ad.y * ad.y + ad.z * ad.z;
    if (al > 0.25 && al < 4) worldDirToMechLocal(ad, p.yaw, mi.aimDirLocal);
    else worldDirToMechLocal(cam.forward, p.yaw, mi.aimDirLocal);
    mi.fired = this.pendingFired;
    this.pendingFired = null;
    mech.update(mi);

    // blob shadow on the ground below the mech
    const hit = sim.world.raycast(rp, this.down, 60, this.rayHit);
    if (hit) {
      const height = Math.max(0, hit.dist - PLAYER.half.y);
      const k = Math.min(1, height / 16);
      this.shadow.visible = true;
      this.shadow.position.set(rp.x, rp.y - hit.dist + 0.04, rp.z);
      const s = 4.6 + k * 3.2;
      this.shadow.scale.set(s, 1, s);
      this.shadowMaterial.uniforms.uOpacity!.value = 0.62 * (1 - k * 0.8);
    } else {
      this.shadow.visible = false;
    }

    // ── enemies ──
    const ei = this.enemyInput;
    ei.dt = dt;
    ei.time = this.time;
    const lim2 = ENEMY_DRAW_DISTANCE * ENEMY_DRAW_DISTANCE;
    const views = this.enemyViews;
    for (let i = 0; i < views.length; i++) {
      const e = sim.enemies[i]!;
      const v = views[i]!;
      const k = e.alive ? lead : 0;
      const x = e.pos.x + e.vel.x * k;
      const y = e.pos.y + e.vel.y * k;
      const z = e.pos.z + e.vel.z * k;
      v.group.position.set(x, y, z);
      const dx = x - cp.x;
      const dy = y - cp.y;
      const dz = z - cp.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      // badly damaged enemies trail smoke (also while their view is culled: the puffs drift into the picture)
      const hpFraction = e.maxHp > 0 ? Math.min(1, Math.max(0, e.hp / e.maxHp)) : 0;
      if (e.alive && hpFraction < 0.4 && d2 < 150 * 150 && dt > 0) {
        this.enemySmoke[i]! -= dt;
        if (this.enemySmoke[i]! <= 0) {
          this.enemySmoke[i] = 0.16 + Math.random() * 0.14;
          this.effects.damageSmoke(x, y + e.radius * 0.5, z, 1 - hpFraction);
        }
      }
      // Too far away or completely outside the view frustum: the whole view is hidden. three.js then neither
      // traverses it nor refreshes its matrices, and the view only advances its animation state (a few
      // scalars) without posing the model — so it is exact in the frame it is shown again (EnemyView.update).
      let visible = d2 < lim2;
      if (visible) {
        const sphere = this.cullSphere;
        sphere.center.set(x, y, z);
        sphere.radius = ENEMY_CULL_RADIUS * v.group.scale.x;
        visible = this.frustum.intersectsSphere(sphere);
      }
      v.group.visible = visible;
      ei.alive = e.alive;
      ei.yaw = e.yaw;
      ei.aimDir.x = e.aimDir.x;
      ei.aimDir.y = e.aimDir.y;
      ei.aimDir.z = e.aimDir.z;
      ei.alert = e.alert;
      ei.hpFraction = hpFraction;
      ei.speed = Math.hypot(e.vel.x, e.vel.y, e.vel.z);
      let tele = 0;
      if (e.alive && e.telegraphStartAt !== null && e.burstStartAt !== null && sim.time >= e.telegraphStartAt && sim.time < e.burstStartAt) {
        const span = e.burstStartAt - e.telegraphStartAt;
        tele = span > 1e-6 ? Math.min(1, Math.max(0.001, (sim.time + lead - e.telegraphStartAt) / span)) : 1;
      }
      ei.telegraph = tele;
      v.update(ei, visible);
    }

    // ── doors / exit follow the objective state (also heals a missed event) ──
    const obj = sim.objective;
    for (const b of sim.stage.barriers) {
      const open = obj.openBarrierIds.indexOf(b.id) >= 0;
      if (stage.isBarrierOpen(b.id) !== open) stage.setBarrierOpen(b.id, open, open);
    }
    const gateId = sim.stage.finalGate.id;
    if (stage.isBarrierOpen(gateId) !== obj.gateOpen) stage.setBarrierOpen(gateId, obj.gateOpen, obj.gateOpen);
    stage.setExitActive(obj.gateOpen);

    // ── effects + stage ──
    this.effects.syncProjectiles(sim.projectiles, lead);
    this.effects.update(dt, cp);
    stage.update(dt, this.time, cp, rp);

    this.renderer.render(this.gameScene, this.camera);
    this.lastCalls = this.renderer.info.render.calls;
    this.lastTriangles = this.renderer.info.render.triangles;
  }

  /**
   * Hangar scene: the mech with the selected legs on a turntable, koala face towards the camera.
   * `frame` (optional): the rectangle of the display area, in CSS px, the mech is framed in — the
   * transparent centre of the garage UI (GarageUi.getPreviewRect()). Without it the mech is centred in the
   * whole view.
   */
  renderGarage(loadout: Loadout, realDt: number, frame?: { x: number; y: number; width: number; height: number } | null): void {
    if (this.disposed) return;
    if (!this.hangar) {
      this.hangar = new StageView(buildHangarStage());
      this.hangar.poolGain = 2.7;
      this.garageScene.add(this.hangar.group);
    }
    const dt = Number.isFinite(realDt) && realDt > 0 ? Math.min(realDt, 0.1) : 0;
    this.time += dt;
    const mech = this.mech;
    if (mech.group.parent !== this.garageScene) {
      this.garageScene.add(mech.group);
      mech.reset(); // (coming back from a sortie: the hangar shows the mech at rest at once)
    }
    if (mech.legs !== loadout.legs) mech.setLegs(loadout.legs);
    const sway = Math.sin(this.time * 0.42) * 25 * DEG;
    mech.group.position.set(0, GARAGE_PLATFORM_TOP, 0);
    mech.group.rotation.set(0, Math.PI + sway, 0);
    const mi = this.mechInput;
    mi.dt = dt;
    mi.time = this.time;
    mi.grounded = true;
    mi.horizontalSpeed = 0;
    mi.moveDirLocal.x = 0;
    mi.moveDirLocal.z = 0;
    mi.horizontalMode = 'walk';
    mi.verticalMode = 'grounded';
    mi.braking = false;
    mi.weapon = DEFAULT_WEAPON;
    mi.aimDirLocal.x = 0.06;
    mi.aimDirLocal.y = -0.1;
    mi.aimDirLocal.z = -0.993;
    mi.fired = null;
    mech.update(mi);

    // frame the whole mech inside `frame` (default: the central ~40 % of the width and ~76 % of the height)
    const cam = this.garageCamera;
    const aspect = this.cssWidth / this.cssHeight;
    const tanV = Math.tan((GARAGE_FOV_DEG * DEG) / 2);
    const mechH = 4.35;
    const mechW = 4.3;
    let fracW = 0.4;
    let fracH = 0.76;
    let shiftX = 0;
    let shiftY = 0;
    if (frame && frame.width >= 16 && frame.height >= 16 && Number.isFinite(frame.x + frame.y + frame.width + frame.height)) {
      fracW = Math.min(1, frame.width / this.cssWidth);
      fracH = Math.min(1, (frame.height / this.cssHeight) * 0.96);
      shiftX = frame.x + frame.width / 2 - this.cssWidth / 2;
      shiftY = frame.y + frame.height / 2 - this.cssHeight / 2;
    }
    const dV = mechH / fracH / (2 * tanV);
    const dH = mechW / fracW / (2 * tanV * aspect);
    const dist = Math.max(dV, dH);
    const lookY = GARAGE_PLATFORM_TOP + 2.02;
    cam.position.set(0, lookY + dist * 0.035, dist);
    cam.lookAt(0, lookY - dist * 0.012, 0);
    // shift the picture so that the optical centre (the mech) lands on the centre of the frame
    if (shiftX !== 0 || shiftY !== 0) cam.setViewOffset(this.cssWidth, this.cssHeight, -shiftX, -shiftY, this.cssWidth, this.cssHeight);
    else if (cam.view !== null && cam.view.enabled) cam.clearViewOffset();
    this.garageFocus.y = GARAGE_PLATFORM_TOP + 2.4;
    this.hangar.update(dt, this.time, cam.position, this.garageFocus);

    this.renderer.render(this.garageScene, cam);
    this.lastCalls = this.renderer.info.render.calls;
    this.lastTriangles = this.renderer.info.render.triangles;
  }

  /**
   * World → CSS pixels (origin top-left) with the game camera of the last renderGame call.
   * Returns false when the point is behind the camera (or before the first renderGame).
   */
  projectToCss(p: V3, out: { x: number; y: number; depth: number }): boolean {
    if (!this.hasGameCamera) {
      out.x = this.cssWidth / 2;
      out.y = this.cssHeight / 2;
      out.depth = 0;
      return false;
    }
    return projectToViewport(this.camState, { width: this.cssWidth, height: this.cssHeight }, p, out);
  }

  /** Statistics of the last rendered frame + resource counts (leak checks). */
  getDebugInfo(): RendererDebugInfo {
    const info = this.renderer.info;
    return {
      drawCalls: this.lastCalls,
      triangles: this.lastTriangles,
      effects: this.effects.activeCount,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      programs: info.programs ? info.programs.length : 0,
      pixelRatio: this.appliedPixelRatio,
      resolutionScale: this.govScale,
    };
  }

  /** Dev harness only: overrides the game camera pose (null = follow the player rig). HUD projection is unaffected. */
  setDebugCamera(pose: DebugCameraPose | null): void {
    this.debugCamera = pose;
  }

  /** Dev harness only: projects with the THREE camera itself (cross-check of projectToCss). */
  debugProjectWithThree(p: V3, out: { x: number; y: number; depth: number }): boolean {
    const v = this.debugVec.set(p.x, p.y, p.z);
    this.camera.updateMatrixWorld();
    v.applyMatrix4(this.camera.matrixWorldInverse);
    out.depth = -v.z;
    v.applyMatrix4(this.camera.projectionMatrix);
    out.x = (v.x * 0.5 + 0.5) * this.cssWidth;
    out.y = (0.5 - v.y * 0.5) * this.cssHeight;
    return out.depth > CAMERA.near;
  }

  /** Dev harness only: the stage view of the current stage. */
  getStageView(): StageView | null {
    return this.stageView;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const v of this.enemyViews) v.dispose();
    this.enemyViews = [];
    this.effects.dispose();
    this.mech.dispose();
    this.stageView?.dispose();
    this.hangar?.dispose();
    this.stageView = null;
    this.hangar = null;
    this.shadow.geometry.dispose();
    this.shadowMaterial.dispose();
    this.renderer.dispose();
  }
}
