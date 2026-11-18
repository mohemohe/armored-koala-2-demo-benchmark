/**
 * Enemy models — guard robot (警備ロボット), fixed turret (固定砲台) and control turret (制御砲台).
 *
 * Everything is procedural (no assets). One enemy = one SkinnedMesh with rigid (single-bone) skinning,
 * so the whole articulated body is a single draw call:
 *
 *   guard / turret alive : body (1) + sensor halo sprite (1) + contact shadow (1)           = 3 draw calls
 *                          + muzzle charge sprites during a telegraph (guard 2, turret 1)    ≤ 5
 *                          + damage spark sprite (only outside telegraphs, a few frames)     ≤ 4
 *   control turret alive : body (1) + emissive ring/beacon group (1) + sensor halo (1)
 *                          + beacon halo (1) + contact shadow (1)                            = 5
 *                          + muzzle charge (telegraph) or damage spark, never both           ≤ 6
 *   any kind destroyed   : wreck (1) + ember glow sprite (1) + contact shadow (1)            = 3, no animation
 *
 * Triangles (measured, `getEnemyModelStats`): guard 1.2k (wreck 1.3k), turret 0.7k (0.8k),
 * control turret 1.3k (1.0k) — all below the 1.5k budget.
 *
 * Resource sharing: geometries, materials and textures live in ONE module-level cache that is
 * REFERENCE-COUNTED by EnemyView instances: the first `new EnemyView` builds it, the last `dispose()`
 * frees every GPU resource. Per instance there is only a Skeleton (its small bone texture is freed in
 * `dispose()`), a few Bones/Sprites and no private material or geometry.
 *
 * The sensor is part of the body mesh: an extra `glow` vertex attribute masks the material's emissive
 * colour, and the state colour (idle / alert / telegraph flash) is selected by swapping between a handful
 * of shared material variants that compile to the same program.
 *
 * Conventions: group origin = hit-sphere centre, model faces -Z at yaw 0 (three.js Euler 'YXZ'); the group
 * lives in world space (its parent has no transform).
 * The guard estimates its direction of travel from the displacement of `group.position` between two
 * `update()` calls (the renderer positions the group; `speed` only scales the gait).
 *
 * Cost of a view that is not on screen: the caller hides `group` and calls `update(input, false)`. The view then
 * only advances its animation state (no IK, no bone / sprite / material writes) and three.js skips its subtree
 * (also the world-matrix refresh, see the constructor). Nothing is approximated: the pose is rebuilt from the
 * same state in the frame the view is drawn again.
 */
import * as THREE from 'three';
import { ENEMIES } from '../config';

export interface EnemyViewInput {
  dt: number;
  time: number;
  alive: boolean;
  /** facing (three.js yaw convention: 0 looks along -Z) */
  yaw: number;
  /** world-space unit barrel direction */
  aimDir: { x: number; y: number; z: number };
  /** 0 when no burst is announced, otherwise progress 0→1 through the telegraph window */
  telegraph: number;
  alert: boolean;
  /** 0..1 */
  hpFraction: number;
  /** actual movement speed m/s (guards) */
  speed: number;
}

type ModelKind = 'guard' | 'turret' | 'control';

// ───────────────────────────── palette (sRGB hex) ─────────────────────────────
const COL = {
  maroon: 0x7a2126,
  maroonDark: 0x52161b,
  maroonLight: 0x9a332f,
  pale: 0xbdb5a6,
  steel: 0x454a53,
  steelDark: 0x25282e,
  steelLight: 0x6d747e,
  olive: 0x687049,
  oliveDark: 0x4a5136,
  oliveLight: 0x848c63,
  gunmetal: 0x505862,
  gunmetalDark: 0x2d3137,
  gunmetalLight: 0x737c88,
  controlArmor: 0x8a929c,
  hazardYellow: 0xf2b619,
  hazardBlack: 0x18181c,
  lens: 0x2a1410,
  cyan: 0x58f2ff,
  amber: 0xffb22a,
} as const;

/** Self-illumination added to the armour (fraction of the albedo) so silhouettes never go fully black. */
const selfLit = { value: 0.07 };
/** Integrator hook: fraction of the armour albedo that is always visible, 0 = purely lit (default 0.07). */
export function setEnemySelfIllumination(fraction: number): void {
  selfLit.value = Math.max(0, fraction);
}

// ───────────────────────────── geometry builder ─────────────────────────────
type P3 = readonly [number, number, number];

interface AddOpts {
  /** Emissive mask 0..1 (1 = sensor lens). */
  glow?: number;
  /** Keep the primitive's own smooth normals (round parts). Default: flat per-face normals. */
  smooth?: boolean;
  /** Orient every face away from the primitive's centroid (for hand-built convex shapes). */
  convex?: boolean;
  /** Wreck only: this part may smoulder. */
  ember?: boolean;
}

const _m3 = new THREE.Matrix3();
const _va = new THREE.Vector3();
const _vb = new THREE.Vector3();
const _vc = new THREE.Vector3();
const _n = new THREE.Vector3();
const _e1 = new THREE.Vector3();
const _e2 = new THREE.Vector3();
const _cen = new THREE.Vector3();
const _col = new THREE.Color();

class GeoBuilder {
  readonly pos: number[] = [];
  readonly nor: number[] = [];
  readonly col: number[] = [];
  readonly bone: number[] = [];
  readonly glow: number[] = [];
  /** Per-vertex part id and per-part ember flag (used when charring a wreck). */
  readonly part: number[] = [];
  readonly partEmber: boolean[] = [];

  get triangles(): number {
    return this.pos.length / 9;
  }

  /** Appends a temporary three.js geometry transformed by `m` (the geometry is disposed). */
  add(g: THREE.BufferGeometry, m: THREE.Matrix4, color: number, bone: number, opts: AddOpts = {}): this {
    const p = g.getAttribute('position');
    const nAttr = opts.smooth ? g.getAttribute('normal') : undefined;
    const idx = g.getIndex();
    const count = idx ? idx.count : p.count;
    const flip = m.determinant() < 0;
    _m3.getNormalMatrix(m);
    _col.setHex(color); // sRGB hex → linear working space
    const partId = this.partEmber.length;
    this.partEmber.push(!!opts.ember);
    if (opts.convex) {
      _cen.set(0, 0, 0);
      for (let i = 0; i < p.count; i++) _cen.add(_va.fromBufferAttribute(p, i));
      _cen.multiplyScalar(1 / Math.max(1, p.count)).applyMatrix4(m);
    }
    const glow = opts.glow ?? 0;
    for (let i = 0; i + 2 < count; i += 3) {
      let ia = idx ? idx.getX(i) : i;
      let ib = idx ? idx.getX(i + 1) : i + 1;
      let ic = idx ? idx.getX(i + 2) : i + 2;
      if (flip) {
        const t = ib;
        ib = ic;
        ic = t;
      }
      _va.fromBufferAttribute(p, ia).applyMatrix4(m);
      _vb.fromBufferAttribute(p, ib).applyMatrix4(m);
      _vc.fromBufferAttribute(p, ic).applyMatrix4(m);
      _n.crossVectors(_e1.subVectors(_vb, _va), _e2.subVectors(_vc, _va));
      if (_n.lengthSq() < 1e-14) continue; // degenerate
      _n.normalize();
      if (opts.convex) {
        _e1.copy(_va).add(_vb).add(_vc).multiplyScalar(1 / 3).sub(_cen);
        if (_e1.dot(_n) < 0) {
          _e2.copy(_vb);
          _vb.copy(_vc);
          _vc.copy(_e2);
          const t = ib;
          ib = ic;
          ic = t;
          _n.negate();
        }
      }
      this.pos.push(_va.x, _va.y, _va.z, _vb.x, _vb.y, _vb.z, _vc.x, _vc.y, _vc.z);
      if (nAttr) {
        for (const vi of [ia, ib, ic]) {
          _e1.fromBufferAttribute(nAttr, vi).applyMatrix3(_m3).normalize();
          this.nor.push(_e1.x, _e1.y, _e1.z);
        }
      } else {
        this.nor.push(_n.x, _n.y, _n.z, _n.x, _n.y, _n.z, _n.x, _n.y, _n.z);
      }
      for (let k = 0; k < 3; k++) {
        this.col.push(_col.r, _col.g, _col.b);
        this.bone.push(bone);
        this.glow.push(glow);
        this.part.push(partId);
      }
    }
    g.dispose();
    return this;
  }

  /** Darkens vertices near the floor (cheap baked occlusion) and adds a small per-part tone jitter. */
  shade(floorY: number, span: number, strength: number, rng: () => number): void {
    const jitter: number[] = this.partEmber.map(() => 0.94 + rng() * 0.12);
    for (let v = 0; v < this.part.length; v++) {
      if (this.glow[v] > 0.5) continue;
      const y = this.pos[v * 3 + 1];
      const t = Math.min(1, Math.max(0, (y - floorY) / span));
      const f = (1 - strength + strength * t * (2 - t)) * jitter[this.part[v]];
      this.col[v * 3] *= f;
      this.col[v * 3 + 1] *= f;
      this.col[v * 3 + 2] *= f;
    }
  }

