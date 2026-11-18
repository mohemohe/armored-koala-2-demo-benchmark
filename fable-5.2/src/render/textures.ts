/**
 * Procedural stage textures (docs/SPEC.md §1: no external assets, §8: the factory must read as an abandoned factory).
 *
 * Everything is painted at load time into 512×512 tiles with a seeded generator (no Math.random, no files):
 * shapes are rasterised with a scratch 2D canvas, noise / wear / shading are added per pixel, and the result is
 * uploaded as TWO texture arrays that the single stage material samples by layer index:
 *
 *   albedo  512×512×17  sRGB8 + A8   rgb = surface colour, a = roughness         (mipmapped, repeat, anisotropic ×4)
 *   height  256×256×17  R8            relief for bump mapping                      (mipmapped, repeat)
 *   noise   512×512     sRGB8 + A8   a copy of the albedo's noise layer            (mipmapped, repeat, NOT anisotropic)
 *
 * The noise copy exists for the fill rate only: anisotropic filtering is a property of the sampler, and the
 * two low-frequency variation lookups every stage fragment makes (macro blotches, grain) gain nothing from
 * the extra probes the surface texture needs on floors seen at a grazing angle.
 * For the same reason the surface texture asks for 4 probes at most (STAGE_ANISOTROPY): every stage fragment
 * pays for them, and against 8 the pictures of the route views differ only by a slightly softer floor joint
 * here and there (compared at 1280×720 and 1920×1080).
 *
 * GPU memory: 17.8 MB + mips = 23.8 MB (albedo) + 1.5 MB (height) + 1.4 MB (noise) ≈ 26.7 MB.
 * One sampler pair for every stage surface means one draw call per geometry chunk, whatever the materials in it.
 *
 * Orientation: canvas "up" is +v, so on vertical faces (v = world Y) drips and streaks run downwards.
 * The textures are shared (reference counted) by every StageView (factory + hangar).
 */
import * as THREE from 'three';

export const TEX_SIZE = 512;
const N = TEX_SIZE;
const NN = N * N;
const HEIGHT_SIZE = 256;
/** Upper bound of the anisotropic filtering of the albedo array (the device may support less). */
export const STAGE_ANISOTROPY = 4;

/** Layer indices of the stage texture arrays. */
export const LAYER = {
  floor: 0,
  wall: 1,
  roof: 2,
  concrete: 3,
  metal: 4,
  rust: 5,
  hazard: 6,
  catwalk: 7,
  machine: 8,
  container: 9,
  pipe: 10,
  shutter: 11,
  paint: 12,
  noise: 13,
  /** stack of pipes running along u (pipe racks; turned upright for pipe blocks) */
  pipes: 14,
  /** conveyor seen from above, travelling along u: side rollers and a ribbed belt (one repeat = the 4 m width) */
  belt: 15,
  /** storage rack front: uprights, beams and stored goods (starts at the floor) */
  shelves: 16,
} as const;
export type LayerName = keyof typeof LAYER;
export const LAYER_COUNT = 17;
/** World size (metres) of one texture repeat, per layer. */
export const LAYER_TILE_M: readonly number[] = [8, 8, 8, 6, 4, 4, 2, 2, 4, 4, 4, 4, 2, 1, 4, 4, 4];
/** Metalness per layer (kept low: there is no environment map, pure metals would go black). */
export const LAYER_METALNESS: readonly number[] = [0, 0, 0.25, 0, 0.35, 0.1, 0.1, 0.4, 0.2, 0.2, 0.25, 0.35, 0.05, 0, 0.3, 0.2, 0.15];
/** Bump strength per layer (multiplies the screen-space height derivative). */
export const LAYER_BUMP: readonly number[] = [1.6, 1.6, 2.4, 1.1, 1.8, 2.2, 0.8, 2.6, 2.0, 2.6, 1.8, 2.4, 0.8, 0, 2.6, 2.2, 2.2];

export interface StageTextures {
  albedo: THREE.DataArrayTexture;
  height: THREE.DataArrayTexture;
  /** The albedo's noise layer as a plain 2D texture without anisotropic filtering (same texels, same colour space). */
  noise: THREE.DataTexture;
}

type RGB = readonly [number, number, number];
const hex = (h: number): RGB => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];

