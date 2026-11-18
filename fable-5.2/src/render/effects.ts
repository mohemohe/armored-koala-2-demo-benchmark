/**
 * Combat effects — projectile visuals and every transient effect (docs/SPEC.md §8, §9).
 *
 * Draw calls (each one only while it has something to show):
 *   1  additive particles   (≤ 400: sparks, fire, flashes, rings)      instanced quads
 *   1  alpha particles      (≤ 260: smoke, dust, fireball body)         instanced quads
 *   1  transient segments   (≤ 64: beams, muzzle streaks, QB streaks)   instanced capsule ribbons
 *   1  projectile segments  (≤ 384: enemy bolts)                        instanced capsule ribbons
 *   2  own projectile segs  (≤ 96: machine-gun tracers, missile exhaust) the same ribbons, drawn twice: normally
 *                           (depth-tested) and once more where the player's OWN mech hides them (see below)
 *   1  missile bodies       (≤ 8)                                       InstancedMesh
 *   1  explosion debris     (≤ 48 tumbling chunks)                      InstancedMesh
 *
 * Everything lives in fixed-size typed arrays allocated once in the constructor: spawning past a cap
 * is dropped, every transient has a lifetime, `update()` / `syncProjectiles()` allocate nothing.
 * Projectile visuals are stateless: `syncProjectiles` rewrites the instance buffer from the live list
 * every frame, so a visual is gone the frame its projectile is gone (only the missile smoke-trail
 * emitter keeps a small table keyed by projectile id).
 *
 * The player's own projectiles and the own mech: the chase camera looks along the line of fire from behind the
 * mech, so on screen most of the path from the muzzle to a target near the reticle lies behind the mech's head
 * and shoulders (measured at 1280×720, target 37 m ahead: about 80 % of it). The tracers and the missile exhaust
 * are therefore drawn a second time, dimmed, exactly on the pixels where the own mech covers them: the mech's
 * material marks its pixels in the stencil buffer (OWN_MECH_STENCIL, see MechModel) and the second pass draws only
 * there and only what lies BEHIND the surface drawn there (depth test "greater"). Walls, floors and every other
 * object hide projectiles as usual, and enemy bolts are never drawn this way. Without a stencil buffer (a dev
 * harness that creates its own renderer) the second pass simply draws nothing through the mech.
 *
 * Randomness here is purely visual (Math.random) and never touches `sim.rng`.
 * All colours are linear working-space values; materials are additive / untone-mapped emitters.
 */
import * as THREE from 'three';
import { ENEMIES, GRAVITY, PLAYER } from '../config';
import type { Sim } from '../sim/sim';
import type { Projectile, SimEvent } from '../sim/types';

// ───────────────────────────── caps ─────────────────────────────
const GLOW_CAP = 400;
const SMOKE_CAP = 260;
const FX_SEG_CAP = 64;
const PROJ_SEG_CAP = 384;
const OWN_SEG_CAP = 96;
/** Stencil value written by the pixels of the player's own mech (MechModel's body material). */
export const OWN_MECH_STENCIL = 1;
/** Brightness of the player's tracers / missile exhaust where they are seen through the own mech. */
const OWN_GHOST_GAIN = 0.7;
const MISSILE_CAP = 8;
const DEBRIS_CAP = 48;
const TRAIL_SLOTS = 16;

// ───────────────────────────── colours (linear) ─────────────────────────────
type RGB = readonly [number, number, number];
const lin = (hex: number): RGB => {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
};
const C_WHITE: RGB = [1, 1, 1];
const C_MG = lin(0xffd060); // machine-gun tracer glow (yellow-white core added by the shader)
const C_MG_HIT = lin(0xffa838);
const C_SPARK_HOT = lin(0xffc670);
const C_SPARK = lin(0xff7a18);
const C_SPARK_END = lin(0xd2360a);
const C_FIRE = lin(0xff9a2c);
const C_FIRE_END = lin(0x9a2206);
const C_FIRE_BODY = lin(0xf07a1c);
const C_FLASH = lin(0xfff0c8);
const C_BEAM = lin(0x38d8ff); // beam glow, cyan
const C_BEAM_HOT = lin(0xbdf4ff);
const C_THRUST = lin(0x4ab8ff); // cyan-blue thruster
const C_GUARD = lin(0xff5a14); // guard bolt, orange-red
const C_GUARD_END = lin(0xc21c05);
const C_TURRET = lin(0xff1e6e); // turret bolt, magenta-red
const C_TURRET_END = lin(0xa00a50);
const C_PLAYER_HIT = lin(0xff3a16); // red-orange sparks on the player
const C_EXHAUST = lin(0xff8a1e);
const C_CYAN = lin(0x58f2ff);
const C_SMOKE_DARK = lin(0x2a2826);
const C_SMOKE_MID = lin(0x5a5a5c);
const C_SMOKE_LIGHT = lin(0xa9a9ac);
const C_TRAIL = lin(0xf2f3f6); // missile smoke trail: light, reads against dark walls and against fire
const C_TRAIL_END = lin(0xa2a3a9);
const C_DUST = lin(0xb9b0a2);
const C_DEBRIS_HOT = lin(0xff7a20);
const C_DEBRIS_COLD = lin(0x1c1a19);

// ───────────────────────────── particle pool ─────────────────────────────
const PS = 31; // floats of state per particle
const P_X = 0;
const P_Y = 1;
const P_Z = 2;
const P_VX = 3;
const P_VY = 4;
const P_VZ = 5;
const P_AGE = 6;
const P_LIFE = 7;
const P_S0 = 8;
const P_S1 = 9;
const P_R0 = 10;
const P_G0 = 11;
const P_B0 = 12;
const P_R1 = 13;
const P_G1 = 14;
const P_B1 = 15;
const P_A = 16;
const P_GRAV = 17;
const P_DRAG = 18;
const P_ROT = 19;
const P_ROTV = 20;
const P_SHAPE = 21;
const P_ORIENT = 22;
const P_ASPECT = 23;
const P_AX = 24;
const P_AY = 25;
const P_AZ = 26;
const P_FADEIN = 27;
const P_FLOOR = 28;
const P_GROW = 29; // 0 = ease-out growth, 1 = linear
const P_SEED = 30; // 0..0.98, stable per particle (noise offset)

const SHAPE_BLOB = 0;
const SHAPE_RING = 1;
const SHAPE_STREAK = 2;
const SHAPE_SMOKE = 3;
const SHAPE_FLARE = 4;
const ORIENT_BILLBOARD = 0;
const ORIENT_VELOCITY = 1;
const ORIENT_PLANE = 2;
const ORIENT_AXIS = 3; // camera-facing, stretched along a fixed world axis
const NO_FLOOR = -1e9;

const PI_STRIDE = 16; // instance floats: pos3, axis3, size2, color4, misc4

const PARTICLE_VS = /* glsl */ `
attribute vec3 iPos;
attribute vec3 iAxis;
attribute vec2 iSize;
attribute vec4 iColor;
attribute vec4 iMisc; // rotation, shape + seed fraction, orient, life fraction
varying vec2 vUv;
varying vec4 vColor;
varying vec3 vMisc;
void main() {
  vUv = position.xy;
  vColor = iColor;
  vMisc = vec3(floor(iMisc.y), iMisc.w, fract(iMisc.y));
  float orient = iMisc.z;
  float cr = cos(iMisc.x);
  float sr = sin(iMisc.x);
  vec4 mv;
  if (orient < 0.5) {
    mv = modelViewMatrix * vec4(iPos, 1.0);
    vec2 p = vec2(position.x * cr - position.y * sr, position.x * sr + position.y * cr) * iSize;
    mv.xy += p;
  } else if (orient < 1.5) {
    vec4 c = modelViewMatrix * vec4(iPos, 1.0);
    vec3 d = (modelViewMatrix * vec4(iAxis, 0.0)).xyz;
    float dl = length(d);
    d = dl > 1e-5 ? d / dl : vec3(0.0, 1.0, 0.0);
    vec3 toCam = normalize(-c.xyz);
    // Camera-facing quad stretched along the part of the axis that lies across the view. Seen end-on (a
    // missile's smoke trail from the chase camera, a spark flying at the viewer) it is a round blob of its
    // own width — never a sliver seen edge-on.
    vec3 dp = d - toCam * dot(d, toCam);
    float across = length(dp);
    vec3 up = across > 1e-3 ? dp / across : (abs(toCam.y) < 0.99 ? normalize(cross(toCam, vec3(1.0, 0.0, 0.0))) : vec3(0.0, 0.0, 1.0));
    vec3 sd = normalize(cross(up, toCam));
    float halfLen = max(iSize.x, iSize.y * across);
    mv = vec4(c.xyz + sd * position.x * iSize.x + up * position.y * halfLen, 1.0);
  } else {
    vec3 n = normalize(iAxis);
    vec3 t = abs(n.y) < 0.99 ? normalize(cross(vec3(0.0, 1.0, 0.0), n)) : vec3(1.0, 0.0, 0.0);
    vec3 b = cross(n, t);
    vec2 q = vec2(position.x * cr - position.y * sr, position.x * sr + position.y * cr) * iSize;
    mv = modelViewMatrix * vec4(iPos + t * q.x + b * q.y, 1.0);
  }
  // fade out right in front of the camera so nothing ever whites out the view
  vColor.a *= smoothstep(0.8, 3.0, -mv.z);
  gl_Position = projectionMatrix * mv;
}`;

