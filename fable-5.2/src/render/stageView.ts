/**
 * StageView — turns any StageDef (axis-aligned solids + decor + barriers + gate + exit zone) into a lit,
 * textured three.js scene graph (docs/SPEC.md §8, §2.2).
 *
 * What is drawn equals what collides: every solid box is drawn exactly, barriers / the final gate are real
 * doors that fill their collision box until they open (and are hidden completely afterwards), decor is
 * drawn where the stage definition puts it. Nothing here adds or removes collision.
 *
 * Rendering design
 *  - ONE material for all opaque stage surfaces: a patched MeshStandardMaterial that samples the procedural
 *    texture arrays of textures.ts by a per-vertex layer index (world-space UVs projected per face, macro
 *    variation + grain to hide tiling, bump mapping from the height array, per-pixel roughness).
 *    → one draw call per geometry chunk (chunk = sector, or a 64 m XZ cell for solids without a sector).
 *  - Lamp lighting is BAKED per vertex at load: faces are tessellated on a world-aligned 4 m grid and every
 *    vertex gathers the lamps (emissive decor) around it with distance falloff, N·L and a soft occlusion
 *    march through a coarse voxel occupancy volume. No per-frame cost, no light "bubble" around the camera.
 *    The stage material ignores real point lights; the small pool of PointLights owned by this view (moved
 *    to the lamps nearest the focus point) only lights dynamic objects (mech, enemies).
 *  - The same occupancy volume (R8 3D texture) gives ambient occlusion in the fragment shader: corners,
 *    wall bases and crevices darken, so boxes sit on the floor instead of floating.
 *  - Readability aids generated from the collision boxes: worn safety-yellow lines along every walkable
 *    ledge with a drop (on the top edge and on the slab side, so they show from above and from below),
 *    darker undersides, per-box tint variation.
 *  - Emissive lamps are one unlit mesh per chunk (blink handled in the vertex shader), their soft halos are
 *    one instanced billboard draw for the whole stage.
 *  - Wayfinding markings (StageDef.markings: stencilled ids, chevrons, hazard bands) are flat decals — paint
 *    lit like the surface below it, or illuminated sign faces — merged into the chunk meshes. Markings and
 *    warning plates that belong to a barrier / the gate follow its state (red while closed, green once open).
 *  - A few solids get a more specific look from their tag (pipe racks, conveyor tops, storage racks).
 *
 * Coordinates: the group stays at the origin (geometry is in world space).
 */
import * as THREE from 'three';
import type { Box, DecorDef, MarkingDef, SolidDef, SolidMaterial, StageDef } from '../sim/types';
import { LAYER, LAYER_BUMP, LAYER_COUNT, LAYER_METALNESS, LAYER_TILE_M, acquireStageTextures, getStageTextureBytes, releaseStageTextures } from './textures';

type RGB = readonly [number, number, number];
type P3 = { x: number; y: number; z: number };

// ───────────────────────────── tunables ─────────────────────────────
/** Tessellation step (m) of large faces — the resolution of the baked lamp light. */
const TESS = 4;
/** Baked irradiance is stored as normalised u16 × BAKE_MAX. */
const BAKE_MAX = 8;
/** XZ cell size (m) of chunks for geometry without a sector id. */
const CHUNK_GRID = 64;
/** XZ cell size (m) of the solid / lamp lookup grids. */
const CELL = 16;
/** Chunks farther than this from the camera are not drawn (far beyond the fog). */
const CHUNK_DRAW_DISTANCE = 340;
const DOOR_OPEN_SECONDS = 0.42;
const POOL_LIGHTS = 4;
const EPS = 1e-4;

const LEDGE_TINT: RGB = [0.93, 0.7, 0.13];

interface MatInfo {
  layer: number;
  tints: readonly RGB[];
  /** ± brightness variation per box */
  vary: number;
  /** baked/dynamic lighting skipped (out-of-bounds filler) */
  dark?: boolean;
  /** texture coordinates start at the box corner (panels / corrugation line up with the object) */
  local?: boolean;
}
const W1: RGB = [1, 1, 1];
const MAT: Record<SolidMaterial, MatInfo> = {
  floor: { layer: LAYER.floor, tints: [W1], vary: 0.05 },
  wall: { layer: LAYER.wall, tints: [W1, [0.96, 0.97, 1], [1, 0.98, 0.95]], vary: 0.05 },
  roof: { layer: LAYER.roof, tints: [W1], vary: 0.05 },
  concrete: { layer: LAYER.concrete, tints: [W1, [0.95, 0.94, 0.92], [0.9, 0.92, 0.94]], vary: 0.08 },
  metal: { layer: LAYER.metal, tints: [W1, [0.9, 0.95, 1], [1, 0.97, 0.9]], vary: 0.08 },
  rust: { layer: LAYER.rust, tints: [W1, [1, 0.92, 0.86], [0.9, 0.94, 1]], vary: 0.1 },
  hazard: { layer: LAYER.hazard, tints: [W1], vary: 0.04 },
  catwalk: { layer: LAYER.catwalk, tints: [W1, [0.94, 0.97, 1]], vary: 0.05 },
  machine: {
    layer: LAYER.machine,
    tints: [
      [0.6, 0.74, 0.66],
      [0.64, 0.72, 0.82],
      [0.86, 0.77, 0.55],
      [0.7, 0.71, 0.7],
      [0.56, 0.66, 0.6],
    ],
    vary: 0.06,
    local: true,
  },
  container: {
    layer: LAYER.container,
    tints: [
      [0.66, 0.27, 0.2],
      [0.22, 0.44, 0.55],
      [0.78, 0.6, 0.22],
      [0.36, 0.5, 0.35],
      [0.62, 0.63, 0.62],
      [0.76, 0.42, 0.18],
      [0.3, 0.36, 0.48],
    ],
    vary: 0.06,
    local: true,
  },
  pipe: {
    layer: LAYER.pipe,
    tints: [W1, [0.8, 0.86, 0.84], [0.9, 0.78, 0.6], [0.72, 0.78, 0.86]],
    vary: 0.06,
  },
  dark: { layer: LAYER.concrete, tints: [[0.1, 0.105, 0.115]], vary: 0, dark: true },
};

/** Emissive decor: HDR radiance of the lamp face (linear), tint of the cast light, relative power. */
const LIGHTS: Record<string, { face: RGB; light: RGB; gain: number }> = {
  'light-warm': { face: [2.7, 1.8, 0.95], light: [1.0, 0.74, 0.44], gain: 1 },
  'light-cyan': { face: [0.5, 2.0, 2.4], light: [0.3, 0.86, 1.0], gain: 0.85 },
  'light-amber': { face: [2.8, 1.35, 0.18], light: [1.0, 0.55, 0.1], gain: 0.6 },
  'light-red': { face: [2.8, 0.2, 0.12], light: [1.0, 0.13, 0.08], gain: 0.6 },
};
const LAMP_RED: RGB = [2.8, 0.2, 0.12];
const LAMP_GREEN: RGB = [0.3, 2.5, 0.75];
const LAMP_AMBER: RGB = [2.8, 1.35, 0.18];

/** Painted marking styles: texture layer + tint. */
const MARK_PAINT: Partial<Record<MarkingDef['style'], { layer: number; tint: RGB }>> = {
  yellow: { layer: LAYER.paint, tint: [0.95, 0.72, 0.12] },
  white: { layer: LAYER.paint, tint: [1, 0.99, 0.95] },
  hazard: { layer: LAYER.hazard, tint: [1, 1, 1] },
  dark: { layer: LAYER.metal, tint: [0.16, 0.175, 0.2] },
};
/** Illuminated marking styles: HDR radiance of the sign face. */
const MARK_GLOW: Partial<Record<MarkingDef['style'], RGB>> = {
  'glow-amber': [2.5, 1.25, 0.2],
  'glow-red': [2.8, 0.25, 0.16],
  'glow-green': [0.3, 2.4, 0.75],
  'glow-cyan': [0.45, 1.9, 2.3],
};
/** Halo tint of the warning plates of a door that has opened. */
const HALO_OPEN: RGB = [0.2, 1.0, 0.42];

/**
 * Looks selected by SolidDef.tag (the material stays the fallback): a different texture layer on the sides
 * and / or the top, optionally with the texture's run direction turned along the solid's long axis.
 */
interface TagLook {
  side?: number;
  top?: number;
  /** the texture runs along u: turn it along the solid's long axis (horizontal) or upright ('up') */
  run?: 'long' | 'up';
  /** tint override (the layer carries its own colours) */
  tint?: RGB;
}
const TAG_LOOK: Record<string, TagLook> = {
  'pipe-bundle': { side: LAYER.pipes, top: LAYER.pipes, run: 'long', tint: [1, 1, 1] },
  'pipe-block': { side: LAYER.pipes, run: 'up', tint: [0.92, 0.95, 1] },
  conveyor: { top: LAYER.belt, run: 'long' },
  'roller-table': { top: LAYER.belt, run: 'long' },
  'storage-rack': { side: LAYER.shelves, top: LAYER.metal, tint: [1, 1, 1] },
};

function hash3(x: number, y: number, z: number): number {
  let h = (Math.imul(Math.round(x * 8), 374761393) + Math.imul(Math.round(y * 8), 668265263) + Math.imul(Math.round(z * 8), 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

// ───────────────────────────── 5×7 stencil font (door markings, exit sign) ─────────────────────────────
const FONT: Record<string, readonly string[]> = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
  '/': ['00001', '00001', '00010', '00100', '01000', '10000', '10000'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
};
/** Horizontal pixel runs [x0, y0, x1, y1] (x right, y up, glyph cell = 5×7, 1 px gap) and the total width. */
function glyphRuns(text: string): { runs: number[][]; width: number } {
  const runs: number[][] = [];
  let cx = 0;
  for (const ch of text.toUpperCase()) {
    const g = FONT[ch];
    if (g) {
      for (let row = 0; row < 7; row++) {
        const line = g[row]!;
        let x = 0;
        while (x < 5) {
          if (line[x] !== '1') {
            x++;
            continue;
          }
          let e = x;
          while (e < 5 && line[e] === '1') e++;
          runs.push([cx + x, 6 - row, cx + e, 7 - row]);
          x = e;
        }
      }
    }
    cx += 6;
  }
  return { runs, width: Math.max(0, cx - 1) };
}

// ───────────────────────────── geometry buffers ─────────────────────────────
class GeoBuf {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly uv: number[] = [];
  readonly tint: number[] = [];
  readonly baked: number[] = [];
  readonly idx: number[] = [];
  count = 0;
  /** Draw-order runs: [first index, sort key] of every surface emitted through `surface()`. */
  private readonly runStart: number[] = [];
  private readonly runKey: number[] = [];

  /**
   * Starts a new surface (everything emitted until the next call) with its area in m² as the draw-order key.
   * The index buffer is written smallest surface first (see `orderedIndices`). `Infinity` = an overlay (paint,
   * ledge line) that is drawn after everything else of its chunk.
   */
  surface(area: number): void {
    this.runStart.push(this.idx.length);
    this.runKey.push(area);
  }

  /**
   * The triangle list with the surfaces in ascending order of area. Inside a room the large surfaces are the
   * shell (floor, walls, roof) and the big slabs — what everything else stands in front of. Drawing them last
   * lets the depth test reject most of their hidden fragments before the (expensive) stage shader runs.
   * Opaque geometry only: the picture does not depend on the order — except where two surfaces are closer
   * together than the depth buffer resolves (with near 0.2 m and 24 bits: 2 cm beyond ≈ 260 m, 3 cm beyond
   * ≈ 320 m), where the one drawn later wins. Paint and ledge lines lie 2–4 cm in front of their surface and
   * were always emitted after it; they keep that by being drawn last (key Infinity), whatever their size.
   */
  private orderedIndices(): number[] {
    const n = this.runStart.length;
    if (n < 2 || this.runStart[0] !== 0) return this.idx;
    const order = new Array<number>(n);
    for (let i = 0; i < n; i++) order[i] = i;
    order.sort((a, b) => this.runKey[a]! - this.runKey[b]! || a - b);
    const out = new Array<number>(this.idx.length);
    let o = 0;
    for (let k = 0; k < n; k++) {
      const r = order[k]!;
      const end = r + 1 < n ? this.runStart[r + 1]! : this.idx.length;
      for (let i = this.runStart[r]!; i < end; i++) out[o++] = this.idx[i]!;
    }
    return out;
  }

  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number, r: number, g: number, b: number, layer: number, br: number, bg: number, bb: number): number {
    this.pos.push(x, y, z);
    this.nrm.push(Math.round(nx * 127), Math.round(ny * 127), Math.round(nz * 127));
    this.uv.push(u, v);
    this.tint.push(Math.round(clamp(r, 0, 1) * 255), Math.round(clamp(g, 0, 1) * 255), Math.round(clamp(b, 0, 1) * 255), layer);
    const k = 65535 / BAKE_MAX;
    this.baked.push(Math.round(clamp(br * k, 0, 65535)), Math.round(clamp(bg * k, 0, 65535)), Math.round(clamp(bb * k, 0, 65535)));
    return this.count++;
  }
  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }
  get triangles(): number {
    return this.idx.length / 3;
  }
  /** `ordered` = false keeps the emit order (blended geometry, where the order of the triangles shows). */
  toGeometry(ordered = true): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Int8Array(this.nrm), 3, true));
    g.setAttribute('aUv', new THREE.BufferAttribute(new Float32Array(this.uv), 2));
    g.setAttribute('aTint', new THREE.BufferAttribute(new Uint8Array(this.tint), 4, true));
    g.setAttribute('aBaked', new THREE.BufferAttribute(new Uint16Array(this.baked), 3, true));
    const idx = ordered ? this.orderedIndices() : this.idx;
    g.setIndex(new THREE.BufferAttribute(this.count > 65535 ? new Uint32Array(idx) : new Uint16Array(idx), 1));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

