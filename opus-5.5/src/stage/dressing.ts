// 区画の自動装飾：屋根トラス・壁柱・壁面配管（衝突あり）と、天窓・扉枠・床塗装・汚れ（描画のみ）。
// 開口の周囲は避けて配置し、通路を塞がない。
import type { V3 } from '../math';
import { Rng } from '../rng';
import type { AABB, MatId, PortalDef, PropCylinder, SectorDef } from './types';

export interface DressBox {
  min: V3;
  max: V3;
  mat: MatId;
}

function overlap(a: AABB, b: AABB) {
  return a.min[0] < b.max[0] && a.max[0] > b.min[0] && a.min[1] < b.max[1] && a.max[1] > b.min[1] && a.min[2] < b.max[2] && a.max[2] > b.min[2];
}
const B = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): AABB => ({
  min: [Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1)],
  max: [Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1)],
});

export function dressSectors(sectors: SectorDef[], portals: PortalDef[], noDressZones: AABB[]) {
  const solids: DressBox[] = [];
  const decals: DressBox[] = [];
  const pipes: PropCylinder[] = [];
  const rng = new Rng(4242);

  for (const s of sectors) {
    const W = s.x1 - s.x0;
    const D = s.z1 - s.z0;
    const H = s.ceil - s.floor;
    const mine = portals.filter((p) => p.a === s.id || p.b === s.id);
    const keepOut = mine.map((p) => B(p.box.min[0] - 3, p.box.min[1] - 3, p.box.min[2] - 3, p.box.max[0] + 3, p.box.max[1] + 3, p.box.max[2] + 3));
    const blocked = (b: AABB) => keepOut.some((k) => overlap(b, k)) || noDressZones.some((k) => overlap(b, k));

    // 1) 屋根トラスと天窓
    if (H >= 10) {
      const longX = W >= D;
      const len = longX ? W : D;
      const n = Math.max(1, Math.floor(len / 12));
      const step = len / n;
      const yT = s.ceil - 1.6;
      for (let i = 1; i < n; i++) {
        const c = (longX ? s.x0 : s.z0) + step * i;
        const t = longX ? B(c - 0.35, yT, s.z0, c + 0.35, s.ceil, s.z1) : B(s.x0, yT, c - 0.35, s.x1, s.ceil, c + 0.35);
        if (!blocked(t)) solids.push({ ...t, mat: 'steel' });
      }
      for (let i = 0; i < n; i++) {
        const c = (longX ? s.x0 : s.z0) + step * (i + 0.5);
        const span = longX ? D : W;
        const a = (longX ? s.z0 : s.x0) + span * 0.2;
        const b = (longX ? s.z0 : s.x0) + span * 0.8;
        const sk = longX ? B(c - 1.5, s.ceil - 0.06, a, c + 1.5, s.ceil - 0.005, b) : B(a, s.ceil - 0.06, c - 1.5, b, s.ceil - 0.005, c + 1.5);
        decals.push({ ...sk, mat: 'lightPanel' });
      }
    }

    // 2) 壁柱（壁から0.5m）と 3) 壁面配管
    const walls: { axis: 'x' | 'z'; at: number; dir: 1 | -1; from: number; to: number }[] = [
      { axis: 'x', at: s.x0, dir: 1, from: s.z0, to: s.z1 },
      { axis: 'x', at: s.x1, dir: -1, from: s.z0, to: s.z1 },
      { axis: 'z', at: s.z0, dir: 1, from: s.x0, to: s.x1 },
      { axis: 'z', at: s.z1, dir: -1, from: s.x0, to: s.x1 },
    ];
    for (const w of walls) {
      const L = w.to - w.from;
      const n = Math.floor(L / 16);
      for (let i = 1; i <= n; i++) {
        const c = w.from + (L / (n + 1)) * i;
        const d0 = w.at,
          d1 = w.at + w.dir * 0.5;
        const pl = w.axis === 'x' ? B(d0, s.floor, c - 0.6, d1, s.ceil, c + 0.6) : B(c - 0.6, s.floor, d0, c + 0.6, s.ceil, d1);
        if (!blocked(pl)) solids.push({ ...pl, mat: 'pillar' });
      }
      // 配管（高い部屋の長い壁）
      if (H >= 14 && L >= 60) {
        const y = s.floor + 8 + rng.next() * 2;
        const r = 0.45;
        const off = w.at + w.dir * (0.5 + r);
        let segStart = w.from + 1;
        const flush = (end: number) => {
          const len = end - segStart;
          if (len < 6) return;
          const base: V3 = w.axis === 'x' ? [off, y, segStart] : [segStart, y, off];
          pipes.push({ base, radius: r, height: len, mat: 'pipe', solid: true, axis: w.axis === 'x' ? 'z' : 'x' });
        };
        let t = segStart;
        const stepL = 2;
        let inSeg = true;
        for (t = w.from + 1; t <= w.to - 1; t += stepL) {
          const probe = w.axis === 'x' ? B(off - r, y - r, t - 1, off + r, y + r, t + 1) : B(t - 1, y - r, off - r, t + 1, y + r, off + r);
          const bad = blocked(probe);
          if (bad && inSeg) {
            flush(t - 1);
            inSeg = false;
          } else if (!bad && !inSeg) {
            segStart = t + 1;
            inSeg = true;
          }
        }
        if (inSeg) flush(w.to - 1);
      }
    }

    // 4) 扉枠（警告色、描画のみ）
    for (const p of mine) {
      const b = p.box;
      const dx = b.max[0] - b.min[0],
        dz = b.max[2] - b.min[2],
        dy = b.max[1] - b.min[1];
      if (dy <= 2.01) continue; // 床・天井のハッチ
      const top = Math.min(b.max[1] + 0.8, s.ceil);
      if (dx <= 2.01) {
        const face = Math.abs(b.min[0] - s.x1) < 0.01 ? s.x1 : s.x0;
        const n = face === s.x1 ? -1 : 1;
        const f0 = face,
          f1 = face + n * 0.08;
        decals.push({ ...B(f0, b.min[1], b.min[2] - 0.8, f1, top, b.min[2]), mat: 'hazard' });
        decals.push({ ...B(f0, b.min[1], b.max[2], f1, top, b.max[2] + 0.8), mat: 'hazard' });
        if (top > b.max[1]) decals.push({ ...B(f0, b.max[1], b.min[2], f1, top, b.max[2]), mat: 'hazard' });
      } else if (dz <= 2.01) {
        const face = Math.abs(b.min[2] - s.z1) < 0.01 ? s.z1 : s.z0;
        const n = face === s.z1 ? -1 : 1;
        const f0 = face,
          f1 = face + n * 0.08;
        decals.push({ ...B(b.min[0] - 0.8, b.min[1], f0, b.min[0], top, f1), mat: 'hazard' });
        decals.push({ ...B(b.max[0], b.min[1], f0, b.max[0] + 0.8, top, f1), mat: 'hazard' });
        if (top > b.max[1]) decals.push({ ...B(b.min[0], b.max[1], f0, b.max[0], top, f1), mat: 'hazard' });
      }
    }

    // 5) 床の塗装線と汚れ（描画のみ、厚さ2cm）
    const fy0 = s.floor,
      fy1 = s.floor + 0.02;
    if (W >= 40 && D >= 40) {
      const longX = W >= D;
      for (const f of [0.33, 0.67]) {
        const c = (longX ? s.z0 : s.x0) + (longX ? D : W) * f;
        const a = longX ? s.x0 + 4 : s.z0 + 4;
        const e = longX ? s.x1 - 4 : s.z1 - 4;
        for (let t = a; t < e - 3; t += 7) {
          const seg = longX ? B(t, fy0, c - 0.15, t + 4, fy1, c + 0.15) : B(c - 0.15, fy0, t, c + 0.15, fy1, t + 4);
          decals.push({ ...seg, mat: 'paint' });
        }
      }
    }
    const stains = Math.round((W * D) / 500);
    for (let i = 0; i < stains; i++) {
      const cx = s.x0 + 3 + rng.next() * (W - 6);
      const cz = s.z0 + 3 + rng.next() * (D - 6);
      const k = 2 + Math.floor(rng.next() * 3);
      for (let j = 0; j < k; j++) {
        const w = 1 + rng.next() * 3,
          d = 1 + rng.next() * 3;
        const ox = (rng.next() - 0.5) * 3,
          oz = (rng.next() - 0.5) * 3;
        const y = fy0 + 0.004 + j * 0.002;
        decals.push({ ...B(cx + ox - w / 2, y, cz + oz - d / 2, cx + ox + w / 2, y + 0.012, cz + oz + d / 2), mat: 'stain' });
      }
    }
    // 壁の損傷（暗い剥離片、描画のみ）
    for (const w of walls) {
      const L = w.to - w.from;
      const n = Math.floor(L / 30);
      for (let i = 0; i < n; i++) {
        const c = w.from + 4 + rng.next() * (L - 8);
        const y = s.floor + 2 + rng.next() * Math.max(1, H - 6);
        const ww = 1.5 + rng.next() * 3,
          hh = 1 + rng.next() * 2.5;
        const f0 = w.at + w.dir * 0.005,
          f1 = w.at + w.dir * 0.03;
        const dec = w.axis === 'x' ? B(f0, y, c - ww / 2, f1, y + hh, c + ww / 2) : B(c - ww / 2, y, f0, c + ww / 2, y + hh, f1);
        if (!blocked(dec)) decals.push({ ...dec, mat: 'rust' });
      }
    }
  }
  return { solids, decals, pipes };
}