const PARTICLE_FS = /* glsl */ `
varying vec2 vUv;
varying vec4 vColor;
varying vec3 vMisc; // shape, life fraction, seed
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
void main() {
  float r = length(vUv);
  float shape = vMisc.x;
  float a;
  if (shape < 0.5) {
    float g = max(0.0, 1.0 - r);
    a = g * g * (1.0 + 1.5 * g);          // soft blob with a hotter middle
    a = min(a, 1.0);
  } else if (shape < 1.5) {
    float w = mix(0.2, 0.05, vMisc.y);     // ring gets thinner as it expands
    a = smoothstep(w, 0.0, abs(r - (1.0 - w)));
  } else if (shape < 2.5) {
    float ax = max(0.0, 1.0 - abs(vUv.x));
    a = ax * ax * smoothstep(-1.0, 0.7, vUv.y) * smoothstep(1.0, 0.75, vUv.y);
  } else if (shape < 3.5) {
    float g = max(0.0, 1.0 - r);
    float n = vnoise(vUv * 2.3 + vMisc.z * 37.0) * 0.6 + vnoise(vUv * 5.1 - vMisc.z * 91.0) * 0.4;
    a = smoothstep(0.0, 0.55, g) * (0.45 + 0.75 * n);
    a = min(a, 1.0) * smoothstep(0.0, 0.25, g);
  } else {
    float g = max(0.0, 1.0 - r);
    float core = g * g * g * 2.2;
    float sx = max(0.0, 1.0 - abs(vUv.x) * 9.0) * max(0.0, 1.0 - abs(vUv.y));
    float sy = max(0.0, 1.0 - abs(vUv.y) * 9.0) * max(0.0, 1.0 - abs(vUv.x));
    a = min(1.0, core + sx + sy);
  }
  a *= vColor.a;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor.rgb, a);
  #include <colorspace_fragment>
}`;

function quadGeometry(): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.instanceCount = 0;
  return g;
}

class ParticlePool {
  readonly mesh: THREE.Mesh;
  readonly data: Float32Array;
  count = 0;
  private readonly inst: Float32Array;
  private readonly buffer: THREE.InstancedInterleavedBuffer;
  private readonly geo: THREE.InstancedBufferGeometry;

  constructor(
    readonly cap: number,
    material: THREE.ShaderMaterial,
    renderOrder: number,
  ) {
    this.data = new Float32Array(cap * PS);
    this.inst = new Float32Array(cap * PI_STRIDE);
    this.buffer = new THREE.InstancedInterleavedBuffer(this.inst, PI_STRIDE, 1);
    this.buffer.setUsage(THREE.DynamicDrawUsage);
    this.geo = quadGeometry();
    this.geo.setAttribute('iPos', new THREE.InterleavedBufferAttribute(this.buffer, 3, 0));
    this.geo.setAttribute('iAxis', new THREE.InterleavedBufferAttribute(this.buffer, 3, 3));
    this.geo.setAttribute('iSize', new THREE.InterleavedBufferAttribute(this.buffer, 2, 6));
    this.geo.setAttribute('iColor', new THREE.InterleavedBufferAttribute(this.buffer, 4, 8));
    this.geo.setAttribute('iMisc', new THREE.InterleavedBufferAttribute(this.buffer, 4, 12));
    this.mesh = new THREE.Mesh(this.geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.visible = false;
    this.mesh.matrixAutoUpdate = false;
  }

  /** Returns the particle's base offset into `data` (for optional extra fields) or -1 when full. */
  spawn(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    life: number,
    s0: number,
    s1: number,
    c0: RGB,
    c1: RGB,
    alpha: number,
    shape: number,
  ): number {
    if (this.count >= this.cap || !(life > 0)) return -1;
    const d = this.data;
    const b = this.count++ * PS;
    d[b + P_X] = x;
    d[b + P_Y] = y;
    d[b + P_Z] = z;
    d[b + P_VX] = vx;
    d[b + P_VY] = vy;
    d[b + P_VZ] = vz;
    d[b + P_AGE] = 0;
    d[b + P_LIFE] = life;
    d[b + P_S0] = s0;
    d[b + P_S1] = s1;
    d[b + P_R0] = c0[0];
    d[b + P_G0] = c0[1];
    d[b + P_B0] = c0[2];
    d[b + P_R1] = c1[0];
    d[b + P_G1] = c1[1];
    d[b + P_B1] = c1[2];
    d[b + P_A] = alpha;
    d[b + P_GRAV] = 0;
    d[b + P_DRAG] = 0;
    d[b + P_ROT] = Math.random() * 6.283;
    d[b + P_ROTV] = 0;
    d[b + P_SHAPE] = shape;
    d[b + P_ORIENT] = ORIENT_BILLBOARD;
    d[b + P_ASPECT] = 1;
    d[b + P_AX] = 0;
    d[b + P_AY] = 1;
    d[b + P_AZ] = 0;
    d[b + P_FADEIN] = 0;
    d[b + P_FLOOR] = NO_FLOOR;
    d[b + P_GROW] = 0;
    d[b + P_SEED] = Math.random() * 0.98;
    return b;
  }

  update(dt: number): void {
    const d = this.data;
    const o = this.inst;
    let n = this.count;
    let i = 0;
    while (i < n) {
      const b = i * PS;
      const age = d[b + P_AGE] + dt;
      const life = d[b + P_LIFE];
      if (age >= life) {
        n--;
        if (i !== n) d.copyWithin(b, n * PS, n * PS + PS);
        continue;
      }
      d[b + P_AGE] = age;
      const w = i * PI_STRIDE;
      i++;
      if (age < 0) {
        // delayed start: parked, invisible
        o[w] = d[b + P_X];
        o[w + 1] = d[b + P_Y];
        o[w + 2] = d[b + P_Z];
        o[w + 6] = 0;
        o[w + 7] = 0;
        o[w + 11] = 0;
        continue;
      }
      let vx = d[b + P_VX];
      let vy = d[b + P_VY];
      let vz = d[b + P_VZ];
      const drag = d[b + P_DRAG];
      if (drag > 0) {
        const k = 1 / (1 + drag * dt);
        vx *= k;
        vy *= k;
        vz *= k;
      }
      vy -= d[b + P_GRAV] * dt;
      let x = d[b + P_X] + vx * dt;
      let y = d[b + P_Y] + vy * dt;
      let z = d[b + P_Z] + vz * dt;
      const floor = d[b + P_FLOOR];
      if (y < floor) {
        y = floor;
        vy = -vy * 0.35;
        vx *= 0.6;
        vz *= 0.6;
      }
      d[b + P_X] = x;
      d[b + P_Y] = y;
      d[b + P_Z] = z;
      d[b + P_VX] = vx;
      d[b + P_VY] = vy;
      d[b + P_VZ] = vz;
      const t = age / life;
      const e = d[b + P_GROW] > 0.5 ? t : 1 - (1 - t) * (1 - t);
      const size = d[b + P_S0] + (d[b + P_S1] - d[b + P_S0]) * e;
      const fadeIn = d[b + P_FADEIN];
      const alpha = d[b + P_A] * (1 - t * t) * (t < fadeIn ? t / fadeIn : 1);
      const rot = (d[b + P_ROT] += d[b + P_ROTV] * dt);
      const orient = d[b + P_ORIENT];
      o[w] = x;
      o[w + 1] = y;
      o[w + 2] = z;
      if (orient === ORIENT_VELOCITY) {
        const sp = Math.hypot(vx, vy, vz);
        o[w + 3] = vx;
        o[w + 4] = vy;
        o[w + 5] = vz;
        o[w + 6] = size;
        o[w + 7] = Math.max(size, sp * d[b + P_ASPECT]);
      } else {
        o[w + 3] = d[b + P_AX];
        o[w + 4] = d[b + P_AY];
        o[w + 5] = d[b + P_AZ];
        o[w + 6] = size;
        o[w + 7] = size * d[b + P_ASPECT];
      }
      const orientOut = orient === ORIENT_AXIS ? ORIENT_VELOCITY : orient;
      const ct = 1 - (1 - t) * (1 - t); // colours cool quickly, then linger
      o[w + 8] = d[b + P_R0] + (d[b + P_R1] - d[b + P_R0]) * ct;
      o[w + 9] = d[b + P_G0] + (d[b + P_G1] - d[b + P_G0]) * ct;
      o[w + 10] = d[b + P_B0] + (d[b + P_B1] - d[b + P_B0]) * ct;
      o[w + 11] = alpha;
      o[w + 12] = rot;
      o[w + 13] = d[b + P_SHAPE] + d[b + P_SEED]; // integer part = shape, fraction = seed
      o[w + 14] = orientOut;
      o[w + 15] = t;
    }
    this.count = n;
    this.geo.instanceCount = n;
    this.mesh.visible = n > 0;
    if (n > 0) {
      this.buffer.clearUpdateRanges();
      this.buffer.addUpdateRange(0, n * PI_STRIDE);
      this.buffer.needsUpdate = true;
    }
  }

  clear(): void {
    this.count = 0;
    this.geo.instanceCount = 0;
    this.mesh.visible = false;
  }

  dispose(): void {
    this.geo.dispose();
  }
}

// ───────────────────────────── capsule segments ─────────────────────────────
const SEG_STRIDE = 14; // start3, end3, params4 (halfWidth, tailFade, core, minPx), color4

const SEGMENT_VS = /* glsl */ `
attribute vec3 iStart;
attribute vec3 iEnd;
attribute vec4 iParams;
attribute vec4 iColor;
uniform float uViewH;
varying vec2 vP;
varying float vLp;
varying vec4 vColor;
varying vec2 vPar;
void main() {
  vec3 s = (modelViewMatrix * vec4(iStart, 1.0)).xyz;
  vec3 e = (modelViewMatrix * vec4(iEnd, 1.0)).xyz;
  vec3 axis = e - s;
  float len = length(axis);
  vec3 dir = len > 1e-5 ? axis / len : vec3(0.0, 1.0, 0.0);
  vec3 mid = 0.5 * (s + e);
  // never thinner than iParams.w pixels (distant tracers stay readable)
  float px = 2.0 * max(0.0, -mid.z) / (projectionMatrix[1][1] * uViewH);
  float hw = max(iParams.x, iParams.w * px);
  float along = position.y * 0.5 + 0.5;
  vec3 c = mix(s, e, along);
  vec3 tc = normalize(-c);
  vec3 dp = dir - tc * dot(dir, tc);
  float l = length(dp);
  vec3 capDir;
  if (l > 1e-3) {
    capDir = dp / l;
  } else {
    capDir = abs(tc.y) < 0.99 ? normalize(cross(tc, vec3(0.0, 1.0, 0.0))) : vec3(1.0, 0.0, 0.0);
  }
  vec3 sd = normalize(cross(capDir, tc));
  vec3 tm = normalize(-mid);
  float lm = length(dir - tm * dot(dir, tm));
  vLp = len * lm / hw;
  vP = vec2(position.x, along < 0.5 ? -1.0 : vLp + 1.0);
  vColor = iColor;
  vColor.a *= smoothstep(0.5, 2.0, -c.z + hw);
  vPar = iParams.yz;
  vec3 p = c + capDir * position.y * hw + sd * position.x * hw;
  gl_Position = projectionMatrix * vec4(p, 1.0);
}`;

const SEGMENT_FS = /* glsl */ `
varying vec2 vP;
varying float vLp;
varying vec4 vColor;
varying vec2 vPar; // tail fade, core radius
uniform float uGain;
void main() {
  float yy = vP.y - clamp(vP.y, 0.0, vLp);
  float d = length(vec2(vP.x, yy));
  if (d >= 1.0) discard;
  float g = 1.0 - d;
  float glow = g * g;
  float core = vPar.y > 0.001 ? smoothstep(vPar.y, vPar.y * 0.45, d) : 0.0;
  float t = vLp > 1e-3 ? clamp(vP.y / vLp, 0.0, 1.0) : 1.0;
  float fade = mix(1.0, t * t, vPar.x);
  vec3 col = vColor.rgb * glow * 1.25 + mix(vColor.rgb, vec3(1.0), 0.8) * core;
  gl_FragColor = vec4(col * fade * vColor.a * uGain, 1.0);
  #include <colorspace_fragment>
}`;

const _size = new THREE.Vector2();

class SegmentBatch {
  readonly mesh: THREE.Mesh;
  /** Optional second mesh over the same instances (another material): see addPass(). */
  private extra: THREE.Mesh | null = null;
  count = 0;
  private readonly inst: Float32Array;
  private readonly buffer: THREE.InstancedInterleavedBuffer;
  private readonly geo: THREE.InstancedBufferGeometry;

