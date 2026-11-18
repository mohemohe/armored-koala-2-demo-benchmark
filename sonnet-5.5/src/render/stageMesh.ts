/**
 * Static stage geometry: StageDef.boxes / decor -> per (material, spatial chunk) merged meshes.
 * UVs are world-space / tile size so textures stay continuous across neighbouring boxes.
 * Barrier boxes (BoxDef.barrierId) are NOT merged: they are separate meshes that the renderer animates.
 */
import { BufferGeometry, Color, Group, Matrix4, Mesh, MeshStandardMaterial, Vector3 } from 'three';
import type { BoxDef, MaterialKey, StageDef } from '../sim/types';
import { GeoBuilder, hash01, rotX, rotZ, type RGB } from './geo';
import { UNTINTED_MATS, sectorLook } from './look';
import { MaterialLibrary, STAGE_MATS } from './textures';
import { sectorContains } from './visibility';

/**
 * Merge granularity: boxes of one (sector, material, emissive level) group are merged into ONE mesh; a group with more than
 * `CHUNK_BOXES` boxes is split by a kd-tree on the box centres (median split along the longest axis) so that the GPU frustum
 * test can still throw away the parts of a big sector that are behind the camera.
 */
export const CHUNK_BOXES = 90;
/** a group is not split below this extent of the box centres [m] */
export const CHUNK_MIN_SPAN = 10;

export interface StageMeshOptions {
  /** max boxes merged into one draw call before the group is split spatially (default CHUNK_BOXES) */
  chunkBoxes?: number;
  /** deprecated (dev viewer): a spatial cell size; converted to a box budget so old callers keep working */
  chunkXZ?: number;
  chunkY?: number;
}

const CRATE_TINTS: RGB[] = [
  [1.0, 0.62, 0.4],
  [0.45, 0.6, 0.9],
  [0.5, 0.75, 0.5],
  [0.9, 0.38, 0.34],
  [0.95, 0.85, 0.5],
  [0.8, 0.8, 0.82],
];
const PIPE_TINTS: RGB[] = [
  [1, 1, 1],
  [0.65, 0.9, 0.7],
  [0.95, 0.6, 0.5],
  [1, 0.92, 0.55],
  [0.6, 0.75, 0.95],
];

export function boxTint(b: BoxDef): RGB {
  const h = hash01(b.id);
  if (b.mat === 'crate') return CRATE_TINTS[Math.floor(h * CRATE_TINTS.length) % CRATE_TINTS.length];
  if (b.mat === 'pipe') return PIPE_TINTS[Math.floor(h * PIPE_TINTS.length) % PIPE_TINTS.length];
  const v = 0.85 + 0.25 * h;
  return [v, v, v * (0.97 + 0.06 * hash01(b.id + 'x'))];
}

export function emissiveLevelOf(b: BoxDef): number {
  const e = b.emissive ?? 0;
  if (e <= 0) return 0;
  return Math.max(1, Math.min(4, Math.round(e * 4)));
}

/** append one BoxDef into a builder (box or cylinder shape) */
export function appendBox(gb: GeoBuilder, b: BoxDef, tile: number, color: RGB): void {
  const shape = b.shape ?? 'box';
  if (shape === 'box') {
    gb.addBox(b.min, b.max, { tile, color });
    return;
  }
  const cx = (b.min.x + b.max.x) / 2;
  const cy = (b.min.y + b.max.y) / 2;
  const cz = (b.min.z + b.max.z) / 2;
  const sx = b.max.x - b.min.x;
  const sy = b.max.y - b.min.y;
  const sz = b.max.z - b.min.z;
  let m: Matrix4;
  let r1: number;
  let r2: number;
  let len: number;
  if (shape === 'cylY') {
    r1 = sx / 2;
    r2 = sz / 2;
    len = sy;
    m = new Matrix4().makeScale(r1, len, r2);
  } else if (shape === 'cylX') {
    r1 = sy / 2;
    r2 = sz / 2;
    len = sx;
    m = new Matrix4().makeScale(r1, len, r2).premultiply(rotZ(Math.PI / 2));
  } else {
    r1 = sx / 2;
    r2 = sy / 2;
    len = sz;
    m = new Matrix4().makeScale(r1, len, r2).premultiply(rotX(Math.PI / 2));
  }
  m.setPosition(cx, cy, cz);
  const circ = Math.PI * (r1 + r2);
  const seg = Math.max(8, Math.min(20, Math.round(circ * 1.6)));
  // unit cylinder (radius 1, height 1) so that scale gives the real size
  gb.addCylinder(new Vector3(0, 0, 0), 1, 1, 1, color, seg, m, [circ / tile, len / tile]);
}

