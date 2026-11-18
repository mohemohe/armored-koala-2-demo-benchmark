/**
 * S12 主製造ホール (multilevel): 最大の上下層。0(床)→+12(中層ギャラリーM)→+24(上層ギャラリーU) を昇降C5,C6で登る。廃工場の中心。
 *
 * 配置 (内寸 x2..218 / z282..428, 床0, 天井42。ARENA_CLEAR x10..110,z300..380 は床+3mまで空ける):
 *  - 天井: 屋根トラス5本(z方向) + 吊り灯 + 天窓。壁沿いの走行レール(y33..35.4)にクレーンの橋桁(z方向)・巻上機・吊り荷(アリーナ上空 y6..14)。
 *  - 南: 大型プレス2基(A: 4柱・クラウン・ラム・ボルスター、B: 小型)、加熱炉(橙の炉口)、コンテナヤード。
 *  - 東帯(x110..130): コンベア(低)+ロボットアームのセル(低い基台と高い腕)+サイロ(高)。M(+12, 機械基礎)はその東。
 *  - 西帯: 高さ+8の格子キャットウォークと、その下の資材(中/高)。北帯: 制御砲台でない砲台T12の台座、鉱石ホッパー(高)、低い掩蔽。
 *  - M の上: 制御室(ガラス)・タンク・木箱。U(+24, x178..218)の下は変圧器・コンテナの格納庫、上は砲台T13・掩蔽と門型ガントリー。
 *  - 敵: 警備4(地上2、M、U) + 砲台2(T12: 北西の高台座 +8m、T13: U 上の台座)。
 *  昇降C5/C6・ルート折れ線(routes.ts)・BR4の分岐点・扉の前(P11/P12/P22)は空けてある。
 */
import type { MaterialKey } from '../../sim/types';
import type { Kit } from '../kit';

