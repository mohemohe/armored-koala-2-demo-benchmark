// 実行時にCanvasで生成する手続き的テクスチャ（外部画像は使用しない）。
import * as THREE from 'three';
import { Rng } from '../rng';

const vrng = new Rng(0x5eed1234);

function canvasTex(size: number, draw: (g: CanvasRenderingContext2D, s: number) => void, repeat = true): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  draw(g, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) {
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
  }
  t.anisotropy = 4;
  return t;
}

function noise(g: CanvasRenderingContext2D, s: number, base: number, amp: number, count: number, rmin: number, rmax: number) {
  g.fillStyle = `rgb(${base},${base},${base})`;
  g.fillRect(0, 0, s, s);
  for (let i = 0; i < count; i++) {
    const v = Math.max(0, Math.min(255, base + (vrng.next() - 0.5) * amp * 2));
    g.fillStyle = `rgba(${v},${v},${v},${0.15 + vrng.next() * 0.35})`;
    const r = rmin + vrng.next() * (rmax - rmin);
    g.beginPath();
    g.arc(vrng.next() * s, vrng.next() * s, r, 0, Math.PI * 2);
    g.fill();
  }
}

function stains(g: CanvasRenderingContext2D, s: number, color: string, n: number) {
  for (let i = 0; i < n; i++) {
    const x = vrng.next() * s,
      y = vrng.next() * s,
      r = 10 + vrng.next() * s * 0.25;
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, color);
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
}

export interface TexSet {
  concrete: THREE.Texture;
  panel: THREE.Texture;
  rust: THREE.Texture;
  hazard: THREE.Texture;
  grate: THREE.Texture;
  ribs: THREE.Texture;
  machine: THREE.Texture;
  pipe: THREE.Texture;
  ceiling: THREE.Texture;
  glow: THREE.Texture;
  ring: THREE.Texture;
}

let cache: TexSet | null = null;