// ───────────────────────────── deterministic random / noise ─────────────────────────────
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(x: number, y: number, seed: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Tileable value noise: `px` × `py` lattice cells across the tile (anisotropic when they differ). */
function addOctave(out: Float32Array, px: number, py: number, seed: number, amp: number): void {
  const lat = new Float32Array(px * py);
  for (let j = 0; j < py; j++) for (let i = 0; i < px; i++) lat[j * px + i] = hash2(i, j, seed);
  const sx = new Float32Array(N);
  const ix0 = new Int32Array(N);
  const ix1 = new Int32Array(N);
  const sy = new Float32Array(N);
  const iy0 = new Int32Array(N);
  const iy1 = new Int32Array(N);
  for (let x = 0; x < N; x++) {
    let f = (x / N) * px;
    let i = Math.floor(f);
    let t = f - i;
    sx[x] = t * t * (3 - 2 * t);
    ix0[x] = i % px;
    ix1[x] = (i + 1) % px;
    f = (x / N) * py;
    i = Math.floor(f);
    t = f - i;
    sy[x] = t * t * (3 - 2 * t);
    iy0[x] = i % py;
    iy1[x] = (i + 1) % py;
  }
  for (let y = 0; y < N; y++) {
    const ty = sy[y]!;
    const r0 = iy0[y]! * px;
    const r1 = iy1[y]! * px;
    const row = y * N;
    for (let x = 0; x < N; x++) {
      const tx = sx[x]!;
      const a = lat[r0 + ix0[x]!]!;
      const b = lat[r0 + ix1[x]!]!;
      const c = lat[r1 + ix0[x]!]!;
      const d = lat[r1 + ix1[x]!]!;
      const top = a + (b - a) * tx;
      const bot = c + (d - c) * tx;
      out[row + x]! += (top + (bot - top) * ty) * amp;
    }
  }
}

/** Tileable fbm normalised to 0..1 (contrast-stretched to the actual min/max). */
function fbm(basePeriod: number, octaves: number, seed: number, gain = 0.5, basePeriodY = basePeriod): Float32Array {
  const out = new Float32Array(NN);
  let amp = 1;
  let px = basePeriod;
  let py = basePeriodY;
  for (let o = 0; o < octaves && px <= N / 2 && py <= N / 2; o++) {
    addOctave(out, px, py, seed + o * 101, amp);
    amp *= gain;
    px *= 2;
    py *= 2;
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < NN; i++) {
    const v = out[i]!;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const k = 1 / Math.max(1e-6, hi - lo);
  for (let i = 0; i < NN; i++) out[i] = (out[i]! - lo) * k;
  return out;
}

/** Wrap an integer coordinate into the tile (N is a power of two). */
const wrap = (v: number): number => v & (N - 1);
/** Copy of a field shifted by (ox, oy) with wrap-around: a cheap decorrelated variant. */
function shifted(src: Float32Array, ox: number, oy: number): Float32Array {
  const out = new Float32Array(NN);
  for (let y = 0; y < N; y++) {
    const sy = wrap(y + oy) * N;
    for (let x = 0; x < N; x++) out[y * N + x] = src[sy + wrap(x + ox)]!;
  }
  return out;
}
const smooth = (lo: number, hi: number, v: number): number => {
  const t = Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
};
function thresh(src: Float32Array, lo: number, hi: number): Float32Array {
  const out = new Float32Array(NN);
  for (let i = 0; i < NN; i++) out[i] = smooth(lo, hi, src[i]!);
  return out;
}
/** Separable box blur with wrap-around (two passes ≈ triangle filter). */
function blur(src: Float32Array, rx: number, ry: number, passes = 2): Float32Array {
  let a = src;
  for (let p = 0; p < passes; p++) {
    if (rx > 0) {
      const b = new Float32Array(NN);
      const w = 2 * rx + 1;
      for (let y = 0; y < N; y++) {
        const row = y * N;
        let s = 0;
        for (let k = -rx; k <= rx; k++) s += a[row + wrap(k)]!;
        for (let x = 0; x < N; x++) {
          b[row + x] = s / w;
          s += a[row + wrap(x + rx + 1)]! - a[row + wrap(x - rx)]!;
        }
      }
      a = b;
    }
    if (ry > 0) {
      const b = new Float32Array(NN);
      const w = 2 * ry + 1;
      for (let x = 0; x < N; x++) {
        let s = 0;
        for (let k = -ry; k <= ry; k++) s += a[wrap(k) * N + x]!;
        for (let y = 0; y < N; y++) {
          b[y * N + x] = s / w;
          s += a[wrap(y + ry + 1) * N + x]! - a[wrap(y - ry) * N + x]!;
        }
      }
      a = b;
    }
  }
  return a;
}
/** Smears a mask downwards on the canvas (= down the wall): drips below stains, rivets, seams. */
function drip(src: Float32Array, length: number, decay = 0.9): Float32Array {
  const out = new Float32Array(NN);
  for (let x = 0; x < N; x++) {
    let carry = 0;
    // two laps so the smear wraps seamlessly
    for (let lap = 0; lap < 2; lap++) {
      for (let y = 0; y < N; y++) {
        const i = y * N + x;
        carry = Math.max(src[i]!, carry * decay - 1 / (length * 4));
        if (carry < 0) carry = 0;
        if (lap === 1 || carry > out[i]!) out[i] = Math.max(out[i]!, carry);
      }
    }
  }
  return out;
}

// ───────────────────────────── painter ─────────────────────────────
type G2 = CanvasRenderingContext2D;

class Painter {
  private readonly g: G2;
  constructor() {
    const cv = document.createElement('canvas');
    cv.width = cv.height = N;
    this.g = cv.getContext('2d', { willReadFrequently: true })!;
  }
  /** Rasterises white shapes on black (tiled 3×3 so everything wraps) and returns the coverage 0..1. */
  mask(draw: (g: G2) => void, tile = true): Float32Array {
    const g = this.g;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = '#000';
    g.fillRect(0, 0, N, N);
    const offs = tile ? [-N, 0, N] : [0];
    for (const dy of offs) {
      for (const dx of offs) {
        g.setTransform(1, 0, 0, 1, dx, dy);
        g.globalAlpha = 1;
        g.fillStyle = '#fff';
        g.strokeStyle = '#fff';
        g.lineCap = 'round';
        g.lineJoin = 'round';
        g.lineWidth = 1;
        draw(g);
      }
    }
    const d = g.getImageData(0, 0, N, N).data;
    const out = new Float32Array(NN);
    for (let i = 0; i < NN; i++) out[i] = d[i * 4]! / 255;
    return out;
  }
}

interface Tile {
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
  /** relief, 0.5 = neutral */
  h: Float32Array;
  /** roughness 0..1 */
  ro: Float32Array;
}
function newTile(c: RGB, rough: number): Tile {
  return {
    r: new Float32Array(NN).fill(c[0]),
    g: new Float32Array(NN).fill(c[1]),
    b: new Float32Array(NN).fill(c[2]),
    h: new Float32Array(NN).fill(0.5),
    ro: new Float32Array(NN).fill(rough),
  };
}
/** Mix towards a colour by mask·k. */
function mixc(t: Tile, m: Float32Array, c: RGB, k = 1): void {
  for (let i = 0; i < NN; i++) {
    const a = m[i]! * k;
    if (a <= 0) continue;
    const q = a > 1 ? 1 : a;
    t.r[i]! += (c[0] - t.r[i]!) * q;
    t.g[i]! += (c[1] - t.g[i]!) * q;
    t.b[i]! += (c[2] - t.b[i]!) * q;
  }
}
/** Multiply brightness by 1 + mask·k (k < 0 darkens). */
function mulc(t: Tile, m: Float32Array, k: number): void {
  for (let i = 0; i < NN; i++) {
    const f = 1 + m[i]! * k;
    t.r[i]! *= f;
    t.g[i]! *= f;
    t.b[i]! *= f;
  }
}
/** Multiply brightness by 1 + (field − 0.5)·k. */
function vary(t: Tile, f: Float32Array, k: number): void {
  for (let i = 0; i < NN; i++) {
    const m = 1 + (f[i]! - 0.5) * k;
    t.r[i]! *= m;
    t.g[i]! *= m;
    t.b[i]! *= m;
  }
}
function addh(t: Tile, m: Float32Array, k: number): void {
  for (let i = 0; i < NN; i++) t.h[i]! += m[i]! * k;
}
function mixr(t: Tile, m: Float32Array, v: number, k = 1): void {
  for (let i = 0; i < NN; i++) t.ro[i]! += (v - t.ro[i]!) * Math.min(1, m[i]! * k);
}
/** Bakes a little top-left light from the relief into the colour (helps where bump mapping is too subtle). */
function emboss(t: Tile, k: number): void {
  const h = t.h;
  for (let y = 0; y < N; y++) {
    const yu = wrap(y - 1) * N;
    const yd = wrap(y + 1) * N;
    const row = y * N;
    for (let x = 0; x < N; x++) {
      const d = (h[yd + x]! - h[yu + x]!) * 0.8 + (h[row + wrap(x + 1)]! - h[row + wrap(x - 1)]!) * 0.4;
      let f = 1 + d * k;
      if (f < 0.55) f = 0.55;
      else if (f > 1.5) f = 1.5;
      const i = row + x;
      t.r[i]! *= f;
      t.g[i]! *= f;
      t.b[i]! *= f;
    }
  }
}
function grain(t: Tile, seed: number, amp: number): void {
  for (let i = 0; i < NN; i++) {
    const n = (hash2(i % N, (i / N) | 0, seed) - 0.5) * amp;
    t.r[i]! += n;
    t.g[i]! += n;
    t.b[i]! += n;
  }
}

interface Ctx {
  p: Painter;
  nA: Float32Array; // big soft blotches
  nB: Float32Array; // medium blotches
  nC: Float32Array; // fine grain
  nS: Float32Array; // horizontal streaks (brushed)
  nV: Float32Array; // vertical streaks (drips)
}

/** Polyline random walk (pre-generated so the 3×3 tiling draws identical copies). */
function walk(rnd: () => number, x: number, y: number, len: number, step: number, wobble: number, dir = rnd() * Math.PI * 2): number[] {
  const pts = [x, y];
  let a = dir;
  for (let l = 0; l < len; l += step) {
    a += (rnd() - 0.5) * wobble;
    x += Math.cos(a) * step;
    y += Math.sin(a) * step;
    pts.push(x, y);
  }
  return pts;
}
function strokePts(g: G2, pts: number[]): void {
  g.beginPath();
  g.moveTo(pts[0]!, pts[1]!);
  for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i]!, pts[i + 1]!);
  g.stroke();
}
function gridLines(g: G2, xs: readonly number[], ys: readonly number[], w: number): void {
  g.lineWidth = w;
  g.lineCap = 'butt';
  g.beginPath();
  for (const x of xs) {
    g.moveTo(x, -4);
    g.lineTo(x, N + 4);
  }
  for (const y of ys) {
    g.moveTo(-4, y);
    g.lineTo(N + 4, y);
  }
  g.stroke();
}
function dots(g: G2, list: readonly number[], r: number): void {
  g.beginPath();
  for (let i = 0; i < list.length; i += 2) {
    g.moveTo(list[i]! + r, list[i + 1]!);
    g.arc(list[i]!, list[i + 1]!, r, 0, Math.PI * 2);
  }
  g.fill();
}
/** Raised round heads (rivets / bolts): shadow, body, highlight. */
function rivets(t: Tile, c: Ctx, list: readonly number[], r: number, light: number, dark: number): void {
  const shadow = c.p.mask((g) => dots(g, list.map((v, i) => v + (i % 2 === 0 ? r * 0.35 : r * 0.45)), r * 1.25));
  const body = c.p.mask((g) => dots(g, list, r));
  const spec = c.p.mask((g) => dots(g, list.map((v) => v - r * 0.3), r * 0.42));
  mulc(t, shadow, -dark);
  mulc(t, body, light * 0.5 + dark * 0.6);
  mulc(t, spec, light);
  addh(t, body, 0.35);
}

// ───────────────────────────── layer painters ─────────────────────────────
function paintFloor(c: Ctx): Tile {
  const rnd = mulberry32(11);
  const t = newTile([0.47, 0.465, 0.45], 0.86);
  vary(t, c.nA, 0.3);
  vary(t, c.nB, 0.14);
  vary(t, c.nC, 0.1);
  // four 4 m slabs with slightly different pours
  const slab = c.p.mask((g) => {
    g.globalAlpha = 0.45;
    g.fillRect(0, 0, 256, 256);
    g.globalAlpha = 0.8;
    g.fillRect(256, 256, 256, 256);
    g.globalAlpha = 0.2;
    g.fillRect(256, 0, 256, 256);
  }, false);
  mulc(t, slab, -0.09);
  // damp, darker, smoother patches
  const damp = thresh(shifted(c.nB, 91, 37), 0.56, 0.78);
  mixc(t, damp, [0.36, 0.365, 0.37], 0.28);
  mixr(t, damp, 0.42, 0.9);
  // oil stains: glossy and dark
  const blobs: number[] = [];
  for (let i = 0; i < 3; i++) blobs.push(rnd() * N, rnd() * N, 16 + rnd() * 30, 0.5 + rnd() * 0.7, rnd() * 3.14);
  let oil = c.p.mask((g) => {
    for (let i = 0; i < blobs.length; i += 5) {
      g.save();
      g.translate(blobs[i]!, blobs[i + 1]!);
      g.rotate(blobs[i + 4]!);
      g.scale(1, blobs[i + 3]!);
      g.beginPath();
      g.arc(0, 0, blobs[i + 2]!, 0, 6.2832);
      g.fill();
      g.restore();
    }
  });
  oil = blur(oil, 9, 9);
  const oilEdge = shifted(c.nC, 13, 77);
  for (let i = 0; i < NN; i++) oil[i] = smooth(0.25, 0.75, oil[i]! * (0.35 + oilEdge[i]! * 1.2));
  mixc(t, oil, [0.2, 0.195, 0.19], 0.36);
  mixr(t, oil, 0.22, 1);
  // rusty water marks
  const rustW = thresh(shifted(c.nA, 200, 310), 0.7, 0.9);
  mixc(t, rustW, [0.46, 0.33, 0.23], 0.2);
  // tyre / drag marks
  const marks: number[][] = [];
  for (let i = 0; i < 3; i++) marks.push(walk(rnd, rnd() * N, rnd() * N, 560, 24, 0.12));
  const tyre = blur(
    c.p.mask((g) => {
      g.lineWidth = 9;
      g.globalAlpha = 0.55;
      for (const m of marks) strokePts(g, m);
    }),
    2,
    2,
  );
  mulc(t, tyre, -0.2);
  // expansion joints every 4 m
  const joints = c.p.mask((g) => gridLines(g, [0, 256], [0, 256], 3.2));
  const jointSoft = blur(joints, 3, 3);
  mulc(t, jointSoft, -0.1);
  mixc(t, joints, [0.13, 0.13, 0.13], 0.8);
  addh(t, joints, -0.45);
  mixr(t, joints, 0.95);
  // cracks
  const cracks: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const w = walk(rnd, rnd() * N, rnd() * N, 130 + rnd() * 260, 7, 0.95);
    cracks.push(w);
    if (rnd() < 0.7) {
      const k = (Math.floor((w.length / 2) * (0.3 + rnd() * 0.4)) | 0) * 2;
      cracks.push(walk(rnd, w[k]!, w[k + 1]!, 60 + rnd() * 90, 7, 1.1));
    }
  }
  const crack = c.p.mask((g) => {
    g.lineWidth = 1.2;
    for (const k of cracks) strokePts(g, k);
  });
  mulc(t, blur(crack, 2, 2), -0.22);
  mixc(t, crack, [0.12, 0.12, 0.12], 0.6);
  addh(t, crack, -0.35);
  // aggregate specks
  const sp: number[] = [];
  for (let i = 0; i < 2600; i++) sp.push(rnd() * N, rnd() * N);
  mulc(t, c.p.mask((g) => dots(g, sp.slice(0, 2600), 0.9)), 0.16);
  mulc(t, c.p.mask((g) => dots(g, sp.slice(2600), 1.1)), -0.2);
  grain(t, 5, 0.035);
  for (let i = 0; i < NN; i++) t.h[i]! += (c.nC[i]! - 0.5) * 0.14;
  emboss(t, 1.2);
  return t;
}

