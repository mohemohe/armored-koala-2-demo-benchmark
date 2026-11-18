/**
 * S10 排気縦坑 (shaft, 地下-14): +12 の張り出しの足場(P09 の入口)から地下(-14)の底へ飛び降りる縦坑。降下は落下で行う(昇降ではない)。敵なし。
 *
 * 構成 (x 212..268 / z 202..278 の内寸、床 -14、天井 26 = 深さ 40m):
 *  - 入口の張り出し(x250..268, z250..278, 上面 +12): 太い支柱と梁の脚で立つ。縁は北・西に開いて(飛び降り口)、警告帯と橙の警告灯。
 *  - 天井近く(y18..22)に巨大な排気ファン2基(角枠・ハブ・十字と斜めの羽根)を西壁に寄せて吊る。
 *  - 北東に全高の主排気ダクト(リブと支線ダクト)、南西に換気機械群、南東(張り出しの下)にポンプ室。
 *  - 西壁と北壁に格子の足場(-4 / +6)と全高の縦配管、壁の縦一列の非常灯(深さの目盛り)。
 *  - 降下・着地の帯(x212..250, z205..250 の床)は空けてある: 着地して EN を回復できる床(着地の標示帯 + 床の光)。
 *  昇降ではないので C1〜C8 の予約はない。ルート(routes.ts)の折れ線: (266,13.5,260)→(248,13.5,242)→(238,5.5,234)→(214,-8.5,220) を塞がない。
 */
import type { MaterialKey } from '../../sim/types';
import type { Kit } from '../kit';

