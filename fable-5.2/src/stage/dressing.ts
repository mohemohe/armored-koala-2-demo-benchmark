/**
 * Second dressing pass over the finished sectors.
 *  - dressFactory: wall piers, corner risers, ceiling ducts, rubble. Collidable (SolidDef) and low-impact: piers
 *    hug the walls, ducts hang directly under the roofs and rubble stays below 1.4 m, so sight lines, routes
 *    and flight spots are unaffected.
 *  - signFactory: wayfinding and character that needs no collision — painted / illuminated markings
 *    (MarkingDef: flight-bay signs, barrier ids at the doors and at their control turrets, exit signs, lane
 *    arrows, zone and level numbers) and a few thin lamps and sign boards hung under ceilings.
 */
import { L, type Layout } from './layout';

export function dressFactory(l: Layout): void {
  const b = l.b;
  const r = l.rooms;

  // S03 material yard
  b.sectorId = 'S03';
  b.pilasters('z', 168, -1, [30, 46, 62], 0, r.yard.ceil);
  b.pilasters('x', 18, 1, [56, 104, 120, 136, 152], 0, r.yard.ceil);
  b.pilasters('x', 98, -1, [62, 76, 146, 160], 0, r.yard.ceil);
  b.duct('x', 60, 44, 166, r.yard.ceil);
  b.solid(165.5, 0, 18, 168, r.yard.ceil, 20.5, 'pipe', 'riser');
  b.rubble(146, 20, 166, 25, 0, 5);

  // S04 rolling mill
  b.sectorId = 'S04';
  b.pilasters('x', 98, -1, [200, 216, 300], r.mill.floor, r.mill.ceil);
  b.pilasters('z', 172, 1, [34, 46, 58], r.mill.floor, r.mill.ceil);
  b.pilasters('z', 308, -1, [40, 48, 74], r.mill.floor, r.mill.ceil);
  b.duct('x', 50, 186, 306, r.mill.ceil);
  b.solid(305.5, r.mill.floor, 95.5, 308, r.mill.ceil, 98, 'pipe', 'riser');
  b.rubble(174, 30, 180, 44, r.mill.floor, 4);

  // S07 assembly line
  b.sectorId = 'S07';
  b.pilasters('z', 352, 1, [60, 80], r.asm.floor, r.asm.ceil);
  b.duct('x', 64, 366, 458, r.asm.ceil);
  b.rubble(354, 52, 362, 64, r.asm.floor, 4);

  // S08 inspection building: debris of the collapsed upper floor under opening H1
  b.sectorId = 'S08';
  b.rubble(407, 127, 421, 143, r.insp.floor, 7);
  b.duct('z', 446, 116, 196, r.insp.ceil);

  // S10 power house
  b.sectorId = 'S10';
  b.pilasters('z', 112, 1, [140, 156, 172, 188], r.pow.floor, r.pow.ceil);
  b.pilasters('x', 102, 1, [140, 160, 200, 216], r.pow.floor, r.pow.ceil);
  b.duct('x', 147, 114, 246, r.pow.ceil);
  b.solid(245.5, r.pow.floor, 102, 248, r.pow.ceil, 104.5, 'pipe', 'riser');
  b.rubble(236, 106, 246, 114, r.pow.floor, 4);

  // S11 cooling plant
  b.sectorId = 'S11';
  b.duct('z', 80, 104, 196, r.cool.ceil);
  b.solid(105.5, r.cool.floor, 195.5, 108, r.cool.ceil, 198, 'pipe', 'riser');
  b.rubble(98, 186, 106, 196, r.cool.floor, 4);

  // S13 tunnel: debris beside the collapsed floor
  b.sectorId = 'S13';
  b.rubble(120, 214, 130, 219.5, r.tun.floor, 4);
  b.rubble(52.5, 261, 58, 267.5, r.tun.floor, 4);

  // S14 main hall
  b.sectorId = 'S14';
  b.pilasters('z', 252, 1, [232, 250, 268], r.main.floor, r.main.ceil);
  b.duct('x', 226, 254, 457, r.main.ceil);
  b.solid(252, r.main.floor, 295.5, 254.5, r.main.ceil, 298, 'pipe', 'riser');
  b.rubble(256, 284, 270, 296, r.main.floor, 5);
  b.rubble(462, 204, 476, 216, r.main.floor, 4);

  // S15 warehouse
  b.sectorId = 'S15';
  b.pilasters('x', 302, 1, [350, 380, 412], 0, r.ware.ceil);
  b.duct('x', 342, 334, 476, r.ware.ceil);
  b.rubble(468, 304, 476, 312, 0, 3);

  // S16 haul road: debris from the cracked roof
  b.sectorId = 'S16';
  b.duct('x', 389, 64, 326, r.road.ceil, 2);
  b.rubble(156, 374, 168, 378, 0, 4);
  b.rubble(300, 390, 312, 396, 0, 4);

  // S17 gate hall
  b.sectorId = 'S17';
  b.pilasters('z', 2, 1, [324, 344, 364, 384], 0, r.gate.ceil);
  b.pilasters('z', 58, -1, [324, 344, 364], 0, r.gate.ceil);
  b.rubble(44, 360, 56, 370, 0, 4);

  signFactory(l);
}