function paintWall(c: Ctx): Tile {
  const rnd = mulberry32(23);
  const t = newTile([0.565, 0.6, 0.585], 0.84);
  vary(t, c.nA, 0.2);
  vary(t, shifted(c.nB, 40, 170), 0.1);
  vary(t, c.nC, 0.07);
  // 4 m × 4 m precast panels, slight tone steps
  const tone = c.p.mask((g) => {
    g.globalAlpha = 0.5;
    g.fillRect(0, 0, 256, 256);
    g.globalAlpha = 0.9;
    g.fillRect(256, 0, 256, 256);
    g.globalAlpha = 0.25;
    g.fillRect(0, 256, 256, 256);
  }, false);
  mulc(t, tone, -0.07);
  // flaked paint: bare, slightly warmer and darker concrete with a crisp edge
  const flake = thresh(shifted(c.nB, 300, 90), 0.72, 0.76);
  const flakeFine = shifted(c.nC, 5, 9);
  for (let i = 0; i < NN; i++) flake[i]! *= smooth(0.25, 0.5, flakeFine[i]! + c.nB[i]! * 0.5);
  mixc(t, flake, [0.5, 0.5, 0.475], 0.55);
  addh(t, flake, -0.12);
  // formwork lines every 2 m (faint) and panel seams every 4 m (strong)
  const faint = c.p.mask((g) => gridLines(g, [], [128, 384], 2));
  mulc(t, faint, -0.2);
  addh(t, faint, -0.15);
  const seams = c.p.mask((g) => gridLines(g, [0, 256], [0, 256], 3.4));
  // tie holes: 4 per panel
  const holes: number[] = [];
  for (const px of [0, 256]) for (const py of [0, 256]) for (const ox of [56, 200]) for (const oy of [64, 192]) holes.push(px + ox, py + oy);
  const hole = c.p.mask((g) => dots(g, holes, 3.4));
  // grime streaks running down from seams and holes
  const src = new Float32Array(NN);
  const sv = shifted(c.nV, 17, 0);
  for (let i = 0; i < NN; i++) src[i] = Math.max(hole[i]! * 0.9, seams[i]! * smooth(0.45, 0.8, sv[i]!) * 0.8);
  const streak = blur(drip(src, 46, 0.975), 1, 0, 1);
  mulc(t, streak, -0.34);
  // rust below some tie holes
  const rustSrc = new Float32Array(NN);
  for (let i = 0; i < NN; i++) rustSrc[i] = hole[i]! * (hash2(((i % N) / 128) | 0, (i / N / 128) | 0, 7) > 0.45 ? 1 : 0);
  mixc(t, blur(drip(rustSrc, 30, 0.965), 1, 0, 1), [0.5, 0.31, 0.19], 0.55);
  // broad water stains from the top of each panel row
  const water = thresh(shifted(c.nV, 211, 0), 0.6, 0.9);
  for (let i = 0; i < NN; i++) water[i]! *= 0.35 + 0.65 * c.nA[i]!;
  mulc(t, water, -0.12);
  mulc(t, blur(seams, 4, 4), -0.22);
  mixc(t, seams, [0.13, 0.14, 0.14], 0.9);
  addh(t, seams, -0.5);
  mixc(t, hole, [0.1, 0.1, 0.1], 0.9);
  addh(t, hole, -0.4);
  // scuffs and chips
  const chips: number[] = [];
  for (let i = 0; i < 500; i++) chips.push(rnd() * N, rnd() * N);
  mulc(t, c.p.mask((g) => dots(g, chips, 1.1)), -0.22);
  grain(t, 9, 0.03);
  for (let i = 0; i < NN; i++) t.h[i]! += (c.nC[i]! - 0.5) * 0.1;
  emboss(t, 1.1);
  return t;
}

function paintRoof(c: Ctx): Tile {
  const rnd = mulberry32(31);
  const t = newTile([0.36, 0.4, 0.44], 0.58);
  vary(t, c.nA, 0.22);
  vary(t, c.nC, 0.06);
  // corrugation: 0.25 m pitch along u
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const s = Math.sin((x / 16) * Math.PI * 2);
      const i = y * N + x;
      const f = 0.84 + 0.2 * s;
      t.r[i]! *= f;
      t.g[i]! *= f;
      t.b[i]! *= f;
      t.h[i] = 0.5 + 0.42 * s;
    }
  }
  // sheet overlaps every 2 m with fixing screws
  const lap = c.p.mask((g) => gridLines(g, [], [0, 128, 256, 384], 2.6));
  mulc(t, blur(lap, 0, 3), -0.3);
  mulc(t, lap, -0.5);
  const screws: number[] = [];
  for (const y of [6, 134, 262, 390]) for (let x = 8; x < N; x += 32) screws.push(x, y);
  mulc(t, c.p.mask((g) => dots(g, screws, 2)), 0.55);
  // rust blooms and dark leaks
  const rust = thresh(shifted(c.nB, 77, 190), 0.64, 0.84);
  const fine = shifted(c.nC, 31, 3);
  for (let i = 0; i < NN; i++) rust[i]! *= 0.45 + 0.75 * fine[i]!;
  mixc(t, rust, [0.4, 0.25, 0.17], 0.55);
  mixr(t, rust, 0.92);
  const leak = thresh(shifted(c.nA, 150, 20), 0.68, 0.9);
  mulc(t, leak, -0.35);
  const pits: number[] = [];
  for (let i = 0; i < 700; i++) pits.push(rnd() * N, rnd() * N);
  mulc(t, c.p.mask((g) => dots(g, pits, 1)), -0.25);
  grain(t, 3, 0.025);
  return t;
}

function paintConcrete(c: Ctx): Tile {
  const rnd = mulberry32(47);
  const t = newTile([0.6, 0.585, 0.55], 0.88);
  vary(t, shifted(c.nA, 60, 60), 0.24);
  vary(t, shifted(c.nB, 10, 200), 0.14);
  vary(t, c.nC, 0.09);
  // board-formed: 0.19 m boards (16 px) with individual tones and staggered butt joints
  const tone = new Float32Array(NN);
  const lines: number[] = [];
  const butt: number[] = [];
  for (let b = 0; b < 32; b++) {
    const y0 = b * 16;
    const v = rnd();
    for (let y = y0; y < y0 + 16; y++) for (let x = 0; x < N; x++) tone[y * N + x] = v;
    lines.push(y0);
    for (let k = 0; k < 2; k++) butt.push(rnd() * N, y0);
  }
  vary(t, tone, 0.09);
  const board = c.p.mask((g) => {
    gridLines(g, [], lines, 1.2);
    g.lineWidth = 1.2;
    g.beginPath();
    for (let i = 0; i < butt.length; i += 2) {
      g.moveTo(butt[i]!, butt[i + 1]!);
      g.lineTo(butt[i]!, butt[i + 1]! + 16);
    }
    g.stroke();
  });
  mulc(t, board, -0.16);
  addh(t, board, -0.2);
  // pour seams every 3 m
  const pour = c.p.mask((g) => gridLines(g, [0], [0, 256], 3));
  mulc(t, blur(pour, 3, 3), -0.18);
  mulc(t, pour, -0.45);
  addh(t, pour, -0.4);
  // bug holes
  const holes: number[] = [];
  for (let i = 0; i < 900; i++) holes.push(rnd() * N, rnd() * N);
  const bug = c.p.mask((g) => dots(g, holes, 1.1));
  mulc(t, bug, -0.26);
  addh(t, bug, -0.08);
  // stains from the top, chipped arrises
  const sv = shifted(c.nV, 99, 0);
  const src = new Float32Array(NN);
  for (let i = 0; i < NN; i++) src[i] = pour[i]! * smooth(0.5, 0.85, sv[i]!);
  mulc(t, blur(drip(src, 60, 0.98), 1, 0, 1), -0.3);
  const chip = thresh(shifted(c.nB, 222, 111), 0.74, 0.8);
  mixc(t, chip, [0.68, 0.66, 0.62], 0.6);
  const rustS = thresh(shifted(c.nA, 5, 400), 0.76, 0.92);
  mixc(t, rustS, [0.5, 0.33, 0.21], 0.4);
  grain(t, 13, 0.035);
  for (let i = 0; i < NN; i++) t.h[i]! += (c.nC[i]! - 0.5) * 0.14;
  emboss(t, 1.2);
  return t;
}