export interface BarrierBoxVisual {
  boxIndex: number;
  box: BoxDef;
  barrierId: string;
  mesh: Mesh;
  material: MeshStandardMaterial;
  baseEmissive: number;
  /** 0 = closed, 1 = fully open (mesh hidden) */
  open: number;
  opening: boolean;
  center: Vector3;
  size: Vector3;
}

export interface LightCandidate {
  pos: Vector3;
  color: number;
  power: number;
  /** index into stage.sectors (-1 = unknown) */
  sector: number;
}

export interface StageMeshResult {
  group: Group;
  chunks: Mesh[];
  /** sector index (stage.sectors) of every chunk; -1 = box outside every sector (always drawn) */
  chunkSector: number[];
  /** chunk indices per sector */
  sectorChunks: number[][];
  barrierBoxes: BarrierBoxVisual[];
  lights: LightCandidate[];
  bounds: { min: Vector3; max: Vector3 };
  stats: { boxes: number; decor: number; barrierBoxes: number; chunks: number; drawCallsIfAllVisible: number; triangles: number; vertices: number; sectors: number };
}

const LIGHT_COLORS: Partial<Record<MaterialKey, number>> = {
  lightPanel: 0xffe6b8,
  hazard: 0xff9040,
  barrier: 0xff5a20,
  gate: 0xff4030,
  machine: 0x70ffd0,
  glass: 0x90d8ff,
};

