/**
 * Player mech "Armored Koala": koala-headed heavy armor. Built from primitives only (merged per material slot).
 *
 * Local frame (root): origin = player.pos (hit-box center), +Y up, forward = -Z, right = +X, feet at y = -1.5.
 * The right arm is a 2-bone IK chain from the shoulder to a hand point chosen so that the weapon's bore line passes
 * through the sim's muzzle point and points along the real firing direction (見た目と実弾の一致, SPEC §4.2).
 */
import {
  AdditiveBlending,
  Color,
  ConeGeometry,
  DoubleSide,
  Group,
  Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  Vector3,
} from 'three';
import { LEGS_PARTS, PLAYER } from '../config';
import type { LegsId, WeaponId } from '../config';
import { forwardFromYaw, rightFromYaw } from '../sim/math';
import type { V2, V3 } from '../sim/math';
import { GeoBuilder, type RGB } from './geo';
import { PartBuilder } from './parts';
import { MaterialLibrary } from './textures';

// ---------------------------------------------------------------------------------------------------------------------
// materials
// ---------------------------------------------------------------------------------------------------------------------
export interface MechMaterials {
  [slot: string]: Material;
  /** all armour: one PBR material + vertex colours (fewer draw calls) */
  unit: MeshStandardMaterial;
  black: MeshStandardMaterial;
  lens: MeshBasicMaterial;
  red: MeshBasicMaterial;
  nozzle: MeshStandardMaterial;
}

export function createMechMaterials(lib: MaterialLibrary): MechMaterials {
  const std = (o: ConstructorParameters<typeof MeshStandardMaterial>[0]): MeshStandardMaterial => new MeshStandardMaterial({ vertexColors: true, ...o });
  return {
    unit: std({ map: lib.texture('armorLight'), roughness: 0.45, metalness: 0.55 }),
    black: std({ color: 0x0c0c0e, roughness: 0.22, metalness: 0.35 }),
    lens: new MeshBasicMaterial({ color: 0x66f2ff, vertexColors: true, toneMapped: false }),
    red: new MeshBasicMaterial({ color: 0xff3a24, vertexColors: true, toneMapped: false }),
    nozzle: std({ color: 0x2a2a2e, roughness: 0.5, metalness: 0.8, emissive: new Color(0xff6a20), emissiveIntensity: 0.25 }),
  };
}

/** PartBuilder whose armour slots are all routed into the single `unit` material with tints */
const mp = (): PartBuilder =>
  new PartBuilder()
    // vertex colours are LINEAR and multiply the (sRGB->linear) light-gray armor texture, so the tints below are
    // target_linear / texture_linear (armor2 = dark navy, accent = orange, dark = gunmetal, ear = cream pink)
    .alias('armor', 'unit', [1, 1, 1])
    .alias('armor2', 'unit', [0.24, 0.26, 0.32])
    .alias('accent', 'unit', [2.6, 0.62, 0.04])
    .alias('dark', 'unit', [0.2, 0.21, 0.23])
    .alias('ear', 'unit', [2.5, 1.6, 1.25]);

const T = (v: number): RGB => [v, v, v];

// ---------------------------------------------------------------------------------------------------------------------
// dimensions
// ---------------------------------------------------------------------------------------------------------------------
const TORSO_PIVOT_Y = -0.1;
const HEAD_LOCAL_Y = 1.22;
const SHOULDER = { x: 0.98, y: 0.58, z: 0.02 };
const ARM_L1 = 0.52;
const ARM_L2 = 0.55;
const BIPED_HIP = { x: 0.44, y: -0.3, z: 0.02 };
const BIPED_L1 = 0.52;
const BIPED_L2 = 0.52;
const QUAD_HIP: [number, number, number][] = [
  [0.74, -0.26, -0.5],
  [-0.74, -0.26, -0.5],
  [0.74, -0.26, 0.5],
  [-0.74, -0.26, 0.5],
];
const QUAD_L1 = 0.6;
const QUAD_L2 = 0.68;
const QUAD_ROLL = 0.5;
export const WEAPON_LENGTH: Record<WeaponId, number> = { machinegun: 1.05, beam: 1.2, missile: 0.95 };

