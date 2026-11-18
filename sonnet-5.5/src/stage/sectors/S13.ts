/**
 * S13 出荷倉庫 (warehouse, 戦闘, 制御砲台 T14=B5): x220..350 z340..490, 床0 / 天井40。
 * 西の+24ギャラリー(P12/P23の入口)から降りる巨大倉庫。北半分の仕分けフロア(ARENA_CLEAR 256..340 x 350..412)を、
 * 南の高層ラック・コンテナ・フォークリフト・北の仕分け機・東の積込ドックが囲み、天井走行クレーンが吊り荷を下げる。
 * 制御B5の砲台は東南の台座から東の隔壁(P13)を監視。ギャラリー東縁の見張り台(遮蔽つき)から遠距離で砲台を狙える。
 * 光は暖色(ナトリウム灯・非常灯)、砲台まわりだけ赤い警告灯。
 */
import type { Kit } from '../kit';

export function build(k: Kit): void {
  // 決定的な疑似乱数 (Math.random は使わない)
  let seed = 1313;
  const rnd = (): number => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const G = 24; // ギャラリーの上面

  // ---- 棚: 南北に長い高層ラック。x0..x1 が厚み、z0..z1 が長さ。フレームで区切ったベイに、段(3m)ごとに荷が入る
  const rack = (x0: number, z0: number, x1: number, z1: number, h: number, bay = 8): void => {
    const n = Math.max(1, Math.round((z1 - z0) / bay));
    const step = (z1 - z0) / n;
    for (let i = 0; i <= n; i++) {
      const z = z0 + i * step;
      const a = Math.max(z0, z - 0.3);
      k.box('rack-frame', x0, 0, a, x1, h + 0.5, Math.min(z1, a + 0.6), 'metal');
    }
    const tiers = Math.floor(h / 3);
    for (let t = 0; t < tiers; t++) {
      const y = t * 3;
      k.box('rack-beam', x0 + 0.5, y, z0 + 0.6, x1 - 0.5, y + 0.5, z1 - 0.6, 'rust');
      for (let i = 0; i < n; i++) {
        if (rnd() < 0.2) continue; // 空きベイ
        const a = z0 + i * step + 0.6;
        const b = z0 + (i + 1) * step - 0.3;
        const gh = 1.4 + rnd() * 1.1;
        k.box('rack-goods', x0 + 0.7, y + 0.5, a + 0.2, x1 - 0.7, y + 0.5 + gh, b - 0.2, 'crate');
      }
    }
  };
  // ---- フォークリフト: (cx, cz) 中心, dz=+1 で南向き(フォークが+z), -1 で北向き
  const forklift = (cx: number, cz: number, dz: 1 | -1, y0 = 0): void => {
    const zz = (a: number, b: number): [number, number] => (dz === 1 ? [cz + a, cz + b] : [cz - b, cz - a]);
    let [a, b] = zz(-1.6, 1.0);
    k.box('fl-body', cx - 1.1, y0 + 0.5, a, cx + 1.1, y0 + 1.5, b, 'machine');
    [a, b] = zz(-2.2, -1.6);
    k.box('fl-weight', cx - 1.1, y0 + 0.5, a, cx + 1.1, y0 + 1.9, b, 'hazard');
    [a, b] = zz(-1.5, 0.9);
    k.box('fl-wheel', cx - 1.3, y0, a, cx - 0.9, y0 + 0.9, b, 'metalDark');
    k.box('fl-wheel', cx + 0.9, y0, a, cx + 1.3, y0 + 0.9, b, 'metalDark');
    [a, b] = zz(-1.0, -0.5);
    k.box('fl-post', cx - 1.0, y0 + 1.5, a, cx - 0.5, y0 + 2.7, b, 'hazard');
    k.box('fl-post', cx + 0.5, y0 + 1.5, a, cx + 1.0, y0 + 2.7, b, 'hazard');
    [a, b] = zz(-1.2, 0.5);
    k.box('fl-roof', cx - 1.1, y0 + 2.7, a, cx + 1.1, y0 + 3.2, b, 'hazard');
    [a, b] = zz(1.0, 1.6);
    k.box('fl-mast', cx - 0.6, y0, a, cx + 0.6, y0 + 3.6, b, 'metalDark');
    [a, b] = zz(1.6, 3.4);
    k.box('fl-fork', cx - 0.9, y0, a, cx - 0.4, y0 + 0.5, b, 'metal');
    k.box('fl-fork', cx + 0.4, y0, a, cx + 0.9, y0 + 0.5, b, 'metal');
  };
  // ---- 床上のパレット積み(低い遮蔽1.2 / 中2.4)
  const pallets = (x0: number, z0: number, x1: number, z1: number, h: number): void => {
    k.box('pallet', x0, 0, z0, x1, 0.5, z1, 'rust');
    k.box('pallet-goods', x0 + 0.1, 0.5, z0 + 0.1, x1 - 0.1, h, z1 - 0.1, 'crate');
  };
  // ---- 積込ドックのトレーラー(N-S向き)
  const trailer = (x: number, z0: number, z1: number, cab = false): void => {
    k.box('tr-chassis', x - 1.3, 0.9, z0, x + 1.3, 1.7, z1, 'metalDark');
    k.box('tr-wheel', x - 1.7, 0, z1 - 4.5, x - 1.3, 1.1, z1 - 1.2, 'metalDark');
    k.box('tr-wheel', x + 1.3, 0, z1 - 4.5, x + 1.7, 1.1, z1 - 1.2, 'metalDark');
    k.box('tr-box', x - 1.3, 1.7, z0 + (cab ? 0 : 0.3), x + 1.3, 4.3, z1, 'crate');
    if (cab) k.box('tr-cab', x - 1.3, 0.9, z0 - 4.6, x + 1.3, 3.4, z0 - 0.2, 'machine');
  };

  // =============================================================== 西のギャラリー (+24): P12 / P23 の入口
  k.platform('gallery', 222, 345, 244, 486, G, 2, 'grating');
  k.platform('gallery-e', 244, 345, 252, 424, G, 2, 'grating');
  k.platform('gallery-e', 244, 436, 252, 486, G, 2, 'grating');
  for (const z of [352, 376, 400, 448, 472, 484]) k.pillar('gallery-col', 250, z, 2.4, 0, G - 2, 'metalDark');
  // 崩落した縁の下に落ちた床材(通路の外・アリーナの外)
  k.fbox('debris', 246, 424, 255, 436, 2.5, 'rust');
  k.fbox('debris', 247, 426, 253, 434, 4, 'metalDark');
  k.fbox('debris', 244, 428, 248, 433, 5.6, 'grating');
  // 見張り台(ギャラリー東縁): T14へ射線が通り、壁の陰から半身を出して狙う
  k.fbox('snipe-wall', 249, 374, 251.5, 386, 2.7, 'concreteDark', G);
  // 入口の遮蔽と足場
  k.fbox('gal-crate', 243, 362, 248, 367, 2.4, 'crate', G);
  k.fbox('gal-crate', 243, 367, 246, 370, 1.2, 'crate', G);
  k.fbox('gal-crate', 236, 410, 241, 416, 1.2, 'crate', G);
  k.fbox('gal-crate', 243, 399, 247, 404, 2.4, 'crate', G);
  k.fbox('gal-crate', 241, 440, 245, 446, 2.4, 'crate', G);
  // 荷役制御室(南端): 基礎と窓
  k.fbox('booth', 236, 452, 248, 462, 3, 'machine', G);
  k.fbox('booth-win', 236, 452, 248, 462, 2.2, 'glass', G + 3);
  k.fbox('booth-roof', 235.5, 452, 248.5, 462, 0.6, 'metal', G + 5.2);
  // 入口(P12/P23)の枠と、扉から伸びる誘導帯
  for (const [a, b] of [[347, 361], [463, 477]] as [number, number][]) {
    k.decor('door-jamb', 222, 24, a - 1.5, 222.14, 32, a, 'hazard');
    k.decor('door-jamb', 222, 24, b, 222.14, 32, b + 1.5, 'hazard');
    k.decor('door-head', 222, 32, a - 1.5, 222.14, 33.6, b + 1.5, 'hazard');
  }
  k.decor('door-lane', 222, G, 353.6, 244, G + 0.06, 354.8, 'hazard');
  k.decor('door-lane', 222, G, 468.6, 244, G + 0.06, 469.8, 'hazard');
  for (let i = 0; i < 5; i++) k.decor('gal-stain', 224 + (i * 7) % 20, G, 372 + i * 20, 230 + (i * 7) % 20, G + 0.02 + i * 0.002, 380 + i * 20, i % 2 ? 'rust' : 'concreteDark');
  // ギャラリーの縁の標示(床面の帯)と街灯
  for (const [z0, z1] of [[345, 424], [436, 486]] as [number, number][]) k.decor('edge-stripe', 250, G, z0 + 0.5, 252, G + 0.06, z1 - 0.5, 'hazard');
  k.decor('edge-stripe', 244, G, 422.8, 252, G + 0.06, 424, 'hazard');
  k.decor('edge-stripe', 244, G, 436, 252, G + 0.06, 437.2, 'hazard');
  for (const z of [366, 456, 480]) {
    k.box('lamp-post', 250.4, G, z - 0.3, 251, G + 3.2, z + 0.3, 'metalDark');
    k.box('lamp-head', 249.6, G + 3.2, z - 1, 251.4, G + 3.8, z + 1, 'lightPanel', { emissive: 0.9 });
  }

  // =============================================================== ギャラリーの下: 仕分けコンベア線と充電場
  for (const [z0, z1] of [[358, 400], [408, 452]] as [number, number][]) {
    k.fbox('conv', 226, z0, 229, z1, 1.1, 'machine');
    k.fbox('conv-top', 226.3, z0 + 0.3, 228.7, z1 - 0.3, 1.5, 'metalDark', 1.1);
  }
  k.fbox('conv', 240, 358, 243, 452, 1.1, 'machine');
  k.fbox('chute', 233, 380, 238, 386, 3, 'machine');
  k.fbox('chute', 233, 424, 238, 430, 2.4, 'machine');
  forklift(233, 474, -1);
  forklift(242, 478, -1);
  k.fbox('charger', 225, 470, 229, 480, 2.2, 'machine');
  for (const z of [376, 400, 472]) k.decor('col-lamp', 248.66, 5, z - 0.8, 248.8, 5.8, z + 0.8, 'lightPanel', { emissive: 0.7 });

  // =============================================================== 北の壁ぎわ: 仕分け機・出荷事務所・梱包
  k.fbox('sorter', 258, 343, 276, 349.5, 3, 'machine');
  k.fbox('sorter-top', 262, 344, 270, 348.5, 5, 'metalDark', 3);
  k.fbox('sorter-stack', 263, 344.5, 267, 347.5, 9, 'pipe', 8);
  k.decor('sorter-screen', 258, 1.4, 349.4, 268, 2.4, 349.5, 'machine', { emissive: 0.6 });
  k.fbox('office', 292, 343, 312, 349.5, 3, 'concreteDark');
  k.fbox('office-2', 294, 344, 310, 348.5, 6, 'metal', 3);
  k.fbox('pack', 318, 343, 330, 349.5, 2.6, 'crate');
  k.fbox('pack', 318, 343, 324, 349.5, 5.2, 'crate', 2.6);
  // 柱型の補強(北壁)
  for (const x of [236, 280, 316]) k.box('pilaster', x - 1.2, 0, 342, x + 1.2, 40, 343.4, 'concreteDark');
  for (const x of [250, 290, 330]) k.decor('zone-sign', x - 4, 14, 342, x + 4, 16.4, 342.14, 'lightPanel', { emissive: 0.55 });
  k.decor('wall-band', 222, 0, 342, 348, 1.2, 342.14, 'hazard');
  k.decor('wall-pipe', 222, 9.5, 342, 348, 11.1, 342.14, 'pipe');
  k.decor('wall-pipe', 222, 19, 342, 348, 20.4, 342.14, 'pipe');

  // =============================================================== 東の壁ぎわ: 積込ドック(トレーラー) — B5への射線は空ける(高さ4.3m以下)
  trailer(345, 367, 381, true);
  trailer(345, 386, 400);
  pallets(343, 403, 347, 409, 2.4);
  for (const z of [368, 392, 430]) {
    k.decor('dock-door', 347.86, 0, z - 4, 348, 6.5, z + 4, 'metalDark');
    k.decor('dock-lamp', 347.86, 8, z - 1.2, 348, 8.6, z + 1.2, 'lightPanel', { emissive: 0.6 });
  }

  // =============================================================== アリーナ縁の遮蔽(低1.2 / 中2.4)と照明塔
  pallets(252.5, 360.5, 255.5, 364, 1.2);
  pallets(252.5, 384, 255.5, 388.5, 2.4);
  pallets(252.5, 402, 255.5, 405.5, 1.2);
  pallets(270, 414, 275, 418, 1.2);
  pallets(284, 414, 288, 418, 2.4);
  pallets(304, 414, 309, 418, 1.2);
  pallets(322, 412, 326, 416, 2.4);
  forklift(290, 436, 1);
  for (const [x, z] of [[254.5, 376], [254.5, 395]] as [number, number][]) {
    k.box('light-tower', x - 0.5, 0, z - 0.5, x + 0.5, 8, z + 0.5, 'metalDark');
    k.box('light-tower-head', x - 1.4, 8, z - 0.5, x + 0.6, 8.6, z + 0.5, 'lightPanel', { emissive: 0.9 });
  }

  // =============================================================== 南の高層ラック (北セクション z424..448 / 南セクション z456..484)
  const heights = [15, 15, 9, 6];
  [[258, 264], [270, 276], [294, 300], [306, 312]].forEach(([x0, x1], i) => {
    rack(x0, 424, x1, 448, heights[i], 8);
    rack(x0, 456, x1, 484, heights[i], 9.34);
    k.decor('rack-lamp', x0 + 1, heights[i] > 6 ? 5.2 : 4.6, 423.86, x1 - 1, heights[i] > 6 ? 5.8 : 5.2, 424, 'lightPanel', { emissive: 0.7 });
  });
  k.fbox('cont', 318, 440, 332, 443, 2.6, 'crate');
  k.fbox('cont', 318, 440, 332, 443, 2.6, 'crate', 2.6);
  k.fbox('cont', 318, 460, 332, 463, 2.6, 'crate');
  forklift(324, 474, -1);
  // 倒れたラック(南東の残骸): 段状に壁へ寄りかかる
  k.fbox('fallen', 336, 470, 346, 486, 1.6, 'rust');
  k.fbox('fallen', 338, 474, 346, 486, 3.2, 'metalDark');
  k.fbox('fallen', 341, 478, 346, 486, 4.8, 'crate');

  // =============================================================== 天井: トラス・ダクト・天井走行クレーンと吊り荷
  for (const x of [262, 300, 338]) k.box('truss', x - 1, 37.4, 342, x + 1, 40, 488, 'metalDark');
  k.pipe('duct', 'x', 222, 35.2, 344.8, 348, 37.6, 347.2, 'pipe');
  k.pipe('duct', 'x', 222, 35, 476, 348, 37.4, 478.4, 'pipe');
  k.box('runway', 222, 33, 371, 348, 34.6, 372.6, 'metalDark');
  k.box('runway', 222, 33, 451, 348, 34.6, 452.6, 'metalDark');
  k.box('bridge', 300.2, 34.6, 371, 303.8, 36.2, 452.6, 'metal');
  k.box('trolley', 299.5, 32.4, 392, 304.5, 34.6, 397, 'machine');
  for (const [cx, cz] of [[298.4, 393.2], [301.6, 393.2], [298.4, 395.8], [301.6, 395.8]]) k.box('chain', cx - 0.25, 9, cz - 0.25, cx + 0.25, 32.4, cz + 0.25, 'pipe');
  k.box('hung-cont', 296, 6.4, 392.6, 306, 9, 396.4, 'crate');

  // 走行クレーンレールの下の作業灯(列) と 屋根まで届く太い柱
  for (const x of [236, 262, 288, 314, 336]) {
    k.box('runway-lamp', x - 3, 32.2, 371, x + 3, 33, 372.6, 'lightPanel', { emissive: 0.75 });
    k.box('runway-lamp', x - 3, 32.2, 451, x + 3, 33, 452.6, 'lightPanel', { emissive: 0.75 });
  }
  for (const [x, z] of [[284, 343.5], [335, 343.5]] as [number, number][]) {
    k.pillar('roof-col', x, z, 3, 0, 40, 'concreteDark');
    k.box('roof-col-base', x - 2, 0, z - 2, x + 2, 1.4, z + 2, 'hazard');
  }
  // ギャラリー西側の荷役コンテナ(通路は中央に残す)
  k.fbox('gal-cont', 222, 372, 228, 384, 2.4, 'crate', G);
  k.fbox('gal-cont', 222, 388, 228, 400, 2.4, 'crate', G);
  k.fbox('gal-cont', 222, 388, 228, 400, 2.4, 'crate', G + 2.4);
  k.fbox('gal-cont', 222, 404, 228, 416, 2.4, 'crate', G);

  // =============================================================== 床の標示・汚れ(衝突なし)
  const H = 0.05;
  k.decor('lane', 256, 0, 350, 340, H, 350.8, 'hazard');
  k.decor('lane', 256, 0, 411.2, 340, H, 412, 'hazard');
  k.decor('lane', 256, 0, 350.8, 256.8, H, 411.2, 'hazard');
  k.decor('lane', 339.2, 0, 350.8, 340, H, 411.2, 'hazard');
  for (let i = 0; i < 9; i++) {
    const w = 4 + rnd() * 8;
    const d = 3 + rnd() * 6;
    const x = 260 + rnd() * (76 - w);
    const z = 353 + rnd() * (56 - d);
    k.decor('stain', x, 0, z, x + w, 0.03 + i * 0.002, z + d, i % 3 === 0 ? 'rust' : 'concreteDark');
  }
  k.decor('track', 262, 0, 372, 336, 0.04, 373.2, 'concreteDark');
  k.decor('track', 262, 0, 385, 336, 0.041, 386.2, 'concreteDark');

  // =============================================================== 制御砲台B5 (東南寄りの台座から東の隔壁を監視)
  k.turret(338, 420, 6, { control: 4, face: [346, 352] });
  k.decor('warn', 335.35, 4.6, 419, 335.5, 5.4, 421, 'gate', { emissive: 0.8 });
  k.decor('warn', 340.5, 4.6, 419, 340.65, 5.4, 421, 'gate', { emissive: 0.8 });

  // =============================================================== 警備3: ギャラリー東縁の巡回1 + 床の警備2
  k.guard(250.2, 406, { floorTop: G, face: [290, 380], patrol: [{ x: 250.2, y: G + 1.5, z: 419 }, { x: 250.2, y: G + 1.5, z: 396 }] });
  k.guard(267, 418, { face: [298, 380], patrol: [{ x: 300, y: 1.5, z: 419 }, { x: 267, y: 1.5, z: 419 }] });
  k.guard(303, 440, { face: [298, 380], patrol: [{ x: 303, y: 1.5, z: 470 }, { x: 303, y: 1.5, z: 432 }] });
}
