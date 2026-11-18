/**
 * マテリアルライブラリ: MaterialKey → MeshStandardMaterial（共有）。
 * 外部アセット禁止のため、質感（錆・汚れ・危険縞・格子）はコードで Canvas に描いたテクスチャで表現する。
 * Canvas が使えない環境（vitest/node）ではテクスチャ無しの色だけのマテリアルになる。
 */
import * as THREE from 'three';
import type { MaterialKey } from '../types';

interface MaterialSpec {
  color: number;
  roughness: number;
  metalness: number;
  emissive?: number;
  emissiveIntensity?: number;
  /** 使用するテクスチャ名（生成できる場合のみ適用） */
  texture?: 'rust' | 'grime' | 'hazard' | 'grate' | 'plate';
  transparent?: boolean;
  opacity?: number;
  side?: THREE.Side;
}

/** 廃工場の色調 */
const MATERIAL_SPECS: Record<MaterialKey, MaterialSpec> = {
  concrete: { color: 0x8c8a82, roughness: 0.95, metalness: 0.0, texture: 'grime' },
  concreteDark: { color: 0x5d5c58, roughness: 0.95, metalness: 0.0, texture: 'grime' },
  floorPlate: { color: 0x6f7378, roughness: 0.8, metalness: 0.2, texture: 'plate' },
  steel: { color: 0x9aa0a6, roughness: 0.6, metalness: 0.3, texture: 'grime' },
  steelDark: { color: 0x5a6066, roughness: 0.65, metalness: 0.25, texture: 'grime' },
  rust: { color: 0x8a4b2a, roughness: 0.9, metalness: 0.3, texture: 'rust' },
  grate: { color: 0x6a6f74, roughness: 0.7, metalness: 0.3, texture: 'grate' },
  catwalk: { color: 0x7d7a6a, roughness: 0.75, metalness: 0.25, texture: 'grate' },
  machine: { color: 0x6b7a5a, roughness: 0.65, metalness: 0.3, texture: 'grime' },
  machineDark: { color: 0x4a5546, roughness: 0.7, metalness: 0.3, texture: 'grime' },
  pipe: { color: 0x8c9aa0, roughness: 0.55, metalness: 0.35 },
  pipeRust: { color: 0x7a4a2e, roughness: 0.85, metalness: 0.4, texture: 'rust' },
  hazard: { color: 0xd9a400, roughness: 0.7, metalness: 0.2, texture: 'hazard' },
  barrier: { color: 0x9a6a1e, roughness: 0.6, metalness: 0.3, texture: 'hazard', emissive: 0x3a1a00, emissiveIntensity: 0.3 },
  gate: { color: 0x5e6a7a, roughness: 0.55, metalness: 0.3, texture: 'hazard', emissive: 0x102030, emissiveIntensity: 0.4 },
  brick: { color: 0x7a4a3a, roughness: 0.95, metalness: 0.0, texture: 'grime' },
  crate: { color: 0x8a7a4a, roughness: 0.9, metalness: 0.1, texture: 'grime' },
  container: { color: 0x3a6a8a, roughness: 0.7, metalness: 0.3, texture: 'rust' },
  glassBroken: { color: 0x9ac0d0, roughness: 0.2, metalness: 0.1, transparent: true, opacity: 0.35, side: THREE.DoubleSide },
  lampRed: { color: 0xff3020, roughness: 0.4, metalness: 0.0, emissive: 0xff2010, emissiveIntensity: 2.0 },
  lampAmber: { color: 0xffa020, roughness: 0.4, metalness: 0.0, emissive: 0xff9010, emissiveIntensity: 2.0 },
  lampGreen: { color: 0x40ff60, roughness: 0.4, metalness: 0.0, emissive: 0x20ff40, emissiveIntensity: 2.0 },
  lampWhite: { color: 0xffffff, roughness: 0.4, metalness: 0.0, emissive: 0xfff4e0, emissiveIntensity: 1.8 },
  controlSign: { color: 0x20e0ff, roughness: 0.4, metalness: 0.0, emissive: 0x10c0ff, emissiveIntensity: 2.2 },
  exitSign: { color: 0x40ff80, roughness: 0.4, metalness: 0.0, emissive: 0x20ff60, emissiveIntensity: 2.2 },
};

/** 各マテリアルの UV タイル幅 [m]（テクスチャ 1 枚がワールドで占める長さ） */
export const TEXTURE_TILE_METERS = 4;