// ---------------------------------------------------------------------------------------------------------------------
// part builders
// ---------------------------------------------------------------------------------------------------------------------
function buildTorso(mats: MechMaterials): Group {
  const p = mp();
  // chest
  p.box('armor', 0, 0.4, 0, 1.3, 0.8, 0.86, { tint: T(1.0) });
  // V-shaped chest plates with a centre emblem
  for (const s of [-1, 1]) {
    p.box('armor2', s * 0.31, 0.52, -0.47, 0.6, 0.56, 0.12, { rx: -0.1, ry: s * 0.3 });
    p.box('armor', s * 0.34, 0.86, -0.34, 0.5, 0.12, 0.26, { rz: -s * 0.12 });
  }
  p.box('accent', 0, 0.52, -0.55, 0.26, 0.26, 0.05, { rz: Math.PI / 4 });
  p.sph('lens', 0, 0.52, -0.585, 0.055, 0.055, 0.03, { seg: 8 });
  p.box('armor', 0, 0.12, -0.4, 0.9, 0.24, 0.14, { tint: T(1.05) });
  p.box('accent', 0, 0.26, -0.415, 1.02, 0.06, 0.05);
  for (let i = 0; i < 3; i++) p.box('dark', 0, 0.16 - i * 0.06, -0.485, 0.5, 0.03, 0.03);
  for (const s of [-1, 1]) {
    p.box('accent', s * 0.67, 0.42, 0.0, 0.05, 0.6, 0.66);
    p.box('armor2', s * 0.4, 0.83, -0.05, 0.42, 0.1, 0.5, { rz: -s * 0.15 });
  }
  p.cyl('dark', 0, 0.02, 0, 0.42, 0.2, { seg: 16 });
  p.cyl('dark', 0, 0.9, 0, 0.22, 0.24, { seg: 12 });
  p.torus('armor2', 0, 0.82, 0, 0.27, 0.05, { rx: Math.PI / 2 });
  // shoulders
  for (const s of [-1, 1]) {
    p.sph('armor', s * SHOULDER.x, SHOULDER.y + 0.12, SHOULDER.z, 0.36, 0.3, 0.38);
    p.box('accent', s * (SHOULDER.x + 0.08), SHOULDER.y + 0.34, SHOULDER.z - 0.02, 0.34, 0.06, 0.5, { rz: -s * 0.25 });
    p.cyl('dark', s * 0.8, SHOULDER.y, SHOULDER.z, 0.2, 0.28, { rz: Math.PI / 2 });
  }
  // back pack
  p.box('armor2', 0, 0.5, 0.62, 1.0, 0.74, 0.38);
  p.box('dark', 0, 0.5, 0.83, 0.78, 0.5, 0.06);
  for (const s of [-1, 1]) {
    p.cyl('armor', s * 0.42, 1.02, 0.6, 0.13, 0.5, { rx: 0.5, seg: 10 });
    p.cone('accent', s * 0.42, 1.28, 0.7, 0.11, 0.18, { rx: 0.5, seg: 10 });
    p.box('dark', s * 0.34, 0.14, 0.78, 0.3, 0.16, 0.24);
  }
  p.cyl('dark', 0.55, 1.05, 0.7, 0.018, 0.7, { rz: -0.15, seg: 6 });
  p.sph('red', 0.6, 1.4, 0.7, 0.045);
  return p.build('torso', mats);
}

function buildHead(mats: MechMaterials): Group {
  const p = mp();
  p.sph('armor', 0, 0, 0, 0.42, 0.36, 0.4, { seg: 20 });
  p.sph('armor2', 0, 0.16, 0.04, 0.37, 0.2, 0.36, { seg: 16 });
  p.sph('armor', 0, -0.1, -0.3, 0.26, 0.22, 0.16);
  // black nose
  p.sph('black', 0, -0.03, -0.44, 0.19, 0.14, 0.12, { seg: 16 });
  p.sph('lens', 0.06, 0.0, -0.53, 0.028, 0.02, 0.012, { seg: 6, tint: [1, 1, 1] });
  // ears: big round discs with cream inner ear and dark rim
  for (const s of [-1, 1]) {
    const ry = -s * 0.6;
    const c = { x: s * 0.56, y: 0.26, z: 0.05 };
    const n = { x: -Math.sin(ry) * 1 * 1, y: 0, z: -Math.cos(ry) };
    p.cyl('armor', c.x, c.y, c.z, 0.34, 0.12, { rx: -Math.PI / 2, ry, seg: 24 });
    p.torus('dark', c.x + n.x * 0.05, c.y, c.z + n.z * 0.05, 0.33, 0.035, { ry: ry });
    p.cyl('ear', c.x + n.x * 0.075, c.y, c.z + n.z * 0.075, 0.245, 0.06, { rx: -Math.PI / 2, ry, seg: 24 });
    p.cyl('dark', c.x - n.x * 0.14, c.y - 0.02, c.z - n.z * 0.14 + 0.02, 0.09, 0.1, { rx: Math.PI / 2, ry, seg: 8 });
    // eyes
    p.sph('dark', s * 0.19, 0.11, -0.36, 0.09);
    p.sph('lens', s * 0.19, 0.11, -0.435, 0.048, 0.048, 0.03, { seg: 8 });
    p.box('accent', s * 0.19, 0.215, -0.36, 0.27, 0.05, 0.14, { rz: s * 0.28 });
    p.box('armor2', s * 0.34, -0.12, -0.2, 0.15, 0.3, 0.3, { ry: -s * 0.35 });
  }
  p.cyl('lens', 0, 0.3, -0.27, 0.04, 0.05, { rx: Math.PI / 2, seg: 8 });
  p.box('dark', 0, -0.25, -0.32, 0.22, 0.04, 0.05);
  p.cyl('dark', 0.29, 0.44, 0.14, 0.018, 0.42, { rz: -0.2, seg: 6 });
  p.sph('red', 0.33, 0.65, 0.14, 0.04);
  return p.build('head', mats);
}

function buildArmSegments(mats: MechMaterials, left: boolean): { upper: Group; fore: Group } {
  const up = mp();
  up.cyl('armor2', 0, -ARM_L1 / 2, 0, 0.13, ARM_L1 - 0.06, { seg: 10 });
  up.box('armor', 0.13, -0.24, 0, 0.09, 0.36, 0.26);
  up.sph('dark', 0, 0, 0, 0.16);
  up.sph('dark', 0, -ARM_L1, 0, 0.15);
  const fo = mp();
  fo.box('armor', 0, -0.28, 0, 0.26, 0.5, 0.28);
  fo.box('accent', 0.14, -0.26, 0, 0.05, 0.34, 0.24);
  fo.cyl('dark', 0, -ARM_L2 + 0.04, 0, 0.11, 0.22, { rz: Math.PI / 2 });
  if (left) fo.cyl('armor2', 0.2, -0.26, 0, 0.27, 0.06, { rz: Math.PI / 2, seg: 18 });
  if (left) fo.torus('accent', 0.235, -0.26, 0, 0.26, 0.022, { ry: Math.PI / 2 });
  return { upper: up.build('armUpper', mats), fore: fo.build('armFore', mats) };
}

