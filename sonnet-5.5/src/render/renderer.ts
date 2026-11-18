/**
 * Three.js renderer (OWNER: render agent). Reads GameState only - never mutates the simulation.
 * API contract: docs/ARCH.md §6.
 *
 * Draw-call budget (round 2, measured in docs / the final report):
 *  - the stage is merged per (sector, material, emissive level) and split by a kd-tree above ~90 boxes (stageMesh.ts);
 *  - sector visibility (visibility.ts): only the camera / player sector and the sectors seen through open, in-frustum portals are
 *    submitted - nothing behind a wall, above / below, or behind a closed barrier; the rest is frustum + fog-distance culled;
 *  - enemies: full model only inside 75 m (~14 draws each), a 2-mesh silhouette beyond; enemies in hidden sectors are skipped;
 *  - all bullets are 3 instanced draws, effects are 2 point-sprite draws (+ 1 marker-lamp draw, 1 light-shaft draw).
 * Everything transient lives in fixed pools (effects.ts), so repeated sorties / hangar round trips do not grow GL resources.
 */
import {
  AdditiveBlending,
  BackSide,
  Color,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  Fog,
  Frustum,
  Group,
  HemisphereLight,
  InstancedMesh,
  Material,
  Matrix4,
  MeshStandardMaterial,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PCFShadowMap,
  PMREMGenerator,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  Quaternion,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  ACESFilmicToneMapping,
  Texture,
  Vector3,
  WebGLRenderer,
} from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { ENEMIES, PLAYER } from '../config';
import { playerMuzzlePosition } from '../sim/camera';
import type { GameEvent, GameState, Loadout, PortalDef, StageDef, V3 } from '../sim/types';
import { visualAimDirection } from './aim';
import { LightShafts, SpeedLines } from './atmosphere';
import { applySimCamera } from './cameraRig';
import { Effects, ParticleSystem } from './effects';
import { EnemyModel, createEnemyMaterials, createEnemyShared, type EnemyMaterials, type EnemyShared } from './enemyModels';
import { GeoBuilder, mulberry32 } from './geo';
import { lerpHex, sectorLook, type SectorLook } from './look';
import { HangarScene } from './hangar';
import { MechModel, type MechFrame } from './mech';
import { buildStageMeshes, type BarrierBoxVisual, type StageMeshResult } from './stageMesh';
import { MaterialLibrary, STAGE_AMBIENT, hasCanvas } from './textures';
import { SectorVisibility } from './visibility';

const FAR_ENEMY_HIDE = 280; // m: enemies beyond this are not drawn
const DETAIL_ENEMY_DIST = 75; // m: limbs are animated / small parts drawn only inside this range (a guard is ~20 px tall at 75 m)
const MAX_EVENTS_PER_FRAME = 400;
/** a shot event younger than this (sim seconds) is decorated at the current visual muzzle */
const FRESH_SHOT_SECONDS = 0.05;
const GHOSTS = 7;
const GHOST_LIFE = 0.2;
const BARRIER_OPEN_SECONDS = 0.9;
const NEAR_LIGHTS = 2;
/** strength of the environment reflection on metals / armour (was scene.environmentIntensity) */
const ENV_INTENSITY = 0.45;
/** ambient lift for surfaces without an environment map: replaces the diffuse IBL they no longer get (tuned on the luminance of the route views) */
const AMBIENT_LIFT = 1.4;
/** frames between forced blob-shadow floor rays while the mech stands still */
const FLOOR_RAY_EVERY = 8;
/** dust motes drifting in the air around the camera (per second / spawn box half size) */
const DUST_RATE = 12;
const DUST_BOX = 24;

/**
 * frames the hangar is not drawn after its shaders were compiled (see render). Drawing in the same frame as gl.compile() makes the
 * software GL link every program one after the other and cost ~3 s more at start-up (measured: tools/startup-bench.ts); a couple of
 * frames in between let the GPU side get on with all of them at once.
 */
const HANGAR_WAIT_FRAMES = 2;

/** edge length [px] of one face of the environment cube map (PMREM) */
const ENV_MAP_SIZE = 128;

/** the drawing buffer never exceeds this many pixels: a 4K / high-DPI window renders at a reduced pixel ratio instead of stalling */
export const MAX_BUFFER_PIXELS = 5_500_000;

/** requested devicePixelRatio -> the ratio actually used: 0.5..2, and small enough for MAX_BUFFER_PIXELS */
export function effectivePixelRatio(cssW: number, cssH: number, requested: number): number {
  let r = Math.min(Math.max(Number.isFinite(requested) && requested > 0 ? requested : 1, 0.5), 2);
  const px = cssW * cssH * r * r;
  if (px > MAX_BUFFER_PIXELS) r = Math.max(0.5, Math.sqrt(MAX_BUFFER_PIXELS / (cssW * cssH)));
  return r;
}

const V_UP = new Vector3(0, 1, 0);
const _m = new Matrix4();
const _q = new Quaternion();
const _q2 = new Quaternion();
const DUMMY = new Object3D();
const _fwd = new Vector3();
const _tip: V3 = { x: 0, y: 0, z: 0 };

interface BarrierGuide {
  id: string;
  group: Group;
  chevron: Mesh | null;
  frameMat: MeshBasicMaterial;
  /** light column above the opening (bright right after opening, then a dim path light) */
  pillar: Mesh | null;
  pillarMat: MeshBasicMaterial | null;
  fade: number;
  open: boolean;
  openedAt: number;
  /** floor point in the middle of the opening + unit travel direction (null for hatches) - for the running path lights */
  path: { origin: Vector3; dir: Vector3 } | null;
}

interface GhostSlot {
  mesh: Mesh;
  mat: MeshBasicMaterial;
  age: number;
  active: boolean;
}

export interface RenderStats {
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
  /** estimated GPU size of the procedural textures (RGBA8 + mips) [bytes] */
  textureBytes: number;
  stageChunks: number;
  /** stage chunks that were submitted this frame (sector + distance culled; the GPU frustum-culls the rest) */
  stageChunksVisible: number;
  sectorsVisible: number;
  sectorsTotal: number;
  stageTriangles: number;
  stageBoxes: number;
  stageDecor: number;
  enemiesVisible: number;
  additiveParticles: number;
  smokeParticles: number;
  /** long-range marker lamps drawn this frame (enemy glints, telegraphs, barrier lamps, path lights) */
  markers: number;
  /** ceiling light shafts / boost streaks drawn this frame */
  lightShafts: number;
  speedLines: number;
}

export class GameRenderer {
  private gl: WebGLRenderer;
  private lib = new MaterialLibrary();
  private scene = new Scene();
  private camera = new PerspectiveCamera(70, 16 / 9, 0.3, 1500);
  private width = 1280;
  private height = 720;
  private dpr = 1;
  /** size / pixel ratio the drawing buffer currently has (see resize) */
  private bufferKey = '';
  /** what the caller asked for / what window.devicePixelRatio was at that time (a later window change re-applies the size) */
  private requestedDpr = 1;
  private windowDpr = 1;
  private env: Texture | null = null;

  private stage: StageDef | null = null;
  private stageCompiled = false;
  private stageMesh: StageMeshResult | null = null;
  /** chunk cell sizes (dev/tuning; default from stageMesh.ts) */
  chunkOpts: { chunkXZ?: number; chunkY?: number } = {};
  private chunkSpheres: { cx: number; cy: number; cz: number; r: number }[] = [];
  private vis: SectorVisibility | null = null;
  private visFlags = new Uint8Array(0);
  private frustum = new Frustum();
  private projView = new Matrix4();
  private barrierById = new Map<string, BarrierBoxVisual[]>();
  private chunksVisible = 0;
  private sectorsVisible = 0;
  /** stage / sector culling on-off (dev / measurement only) */
  sectorCulling = true;
  private barrierGuides = new Map<string, BarrierGuide>();
  private barrierSeen = new Map<number, boolean>();
  private escapeBeacon: { group: Group; pillar: Mesh; ring: Mesh; mat: MeshBasicMaterial; ringMat: MeshBasicMaterial } | null = null;
  private guideTex: Texture[] = [];

  private effects: Effects;
  private mech: MechModel;
  private enemyMats: EnemyMaterials;
  private enemyShared: EnemyShared;
  private enemies = new Map<string, EnemyModel>();
  private enemyGroup = new Group();
  private hangar: HangarScene | null = null;
  private hangarLoadout: Loadout | null = null;
  private hangarSkipped = 0;
  /** number of scene draws submitted so far (the app waits for real frames before it hides its loading screen) */
  framesDrawn = 0;

