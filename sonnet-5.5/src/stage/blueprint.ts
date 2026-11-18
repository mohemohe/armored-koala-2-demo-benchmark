/**
 * ステージ骨格 (blueprint): 区画・接続(portal)・隔壁・制御砲台・昇降・経路の「データ」。
 * 座標: 東+x / 南+z / 上+y。区画boundsは殻(床スラブ2m・壁2m・天井スラブ2m)を含む外形で、隣接区画は境界面を共有する。
 * 区画の内部(掩蔽物・設備・敵配置)は src/stage/sectors/Sxx.ts が作る。ここの数値(bounds/portal/隔壁/昇降/予算)は
 * tests/stage-blueprint.test.ts と src/stage/validate.ts が検証するため、区画担当は変更しない。
 */
import type { AABB, BarrierDef, BranchDef, ClimbDef, PortalDef, RouteDef, SectorDef, SectorKind, V3 } from '../sim/types';
import { ROUTE_BRANCH_POINTS, ROUTE_MAIN_POINTS } from './routes';

export const WALL = 2; // 壁・スラブ厚
export const DOOR_W = 14;
export const DOOR_H = 8;
export const PLAYER_CY = 1.5; // プレイヤー中心の床上高

const v = (x: number, y: number, z: number): V3 => ({ x, y, z });

