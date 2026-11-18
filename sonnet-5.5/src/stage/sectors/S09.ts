/**
 * S09 冷却設備 (factory, 地上0 / 天井30): 冷たい青白い色調の冷却プラント。昇降C3(西南の冷却塔デッキ +12)は固定。
 *  - 南東に大型の冷却塔(ルーバー・ファン筒・砲台T10), 中央南に八角形の大型貯水タンク2基, 西に水槽(縁つきの水面), 東に熱交換器の列, 天井に配管格子。
 *  - 中央(ARENA_CLEAR)は空け、塔・タンク・ポンプ室・熱交換器・水槽の縁が低(1.4〜2.6)/中(5.7)/高(10〜15)の掩蔽になる。
 *  - 東の入口(P08)からは G20 と遠くの T10 が見え、奥(アリーナ→南のデッキ)へ進むと 3 体が別方向から狙う。
 *  - 警備2 + 砲台1(T10)。制御砲台はない(制御B3は動力棟S08)。
 *  - 踏み台の規則: 昇降C3/C1 の離陸位置から40m以内の「2x2m以上の上面」は、高さ 2.6m 以下か 5.7m 以上だけにする(ジャンプの連鎖で足場に届かないように)。
 */
import type { Kit } from '../kit';

export function build(k: Kit): void {
  const F = k.floorY; // 0
  const C = k.ceilingY; // 30

  // ================================================================== 昇降 C3 (足場と支柱は kit が作る。位置は変えない)
  k.climbPads('C3', [[310, 238], [310, 276]]);

  // ---- decor helpers (衝突なし)
  type DM = 'hazard' | 'concreteDark' | 'metal' | 'metalDark' | 'glass' | 'machine' | 'rust' | 'pipe';
  const floorPlate = (name: string, x0: number, z0: number, x1: number, z1: number, mat: DM, emissive?: number): void => {
    k.decor(name, x0, F - 0.02, z0, x1, F + 0.05, z1, mat, emissive !== undefined ? { emissive } : {});
  };
  const wallN = (name: string, x0: number, y0: number, x1: number, y1: number, mat: DM, emissive?: number): void => {
    k.decor(name, x0, y0, 141.9, x1, y1, 142.12, mat, emissive !== undefined ? { emissive } : {});
  };
  const wallS = (name: string, x0: number, y0: number, x1: number, y1: number, mat: DM, emissive?: number): void => {
    k.decor(name, x0, y0, 277.88, x1, y1, 278.1, mat, emissive !== undefined ? { emissive } : {});
  };
  const wallW = (name: string, z0: number, y0: number, z1: number, y1: number, mat: DM, emissive?: number): void => {
    k.decor(name, 271.9, y0, z0, 272.12, y1, z1, mat, emissive !== undefined ? { emissive } : {});
  };
  const wallE = (name: string, z0: number, y0: number, z1: number, y1: number, mat: DM, emissive?: number): void => {
    k.decor(name, 387.88, y0, z0, 388.1, y1, z1, mat, emissive !== undefined ? { emissive } : {});
  };

  // ================================================================== 天井: 桁・配管格子・冷光の吊り照明
  for (const x of [292, 326, 360]) k.box('girder', x - 0.9, 25.6, 142, x + 0.9, C, 278, 'metalDark');
  for (const z of [176, 246]) k.box('purlin', 272, 27.4, z - 0.6, 388, C, z + 0.6, 'metal');
  // 配管格子: x方向 y 21..23.6 と z方向 y 23.9..26.5 が交差(交点の垂れ配管あり)
  for (const z of [166, 214, 252, 270]) k.pipe('grid-x', 'x', 272, 21, z - 1.3, 388, 23.6, z + 1.3, 'pipe');
  for (const x of [304, 344]) k.pipe('grid-z', 'z', x - 1.3, 23.9, 142, x + 1.3, 26.5, 278, 'pipe');
  // 垂れ配管(格子から下へ。下端は高さ13m以上)
  for (const [x, z] of [[304, 166], [344, 214], [344, 166]] as [number, number][]) k.pipe('drop', 'y', x - 0.9, 13.5, z - 0.9, x + 0.9, 21, z + 0.9, 'pipe');
  k.pipe('drop-broken', 'y', 303.1, 8.6, 261.1, 304.9, 23.9, 262.9, 'pipe');
  // 吊り照明(冷たい青白: 発光ガラス)
  for (const x of [292, 326, 360]) {
    for (const z of [160, 200, 240]) {
      k.box('lamp-stem', x - 0.3, 24.4, z - 0.3, x + 0.3, 25.6, z + 0.3, 'metalDark');
      k.box('lamp', x - 2.6, 23.6, z - 1.2, x + 2.6, 24.4, z + 1.2, 'glass', { emissive: 0.9 });
    }
  }
  // 水槽の上の照明(水面を照らす)
  k.box('pool-lamp-stem', 291.7, 9.2, 220.7, 292.3, 25.6, 221.3, 'metalDark');
  k.box('pool-lamp', 289, 8.6, 219.6, 295, 9.2, 222.4, 'glass', { emissive: 0.9 });

  // ================================================================== 南東: 大型冷却塔(ルーバー+ファン筒+砲台)
  k.box('tower', 350, F, 246, 384, 15, 276, 'concrete');
  k.box('tower-base', 348.4, F, 244.4, 385.6, 1.4, 277.6, 'concreteDark');
  for (const x of [358, 367, 376]) for (const z of [253, 267]) k.pipe('fan-stack', 'y', x - 1.5, 15, z - 1.5, x + 1.5, 18.4, z + 1.5, 'metalDark');
  k.box('tower-rim', 350, 15, 246, 384, 15.9, 247, 'metal');
  k.box('tower-rim', 350, 15, 275, 384, 15.9, 276, 'metal');
  k.box('tower-rim', 350, 15, 247, 351, 15.9, 275, 'metal');
  k.box('tower-rim', 383, 15, 247, 384, 15.9, 275, 'metal');
  // 冷却塔と貯水タンクの間の配管橋(高さ 7..9.2)
  for (const y of [7, 9.4]) k.pipe('bridge-pipe', 'x', 339, y, 258, 350, y + 2, 260, 'pipe');
  k.pipe('bridge-pipe', 'x', 339, 11.8, 262, 350, 13.8, 264, 'pipe');

  // ================================================================== 大型貯水タンク(八角形の近似: 十字 + 角落としの矩形)
  const tank = (cx: number, cz: number, r: number, h: number, mat: 'metal' | 'rust'): void => {
    k.box('tank', cx - r, F, cz - r * 0.45, cx + r, h, cz + r * 0.45, mat);
    k.box('tank', cx - r * 0.45, F, cz - r, cx + r * 0.45, h + 0.05, cz + r, mat);
    k.box('tank', cx - r * 0.8, F, cz - r * 0.8, cx + r * 0.8, h + 0.1, cz + r * 0.8, mat);
    k.box('tank-hatch', cx - 2, h + 0.1, cz - 2, cx + 2, h + 0.9, cz + 2, 'metalDark');
  };
  tank(330, 262, 9, 14, 'metal');
  tank(346, 222, 8, 10, 'rust');
  k.pipe('tank-riser', 'y', 320.4, 14, 251.4, 322.2, 23.6, 253.2, 'pipe');

  // ================================================================== 水槽: 縁つきの水面(西, x 276..298 z 210..232)
  k.box('pool-rim', 276, F, 210, 298, 1.4, 211.2, 'concreteDark');
  k.box('pool-rim', 276, F, 230.8, 298, 1.4, 232, 'concreteDark');
  k.box('pool-rim', 276, F, 211.2, 277.2, 1.4, 230.8, 'concreteDark');
  k.box('pool-rim', 296.8, F, 211.2, 298, 1.4, 230.8, 'concreteDark');
  k.box('pool-water', 277.2, F, 211.2, 296.8, 0.9, 230.8, 'glass', { emissive: 0.45 });
  k.pipe('pool-inlet', 'z', 285, F, 232, 287.4, 2.4, 240, 'pipe');
  k.box('pool-pump', 279, F, 233.4, 283, 2.4, 238, 'machine');

  // ================================================================== 東: ポンプ室・熱交換器の列・弁ステーション
  k.box('pump-house', 366, F, 212, 384, 5.8, 226, 'machine');
  k.pipe('pump-pipe', 'x', 354, 6.2, 214, 366, 8.6, 216.4, 'pipe');
  k.box('pump-cabinet', 362, F, 228, 368, 2.5, 232, 'metal');
  k.box('valve-station', 366, F, 178, 380, 2.6, 184, 'machine');
  // 熱交換器(横置きの円筒 3 本 + 鞍)
  for (const z of [189, 195, 201]) {
    k.pipe('exchanger', 'x', 368, 2.7, z - 1.5, 386, 5.7, z + 1.5, 'metal');
    for (const x of [372, 382]) k.box('exchanger-saddle', x - 0.6, F, z - 1.4, x + 0.6, 2.7, z + 1.4, 'metalDark');
  }
  k.pipe('exchanger-header', 'z', 386, 2.7, 187, 388, 5.7, 203, 'pipe');

  // ================================================================== 北: 冷凍機(北壁沿い) と 西: 立ち上がり配管
  k.box('chiller', 284, F, 142, 298, 3, 146, 'machine');
  k.box('chiller', 322, F, 142, 336, 3, 146, 'machine');
  k.pipe('north-header', 'x', 274, 8, 142.4, 386, 10.4, 144.8, 'pipe');
  for (const z of [152, 164, 176, 188, 200]) k.pipe('riser', 'y', 272.4, F, z - 1, 274.4, 21, z + 1, 'pipe');

  // ================================================================== 冷却塔デッキ(+12)の上: 温水槽と冷却セル (主経路 z=234..260 と C3 コリドーは空ける)
  k.box('hot-basin', 298, 12, 258, 311, 15.2, 277, 'metal');
  k.box('hot-water', 299, 15.2, 259, 310, 15.6, 276, 'glass', { emissive: 0.45 });
  k.box('cell', 281, 12, 264, 296, 18, 277, 'concrete');
  k.pipe('cell-stack', 'y', 285, 18, 269, 288, 21, 272, 'metalDark');
  for (const [x, z] of [[292, 246], [292, 262], [292, 276], [276, 240]] as [number, number][]) k.pillar('deck-col', x, z, 2, F, 10, 'metalDark');
  // C3 の離陸位置(304,228)の四隅の信号灯(青白)
  for (const [x, z] of [[298.4, 222.6], [309.4, 222.6], [298.4, 233.2], [309.4, 233.2]] as [number, number][]) k.box('takeoff-beacon', x - 0.45, F, z - 0.45, x + 0.45, 1.4, z + 0.45, 'glass', { emissive: 0.7 });

  // ================================================================== 冷却塔の点検通路(+6.5)と支柱、管の弁、北東の制御小屋、樽
  k.catwalk('tower-walk', 352, 242.4, 382, 246, 6.5, ['n']);
  for (const x of [356, 368, 380]) k.box('tower-walk-post', x - 0.6, F, 242.8, x + 0.6, 5.5, 244, 'metalDark');
  k.decor('tower-ladder', 383.88, 0, 262, 384.1, 14.6, 263.4, 'grating');
  for (const [x, z] of [[304, 166], [344, 214], [344, 166]] as [number, number][]) k.box('valve', x - 1.2, 12.2, z - 1.2, x + 1.2, 13.5, z + 1.2, 'metalDark');
  for (const x of [300, 340, 380]) k.box('header-post', x - 0.7, F, 142.4, x + 0.7, 8, 143.8, 'metalDark');
  k.box('shack', 372, F, 143, 381, 3, 148.6, 'metal');
  k.box('shack-glass', 372, 3, 148, 381, 4.6, 148.6, 'glass', { emissive: 0.45 });
  k.box('shack-roof', 371.6, 4.6, 142.4, 381.6, 5.1, 148.9, 'metalDark');
  for (const [x, z] of [[356, 236], [358.6, 237.6], [356.4, 239], [359, 240.2]] as [number, number][]) k.pipe('barrel', 'y', x - 0.8, F, z - 0.8, x + 0.8, 1.8, z + 0.8, 'rust');
  k.box('basin-valve', 300, 15.6, 260, 302, 17.2, 262, 'metalDark');
  k.box('basin-valve', 306, 15.6, 268, 308, 17.2, 270, 'metalDark');

  // 南中央の掩蔽: 縦の調圧タンク(円筒 6m) と低い弁マニホールド(2.4m)
  k.pipe('surge-tank', 'y', 322.5, F, 242.5, 325.5, 6, 245.5, 'metal');
  k.pipe('surge-tank', 'y', 327, F, 247, 330, 6, 250, 'metalDark');
  k.box('manifold', 312, F, 250, 320, 2.4, 253, 'pipe');
  k.box('manifold', 334, F, 236, 340, 2.4, 238.4, 'pipe');
  k.pipe('surge-tank', 'y', 312.5, F, 240.5, 315.5, 6, 243.5, 'metal');

  // ================================================================== 残骸・小物
  k.crate('crate', 340, 209.4, 8, 4, 2.4, 'crate');
  k.crate('crate', 332, 240, 4, 4, 2.4, 'crate');
  k.box('fallen-pipe', 304, F, 208, 322, 1.6, 209.8, 'pipe');
  k.box('fallen-pipe', 322, F, 207, 323.8, 1.6, 215, 'pipe');
  k.pipe('drum', 'y', 358, F, 208, 361, 1.4, 211, 'rust');

  // ================================================================== 砲台1 + 警備2
  k.turret(368, 258, 3, { baseY: 15, face: [320, 190] });
  k.guard(330, 182, { patrol: [{ x: 330, y: 1.5, z: 182 }, { x: 345, y: 1.5, z: 196 }, { x: 320, y: 1.5, z: 196 }] });
  k.guard(304, 214, { patrol: [{ x: 306, y: 1.5, z: 213 }, { x: 320, y: 1.5, z: 226 }, { x: 304, y: 1.5, z: 242 }] });

  // ================================================================== 装飾(衝突なし)
  // 水槽の縁のハザード
  k.decor('pool-mark', 276, 1.35, 210, 298, 1.45, 211.2, 'hazard');
  k.decor('pool-mark', 276, 1.35, 230.8, 298, 1.45, 232, 'hazard');
  // 離陸位置(C3, (304,228))の発着枠
  floorPlate('pad-mark', 297.5, 222, 310.5, 222.8, 'hazard');
  floorPlate('pad-mark', 297.5, 233, 310.5, 233.8, 'hazard');
  floorPlate('pad-mark', 297.5, 222.8, 298.3, 233, 'hazard');
  floorPlate('pad-mark', 309.7, 222.8, 310.5, 233, 'hazard');
  floorPlate('pad-fill', 298.5, 223.4, 309.5, 232.4, 'concreteDark');
  // アリーナの床(冷たい金属板) と境界
  floorPlate('arena-floor', 278, 148, 358, 204, 'metal');
  floorPlate('arena-edge', 278, 148, 358, 148.8, 'hazard');
  floorPlate('arena-edge', 278, 203.2, 358, 204, 'hazard');
  floorPlate('arena-edge', 278, 148.8, 278.8, 203.2, 'hazard');
  floorPlate('arena-edge', 357.2, 148.8, 358, 203.2, 'hazard');
  // 冷たい鋼板の床(南の作業帯・東の入口帯・水槽まわり)
  floorPlate('steel', 300, 206, 350, 244, 'metal');
  floorPlate('steel', 300, 244, 348, 278, 'metal');
  floorPlate('steel', 360, 143, 387, 208, 'metal');
  floorPlate('steel', 274, 206, 300, 236, 'metal');
  // 水漏れの水たまり(青白く光る)
  floorPlate('puddle', 312, 196, 322, 202, 'glass', 0.4);
  floorPlate('puddle', 336, 236, 344, 244, 'glass', 0.4);
  floorPlate('puddle', 366, 236, 378, 242, 'glass', 0.4);
  floorPlate('puddle', 352, 166, 358, 172, 'glass', 0.4);
  floorPlate('stain', 340, 176, 352, 186, 'concreteDark');
  floorPlate('stain', 300, 250, 318, 260, 'concreteDark');
  // 入口(P08)からアリーナへの誘導帯
  floorPlate('lane', 362, 155.4, 386, 156.2, 'hazard');
  // 東壁の扉枠(P08: z 149..163, y 0..8)
  k.decor('p08-frame', 387.88, 0, 148.2, 388.1, 8.8, 149, 'hazard');
  k.decor('p08-frame', 387.88, 0, 163, 388.1, 8.8, 163.8, 'hazard');
  k.decor('p08-frame', 387.88, 8, 148.2, 388.1, 8.8, 163.8, 'hazard');
  // 西壁の扉枠(P09: z 259..273, y 12..20)
  k.decor('p09-frame', 271.9, 12, 258.2, 272.12, 20.8, 259, 'hazard');
  k.decor('p09-frame', 271.9, 12, 273, 272.12, 20.8, 273.8, 'hazard');
  k.decor('p09-frame', 271.9, 20, 258.2, 272.12, 20.8, 273.8, 'hazard');
  // 冷却塔のルーバー(北面と西面)と冷光の帯
  for (const y of [2.6, 5.2, 7.8, 10.4, 13]) {
    k.decor('louver', 352, y, 245.86, 382, y + 1.3, 246.1, 'metalDark');
    k.decor('louver', 349.86, y, 248, 350.1, y + 1.3, 274, 'metalDark');
    k.decor('louver-glow', 352, y + 1.35, 245.86, 382, y + 1.55, 246.1, 'glass', { emissive: 0.4 });
  }
  // 壁: 足元の帯・制御盤・指示灯・冷光の看板
  wallN('base-band', 274, 0, 386, 0.9, 'hazard');
  wallS('base-band', 322, 0, 386, 0.9, 'hazard');
  wallS('panel', 320, 3, 346, 6, 'metalDark');
  wallS('panel-glow', 322, 4.2, 344, 4.6, 'glass', 0.4);
  wallW('base-band', 143, 0, 258, 0.9, 'hazard');
  wallE('base-band', 164, 0, 276, 0.9, 'hazard');
  wallE('panel', 168, 3, 200, 6, 'metalDark');
  wallE('panel-glow', 170, 4.2, 198, 4.6, 'glass', 0.4);
  wallN('sign', 300, 11, 314, 14, 'hazard');
  wallN('streak', 342, 10, 345, 29.9, 'rust');
  wallS('streak', 288, 12, 291, 29.9, 'rust');
  wallW('streak', 200, 10, 203, 29.9, 'rust');
  // 天井際の冷光帯(発光。ライトの数を増やさないよう 0.5 未満)
  for (const x of [276, 309, 343, 376]) k.decor('ceiling-strip', x - 0.6, 29.86, 145, x + 0.6, 30.1, 274, 'glass', { emissive: 0.4 });
}
