/**
 * S08 動力棟 (multilevel, 床0 / 天井40): 発電ホール。制御砲台T08(B3)が南寄りの台座から西の隔壁(P08)を監視する。
 *  - 東: タービン発電機(HP/LP/発電機)と制御棟(屋根に配管)。北壁ぞい: ボイラー給水設備。南: 変圧器ヤード(T08はその谷間)。
 *  - +24 の南ギャラリー(P07 東入口 / P21 南入口)が広間を見下ろす。ギャラリーの下は大型変圧器ヤード(上からは見えない陰)。
 *  - 天井に橋形クレーン(床+34..37)。中央(ARENA_CLEAR 400..500 x 150..230)は空け、周囲の低(1.2)/中(2.5〜3.2)/高(6〜9)の設備が掩蔽になる。
 *  - 光: 天井は暖色の水銀灯、変圧器ヤードは寒色(ガラス灯)、制御砲台・隔壁の周りは赤。
 *  - 遠距離狙撃: ギャラリー西端の手すりの窓 (413,25.5,257.4) は隔壁 (391,156) から 105.8m・T08 に射線が通る(見えるのは G17 と T08 の2体)。
 *    1〜3m 南へ下がるとデッキの下面と縁が全ての敵の射線を切る(掩蔽)。荷箱と手すりの端が出入りの目印。北壁の給水ポンプの間 (466,147) も T08 まで射線が通る(隔壁から74.6m)が、警備が近く掩蔽は弱い。
 *  - 廃工場の残骸: ギャラリー床の崩落穴(x438..446 z258..265, 経路から離れ真下は床)・北東の落ちたガントリー・垂れ下がる配管(床から28m以上)・色あせた荷箱。
 * 経路(mainRoute / BR3 の折れ線): ギャラリー上(y24..27, z258..282)・広間の対角の空中・北西の降下(414,182)->(394,162)・P08の前面 は空けておく。
 */
import type { Kit } from '../kit';