function sector(
  id: string, name: string, kind: SectorKind,
  x0: number, x1: number, z0: number, z1: number,
  floorY: number, ceilingY: number, combat: boolean, note: string,
): SectorDef {
  return {
    id, name, kind,
    bounds: { min: v(x0, floorY - WALL, z0), max: v(x1, ceilingY + WALL, z1) },
    floorY, ceilingY, combat, note,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// 区画 (20): 主経路 S01..S15 + 脱出領域 S16 + 分岐用の迂回 S17..S20
// ---------------------------------------------------------------------------------------------------------------------
export const SECTORS: SectorDef[] = [
  sector('S01', '搬入口', 'dock', 0, 70, 0, 140, 0, 14, false, '開始区画。北西の3方壁の搬入口一角から出撃'),
  sector('S02', '資材ヤード', 'yard', 70, 200, 0, 140, 0, 24, true, '屋内の広い資材置場。北に迂回路S17への扉'),
  sector('S03', '圧延棟', 'factory', 200, 330, 0, 140, 0, 26, true, '圧延機のある製造室。制御B1。北にS17からの合流扉'),
  sector('S04', '搬送縦坑', 'shaft', 330, 390, 60, 140, 0, 26, false, '昇降C1: 地上0→+12m'),
  sector('S05', '組立ライン', 'factory', 390, 530, 0, 140, 12, 34, true, '中層(+12)の組立ライン。北にS18への扉'),
  sector('S06', '検査棟', 'multilevel', 530, 640, 0, 140, 12, 40, false, '昇降C2: +12→+24。制御B2。S18からの合流扉'),
  sector('S07', '保守用配管区画', 'pipe', 530, 640, 140, 280, 24, 40, false, '上層(+24)の配管ラック。南にS19への扉'),
  sector('S08', '動力棟', 'multilevel', 390, 530, 140, 280, 0, 40, true, '+24の南ギャラリーから地上へ降りる吹き抜け。制御B3'),
  sector('S09', '冷却設備', 'factory', 270, 390, 140, 280, 0, 30, true, '昇降C3: 0→+12'),
  sector('S10', '排気縦坑', 'shaft', 210, 270, 200, 280, -14, 26, false, '+12の張り出しから地下-14へ降下する縦坑'),
  sector('S11', '地下搬送区画', 'corridor', 80, 210, 140, 280, -14, 12, true, '地下(-14)。昇降C4: -14→0。制御B4'),
  sector('S12', '主製造ホール', 'multilevel', 0, 220, 280, 430, 0, 42, true, '最大の上下層(0/+12/+24)。昇降C5,C6。南にS20への扉'),
  sector('S13', '出荷倉庫', 'warehouse', 220, 350, 340, 490, 0, 40, true, '+24の西ギャラリーから降下する倉庫。制御B5'),
  sector('S14', '外周搬送路', 'corridor', 350, 500, 340, 490, 0, 30, true, '昇降C7: 0→+12。制御B6'),
  sector('S15', '搬出ゲート', 'gate', 500, 640, 340, 490, 12, 40, false, '昇降C8: +12→+24。最終ゲートGATE'),
  sector('S16', '脱出領域', 'yard', 640, 720, 340, 490, 24, 40, false, '最終ゲートの先。脱出ゾーン'),
  sector('S17', '旧搬送トンネル', 'corridor', 100, 300, -40, 0, 0, 12, false, '分岐1の迂回路(S02→S03)。低く狭いが遮蔽が多い'),
  sector('S18', '屋根裏保守通路', 'corridor', 390, 640, -50, 0, 12, 24, false, '分岐2の迂回路(S05→S06)'),
  sector('S19', '上層配管ダクト', 'pipe', 400, 640, 280, 340, 24, 36, false, '分岐3の迂回路(S07→S08)'),
  sector('S20', '旧倉庫', 'warehouse', 120, 220, 430, 510, 24, 36, false, '分岐4の迂回路(S12→S13)'),
];

export const SECTOR_BY_ID: Record<string, SectorDef> = Object.fromEntries(SECTORS.map((s) => [s.id, s]));

/** 敵の予算(区画別)。警備30・砲台15・うち制御6。区画モジュールはこの数を守る(テストで検証) */
export const ENEMY_BUDGET: Record<string, { guard: number; turret: number }> = {
  S01: { guard: 2, turret: 0 },
  S02: { guard: 4, turret: 2 },
  S03: { guard: 3, turret: 2 }, // 制御B1
  S05: { guard: 4, turret: 2 },
  S06: { guard: 2, turret: 1 }, // 制御B2
  S07: { guard: 1, turret: 0 },
  S08: { guard: 3, turret: 2 }, // 制御B3
  S09: { guard: 2, turret: 1 },
  S11: { guard: 2, turret: 1 }, // 制御B4
  S12: { guard: 4, turret: 2 },
  S13: { guard: 3, turret: 1 }, // 制御B5
  S14: { guard: 0, turret: 1 }, // 制御B6
};
/** 制御砲台(B1..B6 = controlIndex 0..5)が属する区画 */
export const CONTROL_SECTORS = ['S03', 'S06', 'S08', 'S11', 'S13', 'S14'] as const;

// ---------------------------------------------------------------------------------------------------------------------
// 接続 (portal): a→b は攻略の進行方向。開口は両区画の殻で同じ位置・大きさに空く
// ---------------------------------------------------------------------------------------------------------------------
export const PORTAL_AXIS: Record<string, 'x' | 'z'> = {};

function portal(
  axis: 'x' | 'z', id: string, a: string, b: string, plane: number, lateral: number, sill: number,
  kind: PortalDef['kind'], barrierId: string | null = null, width = DOOR_W, height = DOOR_H,
): PortalDef {
  PORTAL_AXIS[id] = axis;
  const center = axis === 'x' ? v(plane, sill + height / 2, lateral) : v(lateral, sill + height / 2, plane);
  return { id, a, b, center, width, height, kind, barrierId };
}
const px = (id: string, a: string, b: string, x: number, z: number, sill: number, kind: PortalDef['kind'], barrier: string | null = null) =>
  portal('x', id, a, b, x, z, sill, kind, barrier);
const pz = (id: string, a: string, b: string, z: number, x: number, sill: number, kind: PortalDef['kind'], barrier: string | null = null) =>
  portal('z', id, a, b, z, x, sill, kind, barrier);

export const PORTALS: PortalDef[] = [
  // 主経路
  px('P01', 'S01', 'S02', 70, 120, 0, 'door'),
  px('P02', 'S02', 'S03', 200, 20, 0, 'door'),
  px('P03', 'S03', 'S04', 330, 100, 0, 'door', 'B1'),
  px('P04', 'S04', 'S05', 390, 100, 12, 'shaft'),
  px('P05', 'S05', 'S06', 530, 20, 12, 'door'),
  pz('P06', 'S06', 'S07', 140, 620, 24, 'catwalk', 'B2'),
  px('P07', 'S07', 'S08', 530, 266, 24, 'catwalk'),
  px('P08', 'S08', 'S09', 390, 156, 0, 'door', 'B3'),
  px('P09', 'S09', 'S10', 270, 266, 12, 'catwalk'),
  px('P10', 'S10', 'S11', 210, 214, -14, 'tunnel'),
  pz('P11', 'S11', 'S12', 280, 92, 0, 'catwalk', 'B4'),
  px('P12', 'S12', 'S13', 220, 354, 24, 'catwalk'),
  px('P13', 'S13', 'S14', 350, 352, 0, 'door', 'B5'),
  px('P14', 'S14', 'S15', 500, 474, 12, 'catwalk', 'B6'),
  px('P15', 'S15', 'S16', 640, 352, 24, 'door', 'GATE'),
  // 分岐の迂回路
  pz('P16', 'S02', 'S17', 0, 120, 0, 'tunnel'),
  pz('P17', 'S17', 'S03', 0, 280, 0, 'tunnel'),
  pz('P18', 'S05', 'S18', 0, 410, 12, 'tunnel'),
  pz('P19', 'S18', 'S06', 0, 620, 12, 'tunnel'),
  pz('P20', 'S07', 'S19', 280, 600, 24, 'tunnel'),
  pz('P21', 'S19', 'S08', 280, 420, 24, 'catwalk'),
  pz('P22', 'S12', 'S20', 430, 200, 24, 'catwalk'),
  px('P23', 'S20', 'S13', 220, 470, 24, 'catwalk'),
];

// ---------------------------------------------------------------------------------------------------------------------
// 隔壁 (B1..B6, GATE): boxIds / controlEnemyId は StageBuilder.finish() が埋める
// ---------------------------------------------------------------------------------------------------------------------
export const BARRIER_INFO: { id: string; portalId: string; label: string; isFinal: boolean }[] = [
  { id: 'B1', portalId: 'P03', label: '圧延棟東の隔壁(搬送縦坑へ)', isFinal: false },
  { id: 'B2', portalId: 'P06', label: '検査棟南の隔壁(配管区画へ)', isFinal: false },
  { id: 'B3', portalId: 'P08', label: '動力棟西の隔壁(冷却設備へ)', isFinal: false },
  { id: 'B4', portalId: 'P11', label: '地下搬送区画南の隔壁(主製造ホールへ)', isFinal: false },
  { id: 'B5', portalId: 'P13', label: '出荷倉庫東の隔壁(外周搬送路へ)', isFinal: false },
  { id: 'B6', portalId: 'P14', label: '外周搬送路東の隔壁(搬出ゲートへ)', isFinal: false },
  { id: 'GATE', portalId: 'P15', label: '最終搬出ゲート', isFinal: true },
];

export function barrierSkeleton(): BarrierDef[] {
  return BARRIER_INFO.map((b) => {
    const p = PORTALS.find((x) => x.id === b.portalId) as PortalDef;
    return { id: b.id, boxIds: [], controlEnemyId: null, isFinal: b.isFinal, label: b.label, pos: { ...p.center } };
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// 昇降 (飛行が必要): from = 下の足場の上面の点, to = 上の足場の上面の点 (どちらも足場の縁から6m以上内側)
// ---------------------------------------------------------------------------------------------------------------------
/** 昇降の足場矩形(上面の高さ y)。区画モジュールは kit.climbPads(id) でこの足場を作る */
export interface PadRect { x0: number; z0: number; x1: number; z1: number; y: number }
export interface ClimbSpec { id: string; sectorId: string; from: V3; to: V3; toPad: PadRect; fromPad: PadRect | null; note: string }

export const CLIMB_SPECS: ClimbSpec[] = [
  { id: 'C1', sectorId: 'S04', from: v(352, 0, 100), to: v(366, 12, 100), toPad: { x0: 360, z0: 84, x1: 388, z1: 118, y: 12 }, fromPad: null, note: '搬送縦坑: 床から+12mの張り出し足場へ' },
  { id: 'C2', sectorId: 'S06', from: v(584, 12, 96), to: v(594, 24, 106), toPad: { x0: 590, z0: 100, x1: 638, z1: 138, y: 24 }, fromPad: null, note: '検査棟: 検査ギャラリー(+24)へ' },
  { id: 'C3', sectorId: 'S09', from: v(304, 0, 228), to: v(300, 12, 242), toPad: { x0: 272, z0: 236, x1: 312, z1: 278, y: 12 }, fromPad: null, note: '冷却設備: 冷却塔デッキ(+12)へ' },
  { id: 'C4', sectorId: 'S11', from: v(138, -14, 256), to: v(122, 0, 256), toPad: { x0: 82, z0: 240, x1: 130, z1: 278, y: 0 }, fromPad: null, note: '地下搬送区画: 地上高さの搬出ギャラリー(0)へ14m' },
  { id: 'C5', sectorId: 'S12', from: v(160, 0, 292), to: v(160, 12, 306), toPad: { x0: 130, z0: 300, x1: 174, z1: 346, y: 12 }, fromPad: null, note: '主製造ホール: 中層ギャラリー(+12)へ' },
  { id: 'C6', sectorId: 'S12', from: v(168, 12, 322), to: v(188, 24, 332), toPad: { x0: 178, z0: 326, x1: 218, z1: 428, y: 24 }, fromPad: { x0: 130, z0: 300, x1: 174, z1: 346, y: 12 }, note: '主製造ホール: 中層から上層ギャラリー(+24)へ' },
  { id: 'C7', sectorId: 'S14', from: v(452, 0, 434), to: v(466, 12, 448), toPad: { x0: 458, z0: 440, x1: 498, z1: 488, y: 12 }, fromPad: null, note: '外周搬送路: 搬出橋(+12)へ' },
  { id: 'C8', sectorId: 'S15', from: v(590, 12, 396), to: v(604, 24, 382), toPad: { x0: 596, z0: 342, x1: 638, z1: 390, y: 24 }, fromPad: null, note: '搬出ゲート: ゲート前デッキ(+24)へ' },
];

export const CLIMBS: ClimbDef[] = CLIMB_SPECS.map((c) => ({
  id: c.id, sectorId: c.sectorId, from: c.from, to: c.to, heightMeters: c.to.y - c.from.y, note: c.note,
}));

/** 戦闘区画で常に空けておく床の矩形(60x50以上の障害物なし床)。区画担当はここに構造物を置かない */
export const ARENA_CLEAR: Record<string, { x0: number; z0: number; x1: number; z1: number }> = {
  S02: { x0: 80, z0: 36, x1: 170, z1: 100 },
  S03: { x0: 210, z0: 36, x1: 290, z1: 100 },
  S05: { x0: 400, z0: 30, x1: 490, z1: 96 },
  S08: { x0: 400, z0: 150, x1: 500, z1: 230 },
  S09: { x0: 276, z0: 146, x1: 360, z1: 206 },
  S11: { x0: 90, z0: 150, x1: 200, z1: 212 },
  S12: { x0: 10, z0: 300, x1: 110, z1: 380 },
  S13: { x0: 256, z0: 350, x1: 340, z1: 412 },
  S14: { x0: 360, z0: 346, x1: 450, z1: 420 },
};

// ---------------------------------------------------------------------------------------------------------------------
// 開始・脱出
// ---------------------------------------------------------------------------------------------------------------------
export const PLAYER_START = { pos: v(12, PLAYER_CY, 14), yaw: Math.PI }; // 南向き(+z)
export const ESCAPE_ZONE: AABB = { min: v(660, 24, 344), max: v(716, 38, 488) };
export const KILL_Y = -80;
export const STAGE_NAME = 'ARMORED KOALA 2 廃工場';

// ---------------------------------------------------------------------------------------------------------------------
// 経路 (プレイヤー中心座標)。src/stage/routes.ts は tools/route-probe.ts --emit が生成する(手で編集しない)。
// ---------------------------------------------------------------------------------------------------------------------
export const polyLength = (pts: readonly V3[]): number => {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y, pts[i].z - pts[i - 1].z);
  return l;
};
export const routeLen = (pts: readonly V3[]): number => Math.round(polyLength(pts) * 100) / 100;

/**
 * 分岐の経路の指定: start から legs を順に(各legは within の区画boundsの中だけを通って)最短でつなぐ。
 * tools/route-probe.ts が routes.ts を生成するときの入力。座標はプレイヤー中心(床+1.5)。各点は区画内部で常に空けておく(RESERVED)。
 */
export interface RouteLeg { to: V3; within: string[] }
const y1 = PLAYER_CY;
export const BRANCH_SPECS: Record<string, { start: V3; legs: RouteLeg[] }> = {
  'BR1-direct': { start: v(80, y1, 112), legs: [{ to: v(200, y1, 20), within: ['S02', 'S03'] }, { to: v(280, y1, 60), within: ['S03'] }] },
  'BR1-tunnel': { start: v(80, y1, 112), legs: [{ to: v(120, y1, 0), within: ['S02', 'S17'] }, { to: v(280, y1, -10), within: ['S17'] }, { to: v(280, y1, 0), within: ['S17', 'S03'] }, { to: v(280, y1, 60), within: ['S03'] }] },
  'BR2-direct': { start: v(400, 13.5, 100), legs: [{ to: v(530, 13.5, 20), within: ['S05', 'S06'] }, { to: v(576, 13.5, 50), within: ['S06'] }] },
  'BR2-attic': { start: v(400, 13.5, 100), legs: [{ to: v(410, 13.5, 0), within: ['S05', 'S18'] }, { to: v(620, 13.5, -10), within: ['S18'] }, { to: v(620, 13.5, 0), within: ['S18', 'S06'] }, { to: v(576, 13.5, 50), within: ['S06'] }] },
  'BR3-direct': { start: v(620, 25.5, 150), legs: [{ to: v(530, 25.5, 266), within: ['S07', 'S08'] }, { to: v(470, 25.5, 266), within: ['S08'] }] },
  'BR3-duct': { start: v(620, 25.5, 150), legs: [{ to: v(600, 25.5, 280), within: ['S07', 'S19'] }, { to: v(600, 25.5, 292), within: ['S19'] }, { to: v(420, 25.5, 292), within: ['S19'] }, { to: v(420, 25.5, 280), within: ['S19', 'S08'] }, { to: v(470, 25.5, 266), within: ['S08'] }] },
  'BR4-direct': { start: v(196, 25.5, 392), legs: [{ to: v(220, 25.5, 354), within: ['S12', 'S13'] }, { to: v(240, 25.5, 356), within: ['S13'] }] },
  'BR4-warehouse': { start: v(196, 25.5, 392), legs: [{ to: v(200, 25.5, 430), within: ['S12', 'S20'] }, { to: v(200, 25.5, 442), within: ['S20'] }, { to: v(220, 25.5, 470), within: ['S20', 'S13'] }, { to: v(240, 25.5, 356), within: ['S13'] }] },
};

/**
 * 区画内部で常に空けておく直方体(kit.box が例外を投げる): 出撃位置・分岐経路の起点/中継点・昇降の離陸柱と飛行コリドー。
 * 区画担当が置いたカバーで経路や昇降が塞がれないようにするため。
 */
export interface Reserved { id: string; min: V3; max: V3 }
export const RESERVED: Reserved[] = (() => {
  const out: Reserved[] = [];
  const box = (id: string, c: V3, rx: number, ry0: number, ry1: number, rz: number): void => {
    out.push({ id, min: v(c.x - rx, c.y + ry0, c.z - rz), max: v(c.x + rx, c.y + ry1, c.z + rz) });
  };
  box('start', PLAYER_START.pos, 2.5, -1.5, 1.6, 2.5);
  for (const [id, sp] of Object.entries(BRANCH_SPECS)) {
    box(`${id}.start`, sp.start, 2.5, -1.5, 1.6, 2.5);
    sp.legs.forEach((l, i) => box(`${id}.leg${i}`, l.to, 2.5, -1.5, 1.6, 2.5));
  }
  for (const c of CLIMB_SPECS) {
    // 離陸位置の真上(to の高さ+6mまで)と、着地足場の上のコリドー(from→to の水平範囲, to.y 〜 to.y+5)
    out.push({ id: `${c.id}.column`, min: v(c.from.x - 3, c.from.y + 0.01, c.from.z - 3), max: v(c.from.x + 3, c.to.y + 6, c.from.z + 3) });
    out.push({
      id: `${c.id}.corridor`,
      min: v(Math.min(c.from.x, c.to.x) - 3, c.to.y + 0.01, Math.min(c.from.z, c.to.z) - 3),
      max: v(Math.max(c.from.x, c.to.x) + 3, c.to.y + 5, Math.max(c.from.z, c.to.z) + 3),
    });
  }
  return out;
})();

/** 折れ線が通る区画IDを順に返す(objective.ts と同じ「最初にboundsが含む区画」規則, 1m刻み) */
export function sectorsAlong(pts: readonly V3[]): string[] {
  const out: string[] = [];
  const at = (p: V3): void => {
    const s = SECTORS.find((q) => p.x >= q.bounds.min.x && p.x <= q.bounds.max.x && p.y >= q.bounds.min.y && p.y <= q.bounds.max.y && p.z >= q.bounds.min.z && p.z <= q.bounds.max.z);
    if (s && out[out.length - 1] !== s.id && !out.includes(s.id)) out.push(s.id);
  };
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)));
    if (i === 1) at(a);
    for (let k = 1; k <= n; k++) at(v(a.x + ((b.x - a.x) * k) / n, a.y + ((b.y - a.y) * k) / n, a.z + ((b.z - a.z) * k) / n));
  }
  return out;
}

