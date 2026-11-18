/**
 * Recorded routes of the shipped stage (docs/SPEC.md §2.2 "攻略経路の座標").
 *
 * A route is written as KEY waypoints (player hit-box centres resting on a floor, with notes) and expanded
 * with the corner points stored in ROUTE_VIAS, so that the expanded polyline can be followed exactly as
 * drawn: a level segment is a straight walk over continuous floor, a climb rises at its lower end and flies
 * level to the landing, a drop walks level off an edge and falls at its far end. tools/validateStage.ts
 * checks exactly that for every segment (V14) and plays both routes with the real simulation.
 *
 * ROUTE_VIAS is generated: after changing geometry or key waypoints run
 *   npx tsx tools/validateStage.ts --refine-route
 * and paste its output over the table below.
 */
import type { V3 } from '../core/vec';
import { stand } from './layout';

export interface RouteKey {
  position: V3;
  note?: string;
}

const k = (x: number, surfaceY: number, z: number, note?: string): RouteKey => (note ? { position: stand(x, surfaceY, z), note } : { position: stand(x, surfaceY, z) });

// ── stretches shared by the recommended route and the detour route ──
const START_TO_VESTIBULE: RouteKey[] = [
  k(20, 0, 90, '出撃地点。正面(-Z)は60 m以上の直線レーン'),
  k(20, 0, 24),
  k(20, 0, 8, '連絡路。東へ'),
  k(84, 0, 8),
  k(84, 0, 24, '資材ヤード入口。マスト上の制御砲台T01(139,28)を射撃 → 隔壁B1開放'),
  k(104, 0, 23, 'ヤード南縁をコンテナ列に沿って東へ（中央の広場は十字砲火）'),
  k(163, 0, 84, 'F1離陸点（+10 m）'),
  k(177, 10, 84, 'F1着地（隔壁B1の手前）'),
  k(187, 10, 84, '隔壁B1を抜けた張り出し。北はクレーンデッキ(+10 m)へ続く'),
  k(194, 4, 84, '圧延棟の床へ降下'),
  k(300, 4, 61, '制御室南扉'),
  // 6 m north of the southern relay-cabinet row (z 57..60, 5 m high): nearer to it the chase camera of a mech
  // that aims at T04 looks over the cabinet top and the cabinet hides the mech (at z = 62.5: 1 of 18 sample
  // points of the mech visible; here and along the whole walk from the door: 18 of 18).
  k(324, 4, 66, '制御砲台T04(341,75)を射撃 → 隔壁B2開放'),
  k(300, 4, 61),
  k(303, 4, 18, 'F2離陸点（+12 m）'),
  k(317, 16, 18, 'F2着地（搬送縦坑の入口足場）'),
  k(327, 10, 13, '縦坑の床へ降下'),
  k(343, 10, 29, 'F3離陸点（+12 m）'),
  k(357, 22, 29, 'F3着地（隔壁B2の手前）'),
  k(368, 22, 29, '前室。分岐BR1: バルコニー開口から床面へ / 南端から部品搬送回廊(S18)へ / 北扉から西通路(+22 m)へ'),
];
const B3_TO_T08: RouteKey[] = [
  k(452, 28, 107, 'F4着地（隔壁B3の手前）'),
  k(460, 28, 118, '隔壁B3を抜けた張り出し。分岐BR2: 上階を直進 / 下階を迂回'),
  k(460, 26, 125, '検査棟上階(+26 m)へ降りる'),
  k(449, 26, 146.5, '床開口H2の縁から下階の制御砲台T08(449,163)を射撃 → 隔壁B4開放'),
];
const F5_TO_TUNNEL: RouteKey[] = [
  k(387, 26, 192, 'F5離陸点（+8 m）'),
  k(372, 34, 192, 'F5着地。配管区画を西へ'),
  k(256, 34, 192, '隔壁B4'),
  k(240, 34, 190, '動力棟の入口バルコニー。北は制御ギャラリーと中央キャットウォーク(+34 m)へ続く'),
  k(228, 26, 183, 'バルコニー西縁から床面へ降下'),
  k(126, 26, 127, 'F6離陸点の北側入口（防爆壁の陰）'),
  k(117, 26, 116, 'F6離陸点（+14 m）'),
  k(103, 40, 116, 'F6着地（防爆壁の内側）'),
  k(93, 40, 115, '防爆壁の開口からキャットウォーク環へ。制御砲台T11(55,153)を射撃 → 隔壁B5開放'),
  k(17, 40, 115),
  k(17, 40, 180),
  k(10, 32, 180, 'キャットウォーク西縁から床面へ降下'),
  k(10, 32, 194, 'F7離陸点（+14 m）'),
  k(10, 46, 207, 'F7着地（隔壁B5の手前）'),
  k(20, 46, 217, '隔壁B5を抜けた張り出し。排気縦坑を降下'),
  k(36, 30, 232, '足場 +30 m'),
  k(12, 14, 238, '足場 +14 m'),
  k(36, -1, 238, '足場 -1 m'),
  k(38, -12, 220, '縦坑底'),
  k(40, -12, 212, '東の扉へ'),
  k(60, -12, 212, '地下搬送区画。分岐BR3: 直通トンネル / 側道'),
];
const TUNNEL_EAST_TO_HALL: RouteKey[] = [
  k(240, -12, 212),
  k(258, -12, 210, '主製造ホール入口前室。分岐BR4: 北扉から最下層へ / 天井ハッチから保守回廊(S19)へ'),
];
const WAREHOUSE_TO_EXIT: RouteKey[] = [
  k(456, 0, 312, '出荷倉庫'),
  k(339, 0, 316),
  k(337, 0, 385, '西扉'),
  k(320, 0, 385, '外周搬送路を西へ（中央レーンは2体の警備ロボットの射線。両側の廃車が遮蔽）'),
  k(200, 0, 385),
  k(70, 0, 385),
  k(48, 0, 385, '搬出ゲート区画'),
  k(20, 0, 330, '最終ゲート（6基破壊で開放）'),
  k(30, 0, 288, '脱出領域'),
];