function buildWeapon(kind: WeaponId, mats: MechMaterials): Group {
  const p = mp();
  const L = WEAPON_LENGTH[kind];
  // hand + grip (below the bore line)
  p.sph('dark', 0, -0.06, 0, 0.11);
  p.box('dark', 0, -0.18, -0.03, 0.1, 0.26, 0.12, { rx: 0.3 });
  if (kind === 'machinegun') {
    p.box('armor2', 0, 0, -0.3, 0.2, 0.22, 0.62);
    p.box('dark', 0, 0.13, -0.35, 0.12, 0.06, 0.5);
    p.box('accent', 0, 0.0, -0.2, 0.21, 0.06, 0.2);
    p.cyl('armor', 0, 0, -0.62, 0.078, 0.3, { rx: Math.PI / 2 });
    p.cyl('dark', 0, 0, -0.76, 0.045, 0.3, { rx: Math.PI / 2, seg: 8 });
    p.cyl('dark', 0, 0, -L + 0.06, 0.07, 0.12, { rx: Math.PI / 2, seg: 10 });
    p.cyl('armor2', 0, -0.22, -0.3, 0.17, 0.2, { rz: Math.PI / 2, seg: 14 });
    p.box('dark', 0, 0.18, -0.5, 0.06, 0.06, 0.14);
    p.sph('lens', 0, 0.19, -0.58, 0.022);
  } else if (kind === 'beam') {
    p.box('armor2', 0, 0, -0.14, 0.2, 0.24, 0.32);
    p.cyl('armor', 0, 0, -0.55, 0.085, 0.8, { rx: Math.PI / 2, seg: 12 });
    p.cyl('accent', 0, 0.14, -0.5, 0.06, 0.5, { rx: Math.PI / 2, seg: 8 });
    for (const s of [-1, 1]) {
      p.box('dark', s * 0.085, 0, -1.02, 0.045, 0.1, 0.36);
      p.box('dark', s * 0.11, 0, -0.35 - 0.1 * s * 0, 0.03, 0.16, 0.3);
    }
    p.cyl('lens', 0, 0, -L + 0.06, 0.038, 0.24, { rx: Math.PI / 2, seg: 8 });
    p.box('lens', 0, 0.185, -0.5, 0.03, 0.02, 0.4);
    p.torus('dark', 0, 0, -0.95, 0.1, 0.018, {});
  } else {
    p.cyl('armor2', 0, 0, -0.5, 0.17, 0.85, { rx: Math.PI / 2, seg: 14 });
    p.torus('dark', 0, 0, -0.9, 0.175, 0.022, {});
    p.torus('accent', 0, 0, -0.55, 0.178, 0.02, {});
    p.cone('accent', 0, 0, -0.86, 0.12, 0.18, { rx: -Math.PI / 2, seg: 10 });
    p.cyl('dark', 0, 0, -0.06, 0.2, 0.12, { rx: Math.PI / 2, seg: 12 });
    p.box('dark', 0.0, 0.2, -0.4, 0.07, 0.07, 0.2);
    p.sph('lens', 0, 0.21, -0.5, 0.024);
  }
  const g = p.build(`weapon:${kind}`, mats);
  g.userData.kind = kind;
  return g;
}

interface LegRig {
  hip: Group;
  knee: Group;
  ankle: Group;
  sole: Object3D;
  side: number;
  phase: number;
  front: boolean;
  isQuad: boolean;
}

function buildBipedLegs(mats: MechMaterials): { group: Group; legs: LegRig[] } {
  const group = new Group();
  group.name = 'legsBiped';
  const legs: LegRig[] = [];
  const pel = mp();
  pel.box('armor2', 0, -0.28, 0.02, 0.92, 0.32, 0.66);
  pel.box('armor', 0, -0.3, -0.38, 0.5, 0.3, 0.1, { rx: 0.2 });
  pel.box('armor2', 0, -0.28, 0.4, 0.6, 0.26, 0.1);
  pel.cyl('dark', 0, -0.32, 0.02, 0.3, 0.2);
  group.add(pel.build('pelvis', mats));
  for (const s of [1, -1]) {
    const hip = new Group();
    hip.position.set(s * BIPED_HIP.x, BIPED_HIP.y, BIPED_HIP.z);
    const th = mp();
    th.sph('dark', 0, 0, 0, 0.19);
    th.box('armor2', 0, -0.26, 0, 0.3, 0.5, 0.34);
    th.box('armor', 0, -0.22, -0.2, 0.3, 0.4, 0.08);
    th.box('accent', s * 0.16, -0.24, 0, 0.03, 0.3, 0.2);
    th.cyl('dark', 0, -BIPED_L1, 0, 0.17, 0.36, { rz: Math.PI / 2 });
    th.sph('armor', 0, -BIPED_L1 + 0.02, -0.17, 0.13);
    hip.add(th.build('thigh', mats));
    const knee = new Group();
    knee.position.set(0, -BIPED_L1, 0);
    const sh = mp();
    sh.box('armor', 0, -0.3, 0.04, 0.32, 0.56, 0.36);
    sh.box('armor2', 0, -0.28, -0.2, 0.26, 0.5, 0.07, { rx: 0.05 });
    sh.sph('armor2', 0, -0.24, 0.2, 0.15, 0.24, 0.14);
    sh.cyl('dark', 0, -BIPED_L2, 0, 0.13, 0.3, { rz: Math.PI / 2 });
    knee.add(sh.build('shin', mats));
    const ankle = new Group();
    ankle.position.set(0, -BIPED_L2, 0);
    const ft = mp();
    ft.box('armor2', 0, -0.09, -0.1, 0.4, 0.14, 0.62);
    ft.box('accent', 0, -0.06, -0.36, 0.38, 0.1, 0.14);
    ft.box('dark', 0, -0.08, 0.2, 0.3, 0.12, 0.14);
    ankle.add(ft.build('foot', mats));
    const sole = new Object3D();
    sole.position.set(0, -0.16, -0.1);
    ankle.add(sole);
    knee.add(ankle);
    hip.add(knee);
    group.add(hip);
    legs.push({ hip, knee, ankle, sole, side: s, phase: s > 0 ? 0 : Math.PI, front: true, isQuad: false });
  }
  return { group, legs };
}

