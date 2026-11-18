import * as THREE from 'three';

/**
 * Procedural textures for the factory.  Everything is generated with the 2D
 * canvas API at runtime - no external image files are fetched.
 */

function noise(ctx: CanvasRenderingContext2D, w: number, h: number, amount: number, alpha: number): void {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * amount;
    d[i] = Math.max(0, Math.min(255, d[i] + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
    d[i + 3] = Math.max(0, Math.min(255, d[i + 3] * alpha + 255 * (1 - alpha)));
  }
  ctx.putImageData(img, 0, 0);
}

let floorTex: THREE.Texture | null = null;
let wallTex: THREE.Texture | null = null;

export function factoryFloorTexture(): THREE.Texture {
  if (floorTex) return floorTex;
  const s = 256;
  const c = document.createElement('canvas');
  c.width = s;
  c.height = s;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#6a7079';
  ctx.fillRect(0, 0, s, s);
  // plate seams
  ctx.strokeStyle = 'rgba(30,34,40,0.85)';
  ctx.lineWidth = 4;
  for (let i = 0; i <= 4; i++) {
    ctx.beginPath();
    ctx.moveTo((i * s) / 4, 0);
    ctx.lineTo((i * s) / 4, s);
    ctx.moveTo(0, (i * s) / 4);
    ctx.lineTo(s, (i * s) / 4);
    ctx.stroke();
  }
  // grating slots
  ctx.fillStyle = 'rgba(26,30,36,0.55)';
  for (let x = 8; x < s; x += 16) {
    for (let y = 8; y < s; y += 10) {
      ctx.fillRect(x, y, 9, 4);
    }
  }
  // bolts
  ctx.fillStyle = 'rgba(180,190,200,0.45)';
  for (let i = 0; i <= 4; i++) {
    for (let j = 0; j <= 4; j++) {
      ctx.beginPath();
      ctx.arc((i * s) / 4, (j * s) / 4, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // rust stains
  ctx.fillStyle = 'rgba(120,78,40,0.16)';
  for (let i = 0; i < 26; i++) {
    const x = Math.random() * s;
    const y = Math.random() * s;
    const r = 6 + Math.random() * 26;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  noise(ctx, s, s, 26, 1);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, 1);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  floorTex = tex;
  return tex;
}

export function factoryWallTexture(): THREE.Texture {
  if (wallTex) return wallTex;
  const s = 256;
  const c = document.createElement('canvas');
  c.width = s;
  c.height = s;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#7b828b';
  ctx.fillRect(0, 0, s, s);
  // horizontal panel bands
  for (let y = 0; y < s; y += 64) {
    ctx.fillStyle = y % 128 === 0 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.06)';
    ctx.fillRect(0, y, s, 64);
    ctx.strokeStyle = 'rgba(25,28,33,0.8)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(s, y);
    ctx.stroke();
    // rivets
    ctx.fillStyle = 'rgba(190,200,210,0.4)';
    for (let x = 12; x < s; x += 32) {
      ctx.beginPath();
      ctx.arc(x, y + 8, 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // vertical seams
  ctx.strokeStyle = 'rgba(30,34,40,0.5)';
  ctx.lineWidth = 2;
  for (let x = 0; x < s; x += 128) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, s);
    ctx.stroke();
  }
  // grime
  ctx.fillStyle = 'rgba(90,60,30,0.13)';
  for (let i = 0; i < 18; i++) {
    const x = Math.random() * s;
    const y = Math.random() * s;
    ctx.fillRect(x, y, 3 + Math.random() * 8, 20 + Math.random() * 70);
  }
  noise(ctx, s, s, 22, 1);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  wallTex = tex;
  return tex;
}

/** A caution stripe texture used for the barrier doors and hazard markings. */
export function hazardTexture(): THREE.Texture {
  const s = 128;
  const c = document.createElement('canvas');
  c.width = s;
  c.height = s;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#1b1d20';
  ctx.fillRect(0, 0, s, s);
  ctx.strokeStyle = '#ffb02a';
  ctx.lineWidth = 18;
  for (let i = -s; i < s * 2; i += 42) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + s, s);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
