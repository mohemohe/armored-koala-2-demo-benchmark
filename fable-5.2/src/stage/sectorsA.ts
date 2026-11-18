/**
 * Interiors of S01 loading dock, S02 checkpoint link, S03 material yard, S04 rolling mill,
 * S05 mill control room and S06 transfer shaft.
 */
import { L, PIT_BOTTOM, type Layout } from './layout';

/** S01 搬入口 — sheltered start. The centre lane x 14..26 stays empty (quick-boost test lane). */
export function buildDock(l: Layout): void {
  const b = l.b;
  const r = l.rooms.dock;
  b.sectorId = 'S01';
  // Raised loading platform on the west side with parked containers.
  b.block(2, 30, 10, 86, 0, 1.5, 'concrete', 'loading-platform');
  for (const [z0, h] of [[34, 2.5], [52, 2], [70, 2.5]] as const) b.solid(3, 1.5, z0, 9, 1.5 + h, z0 + 12, 'container', 'container');
  // Parked trucks / container stacks on the east side.
  b.block(30, 26, 36, 31, 0, 3.5, 'metal', 'truck-cab');
  b.block(30, 31, 36, 45, 0, 4, 'container', 'truck-trailer');
  b.block(29, 56, 37, 68, 0, 3, 'container', 'container');
  b.block(29, 74, 37, 86, 0, 4, 'container', 'container');
  // Closed entrance shutter behind the spawn.
  b.block(8, 97, 32, 98, 0, 10, 'metal', 'shutter');
  for (const z of [22, 50, 72, 92]) b.solid(37, 0, z - 1, 38, r.ceil, z + 1, 'concrete', 'pilaster');
  for (const z of [22, 92]) b.solid(2, 0, z - 1, 3, r.ceil, z + 1, 'concrete', 'pilaster');
  // Lane markings (flush with the floor).
  b.floorPatch(13.5, 20, 14, 96, 0, 'hazard');
  b.floorPatch(26, 20, 26.5, 96, 0, 'hazard');
  b.wallTray('z', 2, 1, 24, 90, r.ceil, 'light-warm');
  b.wallTray('z', 38, -1, 24, 90, r.ceil, 'light-warm');
  for (const z of [30, 46, 62, 78, 94]) b.truss('x', z, 4.2, 35.8, r.ceil);
  b.lamps(12, 22, 28, 86, r.ceil, 16, 16);
  b.warnLights('x', 18, 1, 14, 26, 8, 'light-amber');
}

/** S02 検問連絡路 — U-turn connector that hides the dock from the yard. First guard of the sortie. */
export function buildLink(l: Layout): void {
  const b = l.b;
  const r = l.rooms.link;
  b.sectorId = 'S02';
  b.block(40, 2, 44, 7, 0, 4, 'container', 'crate');
  b.block(56, 9, 60, 14, 0, 4, 'container', 'crate');
  b.block(64, 2, 67, 6, 0, 3, 'container', 'crate');
  b.block(94, 2, 98, 8, 0, 4, 'container', 'crate');
  // 4 m racks: nothing before the first climb may be higher than L1 - 6 = +4.
  b.wallRack('x', 2, 1, 4, 13, 0, 4);
  b.wallRack('x', 2, 1, 27, 39, 0, 4);
  b.wallRack('x', 2, 1, 70, 92, 0, 4);
  b.lamps(10, 8, 90, 8, r.ceil, 16, 16);
  b.warnLights('x', 14, -1, 76, 92, 8, 'light-amber');
  b.guard('G01', 72, 9, 0, Math.PI / 2);
}

/**
 * S03 資材ヤード — arena 1: container stacks around an open marshalling plaza under a gantry crane; two turrets
 * on masts under the roof, three guards on the floor. Control turret T01 opens B1.
 */