/** Canvas 2D が使えるか（ブラウザーのみ） */
export function canUseCanvas(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const c = document.createElement('canvas');
    return typeof c.getContext === 'function' && c.getContext('2d') !== null;
  } catch {
    return false;
  }
}

/** 視覚効果専用の乱数（ゲーム進行の Rng とは分離） */
export const visualRandom = (): number => Math.random();

function makeCanvas(size: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  if (!canUseCanvas()) return null;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  return { canvas, ctx };
}

function finishTexture(canvas: HTMLCanvasElement, repeat: boolean): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  if (repeat) {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
  }
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/** ノイズ斑点（錆・汚れ）。白ベースに乗算されるので base は明るめ */
function makeNoiseTexture(base: string, spots: string[], count: number, seedScale: number): THREE.CanvasTexture | null {
  const c = makeCanvas(256);
  if (!c) return null;
  const { canvas, ctx } = c;
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < count; i++) {
    const r = 2 + visualRandom() * 14 * seedScale;
    ctx.fillStyle = spots[i % spots.length];
    ctx.globalAlpha = 0.15 + visualRandom() * 0.35;
    ctx.beginPath();
    ctx.ellipse(visualRandom() * 256, visualRandom() * 256, r, r * (0.4 + visualRandom()), visualRandom() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  // 細かい粒子
  ctx.globalAlpha = 0.25;
  for (let i = 0; i < 1800; i++) {
    ctx.fillStyle = visualRandom() < 0.5 ? '#000000' : '#ffffff';
    ctx.fillRect(visualRandom() * 256, visualRandom() * 256, 1, 1);
  }
  ctx.globalAlpha = 1;
  return finishTexture(canvas, true);
}

/** 黄黒の危険縞 */
function makeHazardTexture(): THREE.CanvasTexture | null {
  const c = makeCanvas(256);
  if (!c) return null;
  const { canvas, ctx } = c;
  ctx.fillStyle = '#f0c020';
  ctx.fillRect(0, 0, 256, 256);
  ctx.fillStyle = '#202020';
  const stripe = 32;
  for (let i = -8; i < 16; i++) {
    ctx.beginPath();
    ctx.moveTo(i * stripe * 2, 0);
    ctx.lineTo(i * stripe * 2 + stripe, 0);
    ctx.lineTo(i * stripe * 2 + stripe + 256, 256);
    ctx.lineTo(i * stripe * 2 + 256, 256);
    ctx.closePath();
    ctx.fill();
  }
  // 汚れ
  ctx.globalAlpha = 0.18;
  for (let i = 0; i < 300; i++) {
    ctx.fillStyle = '#000000';
    const r = 2 + visualRandom() * 8;
    ctx.beginPath();
    ctx.arc(visualRandom() * 256, visualRandom() * 256, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  return finishTexture(canvas, true);
}

/** 格子床（キャットウォーク） */
function makeGrateTexture(): THREE.CanvasTexture | null {
  const c = makeCanvas(256);
  if (!c) return null;
  const { canvas, ctx } = c;
  ctx.fillStyle = '#30343a';
  ctx.fillRect(0, 0, 256, 256);
  ctx.strokeStyle = '#b0b6bc';
  ctx.lineWidth = 6;
  const cell = 32;
  for (let i = 0; i <= 256; i += cell) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, 256);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i);
    ctx.lineTo(256, i);
    ctx.stroke();
  }
  return finishTexture(canvas, true);
}

/** 縞鋼板 */
function makePlateTexture(): THREE.CanvasTexture | null {
  const c = makeCanvas(256);
  if (!c) return null;
  const { canvas, ctx } = c;
  ctx.fillStyle = '#c8ccd0';
  ctx.fillRect(0, 0, 256, 256);
  ctx.strokeStyle = '#8a9096';
  ctx.lineWidth = 3;
  for (let y = 0; y < 256; y += 24) {
    for (let x = 0; x < 256; x += 24) {
      const ox = (y / 24) % 2 === 0 ? 0 : 12;
      ctx.beginPath();
      ctx.moveTo(x + ox, y + 4);
      ctx.lineTo(x + ox + 10, y + 14);
      ctx.stroke();
    }
  }
  // 板の継ぎ目
  ctx.strokeStyle = '#50565c';
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, 252, 252);
  ctx.globalAlpha = 0.3;
  for (let i = 0; i < 200; i++) {
    ctx.fillStyle = '#5a3a20';
    const r = 2 + visualRandom() * 10;
    ctx.beginPath();
    ctx.arc(visualRandom() * 256, visualRandom() * 256, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  return finishTexture(canvas, true);
}

/** 文字ラベル用テクスチャ（標識・ラベル装飾） */
export function makeLabelTexture(text: string, color = '#ffe8a0', background = 'rgba(20,20,24,0.85)'): THREE.CanvasTexture | null {
  const c = makeCanvas(256);
  if (!c) return null;
  const { canvas, ctx } = c;
  canvas.width = 512;
  canvas.height = 128;
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, 512, 128);
  ctx.strokeStyle = color;
  ctx.lineWidth = 6;
  ctx.strokeRect(6, 6, 500, 116);
  ctx.fillStyle = color;
  ctx.font = 'bold 56px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let size = 56;
  while (ctx.measureText(text).width > 470 && size > 18) {
    size -= 4;
    ctx.font = `bold ${size}px sans-serif`;
  }
  ctx.fillText(text, 256, 64);
  return finishTexture(canvas, false);
}

