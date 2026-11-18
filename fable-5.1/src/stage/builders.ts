/**
 * ステージ定義用のヘルパー。純粋なデータ（SolidDef/DecorDef）を生成するだけで、
 * Three.js や DOM には依存しない。
 *
 * 方針:
 * - 部屋は「床スラブ・天井スラブ・4 枚の壁」を生成し、扉・ハッチ・縦ダクトは
 *   carve()（AABB の差集合）で後から切り抜く。見た目と衝突が必ず一致する。
 * - 座標は 1 単位 = 1 m。壁厚・スラブ厚は既定 1 m。
 */
import type { AABB, DecorDef, MaterialKey, SolidDef, Vec3 } from '../types';

const EPS = 1e-6;

export function aabb(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): AABB {
  return { min: [Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1)], max: [Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1)] };
}

/** 厳密な重なり（面で接しているだけなら false） */
export function overlaps(a: AABB, b: AABB): boolean {
  return (
    a.min[0] < b.max[0] - EPS &&
    a.max[0] > b.min[0] + EPS &&
    a.min[1] < b.max[1] - EPS &&
    a.max[1] > b.min[1] + EPS &&
    a.min[2] < b.max[2] - EPS &&
    a.max[2] > b.min[2] + EPS
  );
}

function nonDegenerate(b: AABB): boolean {
  return b.max[0] - b.min[0] > EPS && b.max[1] - b.min[1] > EPS && b.max[2] - b.min[2] > EPS;
}

/** a − hole を最大 6 個の AABB で返す（重ならなければ [a]） */
export function subtractBox(a: AABB, hole: AABB): AABB[] {
  if (!overlaps(a, hole)) return [a];
  const out: AABB[] = [];
  const push = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => {
    const b = aabb(x0, y0, z0, x1, y1, z1);
    if (nonDegenerate(b)) out.push(b);
  };
  // X スラブ
  if (a.min[0] < hole.min[0]) push(a.min[0], a.min[1], a.min[2], hole.min[0], a.max[1], a.max[2]);
  if (a.max[0] > hole.max[0]) push(hole.max[0], a.min[1], a.min[2], a.max[0], a.max[1], a.max[2]);
  const x0 = Math.max(a.min[0], hole.min[0]);
  const x1 = Math.min(a.max[0], hole.max[0]);
  // Y スラブ（X 中央帯）
  if (a.min[1] < hole.min[1]) push(x0, a.min[1], a.min[2], x1, hole.min[1], a.max[2]);
  if (a.max[1] > hole.max[1]) push(x0, hole.max[1], a.min[2], x1, a.max[1], a.max[2]);
  const y0 = Math.max(a.min[1], hole.min[1]);
  const y1 = Math.min(a.max[1], hole.max[1]);
  // Z スラブ（XY 中央帯）
  if (a.min[2] < hole.min[2]) push(x0, y0, a.min[2], x1, y1, hole.min[2]);
  if (a.max[2] > hole.max[2]) push(x0, y0, hole.max[2], x1, y1, a.max[2]);
  return out;
}

export type Side = 'n' | 's' | 'e' | 'w';

export interface RoomSpec {
  id: string;
  /** 内側の範囲 */
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  /** 床上面の高さ */
  floorY: number;
  /** 床上面から天井下面までの高さ */
  height: number;
  floor?: MaterialKey;
  ceiling?: MaterialKey;
  wall?: MaterialKey;
  /** 面ごとの壁マテリアル（隣室と共有する壁を同じ材質にするために使う。wall より優先） */
  wallMaterials?: Partial<Record<Side, MaterialKey>>;
  /** 生成しない壁（隣室が所有する場合） */
  skipWalls?: Side[];
  /** 壁厚（既定 1） */
  t?: number;
}

export interface DuctSpec {
  id: string;
  sectorId: string;
  /** 内側の範囲（xz） */
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  /** 底（離陸足場の床上面）と頂上（着地面の高さ） */
  bottomY: number;
  topY: number;
  /** 底の入口がある側と、その範囲（入口側の壁に沿った座標） */
  entrySide: Side;
  entryA0: number;
  entryA1: number;
  /** 頂上の出口がある側（部屋の外壁に扉として切り抜かれる）とその範囲 */
  exitSide: Side;
  exitA0: number;
  exitA1: number;
  /** 出口側の壁はダクト自身が持たない（部屋の外壁を使う）場合 true */
  exitIsRoomWall?: boolean;
  wall?: MaterialKey;
  /** 開口の高さ（既定 6） */
  openingHeight?: number;
}