  /** Vertex data → BufferGeometry. `extra` (optional) is appended as material group 1. */
  build(skinned: boolean, extra?: GeoBuilder): THREE.BufferGeometry {
    const all = extra ? [this, extra] : [this];
    const vcount = all.reduce((s, b) => s + b.pos.length / 3, 0);
    const pos = new Float32Array(vcount * 3);
    const nor = new Float32Array(vcount * 3);
    const col = new Float32Array(vcount * 3);
    const glow = new Float32Array(vcount);
    const skinIndex = new Uint16Array(vcount * 4);
    const skinWeight = new Float32Array(vcount * 4);
    let o = 0;
    for (const b of all) {
      const n = b.pos.length / 3;
      pos.set(b.pos, o * 3);
      nor.set(b.nor, o * 3);
      col.set(b.col, o * 3);
      glow.set(b.glow, o);
      for (let i = 0; i < n; i++) {
        skinIndex[(o + i) * 4] = b.bone[i];
        skinWeight[(o + i) * 4] = 1;
      }
      o += n;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('glow', new THREE.BufferAttribute(glow, 1));
    if (skinned) {
      g.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
      g.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
    }
    if (extra) {
      const n0 = this.pos.length / 3;
      g.addGroup(0, n0, 0);
      g.addGroup(n0, extra.pos.length / 3, 1);
    }
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

// ── primitive helpers (build time only: allocations are fine here) ──
const _euler = new THREE.Euler();
const _quat = new THREE.Quaternion();
const _pos = new THREE.Vector3();
const _scl = new THREE.Vector3();
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);

function M(px = 0, py = 0, pz = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1): THREE.Matrix4 {
  return new THREE.Matrix4().compose(_pos.set(px, py, pz), _quat.setFromEuler(_euler.set(rx, ry, rz)), _scl.set(sx, sy, sz));
}
const box = (w: number, h: number, d: number): THREE.BufferGeometry => new THREE.BoxGeometry(w, h, d);
/** Box whose top face is scaled / shifted (trapezoid armour blocks). */
function taperBox(w: number, h: number, d: number, tx = 1, tz = 1, shiftX = 0, shiftZ = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    if (p.getY(i) > 0) p.setXYZ(i, p.getX(i) * tx + shiftX, p.getY(i), p.getZ(i) * tz + shiftZ);
  }
  return g;
}
/** Cylinder along +Y. */
const cyl = (rTop: number, rBottom: number, h: number, seg: number, open = false): THREE.BufferGeometry =>
  new THREE.CylinderGeometry(rTop, rBottom, h, seg, 1, open);
/** Matrix for a cylinder/box whose long axis (+Y) should run along Z. */
const alongZ = (px: number, py: number, pz: number): THREE.Matrix4 => M(px, py, pz, Math.PI / 2, 0, 0);
/** Matrix for a cylinder whose axis (+Y) should run along X. */
const alongX = (px: number, py: number, pz: number): THREE.Matrix4 => M(px, py, pz, 0, 0, Math.PI / 2);

/**
 * Symmetric extruded profile: `pts` = [z, y, halfWidth] going round a (roughly convex) side profile.
 * Gives angular hull shapes with sloped faces for very few triangles.
 */
function loft(pts: ReadonlyArray<P3>): THREE.BufferGeometry {
  const out: number[] = [];
  const n = pts.length;
  const R = (i: number): P3 => [pts[i][2], pts[i][1], pts[i][0]];
  const L = (i: number): P3 => [-pts[i][2], pts[i][1], pts[i][0]];
  const tri = (a: P3, b: P3, c: P3): void => {
    out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  };
  for (let i = 1; i < n - 1; i++) {
    tri(R(0), R(i), R(i + 1));
    tri(L(0), L(i + 1), L(i));
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    tri(L(i), R(i), R(j));
    tri(L(i), R(j), L(j));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(out), 3));
  return g;
}

/** Box of cross-section w × d running from a to b. */
function strut(b: GeoBuilder, a: P3, c: P3, w: number, d: number, color: number, bone: number, opts?: AddOpts): void {
  const dir = new THREE.Vector3(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
  const len = dir.length();
  dir.normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(Y_AXIS, dir);
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3((a[0] + c[0]) / 2, (a[1] + c[1]) / 2, (a[2] + c[2]) / 2),
    q,
    new THREE.Vector3(1, 1, 1),
  );
  b.add(box(w, len, d), m, color, bone, opts);
}

/** Clips a convex 2D polygon by the half-plane a·x + b·y <= c. */
function clipPoly(poly: Array<[number, number]>, a: number, b: number, c: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const dp = a * p[0] + b * p[1] - c;
    const dq = a * q[0] + b * q[1] - c;
    if (dp <= 0) out.push(p);
    if (dp < 0 !== dq < 0 && dp !== 0 && dq !== 0) {
      const t = dp / (dp - dq);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }
  return out;
}

/**
 * Hazard-striped rectangle (yellow/black diagonals) in the local XY plane, facing local +Z, centred
 * on the origin. Stripes are separate coloured polygons (no texture → same draw call as the armour).
 */
function hazardPanel(b: GeoBuilder, m: THREE.Matrix4, w: number, h: number, stripe: number, bone: number): void {
  const rect: Array<[number, number]> = [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ];
  // stripes: k*stripe <= x + y < (k+1)*stripe
  const lo = Math.floor((-w / 2 - h / 2) / stripe);
  const hi = Math.ceil((w / 2 + h / 2) / stripe);
  for (let k = lo; k < hi; k++) {
    let poly = clipPoly(rect, 1, 1, (k + 1) * stripe);
    poly = clipPoly(poly, -1, -1, -k * stripe);
    if (poly.length < 3) continue;
    const out: number[] = [];
    for (let i = 1; i < poly.length - 1; i++) {
      out.push(poly[0][0], poly[0][1], 0, poly[i][0], poly[i][1], 0, poly[i + 1][0], poly[i + 1][1], 0);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(out), 3));
    b.add(g, m, (((k % 2) + 2) % 2) === 0 ? COL.hazardYellow : COL.hazardBlack, bone);
  }
}

/** Hazard-striped band around a vertical cylinder (slanted segments). */
function hazardBand(b: GeoBuilder, radius: number, y0: number, y1: number, segs: number, slant: number, bone: number, cx = 0, cz = 0): void {
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2;
    const a1 = ((i + 1) / segs) * Math.PI * 2;
    const p = (a: number, y: number): P3 => [cx + Math.sin(a) * radius, y, cz + Math.cos(a) * radius];
    const A = p(a0, y0);
    const B = p(a1, y0);
    const C = p(a1 + slant, y1);
    const D = p(a0 + slant, y1);
    const g = new THREE.BufferGeometry();
    g.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array([...A, ...B, ...C, ...A, ...C, ...D]), 3),
    );
    b.add(g, M(), i % 2 === 0 ? COL.hazardYellow : COL.hazardBlack, bone);
  }
}

function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

// ───────────────────────────── bone layouts ─────────────────────────────
interface BoneDef {
  parent: number;
  /** Pivot in model space (rest pose). */
  p: P3;
}

// Guard
const G_ROOT = 0;
const G_PELVIS = 1;
const G_THIGH_L = 2;
const G_SHIN_L = 3;
const G_FOOT_L = 4;
const G_THIGH_R = 5;
const G_SHIN_R = 6;
const G_FOOT_R = 7;
const G_TORSO = 8;
const G_HEAD = 9;
const G_ARM_L = 10;
const G_ARM_R = 11;
const G_FINS = 12;

const GUARD_FLOOR = -ENEMIES.guard.centerHeight; // -1.3
const TURRET_FLOOR = -ENEMIES.turret.centerHeight; // -1.6

const G_HIP: P3 = [0.5, -0.3, 0.05];
const G_KNEE: P3 = [0.58, -0.72, -0.3];
const G_ANKLE: P3 = [0.58, -1.12, 0.12];
const G_PELVIS_P: P3 = [0, -0.28, 0.05];
const G_ARM_P: P3 = [0.78, 0.5, 0.02];
const G_MUZZLE: P3 = [0.98, 0.41, -1.1];
const G_SENSOR: P3 = [0, 0.92, -0.76];

const side = (p: P3, s: number): P3 => [p[0] * s, p[1], p[2]];

const GUARD_BONES: BoneDef[] = [
  { parent: -1, p: [0, 0, 0] }, // root
  { parent: G_ROOT, p: G_PELVIS_P }, // pelvis
  { parent: G_PELVIS, p: side(G_HIP, -1) },
  { parent: G_THIGH_L, p: side(G_KNEE, -1) },
  { parent: G_SHIN_L, p: side(G_ANKLE, -1) },
  { parent: G_PELVIS, p: side(G_HIP, 1) },
  { parent: G_THIGH_R, p: side(G_KNEE, 1) },
  { parent: G_SHIN_R, p: side(G_ANKLE, 1) },
  { parent: G_PELVIS, p: [0, -0.06, 0.05] }, // torso
  { parent: G_TORSO, p: [0, 0.84, -0.2] }, // head
  { parent: G_TORSO, p: side(G_ARM_P, -1) },
  { parent: G_TORSO, p: side(G_ARM_P, 1) },
  { parent: G_TORSO, p: [0, 0.8, 0.44] }, // fins
];

// Turret / control turret
const T_ROOT = 0;
const T_HEAD = 1;
const T_GUN = 2;
const T_MAST = 3;
const T_BEACON = 4;
const T_RING = 5;

const T_GUN_P: P3 = [0, 0.5, -0.5];
const T_MUZZLE: P3 = [0, 0.5, -2.42];
const T_SENSOR: P3 = [0, 1.1, -0.78];
const T_MAST_BASE: P3 = [0, 0.94, 0.1];
const T_BEACON_P: P3 = [0, 2.92, 0.1];
const T_RING_P: P3 = [0, 1.92, 0.1];

const TURRET_BONES: BoneDef[] = [
  { parent: -1, p: [0, 0, 0] },
  { parent: T_ROOT, p: [0, -0.4, 0] }, // head (yaw)
  { parent: T_HEAD, p: T_GUN_P }, // gun (pitch)
  { parent: T_HEAD, p: T_MAST_BASE }, // mast (control only; static while alive)
  { parent: T_MAST, p: T_BEACON_P }, // beacon rotor
  { parent: T_MAST, p: T_RING_P }, // halo ring
];