/**
 * Wayfinding in the world (docs/SPEC.md §2.1: the control turrets and the way on must be recognisable):
 *  - every climb that needs flight: hazard-framed bay, a column of running amber up-chevrons and the climb's id
 *    on the wall below the sill, the id on the take-off pad;
 *  - every barrier: its id above the doorway (red while locked, green once open) and the same id, in red, at
 *    its control turret (mast / tower / pedestal / floor / hanging board) until the barrier opens;
 *  - the final gate: EXIT above it, red while locked and green once open;
 *  - zone numbers at the entrances, level marks in the exhaust shaft, lane arrows along the way out.
 * Everything is render-only paint or light except the two thin sign boards hung under the cooling plant's roof.
 */
function signFactory(l: Layout): void {
  const b = l.b;
  const r = l.rooms;

  // ── flight bays ──
  b.sectorId = 'S03';
  b.flightSign('F1', 'z', 168, -1, 72, 96, 0, L.l1);
  b.sectorId = 'S04';
  b.flightSign('F2', 'z', 308, -1, 6, 30, r.mill.floor, L.l2);
  b.sectorId = 'S06';
  b.flightSign('F3', 'z', 348, -1, 14, 44, r.shaft.floor, L.l3);
  b.sectorId = 'S07';
  b.flightSign('F4', 'x', 98, -1, 446, 460, r.asm.floor, L.l4, { c: 452, jambs: 'low' });
  b.sectorId = 'S18';
  b.flightSign('F4', 'x', 98, -1, 461, 474, L.l3, L.l4, { c: 468, jambs: 'high', pad: false });
  b.sectorId = 'S08';
  b.flightSign('F5', 'z', 382, 1, 186, 198, 26, L.l5, { jambs: 'low' });
  b.sectorId = 'S10';
  b.flightSign('F6', 'z', 112, 1, 104, 128, r.pow.floor, L.l6, { c: 116 });
  b.sectorId = 'S11';
  b.flightSign('F7', 'x', 198, -1, 6, 34, r.cool.floor, L.l7, { c: 10 });

  // Main hall: the climb from the bottom floor to the north gallery (0 m) in front of barrier B6 has no wall
  // below it — chevrons on the gallery's edge and on the wall under it, the pad is marked on the floor.
  b.sectorId = 'S14';
  for (let i = 0; i < 4; i++) b.mark('z-', 447.5 + i * 3, -0.5, 280, 2.2, 0.8, 'glow-amber', '^', { chase: i * 0.12 });
  for (let i = 0; i < 3; i++) for (const x of [446.6, 457.4]) b.mark('z-', x, -8.6 + i * 2.4, 298, 3.2, 1.5, 'glow-amber', '^', { chase: i * 0.25 });
  b.mark('y+', 452, r.main.floor, 270, 7.6, 3.4, 'dark', undefined, { top: 'z+' });
  b.mark('y+', 452, r.main.floor, 270, 6.6, 2.4, 'white', '^ B6', { top: 'z+' });
  // Vestibule: the hatch up into the service gallery (covered detour) is signposted in cyan.
  b.mark('x-', 271, -6.4, 209, 6.2, 2.2, 'glow-cyan', '^ S19');
  b.mark('y+', 262, r.main.floor, 209, 7, 3, 'dark', undefined, { top: 'x+' });
  b.mark('y+', 262, r.main.floor, 209, 6, 2, 'white', '^ S19', { top: 'x+' });

  // ── barrier ids above the doorways (approach side) ──
  b.sectorId = 'S03';
  b.doorSign('B1', 'z', 182, -1, 84, L.l1 + 8);
  b.sectorId = 'S06';
  b.doorSign('B2', 'z', 362, -1, 29, L.l3 + 8);
  b.sectorId = 'S07';
  b.doorSign('B3', 'x', 112, -1, 460, L.l4 + 8);
  b.sectorId = 'S09';
  // B4 fills the gallery up to its ceiling: the id goes on both side walls in front of it
  for (const [f, z] of [['z+', 186], ['z-', 198]] as const) {
    if (f === 'z-') continue; // the north wall carries the pipe bundle there
    b.mark(f, 258.6, 39.4, z, 3.8, 2.3, 'dark');
    b.mark(f, 258.6, 39.4, z, 2.9, 1.6, 'glow-red', 'B4', { until: 'B4' });
    b.mark(f, 258.6, 39.4, z, 2.9, 1.6, 'glow-green', 'B4', { after: 'B4' });
  }
  b.sectorId = 'S11';
  b.doorSign('B5', 'x', 212, -1, 20, L.l7 + 8);
  b.sectorId = 'S14';
  b.doorSign('B6', 'x', 298, -1, 451, 8);
  b.sectorId = 'S19';
  b.doorSign('B6', 'x', 298, -1, 463.5, 8, 1.5);

  // ── the same ids at the control turrets (go out when the barrier opens) ──
  b.sectorId = 'S03';
  b.columnTag('B1', 139, 28, 0.8, 15, 1.3); // T01, mast
  b.sectorId = 'S07';
  b.columnTag('B3', 360, 90, 0.8, 28, 1.3); // T06, mast
  b.sectorId = 'S14';
  b.columnTag('B6', 366, 264, 2, -3.2, 2.6); // T14, gun tower
  // T04 (control room): pedestal faces + the wall behind it
  b.sectorId = 'S05';
  for (const [f, x, z] of [['x+', 343, 75], ['x-', 339, 75], ['z+', 341, 77], ['z-', 341, 73]] as const) {
    b.mark(f, x, 4.75, z, 3, 1.3, 'dark');
    b.mark(f, x, 4.75, z, 2.2, 1.05, 'glow-red', 'B2', { until: 'B2' });
  }
  b.mark('x-', 348, 10.6, 75, 5.2, 3, 'dark');
  b.mark('x-', 348, 10.6, 75, 4.2, 2.2, 'glow-red', 'B2', { until: 'B2' });
  // T08 (inspection, lower storey under floor opening H2): on the floor around the pedestal, read from above.
  // All four are laid out for the side the route arrives from (the firing position at the south edge of the
  // opening, looking +z): seen from there every one of them reads upright. (Laid out as a ring — each with its
  // top towards the turret — three of the four were seen sideways / upside down from that edge and read as
  // mirrored glyphs.)
  b.sectorId = 'S08';
  for (const [x, z] of [[449, 157.4], [449, 168.6], [443.4, 163], [454.6, 163]] as const) {
    b.mark('y+', x, r.insp.floor, z, 4.6, 2.8, 'dark', undefined, { top: 'z+' });
    b.mark('y+', x, r.insp.floor, z, 3.8, 2.1, 'glow-red', 'B4', { top: 'z+', until: 'B4' });
  }
  // T11 (cooling plant, on the catwalk): on the catwalk beside it and on two crossed boards hung under the roof
  b.sectorId = 'S11';
  for (const [x, top] of [[50.2, 'x+'], [59.8, 'x-']] as const) {
    b.mark('y+', x, L.l6, 153, 4.4, 2.6, 'dark', undefined, { top });
    b.mark('y+', x, L.l6, 153, 3.6, 2, 'glow-red', 'B5', { top, until: 'B5' });
  }
  {
    const y0 = r.cool.ceil - 3.7;
    const y1 = r.cool.ceil - 0.7;
    b.dec('box', 'metal', 52.4, y0, 152.95, 57.6, y1, 153.05);
    b.dec('box', 'metal', 54.95, y0, 150.4, 55.05, y1, 155.6);
    for (const [x, z] of [[53, 153], [57, 153], [55, 151], [55, 155]] as const) b.dec('cylinder-y', 'metal', x - 0.05, y1, z - 0.05, x + 0.05, r.cool.ceil, z + 0.05);
    const yc = (y0 + y1) / 2;
    for (const [f, x, z] of [['z+', 55, 153.05], ['z-', 55, 152.95], ['x+', 55.05, 153], ['x-', 54.95, 153]] as const) {
      b.mark(f, x, yc, z, 5, 2.9, 'dark');
      b.mark(f, x, yc + 0.35, z, 3.6, 1.9, 'glow-red', 'B5', { until: 'B5' });
      b.mark(f, x, yc - 1.05, z, 1.3, 0.6, 'glow-red', 'v', { until: 'B5' });
    }
  }

  // ── final gate: EXIT above it (red while locked, green once open), lane chevrons on the floor towards it ──
  b.sectorId = 'S17';
  b.mark('z+', 30, 13.5, 304, 17, 3.6, 'dark');
  b.mark('z+', 30, 13.5, 304, 15.6, 2.7, 'glow-red', 'v EXIT v', { until: 'GATE' });
  b.mark('z+', 30, 13.5, 304, 15.6, 2.7, 'glow-green', 'v EXIT v', { after: 'GATE' });
  for (const z of [322, 334, 346]) b.mark('y+', 30, 0, z, 5, 2.2, 'yellow', '^', { top: 'z-' });
  b.mark('z-', 30, 12.6, 398, 12, 2.4, 'white', 'S17 EXIT');

  // ── way out: lane markings of the haul road (west = towards the gate hall) ──
  b.sectorId = 'S16';
  for (let x = 76; x <= 316; x += 16) b.mark('y+', x, 0, 385, 5, 0.35, 'yellow', undefined, { top: 'x-' });
  for (const x of [300, 228, 190, 132, 74]) b.mark('y+', x, 0, 381.2, 2.4, 3.4, 'white', '<', { top: 'z-' });
  for (const x of [300, 190, 74]) b.mark('y+', x - 8, 0, 385, 8, 2.6, 'white', 'EXIT', { top: 'x-' });
  b.mark('z-', 196, 6.4, 398, 16, 2.4, 'white', '< S17 EXIT');
  b.mark('x+', 62, 9.6, 385, 9, 1.2, 'glow-amber', '< < <', { chase: 0 });

  // ── zone numbers at the entrances (stencil paint) and direction arrows through the plain connectors ──
  b.sectorId = 'S01';
  b.mark('z+', 8, 9.6, 18, 5.4, 2.2, 'white', 'S01');
  b.mark('z+', 20, 10.6, 18, 4.4, 1, 'glow-amber', 'v v v', { chase: 0 });
  b.sectorId = 'S02';
  b.mark('x+', 2, 7, 8, 5.4, 2.2, 'white', 'S02');
  b.mark('z-', 48, 7, 14, 7, 1.8, 'white', '> S03');
  b.mark('z+', 58, 7.6, 2, 9, 1.1, 'glow-amber', '> > >', { chase: 0 });
  b.mark('y+', 68, 0, 8, 11.6, 0.5, 'yellow', undefined, { top: 'x+' });
  b.mark('y+', 61.6, 0, 8, 6.4, 2.2, 'yellow', 'STOP', { top: 'x+' });
  b.sectorId = 'S03';
  b.mark('z+', 96, 11, 18, 6.4, 2.6, 'white', 'S03');
  b.mark('x-', 168, 21.5, 84, 7, 2.2, 'white', 'S04');
  b.sectorId = 'S04';
  b.mark('x-', 308, 13.4, 61, 4.6, 1.8, 'white', 'S05');
  b.mark('x-', 308, 26.6, 18, 7, 1.8, 'white', 'S06');
  b.sectorId = 'S06';
  b.mark('x-', 348, 33.5, 29, 7, 2.4, 'white', 'S07');
  b.sectorId = 'S07';
  b.mark('z-', 453, 38.2, 98, 7, 1.8, 'white', 'S08');
  b.sectorId = 'S08';
  b.mark('x+', 382, 44, 192, 6, 2, 'white', 'S09');
  b.sectorId = 'S09';
  // lane arrows come in pairs beside the walking line (the mech covers the centre line in the chase view)
  for (const x of [366, 330, 302, 276]) for (const z of [189.6, 194.4]) b.mark('y+', x, r.gal.floor, z, 2.4, 2.4, 'yellow', '<', { top: 'z-' });
  b.mark('z+', 372, 39.4, 186, 5, 2, 'white', 'S09');
  b.sectorId = 'S10';
  b.mark('x+', 112, 50.2, 116, 6, 1.9, 'white', 'S11');
  b.sectorId = 'S11';
  b.mark('z-', 20, 56, 198, 6, 1.9, 'white', 'S12');
  // S12 exhaust shaft: level marks beside the platforms on the way down, the exit door at the bottom
  b.sectorId = 'S12';
  for (const [x, y, t] of [[37, 49.5, '+46'], [37, 33.6, '+30'], [13, 17.6, '+14'], [37, 2.6, '-01'], [13, -8.4, '-12']] as const) {
    b.mark('z-', x, y, 248, 6.4, 2.6, 'white', t);
    b.mark('z-', x, y - 2.2, 248, 6.4, 0.3, 'yellow');
  }
  for (const [y, c] of [[38, 0], [22, 0.25], [6, 0.5]] as const) b.mark('x+', 2, y, 238, 5, 1.6, 'glow-amber', 'v', { chase: c });
  b.mark('x-', 48, -2.4, 212, 9, 1.8, 'glow-amber', '> S13 >', { chase: 0 });
  b.sectorId = 'S13';
  b.mark('x+', 52, -6.4, 226, 5.4, 2.2, 'white', 'S13');
  for (const x of [96, 146, 196, 228]) for (const z of [207.6, 212.6]) b.mark('y+', x, r.tun.floor, z, 2.2, 2.2, 'yellow', '>', { top: 'z-' });
  b.sectorId = 'S14';
  b.mark('z-', 262, -2.6, 219, 9, 1.5, 'glow-amber', '^ S14 ^');
  b.sectorId = 'S15';
  b.mark('z+', 440, 13, 302, 6.4, 2.6, 'white', 'S15');
  b.mark('x+', 332, 10.6, 385, 9, 1.6, 'glow-amber', '< S16 <', { chase: 0 });
  for (const x of [444, 414, 380, 350]) for (const z of [311.4, 317.6]) b.mark('y+', x, 0, z, 2.4, 2.4, 'yellow', '<', { top: 'z-' });
  // Detour galleries: zone numbers and arrows towards the next barrier
  b.sectorId = 'S18';
  b.mark('z+', 384, 28, 2, 6.4, 2.6, 'white', 'S18');
  for (const x of [388, 414, 442]) for (const z of [8, 14]) b.mark('y+', x, L.l3, z, 2.4, 2.4, 'yellow', '>', { top: 'z-' });
  for (const z of [30, 54, 76]) for (const x of [466.4, 471.6]) b.mark('y+', x, L.l3, z, 2.4, 2.4, 'yellow', '^', { top: 'z+' });
  b.sectorId = 'S19';
  b.mark('z+', 290, 6, 202, 6.4, 2.6, 'white', 'S19');
  for (const x of [300, 330, 370, 410, 446]) for (const z of [207.4, 214.6]) b.mark('y+', x, 0, z, 2.4, 2.4, 'yellow', '>', { top: 'z-' });
  for (const z of [244, 270]) for (const x of [465.6, 471.4]) b.mark('y+', x, 0, z, 2.4, 2.4, 'yellow', '^', { top: 'z+' });

  // ── thin lamps under mezzanines (cyan service lights, flush under the slab, more than 5 m above the floor) ──
  b.sectorId = 'S07';
  const under = L.l3 - 1;
  for (const x of [388, 404, 436]) b.dec('box', 'light-cyan', x - 2, under - 0.15, 10.4, x + 2, under, 11.6);
  for (const z of [30, 54, 78]) b.dec('box', 'light-cyan', 468.4, under - 0.15, z - 2, 469.6, under, z + 2);
  for (const z of [14, 38]) b.dec('box', 'light-cyan', 361.4, under - 0.15, z - 2, 362.6, under, z + 2);
  b.sectorId = 'S10';
  for (const x of [150, 190, 222]) b.dec('box', 'light-cyan', x - 2, L.l5 - 1.15, 193, x + 2, L.l5 - 1, 194.2);
  b.dec('box', 'light-cyan', 238, L.l5 - 1.15, 187.4, 242, L.l5 - 1, 188.6);
}