export function build(k: Kit): void {
  const F = k.floorY; // 0
  const T = k.ceilingY; // 42
  const X0 = k.inner.x0; // 2
  const X1 = k.inner.x1; // 218
  const Z0 = k.inner.z0; // 282
  const Z1 = k.inner.z1; // 428
  const LOW = 1.2;
  const MID = 2.5;
  const HIGH = 6;
  const M = 12; // 中層(M)の上面
  const U = 24; // 上層(U)の上面

  // ================================================================== 昇降の足場 (C5: M, C6: U) と U の脚
  k.climbPads('C5', [], false, true); // M: 下を詰めた機械基礎
  k.climbPads('C6', [[216, 328], [216, 354], [216, 380], [216, 404], [216, 426], [182, 332], [182, 364], [182, 396], [182, 424]], true);
  // U の下の梁(脚と脚をつなぐ, y 15..16.2)
  for (const x of [182, 216]) k.box('u-beam', x - 0.6, 14.9, 332, x + 0.6, 16.1, 424, 'metal');
  for (const z of [332, 364, 396, 424]) k.box('u-beam', 182, 15, z - 0.6, 216, 16.2, z + 0.6, 'metal');

  // ================================================================== 屋根トラス(z方向) と吊り灯・天窓
  for (const x of [24, 66, 108, 150, 192]) {
    k.box('truss-top', x - 1.2, 40.6, Z0, x + 1.2, T, Z1, 'metalDark');
    k.box('truss-bot', x - 1.2, 36.6, Z0, x + 1.2, 38, Z1, 'metal');
    for (const z of [292, 313, 334, 355, 376, 397, 418]) k.box('truss-strut', x - 0.6, 38, z - 0.6, x + 0.6, 40.6, z + 0.6, 'metal');
    // 吊り灯: 一部は死んでいる(消えた灯具は暗い金属の枠だけ)
    for (const [i, z0] of [296, 342, 388].entries()) {
      const dead = (x * 3 + i * 5) % 7 === 0;
      k.box(dead ? 'roof-lamp-dead' : 'roof-lamp', x - 1.6, 36, z0, x + 1.6, 36.6, z0 + 12, dead ? 'metalDark' : 'lightPanel', dead ? {} : { emissive: 1 });
    }
  }
  // 天窓(屋根の下面に貼る青白い面)
  // (割れて抜け落ちた窓は屋根がそのまま見える)
  for (const [i, x] of [45, 87, 129, 171].entries()) {
    for (let j = 0; j < 12; j++) {
      if ((i * 5 + j * 3) % 7 === 0) continue;
      const z0 = 300 + j * 8.4;
      k.decor('skylight', x - 6, T - 0.14, z0, x + 6, T, z0 + 6.4, 'glass', { emissive: 0.45 });
    }
  }

  // ================================================================== 走行クレーン
  // 壁沿いの走行レール(北・南) と壁のブラケット柱
  k.box('runway', X0, 33, Z0, X1, 35.4, Z0 + 3.5, 'metalDark');
  k.box('runway', X0, 33, Z1 - 3.5, X1, 35.4, Z1, 'metalDark');
  for (const x of [14, 40, 66, 120, 146, 172]) k.pillar('pilaster', x, Z0 + 1.5, 3, F, 33, 'concreteDark');
  for (const x of [14, 46, 118, 146, 170]) k.pillar('pilaster', x, Z1 - 1.5, 3, F, 33, 'concreteDark');
  // 橋桁(z方向, x84..90) と 台車・巻上機・吊り荷(アリーナ上空)
  k.box('bridge', 84, 35.4, Z0, 90, 38.4, Z1, 'metal');
  k.box('trolley', 82, 38.4, 338, 92, 40, 352, 'machine');
  k.box('hoist', 83, 31, 341, 91, 35.4, 349, 'machine');
  k.box('rope', 85, 20.2, 344, 85.8, 31, 344.8, 'metalDark');
  k.box('rope', 88.2, 20.2, 344, 89, 31, 344.8, 'metalDark');
  k.box('spreader', 79, 19, 342.5, 95, 20.2, 346.5, 'metal');
  for (const [x, z] of [[80, 342.6], [93.3, 342.6], [80, 345.6], [93.3, 345.6]] as [number, number][]) k.box('sling', x, 14, z, x + 0.7, 19, z + 0.7, 'metalDark');
  k.box('payload', 78, 6, 338, 96, 14, 353, 'rust'); // 吊られた大型ダイ(型)
  k.box('payload-band', 77.4, 8.4, 338, 78, 11.6, 353, 'hazard');
  k.box('payload-band', 96, 8.4, 338, 96.6, 11.6, 353, 'hazard');
  k.box('crane-lamp', 84.4, 34.6, 312, 89.6, 35.4, 320, 'hazard', { emissive: 0.8 });
  // 北壁沿いの高所の配管(x方向, 天井のトラスから吊る)
  k.pipe('overhead-pipe', 'x', X0, 26.4, 296, 128, 28.8, 298.4, 'pipe');
  k.pipe('overhead-pipe', 'x', X0, 29.4, 296.4, 128, 31.8, 298.8, 'rust');
  for (const x of [24, 66, 108]) k.box('pipe-hanger', x - 0.5, 28.8, 296.6, x + 0.5, 36.6, 297.6, 'metalDark');

  // ================================================================== 北帯 (z282..300): T12・鉱石ホッパー・低い掩蔽
  k.turret(30, 288, 8, { face: [60, 340] });
  k.box('t12-beacon', 27.5, 5.6, 290.5, 32.5, 6.6, 291.1, 'hazard', { emissive: 1 });
  k.fbox('hopper', 104, 293, 118, 299, HIGH, 'concreteDark');
  k.fbox('hopper-base', 103.4, 292.4, 118.6, 293, LOW, 'hazard');
  k.fbox('hopper', 6, 292, 20, 298, HIGH, 'concreteDark');
  k.fbox('north-cover', 48, 291, 56, 297, LOW, 'metalDark');
  k.fbox('north-cover', 70, 292, 76, 297, MID, 'crate');
  k.fbox('north-cover', 128, 296.5, 138, 299.5, MID, 'machine'); // 経路の折れ線(z≒292)から離す
  k.fbox('north-cover', 142, 297, 152, 299.8, LOW, 'rust');
  // 崩れた足場の残骸(北西)
  k.fbox('debris', 36, 296, 42, 299, LOW, 'rust');
  k.box('debris-beam', 34, LOW, 297, 46, LOW + 1.2, 298.2, 'rust');

  // ================================================================== 西帯 (x2..10): 格子キャットウォーク(+8) とその下の資材
  k.box('west-cat', X0, 8, 300, 8.5, 9, 380, 'grating');
  k.box('west-cat-rail', 8, 9, 300, 8.5, 10.2, 380, 'metal');
  k.fbox('west-store', X0, 302, 8.5, 314, MID, 'crate');
  k.fbox('west-store', X0, 318, 8.5, 330, HIGH, 'rust');
  k.fbox('west-store', X0, 334, 8.5, 346, MID, 'crate');
  k.fbox('west-store', X0, 350, 8.5, 362, HIGH, 'metalDark');
  k.fbox('west-store', X0, 366, 8.5, 378, MID, 'crate');
  for (const z of [316, 332, 348, 364, 380]) k.pillar('west-col', 5, z - 0.4, 1.6, F, 8, 'metalDark');
  for (const z of [308, 340, 372]) k.box('west-lamp', X0, 7.2, z, 6, 8, z + 8, 'lightPanel', { emissive: 1 });

  // ================================================================== 東帯 (x110..130): コンベアとロボットセル
  for (const [z0, z1] of [[302, 322], [328, 348], [354, 378]] as [number, number][]) {
    k.fbox('belt', 116, z0, 119.5, z1, LOW, 'metalDark');
    k.decor('belt-top', 116.4, LOW, z0 + 0.5, 119.1, LOW + 0.06, z1 - 0.5, 'hazard');
  }
  for (const cz of [312, 338, 366]) {
    k.fbox('robot-base', 121, cz - 3, 127, cz + 3, LOW, 'machine');
    k.box('robot-col', 123.2, LOW, cz - 0.8, 124.8, 6.6, cz + 0.8, 'metal');
    k.box('robot-arm', 117, 6.6, cz - 0.7, 124.8, 8, cz + 0.7, 'metalDark');
    k.box('robot-claw', 117, 5, cz - 0.8, 118.6, 6.6, cz + 0.8, 'metal');
    k.box('robot-tip', 117.2, 4.4, cz - 0.6, 118.4, 5, cz + 0.6, 'hazard', { emissive: 0.9 });
  }
  k.fbox('silo', 120, 322, 128, 330, HIGH, 'metal');
  k.fbox('silo', 120, 346, 128, 356, HIGH, 'metalDark');
  k.fbox('silo', 120, 372, 128, 380, HIGH, 'rust');
  for (const z of [326, 351, 376]) k.box('silo-lamp', 119.4, 4.2, z - 2, 120, 5.2, z + 2, 'lightPanel', { emissive: 1 });

  // ================================================================== M (+12) の上
  // 制御室(ガラス張り)、タンク、木箱、縁の警告帯
  k.box('cabin-base', 134, M, 330, 148, M + MID, 344, 'machine');
  k.box('cabin-glass', 134.6, M + MID, 330.6, 147.4, M + HIGH, 343.4, 'glass');
  k.box('cabin-roof', 134, M + HIGH, 330, 148, M + HIGH + 0.6, 344, 'metal');
  k.box('cabin-lamp', 138, M + HIGH + 0.6, 336, 144, M + HIGH + 1.2, 338, 'hazard', { emissive: 0.9 });
  k.box('m-tank', 152, M, 336, 162, M + HIGH, 346, 'rust');
  k.box('m-tank', 164, M, 338, 174, M + HIGH, 346, 'metal');
  for (const z of [304, 313, 322]) k.box('m-crate', 139, M, z, 145, M + LOW, z + 6, 'crate');
  k.box('m-crate', 139, M + LOW, 314, 143, M + MID, 318, 'crate');
  // 西の縁の掩蔽(中2.5): 縁ぎわの警備から北西の扉(P11)前への射線を切る。南(アリーナ側)への射線は通す
  k.box('m-edge-cover', 130.4, M, 316, 133.4, M + MID, 324, 'metalDark');
  // 着地(C5)の南東側を遮る高い遮蔽(高6): T13 からの射線を切る。C5コリドー(z<=309)・C6離陸柱(x165..171,z319..325)の外
  k.box('m-shield', 156, M, 312, 164, M + HIGH, 316, 'concreteDark');
  k.decor('m-shield-band', 156, M + 2.4, 311.86, 164, M + 3.4, 312, 'hazard');
  k.decor('m-edge', 130, M, 300, 130.6, M + 0.05, 346, 'hazard');
  k.decor('m-edge', 130, M, 345.4, 174, M + 0.05, 346, 'hazard');
  k.decor('m-edge', 130, M, 300, 152, M + 0.05, 300.6, 'hazard');

  // ================================================================== U (+24) の上: T13・掩蔽・門型ガントリー
  k.turret(182, 366, 4, { baseY: U, face: [100, 340] });
  k.box('t13-beacon', 179.5, U + 2.4, 368.5, 184.5, U + 3.4, 369.1, 'hazard', { emissive: 1 });
  k.box('u-cover', 180, U, 344, 188, U + MID, 350, 'crate');
  k.box('u-cover', 180, U, 356, 190, U + HIGH, 359, 'metalDark');
  k.box('u-cover', 182, U, 372, 188, U + LOW, 380, 'crate');
  k.box('u-cover', 180, U, 398, 190, U + HIGH, 402, 'rust');
  k.box('u-cover', 185.5, U, 408, 192, U + MID, 412, 'crate');
  k.box('u-cover', 206, U, 400, 216, U + MID, 406, 'machine');
  // 門型ガントリー(z=340 と z=416): 脚と梁
  for (const z of [340, 416]) {
    for (const x of [182, 214]) k.pillar('gantry-leg', x, z, 2.4, U, 35.6, 'metal');
    k.box('gantry-beam', 182, 33.6, z - 0.9, 214, 35, z + 0.9, 'metalDark');
    k.box('gantry-lamp', 190, 33, z - 0.8, 206, 33.6, z + 0.8, 'lightPanel', { emissive: 1 });
  }

  // ================================================================== 南: 大型プレスA・小型プレスB・加熱炉・コンテナヤード
  // プレスA: 4柱(6x6) + クラウン + 4本のシリンダー + ラム + ボルスターとダイ
  for (const [x, z] of [[55, 396], [93, 396], [55, 420], [93, 420]] as [number, number][]) {
    k.box('press-col', x - 3, F, z - 3, x + 3, 25, z + 3, 'metalDark');
    k.fbox('press-foot', x - 4.2, z - 4.2, x + 4.2, z + 4.2, 1, 'hazard');
    k.box('press-lamp', x - 1.5, 6, z - 3.6, x + 1.5, 7, z - 3, 'lightPanel', { emissive: 1 });
  }
  k.box('press-crown', 52, 25, 393, 96, 32, 423, 'metal');
  k.box('press-crown-cap', 56, 32, 398, 92, 33, 418, 'machine');
  for (const [x, z] of [[66, 404], [82, 404], [66, 412], [82, 412]] as [number, number][]) k.pipe('press-cyl', 'y', x - 1.2, 15, z - 1.2, x + 1.2, 25, z + 1.2, 'pipe');
  k.box('press-ram', 62, 10, 400, 86, 15, 416, 'machine');
  k.box('press-ram-glow', 68, 9.4, 404, 80, 10, 412, 'hazard', { emissive: 0.9 });
  k.fbox('press-bed', 60, 399, 88, 417, 4, 'machine');
  k.fbox('press-die', 66, 404, 82, 412, 3, 'metalDark', 4);
  k.fbox('press-die-glow', 68, 405, 80, 411, 0.6, 'hazard', 7, { emissive: 0.8 });
  // プレスB
  for (const [x, z] of [[10, 398], [36, 398], [10, 420], [36, 420]] as [number, number][]) {
    k.box('pressB-col', x - 2, F, z - 2, x + 2, 16, z + 2, 'metalDark');
    k.fbox('pressB-foot', x - 3, z - 3, x + 3, z + 3, 1, 'hazard');
  }
  k.box('pressB-crown', 6, 16, 394, 40, 20, 424, 'metal');
  for (const x of [18, 28]) k.pipe('pressB-cyl', 'y', x - 1, 12, 408, x + 1, 16, 410, 'pipe');
  k.box('pressB-ram', 14, 8, 402, 32, 12, 416, 'machine');
  k.fbox('pressB-bed', 12, 400, 34, 418, 3, 'metalDark');
  k.box('pressB-lamp', 20, 17, 393.4, 26, 18.4, 394, 'hazard', { emissive: 1 });
  // 加熱炉(炉口は橙に光る)と煙突
  k.fbox('furnace', 100, 398, 116, 414, 10, 'rust');
  k.box('furnace-mouth', 103, 1, 397.4, 113, 5, 398, 'hazard', { emissive: 1 });
  k.box('chimney', 106, 10, 402, 110, 30, 406, 'concreteDark');
  k.fbox('furnace-pipe', 116, 404, 122, 407, 3.4, 'pipe');
  // コンテナヤード(x120..176, z388..426): 高6と中2.5
  const cont = (x: number, z: number, w: number, d: number, h: number, mat: 'crate' | 'metalDark' | 'rust' = 'crate'): void => {
    k.fbox('cont', x, z, x + w, z + d, h, mat);
  };
  cont(124, 388, 12, 3, HIGH);
  cont(138, 388, 12, 3, MID);
  cont(124, 397, 12, 3, MID, 'metalDark');
  cont(142, 400, 12, 3, HIGH, 'rust');
  cont(124, 408, 12, 3, HIGH);
  cont(138, 412, 12, 3, MID);
  cont(158, 392, 12, 3, HIGH, 'metalDark');
  cont(156, 410, 12, 3, MID);
  cont(150, 420, 12, 3, HIGH, 'rust');

  // ================================================================== U の下の格納庫: 変圧器・コンテナ・パイプ置場
  for (const z of [334, 350]) {
    k.fbox('gen', 200, z, 214, z + 10, MID, 'machine');
    k.fbox('gen-foot', 199.2, z - 0.8, 214.8, z + 10.8, 0.6, 'hazard');
  }
  k.fbox('under-cont', 182, 340, 196, 343, HIGH, 'crate');
  k.fbox('under-cont', 182, 352, 196, 355, HIGH, 'metalDark');
  k.fbox('pipe-yard', 182, 404, 214, 407, 2.4, 'pipe');
  k.fbox('pipe-yard', 184, 412, 212, 415, 2.4, 'rust');
  for (const z of [346, 384, 420]) k.box('under-lamp', 183, 21.4, z, 213, 22, z + 3, 'lightPanel', { emissive: 1 });

  // ================================================================== 床の標示(装飾)
  // アリーナの縁の標示帯と、プレス・炉の安全帯
  k.decor('arena-line', 10, F, 299.4, 110, F + 0.07, 300, 'hazard');
  k.decor('arena-line', 10, F, 380, 110, F + 0.07, 380.6, 'hazard');
  k.decor('arena-line', 109.4, F, 300, 110, F + 0.07, 380, 'hazard');
  k.decor('arena-line', 10, F, 300, 10.6, F + 0.07, 380, 'hazard');
  k.decor('press-safe', 44, F, 386, 104, F + 0.07, 388, 'hazard');
  k.decor('door-guide', 84, F, 288.6, 100, F + 0.07, 290, 'hazard', { emissive: 0.8 });

  // ================================================================== 追加の設備と残骸
  // Mの側面: 照明・警告帯・設備パネル(機械基礎の壁面)
  for (const z of [306, 322, 338]) k.box('m-lamp', 129.5, 8, z, 130, 9.2, z + 6, 'lightPanel', { emissive: 1 });
  k.decor('m-band', 130, 10.2, 300, 130.14, 11.2, 346, 'hazard');
  k.decor('m-band', 130, 10.2, 299.86, 174, 11.2, 300, 'hazard');
  k.decor('m-band', 130, 10.2, 346, 174, 11.2, 346.14, 'hazard');
  k.decor('m-band', 173.86, 10.2, 300, 174, 11.2, 346, 'hazard');
  for (let i = 0; i < 6; i++) {
    k.decor('m-panel', 129.9 - (i % 3) * 0.02, 1.4 + (i % 2) * 3.4, 303 + i * 7, 130, 4.6 + (i % 2) * 3.4, 309 + i * 7, i % 2 ? 'metalDark' : 'concreteDark');
  }
  // 樽の集積(縁と壁際。アリーナの外)
  const barrels = (cx: number, cz: number, n: number, mat: MaterialKey): void => {
    for (let i = 0; i < n; i++) {
      const x = cx + (i % 3) * 1.5;
      const z = cz + Math.floor(i / 3) * 1.5;
      k.pipe('barrel', 'y', x - 0.65, F, z - 0.65, x + 0.65, F + 1.7, z + 0.65, i % 4 === 0 ? 'hazard' : mat);
    }
  };
  barrels(23, 294, 6, 'rust');
  barrels(44, 395, 6, 'rust');
  barrels(118, 392, 5, 'metal');
  barrels(12.5, 385.5, 6, 'rust');
  // 崩れた棚(段積みで傾きを近似): 西南の隅
  k.fbox('slump', X0, 384, 10, 388, LOW, 'metalDark');
  k.fbox('slump', X0, 388, 8, 392, 2.2, 'rust');
  k.fbox('slump', X0, 392, 6, 394, 3.2, 'metalDark');
  // 落ちたクレーンのフック(北西寄りの床)
  k.fbox('hook', 60, 384.8, 66, 388, 1.6, 'metal');
  // 高窓(西壁・東壁): 青白い天光
  for (const z of [300, 326, 372, 398]) k.decor('window', X0, 30, z, X0 + 0.14, 37, z + 16, 'glass', { emissive: 0.45 });
  for (const z of [296, 318, 396, 412]) k.decor('window', X1 - 0.14, 34.2, z, X1, 38.6, z + 12, 'glass', { emissive: 0.45 });

  // 昇降の離陸・着地の目印(床の標示と光る帯): 通行可能空間に浮かぶものはない(標示は床/足場の面の上の装飾)
  const padMark = (cx: number, cz: number, y: number, r: number): void => {
    const h = 0.07;
    k.decor('pad-mark', cx - r, y, cz - r, cx + r, y + h, cz - r + 0.5, 'hazard');
    k.decor('pad-mark', cx - r, y, cz + r - 0.5, cx + r, y + h, cz + r, 'hazard');
    k.decor('pad-mark', cx - r, y, cz - r + 0.5, cx - r + 0.5, y + h, cz + r - 0.5, 'hazard');
    k.decor('pad-mark', cx + r - 0.5, y, cz - r + 0.5, cx + r, y + h, cz + r - 0.5, 'hazard');
    for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const px = cx + dx * (r - 1.6);
      const pz = cz + dz * (r - 1.6);
      k.decor('pad-light', px - 0.6, y, pz - 0.6, px + 0.6, y + 0.09, pz + 0.6, 'lightPanel', { emissive: 1 });
    }
  };
  padMark(160, 292, F, 5); // C5 離陸(接地して回復できる床)
  padMark(160, 306, M, 5); // C5 着地 / M
  padMark(168, 322, M, 5); // C6 離陸
  padMark(188, 332, U, 5); // C6 着地 / U
  // C5 離陸位置の脇の灯柱(離陸柱x157..163の外)と、北壁の灯
  for (const x of [153.8, 164.8]) {
    k.box('c5-post', x, F, 289.6, x + 1.4, 7, 291, 'metalDark');
    k.box('c5-post-lamp', x - 0.4, 7, 289.2, x + 1.8, 8.2, 291.4, 'lightPanel', { emissive: 1 });
  }
  k.box('c5-wall-lamp', 154, 9, Z0, 166, 10.2, Z0 + 0.6, 'hazard', { emissive: 0.9 });

  // 制御室の操作卓(緑の光)と、吊り荷の下の危険区域の標示(床の装飾)
  k.box('cabin-console', 136, M, 328.4, 144, M + 1.4, 330, 'machine', { emissive: 0.6 });
  k.decor('load-zone', 76, F, 336, 98, F + 0.07, 336.5, 'hazard');
  k.decor('load-zone', 76, F, 354.5, 98, F + 0.07, 355, 'hazard');
  k.decor('load-zone', 76, F, 336.5, 76.5, F + 0.07, 354.5, 'hazard');
  k.decor('load-zone', 97.5, F, 336.5, 98, F + 0.07, 354.5, 'hazard');

  // M・U の足場の面の汚れ(錆・油のしみ)と、U の上の進路の誘導(C6着地 → 東扉P12)、扉の上の灯(主経路=暖色、旧倉庫への分岐=寒色)
  let dseed = 0x5a12d;
  const drnd = (): number => {
    dseed = (Math.imul(dseed, 1664525) + 1013904223) >>> 0;
    return dseed / 4294967296;
  };
  const deckStains = (x0: number, z0: number, x1: number, z1: number, y: number, n: number): void => {
    for (let i = 0; i < n; i++) {
      const w = 1.2 + drnd() * 4.5;
      const d = 1.2 + drnd() * 4.5;
      const sx = x0 + drnd() * (x1 - x0 - w);
      const sz = z0 + drnd() * (z1 - z0 - d);
      const c = drnd();
      k.decor('deck-stain', sx, y, sz, sx + w, y + 0.02 + (i % 7) * 0.005, sz + d, c < 0.5 ? 'roof' : 'rust');
    }
  };
  deckStains(130, 300, 174, 346, M, 16);
  deckStains(178, 326, 218, 428, U, 34);
  k.decor('u-guide', 190, U, 347.5, 216, U + 0.07, 348.1, 'hazard');
  k.decor('u-guide', 189.4, U, 337, 190, U + 0.07, 347.5, 'hazard');
  k.decor('u-guide-light', 200, U, 347.6, 204, U + 0.09, 348, 'lightPanel', { emissive: 1 });
  k.decor('u-guide-light', 209, U, 347.6, 213, U + 0.09, 348, 'lightPanel', { emissive: 1 });
  k.box('p12-lamp', 217.4, 32.1, 347, X1, 32.9, 361, 'lightPanel', { emissive: 1 });
  k.box('p22-lamp', 193, 32.1, 427.4, 207, 32.9, Z1, 'glass', { emissive: 0.9 });

  // ================================================================== 警備 4
  k.guard(28, 378, { face: [60, 340], patrol: [{ x: 28, y: 1.5, z: 378 }, { x: 50, y: 1.5, z: 382 }, { x: 96, y: 1.5, z: 382 }, { x: 70, y: 1.5, z: 382 }] });
  k.guard(113, 340, { face: [60, 340], patrol: [{ x: 113, y: 1.5, z: 340 }, { x: 113, y: 1.5, z: 312 }, { x: 113, y: 1.5, z: 370 }] });
  k.guard(132.6, 326, { floorTop: M, face: [60, 340], patrol: [{ x: 132.6, y: M + 1.5, z: 326 }, { x: 132.6, y: M + 1.5, z: 306 }, { x: 150, y: M + 1.5, z: 312 }, { x: 136, y: M + 1.5, z: 320 }] });
  k.guard(198, 408, { floorTop: U, face: [100, 340], patrol: [{ x: 198, y: U + 1.5, z: 408 }, { x: 208, y: U + 1.5, z: 380 }, { x: 190, y: U + 1.5, z: 384 }] });

  // ================================================================== 経年の汚れ (装飾のみ・衝突なし): 壁の錆の筋・パネル・裾の汚れ、床のしみとひび
  let seed = 0x5a12;
  const rnd = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  let di = 0;
  const thick = (): number => 0.03 + (di++ % 6) * 0.02; // 重なる装飾の面が同一平面にならないよう厚みを変える(最大0.13m)
  type Face = 'n' | 's' | 'w' | 'e';
  const excl: Record<Face, [number, number, number, number][]> = {
    n: [[83.5, 100.5, -1, 9.5]],
    s: [[191.5, 208.5, 22.5, 33.5]],
    w: [],
    e: [[345.5, 362.5, 22.5, 33.5]],
  };
  const wallPatch = (f: Face, u0: number, u1: number, y0: number, y1: number, mat: MaterialKey): void => {
    if (excl[f].some((r) => u1 > r[0] && u0 < r[1] && y1 > r[2] && y0 < r[3])) return;
    const t = thick();
    if (f === 'n') k.decor('grime', u0, y0, 282, u1, y1, 282 + t, mat);
    else if (f === 's') k.decor('grime', u0, y0, 428 - t, u1, y1, 428, mat);
    else if (f === 'w') k.decor('grime', 2, y0, u0, 2 + t, y1, u1, mat);
    else k.decor('grime', 218 - t, y0, u0, 218, y1, u1, mat);
  };
  for (const [f, lo, hi] of [['n', 2, 218], ['s', 2, 218], ['w', 282, 428], ['e', 282, 428]] as [Face, number, number][]) {
    const len = hi - lo;
    // 錆の筋(縦)
    for (let i = 0; i < Math.round(len / 7); i++) {
      const w = 0.7 + rnd() * 1.8;
      const u = lo + rnd() * (len - w);
      const y1 = 0 + (42 - 0) * (0.3 + rnd() * 0.7);
      wallPatch(f, u, u + w, Math.max(0, y1 - (4 + rnd() * 14)), y1, rnd() < 0.62 ? 'rust' : 'concreteDark');
    }
    // 暗い板(設備パネル跡)
    for (let i = 0; i < Math.round(len / 14); i++) {
      const w = 4 + rnd() * 8;
      const u = lo + rnd() * (len - w);
      const y0 = 0 + 1 + rnd() * (42 - 0 - 9);
      wallPatch(f, u, u + w, y0, y0 + 2.5 + rnd() * 3.5, rnd() < 0.5 ? 'metalDark' : 'concreteDark');
    }
    // 警告の帯(破線)
    for (let u = lo + 3; u < hi - 9; u += 18) wallPatch(f, u, u + 9, 0 + 3.6, 0 + 3.6 + 0.6, 'hazard');
    // 裾の汚れ
    for (let u = lo; u < hi - 1; u += 10) wallPatch(f, u, Math.min(hi, u + 10), 0, 0 + 1.4 + rnd() * 0.8, 'concreteDark');
  }
  // 床のしみ(油・錆・焼け)とひび
  for (let i = 0; i < 70; i++) {
    const w = 1.5 + rnd() * 6;
    const d = 1.5 + rnd() * 6;
    const t = 0.02 + (di++ % 7) * 0.005;
    const c = rnd();
    const sx = 2 + rnd() * (218 - 2 - w);
    const sz = 282 + rnd() * (428 - 282 - d);
    k.decor('stain', sx, 0, sz, sx + w, 0 + t, sz + d, c < 0.55 ? 'roof' : c < 0.85 ? 'rust' : 'concreteDark');
  }
  for (let i = 0; i < 70; i++) {
    const along = 4 + rnd() * 10;
    const t = 0.02 + (di++ % 7) * 0.005;
    const alongX = rnd() < 0.5;
    const cx = 2 + rnd() * (218 - 2 - along);
    const cz = 282 + rnd() * (428 - 282 - along);
    if (alongX) k.decor('crack', cx, 0, cz, cx + along, 0 + t, cz + 0.22, 'roof');
    else k.decor('crack', cx, 0, cz, cx + 0.22, 0 + t, cz + along, 'roof');
  }
}
