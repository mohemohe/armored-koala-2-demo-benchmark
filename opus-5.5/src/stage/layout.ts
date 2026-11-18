// AK2 ステージ定義（区画・接続・隔壁・制御砲台・敵初期配置・攻略経路）。
// 座標系: 1単位=1m、Y上向き。X=東、Z=南。区画の x0..x1, z0..z1 は内部空間（壁の内側）。
// 隣接区画は2mの壁（各区画1mずつ）を挟んで配置し、開口（portal）でのみ接続する。
// 全区画は床・壁・天井で密閉されており、飛行で壁や屋根を越えることはできない。
import type { V3 } from '../math';
import type {
  AABB,
  BarrierDef,
  BranchDef,
  EnemyDef,
  FlightAscent,
  LightDef,
  MatId,
  PortalDef,
  PropBox,
  PropCylinder,
  RoutePoint,
  SectorDef,
} from './types';

const aabb = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): AABB => ({
  min: [x0, y0, z0],
  max: [x1, y1, z1],
});

export const SECTORS: SectorDef[] = [
  {
    id: 'S01',
    name: '搬入口',
    spaceType: '搬入口',
    x0: 0, x1: 60, z0: 30, z1: 92, floor: 0, ceil: 16,
    description: '出撃地点。コンテナ壁の陰で遮蔽されている。6mの練習用段差あり。',
  },
  {
    id: 'S02',
    name: '資材ヤード',
    spaceType: '広場',
    x0: 62, x1: 212, z0: 0, z1: 100, floor: 0, ceil: 34,
    description: 'コンテナが点在する大広場。北東の積込台（高さ8m）上に隔壁B1。制御砲台T01は管制塔上。',
  },
  {
    id: 'S03',
    name: '圧延棟',
    spaceType: '設備のある製造室',
    x0: 214, x1: 364, z0: 0, z1: 92, floor: 0, ceil: 30,
    description: '3本の圧延ラインが並ぶ製造棟。出口は東壁の高さ12mの開口。',
  },
  {
    id: 'S04',
    name: '搬送縦坑',
    spaceType: '縦坑',
    x0: 366, x1: 400, z0: 58, z1: 100, floor: 0, ceil: 64,
    description: '高さ64mの縦坑。高さ12mの踊り場から高さ26mの出口（隔壁B2）へ上昇する。制御砲台T04は東壁の高さ22mの台座。',
  },
  {
    id: 'S05',
    name: '組立ライン',
    spaceType: '設備のある製造室',
    x0: 250, x1: 400, z0: 102, z1: 204, floor: 26, ceil: 56,
    description: '上層（床高26m）の組立工場。西壁に2つの出口があり分岐αの起点。',
  },
  {
    id: 'S06',
    name: '検査棟',
    spaceType: '上下層',
    x0: 128, x1: 248, z0: 102, z1: 152, floor: 12, ceil: 44,
    description: '分岐α短経路。上階（中二階・床26m）と下階（床12m）の2層構造。開けていて複数方向から撃たれる。',
  },
  {
    id: 'S07',
    name: '保守用配管区画',
    spaceType: '狭い連絡路',
    x0: 128, x1: 248, z0: 154, z1: 204, floor: 12, ceil: 40,
    description: '分岐α長経路。配管塊の下を曲がりくねる幅12〜14mの狭い通路。遮蔽が多い。',
    zones: [
      { id: 'S07-E', box: aabb(236, 12, 154, 248, 40, 204) },
      { id: 'S07-A', box: aabb(186, 12, 188, 236, 24, 202) },
      { id: 'S07-B', box: aabb(176, 12, 158, 190, 24, 202) },
      { id: 'S07-C', box: aabb(140, 12, 158, 190, 24, 170) },
      { id: 'S07-D', box: aabb(140, 12, 158, 152, 24, 188) },
      { id: 'S07-X', box: aabb(128, 12, 176, 152, 24, 188) },
    ],
    internalPortals: [
      { id: 'S07-EA', a: 'S07-E', b: 'S07-A', box: aabb(236, 12, 188, 236, 24, 202) },
      { id: 'S07-AB', a: 'S07-A', b: 'S07-B', box: aabb(186, 12, 188, 190, 24, 202) },
      { id: 'S07-BC', a: 'S07-B', b: 'S07-C', box: aabb(176, 12, 158, 190, 24, 170) },
      { id: 'S07-CD', a: 'S07-C', b: 'S07-D', box: aabb(140, 12, 158, 152, 24, 170) },
      { id: 'S07-DX', a: 'S07-D', b: 'S07-X', box: aabb(140, 12, 176, 152, 24, 188) },
    ],
  },
  {
    id: 'S08',
    name: '動力棟',
    spaceType: '動力設備',
    x0: 0, x1: 126, z0: 102, z1: 204, floor: 12, ceil: 50,
    description: '発電機が並ぶ大空間。分岐αの合流点。南西の高さ24mの回廊から隔壁B3へ。制御砲台T08は発電機上。',
  },
  {
    id: 'S09',
    name: '冷却設備',
    spaceType: '冷却設備',
    x0: 0, x1: 120, z0: 206, z1: 306, floor: 24, ceil: 56,
    description: '冷却塔の並ぶ上層区画。東壁に2つの出口があり分岐βの起点。',
  },
  {
    id: 'S10',
    name: '変電区画',
    spaceType: '変電設備',
    x0: 122, x1: 242, z0: 206, z1: 254, floor: 24, ceil: 50,
    description: '分岐β短経路。変圧器が点在する開けた区画。',
  },
  {
    id: 'S11',
    name: '排水路',
    spaceType: '排水路',
    x0: 122, x1: 242, z0: 256, z1: 306, floor: 24, ceil: 46,
    description: '分岐β長経路。隔壁状の仕切りで蛇行する水路。低い水路壁が遮蔽になる。',
    zones: [
      { id: 'S11-1', box: aabb(122, 24, 256, 160, 46, 306) },
      { id: 'S11-2', box: aabb(162, 24, 256, 200, 46, 306) },
      { id: 'S11-3', box: aabb(202, 24, 256, 242, 46, 306) },
    ],
    internalPortals: [
      { id: 'S11-12', a: 'S11-1', b: 'S11-2', box: aabb(160, 24, 296, 162, 46, 306) },
      { id: 'S11-23', a: 'S11-2', b: 'S11-3', box: aabb(200, 24, 256, 202, 46, 266) },
    ],
  },
  {
    id: 'S12',
    name: '排気縦坑',
    spaceType: '縦坑',
    x0: 244, x1: 280, z0: 220, z1: 292, floor: -14, ceil: 64,
    description: '分岐βの合流点。高さ24mの西側足場から底（-14m）へ降下し、底の東壁の隔壁B4から地下へ。制御砲台T11は東壁。',
  },
  {
    id: 'S13',
    name: '地下搬送区画',
    spaceType: '地下',
    x0: 282, x1: 432, z0: 206, z1: 306, floor: -14, ceil: -2,
    description: '主製造ホールの真下にある地下層。中央の搬送機壁でU字に折り返す。北西天井のハッチ（隔壁B5）から上層へ。',
    zones: [
      { id: 'S13-S', box: aabb(282, -14, 258, 432, -2, 306) },
      { id: 'S13-E', box: aabb(408, -14, 206, 432, -2, 306) },
      { id: 'S13-N', box: aabb(282, -14, 206, 432, -2, 254) },
    ],
    internalPortals: [
      { id: 'S13-SE', a: 'S13-S', b: 'S13-E', box: aabb(408, -14, 258, 432, -2, 306) },
      { id: 'S13-EN', a: 'S13-E', b: 'S13-N', box: aabb(408, -14, 206, 432, -2, 254) },
    ],
  },
  {
    id: 'S14',
    name: '主製造ホール',
    spaceType: '設備のある製造室',
    x0: 282, x1: 432, z0: 206, z1: 306, floor: 0, ceil: 34,
    description: '大型プレス機の並ぶ中心ホール（地下搬送区画の真上）。南東の高さ12m回廊の隔壁B6へ。制御砲台T13はプレス機上。',
  },
  {
    id: 'S15',
    name: '出荷倉庫',
    spaceType: '倉庫',
    x0: 358, x1: 432, z0: 308, z1: 408, floor: 12, ceil: 40,
    description: '高い棚が並ぶ倉庫。西壁に2つの出口があり分岐γの起点。',
  },
  {
    id: 'S16',
    name: '外周搬送路',
    spaceType: '外周路',
    x0: 200, x1: 356, z0: 308, z1: 356, floor: 12, ceil: 36,
    description: '分岐γ短経路。外周沿いの直線搬送路。遮蔽が少ない。',
  },
  {
    id: 'S17',
    name: '梱包区画',
    spaceType: '倉庫',
    x0: 200, x1: 356, z0: 358, z1: 408, floor: 12, ceil: 36,
    description: '分岐γ長経路。仕切り壁で蛇行する梱包エリア。木箱が遮蔽になる。',
    zones: [
      { id: 'S17-1', box: aabb(302, 12, 358, 356, 36, 408) },
      { id: 'S17-2', box: aabb(252, 12, 358, 300, 36, 408) },
      { id: 'S17-3', box: aabb(200, 12, 358, 250, 36, 408) },
    ],
    internalPortals: [
      { id: 'S17-12', a: 'S17-1', b: 'S17-2', box: aabb(300, 12, 398, 302, 36, 408) },
      { id: 'S17-23', a: 'S17-2', b: 'S17-3', box: aabb(250, 12, 358, 252, 36, 368) },
    ],
  },
  {
    id: 'S18',
    name: '搬出ゲート',
    spaceType: '搬出ゲート',
    x0: 80, x1: 198, z0: 308, z1: 408, floor: 0, ceil: 36,
    description: '分岐γの合流点。西壁の高さ8mの搬出台に最終搬出ゲート。',
  },
  {
    id: 'S19',
    name: '脱出路',
    spaceType: '脱出路',
    x0: 20, x1: 78, z0: 340, z1: 376, floor: 8, ceil: 24,
    description: '最終ゲートの先。西側の脱出領域に入るとクリア。',
  },
];

