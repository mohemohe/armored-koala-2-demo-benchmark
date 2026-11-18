/**
 * Interiors of S07 assembly line, S08 inspection building, S09 pipe gallery and S10 power house.
 */
import { L, type Layout } from './layout';

/**
 * S07 組立ライン — arena 3: hall floor (+14) under a walkway network at +22 (west walkway, centre catwalk, parts
 * gantry) that starts in the vestibule behind B2. Two turrets on masts, two guards on the floor, two on the
 * centre catwalk. Control turret T06 opens B3.
 * S18 部品搬送回廊 — the L-shaped mezzanine (+22) is walled off from the hall: a covered detour (branch BR1).
 * Nobody is posted in it, but six firing slits let the hall's enemies shoot into it.
 */
export function buildAssembly(l: Layout): void {
  const b = l.b;
  const r = l.rooms.asm;
  const f = r.floor;
  b.sectorId = 'S07';
  // Parts gallery (S18): mezzanine slab along the south and east walls, closed towards the hall by a
  // full-height wall. It starts in the vestibule behind B2 and ends under the exit bay in the north wall.
  b.sectorId = 'S18';
  b.platform(372, 2, 478, 20, L.l3, 1, 'catwalk', '', 'mezzanine');
  b.platform(460, 20, 478, 98, L.l3, 1, 'catwalk', '', 'mezzanine');
  b.shell(372, L.l3, 19, 461, r.ceil, 20, 'wall', 'gallery-wall');
  b.shell(460, L.l3, 20, 461, r.ceil, 98, 'wall', 'gallery-wall');
  // Firing slits (2 m wide, 2 m high: too small for the mech) give the hall's enemies intermittent lines
  // into the gallery — the detour is covered, not safe.
  for (const x of [392, 414, 438]) b.carve(x, L.l3 + 1, 19, x + 2, L.l3 + 3, 20);
  for (const z of [36, 60, 72]) b.carve(460, L.l3 + 1, z, 461, L.l3 + 3, z + 2);
  for (const [x0, z0, x1, z1] of [[398, 2, 402, 9], [428, 12, 432, 19], [452, 2, 456, 9], [461, 38, 468, 42], [471, 62, 478, 66], [461, 84, 467, 88]] as const) {
    b.solid(x0, L.l3, z0, x1, r.ceil, z1, 'concrete', 'gallery-buttress');
  }
  for (const x of [384, 404, 424, 444]) b.dec('box', 'light-warm', x, L.l3 + 6, 18.85, x + 4, L.l3 + 7, 19);
  for (const z of [30, 54, 78]) b.dec('box', 'light-warm', 461, L.l3 + 6, z, 461.15, L.l3 + 7, z + 4);
  b.sectorId = 'S07';
  for (const x of [384, 416, 448]) b.pillar(x, 19.4, 1.2, f, L.l3 - 1, 'metal', 'mezzanine-post');
  for (const z of [34, 58, 82]) b.pillar(460.6, z, 1.2, f, L.l3 - 1, 'metal', 'mezzanine-post');
  for (const [x, z] of [[388, 54], [424, 54], [388, 86], [424, 86]] as const) b.pillar(x, z, 2.5, f, r.ceil);
  // Assembly cells and conveyors.
  const cells: Array<[number, number, number, number, number]> = [
    [396, 46, 404, 54, 6],
    [410, 70, 418, 78, 6],
    [432, 50, 440, 58, 5],
    [376, 70, 384, 78, 5],
    [440, 72, 448, 80, 6],
  ];
  for (const [x0, z0, x1, z1, h] of cells) b.block(x0, z0, x1, z1, f, h, 'machine', 'assembly-cell');
  b.block(380, 38, 452, 42, f, 2.5, 'metal', 'conveyor');
  b.block(386, 62, 406, 66, f, 2.5, 'metal', 'conveyor');
  b.block(420, 62, 438, 66, f, 2.5, 'metal', 'conveyor');
  const crates: Array<[number, number, number, number, number]> = [
    [380, 6, 386, 12, 4],
    [410, 10, 416, 16, 3],
    [440, 6, 446, 12, 4],
    [356, 70, 362, 76, 3.5],
    [368, 84, 374, 90, 4],
    [398, 90, 404, 96, 3],
    [452, 60, 457, 66, 4],
  ];
  for (const [x0, z0, x1, z1, h] of crates) b.block(x0, z0, x1, z1, f, h, b.pick(['container', 'rust']), 'crate');
  // Parts gantry (+22) along the north wall.
  b.platform(376, 90, 440, 98, L.l3, 1, 'catwalk', '', 'parts-gantry');
  for (const x of [377, 408, 439]) b.pillar(x, 90.6, 1, f, L.l3 - 1, 'metal', 'catwalk-post');
  b.mastTurret('T06', 360, 90, f, r.ceil, Math.PI, 'B3');
  b.mastTurret('T07', 456, 36, f, r.ceil, -Math.PI / 2);
  // West walkway (+22): from a doorway in the north wall of the vestibule behind B2 along the west side of the
  // hall to the parts gantry. Vestibule, walkway, centre catwalk and gantry are one navigation region: the
  // catwalk guards can come for a player who stays up there, and the player can cross the hall on the high road.
  b.carve(365, L.l3, 49, 371, L.l3 + 8, 50);
  b.platform(364, 50, 372, 90, L.l3, 1, 'catwalk', 'ew', 'west-walkway');
  b.platform(364, 90, 376, 98, L.l3, 1, 'catwalk', '', 'west-walkway');
  for (const z of [62, 78]) for (const x of [364.6, 371.4]) b.pillar(x, z, 1, f, L.l3 - 1, 'metal', 'catwalk-post');
  b.pillar(365, 97, 1.2, f, L.l3 - 1, 'metal', 'catwalk-post');
  // Centre catwalk (+22) from the west walkway out over the conveyors.
  b.platform(372, 56, 430, 62, L.l3, 1, 'catwalk', 'ns', 'centre-catwalk');
  for (const x of [380, 410, 429]) for (const z of [56.6, 61.4]) b.pillar(x, z, 1, f, L.l3 - 1, 'metal', 'catwalk-post');
  // Two guards on the hall floor, two on the centre catwalk.
  b.guard('G08', 414, 30, f, Math.PI / 2);
  b.guard('G09', 432, 86, f, Math.PI / 2);
  b.guard('G10', 400, 59, L.l3, Math.PI / 2);
  b.guard('G11', 416, 59, L.l3, Math.PI / 2);
  b.platform(444, 46, 460, 60, f + 6, 1, 'catwalk', '', 'operator-deck');
  for (const [x, z] of [[444.6, 46.6], [444.6, 59.4]] as const) b.pillar(x, z, 1, f, f + 5, 'metal', 'catwalk-post');
  // Full-height blast walls: beside the take-off pad of climb F4 and in the middle of the hall.
  b.solid(441, f, 84, 443, r.ceil, 98, 'concrete', 'blast-wall');
  b.solid(443, f, 84, 451, r.ceil, 85.5, 'concrete', 'blast-wall');
  b.solid(404, f, 24, 405.5, r.ceil, 36, 'concrete', 'blast-wall');
  b.solid(418, f, 46, 430, r.ceil, 47.5, 'concrete', 'blast-wall');
  b.floorPatch(446, 86, 458, 98, f, 'hazard');
  b.wallTray('x', 98, -1, 354, 440, r.ceil, 'light-warm');
  b.wallTray('x', 2, 1, 366, 476, r.ceil, 'light-warm');
  b.wallTray('z', 478, -1, 24, 96, r.ceil, null);
  for (const x of [376, 408, 440]) b.truss('z', x, 4.2, 95.8, r.ceil);
  b.lamps(392, 30, 456, 74, r.ceil, 32, 22);
  b.warnLights('x', 98, -1, 446, 474, L.l4 + 8, 'light-amber');
  b.warnLights('z', 362, -1, 22, 36, L.l3 + 8, 'light-red');
}

