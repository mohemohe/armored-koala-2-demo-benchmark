/**
 * Interiors of S14 main production hall, S15 shipping warehouse, S16 perimeter haul road and S17 exit gate.
 */
import type { Layout } from './layout';

/**
 * S14 主製造ホール — arena 6: two stacked levels (-12 floor, 0 m north gallery + jetty + crane cab) under a 42 m roof. T14 opens B6.
 * S19 保守回廊 — the south and east galleries (0 m) are walled off from the hall: a covered detour (branch BR4).
 */
export function buildMainHall(l: Layout): void {
  const b = l.b;
  const r = l.rooms.main;
  const f = r.floor;
  b.sectorId = 'S14';
  // Entry vestibule at the tunnel door (bottom level): north door to the hall floor, hatch in its ceiling
  // up into the service gallery.
  b.shell(252, f, 219, 272, -1, 220, 'wall', 'vestibule-wall');
  b.carve(256, f, 219, 268, f + 8, 220);
  b.solid(271, f, 202, 272, -1, 219, 'wall', 'vestibule-wall');
  // Service gallery (S19): south + east galleries at 0 m behind a full-height wall. It is entered through the
  // hatch above the vestibule (12 m flight) and leads to the east half of the doorway of barrier B6.
  b.sectorId = 'S19';
  b.platform(252, 202, 478, 220, 0, 1, 'catwalk', '', 'gallery');
  b.carve(255, -1, 203, 269, 0, 215);
  b.shell(255, -1, 203, 269, 0, 204, 'hazard', 'hatch-edge');
  b.shell(255, -1, 214, 269, 0, 215, 'hazard', 'hatch-edge');
  b.shell(255, -1, 204, 256, 0, 214, 'hazard', 'hatch-edge');
  b.shell(268, -1, 204, 269, 0, 214, 'hazard', 'hatch-edge');
  b.platform(459, 220, 478, 298, 0, 1, 'catwalk', '', 'gallery');
  b.shell(252, 0, 219, 459, r.ceil, 220, 'wall', 'gallery-wall');
  b.shell(458, -1, 220, 459, r.ceil, 298, 'wall', 'gallery-wall');
  // Firing slits (2 m wide, 2 m high: too small for the mech): the hall's enemies get intermittent lines into the gallery.
  for (const x of [318, 404]) b.carve(x, 1, 219, x + 2, 3, 220);
  b.carve(458, 1, 262, 459, 3, 264);
  b.solid(458, 0, 298, 459, 8, 302, 'wall', 'gallery-wall');
  for (const [x0, z0, x1, z1] of [[344, 202, 348, 210], [388, 211, 392, 219], [432, 202, 436, 210], [471, 232, 478, 236], [459, 256, 466, 260]] as const) {
    b.solid(x0, 0, z0, x1, r.ceil, z1, 'concrete', 'gallery-buttress');
  }
  for (let x = 284; x <= 444; x += 32) b.dec('box', 'light-warm', x, 6, 218.85, x + 4, 7, 219);
  for (const z of [236, 262]) b.dec('box', 'light-warm', 459, 6, z, 459.15, 7, z + 4);
  b.sectorId = 'S14';
  // Mid level (0) of the hall: north gallery with a jetty reaching out over the floor.
  b.platform(252, 280, 458, 298, 0, 1, 'catwalk', 's', 'gallery');
  b.platform(390, 236, 402, 280, 0, 1, 'catwalk', 'ews', 'jetty');
  // Three full-height piers down the middle of the hall.
  for (const x of [300, 380, 440]) b.pillar(x, 250, 3, f, r.ceil, 'concrete', 'pier');
  for (const x of [310, 370, 430]) b.pillar(x, 296, 2.5, f, r.ceil);
  // Production machinery on the bottom floor.
  const machines: Array<[number, number, number, number, number]> = [
    [282, 226, 292, 238, 6],
    [282, 262, 292, 274, 5],
    [312, 240, 322, 260, 6],
    [350, 226, 362, 236, 5],
    [350, 264, 362, 274, 6],
    [376, 238, 388, 244, 4],
    [376, 256, 388, 262, 4],
    [416, 226, 430, 238, 6], // abuts the gun tower of T13 (no blind 2 m slot between them)
    [416, 262, 428, 274, 5],
    [444, 238, 452, 262, 5],
  ];
  for (const [x0, z0, x1, z1, h] of machines) b.block(x0, z0, x1, z1, f, h, 'machine', 'press');
  b.block(302, 248, 312, 252, f, 2, 'metal', 'conveyor');
  b.block(322, 248, 376, 252, f, 2, 'metal', 'conveyor');
  b.block(388, 248, 438, 252, f, 2, 'metal', 'conveyor');
  for (const [cx, cz] of [[320, 290], [382, 290], [430, 210], [344, 210]] as const) b.tank(cx, cz, 5, f, 6, 'pipe');
  // Cover on the galleries.
  const crates: Array<[number, number, number, number, number]> = [
    [300, 290, 306, 296, 3],
    [360, 291, 366, 297, 4],
    [410, 290, 416, 296, 3],
  ];
  for (const [x0, z0, x1, z1, h] of crates) b.block(x0, z0, x1, z1, 0, h, b.pick(['container', 'rust']), 'crate');
  // Two gun towers rise from the bottom floor to +3 m: they see over every machine and onto the galleries.
  b.turretOnPedestal('T13', 432, 236, f, 15, -Math.PI / 2);
  b.turretOnPedestal('T14', 366, 264, f, 15, Math.PI / 2, 'B6');
  b.beacon(366, 264, 3, r.ceil);
  // One guard on the hall floor, two on the north gallery (the route crosses it on the way to barrier B6).
  b.guard('G22', 378, 210, f, Math.PI / 2);
  b.guard('G23', 322, 281.3, 0, Math.PI / 2);
  b.guard('G24', 425, 281.3, 0, Math.PI / 2);
  b.guard('G25', 396, 240, 0, Math.PI / 2);
  // Crane cab platform (0 m) on the south side.
  b.platform(326, 222, 342, 236, 0, 1, 'catwalk', 'new', 'crane-cab');
  for (const [x, z] of [[326.6, 222.6], [341.4, 222.6], [326.6, 235.4], [341.4, 235.4]] as const) b.pillar(x, z, 1, f, -1, 'metal', 'catwalk-post');
  b.floorPatch(446, 264, 458, 280, f, 'hazard');
  b.wallTray('x', 298, -1, 254, 476, r.ceil, 'light-warm');
  b.wallTray('x', 202, 1, 254, 476, r.ceil, 'light-warm');
  for (const x of [280, 340, 400, 468]) b.truss('z', x, 204.2, 295.8, r.ceil);
  for (const z of [214, 236, 264, 286]) b.lamps(270, z, 466, z, r.ceil, 28, 40);
  for (let x = 270; x <= 450; x += 30) {
    b.dec('box', 'light-cyan', x - 2, -1.15, 288.4, x + 2, -1, 289.6);
    if (x >= 330) b.dec('box', 'light-cyan', x - 2, -1.15, 210.4, x + 2, -1, 211.6);
  }
  b.warnLights('x', 298, -1, 444, 458, 8, 'light-red');
  b.warnLights('x', 298, -1, 459, 468, 8, 'light-red');
  for (const z of [206.5, 215.5]) b.dec('box', 'light-amber', 252, -3.9, z, 252.2, -3.1, z + 2, true);
}

