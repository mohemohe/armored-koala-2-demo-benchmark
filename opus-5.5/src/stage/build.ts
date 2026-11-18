// レイアウト定義から衝突・描画用の箱群を生成する。
import type { V3 } from '../math';
import {
  BARRIERS,
  CYLINDERS,
  DECALS,
  ENEMIES,
  ESCAPE_ZONE,
  LIGHTS,
  PORTALS,
  PROPS,
  ROUTE,
  S07_CORRIDORS,
  S07_SOLID,
  SECTORS,
  START,
} from './layout';
import { dressSectors } from './dressing';
import type { AABB, BarrierDef, MatId, PropCylinder, SectorDef, SignDef } from './types';

export interface StageBox {
  min: V3;
  max: V3;
  mat: MatId;
  /** 描画しない（円柱の外接箱など） */
  hidden?: boolean;
}

/** 描画のみ（衝突なし）の塗装面 */
export interface StageDecal {
  min: V3;
  max: V3;
  mat: MatId;
}

export interface BarrierBuild {
  def: BarrierDef;
  /** 閉鎖時の衝突・描画箱 */
  box: AABB;
  /** 開放方向の軸（0=x,1=y,2=z） */
  thinAxis: 0 | 1 | 2;
}

export interface StageData {
  boxes: StageBox[];
  decals: StageDecal[];
  barriers: BarrierBuild[];
  cylinders: PropCylinder[];
  signs: SignDef[];
  sectors: SectorDef[];
  bounds: AABB;
}

export function boxOverlap(a: AABB, b: AABB): boolean {
  return (
    a.min[0] < b.max[0] &&
    a.max[0] > b.min[0] &&
    a.min[1] < b.max[1] &&
    a.max[1] > b.min[1] &&
    a.min[2] < b.max[2] &&
    a.max[2] > b.min[2]
  );
}

/** a から b を除いた残りを最大6個の箱で返す */
export function subtractBox(a: AABB, b: AABB): AABB[] {
  if (!boxOverlap(a, b)) return [a];
  const out: AABB[] = [];
  const cur: AABB = { min: [...a.min] as V3, max: [...a.max] as V3 };
  for (let ax = 0; ax < 3; ax++) {
    if (b.min[ax] > cur.min[ax]) {
      const piece: AABB = { min: [...cur.min] as V3, max: [...cur.max] as V3 };
      piece.max[ax] = b.min[ax];
      out.push(piece);
      cur.min[ax] = b.min[ax];
    }
    if (b.max[ax] < cur.max[ax]) {
      const piece: AABB = { min: [...cur.min] as V3, max: [...cur.max] as V3 };
      piece.min[ax] = b.max[ax];
      out.push(piece);
      cur.max[ax] = b.max[ax];
    }
  }
  return out.filter((p) => p.max[0] - p.min[0] > 1e-6 && p.max[1] - p.min[1] > 1e-6 && p.max[2] - p.min[2] > 1e-6);
}

export function subtractMany(a: AABB, holes: AABB[]): AABB[] {
  let pieces: AABB[] = [a];
  for (const h of holes) {
    const next: AABB[] = [];
    for (const p of pieces) next.push(...subtractBox(p, h));
    pieces = next;
  }
  return pieces;
}

const bx = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): AABB => ({
  min: [x0, y0, z0],
  max: [x1, y1, z1],
});

function thinAxisOf(b: AABB): 0 | 1 | 2 {
  const d = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
  let best: 0 | 1 | 2 = 0;
  if (d[1] < d[best]) best = 1;
  if (d[2] < d[best]) best = 2;
  return best;
}

let cached: StageData | null = null;

