/**
 * Pooled visual effects. Everything here has a fixed capacity and a lifetime, so nothing grows during long play or
 * repeated sorties:
 *   - two GPU point-sprite particle systems (additive: sparks/fire/flash, alpha: smoke/dust), ring-buffer allocation
 *   - InstancedMesh for tracers / enemy bullets (3 draw calls for all bullets)
 *   - fixed pools for beams, shock rings, missiles and two dynamic point lights
 * Visual randomness uses its own PRNG (never the simulation rng, SPEC §9).
 */
import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NormalBlending,
  Object3D,
  PointLight,
  Points,
  Quaternion,
  RingGeometry,
  ShaderMaterial,
  SphereGeometry,
  Texture,
  Vector3,
} from 'three';
import { ENEMIES, PLAYER, WEAPONS } from '../config';
import type { EnemyKind } from '../config';
import type { EnemyBullet, GameEvent, Missile, PlayerBullet, V3 } from '../sim/types';
import { mulberry32 } from './geo';
import { PartBuilder } from './parts';

// ---------------------------------------------------------------------------------------------------------------------
// GPU point-sprite particles
// ---------------------------------------------------------------------------------------------------------------------
const VERT = /* glsl */ `
attribute float aSize;
attribute vec4 aColor;
uniform float uScale;
uniform float uMaxPx;
uniform float uNearFade;
uniform float uH;
varying vec4 vColor;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float d = max(-mv.z, 0.05);
  float pxRaw = aSize * uScale / d;
  gl_PointSize = clamp(pxRaw, 0.0, uMaxPx);
  float nearFade = smoothstep(uNearFade * 0.35, uNearFade, d);
  // a sprite that would cover a big part of the screen (explosion / smoke right next to the camera) fades out instead of
  // whiting out the view: fully faded once it is taller than 65 % of the screen, untouched below 28 %
  float occ = 1.0 - smoothstep(uH * 0.28, uH * 0.65, pxRaw);
  vColor = vec4(aColor.rgb, aColor.a * nearFade * occ);
}
`;
const FRAG = /* glsl */ `
uniform float uPower;
varying vec4 vColor;
void main() {
  float r = length(gl_PointCoord - vec2(0.5)) * 2.0;
  float a = pow(clamp(1.0 - r, 0.0, 1.0), uPower);
  gl_FragColor = vec4(vColor.rgb, vColor.a * a);
  if (gl_FragColor.a < 0.003) discard;
}
`;

export interface ParticleSpec {
  x: number;
  y: number;
  z: number;
  vx?: number;
  vy?: number;
  vz?: number;
  life: number;
  size0: number;
  size1?: number;
  /** rgb 0..1 start / end colour (end defaults to start) */
  c0: readonly [number, number, number];
  c1?: readonly [number, number, number];
  a0?: number;
  a1?: number;
  drag?: number;
  gravity?: number;
}

export class ParticleSystem {
  readonly points: Points;
  readonly capacity: number;
  private geo: BufferGeometry;
  private pos: Float32Array;
  private vel: Float32Array;
  private col: Float32Array; // rgba (current, written to GPU)
  private size: Float32Array; // current
  private age: Float32Array;
  private life: Float32Array; // 0 = dead
  private s0: Float32Array;
  private s1: Float32Array;
  private c0: Float32Array; // r,g,b,a0
  private c1: Float32Array; // r,g,b,a1
  private drag: Float32Array;
  private grav: Float32Array;
  private cursor = 0;
  private hi = 0;
  readonly material: ShaderMaterial;
  aliveCount = 0;