export function buildYard(l: Layout): void {
  const b = l.b;
  const r = l.rooms.yard;
  b.sectorId = 'S03';
  for (const x of [74, 106, 138]) for (const z of [44, 76]) b.pillar(x, z, 3, 0, r.ceil);
  // Container stacks stand around an open marshalling plaza (x 78..134, z 36..84) in the middle of the yard.
  const containers: Array<[number, number, number, number, number]> = [
    [62, 30, 74, 33, 3],
    [94, 28, 106, 31, 4],
    [116, 22, 119, 34, 3],
    [56, 36, 59, 48, 3],
    [60, 64, 63, 76, 3],
    [64, 80, 76, 83, 3],
    [78, 86, 90, 89, 4],
    [124, 30, 136, 33, 3],
    [142, 40, 145, 52, 4],
    [146, 56, 158, 59, 3],
    [142, 62, 154, 65, 3],
    [142, 65, 154, 68, 4],
    [140, 76, 152, 79, 3],
    [136, 84, 148, 87, 3],
  ];
  for (const [x0, z0, x1, z1, h] of containers) b.block(x0, z0, x1, z1, 0, h, b.pick(['container', 'container', 'rust']), 'container');
  // Gantry crane (beam top 3.5 m below the roof: nobody can stand on it).
  b.pillar(112, 22, 2.5, 0, 20, 'rust', 'crane-leg');
  b.pillar(112, 87, 2.5, 0, 20, 'rust', 'crane-leg'); // in front of the north loading deck, not through it
  b.solid(110.75, 20, 20.5, 113.25, 22.5, 88.5, 'rust', 'crane-beam');
  // Raised loading decks (4 m = L1 - 6: the highest resting place before the first climb).
  b.block(90, 90, 134, 98, 0, 4, 'concrete', 'loading-deck');
  b.block(42, 28, 52, 66, 0, 4, 'concrete', 'loading-deck');
  // Rubble from the broken north-west wall section.
  for (const [x, z, s, h] of [[56, 86, 3, 1.2], [62, 90, 2, 0.8], [58, 94, 2.5, 1.6], [70, 92, 2, 1]] as const) b.block(x, z, x + s, z + s, 0, h, 'concrete', 'rubble');
  // Full-height blast walls: cover that also works against the turrets on their masts.
  b.solid(153, 0, 70, 154.5, r.ceil, 84, 'concrete', 'blast-wall');
  b.solid(96, 0, 35, 108, r.ceil, 36.5, 'concrete', 'blast-wall');
  b.solid(66, 0, 21, 67.5, r.ceil, 31, 'concrete', 'blast-wall');
  b.mastTurret('T01', 139, 28, 0, r.ceil, Math.PI / 2, 'B1');
  b.mastTurret('T02', 75, 56, 0, r.ceil, -Math.PI / 2);
  // All three guards patrol the yard floor (the whole floor is one navigation region with the link and the dock).
  b.guard('G02', 98, 44, 0, Math.PI);
  b.guard('G03', 122, 82, 0, Math.PI / 2);
  b.guard('G04', 66, 56, 0, Math.PI);
  b.floorPatch(156, 72, 168, 96, 0, 'hazard');
  b.wallTray('x', 98, -1, 44, 166, r.ceil, 'light-warm');
  b.wallTray('x', 18, 1, 44, 166, r.ceil, 'light-warm');
  for (const x of [60, 90, 124, 152]) b.truss('z', x, 20.2, 95.8, r.ceil);
  b.lamps(48, 30, 156, 90, r.ceil, 18, 20);
  b.warnLights('z', 168, -1, 72, 96, L.l1 + 8, 'light-amber');
}

/**
 * S04 圧延棟 — arena 2: rolling lines, furnace, collapsed floor (bottomless pit) under a walkway network at +10
 * (crane deck, link, line catwalk) that starts at the lip behind barrier B1 — the high road across the mill.
 */
