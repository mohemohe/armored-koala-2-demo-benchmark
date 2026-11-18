/**
 * Interiors of S11 cooling plant, S12 exhaust shaft and S13 underground conveyor tunnel.
 */
import { L, PIT_BOTTOM, type Layout } from './layout';

/** S11 冷却設備 — arena 5: six tanks (tops +40) inside a catwalk ring at +40 held by T05, T10 and a guard; one guard on the floor. Control turret T11 opens B5. */
export function buildCooling(l: Layout): void {
  const b = l.b;
  const r = l.rooms.cool;
  const f = r.floor;
  b.sectorId = 'S11';
  // Entry balcony behind the flight bay from the power house and the catwalk ring (all +40).
  b.platform(96, 102, 108, 132, L.l6, 1, 'catwalk', 'n', 'entry-balcony');
  b.platform(90, 112, 96, 192, L.l6, 1, 'catwalk', '', 'catwalk');
  b.platform(20, 112, 90, 118, L.l6, 1, 'catwalk', '', 'catwalk');
  b.platform(20, 186, 90, 192, L.l6, 1, 'catwalk', '', 'catwalk');
  b.platform(14, 112, 20, 192, L.l6, 1, 'catwalk', '', 'catwalk');
  b.platform(20, 150, 90, 156, L.l6, 1, 'catwalk', '', 'catwalk');
  for (const [x, z] of [[17, 115], [93, 115], [17, 189], [93, 189], [17, 153], [93, 153], [55, 115], [55, 189]] as const) {
    b.pillar(x, z, 1.2, f, L.l6 - 1, 'metal', 'catwalk-post');
  }
  // Tank tops at +40 = L7 - 6 (level with the catwalks).
  for (const cx of [33, 55, 77]) for (const cz of [134, 171]) b.tank(cx, cz, 7, f, 8, cx === 55 ? 'rust' : 'pipe');
  b.solid(2, f, 102, 8, r.ceil, 110, 'pipe', 'cooling-riser');
  const pumps: Array<[number, number, number, number, number]> = [
    [44, 104, 52, 110, 4],
    [66, 104, 74, 110, 4],
    [4, 140, 10, 150, 4],
    [4, 164, 10, 174, 4],
    [98, 150, 106, 160, 5],
    [98, 170, 106, 180, 5],
    [50, 193, 60, 197, 3],
  ];
  for (const [x0, z0, x1, z1, h] of pumps) b.block(x0, z0, x1, z1, f, h, b.pick(['machine', 'metal']), 'pump');
  // Blast wall along the west edge of the entry balcony: the landing of climb F6 is out of sight of the plant;
  // the 6 m doorway (z 112..118) leads onto the catwalk ring.
  b.solid(96, L.l6, 102, 97, r.ceil, 112, 'concrete', 'blast-wall');
  b.solid(96, L.l6, 118, 97, r.ceil, 132, 'concrete', 'blast-wall');
  b.turret('T05', 17, 189, L.l6, 0);
  b.turret('T10', 77, 171, f + 8, Math.PI / 2);
  b.turret('T11', 55, 153, L.l6, Math.PI, 'B5');
  b.beacon(55, 153, L.l6, r.ceil);
  b.guard('G18', 60, 115, L.l6, Math.PI);
  b.guard('G19', 44, 152, f, Math.PI / 2);
  b.floorPatch(4, 190, 14, 198, f, 'hazard');
  b.wallTray('x', 102, 1, 10, 94, r.ceil, 'light-warm');
  b.wallTray('z', 2, 1, 112, 188, r.ceil, 'light-warm');
  b.wallTray('x', 198, -1, 40, 106, r.ceil, 'light-warm');
  for (const z of [124, 144, 164, 184]) b.truss('x', z, 4.2, 105.8, r.ceil);
  b.lamps(20, 114, 92, 186, r.ceil, 24, 18, 'light-cyan');
  b.warnLights('x', 198, -1, 6, 34, L.l7 + 8, 'light-amber');
}

/** S12 排気縦坑 — 58 m descent from the gatehouse (+46, barrier B5) to the tunnel level (-12), where a guard waits at the door. */
export function buildExhaust(l: Layout): void {
  const b = l.b;
  const r = l.rooms.exh;
  const f = r.floor;
  b.sectorId = 'S12';
  // Broken service platforms on the way down (each step <= 16 m, so the shaft can also be climbed).
  b.platform(28, 228, 48, 248, 30, 1, 'catwalk', 'ws', 'shaft-platform');
  b.platform(2, 228, 22, 248, 14, 1, 'catwalk', 'es', 'shaft-platform');
  b.platform(28, 228, 48, 248, -1, 1, 'catwalk', 'ws', 'shaft-platform');
  b.solid(2, f, 222, 5, r.ceil, 226, 'pipe', 'exhaust-duct');
  b.solid(45, f, 222, 48, r.ceil, 226, 'pipe', 'exhaust-duct');
  b.block(10, 222, 30, 226, f, 3, 'rust', 'fallen-duct');
  b.block(6, 236, 12, 242, f, 2, 'concrete', 'rubble');
  b.block(16, 242, 20, 246, f, 1.2, 'concrete', 'rubble');
  // Cables are clamped to the north wall (never across the descent).
  for (const x of [8, 25, 42]) b.dec('cylinder-y', 'metal', x - 0.08, 6, 247.84, x + 0.08, r.ceil, 248);
  b.guard('G20', 37, 211, f, Math.PI / 2);
  for (const y of [0, 24, 44]) b.dec('box', 'light-warm', 23, y, 247.85, 27, y + 6, 248);
  for (const y of [5, 20, 40]) b.dec('box', 'light-cyan', 47.85, y, 232, 48, y + 6, 236);
  b.lamps(14, 208, 34, 240, r.ceil, 20, 32);
  b.warnLights('x', 212, -1, 13, 27, L.l7 + 8, 'light-red');
}

