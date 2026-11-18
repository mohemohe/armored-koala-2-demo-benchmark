/**
 * Player mech model — a heavy combat robot with a koala head, built entirely from procedural geometry.
 *
 * Frame: `group` origin = FEET centre on the ground, the model faces -Z, +Y is up (same as the simulation's
 * body frame for yaw 0, see src/core/vec.ts). Place it at `player.pos - (0, PLAYER.half.y, 0)` with
 * `rotation.y = player.yaw`.
 *
 * Gameplay contract: the muzzle tip of the active weapon is exactly at MECH_MUZZLE_LOCAL
 * (= PLAYER.muzzleLocal expressed in this frame) for every aim direction. The weapon assembly is a child of
 * the root group that pivots about that point, the barrel axis is `aimDirLocal`; the right arm follows the
 * weapon with a two-bone IK solve, so body leans / bobbing never move the muzzle.
 *
 * Rendering cost: one shared MeshStandardMaterial (vertex colours + tiny palette textures for
 * roughness/metalness/emissive), one merged mesh per moving joint, one shared additive flame shader.
 * Biped = 18 opaque draw calls (~19k triangles), quadruped = 24 (~21k), plus 0–9 additive flame draws
 * depending on the thruster state. `update()` does not allocate.
 *
 * Recoil never moves the muzzle or the barrel axis: it only kicks the torso and the elbow and rolls the weapon
 * about its own barrel axis. The quadruped footprint is intentionally a little wider than the collision box.
 */
import * as THREE from 'three';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import { PLAYER } from '../config';
import type { HorizontalMode, LegsId, VerticalMode, Weapon } from '../sim/types';
import { OWN_MECH_STENCIL } from './effects';

export interface MechAnimInput {
  /** Real seconds since the previous update. */
  dt: number;
  /** Monotonically increasing seconds (idle motion, flicker). */
  time: number;
  grounded: boolean;
  /** Actual horizontal speed, m/s (walk ≈ 10, glide ≈ 22, quick boost up to 80). */
  horizontalSpeed: number;
  /** Unit horizontal velocity direction in the body frame (x = right, z = forward); (0,0) when still. */
  moveDirLocal: { x: number; z: number };
  horizontalMode: HorizontalMode;
  verticalMode: VerticalMode;
  braking: boolean;
  /** Currently selected weapon. */
  weapon: Weapon;
  /** Unit launch direction in the model's local axes (+x right, +y up, -z forward). */
  aimDirLocal: { x: number; y: number; z: number };
  /** Set for one update when a shot was just fired (muzzle flash / recoil). */
  fired: Weapon | null;
}

/** Muzzle tip in model space (feet-centre origin): (0.9, 2.75, -0.85) with the default config. */
export const MECH_MUZZLE_LOCAL: Readonly<{ x: number; y: number; z: number }> = Object.freeze({
  x: PLAYER.muzzleLocal.right,
  y: PLAYER.half.y + PLAYER.muzzleLocal.up,
  z: -PLAYER.muzzleLocal.forward,
});

/** World direction → the model's local axes for a body yaw (Euler 'YXZ', yaw 0 looks along -Z). */
export function worldDirToMechLocal<T extends { x: number; y: number; z: number }>(
  dir: { x: number; y: number; z: number },
  yaw: number,
  out: T,
): T {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const x = dir.x * c - dir.z * s;
  const z = dir.x * s + dir.z * c;
  out.x = x;
  out.y = dir.y;
  out.z = z;
  return out;
}

/** World horizontal velocity → `moveDirLocal` (x = right, z = forward, unit length or (0,0)). */
export function worldVelToMoveDirLocal<T extends { x: number; z: number }>(vx: number, vz: number, yaw: number, out: T): T {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const right = vx * c - vz * s;
  const fwd = -vx * s - vz * c;
  const l = Math.hypot(right, fwd);
  if (l < 1e-4) {
    out.x = 0;
    out.z = 0;
  } else {
    out.x = right / l;
    out.z = fwd / l;
  }
  return out;
}

// ───────────────────────────── palette ─────────────────────────────
// [albedo (sRGB hex), roughness, metalness, emissive (sRGB hex)]
const PAL_DEF = {
  armorLight: [0x8f99a6, 0.56, 0.25, 0x000000],
  armorDark: [0x56616e, 0.6, 0.3, 0x000000],
  armorPale: [0xbfc6ce, 0.5, 0.18, 0x000000],
  earPale: [0xd8d2c8, 0.72, 0.04, 0x000000],
  nose: [0x0a0b0e, 0.2, 0.15, 0x000000],
  joint: [0x2c3139, 0.55, 0.6, 0x000000],
  gunmetal: [0x3b4149, 0.42, 0.72, 0x000000],
  steel: [0x737b85, 0.42, 0.6, 0x000000],
  black: [0x121417, 0.75, 0.2, 0x000000],
  orange: [0xe8761f, 0.5, 0.12, 0x2a0d00],
  hazard: [0xe6b722, 0.55, 0.1, 0x000000],
  white: [0xe4e7ea, 0.45, 0.1, 0x000000],
  red: [0xc8402c, 0.45, 0.1, 0x000000],
  eye: [0x0d3c44, 0.25, 0.0, 0x58f6ff],
  cyanGlow: [0x0c3a44, 0.35, 0.0, 0x2fd3ee],
  cyanDim: [0x0b2b33, 0.5, 0.3, 0x0b5f73],
  orangeGlow: [0x401a05, 0.4, 0.0, 0xff7a1c],
} as const;
type Pal = keyof typeof PAL_DEF;
const PAL_NAMES = Object.keys(PAL_DEF) as Pal[];
const PAL_COUNT = PAL_NAMES.length;
const PAL_INDEX = Object.fromEntries(PAL_NAMES.map((n, i) => [n, i])) as Record<Pal, number>;

function makePaletteTextures(): { orm: THREE.DataTexture; emissive: THREE.DataTexture } {
  const orm = new Uint8Array(PAL_COUNT * 4);
  const em = new Uint8Array(PAL_COUNT * 4);
  PAL_NAMES.forEach((name, i) => {
    const d = PAL_DEF[name];
    orm[i * 4 + 0] = 255;
    orm[i * 4 + 1] = Math.round(d[1] * 255); // G = roughness
    orm[i * 4 + 2] = Math.round(d[2] * 255); // B = metalness
    orm[i * 4 + 3] = 255;
    em[i * 4 + 0] = (d[3] >> 16) & 255;
    em[i * 4 + 1] = (d[3] >> 8) & 255;
    em[i * 4 + 2] = d[3] & 255;
    em[i * 4 + 3] = 255;
  });
  const mk = (data: Uint8Array, srgb: boolean): THREE.DataTexture => {
    const t = new THREE.DataTexture(data, PAL_COUNT, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.NearestFilter;
    t.generateMipmaps = false;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.needsUpdate = true;
    return t;
  };
  return { orm: mk(orm, false), emissive: mk(em, true) };
}

// ───────────────────────────── geometry kit (build time only) ─────────────────────────────
const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

function xf(px = 0, py = 0, pz = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(px, py, pz),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    new THREE.Vector3(sx, sy, sz),
  );
}
/** Transform that maps the local -Y axis onto `dir` (used for nozzles) and translates to `pos`. */
function xfDir(pos: readonly number[], dir: readonly number[]): THREE.Matrix4 {
  const d = new THREE.Vector3(dir[0], dir[1], dir[2]).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), d);
  return new THREE.Matrix4().compose(new THREE.Vector3(pos[0], pos[1], pos[2]), q, new THREE.Vector3(1, 1, 1));
}

const sph = (ws = 16, hs = 12, ps?: number, pl?: number, ts?: number, tl?: number): THREE.BufferGeometry =>
  new THREE.SphereGeometry(1, ws, hs, ps, pl, ts, tl);
const cyl = (rTop: number, rBot: number, h: number, seg = 12): THREE.BufferGeometry => new THREE.CylinderGeometry(rTop, rBot, h, seg, 1);
const tor = (R: number, r: number, rs = 6, ts = 20, arc = TAU): THREE.BufferGeometry => new THREE.TorusGeometry(R, r, rs, ts, arc);
const hull = (pts: readonly (readonly number[])[]): THREE.BufferGeometry =>
  new ConvexGeometry(pts.map((p) => new THREE.Vector3(p[0], p[1], p[2])));

/** Chamfered box centred on the origin. */
function cbox(w: number, h: number, d: number, c = 0.025): THREE.BufferGeometry {
  const hw = w / 2;
  const hh = h / 2;
  const hd = d / 2;
  c = Math.min(c, hw * 0.9, hh * 0.9, hd * 0.9);
  const pts: number[][] = [];
  for (const sx of [-1, 1])
    for (const sy of [-1, 1])
      for (const sz of [-1, 1]) {
        pts.push([sx * (hw - c), sy * (hh - c), sz * hd]);
        pts.push([sx * (hw - c), sy * hh, sz * (hd - c)]);
        pts.push([sx * hw, sy * (hh - c), sz * (hd - c)]);
      }
  return hull(pts);
}
/** Tapered box: bottom rectangle (w0 × d0) at y = 0, top rectangle (w1 × d1) at y = h shifted by (ox, oz). */
function taper(w0: number, d0: number, w1: number, d1: number, h: number, ox = 0, oz = 0): THREE.BufferGeometry {
  const pts: number[][] = [];
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      pts.push([(sx * w0) / 2, 0, (sz * d0) / 2]);
      pts.push([ox + (sx * w1) / 2, h, oz + (sz * d1) / 2]);
    }
  return hull(pts);
}
/** Bevelled armour plate from a convex outline in the XY plane: back face at z = 0, smaller front face at z = -t. */
function plate(outline: readonly (readonly number[])[], t: number, bevel: number): THREE.BufferGeometry {
  let cx = 0;
  let cy = 0;
  for (const p of outline) {
    cx += p[0];
    cy += p[1];
  }
  cx /= outline.length;
  cy /= outline.length;
  const pts: number[][] = [];
  for (const p of outline) {
    const dx = p[0] - cx;
    const dy = p[1] - cy;
    const l = Math.hypot(dx, dy) || 1;
    const k = Math.max(0, 1 - bevel / l);
    pts.push([p[0], p[1], 0]);
    pts.push([p[0], p[1], -t * 0.45]);
    pts.push([cx + dx * k, cy + dy * k, -t]);
  }
  return hull(pts);
}

/** Accumulates transformed primitives into one non-indexed geometry (position, normal, uv = palette cell, color). */
class Builder {
  private readonly pos: number[] = [];
  private readonly nor: number[] = [];
  private readonly uv: number[] = [];
  private readonly col: number[] = [];
  private static readonly v = new THREE.Vector3();
  private static readonly n = new THREE.Vector3();
  private static readonly nm = new THREE.Matrix3();
  private static readonly c = new THREE.Color();

  add(src: THREE.BufferGeometry, pal: Pal, m?: THREE.Matrix4): this {
    const g = src.index ? src.toNonIndexed() : src;
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    const v = Builder.v;
    const nn = Builder.n;
    const flip = m ? m.determinant() < 0 : false;
    if (m) Builder.nm.getNormalMatrix(m);
    const c = Builder.c.setHex(PAL_DEF[pal][0]);
    const u = (PAL_INDEX[pal] + 0.5) / PAL_COUNT;
    const count = p.count - (p.count % 3);
    for (let i = 0; i < count; i += 3) {
      for (let k = 0; k < 3; k++) {
        const j = i + (flip ? 2 - k : k);
        v.fromBufferAttribute(p, j);
        nn.fromBufferAttribute(n, j);
        if (m) {
          v.applyMatrix4(m);
          nn.applyMatrix3(Builder.nm).normalize();
        }
        this.pos.push(v.x, v.y, v.z);
        this.nor.push(nn.x, nn.y, nn.z);
        this.uv.push(u, 0.5);
        // Very light baked hemisphere occlusion so forms still read in flat lighting.
        const ao = 0.86 + 0.14 * (nn.y * 0.5 + 0.5);
        this.col.push(c.r * ao, c.g * ao, c.b * ao);
      }
    }
    if (g !== src) g.dispose();
    src.dispose();
    return this;
  }

