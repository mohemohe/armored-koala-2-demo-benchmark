/**
 * S03 圧延棟 (factory, 地上0 / 天井26): 熱間圧延ラインの廃工場。制御砲台T03(B1)が北東の台座から東の隔壁(P03)を見る。
 *  - 西壁沿いに加熱炉(赤熱する装入口), 南に圧延スタンド3基とロールテーブル(上に点検通路), 東に剪断機・冷却槽・コイル置場, 北にスラブヤード・ローラーコンベア・高所の点検路。
 *  - 天井は桁と天井クレーン(取鍋を吊る)。中央(ARENA_CLEAR)は空け、周囲の機械が低(1.2〜2.4)/中(5.8〜9)/高(13)の掩蔽になる。
 *  - 入口(P02)からは G09 だけが見え、T03/T04 は炉と機械の陰。アリーナに出ると 4〜5 体が別方向から狙う。
 *  - 遠距離狙撃: 北の落下した足場/桁の陰(約 (257..269, 19..33))から T03 を撃てる(隔壁から約 100m)。
 *  - 踏み台の規則: 昇降C1 の離陸位置(352,100)から40m以内の「2x2m以上の上面」は 2.6m 以下か 5.7m 以上だけ(ジャンプの連鎖で足場に届かないように)。
 */
import type { Kit } from '../kit';