/** S08 検査棟 — two storeys: upper floor +26 (broken open in three places) over the lower floor +18. */
export function buildInspection(l: Layout): void {
  const b = l.b;
  const r = l.rooms.insp;
  const lower = r.floor;
  const upper = 26;
  b.sectorId = 'S08';
  b.platform(382, 102, 478, 198, upper, 1, 'floor', '', 'upper-floor');
  const holes: Array<[number, number, number, number]> = [
    [404, 124, 430, 146], // H1: drop to the lower storey near the entrance
    [436, 150, 462, 176], // H2: above control turret T08
    [386, 146, 400, 172], // H3: fly back up near the exit
  ];
  const inHole = (x0: number, z0: number, x1: number, z1: number, pad: number): boolean =>
    holes.some(([hx0, hz0, hx1, hz1]) => x1 > hx0 - pad && x0 < hx1 + pad && z1 > hz0 - pad && z0 < hz1 + pad);
  for (const [x0, z0, x1, z1] of holes) {
    b.carve(x0 - 1, upper - 1, z0 - 1, x1 + 1, upper, z1 + 1);
    b.shell(x0 - 1, upper - 1, z0 - 1, x1 + 1, upper, z0, 'hazard', 'hole-edge');
    b.shell(x0 - 1, upper - 1, z1, x1 + 1, upper, z1 + 1, 'hazard', 'hole-edge');
    b.shell(x0 - 1, upper - 1, z0, x0, upper, z1, 'hazard', 'hole-edge');
    b.shell(x1, upper - 1, z0, x1 + 1, upper, z1, 'hazard', 'hole-edge');
  }
  // Column grid: lower storey everywhere, six columns continue through the upper storey to the roof.
  const tall = new Set(['430,118', '462,134', '414,166', '430,182', '398,182', '462,182']);
  for (const x of [398, 414, 430, 446, 462]) {
    for (const z of [118, 134, 150, 166, 182]) {
      if (inHole(x - 1, z - 1, x + 1, z + 1, 1.2)) continue;
      b.pillar(x, z, 2, lower, upper - 1, 'concrete');
      if (tall.has(`${x},${z}`)) b.pillar(x, z, 2, upper, r.ceil, 'concrete');
    }
  }
  // Upper storey: low crates only (tops at +28 = L5 - 6).
  const crates: Array<[number, number, number, number]> = [
    [408, 106, 414, 112],
    [470, 130, 476, 142],
    [424, 160, 430, 166],
    [404, 178, 410, 184],
    [444, 186, 456, 190],
    [466, 160, 472, 166],
  ];
  for (const [x0, z0, x1, z1] of crates) b.block(x0, z0, x1, z1, upper, 2, b.pick(['container', 'metal']), 'crate');
  // Lower storey: partitions and test rigs (too tall to stand on under the 7 m ceiling).
  // Partitions seal the control turret's chamber (east + north part) from the rest of the lower storey:
  // it is open only to the floor opening H2 above it.
  b.solid(432, lower, 102, 434, upper - 1, 148, 'wall', 'partition');
  b.solid(404, lower, 148, 434, upper - 1, 150, 'wall', 'partition');
  b.solid(404, lower, 150, 406, upper - 1, 198, 'wall', 'partition');
  const rigs: Array<[number, number, number, number, number]> = [
    [384, 104, 394, 112, 5],
    [412, 104, 426, 110, 5],
    [440, 126, 452, 132, 5],
    [466, 150, 476, 160, 5],
    [410, 186, 424, 196, 5],
    [450, 186, 462, 196, 5],
    [384, 178, 392, 186, 3],
  ];
  for (const [x0, z0, x1, z1, h] of rigs) b.block(x0, z0, x1, z1, lower, h, 'machine', 'test-rig');
  b.turretOnPedestal('T08', 449, 163, lower, 1, Math.PI, 'B4');
  b.beacon(449, 163, lower + 1, r.ceil);
  b.guard('G12', 458, 184, upper, Math.PI);
  b.floorPatch(382, 184, 394, 198, upper, 'hazard');
  b.wallTray('z', 478, -1, 116, 196, r.ceil, 'light-warm');
  b.wallTray('x', 198, -1, 400, 474, r.ceil, 'light-warm');
  for (const z of [130, 164]) b.truss('x', z, 384, 475.6, r.ceil);
  b.lamps(398, 120, 462, 180, r.ceil, 32, 20);
  for (let x = 392; x <= 472; x += 20) {
    for (let z = 110; z <= 190; z += 20) {
      if (inHole(x - 2, z - 0.6, x + 2, z + 0.6, 1.2)) continue;
      b.dec('box', 'light-cyan', x - 2, upper - 1.15, z - 0.6, x + 2, upper - 1, z + 0.6);
    }
  }
  b.warnLights('z', 382, 1, 186, 198, L.l5 + 8, 'light-amber');
  b.warnLights('x', 112, -1, 453, 467, L.l4 + 8, 'light-red');
}