  private sky: Mesh;
  private hemi: HemisphereLight;
  private sun: DirectionalLight;
  private nearLights: PointLight[] = [];
  private nearTarget: { pos: Vector3; power: number; color: Color }[] = [];
  private mechLight: PointLight;
  private lightScanT = 0;

  /** long-range marker lamps (enemies beyond ~40 m, closed barriers): constant on-screen size, additive, depth tested */
  private glints = new ParticleSystem(160, true);
  private shafts: LightShafts;
  private speedLines = new SpeedLines();
  private looks: SectorLook[] = [];
  private floorYs: number[] = [];
  /** currently blended sector look (fog / ambient colours as 0xRRGGBB) */
  private look: { fog: number; hemiSky: number; hemiGround: number; sun: number } = { fog: 0x33312e, hemiSky: 0xa9b2bc, hemiGround: 0x40372c, sun: 0xffeed8 };
  /** strength of the ambient lift on the stage surfaces that have no environment map (x hemisphere sky colour) */
  ambientK = AMBIENT_LIFT;
  private lookSnap = true;
  private dustAcc = 0;
  private dustRnd = mulberry32(0xd057);
  private mechBlob: Mesh;
  private enemyBlobs: InstancedMesh;
  private ghosts: GhostSlot[] = [];
  private ghostTimer = 0;

  private visTime = 0;
  private lastState: GameState | null = null;
  private lastTick = -1;
  private deathFx = false;
  private mechFloorY = NaN;
  private floorRayAge = 0;
  private floorRayX = 0;
  private floorRayY = 0;
  private floorRayZ = 0;
  /** number of blob-shadow rays cast so far (dev / verification) */
  floorRays = 0;
  private thrusterAcc = 0;
  private footAcc = 0;
  private enemiesVisible = 0;
  private lastStats: RenderStats | null = null;
  private disposed = false;

