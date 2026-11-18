/**
 * S14 外周搬送路 (corridor, 戦闘, 制御砲台 T15=B6): x350..500 z340..490, 床0 / 天井30。
 * 屋外ヤード風の広い外周貨物線。中央の搬送フロア(ARENA_CLEAR 360..450 x 346..420)を、南のコンテナ貨車列・コンテナ山・ガントリークレーン、
 * 北東の高い基礎に据えた制御砲台T15、高架コンベア橋が囲む。昇降C7で南東の搬出橋(+12)へ上がり、東の隔壁B6(P14)を抜ける。
 * 砲台は北東(470,350)の基礎(+3)の上の台座(+8)から搬出橋の隔壁を見通す。光は寒色(青白・青緑)、砲台まわりだけ赤い警告灯。
 * 遠距離の狙撃位置は、貨車列の陰(南西)。
 */
import type { Kit } from '../kit';

export function build(k: Kit): void {
  let seed = 4141;
  const rnd = (): number => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  k.climbPads('C7', [[496, 442], [496, 486], [460, 486]]);

  // ---- コンテナ貨車: x0 から東へ len(13.5m)、z 中心。台車・連結ずみのフラットカーに20ftコンテナ(stack段)
  const wagon = (x0: number, z: number, stack = 1, len = 13.5): void => {
    k.box('wagon-bogie', x0 + 1.2, 0, z - 1.2, x0 + 3.4, 0.7, z + 1.2, 'machine');
    k.box('wagon-bogie', x0 + len - 3.4, 0, z - 1.2, x0 + len - 1.2, 0.7, z + 1.2, 'machine');
    k.box('wagon-frame', x0, 0.7, z - 1.45, x0 + len, 1.3, z + 1.45, 'metalDark');
    for (let s = 0; s < stack; s++) k.box('wagon-cont', x0 + 0.6, 1.3 + s * 2.6, z - 1.3, x0 + len - 0.6, 3.9 + s * 2.6, z + 1.3, 'crate');
  };
  // ---- ガントリークレーン: x 中心、z0..z1 に跨ぐ門型(脚2m角)
  const gantry = (x: number, z0: number, z1: number): void => {
    k.box('gantry-leg', x - 1.2, 0, z0, x + 1.2, 10, z0 + 2.4, 'metalDark');
    k.box('gantry-leg', x - 1.2, 0, z1 - 2.4, x + 1.2, 10, z1, 'metalDark');
    k.box('gantry-girder', x - 1.2, 10, z0, x + 1.2, 12, z1, 'metal');
    k.box('gantry-foot', x - 2, 0, z0 - 0.4, x + 2, 0.8, z0 + 2.8, 'hazard');
    k.box('gantry-foot', x - 2, 0, z1 - 2.8, x + 2, 0.8, z1 + 0.4, 'hazard');
    for (const zz of [z0 + 6, z1 - 8]) k.box('gantry-lamp', x - 1.2, 12, zz, x + 1.2, 12.8, zz + 2, 'machine', { emissive: 0.8 });
  };
  const jersey = (x0: number, z0: number, x1: number, z1: number): void => {
    k.box('barrier', x0, 0, z0, x1, 0.7, z1, 'concreteDark');
    k.box('barrier', x0 + 0.4, 0.7, z0 + 0.3, x1 - 0.4, 1.4, z1 - 0.3, 'concreteDark');
  };

  // 入口(P13)の前の遮蔽壁: 扉から出た直後に砲台(118m)から狙い撃たれない
  k.fbox('entry-cover', 358, 346, 360, 356, 4, 'concreteDark');
  k.decor('entry-cover-band', 357.86, 0, 346, 358, 1.2, 356, 'hazard');

  // =============================================================== 制御砲台T15: 北東の基礎(+3) の上の台座(+8)
  k.fbox('plinth', 463, 343, 477, 357, 3, 'concreteDark');
  k.turret(470, 350, 5, { baseY: 3, control: 5, face: [499, 474] });
  for (const [x, z] of [[463.6, 343.6], [476.4, 343.6], [463.6, 356.4], [476.4, 356.4]]) k.decor('beacon', x - 0.5, 3, z - 0.5, x + 0.5, 3.15, z + 0.5, 'gate', { emissive: 0.8 });
  // 砲台の手前の防護(低い遮蔽)
  jersey(452, 362, 462, 364.5);
  jersey(458, 372, 468, 374.5);
  jersey(468, 386, 478, 388.5);
  k.fbox('sandbag', 484, 366, 490, 372, 1.6, 'crate');

  // 変電ヤード(砲台への接近路の掩蔽。砲台→隔壁の射線の下 y<10 に収める)
  k.fbox('trans', 454, 388, 462, 396, 4.5, 'machine');
  k.fbox('trans-top', 456, 390, 460, 394, 1.6, 'metalDark', 4.5);
  k.fbox('trans', 466, 390, 474, 398, 3.2, 'machine');
  k.fbox('trans', 454, 402, 464, 412, 6, 'metalDark');
  k.fbox('trans-rim', 453.5, 401.5, 464.5, 412.5, 0.5, 'hazard', 6);
  k.decor('trans-lamp', 453.86, 3, 404, 454, 3.8, 410, 'machine', { emissive: 0.8 });
  k.decor('trans-lamp', 461.99, 2.6, 388, 462.13, 3.4, 396, 'machine', { emissive: 0.8 });
  jersey(466, 420, 476, 422.5);

  // =============================================================== 南: コンテナ貨車列(トラックA z=428) — 陰に入れる中遮蔽(3.9m)/高遮蔽(6.5m)
  wagon(356, 428, 1);
  wagon(371.5, 428, 2);
  wagon(387, 428, 1);
  wagon(410, 428, 1);
  wagon(425.5, 428, 2);
  k.fbox('stop', 352, 426.6, 355, 429.4, 1.6, 'hazard'); // 車止め
  // コンテナヤード(トラックB): 山積みのコンテナ
  k.fbox('yard-cont', 358, 441, 370, 443.6, 2.6, 'crate');
  k.fbox('yard-cont', 358, 441, 370, 443.6, 2.6, 'crate', 2.6);
  k.fbox('yard-cont', 376, 441, 388, 443.6, 2.6, 'crate');
  k.fbox('yard-cont', 394, 441, 406, 443.6, 2.6, 'crate');
  k.fbox('yard-cont', 394, 441, 406, 443.6, 2.6, 'crate', 2.6);
  k.fbox('yard-cont', 394, 444, 406, 446.6, 2.6, 'crate');
  k.fbox('yard-cont', 426, 441, 438, 443.6, 2.6, 'crate');
  // 南のガントリークレーン2基とコンテナ置場
  gantry(376, 460, 484);
  gantry(416, 460, 484);
  k.fbox('yard-cont', 352, 466, 364, 468.6, 2.6, 'crate');
  k.fbox('yard-cont', 352, 466, 364, 468.6, 2.6, 'crate', 2.6);
  k.fbox('yard-cont', 352, 466, 364, 468.6, 2.6, 'crate', 5.2);
  k.fbox('yard-cont', 352, 468.6, 364, 471.2, 2.6, 'crate');
  k.fbox('yard-cont', 352, 468.6, 364, 471.2, 2.6, 'crate', 2.6);
  k.fbox('yard-cont', 352, 471.2, 364, 473.8, 2.6, 'crate');
  wagon(388, 476, 1);
  wagon(430, 476, 1);

  // =============================================================== 高架コンベア橋 (z=380, +16): 壁から壁へ。支柱塔はアリーナの外(x456..460)
  k.box('belt', 352, 16, 378.8, 498, 17.4, 381.2, 'machine');
  k.box('belt-truss', 352, 17.4, 378.3, 498, 18.4, 378.8, 'metalDark');
  k.box('belt-truss', 352, 17.4, 381.2, 498, 18.4, 381.7, 'metalDark');
  k.box('belt-tower', 456, 0, 377.5, 460, 16, 382.5, 'metalDark');
  k.box('belt-tower-cap', 455, 16, 377, 461, 16.8, 383, 'hazard');
  // 高架の照明
  for (const x of [372, 404, 436, 476]) k.box('belt-lamp', x - 2.5, 15.2, 379.4, x + 2.5, 16, 380.6, 'glass', { emissive: 0.85 });

  // =============================================================== 東: タンク群(砲台の背景)。砲台→隔壁の射線(x<483)の外側
  k.fbox('tank', 484, 346, 496, 358, 22, 'rust');
  k.fbox('tank-rim', 483, 345, 497, 359, 1, 'hazard', 22);
  k.fbox('tank', 484, 366, 496, 384, 14, 'metal');
  k.fbox('tank-rim', 483, 365, 497, 385, 1, 'hazard', 14);
  k.fbox('tank', 484, 392, 496, 404, 18, 'metalDark');
  k.fbox('tank-rim', 483, 391, 497, 405, 1, 'hazard', 18);
  k.decor('tank-ladder', 483.86, 0, 350, 484, 22, 351.2, 'metal');
  k.decor('tank-band', 483.86, 6, 347, 484, 8, 357, 'hazard');
  k.decor('tank-band', 483.86, 6, 393, 484, 8, 403, 'hazard');
  // 砲台の監視マストと投光器
  k.pillar('mast', 458, 346, 2, 0, 20, 'metalDark');
  k.box('mast-lamp', 456.6, 20, 344.6, 459.4, 21, 347.4, 'gate', { emissive: 0.9 });
  // 高架の照明

  // =============================================================== 搬出橋(C7 の着地足場 y=12): 端に警告帯、足場の遮蔽は経路の外側
  k.fbox('crate', 460, 478, 466, 484, 1.2, 'crate', 12);
  k.fbox('crate', 488, 442, 494, 448, 2.4, 'crate', 12);
  k.fbox('booth', 486, 482, 497, 487.5, 3.5, 'machine', 12);
  k.fbox('booth-roof', 485.5, 481.5, 497.5, 488, 0.6, 'hazard', 15.5);
  k.decor('booth-lamp', 485.86, 13.6, 483, 486, 14.6, 486.5, 'gate', { emissive: 0.8 });
  k.decor('pad-edge', 458.5, 12, 440.5, 497.5, 12.06, 442, 'hazard');
  k.decor('pad-edge', 458.5, 12, 486.5, 497.5, 12.06, 488, 'hazard');
  k.decor('pad-edge', 458.5, 12, 442, 460, 12.06, 486.5, 'hazard');

  // =============================================================== 床・壁の標示(衝突なし)
  const H = 0.05;
  k.decor('lane', 360, 0, 346, 450, H, 346.8, 'hazard');
  k.decor('lane', 360, 0, 419.2, 450, H, 420, 'hazard');
  k.decor('lane', 360, 0, 346.8, 360.8, H, 419.2, 'hazard');
  k.decor('lane', 449.2, 0, 346.8, 450, H, 419.2, 'hazard');
  k.decor('ballast', 352, 0, 424.2, 452, 0.03, 431.8, 'concreteDark');
  k.decor('rail', 352, 0.03, 426.8, 452, 0.13, 427.2, 'metal');
  k.decor('rail', 352, 0.03, 428.8, 452, 0.13, 429.2, 'metal');
  k.decor('ballast', 352, 0, 472.2, 452, 0.03, 479.8, 'concreteDark');
  for (let i = 0; i < 7; i++) {
    const w = 5 + rnd() * 9;
    const d = 3 + rnd() * 7;
    const x = 364 + rnd() * (84 - w);
    const z = 349 + rnd() * (68 - d);
    k.decor('stain', x, 0, z, x + w, 0.04 + i * 0.002, z + d, i % 2 ? 'rust' : 'concreteDark');
  }
  for (const x of [380, 420]) k.box('pilaster', x - 1.2, 0, 342, x + 1.2, 30, 343.4, 'metal');
  for (const x of [396, 440]) k.box('pilaster', x - 1.2, 0, 486.6, x + 1.2, 30, 488, 'metal');
  k.decor('ballast', 352, 0, 385, 450, 0.03, 391.4, 'concreteDark');
  k.decor('rail', 352, 0.03, 386.6, 450, 0.13, 387.0, 'metal');
  k.decor('rail', 352, 0.03, 389.4, 450, 0.13, 389.8, 'metal');
  k.decor('ring', 461, 0, 341.9, 479, 0.05, 343, 'hazard');
  k.decor('ring', 461, 0, 357, 479, 0.05, 358.2, 'hazard');
  k.decor('ring', 461, 0, 343, 462.2, 0.05, 357, 'hazard');
  k.decor('ring', 477.8, 0, 343, 479, 0.05, 357, 'hazard');
  // 南壁・東壁の設備(衝突なし)
  k.decor('lining', 352, 0, 487.86, 498, 6, 488, 'metalDark');
  k.decor('wall-pipe', 352, 12, 487.86, 498, 13.6, 488, 'pipe');
  k.decor('wall-pipe', 352, 16.5, 487.86, 498, 18, 488, 'pipe');
  for (const x of [372, 420, 468]) k.decor('wall-lamp', x - 2, 9, 487.86, x + 2, 9.7, 488, 'glass', { emissive: 0.85 });
  k.decor('wall-band', 352, 0, 487.86, 498, 1.2, 488, 'hazard');
  k.decor('lining', 497.86, 0, 342, 498, 6, 440, 'metalDark');
  k.decor('wall-pipe', 497.86, 14, 342, 498, 15.6, 440, 'pipe');
  k.decor('wall-band', 497.86, 0, 342, 498, 1.2, 440, 'hazard');
  // 北壁の配管ラック(壁ぎわ)と照明
  k.pipe('rack-pipe', 'x', 352, 20, 342, 498, 22.4, 344.4, 'pipe');
  k.pipe('rack-pipe', 'x', 352, 24, 342, 498, 26.4, 344.4, 'pipe');
  for (const x of [372, 420, 468]) k.decor('wall-lamp', x - 2, 10, 342, x + 2, 10.7, 342.14, 'glass', { emissive: 0.85 });
  k.decor('wall-band', 352, 0, 342, 498, 1.2, 342.14, 'hazard');
  for (const z of [372, 410, 450]) k.decor('wall-lamp', 352, 10, z - 2, 352.14, 10.7, z + 2, 'glass', { emissive: 0.85 });
}