/** S15 出荷倉庫 — arena 7: aisles between 12 m racks. */
export function buildWarehouse(l: Layout): void {
  const b = l.b;
  const r = l.rooms.ware;
  b.sectorId = 'S15';
  for (const z of [322, 342, 362]) for (const x0 of [344, 384, 424]) b.block(x0, z - 2, x0 + 30, z + 2, 0, 12, z === 342 ? 'rust' : 'metal', 'storage-rack');
  b.block(350, 380, 380, 384, 0, 12, 'metal', 'storage-rack');
  const crates: Array<[number, number, number, number, number]> = [
    [462, 328, 468, 334, 3],
    [336, 306, 342, 312, 4],
    [400, 304, 408, 310, 3.5],
    [430, 306, 436, 312, 3],
    [398, 380, 404, 386, 4],
    [418, 388, 426, 394, 3],
    [440, 376, 446, 382, 3.5],
    [468, 352, 474, 360, 4],
    [336, 346, 340, 352, 3],
  ];
  for (const [x0, z0, x1, z1, h] of crates) b.block(x0, z0, x1, z1, 0, h, b.pick(['container', 'rust', 'container']), 'crate');
  for (const z of [318, 350, 382]) b.solid(477, 0, z - 1, 478, r.ceil, z + 1, 'concrete', 'pilaster');
  // Fin continuing the service-gallery wall through the doorway of B6.
  b.solid(458, 0, 302, 459, r.ceil, 312, 'wall', 'door-fin');
  // Crossing fire on the way through: one guard down the south aisle, one in the west aisle in front of the
  // exit door, one in the east aisle looking at the doorway of barrier B6.
  b.guard('G26', 396, 314, 0, Math.PI / 2);
  b.guard('G27', 338, 356, 0, 0);
  b.guard('G28', 458, 338, 0, Math.PI);
  b.wallTray('z', 478, -1, 304, 394, r.ceil, null);
  b.wallTray('x', 398, -1, 334, 476, r.ceil, 'light-warm');
  for (const x of [358, 406, 454]) b.truss('z', x, 304.2, 395.8, r.ceil);
  b.lamps(346, 312, 466, 392, r.ceil, 24, 20);
  b.warnLights('z', 332, 1, 374, 396, 8, 'light-amber');
}