/** S13 地下搬送区画 — two parallel tunnels joined by three cross links around two solid cores. */
export function buildTunnel(l: Layout): void {
  const b = l.b;
  const r = l.rooms.tun;
  const f = r.floor;
  b.sectorId = 'S13';
  b.solid(68, f, 220, 142, r.ceil, 250, 'concrete', 'tunnel-core');
  b.solid(158, f, 220, 232, r.ceil, 250, 'concrete', 'tunnel-core');
  // Main conveyor along the south wall of the direct tunnel.
  b.block(60, 202, 240, 206, f, 2, 'metal', 'conveyor');
  // Collapsed lining: a full-height baffle that hides the west junction from the direct tunnel.
  b.solid(70, f, 206, 74, r.ceil, 214, 'concrete', 'baffle');
  b.solid(84, f, 212, 88, r.ceil, 220, 'concrete', 'baffle');
  // The pit leaves a 7 m strip (z 206..213) south of it, in line with the gap of the second baffle.
  b.pit(104, 213, 118, 220, f, r.t, PIT_BOTTOM);
  const crates: Array<[number, number, number, number, number]> = [
    [150, 206, 156, 210, 3],
    [176, 214, 182, 220, 3.5],
    [210, 206, 216, 211, 3],
    [90, 260, 96, 266, 3],
    [120, 250, 126, 256, 3.5],
    [180, 260, 186, 266, 3],
    [212, 250, 218, 255, 3.5],
    [142, 232, 147, 238, 3],
  ];
  for (const [x0, z0, x1, z1, h] of crates) b.block(x0, z0, x1, z1, f, h, b.pick(['container', 'rust', 'metal']), 'crate');
  // Pipe bundles along the north wall of the side tunnel (6 m high under a 9 m ceiling).
  for (const [x0, x1] of [[60, 112], [136, 176], [196, 240]] as const) {
    b.solid(x0, f, 266.5, x1, f + 6, 268, 'pipe', 'pipe-bundle');
    b.dec('cylinder-x', 'rust', x0 + 0.3, f + 6, 266.8, x1 - 0.3, f + 7, 267.8);
    b.dec('cylinder-x', 'metal', x0 + 0.3, f + 7, 266.9, x1 - 0.3, f + 7.8, 267.7);
  }
  // Cable/pipe bundles along the core walls of the direct tunnel.
  for (const [x0, x1] of [[132, 141], [160, 174], [184, 230]] as const) {
    b.solid(x0, f, 218.5, x1, f + 6, 220, 'rust', 'pipe-bundle');
    b.dec('cylinder-x', 'pipe', x0 + 0.3, f + 6, 218.8, x1 - 0.3, f + 7, 219.8);
    b.dec('cylinder-x', 'metal', x0 + 0.3, f + 7, 218.9, x1 - 0.3, f + 7.8, 219.7);
  }
  for (const [x0, x1] of [[70, 100], [128, 140], [160, 210]] as const) b.solid(x0, f, 250, x1, f + 6, 251.5, 'pipe', 'pipe-bundle');
  b.turret('T12', 236, 204, f + 2, Math.PI / 2);
  b.guard('G21', 136, 210, f, -Math.PI / 2);
  for (const x of [64, 88, 136, 160, 184, 208, 232]) {
    b.dec('box', 'light-warm', x - 2, r.ceil - 0.15, 212.4, x + 2, r.ceil, 213.6);
    b.dec('box', 'light-warm', x - 2, r.ceil - 0.15, 258.4, x + 2, r.ceil, 259.6);
  }
  for (const x of [60, 150, 240]) b.dec('box', 'light-warm', x - 0.6, r.ceil - 0.15, 233, x + 0.6, r.ceil, 237);
  b.dec('box', 'light-red', 105, r.ceil - 0.15, 214, 107, r.ceil, 218, true);
  b.dec('box', 'light-red', 115, r.ceil - 0.15, 214, 117, r.ceil, 218, true);
  for (const z of [206.5, 215.5]) b.dec('box', 'light-amber', 247.8, -3.9, z, 248, -3.1, z + 2, true);
}