  constructor(
    readonly cap: number,
    material: THREE.ShaderMaterial,
    renderOrder: number,
  ) {
    this.inst = new Float32Array(cap * SEG_STRIDE);
    this.buffer = new THREE.InstancedInterleavedBuffer(this.inst, SEG_STRIDE, 1);
    this.buffer.setUsage(THREE.DynamicDrawUsage);
    this.geo = quadGeometry();
    this.geo.setAttribute('iStart', new THREE.InterleavedBufferAttribute(this.buffer, 3, 0));
    this.geo.setAttribute('iEnd', new THREE.InterleavedBufferAttribute(this.buffer, 3, 3));
    this.geo.setAttribute('iParams', new THREE.InterleavedBufferAttribute(this.buffer, 4, 6));
    this.geo.setAttribute('iColor', new THREE.InterleavedBufferAttribute(this.buffer, 4, 10));
    this.mesh = new THREE.Mesh(this.geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.visible = false;
    this.mesh.matrixAutoUpdate = false;
    const uViewH = material.uniforms.uViewH;
    this.mesh.onBeforeRender = (renderer) => {
      const rt = renderer.getRenderTarget();
      uViewH.value = rt ? rt.height : renderer.getDrawingBufferSize(_size).y;
    };
  }

  /** A second mesh that draws the same instances with another material (shown / hidden with the first). */
  addPass(material: THREE.ShaderMaterial, renderOrder: number): THREE.Mesh {
    const m = new THREE.Mesh(this.geo, material);
    m.frustumCulled = false;
    m.renderOrder = renderOrder;
    m.visible = false;
    m.matrixAutoUpdate = false;
    const uViewH = material.uniforms.uViewH;
    m.onBeforeRender = (renderer) => {
      const rt = renderer.getRenderTarget();
      uViewH.value = rt ? rt.height : renderer.getDrawingBufferSize(_size).y;
    };
    this.extra = m;
    return m;
  }

  begin(): void {
    this.count = 0;
  }

  /** `start` is the tail (faded by `tail` 0..1), `end` the head. Zero length = a round glow. */
  push(
    sx: number,
    sy: number,
    sz: number,
    ex: number,
    ey: number,
    ez: number,
    halfWidth: number,
    tail: number,
    core: number,
    minPx: number,
    c: RGB,
    alpha: number,
  ): void {
    if (this.count >= this.cap) return;
    const o = this.inst;
    const w = this.count++ * SEG_STRIDE;
    o[w] = sx;
    o[w + 1] = sy;
    o[w + 2] = sz;
    o[w + 3] = ex;
    o[w + 4] = ey;
    o[w + 5] = ez;
    o[w + 6] = halfWidth;
    o[w + 7] = tail;
    o[w + 8] = core;
    o[w + 9] = minPx;
    o[w + 10] = c[0];
    o[w + 11] = c[1];
    o[w + 12] = c[2];
    o[w + 13] = alpha;
  }

  commit(): void {
    const n = this.count;
    this.geo.instanceCount = n;
    this.mesh.visible = n > 0;
    if (this.extra) this.extra.visible = n > 0;
    if (n > 0) {
      this.buffer.clearUpdateRanges();
      this.buffer.addUpdateRange(0, n * SEG_STRIDE);
      this.buffer.needsUpdate = true;
    }
  }

  dispose(): void {
    this.geo.dispose();
  }
}

// transient segment state: start3, end3, vel3, hw0, hw1, age, life, rgb3, alpha, tail, core, minPx
const FS = 20;
const F_SX = 0;
const F_EX = 3;
const F_VX = 6;
const F_HW0 = 9;
const F_HW1 = 10;
const F_AGE = 11;
const F_LIFE = 12;
const F_R = 13;
const F_A = 16;
const F_TAIL = 17;
const F_CORE = 18;
const F_MINPX = 19;

// debris state: pos3, vel3, quat4, axis3, spin, scale3, age, life, floor
const DS = 20;
const D_X = 0;
const D_VX = 3;
const D_Q = 6;
const D_AX = 10;
const D_SPIN = 13;
const D_SX = 14;
const D_AGE = 17;
const D_LIFE = 18;
const D_FLOOR = 19;

// ───────────────────────────── small geometry helpers ─────────────────────────────
function coloredGeometry(parts: Array<{ g: THREE.BufferGeometry; m: THREE.Matrix4; color: number; shade?: boolean }>): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const v = new THREE.Vector3();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const n = new THREE.Vector3();
  const color = new THREE.Color();
  for (const part of parts) {
    const g = part.g.index ? part.g.toNonIndexed() : part.g;
    const p = g.getAttribute('position');
    color.setHex(part.color);
    for (let i = 0; i < p.count; i += 3) {
      a.fromBufferAttribute(p, i).applyMatrix4(part.m);
      b.fromBufferAttribute(p, i + 1).applyMatrix4(part.m);
      c.fromBufferAttribute(p, i + 2).applyMatrix4(part.m);
      n.crossVectors(v.subVectors(b, a), c.clone().sub(a)).normalize();
      // baked two-tone shading (the materials are unlit so the shapes read in any lighting)
      const f = part.shade === false ? 1 : 0.72 + 0.28 * Math.max(0, n.y * 0.7 + n.x * 0.3 + 0.3);
      for (const q of [a, b, c]) {
        pos.push(q.x, q.y, q.z);
        col.push(color.r * f, color.g * f, color.b * f);
      }
    }
    if (g !== part.g) g.dispose();
    part.g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  out.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
  out.computeBoundingSphere();
  return out;
}

/** Missile body, nose towards -Z, origin at the centre. */
function missileGeometry(): THREE.BufferGeometry {
  const rotX = new THREE.Matrix4().makeRotationX(-Math.PI / 2); // +Y → -Z
  const at = (z: number): THREE.Matrix4 => new THREE.Matrix4().makeTranslation(0, 0, z).multiply(rotX);
  const parts: Array<{ g: THREE.BufferGeometry; m: THREE.Matrix4; color: number; shade?: boolean }> = [
    { g: new THREE.CylinderGeometry(0.13, 0.13, 0.95, 8, 1, false), m: at(0.05), color: 0xf2f4f6 },
    { g: new THREE.ConeGeometry(0.13, 0.42, 8), m: at(-0.63), color: 0xf2f4f6 },
    { g: new THREE.CylinderGeometry(0.135, 0.135, 0.12, 8, 1, true), m: at(-0.2), color: 0xff8a20 },
    { g: new THREE.CylinderGeometry(0.1, 0.14, 0.14, 8, 1, false), m: at(0.58), color: 0x33363c },
  ];
  for (let i = 0; i < 4; i++) {
    const m = new THREE.Matrix4().makeRotationZ((i * Math.PI) / 2 + Math.PI / 4).multiply(new THREE.Matrix4().makeTranslation(0.2, 0, 0.4));
    parts.push({ g: new THREE.BoxGeometry(0.22, 0.03, 0.3), m, color: 0xc9ced6 });
  }
  return coloredGeometry(parts);
}

/** Irregular armour shard of roughly unit size. */
function debrisGeometry(): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(1, 0.5, 0.8);
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    // skew the box into a wedge-like shard (deterministic)
    p.setXYZ(i, x * (y > 0 ? 0.55 : 1) + z * 0.2, y + x * 0.25, z * (x > 0 ? 0.6 : 1));
  }
  return coloredGeometry([{ g, m: new THREE.Matrix4(), color: 0xffffff }]);
}

