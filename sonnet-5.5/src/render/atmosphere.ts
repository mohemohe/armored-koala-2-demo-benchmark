/**
 * Dusty-air atmosphere: cheap light shafts under ceiling lights (SPEC §8 / 廃工場の質感). No shadow maps and no volumetric
 * pass - a handful of additive, view-dependent cones instanced in ONE draw call, placed under the nearest visible light panels.
 * They are decoration only: faint, faded out when the camera is inside / next to them, and never used for gameplay.
 */
import { AdditiveBlending, BoxGeometry, Color, CylinderGeometry, DoubleSide, DynamicDrawUsage, InstancedBufferAttribute, InstancedMesh, Matrix4, MeshBasicMaterial, Quaternion, ShaderMaterial, Vector3 } from 'three';
import { mulberry32 } from './geo';
import type { LightCandidate } from './stageMesh';

const VERT = /* glsl */ `
varying float vA;
varying vec3 vC;
void main() {
  vec4 wp = instanceMatrix * vec4(position, 1.0);
  vec4 mv = modelViewMatrix * wp;
  vec3 n = normalize(mat3(modelViewMatrix) * mat3(instanceMatrix) * normal);
  vec3 v = normalize(-mv.xyz);
  float rim = pow(abs(dot(n, v)), 1.7);
  float top = clamp(position.y + 1.0, 0.0, 1.0);
  float d = length(mv.xyz);
  vA = rim * pow(top, 1.25) * smoothstep(3.0, 12.0, d) * (1.0 - smoothstep(90.0, 160.0, d));
  vC = instanceColor;
  gl_Position = projectionMatrix * mv;
}
`;
const FRAG = /* glsl */ `
uniform float uOpacity;
varying float vA;
varying vec3 vC;
void main() {
  gl_FragColor = vec4(vC, vA * uOpacity);
}
`;

export const MAX_SHAFTS = 10;

export class LightShafts {
  readonly mesh: InstancedMesh;
  private mat: ShaderMaterial;
  private scanT = 0;
  private m4 = new Matrix4();
  private color = new Color();
  private picks: { d: number; i: number }[] = [];
  count = 0;
  /** world positions of the lamps that currently carry a shaft (the renderer adds a soft halo to each) */
  readonly lamps: { x: number; y: number; z: number }[] = [];

  constructor(readonly max = MAX_SHAFTS) {
    const geo = new CylinderGeometry(0.55, 3.6, 1, 14, 1, true);
    geo.translate(0, -0.5, 0); // spans y in [-1, 0]: origin on the light, the cone opens downward
    this.mat = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uOpacity: { value: 0.2 } },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
      fog: false,
    });
    this.mesh = new InstancedMesh(geo, this.mat, max);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(max * 3), 3);
    this.mesh.instanceColor.setUsage(DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    this.mesh.visible = false;
  }

  /** re-pick the shafts a few times per second: nearest ceiling lights of the visible sectors that are (roughly) in front */
  update(dt: number, cam: Vector3, fwd: Vector3, lights: readonly LightCandidate[], visible: Uint8Array | null, floorY: readonly number[], enabled: boolean): void {
    if (!enabled || lights.length === 0) {
      this.mesh.visible = false;
      this.count = 0;
      this.lamps.length = 0;
      return;
    }
    this.scanT -= dt;
    if (this.scanT > 0) return;
    this.scanT = 0.35;
    const picks = this.picks;
    picks.length = 0;
    for (let i = 0; i < lights.length; i++) {
      const l = lights[i];
      if (l.color !== 0xffe6b8) continue; // ceiling light panels only
      if (visible && l.sector >= 0 && visible[l.sector] === 0) continue;
      const dx = l.pos.x - cam.x;
      const dy = l.pos.y - cam.y;
      const dz = l.pos.z - cam.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > 95 * 95) continue;
      const ahead = dx * fwd.x + dy * fwd.y + dz * fwd.z;
      if (ahead < -8) continue;
      const fl = l.sector >= 0 ? floorY[l.sector] : l.pos.y - 12;
      if (l.pos.y - fl < 6) continue; // low lamps do not make shafts
      if (picks.length < this.max) picks.push({ d: d2, i });
      else {
        let worst = 0;
        for (let k = 1; k < picks.length; k++) if (picks[k].d > picks[worst].d) worst = k;
        if (d2 < picks[worst].d) picks[worst] = { d: d2, i };
      }
    }
    let n = 0;
    this.lamps.length = 0;
    for (const pk of picks) {
      const l = lights[pk.i];
      this.lamps.push({ x: l.pos.x, y: l.pos.y - 0.3, z: l.pos.z });
      const fl = l.sector >= 0 ? floorY[l.sector] : l.pos.y - 12;
      const h = Math.min(24, Math.max(5, l.pos.y - 0.4 - fl));
      this.m4.makeScale(1, h, 1).setPosition(l.pos.x, l.pos.y - 0.4, l.pos.z);
      this.mesh.setMatrixAt(n, this.m4);
      this.color.setHex(0xffd9a0);
      this.mesh.setColorAt(n, this.color);
      n++;
    }
    this.mesh.count = n;
    this.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.mesh.visible = n > 0;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mat.dispose();
    this.mesh.dispose();
  }
}

