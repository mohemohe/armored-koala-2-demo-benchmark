/**
 * Per-sector colour temperature (区画ごとの色味の識別). Purely visual: a vertex-colour multiplier for the sector's static
 * geometry plus a small ambient / fog shift that the renderer blends toward while the camera is inside the sector.
 * Kept subtle on purpose - corridor / catwalk edges and enemies must stay the most readable things on screen.
 */
import type { SectorDef } from '../sim/types';
import { hash01, type RGB } from './geo';

export interface SectorLook {
  /** linear multiplier on the sector's static geometry */
  tint: RGB;
  /** fog / horizon colour (dusty air) */
  fog: number;
  /** hemisphere light sky / ground colours */
  hemiSky: number;
  hemiGround: number;
  /** directional light colour */
  sun: number;
}

const BASE: Record<string, SectorLook> = {
  // warm sodium-lit loading dock
  dock: { tint: [1.06, 1.0, 0.88], fog: 0x3d362d, hemiSky: 0xb9b3a4, hemiGround: 0x45392b, sun: 0xffe6c4 },
  // open yard: dusty daylight leaking through the roof
  yard: { tint: [1.03, 1.0, 0.93], fog: 0x3c3d3d, hemiSky: 0xa9b6c4, hemiGround: 0x41382e, sun: 0xfff0d8 },
  // rolling mill / assembly: neutral, slightly warm
  factory: { tint: [1.03, 1.0, 0.94], fog: 0x393632, hemiSky: 0xa9b2bc, hemiGround: 0x40372c, sun: 0xffeed8 },
  // multi level halls: cooler teal
  multilevel: { tint: [0.95, 1.01, 1.04], fog: 0x2f3a3f, hemiSky: 0x9dbac8, hemiGround: 0x363a36, sun: 0xe4f0ff },
  // service corridors: greenish fluorescent
  corridor: { tint: [0.94, 1.03, 0.98], fog: 0x2e3a35, hemiSky: 0xa4bcb0, hemiGround: 0x363c30, sun: 0xeaf6e4 },
  // vertical shafts: cold blue-grey
  shaft: { tint: [0.93, 0.99, 1.05], fog: 0x2b3542, hemiSky: 0x94aacc, hemiGround: 0x323640, sun: 0xdae6ff },
  // pipe rooms: hot amber steam
  pipe: { tint: [1.06, 0.98, 0.88], fog: 0x40362c, hemiSky: 0xb8ae9c, hemiGround: 0x4a3626, sun: 0xffddb0 },
  // warehouse: rusty orange dust
  warehouse: { tint: [1.07, 0.98, 0.87], fog: 0x40352b, hemiSky: 0xb6aa98, hemiGround: 0x4a3a2a, sun: 0xffe0b8 },
  // shipping gate: a hint of alarm red
  gate: { tint: [1.05, 0.95, 0.93], fog: 0x3c3232, hemiSky: 0xb4a8a8, hemiGround: 0x44342e, sun: 0xffe2d4 },
};
const FALLBACK: SectorLook = BASE.factory;

/** stable per-sector look (kind palette + a small hash based variation so neighbouring sectors of one kind differ a little) */
export function sectorLook(s: Pick<SectorDef, 'id' | 'kind'>): SectorLook {
  const b = BASE[s.kind] ?? FALLBACK;
  const h = hash01(`look:${s.id}`);
  const k = 0.97 + 0.06 * h; // +-3 % on each channel
  const k2 = 0.97 + 0.06 * hash01(`look2:${s.id}`);
  return { ...b, tint: [b.tint[0] * k, b.tint[1], b.tint[2] * k2] };
}

/** materials whose colour is the message (lights, warning stripes, barriers, glass) are never tinted */
export const UNTINTED_MATS: ReadonlySet<string> = new Set(['lightPanel', 'hazard', 'barrier', 'gate', 'glass']);

/** interpolate hex colours in place (r,g,b 0..255 arithmetic; used for fog / ambient cross fades) */
export function lerpHex(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255;
  const ag = (a >> 8) & 255;
  const ab = a & 255;
  const br = (b >> 16) & 255;
  const bg = (b >> 8) & 255;
  const bb = b & 255;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}