// ───────────────────────────── scratch ─────────────────────────────
const _q = new THREE.Quaternion();
const _dq = new THREE.Quaternion();
const _axis = new THREE.Vector3();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _c = new THREE.Color();
const FORWARD = new THREE.Vector3(0, 0, -1);
/** Length of a machine-gun tracer streak (m) and the drawn size of the missile body relative to its model. */
const MG_TRACER_LEN = 8;
const MISSILE_SCALE = 1.5;
const rnd = (a: number, b: number): number => a + Math.random() * (b - a);
/** Random unit vector into module scratch (rx, ry, rz). */
let rx = 0;
let ry = 0;
let rz = 0;
function randomDir(): void {
  const u = Math.random() * 2 - 1;
  const a = Math.random() * 6.2832;
  const s = Math.sqrt(1 - u * u);
  rx = s * Math.cos(a);
  ry = u;
  rz = s * Math.sin(a);
}

export class Effects {
  /** add to the game scene (world space: keep it at the origin, unrotated) */
  readonly group = new THREE.Group();

  private readonly glowMat: THREE.ShaderMaterial;
  private readonly smokeMat: THREE.ShaderMaterial;
  private readonly segMat: THREE.ShaderMaterial;
  private readonly glow: ParticlePool;
  private readonly smoke: ParticlePool;
  private readonly fxSeg: SegmentBatch;
  private readonly projSeg: SegmentBatch;
  /** The player's own projectiles (tracers, missile exhaust) + the material of their pass through the own mech. */
  private readonly ownSeg: SegmentBatch;
  private readonly ownGhostMat: THREE.ShaderMaterial;

  private readonly fx = new Float32Array(FX_SEG_CAP * FS);
  private fxCount = 0;

  private readonly missileGeo: THREE.BufferGeometry;
  private readonly missileMat: THREE.MeshBasicMaterial;
  private readonly missiles: THREE.InstancedMesh;

  private readonly debrisGeo: THREE.BufferGeometry;
  private readonly debrisMat: THREE.MeshBasicMaterial;
  private readonly debris: THREE.InstancedMesh;
  private readonly deb = new Float32Array(DEBRIS_CAP * DS);
  private debCount = 0;

  // missile smoke-trail emitters keyed by projectile id
  private readonly trailId = new Int32Array(TRAIL_SLOTS).fill(-1);
  private readonly trailPos = new Float32Array(TRAIL_SLOTS * 3);
  private readonly trailSeen = new Uint8Array(TRAIL_SLOTS);

  private camX = 0;
  private camY = 0;
  private camZ = 0;
  private hasCam = false;
  private shotSide = 1;
  private disposed = false;

  constructor() {
    this.group.name = 'effects';
    const particleMat = (additive: boolean): THREE.ShaderMaterial =>
      new THREE.ShaderMaterial({
        vertexShader: PARTICLE_VS,
        fragmentShader: PARTICLE_FS,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        side: THREE.DoubleSide,
        blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
        toneMapped: false,
        fog: false,
      });
    this.glowMat = particleMat(true);
    this.smokeMat = particleMat(false);
    this.segMat = new THREE.ShaderMaterial({
      uniforms: { uViewH: { value: 720 }, uGain: { value: 1 } },
      vertexShader: SEGMENT_VS,
      fragmentShader: SEGMENT_FS,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      fog: false,
    });
    // Second pass of the player's own projectile ribbons: only on pixels of the own mech (stencil) and only what
    // lies behind the surface drawn there (depth "greater"). It writes neither depth nor stencil.
    this.ownGhostMat = new THREE.ShaderMaterial({
      uniforms: { uViewH: { value: 720 }, uGain: { value: OWN_GHOST_GAIN } },
      vertexShader: SEGMENT_VS,
      fragmentShader: SEGMENT_FS,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      depthFunc: THREE.GreaterDepth,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      fog: false,
      stencilWrite: true,
      stencilFunc: THREE.EqualStencilFunc,
      stencilRef: OWN_MECH_STENCIL,
      stencilFail: THREE.KeepStencilOp,
      stencilZFail: THREE.KeepStencilOp,
      stencilZPass: THREE.KeepStencilOp,
    });
    // draw order: smoke first, then fire/sparks, then light ribbons
    this.smoke = new ParticlePool(SMOKE_CAP, this.smokeMat, 10);
    this.glow = new ParticlePool(GLOW_CAP, this.glowMat, 11);
    this.fxSeg = new SegmentBatch(FX_SEG_CAP, this.segMat, 12);
    this.projSeg = new SegmentBatch(PROJ_SEG_CAP, this.segMat, 13);
    this.ownSeg = new SegmentBatch(OWN_SEG_CAP, this.segMat, 13);
    const ownGhost = this.ownSeg.addPass(this.ownGhostMat, 14);

    this.missileGeo = missileGeometry();
    this.missileMat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
    this.missiles = new THREE.InstancedMesh(this.missileGeo, this.missileMat, MISSILE_CAP);
    this.missiles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.missiles.frustumCulled = false;
    this.missiles.count = 0;
    this.missiles.visible = false;

    this.debrisGeo = debrisGeometry();
    this.debrisMat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
    this.debris = new THREE.InstancedMesh(this.debrisGeo, this.debrisMat, DEBRIS_CAP);
    this.debris.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.debris.setColorAt(0, _c.setRGB(1, 1, 1)); // allocates instanceColor once
    this.debris.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    this.debris.frustumCulled = false;
    this.debris.count = 0;
    this.debris.visible = false;

    this.group.add(this.smoke.mesh, this.glow.mesh, this.fxSeg.mesh, this.projSeg.mesh, this.ownSeg.mesh, ownGhost, this.missiles, this.debris);
  }

  /** live transient effects (particles + transient segments + debris) — projectile visuals are not transient */
  get activeCount(): number {
    return this.glow.count + this.smoke.count + this.fxCount + this.debCount;
  }