function paintMetal(c: Ctx): Tile {
  const rnd = mulberry32(59);
  const t = newTile([0.42, 0.455, 0.49], 0.5);
  vary(t, c.nA, 0.16);
  vary(t, c.nS, 0.16);
  vary(t, c.nC, 0.05);
  // 2 m plates with individual tone
  const tone = c.p.mask((g) => {
    g.globalAlpha = 0.6;
    g.fillRect(0, 0, 256, 256);
    g.globalAlpha = 1;
    g.fillRect(256, 256, 256, 256);
    g.globalAlpha = 0.3;
    g.fillRect(0, 256, 256, 256);
  }, false);
  mulc(t, tone, -0.1);
  // scratches
  const sc: number[] = [];
  for (let i = 0; i < 70; i++) {
    const x = rnd() * N;
    const y = rnd() * N;
    const a = rnd() * Math.PI;
    const l = 14 + rnd() * 70;
    sc.push(x, y, x + Math.cos(a) * l, y + Math.sin(a) * l);
  }
  const scr = c.p.mask((g) => {
    g.lineWidth = 1;
    g.beginPath();
    for (let i = 0; i < sc.length; i += 4) {
      g.moveTo(sc[i]!, sc[i + 1]!);
      g.lineTo(sc[i + 2]!, sc[i + 3]!);
    }
    g.stroke();
  });
  mulc(t, scr, 0.28);
  mixr(t, scr, 0.3);
  // seams, grime along seams
  const seams = c.p.mask((g) => gridLines(g, [0, 256], [0, 256], 3));
  mulc(t, blur(seams, 7, 7), -0.42);
  const hi = c.p.mask((g) => gridLines(g, [3, 259], [3, 259], 1.2));
  mulc(t, hi, 0.22);
  mixc(t, seams, [0.1, 0.11, 0.12], 0.92);
  addh(t, seams, -0.45);
  // rivets along the plate edges, 0.25 m apart
  const rv: number[] = [];
  for (const bx of [0, 256]) {
    for (const by of [0, 256]) {
      for (let k = 16; k < 256; k += 32) rv.push(bx + 13, by + k, bx + 243, by + k, bx + k, by + 13, bx + k, by + 243);
    }
  }
  // rust weeping from some rivets
  const rs: number[] = [];
  for (let i = 0; i < rv.length; i += 2) if (rnd() < 0.2) rs.push(rv[i]!, rv[i + 1]!);
  const weep = blur(drip(c.p.mask((g) => dots(g, rs, 3)), 26, 0.96), 1, 0, 1);
  mixc(t, weep, [0.45, 0.27, 0.16], 0.6);
  mixr(t, weep, 0.9);
  const patch = thresh(shifted(c.nB, 140, 60), 0.72, 0.86);
  mixc(t, patch, [0.4, 0.26, 0.17], 0.5);
  mixr(t, patch, 0.9);
  rivets(t, c, rv, 3.4, 0.45, 0.45);
  grain(t, 17, 0.02);
  emboss(t, 1.0);
  return t;
}

function paintRust(c: Ctx): Tile {
  const rnd = mulberry32(67);
  const t = newTile([0.3, 0.19, 0.14], 0.93);
  const a = shifted(c.nB, 300, 20);
  const fine = shifted(c.nC, 70, 70);
  for (let i = 0; i < NN; i++) {
    const k = smooth(0.25, 0.8, a[i]! * 0.7 + fine[i]! * 0.3);
    t.r[i] = 0.25 + k * 0.33;
    t.g[i] = 0.165 + k * 0.15;
    t.b[i] = 0.13 + k * 0.05;
  }
  // bright orange bloom
  const bloom = thresh(shifted(c.nA, 20, 120), 0.58, 0.85);
  for (let i = 0; i < NN; i++) bloom[i]! *= 0.4 + fine[i]! * 0.8;
  mixc(t, bloom, [0.68, 0.38, 0.17], 0.6);
  // remnants of old grey-green paint with a crisp, flaky edge
  const paint = thresh(shifted(c.nA, 256, 256), 0.66, 0.7);
  const fl = shifted(c.nC, 3, 41);
  for (let i = 0; i < NN; i++) paint[i]! *= smooth(0.3, 0.42, fl[i]! * 0.6 + c.nB[i]! * 0.5);
  mixc(t, paint, [0.37, 0.43, 0.41], 0.88);
  addh(t, paint, 0.16);
  mixr(t, paint, 0.6);
  vary(t, c.nA, 0.22);
  // vertical weeping, pits, plate seams
  mulc(t, thresh(shifted(c.nV, 61, 0), 0.55, 0.9), -0.25);
  const pits: number[] = [];
  for (let i = 0; i < 1800; i++) pits.push(rnd() * N, rnd() * N);
  const pit = c.p.mask((g) => dots(g, pits, 1.3));
  mulc(t, pit, -0.38);
  addh(t, pit, -0.3);
  const seams = c.p.mask((g) => gridLines(g, [0, 256], [0, 256], 2.6));
  mulc(t, blur(seams, 4, 4), -0.3);
  mulc(t, seams, -0.6);
  addh(t, seams, -0.4);
  const rv: number[] = [];
  for (const base of [0, 256]) for (let k = 32; k < N; k += 64) rv.push(base + 12, k, k, base + 12);
  rivets(t, c, rv, 3.2, 0.3, 0.4);
  for (let i = 0; i < NN; i++) t.h[i]! += (fine[i]! - 0.5) * 0.3;
  grain(t, 21, 0.04);
  emboss(t, 1.3);
  return t;
}

function paintHazard(c: Ctx): Tile {
  const rnd = mulberry32(71);
  const t = newTile([0.86, 0.63, 0.08], 0.6);
  const black: RGB = [0.085, 0.085, 0.095];
  const stripe = new Float32Array(NN);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const s = (x + y) % 256; // 1 m period along u at 256 px/m
      // black for s in [64, 192)
      stripe[y * N + x] = smooth(62.5, 65.5, s) * (1 - smooth(190.5, 193.5, s));
    }
  }
  mixc(t, stripe, black, 1);
  vary(t, c.nA, 0.22);
  vary(t, c.nC, 0.08);
  // chipped paint: bare dark steel on yellow, grey scuffs on black
  const chip = thresh(shifted(c.nC, 9, 200), 0.6, 0.66);
  const big = shifted(c.nB, 120, 300);
  for (let i = 0; i < NN; i++) chip[i]! *= smooth(0.55, 0.72, big[i]!);
  for (let i = 0; i < NN; i++) {
    const a = chip[i]!;
    if (a <= 0) continue;
    const k = stripe[i]!;
    const tr = 0.23 + k * 0.1;
    t.r[i]! += (tr - t.r[i]!) * a * 0.9;
    t.g[i]! += (tr - t.g[i]!) * a * 0.9;
    t.b[i]! += (tr + 0.01 - t.b[i]!) * a * 0.9;
  }
  addh(t, chip, -0.2);
  mixr(t, chip, 0.8);
  const sc: number[][] = [];
  for (let i = 0; i < 26; i++) sc.push(walk(rnd, rnd() * N, rnd() * N, 30 + rnd() * 110, 12, 0.3));
  const scr = c.p.mask((g) => {
    g.lineWidth = 1.4;
    for (const s of sc) strokePts(g, s);
  });
  mulc(t, scr, -0.3);
  mulc(t, thresh(shifted(c.nA, 77, 7), 0.55, 0.9), -0.28); // dirt
  grain(t, 27, 0.03);
  return t;
}