function boneInverses(defs: BoneDef[]): THREE.Matrix4[] {
  return defs.map((d) => new THREE.Matrix4().makeTranslation(-d.p[0], -d.p[1], -d.p[2]));
}

function makeBones(defs: BoneDef[]): THREE.Bone[] {
  const bones = defs.map(() => new THREE.Bone());
  defs.forEach((d, i) => {
    const b = bones[i];
    if (d.parent < 0) {
      b.position.set(d.p[0], d.p[1], d.p[2]);
    } else {
      const pp = defs[d.parent].p;
      b.position.set(d.p[0] - pp[0], d.p[1] - pp[1], d.p[2] - pp[2]);
      bones[d.parent].add(b);
    }
  });
  return bones;
}

// ───────────────────────────── guard geometry ─────────────────────────────
function buildGuardParts(b: GeoBuilder): void {
  // ── pelvis ──
  b.add(taperBox(0.74, 0.3, 0.56, 1.08, 1.0), M(0, -0.29, 0.05), COL.steel, G_PELVIS);
  b.add(taperBox(0.4, 0.3, 0.16, 0.7, 1), M(0, -0.31, -0.27, Math.PI, 0, 0), COL.maroonDark, G_PELVIS);
  b.add(cyl(0.3, 0.33, 0.14, 8), M(0, -0.09, 0.05), COL.steelDark, G_PELVIS, { ember: true });
  for (const s of [-1, 1]) {
    b.add(cyl(0.19, 0.19, 0.22, 8), alongX(s * 0.47, -0.3, 0.05), COL.steelDark, G_PELVIS, { ember: true });
  }

  // ── legs (digitigrade: knee forward, ankle back) ──
  for (const s of [-1, 1]) {
    const thigh = s < 0 ? G_THIGH_L : G_THIGH_R;
    const shin = s < 0 ? G_SHIN_L : G_SHIN_R;
    const foot = s < 0 ? G_FOOT_L : G_FOOT_R;
    const H = side(G_HIP, s);
    const K = side(G_KNEE, s);
    const A = side(G_ANKLE, s);
    strut(b, H, K, 0.24, 0.3, COL.steel, thigh);
    // thigh armour: outer slab + front plate
    strut(b, [H[0] + s * 0.17, H[1] + 0.1, H[2] - 0.02], [K[0] + s * 0.17, K[1] - 0.02, K[2] - 0.04], 0.1, 0.46, COL.maroon, thigh);
    strut(b, [H[0] + s * 0.02, H[1] - 0.02, H[2] - 0.2], [K[0] + s * 0.02, K[1] + 0.06, K[2] - 0.14], 0.3, 0.08, COL.maroonLight, thigh);
    b.add(cyl(0.15, 0.15, 0.36, 8), alongX(K[0], K[1], K[2]), COL.steelDark, thigh, { ember: true });
    // shin
    strut(b, K, A, 0.2, 0.22, COL.steelDark, shin);
    strut(b, [K[0], K[1] - 0.04, K[2] - 0.15], [A[0], A[1] + 0.1, A[2] - 0.17], 0.28, 0.09, COL.maroon, shin);
    strut(b, [K[0], K[1] - 0.1, K[2] + 0.2], [A[0], A[1] + 0.2, A[2] + 0.12], 0.07, 0.07, COL.steelLight, shin);
    b.add(cyl(0.12, 0.12, 0.3, 8), alongX(A[0], A[1], A[2]), COL.steelDark, shin, { ember: true });
    // foot: wide armoured toe pad + heel spur
    b.add(
      loft([
        [-0.56, GUARD_FLOOR, 0.19],
        [-0.52, GUARD_FLOOR + 0.1, 0.21],
        [-0.14, GUARD_FLOOR + 0.24, 0.24],
        [0.2, GUARD_FLOOR + 0.2, 0.22],
        [0.34, GUARD_FLOOR, 0.2],
      ]),
      M(A[0], 0, A[2]),
      COL.steel,
      foot,
      { convex: true },
    );
    b.add(taperBox(0.4, 0.09, 0.3, 0.9, 0.7, 0, 0.04), M(A[0], GUARD_FLOOR + 0.16, A[2] - 0.38, 0.28, 0, 0), COL.maroon, foot);
  }

  // ── torso hull ──
  b.add(
    loft([
      [-0.42, -0.02, 0.48],
      [-0.7, 0.26, 0.56],
      [-0.5, 0.66, 0.5],
      [-0.12, 0.84, 0.42],
      [0.42, 0.84, 0.44],
      [0.64, 0.5, 0.52],
      [0.52, -0.02, 0.46],
    ]),
    M(),
    COL.maroon,
    G_TORSO,
    { convex: true },
  );
  // glacis plate with a pale security chevron band
  b.add(box(0.74, 0.34, 0.05), M(0, 0.47, -0.635, 0.43, 0, 0), COL.maroonLight, G_TORSO);
  b.add(box(0.76, 0.07, 0.055), M(0, 0.36, -0.69, 0.43, 0, 0), COL.pale, G_TORSO);
  // prow
  b.add(taperBox(0.5, 0.2, 0.2, 0.8, 0.5), M(0, 0.12, -0.6, -0.5, 0, 0), COL.maroonDark, G_TORSO);
  // flank armour skirts
  for (const s of [-1, 1]) {
    b.add(taperBox(0.08, 0.5, 0.86, 1, 0.82), M(s * 0.57, 0.22, 0.02, 0, 0, s * -0.06), COL.maroonDark, G_TORSO);
    // shoulder joint
    b.add(cyl(0.17, 0.17, 0.2, 8), alongX(s * 0.62, 0.5, 0.02), COL.steelDark, G_TORSO, { ember: true });
  }
  // back: power pack, vents, exhaust stubs
  b.add(taperBox(0.74, 0.5, 0.26, 0.9, 0.8), M(0, 0.5, 0.68, -0.16, 0, 0), COL.steel, G_TORSO);
  b.add(box(0.56, 0.08, 0.06), M(0, 0.62, 0.83, -0.16, 0, 0), COL.steelDark, G_TORSO, { ember: true });
  b.add(box(0.56, 0.08, 0.06), M(0, 0.48, 0.85, -0.16, 0, 0), COL.steelDark, G_TORSO, { ember: true });
  for (const s of [-1, 1]) {
    b.add(cyl(0.07, 0.09, 0.3, 6), M(s * 0.26, 0.86, 0.6, -0.3, 0, 0), COL.steelLight, G_TORSO);
  }
  // collar ring under the head
  b.add(cyl(0.3, 0.34, 0.08, 8), M(0, 0.86, -0.2), COL.steelDark, G_TORSO, { ember: true });

  // ── head: low armoured cowl with one wide sensor eye ──
  b.add(
    loft([
      [-0.62, 0.84, 0.3],
      [-0.6, 1.0, 0.3],
      [-0.4, 1.14, 0.24],
      [-0.02, 1.15, 0.26],
      [0.16, 0.84, 0.33],
    ]),
    M(),
    COL.maroonDark,
    G_HEAD,
    { convex: true },
  );
  b.add(box(0.52, 0.15, 0.05), M(0, 0.92, -0.625, 0.12, 0, 0), COL.steelDark, G_HEAD);
  // the eye: a wide hexagonal lens (emissive via the glow mask)
  b.add(cyl(0.062, 0.062, 0.05, 6), M(0, 0.92, -0.655, Math.PI / 2 + 0.12, 0, 0, 3.2, 1, 1), COL.lens, G_HEAD, { glow: 1 });
  // brow + cheek sensors
  b.add(box(0.68, 0.05, 0.24), M(0, 1.025, -0.6, 0.16, 0, 0), COL.maroonLight, G_HEAD);
  for (const s of [-1, 1]) {
    b.add(box(0.06, 0.14, 0.26), M(s * 0.33, 0.98, -0.3), COL.steelLight, G_HEAD);
  }

  // ── arms: shoulder shield + forearm gun ──
  for (const s of [-1, 1]) {
    const arm = s < 0 ? G_ARM_L : G_ARM_R;
    const x = s * 0.98;
    b.add(taperBox(0.4, 0.5, 0.64, 0.72, 0.8), M(s * 0.96, 0.56, 0.04), COL.maroon, arm);
    b.add(box(0.3, 0.05, 0.4), M(s * 0.96, 0.825, 0.04), COL.pale, arm);
    b.add(box(0.06, 0.4, 0.5), M(s * 1.17, 0.5, 0.04, 0, 0, s * -0.12), COL.maroonLight, arm);
    // gun housing, magazine, drum
    b.add(box(0.26, 0.28, 0.92), M(x, 0.38, -0.32), COL.steel, arm);
    b.add(box(0.28, 0.1, 0.5), M(x, 0.54, -0.42), COL.steelDark, arm);
    b.add(box(0.18, 0.24, 0.3), M(x, 0.15, -0.12), COL.steelDark, arm, { ember: true });
    b.add(cyl(0.16, 0.16, 0.24, 8), alongX(x, 0.36, 0.26), COL.steelLight, arm);
    // barrel + muzzle
    b.add(cyl(0.065, 0.065, 0.36, 8), alongZ(x, 0.41, -0.92), COL.steelLight, arm, { smooth: true });
    b.add(cyl(0.1, 0.1, 0.1, 8), alongZ(x, 0.41, -1.05), COL.steelDark, arm, { ember: true });
    b.add(box(0.1, 0.1, 0.3), M(x, 0.26, -0.84), COL.steelDark, arm);
  }

  // ── alert fins (fold flat along the back when idle) ──
  for (const s of [-1, 1]) {
    b.add(taperBox(0.05, 0.56, 0.22, 1, 0.5, 0, 0.04), M(s * 0.3, 1.08, 0.48, 0, 0, s * -0.2), COL.maroonLight, G_FINS);
    b.add(box(0.055, 0.1, 0.12), M(s * 0.352, 1.33, 0.5, 0, 0, s * -0.2), COL.pale, G_FINS);
  }
}