  constructor(capacity: number, additive: boolean) {
    this.capacity = capacity;
    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.col = new Float32Array(capacity * 4);
    this.size = new Float32Array(capacity);
    this.age = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.s0 = new Float32Array(capacity);
    this.s1 = new Float32Array(capacity);
    this.c0 = new Float32Array(capacity * 4);
    this.c1 = new Float32Array(capacity * 4);
    this.drag = new Float32Array(capacity);
    this.grav = new Float32Array(capacity);
    this.geo = new BufferGeometry();
    // wrap (not copy) the typed arrays: Float32BufferAttribute would clone them
    const pa = new BufferAttribute(this.pos, 3);
    const ca = new BufferAttribute(this.col, 4);
    const sa = new BufferAttribute(this.size, 1);
    pa.setUsage(DynamicDrawUsage);
    ca.setUsage(DynamicDrawUsage);
    sa.setUsage(DynamicDrawUsage);
    this.geo.setAttribute('position', pa);
    this.geo.setAttribute('aColor', ca);
    this.geo.setAttribute('aSize', sa);
    this.geo.setDrawRange(0, 0);
    this.material = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: additive ? AdditiveBlending : NormalBlending,
      uniforms: {
        uScale: { value: 800 },
        uMaxPx: { value: additive ? 160 : 320 },
        uNearFade: { value: additive ? 1.2 : 3.0 },
        uH: { value: 720 },
        uPower: { value: additive ? 1.6 : 0.8 },
      },
    });
    this.points = new Points(this.geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 20 : 10;
  }

  setView(drawingBufferHeight: number, fovYDeg: number): void {
    this.material.uniforms.uScale.value = drawingBufferHeight / (2 * Math.tan((fovYDeg * Math.PI) / 360));
    const h = drawingBufferHeight;
    this.material.uniforms.uMaxPx.value = Math.min(h * 0.4, 512);
    this.material.uniforms.uH.value = h;
  }

  emit(p: ParticleSpec): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    const i3 = i * 3;
    const i4 = i * 4;
    this.pos[i3] = p.x;
    this.pos[i3 + 1] = p.y;
    this.pos[i3 + 2] = p.z;
    this.vel[i3] = p.vx ?? 0;
    this.vel[i3 + 1] = p.vy ?? 0;
    this.vel[i3 + 2] = p.vz ?? 0;
    this.age[i] = 0;
    this.life[i] = Math.max(p.life, 1e-3);
    this.s0[i] = p.size0;
    this.s1[i] = p.size1 ?? p.size0;
    const c1 = p.c1 ?? p.c0;
    this.c0[i4] = p.c0[0];
    this.c0[i4 + 1] = p.c0[1];
    this.c0[i4 + 2] = p.c0[2];
    this.c0[i4 + 3] = p.a0 ?? 1;
    this.c1[i4] = c1[0];
    this.c1[i4 + 1] = c1[1];
    this.c1[i4 + 2] = c1[2];
    this.c1[i4 + 3] = p.a1 ?? 0;
    this.drag[i] = p.drag ?? 0;
    this.grav[i] = p.gravity ?? 0;
    if (i + 1 > this.hi) this.hi = i + 1;
    this.size[i] = p.size0;
    this.col[i4] = p.c0[0];
    this.col[i4 + 1] = p.c0[1];
    this.col[i4 + 2] = p.c0[2];
    this.col[i4 + 3] = p.a0 ?? 1;
  }

  update(dt: number): void {
    let hi = 0;
    let alive = 0;
    const n = this.hi;
    for (let i = 0; i < n; i++) {
      const L = this.life[i];
      if (L <= 0) {
        this.size[i] = 0;
        this.col[i * 4 + 3] = 0;
        continue;
      }
      const a = this.age[i] + dt;
      if (a >= L) {
        this.life[i] = 0;
        this.size[i] = 0;
        this.col[i * 4 + 3] = 0;
        continue;
      }
      this.age[i] = a;
      const f = a / L;
      const i3 = i * 3;
      const i4 = i * 4;
      const dg = Math.exp(-this.drag[i] * dt);
      this.vel[i3] *= dg;
      this.vel[i3 + 1] = this.vel[i3 + 1] * dg - this.grav[i] * dt;
      this.vel[i3 + 2] *= dg;
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      this.size[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * f;
      this.col[i4] = this.c0[i4] + (this.c1[i4] - this.c0[i4]) * f;
      this.col[i4 + 1] = this.c0[i4 + 1] + (this.c1[i4 + 1] - this.c0[i4 + 1]) * f;
      this.col[i4 + 2] = this.c0[i4 + 2] + (this.c1[i4 + 2] - this.c0[i4 + 2]) * f;
      this.col[i4 + 3] = this.c0[i4 + 3] + (this.c1[i4 + 3] - this.c0[i4 + 3]) * f;
      hi = i + 1;
      alive++;
    }
    this.hi = Math.max(hi, 0);
    this.aliveCount = alive;
    this.geo.setDrawRange(0, this.hi);
    (this.geo.getAttribute('position') as BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('aColor') as BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('aSize') as BufferAttribute).needsUpdate = true;
  }

  clear(): void {
    this.life.fill(0);
    this.size.fill(0);
    this.col.fill(0);
    this.hi = 0;
    this.cursor = 0;
    this.aliveCount = 0;
    this.geo.setDrawRange(0, 0);
    (this.geo.getAttribute('aSize') as BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('aColor') as BufferAttribute).needsUpdate = true;
  }

  /**
   * Immediate mode (marker lamps that are re-emitted every frame): call resetManual(), emit() the frame's markers, then commit().
   * There is no ageing, so a marker is drawn exactly once per frame at exactly the emitted size / colour.
   */
  resetManual(): void {
    this.hi = 0;
    this.cursor = 0;
  }
  commit(): void {
    this.aliveCount = this.hi;
    this.geo.setDrawRange(0, this.hi);
    (this.geo.getAttribute('position') as BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('aColor') as BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('aSize') as BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.geo.dispose();
    this.material.dispose();
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// small pools
// ---------------------------------------------------------------------------------------------------------------------
interface BeamSlot {
  group: Group;
  core: Mesh;
  glow: Mesh;
  age: number;
  life: number;
  active: boolean;
}
interface RingSlot {
  mesh: Mesh;
  mat: MeshBasicMaterial;
  age: number;
  life: number;
  size: number;
  active: boolean;
  /** blast rings fade out while their band is close to the camera (a wide additive band must not cover the screen / crosshair) */
  nearFade: boolean;
}
interface LightSlot {
  light: PointLight;
  age: number;
  life: number;
  peak: number;
  active: boolean;
}
interface MissileSlot {
  id: number;
  group: Group;
  flame: Mesh;
  flameCore: Mesh;
  active: boolean;
  smokeAcc: number;
}

const TMP_Q = new Quaternion();
const V_Z = new Vector3(0, 0, 1);
const V_NZ = new Vector3(0, 0, -1);
const V_A = new Vector3();
const V_B = new Vector3();
const DUMMY = new Object3D();

/**
 * machine-gun tracer (additive streak) and muzzle flash. Seen from the TPS camera behind the mech the tracer runs almost along the line of
 * sight, so the old 0.11 m x 4.5 m streak and 0.36 m flash changed 0.0147% of the screen 2 frames after the first shot at 30 m (audit-ui A2;
 * measured 0.04% now, the overlap with the crosshair circle r=40px went 1.8% -> 6%). fx-audit limits (Y-size): <= 6% of the screen, <= 60% of
 * the centre circle.
 */
export const MG_TRACER = { width: 0.3, lengthPerSpeed: 0.07, minLength: 1.8, maxLength: 8 };
export const MG_FLASH = { size0: 0.7, size1: 1.15, life: 0.05 };

const MAX_PLAYER_BULLETS = 160;
const MAX_ENEMY_BULLETS = 192;
const BEAM_SLOTS = 6;
const RING_SLOTS = 10;
const MISSILE_SLOTS = 10;
const MAX_SMOKERS = 10;

export interface EffectStats {
  additiveParticles: number;
  smokeParticles: number;
  beams: number;
  rings: number;
  missiles: number;
  bullets: number;
  enemyBullets: number;
  lightsActive: number;
  smokers: number;
}

/** blast rings: fully faded while their band is closer than MIN to the camera, untouched beyond MAX [m] */
const RING_NEAR_FADE_MIN = 3.5;
const RING_NEAR_FADE_MAX = 13;

export class Effects {
  readonly group = new Group();
  /** camera position (set by the renderer every frame) */
  readonly viewPos = { x: 0, y: 0, z: 0 };
  readonly additive: ParticleSystem;
  readonly smoke: ParticleSystem;
  private rnd = mulberry32(0xa11ce);
  private beams: BeamSlot[] = [];
  private rings: RingSlot[] = [];
  private lights: LightSlot[] = [];
  private missiles: MissileSlot[] = [];
  private tracerMesh: InstancedMesh;
  private coreMesh: InstancedMesh;
  private haloMesh: InstancedMesh;
  private enemyTrailMesh: InstancedMesh;
  private smokers: { x: number; y: number; z: number; until: number; acc: number }[] = [];
  private clock = 0;
  private missileById = new Map<number, MissileSlot>();
  private missileMats: Record<string, MeshStandardMaterial> = {};
  private nBullets = 0;
  private nEnemyBullets = 0;

  constructor() {
    this.group.name = 'effects';
    this.additive = new ParticleSystem(2600, true);
    this.smoke = new ParticleSystem(1500, false);
    this.group.add(this.smoke.points, this.additive.points);

    // ---- instanced tracers (player MG) + enemy trail streaks + cores + halos
    const streakGeo = new BoxGeometry(1, 1, 1);
    streakGeo.translate(0, 0, -0.5); // spans z in [-1,0]: head at origin, tail behind (-Z local = travel dir reversed by orientation)
    const addMat = (): MeshBasicMaterial =>
      new MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: AdditiveBlending, depthWrite: false, toneMapped: false });
    this.tracerMesh = new InstancedMesh(streakGeo, addMat(), MAX_PLAYER_BULLETS);
    this.enemyTrailMesh = new InstancedMesh(streakGeo, addMat(), MAX_ENEMY_BULLETS);
    const sphere = new SphereGeometry(1, 10, 8);
    this.coreMesh = new InstancedMesh(sphere, new MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), MAX_ENEMY_BULLETS);
    this.haloMesh = new InstancedMesh(sphere, addMat(), MAX_ENEMY_BULLETS);
    (this.haloMesh.material as MeshBasicMaterial).opacity = 0.35;
    for (const im of [this.tracerMesh, this.enemyTrailMesh, this.coreMesh, this.haloMesh]) {
      im.instanceMatrix.setUsage(DynamicDrawUsage);
      im.instanceColor = new InstancedBufferAttribute(new Float32Array(im.count * 3), 3);
      im.instanceColor.setUsage(DynamicDrawUsage);
      im.frustumCulled = false;
      im.count = 0;
      im.renderOrder = 15;
      this.group.add(im);
    }

    // ---- beams
    const beamGeo = new CylinderGeometry(1, 1, 1, 8, 1, true);
    beamGeo.rotateX(Math.PI / 2);
    beamGeo.translate(0, 0, -0.5);
    for (let i = 0; i < BEAM_SLOTS; i++) {
      const group = new Group();
      const core = new Mesh(beamGeo, new MeshBasicMaterial({ color: 0xf2ffff, transparent: true, blending: AdditiveBlending, depthWrite: false, toneMapped: false, side: DoubleSide }));
      const glow = new Mesh(beamGeo, new MeshBasicMaterial({ color: 0x28d8ff, transparent: true, opacity: 0.6, blending: AdditiveBlending, depthWrite: false, toneMapped: false, side: DoubleSide }));
      core.frustumCulled = glow.frustumCulled = false;
      group.add(glow, core);
      group.visible = false;
      group.renderOrder = 16;
      this.group.add(group);
      this.beams.push({ group, core, glow, age: 0, life: 0, active: false });
    }

    // ---- rings
    const ringGeo = new RingGeometry(0.82, 1, 40, 1);
    for (let i = 0; i < RING_SLOTS; i++) {
      const mat = new MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: AdditiveBlending, depthWrite: false, toneMapped: false, side: DoubleSide });
      const mesh = new Mesh(ringGeo, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 17;
      this.group.add(mesh);
      this.rings.push({ mesh, mat, age: 0, life: 0, size: 1, active: false, nearFade: false });
    }

    // ---- two flash lights (constant light count => no shader recompiles)
    for (let i = 0; i < 2; i++) {
      const light = new PointLight(0xffffff, 0, 30, 2);
      this.group.add(light);
      this.lights.push({ light, age: 0, life: 0, peak: 0, active: false });
    }

    // ---- missiles
    const mb = new PartBuilder();
    const mmat = this.missileMats = {
      body: new MeshStandardMaterial({ color: 0xd8dade, roughness: 0.4, metalness: 0.6, vertexColors: true }),
      nose: new MeshStandardMaterial({ color: 0xff5a20, roughness: 0.4, metalness: 0.3, vertexColors: true, emissive: new Color(0xff3a10), emissiveIntensity: 0.4 }),
      dark: new MeshStandardMaterial({ color: 0x33363c, roughness: 0.5, metalness: 0.8, vertexColors: true }),
    };
    mb.cyl('body', 0, 0, 0, 0.11, 0.85, { rx: Math.PI / 2, seg: 10 });
    mb.cone('nose', 0, 0, -0.55, 0.11, 0.26, { rx: -Math.PI / 2, seg: 10 });
    mb.cyl('dark', 0, 0, 0.42, 0.12, 0.12, { rx: Math.PI / 2, seg: 10 });
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2;
      mb.box('dark', Math.cos(a) * 0.15, Math.sin(a) * 0.15, 0.32, i % 2 ? 0.26 : 0.03, i % 2 ? 0.03 : 0.26, 0.22);
    }
    const flameGeo = new ConeGeometry(0.13, 1, 10, 1, true);
    flameGeo.rotateX(Math.PI / 2);
    flameGeo.translate(0, 0, 0.5);
    for (let i = 0; i < MISSILE_SLOTS; i++) {
      const g = mb.build('missile', mmat);
      const flame = new Mesh(flameGeo, new MeshBasicMaterial({ color: 0xff9a3a, transparent: true, opacity: 0.7, blending: AdditiveBlending, depthWrite: false, toneMapped: false, side: DoubleSide }));
      const flameCore = new Mesh(flameGeo, new MeshBasicMaterial({ color: 0xfff0c8, transparent: true, opacity: 0.9, blending: AdditiveBlending, depthWrite: false, toneMapped: false, side: DoubleSide }));
      flame.position.z = 0.48;
      flameCore.position.z = 0.48;
      flame.frustumCulled = flameCore.frustumCulled = false;
      g.add(flame, flameCore);
      g.visible = false;
      this.group.add(g);
      this.missiles.push({ id: -1, group: g, flame, flameCore, active: false, smokeAcc: 0 });
    }
  }

  /** image based lighting for the missile bodies (the scene itself has no environment, see MaterialLibrary.setEnvironment) */
  setEnvironment(env: Texture | null, intensity: number): void {
    for (const m of Object.values(this.missileMats)) {
      if (m.envMap !== env) m.needsUpdate = true;
      m.envMap = env;
      m.envMapIntensity = intensity;
    }
  }

  // ------------------------------------------------------------------ helpers
  private R(): number {
    return this.rnd();
  }
  private rs(): number {
    return this.rnd() * 2 - 1;
  }

  private ring(pos: V3, normal: V3, size: number, life: number, color: number, alpha = 0.9, nearFade = false): void {
    const s = this.rings.find((r) => !r.active) ?? this.rings.reduce((a, b) => (a.age / a.life > b.age / b.life ? a : b));
    s.active = true;
    s.age = 0;
    s.life = life;
    s.size = size;
    s.nearFade = nearFade;
    s.mat.color.setHex(color);
    s.mat.opacity = alpha;
    s.mesh.visible = true;
    s.mesh.position.set(pos.x, pos.y, pos.z);
    V_A.set(normal.x, normal.y, normal.z).normalize();
    TMP_Q.setFromUnitVectors(V_Z, V_A);
    s.mesh.quaternion.copy(TMP_Q);
    s.mesh.scale.setScalar(size * 0.1);
    (s.mesh.userData as { alpha0: number }).alpha0 = alpha;
  }

  private flashLight(pos: V3, color: number, intensity: number, life: number, dist = 30): void {
    const s = this.lights.find((l) => !l.active) ?? this.lights[0];
    s.active = true;
    s.age = 0;
    s.life = life;
    s.peak = intensity;
    s.light.color.setHex(color);
    s.light.position.set(pos.x, pos.y, pos.z);
    s.light.distance = dist;
    s.light.intensity = intensity;
  }

  private spark(x: number, y: number, z: number, dx: number, dy: number, dz: number, speed: number, life: number, c0: readonly [number, number, number], c1: readonly [number, number, number], size = 0.14, gravity = 14): void {
    this.additive.emit({
      x, y, z,
      vx: dx * speed, vy: dy * speed, vz: dz * speed,
      life, size0: size, size1: size * 0.3, c0, c1, a0: 1, a1: 0, drag: 1.2, gravity,
    });
  }

  private puff(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, s0: number, s1: number, shade: number, alpha: number): void {
    this.smoke.emit({
      x, y, z, vx, vy, vz, life, size0: s0, size1: s1,
      c0: [shade, shade * 0.97, shade * 0.93], c1: [shade * 0.55, shade * 0.55, shade * 0.55],
      a0: alpha, a1: 0, drag: 1.4, gravity: -0.6,
    });
  }

  private burst(pos: V3, n: number, baseDir: V3 | null, spread: number, speed: number, c0: readonly [number, number, number], c1: readonly [number, number, number], size = 0.12, life = 0.45): void {
    for (let i = 0; i < n; i++) {
      let dx = this.rs();
      let dy = this.rs();
      let dz = this.rs();
      if (baseDir) {
        dx = baseDir.x + dx * spread;
        dy = baseDir.y + dy * spread;
        dz = baseDir.z + dz * spread;
      }
      const l = Math.hypot(dx, dy, dz) || 1;
      this.spark(pos.x, pos.y, pos.z, dx / l, dy / l, dz / l, speed * (0.4 + 0.9 * this.R()), life * (0.6 + 0.8 * this.R()), c0, c1, size * (0.6 + 0.8 * this.R()));
    }
  }

  // ------------------------------------------------------------------ events
  handle(ev: GameEvent): void {
    switch (ev.type) {
      case 'mgFire': {
        const o = ev.origin;
        // the muzzle sits right next to the crosshair in the TPS view: keep the flash compact so the aim stays readable, but big enough
        // to be seen from behind (audit-ui A2: it changed 0.01% of the screen at 30 m)
        this.additive.emit({ x: o.x, y: o.y, z: o.z, life: MG_FLASH.life, size0: MG_FLASH.size0, size1: MG_FLASH.size1, c0: [1, 0.85, 0.45], c1: [1, 0.5, 0.1], a0: 0.9, a1: 0 });
        for (let i = 0; i < 2; i++) this.spark(o.x, o.y, o.z, ev.dir.x + this.rs() * 0.25, ev.dir.y + this.rs() * 0.25, ev.dir.z + this.rs() * 0.25, 22, 0.12, [1, 0.9, 0.5], [1, 0.4, 0.05], 0.08, 0);
        this.flashLight(o, 0xffc060, 5, 0.05, 10);
        break;
      }
      case 'beamFire': {
        this.spawnBeam(ev.origin, ev.end);
        const o = ev.origin;
        this.additive.emit({ x: o.x, y: o.y, z: o.z, life: 0.1, size0: 0.6, size1: 1.0, c0: [0.7, 1, 1], c1: [0.2, 0.7, 1], a0: 0.85, a1: 0 });
        this.flashLight(o, 0x50e0ff, 9, 0.09, 14);
        if (ev.hit !== 'none') {
          const d = V_B.set(o.x - ev.end.x, o.y - ev.end.y, o.z - ev.end.z).normalize();
          const dir = { x: d.x, y: d.y, z: d.z };
          this.burst(ev.end, ev.hit === 'enemy' ? 14 : 10, dir, 0.9, 16, [0.8, 1, 1], [0.2, 0.7, 1], 0.14, 0.4);
          this.additive.emit({ x: ev.end.x, y: ev.end.y, z: ev.end.z, life: 0.12, size0: 1.3, size1: 2.0, c0: [0.8, 1, 1], c1: [0.2, 0.6, 1], a0: 0.9, a1: 0 });
          this.flashLight(ev.end, 0x50e0ff, 8, 0.1, 14);
        }
        break;
      }
      case 'missileFire': {
        const o = ev.origin;
        this.additive.emit({ x: o.x, y: o.y, z: o.z, life: 0.12, size0: 0.7, size1: 1.3, c0: [1, 0.8, 0.5], c1: [1, 0.35, 0.08], a0: 0.85, a1: 0 });
        for (let i = 0; i < 5; i++) this.puff(o.x, o.y, o.z, -ev.dir.x * 4 + this.rs() * 2, -ev.dir.y * 4 + this.rs() * 2, -ev.dir.z * 4 + this.rs() * 2, 0.9, 0.4, 1.4, 0.8, 0.5);
        this.flashLight(o, 0xff9040, 10, 0.12, 16);
        break;
      }
      case 'hit': {
        const p = ev.pos;
        const n = ev.normal;
        if (ev.on === 'enemy') {
          this.burst(p, 10, n, 0.9, 12, [1, 0.95, 0.7], [1, 0.4, 0.1], 0.13, 0.4);
          this.additive.emit({ x: p.x, y: p.y, z: p.z, life: 0.1, size0: 0.9, size1: 1.5, c0: [1, 0.85, 0.5], c1: [1, 0.4, 0.1], a0: 0.95, a1: 0 });
        } else if (ev.on === 'player') {
          this.burst(p, 10, n, 1.0, 10, [1, 0.6, 0.3], [1, 0.1, 0.05], 0.14, 0.4);
          this.additive.emit({ x: p.x, y: p.y, z: p.z, life: 0.1, size0: 1.0, size1: 1.6, c0: [1, 0.5, 0.25], c1: [1, 0.1, 0.05], a0: 0.9, a1: 0 });
        } else {
          const beam = ev.weapon === 'beam';
          const c0 = beam ? ([0.8, 1, 1] as const) : ([1, 0.85, 0.5] as const);
          const c1 = beam ? ([0.2, 0.7, 1] as const) : ([1, 0.35, 0.08] as const);
          this.burst(p, ev.weapon === 'missile' ? 12 : 6, n, 0.8, 10, c0, c1, 0.1, 0.35);
          this.additive.emit({ x: p.x, y: p.y, z: p.z, life: 0.07, size0: 0.5, size1: 0.9, c0, c1, a0: 0.9, a1: 0 });
          this.puff(p.x + n.x * 0.1, p.y + n.y * 0.1, p.z + n.z * 0.1, n.x * 1.2, n.y * 1.2 + 0.4, n.z * 1.2, 0.6, 0.25, 0.7, 0.55, 0.32);
        }
        break;
      }
      case 'explosion':
        this.explosion(ev.pos, ev.size);
        break;
      case 'enemyDown': {
        // debris burst; the fireball itself is drawn by the paired explosion event
        this.burst(ev.pos, 18, null, 1, 13, [1, 0.8, 0.4], [0.9, 0.2, 0.05], 0.16, 0.9);
        this.addSmoker(ev.pos);
        break;
      }
      case 'enemyFire': {
        const o = ev.origin;
        const t = ev.kind === 'turret';
        this.additive.emit({
          x: o.x + ev.dir.x * 1.2, y: o.y + ev.dir.y * 1.2, z: o.z + ev.dir.z * 1.2,
          life: 0.09, size0: t ? 1.0 : 0.6, size1: t ? 1.7 : 1.0,
          c0: t ? [1, 0.5, 0.75] : [1, 0.75, 0.4], c1: t ? [1, 0.1, 0.4] : [1, 0.3, 0.05], a0: 0.95, a1: 0,
        });
        break;
      }
      case 'playerHit': {
        // small local effect only (the screen flash is the HUD's job); placed by the renderer near the mech
        break;
      }
      case 'qb': {
        const p = ev.pos;
        const d = ev.dir;
        const feet = { x: p.x, y: p.y, z: p.z };
        this.ring({ x: feet.x - d.x * 0.6, y: feet.y, z: feet.z - d.z * 0.6 }, d, 4.2, 0.28, 0x7fd8ff, 0.7);
        for (let i = 0; i < 16; i++) {
          this.spark(feet.x, feet.y + this.rs() * 0.8, feet.z, -d.x + this.rs() * 0.35, this.rs() * 0.3, -d.z + this.rs() * 0.35, 18 + 22 * this.R(), 0.3 + 0.2 * this.R(), [0.7, 0.95, 1], [0.2, 0.5, 1], 0.2, 0);
        }
        this.flashLight(feet, 0x60b8ff, 9, 0.16, 18);
        break;
      }
      case 'jump': {
        const y = ev.pos.y - PLAYER.HALF.y + 0.15;
        for (let i = 0; i < 6; i++) {
          const a = this.R() * Math.PI * 2;
          this.puff(ev.pos.x + Math.cos(a) * 0.6, y, ev.pos.z + Math.sin(a) * 0.6, Math.cos(a) * 3, 0.7, Math.sin(a) * 3, 0.7, 0.4, 1.3, 0.55, 0.3);
        }
        break;
      }
      case 'land': {
        const y = ev.pos.y - PLAYER.HALF.y + 0.15;
        const k = Math.min(1, ev.impactSpeed / 30);
        const n = 6 + Math.round(8 * k);
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2 + this.R() * 0.4;
          const sp = 2.5 + 6 * k * (0.6 + 0.6 * this.R());
          this.puff(ev.pos.x + Math.cos(a) * 0.7, y, ev.pos.z + Math.sin(a) * 0.7, Math.cos(a) * sp, 0.5 + k, Math.sin(a) * sp, 0.6 + 0.5 * k, 0.4, 1.4 + k, 0.5, 0.34);
        }
        if (ev.impactSpeed > 22) this.burst({ x: ev.pos.x, y, z: ev.pos.z }, 8, { x: 0, y: 1, z: 0 }, 1.5, 9, [1, 0.8, 0.5], [1, 0.3, 0.05], 0.1, 0.35);
        break;
      }
      case 'barrierOpen':
      case 'gateOpen':
      case 'notice':
      case 'sector':
      case 'enemyTelegraph':
      case 'custom':
        break;
    }
  }

  explosion(pos: V3, size: number): void {
    const s = size;
    // core flash
    this.additive.emit({ x: pos.x, y: pos.y, z: pos.z, life: 0.14, size0: s * 2.2, size1: s * 3.4, c0: [1, 0.95, 0.8], c1: [1, 0.6, 0.2], a0: 0.95, a1: 0 });
    for (let i = 0; i < 12; i++) {
      const a = this.rs();
      const b = this.rs();
      const c = this.rs();
      const l = Math.hypot(a, b, c) || 1;
      const sp = s * (1.2 + 2.2 * this.R());
      this.additive.emit({
        x: pos.x + (a / l) * s * 0.3, y: pos.y + (b / l) * s * 0.3, z: pos.z + (c / l) * s * 0.3,
        vx: (a / l) * sp, vy: (b / l) * sp + s * 0.6, vz: (c / l) * sp,
        life: 0.35 + 0.35 * this.R(), size0: s * (0.7 + 0.5 * this.R()), size1: s * 1.9,
        c0: [1, 0.75, 0.35], c1: [0.7, 0.15, 0.03], a0: 0.85, a1: 0, drag: 2.5,
      });
    }
    for (let i = 0; i < 10; i++) {
      const a = this.R() * Math.PI * 2;
      const sp = s * (0.5 + 1.0 * this.R());
      this.smoke.emit({
        x: pos.x, y: pos.y, z: pos.z, vx: Math.cos(a) * sp, vy: s * (0.8 + 1.4 * this.R()), vz: Math.sin(a) * sp,
        life: 1.2 + 1.2 * this.R(), size0: s * 0.8, size1: s * (2.2 + 1.5 * this.R()),
        c0: [0.28, 0.26, 0.25], c1: [0.08, 0.08, 0.08], a0: 0.6, a1: 0, drag: 1.3, gravity: -0.8,
      });
    }
    this.burst(pos, Math.round(14 + s * 6), null, 1, s * 7, [1, 0.9, 0.5], [1, 0.3, 0.05], 0.13, 0.8);
    this.ring({ x: pos.x, y: pos.y - 0.6, z: pos.z }, { x: 0, y: 1, z: 0 }, s * 3.2, 0.42, 0xffb060, 0.6, true);
    this.flashLight(pos, 0xff9a40, 26 * s, 0.28, 34);
  }

  private addSmoker(p: V3): void {
    if (this.smokers.length >= MAX_SMOKERS) this.smokers.shift();
    this.smokers.push({ x: p.x, y: p.y - 0.8, z: p.z, until: this.clock + 6, acc: 0 });
  }

  private spawnBeam(o: V3, e: V3): void {
    const s = this.beams.find((b) => !b.active) ?? this.beams[0];
    s.active = true;
    s.age = 0;
    s.life = WEAPONS.beam.visibleSeconds;
    s.group.visible = true;
    const dx = e.x - o.x;
    const dy = e.y - o.y;
    const dz = e.z - o.z;
    const len = Math.max(0.05, Math.hypot(dx, dy, dz));
    V_A.set(dx / len, dy / len, dz / len);
    TMP_Q.setFromUnitVectors(V_NZ, V_A);
    s.group.position.set(o.x, o.y, o.z);
    s.group.quaternion.copy(TMP_Q);
    s.group.scale.set(1, 1, len);
    s.core.scale.set(0.05, 0.05, 1);
    s.glow.scale.set(0.16, 0.16, 1);
  }

  // ------------------------------------------------------------------ per-frame projectile sync
  syncBullets(bullets: readonly PlayerBullet[], enemy: readonly EnemyBullet[], missiles: readonly Missile[], dt: number): void {
    // player MG tracers
    let n = 0;
    const g = 18;
    for (const b of bullets) {
      if (!b.alive || n >= MAX_PLAYER_BULLETS) continue;
      const vx = b.v0.x;
      const vy = b.v0.y - g * b.age;
      const vz = b.v0.z;
      const sp = Math.hypot(vx, vy, vz) || 1;
      const dx = vx / sp;
      const dy = vy / sp;
      const dz = vz / sp;
      const fromOrigin = Math.hypot(b.pos.x - b.origin.x, b.pos.y - b.origin.y, b.pos.z - b.origin.z);
      const len = Math.min(Math.max(sp * MG_TRACER.lengthPerSpeed, MG_TRACER.minLength), MG_TRACER.maxLength, fromOrigin + 0.3);
      DUMMY.position.set(b.pos.x, b.pos.y, b.pos.z);
      // geometry spans z in [-1,0]; orient so that -Z points backwards along the path (tail behind the head)
      V_A.set(-dx, -dy, -dz);
      DUMMY.quaternion.setFromUnitVectors(V_NZ, V_A);
      DUMMY.scale.set(MG_TRACER.width, MG_TRACER.width, len);
      DUMMY.updateMatrix();
      this.tracerMesh.setMatrixAt(n, DUMMY.matrix);
      this.tracerMesh.instanceColor!.setXYZ(n, 1.0, 0.85, 0.35);
      n++;
    }
    this.tracerMesh.count = n;
    this.tracerMesh.instanceMatrix.needsUpdate = true;
    this.tracerMesh.instanceColor!.needsUpdate = true;
    this.nBullets = n;

    // enemy bullets: core + halo + trail
    let m = 0;
    for (const b of enemy) {
      if (!b.alive || m >= MAX_ENEMY_BULLETS) continue;
      const turret = b.kind === 'turret';
      const sp = Math.hypot(b.vel.x, b.vel.y, b.vel.z) || 1;
      const dx = b.vel.x / sp;
      const dy = b.vel.y / sp;
      const dz = b.vel.z / sp;
      const r = Math.max(0.16, b.radius * (turret ? 1.15 : 1.0));
      DUMMY.position.set(b.pos.x, b.pos.y, b.pos.z);
      DUMMY.quaternion.identity();
      DUMMY.scale.setScalar(r);
      DUMMY.updateMatrix();
      this.coreMesh.setMatrixAt(m, DUMMY.matrix);
      this.coreMesh.instanceColor!.setXYZ(m, turret ? 1.0 : 1.0, turret ? 0.35 : 0.72, turret ? 0.7 : 0.45);
      DUMMY.scale.setScalar(r * (turret ? 2.8 : 2.3));
      DUMMY.updateMatrix();
      this.haloMesh.setMatrixAt(m, DUMMY.matrix);
      this.haloMesh.instanceColor!.setXYZ(m, turret ? 1.0 : 1.0, turret ? 0.08 : 0.32, turret ? 0.38 : 0.06);
      // trail (behind the head)
      const tl = Math.min(sp * 0.045, 3.2, Math.hypot(b.pos.x - b.prevPos.x, b.pos.y - b.prevPos.y, b.pos.z - b.prevPos.z) + b.age * sp + 0.2);
      V_A.set(-dx, -dy, -dz);
      DUMMY.position.set(b.pos.x, b.pos.y, b.pos.z);
      DUMMY.quaternion.setFromUnitVectors(V_NZ, V_A);
      DUMMY.scale.set(r * 0.9, r * 0.9, Math.max(0.3, tl));
      DUMMY.updateMatrix();
      this.enemyTrailMesh.setMatrixAt(m, DUMMY.matrix);
      this.enemyTrailMesh.instanceColor!.setXYZ(m, turret ? 0.9 : 1.0, turret ? 0.15 : 0.4, turret ? 0.5 : 0.08);
      m++;
    }
    for (const im of [this.coreMesh, this.haloMesh, this.enemyTrailMesh]) {
      im.count = m;
      im.instanceMatrix.needsUpdate = true;
      im.instanceColor!.needsUpdate = true;
    }
    this.nEnemyBullets = m;

    // missiles
    for (const s of this.missiles) s.active = false;
    for (const ms of missiles) {
      if (!ms.alive) continue;
      let s = this.missileById.get(ms.id);
      if (!s || s.id !== ms.id) {
        s = this.missiles.find((x) => x.id < 0);
        if (!s) continue;
        this.missileById.set(ms.id, s);
        s.id = ms.id;
        s.smokeAcc = 0;
      }
      s.active = true;
      const sp = Math.hypot(ms.vel.x, ms.vel.y, ms.vel.z) || 1;
      V_A.set(ms.vel.x / sp, ms.vel.y / sp, ms.vel.z / sp);
      s.group.visible = true;
      s.group.position.set(ms.pos.x, ms.pos.y, ms.pos.z);
      s.group.quaternion.setFromUnitVectors(V_NZ, V_A);
      const fl = 0.85 + 0.3 * this.R();
      s.flame.scale.set(1, 1, 1.5 * fl);
      s.flameCore.scale.set(0.55, 0.55, 0.9 * fl);
      // exhaust + smoke trail (frame-rate independent)
      s.smokeAcc += dt * 90;
      const tail = { x: ms.pos.x - V_A.x * 0.55, y: ms.pos.y - V_A.y * 0.55, z: ms.pos.z - V_A.z * 0.55 };
      while (s.smokeAcc >= 1) {
        s.smokeAcc -= 1;
        const jit = 0.5;
        this.puff(tail.x, tail.y, tail.z, -V_A.x * 3 + this.rs() * jit, -V_A.y * 3 + this.rs() * jit, -V_A.z * 3 + this.rs() * jit, 1.6, 0.35, 1.4, 0.8, 0.5);
        if (this.R() < 0.5) this.additive.emit({ x: tail.x, y: tail.y, z: tail.z, vx: -V_A.x * 6, vy: -V_A.y * 6, vz: -V_A.z * 6, life: 0.14, size0: 0.5, size1: 0.15, c0: [1, 0.75, 0.35], c1: [1, 0.3, 0.05], a0: 0.9, a1: 0 });
      }
    }
    for (const s of this.missiles) {
      if (!s.active) {
        s.group.visible = false;
        if (s.id >= 0) this.missileById.delete(s.id);
        s.id = -1;
      }
    }
  }

  // ------------------------------------------------------------------ lifetimes
  update(dt: number): void {
    dt = Math.min(dt, 0.05);
    this.clock += dt;
    this.additive.update(dt);
    this.smoke.update(dt);
    for (const b of this.beams) {
      if (!b.active) continue;
      b.age += dt;
      const f = b.age / b.life;
      if (f >= 1) {
        b.active = false;
        b.group.visible = false;
        continue;
      }
      const k = 1 - f;
      b.core.scale.set(0.05 * (0.4 + 0.6 * k), 0.05 * (0.4 + 0.6 * k), 1);
      b.glow.scale.set(0.16 * (0.5 + 0.5 * k), 0.16 * (0.5 + 0.5 * k), 1);
      (b.core.material as MeshBasicMaterial).opacity = k;
      (b.glow.material as MeshBasicMaterial).opacity = 0.6 * k;
    }
    for (const r of this.rings) {
      if (!r.active) continue;
      r.age += dt;
      const f = r.age / r.life;
      if (f >= 1) {
        r.active = false;
        r.mesh.visible = false;
        continue;
      }
      const e = 1 - (1 - f) * (1 - f);
      const rad = r.size * (0.1 + 0.9 * e);
      r.mesh.scale.setScalar(rad);
      let fade = 1;
      if (r.nearFade) {
        // distance from the camera to the ring band itself: the wide shock ring of a blast right next to the camera would otherwise
        // paint the whole lower half of the screen with additive yellow
        const vp = this.viewPos;
        const dx = r.mesh.position.x - vp.x;
        const dz = r.mesh.position.z - vp.z;
        const dy = r.mesh.position.y - vp.y;
        const band = Math.hypot(Math.abs(Math.hypot(dx, dz) - rad), dy);
        const t = Math.min(1, Math.max(0, (band - RING_NEAR_FADE_MIN) / (RING_NEAR_FADE_MAX - RING_NEAR_FADE_MIN)));
        fade = t * t * (3 - 2 * t);
      }
      r.mat.opacity = (r.mesh.userData as { alpha0: number }).alpha0 * (1 - f) * fade;
    }
    for (const l of this.lights) {
      if (!l.active) continue;
      l.age += dt;
      const f = l.age / l.life;
      if (f >= 1) {
        l.active = false;
        l.light.intensity = 0;
        continue;
      }
      l.light.intensity = l.peak * (1 - f) * (1 - f);
    }
    for (let i = this.smokers.length - 1; i >= 0; i--) {
      const s = this.smokers[i];
      if (this.clock >= s.until) {
        this.smokers.splice(i, 1);
        continue;
      }
      s.acc += dt * 9 * Math.max(0.2, (s.until - this.clock) / 6);
      while (s.acc >= 1) {
        s.acc -= 1;
        this.puff(s.x + this.rs() * 0.4, s.y, s.z + this.rs() * 0.4, this.rs() * 0.4, 1.6 + this.R(), this.rs() * 0.4, 1.8, 0.35, 1.4, 0.35, 0.3);
        if (this.R() < 0.15) this.spark(s.x, s.y, s.z, this.rs() * 0.4, 1, this.rs() * 0.4, 5, 0.5, [1, 0.6, 0.2], [1, 0.2, 0.05], 0.08, 8);
      }
    }
  }

  setView(drawingBufferHeight: number, fovYDeg: number): void {
    this.additive.setView(drawingBufferHeight, fovYDeg);
    this.smoke.setView(drawingBufferHeight, fovYDeg);
  }

  /** drop everything (new sortie) */
  clear(): void {
    this.additive.clear();
    this.smoke.clear();
    for (const b of this.beams) {
      b.active = false;
      b.group.visible = false;
    }
    for (const r of this.rings) {
      r.active = false;
      r.mesh.visible = false;
    }
    for (const l of this.lights) {
      l.active = false;
      l.light.intensity = 0;
    }
    for (const s of this.missiles) {
      s.active = false;
      s.id = -1;
      s.group.visible = false;
    }
    this.missileById.clear();
    this.smokers.length = 0;
    for (const im of [this.tracerMesh, this.coreMesh, this.haloMesh, this.enemyTrailMesh]) im.count = 0;
    this.nBullets = 0;
    this.nEnemyBullets = 0;
  }

  stats(): EffectStats {
    return {
      additiveParticles: this.additive.aliveCount,
      smokeParticles: this.smoke.aliveCount,
      beams: this.beams.filter((b) => b.active).length,
      rings: this.rings.filter((r) => r.active).length,
      missiles: this.missiles.filter((m) => m.active).length,
      bullets: this.nBullets,
      enemyBullets: this.nEnemyBullets,
      lightsActive: this.lights.filter((l) => l.active).length,
      smokers: this.smokers.length,
    };
  }

  /** count of scene objects owned by the pool (constant: proves no growth) */
  get poolObjectCount(): number {
    let n = 0;
    this.group.traverse(() => n++);
    return n;
  }

  dispose(): void {
    this.additive.dispose();
    this.smoke.dispose();
    this.group.traverse((o) => {
      const m = o as Mesh;
      if (m.isMesh) {
        m.geometry?.dispose();
        const mat = m.material as MeshBasicMaterial | MeshBasicMaterial[];
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose();
      }
    });
  }
}

export type { EnemyKind };
export { ENEMIES };