function buildQuadLegs(mats: MechMaterials): { group: Group; legs: LegRig[] } {
  const group = new Group();
  group.name = 'legsQuad';
  const legs: LegRig[] = [];
  const pel = mp();
  pel.box('armor2', 0, -0.3, 0.0, 1.2, 0.34, 1.34);
  pel.box('armor', 0, -0.42, -0.62, 0.7, 0.2, 0.12, { rx: 0.25 });
  pel.box('armor', 0, -0.4, 0.66, 0.7, 0.2, 0.12);
  pel.box('accent', 0, -0.12, 0.0, 0.5, 0.06, 1.0);
  pel.cyl('dark', 0, -0.36, 0, 0.42, 0.22, { seg: 14 });
  group.add(pel.build('pelvisQuad', mats));
  QUAD_HIP.forEach(([x, y, z], i) => {
    const s = x > 0 ? 1 : -1;
    const front = z < 0;
    const hip = new Group();
    hip.position.set(x, y, z);
    const th = mp();
    th.sph('dark', 0, 0, 0, 0.22);
    th.box('armor2', s * 0.02, -0.3, 0, 0.32, 0.6, 0.32);
    th.box('armor', s * 0.2, -0.28, 0, 0.06, 0.46, 0.26);
    th.sph('dark', 0, -QUAD_L1, 0, 0.19);
    hip.add(th.build('thighQ', mats));
    const knee = new Group();
    knee.position.set(0, -QUAD_L1, 0);
    const sh = mp();
    sh.box('armor', 0, -0.36, 0, 0.26, 0.66, 0.3, { tint: T(0.95) });
    sh.box('accent', s * 0.15, -0.3, 0, 0.03, 0.4, 0.2);
    sh.sph('armor2', 0, -0.14, 0.0, 0.2, 0.16, 0.2);
    sh.sph('dark', 0, -QUAD_L2, 0, 0.14);
    knee.add(sh.build('shinQ', mats));
    const ankle = new Group();
    ankle.position.set(0, -QUAD_L2, 0);
    const ft = mp();
    ft.cyl('armor2', 0, -0.06, 0, 0.23, 0.1, { seg: 12 });
    for (let k = -1; k <= 1; k++) ft.box('dark', k * 0.13, -0.08, front ? -0.22 : -0.2, 0.09, 0.09, 0.2, { ry: k * 0.25 });
    ankle.add(ft.build('footQ', mats));
    const sole = new Object3D();
    sole.position.set(0, -0.11, 0);
    ankle.add(sole);
    knee.add(ankle);
    hip.add(knee);
    group.add(hip);
    // diagonal gait: front-right & rear-left together
    legs.push({ hip, knee, ankle, sole, side: s, phase: (s > 0) === front ? 0 : Math.PI, front, isQuad: true });
    void i;
  });
  return { group, legs };
}

function buildGhostGeometry(): GeoBuilder {
  const g = new GeoBuilder();
  g.addBoxC(0, 0.3, 0, 1.3, 0.8, 0.86);
  g.addSphere({ x: 0, y: 1.12, z: 0 }, 0.42, 0.36, 0.4, [1, 1, 1], 10);
  g.addBoxC(0, -0.3, 0, 0.9, 0.34, 0.66);
  for (const s of [-1, 1]) {
    g.addBoxC(s * 1.05, 1.15, 0.05, 0.2, 0.6, 0.6);
    g.addBoxC(s * 0.44, -0.9, 0, 0.32, 1.2, 0.4);
    g.addBoxC(s * 0.98, 0.3, 0, 0.32, 0.9, 0.34);
  }
  g.addBoxC(1.05, 0.7, -0.6, 0.2, 0.22, 1.1);
  return g;
}

// ---------------------------------------------------------------------------------------------------------------------
// runtime
// ---------------------------------------------------------------------------------------------------------------------
export interface MechFrame {
  dt: number;
  time: number;
  pos: V3;
  vel: V3;
  /** aim (camera) yaw/pitch - the body turns toward yaw, the head follows pitch a little */
  yaw: number;
  pitch: number;
  grounded: boolean;
  vertical: 'grounded' | 'rising' | 'flying' | 'falling';
  horizontal: 'walk' | 'glide' | 'quickboost';
  thrusting: boolean;
  qbRemaining: number;
  qbDir: V2;
  weapon: WeaponId;
  /** world muzzle point (sim) and the real firing direction (unit) */
  muzzle: V3;
  aimDir: V3;
  legs: LegsId;
  /** hangar: when set, fixes the body yaw (no smoothing) and simulates this walking speed [m/s] */
  fixedYaw?: number;
  walkSpeed?: number;
}

