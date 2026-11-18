/**
 * ステージメッシュ: StageData の solids/decor/lights/barriers/gate からメッシュを生成する。
 * 静的な直方体・円柱はマテリアルごとに BufferGeometryUtils.mergeGeometries で 1 メッシュへ結合する。
 * 隔壁・ゲートは個別メッシュで、開放時に床へ沈む。
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { AABB, DecorDef, MaterialKey, StageData } from '../types';
import { MaterialLibrary, TEXTURE_TILE_METERS, disposeObject, makeLabelTexture, standard } from './materials';

/**
 * 隔壁・ゲートが床へ沈み切るまでの時間 [s]（視覚のみ）。
 * sim は開放イベントと同時に衝突を外すため、見た目もすぐ通れると分かるよう短くし、
 * 開放した瞬間から半透明にして「実体がない」ことを示す。
 */
export const BARRIER_OPEN_SECONDS = 0.35;
/** 開放中の扉の不透明度 */
export const DOOR_OPENING_OPACITY = 0.4;
/** PointLight の上限（Hemisphere + Directional を除く） */
export const MAX_POINT_LIGHTS = 10;
/** ランプに PointLight を付けるのは合計がこの数以下のときだけ */
export const LAMP_LIGHT_BUDGET = 8;
/** LightDef.intensity → PointLight(candela) の換算係数（物理ベース照明のため） */
export const POINT_LIGHT_SCALE = 30;

interface SlidingDoor {
  mesh: THREE.Mesh;
  /** 扉ごとの複製マテリアル（開放中は半透明にするため共有しない。map はライブラリと共有） */
  material: THREE.MeshStandardMaterial;
  /** 閉鎖時の発光強度（ライブラリ値） */
  closedEmissive: number;
  closedY: number;
  height: number;
  open: boolean;
  /** 0=閉、1=開 */
  progress: number;
}

function boxSize(b: AABB): [number, number, number] {
  return [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
}

function boxCenter(b: AABB): [number, number, number] {
  return [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
}

/** AABB からワールド配置済みの BoxGeometry（UV はワールド寸法でタイル） */
function boxGeometryFor(b: AABB): THREE.BufferGeometry {
  const [w, h, d] = boxSize(b);
  const [cx, cy, cz] = boxCenter(b);
  const g = new THREE.BoxGeometry(Math.max(0.01, w), Math.max(0.01, h), Math.max(0.01, d));
  // BoxGeometry の面順: +x, −x, +y, −y, +z, −z（各 4 頂点）
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  const faceDims: [number, number][] = [
    [d, h],
    [d, h],
    [w, d],
    [w, d],
    [w, h],
    [w, h],
  ];
  for (let f = 0; f < 6; f++) {
    const [du, dv] = faceDims[f];
    for (let v = 0; v < 4; v++) {
      const i = f * 4 + v;
      uv.setXY(i, (uv.getX(i) * du) / TEXTURE_TILE_METERS, (uv.getY(i) * dv) / TEXTURE_TILE_METERS);
    }
  }
  uv.needsUpdate = true;
  g.translate(cx, cy, cz);
  return g;
}

function cylinderGeometryFor(d: DecorDef): THREE.BufferGeometry | null {
  if (!d.position) return null;
  const r = d.radius ?? 0.5;
  const h = d.height ?? 1;
  const g = new THREE.CylinderGeometry(r, r, h, 12);
  const axis = d.axis ?? 'y';
  if (axis === 'x') g.rotateZ(Math.PI / 2);
  else if (axis === 'z') g.rotateX(Math.PI / 2);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  const circ = Math.PI * 2 * r;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) * circ) / TEXTURE_TILE_METERS, (uv.getY(i) * h) / TEXTURE_TILE_METERS);
  uv.needsUpdate = true;
  g.translate(d.position[0], d.position[1], d.position[2]);
  return g;
}

/** 平らな矢印（山形）: 2 本の細い板を V 字に合わせ、先端を −Z（forwardFromYaw の向き）へ */
function arrowGeometryFor(d: DecorDef): THREE.BufferGeometry | null {
  if (!d.position) return null;
  const parts: THREE.BufferGeometry[] = [];
  for (const s of [-1, 1]) {
    const g = new THREE.BoxGeometry(0.9, 0.06, 0.28);
    // 原点（先端）から +X へ伸びる板を、後方（+Z）斜め左右へ回す: rotateY(a) で +X → (cos a, 0, −sin a)
    g.translate(0.45, 0, 0);
    g.rotateY(s < 0 ? -Math.PI / 4 : (-3 * Math.PI) / 4);
    // 先端が z=−0.32 になるよう移動（山形の中心を原点付近に）
    g.translate(0, 0, -0.32);
    parts.push(g);
  }
  const merged = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  if (!merged) return null;
  merged.rotateY(d.yaw ?? 0);
  merged.translate(d.position[0], d.position[1] + 0.04, d.position[2]);
  return merged;
}

