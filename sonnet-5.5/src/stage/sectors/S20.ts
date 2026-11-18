/**
 * S20 旧倉庫 (warehouse, +24): x120..220 z430..510 床+24 / 天井36。敵なし。分岐4(BR4)の迂回路: 北東の扉(P22)から東の扉(P23)へ抜ける。
 * 埃をかぶった旧い棚の列、崩れた棚と資材の山、割れた天窓から差す弱い光。通路の主線(北東の広い帯)は空けてあり、
 * 西と南の棚の陰に入って迂回できる。光は暗い琥珀色(古い灯り)と灰色の埃。
 */
import type { Kit } from '../kit';

export function build(k: Kit): void {
  const F = 24;
  let seed = 2020;
  const rnd = (): number => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // ---- 旧い棚(東西に長い): x0..x1, z0..z1(奥行3.5m)。2段。荷は所々欠け、上面に埃(装飾)が積もる
  const shelf = (x0: number, x1: number, z0: number, h = 6): void => {
    const z1 = z0 + 3.5;
    const n = Math.max(1, Math.round((x1 - x0) / 7));
    const step = (x1 - x0) / n;
    for (let i = 0; i <= n; i++) {
      const a = Math.max(x0, x0 + i * step - 0.35);
      k.box('post', a, F, z0, Math.min(x1, a + 0.7), F + h, z1, 'rust');
    }
    const tiers = Math.floor(h / 3);
    for (let t = 0; t < tiers; t++) {
      const y = F + t * 3;
      k.box('plank', x0 + 0.7, y, z0 + 0.3, x1 - 0.7, y + 0.5, z1 - 0.3, 'rust');
      const cap = Math.min(2.5, h - 0.5 - t * 3 - 0.5);
      for (let i = 0; i < n; i++) {
        const r = rnd();
        if (r < 0.3) continue; // 空きの棚
        const a = x0 + i * step + 0.7;
        const b = x0 + (i + 1) * step - 0.35;
        const gh = 1.2 + rnd() * (cap - 1.2);
        k.box('goods', a + 0.15, y + 0.5, z0 + 0.5, b - 0.15, y + 0.5 + gh, z1 - 0.5, r < 0.6 ? 'concreteDark' : 'crate');
      }
    }
    k.box('top-plank', x0 + 0.7, F + h - 0.5, z0 + 0.3, x1 - 0.7, F + h, z1 - 0.3, 'rust');
    k.decor('dust', x0 + 0.7, F + h, z0 + 0.3, x1 - 0.7, F + h + 0.08, z1 - 0.3, 'concrete');
  };
  // ---- 崩れた棚と資材の山 (階段状の残骸。通路の半分までにとどめる)
  const pile = (x0: number, z0: number, x1: number, z1: number, h: number): void => {
    k.fbox('rubble', x0, z0, x1, z1, h * 0.5, 'rust', F);
    k.fbox('rubble', x0 + (x1 - x0) * 0.2, z0 + (z1 - z0) * 0.15, x1 - (x1 - x0) * 0.15, z1 - (z1 - z0) * 0.2, h * 0.8, 'concreteDark', F);
    k.fbox('rubble', x0 + (x1 - x0) * 0.4, z0 + (z1 - z0) * 0.3, x1 - (x1 - x0) * 0.35, z1 - (z1 - z0) * 0.4, h, 'crate', F);
  };

  // =============================================================== 棚の列 (経路の帯 x>=192 / 北東は空ける)
  const rows: [number, number][] = [[440, 6], [452, 6], [464, 6], [476, 4.5]];
  rows.forEach(([z, h], r) => {
    let x = 126;
    while (x < 186) {
      const len = 12 + rnd() * 10;
      const x1 = Math.min(186, x + len);
      if (x1 - x > 7) shelf(x, x1, z, h);
      x = x1 + 4 + rnd() * 5; // 横断路
    }
    void r;
  });
  for (const [z, h] of [[488, 6], [500, 6]] as [number, number][]) {
    let x = 126;
    while (x < 212) {
      const len = 14 + rnd() * 12;
      const x1 = Math.min(212, x + len);
      if (x1 - x > 7) shelf(x, x1, z, h);
      x = x1 + 4 + rnd() * 5;
    }
  }
  // 太い柱
  for (const [x, z] of [[160, 446], [160, 470], [160, 494], [196, 484], [130, 494]] as [number, number][]) k.pillar('col', x, z, 2.4, F, 36, 'concreteDark');
  // 崩れた棚
  pile(150, 456, 166, 462, 4.8);
  pile(132, 468, 146, 473, 3.6);
  pile(168, 480, 184, 485.5, 5);
  pile(196, 496, 210, 503, 3.2);
  k.fbox('crate', 122.5, 505, 130, 508, 1.6, 'crate', F);
  k.fbox('crate', 205, 480, 210, 484.5, 1.2, 'crate', F);
  k.fbox('crate', 168, 434, 176, 438, 2.4, 'crate', F);
  k.fbox('crate', 132, 434, 140, 438, 1.2, 'crate', F);

  // 天井の梁(屋根に接する)
  for (const z of [446, 470, 494]) k.box('ceiling-beam', 122, 33.6, z - 1, 218, 36, z + 1, 'metalDark');

  // =============================================================== 光: 割れた天窓(弱い光の面)・古い灯り
  for (const [x, z] of [[140, 460], [176, 446], [150, 490]] as [number, number][]) k.decor('skylight', x - 5, 35.86, z - 4, x + 5, 36, z + 4, 'lightPanel', { emissive: 0.5 });
  for (const [x, z] of [[130, 432], [180, 432], [130, 507.86]] as [number, number][]) k.decor('old-lamp', x - 1.5, 30, z, x + 1.5, 30.7, z + 0.14, 'lightPanel', { emissive: 0.5 });

  // =============================================================== 床の汚れ・埃・古い標示(衝突なし)
  for (let i = 0; i < 9; i++) {
    const w = 4 + rnd() * 10;
    const d = 3 + rnd() * 8;
    const x = 124 + rnd() * (94 - w);
    const z = 434 + rnd() * (72 - d);
    k.decor('stain', x, F, z, x + w, F + 0.03 + i * 0.002, z + d, i % 2 ? 'rust' : 'concreteDark');
  }
  k.decor('lane', 192, F, 432, 193.2, F + 0.05, 478, 'hazard');
  k.decor('wall-pipe', 122, 30, 432, 218, 31.6, 432.14, 'pipe');
  k.decor('wall-pipe', 122, 32.4, 507.86, 218, 34, 508, 'pipe');
}