const _v1 = new Vector3();
const _v2 = new Vector3();
const _v3 = new Vector3();
const _v4 = new Vector3();
const _q = new Quaternion();
const _m = new Matrix4();
const UP = new Vector3(0, 1, 0);

const angDiff = (a: number, b: number): number => {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
};
const expK = (k: number, dt: number): number => 1 - Math.exp(-k * dt);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

function flameMesh(color: number, opacity: number): Mesh {
  const g = new ConeGeometry(0.16, 1, 12, 1, true);
  g.rotateX(Math.PI);
  g.translate(0, -0.5, 0);
  const m = new MeshBasicMaterial({ color, transparent: true, opacity, blending: AdditiveBlending, depthWrite: false, side: DoubleSide, toneMapped: false });
  const mesh = new Mesh(g, m);
  mesh.frustumCulled = false;
  return mesh;
}

export class MechModel {
  readonly root = new Group();
  readonly body = new Group();
  readonly torso = new Group();
  readonly head = new Group();
  readonly mats: MechMaterials;
  private rightUpper: Group;
  private rightFore: Group;
  private leftUpper: Group;
  private leftFore: Group;
  private handRoot = new Group();
  private weapons = new Map<WeaponId, Group>();
  private biped: { group: Group; legs: LegRig[] };
  private quad: { group: Group; legs: LegRig[] };
  private gimbals: { g: Group; outer: Mesh; core: Mesh; tip: Object3D }[] = [];
  private ghostGeo: GeoBuilder;
  readonly triangleCount: number;

  // animated state
  private visYaw = 0;
  private first = true;
  private phase = 0;
  private leanPitch = 0;
  private leanRoll = 0;
  private wAir = 0;
  private wSkate = 0;
  private ampWalk = 0;
  private groundBlend = 1;
  private landDip = 0;
  private kick = 0;
  private flightLevel = 0;
  private qbLevel = 0;
  private flameDir = new Vector3(0, -1, 0);
  private hitFlash = 0;
  private legsId: LegsId = 'biped';
  private curWeapon: WeaponId = 'machinegun';
  /** exposed for effects */
  readonly nozzleWorld: Vector3[] = [new Vector3(), new Vector3()];
  flameWorldDir = new Vector3(0, -1, 0);
  flameStrength = 0;
  qbActive = false;
  speed = 0;
  footWorld: Vector3[] = [new Vector3(), new Vector3()];

  constructor(lib: MaterialLibrary, mats?: MechMaterials) {
    this.mats = mats ?? createMechMaterials(lib);
    const m = this.mats;
    this.root.name = 'mech';
    this.root.add(this.body);
    this.torso.position.set(0, TORSO_PIVOT_Y, 0);
    this.body.add(this.torso);
    this.torso.add(buildTorso(m));
    this.head.position.set(0, HEAD_LOCAL_Y + 0.06, -0.02);
    this.head.scale.setScalar(1.14);
    this.head.add(buildHead(m));
    this.torso.add(this.head);

    this.biped = buildBipedLegs(m);
    this.quad = buildQuadLegs(m);
    this.body.add(this.biped.group, this.quad.group);
    this.quad.group.visible = false;

    const R = buildArmSegments(m, false);
    const Lm = buildArmSegments(m, true);
    this.rightUpper = R.upper;
    this.rightFore = R.fore;
    this.leftUpper = Lm.upper;
    this.leftFore = Lm.fore;
    this.root.add(this.rightUpper, this.rightFore, this.leftUpper, this.leftFore, this.handRoot);
    for (const k of ['machinegun', 'beam', 'missile'] as WeaponId[]) {
      const w = buildWeapon(k, m);
      w.visible = k === 'machinegun';
      this.weapons.set(k, w);
      this.handRoot.add(w);
    }

    // back-pack thruster gimbals with flames
    for (const s of [-1, 1]) {
      const g = new Group();
      g.position.set(s * 0.34, 0.24, 0.8);
      const p = mp();
      p.cyl('dark', 0, -0.1, 0, 0.11, 0.18, { seg: 10 });
      p.cyl('dark', 0, -0.26, 0, 0.11, 0.16, { r2: 0.2, seg: 10 });
      p.torus('nozzle', 0, -0.35, 0, 0.17, 0.022, { rx: Math.PI / 2 });
      g.add(p.build('nozzle', m));
      const outer = flameMesh(0xff8a30, 0.38);
      const core = flameMesh(0xffe8b0, 0.7);
      outer.position.y = -0.34;
      core.position.y = -0.34;
      g.add(outer, core);
      const tip = new Object3D();
      tip.position.set(0, -0.36, 0);
      g.add(tip);
      this.torso.add(g);
      this.gimbals.push({ g, outer, core, tip });
    }

    this.ghostGeo = buildGhostGeometry();
    this.triangleCount = 0;
    this.root.traverse((o) => {
      const mesh = o as Mesh;
      if (mesh.isMesh) {
        const idx = mesh.geometry.getIndex();
        (this as { triangleCount: number }).triangleCount += idx ? idx.count / 3 : 0;
      }
    });
  }

  ghostSilhouette(): GeoBuilder {
    return this.ghostGeo;
  }