// ───────────────────────────── turret geometry ─────────────────────────────
function buildTurretParts(b: GeoBuilder, glowB: GeoBuilder | null, control: boolean, wreck: boolean): void {
  const armor = control ? COL.controlArmor : COL.olive;
  const armorLight = control ? 0xa3abb5 : COL.oliveLight;
  const armorDark = control ? COL.gunmetal : COL.oliveDark;
  const F = TURRET_FLOOR;

  // ── base: floor plate, tripod, column, bearing ──
  b.add(cyl(1.36, 1.5, 0.18, 8), M(0, F + 0.09, 0, 0, Math.PI / 8, 0), COL.gunmetalDark, T_ROOT);
  b.add(cyl(0.56, 0.7, 0.86, 8), M(0, F + 0.61, 0, 0, Math.PI / 8, 0), armorDark, T_ROOT);
  b.add(cyl(0.72, 0.72, 0.12, 8), M(0, F + 0.5, 0, 0, Math.PI / 8, 0), COL.gunmetalDark, T_ROOT, { ember: true });
  for (let i = 0; i < 3; i++) {
    const a = (i * 2 * Math.PI) / 3 + Math.PI / 3; // 60°, 180°, 300° from the front
    const sx = Math.sin(a);
    const sz = -Math.cos(a);
    strut(b, [sx * 1.3, F + 0.2, sz * 1.3], [sx * 0.5, F + 0.92, sz * 0.5], 0.34, 0.24, COL.gunmetal, T_ROOT);
    b.add(box(0.56, 0.16, 0.5), M(sx * 1.24, F + 0.22, sz * 1.24, 0, -a, 0), control ? COL.hazardYellow : armorLight, T_ROOT);
    strut(b, [sx * 1.0, F + 0.24, sz * 1.0], [sx * 0.62, F + 0.42, sz * 0.62], 0.1, 0.1, COL.steelLight, T_ROOT);
  }
  b.add(cyl(0.94, 0.9, 0.2, 12), M(0, -0.52, 0), COL.gunmetalDark, T_ROOT);
  if (control) hazardBand(b, 0.955, -0.6, -0.44, 16, 0.2, T_ROOT);

  // ── head ──
  b.add(cyl(0.84, 0.88, 0.12, 8), M(0, -0.34, 0, 0, Math.PI / 8, 0), COL.gunmetalLight, T_HEAD);
  b.add(
    loft([
      [-0.7, -0.26, 0.66],
      [-0.94, 0.2, 0.6],
      [-0.62, 0.88, 0.46],
      [0.5, 0.94, 0.5],
      [1.0, 0.5, 0.6],
      [0.86, -0.26, 0.66],
    ]),
    M(),
    armor,
    T_HEAD,
    { convex: true },
  );
  // side armour cheeks
  for (const s of [-1, 1]) {
    b.add(taperBox(0.14, 0.9, 1.36, 1, 0.8), M(s * 0.76, 0.26, 0.02, 0, 0, s * -0.1), armorLight, T_HEAD);
    if (control) {
      hazardPanel(b, M(s * 0.76, 0.26, 0.02, 0, 0, s * -0.1).multiply(M(s * 0.086, 0, 0, 0, (s * Math.PI) / 2, 0)), 1.06, 0.62, 0.2, T_HEAD);
    } else {
      b.add(box(0.03, 0.2, 0.9), M(s * 0.84, 0.3, 0.02, 0, 0, s * -0.1), armorDark, T_HEAD);
    }
  }
  // rear bustle with radiator fins
  b.add(taperBox(1.0, 0.56, 0.42, 0.9, 0.8), M(0, 0.18, 1.02), armorDark, T_HEAD);
  for (let i = 0; i < 3; i++) {
    b.add(box(0.8, 0.05, 0.1), M(0, 0.06 + i * 0.14, 1.26), COL.gunmetalDark, T_HEAD, { ember: true });
  }
  // top hatch
  b.add(box(0.62, 0.06, 0.6), M(0, 0.95, 0.12), COL.gunmetal, T_HEAD);
  // sensor housing with a round red lens
  b.add(taperBox(0.4, 0.34, 0.46, 0.85, 0.85), M(0, 1.08, -0.46), COL.gunmetalDark, T_HEAD);
  b.add(cyl(0.135, 0.135, 0.08, 10), alongZ(0, 1.1, -0.71), COL.lens, T_HEAD, { glow: 1, smooth: true });
  b.add(box(0.48, 0.05, 0.36), M(0, 1.285, -0.52, 0.08, 0, 0), armorLight, T_HEAD);
  if (control) {
    // front hazard plate under the guns
    hazardPanel(b, M(0, -0.04, -0.845, -0.46, Math.PI, 0), 1.0, 0.34, 0.17, T_HEAD);
  } else {
    b.add(box(0.035, 0.42, 0.035), M(0.36, 1.16, 0.56), COL.steelLight, T_HEAD);
  }

  // ── twin guns ──
  b.add(cyl(0.3, 0.3, 1.16, 8), alongX(0, 0.5, -0.5), COL.gunmetalDark, T_GUN, { ember: true });
  b.add(taperBox(1.0, 0.4, 0.56, 0.9, 0.86), M(0, 0.5, -0.92, -Math.PI / 2, 0, 0), COL.gunmetal, T_GUN);
  for (const s of [-1, 1]) {
    const x = s * 0.25;
    b.add(box(0.28, 0.28, 0.56), M(x, 0.5, -1.3), COL.gunmetalDark, T_GUN);
    b.add(cyl(0.085, 0.085, 0.8, 8), alongZ(x, 0.5, -1.87), COL.gunmetalLight, T_GUN, { smooth: true });
    b.add(cyl(0.135, 0.135, 0.22, 8), alongZ(x, 0.5, -2.27), COL.gunmetalDark, T_GUN, { ember: true });
  }
  b.add(box(0.66, 0.08, 0.3), M(0, 0.68, -1.3), armorLight, T_GUN);

  if (!control) return;

  // ── control turret: mast, rotating amber beacon, cyan rings ──
  const mx = T_MAST_BASE[0];
  const mz = T_MAST_BASE[2];
  b.add(taperBox(0.5, 0.2, 0.5, 0.5, 0.5), M(mx, 1.04, mz), COL.gunmetalDark, T_MAST);
  b.add(box(0.13, 1.74, 0.13), M(mx, 1.98, mz), COL.steelLight, T_MAST);
  for (const s of [-1, 1]) {
    strut(b, [mx + s * 0.44, 0.98, mz], [mx, 1.72, mz], 0.06, 0.06, COL.gunmetalLight, T_MAST);
  }
  strut(b, [mx, 0.98, mz + 0.46], [mx, 1.6, mz], 0.06, 0.06, COL.gunmetalLight, T_MAST);
  hazardBand(b, 0.1, 2.3, 2.62, 8, 0.5, T_MAST, mx, mz);
  b.add(cyl(0.3, 0.24, 0.1, 8), M(mx, 2.8, mz), COL.gunmetalDark, T_MAST);
  b.add(cyl(0.2, 0.24, 0.06, 8), M(mx, 3.2, mz), COL.gunmetalDark, T_MAST);
  // rotor: two reflector slats either side of the lamp (the lamp shines along the rotor's ±Z)
  for (const s of [-1, 1]) {
    b.add(box(0.035, 0.3, 0.34), M(mx + s * 0.215, 3.02, mz), COL.gunmetalDark, T_BEACON);
  }
  // three emitter nodes riding on the halo ring (gone with the ring when destroyed)
  for (let i = 0; i < 3 && !wreck; i++) {
    const a = (i * 2 * Math.PI) / 3;
    b.add(box(0.16, 0.2, 0.26), M(mx + Math.sin(a) * 1.08, T_RING_P[1], mz + Math.cos(a) * 1.08, 0, a, 0), COL.gunmetalDark, T_RING);
  }
  if (wreck || !glowB) {
    // dead lamp
    b.add(cyl(0.17, 0.17, 0.3, 8), M(mx, 3.02, mz), COL.steelDark, T_MAST, { ember: true });
    return;
  }
  // emissive group (MeshBasicMaterial, vertex colours)
  glowB.add(cyl(0.17, 0.17, 0.3, 8), M(mx, 3.02, mz), COL.amber, T_MAST, { smooth: true });
  glowB.add(new THREE.TorusGeometry(1.08, 0.06, 4, 20), M(mx, T_RING_P[1], mz, Math.PI / 2, 0, 0), COL.cyan, T_RING);
  glowB.add(new THREE.TorusGeometry(1.66, 0.06, 4, 20), M(0, F + 0.34, 0, Math.PI / 2, 0, 0), COL.cyan, T_ROOT);
}