/** S09 保守用配管区画 — narrow gallery at +34 with a chicane of full-height pipe blocks. Ends at barrier B4. */
export function buildGallery(l: Layout): void {
  const b = l.b;
  const r = l.rooms.gal;
  const f = r.floor;
  b.sectorId = 'S09';
  // Each block leaves a 6 m passage between itself and the pipe bundle on the opposite wall.
  b.solid(344, f, 193.5, 348, r.ceil, 198, 'pipe', 'pipe-block');
  b.solid(316, f, 186, 320, r.ceil, 190.5, 'pipe', 'pipe-block');
  b.solid(288, f, 193.5, 292, r.ceil, 198, 'pipe', 'pipe-block');
  b.solid(262, f, 186, 266, r.ceil, 190.5, 'pipe', 'pipe-block');
  // Pipe bundles along the walls (5.5 m high under an 8 m ceiling: nothing to stand on).
  b.solid(296, f, 196.5, 340, f + 5.5, 198, 'pipe', 'pipe-bundle');
  b.solid(270, f, 186, 312, f + 5.5, 187.5, 'rust', 'pipe-bundle');
  b.solid(324, f, 186, 362, f + 5.5, 187.5, 'pipe', 'pipe-bundle');
  b.solid(254, f, 196.5, 284, f + 5.5, 198, 'rust', 'pipe-bundle');
  for (const [x0, x1, z] of [[296, 340, 197.25], [254, 284, 197.25], [270, 312, 186.75], [324, 362, 186.75]] as const) {
    b.dec('cylinder-x', 'metal', x0 + 0.3, f + 5.5, z - 0.4, x1 - 0.3, f + 6.3, z + 0.4);
    b.dec('cylinder-x', 'pipe', x0 + 0.3, f + 6.3, z - 0.5, x1 - 0.3, f + 7.3, z + 0.5);
  }
  b.guard('G13', 302, 192, f, -Math.PI / 2);
  for (const x of [276, 304, 332, 360]) b.dec('box', 'light-warm', x - 2, r.ceil - 0.15, 191.4, x + 2, r.ceil, 192.6);
  b.dec('box', 'light-red', 254, f + 5.6, 197.8, 256, f + 6.4, 198, true);
  b.dec('box', 'light-red', 254, f + 5.6, 186, 256, f + 6.4, 186.2, true);
}

