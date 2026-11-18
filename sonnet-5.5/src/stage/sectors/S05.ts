/**
 * S05 組立ライン (factory, +12, 戦闘): 中層の巨大な組立ホール。暖色の作業灯。
 *  - 南: 組立コンベア2本(A/B) とそれを跨ぐロボットアーム(箱の組合せ)。中段の吊りレール(搬送レール)にシャーシが下がる。
 *  - 西: 部品棚の壁(高さ6.6m)。入口の搬入ロビー(P04)は棚と柱で北の砲台から隠れる。
 *  - 北: プレス機(高い掩蔽)と T05 の台座。北西はロビーから北の保守扉(P18)への通路。
 *  - 東: 出口の扉(P05)へ向かう斜めの通路(mainRoute / BR2-direct)。空けておき、T05 と警備が見張る。
 *  - 中央 ARENA_CLEAR(400..490 x 30..96)は空床。周囲に低1.2 / 中2.5 / 高6 の掩蔽を並べ、多方向から射線が通る。
 * 経路(mainRoute, BR2-direct, BR2-attic の折れ線)と入口/出口/北扉の前面は常に空ける。
 */
import type { Kit } from '../kit';

type Mat = 'metal' | 'metalDark' | 'machine' | 'concreteDark' | 'rust' | 'crate' | 'concrete' | 'hazard' | 'pipe' | 'grating';

