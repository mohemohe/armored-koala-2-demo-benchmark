/**
 * S06 検査棟 (multilevel, +12): 出荷前の検査ホール。昇降C2 で検査ギャラリー(+24)へ。
 * 制御砲台B2(T07)は北東の高い台座(+8m)から、南のギャラリー上の隔壁(P06)へ射線を通す。
 *  - 北: ガラス張りの検査室(QCラボ)。西の扉から見た T07 の射線を切る。
 *  - 中央: 3連のスキャナーゲート(N-Sのベルト)。入口→takeoff の主導線を跨ぐ。
 *  - 西: 試験装置の列(上面+6)。南西に「監視ブース」= 狙撃位置(隔壁から約65〜100m, T07 への射線と掩蔽)。
 *  - 東: 反応の高い排出ケージ群。T07 の周りは遠くまで見渡せる。
 *  - 南東: 昇降C2のギャラリー(+24)と、その下の暗い検疫ベイ。ギャラリー上に高い検査ポッド(掩蔽)。
 * 経路(mainRoute の対角の飛行路, BR2 の2本)と C2 の離陸柱/コリドーは常に空ける。
 */
import type { Kit } from '../kit';

export function build(k: Kit): void {
  const F = k.floorY; // 12
  const C = k.ceilingY; // 40
  k.climbPads('C2', [[634, 104], [634, 134], [595, 134]]);

  // ------------------------------------------------------------------ 小道具
  /** 中心(cx,cz)・幅s・高さh の角柱 */
  const post = (name: string, cx: number, cz: number, sx: number, sz: number, h: number, mat: 'metal' | 'metalDark' | 'machine' | 'concreteDark' | 'rust' = 'metalDark', y0 = F): void => {
    k.box(name, cx - sx / 2, y0, cz - sz / 2, cx + sx / 2, y0 + h, cz + sz / 2, mat);
  };
  /** 投光器の柱(高さ9m): 上端に光るパネル。cool=青白(glass) / それ以外=暖色(lightPanel) */
  const lamp = (cx: number, cz: number, cool: boolean, y0 = F): void => {
    k.box('lamp-pole', cx - 0.4, y0, cz - 0.4, cx + 0.4, y0 + 9, cz + 0.4, 'metalDark');
    if (cool) k.box('lamp-head', cx - 1.6, y0 + 9, cz - 0.8, cx + 1.6, y0 + 9.7, cz + 0.8, 'glass', { emissive: 0.9 });
    else k.box('lamp-head', cx - 1.6, y0 + 9, cz - 0.8, cx + 1.6, y0 + 9.7, cz + 0.8, 'lightPanel', { emissive: 0.8 });
  };

  // ------------------------------------------------------------------ 1. 天井: クレーンの走行桁と橋形桁 (y 32..33.6)
  const GY0 = F + 20;
  const GY1 = F + 21.6;
  k.box('runway', 532, GY0, 4, 534, GY1, 136, 'metalDark');
  k.box('runway', 636, GY0, 4, 638, GY1, 136, 'metalDark');
  for (const gz of [30, 80, 124]) {
    k.box('bridge', 534, GY0, gz - 0.9, 636, GY1, gz + 0.9, 'metal');
  }
  // 吊り具(桁に吊る)
  for (const [hx, hz] of [[560, 80], [606, 30], [626, 124]] as [number, number][]) {
    k.box('hoist', hx - 2.2, F + 17.2, hz - 1.6, hx + 2.2, GY0, hz + 1.6, 'machine');
    k.box('hoist-chain', hx - 0.35, F + 13.4, hz - 0.35, hx + 0.35, F + 17.2, hz + 0.35, 'metalDark');
    k.box('hoist-hook', hx - 0.9, F + 12.4, hz - 0.9, hx + 0.9, F + 13.4, hz + 0.9, 'hazard');
  }

  // ------------------------------------------------------------------ 2. 北: QCラボ(ガラスの検査室) x548..588, z6..25
  {
    const lx0 = 548;
    const lx1 = 588;
    const lz0 = 6;
    const lz1 = 25;
    const H = 6;
    const xs = [548.5, 558.5, 568.5, 578.5, 587.5];
    for (const px of xs) {
      post('lab-post', px, lz0 + 0.5, 1, 1, H + 0.4, 'metalDark');
      post('lab-post', px, lz1 - 0.5, 1, 1, H + 0.4, 'metalDark');
    }
    post('lab-post', 548.5, 15.5, 1, 1, H + 0.4, 'metalDark');
    post('lab-post', 587.5, 15.5, 1, 1, H + 0.4, 'metalDark');
    // ガラス(衝突あり): 北・西・東は連続、南は中央に扉の開口(x568..578)
    for (let i = 0; i < xs.length - 1; i++) {
      // 北面の2枚目は割れて下半分しか残っていない
      k.box('lab-glass-n', xs[i] + 0.5, F, lz0, xs[i + 1] - 0.5, i === 1 ? F + 1.8 : F + H, lz0 + 0.6, 'glass');
      if (i !== 2) k.box('lab-glass-s', xs[i] + 0.5, F, lz1 - 0.6, xs[i + 1] - 0.5, F + H, lz1, 'glass');
    }
    k.box('lab-glass-w', lx0, F, lz0 + 1, lx0 + 0.6, F + H, 15, 'glass');
    k.box('lab-glass-w', lx0, F, 16, lx0 + 0.6, F + H, lz1 - 1, 'glass');
    k.box('lab-glass-e', lx1 - 0.6, F, lz0 + 1, lx1, F + H, 15, 'glass');
    k.box('lab-glass-e', lx1 - 0.6, F, 16, lx1, F + H, lz1 - 1, 'glass');
    k.box('lab-roof', lx0, F + H + 0.4, lz0, lx1, F + H + 1.4, lz1, 'metal');
    k.box('lab-lintel', 568.5 - 0.5, F + H - 1.6, lz1 - 1, 578.5 + 0.5, F + H + 0.4, lz1, 'hazard');
    // 室内: 検査台と機器(暗い青緑の光)
    k.fbox('lab-bench', 551, 8, 584, 10.5, 1.1, 'machine', F, { emissive: 0.55 });
    k.fbox('lab-bench', 551, 20.5, 566, 23, 1.1, 'machine');
    k.fbox('lab-bench', 581, 20.5, 585, 23, 1.1, 'machine');
    k.fbox('lab-rack', 551, 12.5, 554, 18.5, 3.2, 'metalDark');
    k.fbox('lab-rack', 582, 12.5, 585, 18.5, 3.2, 'metalDark');
    k.fbox('lab-scanner', 562, 13, 574, 16.5, 2.2, 'machine', F, { emissive: 0.6 });
    k.box('lab-lamp', 562, F + H - 0.3, 12, 574, F + H + 0.4, 14, 'glass', { emissive: 0.9 });
  }

  // ------------------------------------------------------------------ 3. 中央: スキャナーゲート x3 + N-Sの検査ベルト
  {
    k.fbox('belt', 577, 54, 583, 78, 1.1, 'machine');
    k.fbox('belt-motor', 576, 78, 584, 84, 2.4, 'metalDark');
    for (const gz of [57, 65, 73]) {
      post('gate-post', 569.5, gz, 3, 3, 9.6, 'metalDark');
      post('gate-post', 591.5, gz, 3, 3, 9.6, 'metalDark');
      k.box('gate-beam', 568, F + 9.6, gz - 1.5, 593, F + 12.2, gz + 1.5, 'metal');
      k.box('gate-scan', 578, F + 9.0, gz - 0.6, 582, F + 9.6, gz + 0.6, 'machine', { emissive: 0.8 });
    }
    // 検査済みの荷: ベルト脇の低いパレット
    k.crate('pallet', 573, 60, 3, 3, 1.2);
    k.crate('pallet', 588, 68, 3, 4, 1.2);
    k.crate('pallet', 586, 78, 3, 3, 2.5);
  }

  // 検査ライン(東西の低い搬送台, 高さ1.4m): 扉→ハブ の2本の分岐路はこの上を飛び越える(BR2 の折れ線の前提)
  k.fbox('inspect-belt', 540, 30, 610, 34, 1.4, 'machine');
  k.decor('inspect-stripe', 540, F + 1.4, 30.3, 610, F + 1.45, 30.9, 'hazard');
  k.decor('inspect-stripe', 540, F + 1.4, 33.1, 610, F + 1.45, 33.7, 'hazard');

  // ------------------------------------------------------------------ 4. 西: 試験装置の列 (x532..546)
  const rigs: [number, number, number][] = [[50, 62, 6], [66, 78, 2.5], [84, 102, 6], [108, 122, 6], [126, 136, 2.5]];
  for (const [z0, z1, h] of rigs) {
    k.fbox('rig', 532, z0, 546, z1, h, h > 3 ? 'machine' : 'crate');
    if (h > 3) k.fbox('rig-cap', 534, z0 + 1, 544, z1 - 1, 0.8, 'metalDark', F + h);
  }

  // ------------------------------------------------------------------ 5. 南西: 監視ブース(狙撃位置) x546..568, z80..106
  {
    k.fbox('booth-wall', 546, 81, 556, 84, 6, 'concreteDark');
    k.fbox('booth-wall', 546, 102, 568, 105, 6, 'concreteDark');
    k.fbox('booth-parapet', 560, 89, 562.5, 97, 2.5, 'metal');
    k.crate('booth-crate', 551, 92, 4, 3, 1.2);
    k.fbox('booth-desk', 549, 96, 553, 101.5, 1.1, 'machine', F, { emissive: 0.55 });
    k.box('booth-lamp', 550, F + 5.4, 84, 560, F + 6, 86, 'glass', { emissive: 0.9 });
  }

  // ------------------------------------------------------------------ 6. 東: T07 の周り
  // 北の目隠し(扉P19から T07 への射線を切る)
  k.fbox('north-screen', 612, 14, 638, 19, 7, 'concreteDark');
  k.fbox('north-screen-top', 614, 15, 636, 18, 0.8, 'hazard', F + 7);
  // 排出ケージ(高い掩蔽)と荷
  k.fbox('reject-cage', 606, 40, 618, 48, 6, 'machine');
  k.fbox('reject-cage-top', 608, 41, 616, 47, 0.8, 'metalDark', F + 6);
  k.fbox('reject-cage', 606, 62, 618, 74, 6, 'machine');
  k.crate('crate', 630, 47, 8, 6, 2.5);
  k.crate('crate', 632, 82, 8, 5, 2.5);
  k.fbox('reject-belt', 594, 90, 636, 94, 1.1, 'machine');
  // ハブ(576,50)の脇の遮蔽
  k.crate('crate', 590, 46, 6, 5, 2.5);
  k.crate('crate', 561, 56, 5, 5, 2.5);
  k.crate('crate', 598, 78, 5, 4, 1.2);

  // ------------------------------------------------------------------ 7. 昇降ギャラリー(+24)の上: 高い検査ポッド(掩蔽) と 手前の低い台
  {
    const G = 24;
    k.box('pod', 600, G, 108, 606, G + 6, 114, 'machine');
    k.box('pod-cap', 601, G + 6, 109, 605, G + 6.8, 113, 'metalDark');
    k.box('pod', 607, G, 120, 613, G + 6, 126, 'machine');
    k.box('pod-cap', 608, G + 6, 121, 612, G + 6.8, 125, 'metalDark');
    k.box('console', 634, G, 108, 637.5, G + 1.2, 128, 'metal');
    k.box('console', 600, G, 101, 616, G + 1.2, 103.5, 'machine');
    k.box('console', 592, G, 130, 598, G + 1.2, 137.5, 'metal');
    // 検疫ベイ(ギャラリーの下): 荷と隔離ケージ
    k.crate('crate', 604, 122, 12, 6, 2.6);
    k.crate('crate', 600, 108, 5, 5, 2.6);
    k.box('cage', 616, F, 108, 624, F + 2.5, 116, 'metalDark');
    k.box('cage', 604, F, 130, 616, F + 6, 137.5, 'machine');
  }

  // ------------------------------------------------------------------ 7b. 追加の設備
  // ゲートの制御盤(高さ2.5m以下: 昇降C2の踏み台の連鎖を作らない)とビーコン
  for (const gz of [57, 65, 73]) {
    k.fbox('gate-cab', 566, gz - 1, 568, gz + 1, 2.5, 'machine');
    k.fbox('gate-cab', 593, gz - 1, 595, gz + 1, 2.5, 'machine');
    k.box('gate-beacon', 570, F + 9.6, gz - 0.5, 571, F + 10.6, gz + 0.5, 'hazard', { emissive: 0.8 });
    k.box('gate-beacon', 590, F + 9.6, gz - 0.5, 591, F + 10.6, gz + 0.5, 'hazard', { emissive: 0.8 });
  }
  // 試験装置の導管(床から天井まで)
  for (const zz of [50.5, 66.5, 108.5, 126.5]) k.pipe('conduit', 'y', 546, F, zz, 547.4, C - 0.5, zz + 1.4, 'pipe');
  k.pipe('conduit', 'y', 546, F, 121, 547.4, C - 0.5, 122.4, 'pipe');
  // 東壁の検体ロッカー(T07 の南)
  k.fbox('locker', 634, 36, 638, 44, 3, 'metal');
  k.fbox('locker', 634, 50, 638, 58, 6, 'machine');
  k.fbox('locker-top', 635, 51, 637, 57, 0.8, 'metalDark', F + 6);
  k.fbox('locker', 634, 66, 638, 76, 3, 'crate');
  k.fbox('locker', 634, 82, 638, 90, 2.5, 'metal');
  // 検疫ベイのコンテナ
  k.crate('crate', 626, 123, 12, 5, 2.6);
  k.crate('crate', 626, 123, 10, 4, 2.6, 'rust', F + 2.6);
  // モニター塔
  k.fbox('monitor-tower', 606, 22.5, 609, 25.5, 6, 'machine', F, { emissive: 0.6 });
  k.fbox('monitor-tower', 620, 66, 623, 69, 3, 'machine', F, { emissive: 0.6 });
  // 壁の付け柱
  for (const pz of [33, 45]) k.box('pilaster', 532, F, pz - 1.5, 534.5, C, pz + 1.5, 'concreteDark');
  for (const px of [545, 580, 606]) k.box('pilaster', px - 1.5, F, 135.5, px + 1.5, C, 138, 'concreteDark');
  for (const px of [544, 600]) k.box('pilaster', px - 1.5, F, 2, px + 1.5, C, 4.5, 'concreteDark');
  // 天井の照明(冷たい白青)を橋形桁の下面に
  for (const [lx, lz] of [[570, 30], [618, 30], [545, 80], [590, 80], [620, 80], [560, 124], [596, 124]] as [number, number][]) {
    k.box('ceil-lamp', lx - 3, GY0 - 0.5, lz - 0.8, lx + 3, GY0, lz + 0.8, 'glass', { emissive: 0.85 });
  }
  // 橙のビーコン(試験装置の上)
  for (const [bx, bz] of [[539, 56], [539, 114], [539, 93]] as [number, number][]) {
    k.box('beacon', bx - 0.5, F + 6.8, bz - 0.5, bx + 0.5, F + 7.8, bz + 0.5, 'hazard', { emissive: 0.8 });
  }

  // ------------------------------------------------------------------ 8. 投光器(冷たい青白)
  for (const [lx, lz] of [[558, 46], [598, 52], [566, 96], [610, 56], [560, 128], [626, 100]] as [number, number][]) lamp(lx, lz, true);
  lamp(612, 112, true);

  // ------------------------------------------------------------------ 9. T07(制御砲台) と警備
  k.turret(632, 30, 8, { control: 1, face: [610, 100] });
  k.guard(556, 108, { face: [576, 60], patrol: [{ x: 556, y: F + 1.5, z: 108 }, { x: 570, y: F + 1.5, z: 90 }, { x: 572, y: F + 1.5, z: 112 }] });
  k.guard(600, 44, { face: [580, 60] });

  // ------------------------------------------------------------------ 10. 装飾(衝突なし)
  // 壁面の設備(西壁は試験装置の上、東壁は全面)
  for (let z = 32; z < 130; z += 14) {
    k.decor('w-panel', 532, F + 8, z, 532.12, F + 14, z + 8, 'machine', z % 28 === 4 ? { emissive: 0.6 } : {});
    k.decor('e-panel', 637.88, F + 8, z, 638, F + 14, z + 8, 'metalDark');
  }
  k.decor('w-tray', 532, F + 17, 30, 532.14, F + 17.6, 136, 'pipe');
  k.decor('e-tray', 637.86, F + 17, 30, 638, F + 17.6, 136, 'pipe');
  // 試験装置の画面(東面)
  for (const [z0, z1, h] of rigs) {
    if (h > 3) k.decor('rig-screen', 546, F + 2.2, z0 + 1.5, 546.12, F + 4.6, z1 - 1.5, 'machine', { emissive: 0.6 });
  }
  // 床の標示帯(ゲートレーンの縁)
  k.decor('lane', 575.6, F, 54, 576.4, F + 0.05, 78, 'hazard');
  k.decor('lane', 583.6, F, 54, 584.4, F + 0.05, 78, 'hazard');
  // ゲートの警告灯(柱の内側の面)
  for (const gz of [57, 65, 73]) {
    k.decor('gate-light', 571, F + 6, gz - 0.6, 571.12, F + 7.2, gz + 0.6, 'hazard', { emissive: 0.6 });
    k.decor('gate-light', 589.88, F + 6, gz - 0.6, 590, F + 7.2, gz + 0.6, 'hazard', { emissive: 0.6 });
  }
  // 台座の警告帯(制御砲台T07)
  k.decor('t07-band', 629.5, F + 4, 27.38, 634.5, F + 5.2, 27.5, 'hazard', { emissive: 0.6 });
  k.decor('t07-band', 629.5, F + 4, 32.5, 634.5, F + 5.2, 32.62, 'hazard', { emissive: 0.6 });
  // 割れたガラスの破片(床)と汚れ
  k.decor('shard', 559, F, 7, 567, F + 0.03, 11, 'glass');
  k.decor('shard', 562, F, 11, 566, F + 0.04, 13, 'glass');
  let seed = 77;
  const rnd = (): number => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  for (let i = 0; i < 20; i++) {
    const w = 3 + rnd() * 10;
    const d = 3 + rnd() * 8;
    const x0 = 534 + rnd() * (102 - w);
    const z0 = 4 + rnd() * (132 - d);
    let t = 0.02 + i * 0.0016;
    if (t > 0.045 && t < 0.055) t += 0.012; // 0.05 は床の標示帯と同じ面になる
    k.decor('stain', x0, F, z0, x0 + w, F + t, z0 + d, i % 4 === 0 ? 'rust' : 'concreteDark');
  }
  // ギャラリーの縁の標示(危険帯)とグレーチング
  k.decor('deck-edge', 590, 24, 100.5, 638, 24.05, 101.3, 'hazard');
  k.decor('deck-edge', 590.5, 24, 100, 591.3, 24.05, 138, 'hazard');
  k.decor('deck-grate', 596, 24, 118, 632, 24.04, 128, 'grating');
  k.decor('barrier-zone', 612, 24, 126, 628, 24.06, 137.9, 'hazard');
  // 壁の腰壁
  k.decor('dado', 532, F, 30, 532.12, F + 2.4, 136, 'metalDark');
  k.decor('dado', 637.88, F, 20, 638, F + 2.4, 136, 'metalDark');
  k.decor('dado', 534, F, 137.88, 612, F + 2.4, 138, 'metalDark');
  k.decor('dado', 534, F, 2, 610, F + 2.4, 2.12, 'metalDark');
  void C;
}
