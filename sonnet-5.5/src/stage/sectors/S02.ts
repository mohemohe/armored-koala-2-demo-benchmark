/**
 * S02 資材ヤード (yard, 戦闘): 屋内の広い資材置場 (x70..200 z0..140, 床0 / 天井24)。
 *  - 中央 (80..170 x 36..100) は ARENA_CLEAR。その周囲に 低1.2 / 中2.6 / 高5.2〜7.8m の掩蔽・台座・機械を置き、多方向から射線が交わる。
 *  - 西の扉 P01 から入ると、東の扉 P02 (橙の警告灯・直行) へは開けたアリーナを斜めに横切る。北の扉 P16 (緑の誘導灯) へは
 *    西の遮蔽壁の陰を北上し、北西の作業場を抜ける遮蔽ルート (旧搬送トンネル S17 へ = 分岐 BR1)。
 *  - 天井: 梁(トラス)・天井クレーン(ガーダー高さ 16〜19m)・吊り荷・吊り下げ歩廊・破損した屋根の光。
 *  - 敵: 警備4 (G03..G06) + 砲台2 (T01 北東の高台座 / T02 南東の高台座)。
 * 経路 (routes.ts) の折れ線 = 入口(78,114)→東扉(196,26) / →北扉(120,0) の2本の斜めレーンは常に空ける。
 */
import type { Kit } from '../kit';
import type { MaterialKey } from '../../sim/types';

// ---- 内壁面の座標 (殻: 壁厚2)
const WI = 72; // 西壁の内面 x
const EI = 198; // 東壁の内面 x
const NI = 2; // 北壁の内面 z
const SI = 138; // 南壁の内面 z
const CH = 24; // 天井高
const D = 0.12; // decor の壁面からの突出

/** decor の壁面からの突出量は材質ごとに変える (同じ面に重なる decor が同一平面にならず Z ファイティングしない。すべて 0.15m 以内) */
const DP: Record<string, number> = { concreteDark: 0.07, rust: 0.09, metalDark: 0.1, metal: 0.1, hazard: 0.11, machine: 0.115, glass: 0.12, pipe: 0.13 };
const dp = (m: string): number => DP[m] ?? 0.12;

type Ax = 'x' | 'z';