export const PORTALS: PortalDef[] = [
  { id: 'P01', a: 'S01', b: 'S02', box: aabb(60, 0, 74, 62, 10, 88) },
  { id: 'P02', a: 'S02', b: 'S03', box: aabb(212, 8, 6, 214, 16, 20), barrierId: 'B1' },
  { id: 'P03', a: 'S03', b: 'S04', box: aabb(364, 12, 70, 366, 20, 84) },
  { id: 'P04', a: 'S04', b: 'S05', box: aabb(380, 26, 100, 396, 34, 102), barrierId: 'B2' },
  { id: 'P05a', a: 'S05', b: 'S06', box: aabb(248, 26, 106, 250, 34, 120) },
  { id: 'P05b', a: 'S05', b: 'S07', box: aabb(248, 26, 190, 250, 34, 202) },
  { id: 'P06', a: 'S06', b: 'S08', box: aabb(126, 12, 134, 128, 20, 148) },
  { id: 'P07', a: 'S07', b: 'S08', box: aabb(126, 12, 176, 128, 20, 188) },
  { id: 'P08', a: 'S08', b: 'S09', box: aabb(6, 24, 204, 20, 32, 206), barrierId: 'B3' },
  { id: 'P09a', a: 'S09', b: 'S10', box: aabb(120, 24, 212, 122, 32, 226) },
  { id: 'P09b', a: 'S09', b: 'S11', box: aabb(120, 24, 290, 122, 32, 304) },
  { id: 'P10', a: 'S10', b: 'S12', box: aabb(242, 24, 230, 244, 32, 244) },
  { id: 'P11', a: 'S11', b: 'S12', box: aabb(242, 24, 272, 244, 32, 286) },
  { id: 'P12', a: 'S12', b: 'S13', box: aabb(280, -14, 270, 282, -6, 284), barrierId: 'B4' },
  { id: 'P13', a: 'S13', b: 'S14', box: aabb(290, -2, 214, 306, 0, 230), barrierId: 'B5' },
  { id: 'P14', a: 'S14', b: 'S15', box: aabb(410, 12, 306, 426, 20, 308), barrierId: 'B6' },
  { id: 'P15a', a: 'S15', b: 'S16', box: aabb(356, 12, 316, 358, 20, 330) },
  { id: 'P15b', a: 'S15', b: 'S17', box: aabb(356, 12, 392, 358, 20, 406) },
  { id: 'P16', a: 'S16', b: 'S18', box: aabb(198, 12, 316, 200, 20, 330) },
  { id: 'P17', a: 'S17', b: 'S18', box: aabb(198, 12, 390, 200, 20, 404) },
  { id: 'PG', a: 'S18', b: 'S19', box: aabb(78, 8, 350, 80, 16, 366), barrierId: 'GATE' },
];

