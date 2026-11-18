// Stage definition: a single connected abandoned factory.
// All geometry is axis-aligned boxes shared by collision, LOS and rendering.
// Every sector is sealed (walls + ceiling) so flight cannot skip sections.
//
// Barrier chain (control turret -> barrier -> next section):
//   TC1 (pipes)      -> B1  conn->inspection door     -> east wing
//   TC2 (power)      -> B2  inspection->corridor door -> assembly route
//   TC3 (assembly)   -> B3a conveyor slab @x20
//                    -> B3b assembly->mainhall door   -> east block (C4 zone)
//   TC4 (underground)-> B4  gantry niche entry        -> C5
//   TC5 (gantry)     -> B5  power->boiler hatch grate -> C6
//   TC6 (boiler)     -> B6  FINAL GATE (all six dead) -> escape zone
//
// Forced zigzag: west(pipes) -> power -> west(assembly) -> east(underground)
//              -> west(gantry) -> east(boiler) -> exit gate.

import { World } from './world.js';

const B = [];        // collision/render boxes
const SECTORS = [];  // {id,name,jp,vols:[{x0,z0,x1,z1,y0,y1}]} (first match wins)
const LINKS = [];    // {a,b,pos,w,kind,barrier}
const SPAWNS = [];   // {id,kind,pos,sectorId,isGateControl,barrierId}
const BARRIERS = []; // {id,controlId,label,boxIdx,open}
const CLIMBS = [];

function sec(id, name, jp, vols) { SECTORS.push({ id, name, jp, vols }); }

// wall along Z at fixed x. holes: [{z0,z1,y0,y1}]
function wallX(x, z0, z1, y0, y1, holes = [], opts = {}) {
  const th = opts.thickness || 1;
  let cur = z0;
  for (const h of holes.slice().sort((a, b) => a.z0 - b.z0)) {
    if (h.z0 > cur) emit(x, cur, x, h.z0, y0, y1);
    if (h.y1 < y1) emit(x, h.z0, x, h.z1, h.y1, y1);
    if (h.y0 > y0) emit(x, h.z0, x, h.z1, y0, h.y0);
    cur = h.z1;
  }
  if (cur < z1) emit(x, cur, x, z1, y0, y1);
  function emit(xc, za, xd, zb, ya, yb) {
    if (zb - za <= 0 || yb - ya <= 0) return;
    B.push({ min: [xc - th / 2, ya, za], max: [xd + th / 2, yb, zb], kind: opts.kind || 'wall', sectorId: opts.sectorId || null, barrierId: opts.barrierId || null });
  }
}

// wall along X at fixed z. holes: [{x0,x1,y0,y1}]
function wallZ(z, x0, x1, y0, y1, holes = [], opts = {}) {
  const th = opts.thickness || 1;
  let cur = x0;
  for (const h of holes.slice().sort((a, b) => a.x0 - b.x0)) {
    if (h.x0 > cur) emit(cur, h.x0, y0, y1);
    if (h.y1 < y1) emit(h.x0, h.x1, h.y1, y1);
    if (h.y0 > y0) emit(h.x0, h.x1, y0, h.y0);
    cur = h.x1;
  }
  if (cur < x1) emit(cur, x1, y0, y1);
  function emit(xa, xb, ya, yb) {
    if (xb - xa <= 0 || yb - ya <= 0) return;
    B.push({ min: [xa, ya, z - th / 2], max: [xb, yb, z + th / 2], kind: opts.kind || 'wall', sectorId: opts.sectorId || null, barrierId: opts.barrierId || null });
  }
}

function slab(x0, z0, x1, z1, y0, y1, kind = 'floor', sectorId = null) {
  B.push({ min: [x0, y0, z0], max: [x1, y1, z1], kind, sectorId });
}
function box(x0, y0, z0, x1, y1, z1, kind = 'obstacle', sectorId = null) {
  B.push({ min: [x0, y0, z0], max: [x1, y1, z1], kind, sectorId });
}
const F = (x0, z0, x1, z1, y) => slab(x0, z0, x1, z1, y - 1, y, 'floor');
const C = (x0, z0, x1, z1, y) => slab(x0, z0, x1, z1, y, y + 1, 'ceil');

function link(a, b, pos, opts = {}) {
  LINKS.push({ a, b, pos, w: opts.w || 6, kind: opts.kind || 'door', barrier: opts.barrier || null });
}
function spawn(id, kind, pos, sectorId, opts = {}) {
  SPAWNS.push({ id, kind, pos, sectorId, isGateControl: !!opts.isGateControl, barrierId: opts.barrierId || null });
}