/** Unlit emissive boxes (lamp faces). */
class LampBuf {
  readonly pos: number[] = [];
  readonly col: number[] = [];
  readonly face: number[] = [];
  readonly blink: number[] = [];
  readonly idx: number[] = [];
  count = 0;

  box(b: Box, c: RGB, blink: number): void {
    const { min, max } = b;
    const dx = max.x - min.x;
    const dy = max.y - min.y;
    const dz = max.z - min.z;
    // [axis, sign]
    for (let f = 0; f < 6; f++) {
      const axis = f >> 1;
      const sign = (f & 1) === 0 ? 1 : -1;
      const coord = axis === 0 ? (sign > 0 ? max.x : min.x) : axis === 1 ? (sign > 0 ? max.y : min.y) : sign > 0 ? max.z : min.z;
      const a0 = axis === 0 ? min.z : min.x;
      const a1 = axis === 0 ? max.z : max.x;
      const b0 = axis === 1 ? min.z : min.y;
      const b1 = axis === 1 ? max.z : max.y;
      const w = axis === 0 ? dz : dx;
      const h = axis === 1 ? dz : dy;
      const base = this.count;
      for (let k = 0; k < 4; k++) {
        const a = k === 0 || k === 3 ? a0 : a1;
        const bb = k < 2 ? b0 : b1;
        if (axis === 0) this.pos.push(coord, bb, a);
        else if (axis === 1) this.pos.push(a, coord, bb);
        else this.pos.push(a, bb, coord);
        this.col.push(c[0], c[1], c[2]);
        this.face.push(k === 0 || k === 3 ? 0 : 1, k < 2 ? 0 : 1, w, h);
        this.blink.push(blink);
        this.count++;
      }
      const flip = axis === 2 ? sign < 0 : sign > 0;
      if (flip) this.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
      else this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  /** One flat face of uniform brightness (sign glyphs): corners counter-clockwise seen from the front. */
  quad(p: readonly number[], c: RGB, blink: number): void {
    const base = this.count;
    for (let k = 0; k < 4; k++) {
      this.pos.push(p[k * 3]!, p[k * 3 + 1]!, p[k * 3 + 2]!);
      this.col.push(c[0], c[1], c[2]);
      // centre of a large virtual face: no dark rim, ribs at their maximum (see LAMP_FRAG)
      this.face.push(0.5, 0.5, 11.968, 11.968);
      this.blink.push(blink);
      this.count++;
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  toGeometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(this.col), 3));
    g.setAttribute('aFace', new THREE.BufferAttribute(new Float32Array(this.face), 4));
    g.setAttribute('aBlink', new THREE.BufferAttribute(new Float32Array(this.blink), 1));
    g.setIndex(new THREE.BufferAttribute(this.count > 65535 ? new Uint32Array(this.idx) : new Uint16Array(this.idx), 1));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

// ───────────────────────────── occupancy volume ─────────────────────────────
class Occupancy {
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly voxel: number;
  readonly ox: number;
  readonly oy: number;
  readonly oz: number;
  readonly data: Uint8Array;

  constructor(solids: readonly SolidDef[]) {
    let x0 = Infinity;
    let y0 = Infinity;
    let z0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    let z1 = -Infinity;
    for (const s of solids) {
      if (s.min.x < x0) x0 = s.min.x;
      if (s.min.y < y0) y0 = s.min.y;
      if (s.min.z < z0) z0 = s.min.z;
      if (s.max.x > x1) x1 = s.max.x;
      if (s.max.y > y1) y1 = s.max.y;
      if (s.max.z > z1) z1 = s.max.z;
    }
    if (!(x1 > x0)) {
      x0 = y0 = z0 = 0;
      x1 = y1 = z1 = 2;
    }
    let voxel = 2;
    const count = (v: number): number => (Math.ceil((x1 - x0) / v) + 2) * (Math.ceil((y1 - y0) / v) + 2) * (Math.ceil((z1 - z0) / v) + 2);
    while (count(voxel) > 4.2e6) voxel *= 1.25;
    this.voxel = voxel;
    // snap the origin to the voxel lattice so 2 m-aligned geometry fills whole voxels
    this.ox = Math.floor(x0 / voxel) * voxel - voxel;
    this.oy = Math.floor(y0 / voxel) * voxel - voxel;
    this.oz = Math.floor(z0 / voxel) * voxel - voxel;
    this.nx = Math.ceil((x1 - this.ox) / voxel) + 1;
    this.ny = Math.ceil((y1 - this.oy) / voxel) + 1;
    this.nz = Math.ceil((z1 - this.oz) / voxel) + 1;
    this.data = new Uint8Array(this.nx * this.ny * this.nz);
    const inv = 1 / voxel;
    for (const s of solids) {
      const ix0 = Math.max(0, Math.floor((s.min.x - this.ox) * inv));
      const ix1 = Math.min(this.nx - 1, Math.floor((s.max.x - this.ox) * inv - 1e-6));
      const iy0 = Math.max(0, Math.floor((s.min.y - this.oy) * inv));
      const iy1 = Math.min(this.ny - 1, Math.floor((s.max.y - this.oy) * inv - 1e-6));
      const iz0 = Math.max(0, Math.floor((s.min.z - this.oz) * inv));
      const iz1 = Math.min(this.nz - 1, Math.floor((s.max.z - this.oz) * inv - 1e-6));
      for (let iz = iz0; iz <= iz1; iz++) {
        const vz0 = this.oz + iz * voxel;
        const fz = (Math.min(s.max.z, vz0 + voxel) - Math.max(s.min.z, vz0)) * inv;
        for (let iy = iy0; iy <= iy1; iy++) {
          const vy0 = this.oy + iy * voxel;
          const fy = (Math.min(s.max.y, vy0 + voxel) - Math.max(s.min.y, vy0)) * inv;
          const row = (iz * this.ny + iy) * this.nx;
          for (let ix = ix0; ix <= ix1; ix++) {
            const vx0 = this.ox + ix * voxel;
            const fx = (Math.min(s.max.x, vx0 + voxel) - Math.max(s.min.x, vx0)) * inv;
            const v = this.data[row + ix]! + fx * fy * fz * 255;
            this.data[row + ix] = v > 255 ? 255 : v;
          }
        }
      }
    }
  }

  /** Nearest-voxel coverage 0..1 (0 outside the volume). */
  sample(x: number, y: number, z: number): number {
    const inv = 1 / this.voxel;
    const ix = Math.floor((x - this.ox) * inv);
    const iy = Math.floor((y - this.oy) * inv);
    const iz = Math.floor((z - this.oz) * inv);
    if (ix < 0 || iy < 0 || iz < 0 || ix >= this.nx || iy >= this.ny || iz >= this.nz) return 0;
    return this.data[(iz * this.ny + iy) * this.nx + ix]! * (1 / 255);
  }
}

// ───────────────────────────── lamps ─────────────────────────────
interface Lamp {
  /** emitting point (panel centre pushed out of its mount) */
  x: number;
  y: number;
  z: number;
  /** emission axis for flat panels, (0,0,0) for omnidirectional strips */
  dx: number;
  dy: number;
  dz: number;
  r: number;
  g: number;
  b: number;
  power: number;
  range: number;
  /** -1 = steady, otherwise blink phase 0..1 */
  blink: number;
  haloSize: number;
  /** warning plate mounted at this barrier / gate (follows its state) */
  door?: string;
}

// ───────────────────────────── shaders ─────────────────────────────
const BLINK_GLSL = /* glsl */ `
float ak2Blink(float phase, float time) {
  if (phase < 0.0) return 1.0;
  if (phase >= 2.0) {
    // chase: never dark, a brighter pulse runs along the sequence (phase - 2 = position 0..1 in it)
    float pc = fract(time * 0.8 - (phase - 2.0));
    return 0.5 + 0.5 * smoothstep(0.0, 0.08, pc) * (1.0 - smoothstep(0.25, 0.5, pc));
  }
  float ph = fract(time * 0.85 + phase);
  return 0.1 + 0.9 * smoothstep(0.0, 0.06, ph) * (1.0 - smoothstep(0.42, 0.56, ph));
}`;

const LAMP_VERT = /* glsl */ `
attribute vec3 aColor;
attribute vec4 aFace;
attribute float aBlink;
uniform float uTime;
varying vec3 vLampColor;
varying vec4 vFace;
#include <common>
#include <fog_pars_vertex>
${BLINK_GLSL}
void main() {
  vLampColor = aColor * ak2Blink(aBlink, uTime);
  vFace = aFace;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const LAMP_FRAG = /* glsl */ `
varying vec3 vLampColor;
varying vec4 vFace;
#include <common>
#include <fog_pars_fragment>
void main() {
  vec2 d = min(vFace.xy, 1.0 - vFace.xy) * vFace.zw;
  float edge = min(d.x, d.y);
  float lit = smoothstep(0.03, 0.075, edge);
  float ribs = 0.86 + 0.14 * cos(vFace.x * vFace.z * 10.5);
  vec3 col = vLampColor * (0.035 + 0.965 * lit) * ribs;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #ifdef USE_FOG
    gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, clamp(fogFactorAk2(vFogDepth) * 0.6, 0.0, 1.0));
  #endif
}`;

const HALO_VERT = /* glsl */ `
attribute vec3 iPos;
attribute vec4 iCol;
attribute vec3 iDir;
attribute float iBlink;
uniform float uTime;
uniform float uGain;
varying vec2 vQ;
varying vec3 vHalo;
${BLINK_GLSL}
void main() {
  vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
  float dist = -mv.z;
  mv.xy += position.xy * iCol.a;
  gl_Position = projectionMatrix * mv;
  float fade = smoothstep(3.0, 10.0, dist) * (1.0 - smoothstep(150.0, 240.0, dist));
  // a panel on a wall or under a slab has no glow on the far side of its mount (the billboard would poke
  // through a thin floor and tint it from above)
  if (dot(iDir, iDir) > 0.5) fade *= smoothstep(-0.05, 0.2, dot(normalize(cameraPosition - iPos), iDir));
  vHalo = iCol.rgb * (uGain * fade * ak2Blink(iBlink, uTime));
  vQ = position.xy * 2.0;
  // a halo that adds nothing (too near, too far, seen from behind its mount) is not rasterised at all
  if (fade <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}`;
const HALO_FRAG = /* glsl */ `
varying vec2 vQ;
varying vec3 vHalo;
void main() {
  float r = length(vQ);
  float a = max(0.0, 1.0 - r);
  a = a * a * (0.35 + 0.65 * a);
  gl_FragColor = vec4(vHalo * a, 1.0);
}`;

const EXIT_VERT = /* glsl */ `
attribute vec2 aUv;
attribute float aKind;
varying vec2 vUv2;
varying float vKind;
void main() {
  vUv2 = aUv;
  vKind = aKind;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const EXIT_FRAG = /* glsl */ `
uniform float uTime;
uniform vec2 uSize;
varying vec2 vUv2;
varying float vKind;
void main() {
  vec3 col = vec3(0.2, 1.0, 0.45);
  float a;
  if (vKind < 0.5) {
    // floor: chevrons running into the exit zone + a bright border
    float lane = 8.0;
    float cx = abs(fract(vUv2.x / lane) - 0.5) * lane;
    float p = fract((vUv2.y + cx * 0.85) / 6.0 - uTime * 0.55);
    float chev = smoothstep(0.0, 0.05, p) * (1.0 - smoothstep(0.28, 0.33, p));
    chev *= 1.0 - smoothstep(lane * 0.5 - 0.9, lane * 0.5 - 0.5, cx);
    vec2 e = min(vUv2, uSize - vUv2);
    float border = 1.0 - smoothstep(0.3, 0.45, min(e.x, e.y));
    a = max(chev * 0.55, border) * (0.8 + 0.2 * sin(uTime * 3.0));
  } else if (vKind < 1.5) {
    // light pillar
    float core = max(0.0, 1.0 - abs(vUv2.x - 0.5) * 2.0);
    a = core * core * (1.0 - vUv2.y) * (0.75 + 0.25 * sin(uTime * 4.0 - vUv2.y * 12.0));
  } else if (vKind < 2.5) {
    // sign pixels
    a = 0.85 + 0.15 * sin(uTime * 3.0);
    col = vec3(0.55, 1.0, 0.7);
  } else {
    // dark backing plate of the sign (keeps it readable in front of bright walls)
    vec2 e = min(vUv2, 1.0 - vUv2);
    float frame = 1.0 - smoothstep(0.0, 0.04, min(e.x * 4.0, e.y));
    gl_FragColor = vec4(vec3(0.1, 0.6, 0.3) * frame, 0.78);
    return;
  }
  // premultiplied output: alpha 0 = purely additive glow
  gl_FragColor = vec4(col * a, 0.0);
}`;

function patchStageShader(shader: { uniforms: Record<string, THREE.IUniform>; vertexShader: string; fragmentShader: string }, uniforms: Record<string, THREE.IUniform>): void {
  Object.assign(shader.uniforms, uniforms);
  shader.vertexShader = shader.vertexShader
    .replace(
      '#include <common>',
      /* glsl */ `#include <common>
attribute vec2 aUv;
attribute vec4 aTint;
attribute vec3 aBaked;
varying vec2 vUvM;
varying vec4 vTint;
varying vec3 vBaked;
varying vec3 vWPos;
varying vec3 vWNrm;`,
    )
    .replace(
      '#include <project_vertex>',
      /* glsl */ `#include <project_vertex>
vUvM = aUv;
vTint = aTint;
vBaked = aBaked * ${BAKE_MAX.toFixed(1)};
vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vWNrm = normalize(mat3(modelMatrix) * objectNormal);`,
    );

  // The stage is lit by the baked lamp light; real point lights (the pool for dynamic objects) are skipped.
  const lightsBegin = THREE.ShaderChunk.lights_fragment_begin.replace('#if ( NUM_POINT_LIGHTS > 0 ) && defined( RE_Direct )', '#if 0');
  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      /* glsl */ `#include <common>
uniform highp sampler2DArray uAlbedo;
uniform highp sampler2DArray uHeight;
uniform sampler2D uNoise;
uniform highp sampler3D uOcc;
uniform vec3 uOccOrigin;
uniform vec3 uOccInvSize;
uniform float uOccVoxel;
uniform float uAoStrength;
uniform float uInvTile[${LAYER_COUNT}];
uniform float uMetal[${LAYER_COUNT}];
uniform float uBump[${LAYER_COUNT}];
varying vec2 vUvM;
varying vec4 vTint;
varying vec3 vBaked;
varying vec3 vWPos;
varying vec3 vWNrm;
float stageLayer;
vec2 stageUv;
float stageRough;
float stageAo;
vec3 stagePerturb(vec3 surfPos, vec3 surfNorm, vec2 dHdxy, float faceDir) {
  vec3 sx = dFdx(surfPos);
  vec3 sy = dFdy(surfPos);
  vec3 r1 = cross(sy, surfNorm);
  vec3 r2 = cross(surfNorm, sx);
  float det = dot(sx, r1) * faceDir;
  vec3 grad = sign(det) * (dHdxy.x * r1 + dHdxy.y * r2);
  return normalize(abs(det) * surfNorm - grad);
}`,
    )
    .replace(
      '#include <map_fragment>',
      /* glsl */ `{
  stageLayer = floor(vTint.a * 255.0 + 0.5);
  int li = int(stageLayer);
  stageUv = vUvM * uInvTile[li];
  vec4 texel = texture(uAlbedo, vec3(stageUv, stageLayer));
  // (the noise layer through its own sampler: no anisotropic probes for the two variation lookups)
  vec3 macro = texture(uNoise, vUvM * (1.0 / 37.0)).rgb;
  float fine = texture(uNoise, vUvM * (1.0 / 1.7)).b;
  vec3 c = texel.rgb * vTint.rgb;
  c *= 0.8 + 0.4 * macro.r;
  c *= 0.93 + 0.14 * fine;
  c = mix(c, c * vec3(0.66, 0.62, 0.58), macro.g * 0.42);
  diffuseColor.rgb *= c;
  stageRough = clamp(texel.a + macro.g * 0.1, 0.08, 1.0);
}`,
    )
    .replace('#include <roughnessmap_fragment>', /* glsl */ `float roughnessFactor = stageRough;`)
    .replace('#include <metalnessmap_fragment>', /* glsl */ `float metalnessFactor = uMetal[int(stageLayer)];`)
    .replace(
      '#include <normal_fragment_maps>',
      /* glsl */ `{
  int li = int(stageLayer);
  vec2 dx = dFdx(stageUv);
  vec2 dy = dFdy(stageUv);
  float h0 = texture(uHeight, vec3(stageUv, stageLayer)).r;
  float hx = texture(uHeight, vec3(stageUv + dx, stageLayer)).r;
  float hy = texture(uHeight, vec3(stageUv + dy, stageLayer)).r;
  normal = stagePerturb(-vViewPosition, normal, vec2(hx - h0, hy - h0) * (uBump[li] * 0.02), faceDirection);
  vec3 wn = normalize(vWNrm);
  float o1 = texture(uOcc, (vWPos + wn * uOccVoxel - uOccOrigin) * uOccInvSize).r;
  float o2 = texture(uOcc, (vWPos + wn * (uOccVoxel * 2.3) - uOccOrigin) * uOccInvSize).r;
  stageAo = 1.0 - clamp(o1 * 0.9 + o2 * 0.5, 0.0, 1.0) * uAoStrength;
}`,
    )
    .replace('#include <lights_fragment_begin>', `${lightsBegin}\nirradiance += vBaked;`)
    .replace(
      '#include <aomap_fragment>',
      /* glsl */ `reflectedLight.indirectDiffuse *= stageAo;
reflectedLight.directDiffuse *= mix(1.0, stageAo, 0.7);
// wet / oily patches glint under the scene's directional lights: keep the sheen, not white blotches
reflectedLight.directSpecular *= stageAo * 0.5;
reflectedLight.indirectSpecular *= stageAo;`,
    );
}

// ───────────────────────────── doors (barriers + final gate) ─────────────────────────────
interface Door {
  id: string;
  group: THREE.Group;
  leaves: THREE.Group[];
  /** world axis each leaf is squashed along ('x' | 'y' | 'z') */
  axis: 'x' | 'y' | 'z';
  red: THREE.Mesh[];
  green: THREE.Mesh[];
  open: boolean;
  /** 0 = closed … 1 = fully open (hidden) */
  t: number;
}

interface Chunk {
  mesh: THREE.Mesh | null;
  lamps: THREE.Mesh | null;
  box: THREE.Box3;
  /** draw-order key of this frame: distance² from the camera to the box (+ a small share of the centre distance²) */
  dist: number;
}

export interface StageViewStats {
  solids: number;
  decor: number;
  chunks: number;
  triangles: number;
  vertices: number;
  lamps: number;
  /** flat faces drawn for StageDef.markings */
  markings: number;
  ledgeStrips: number;
  culledFaces: number;
  buildMs: number;
  bakeMs: number;
  textureBytes: number;
  occupancyBytes: number;
}

export class StageView {
  readonly group = new THREE.Group();
  /** Multiplier of the pool point lights that light dynamic objects (the hangar uses a brighter key). */
  poolGain = 1;

  private readonly stage: StageDef;
  private readonly occ: Occupancy;
  private readonly occTex: THREE.Data3DTexture;
  private readonly material: THREE.MeshStandardMaterial;
  private readonly lampMaterial: THREE.ShaderMaterial;
  private readonly haloMaterial: THREE.ShaderMaterial;
  private readonly exitMaterial: THREE.ShaderMaterial;
  private glassMaterial: THREE.MeshStandardMaterial | null = null;
  private readonly timeUniform = { value: 0 };
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly chunks: Chunk[] = [];
  /** the chunks nearest first (re-sorted every frame; a separate list so `chunks` keeps its build order) */
  private readonly chunkOrder: Chunk[] = [];
  private readonly doors = new Map<string, Door>();
  private readonly doorList: Door[] = [];
  private readonly exitGroup = new THREE.Group();
  private readonly lamps: Lamp[] = [];
  private readonly poolLamps: number[] = [];
  private readonly pool: THREE.PointLight[] = [];
  private readonly poolLamp: number[] = [];
  private readonly poolFade: number[] = [];
  private poolTimer = 0;
  private readonly poolBest: number[] = [];
  private readonly poolBestD: number[] = [];
  private disposed = false;

  // build-time lookup structures
  private readonly solids: readonly SolidDef[];
  private gx0 = 0;
  private gz0 = 0;
  private gnx = 1;
  private gnz = 1;
  private solidCells: number[][] = [];
  private lampCells: number[][] = [];
  private readonly cutA = new Float64Array(1024);
  private readonly cutB = new Float64Array(1024);
  private readonly bakeOut = new Float32Array(3);
  private uvLocal = false;
  /** texture layer of the ±Y faces of the box being emitted (-1 = same as the sides), local UVs on them */
  private topLayer = -1;
  private topLocal = false;
  /** brightness factor of the top face of the box being emitted */
  private topTint = 1;
  /** swap u / v on the vertical faces / on the ±Y faces of the box being emitted */
  private uvSwapSide = false;
  private uvSwapTop = false;
  /** blinking warning plates mounted at a barrier / the gate → that door's id */
  private readonly doorDecor = new Map<DecorDef, string>();
  /** meshes shown only while a door is closed / only once it is open (markings, warning plates) */
  private readonly doorSigns = new Map<string, { closed: THREE.Object3D[]; open: THREE.Object3D[] }>();
  private readonly doorHalos = new Map<string, number[]>();
  private haloCol: THREE.InstancedBufferAttribute | null = null;
  private haloBlink: THREE.InstancedBufferAttribute | null = null;
  private bakeMs = 0;
  private readonly stats: StageViewStats;

  constructor(stage: StageDef) {
    const t0 = performance.now();
    this.stage = stage;
    this.solids = stage.solids;
    this.group.name = `stage-${stage.id}`;
    this.group.matrixAutoUpdate = false;

    // ── lookup grids + occupancy ──
    this.buildSolidGrid();
    this.occ = new Occupancy(stage.solids);
    this.occTex = new THREE.Data3DTexture(this.occ.data, this.occ.nx, this.occ.ny, this.occ.nz);
    this.occTex.format = THREE.RedFormat;
    this.occTex.type = THREE.UnsignedByteType;
    this.occTex.minFilter = THREE.LinearFilter;
    this.occTex.magFilter = THREE.LinearFilter;
    this.occTex.wrapS = this.occTex.wrapT = this.occTex.wrapR = THREE.ClampToEdgeWrapping;
    this.occTex.unpackAlignment = 1;
    this.occTex.needsUpdate = true;

    // ── materials ──
    const tex = acquireStageTextures();
    const uniforms: Record<string, THREE.IUniform> = {
      uAlbedo: { value: tex.albedo },
      uHeight: { value: tex.height },
      uNoise: { value: tex.noise },
      uOcc: { value: this.occTex },
      uOccOrigin: { value: new THREE.Vector3(this.occ.ox, this.occ.oy, this.occ.oz) },
      uOccInvSize: { value: new THREE.Vector3(1 / (this.occ.nx * this.occ.voxel), 1 / (this.occ.ny * this.occ.voxel), 1 / (this.occ.nz * this.occ.voxel)) },
      uOccVoxel: { value: this.occ.voxel },
      uAoStrength: { value: 0.62 },
      uInvTile: { value: LAYER_TILE_M.map((m) => 1 / m) },
      uMetal: { value: [...LAYER_METALNESS] },
      uBump: { value: [...LAYER_BUMP] },
    };
    this.material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
    this.material.onBeforeCompile = (shader) => patchStageShader(shader, uniforms);
    this.material.customProgramCacheKey = () => 'ak2-stage-v3';

    this.lampMaterial = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 } }]),
      vertexShader: LAMP_VERT,
      fragmentShader: LAMP_FRAG.replace(
        '#include <fog_pars_fragment>',
        /* glsl */ `#include <fog_pars_fragment>
#ifdef USE_FOG
float fogFactorAk2(float depth) {
  #ifdef FOG_EXP2
    return 1.0 - exp(-fogDensity * fogDensity * depth * depth);
  #else
    return smoothstep(fogNear, fogFar, depth);
  #endif
}
#endif`,
      ),
      fog: true,
    });
    this.lampMaterial.uniforms.uTime = this.timeUniform;
    this.haloMaterial = new THREE.ShaderMaterial({
      uniforms: { uTime: this.timeUniform, uGain: { value: 0.42 } },
      vertexShader: HALO_VERT,
      fragmentShader: HALO_FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    this.exitMaterial = new THREE.ShaderMaterial({
      uniforms: { uTime: this.timeUniform, uSize: { value: new THREE.Vector2(1, 1) } },
      vertexShader: EXIT_VERT,
      fragmentShader: EXIT_FRAG,
      transparent: true,
      // premultiplied blend: glow is added (alpha 0), the sign's backing plate darkens what is behind it (alpha > 0)
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });

    // ── lamps (needed before any geometry is baked) ──
    this.assignDoorLamps();
    this.collectLamps();

    // ── static geometry per chunk ──
    const bufs = new Map<string, { geo: GeoBuf; lamps: LampBuf }>();
    const bufFor = (sectorId: string | undefined, cx: number, cz: number): { geo: GeoBuf; lamps: LampBuf } => {
      const key = sectorId ?? `g${Math.floor(cx / CHUNK_GRID)}_${Math.floor(cz / CHUNK_GRID)}`;
      let b = bufs.get(key);
      if (!b) {
        b = { geo: new GeoBuf(), lamps: new LampBuf() };
        bufs.set(key, b);
      }
      return b;
    };
    let culled = 0;
    let ledges = 0;
    const solids = stage.solids;
    for (let i = 0; i < solids.length; i++) {
      const s = solids[i]!;
      const info = MAT[s.material] ?? MAT.concrete;
      const buf = bufFor(s.sectorId, (s.min.x + s.max.x) / 2, (s.min.z + s.max.z) / 2).geo;
      const h = hash3(s.min.x + s.max.x * 0.37, s.min.y + s.max.y * 0.71, s.min.z + s.max.z * 0.13);
      const look = s.tag ? TAG_LOOK[s.tag] : undefined;
      const tint = look?.tint ?? info.tints[Math.floor(h * info.tints.length) % info.tints.length]!;
      const v = 1 - info.vary * 2 * hash3(s.max.x, s.max.y + 3.1, s.min.z);
      this.uvLocal = !!info.local;
      let layer = info.layer;
      if (look) {
        const alongZ = s.max.z - s.min.z > s.max.x - s.min.x;
        if (look.side !== undefined) {
          layer = look.side;
          this.uvLocal = true;
          this.uvSwapSide = look.run === 'up';
        }
        if (look.top !== undefined) {
          this.topLayer = look.top;
          this.topLocal = true;
          this.uvSwapTop = look.run === 'long' && alongZ;
        }
      } else if (s.material === 'machine') {
        // machine tops are plain plate (the panel texture belongs on the sides), kept as light as the panels
        this.topLayer = LAYER.metal;
        this.topTint = 1.4;
      }
      culled += this.emitBox(buf, s, layer, tint[0] * v, tint[1] * v, tint[2] * v, i, !info.dark);
      this.topTint = 1;
      this.uvLocal = false;
      this.topLayer = -1;
      this.topLocal = false;
      this.uvSwapSide = false;
      this.uvSwapTop = false;
      if (s.material === 'floor' || s.material === 'catwalk' || s.material === 'concrete' || s.material === 'metal') ledges += this.emitLedges(buf, s, i);
    }
    const glass = new GeoBuf();
    const doorBufs = new Map<string, { closed: { geo: GeoBuf; lamps: LampBuf }; open: { geo: GeoBuf; lamps: LampBuf } }>();
    let markings = 0;
    for (const m of stage.markings ?? []) {
      const linked = m.untilBarrierOpen ?? m.afterBarrierOpen;
      const target = linked !== undefined ? this.doorSignBufs(doorBufs, linked)[m.untilBarrierOpen !== undefined ? 'closed' : 'open'] : bufFor(m.sectorId, m.position.x, m.position.z);
      markings += this.emitMarking(m, target.geo, target.lamps);
    }
    for (const d of stage.decor) {
      const cx = (d.min.x + d.max.x) / 2;
      const cz = (d.min.z + d.max.z) / 2;
      const b = bufFor(d.sectorId, cx, cz);
      const light = LIGHTS[d.material];
      if (light) {
        const owner = this.doorDecor.get(d);
        if (owner !== undefined) {
          // warning plate of a door: blinking red (or its own colour) while closed, steady green once open
          const sg = this.doorSignBufs(doorBufs, owner);
          sg.closed.lamps.box(d, light.face, hash3(d.min.x, d.min.y, d.min.z));
          sg.open.lamps.box(d, LAMP_GREEN, -1);
          continue;
        }
        b.lamps.box(d, light.face, d.blink ? hash3(d.min.x, d.min.y, d.min.z) : -1);
        continue;
      }
      if (d.material === 'glass') {
        this.emitBox(glass, d, LAYER.paint, 1, 1, 1, -1, false);
        continue;
      }
      const info = MAT[d.material as SolidMaterial] ?? MAT.metal;
      const h = hash3(d.min.x * 0.7 + d.max.z, d.min.y, d.min.z * 0.3 + d.max.x);
      const tint = info.tints[Math.floor(h * info.tints.length) % info.tints.length]!;
      const v = 1 - info.vary * 2 * hash3(d.max.x, d.max.y, d.max.z);
      this.uvLocal = !!info.local;
      if (d.shape === 'box') this.emitBox(b.geo, d, info.layer, tint[0] * v, tint[1] * v, tint[2] * v, -1, true);
      else this.emitCylinder(b.geo, d, d.shape === 'cylinder-x' ? 0 : d.shape === 'cylinder-y' ? 1 : 2, info.layer, tint[0] * v, tint[1] * v, tint[2] * v);
      this.uvLocal = false;
    }

    let triangles = 0;
    let vertices = 0;
    for (const [key, b] of bufs) {
      const chunk: Chunk = { mesh: null, lamps: null, box: new THREE.Box3(), dist: 0 };
      if (b.geo.count > 0) {
        const g = b.geo.toGeometry();
        this.geometries.push(g);
        const m = new THREE.Mesh(g, this.material);
        m.name = `chunk-${key}`;
        m.matrixAutoUpdate = false;
        this.group.add(m);
        chunk.mesh = m;
        chunk.box.union(g.boundingBox!);
        triangles += b.geo.triangles;
        vertices += b.geo.count;
      }
      if (b.lamps.count > 0) {
        const g = b.lamps.toGeometry();
        this.geometries.push(g);
        const m = new THREE.Mesh(g, this.lampMaterial);
        m.name = `lamps-${key}`;
        m.matrixAutoUpdate = false;
        this.group.add(m);
        chunk.lamps = m;
        chunk.box.union(g.boundingBox!);
        triangles += b.lamps.idx.length / 3;
        vertices += b.lamps.count;
      }
      this.chunks.push(chunk);
      this.chunkOrder.push(chunk);
    }
    if (glass.count > 0) {
      const g = glass.toGeometry(false);
      this.geometries.push(g);
      this.glassMaterial = new THREE.MeshStandardMaterial({ color: 0x9fd4dc, roughness: 0.12, metalness: 0, transparent: true, opacity: 0.3, depthWrite: false });
      const m = new THREE.Mesh(g, this.glassMaterial);
      m.name = 'glass';
      m.matrixAutoUpdate = false;
      m.renderOrder = 2;
      this.group.add(m);
      triangles += glass.triangles;
    }

    this.buildHalos();
    for (const b of stage.barriers) this.buildDoor(b.id, b.box, false);
    this.buildDoor(stage.finalGate.id, stage.finalGate.box, true);
    // markings and warning plates that follow a door's state (one mesh pair per state, shown / hidden with it)
    for (const [id, pair] of doorBufs) {
      const entry = { closed: [] as THREE.Object3D[], open: [] as THREE.Object3D[] };
      for (const state of ['closed', 'open'] as const) {
        const b = pair[state];
        const add = (g: THREE.BufferGeometry, mat: THREE.Material): void => {
          this.geometries.push(g);
          const m = new THREE.Mesh(g, mat);
          m.name = `door-sign-${id}-${state}`;
          m.matrixAutoUpdate = false;
          m.visible = state === 'closed';
          this.group.add(m);
          entry[state].push(m);
        };
        if (b.geo.count > 0) {
          add(b.geo.toGeometry(), this.material);
          triangles += b.geo.triangles;
        }
        if (b.lamps.count > 0) {
          add(b.lamps.toGeometry(), this.lampMaterial);
          triangles += b.lamps.idx.length / 3;
        }
      }
      this.doorSigns.set(id, entry);
    }
    this.buildExitMarker();
    this.buildPool();

    // build-only structures are no longer needed
    this.solidCells = [];
    this.lampCells = [];

    this.stats = {
      solids: stage.solids.length,
      decor: stage.decor.length,
      chunks: this.chunks.length,
      triangles,
      vertices,
      lamps: this.lamps.length,
      markings,
      ledgeStrips: ledges,
      culledFaces: culled,
      buildMs: performance.now() - t0,
      bakeMs: this.bakeMs,
      textureBytes: getStageTextureBytes(),
      occupancyBytes: this.occ.data.length,
    };
    this.group.updateMatrixWorld(true);
  }

  getStats(): StageViewStats {
    return this.stats;
  }

  // ───────────────────────────── public API ─────────────────────────────
  /** Opens / closes a barrier or the final gate (BarrierDef.id or FinalGateDef.id). Unknown ids are ignored. */
  setBarrierOpen(id: string, open: boolean, animate: boolean): void {
    const d = this.doors.get(id);
    if (!d) return;
    if (open) {
      if (d.open) {
        if (!animate && d.t < 1) this.finishDoor(d);
        return;
      }
      d.open = true;
      for (const m of d.red) m.visible = false;
      for (const m of d.green) m.visible = true;
      this.applyDoorSigns(id, true);
      if (!animate) this.finishDoor(d);
    } else {
      d.open = false;
      d.t = 0;
      d.group.visible = true;
      for (const l of d.leaves) l.scale.set(1, 1, 1);
      for (const m of d.red) m.visible = true;
      for (const m of d.green) m.visible = false;
      this.applyDoorSigns(id, false);
    }
  }

  /** Markings, warning plates and their halos that follow the state of a door. */
  private applyDoorSigns(id: string, open: boolean): void {
    const signs = this.doorSigns.get(id);
    if (signs) {
      for (const m of signs.closed) m.visible = !open;
      for (const m of signs.open) m.visible = open;
    }
    const halos = this.doorHalos.get(id);
    if (halos && this.haloCol && this.haloBlink) {
      const col = this.haloCol.array as Float32Array;
      const blink = this.haloBlink.array as Float32Array;
      for (const i of halos) {
        const l = this.lamps[i]!;
        const k = open ? 1 : l.blink >= 0 ? 1.5 : 1;
        col[i * 4] = (open ? HALO_OPEN[0] : l.r) * k;
        col[i * 4 + 1] = (open ? HALO_OPEN[1] : l.g) * k;
        col[i * 4 + 2] = (open ? HALO_OPEN[2] : l.b) * k;
        blink[i] = open ? -1 : l.blink;
      }
      this.haloCol.needsUpdate = true;
      this.haloBlink.needsUpdate = true;
    }
  }

  /** True while the door is drawn (closed or still retracting). */
  isBarrierVisible(id: string): boolean {
    const d = this.doors.get(id);
    return !!d && d.group.visible;
  }

  isBarrierOpen(id: string): boolean {
    return !!this.doors.get(id)?.open;
  }

  /** All barriers and the gate closed (new sortie). */
  resetBarriers(): void {
    for (const d of this.doorList) this.setBarrierOpen(d.id, false, false);
  }

  /** Shows / hides the exit marker (green chevrons, light pillars, EXIT sign) in the exit zone. */
  setExitActive(active: boolean): void {
    this.exitGroup.visible = active;
  }

  /**
   * Per-frame update: blinking lamps, door animation, chunk distance culling and the dynamic light pool.
   * `focus` (default: the camera position) is the point the pool lights gather around — pass the mech position.
   */
  update(dt: number, time: number, cameraPos: P3, focus: P3 = cameraPos): void {
    if (this.disposed) return;
    this.timeUniform.value = time;
    const step = dt > 0 ? Math.min(dt, 0.1) : 0;

    for (let k = 0; k < this.doorList.length; k++) {
      const d = this.doorList[k]!;
      if (!d.open || d.t >= 1) continue;
      d.t = Math.min(1, d.t + step / DOOR_OPEN_SECONDS);
      if (d.t >= 1) {
        this.finishDoor(d);
        continue;
      }
      const e = d.t * d.t * (3 - 2 * d.t);
      const s = Math.max(0.002, 1 - e);
      for (const l of d.leaves) {
        if (d.axis === 'x') l.scale.x = s;
        else if (d.axis === 'y') l.scale.y = s;
        else l.scale.z = s;
      }
    }

    const lim2 = CHUNK_DRAW_DISTANCE * CHUNK_DRAW_DISTANCE;
    for (let k = 0; k < this.chunks.length; k++) {
      const c = this.chunks[k]!;
      const b = c.box;
      const dx = cameraPos.x < b.min.x ? b.min.x - cameraPos.x : cameraPos.x > b.max.x ? cameraPos.x - b.max.x : 0;
      const dy = cameraPos.y < b.min.y ? b.min.y - cameraPos.y : cameraPos.y > b.max.y ? cameraPos.y - b.max.y : 0;
      const dz = cameraPos.z < b.min.z ? b.min.z - cameraPos.z : cameraPos.z > b.max.z ? cameraPos.z - b.max.z : 0;
      const d2 = dx * dx + dy * dy + dz * dz;
      const vis = d2 < lim2;
      if (c.mesh) c.mesh.visible = vis;
      if (c.lamps) c.lamps.visible = vis;
      // boxes of neighbouring sectors overlap at the shared walls: the centre distance breaks the tie
      const cx = (b.min.x + b.max.x) * 0.5 - cameraPos.x;
      const cy = (b.min.y + b.max.y) * 0.5 - cameraPos.y;
      const cz = (b.min.z + b.max.z) * 0.5 - cameraPos.z;
      c.dist = d2 + (cx * cx + cy * cy + cz * cz) * 1e-4;
    }
    // Draw order of the opaque chunks: nearest first (the chunk the camera is in before everything behind its
    // walls), so the depth test discards hidden fragments before the stage shader runs. three.js sorts opaque
    // objects by renderOrder first; its own depth key (the centre of a sector-sized bounding sphere) is too coarse.
    const order = this.chunkOrder;
    for (let i = 1; i < order.length; i++) {
      const c = order[i]!;
      let j = i - 1;
      while (j >= 0 && order[j]!.dist > c.dist) {
        order[j + 1] = order[j]!;
        j--;
      }
      order[j + 1] = c;
    }
    for (let i = 0; i < order.length; i++) {
      const m = order[i]!.mesh;
      if (m) m.renderOrder = i;
    }

    this.updatePool(step, focus);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const g of this.geometries) g.dispose();
    this.geometries.length = 0;
    this.material.dispose();
    this.lampMaterial.dispose();
    this.haloMaterial.dispose();
    this.exitMaterial.dispose();
    this.glassMaterial?.dispose();
    this.occTex.dispose();
    for (const l of this.pool) l.dispose();
    this.group.clear();
    this.group.removeFromParent();
    this.doors.clear();
    this.doorList.length = 0;
    this.doorSigns.clear();
    this.doorHalos.clear();
    this.doorDecor.clear();
    this.chunks.length = 0;
    this.chunkOrder.length = 0;
    releaseStageTextures();
  }

  // ───────────────────────────── lookup grids ─────────────────────────────
  private buildSolidGrid(): void {
    let x0 = Infinity;
    let z0 = Infinity;
    let x1 = -Infinity;
    let z1 = -Infinity;
    for (const s of this.solids) {
      if (s.min.x < x0) x0 = s.min.x;
      if (s.min.z < z0) z0 = s.min.z;
      if (s.max.x > x1) x1 = s.max.x;
      if (s.max.z > z1) z1 = s.max.z;
    }
    for (const d of this.stage.decor) {
      if (d.min.x < x0) x0 = d.min.x;
      if (d.min.z < z0) z0 = d.min.z;
      if (d.max.x > x1) x1 = d.max.x;
      if (d.max.z > z1) z1 = d.max.z;
    }
    if (!(x1 > x0)) {
      x0 = z0 = 0;
      x1 = z1 = 1;
    }
    this.gx0 = x0 - CELL;
    this.gz0 = z0 - CELL;
    this.gnx = Math.ceil((x1 - x0) / CELL) + 3;
    this.gnz = Math.ceil((z1 - z0) / CELL) + 3;
    const n = this.gnx * this.gnz;
    this.solidCells = new Array<number[]>(n);
    this.lampCells = new Array<number[]>(n);
    for (let i = 0; i < n; i++) {
      this.solidCells[i] = [];
      this.lampCells[i] = [];
    }
    for (let i = 0; i < this.solids.length; i++) {
      const s = this.solids[i]!;
      const cx0 = this.cellX(s.min.x - 0.05);
      const cx1 = this.cellX(s.max.x + 0.05);
      const cz0 = this.cellZ(s.min.z - 0.05);
      const cz1 = this.cellZ(s.max.z + 0.05);
      for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) this.solidCells[cz * this.gnx + cx]!.push(i);
    }
  }
  private cellX(x: number): number {
    return clamp(Math.floor((x - this.gx0) / CELL), 0, this.gnx - 1);
  }
  private cellZ(z: number): number {
    return clamp(Math.floor((z - this.gz0) / CELL), 0, this.gnz - 1);
  }
  private pointInSolid(x: number, y: number, z: number): boolean {
    const cell = this.solidCells[this.cellZ(z) * this.gnx + this.cellX(x)]!;
    for (let k = 0; k < cell.length; k++) {
      const s = this.solids[cell[k]!]!;
      if (x > s.min.x && x < s.max.x && y > s.min.y && y < s.max.y && z > s.min.z && z < s.max.z) return true;
    }
    return false;
  }
  /** True when the whole face rectangle lies against (inside) one other permanent solid: it can never be seen. */
  private faceCovered(self: number, axis: number, sign: number, coord: number, a0: number, a1: number, b0: number, b1: number): boolean {
    // any covering box contains the face's min corner → one cell is enough
    const px = axis === 0 ? coord + sign * 0.01 : a0 + 0.01;
    const pz = axis === 0 ? a0 + 0.01 : axis === 1 ? b0 + 0.01 : coord + sign * 0.01;
    const cell = this.solidCells[this.cellZ(pz) * this.gnx + this.cellX(px)]!;
    for (let k = 0; k < cell.length; k++) {
      const i = cell[k]!;
      if (i === self) continue;
      const s = this.solids[i]!;
      let lo: number;
      let hi: number;
      let alo: number;
      let ahi: number;
      let blo: number;
      let bhi: number;
      if (axis === 0) {
        lo = s.min.x;
        hi = s.max.x;
        alo = s.min.z;
        ahi = s.max.z;
        blo = s.min.y;
        bhi = s.max.y;
      } else if (axis === 1) {
        lo = s.min.y;
        hi = s.max.y;
        alo = s.min.x;
        ahi = s.max.x;
        blo = s.min.z;
        bhi = s.max.z;
      } else {
        lo = s.min.z;
        hi = s.max.z;
        alo = s.min.x;
        ahi = s.max.x;
        blo = s.min.y;
        bhi = s.max.y;
      }
      if (sign > 0 ? !(lo <= coord + EPS && hi >= coord + 0.02) : !(hi >= coord - EPS && lo <= coord - 0.02)) continue;
      if (alo <= a0 + EPS && ahi >= a1 - EPS && blo <= b0 + EPS && bhi >= b1 - EPS) return true;
    }
    return false;
  }

  // ───────────────────────────── lamps + bake ─────────────────────────────
  /**
   * Blinking warning plates mounted right next to a barrier or the gate (above the doorway or on its jambs)
   * belong to that door: they are drawn in its state colours instead of blinking on for ever.
   */
  private assignDoorLamps(): void {
    const doors: Array<{ id: string; box: Box }> = this.stage.barriers.map((b) => ({ id: b.id, box: b.box }));
    doors.push({ id: this.stage.finalGate.id, box: this.stage.finalGate.box });
    for (const d of this.stage.decor) {
      if (!d.blink || !LIGHTS[d.material]) continue;
      for (const { id, box } of doors) {
        const m = 3.5;
        if (d.max.x < box.min.x - m || d.min.x > box.max.x + m || d.max.z < box.min.z - m || d.min.z > box.max.z + m) continue;
        if (d.max.y < box.min.y || d.min.y > box.max.y + 2.2) continue;
        this.doorDecor.set(d, id);
        break;
      }
    }
  }

  private doorSignBufs(
    map: Map<string, { closed: { geo: GeoBuf; lamps: LampBuf }; open: { geo: GeoBuf; lamps: LampBuf } }>,
    id: string,
  ): { closed: { geo: GeoBuf; lamps: LampBuf }; open: { geo: GeoBuf; lamps: LampBuf } } {
    let e = map.get(id);
    if (!e) {
      e = { closed: { geo: new GeoBuf(), lamps: new LampBuf() }, open: { geo: new GeoBuf(), lamps: new LampBuf() } };
      map.set(id, e);
    }
    return e;
  }

  private collectLamps(): void {
    const occ = this.occ;
    for (const d of this.stage.decor) {
      const info = LIGHTS[d.material];
      if (!info) continue;
      const door = this.doorDecor.get(d);
      const dim = [d.max.x - d.min.x, d.max.y - d.min.y, d.max.z - d.min.z];
      let thin = 0;
      if (dim[1]! < dim[thin]!) thin = 1;
      if (dim[2]! < dim[thin]!) thin = 2;
      const o1 = (thin + 1) % 3;
      const o2 = (thin + 2) % 3;
      const panel = dim[thin]! < 0.45 * Math.min(dim[o1]!, dim[o2]!);
      const n1 = Math.max(1, Math.ceil(dim[o1]! / 5));
      const n2 = Math.max(1, Math.ceil(dim[o2]! / 5));
      const area = (dim[o1]! / n1) * (dim[o2]! / n2);
      const power = 58 * Math.sqrt(clamp(area, 0.5, 6)) * info.gain;
      const c = [(d.min.x + d.max.x) / 2, (d.min.y + d.max.y) / 2, (d.min.z + d.max.z) / 2];
      const lo = [d.min.x, d.min.y, d.min.z];
      const blink = d.blink ? hash3(d.min.x, d.min.y, d.min.z) : -1;
      for (let i = 0; i < n1; i++) {
        for (let j = 0; j < n2; j++) {
          const p = [c[0]!, c[1]!, c[2]!];
          p[o1] = lo[o1]! + (dim[o1]! * (i + 0.5)) / n1;
          p[o2] = lo[o2]! + (dim[o2]! * (j + 0.5)) / n2;
          const dir = [0, 0, 0];
          if (panel) {
            const e = [0, 0, 0];
            e[thin] = 1;
            // the mount is the solid right behind the plate (exact test: the 2 m voxels cannot tell the two
            // sides of a 1 m slab apart) …
            const h = dim[thin]! / 2 + 0.2;
            const sp = this.pointInSolid(p[0]! + e[0]! * h, p[1]! + e[1]! * h, p[2]! + e[2]! * h);
            const sm = this.pointInSolid(p[0]! - e[0]! * h, p[1]! - e[1]! * h, p[2]! - e[2]! * h);
            if (sp !== sm) {
              dir[thin] = sp ? -1 : 1;
            } else {
              // … otherwise the open side is the one with less solid matter
              let plus = 0;
              let minus = 0;
              for (const dist of [1.2, 2.6, 4]) {
                plus += occ.sample(p[0]! + e[0]! * dist, p[1]! + e[1]! * dist, p[2]! + e[2]! * dist);
                minus += occ.sample(p[0]! - e[0]! * dist, p[1]! - e[1]! * dist, p[2]! - e[2]! * dist);
              }
              if (Math.abs(plus - minus) > 0.15) dir[thin] = plus < minus ? 1 : -1;
            }
          }
          this.lamps.push({
            x: p[0]! + dir[0]! * 0.8,
            y: p[1]! + dir[1]! * 0.8,
            z: p[2]! + dir[2]! * 0.8,
            dx: dir[0]!,
            dy: dir[1]!,
            dz: dir[2]!,
            r: info.light[0],
            g: info.light[1],
            b: info.light[2],
            power,
            range: clamp(Math.sqrt(power) * 2.9, 14, 36),
            blink,
            haloSize: clamp(Math.max(dim[o1]! / n1, dim[o2]! / n2) * 1.15, 1.8, 6),
          });
          if (door !== undefined) {
            this.lamps[this.lamps.length - 1]!.door = door;
            let list = this.doorHalos.get(door);
            if (!list) {
              list = [];
              this.doorHalos.set(door, list);
            }
            list.push(this.lamps.length - 1);
          }
        }
      }
    }
    for (let i = 0; i < this.lamps.length; i++) {
      const l = this.lamps[i]!;
      if (l.blink >= 0) continue; // warning lights are not baked (they blink) and never drive the pool
      this.poolLamps.push(i);
      const cx0 = this.cellX(l.x - l.range);
      const cx1 = this.cellX(l.x + l.range);
      const cz0 = this.cellZ(l.z - l.range);
      const cz1 = this.cellZ(l.z + l.range);
      for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) this.lampCells[cz * this.gnx + cx]!.push(i);
    }
  }

  /** Irradiance at a surface point from the steady lamps. `s` = occlusion start (off the surface, towards the face centre). */
  private bake(px: number, py: number, pz: number, nx: number, ny: number, nz: number, sx: number, sy: number, sz: number): Float32Array {
    const out = this.bakeOut;
    let r = 0;
    let g = 0;
    let b = 0;
    const cell = this.lampCells[this.cellZ(pz) * this.gnx + this.cellX(px)]!;
    const occ = this.occ;
    for (let k = 0; k < cell.length; k++) {
      const l = this.lamps[cell[k]!]!;
      const lx = l.x - px;
      const ly = l.y - py;
      const lz = l.z - pz;
      const d2 = lx * lx + ly * ly + lz * lz;
      if (d2 >= l.range * l.range) continue;
      const d = Math.sqrt(d2) + 1e-6;
      const ndl = (nx * lx + ny * ly + nz * lz) / d;
      // A lamp up to 3.2 m behind the plane of this surface is mounted on the other side of the slab or wall
      // (a panel under the floor that is being lit): the occlusion march stops 2 m short of the fixture and the
      // coarse voxels only half-fill a thin slab, so its bounce would leak through as a hard-edged patch.
      if (ndl < 0 && -ndl * d > 0.05 && -ndl * d < 3.2) continue;
      let lobe = 1;
      if (l.dx !== 0 || l.dy !== 0 || l.dz !== 0) lobe = clamp(-(l.dx * lx + l.dy * ly + l.dz * lz) / d + 0.3, 0, 1);
      const q = d / l.range;
      const q2 = q * q;
      const win = (1 - q2 * q2) * (1 - q2 * q2);
      // direct (N·L, inverse square, softened close to the fixture) + a little unshaded bounce
      let e = l.power * win * (((ndl > 0 ? ndl : 0) * lobe) / Math.max(d2, 9) + (0.2 * (0.35 + 0.65 * lobe)) / (d2 + 36));
      if (e < 0.012) continue;
      // soft occlusion: march the voxel volume from the start point to 2 m short of the lamp
      const mx = l.x - sx;
      const my = l.y - sy;
      const mz = l.z - sz;
      const len = Math.sqrt(mx * mx + my * my + mz * mz);
      const usable = len - 2;
      if (usable > 0.5) {
        const n = Math.min(26, Math.ceil(usable));
        const f = usable / len / n;
        let t = 1;
        for (let i = 0; i < n; i++) {
          const w = (i + 0.5) * f;
          const o = occ.sample(sx + mx * w, sy + my * w, sz + mz * w);
          if (o > 0.02) {
            const pass = 1 - o;
            t *= pass * pass;
            if (t < 0.03) {
              t = 0;
              break;
            }
          }
        }
        e *= t;
        if (e < 0.004) continue;
      }
      if (e > 5) e = 5;
      r += l.r * e;
      g += l.g * e;
      b += l.b * e;
    }
    out[0] = r;
    out[1] = g;
    out[2] = b;
    return out;
  }

  // ───────────────────────────── geometry emitters ─────────────────────────────
  private cuts(a0: number, a1: number, out: Float64Array): number {
    let n = 0;
    out[n++] = a0;
    if (a1 - a0 > TESS * 1.5) {
      let c = Math.ceil((a0 + 0.75) / TESS) * TESS;
      while (c < a1 - 0.75 && n < out.length - 1) {
        out[n++] = c;
        c += TESS;
      }
    }
    out[n++] = a1;
    return n;
  }

  /**
   * One axis-aligned rectangle, tessellated on the world grid, with baked light.
   * axis 0: plane x = coord, (a, b) = (z, y) · axis 1: plane y = coord, (a, b) = (x, z) · axis 2: plane z = coord, (a, b) = (x, y).
   */
  private emitFace(buf: GeoBuf, axis: number, sign: number, coord: number, a0: number, a1: number, b0: number, b1: number, layer: number, r: number, g: number, b: number, lit: boolean, overlay = false): void {
    const na = this.cuts(a0, a1, this.cutA);
    const nb = this.cuts(b0, b1, this.cutB);
    const am = (a0 + a1) / 2;
    const bm = (b0 + b1) / 2;
    const nx = axis === 0 ? sign : 0;
    const ny = axis === 1 ? sign : 0;
    const nz = axis === 2 ? sign : 0;
    const base = buf.count;
    buf.surface(overlay ? Infinity : (a1 - a0) * (b1 - b0));
    const tBake = performance.now();
    const local = this.uvLocal || (axis === 1 && this.topLocal);
    const ua = local ? a0 : 0;
    const ub = local ? b0 : 0;
    const swap = axis === 1 ? this.uvSwapTop : this.uvSwapSide;
    // undersides and ceilings receive a share of the light that reaches the space below them (floor bounce)
    const bounce = lit && axis === 1 && sign < 0;
    for (let j = 0; j < nb; j++) {
      const bb = this.cutB[j]!;
      const ib = bb + clamp(bm - bb, -1.2, 1.2);
      for (let i = 0; i < na; i++) {
        const a = this.cutA[i]!;
        const ia = a + clamp(am - a, -1.2, 1.2);
        let x: number;
        let y: number;
        let z: number;
        let sx: number;
        let sy: number;
        let sz: number;
        if (axis === 0) {
          x = coord;
          y = bb;
          z = a;
          sx = coord + sign * 2;
          sy = ib;
          sz = ia;
        } else if (axis === 1) {
          x = a;
          y = coord;
          z = bb;
          sx = ia;
          sy = coord + sign * 2;
          sz = ib;
        } else {
          x = a;
          y = bb;
          z = coord;
          sx = ia;
          sy = ib;
          sz = coord + sign * 2;
        }
        if (lit) {
          const e = this.bake(x, y, z, nx, ny, nz, sx, sy, sz);
          let er = e[0]!;
          let eg = e[1]!;
          let eb = e[2]!;
          if (bounce) {
            const f = this.bake(sx, y - 3, sz, 0, 1, 0, sx, y - 2.2, sz);
            er += f[0]! * 0.22;
            eg += f[1]! * 0.22;
            eb += f[2]! * 0.22;
          }
          buf.vertex(x, y, z, nx, ny, nz, swap ? bb - ub : a - ua, swap ? a - ua : bb - ub, r, g, b, layer, er, eg, eb);
        } else {
          buf.vertex(x, y, z, nx, ny, nz, swap ? bb - ub : a - ua, swap ? a - ua : bb - ub, r, g, b, layer, 0, 0, 0);
        }
      }
    }
    this.bakeMs += performance.now() - tBake;
    const flip = axis === 2 ? sign < 0 : sign > 0;
    for (let j = 0; j < nb - 1; j++) {
      for (let i = 0; i < na - 1; i++) {
        const p00 = base + j * na + i;
        const p10 = p00 + 1;
        const p01 = p00 + na;
        const p11 = p01 + 1;
        if (flip) {
          buf.tri(p00, p11, p10);
          buf.tri(p00, p01, p11);
        } else {
          buf.tri(p00, p10, p11);
          buf.tri(p00, p11, p01);
        }
      }
    }
  }

  /** All faces of a box. `self` ≥ 0 enables the covered-face test against the other solids. Returns the faces skipped. */
  private emitBox(buf: GeoBuf, bx: Box, layer: number, r: number, g: number, b: number, self: number, lit: boolean): number {
    const { min, max } = bx;
    let culled = 0;
    const under = 0.72;
    const side = 0.94;
    // ±X
    if (self >= 0 && this.faceCovered(self, 0, 1, max.x, min.z, max.z, min.y, max.y)) culled++;
    else this.emitFace(buf, 0, 1, max.x, min.z, max.z, min.y, max.y, layer, r * side, g * side, b * side, lit);
    if (self >= 0 && this.faceCovered(self, 0, -1, min.x, min.z, max.z, min.y, max.y)) culled++;
    else this.emitFace(buf, 0, -1, min.x, min.z, max.z, min.y, max.y, layer, r * side, g * side, b * side, lit);
    // ±Y
    const ly = this.topLayer >= 0 ? this.topLayer : layer;
    if (self >= 0 && this.faceCovered(self, 1, 1, max.y, min.x, max.x, min.z, max.z)) culled++;
    else this.emitFace(buf, 1, 1, max.y, min.x, max.x, min.z, max.z, ly, r * this.topTint, g * this.topTint, b * this.topTint, lit);
    if (self >= 0 && this.faceCovered(self, 1, -1, min.y, min.x, max.x, min.z, max.z)) culled++;
    else this.emitFace(buf, 1, -1, min.y, min.x, max.x, min.z, max.z, ly, r * under, g * under, b * under, lit);
    // ±Z
    if (self >= 0 && this.faceCovered(self, 2, 1, max.z, min.x, max.x, min.y, max.y)) culled++;
    else this.emitFace(buf, 2, 1, max.z, min.x, max.x, min.y, max.y, layer, r * side, g * side, b * side, lit);
    if (self >= 0 && this.faceCovered(self, 2, -1, min.z, min.x, max.x, min.y, max.y)) culled++;
    else this.emitFace(buf, 2, -1, min.z, min.x, max.x, min.y, max.y, layer, r * side, g * side, b * side, lit);
    return culled;
  }

  /**
   * Safety-yellow lines along the walkable edges of a slab that border a drop (≥ 1.7 m) — on the top surface and
   * on the upper part of the slab's side, so ledges read from above and from below. Returns the strips emitted.
   */
  private emitLedges(buf: GeoBuf, s: SolidDef, self: number): number {
    const w = s.max.x - s.min.x;
    const d = s.max.z - s.min.z;
    if (Math.min(w, d) < 2) return 0;
    const top = s.max.y;
    if (this.faceCovered(self, 1, 1, top, s.min.x, s.max.x, s.min.z, s.max.z)) return 0;
    const [lr, lg, lb] = LEDGE_TINT;
    const sideH = Math.min(0.32, (s.max.y - s.min.y) * 0.6);
    let strips = 0;
    // edge e: 0 = -x, 1 = +x (run along z) · 2 = -z, 3 = +z (run along x)
    for (let e = 0; e < 4; e++) {
      const alongZ = e < 2;
      const sign = (e & 1) === 0 ? -1 : 1;
      const edge = alongZ ? (sign < 0 ? s.min.x : s.max.x) : sign < 0 ? s.min.z : s.max.z;
      const t0 = alongZ ? s.min.z : s.min.x;
      const t1 = alongZ ? s.max.z : s.max.x;
      const step = 0.5;
      const n = Math.max(1, Math.round((t1 - t0) / step));
      let runStart = -1;
      for (let i = 0; i <= n; i++) {
        let open = false;
        if (i < n) {
          const t = t0 + ((i + 0.5) * (t1 - t0)) / n;
          const ox = alongZ ? edge + sign * 0.4 : t;
          const oz = alongZ ? t : edge + sign * 0.4;
          const ix = alongZ ? edge - sign * 0.6 : t;
          const iz = alongZ ? t : edge - sign * 0.6;
          open =
            !this.pointInSolid(ox, top - 0.25, oz) &&
            !this.pointInSolid(ox, top - 1.0, oz) &&
            !this.pointInSolid(ox, top - 1.7, oz) &&
            !this.pointInSolid(ox, top + 0.5, oz) &&
            !this.pointInSolid(ix, top + 1.0, iz) &&
            !this.pointInSolid(ix, top + 3.9, iz);
        }
        if (open && runStart < 0) runStart = i;
        if (!open && runStart >= 0) {
          const a0 = t0 + (runStart * (t1 - t0)) / n;
          const a1 = t0 + (i * (t1 - t0)) / n;
          runStart = -1;
          if (a1 - a0 < 0.99) continue;
          strips++;
          const y = top + 0.03;
          const in0 = sign < 0 ? edge + 0.04 : edge - 0.36;
          const in1 = sign < 0 ? edge + 0.36 : edge - 0.04;
          if (alongZ) {
            this.emitFace(buf, 1, 1, y, in0, in1, a0, a1, LAYER.paint, lr, lg, lb, true, true);
            this.emitFace(buf, 0, sign, edge + sign * 0.03, a0, a1, top - sideH, top, LAYER.paint, lr * 0.92, lg * 0.92, lb * 0.92, true, true);
          } else {
            this.emitFace(buf, 1, 1, y, a0, a1, in0, in1, LAYER.paint, lr, lg, lb, true, true);
            this.emitFace(buf, 2, sign, edge + sign * 0.03, a0, a1, top - sideH, top, LAYER.paint, lr * 0.92, lg * 0.92, lb * 0.92, true, true);
          }
        }
      }
    }
    return strips;
  }

  /**
   * One StageDef marking as flat faces a few centimetres off its surface: paint goes into `geo` (textured, lit
   * by the baked lamps like the surface below it), illuminated faces into `lamps`. Returns the faces emitted.
   */
  private emitMarking(m: MarkingDef, geo: GeoBuf, lamps: LampBuf): number {
    // surface frame: n = outward normal, r = reading direction, u = up of the marking (r × u = n)
    let nx = 0;
    let ny = 0;
    let nz = 0;
    let rx = 0;
    let rz = 0;
    let ux = 0;
    let uy = 1;
    let uz = 0;
    if (m.facing === 'x+') {
      nx = 1;
      rz = -1;
    } else if (m.facing === 'x-') {
      nx = -1;
      rz = 1;
    } else if (m.facing === 'z+') {
      nz = 1;
      rx = 1;
    } else if (m.facing === 'z-') {
      nz = -1;
      rx = -1;
    } else {
      ny = 1;
      uy = 0;
      const t = m.top ?? 'z-';
      if (t === 'z-') {
        uz = -1;
        rx = 1;
      } else if (t === 'z+') {
        uz = 1;
        rx = -1;
      } else if (t === 'x+') {
        ux = 1;
        rz = 1;
      } else {
        ux = -1;
        rz = -1;
      }
    }
    const glow = MARK_GLOW[m.style];
    const paint = MARK_PAINT[m.style] ?? MARK_PAINT.white!;
    const off = glow ? 0.055 : m.style === 'dark' || m.style === 'hazard' ? 0.022 : 0.038;
    const ox = m.position.x + nx * off;
    const oy = m.position.y + ny * off;
    const oz = m.position.z + nz * off;

    // faces in the surface frame: [x0, y0, x1, y1, x2, y2, x3, y3] counter-clockwise, + the glyph each belongs to
    const polys: number[][] = [];
    const glyphOf: number[] = [];
    if (m.text === undefined) {
      const cx = Math.max(1, Math.ceil(m.width / TESS));
      const cy = Math.max(1, Math.ceil(m.height / TESS));
      for (let j = 0; j < cy; j++) {
        for (let i = 0; i < cx; i++) {
          const x0 = -m.width / 2 + (m.width * i) / cx;
          const x1 = -m.width / 2 + (m.width * (i + 1)) / cx;
          const y0 = -m.height / 2 + (m.height * j) / cy;
          const y1 = -m.height / 2 + (m.height * (j + 1)) / cy;
          polys.push([x0, y0, x1, y0, x1, y1, x0, y1]);
          glyphOf.push(0);
        }
      }
    } else {
      // layout in font pixels: glyphs are 5 wide, chevrons 7, 1 px apart, a space is 3 px
      const items: Array<{ ch: string; x: number }> = [];
      let cx = 0;
      for (const raw of m.text) {
        if (raw === ' ') {
          cx += 3;
          continue;
        }
        // a lower-case 'v' is the down chevron, every other letter is upper-cased
        const ch = raw === 'v' ? 'v' : raw.toUpperCase();
        items.push({ ch, x: cx });
        cx += (ch === '^' || ch === 'v' || ch === '<' || ch === '>' ? 7 : 5) + 1;
      }
      const total = Math.max(1, cx - 1);
      const px = Math.min(m.width / total, m.height / 7);
      const x0 = (-total * px) / 2;
      const y0 = -3.5 * px;
      // up-chevron in a 7×7 cell: two bars, counter-clockwise
      const CHEVRON = [
        [0.3, 0.6, 3.5, 4.2, 3.5, 6.6, 0.3, 3.0],
        [6.7, 0.6, 6.7, 3.0, 3.5, 6.6, 3.5, 4.2],
      ];
      items.forEach((it, gi) => {
        const ch = it.ch;
        if (ch === '^' || ch === 'v' || ch === '<' || ch === '>') {
          const kind = ch;
          for (const bar of CHEVRON) {
            const q: number[] = [];
            for (let k = 0; k < 4; k++) {
              const bx = bar[k * 2]!;
              const by = bar[k * 2 + 1]!;
              let tx = bx;
              let ty = by;
              if (kind === 'v') ty = 7 - by;
              else if (kind === '>') {
                tx = by;
                ty = bx;
              } else if (kind === '<') {
                tx = 7 - by;
                ty = bx;
              }
              q.push(x0 + (it.x + tx) * px, y0 + ty * px);
            }
            // a single mirror flips the winding
            if (kind === 'v' || kind === '>') polys.push([q[0]!, q[1]!, q[6]!, q[7]!, q[4]!, q[5]!, q[2]!, q[3]!]);
            else polys.push(q);
            glyphOf.push(gi);
          }
          return;
        }
        const g = FONT[ch];
        if (!g) return;
        for (let row = 0; row < 7; row++) {
          const line = g[row]!;
          let x = 0;
          while (x < 5) {
            if (line[x] !== '1') {
              x++;
              continue;
            }
            let e = x;
            while (e < 5 && line[e] === '1') e++;
            const ax = x0 + (it.x + x) * px;
            const bx = x0 + (it.x + e) * px;
            const ay = y0 + (6 - row) * px;
            const by = y0 + (7 - row) * px;
            polys.push([ax, ay, bx, ay, bx, by, ax, by]);
            glyphOf.push(gi);
            x = e;
          }
        }
      });
    }

    const p12 = new Array<number>(12);
    if (!glow) geo.surface(Infinity); // paint lies a few centimetres in front of its surface: drawn after it, as it always was
    for (let k = 0; k < polys.length; k++) {
      const q = polys[k]!;
      for (let c = 0; c < 4; c++) {
        const lx = q[c * 2]!;
        const ly = q[c * 2 + 1]!;
        p12[c * 3] = ox + rx * lx + ux * ly;
        p12[c * 3 + 1] = oy + uy * ly;
        p12[c * 3 + 2] = oz + rz * lx + uz * ly;
      }
      if (glow) {
        lamps.quad(p12, glow, m.chase !== undefined ? 2 + ((m.chase + glyphOf[k]! * 0.12) % 1) : -1);
        continue;
      }
      const base = geo.count;
      for (let c = 0; c < 4; c++) {
        const x = p12[c * 3]!;
        const y = p12[c * 3 + 1]!;
        const z = p12[c * 3 + 2]!;
        const e = this.bake(x, y, z, nx, ny, nz, x + nx * 2, y + ny * 2, z + nz * 2);
        geo.vertex(x, y, z, nx, ny, nz, x * rx + z * rz, x * ux + y * uy + z * uz, paint.tint[0], paint.tint[1], paint.tint[2], paint.layer, e[0]!, e[1]!, e[2]!);
      }
      geo.tri(base, base + 1, base + 2);
      geo.tri(base, base + 2, base + 3);
    }
    return polys.length;
  }

  private emitCylinder(buf: GeoBuf, d: DecorDef, axis: number, layer: number, r: number, g: number, b: number): void {
    const lo = [d.min.x, d.min.y, d.min.z];
    const hi = [d.max.x, d.max.y, d.max.z];
    const e1 = (axis + 1) % 3;
    const e2 = (axis + 2) % 3;
    const r1 = (hi[e1]! - lo[e1]!) / 2;
    const r2 = (hi[e2]! - lo[e2]!) / 2;
    const c1 = (hi[e1]! + lo[e1]!) / 2;
    const c2 = (hi[e2]! + lo[e2]!) / 2;
    const rad = Math.max(r1, r2);
    if (rad < 1e-4) return;
    const segs = clamp(Math.round(7 + rad * 7), 8, 16);
    const nr = this.cuts(lo[axis]!, hi[axis]!, this.cutA);
    const tile = LAYER_TILE_M[layer]!;
    const circ = Math.max(1, Math.round((2 * Math.PI * rad) / tile)) * tile;
    const p = [0, 0, 0];
    const n = [0, 0, 0];
    const base = buf.count;
    buf.surface(2 * rad * (hi[axis]! - lo[axis]!)); // silhouette area
    for (let i = 0; i < nr; i++) {
      const t = this.cutA[i]!;
      for (let j = 0; j <= segs; j++) {
        const th = (j / segs) * Math.PI * 2;
        const cs = Math.cos(th);
        const sn = Math.sin(th);
        p[axis] = t;
        p[e1] = c1 + r1 * cs;
        p[e2] = c2 + r2 * sn;
        n[axis] = 0;
        n[e1] = cs;
        n[e2] = sn;
        const e = this.bake(p[0]!, p[1]!, p[2]!, n[0]!, n[1]!, n[2]!, p[0]! + n[0]! * 2, p[1]! + n[1]! * 2, p[2]! + n[2]! * 2);
        // darker belly for horizontal pipes
        const shade = axis === 1 ? 0.94 : 0.86 + 0.14 * (n[1]! * 0.5 + 0.5);
        buf.vertex(p[0]!, p[1]!, p[2]!, n[0]!, n[1]!, n[2]!, t, (j / segs) * circ, r * shade, g * shade, b * shade, layer, e[0]!, e[1]!, e[2]!);
      }
    }
    const ring = segs + 1;
    for (let i = 0; i < nr - 1; i++) {
      for (let j = 0; j < segs; j++) {
        const a = base + i * ring + j;
        const bq = a + 1;
        const c = a + ring + 1;
        const dd = a + ring;
        buf.tri(a, bq, c);
        buf.tri(a, c, dd);
      }
    }
    if (rad < 0.12) return;
    for (let end = 0; end < 2; end++) {
      const t = end === 0 ? lo[axis]! : hi[axis]!;
      const sgn = end === 0 ? -1 : 1;
      n[axis] = sgn;
      n[e1] = 0;
      n[e2] = 0;
      p[axis] = t;
      p[e1] = c1;
      p[e2] = c2;
      const e = this.bake(p[0]!, p[1]!, p[2]!, n[0]!, n[1]!, n[2]!, p[0]! + n[0]! * 2, p[1]! + n[1]! * 2, p[2]! + n[2]! * 2);
      const er = e[0]!;
      const eg = e[1]!;
      const eb = e[2]!;
      const centre = buf.vertex(p[0]!, p[1]!, p[2]!, n[0]!, n[1]!, n[2]!, c1, c2, r * 0.8, g * 0.8, b * 0.8, layer, er, eg, eb);
      const first = buf.count;
      for (let j = 0; j <= segs; j++) {
        const th = (j / segs) * Math.PI * 2;
        p[e1] = c1 + r1 * Math.cos(th);
        p[e2] = c2 + r2 * Math.sin(th);
        buf.vertex(p[0]!, p[1]!, p[2]!, n[0]!, n[1]!, n[2]!, p[e1]!, p[e2]!, r * 0.8, g * 0.8, b * 0.8, layer, er, eg, eb);
      }
      for (let j = 0; j < segs; j++) {
        if (sgn > 0) buf.tri(centre, first + j, first + j + 1);
        else buf.tri(centre, first + j + 1, first + j);
      }
    }
  }

  // ───────────────────────────── halos ─────────────────────────────
  private buildHalos(): void {
    if (this.lamps.length === 0) return;
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const n = this.lamps.length;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 4);
    const dir = new Float32Array(n * 3);
    const blink = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const l = this.lamps[i]!;
      pos[i * 3] = l.x - l.dx * 0.5;
      pos[i * 3 + 1] = l.y - l.dy * 0.5;
      pos[i * 3 + 2] = l.z - l.dz * 0.5;
      dir[i * 3] = l.dx;
      dir[i * 3 + 1] = l.dy;
      dir[i * 3 + 2] = l.dz;
      const k = l.blink >= 0 ? 1.5 : 1;
      col[i * 4] = l.r * k;
      col[i * 4 + 1] = l.g * k;
      col[i * 4 + 2] = l.b * k;
      col[i * 4 + 3] = l.haloSize * (l.blink >= 0 ? 1.6 : 1) * 2.2;
      blink[i] = l.blink;
    }
    g.setAttribute('iPos', new THREE.InstancedBufferAttribute(pos, 3));
    g.setAttribute('iDir', new THREE.InstancedBufferAttribute(dir, 3));
    this.haloCol = new THREE.InstancedBufferAttribute(col, 4);
    this.haloBlink = new THREE.InstancedBufferAttribute(blink, 1);
    g.setAttribute('iCol', this.haloCol);
    g.setAttribute('iBlink', this.haloBlink);
    g.instanceCount = n;
    this.geometries.push(g);
    const m = new THREE.Mesh(g, this.haloMaterial);
    m.name = 'lamp-halos';
    m.frustumCulled = false;
    m.matrixAutoUpdate = false;
    m.renderOrder = 3;
    this.group.add(m);
  }

  // ───────────────────────────── doors ─────────────────────────────
  private buildDoor(id: string, box: Box, isGate: boolean): void {
    const dx = box.max.x - box.min.x;
    const dz = box.max.z - box.min.z;
    const thinX = dx <= dz;
    const W = thinX ? dz : dx;
    const T = thinX ? dx : dz;
    const H = box.max.y - box.min.y;
    if (!(W > 0.05 && T > 0.01 && H > 0.05)) return;
    const u0 = thinX ? box.min.z : box.min.x;
    const w0 = thinX ? box.min.x : box.min.z;
    const v0 = box.min.y;
    const bufs = [new GeoBuf(), new GeoBuf()];
    const reds = [new LampBuf(), new LampBuf()];
    const greens = [new LampBuf(), new LampBuf()];
    const world = (ua: number, va: number, wa: number, ub: number, vb: number, wb: number): Box =>
      thinX
        ? { min: { x: w0 + wa, y: v0 + va, z: u0 + ua }, max: { x: w0 + wb, y: v0 + vb, z: u0 + ub } }
        : { min: { x: u0 + ua, y: v0 + va, z: w0 + wa }, max: { x: u0 + ub, y: v0 + vb, z: w0 + wb } };
    const part = (leaf: number, ua: number, va: number, wa: number, ub: number, vb: number, wb: number, layer: number, c: RGB): void => {
      if (ub - ua < 1e-3 || vb - va < 1e-3 || wb - wa < 1e-3) return;
      this.emitBox(bufs[leaf]!, world(ua, va, wa, ub, vb, wb), layer, c[0], c[1], c[2], -1, true);
    };
    const lamp = (leaf: number, ua: number, va: number, ub: number, vb: number, col: RGB, blink: number): void => {
      // flush lamp plates on both faces
      const t = Math.min(0.08, T * 0.2);
      for (const [wa, wb] of [
        [0, t],
        [T - t, T],
      ] as const) {
        const b = world(ua, va, wa, ub, vb, wb);
        reds[leaf]!.box(b, col, blink);
        greens[leaf]!.box(b, LAMP_GREEN, -1);
      }
    };
    const inset = Math.min(0.16, T * 0.22);
    const DARK: RGB = [0.5, 0.52, 0.56];
    const PALE: RGB = [0.96, 0.95, 0.9];
    const phase = hash3(box.min.x, box.min.y, box.min.z);
    // text direction on the two faces so the marking reads correctly from both sides
    const hand = thinX ? -1 : 1;
    const marking = (text: string, uc: number, vc: number, px: number, leafOf: (u: number) => number, splitU: number | null, onlyFace = -1): void => {
      const { runs, width } = glyphRuns(text);
      for (let face = 0; face < 2; face++) {
        if (onlyFace >= 0 && face !== onlyFace) continue;
        const s = face === 0 ? -1 : 1; // face at w = 0 looks along -w, face at w = T along +w
        const dir = hand * s;
        const wa = face === 0 ? 0.015 : T - inset - 0.01;
        const wb = face === 0 ? inset + 0.01 : T - 0.015;
        for (const run of runs) {
          let ua = uc + dir * (run[0]! - width / 2) * px;
          let ub = uc + dir * (run[2]! - width / 2) * px;
          if (ua > ub) [ua, ub] = [ub, ua];
          const va = vc + (run[1]! - 3.5) * px;
          const vb = vc + (run[3]! - 3.5) * px;
          if (splitU !== null && ua < splitU && ub > splitU) {
            part(leafOf(ua), ua, va, wa, splitU, vb, wb, LAYER.paint, PALE);
            part(leafOf(ub), splitU, va, wa, ub, vb, wb, LAYER.paint, PALE);
          } else {
            part(leafOf((ua + ub) / 2), ua, va, wa, ub, vb, wb, LAYER.paint, PALE);
          }
        }
      }
    };

    let axis: 'x' | 'y' | 'z';
    const anchors: THREE.Vector3[] = [];
    if (!isGate) {
      // ── barrier: horizontally split shutter, upper leaf retracts up, lower leaf down ──
      axis = 'y';
      const RED: RGB = [0.7, 0.3, 0.22];
      const hm = H / 2;
      const beam = Math.min(0.45, H * 0.08);
      const band = Math.min(0.62, H * 0.1);
      const post = Math.min(0.45, W * 0.06);
      for (let leaf = 0; leaf < 2; leaf++) {
        const va = leaf === 0 ? hm : 0;
        const vb = leaf === 0 ? H : hm;
        part(leaf, 0, va, inset, W, vb, T - inset, LAYER.shutter, RED);
        // outer beam, seam band, end posts (all flush with the collision box)
        if (leaf === 0) {
          part(leaf, 0, H - beam, 0, W, H, T, LAYER.metal, DARK);
          part(leaf, 0, hm, 0, W, hm + band, T, LAYER.hazard, W1);
        } else {
          part(leaf, 0, 0, 0, W, beam, T, LAYER.metal, DARK);
          part(leaf, 0, hm - band, 0, W, hm, T, LAYER.hazard, W1);
        }
        const pa = leaf === 0 ? hm + band : beam;
        const pb = leaf === 0 ? H - beam : hm - band;
        part(leaf, 0, pa, 0, post, pb, T, LAYER.metal, DARK);
        part(leaf, W - post, pa, 0, W, pb, T, LAYER.metal, DARK);
      }
      // id marking on the upper leaf
      const { width } = glyphRuns(id);
      const freeV = hm - band - beam;
      const px = Math.max(0.05, Math.min(0.38, (freeV - 0.5) / 7, (W - 2 * post - 1) / Math.max(1, width)));
      const textHalf = (width * px) / 2;
      // dark name plate behind the id: the stencil stays readable on the rusty slats
      part(0, W / 2 - textHalf - 0.45, hm + band + freeV / 2 - 3.5 * px - 0.3, inset * 0.55, W / 2 + textHalf + 0.45, hm + band + freeV / 2 + 3.5 * px + 0.3, T - inset * 0.55, LAYER.metal, [0.2, 0.22, 0.25]);
      marking(id, W / 2, hm + band + freeV / 2, px, () => 0, null);
      // ribs on both leaves (kept clear of the marking)
      const nr = Math.max(1, Math.round(W / 3.5));
      for (let k = 1; k < nr; k++) {
        const u = (W * k) / nr;
        for (let leaf = 0; leaf < 2; leaf++) {
          if (leaf === 0 && Math.abs(u - W / 2) < textHalf + 0.5) continue;
          if (leaf === 1 && Math.abs(u - W / 2) < 1.7) continue;
          const pa = leaf === 0 ? hm + band : beam;
          const pb = leaf === 0 ? H - beam : hm - band;
          part(leaf, u - 0.14, pa, inset * 0.35, u + 0.14, pb, T - inset * 0.35, LAYER.metal, DARK);
        }
      }
      // lock housing + lamps
      const lockH = Math.min(1.1, (hm - band - beam) * 0.6);
      const lockW = Math.min(2.6, W * 0.4);
      part(1, W / 2 - lockW / 2, hm - band - lockH, 0.03, W / 2 + lockW / 2, hm - band, T - 0.03, LAYER.metal, DARK);
      lamp(1, W / 2 - lockW * 0.36, hm - band - lockH * 0.72, W / 2 + lockW * 0.36, hm - band - lockH * 0.3, LAMP_RED, phase);
      const ls = Math.min(0.5, post * 1.2);
      lamp(0, post + 0.25, H - beam - 0.3 - ls, post + 0.25 + ls, H - beam - 0.3, LAMP_RED, phase);
      lamp(0, W - post - 0.25 - ls, H - beam - 0.3 - ls, W - post - 0.25, H - beam - 0.3, LAMP_RED, phase);
      anchors.push(new THREE.Vector3((box.min.x + box.max.x) / 2, box.max.y, (box.min.z + box.max.z) / 2));
      anchors.push(new THREE.Vector3((box.min.x + box.max.x) / 2, box.min.y, (box.min.z + box.max.z) / 2));
    } else {
      // ── final gate: vertically split blast door, the leaves retract sideways ──
      axis = thinX ? 'z' : 'x';
      const STEEL: RGB = [0.4, 0.47, 0.57];
      const um = W / 2;
      const band = Math.min(0.9, H * 0.1);
      const post = Math.min(0.7, W * 0.05);
      const seam = Math.min(0.5, W * 0.04);
      const leafOf = (u: number): number => (u < um ? 0 : 1);
      for (let leaf = 0; leaf < 2; leaf++) {
        const ua = leaf === 0 ? 0 : um;
        const ub = leaf === 0 ? um : W;
        part(leaf, ua, 0, inset, ub, H, T - inset, LAYER.shutter, STEEL);
        part(leaf, ua, 0, 0, ub, band, T, LAYER.hazard, W1);
        part(leaf, ua, H - band, 0, ub, H, T, LAYER.hazard, W1);
        if (leaf === 0) {
          part(leaf, 0, band, 0, post, H - band, T, LAYER.metal, DARK);
          part(leaf, um - seam, band, 0, um, H - band, T, LAYER.metal, DARK);
        } else {
          part(leaf, W - post, band, 0, W, H - band, T, LAYER.metal, DARK);
          part(leaf, um, band, 0, um + seam, H - band, T, LAYER.metal, DARK);
        }
      }
      // the id is split in two halves, one per leaf, clear of the seam posts
      const half = Math.ceil(id.length / 2);
      const parts = [id.slice(0, half), id.slice(half)];
      const widest = Math.max(1, glyphRuns(parts[0]!).width, glyphRuns(parts[1]!).width);
      const freeV = H - 2 * band;
      const freeU = um - seam - post;
      const px = Math.max(0.05, Math.min(0.6, (freeV - 2.2) / 7, (freeU - 1.2) / widest));
      const vc = band + freeV / 2;
      // which half sits on which leaf depends on the side it is read from, so each face gets its own pair
      for (let face = 0; face < 2; face++) {
        const dir = hand * (face === 0 ? -1 : 1);
        for (let k = 0; k < 2; k++) {
          const leaf = dir > 0 ? k : 1 - k;
          const uc = leaf === 0 ? post + freeU / 2 : um + seam + freeU / 2;
          if (parts[k]!.length > 0) marking(parts[k]!, uc, vc, px, () => leaf, null, face);
        }
      }
      // rails above and below the marking
      const rail = 3.5 * px + 0.45;
      for (let leaf = 0; leaf < 2; leaf++) {
        const ua = leaf === 0 ? post : um + seam;
        const ub = leaf === 0 ? um - seam : W - post;
        part(leaf, ua, vc + rail, inset * 0.35, ub, vc + rail + 0.3, T - inset * 0.35, LAYER.paint, LEDGE_TINT);
        part(leaf, ua, vc - rail - 0.3, inset * 0.35, ub, vc - rail, T - inset * 0.35, LAYER.paint, LEDGE_TINT);
      }
      // lock lamps on the seam posts, amber beacons under the top band
      for (const f of [0.28, 0.5, 0.72]) {
        const vc2 = band + freeV * f;
        lamp(0, um - seam * 0.85, vc2 - 0.32, um - seam * 0.2, vc2 + 0.32, LAMP_RED, phase);
        lamp(1, um + seam * 0.2, vc2 - 0.32, um + seam * 0.85, vc2 + 0.32, LAMP_RED, phase);
      }
      for (const f of [0.14, 0.36, 0.64, 0.86]) {
        const leaf = f < 0.5 ? 0 : 1;
        lamp(leaf, W * f - 0.7, H - band - 0.55, W * f + 0.7, H - band - 0.2, LAMP_AMBER, (phase + (f < 0.3 || (f > 0.5 && f < 0.7) ? 0 : 0.5)) % 1);
      }
      const cy = (box.min.y + box.max.y) / 2;
      if (thinX) {
        anchors.push(new THREE.Vector3((box.min.x + box.max.x) / 2, cy, box.min.z));
        anchors.push(new THREE.Vector3((box.min.x + box.max.x) / 2, cy, box.max.z));
      } else {
        anchors.push(new THREE.Vector3(box.min.x, cy, (box.min.z + box.max.z) / 2));
        anchors.push(new THREE.Vector3(box.max.x, cy, (box.min.z + box.max.z) / 2));
      }
    }

    const door: Door = { id, group: new THREE.Group(), leaves: [], axis, red: [], green: [], open: false, t: 0 };
    door.group.name = `door-${id}`;
    for (let leaf = 0; leaf < 2; leaf++) {
      const node = new THREE.Group();
      const a = anchors[leaf]!;
      node.position.copy(a);
      const add = (g: THREE.BufferGeometry, mat: THREE.Material): THREE.Mesh => {
        g.translate(-a.x, -a.y, -a.z);
        g.computeBoundingBox();
        g.computeBoundingSphere();
        this.geometries.push(g);
        const m = new THREE.Mesh(g, mat);
        node.add(m);
        return m;
      };
      if (bufs[leaf]!.count > 0) add(bufs[leaf]!.toGeometry(), this.material);
      if (reds[leaf]!.count > 0) {
        door.red.push(add(reds[leaf]!.toGeometry(), this.lampMaterial));
        const gm = add(greens[leaf]!.toGeometry(), this.lampMaterial);
        gm.visible = false;
        door.green.push(gm);
      }
      door.leaves.push(node);
      door.group.add(node);
    }
    this.group.add(door.group);
    this.doors.set(id, door);
    this.doorList.push(door);
  }

  private finishDoor(d: Door): void {
    d.t = 1;
    d.group.visible = false;
  }

  // ───────────────────────────── exit marker ─────────────────────────────
  private buildExitMarker(): void {
    const z = this.stage.exitZone;
    const gate = this.stage.finalGate.box;
    const sx = z.max.x - z.min.x;
    const sz = z.max.z - z.min.z;
    this.exitGroup.name = 'exit-marker';
    this.exitGroup.visible = false;
    this.group.add(this.exitGroup);
    if (!(sx > 0.5 && sz > 0.5)) return;
    // approach direction: from the gate into the zone, snapped to the dominant axis
    const ax = (z.min.x + z.max.x) / 2 - (gate.min.x + gate.max.x) / 2;
    const az = (z.min.z + z.max.z) / 2 - (gate.min.z + gate.max.z) / 2;
    const alongX = Math.abs(ax) > Math.abs(az);
    const dirSign = (alongX ? ax : az) >= 0 ? 1 : -1;
    const pos: number[] = [];
    const uv: number[] = [];
    const kind: number[] = [];
    const idx: number[] = [];
    const quad = (p: number[], uvs: number[], k: number): void => {
      const base = pos.length / 3;
      pos.push(...p);
      uv.push(...uvs);
      kind.push(k, k, k, k);
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    const y = z.min.y + 0.07;
    const across = alongX ? sz : sx;
    const along = alongX ? sx : sz;
    // floor: uv = (across, along) in metres, along grows into the zone
    const corner = (fa: number, fl: number): number[] => {
      const l = dirSign > 0 ? fl : 1 - fl;
      return alongX ? [z.min.x + sx * l, y, z.min.z + sz * fa] : [z.min.x + sx * fa, y, z.min.z + sz * l];
    };
    quad([...corner(0, 0), ...corner(1, 0), ...corner(1, 1), ...corner(0, 1)], [0, 0, across, 0, across, along, 0, along], 0);
    // light pillars at the corners and the middle of the entrance side
    const ph = clamp(z.max.y - z.min.y, 4, 16);
    const pw = 1.3;
    const pillar = (px: number, pz: number): void => {
      quad([px - pw, y, pz, px + pw, y, pz, px + pw, y + ph, pz, px - pw, y + ph, pz], [0, 0, 1, 0, 1, 1, 0, 1], 1);
      quad([px, y, pz - pw, px, y, pz + pw, px, y + ph, pz + pw, px, y + ph, pz - pw], [0, 0, 1, 0, 1, 1, 0, 1], 1);
    };
    for (const fx of [0.03, 0.97]) for (const fz of [0.03, 0.97]) pillar(z.min.x + sx * fx, z.min.z + sz * fz);
    // EXIT sign above the entrance edge, readable from the approach side
    const { runs, width } = glyphRuns('EXIT');
    const px = clamp((across * 0.5) / width, 0.2, 0.6);
    const sy = z.min.y + Math.min(ph * 0.5, 6);
    const edge = corner(0.5, 0.06);
    // viewer looks along the approach direction d; text runs along the viewer's right = (-d.z, 0, d.x)
    const tx = alongX ? 0 : -dirSign;
    const tz = alongX ? dirSign : 0;
    {
      // backing plate first (drawn before the glyphs of the same mesh)
      const hw = (width / 2 + 1.6) * px;
      const y0 = sy - 1.2 * px;
      const y1 = sy + 8.2 * px;
      quad([edge[0]! - tx * hw, y0, edge[2]! - tz * hw, edge[0]! + tx * hw, y0, edge[2]! + tz * hw, edge[0]! + tx * hw, y1, edge[2]! + tz * hw, edge[0]! - tx * hw, y1, edge[2]! - tz * hw], [0, 0, 1, 0, 1, 1, 0, 1], 3);
    }
    for (const run of runs) {
      const a0 = (run[0]! - width / 2) * px;
      const a1 = (run[2]! - width / 2) * px;
      const b0 = sy + run[1]! * px;
      const b1 = sy + run[3]! * px;
      quad(
        [edge[0]! + tx * a0, b0, edge[2]! + tz * a0, edge[0]! + tx * a1, b0, edge[2]! + tz * a1, edge[0]! + tx * a1, b1, edge[2]! + tz * a1, edge[0]! + tx * a0, b1, edge[2]! + tz * a0],
        [0, 0, 1, 0, 1, 1, 0, 1],
        2,
      );
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('aUv', new THREE.BufferAttribute(new Float32Array(uv), 2));
    g.setAttribute('aKind', new THREE.BufferAttribute(new Float32Array(kind), 1));
    g.setIndex(idx);
    g.computeBoundingSphere();
    this.geometries.push(g);
    (this.exitMaterial.uniforms.uSize!.value as THREE.Vector2).set(across, along);
    const m = new THREE.Mesh(g, this.exitMaterial);
    m.renderOrder = 4;
    m.matrixAutoUpdate = false;
    this.exitGroup.add(m);
  }

  // ───────────────────────────── dynamic light pool ─────────────────────────────
  private buildPool(): void {
    for (let i = 0; i < POOL_LIGHTS; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 30, 2);
      l.name = `pool-light-${i}`;
      this.pool.push(l);
      this.poolLamp.push(-1);
      this.poolFade.push(0);
      this.group.add(l);
    }
  }

  private updatePool(dt: number, focus: P3): void {
    const n = this.pool.length;
    this.poolTimer -= dt;
    if (this.poolTimer <= 0 || dt === 0) {
      this.poolTimer = 0.12;
      // the n nearest steady lamps (currently used lamps get a bonus so the choice does not flicker)
      const best = this.poolBest;
      const bestD = this.poolBestD;
      best.length = 0;
      bestD.length = 0;
      for (let k = 0; k < this.poolLamps.length; k++) {
        const li = this.poolLamps[k]!;
        const l = this.lamps[li]!;
        const dx = l.x - focus.x;
        const dy = l.y - focus.y;
        const dz = l.z - focus.z;
        let d = dx * dx + dy * dy + dz * dz;
        if (d > l.range * l.range * 1.2) continue;
        if (this.poolLamp.indexOf(li) >= 0) d *= 0.7;
        let at = best.length;
        while (at > 0 && bestD[at - 1]! > d) at--;
        if (at >= n) continue;
        best.splice(at, 0, li);
        bestD.splice(at, 0, d);
        if (best.length > n) {
          best.length = n;
          bestD.length = n;
        }
      }
    }
    const rate = dt > 0 ? dt / 0.22 : 1;
    for (let i = 0; i < n; i++) {
      const light = this.pool[i]!;
      const cur = this.poolLamp[i]!;
      const wanted = cur >= 0 && this.poolBest.indexOf(cur) >= 0;
      if (wanted) {
        this.poolFade[i] = Math.min(1, this.poolFade[i]! + rate);
      } else {
        this.poolFade[i] = Math.max(0, this.poolFade[i]! - rate);
        if (this.poolFade[i]! <= 0) {
          // take over a wanted lamp that no other pool light has
          let next = -1;
          for (const cand of this.poolBest) {
            if (this.poolLamp.indexOf(cand) < 0) {
              next = cand;
              break;
            }
          }
          this.poolLamp[i] = next;
          if (next >= 0) {
            const l = this.lamps[next]!;
            light.position.set(l.x, l.y, l.z);
            light.color.setRGB(l.r, l.g, l.b);
            light.distance = l.range * 1.15;
            light.userData.power = l.power;
          }
        }
      }
      const li = this.poolLamp[i]!;
      light.intensity = li >= 0 ? (light.userData.power as number) * this.poolFade[i]! * this.poolGain : 0;
    }
  }
}