function paintCatwalk(c: Ctx): Tile {
  const t = newTile([0.47, 0.5, 0.54], 0.56);
  vary(t, c.nA, 0.2);
  vary(t, c.nC, 0.06);
  // dirt and rust in the valleys
  const dirt = thresh(shifted(c.nB, 180, 40), 0.45, 0.8);
  mixc(t, dirt, [0.3, 0.24, 0.2], 0.45);
  mixr(t, dirt, 0.85);
  // raised lozenges, alternating orientation, 0.125 m pitch
  const loz = c.p.mask((g) => {
    for (let j = 0; j < 16; j++) {
      for (let i = 0; i < 16; i++) {
        g.save();
        g.translate(i * 32 + 16, j * 32 + 16);
        g.rotate(((i + j) & 1) === 0 ? Math.PI / 4 : -Math.PI / 4);
        g.beginPath();
        g.ellipse(0, 0, 12.5, 4, 0, 0, 6.2832);
        g.fill();
        g.restore();
      }
    }
  }, false);
  const soft = blur(loz, 1, 1, 1);
  t.h.fill(0.3);
  addh(t, soft, 0.55);
  // worn, shiny tops
  const wear = thresh(shifted(c.nA, 90, 200), 0.35, 0.75);
  for (let i = 0; i < NN; i++) {
    const a = loz[i]!;
    if (a <= 0) continue;
    const f = 1 + a * (0.16 + wear[i]! * 0.3);
    t.r[i]! *= f;
    t.g[i]! *= f;
    t.b[i]! *= f;
    t.ro[i]! += (0.3 - t.ro[i]!) * a * (0.3 + wear[i]! * 0.6);
  }
  // plate seams every metre and corner bolts
  const seams = c.p.mask((g) => gridLines(g, [0, 256], [0, 256], 3.5));
  mulc(t, blur(seams, 5, 5), -0.3);
  mixc(t, seams, [0.08, 0.085, 0.09], 0.92);
  addh(t, seams, -0.3);
  const bolts: number[] = [];
  for (const x of [14, 242, 270, 498]) for (const y of [14, 242, 270, 498]) bolts.push(x, y);
  rivets(t, c, bolts, 5, 0.5, 0.5);
  grain(t, 33, 0.02);
  emboss(t, 1.5);
  return t;
}

function paintMachine(c: Ctx): Tile {
  const rnd = mulberry32(83);
  const t = newTile([0.64, 0.65, 0.635], 0.52);
  vary(t, c.nA, 0.14);
  vary(t, c.nC, 0.05);
  const P = 256;
  // ── top-left: louvred vent ──
  const ventBox = c.p.mask((g) => g.fillRect(26, 26, P - 52, P - 52), false);
  mulc(t, ventBox, -0.2);
  addh(t, ventBox, -0.12);
  const slots = c.p.mask((g) => {
    for (let y = 40; y < P - 46; y += 17) g.fillRect(38, y, P - 76, 8);
  }, false);
  mixc(t, slots, [0.07, 0.075, 0.08], 0.95);
  addh(t, slots, -0.3);
  const lips = c.p.mask((g) => {
    for (let y = 40; y < P - 46; y += 17) g.fillRect(38, y + 8.5, P - 76, 2.5);
  }, false);
  mulc(t, lips, 0.5);
  // ── top-right: access hatch with a warning plate ──
  const hatch = c.p.mask((g) => {
    g.lineWidth = 3;
    g.beginPath();
    g.roundRect(P + 24, 22, P - 48, P - 44, 14);
    g.stroke();
  }, false);
  mulc(t, hatch, -0.6);
  addh(t, hatch, -0.35);
  const hardware = c.p.mask((g) => {
    g.fillRect(P + 16, 54, 16, 30); // hinges
    g.fillRect(P + 16, 172, 16, 30);
    g.beginPath();
    g.roundRect(P + 196, 110, 14, 44, 5); // handle
    g.fill();
  }, false);
  mixc(t, hardware, [0.16, 0.17, 0.18], 0.95);
  addh(t, hardware, 0.3);
  const tri = c.p.mask((g) => {
    g.beginPath();
    g.moveTo(P + 92, 70);
    g.lineTo(P + 126, 128);
    g.lineTo(P + 58, 128);
    g.closePath();
    g.fill();
  }, false);
  mixc(t, tri, [0.88, 0.66, 0.08], 0.95);
  const triInk = c.p.mask((g) => {
    g.lineWidth = 3;
    g.lineJoin = 'miter';
    g.beginPath();
    g.moveTo(P + 92, 70);
    g.lineTo(P + 126, 128);
    g.lineTo(P + 58, 128);
    g.closePath();
    g.stroke();
    g.beginPath(); // abstract bolt glyph
    g.moveTo(P + 96, 88);
    g.lineTo(P + 84, 108);
    g.lineTo(P + 93, 108);
    g.lineTo(P + 88, 122);
    g.lineTo(P + 101, 102);
    g.lineTo(P + 92, 102);
    g.closePath();
    g.fill();
    for (let k = 0; k < 4; k++) g.fillRect(P + 140, 80 + k * 13, 34 - (k % 2) * 10, 5); // pseudo text lines
  }, false);
  mixc(t, triInk, [0.07, 0.07, 0.08], 0.92);
  // ── bottom-left: instrument panel ──
  const inst = c.p.mask((g) => {
    g.beginPath();
    g.roundRect(30, P + 40, P - 60, 120, 8);
    g.fill();
  }, false);
  mixc(t, inst, [0.13, 0.14, 0.15], 0.95);
  addh(t, inst, -0.25);
  const dials = c.p.mask((g) => {
    for (let k = 0; k < 3; k++) {
      g.beginPath();
      g.arc(72 + k * 56, P + 84, 20, 0, 6.2832);
      g.fill();
    }
  }, false);
  mixc(t, dials, [0.78, 0.78, 0.74], 0.9);
  const needles = c.p.mask((g) => {
    g.lineWidth = 2.5;
    const ang = [-2.2, -0.9, -1.6];
    for (let k = 0; k < 3; k++) {
      g.beginPath();
      g.arc(72 + k * 56, P + 84, 20, 0, 6.2832);
      g.stroke();
      g.beginPath();
      g.moveTo(72 + k * 56, P + 84);
      g.lineTo(72 + k * 56 + Math.cos(ang[k]!) * 15, P + 84 + Math.sin(ang[k]!) * 15);
      g.stroke();
    }
  }, false);
  mixc(t, needles, [0.08, 0.08, 0.09], 0.95);
  const leds: Array<[number, RGB]> = [
    [0, [0.62, 0.14, 0.1]],
    [1, [0.75, 0.5, 0.1]],
    [2, [0.2, 0.52, 0.28]],
    [3, [0.62, 0.14, 0.1]],
    [4, [0.3, 0.32, 0.34]],
    [5, [0.2, 0.52, 0.28]],
  ];
  for (const [k, col] of leds) {
    mixc(t, c.p.mask((g) => g.fillRect(48 + k * 28, P + 122, 16, 16), false), col, 0.95);
  }
  const plate = c.p.mask((g) => g.fillRect(40, P + 180, 100, 36), false);
  mixc(t, plate, [0.8, 0.8, 0.76], 0.9);
  mixc(t, c.p.mask((g) => {
    for (let k = 0; k < 3; k++) g.fillRect(48, P + 187 + k * 9, 84 - k * 22, 4);
  }, false), [0.1, 0.1, 0.11], 0.9);
  // ── bottom-right: flange port and a striped kick plate ──
  const ring = c.p.mask((g) => {
    g.lineWidth = 16;
    g.beginPath();
    g.arc(P + 128, P + 104, 56, 0, 6.2832);
    g.stroke();
  }, false);
  mulc(t, ring, -0.24);
  addh(t, ring, 0.3);
  const port = c.p.mask((g) => {
    g.beginPath();
    g.arc(P + 128, P + 104, 47, 0, 6.2832);
    g.fill();
  }, false);
  mixc(t, port, [0.1, 0.105, 0.11], 0.95);
  addh(t, port, -0.3);
  const fb: number[] = [];
  for (let k = 0; k < 8; k++) fb.push(P + 128 + Math.cos((k / 8) * 6.2832) * 56, P + 104 + Math.sin((k / 8) * 6.2832) * 56);
  rivets(t, c, fb, 4, 0.5, 0.5);
  const kick = c.p.mask((g) => g.fillRect(P + 20, P + 206, P - 40, 26), false);
  mixc(t, kick, [0.8, 0.79, 0.75], 0.95);
  const kickStripe = new Float32Array(NN);
  for (let i = 0; i < NN; i++) kickStripe[i] = kick[i]! * (((i % N) + ((i / N) | 0)) % 32 < 16 ? 1 : 0);
  mixc(t, kickStripe, [0.66, 0.17, 0.12], 0.95);
  // panel seams + corner bolts
  const seams = c.p.mask((g) => gridLines(g, [0, 256], [0, 256], 3.2));
  mulc(t, blur(seams, 5, 5), -0.3);
  mixc(t, seams, [0.1, 0.105, 0.11], 0.92);
  addh(t, seams, -0.45);
  const bolts: number[] = [];
  for (const x of [12, 244, 268, 500]) for (const y of [12, 244, 268, 500]) bolts.push(x, y);
  rivets(t, c, bolts, 4.2, 0.4, 0.5);
  // wear: grime weeping from the vent, the hatch and the instruments, chipped edges, scratches
  const src = new Float32Array(NN);
  const sv = shifted(c.nV, 143, 0);
  for (let i = 0; i < NN; i++) src[i] = Math.max(slots[i]!, inst[i]! * 0.7, hatch[i]! * 0.6, port[i]!) * smooth(0.4, 0.8, sv[i]!);
  const weep = blur(drip(src, 60, 0.98), 1, 0, 1);
  for (let i = 0; i < NN; i++) weep[i]! *= 1 - Math.max(slots[i]!, inst[i]!, port[i]!);
  mulc(t, weep, -0.42);
  const chip = thresh(shifted(c.nC, 51, 17), 0.66, 0.7);
  const big = shifted(c.nB, 30, 90);
  for (let i = 0; i < NN; i++) chip[i]! *= smooth(0.5, 0.66, big[i]!);
  mixc(t, chip, [0.36, 0.3, 0.26], 0.8);
  mixr(t, chip, 0.85);
  const sc: number[][] = [];
  for (let i = 0; i < 18; i++) sc.push(walk(rnd, rnd() * N, rnd() * N, 20 + rnd() * 80, 10, 0.25));
  mulc(t, c.p.mask((g) => {
    g.lineWidth = 1.2;
    for (const s of sc) strokePts(g, s);
  }), -0.22);
  grain(t, 39, 0.02);
  emboss(t, 1.1);
  return t;
}