export class StageMeshes {
  readonly root = new THREE.Group();
  readonly data: StageData;
  private readonly materials: MaterialLibrary;
  private readonly barriers = new Map<string, SlidingDoor>();
  private gate: SlidingDoor | null = null;
  private readonly customMaterials = new Map<string, THREE.MeshStandardMaterial>();
  private readonly ownedMaterials: THREE.Material[] = [];
  private readonly ownedTextures: THREE.Texture[] = [];
  /** 診断用: 結合後の静的メッシュ数と PointLight 数 */
  staticMeshCount = 0;
  pointLightCount = 0;
  labelCount = 0;

  constructor(data: StageData, materials: MaterialLibrary) {
    this.data = data;
    this.materials = materials;
    this.root.name = 'stage:' + data.id;
    this.build();
  }

  private emissiveMaterial(key: MaterialKey | undefined, emissive: number | undefined): THREE.MeshStandardMaterial {
    if (emissive !== undefined) {
      const k = 'custom:' + emissive.toString(16);
      let m = this.customMaterials.get(k);
      if (!m) {
        m = standard(emissive, 0.5, 0.0, emissive, 2.0);
        this.customMaterials.set(k, m);
        this.ownedMaterials.push(m);
      }
      return m;
    }
    return this.materials.get(key ?? 'lampAmber');
  }

  private build(): void {
    const data = this.data;
    const groups = new Map<THREE.Material, THREE.BufferGeometry[]>();
    const push = (mat: THREE.Material, g: THREE.BufferGeometry | null) => {
      if (!g) return;
      let list = groups.get(mat);
      if (!list) {
        list = [];
        groups.set(mat, list);
      }
      list.push(g);
    };
    // 衝突ありの直方体
    for (const s of data.solids) push(this.materials.get(s.material), boxGeometryFor(s.box));

    // 照明予算: LightDef を優先
    let lightsUsed = 0;
    for (const l of data.lights) {
      if (lightsUsed >= MAX_POINT_LIGHTS) break;
      const pl = new THREE.PointLight(l.color, l.intensity * POINT_LIGHT_SCALE, l.distance, 2);
      pl.position.set(l.position[0], l.position[1], l.position[2]);
      this.root.add(pl);
      lightsUsed++;
    }

    // 装飾
    for (const d of data.decor) {
      switch (d.kind) {
        case 'box':
          if (d.box) push(d.emissive !== undefined ? this.emissiveMaterial(d.material, d.emissive) : this.materials.get(d.material ?? 'steelDark'), boxGeometryFor(d.box));
          break;
        case 'cylinder':
          push(d.emissive !== undefined ? this.emissiveMaterial(d.material, d.emissive) : this.materials.get(d.material ?? 'pipe'), cylinderGeometryFor(d));
          break;
        case 'lamp': {
          if (!d.position) break;
          const mat = this.emissiveMaterial(d.material, d.emissive);
          const g = new THREE.SphereGeometry(d.radius ?? 0.18, 10, 8);
          g.translate(d.position[0], d.position[1], d.position[2]);
          push(mat, g);
          // 取り付け金具
          const bracket = new THREE.BoxGeometry(0.3, 0.08, 0.3);
          bracket.translate(d.position[0], d.position[1] + (d.radius ?? 0.18) + 0.04, d.position[2]);
          push(this.materials.get('steelDark'), bracket);
          if (lightsUsed < LAMP_LIGHT_BUDGET) {
            const color = d.emissive ?? mat.emissive.getHex();
            const pl = new THREE.PointLight(color, 12, 14, 2);
            pl.position.set(d.position[0], d.position[1] - 0.2, d.position[2]);
            this.root.add(pl);
            lightsUsed++;
          }
          break;
        }
        case 'arrow':
          push(this.emissiveMaterial(d.material ?? 'lampAmber', d.emissive), arrowGeometryFor(d));
          break;
        case 'label':
          this.addLabel(d);
          break;
        default:
          break;
      }
    }
    this.pointLightCount = lightsUsed;

    // マテリアルごとに結合
    for (const [mat, list] of groups) {
      if (list.length === 0) continue;
      const merged = mergeGeometries(list);
      for (const g of list) g.dispose();
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, mat);
      mesh.name = 'static:' + (mat.name || 'material');
      mesh.matrixAutoUpdate = false;
      this.root.add(mesh);
      this.staticMeshCount++;
    }

