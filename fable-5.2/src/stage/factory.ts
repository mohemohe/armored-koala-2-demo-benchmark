/**
 * The shipped stage: one continuous, fully enclosed abandoned factory (廃工場) of 19 sectors.
 *
 * Geometry lives in layout.ts (shells, doorways, flight bays, gatehouses, barriers) and sectorsA..D.ts
 * (one function per sector interior), the recorded routes in route.ts; this file assembles the StageDef and
 * records the documentation fields (connections, flight spots, branches, loops). tools/validateStage.ts
 * checks every claim made here against the real collision boxes.
 *
 * Route: S01 dock → S02 link → S03 yard ─F1→ [B1] S04 mill (+S05 control room) ─F2→ S06 shaft ─F3→ [B2]
 * S07 assembly ─F4→ [B3] S08 inspection ─F5→ S09 gallery → [B4] S10 power ─F6→ S11 cooling ─F7→ [B5]
 * S12 exhaust shaft (58 m descent) → S13 tunnel → S14 main hall (climb to the 0 m gallery) → [B6]
 * S15 warehouse → S16 haul road → S17 gate [GATE] → exit zone.
 * Optional covered detours: S18 parts gallery (around the assembly hall) and S19 service gallery (around the
 * main hall); both have firing slits towards their hall. docs/STAGE.md is generated from this definition and
 * the validator's measurements by tools/stageReport.ts.
 *
 * Enemies: 30 guards + 15 turrets in 16 sectors. Guards stand on main floors or on walkways that are one
 * navigation region with a place the route visits (they can always come for the player); turrets hold the
 * vantage points (masts under the roof, towers, catwalk corners).
 */
import { v3 } from '../core/vec';
import type { SectorDef, StageDef } from '../sim/types';
import { dressFactory } from './dressing';
import { BOUNDS, KILL_Y, buildLayout, stand } from './layout';
import { DETOUR_KEYS, MAIN_KEYS, expandRoute, type RouteKey } from './route';
import { buildControlRoom, buildDock, buildLink, buildMill, buildShaft, buildYard } from './sectorsA';
import { buildAssembly, buildGallery, buildInspection, buildPower } from './sectorsB';
import { buildCooling, buildExhaust, buildTunnel } from './sectorsC';
import { buildGate, buildMainHall, buildRoad, buildWarehouse } from './sectorsD';