export function build(k: Kit): void {
  const F = k.floorY; // 0
  const C = k.ceilingY; // 40
  const X0 = k.inner.x0; // 392
  const X1 = k.inner.x1; // 528
  const Z0 = k.inner.z0; // 142
  const Z1 = k.inner.z1; // 278

  // ---- decor helpers (衝突なし。host 箱の面から 0.16m 以内)
  const floorPlate = (name: string, x0: number, z0: number, x1: number, z1: number, mat: 'hazard' | 'concreteDark' | 'metalDark' | 'rust', emissive?: number): void => {
    k.decor(name, x0, F + 0.03, z0, x1, F + 0.14, z1, mat, emissive !== undefined ? { emissive } : {});
  };

  // ================================================================== 変圧器(大型): パッド + 本体 + 帯 + 放熱器(z両側) + コンサベータ + ブッシング3
  const xfmr = (x0: number, z0: number, w: number, d: number, h: number, baseY = F): void => {
    k.box('xf-pad', x0 - 0.6, baseY, z0 - 1.9, x0 + w + 0.6, baseY + 0.5, z0 + d + 1.9, 'concreteDark');
    k.box('xf-tank', x0, baseY + 0.5, z0, x0 + w, baseY + h, z0 + d, 'machine');
    k.box('xf-band', x0 - 0.15, baseY + 1.3, z0 - 0.15, x0 + w + 0.15, baseY + 2.1, z0 + d + 0.15, 'hazard');
    k.box('xf-fin', x0 + 1, baseY + 1.2, z0 - 1.4, x0 + w - 1, baseY + h - 0.8, z0, 'metalDark');
    k.box('xf-fin', x0 + 1, baseY + 1.2, z0 + d, x0 + w - 1, baseY + h - 0.8, z0 + d + 1.4, 'metalDark');
    k.pipe('xf-cons', 'x', x0 + 1, baseY + h, z0 + d / 2 - 1.2, x0 + w - 1, baseY + h + 2.4, z0 + d / 2 + 1.2, 'metal');
    for (const t of [0.22, 0.5, 0.78]) {
      const bx = x0 + w * t;
      k.box('xf-bush', bx - 0.45, baseY + h, z0 + 0.8, bx + 0.45, baseY + h + 2, z0 + 1.7, 'concrete');
    }
  };

  // ================================================================== ギャラリー(+24): 東西に長い足場。P07(東)/P21(南 x413..427)の入口を受ける
  // 床の欠け: x438..446 z258..265 は崩落(経路(z=260 は x492 以東・z266 は x470 以東)から離れている。真下は変圧器の谷間の床)
  k.platform('gallery', 404, 256, 438, Z1, 24, 1, 'grating');
  k.platform('gallery', 446, 256, X1, Z1, 24, 1, 'grating');
  k.platform('gallery', 438, 256, 446, 258, 24, 1, 'grating');
  k.platform('gallery', 438, 265, 446, Z1, 24, 1, 'grating');
  // 下の桁(縦横): 見下ろしたときの構造と、下から見上げたときの骨組み
  for (const z of [257, 267, 277]) k.box('gallery-girder', 405.2, 20.6, z - 0.6, 526.8, 23, z + 0.6, 'metalDark');
  for (const x of [404, 434, 464, 494, 526.8]) k.box('gallery-cross', x, 20.6, 256, x + 1.2, 23, Z1, 'metalDark');
  // 北縁の手すり(1.2m): 2か所は開けて飛び降りや射線を通す。P07/P21の前面とアンカー(y24..27.1)には出さない
  // 隙間: x410..422(西の狙撃窓: T08へ射線) / 452..462(飛び降り) / 482..494(主経路の対角が縁を越える) / 522..(P07前)
  k.box('gallery-rail', 404, 24, 256, 410, 25.2, 256.5, 'metal');
  k.box('gallery-rail', 422, 24, 256, 452, 25.2, 256.5, 'metal');
  k.box('gallery-rail', 462, 24, 256, 482, 25.2, 256.5, 'metal');
  k.box('gallery-rail', 494, 24, 256, 522, 25.2, 256.5, 'metal');
  k.box('gallery-rail', 404, 24, 256.5, 404.5, 25.2, 278, 'metal');
  // 狙撃窓(x410..422)の脇: デッキ上の荷箱(掩蔽と目印)。P21前面(x413..427 z272..278)と経路から離れている
  k.crate('crate', 407.5, 260.5, 3.4, 3.4, 2.6, 'crate', 24);
  k.crate('crate', 424.5, 260.5, 3.4, 3.4, 2.6, 'rust', 24);
  // デッキの設備: 操作盤・荷箱(経路 z=260 / z=266 / 南入口の対角から離す)と、縁の灯柱(暖色の発光体)
  k.box('deck-console', 504, 24, 271, 512, 25.6, 275, 'machine');
  k.box('deck-console-top', 505, 25.6, 271.6, 511, 26.2, 274.4, 'metalDark');
  k.crate('crate', 492, 274, 3.2, 3.2, 2.6, 'crate', 24);
  for (const x of [431, 474, 512]) {
    k.box('deck-lamp-post', x - 0.3, 24, 256.7, x + 0.3, 27.4, 257.3, 'metalDark');
    k.box('deck-lamp', x - 0.9, 27.4, 256.6, x + 0.9, 28, 257.4, 'lightPanel', { emissive: 0.9 });
  }
  // 柱(床〜桁): 4本 + 柱脚の危険帯
  for (const x of [420, 450, 480, 510]) {
    k.pillar('gallery-col', x, 258, 3, F + 1, 20.6, 'metalDark');
    k.box('gallery-col-base', x - 2, F, 256, x + 2, F + 1, 260, 'hazard');
  }

  // ================================================================== 東: タービン発電機(A) x502..527, z152..204
  k.box('turbine-plinth', 502, F, 152, 527, F + 1, 204, 'concreteDark');
  k.box('turbine-hp', 505, F + 1, 154, 524, F + 6.5, 170, 'machine');
  k.box('turbine-hp-ridge', 508, F + 6.5, 155, 521, F + 8, 169, 'metalDark');
  k.box('turbine-coupling', 511, F + 2.5, 170, 518, F + 5, 172, 'metalDark');
  k.box('turbine-lp', 505, F + 1, 172, 524, F + 7, 186, 'machine');
  k.box('turbine-lp-band', 504.8, F + 3.4, 171.8, 524.2, F + 4.4, 186.2, 'hazard');
  k.box('turbine-coupling', 511, F + 2.5, 186, 518, F + 5, 188, 'metalDark');
  k.box('turbine-gen', 505, F + 1, 188, 524, F + 6, 202, 'machine');
  k.box('turbine-gen-band', 504.8, F + 2.8, 187.8, 524.2, F + 3.8, 202.2, 'hazard');
  // 蒸気管: HPケーシングから上へ(縦)・東壁へ(横)。頭上(y>=14)
  k.pipe('steam-riser', 'y', 508.5, F + 8, 156, 511.3, F + 15, 158.8, 'pipe');
  k.pipe('steam-run', 'x', 508.5, F + 15, 156, X1, F + 17.8, 158.8, 'pipe');
  k.pipe('steam-riser', 'y', 519, F + 8, 156, 521.8, F + 12.5, 158.8, 'pipe');
  k.pipe('steam-run', 'z', 519, F + 12.5, 157, 521.8, F + 15.3, 190, 'pipe');
  // 排気の大ダクト(LP上部→東壁)
  k.box('exhaust-duct', 508, F + 7, 176, X1, F + 11.5, 184, 'metal');

  // ================================================================== 東: 制御棟 x506..526, z212..240, 高6 + 屋上設備
  k.box('control-bldg', 506, F, 212, 526, F + 6, 240, 'concreteDark');
  k.box('control-bldg-cap', 505.6, F + 6, 211.6, 526, F + 6.6, 240.4, 'metalDark');
  k.box('control-ac', 508, F + 6.6, 214, 513, F + 8.4, 219, 'machine');
  k.box('control-ac', 508, F + 6.6, 232, 513, F + 8.4, 237, 'machine');
  k.box('control-stack', 520, F + 6.6, 214, 522.8, F + 12.6, 216.8, 'metal');
  k.pipe('control-duct', 'z', 516, F + 6.6, 220, 518.8, F + 9.4, 230, 'pipe');
  // 制御棟の南: 冷却水配管(低い掩蔽)
  k.pipe('coolant', 'x', 502, F, 244, X1, F + 2.8, 246.8, 'pipe');
  k.pipe('coolant', 'x', 502, F + 2.8, 244, X1, F + 5.6, 246.8, 'pipe');

  // ================================================================== 南: 変圧器ヤード (z234.6..245.4)。T08(440,240)は谷間の台座
  xfmr(394, 236, 10, 8, 6.5);
  xfmr(408, 236, 10, 8, 6);
  xfmr(422, 236, 10, 8, 7);
  xfmr(448, 236, 10, 8, 6.5);
  xfmr(462, 236, 10, 8, 7);
  xfmr(476, 236, 10, 8, 6);
  xfmr(490, 236, 10, 8, 6.5);
  // 制御砲台T08(B3): 台座の根元にコンクリートの基礎、危険帯
  k.turret(440, 240, 6, { control: 2, face: [392, 156] });
  k.box('t08-base', 434.5, F, 234.5, 445.5, F + 0.8, 245.5, 'concreteDark');
  k.box('t08-band', 437.3, F + 2, 237.3, 442.7, F + 2.8, 242.7, 'hazard');
  k.box('t08-band', 437.3, F + 4.6, 237.3, 442.7, F + 5.2, 242.7, 'hazard');
  // 谷間の入口の低い防護柵(1.2m): 北側の警備が回り込む
  k.box('t08-guard-wall', 431.8, F, 231.6, 436, F + 1.2, 233, 'concrete');
  k.box('t08-guard-wall', 444, F, 231.6, 448.2, F + 1.2, 233, 'concrete');

  // ================================================================== ギャラリーの下: 大型変圧器ヤード (z260.6..273.4)
  xfmr(424, 262, 14, 10, 9);
  xfmr(452, 262, 14, 10, 8);
  xfmr(480, 262, 14, 10, 9.5);
  xfmr(508, 262, 14, 10, 8.5);

  // ================================================================== 北: ボイラー給水設備 (z143..149)。狙撃の陰 (466,147)
  k.box('feed-header', 404, F, 143, 436, F + 3, 149, 'machine');
  k.box('feed-header-band', 403.8, F + 1.4, 142.8, 436.2, F + 2.2, 149.2, 'hazard');
  k.pipe('feed-drum', 'x', 406, F + 3, 144, 434, F + 5.8, 146.8, 'metal');
  k.box('feed-pump', 444, F, 144, 450, F + 2.5, 148.4, 'machine');
  k.box('feed-pump', 456, F, 144, 462, F + 2.5, 148.4, 'machine');
  k.box('boiler', 470, F, 143, 496, F + 6.5, 149, 'rust');
  k.box('boiler-band', 469.8, F + 3, 142.8, 496.2, F + 4, 149.2, 'hazard');
  k.pipe('flue', 'y', 480, F + 6.5, 144.5, 483, C - 2, 147.5, 'pipe');
  k.box('flue-collar', 479.4, F + 6.5, 143.9, 483.6, F + 7.3, 148.1, 'metalDark');
  k.box('flue-collar', 479.4, C - 3, 143.9, 483.6, C - 2, 148.1, 'metalDark');
  // 給水ポンプの間の低い壁(狙撃位置の掩蔽 1.2m)
  k.box('nest-wall', 463, F, 144, 469, F + 1.2, 145.2, 'concrete');

  // ================================================================== 西: 隔壁P08(B3)の門型フレーム(前面 x392..398 z149..163 は空ける)と設備
  k.pillar('gate-post', 393.5, 147, 3, F, C - 2, 'metalDark');
  k.pillar('gate-post', 393.5, 169, 3, F, C - 2, 'metalDark');
  k.box('gate-post-base', X0, F, 145, 396, F + 1.2, 149, 'hazard');
  k.box('gate-post-base', X0, F, 166.6, 396, F + 1.2, 171.4, 'hazard');
  k.box('gate-lintel', X0, 12.4, 145.5, 397, 13.6, 170.5, 'metalDark'); // 降下の経路(x397でy<=10.9)より上
  // 隔壁の手前の遮蔽(高さ3m): T08→隔壁の射線(x397..400 で y>=4.7)と降下の経路(x>=404)の下に収まる
  k.box('w-cover', 396, F, 171, 399.5, F + 3, 175.5, 'machine');
  k.box('w-cover-band', 395.8, F + 1.4, 170.8, 399.7, F + 2.2, 175.7, 'hazard');
  // 西壁ぞいの低い設備(射線 T08→隔壁 を切らない: 隔壁前 z<175 は避ける)
  k.box('w-cabinet', X0, F, 182, 396.4, F + 2.5, 190, 'machine');
  k.box('w-cabinet', X0, F, 196, 396.4, F + 2.5, 204, 'machine');
  k.box('w-cabinet', X0, F, 210, 396.4, F + 2.5, 218, 'machine');
  k.box('w-barrier', 397.5, F, 176, 399.5, F + 1.2, 186, 'concrete');
  k.box('w-barrier', 397.5, F, 206, 399.5, F + 1.2, 226, 'concrete');

  // ================================================================== 東壁ぞい(北): 高い機械の陰と回り込みの低い壁
  k.box('e-cover', 502, F, 229.5, 505, F + 1.2, 232, 'concrete');

  // ================================================================== 天井: 橋形クレーン(走行桁は東西の壁ぞい, 橋桁は東西方向)。空中の対角の経路(y24..27)より上
  k.box('runway', X0, 33, Z0 + 2, X0 + 2.5, 35, Z1 - 2, 'metalDark');
  k.box('runway', X1 - 2.5, 33, Z0 + 2, X1, 35, Z1 - 2, 'metalDark');
  k.box('crane-truck', X0, 35, 187, X0 + 4, 37.6, 199, 'machine');
  k.box('crane-truck', X1 - 4, 35, 187, X1, 37.6, 199, 'machine');
  k.box('crane-bridge', X0 + 4, 35.2, 190, X1 - 4, 37.6, 192, 'metal');
  k.box('crane-bridge', X0 + 4, 35.2, 194, X1 - 4, 37.6, 196, 'metal');
  for (const x of [420, 450, 480, 510]) k.box('crane-brace', x, 35.2, 192, x + 1, 37.6, 194, 'metalDark');
  k.box('crane-trolley', 466, 34.6, 189, 474, 37.6, 197, 'machine');
  // つり荷(タービンのロータ 長さ12m): 台車の下にワイヤ2本で吊る(床+28..31)
  k.pipe('rotor', 'x', 464, 28, 191.1, 476, 30.9, 194, 'metal');
  k.box('rotor-sling', 466.4, 30.9, 191.8, 467.2, 34.6, 192.6, 'metalDark');
  k.box('rotor-sling', 472.8, 30.9, 191.8, 473.6, 34.6, 192.6, 'metalDark');

  // ================================================================== 天井の梁と配管(頭上)
  for (const z of [160, 200, 240]) k.box('roof-beam', X0, 38, z - 0.8, X1, 39.6, z + 0.8, 'metalDark');
  k.pipe('roof-pipe', 'x', X0, 36, 168, X1, 38, 170, 'pipe');
  k.pipe('roof-pipe', 'x', X0, 36, 226, X1, 38, 228, 'pipe');

  // ================================================================== 壁の構造: 付け柱(壁から2.4m張り出す)と梁・ケーブルトレイ・壁ぞいの配管
  // 北壁の付け柱(給水設備・ボイラーの隙間)
  for (const x of [440, 466, 500, 524]) k.box('pilaster', x - 1.5, F, Z0, x + 1.5, 32, Z0 + 2.4, 'concrete');
  // 南壁の付け柱(ギャラリー・変圧器ヤードの間)
  for (const x of [404, 452, 480, 500, 522]) k.box('pilaster', x - 1.5, F, Z1 - 1.6, x + 1.5, 32, Z1, 'concrete');
  // 西壁の付け柱(隔壁の前 z145..172 は避ける)
  for (const z of [180, 208, 236, 262]) k.box('pilaster', X0, F, z - 1.5, X0 + 2.4, 30, z + 1.5, 'concrete');
  // 東壁の付け柱(タービン・制御棟の間)
  for (const z of [150, 206]) k.box('pilaster', X1 - 2.4, F, z - 1.5, X1, 30, z + 1.5, 'concrete');
  // 壁ぞいの梁(付け柱の頭をつなぐ)
  k.box('wall-beam', X0, 30, 176, X0 + 2.4, 31.4, 266, 'metalDark');
  k.box('wall-beam', X1 - 2.4, 30, 146, X1, 31.4, 254, 'metalDark');
  k.box('wall-beam', 400, 32, Z0, 510, 33.4, Z0 + 2.4, 'metalDark');
  // ケーブルトレイ(壁ぞい, 高所)
  k.box('cable-tray', X0, 16, 145, X0 + 1.6, 17.2, 276, 'metalDark');
  k.box('cable-tray', X1 - 1.6, 16, 145, X1, 17.2, 254, 'metalDark');
  k.box('cable-tray', 396, 21.6, Z0, 524, 22.8, Z0 + 1.6, 'metalDark');
  // 壁ぞいの大配管(西壁: 隔壁より南 / 東壁)
  k.pipe('wall-pipe', 'z', X0, 20, 176, X0 + 2.8, 22.8, 266, 'pipe');
  k.pipe('wall-pipe', 'z', X1 - 2.8, 20, 146, X1, 22.8, 254, 'rust');

  // ================================================================== ボイラーの上部(高所の塔): 北壁ぞいに 6.5 -> 20m
  k.box('boiler-upper', 472, F + 6.5, 143.5, 494, F + 14, 148.5, 'metal');
  k.box('boiler-upper-band', 471.8, F + 10, 143.3, 494.2, F + 11, 148.7, 'hazard');
  k.pipe('boiler-drum', 'x', 474, F + 14, 144, 492, F + 17, 147, 'pipe');
  k.box('boiler-catwalk', 470, F + 14, 143, 496, F + 14.6, 149, 'grating'); // 上の点検足場(縁のみ)

  // ================================================================== 東壁ぞいの高い機械: 制御棟の南 (z244..254 は冷却水配管)
  k.box('e-silo', 519, F, 248, 527, F + 10, 254, 'metal');
  k.box('e-silo-band', 518.8, F + 3, 247.8, 527, F + 4, 254, 'hazard');
  k.box('e-silo-band', 518.8, F + 7, 247.8, 527, F + 8, 254, 'hazard');

  // ================================================================== 西壁ぞいの高い機械 (隔壁前 z<175 は避ける)
  k.box('w-tank', X0, F, 224, 399, F + 8, 232, 'metalDark');
  k.box('w-tank-band', X0, F + 4, 223.8, 399.2, F + 5, 232.2, 'hazard');

  // ================================================================== 廃工場の残骸: 落ちたガントリー(北東の隅)・落下した荷・垂れ下がる配管(床から28m以上)
  k.box('fallen-gantry', 498, F, 144, 511, F + 1.4, 146.2, 'metalDark');
  k.box('fallen-gantry', 501, F + 1.4, 145, 509, F + 2.4, 146.4, 'rust');
  k.crate('crate', 500.5, 148, 4, 3, 2.6, 'crate', F);
  k.box('fallen-gantry-leg', 511, F, 146.2, 512.6, F + 3, 149, 'metalDark');
  for (const [x, z] of [[430, 168], [470, 215]] as [number, number][]) {
    k.pipe('hang-pipe', 'y', x - 1.2, 28, z - 1.2, x + 1.2, C - 0.8, z + 1.2, 'pipe');
    k.box('hang-pipe-flange', x - 1.8, C - 0.8, z - 1.8, x + 1.8, C, z + 1.8, 'metalDark');
    k.box('hang-pipe-break', x - 1.6, 27.4, z - 1.6, x + 1.6, 28, z + 1.6, 'rust');
  }
  // 荷の山(ギャラリー下・西): 色のある木箱
  k.crate('crate', 398, 266, 6, 4, 2.6, 'crate', F);
  k.crate('crate', 398, 272, 6, 4, 2.6, 'crate', F);
  k.crate('crate', 398.5, 268.8, 4, 4, 2.6, 'crate', F + 2.6);
  k.crate('crate', 404.5, 250, 5, 5, 2.6, 'crate', F);
  k.crate('crate', 512, 264, 5, 6, 2.6, 'crate', F);
  k.crate('crate', 518, 270.5, 4, 5, 2.6, 'crate', F);

  // ================================================================== 敵
  k.guard(404, 196, { face: [450, 190], patrol: [{ x: 404, y: 1.5, z: 196 }, { x: 404, y: 1.5, z: 172 }, { x: 420, y: 1.5, z: 158 }, { x: 420, y: 1.5, z: 200 }] });
  k.guard(462, 152, { face: [450, 200], patrol: [{ x: 462, y: 1.5, z: 152 }, { x: 490, y: 1.5, z: 152 }, { x: 490, y: 1.5, z: 175 }, { x: 462, y: 1.5, z: 175 }] });
  k.guard(508, 208, { face: [450, 200] });
  k.turret(516, 145, 6, { face: [450, 200] });

  // ================================================================== 装飾(衝突なし)
  // 天井の水銀灯(暖色): 天井スラブ面(y=40)に密着
  for (const x of [420, 460, 500]) for (const z of [150, 180, 215, 250]) k.decor('ceiling-lamp', x - 3, C - 0.15, z - 1.2, x + 3, C, z + 1.2, 'lightPanel');
  // 変圧器ヤードの寒色灯(南壁・ギャラリー下)
  for (const x of [410, 440, 470, 500]) k.decor('cold-lamp', x - 2, 8, Z1 - 0.12, x + 2, 8.5, Z1, 'glass', { emissive: 0.9 });
  // 隔壁の赤い警告灯(門型フレームの内側)
  k.decor('gate-lamp', 397, 12.6, 149, 397.1, 13.2, 153, 'gate', { emissive: 0.9 });
  k.decor('gate-lamp', 397, 12.6, 159, 397.1, 13.2, 163, 'gate', { emissive: 0.9 });
  // T09(通常の砲台)の台座: 橙の表示板(制御砲台の赤と区別する)
  k.decor('t09-plate', 514.4, 2.6, 147.5, 517.6, 4.6, 147.6, 'hazard', { emissive: 0.7 });
  k.decor('t09-plate', 513.4, 2.6, 143.4, 513.5, 4.6, 146.6, 'hazard', { emissive: 0.7 });
  // T08 台座上面の赤い灯
  k.decor('t08-lamp', 437.6, 6, 237.6, 438.6, 6.1, 238.6, 'gate', { emissive: 0.9 });
  k.decor('t08-lamp', 441.4, 6, 241.4, 442.4, 6.1, 242.4, 'gate', { emissive: 0.9 });
  // 壁の下部を暗い帯で締める(0..14m)と、その上端の危険帯(12..12.8m)。隔壁の面(西壁 z149..163)は空ける
  k.decor('wall-band', X0, F, Z0, X1, 14, Z0 + 0.1, 'concreteDark');
  k.decor('wall-band', X0, F, Z1 - 0.1, X1, 14, Z1, 'concreteDark');
  k.decor('wall-band', X1 - 0.1, F, Z0 + 0.1, X1, 14, Z1 - 0.1, 'concreteDark');
  k.decor('wall-band', X0, F, Z0 + 0.1, X0 + 0.1, 14, 148.5, 'concreteDark');
  k.decor('wall-band', X0, F, 163.5, X0 + 0.1, 14, Z1 - 0.1, 'concreteDark');
  k.decor('wall-stripe', X0 + 0.1, 14, Z0, X1 - 0.1, 14.7, Z0 + 0.12, 'hazard');
  k.decor('wall-stripe', X0 + 0.1, 14, Z1 - 0.12, X1 - 0.1, 14.7, Z1, 'hazard');
  k.decor('wall-stripe', X1 - 0.12, 14, Z0 + 0.12, X1, 14.7, Z1 - 0.12, 'hazard');
  k.decor('wall-stripe', X0, 14, 164, X0 + 0.12, 14.7, Z1 - 0.12, 'hazard');
  // 壁の上部の設備パネル(機械・暗色)
  for (const x of [410, 470, 510]) k.decor('wall-panel', x, 24, Z0, x + 10, 30, Z0 + 0.1, 'machine');
  for (const z of [190, 230]) k.decor('wall-panel', X0, 24, z, X0 + 0.1, 30, z + 12, 'machine');
  for (const z of [170, 210, 230]) k.decor('wall-panel', X1 - 0.1, 24, z, X1, 30, z + 12, 'machine');
  // 床: アリーナ(明るいタイル)の外側を暗いコンクリートの帯にして、設備の区域を分ける
  floorPlate('zone-n', X0, Z0, X1, 150, 'concreteDark');
  floorPlate('zone-s', X0, 230, X1, 256, 'concreteDark');
  floorPlate('zone-e', 500, 150, X1, 230, 'concreteDark');
  floorPlate('zone-w', X0, 150, 400, 230, 'concreteDark');
  // 制御砲台T08 の台座: 四面の赤い表示板(遠くからも識別できる)
  k.decor('t08-plate', 438.4, 2.6, 237.4, 441.6, 4.6, 237.5, 'gate', { emissive: 0.9 });
  k.decor('t08-plate', 438.4, 2.6, 242.5, 441.6, 4.6, 242.6, 'gate', { emissive: 0.9 });
  k.decor('t08-plate', 437.4, 2.6, 238.4, 437.5, 4.6, 241.6, 'gate', { emissive: 0.9 });
  k.decor('t08-plate', 442.5, 2.6, 238.4, 442.6, 4.6, 241.6, 'gate', { emissive: 0.9 });
  // ギャラリーの縁: 手すりの橙灯と縁の危険帯
  for (const x of [406, 428, 440, 466, 500, 512]) k.decor('rail-lamp', x, 24.4, 256.5, x + 1.6, 25, 256.6, 'hazard', { emissive: 0.85 });
  for (let x = 405; x < 524; x += 14) k.decor('gallery-edge', x, 24.03, 256.6, x + 7, 24.14, 257.4, 'hazard');
  // 入口(P07 東壁 / P21 南壁)の上の橙の警告灯
  k.decor('p07-lamp', X1 - 0.1, 32.4, 260, X1, 33.2, 272, 'hazard', { emissive: 0.85 });
  k.decor('p21-lamp', 414, 32.4, Z1 - 0.1, 426, 33.2, Z1, 'hazard', { emissive: 0.85 });
  // 崩落穴の縁の警告帯(デッキ上面)
  k.decor('hole-edge', 437, 24.03, 258, 438, 24.14, 265, 'hazard');
  k.decor('hole-edge', 446, 24.03, 258, 447, 24.14, 265, 'hazard');
  k.decor('hole-edge', 438, 24.03, 257.2, 446, 24.14, 258, 'hazard');
  k.decor('hole-edge', 438, 24.03, 265, 446, 24.14, 265.8, 'hazard');
  // 床のライン: アリーナの縁の危険帯(破線)。衝突なし
  for (let x = 401; x < 499; x += 12) {
    floorPlate('arena-line', x, 150.2, x + 6, 150.9, 'hazard');
    floorPlate('arena-line', x, 229.1, x + 6, 229.8, 'hazard');
  }
  for (let z = 152; z < 229; z += 12) {
    floorPlate('arena-line', 400.2, z, 400.9, z + 6, 'hazard');
    floorPlate('arena-line', 499.1, z, 499.8, z + 6, 'hazard');
  }
  // 隔壁の前面: 床の危険帯
  floorPlate('gate-floor', 392.2, 148.2, 398.8, 149, 'hazard');
  floorPlate('gate-floor', 392.2, 163, 398.8, 163.8, 'hazard');
}
