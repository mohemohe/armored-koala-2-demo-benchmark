/**
 * S16 脱出領域 (yard, +24): x640..720 z340..490 床+24 / 天井40。escapeZone(x660..716 z344..488)に入るとクリア。
 * 最終ゲートの先の搬出ヤード。東の壁いっぱいの「空の光」(夕映えの光と遠景のシルエット)、天窓、出口の門型(x=660)と緑の出口標識、
 * 危険帯のゴールライン、光る灯火塔、駐車したトレーラー。ゲートを抜けたことが一目で分かる明るい屋外の雰囲気にする(敵なし)。
 */
import type { Kit } from '../kit';

export function build(k: Kit): void {
  const F = 24;
  let seed = 1616;
  const rnd = (): number => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // ---- 東西向きのトレーラー(頭が西): x0..x1, 中心 z
  const trailer = (x0: number, x1: number, z: number, cab = true): void => {
    k.box('tr-chassis', x0, F + 0.9, z - 1.3, x1, F + 1.7, z + 1.3, 'metalDark');
    k.box('tr-wheel', x1 - 4.5, F, z - 1.7, x1 - 1.2, F + 1.1, z - 1.3, 'metalDark');
    k.box('tr-wheel', x1 - 4.5, F, z + 1.3, x1 - 1.2, F + 1.1, z + 1.7, 'metalDark');
    k.box('tr-box', x0 + 0.3, F + 1.7, z - 1.3, x1, F + 4.3, z + 1.3, 'crate');
    if (cab) k.box('tr-cab', x0 - 4.6, F + 0.9, z - 1.3, x0 - 0.2, F + 3.4, z + 1.3, 'machine');
  };
  const tower = (x: number, z: number): void => {
    k.box('light-tower', x - 0.5, F, z - 0.5, x + 0.5, F + 10, z + 0.5, 'metalDark');
    k.box('light-tower-head', x - 1.4, F + 10, z - 1.4, x + 1.4, F + 11, z + 1.4, 'lightPanel', { emissive: 1 });
  };

  // =============================================================== 出口の門型(x=660, 経路 z=358 の両脇) と ゴールライン
  k.pillar('exit-post', 660, 350, 3, F, F + 13, 'metal');
  k.pillar('exit-post', 660, 366, 3, F, F + 13, 'metal');
  k.box('exit-beam', 658.5, F + 13, 348.5, 661.5, F + 15, 367.5, 'hazard');
  k.decor('exit-sign', 658.36, F + 13.2, 350, 658.5, F + 14.8, 366, 'machine', { emissive: 0.9 });
  k.decor('exit-sign', 661.5, F + 13.2, 350, 661.64, F + 14.8, 366, 'machine', { emissive: 0.9 });
  k.decor('goal-line', 658.5, F, 344, 661.5, F + 0.06, 488, 'hazard');

  // =============================================================== 灯火塔 (昼光の白い光)
  for (const [x, z] of [[672, 346], [672, 484], [700, 346], [700, 484], [686, 415]] as [number, number][]) tower(x, z);

  // =============================================================== 駐車したトレーラーと積荷(中央の通り z350..368 は空ける)
  trailer(672, 686, 388);
  trailer(692, 706, 388, false);
  trailer(670, 684, 430);
  trailer(690, 704, 448);
  trailer(672, 686, 470);
  k.crate('crate', 652, 420, 8, 6, 3, 'crate', F);
  k.crate('crate', 652, 460, 8, 6, 3, 'crate', F);
  k.fbox('stack', 706, 404, 718, 406.6, 2.6, 'crate', F);
  k.fbox('stack', 706, 404, 718, 406.6, 2.6, 'crate', F + 2.6);
  k.fbox('stack', 706, 470, 716, 472.6, 2.6, 'crate', F);
  k.fbox('barrier', 662, 376, 668, 378.4, 1.4, 'concreteDark', F);
  k.fbox('barrier', 662, 400, 668, 402.4, 1.4, 'concreteDark', F);

  // =============================================================== 東の壁: 空の光(壁面いっぱいの光の面)と遠景のシルエット
  k.decor('sky', 717.86, F + 6, 342, 718, 39.9, 488, 'lightPanel', { emissive: 1 });
  let z = 344;
  while (z < 486) {
    const w = 4 + rnd() * 10;
    const h = 2 + rnd() * 8;
    k.decor('skyline', 717.86, F, z, 718, F + h, Math.min(486, z + w), 'concreteDark');
    z += w + 1 + rnd() * 3;
  }
  for (let i = 0; i < 4; i++) {
    const zc = 360 + i * 36;
    k.decor('chimney', 717.86, F + 8, zc, 718, F + 12 + rnd() * 3.5, zc + 1.6, 'concreteDark');
  }
  // 天窓(屋根の下面)と北・南壁の高窓
  for (const x of [652, 676, 700]) for (const zc of [372, 412, 452]) k.decor('skylight', x - 5, 39.86, zc - 8, x + 5, 40, zc + 8, 'lightPanel', { emissive: 0.85 });
  k.decor('clerestory', 660, 33, 342, 700, 38, 342.14, 'lightPanel', { emissive: 0.7 });
  k.decor('clerestory', 660, 33, 487.86, 700, 38, 488, 'lightPanel', { emissive: 0.7 });

  // =============================================================== 出入口(P15)の緑の非常口標識と、床の帯
  k.decor('exit-door-sign', 642, 33, 346, 642.14, 35, 358, 'machine', { emissive: 0.9 });
  k.decor('road', 642, F, 349, 718, F + 0.03, 367, 'concreteDark');
  for (let x = 648; x < 716; x += 8) k.decor('dash', x, F + 0.03, 357.6, x + 4, F + 0.06, 358.4, 'metal');
  k.decor('road', 642, F, 396, 718, F + 0.03, 402, 'concreteDark');
  for (let i = 0; i < 6; i++) {
    const w = 4 + rnd() * 9;
    const d = 3 + rnd() * 7;
    const x = 645 + rnd() * (70 - w);
    const zz = 372 + rnd() * (110 - d);
    k.decor('stain', x, F, zz, x + w, F + 0.04 + i * 0.002, zz + d, i % 2 ? 'rust' : 'concreteDark');
  }
}