/** Builds the stage definition (pure and deterministic). */
export function buildFactoryStage(): StageDef {
  const l = buildLayout();
  buildDock(l);
  buildLink(l);
  buildYard(l);
  buildMill(l);
  buildControlRoom(l);
  buildShaft(l);
  buildAssembly(l);
  buildInspection(l);
  buildGallery(l);
  buildPower(l);
  buildCooling(l);
  buildExhaust(l);
  buildTunnel(l);
  buildMainHall(l);
  buildWarehouse(l);
  buildRoad(l);
  buildGate(l);
  dressFactory(l);
  const b = l.b;
  b.enemies.sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
  const solids = b.finishSolids();
  // Decor that ended up (mostly) inside a solid — a lamp swallowed by a duct or a buttress — is never visible.
  const decor = b.decor.filter((d) => {
    const dv = (d.max.x - d.min.x) * (d.max.y - d.min.y) * (d.max.z - d.min.z);
    return !solids.some((s) => {
      const x = Math.min(d.max.x, s.max.x) - Math.max(d.min.x, s.min.x);
      const y = Math.min(d.max.y, s.max.y) - Math.max(d.min.y, s.min.y);
      const z = Math.min(d.max.z, s.max.z) - Math.max(d.min.z, s.min.z);
      return x > 0 && y > 0 && z > 0 && x * y * z >= 0.4 * dv;
    });
  });

  const connections: StageDef['connections'] = [
    { a: 'S01', b: 'S02', kind: 'door', note: '搬入口南端の扉（幅12 m）' },
    { a: 'S02', b: 'S03', kind: 'door', note: '連絡路北壁の扉（幅16 m）。搬入口の扉と同じ壁面にあり射線が通らない' },
    { a: 'S03', b: 'S04', kind: 'climb', note: 'F1: 東壁の開口 +10 m' },
    { a: 'S03', b: 'S04', kind: 'barrier', barrierId: 'B1', note: 'F1着地直後の隔壁（制御砲台T01）' },
    { a: 'S04', b: 'S05', kind: 'door', note: '制御室南扉' },
    { a: 'S04', b: 'S05', kind: 'door', note: '制御室北扉（環状経路LP1）' },
    { a: 'S04', b: 'S06', kind: 'climb', note: 'F2: 南東の開口 +16 m' },
    { a: 'S06', b: 'S07', kind: 'climb', note: 'F3: 縦坑東壁の開口 +22 m' },
    { a: 'S06', b: 'S07', kind: 'barrier', barrierId: 'B2', note: 'F3着地直後の隔壁（制御砲台T04）。前室からはバルコニー開口（床面へ8 m降下）、北扉（西通路・中央キャットウォーク・部品ガントリー +22 m）、南端（S18）の3方向' },
    { a: 'S07', b: 'S08', kind: 'climb', note: 'F4: 北壁の開口 +28 m' },
    { a: 'S07', b: 'S08', kind: 'barrier', barrierId: 'B3', note: 'F4着地直後の隔壁（制御砲台T06）' },
    { a: 'S08', b: 'S09', kind: 'climb', note: 'F5: 西壁の開口 +34 m' },
    { a: 'S09', b: 'S10', kind: 'barrier', barrierId: 'B4', note: '配管区画西端の隔壁（制御砲台T08）' },
    { a: 'S10', b: 'S11', kind: 'climb', note: 'F6: 西壁の開口 +40 m' },
    { a: 'S11', b: 'S12', kind: 'climb', note: 'F7: 北壁の開口 +46 m' },
    { a: 'S11', b: 'S12', kind: 'barrier', barrierId: 'B5', note: 'F7着地直後の隔壁（制御砲台T11）' },
    { a: 'S12', b: 'S13', kind: 'drop', note: '排気縦坑を58 m降下し、底の扉から地下搬送区画へ' },
    { a: 'S13', b: 'S14', kind: 'door', note: '直通トンネル東端の扉' },
    { a: 'S14', b: 'S15', kind: 'barrier', barrierId: 'B6', note: '北ギャラリー(0 m)北東の隔壁（制御砲台T14）。最下層から12 mの飛行が必要' },
    { a: 'S07', b: 'S18', kind: 'open', note: '前室南端 ⇄ 部品搬送回廊（分岐BR1の遮蔽側）' },
    { a: 'S18', b: 'S08', kind: 'climb', note: '回廊東辺の北端から搬入開口F4の東半分へ6 m上昇（開口の仕切り壁でホール側と分離。S07の境界帯を2 m横切る）' },
    { a: 'S14', b: 'S19', kind: 'climb', note: '入口前室の天井ハッチから保守回廊へ12 m上昇（分岐BR4の遮蔽側）' },
    { a: 'S19', b: 'S15', kind: 'barrier', barrierId: 'B6', note: '保守回廊北端は隔壁B6の扉の東半分に直結' },
    { a: 'S15', b: 'S16', kind: 'door', note: '倉庫西壁の扉' },
    { a: 'S16', b: 'S17', kind: 'door', note: '搬送路西端の扉' },
    { a: 'S17', b: 'S17', kind: 'gate', barrierId: 'GATE', note: '最終搬出ゲート → 脱出領域' },
  ];

  const route = toRoute(b.sectors, expandRoute(MAIN_KEYS));

  // Branches: viaA / viaB lie in the cross-section of their passage (the validator closes the 2 m slab through
  // each of them: either one alone leaves the rejoin point reachable, both together cut it off).
  const branches: StageDef['branches'] = [
    {
      id: 'BR1',
      from: stand(368, 22, 10),
      to: stand(460, 28, 118),
      viaA: stand(400, 14, 30),
      viaB: stand(420, 22, 11),
      noteA: '前室のバルコニー開口から組立ライン床面へ降り、対角に横断して14 m上昇。最短だがマスト砲台T06・T07、中央キャットウォークのG10・G11、床面のG08・G09に四方から撃たれる',
      noteB: '前室の南端から壁で囲われた部品搬送回廊(S18, +22 m)を南→東へ迂回して6 m上昇。約1.2倍の距離。回廊自体に敵はおらず、壁の銃眼(幅2 m)を横切る瞬間だけホールの敵の射線が通る',
    },
    {
      id: 'BR2',
      from: stand(460, 28, 118),
      to: stand(387, 26, 192),
      viaA: stand(402, 26, 186),
      viaB: stand(402, 18, 128),
      noteA: '検査棟上階を対角に直進。短いが開けており、上階のG12と床開口H2越しの制御砲台T08に撃たれる',
      noteB: '床開口H1から下階へ降り、T08の区画から隔壁で遮られた西側通路を進んでH3から8 m上昇して復帰。長いが、下階の通路自体は敵から見えない（開口の上り下りでのみG12に露出）',
    },
    {
      id: 'BR3',
      from: stand(60, -12, 212),
      to: stand(240, -12, 212),
      viaA: stand(110, -12, 209),
      viaB: stand(110, -12, 259),
      noteA: '直通トンネル。最短だが東端のT12とトンネル内のG21に正面から撃たれ続け、崩落孔の南側(幅7 m)を通る',
      noteB: '北側の側道を迂回。約65 m長いがコアが遮蔽となり、連絡路を横切る時以外は撃たれない',
    },
    {
      id: 'BR4',
      from: stand(258, -12, 210),
      to: stand(470, 0, 318),
      viaA: stand(368, -12, 243),
      viaB: stand(380, 0, 211),
      noteA: '入口前室の北扉から最下層を斜めに横断し東端で12 m上昇。最短だが砲塔T13・T14、北ギャラリーと桟橋のG23〜G25、床面のG22に上下から撃たれる',
      noteB: '入口前室の天井ハッチへ12 m上昇して壁で囲われた保守回廊(S19, 0 m)に入り、南→東を回って隔壁B6の東半分へ出る。長いが、回廊自体に敵はおらず、壁の銃眼(幅2 m)を横切る瞬間だけホールの敵の射線が通る',
    },
  ];

  const loops: StageDef['loops'] = [
    {
      id: 'LP1',
      points: [stand(304, 4, 61), stand(322, 4, 66), stand(336.5, 4, 75), stand(322, 4, 84), stand(304, 4, 89)],
      note: '圧延棟 ⇄ 制御室: 南扉から入り隔壁の東端を回って北扉から戻る',
    },
    {
      id: 'LP2',
      points: [stand(17, 40, 115), stand(93, 40, 115), stand(93, 40, 189), stand(19, 40, 187)],
      note: '冷却設備のタンク群を囲むキャットウォーク環(+40 m)',
    },
    {
      id: 'LP3',
      points: [stand(60, -12, 212), stand(150, -12, 214), stand(150, -12, 259), stand(60, -12, 259)],
      note: '地下搬送区画: 西コアを囲む直通トンネル → 中央連絡 → 側道 → 西連絡',
    },
    {
      id: 'LP4',
      points: [stand(160, -12, 214), stand(240, -12, 214), stand(240, -12, 259), stand(160, -12, 259)],
      note: '地下搬送区画: 東コアを囲む直通トンネル → 東連絡 → 側道 → 中央連絡',
    },
  ];

  return {
    id: 'factory',
    name: '廃工場',
    bounds: BOUNDS,
    killY: KILL_Y,
    sectors: b.sectors,
    solids,
    decor,
    markings: b.markings,
    barriers: b.barriers,
    finalGate: l.finalGate,
    exitZone: l.exitZone,
    playerStart: { position: v3(20, 2.001, 90), yaw: 0 },
    enemies: b.enemies,
    connections,
    route,
    flightSpots: l.flightSpots,
    branches,
    loops,
  };
}