  // ───────────────────────────── events ─────────────────────────────
  /** spawn transient effects for simulation events */
  handleEvent(e: SimEvent, sim: Sim): void {
    if (this.disposed) return;
    switch (e.type) {
      case 'player-shot': {
        const pv = sim.player?.vel;
        const vx = pv ? pv.x : 0;
        const vy = pv ? pv.y : 0;
        const vz = pv ? pv.z : 0;
        const m = e.muzzle;
        const d = e.dir;
        if (e.weapon === 'machinegun') {
          // small star flash that travels with the mech + a short tongue along the barrel line
          const b = this.glow.spawn(m.x + d.x * 0.25, m.y + d.y * 0.25, m.z + d.z * 0.25, vx, vy, vz, 0.05, 0.34, 0.5, C_FLASH, C_MG_HIT, 0.9, SHAPE_FLARE);
          if (b >= 0) this.glow.data[b + P_ROT] = rnd(0, 1.5);
          this.addSegment(m.x, m.y, m.z, m.x + d.x * 1.1, m.y + d.y * 1.1, m.z + d.z * 1.1, vx, vy, vz, 0.1, 0.04, 0.05, C_MG, 0.85, 0, 0.4, 0);
        } else if (e.weapon === 'missile') {
          // launch puff: back-blast smoke + orange flash
          this.glow.spawn(m.x, m.y, m.z, vx, vy, vz, 0.09, 0.5, 1.2, C_FLASH, C_EXHAUST, 0.9, SHAPE_BLOB);
          for (let i = 0; i < 6; i++) {
            randomDir();
            const b = this.smoke.spawn(
              m.x - d.x * 0.3,
              m.y - d.y * 0.3,
              m.z - d.z * 0.3,
              vx * 0.5 - d.x * rnd(2, 6) + rx * 1.2,
              vy * 0.5 - d.y * rnd(2, 6) + ry * 1.2 + 0.6,
              vz * 0.5 - d.z * rnd(2, 6) + rz * 1.2,
              rnd(0.45, 0.8),
              0.3,
              rnd(0.9, 1.4),
              C_SMOKE_LIGHT,
              C_SMOKE_MID,
              0.4,
              SHAPE_SMOKE,
            );
            if (b >= 0) this.smoke.data[b + P_DRAG] = 2.5;
          }
        }
        break;
      }
      case 'beam': {
        const f = e.from;
        const t = e.to;
        // thick cyan-white beam: hot core + soft glow, gone after ≈ 0.12 s
        this.addSegment(f.x, f.y, f.z, t.x, t.y, t.z, 0, 0, 0, 0.5, 0.16, 0.12, C_BEAM, 1, 0, 0.42, 2.5);
        this.addSegment(f.x, f.y, f.z, t.x, t.y, t.z, 0, 0, 0, 1.1, 0.5, 0.1, C_BEAM, 0.22, 0, 0, 0);
        // muzzle flare
        const pv = sim.player?.vel;
        this.glow.spawn(f.x, f.y, f.z, pv ? pv.x : 0, pv ? pv.y : 0, pv ? pv.z : 0, 0.1, 0.55, 0.25, C_BEAM_HOT, C_BEAM, 0.85, SHAPE_FLARE);
        if (e.hit === 'none') break;
        const dx = t.x - f.x;
        const dy = t.y - f.y;
        const dz = t.z - f.z;
        const dl = Math.hypot(dx, dy, dz) || 1;
        const nx = -dx / dl;
        const ny = -dy / dl;
        const nz = -dz / dl;
        // step the impact a little back along the beam so it is not buried in the surface
        const ix = t.x + nx * 0.15;
        const iy = t.y + ny * 0.15;
        const iz = t.z + nz * 0.15;
        if (e.hit === 'enemy') {
          this.glow.spawn(ix, iy, iz, 0, 0, 0, 0.14, 0.8, 2.3, C_WHITE, C_BEAM, 1, SHAPE_BLOB);
          this.glow.spawn(ix, iy, iz, 0, 0, 0, 0.2, 0.5, 2.4, C_BEAM_HOT, C_BEAM, 0.7, SHAPE_RING);
          this.sparks(ix, iy, iz, nx, ny, nz, 12, 7, 20, C_SPARK_HOT, C_SPARK, 0.28, 0.6);
        } else {
          this.glow.spawn(ix, iy, iz, 0, 0, 0, 0.12, 0.6, 1.5, C_BEAM_HOT, C_BEAM, 0.9, SHAPE_BLOB);
          this.sparks(ix, iy, iz, nx, ny, nz, 5, 4, 11, C_BEAM_HOT, C_BEAM, 0.2, 0.4);
          this.dust(ix, iy, iz, nx, ny, nz, 2, 0.8);
        }
        break;
      }
      case 'projectile-hit': {
        const p = e.pos;
        const lod = this.lod(p.x, p.y, p.z);
        if (lod === 0) break;
        if (e.kind === 'missile') {
          this.explosion(p.x, p.y, p.z, 0.8, NO_FLOOR, 3, false);
        } else if (e.target === 'enemy') {
          // orange spark burst
          this.glow.spawn(p.x, p.y, p.z, 0, 0, 0, 0.07, 0.35, 0.9, C_FLASH, C_MG_HIT, 0.95, SHAPE_BLOB);
          this.sparks(p.x, p.y, p.z, 0, 0.3, 0, Math.round(7 * lod), 5, 15, C_SPARK_HOT, C_SPARK, 0.22, 0.45);
        } else if (e.target === 'player') {
          // red-orange sparks at the hit point (kept small: the camera sits right behind the player)
          this.glow.spawn(p.x, p.y, p.z, 0, 0, 0, 0.08, 0.3, 0.8, C_FLASH, C_PLAYER_HIT, 0.9, SHAPE_BLOB);
          this.sparks(p.x, p.y, p.z, 0, 0.4, 0, 7, 4, 11, C_SPARK, C_PLAYER_HIT, 0.25, 0.5);
        } else if (e.kind === 'mg') {
          // grey dust + a few small sparks
          this.glow.spawn(p.x, p.y, p.z, 0, 0, 0, 0.05, 0.2, 0.45, C_FLASH, C_MG_HIT, 0.8, SHAPE_BLOB);
          this.sparks(p.x, p.y, p.z, 0, 0.5, 0, Math.round(3 * lod), 3, 8, C_SPARK_HOT, C_MG_HIT, 0.15, 0.3);
          this.dust(p.x, p.y, p.z, 0, 1, 0, 2, 0.7);
        } else {
          // enemy bolt on scenery
          this.glow.spawn(p.x, p.y, p.z, 0, 0, 0, 0.09, 0.3, 0.9, C_FLASH, C_GUARD, 0.8, SHAPE_BLOB);
          this.sparks(p.x, p.y, p.z, 0, 0.5, 0, Math.round(3 * lod), 3, 8, C_SPARK, C_GUARD_END, 0.2, 0.35);
          this.dust(p.x, p.y, p.z, 0, 1, 0, 1, 0.7);
        }
        break;
      }
      case 'projectile-expired': {
        const p = e.pos;
        if (this.lod(p.x, p.y, p.z) < 1) break;
        if (e.kind === 'missile') {
          this.glow.spawn(p.x, p.y, p.z, 0, 0, 0, 0.12, 0.3, 1.0, C_FLASH, C_EXHAUST, 0.7, SHAPE_BLOB);
          this.dust(p.x, p.y, p.z, 0, 1, 0, 3, 1.1);
        } else {
          this.glow.spawn(p.x, p.y, p.z, 0, 0, 0, 0.14, 0.22, 0.05, e.kind === 'mg' ? C_MG : C_GUARD, e.kind === 'mg' ? C_MG_HIT : C_GUARD_END, 0.5, SHAPE_BLOB);
        }
        break;
      }
      case 'enemy-shot': {
        const m = e.muzzle;
        const d = e.dir;
        if (this.lod(m.x, m.y, m.z) === 0) break;
        // horizontal right of the firing direction
        const hl = Math.hypot(d.x, d.z);
        const rxh = hl > 1e-4 ? -d.z / hl : 1;
        const rzh = hl > 1e-4 ? d.x / hl : 0;
        if (e.kind === 'guard') {
          // the guard model fires from its forearm guns (alternating), the bolt itself starts at e.muzzle
          this.shotSide = -this.shotSide;
          const o = 0.98 * this.shotSide;
          const x = m.x + rxh * o + d.x * 1.15;
          const y = m.y - 0.08 + d.y * 1.15;
          const z = m.z + rzh * o + d.z * 1.15;
          this.glow.spawn(x, y, z, 0, 0, 0, 0.07, 0.45, 0.9, C_FLASH, C_GUARD, 0.95, SHAPE_FLARE);
          this.addSegment(x, y, z, x + d.x * 1.3, y + d.y * 1.3, z + d.z * 1.3, 0, 0, 0, 0.14, 0.05, 0.06, C_GUARD, 0.9, 0, 0.35, 0);
        } else {
          const x = m.x + d.x * 2.1;
          const y = m.y + d.y * 2.1;
          const z = m.z + d.z * 2.1;
          this.glow.spawn(x, y, z, 0, 0, 0, 0.065, 0.7, 1.3, C_FLASH, C_TURRET, 1, SHAPE_FLARE);
          this.glow.spawn(x, y, z, 0, 0, 0, 0.12, 0.4, 1.3, C_TURRET, C_TURRET_END, 0.5, SHAPE_RING);
          this.addSegment(x, y, z, x + d.x * 1.9, y + d.y * 1.9, z + d.z * 1.9, 0, 0, 0, 0.22, 0.06, 0.08, C_TURRET, 0.9, 0, 0.35, 0);
        }
        break;
      }
      case 'enemy-destroyed': {
        const p = e.pos;
        const turret = e.kind === 'turret';
        const floor = p.y - ENEMIES[e.kind].centerHeight;
        const scale = e.isGateControl ? 1.7 : turret ? 1.4 : 1.0;
        const lod = this.lod(p.x, p.y, p.z);
        if (lod === 0) break;
        this.explosion(p.x, p.y, p.z, scale, floor, lod < 1 ? 3 : turret ? 11 : 7, true);
        if (e.isGateControl) {
          // cyan shock rings: one flat on the floor, one facing the camera, plus cyan sparks
          let b = this.glow.spawn(p.x, floor + 0.12, p.z, 0, 0, 0, 0.7, 1.5, 15, C_CYAN, C_BEAM, 0.85, SHAPE_RING);
          if (b >= 0) this.glow.data[b + P_ORIENT] = ORIENT_PLANE;
          b = this.glow.spawn(p.x, p.y + 0.3, p.z, 0, 0, 0, 0.45, 1.0, 8.5, C_CYAN, C_BEAM, 0.7, SHAPE_RING);
          b = this.glow.spawn(p.x, floor + 0.14, p.z, 0, 0, 0, 0.9, 1.0, 9, C_CYAN, C_BEAM, 0.5, SHAPE_RING);
          if (b >= 0) {
            this.glow.data[b + P_ORIENT] = ORIENT_PLANE;
            this.glow.data[b + P_AGE] = -0.12;
          }
          this.sparks(p.x, p.y + 0.4, p.z, 0, 1, 0, 14, 9, 22, C_WHITE, C_CYAN, 0.5, 1.0);
        }
        break;
      }
      case 'qb': {
        const pp = sim.player?.pos;
        if (!pp) break;
        this.quickBoost(pp.x, pp.y, pp.z, e.dir.x, e.dir.z);
        break;
      }
      case 'jump': {
        const pp = sim.player?.pos;
        if (!pp) break;
        this.groundDust(pp.x, pp.y - PLAYER.half.y, pp.z, 0.7);
        break;
      }
      case 'land': {
        const pp = sim.player?.pos;
        if (!pp) break;
        const k = Math.min(1.6, Math.max(0.35, (Number.isFinite(e.speed) ? Math.abs(e.speed) : 6) / 10));
        if (k > 0.4) this.groundDust(pp.x, pp.y - PLAYER.half.y, pp.z, k);
        break;
      }
      case 'barrier-opened': {
        const b = sim.stage?.barriers?.find((x) => x.id === e.barrierId);
        if (b) this.doorFlash(b.box.min, b.box.max);
        break;
      }
      case 'gate-opened': {
        const g = sim.stage?.finalGate;
        if (g) this.doorFlash(g.box.min, g.box.max);
        break;
      }
      default:
        break;
    }
  }