// ───────────────────────────── wreck baking ─────────────────────────────
/** Applies a pose (bone world matrices of a temporary skeleton) to the builder's vertices. */
function bakePose(b: GeoBuilder, defs: BoneDef[], pose: (bones: THREE.Bone[]) => void, floorY: number): void {
  const bones = makeBones(defs);
  pose(bones);
  bones[0].updateMatrixWorld(true);
  const inv = boneInverses(defs);
  const mats = bones.map((bn, i) => new THREE.Matrix4().multiplyMatrices(bn.matrixWorld, inv[i]));
  const v = new THREE.Vector3();
  const n = new THREE.Vector3();
  const nm = new THREE.Matrix3();
  for (let i = 0; i < b.bone.length; i++) {
    const m = mats[b.bone[i]];
    v.set(b.pos[i * 3], b.pos[i * 3 + 1], b.pos[i * 3 + 2]).applyMatrix4(m);
    if (v.y < floorY + 0.01) v.y = floorY + 0.01; // nothing sinks through the floor
    b.pos[i * 3] = v.x;
    b.pos[i * 3 + 1] = v.y;
    b.pos[i * 3 + 2] = v.z;
    nm.getNormalMatrix(m);
    n.set(b.nor[i * 3], b.nor[i * 3 + 1], b.nor[i * 3 + 2]).applyMatrix3(nm).normalize();
    b.nor[i * 3] = n.x;
    b.nor[i * 3 + 1] = n.y;
    b.nor[i * 3 + 2] = n.z;
    b.bone[i] = 0;
  }
}

/** Burns the colours to soot and lets some inner parts smoulder (emissive mask). */
function charWreck(b: GeoBuilder, rng: () => number, keep: number): void {
  const soot = new THREE.Color(0x1d1a18);
  const parts = b.partEmber.length;
  const burn: number[] = [];
  const ember: number[] = [];
  for (let p = 0; p < parts; p++) {
    burn.push(1 - keep * (0.35 + rng() * 0.65));
    ember.push(b.partEmber[p] && rng() < 0.55 ? 0.2 + rng() * 0.8 : 0);
  }
  for (let v = 0; v < b.part.length; v++) {
    const p = b.part[v];
    const t = burn[p];
    b.col[v * 3] += (soot.r - b.col[v * 3]) * t;
    b.col[v * 3 + 1] += (soot.g - b.col[v * 3 + 1]) * t;
    b.col[v * 3 + 2] += (soot.b - b.col[v * 3 + 2]) * t;
    b.glow[v] = ember[p];
  }
}

/** Charred scrap lying around a wreck. */
function scatterScrap(b: GeoBuilder, rng: () => number, floorY: number, rMin: number, rMax: number, count: number): void {
  for (let i = 0; i < count; i++) {
    const a = rng() * Math.PI * 2;
    const r = rMin + rng() * (rMax - rMin);
    const w = 0.14 + rng() * 0.3;
    const h = 0.06 + rng() * 0.14;
    const d = 0.12 + rng() * 0.34;
    b.add(
      taperBox(w, h, d, 0.6 + rng() * 0.4, 0.6 + rng() * 0.4),
      M(Math.sin(a) * r, floorY + h / 2, Math.cos(a) * r, (rng() - 0.5) * 0.3, rng() * 6.28, (rng() - 0.5) * 0.3),
      COL.steelDark,
      0,
      { ember: rng() < 0.5 },
    );
  }
}

function guardWreckPose(bn: THREE.Bone[]): void {
  bn[G_ROOT].rotation.set(0.1, 0, 0.2);
  bn[G_PELVIS].position.y -= 0.6;
  bn[G_PELVIS].position.z += 0.1;
  bn[G_THIGH_L].rotation.set(-0.95, 0, -0.5);
  bn[G_SHIN_L].rotation.set(1.5, 0, 0);
  bn[G_FOOT_L].rotation.set(-0.5, 0.3, 0.3);
  bn[G_THIGH_R].rotation.set(-1.25, 0, 0.75);
  bn[G_SHIN_R].rotation.set(1.75, 0, 0.2);
  bn[G_FOOT_R].rotation.set(-0.4, -0.4, 0);
  bn[G_TORSO].rotation.set(-0.42, 0.5, 0.22);
  bn[G_HEAD].rotation.set(-0.5, -0.45, 0.25);
  bn[G_ARM_L].rotation.set(-1.25, 0, 0.3);
  bn[G_ARM_R].rotation.set(-0.7, 0, -0.35);
  bn[G_ARM_R].position.y -= 0.12;
  bn[G_FINS].rotation.set(1.5, 0, 0.3);
}

function turretWreckPose(bn: THREE.Bone[]): void {
  bn[T_HEAD].rotation.set(0.16, 0.5, 0.26);
  bn[T_HEAD].position.y -= 0.1;
  bn[T_HEAD].position.x += 0.12;
  bn[T_GUN].rotation.set(-0.5, 0, 0.06);
  bn[T_MAST].rotation.set(0.5, 0, 1.15);
  bn[T_RING].rotation.set(0.9, 0, 0.5);
  bn[T_RING].position.y -= 0.9;
}

// ───────────────────────────── shared assets (reference counted) ─────────────────────────────
interface KindAssets {
  live: THREE.BufferGeometry;
  wreck: THREE.BufferGeometry;
  bones: BoneDef[];
  inverses: THREE.Matrix4[];
  liveTriangles: number;
  wreckTriangles: number;
}

interface Shared {
  kinds: Partial<Record<ModelKind, KindAssets>>;
  glowTex: THREE.Texture;
  chargeGuardTex: THREE.Texture;
  chargeTurretTex: THREE.Texture;
  shadowTex: THREE.Texture;
  bodyOrange: THREE.MeshStandardMaterial;
  bodyRed: THREE.MeshStandardMaterial;
  bodyRedDim: THREE.MeshStandardMaterial;
  bodyFlash: THREE.MeshStandardMaterial;
  wreckMat: THREE.MeshStandardMaterial;
  emissiveMat: THREE.MeshBasicMaterial;
  shadowMat: THREE.MeshBasicMaterial;
  shadowGeo: THREE.BufferGeometry;
  haloOrange: THREE.SpriteMaterial;
  haloRed: THREE.SpriteMaterial;
  haloWhite: THREE.SpriteMaterial;
  chargeGuard: THREE.SpriteMaterial;
  chargeGuardDim: THREE.SpriteMaterial;
  chargeTurret: THREE.SpriteMaterial;
  chargeTurretDim: THREE.SpriteMaterial;
  beacon: THREE.SpriteMaterial;
  spark: THREE.SpriteMaterial;
  ember: THREE.SpriteMaterial;
}

let shared: Shared | null = null;
let sharedRefs = 0;

function radialTexture(stops: Array<[number, string]>, size = 128): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [o, col] of stops) g.addColorStop(o, col);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = true;
  return t;
}

function bodyMaterial(emissive: number, intensity: number, rough = 0.6, metal = 0.25): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: rough,
    metalness: metal,
    emissive,
    emissiveIntensity: intensity,
  });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uSelfLit = selfLit;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float glow;\nvarying float vGlow;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = glow;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vGlow;\nuniform float uSelfLit;')
      .replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\ntotalEmissiveRadiance = totalEmissiveRadiance * vGlow + diffuseColor.rgb * uSelfLit;',
      );
  };
  m.customProgramCacheKey = () => 'ak2-enemy-body';
  return m;
}

function glowSprite(tex: THREE.Texture, color: number, opacity = 1): THREE.SpriteMaterial {
  return new THREE.SpriteMaterial({
    map: tex,
    color,
    opacity,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  });
}

function acquireShared(): Shared {
  sharedRefs++;
  if (shared) return shared;
  const glowTex = radialTexture([
    [0, 'rgba(255,255,255,1)'],
    [0.1, 'rgba(255,255,255,0.95)'],
    [0.24, 'rgba(255,255,255,0.5)'],
    [0.5, 'rgba(255,255,255,0.14)'],
    [0.78, 'rgba(255,255,255,0.03)'],
    [1, 'rgba(255,255,255,0)'],
  ]);
  // muzzle charge: white-hot core inside the colour of the bolt that is about to be fired
  const chargeGuardTex = radialTexture([
    [0, 'rgba(255,255,255,1)'],
    [0.1, 'rgba(255,236,200,1)'],
    [0.22, 'rgba(255,150,50,0.8)'],
    [0.45, 'rgba(255,90,20,0.3)'],
    [0.75, 'rgba(255,60,10,0.07)'],
    [1, 'rgba(255,40,0,0)'],
  ]);
  const chargeTurretTex = radialTexture([
    [0, 'rgba(255,255,255,1)'],
    [0.1, 'rgba(255,214,235,1)'],
    [0.22, 'rgba(255,70,150,0.8)'],
    [0.45, 'rgba(255,30,110,0.3)'],
    [0.75, 'rgba(255,20,90,0.07)'],
    [1, 'rgba(255,0,80,0)'],
  ]);
  const shadowTex = radialTexture(
    [
      [0, 'rgba(0,0,0,0.62)'],
      [0.45, 'rgba(0,0,0,0.5)'],
      [0.8, 'rgba(0,0,0,0.14)'],
      [1, 'rgba(0,0,0,0)'],
    ],
    64,
  );
  const shadowGeo = new THREE.PlaneGeometry(1, 1);
  shadowGeo.rotateX(-Math.PI / 2);
  shared = {
    kinds: {},
    glowTex,
    chargeGuardTex,
    chargeTurretTex,
    shadowTex,
    bodyOrange: bodyMaterial(0xff5200, 1.0),
    bodyRed: bodyMaterial(0xff1c0c, 1.2),
    bodyRedDim: bodyMaterial(0xd8200f, 0.8),
    bodyFlash: bodyMaterial(0xfff2e4, 1.6),
    wreckMat: bodyMaterial(0xe0420a, 0.7, 0.95, 0.05),
    emissiveMat: new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, fog: false }),
    shadowMat: new THREE.MeshBasicMaterial({
      map: shadowTex,
      transparent: true,
      depthWrite: false,
      fog: false,
      toneMapped: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }),
    shadowGeo,
    haloOrange: glowSprite(glowTex, 0xff5c10, 0.7),
    haloRed: glowSprite(glowTex, 0xff2410, 0.9),
    haloWhite: glowSprite(glowTex, 0xfff4ea, 1),
    chargeGuard: glowSprite(chargeGuardTex, 0xffffff, 1),
    chargeGuardDim: glowSprite(chargeGuardTex, 0xffffff, 0.55),
    chargeTurret: glowSprite(chargeTurretTex, 0xffffff, 1),
    chargeTurretDim: glowSprite(chargeTurretTex, 0xffffff, 0.55),
    beacon: glowSprite(glowTex, 0xffa416, 1),
    spark: glowSprite(glowTex, 0xffd6a0, 1),
    ember: glowSprite(glowTex, 0xff5a14, 0.3),
  };
  return shared;
}

