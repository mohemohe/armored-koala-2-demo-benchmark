/**
 * S07 保守用配管区画 (pipe, +24 / 天井40): 太い配管が林立する保守キャットウォーク網。警備1(巡回)。
 *  - 千鳥に置いた2本の巨大な配管ラック(BANK1 x532-600 z178-184 / BANK2 x570-638 z214-220, 高さ8m)が区画を蛇行させる。
 *    ラックの自由端(BANK1東端 x600 / BANK2西端 x570)は分岐経路 BR3 の折れ点なので、端面の位置・外形は動かさない。
 *    BANK2 の上面(y=32)は BR3-duct の飛行経路(y32..35)が真上を通るので、x606..618 の上面には何も載せない。
 *  - ラックの上面は保守キャットウォーク: 上面同士を空中橋(BRIDGE)でつなぎ、ジャンプの踏み台(2.7m刻み)で床から登れる。
 *  - 縦の大配管(スタック)が林立し、陰で遮蔽が取れる。天井には配管ラック(y36.4以上: 飛行経路の上)、壁ぞいに配管と設備パネル。
 *  - 光は橙(ハザード灯)と暖色の天井灯。警備の巡回: 北入口→東の抜け→中央の間→西の抜け→南の配管林。
 *  - 廃工場の残骸: 落ちた桁(荷箱に載る, 下は2.2mで通れない)・垂れ下がった配管(床から7m以上)・床の腐食跡。
 * 経路(mainRoute/BR3 の折れ線)は、北入口(x613-627)・対角の通路(614,174)->(568,214)->(534,260)・南の出口(x593-607)を空けておく。
 */
import type { Kit } from '../kit';
import type { MaterialKey } from '../../sim/types';