export class StageBuilder {
  readonly solids: SolidDef[] = [];
  readonly decor: DecorDef[] = [];

  add(box: AABB, material: MaterialKey, sectorId?: string, label?: string): SolidDef {
    const s: SolidDef = { box, material };
    if (sectorId !== undefined) s.sectorId = sectorId;
    if (label !== undefined) s.label = label;
    this.solids.push(s);
    return s;
  }

  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, material: MaterialKey, sectorId?: string, label?: string): SolidDef {
    return this.add(aabb(x0, y0, z0, x1, y1, z1), material, sectorId, label);
  }

  /** hole と重なる全ソリッドから hole を切り抜く */
  carve(hole: AABB): void {
    const next: SolidDef[] = [];
    for (const s of this.solids) {
      if (!overlaps(s.box, hole)) {
        next.push(s);
        continue;
      }
      for (const piece of subtractBox(s.box, hole)) {
        const p: SolidDef = { box: piece, material: s.material };
        if (s.sectorId !== undefined) p.sectorId = s.sectorId;
        if (s.label !== undefined) p.label = s.label;
        next.push(p);
      }
    }
    this.solids.length = 0;
    this.solids.push(...next);
  }

  /** 部屋（床・天井・4 壁）。壁は角で重ならないよう E/W 壁を z 方向に延長する */
  room(r: RoomSpec): void {
    const t = r.t ?? 1;
    const fy = r.floorY;
    const cy = r.floorY + r.height;
    const floorMat = r.floor ?? 'concrete';
    const ceilMat = r.ceiling ?? 'concreteDark';
    const wallMat = r.wall ?? 'brick';
    const wm = (side: Side): MaterialKey => r.wallMaterials?.[side] ?? wallMat;
    const skip = new Set(r.skipWalls ?? []);
    this.box(r.x0 - t, fy - t, r.z0 - t, r.x1 + t, fy, r.z1 + t, floorMat, r.id, `${r.id}:floor`);
    this.box(r.x0 - t, cy, r.z0 - t, r.x1 + t, cy + t, r.z1 + t, ceilMat, r.id, `${r.id}:ceiling`);
    if (!skip.has('w')) this.box(r.x0 - t, fy, r.z0 - t, r.x0, cy, r.z1 + t, wm('w'), r.id, `${r.id}:wallW`);
    if (!skip.has('e')) this.box(r.x1, fy, r.z0 - t, r.x1 + t, cy, r.z1 + t, wm('e'), r.id, `${r.id}:wallE`);
    if (!skip.has('n')) this.box(r.x0, fy, r.z0 - t, r.x1, cy, r.z0, wm('n'), r.id, `${r.id}:wallN`);
    if (!skip.has('s')) this.box(r.x0, fy, r.z1, r.x1, cy, r.z1 + t, wm('s'), r.id, `${r.id}:wallS`);
  }

  /**
   * ソリッド同士の重なりを解消する。先に追加したソリッドを優先し、後のソリッドから重なり部分を差し引く
   * （隣室の共有壁、部屋の壁に食い込むダクトの壁、梁と設備など）。ソリッドの和集合（＝衝突形状）は変わらず、
   * 同一平面上に重なる可視面（Z ファイティングの原因）がなくなる。戻り値は差し引きが起きたソリッド数。
   */
  resolveOverlaps(): number {
    const out: SolidDef[] = [];
    let changed = 0;
    for (const s of this.solids) {
      let pieces: AABB[] = [s.box];
      let touched = false;
      for (const prev of out) {
        if (!overlaps(prev.box, s.box)) continue;
        const next: AABB[] = [];
        for (const p of pieces) {
          if (overlaps(p, prev.box)) {
            next.push(...subtractBox(p, prev.box));
            touched = true;
          } else next.push(p);
        }
        pieces = next;
      }
      if (touched) changed++;
      for (const p of pieces) {
        const d: SolidDef = { box: p, material: s.material };
        if (s.sectorId !== undefined) d.sectorId = s.sectorId;
        if (s.label !== undefined) d.label = s.label;
        out.push(d);
      }
    }
    this.solids.length = 0;
    this.solids.push(...out);
    return changed;
  }

  /**
   * 縦ダクト（壊れた昇降機の縦坑）。底の入口から入り、飛行で頂上まで上がり、頂上の出口へ出る。
   * 出口が部屋の外壁にある場合は exitIsRoomWall=true で、外壁の扉だけを切り抜く。
   * 戻り値は { entry, exit } の切り抜きボックス（隔壁定義などに使う）。
   */
  duct(d: DuctSpec): { entry: AABB; exit: AABB } {
    const t = 1;
    const oh = d.openingHeight ?? 6;
    const mat = d.wall ?? 'steelDark';
    const y0 = d.bottomY;
    const y1 = d.topY + oh;
    const sides: Side[] = ['n', 's', 'e', 'w'];
    for (const side of sides) {
      if (side === d.exitSide && d.exitIsRoomWall) continue;
      let b: AABB;
      switch (side) {
        case 'w':
          b = aabb(d.x0 - t, y0, d.z0 - t, d.x0, y1 + t, d.z1 + t);
          break;
        case 'e':
          b = aabb(d.x1, y0, d.z0 - t, d.x1 + t, y1 + t, d.z1 + t);
          break;
        case 'n':
          b = aabb(d.x0 - t, y0, d.z0 - t, d.x1 + t, y1 + t, d.z0);
          break;
        default:
          b = aabb(d.x0 - t, y0, d.z1, d.x1 + t, y1 + t, d.z1 + t);
      }
      this.add(b, mat, d.sectorId, `${d.id}:${side}`);
    }
    // 屋根
    this.box(d.x0 - t, y1, d.z0 - t, d.x1 + t, y1 + t, d.z1 + t, mat, d.sectorId, `${d.id}:roof`);
    // 中間スラブ（区画内の床板など）をダクト内部から取り除く
    this.carve(aabb(d.x0, y0, d.z0, d.x1, y1, d.z1));
    const entry = this.sideOpening(d, d.entrySide, d.entryA0, d.entryA1, y0, y0 + oh, t);
    const exit = this.sideOpening(d, d.exitSide, d.exitA0, d.exitA1, d.topY, d.topY + oh, t);
    this.carve(entry);
    this.carve(exit);
    return { entry, exit };
  }

  private sideOpening(d: DuctSpec, side: Side, a0: number, a1: number, y0: number, y1: number, t: number): AABB {
    switch (side) {
      case 'w':
        return aabb(d.x0 - t, y0, a0, d.x0, y1, a1);
      case 'e':
        return aabb(d.x1, y0, a0, d.x1 + t, y1, a1);
      case 'n':
        return aabb(a0, y0, d.z0 - t, a1, y1, d.z0);
      default:
        return aabb(a0, y0, d.z1, a1, y1, d.z1 + t);
    }
  }

  // ---- 装飾 -------------------------------------------------------------

  lamp(position: Vec3, emissive: number, sectorId?: string, material: MaterialKey = 'lampAmber'): void {
    const d: DecorDef = { kind: 'lamp', position, emissive, material };
    if (sectorId !== undefined) d.sectorId = sectorId;
    this.decor.push(d);
  }

  arrow(position: Vec3, yaw: number, sectorId?: string): void {
    const d: DecorDef = { kind: 'arrow', position, yaw, material: 'hazard', emissive: 0xffaa00 };
    if (sectorId !== undefined) d.sectorId = sectorId;
    this.decor.push(d);
  }

  label(position: Vec3, text: string, sectorId?: string): void {
    const d: DecorDef = { kind: 'label', position, text, material: 'lampWhite', emissive: 0xffffff };
    if (sectorId !== undefined) d.sectorId = sectorId;
    this.decor.push(d);
  }

  cylinder(position: Vec3, radius: number, height: number, axis: 'x' | 'y' | 'z', material: MaterialKey, sectorId?: string): void {
    const d: DecorDef = { kind: 'cylinder', position, radius, height, axis, material };
    if (sectorId !== undefined) d.sectorId = sectorId;
    this.decor.push(d);
  }

  decorBox(box: AABB, material: MaterialKey, sectorId?: string, emissive?: number): void {
    const d: DecorDef = { kind: 'box', box, material };
    if (sectorId !== undefined) d.sectorId = sectorId;
    if (emissive !== undefined) d.emissive = emissive;
    this.decor.push(d);
  }
}

/** 扉の切り抜きボックス。wall は壁スラブの座標範囲 [a, a+t]（x または z） */
export function doorX(wallX0: number, wallX1: number, z0: number, z1: number, y0: number, y1: number): AABB {
  return aabb(wallX0, y0, z0, wallX1, y1, z1);
}
export function doorZ(wallZ0: number, wallZ1: number, x0: number, x1: number, y0: number, y1: number): AABB {
  return aabb(x0, y0, wallZ0, x1, y1, wallZ1);
}

/** AABB を各方向に m だけ広げる（区画境界用） */
export function grow(b: AABB, m: number): AABB {
  return { min: [b.min[0] - m, b.min[1] - m, b.min[2] - m], max: [b.max[0] + m, b.max[1] + m, b.max[2] + m] };
}