function paintContainer(c: Ctx): Tile {
  const rnd = mulberry32(97);
  const t = newTile([0.74, 0.74, 0.72], 0.55);
  vary(t, c.nA, 0.14);
  vary(t, c.nC, 0.05);
  // trapezoidal corrugation, 0.25 m pitch
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const p = x % 32;
      let s: number;
      let h: number;
      if (p < 11) {
        s = 1.0;
        h = 0.85;
      } else if (p < 16) {
        s = 0.66;
        h = 0.85 - ((p - 11) / 5) * 0.7;
      } else if (p < 27) {
        s = 0.84;
        h = 0.15;
      } else {
        s = 1.12;
        h = 0.15 + ((p - 27) / 5) * 0.7;
      }
      const i = y * N + x;
      t.r[i]! *= s;
      t.g[i]! *= s;
      t.b[i]! *= s;
      t.h[i] = h;
    }
  }
  // horizontal weld seam, stencil code blocks
  const weld = c.p.mask((g) => gridLines(g, [], [0], 3));
  mulc(t, weld, -0.4);
  const code = c.p.mask((g) => {
    for (let k = 0; k < 6; k++) g.fillRect(300 + k * 22, 96, k === 3 ? 6 : 15, 26);
    for (let k = 0; k < 4; k++) g.fillRect(300 + k * 22, 132, 15, 10);
    g.fillRect(60, 380, 70, 9);
    g.fillRect(60, 396, 44, 9);
  }, false);
  for (let i = 0; i < NN; i++) code[i]! *= smooth(0.25, 0.5, c.nC[i]! + c.nB[i]! * 0.4);
  mixc(t, code, [0.95, 0.95, 0.93], 0.75);
  // rust patches bleeding downwards, dents, scratches
  const rust = thresh(shifted(c.nB, 60, 230), 0.72, 0.84);
  const fine = shifted(c.nC, 90, 14);
  for (let i = 0; i < NN; i++) rust[i]! *= 0.5 + fine[i]! * 0.7;
  const bleed = blur(drip(rust, 40, 0.972), 1, 0, 1);
  mixc(t, bleed, [0.5, 0.29, 0.17], 0.5);
  mixc(t, rust, [0.36, 0.2, 0.13], 0.8);
  mixr(t, rust, 0.92);
  const dents: number[] = [];
  for (let i = 0; i < 9; i++) dents.push(rnd() * N, rnd() * N, 12 + rnd() * 26);
  const dent = blur(
    c.p.mask((g) => {
      for (let i = 0; i < dents.length; i += 3) {
        g.beginPath();
        g.arc(dents[i]!, dents[i + 1]!, dents[i + 2]!, 0, 6.2832);
        g.fill();
      }
    }),
    6,
    6,
  );
  mulc(t, dent, -0.16);
  addh(t, dent, -0.2);
  const sc: number[][] = [];
  for (let i = 0; i < 22; i++) sc.push(walk(rnd, rnd() * N, rnd() * N, 30 + rnd() * 120, 12, 0.2, (rnd() - 0.5) * 0.6));
  mulc(t, c.p.mask((g) => {
    g.lineWidth = 1.3;
    for (const s of sc) strokePts(g, s);
  }), -0.25);
  mulc(t, thresh(shifted(c.nV, 7, 0), 0.6, 0.95), -0.18);
  grain(t, 43, 0.02);
  return t;
}

function paintPipe(c: Ctx): Tile {
  const rnd = mulberry32(101);
  const t = newTile([0.6, 0.6, 0.565], 0.6);
  vary(t, c.nA, 0.18);
  vary(t, c.nS, 0.1);
  vary(t, c.nC, 0.05);
  // painted identification ring (rust-orange), 0.25 m wide, once per 4 m
  const ringM = c.p.mask((g) => g.fillRect(112, -2, 32, N + 4), false);
  const worn = shifted(c.nC, 21, 60);
  for (let i = 0; i < NN; i++) ringM[i]! *= smooth(0.2, 0.42, worn[i]! * 0.7 + c.nB[i]! * 0.5);
  mixc(t, ringM, [0.74, 0.36, 0.11], 0.92);
  // cladding joints every 2 m with straps
  const strap = c.p.mask((g) => gridLines(g, [0, 256], [], 14));
  mulc(t, strap, 0.14);
  addh(t, strap, 0.25);
  const joint = c.p.mask((g) => gridLines(g, [0, 256], [], 2.4));
  mulc(t, joint, -0.6);
  addh(t, joint, -0.5);
  const edge = c.p.mask((g) => gridLines(g, [-8, 8, 248, 264], [], 1.6));
  mulc(t, edge, -0.35);
  // longitudinal seam with rivets
  const seam = c.p.mask((g) => gridLines(g, [], [0], 2.2));
  mulc(t, seam, -0.5);
  addh(t, seam, -0.35);
  const rv: number[] = [];
  for (let x = 16; x < N; x += 32) rv.push(x, 9);
  rivets(t, c, rv, 2.8, 0.4, 0.45);
  // stains, rust at the joints, dents
  const rust = thresh(shifted(c.nB, 250, 130), 0.68, 0.84);
  mixc(t, rust, [0.46, 0.28, 0.17], 0.6);
  mixr(t, rust, 0.9);
  const src = new Float32Array(NN);
  const sv = shifted(c.nV, 201, 0);
  for (let i = 0; i < NN; i++) src[i] = seam[i]! * smooth(0.5, 0.85, sv[i]!);
  mulc(t, blur(drip(src, 50, 0.975), 1, 0, 1), -0.3);
  mulc(t, thresh(shifted(c.nA, 130, 250), 0.6, 0.9), -0.22);
  const dents: number[] = [];
  for (let i = 0; i < 7; i++) dents.push(rnd() * N, rnd() * N, 10 + rnd() * 22);
  const dent = blur(
    c.p.mask((g) => {
      for (let i = 0; i < dents.length; i += 3) {
        g.beginPath();
        g.arc(dents[i]!, dents[i + 1]!, dents[i + 2]!, 0, 6.2832);
        g.fill();
      }
    }),
    5,
    5,
  );
  mulc(t, dent, -0.14);
  addh(t, dent, -0.2);
  grain(t, 49, 0.02);
  emboss(t, 0.9);
  return t;
}

function paintShutter(c: Ctx): Tile {
  const rnd = mulberry32(109);
  const t = newTile([0.71, 0.71, 0.7], 0.55);
  vary(t, c.nA, 0.14);
  vary(t, c.nS, 0.08);
  // horizontal slats, 0.25 m
  for (let y = 0; y < N; y++) {
    const p = y % 32;
    let s: number;
    let h: number;
    if (p < 3) {
      s = 1.16;
      h = 0.55 + p * 0.12;
    } else if (p < 27) {
      s = 1.02 - ((p - 3) / 24) * 0.2;
      h = 0.9 - ((p - 3) / 24) * 0.25;
    } else {
      s = 0.42;
      h = 0.1;
    }
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      t.r[i]! *= s;
      t.g[i]! *= s;
      t.b[i]! *= s;
      t.h[i] = h;
    }
  }
  // guide joints every 2 m with bolts
  const guide = c.p.mask((g) => gridLines(g, [0, 256], [], 6));
  mulc(t, guide, -0.5);
  addh(t, guide, -0.3);
  mulc(t, blur(guide, 5, 0), -0.2);
  const bolts: number[] = [];
  for (const x of [14, 242, 270, 498]) for (let y = 16; y < N; y += 64) bolts.push(x, y);
  rivets(t, c, bolts, 3.2, 0.4, 0.45);
  // grime running down, scratches, dents
  mulc(t, thresh(shifted(c.nV, 33, 0), 0.5, 0.92), -0.28);
  mulc(t, thresh(shifted(c.nB, 17, 17), 0.6, 0.85), -0.16);
  const sc: number[][] = [];
  for (let i = 0; i < 30; i++) sc.push(walk(rnd, rnd() * N, rnd() * N, 30 + rnd() * 140, 12, 0.2, rnd() < 0.6 ? (rnd() - 0.5) * 0.5 : rnd() * 6.28));
  mulc(t, c.p.mask((g) => {
    g.lineWidth = 1.3;
    for (const s of sc) strokePts(g, s);
  }), -0.28);
  const chip = thresh(shifted(c.nC, 77, 5), 0.68, 0.72);
  const big = shifted(c.nB, 200, 60);
  for (let i = 0; i < NN; i++) chip[i]! *= smooth(0.5, 0.7, big[i]!);
  mixc(t, chip, [0.33, 0.28, 0.25], 0.8);
  grain(t, 53, 0.02);
  return t;
}