export const BARRIERS: BarrierDef[] = [
  { id: 'B1', portalId: 'P02', controlId: 'T01', label: '隔壁B1 資材ヤード→圧延棟', openAxis: 'up' },
  { id: 'B2', portalId: 'P04', controlId: 'T04', label: '隔壁B2 搬送縦坑→組立ライン', openAxis: 'up' },
  { id: 'B3', portalId: 'P08', controlId: 'T08', label: '隔壁B3 動力棟→冷却設備', openAxis: 'up' },
  { id: 'B4', portalId: 'P12', controlId: 'T11', label: '隔壁B4 排気縦坑→地下搬送区画', openAxis: 'up' },
  { id: 'B5', portalId: 'P13', controlId: 'T12', label: '隔壁B5 地下搬送区画→主製造ホール（天井ハッチ）', openAxis: 'side' },
  { id: 'B6', portalId: 'P14', controlId: 'T13', label: '隔壁B6 主製造ホール→出荷倉庫', openAxis: 'up' },
  { id: 'GATE', portalId: 'PG', controlId: null, label: '最終搬出ゲート', openAxis: 'up' },
];

/** 脱出領域（最終ゲートの先）。ゲート開放後、生存したプレイヤーが入るとクリア */
export const ESCAPE_ZONE: AABB = aabb(20, 8, 340, 60, 24, 376);

/** 出撃地点（コンテナ壁の陰）。初期の向きは搬入口の出口方向（南東） */
export const START = { pos: [8, 0, 38] as V3, yaw: Math.atan2(-10, -34) };

const G = (id: string, sectorId: string, x: number, y: number, z: number): EnemyDef => ({
  id,
  kind: 'guard',
  sectorId,
  pos: [x, y, z],
  isGateControl: false,
});
const T = (id: string, sectorId: string, x: number, y: number, z: number, barrierId?: string): EnemyDef => ({
  id,
  kind: 'turret',
  sectorId,
  pos: [x, y, z],
  isGateControl: !!barrierId,
  barrierId,
});

export const ENEMIES: EnemyDef[] = [
  // S02 資材ヤード（警備3・砲台2）
  G('G01', 'S02', 120, 0, 70),
  G('G02', 'S02', 150, 0, 30),
  G('G03', 'S02', 172, 0, 82),
  T('T01', 'S02', 185, 12, 59, 'B1'),
  T('T02', 'S02', 130, 0, 84),
  // S03 圧延棟（警備3・砲台1）
  G('G04', 'S03', 260, 0, 36),
  G('G05', 'S03', 300, 0, 62),
  G('G06', 'S03', 330, 0, 12),
  T('T03', 'S03', 276, 0, 38),
  // S04 搬送縦坑（砲台2）
  T('T04', 'S04', 398, 22, 76, 'B2'),
  T('T05', 'S04', 386, 20, 60.5),
  // S05 組立ライン（警備3・砲台1）
  G('G07', 'S05', 300, 26, 114),
  G('G08', 'S05', 340, 26, 158),
  G('G09', 'S05', 280, 26, 190),
  T('T06', 'S05', 320, 36, 150),
  // S06 検査棟（警備2・砲台1）
  G('G10', 'S06', 225, 26, 128),
  G('G11', 'S06', 165, 12, 132),
  T('T07', 'S06', 150, 20, 110),
  // S07 保守用配管区画（警備2）
  G('G12', 'S07', 205, 12, 195),
  G('G13', 'S07', 146, 12, 175),
  // S08 動力棟（警備3・砲台1）
  G('G14', 'S08', 105, 12, 152),
  G('G15', 'S08', 62, 12, 180),
  G('G16', 'S08', 16, 12, 150),
  T('T08', 'S08', 90, 28, 170, 'B3'),
  // S09 冷却設備（警備2・砲台1）
  G('G17', 'S09', 60, 24, 265),
  G('G18', 'S09', 104, 24, 294),
  T('T09', 'S09', 101, 32, 245),
  // S10 変電区画（警備2・砲台1）
  G('G19', 'S10', 200, 24, 231),
  G('G20', 'S10', 162, 24, 214),
  T('T10', 'S10', 179, 36, 244),
  // S11 排水路（警備1）
  G('G21', 'S11', 180, 24, 270),
  // S12 排気縦坑（砲台1）
  T('T11', 'S12', 277, 6, 240, 'B4'),
  // S13 地下搬送区画（警備3・砲台1）
  G('G22', 'S13', 340, -14, 290),
  G('G23', 'S13', 395, -14, 266),
  G('G24', 'S13', 350, -14, 226),
  T('T12', 'S13', 400, -9, 218, 'B5'),
  // S14 主製造ホール（警備3・砲台1）
  G('G25', 'S14', 330, 0, 224),
  G('G26', 'S14', 400, 0, 262),
  G('G27', 'S14', 345, 0, 290),
  T('T13', 'S14', 360, 14, 260, 'B6'),
  // S15 出荷倉庫（警備1）
  G('G28', 'S15', 385, 12, 370),
  // S16 外周搬送路（警備1・砲台1）
  G('G29', 'S16', 240, 12, 326),
  T('T14', 'S16', 274, 20, 352),
  // S18 搬出ゲート（警備1・砲台1）
  G('G30', 'S18', 150, 0, 345),
  T('T15', 'S18', 114, 10, 320),
];

