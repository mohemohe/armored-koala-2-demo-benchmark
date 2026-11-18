/**
 * Enemy models: security robot (2-legged walker) and fixed turret. Primitive assemblies, merged per material slot.
 * Local frame: origin = EnemyState.pos (hit-sphere center), forward = -Z, +Y up. The bullet origin (sim) is
 * pos + (0, 0.4, 0); the barrel pivot sits exactly on it so the visible barrel is collinear with the real shot.
 */
import {
  AdditiveBlending,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  Material,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OctahedronGeometry,
  SphereGeometry,
  TorusGeometry,
} from 'three';
import { ENEMIES } from '../config';
import type { EnemyKind } from '../config';
import type { EnemyState, V3 } from '../sim/types';
import type { RGB } from './geo';
import { PartBuilder } from './parts';
import { MaterialLibrary } from './textures';

export const MUZZLE_HEIGHT = 0.4;

export interface EnemyMaterials {
  [slot: string]: Material;
  /** one PBR material for all enemy armour; colours come from vertex colours (see the *_TINT palettes) */
  unit: MeshStandardMaterial;
  hazard: MeshStandardMaterial;
  lens: MeshBasicMaterial;
  red: MeshBasicMaterial;
  flash: MeshBasicMaterial;
  wreck: MeshStandardMaterial;
  ember: MeshBasicMaterial;
  // shared effect materials
  glowGuard: MeshBasicMaterial;
  glowTurret: MeshBasicMaterial;
  beaconPillar: MeshBasicMaterial;
  beaconCore: MeshBasicMaterial;
}

// linear vertex tints on the light-gray armor texture (see mech.ts): target_linear / texture_linear
const OLIVE: RGB = [0.34, 0.4, 0.22];
const YELLOW: RGB = [2.6, 1.45, 0.05];
const DARKC: RGB = [0.2, 0.21, 0.24];
const STEELC: RGB = [0.5, 0.63, 0.87];
const REDC: RGB = [1.4, 0.07, 0.05];

/**
 * Rim light on the enemy armour: an amber glow along the silhouette (grazing angles) plus a lift on the upward faces, added to the
 * emissive term. The stage is grey-blue and the turret paint is blue-grey, so without it an enemy in front of a similar wall lost its
 * outline (tests/audit-ui/stage-audit.ts V11: 6 of 30 cases with |dL| < 0.05 and colour distance < 0.08). Measured on 22 cases with the
 * values below: all pass, min colour distance 0.104 (before: 6 fail).
 * The uniforms are shared by every patched material (one program, `userData.rim` gives dev tools access to the live values).
 */
export const ENEMY_RIM = {
  /** rim colour x strength (linear, added before tone mapping): a saturated amber, so the enemy differs in HUE from the grey-blue stage even where
   *  its luminance matches the wall (a pale / white rim only moves the luminance past the wall's and just swaps which backgrounds it matches) */
  rim: [1.0, 0.45, 0.1] as const,
  /** exponent of (1 - N.V): smaller = the glow reaches further in from the silhouette */
  power: 1.2,
  /** light added on faces looking up (linear rgb) */
  top: [0.13, 0.08, 0.03] as const,
};