export function buildMill(l: Layout): void {
  const b = l.b;
  const r = l.rooms.mill;
  const f = r.floor;
  b.sectorId = 'S04';
  for (const x of [205, 240, 275]) for (const z of [24, 80]) b.pillar(x, z, 2.5, f, r.ceil);
  // North rolling line: four stands joined by a roller table.
  for (const x of [204, 228, 252, 276]) b.block(x - 4, 60, x + 4, 68, f, 5, 'machine', 'mill-stand');
  for (const x of [216, 240, 264]) b.block(x - 8, 62, x + 8, 66, f, 2, 'metal', 'roller-table');
  // South rolling line.
  for (const x of [244, 268, 292]) b.block(x - 4, 42, x + 4, 50, f, 5, 'machine', 'mill-stand');
  for (const x of [256, 280]) b.block(x - 8, 44, x + 8, 48, f, 2, 'metal', 'roller-table');
  // Reheating furnace (top +10 = L2 - 6) with a stack that runs up to the roof.
  b.block(176, 6, 196, 26, f, 6, 'machine', 'furnace');
  b.solid(178, f + 6, 8, 184, r.ceil, 14, 'pipe', 'furnace-stack');
  // Steel coils and plate stacks (cover).
  const coils: Array<[number, number, number, number]> = [
    [198, 86, 4, 3.5],
    [210, 90, 4, 3.5],
    [232, 86, 5, 4],
    [260, 90, 4, 3.5],
    [284, 84, 5, 4],
    [268, 28, 4, 3.5],
    [250, 12, 5, 4],
    [286, 60, 4, 3.5],
    [226, 46, 4, 3],
    [196, 46, 5, 4],
    [234, 8, 4, 3.5],
  ];
  for (const [x, z, s, h] of coils) b.block(x, z, x + s, z + s, f, h, b.pick(['rust', 'metal', 'container']), 'coil');
  // Collapsed floor: bottomless pit, ringed by a hazard border, rubble and warning beacons.
  b.pit(214, 22, 230, 36, f, r.t, PIT_BOTTOM);
  for (const [x, z, s, h] of [[209, 30, 2, 1], [232.5, 24, 2.5, 1.4], [220, 38.5, 2, 0.8], [226, 17.5, 2, 1.2]] as const) b.block(x, z, x + s, z + s, f, h, 'concrete', 'rubble');
  b.beacon(216, 29, f, r.ceil);
  b.beacon(228, 29, f, r.ceil);
  // Inspection catwalk (+10 = L2 - 6) between the two rolling lines.
  b.platform(232, 52, 300, 58, L.l1, 1, 'catwalk', '', 'line-catwalk');
  for (const x of [233, 266, 299]) for (const z of [52.6, 57.4]) b.pillar(x, z, 1, f, L.l1 - 1, 'metal', 'catwalk-post');
  b.mastTurret('T03', 235, 76, f, r.ceil, Math.PI / 2);
  // Crane deck (+10) along the north wall, flush with the drop-off lip of the gatehouse behind barrier B1.
  b.platform(190, 91, 296, 98, L.l1, 1, 'catwalk', 's', 'crane-deck');
  for (const x of [204, 237, 266, 295]) b.pillar(x, 91.6, 1, f, L.l1 - 1, 'metal', 'catwalk-post');
  // Full-height blast walls (cover against the turret on its mast).
  b.solid(206, f, 74, 207.5, r.ceil, 84, 'concrete', 'blast-wall');
  b.solid(262, f, 70, 272, r.ceil, 71.5, 'concrete', 'blast-wall');
  b.solid(293, f, 6, 294.5, r.ceil, 20, 'concrete', 'blast-wall');
  // Link between the crane deck and the line catwalk: one elevated walkway network across the mill.
  b.platform(294, 58, 300, 91, L.l1, 1, 'catwalk', 'ew', 'catwalk-link');
  for (const z of [70, 84]) for (const x of [294.6, 299.4]) b.pillar(x, z, 1, f, L.l1 - 1, 'metal', 'catwalk-post');
  // Both guards start in the south half of the floor and come for the player across the rolling lines.
  b.guard('G05', 240, 30, f, -Math.PI / 2);
  b.guard('G06', 284, 30, f, Math.PI / 2);
  b.floorPatch(296, 4, 308, 32, f, 'hazard');
  b.wallRack('x', 2, 1, 202, 290, f);
  b.wallTray('x', 98, -1, 192, 306, r.ceil, 'light-warm');
  b.wallTray('x', 2, 1, 174, 306, r.ceil, 'light-warm');
  for (const x of [212, 258, 292]) b.truss('z', x, 4.2, 95.8, r.ceil);
  b.lamps(196, 14, 300, 86, r.ceil, 26, 24);
  b.warnLights('z', 308, -1, 6, 30, L.l2 + 8, 'light-amber');
  b.warnLights('z', 182, -1, 77, 91, L.l1 + 8, 'light-red');
}