/** 必須経路上の飛行が必要な昇降箇所（通常ジャンプ最高到達 約2.78m） */
export const FLIGHT_ASCENTS: FlightAscent[] = [
  { id: 'A0', sectorId: 'S02', from: 0, to: 8, base: [204, 0, 36], note: '資材ヤード北東の積込台（隔壁B1の前）' },
  { id: 'A1', sectorId: 'S03', from: 0, to: 12, base: [358, 0, 77], note: '圧延棟東壁の高さ12m開口（搬送縦坑へ）' },
  { id: 'A2', sectorId: 'S04', from: 12, to: 26, base: [372, 12, 88], note: '搬送縦坑の踊り場から高さ26mの出口（隔壁B2）' },
  { id: 'A3', sectorId: 'S08', from: 12, to: 24, base: [30, 12, 186], note: '動力棟南西の高さ24m回廊（隔壁B3の前）' },
  { id: 'A4', sectorId: 'S13', from: -14, to: 0, base: [298, -14, 222], note: '地下搬送区画から天井ハッチ（隔壁B5）を抜けて主製造ホールへ' },
  { id: 'A5', sectorId: 'S14', from: 0, to: 12, base: [418, 0, 288], note: '主製造ホール南東の高さ12m回廊（隔壁B6の前）' },
  { id: 'A6', sectorId: 'S18', from: 0, to: 8, base: [102, 0, 358], note: '搬出ゲート西側の高さ8m搬出台（最終ゲートの前）' },
];

export const BRANCHES: BranchDef[] = [
  { id: 'α', from: 'S05', to: 'S08', short: 'S06', long: 'S07', note: '検査棟は短いが開けていて砲台と2層から撃たれる。配管区画は曲がりくねり長いが遮蔽が多い。' },
  { id: 'β', from: 'S09', to: 'S12', short: 'S10', long: 'S11', note: '変電区画は直線で短いが砲台と警備に晒される。排水路は仕切りで蛇行するが遮蔽が多い。' },
  { id: 'γ', from: 'S15', to: 'S18', short: 'S16', long: 'S17', note: '外周搬送路は直線で短いが遮蔽が少ない。梱包区画は蛇行して長いが木箱が遮蔽になり敵がいない。' },
];