/** Route waypoints with the sector each one lies in. */
function toRoute(sectors: SectorDef[], keys: RouteKey[]): StageDef['route'] {
  return keys.map((key) => {
    const p = key.position;
    const sec = sectors.find((s) => s.bounds.some((q) => p.x >= q.min.x && p.x <= q.max.x && p.y >= q.min.y && p.y <= q.max.y && p.z >= q.min.z && p.z <= q.max.z));
    const w: StageDef['route'][number] = { sectorId: sec ? sec.id : '', position: p };
    if (key.note) w.note = key.note;
    return w;
  });
}

/**
 * Variant of the recommended route that takes the covered / longer alternative (B) of all four branches (see
 * DETOUR_KEYS in route.ts). Documentation only (the game guides the player along `stage.route`);
 * tools/validateStage.ts plays it with the real simulation so that both sides of every branch are known to be
 * passable with real physics.
 */
export function buildDetourRoute(stage: StageDef): StageDef['route'] {
  return toRoute(stage.sectors, expandRoute(DETOUR_KEYS));
}

let cached: StageDef | null = null;
/** Cached stage definition shared by the game, the tools and the tests. */
export function getFactoryStage(): StageDef {
  if (!cached) cached = buildFactoryStage();
  return cached;
}

/** The detour variant of the recommended route of the shipped stage (see buildDetourRoute). */
export function getFactoryDetourRoute(): StageDef['route'] {
  return buildDetourRoute(getFactoryStage());
}