/**
 * S16 外周搬送路 — haul road: wrecked trailers stand along both walls (cover every 30 m on alternating sides)
 * and leave a centre lane that the two guards hold from 130 m apart.
 */
export function buildRoad(l: Layout): void {
  const b = l.b;
  const r = l.rooms.road;
  b.sectorId = 'S16';
  const wrecks: Array<[number, number, number, number, number]> = [
    [290, 374, 304, 378, 4],
    [262, 392, 276, 396, 4],
    [230, 374, 244, 378, 4.5],
    [200, 392, 214, 396, 4],
    [170, 374, 184, 378, 4],
    [140, 392, 154, 396, 4.5],
    [110, 374, 124, 378, 4],
    [84, 392, 98, 396, 4],
  ];
  for (const [x0, z0, x1, z1, h] of wrecks) b.block(x0, z0, x1, z1, 0, h, b.pick(['container', 'rust', 'metal']), 'wreck');
  // Checkpoint blocks (1.2 m: they stop the mech on the ground but not a bullet) narrow the centre lane.
  for (const [x0, z0] of [[282, 388], [216, 380], [158, 388], [100, 380]] as const) b.block(x0, z0, x0 + 6, z0 + 1.5, 0, 1.2, 'concrete', 'jersey-barrier');
  for (let x = 80; x <= 320; x += 30) b.solid(x - 1, 0, 372, x + 1, r.ceil, 373, 'concrete', 'pilaster');
  b.guard('G29', 250, 385, 0, -Math.PI / 2);
  b.guard('G30', 122, 385, 0, -Math.PI / 2);
  b.wallTray('x', 398, -1, 64, 326, r.ceil, 'light-warm');
  for (const x of [100, 160, 220, 280]) b.truss('z', x, 373, 395.8, r.ceil);
  b.lamps(80, 381, 320, 381, r.ceil, 30, 20);
  b.warnLights('z', 62, 1, 374, 396, 8, 'light-amber');
}

/** S17 搬出ゲート — the final gate (opens when all six control turrets are destroyed) and the exit zone behind it. */
export function buildGate(l: Layout): void {
  const b = l.b;
  const r = l.rooms.gate;
  b.sectorId = 'S17';
  b.turretOnPedestal('T15', 30, 316, 0, 2, 0);
  const blocks: Array<[number, number, number, number, number]> = [
    [10, 340, 16, 346, 4],
    [44, 340, 50, 346, 4],
    [26, 358, 34, 362, 4],
    [8, 372, 14, 378, 3.5],
    [4, 306, 10, 314, 5],
    [50, 306, 56, 314, 5],
  ];
  for (const [x0, z0, x1, z1, h] of blocks) b.block(x0, z0, x1, z1, 0, h, 'concrete', 'barricade');
  b.floorPatch(18, 304, 42, 308, 0, 'hazard');
  b.floorPatch(18, 296, 42, 300, 0, 'hazard');
  for (const z of [330, 360, 390]) b.truss('x', z, 2, 58, r.ceil);
  b.lamps(16, 318, 44, 378, r.ceil, 28, 20);
  b.lamps(16, 286, 44, 286, r.ceil, 28, 20, 'light-cyan');
  b.dec('box', 'light-cyan', 10, 6, 272, 50, 12, 272.15);
  b.warnLights('x', 304, 1, 18, 42, 10, 'light-red');
}