export function build(k: Kit): void {
  const F = k.floorY; // -14
  const T = k.ceilingY; // 26
  const WX0 = k.inner.x0; // 212
  const WX1 = k.inner.x1; // 268
  const WZ0 = k.inner.z0; // 202
  const WZ1 = k.inner.z1; // 278
  const LOWH = 1.2;

  // ------------------------------------------------------------------ 入口の張り出し (P09, 上面 +12)
  const LX = 250; // 張り出しの西端(飛び降り口)
  const LZ = 250; // 張り出しの北端
  k.platform('ledge', LX, LZ, 268, 278, 12, 2, 'grating');
  // 脚: 太い支柱(床まで) + 梁の枠(y-3 / y5)。北・西へ飛び降りる縁は開ける
  const lx = LX + 2.5;
  const lz = LZ + 2.5;
  for (const [x, z] of [[lx, lz], [266, lz], [lx, 276], [266, 276], [259, 264]] as [number, number][]) {
    k.pillar('ledge-leg', x, z, 3, F, 10, 'metalDark');
  }
  for (const y of [-3, 5]) {
    k.box('ledge-beam', lx, y, lz - 0.6, 266, y + 1.2, lz + 0.6, 'metal');
    k.box('ledge-beam', lx, y, 276 - 0.6, 266, y + 1.2, 276 + 0.6, 'metal');
    k.box('ledge-beam', lx - 0.6, y, lz, lx + 0.6, y + 1.2, 276, 'metal');
    k.box('ledge-beam', 266 - 0.6, y, lz, 266 + 0.6, y + 1.2, 276, 'metal');
  }
  // 縁の手すり: 西の南半分と、北の東寄り(ルートの折れ線が越える北縁の x252..258 は開けておく)
  k.box('ledge-rail', LX, 12, 262.6, LX + 0.5, 13.2, 278, 'metal');
  k.box('ledge-rail', 260.6, 12, LZ, 268, 13.2, LZ + 0.5, 'metal');
  k.box('ledge-post', LX, 12, 261.6, LX + 1, 13.6, 262.6, 'hazard');
  k.box('ledge-post', 259.6, 12, LZ, 260.6, 13.6, LZ + 1, 'hazard');
  // 縁の警告帯(床面の装飾)
  k.decor('edge-n', LX, 12, LZ, 259.6, 12.05, LZ + 1.4, 'hazard');
  k.decor('edge-n', 260.6, 12, LZ + 0.5, 268, 12.05, LZ + 1.4, 'hazard');
  k.decor('edge-w', LX, 12, LZ + 1.4, LX + 1.4, 12.05, 261.6, 'hazard');
  k.decor('edge-w', LX + 0.5, 12, 262.6, LX + 1.4, 12.05, 278, 'hazard');
  // 入口の扉(P09)の上の非常灯と壁の警告枠
  k.box('door-lamp', 267.4, 21, 259.5, 268, 22.4, 272.5, 'lightPanel', { emissive: 1 });
  k.decor('door-frame', 267.85, 20.3, 258.2, 268, 20.9, 273.8, 'hazard');
  k.decor('door-frame', 267.85, 11.2, 258.2, 268, 20.3, 258.8, 'hazard');
  k.decor('door-frame', 267.85, 11.2, 273.2, 268, 20.3, 273.8, 'hazard');
  k.box('ledge-lamp', 262, 12, 277.4, 266, 13.6, 278, 'hazard', { emissive: 0.8 });

  // ------------------------------------------------------------------ 天井近くの排気ファン 2基 (西壁に寄せて吊る)
  const fan = (cx: number, cz: number, y0: number, R: number): void => {
    const H = 4;
    k.box('fan-ring', cx - R, y0, cz - R, cx - R + 2, y0 + H, cz + R, 'metal');
    k.box('fan-ring', cx + R - 2, y0, cz - R, cx + R, y0 + H, cz + R, 'metal');
    k.box('fan-ring', cx - R + 2, y0, cz - R, cx + R - 2, y0 + H, cz - R + 2, 'metal');
    k.box('fan-ring', cx - R + 2, y0, cz + R - 2, cx + R - 2, y0 + H, cz + R, 'metal');
    // 縁の警告帯(リングの下面の内側)
    k.box('fan-hub', cx - 2.5, y0 + 0.5, cz - 2.5, cx + 2.5, y0 + 3.5, cz + 2.5, 'machine');
    k.box('fan-cone', cx - 1, y0 + 3.5, cz - 1, cx + 1, y0 + 4.6, cz + 1, 'hazard', { emissive: 0.7 });
    const L = R - 2;
    // 十字の羽根(4)
    k.box('fan-blade', cx + 2.5, y0 + 1.4, cz - 1.3, cx + L, y0 + 2.4, cz + 1.3, 'metalDark');
    k.box('fan-blade', cx - L, y0 + 1.4, cz - 1.3, cx - 2.5, y0 + 2.4, cz + 1.3, 'metalDark');
    k.box('fan-blade', cx - 1.3, y0 + 1.4, cz + 2.5, cx + 1.3, y0 + 2.4, cz + L, 'metalDark');
    k.box('fan-blade', cx - 1.3, y0 + 1.4, cz - L, cx + 1.3, y0 + 2.4, cz - 2.5, 'metalDark');
    // 斜めの羽根(階段状の3片 x 4)
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        for (let i = 0; i < 3; i++) {
          const d = 3.4 + i * 2.2;
          const x0 = sx > 0 ? cx + d : cx - d - 2.4;
          const z0 = sz > 0 ? cz + d : cz - d - 2.4;
          const dy = i % 2 ? 0.1 : 0; // 隣り合う片の上下面を少しずらして同一平面の重なりを避ける
          k.box('fan-blade', x0, y0 + 1.5 - dy, z0, x0 + 2.4, y0 + 2.3 + dy, z0 + 2.4, 'metalDark');
        }
      }
    }
    // 天井からの吊り柱(4隅)
    for (const [dx, dz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      const px = cx + dx * (R - 1);
      const pz = cz + dz * (R - 1);
      if (px - 1 < WX0 || px + 1 > WX1 || pz - 1 < WZ0 || pz + 1 > WZ1) continue;
      k.pillar('fan-hanger', px, pz, 2, y0 + H, T, 'metalDark');
    }
  };
  fan(224, 222, 18, 12);
  fan(224, 258, 18, 12);
  // ファン間の保守梁と、ファン直下の橙の警告灯
  k.box('fan-girder', WX0, 19, 234, 236, 20.6, 246, 'metalDark');
  k.box('fan-lamp', 224 - 3, 17.4, 231.4, 224 + 3, 18, 233.4, 'hazard', { emissive: 0.9 });
  k.box('fan-lamp', 224 - 3, 17.4, 246.6, 224 + 3, 18, 248.6, 'hazard', { emissive: 0.9 });

  // ------------------------------------------------------------------ 北東: 主排気ダクト(全高) + 支線
  k.box('stack', 252, F, WZ0, 266, T, 232, 'metal');
  for (const y of [-10, -2, 6, 14, 20]) {
    k.box('stack-rib', 251.2, y, WZ0, 266.8, y + 1.2, 232.8, 'metalDark');
  }
  k.box('stack-base', 250, F, WZ0, 268, F + 3, 234, 'hazard');
  k.box('stack-lamp', 253, -6, 232, 257, -4.8, 232.6, 'lightPanel', { emissive: 1 });
  k.box('stack-lamp', 260, -6, 232, 264, -4.8, 232.6, 'lightPanel', { emissive: 1 });
  // 主管に入る太い支線ダクト(東壁沿い、張り出しの下まで)
  k.box('branch', 266, F + 3, 232, 268, 8, 250, 'pipe');
  k.pipe('branch-vent', 'z', 262, F + 6, 232, 265, F + 9, 251, 'pipe');
  // 錆びたダクト継ぎ手と垂れ下がりの補修跡
  k.decor('stack-patch', 252, 2, 232, 258, 6, 232.15, 'rust');
  k.decor('stack-patch', 260, -9.5, 232, 265, -7, 232.15, 'rust');

  // ------------------------------------------------------------------ 北壁・西壁: 格子の足場と全高の縦配管
  // 西壁の足場(-4 と +6)、ルートの折れ線と扉の前を避けて z226 より南に
  for (const y of [-4, 6]) {
    k.box(`gantry-w`, WX0, y - 0.9, 226, 217.5, y, 276, 'grating');
    k.box(`gantry-w-rail`, 217, y, 226, 217.5, y + 1.1, 276, 'metal');
  }
  for (const z of [228, 250, 275.6]) {
    k.pillar('gantry-w-col', 214.5, z, 1.6, F, -4.9, 'metalDark');
  }
  for (const z of [239, 265]) {
    k.box('gantry-w-brace', WX0, 6 - 1.9, z - 0.8, 217.5, 6 - 0.9, z + 0.8, 'metal');
  }
  // 北壁の足場(-2)。x 226..250 は降下帯なので東寄りの短い足場に限る
  k.box('gantry-n', 236, -2.9, WZ0, 251, -2, 205.6, 'grating');
  k.box('gantry-n-rail', 236, -2, 205.1, 251, -0.9, 205.6, 'metal');
  // 縦配管 (北壁)
  for (let i = 0; i < 4; i++) {
    const x = 222 + i * 3.6;
    k.pipe('riser', 'y', x, F, WZ0, x + 1.6, T, WZ0 + 1.6, i % 2 ? 'pipe' : 'metalDark');
  }
  k.box('riser-clamp', 221.4, -6, WZ0, 236.2, -5.4, WZ0 + 2.2, 'metal');
  k.box('riser-clamp', 221.4, 8, WZ0, 236.2, 8.6, WZ0 + 2.2, 'metal');
  k.box('riser-clamp', 221.4, 20, WZ0, 236.2, 20.6, WZ0 + 2.2, 'metal');
  // 南壁の縦配管(換気機械から立ち上がる)
  for (let i = 0; i < 3; i++) {
    const x = 226 + i * 4;
    k.pipe('riser-s', 'y', x, F + 5, WZ1 - 1.8, x + 1.8, T, WZ1, 'pipe');
  }

  // ------------------------------------------------------------------ 南西: 換気機械群 / 南東: ポンプ室(張り出しの下)
  const unit = (x: number, z: number, w: number, d: number, h: number): void => {
    k.fbox('unit', x, z, x + w, z + d, h, 'machine');
    k.fbox('unit-base', x - 0.6, z - 0.6, x + w + 0.6, z + d + 0.6, 0.7, 'hazard');
    k.pipe('unit-out', 'y', x + w / 2 - 1.4, F + h, z + d / 2 - 1.4, x + w / 2 + 1.4, F + h + 12, z + d / 2 + 1.4, 'pipe');
  };
  unit(214, 252, 12, 10, 4.5);
  unit(214, 264, 12, 10, 4.5);
  unit(232, 262, 9, 12, 3.5);
  // ポンプ室(張り出しの下、支柱と梁の間): 低い機械と配管
  k.fbox('pump', 255, 252, 262, 258, 3, 'machine');
  k.fbox('pump', 250, 266, 262, 272, 3, 'machine');
  k.pipe('pump-line', 'x', 250, F + 3, 259.5, 264, F + 4.8, 261.3, 'pipe');
  k.fbox('pump-tank', 262, 259, 266, 263.5, 5.5, 'rust'); // 錆びた小型タンク
  k.crate('pump-crate', 257, 274.5, 3.5, 3, 2.5, 'crate');

  // ------------------------------------------------------------------ 縦の非常灯 (深さの目盛り): 北壁・南壁・西壁
  for (const y of [22, 14, 6, -2, -10]) {
    k.box('shaft-lamp', 238, y, WZ0, 243, y + 1.2, WZ0 + 0.5, 'lightPanel', { emissive: 1 });
    k.box('shaft-lamp', 246, y, WZ1 - 0.5, 251, y + 1.2, WZ1, 'glass', { emissive: 0.9 });
  }
  for (const y of [16, 8, 0, -8]) {
    k.box('shaft-lamp', WX0, y, 268, WX0 + 0.5, y + 1.2, 273, 'glass', { emissive: 0.9 });
  }
  // 降下の目安: 縁から見える底の着地標示(床の光る帯 = 装飾)
  k.decor('pad-glow', 226, F, 222, 250, F + 0.08, 224, 'hazard', { emissive: 0.9 });
  k.decor('pad-glow', 226, F, 240, 250, F + 0.08, 242, 'hazard', { emissive: 0.9 });
  k.decor('pad-line', 226, F, 224, 227.6, F + 0.06, 240, 'hazard');
  k.decor('pad-line', 248.4, F, 224, 250, F + 0.06, 240, 'hazard');
  k.decor('pad-light', 232, F, 231, 244, F + 0.08, 233, 'lightPanel', { emissive: 1 });
  // 底の扉(P10)の前の誘導灯
  k.decor('door-guide', 213, F, 209, 217, F + 0.06, 210.4, 'hazard', { emissive: 0.8 });
  k.decor('door-guide', 213, F, 217.6, 217, F + 0.06, 219, 'hazard', { emissive: 0.8 });

  // ------------------------------------------------------------------ 追加: 吸気ダクト・警備小屋・瓦礫・吊り足場(ゴンドラ)
  // 主排気ダクトの西面から北壁に沿って伸びる吸気ダクト(ファンの間へ)
  k.box('intake-duct', 235, 15.5, WZ0, 252, 19, 209, 'metal');
  k.box('intake-rib', 236, 15.5, 209, 237, 19, 210, 'metalDark');
  k.box('intake-rib', 243.5, 15.5, 209, 244.5, 19, 210, 'metalDark');
  k.box('intake-rib', 250.5, 15.5, 209, 251.5, 19, 210, 'metalDark');
  k.box('intake-lamp', 239, 19, 203, 244, 19.6, 208, 'hazard', { emissive: 0.9 });
  // 底の警備小屋(降下帯の北東の縁): 光る窓が着地点の目印
  k.fbox('kiosk', 243, 204, 250, 210, 3.4, 'machine');
  k.box('kiosk-glass', 243.8, F + 1.4, 210, 249.2, F + 3, 210.5, 'glass', { emissive: 0.9 });
  k.box('kiosk-beacon', 245, F + 3.4, 205, 248, F + 4.2, 208, 'hazard', { emissive: 1 });
  // 底の瓦礫(降下帯の縁)
  k.fbox('rubble', 244, 218, 250, 224, LOWH, 'concreteDark');
  k.fbox('rubble', 246, 236, 251, 242, 2.4, 'rust');
  k.box('rubble-beam', 244, F + LOWH, 220, 250, F + LOWH + 1.2, 221.4, 'rust'); // 落ちた梁
  // 吊り足場(ゴンドラ): 天井から4本のケーブルで垂れ下がる保守用の足場
  for (const [x, z] of [[227, 264], [237, 264], [227, 272], [237, 272]] as [number, number][]) k.box('gondola-cable', x - 0.4, 7, z - 0.4, x + 0.4, T, z + 0.4, 'metalDark');
  k.box('gondola', 226, 6, 263, 238.4, 7, 273.4, 'grating');
  k.box('gondola-rail', 226, 7, 263, 238.4, 8.2, 263.5, 'metal');
  k.box('gondola-rail', 226, 7, 272.9, 238.4, 8.2, 273.4, 'metal');
  k.box('gondola-lamp', 229, 5.4, 266, 235, 6, 270, 'lightPanel', { emissive: 1 });

  // ================================================================== 経年の汚れ (装飾のみ・衝突なし): 壁の錆の筋・パネル・裾の汚れ、床のしみとひび
  let seed = 0x5a10;
  const rnd = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  let di = 0;
  const thick = (): number => 0.03 + (di++ % 6) * 0.02; // 重なる装飾の面が同一平面にならないよう厚みを変える(最大0.13m)
  type Face = 'n' | 's' | 'w' | 'e';
  const excl: Record<Face, [number, number, number, number][]> = {
    n: [],
    s: [],
    w: [[205.5, 222.5, -15, -4.5]],
    e: [[257.5, 274.5, 10.5, 21.5]],
  };
  const wallPatch = (f: Face, u0: number, u1: number, y0: number, y1: number, mat: MaterialKey): void => {
    if (excl[f].some((r) => u1 > r[0] && u0 < r[1] && y1 > r[2] && y0 < r[3])) return;
    const t = thick();
    if (f === 'n') k.decor('grime', u0, y0, 202, u1, y1, 202 + t, mat);
    else if (f === 's') k.decor('grime', u0, y0, 278 - t, u1, y1, 278, mat);
    else if (f === 'w') k.decor('grime', 212, y0, u0, 212 + t, y1, u1, mat);
    else k.decor('grime', 268 - t, y0, u0, 268, y1, u1, mat);
  };
  for (const [f, lo, hi] of [['n', 212, 268], ['s', 212, 268], ['w', 202, 278], ['e', 202, 278]] as [Face, number, number][]) {
    const len = hi - lo;
    // 錆の筋(縦)
    for (let i = 0; i < Math.round(len / 4); i++) {
      const w = 0.7 + rnd() * 1.8;
      const u = lo + rnd() * (len - w);
      const y1 = -14 + (26 - -14) * (0.3 + rnd() * 0.7);
      wallPatch(f, u, u + w, Math.max(-14, y1 - (4 + rnd() * 14)), y1, rnd() < 0.62 ? 'rust' : 'concreteDark');
    }
    // 暗い板(設備パネル跡)
    for (let i = 0; i < Math.round(len / 8); i++) {
      const w = 4 + rnd() * 8;
      const u = lo + rnd() * (len - w);
      const y0 = -14 + 1 + rnd() * (26 - -14 - 9);
      wallPatch(f, u, u + w, y0, y0 + 2.5 + rnd() * 3.5, rnd() < 0.5 ? 'metalDark' : 'concreteDark');
    }
    // 警告の帯(破線)
    for (let u = lo + 3; u < hi - 9; u += 18) wallPatch(f, u, u + 9, -14 + 3.0, -14 + 3.0 + 0.6, 'hazard');
    // 裾の汚れ
    for (let u = lo; u < hi - 1; u += 10) wallPatch(f, u, Math.min(hi, u + 10), -14, -14 + 1.4 + rnd() * 0.8, 'concreteDark');
  }
  // 床のしみ(油・錆・焼け)とひび
  for (let i = 0; i < 26; i++) {
    const w = 1.5 + rnd() * 6;
    const d = 1.5 + rnd() * 6;
    const t = 0.02 + (di++ % 7) * 0.005;
    const c = rnd();
    const sx = 212 + rnd() * (268 - 212 - w);
    const sz = 202 + rnd() * (278 - 202 - d);
    k.decor('stain', sx, -14, sz, sx + w, -14 + t, sz + d, c < 0.55 ? 'roof' : c < 0.85 ? 'rust' : 'concreteDark');
  }
  for (let i = 0; i < 26; i++) {
    const along = 4 + rnd() * 10;
    const t = 0.02 + (di++ % 7) * 0.005;
    const alongX = rnd() < 0.5;
    const cx = 212 + rnd() * (268 - 212 - along);
    const cz = 202 + rnd() * (278 - 202 - along);
    if (alongX) k.decor('crack', cx, -14, cz, cx + along, -14 + t, cz + 0.22, 'roof');
    else k.decor('crack', cx, -14, cz, cx + 0.22, -14 + t, cz + along, 'roof');
  }
}