  /** Optional extra for the integrator: a wisp of dark smoke (e.g. from a badly damaged enemy). */
  damageSmoke(x: number, y: number, z: number, strength = 1): void {
    if (this.smoke.count > this.smoke.cap * 0.7) return;
    const b = this.smoke.spawn(x + rnd(-0.3, 0.3), y, z + rnd(-0.3, 0.3), rnd(-0.3, 0.3), rnd(1.2, 2.2), rnd(-0.3, 0.3), rnd(0.9, 1.4), 0.3, 1.1 * strength, C_SMOKE_DARK, C_SMOKE_MID, 0.32, SHAPE_SMOKE);
    if (b >= 0) this.smoke.data[b + P_FADEIN] = 0.2;
  }

  // ───────────────────────────── building blocks ─────────────────────────────
  private lod(x: number, y: number, z: number): number {
    if (!this.hasCam) return 1;
    const d2 = (x - this.camX) ** 2 + (y - this.camY) ** 2 + (z - this.camZ) ** 2;
    return d2 > 260 * 260 ? 0 : d2 > 130 * 130 ? 0.5 : 1;
  }

  private addSegment(
    sx: number,
    sy: number,
    sz: number,
    ex: number,
    ey: number,
    ez: number,
    vx: number,
    vy: number,
    vz: number,
    hw0: number,
    hw1: number,
    life: number,
    c: RGB,
    alpha: number,
    tail: number,
    core: number,
    minPx: number,
  ): void {
    if (this.fxCount >= FX_SEG_CAP) return;
    const f = this.fx;
    const b = this.fxCount++ * FS;
    f[b + F_SX] = sx;
    f[b + F_SX + 1] = sy;
    f[b + F_SX + 2] = sz;
    f[b + F_EX] = ex;
    f[b + F_EX + 1] = ey;
    f[b + F_EX + 2] = ez;
    f[b + F_VX] = vx;
    f[b + F_VX + 1] = vy;
    f[b + F_VX + 2] = vz;
    f[b + F_HW0] = hw0;
    f[b + F_HW1] = hw1;
    f[b + F_AGE] = 0;
    f[b + F_LIFE] = life;
    f[b + F_R] = c[0];
    f[b + F_R + 1] = c[1];
    f[b + F_R + 2] = c[2];
    f[b + F_A] = alpha;
    f[b + F_TAIL] = tail;
    f[b + F_CORE] = core;
    f[b + F_MINPX] = minPx;
  }

  /** Streak sparks thrown into the hemisphere around (nx, ny, nz) (zero normal = all directions). */
  private sparks(
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    count: number,
    vMin: number,
    vMax: number,
    c0: RGB,
    c1: RGB,
    lifeMin: number,
    lifeMax: number,
  ): void {
    const d = this.glow.data;
    for (let i = 0; i < count; i++) {
      randomDir();
      let dx = rx + nx * 0.9;
      let dy = ry + ny * 0.9;
      let dz = rz + nz * 0.9;
      const l = Math.hypot(dx, dy, dz) || 1;
      const sp = rnd(vMin, vMax);
      dx = (dx / l) * sp;
      dy = (dy / l) * sp;
      dz = (dz / l) * sp;
      const b = this.glow.spawn(x, y, z, dx, dy, dz, rnd(lifeMin, lifeMax), rnd(0.045, 0.075), 0.025, c0, c1, 1, SHAPE_STREAK);
      if (b < 0) return;
      d[b + P_ORIENT] = ORIENT_VELOCITY;
      d[b + P_ASPECT] = 0.035; // streak half-length = speed × this
      d[b + P_GRAV] = GRAVITY * 0.8;
      d[b + P_DRAG] = 1.6;
    }
  }

  /** Small grey dust puffs drifting away from a surface. */
  private dust(x: number, y: number, z: number, nx: number, ny: number, nz: number, count: number, size: number): void {
    const d = this.smoke.data;
    for (let i = 0; i < count; i++) {
      randomDir();
      const b = this.smoke.spawn(
        x,
        y,
        z,
        nx * rnd(0.6, 1.8) + rx * 0.7,
        ny * rnd(0.6, 1.8) + ry * 0.5 + 0.4,
        nz * rnd(0.6, 1.8) + rz * 0.7,
        rnd(0.4, 0.75),
        0.22 * size,
        rnd(0.9, 1.4) * size,
        C_SMOKE_LIGHT,
        C_SMOKE_MID,
        0.5,
        SHAPE_SMOKE,
      );
      if (b < 0) return;
      d[b + P_DRAG] = 2.2;
      d[b + P_ROTV] = rnd(-1, 1);
    }
  }

  /** Dust ring kicked up at the player's feet (jump / landing). */
  private groundDust(x: number, y: number, z: number, k: number): void {
    const d = this.smoke.data;
    const n = Math.round(5 + 4 * k);
    const a0 = Math.random() * 6.283;
    for (let i = 0; i < n; i++) {
      const a = a0 + (i / n) * 6.283;
      const cx = Math.cos(a);
      const cz = Math.sin(a);
      const sp = rnd(2.5, 4.5) * k;
      const b = this.smoke.spawn(x + cx * 0.9, y + 0.25, z + cz * 0.9, cx * sp, rnd(0.3, 0.9), cz * sp, rnd(0.55, 0.9), 0.4, rnd(1.1, 1.7) * (0.6 + 0.5 * k), C_DUST, C_SMOKE_LIGHT, 0.5, SHAPE_SMOKE);
      if (b < 0) break;
      d[b + P_DRAG] = 3.2;
      d[b + P_ROTV] = rnd(-1, 1);
      d[b + P_FADEIN] = 0.1;
    }
    if (k > 0.8) {
      const b = this.glow.spawn(x, y + 0.08, z, 0, 0, 0, 0.3, 1.2, 3.2 * k, C_SMOKE_LIGHT, C_SMOKE_MID, 0.12, SHAPE_RING);
      if (b >= 0) this.glow.data[b + P_ORIENT] = ORIENT_PLANE;
    }
  }

  /** Quick boost: an expanding ring behind the mech, a thruster burst and a few speed streaks. */
  private quickBoost(x: number, y: number, z: number, dirX: number, dirZ: number): void {
    const l = Math.hypot(dirX, dirZ);
    const dx = l > 1e-6 ? dirX / l : 0;
    const dz = l > 1e-6 ? dirZ / l : -1;
    const g = this.glow.data;
    // rings in the plane perpendicular to the boost, left behind the mech
    for (let i = 0; i < 2; i++) {
      const back = 1.6 + i * 2.2;
      const b = this.glow.spawn(x - dx * back, y + 0.2, z - dz * back, -dx * 3, 0, -dz * 3, 0.26 + i * 0.08, 1.0, 3.6 - i * 1.0, C_BEAM_HOT, C_THRUST, 0.55 - i * 0.15, SHAPE_RING);
      if (b < 0) break;
      g[b + P_ORIENT] = ORIENT_PLANE;
      g[b + P_AX] = dx;
      g[b + P_AY] = 0;
      g[b + P_AZ] = dz;
      g[b + P_AGE] = -i * 0.03;
    }
    // thruster burst
    for (let i = 0; i < 4; i++) {
      randomDir();
      const b = this.glow.spawn(x - dx * 1.5 + rx * 0.5, y + 0.3 + ry * 0.6, z - dz * 1.5 + rz * 0.5, -dx * rnd(8, 16) + rx, ry, -dz * rnd(8, 16) + rz, rnd(0.14, 0.22), 1.1, 0.25, C_BEAM_HOT, C_THRUST, 0.7, SHAPE_BLOB);
      if (b >= 0) g[b + P_DRAG] = 4;
    }
    // speed streaks: thin lines left in the air, parallel to the boost, around the mech
    const px = -dz; // horizontal perpendicular
    const pz = dx;
    for (let i = 0; i < 7; i++) {
      const side = rnd(-2.6, 2.6);
      const up = rnd(-1.6, 2.2);
      const ox = x + px * side;
      const oy = y + up;
      const oz = z + pz * side;
      const s0 = rnd(0.5, 2.0);
      const len = rnd(3.5, 6.5);
      this.addSegment(ox - dx * (s0 + len), oy, oz - dz * (s0 + len), ox - dx * s0, oy, oz - dz * s0, -dx * 6, 0, -dz * 6, 0.045, 0.02, rnd(0.18, 0.28), C_BEAM_HOT, 0.6, 1, 0, 1.2);
    }
  }