export const MAIN_ROUTE: RouteDef = {
  id: 'main',
  kind: 'main',
  note: 'スタートから脱出領域までの最短の実行可能経路(全隔壁開放・飛行可)。tools/route-probe.ts --emit の出力',
  points: ROUTE_MAIN_POINTS,
  sectorIds: sectorsAlong(ROUTE_MAIN_POINTS),
};

const br = (id: string, note: string, sectorIds: string[]) => ({
  id, note, sectorIds, points: ROUTE_BRANCH_POINTS[id], lengthMeters: routeLen(ROUTE_BRANCH_POINTS[id]),
});

/** 分岐: 各分岐の2経路は同じ始点(分岐区画内)と同じ終点(合流区画内)を共有する */
export const BRANCHES: BranchDef[] = [
  {
    id: 'BR1', splitSectorId: 'S02', mergeSectorId: 'S03',
    routes: [
      br('BR1-direct', '資材ヤードの東扉から圧延棟へ直行。短いが資材ヤードと圧延棟の砲台に多方向から狙われる', []),
      br('BR1-tunnel', '北の旧搬送トンネル(S17)経由。長いが低い天井と柱・機械で遮蔽が使える', ['S17']),
    ],
  },
  {
    id: 'BR2', splitSectorId: 'S05', mergeSectorId: 'S06',
    routes: [
      br('BR2-direct', '組立ラインを横断して検査棟の西扉へ。短いが組立ライン全域から射線が通る', []),
      br('BR2-attic', '屋根裏保守通路(S18)経由。長いが梁と配管に隠れて進める', ['S18']),
    ],
  },
  {
    id: 'BR3', splitSectorId: 'S07', mergeSectorId: 'S08',
    routes: [
      br('BR3-direct', '配管区画の西扉から動力棟の+24ギャラリーへ。短いが動力棟に上から露出する', []),
      br('BR3-duct', '上層配管ダクト(S19)経由。長いが太い配管が射線を切る', ['S19']),
    ],
  },
  {
    id: 'BR4', splitSectorId: 'S12', mergeSectorId: 'S13',
    routes: [
      br('BR4-direct', '上層ギャラリー東扉から出荷倉庫の西ギャラリーへ直行。短いがホール全体から見下ろされる', []),
      br('BR4-warehouse', '旧倉庫(S20)経由。長いが棚の陰に入れる', ['S20']),
    ],
  },
];

/** 環状経路: 各分岐の「直行 + 迂回の逆順」で始点に戻る閉路 */
export const LOOPS: RouteDef[] = BRANCHES.map((b) => {
  const direct = b.routes[0].points;
  const alt = b.routes[1].points;
  const pts = [...direct, ...[...alt].reverse().slice(1)];
  return { id: `LOOP-${b.id}`, kind: 'loop' as const, note: `${b.id} の直行路と迂回路を結ぶ環状経路`, points: pts, sectorIds: sectorsAlong(pts) };
});
