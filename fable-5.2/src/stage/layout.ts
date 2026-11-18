/**
 * Factory layout: room shells, sector bounds, doorways, flight bays, gatehouses, barriers, final gate.
 *
 * Plan (x east 0..480, z 0..400, y up). The facility climbs from the loading dock (floor 0) through six
 * halls to the cooling plant (floor +32, exit +46), drops 58 m down the exhaust shaft into the underground
 * conveyor level (-12) and leaves through the warehouse and the perimeter haul road (floor 0).
 *
 *   row 1 (z   0..100): S02 link / S01 dock | S03 yard | S04 rolling mill | S05 control room + S06 shaft | S07 assembly
 *   row 2 (z 100..200): S11 cooling | S10 power house | S09 pipe gallery | S08 inspection
 *   row 3 (z 200..300): S12 exhaust shaft | S13 conveyor tunnel | S14 main hall
 *   row 4 (z 300..400): S17 gate | S16 haul road | S15 warehouse
 *   side sectors: S05 control room (two doors to the mill), S18 parts gallery (walled-off mezzanine of the
 *   assembly hall) and S19 service gallery (walled-off mid-level gallery of the main hall) — covered detours.
 *
 * Altitude rule that makes every declared climb a genuine flight of at least 6 m: the landing of climb k
 * (L[k]) is 6 m above the landing of climb k-1, and nothing a player can stand on before climb k is higher
 * than L[k] - 6 (decks, catwalks, machine tops, pedestals, crates — everything taller reaches up to within
 * 4 m of a ceiling, so its top is not a resting place). tools/validateStage.ts measures this (V6: the
 * jump-only closure with a 5.5 m "super jump" must not get past any cut).
 */
import { v3, type V3 } from '../core/vec';
import type { Box } from '../sim/types';
import { StageBuilder, box, type Room } from './builder';

/** Landing heights of the seven declared climbs. */
export const L = { l1: 10, l2: 16, l3: 22, l4: 28, l5: 34, l6: 40, l7: 46 } as const;

export const BOUNDS: Box = box(-8, -48, -8, 488, 68, 408);
export const KILL_Y = -30;
export const PIT_BOTTOM = BOUNDS.min.y;

export interface Rooms {
  link: Room;
  dock: Room;
  yard: Room;
  mill: Room;
  ctrl: Room;
  shaft: Room;
  asm: Room;
  insp: Room;
  gal: Room;
  pow: Room;
  cool: Room;
  exh: Room;
  tun: Room;
  main: Room;
  ware: Room;
  road: Room;
  gate: Room;
}

export interface FlightSpot {
  id: string;
  sectorId: string;
  from: V3;
  to: V3;
  height: number;
  cut: Box;
  note: string;
}

export interface Layout {
  b: StageBuilder;
  rooms: Rooms;
  flightSpots: FlightSpot[];
  finalGate: { id: string; name: string; box: Box };
  exitZone: Box;
}

/** Player hit-box centre standing on a surface at height `y`. */
export const stand = (x: number, surfaceY: number, z: number): V3 => v3(x, surfaceY + 2, z);

