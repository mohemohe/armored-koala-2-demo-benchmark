/**
 * Procedural (code-generated) textures and the shared material library. No external assets.
 * In Node (no `document`) textures fall back to a tiny solid DataTexture so geometry / material creation stays testable.
 */
import {
  AdditiveBlending,
  CanvasTexture,
  Color,
  DataTexture,
  DoubleSide,
  MeshStandardMaterial,
  NoColorSpace,
  RepeatWrapping,
  SRGBColorSpace,
  LinearFilter,
  LinearMipmapLinearFilter,
  ClampToEdgeWrapping,
  RGBAFormat,
  UnsignedByteType,
  Texture,
} from 'three';
import type { MaterialKey } from '../sim/types';
import { mulberry32 } from './geo';

type G = CanvasRenderingContext2D;
type Rnd = () => number;

export const hasCanvas = (): boolean => typeof document !== 'undefined' && typeof document.createElement === 'function';

function rgba(r: number, g: number, b: number, a = 1): string {
  return `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${a})`;
}

/** run `fn` at every wrapped offset so features near the border tile seamlessly */
function wrapAt(size: number, x: number, y: number, r: number, fn: (x: number, y: number) => void): void {
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const px = x + dx * size;
      const py = y + dy * size;
      if (px + r < 0 || px - r > size || py + r < 0 || py - r > size) continue;
      fn(px, py);
    }
  }
}

function blotch(g: G, s: number, x: number, y: number, r: number, col: [number, number, number], a: number): void {
  wrapAt(s, x, y, r, (px, py) => {
    const gr = g.createRadialGradient(px, py, 0, px, py, r);
    gr.addColorStop(0, rgba(col[0], col[1], col[2], a));
    gr.addColorStop(1, rgba(col[0], col[1], col[2], 0));
    g.fillStyle = gr;
    g.fillRect(px - r, py - r, r * 2, r * 2);
  });
}

function speckle(g: G, s: number, rnd: Rnd, count: number, dark: number, light: number): void {
  for (let i = 0; i < count; i++) {
    const x = Math.floor(rnd() * s);
    const y = Math.floor(rnd() * s);
    const v = rnd();
    if (v < 0.5) g.fillStyle = rgba(0, 0, 0, dark * rnd());
    else g.fillStyle = rgba(255, 255, 255, light * rnd());
    const w = rnd() < 0.15 ? 2 : 1;
    g.fillRect(x, y, w, w);
  }
}

function streaks(g: G, s: number, rnd: Rnd, count: number, col: [number, number, number], a: number, minH: number, maxH: number): void {
  for (let i = 0; i < count; i++) {
    const x = rnd() * s;
    const w = 1 + rnd() * 7;
    const h = minH + rnd() * (maxH - minH);
    const y = rnd() * s;
    wrapAt(s, x, y + h / 2, Math.max(w, h / 2), (px, py) => {
      const gr = g.createLinearGradient(0, py - h / 2, 0, py + h / 2);
      gr.addColorStop(0, rgba(col[0], col[1], col[2], 0));
      gr.addColorStop(0.15, rgba(col[0], col[1], col[2], a * (0.4 + 0.6 * rnd())));
      gr.addColorStop(1, rgba(col[0], col[1], col[2], 0));
      g.fillStyle = gr;
      g.fillRect(px - w / 2, py - h / 2, w, h);
    });
  }
}

function crack(g: G, s: number, rnd: Rnd, alpha: number): void {
  let x = rnd() * s;
  let y = rnd() * s;
  let ang = rnd() * Math.PI * 2;
  g.strokeStyle = rgba(10, 10, 10, alpha);
  g.lineWidth = 1 + rnd();
  g.beginPath();
  g.moveTo(x, y);
  const n = 8 + Math.floor(rnd() * 14);
  for (let i = 0; i < n; i++) {
    ang += (rnd() - 0.5) * 1.1;
    x += Math.cos(ang) * (6 + rnd() * 14);
    y += Math.sin(ang) * (6 + rnd() * 14);
    g.lineTo(x, y);
  }
  g.stroke();
}

function rivet(g: G, x: number, y: number, r: number, base: string): void {
  g.fillStyle = 'rgba(0,0,0,0.5)';
  g.beginPath();
  g.arc(x + r * 0.25, y + r * 0.35, r, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = base;
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = 'rgba(255,255,255,0.35)';
  g.beginPath();
  g.arc(x - r * 0.3, y - r * 0.3, r * 0.4, 0, Math.PI * 2);
  g.fill();
}


/** soft elliptical blotch (sx / sy stretch the disc) */
function blotchE(g: G, s: number, x: number, y: number, r: number, col: [number, number, number], a: number, sx: number, sy: number): void {
  wrapAt(s, x, y, r * Math.max(sx, sy), (px, py) => {
    g.save();
    g.translate(px, py);
    g.scale(sx, sy);
    const gr = g.createRadialGradient(0, 0, 0, 0, 0, r);
    gr.addColorStop(0, rgba(col[0], col[1], col[2], a));
    gr.addColorStop(0.55, rgba(col[0], col[1], col[2], a * 0.5));
    gr.addColorStop(1, rgba(col[0], col[1], col[2], 0));
    g.fillStyle = gr;
    g.fillRect(-r, -r, r * 2, r * 2);
    g.restore();
  });
}

/**
 * irregular organic stain (water / oil / grime): overlapping soft ellipses, stretched vertically like a run-off mark,
 * with a fuzzy edge - never a round spot
 */
function stain(g: G, s: number, rnd: Rnd, x: number, y: number, r: number, col: [number, number, number], a: number): void {
  const n = 5 + Math.floor(rnd() * 3);
  const sx = 0.5 + 0.45 * rnd();
  const sy = 1.0 + 0.7 * rnd();
  for (let i = 0; i < n; i++) {
    const a0 = rnd() * Math.PI * 2;
    const d = r * 0.5 * rnd();
    blotchE(g, s, x + Math.cos(a0) * d * sx, y + Math.sin(a0) * d * sy, r * (0.4 + 0.55 * rnd()), col, a * (0.45 + 0.55 * rnd()), sx * (0.8 + 0.4 * rnd()), sy * (0.8 + 0.4 * rnd()));
  }
}

/** vertical rust / grime runs that start at a source (seam, rivet, pipe joint) and thin out downward */
function drips(g: G, s: number, rnd: Rnd, count: number, col: [number, number, number], a: number, minL: number, maxL: number, xs?: number[]): void {
  for (let i = 0; i < count; i++) {
    const x = xs ? xs[Math.floor(rnd() * xs.length)] + (rnd() - 0.5) * 10 : rnd() * s;
    const y0 = rnd() * s;
    const L = minL + rnd() * (maxL - minL);
    const w = 1 + rnd() * 3.2;
    wrapAt(s, x, y0 + L / 2, Math.max(w * 3, L / 2), (px, py) => {
      const gr = g.createLinearGradient(0, py - L / 2, 0, py + L / 2);
      gr.addColorStop(0, rgba(col[0], col[1], col[2], a));
      gr.addColorStop(0.6, rgba(col[0], col[1], col[2], a * 0.45));
      gr.addColorStop(1, rgba(col[0], col[1], col[2], 0));
      g.fillStyle = gr;
      g.fillRect(px - w / 2, py - L / 2, w, L);
      // the head where the water sat
      const hg = g.createRadialGradient(px, py - L / 2, 0, px, py - L / 2, w * 2.6);
      hg.addColorStop(0, rgba(col[0], col[1], col[2], a * 0.8));
      hg.addColorStop(1, rgba(col[0], col[1], col[2], 0));
      g.fillStyle = hg;
      g.fillRect(px - w * 2.6, py - L / 2 - w * 2.6, w * 5.2, w * 5.2);
    });
  }
}

/** dark glossy oil patch with a thin bright rim (the roughness derivation makes these shiny) */
function oil(g: G, s: number, rnd: Rnd, count: number): void {
  for (let i = 0; i < count; i++) {
    const x = rnd() * s;
    const y = rnd() * s;
    const r = 12 + rnd() * 34;
    stain(g, s, rnd, x, y, r, [26, 26, 30], 0.26 + 0.16 * rnd());
    stain(g, s, rnd, x + r * 0.1, y - r * 0.1, r * 0.5, [14, 14, 18], 0.2);
    blotch(g, s, x - r * 0.3, y - r * 0.35, r * 0.26, [120, 130, 150], 0.08); // bluish sheen
  }
}

/** paint that flaked off: ragged patches showing the primer / rusty steel, with a lit edge for relief */
function peel(g: G, s: number, rnd: Rnd, count: number, under: [number, number, number], edge: [number, number, number], minR = 8, maxR = 34): void {
  for (let i = 0; i < count; i++) {
    const cx = rnd() * s;
    const cy = rnd() * s;
    const r = minR + rnd() * (maxR - minR);
    const n = 9 + Math.floor(rnd() * 6);
    const pts: [number, number][] = [];
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      const rr = r * (0.55 + 0.75 * rnd()) * (1 + 0.5 * Math.sin(a * 2 + cx));
      pts.push([Math.cos(a) * rr, Math.sin(a) * rr * 0.75]);
    }
    wrapAt(s, cx, cy, r * 1.6, (px, py) => {
      g.beginPath();
      pts.forEach(([x, y], k) => (k ? g.lineTo(px + x, py + y) : g.moveTo(px + x, py + y)));
      g.closePath();
      g.fillStyle = rgba(under[0], under[1], under[2], 0.8);
      g.fill();
      g.strokeStyle = rgba(edge[0], edge[1], edge[2], 0.32);
      g.lineWidth = 1.4;
      g.stroke();
      // rust bloom in the middle
      const rg = g.createRadialGradient(px, py, 0, px, py, r);
      rg.addColorStop(0, 'rgba(120,58,26,0.55)');
      rg.addColorStop(1, 'rgba(120,58,26,0)');
      g.fillStyle = rg;
      g.fill();
    });
  }
}