/** 推奨攻略経路（短経路側）。HUDの進行方向表示とドキュメントに使用 */
export const ROUTE: RoutePoint[] = [
  { pos: [8, 0, 38], sectorId: 'S01', note: '出撃地点' },
  { pos: [16, 0, 62], sectorId: 'S01' },
  { pos: [30, 0, 70], sectorId: 'S01' },
  { pos: [61, 1, 81], sectorId: 'S01', note: 'P01' },
  { pos: [120, 0, 58], sectorId: 'S02' },
  { pos: [185, 0, 40], sectorId: 'S02', note: 'T01（制御）を破壊' },
  { pos: [204, 8.5, 20], sectorId: 'S02', note: 'A0 積込台へ飛行' },
  { pos: [213, 9, 13], sectorId: 'S02', note: 'P02 / 隔壁B1' },
  { pos: [240, 0, 14], sectorId: 'S03' },
  { pos: [300, 0, 36], sectorId: 'S03' },
  { pos: [355, 0, 77], sectorId: 'S03', note: 'A1 東壁開口へ飛行' },
  { pos: [365, 13, 77], sectorId: 'S03', note: 'P03' },
  { pos: [374, 12, 90], sectorId: 'S04', note: '踊り場からT04（制御）を破壊し、A2 出口へ上昇' },
  { pos: [388, 27, 101], sectorId: 'S04', note: 'P04 / 隔壁B2' },
  { pos: [360, 26, 112], sectorId: 'S05' },
  { pos: [300, 26, 112], sectorId: 'S05' },
  { pos: [249, 27, 113], sectorId: 'S05', note: 'P05a（分岐α短経路）' },
  { pos: [200, 26, 118], sectorId: 'S06' },
  { pos: [175, 12, 128], sectorId: 'S06', note: '中二階から下階へ降下' },
  { pos: [127, 13, 141], sectorId: 'S06', note: 'P06' },
  { pos: [90, 12, 150], sectorId: 'S08', note: 'T08（制御）を破壊' },
  { pos: [40, 12, 184], sectorId: 'S08' },
  { pos: [13, 24.5, 196], sectorId: 'S08', note: 'A3 回廊へ飛行' },
  { pos: [13, 25, 205], sectorId: 'S08', note: 'P08 / 隔壁B3' },
  { pos: [60, 24, 216], sectorId: 'S09' },
  { pos: [121, 25, 219], sectorId: 'S09', note: 'P09a（分岐β短経路）' },
  { pos: [185, 24, 228], sectorId: 'S10' },
  { pos: [243, 25, 237], sectorId: 'S10', note: 'P10' },
  { pos: [258, 10, 262], sectorId: 'S12', note: '縦坑を降下・T11（制御）を破壊' },
  { pos: [270, -14, 277], sectorId: 'S12' },
  { pos: [281, -13, 277], sectorId: 'S12', note: 'P12 / 隔壁B4' },
  { pos: [360, -14, 282], sectorId: 'S13' },
  { pos: [420, -14, 256], sectorId: 'S13', note: 'U字の折り返し' },
  { pos: [360, -14, 247], sectorId: 'S13', note: 'T12（制御）を破壊' },
  { pos: [304, -14, 244], sectorId: 'S13' },
  { pos: [298, -14, 222], sectorId: 'S13', note: 'A4 天井ハッチへ上昇' },
  { pos: [298, 3, 222], sectorId: 'S14', note: 'P13 / 隔壁B5（床面より上まで上昇）' },
  { pos: [340, 0, 236], sectorId: 'S14', note: 'T13（制御）を破壊' },
  { pos: [405, 0, 285], sectorId: 'S14' },
  { pos: [418, 12.5, 300], sectorId: 'S14', note: 'A5 回廊へ飛行' },
  { pos: [418, 13, 307], sectorId: 'S14', note: 'P14 / 隔壁B6' },
  { pos: [400, 12, 322], sectorId: 'S15' },
  { pos: [357, 13, 323], sectorId: 'S15', note: 'P15a（分岐γ短経路）' },
  { pos: [280, 12, 322], sectorId: 'S16' },
  { pos: [199, 13, 323], sectorId: 'S16', note: 'P16' },
  { pos: [150, 0, 340], sectorId: 'S18' },
  { pos: [102, 0, 358], sectorId: 'S18', note: 'A6 搬出台へ飛行' },
  { pos: [79, 9, 358], sectorId: 'S18', note: '最終ゲート' },
  { pos: [40, 8, 358], sectorId: 'S19', note: '脱出領域' },
];

// ---------------------------------------------------------------------------
// 内部構造物（プロップ）。全て衝突あり（見た目と衝突を一致させる）。
// ---------------------------------------------------------------------------

const props: PropBox[] = [];
/** 衝突しない塗装（警告帯など）。壁面から6cmのみ。 */
const decals: PropBox[] = [];
const cylinders: PropCylinder[] = [];
const lights: LightDef[] = [];

const B = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, mat: MatId) =>
  props.push({ min: [Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1)], max: [Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1)], mat });
const Cyl = (x: number, y: number, z: number, r: number, h: number, mat: MatId, axis: 'y' | 'x' | 'z' = 'y') =>
  cylinders.push({ base: [x, y, z], radius: r, height: h, mat, solid: true, axis });
const Lamp = (x: number, y: number, z: number, kind: LightDef['kind'] = 'lamp', color = 0xffc070) =>
  lights.push({ pos: [x, y, z], color, kind });

/** コンテナ（長さ方向 axis） */
function container(x: number, z: number, y: number, len: number, axis: 'x' | 'z', mat: MatId) {
  if (axis === 'x') B(x, y, z, x + len, y + 6, z + 6, mat);
  else B(x, y, z, x + 6, y + 6, z + len, mat);
}
/** 柱 */
function pillar(x: number, z: number, y0: number, y1: number, s = 2) {
  B(x - s / 2, y0, z - s / 2, x + s / 2, y1, z + s / 2, 'pillar');
}
/** 段差の縁の警告帯（上面と同じ高さ、外側へ5cm） */
function hazardEdgeX(x0: number, x1: number, z: number, top: number, side: 1 | -1) {
  const z1 = z + side * 0.06;
  decals.push({ min: [x0, top - 0.6, Math.min(z, z1)], max: [x1, top, Math.max(z, z1)], mat: 'hazard' });
}
function hazardEdgeZ(z0: number, z1: number, x: number, top: number, side: 1 | -1) {
  const x1 = x + side * 0.06;
  decals.push({ min: [Math.min(x, x1), top - 0.6, z0], max: [Math.max(x, x1), top, z1], mat: 'hazard' });
}

// S01 搬入口 ---------------------------------------------------------------
B(16, 0, 30, 22, 8, 54, 'containerBlue'); // 出撃地点を遮蔽するコンテナ壁
B(16, 8, 30, 22, 14, 42, 'containerRed');
B(30, 0, 40, 36, 5, 48, 'machine'); // トラック運転台
B(36, 0, 40, 54, 6, 48, 'containerGreen'); // トラック荷台
B(26, 0, 30, 56, 6, 34, 'crate'); // 北壁の棚
B(40, 0, 60, 44, 3, 64, 'crate');
B(20, 0, 82, 26, 4, 88, 'crate');
B(0, 0, 78, 14, 6, 92, 'concrete'); // 練習用段差（6m）
hazardEdgeX(0, 14, 78, 6, -1);
hazardEdgeZ(78, 92, 14, 6, 1);
Lamp(30, 15, 60, 'skylight', 0xdde8ff);
Lamp(8, 12, 32, 'warning', 0x40ff80);

