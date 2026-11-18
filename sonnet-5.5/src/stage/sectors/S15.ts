/**
 * S15 搬出ゲート (gate, +12): x500..640 z340..490 床+12 / 天井40。敵なし。
 * 最終搬出ゲート(GATE)の前の大ホール。西の搬出橋(P14)から入り、2枚の開いた隔壁枠(検問)を経てゲート前の区画へ進み、
 * 昇降C8(+12 → ゲート前デッキ +24)でゲートへ向かう。枠の開口は経路の対角線(x+z=994)が抜ける位置に広く空けてある。
 * 東壁のゲートは閉じている間は赤い警告灯と危険帯に縁取られる(開くと奥のS16の昼光が差し込む)。床の赤い誘導灯が検問の開口から昇降の離陸点へ導く。
 * 光は赤(非常灯・警告灯)と危険色(黄黒)。
 */
import type { Kit } from '../kit';

export function build(k: Kit): void {
  const F = 12;
  let seed = 1515;
  const rnd = (): number => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  k.climbPads('C8', [[636, 344], [636, 388], [598, 388]]);

  const cont = (x0: number, z0: number, stack = 1, len = 12): void => {
    for (let s = 0; s < stack; s++) k.box('cont', x0, F + s * 2.6, z0, x0 + len, F + (s + 1) * 2.6, z0 + 2.6, 'crate');
  };
  const beacon = (x: number, z: number, h = 4): void => {
    k.box('beacon-post', x - 0.4, F, z - 0.4, x + 0.4, F + h, z + 0.4, 'metalDark');
    k.box('beacon-lamp', x - 0.7, F + h, z - 0.7, x + 0.7, F + h + 0.9, z + 0.7, 'gate', { emissive: 0.9 });
  };
  // ---- 検問の隔壁枠: x..x+4 の壁(天井まで)に、z0..z1 の開口(高さ13m)。開口は開いた状態(隔壁は上に収納)
  const frame = (x: number, z0: number, z1: number): void => {
    k.box('bulkhead', x, F, 342, x + 4, 40, z0, 'metalDark');
    k.box('bulkhead', x, F, z1, x + 4, 40, 488, 'metalDark');
    k.box('bulkhead-header', x, F + 13, z0, x + 4, 40, z1, 'metal');
    k.box('shutter-box', x - 1, F + 12, z0, x, F + 13, z1, 'hazard'); // 収納された隔壁の下端(西面の突起)
    k.decor('jamb', x, F, z0 - 0.14, x + 4, F + 13, z0, 'hazard');
    k.decor('jamb', x, F, z1, x + 4, F + 13, z1 + 0.14, 'hazard');
    for (const s of [x - 0.14, x + 4]) k.decor('frame-lamp', s, F + 14, z0 + 2, s + 0.14, F + 15, z1 - 2, 'gate', { emissive: 0.8 });
  };

  // =============================================================== 最終ゲートの構造 (東壁 z345..359, y24..32): 枠・まぐさ・警告灯
  k.box('gate-col', 630, 24, 342, 638, 40, 345, 'metal');
  k.box('gate-lintel', 630, 32, 345, 638, 37, 361.5, 'metalDark');
  k.box('gate-hanger', 636, 37, 359.5, 638, 40, 361.5, 'metal');
  for (const z of [347.5, 352, 356.5]) k.box('gate-beacon', 632, 37, z - 0.8, 636, 38.2, z + 0.8, 'gate', { emissive: 0.9 });
  k.pipe('piston', 'y', 631.4, 24, 342.4, 633.8, 32, 344.8, 'metalDark');
  k.decor('gate-chevron', 629.86, 32.4, 345, 630, 36.6, 361.5, 'hazard');
  k.decor('gate-frame', 637.86, 24, 341.9, 638, 40, 345, 'hazard');
  k.decor('gate-lamp', 637.86, 33, 346, 638, 34.2, 358, 'gate', { emissive: 0.9 });
  // デッキ(C8): 縁の帯と端末
  k.decor('deck-edge', 596.5, 24, 342, 598, 24.06, 390, 'hazard');
  k.decor('deck-edge', 598, 24, 388.5, 638, 24.06, 390, 'hazard');
  k.fbox('console', 600, 344, 608, 350, 3, 'machine', 24);
  k.decor('console-screen', 599.86, 25.4, 345, 600, 26.6, 349, 'gate', { emissive: 0.8 });
  k.fbox('deck-crate', 614, 344, 620, 349, 1.2, 'crate', 24);
  k.fbox('deck-crate', 622, 380, 630, 386, 2.4, 'crate', 24);
  beacon(636, 373.5, 3.2);
  k.box('deck-beacon', 598.2, 24, 343.2, 599, 27.2, 344, 'metalDark');
  k.box('deck-beacon-lamp', 597.9, 27.2, 342.9, 599.3, 28, 344.3, 'gate', { emissive: 0.9 });

  k.decor('deck-lining', 637.86, 24, 361.5, 638, 30, 390, 'metalDark');
  k.decor('deck-lining', 598, 24, 342, 630, 29, 342.14, 'metalDark');
  k.decor('deck-lining', 637.86, 24, 345, 638, 24.9, 359, 'hazard');
  for (const z of [370, 382]) k.decor('deck-lamp', 637.86, 26, z - 1.5, 638, 27, z + 1.5, 'gate', { emissive: 0.8 });

  // =============================================================== 検問枠: 経路の対角線(x+z=994)が抜ける位置に大きな開口
  frame(548, 434, 454);
  frame(576, 404, 428);

  // =============================================================== 入口の検問(P14 の前は空ける)
  k.fbox('checkpoint', 502, 456, 511, 463.5, 3.6, 'machine', F);
  k.fbox('checkpoint-roof', 501.5, 455.5, 511.5, 464, 0.6, 'hazard', F + 3.6);
  k.fbox('checkpoint', 502, 484.4, 511, 488, 3.6, 'machine', F);
  k.decor('checkpoint-lamp', 511, F + 2.2, 458, 511.14, F + 3, 462, 'gate', { emissive: 0.8 });

  // =============================================================== 区画1 (x502..548): 北西のコンテナヤード
  for (const [z, s1, s2] of [[350, 2, 1], [368, 1, 2], [386, 2, 1], [404, 1, 2], [424, 2, 1]] as [number, number, number][]) {
    cont(506, z, s1);
    cont(526, z, s2);
  }
  cont(524, 484, 2, 10);
  cont(536, 484, 1, 10);
  // 区画2 (x552..576)
  cont(555, 352, 2, 16);
  cont(555, 372, 1, 16);
  cont(555, 390, 2, 16);
  cont(555, 470, 1, 18);
  cont(555, 482, 2, 18);
  // 区画3 (x580..638): 昇降の離陸点まわり(x587..593,z393..399 は空ける)
  cont(582, 352, 1, 12);
  cont(582, 372, 2, 12);
  cont(598, 452, 1);
  cont(614, 452, 2);
  cont(600, 470, 1);
  cont(616, 470, 1);
  cont(618, 428, 2);
  cont(604, 428, 1);
  cont(584, 484, 2);
  // 警告灯(赤)の柱: 各区画に
  for (const [x, z] of [[540, 440], [540, 476], [566, 444], [566, 344], [600, 440], [630, 420], [630, 470], [590, 366]] as [number, number][]) beacon(x, z);

  // =============================================================== 赤い誘導灯: 入口 → 検問A → 検問B → 昇降の離陸点(床。光らない灯)
  for (let i = 0; i < 12; i++) {
    const x = 520 + i * 6;
    const z = 994 - x;
    k.decor('guide', x - 0.6, F, z - 0.6, x + 0.6, F + 0.1, z + 0.6, 'gate');
  }
  k.decor('launch-pad', 586, F, 392, 594, F + 0.06, 400, 'hazard');

  // =============================================================== 壁の内張り・錆・配管(衝突なし)
  k.decor('lining', 502, F, 342, 638, F + 5, 342.14, 'metalDark');
  k.decor('lining', 502, F, 487.86, 638, F + 5, 488, 'metalDark');
  k.decor('wall-pipe', 502, F + 9, 342, 638, F + 10.6, 342.14, 'pipe');
  k.decor('wall-pipe', 502, F + 12, 487.86, 638, F + 13.6, 488, 'pipe');
  for (let i = 0; i < 14; i++) {
    const x = 504 + rnd() * 130;
    const h = 3 + rnd() * 9;
    k.decor('streak', x, F + 6 + rnd() * 6, 342, x + 0.6 + rnd() * 1.2, F + 6 + h, 342.12, 'rust');
  }
  for (let i = 0; i < 6; i++) {
    const w = 4 + rnd() * 9;
    const d = 3 + rnd() * 7;
    const x = 504 + rnd() * (130 - w);
    const z = 346 + rnd() * (138 - d);
    k.decor('stain', x, F, z, x + w, F + 0.03 + i * 0.002, z + d, i % 2 ? 'rust' : 'concreteDark');
  }

  // =============================================================== 天井トラス
  for (const z of [372, 412, 452]) k.box('truss', 502, 37.4, z - 1, 638, 40, z + 1, 'metalDark');
}