function paintPaint(c: Ctx): Tile {
  const rnd = mulberry32(113);
  const t = newTile([0.9, 0.88, 0.82], 0.62);
  vary(t, c.nA, 0.16);
  vary(t, c.nC, 0.06);
  const chip = thresh(shifted(c.nC, 140, 9), 0.6, 0.65);
  const big = shifted(c.nB, 60, 60);
  for (let i = 0; i < NN; i++) chip[i]! *= smooth(0.56, 0.72, big[i]!);
  mixc(t, chip, [0.24, 0.24, 0.24], 0.9);
  addh(t, chip, -0.2);
  mixr(t, chip, 0.85);
  mulc(t, thresh(shifted(c.nA, 10, 300), 0.5, 0.9), -0.22);
  const sc: number[][] = [];
  for (let i = 0; i < 24; i++) sc.push(walk(rnd, rnd() * N, rnd() * N, 40 + rnd() * 120, 12, 0.3));
  mulc(t, c.p.mask((g) => {
    g.lineWidth = 1.5;
    for (const s of sc) strokePts(g, s);
  }), -0.3);
  grain(t, 57, 0.025);
  return t;
}

/** Utility layer: r = macro brightness variation, g = large stain mask, b = fine grain. Sampled at other scales. */
function paintNoise(c: Ctx): Tile {
  const t = newTile([0.5, 0.5, 0.5], 1);
  const stain = shifted(c.nB, 201, 77);
  const fine = fbm(64, 2, 991, 0.6);
  for (let i = 0; i < NN; i++) {
    t.r[i] = smooth(0.15, 0.85, c.nA[i]! * 0.7 + stain[i]! * 0.3);
    t.g[i] = smooth(0.42, 0.95, stain[i]! * 0.75 + c.nV[i]! * 0.25);
    t.b[i] = fine[i]! * 0.7 + hash2(i % N, (i / N) | 0, 5) * 0.3;
  }
  return t;
}

/**
 * Pipe rack: six pipes of different diameters lying on top of each other, running along u. Each pipe is a
 * shaded half-round (lit from above) with flanges every 2 m and, on some, a painted identification band.
 */
function paintPipes(c: Ctx): Tile {
  const t = newTile([0.5, 0.5, 0.5], 0.6);
  // [diameter px (128 px = 1 m), colour, flange offset px, identification band colour]
  const defs: Array<[number, RGB, number, RGB | null]> = [
    [112, [0.66, 0.65, 0.6], 0, null],
    [64, [0.36, 0.43, 0.48], 128, [0.86, 0.68, 0.14]],
    [96, [0.56, 0.36, 0.23], 64, null],
    [48, [0.3, 0.33, 0.36], 192, [0.74, 0.2, 0.14]],
    [80, [0.45, 0.53, 0.46], 0, null],
    [112, [0.6, 0.56, 0.48], 128, [0.24, 0.44, 0.66]],
  ];
  const worn = shifted(c.nC, 77, 140);
  let y = 0;
  for (const [d, col, fl, band] of defs) {
    for (let j = 0; j < d; j++) {
      const sy = ((j + 0.5) / d) * 2 - 1; // -1 = upper side of the pipe … +1 = underside
      const k = Math.sqrt(Math.max(0, 1 - sy * sy));
      const shade = 0.2 + 0.98 * k * (0.64 - 0.36 * sy);
      const row = (y + j) * N;
      for (let x = 0; x < N; x++) {
        const i = row + x;
        const fx = (x + N - fl) % 256;
        const flange = fx < 12;
        const fb = flange ? 1.2 : fx < 15 || fx > 253 ? 0.62 : 1;
        const bx = (x + N - fl - 56) % 512;
        const inBand = band !== null && bx < 28 && worn[i]! * 0.7 + c.nB[i]! * 0.5 > 0.36;
        const cc = inBand ? band : col;
        t.r[i] = cc[0] * shade * fb;
        t.g[i] = cc[1] * shade * fb;
        t.b[i] = cc[2] * shade * fb;
        t.h[i] = 0.08 + 0.8 * k + (flange ? 0.1 : 0);
        t.ro[i] = flange ? 0.42 : 0.6;
      }
    }
    y += d;
  }
  // bolts on the flanges
  const bolts: number[] = [];
  y = 0;
  for (const [d, , fl] of defs) {
    for (const f of [0.3, 0.7]) for (const x0 of [0, 256]) bolts.push((x0 + fl + 6) % N, y + d * f);
    y += d;
  }
  rivets(t, c, bolts, 2.6, 0.35, 0.4);
  // wear: tone variation, rust blooms, grime hanging below the flanges
  vary(t, c.nA, 0.2);
  vary(t, c.nS, 0.12);
  vary(t, c.nC, 0.06);
  const rust = thresh(shifted(c.nB, 91, 300), 0.62, 0.8);
  mixc(t, rust, [0.47, 0.28, 0.16], 0.55);
  mixr(t, rust, 0.92);
  mulc(t, thresh(shifted(c.nV, 77, 0), 0.55, 0.9), -0.18);
  grain(t, 61, 0.025);
  return t;
}

/**
 * Conveyor from above, travelling along u; one repeat spans the 4 m width: steel side rails, a row of roller
 * ends on each side and a dark ribbed belt between them.
 */
function paintBelt(c: Ctx): Tile {
  const rnd = mulberry32(131);
  const t = newTile([0.2, 0.2, 0.21], 0.78);
  for (let y = 0; y < N; y++) {
    // distance from the nearer side, in px (128 px = 1 m)
    const e = Math.min(y, N - 1 - y);
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      if (e < 30) {
        // side rail: steel channel with a lip
        const lip = e < 4 || e > 25 ? 0.7 : 1;
        t.r[i] = 0.4 * lip;
        t.g[i] = 0.43 * lip;
        t.b[i] = 0.46 * lip;
        t.h[i] = e < 4 || e > 25 ? 0.95 : 0.8;
        t.ro[i] = 0.5;
      } else if (e < 84) {
        // exposed rollers every 0.25 m: half-rounds across the travel direction
        const p = ((x % 32) + 0.5) / 32;
        const sx = p * 2 - 1;
        const k = Math.sqrt(Math.max(0, 1 - sx * sx));
        const sh = 0.16 + 0.62 * k * (0.75 - 0.25 * sx);
        t.r[i] = 0.62 * sh;
        t.g[i] = 0.64 * sh;
        t.b[i] = 0.66 * sh;
        t.h[i] = 0.2 + 0.6 * k;
        t.ro[i] = 0.38;
      } else {
        // belt: transverse cleats every 0.5 m, slightly raised edges
        const cleat = x % 64 < 6;
        const edge = e < 90;
        const v = cleat ? 1.55 : edge ? 1.3 : 1;
        t.r[i]! *= v;
        t.g[i]! *= v;
        t.b[i]! *= v;
        t.h[i] = cleat ? 0.72 : 0.55;
      }
    }
  }
  // scuffed centre, dust, spilled material, long scratches along the travel direction
  const centre = c.p.mask((g) => g.fillRect(-2, 150, N + 4, 212), false);
  const scuff = shifted(c.nS, 11, 200);
  for (let i = 0; i < NN; i++) centre[i]! *= smooth(0.35, 0.8, scuff[i]! * 0.6 + c.nA[i]! * 0.5);
  mixc(t, blur(centre, 2, 8), [0.3, 0.29, 0.27], 0.5);
  vary(t, c.nA, 0.22);
  vary(t, c.nC, 0.08);
  const sc: number[][] = [];
  for (let i = 0; i < 14; i++) sc.push(walk(rnd, rnd() * N, 100 + rnd() * 312, 80 + rnd() * 260, 14, 0.08, 0));
  mulc(t, c.p.mask((g) => {
    g.lineWidth = 1.6;
    for (const k of sc) strokePts(g, k);
  }), 0.5);
  const rust = thresh(shifted(c.nB, 40, 220), 0.7, 0.85);
  mixc(t, rust, [0.42, 0.26, 0.16], 0.4);
  grain(t, 67, 0.02);
  return t;
}

/**
 * Storage rack front (4 m × 4 m, starts at the floor): orange uprights every 2 m, beams every 1.33 m and the
 * goods left on the shelves — cartons, crates, drums, wrapped pallets, some bays empty.
 */
