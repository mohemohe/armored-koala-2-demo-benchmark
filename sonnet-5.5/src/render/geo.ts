/**
 * Geometry helpers for the renderer: a tiny append-only mesh builder that writes position / normal / uv / vertex-color
 * into plain arrays, so many boxes / primitives can be merged into one BufferGeometry (few draw calls).
 * No DOM. Runs in Node (vitest).
 */
import {
  BufferGeometry,
  CapsuleGeometry,
  ConeGeometry,
  CylinderGeometry,
  Euler,
  Float32BufferAttribute,
  Matrix3,
  Matrix4,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three';
import type { V3 } from '../sim/math';

export type RGB = readonly [number, number, number];

interface FaceDef {
  n: readonly [number, number, number];
  tu: readonly [number, number, number];
  tv: readonly [number, number, number];
}

/** outward normal + tangent axes with tu x tv = n (so corners (0,0)(1,0)(1,1)(0,1) are CCW seen from outside) */
const FACES: FaceDef[] = [
  { n: [1, 0, 0], tu: [0, 0, -1], tv: [0, 1, 0] },
  { n: [-1, 0, 0], tu: [0, 0, 1], tv: [0, 1, 0] },
  { n: [0, 1, 0], tu: [1, 0, 0], tv: [0, 0, -1] },
  { n: [0, -1, 0], tu: [1, 0, 0], tv: [0, 0, 1] },
  { n: [0, 0, 1], tu: [1, 0, 0], tv: [0, 1, 0] },
  { n: [0, 0, -1], tu: [-1, 0, 0], tv: [0, 1, 0] },
];

const _v = new Vector3();
const _m3 = new Matrix3();

export interface AddOpts {
  /** metres per texture repeat (uv = coordinate / tile). default 4 */
  tile?: number;
  color?: RGB;
  /** local -> output transform applied to positions / normals */
  matrix?: Matrix4;
  /** when true uv is computed from the *transformed* (world) position; otherwise from the local box coordinates */
  worldUv?: boolean;
}

export class GeoBuilder {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  idx: number[] = [];
  /** when true every vertex also records `curFloor` (attribute `aFloorY`, used by the stage grime shader) */
  trackFloor = false;
  curFloor = 0;
  flo: number[] = [];

  get vertexCount(): number {
    return this.pos.length / 3;
  }
  get triangleCount(): number {
    return this.idx.length / 3;
  }
  get isEmpty(): boolean {
    return this.idx.length === 0;
  }

  /** axis-aligned box from min/max (local coordinates, then optional matrix) */
  addBox(min: V3, max: V3, opts: AddOpts = {}): this {
    const tile = opts.tile ?? 4;
    const color = opts.color ?? [1, 1, 1];
    const m = opts.matrix;
    const nm = m ? _m3.getNormalMatrix(m) : null;
    const cx = (min.x + max.x) / 2;
    const cy = (min.y + max.y) / 2;
    const cz = (min.z + max.z) / 2;
    const h = [(max.x - min.x) / 2, (max.y - min.y) / 2, (max.z - min.z) / 2];
    const c = [cx, cy, cz];
    for (const f of FACES) {
      const base = this.vertexCount;
      const an = f.n[0] !== 0 ? 0 : f.n[1] !== 0 ? 1 : 2;
      const au = f.tu[0] !== 0 ? 0 : f.tu[1] !== 0 ? 1 : 2;
      const av = f.tv[0] !== 0 ? 0 : f.tv[1] !== 0 ? 1 : 2;
      const corners: [number, number][] = [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ];
      for (const [su, sv] of corners) {
        const p = [c[0], c[1], c[2]];
        p[an] += f.n[an] * h[an];
        p[au] += f.tu[au] * su * h[au];
        p[av] += f.tv[av] * sv * h[av];
        let u = (p[0] * f.tu[0] + p[1] * f.tu[1] + p[2] * f.tu[2]) / tile;
        let v = (p[0] * f.tv[0] + p[1] * f.tv[1] + p[2] * f.tv[2]) / tile;
        _v.set(p[0], p[1], p[2]);
        if (m) _v.applyMatrix4(m);
        if (opts.worldUv && m) {
          u = (_v.x * f.tu[0] + _v.y * f.tu[1] + _v.z * f.tu[2]) / tile;
          v = (_v.x * f.tv[0] + _v.y * f.tv[1] + _v.z * f.tv[2]) / tile;
        }
        this.pos.push(_v.x, _v.y, _v.z);
        if (nm) {
          _v.set(f.n[0], f.n[1], f.n[2]).applyMatrix3(nm).normalize();
          this.nor.push(_v.x, _v.y, _v.z);
        } else this.nor.push(f.n[0], f.n[1], f.n[2]);
        this.uv.push(u, v);
        this.col.push(color[0], color[1], color[2]);
        if (this.trackFloor) this.flo.push(this.curFloor);
      }
      this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    return this;
  }

  /** box given by center + full size, optionally rotated by matrix */
  addBoxC(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, opts: AddOpts = {}): this {
    return this.addBox({ x: cx - sx / 2, y: cy - sy / 2, z: cz - sz / 2 }, { x: cx + sx / 2, y: cy + sy / 2, z: cz + sz / 2 }, opts);
  }

  /** append an arbitrary indexed BufferGeometry (Sphere/Cylinder/...) through `matrix`; uv scaled by uvMul */
  addGeometry(g: BufferGeometry, matrix: Matrix4, color: RGB = [1, 1, 1], uvMul: readonly [number, number] = [1, 1]): this {
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    const t = g.getAttribute('uv');
    const base = this.vertexCount;
    const nm = _m3.getNormalMatrix(matrix);
    for (let i = 0; i < p.count; i++) {
      _v.fromBufferAttribute(p, i).applyMatrix4(matrix);
      this.pos.push(_v.x, _v.y, _v.z);
      if (n) {
        _v.fromBufferAttribute(n, i).applyMatrix3(nm).normalize();
        this.nor.push(_v.x, _v.y, _v.z);
      } else this.nor.push(0, 1, 0);
      if (t) this.uv.push(t.getX(i) * uvMul[0], t.getY(i) * uvMul[1]);
      else this.uv.push(0, 0);
      this.col.push(color[0], color[1], color[2]);
      if (this.trackFloor) this.flo.push(this.curFloor);
    }
    const ix = g.getIndex();
    if (ix) for (let i = 0; i < ix.count; i++) this.idx.push(base + ix.getX(i));
    else for (let i = 0; i < p.count; i++) this.idx.push(base + i);
    return this;
  }

  /** sphere (optionally ellipsoid via scale) centered at c */
  addSphere(c: V3, rx: number, ry = rx, rz = rx, color: RGB = [1, 1, 1], seg = 14, matrix?: Matrix4): this {
    const g = new SphereGeometry(1, seg, Math.max(6, Math.round(seg * 0.7)));
    const m = new Matrix4().makeScale(rx, ry, rz).setPosition(c.x, c.y, c.z);
    if (matrix) m.premultiply(matrix);
    this.addGeometry(g, m, color, [2, 1]);
    g.dispose();
    return this;
  }

  /** cylinder along Y (unit radius scaled) centered at c; `matrix` (rotation) is applied afterwards */
  addCylinder(c: V3, radiusTop: number, radiusBottom: number, height: number, color: RGB = [1, 1, 1], seg = 12, matrix?: Matrix4, uvMul: readonly [number, number] = [1, 1]): this {
    const g = new CylinderGeometry(radiusTop, radiusBottom, height, seg, 1);
    const m = new Matrix4().makeTranslation(c.x, c.y, c.z);
    if (matrix) m.premultiply(matrix);
    this.addGeometry(g, m, color, uvMul);
    g.dispose();
    return this;
  }

  addCone(c: V3, radius: number, height: number, color: RGB = [1, 1, 1], seg = 10, matrix?: Matrix4): this {
    const g = new ConeGeometry(radius, height, seg, 1);
    const m = new Matrix4().makeTranslation(c.x, c.y, c.z);
    if (matrix) m.premultiply(matrix);
    this.addGeometry(g, m, color);
    g.dispose();
    return this;
  }

  addCapsule(c: V3, radius: number, length: number, color: RGB = [1, 1, 1], matrix?: Matrix4): this {
    const g = new CapsuleGeometry(radius, length, 4, 10);
    const m = new Matrix4().makeTranslation(c.x, c.y, c.z);
    if (matrix) m.premultiply(matrix);
    this.addGeometry(g, m, color);
    g.dispose();
    return this;
  }

  addTorus(c: V3, radius: number, tube: number, color: RGB = [1, 1, 1], matrix?: Matrix4): this {
    const g = new TorusGeometry(radius, tube, 8, 20);
    const m = new Matrix4().makeTranslation(c.x, c.y, c.z);
    if (matrix) m.premultiply(matrix);
    this.addGeometry(g, m, color);
    g.dispose();
    return this;
  }

  build(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new Float32BufferAttribute(this.col, 3));
    if (this.trackFloor) g.setAttribute('aFloorY', new Float32BufferAttribute(this.flo, 1));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/** rotation matrix helpers */
export const rotX = (a: number): Matrix4 => new Matrix4().makeRotationX(a);
export const rotY = (a: number): Matrix4 => new Matrix4().makeRotationY(a);
export const rotZ = (a: number): Matrix4 => new Matrix4().makeRotationZ(a);
/** compose translate * rotXYZ * scale */
export function trs(px: number, py: number, pz: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1): Matrix4 {
  const m = new Matrix4();
  const q = new Matrix4().makeRotationFromEuler(new Euler(rx, ry, rz, 'YXZ'));
  m.makeScale(sx, sy, sz);
  m.premultiply(q);
  m.setPosition(px, py, pz);
  return m;
}

/** deterministic hash of a string -> [0,1) (visual variation only; never used by the simulation) */
export function hash01(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995) >>> 0;
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** small deterministic PRNG for procedural textures / visual randomness */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