  /** world-space barrel tip and bore direction of the current weapon (verification helper) */
  weaponTipWorld(): { tip: Vector3; dir: Vector3 } {
    this.root.updateMatrixWorld(true);
    const tip = new Vector3(0, 0, -WEAPON_LENGTH[this.curWeapon]).applyMatrix4(this.handRoot.matrixWorld);
    const dir = new Vector3(0, 0, -1).transformDirection(this.handRoot.matrixWorld);
    return { tip, dir };
  }

  setLegs(legs: LegsId): void {
    if (legs === this.legsId && this.first === false) return;
    this.legsId = legs;
    this.biped.group.visible = legs === 'biped';
    this.quad.group.visible = legs === 'quadruped';
  }
  get legs(): LegsId {
    return this.legsId;
  }
  setWeapon(w: WeaponId): void {
    this.curWeapon = w;
    for (const [k, g] of this.weapons) g.visible = k === w;
  }
  get bodyYaw(): number {
    return this.visYaw;
  }

  onLand(impactSpeed: number): void {
    this.landDip = Math.max(this.landDip, clamp(impactSpeed / 40, 0.05, 0.32));
  }
  onJump(): void {
    this.landDip = Math.max(this.landDip, 0.05);
  }
  onFire(w: WeaponId): void {
    this.kick = w === 'machinegun' ? 0.04 : 0.1;
  }
  onHit(): void {
    this.hitFlash = 0.12;
  }

  private activeLegs(): LegRig[] {
    return this.legsId === 'biped' ? this.biped.legs : this.quad.legs;
  }

  /** two-bone IK. Places the two segment groups (segment local axis = -Y, local +X = outward hint). */
  private solveArm(upper: Group, fore: Group, S: Vector3, H: Vector3, pole: Vector3, outward: Vector3): void {
    const l1 = ARM_L1;
    const l2 = ARM_L2;
    const dirSH = _v1.copy(H).sub(S);
    let d = dirSH.length();
    if (d < 1e-4) {
      dirSH.set(0, -1, 0);
      d = 0.05;
    } else dirSH.multiplyScalar(1 / d);
    const maxReach = (l1 + l2) * 0.999;
    let k = 1;
    if (d > maxReach) k = d / maxReach; // stretch the bones a little instead of detaching the hand
    const a1 = l1 * k;
    const a2 = l2 * k;
    const dd = clamp(d, Math.abs(a1 - a2) + 0.02, a1 + a2 - 0.001);
    const a = (a1 * a1 - a2 * a2 + dd * dd) / (2 * dd);
    const h = Math.sqrt(Math.max(0, a1 * a1 - a * a));
    const pv = _v2.copy(pole).addScaledVector(dirSH, -pole.dot(dirSH));
    if (pv.lengthSq() < 1e-6) pv.set(outward.x, -0.3, 0.2);
    pv.normalize();
    const E = _v3.copy(S).addScaledVector(dirSH, a).addScaledVector(pv, h);
    // upper: S -> E
    this.orientSegment(upper, S, E, a1, outward);
    // fore: E -> H
    this.orientSegment(fore, E, H, a2, outward);
  }

  private orientSegment(g: Group, from: Vector3, to: Vector3, baseLen: number, outward: Vector3): void {
    const dir = _v4.copy(to).sub(from);
    const len = dir.length();
    if (len < 1e-5) return;
    dir.multiplyScalar(1 / len);
    const x = new Vector3().copy(outward).addScaledVector(dir, -outward.dot(dir));
    if (x.lengthSq() < 1e-6) x.set(1, 0, 0);
    x.normalize();
    const y = new Vector3().copy(dir).multiplyScalar(-1);
    const z = new Vector3().crossVectors(x, y);
    _m.makeBasis(x, y, z);
    g.quaternion.setFromRotationMatrix(_m);
    g.position.copy(from);
    // segment geometry length is the nominal bone length (ARM_L1 / ARM_L2)
    const nominal = g === this.rightUpper || g === this.leftUpper ? ARM_L1 : ARM_L2;
    g.scale.set(1, len / nominal, 1);
    void baseLen;
  }