export function buildStage() {
  B.length = SECTORS.length = LINKS.length = SPAWNS.length = BARRIERS.length = CLIMBS.length = 0;
  // ============ SECTORS (first-match volumes; nested rooms listed before their parent) ============
  sec('gantry', 'GANTRY VAULT', '高所制御室', [{ x0: -80, z0: -8, x1: -42, z1: 8, y0: 7, y1: 14 }]);
  sec('controlroom', 'CONTROL ROOM', '管制室', [{ x0: 80, z0: 52, x1: 100, z1: 68, y0: 8, y1: 19 }]);
  sec('boiler', 'BOILER ROOM', 'ボイラー室', [
    { x0: 45, z0: -60, x1: 90, z1: -30, y0: -9, y1: -1 },
    { x0: 70, z0: -45, x1: 78, z1: -37, y0: -9, y1: 0 },
  ]);
  sec('hangar', 'INTAKE BAY', '搬入口', [{ x0: -160, z0: 30, x1: -110, z1: 80, y0: -1, y1: 12 }]);
  sec('scrap', 'SORTING YARD', '選別ヤード', [{ x0: -160, z0: -60, x1: -110, z1: 30, y0: -1, y1: 10 }]);
  sec('yard', 'MATERIAL YARD', '資材ヤード', [{ x0: -110, z0: 30, x1: -40, z1: 80, y0: -1, y1: 18 }]);
  sec('mill', 'ROLLING MILL', '圧延棟', [{ x0: -110, z0: -60, x1: -40, z1: 30, y0: -1, y1: 14 }]);
  sec('pipes', 'MAINTENANCE PIPES', '保守用配管区画', [{ x0: -60, z0: -80, x1: 10, z1: -60, y0: -1, y1: 5 }]);
  sec('conn', 'WEST GALLERY', '西側連絡廊', [{ x0: -40, z0: -60, x1: -10, z1: -10, y0: -1, y1: 10 }]);
  sec('inspection', 'INSPECTION HALL', '検査棟', [{ x0: -10, z0: -60, x1: 30, z1: -10, y0: -1, y1: 10 }]);
  sec('hub', 'CENTRAL JUNCTION', '中央分岐', [{ x0: -40, z0: -10, x1: -10, z1: 40, y0: -1, y1: 10 }]);
  sec('corridor', 'ASSEMBLY CORRIDOR', '組立連絡路', [{ x0: 0, z0: -10, x1: 20, z1: 20, y0: -1, y1: 6 }]);
  sec('shaft', 'TRANSPORT SHAFT', '搬送縦坑', [{ x0: -40, z0: 40, x1: -10, z1: 80, y0: -1, y1: 30 }]);
  sec('assembly', 'ASSEMBLY LINE', '組立ライン', [{ x0: -10, z0: 20, x1: 30, z1: 80, y0: -1, y1: 12 }]);
  sec('service', 'SOUTH SERVICE', '南側保守通路', [{ x0: -160, z0: 80, x1: 30, z1: 95, y0: -1, y1: 6 }]);
  sec('conveyor', 'OUTER CONVEYOR', '外周搬送路', [{ x0: -60, z0: -100, x1: 255, z1: -80, y0: -1, y1: 6 }]);
  sec('power', 'POWER PLANT', '動力棟', [{ x0: 30, z0: -80, x1: 100, z1: -20, y0: -1, y1: 24 }]);
  sec('cooling', 'COOLING PLANT', '冷却設備', [{ x0: 100, z0: -80, x1: 240, z1: -20, y0: -1, y1: 12 }]);
  sec('exhaust', 'EXHAUST SHAFT', '排気縦坑', [
    { x0: 195, z0: -20, x1: 230, z1: -10, y0: -1, y1: 12 },
    { x0: 195, z0: -10, x1: 230, z1: 35, y0: -9, y1: 20 },
    { x0: 224, z0: -10, x1: 230, z1: 35, y0: -1, y1: 2 },
  ]);
  sec('underground', 'UNDERGROUND DOCK', '地下搬送区画', [
    { x0: 40, z0: 0, x1: 110, z1: 70, y0: -9, y1: -1 },
    { x0: 110, z0: 10, x1: 195, z1: 20, y0: -9, y1: -1 },
    { x0: 95, z0: 55, x1: 105, z1: 65, y0: -9, y1: -1 },
  ]);
  sec('mainhall', 'MAIN FOUNDRY HALL', '主製造ホール', [
    { x0: 30, z0: -10, x1: 110, z1: 80, y0: -1, y1: 20 },
    { x0: 30, z0: -20, x1: 110, z1: -10, y0: -1, y1: 20 },
    { x0: 95, z0: 55, x1: 105, z1: 65, y0: -1, y1: 3 },
  ]);
  sec('warehouse', 'SHIPPING WAREHOUSE', '出荷倉庫', [
    { x0: 110, z0: 40, x1: 250, z1: 95, y0: -1, y1: 10 },
    { x0: 110, z0: 35, x1: 245, z1: 40, y0: -1, y1: 8 },
  ]);
  sec('exitgate', 'DELIVERY GATE', '搬出ゲート', [{ x0: 230, z0: -10, x1: 255, z1: 35, y0: -1, y1: 8 }]);

  // ============ FLOORS & CEILINGS ============
  F(-160, 30, -110, 80, 0); C(-160, 30, -110, 80, 12);      // hangar
  F(-160, -60, -110, 30, 0); C(-160, -60, -110, 30, 10);   // scrap
  F(-110, 30, -40, 80, 0); C(-110, 30, -40, 80, 18);       // yard
  F(-110, -60, -40, 30, 0); C(-110, -60, -40, 30, 14);     // mill
  F(-60, -80, 10, -60, 0); C(-60, -80, 10, -60, 5);        // pipes
  F(-40, -60, -10, -10, 0); C(-40, -60, -10, -10, 10);     // conn
  F(-10, -60, 30, -10, 0); C(-10, -60, 30, -10, 10);       // inspection
  F(-40, -10, -10, 40, 0); C(-40, -10, -10, 40, 10);       // hub
  F(0, -10, 20, 20, 0); C(0, -10, 20, 20, 6);              // corridor
  F(-40, 40, -10, 80, 0); C(-40, 40, -10, 80, 30);         // shaft
  F(-10, 20, 30, 80, 0); C(-10, 20, 30, 80, 12);           // assembly
  F(-160, 80, 30, 95, 0); C(-160, 80, 30, 95, 6);          // service
  F(-60, -100, 255, -80, 0); C(-60, -100, 255, -80, 6);    // conveyor
  C(30, -80, 100, -20, 24);                                 // power ceil
  // power floor with hatch hole (x70-78, z-45--37)
  slab(30, -80, 70, -20, -1, 0, 'floor');
  slab(78, -80, 100, -20, -1, 0, 'floor');
  slab(70, -80, 78, -45, -1, 0, 'floor');
  slab(70, -37, 78, -20, -1, 0, 'floor');
  F(45, -60, 90, -30, -8);                                  // boiler floor
  // boiler ceiling with hatch hole (x70-78, z-45--37)
  slab(45, -60, 70, -30, -1, 0, 'ceil');
  slab(78, -60, 90, -30, -1, 0, 'ceil');
  slab(70, -60, 78, -45, -1, 0, 'ceil');
  slab(70, -37, 78, -30, -1, 0, 'ceil');
  F(100, -80, 240, -20, 0); C(100, -80, 240, -20, 12);     // cooling
  F(195, -20, 230, -10, 0); C(195, -20, 230, -10, 12);     // exhaust rim
  F(195, -10, 230, 35, -8);                                 // exhaust pit floor
  F(40, 0, 110, 70, -8);                                    // underground floor
  // underground ceiling with return-shaft hole (x95-105, z55-65)
  slab(40, 0, 95, 70, -1, 0, 'ceil');
  slab(105, 0, 110, 70, -1, 0, 'ceil');
  slab(95, 0, 105, 55, -1, 0, 'ceil');
  slab(95, 65, 105, 70, -1, 0, 'ceil');
  F(110, 10, 195, 20, -8); C(110, 10, 195, 20, -1);        // tunnel
  // mainhall floor with shaft hole (x95-105, z55-65)
  slab(30, -20, 95, 80, -1, 0, 'floor');
  slab(105, -20, 110, 80, -1, 0, 'floor');
  slab(95, -20, 105, 55, -1, 0, 'floor');
  slab(95, 65, 105, 80, -1, 0, 'floor');
  C(30, -20, 110, 80, 20);                                  // mainhall ceil
  slab(80, 52, 100, 68, 8, 9, 'floor'); C(80, 52, 100, 68, 19); // controlroom
  slab(-80, -8, -42, 8, 8, 9, 'floor'); C(-80, -8, -42, 8, 14); // gantry niche
  F(110, 40, 250, 95, 0); C(110, 40, 250, 95, 10);         // warehouse
  F(110, 35, 245, 40, 0); C(110, 35, 245, 40, 8);          // warehouse strip
  F(230, -10, 255, 35, 0); C(230, -10, 255, 35, 8);        // exit gate
  slab(225, -10, 230, 35, -0.5, 0, 'floor', 'exhaust');    // pit east ledge

  // ============ EXTERIOR WALLS ============
  wallX(-160, -100, 95, 0, 14);          // west outer
  wallZ(-100, -160, 255, 0, 8);          // north outer
  wallZ(95, -160, 255, 0, 12);           // south outer
  wallX(255, -100, 95, 0, 10);           // east outer
  // sealing the unused west-north block (x-160..-60, z-100..-60)
  wallX(-110, -100, -60, 0, 10);
  wallZ(-60, -160, -110, 0, 10);
  wallX(-60, -100, -80, 0, 6);           // conveyor west cap
  // sealing void strips
  wallZ(-10, 110, 115, 0, 10);           // between mainhall north & rim west
  wallX(240, -80, -10, 0, 12);           // cooling east continues to z-10
  wallZ(-20, 240, 255, 0, 12);           // void strip south of cooling-east
  wallZ(-80, 10, 30, 0, 6);              // void strip x10-30 z-80..-60 south face (north of inspection)
  wallX(10, -80, -60, 0, 6);             // pipes east face
  wallZ(-60, -110, -60, 0, 14);          // mill north face (sealed void beyond)
  wallZ(-60, -60, -40, 5, 14);           // seal above pipes wall (mill airspace y5-14)
  wallZ(35, 245, 255, 0, 8);             // exit gate south-east face (seal escape void)

  // ============ INTERIOR WALLS ============
  // -- hangar --
  wallZ(30, -160, -110, 0, 12, [{ x0: -145, x1: -135, y0: 0, y1: 4 }]); // hangar<->scrap
  wallX(-110, 30, 80, 0, 12, [{ z0: 45, z1: 55, y0: 0, y1: 4 }]);       // hangar<->yard
  // -- scrap --
  wallX(-110, -60, 30, 0, 10, [{ z0: -30, z1: -20, y0: 0, y1: 4 }]);    // scrap<->mill
  // -- yard --
  wallZ(30, -110, -40, 0, 18, [
    { x0: -80, x1: -70, y0: 0, y1: 4 },    // yard<->scrap
    { x0: -100, x1: -90, y0: 0, y1: 4 },   // yard<->mill A
    { x0: -55, x1: -45, y0: 0, y1: 4 },    // yard<->mill B
  ]);
  wallX(-40, 30, 80, 0, 18, [{ z0: 55, z1: 65, y0: 0, y1: 4 }]);         // yard<->shaft
  // -- mill --
  wallX(-40, -60, 30, 0, 14, [
    { z0: -35, z1: -25, y0: 0, y1: 4 },    // mill<->conn
    { z0: 5, z1: 15, y0: 0, y1: 4 },       // mill<->hub
  ]);
  // -- pipes --
  wallZ(-60, -60, 10, 0, 5, [
    { x0: -50, x1: -44, y0: 0, y1: 4 },    // pipes<->mill
    { x0: -24, x1: -18, y0: 0, y1: 4 },    // pipes<->conn
  ]);
  wallX(-60, -80, -60, 0, 5);            // pipes west face
  // pipes north face = conveyor south wall (shared below)
  // -- conn --
  wallZ(-60, -40, -10, 0, 10, [{ x0: -24, x1: -18, y0: 0, y1: 4 }]);     // conn<->pipes
  wallX(-10, -60, -10, 0, 10, [{ z0: -35, z1: -25, y0: 0, y1: 4 }]);     // conn<->inspection (B1)
  wallZ(-10, -40, -10, 0, 10, [{ x0: -30, x1: -20, y0: 0, y1: 4 }]);     // conn<->hub
  // -- inspection --
  wallZ(-60, -10, 30, 0, 10);            // inspection north (pipes/void beyond)
  wallX(30, -60, -10, 0, 10, [{ z0: -50, z1: -40, y0: 0, y1: 4 }]);      // inspection<->power
  // -- hub --
  wallX(-40, -10, 40, 0, 10, [{ z0: 5, z1: 15, y0: 0, y1: 4 }]);         // hub<->mill
  wallX(-10, -10, 40, 0, 10, [
    { z0: 25, z1: 35, y0: 0, y1: 4 },      // hub<->assembly
  ]);
  wallZ(-10, -40, -10, 0, 10, [{ x0: -30, x1: -20, y0: 0, y1: 4 }]);     // hub<->conn
  wallZ(40, -40, -10, 0, 10, [{ x0: -30, x1: -20, y0: 0, y1: 4 }]);      // hub<->shaft
  // -- corridor --
  wallZ(-10, 0, 20, 0, 6, [{ x0: 4, x1: 12, y0: 0, y1: 4 }]);            // corridor<->inspection (B2)
  wallZ(20, 0, 20, 0, 6, [{ x0: 4, x1: 12, y0: 0, y1: 4 }]);             // corridor<->assembly
  wallX(0, -10, 20, 0, 6);               // corridor west
  wallX(20, -10, 20, 0, 6);              // corridor east
  // -- inspection south face (z-10, x-10..30): corridor door is above, rest solid
  wallZ(-10, -10, 30, 0, 10, [{ x0: 4, x1: 12, y0: 0, y1: 4 }]);         // inspection<->corridor (B2)
  // -- shaft --
  wallX(-40, 40, 80, 0, 30, [{ z0: 55, z1: 65, y0: 0, y1: 4 }]);         // shaft<->yard
  wallX(-10, 40, 80, 0, 30, [
    { z0: 55, z1: 65, y0: 0, y1: 4 },      // shaft<->assembly (ground)
    { z0: 66, z1: 74, y0: 8, y1: 11 },     // shaft ledge<->assembly mezz
  ]);
  wallZ(40, -40, -10, 0, 30, [{ x0: -30, x1: -20, y0: 0, y1: 4 }]);      // shaft<->hub
  wallZ(80, -40, -10, 0, 30, [{ x0: -20, x1: -12, y0: 0, y1: 4 }]);      // shaft<->service
  // -- assembly --
  wallX(-10, 20, 40, 0, 12, [{ z0: 25, z1: 35, y0: 0, y1: 4 }]);         // assembly<->hub
  // (assembly x-10 z40-80 = shaft wall already built)
  wallZ(20, -10, 0, 0, 12);              // assembly north face part A
  wallZ(20, 20, 30, 0, 12);              // assembly north face part B
  wallX(30, 20, 80, 0, 12, [{ z0: 45, z1: 55, y0: 0, y1: 5 }]);          // assembly<->mainhall (B3b)
  // -- service --
  wallZ(80, -160, -10, 0, 6, [
    { x0: -140, x1: -134, y0: 0, y1: 4 },  // service<->hangar
    { x0: -20, x1: -12, y0: 0, y1: 4 },    // service<->shaft
  ]);
  wallZ(80, -10, 30, 0, 6, [{ x0: 10, x1: 20, y0: 0, y1: 4 }]);          // service<->assembly
  wallX(30, 80, 95, 0, 6);               // service east cap
  // -- conveyor --
  wallZ(-80, -60, 255, 0, 6, [
    { x0: -55, x1: -49, y0: 0, y1: 4 },    // conveyor<->pipes
    { x0: 125, x1: 135, y0: 0, y1: 4 },    // conveyor<->cooling
  ]);
  // -- power --
  wallX(30, -80, -20, 0, 24, [{ z0: -50, z1: -40, y0: 0, y1: 4 }]);      // power<->inspection
  wallZ(-20, 30, 100, 0, 24);            // power south
  wallX(100, -80, -20, 0, 24);           // power east
  wallZ(-80, 30, 100, 0, 24);            // power north
  // -- boiler --
  wallX(45, -60, -30, -8, -1); wallX(90, -60, -30, -8, -1);
  wallZ(-60, 45, 90, -8, -1); wallZ(-30, 45, 90, -8, -1);
  wallX(70, -45, -37, -8, 0, [], { thickness: 0.5 });  // hatch shaft walls
  wallX(78, -45, -37, -8, 0, [], { thickness: 0.5 });
  wallZ(-45, 70, 78, -8, 0, [], { thickness: 0.5 });
  wallZ(-37, 70, 78, -8, 0, [], { thickness: 0.5 });
  // -- cooling --
  wallX(100, -80, -20, 0, 12);           // cooling west
  wallZ(-20, 100, 240, 0, 12, [{ x0: 205, x1: 215, y0: 0, y1: 4 }]);     // cooling<->exhaust rim
  // -- exhaust --
  wallZ(-20, 195, 230, 0, 12, [{ x0: 205, x1: 215, y0: 0, y1: 4 }]);     // rim<->cooling
  wallX(195, -20, -10, 0, 12);           // rim west
  wallX(195, -10, 35, -8, 20, [{ z0: 10, z1: 20, y0: -8, y1: -5 }]);     // pit west (tunnel hole)
  wallX(230, -20, 35, -8, 20, [{ z0: 10, z1: 20, y0: 0, y1: 4 }]);       // pit east (exit door)
  wallZ(35, 195, 230, -8, 20);           // pit south
  wallZ(-10, 195, 230, -8, -0.5);        // pit north inner face (below rim floor)
  wallX(225, -10, 35, 0, 1.2, [], { thickness: 0.3, kind: 'rail' });     // ledge rail
  // -- underground --
  wallX(40, 0, 70, -8, -1);
  wallZ(0, 40, 110, -8, -1);
  wallZ(70, 40, 110, -8, -1);
  wallX(110, 0, 10, -8, -1); wallX(110, 20, 70, -8, -1);
  wallZ(10, 110, 195, -8, -1); wallZ(20, 110, 195, -8, -1);              // tunnel sides
  wallX(95, 55, 65, -8, 1.2, [], { thickness: 0.5 });  // return shaft walls+parapet
  wallX(105, 55, 65, -8, 1.2, [], { thickness: 0.5 });
  wallZ(55, 95, 105, -8, 1.2, [], { thickness: 0.5 });
  wallZ(65, 95, 105, -8, 1.2, [], { thickness: 0.5 });
  // -- mainhall --
  wallX(30, -20, 20, 0, 20);             // mainhall west upper (corridor/void face)
  wallZ(-10, 30, 110, 0, 20);            // mainhall north (strip face)
  wallZ(-20, 30, 110, 0, 20);            // strip north wall
  wallX(110, -20, 80, 0, 20, [{ z0: 50, z1: 60, y0: 0, y1: 5 }]);        // mainhall east (warehouse door)
  wallZ(80, 30, 110, 0, 20);             // mainhall south
  // -- shaft vestibule (sealed room around the underground return-shaft mouth;
  //    its only door is barred by B4, so the shaft works as a one-way exit) --
  wallX(93, 53, 67, 0, 8); wallX(107, 53, 67, 0, 8);
  wallZ(67, 93, 107, 0, 8);
  wallZ(53, 93, 107, 0, 8, [{ x0: 98, x1: 102, y0: 0, y1: 4 }]);         // vestibule door (B4)
  slab(93, 53, 107, 67, 8, 9, 'ceil');
  // -- controlroom (floating room inside mainhall) --
  wallX(80, 52, 68, 9, 18, [{ z0: 58, z1: 64, y0: 9, y1: 12 }]);
  wallX(100, 52, 68, 9, 18); wallZ(52, 80, 100, 9, 18); wallZ(68, 80, 100, 9, 18);
  box(82, 0, 54, 84, 8, 56, 'pillar', 'mainhall');
  box(96, 0, 64, 98, 8, 66, 'pillar', 'mainhall');
  // -- gantry niche (inside mill airspace y9-13) --
  wallX(-80, -8, 8, 9, 14);
  wallX(-42, -8, 8, 9, 14, [{ z0: -2, z1: 3, y0: 9, y1: 12 }]);          // entry slot (B4)
  wallZ(-8, -80, -42, 9, 14); wallZ(8, -80, -42, 9, 14);
  box(-70, 13, -6, -68, 14, -4, 'pillar', 'mill');   // hanger struts to mill ceiling
  box(-50, 13, 4, -48, 14, 6, 'pillar', 'mill');
  // -- warehouse --
  wallX(250, 35, 95, 0, 10);             // warehouse east (covers strip edge too)
  wallZ(40, 245, 250, 0, 10);            // separates void x245-250 z35-40 from warehouse
  wallZ(35, 110, 195, 0, 10);            // strip north face (void face beyond)
  wallZ(35, 230, 245, 0, 8, [{ x0: 232, x1: 240, y0: 0, y1: 4 }]);       // strip<->exitgate
  wallX(245, 35, 40, 0, 8);              // strip east wall (x245-255 z35-40 is sealed void)
  wallX(110, 40, 95, 0, 10, [{ z0: 50, z1: 60, y0: 0, y1: 5 }]);         // warehouse<->mainhall
  wallZ(95, 110, 250, 0, 10);            // warehouse south interior face
  // -- exitgate --
  wallZ(-10, 230, 255, 0, 8);            // exit north
  // (exit west = pit east wall built above with door z10-20)
  wallX(245, -10, 35, 0, 8, [{ z0: 10, z1: 20, y0: 0, y1: 5 }]);         // final gate wall (B6 hole)

  // ============ BARRIERS ============
  const barriersSpec = [
    { id: 'B1', control: 'TC1', label: 'WEST GATE', boxes: [[-10.4, 0, -35, -9.6, 4, -25]] },
    { id: 'B2', control: 'TC2', label: 'ASSEMBLY GATE', boxes: [[4, 0, -10.4, 12, 4, -9.6]] },
    { id: 'B3', control: 'TC3', label: 'EAST BLOCKADE', boxes: [[19.5, 0, -100, 20.5, 6, -80], [29.6, 0, 45, 30.4, 5, 55]] },
    { id: 'B4', control: 'TC4', label: 'GANTRY VAULT', boxes: [[-42.4, 9, -2, -41.6, 12, 3], [97.6, 0, 52.6, 102.4, 4, 53.4]] },
    { id: 'B5', control: 'TC5', label: 'BOILER HATCH', boxes: [[70.1, -0.5, -44.9, 77.9, 0, -37.1]] },
    { id: 'B6', control: 'TC6', label: 'FINAL GATE', boxes: [[244.6, 0, 10, 245.4, 5, 20]] },
  ];
  for (const b of barriersSpec) {
    const idxs = [];
    for (const bb of b.boxes) {
      B.push({ min: [bb[0], bb[1], bb[2]], max: [bb[3], bb[4], bb[5]], kind: 'barrier', barrierId: b.id });
      idxs.push(B.length - 1);
    }
    BARRIERS.push({ id: b.id, controlId: b.control, label: b.label, boxIdx: idxs, open: false });
  }

  // ============ INTERIOR PLATFORMS ============
  slab(35, -70, 95, -55, 8, 9, 'platform', 'power');   // power catwalk A
  slab(35, -55, 50, -30, 8, 9, 'platform', 'power');   // power catwalk B
  for (const cx of [40, 60, 80]) box(cx, 0, -66, cx + 3, 8, -63, 'pillar', 'power');
  slab(55, -70, 80, -45, 16, 17, 'platform', 'power'); // power deck
  for (const cx of [57, 72]) box(cx, 9, -68, cx + 2, 16, -66, 'pillar', 'power');
  slab(-40, 64, -10, 80, 8, 9, 'platform', 'shaft');   // shaft ledge y9
  slab(-40, 40, -30, 52, 16, 17, 'platform', 'shaft'); // shaft ledge y17
  box(-38, 9, 70, -36, 16, 72, 'pillar', 'shaft');     // ledge support
  slab(-10, 35, 30, 80, 8, 9, 'platform', 'assembly'); // assembly mezzanine
  for (const cx of [-5, 12]) box(cx, 0, 60, cx + 3, 8, 63, 'pillar', 'assembly');

  // ============ OBSTACLES / COVER ============
  const O = [
    // hangar crates (start shelter)
    [-152, 0, 48, -146, 3, 54, 'crate'], [-145, 0, 62, -139, 2.5, 68, 'crate'],
    [-155, 0, 60, -150, 2, 66, 'crate'], [-130, 0, 55, -124, 2, 61, 'crate'],
    // scrap piles
    [-140, 0, -30, -132, 3.5, -22, 'scrap'], [-128, 0, 5, -120, 2.5, 12, 'scrap'],
    [-150, 0, 15, -144, 3, 22, 'scrap'], [-135, 0, -50, -127, 4, -42, 'scrap'],
    // yard
    [-100, 0, 45, -90, 5, 55, 'container'], [-75, 0, 60, -65, 5, 70, 'container'],
    [-60, 0, 40, -52, 4, 48, 'container'], [-95, 0, 68, -85, 6, 74, 'machine'],
    [-55, 0, 70, -48, 3, 76, 'crate'],
    // mill
    [-100, 0, -40, -90, 6, -32, 'machine'], [-80, 0, -20, -70, 5, -12, 'machine'],
    [-60, 0, -45, -50, 7, -38, 'machine'], [-95, 0, 5, -85, 4, 12, 'machine'],
    [-70, 0, 10, -62, 3, 18, 'crate'], [-55, 0, -5, -48, 5, 3, 'machine'],
    // pipes
    [-55, 0, -76, -45, 3.5, -74, 'pipe'], [-40, 0, -70, -30, 3.5, -68, 'pipe'],
    [-15, 0, -78, -5, 4, -75, 'tank'], [-35, 0, -78, -28, 4.5, -74, 'tank'],
    [-55, 0, -66, -50, 3, -62, 'pipe'], [-8, 0, -68, -4, 3.5, -64, 'tank'],
    // conn
    [-30, 0, -50, -27, 6, -47, 'pillar'], [-20, 0, -30, -17, 6, -27, 'pillar'],
    // inspection
    [0, 0, -50, 8, 3, -45, 'machine'], [15, 0, -35, 22, 2.5, -30, 'machine'],
    [5, 0, -20, 10, 3.5, -15, 'crate'],
    // hub
    [-35, 0, 15, -32, 7, 18, 'pillar'], [-18, 0, 0, -15, 7, 3, 'pillar'],
    // shaft
    [-35, 0, 45, -32, 2.5, 50, 'crate'], [-20, 0, 75, -15, 2, 78, 'crate'],
    // assembly (conveyor lines + arms) — leave gaps under mezz
    [0, 0, 40, 25, 2, 44, 'machine'], [0, 0, 55, 25, 2, 59, 'machine'],
    [8, 0, 47, 12, 5, 51, 'machine'], [18, 0, 63, 22, 5, 67, 'machine'],
    [25, 0, 70, 28, 4, 76, 'crate'],
    // service
    [-100, 0, 90, -60, 2.5, 93, 'pipe'], [-40, 0, 90, -20, 2.5, 93, 'pipe'],
    [-120, 0, 82, -115, 2, 86, 'crate'], [-10, 0, 82, -5, 2, 86, 'crate'],
    // conveyor belt strips (leave gaps)
    [-40, 0, -95, -10, 1.8, -92, 'belt'], [30, 0, -95, 60, 1.8, -92, 'belt'],
    [80, 0, -95, 110, 1.8, -92, 'belt'], [140, 0, -95, 165, 1.8, -92, 'belt'],
    [200, 0, -95, 240, 1.8, -92, 'belt'],
    // power
    [45, 0, -35, 52, 5, -28, 'machine'], [70, 0, -30, 78, 6, -24, 'machine'],
    [85, 0, -55, 92, 5, -48, 'machine'], [40, 0, -65, 47, 4, -58, 'crate'],
    [88, 0, -38, 95, 4, -32, 'machine'],
    // boiler
    [50, -8, -55, 58, -3, -48, 'tank'], [80, -8, -50, 87, -3, -42, 'tank'],
    [62, -8, -35, 68, -4, -32, 'machine'],
    // cooling
    [110, 0, -70, 122, 10, -58, 'tower'], [160, 0, -70, 172, 10, -58, 'tower'],
    [210, 0, -70, 222, 10, -58, 'tower'], [135, 0, -45, 147, 10, -33, 'tower'],
    [185, 0, -45, 197, 8, -35, 'machine'], [220, 0, -45, 230, 8, -35, 'machine'],
    [125, 0, -30, 132, 2, -25, 'crate'],
    // exhaust rim ducts
    [198, 0, -18, 204, 3, -14, 'machine'], [220, 0, -18, 226, 3, -14, 'machine'],
    // underground
    [50, -8, 10, 58, -4, 18, 'container'], [70, -8, 35, 80, -4, 45, 'container'],
    [95, -8, 20, 103, -4, 28, 'container'], [60, -8, 55, 68, -5, 62, 'crate'],
    [45, -8, 30, 50, -4, 38, 'container'],
    // mainhall
    [40, 0, 5, 50, 8, 15, 'machine'], [60, 0, 20, 70, 6, 30, 'machine'],
    [85, 0, 10, 95, 7, 20, 'machine'], [40, 0, 40, 48, 4, 48, 'crate'],
    [75, 0, 60, 88, 5, 72, 'machine'], [55, 0, 65, 62, 3, 72, 'crate'],
    [100, 0, 30, 106, 6, 38, 'machine'],
    // warehouse maze
    [118, 0, 48, 126, 4, 56, 'crate'], [150, 0, 55, 158, 5, 63, 'crate'],
    [180, 0, 45, 188, 4, 52, 'crate'], [210, 0, 55, 218, 5, 63, 'crate'],
    [120, 0, 70, 128, 4, 78, 'crate'], [165, 0, 68, 173, 5, 76, 'crate'],
    [200, 0, 70, 208, 4, 78, 'crate'], [230, 0, 68, 238, 5, 76, 'crate'],
    [145, 0, 80, 153, 4, 88, 'crate'], [175, 0, 85, 182, 3, 90, 'crate'],
    // exitgate
    [232, 0, 0, 238, 3, 6, 'machine'], [248, 0, 25, 253, 3, 30, 'crate'],
  ];
  for (const o of O) box(o[0], o[1], o[2], o[3], o[4], o[5], o[6], o[7]);

  // ============ ENEMIES ============
  const G = (id, x, y, z, s) => spawn(id, 'guard', [x, y, z], s);
  const T = (id, x, y, z, s, o = {}) => spawn(id, 'turret', [x, y, z], s, o);

  G('G01', -140, 0, -20, 'scrap');
  G('G02', -60, 9, 3, 'gantry');
  G('G03', -90, 0, 60, 'yard'); G('G04', -60, 0, 75, 'yard');
  G('G05', -90, 0, -30, 'mill'); G('G06', -60, 0, 0, 'mill'); G('G07', -80, 0, 15, 'mill');
  G('G08', -45, 0, -70, 'pipes'); G('G09', -15, 0, -68, 'pipes');
  G('G10', -25, 0, 55, 'shaft'); G('G11', -20, 9, 72, 'shaft');
  G('G12', 10, 0, 40, 'assembly'); G('G13', 15, 9, 45, 'assembly');
  G('G14', 5, 0, -40, 'inspection'); G('G15', 20, 0, -20, 'inspection');
  G('G16', -30, 0, 10, 'hub');
  G('G17', 80, 0, -90, 'conveyor');
  G('G18', 45, 0, -40, 'power'); G('G19', 80, 0, -60, 'power'); G('G20', 60, 9, -62, 'power');
  G('G21', 145, 0, -50, 'cooling'); G('G22', 205, 0, -35, 'cooling');
  G('G23', 60, -8, 30, 'underground'); G('G24', 90, -8, 50, 'underground'); G('G25', 75, -8, 15, 'underground');
  G('G26', 50, 0, 30, 'mainhall'); G('G27', 90, 0, 45, 'mainhall'); G('G28', 65, 0, 60, 'mainhall');
  G('G29', 145, 0, 60, 'warehouse'); G('G30', 220, 0, 75, 'warehouse');

  T('T01', -95, 0, -45, 'mill'); T('T02', -50, 0, 20, 'mill');
  T('T03', 25, 0, 30, 'assembly');
  T('T04', 25, 0, -55, 'inspection');
  T('T05', 190, 0, -60, 'cooling');
  T('T06', 85, 0, -30, 'power');
  T('T07', 45, 0, 15, 'mainhall'); T('T08', 90, 9, 62, 'controlroom');
  T('T09', 250, 0, 15, 'exitgate');
  T('TC1', -2, 0, -72, 'pipes', { isGateControl: true, barrierId: 'B1' });
  T('TC2', 67, 17, -57, 'power', { isGateControl: true, barrierId: 'B2' });
  T('TC3', 5, 9, 75, 'assembly', { isGateControl: true, barrierId: 'B3' });
  T('TC4', 50, -8, 55, 'underground', { isGateControl: true, barrierId: 'B4' });
  T('TC5', -60, 9, 0, 'gantry', { isGateControl: true, barrierId: 'B5' });
  T('TC6', 70, -8, -50, 'boiler', { isGateControl: true, barrierId: 'B6' });

  // ============ LINKS ============
  link('hangar', 'yard', [-110, 0, 50]);
  link('hangar', 'scrap', [-140, 0, 30]);
  link('hangar', 'service', [-137, 0, 80]);
  link('scrap', 'yard', [-75, 0, 30]);
  link('scrap', 'mill', [-110, 0, -25]);
  link('yard', 'mill', [-95, 0, 30]);
  link('yard', 'mill', [-50, 0, 30]);
  link('yard', 'shaft', [-40, 0, 60]);
  link('mill', 'conn', [-40, 0, -30]);
  link('mill', 'hub', [-40, 0, 10]);
  link('mill', 'pipes', [-47, 0, -60]);
  link('mill', 'gantry', [-41, 9, 0.5], { kind: 'shaft', barrier: 'B4' });
  link('pipes', 'conn', [-21, 0, -60]);
  link('pipes', 'conveyor', [-52, 0, -80]);
  link('conn', 'inspection', [-10, 0, -30], { barrier: 'B1' });
  link('conn', 'hub', [-25, 0, -10]);
  link('hub', 'shaft', [-25, 0, 40]);
  link('hub', 'assembly', [-10, 0, 30]);
  link('inspection', 'corridor', [8, 0, -10], { barrier: 'B2' });
  link('corridor', 'assembly', [8, 0, 20]);
  link('inspection', 'power', [30, 0, -45]);
  link('shaft', 'assembly', [-10, 0, 60]);
  link('shaft', 'assembly', [-10, 9, 70], { kind: 'shaft' });
  link('shaft', 'service', [-16, 0, 80]);
  link('assembly', 'service', [15, 0, 80]);
  link('assembly', 'mainhall', [30, 0, 50], { barrier: 'B3' });
  link('conveyor', 'cooling', [130, 0, -80], { barrier: 'B3' }); // B3 slab sits mid-conveyor
  link('cooling', 'exhaust', [210, 0, -20]);
  link('exhaust', 'underground', [112, -8, 15], { kind: 'shaft' });
  link('underground', 'mainhall', [100, -8, 60], { kind: 'shaft', barrier: 'B4' });
  link('mainhall', 'warehouse', [110, 0, 55]);
  link('mainhall', 'controlroom', [80, 9, 61], { kind: 'shaft' });
  link('warehouse', 'exitgate', [236, 0, 35]);
  link('exhaust', 'exitgate', [230, 0, 15]);
  link('power', 'boiler', [74, -8, -41], { kind: 'shaft', barrier: 'B5' });

  const start = { pos: [-150, 0, 55], yaw: Math.PI / 2 }; // facing +X
  const escapeZone = { min: [246.5, 0, 12], max: [253.5, 3, 19] };

  CLIMBS.push(
    { id: 'K1', from: 'power floor 0', to: 'power catwalk 9', delta: 9 },
    { id: 'K2', from: 'power catwalk 9', to: 'power deck 17', delta: 8 },
    { id: 'K3', from: 'assembly floor 0', to: 'assembly mezz 9', delta: 9 },
    { id: 'K4', from: 'shaft floor 0', to: 'shaft ledge 9', delta: 9 },
    { id: 'K5', from: 'underground -8', to: 'mainhall 0 (return shaft)', delta: 8 },
    { id: 'K6', from: 'mill floor 0', to: 'gantry niche 9', delta: 9 },
    { id: 'K7', from: 'boiler -8', to: 'power 0 (hatch)', delta: 8 },
    { id: 'K8', from: 'mainhall floor 0', to: 'controlroom 9', delta: 9 },
  );

  // ============ build world ============
  const world = new World();
  for (const b of B) world.addBox(b.min, b.max, { kind: b.kind, sectorId: b.sectorId, barrierId: b.barrierId });
  world.finalize();
  const barrierBoxes = {};
  for (const bd of BARRIERS) barrierBoxes[bd.id] = bd.boxIdx.map(i => world.boxes[i]);

  const adjacency = {};
  for (const l of LINKS) {
    (adjacency[l.a] = adjacency[l.a] || []).push({ to: l.b, pos: l.pos, barrier: l.barrier });
    (adjacency[l.b] = adjacency[l.b] || []).push({ to: l.a, pos: l.pos, barrier: l.barrier });
  }

  function sectorAt(p) {
    for (const s of SECTORS) {
      for (const v of s.vols) {
        if (p[0] >= v.x0 && p[0] <= v.x1 && p[2] >= v.z0 && p[2] <= v.z1 &&
            p[1] >= v.y0 && p[1] <= v.y1) return s.id;
      }
    }
    return null;
  }

  return {
    world, sectors: SECTORS, links: LINKS, spawns: SPAWNS,
    barriers: BARRIERS, barrierBoxes, adjacency, sectorAt,
    start, escapeZone, climbs: CLIMBS, boxes: B,
  };
}
