/**
 * S17 旧搬送トンネル (corridor, 敵なし): 分岐 BR1 の遮蔽ルート (x100..300 z-40..0, 床0 / 天井12)。
 *  - 中央の搬送機 (ベルトコンベヤ: 脚・ベルト・ホッパー・駆動部) が北レーン(z-38..-24)と南レーン(z-18..-2)を割る。搬送機の下は 3.2m の隙間 (くぐれる)。
 *  - 南レーンは扉 P16 (西) と P17 (東) を結ぶ本線。斜めの経路 (128,-4)→(198,-12)→(278,-12) は常に空ける。
 *  - 柱・積荷・崩れた資材(瓦礫の山・落下した梁)・北壁沿いのキャットウォークで遮蔽が続く。
 *  - 暗めの非常灯 (赤/橙)・水漏れ (壁の筋と床の水たまり)・錆と煤。
 */
import type { Kit } from '../kit';
import type { MaterialKey } from '../../sim/types';

const WI = 102; // 西壁の内面 x
const EI = 298; // 東壁の内面 x
const NI = -38; // 北壁の内面 z
const SI = -2; // 南壁の内面 z
const CH = 12; // 天井高
const D = 0.12;

/** decor の壁面からの突出量は材質ごとに変える (同じ面に重なる decor が同一平面にならず Z ファイティングしない。すべて 0.15m 以内) */
const DP: Record<string, number> = { concreteDark: 0.07, rust: 0.09, metalDark: 0.1, metal: 0.1, hazard: 0.11, machine: 0.115, glass: 0.12, pipe: 0.13 };
const dp = (m: string): number => DP[m] ?? 0.12;

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function build(k: Kit): void {
  const rnd = lcg(0x5a17);
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length) % a.length];

  // ------------------------------------------------------------------------------------------------------------------
  // 汚れ・錆・煤のパッチ (decor, 衝突なし)。区画の面を格子に分け、ジッタ配置 (パッチ同士は重ならない)。
  //   surface: 'floor' | 'roof' | 'n' | 's' | 'w' | 'e'。u,v = その面の 2 軸 (床/天井: x,z / 南北の壁: x,y / 東西の壁: z,y)
  //   avoid: [u0,v0,u1,v1] の矩形 (扉の開口など) には置かない。厚みは thin (床/壁面から突出する量)
  // ------------------------------------------------------------------------------------------------------------------
  const grime = (
    surface: 'floor' | 'roof' | 'n' | 's' | 'w' | 'e',
    u0: number, u1: number, v0: number, v1: number,
    o: { cell: number; prob: number; min: number; max: number; mats: readonly MaterialKey[]; thin?: number; avoid?: readonly (readonly [number, number, number, number])[]; streak?: boolean },
  ): number => {
    let n = 0;
    const thin = o.thin ?? 0.03;
    const put = (a0: number, b0: number, a1: number, b1: number, mat: MaterialKey, t: number): void => {
      if (a1 - a0 < 0.05 || b1 - b0 < 0.05) return;
      for (const [x0, y0, x1, y1] of o.avoid ?? []) if (a1 > x0 && a0 < x1 && b1 > y0 && b0 < y1) return;
      if (surface === 'floor') k.decor('grime', a0, 0, b0, a1, t, b1, mat);
      else if (surface === 'roof') k.decor('grime', a0, CH - t, b0, a1, CH, b1, mat);
      else if (surface === 'n') k.decor('grime', a0, b0, NI, a1, b1, NI + t, mat);
      else if (surface === 's') k.decor('grime', a0, b0, SI - t, a1, b1, SI, mat);
      else if (surface === 'w') k.decor('grime', WI, b0, a0, WI + t, b1, a1, mat);
      else k.decor('grime', EI - t, b0, a0, EI, b1, a1, mat);
      n++;
    };
    for (let a = u0; a < u1; a += o.cell) {
      for (let b = v0; b < v1; b += o.cell) {
        if (rnd() > o.prob) continue;
        const w = o.min + rnd() * (o.max - o.min);
        const h = o.min + rnd() * (o.max - o.min);
        const pa = a + rnd() * Math.max(0.01, o.cell - w);
        const pb = b + rnd() * Math.max(0.01, o.cell - h);
        const a0 = Math.max(u0, pa);
        const b0 = Math.max(v0, pb);
        const a1 = Math.min(u1, pa + w);
        const b1 = Math.min(v1, pb + h);
        const mat = o.mats[Math.floor(rnd() * o.mats.length) % o.mats.length];
        put(a0, b0, a1, b1, mat, thin);
        if (rnd() < 0.5) put(a0 + (a1 - a0) * 0.15, b0 + (b1 - b0) * 0.15, a1 - (a1 - a0) * 0.15, b1 - (b1 - b0) * 0.15, o.mats[Math.floor(rnd() * o.mats.length) % o.mats.length], thin * 1.4); // 重ね塗り (小さい矩形を少し厚く)
        if (o.streak && surface !== 'floor' && surface !== 'roof' && rnd() < 0.6) {
          // 錆の筋: パッチの下へ垂れる細い縦帯
          const sx = a0 + (a1 - a0) * (0.2 + rnd() * 0.6);
          put(sx, Math.max(v0, b0 - 1.5 - rnd() * 4), sx + 0.25 + rnd() * 0.4, b0, mat, thin * 1.2);
        }
      }
    }
    return n;
  };

  // ==================================================================================================================
  // 1. 骨組み: 柱・天井のリブ・天井配管・北壁沿いのキャットウォーク
  // ==================================================================================================================
  // 南レーンの中央列の柱 (z=-10): 経路 (128,-4)→(198,-12)→(278,-12) はこの柱の北を回る (骨格の最短経路と同じ位置に置く)
  for (const x of [160, 200, 240]) k.box('pillar', x - 1, 0, -11, x + 1, CH, -9, 'concrete');
  // 北列の柱 (z=-36, キャットウォークの腕木を受ける)
  for (let x = 120; x <= 280; x += 20) k.box('pillar', x - 1, 0, -37, x + 1, CH, -35, 'concrete');
  // 天井のリブ (東西 20m ごとに南北へ渡る梁)
  for (let x = 110; x <= 290; x += 20) k.box('rib', x - 0.6, 10.0, NI, x + 0.6, 11.8, SI, 'metalDark');
  // 天井配管 (北側の束) と 断線して垂れ下がる配管の先 (下端 6.4m)
  k.pipe('ceiling-pipe', 'x', WI, 10.4, -35.8, EI, 11.6, -34.6, 'pipe');
  k.pipe('ceiling-pipe', 'x', WI, 8.8, -35.8, 170, 10.0, -34.6, 'pipe');
  k.pipe('ceiling-pipe', 'x', 192, 8.8, -35.8, EI, 10.0, -34.6, 'pipe');
  k.pipe('broken-pipe', 'y', 170.2, 6.4, -35.8, 171.4, 8.8, -34.6, 'pipe'); // 断線して垂れる
  k.pipe('broken-pipe', 'y', 190.8, 6.4, -35.8, 192, 8.8, -34.6, 'pipe');
  k.box('duct', WI, 9.0, -30, EI, 10.2, -28.4, 'metal'); // 北レーン上の換気ダクト
  // 北壁沿いのキャットウォーク (上面 y 5.4, 幅 3.6m)。柱から腕木で吊る。手すりは南の縁だけ
  k.box('catwalk', 106, 4.8, -34, 294, 5.4, -30.4, 'grating');
  k.box('catwalk-rail', 106, 5.4, -30.9, 294, 6.4, -30.4, 'metal');
  for (let x = 120; x <= 280; x += 20) k.box('catwalk-arm', x - 0.5, 4.8, -35, x + 0.5, 5.4, -34, 'metalDark');

  // ==================================================================================================================
  // 2. 中央の搬送機 (レーンを割る): 脚・ベルト・側板・ホッパー・駆動部
  // ==================================================================================================================
  const CZ0 = -23;
  const CZ1 = -19;
  // ベルトは x198..210 で崩落して切れている (落ちた搬送機の断片が床に横たわる)
  for (const [x0, x1] of [[132, 198], [210, 268]] as [number, number][]) {
    k.box('belt', x0, 3.2, CZ0, x1, 4.4, CZ1, 'metalDark');
    k.box('belt-side', x0, 4.4, CZ0, x1, 5.2, CZ0 + 0.5, 'metal');
    k.box('belt-side', x0, 4.4, CZ1 - 0.5, x1, 5.2, CZ1, 'metal');
  }
  for (const x of [138, 153.5, 169, 184.5, 216, 231.5, 247, 262]) {
    k.box('belt-leg', x - 0.5, 0, CZ0 + 0.3, x + 0.5, 3.2, CZ0 + 1.3, 'metal');
    k.box('belt-leg', x - 0.5, 0, CZ1 - 1.3, x + 0.5, 3.2, CZ1 - 0.3, 'metal');
  }
  k.box('belt-fallen', 200, 0, CZ0, 209, 1.2, CZ1, 'metalDark'); // 落ちたベルト断片
  k.box('belt-fallen-side', 200, 1.2, CZ0, 209, 2.0, CZ0 + 0.5, 'metal');
  k.box('belt-fallen-leg', 199, 0, -18.4, 204, 0.6, -17.6, 'metal');
  // 駆動部 (東) と 張り機構 (西)
  k.box('drive', 268, 0, -25, 276, 6.2, -17, 'machine', { emissive: 0.3 });
  k.box('motor', 276, 0, -24, 281, 3.6, -18, 'machine');
  k.box('motor-cap', 276.6, 3.6, -23.2, 280.4, 4.4, -18.8, 'metalDark');
  k.box('tail', 126, 0, -25, 132, 5.4, -17, 'metalDark');
  // ホッパー: 4 本の脚 + 漏斗 (段積み) + シュート
  for (const x of [168, 184]) for (const z of [-27, -16]) k.box('hopper-leg', x - 0.6, 0, z - 0.6, x + 0.6, 6.4, z + 0.6, 'metalDark');
  k.box('hopper', 166, 6.4, -28, 186, 7.6, -14, 'metal');
  k.box('hopper', 169, 7.6, -26, 183, 8.8, -16, 'rust');
  k.box('chute', 174, 5.2, -22.4, 178, 6.4, -19.6, 'metalDark');
  // 搬送機の上を渡る点検橋 (2 か所): ベルトの上 y 6.0 ..6.6, 幅 2m
  for (const x of [222, 250]) {
    k.box('bridge', x - 1, 6.0, -26.5, x + 1, 6.6, -15.5, 'grating');
    k.box('bridge-post', x - 0.5, 0, -26.5, x + 0.5, 6.0, -25.5, 'metalDark');
    k.box('bridge-post', x - 0.5, 0, -16.5, x + 0.5, 6.0, -15.5, 'metalDark');
  }

  // ==================================================================================================================
  // 3. 積荷・崩れた資材 (南北の両レーン。斜めの経路から 2m 以上離す)
  // ==================================================================================================================
  // 北レーン (z-38..-24): 積荷は南北どちらか半分だけに置く (もう一方に 5m 以上の通路を残す)
  k.crate('crate', 112, -32, 6, 5, 2.6, 'crate'); // 北半分
  k.crate('crate', 112, -32, 4, 3, 2.6, 'rust', 2.6);
  k.crate('crate', 140, -27, 8, 3.6, 2.4, 'rust'); // 南半分
  k.crate('crate', 152, -33, 5, 4, 3.6, 'crate'); // 北
  k.crate('crate', 172, -33, 5, 4, 1.4, 'crate'); // 北 (低い)
  k.crate('crate', 192, -32, 4, 4, 2.6, 'crate'); // 北
  k.crate('crate', 232, -27, 5, 3, 2.0, 'crate'); // 南
  k.crate('crate', 244, -33, 6, 4, 2.6, 'metal'); // 北
  // 崩れた天井の瓦礫の山 (北壁に接する段積み) と 落ちた梁
  k.box('rubble', 202, 0, NI, 218, 1.4, -29.5, 'concreteDark');
  k.box('rubble', 205, 1.4, NI, 215, 2.8, -31, 'rust');
  k.box('rubble', 208, 2.8, NI, 212, 4.2, -33, 'concreteDark');
  // 南レーン (z-18..-2): 斜めの経路 (128,-4)→(198,-12)→(278,-12) の外側だけ
  k.crate('crate', 142, -15, 6, 4, 2.6, 'crate'); // 経路より北 (z-17..-13)
  k.crate('crate', 176, -6, 6, 3, 2.4, 'rust'); // 骨格の位置のまま (経路の最短を決める積荷)
  k.box('cargo-pallet', 168, 0, -6, 172, 1.2, -2.8, 'crate');
  k.crate('crate', 212, -4.4, 8, 3.4, 2.4, 'rust');
  k.crate('crate', 232, -16.5, 6, 3, 2.6, 'crate'); // 経路 z=-12 の北 (z-18..-15)
  k.crate('crate', 160, -16.5, 5, 3, 1.4, 'rust'); // 南レーンの北寄り (低い掩蔽): 経路の最短を変えない位置
  k.crate('crate', 192, -16.5, 6, 3, 2.6, 'crate');
  k.crate('crate', 214, -16.5, 5, 3, 1.4, 'rust');
  k.crate('crate', 246, -16.5, 4, 3, 2.6, 'crate');
  k.crate('crate', 226, -4.2, 4, 3, 1.4, 'crate');
  k.crate('crate', 264, -4.2, 6, 3, 2.6, 'rust');
  k.crate('crate', 258, -16.5, 8, 3, 4.6, 'metal');
  for (const [x, z] of [[190, -5.5], [192.2, -4.4], [190.4, -3.6]]) k.pipe('drum', 'y', x - 0.9, 0, z - 0.9, x + 0.9, 2.2, z + 0.9, pick(['rust', 'pipe', 'hazard'] as const));
  // トロッコ (鉱車): 北レーンの東 (北半分)
  for (const x of [250, 260]) {
    k.box('cart', x, 0.6, -34.4, x + 8, 2.6, -31.2, 'rust');
    k.box('cart-wheel', x + 0.8, 0, -34.4, x + 2.2, 0.6, -31.2, 'metalDark');
    k.box('cart-wheel', x + 5.8, 0, -34.4, x + 7.2, 0.6, -31.2, 'metalDark');
  }

  // 配電盤 (南壁に取り付け): 経路から 1.8m 以上離す
  for (const x of [152, 200, 240, 254]) {
    k.box('cabinet', x - 1, 0, SI - 0.9, x + 1, 2.4, SI, 'machine');
    k.box('cabinet-lamp', x - 0.4, 2.4, SI - 0.5, x + 0.4, 2.9, SI, 'machine', { emissive: 0.9 });
  }
  // 排水ピット (北レーン西): 縁 1.0m の台に囲まれた凹み (北側は開けて通路を広く残す)
  for (const [x0, z0, x1, z1] of [[116, -25.4, 126, -23], [116, -28.6, 118.4, -25.4], [123.6, -28.6, 126, -25.4]] as [number, number, number, number][]) {
    k.box('pit-rim', x0, 0, z0, x1, 1.0, z1, 'concreteDark');
  }
  // 天井から垂れ下がる断線ケーブル (下端 7m 以上, 上端はリブに掛かる)
  for (const [x, z] of [[150, -26], [190, -14], [210, -26], [230, -14], [270, -30]] as [number, number][]) {
    k.box('hang-cable', x - 0.25, 7.4, z - 0.25, x + 0.25, 10.0, z + 0.25, 'metalDark');
  }
  // 落ちた非常灯 (床で赤く光る): 経路から 2m 以上離す
  k.box('fallen-lamp', 149.4, 0, -3.5, 151.0, 0.6, -2.4, 'gate', { emissive: 0.9 });
  k.box('fallen-lamp', 262.0, 0, -37.4, 263.6, 0.6, -36.4, 'gate', { emissive: 0.9 });

  // ==================================================================================================================
  // 4. 非常灯 (暗い赤/橙)・水漏れ・標示 (decor)
  // ==================================================================================================================
  // 非常灯 (実体の箱): 南壁と北の柱に取り付け。赤 = gate、橙 = hazard
  for (let x = 130; x <= 290; x += 32) k.box('emergency-lamp', x - 0.6, 6.4, SI - 0.6, x + 0.6, 7.2, SI, 'gate', { emissive: 0.9 });
  for (let x = 150; x <= 270; x += 40) k.box('warning-lamp', x - 0.6, 6.0, NI, x + 0.6, 6.8, NI + 0.6, 'hazard', { emissive: 0.9 });
  k.box('drive-lamp', 268.6, 6.2, -21.6, 269.4, 7.0, -20.4, 'machine', { emissive: 0.9 });
  for (const x of [160, 200, 240]) k.box('pillar-lamp', x - 0.6, 5.0, -11.6, x + 0.6, 5.8, -11, 'gate', { emissive: 0.9 }); // 中央列の柱の北面の非常灯 (経路の上 5m: 通行の邪魔にならない)
  for (const x of [118, 278]) k.box('door-lamp', x - 2, 8.3, SI - 0.6, x + 2, 8.9, SI, 'hazard', { emissive: 0.9 }); // 扉の上の橙の灯

  const wallS = (x0: number, x1: number, y0: number, y1: number, mat: MaterialKey, e?: number): void => {
    k.decor('wall-s', x0, y0, SI - dp(mat), x1, y1, SI, mat, e !== undefined ? { emissive: e } : {});
  };
  const wallN = (x0: number, x1: number, y0: number, y1: number, mat: MaterialKey, e?: number): void => {
    k.decor('wall-n', x0, y0, NI, x1, y1, NI + dp(mat), mat, e !== undefined ? { emissive: e } : {});
  };
  const flr = (x0: number, z0: number, x1: number, z1: number, h: number, mat: MaterialKey, e?: number): void => {
    k.decor('floor', x0, 0, z0, x1, h, z1, mat, e !== undefined ? { emissive: e } : {});
  };
  // 巾木 (南北の壁) ・錆の板・煤
  wallS(102, 113, 0, 1.2, 'concreteDark');
  wallS(127, 273, 0, 1.2, 'concreteDark');
  wallS(287, 298, 0, 1.2, 'concreteDark');
  wallN(102, 298, 0, 1.2, 'concreteDark');
  for (const [x0, x1, y0, y1] of [[140, 158, 2, 8], [176, 196, 3, 9], [224, 246, 2, 7], [262, 272, 4, 9]] as [number, number, number, number][]) wallS(x0, x1, y0, y1, 'rust');
  for (const [x0, x1, y0, y1] of [[110, 134, 5.6, 10], [160, 190, 6.5, 10], [236, 270, 6, 10]] as [number, number, number, number][]) wallN(x0, x1, y0, y1, 'rust');
  wallS(102, 298, 9.4, 12, 'concreteDark');
  wallN(102, 298, 9.4, 12, 'concreteDark');
  // 扉 P16/P17 まわり: 警告の黄黒帯 (開口の上・左右)
  wallS(113, 127, 8, 9.2, 'hazard');
  wallS(273, 287, 8, 9.2, 'hazard');
  wallS(110.2, 113, 0, 8, 'hazard');
  wallS(127, 129.8, 0, 8, 'hazard');
  wallS(270.2, 273, 0, 8, 'hazard');
  wallS(287, 289.8, 0, 8, 'hazard');
  // 水漏れ: 壁の筋 (壁面に密着した半透明の帯) と 床の水たまり
  wallN(150, 150.5, 0, 10, 'glass');
  wallN(236, 236.6, 0, 10, 'glass');
  wallS(188, 188.5, 0, 9, 'glass');
  flr(144, -38, 158, -31, 0.026, 'glass');
  flr(230, -38, 244, -32, 0.026, 'glass');
  flr(182, -8, 196, -2, 0.026, 'glass');
  flr(120, -20, 134, -13, 0.026, 'glass');
  // 旧トロッコの線路: 北レーン全長 (レール 2 本 + 枕木)。床面の decor
  for (const zc of [-33.4, -31.8]) flr(WI + 2, zc - 0.15, EI - 2, zc + 0.15, 0.045, 'metal');
  for (let x = 108; x < 296; x += 2.4) flr(x, -34.0, x + 0.5, -31.2, 0.028, 'rust');
  // 床: 搬送機の影のしみ・錆・油
  flr(132, -18.6, 268, -17.8, 0.02, 'concreteDark');
  flr(132, -24.2, 268, -23.4, 0.02, 'concreteDark');
  flr(160, -14, 176, -8, 0.022, 'rust');
  flr(226, -10, 240, -6, 0.022, 'rust');
  flr(262, -36, 276, -30, 0.022, 'rust');
  // 柱の根元の黄黒帯 (中央列の柱の南北の面)
  for (const x of [160, 200, 240]) {
    k.decor('pillar-band', x - 1, 0, -11.12, x + 1, 1.2, -11, 'hazard');
    k.decor('pillar-band', x - 1, 0, -9, x + 1, 1.2, -8.88, 'hazard');
  }
  // 天井の暗い補修板と錆
  k.decor('roof', 150, CH - D, -30, 166, CH, -12, 'rust');
  k.decor('roof', 230, CH - D, -36, 250, CH, -20, 'rust');
  // 汚れ・錆・煤 (パッチ)
  grime('floor', WI, EI, NI, SI, { cell: 10, prob: 0.45, min: 3, max: 8, mats: ['metalDark', 'rust', 'metalDark', 'metal'], thin: 0.008 });
  grime('roof', WI, EI, NI, SI, { cell: 12, prob: 0.5, min: 3, max: 9, mats: ['rust', 'metalDark'], thin: 0.03 });
  grime('n', WI, EI, 0, CH, { cell: 7, prob: 0.45, min: 2, max: 5, mats: ['rust', 'metalDark', 'rust'], streak: true });
  grime('s', WI, EI, 0, CH, { cell: 7, prob: 0.45, min: 2, max: 5, mats: ['rust', 'metalDark', 'rust'], streak: true, avoid: [[110, 0, 130, 10], [270, 0, 290, 10]] });
  grime('w', NI, SI, 0, CH, { cell: 7, prob: 0.45, min: 2, max: 5, mats: ['rust', 'metalDark', 'rust'], streak: true });
  grime('e', NI, SI, 0, CH, { cell: 7, prob: 0.45, min: 2, max: 5, mats: ['rust', 'metalDark', 'rust'], streak: true });
}