export function build(k: Kit): void {
  const F = k.floorY; // 12
  const C = k.ceilingY; // 34
  const y = (h: number): number => F + h;

  // ------------------------------------------------------------------ 小道具
  const blk = (name: string, x0: number, z0: number, x1: number, z1: number, h: number, mat: Mat = 'machine', y0 = F): void => {
    k.box(name, x0, y0, z0, x1, y0 + h, z1, mat);
  };
  /** 投光器の柱(高さ9m): 頭部は暖色の光るパネル */
  const lamp = (cx: number, cz: number, y0 = F): void => {
    k.box('lamp-pole', cx - 0.4, y0, cz - 0.4, cx + 0.4, y0 + 9, cz + 0.4, 'metalDark');
    k.box('lamp-head', cx - 1.8, y0 + 9, cz - 0.8, cx + 1.8, y0 + 9.7, cz + 0.8, 'lightPanel', { emissive: 0.85 });
  };
  /** 部品棚: 下段は詰まった荷(高さ3m)、上段は骨組みと荷。along='z' は南北に長い棚、'x' は東西に長い棚 */
  const rack = (x0: number, z0: number, x1: number, z1: number, along: 'x' | 'z', seed: number): void => {
    const len = along === 'z' ? z1 - z0 : x1 - x0;
    const n = Math.max(1, Math.round(len / 6));
    const step = len / n;
    const baseMats: Mat[] = ['crate', 'rust', 'machine', 'crate'];
    for (let i = 0; i < n; i++) {
      const a = i * step;
      const b = (i + 1) * step;
      const m = baseMats[(i + seed) % baseMats.length];
      const hh = (i + seed) % 3 === 0 ? 2.2 : 3.0;
      if (along === 'z') blk('rack-base', x0, z0 + a, x1, z0 + b, hh, m);
      else blk('rack-base', x0 + a, z0, x0 + b, z1, hh, m);
      // 上段の荷(いくつかの区画だけ)
      if ((i + seed) % 3 !== 1) {
        const hu = 1.4 + ((i * 7 + seed) % 3) * 0.6;
        if (along === 'z') blk('rack-goods', x0 + 0.6, z0 + a + 0.6, x1 - 0.6, z0 + b - 0.6, hu, (i + seed) % 2 ? 'crate' : 'machine', F + 3.5);
        else blk('rack-goods', x0 + a + 0.6, z0 + 0.6, x0 + b - 0.6, z1 - 0.6, hu, (i + seed) % 2 ? 'crate' : 'machine', F + 3.5);
      }
    }
    // 棚板と支柱(骨組み): 荷の上の天板 + 前面の支柱
    if (along === 'z') {
      k.box('rack-shelf', x0, F + 3.0, z0, x1, F + 3.5, z1, 'metalDark');
      k.box('rack-top', x0, F + 6.2, z0, x1, F + 6.7, z1, 'metal');
      for (let i = 0; i <= n; i++) {
        const pz = Math.min(z1 - 0.35, Math.max(z0 + 0.35, z0 + i * step));
        k.box('rack-post', x0, F + 3.5, pz - 0.35, x0 + 0.7, F + 6.2, pz + 0.35, 'metalDark');
        k.box('rack-post', x1 - 0.7, F + 3.5, pz - 0.35, x1, F + 6.2, pz + 0.35, 'metalDark');
      }
    } else {
      k.box('rack-shelf', x0, F + 3.0, z0, x1, F + 3.5, z1, 'metalDark');
      k.box('rack-top', x0, F + 6.2, z0, x1, F + 6.7, z1, 'metal');
      for (let i = 0; i <= n; i++) {
        const px = Math.min(x1 - 0.35, Math.max(x0 + 0.35, x0 + i * step));
        k.box('rack-post', px - 0.35, F + 3.5, z0, px + 0.35, F + 6.2, z0 + 0.7, 'metalDark');
        k.box('rack-post', px - 0.35, F + 3.5, z1 - 0.7, px + 0.35, F + 6.2, z1, 'metalDark');
      }
    }
  };
  /** ロボットアーム: (cx, base側の中心 zc) からコンベア中心 zt へ腕を伸ばす */
  const robot = (cx: number, zc: number, zt: number): void => {
    const dir = zt > zc ? 1 : -1;
    blk('arm-base', cx - 2.5, zc - 2.5, cx + 2.5, zc + 2.5, 1.2, 'machine');
    k.box('arm-column', cx - 1, y(1.2), zc - 1, cx + 1, y(7.4), zc + 1, 'metal');
    k.box('arm-shoulder', cx - 1.7, y(7.4), zc - 1.7, cx + 1.7, y(9.4), zc + 1.7, 'machine', { emissive: 0.5 });
    const za = dir > 0 ? zc : zt - 0.7;
    const zb = dir > 0 ? zt + 0.7 : zc;
    k.box('arm-upper', cx - 0.7, y(7.8), za, cx + 0.7, y(9.0), zb, 'metalDark');
    k.box('arm-fore', cx - 0.6, y(5.0), zt - 0.6, cx + 0.6, y(7.8), zt + 0.6, 'metal');
    k.box('arm-grip', cx - 1.2, y(4.2), zt - 1.2, cx + 1.2, y(5.0), zt + 1.2, 'hazard');
  };

  // T05 = 北の壁際(アリーナと東の出口を見張る。入口ロビーは射程外) / T06 = 南東の隅(組立ライン越しにアリーナ東を見る)
  k.turret(474, 6, 6, { face: [445, 63] });
  k.turret(516, 134, 6, { face: [455, 64] });

  // ------------------------------------------------------------------ 1. 天井: 走行桁・橋形桁・搬送レール
  const GY0 = F + 16;
  const GY1 = F + 17.5;
  k.box('runway', 392, GY0, 3, 394, GY1, 137, 'metalDark');
  k.box('runway', 526, GY0, 3, 528, GY1, 137, 'metalDark');
  for (const gz of [20, 64, 112]) k.box('bridge', 394, GY0, gz - 0.9, 526, GY1, gz + 0.9, 'metal');
  // 吊り具(橋形桁に吊る)
  for (const [hx, hz] of [[445, 64], [480, 20], [420, 112]] as [number, number][]) {
    k.box('hoist', hx - 2.2, y(12.4), hz - 1.6, hx + 2.2, GY0, hz + 1.6, 'machine');
    k.box('hoist-chain', hx - 0.35, y(10), hz - 0.35, hx + 0.35, y(12.4), hz + 0.35, 'metalDark');
    k.box('hoist-hook', hx - 0.9, y(9), hz - 0.9, hx + 0.9, y(10), hz + 0.9, 'hazard');
  }
  // 搬送レール(組立ラインの真上, 天井から吊る) と そこに下がるシャーシ
  k.box('rail', 402, y(13), 118.5, 526, y(14.5), 121.5, 'metalDark');
  for (const hx of [410, 440, 470, 500, 522]) k.box('rail-hanger', hx - 0.5, y(14.5), 119.5, hx + 0.5, C, 120.5, 'metalDark');
  for (const cx of [424, 446, 480, 512]) {
    k.box('carrier-hook', cx - 0.4, y(11.6), 119.6, cx + 0.4, y(13), 120.4, 'metalDark');
    k.box('carrier', cx - 2.4, y(9), 118.4, cx + 2.4, y(11.6), 121.6, 'machine', { emissive: 0.0 });
  }
  // 天井の梁(壁から壁へ)
  for (const bz of [36, 84]) k.box('roof-beam', 394, y(19), bz - 1, 526, y(20.6), bz + 1, 'metalDark');

  // ------------------------------------------------------------------ 2. 南: 組立コンベア A/B とロボット
  blk('belt-a', 404, 117, 452, 123, 1.2, 'machine');
  blk('belt-b', 464, 117, 506, 123, 1.2, 'machine');
  for (const cx of [414, 428, 442]) blk('chassis', cx - 2.2, 118.4, cx + 2.2, 121.6, 1.6, 'metal', y(1.2));
  for (const cx of [472, 486, 498]) blk('chassis', cx - 2.2, 118.4, cx + 2.2, 121.6, 1.6, 'rust', y(1.2));
  robot(416, 110.5, 120);
  robot(436, 129.5, 120);
  robot(476, 110.5, 120);
  // 4基目は倒れて壊れている(部品が床とコンベアに散らばる)
  blk('arm-base', 493.5, 127, 498.5, 132, 1.2, 'machine');
  k.box('arm-fallen', 487.3, F, 128.5, 493.5, y(2), 130.5, 'metal');
  k.box('arm-fallen', 483.6, F, 127.8, 487.3, y(2.4), 131.2, 'machine');
  k.box('arm-fallen', 480.6, F, 123, 482.4, y(1.4), 129, 'metalDark');
  k.box('arm-fallen', 490, y(1.2), 118.8, 493, y(2), 121.2, 'hazard');
  // 制御盤・電源
  blk('control-cab', 456, 126, 462, 132, 3.4, 'machine');
  blk('control-cab', 458, 108, 462, 112, 2.5, 'metalDark');
  // 南壁の部品棚(T06 の西)
  rack(404, 133.6, 476, 138, 'x', 1);
  // 荷とパレット(出口側)
  k.crate('crate', 520, 106, 9, 6, 2.6);
  k.crate('crate', 512, 116, 6, 6, 2.6);
  k.crate('crate', 520, 118, 6, 5, 5.2, 'crate', F + 0);

  // ------------------------------------------------------------------ 3. 西: 部品棚の壁(入口ロビーの北)
  rack(392, 34, 398, 58, 'z', 0);
  rack(392, 64, 398, 88, 'z', 2);
  // 北西の管制室(壁面のガラス窓つき)
  blk('cabin', 392, 8, 401, 22, 3.6, 'metal');
  k.box('cabin-glass', 401, y(1.4), 9, 401.6, y(3.4), 21, 'glass');
  k.box('cabin-roof', 392, y(3.6), 8, 402, y(4.4), 22, 'metalDark');

  // ------------------------------------------------------------------ 4. 北: プレス機・ローラーと T05
  const press = (x0: number, z0: number, x1: number, z1: number, h: number): void => {
    blk('press', x0, z0, x1, z1, h, 'machine');
    blk('press-head', x0 + 1, z0 + 1, x1 - 1, z1 - 1, 1.4, 'metalDark', y(h));
    blk('press-piston', x0 + (x1 - x0) / 2 - 1, z0 + (z1 - z0) / 2 - 1, x0 + (x1 - x0) / 2 + 1, z0 + (z1 - z0) / 2 + 1, 2.2, 'metal', y(h + 1.4));
  };
  press(432, 14, 444, 26, 6);
  press(482, 16, 494, 27, 5.4);
  blk('roller', 448, 24, 468, 28, 1.2, 'concreteDark');
  blk('crate', 418, 24, 428, 29, 2.5, 'crate');
  rack(484, 2, 520, 8.4, 'x', 3);

  // ------------------------------------------------------------------ 5. アリーナ周囲の掩蔽(低1.2 / 中2.5 / 高6)
  // 東
  blk('cover-e', 491, 28, 497, 40, 2.6, 'crate');
  blk('cover-e', 494, 76, 506, 84, 6, 'machine');
  blk('cover-e', 491, 88, 497, 95, 1.2, 'concreteDark');
  // 南(アリーナの縁)
  blk('cover-s', 408, 99, 418, 105, 1.2, 'crate');
  blk('cover-s', 444, 100, 456, 106, 2.5, 'rust');
  blk('cover-s', 470, 98, 482, 106, 1.2, 'concreteDark');
  blk('generator', 424, 98, 436, 105, 6, 'machine');
  blk('generator-top', 426, 99, 434, 104, 0.8, 'metalDark', y(6));
  // 北西の縁
  blk('cover-nw', 420, 20, 426, 27, 2.5, 'crate');
  blk('cover-n', 470, 24, 480, 29, 2.5, 'rust');
  blk('cover-s', 486, 99, 496, 106, 2.5, 'crate');
  k.box('duct', 400, y(18), 58, 520, y(20.4), 61, 'metal');

  // ------------------------------------------------------------------ 5b. 配管網(壁沿い, 扉より上) と 壁の付け柱
  k.pipe('wall-pipe', 'z', 392, y(9.6), 3, 394.4, y(12), 137, 'pipe');
  k.pipe('wall-pipe', 'z', 525.6, y(11.4), 3, 528, y(13.8), 137, 'pipe');
  k.pipe('wall-pipe', 'x', 395, y(12.6), 2, 525, y(15), 4.4, 'pipe');
  k.pipe('wall-pipe', 'x', 395, y(8.4), 135.6, 525, y(10.8), 138, 'pipe');
  for (const [px, pz] of [[394.3, 3.2], [525.7, 3.2], [394.3, 136.8], [525.7, 136.8]] as [number, number][]) {
    k.pipe('riser', 'y', px - 1.1, F, pz - 1.1, px + 1.1, y(15), pz + 1.1, 'pipe');
  }
  for (const pz of [36, 66, 96, 126]) k.box('pilaster', 525.5, F, pz - 1.5, 528, C, pz + 1.5, 'concreteDark');
  for (const px of [440, 500]) k.box('pilaster', px - 1.5, F, 2, px + 1.5, C, 4.5, 'concreteDark');
  for (const px of [420, 452, 484, 508]) k.box('pilaster', px - 1.5, F, 135.5, px + 1.5, C, 138, 'concreteDark');
  // 梱包エリアのフォークリフト(箱の組合せ)
  const forklift = (cx: number, cz: number, mat: 'hazard' | 'machine' = 'hazard'): void => {
    k.box('fork-body', cx - 1.1, F, cz - 1.8, cx + 1.1, y(1.6), cz + 1.8, mat);
    k.box('fork-cab', cx - 1, y(1.6), cz + 0.2, cx + 1, y(3.6), cz + 1.7, 'metalDark');
    k.box('fork-mast', cx - 0.9, F, cz - 2.5, cx - 0.3, y(4.4), cz - 1.8, 'metal');
    k.box('fork-mast', cx + 0.3, F, cz - 2.5, cx + 0.9, y(4.4), cz - 1.8, 'metal');
    k.box('fork-blade', cx - 0.9, F, cz - 4.2, cx - 0.4, y(0.5), cz - 2.5, 'metal');
    k.box('fork-blade', cx + 0.4, F, cz - 4.2, cx + 0.9, y(0.5), cz - 2.5, 'metal');
  };
  forklift(498, 112);
  forklift(408, 128, 'machine');
  // 崩れた桁の残骸(東南, 経路の外)
  k.box('fallen-girder', 492, F, 104, 506, y(1.6), 106, 'metal');
  k.box('fallen-girder', 498, y(1.6), 103.4, 508, y(3.2), 106.6, 'rust');
  k.box('fallen-girder', 504, F, 100, 508, y(2.4), 108, 'rust');
  // T05 の横の保守キャットウォーク(+6)。飛行で上がると T05 の台座に近づける
  k.platform('catwalk', 478, 10, 500, 15, y(6), 1, 'grating');
  k.box('catwalk-rail', 478, y(6), 14.5, 500, y(7.2), 15, 'metal');
  k.box('catwalk-rail', 499.5, y(6), 10, 500, y(7.2), 15, 'metal');
  for (const cx of [479, 498]) k.box('catwalk-leg', cx, F, 12, cx + 1.2, y(5), 13.2, 'metalDark');
  // 天井の照明(暖色) — 梁の下面に貼る
  for (const [lx, lz] of [[430, 36], [470, 36], [510, 36], [430, 84], [470, 84], [510, 84]] as [number, number][]) {
    k.box('ceil-lamp', lx - 3, y(18.5), lz - 1, lx + 3, y(19), lz + 1, 'lightPanel', { emissive: 0.9 });
  }

  // ------------------------------------------------------------------ 6. 敵(警備4 + 砲台2は上で作成)
  k.guard(438, 112, { face: [430, 70], patrol: [{ x: 438, y: F + 1.5, z: 112 }, { x: 466, y: F + 1.5, z: 108 }] });
  k.guard(480, 62, { face: [430, 70], patrol: [{ x: 480, y: F + 1.5, z: 62 }, { x: 478, y: F + 1.5, z: 86 }, { x: 486, y: F + 1.5, z: 72 }] });
  k.guard(512, 44, { face: [470, 70], patrol: [{ x: 512, y: F + 1.5, z: 44 }, { x: 506, y: F + 1.5, z: 62 }] });
  k.guard(462, 17, { face: [440, 70], patrol: [{ x: 462, y: F + 1.5, z: 17 }, { x: 452, y: F + 1.5, z: 19 }] });

  // ------------------------------------------------------------------ 7. 投光器(暖色)
  for (const [lx, lz] of [[422, 28], [470, 27], [500, 28], [395, 110], [440, 104], [470, 112], [504, 100], [410, 114], [452, 128]] as [number, number][]) lamp(lx, lz);

  // ------------------------------------------------------------------ 8. 装飾(衝突なし)
  // 床の標示: アリーナの縁と組立ラインの縁
  const stripe = (x0: number, z0: number, x1: number, z1: number, mat: 'hazard' | 'concreteDark' | 'rust' = 'hazard'): void => {
    k.decor('floor-mark', x0, F, z0, x1, F + 0.05, z1, mat);
  };
  stripe(400, 29.4, 490, 30, 'hazard');
  stripe(400, 96, 490, 96.6, 'hazard');
  stripe(399.4, 30, 400, 96, 'hazard');
  stripe(490, 30, 490.6, 96, 'hazard');
  stripe(404, 115.6, 452, 116.4, 'hazard');
  stripe(464, 115.6, 506, 116.4, 'hazard');
  stripe(404, 123.6, 452, 124.4, 'hazard');
  stripe(464, 123.6, 506, 124.4, 'hazard');
  // 壁の設備パネル・配管・警告灯
  for (let x = 400; x < 520; x += 24) {
    k.decor('s-panel', x, F + 8, 137.88, x + 12, F + 14, 138, 'machine', x % 48 === 16 ? { emissive: 0.5 } : {});
    k.decor('n-panel', x, F + 8, 2, x + 12, F + 14, 2.12, 'metalDark');
  }
  k.decor('e-tray', 527.86, F + 10, 30, 528, F + 10.6, 136, 'pipe');
  k.decor('w-tray', 392, F + 10, 30, 392.14, F + 10.6, 136, 'pipe');
  for (const [lx, lz] of [[452, 137.88], [500, 137.88]] as [number, number][]) {
    k.decor('warn', lx - 1, F + 16, lz, lx + 1, F + 17, lz + 0.12, 'hazard', { emissive: 0.6 });
  }
  // 床の汚れ(油だまり・錆): 衝突なしの薄いパッチ
  const stain = (x0: number, z0: number, x1: number, z1: number, mat: 'concreteDark' | 'rust' | 'grating', t = 0.03): void => {
    k.decor('stain', x0, F, z0, x1, F + t, z1, mat);
  };
  stain(410, 60, 424, 72, 'concreteDark');
  stain(456, 40, 470, 50, 'concreteDark', 0.081);
  stain(436, 82, 452, 92, 'concreteDark', 0.083);
  stain(480, 68, 490, 80, 'rust');
  stain(404, 124, 424, 134, 'rust');
  stain(496, 124, 518, 130, 'rust', 0.085);
  stain(400, 126, 456, 132, 'grating', 0.09);
  stain(464, 126, 506, 132, 'grating', 0.09);
  stain(452, 100, 464, 138, 'concreteDark', 0.087);
  // 壁面の汚れ・錆の筋・設備
  for (const [x0, w] of [[410, 6], [452, 4], [498, 8]] as [number, number][]) k.decor('rust-streak', x0, F + 2, 137.88, x0 + w, F + 14, 138, 'rust');
  for (const [z0, w] of [[40, 8], [70, 6], [110, 10]] as [number, number][]) k.decor('rust-streak', 527.88, F + 2, z0, 528, F + 12, z0 + w, 'rust');
  // 警告灯(橙)
  for (const [bx, bz, by] of [[438, 20, y(6 + 1.4 + 2.2)], [488, 21.5, y(5.4 + 1.4 + 2.2)], [430, 101.5, y(6.8)]] as [number, number, number][]) {
    k.box('beacon', bx - 0.5, by, bz - 0.5, bx + 0.5, by + 1, bz + 0.5, 'hazard', { emissive: 0.8 });
  }
  // 床の汚れ(擬似乱数で散らす)。厚みを変えて面が重ならないようにする
  let seed = 51;
  const rnd = (): number => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  for (let i = 0; i < 26; i++) {
    const w = 3 + rnd() * 11;
    const d = 3 + rnd() * 9;
    const x0 = 396 + rnd() * (128 - w);
    const z0 = 4 + rnd() * (132 - d);
    let t = 0.02 + i * 0.0016;
    if (t > 0.045 && t < 0.055) t += 0.012; // 0.05 は床の標示帯と同じ面になる
    stain(x0, z0, x0 + w, z0 + d, i % 3 === 0 ? 'rust' : 'concreteDark', t);
  }
  // 壁の下部(腰壁)の暗い帯
  for (const [x0, x1] of [[419, 484], [523, 526]] as [number, number][]) k.decor('dado', x0, F, 2, x1, F + 2.4, 2.12, 'metalDark');
  k.decor('dado', 396, F, 137.88, 524, F + 2.4, 138, 'metalDark');
  k.decor('dado', 527.88, F, 30, 528, F + 2.4, 136, 'metalDark');
  void GY1;
}