export function buildStage(): StageData {
  if (cached) return cached;
  const boxes: StageBox[] = [];
  const signs: SignDef[] = [];

  for (const s of SECTORS) {
    const holes = PORTALS.filter((p) => p.a === s.id || p.b === s.id).map((p) => p.box);
    const shell: { b: AABB; mat: MatId }[] = [
      { b: bx(s.x0, s.floor - 1, s.z0, s.x1, s.floor, s.z1), mat: s.floor < 0 ? 'floorDark' : 'floor' },
      { b: bx(s.x0, s.ceil, s.z0, s.x1, s.ceil + 1, s.z1), mat: 'ceiling' },
      { b: bx(s.x0 - 1, s.floor - 1, s.z0 - 1, s.x0, s.ceil + 1, s.z1 + 1), mat: 'wall' },
      { b: bx(s.x1, s.floor - 1, s.z0 - 1, s.x1 + 1, s.ceil + 1, s.z1 + 1), mat: 'wall' },
      { b: bx(s.x0, s.floor - 1, s.z0 - 1, s.x1, s.ceil + 1, s.z0), mat: 'wallRust' },
      { b: bx(s.x0, s.floor - 1, s.z1, s.x1, s.ceil + 1, s.z1 + 1), mat: 'wallRust' },
    ];
    for (const { b, mat } of shell) {
      for (const piece of subtractMany(b, holes)) boxes.push({ min: piece.min, max: piece.max, mat });
    }
  }

  // 自動装飾（トラス・壁柱・壁面配管は衝突あり、天窓・扉枠・塗装・汚れは描画のみ）
  const dress = dressSectors(SECTORS, PORTALS, []);
  for (const d of dress.solids) boxes.push({ min: d.min, max: d.max, mat: d.mat });
  const allCylinders: PropCylinder[] = [...CYLINDERS, ...dress.pipes];

  // S07 配管塊（通路以外を埋める）
  for (const piece of subtractMany(S07_SOLID, S07_CORRIDORS)) boxes.push({ min: piece.min, max: piece.max, mat: 'pipe' });

  for (const p of PROPS) boxes.push({ min: [...p.min] as V3, max: [...p.max] as V3, mat: p.mat });

  for (const c of allCylinders) {
    if (!c.solid) continue;
    const axis = c.axis ?? 'y';
    const [x, y, z] = c.base;
    const r = c.radius;
    if (axis === 'y') boxes.push({ min: [x - r, y, z - r], max: [x + r, y + c.height, z + r], mat: c.mat, hidden: true });
    else if (axis === 'x') boxes.push({ min: [x, y - r, z - r], max: [x + c.height, y + r, z + r], mat: c.mat, hidden: true });
    else boxes.push({ min: [x - r, y - r, z], max: [x + r, y + r, z + c.height], mat: c.mat, hidden: true });
  }

  const barriers: BarrierBuild[] = BARRIERS.map((def) => {
    const portal = PORTALS.find((p) => p.id === def.portalId)!;
    const thin = thinAxisOf(portal.box);
    const b: AABB = { min: [...portal.box.min] as V3, max: [...portal.box.max] as V3 };
    const mid = (b.min[thin] + b.max[thin]) / 2;
    b.min[thin] = mid - 0.5;
    b.max[thin] = mid + 0.5;
    return { def, box: b, thinAxis: thin };
  });

  // 開口上部の区画表示（行き先）
  for (const p of PORTALS) {
    const thin = thinAxisOf(p.box);
    if (thin === 1) continue;
    const cx = (p.box.min[0] + p.box.max[0]) / 2;
    const cz = (p.box.min[2] + p.box.max[2]) / 2;
    const top = p.box.max[1];
    for (const [from, to] of [
      [p.a, p.b],
      [p.b, p.a],
    ]) {
      const s = SECTORS.find((q) => q.id === from)!;
      const dest = SECTORS.find((q) => q.id === to)!;
      let pos: V3;
      let yaw: number;
      if (thin === 0) {
        const inside = Math.abs(p.box.min[0] - s.x1) < 0.01 ? s.x1 - 0.05 : s.x0 + 0.05;
        const nx = inside < cx ? -1 : 1;
        pos = [inside, top + 2.2, cz];
        yaw = nx < 0 ? -Math.PI / 2 : Math.PI / 2;
      } else {
        const inside = Math.abs(p.box.min[2] - s.z1) < 0.01 ? s.z1 - 0.05 : s.z0 + 0.05;
        const nz = inside < cz ? -1 : 1;
        pos = [cx, top + 2.2, inside];
        yaw = nz < 0 ? Math.PI : 0;
      }
      if (pos[1] > s.ceil - 1) pos[1] = s.ceil - 1.2;
      const barrier = p.barrierId ? BARRIERS.find((b) => b.id === p.barrierId) : undefined;
      signs.push({
        pos,
        yaw,
        text: `${dest.id} ${dest.name}`,
        sub: barrier ? (barrier.id === 'GATE' ? 'FINAL GATE' : `${barrier.id} ← ${barrier.controlId}`) : p.id,
        width: 9,
        height: 2.6,
        color: barrier ? '#ffb020' : '#7fd4ff',
      });
    }
  }

  let x0 = Infinity,
    y0 = Infinity,
    z0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity,
    z1 = -Infinity;
  for (const b of boxes) {
    x0 = Math.min(x0, b.min[0]);
    y0 = Math.min(y0, b.min[1]);
    z0 = Math.min(z0, b.min[2]);
    x1 = Math.max(x1, b.max[0]);
    y1 = Math.max(y1, b.max[1]);
    z1 = Math.max(z1, b.max[2]);
  }

  cached = {
    boxes,
    decals: [...DECALS, ...dress.decals].map((d) => ({ min: [...d.min] as V3, max: [...d.max] as V3, mat: d.mat })),
    barriers,
    cylinders: allCylinders,
    signs,
    sectors: SECTORS,
    bounds: bx(x0, y0, z0, x1, y1, z1),
  };
  return cached;
}

export function sectorAt(p: V3): SectorDef | null {
  for (const s of SECTORS) {
    if (p[0] >= s.x0 && p[0] <= s.x1 && p[2] >= s.z0 && p[2] <= s.z1 && p[1] >= s.floor - 0.5 && p[1] <= s.ceil) return s;
  }
  return null;
}

export { SECTORS, PORTALS, BARRIERS, ENEMIES, ESCAPE_ZONE, START, ROUTE, LIGHTS };