/** S10 動力棟 — arena 4: four generator sets (floor +26) under a control gallery and a centre catwalk (+34). Entry balcony +34, exit bay +40. */
export function buildPower(l: Layout): void {
  const b = l.b;
  const r = l.rooms.pow;
  const f = r.floor;
  b.sectorId = 'S10';
  b.platform(232, 176, 248, 198, L.l5, 1, 'catwalk', 'ws', 'entry-balcony');
  for (const [x, z] of [[233, 177], [247, 177]] as const) b.pillar(x, z, 1.2, f, L.l5 - 1, 'metal', 'post');
  for (const [cx, cz] of [[152, 130], [196, 130], [152, 170], [196, 170]] as const) {
    b.block(cx - 10, cz - 6, cx + 6, cz + 6, f, 5, 'machine', 'generator');
    b.block(cx + 6, cz - 6, cx + 10, cz - 2, f, 5, 'machine', 'generator');
    b.block(cx + 6, cz + 2, cx + 10, cz + 6, f, 5, 'machine', 'generator');
    b.solid(cx + 6, f, cz - 2, cx + 10, r.ceil, cz + 2, 'pipe', 'exhaust-stack');
  }
  for (const [x, z] of [[174, 150], [220, 150], [130, 158], [174, 188], [174, 112]] as const) b.pillar(x, z, 3, f, r.ceil);
  const transformers: Array<[number, number, number, number, number]> = [
    [222, 108, 230, 116, 5],
    [222, 122, 230, 130, 5],
    [128, 180, 136, 188, 4],
    [208, 186, 216, 194, 4],
    [124, 140, 130, 148, 4],
    [226, 160, 232, 168, 4],
  ];
  for (const [x0, z0, x1, z1, h] of transformers) b.block(x0, z0, x1, z1, f, h, b.pick(['metal', 'machine', 'rust']), 'transformer');
  // Control gallery (+34) along the north wall, continuous with the entry balcony.
  b.platform(130, 190, 232, 198, L.l5, 1, 'catwalk', 's', 'control-gallery');
  for (const x of [131, 164, 198, 231]) b.pillar(x, 190.6, 1, f, L.l5 - 1, 'metal', 'post');
  b.mastTurret('T09', 160, 112, f, r.ceil, Math.PI / 2);
  // Centre catwalk (+34) from the control gallery down the central aisle.
  b.platform(176, 120, 182, 190, L.l5, 1, 'catwalk', 'ew', 'centre-catwalk');
  for (const z of [124, 158, 186]) for (const x of [176.6, 181.4]) b.pillar(x, z, 1, f, L.l5 - 1, 'metal', 'post');
  // Two guards on the hall floor, one on the centre catwalk and one on the control gallery; catwalk and
  // gallery are continuous with the entry balcony the player arrives on.
  b.guard('G14', 236, 150, f, Math.PI / 2);
  b.guard('G15', 220, 140, f, Math.PI / 2);
  b.guard('G16', 179, 148, L.l5, Math.PI / 2);
  b.guard('G17', 206, 192.3, L.l5, Math.PI / 2);
  // Full-height blast walls: east of the take-off pad of climb F6 and below the entry balcony.
  b.solid(128.5, f, 102, 130, r.ceil, 124, 'concrete', 'blast-wall');
  b.solid(218, f, 170, 219.5, r.ceil, 182, 'concrete', 'blast-wall');
  b.floorPatch(112, 102, 124, 130, f, 'hazard');
  b.wallRack('x', 198, -1, 116, 170, f);
  b.wallTray('x', 198, -1, 114, 228, r.ceil, 'light-warm');
  b.wallTray('x', 102, 1, 130, 246, r.ceil, 'light-warm');
  b.wallTray('z', 248, -1, 104.4, 172, r.ceil, null);
  for (const x of [136, 182, 226]) b.truss('z', x, 104.2, 195.8, r.ceil);
  b.lamps(126, 116, 236, 182, r.ceil, 22, 22);
  b.warnLights('z', 112, 1, 104, 128, L.l6 + 8, 'light-amber');
}