function releaseShared(): void {
  sharedRefs = Math.max(0, sharedRefs - 1);
  if (sharedRefs > 0 || !shared) return;
  const s = shared;
  shared = null;
  for (const k of Object.values(s.kinds)) {
    k?.live.dispose();
    k?.wreck.dispose();
  }
  s.glowTex.dispose();
  s.chargeGuardTex.dispose();
  s.chargeTurretTex.dispose();
  s.shadowTex.dispose();
  s.shadowGeo.dispose();
  for (const m of [
    s.bodyOrange,
    s.bodyRed,
    s.bodyRedDim,
    s.bodyFlash,
    s.wreckMat,
    s.emissiveMat,
    s.shadowMat,
    s.haloOrange,
    s.haloRed,
    s.haloWhite,
    s.chargeGuard,
    s.chargeGuardDim,
    s.chargeTurret,
    s.chargeTurretDim,
    s.beacon,
    s.spark,
    s.ember,
  ]) {
    m.dispose();
  }
}

function kindAssets(s: Shared, kind: ModelKind): KindAssets {
  const cached = s.kinds[kind];
  if (cached) return cached;
  let assets: KindAssets;
  if (kind === 'guard') {
    const live = new GeoBuilder();
    buildGuardParts(live);
    live.shade(GUARD_FLOOR, 1.5, 0.3, makeRng(11));
    const wreck = new GeoBuilder();
    buildGuardParts(wreck);
    bakePose(wreck, GUARD_BONES, guardWreckPose, GUARD_FLOOR);
    const rng = makeRng(4711);
    scatterScrap(wreck, rng, GUARD_FLOOR, 0.9, 1.9, 7);
    charWreck(wreck, rng, 0.22);
    wreck.shade(GUARD_FLOOR, 1.2, 0.25, makeRng(5));
    assets = {
      live: live.build(true),
      wreck: wreck.build(false),
      bones: GUARD_BONES,
      inverses: boneInverses(GUARD_BONES),
      liveTriangles: live.triangles,
      wreckTriangles: wreck.triangles,
    };
  } else {
    const control = kind === 'control';
    const live = new GeoBuilder();
    const glowB = control ? new GeoBuilder() : null;
    buildTurretParts(live, glowB, control, false);
    live.shade(TURRET_FLOOR, 1.6, 0.3, makeRng(control ? 23 : 17));
    const wreck = new GeoBuilder();
    buildTurretParts(wreck, null, control, true);
    bakePose(wreck, TURRET_BONES, turretWreckPose, TURRET_FLOOR);
    const rng = makeRng(control ? 977 : 1201);
    scatterScrap(wreck, rng, TURRET_FLOOR, 1.6, 2.5, 8);
    charWreck(wreck, rng, control ? 0.3 : 0.24);
    wreck.shade(TURRET_FLOOR, 1.4, 0.25, makeRng(7));
    assets = {
      live: live.build(true, glowB ?? undefined),
      wreck: wreck.build(false),
      bones: TURRET_BONES,
      inverses: boneInverses(TURRET_BONES),
      liveTriangles: live.triangles + (glowB ? glowB.triangles : 0),
      wreckTriangles: wreck.triangles,
    };
  }
  s.kinds[kind] = assets;
  return assets;
}

/** Triangle counts of the shared geometries (builds them if needed) — for budget checks. */
export function getEnemyModelStats(): Record<ModelKind, { live: number; wreck: number }> {
  const s = acquireShared();
  const out = {
    guard: { live: kindAssets(s, 'guard').liveTriangles, wreck: kindAssets(s, 'guard').wreckTriangles },
    turret: { live: kindAssets(s, 'turret').liveTriangles, wreck: kindAssets(s, 'turret').wreckTriangles },
    control: { live: kindAssets(s, 'control').liveTriangles, wreck: kindAssets(s, 'control').wreckTriangles },
  };
  releaseShared();
  return out;
}

// ───────────────────────────── view ─────────────────────────────
const IDENTITY = new THREE.Matrix4();
const TWO_PI = Math.PI * 2;
const wrapAngle = (a: number): number => {
  a = (a + Math.PI) % TWO_PI;
  if (a < 0) a += TWO_PI;
  return a - Math.PI;
};
const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
const damp = (rate: number, dt: number): number => 1 - Math.exp(-rate * dt);

// scratch objects for update() (no per-frame allocations)
const _hip = new THREE.Vector3();
const _d = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _thighDir = new THREE.Vector3();
const _shinDir = new THREE.Vector3();
const _qThigh = new THREE.Quaternion();
const _qShin = new THREE.Quaternion();
const _qFoot = new THREE.Quaternion();

const G_L1 = Math.hypot(G_KNEE[0] - G_HIP[0], G_KNEE[1] - G_HIP[1], G_KNEE[2] - G_HIP[2]);
const G_L2 = Math.hypot(G_ANKLE[0] - G_KNEE[0], G_ANKLE[1] - G_KNEE[1], G_ANKLE[2] - G_KNEE[2]);
const G_REST_THIGH = [-1, 1].map((s) =>
  new THREE.Vector3((G_KNEE[0] - G_HIP[0]) * s, G_KNEE[1] - G_HIP[1], G_KNEE[2] - G_HIP[2]).normalize(),
);
const G_REST_SHIN = [-1, 1].map((s) =>
  new THREE.Vector3((G_ANKLE[0] - G_KNEE[0]) * s, G_ANKLE[1] - G_KNEE[1], G_ANKLE[2] - G_KNEE[2]).normalize(),
);

export class EnemyView {
  /** origin = the enemy's hit-sphere centre */
  readonly group = new THREE.Group();

  private readonly model: ModelKind;
  private readonly shared: Shared;
  private readonly assets: KindAssets;
  private readonly bones: THREE.Bone[];
  private readonly skeleton: THREE.Skeleton;
  private readonly live: THREE.SkinnedMesh;
  private readonly liveMaterials: THREE.Material[] | null = null;
  private readonly shadow: THREE.Mesh;
  private readonly sensor: THREE.Sprite;
  private readonly charges: THREE.Sprite[] = [];
  private readonly beaconHalo: THREE.Sprite | null = null;
  private readonly spark: THREE.Sprite;
  private wreck: THREE.Mesh | null = null;
  private ember: THREE.Sprite | null = null;

  private disposed = false;
  private dead = false;
  private first = true;
  private readonly seed = Math.random() * 100;
  private bodyMat: THREE.Material;

  // animation state
  private alertBlend = 0;
  private moveBlend = 0;
  private phase = Math.random();
  private bodyYaw = 0;
  private aimYaw = 0;
  private aimPitch = 0;
  private stepX = 0;
  private stepZ = -1;
  private lastX = 0;
  private lastZ = 0;
  private prevTelegraph = 0;
  private recoil = 0;
  private sparkTimer = 0.3;
  private sparkShow = 0;
  private baseYaw = 0;
  private readonly camPos = new THREE.Vector3();
  private hasCam = false;