/** branching crack */
function crackTree(g: G, s: number, rnd: Rnd, x: number, y: number, ang: number, len: number, w: number, alpha: number, depth: number): void {
  g.strokeStyle = rgba(8, 8, 8, alpha);
  g.lineWidth = w;
  g.beginPath();
  g.moveTo(x, y);
  const steps = Math.max(3, Math.round(len / 9));
  const branches: [number, number, number][] = [];
  for (let i = 0; i < steps; i++) {
    ang += (rnd() - 0.5) * 0.9;
    x += Math.cos(ang) * (5 + rnd() * 9);
    y += Math.sin(ang) * (5 + rnd() * 9);
    g.lineTo(x, y);
    if (depth > 0 && rnd() < 0.22) branches.push([x, y, ang + (rnd() < 0.5 ? -1 : 1) * (0.5 + rnd() * 0.7)]);
  }
  g.stroke();
  // light lip on one side
  g.strokeStyle = 'rgba(255,255,255,0.10)';
  g.lineWidth = 1;
  g.stroke();
  for (const [bx, by, ba] of branches) crackTree(g, s, rnd, bx, by, ba, len * 0.5, Math.max(0.8, w * 0.7), alpha * 0.85, depth - 1);
}

/** worn-out spots on stripes / paint: chips down to the base material */
function chips(g: G, s: number, rnd: Rnd, count: number, col: [number, number, number], a: number): void {
  for (let i = 0; i < count; i++) {
    const x = rnd() * s;
    const y = rnd() * s;
    const r = 2 + rnd() * 9;
    wrapAt(s, x, y, r * 2, (px, py) => {
      g.fillStyle = rgba(col[0], col[1], col[2], a * (0.6 + 0.4 * rnd()));
      g.beginPath();
      const n = 5 + Math.floor(rnd() * 4);
      for (let k = 0; k < n; k++) {
        const an = (k / n) * Math.PI * 2;
        const rr = r * (0.5 + rnd());
        const X = px + Math.cos(an) * rr;
        const Y = py + Math.sin(an) * rr * 0.7;
        if (k) g.lineTo(X, Y);
        else g.moveTo(X, Y);
      }
      g.closePath();
      g.fill();
    });
  }
}