/** 決定的な疑似乱数 (Math.random は使わない) */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function build(k: Kit): void {
  const rnd = lcg(0x5a02);
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length) % a.length];

  /** 12m コンテナの段積み (min corner x,z / 軸 ax / 段数)。段ごとに材質を変えて色のばらつきを出す */
  const stack = (x: number, z: number, ax: Ax, tiers: number, mat: MaterialKey = 'crate', len = 12, w = 2.6): void => {
    for (let t = 0; t < tiers; t++) {
      const y0 = t * 2.6;
      const m: MaterialKey = t > 0 && mat === 'crate' ? pick(['crate', 'crate', 'rust', 'metal'] as const) : mat;
      if (ax === 'x') k.box('cont', x, y0, z, x + len, y0 + 2.6, z + w, m);
      else k.box('cont', x, y0, z, x + w, y0 + 2.6, z + len, m);
    }
  };

  /** パレット棚: 奥行2.6m・高さ9.6m。荷は棚板の上にまばらに載る (min corner x,z / 軸 / 長さ = 4m の倍数) */
  const rack = (x: number, z: number, ax: Ax, len: number, chance: readonly number[] = [0.75, 0.6, 0.4]): void => {
    const dep = 2.6;
    const bays = Math.round(len / 4);
    const P = (a: number, b: number, y0: number, y1: number, mat: MaterialKey, name: string, da: number, db: number): void => {
      if (ax === 'x') k.box(name, x + a, y0, z + b, x + a + da, y1, z + b + db, mat);
      else k.box(name, x + b, y0, z + a, x + b + db, y1, z + a + da, mat);
    };
    for (let i = 0; i <= bays; i++) {
      const a = i === bays ? len - 0.6 : i * 4;
      P(a, 0, 0, 9.6, 'metalDark', 'rack-post', 0.6, 0.6);
      P(a, dep - 0.6, 0, 9.6, 'metalDark', 'rack-post', 0.6, 0.6);
    }
    for (const y of [2.8, 5.8, 8.8]) P(0.05, 0.05, y, y + 0.5, 'metal', 'rack-shelf', len - 0.1, dep - 0.1);
    const levels = [0, 3.3, 6.3];
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

  /** 作業灯 (マスト + 灯具)。灯具は lightPanel / 発光する箱 = 近傍の点光源になる */
  const lamp = (cx: number, cz: number, baseY: number, mastH: number, ax: Ax = 'x', mat: MaterialKey = 'lightPanel', emissive?: number): void => {
    k.box('lamp-mast', cx - 0.4, baseY, cz - 0.4, cx + 0.4, baseY + mastH, cz + 0.4, 'metalDark');
    const y0 = baseY + mastH;
    const sx = ax === 'x' ? 1.7 : 0.4;
    const sz = ax === 'x' ? 0.4 : 1.7;
    k.box('lamp-head', cx - sx, y0, cz - sz, cx + sx, y0 + 0.9, cz + sz, mat, emissive !== undefined ? { emissive } : {});
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
  // 1. 構造: 壁の付け柱・天井トラス・クレーンの走行桁・吊り下げ歩廊
  // ==================================================================================================================
  for (const x of [140, 160, 176, 188]) k.box('pilaster', x - 1.2, 0, NI, x + 1.2, CH, NI + 1.4, 'concrete');
  for (const x of [112, 136, 160, 184]) k.box('pilaster', x - 1.2, 0, SI - 1.4, x + 1.2, CH, SI, 'concrete');
  for (const z of [44, 68, 92, 110, 134]) k.box('pilaster', EI - 1.4, 0, z - 1.2, EI, CH, z + 1.2, 'concrete');
  for (const z of [14, 28, 134]) k.box('pilaster', WI, 0, z - 1.2, WI + 1.4, CH, z + 1.2, 'concrete');

  // 天井トラス (東西に渡る梁): 天井スラブの下 y 20..22
  for (const z of [24, 56, 88, 120]) k.box('truss', WI, 20, z - 0.6, EI, 22, z + 0.6, 'metalDark');
  // 換気ダクトと配管 (壁沿い, 付け柱の前面に掛かる)
  k.box('duct', 138.8, 12, NI + 1.4, 190.4, 13.6, NI + 3.0, 'metal');
  k.pipe('wall-pipe', 'x', 138.8, 14.4, NI + 1.4, 190.4, 15.6, NI + 2.6, 'pipe');
  k.box('duct', 86.8, 12, SI - 3.0, 185.2, 13.6, SI - 1.4, 'metal');
  k.pipe('wall-pipe', 'x', 86.8, 14.4, SI - 2.6, 185.2, 15.6, SI - 1.4, 'pipe');

  // クレーンの走行桁 (南北): x=84 / x=176, y 15.6..17.4。柱で支える (アリーナ z36..100 の外)
  for (const x of [84, 176]) {
    k.box('runway', x - 1, 15.6, 6, x + 1, 17.4, 132, 'metal');
    for (const z of [20, 116]) k.box('runway-col', x - 1.2, 0, z - 1.2, x + 1.2, 15.6, z + 1.2, 'concrete');
  }
  // ブリッジ・ガーダー (東西): 走行桁の上 y 17.4..19.6, z=68 付近 (アリーナ上空 ≥ 3m)
  k.box('bridge', 85, 17.4, 66.4, 175, 19.6, 69.6, 'metalDark');
  // クレーン台車 + ロープ + フック + 吊り荷 (配管束: 下端 6.2m)
  k.box('trolley', 141, 16.0, 65, 149, 17.4, 71, 'machine');
  k.box('rope', 144.6, 14.4, 67.6, 145.4, 16.0, 68.4, 'metalDark');
  k.box('hook-block', 143.8, 12.8, 67, 146.2, 14.4, 69, 'hazard');
  k.box('spreader', 139, 11.8, 67.2, 151, 12.8, 68.8, 'metalDark');
  for (const x of [140, 149.4]) k.box('sling', x, 8.8, 67.7, x + 0.6, 11.8, 68.3, 'metalDark');
  k.pipe('bundle', 'x', 139, 6.2, 66.2, 151, 8.8, 69.8, 'pipe');
  // 運転室 (ブリッジの西端下)
  k.box('cab', 85, 14.2, 65.2, 89.5, 17.4, 70.8, 'metalDark');
  k.box('cab-window', 89.5, 14.8, 66, 90.1, 16.6, 70, 'glass');
  // クレーンの警告灯 (橙)
  k.box('crane-beacon', 173.6, 19.6, 67, 174.6, 20.1, 69, 'hazard', { emissive: 0.8 });
  k.box('crane-beacon', 85.4, 19.6, 67, 86.4, 20.1, 69, 'hazard', { emissive: 0.8 });

  // 吊り下げ歩廊 (キャットウォーク, 上面 y 9.0): アリーナ上空を南北に渡る。トラスから吊り、両端は柱で受ける
  k.box('gantry-deck', 122.5, 8.4, 30, 127.5, 9.0, 103, 'grating');
  k.box('gantry-rail', 122.5, 9.0, 30, 123.0, 10.0, 103, 'metal');
  k.box('gantry-rail', 127.0, 9.0, 30, 127.5, 10.0, 103, 'metal');
  for (const z of [56, 88]) {
    k.box('gantry-hanger', 124.2, 9.0, z - 0.4, 124.8, 20, z + 0.4, 'metalDark');
    k.box('gantry-hanger', 125.2, 9.0, z - 0.4, 125.8, 20, z + 0.4, 'metalDark');
  }
  k.box('gantry-col', 123.5, 0, 30, 126.5, 8.4, 33, 'concrete'); // 北端の受け柱
  k.box('gantry-col', 123.5, 0, 100, 126.5, 8.4, 103, 'concrete'); // 南端の受け柱

  // 天井から垂れ下がる断線ケーブル/ホース (下端は 7m 以上, 上端はトラスに掛かる)
  for (const [x, z] of [[100, 88], [166, 56], [110, 120], [150, 56]] as [number, number][]) {
    k.box('hang-hose', x - 0.3, 7.6, z - 0.3, x + 0.3, 20, z + 0.3, 'pipe');
  }

  // ==================================================================================================================
  // 2. 北西の作業場 (遮蔽ルートの終点 → P16)
  // ==================================================================================================================
  rack(84, 30, 'x', 20); // アリーナ側を隠す棚 (x84..104, z30..32.6)
  rack(84, 3, 'x', 20); // 北壁沿いの棚
  // 現場事務所 (西): 窓付き
  k.box('office', 73, 0, 16, 81, 3.6, 24, 'metalDark');
  k.box('office-roof', 72.6, 3.6, 15.6, 81.4, 4.1, 24.4, 'metal');
  k.box('office-glass', 81, 1.2, 17, 81.5, 3.0, 23, 'glass');
  // 旋盤 / 圧縮機 (機械)
  k.box('lathe', 90, 0, 16, 98, 2.2, 19.4, 'machine');
  k.box('lathe-head', 90, 2.2, 16, 93, 3.4, 19.4, 'metalDark');
  k.box('compressor', 100, 0, 18, 104.6, 3.2, 22.4, 'machine', { emissive: 0.3 });
  k.box('compressor-tank', 100, 3.2, 18.4, 104.6, 4.6, 22, 'metal');
  // ドラム缶の群れ
  for (const [x, z] of [[76, 29], [78.2, 30.1], [76.4, 31.3], [90, 26.5], [92.2, 27.6], [108, 6], [110.2, 7.4]] as [number, number][]) {
    k.pipe('drum', 'y', x - 0.9, 0, z - 0.9, x + 0.9, 2.2, z + 0.9, pick(['rust', 'pipe', 'hazard'] as const));
  }

  // 北の扉 P16 の庇 (壁から張り出す。y>=8.6 は通行空間の外)。緑の誘導灯 (machine = 緑の点光源)
  k.box('gate16-beam', 109, 8.6, NI, 131, 9.8, 7, 'metal');
  k.box('gate16-lamp', 114, 8.1, 3.2, 118, 8.6, 4.6, 'machine', { emissive: 0.9 });
  k.box('gate16-lamp', 122, 8.1, 3.2, 126, 8.6, 4.6, 'machine', { emissive: 0.9 });

  // 北中央の変電・機械ヤード (P16 の東)
  for (const x of [130, 141]) {
    k.box('transformer', x, 0, 4, x + 6, 5.4, 9.5, 'machine', { emissive: 0.25 });
    for (const dx of [0.8, 2.6, 4.4]) k.pipe('insulator', 'y', x + dx, 5.4, 5.6, x + dx + 0.8, 7.2, 6.4, 'metal');
  }
  stack(128, 22, 'x', 2);
  stack(138, 27, 'x', 1, 'rust');
  // 鋼管の山 (三角に積む)
  {
    const rows: [number, number, number][] = [[4, 4, 0], [3, 4.7, 1.4], [2, 5.4, 2.8], [1, 6.1, 4.2]];
    for (const [n, z0, y0] of rows) {
      for (let i = 0; i < n; i++) k.pipe('steel-pipe', 'x', 156, y0, z0 + i * 1.4, 168, y0 + 1.4, z0 + (i + 1) * 1.4, i % 2 ? 'metal' : 'pipe');
    }
  }
  // 床のピット (縁 1.0m の台に囲まれた凹み。底は床)。北東の空き地
  {
    const pit: [number, number, number, number][] = [[156, 14, 172, 17], [156, 23, 172, 26], [156, 17, 159, 23], [169, 17, 172, 23]];
    for (const [x0, z0, x1, z1] of pit) k.box('pit-rim', x0, 0, z0, x1, 1.0, z1, 'concreteDark');
    k.box('pit-pipe', 158, 1.0, 19.2, 170, 2.0, 20.6, 'rust'); // 穴をまたいで落ちた配管
  }

  // ==================================================================================================================
  // 3. 西の遮蔽廊下 (x72..77.2 の 5m 幅) と、その壁 (アリーナ側)
  // ==================================================================================================================
  stack(77.4, 38, 'z', 2, 'crate', 12);
  stack(77.4, 56, 'z', 3, 'rust', 12);
  stack(77.4, 74, 'z', 2, 'metal', 12);
  stack(77.4, 92, 'z', 1, 'crate', 8);

  // ==================================================================================================================
  // 4. 北の棚壁 (T01 の射線を切る) と 北東の砲台塔 T01
  // ==================================================================================================================
  rack(150, 4, 'z', 28); // x150..152.6, z4..32
  k.box('t01-base', 175.5, 0, 3.5, 184.5, 2, 12.5, 'concreteDark');
  k.turret(180, 8, 6, { baseY: 2, face: [125, 68] });
  for (const [x, z] of [[175.5, 3.5], [183.7, 3.5], [175.5, 11.7], [183.7, 11.7]]) k.box('t01-beacon', x, 2, z, x + 0.8, 2.8, z + 0.8, 'hazard', { emissive: 0.6 });
  // 門形の庇 (東扉 P02) と橙の警告灯
  k.box('gate02-beam', 190, 8.6, 11, EI, 9.8, 29, 'metal'); // 壁から張り出す庇 (柱なし: 斜めレーンを塞がない)
  k.box('gate02-lamp', 193, 8.1, 14, 195, 8.6, 16.5, 'hazard', { emissive: 0.9 });
  k.box('gate02-lamp', 193, 8.1, 23.5, 195, 8.6, 26, 'hazard', { emissive: 0.9 });

  // ==================================================================================================================
  // 5. 南の資材列 (コンテナ 3 列 + 縦置き) と 南東の砲台塔 T02、南西の砂利ボックス
  // ==================================================================================================================
  // 列A (z104..106.6)
  stack(104, 104, 'x', 2);
  stack(116, 104, 'x', 1, 'rust');
  stack(140, 104, 'x', 3);
  stack(152, 104, 'x', 2, 'metal');
  stack(176, 104, 'x', 1);
  // 列B (z115..117.6)
  stack(100, 115, 'x', 1);
  stack(124, 115, 'x', 2);
  stack(136, 115, 'x', 1, 'rust');
  stack(160, 115, 'x', 2);
  stack(184, 115, 'x', 1);
  // 縦置き
  k.box('pallet', 96, 0, 108, 98.6, 1.2, 116, 'crate'); // 低い掩蔽 (視線は通す)
  stack(172.4, 118, 'z', 3, 'rust', 8);
  // 列C (z126.4..129)
  stack(120, 126.4, 'x', 3);
  stack(144, 126.4, 'x', 2);
  stack(168, 126.4, 'x', 2, 'metal');
  k.box('t02-base', 183.5, 0, 125.5, 192.5, 1.5, 134.5, 'concreteDark');
  k.turret(188, 130, 6, { baseY: 1.5, face: [125, 68] });
  for (const [x, z] of [[183.5, 125.5], [191.7, 125.5], [183.5, 133.7], [191.7, 133.7]]) k.box('t02-beacon', x, 1.5, z, x + 0.8, 2.3, z + 0.8, 'hazard', { emissive: 0.6 });
  // 砂利ボックス (仕切り壁 + 山) : 南西
  for (let i = 0; i < 5; i++) k.box('bin-wall', 84 + i * 5, 0, 129, 85 + i * 5, 3.4, SI, 'concreteDark');
  for (let i = 0; i < 4; i++) {
    const x0 = 85 + i * 5;
    const m: MaterialKey = i % 2 ? 'rust' : 'concrete';
    k.box('heap', x0 + 0.3, 0, 132, x0 + 3.7, 1.2, SI, m);
    k.box('heap', x0 + 0.8, 1.2, 133.5, x0 + 3.2, 2.2, SI, m);
    k.box('heap', x0 + 1.3, 2.2, 135, x0 + 2.7, 3.0, SI, m);
  }
  forklift(88, 118, 'x');
  k.box('pallet', 96.4, 0, 121, 100.4, 1.2, 124.2, 'crate');

  // ==================================================================================================================
  // 6. 東の資材群 (x172..196, z34..110) と 低い掩蔽 (ジャージーバリア/パレット)
  // ==================================================================================================================
  stack(178, 50, 'x', 2);
  stack(186, 64, 'z', 3, 'rust', 12);
  stack(176, 82, 'x', 2, 'metal');
  stack(184, 92, 'z', 1, 'crate', 8);
  stack(190, 35, 'z', 2, 'crate', 10);
  for (const z of [60, 76, 92]) k.box('jersey', 172, 0, z, 173, 1.2, z + 4, 'hazard');
  // 崩れた梁 (トラスの一部が落ちて 高い積荷の上端に掛かる: 段状に近似)
  stack(186, 46, 'x', 3, 'rust', 6); // 梁の掛かる高い積荷 (x186..192, z46..48.6)
  {
    const segs: [number, number, number][] = [[184, 190, 7.8], [181, 184, 6.6], [178, 181, 5.4], [175, 178, 4.2], [172, 175, 3.0]];
    segs.forEach(([x0, x1, y], i) => k.box('fallen-beam', x0, y, 46.7, x1, y + 1.2, 47.9, i % 2 ? 'metalDark' : 'metal'));
    k.box('debris', 172, 0, 46.4, 175, 3.0, 48.2, 'concreteDark');
  }

  // 東の高台 (キャットウォーク, 上面 y 6.0): 東壁沿い z50..100。柱で支え、アリーナ側だけ手すり。積荷の陰から見下ろせる
  k.box('east-deck', 190, 5.4, 50, 196.6, 6.0, 100, 'grating');
  k.box('east-rail', 190, 6.0, 50, 190.5, 7.0, 100, 'metal');
  for (const z of [52, 64, 76, 88, 98]) k.box('east-col', 190.2, 0, z - 0.5, 191.2, 5.4, z + 0.5, 'metalDark');
  k.crate('deck-crate', 194, 58, 3, 3, 2.2, 'crate', 6.0);
  k.crate('deck-crate', 194, 82, 4, 3, 1.6, 'rust', 6.0);
  k.crate('deck-crate', 193.4, 92, 3, 3, 2.6, 'crate', 6.0);
  // 倒れた棚 (北のヤード): 棚板が木箱に掛かり、荷が散らばる
  k.box('fallen-shelf', 132, 0, 14, 144, 0.5, 16.6, 'metal');
  k.box('fallen-goods', 132, 0, 17.6, 135, 1.6, 20.2, 'crate');
  k.box('fallen-goods', 143, 0, 17.6, 146, 1.6, 20.2, 'rust');
  k.box('fallen-shelf', 133, 1.6, 17.6, 145.6, 2.1, 20.2, 'metal');
  for (const [x, z, w, d, h] of [[138, 20.6, 2.4, 2.2, 1.4], [141, 12.4, 2.2, 2.2, 1.2], [147, 15, 2.6, 2.4, 1.8]] as [number, number, number, number, number][]) k.crate('fallen-goods', x, z, w, d, h, pick(['crate', 'crate', 'rust'] as const));
  // 二重の資材ブロック (段違いに隣接)
  stack(104, 106.6, 'x', 1, 'rust');
  stack(140, 106.6, 'x', 2, 'crate');
  stack(124, 117.6, 'x', 1, 'rust');
  stack(160, 117.6, 'x', 1, 'metal');
  // 少しずれて崩れかけた最上段 (南西の3段積み)
  k.box('cont', 104.0, 5.2, 104, 116, 7.8, 106.6, 'crate');
  k.box('cont', 108.0, 7.8, 104.4, 120, 10.4, 107.0, 'rust'); // ずれて張り出す最上段

  // ==================================================================================================================
  // 7. 作業灯 (点光源) : 高いコンテナ/棚の上、扉の庇の下
  // ==================================================================================================================
  lamp(94.5, 130.5, 3.4, 3.0, 'x'); // 南西の砂利ボックスの仕切り壁の上 (入口 P01 まわりを照らす)
  lamp(78.7, 62, 7.8, 2.4, 'x'); // 西廊下の上 (白)
  lamp(78.7, 44, 5.2, 1.6, 'x', 'machine', 0.9); // 西廊下 (緑の誘導)
  lamp(78.7, 80, 5.2, 1.6, 'x', 'machine', 0.9);
  lamp(146, 105.3, 7.8, 2.4, 'z');
  lamp(151.3, 22, 9.3, 2.4, 'x');
  lamp(187.3, 70, 7.8, 2.4, 'z');
  lamp(126, 127.7, 7.8, 2.4, 'z');
  lamp(184, 51.3, 5.2, 1.6, 'z', 'hazard', 0.9); // 東側 (橙)

  // ==================================================================================================================
  // 8. decor (衝突なし・壁面/床面/天井面に密着): 壁の板・標示・水漏れ・天井の破損と光
  // ==================================================================================================================
  const wallN = (x0: number, x1: number, y0: number, y1: number, mat: MaterialKey, e?: number): void => {
    k.decor('wall-n', x0, y0, NI, x1, y1, NI + dp(mat), mat, e !== undefined ? { emissive: e } : {});
  };
  const wallS = (x0: number, x1: number, y0: number, y1: number, mat: MaterialKey): void => {
    k.decor('wall-s', x0, y0, SI - dp(mat), x1, y1, SI, mat);
  };
  const wallW = (z0: number, z1: number, y0: number, y1: number, mat: MaterialKey): void => {
    k.decor('wall-w', WI, y0, z0, WI + dp(mat), y1, z1, mat);
  };
  const wallE = (z0: number, z1: number, y0: number, y1: number, mat: MaterialKey, e?: number): void => {
    k.decor('wall-e', EI - dp(mat), y0, z0, EI, y1, z1, mat, e !== undefined ? { emissive: e } : {});
  };

  // 巾木 (床から 1.4m)
  wallN(72, 113, 0, 1.4, 'concreteDark');
  wallN(127, 198, 0, 1.4, 'concreteDark');
  wallS(72, 198, 0, 1.4, 'concreteDark');
  wallW(2, 113, 0, 1.4, 'concreteDark');
  wallW(127, 138, 0, 1.4, 'concreteDark');
  wallE(2, 13, 0, 1.4, 'concreteDark');
  wallE(27, 138, 0, 1.4, 'concreteDark');
  // 錆びた波板のパネル (壁ごとにまだら)
  for (const [x0, x1, y0, y1] of [[88, 100, 3, 9], [162, 176, 4, 11], [190, 198, 5, 10]] as [number, number, number, number][]) wallN(x0, x1, y0, y1, 'rust');
  for (const [x0, x1, y0, y1] of [[76, 90, 2, 8], [112, 128, 3, 10], [150, 166, 2, 7], [170, 182, 5, 12]] as [number, number, number, number][]) wallS(x0, x1, y0, y1, 'rust');
  for (const [z0, z1, y0, y1] of [[30, 48, 3, 9], [56, 76, 5, 13], [84, 104, 2, 8]] as [number, number, number, number][]) wallW(z0, z1, y0, y1, 'rust');
  for (const [z0, z1, y0, y1] of [[36, 58, 4, 11], [70, 86, 2, 7], [96, 118, 6, 12]] as [number, number, number, number][]) wallE(z0, z1, y0, y1, 'rust');
  // 上部の換気ルーバー (金属の暗色帯) と 配線ダクト
  wallN(72, 198, 16.4, 17.6, 'metalDark');
  wallS(72, 198, 16.4, 17.6, 'metalDark');
  wallW(2, 138, 16.4, 17.6, 'metalDark');
  wallE(2, 138, 16.4, 17.6, 'metalDark');
  for (const y of [6.2, 6.7, 7.2]) {
    wallS(72, 198, y, y + 0.15, 'pipe');
    wallW(2, 112, y, y + 0.15, 'pipe');
  }
  // 扉まわりの標示 (P01 = 入口: 黄黒 / P02 = 橙の警告 / P16 = 緑)
  wallW(113, 127, 8, 9.2, 'hazard');
  wallE(13, 27, 8, 9.2, 'hazard');
  wallN(113, 127, 8, 9.2, 'machine', 0.35);
  wallE(10.2, 13, 0, 8, 'hazard');
  wallE(27, 29.8, 0, 8, 'hazard');
  wallN(110.2, 113, 0, 8, 'machine', 0.35);
  wallN(127, 129.8, 0, 8, 'machine', 0.35);
  // 水漏れの跡 (壁の縦筋)
  for (const [x, y0] of [[95, 6], [168, 9], [131, 10]] as [number, number][]) wallN(x, x + 0.9, y0, 16, 'concreteDark');
  wallS(96, 96.9, 4, 16, 'concreteDark');
  wallS(150, 150.9, 5, 16, 'concreteDark');

  // 天井 (屋根スラブ下面 y=24): 破損箇所と差し込む光
  const roof = (x0: number, z0: number, x1: number, z1: number, mat: MaterialKey, h = D): void => {
    k.decor('roof', x0, CH - h, z0, x1, CH, z1, mat);
  };
  roof(94, 42, 114, 54, 'concreteDark');
  roof(96, 44, 112, 52, 'lightPanel', 0.1);
  roof(134, 76, 152, 88, 'concreteDark');
  roof(136, 78, 150, 86, 'lightPanel', 0.1);
  roof(158, 102, 174, 112, 'concreteDark');
  roof(160, 104, 172, 110, 'lightPanel', 0.1);
  roof(100, 22, 110, 30, 'rust');
  roof(86, 96, 96, 104, 'rust');

  // 床の標示 ------------------------------------------------------------------------------------------------------
  const flr = (x0: number, z0: number, x1: number, z1: number, h: number, mat: MaterialKey, e?: number): void => {
    k.decor('floor', x0, 0, z0, x1, h, z1, mat, e !== undefined ? { emissive: e } : {});
  };
  // 緑の破線 (遮蔽ルート): 入口 → 西廊下を北上 → 作業場 → P16
  for (let z = 106; z > 36; z -= 5) flr(74.2, z - 3, 74.9, z, 0.03, 'machine', 0.4);
  for (let z = 32; z > 14; z -= 5) flr(74.2, z - 3, 74.9, z, 0.03, 'machine', 0.4);
  for (let x = 80; x < 110; x += 5) flr(x, 33.6, x + 3, 34.3, 0.03, 'machine', 0.4);
  for (let z = 30; z > 10; z -= 5) flr(119.6, z - 3, 120.3, z, 0.03, 'machine', 0.4);
  // 橙の点線 (直行ルート): 入口 → アリーナを斜めに → P02
  for (let i = 0; i < 20; i++) {
    const t = i / 19;
    const x = 84 + (196 - 84) * t;
    const z = 110 + (24 - 110) * t;
    flr(x - 0.8, z - 0.8, x + 0.8, z + 0.8, 0.035, 'hazard', 0.4);
  }
  // 扉の敷居の黄黒帯
  flr(72, 113, 74, 127, 0.04, 'hazard');
  flr(196, 13, 198, 27, 0.04, 'hazard');
  flr(113, 2, 127, 4, 0.04, 'hazard');
  // 屋根の破損箇所の真下: 差し込む光の跡 (床の淡い発光パッチ)
  for (const [x0, z0, x1, z1] of [[97, 45, 111, 51], [137, 79, 149, 85], [161, 105, 171, 109]] as [number, number, number, number][]) {
    flr(x0, z0, x1, z1, 0.028, 'glass', 0.42);
  }
  // 壁の設備パネル (制御盤)
  for (const [x0, x1] of [[74, 78], [98, 102], [180, 184]] as [number, number][]) {
    k.decor('panel', x0, 1.6, SI - 0.1, x1, 4.6, SI, 'metalDark');
    for (let i = 0; i < 3; i++) k.decor('panel-light', x0 + 0.6 + i * 1.0, 3.6, SI - 0.15, x0 + 1.2 + i * 1.0, 3.9, SI, 'machine', { emissive: 0.45 });
  }
  // アリーナ (戦闘用の空き床) の外周を示す黄黒の枠線
  for (const [x0, z0, x1, z1] of [[80.5, 36.5, 169.5, 37]] as [number, number, number, number][]) flr(x0, z0, x1, z1, 0.03, 'hazard');
  flr(80.5, 99.5, 169.5, 100, 0.03, 'hazard');
  flr(80.5, 37, 81, 99.5, 0.03, 'hazard');
  flr(169, 37, 169.5, 99.5, 0.03, 'hazard');
  // 保管区画の枠線 (黄): 南列のコンテナの周り
  for (const [x0, z0, x1, z1] of [[98, 102, 130, 109], [138, 102, 166, 109], [122, 113, 150, 120], [158, 113, 186, 120]] as [number, number, number, number][]) {
    flr(x0, z0, x1, z0 + 0.3, 0.03, 'hazard');
    flr(x0, z1 - 0.3, x1, z1, 0.03, 'hazard');
    flr(x0, z0 + 0.3, x0 + 0.3, z1 - 0.3, 0.03, 'hazard');
    flr(x1 - 0.3, z0 + 0.3, x1, z1 - 0.3, 0.03, 'hazard');
  }
  flr(160, 18, 168, 22, 0.026, 'glass'); // ピットの底の水
  // 汚れ・錆・煤 (パッチ): 床 / 天井 / 4 壁 (扉の開口は避ける)
  grime('floor', WI, EI, NI, SI, { cell: 12, prob: 0.45, min: 3, max: 9, mats: ['metalDark', 'rust', 'metalDark', 'metal'], thin: 0.008 });
  grime('roof', WI, EI, NI, SI, { cell: 14, prob: 0.55, min: 4, max: 11, mats: ['rust', 'metalDark'], thin: 0.03 });
  grime('n', WI, EI, 0, CH, { cell: 8, prob: 0.45, min: 2, max: 6, mats: ['rust', 'metalDark', 'rust'], streak: true, avoid: [[108, 0, 132, 10]] });
  grime('s', WI, EI, 0, CH, { cell: 8, prob: 0.45, min: 2, max: 6, mats: ['rust', 'metalDark', 'rust'], streak: true });
  grime('w', NI, SI, 0, CH, { cell: 8, prob: 0.45, min: 2, max: 6, mats: ['rust', 'metalDark', 'rust'], streak: true, avoid: [[110, 0, 130, 10]] });
  grime('e', NI, SI, 0, CH, { cell: 8, prob: 0.45, min: 2, max: 6, mats: ['rust', 'metalDark', 'rust'], streak: true, avoid: [[8, 0, 32, 10]] });

  // ==================================================================================================================
  // 9. 敵: 警備 4 (巡回あり) — 入口から見えるのは 1〜2 体、奥では多方向
  // ==================================================================================================================
  k.guard(126, 112, { face: [78, 114], patrol: [{ x: 126, y: 1.5, z: 112 }, { x: 160, y: 1.5, z: 112 }] });
  k.guard(168, 40, { face: [110, 90], patrol: [{ x: 168, y: 1.5, z: 40 }, { x: 168, y: 1.5, z: 96 }] });
  k.guard(108, 24, { face: [120, 60], patrol: [{ x: 108, y: 1.5, z: 24 }, { x: 122, y: 1.5, z: 26 }] });
  k.guard(164, 122, { face: [120, 90], patrol: [{ x: 164, y: 1.5, z: 122 }, { x: 110, y: 1.5, z: 122 }] });
}