// S02 資材ヤード -----------------------------------------------------------
B(192, 0, 0, 212, 8, 32, 'concrete'); // 積込台（A0）
hazardEdgeX(192, 212, 32, 8, 1);
hazardEdgeZ(0, 32, 192, 8, -1);
B(180, 0, 54, 190, 12, 64, 'machineDark'); // 管制塔（T01）
container(80, 10, 0, 12, 'x', 'containerRed');
container(80, 10, 6, 12, 'x', 'containerBlue');
container(100, 40, 0, 18, 'z', 'containerBlue');
container(120, 20, 0, 12, 'x', 'containerGreen');
container(140, 60, 0, 18, 'z', 'containerRed');
container(140, 60, 6, 12, 'z', 'containerBlue'); // T02 の台
container(160, 40, 0, 12, 'x', 'containerGreen');
container(118, 82, 0, 16, 'z', 'containerBlue');
container(84, 70, 0, 14, 'z', 'containerGreen');
container(170, 12, 0, 12, 'z', 'containerRed');
container(152, 88, 0, 10, 'x', 'containerRed');
container(104, 64, 0, 12, 'x', 'containerRed'); // 進入路の遮蔽
container(164, 50, 0, 12, 'z', 'containerBlue');
container(172, 34, 0, 10, 'x', 'containerGreen'); // 積込台手前の遮蔽
B(96, 0, 88, 104, 3, 96, 'rust'); // 鋼材の山
B(176, 0, 90, 188, 2.5, 96, 'rust');
for (const x of [112, 162]) for (const z of [33, 66]) pillar(x, z, 0, 34, 2);
B(64, 26, 48, 210, 28, 50, 'steel'); // 天井クレーンの桁
B(64, 26, 24, 210, 28, 26, 'steel');
Lamp(90, 33, 25, 'skylight', 0xdde8ff);
Lamp(140, 33, 50, 'skylight', 0xdde8ff);
Lamp(190, 33, 80, 'skylight', 0xdde8ff);
Lamp(185, 13.5, 59, 'warning', 0xff3020);
Lamp(205, 15, 34, 'warning', 0xffa020);

// S03 圧延棟 ---------------------------------------------------------------
function rollingLine(z0: number, z1: number, segs: [number, number][]) {
  for (const [a, b] of segs) {
    B(a, 0, z0, b, 3.5, z1, 'machine');
    for (let w = a + 2; w + 3 <= b - 1; w += 12) B(w, 0, z0 - 1, w + 3, 7, z1 + 1, 'machineDark'); // ロールスタンド
  }
}
rollingLine(22, 28, [[226, 256], [264, 300], [308, 340]]);
rollingLine(46, 52, [[232, 270], [278, 318], [326, 338]]);
rollingLine(70, 76, [[226, 262], [270, 306], [314, 344]]);
B(344, 0, 40, 356, 10, 56, 'machineDark'); // 制御ブース（T03）
Cyl(235, 0, 60, 6, 14, 'tank'); // 加熱炉
B(216, 22, 36, 362, 24, 38, 'steel');
B(216, 22, 60, 362, 24, 62, 'steel');
for (const x of [250, 290, 330]) {
  pillar(x, 3, 0, 30, 2);
  pillar(x, 89, 0, 30, 2);
}
hazardEdgeZ(70, 84, 364, 12, -1);
Lamp(365, 20.5, 77, 'warning', 0xffa020);
Lamp(260, 29, 45, 'skylight', 0xdde8ff);
Lamp(320, 29, 45, 'skylight', 0xdde8ff);
Lamp(240, 5, 60, 'lamp', 0xff7030);

// S04 搬送縦坑 -------------------------------------------------------------
B(366, 0, 64, 378, 12, 92, 'concrete'); // 踊り場（A2 の起点）
B(376.5, 12, 64, 378, 15.2, 80, 'steel'); // 踊り場の防護壁（砲台からの遮蔽）
hazardEdgeZ(64, 92, 378, 12, 1);
B(394, 0, 58, 400, 64, 62, 'steel');
B(394, 0, 96, 400, 64, 100, 'steel');
B(396, 20, 72, 400, 22, 80, 'machineDark'); // T04 の台座（踊り場から見える高さ）
B(382, 17, 58, 390, 20, 62, 'machineDark'); // T05 の台座
B(368, 48, 58, 398, 50, 62, 'steel');
Lamp(388, 35, 100, 'warning', 0xffa020);
Lamp(380, 60, 80, 'skylight', 0xdde8ff);
Lamp(399, 26, 71, 'warning', 0xff3020);

// S05 組立ライン -----------------------------------------------------------
B(262, 26, 128, 386, 28, 134, 'machine');
for (const w of [270, 294, 318, 342, 366]) B(w, 26, 122, w + 4, 32, 128, 'machineDark');
B(262, 26, 168, 386, 28, 174, 'machine');
for (const w of [282, 306, 330, 354]) B(w, 26, 174, w + 4, 32, 180, 'machineDark');
B(316, 26, 146, 324, 36, 154, 'machineDark'); // ガントリー塔（T06）
B(336, 26, 104, 344, 30, 108, 'crate'); // 通路沿いの部品箱（遮蔽）
B(280, 26, 104, 288, 30, 108, 'crate');
B(260, 26, 198, 300, 34, 204, 'crate');
B(330, 26, 198, 370, 34, 204, 'crate');
pillar(280, 150, 26, 56, 2);
pillar(362, 150, 26, 56, 2);
B(252, 46, 149, 398, 48, 151, 'steel');
Lamp(300, 55, 150, 'skylight', 0xdde8ff);
Lamp(370, 55, 120, 'skylight', 0xdde8ff);
Lamp(249, 35, 113, 'warning', 0xffa020);
Lamp(249, 35, 196, 'warning', 0xffa020);

