/**
 * S01 搬入口 (dock): 屋内のトラック搬入場 (x0..70 z0..140, 床0 / 天井14)。
 *  - 出撃位置は北西の3方壁アルコーブ (西/北=殻の壁, 東=仕切り壁, 南=突き当たりの壁)。位置は変えない。
 *    アルコーブは南北に細長い「遮蔽レーン」(x2..22 z2..67): 出撃位置 (12,14) から初期向き (南=+z) へ、突き当たり (z=67) まで
 *    障害物のない平らな直線が 52m 以上ある (SPEC §11 のQB移動量 42.6m を出撃直後に測れる)。出口は東の仕切り壁の隙間 (z50..56) で、
 *    袖壁 (x22..32 z56..58) が外からの射線を切る。レーン東壁に南向きの大きな矢印 → 出口の隙間の緑の縁取りへ。
 *  - 搬入場: 南の荷役プラットフォームにトラック 4 台 (荷台・キャブ・車輪)・シャッター・フォークリフト・コンテナ・棚・天井梁と作業灯。
 *  - 導線: 出口の隙間から東の扉 P01 まで、緑の点線 (床) + 緑の誘導灯 (壁/扉の庇)。
 *  - 警備 2 (G01 / G02) は遠く (出口から 40m 以上) を巡回し、出撃位置には射線が通らない。
 * 経路 (routes.ts) の mainRoute = (12,14)→(20,52)→(34,54)→(56,88)→(66,114)→(78,114) は常に空ける。
 */
import type { Kit } from '../kit';
import type { MaterialKey } from '../../sim/types';

const WI = 2; // 西壁の内面 x
const EI = 68; // 東壁の内面 x
const NI = 2; // 北壁の内面 z
const SI = 138; // 南壁の内面 z
const CH = 14; // 天井高
const D = 0.12; // decor の壁面からの突出

/** decor の壁面からの突出量は材質ごとに変える (同じ面に重なる decor が同一平面にならず Z ファイティングしない。すべて 0.15m 以内) */
const DP: Record<string, number> = { concreteDark: 0.07, rust: 0.09, metalDark: 0.1, metal: 0.1, hazard: 0.11, machine: 0.115, glass: 0.12, pipe: 0.13 };
const dp = (m: string): number => DP[m] ?? 0.12;

