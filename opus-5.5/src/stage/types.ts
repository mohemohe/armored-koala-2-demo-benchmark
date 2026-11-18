import type { V3 } from '../math';
import type { EnemyKind } from '../config';

export type MatId =
  | 'floor'
  | 'floorDark'
  | 'wall'
  | 'wallRust'
  | 'ceiling'
  | 'pillar'
  | 'steel'
  | 'containerRed'
  | 'containerBlue'
  | 'containerGreen'
  | 'crate'
  | 'machine'
  | 'machineDark'
  | 'pipe'
  | 'hazard'
  | 'catwalk'
  | 'rust'
  | 'tank'
  | 'lightPanel'
  | 'warning'
  | 'concrete'
  | 'paint'
  | 'stain';

/** 空間構成の種類（仕様 2.2 の「空間構成の違い」） */
export type SpaceType = '広場' | '設備のある製造室' | '上下層' | '狭い連絡路' | '縦坑' | '倉庫' | '地下' | '冷却設備' | '外周路' | '搬出ゲート' | '搬入口' | '脱出路' | '動力設備' | '変電設備' | '排水路';

export interface AABB {
  min: V3;
  max: V3;
}

/** 区画の内部空間（床面〜天井面） */
export interface SectorDef {
  id: string;
  name: string;
  spaceType: SpaceType;
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  floor: number;
  ceil: number;
  description: string;
  /** 下限距離計算用の内部ゾーン（内壁で分割された区画のみ） */
  zones?: { id: string; box: AABB }[];
  /** 内部ゾーン間の開口 */
  internalPortals?: { id: string; a: string; b: string; box: AABB }[];
}

export interface PortalDef {
  id: string;
  a: string;
  b: string;
  box: AABB;
  barrierId?: string;
}

export interface BarrierDef {
  id: string;
  portalId: string;
  /** 対応する制御砲台ID。最終ゲートは null（6体全ての破壊で開放） */
  controlId: string | null;
  label: string;
  /** 開放時の移動方向 */
  openAxis: 'up' | 'side';
}

export interface EnemyDef {
  id: string;
  kind: EnemyKind;
  sectorId: string;
  /** 警備ロボット: 足元位置 / 固定砲台: 台座の上面位置 */
  pos: V3;
  isGateControl: boolean;
  barrierId?: string;
}

export interface PropBox {
  min: V3;
  max: V3;
  mat: MatId;
}

export interface PropCylinder {
  /** 底面中心 */
  base: V3;
  radius: number;
  height: number;
  mat: MatId;
  /** 衝突する場合は外接AABBを追加 */
  solid: boolean;
  axis?: 'y' | 'x' | 'z';
}

export interface LightDef {
  pos: V3;
  color: number;
  kind: 'warning' | 'lamp' | 'skylight';
}

export interface SignDef {
  pos: V3;
  /** 看板の法線方向（yaw ラジアン） */
  yaw: number;
  text: string;
  sub?: string;
  width: number;
  height: number;
  color?: string;
}

export interface RoutePoint {
  pos: V3;
  sectorId: string;
  note?: string;
}

export interface FlightAscent {
  id: string;
  sectorId: string;
  from: number;
  to: number;
  note: string;
  base: V3;
}

export interface BranchDef {
  id: string;
  from: string;
  to: string;
  short: string;
  long: string;
  note: string;
}
