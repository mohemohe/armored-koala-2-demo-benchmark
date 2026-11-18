/**
 * S04 搬送縦坑 (shaft, 地上0 / 天井26, 敵なし): 昇降C1。床(0)から張り出し足場(+12)へ飛行で上がる。足場の縁に手すりは付けない。
 *  - 縦坑の壁に沿う昇降レール(全高の柱)、吊り上げ中のリフト台(北西・+9)と床に降りたケージ(南西)、巻上機室(天井裏)とワイヤー。
 *  - 見上げると、高さの違う梁・配管・照明の列が奥へ重なる。床の離陸位置(352,100)にはハザードの発着枠。
 *  - C1 の離陸柱/飛行コリドー/足場(kit.climbPads)と、主経路(z=94, 床上 +5..+15.5m)は塞がない。
 */
import type { Kit } from '../kit';

export function build(k: Kit): void {
  const F = k.floorY; // 0
  const C = k.ceilingY; // 26
  const PAD = 12; // C1 の着地足場の上面

  // ================================================================== 昇降 C1 (足場と支柱は kit が作る。位置は変えない)
  k.climbPads('C1', [[385, 87], [385, 115]]);

  // ---- decor helpers (衝突なし)
  const floorPlate = (name: string, x0: number, z0: number, x1: number, z1: number, mat: 'hazard' | 'concreteDark' | 'rust' | 'metal', emissive?: number): void => {
    k.decor(name, x0, F - 0.02, z0, x1, F + 0.05, z1, mat, emissive !== undefined ? { emissive } : {});
  };
  const padPlate = (name: string, x0: number, z0: number, x1: number, z1: number, mat: 'hazard' | 'metalDark' | 'rust' | 'metal', emissive?: number): void => {
    k.decor(name, x0, PAD - 0.03, z0, x1, PAD + 0.05, z1, mat, emissive !== undefined ? { emissive } : {});
  };

  // ================================================================== 壁沿いの昇降レール(床〜天井の柱)
  for (const z of [66, 74, 82, 118, 126, 134]) k.box('guide-rail', 332, F, z - 0.6, 333.4, C, z + 0.6, 'metalDark');
  for (const x of [342, 352, 362, 372, 382]) k.box('guide-rail', x - 0.6, F, 62, x + 0.6, C, 63.4, 'metalDark');
  for (const x of [342, 352, 362, 372, 382]) k.box('guide-rail', x - 0.6, F, 136.6, x + 0.6, C, 138, 'metalDark');
  // 東壁は足場(+12)より上だけ(足場の下は柱)
  for (const z of [90, 110]) k.box('guide-rail', 386.6, PAD, z - 0.6, 388, C, z + 0.6, 'metalDark');
  // 壁沿いの配管ラック(北・南壁)
  for (const y of [5, 8.4, 11.8, 15.2]) {
    k.pipe('rack-pipe', 'x', 334, y, 63.4, 388, y + 2, 65.4, 'pipe');
  }
  for (const y of [4, 7.4, 10.8]) {
    k.pipe('rack-pipe', 'x', 334, y, 134.6, 388, y + 2, 136.6, 'pipe');
  }
  k.pipe('riser', 'y', 334, F, 63.4, 336.4, C, 65.8, 'pipe');
  k.pipe('riser', 'y', 384.6, F, 134.4, 387, C, 136.8, 'pipe');

  // ================================================================== リフトA: 吊り上げ中(北西, 台の上面 +9)
  // 四隅のガイド柱 + 台 + 天蓋 + ワイヤー + 天井裏の巻上機
  for (const [x, z] of [[336.6, 66.6], [347.4, 66.6], [336.6, 79.4], [347.4, 79.4]]) k.pillar('lift-guide', x, z, 1.2, F, C, 'metal');
  k.box('lift-car', 336, 8.4, 66, 348, 9, 80, 'grating');
  k.box('lift-car-rim', 336, 9, 66, 348, 9.6, 66.5, 'hazard');
  k.box('lift-car-rim', 336, 9, 79.5, 348, 9.6, 80, 'hazard');
  k.box('lift-canopy', 335.6, 14, 65.6, 348.4, 14.6, 80.4, 'metalDark');
  k.box('lift-cable', 341.3, 14.6, 72.3, 342.1, 22.5, 73.1, 'metalDark');
  k.box('lift-cable', 343.9, 14.6, 72.3, 344.7, 22.5, 73.1, 'metalDark');
  k.box('hoist-house', 334, 22.5, 64, 350, C, 82, 'machine');
  k.pipe('sheave', 'x', 335, 19.6, 70, 349, 22.5, 73, 'metal');
  k.box('lift-lamp', 338, 13.4, 72, 346, 14, 74, 'lightPanel', { emissive: 0.8 });

  // ================================================================== リフトB: 床に降りたケージ(南西)
  for (const [x, z] of [[336.6, 122.6], [347.4, 122.6], [336.6, 135.4], [347.4, 135.4]]) k.pillar('cage-guide', x, z, 1.2, F, C, 'metal');
  k.box('cage-base', 336, F, 122, 348, 0.8, 136, 'metalDark');
  k.box('cage-deck', 336.6, 0.8, 122.6, 347.4, 1.2, 135.4, 'grating');
  k.box('cage-roof', 335.6, 6.2, 121.6, 348.4, 6.8, 136.4, 'metal');
  k.box('cage-bar', 336, 1.2, 122, 348, 2.4, 122.6, 'hazard');
  k.box('cage-bar', 336, 1.2, 135.4, 348, 2.4, 136, 'hazard');
  k.box('cage-cable', 341.3, 6.8, 128.3, 342.1, 22.5, 129.1, 'metalDark');
  k.box('cage-cable', 343.9, 6.8, 128.3, 344.7, 22.5, 129.1, 'metalDark');
  k.box('hoist-house', 334, 22.5, 120, 350, C, 138, 'machine');
  k.box('cage-lamp', 338, 5.6, 128, 346, 6.2, 130, 'lightPanel', { emissive: 0.8 });

  // ================================================================== 西壁の点検踊り場(リフトAが横付けする +9)と梯子
  k.catwalk('landing', 332, 64, 336, 83, 9, ['e']);
  k.catwalk('landing', 332, 64, 336, 83, 17.4, ['e']);
  k.pillar('landing-col', 334.8, 83.6, 1.2, F, 16.4, 'metalDark');
  k.decor('ladder', 331.9, 0, 83.4, 332.12, 9.6, 84.6, 'grating');
  k.decor('ladder', 331.9, 9, 83.4, 332.12, 17.8, 84.6, 'grating');

  // ================================================================== 釣り合い錘(北東): ガイド柱 + 錘 + ワイヤー + 巻上機室
  for (const [x, z] of [[373.6, 68], [382.4, 68], [373.6, 76], [382.4, 76]]) k.pillar('cw-guide', x, z, 1.2, F, C, 'metal');
  k.box('cw-weight', 374.2, 10.6, 68.6, 381.8, 19, 75.4, 'rust');
  k.decor('cw-band', 374.15, 12.4, 68.55, 381.85, 13.6, 68.7, 'hazard');
  k.decor('cw-band', 374.15, 16, 68.55, 381.85, 17.2, 68.7, 'hazard');
  k.box('cw-cable', 377.2, 19, 71.7, 378, 22.5, 72.5, 'metalDark');
  k.box('cw-cable', 379.6, 19, 71.7, 380.4, 22.5, 72.5, 'metalDark');
  k.box('hoist-house', 370, 22.5, 64, 386, C, 80, 'machine');

  // ================================================================== 見上げたときの奥行き: 高さの違う梁の列
  k.box('cross-beam', 332, 24.2, 90, 388, C, 91.8, 'metalDark');
  k.box('cross-beam', 332, 21, 108, 388, 22.8, 109.8, 'metalDark');
  k.box('cross-beam', 356, 17.6, 66, 388, 19.2, 67.6, 'metalDark');
  k.box('cross-beam', 356, 20.2, 128, 388, 21.8, 129.6, 'metalDark');
  k.box('cross-beam', 356, 16.2, 116, 388, 17.8, 117.6, 'metal');
  // 天井を渡る縦のガーダー(z方向)
  k.box('cross-girder', 372, 23.4, 62, 374, C, 138, 'metal');
  k.box('cross-girder', 358, 24.4, 62, 359.6, C, 138, 'metalDark');
  // 太い排気管が天井際を渡る
  k.pipe('vent-duct', 'z', 378, 19.4, 80, 381.4, 22.8, 136, 'pipe');
  // 吊り照明の列(高さ違い)
  for (const [x, y, z] of [[366, 18.6, 74], [366, 15.6, 90], [374, 12.8, 128], [366, 18.6, 122]] as [number, number, number][]) {
    k.box('lamp-stem', x - 0.3, y + 0.6, z - 0.3, x + 0.3, C - 1.6, z + 0.3, 'metalDark');
    k.box('lamp', x - 2.4, y, z - 1, x + 2.4, y + 0.6, z + 1, 'lightPanel', { emissive: 0.9 });
  }
  // 足場の下面の照明(足場の下から見上げる)
  k.box('pad-lamp', 372, 9.4, 88, 378, 10, 90, 'lightPanel', { emissive: 0.8 });
  k.box('pad-lamp', 372, 9.4, 112, 378, 10, 114, 'lightPanel', { emissive: 0.8 });

  // ================================================================== 足場の上(+12): 昇降場の表示と信号灯 (主経路 z=94 の上 +12..15.5 は空ける)
  k.box('landing-cabin', 378, PAD, 108, 386, PAD + 3.2, 116, 'metalDark');
  k.box('landing-glass', 378, PAD + 2.2, 107.4, 386, PAD + 3.2, 108, 'glass', { emissive: 0.3 });
  k.box('beacon', 361, PAD, 85, 362.2, PAD + 1.6, 86.2, 'hazard', { emissive: 0.62 });
  k.box('beacon', 361, PAD, 116, 362.2, PAD + 1.6, 117.2, 'hazard', { emissive: 0.62 });
  k.box('landing-crate', 372, PAD, 84.4, 378, PAD + 2.4, 88, 'crate');

  // ================================================================== ガイド柱を結ぶ横桟(リフトの案内枠)と、配管ラックの弁
  for (const y of [4, 10, 16, 22]) {
    k.box('guide-frame', 337.2, y, 66, 346.8, y + 0.7, 66.7, 'metalDark');
    k.box('guide-frame', 337.2, y, 79.3, 346.8, y + 0.7, 80, 'metalDark');
  }
  for (const y of [3, 9, 15]) {
    k.box('cage-frame', 337.2, y, 122, 346.8, y + 0.7, 122.7, 'metalDark');
    k.box('cage-frame', 337.2, y, 135.3, 346.8, y + 0.7, 136, 'metalDark');
  }
  for (const x of [346, 360, 374]) k.box('rack-valve', x - 0.9, 5.4, 65.4, x + 0.9, 7.6, 67.2, 'hazard');
  for (const x of [352, 366, 380]) k.box('rack-valve', x - 0.9, 4.4, 133.2, x + 0.9, 6.4, 134.6, 'metalDark');

  // ================================================================== 足場の下の補強(斜材の代わりの段状ブラケット)と樽
  for (const z of [88, 100, 112]) k.box('pad-bracket', 356.4, 8.4, z - 0.7, 360, 10, z + 0.7, 'metalDark');
  for (const z of [88, 100, 112]) k.box('pad-bracket', 357.6, 6.6, z - 0.7, 360, 8.4, z + 0.7, 'metalDark');
  for (const [x, z] of [[364, 124], [366.4, 125.4], [364.6, 127.2], [368, 124.4], [370.2, 126]] as [number, number][]) k.pipe('barrel', 'y', x - 0.8, F, z - 0.8, x + 0.8, 1.8, z + 0.8, 'rust');
  k.crate('crate', 336, 108 + 0.5, 4, 3, 1.8, 'crate');
  k.box('cable-drum', 380, F, 100, 384, 1.6, 104, 'metalDark');

  // ================================================================== 破損・残骸
  k.box('rubble', 340, F, 100 + 12, 346, 1.4, 118, 'concreteDark');
  k.box('rubble', 344, F, 108, 348, 2.6, 111.6, 'rust');
  k.crate('crate', 372, 70, 6, 4, 2.4, 'crate');
  k.crate('crate', 380, 132, 6, 4, 2.4, 'crate');
  k.box('fallen-beam', 356, F, 76, 368, 1.6, 78, 'metal');

  // ================================================================== 装飾(衝突なし): 発着枠・ハザード・扉枠
  // 離陸位置(352,100)の発着枠
  floorPlate('pad-mark', 346, 94, 358, 94.8, 'hazard');
  floorPlate('pad-mark', 346, 105.2, 358, 106, 'hazard');
  floorPlate('pad-mark', 346, 94.8, 346.8, 105.2, 'hazard');
  floorPlate('pad-mark', 357.2, 94.8, 358, 105.2, 'hazard');
  floorPlate('pad-fill', 347, 95.4, 357, 104.6, 'concreteDark');
  // ケージ/リフトの足元
  floorPlate('cage-mark', 334.4, 120, 350, 121, 'hazard');
  floorPlate('cage-mark', 334.4, 137, 350, 137.9, 'hazard');
  floorPlate('lift-mark', 334.4, 64.4, 350, 65.4, 'hazard');
  floorPlate('lift-mark', 334.4, 80.6, 350, 81.6, 'hazard');
  floorPlate('rust-stain', 360, 64.4, 384, 70, 'rust');
  floorPlate('rust-stain', 352, 124, 372, 134, 'rust');
  // 足場の縁のハザード帯(手すりは付けない)
  padPlate('pad-edge', 360.2, 84, 388, 84.9, 'hazard');
  padPlate('pad-edge', 360.2, 117.1, 388, 118, 'hazard');
  padPlate('pad-edge', 360, 84.9, 360.9, 117.1, 'hazard');
  padPlate('pad-lane', 362, 92.2, 388, 92.8, 'hazard');
  padPlate('pad-lane', 362, 95.2, 388, 95.8, 'hazard');
  // 西壁(P03)の扉枠と、東壁(P04)の扉枠
  k.decor('p03-frame', 331.88, 0, 92.2, 332.1, 8.8, 93, 'hazard');
  k.decor('p03-frame', 331.88, 0, 107, 332.1, 8.8, 107.8, 'hazard');
  k.decor('p03-frame', 331.88, 8, 92.2, 332.1, 8.8, 107.8, 'hazard');
  k.decor('p04-frame', 387.9, 12, 92.2, 388.12, 20.8, 93, 'hazard');
  k.decor('p04-frame', 387.9, 12, 107, 388.12, 20.8, 107.8, 'hazard');
  k.decor('p04-frame', 387.9, 20, 92.2, 388.12, 20.8, 107.8, 'hazard');
  // 壁面の階数表示と点検札(高さごと)
  for (const [y, tag] of [[4, 'lv0'], [12, 'lv12'], [20, 'lv20']] as [number, string][]) {
    k.decor(`level-${tag}`, 331.88, y, 84, 332.1, y + 1.2, 90, 'hazard');
    k.decor(`level-${tag}`, 331.88, y, 110, 332.1, y + 1.2, 116, 'hazard');
  }
  for (const y of [14, 22]) k.decor('wall-lamp', 331.88, y, 99, 332.1, y + 0.6, 101, 'machine', { emissive: 0.4 });
  k.decor('wall-streak', 331.88, 8, 68, 332.1, 25.9, 70, 'rust');
  k.decor('wall-streak', 387.9, 12, 118, 388.12, 25.9, 121, 'rust');
}