  /** Adds the same primitive mirrored across the YZ plane as well. */
  addPair(make: () => THREE.BufferGeometry, pal: Pal, m: THREE.Matrix4): this {
    this.add(make(), pal, m);
    this.add(make(), pal, new THREE.Matrix4().makeScale(-1, 1, 1).multiply(m));
    return this;
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/** Mirror of a built geometry across the YZ plane (x → -x), winding fixed. */
function mirrorX(src: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = src.clone();
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const n = g.getAttribute('normal') as THREE.BufferAttribute;
  const u = g.getAttribute('uv') as THREE.BufferAttribute;
  const c = g.getAttribute('color') as THREE.BufferAttribute;
  const swap = (a: THREE.BufferAttribute, i: number, j: number): void => {
    for (let k = 0; k < a.itemSize; k++) {
      const t = a.array[i * a.itemSize + k];
      a.array[i * a.itemSize + k] = a.array[j * a.itemSize + k];
      a.array[j * a.itemSize + k] = t;
    }
  };
  for (let i = 0; i < p.count; i++) {
    p.setX(i, -p.getX(i));
    n.setX(i, -n.getX(i));
  }
  for (let i = 0; i + 2 < p.count; i += 3) {
    swap(p, i + 1, i + 2);
    swap(n, i + 1, i + 2);
    swap(u, i + 1, i + 2);
    swap(c, i + 1, i + 2);
  }
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

/** Thruster bell: throat at `pos`, exit `L` further along `dir`, exit radius R. */
function addNozzle(b: Builder, pos: readonly number[], dir: readonly number[], R: number, L: number, seg = 12): void {
  const m = xfDir(pos, dir);
  const v2 = (x: number, y: number): THREE.Vector2 => new THREE.Vector2(x, y);
  b.add(new THREE.LatheGeometry([v2(R, -L), v2(R * 0.66, -L * 0.35), v2(R * 0.52, 0), v2(R * 0.52, L * 0.25)], seg), 'gunmetal', m);
  b.add(new THREE.LatheGeometry([v2(R * 0.02, -L * 0.2), v2(R * 0.45, -L * 0.25), v2(R * 0.9, -L)], seg), 'cyanDim', m);
  b.add(tor(R * 0.95, R * 0.07, 4, seg), 'steel', m.clone().multiply(xf(0, -L, 0, 90 * DEG)));
}

// ───────────────────────────── layout constants (model space unless noted) ─────────────────────────────
const HIP_Y = 1.68; // pelvis origin (hip centre) above the ground
const WAIST = new THREE.Vector3(0, 0.34, 0); // torso pivot, pelvis-local
const NECK = new THREE.Vector3(0, 1.0, -0.03); // head pivot, torso-local
const SHOULDER_R = new THREE.Vector3(0.87, 0.96, 0.16); // torso-local
const ARM_L1 = 0.68;
const ARM_L2 = 0.68;
/** Wrist socket on every weapon, in weapon space (muzzle = origin, barrel = -Z, body extends along +Z). */
const GRIP = new THREE.Vector3(0, -0.23, 0.5);
const HEAD_CY = 0.42; // skull centre above the neck pivot
const RETRO_DIR = [0.86, -0.3, -0.42] as const; // right-hand retro thruster axis (pelvis space)
const EAR_R = 0.36;
const EAR_TILT = 55 * DEG; // ears sit on the sides of the skull, koala style

// ───────────────────────────── part geometry ─────────────────────────────
function buildHead(): THREE.BufferGeometry {
  const b = new Builder();
  const cy = HEAD_CY;
  const RX = 0.6;
  const RY = 0.46;
  const RZ = 0.54;
  // neck joint
  b.add(cyl(0.15, 0.18, 0.2, 12), 'joint', xf(0, 0.0, 0.02));
  // skull
  b.add(sph(28, 18), 'armorLight', xf(0, cy, 0, 0, 0, 0, RX, RY, RZ));
  // rear helmet plate (darker) — phi runs -X → +Z → +X → -Z
  b.add(sph(20, 8, 24 * DEG, 132 * DEG, 64 * DEG, 50 * DEG), 'armorDark', xf(0, cy, 0, 0, 0, 0, RX * 1.018, RY * 1.018, RZ * 1.018));
  // pale lower face / jaw
  b.add(sph(20, 12), 'armorPale', xf(0, cy - 0.2, -0.13, 0, 0, 0, 0.47, 0.25, 0.42));
  // jaw underside
  b.add(sph(14, 8), 'armorDark', xf(0, cy - 0.31, -0.02, 0, 0, 0, 0.4, 0.17, 0.4));
  // big black nose
  b.add(sph(18, 12), 'nose', xf(0, cy - 0.04, -0.55, 0, 0, 0, 0.16, 0.245, 0.13));
  b.add(sph(12, 8), 'joint', xf(0, cy - 0.05, -0.5, 0, 0, 0, 0.21, 0.29, 0.1));
  // eyes: dark sockets + glowing lenses, following the skull surface
  for (const s of [-1, 1]) {
    const ex = 0.285 * s;
    const ey = cy + 0.075;
    b.add(sph(12, 8), 'black', xf(ex, ey, -0.452, -8 * DEG, -27 * DEG * s, 8 * DEG * s, 0.125, 0.092, 0.05));
    b.add(sph(12, 8), 'eye', xf(ex + 0.012 * s, ey, -0.474, -8 * DEG, -27 * DEG * s, 8 * DEG * s, 0.086, 0.058, 0.035));
  }
  // visor brow: dark band above the eyes (solid torus arc lying in a horizontal plane, front centred)
  {
    const arc = 156 * DEG;
    const m = xf(0, cy + 0.215, 0, 0, 0, 0, RX * 0.925, 1, RZ * 0.925).multiply(xf(0, 0, 0, 90 * DEG, 0, 0)).multiply(xf(0, 0, 0, 0, 0, -90 * DEG - arc / 2));
    b.add(tor(1, 0.085, 6, 22, arc), 'armorDark', m);
  }
  // crest ridge front → back over the top, with an orange section at the rear
  {
    const base = xf(0, cy, 0, 0, 0, 0, 0.9, RY * 1.03, RZ * 1.03).multiply(xf(0, 0, 0, 0, 90 * DEG, 0));
    b.add(tor(1, 0.05, 4, 16, 92 * DEG), 'armorDark', base.clone().multiply(xf(0, 0, 0, 0, 0, 38 * DEG)));
    b.add(tor(1.004, 0.052, 4, 8, 34 * DEG), 'orange', base.clone().multiply(xf(0, 0, 0, 0, 0, 130 * DEG)));
  }
  // panel seam around the back of the skull
  b.add(tor(1, 0.014, 4, 28, 200 * DEG), 'joint', xf(0, cy - 0.1, 0, 0, 0, 0, RX * 0.985, 1, RZ * 0.985).multiply(xf(0, 0, 0, 90 * DEG, 0, 0)).multiply(xf(0, 0, 0, 0, 0, -10 * DEG)));
  // rear hatch with a small status light
  b.add(cbox(0.22, 0.12, 0.05, 0.015), 'joint', xf(0, cy + 0.02, 0.535));
  b.add(cbox(0.1, 0.03, 0.03, 0.008), 'cyanGlow', xf(0, cy + 0.02, 0.56));
  // ear mounts
  for (const s of [-1, 1]) b.add(cyl(0.11, 0.13, 0.14, 10), 'joint', xf(s * 0.5, cy + 0.13, 0.06, 0, 0, -55 * DEG * s));
  // antenna (right rear)
  b.add(cbox(0.07, 0.06, 0.09, 0.012), 'joint', xf(0.24, cy + 0.385, 0.2, -12 * DEG, 0, -8 * DEG));
  b.add(cyl(0.008, 0.013, 0.33, 5), 'steel', xf(0.25, cy + 0.56, 0.235, 12 * DEG, 0, -3 * DEG));
  b.add(sph(6, 4), 'orangeGlow', xf(0.258, cy + 0.73, 0.27, 0, 0, 0, 0.02, 0.02, 0.02));
  return b.build();
}

/**
 * Right ear in its own frame: origin at the hinge on the skull, disc centre at (0, EAR_R - 0.03, 0), front = -Z,
 * local +X = the outer / lower edge, which carries a pale fringe plate (the left ear is the mirror image).
 */
function buildEar(): THREE.BufferGeometry {
  const b = new Builder();
  const c = EAR_R - 0.03;
  b.add(sph(22, 10), 'armorLight', xf(0, c, 0, 0, 0, 0, EAR_R, EAR_R, 0.085));
  b.add(tor(EAR_R - 0.02, 0.045, 6, 26), 'armorDark', xf(0, c, 0));
  b.add(sph(18, 8), 'earPale', xf(0, c, -0.06, 0, 0, 0, 0.26, 0.26, 0.05));
  // fringe: a pale crescent peeking out along the outer / lower edge (the koala's fluffy ear rim)
  b.add(sph(22, 8), 'armorPale', xf(0.075, c - 0.045, 0.005, 0, 0, 0, EAR_R * 1.02, EAR_R * 1.02, 0.05));
  b.add(tor(EAR_R * 1.02, 0.022, 4, 26), 'armorLight', xf(0.075, c - 0.045, 0.005));
  // back: small service cap near the hinge
  b.add(cbox(0.12, 0.1, 0.04, 0.012), 'armorDark', xf(0, c - 0.2, 0.066));
  return b.build();
}

function buildTorso(): THREE.BufferGeometry {
  const b = new Builder();
  // waist joint
  b.add(cyl(0.3, 0.32, 0.2, 14), 'joint', xf(0, 0.0, 0.0));
  b.add(cyl(0.34, 0.34, 0.04, 14), 'gunmetal', xf(0, 0.08, 0));
  // abdomen + chest core
  b.add(taper(0.7, 0.56, 0.86, 0.72, 0.3), 'armorDark', xf(0, 0.1, 0.02));
  b.add(taper(0.84, 0.72, 1.0, 0.86, 0.36), 'armorDark', xf(0, 0.4, 0.02));
  b.add(taper(1.0, 0.86, 0.78, 0.66, 0.26), 'armorDark', xf(0, 0.76, 0.02));
  // pectoral plates
  const pec = (): THREE.BufferGeometry =>
    hull([
      [0.065, 0.97, -0.47], [0.5, 0.93, -0.4], [0.52, 0.58, -0.43], [0.065, 0.5, -0.6],
      [0.065, 0.97, -0.3], [0.5, 0.93, -0.3], [0.52, 0.58, -0.3], [0.065, 0.5, -0.3],
    ]);
  b.addPair(pec, 'armorLight', xf());
  // orange chest stripes (follow the plate slope)
  b.addPair(() => cbox(0.2, 0.055, 0.03, 0.008), 'orange', xf(0.33, 0.885, -0.452, -7 * DEG, -10 * DEG, -4 * DEG));
  // sternum recess + sensor
  b.add(cbox(0.13, 0.46, 0.1, 0.02), 'joint', xf(0, 0.74, -0.44));
  b.add(sph(10, 8), 'cyanGlow', xf(0, 0.86, -0.49, 0, 0, 0, 0.045, 0.045, 0.03));
  // pale belly plate
  b.add(
    hull([
      [-0.21, 0.5, -0.51], [0.21, 0.5, -0.51], [-0.14, 0.13, -0.36], [0.14, 0.13, -0.36],
      [-0.21, 0.5, -0.3], [0.21, 0.5, -0.3], [-0.14, 0.13, -0.24], [0.14, 0.13, -0.24],
    ]),
    'armorPale',
  );
  // collar ring + rear head guard
  b.add(tor(0.25, 0.075, 6, 18), 'armorDark', xf(0, 1.0, -0.03, 90 * DEG, 0, 0, 1, 1, 0.8));
  b.add(cbox(0.6, 0.2, 0.12, 0.03), 'armorLight', xf(0, 1.07, 0.33, 14 * DEG));
  // shoulder yokes + ball joints
  b.addPair(() => cbox(0.42, 0.22, 0.36, 0.04), 'joint', xf(0.65, 0.975, 0.17));
  b.addPair(() => cbox(0.3, 0.05, 0.3, 0.015), 'armorLight', xf(0.62, 1.095, 0.17));
  b.addPair(() => sph(14, 10), 'steel', xf(SHOULDER_R.x, SHOULDER_R.y, SHOULDER_R.z, 0, 0, 0, 0.18, 0.18, 0.18));
  // backpack
  b.add(cbox(0.84, 0.6, 0.36, 0.05), 'armorDark', xf(0, 0.62, 0.6));
  b.add(cbox(0.7, 0.06, 0.3, 0.02), 'armorLight', xf(0, 0.94, 0.6));
  b.add(cbox(0.09, 0.42, 0.03, 0.008), 'orange', xf(0, 0.68, 0.782));
  for (let i = 0; i < 3; i++) b.addPair(() => cbox(0.2, 0.03, 0.03, 0.006), 'black', xf(0.2, 0.84 - i * 0.07, 0.782));
  b.add(cbox(0.3, 0.05, 0.05, 0.01), 'hazard', xf(0, 0.93, 0.76));
  // main boosters: housings + bells (down 30° from straight back)
  const mainDir = [0, -0.5, 0.866];
  b.addPair(() => cbox(0.32, 0.34, 0.34, 0.04), 'armorLight', xf(0.25, 0.42, 0.74, -30 * DEG));
  b.addPair(() => cbox(0.325, 0.06, 0.2, 0.01), 'orange', xf(0.25, 0.53, 0.82, -30 * DEG));
  addNozzle(b, [0.25, 0.36, 0.86], mainDir, 0.155, 0.22);
  addNozzle(b, [-0.25, 0.36, 0.86], mainDir, 0.155, 0.22);
  // downward lift jets under the booster housings
  addNozzle(b, [0.25, 0.25, 0.62], [0, -1, 0.12], 0.085, 0.1, 10);
  addNozzle(b, [-0.25, 0.25, 0.62], [0, -1, 0.12], 0.085, 0.1, 10);
  // waist side boosters
  b.addPair(() => cbox(0.22, 0.27, 0.38, 0.03), 'armorLight', xf(0.44, 0.24, 0.08, 0, 0, -18 * DEG));
  b.addPair(() => cbox(0.225, 0.05, 0.385, 0.008), 'armorDark', xf(0.425, 0.3, 0.08, 0, 0, -18 * DEG));
  addNozzle(b, [0.5, 0.22, 0.08], [0.94, -0.34, 0.06], 0.11, 0.12, 10);
  addNozzle(b, [-0.5, 0.22, 0.08], [-0.94, -0.34, 0.06], 0.11, 0.12, 10);
  // front waist vents
  b.addPair(() => cbox(0.14, 0.14, 0.12, 0.02), 'armorLight', xf(0.3, 0.3, -0.3, 25 * DEG));
  b.addPair(() => cbox(0.09, 0.03, 0.03, 0.006), 'black', xf(0.3, 0.3, -0.365, 25 * DEG));
  // weapon racks on the backpack flanks
  b.addPair(() => cbox(0.2, 0.16, 0.12, 0.02), 'joint', xf(0.47, 0.72, 0.62));
  b.addPair(() => cbox(0.2, 0.1, 0.12, 0.02), 'joint', xf(0.47, 0.38, 0.62));
  return b.build();
}

/** Upper arm in bone space: origin at the shoulder, bone along -Y (length ARM_L1), +X outward, -Z front (right arm). */
function buildUpperArm(big: boolean): THREE.BufferGeometry {
  const b = new Builder();
  b.add(cyl(0.15, 0.14, 0.2, 10), 'joint', xf(0, -0.1, 0));
  b.add(cbox(0.24, 0.46, 0.27, 0.04), 'armorDark', xf(0, -0.38, 0));
  b.add(cbox(0.08, 0.36, 0.2, 0.02), 'armorLight', xf(0.11, -0.4, 0));
  b.add(cyl(0.125, 0.125, 0.3, 12), 'steel', xf(0, -ARM_L1, 0, 0, 0, 90 * DEG));
  // pauldron
  const zf = big ? -0.31 : -0.17;
  const zb = 0.33;
  const top = big ? 0.27 : 0.23;
  b.add(
    hull([
      [-0.1, top - 0.03, zf + 0.06], [-0.1, top - 0.03, zb - 0.06],
      [0.2, top, zf + 0.04], [0.2, top, zb - 0.04],
      [0.33, 0.04, zf], [0.33, 0.04, zb],
      [0.3, -0.3, zf + 0.05], [0.3, -0.3, zb - 0.05],
      [0.1, -0.22, zf + 0.03], [0.1, -0.22, zb - 0.03],
      [-0.1, -0.02, zf + 0.06], [-0.1, -0.02, zb - 0.06],
    ]),
    'armorLight',
  );
  b.add(cbox(0.03, 0.075, zb - zf - 0.06, 0.008), 'orange', xf(0.322, -0.12, (zf + zb) / 2, 0, 0, 5 * DEG));
  b.add(cbox(0.2, 0.03, zb - zf - 0.14, 0.008), 'armorDark', xf(0.07, top + 0.005, (zf + zb) / 2, 0, 0, 6 * DEG));
  if (big) b.add(cbox(0.05, 0.16, 0.36, 0.012), 'armorDark', xf(0.275, 0.2, 0.02, 0, 0, -28 * DEG));
  return b.build();
}

/** Forearm in bone space: origin at the elbow, bone along -Y (length ARM_L2), +X outward, -Z front (right arm). */
function buildForearm(shield: boolean): THREE.BufferGeometry {
  const b = new Builder();
  b.add(cbox(0.2, 0.5, 0.22, 0.03), 'armorDark', xf(0, -0.34, 0));
  b.add(cbox(0.15, 0.46, 0.3, 0.04), 'armorLight', xf(0.09, -0.36, 0));
  b.add(cbox(0.155, 0.05, 0.305, 0.008), 'orange', xf(0.09, -0.52, 0));
  b.add(cyl(0.035, 0.035, 0.36, 6), 'steel', xf(-0.1, -0.3, 0.08));
  b.add(sph(10, 8), 'steel', xf(0, -ARM_L2, 0, 0, 0, 0, 0.09, 0.09, 0.09));
  if (!shield) {
    // weapon clamp
    b.add(cbox(0.05, 0.16, 0.14, 0.012), 'gunmetal', xf(0.085, -ARM_L2 + 0.02, 0));
    b.add(cbox(0.05, 0.16, 0.14, 0.012), 'gunmetal', xf(-0.085, -ARM_L2 + 0.02, 0));
  } else {
    // manipulator claws
    b.add(cbox(0.17, 0.12, 0.2, 0.025), 'joint', xf(0, -ARM_L2 - 0.03, 0));
    const claw = (): THREE.BufferGeometry => hull([[-0.03, 0, -0.035], [0.03, 0, -0.035], [-0.03, 0, 0.035], [0.03, 0, 0.035], [0, -0.22, -0.045], [0, -0.13, 0.03]]);
    b.add(claw(), 'gunmetal', xf(0.06, -ARM_L2 - 0.07, -0.07, -14 * DEG));
    b.add(claw(), 'gunmetal', xf(-0.06, -ARM_L2 - 0.07, -0.07, -14 * DEG));
    b.add(claw(), 'gunmetal', xf(0, -ARM_L2 - 0.07, 0.08, 16 * DEG, 180 * DEG));
    // shield: bevelled kite plate facing +X, mounted on a bracket
    b.add(cbox(0.1, 0.34, 0.18, 0.02), 'joint', xf(0.17, -0.32, 0));
    const outline = [[-0.23, 0.4], [0.23, 0.4], [0.31, 0.1], [0.22, -0.66], [0, -0.92], [-0.22, -0.66], [-0.31, 0.1]];
    const face = xf(0.2, 0, 0, 0, -90 * DEG, 0);
    b.add(plate(outline, 0.075, 0.07), 'armorDark', face);
    const inner = outline.map((p) => [p[0] * 0.66, p[1] * 0.7 - 0.03]);
    b.add(plate(inner, 0.035, 0.03), 'armorLight', xf(0.27, 0, 0, 0, -90 * DEG, 0));
    b.add(cbox(0.02, 0.07, 0.34, 0.006), 'orange', xf(0.31, 0.02, 0));
    b.add(cbox(0.02, 0.03, 0.25, 0.006), 'orange', xf(0.31, -0.08, 0));
    b.add(cbox(0.02, 0.05, 0.12, 0.006), 'hazard', xf(0.31, -0.5, 0));
  }
  return b.build();
}

// ── weapons: muzzle tip at the origin, barrel axis = -Z, everything else at z >= 0 ──
function buildMachineGun(): THREE.BufferGeometry {
  const b = new Builder();
  const along = (z: number): THREE.Matrix4 => xf(0, 0, z, 90 * DEG, 0, 0);
  // rotary barrel cluster
  for (let i = 0; i < 3; i++) {
    const a = (90 + i * 120) * DEG;
    const x = Math.cos(a) * 0.068;
    const y = Math.sin(a) * 0.068;
    b.add(cyl(0.04, 0.04, 0.516, 8), 'steel', xf(x, y, 0.262, 90 * DEG));
    b.add(cyl(0.024, 0.024, 0.012, 8), 'black', xf(x, y, 0.006, 90 * DEG));
  }
  b.add(cyl(0.03, 0.03, 0.5, 6), 'gunmetal', along(0.26));
  b.add(cyl(0.125, 0.125, 0.07, 12), 'gunmetal', along(0.05));
  b.add(cyl(0.118, 0.118, 0.05, 12), 'gunmetal', along(0.27));
  b.add(cbox(0.27, 0.27, 0.2, 0.04), 'gunmetal', xf(0, 0, 0.5));
  // receiver
  b.add(cbox(0.24, 0.3, 0.44, 0.035), 'armorDark', xf(0, -0.01, 0.74));
  b.add(cbox(0.15, 0.06, 0.42, 0.012), 'armorLight', xf(0, 0.165, 0.72));
  b.add(cbox(0.04, 0.07, 0.2, 0.008), 'joint', xf(0, 0.225, 0.62));
  // ammunition drum on the outboard side
  b.add(cyl(0.155, 0.155, 0.2, 14), 'armorLight', xf(0.2, -0.03, 0.72, 0, 0, 90 * DEG));
  b.add(cyl(0.16, 0.16, 0.05, 14), 'orange', xf(0.2, -0.03, 0.72, 0, 0, 90 * DEG));
  b.add(cyl(0.07, 0.07, 0.03, 10), 'joint', xf(0.305, -0.03, 0.72, 0, 0, 90 * DEG));
  b.add(cbox(0.12, 0.07, 0.12, 0.012), 'joint', xf(0.14, 0.12, 0.58));
  // rear cap + grip socket
  b.add(cbox(0.18, 0.2, 0.06, 0.02), 'joint', xf(0, -0.03, 0.975));
  b.add(cbox(0.1, 0.1, 0.16, 0.015), 'joint', xf(0, -0.19, GRIP.z));
  return b.build();
}

function buildBeamRifle(): THREE.BufferGeometry {
  const b = new Builder();
  const along = (z: number): THREE.Matrix4 => xf(0, 0, z, 90 * DEG);
  // emitter: two rails, glowing core and coils
  b.add(cbox(0.06, 0.05, 0.6, 0.012), 'white', xf(0, 0.085, 0.3));
  b.add(cbox(0.06, 0.05, 0.6, 0.012), 'white', xf(0, -0.085, 0.3));
  b.add(cyl(0.024, 0.024, 0.58, 8), 'cyanGlow', along(0.3));
  for (let i = 0; i < 4; i++) b.add(tor(0.062, 0.021, 6, 14), 'cyanGlow', xf(0, 0, 0.1 + i * 0.125));
  b.add(cyl(0.05, 0.05, 0.032, 10), 'steel', along(0.02));
  b.add(cyl(0.032, 0.032, 0.006, 10), 'eye', along(0.003));
  // body
  b.add(cbox(0.17, 0.26, 0.4, 0.03), 'armorPale', xf(0, 0, 0.74));
  b.add(cbox(0.175, 0.07, 0.3, 0.01), 'armorDark', xf(0, -0.03, 0.74));
  b.add(cbox(0.12, 0.1, 0.26, 0.02), 'joint', xf(0, -0.16, 0.7));
  // capacitor tube on top with a glowing band
  b.add(cyl(0.065, 0.065, 0.36, 10), 'gunmetal', xf(0, 0.17, 0.72, 90 * DEG));
  b.add(cyl(0.07, 0.07, 0.05, 10), 'cyanGlow', xf(0, 0.17, 0.66, 90 * DEG));
  b.add(cbox(0.03, 0.06, 0.2, 0.008), 'cyanGlow', xf(0.088, 0.04, 0.74));
  b.add(cbox(0.03, 0.06, 0.2, 0.008), 'cyanGlow', xf(-0.088, 0.04, 0.74));
  b.add(cbox(0.13, 0.2, 0.05, 0.015), 'joint', xf(0, -0.01, 0.955));
  b.add(cbox(0.1, 0.08, 0.16, 0.015), 'joint', xf(0, -0.2, GRIP.z));
  return b.build();
}

function buildMissilePod(): THREE.BufferGeometry {
  const b = new Builder();
  b.add(cbox(0.4, 0.34, 0.72, 0.03), 'armorLight', xf(0, 0, 0.44));
  b.add(cbox(0.43, 0.37, 0.07, 0.015), 'armorDark', xf(0, 0, 0.049));
  b.add(cbox(0.415, 0.35, 0.06, 0.01), 'orange', xf(0, 0, 0.3));
  b.add(cbox(0.41, 0.07, 0.22, 0.01), 'hazard', xf(0, -0.1, 0.58));
  b.add(cbox(0.415, 0.02, 0.23, 0.005), 'black', xf(0, -0.1, 0.58));
  // six tubes with missile noses
  for (const x of [-0.13, 0, 0.13])
    for (const y of [-0.082, 0.082]) {
      b.add(tor(0.05, 0.012, 4, 12), 'steel', xf(x, y, 0.012));
      b.add(cyl(0.05, 0.05, 0.004, 12), 'black', xf(x, y, 0.016, 90 * DEG));
      b.add(cyl(0.036, 0.004, 0.05, 8), 'red', xf(x, y, 0.03, 90 * DEG));
    }
  b.add(cbox(0.1, 0.05, 0.42, 0.012), 'joint', xf(0, 0.195, 0.44));
  b.add(cbox(0.34, 0.28, 0.04, 0.01), 'black', xf(0, 0, 0.81));
  b.add(cbox(0.12, 0.08, 0.18, 0.015), 'joint', xf(0, -0.2, GRIP.z));
  return b.build();
}

// ── pelvis (origin = hip centre) ──
function buildPelvisCore(b: Builder): void {
  b.add(cbox(0.6, 0.36, 0.5, 0.05), 'joint', xf(0, 0, 0));
  b.add(cyl(0.31, 0.35, 0.13, 14), 'gunmetal', xf(0, 0.22, 0));
  // front plate
  b.add(
    hull([
      [-0.21, 0.18, -0.34], [0.21, 0.18, -0.34], [-0.13, -0.33, -0.36], [0.13, -0.33, -0.36],
      [-0.21, 0.18, -0.2], [0.21, 0.18, -0.2], [-0.13, -0.33, -0.2], [0.13, -0.33, -0.2],
    ]),
    'armorLight',
  );
  b.add(cbox(0.3, 0.06, 0.03, 0.008), 'orange', xf(0, 0.05, -0.352, 2 * DEG));
  b.add(cbox(0.1, 0.16, 0.03, 0.008), 'armorDark', xf(0, -0.16, -0.362, 2 * DEG));
  // rear plate
  b.add(
    hull([
      [-0.26, 0.16, 0.31], [0.26, 0.16, 0.31], [-0.17, -0.28, 0.38], [0.17, -0.28, 0.38],
      [-0.26, 0.16, 0.2], [0.26, 0.16, 0.2], [-0.17, -0.28, 0.2], [0.17, -0.28, 0.2],
    ]),
    'armorDark',
  );
  b.add(cbox(0.24, 0.05, 0.03, 0.008), 'hazard', xf(0, 0.02, 0.352, 9 * DEG));
  // retro thrusters on the front corners, splayed outwards so their burst shows beside the legs from behind
  b.addPair(() => cbox(0.15, 0.15, 0.15, 0.025), 'armorLight', xf(0.27, 0.1, -0.29, 0, -62 * DEG, 0));
  addNozzle(b, [0.3, 0.09, -0.32], RETRO_DIR, 0.07, 0.09, 10);
  addNozzle(b, [-0.3, 0.09, -0.32], [-RETRO_DIR[0], RETRO_DIR[1], RETRO_DIR[2]], 0.07, 0.09, 10);
}

const BIPED = {
  hip: [0.4, 0, 0] as const, // pelvis-local (right leg)
  l1: 0.68,
  l2: 0.8,
  ankleY: 0.3,
  rest: [0.52, 0.3, 0.04] as const,
  cycle: 4.4, // metres travelled per gait cycle
};

function buildPelvisBiped(): THREE.BufferGeometry {
  const b = new Builder();
  buildPelvisCore(b);
  b.addPair(() => cyl(0.19, 0.19, 0.2, 12), 'gunmetal', xf(0.3, 0, 0, 0, 0, 90 * DEG));
  // side skirts
  b.addPair(
    () => hull([[0, 0.22, -0.26], [0, 0.22, 0.26], [0.02, -0.3, -0.22], [0.02, -0.3, 0.22], [0.09, 0.18, -0.24], [0.09, 0.18, 0.24], [0.1, -0.24, -0.2], [0.1, -0.24, 0.2]]),
    'armorLight',
    xf(0.665, 0.05, 0, 0, 0, -8 * DEG),
  );
  b.addPair(() => cbox(0.03, 0.06, 0.44, 0.008), 'orange', xf(0.765, 0.1, 0, 0, 0, -8 * DEG));
  b.addPair(() => cbox(0.12, 0.1, 0.2, 0.02), 'joint', xf(0.6, 0.17, 0));
  return b.build();
}

const FOOT_TOE = 0.75; // sole length ahead of / behind the ankle (ground contact while the foot rolls)
const FOOT_HEEL = 0.48;

/** Thigh, bone space: origin at the hip, bone along -Y, -Z front, +X outer side (right leg). */
function buildThigh(): THREE.BufferGeometry {
  const b = new Builder();
  const L = BIPED.l1;
  b.add(sph(12, 8), 'joint', xf(0, 0, 0, 0, 0, 0, 0.21, 0.21, 0.21));
  b.add(cbox(0.33, 0.5, 0.4, 0.05), 'armorDark', xf(0, -0.35, 0.02));
  b.add(
    hull([
      [-0.2, -0.05, -0.31], [0.2, -0.05, -0.31], [-0.17, -0.55, -0.28], [0.17, -0.55, -0.28],
      [-0.2, -0.02, -0.1], [0.2, -0.02, -0.1], [-0.17, -0.6, -0.1], [0.17, -0.6, -0.1],
    ]),
    'armorLight',
  );
  b.add(cbox(0.09, 0.46, 0.38, 0.025), 'armorLight', xf(0.19, -0.33, 0.02));
  b.add(cbox(0.095, 0.07, 0.385, 0.008), 'orange', xf(0.19, -0.18, 0.02));
  b.add(cyl(0.04, 0.04, 0.44, 6), 'steel', xf(0, -0.36, 0.23));
  b.add(cyl(0.16, 0.16, 0.44, 12), 'joint', xf(0, -L, 0, 0, 0, 90 * DEG));
  b.add(cyl(0.08, 0.08, 0.47, 10), 'steel', xf(0, -L, 0, 0, 0, 90 * DEG));
  return b.build();
}

/** Shin, bone space: origin at the knee, bone along -Y to the ankle. */
function buildShin(): THREE.BufferGeometry {
  const b = new Builder();
  const L = BIPED.l2;
  // knee cap
  b.add(
    hull([
      [-0.17, 0.2, -0.16], [0.17, 0.2, -0.16], [-0.21, -0.02, -0.32], [0.21, -0.02, -0.32], [-0.18, -0.28, -0.27], [0.18, -0.28, -0.27],
      [-0.17, 0.12, -0.05], [0.17, 0.12, -0.05], [-0.18, -0.28, -0.1], [0.18, -0.28, -0.1],
    ]),
    'armorLight',
  );
  b.add(cbox(0.36, 0.055, 0.03, 0.008), 'orange', xf(0, 0.07, -0.262, -36 * DEG));
  // shin core flaring towards the boot
  b.add(taper(0.46, 0.54, 0.3, 0.34, 0.66), 'armorDark', xf(0, -L + 0.02, 0.03));
  // greave
  b.add(
    hull([
      [-0.15, -0.24, -0.24], [0.15, -0.24, -0.24], [-0.25, -0.74, -0.33], [0.25, -0.74, -0.33],
      [-0.15, -0.24, -0.1], [0.15, -0.24, -0.1], [-0.25, -0.77, -0.12], [0.25, -0.77, -0.12],
    ]),
    'armorLight',
  );
  b.add(cbox(0.16, 0.26, 0.03, 0.008), 'armorDark', xf(0, -0.52, -0.3, 10.2 * DEG));
  // calf vernier
  b.add(cbox(0.3, 0.4, 0.22, 0.035), 'armorLight', xf(0, -0.38, 0.25));
  b.add(cbox(0.305, 0.05, 0.225, 0.008), 'armorDark', xf(0, -0.28, 0.25));
  addNozzle(b, [0, -0.55, 0.29], [0, -0.9, 0.44], 0.09, 0.12, 10);
  // ankle
  b.add(cyl(0.14, 0.14, 0.5, 10), 'joint', xf(0, -L, 0, 0, 0, 90 * DEG));
  b.add(cyl(0.07, 0.07, 0.53, 8), 'steel', xf(0, -L, 0, 0, 0, 90 * DEG));
  return b.build();
}

/** Foot, origin at the ankle, sole at y = -ankleY, toe towards -Z. */
function buildFoot(): THREE.BufferGeometry {
  const b = new Builder();
  const s = -BIPED.ankleY;
  b.add(hull([[-0.27, s, -0.7], [0.27, s, -0.7], [-0.28, s, -0.1], [0.28, s, -0.1], [-0.17, s + 0.14, -0.67], [0.17, s + 0.14, -0.67], [-0.22, 0.02, -0.14], [0.22, 0.02, -0.14]]), 'armorLight');
  b.add(hull([[-0.25, s, -0.14], [0.25, s, -0.14], [-0.22, s, 0.4], [0.22, s, 0.4], [-0.21, 0.05, -0.14], [0.21, 0.05, -0.14], [-0.17, -0.07, 0.36], [0.17, -0.07, 0.36]]), 'armorDark');
  b.add(cbox(0.57, 0.1, 0.08, 0.015), 'joint', xf(0, s + 0.055, -0.705));
  b.add(cbox(0.36, 0.03, 0.13, 0.008), 'orange', xf(0, s + 0.205, -0.5, 16.5 * DEG));
  b.add(cbox(0.26, 0.16, 0.1, 0.02), 'joint', xf(0, s + 0.09, 0.42));
  b.add(cbox(0.58, 0.04, 0.56, 0.01), 'black', xf(0, s + 0.02, -0.38));
  b.add(cbox(0.5, 0.04, 0.44, 0.01), 'black', xf(0, s + 0.02, 0.17));
  return b.build();
}

const QUAD = {
  // pelvis-local hip joints and model-space rest ankles for the right-hand legs (front, rear).
  // The front pair splays wide and the rear pair trails narrow so that all four legs stay visible from the
  // chase camera behind the mech.
  hipF: [0.5, -0.2, -0.3] as const,
  hipR: [0.3, -0.2, 0.26] as const,
  restF: [1.07, 0.2, -0.72] as const,
  restR: [0.52, 0.2, 0.94] as const,
  l1: 0.7,
  l2: 1.5,
  ankleY: 0.2,
  cycle: 3.0,
};

function buildPelvisQuad(): THREE.BufferGeometry {
  const b = new Builder();
  buildPelvisCore(b);
  b.add(cyl(0.54, 0.68, 0.28, 8), 'armorDark', xf(0, -0.2, 0.04, 0, 22.5 * DEG));
  b.add(cyl(0.46, 0.56, 0.06, 8), 'armorLight', xf(0, -0.04, 0.04, 0, 22.5 * DEG));
  b.add(cyl(0.3, 0.46, 0.14, 8), 'joint', xf(0, -0.4, 0.04, 0, 22.5 * DEG));
  for (const sx of [-1, 1]) {
    b.add(sph(12, 8), 'gunmetal', xf(sx * QUAD.hipF[0], QUAD.hipF[1], QUAD.hipF[2], 0, 0, 0, 0.23, 0.23, 0.23));
    b.add(sph(12, 8), 'gunmetal', xf(sx * QUAD.hipR[0], QUAD.hipR[1], QUAD.hipR[2], 0, 0, 0, 0.23, 0.23, 0.23));
  }
  b.add(cbox(0.5, 0.06, 0.03, 0.008), 'orange', xf(0, -0.2, 0.67));
  return b.build();
}

/** Quadruped upper leg, bone space: origin at the hip, bone along -Y, +Z = upper side, X = hinge axis. */
function buildQuadUpper(): THREE.BufferGeometry {
  const b = new Builder();
  const L = QUAD.l1;
  b.add(cyl(0.19, 0.19, 0.36, 10), 'joint', xf(0, 0, 0, 0, 0, 90 * DEG));
  b.add(cbox(0.3, L - 0.14, 0.28, 0.05), 'armorDark', xf(0, -L / 2 - 0.01, 0));
  b.add(
    hull([
      [-0.2, -0.08, 0.25], [0.2, -0.08, 0.25], [-0.17, -L + 0.1, 0.22], [0.17, -L + 0.1, 0.22],
      [-0.2, -0.03, 0.08], [0.2, -0.03, 0.08], [-0.17, -L + 0.05, 0.08], [0.17, -L + 0.05, 0.08],
    ]),
    'armorLight',
  );
  b.add(cbox(0.36, 0.08, 0.03, 0.008), 'orange', xf(0, -0.27, 0.242, -3.3 * DEG));
  b.add(cyl(0.035, 0.035, L - 0.3, 6), 'steel', xf(0, -L / 2, -0.18));
  b.add(cyl(0.2, 0.2, 0.46, 12), 'joint', xf(0, -L, 0, 0, 0, 90 * DEG));
  b.add(cyl(0.09, 0.09, 0.49, 10), 'steel', xf(0, -L, 0, 0, 0, 90 * DEG));
  return b.build();
}

/** Quadruped lower leg, bone space: origin at the knee, bone along -Y to the ankle, +Z = outer side. */
function buildQuadLower(): THREE.BufferGeometry {
  const b = new Builder();
  const L = QUAD.l2;
  // knee shield
  b.add(
    hull([
      [-0.21, 0.3, 0.1], [0.21, 0.3, 0.1], [-0.25, 0.03, 0.33], [0.25, 0.03, 0.33], [-0.2, -0.38, 0.26], [0.2, -0.38, 0.26],
      [-0.21, 0.24, -0.06], [0.21, 0.24, -0.06], [-0.2, -0.38, 0.06], [0.2, -0.38, 0.06],
    ]),
    'armorLight',
  );
  b.add(cbox(0.44, 0.08, 0.03, 0.008), 'orange', xf(0, 0.14, 0.243, 40.4 * DEG));
  // pillar
  b.add(taper(0.26, 0.28, 0.38, 0.42, 1.3), 'armorDark', xf(0, -L + 0.08, 0));
  b.add(
    hull([
      [-0.18, -0.4, 0.25], [0.18, -0.4, 0.25], [-0.12, -1.32, 0.18], [0.12, -1.32, 0.18],
      [-0.18, -0.4, 0.08], [0.18, -0.4, 0.08], [-0.12, -1.34, 0.06], [0.12, -1.34, 0.06],
    ]),
    'armorLight',
  );
  b.add(cbox(0.1, 0.5, 0.03, 0.008), 'armorDark', xf(0, -0.9, 0.228, 4.4 * DEG));
  b.add(cbox(0.2, 0.46, 0.05, 0.015), 'armorLight', xf(0, -1.02, -0.155, -3 * DEG));
  b.add(cbox(0.24, 0.06, 0.03, 0.008), 'orange', xf(0, -0.74, -0.185, -3 * DEG));
  // inner vernier
  b.add(cbox(0.26, 0.32, 0.16, 0.03), 'armorLight', xf(0, -0.5, -0.24));
  addNozzle(b, [0, -0.62, -0.25], [0, -1, -0.1], 0.075, 0.1, 10);
  b.add(sph(10, 8), 'steel', xf(0, -L, 0, 0, 0, 0, 0.14, 0.14, 0.14));
  return b.build();
}

/** Quadruped foot pad, origin at the ankle, sole at y = -ankleY, claws towards -Z. */
function buildQuadFoot(): THREE.BufferGeometry {
  const b = new Builder();
  const s = -QUAD.ankleY;
  b.add(cyl(0.19, 0.29, 0.16, 8), 'armorLight', xf(0, s + 0.12, 0, 0, 22.5 * DEG));
  b.add(cyl(0.31, 0.31, 0.04, 8), 'black', xf(0, s + 0.02, 0, 0, 22.5 * DEG));
  const claw = (): THREE.BufferGeometry => hull([[-0.08, s, -0.18], [0.08, s, -0.18], [-0.055, s, -0.4], [0.055, s, -0.4], [-0.07, s + 0.14, -0.18], [0.07, s + 0.14, -0.18], [0, s + 0.06, -0.38]]);
  for (const a of [-52, 0, 52]) b.add(claw(), 'armorDark', xf(0, 0, 0, 0, a * DEG));
  b.add(cbox(0.16, 0.11, 0.1, 0.02), 'joint', xf(0, s + 0.075, 0.26));
  return b.build();
}

// ───────────────────────────── thruster flames / muzzle flash ─────────────────────────────
interface FlameDef {
  pos: readonly number[];
  dir: readonly number[];
  radius: number;
  length: number;
}

const FLAME_VERT = /* glsl */ `
attribute vec3 aBase;
attribute vec3 aAxis;
uniform float uTime;
uniform float uLen;
uniform float uRad;
uniform float uSeed;
varying vec2 vUv;
varying float vFacing;
void main() {
  float t = uv.y;
  float along = dot(position, aAxis);
  vec3 radial = position - along * aAxis;
  float ph = uSeed + aBase.x * 7.0 + aBase.y * 3.0;
  float wob = 1.0 + 0.11 * sin(uTime * 61.0 + t * 13.0 + ph) * t;
  float lenW = 1.0 + 0.07 * sin(uTime * 37.0 + ph * 2.3);
  vec3 p = aBase + radial * (uRad * wob) + aAxis * (along * uLen * lenW);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vec3 n = normalize(normalMatrix * normal);
  vFacing = abs(dot(n, normalize(-mv.xyz)));
  vUv = uv;
  gl_Position = projectionMatrix * mv;
}`;

const FLAME_FRAG = /* glsl */ `
uniform vec3 uColA;
uniform vec3 uColB;
uniform float uIntensity;
varying vec2 vUv;
varying float vFacing;
void main() {
  float t = vUv.y;
  float shell = vUv.x;
  float edge = pow(vFacing, mix(2.4, 1.3, shell));
  float fade = pow(1.0 - t, mix(1.9, 1.1, shell)) * smoothstep(0.0, 0.06, t);
  vec3 col = mix(uColB, uColA, shell);
  col = mix(col, uColA, (1.0 - t) * 0.3);
  float a = edge * fade * uIntensity * mix(0.5, 1.0, shell);
  gl_FragColor = vec4(col * a, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

function buildFlameGeometry(defs: readonly FlameDef[]): THREE.BufferGeometry {
  const NR = 10;
  const NL = 8;
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const base: number[] = [];
  const axis: number[] = [];
  const q = new THREE.Quaternion();
  const zAxis = new THREE.Vector3(0, 0, 1);
  const d = new THREE.Vector3();
  const v = new THREE.Vector3();
  const n = new THREE.Vector3();
  const prof = (t: number): number => (t < 0.1 ? 0.72 + 0.28 * (t / 0.1) : Math.pow(Math.max(0, 1 - (t - 0.1) / 0.9), 0.8));
  for (const def of defs) {
    d.set(def.dir[0], def.dir[1], def.dir[2]).normalize();
    q.setFromUnitVectors(zAxis, d);
    for (let shell = 0; shell < 2; shell++) {
      const rs = def.radius * (shell ? 0.5 : 1);
      const ls = def.length * (shell ? 0.68 : 1);
      const push = (i: number, j: number): void => {
        const t = i / NL;
        const a = (j / NR) * TAU;
        const r = prof(t);
        v.set(Math.cos(a) * r * rs, Math.sin(a) * r * rs, t * ls).applyQuaternion(q);
        n.set(Math.cos(a), Math.sin(a), 0.25).normalize().applyQuaternion(q);
        pos.push(v.x, v.y, v.z);
        nor.push(n.x, n.y, n.z);
        uv.push(shell, t);
        base.push(def.pos[0], def.pos[1], def.pos[2]);
        axis.push(d.x, d.y, d.z);
      };
      for (let i = 0; i < NL; i++)
        for (let j = 0; j < NR; j++) {
          push(i, j);
          push(i, j + 1);
          push(i + 1, j);
          if (i + 1 < NL) {
            push(i + 1, j);
            push(i, j + 1);
            push(i + 1, j + 1);
          }
        }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aBase', new THREE.Float32BufferAttribute(base, 3));
  g.setAttribute('aAxis', new THREE.Float32BufferAttribute(axis, 3));
  return g;
}

const THRUST_CORE = new THREE.Color(0.82, 0.96, 1.0);
const THRUST_OUTER = new THREE.Color(0.1, 0.5, 1.0);

/** One draw call worth of flames that share a level (length / width / brightness). */
class FlameSet {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  level = 0;
  constructor(defs: readonly FlameDef[], seed: number, parent: THREE.Object3D) {
    this.material = new THREE.ShaderMaterial({
      vertexShader: FLAME_VERT,
      fragmentShader: FLAME_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uLen: { value: 1 },
        uRad: { value: 1 },
        uSeed: { value: seed },
        uIntensity: { value: 1 },
        uColA: { value: THRUST_CORE.clone() },
        uColB: { value: THRUST_OUTER.clone() },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(buildFlameGeometry(defs), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = 5;
    parent.add(this.mesh);
  }
  /** Moves the level towards `target` (fast attack, slower release) and updates the uniforms. */
  drive(target: number, dt: number, time: number): void {
    const rate = target > this.level ? 38 : 11;
    this.level += (target - this.level) * (1 - Math.exp(-rate * dt));
    this.apply(this.level, time);
  }
  apply(level: number, time: number): void {
    const on = level > 0.02;
    this.mesh.visible = on;
    if (!on) return;
    const u = this.material.uniforms;
    u.uTime.value = time;
    u.uLen.value = 0.4 + 0.7 * level;
    u.uRad.value = 0.68 + 0.32 * Math.min(level, 2);
    u.uIntensity.value = 0.5 + 0.5 * Math.min(level, 2);
  }
  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh.removeFromParent();
  }
}

// ───────────────────────────── animation helpers ─────────────────────────────
/** Critically damped spring (implicit integration, stable for any dt). */
class Spring {
  x: number;
  v = 0;
  constructor(x = 0) {
    this.x = x;
  }
  step(target: number, omega: number, dt: number): number {
    const f = 1 + 2 * dt * omega;
    const oo = omega * omega;
    const hoo = dt * oo;
    const hhoo = dt * hoo;
    const inv = 1 / (f + hhoo);
    const x = (f * this.x + dt * this.v + hhoo * target) * inv;
    const v = (this.v + hoo * (target - this.x)) * inv;
    this.x = x;
    this.v = v;
    return x;
  }
  /** Back to rest at `x` (no velocity). */
  reset(x = 0): void {
    this.x = x;
    this.v = 0;
  }
}

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
const fin = (x: number, fallback = 0): number => (Number.isFinite(x) ? x : fallback);
const frac = (x: number): number => x - Math.floor(x);

const _d = new THREE.Vector3();
const _p = new THREE.Vector3();
const _bx = new THREE.Vector3();
const _by = new THREE.Vector3();
const _bz = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const _n = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _t = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _hint = new THREE.Vector3();
const _mTorso = new THREE.Matrix4();
const _mPelvis = new THREE.Matrix4();
const _wx = new THREE.Vector3();
const _wy = new THREE.Vector3();
const _wz = new THREE.Vector3();
const _UP = new THREE.Vector3(0, 1, 0);
const _DOWN = new THREE.Vector3(0, -1, 0);
const _q = new THREE.Quaternion();

/** Two-bone IK: joint position for a chain a → mid → t with segment lengths l1, l2 bending towards `pole`. */
function solveTwoBone(a: THREE.Vector3, t: THREE.Vector3, l1: number, l2: number, pole: THREE.Vector3, outMid: THREE.Vector3): void {
  _d.subVectors(t, a);
  let dist = _d.length();
  if (dist < 1e-5) {
    _d.set(0, -1, 0);
    dist = 1e-5;
  } else {
    _d.multiplyScalar(1 / dist);
  }
  const c = clamp(dist, Math.abs(l1 - l2) + 1e-3, (l1 + l2) * 0.9995);
  const a1 = (l1 * l1 - l2 * l2 + c * c) / (2 * c);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a1 * a1));
  _p.copy(pole).addScaledVector(_d, -pole.dot(_d));
  if (_p.lengthSq() < 1e-8) {
    _p.set(1, 0, 0).addScaledVector(_d, -_d.x);
    if (_p.lengthSq() < 1e-8) _p.set(0, 0, 1).addScaledVector(_d, -_d.z);
  }
  _p.normalize();
  outMid.copy(a).addScaledVector(_d, a1).addScaledVector(_p, h);
}

/** Places a bone mesh (modelled along -Y) at `from`, pointing at `to`, with its local +X as close to `xHint` as possible. */
function orientBone(obj: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3, xHint: THREE.Vector3): void {
  _by.subVectors(from, to);
  if (_by.lengthSq() < 1e-10) _by.set(0, 1, 0);
  _by.normalize();
  _bx.copy(xHint).addScaledVector(_by, -xHint.dot(_by));
  if (_bx.lengthSq() < 1e-8) {
    _bx.set(1, 0, 0).addScaledVector(_by, -_by.x);
    if (_bx.lengthSq() < 1e-8) _bx.set(0, 0, 1).addScaledVector(_by, -_by.z);
  }
  _bx.normalize();
  _bz.crossVectors(_bx, _by);
  _m4.makeBasis(_bx, _by, _bz);
  obj.quaternion.setFromRotationMatrix(_m4);
  obj.position.copy(from);
}

interface Leg {
  upper: THREE.Mesh;
  lower: THREE.Mesh;
  foot: THREE.Mesh;
  flame: FlameSet; // vectored vernier jet, child of the rig root (model space)
  nozzle: THREE.Vector3; // nozzle exit in the lower leg's bone space
  hip: THREE.Vector3; // pelvis-local
  rest: THREE.Vector3; // model space ankle
  side: number; // -1 left, +1 right
  fore: number; // quadruped: -1 front, +1 rear; biped: 0
  outX: number; // unit horizontal splay direction (quadruped)
  outZ: number;
  phase: number; // gait phase offset
}
interface LegRig {
  id: LegsId;
  root: THREE.Group; // model space, child of the main group
  pelvisMesh: THREE.Mesh; // child of the pelvis node
  legs: Leg[];
  l1: number;
  l2: number;
  cycle: number;
}

const WEAPON_LIST: readonly Weapon[] = ['machinegun', 'beam', 'missile'];
const FLASH_TIME: Record<Weapon, number> = { machinegun: 0.05, beam: 0.1, missile: 0.2 };
const FLASH_CORE: Record<Weapon, THREE.Color> = {
  machinegun: new THREE.Color(1.0, 0.95, 0.72),
  beam: new THREE.Color(0.85, 1.0, 1.0),
  missile: new THREE.Color(1.0, 0.9, 0.72),
};
const FLASH_OUTER: Record<Weapon, THREE.Color> = {
  machinegun: new THREE.Color(1.0, 0.6, 0.12),
  beam: new THREE.Color(0.15, 0.8, 1.0),
  missile: new THREE.Color(1.0, 0.42, 0.08),
};
const BASE_EMISSIVE = 1.5;

// ───────────────────────────── the model ─────────────────────────────
export class MechModel {
  /** Origin at the FEET centre on the ground, model faces -Z, +Y up. */
  readonly group: THREE.Group;

  private legsId: LegsId;
  private readonly material: THREE.MeshStandardMaterial;
  private readonly textures: THREE.Texture[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly flames: FlameSet[] = [];

  private readonly pelvis = new THREE.Object3D();
  private readonly torso = new THREE.Object3D();
  private readonly head = new THREE.Object3D();
  private readonly earL: THREE.Mesh;
  private readonly earR: THREE.Mesh;
  private readonly armLU: THREE.Mesh;
  private readonly armLF: THREE.Mesh;
  private readonly armRU: THREE.Mesh;
  private readonly armRF: THREE.Mesh;
  private readonly weaponPivot = new THREE.Object3D();
  private readonly weapons: Record<Weapon, THREE.Mesh>;
  private readonly stowL = new THREE.Object3D();
  private readonly stowR = new THREE.Object3D();
  private activeWeapon: Weapon | null = null;

  private readonly rigs: Partial<Record<LegsId, LegRig>> = {};
  private rig!: LegRig;

  private readonly fMain: FlameSet;
  private readonly fSideL: FlameSet;
  private readonly fSideR: FlameSet;
  private readonly fFront: FlameSet;
  private readonly fDown: FlameSet;
  private readonly fFlash: FlameSet;
  private readonly fBack: FlameSet;

  // animation state
  private phase = 0;
  private dirX = 0;
  private dirZ = -1;
  private wasGrounded = true;
  private airTime = 0;
  private flashT = 0;
  private flashWeapon: Weapon = 'machinegun';
  private recoil = 0;
  private legFlameLevel = 0;
  private readonly sWalk = new Spring();
  private readonly sGlide = new Spring();
  private readonly sAir = new Spring();
  private readonly sFall = new Spring();
  private readonly sBrake = new Spring();
  private readonly sBoost = new Spring();
  private readonly sLeanF = new Spring();
  private readonly sLeanR = new Spring();
  private readonly sSquash = new Spring();
  private readonly sEar = new Spring();
  private readonly sHeadYaw = new Spring();
  private readonly sHeadPitch = new Spring();

  constructor(legs: LegsId) {
    this.group = new THREE.Group();
    this.group.name = 'MechModel';
    this.legsId = legs;

    const tex = makePaletteTextures();
    this.textures.push(tex.orm, tex.emissive);
    this.material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 1,
      metalness: 1,
      roughnessMap: tex.orm,
      metalnessMap: tex.orm,
      emissive: 0xffffff,
      emissiveMap: tex.emissive,
      emissiveIntensity: BASE_EMISSIVE,
    });
    // The body marks its pixels in the stencil buffer: Effects draws the player's own tracers and missile exhaust
    // once more, dimmed, where this mech hides them from the chase camera (see OWN_MECH_STENCIL in effects.ts).
    // Nothing else reads the mark; without a stencil buffer these settings do nothing.
    this.material.stencilWrite = true;
    this.material.stencilFunc = THREE.AlwaysStencilFunc;
    this.material.stencilRef = OWN_MECH_STENCIL;
    this.material.stencilZPass = THREE.ReplaceStencilOp;

    // ── hierarchy ──
    this.pelvis.position.set(0, HIP_Y, 0);
    this.group.add(this.pelvis);
    this.torso.position.copy(WAIST);
    this.pelvis.add(this.torso);
    this.torso.add(this.mesh(buildTorso(), 'torso'));
    this.head.position.copy(NECK);
    this.head.rotation.order = 'YXZ';
    this.torso.add(this.head);
    this.head.add(this.mesh(buildHead(), 'head'));

    const earGeo = buildEar();
    this.earR = this.mesh(earGeo, 'earR');
    this.earL = this.mesh(mirrorX(earGeo), 'earL');
    for (const [ear, s] of [[this.earR, 1], [this.earL, -1]] as const) {
      ear.position.set(0.5 * s, HEAD_CY + 0.12, 0.06);
      ear.rotation.order = 'ZYX';
      this.head.add(ear);
    }

    const upR = buildUpperArm(false);
    const upL = this.own(mirrorX(buildUpperArm(true)));
    const foR = buildForearm(false);
    const foL = this.own(mirrorX(buildForearm(true)));
    this.armRU = this.mesh(upR, 'armRU');
    this.armRF = this.mesh(foR, 'armRF');
    this.armLU = new THREE.Mesh(upL, this.material);
    this.armLF = new THREE.Mesh(foL, this.material);
    this.group.add(this.armRU, this.armRF); // solved in model space against the weapon
    this.torso.add(this.armLU, this.armLF); // solved in torso space

    // ── weapons ──
    this.weaponPivot.position.set(MECH_MUZZLE_LOCAL.x, MECH_MUZZLE_LOCAL.y, MECH_MUZZLE_LOCAL.z);
    this.group.add(this.weaponPivot);
    this.weapons = {
      machinegun: this.mesh(buildMachineGun(), 'machinegun'),
      beam: this.mesh(buildBeamRifle(), 'beam'),
      missile: this.mesh(buildMissilePod(), 'missile'),
    };
    // stowed: muzzle down, barrel axis vertical, top of the weapon facing backwards
    for (const [slot, s] of [[this.stowR, 1], [this.stowL, -1]] as const) {
      slot.position.set(0.6 * s, 0.1, 0.63);
      _m4.makeBasis(_bx.set(-1, 0, 0), _by.set(0, 0, 1), _bz.set(0, 1, 0));
      slot.quaternion.setFromRotationMatrix(_m4);
      this.torso.add(slot);
    }

    // ── flames ──
    const mainDir = [0, -0.5, 0.866];
    this.fMain = this.flame([
      { pos: [0.25, 0.27, 1.02], dir: mainDir, radius: 0.17, length: 1.25 },
      { pos: [-0.25, 0.27, 1.02], dir: mainDir, radius: 0.17, length: 1.25 },
    ], this.torso);
    this.fSideL = this.flame([{ pos: [-0.6, 0.185, 0.087], dir: [-0.94, -0.34, 0.06], radius: 0.14, length: 1.2 }], this.torso);
    this.fSideR = this.flame([{ pos: [0.6, 0.185, 0.087], dir: [0.94, -0.34, 0.06], radius: 0.14, length: 1.2 }], this.torso);
    this.fFront = this.flame([
      { pos: [0.375, 0.065, -0.355], dir: RETRO_DIR, radius: 0.13, length: 1.2 },
      { pos: [-0.375, 0.065, -0.355], dir: [-RETRO_DIR[0], RETRO_DIR[1], RETRO_DIR[2]], radius: 0.13, length: 1.2 },
    ], this.pelvis);
    this.fDown = this.flame([
      { pos: [0.25, 0.16, 0.63], dir: [0, -1, 0.12], radius: 0.1, length: 0.9 },
      { pos: [-0.25, 0.16, 0.63], dir: [0, -1, 0.12], radius: 0.1, length: 0.9 },
    ], this.torso);
    this.fFlash = this.flame([
      { pos: [0, 0, -0.01], dir: [0, 0, -1], radius: 0.075, length: 0.5 },
      { pos: [0, 0, 0.0], dir: [1, 1, -0.7], radius: 0.04, length: 0.24 },
      { pos: [0, 0, 0.0], dir: [-1, 1, -0.7], radius: 0.04, length: 0.24 },
      { pos: [0, 0, 0.0], dir: [1, -1, -0.7], radius: 0.04, length: 0.24 },
      { pos: [0, 0, 0.0], dir: [-1, -1, -0.7], radius: 0.04, length: 0.24 },
    ], this.weaponPivot);
    this.fBack = this.flame([{ pos: [0, 0, 0.83], dir: [0, 0, 1], radius: 0.16, length: 0.8 }], this.weaponPivot);

    this.setLegs(legs);
    this.setWeapon('machinegun');
    this.update(MechModel.IDLE);
  }

  private static readonly IDLE: MechAnimInput = {
    dt: 0,
    time: 0,
    grounded: true,
    horizontalSpeed: 0,
    moveDirLocal: { x: 0, z: 0 },
    horizontalMode: 'walk',
    verticalMode: 'grounded',
    braking: false,
    weapon: 'machinegun',
    aimDirLocal: { x: 0, y: 0, z: -1 },
    fired: null,
  };

  private own<T extends THREE.BufferGeometry>(g: T): T {
    if (!this.geometries.includes(g)) this.geometries.push(g);
    return g;
  }
  private mesh(g: THREE.BufferGeometry, name: string): THREE.Mesh {
    const m = new THREE.Mesh(this.own(g), this.material);
    m.name = name;
    return m;
  }
  private flame(defs: readonly FlameDef[], parent: THREE.Object3D): FlameSet {
    const f = new FlameSet(defs, this.flames.length * 1.7 + 0.3, parent);
    this.flames.push(f);
    return f;
  }

  /** Current leg assembly. */
  get legs(): LegsId {
    return this.legsId;
  }

  /** Swaps the leg assembly: 'biped' (2 legs) ↔ 'quadruped' (4 legs). */
  setLegs(legs: LegsId): void {
    if (this.rig && this.rig.id === legs) return;
    if (this.rig) {
      this.group.remove(this.rig.root);
      this.pelvis.remove(this.rig.pelvisMesh);
      for (const l of this.rig.legs) l.flame.mesh.visible = false;
    }
    let rig = this.rigs[legs];
    if (!rig) {
      rig = legs === 'biped' ? this.buildBipedRig() : this.buildQuadRig();
      this.rigs[legs] = rig;
    }
    this.rig = rig;
    this.legsId = legs;
    this.group.add(rig.root);
    this.pelvis.add(rig.pelvisMesh);
    this.phase = 0;
    this.poseLegs(0);
  }

  private buildBipedRig(): LegRig {
    const root = new THREE.Group();
    root.name = 'legs-biped';
    const thighR = this.own(buildThigh());
    const thighL = this.own(mirrorX(thighR));
    const shin = this.own(buildShin());
    const foot = this.own(buildFoot());
    const legs: Leg[] = [];
    for (const s of [-1, 1]) {
      const upper = new THREE.Mesh(s > 0 ? thighR : thighL, this.material);
      const lower = new THREE.Mesh(shin, this.material);
      const ft = new THREE.Mesh(foot, this.material);
      ft.rotation.order = 'YXZ';
      root.add(upper, lower, ft);
      const flame = this.flame([{ pos: [0, 0, 0], dir: [0, -1, 0], radius: 0.095, length: 0.7 }], root);
      legs.push({
        upper,
        lower,
        foot: ft,
        flame,
        nozzle: new THREE.Vector3(0, -0.645, 0.335),
        hip: new THREE.Vector3(BIPED.hip[0] * s, BIPED.hip[1], BIPED.hip[2]),
        rest: new THREE.Vector3(BIPED.rest[0] * s, BIPED.rest[1], BIPED.rest[2]),
        side: s,
        fore: 0,
        outX: s,
        outZ: 0,
        phase: s < 0 ? 0 : 0.5,
      });
    }
    return { id: 'biped', root, pelvisMesh: this.mesh(buildPelvisBiped(), 'pelvis-biped'), legs, l1: BIPED.l1, l2: BIPED.l2, cycle: BIPED.cycle };
  }

  private buildQuadRig(): LegRig {
    const root = new THREE.Group();
    root.name = 'legs-quadruped';
    const upperG = this.own(buildQuadUpper());
    const lowerG = this.own(buildQuadLower());
    const footG = this.own(buildQuadFoot());
    const legs: Leg[] = [];
    for (const fore of [-1, 1])
      for (const s of [-1, 1]) {
        const hipDef = fore < 0 ? QUAD.hipF : QUAD.hipR;
        const restDef = fore < 0 ? QUAD.restF : QUAD.restR;
        const upper = new THREE.Mesh(upperG, this.material);
        const lower = new THREE.Mesh(lowerG, this.material);
        const ft = new THREE.Mesh(footG, this.material);
        root.add(upper, lower, ft);
        const flame = this.flame([{ pos: [0, 0, 0], dir: [0, -1, 0], radius: 0.08, length: 0.6 }], root);
        const hip = new THREE.Vector3(hipDef[0] * s, hipDef[1], hipDef[2]);
        const rest = new THREE.Vector3(restDef[0] * s, restDef[1], restDef[2]);
        const ox = rest.x - hip.x;
        const oz = rest.z - hip.z;
        const ol = Math.hypot(ox, oz);
        legs.push({
          upper,
          lower,
          foot: ft,
          flame,
          nozzle: new THREE.Vector3(0, -0.71, -0.26),
          hip,
          rest,
          side: s,
          fore,
          outX: ox / ol,
          outZ: oz / ol,
          // trot: diagonal pairs move together
          phase: s * fore < 0 ? 0 : 0.5,
        });
      }
    return { id: 'quadruped', root, pelvisMesh: this.mesh(buildPelvisQuad(), 'pelvis-quad'), legs, l1: QUAD.l1, l2: QUAD.l2, cycle: QUAD.cycle };
  }

  private setWeapon(w: Weapon): void {
    if (this.activeWeapon === w || !WEAPON_LIST.includes(w)) return;
    this.activeWeapon = w;
    let slot = 0;
    for (const id of WEAPON_LIST) {
      const m = this.weapons[id];
      if (id === w) this.weaponPivot.add(m);
      else (slot++ === 0 ? this.stowL : this.stowR).add(m);
    }
  }

  /**
   * Snaps every smoothed animation value back to rest: pose weights (walk / glide / air / fall / brake /
   * boost), lean, gait phase, landing squash, ear and head springs, recoil, muzzle flash and all thruster
   * flames. Call it when the mech is put somewhere new at rest (a new sortie, the hangar): nothing of the
   * previous motion may be seen decaying there — with a frame time of 0 (a frozen frame) it would not even
   * decay. The weapon and the leg type stay as they are; the pose itself is applied by the next update().
   */
  reset(): void {
    this.sWalk.reset();
    this.sGlide.reset();
    this.sAir.reset();
    this.sFall.reset();
    this.sBrake.reset();
    this.sBoost.reset();
    this.sLeanF.reset();
    this.sLeanR.reset();
    this.sSquash.reset();
    this.sEar.reset();
    this.sHeadYaw.reset();
    this.sHeadPitch.reset();
    this.phase = 0;
    this.dirX = 0;
    this.dirZ = -1;
    this.wasGrounded = true;
    this.airTime = 0;
    this.flashT = 0;
    this.flashWeapon = 'machinegun';
    this.recoil = 0;
    this.legFlameLevel = 0;
    // (every flame set of the model, including the leg verniers of both leg rigs)
    for (const f of this.flames) {
      f.level = 0;
      f.mesh.visible = false;
    }
  }

  /** World position of the muzzle tip (the gameplay launch point). */
  getMuzzleWorld(out: THREE.Vector3): THREE.Vector3 {
    this.group.updateWorldMatrix(true, false);
    return out.set(MECH_MUZZLE_LOCAL.x, MECH_MUZZLE_LOCAL.y, MECH_MUZZLE_LOCAL.z).applyMatrix4(this.group.matrixWorld);
  }

  update(input: MechAnimInput): void {
    const dt = clamp(fin(input.dt), 0, 0.1);
    const time = fin(input.time);
    const speed = Math.max(0, fin(input.horizontalSpeed));
    const quad = this.legsId === 'quadruped';

    // movement direction in model axes (x right, z back); keep the last one while standing still
    const mdx = fin(input.moveDirLocal.x);
    const mdz = -fin(input.moveDirLocal.z);
    const ml = Math.hypot(mdx, mdz);
    const moving = ml > 1e-3 && speed > 0.2;
    if (ml > 1e-3) {
      this.dirX = mdx / ml;
      this.dirZ = mdz / ml;
    }
    const dx = this.dirX;
    const dz = this.dirZ;
    const fwd = moving ? -dz : 0;
    const right = moving ? dx : 0;

    const grounded = input.grounded;
    const qb = input.horizontalMode === 'quickboost';
    const glide = input.horizontalMode === 'glide';
    const walk = input.horizontalMode === 'walk';
    const flying = input.verticalMode === 'flying';
    const braking = input.braking;

    // ── pose weights ──
    const wWalk = this.sWalk.step(grounded && walk && !braking && moving ? clamp(speed / 3, 0, 1) : 0, 16, dt);
    const wGlide = this.sGlide.step(grounded && (glide || qb) ? 1 : 0, 13, dt);
    const wAir = this.sAir.step(grounded ? 0 : 1, 12, dt);
    const wFall = this.sFall.step(!grounded && input.verticalMode === 'falling' ? 1 : 0, 8, dt);
    const wBrake = this.sBrake.step(braking && grounded ? 1 : 0, 14, dt);
    const boost = this.sBoost.step(qb ? 1 : glide ? clamp((speed - 24) / 50, 0, 1) : 0, qb ? 30 : 9, dt);

    // gait phase: stride frequency proportional to the ground speed
    if (grounded && walk) this.phase = frac(this.phase + (dt * speed) / this.rig.cycle);

    // landing squash
    if (grounded && !this.wasGrounded) this.sSquash.v -= 3.5 + 4.5 * clamp(this.airTime / 0.7, 0, 1);
    this.airTime = grounded ? 0 : this.airTime + dt;
    this.wasGrounded = grounded;
    const squash = this.sSquash.step(0, 13, dt);

    // ── lean (radians, positive = into forward / right) ──
    let leanAmt = 0;
    if (qb) leanAmt = 0.27;
    else if (glide) leanAmt = (grounded ? 0.15 : 0.12) + 0.1 * boost;
    else if (!grounded) leanAmt = 0.09 * clamp(speed / 16, 0, 1);
    else leanAmt = 0.05 * clamp(speed / 10, 0, 1);
    let tLeanF = fwd * leanAmt;
    let tLeanR = right * leanAmt;
    if (braking) {
      const k = clamp(speed / 8, 0, 1);
      tLeanF = -fwd * 0.13 * k - 0.05;
      tLeanR = -right * 0.1 * k;
    }
    const leanF = this.sLeanF.step(tLeanF, qb ? 20 : 10, dt);
    const leanR = this.sLeanR.step(tLeanR, qb ? 20 : 10, dt);

    // ── pelvis / torso ──
    const bobAmp = quad ? 0.02 : 0.035;
    const bob = wWalk * ((quad ? 0.03 : 0.045) + bobAmp * Math.cos(this.phase * 4 * Math.PI));
    const breathe = Math.sin(time * 1.7) * 0.012 * (1 - wWalk) * (1 - wAir);
    this.pelvis.position.set(
      -leanR * 0.4 + (quad ? 0 : wWalk * 0.035 * Math.sin(this.phase * TAU)),
      HIP_Y + breathe - bob - wGlide * (quad ? 0.1 : 0.15) - wBrake * 0.08 + squash + wAir * 0.03,
      leanF * 0.4,
    );
    this.pelvis.rotation.set(-leanF * 0.45, 0, -leanR * 0.45);

    // recoil (never moves the muzzle: only the body, the elbow and a roll about the barrel axis)
    if (input.fired) {
      this.recoil = input.fired === 'missile' ? 1.6 : input.fired === 'beam' ? 0.8 : 1;
      this.flashT = FLASH_TIME[input.fired];
      this.flashWeapon = input.fired;
    }
    this.recoil *= Math.exp(-dt * 16);
    if (this.recoil < 1e-3) this.recoil = 0;
    const rc = this.recoil;

    // aim angles
    let ax = fin(input.aimDirLocal.x);
    let ay = fin(input.aimDirLocal.y);
    let az = fin(input.aimDirLocal.z, -1);
    const al = Math.hypot(ax, ay, az);
    if (al < 1e-6) {
      ax = 0;
      ay = 0;
      az = -1;
    } else {
      ax /= al;
      ay /= al;
      az /= al;
    }
    const aimYaw = Math.atan2(-ax, -az);
    const aimPitch = Math.asin(clamp(ay, -1, 1));

    const twist = clamp(aimYaw * 0.3, -0.2, 0.2) + wWalk * 0.04 * Math.sin(this.phase * TAU);
    this.torso.rotation.set(-leanF * 0.55 + rc * 0.014, twist, -leanR * 0.55 + Math.sin(time * 1.1) * 0.004);

    // head: stays level, glances along the aim direction
    const hy = this.sHeadYaw.step(clamp(aimYaw * 0.45, -0.45, 0.45) - twist, 14, dt);
    const hp = this.sHeadPitch.step(clamp(aimPitch * 0.3, -0.22, 0.3), 14, dt);
    this.head.rotation.set(hp + leanF * 0.8 - squash * 0.5, hy, leanR * 0.6);

    // ears: swept back by speed, flop on landing
    const ear = this.sEar.step(clamp(speed / 60, 0, 1) * 0.3 + boost * 0.12 + wFall * -0.1 - squash * 1.6, 15, dt);
    const twitch = Math.max(0, Math.sin(time * 0.9) - 0.96) * 5;
    this.earR.rotation.set(ear, -14 * DEG, -EAR_TILT - ear * 0.2);
    this.earL.rotation.set(ear + twitch * 0.2, 14 * DEG, EAR_TILT + ear * 0.2);

    // ── weapon: pivots about the muzzle, barrel axis = aim direction ──
    this.setWeapon(input.weapon);
    _wz.set(-ax, -ay, -az);
    _wx.crossVectors(_UP, _wz);
    if (_wx.lengthSq() < 1e-6) _wx.set(1, 0, 0);
    _wx.normalize();
    _wy.crossVectors(_wz, _wx);
    const roll = rc * 0.05 * Math.sin(time * 90);
    if (roll !== 0) {
      const cr = Math.cos(roll);
      const sr = Math.sin(roll);
      _a.copy(_wx).multiplyScalar(cr).addScaledVector(_wy, sr);
      _wy.multiplyScalar(cr).addScaledVector(_wx, -sr);
      _wx.copy(_a);
    }
    _m4.makeBasis(_wx, _wy, _wz);
    this.weaponPivot.quaternion.setFromRotationMatrix(_m4);

    // ── arms ──
    this.pelvis.updateMatrix();
    this.torso.updateMatrix();
    _mPelvis.copy(this.pelvis.matrix);
    _mTorso.multiplyMatrices(this.pelvis.matrix, this.torso.matrix);

    // right arm: shoulder (torso) → wrist socket on the weapon, in model space
    _a.copy(SHOULDER_R).applyMatrix4(_mTorso);
    _t.copy(GRIP).applyQuaternion(this.weaponPivot.quaternion).add(this.weaponPivot.position);
    _pole.set(0.28 + rc * 0.5, -0.85 + rc * 0.25, 0.6).transformDirection(_mTorso);
    solveTwoBone(_a, _t, ARM_L1, ARM_L2, _pole, _mid);
    _n.subVectors(_mid, _a).cross(_b.subVectors(_t, _mid));
    orientBone(this.armRU, _a, _mid, _n);
    orientBone(this.armRF, _mid, _t, _n);
    // telescoping forearm: always reaches the socket, even at extreme elevation
    this.armRF.scale.set(1, Math.max(0.6, _mid.distanceTo(_t) / ARM_L2), 1);

    // left arm (shield): rest pose in torso space with a little sway
    const sway = wWalk * 0.1 * Math.sin(this.phase * TAU + Math.PI) + wGlide * 0.06;
    _a.set(-SHOULDER_R.x, SHOULDER_R.y, SHOULDER_R.z);
    _t.set(-0.8 - wAir * 0.04, -0.2 + wGlide * 0.06 + Math.sin(time * 1.7 + 1) * 0.006, -0.16 + sway);
    _pole.set(-0.3, 0.1, 0.95);
    solveTwoBone(_a, _t, ARM_L1, ARM_L2, _pole, _mid);
    _n.subVectors(_mid, _a).cross(_b.subVectors(_t, _mid));
    orientBone(this.armLU, _a, _mid, _n);
    orientBone(this.armLF, _mid, _t, _n);

    // ── legs ──
    this.poseLegs(wAir, wWalk, wGlide, wFall, wBrake, boost, dx, dz, moving);

    // ── thrusters ──
    let tMain = 0;
    let tSideL = 0; // flame towards -x (pushes the mech to the right)
    let tSideR = 0;
    let tFront = 0;
    let tDown = 0;
    let tLeg = 0;
    if (qb) {
      tMain = 0.2 + 2.0 * Math.max(0, fwd);
      tSideL = 2.0 * Math.max(0, right);
      tSideR = 2.0 * Math.max(0, -right);
      tFront = 1.9 * Math.max(0, -fwd);
      tLeg = grounded ? 0.5 : 0;
    } else if (glide) {
      const base = 0.55 + 0.9 * clamp((speed - 24) / 50, 0, 1);
      tMain = base * (fwd >= 0 ? 0.6 + 0.4 * fwd : 0.6 + 0.3 * fwd);
      tSideL = base * 0.9 * Math.max(0, right);
      tSideR = base * 0.9 * Math.max(0, -right);
      tFront = base * 0.9 * Math.max(0, -fwd);
      tLeg = grounded ? 0.35 : 0;
    }
    if (braking && moving && speed > 3) {
      // retro burn: flames point along the velocity
      const k = 0.7 * clamp(speed / 20, 0.3, 1);
      tFront += k * Math.max(0, fwd);
      tMain += k * Math.max(0, -fwd);
      tSideR += k * Math.max(0, right);
      tSideL += k * Math.max(0, -right);
    }
    if (flying) {
      tDown = 1;
      tLeg = 1;
    }
    this.fMain.drive(tMain, dt, time);
    this.fSideL.drive(tSideL, dt, time);
    this.fSideR.drive(tSideR, dt, time);
    this.fFront.drive(tFront, dt, time);
    this.fDown.drive(tDown, dt, time);
    {
      const rate = tLeg > this.legFlameLevel ? 38 : 11;
      this.legFlameLevel += (tLeg - this.legFlameLevel) * (1 - Math.exp(-rate * dt));
      // the leg verniers are vectored: straight down in flight, raked back against the motion when skating
      const rake = moving ? (flying ? 0.3 : 0.85) : 0;
      _c.set(-dx * rake, -1, -dz * rake).normalize();
      _q.setFromUnitVectors(_DOWN, _c);
      const legs = this.rig.legs;
      for (let i = 0; i < legs.length; i++) {
        const l = legs[i];
        l.flame.apply(this.legFlameLevel, time);
        if (!l.flame.mesh.visible) continue;
        l.flame.mesh.position.copy(l.nozzle).applyQuaternion(l.lower.quaternion).add(l.lower.position);
        l.flame.mesh.quaternion.copy(_q);
      }
    }

    // ── muzzle flash ──
    if (this.flashT > 0) {
      const w = this.flashWeapon;
      const k = clamp(this.flashT / FLASH_TIME[w], 0, 1);
      const u = this.fFlash.material.uniforms;
      (u.uColA.value as THREE.Color).copy(FLASH_CORE[w]);
      (u.uColB.value as THREE.Color).copy(FLASH_OUTER[w]);
      u.uTime.value = time;
      u.uLen.value = (w === 'missile' ? 1.3 : w === 'beam' ? 1.5 : 1.0) * (0.6 + 0.4 * k);
      u.uRad.value = (w === 'missile' ? 2.2 : w === 'beam' ? 1.3 : 1.0) * (0.7 + 0.3 * k);
      u.uIntensity.value = 1.5 * k;
      this.fFlash.mesh.visible = true;
      if (w === 'missile') {
        const ub = this.fBack.material.uniforms;
        (ub.uColA.value as THREE.Color).copy(FLASH_CORE.missile);
        (ub.uColB.value as THREE.Color).copy(FLASH_OUTER.missile);
        ub.uTime.value = time;
        ub.uLen.value = 0.5 + 0.7 * k;
        ub.uRad.value = 1;
        ub.uIntensity.value = 1.2 * k;
        this.fBack.mesh.visible = true;
      } else {
        this.fBack.mesh.visible = false;
      }
      this.flashT -= dt;
    } else {
      this.fFlash.mesh.visible = false;
      this.fBack.mesh.visible = false;
    }

    // sensors breathe; the beam coils and eyes flare when the beam fires
    this.material.emissiveIntensity = BASE_EMISSIVE * (1 + 0.07 * Math.sin(time * 2.3)) + (this.flashWeapon === 'beam' ? Math.max(0, this.flashT) * 12 : 0);
  }

  /** Solves and places every leg of the current rig (model space). */
  private poseLegs(wAir: number, wWalk = 0, wGlide = 0, wFall = 0, wBrake = 0, boost = 0, dx = 0, dz = -1, moving = false): void {
    const rig = this.rig;
    const quad = rig.id === 'quadruped';
    this.pelvis.updateMatrix();
    _mPelvis.copy(this.pelvis.matrix);
    const duty = quad ? 0.5 : 0.42;
    const amp = quad ? 0.36 : 0.56;
    const liftH = quad ? 0.32 : 0.36;
    for (let li = 0; li < rig.legs.length; li++) {
      const leg = rig.legs[li];
      _a.copy(leg.hip).applyMatrix4(_mPelvis);
      _t.copy(leg.rest);
      let pitch = 0;
      let yaw = 0;

      // walk cycle
      if (wWalk > 1e-4) {
        const p = frac(this.phase + leg.phase);
        let s: number;
        let lift = 0;
        let pw: number;
        if (p < duty) {
          const u = p / duty;
          s = 1 - 2 * u;
          const late = Math.max(0, (u - 0.65) / 0.35);
          pw = -0.22 * Math.max(0, 1 - u / 0.2) + 0.5 * late * late;
        } else {
          const u = (p - duty) / (1 - duty);
          s = -Math.cos(Math.PI * u);
          lift = Math.sin(Math.PI * u);
          pw = 0.5 * (1 - u) * (1 - u) - 0.22 * u * u;
        }
        const lat = quad ? 0.7 : 0.45;
        _t.x += dx * amp * lat * s * wWalk;
        _t.z += dz * amp * s * wWalk;
        _t.y += lift * liftH * wWalk;
        if (!quad) pitch += pw * wWalk;
      }

      if (quad) {
        // glide: wide braced stance; air: legs gathered under the body
        const spread = wGlide * (0.12 + 0.06 * boost) - wAir * (0.24 - 0.12 * wFall);
        _t.x += leg.outX * spread;
        _t.z += leg.outZ * spread + wAir * 0.12 * (1 - wFall);
        _t.y += wAir * (0.3 + 0.08 * leg.fore);
        if (moving) {
          _t.x += dx * wBrake * 0.14 - dx * wGlide * 0.05;
          _t.z += dz * wBrake * 0.14 - dz * wGlide * 0.05;
        }
        yaw = Math.atan2(-leg.outX, -leg.outZ);
      } else {
        const s = leg.side;
        // glide: braced skating stance, left foot leading, right foot trailing and turned out
        const lead = s < 0 ? 1 : 0;
        _t.z += wGlide * (lead ? -0.36 : 0.4) * (1 + 0.2 * boost);
        _t.x += wGlide * s * 0.07;
        yaw += s * (-0.07 - wGlide * (lead ? 0.05 : 0.34));
        pitch += wGlide * (lead ? -0.04 : 0.2);
        // airborne: legs trail (rising / flying) or tuck forward to brace (falling)
        _t.y += wAir * (0.24 + (lead ? 0.1 : 0) + wFall * 0.1);
        _t.z += wAir * ((lead ? 0.08 : 0.34) - wFall * 0.42);
        _t.x -= wAir * s * 0.05;
        pitch += wAir * (0.6 - wFall * 0.5);
        if (moving) {
          _t.x += dx * wBrake * 0.2;
          _t.z += dz * wBrake * 0.2;
        } else {
          _t.z -= wBrake * 0.12;
        }
      }

      if (!quad) {
        // the sole never goes below the ground plane: a rolled foot pivots on its toe (pitch > 0) or heel
        const ap = Math.abs(pitch);
        const need = BIPED.ankleY * Math.cos(ap) + (pitch > 0 ? FOOT_TOE : FOOT_HEEL) * Math.sin(ap);
        if (_t.y < need) _t.y = need;
      }

      // two-bone solve
      if (quad) _pole.set(leg.outX * 0.45, 1, leg.outZ * 0.45);
      else _pole.set(leg.side * 0.12, 0.05, -1);
      solveTwoBone(_a, _t, rig.l1, rig.l2, _pole, _mid);
      // the foot stays attached to the shin when the target is out of reach
      _c.subVectors(_t, _mid);
      const reach = _c.length();
      if (reach > rig.l2 * 1.0005 || reach < rig.l2 * 0.9995) _t.copy(_mid).addScaledVector(_c, rig.l2 / Math.max(reach, 1e-6));
      _n.subVectors(_mid, _a).cross(_b.subVectors(_t, _mid)).negate();
      if (!quad) {
        orientBone(leg.upper, _a, _mid, _n);
        orientBone(leg.lower, _mid, _t, _n);
        leg.foot.position.copy(_t);
        leg.foot.rotation.set(-pitch, yaw, 0);
      } else {
        // bone +X = hinge axis chosen so that +Z is the upper / outer side
        _hint.copy(_n).negate();
        orientBone(leg.upper, _a, _mid, _hint);
        orientBone(leg.lower, _mid, _t, _hint);
        leg.foot.position.copy(_t);
        leg.foot.rotation.set(0, yaw, 0);
      }
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const f of this.flames) f.dispose();
    this.flames.length = 0;
    for (const g of this.geometries) g.dispose();
    this.geometries.length = 0;
    for (const t of this.textures) t.dispose();
    this.textures.length = 0;
    this.material.dispose();
  }
}