/** Recommended route (the A side of every branch). */
export const MAIN_KEYS: RouteKey[] = [
  ...START_TO_VESTIBULE,
  k(368, 22, 36, 'バルコニー開口'),
  k(376, 14, 36, '床面へ降下。マスト上の制御砲台T06(360,90)を射撃 → 隔壁B3開放'),
  k(452, 14, 93, 'F4離陸点（+14 m、防爆壁の内側）'),
  ...B3_TO_T08,
  ...F5_TO_TUNNEL,
  k(110, -12, 209, '直通トンネル: 崩落孔の南側（幅7 m）を通過'),
  ...TUNNEL_EAST_TO_HALL,
  k(262, -12, 226, '北扉を出て最下層へ。砲塔上の制御砲台T14(366,264,+3 m)を射撃 → 隔壁B6開放'),
  k(440, -12, 270, '最下層を横断（または保守回廊S19を迂回）'),
  k(452, -12, 272, '北ギャラリーの真下'),
  k(452, 0, 289, '北ギャラリー(0 m)へ12 m上昇'),
  k(452, 0, 296, '隔壁B6（扉の西半分）'),
  ...WAREHOUSE_TO_EXIT,
];

/**
 * Detour route: the covered / longer alternative (B) of all four branches — the parts gallery S18 around the
 * assembly hall, the lower storey of the inspection building, the side tunnel and the service gallery S19
 * around the main hall. The control turrets T06 and T14 stand inside their halls, so this route steps into
 * the hall to shoot them and returns to the detour.
 */
export const DETOUR_KEYS: RouteKey[] = [
  ...START_TO_VESTIBULE,
  k(368, 22, 36, 'バルコニー開口からマスト上の制御砲台T06(360,90)を射撃 → 隔壁B3開放'),
  k(368, 22, 10, '分岐BR1-B: 前室の南端'),
  k(380, 22, 11, '部品搬送回廊（南辺）。銃眼からホールの敵に撃たれる'),
  k(469, 22, 11),
  k(469, 22, 93, '部品搬送回廊（東辺）の北端'),
  k(468, 28, 106, '搬入開口F4の東半分へ6 m上昇'),
  k(463, 28, 110, '隔壁B3の手前'),
  ...B3_TO_T08.slice(1),
  k(433, 26, 135, '分岐BR2-B: 床開口H1の東縁'),
  k(426, 18, 135, '下階へ降下'),
  k(393, 18, 138, '下階の西側通路'),
  k(393, 18, 160, '床開口H3の真下'),
  k(393, 26, 177, '8 m上昇して上階へ復帰'),
  ...F5_TO_TUNNEL,
  k(60, -12, 259, '分岐BR3-B: 西連絡から側道へ'),
  k(110, -12, 259),
  k(240, -12, 259, '東連絡で直通トンネルへ戻る'),
  ...TUNNEL_EAST_TO_HALL,
  k(262, -12, 226, '北扉から最下層へ出て砲塔上の制御砲台T14(366,264,+3 m)を射撃 → 隔壁B6開放'),
  k(262, -12, 209, '分岐BR4-B: 入口前室へ戻り、天井ハッチの真下へ'),
  k(274, 0, 209, 'ハッチを通って12 m上昇、保守回廊へ'),
  k(380, 0, 211, '保守回廊（南辺）。銃眼からホールの敵に撃たれる'),
  k(468, 0, 211),
  k(468, 0, 290, '保守回廊（東辺）の北端'),
  k(463.5, 0, 296, '隔壁B6（扉の東半分）'),
  k(463.5, 0, 312),
  ...WAREHOUSE_TO_EXIT,
];

