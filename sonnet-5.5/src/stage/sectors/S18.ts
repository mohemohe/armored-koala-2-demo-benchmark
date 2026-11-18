/**
 * S18 屋根裏保守通路 (corridor, +12): 分岐2(BR2)の迂回路。敵なし。
 * 南壁沿いの幅7mの保守レーン(z -9..-2)が東西250mを貫き、その北側は積層した配管バンクと梁・配管が天井(24)まで重なる暗い機械室。
 * 光は薄暗い赤/橙の非常灯だけ(hazard の emissive)。BR2-attic の折れ線(南壁沿い z=-4)と両扉の前面は常に空ける。
 */
import type { Kit } from '../kit';

export function build(k: Kit): void {
  const F = k.floorY; // 12
  const C = k.ceilingY; // 24
  const X0 = k.inner.x0; // 392
  const X1 = k.inner.x1; // 638
  const Z0 = k.inner.z0; // -48
  const Z1 = k.inner.z1; // -2
  const LANE_N = -9; // レーンの北端 (南壁 z=-2 から 7m)

  // ---- 1. レーン北側の配管バンク(4段の太い配管を積む)。crossing(=隙間)は12m。
  const gaps: [number, number][] = [[444, 458], [494, 508], [540, 552]];
  const segs: [number, number][] = [[420, 444], [458, 494], [508, 540], [552, 598]];
  const layerY = [12, 14.6, 17.2, 19.8, 22.4];
  const bankMats = ['pipe', 'metalDark', 'pipe', 'rust', 'pipe'] as const;
  segs.forEach(([a, b], si) => {
    for (let l = 0; l < 4; l++) {
      // 損壊: 一部の段は途中で切れて落ちている
      if ((si === 1 && l === 3) || (si === 3 && l === 2)) {
        k.pipe('bank', 'x', a, layerY[l], LANE_N - 3.4, a + (b - a) * 0.55, layerY[l + 1] - 0.0, LANE_N - 0.6, bankMats[(l + si) % 5]);
        continue;
      }
      k.pipe('bank', 'x', a, layerY[l], LANE_N - 3.4, b, layerY[l + 1], LANE_N - 0.6, bankMats[(l + si) % 5]);
    }
    // バンクの支持脚(南北に貫く角材)
    k.box('bank-leg', a + 0.4, F, LANE_N - 4.4, a + 1.6, layerY[4] - 0.2, LANE_N - 0.2, 'metalDark');
    k.box('bank-leg', b - 1.6, F, LANE_N - 4.4, b - 0.4, layerY[4] - 0.2, LANE_N - 0.2, 'metalDark');
  });
  // バンクの背面(北)に並ぶ縦配管
  for (let i = 0; i < 9; i++) {
    const px = 426 + i * 22;
    if (gaps.some(([g0, g1]) => px + 1.6 > g0 - 1 && px < g1 + 1)) continue;
    k.pipe('riser', 'y', px, F, LANE_N - 8.2, px + 2, C - 0.4, LANE_N - 6.2, 'pipe');
  }

  // ---- 2. 梁: 南北に渡す梁(L1, y 17..18.4)。バンクとレーンの区間を分けて置き、扉の前面(x403..417, 613..627)には置かない。
  const beamXs: number[] = [];
  for (let bx = 426; bx <= 594; bx += 14) beamXs.push(bx);
  for (const bx of beamXs) {
    k.box('cross-beam', bx, F + 5, Z0, bx + 1.6, F + 6.4, LANE_N - 4.6, 'metal');
    k.box('cross-beam', bx, F + 5, LANE_N - 0.4, bx + 1.6, F + 6.4, Z1, 'metal');
  }
  // 縦(東西)の桁: 3本(北ホール) + レーン上空の桁
  for (const gz of [-44, -30, -17]) {
    for (const [a, b] of [[394, 448], [454, 520], [526, 584], [590, 636]] as [number, number][]) {
      k.box('girder', a, F + 8, gz - 0.9, b, F + 9.6, gz + 0.9, 'metalDark');
    }
  }
  k.box('lane-girder', 420, F + 7.6, -6.9, 598, F + 9.2, -5.3, 'metal');
  // 天井に接する配管(北)
  for (const [pz, a, b] of [[-38, 394, 590], [-24, 430, 636], [-46, 470, 636]] as [number, number, number][]) {
    k.pipe('ceil-pipe', 'x', a, C - 2.8, pz - 1.3, b, C - 0.2, pz + 1.3, 'pipe');
  }

  // 東端の機械室(全高)。レーンをここだけ幅3.5mに絞る(BR2-attic の折れ線が南壁沿いを保つ理由)
  k.box('valve-house', 598, F, -14, 612.5, C, -5.5, 'machine');
  k.decor('valve-stripe', 598, F, -5.62, 612.5, F + 0.9, -5.5, 'hazard');

  // ---- 3. 北ホールの柱・縦配管・機械
  for (const px of [440, 476, 512, 548, 584, 618]) {
    for (const pz of [-42, -24]) {
      const wide = (px + pz) % 3 === 0;
      k.pillar('pillar', px, pz, wide ? 3 : 2.4, F, C, wide ? 'concreteDark' : 'metalDark');
    }
  }
  // 柱の非常灯(赤橙): 各柱のレーン側の面に
  for (const px of [440, 476, 512, 548, 584, 618]) {
    for (const pz of [-42, -24]) {
      const wide = (px + pz) % 3 === 0;
      const half = wide ? 1.5 : 1.2;
      k.box('pillar-lamp', px - 0.6, F + 6, pz + half, px + 0.6, F + 7.2, pz + half + 0.7, 'hazard', { emissive: 0.85 });
    }
  }
  // ポンプ室(低い機械)と弁の列
  const pumps: [number, number, number, number][] = [[452, -40, 8, 5], [498, -36, 6, 5], [560, -42, 10, 5], [602, -38, 6, 6]];
  for (const [cx, cz, w, d] of pumps) {
    k.fbox('pump', cx - w / 2, cz - d / 2, cx + w / 2, cz + d / 2, 2.6, 'machine');
    k.fbox('pump-motor', cx - w / 2 + 0.6, cz - d / 2 + 0.6, cx - w / 2 + 3.2, cz + d / 2 - 0.6, 4.0, 'metalDark');
    k.pipe('pump-pipe', 'y', cx + w / 2 - 1.8, F + 2.6, cz - 0.8, cx + w / 2 - 0.4, F + 8, cz + 0.6, 'pipe');
  }
  // 貯水槽(大きな錆びた箱)
  for (const [cx, cz, s, h] of [[486, -20, 8, 7], [532, -40, 9, 8], [580, -33, 8, 6.5]] as [number, number, number, number][]) {
    k.fbox('tank', cx - s / 2, cz - s / 2, cx + s / 2, cz + s / 2, h, 'rust');
    k.fbox('tank-band', cx - s / 2 - 0.4, cz - s / 2 - 0.4, cx + s / 2 + 0.4, cz + s / 2 + 0.4, 1.0, 'hazard', F + h * 0.4);
    k.fbox('tank-cap', cx - s / 2 + 1, cz - s / 2 + 1, cx + s / 2 - 1, cz + s / 2 - 1, 1.2, 'metalDark', F + h);
  }
  // 落ちた梁の残骸(通路の外)
  k.box('fallen-beam', 508, F, -32, 522, F + 1.6, -30, 'metal');
  k.box('fallen-beam', 516, F + 1.6, -32.4, 526, F + 3.2, -29.6, 'rust');
  k.box('fallen-beam', 522, F, -35, 526, F + 2.4, -28, 'rust');
  k.crate('debris', 530, -22, 5, 4, 2.2, 'rust');
  k.crate('debris', 424, -30, 6, 4, 2.6, 'crate');
  k.crate('debris', 428, -22, 4, 4, 1.4, 'crate');

  // ---- 4. 北ホール中央の保守キャットウォーク(+6): 飛行で上がる。手すり付き
  k.platform('walk', 486, -29, 566, -25, F + 6, 1, 'grating');
  for (const rz of [-29, -25.5]) k.box('walk-rail', 486, F + 6, rz, 566, F + 7.2, rz + 0.5, 'metal');
  for (const cx of [490, 514, 540, 562]) k.box('walk-leg', cx, F, -28, cx + 1.2, F + 5, -26, 'metalDark');

  // ---- 5. 装飾(衝突なし): 南壁の設備と非常灯
  const wallZ = Z1; // 南壁の内側の面
  const lampXs = [426, 446, 466, 486, 506, 526, 546, 566, 586, 606];
  for (const lx of lampXs) {
    k.decor('lamp', lx - 0.7, F + 5.6, wallZ - 0.12, lx + 0.7, F + 6.6, wallZ, 'hazard', { emissive: 0.7 });
    k.decor('lamp-base', lx - 1.1, F + 5.4, wallZ - 0.1, lx + 1.1, F + 6.8, wallZ, 'metalDark');
  }
  // ケーブルトレイ・配管(壁面沿い)
  for (const [a, b] of [[420, 470], [476, 540], [546, 610]] as [number, number][]) {
    k.decor('tray', a, F + 3.2, wallZ - 0.14, b, F + 3.7, wallZ, 'metalDark');
    k.decor('tray', a, F + 9.6, wallZ - 0.14, b, F + 10.1, wallZ, 'pipe');
  }
  // 床の標示帯(レーンの縁)
  for (const [a, b] of [[420, 610]] as [number, number][]) k.decor('lane-line', a, F, LANE_N + 0.2, b, F + 0.07, LANE_N + 0.7, 'hazard');
  // 北壁の設備
  for (let i = 0; i < 12; i++) {
    const nx = 404 + i * 20;
    k.decor('n-panel', nx, F + 3, Z0, nx + 6, F + 8, Z0 + 0.12, i % 3 === 0 ? 'machine' : 'metalDark');
  }
  // 床: レーンは暗い金属グレーチング、北ホールは油と錆
  k.decor('lane-grate', 420, F, -8.6, 598, F + 0.05, -2.3, 'grating');
  let seed = 9;
  const rnd = (): number => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  for (let i = 0; i < 26; i++) {
    const w = 3 + rnd() * 12;
    const d = 3 + rnd() * 7;
    const x0 = 394 + rnd() * (240 - w);
    const z0 = -46 + rnd() * (34 - d);
    let t = 0.02 + i * 0.0016;
    if (t > 0.045 && t < 0.055) t += 0.012; // 0.05 は床の標示帯と同じ面になる
    k.decor('stain', x0, F, z0, x0 + w, F + t, z0 + d, i % 2 === 0 ? 'rust' : 'grating');
  }
  // ---- 6. 追加: レーンの絞り(柱)・非常灯・扉枠・暗い床・吊り配管・足場
  // レーンの北縁に張り出す柱: 幅が3.5〜4mに絞られる(南壁沿いの折れ線 z=-4 は空いたまま)
  for (const px of [436, 470, 512, 566, 588]) k.box('lane-post', px - 1, F, -9.4, px + 1, C, -7, 'concreteDark');
  // レーン上空の桁に付けた非常灯(赤橙)
  for (let lx = 430; lx <= 590; lx += 20) {
    if (lx > 596) continue;
    k.box('lane-lamp', lx - 1.2, F + 7, -6.6, lx + 1.2, F + 7.6, -5.6, 'hazard', { emissive: 0.85 });
  }
  // 北ホールの管の集合(ヘッダー)と吊り配管
  k.pipe('header', 'x', 430, F + 0.4, -22.3, 470, F + 3, -19.7, 'pipe');
  k.pipe('header', 'x', 430, F + 3, -22.3, 466, F + 5.6, -19.7, 'rust');
  k.box('header-leg', 436, F, -22.6, 438, F + 3, -19.4, 'metalDark');
  k.box('header-leg', 462, F, -22.6, 464, F + 3, -19.4, 'metalDark');
  k.pipe('hung-pipe', 'x', 494, F + 7.4, -20.3, 556, F + 10, -17.7, 'pipe');
  for (const hx of [498, 522, 550]) k.box('hung-strap', hx, F + 10, -19.5, hx + 1, C, -18.5, 'metalDark');
  // 足場の塔(北ホール西)
  {
    const tx = 446;
    const tz = -33;
    for (const [dx, dz] of [[0, 0], [5, 0], [0, 5], [5, 5]]) k.box('scaffold-post', tx + dx, F, tz + dz, tx + dx + 1, F + 9.5, tz + dz + 1, 'metalDark');
    for (const dy of [3, 6, 9]) k.box('scaffold-deck', tx - 0.5, F + dy, tz - 0.5, tx + 6.5, F + dy + 0.5, tz + 6.5, 'grating');
    k.box('scaffold-rail', tx - 0.5, F + 9.5, tz - 0.5, tx + 6.5, F + 10.7, tz, 'metal');
  }
  // 扉枠(南壁面の危険帯): P18 / P19
  for (const cx of [410, 620]) {
    k.decor('door-frame', cx - 9, F, -2.12, cx - 7, F + 8, -2, 'hazard');
    k.decor('door-frame', cx + 7, F, -2.12, cx + 9, F + 8, -2, 'hazard');
    k.decor('door-frame', cx - 9, F + 8, -2.12, cx + 9, F + 8.8, -2, 'hazard', { emissive: 0.6 });
  }
  // 北ホールの床は暗い鋼板
  k.decor('hall-plate', 394, F, -46.5, 636, F + 0.015, -12.5, 'metalDark');
  void X0;
  void X1;
}