  constructor(kind: 'guard' | 'turret', isGateControl: boolean) {
    this.model = kind === 'guard' ? 'guard' : isGateControl ? 'control' : 'turret';
    const s = (this.shared = acquireShared());
    const a = (this.assets = kindAssets(s, this.model));
    this.group.name = `enemy-${this.model}`;

    this.bones = makeBones(a.bones);
    this.skeleton = new THREE.Skeleton(this.bones, a.inverses);
    this.bodyMat = this.model === 'guard' ? s.bodyOrange : s.bodyRedDim;
    if (this.model === 'control') {
      this.liveMaterials = [this.bodyMat, s.emissiveMat];
      this.live = new THREE.SkinnedMesh(a.live, this.liveMaterials);
    } else {
      this.live = new THREE.SkinnedMesh(a.live, this.bodyMat);
    }
    this.live.bind(this.skeleton, IDENTITY);
    // Skinned bounds are never recomputed: a fixed sphere around the hit centre covers every pose.
    this.live.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.4, 0), this.model === 'control' ? 3.6 : 2.7);
    this.live.castShadow = false;
    this.live.receiveShadow = false;
    this.group.add(this.bones[0], this.live);

    // contact shadow on the floor the enemy stands on
    const floor = this.model === 'guard' ? GUARD_FLOOR : TURRET_FLOOR;
    this.shadow = new THREE.Mesh(s.shadowGeo, s.shadowMat);
    const shadowSize = this.model === 'guard' ? 3.3 : this.model === 'turret' ? 4.6 : 4.9;
    this.shadow.scale.set(shadowSize, 1, shadowSize);
    this.shadow.position.y = floor + 0.03;
    this.shadow.renderOrder = -1;
    this.group.add(this.shadow);

    // sensor halo + muzzle charge sprites ride on the bones
    this.sensor = new THREE.Sprite(this.model === 'guard' ? s.haloOrange : s.haloRed);
    if (this.model === 'guard') {
      this.attach(this.sensor, G_HEAD, G_SENSOR);
      for (const sgn of [-1, 1]) {
        const c = new THREE.Sprite(s.chargeGuard);
        c.visible = false;
        this.attach(c, sgn < 0 ? G_ARM_L : G_ARM_R, side(G_MUZZLE, sgn));
        this.charges.push(c);
      }
    } else {
      this.attach(this.sensor, T_HEAD, T_SENSOR);
      const c = new THREE.Sprite(s.chargeTurret);
      c.visible = false;
      this.attach(c, T_GUN, T_MUZZLE);
      this.charges.push(c);
      if (this.model === 'control') {
        this.beaconHalo = new THREE.Sprite(s.beacon);
        this.attach(this.beaconHalo, T_MAST, [T_BEACON_P[0], T_BEACON_P[1] + 0.1, T_BEACON_P[2]]);
        this.bones[T_RING].rotation.order = 'YXZ';
        this.live.onBeforeRender = (_r, _s, camera) => {
          this.camPos.setFromMatrixPosition(camera.matrixWorld);
          this.hasCam = true;
        };
      }
    }
    this.spark = new THREE.Sprite(s.spark);
    this.spark.visible = false;
    this.group.add(this.spark);

    // A hidden view costs no scene-graph work: three.js refreshes the world matrices of invisible subtrees too
    // (about 20 nodes per enemy, every frame). They are rebuilt by the same call in the frame the view is shown again.
    const group = this.group;
    group.updateMatrixWorld = function (force?: boolean): void {
      if (group.visible) THREE.Object3D.prototype.updateMatrixWorld.call(group, force);
    };
  }

  private attach(sprite: THREE.Sprite, bone: number, at: P3): void {
    const p = this.assets.bones[bone].p;
    sprite.position.set(at[0] - p[0], at[1] - p[1], at[2] - p[2]);
    this.bones[bone].add(sprite);
  }

  /**
   * Advances the animation by `input.dt` and poses the model.
   *
   * `pose` = false is for a view that is not drawn this frame (off-screen, too far away; the caller hides
   * `group`): the animation STATE still advances exactly as it does on screen — a handful of scalars (heading,
   * aim, alert blend, gait phase and direction, recoil) — but nothing is posed: no leg IK, no bone, sprite or
   * material writes. The pose is a pure function of that state, so in the frame the view is drawn again it is
   * exactly what a view that was never hidden shows (only the random hull sparks pause while hidden).
   */
  update(input: EnemyViewInput, pose = true): void {
    if (this.disposed) return;
    if (!input.alive) {
      if (!this.dead) this.enterWreck(Number.isFinite(input.yaw) ? input.yaw : 0);
      return; // wrecks are static: no animation cost
    }
    if (this.dead) this.leaveWreck();

    const dt = Number.isFinite(input.dt) ? clamp(input.dt, 0, 0.1) : 0;
    const time = Number.isFinite(input.time) ? input.time : 0;
    const yaw = Number.isFinite(input.yaw) ? input.yaw : 0;
    const telegraph = Number.isFinite(input.telegraph) ? clamp(input.telegraph, 0, 1) : 0;
    const hp = Number.isFinite(input.hpFraction) ? clamp(input.hpFraction, 0, 1) : 1;

    // aim angles from the barrel direction (fallback: straight ahead)
    const ax = input.aimDir.x;
    const ay = input.aimDir.y;
    const az = input.aimDir.z;
    const al = Math.hypot(ax, ay, az);
    let aimYaw = yaw;
    let aimPitch = 0;
    if (al > 1e-6 && Number.isFinite(al)) {
      if (Math.hypot(ax, az) > 1e-6) aimYaw = Math.atan2(-ax, -az);
      aimPitch = Math.asin(clamp(ay / al, -1, 1));
    }

    if (this.first) {
      this.first = false;
      this.bodyYaw = yaw;
      this.baseYaw = yaw;
      this.aimYaw = input.alert ? aimYaw : yaw;
      this.aimPitch = input.alert ? aimPitch : 0;
      this.alertBlend = input.alert ? 1 : 0;
      this.lastX = this.group.position.x;
      this.lastZ = this.group.position.z;
      this.prevTelegraph = telegraph;
    }
    this.alertBlend += ((input.alert ? 1 : 0) - this.alertBlend) * damp(9, dt);

    // burst recoil: the telegraph ending while still alert means the burst starts now
    if (this.prevTelegraph > 0.5 && telegraph === 0 && input.alert) this.recoil = 1;
    this.prevTelegraph = telegraph;
    this.recoil *= Math.exp(-dt * (this.model === 'guard' ? 5 : 3.2));

    if (this.model === 'guard') this.updateGuard(dt, time, yaw, aimYaw, aimPitch, input.alert, input.speed, pose);
    else this.updateTurret(dt, time, yaw, aimYaw, aimPitch, input.alert, pose);
    if (!pose) return;

    this.updateLights(time, telegraph, input.alert);
    this.updateDamage(dt, hp, telegraph);
  }

  // ── guard ──
  private updateGuard(dt: number, time: number, yaw: number, aimYaw: number, aimPitch: number, alert: boolean, speedIn: number, pose: boolean): void {
    const bn = this.bones;
    const a = this.alertBlend;
    const speed = Number.isFinite(speedIn) ? clamp(speedIn, 0, 14) : 0;

    // ── animation state (advances whether the view is drawn or not) ──
    this.moveBlend += (Math.min(1, speed / 2.5) - this.moveBlend) * damp(10, dt);
    const mv = this.moveBlend;

    // facing
    this.bodyYaw += wrapAngle(yaw - this.bodyYaw) * damp(16, dt);

    // direction of travel in the body frame, from the group's displacement since the last update
    const gp = this.group.position;
    if (dt > 1e-4) {
      const vx = (gp.x - this.lastX) / dt;
      const vz = (gp.z - this.lastZ) / dt;
      const c = Math.cos(this.bodyYaw);
      const s = Math.sin(this.bodyYaw);
      let lx = vx * c - vz * s;
      let lz = vx * s + vz * c;
      const l = Math.hypot(lx, lz);
      if (l > 0.6 && l < 60) {
        lx /= l;
        lz /= l;
      } else {
        lx = 0;
        lz = -1;
      }
      const k = damp(8, dt);
      this.stepX += (lx - this.stepX) * k;
      this.stepZ += (lz - this.stepZ) * k;
      const sl = Math.hypot(this.stepX, this.stepZ);
      if (sl > 1e-3) {
        this.stepX /= sl;
        this.stepZ /= sl;
      } else {
        this.stepX = 0;
        this.stepZ = -1;
      }
      this.lastX = gp.x;
      this.lastZ = gp.z;
    }

    // gait
    const cadence = 1.25 + 1.45 * Math.min(1, speed / 8); // steps cycles per second
    if (mv > 0.02) this.phase = (this.phase + dt * cadence) % 1;

    // aim (smoothed so that aim jitter / target switches do not snap)
    const ka = damp(alert ? 20 : 5, dt);
    this.aimYaw += wrapAngle((alert ? aimYaw : yaw) - this.aimYaw) * ka;
    this.aimPitch += ((alert ? clamp(aimPitch, -1.1, 1.2) : 0) - this.aimPitch) * ka;

    if (!pose) return;

    // ── pose: a pure function of the state above (and of `time`) ──
    bn[G_ROOT].rotation.y = this.bodyYaw;
    const stride = 0.4 * Math.min(1, speed / 5) * mv;

    // pelvis: crouch when alert, bob + sway with the gait, breathe when idle
    const pelvis = bn[G_PELVIS];
    const bob = mv * 0.04 * Math.cos(this.phase * 2 * TWO_PI);
    const breathe = (1 - mv) * 0.012 * Math.sin(time * 1.7 + this.seed);
    const pelvisY = G_PELVIS_P[1] - 0.1 * a + bob + breathe;
    const pelvisX = mv * 0.035 * Math.sin(this.phase * TWO_PI);
    pelvis.position.set(pelvisX, pelvisY, G_PELVIS_P[2] - 0.05 * a);

    for (let i = 0; i < 2; i++) {
      const s = i === 0 ? -1 : 1;
      const p = (this.phase + (i === 0 ? 0 : 0.5)) % 1;
      let along: number;
      let lift = 0;
      if (p < 0.5) {
        along = stride * (1 - 4 * p);
      } else {
        const u = (p - 0.5) * 2;
        along = stride * (-1 + 2 * u * u * (3 - 2 * u));
        lift = Math.sin(Math.PI * u) * (0.12 + 0.12 * Math.min(1, speed / 6)) * mv;
      }
      // combat stance: wider, left foot leading
      const tx = s * (G_ANKLE[0] + 0.09 * a) + this.stepX * along;
      const ty = G_ANKLE[1] + lift;
      const tz = G_ANKLE[2] + (s < 0 ? -0.16 : 0.12) * a + this.stepZ * along;
      this.solveLeg(i, pelvisX, pelvisY, pelvis.position.z, tx, ty, tz, -lift * 1.2);
    }

    const scan = Math.sin(time * 0.75 + this.seed);
    const torso = bn[G_TORSO];
    const twist = wrapAngle(this.aimYaw - this.bodyYaw) * a + (1 - a) * 0.42 * scan;
    torso.rotation.set(-0.1 * a - 0.05 * mv, twist, mv * 0.03 * Math.sin(this.phase * TWO_PI));

    const head = bn[G_HEAD];
    head.rotation.set(this.aimPitch * 0.5 * a - (1 - a) * 0.06, (1 - a) * 0.55 * Math.sin(time * 1.35 + this.seed * 2), 0);

    const kick = this.recoil * 0.07 * Math.abs(Math.sin(time * 42));
    const armPitch = this.aimPitch * a + (1 - a) * (-0.5 + 0.04 * scan) + 0.1 * a; // torso leans forward when alert
    for (let i = 0; i < 2; i++) {
      const arm = bn[i === 0 ? G_ARM_L : G_ARM_R];
      arm.rotation.x = armPitch + (i === 0 ? 0.03 : -0.03) * mv * Math.sin(this.phase * TWO_PI);
      const p = this.assets.bones[i === 0 ? G_ARM_L : G_ARM_R].p;
      const tp = this.assets.bones[G_TORSO].p;
      arm.position.z = p[2] - tp[2] + kick * (i === 0 ? 1 : 0.6);
    }

    bn[G_FINS].rotation.x = 1.28 * (1 - a) - 0.1 * a + 0.03 * Math.sin(time * 9 + this.seed) * a;
  }

  /** Two-bone IK in the root frame: plants the ankle at (tx, ty, tz), knee pointing forward. */
  private solveLeg(i: number, pelvisX: number, pelvisY: number, pelvisZ: number, tx: number, ty: number, tz: number, footPitch: number): void {
    const s = i === 0 ? -1 : 1;
    const bn = this.bones;
    const thigh = bn[i === 0 ? G_THIGH_L : G_THIGH_R];
    const shin = bn[i === 0 ? G_SHIN_L : G_SHIN_R];
    const foot = bn[i === 0 ? G_FOOT_L : G_FOOT_R];
    _hip.set(pelvisX + s * G_HIP[0], pelvisY + (G_HIP[1] - G_PELVIS_P[1]), pelvisZ + (G_HIP[2] - G_PELVIS_P[2]));
    _d.set(tx - _hip.x, ty - _hip.y, tz - _hip.z);
    const dist = clamp(_d.length(), Math.abs(G_L1 - G_L2) + 0.06, G_L1 + G_L2 - 0.012);
    _d.normalize();
    _pole.set(0, 0, -1).addScaledVector(_d, _d.z); // forward, made perpendicular to d
    if (_pole.lengthSq() < 1e-6) _pole.set(0, 1, 0);
    _pole.normalize();
    const cosA = clamp((G_L1 * G_L1 + dist * dist - G_L2 * G_L2) / (2 * G_L1 * dist), -1, 1);
    const sinA = Math.sqrt(1 - cosA * cosA);
    _thighDir.copy(_d).multiplyScalar(cosA).addScaledVector(_pole, sinA);
    // knee = hip + thighDir * L1 ; ankle = hip + d * dist
    _shinDir.copy(_d).multiplyScalar(dist).addScaledVector(_thighDir, -G_L1).normalize();
    _qThigh.setFromUnitVectors(G_REST_THIGH[i], _thighDir);
    _qShin.setFromUnitVectors(G_REST_SHIN[i], _shinDir);
    thigh.quaternion.copy(_qThigh);
    shin.quaternion.copy(_qThigh).invert().multiply(_qShin);
    _qFoot.setFromAxisAngle(X_AXIS, footPitch);
    foot.quaternion.copy(_qShin).invert().multiply(_qFoot);
  }

  // ── turret / control turret ──
  private updateTurret(dt: number, time: number, yaw: number, aimYaw: number, aimPitch: number, alert: boolean, pose: boolean): void {
    const bn = this.bones;
    // ── animation state (advances whether the view is drawn or not) ──
    const scan = Math.sin(time * 0.4 + this.seed);
    const targetYaw = alert ? aimYaw : yaw + 0.75 * scan;
    const targetPitch = alert ? clamp(aimPitch, -0.45, 1.1) : 0.05 * Math.sin(time * 0.63 + this.seed);
    const k = damp(alert ? 18 : 3, dt);
    this.aimYaw += wrapAngle(targetYaw - this.aimYaw) * k;
    this.aimPitch += (targetPitch - this.aimPitch) * k;
    if (!pose) return;

    // ── pose ──
    bn[T_ROOT].rotation.y = this.baseYaw; // the mount never turns
    bn[T_HEAD].rotation.y = this.aimYaw - this.baseYaw;
    const gun = bn[T_GUN];
    gun.rotation.x = this.aimPitch;
    gun.position.z = T_GUN_P[2] + this.recoil * 0.16 * Math.abs(Math.sin(time * 12.6));

    if (this.model !== 'control') return;
    // rotating beacon + precessing halo ring
    const spin = time * 5.2 + this.seed;
    bn[T_BEACON].rotation.y = spin;
    const ring = bn[T_RING];
    ring.rotation.set(0.3, time * 0.7 + this.seed, 0);
    ring.position.y = T_RING_P[1] - T_MAST_BASE[1] + 0.06 * Math.sin(time * 1.6 + this.seed);

    // lighthouse sweep: the halo flares when one of the two lamp lobes points at the camera
    let lobe = 0.5 + 0.5 * Math.cos(spin * 2);
    if (this.hasCam) {
      // (the group's own position: its world matrix is not refreshed while the view is hidden)
      const gp = this.group.position;
      const dx = this.camPos.x - gp.x;
      const dz = this.camPos.z - gp.z;
      const dl = Math.hypot(dx, dz);
      if (dl > 1e-3) {
        const phi = this.aimYaw + spin; // world yaw of the rotor (mount yaw + head yaw + spin)
        const facing = (-Math.sin(phi) * dx - Math.cos(phi) * dz) / dl;
        lobe = facing * facing;
      }
    }
    const flare = lobe * lobe * lobe;
    const size = 1.3 + 3.4 * flare;
    this.beaconHalo!.scale.set(size, size, 1);
  }

  // ── sensor colour, telegraph flash, muzzle charge ──
  private updateLights(time: number, telegraph: number, alert: boolean): void {
    const s = this.shared;
    const guard = this.model === 'guard';
    let body: THREE.Material;
    let halo: THREE.SpriteMaterial;
    let haloSize: number;
    const flicker = 1 + 0.06 * Math.sin(time * 23 + this.seed * 3);
    if (telegraph > 0) {
      // rapid flashing locked to the telegraph progress: guard 3 flashes in 0.15 s, turret 5 in 0.35 s
      const on = (telegraph * (guard ? 3 : 5)) % 1 < 0.55;
      body = on ? s.bodyFlash : s.bodyRed;
      halo = on ? s.haloWhite : s.haloRed;
      haloSize = (on ? 1.9 : 1.1) * (guard ? 1 : 1.25);
      const grow = Math.pow(telegraph, 0.7);
      const size = (guard ? 0.7 + 1.5 * grow : 1.0 + 2.4 * grow) * (on ? 1.1 : 0.85);
      const mat = guard ? (on ? s.chargeGuard : s.chargeGuardDim) : on ? s.chargeTurret : s.chargeTurretDim;
      for (let i = 0; i < this.charges.length; i++) {
        const c = this.charges[i];
        c.visible = true;
        c.material = mat;
        c.scale.set(size, size, 1);
      }
    } else {
      for (let i = 0; i < this.charges.length; i++) this.charges[i].visible = false;
      if (alert) {
        body = s.bodyRed;
        halo = s.haloRed;
        haloSize = (guard ? 1.25 : 1.5) * flicker;
      } else if (guard) {
        body = s.bodyOrange;
        halo = s.haloOrange;
        haloSize = 0.95;
      } else {
        body = s.bodyRedDim;
        halo = s.haloRed;
        haloSize = 0.9;
      }
    }
    if (body !== this.bodyMat) {
      this.bodyMat = body;
      if (this.liveMaterials) this.liveMaterials[0] = body;
      else this.live.material = body;
    }
    this.sensor.material = halo;
    this.sensor.scale.set(haloSize, haloSize, 1);
  }

  // ── damage sparks (short white-orange flickers on the hull below 45 % HP) ──
  private updateDamage(dt: number, hp: number, telegraph: number): void {
    const spark = this.spark;
    if (hp >= 0.45 || telegraph > 0) {
      spark.visible = false;
      return;
    }
    if (this.sparkShow > 0) {
      this.sparkShow -= dt;
      if (this.sparkShow <= 0) spark.visible = false;
      return;
    }
    this.sparkTimer -= dt;
    if (this.sparkTimer > 0) return;
    this.sparkTimer = (0.12 + Math.random() * 0.7) * (0.5 + hp * 2.5);
    this.sparkShow = 0.04 + Math.random() * 0.05;
    const a = Math.random() * TWO_PI;
    const r = this.model === 'guard' ? 0.55 : 0.8;
    spark.position.set(Math.sin(a) * r, 0.1 + Math.random() * 0.7, Math.cos(a) * r);
    const size = 0.35 + Math.random() * 0.5;
    spark.scale.set(size, size, 1);
    spark.visible = true;
  }

  // ── destroyed ──
  private enterWreck(yaw: number): void {
    this.dead = true;
    const s = this.shared;
    this.group.remove(this.bones[0], this.live);
    this.spark.visible = false;
    for (let i = 0; i < this.charges.length; i++) this.charges[i].visible = false;
    if (!this.wreck) {
      this.wreck = new THREE.Mesh(this.assets.wreck, s.wreckMat);
      this.wreck.castShadow = false;
      this.ember = new THREE.Sprite(s.ember);
      const guard = this.model === 'guard';
      this.ember.position.set(0, guard ? GUARD_FLOOR + 0.75 : TURRET_FLOOR + 1.5, 0);
      const es = guard ? 3.0 : 3.8;
      this.ember.scale.set(es, es * 0.8, 1);
    }
    // keep the heading the machine had when it died (turret: where the head pointed)
    this.wreck.rotation.y = this.first ? yaw : this.model === 'guard' ? this.bodyYaw : this.baseYaw;
    this.group.add(this.wreck, this.ember!);
  }

  private leaveWreck(): void {
    this.dead = false;
    this.first = true;
    if (this.wreck) this.group.remove(this.wreck);
    if (this.ember) this.group.remove(this.ember);
    this.group.add(this.bones[0], this.live);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.group.clear();
    this.group.removeFromParent();
    this.skeleton.dispose(); // per-instance bone texture
    releaseShared(); // shared geometries / materials / textures go when the last view is disposed
  }
}