  /** Fireball, sparks, smoke column, ground flash, shock ring and debris. */
  private explosion(x: number, y: number, z: number, s: number, floor: number, debris: number, big: boolean): void {
    const g = this.glow.data;
    const sm = this.smoke.data;
    // core flash (very short, the only white-hot part)
    this.glow.spawn(x, y, z, 0, 0, 0, 0.09, 0.9 * s, 2.6 * s, C_WHITE, C_FLASH, 1, SHAPE_BLOB);
    // fireball: rolling orange → dark red light
    const fire = big ? 7 : 5;
    for (let i = 0; i < fire; i++) {
      randomDir();
      const sp = rnd(2, 5) * s;
      const b = this.glow.spawn(x + rx * 0.45 * s, y + ry * 0.35 * s, z + rz * 0.45 * s, rx * sp, Math.abs(ry) * sp + 1.5, rz * sp, rnd(0.34, 0.6), 0.6 * s, rnd(1.3, 1.9) * s, C_FIRE, C_FIRE_END, 0.5, SHAPE_BLOB);
      if (b < 0) break;
      g[b + P_DRAG] = 3;
      g[b + P_AGE] = -i * 0.015;
    }
    // burning smoke: opaque orange-brown puffs that give the fireball a body and darken quickly
    const body = big ? 6 : 4;
    for (let i = 0; i < body; i++) {
      randomDir();
      const sp = rnd(2.5, 6) * s;
      const b = this.smoke.spawn(x + rx * 0.4 * s, y + ry * 0.3 * s, z + rz * 0.4 * s, rx * sp, Math.abs(ry) * sp * 0.8 + 1.5, rz * sp, rnd(0.55, 0.9), 0.7 * s, rnd(1.6, 2.2) * s, C_FIRE_BODY, C_SMOKE_DARK, 0.85, SHAPE_SMOKE);
      if (b < 0) break;
      sm[b + P_DRAG] = 3.5;
      sm[b + P_ROTV] = rnd(-1.5, 1.5);
    }
    // shock ring facing the camera (thin, quick)
    this.glow.spawn(x, y, z, 0, 0, 0, 0.2, 0.8 * s, 4.4 * s, C_FLASH, C_SPARK, 0.28, SHAPE_RING);
    // sparks
    this.sparks(x, y, z, 0, 0.6, 0, big ? Math.round(16 * s) : 10, 7 * s, 22 * s, C_SPARK_HOT, C_SPARK_END, 0.4, 0.95);
    // ground flash
    if (floor > NO_FLOOR) {
      const b = this.glow.spawn(x, floor + 0.08, z, 0, 0, 0, 0.3, 2.0 * s, 5.0 * s, C_FIRE, C_FIRE_END, 0.5, SHAPE_BLOB);
      if (b >= 0) g[b + P_ORIENT] = ORIENT_PLANE;
    }
    // smoke column rising from the wreck
    const puffs = big ? Math.round(6 + 3 * s) : 4;
    for (let i = 0; i < puffs; i++) {
      randomDir();
      const b = this.smoke.spawn(x + rx * 0.7 * s, y + ry * 0.3 * s, z + rz * 0.7 * s, rx * 1.3, rnd(1.8, 3.8), rz * 1.3, rnd(1.5, 2.5), 1.0 * s, rnd(2.2, 3.0) * s, C_SMOKE_DARK, C_SMOKE_MID, 0.62, SHAPE_SMOKE);
      if (b < 0) break;
      sm[b + P_AGE] = -0.03 - i * (big ? 0.07 : 0.05);
      sm[b + P_DRAG] = 0.6;
      sm[b + P_ROTV] = rnd(-0.6, 0.6);
      sm[b + P_FADEIN] = 0.1;
      sm[b + P_GROW] = 1;
    }
    // debris
    for (let i = 0; i < debris; i++) {
      randomDir();
      const sp = rnd(5, 13) * Math.sqrt(s);
      this.spawnDebris(x + rx * 0.4, y + 0.2, z + rz * 0.4, rx * sp, Math.abs(ry) * sp + rnd(3, 8), rz * sp, rnd(0.22, 0.5) * s, rnd(1.2, 2.1), floor);
    }
  }

  private spawnDebris(x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number, life: number, floor: number): void {
    if (this.debCount >= DEBRIS_CAP) return;
    const d = this.deb;
    const b = this.debCount++ * DS;
    d[b + D_X] = x;
    d[b + D_X + 1] = y;
    d[b + D_X + 2] = z;
    d[b + D_VX] = vx;
    d[b + D_VX + 1] = vy;
    d[b + D_VX + 2] = vz;
    randomDir();
    _q.setFromAxisAngle(_axis.set(rx, ry, rz), Math.random() * 6.28);
    d[b + D_Q] = _q.x;
    d[b + D_Q + 1] = _q.y;
    d[b + D_Q + 2] = _q.z;
    d[b + D_Q + 3] = _q.w;
    randomDir();
    d[b + D_AX] = rx;
    d[b + D_AX + 1] = ry;
    d[b + D_AX + 2] = rz;
    d[b + D_SPIN] = rnd(4, 14);
    d[b + D_SX] = size * rnd(0.7, 1.3);
    d[b + D_SX + 1] = size * rnd(0.5, 1.0);
    d[b + D_SX + 2] = size * rnd(0.7, 1.3);
    d[b + D_AGE] = 0;
    d[b + D_LIFE] = life;
    d[b + D_FLOOR] = floor;
  }

  /** Cyan flash across an opening barrier / gate. */
  private doorFlash(min: { x: number; y: number; z: number }, max: { x: number; y: number; z: number }): void {
    const cx = (min.x + max.x) / 2;
    const cy = (min.y + max.y) / 2;
    const cz = (min.z + max.z) / 2;
    const wx = max.x - min.x;
    const wz = max.z - min.z;
    const h = max.y - min.y;
    // across the wider horizontal extent
    const ax = wx >= wz ? 1 : 0;
    const az = wx >= wz ? 0 : 1;
    const half = Math.max(wx, wz) / 2;
    this.addSegment(cx - ax * half, min.y + 0.3, cz - az * half, cx + ax * half, min.y + 0.3, cz + az * half, 0, h * 0.9, 0, 0.5, 0.15, 0.9, C_CYAN, 0.8, 0, 0.3, 2);
    this.glow.spawn(cx, cy, cz, 0, 0, 0, 0.6, 2, Math.max(6, half * 1.6), C_CYAN, C_BEAM, 0.32, SHAPE_RING);
    for (let i = 0; i < 10; i++) {
      const t = rnd(-1, 1) * half;
      this.sparks(cx + ax * t, min.y + 0.3, cz + az * t, 0, 1, 0, 1, 4, 10, C_WHITE, C_CYAN, 0.4, 0.9);
    }
  }

  // ───────────────────────────── projectiles ─────────────────────────────
  /** show every live projectile at pos + vel·leadSeconds */
  syncProjectiles(projectiles: readonly Projectile[], leadSeconds: number): void {
    if (this.disposed) return;
    const lead = Number.isFinite(leadSeconds) ? leadSeconds : 0;
    const seg = this.projSeg;
    const own = this.ownSeg;
    seg.begin();
    own.begin();
    this.trailSeen.fill(0);
    let mc = 0;
    for (let i = 0; i < projectiles.length; i++) {
      const p = projectiles[i];
      if (!p.alive) continue;
      const x = p.pos.x + p.vel.x * lead;
      const y = p.pos.y + p.vel.y * lead;
      const z = p.pos.z + p.vel.z * lead;
      const sp = Math.hypot(p.vel.x, p.vel.y, p.vel.z);
      const dx = sp > 1e-6 ? p.vel.x / sp : 0;
      const dy = sp > 1e-6 ? p.vel.y / sp : 0;
      const dz = sp > 1e-6 ? p.vel.z / sp : -1;
      // a streak never reaches back past the point it was fired from
      const flown = Math.hypot(x - p.origin.x, y - p.origin.y, z - p.origin.z);
      if (p.kind === 'mg') {
        // Tracer: a long yellow-white streak with a hot core and a bright head. The chase camera looks along
        // the line of fire, so a streak is seen almost end-on — a short thin one (3 m × 0.08 m) was a few dim
        // pixels. At 10 rounds/s and 100 m/s the rounds are 10 m apart: 8 m streaks read as a dashed line of
        // separate rounds from the muzzle to the target; the head stays smaller than an enemy.
        const len = Math.min(MG_TRACER_LEN, flown);
        own.push(x - dx * len, y - dy * len, z - dz * len, x, y, z, 0.15, 0.65, 0.5, 2.2, C_MG, 1);
        own.push(x, y, z, x, y, z, 0.3, 0, 0.36, 3, C_MG, 0.9);
      } else if (p.kind === 'missile') {
        if (mc < MISSILE_CAP) {
          _q.setFromUnitVectors(FORWARD, _v.set(dx, dy, dz));
          _m.compose(_v.set(x, y, z), _q, _s.set(MISSILE_SCALE, MISSILE_SCALE, MISSILE_SCALE));
          this.missiles.setMatrixAt(mc++, _m);
        }
        // exhaust: hot tongue behind the nozzle + flare (large enough to follow the missile from behind)
        const back = 0.66 * MISSILE_SCALE;
        const nx = x - dx * back;
        const ny = y - dy * back;
        const nz = z - dz * back;
        const el = Math.min(3.4, Math.max(0, flown - back)) * (0.85 + 0.3 * Math.random());
        own.push(nx - dx * el, ny - dy * el, nz - dz * el, nx, ny, nz, 0.3, 1, 0.55, 2.5, C_EXHAUST, 1);
        // flare: a white-hot core in an orange glow (seen from behind this IS the missile: the body is ≈ 8 px)
        own.push(nx, ny, nz, nx, ny, nz, 0.85, 0, 0.5, 6, C_EXHAUST, 1);
        this.missileTrail(p.id, nx, ny, nz);
      } else {
        const turret = p.ownerKind === 'turret';
        const len = Math.min(turret ? 2.8 : 1.8, flown);
        const col = turret ? C_TURRET : C_GUARD;
        seg.push(x - dx * len, y - dy * len, z - dz * len, x, y, z, turret ? 0.2 : 0.13, 1, 0.4, 1.5, col, 1);
        seg.push(x, y, z, x, y, z, turret ? 0.56 : 0.32, 0, turret ? 0.34 : 0.3, turret ? 3 : 2, col, 0.9);
      }
    }
    seg.commit();
    own.commit();
    this.missiles.count = mc;
    this.missiles.visible = mc > 0;
    if (mc > 0) this.missiles.instanceMatrix.needsUpdate = true;
    for (let s = 0; s < TRAIL_SLOTS; s++) {
      if (!this.trailSeen[s]) this.trailId[s] = -1;
    }
  }