export function build(k: Kit): void {
  const F = k.floorY; // 0
  const C = k.ceilingY; // 26

  // ---- decor helpers (衝突なし。ホスト箱の面から0.16m以内に置く)
  type DM = 'rust' | 'concreteDark' | 'hazard' | 'metalDark' | 'machine' | 'pipe' | 'concrete' | 'metal' | 'glass';
  const ex = (e?: number): { emissive?: number } => (e !== undefined ? { emissive: e } : {});
  const floorPlate = (name: string, x0: number, z0: number, x1: number, z1: number, mat: DM, emissive?: number): void => {
    k.decor(name, x0, F - 0.02, z0, x1, F + 0.05, z1, mat, ex(emissive));
  };
  const wallN = (name: string, x0: number, y0: number, x1: number, y1: number, mat: DM, emissive?: number): void => {
    k.decor(name, x0, y0, 1.9, x1, y1, 2.13, mat, ex(emissive));
  };
  const wallS = (name: string, x0: number, y0: number, x1: number, y1: number, mat: DM, emissive?: number): void => {
    k.decor(name, x0, y0, 137.87, x1, y1, 138.1, mat, ex(emissive));
  };

  // ================================================================== 天井: 桁・クレーン・照明
  for (const x of [214, 234, 254, 274, 294, 314]) k.box('girder', x - 0.9, 22, 2, x + 0.9, C, 138, 'metalDark');
  for (const z of [26, 70, 114]) k.box('purlin', 202, 24.2, z - 0.6, 328, C, z + 0.6, 'metal');
  // 蒸気の主管(桁の下を横切る)
  k.pipe('steam-header', 'x', 202, 19.4, 33.2, 328, 21.8, 35.6, 'pipe');
  k.pipe('steam-header', 'x', 202, 19.4, 103.2, 328, 21.8, 105.6, 'pipe');
  // 吊り照明(軸 + 灯体)。暖色の水銀灯
  for (const x of [214, 254, 294]) {
    for (const z of [18, 50, 90, 122]) {
      k.box('lamp-stem', x - 0.3, 20.2, z - 0.3, x + 0.3, 22, z + 0.3, 'metalDark');
      k.box('lamp', x - 3, 19.6, z - 1.2, x + 3, 20.2, z + 1.2, 'lightPanel', { emissive: 0.9 });
    }
  }
  // 垂れ下がる配管(切れた蒸気管。高さ13m以上)
  k.pipe('hang-pipe', 'y', 253.2, 13.2, 96, 254.8, 22, 97.6, 'pipe');
  k.pipe('hang-pipe', 'y', 273.2, 15.5, 41, 274.8, 22, 42.6, 'pipe');
  k.pipe('hang-elbow', 'x', 273.2, 14.4, 41, 278, 15.5, 42.6, 'pipe');
  // 天井クレーン: 橋桁(x方向 z=70)・車輪台・台車・吊り具・取鍋
  k.box('crane-bridge', 202.6, 15, 68.6, 327.4, 18, 71.4, 'metal');
  k.box('crane-truck', 202, 13.8, 65, 207, 18.4, 75, 'metalDark');
  k.box('crane-truck', 323, 13.8, 65, 328, 18.4, 75, 'metalDark');
  k.box('crane-trolley', 244, 18, 66.6, 256, 20.4, 73.4, 'machine');
  k.box('crane-hanger', 246.2, 8.5, 69.4, 247, 15, 70.6, 'metalDark');
  k.box('crane-hanger', 253, 8.5, 69.4, 253.8, 15, 70.6, 'metalDark');
  k.box('ladle', 247, 6.5, 65.5, 253, 12, 74.5, 'rust');
  k.box('ladle-rim', 246.4, 12, 65, 253.6, 12.8, 75, 'metalDark');
  k.decor('ladle-glow', 247.4, 12.7, 65.6, 252.6, 12.86, 74.4, 'rust', { emissive: 0.9 });
  k.decor('ladle-band', 246.9, 8.4, 65.42, 253.1, 9.4, 74.58, 'metalDark');
  // 走行レール(壁に取り付く桁)
  k.box('runway', 202, 12.6, 40, 204.4, 14.6, 100, 'metal');
  k.box('runway', 325.6, 12.6, 40, 328, 14.6, 100, 'metal');

  // ================================================================== 壁の柱(付け柱)
  for (const x of [222, 248, 264, 300, 316]) k.box('pilaster', x - 1.4, F, 2, x + 1.4, C - 4, 4.8, 'concrete');
  for (const x of [222, 248, 276, 302, 318]) k.box('pilaster', x - 1.4, F, 135.2, x + 1.4, C - 4, 138, 'concrete');
  for (const z of [6, 34, 108, 126]) k.box('pilaster', 202, F, z - 1.4, 204.8, C - 4, z + 1.4, 'concrete');
  for (const z of [30, 50, 118, 132]) k.box('pilaster', 325.2, F, z - 1.4, 328, C - 4, z + 1.4, 'concrete');
  for (const x of [222, 248, 264, 300, 316]) k.decor('pilaster-base', x - 1.45, F, 4.7, x + 1.45, F + 0.9, 4.95, 'hazard');

  // ================================================================== 北の点検路(高所ギャラリー +9.6): 蒸気管を見下ろし、遠距離狙撃にも使える
  k.catwalk('gallery-n', 204.4, 2, 270, 5.4, 9.6, ['s']);
  k.pipe('gallery-steam', 'x', 204.4, 11.4, 2.3, 270, 13.8, 4.7, 'pipe');
  k.box('gallery-hanger', 204.4, 9.6, 2, 205.2, 11.4, 5.4, 'metalDark');
  k.box('gallery-hanger', 269.2, 9.6, 2, 270, 11.4, 5.4, 'metalDark');

  // ================================================================== 西: 加熱炉 (x 202..209.4, z 44..98)
  k.box('furnace-plinth', 202, F, 43, 209.8, 1.2, 99, 'concreteDark');
  k.box('furnace-body', 202, 1.2, 44, 209.4, 8, 61, 'rust');
  k.box('furnace-body', 202, 1.2, 63, 209.4, 8.6, 81, 'rust');
  k.box('furnace-body', 202, 1.2, 83, 209.4, 8, 98, 'rust');
  k.pipe('furnace-link', 'z', 203.5, 5, 61, 207.5, 7.4, 63, 'pipe');
  k.pipe('furnace-link', 'z', 203.5, 5, 81, 207.5, 7.4, 83, 'pipe');
  k.box('furnace-burner', 203, 8, 47, 208, 10.5, 58, 'machine');
  k.box('furnace-burner', 203, 8.6, 66, 208, 11, 78, 'machine');
  k.box('furnace-burner', 203, 8, 86, 208, 10.5, 95, 'machine');
  k.pipe('flue', 'y', 204, 10.5, 51, 207, C - 0.001, 54, 'metalDark');
  k.pipe('flue', 'y', 204, 10.5, 90, 207, C - 0.001, 93, 'metalDark');
  k.pipe('flue-duct', 'z', 204.3, 17, 54, 206.7, 19.4, 90, 'pipe');
  // 装入口: 炉の東面に張り出す扉枠(0.5m) + 赤熱の窓(発光)。各セグメントの中央は強く発光して周囲を照らす
  for (const [z0, z1] of [[46, 51.5], [52.5, 58], [65, 70.5], [71.5, 77], [85, 90], [91, 96]] as [number, number][]) {
    k.box('furnace-door', 209.4, 2.2, z0 - 0.4, 209.9, 6.4, z1 + 0.4, 'metalDark');
    k.decor('furnace-glow', 209.85, 2.8, z0, 209.99, 5.8, z1, 'rust', { emissive: 1 });
    floorPlate('furnace-spill', 210, z0 - 1.5, 214.5, z1 + 1.5, 'rust', 0.4);
  }
  // 各セグメントの上に赤い警告灯(発光ハザード)。ここが橙のポイントライトになる
  for (const z of [55, 74, 88]) k.box('furnace-lamp', 205, 10.5 + (z === 74 ? 0.5 : 0), z - 0.6, 206.2, 11.5 + (z === 74 ? 0.5 : 0), z + 0.6, 'hazard', { emissive: 0.7 });
  for (const [z0, z1, y1] of [[44, 61, 8], [63, 81, 8.6], [83, 98, 8]] as [number, number, number][]) k.decor('furnace-soot', 209.35, 6.6, z0, 209.55, y1, z1, 'metalDark');

  // ================================================================== 南: 圧延スタンド3基とロールテーブル
  const stand = (cx: number, tone: 'rust' | 'metalDark' | 'metal'): void => {
    k.box('stand-plinth', cx - 5, F, 106, cx + 5, 1, 134, 'concreteDark');
    k.box('stand-housing', cx - 3, 1, 108, cx + 3, 12, 112.5, tone);
    k.box('stand-housing', cx - 3, 1, 127.5, cx + 3, 12, 132, tone);
    k.box('stand-yoke', cx - 3.4, 12, 108, cx + 3.4, 13.6, 132, 'metal');
    k.pipe('stand-roll', 'z', cx - 1.5, 3.6, 112.5, cx + 1.5, 6.6, 127.5, 'metal');
    k.pipe('stand-roll', 'z', cx - 1.5, 7.2, 112.5, cx + 1.5, 10.2, 127.5, 'metal');
    k.box('stand-gearbox', cx - 3.5, F, 101, cx + 3.5, 4.6, 106, 'machine');
    k.box('stand-motor', cx - 2.5, F, 132.4, cx + 2.5, 4.2, 137, 'metalDark');
    // 圧下シリンダー(ヨークの上の円筒)と赤い警告灯
    k.pipe('stand-cylinder', 'y', cx - 1.5, 13.6, 109.2, cx + 1.5, 16.6, 112.2, 'metalDark');
    k.pipe('stand-cylinder', 'y', cx - 1.5, 13.6, 127.8, cx + 1.5, 16.6, 130.8, 'metalDark');
    k.box('stand-beacon', cx + 2.2, 13.6, 108.4, cx + 3, 14.6, 109.2, 'gate', { emissive: 0.6 });
    // 圧延機の足元のハザード帯と、ハウジングの油汚れ
    k.decor('stand-mark', cx - 3.5, F, 100.9, cx + 3.5, F + 0.9, 101.1, 'hazard');
    k.decor('stand-band', cx - 3.05, 5.4, 107.9, cx + 3.05, 6.6, 108.05, 'hazard');
    k.decor('stand-band', cx - 3.05, 5.4, 131.95, cx + 3.05, 6.6, 132.1, 'hazard');
  };
  stand(236, 'metalDark');
  stand(266, 'rust');
  stand(296, 'metal');
  k.box('roll-table', 246, F, 116, 256, 1.2, 124, 'metalDark');
  k.box('roll-table', 276, F, 116, 286, 1.2, 124, 'metalDark');
  k.box('roll-table', 212, F, 116, 226, 1.2, 124, 'metalDark');
  // ロールテーブルのローラー(上面の桟)
  for (const [x0, x1] of [[246, 256], [276, 286], [212, 226]] as [number, number][]) {
    for (let x = x0 + 0.8; x < x1 - 0.5; x += 1.6) k.decor('roller', x, 1.14, 116.4, x + 0.5, 1.32, 123.6, 'metal');
  }
  // スタンド上部の点検通路(ヨークの上を渡る)
  k.catwalk('gantry', 232.6, 118, 299.4, 122, 14.6, ['n', 's']);
  k.pillar('gantry-col', 251, 120, 1.6, 1.2, 13.6, 'metalDark');
  k.pillar('gantry-col', 281, 120, 1.6, 1.2, 13.6, 'metalDark');

  // 南西: 崩れた点検階段の残骸(段状: 歩行面ではなく遮蔽)
  k.box('collapsed-catwalk', 212, F, 106, 216, 1.2, 114, 'grating');
  k.box('collapsed-catwalk', 216, F, 106, 220, 2.4, 114, 'grating');
  k.box('collapsed-catwalk', 220, F, 106, 224, 3.6, 114, 'metalDark');
  // 東南: 巻取機とコイル置場
  k.box('coiler', 306, F, 112, 318, 5.8, 124, 'machine');
  k.pipe('coil', 'y', 304, F, 128, 307, 2.4, 131, 'rust');
  k.pipe('coil', 'y', 309, F, 128, 312, 2.4, 131, 'metalDark');
  k.pipe('coil', 'y', 314, F, 128, 317, 2.4, 131, 'rust');
  k.pipe('coil', 'y', 320, F, 118, 323, 2.4, 121, 'metalDark');
  k.pipe('coil', 'y', 320, F, 124, 323, 2.4, 127, 'rust');
  k.crate('coil-crate', 310, 134.4, 8, 3, 2.4, 'crate');

  // ================================================================== 東: 剪断機・アキュムレーター・冷却槽・制御室
  k.box('shear', 292, F, 24, 306, 5.2, 38, 'machine');
  k.pipe('accumulator', 'y', 308.5, F, 25, 311.5, 9, 28, 'metalDark');
  k.pipe('accumulator', 'y', 308.5, F, 32, 311.5, 9, 35, 'metalDark');
  k.box('quench-tank', 300, F, 42, 316, 3, 58, 'metal');
  k.box('quench-water', 301, 3, 43, 315, 3.5, 57, 'glass', { emissive: 0.4 });
  k.box('cabin', 308, F, 3, 326, 3.6, 8, 'metalDark');
  k.box('cabin-glass', 308, 3.6, 3.4, 326, 5.6, 4, 'glass', { emissive: 0.3 });
  k.box('cabin-roof', 308, 5.6, 3, 326, 6.2, 8, 'metal');

  // 東中: 油圧ユニットとコイル置場(隔壁 B1 への進路 (322..328, 93..107) と対角の主経路は空ける)
  k.box('power-pack', 296, F, 80, 310, 2.4, 90, 'machine');
  k.pipe('coil', 'y', 314, F, 82, 317, 2.4, 85, 'rust');
  k.pipe('coil', 'y', 318.4, F, 86, 321.4, 2.4, 89, 'metalDark');
  k.pipe('pump-tank', 'y', 297, F, 92, 300, 7.6, 95, 'metal');
  floorPlate('pack-oil', 294, 78, 312, 92, 'metalDark');

  // ================================================================== 北: スラブヤード・ローラーコンベア・落下した足場(狙撃用の陰)
  k.box('slab-stack', 210, F, 4, 224, 1.2, 10.4, 'rust');
  k.box('slab-stack', 210.6, 1.2, 4.4, 223.4, 2.4, 10, 'rust');
  k.box('slab-stack', 211.2, 2.4, 4.8, 222.8, 3.6, 9.6, 'rust');
  k.box('descaler', 232, F, 4, 244, 9, 23.5, 'machine');
  k.box('conveyor', 248, F, 12, 270, 1.2, 17, 'metalDark');
  for (let x = 249; x < 269; x += 1.6) k.decor('roller', x, 1.14, 12.4, x + 0.5, 1.32, 16.6, 'metal');
  k.box('scaffold', 256, F, 20, 262, 2.4, 27, 'rust');
  k.box('scaffold', 262, F, 20, 268, 3.6, 27, 'metalDark');
  k.box('fallen-girder', 246, F, 27.4, 266, 1.8, 29.2, 'metal');

  // 入口脇の廃材(低い掩蔽。入口の進路 z=13..28 と主経路は空ける)
  k.crate('scrap-crate', 212, 33.5, 6, 4, 2.4, 'crate');
  k.pipe('scrap-drum', 'y', 206, F, 36.5, 208.4, 1.6, 38.9, 'rust');
  k.pipe('scrap-drum', 'y', 206.4, F, 39.4, 208.8, 1.6, 41.8, 'metalDark');
  k.crate('scrap-crate', 216, 8.6 + 8, 5, 4, 1.8, 'crate');

  // ================================================================== 砲台: 制御B1(北東) + 通常(南西)
  k.turret(322, 12, 6, { control: 0, face: [270, 60] });
  k.turret(208, 132, 5, { face: [250, 70] });

  // ================================================================== 警備 3
  k.guard(250, 108, { patrol: [{ x: 250, y: 1.5, z: 108 }, { x: 243.5, y: 1.5, z: 128 }, { x: 258.5, y: 1.5, z: 128 }, { x: 258.5, y: 1.5, z: 108 }] });
  k.guard(276, 24, { patrol: [{ x: 272, y: 1.5, z: 32 }, { x: 238, y: 1.5, z: 32 }, { x: 238, y: 1.5, z: 28 }, { x: 272, y: 1.5, z: 28 }] });
  k.guard(230, 60, { patrol: [{ x: 226, y: 1.5, z: 56 }, { x: 226, y: 1.5, z: 86 }, { x: 246, y: 1.5, z: 86 }, { x: 246, y: 1.5, z: 56 }] });

  // ================================================================== 床・壁の装飾(衝突なし)
  // アリーナの作業床(暗いコンクリ) + ハザードの境界
  floorPlate('arena-floor', 212, 38, 288, 98, 'concreteDark');
  floorPlate('arena-edge', 212, 38, 288, 38.8, 'hazard');
  floorPlate('arena-edge', 212, 97.2, 288, 98, 'hazard');
  floorPlate('arena-edge', 212, 38.8, 212.8, 97.2, 'hazard');
  floorPlate('arena-edge', 287.2, 38.8, 288, 97.2, 'hazard');
  // 汚れ・油・錆
  floorPlate('oil', 232, 64, 246, 76, 'metalDark');
  floorPlate('oil', 262, 50, 274, 58, 'metalDark');
  floorPlate('oil', 216, 90, 222, 96, 'metalDark');
  floorPlate('rust-stain', 214, 106, 228, 114, 'rust');
  floorPlate('rust-stain', 300, 90, 314, 100, 'rust');
  floorPlate('rust-stain', 236, 8, 256, 12, 'rust');
  floorPlate('dirt', 224, 4, 246, 34, 'concreteDark');
  floorPlate('dirt', 292, 40, 300, 64, 'concreteDark');
  floorPlate('dirt', 240, 100, 300, 112, 'concreteDark');
  floorPlate('dirt', 300, 108, 326, 138, 'concreteDark');
  // 入口(P02)の搬入エリア: 金属板と黄色の枠、脇に廃材
  floorPlate('entry-plate', 202, 12, 214, 28, 'metal');
  floorPlate('entry-edge', 202, 27.2, 214.8, 28, 'hazard');
  floorPlate('entry-edge', 202, 12, 214.8, 12.8, 'hazard');
  floorPlate('entry-edge', 214, 12.8, 214.8, 27.2, 'hazard');
  // 隔壁(B1)への誘導帯
  floorPlate('lane-b1', 314, 93.4, 328, 94.2, 'hazard');
  floorPlate('lane-b1', 314, 105.8, 328, 106.6, 'hazard');
  // 隔壁の枠(壁面)
  k.decor('b1-frame', 327.88, 0, 92.2, 328.1, 8.8, 93, 'hazard');
  k.decor('b1-frame', 327.88, 0, 107, 328.1, 8.8, 107.8, 'hazard');
  k.decor('b1-frame', 327.88, 8, 92.2, 328.1, 8.8, 107.8, 'hazard');
  // 北壁: 足元の帯・制御盤・看板
  wallN('base-band', 204, 0, 272, 0.9, 'hazard');
  wallN('base-band', 288, 0, 326, 0.9, 'hazard');
  wallN('panel', 226, 2.4, 246, 5.2, 'metalDark');
  wallN('panel-light', 228, 4.4, 229.6, 4.9, 'machine', 0.4);
  wallN('sign', 288.5, 10, 300, 12.5, 'hazard');
  wallN('sign', 205, 6.5, 214, 9, 'hazard');
  wallN('streak', 230, 10, 232, 25.9, 'rust');
  wallN('streak', 300.5, 12, 303, 25.9, 'rust');
  wallN('streak', 252, 14, 254.5, 25.9, 'rust');
  // 南壁
  wallS('base-band', 204, 0, 326, 0.9, 'hazard');
  wallS('panel', 250, 4, 272, 7, 'metalDark');
  wallS('panel', 284, 4, 300, 7, 'metalDark');
  wallS('streak', 226, 8, 228.5, 25.9, 'rust');
  wallS('streak', 310, 6, 313, 25.9, 'rust');
  wallS('streak', 262, 16, 264, 25.9, 'rust');
  // 西壁(炉の上)と東壁
  k.decor('w-band', 201.9, 0, 6, 202.13, 0.9, 12, 'hazard');
  k.decor('w-sign', 201.9, 15, 30, 202.13, 18, 40, 'hazard');
  k.decor('w-streak', 201.9, 16, 100, 202.13, 25.9, 103, 'rust');
  k.decor('e-band', 327.87, 0, 20, 328.1, 0.9, 90, 'hazard');
  k.decor('e-band', 327.87, 0, 108, 328.1, 0.9, 136, 'hazard');
  k.decor('e-panel', 327.87, 2.4, 60, 328.1, 5.4, 88, 'metalDark');
  k.decor('e-streak', 327.87, 12, 40, 328.1, 25.9, 43, 'rust');
  // 天井際の暖色の帯(発光。ライトの数を増やさないよう 0.5 未満)
  for (const x of [224, 264, 304]) k.decor('ceiling-strip', x - 0.6, 25.86, 6, x + 0.6, 26.1, 134, 'rust', { emissive: 0.4 });
}