/**
 * Quick-boost / high-speed "wind" streaks (SPEC §8: QB中の視野の演出は控えめに). The real camera FOV must NOT change (the FCS circle and the
 * HUD markers are projected with the sim camera), so the effect is a set of thin additive streaks flying past the camera, kept at
 * the edge of the screen (outside ~62 % of the half height) so the crosshair and the FCS circle stay clear. Intensity follows the
 * boost / speed; below the threshold nothing is drawn at all.
 */
export const SPEED_LINE_COUNT = 26;

export class SpeedLines {
  readonly mesh: InstancedMesh;
  private mat: MeshBasicMaterial;
  private rnd = mulberry32(0x5eed);
  private phase = new Float32Array(SPEED_LINE_COUNT);
  private ang = new Float32Array(SPEED_LINE_COUNT);
  private rad = new Float32Array(SPEED_LINE_COUNT);
  private level = 0;
  private m4 = new Matrix4();
  private v = new Vector3();
  private one = new Vector3(1, 1, 1);
  private q = new Quaternion();
  active = 0;

  constructor() {
    const geo = new BoxGeometry(1, 1, 1);
    geo.translate(0, 0, -0.5);
    this.mat = new MeshBasicMaterial({ color: 0xbfe8ff, transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false, toneMapped: false, fog: false });
    this.mesh = new InstancedMesh(geo, this.mat, SPEED_LINE_COUNT);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.renderOrder = 22;
    this.mesh.visible = false;
    for (let i = 0; i < SPEED_LINE_COUNT; i++) {
      this.phase[i] = this.rnd();
      this.reroll(i);
    }
  }

  private reroll(i: number): void {
    this.ang[i] = this.rnd() * Math.PI * 2;
    this.rad[i] = 0.66 + 0.4 * this.rnd();
  }

  /** target 0..1 (boost strength); cam = the rendered camera (position / quaternion); tanHalf = tan(fovY / 2) */
  update(dt: number, target: number, camPos: Vector3, camQuat: Quaternion, tanHalf: number, aspect: number): void {
    this.level += (target - this.level) * (1 - Math.exp(-dt * (target > this.level ? 18 : 7)));
    if (this.level < 0.02) {
      this.mesh.visible = false;
      this.mesh.count = 0;
      this.active = 0;
      return;
    }
    const L = this.level;
    this.mat.opacity = 0.34 * L;
    const len = 3 + 9 * L;
    let n = 0;
    for (let i = 0; i < SPEED_LINE_COUNT; i++) {
      let ph = this.phase[i] + dt * (1.6 + 1.4 * L);
      if (ph >= 1) {
        ph -= Math.floor(ph);
        this.reroll(i);
      }
      this.phase[i] = ph;
      const z = 30 - 26 * ph; // flies toward the camera
      const r = this.rad[i] * z * tanHalf;
      const x = Math.cos(this.ang[i]) * r * aspect;
      const y = Math.sin(this.ang[i]) * r;
      this.v.set(x, y, -z).applyQuaternion(camQuat).add(camPos);
      const w = Math.max(0.01, z * 0.0028);
      this.m4.compose(this.v, this.q.copy(camQuat), this.one.set(w, w, len));
      this.mesh.setMatrixAt(n++, this.m4);
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.visible = true;
    this.active = n;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mat.dispose();
    this.mesh.dispose();
  }
}