    // 隔壁・ゲート（個別）
    for (const b of data.barriers) {
      const door = this.makeDoor(b.box, this.materials.get('barrier'), 'barrier:' + b.id);
      this.barriers.set(b.id, door);
    }
    this.gate = this.makeDoor(data.gate.box, this.materials.get('gate'), 'gate:' + data.gate.id);
  }

  private makeDoor(box: AABB, libraryMat: THREE.MeshStandardMaterial, name: string): SlidingDoor {
    const [w, h, d] = boxSize(box);
    const [cx, cy, cz] = boxCenter(box);
    const g = new THREE.BoxGeometry(Math.max(0.01, w), Math.max(0.01, h), Math.max(0.01, d));
    const uv = g.getAttribute('uv') as THREE.BufferAttribute;
    const dims: [number, number][] = [
      [d, h],
      [d, h],
      [w, d],
      [w, d],
      [w, h],
      [w, h],
    ];
    for (let f = 0; f < 6; f++) {
      for (let v = 0; v < 4; v++) {
        const i = f * 4 + v;
        uv.setXY(i, (uv.getX(i) * dims[f][0]) / TEXTURE_TILE_METERS, (uv.getY(i) * dims[f][1]) / TEXTURE_TILE_METERS);
      }
    }
    const mat = libraryMat.clone();
    mat.name = libraryMat.name;
    this.ownedMaterials.push(mat);
    const mesh = new THREE.Mesh(g, mat);
    mesh.position.set(cx, cy, cz);
    mesh.name = name;
    this.root.add(mesh);
    return { mesh, material: mat, closedEmissive: libraryMat.emissiveIntensity, closedY: cy, height: h, open: false, progress: 0 };
  }

  private addLabel(d: DecorDef): void {
    if (!d.position || !d.text) return;
    const tex = makeLabelTexture(d.text);
    if (tex) {
      this.ownedTextures.push(tex);
      const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
      this.ownedMaterials.push(mat);
      const sprite = new THREE.Sprite(mat);
      sprite.scale.set(4, 1, 1);
      sprite.position.set(d.position[0], d.position[1], d.position[2]);
      sprite.name = 'label:' + d.text;
      this.root.add(sprite);
    } else {
      // Canvas が無い環境: 発光板で代用
      const mat = this.emissiveMaterial(d.material ?? 'lampWhite', d.emissive);
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(4, 1), mat);
      plane.position.set(d.position[0], d.position[1], d.position[2]);
      plane.rotation.y = d.yaw ?? 0;
      plane.name = 'label:' + d.text;
      this.root.add(plane);
    }
    this.labelCount++;
  }

  setBarrierOpen(id: string, open: boolean): void {
    const door = this.barriers.get(id);
    if (!door) return;
    this.setDoor(door, open);
  }

  setGateOpen(open: boolean): void {
    if (this.gate) this.setDoor(this.gate, open);
  }

  private setDoor(door: SlidingDoor, open: boolean): void {
    if (door.open === open) return;
    door.open = open;
    const mat = door.material;
    if (open) {
      // 開放した瞬間から半透明＋発光（衝突は sim 側で既に無い）
      mat.transparent = true;
      mat.opacity = DOOR_OPENING_OPACITY;
      mat.depthWrite = false;
      mat.emissiveIntensity = 1.5;
      mat.needsUpdate = true;
    } else {
      // 閉鎖は即時（再出撃時の初期化）
      door.progress = 0;
      mat.transparent = false;
      mat.opacity = 1;
      mat.depthWrite = true;
      mat.emissiveIntensity = door.closedEmissive;
      mat.needsUpdate = true;
      this.applyDoor(door);
    }
  }

  private applyDoor(door: SlidingDoor): void {
    const t = door.progress;
    // 立ち上がりの速いイーズアウト: 開放直後から大きく沈む
    const eased = 1 - (1 - t) * (1 - t);
    door.mesh.position.y = door.closedY - eased * (door.height + 0.1);
    door.mesh.visible = t < 1;
  }

  isBarrierOpen(id: string): boolean {
    return this.barriers.get(id)?.open ?? false;
  }

  /** 開閉アニメーションを進める */
  update(dt: number): void {
    const step = dt / BARRIER_OPEN_SECONDS;
    for (const door of this.barriers.values()) this.animateDoor(door, step);
    if (this.gate) this.animateDoor(this.gate, step);
  }

  private animateDoor(door: SlidingDoor, step: number): void {
    if (door.open && door.progress < 1) {
      door.progress = Math.min(1, door.progress + step);
      this.applyDoor(door);
    }
  }

  /** 隔壁の中心とサイズ（効果の発生位置用） */
  barrierBox(id: string): AABB | null {
    const b = this.data.barriers.find((x) => x.id === id);
    return b ? b.box : null;
  }

  dispose(): void {
    // マテリアルは disposeObject に破棄させない: ライブラリの共有品はライブラリが破棄し、
    // 自前のもの（扉の複製・発光・標識）は map をライブラリ/自前テクスチャと共有するため下で material.dispose() だけ行う
    const keep = new Set<THREE.Material>();
    this.root.traverse((o) => {
      const mat = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (mat) keep.add(mat);
    });
    disposeObject(this.root, keep);
    for (const m of this.ownedMaterials) m.dispose();
    for (const t of this.ownedTextures) t.dispose();
    this.ownedMaterials.length = 0;
    this.ownedTextures.length = 0;
    this.customMaterials.clear();
    this.barriers.clear();
    this.gate = null;
    this.root.removeFromParent();
    this.root.clear();
  }
}