export function textures(): TexSet {
  if (cache) return cache;
  const concrete = canvasTex(256, (g, s) => {
    noise(g, s, 158, 16, 1800, 0.5, 2.2);
    stains(g, s, 'rgba(70,60,50,0.16)', 5);
    g.strokeStyle = 'rgba(40,40,40,0.55)';
    g.lineWidth = 2;
    g.strokeRect(0, 0, s, s); // 目地
    g.strokeStyle = 'rgba(30,30,30,0.35)';
    g.lineWidth = 1;
    for (let i = 0; i < 4; i++) {
      g.beginPath();
      let x = vrng.next() * s,
        y = vrng.next() * s;
      g.moveTo(x, y);
      for (let k = 0; k < 6; k++) {
        x += (vrng.next() - 0.5) * 40;
        y += (vrng.next() - 0.5) * 40;
        g.lineTo(x, y);
      }
      g.stroke();
    }
  });
  const panel = canvasTex(256, (g, s) => {
    noise(g, s, 170, 18, 900, 0.5, 3);
    g.strokeStyle = 'rgba(30,34,40,0.55)';
    g.lineWidth = 2;
    for (let i = 0; i <= 2; i++) {
      g.beginPath();
      g.moveTo(0, (i * s) / 2);
      g.lineTo(s, (i * s) / 2);
      g.stroke();
      g.beginPath();
      g.moveTo((i * s) / 2, 0);
      g.lineTo((i * s) / 2, s);
      g.stroke();
    }
    g.fillStyle = 'rgba(40,40,40,0.8)';
    for (let x = 8; x < s; x += s / 2)
      for (let y = 8; y < s; y += s / 2) {
        for (const [dx, dy] of [
          [0, 0],
          [s / 2 - 16, 0],
          [0, s / 2 - 16],
          [s / 2 - 16, s / 2 - 16],
        ]) {
          g.beginPath();
          g.arc(x + dx, y + dy, 2.5, 0, Math.PI * 2);
          g.fill();
        }
      }
    // 錆だれ
    for (let i = 0; i < 10; i++) {
      const x = vrng.next() * s;
      const y = vrng.next() * s * 0.6;
      const grd = g.createLinearGradient(x, y, x, y + 60 + vrng.next() * 80);
      grd.addColorStop(0, 'rgba(110,60,30,0.45)');
      grd.addColorStop(1, 'rgba(110,60,30,0)');
      g.fillStyle = grd;
      g.fillRect(x, y, 3 + vrng.next() * 6, 140);
    }
  });
  const rust = canvasTex(256, (g, s) => {
    g.fillStyle = '#7a4a2c';
    g.fillRect(0, 0, s, s);
    for (let i = 0; i < 1400; i++) {
      const r = 90 + vrng.next() * 90,
        gg = 45 + vrng.next() * 50,
        b = 20 + vrng.next() * 30;
      g.fillStyle = `rgba(${r | 0},${gg | 0},${b | 0},${0.2 + vrng.next() * 0.4})`;
      g.fillRect(vrng.next() * s, vrng.next() * s, 2 + vrng.next() * 6, 2 + vrng.next() * 6);
    }
    stains(g, s, 'rgba(30,20,15,0.4)', 8);
  });
  const hazard = canvasTex(128, (g, s) => {
    g.fillStyle = '#e8b400';
    g.fillRect(0, 0, s, s);
    g.fillStyle = '#161616';
    for (let i = -s; i < s * 2; i += 32) {
      g.beginPath();
      g.moveTo(i, 0);
      g.lineTo(i + 16, 0);
      g.lineTo(i + 16 - s, s);
      g.lineTo(i - s, s);
      g.closePath();
      g.fill();
    }
    for (let i = 0; i < 200; i++) {
      g.fillStyle = `rgba(60,50,30,${vrng.next() * 0.3})`;
      g.fillRect(vrng.next() * s, vrng.next() * s, 3, 3);
    }
  });
  const grate = canvasTex(128, (g, s) => {
    g.fillStyle = '#3a3e44';
    g.fillRect(0, 0, s, s);
    g.strokeStyle = '#7d858f';
    g.lineWidth = 3;
    for (let i = 0; i <= s; i += 16) {
      g.beginPath();
      g.moveTo(i, 0);
      g.lineTo(i, s);
      g.stroke();
      g.beginPath();
      g.moveTo(0, i);
      g.lineTo(s, i);
      g.stroke();
    }
  });
  const ribs = canvasTex(128, (g, s) => {
    for (let x = 0; x < s; x += 16) {
      const grd = g.createLinearGradient(x, 0, x + 16, 0);
      grd.addColorStop(0, '#9a9a9a');
      grd.addColorStop(0.5, '#e6e6e6');
      grd.addColorStop(1, '#8a8a8a');
      g.fillStyle = grd;
      g.fillRect(x, 0, 16, s);
    }
    for (let i = 0; i < 160; i++) {
      g.fillStyle = `rgba(90,50,25,${vrng.next() * 0.35})`;
      g.fillRect(vrng.next() * s, vrng.next() * s, 2 + vrng.next() * 5, 2 + vrng.next() * 10);
    }
  });
  const machine = canvasTex(256, (g, s) => {
    noise(g, s, 170, 20, 500, 1, 3);
    g.strokeStyle = 'rgba(25,25,25,0.7)';
    g.lineWidth = 3;
    g.strokeRect(6, 6, s - 12, s - 12);
    g.strokeRect(s * 0.1, s * 0.55, s * 0.35, s * 0.35);
    g.fillStyle = 'rgba(20,20,20,0.7)';
    for (let y = s * 0.12; y < s * 0.45; y += 10) g.fillRect(s * 0.55, y, s * 0.35, 4); // 通気口
    g.fillStyle = 'rgba(230,180,20,0.9)';
    g.fillRect(s * 0.1, s * 0.12, s * 0.3, 10);
    stains(g, s, 'rgba(50,35,20,0.35)', 5);
  });
  const pipe = canvasTex(128, (g, s) => {
    const grd = g.createLinearGradient(0, 0, 0, s);
    grd.addColorStop(0, '#555');
    grd.addColorStop(0.5, '#c8c8c8');
    grd.addColorStop(1, '#4a4a4a');
    g.fillStyle = grd;
    g.fillRect(0, 0, s, s);
    g.fillStyle = 'rgba(20,20,20,0.6)';
    for (let x = 0; x < s; x += 64) g.fillRect(x, 0, 6, s);
    for (let i = 0; i < 80; i++) {
      g.fillStyle = `rgba(110,60,30,${vrng.next() * 0.4})`;
      g.fillRect(vrng.next() * s, vrng.next() * s, 4, 4);
    }
  });
  const ceiling = canvasTex(256, (g, s) => {
    noise(g, s, 150, 14, 500, 1, 3);
    g.strokeStyle = 'rgba(40,44,50,0.6)';
    g.lineWidth = 6;
    for (let i = 0; i <= s; i += s / 4) {
      g.beginPath();
      g.moveTo(i, 0);
      g.lineTo(i, s);
      g.stroke();
    }
    g.lineWidth = 2;
    for (let i = 0; i < s; i += s / 8) {
      g.beginPath();
      g.moveTo(0, i);
      g.lineTo(s, i + s / 8);
      g.stroke();
    }
  });
  const glow = canvasTex(
    64,
    (g, s) => {
      const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
      grd.addColorStop(0, 'rgba(255,255,255,1)');
      grd.addColorStop(0.25, 'rgba(255,255,255,0.7)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd;
      g.fillRect(0, 0, s, s);
    },
    false,
  );
  const ring = canvasTex(
    64,
    (g, s) => {
      g.strokeStyle = 'rgba(255,255,255,1)';
      g.lineWidth = 5;
      g.beginPath();
      g.arc(s / 2, s / 2, s / 2 - 5, 0, Math.PI * 2);
      g.stroke();
    },
    false,
  );
  cache = { concrete, panel, rust, hazard, grate, ribs, machine, pipe, ceiling, glow, ring };
  return cache;
}

/** 区画名などの看板テクスチャ */
export function signTexture(text: string, sub: string | undefined, color: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 148;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(12,14,18,0.92)';
  g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = color;
  g.lineWidth = 6;
  g.strokeRect(5, 5, c.width - 10, c.height - 10);
  g.fillStyle = color;
  g.fillRect(5, 5, 22, c.height - 10);
  g.fillStyle = '#f2f2f2';
  g.font = 'bold 54px "Hiragino Sans","Yu Gothic","Noto Sans JP",sans-serif';
  g.textBaseline = 'middle';
  g.fillText(text, 44, sub ? 58 : 74, c.width - 60);
  if (sub) {
    g.fillStyle = color;
    g.font = 'bold 30px "Consolas","Menlo",monospace';
    g.fillText(sub, 46, 114, c.width - 60);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