// S06 検査棟（上下層） -----------------------------------------------------
B(188, 24, 102, 248, 26, 152, 'catwalk'); // 中二階（上階の床）
B(188, 26, 102, 189, 27.2, 118, 'steel'); // 手すり
B(188, 26, 136, 189, 27.2, 152, 'steel');
for (const [x, z] of [[190, 110], [190, 144], [218, 104], [218, 150]]) pillar(x, z, 12, 24, 1.2);
B(196, 12, 110, 208, 18, 120, 'machine'); // 下階の検査ブース
B(220, 12, 130, 232, 18, 140, 'machine');
B(232, 12, 106, 244, 20, 114, 'machineDark');
B(146, 12, 106, 154, 20, 114, 'machineDark'); // T07 の塔
B(160, 12, 112, 164, 22, 116, 'steel'); // 検査ゲート
B(160, 12, 140, 164, 22, 144, 'steel');
B(160, 20, 116, 164, 22, 140, 'steel');
B(210, 26, 120, 216, 30, 132, 'machine'); // 上階の検査装置
B(232, 26, 136, 242, 30, 146, 'crate');
Lamp(160, 43, 127, 'skylight', 0xdde8ff);
Lamp(210, 23.5, 127, 'lamp', 0xffd080);
Lamp(127, 21, 141, 'warning', 0xffa020);

// S07 保守用配管区画（配管塊の下の狭い通路） -------------------------------
B(128, 24, 154, 236, 40, 204, 'pipe'); // 配管塊（天井）
B(238, 25, 186, 248, 26, 204, 'catwalk'); // 入口の足場（高さ26m）
// 通路以外の下部空間を配管塊で埋める（buildで差分生成）
export const S07_SOLID = aabb(128, 12, 154, 236, 24, 204);
export const S07_CORRIDORS: AABB[] = [
  aabb(186, 12, 188, 236, 24, 202),
  aabb(176, 12, 158, 190, 24, 202),
  aabb(140, 12, 158, 190, 24, 170),
  aabb(140, 12, 158, 152, 24, 188),
  aabb(128, 12, 176, 152, 24, 188),
];
B(238, 12, 160, 246, 16, 170, 'machine');
Lamp(210, 23.5, 195, 'lamp', 0xffb060);
Lamp(183, 23.5, 180, 'lamp', 0xffb060);
Lamp(165, 23.5, 164, 'lamp', 0xffb060);
Lamp(146, 23.5, 180, 'warning', 0xff3020);
Lamp(242, 38, 180, 'skylight', 0xdde8ff);

// S08 動力棟 ---------------------------------------------------------------
B(0, 12, 190, 60, 24, 204, 'concrete'); // 南西回廊（A3）
hazardEdgeX(0, 60, 190, 24, -1);
hazardEdgeZ(190, 204, 60, 24, 1);
Cyl(35, 12, 130, 8, 14, 'tank');
Cyl(85, 12, 130, 8, 14, 'tank');
Cyl(90, 12, 170, 7, 16, 'tank'); // T08 が上に乗る
B(40, 12, 160, 52, 20, 172, 'machine');
B(100, 12, 128, 108, 16, 134, 'crate'); // 遮蔽
B(70, 12, 176, 78, 16, 182, 'crate');
B(100, 12, 108, 112, 18, 116, 'machine');
B(2, 36, 148, 124, 38, 150, 'steel');
Lamp(60, 49, 150, 'skylight', 0xdde8ff);
Lamp(90, 29, 170, 'warning', 0xff3020);
Lamp(13, 33, 203, 'warning', 0xffa020);

// S09 冷却設備 -------------------------------------------------------------
Cyl(30, 24, 245, 10, 22, 'tank');
Cyl(80, 24, 280, 10, 22, 'tank');
Cyl(30, 24, 290, 8, 18, 'tank');
B(96, 24, 240, 106, 32, 250, 'machineDark'); // ポンプ室（T09）
B(2, 40, 262, 118, 42, 264, 'pipe');
B(50, 24, 216, 58, 27, 226, 'machine');
Lamp(60, 55, 250, 'skylight', 0xbfe8ff);
Lamp(121, 33, 219, 'warning', 0xffa020);
Lamp(121, 33, 297, 'warning', 0xffa020);

// S10 変電区画 -------------------------------------------------------------
B(150, 24, 236, 160, 32, 246, 'machine');
B(200, 24, 212, 210, 30, 220, 'machine');
B(215, 24, 236, 225, 30, 244, 'machine');
B(176, 24, 240, 182, 36, 248, 'steel'); // 鉄塔（T10）
Lamp(180, 49, 230, 'skylight', 0xdde8ff);
Lamp(170, 30, 216, 'lamp', 0x80c0ff);