/** tyre / scuff marks: long faint dark strokes along a direction */
function scuffs(g: G, s: number, rnd: Rnd, count: number, dx: number, dy: number, a: number): void {
  for (let i = 0; i < count; i++) {
    const x = rnd() * s;
    const y = rnd() * s;
    const L = 40 + rnd() * 160;
    const w = 2 + rnd() * 7;
    wrapAt(s, x, y, L, (px, py) => {
      const gr = g.createLinearGradient(px, py, px + dx * L, py + dy * L);
      gr.addColorStop(0, 'rgba(10,8,6,0)');
      gr.addColorStop(0.3, rgba(10, 8, 6, a * (0.5 + 0.5 * rnd())));
      gr.addColorStop(1, 'rgba(10,8,6,0)');
      g.strokeStyle = gr;
      g.lineWidth = w;
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(px, py);
      g.lineTo(px + dx * L, py + dy * L);
      g.stroke();
    });
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// individual painters (size s, seeded rnd)
// ---------------------------------------------------------------------------------------------------------------------
function paintConcrete(g: G, s: number, rnd: Rnd, base: [number, number, number]): void {
  g.fillStyle = rgba(...base);
  g.fillRect(0, 0, s, s);
  // low-frequency mottling so the 6 m tile does not read as a repeating photo
  for (let i = 0; i < 26; i++) {
    const c: [number, number, number] = rnd() < 0.5 ? [255, 255, 255] : [0, 0, 0];
    blotch(g, s, rnd() * s, rnd() * s, 70 + rnd() * 150, c, 0.015 + rnd() * 0.03);
  }
  speckle(g, s, rnd, (s * s) / 6, 0.35, 0.25);
  // efflorescence / damp patches
  for (let i = 0; i < 3; i++) stain(g, s, rnd, rnd() * s, rnd() * s, 40 + rnd() * 70, [200, 200, 190], 0.05 + rnd() * 0.04);
  for (let i = 0; i < 3; i++) stain(g, s, rnd, rnd() * s, rnd() * s, 50 + rnd() * 80, [24, 22, 18], 0.04 + rnd() * 0.05);
  streaks(g, s, rnd, 16, [20, 18, 14], 0.24, s * 0.15, s * 0.6);
  // rust water runs from the joints / spalled rebar
  drips(g, s, rnd, 7, [120, 66, 32], 0.3, s * 0.12, s * 0.5);
  streaks(g, s, rnd, 6, [110, 70, 40], 0.16, s * 0.1, s * 0.4);
  // spalled corners with exposed rust
  for (let i = 0; i < 2; i++) {
    const x = rnd() * s;
    const y = rnd() * s;
    chips(g, s, rnd, 1, [58, 56, 52], 0.8);
    stain(g, s, rnd, x, y, 8 + rnd() * 8, [110, 56, 26], 0.3);
  }
  for (let i = 0; i < 3; i++) crackTree(g, s, rnd, rnd() * s, rnd() * s, rnd() * Math.PI * 2, 90 + rnd() * 120, 1.2 + rnd() * 0.8, 0.5, 2);
  // expansion joints along the tile border
  g.fillStyle = 'rgba(0,0,0,0.5)';
  g.fillRect(0, 0, s, 3);
  g.fillRect(0, 0, 3, s);
  g.fillStyle = 'rgba(255,255,255,0.10)';
  g.fillRect(0, 3, s, 2);
  g.fillRect(3, 0, 2, s);
}

function paintMetal(g: G, s: number, rnd: Rnd, base: [number, number, number], panels: number): void {
  g.fillStyle = rgba(...base);
  g.fillRect(0, 0, s, s);
  // brushed lines
  for (let i = 0; i < s * 1.2; i++) {
    const y = rnd() * s;
    const l = 20 + rnd() * s * 0.6;
    const x = rnd() * s;
    g.fillStyle = rgba(rnd() < 0.5 ? 255 : 0, rnd() < 0.5 ? 255 : 0, rnd() < 0.5 ? 255 : 0, 0.04 + rnd() * 0.05);
    g.fillRect(x, y, l, 1);
  }
  for (let i = 0; i < 24; i++) blotch(g, s, rnd() * s, rnd() * s, 30 + rnd() * 90, rnd() < 0.5 ? [255, 255, 255] : [0, 0, 0], 0.05 + rnd() * 0.06);
  const pw = s / panels;
  const seams: number[] = [];
  for (let px = 0; px < panels; px++) {
    for (let py = 0; py < panels; py++) {
      const x = px * pw;
      const y = py * pw;
      g.strokeStyle = 'rgba(0,0,0,0.55)';
      g.lineWidth = 3;
      g.strokeRect(x + 1.5, y + 1.5, pw - 3, pw - 3);
      g.strokeStyle = 'rgba(255,255,255,0.12)';
      g.lineWidth = 1.5;
      g.strokeRect(x + 4.5, y + 4.5, pw - 9, pw - 9);
      const off = 14;
      const rc = 'rgba(150,152,155,1)';
      rivet(g, x + off, y + off, 3, rc);
      rivet(g, x + pw - off, y + off, 3, rc);
      rivet(g, x + off, y + pw - off, 3, rc);
      rivet(g, x + pw - off, y + pw - off, 3, rc);
      seams.push(x + off, x + pw - off);
    }
  }
  // rust run-off under every rivet row, dirty water, oil creep, flaked paint
  drips(g, s, rnd, 18, [112, 58, 26], 0.4, s * 0.1, s * 0.42, seams);
  drips(g, s, rnd, 10, [14, 12, 10], 0.32, s * 0.15, s * 0.6);
  for (let i = 0; i < 5; i++) stain(g, s, rnd, rnd() * s, rnd() * s, 26 + rnd() * 60, [120, 62, 28], 0.12 + rnd() * 0.12);
  peel(g, s, rnd, 4, [92, 54, 34], [190, 190, 190], 6, 20);
  oil(g, s, rnd, 1);
  streaks(g, s, rnd, 10, [10, 10, 10], 0.25, s * 0.1, s * 0.5);
  // scratches (bright bare metal)
  for (let i = 0; i < 34; i++) {
    g.strokeStyle = rgba(236, 236, 236, 0.14 + rnd() * 0.2);
    g.lineWidth = 1;
    g.beginPath();
    const x = rnd() * s;
    const y = rnd() * s;
    g.moveTo(x, y);
    g.lineTo(x + (rnd() - 0.5) * 70, y + (rnd() - 0.5) * 22);
    g.stroke();
  }
  for (let i = 0; i < 2; i++) crackTree(g, s, rnd, rnd() * s, rnd() * s, rnd() * Math.PI * 2, 50 + rnd() * 60, 1, 0.35, 1);
}

function paintRust(g: G, s: number, rnd: Rnd): void {
  g.fillStyle = rgba(96, 58, 36);
  g.fillRect(0, 0, s, s);
  const cols: [number, number, number][] = [
    [140, 74, 34],
    [100, 50, 26],
    [64, 36, 24],
    [168, 98, 44],
    [82, 82, 78],
  ];
  for (let i = 0; i < 90; i++) blotch(g, s, rnd() * s, rnd() * s, 20 + rnd() * 90, cols[Math.floor(rnd() * cols.length)], 0.18 + rnd() * 0.25);
  speckle(g, s, rnd, (s * s) / 4, 0.5, 0.18);
  streaks(g, s, rnd, 22, [40, 20, 10], 0.35, s * 0.2, s * 0.7);
  drips(g, s, rnd, 18, [150, 78, 30], 0.4, s * 0.15, s * 0.6);
  drips(g, s, rnd, 10, [30, 16, 8], 0.4, s * 0.2, s * 0.7);
  // remaining paint flakes (blue-grey factory paint) around the rust
  peel(g, s, rnd, 3, [70, 90, 100], [200, 210, 215], 8, 26);
  for (let i = 0; i < 10; i++) {
    g.fillStyle = rgba(70, 90, 100, 0.55);
    const x = rnd() * s;
    const y = rnd() * s;
    g.beginPath();
    g.ellipse(x, y, 6 + rnd() * 20, 4 + rnd() * 12, rnd() * 3, 0, Math.PI * 2);
    g.fill();
  }
  // bright scale where the corrosion flakes off
  chips(g, s, rnd, 22, [176, 110, 52], 0.45);
  oil(g, s, rnd, 1);
  g.strokeStyle = 'rgba(0,0,0,0.5)';
  g.lineWidth = 3;
  g.strokeRect(1.5, 1.5, s - 3, s - 3);
}

function paintHazard(g: G, s: number, rnd: Rnd, a: [number, number, number], b: [number, number, number], stripes = 8): void {
  g.fillStyle = rgba(...b);
  g.fillRect(0, 0, s, s);
  g.fillStyle = rgba(...a);
  const w = s / stripes;
  // diagonal stripes, tileable: draw parallelograms over a 3x range
  for (let i = -stripes * 2; i < stripes * 3; i += 2) {
    g.beginPath();
    g.moveTo(i * w, 0);
    g.lineTo((i + 1) * w, 0);
    g.lineTo((i + 1) * w - s, s);
    g.lineTo(i * w - s, s);
    g.closePath();
    g.fill();
  }
  // wear: the paint is ground away where machines / tyres run (the stripes stay readable, only broken up)
  for (let i = 0; i < 36; i++) blotch(g, s, rnd() * s, rnd() * s, 10 + rnd() * 50, [30, 25, 20], 0.10 + rnd() * 0.16);
  chips(g, s, rnd, 46, [74, 70, 64], 0.75);
  chips(g, s, rnd, 20, [54, 30, 18], 0.6);
  scuffs(g, s, rnd, 9, 0.55, -1, 0.42);
  scuffs(g, s, rnd, 5, 1, 0, 0.3);
  for (let i = 0; i < 4; i++) stain(g, s, rnd, rnd() * s, rnd() * s, 20 + rnd() * 30, [12, 10, 8], 0.35);
  speckle(g, s, rnd, (s * s) / 5, 0.5, 0.15);
  streaks(g, s, rnd, 10, [20, 16, 10], 0.3, s * 0.1, s * 0.4);
  g.strokeStyle = 'rgba(0,0,0,0.6)';
  g.lineWidth = 4;
  g.strokeRect(2, 2, s - 4, s - 4);
}

function paintGrating(g: G, s: number, rnd: Rnd): void {
  g.fillStyle = rgba(12, 13, 15);
  g.fillRect(0, 0, s, s);
  const pitch = s / 12;
  for (let i = 0; i < 12; i++) {
    const p = i * pitch;
    // bars (top faces lit, sides dark)
    g.fillStyle = rgba(96, 102, 108);
    g.fillRect(p, 0, pitch * 0.32, s);
    g.fillStyle = rgba(150, 156, 162);
    g.fillRect(p, 0, pitch * 0.1, s);
    g.fillStyle = rgba(70, 74, 78);
    g.fillRect(0, p, s, pitch * 0.26);
    g.fillStyle = rgba(130, 136, 142);
    g.fillRect(0, p, s, pitch * 0.07);
  }
  for (let i = 0; i < 40; i++) blotch(g, s, rnd() * s, rnd() * s, 15 + rnd() * 50, [90, 50, 20], 0.10 + rnd() * 0.15);
  speckle(g, s, rnd, (s * s) / 10, 0.5, 0.1);
  g.strokeStyle = 'rgba(200,200,205,0.6)';
  g.lineWidth = 3;
  g.strokeRect(1.5, 1.5, s - 3, s - 3);
}

function paintPipe(g: G, s: number, rnd: Rnd): void {
  // u runs around the circumference (wrap), v runs along the axis
  const gr = g.createLinearGradient(0, 0, s, 0);
  gr.addColorStop(0, rgba(88, 104, 110));
  gr.addColorStop(0.5, rgba(122, 140, 146));
  gr.addColorStop(1, rgba(88, 104, 110));
  g.fillStyle = gr;
  g.fillRect(0, 0, s, s);
  for (let i = 0; i < 30; i++) blotch(g, s, rnd() * s, rnd() * s, 20 + rnd() * 70, rnd() < 0.5 ? [120, 66, 30] : [0, 0, 0], 0.12 + rnd() * 0.15);
  streaks(g, s, rnd, 20, [40, 22, 12], 0.35, s * 0.2, s * 0.8);
  speckle(g, s, rnd, (s * s) / 8, 0.4, 0.15);
  // flange bands & bolts along the axis
  for (const y of [s * 0.06, s * 0.5]) {
    g.fillStyle = 'rgba(30,34,38,0.85)';
    g.fillRect(0, y - 9, s, 18);
    g.fillStyle = 'rgba(190,196,200,0.28)';
    g.fillRect(0, y - 9, s, 3);
    for (let x = 12; x < s; x += 32) rivet(g, x, y, 4, 'rgba(120,124,128,1)');
    // leaking joint: rust + wet dark run below the flange
    drips(g, s, rnd, 9, [120, 62, 26], 0.45, s * 0.12, s * 0.35, [12, 44, 76, 108, 140, 172, 204, 236]);
    drips(g, s, rnd, 4, [10, 10, 12], 0.4, s * 0.1, s * 0.3);
  }
  // colored identification band
  g.fillStyle = 'rgba(210,170,30,0.55)';
  g.fillRect(0, s * 0.72, s, 14);
  chips(g, s, rnd, 16, [94, 60, 40], 0.6);
  peel(g, s, rnd, 3, [96, 60, 38], [200, 200, 200], 6, 16);
}

function paintCrate(g: G, s: number, rnd: Rnd): void {
  // corrugated container wall; neutral light gray so per-vertex tint gives the container color
  g.fillStyle = rgba(196, 196, 196);
  g.fillRect(0, 0, s, s);
  const ribs = 16;
  const w = s / ribs;
  for (let i = 0; i < ribs; i++) {
    const gr = g.createLinearGradient(i * w, 0, (i + 1) * w, 0);
    gr.addColorStop(0, 'rgba(0,0,0,0.35)');
    gr.addColorStop(0.5, 'rgba(255,255,255,0.18)');
    gr.addColorStop(1, 'rgba(0,0,0,0.30)');
    g.fillStyle = gr;
    g.fillRect(i * w, 0, w, s);
  }
  for (let i = 0; i < 40; i++) blotch(g, s, rnd() * s, rnd() * s, 20 + rnd() * 60, rnd() < 0.4 ? [130, 70, 30] : [0, 0, 0], 0.10 + rnd() * 0.16);
  streaks(g, s, rnd, 16, [60, 30, 12], 0.30, s * 0.2, s * 0.9);
  // sun-faded / dented paint: bare steel + rust where the paint is gone, drips from the top rail
  peel(g, s, rnd, 6, [112, 66, 40], [230, 230, 230], 8, 24);
  drips(g, s, rnd, 14, [110, 56, 24], 0.38, s * 0.15, s * 0.8);
  chips(g, s, rnd, 24, [90, 60, 44], 0.55);
  speckle(g, s, rnd, (s * s) / 6, 0.4, 0.2);
  // stencil label (faded)
  g.fillStyle = 'rgba(240,240,235,0.5)';
  g.fillRect(s * 0.15, s * 0.3, s * 0.34, s * 0.09);
  g.fillRect(s * 0.15, s * 0.44, s * 0.22, s * 0.05);
  chips(g, s, rnd, 14, [150, 150, 150], 0.7);
  // steel frame
  g.fillStyle = 'rgba(30,30,30,0.6)';
  g.fillRect(0, 0, s, 8);
  g.fillRect(0, s - 8, s, 8);
  g.fillRect(0, 0, 8, s);
  g.fillRect(s - 8, 0, 8, s);
}

function paintMachine(g: G, s: number, rnd: Rnd): void {
  g.fillStyle = rgba(52, 66, 74);
  g.fillRect(0, 0, s, s);
  for (let i = 0; i < 26; i++) blotch(g, s, rnd() * s, rnd() * s, 30 + rnd() * 80, rnd() < 0.5 ? [255, 255, 255] : [0, 0, 0], 0.05 + rnd() * 0.07);
  const half = s / 2;
  for (let px = 0; px < 2; px++) {
    for (let py = 0; py < 2; py++) {
      const x = px * half;
      const y = py * half;
      g.strokeStyle = 'rgba(0,0,0,0.65)';
      g.lineWidth = 4;
      g.strokeRect(x + 2, y + 2, half - 4, half - 4);
      g.strokeStyle = 'rgba(255,255,255,0.10)';
      g.lineWidth = 1.5;
      g.strokeRect(x + 6, y + 6, half - 12, half - 12);
      const kind = (px + py * 2 + Math.floor(rnd() * 3)) % 3;
      if (kind === 0) {
        // vents
        for (let i = 0; i < 7; i++) {
          g.fillStyle = 'rgba(8,10,12,0.9)';
          g.fillRect(x + 22, y + 26 + i * 15, half - 44, 8);
          g.fillStyle = 'rgba(255,255,255,0.08)';
          g.fillRect(x + 22, y + 34 + i * 15, half - 44, 1.5);
        }
      } else if (kind === 1) {
        // gauge + lamps
        g.fillStyle = 'rgba(10,12,14,1)';
        g.beginPath();
        g.arc(x + half / 2, y + half / 2 - 10, 34, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = 'rgba(220,225,215,0.9)';
        g.beginPath();
        g.arc(x + half / 2, y + half / 2 - 10, 28, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = 'rgba(200,30,20,1)';
        g.lineWidth = 3;
        g.beginPath();
        g.moveTo(x + half / 2, y + half / 2 - 10);
        g.lineTo(x + half / 2 + 18, y + half / 2 - 24);
        g.stroke();
        const lamps = ['rgb(60,220,90)', 'rgb(240,190,40)', 'rgb(230,50,40)'];
        for (let i = 0; i < 3; i++) {
          g.fillStyle = lamps[(i + px) % 3];
          g.beginPath();
          g.arc(x + 40 + i * 30, y + half - 34, 7, 0, Math.PI * 2);
          g.fill();
        }
      } else {
        // hazard corner + warning plate
        g.save();
        g.beginPath();
        g.rect(x + 14, y + 14, half - 28, 26);
        g.clip();
        g.fillStyle = 'rgb(220,180,20)';
        g.fillRect(x + 14, y + 14, half - 28, 26);
        g.fillStyle = 'rgb(20,20,20)';
        for (let k = -4; k < 12; k++) {
          g.beginPath();
          g.moveTo(x + 14 + k * 20, y + 14);
          g.lineTo(x + 24 + k * 20, y + 14);
          g.lineTo(x + 4 + k * 20, y + 40);
          g.lineTo(x - 6 + k * 20, y + 40);
          g.fill();
        }
        g.restore();
        for (let i = 0; i < 3; i++) rivet(g, x + 30 + i * 40, y + half - 30, 4, 'rgba(140,146,150,1)');
      }
    }
  }
  streaks(g, s, rnd, 14, [10, 10, 10], 0.3, s * 0.1, s * 0.5);
  // oil-stained, chipped cabinet panels; rust weeping from the seams
  drips(g, s, rnd, 10, [112, 58, 26], 0.32, s * 0.08, s * 0.3, [4, half, s - 4, half - 4, half + 4]);
  for (let i = 0; i < 4; i++) stain(g, s, rnd, rnd() * s, rnd() * s, 26 + rnd() * 40, [18, 16, 14], 0.16);
  chips(g, s, rnd, 14, [96, 100, 100], 0.5);
  speckle(g, s, rnd, (s * s) / 10, 0.4, 0.12);
}

function paintGlass(g: G, s: number, rnd: Rnd): void {
  g.fillStyle = rgba(150, 205, 215);
  g.fillRect(0, 0, s, s);
  for (let i = 0; i < 6; i++) {
    g.fillStyle = 'rgba(255,255,255,0.18)';
    const x = rnd() * s;
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x + 30 + rnd() * 30, 0);
    g.lineTo(x - 60 + 30, s);
    g.lineTo(x - 60, s);
    g.fill();
  }
  speckle(g, s, rnd, (s * s) / 30, 0.2, 0.3);
  streaks(g, s, rnd, 10, [20, 40, 40], 0.3, s * 0.2, s * 0.6);
  g.strokeStyle = 'rgba(30,50,55,0.85)';
  g.lineWidth = 5;
  g.strokeRect(2.5, 2.5, s - 5, s - 5);
}

function paintBarrier(g: G, s: number, rnd: Rnd): void {
  // red / yellow warning stripes with a chevron band; used as map + emissiveMap
  g.fillStyle = rgba(190, 20, 20);
  g.fillRect(0, 0, s, s);
  g.fillStyle = rgba(250, 200, 20);
  const w = s / 6;
  for (let i = -12; i < 18; i += 2) {
    g.beginPath();
    g.moveTo(i * w, 0);
    g.lineTo((i + 1) * w, 0);
    g.lineTo((i + 1) * w - s, s);
    g.lineTo(i * w - s, s);
    g.closePath();
    g.fill();
  }
  speckle(g, s, rnd, (s * s) / 10, 0.35, 0.1);
  for (let i = 0; i < 16; i++) blotch(g, s, rnd() * s, rnd() * s, 12 + rnd() * 40, [40, 10, 6], 0.10 + rnd() * 0.12);
  g.strokeStyle = 'rgba(30,8,4,0.9)';
  g.lineWidth = 8;
  g.strokeRect(4, 4, s - 8, s - 8);
}

function paintGate(g: G, s: number, rnd: Rnd): void {
  g.fillStyle = rgba(44, 46, 52);
  g.fillRect(0, 0, s, s);
  for (let i = 0; i < 24; i++) blotch(g, s, rnd() * s, rnd() * s, 30 + rnd() * 80, rnd() < 0.5 ? [255, 255, 255] : [0, 0, 0], 0.04 + rnd() * 0.06);
  // big chevrons
  for (let k = 0; k < 3; k++) {
    const y = s * (0.18 + k * 0.27);
    g.fillStyle = k % 2 ? 'rgb(240,190,20)' : 'rgb(220,40,30)';
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(s / 2, y + s * 0.13);
    g.lineTo(s, y);
    g.lineTo(s, y + s * 0.09);
    g.lineTo(s / 2, y + s * 0.22);
    g.lineTo(0, y + s * 0.09);
    g.closePath();
    g.fill();
  }
  // a heavy shutter: scraped by decades of use, chevrons stay readable
  chips(g, s, rnd, 36, [70, 66, 62], 0.55);
  scuffs(g, s, rnd, 8, 0.2, 1, 0.3);
  g.strokeStyle = 'rgba(0,0,0,0.6)';
  g.lineWidth = 6;
  g.strokeRect(3, 3, s - 6, s - 6);
  for (let i = 0; i < 8; i++) {
    rivet(g, 14 + i * ((s - 28) / 7), 14, 4, 'rgba(150,154,158,1)');
    rivet(g, 14 + i * ((s - 28) / 7), s - 14, 4, 'rgba(150,154,158,1)');
  }
  drips(g, s, rnd, 12, [110, 56, 24], 0.34, s * 0.1, s * 0.4, [14, 60, 110, 160, 210, 260, 310, 360, 410, 460, 498]);
  streaks(g, s, rnd, 12, [10, 6, 4], 0.3, s * 0.2, s * 0.6);
  speckle(g, s, rnd, (s * s) / 8, 0.4, 0.12);
}

function paintFloorTile(g: G, s: number, rnd: Rnd): void {
  g.fillStyle = rgba(76, 86, 82);
  g.fillRect(0, 0, s, s);
  const n = 4;
  const w = s / n;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const v = (rnd() - 0.5) * 30;
      g.fillStyle = rgba(76 + v, 86 + v, 82 + v);
      g.fillRect(i * w + 2, j * w + 2, w - 4, w - 4);
    }
  }
  g.fillStyle = 'rgba(0,0,0,0.55)';
  for (let i = 0; i < n; i++) {
    g.fillRect(i * w, 0, 3, s);
    g.fillRect(0, i * w, s, 3);
  }
  for (let i = 0; i < 40; i++) blotch(g, s, rnd() * s, rnd() * s, 20 + rnd() * 70, rnd() < 0.5 ? [255, 255, 255] : [10, 8, 4], 0.03 + rnd() * 0.05);
  speckle(g, s, rnd, (s * s) / 6, 0.3, 0.12);
  // grime collects in the joints; traffic lanes are worn lighter, spilled oil / rust water elsewhere
  for (let i = 0; i < 4; i++) stain(g, s, rnd, rnd() * s, rnd() * s, 30 + rnd() * 60, [20, 16, 10], 0.1 + rnd() * 0.1);
  oil(g, s, rnd, 1);
  stain(g, s, rnd, rnd() * s, rnd() * s, 40, [120, 66, 30], 0.14);
  chips(g, s, rnd, 8, [44, 50, 48], 0.5);
  scuffs(g, s, rnd, 6, 1, 0.15, 0.22);
  streaks(g, s, rnd, 6, [20, 16, 10], 0.2, s * 0.1, s * 0.4);
  for (let i = 0; i < 2; i++) crackTree(g, s, rnd, rnd() * s, rnd() * s, rnd() * Math.PI * 2, 80 + rnd() * 80, 1.4, 0.5, 2);
}

function paintRoof(g: G, s: number, rnd: Rnd): void {
  g.fillStyle = rgba(46, 50, 56);
  g.fillRect(0, 0, s, s);
  const ribs = 12;
  const w = s / ribs;
  for (let i = 0; i < ribs; i++) {
    const gr = g.createLinearGradient(i * w, 0, (i + 1) * w, 0);
    gr.addColorStop(0, 'rgba(0,0,0,0.35)');
    gr.addColorStop(0.5, 'rgba(255,255,255,0.10)');
    gr.addColorStop(1, 'rgba(0,0,0,0.3)');
    g.fillStyle = gr;
    g.fillRect(i * w, 0, w, s);
  }
  for (let i = 0; i < 30; i++) blotch(g, s, rnd() * s, rnd() * s, 30 + rnd() * 90, rnd() < 0.5 ? [130, 70, 30] : [0, 0, 0], 0.10 + rnd() * 0.16);
  streaks(g, s, rnd, 12, [110, 66, 30], 0.28, s * 0.2, s * 0.8);
  // leaks: pale water stains with rust rims, corroded sheet joints, holes letting the sky through (only lightened, no real opening)
  for (let i = 0; i < 4; i++) {
    const x = rnd() * s;
    const y = rnd() * s;
    stain(g, s, rnd, x, y, 26 + rnd() * 30, [150, 140, 120], 0.16);
    stain(g, s, rnd, x, y, 14 + rnd() * 14, [120, 60, 26], 0.24);
  }
  drips(g, s, rnd, 14, [120, 62, 26], 0.38, s * 0.15, s * 0.6);
  peel(g, s, rnd, 5, [92, 60, 40], [170, 170, 170], 6, 22);
  speckle(g, s, rnd, (s * s) / 8, 0.4, 0.1);
  g.fillStyle = 'rgba(0,0,0,0.5)';
  g.fillRect(0, s / 2 - 2, s, 4);
}

function paintLightPanel(g: G, s: number, rnd: Rnd): void {
  g.fillStyle = rgba(30, 30, 30);
  g.fillRect(0, 0, s, s);
  const gr = g.createLinearGradient(0, 0, 0, s);
  gr.addColorStop(0, rgba(255, 244, 214));
  gr.addColorStop(0.5, rgba(255, 252, 236));
  gr.addColorStop(1, rgba(255, 238, 196));
  g.fillStyle = gr;
  g.fillRect(8, 8, s - 16, s - 16);
  g.fillStyle = 'rgba(80,60,30,0.35)';
  g.fillRect(s / 2 - 1.5, 8, 3, s - 16);
  g.fillRect(8, s / 2 - 1.5, s - 16, 3);
  blotch(g, s, rnd() * s, rnd() * s, 60, [120, 90, 40], 0.18);
  speckle(g, s, rnd, (s * s) / 40, 0.25, 0.0);
}

// ---------------------------------------------------------------------------------------------------------------------
// mech / enemy paint
// ---------------------------------------------------------------------------------------------------------------------
function paintArmor(g: G, s: number, rnd: Rnd, base: [number, number, number]): void {
  g.fillStyle = rgba(...base);
  g.fillRect(0, 0, s, s);
  for (let i = 0; i < 22; i++) blotch(g, s, rnd() * s, rnd() * s, 26 + rnd() * 70, rnd() < 0.5 ? [255, 255, 255] : [0, 0, 0], 0.04 + rnd() * 0.06);
  g.strokeStyle = 'rgba(0,0,0,0.45)';
  g.lineWidth = 3;
  g.strokeRect(2, 2, s - 4, s - 4);
  g.beginPath();
  g.moveTo(0, s * 0.5);
  g.lineTo(s, s * 0.5);
  g.moveTo(s * 0.5, 0);
  g.lineTo(s * 0.5, s);
  g.stroke();
  g.strokeStyle = 'rgba(255,255,255,0.10)';
  g.lineWidth = 1.5;
  g.strokeRect(6, 6, s - 12, s - 12);
  speckle(g, s, rnd, (s * s) / 14, 0.35, 0.15);
  // paint chips & scratches
  for (let i = 0; i < 18; i++) {
    g.strokeStyle = rgba(225, 225, 225, 0.10 + rnd() * 0.22);
    g.lineWidth = 1;
    g.beginPath();
    const x = rnd() * s;
    const y = rnd() * s;
    g.moveTo(x, y);
    g.lineTo(x + (rnd() - 0.5) * 34, y + (rnd() - 0.5) * 14);
    g.stroke();
  }
  streaks(g, s, rnd, 5, [10, 10, 10], 0.22, s * 0.1, s * 0.4);
  for (const [x, y] of [[12, 12], [s - 12, 12], [12, s - 12], [s - 12, s - 12]]) rivet(g, x, y, 2.5, 'rgba(160,164,168,1)');
}

// ---------------------------------------------------------------------------------------------------------------------
// utility textures
// ---------------------------------------------------------------------------------------------------------------------
function paintRadial(g: G, s: number, stops: [number, string][]): void {
  const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  for (const [o, c] of stops) gr.addColorStop(o, c);
  g.fillStyle = gr;
  g.fillRect(0, 0, s, s);
}

function paintChevron(g: G, s: number): void {
  g.clearRect(0, 0, s, s);
  g.fillStyle = 'rgba(255,255,255,1)';
  g.beginPath();
  g.moveTo(s * 0.04, s * 0.66);
  g.lineTo(s * 0.5, s * 0.2);
  g.lineTo(s * 0.96, s * 0.66);
  g.lineTo(s * 0.96, s * 0.88);
  g.lineTo(s * 0.5, s * 0.42);
  g.lineTo(s * 0.04, s * 0.88);
  g.closePath();
  g.fill();
}

function paintVerticalFade(g: G, s: number): void {
  const gr = g.createLinearGradient(0, s, 0, 0);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.15, 'rgba(255,255,255,0.7)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, s, s);
  // soft edge across u
  const gh = g.createLinearGradient(0, 0, s, 0);
  gh.addColorStop(0, 'rgba(0,0,0,0.65)');
  gh.addColorStop(0.5, 'rgba(0,0,0,0)');
  gh.addColorStop(1, 'rgba(0,0,0,0.65)');
  g.globalCompositeOperation = 'destination-out';
  g.fillStyle = gh;
  g.fillRect(0, 0, s, s);
  g.globalCompositeOperation = 'source-over';
}

interface TexSpec {
  size: number;
  avg: [number, number, number];
  paint: (g: G, s: number, rnd: Rnd) => void;
  srgb: boolean;
  repeat: boolean;
  seed: number;
}

const SPECS: Record<string, TexSpec> = {
  concrete: { size: 512, avg: [110, 112, 110], paint: (g, s, r) => paintConcrete(g, s, r, [112, 114, 112]), srgb: true, repeat: true, seed: 11 },
  concreteDark: { size: 512, avg: [64, 66, 66], paint: (g, s, r) => paintConcrete(g, s, r, [84, 86, 86]), srgb: true, repeat: true, seed: 12 },
  metal: { size: 512, avg: [120, 126, 132], paint: (g, s, r) => paintMetal(g, s, r, [124, 130, 136], 2), srgb: true, repeat: true, seed: 13 },
  metalDark: { size: 512, avg: [60, 66, 72], paint: (g, s, r) => paintMetal(g, s, r, [88, 94, 102], 2), srgb: true, repeat: true, seed: 14 },
  rust: { size: 512, avg: [110, 62, 34], paint: (g, s, r) => paintRust(g, s, r), srgb: true, repeat: true, seed: 15 },
  hazard: { size: 256, avg: [130, 110, 20], paint: (g, s, r) => paintHazard(g, s, r, [230, 184, 24], [24, 24, 24]), srgb: true, repeat: true, seed: 16 },
  grating: { size: 256, avg: [50, 54, 58], paint: (g, s, r) => paintGrating(g, s, r), srgb: true, repeat: true, seed: 17 },
  pipe: { size: 256, avg: [100, 116, 122], paint: (g, s, r) => paintPipe(g, s, r), srgb: true, repeat: true, seed: 18 },
  crate: { size: 512, avg: [170, 170, 170], paint: (g, s, r) => paintCrate(g, s, r), srgb: true, repeat: true, seed: 19 },
  machine: { size: 512, avg: [56, 70, 78], paint: (g, s, r) => paintMachine(g, s, r), srgb: true, repeat: true, seed: 20 },
  glass: { size: 128, avg: [150, 205, 215], paint: (g, s, r) => paintGlass(g, s, r), srgb: true, repeat: true, seed: 21 },
  barrier: { size: 256, avg: [220, 110, 20], paint: (g, s, r) => paintBarrier(g, s, r), srgb: true, repeat: true, seed: 22 },
  gate: { size: 512, avg: [90, 60, 40], paint: (g, s, r) => paintGate(g, s, r), srgb: true, repeat: true, seed: 23 },
  floorTile: { size: 512, avg: [76, 86, 82], paint: (g, s, r) => paintFloorTile(g, s, r), srgb: true, repeat: true, seed: 24 },
  roof: { size: 256, avg: [46, 50, 56], paint: (g, s, r) => paintRoof(g, s, r), srgb: true, repeat: true, seed: 25 },
  lightPanel: { size: 128, avg: [255, 244, 214], paint: (g, s, r) => paintLightPanel(g, s, r), srgb: true, repeat: true, seed: 26 },
  armorLight: { size: 256, avg: [150, 158, 168], paint: (g, s, r) => paintArmor(g, s, r, [152, 160, 170]), srgb: true, repeat: true, seed: 31 },
  armorDark: { size: 256, avg: [70, 76, 84], paint: (g, s, r) => paintArmor(g, s, r, [72, 78, 86]), srgb: true, repeat: true, seed: 32 },
  armorAccent: { size: 256, avg: [230, 130, 30], paint: (g, s, r) => paintArmor(g, s, r, [232, 128, 28]), srgb: true, repeat: true, seed: 33 },
  armorYellow: { size: 256, avg: [230, 190, 30], paint: (g, s, r) => paintArmor(g, s, r, [232, 190, 36]), srgb: true, repeat: true, seed: 34 },
  armorOlive: { size: 256, avg: [86, 98, 78], paint: (g, s, r) => paintArmor(g, s, r, [88, 100, 80]), srgb: true, repeat: true, seed: 35 },
  armorRed: { size: 256, avg: [170, 40, 34], paint: (g, s, r) => paintArmor(g, s, r, [176, 42, 36]), srgb: true, repeat: true, seed: 36 },
  glow: {
    size: 128,
    avg: [255, 255, 255],
    paint: (g, s) => paintRadial(g, s, [[0, 'rgba(255,255,255,1)'], [0.25, 'rgba(255,255,255,0.7)'], [0.6, 'rgba(255,255,255,0.15)'], [1, 'rgba(255,255,255,0)']]),
    srgb: true,
    repeat: false,
    seed: 41,
  },
  blob: {
    size: 128,
    avg: [0, 0, 0],
    paint: (g, s) => paintRadial(g, s, [[0, 'rgba(0,0,0,0.85)'], [0.5, 'rgba(0,0,0,0.5)'], [1, 'rgba(0,0,0,0)']]),
    srgb: true,
    repeat: false,
    seed: 42,
  },
  chevron: { size: 128, avg: [255, 255, 255], paint: (g, s) => paintChevron(g, s), srgb: true, repeat: true, seed: 43 },
  pillar: { size: 128, avg: [255, 255, 255], paint: (g, s) => paintVerticalFade(g, s), srgb: true, repeat: false, seed: 44 },
};

export type TextureName = keyof typeof SPECS;
/** every procedural texture name (dev: timing / contact sheets) */
export const TEXTURE_NAMES: string[] = Object.keys(SPECS);

function makeTexture(spec: TexSpec): Texture {
  if (!hasCanvas()) {
    const d = new Uint8Array([spec.avg[0], spec.avg[1], spec.avg[2], 255]);
    const t = new DataTexture(d, 1, 1, RGBAFormat, UnsignedByteType);
    t.needsUpdate = true;
    if (spec.srgb) t.colorSpace = SRGBColorSpace;
    return t;
  }
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = spec.size;
  // a CPU-backed canvas: the roughness / height derivation reads every colour canvas back (getImageData), and reading a GPU-backed canvas
  // stalls the pipeline once per texture (measured: ~0.2 s each on a busy software-GL machine vs ~4 ms for a CPU canvas)
  const g = canvas.getContext('2d', { willReadFrequently: true });
  if (!g) {
    const d = new Uint8Array([spec.avg[0], spec.avg[1], spec.avg[2], 255]);
    const t = new DataTexture(d, 1, 1, RGBAFormat, UnsignedByteType);
    t.needsUpdate = true;
    return t;
  }
  spec.paint(g, spec.size, mulberry32(spec.seed));
  const t = new CanvasTexture(canvas);
  if (spec.srgb) t.colorSpace = SRGBColorSpace;
  if (spec.repeat) t.wrapS = t.wrapT = RepeatWrapping;
  else t.wrapS = t.wrapT = ClampToEdgeWrapping;
  t.generateMipmaps = true;
  t.minFilter = spec.repeat ? LinearMipmapLinearFilter : LinearFilter;
  t.magFilter = LinearFilter;
  t.needsUpdate = true;
  return t;
}

// ---------------------------------------------------------------------------------------------------------------------
// stage material definitions
// ---------------------------------------------------------------------------------------------------------------------
export interface StageMatDef {
  tex: TextureName;
  /** metres per texture repeat */
  tile: number;
  roughness: number;
  metalness: number;
  bump: number;
  /** emissive tint used when box.emissive > 0 (multiplied with the texture through emissiveMap) */
  glow: number;
  transparent?: number;
  emissiveColor: number;
  /**
   * derived roughness / height map ("mr" texture: R = height for the bump, G = roughness), see deriveMR().
   * `roughness` above is the MEAN; rust makes it rougher, oil / scuffed bare metal smoother.
   */
  mr?: { rust: number; dark: number; scratch: number; oil: number };
}

export const STAGE_MATS: Record<MaterialKey, StageMatDef> = {
  concrete: { tex: 'concrete', tile: 6, roughness: 0.92, metalness: 0.0, bump: 0.6, glow: 0.0, emissiveColor: 0xffffff, mr: { rust: 0.08, dark: 0.1, scratch: 0.0, oil: 0.3 } },
  concreteDark: { tex: 'concreteDark', tile: 6, roughness: 0.92, metalness: 0.0, bump: 0.6, glow: 0.0, emissiveColor: 0xffffff, mr: { rust: 0.08, dark: 0.1, scratch: 0.0, oil: 0.3 } },
  metal: { tex: 'metal', tile: 4, roughness: 0.5, metalness: 0.65, bump: 0.9, glow: 0.0, emissiveColor: 0xffffff, mr: { rust: 0.42, dark: 0.16, scratch: 0.22, oil: 0.32 } },
  metalDark: { tex: 'metalDark', tile: 4, roughness: 0.6, metalness: 0.5, bump: 0.7, glow: 0.0, emissiveColor: 0xffffff, mr: { rust: 0.36, dark: 0.16, scratch: 0.22, oil: 0.32 } },
  rust: { tex: 'rust', tile: 5, roughness: 0.86, metalness: 0.25, bump: 1.1, glow: 0.0, emissiveColor: 0xffffff, mr: { rust: 0.12, dark: 0.16, scratch: 0.1, oil: 0.4 } },
  hazard: { tex: 'hazard', tile: 2.5, roughness: 0.72, metalness: 0.1, bump: 0.55, glow: 0.0, emissiveColor: 0xffb020, mr: { rust: 0.1, dark: 0.12, scratch: 0.12, oil: 0.3 } },
  grating: { tex: 'grating', tile: 3, roughness: 0.6, metalness: 0.6, bump: 1.4, glow: 0.0, emissiveColor: 0xffffff, mr: { rust: 0.3, dark: 0.1, scratch: 0.2, oil: 0.2 } },
  pipe: { tex: 'pipe', tile: 3, roughness: 0.5, metalness: 0.55, bump: 0.6, glow: 0.0, emissiveColor: 0xffffff, mr: { rust: 0.4, dark: 0.16, scratch: 0.2, oil: 0.3 } },
  crate: { tex: 'crate', tile: 3, roughness: 0.65, metalness: 0.35, bump: 1.2, glow: 0.0, emissiveColor: 0xffffff, mr: { rust: 0.36, dark: 0.14, scratch: 0.2, oil: 0.2 } },
  machine: { tex: 'machine', tile: 4, roughness: 0.5, metalness: 0.5, bump: 0.7, glow: 0.0, emissiveColor: 0x60ffb0, mr: { rust: 0.3, dark: 0.16, scratch: 0.2, oil: 0.3 } },
  glass: { tex: 'glass', tile: 3, roughness: 0.12, metalness: 0.0, bump: 0.0, glow: 0.0, transparent: 0.32, emissiveColor: 0x9fe0ff },
  barrier: { tex: 'barrier', tile: 3, roughness: 0.6, metalness: 0.2, bump: 0.0, glow: 0.6, emissiveColor: 0xffffff },
  gate: { tex: 'gate', tile: 5, roughness: 0.5, metalness: 0.55, bump: 0.6, glow: 0.45, emissiveColor: 0xffffff, mr: { rust: 0.3, dark: 0.12, scratch: 0.2, oil: 0.2 } },
  floorTile: { tex: 'floorTile', tile: 4, roughness: 0.78, metalness: 0.05, bump: 0.4, glow: 0.0, emissiveColor: 0xffffff, mr: { rust: 0.14, dark: 0.12, scratch: 0.1, oil: 0.5 } },
  roof: { tex: 'roof', tile: 6, roughness: 0.85, metalness: 0.3, bump: 0.8, glow: 0.0, emissiveColor: 0xffffff, mr: { rust: 0.14, dark: 0.12, scratch: 0.12, oil: 0.2 } },
  lightPanel: { tex: 'lightPanel', tile: 2, roughness: 0.3, metalness: 0.0, bump: 0.0, glow: 1.0, emissiveColor: 0xffffff },
};

/** separable box blur with wrap-around (the maps tile), radius in texels */
function boxBlurWrap(src: Float32Array, size: number, radius: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const w = radius * 2 + 1;
  for (let y = 0; y < size; y++) {
    let acc = 0;
    for (let k = -radius; k <= radius; k++) acc += src[y * size + ((k + size) % size)];
    for (let x = 0; x < size; x++) {
      tmp[y * size + x] = acc / w;
      acc += src[y * size + ((x + radius + 1) % size)] - src[y * size + ((x - radius + size) % size)];
    }
  }
  for (let x = 0; x < size; x++) {
    let acc = 0;
    for (let k = -radius; k <= radius; k++) acc += tmp[((k + size) % size) * size + x];
    for (let y = 0; y < size; y++) {
      out[y * size + x] = acc / w;
      acc += tmp[((y + radius + 1) % size) * size + x] - tmp[((y - radius + size) % size) * size + x];
    }
  }
  return out;
}

/** stage materials at least this metallic get the environment map */
const ENV_METALNESS_MIN = 0.25;

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Roughness + height map derived from the painted colour canvas (one extra <= 256 px texture per material):
 *   R = height (feeds bumpMap, so stripes / stencils are no longer bumped by their colour),
 *   G = roughness (roughnessMap; material.roughness = 1): rust and grime are rough, oil patches and scuffed bare metal are smooth.
 * Same UVs as the colour map. Not available without a canvas (Node tests).
 */
function deriveMR(color: Texture, def: StageMatDef): Texture | null {
  const mp = def.mr;
  const src = color.image as HTMLCanvasElement | undefined;
  if (!mp || !hasCanvas() || !src || typeof src.getContext !== 'function') return null;
  const size = Math.min(256, src.width);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d', { willReadFrequently: true });
  if (!g) return null;
  g.drawImage(src, 0, 0, size, size);
  const img = g.getImageData(0, 0, size, size);
  const d = img.data;
  // height = luminance minus its local mean (high pass): scratches, seams, speckle and cracks become relief while large soft stains
  // stay flat (a plain luminance height turns every dark stain into a crater)
  const n = size * size;
  const lumA = new Float32Array(n);
  for (let i = 0, k = 0; i < d.length; i += 4, k++) lumA[k] = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
  const blur = boxBlurWrap(lumA, size, 5);
  for (let i = 0, k = 0; i < d.length; i += 4, k++) {
    const r = d[i];
    const b = d[i + 2];
    const lum = lumA[k];
    const rust = smooth(16, 70, r - b);
    const bright = smooth(0.62, 0.9, lum);
    const oilK = 1 - smooth(0.05, 0.2, lum);
    const rough = Math.min(1, Math.max(0.12, def.roughness + mp.rust * rust - mp.scratch * bright + mp.dark * (0.45 - lum) - mp.oil * oilK));
    const h = Math.min(1, Math.max(0, 0.5 + (lum - blur[k]) * 2.2 + 0.12 * rust));
    d[i] = Math.round(h * 255);
    d[i + 1] = Math.round(rough * 255);
    d[i + 2] = Math.round(lum * 255);
    d[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new CanvasTexture(c);
  t.colorSpace = NoColorSpace;
  t.wrapS = t.wrapT = RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = LinearMipmapLinearFilter;
  t.magFilter = LinearFilter;
  t.needsUpdate = true;
  return t;
}

/**
 * Dirt / grime at the foot of walls and machines, in the fragment shader (world height above the sector floor, only on
 * vertical faces) - cheap "abandoned" cue that needs no extra texture. Reads the `aFloorY` attribute written by stageMesh.
 */
function patchGrime(m: MeshStandardMaterial): void {
  m.onBeforeCompile = (sh) => {
    // surfaces WITHOUT an environment map (concrete, tiles, paint) get a constant ambient lift instead of the IBL diffuse term
    const lift = !m.envMap;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aFloorY;\nvarying float vWY;\nvarying float vFl;\nvarying float vSide;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWY = (modelMatrix * vec4(position, 1.0)).y;\nvFl = aFloorY;\nvSide = 1.0 - abs(normal.y);');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying float vWY;\nvarying float vFl;\nvarying float vSide;${lift ? '\nuniform vec3 uAmbLift;' : ''}`)
      .replace(
        '#include <color_fragment>',
        '#include <color_fragment>\n{ float gh = vWY - vFl; float gk = mix(0.6, 1.0, smoothstep(0.0, 3.4, gh)); diffuseColor.rgb *= mix(1.0, gk, vSide); }',
      );
    if (lift) {
      sh.uniforms.uAmbLift = { value: STAGE_AMBIENT };
      sh.fragmentShader = sh.fragmentShader.replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\nreflectedLight.indirectDiffuse += uAmbLift * material.diffuseColor;');
    }
  };
  m.customProgramCacheKey = () => (m.envMap ? 'stage-g-env' : 'stage-g-amb');
}

/**
 * Colour added as indirect diffuse light on the stage surfaces that have no environment map (see MaterialLibrary.setEnvironment):
 * it stands in for the diffuse part of the IBL. The renderer sets it every frame from the hemisphere light colour (sector look).
 */
export const STAGE_AMBIENT = new Color(0.3, 0.3, 0.3);

/** shared textures + cached materials. One instance per renderer. */
export class MaterialLibrary {
  private textures = new Map<string, Texture>();
  private stageCache = new Map<string, MeshStandardMaterial>();
  private stageKeys = new Map<string, MaterialKey>();
  private anisotropy = 1;
  private env: Texture | null = null;
  private envIntensity = 1;

  setAnisotropy(a: number): void {
    this.anisotropy = a;
    for (const t of this.textures.values()) t.anisotropy = a;
  }

  texture(name: TextureName): Texture {
    let t = this.textures.get(name);
    if (!t) {
      t = makeTexture(SPECS[name]);
      t.anisotropy = this.anisotropy;
      this.textures.set(name, t);
    }
    return t;
  }

  /**
   * Image based lighting for the stage materials, only where it is visible: metals, rust and glass get `envMap`; concrete, tiles,
   * paint and the lamps do not (they are lit by the hemisphere / directional light alone). The scene itself has NO `environment`,
   * so the PBR shader of those non-metal surfaces skips the cube-map lookups (about a third of the frame time on a software GL).
   */
  setEnvironment(env: Texture | null, intensity: number): void {
    this.env = env;
    this.envIntensity = intensity;
    for (const [ck, m] of this.stageCache) this.applyEnv(m, this.stageKeys.get(ck) as MaterialKey);
  }

  private applyEnv(m: MeshStandardMaterial, key: MaterialKey): void {
    const d = STAGE_MATS[key];
    const want = this.env !== null && (d.metalness >= ENV_METALNESS_MIN || key === 'glass');
    const next = want ? this.env : null;
    if (m.envMap !== next) m.needsUpdate = true;
    m.envMap = next;
    m.envMapIntensity = this.envIntensity;
  }

  /** derived roughness / height texture of a stage material (null when it has none or there is no canvas) */
  mrTexture(key: MaterialKey): Texture | null {
    const d = STAGE_MATS[key];
    if (!d.mr) return null;
    const ck = `mr:${d.tex}`;
    const hit = this.textures.get(ck);
    if (hit) return hit;
    const t = deriveMR(this.texture(d.tex), d);
    if (!t) return null;
    t.anisotropy = Math.min(this.anisotropy, 4);
    this.textures.set(ck, t);
    return t;
  }

  /** stage material for a key and a quantized emissive level (0..4). Cached, shared by all chunks. */
  stage(key: MaterialKey, emissiveLevel = 0): MeshStandardMaterial {
    const ck = `${key}|${emissiveLevel}`;
    const hit = this.stageCache.get(ck);
    if (hit) return hit;
    const d = STAGE_MATS[key];
    const map = this.texture(d.tex);
    // barrier/gate/lightPanel glow by default even when the box does not set `emissive`
    const level = Math.max(emissiveLevel, d.glow > 0 && emissiveLevel === 0 ? Math.round(d.glow * 4) : 0);
    const inten = level / 4;
    const mr = this.mrTexture(key);
    const m = new MeshStandardMaterial({
      map,
      vertexColors: true,
      roughness: mr ? 1 : d.roughness,
      metalness: d.metalness,
      color: 0xffffff,
      emissive: level > 0 ? new Color(d.emissiveColor) : new Color(0x000000),
      emissiveMap: level > 0 ? map : null,
      emissiveIntensity: level > 0 ? inten * 1.6 : 0,
    });
    if (mr) {
      m.roughnessMap = mr;
      m.bumpMap = mr;
      m.bumpScale = d.bump * 1.5;
    } else if (d.bump > 0 && hasCanvas()) {
      m.bumpMap = map;
      m.bumpScale = d.bump * 1.5;
    }
    if (!d.transparent && d.glow <= 0) patchGrime(m);
    if (d.transparent) {
      m.transparent = true;
      m.opacity = d.transparent;
      m.depthWrite = false;
      m.side = DoubleSide;
    }
    m.name = `stage:${ck}`;
    this.stageCache.set(ck, m);
    this.stageKeys.set(ck, key);
    this.applyEnv(m, key);
    return m;
  }

  /** clone used for animated (barrier) boxes, so their glow can pulse independently of merged chunks */
  cloneStage(key: MaterialKey, emissiveLevel: number): MeshStandardMaterial {
    return this.stage(key, emissiveLevel).clone();
  }

  /** map used for additive glow / blob shadow etc. */
  glowMap(): Texture {
    return this.texture('glow');
  }

  disposeAll(): void {
    for (const m of this.stageCache.values()) m.dispose();
    for (const t of this.textures.values()) t.dispose();
    this.stageCache.clear();
    this.stageKeys.clear();
    this.textures.clear();
  }

  /** rough GPU size of all textures created so far (RGBA8 + mip chain) [bytes] */
  get textureBytes(): number {
    let n = 0;
    for (const t of this.textures.values()) {
      const im = t.image as { width?: number; height?: number } | undefined;
      if (im && im.width && im.height) n += im.width * im.height * 4 * (t.generateMipmaps ? 1.333 : 1);
    }
    return Math.round(n);
  }
  get materialCount(): number {
    return this.stageCache.size;
  }
  get textureCount(): number {
    return this.textures.size;
  }
}

export { AdditiveBlending };