  update(f: MechFrame): void {
    const dt = Math.min(Math.max(f.dt, 0), 0.1);
    const root = this.root;
    root.position.set(f.pos.x, f.pos.y, f.pos.z);
    // ---- body yaw
    if (f.fixedYaw !== undefined) {
      this.visYaw = f.fixedYaw;
    } else if (this.first) {
      this.visYaw = f.yaw;
    } else {
      this.visYaw += angDiff(this.visYaw, f.yaw) * expK(22, dt);
    }
    this.first = false;
    root.rotation.y = this.visYaw;
    this.setLegs(f.legs);
    this.setWeapon(f.weapon);

    // ---- velocity in body frame
    const fw = forwardFromYaw(this.visYaw);
    const rt = rightFromYaw(this.visYaw);
    const hvx = f.walkSpeed !== undefined ? fw.x * f.walkSpeed : f.vel.x;
    const hvz = f.walkSpeed !== undefined ? fw.z * f.walkSpeed : f.vel.z;
    const vf = hvx * fw.x + hvz * fw.z;
    const vr = hvx * rt.x + hvz * rt.z;
    const sp = Math.hypot(hvx, hvz);
    this.speed = sp;
    const airborne = !f.grounded && f.walkSpeed === undefined;
    const qbActive = f.qbRemaining > 0 || f.horizontal === 'quickboost';
    this.qbActive = qbActive;
    const fast = sp > 13;

    // ---- pose targets
    const glideish = f.horizontal !== 'walk' || sp > 12.5;
    const targetPitch = -clamp(vf / 22, -1, 1) * 0.3 - (qbActive ? 0.22 * Math.sign(vf || 1) : 0) + (airborne && f.vertical === 'falling' ? 0.05 : 0);
    const targetRoll = -clamp(vr / 22, -1, 1) * 0.28;
    this.leanPitch = lerp(this.leanPitch, targetPitch, expK(qbActive ? 26 : 12, dt));
    this.leanRoll = lerp(this.leanRoll, targetRoll, expK(12, dt));
    this.wAir = lerp(this.wAir, airborne ? 1 : 0, expK(12, dt));
    this.wSkate = lerp(this.wSkate, !airborne && glideish && fast ? 1 : 0, expK(10, dt));
    this.ampWalk = lerp(this.ampWalk, clamp(sp / 6, 0, 1), expK(10, dt));
    this.groundBlend = lerp(this.groundBlend, airborne ? 0 : 1, expK(14, dt));
    this.landDip = Math.max(0, this.landDip - dt * 1.2);
    this.kick = Math.max(0, this.kick - dt * 0.9);
    this.hitFlash = Math.max(0, this.hitFlash - dt);

    const cycles = clamp(sp / 2.6, 0, 4.2);
    if (this.wSkate < 0.5) this.phase += dt * cycles * Math.PI * 2;

    this.torso.rotation.set(this.leanPitch, 0, this.leanRoll);
    this.head.rotation.x = clamp(f.pitch * 0.55, -0.45, 0.4) - this.leanPitch * 0.7;
    this.head.rotation.z = -this.leanRoll * 0.5;

    // ---- legs
    const legs = this.activeLegs();
    const A = 0.62 * this.ampWalk;
    legs.forEach((leg, idx) => {
      const ph = this.phase + leg.phase;
      const walkT = A * Math.sin(ph);
      const walkK = 0.32 + 0.9 * this.ampWalk * Math.max(0, Math.cos(ph));
      const alt = idx % 2 === 0;
      const skT = leg.isQuad ? (leg.front ? 0.42 : -0.34) : alt ? 0.42 : -0.34;
      const skK = alt ? 0.38 : 0.62;
      let airT: number;
      let airK: number;
      if (f.vertical === 'flying') {
        airT = -0.18;
        airK = 0.25;
      } else if (f.vertical === 'falling') {
        airT = 0.22 * (alt ? 1 : 0.5);
        airK = 0.2;
      } else {
        airT = (alt ? -0.4 : 0.1) * (leg.isQuad ? 0.7 : 1);
        airK = alt ? 0.85 : 0.55;
      }
      let th = lerp(walkT, skT, this.wSkate);
      let kn = lerp(walkK, skK, this.wSkate);
      th = lerp(th, airT, this.wAir);
      kn = lerp(kn, airK, this.wAir);
      leg.hip.rotation.x = th;
      leg.knee.rotation.x = -kn;
      leg.ankle.rotation.x = -(th - kn);
      if (leg.isQuad) {
        leg.hip.rotation.z = leg.side * QUAD_ROLL;
        leg.knee.rotation.z = -leg.side * QUAD_ROLL * 0.95;
        leg.ankle.rotation.z = 0;
        leg.ankle.rotation.x = -(th - kn) * 0.6;
      } else {
        leg.hip.rotation.z = leg.side * 0.03;
      }
    });
    // ground compensation so the lowest sole rests on y = -1.5
    this.body.position.y = 0;
    this.body.rotation.set(0, 0, 0);
    root.updateMatrixWorld(true);
    let lowest = Infinity;
    for (const leg of legs) {
      leg.sole.getWorldPosition(_v1);
      lowest = Math.min(lowest, _v1.y - root.position.y);
    }
    const comp = Number.isFinite(lowest) ? -PLAYER.HALF.y - lowest : 0;
    this.body.position.y = comp * this.groundBlend - this.landDip;
    // idle bob
    if (f.walkSpeed !== undefined || (!airborne && this.ampWalk > 0.05 && this.wSkate < 0.5)) this.body.position.y += Math.abs(Math.sin(this.phase)) * 0.03 * this.ampWalk;
    root.updateMatrixWorld(true);
    legs.forEach((leg, i) => {
      if (i < 2) leg.sole.getWorldPosition(this.footWorld[i]);
    });

    // ---- arms (root-local)
    const cosY = Math.cos(this.visYaw);
    const sinY = Math.sin(this.visYaw);
    const toLocal = (w: V3, out: Vector3): Vector3 => {
      const dx = w.x - f.pos.x;
      const dz = w.z - f.pos.z;
      return out.set(cosY * dx - sinY * dz, w.y - f.pos.y, sinY * dx + cosY * dz);
    };
    const dirLocal = new Vector3();
    {
      const dx = f.aimDir.x;
      const dz = f.aimDir.z;
      dirLocal.set(cosY * dx - sinY * dz, f.aimDir.y, sinY * dx + cosY * dz).normalize();
    }
    const Mloc = toLocal(f.muzzle, new Vector3());
    const Lw = WEAPON_LENGTH[this.curWeapon];
    // the weapon root (barrel tip = sim muzzle) is exact; the recoil slides the gun body back along the bore inside it
    const H = new Vector3().copy(Mloc).addScaledVector(dirLocal, -Lw);
    const Hkick = new Vector3().copy(H).addScaledVector(dirLocal, -this.kick);
    // shoulders in root-local
    this.torso.updateMatrix();
    const SR = new Vector3(SHOULDER.x, SHOULDER.y, SHOULDER.z).applyMatrix4(this.torso.matrix).add(this.body.position);
    const SL = new Vector3(-SHOULDER.x, SHOULDER.y, SHOULDER.z).applyMatrix4(this.torso.matrix).add(this.body.position);
    this.solveArm(this.rightUpper, this.rightFore, SR, Hkick, new Vector3(0.75, -0.6, 0.25), new Vector3(1, 0, 0));
    // weapon root orientation: -Z = aim direction
    {
      const z = _v1.copy(dirLocal).multiplyScalar(-1);
      const hint = Math.abs(z.y) > 0.98 ? new Vector3(0, 0, -1) : UP;
      const y = new Vector3().copy(hint).addScaledVector(z, -hint.dot(z)).normalize();
      const x = new Vector3().crossVectors(y, z);
      _m.makeBasis(x, y, z);
      this.handRoot.quaternion.setFromRotationMatrix(_m);
      this.handRoot.position.copy(H);
      for (const w of this.weapons.values()) w.position.z = this.kick; // local +Z = backwards along the bore
    }
    // left arm: relaxed, swings with the gait, sweeps back when skating
    const swing = Math.sin(this.phase) * 0.28 * this.ampWalk * (1 - this.wSkate);
    const HL = new Vector3(SL.x - 0.08, SL.y - 0.62 + 0.12 * this.wAir, SL.z - 0.36 - swing - 0.18 * this.wAir + 0.3 * this.wSkate);
    this.solveArm(this.leftUpper, this.leftFore, SL, HL, new Vector3(-0.75, -0.6, 0.25), new Vector3(-1, 0, 0));

    // ---- thrusters
    const wantFlight = f.thrusting ? 1 : 0;
    this.flightLevel = lerp(this.flightLevel, wantFlight, expK(f.thrusting ? 30 : 14, dt));
    const wantQb = f.qbRemaining > 0 ? 1 : qbActive ? 0.6 : 0;
    this.qbLevel = lerp(this.qbLevel, wantQb, expK(wantQb > 0 ? 40 : 10, dt));
    const glideLevel = !airborne && glideish ? clamp((sp - 8) / 16, 0, 1) * 0.5 : 0;
    // flame direction (root-local): down for flight, opposite the QB direction, back-down at idle
    const qd = f.qbDir;
    const qbLocal = new Vector3(cosY * qd.x - sinY * qd.z, 0, sinY * qd.x + cosY * qd.z);
    const back = qbLocal.lengthSq() > 1e-6 ? qbLocal.clone().normalize().multiplyScalar(-1) : new Vector3(0, 0, 1);
    const glideDirLocal = new Vector3(0, 0, 1); // ground glide: exhaust streams straight back
    const fd = new Vector3(0, -0.85, 0.5)
      .multiplyScalar(0.25 + glideLevel)
      .addScaledVector(new Vector3(0, -1, 0), this.flightLevel * 1.2)
      .addScaledVector(back.clone().add(new Vector3(0, -0.15, 0)), this.qbLevel * 1.6)
      .addScaledVector(glideDirLocal, glideLevel * 0.4);
    if (fd.lengthSq() < 1e-6) fd.set(0, -1, 0.4);
    fd.normalize();
    this.flameDir.lerp(fd, expK(30, dt)).normalize();
    const tq = _q.copy(this.torso.quaternion).invert();
    const dirTorso = new Vector3().copy(this.flameDir).applyQuaternion(tq);
    const strength = clamp(0.16 + glideLevel * 0.5 + this.flightLevel * 0.8 + this.qbLevel * 1.4, 0, 2.2);
    this.flameStrength = strength;
    const flick = 0.88 + 0.24 * Math.sin(f.time * 90 + 1.7) * Math.cos(f.time * 57);
    const len = (0.18 + strength * 0.95) * flick;
    const wid = 0.85 + strength * 0.5;
    const blue = clamp(this.qbLevel, 0, 1);
    for (const gm of this.gimbals) {
      gm.g.quaternion.setFromUnitVectors(new Vector3(0, -1, 0), dirTorso);
      gm.outer.scale.set(wid, len, wid);
      gm.core.scale.set(wid * 0.5, len * 0.72, wid * 0.5);
      (gm.outer.material as MeshBasicMaterial).color.setRGB(lerp(1.0, 0.45, blue), lerp(0.52, 0.72, blue), lerp(0.16, 1.0, blue));
      (gm.core.material as MeshBasicMaterial).color.setRGB(lerp(1.0, 0.85, blue), lerp(0.9, 0.95, blue), lerp(0.7, 1.0, blue));
      gm.outer.visible = gm.core.visible = strength > 0.3;
    }
    this.torso.updateMatrixWorld(true);
    this.gimbals.forEach((gm, i) => {
      gm.tip.getWorldPosition(this.nozzleWorld[i]);
    });
    this.flameWorldDir.copy(this.flameDir).applyAxisAngle(UP, this.visYaw);

    // ---- hit flash
    const flash = this.hitFlash > 0 ? this.hitFlash / 0.12 : 0;
    // a short red tint, not a full-body glow: enemies hit the mech many times a second and the model must stay readable
    this.mats.unit.emissive.setRGB(flash * 0.5, flash * 0.07, flash * 0.04);
  }

  dispose(): void {
    this.root.traverse((o) => {
      const mesh = o as Mesh;
      if (mesh.isMesh) {
        mesh.geometry.dispose();
      }
    });
    for (const gm of this.gimbals) {
      (gm.outer.material as Material).dispose();
      (gm.core.material as Material).dispose();
    }
  }
}