export function buildStageMeshes(stage: StageDef, lib: MaterialLibrary, opts: StageMeshOptions = {}): StageMeshResult {
  const maxBoxes = Math.max(1, opts.chunkBoxes ?? (opts.chunkXZ ? Math.round(CHUNK_BOXES * (opts.chunkXZ / 96)) : CHUNK_BOXES));
  const group = new Group();
  group.name = 'stage';
  interface Item {
    b: BoxDef;
    tint: RGB;
    cx: number;
    cy: number;
    cz: number;
  }
  const groups = new Map<string, { items: Item[]; key: MaterialKey; level: number; sector: number }>();
  const sectors = stage.sectors ?? [];
  const sectorIndexById = new Map<string, number>();
  sectors.forEach((sd, i) => sectorIndexById.set(sd.id, i));
  const looks = sectors.map((sd) => sectorLook(sd));
  /** the sector that physically contains the box centre (the declared sectorId is only the fallback) */
  const sectorOf = (b: BoxDef): number => {
    const c = { x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2, z: (b.min.z + b.max.z) / 2 };
    for (let i = 0; i < sectors.length; i++) if (sectorContains(sectors[i], c)) return i;
    return sectorIndexById.get(b.sectorId) ?? -1;
  };
  const barrierBoxes: BarrierBoxVisual[] = [];
  const lights: LightCandidate[] = [];
  const bmin = new Vector3(Infinity, Infinity, Infinity);
  const bmax = new Vector3(-Infinity, -Infinity, -Infinity);

  const add = (b: BoxDef, index: number, isDecor: boolean): void => {
    const def = STAGE_MATS[b.mat];
    const sec = sectorOf(b);
    let tint = boxTint(b);
    if (sec >= 0 && !UNTINTED_MATS.has(b.mat)) {
      const st = looks[sec].tint;
      tint = [tint[0] * st[0], tint[1] * st[1], tint[2] * st[2]];
    }
    bmin.min(new Vector3(b.min.x, b.min.y, b.min.z));
    bmax.max(new Vector3(b.max.x, b.max.y, b.max.z));
    const level = emissiveLevelOf(b);
    if (!isDecor && b.barrierId) {
      const gb = new GeoBuilder();
      appendBox(gb, b, def.tile, tint);
      const geo = gb.build();
      const lv = level > 0 ? level : Math.round(def.glow * 4);
      const mat = lib.cloneStage(b.mat, lv);
      const mesh = new Mesh(geo, mat);
      mesh.name = `barrier:${b.id}`;
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
      barrierBoxes.push({
        boxIndex: index,
        box: b,
        barrierId: b.barrierId,
        mesh,
        material: mat,
        baseEmissive: mat.emissiveIntensity,
        open: 0,
        opening: false,
        center: new Vector3((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2),
        size: new Vector3(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z),
      });
      return;
    }
    const k = `${sec}|${b.mat}|${level}`;
    let e = groups.get(k);
    if (!e) {
      e = { items: [], key: b.mat, level, sector: sec };
      groups.set(k, e);
    }
    e.items.push({ b, tint, cx: (b.min.x + b.max.x) / 2, cy: (b.min.y + b.max.y) / 2, cz: (b.min.z + b.max.z) / 2 });
    const lit = b.mat === 'lightPanel' || (b.emissive ?? 0) >= 0.5;
    if (lit && lights.length < 4000) {
      lights.push({
        pos: new Vector3((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2),
        color: LIGHT_COLORS[b.mat] ?? 0xffe0b0,
        power: Math.max(0.3, Math.min(1, b.emissive ?? 0.8)),
        sector: sec,
      });
    }
  };

  stage.boxes.forEach((b, i) => add(b, i, false));
  (stage.decor ?? []).forEach((b, i) => add(b, -1 - i, true));

  const chunks: Mesh[] = [];
  const chunkSector: number[] = [];
  const sectorChunks: number[][] = sectors.map(() => []);
  let triangles = 0;
  let vertices = 0;
  /** kd split: median along the longest extent of the box centres until each part has <= maxBoxes (or is small) */
  const split = (items: Item[], out: Item[][]): void => {
    if (items.length <= maxBoxes) {
      out.push(items);
      return;
    }
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (const it of items) {
      x0 = Math.min(x0, it.cx); x1 = Math.max(x1, it.cx);
      y0 = Math.min(y0, it.cy); y1 = Math.max(y1, it.cy);
      z0 = Math.min(z0, it.cz); z1 = Math.max(z1, it.cz);
    }
    const ex = x1 - x0;
    const ey = (y1 - y0) * 1.5; // vertical splits are worth less: levels are usually seen together
    const ez = z1 - z0;
    const m = Math.max(ex, ey, ez);
    if (m < CHUNK_MIN_SPAN) {
      out.push(items);
      return;
    }
    const key: 'cx' | 'cy' | 'cz' = m === ex ? 'cx' : m === ey ? 'cy' : 'cz';
    items.sort((a, b) => a[key] - b[key]);
    const h = items.length >> 1;
    split(items.slice(0, h), out);
    split(items.slice(h), out);
  };
  for (const [k, e] of groups) {
    const parts: Item[][] = [];
    split(e.items, parts);
    parts.forEach((items, pi) => {
      const gb = new GeoBuilder();
      gb.trackFloor = true;
      gb.curFloor = e.sector >= 0 ? sectors[e.sector].floorY : 0;
      const def = STAGE_MATS[e.key];
      for (const it of items) appendBox(gb, it.b, def.tile, it.tint);
      if (gb.isEmpty) return;
      const geo: BufferGeometry = gb.build();
      triangles += gb.triangleCount;
      vertices += gb.vertexCount;
      const mesh = new Mesh(geo, lib.stage(e.key, e.level));
      const [sec, mat, lv] = k.split('|');
      mesh.name = `chunk:${mat}|${lv}|${sec}|${pi}`;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mesh.userData.sector = e.sector;
      group.add(mesh);
      if (e.sector >= 0) sectorChunks[e.sector].push(chunks.length);
      chunkSector.push(e.sector);
      chunks.push(mesh);
    });
  }
  for (const bb of barrierBoxes) {
    triangles += 12;
    vertices += 24;
  }
  if (!isFinite(bmin.x)) {
    bmin.set(0, 0, 0);
    bmax.set(0, 0, 0);
  }
  // thin out light candidates deterministically to keep the nearest-light scan cheap
  const maxLights = 600;
  let lightList = lights;
  if (lights.length > maxLights) {
    const step = lights.length / maxLights;
    lightList = [];
    for (let i = 0; i < maxLights; i++) lightList.push(lights[Math.floor(i * step)]);
  }
  void Color;
  return {
    group,
    chunks,
    chunkSector,
    sectorChunks,
    barrierBoxes,
    lights: lightList,
    bounds: { min: bmin, max: bmax },
    stats: {
      boxes: stage.boxes.length,
      decor: stage.decor?.length ?? 0,
      barrierBoxes: barrierBoxes.length,
      chunks: chunks.length,
      drawCallsIfAllVisible: chunks.length + barrierBoxes.length,
      triangles,
      vertices,
      sectors: sectors.length,
    },
  };
}