export class MaterialLibrary {
  private readonly materials = new Map<MaterialKey, THREE.MeshStandardMaterial>();
  private readonly textures = new Map<string, THREE.CanvasTexture>();
  private texturesBuilt = false;

  /** キーに対応する共有マテリアル（初回に生成） */
  get(key: MaterialKey): THREE.MeshStandardMaterial {
    const existing = this.materials.get(key);
    if (existing) return existing;
    const spec = MATERIAL_SPECS[key] ?? MATERIAL_SPECS.concrete;
    const mat = new THREE.MeshStandardMaterial({
      color: spec.color,
      roughness: spec.roughness,
      metalness: spec.metalness,
      emissive: spec.emissive ?? 0x000000,
      emissiveIntensity: spec.emissiveIntensity ?? 1,
      transparent: spec.transparent ?? false,
      opacity: spec.opacity ?? 1,
      side: spec.side ?? THREE.FrontSide,
    });
    if (spec.texture) {
      const tex = this.texture(spec.texture);
      if (tex) mat.map = tex;
    }
    mat.name = key;
    this.materials.set(key, mat);
    return mat;
  }

  /** テクスチャが適用されているか（試験・診断用） */
  hasTexture(key: MaterialKey): boolean {
    return this.get(key).map !== null;
  }

  private texture(name: NonNullable<MaterialSpec['texture']>): THREE.CanvasTexture | null {
    if (!this.texturesBuilt) {
      this.texturesBuilt = true;
      const add = (k: string, t: THREE.CanvasTexture | null) => {
        if (t) this.textures.set(k, t);
      };
      add('rust', makeNoiseTexture('#e0c8b0', ['#6a2a10', '#a0501e', '#3a1a08', '#c07030'], 320, 1.0));
      add('grime', makeNoiseTexture('#e8e8e4', ['#404040', '#606058', '#808078', '#2a2a2a'], 260, 1.2));
      add('hazard', makeHazardTexture());
      add('grate', makeGrateTexture());
      add('plate', makePlateTexture());
    }
    return this.textures.get(name) ?? null;
  }

  dispose(): void {
    for (const m of this.materials.values()) m.dispose();
    this.materials.clear();
    for (const t of this.textures.values()) t.dispose();
    this.textures.clear();
    this.texturesBuilt = false;
  }
}

/** 機体・敵・効果で共用する簡易マテリアル生成 */
export function standard(color: number, roughness = 0.6, metalness = 0.6, emissive = 0x000000, emissiveIntensity = 1): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness, emissive, emissiveIntensity });
}

export function glow(color: number, opacity = 1, additive = true): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: opacity < 1 || additive,
    opacity,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    depthWrite: false,
  });
}

/** Object3D 配下の全ジオメトリ・マテリアル（共有マテリアルは除外可能）を破棄する */
export function disposeObject(obj: THREE.Object3D, keepMaterials?: Set<THREE.Material>): void {
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    // Sprite のジオメトリは three.js 内部で全 Sprite に共有されるため破棄しない
    if (mesh.geometry && !(o as THREE.Sprite).isSprite) mesh.geometry.dispose();
    const mat = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (!mat) return;
    const list = Array.isArray(mat) ? mat : [mat];
    for (const m of list) {
      if (keepMaterials && keepMaterials.has(m)) continue;
      const withMap = m as THREE.Material & { map?: THREE.Texture | null };
      if (withMap.map) withMap.map.dispose();
      m.dispose();
    }
  });
}