  /** Leaves grey smoke puffs along the path a missile nozzle travelled since the last frame. */
  private missileTrail(id: number, x: number, y: number, z: number): void {
    let slot = -1;
    let free = -1;
    for (let s = 0; s < TRAIL_SLOTS; s++) {
      if (this.trailId[s] === id) {
        slot = s;
        break;
      }
      if (free < 0 && this.trailId[s] === -1) free = s;
    }
    const tp = this.trailPos;
    if (slot < 0) {
      if (free < 0) return;
      slot = free;
      this.trailId[slot] = id;
      tp[slot * 3] = x;
      tp[slot * 3 + 1] = y;
      tp[slot * 3 + 2] = z;
      this.trailSeen[slot] = 1;
      return;
    }
    this.trailSeen[slot] = 1;
    const lx = tp[slot * 3];
    const ly = tp[slot * 3 + 1];
    const lz = tp[slot * 3 + 2];
    const dist = Math.hypot(x - lx, y - ly, z - lz);
    const SPACING = 0.9;
    if (dist < SPACING) return;
    if (dist > 30) {
      // teleport / huge frame: restart the trail instead of bridging the gap
      tp[slot * 3] = x;
      tp[slot * 3 + 1] = y;
      tp[slot * 3 + 2] = z;
      return;
    }
    const n = Math.floor(dist / SPACING);
    const sm = this.smoke;
    const ax = (x - lx) / dist;
    const ay = (y - ly) / dist;
    const az = (z - lz) / dist;
    for (let k = 1; k <= n; k++) {
      const t = (k * SPACING) / dist;
      if (sm.count > sm.cap * 0.8) break; // leave room for explosions
      const b = sm.spawn(lx + (x - lx) * t + rnd(-0.1, 0.1), ly + (y - ly) * t + rnd(-0.1, 0.1), lz + (z - lz) * t + rnd(-0.1, 0.1), rnd(-0.35, 0.35), rnd(0.1, 0.7), rnd(-0.35, 0.35), rnd(0.9, 1.3), 0.35, rnd(0.85, 1.2), C_TRAIL, C_TRAIL_END, 0.78, SHAPE_SMOKE);
      if (b < 0) break;
      // puffs are stretched along the flight path so that they join into one ribbon of smoke
      const d = sm.data;
      d[b + P_ORIENT] = ORIENT_AXIS;
      d[b + P_AX] = ax;
      d[b + P_AY] = ay;
      d[b + P_AZ] = az;
      d[b + P_ASPECT] = rnd(1.5, 2.1);
    }
    const adv = (n * SPACING) / dist;
    tp[slot * 3] = lx + (x - lx) * adv;
    tp[slot * 3 + 1] = ly + (y - ly) * adv;
    tp[slot * 3 + 2] = lz + (z - lz) * adv;
  }

  // ───────────────────────────── per frame ─────────────────────────────
  /** age / recycle */
  update(dt: number, cameraPos: { x: number; y: number; z: number }): void {
    if (this.disposed) return;
    const h = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.1) : 0;
    if (cameraPos && Number.isFinite(cameraPos.x) && Number.isFinite(cameraPos.y) && Number.isFinite(cameraPos.z)) {
      this.camX = cameraPos.x;
      this.camY = cameraPos.y;
      this.camZ = cameraPos.z;
      this.hasCam = true;
    }
    this.smoke.update(h);
    this.glow.update(h);

    // transient segments
    const f = this.fx;
    const seg = this.fxSeg;
    seg.begin();
    let n = this.fxCount;
    let i = 0;
    while (i < n) {
      const b = i * FS;
      const age = f[b + F_AGE] + h;
      const life = f[b + F_LIFE];
      if (age >= life) {
        n--;
        if (i !== n) f.copyWithin(b, n * FS, n * FS + FS);
        continue;
      }
      f[b + F_AGE] = age;
      for (let k = 0; k < 3; k++) {
        const dv = f[b + F_VX + k] * h;
        f[b + F_SX + k] += dv;
        f[b + F_EX + k] += dv;
      }
      const t = age / life;
      const hw = f[b + F_HW0] + (f[b + F_HW1] - f[b + F_HW0]) * t;
      const fade = (1 - t) * (1 - t * 0.5);
      _rgb[0] = f[b + F_R];
      _rgb[1] = f[b + F_R + 1];
      _rgb[2] = f[b + F_R + 2];
      seg.push(f[b + F_SX], f[b + F_SX + 1], f[b + F_SX + 2], f[b + F_EX], f[b + F_EX + 1], f[b + F_EX + 2], hw, f[b + F_TAIL], f[b + F_CORE], f[b + F_MINPX], _rgb, f[b + F_A] * fade);
      i++;
    }
    this.fxCount = n;
    seg.commit();

    // debris
    const d = this.deb;
    n = this.debCount;
    i = 0;
    const mesh = this.debris;
    while (i < n) {
      const b = i * DS;
      const age = d[b + D_AGE] + h;
      const life = d[b + D_LIFE];
      if (age >= life) {
        n--;
        if (i !== n) d.copyWithin(b, n * DS, n * DS + DS);
        continue;
      }
      d[b + D_AGE] = age;
      let vy = d[b + D_VX + 1] - GRAVITY * h;
      let x = d[b + D_X] + d[b + D_VX] * h;
      let y = d[b + D_X + 1] + vy * h;
      let z = d[b + D_X + 2] + d[b + D_VX + 2] * h;
      const floor = d[b + D_FLOOR] + 0.1;
      let spin = d[b + D_SPIN];
      if (y < floor) {
        y = floor;
        vy = Math.abs(vy) > 2.5 ? -vy * 0.32 : 0;
        d[b + D_VX] *= 0.55;
        d[b + D_VX + 2] *= 0.55;
        spin *= 0.5;
        d[b + D_SPIN] = spin;
      }
      d[b + D_X] = x;
      d[b + D_X + 1] = y;
      d[b + D_X + 2] = z;
      d[b + D_VX + 1] = vy;
      _q.set(d[b + D_Q], d[b + D_Q + 1], d[b + D_Q + 2], d[b + D_Q + 3]);
      _dq.setFromAxisAngle(_axis.set(d[b + D_AX], d[b + D_AX + 1], d[b + D_AX + 2]), spin * h);
      _q.premultiply(_dq).normalize();
      d[b + D_Q] = _q.x;
      d[b + D_Q + 1] = _q.y;
      d[b + D_Q + 2] = _q.z;
      d[b + D_Q + 3] = _q.w;
      const t = age / life;
      const shrink = t > 0.8 ? (1 - t) / 0.2 : 1;
      _m.compose(_v.set(x, y, z), _q, _s.set(d[b + D_SX] * shrink, d[b + D_SX + 1] * shrink, d[b + D_SX + 2] * shrink));
      mesh.setMatrixAt(i, _m);
      // glowing hot at first, cooling to charred metal
      const heat = Math.max(0, 1 - t * 2.2);
      _c.setRGB(
        C_DEBRIS_COLD[0] + (C_DEBRIS_HOT[0] - C_DEBRIS_COLD[0]) * heat,
        C_DEBRIS_COLD[1] + (C_DEBRIS_HOT[1] - C_DEBRIS_COLD[1]) * heat,
        C_DEBRIS_COLD[2] + (C_DEBRIS_HOT[2] - C_DEBRIS_COLD[2]) * heat,
      );
      mesh.setColorAt(i, _c);
      i++;
    }
    this.debCount = n;
    mesh.count = n;
    mesh.visible = n > 0;
    if (n > 0) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor!.needsUpdate = true;
    }
  }

  /** remove everything (new sortie) */
  clear(): void {
    this.glow.clear();
    this.smoke.clear();
    this.fxCount = 0;
    this.fxSeg.begin();
    this.fxSeg.commit();
    this.projSeg.begin();
    this.projSeg.commit();
    this.ownSeg.begin();
    this.ownSeg.commit();
    this.debCount = 0;
    this.debris.count = 0;
    this.debris.visible = false;
    this.missiles.count = 0;
    this.missiles.visible = false;
    this.trailId.fill(-1);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
    this.group.removeFromParent();
    this.glow.dispose();
    this.smoke.dispose();
    this.fxSeg.dispose();
    this.projSeg.dispose();
    this.ownSeg.dispose();
    this.glowMat.dispose();
    this.smokeMat.dispose();
    this.segMat.dispose();
    this.ownGhostMat.dispose();
    this.missileGeo.dispose();
    this.missileMat.dispose();
    this.missiles.dispose();
    this.debrisGeo.dispose();
    this.debrisMat.dispose();
    this.debris.dispose();
  }
}

const _rgb: [number, number, number] = [0, 0, 0];
