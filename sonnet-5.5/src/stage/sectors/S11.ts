/**
 * S11 地下搬送区画 (corridor, 地下-14, 戦闘): 天井に梁と配管の格子を張った地下の貨物ヤード。昇降C4(-14→0)で地上高さの搬出ギャラリーへ。制御B4(T11)が南の隔壁(P11)を監視。
 *
 * 配置 (内寸 x82..208 / z142..278, 床-14, 天井12):
 *  - 中央 ARENA_CLEAR(x90..200,z150..212)は空けた床(軌道の装飾線・標示帯だけ)。周囲に低(1.2)/中(2.5)/高(6)の掩蔽物。
 *  - 北東の隅: 機械の基壇(2.5)+砲台の台座で高さ+8mの制御砲台T11。東壁沿いの変圧器の壁(6m)が入口(P10)からT11への射線を切る。
 *  - 南: 貨車の列(ボックス車=高、平台車+積荷=中、機関車)が2本の線路に並ぶ貨物ヤード。中央にC4の離陸位置(138,-14,256)の広い空き。
 *  - 南西: コンテナの塔(7.5m)と積み。西壁沿いの低い凹みが「狙撃位置」(制御砲台から遠く、コンテナの陰から覗く)。
 *  - ギャラリー(C4の着地足場 y=0, x82..130 z240..278): 橋脚の格子と梁。手すりなし(縁の警告帯のみ)。
 *  - 天井(y6.4..12): 主梁・横梁・吊り灯・配管。垂れ下がる配管は y>=-8 (床上6m以上)にとどめる。
 *  昇降C4: 離陸柱(x135..141,z253..259)と飛行コリドー、ルート折れ線((154,-8.5,220)→(132,1.5,242)→(98,1.5,276))は空けてある。
 */
import type { MaterialKey } from '../../sim/types';
import type { Kit } from '../kit';