export function buildLayout(): Layout {
  const b = new StageBuilder();
  const mk = (id: string, x0: number, x1: number, z0: number, z1: number, floor: number, ceil: number): Room => {
    b.sectorId = id;
    return b.room({ x0, x1, z0, z1, floor, ceil });
  };
  const rooms: Rooms = {
    link: mk('S02', 0, 100, 0, 16, 0, 10),
    dock: mk('S01', 0, 40, 16, 100, 0, 12),
    yard: mk('S03', 40, 170, 16, 100, 0, 26),
    mill: mk('S04', 170, 310, 0, 100, 4, 28),
    ctrl: mk('S05', 310, 350, 50, 100, 4, 14),
    shaft: mk('S06', 310, 350, 0, 50, 10, 60),
    asm: mk('S07', 350, 480, 0, 100, 14, 40),
    insp: mk('S08', 380, 480, 100, 200, 18, 46),
    gal: mk('S09', 250, 380, 184, 200, 34, 42),
    pow: mk('S10', 110, 250, 100, 200, 26, 52),
    cool: mk('S11', 0, 110, 100, 200, 32, 58),
    exh: mk('S12', 0, 50, 200, 250, -12, 62),
    tun: mk('S13', 50, 250, 200, 270, -12, -3),
    main: mk('S14', 250, 480, 200, 300, -12, 30),
    ware: mk('S15', 330, 480, 300, 400, 0, 20),
    road: mk('S16', 60, 330, 370, 400, 0, 12),
    gate: mk('S17', 0, 60, 270, 400, 0, 16),
  };
  const r = rooms;
  const rb = (room: Room): Box => b.roomBounds(room);

  // ── sectors ──
  // Bounds = room shells (the dock gives its south wall with the doorway to the link). A sector ends at its
  // barrier: the gatehouse behind a flight bay — the walled landing in front of the barrier door — belongs to the
  // sector it is entered from (GH1 → S03, GH2 → S06, GH3 → S07, GH5 → S11), although it stands inside the next
  // room's shell; the boundary runs through the middle of the barrier wall and of the gatehouse slab.
  const gh1 = box(170, 9, 68, 183, 30, 100);
  const gh2 = box(350, 21, 0, 363, 42, 50);
  const gh3 = box(440, 27, 100, 480, 48, 113);
  const gh5 = box(0, 45, 200, 40, 64, 213);
  b.sector('S01', '搬入口', 'Loading dock', 'dock', [box(0, -2, 18, 40, 14, 100)]);
  b.sector('S02', '検問連絡路', 'Checkpoint link', 'corridor', [rb(r.link), box(0, -2, 16, 40, 14, 18)]);
  b.sector('S03', '資材ヤード', 'Material yard', 'yard', [rb(r.yard), gh1], true);
  b.sector('S04', '圧延棟', 'Rolling mill', 'factory', [box(170, 2, 0, 310, 30, 68), box(183, 2, 68, 310, 30, 100), box(170, 2, 68, 183, 9, 100), box(213, PIT_BOTTOM, 21, 231, 2, 37)], true);
  b.sector('S05', '圧延制御室', 'Mill control room', 'factory', [rb(r.ctrl)]);
  b.sector('S06', '搬送縦坑', 'Transfer shaft', 'shaft', [rb(r.shaft), gh2]);
  // S07 = assembly hall without the enclosed parts gallery on the mezzanine (S18), plus the gatehouse of B3.
  b.sector('S07', '組立ライン', 'Assembly line', 'multilevel', [box(350, 12, 0, 480, 21, 100), box(363, 21, 0, 372, 42, 50), box(350, 21, 50, 372, 42, 100), box(372, 21, 20, 460, 42, 100), box(460, 21, 98, 480, 42, 100), gh3], true);
  b.sector('S08', '検査棟', 'Inspection building', 'multilevel', [box(380, 16, 113, 480, 48, 200), box(380, 16, 100, 440, 48, 113), box(440, 16, 100, 480, 27, 113)]);
  b.sector('S09', '保守用配管区画', 'Pipe gallery', 'corridor', [rb(r.gal)]);
  b.sector('S10', '動力棟', 'Power house', 'plant', [rb(r.pow)], true);
  b.sector('S11', '冷却設備', 'Cooling plant', 'plant', [rb(r.cool), gh5], true);
  b.sector('S12', '排気縦坑', 'Exhaust shaft', 'shaft', [box(0, -14, 213, 50, 64, 250), box(40, -14, 200, 50, 64, 213), box(0, -14, 200, 40, 45, 213)]);
  b.sector('S13', '地下搬送区画', 'Underground conveyor tunnel', 'tunnel', [rb(r.tun), box(103, PIT_BOTTOM, 212, 119, -14, 221)]);
  // S14 = main hall without the enclosed service gallery at mid level (S19).
  b.sector('S14', '主製造ホール', 'Main production hall', 'multilevel', [box(250, -14, 200, 480, -1, 300), box(250, -1, 220, 458, 32, 300)], true);
  b.sector('S15', '出荷倉庫', 'Shipping warehouse', 'warehouse', [rb(r.ware)], true);
  b.sector('S16', '外周搬送路', 'Perimeter haul road', 'road', [rb(r.road)]);
  b.sector('S17', '搬出ゲート', 'Exit gate', 'gate', [rb(r.gate)]);
  b.sector('S18', '部品搬送回廊', 'Parts gallery', 'corridor', [box(372, 21, 0, 480, 42, 20), box(460, 21, 20, 480, 42, 98)]);
  b.sector('S19', '保守回廊', 'Service gallery', 'corridor', [box(250, -1, 200, 480, 32, 220), box(458, -1, 220, 480, 32, 300)]);

  // ── plain doorways ──
  b.carve(14, 0, 14, 26, 8, 18); // D1 dock → link
  b.carve(76, 0, 14, 92, 8, 18); // D2 link → yard
  b.carve(308, 4, 56, 312, 11, 66); // mill ↔ control room (south door)
  b.carve(308, 4, 84, 312, 11, 94); // mill ↔ control room (north door)
  b.carve(248, 34, 186, 252, 42, 198); // gallery → power house (barrier B4)
  b.carve(48, -12, 206, 52, -4, 218); // exhaust shaft → tunnel
  b.carve(248, -12, 206, 252, -4, 218); // tunnel → main hall
  b.carve(444, 0, 298, 468, 8, 302); // main hall mid level → warehouse (barrier B6)
  b.carve(328, 0, 374, 332, 8, 396); // warehouse → haul road
  b.carve(58, 0, 374, 62, 8, 396); // haul road → gate hall

  // ── flight bays (openings high in a wall; the landing lies behind the opening) ──
  b.carve(168, L.l1, 72, 172, L.l1 + 8, 96); // F1 yard → mill
  b.carve(308, L.l2, 6, 312, L.l2 + 8, 30); // F2 mill → shaft
  b.carve(348, L.l3, 14, 352, L.l3 + 8, 44); // F3 shaft → assembly
  b.carve(446, L.l4, 98, 474, L.l4 + 8, 102); // F4 assembly → inspection
  b.carve(378, L.l5, 186, 382, L.l5 + 8, 198); // F5 inspection → gallery
  b.carve(108, L.l6, 104, 112, L.l6 + 8, 128); // F6 power house → cooling
  b.carve(6, L.l7, 198, 34, L.l7 + 8, 202); // F7 cooling → exhaust shaft

  // ── gatehouses: enclosed landing behind a flight bay, closed by a barrier door, then a drop-off lip ──
  // GH1 (mill, barrier B1)
  b.sectorId = 'S04';
  b.platform(172, 68, 190, 98, L.l1, 1, 'concrete', 'es', 'gatehouse-slab');
  b.shell(172, L.l1, 68, 182, r.mill.ceil, 70, 'wall', 'gatehouse-wall');
  b.shell(182, L.l1, 68, 184, r.mill.ceil, 98, 'wall', 'gatehouse-wall');
  b.carve(182, L.l1, 77, 184, L.l1 + 8, 91);
  for (const z of [69, 97]) b.pillar(189, z, 1.2, r.mill.floor, L.l1 - 1, 'metal', 'gatehouse-post');
  b.pillar(177, 69, 1.2, r.mill.floor, L.l1 - 1, 'metal', 'gatehouse-post');
  // GH2 (assembly, barrier B2)
  b.sectorId = 'S07';
  b.platform(352, 2, 372, 50, L.l3, 1, 'concrete', '', 'gatehouse-slab');
  b.shell(352, L.l3, 48, 362, r.asm.ceil, 50, 'wall', 'gatehouse-wall');
  b.shell(362, L.l3, 2, 364, r.asm.ceil, 50, 'wall', 'gatehouse-wall');
  b.carve(362, L.l3, 22, 364, L.l3 + 8, 36);
  // Vestibule behind B2: closed towards the hall except for the balcony gate (drop into the hall);
  // its south end leads into the enclosed parts gallery (S18).
  b.shell(364, L.l3, 49, 372, r.asm.ceil, 50, 'wall', 'gatehouse-wall');
  b.shell(371, L.l3, 20, 372, r.asm.ceil, 49, 'wall', 'gatehouse-wall');
  b.carve(371, L.l3, 28, 372, L.l3 + 8, 44);
  b.floorPatch(369.5, 28, 372, 44, L.l3, 'hazard');
  for (const x of [357, 371]) b.pillar(x, 49, 1.2, r.asm.floor, L.l3 - 1, 'metal', 'gatehouse-post');
  // GH3 (inspection, barrier B3) — sits 2 m above the upper inspection floor (+26)
  b.sectorId = 'S08';
  b.shell(440, 26, 102, 478, L.l4, 121, 'concrete', 'gatehouse-slab');
  b.shell(440, 26, 121, 478, L.l4, 122, 'hazard', 'gatehouse-slab');
  b.shell(440, L.l4, 102, 442, r.insp.ceil, 114, 'wall', 'gatehouse-wall');
  b.shell(442, L.l4, 112, 478, r.insp.ceil, 114, 'wall', 'gatehouse-wall');
  b.carve(453, L.l4, 112, 467, L.l4 + 8, 114);
  // Fin that keeps the parts gallery (S18) side of the bay out of sight of the assembly hall.
  b.shell(460, L.l4, 98, 461, L.l4 + 8, 102, 'wall', 'gatehouse-wall');
  b.shell(460, L.l4, 102, 461, r.insp.ceil, 108, 'wall', 'gatehouse-wall');
  // GH5 (exhaust shaft top, barrier B5)
  b.sectorId = 'S12';
  b.platform(2, 202, 40, 220, L.l7, 1, 'concrete', 'ne', 'gatehouse-slab');
  b.shell(38, L.l7, 202, 40, r.exh.ceil, 212, 'wall', 'gatehouse-wall');
  b.shell(2, L.l7, 212, 40, r.exh.ceil, 214, 'wall', 'gatehouse-wall');
  b.carve(13, L.l7, 212, 27, L.l7 + 8, 214);

  // ── final gate wall inside the gate hall ──
  b.sectorId = 'S17';
  b.shell(2, 0, 300, 58, 16, 304, 'wall', 'gate-wall');
  b.carve(18, 0, 300, 42, 10, 304);

  // ── barriers (each box fills its doorway completely) ──
  b.barrier('B1', '第1隔壁（圧延棟入口）', box(182, L.l1, 77, 184, L.l1 + 8, 91), 'T01', 'S03', 'S04');
  b.barrier('B2', '第2隔壁（組立ライン入口）', box(362, L.l3, 22, 364, L.l3 + 8, 36), 'T04', 'S06', 'S07');
  b.barrier('B3', '第3隔壁（検査棟入口）', box(453, L.l4, 112, 467, L.l4 + 8, 114), 'T06', 'S07', 'S08');
  b.barrier('B4', '第4隔壁（動力棟入口）', box(249, 34, 186, 251, 42, 198), 'T08', 'S09', 'S10');
  b.barrier('B5', '第5隔壁（排気縦坑入口）', box(13, L.l7, 212, 27, L.l7 + 8, 214), 'T11', 'S11', 'S12');
  b.barrier('B6', '第6隔壁（出荷倉庫入口）', box(444, 0, 299, 468, 8, 301), 'T14', 'S14', 'S15');

  const flightSpots: FlightSpot[] = [
    { id: 'F1', sectorId: 'S03', from: stand(163, 0, 84), to: stand(177, L.l1, 84), height: 10, cut: box(165, 9, 71, 174, 19, 97), note: '資材ヤード東壁の搬入開口(+10 m)へ上昇' },
    { id: 'F2', sectorId: 'S04', from: stand(303, 4, 18), to: stand(317, L.l2, 18), height: 12, cut: box(305, 15, 5, 314, 25, 31), note: '圧延棟南東の開口(+16 m)から搬送縦坑へ' },
    { id: 'F3', sectorId: 'S06', from: stand(343, 10, 29), to: stand(357, L.l3, 29), height: 12, cut: box(345, 21, 13, 354, 31, 45), note: '搬送縦坑の底(+10 m)から組立ライン入口(+22 m)へ' },
    { id: 'F4', sectorId: 'S07', from: stand(452, 14, 93), to: stand(452, L.l4, 107), height: 14, cut: box(445, 27, 95, 475, 37, 104), note: '組立ライン北東の開口(+28 m)から検査棟へ' },
    { id: 'F5', sectorId: 'S08', from: stand(387, 26, 192), to: stand(372, L.l5, 192), height: 8, cut: box(376, 33, 185, 385, 43, 199), note: '検査棟上階(+26 m)から配管区画(+34 m)へ' },
    { id: 'F6', sectorId: 'S10', from: stand(117, 26, 116), to: stand(103, L.l6, 116), height: 14, cut: box(106, 39, 103, 115, 49, 129), note: '動力棟南西の開口(+40 m)から冷却設備へ' },
    { id: 'F7', sectorId: 'S11', from: stand(10, 32, 194), to: stand(10, L.l7, 207), height: 14, cut: box(5, 45, 195, 35, 55, 204), note: '冷却設備北西の開口(+46 m)から排気縦坑上部へ' },
  ];

  return {
    b,
    rooms,
    flightSpots,
    finalGate: { id: 'GATE', name: '最終搬出ゲート', box: box(18, 0, 301, 42, 10, 303) },
    exitZone: box(4, 0, 274, 56, 12, 298),
  };
}