/** S05 圧延制御室 — side room with two doors to the mill (local loop LP1), relay cabinets and consoles. Control turret T04 opens B2. */
export function buildControlRoom(l: Layout): void {
  const b = l.b;
  const r = l.rooms.ctrl;
  const f = r.floor;
  b.sectorId = 'S05';
  b.solid(312, f, 74, 334, r.ceil, 76, 'wall', 'divider');
  b.block(345, 54, 348, 68, f, 3, 'machine', 'console');
  b.block(345, 82, 348, 96, f, 3, 'machine', 'console');
  b.block(318, 52, 332, 54, f, 7, 'machine', 'server-rack');
  b.block(318, 96, 332, 98, f, 7, 'machine', 'server-rack');
  // Free-standing relay cabinets (5 m: tops at +9, below L2 - 6). They are the machinery taller than the mech
  // that makes this room an equipment hall (validator V1) — do not lower them. The chase camera of a mech that
  // stands within about 4 m north of the southern row and aims at T04 looks over the cabinet top, which then
  // hides the mech: the firing waypoint of the route keeps 6 m clear of the row for that reason.
  b.block(318, 57, 336, 60, f, 5, 'machine', 'relay-cabinet');
  b.block(318, 90, 336, 93, f, 5, 'machine', 'relay-cabinet');
  b.turretOnPedestal('T04', 341, 75, f, 1.5, Math.PI / 2, 'B2');
  b.beacon(341, 75, f + 1.5, r.ceil);
  b.lamps(322, 64, 340, 88, r.ceil, 18, 24, 'light-cyan');
}

/** S06 搬送縦坑 — 50 m high hoist shaft: enter on a ledge at +16, drop to the lift floor (+10, one guard), fly up to the bay at +22. */
export function buildShaft(l: Layout): void {
  const b = l.b;
  const r = l.rooms.shaft;
  const f = r.floor;
  b.sectorId = 'S06';
  b.platform(312, 2, 322, 34, L.l2, 1, 'catwalk', 'en', 'entry-ledge');
  b.block(312, 40, 320, 48, f, 6, 'metal', 'winch-housing');
  b.block(324, 20, 332, 30, f, 5, 'machine', 'hoist');
  b.block(326, 36, 330, 40, f, 3, 'rust', 'cable-drum');
  b.solid(345, f, 2, 348, r.ceil, 5, 'pipe', 'riser-duct');
  b.solid(345, f, 45, 348, r.ceil, 48, 'pipe', 'riser-duct');
  b.solid(323, f, 2, 326, r.ceil, 4, 'pipe', 'riser-duct');
  // Hoist cables run down the north wall (clamped to it, never across the flight volume).
  for (const x of [324, 332, 344]) b.dec('cylinder-y', 'metal', x - 0.08, 22, 47.84, x + 0.08, r.ceil, 48);
  for (const x of [326, 338]) b.dec('box', 'light-cyan', x, 24, 47.85, x + 4, 30, 48);
  for (const x of [326, 338]) b.dec('box', 'light-cyan', x, 44, 47.85, x + 4, 50, 48);
  // Guide rails of the hoist: full-height columns in the corners of the lift floor.
  b.solid(333, f, 44.5, 336, r.ceil, 48, 'metal', 'guide-rail');
  b.solid(312, f, 36, 314, r.ceil, 38.5, 'metal', 'guide-rail');
  b.guard('G07', 332, 11, f, Math.PI / 2);
  b.lamps(324, 14, 340, 38, r.ceil, 16, 24);
  b.floorPatch(336, 12, 348, 46, f, 'hazard');
  b.warnLights('z', 348, -1, 14, 44, L.l3 + 8, 'light-amber');
}