// S11 排水路 ---------------------------------------------------------------
B(160, 24, 256, 162, 46, 296, 'wallRust');
B(200, 24, 266, 202, 46, 306, 'wallRust');
B(130, 24, 270, 150, 27, 272, 'concrete');
B(170, 24, 280, 190, 27, 282, 'concrete');
B(210, 24, 290, 230, 27, 292, 'concrete');
B(214, 24, 272, 222, 27, 274, 'concrete');
Lamp(140, 45, 285, 'lamp', 0x80ffd0);
Lamp(180, 45, 280, 'lamp', 0x80ffd0);
Lamp(220, 45, 280, 'lamp', 0x80ffd0);

// S12 排気縦坑 -------------------------------------------------------------
B(244, 23, 220, 252, 24, 292, 'catwalk'); // 西側足場（高さ24m）
hazardEdgeZ(220, 292, 252, 24, 1);
B(274, 3, 236, 280, 6, 244, 'machineDark'); // T11 台座
B(276, 40, 240, 280, 56, 256, 'machine'); // 排気ファン
B(276, 40, 262, 280, 56, 278, 'machine');
B(254, -14, 224, 262, -11, 232, 'rust');
B(262, -14, 250, 266, -12, 262, 'rust');
Lamp(262, 62, 256, 'skylight', 0xdde8ff);
Lamp(279, -5, 277, 'warning', 0xff3020);
Lamp(250, 30, 256, 'warning', 0xffa020);

// S13 地下搬送区画 ---------------------------------------------------------
B(282, -14, 254, 408, -2, 258, 'wall'); // 中央の搬送機壁（U字）
B(296, -14, 272, 400, -12, 276, 'machine');
B(310, -14, 236, 400, -12, 240, 'machine');
for (const x of [320, 360]) {
  pillar(x, 294, -14, -2, 2);
  pillar(x, 216, -14, -2, 2);
}
B(396, -14, 214, 404, -9, 222, 'machineDark'); // T12 台座
Lamp(330, -2.5, 282, 'lamp', 0xffb060);
Lamp(400, -2.5, 282, 'lamp', 0xffb060);
Lamp(420, -2.5, 256, 'warning', 0xffa020);
Lamp(360, -2.5, 230, 'lamp', 0xffb060);
Lamp(298, -2.5, 222, 'warning', 0x40ff80);

// S14 主製造ホール ---------------------------------------------------------
B(380, 0, 292, 432, 12, 306, 'concrete'); // 南東回廊（A5）
hazardEdgeX(380, 432, 292, 12, -1);
hazardEdgeZ(292, 306, 380, 12, -1);
B(320, 0, 240, 336, 12, 256, 'machine'); // プレス機
B(380, 0, 240, 396, 12, 256, 'machine');
B(356, 0, 256, 364, 14, 264, 'machineDark'); // T13 の台
B(300, 0, 270, 316, 5, 282, 'machine');
B(410, 0, 216, 424, 6, 230, 'machine');
pillar(340, 214, 0, 34, 2);
pillar(400, 280, 0, 34, 2);
B(284, 26, 262, 430, 28, 264, 'steel');
Lamp(330, 33, 260, 'skylight', 0xdde8ff);
Lamp(400, 33, 230, 'skylight', 0xdde8ff);
Lamp(418, 21, 306, 'warning', 0xffa020);

// S15 出荷倉庫 -------------------------------------------------------------
B(372, 12, 340, 378, 22, 396, 'crate');
B(392, 12, 330, 398, 22, 396, 'crate');
B(412, 12, 340, 418, 22, 400, 'crate');
B(364, 12, 312, 370, 15, 320, 'crate');
Lamp(395, 39, 360, 'skylight', 0xdde8ff);
Lamp(357, 21, 323, 'warning', 0xffa020);

// S16 外周搬送路 -----------------------------------------------------------
B(210, 12, 340, 346, 14, 346, 'machine');
B(270, 12, 348, 278, 20, 356, 'machineDark'); // T14 台
for (const x of [230, 310]) pillar(x, 312, 12, 36, 2);
Lamp(280, 35, 330, 'skylight', 0xdde8ff);

// S17 梱包区画 -------------------------------------------------------------
B(300, 12, 358, 302, 36, 398, 'wallRust');
B(250, 12, 368, 252, 36, 408, 'wallRust');
B(320, 12, 370, 328, 16, 378, 'crate');
B(336, 12, 386, 344, 15, 392, 'crate');
B(270, 12, 380, 278, 16, 390, 'crate');
B(262, 12, 398, 268, 15, 404, 'crate');
B(220, 12, 372, 230, 16, 380, 'crate');
Lamp(280, 35, 385, 'skylight', 0xdde8ff);

// S18 搬出ゲート -----------------------------------------------------------
B(80, 0, 340, 98, 8, 376, 'concrete'); // 搬出台（A6）
hazardEdgeZ(340, 376, 98, 8, 1);
B(188, 11, 312, 198, 12, 334, 'catwalk');
B(188, 11, 386, 198, 12, 408, 'catwalk');
container(120, 330, 0, 12, 'x', 'containerRed');
container(140, 360, 0, 18, 'z', 'containerBlue');
container(110, 390, 0, 12, 'x', 'containerGreen');
container(160, 350, 0, 12, 'x', 'containerRed');
B(110, 0, 316, 118, 10, 324, 'machineDark'); // T15 台
Lamp(79, 17, 358, 'warning', 0x40ff80);
Lamp(140, 35, 358, 'skylight', 0xdde8ff);

// S19 脱出路 ---------------------------------------------------------------
Lamp(40, 23, 358, 'skylight', 0xffffff);
Lamp(22, 16, 358, 'warning', 0x40ff80);

export const PROPS = props;
export const DECALS = decals;
export const CYLINDERS = cylinders;
export const LIGHTS = lights;