export function build(k: Kit): void {
  const F = k.floorY; // 24
  const C = k.ceilingY; // 40
  const X0 = k.inner.x0; // 532
  const X1 = k.inner.x1; // 638
  const Z0 = k.inner.z0; // 142
  const Z1 = k.inner.z1; // 278

  // ---- 部品
  /** 縦の大配管(床〜天井): 円柱(断面<=3) + 足元の危険帯 + 中間のクランプ + 天井のフランジ */
  const stack = (cx: number, cz: number, s = 3, clampY = 7.5): void => {
    k.pipe('stack', 'y', cx - s / 2, F + 0.8, cz - s / 2, cx + s / 2, C - 0.8, cz + s / 2, 'pipe');
    k.box('stack-base', cx - s / 2 - 0.6, F, cz - s / 2 - 0.6, cx + s / 2 + 0.6, F + 0.8, cz + s / 2 + 0.6, 'hazard');
    k.box('stack-clamp', cx - s / 2 - 0.4, F + clampY, cz - s / 2 - 0.4, cx + s / 2 + 0.4, F + clampY + 0.7, cz + s / 2 + 0.4, 'metalDark');
    k.box('stack-flange', cx - s / 2 - 0.7, C - 0.8, cz - s / 2 - 0.7, cx + s / 2 + 0.7, C, cz + s / 2 + 0.7, 'metalDark');
  };
  const RACK_MATS: MaterialKey[] = ['pipe', 'pipe', 'rust', 'metal', 'pipe', 'pipe'];
  /** 配管ラック: 6m厚(z)x8m高。plinth 1m + 円柱2列x3段 + 危険帯クランプ。外形は (x0..x1, z0..z0+6, F..F+8) のまま */
  const rack = (tag: string, x0: number, x1: number, z0: number, clamps: number[]): void => {
    k.box(`${tag}-plinth`, x0, F, z0, x1, F + 1, z0 + 6, 'concreteDark');
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 2; c++) {
        // 段の境界は整数演算で求める(最上段の上面がちょうど F+8 になる)
        k.pipe(`${tag}-pipe`, 'x', x0, F + 1 + (7 * r) / 3, z0 + 3 * c, x1, F + 1 + (7 * (r + 1)) / 3, z0 + 3 * (c + 1), RACK_MATS[r * 2 + c]);
      }
    }
    for (const cx of clamps) k.box(`${tag}-clamp`, cx, F + 1, z0, cx + 1.2, F + 8, z0 + 6, 'hazard');
  };
  /** 踏み台の階段(ジャンプで登る: 段差は (topY-F)/3 <= 2.78)。edge の面に接する3つの4m角のブロックを away 方向へ並べる。上面は edge 側が topY */
  const stairs = (tag: string, axis: 'x' | 'z', edge: number, away: 1 | -1, c0: number, topY: number): void => {
    const rise = (topY - F) / 3;
    for (let i = 0; i < 3; i++) {
      const a0 = away > 0 ? edge + 4 * i : edge - 4 * (i + 1);
      const a1 = a0 + 4;
      const top = i === 0 ? topY : topY - i * rise;
      if (axis === 'z') {
        k.box(`${tag}-step`, c0, F, a0, c0 + 4, top, a1, i === 0 ? 'metalDark' : 'machine');
        k.decor(`${tag}-step-mark`, c0, top + 0.03, a0, c0 + 4, top + 0.14, a1, 'hazard');
      } else {
        k.box(`${tag}-step`, a0, F, c0, a1, top, c0 + 4, i === 0 ? 'metalDark' : 'machine');
        k.decor(`${tag}-step-mark`, a0, top + 0.03, c0, a1, top + 0.14, c0 + 4, 'hazard');
      }
    }
  };

  // ================================================================== 配管ラック(千鳥): 端面は経路の折れ点なので位置固定
  rack('bank1', X0, 600, 178, [537, 555, 573, 591, 598.8]);
  rack('bank2', 570, X1, 214, [570, 588, 606, 624, 636.8]);

  // ---- ラック上面のキャットウォークの手すり(1.2m): 飛行経路の直下(BANK2 x606..618)には出さない
  for (const [a, b] of [[536, 578], [584, 596]] as [number, number][]) k.box('bank1-rail', a, F + 8, 178, b, F + 9.2, 178.5, 'metal');
  for (const [a, b] of [[536, 578], [594, 596]] as [number, number][]) k.box('bank1-rail', a, F + 8, 183.5, b, F + 9.2, 184, 'metal');
  for (const [a, b] of [[574, 581], [591, 604], [620, 634]] as [number, number][]) k.box('bank2-rail', a, F + 8, 214, b, F + 9.2, 214.5, 'metal');
  for (const [a, b] of [[574, 604], [620, 634]] as [number, number][]) k.box('bank2-rail', a, F + 8, 219.5, b, F + 9.2, 220, 'metal');
  // ---- 空中橋: BANK1 と BANK2 の上面を結ぶ(下は経路(y24..27)が通る。橋の下面 y31)
  k.box('bridge', 583, F + 7, 184, 588.6, F + 8, 214, 'grating');
  k.box('bridge-girder', 583, F + 5.8, 184, 583.6, F + 7, 214, 'metalDark');
  k.box('bridge-girder', 588, F + 5.8, 184, 588.6, F + 7, 214, 'metalDark');
  k.box('bridge-rail', 583, F + 8, 184, 583.5, F + 9.2, 214, 'metal');
  k.box('bridge-rail', 588.1, F + 8, 184, 588.6, F + 9.2, 214, 'metal');
  // ---- 階段(踏み台): BANK1 西端へ / BANK2 東端へ
  stairs('s1', 'z', 178, -1, 533, F + 8); // z166..178 -> BANK1の北面(z178)に接して上面y32
  stairs('s2', 'z', 220, 1, 633, F + 8); // z220..232 -> BANK2の南面(z220)に接して上面y32

  // ================================================================== 北: 入口ホール(P06 x613-627)と制御デッキ
  // 入口の門柱(前面 x613-627 は空ける)
  stack(606.5, 145, 3, 6);
  stack(633.5, 145, 3, 6);
  // 制御デッキ(y30, 6m上): 北西。脚は縦配管。デッキの南の縁は階段で登る
  k.box('deck', 538, F + 5, 150, 566, F + 6, 170, 'grating');
  for (const [x, z] of [[540, 152], [564, 152], [540, 168], [564, 168]] as [number, number][]) k.pipe('deck-leg', 'y', x - 1.5, F, z - 1.5, x + 1.5, F + 5, z + 1.5, 'pipe');
  k.box('deck-rail', 538, F + 6, 150, 566, F + 7.2, 150.5, 'metal');
  k.box('deck-rail', 538, F + 6, 150, 538.5, F + 7.2, 170, 'metal');
  k.box('deck-rail', 565.5, F + 6, 150, 566, F + 7.2, 158, 'metal'); // 東の縁は z158..162 を階段の入口に開ける
  k.box('deck-rail', 565.5, F + 6, 162, 566, F + 7.2, 170, 'metal');
  k.box('deck-rail', 538, F + 6, 169.5, 550, F + 7.2, 170, 'metal');
  k.box('deck-rail', 556, F + 6, 169.5, 566, F + 7.2, 170, 'metal');
  k.box('deck-booth', 541, F + 6, 153, 549, F + 9.4, 161, 'machine');
  k.box('deck-booth-roof', 540.6, F + 9.4, 152.6, 549.4, F + 10, 161.4, 'metalDark');
  stairs('s3', 'x', 566, 1, 158, F + 6); // デッキ(上面 y30)へ: 東の縁から x566..578
  // デッキの下: ポンプ
  k.box('pump', 543, F, 156, 551, F + 3, 162, 'machine');
  k.box('pump', 555, F, 156, 562, F + 3, 162, 'machine');
  // 北の大配管
  stack(584, 160);
  stack(590, 150);
  stack(596, 168);
  stack(633.5, 160);
  stack(628, 172, 3, 9);
  // 北壁ぞいの弁ステーション(低い掩蔽)
  k.crate('valve-box', 578, 146, 8, 4, 2.4, 'machine', F);
  k.crate('valve-box', 594, 146, 6, 4, 3.2, 'machine', F);

  // ================================================================== 中間の間 (z184-214)
  stack(546, 192);
  stack(546, 208);
  stack(560, 200, 3, 10);
  stack(626, 192);
  stack(632, 206);
  k.crate('valve-box', 620, 206, 6, 5, 2.6, 'machine', F);
  k.box('tank-e', 634, F, 190, 638, F + 6, 200, 'rust'); // 東壁ぞいのタンク(壁に接する)

  // ================================================================== 南の配管林 (z220-278)
  // 中央のポンプ室
  k.box('ph-pad', 571, F, 237, 597, F + 1, 255, 'concreteDark');
  k.box('ph-body', 574, F + 1, 240, 594, F + 5.4, 252, 'machine');
  k.box('ph-band', 573.8, F + 2.6, 239.8, 594.2, F + 3.6, 252.2, 'hazard');
  k.box('ph-housing', 578, F + 5.4, 244, 590, F + 7.6, 248, 'metalDark');
  for (const x of [576, 582, 588, 592.4]) k.pipe('ph-stub', 'y', x, F + 7.6, 245, x + 2.2, C - 3.6, 247.2, 'pipe');
  k.box('ph-header', 575, C - 3.6, 243, 595, C - 2.2, 249, 'metalDark');
  // 配管林
  for (const [x, z, s] of [[541, 232, 3], [566, 228, 3], [604, 234, 3], [620, 242, 3], [634, 252, 3], [632, 266, 3], [578, 268, 3], [558, 262, 3], [548, 254, 3], [618, 254, 3]] as [number, number, number][]) stack(x, z, s);
  // 出口P07(西)の門柱・出口P20(南)の門柱
  stack(534, 275.6, 3, 6);
  stack(590.5, 276.5, 3, 6);
  stack(609.5, 276.5, 3, 6);
  // 低い掩蔽: 弁ボックス・小型タンク
  k.crate('valve-box', 600, 226, 8, 4, 2.4, 'machine', F);
  k.crate('valve-box', 566, 246, 4, 8, 3.2, 'machine', F);
  k.crate('valve-box', 620, 232, 6, 6, 2.6, 'machine', F);
  k.box('tank-s', 616, F, 262, 626, F + 5, 272, 'metalDark');
  k.box('tank-s-band', 615.8, F + 2, 261.8, 626.2, F + 3, 272.2, 'hazard');

  // ================================================================== 床置きの配管(径2.4m: ジャンプで越えられる高さ)と大型タンク
  k.pipe('floor-run', 'z', 538, F, 186, 540.4, F + 2.4, 212, 'pipe');
  k.pipe('floor-run', 'x', 602, F, 246, 626, F + 2.4, 248.4, 'pipe');
  k.pipe('floor-run', 'x', 542, F, 262, 556, F + 2.4, 264.4, 'rust');
  k.pipe('floor-run', 'z', 576, F, 258, 578.4, F + 2.4, 272, 'pipe');
  k.pipe('floor-run', 'z', 604, F, 188, 606.4, F + 2.4, 200, 'pipe');
  k.box('tank-n', 572, F, 164, 582, F + 12, 174, 'metal');
  k.box('tank-n-band', 571.8, F + 3, 163.8, 582.2, F + 4, 174.2, 'hazard');
  k.box('tank-n-band', 571.8, F + 8, 163.8, 582.2, F + 9, 174.2, 'hazard');
  k.pipe('tank-n-riser', 'y', 575.5, F + 12, 167.5, 578.5, C - 0.8, 170.5, 'pipe');
  k.box('tank-e2', 630, F, 238, X1, F + 10, 248, 'rust');
  k.box('tank-e2-band', 629.8, F + 3, 237.8, X1, F + 4, 248.2, 'hazard');
  k.box('tank-e2-band', 629.8, F + 7, 237.8, X1, F + 8, 248.2, 'hazard');

  // ================================================================== 廃工場の残骸: 落ちた桁(下をくぐれない高さ2.2m)と垂れ下がった配管(床から7m以上)
  k.crate('crate', 591.5, 262.8, 3, 3, 2.2, 'crate', F);
  k.crate('crate', 604.5, 262.8, 3, 3, 2.2, 'rust', F);
  k.box('fallen-girder', 590, F + 2.2, 262, 606, F + 3.4, 263.6, 'metalDark');
  k.box('fallen-girder-web', 594, F + 3.4, 262.4, 601, F + 4.2, 263.2, 'rust');
  for (const [x, z] of [[552, 198], [628, 226], [568, 250]] as [number, number][]) {
    k.pipe('hang-pipe', 'y', x - 1.2, 31.5, z - 1.2, x + 1.2, C - 0.8, z + 1.2, 'pipe');
    k.box('hang-pipe-flange', x - 1.8, C - 0.8, z - 1.8, x + 1.8, C, z + 1.8, 'metalDark');
    k.box('hang-pipe-break', x - 1.6, 30.9, z - 1.6, x + 1.6, 31.5, z + 1.6, 'rust');
  }

  // ================================================================== 天井の配管ラック(y36.4..39.2 = 飛行経路(y<=35)の上)と吊り金具
  k.pipe('roof-rack', 'x', X0, 36.4, 158.6, X1, 39.2, 161.4, 'pipe');
  k.pipe('roof-rack', 'x', X0, 36.4, 236.6, X1, 39.2, 239.4, 'pipe');
  for (const x of [545, 575, 605, 635]) {
    k.box('roof-hanger', x, 39.2, 159, x + 0.8, C, 161, 'metalDark');
    k.box('roof-hanger', x, 39.2, 237, x + 0.8, C, 239, 'metalDark');
  }
  // 壁ぞいの配管(y>=33: 出入口の開口(y<=32)の上)
  k.pipe('wall-pipe', 'x', X0, 33, Z0, 610, 35.8, Z0 + 2.8, 'pipe'); // 北壁(P06の上は空けて標識)
  k.pipe('wall-pipe', 'x', 630, 33, Z0, X1, 35.8, Z0 + 2.8, 'pipe');
  k.pipe('wall-pipe', 'x', X0, 33, Z1 - 2.8, 590, 35.8, Z1, 'pipe'); // 南壁(P20の上は空ける)
  k.pipe('wall-pipe', 'x', 610, 33, Z1 - 2.8, X1, 35.8, Z1, 'pipe');
  k.pipe('wall-pipe', 'z', X0, 33, Z0 + 2.8, X0 + 2.8, 35.8, Z1 - 2.8, 'pipe'); // 西壁
  k.pipe('wall-pipe', 'z', X1 - 2.8, 33, Z0 + 2.8, X1, 35.8, Z1 - 2.8, 'rust'); // 東壁
  k.pipe('wall-pipe', 'z', X1 - 2.8, 36.5, Z0 + 2.8, X1, 39.3, Z1 - 2.8, 'pipe');
  k.pipe('wall-pipe', 'z', X0, 36.5, Z0 + 2.8, X0 + 2.8, 39.3, Z1 - 2.8, 'pipe');

  // ================================================================== 敵: 巡回する警備1(G16)
  k.guard(590, 200, {
    face: [612, 190],
    patrol: [
      { x: 610, y: 25.5, z: 160 },
      { x: 618, y: 25.5, z: 190 },
      { x: 590, y: 25.5, z: 200 },
      { x: 552, y: 25.5, z: 204 },
      { x: 552, y: 25.5, z: 234 },
      { x: 590, y: 25.5, z: 230 },
      { x: 612, y: 25.5, z: 238 },
    ],
  });

  // ================================================================== 装飾(衝突なし)
  // 天井灯(暖色)
  for (const x of [556, 576, 620]) for (const z of [150, 196, 226, 262]) k.decor('ceiling-lamp', x - 3, C - 0.15, z - 1.2, x + 3, C, z + 1.2, 'lightPanel');
  // 橙の警告灯: 北壁・南壁の上部
  for (const x of [560, 580, 600]) k.decor('amber', x, 30, Z0, x + 1.6, 31, Z0 + 0.1, 'hazard', { emissive: 0.9 });
  for (const x of [545, 575, 625]) k.decor('amber', x, 30, Z1 - 0.1, x + 1.6, 31, Z1, 'hazard', { emissive: 0.9 });
  // 北入口(P06)の枠: 開口の上の危険帯と赤い灯
  k.decor('p06-sign', 612, 32.6, Z0, 628, 35, Z0 + 0.1, 'hazard');
  k.decor('p06-lamp', 610.4, 28, Z0, 612.4, 30, Z0 + 0.1, 'gate', { emissive: 0.9 });
  k.decor('p06-lamp', 627.6, 28, Z0, 629.6, 30, Z0 + 0.1, 'gate', { emissive: 0.9 });
  // 床の補修板(暗い鋼板を格子床に溶接した跡)と小さな腐食
  for (const [x0, z0, x1, z1] of [[555, 190, 563, 196], [600, 226, 608, 232], [541, 238, 549, 243], [621, 162, 629, 168], [568, 263, 576, 268], [608, 197, 614, 202]] as [number, number, number, number][]) k.decor('repair-plate', x0, F + 0.03, z0, x1, F + 0.12, z1, 'metalDark');
  for (const [x0, z0, x1, z1] of [[556, 192, 559, 194.6], [602, 228, 604.6, 231], [544, 238, 546.6, 240.4], [624, 163, 626.4, 166]] as [number, number, number, number][]) k.decor('rust-patch', x0, F + 0.05, z0, x1, F + 0.14, z1, 'rust');
  // 床の危険帯(ラックの根元)
  k.decor('rack-line', 532, F + 0.03, 176.2, 600, F + 0.14, 177.6, 'hazard');
  k.decor('rack-line', 532, F + 0.03, 184.4, 600, F + 0.14, 185.8, 'hazard');
  k.decor('rack-line', 570, F + 0.03, 212.2, X1, F + 0.14, 213.6, 'hazard');
  k.decor('rack-line', 570, F + 0.03, 220.4, X1, F + 0.14, 221.8, 'hazard');
  // 壁の設備パネル(西壁・東壁)
  for (const z of [166, 196, 226]) k.decor('panel', X0, 26, z, X0 + 0.1, 30, z + 8, 'machine');
  for (const z of [170, 200, 240]) k.decor('panel', X1 - 0.1, 26, z, X1, 30, z + 8, 'metalDark');
}