function patchEnemyRim(ms: MeshStandardMaterial[]): void {
  const rim = { uRimColor: { value: new Color(...ENEMY_RIM.rim) }, uRimTop: { value: new Color(...ENEMY_RIM.top) }, uRimPower: { value: ENEMY_RIM.power } };
  for (const m of ms) {
    m.userData.rim = rim;
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, rim);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec3 uRimColor;\nuniform vec3 uRimTop;\nuniform float uRimPower;')
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
{
  vec3 rimN = normalize( normal );
  float rimNV = clamp( dot( rimN, normalize( vViewPosition ) ), 0.0, 1.0 );
  float rimUp = clamp( inverseTransformDirection( rimN, viewMatrix ).y, 0.0, 1.0 );
  totalEmissiveRadiance += uRimColor * pow( 1.0 - rimNV, uRimPower ) + uRimTop * rimUp;
}`,
        );
    };
    m.customProgramCacheKey = () => 'enemy-rim';
  }
}

export function createEnemyMaterials(lib: MaterialLibrary): EnemyMaterials {
  const std = (o: ConstructorParameters<typeof MeshStandardMaterial>[0]): MeshStandardMaterial => new MeshStandardMaterial({ vertexColors: true, ...o });
  const unit = std({ map: lib.texture('armorLight'), roughness: 0.5, metalness: 0.5 });
  const hazard = std({ map: lib.texture('hazard'), roughness: 0.7, metalness: 0.1 });
  patchEnemyRim([unit, hazard]);
  return {
    unit,
    hazard,
    lens: new MeshBasicMaterial({ color: 0x7fe8ff, vertexColors: true, toneMapped: false }),
    red: new MeshBasicMaterial({ color: 0xff3a24, vertexColors: true, toneMapped: false }),
    flash: new MeshBasicMaterial({ color: 0xffe0c0, toneMapped: false }),
    wreck: std({ color: 0x2a2624, roughness: 0.9, metalness: 0.4 }),
    ember: new MeshBasicMaterial({ color: 0xff6a20, vertexColors: true, toneMapped: false }),
    glowGuard: new MeshBasicMaterial({ color: 0xff7a2a, transparent: true, opacity: 0.9, blending: AdditiveBlending, depthWrite: false, toneMapped: false }),
    glowTurret: new MeshBasicMaterial({ color: 0xff2a70, transparent: true, opacity: 0.9, blending: AdditiveBlending, depthWrite: false, toneMapped: false }),
    beaconPillar: new MeshBasicMaterial({
      color: 0xff8a30,
      map: lib.texture('pillar'),
      transparent: true,
      opacity: 0.8,
      blending: AdditiveBlending,
      depthWrite: false,
      side: DoubleSide,
      toneMapped: false,
    }),
    beaconCore: new MeshBasicMaterial({ color: 0xffb060, transparent: true, opacity: 0.95, blending: AdditiveBlending, depthWrite: false, toneMapped: false }),
  };
}

/** shared unit geometries for enemy effects */
export interface EnemyShared {
  glowSphere: SphereGeometry;
  ring: TorusGeometry;
  pillar: CylinderGeometry;
  diamond: OctahedronGeometry;
}
export function createEnemyShared(): EnemyShared {
  return {
    glowSphere: new SphereGeometry(1, 12, 8),
    ring: new TorusGeometry(1, 0.05, 6, 24),
    pillar: new CylinderGeometry(0.7, 0.7, 1, 12, 1, true),
    diamond: new OctahedronGeometry(0.5, 0),
  };
}

const BARREL = {
  guard: { r: 0.09, len: 1.5, housing: 0.17 },
  turret: { r: 0.14, len: 2.2, housing: 0.26 },
} as const;

interface Leg {
  hip: Group;
  knee: Group;
  ankle: Group;
  side: number;
}

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const expK = (k: number, dt: number): number => 1 - Math.exp(-k * dt);

/** Wreck geometry (single merged mesh per kind) */
function buildWreck(kind: EnemyKind, mats: EnemyMaterials): Group {
  const p = new PartBuilder();
  if (kind === 'guard') {
    p.box('wreck', 0.1, -1.2, 0.1, 1.0, 0.7, 0.75, { rz: 0.5, ry: 0.4, tint: [1, 1, 1] });
    p.box('wreck', -0.9, -1.4, -0.5, 0.3, 0.3, 1.0, { ry: 0.9, rz: 0.2 });
    p.box('wreck', 0.9, -1.42, 0.6, 0.3, 0.26, 0.9, { ry: -0.4 });
    p.sph('wreck', -0.5, -1.25, 0.9, 0.28, 0.26, 0.28);
    p.box('wreck', 1.3, -1.3, -0.4, 0.6, 0.2, 0.3, { ry: 0.6, rz: -0.2 });
    p.box('ember', 0.15, -0.9, 0.05, 0.3, 0.06, 0.3, { rz: 0.5, ry: 0.4 });
    p.box('ember', -0.9, -1.25, -0.55, 0.14, 0.06, 0.3, { ry: 0.9 });
  } else {
    p.cyl('wreck', 0, -1.35, 0, 0.95, 0.5, { seg: 10 });
    p.cyl('wreck', 0, -0.8, 0, 0.5, 0.7, { seg: 8 });
    p.box('wreck', 0.5, -0.3, 0.2, 1.3, 0.7, 1.1, { rz: 0.35, ry: 0.5 });
    p.cyl('wreck', -0.6, -1.1, -1.0, 0.13, 1.5, { rx: 1.4, ry: 0.5, seg: 8 });
    p.box('ember', 0.4, 0.0, 0.2, 0.5, 0.06, 0.5, { rz: 0.35, ry: 0.5 });
    p.box('ember', 0, -1.08, 0, 0.6, 0.06, 0.06);
  }
  return p.build(`wreck:${kind}`, mats);
}

function buildGuardParts(mats: EnemyMaterials): {
  body: Group;
  head: Group;
  arms: Group[];
  legs: Leg[];
  barrel: Group;
  eye: Mesh;
  eyeMat: MeshBasicMaterial;
  flashTargets: Mesh[];
  detail: Group;
  muzzleGlow: Mesh;
  ring: Mesh;
} {
  const flashTargets: Mesh[] = [];
  const track = (g: Group): Group => {
    g.traverse((o) => {
      const m = o as Mesh;
      if (m.isMesh && m.material === mats.unit) flashTargets.push(m);
    });
    return g;
  };
  const gp = (): PartBuilder => new PartBuilder().alias('body', 'unit', OLIVE).alias('yellow', 'unit', YELLOW).alias('dark', 'unit', DARKC);
  const body = new Group();
  const bp = gp();
  bp.box('dark', 0, -0.5, 0, 0.8, 0.3, 0.6);
  bp.cyl('dark', 0, -0.32, 0, 0.32, 0.2, { seg: 10 });
  bp.box('body', 0, 0.16, 0, 1.0, 0.86, 0.72);
  bp.box('body', 0, 0.2, -0.34, 0.8, 0.6, 0.1, { rx: -0.12 });
  bp.box('hazard', 0, -0.12, -0.38, 0.98, 0.2, 0.06);
  bp.box('dark', 0, 0.28, 0.4, 0.8, 0.6, 0.16);
  bp.box('dark', 0, 0.1, 0.5, 0.5, 0.24, 0.16);
  for (const s of [-1, 1]) {
    bp.box('yellow', s * 0.64, 0.5, 0, 0.28, 0.2, 0.56, { rz: -s * 0.3 });
    bp.sph('dark', s * 0.6, 0.35, 0, 0.16);
    bp.box('yellow', s * 0.3, 0.3, -0.4, 0.26, 0.08, 0.04);
  }
  body.add(track(bp.build('guardBody', mats)));

  // head: sensor dome (turns to scan)
  const head = new Group();
  head.position.set(0, 0.86, -0.02);
  const hp = gp();
  hp.sph('dark', 0, 0.02, 0, 0.34, 0.28, 0.32, { seg: 14 });
  hp.box('yellow', 0, 0.28, 0.02, 0.3, 0.06, 0.4);
  hp.box('dark', 0, 0.0, -0.3, 0.42, 0.12, 0.08);
  hp.cyl('dark', 0.22, 0.46, 0.1, 0.014, 0.4, { seg: 5 });
  hp.sph('red', 0.22, 0.68, 0.1, 0.04);
  head.add(track(hp.build('guardHead', mats)));
  const eyeMat = new MeshBasicMaterial({ color: 0x7fe8ff, toneMapped: false });
  const eye = new Mesh(new SphereGeometry(0.115, 10, 8), eyeMat);
  eye.position.set(0, 0.02, -0.33);
  eye.scale.set(1.3, 0.85, 0.6);
  head.add(eye);
  body.add(head);

  // chest cannon (pivot on the bullet origin)
  const barrel = new Group();
  barrel.position.set(0, MUZZLE_HEIGHT, 0);
  const B = BARREL.guard;
  const cp = gp();
  cp.cyl('dark', 0, 0, -0.5, B.housing, 0.5, { rx: Math.PI / 2, seg: 10 });
  cp.cyl('yellow', 0, 0, -0.45, B.housing + 0.02, 0.1, { rx: Math.PI / 2, seg: 10 });
  cp.cyl('dark', 0, 0, -B.len / 2 - 0.2, B.r, B.len - 0.4, { rx: Math.PI / 2, seg: 8 });
  cp.cyl('dark', 0, 0, -B.len + 0.04, 0.12, 0.16, { rx: Math.PI / 2, seg: 8 });
  barrel.add(track(cp.build('guardCannon', mats)));
  const glow = new Mesh(new SphereGeometry(1, 10, 8), mats.glowGuard);
  glow.position.set(0, 0, -B.len - 0.08);
  glow.visible = false;
  glow.frustumCulled = false;
  barrel.add(glow);
  const ring = new Mesh(new TorusGeometry(1, 0.06, 6, 20), mats.glowGuard);
  ring.position.set(0, 0, -B.len - 0.05);
  ring.visible = false;
  ring.frustumCulled = false;
  barrel.add(ring);
  // NOT a child of `body`: the body bobs / re-levels with the gait, but the barrel pivot must stay exactly on the sim's bullet
  // origin (pos + (0, MUZZLE_HEIGHT, 0)). EnemyModel adds it to the live group next to the body.

  // arms
  const detail = new Group();
  const arms: Group[] = [];
  for (const s of [-1, 1]) {
    const arm = new Group();
    arm.position.set(s * 0.68, 0.42, 0);
    const ap = gp();
    ap.cyl('dark', 0, -0.25, 0, 0.1, 0.5, { seg: 8 });
    ap.box('body', 0, -0.6, -0.1, 0.2, 0.36, 0.24);
    ap.sph('dark', 0, -0.85, -0.12, 0.13);
    ap.box('yellow', s * 0.1, -0.45, -0.1, 0.03, 0.2, 0.2);
    arm.add(track(ap.build('guardArm', mats)));
    detail.add(arm);
    arms.push(arm);
  }
  body.add(detail);

  // legs (digitigrade)
  const legs: Leg[] = [];
  const legRoot = new Group();
  for (const s of [-1, 1]) {
    const hip = new Group();
    hip.position.set(s * 0.32, -0.55, 0);
    const tp = gp();
    tp.sph('dark', 0, 0, 0, 0.17);
    tp.box('body', 0, -0.2, -0.02, 0.24, 0.42, 0.28);
    tp.box('yellow', s * 0.13, -0.2, 0, 0.03, 0.26, 0.18);
    hip.add(track(tp.build('guardThigh', mats)));
    const knee = new Group();
    knee.position.set(0, -0.42, 0);
    const sp = gp();
    sp.sph('dark', 0, 0, 0, 0.13);
    sp.box('dark', 0, -0.22, 0.04, 0.16, 0.42, 0.2, { rx: -0.1 });
    sp.box('body', 0, -0.18, -0.12, 0.2, 0.3, 0.1);
    knee.add(track(sp.build('guardShin', mats)));
    const ankle = new Group();
    ankle.position.set(0, -0.42, 0.02);
    const fp = gp();
    fp.box('dark', 0, -0.07, -0.1, 0.3, 0.12, 0.5);
    fp.box('yellow', 0, -0.05, -0.34, 0.28, 0.08, 0.1);
    ankle.add(track(fp.build('guardFoot', mats)));
    knee.add(ankle);
    hip.add(knee);
    legRoot.add(hip);
    legs.push({ hip, knee, ankle, side: s });
  }
  body.add(legRoot);
  return { body, head, arms, legs, barrel, eye, eyeMat, flashTargets, detail, muzzleGlow: glow, ring };
}

function buildTurretParts(mats: EnemyMaterials, control: boolean): {
  base: Group;
  swivel: Group;
  barrel: Group;
  flashTargets: Mesh[];
  muzzleGlow: Mesh;
  ring: Mesh;
  eyeMat: MeshBasicMaterial;
  detail: Group;
} {
  const flashTargets: Mesh[] = [];
  const paint = 'paint';
  const tp = (): PartBuilder => new PartBuilder().alias('steel', 'unit', STEELC).alias('paint', 'unit', control ? REDC : [0.42, 0.5, 0.62]).alias('dark', 'unit', DARKC);
  const track = (g: Group): Group => {
    g.traverse((o) => {
      const m = o as Mesh;
      if (m.isMesh && m.material === mats.unit) flashTargets.push(m);
    });
    return g;
  };
  const base = new Group();
  const bp = tp();
  bp.cyl('dark', 0, -1.42, 0, 1.05, 0.36, { seg: 14 });
  bp.cyl('hazard', 0, -1.2, 0, 0.98, 0.14, { seg: 14 });
  bp.cyl('dark', 0, -0.75, 0, 0.55, 0.9, { seg: 10 });
  bp.torus('steel', 0, -0.32, 0, 0.62, 0.09, { rx: Math.PI / 2 });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    bp.box('dark', Math.cos(a) * 0.85, -1.0, Math.sin(a) * 0.85, 0.16, 0.7, 0.16, { rz: -Math.cos(a) * 0.35, rx: Math.sin(a) * 0.35 });
  }
  base.add(bp.build('turretBase', mats));

  const swivel = new Group();
  const sp = tp();
  sp.box(paint, 0, 0.12, 0.05, 1.5, 0.86, 1.25);
  sp.box(paint, 0, 0.62, 0.05, 1.1, 0.24, 0.9, { tint: [0.92, 0.92, 0.92] });
  sp.box('dark', 0, 0.12, 0.72, 1.2, 0.6, 0.2);
  sp.box('dark', 0, 0.12, -0.66, 1.0, 0.5, 0.1);
  for (const s of [-1, 1]) {
    sp.box(paint, s * 0.92, 0.2, 0.15, 0.36, 0.6, 0.9, { rz: -s * 0.15 });
    sp.box('hazard', s * 1.08, 0.2, 0.15, 0.04, 0.5, 0.6);
    sp.cyl('dark', s * 0.4, 0.78, 0.3, 0.12, 0.28, { seg: 8 });
  }
  sp.sph('dark', 0, 0.86, -0.15, 0.3, 0.2, 0.3);
  sp.cyl('dark', -0.5, 1.1, 0.35, 0.014, 0.6, { seg: 5 });
  sp.sph('red', -0.5, 1.4, 0.35, 0.045);
  swivel.add(track(sp.build('turretHead', mats)));
  const eyeMat = new MeshBasicMaterial({ color: 0xff4a30, toneMapped: false });
  const eye = new Mesh(new SphereGeometry(0.13, 10, 8), eyeMat);
  eye.position.set(0, 0.86, -0.38);
  eye.scale.set(1.2, 0.8, 0.6);
  swivel.add(eye);

  const barrel = new Group();
  barrel.position.set(0, MUZZLE_HEIGHT, 0);
  const B = BARREL.turret;
  const cp = tp();
  cp.cyl('dark', 0, 0, -0.75, B.housing, 0.7, { rx: Math.PI / 2, seg: 12 });
  cp.cyl(paint, 0, 0, -0.55, B.housing + 0.03, 0.14, { rx: Math.PI / 2, seg: 12 });
  cp.cyl('dark', 0, 0, -1.5, B.r, 1.4, { rx: Math.PI / 2, seg: 10 });
  cp.cyl('steel', 0, 0, -1.25, B.r + 0.05, 0.6, { rx: Math.PI / 2, seg: 10 });
  cp.cyl('dark', 0, 0, -B.len + 0.1, 0.2, 0.26, { rx: Math.PI / 2, seg: 10 });
  cp.torus('hazard', 0, 0, -B.len + 0.18, 0.2, 0.03, {});
  barrel.add(track(cp.build('turretBarrel', mats)));
  const glow = new Mesh(new SphereGeometry(1, 12, 8), mats.glowTurret);
  glow.position.set(0, 0, -B.len - 0.1);
  glow.visible = false;
  glow.frustumCulled = false;
  barrel.add(glow);
  const ring = new Mesh(new TorusGeometry(1, 0.06, 6, 24), mats.glowTurret);
  ring.position.set(0, 0, -B.len - 0.05);
  ring.visible = false;
  ring.frustumCulled = false;
  barrel.add(ring);
  swivel.add(barrel);
  const detail = new Group();
  return { base, swivel, barrel, flashTargets, muzzleGlow: glow, ring, eyeMat, detail };
}


/** single-mesh silhouettes used beyond DETAIL distance (1-2 draw calls per enemy instead of ~12) */
function buildGuardFar(mats: EnemyMaterials): Group {
  const p = new PartBuilder().alias('body', 'unit', OLIVE).alias('yellow', 'unit', YELLOW).alias('dark', 'unit', DARKC);
  p.box('body', 0, 0.16, 0, 1.0, 0.86, 0.72);
  p.box('dark', 0, -0.5, 0, 0.8, 0.3, 0.6);
  p.box('hazard', 0, -0.12, -0.38, 0.98, 0.2, 0.06);
  p.box('yellow', 0.64, 0.5, 0, 0.28, 0.2, 0.56);
  p.box('yellow', -0.64, 0.5, 0, 0.28, 0.2, 0.56);
  p.sph('dark', 0, 0.88, -0.02, 0.34, 0.28, 0.32, { seg: 8 });
  p.sph('red', 0, 0.9, -0.33, 0.13, 0.09, 0.05, { seg: 6 });
  p.cyl('dark', 0, MUZZLE_HEIGHT, -0.75, 0.1, 1.5, { rx: Math.PI / 2, seg: 6 });
  for (const s of [-1, 1]) {
    p.box('dark', s * 0.32, -1.0, -0.05, 0.24, 0.9, 0.3);
    p.box('dark', s * 0.68, 0.0, -0.1, 0.2, 0.8, 0.24);
    p.box('dark', s * 0.32, -1.42, -0.15, 0.3, 0.12, 0.5);
  }
  return p.build('guardFar', mats);
}

function buildTurretFar(mats: EnemyMaterials, control: boolean): { base: Group; head: Group } {
  const alias = (): PartBuilder => new PartBuilder().alias('steel', 'unit', STEELC).alias('paint', 'unit', control ? REDC : [0.42, 0.5, 0.62]).alias('dark', 'unit', DARKC);
  const b = alias();
  b.cyl('dark', 0, -1.42, 0, 1.05, 0.36, { seg: 10 });
  b.cyl('dark', 0, -0.75, 0, 0.55, 0.9, { seg: 8 });
  const h = alias();
  h.box('paint', 0, 0.12, 0.05, 1.5, 0.86, 1.25);
  h.box('paint', 0, 0.62, 0.05, 1.1, 0.24, 0.9);
  h.cyl('dark', 0, MUZZLE_HEIGHT, -1.1, 0.16, 2.2, { rx: Math.PI / 2, seg: 8 });
  h.sph('red', 0, 0.86, -0.4, 0.15, 0.1, 0.06, { seg: 6 });
  return { base: b.build('turretFarBase', mats), head: h.build('turretFarHead', mats) };
}

export class EnemyModel {
  readonly root = new Group();
  readonly kind: EnemyKind;
  readonly id: string;
  readonly isControl: boolean;
  private live = new Group();
  private far = new Group();
  private farHead?: Group;
  private farGlow: Mesh;
  private farRing: Mesh;
  private lodFar = false;
  private wreck: Group;
  private mats: EnemyMaterials;
  // guard
  private gBody?: Group;
  private gHead?: Group;
  private gArms: Group[] = [];
  private gLegs: Leg[] = [];
  // shared handles
  private barrel: Group;
  private swivel?: Group;
  private eyeMat: MeshBasicMaterial;
  private eye?: Mesh;
  private glow: Mesh;
  private ring: Mesh;
  private flashTargets: Mesh[] = [];
  private flashBase = new Map<Mesh, Material>();
  private flashOn = false;
  private detail: Group;
  private beacon?: { group: Group; pillar: Mesh; diamond: Mesh; halo: Mesh };
  // animation
  private phase = 0;
  private amp = 0;
  private barrelPitch = 0;
  private dead = false;
  /** floor-Y below the enemy (cached blob shadow height) */
  floorY = NaN;
  private legLift = 0;

  constructor(e: Pick<EnemyState, 'id' | 'kind' | 'isGateControl'>, mats: EnemyMaterials, shared: EnemyShared) {
    this.kind = e.kind;
    this.id = e.id;
    this.isControl = e.isGateControl;
    this.mats = mats;
    this.root.name = `enemy:${e.id}`;
    this.root.add(this.live);
    if (e.kind === 'guard') {
      const g = buildGuardParts(mats);
      this.gBody = g.body;
      this.gHead = g.head;
      this.gArms = g.arms;
      this.gLegs = g.legs;
      this.barrel = g.barrel;
      this.eye = g.eye;
      this.eyeMat = g.eyeMat;
      this.flashTargets = g.flashTargets;
      this.glow = g.muzzleGlow;
      this.ring = g.ring;
      this.detail = g.detail;
      this.live.add(g.body, g.barrel);
    } else {
      const t = buildTurretParts(mats, e.isGateControl);
      this.swivel = t.swivel;
      this.barrel = t.barrel;
      this.eyeMat = t.eyeMat;
      this.flashTargets = t.flashTargets;
      this.glow = t.muzzleGlow;
      this.ring = t.ring;
      this.detail = t.detail;
      this.live.add(t.base, t.swivel);
    }
    for (const m of this.flashTargets) this.flashBase.set(m, m.material as Material);
    // far LOD (one or two merged meshes) + its own telegraph glow, placed on the barrel tip
    const glowMat = e.kind === 'guard' ? mats.glowGuard : mats.glowTurret;
    this.farGlow = new Mesh(shared.glowSphere, glowMat);
    this.farRing = new Mesh(shared.ring, glowMat);
    for (const m of [this.farGlow, this.farRing]) {
      m.visible = false;
      m.frustumCulled = false;
    }
    if (e.kind === 'guard') {
      const g = buildGuardFar(mats);
      g.add(this.farGlow, this.farRing);
      this.far.add(g);
    } else {
      const t = buildTurretFar(mats, e.isGateControl);
      this.farHead = t.head;
      t.head.add(this.farGlow, this.farRing);
      this.far.add(t.base, t.head);
    }
    this.far.visible = false;
    this.root.add(this.far);
    this.wreck = buildWreck(e.kind, mats);
    this.wreck.visible = false;
    this.root.add(this.wreck);
    if (e.isGateControl) this.beacon = this.buildBeacon(shared);
  }

  private buildBeacon(shared: EnemyShared): { group: Group; pillar: Mesh; diamond: Mesh; halo: Mesh } {
    const group = new Group();
    group.position.y = this.kind === 'turret' ? 2.6 : 2.4;
    const pillar = new Mesh(shared.pillar, this.mats.beaconPillar);
    pillar.scale.set(1, 46, 1);
    pillar.position.y = 23;
    pillar.renderOrder = 5;
    const diamond = new Mesh(shared.diamond, this.mats.beaconCore);
    diamond.scale.set(0.8, 1.4, 0.8);
    diamond.renderOrder = 6;
    const halo = new Mesh(shared.ring, this.mats.beaconCore);
    halo.rotation.x = Math.PI / 2;
    halo.scale.setScalar(1.3);
    halo.renderOrder = 6;
    group.add(pillar, diamond, halo);
    this.root.add(group);
    return { group, pillar, diamond, halo };
  }

  get triangleCount(): number {
    let n = 0;
    this.root.traverse((o) => {
      const m = o as Mesh;
      if (m.isMesh) {
        const ix = m.geometry.getIndex();
        n += ix ? ix.count / 3 : m.geometry.getAttribute('position').count / 3;
      }
    });
    return n;
  }

  /** world position of the barrel tip (where the pre-fire glow sits), from the sim pose + the drawn barrel elevation */
  tipWorld(e: Pick<EnemyState, 'pos' | 'yaw'>, out: V3): V3 {
    const L = (this.kind === 'guard' ? BARREL.guard.len : BARREL.turret.len) + 0.1;
    const cp = Math.cos(this.barrelPitch);
    const sp = Math.sin(this.barrelPitch);
    out.x = e.pos.x - Math.sin(e.yaw) * L * cp;
    out.y = e.pos.y + MUZZLE_HEIGHT + L * sp;
    out.z = e.pos.z - Math.cos(e.yaw) * L * cp;
    return out;
  }

  setDead(dead: boolean): void {
    if (dead === this.dead) return;
    this.dead = dead;
    this.live.visible = !dead && !this.lodFar;
    this.far.visible = !dead && this.lodFar;
    this.wreck.visible = dead;
    if (this.beacon) this.beacon.group.visible = !dead;
    this.glow.visible = false;
    this.ring.visible = false;
    this.farGlow.visible = false;
    this.farRing.visible = false;
    if (dead) this.setFlash(false);
    // wreck sits on the floor: reset yaw-independent pose
  }
  get isDead(): boolean {
    return this.dead;
  }

  private setFlash(on: boolean): void {
    if (on === this.flashOn) return;
    this.flashOn = on;
    for (const m of this.flashTargets) m.material = on ? this.mats.flash : (this.flashBase.get(m) as Material);
  }

  /**
   * @param playerPos target for barrel elevation (only used while the enemy is engaged)
   * @param detailed false for far enemies: skip limb animation
   */
  update(e: EnemyState, playerPos: V3, dt: number, time: number, detailed: boolean): void {
    this.root.position.set(e.pos.x, e.pos.y, e.pos.z);
    if (!e.alive) {
      this.setDead(true);
      this.root.rotation.y = e.yaw;
      return;
    }
    this.setDead(false);
    this.root.rotation.y = this.kind === 'guard' ? e.yaw : 0;
    if (this.swivel) this.swivel.rotation.y = e.yaw;
    if (this.farHead) this.farHead.rotation.y = e.yaw;
    const wantFar = !detailed;
    if (wantFar !== this.lodFar) {
      this.lodFar = wantFar;
      this.live.visible = !wantFar;
      this.far.visible = wantFar;
      this.glow.visible = false;
      this.ring.visible = false;
      this.farGlow.visible = false;
      this.farRing.visible = false;
    }
    this.setFlash(!this.lodFar && e.hitFlash > 0.02);

    // barrel elevation toward the player while engaged
    let targetPitch = 0;
    if (e.alert || e.telegraph > 0) {
      const dx = playerPos.x - e.pos.x;
      const dz = playerPos.z - e.pos.z;
      const dy = playerPos.y - (e.pos.y + MUZZLE_HEIGHT);
      const h = Math.max(1, Math.hypot(dx, dz));
      targetPitch = clamp(Math.atan2(dy, h), -0.7, 0.7);
    }
    this.barrelPitch = lerp(this.barrelPitch, targetPitch, expK(14, dt));
    this.barrel.rotation.x = this.barrelPitch;

    // eye colour: idle cool / alert hot
    if (this.kind === 'guard') this.eyeMat.color.setHex(e.alert ? 0xff4a2a : 0x7fe8ff);
    else this.eyeMat.color.setHex(e.alert ? 0xff2a50 : 0xff9a40);

    // telegraph glow: blink so that even the short 0.15 s warning is unmistakable
    const t = e.telegraph;
    const glow = this.lodFar ? this.farGlow : this.glow;
    const ring = this.lodFar ? this.farRing : this.ring;
    if (t > 0) {
      const blink = Math.sin(time * 70) > -0.35 ? 1 : 0.25;
      // far enemies get a larger glow so the warning stays readable at distance
      const boost = this.lodFar ? 2.2 : 1;
      const s = (this.kind === 'guard' ? 0.22 : 0.34) * (0.5 + 1.1 * t) * blink * boost;
      glow.visible = true;
      glow.scale.setScalar(s);
      ring.visible = true;
      const rs = (this.kind === 'guard' ? 0.5 : 0.75) * (1.6 - 1.0 * t) * boost;
      ring.scale.setScalar(rs);
      if (this.lodFar) {
        const L = (this.kind === 'guard' ? BARREL.guard.len : BARREL.turret.len) + 0.1;
        const cp = Math.cos(this.barrelPitch);
        const sp = Math.sin(this.barrelPitch);
        glow.position.set(0, MUZZLE_HEIGHT + L * sp, -L * cp);
        ring.position.set(0, MUZZLE_HEIGHT + (L - 0.05) * sp, -(L - 0.05) * cp);
      }
    } else {
      glow.visible = false;
      ring.visible = false;
    }

    if (this.beacon) {
      const b = this.beacon;
      b.diamond.rotation.y = time * 1.6;
      b.diamond.position.y = 0.4 + Math.sin(time * 2.4) * 0.15;
      b.halo.rotation.z = time * 1.2;
      b.halo.scale.setScalar(1.2 + 0.15 * Math.sin(time * 3.1));
      this.mats.beaconCore.opacity = 0.75 + 0.2 * Math.sin(time * 5.0);
    }

    if (this.kind === 'guard' && detailed && this.gBody) this.animateGuard(e, dt, time);
    this.detail.visible = detailed;
  }

  private animateGuard(e: EnemyState, dt: number, time: number): void {
    const body = this.gBody as Group;
    const hvx = e.vel.x;
    const hvz = e.vel.z;
    const sp = Math.hypot(hvx, hvz);
    const cy = Math.cos(e.yaw);
    const sy = Math.sin(e.yaw);
    const fwd = { x: -sy, z: -cy };
    const rgt = { x: cy, z: -sy };
    const vf = hvx * fwd.x + hvz * fwd.z;
    const vr = hvx * rgt.x + hvz * rgt.z;
    this.amp = lerp(this.amp, clamp(sp / 4, 0, 1), expK(10, dt));
    this.phase += dt * (sp / 3.0) * Math.PI * 2;
    const A = 0.5 * this.amp;
    const fx = clamp(vf / 8, -1, 1);
    const fz = clamp(vr / 8, -1, 1);
    let lowest = Infinity;
    this.gLegs.forEach((leg, i) => {
      const ph = this.phase + (i === 0 ? 0 : Math.PI);
      const th = 0.32 + A * Math.sin(ph) * (Math.abs(fx) > 0.15 ? Math.sign(fx) : 0.6);
      const kn = 0.62 + 0.8 * this.amp * Math.max(0, Math.cos(ph));
      leg.hip.rotation.x = th;
      leg.hip.rotation.z = leg.side * 0.06 + 0.3 * fz * Math.sin(ph);
      leg.knee.rotation.x = -kn;
      leg.ankle.rotation.x = -(th - kn);
      const ankleY = -(0.42 * Math.cos(th) + 0.42 * Math.cos(th - kn));
      lowest = Math.min(lowest, -0.55 + ankleY - 0.13);
    });
    const comp = Number.isFinite(lowest) ? -1.5 - lowest : 0;
    body.position.y = comp + Math.abs(Math.sin(this.phase)) * 0.04 * this.amp;
    this.gArms.forEach((arm, i) => {
      const ph = this.phase + (i === 0 ? Math.PI : 0);
      arm.rotation.x = -0.35 + Math.sin(ph) * 0.4 * this.amp * Math.abs(fx);
    });
    if (this.gHead) this.gHead.rotation.y = e.alert ? 0 : Math.sin(time * 0.9 + e.pos.x) * 0.5;
    void this.eye;
  }

  dispose(): void {
    this.root.traverse((o) => {
      const m = o as Mesh;
      if (m.isMesh && !m.userData.sharedGeometry) {
        if (m.geometry !== undefined && !(m === this.beacon?.pillar) && !(m === this.beacon?.diamond) && !(m === this.beacon?.halo)) m.geometry.dispose();
      }
    });
    this.eyeMat.dispose();
  }
}

export const guardBulletOrigin = (e: EnemyState): V3 => ({ x: e.pos.x, y: e.pos.y + MUZZLE_HEIGHT, z: e.pos.z });
export { ENEMIES };