  constructor(private canvas: HTMLCanvasElement) {
    this.gl = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', stencil: false });
    // size the drawing buffer now, while the GPU is idle: a later setSize would wait for the environment map work queued below
    this.gl.setPixelRatio(1);
    this.gl.setSize(this.width, this.height, true);
    this.bufferKey = `${this.width}x${this.height}@1`;
    this.gl.toneMapping = ACESFilmicToneMapping;
    this.gl.toneMappingExposure = 1.1;
    this.gl.shadowMap.enabled = true;
    this.gl.shadowMap.type = PCFShadowMap;
    this.gl.setClearColor(0x1a1e24, 1);
    this.lib.setAnisotropy(Math.min(8, this.gl.capabilities.getMaxAnisotropy()));

    // image based lighting for the metals (generated in code, no assets)
    try {
      const pmrem = new PMREMGenerator(this.gl);
      // 128 px per cube face (the default 256 costs ~0.4 s of software-GL time at start-up; the room is soft and only feeds rough metals)
      const rt = pmrem.fromScene(new RoomEnvironment(), 0.04, 0.1, 100, { size: ENV_MAP_SIZE });
      this.env = rt.texture;
      pmrem.dispose();
    } catch {
      this.env = null;
    }
    // IBL only on the surfaces where it shows (metals / glass / the armour of the mech and the enemies / missiles): the scene has no
    // `environment`, so concrete, tiles and paint skip the cube-map lookups in their PBR shader. Set up again once the actors exist.
    this.scene.environment = null;
    // dusty, slightly warm air (the colour is blended toward the current sector's look every frame)
    this.scene.fog = new Fog(0x33312e, 60, 320);

    // sky dome
    this.sky = new Mesh(
      new SphereGeometry(1000, 24, 12),
      new ShaderMaterial({
        side: BackSide,
        depthWrite: false,
        fog: false,
        uniforms: { uHorizon: { value: new Color(0x2a2d33) }, uZenith: { value: new Color(0x0d1016) } },
        vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position = p.xyww; }',
        fragmentShader:
          'uniform vec3 uHorizon; uniform vec3 uZenith; varying vec3 vDir; void main(){ float h = clamp(vDir.y, 0.0, 1.0); vec3 c = mix(uHorizon, uZenith, pow(h, 0.6)); c += vec3(0.10,0.06,0.02) * exp(-abs(vDir.y) * 9.0); gl_FragColor = vec4(c, 1.0); }',
      }),
    );
    this.sky.renderOrder = -100;
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);

    // lights: hemisphere + one directional (no shadow map) + nearest ceiling lights + a fill light on the mech
    this.hemi = new HemisphereLight(0x9db2c8, 0x40372c, 1.05);
    this.sun = new DirectionalLight(0xffefd8, 1.5);
    this.sun.position.set(-30, 60, 25);
    this.scene.add(this.hemi, this.sun, this.sun.target);
    for (let i = 0; i < NEAR_LIGHTS; i++) {
      const l = new PointLight(0xffe4b8, 0, 46, 2);
      this.scene.add(l);
      this.nearLights.push(l);
      this.nearTarget.push({ pos: new Vector3(), power: 0, color: new Color(0xffe4b8) });
    }
    this.mechLight = new PointLight(0xcfe0ff, 26, 15, 2);
    this.scene.add(this.mechLight);

    this.shafts = new LightShafts();
    this.scene.add(this.shafts.mesh);
    this.glints.points.renderOrder = 21;
    this.scene.add(this.glints.points);
    this.scene.add(this.speedLines.mesh);

    // actors
    this.mech = new MechModel(this.lib);
    this.scene.add(this.mech.root);
    this.enemyMats = createEnemyMaterials(this.lib);
    this.enemyShared = createEnemyShared();
    this.scene.add(this.enemyGroup);
    this.effects = new Effects();
    this.scene.add(this.effects.group);
    this.applyEnvironment();

    // blob shadows (cheap contact shadows; no shadow maps in the game scene)
    const blobGeo = new PlaneGeometry(1, 1);
    blobGeo.rotateX(-Math.PI / 2);
    const blobTex = this.lib.texture('blob');
    this.mechBlob = new Mesh(
      blobGeo,
      new MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, fog: true, color: 0x000000 }),
    );
    this.mechBlob.renderOrder = 2;
    this.mechBlob.visible = false;
    this.scene.add(this.mechBlob);
    this.enemyBlobs = new InstancedMesh(
      blobGeo,
      new MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, color: 0x000000 }),
      64,
    );
    this.enemyBlobs.count = 0;
    this.enemyBlobs.frustumCulled = false;
    this.enemyBlobs.renderOrder = 2;
    this.scene.add(this.enemyBlobs);

    // afterimages for quick boost (silhouette copies of the mech, additive)
    const ghostGeo = this.mech.ghostSilhouette().build();
    for (let i = 0; i < GHOSTS; i++) {
      const mat = new MeshBasicMaterial({ color: 0x5fd0ff, transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false, toneMapped: false });
      const mesh = new Mesh(ghostGeo, mat);
      mesh.visible = false;
      mesh.renderOrder = 12;
      this.scene.add(mesh);
      this.ghosts.push({ mesh, mat, age: 0, active: false });
    }
    this.resize(1280, 720, 1);
  }

  // ------------------------------------------------------------------------------------------------------- contract
  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    this.width = Math.max(1, Math.floor(cssWidth));
    this.height = Math.max(1, Math.floor(cssHeight));
    this.requestedDpr = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
    this.windowDpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    this.dpr = effectivePixelRatio(this.width, this.height, this.requestedDpr);
    // setSize / setPixelRatio reallocate the drawing buffer (a synchronous GPU round trip): skip them when nothing changed
    const key = `${this.width}x${this.height}@${this.dpr}`;
    if (key !== this.bufferKey) {
      this.bufferKey = key;
      this.gl.setPixelRatio(this.dpr);
      this.gl.setSize(this.width, this.height, true);
    }
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.hangar?.setAspect(this.width / this.height);
    this.effects.setView(this.gl.domElement.height, this.camera.fov);
    this.glints.setView(this.gl.domElement.height, this.camera.fov);
  }

  /** current drawing-buffer size [px] and the pixel ratio actually used (dev / verification) */
  get bufferInfo(): { cssWidth: number; cssHeight: number; dpr: number; bufferWidth: number; bufferHeight: number } {
    const c = this.gl.domElement;
    return { cssWidth: this.width, cssHeight: this.height, dpr: this.dpr, bufferWidth: c.width, bufferHeight: c.height };
  }

  /** `compile` false: only build the meshes / materials; call compileStage() later (the app builds the stage while the hangar is on screen) */
  setStage(stage: StageDef, compile = true): void {
    this.clearStage();
    this.stage = stage;
    this.stageMesh = buildStageMeshes(stage, this.lib, this.chunkOpts);
    this.chunkSpheres = this.stageMesh.chunks.map((c) => {
      const bs = c.geometry.boundingSphere;
      return { cx: bs?.center.x ?? 0, cy: bs?.center.y ?? 0, cz: bs?.center.z ?? 0, r: bs?.radius ?? 0 };
    });
    this.scene.add(this.stageMesh.group);
    this.vis = new SectorVisibility(stage);
    this.looks = stage.sectors.map((sd) => sectorLook(sd));
    this.floorYs = stage.sectors.map((sd) => sd.floorY);
    this.visFlags = new Uint8Array(this.vis.count);
    this.barrierById = this.barrierGroups();
    this.buildBarrierGuides(stage);
    this.buildEscapeBeacon(stage);
    this.nearTarget.forEach((t) => (t.power = 0));
    this.lightScanT = 0;
    this.resetVisuals();
    this.stageCompiled = false;
    if (compile) this.compileStage();
  }

  /** compile every shader variant of the game scene now (incl. hidden effect meshes) so the first beam / explosion does not hitch */
  compileStage(): void {
    if (this.stageCompiled || !this.stage) return;
    this.stageCompiled = true;
    try {
      this.gl.compile(this.scene, this.camera);
    } catch {
      /* compile is an optimisation only */
    }
  }

  showHangar(loadout: Loadout): void {
    this.ensureHangar(loadout);
    this.hangar!.setLoadout(loadout);
    this.hangar!.reset();
    this.hangarLoadout = { ...loadout };
  }

  setHangarLoadout(loadout: Loadout): void {
    this.ensureHangar(loadout);
    this.hangar!.setLoadout(loadout);
    this.hangarLoadout = { ...loadout };
  }

  showGame(): void {
    this.resetVisuals();
  }

  render(state: GameState, events: GameEvent[], frameDt: number): void {
    if (this.disposed) return;
    const dt = Math.min(Math.max(Number.isFinite(frameDt) ? frameDt : 0, 0), 0.1);
    // the window moved to a display with another devicePixelRatio (browser zoom / monitor change): re-apply without a resize event
    if (typeof window !== 'undefined' && (window.devicePixelRatio || 1) !== this.windowDpr) this.resize(this.width, this.height, window.devicePixelRatio || 1);
    if (state.mode === 'garage') {
      STAGE_AMBIENT.setRGB(0, 0, 0); // the hangar scene has its own environment lighting
      this.ensureHangar(this.hangarLoadout ?? state.loadout);
      this.hangar!.update(dt);
      if (this.hangarSkipped < HANGAR_WAIT_FRAMES) {
        this.hangarSkipped++;
        return;
      }
      this.gl.render(this.hangar!.scene, this.hangar!.camera);
      this.framesDrawn++;
      this.lastStats = null;
      return;
    }
    if (state.stage !== this.stage) this.setStage(state.stage);
    else this.compileStage(); // no-op unless the stage was built without compiling (app warm-up)
    if (state !== this.lastState || state.tick < this.lastTick) this.resetVisuals();
    this.lastState = state;
    this.lastTick = state.tick;

    const paused = state.mode === 'paused';
    const vdt = paused ? 0 : dt;
    this.visTime += vdt;

    this.applyCamera(state);
    this.glints.resetManual();
    if (!paused) this.processEvents(state, events);
    this.updatePlayer(state, vdt);
    this.updateBarriers(state, vdt);
    this.cullStage(state);
    this.updateEnemies(state, vdt);
    this.glints.commit();
    this.effects.syncBullets(state.bullets, state.enemyBullets, state.missiles, vdt);
    this.effects.viewPos.x = this.camera.position.x;
    this.effects.viewPos.y = this.camera.position.y;
    this.effects.viewPos.z = this.camera.position.z;
    this.effects.update(vdt);
    this.updateGhosts(vdt);
    this.updateLights(state, vdt);
    this.updateAtmosphere(state, vdt);
    // the whole factory is one closed shell: the sky dome is a full-screen pass that nothing can ever see, so it is only drawn
    // for a stage without sectors (the clear colour equals the fog colour, so a gap would still blend in)
    this.sky.visible = !this.vis || this.vis.count === 0;
    this.sky.position.copy(this.camera.position);

    this.gl.render(this.scene, this.camera);
    this.framesDrawn++;
    this.captureStats();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearStage();
    this.effects.dispose();
    this.glints.dispose();
    this.speedLines.dispose();
    this.shafts.dispose();
    this.mech.dispose();
    for (const e of this.enemies.values()) e.dispose();
    this.enemies.clear();
    this.hangar?.dispose();
    // everything left in the scene graphs (sky, blobs, ghosts, lights' helpers...) + shared materials
    const disposeTree = (root: Object3D): void =>
      root.traverse((o) => {
        const m = o as Mesh;
        if (m.geometry) m.geometry.dispose();
        const mat = m.material as Material | Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose();
        if ((o as InstancedMesh).isInstancedMesh) (o as InstancedMesh).dispose();
      });
    disposeTree(this.scene);
    if (this.hangar) disposeTree(this.hangar.scene);
    this.enemyShared.glowSphere.dispose();
    this.enemyShared.ring.dispose();
    this.enemyShared.pillar.dispose();
    this.enemyShared.diamond.dispose();
    this.lib.disposeAll();
    for (const t of this.guideTex) t.dispose();
    this.env?.dispose();
    this.gl.dispose();
  }

  /** dev/verification helper (not part of the contract): numbers from the last game-scene frame */
  getStats(): RenderStats | null {
    return this.lastStats;
  }
  /** dev/verification helper */
  get effectStats() {
    return this.effects.stats();
  }
  get effectPoolObjects(): number {
    return this.effects.poolObjectCount;
  }
  /** dev / verification: submitted draw calls of the last frame split by owner (visible + inside the frustum; approximate for instanced groups) */
  drawBreakdown(): { stage: number; barriers: number; enemies: number; mech: number; effects: number; other: number } {
    const out = { stage: 0, barriers: 0, enemies: 0, mech: 0, effects: 0, other: 0 };
    this.projView.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    const fr = new Frustum().setFromProjectionMatrix(this.projView);
    const walk = (o: Object3D, bucket: keyof typeof out): void => {
      if (!o.visible) return;
      const m = o as Mesh;
      if (m.isMesh || (o as unknown as { isPoints?: boolean }).isPoints) {
        if (!o.frustumCulled || fr.intersectsObject(m)) out[bucket]++;
      }
      for (const c of o.children) walk(c, bucket);
    };
    for (const c of this.scene.children) {
      if (c === this.stageMesh?.group) {
        for (const ch of c.children) walk(ch, (ch as Mesh).name.startsWith('barrier:') ? 'barriers' : 'stage');
      } else if (c === this.enemyGroup) walk(c, 'enemies');
      else if (c === this.mech.root) walk(c, 'mech');
      else if (c === this.effects.group) walk(c, 'effects');
      else walk(c, 'other');
    }
    return out;
  }
  /** dev/verification helper: number of objects in the game scene graph (must stay constant during play) */
  get sceneObjectCount(): number {
    let n = 0;
    this.scene.traverse(() => n++);
    return n;
  }
  /** dev/verification helper: GL resources currently alive */
  get glResources(): { geometries: number; textures: number; programs: number } {
    const m = this.gl.info.memory;
    return { geometries: m.geometries, textures: m.textures, programs: this.gl.info.programs?.length ?? 0 };
  }
  /** verification helper: where the visible weapon's barrel tip / bore currently point (world space) */
  weaponAlignment(): { tip: V3; dir: V3 } {
    const w = this.mech.weaponTipWorld();
    return { tip: { x: w.tip.x, y: w.tip.y, z: w.tip.z }, dir: { x: w.dir.x, y: w.dir.y, z: w.dir.z } };
  }
  get webgl(): WebGLRenderer {
    return this.gl;
  }
  get activeCamera(): PerspectiveCamera {
    return this.camera;
  }

  // ------------------------------------------------------------------------------------------------------- internals
  /** hand the environment map to the materials that should reflect it (see the constructor) */
  private applyEnvironment(): void {
    const env = this.env;
    this.lib.setEnvironment(env, ENV_INTENSITY);
    this.effects.setEnvironment(env, ENV_INTENSITY);
    const actors = [this.mech.mats, this.enemyMats] as Record<string, Material>[];
    for (const set of actors) {
      for (const m of Object.values(set)) {
        const sm = m as MeshStandardMaterial;
        if (!sm.isMeshStandardMaterial) continue;
        if (sm.envMap !== env) sm.needsUpdate = true;
        sm.envMap = env;
        sm.envMapIntensity = ENV_INTENSITY;
      }
    }
  }

  private ensureHangar(loadout: Loadout): void {
    if (this.hangar) return;
    this.hangar = new HangarScene(this.lib, this.env, loadout);
    this.hangar.setAspect(this.width / this.height);
    this.hangarSkipped = 0;
    try {
      this.gl.compile(this.hangar.scene, this.hangar.camera);
    } catch {
      /* optimisation only */
    }
  }

  private captureStats(): void {
    const info = this.gl.info;
    const es = this.effects.stats();
    this.lastStats = {
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      textureBytes: this.lib.textureBytes,
      stageChunks: this.stageMesh?.stats.chunks ?? 0,
      stageChunksVisible: this.chunksVisible,
      sectorsVisible: this.sectorsVisible,
      sectorsTotal: this.visFlags.length,
      stageTriangles: this.stageMesh?.stats.triangles ?? 0,
      stageBoxes: this.stageMesh?.stats.boxes ?? 0,
      stageDecor: this.stageMesh?.stats.decor ?? 0,
      enemiesVisible: this.enemiesVisible,
      additiveParticles: es.additiveParticles,
      smokeParticles: es.smokeParticles,
      markers: this.glints.aliveCount,
      lightShafts: this.shafts.count,
      speedLines: this.speedLines.active,
    };
  }

  private clearStage(): void {
    this.vis = null;
    this.visFlags = new Uint8Array(0);
    this.barrierById.clear();
    if (this.stageMesh) {
      this.scene.remove(this.stageMesh.group);
      this.stageMesh.group.traverse((o) => {
        const m = o as Mesh;
        if (m.isMesh) m.geometry.dispose();
      });
      for (const b of this.stageMesh.barrierBoxes) b.material.dispose();
      this.stageMesh = null;
    }
    for (const g of this.barrierGuides.values()) {
      this.scene.remove(g.group);
      g.group.traverse((o) => {
        const m = o as Mesh;
        if (m.isMesh) m.geometry.dispose();
      });
      g.frameMat.dispose();
      g.pillarMat?.dispose();
      (g.chevron?.material as Material | undefined)?.dispose();
    }
    this.barrierGuides.clear();
    this.barrierSeen.clear();
    for (const t of this.guideTex) t.dispose();
    this.guideTex = [];
    if (this.escapeBeacon) {
      this.scene.remove(this.escapeBeacon.group);
      this.escapeBeacon.pillar.geometry.dispose();
      this.escapeBeacon.ring.geometry.dispose();
      this.escapeBeacon.mat.dispose();
      this.escapeBeacon.ringMat.dispose();
      this.escapeBeacon = null;
    }
  }

  /** everything transient goes back to the initial look (new sortie / new state object) */
  private resetVisuals(): void {
    this.effects.clear();
    for (const g of this.ghosts) {
      g.active = false;
      g.mesh.visible = false;
    }
    for (const e of this.enemies.values()) e.setDead(false);
    if (this.stageMesh) {
      for (const b of this.stageMesh.barrierBoxes) {
        b.open = 0;
        b.opening = false;
        b.mesh.visible = true;
        b.mesh.position.set(0, 0, 0);
        b.mesh.updateMatrix();
      }
    }
    this.barrierSeen.clear();
    for (const g of this.barrierGuides.values()) {
      g.group.visible = false;
      g.fade = 0;
      g.open = false;
    }
    this.mech.root.visible = true;
    this.deathFx = false;
    this.lookSnap = true;
    this.mechFloorY = NaN;
    this.mechBlob.visible = false;
    this.visTime = 0;
  }

  private applyCamera(state: GameState): void {
    if (applySimCamera(this.camera, state.camera, this.width / this.height)) {
      this.effects.setView(this.gl.domElement.height, this.camera.fov);
      this.glints.setView(this.gl.domElement.height, this.camera.fov);
    }
  }

  /**
   * Which stage chunks are submitted this frame:
   *  1. sector visibility (visibility.ts): the camera / player sector plus the sectors reachable through open portals that are
   *     inside the view frustum. Sectors behind walls, above / below, or behind a closed barrier are not drawn at all.
   *  2. chunks entirely inside the fog wall (far areas) are skipped.
   * The GPU-side frustum test (three.js bounding spheres) handles the rest.
   */
  private cullStage(state: GameState): void {
    const sm = this.stageMesh;
    if (!sm) return;
    const fog = this.scene.fog as Fog;
    const lim = fog.far + 10;
    const cam = this.camera.position;
    const vis = this.vis;
    const flags = this.visFlags;
    if (vis && this.sectorCulling) {
      this.projView.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
      const blocked = (id: string): boolean => {
        const boxes = this.barrierById.get(id);
        if (!boxes) return false;
        for (const b of boxes) if (b.open > 0 || b.opening) return false;
        return true;
      };
      this.sectorsVisible = vis.compute(cam, state.player.pos, this.projView, blocked, lim, flags);
    } else {
      flags.fill(1);
      this.sectorsVisible = flags.length;
    }
    let nv = 0;
    for (let i = 0; i < sm.chunks.length; i++) {
      const c = this.chunkSpheres[i];
      const sec = sm.chunkSector[i];
      let show = sec < 0 || flags[sec] === 1;
      if (show) {
        const dx = c.cx - cam.x;
        const dy = c.cy - cam.y;
        const dz = c.cz - cam.z;
        show = Math.sqrt(dx * dx + dy * dy + dz * dz) - c.r < lim;
      }
      sm.chunks[i].visible = show;
      if (show) nv++;
    }
    this.chunksVisible = nv;
  }

  // ------------------------------------------------------------------ player
  private aimDirection(state: GameState, muzzle: V3): V3 {
    return visualAimDirection(state, muzzle);
  }

  private updatePlayer(state: GameState, dt: number): void {
    const p = state.player;
    const muzzle = playerMuzzlePosition(p);
    const aim = this.aimDirection(state, muzzle);
    const dead = p.hp <= 0;
    if (dead && !this.deathFx) {
      this.deathFx = true;
      this.effects.explosion({ x: p.pos.x, y: p.pos.y, z: p.pos.z }, 3.2);
      this.mech.root.visible = false;
      this.mechBlob.visible = false;
    }
    if (!dead && this.deathFx) {
      this.deathFx = false;
      this.mech.root.visible = true;
    }
    if (dead) return;
    // when the TPS camera is squeezed against a wall right behind the mech, don't let the model fill the screen
    const cp = this.camera.position;
    const camDist = Math.hypot(cp.x - p.pos.x, cp.y - (p.pos.y + 0.5), cp.z - p.pos.z);
    this.mech.root.visible = camDist > 1.7;
    const frame: MechFrame = {
      dt,
      time: this.visTime,
      pos: p.pos,
      vel: p.vel,
      yaw: p.yaw,
      pitch: p.pitch,
      grounded: p.grounded,
      vertical: p.mv.verticalMode,
      horizontal: p.mv.horizontalMode,
      thrusting: p.mv.thrusting,
      qbRemaining: p.mv.qbImpulseRemaining,
      qbDir: p.mv.qbDir,
      weapon: p.weapon,
      muzzle,
      aimDir: aim,
      legs: state.loadout.legs,
    };
    this.mech.update(frame);

    // continuous mech effects (rate based -> independent of the frame rate)
    if (dt > 0) {
      const m = this.mech;
      const str = m.flameStrength;
      if (str > 0.2) {
        const blue0 = m.qbActive ? 1 : 0;
        for (const n of m.nozzleWorld) {
          this.effects.additive.emit({
            x: n.x, y: n.y, z: n.z, life: 0.05, size0: 0.5 + 0.55 * str, size1: 0.3,
            c0: blue0 ? [0.55, 0.85, 1] : [1, 0.6, 0.25], c1: blue0 ? [0.3, 0.5, 1] : [1, 0.3, 0.08], a0: 0.55, a1: 0.1,
          });
        }
      }
      if (str > 0.45) {
        this.thrusterAcc += dt * (70 + 60 * str);
        const blue = m.qbActive ? 1 : 0;
        while (this.thrusterAcc >= 1) {
          this.thrusterAcc -= 1;
          for (const n of m.nozzleWorld) {
            const sp = 7 + 12 * str;
            this.effects.additive.emit({
              x: n.x, y: n.y, z: n.z,
              vx: m.flameWorldDir.x * sp + (Math.random() - 0.5) * 1.6,
              vy: m.flameWorldDir.y * sp + (Math.random() - 0.5) * 1.6,
              vz: m.flameWorldDir.z * sp + (Math.random() - 0.5) * 1.6,
              life: 0.16 + 0.1 * str, size0: 0.34 + 0.1 * str, size1: 0.1,
              c0: blue ? [0.6, 0.9, 1] : [1, 0.75, 0.35], c1: blue ? [0.2, 0.4, 1] : [1, 0.25, 0.05], a0: 0.85, a1: 0,
            });
          }
        }
      } else this.thrusterAcc = 0;
      const speed = m.speed;
      if (p.grounded && speed > 13 && p.mv.horizontalMode !== 'walk') {
        this.footAcc += dt * 70;
        while (this.footAcc >= 1) {
          this.footAcc -= 1;
          const f = m.footWorld[Math.random() < 0.5 ? 0 : 1];
          const vx = p.vel.x;
          const vz = p.vel.z;
          const l = Math.hypot(vx, vz) || 1;
          this.effects.additive.emit({
            x: f.x, y: f.y + 0.05, z: f.z,
            vx: -vx / l * (6 + Math.random() * 8) + (Math.random() - 0.5) * 3, vy: 2 + Math.random() * 4, vz: -vz / l * (6 + Math.random() * 8) + (Math.random() - 0.5) * 3,
            life: 0.25 + 0.2 * Math.random(), size0: 0.12, size1: 0.04, c0: [1, 0.85, 0.5], c1: [1, 0.3, 0.05], a0: 1, a1: 0, drag: 0.8, gravity: 20,
          });
        }
      } else this.footAcc = 0;
    }

    // afterimages while boosting fast
    const boosting = p.mv.qbImpulseRemaining > 0 || p.mv.horizontalMode === 'quickboost';
    const fast = this.mech.speed > 32;
    if (dt > 0 && (boosting || fast) && this.mech.speed > 28) {
      this.ghostTimer -= dt;
      if (this.ghostTimer <= 0) {
        this.ghostTimer = 0.035;
        this.spawnGhost();
      }
    } else this.ghostTimer = 0;

    // blob shadow under the mech: the floor is looked up with a ray only when the mech moved / a few frames passed (the floor
    // under it changes slowly, and a ray per frame is wasted work)
    this.floorRayAge++;
    const moved = Math.hypot(p.pos.x - this.floorRayX, p.pos.z - this.floorRayZ) > 1.2 || Math.abs(p.pos.y - this.floorRayY) > 0.8;
    if (Number.isNaN(this.mechFloorY) || (dt > 0 && (moved || this.floorRayAge >= FLOOR_RAY_EVERY))) {
      const hit = state.world.raycast(p.pos, { x: 0, y: -1, z: 0 }, 80);
      this.mechFloorY = hit ? hit.point.y : NaN;
      this.floorRayAge = 0;
      this.floorRayX = p.pos.x;
      this.floorRayY = p.pos.y;
      this.floorRayZ = p.pos.z;
      this.floorRays++;
    }
    if (Number.isFinite(this.mechFloorY)) {
      const h = Math.max(0, p.pos.y - PLAYER.HALF.y - this.mechFloorY);
      const k = 1 - Math.min(h / 30, 1);
      this.mechBlob.visible = k > 0.05;
      this.mechBlob.position.set(p.pos.x, this.mechFloorY + 0.03, p.pos.z);
      const sc = 3.2 * (1 + h * 0.03);
      this.mechBlob.scale.set(sc, 1, sc);
      (this.mechBlob.material as MeshBasicMaterial).opacity = 0.62 * k;
    } else this.mechBlob.visible = false;

    // fill light follows the mech
    this.mechLight.position.set(p.pos.x + 1.5, p.pos.y + 4.2, p.pos.z + 2.5);
  }

  private spawnGhost(): void {
    const g = this.ghosts.find((x) => !x.active) ?? this.ghosts.reduce((a, b) => (a.age > b.age ? a : b));
    g.active = true;
    g.age = 0;
    g.mesh.visible = true;
    const r = this.mech.root;
    g.mesh.position.set(r.position.x, r.position.y + this.mech.body.position.y, r.position.z);
    g.mesh.rotation.set(this.mech.torso.rotation.x * 0.6, this.mech.bodyYaw, this.mech.torso.rotation.z * 0.6, 'YXZ');
  }

  private updateGhosts(dt: number): void {
    for (const g of this.ghosts) {
      if (!g.active) continue;
      g.age += dt;
      const f = g.age / GHOST_LIFE;
      if (f >= 1) {
        g.active = false;
        g.mesh.visible = false;
        continue;
      }
      // fade out with age and near the camera so afterimages never hide the crosshair
      const dx = g.mesh.position.x - this.camera.position.x;
      const dy = g.mesh.position.y - this.camera.position.y;
      const dz = g.mesh.position.z - this.camera.position.z;
      const d = Math.hypot(dx, dy, dz);
      const near = Math.min(1, Math.max(0, (d - 3) / 7));
      g.mat.opacity = 0.38 * (1 - f) * (1 - f) * near;
      g.mesh.scale.setScalar(1 - 0.05 * f);
    }
  }

  private processEvents(state: GameState, events: GameEvent[]): void {
    const n = Math.min(events.length, MAX_EVENTS_PER_FRAME);
    for (let i = events.length - n; i < events.length; i++) {
      const ev = events[i];
      // A shot fired a tick or two ago started at the muzzle of that moment; the mech has moved on since (up to ~1 m during a QB),
      // so the flash / beam line of a fresh shot is drawn from the barrel tip as it is NOW (the sim origin stays the source of truth
      // for the projectile itself - only the decoration follows the drawn gun).
      if ((ev.type === 'mgFire' || ev.type === 'beamFire' || ev.type === 'missileFire') && state.time - ev.time <= FRESH_SHOT_SECONDS) {
        const m = playerMuzzlePosition(state.player);
        this.effects.handle({ ...ev, origin: { x: m.x, y: m.y, z: m.z } });
      } else this.effects.handle(ev);
      switch (ev.type) {
        case 'mgFire':
          this.mech.onFire('machinegun');
          break;
        case 'beamFire':
          this.mech.onFire('beam');
          break;
        case 'missileFire':
          this.mech.onFire('missile');
          break;
        case 'land':
          this.mech.onLand(ev.impactSpeed);
          break;
        case 'jump':
          this.mech.onJump();
          break;
        case 'playerHit': {
          this.mech.onHit();
          const p = state.player.pos;
          const d = ev.dirToSource;
          this.effects.handle({ type: 'hit', time: ev.time, pos: { x: p.x + d.x * 1.0, y: p.y + d.y * 0.6 + 0.3, z: p.z + d.z * 1.0 }, normal: d, on: 'player', weapon: 'enemy' });
          break;
        }
        case 'barrierOpen': {
          const g = this.barrierGuides.get(ev.barrierId);
          const b = state.stage.barriers.find((x) => x.id === ev.barrierId);
          if (b) {
            this.effects.explosion({ x: b.pos.x, y: b.pos.y, z: b.pos.z }, 0.9);
          }
          void g;
          break;
        }
        case 'gateOpen': {
          const b = state.stage.barriers.find((x) => x.isFinal);
          if (b) this.effects.explosion({ x: b.pos.x, y: b.pos.y, z: b.pos.z }, 1.2);
          break;
        }
        default:
          break;
      }
    }
  }

  // ------------------------------------------------------------------ enemies
  private ensureEnemy(e: GameState['enemies'][number]): EnemyModel {
    let m = this.enemies.get(e.id);
    if (!m) {
      m = new EnemyModel(e, this.enemyMats, this.enemyShared);
      this.enemies.set(e.id, m);
      this.enemyGroup.add(m.root);
    }
    return m;
  }

  private updateEnemies(state: GameState, dt: number): void {
    const cam = this.camera.position;
    let vis = 0;
    let blobN = 0;
    const world = state.world;
    for (const e of state.enemies) {
      const m = this.ensureEnemy(e);
      const dx = e.pos.x - cam.x;
      const dy = e.pos.y - cam.y;
      const dz = e.pos.z - cam.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > FAR_ENEMY_HIDE * FAR_ENEMY_HIDE) {
        m.root.visible = false;
        continue;
      }
      // enemies in sectors that cannot be seen from here (behind walls / closed barriers) are not drawn
      if (this.vis && this.sectorCulling) {
        const sec = this.vis.sectorAt(e.pos);
        if (sec >= 0 && this.visFlags[sec] === 0) {
          m.root.visible = false;
          continue;
        }
      }
      m.root.visible = true;
      vis++;
      const detailed = d2 < DETAIL_ENEMY_DIST * DETAIL_ENEMY_DIST;
      m.update(e, state.player.pos, dt, this.visTime, detailed);
      this.emitEnemyGlint(e, Math.sqrt(d2));
      if (e.alive && e.telegraph > 0) this.emitTelegraphGlint(e, m, Math.sqrt(d2));
      // floor height for the blob shadow (cached; guards refresh a few times per second)
      const cfg = ENEMIES[e.kind];
      if (Number.isNaN(m.floorY) || (e.kind === 'guard' && e.alive && ((state.tick + e.id.charCodeAt(2)) & 31) === 0)) {
        const hit = world.raycast(e.pos, { x: 0, y: -1, z: 0 }, 12);
        m.floorY = hit ? hit.point.y : e.pos.y - cfg.centerHeight;
      }
      if (blobN < 64) {
        const s = e.kind === 'turret' ? 4.0 : e.alive ? 3.0 : 3.4;
        DUMMY.position.set(e.pos.x, m.floorY + 0.03, e.pos.z);
        DUMMY.scale.set(s, 1, s);
        DUMMY.quaternion.identity();
        DUMMY.updateMatrix();
        this.enemyBlobs.setMatrixAt(blobN++, DUMMY.matrix);
      }
    }
    this.enemyBlobs.count = blobN;
    this.enemyBlobs.instanceMatrix.needsUpdate = true;
    this.enemiesVisible = vis;
  }


  /**
   * Long-range marker lamp on a live enemy: from ~40 m out it keeps a constant on-screen size (a few pixels) so guards and turrets
   * can be told from the factory background at 100 m+. Colour: guard amber -> orange when alert, turret magenta, control turret red.
   * Purely additive and small; it never covers the crosshair (aim is at the body, the lamp sits on the head).
   */
  private emitEnemyGlint(e: GameState['enemies'][number], d: number): void {
    if (!e.alive || d < 34) return;
    const t = Math.min(1, Math.max(0, (d - 34) / 46));
    const k = t * t * (3 - 2 * t);
    const turret = e.kind === 'turret';
    const alert = e.alert || e.telegraph > 0;
    const size = d * 0.02 * (e.isGateControl ? 1.4 : 1) * (e.telegraph > 0 ? 1.5 : 1);
    const c: readonly [number, number, number] = turret ? (e.isGateControl ? [1, 0.22, 0.16] : [1, 0.3, 0.6]) : alert ? [1, 0.42, 0.14] : [1, 0.74, 0.3];
    this.glints.emit({ x: e.pos.x, y: e.pos.y + (turret ? 0.9 : 1.0), z: e.pos.z, life: 1, size0: size, c0: c, a0: k * (alert ? 1 : 0.78) });
  }

  /** the pre-fire warning: a lamp on the barrel tip that swells while the charge builds (readable at any distance, even in the far LOD) */
  private emitTelegraphGlint(e: GameState['enemies'][number], m: EnemyModel, d: number): void {
    const tip = m.tipWorld(e, _tip);
    const turret = e.kind === 'turret';
    const t = Math.min(1, Math.max(0, e.telegraph));
    const size = Math.max(turret ? 0.9 : 0.7, d * 0.026) * (0.55 + 0.75 * t);
    const blink = Math.sin(this.visTime * 70) > -0.35 ? 1 : 0.55;
    this.glints.emit({ x: tip.x, y: tip.y, z: tip.z, life: 1, size0: size, c0: turret ? [1, 0.35, 0.65] : [1, 0.62, 0.22], a0: (0.5 + 0.5 * t) * blink });
  }

  /** flashing amber / red lamps on the four top corners of every closed barrier (visible from far away, from both sides) */
  private emitBarrierLamps(b: BarrierBoxVisual, t: number): void {
    const cam = this.camera.position;
    const cx = b.center.x;
    const cy = b.center.y;
    const cz = b.center.z;
    const d = Math.hypot(cx - cam.x, cy - cam.y, cz - cam.z);
    if (d > 260 || b.open > 0 || b.opening) return;
    const thinX = b.size.x <= b.size.z;
    const top = b.box.max.y - 0.7;
    const off = (thinX ? b.size.x : b.size.z) / 2 + 0.45;
    const size = Math.max(0.9, d * 0.02);
    for (let corner = 0; corner < 2; corner++) {
      const c = corner === 0 ? -1 : 1;
      const lat = (thinX ? b.size.z : b.size.x) / 2 - 0.9;
      const on = Math.sin(t * 5 + corner * Math.PI + b.boxIndex) > -0.25;
      if (!on) continue;
      for (const side of [-1, 1]) {
        const x = thinX ? cx + side * off : cx + c * lat;
        const z = thinX ? cz + c * lat : cz + side * off;
        this.glints.emit({ x, y: top, z, life: 1, size0: size, c0: corner === 0 ? [1, 0.95, 0.6] : [1, 0.6, 0.5], a0: 1 });
      }
    }
  }

  // ------------------------------------------------------------------ barriers / guides
  private barrierGroups(): Map<string, BarrierBoxVisual[]> {
    const map = new Map<string, BarrierBoxVisual[]>();
    for (const b of this.stageMesh?.barrierBoxes ?? []) {
      const a = map.get(b.barrierId) ?? [];
      a.push(b);
      map.set(b.barrierId, a);
    }
    return map;
  }

  private buildBarrierGuides(stage: StageDef): void {
    const groups = this.barrierGroups();
    for (const [id, boxes] of groups) {
      const mn = new Vector3(Infinity, Infinity, Infinity);
      const mx = new Vector3(-Infinity, -Infinity, -Infinity);
      for (const b of boxes) {
        mn.min(new Vector3(b.box.min.x, b.box.min.y, b.box.min.z));
        mx.max(new Vector3(b.box.max.x, b.box.max.y, b.box.max.z));
      }
      const ext = new Vector3().subVectors(mx, mn);
      const thin = ext.x <= ext.y && ext.x <= ext.z ? 0 : ext.y <= ext.z ? 1 : 2;
      const group = new Group();
      group.name = `guide:${id}`;
      const gb = new GeoBuilder();
      const t = 0.32;
      const inset = 0.05;
      const ax = [0, 1, 2].filter((a) => a !== thin);
      const [a0, a1] = ax;
      const lo = [mn.x, mn.y, mn.z];
      const hi = [mx.x, mx.y, mx.z];
      const box = (u0: number, u1: number, v0: number, v1: number): void => {
        const min = [0, 0, 0];
        const max = [0, 0, 0];
        // a slim ring on the middle plane of the passage (full-depth bars looked like translucent green slabs)
        min[thin] = (lo[thin] + hi[thin]) / 2 - 0.25;
        max[thin] = (lo[thin] + hi[thin]) / 2 + 0.25;
        min[a0] = u0;
        max[a0] = u1;
        min[a1] = v0;
        max[a1] = v1;
        gb.addBox({ x: min[0], y: min[1], z: min[2] }, { x: max[0], y: max[1], z: max[2] }, { tile: 1, color: [1, 1, 1] });
      };
      // frame bars just inside the opening (left/right/top for vertical walls)
      box(lo[a0] + inset, lo[a0] + inset + t, lo[a1] + inset, hi[a1] - inset);
      box(hi[a0] - inset - t, hi[a0] - inset, lo[a1] + inset, hi[a1] - inset);
      box(lo[a0] + inset, hi[a0] - inset, hi[a1] - inset - t, hi[a1] - inset);
      const frameMat = new MeshBasicMaterial({ color: 0x40ff96, vertexColors: true, toneMapped: false, transparent: true, opacity: 1, depthWrite: false });
      group.add(new Mesh(gb.build(), frameMat));
      let chevron: Mesh | null = null;
      // direction of travel through the opening (from the portal's first sector toward its second)
      const dir = thin !== 1 ? this.passDirection(stage, id, thin, (lo[thin] + hi[thin]) / 2) : 0;
      const path = thin !== 1 ? { origin: new Vector3((lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2), dir: new Vector3(thin === 0 ? dir : 0, 0, thin === 2 ? dir : 0) } : null;
      if (thin !== 1 && hasCanvas()) {
        // chevrons on the floor in the direction of travel
        const w = Math.max(3, ext[thin === 0 ? 'z' : 'x'] * 0.8);
        const len = 10;
        const tex = this.lib.texture('chevron').clone();
        tex.needsUpdate = true;
        tex.repeat.set(1, len / 5);
        this.guideTex.push(tex);
        const geo = new PlaneGeometry(w, len);
        const mat = new MeshBasicMaterial({ map: tex, color: 0x50ff9a, transparent: true, opacity: 0.85, blending: AdditiveBlending, depthWrite: false, toneMapped: false, side: DoubleSide });
        chevron = new Mesh(geo, mat);
        chevron.frustumCulled = false;
        chevron.renderOrder = 3;
        // plane: local +Y -> travel direction on the floor
        const cx = (lo[0] + hi[0]) / 2;
        const cz = (lo[2] + hi[2]) / 2;
        chevron.position.set(cx + (thin === 0 ? dir * len * 0.5 : 0), lo[1] + 0.08, cz + (thin === 2 ? dir * len * 0.5 : 0));
        _q.setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2);
        const dx = thin === 0 ? dir : 0;
        const dz = thin === 2 ? dir : 0;
        const yaw = Math.atan2(-dx, -dz);
        _q2.setFromAxisAngle(V_UP, yaw);
        chevron.quaternion.copy(_q2.multiply(_q));
        group.add(chevron);
      }
      let pillar: Mesh | null = null;
      let pillarMat: MeshBasicMaterial | null = null;
      if (hasCanvas()) {
        pillarMat = new MeshBasicMaterial({ color: 0x50ff9a, map: this.lib.texture('pillar'), transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false, side: DoubleSide, toneMapped: false });
        pillar = new Mesh(new CylinderGeometry(0.6, 0.6, 1, 10, 1, true), pillarMat);
        pillar.scale.set(1, 34, 1);
        pillar.position.set((lo[0] + hi[0]) / 2, lo[1] + 17, (lo[2] + hi[2]) / 2);
        pillar.frustumCulled = false;
        pillar.renderOrder = 5;
        group.add(pillar);
      }
      group.visible = false;
      this.scene.add(group);
      this.barrierGuides.set(id, { id, group, chevron, frameMat, pillar, pillarMat, fade: 0, open: false, openedAt: 0, path });
    }
  }

  /** +1 / -1 along the thin (passage) axis: from the portal's first sector toward its second */
  private passDirection(stage: StageDef, barrierId: string, thin: number, centerAlong: number): number {
    const portal: PortalDef | undefined = stage.portals.find((p) => p.barrierId === barrierId);
    if (portal) {
      const a = stage.sectors.find((s) => s.id === portal.a);
      const b = stage.sectors.find((s) => s.id === portal.b);
      if (a && b) {
        const key = thin === 0 ? 'x' : 'z';
        const ca = (a.bounds.min[key] + a.bounds.max[key]) / 2;
        const cb = (b.bounds.min[key] + b.bounds.max[key]) / 2;
        if (Math.abs(cb - ca) > 1e-3) return cb > ca ? 1 : -1;
      }
    }
    void centerAlong;
    return 1;
  }

  private buildEscapeBeacon(stage: StageDef): void {
    const z = stage.escapeZone;
    const cx = (z.min.x + z.max.x) / 2;
    const cz = (z.min.z + z.max.z) / 2;
    const w = z.max.x - z.min.x;
    const d = z.max.z - z.min.z;
    if (!(w > 0 && d > 0) || w > 5000) return;
    const r = Math.max(1.5, Math.min(w, d) * 0.25);
    const geo = new CylinderGeometry(r, r, 1, 20, 1, true);
    const mat = new MeshBasicMaterial({ color: 0xff4a30, map: this.lib.texture('pillar'), transparent: true, opacity: 0.22, blending: AdditiveBlending, depthWrite: false, side: DoubleSide, toneMapped: false });
    const pillar = new Mesh(geo, mat);
    pillar.scale.set(1, 90, 1);
    pillar.position.set(cx, z.min.y + 45, cz);
    pillar.renderOrder = 5;
    pillar.frustumCulled = false;
    const rg = new CylinderGeometry(1, 1, 0.1, 32, 1, true);
    const ringMat = new MeshBasicMaterial({ color: 0xff4a30, transparent: true, opacity: 0.35, blending: AdditiveBlending, depthWrite: false, side: DoubleSide, toneMapped: false });
    const ring = new Mesh(rg, ringMat);
    ring.scale.set(Math.max(2, Math.min(w, d) * 0.45), 1, Math.max(2, Math.min(w, d) * 0.45));
    ring.position.set(cx, z.min.y + 0.15, cz);
    ring.frustumCulled = false;
    const group = new Group();
    group.add(pillar, ring);
    this.scene.add(group);
    this.escapeBeacon = { group, pillar, ring, mat, ringMat };
  }

  /**
   * After a barrier / the final gate is open: a row of green lamps on the floor beyond the opening, chasing away from it, so the way
   * on is obvious from afar (in addition to the frame, the chevrons and the light column). Constant-size marker sprites.
   */
  private emitPathLights(g: BarrierGuide, t: number): void {
    const p = g.path;
    if (!p) return;
    const cam = this.camera.position;
    if (Math.hypot(p.origin.x - cam.x, p.origin.z - cam.z) > 140 || Math.abs(p.origin.y - cam.y) > 60) return;
    for (let i = 0; i < 7; i++) {
      const dd = 3 + i * 4.5;
      const x = p.origin.x + p.dir.x * dd;
      const z = p.origin.z + p.dir.z * dd;
      const y = p.origin.y + 0.55;
      const d = Math.hypot(x - cam.x, y - cam.y, z - cam.z);
      const pulse = Math.max(0, Math.sin(t * 5 - i * 0.95));
      const size = Math.max(0.42, d * 0.0075) * (0.75 + 0.5 * pulse);
      this.glints.emit({ x, y, z, life: 1, size0: size, c0: [0.28, 1, 0.55], a0: g.fade * (0.32 + 0.6 * pulse) });
    }
  }

  private updateBarriers(state: GameState, dt: number): void {
    const sm = this.stageMesh;
    if (!sm) return;
    const t = this.visTime;
    const world = state.world;
    const guideOpen = new Set<string>();
    for (const b of sm.barrierBoxes) {
      const enabled = world.isBoxEnabled(b.boxIndex);
      const seen = this.barrierSeen.get(b.boxIndex);
      if (!enabled) {
        if (seen === undefined) {
          // first sight already open (e.g. renderer attached mid-game): no animation
          b.open = 1;
          b.opening = false;
          b.mesh.visible = false;
        } else if (b.open < 1) {
          if (!b.opening) b.opening = true;
        }
        guideOpen.add(b.barrierId);
      } else if (b.open > 0 || b.opening || !b.mesh.visible) {
        b.open = 0;
        b.opening = false;
        b.mesh.visible = true;
        b.mesh.position.set(0, 0, 0);
        b.mesh.updateMatrix();
      }
      this.barrierSeen.set(b.boxIndex, enabled);
      if (b.opening && dt > 0) {
        b.open = Math.min(1, b.open + dt / BARRIER_OPEN_SECONDS);
        const e = b.open * b.open * (3 - 2 * b.open);
        b.mesh.position.set(0, b.size.y * 1.02 * e, 0);
        b.mesh.updateMatrix();
        b.material.emissiveIntensity = b.baseEmissive * (1 + 1.5 * Math.sin(b.open * Math.PI));
        // sparks along the lower edge of the rising shutter
        const n = Math.ceil(dt * 90);
        for (let i = 0; i < n; i++) {
          const x = b.box.min.x + Math.random() * (b.box.max.x - b.box.min.x);
          const z = b.box.min.z + Math.random() * (b.box.max.z - b.box.min.z);
          this.effects.additive.emit({
            x, y: b.box.min.y + b.size.y * 1.02 * e + 0.1, z,
            vx: (Math.random() - 0.5) * 4, vy: 1 + Math.random() * 4, vz: (Math.random() - 0.5) * 4,
            life: 0.3 + Math.random() * 0.3, size0: 0.14, size1: 0.04, c0: [1, 0.85, 0.4], c1: [1, 0.3, 0.05], a0: 1, a1: 0, drag: 0.6, gravity: 16,
          });
        }
        if (b.open >= 1) {
          b.opening = false;
          b.mesh.visible = false;
        }
      } else if (!b.opening && b.open === 0) {
        this.emitBarrierLamps(b, t);
        // closed: warning pulse
        const ph = (b.boxIndex % 7) * 0.9;
        b.material.emissiveIntensity = b.baseEmissive * (0.72 + 0.28 * Math.sin(t * 3.2 + ph));
      }
    }
    // guide markers appear once a barrier starts to open and stay as the "next way" indicator
    for (const g of this.barrierGuides.values()) {
      const open = guideOpen.has(g.id);
      if (open) {
        if (!g.open) g.openedAt = t;
        g.open = true;
        g.group.visible = true;
        g.fade = Math.min(1, g.fade + dt * 1.2);
      } else if (g.open) {
        g.open = false;
        g.group.visible = false;
        g.fade = 0;
      }
      if (g.open) {
        if (g.path) this.emitPathLights(g, t);
        if (g.pillarMat) g.pillarMat.opacity = g.fade * (0.12 + 0.4 * Math.max(0, 1 - (t - g.openedAt) / 20)) * (0.85 + 0.15 * Math.sin(t * 3));
        g.frameMat.opacity = g.fade * (0.6 + 0.25 * Math.sin(t * 4));
        if (g.chevron) {
          const mat = g.chevron.material as MeshBasicMaterial;
          mat.opacity = 0.85 * g.fade;
          if (mat.map) mat.map.offset.y -= dt * 0.7;
        }
      }
    }
    // escape zone beacon: dull red while the gate is shut, bright green once it opens
    if (this.escapeBeacon) {
      const open = state.objective.gateOpen;
      const b = this.escapeBeacon;
      b.mat.color.setHex(open ? 0x50ff9a : 0xff4a30);
      b.ringMat.color.setHex(open ? 0x50ff9a : 0xff4a30);
      b.mat.opacity = open ? 0.55 + 0.15 * Math.sin(t * 3) : 0.18;
      b.ringMat.opacity = open ? 0.7 : 0.25;
      b.ring.rotation.y = t * 0.5;
    }
  }


  // ------------------------------------------------------------------ atmosphere
  /** sector colour temperature blend, light shafts, drifting dust (all decoration; nothing here changes what is readable) */
  private updateAtmosphere(state: GameState, dt: number): void {
    // 1. fog / ambient colours follow the sector the camera is in (smooth ~0.7 s cross fade)
    const sec = this.vis ? this.vis.camSector : -1;
    const target = sec >= 0 ? this.looks[sec] : undefined;
    if (target) {
      const k = dt > 0 && !this.lookSnap ? 1 - Math.exp(-dt * 1.4) : 1;
      this.lookSnap = false;
      const L = this.look;
      L.fog = lerpHex(L.fog, target.fog, k);
      L.hemiSky = lerpHex(L.hemiSky, target.hemiSky, k);
      L.hemiGround = lerpHex(L.hemiGround, target.hemiGround, k);
      L.sun = lerpHex(L.sun, target.sun, k);
      (this.scene.fog as Fog).color.setHex(L.fog);
      this.hemi.color.setHex(L.hemiSky);
      this.hemi.groundColor.setHex(L.hemiGround);
      // mostly neutral (the old IBL was neutral): only a quarter of the sector's sky tint, otherwise walls turn teal / khaki
      const hc = this.hemi.color;
      const hy = 0.2126 * hc.r + 0.7152 * hc.g + 0.0722 * hc.b;
      STAGE_AMBIENT.setRGB(hy, hy, hy).lerp(hc, 0.25).multiplyScalar(this.ambientK);
      this.sun.color.setHex(L.sun);
      const u = (this.sky.material as ShaderMaterial).uniforms.uHorizon.value as Color;
      u.setHex(L.fog);
      this.gl.setClearColor(L.fog, 1);
    }
    // 2. light shafts under the nearest ceiling lights
    const cam = this.camera.position;
    const fwd = _fwd.set(state.camera.forward.x, state.camera.forward.y, state.camera.forward.z);
    this.shafts.update(dt, cam, fwd, this.stageMesh?.lights ?? [], this.visFlags.length ? this.visFlags : null, this.floorYs, !!this.stageMesh);
    // a soft warm halo around the same lamps: dusty air scatters the light (cheap, constant world size, additive)
    for (const l of this.shafts.lamps) this.glints.emit({ x: l.x, y: l.y, z: l.z, life: 1, size0: 5.5, c0: [1, 0.86, 0.6], a0: 0.2 });
    // 2b. boost streaks at the screen edge: full during the QB impulse, a light wisp while gliding faster than ~35 m/s
    {
      const p = state.player;
      const sp = Math.hypot(p.vel.x, p.vel.z);
      const boost = p.mv.qbImpulseRemaining > 0 ? 1 : p.mv.horizontalMode === 'quickboost' ? 0.7 : Math.min(0.45, Math.max(0, (sp - 34) / 60));
      this.speedLines.update(dt, state.mode === 'playing' || state.mode === 'paused' ? boost : 0, cam, this.camera.quaternion, Math.tan((this.camera.fov * Math.PI) / 360), this.camera.aspect);
    }
    // 3. dust motes (rate based -> frame-rate independent; the visual RNG is separate from the sim)
    if (dt > 0) {
      this.dustAcc += dt * DUST_RATE;
      const r = this.dustRnd;
      while (this.dustAcc >= 1) {
        this.dustAcc -= 1;
        const a = 0.25 + 0.3 * r();
        this.effects.additive.emit({
          x: cam.x + (r() * 2 - 1) * DUST_BOX,
          y: cam.y + (r() * 2 - 1) * 8,
          z: cam.z + (r() * 2 - 1) * DUST_BOX,
          vx: (r() - 0.5) * 0.5,
          vy: (r() - 0.5) * 0.3,
          vz: (r() - 0.5) * 0.5,
          life: 5 + 4 * r(),
          size0: 0.05 + 0.06 * r(),
          c0: [0.95, 0.82, 0.62],
          a0: a,
          a1: 0,
        });
      }
    }
  }

  // ------------------------------------------------------------------ lights
  private updateLights(state: GameState, dt: number): void {
    const p = state.player.pos;
    this.sun.position.set(p.x - 30, p.y + 60, p.z + 25);
    this.sun.target.position.set(p.x, p.y, p.z);
    const sm = this.stageMesh;
    if (sm && sm.lights.length > 0) {
      this.lightScanT -= dt;
      if (this.lightScanT <= 0) {
        this.lightScanT = 0.2;
        // pick the nearest emissive panels (not directly on top of the player)
        const picks: { d: number; i: number }[] = [];
        for (let i = 0; i < sm.lights.length; i++) {
          // a lamp in a sector that is not visible from here (behind a wall) must not light this side: point lights ignore occluders
          const sec = sm.lights[i].sector;
          if (sec >= 0 && this.visFlags[sec] === 0) continue;
          const l = sm.lights[i].pos;
          const dx = l.x - p.x;
          const dy = (l.y - p.y) * 0.6;
          const dz = l.z - p.z;
          const d = dx * dx + dy * dy + dz * dz;
          if (d > 55 * 55) continue;
          if (picks.length < NEAR_LIGHTS) picks.push({ d, i });
          else {
            let worst = 0;
            for (let k = 1; k < picks.length; k++) if (picks[k].d > picks[worst].d) worst = k;
            if (d < picks[worst].d) picks[worst] = { d, i };
          }
        }
        picks.sort((a, b) => a.d - b.d);
        for (let k = 0; k < NEAR_LIGHTS; k++) {
          const t = this.nearTarget[k];
          const pk = picks[k];
          if (pk) {
            const c = sm.lights[pk.i];
            t.pos.set(c.pos.x, c.pos.y - 1.2, c.pos.z);
            t.power = 110 * c.power;
            t.color.setHex(c.color);
          } else t.power = 0;
        }
      }
      for (let k = 0; k < NEAR_LIGHTS; k++) {
        const l = this.nearLights[k];
        const t = this.nearTarget[k];
        const a = 1 - Math.exp(-6 * Math.max(dt, 1 / 60));
        l.position.lerp(t.pos, a);
        l.intensity += (t.power - l.intensity) * a;
        l.color.lerp(t.color, a);
      }
    } else {
      for (const l of this.nearLights) l.intensity = 0;
    }
  }
}