type Ax = 'x' | 'z';

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function build(k: Kit): void {
  const rnd = lcg(0x5a01);
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length) % a.length];

  /** 12m コンテナの段積み */
  const stack = (x: number, z: number, ax: Ax, tiers: number, mat: MaterialKey = 'crate', len = 12, w = 2.6): void => {
    for (let t = 0; t < tiers; t++) {
      const y0 = t * 2.6;
      const m: MaterialKey = t > 0 && mat === 'crate' ? pick(['crate', 'crate', 'rust', 'metal'] as const) : mat;
      if (ax === 'x') k.box('cont', x, y0, z, x + len, y0 + 2.6, z + w, m);
      else k.box('cont', x, y0, z, x + w, y0 + 2.6, z + len, m);
    }
  };

  /** パレット棚 (奥行2.6m・高さ 8.6m) */
  const rack = (x: number, z: number, ax: Ax, len: number, chance: readonly number[] = [0.75, 0.6, 0.4]): void => {
    const dep = 2.6;
    const bays = Math.round(len / 4);
    const P = (a: number, b: number, y0: number, y1: number, mat: MaterialKey, name: string, da: number, db: number): void => {
      if (ax === 'x') k.box(name, x + a, y0, z + b, x + a + da, y1, z + b + db, mat);
      else k.box(name, x + b, y0, z + a, x + b + db, y1, z + a + da, mat);
    };
    for (let i = 0; i <= bays; i++) {
      const a = i === bays ? len - 0.6 : i * 4;
      P(a, 0, 0, 8.8, 'metalDark', 'rack-post', 0.6, 0.6);
      P(a, dep - 0.6, 0, 8.8, 'metalDark', 'rack-post', 0.6, 0.6);
    }
    for (const y of [2.8, 5.6]) P(0.05, 0.05, y, y + 0.5, 'metal', 'rack-shelf', len - 0.1, dep - 0.1);
    const levels = [0, 3.3, 6.1];
    for (let i = 0; i < bays; i++) {
      for (let l = 0; l < 3; l++) {
        if (rnd() > chance[l]) continue;
        const h = 1.4 + rnd() * 0.9;
        const w0 = 0.7 + rnd() * 0.3;
        const w1 = 3.3 - rnd() * 0.3;
        P(i * 4 + w0, 0.15, levels[l], levels[l] + h, pick(['crate', 'crate', 'rust', 'metalDark'] as const), 'rack-goods', w1 - w0, dep - 0.3);
      }
    }
  };

  /** フォークリフト (前 = +軸方向) */
  const forklift = (x: number, z: number, ax: Ax): void => {
    const b = (a0: number, a1: number, b0: number, b1: number, y0: number, y1: number, m: MaterialKey, name: string): void => {
      if (ax === 'x') k.box(name, x + a0, y0, z + b0, x + a1, y1, z + b1, m);
      else k.box(name, x + b0, y0, z + a0, x + b1, y1, z + a1, m);
    };
    b(0, 3.6, 0, 2.0, 0, 0.6, 'concreteDark', 'fork-chassis');
    b(0, 3.6, 0, 2.0, 0.6, 1.9, 'hazard', 'fork-body');
    b(0, 1.2, 0, 2.0, 1.9, 2.4, 'metalDark', 'fork-weight');
    b(0.4, 1.0, 0.2, 1.8, 2.4, 3.2, 'metalDark', 'fork-seat');
    b(3.6, 4.4, 0.5, 1.5, 0, 4.4, 'metal', 'fork-mast');
    b(4.4, 5.6, 0.2, 0.8, 0, 0.6, 'metal', 'fork-blade');
    b(4.4, 5.6, 1.2, 1.8, 0, 0.6, 'metal', 'fork-blade');
  };

  /** トラック: 荷台の後端を荷役プラットフォーム (z=130) に付ける。cx = 車体中心 x。cab は北向き */
  const truck = (cx: number, cargo: MaterialKey, cab: MaterialKey): void => {
    k.box('truck-frame', cx - 1.2, 0.7, 116, cx + 1.2, 1.4, 130, 'metalDark'); // シャーシ
    k.box('truck-trailer', cx - 1.5, 1.4, 115, cx + 1.5, 4.4, 130, cargo); // 荷台
    for (const z of [122.5, 125]) {
      k.box('truck-wheel', cx - 1.8, 0, z, cx - 1.2, 1.3, z + 1.4, 'concreteDark');
      k.box('truck-wheel', cx + 1.2, 0, z, cx + 1.8, 1.3, z + 1.4, 'concreteDark');
    }
    k.box('truck-coupler', cx - 0.8, 1.05, 113.4, cx + 0.8, 1.55, 116, 'metalDark');
    k.box('truck-cab', cx - 1.4, 1.0, 108, cx + 1.4, 3.8, 114, cab);
    k.box('truck-cab-roof', cx - 1.4, 3.8, 109.2, cx + 1.4, 4.4, 114, 'metalDark');
    k.box('truck-bumper', cx - 1.5, 1.0, 107.4, cx + 1.5, 1.8, 108, 'metalDark');
    k.box('truck-wheel', cx - 1.9, 0, 109.5, cx - 1.4, 1.2, 110.9, 'concreteDark');
    k.box('truck-wheel', cx + 1.4, 0, 109.5, cx + 1.9, 1.2, 110.9, 'concreteDark');
    // 前照灯 (弱い暖色の点光源)
    for (const dx of [-1.1, 0.5]) k.box('truck-headlight', cx + dx, 1.9, 107.5, cx + dx + 0.6, 2.4, 108, 'lightPanel');
    // 窓 (decor) と 荷台の反射帯
    k.decor('cab-glass', cx - 1.0, 2.3, 107.88, cx + 1.0, 3.5, 108, 'glass');
    k.decor('cab-glass', cx - 1.52, 2.3, 108.6, cx - 1.4, 3.5, 110.4, 'glass');
    k.decor('cab-glass', cx + 1.4, 2.3, 108.6, cx + 1.52, 3.5, 110.4, 'glass');
    for (const [x0, x1] of [[cx - 1.62, cx - 1.5], [cx + 1.5, cx + 1.62]]) {
      k.decor('trailer-stripe', x0, 1.55, 115, x1, 1.95, 130, 'hazard');
      k.decor('trailer-panel', x0, 2.6, 118, x1, 4.0, 126, 'rust');
    }
  };

  /** 天井から吊る作業灯: 梁の下面 (y=CH-2.6) に吊り金具 + 灯具 (lightPanel = 点光源) */
  const hangLamp = (x: number, z: number, mat: MaterialKey = 'lightPanel', emissive?: number): void => {
    k.box('lamp-hanger', x - 0.25, 10.2, z - 0.25, x + 0.25, 11.4, z + 0.25, 'metalDark');
    k.box('lamp', x - 1.5, 9.6, z - 0.6, x + 1.5, 10.2, z + 0.6, mat, emissive !== undefined ? { emissive } : {});
  };

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
  // 1. 出撃ベイ (遮蔽レーン x2..22 z2..67): 西/北=殻の壁, 東=仕切り壁(出口の隙間 z50..56), 南=突き当たりの壁
  // ==================================================================================================================
  k.partition('alcove-east', 22, 2, 24, 50, 14, 'concrete');
  // 出口の袖壁: 隙間 (z50..56) の南側。外の搬入場からの射線を切る (従来の目隠し壁の東半分)
  k.partition('baffle', 22, 56, 32, 58, 14, 'concreteDark');
  // レーンの南端: 東壁の続きと突き当たりの壁。出撃位置 (12,14) の真南 z=67 まで床は平らで何も置かない (直線 52.2m)
  k.partition('alcove-east', 22, 58, 24, 69, 14, 'concrete');
  k.partition('lane-end', 2, 67, 22, 69, 14, 'concreteDark');
  // 天井の門形ガントリー (梁) と 寒色の灯
  for (const z of [8, 30, 48, 62]) k.box('gantry-beam', 2, 11.2, z - 0.7, 22, 12.8, z + 0.7, 'metalDark');
  for (const z of [8, 30]) k.box('bay-lamp', 6, 10.5, z - 0.5, 18, 11.2, z + 0.5, 'glass', { emissive: 0.9 });
  k.box('bay-lamp', 9, 10.5, 47.5, 15, 11.2, 48.5, 'lightPanel');
  k.box('bay-lamp', 9, 10.5, 61.5, 15, 11.2, 62.5, 'lightPanel');
  // 西壁沿いの設備: 発電機・燃料タンク
  k.box('generator', 2, 0, 20, 5.2, 4.8, 28, 'machine', { emissive: 0.25 });
  k.box('generator-top', 2, 4.8, 21, 4.4, 5.6, 27, 'metalDark');
  for (const z of [34, 38.6, 43.2]) k.pipe('fuel-tank', 'y', 2.4, 0, z - 1.2, 4.8, 4.4, z + 1.2, 'metal');
  // 仕切り壁沿いの補給コンテナ
  k.box('supply', 19.4, 0, 20, 22, 2.6, 32, 'crate');
  k.box('supply', 19.4, 2.6, 22, 22, 5.2, 30, 'rust');
  // 北東隅の木箱
  k.box('crate', 16, 0, 4, 20.4, 3, 8.4, 'crate');
  k.box('crate', 5, 0, 4, 9, 2, 7.2, 'crate');
  k.box('crate', 16.4, 3, 4.4, 20, 5.2, 8, 'crate');

  // ==================================================================================================================
  // 2. 北東の資材置場 (x24..68 z2..56): 棚・柱・コンテナ
  // ==================================================================================================================
  for (const [x, z] of [[44, 14], [64, 14], [44, 38], [64, 38]]) k.box('pillar', x - 1, 0, z - 1, x + 1, CH, z + 1, 'concrete');
  rack(48, 6, 'z', 24);
  rack(56, 6, 'z', 24);
  stack(26, 4, 'x', 3);
  stack(28, 18, 'z', 2, 'metal', 12);
  stack(28, 34, 'z', 1, 'crate', 8);
  stack(52, 40, 'x', 2, 'rust', 8);

  // 崩れた棚 (北東の資材置場): 棚板が木箱に掛かり、荷が散らばる
  k.box('fallen-shelf', 28, 0, 8.4, 40, 0.5, 11, 'metal');
  k.box('fallen-goods', 28, 0, 12, 31, 1.6, 14.6, 'crate');
  k.box('fallen-goods', 37, 0, 12, 40, 1.6, 14.6, 'rust');
  k.box('fallen-shelf', 29, 1.6, 12, 39.6, 2.1, 14.6, 'metal');
  k.crate('fallen-goods', 34, 15.4, 2.4, 2.2, 1.4, 'crate');
  k.crate('fallen-goods', 41.5, 10.6, 2.6, 2.4, 1.8, 'rust');
  // 床のピット (縁 1.0m の台に囲まれた凹み。底は床): 排水ピット
  for (const [x0, z0, x1, z1] of [[32, 22, 44, 25], [32, 30, 44, 33], [32, 25, 35, 30], [41, 25, 44, 30]] as [number, number, number, number][]) k.box('pit-rim', x0, 0, z0, x1, 1.0, z1, 'concreteDark');
  k.box('pit-pipe', 33, 1.0, 26.6, 43, 2.0, 27.8, 'rust');
  // 天井から垂れ下がる断線ケーブル/配管 (下端は 6.4m 以上, 上端はトラスに掛かる)
  for (const [x, z] of [[16, 46], [40, 70], [58, 94], [26, 118]] as [number, number][]) k.box('hang-hose', x - 0.3, 6.4, z - 0.3, x + 0.3, 11.4, z + 0.3, 'pipe');
  // 現場事務所 (北東の隅): 窓付きの小屋
  k.box('office', 58, 0, 44, 66, 3.4, 52, 'metalDark');
  k.box('office-roof', 57.6, 3.4, 43.6, 66, 3.9, 52.4, 'metal');
  k.box('office-glass', 57.5, 1.2, 45, 58, 3.0, 51, 'glass');
  k.decor('office-sign', 57.88, 2.6, 46, 58, 3.4, 50, 'hazard');

  // ==================================================================================================================
  // 3. 中央の通路帯 (z56..110): 最初の遮蔽と、G01 の巡回路
  // ==================================================================================================================
  stack(42, 58, 'x', 2, 'crate', 10);
  k.box('pillar', 35, 0, 75, 37, CH, 77, 'concrete');
  stack(26, 70, 'x', 2, 'metal', 8); // G02 からの視線を切る (出口から見えない)
  stack(52, 62, 'z', 2, 'crate', 8); // G01 の巡回路の手前の遮蔽
  forklift(8, 76, 'z');
  k.box('pallet', 14, 0, 96, 17.6, 1.2, 100, 'crate');
  k.box('pallet', 17.6, 0, 96, 21.2, 1.2, 100, 'rust');
  k.box('pallet', 46, 0, 84, 50, 1.2, 87.4, 'crate');
  for (const [x, z] of [[66.2, 91], [66.2, 93.3], [64.2, 92.2]]) k.pipe('drum', 'y', x - 0.9, 0, z - 0.9, x + 0.9, 2.2, z + 0.9, pick(['rust', 'pipe', 'hazard'] as const));

  // ==================================================================================================================
  // 4. 荷役プラットフォームとトラック (南: z110..138)
  // ==================================================================================================================
  k.box('dock-platform', 4, 0, 130, 58, 1.4, SI, 'concreteDark');
  for (const x of [10, 24, 38, 52]) {
    for (const dx of [-2.6, 2.0]) k.box('dock-bumper', x + dx, 0, 129.2, x + dx + 0.6, 1.4, 130, 'hazard'); // 車止め (プラットフォームの縁)
  }
  truck(10, 'crate', 'crate');
  truck(24, 'metal', 'crate');
  truck(38, 'crate', 'rust');
  truck(52, 'rust', 'crate');
  // 荷役中の荷: プラットフォーム上のパレットとコンテナ
  k.box('dock-goods', 13.5, 1.4, 132, 16.5, 3.4, 135, 'crate');
  k.box('dock-goods', 28, 1.4, 132.4, 31, 2.6, 136, 'rust');
  k.box('dock-goods', 41.5, 1.4, 132, 46, 3.6, 135.4, 'crate');
  forklift(32, 112, 'z');
  // ドアの庇 (P01: 壁から張り出す。y>=8.6 は通行空間の外) と 緑の誘導灯
  k.box('gate-beam', 60, 8.6, 111, EI, 9.8, 129, 'metal');
  k.box('gate-lamp', 63, 8.1, 114, 66, 8.6, 116.5, 'machine', { emissive: 0.9 });
  k.box('gate-lamp', 63, 8.1, 123.5, 66, 8.6, 126, 'machine', { emissive: 0.9 });

  // ==================================================================================================================
  // 5. 天井: 梁 (トラス)・吊り作業灯・モノレールのホイスト
  // ==================================================================================================================
  for (const z of [70, 94, 118]) k.box('truss', 2, 11.4, z - 0.6, EI, 13, z + 0.6, 'metalDark');
  for (const z of [22, 46]) {
    k.box('truss', 24, 11.4, z - 0.6, EI, 13, z + 0.6, 'metalDark'); // アルコーブの外側
  }
  // モノレール (南北) とホイスト
  k.box('monorail', 29.4, 10.2, 62, 30.6, 11.4, 136, 'metal');
  k.box('hoist', 28.4, 8.4, 119, 31.6, 10.2, 123, 'machine');
  k.box('hoist-rope', 29.6, 4.4, 120.6, 30.4, 8.4, 121.4, 'metalDark');
  k.box('hoist-hook', 29, 3.4, 120, 31, 4.4, 122, 'hazard');
  hangLamp(16, 22);
  hangLamp(34, 22);
  hangLamp(52, 22);
  hangLamp(34, 46);
  hangLamp(52, 46);
  hangLamp(16, 70);
  hangLamp(52, 70);
  hangLamp(34, 94);
  hangLamp(52, 94, 'hazard', 0.9);
  hangLamp(16, 118);
  hangLamp(42, 118);

  // ==================================================================================================================
  // 6. decor: 床の導線・標示、壁の板・シャッター、天井の破損
  // ==================================================================================================================
  const flr = (x0: number, z0: number, x1: number, z1: number, h: number, mat: MaterialKey, e?: number): void => {
    k.decor('floor', x0, 0, z0, x1, h, z1, mat, e !== undefined ? { emissive: e } : {});
  };
  // 出撃パッド: 黄黒の縁取り + 暗い鋼板
  flr(5, 6, 19, 22, 0.02, 'metalDark');
  flr(5, 6, 19, 6.6, 0.035, 'hazard');
  flr(5, 21.4, 19, 22, 0.035, 'hazard');
  flr(5, 6.6, 5.6, 21.4, 0.035, 'hazard');
  flr(18.4, 6.6, 19, 21.4, 0.035, 'hazard');
  // 出口へ導く緑の矢印 (南向き): 経路 (12,14)→(20,52) の上
  const arrowS = (cx: number, z0: number): void => {
    flr(cx - 0.9, z0, cx + 0.9, z0 + 3.4, 0.03, 'hazard', 0.45);
    flr(cx - 2.4, z0 + 3.4, cx + 2.4, z0 + 4.1, 0.03, 'hazard', 0.45);
    flr(cx - 1.8, z0 + 4.1, cx + 1.8, z0 + 4.8, 0.03, 'hazard', 0.45);
    flr(cx - 1.2, z0 + 4.8, cx + 1.2, z0 + 5.5, 0.03, 'hazard', 0.45);
    flr(cx - 0.6, z0 + 5.5, cx + 0.6, z0 + 6.2, 0.03, 'hazard', 0.45);
  };
  for (const z of [26, 35, 44]) arrowS(12 + (z + 2.5 - 14) * (8 / 38), z);
  // 出口の隙間 (東向き): レーンの突き当たり手前で曲がる
  {
    const x0 = 14;
    const cz = 53;
    flr(x0, cz - 0.9, x0 + 3.4, cz + 0.9, 0.03, 'hazard', 0.45);
    flr(x0 + 3.4, cz - 2.4, x0 + 4.1, cz + 2.4, 0.03, 'hazard', 0.45);
    flr(x0 + 4.1, cz - 1.8, x0 + 4.8, cz + 1.8, 0.03, 'hazard', 0.45);
    flr(x0 + 4.8, cz - 1.2, x0 + 5.5, cz + 1.2, 0.03, 'hazard', 0.45);
    flr(x0 + 5.5, cz - 0.6, x0 + 6.2, cz + 0.6, 0.03, 'hazard', 0.45);
  }
  // 出口 → 扉 の緑の点線 (経路 (24,53)→(34,54)→(56,88)→(66,114) をなぞる)
  {
    const pts: [number, number][] = [[24, 53], [34, 54], [56, 88], [66, 114]];
    for (let i = 1; i < pts.length; i++) {
      const [x0, z0] = pts[i - 1];
      const [x1, z1] = pts[i];
      const n = Math.max(1, Math.floor(Math.hypot(x1 - x0, z1 - z0) / 4.5));
      for (let j = 0; j < n; j++) {
        const t = j / n;
        const x = x0 + (x1 - x0) * t;
        const z = z0 + (z1 - z0) * t;
        flr(x - 0.7, z - 0.7, x + 0.7, z + 0.7, 0.035, 'hazard', 0.45);
      }
    }
  }
  // 扉の敷居の黄黒帯
  flr(66, 113, 68, 127, 0.04, 'hazard');
  // 荷役レーンの枠線 (トラックの停車位置) と 油のしみ
  for (const x of [10, 24, 38, 52]) {
    flr(x - 3.2, 108, x - 2.9, 130, 0.02, 'hazard');
    flr(x + 2.9, 108, x + 3.2, 130, 0.02, 'hazard');
  }
  flr(28, 80, 44, 92, 0.02, 'concreteDark');
  flr(8, 96, 24, 106, 0.02, 'concreteDark');
  flr(44, 100, 60, 108, 0.02, 'concreteDark');
  flr(50, 60, 58, 70, 0.022, 'rust');
  flr(30, 60, 36, 66, 0.024, 'glass');

  // 壁 -----------------------------------------------------------------------------------------------------------
  const wallN = (x0: number, x1: number, y0: number, y1: number, mat: MaterialKey, e?: number): void => {
    k.decor('wall-n', x0, y0, NI, x1, y1, NI + dp(mat), mat, e !== undefined ? { emissive: e } : {});
  };
  const wallS = (x0: number, x1: number, y0: number, y1: number, mat: MaterialKey, e?: number): void => {
    k.decor('wall-s', x0, y0, SI - dp(mat), x1, y1, SI, mat, e !== undefined ? { emissive: e } : {});
  };
  const wallW = (z0: number, z1: number, y0: number, y1: number, mat: MaterialKey): void => {
    k.decor('wall-w', WI, y0, z0, WI + dp(mat), y1, z1, mat);
  };
  const wallE = (z0: number, z1: number, y0: number, y1: number, mat: MaterialKey, e?: number): void => {
    k.decor('wall-e', EI - dp(mat), y0, z0, EI, y1, z1, mat, e !== undefined ? { emissive: e } : {});
  };
  // 巾木
  wallN(2, 68, 0, 1.2, 'concreteDark');
  wallS(2, 68, 0, 1.2, 'concreteDark');
  wallW(2, 138, 0, 1.2, 'concreteDark');
  wallE(2, 113, 0, 1.2, 'concreteDark');
  wallE(127, 138, 0, 1.2, 'concreteDark');
  // 出撃ベイの大扉 (北壁) : 暗い鋼板 + 黄黒の縁
  wallN(5, 19, 0, 9.2, 'metalDark');
  wallN(4.4, 5, 0, 9.8, 'hazard');
  wallN(19, 19.6, 0, 9.8, 'hazard');
  wallN(5, 19, 9.2, 9.8, 'hazard');
  // レーン東壁 (仕切り壁の西面) の巨大な矢印 (南向き = 出口の隙間の緑の縁取りへ)
  {
    const face = (z0: number, z1: number, y0: number, y1: number): void => {
      k.decor('lane-arrow', 22 - D, y0, z0, 22, y1, z1, 'hazard', { emissive: 0.45 });
    };
    face(29, 42.4, 5.6, 7.6);
    face(42.4, 44.2, 3.8, 9.4);
    face(44.2, 46, 4.6, 8.6);
    face(46, 47.8, 5.4, 7.8);
    face(47.8, 48, 6.2, 7.0);
  }
  // 出口の隙間 (z50..56) の縁取り: 緑の縦帯 (袖壁 x22..32 z56..58 の北面と、仕切り壁の南端面)
  k.decor('exit-frame', 22, 0, 50, 24, 8, 50.12, 'machine', { emissive: 0.45 });
  k.decor('exit-frame', 22, 0, 55.88, 24, 8, 56, 'machine', { emissive: 0.45 });
  k.decor('exit-frame', 22 - D, 0, 48.4, 22, 8, 50, 'machine', { emissive: 0.45 });
  k.decor('exit-frame', 22 - D, 0, 56, 22, 8, 57.6, 'machine', { emissive: 0.45 });
  // 突き当たりの壁の足元に黄黒帯
  k.decor('lane-end-stripe', 2, 0, 66.88, 22, 1.4, 67, 'hazard');
  // 仕切り壁 (アルコーブ東壁) の両面に錆と警告帯
  k.decor('alcove-panel', 21.88, 0, 6, 22, 4, 18, 'rust');
  k.decor('alcove-stripe', 24, 0, 2, 24.12, 1.4, 50, 'hazard');
  k.decor('alcove-panel', 24, 3, 8, 24.12, 9, 26, 'rust');
  k.decor('alcove-stripe', 24, 0, 58, 24.12, 1.4, 69, 'hazard');
  // 南壁: トラックのシャッター (荷役ベイ) : 横桟の鋼板 + 黄黒の枠
  for (const x of [10, 24, 38, 52]) {
    k.decor('shutter-frame', x - 3.2, 1.4, SI - D, x - 2.8, 8.2, SI, 'hazard');
    k.decor('shutter-frame', x + 2.8, 1.4, SI - D, x + 3.2, 8.2, SI, 'hazard');
    k.decor('shutter-frame', x - 2.8, 7.8, SI - D, x + 2.8, 8.2, SI, 'hazard');
    for (let i = 0; i < 6; i++) k.decor('shutter', x - 2.8, 1.4 + i * 1.07, SI - D, x + 2.8, 1.4 + i * 1.07 + 0.95, SI, i % 2 ? 'metal' : 'metalDark');
    k.decor('bay-beacon', x - 0.5, 8.6, SI - D, x + 0.5, 9.4, SI, 'hazard', { emissive: 0.45 });
  }
  wallS(58, 68, 1.2, 8, 'rust');
  // 西壁: 錆の板と配管
  for (const [z0, z1, y0, y1] of [[60, 80, 2, 9], [98, 124, 3, 10], [126, 136, 2, 7], [30, 46, 6, 12]] as [number, number, number, number][]) wallW(z0, z1, y0, y1, 'rust');
  for (const y of [5.8, 6.3, 6.8]) wallW(58, 138, y, y + 0.15, 'pipe');
  // 東壁: 扉まわり (緑の縦帯 + 黄黒) と 板
  wallE(110, 113, 0, 8, 'machine', 0.45);
  wallE(127, 130, 0, 8, 'machine', 0.45);
  wallE(113, 127, 8, 9.2, 'machine', 0.45);
  for (const [z0, z1, y0, y1] of [[4, 30, 3, 10], [60, 100, 4, 9]] as [number, number, number, number][]) wallE(z0, z1, y0, y1, 'rust');
  // 上部の暗帯 (煤)
  wallN(24, 68, 10.4, 14, 'concreteDark');
  wallS(2, 68, 10.4, 14, 'concreteDark');
  wallW(58, 138, 10.4, 14, 'concreteDark');
  wallE(2, 138, 10.4, 14, 'concreteDark');
  // 壁の設備パネル (制御盤・配電盤)
  for (const [z0, z1] of [[62, 66], [84, 88], [104, 108]] as [number, number][]) {
    k.decor('panel', WI, 1.6, z0, WI + 0.1, 4.6, z1, 'metalDark');
    for (let i = 0; i < 3; i++) k.decor('panel-light', WI, 3.6, z0 + 0.6 + i * 1.0, WI + 0.15, 3.9, z0 + 1.2 + i * 1.0, 'machine', { emissive: 0.45 });
  }
  // 天井の破損と光
  k.decor('roof', 40, CH - D, 84, 56, CH, 96, 'concreteDark');
  k.decor('roof', 42, CH - 0.1, 86, 54, CH, 94, 'lightPanel');
  k.decor('roof', 10, CH - D, 60, 22, CH, 66, 'rust');
  k.decor('roof', 46, CH - D, 24, 60, CH, 32, 'rust');

  grime('floor', WI, EI, NI, SI, { cell: 12, prob: 0.45, min: 3, max: 9, mats: ['metalDark', 'rust', 'metalDark', 'metal'], thin: 0.008 });
  grime('roof', WI, EI, NI, SI, { cell: 12, prob: 0.5, min: 3, max: 8, mats: ['rust', 'metalDark'], thin: 0.03 });
  grime('w', NI, SI, 0, CH, { cell: 7, prob: 0.45, min: 2, max: 5, mats: ['rust', 'metalDark', 'rust'], streak: true });
  grime('e', NI, SI, 0, CH, { cell: 7, prob: 0.45, min: 2, max: 5, mats: ['rust', 'metalDark', 'rust'], streak: true, avoid: [[108, 0, 132, 10]] });
  grime('s', WI, EI, 0, CH, { cell: 7, prob: 0.45, min: 2, max: 5, mats: ['rust', 'metalDark', 'rust'], streak: true, avoid: [[4, 1, 60, 10]] });
  grime('n', 24, EI, 0, CH, { cell: 7, prob: 0.45, min: 2, max: 5, mats: ['rust', 'metalDark', 'rust'], streak: true });

  // ==================================================================================================================
  // 7. 敵: 警備 2 (遠くを巡回・出撃位置に射線なし)
  // ==================================================================================================================
  k.guard(58, 76, { face: [12, 40], patrol: [{ x: 58, y: 1.5, z: 76 }, { x: 56, y: 1.5, z: 102 }] });
  k.guard(26, 100, { face: [60, 120], patrol: [{ x: 26, y: 1.5, z: 100 }, { x: 14, y: 1.5, z: 88 }] });
}