export function build(k: Kit): void {
  const F = k.floorY; // -14
  const T = k.ceilingY; // 12
  const X0 = k.inner.x0; // 82
  const X1 = k.inner.x1; // 208
  const Z0 = k.inner.z0; // 142
  const Z1 = k.inner.z1; // 278
  const LOW = 1.2;
  const MID = 2.5;
  const HIGH = 6;

  // ================================================================== 昇降C4 の足場(着地側 y=0)と橋脚
  k.climbPads('C4', [[84, 242], [84, 276], [128, 276], [106, 242], [106, 276], [128, 242]]);
  // 橋脚の梁(y -9.2..-8): 脚と脚をつなぐ
  for (const y of [-9.2, -3.2]) {
    k.box('viaduct-beam', 84, y, 241.4, 128, y + 1.2, 242.6, 'metal');
    k.box('viaduct-beam', 84, y, 275.4, 128, y + 1.2, 276.6, 'metal');
    k.box('viaduct-beam', 83.4, y, 242, 84.6, y + 1.2, 276, 'metal');
    k.box('viaduct-beam', 105.4, y, 242, 106.6, y + 1.2, 276, 'metal');
    k.box('viaduct-beam', 127.4, y, 242, 128.6, y + 1.2, 276, 'metal');
  }
  // ギャラリーの縁の警告帯と、下面(y-2)の青白い灯 (橋脚の間で足場の縁が識別できる)
  k.decor('pad-edge', 82, 0, 240, 130, 0.05, 241.4, 'hazard');
  k.decor('pad-edge', 128.6, 0, 241.4, 130, 0.05, 278, 'hazard');
  k.box('pad-lamp', 96, -2.6, 240, 104, -2, 240.6, 'glass', { emissive: 0.9 });
  k.box('pad-lamp', 114, -2.6, 240, 122, -2, 240.6, 'glass', { emissive: 0.9 });
  k.box('pad-lamp', 129.4, -2.6, 246, 130, -2, 254, 'glass', { emissive: 0.9 });
  k.box('pad-lamp', 129.4, -2.6, 262, 130, -2, 270, 'glass', { emissive: 0.9 });
  // ギャラリーの西の縁の機器(手すりではない低い機械 1.2m)
  k.fbox('gallery-cab', 82, 246, 86, 258, LOW, 'machine', 0);
  k.fbox('gallery-cab', 82, 262, 86, 270, LOW, 'metalDark', 0);
  // 出口(P11)の上の案内灯 (隔壁が開くとこの色が目印になる)
  k.box('exit-lamp', 86, 8.6, 277.4, 98, 9.6, 278, 'hazard', { emissive: 0.9 });
  k.decor('exit-frame', 84.4, 0.05, 277.85, 85, 8.6, 278, 'hazard');
  k.decor('exit-frame', 99, 0.05, 277.85, 99.6, 8.6, 278, 'hazard');

  // ================================================================== 天井: 主梁・横梁・吊り灯・配管 (y 6.4..12)
  for (const z of [152, 176, 200, 224, 248, 272]) k.box('girder', X0, 8, z - 1.5, X1, T, z + 1.5, 'metalDark');
  for (const x of [104, 134, 164, 194]) k.box('cross-beam', x - 1, 6.4, Z0, x + 1, 8, Z1, 'metal');
  for (const x of [104, 134, 164, 194]) {
    for (const z0 of [156, 196, 236]) k.box('ceiling-lamp', x - 0.9, 5.8, z0, x + 0.9, 6.4, z0 + 8, 'lightPanel', { emissive: 1 });
  }
  for (const z of [164, 212, 260]) {
    k.pipe('duct', 'x', X0, 5.6, z - 1, X1, 7.6, z + 1, 'pipe');
    k.pipe('duct', 'x', X0, 6, z + 4, X1, 7.8, z + 5.8, 'rust');
  }
  // 垂れ下がる配管(梁から。先端は床上6m以上): 折れて垂れた配管と外れた吊り金具
  k.pipe('hang', 'y', 141, -6, 163.2, 142.6, 6.4, 164.8, 'pipe');
  k.pipe('hang', 'y', 172, -5, 211.2, 173.4, 6.4, 212.6, 'rust');
  k.pipe('hang', 'y', 110, -7.5, 211.2, 111.6, 6.4, 212.8, 'pipe');

  // ================================================================== 柱列 (全高)
  const column = (x: number, z: number): void => {
    k.pillar('pillar', x, z, 3);
    k.fbox('pillar-base', x - 2.2, z - 2.2, x + 2.2, z + 2.2, LOW, 'hazard');
    k.box('pillar-lamp', x - 1.2, F + 5, z + 1.5, x + 1.2, F + 6, z + 2.1, 'lightPanel', { emissive: 1 });
  };
  for (const [x, z] of [[118, 146], [146, 146], [104, 232], [150, 246], [204, 250]] as [number, number][]) column(x, z);

  // ================================================================== 北東: 制御砲台T11(高台座 +8m) と入口を隠す変圧器の壁
  k.fbox('t11-plinth', 184, Z0, X1, 150, MID, 'machine');
  k.fbox('t11-plinth-band', 183.4, Z0, 184, 150, LOW, 'hazard');
  k.turret(196, 146, 5.5, { baseY: F + MID, control: 3, face: [92, 279] });
  // 制御砲台の目印: 基壇から天井まで立つ電波塔(遠くから見える橙の灯)
  k.box('t11-mast', 201, F + MID, 143.6, 202.4, T, 145, 'metalDark');
  for (const y of [F + 12, F + 19]) k.box('t11-mast-lamp', 200.2, y, 143.2, 203.2, y + 1.6, 145.4, 'hazard', { emissive: 1 });
  k.box('t11-beacon', 192, F + 5, 148.5, 200, F + 6, 149.1, 'hazard', { emissive: 1 });
  k.box('t11-beacon', 192, F + 5, 143, 200, F + 6, 143.6, 'hazard', { emissive: 1 });
  // 東壁沿いの変圧器の壁(高6m): 入口(P10)からT11への射線を切る
  k.fbox('trafo', 200.5, 172, X1, 196, HIGH, 'machine');
  for (const z of [174, 180, 186, 192]) k.decor('trafo-fin', 200.35, F + 0.4, z, 200.5, F + 5.6, z + 2.4, 'metalDark');
  k.box('trafo-lamp', 199.8, F + 3.5, 181, 200.5, F + 4.5, 189, 'lightPanel', { emissive: 1 });
  k.decor('trafo-hazard', 200.5, F + 0.4, 171.85, X1, F + 1.6, 172, 'hazard');

  // ================================================================== 北面の設備 (z142..150, 低・中・高)
  k.fbox('north-cab', 88, Z0, 100, 149, MID, 'machine');
  // 北帯の操作室(ガラス張り): 低い基台(中2.5) + ガラス + 屋根
  k.fbox('booth', 124, Z0 + 1, 138, 149, MID, 'machine');
  k.box('booth-glass', 124.6, F + MID, Z0 + 1.6, 137.4, F + MID + 3, 148.4, 'glass');
  k.box('booth-roof', 124, F + MID + 3, Z0 + 1, 138, F + MID + 3.6, 149, 'metal');
  k.box('booth-lamp', 128, F + MID + 3.6, 144, 134, F + MID + 4.2, 146, 'hazard', { emissive: 0.9 });
  k.box('booth-console', 126, F, 149, 134, F + 1.4, 150, 'machine', { emissive: 0.6 });
  k.fbox('north-cab', 152, Z0, 164, 149, HIGH, 'concreteDark');
  k.fbox('buffer', 166, Z0, 170, 146, MID, 'hazard'); // 南北の線路(x168)の終端の車止め
  // 崩れた梁: 瓦礫の山2つに掛かる
  k.fbox('rubble', 100, 143.5, 104, 148.5, LOW, 'concreteDark');
  k.fbox('rubble', 110, 143.5, 114, 148.5, LOW, 'concreteDark');
  k.box('fallen-beam', 100, F + LOW, 145, 116, F + LOW + 1.4, 146.4, 'rust');

  // ================================================================== 西: 狙撃位置(コンテナの塔と凹み)
  // 塔A(7.5m)が北東からの射線を切り、その南端の脇から覗く。塔B(中)は凹みの南を閉じる。
  k.fbox('tower', 82, 196, 90, 200, HIGH + 1.5, 'crate');
  k.fbox('nest-low', 82, 205, 88, 207, LOW, 'concreteDark');
  k.fbox('nest-stack', 84, 219, 92, 224, MID, 'crate');
  k.fbox('nest-stack', 84, 226, 92, 230, HIGH + 1.5, 'crate');
  k.box('nest-lamp', 82, F + 4.5, 212, 82.6, F + 5.5, 218, 'glass', { emissive: 0.9 });
  // 西壁沿いの資材(北): 積まれた鋼材と傾いた棚の残骸
  k.fbox('west-rack', 82, 152, 86, 170, MID, 'metalDark');
  k.fbox('west-rack', 82, 172, 86, 176, HIGH, 'rust');
  k.fbox('west-slump', 86, 154, 88, 168, LOW, 'rust');

  // ================================================================== 南西: コンテナヤード (高さは 中2.5 と 塔7.5 のみ。C4離陸位置の周囲は 4m台の踏み台を作らない)
  const container = (name: string, x: number, z: number, w: number, d: number, h: number): void => {
    k.fbox(name, x, z, x + w, z + d, h, 'crate');
  };
  container('yard-box', 94, 236, 12, 3, MID);
  container('yard-tower', 112, 228, 12, 3, HIGH + 1.5);
  container('yard-box', 108, 214, 12, 3, MID);

  // ================================================================== 南: 貨車の列 (線路は南北: x=168 と x=192。先頭はトンネル口(南壁)へ向く)
  const boxcar = (x: number, z: number, mat: MaterialKey = 'metalDark'): void => {
    // 車体(高6m) + 台車(2) + 屋根板
    k.box('boxcar', x - 1.8, F + 1, z, x + 1.8, F + HIGH, z + 14, mat);
    k.box('boxcar-truck', x - 1.2, F, z + 1.5, x + 1.2, F + 1, z + 4.5, 'metal');
    k.box('boxcar-truck', x - 1.2, F, z + 9.5, x + 1.2, F + 1, z + 12.5, 'metal');
    k.box('boxcar-roof', x - 1.4, F + HIGH, z + 0.6, x + 1.4, F + HIGH + 0.6, z + 13.4, 'rust');
  };
  const flatcar = (x: number, z: number, loaded: boolean): void => {
    k.box('flatcar', x - 1.8, F + 0.5, z, x + 1.8, F + LOW, z + 14, 'metal');
    k.box('flatcar-truck', x - 1.2, F, z + 1.5, x + 1.2, F + 0.5, z + 4.5, 'metalDark');
    k.box('flatcar-truck', x - 1.2, F, z + 9.5, x + 1.2, F + 0.5, z + 12.5, 'metalDark');
    if (loaded) {
      k.box('flat-load', x - 1.5, F + LOW, z + 1, x + 1.5, F + MID, z + 6, 'crate');
      k.box('flat-load', x - 1.5, F + LOW, z + 8, x + 1.5, F + MID, z + 13, 'crate');
    }
  };
  const loco = (x: number, z: number): void => {
    // 機関車: 長い機関室(中) と 運転台(高)。先頭(南)へ向く
    k.box('loco-cab', x - 1.8, F + 1, z, x + 1.8, F + HIGH, z + 6, 'metalDark');
    k.box('loco-hood', x - 1.8, F + 1, z + 6, x + 1.8, F + MID, z + 14, 'machine');
    k.box('loco-truck', x - 1.2, F, z + 1.5, x + 1.2, F + 1, z + 5, 'metal');
    k.box('loco-truck', x - 1.2, F, z + 9.5, x + 1.2, F + 1, z + 12.5, 'metal');
    k.pipe('loco-stack', 'y', x - 0.7, F + MID, z + 9, x + 0.7, F + 5, z + 10.4, 'pipe');
    k.box('loco-light', x - 1, F + 1.8, z + 14, x + 1, F + 2.5, z + 14.6, 'lightPanel', { emissive: 1 });
  };
  // 線路W (x=168): 平台車(積荷) + ボックス車 | 機関車
  flatcar(168, 224, true);
  boxcar(168, 240);
  loco(168, 262);
  // 線路E (x=192): ボックス車 | 平台車(積荷) + ボックス車
  boxcar(192, 228, 'rust');
  flatcar(192, 250, true);
  boxcar(192, 264);
  // 連結器(線路W)
  k.box('coupler', 167, F + 1.4, 238, 169, F + 2.4, 240, 'metalDark');
  // 車止めと信号灯
  k.box('signal', 175, F, 224, 176.4, F + 4.5, 225.4, 'metalDark');
  k.box('signal-lamp', 174.6, F + 4.5, 223.8, 176.8, F + 5.3, 225.6, 'hazard', { emissive: 1 });
  k.box('signal', 199, F, 224, 200.4, F + 4.5, 225.4, 'metalDark');
  k.box('signal-lamp', 198.6, F + 4.5, 223.8, 200.8, F + 5.3, 225.6, 'glass', { emissive: 1 });

  // ================================================================== 追加: ギャラリー下の機械・樽・崩落した覆工
  k.fbox('gallery-machine', 108, 262, 126, 272, MID, 'machine');
  k.fbox('gallery-machine', 88, 250, 102, 258, LOW, 'metalDark');
  k.fbox('gallery-machine-base', 107.4, 261.4, 126.6, 272.6, 0.6, 'hazard');
  const barrels = (cx: number, cz: number, n: number, mat: MaterialKey): void => {
    for (let i = 0; i < n; i++) {
      const x = cx + (i % 3) * 1.5;
      const z = cz + Math.floor(i / 3) * 1.5;
      k.pipe('barrel', 'y', x - 0.65, F, z - 0.65, x + 0.65, F + 1.7, z + 0.65, i % 4 === 0 ? 'hazard' : mat);
    }
  };
  barrels(84, 232, 4, 'rust');
  barrels(202, 268, 5, 'metal');
  barrels(84, 145, 4, 'rust');
  // 南壁沿いの崩落した覆工(瓦礫)とトンネル口の脇の資材
  k.fbox('lining-rubble', 178, 268, 184, 276, MID, 'concreteDark');
  k.fbox('lining-rubble', 202, 272, 207, 277, LOW, 'concreteDark');
  k.box('lining-slab', 176, F + MID, 270, 184, F + MID + 1.2, 273, 'rust');

  // ================================================================== 装飾: 軌道(床の線)・標示帯・壁の設備・トンネル口
  // 線路(床面の装飾): 道床 + 2本のレール。南北(x=168, 192)と東西(z=180)
  const trackZ = (x: number): void => {
    k.decor('bed', x - 2, F, Z0, x + 2, F + 0.06, Z1, 'concreteDark');
    k.decor('rail', x - 0.95 - 0.12, F + 0.06, Z0, x - 0.95 + 0.12, F + 0.15, Z1, 'metal');
    k.decor('rail', x + 0.95 - 0.12, F + 0.06, Z0, x + 0.95 + 0.12, F + 0.15, Z1, 'metal');
  };
  trackZ(168);
  trackZ(192);
  k.decor('bed', X0, F, 178, X1, F + 0.06, 182, 'concreteDark');
  k.decor('rail', X0, F + 0.06, 179.05 - 0.12, X1, F + 0.15, 179.05 + 0.12, 'metal');
  k.decor('rail', X0, F + 0.06, 180.95 - 0.12, X1, F + 0.15, 180.95 + 0.12, 'metal');
  // アリーナ周りの標示帯
  k.decor('arena-line', 90, F, 149.6, 200, F + 0.07, 150, 'hazard');
  k.decor('arena-line', 90, F, 212, 200, F + 0.07, 212.4, 'hazard');
  // 入口(P10)の前: 誘導の帯と灯
  k.decor('door-guide', 202, F, 206.4, 207.6, F + 0.07, 207, 'hazard', { emissive: 0.8 });
  k.decor('door-guide', 202, F, 221, 207.6, F + 0.07, 221.6, 'hazard', { emissive: 0.8 });
  k.box('door-lamp', 207.4, -5.4, 208, 208, -4.4, 220, 'lightPanel', { emissive: 1 });
  // 南壁のトンネル口(線路の終端): 暗い口 + 枠
  for (const [x0, x1] of [[160, 176], [184, 200]] as [number, number][]) {
    k.decor('tunnel', x0, F, 277.85, x1, F + 9, 278, 'metalDark');
    k.decor('tunnel-frame', x0 - 0.8, F, 277.85, x0, F + 9.8, 278, 'hazard');
    k.decor('tunnel-frame', x1, F, 277.85, x1 + 0.8, F + 9.8, 278, 'hazard');
    k.decor('tunnel-frame', x0 - 0.8, F + 9, 277.85, x1 + 0.8, F + 9.8, 278, 'hazard');
  }
  // 壁の配管ラック(北壁・西壁・東壁: 壁面に密着)
  for (const z of [156, 180, 204]) k.decor('wall-pipes', X0, -6, z, X0 + 0.15, -4.4, z + 14, 'pipe');
  for (const x of [100, 130, 160]) k.decor('wall-pipes', x, -6, Z0, x + 14, -4.4, Z0 + 0.15, 'pipe');

  // 転車台(床の装飾): 南北の線路と東西の線路の交差
  for (const x of [168, 192]) {
    k.decor('turntable', x - 6, F, 174, x + 6, F + 0.075, 186, 'metalDark');
    k.decor('turntable-rim', x - 6, F, 174, x + 6, F + 0.09, 174.5, 'hazard');
    k.decor('turntable-rim', x - 6, F, 185.5, x + 6, F + 0.09, 186, 'hazard');
    k.decor('turntable-rim', x - 6, F, 174.5, x - 5.5, F + 0.09, 185.5, 'hazard');
    k.decor('turntable-rim', x + 5.5, F, 174.5, x + 6, F + 0.09, 185.5, 'hazard');
  }
  // 貨車の側面の装飾(引き戸の枠・補強リブ・錆)
  for (const [x, z] of [[168, 240], [192, 228], [192, 264]] as [number, number][]) {
    for (const sx of [-1, 1]) {
      const fx = sx > 0 ? x + 1.8 : x - 1.95;
      k.decor('car-door', fx, F + 1.6, z + 3, fx + 0.15, F + 5.4, z + 8, 'metal');
      k.decor('car-rib', fx, F + 1.2, z + 0.5, fx + 0.1, F + 5.8, z + 1, 'metalDark');
      k.decor('car-rib', fx, F + 1.2, z + 13, fx + 0.1, F + 5.8, z + 13.5, 'metalDark');
      k.decor('car-rust', fx, F + 3.2, z + 9, fx + 0.12, F + 5.8, z + 12.5, 'rust');
    }
  }

  // 昇降の離陸・着地の目印(床の標示と光る帯): 通行可能空間に浮かぶものはない(標示は床/足場の面の上の装飾)
  const padMark = (cx: number, cz: number, y: number, r: number): void => {
    const h = 0.07;
    k.decor('pad-mark', cx - r, y, cz - r, cx + r, y + h, cz - r + 0.5, 'hazard');
    k.decor('pad-mark', cx - r, y, cz + r - 0.5, cx + r, y + h, cz + r, 'hazard');
    k.decor('pad-mark', cx - r, y, cz - r + 0.5, cx - r + 0.5, y + h, cz + r - 0.5, 'hazard');
    k.decor('pad-mark', cx + r - 0.5, y, cz - r + 0.5, cx + r, y + h, cz + r - 0.5, 'hazard');
    for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const px = cx + dx * (r - 1.6);
      const pz = cz + dz * (r - 1.6);
      k.decor('pad-light', px - 0.6, y, pz - 0.6, px + 0.6, y + 0.09, pz + 0.6, 'lightPanel', { emissive: 1 });
    }
  };
  padMark(138, 256, F, 5); // C4 離陸(接地して回復できる床)
  padMark(122, 256, 0, 4); // C4 着地 / ギャラリー
  // C4 離陸位置の脇の灯柱(離陸柱x135..141の外)
  for (const x of [130.6, 143.6]) {
    k.box('c4-post', x, F, 249.6, x + 1.4, F + 7, 251, 'metalDark');
    k.box('c4-post-lamp', x - 0.4, F + 7, 249.2, x + 1.8, F + 8.2, 251.4, 'lightPanel', { emissive: 1 });
  }

  // ================================================================== 警備 2
  k.guard(122, 186, { face: [190, 214], patrol: [{ x: 122, y: F + 1.5, z: 186 }, { x: 110, y: F + 1.5, z: 168 }, { x: 150, y: F + 1.5, z: 160 }, { x: 140, y: F + 1.5, z: 190 }] });
  k.guard(178, 246, { face: [170, 214], patrol: [{ x: 178, y: F + 1.5, z: 246 }, { x: 140, y: F + 1.5, z: 246 }, { x: 138, y: F + 1.5, z: 226 }, { x: 176, y: F + 1.5, z: 222 }] });

  // ================================================================== 経年の汚れ (装飾のみ・衝突なし): 壁の錆の筋・パネル・裾の汚れ、床のしみとひび
  let seed = 0x5a11;
  const rnd = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  let di = 0;
  const thick = (): number => 0.03 + (di++ % 6) * 0.02; // 重なる装飾の面が同一平面にならないよう厚みを変える(最大0.13m)
  type Face = 'n' | 's' | 'w' | 'e';
  const excl: Record<Face, [number, number, number, number][]> = {
    n: [],
    s: [[83, 101, -15, 9.5], [158, 202, -15, -3.5]],
    w: [],
    e: [[205.5, 222.5, -15, -4.5]],
  };
  const wallPatch = (f: Face, u0: number, u1: number, y0: number, y1: number, mat: MaterialKey): void => {
    if (excl[f].some((r) => u1 > r[0] && u0 < r[1] && y1 > r[2] && y0 < r[3])) return;
    const t = thick();
    if (f === 'n') k.decor('grime', u0, y0, 142, u1, y1, 142 + t, mat);
    else if (f === 's') k.decor('grime', u0, y0, 278 - t, u1, y1, 278, mat);
    else if (f === 'w') k.decor('grime', 82, y0, u0, 82 + t, y1, u1, mat);
    else k.decor('grime', 208 - t, y0, u0, 208, y1, u1, mat);
  };
  for (const [f, lo, hi] of [['n', 82, 208], ['s', 82, 208], ['w', 142, 278], ['e', 142, 278]] as [Face, number, number][]) {
    const len = hi - lo;
    // 錆の筋(縦)
    for (let i = 0; i < Math.round(len / 5); i++) {
      const w = 0.7 + rnd() * 1.8;
      const u = lo + rnd() * (len - w);
      const y1 = -14 + (12 - -14) * (0.3 + rnd() * 0.7);
      wallPatch(f, u, u + w, Math.max(-14, y1 - (4 + rnd() * 14)), y1, rnd() < 0.62 ? 'rust' : 'concreteDark');
    }
    // 暗い板(設備パネル跡)
    for (let i = 0; i < Math.round(len / 10); i++) {
      const w = 4 + rnd() * 8;
      const u = lo + rnd() * (len - w);
      const y0 = -14 + 1 + rnd() * (12 - -14 - 9);
      wallPatch(f, u, u + w, y0, y0 + 2.5 + rnd() * 3.5, rnd() < 0.5 ? 'metalDark' : 'concreteDark');
    }
    // 警告の帯(破線)
    for (let u = lo + 3; u < hi - 9; u += 18) wallPatch(f, u, u + 9, -14 + 2.8, -14 + 2.8 + 0.6, 'hazard');
    // 裾の汚れ
    for (let u = lo; u < hi - 1; u += 10) wallPatch(f, u, Math.min(hi, u + 10), -14, -14 + 1.4 + rnd() * 0.8, 'concreteDark');
  }
  // 床のしみ(油・錆・焼け)とひび
  for (let i = 0; i < 40; i++) {
    const w = 1.5 + rnd() * 6;
    const d = 1.5 + rnd() * 6;
    const t = 0.02 + (di++ % 7) * 0.005;
    const c = rnd();
    const sx = 82 + rnd() * (208 - 82 - w);
    const sz = 142 + rnd() * (278 - 142 - d);
    k.decor('stain', sx, -14, sz, sx + w, -14 + t, sz + d, c < 0.55 ? 'roof' : c < 0.85 ? 'rust' : 'concreteDark');
  }
  for (let i = 0; i < 40; i++) {
    const along = 4 + rnd() * 10;
    const t = 0.02 + (di++ % 7) * 0.005;
    const alongX = rnd() < 0.5;
    const cx = 82 + rnd() * (208 - 82 - along);
    const cz = 142 + rnd() * (278 - 142 - along);
    if (alongX) k.decor('crack', cx, -14, cz, cx + along, -14 + t, cz + 0.22, 'roof');
    else k.decor('crack', cx, -14, cz, cx + 0.22, -14 + t, cz + along, 'roof');
  }
}