/** Corner points between key waypoints, keyed "x,y,z>x,y,z" (player centres). GENERATED — see the header. */
export const ROUTE_VIAS: Record<string, Array<[number, number, number]>> = {
  '20,2,8>84,2,8': [[40.5, 2, 8.5], [53.5, 2, 8.5], [54.5, 2, 7.5]],
  '104,2,23>163,2,84': [[114.5, 2, 33.5], [114.5, 2, 35.5], [144.5, 2, 60.5], [155.5, 2, 60.5]],
  '194,6,84>300,6,61': [[204.5, 6, 72.5], [273.5, 6, 73.5], [291.5, 6, 65.5]],
  '300,6,61>303,6,18': [[301.5, 6, 58.5]],
  '327,12,13>343,12,29': [[333.5, 12, 18.5]],
  '376,16,36>452,16,93': [[378.5, 16, 43.5], [394.5, 16, 53.5], [394.5, 16, 55.5], [412.5, 16, 59.5], [418.5, 16, 67.5], [439.5, 16, 82.5], [452.5, 16, 82.5], [452.5, 16, 91.5]],
  '449,28,146.5>387,28,192': [[435.5, 28, 150.5], [411.5, 28, 163.5], [388.5, 28, 186.5]],
  '228,28,183>126,28,127': [[216.5, 28, 183.5], [184.5, 28, 177.5]],
  '10,48,207>20,48,217': [[14.5, 48, 210.5]],
  '60,-10,212>110,-10,209': [[68.5, -10, 215.5], [77.5, -10, 215.5], [82.5, -10, 210.5]],
  '110,-10,209>240,-10,212': [[148.5, -10, 211.5], [211.5, -10, 212.5]],
  '262,-10,226>440,-10,270': [[280.5, -10, 224.5], [329.5, -10, 224.5], [345.5, -10, 234.5], [348.5, -10, 237.5], [374.5, -10, 245.5], [383.5, -10, 246.5], [386.5, -10, 253.5], [429.5, -10, 260.5]],
  '456,2,312>339,2,316': [[437.5, 2, 313.5]],
  '339,2,316>337,2,385': [[334.5, 2, 344.5], [334.5, 2, 380.5]],
  '48,2,385>20,2,330': [[35.5, 2, 356.5]],
  '380,24,11>469,24,11': [[431.5, 24, 10.5]],
  '469,24,11>469,24,93': [[469.5, 24, 38.5]],
  '426,20,135>393,20,138': [[415.5, 20, 144.5], [405.5, 20, 143.5]],
  '60,-10,259>110,-10,259': [[91.5, -10, 258.5]],
  '110,-10,259>240,-10,259': [[185.5, -10, 258.5]],
  '274,2,209>380,2,211': [[343.5, 2, 211.5]],
  '380,2,211>468,2,211': [[386.5, 2, 209.5], [428.5, 2, 209.5], [430.5, 2, 211.5]],
  '463.5,2,312>456,2,312': [[460.5, 2, 313.5], [456.5, 2, 313.5]],
};

/** Key waypoints + stored corner points. */
export function expandRoute(keys: RouteKey[]): RouteKey[] {
  const out: RouteKey[] = [];
  const id = (p: V3): string => `${p.x},${p.y},${p.z}`;
  keys.forEach((key, i) => {
    if (i > 0) {
      const via = ROUTE_VIAS[`${id(keys[i - 1].position)}>${id(key.position)}`];
      if (via) for (const [x, y, z] of via) out.push({ position: { x, y, z } });
    }
    out.push(key);
  });
  return out;
}
