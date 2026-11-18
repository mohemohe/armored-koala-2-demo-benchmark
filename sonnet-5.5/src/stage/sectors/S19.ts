/**
 * S19 上層配管ダクト (pipe, +24): 分岐3の迂回路(S07→S19→S08)。敵なし。
 * 千鳥に並ぶ3枚の全高仕切り(縦配管の束: R1 x570-576 / R2 x520-526 / R3 x470-476)で蛇行し、仕切りの陰で遮蔽が取れる。
 * 仕切りの「自由端」(R1北端 z300 / R2南端 z320 / R3北端 z300)は分岐経路 BR3-duct の折れ点なので、端面の位置と外形は動かさない。
 * 廃工場の残骸: 垂れ下がった角ダクト(床から6m)・落ちた配管・置き去りの木箱。経路(BR3-duct)の折れ点から離してある。
 * 色味: 寒色(ガラスの青白い灯)を基調に、折れ点の警告灯だけ橙。
 */
import type { Kit } from '../kit';
import type { MaterialKey } from '../../sim/types';

const CYL_MATS: MaterialKey[] = ['pipe', 'metal', 'pipe', 'rust', 'pipe', 'metalDark'];

export function build(k: Kit): void {
  const F = k.floorY; // 24
  const C = k.ceilingY; // 36
  const X0 = k.inner.x0;
  const X1 = k.inner.x1;
  const Z0 = k.inner.z0; // 282
  const Z1 = k.inner.z1; // 338

  // ------------------------------------------------------------------ 仕切り(縦配管の束 6m厚): 基礎の危険帯 + 縦配管2列(千鳥) + 上部マニホールド
  /**
   * zFree = 自由端(通路側に面する端)のz, zWall = 壁に接する端のz。長さ方向に 3m の縦配管を並べ、端数は箱で埋める。
   * 2列目は 1.5m ずらして、継ぎ目から向こう側が透けないようにする。
   */
  const riser = (tag: string, x0: number, zFree: number, zWall: number): void => {
    const x1 = x0 + 6;
    const dir = zWall > zFree ? 1 : -1;
    const L = Math.abs(zWall - zFree);
    const zMin = Math.min(zFree, zWall);
    const zMax = Math.max(zFree, zWall);
    k.box(`${tag}-base`, x0, F, zMin, x1, F + 1, zMax, 'hazard');
    k.box(`${tag}-head`, x0, C - 1.5, zMin, x1, C, zMax, 'metalDark');
    const yLo = F + 1;
    const yHi = C - 1.5;
    const row = (xa: number, xb: number, offset: number, seed: number): void => {
      let cur = 0; // 自由端からの距離
      let i = seed;
      const put = (a: number, b: number, cyl: boolean): void => {
        const za = dir > 0 ? zFree + a : zFree - b;
        const zb = dir > 0 ? zFree + b : zFree - a;
        if (cyl) k.pipe(`${tag}-riser`, 'y', xa, yLo, za, xb, yHi, zb, CYL_MATS[i++ % CYL_MATS.length]);
        else k.box(`${tag}-brace`, xa, yLo, za, xb, yHi, zb, 'metalDark');
      };
      if (offset > 0) {
        put(0, offset, false);
        cur = offset;
      }
      while (L - cur >= 3 + 1e-9) {
        put(cur, cur + 3, true);
        cur += 3;
      }
      if (L - cur > 0.4) put(cur, L, false);
    };
    row(x0, x0 + 3, 0, seed(tag));
    row(x0 + 3, x1, 2, seed(tag) + 3);
  };
  function seed(tag: string): number {
    return tag.charCodeAt(1) % 5;
  }
  riser('R1', 570, 300, Z1); // 自由端=北(z300): 南は壁まで塞ぐ(北が空く)
  riser('R2', 520, 320, Z0); // 自由端=南(z320): 北は壁まで塞ぐ(南が空く)
  riser('R3', 470, 300, Z1);

  // ------------------------------------------------------------------ 天井のダクト(角ダクト): 北(z283-288.5)と南(z331.5-337)を仕切りの面で区切って通す
  // 北ダクトは 出入口(P20 x593-607 / P21 x413-427, 開口高さ32まで)の上(y>=32.2)に通す
  const ductN = (xa: number, xb: number, mat: MaterialKey): void => {
    k.box('duct-n', xa, 32.2, 283, xb, C - 0.1, 288.5, mat);
  };
  ductN(X0, 520, 'metal');
  ductN(526, X1, 'metal');
  for (const x of [438, 500, 552, 612]) k.box('duct-n-flange', x, 31.9, 282.6, x + 1.2, C - 0.05, 289, 'metalDark');
  const ductS = (xa: number, xb: number, mat: MaterialKey): void => {
    k.box('duct-s', xa, 30, 331.5, xb, C - 0.1, 337, mat);
  };
  ductS(X0, 470, 'metal');
  ductS(476, 570, 'metal');
  ductS(576, X1, 'metal');
  for (const x of [430, 496, 546, 600]) k.box('duct-s-flange', x, 29.7, 331, x + 1.2, C - 0.05, 337.5, 'metalDark');

  // ------------------------------------------------------------------ 南壁ぞいの太い配管(床置き): 3本を束ねて仕切りの手前で止める
  const sPipe = (xa: number, xb: number, y0: number, mat: MaterialKey): void => {
    k.pipe('wall-pipe', 'x', xa, y0, 333, xb, y0 + 2.8, 335.8, mat);
  };
  sPipe(X0, 470, F, 'pipe');
  sPipe(X0, 470, F + 2.8, 'pipe');
  sPipe(478, 570, F, 'pipe');
  sPipe(478, 570, F + 2.8, 'rust');
  sPipe(578, X1, F, 'pipe');
  sPipe(578, X1, F + 2.8, 'pipe');

  // ------------------------------------------------------------------ ポケットA(東, x578-636 z302-336): 熱交換ドラム4基と連絡配管。経路(z<=298)には出ない
  const drum = (cx: number, cz: number, s: number, h: number): void => {
    k.box('drum-base', cx - s / 2 - 0.6, F, cz - s / 2 - 0.6, cx + s / 2 + 0.6, F + 1.2, cz + s / 2 + 0.6, 'concreteDark');
    k.box('drum', cx - s / 2, F + 1.2, cz - s / 2, cx + s / 2, F + 1.2 + h, cz + s / 2, 'metal');
    k.box('drum-band', cx - s / 2 - 0.2, F + 1.2 + h * 0.35, cz - s / 2 - 0.2, cx + s / 2 + 0.2, F + 1.2 + h * 0.35 + 1, cz + s / 2 + 0.2, 'hazard');
    k.box('drum-cap', cx - s / 2 + 1, F + 1.2 + h, cz - s / 2 + 1, cx + s / 2 - 1, F + 1.2 + h + 1.4, cz + s / 2 - 1, 'metalDark');
  };
  drum(587, 311, 9, 8);
  drum(609, 311, 9, 6);
  drum(587, 327, 9, 6);
  drum(609, 327, 9, 8);
  // ドラムをつなぐ配管(高い位置: 通行の頭上)
  k.pipe('link', 'x', 591.5, 28.2, 309.5, 604.5, 30.8, 312.5, 'pipe');
  k.pipe('link', 'x', 591.5, 28.2, 325.5, 604.5, 30.8, 328.5, 'pipe');
  k.pipe('link', 'z', 586, 28.4, 315.5, 589, 31, 322.5, 'pipe');
  // 東端の縦配管の列
  for (const z of [304, 316, 328]) k.pipe('stack', 'y', 626, F, z, 629, C - 1.5, z + 3, 'pipe');
  k.box('stack-head', 626, C - 1.5, 302, 629, C, 334, 'metalDark');
  // 低い掩蔽(ドラムの通路の中)
  k.crate('valve-box', 598, 319, 4, 3, 2.4, 'machine', F);
  k.crate('valve-box', 620, 319, 4, 3, 2.4, 'machine', F);

  // ------------------------------------------------------------------ 北の帯(東, x578-636 z282-289.5): 出入口の脇の弁ボックス。P20の前面(x593-607)は空ける
  k.crate('valve-box', 626, 286, 8, 4, 3.2, 'machine', F);
  k.crate('valve-box', 584, 286, 6, 4, 2.4, 'machine', F);
  k.box('tank-n', 630, F, 290, 636, F + 5.5, 297, 'metalDark');
  k.box('tank-n-band', 629.8, F + 2, 289.8, 636.2, F + 3, 297.2, 'hazard');

  // ------------------------------------------------------------------ ポケットB(南, x528-566 z326-330): 仕切りR1の西面ぞいの弁ステーション。経路(z<=322)から離す
  k.crate('valve-box', 542, 328, 8, 4, 2.6, 'machine', F);
  k.crate('valve-box', 556, 329, 6, 4, 3.4, 'machine', F);

  // ------------------------------------------------------------------ 中間(x478-518): R3とR2の間。北帯(z282-290)と南帯(z326-330)に掩蔽
  k.crate('valve-box', 488, 286, 8, 4, 2.6, 'machine', F);
  k.crate('valve-box', 508, 288, 6, 5, 3.6, 'machine', F);
  k.box('tank-m', 484, F, 321, 494, F + 5, 331, 'metalDark');
  k.box('tank-m-band', 483.8, F + 2, 320.8, 494.2, F + 3, 331.2, 'hazard');
  k.crate('valve-box', 506, 330, 6, 4, 2.4, 'machine', F);

  // ------------------------------------------------------------------ 西(x402-466): P21側。南に大きな弁ホール、北の帯に配電盤
  k.crate('valve-box', 440, 286, 10, 4, 3, 'machine', F);
  k.crate('switch-box', 405, 286, 3, 6, 4.2, 'machine', F);
  k.box('manifold', 434, F, 310, 464, F + 3.4, 316, 'metalDark');
  k.box('manifold-band', 433.8, F + 1.2, 309.8, 464.2, F + 2.2, 316.2, 'hazard');
  for (const x of [438, 450, 462]) k.pipe('manifold-stub', 'y', x, F + 3.4, 311, x + 2.2, F + 8, 313.2, 'pipe');
  k.box('manifold-head', 436, F + 8, 309, 464.4, F + 10, 317, 'metalDark');
  k.crate('valve-box', 418, 322, 8, 6, 2.6, 'machine', F);
  k.box('tank-w', 404, F, 321, 414, F + 6, 331, 'metal');
  k.box('tank-w-band', 403.8, F + 2.5, 320.8, 414.2, F + 3.5, 331.2, 'hazard');
  k.crate('valve-box', 452, 330, 6, 4, 2.4, 'machine', F);

  // ------------------------------------------------------------------ 天井の連絡管(北ダクト→南ダクト): 経路(y<=27)の頭上高く(y33..35.8)を横切る
  for (const x of [446, 500, 548, 616]) k.pipe('cross-duct', 'z', x, 33, 288.5, x + 2.8, 35.8, 331.5, 'pipe');

  // ------------------------------------------------------------------ 廃工場の残骸: 垂れ下がった角ダクト(y30)・落ちた配管・置き去りの木箱
  k.box('duct-hang', 452, 30.6, 283, 462, 32.2, 288.5, 'metalDark');
  k.box('duct-hang-break', 451.6, 30, 282.6, 462.4, 30.6, 288.9, 'rust');
  k.pipe('fallen-pipe', 'x', 438, F, 302, 450, F + 2.4, 304.4, 'rust');
  k.box('fallen-pipe-cradle', 449, F, 301.4, 452, F + 1.4, 305, 'concreteDark');
  k.crate('crate', 408.5, 288, 5, 4, 2.6, 'crate', F);
  k.crate('crate', 630, 330, 6, 4, 2.6, 'crate', F);

  // ------------------------------------------------------------------ 装飾(衝突なし): 仕切りの灯・折れ点の警告灯・床の誘導ドット
  // 寒色の灯(ガラス emissive): 仕切り上部マニホールドの側面
  for (const [x, dx] of [[570, -1], [576, 1], [520, -1], [526, 1], [470, -1], [476, 1]] as [number, number][]) {
    const zc = x === 520 || x === 526 ? 300 : 319;
    const xa = dx < 0 ? x - 0.1 : x;
    const xb = dx < 0 ? x : x + 0.1;
    k.decor('lamp-cold', xa, C - 1.2, zc - 3, xb, C - 0.6, zc + 3, 'glass', { emissive: 0.9 });
  }
  // 折れ点の警告灯(橙): 自由端の端面
  k.decor('beacon', 571.5, F + 6, 299.9, 574.5, F + 7, 300, 'hazard', { emissive: 0.9 });
  k.decor('beacon', 521.5, F + 6, 320, 524.5, F + 7, 320.1, 'hazard', { emissive: 0.9 });
  k.decor('beacon', 471.5, F + 6, 299.9, 474.5, F + 7, 300, 'hazard', { emissive: 0.9 });
  // 北壁の設備パネル
  for (const x of [440, 470, 500, 560, 578]) k.decor('panel', x, F + 4, 282, x + 8, F + 8, 282.1, 'machine');
  // 南壁の設備パネル
  for (const x of [415, 445, 530, 590]) k.decor('panel', x, F + 6, 337.9, x + 8, F + 9, 338, 'metalDark');
  // 床の誘導ドット(経路 R: (600,292)->(568,298)->(526,322)->(498,318)->(476,298)->(420,292))
  const path: [number, number][] = [[600, 288], [600, 292], [568, 298], [526, 322], [498, 318], [476, 298], [420, 292]];
  for (let i = 1; i < path.length; i++) {
    const [ax, az] = path[i - 1];
    const [bx, bz] = path[i];
    const n = Math.floor(Math.hypot(bx - ax, bz - az) / 5);
    for (let s = 1; s < n; s++) {
      const x = ax + ((bx - ax) * s) / n;
      const z = az + ((bz - az) * s) / n;
      k.decor('dot', x - 0.5, F + 0.03, z - 0.5, x + 0.5, F + 0.14, z + 0.5, 'hazard');
    }
  }
}