function paintShelves(c: Ctx): Tile {
  const rnd = mulberry32(139);
  const t = newTile([0.075, 0.08, 0.09], 0.9);
  for (let i = 0; i < NN; i++) t.h[i] = 0.15;
  const fill = (x0: number, y0: number, x1: number, y1: number, col: RGB, h: number, rough: number): void => {
    for (let y = Math.max(0, y0 | 0); y < Math.min(N, y1 | 0); y++) {
      for (let x = Math.max(0, x0 | 0); x < Math.min(N, x1 | 0); x++) {
        const i = y * N + x;
        // soft edge shading so boxes read as volumes
        const ex = Math.min(x - x0, x1 - 1 - x);
        const ey = Math.min(y - y0, y1 - 1 - y);
        const e = Math.min(ex, ey);
        const s = e < 1.5 ? 0.6 : e < 3 ? 0.85 : 1;
        t.r[i] = col[0] * s;
        t.g[i] = col[1] * s;
        t.b[i] = col[2] * s;
        t.h[i] = e < 1.5 ? h - 0.15 : h;
        t.ro[i] = rough;
      }
    }
  };
  // dull cartons, crates, drums and wrapped pallets — nothing red or bright (enemies must stay the only red things)
  const goods: RGB[] = [
    [0.5, 0.4, 0.27],
    [0.43, 0.34, 0.23],
    [0.55, 0.47, 0.34],
    [0.34, 0.38, 0.42],
    [0.2, 0.31, 0.42],
    [0.42, 0.4, 0.3],
    [0.5, 0.52, 0.54],
    [0.27, 0.36, 0.29],
  ];
  // three shelf levels (canvas y grows downwards: level 0 is the top third), two bays per level
  const LV = N / 3;
  for (let lv = 0; lv < 3; lv++) {
    const yTop = lv * LV + 14;
    const yBot = (lv + 1) * LV - 1;
    for (let bay = 0; bay < 2; bay++) {
      const bx0 = bay * 256 + 16;
      const bx1 = bay * 256 + 252;
      const kind = rnd();
      if (kind < 0.16) continue; // empty bay
      // pallet board
      fill(bx0 + 6, yBot - 9, bx1 - 6, yBot, [0.42, 0.33, 0.22], 0.5, 0.9);
      let x = bx0 + 8;
      while (x < bx1 - 30) {
        const w = 34 + Math.floor(rnd() * 56);
        const hgt = 50 + Math.floor(rnd() * (yBot - 9 - yTop - 56));
        const x1 = Math.min(bx1 - 8, x + w);
        if (rnd() < 0.12) {
          x = x1 + 4;
          continue;
        }
        const col = goods[Math.floor(rnd() * goods.length)]!;
        fill(x, yBot - 9 - hgt, x1, yBot - 9, col, 0.62 + rnd() * 0.2, 0.82);
        // tape / strap line
        if (rnd() < 0.7) fill(x + 2, yBot - 9 - hgt * 0.55, x1 - 2, yBot - 9 - hgt * 0.55 + 3, [col[0] * 0.6, col[1] * 0.6, col[2] * 0.6], 0.6, 0.8);
        if (rnd() < 0.35) fill(x + (x1 - x) * 0.3, yBot - 9 - hgt * 0.35, x + (x1 - x) * 0.3 + 12, yBot - 9 - hgt * 0.35 + 9, [0.85, 0.84, 0.8], 0.7, 0.7);
        x = x1 + 3 + Math.floor(rnd() * 5);
      }
    }
    // beam under each level
    fill(0, (lv + 1) * LV - 1, N, (lv + 1) * LV + 13, [0.6, 0.36, 0.13], 0.95, 0.55);
  }
  // the beam of the bottom level wraps to the top rows of the tile
  fill(0, 0, N, 13, [0.6, 0.36, 0.13], 0.95, 0.55);
  // uprights every 2 m
  for (const ux of [0, 256]) {
    fill(ux - 1, 0, ux + 15, N, [0.2, 0.3, 0.44], 1, 0.5);
    for (let y = 10; y < N; y += 21) fill(ux + 5, y, ux + 10, y + 7, [0.05, 0.06, 0.07], 0.7, 0.9);
  }
  vary(t, c.nA, 0.2);
  vary(t, c.nC, 0.08);
  const dust = thresh(shifted(c.nB, 310, 20), 0.55, 0.9);
  mixc(t, dust, [0.34, 0.33, 0.31], 0.22);
  const rust = thresh(shifted(c.nB, 120, 400), 0.7, 0.84);
  mixc(t, rust, [0.42, 0.25, 0.15], 0.4);
  grain(t, 71, 0.025);
  return t;
}

// ───────────────────────────── build / cache ─────────────────────────────
interface RawTextures {
  albedo: Uint8Array;
  height: Uint8Array;
  ms: number;
  layerMs: number[];
}

function buildRaw(): RawTextures {
  const t0 = performance.now();
  // streak fields: fbm that varies quickly across one axis and slowly along the other
  const nV = fbm(48, 3, 707, 0.55, 2); // vertical streaks (drips down walls)
  const nS = fbm(2, 3, 717, 0.55, 48); // horizontal streaks (brushed steel)
  const ctx: Ctx = {
    p: new Painter(),
    nA: fbm(4, 5, 101),
    nB: fbm(8, 5, 211),
    nC: fbm(32, 3, 307, 0.6),
    nS,
    nV,
  };
  const painters: Array<(c: Ctx) => Tile> = [
    paintFloor,
    paintWall,
    paintRoof,
    paintConcrete,
    paintMetal,
    paintRust,
    paintHazard,
    paintCatwalk,
    paintMachine,
    paintContainer,
    paintPipe,
    paintShutter,
    paintPaint,
    paintNoise,
    paintPipes,
    paintBelt,
    paintShelves,
  ];
  const albedo = new Uint8Array(NN * 4 * LAYER_COUNT);
  const HS = HEIGHT_SIZE;
  const height = new Uint8Array(HS * HS * LAYER_COUNT);
  const to8 = (v: number): number => (v <= 0 ? 0 : v >= 1 ? 255 : (v * 255 + 0.5) | 0);
  const layerMs: number[] = [performance.now() - t0];
  for (let l = 0; l < LAYER_COUNT; l++) {
    const tl = performance.now();
    const t = painters[l]!(ctx);
    const base = l * NN * 4;
    for (let y = 0; y < N; y++) {
      const dst = base + (N - 1 - y) * N * 4; // canvas up = +v
      const src = y * N;
      for (let x = 0; x < N; x++) {
        const o = dst + x * 4;
        const i = src + x;
        albedo[o] = to8(t.r[i]!);
        albedo[o + 1] = to8(t.g[i]!);
        albedo[o + 2] = to8(t.b[i]!);
        albedo[o + 3] = to8(t.ro[i]!);
      }
    }
    const hb = l * HS * HS;
    for (let y = 0; y < HS; y++) {
      for (let x = 0; x < HS; x++) {
        const i = y * 2 * N + x * 2;
        const v = (t.h[i]! + t.h[i + 1]! + t.h[i + N]! + t.h[i + N + 1]!) * 0.25;
        height[hb + (HS - 1 - y) * HS + x] = to8(v);
      }
    }
    layerMs.push(performance.now() - tl);
  }
  return { albedo, height, ms: performance.now() - t0, layerMs };
}

let raw: RawTextures | null = null;
let shared: StageTextures | null = null;
let refs = 0;

/** Raw pixel data (for the dev harness preview); generated on first use and kept. */
export function getStageTextureData(): { albedo: Uint8Array; height: Uint8Array; size: number; heightSize: number; layers: number; ms: number; layerMs: number[] } {
  if (!raw) raw = buildRaw();
  return { albedo: raw.albedo, height: raw.height, size: N, heightSize: HEIGHT_SIZE, layers: LAYER_COUNT, ms: raw.ms, layerMs: raw.layerMs };
}

/** GPU bytes of the two arrays and the noise copy including mip chains. */
export function getStageTextureBytes(): number {
  return Math.round((NN * 4 * LAYER_COUNT + HEIGHT_SIZE * HEIGHT_SIZE * LAYER_COUNT + NN * 4) * (4 / 3));
}

/** Shared, reference-counted stage texture arrays. Pair every call with releaseStageTextures(). */
export function acquireStageTextures(maxAnisotropy = STAGE_ANISOTROPY): StageTextures {
  refs++;
  if (shared) return shared;
  const d = getStageTextureData();
  const albedo = new THREE.DataArrayTexture(d.albedo, N, N, LAYER_COUNT);
  albedo.format = THREE.RGBAFormat;
  albedo.type = THREE.UnsignedByteType;
  albedo.colorSpace = THREE.SRGBColorSpace;
  albedo.wrapS = albedo.wrapT = THREE.RepeatWrapping;
  albedo.minFilter = THREE.LinearMipmapLinearFilter;
  albedo.magFilter = THREE.LinearFilter;
  albedo.generateMipmaps = true;
  albedo.anisotropy = Math.max(1, Math.min(STAGE_ANISOTROPY, maxAnisotropy));
  albedo.needsUpdate = true;
  const height = new THREE.DataArrayTexture(d.height, HEIGHT_SIZE, HEIGHT_SIZE, LAYER_COUNT);
  height.format = THREE.RedFormat;
  height.type = THREE.UnsignedByteType;
  height.colorSpace = THREE.NoColorSpace;
  height.wrapS = height.wrapT = THREE.RepeatWrapping;
  height.minFilter = THREE.LinearMipmapLinearFilter;
  height.magFilter = THREE.LinearFilter;
  height.generateMipmaps = true;
  height.unpackAlignment = 1;
  height.needsUpdate = true;
  // the noise layer once more, as its own texture: identical texels and filtering except for the anisotropy
  const noise = new THREE.DataTexture(d.albedo.subarray(LAYER.noise * NN * 4, (LAYER.noise + 1) * NN * 4), N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  noise.colorSpace = THREE.SRGBColorSpace;
  noise.wrapS = noise.wrapT = THREE.RepeatWrapping;
  noise.minFilter = THREE.LinearMipmapLinearFilter;
  noise.magFilter = THREE.LinearFilter;
  noise.generateMipmaps = true;
  noise.anisotropy = 1;
  noise.needsUpdate = true;
  shared = { albedo, height, noise };
  return shared;
}

export function releaseStageTextures(): void {
  if (refs <= 0) return;
  refs--;
  if (refs === 0 && shared) {
    shared.albedo.dispose();
    shared.height.dispose();
    shared.noise.dispose();
    shared = null;
  }
}
