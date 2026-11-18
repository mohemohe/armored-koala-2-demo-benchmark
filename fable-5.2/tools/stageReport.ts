/**
 * Stage report generator — writes docs/STAGE.md from the stage definition (src/stage/factory.ts) and the
 * measured output of the stage validator (tools/stageAnalysis.ts), so that the document required by
 * docs/SPEC.md §2.2 (sector ids / bounds, connections, barriers, control turrets, enemy placement, route
 * coordinates) can never drift away from the shipped geometry.
 *
 *   npx tsx tools/stageReport.ts [--json <validator.json>] [--out <file.md>] [--save-json <file.json>]
 *
 * Without --json the whole validation (V1–V16, about a minute) is run first; with --json a report written
 * by `npx tsx tools/validateStage.ts --json <file>` is used instead (it must belong to the current stage:
 * the solid / decor / enemy counts are compared). The output contains no timings or dates, so running the
 * tool twice on the same sources produces the identical file. Exits 1 when the validation failed and 3 when
 * checks were not run (the document is still written and says so). Must not import three.js.
 */
import { ENEMIES, GENERATOR_PARTS, PLAYER } from '../src/config';
import type { V3 } from '../src/core/vec';
import type { Box, StageDef } from '../src/sim/types';
import { getFactoryDetourRoute, getFactoryStage } from '../src/stage/factory';
import { LIMITS, analyzeStage, type CheckResult, type StageReport } from './stageAnalysis';

// The project has no @types/node (dependencies are pinned), so the few Node APIs used here are typed locally.
interface NodeFs {
  mkdirSync(path: string, opts: { recursive: boolean }): void;
  writeFileSync(path: string, data: string): void;
  readFileSync(path: string, enc: string): string;
}
interface NodeProcess {
  argv: string[];
  exitCode?: number;
}
const proc = (globalThis as unknown as { process: NodeProcess }).process;

// ───────────────────────────── formatting ─────────────────────────────
const num = (v: number, digits = 2): string => {
  if (!Number.isFinite(v)) return '–';
  const s = v.toFixed(digits);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
};
const n1 = (v: number): string => num(v, 1);
const pt = (p: V3): string => `(${num(p.x)}, ${num(p.y)}, ${num(p.z)})`;
const bx = (b: Box): string => `x ${num(b.min.x)}..${num(b.max.x)}, y ${num(b.min.y)}..${num(b.max.y)}, z ${num(b.min.z)}..${num(b.max.z)}`;
const esc = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const table = (head: string[], rows: string[][], align?: string): string[] => {
  const out = [`| ${head.join(' | ')} |`, `| ${head.map((_, i) => (align && align[i] === 'r' ? '---:' : '---')).join(' | ')} |`];
  for (const r of rows) out.push(`| ${r.map(esc).join(' | ')} |`);
  return out;
};
const deg = (rad: number | undefined): string => (rad === undefined ? '–' : `${num((rad * 180) / Math.PI, 0)}°`);

type Data = Record<string, unknown>;
const KIND_JA: Record<string, string> = {
  dock: '搬入口 (sheltered entry)',
  yard: '広場 (open yard)',
  factory: '設備のある製造室 (machine hall)',
  multilevel: '上下層 (stacked floors)',
  corridor: '狭い連絡路 (narrow connector)',
  shaft: '縦坑 (vertical shaft)',
  warehouse: '倉庫 (rack storage)',
  tunnel: '地下通路 (tunnel)',
  plant: '設備プラント (plant)',
  road: '搬送路 (haul road)',
  gate: 'ゲート (gate)',
};
const CONN_JA: Record<string, string> = { open: 'open', door: 'door', climb: 'climb (flight)', drop: 'drop', barrier: 'barrier', gate: 'final gate' };

interface Expo {
  enemies: number;
  maxSimultaneous: number;
  mean: number;
  ids: string[];
}
interface BranchAlt {
  length: number;
  retrace: number;
  exposure: Expo;
}
interface BranchRow {
  id: string;
  A: BranchAlt | null;
  B: BranchAlt | null;
  ownA: Expo | null;
  ownB: Expo | null;
  ownLengthA: number;
  ownLengthB: number;
  separation: { ok: boolean; reason: string; axisA: string; axisB: string } | null;
}
interface ShapeRow {
  kind: string;
  class: string;
  ok: boolean;
  rule: string;
  spanX: number;
  spanZ: number;
  openSquare: number;
  height: number;
  top: number;
  bands: number;
  stacked: number;
  tallFraction: number;
  tallRows: number;
  elevated: number;
}
interface CombatRun {
  name: string;
  required: boolean;
  ok: boolean;
  reason: string;
  seconds: number;
  hpEnd: number;
  hpMin: number;
  damageTaken: number;
  kills: string[];
  shots: { machinegun: number; beam: number; missile: number };
  enemyShots: number;
  fightSeconds: number;
  hpAtBarrier: Array<{ barrierId: string; controlId: string; time: number; hp: number }>;
  damageBySector: Record<string, number>;
}
interface FlightRun {
  generator: string;
  legs: string;
  maxEn: number;
  ok: boolean;
  reason: string;
  enUsed: number;
  enLeft: number;
  seconds: number;
  landed: V3;
}
interface WalkRun {
  name: string;
  main?: boolean;
  replans?: number;
  ok: boolean;
  reason: string;
  seconds: number;
  distance: number;
  minEn: number;
  flights: number;
  flightEn: number;
  maxFlightEn: number;
  enWaitSeconds: number;
  waypoints: number;
  waypointsReached: number;
  arrivals: Array<number | null>;
  controls: Array<{ id: string; barrierId: string; time: number; from: V3; dist: number; waypoint: number }>;
  climbs?: Array<{ waypoint: number; from: V3; to: V3; height: number; horizontal: number; enUsed: number; seconds: number }>;
  visitedSectors: string[];
}

const DETOUR_NAME = 'detour (B side of every branch)';

function build(stage: StageDef, rep: StageReport, detour: StageDef['route']): string {
  const check = (id: string): CheckResult | undefined => rep.checks.find((c) => c.id === id);
  const data = (id: string): Data => (check(id)?.data ?? {}) as Data;
  const status = (id: string): string => {
    const c = check(id);
    return !c ? 'not run' : c.status === 'pass' ? 'PASS' : c.status === 'fail' ? 'FAIL' : 'NOT RUN';
  };
  const secName = (id: string): string => {
    const s = stage.sectors.find((q) => q.id === id);
    return s ? `${id} ${s.name}` : id;
  };
  const sectorAt = (p: V3): string => {
    for (const s of stage.sectors) for (const b of s.bounds) {
      if (p.x >= b.min.x && p.x <= b.max.x && p.y >= b.min.y && p.y <= b.max.y && p.z >= b.min.z && p.z <= b.max.z) return s.id;
    }
    return '–';
  };
  const L: string[] = [];
  const guards = stage.enemies.filter((e) => e.kind === 'guard');
  const turrets = stage.enemies.filter((e) => e.kind === 'turret');
  const controls = stage.enemies.filter((e) => e.isGateControl);
  const v1 = data('V1');
  const v3 = data('V3');
  const v4 = data('V4');
  const v5 = data('V5');
  const v6 = data('V6');
  const v6d = data('V6d');
  const v7 = data('V7');
  const v8 = data('V8');
  const v9 = data('V9');
  const v10 = data('V10');
  const v11 = data('V11');
  const v12 = data('V12');
  const v13 = data('V13');
  const v14 = data('V14');
  const v15 = data('V15');
  const v16 = data('V16');
  const v2 = data('V2');
  const shapes = (v1.shapes ?? {}) as Record<string, ShapeRow>;
  const classes = (v1.classes ?? []) as Array<{ class: string; sectors: string[] }>;
  const mobility = (v2.guardMobility ?? {}) as Record<string, { area: number; onRoute: boolean; onMainFloor: boolean; mobile: boolean }>;
  const combatRuns = ((v16.runs ?? []) as CombatRun[]).filter((r) => r && typeof r === 'object');
  const areas = (v1.areas ?? {}) as Record<string, number>;
  const floors = (v1.floors ?? {}) as Record<string, Array<[number, number]>>;
  const mandatory = (v4.mandatory ?? []) as string[];
  const optional = (v4.optional ?? []) as string[];
  const walk = ((v14.runs ?? []) as WalkRun[]).filter((r) => r && typeof r === 'object');
  const weakWalk = walk[0];
  const defWalk = walk[1];
  const detourWalk = walk.find((r) => r.main === false);

  // ── title ──
  L.push(`# ステージ設計書 / Stage design — ${stage.name} (\`${stage.id}\`)`);
  L.push('');
  L.push('> **Generated file — do not edit by hand.** Regenerate with `npx tsx tools/stageReport.ts` (`npm run report:stage`).');
  L.push('> Sources: the stage definition `src/stage/factory.ts` (+ `layout.ts`, `sectorsA–D.ts`, `dressing.ts`, `route.ts`, `builder.ts`) and the');
  L.push('> measurements of the stage validator `tools/stageAnalysis.ts` (`npx tsx tools/validateStage.ts`, `npm run validate:stage`).');
  L.push('> **Measured vs. declared.** Everything in the "Measured" columns and in §9 is computed by the validator from the real collision');
  L.push('> boxes. Declared by the designer and then *checked*: sector bounds and kinds (each kind must hold as a geometric property of');
  L.push('> the sector, §1), the take-off / landing points of the climbs (the smallest climb that really crosses each cut is measured');
  L.push('> next to the declared one, §5), the via points of branches and the waypoints of loops and routes (§6–§8).');
  L.push('');
  L.push('Units: metres, +Y up. Coordinates of the player and of enemies are hit-volume centres (a player standing on a floor at');
  L.push(`height h has y = h + ${PLAYER.half.y}; a guard y = h + ${ENEMIES.guard.centerHeight}; a turret y = h + ${ENEMIES.turret.centerHeight}). Boxes are axis-aligned \`x a..b, y a..b, z a..b\`.`);
  L.push('');

  // ── 0. summary ──
  L.push('## 0. 概要 / Summary');
  L.push('');
  const sz = stage.bounds;
  L.push(`- One continuous, fully enclosed facility: **${stage.sectors.length} sectors** (${classes.length} geometrically distinct kinds of space), ${stage.solids.length} collision boxes, ${stage.decor.length} decor boxes; stage bounds ${bx(sz)}; falling below y = ${num(stage.killY)} fails the sortie.`);
  L.push(`- Enemies: **${guards.length} guards + ${turrets.length} turrets = ${stage.enemies.length}** stationed in ${v2.sectorsWithEnemies ?? '–'} of the ${stage.sectors.length} sectors, of which **${controls.length} control turrets** (one per barrier). Every guard stands on a main floor or on a walkway that is one navigation region with a place the route visits.`);
  L.push(`- Player start ${pt(stage.playerStart.position)} in ${secName(sectorAt(stage.playerStart.position))}, yaw ${deg(stage.playerStart.yaw)} (yaw 0 looks along −Z).`);
  L.push(`- Final gate \`${stage.finalGate.id}\` ${stage.finalGate.name}: ${bx(stage.finalGate.box)} — opens when all ${controls.length} control turrets are destroyed. Exit zone (clear condition): ${bx(stage.exitZone)}.`);
  const chain: string[] = [];
  for (const id of (v3.sectorSequence ?? []) as string[]) chain.push(id);
  if (chain.length) L.push(`- Sector sequence of the shortest route: ${chain.join(' → ')}.`);
  L.push('');
  L.push(`**Validation result: ${rep.result ?? (rep.pass ? 'PASS' : 'FAIL')}** — ${rep.checks.filter((c) => c.status === 'pass').length} checks passed, ${rep.checks.filter((c) => c.status === 'fail').length} failed, ${rep.checks.filter((c) => c.status === 'skipped').length} not run.`);
  L.push('');
  const lower = v3.lowerBound as number;
  const sum: string[][] = [];
  const add = (req: string, need: string, got: string, id: string): void => {
    sum.push([req, need, got, `${id} ${status(id)}`]);
  };
  const smallest = Object.entries(areas).sort((a, b) => a[1] - b[1])[0];
  add('区画数 / sectors', `≥ ${LIMITS.sectors}, each ≥ ${LIMITS.sectorArea} m² of reachable floor`, `${stage.sectors.length} (smallest ${smallest ? `${smallest[0]}: ${smallest[1]} m²` : '–'})`, 'V1');
  add('空間構成の違い / kinds of space', `≥ ${LIMITS.sectorKinds}, each a measured property of the sector`, `${classes.length} geometric classes (${classes.map((c) => `${c.class}: ${c.sectors.join(' ')}`).join(' · ')})`, 'V1');
  const mobs = Object.values(mobility);
  add('敵 / enemies', `${LIMITS.guards} guards + ${LIMITS.turrets} turrets, ${LIMITS.controls} control turrets in different sectors, all attackable; enemies in ≥ ${LIMITS.enemySectors} sectors; ≥ ${LIMITS.mobileGuards} guards able to walk to the route, ≥ ${LIMITS.mainFloorGuards} on main floors`, `${guards.length} + ${turrets.length}, ${controls.length} controls in ${new Set(controls.map((c) => c.sectorId)).size} sectors; enemies in ${v2.sectorsWithEnemies ?? '–'} sectors; ${mobs.filter((m) => m.mobile).length} mobile guards, ${mobs.filter((m) => m.onMainFloor).length} on main floors`, 'V2');
  add('必要な移動距離 / shortest feasible route', `≥ ${LIMITS.routeMin} m`, `proven lower bound **${n1(lower)} m**; grid shortest path Lgrid ${n1(v3.lgrid as number)} m; explicit swept route ${n1(v3.feasibleRouteLength as number)} m`, 'V3');
  add('必須経路 / mandatory sectors', `≥ ${LIMITS.mandatorySectors}`, `${mandatory.length} (${mandatory.join(', ')})`, 'V4');
  add('進行 / progression', 'each barrier and the gate is a true cut; control turrets attackable in order only', `${stage.barriers.length} barriers + gate; order ${stage.barriers.map((b) => b.controlEnemyId).join(' → ')}`, 'V5');
  const spots = (v6.spots ?? []) as Array<{ id: string; height: number; isCut: boolean; needsFlight: boolean; enEstimate: number; horizontal: number; minClimb: number | null }>;
  add('高低差 / mandatory flights', `≥ ${LIMITS.flightSpots} separate climbs of ${LIMITS.flightMin}–${LIMITS.flightMax} m needing flight`, `${spots.length}; declared climb / smallest climb that crosses the cut: ${spots.map((s) => `${s.id} ${num(s.height)} / ${s.minClimb === null ? '–' : num(s.minClimb)} m`).join(', ')}; cuts disjoint and nested ${((v6.order ?? []) as string[]).join(' < ')}`, 'V6');
  const fsim = (v6d.spots ?? []) as Array<{ id: string; runs?: FlightRun[] }>;
  const allRuns = fsim.flatMap((s) => s.runs ?? []);
  add('全構成で通過可能 / feasible for every loadout', 'real Sim lands every climb with all generator × legs combinations', allRuns.length ? `${allRuns.filter((r) => r.ok).length}/${allRuns.length} simulated flights landed; worst EN share ${num(Math.max(0, ...allRuns.filter((r) => r.ok).map((r) => (100 * r.enUsed) / r.maxEn)), 0)} %` : 'not run', 'V6d');
  const brs = (v7.branches ?? []) as BranchRow[];
  add('分岐 / branches', `≥ ${LIMITS.branches}: two separate passages (closing both cuts the route), the shorter one clearly more exposed`, `${brs.filter((b) => b.separation?.ok).length} structurally separate (${brs.map((b) => `${b.id} ${b.ownA && b.ownB ? `${num(b.ownA.mean)} vs ${num(b.ownB.mean)} firing lines/m` : '–'}`).join(', ')})`, 'V7');
  const lps = (v8.loops ?? []) as Array<{ id: string; waypoints: number; perimeter: number | null; hole?: number; enclosed?: number }>;
  add('環状経路 / loops', `≥ ${LIMITS.loops}: circuits around ≥ ${LIMITS.loopHole} m² that cannot be walked on (≥ ${LIMITS.loopHoleShare * 100} % of what they enclose)`, `${lps.length} (${lps.map((l) => `${l.id} ${l.perimeter === null ? '–' : n1(l.perimeter)} m around ${l.hole ?? '–'} m²${l.enclosed ? ` = ${num((100 * (l.hole ?? 0)) / l.enclosed, 0)} %` : ''}`).join(', ')})`, 'V8');
  const bands = (v9.bands ?? []) as Array<{ height: number; area: number }>;
  add('階層 / levels', `≥ ${LIMITS.bands} altitude bands, stacked floors`, `${bands.length} bands from ${bands.length ? num(bands[0].height) : '–'} m to ${bands.length ? num(bands[bands.length - 1].height) : '–'} m; ${num(v9.stackedArea as number, 0)} m² of stacked floor`, 'V9');
  const ar = (v10.arenas ?? []) as Array<{ id: string; long: number; short: number; fill: number; area: number; height: number; ok: boolean }>;
  const smallArena = [...ar].sort((a, b) => a.long * a.short - b.long * b.short)[0];
  add('広い戦闘空間 / arenas', `≥ ${LIMITS.arenas} of ≥ ${LIMITS.arenaLong} × ${LIMITS.arenaShort} m`, `${ar.filter((a) => a.ok).length} (smallest: ${smallArena ? `${smallArena.id} ${smallArena.long} × ${smallArena.short} m` : '–'})`, 'V10');
  const ma = (v11.arenas ?? []) as Array<{ id: string; enemies: number; coveredFraction: number; standingArea: number; ok: boolean }>;
  add('複数方向の攻撃 / multi-directional fire', `≥ ${LIMITS.multiArenas} arenas with ≥ ${LIMITS.multiEnemies} enemies covering ≥ ${LIMITS.multiFraction * 100} % of the floor over ≥ ${LIMITS.multiSpreadDeg}°`, `${ma.filter((a) => a.ok).length} (${ma.filter((a) => a.ok).map((a) => `${a.id} ${num(a.coveredFraction * 100, 0)} %`).join(', ')})`, 'V11');
  add('開始地点 / start', 'sheltered, 60 m free lane', `no enemy sees the start sector; lane ${num(v12.laneFree as number)} m free, floor ${num(v12.laneFloor as number)} m`, 'V12');
  add('形状 / geometry', 'enclosed, inside bounds, decor outside the player volume', `leak cells ${v13.leakCells ?? '–'}, decor intrusions ${v13.decorIntrusions ?? '–'}`, 'V13');
  add('実走 / walkthrough', 'real Sim plays the route to the exit', weakWalk && defWalk ? `weakest loadout: ${weakWalk.ok ? `cleared, ${n1(weakWalk.distance)} m in ${n1(weakWalk.seconds)} s` : 'FAILED'}; default loadout: ${defWalk.ok ? `cleared, ${n1(defWalk.distance)} m in ${n1(defWalk.seconds)} s` : 'FAILED'}${detourWalk ? `; detour route (weakest): ${detourWalk.ok ? `cleared, ${n1(detourWalk.distance)} m, ${detourWalk.visitedSectors.length} sectors` : 'FAILED'}` : ''}` : 'not run', 'V14');
  const gaps = (v15.gaps ?? []) as Array<{ length: number; sectors: string[] }>;
  add('経路の密度 / route defence', `no stretch > ${LIMITS.routeGap} m without an enemy firing line, ≥ ${LIMITS.routeCovered * 100} % of the route under fire (outside the start sector)`, `longest quiet stretch ${v15.longestGap ?? '–'} m${gaps.length ? ` (${gaps[0].sectors.join('/')})` : ''}; ${num(((v15.coveredShare as number) ?? 0) * 100, 0)} % under ≥ 1 firing line, ${num(((v15.share4 as number) ?? 0) * 100, 0)} % under ≥ 4`, 'V15');
  const reqRuns = combatRuns.filter((r) => r.required);
  add('生存可能性 / survivability', 'a plain fighting bot clears the route against the real enemy AI without cheats (default loadout, 3 seeds)', reqRuns.length ? `${reqRuns.filter((r) => r.ok).length}/${reqRuns.length} runs cleared; final HP ${reqRuns.map((r) => (r.ok ? String(Math.round(r.hpEnd)) : 'destroyed')).join(' / ')} of ${PLAYER.maxHp}` : 'not run', 'V16');
  L.push(...table(['SPEC §2.2 requirement', 'Required', 'Measured', 'Check'], sum));
  L.push('');

  // ── 1. sectors ──
  L.push('## 1. 区画 / Sectors');
  L.push('');
  L.push('A point belongs to a sector when it lies inside one of its bounds boxes (sector bounds are pairwise disjoint; adjacent rooms share');
  L.push('their 2 m walls, so the boxes tile the building). "Floors" lists the standing surfaces the player can reach (height: area), measured');
  L.push('by the validator; ★ = combat arena (≥ 60 × 50 m main floor).');
  L.push('');
  const perSector: Record<string, { g: number; t: number }> = {};
  for (const e of stage.enemies) {
    const o = (perSector[e.sectorId] ??= { g: 0, t: 0 });
    if (e.kind === 'guard') o.g++;
    else o.t++;
  }
  L.push(
    ...table(
      ['ID', '名称', 'Name', 'Kind', 'Arena', 'Mandatory', 'Bounds boxes', 'Reachable floors (height m: area m²)', 'Floor m²', 'Guards', 'Turrets'],
      stage.sectors.map((s) => {
        const fl = (floors[s.id] ?? []).filter(([, a]) => a >= 60);
        return [
          s.id,
          s.name,
          s.nameEn,
          KIND_JA[s.kind] ? `${s.kind} — ${KIND_JA[s.kind]}` : s.kind,
          s.combatArena ? '★' : '',
          mandatory.includes(s.id) ? 'yes' : optional.includes(s.id) ? 'optional' : '–',
          s.bounds.map((b) => `[${bx(b)}]`).join('<br>'),
          fl.map(([h, a]) => `${num(h)}: ${a}`).join(' · ') || '–',
          String(areas[s.id] ?? '–'),
          String(perSector[s.id]?.g ?? 0),
          String(perSector[s.id]?.t ?? 0),
        ];
      }),
    ),
  );
  L.push('');
  if (Object.keys(shapes).length) {
    L.push('Kinds of space (V1). A kind is not taken from the label: the declared kind of every sector must hold as the measured property in');
    L.push('the last column, and the requirement "≥ 6 kinds" is counted over the geometric classes. Spans are clear widths of the space the');
    L.push("player's box can be in; \"free square\" is the largest axis-aligned square of it; \"tall equipment\" is the share of the main floor's");
    L.push('bounding rectangle under free-standing obstacles in which the player cannot be lower than 4.5 m above the floor.');
    L.push('');
    L.push(
      ...table(
        ['Sector', 'Declared kind', 'Geometric class', 'Span x × z (m)', 'Free square (m)', 'Clear height (m)', 'Floor levels / stacked m²', 'Tall equipment', 'Rack rows', 'Walkways m²', 'Measured property that makes the kind'],
        stage.sectors.map((s) => {
          const q = shapes[s.id];
          if (!q) return [secName(s.id), s.kind, '–', '–', '–', '–', '–', '–', '–', '–', '–'];
          return [secName(s.id), s.kind, q.class, `${n1(q.spanX)} × ${n1(q.spanZ)}`, n1(q.openSquare), n1(q.height), `${q.bands} / ${q.stacked}`, `${num(q.tallFraction * 100, 1)} %`, String(q.tallRows), String(q.elevated), `${q.ok ? '' : 'NOT MET: '}${q.rule}`];
        }),
      ),
    );
    L.push('');
  }
  if (ar.length) {
    L.push('Arena floors (largest connected component of the main floor, V10) and multi-directional fire (V11):');
    L.push('');
    L.push(
      ...table(
        ['Sector', 'Main floor height', 'Extent (m)', 'Fill of bounding rectangle', 'Area m²', 'Enemies', 'Floor under fire from ≥ 4 enemies over ≥ 90°'],
        ar.map((a) => {
          const m = ma.find((q) => q.id === a.id);
          return [secName(a.id), `${num(a.height)} m`, `${a.long} × ${a.short}`, `${num(a.fill * 100, 0)} %`, String(a.area), m ? String(m.enemies) : '–', m ? `${num(m.coveredFraction * 100, 0)} % of ${m.standingArea} m²${m.ok ? '' : ' (does not count)'}` : '–'];
        }),
      ),
    );
    L.push('');
  }

  // ── 2. connections ──
  L.push('## 2. 接続関係 / Connection graph');
  L.push('');
  L.push(
    ...table(
      ['From', 'To', 'Kind', 'Barrier', 'Note'],
      stage.connections.map((c) => [secName(c.a), c.a === c.b ? '(exit zone inside the same sector)' : secName(c.b), CONN_JA[c.kind] ?? c.kind, c.barrierId ?? '', c.note ?? '']),
    ),
  );
  L.push('');
  L.push(`Mandatory sectors (blocking the sector disconnects the exit, V4): **${mandatory.length}** — ${mandatory.join(', ') || '–'}. Optional: ${optional.join(', ') || '–'}.`);
  L.push('');

  // ── 3. barriers ──
  L.push('## 3. 隔壁と制御砲台 / Barriers and control turrets');
  L.push('');
  L.push('Each barrier is a solid box that fills its doorway until its control turret is destroyed. The validator proves that every');
  L.push('barrier is a cut of the route and that control turret i+1 cannot be seen from anywhere reachable while barrier i is closed.');
  L.push('');
  const stages = (v5.stages ?? []) as Array<{ stage: number; turret: string; witness: { from: V3; dist: number } | null; nextTurret?: string; nextTurretVisibleFrom?: V3 | null }>;
  L.push(
    ...table(
      ['Barrier', '名称', 'Box', 'Between', 'Control turret', 'Turret position', 'Turret sector', 'Destroyed in the walkthrough from (distance)'],
      stage.barriers.map((b) => {
        const e = stage.enemies.find((q) => q.id === b.controlEnemyId);
        const w = weakWalk?.controls.find((c) => c.id === b.controlEnemyId);
        return [b.id, b.name, bx(b.box), `${b.fromSectorId} → ${b.toSectorId}`, b.controlEnemyId, e ? pt(e.position) : '–', e ? secName(e.sectorId) : '–', w ? `${pt(w.from)} (${n1(w.dist)} m)` : '–'];
      }),
    ),
  );
  L.push('');
  if (stages.length) {
    L.push('Progression order measured by V5 (barriers i..6 and the gate closed):');
    L.push('');
    L.push(
      ...table(
        ['Stage', 'Control turret', 'Attackable from the reachable region, e.g. from (distance)', 'Next control turret', 'Visible before its turn?'],
        stages.map((s) => [String(s.stage), s.turret, s.witness ? `${pt(s.witness.from)} (${n1(s.witness.dist)} m)` : 'NO', s.nextTurret ?? '–', s.nextTurret ? (s.nextTurretVisibleFrom ? `YES from ${pt(s.nextTurretVisibleFrom)}` : 'no') : '–']),
      ),
    );
    L.push('');
  }

  // ── 4. enemies ──
  L.push(`## 4. 敵の初期配置 / Enemy placement (${stage.enemies.length})`);
  L.push('');
  L.push(`Guards: hit sphere r ${ENEMIES.guard.radius} m, centre ${ENEMIES.guard.centerHeight} m above their floor, HP ${ENEMIES.guard.hp}, range ${ENEMIES.guard.range} m. Turrets: r ${ENEMIES.turret.radius} m, centre ${ENEMIES.turret.centerHeight} m above their base, HP ${ENEMIES.turret.hp}, range ${ENEMIES.turret.range} m.`);
  L.push('');
  L.push(
    ...table(
      ['ID', 'Kind', 'Sector', 'x', 'y', 'z', 'Stands on (m)', 'Yaw', 'Control turret of', 'Guard: walkable region (all barriers open)'],
      stage.enemies.map((e) => {
        const m = mobility[e.id];
        return [
          e.id,
          e.kind === 'guard' ? 'guard 警備ロボット' : 'turret 固定砲台',
          secName(e.sectorId),
          num(e.position.x),
          num(e.position.y),
          num(e.position.z),
          num(e.position.y - ENEMIES[e.kind].centerHeight),
          deg(e.yaw),
          e.isGateControl ? `**${e.barrierId ?? '?'}**` : '',
          e.kind !== 'guard' ? '' : m ? `${m.area} m², ${m.onRoute ? 'reaches the route' : 'OFF the route'}, ${m.onMainFloor ? 'main floor' : 'other level (walkway / gallery / upper storey)'}` : '–',
        ];
      }),
      '---rrrrr--',
    ),
  );
  L.push('');
  L.push(`Enemies per sector: ${stage.sectors.map((s) => `${s.id} ${(perSector[s.id]?.g ?? 0) + (perSector[s.id]?.t ?? 0)}`).join(' · ')} — ${v2.sectorsWithEnemies ?? '–'} sectors with enemies (required ≥ ${LIMITS.enemySectors}).`);
  L.push('');
  if (mobs.length) {
    L.push(`Guard mobility (V2, the game's NavGrid with every barrier open): **${mobs.filter((m) => m.mobile).length} of ${mobs.length}** guards have a walkable region of ≥ ${LIMITS.mobileGuardFloor} m² that contains a waypoint of the recommended route (required ≥ ${LIMITS.mobileGuards}); **${mobs.filter((m) => m.onMainFloor).length}** stand on the main floor of their sector (required ≥ ${LIMITS.mainFloorGuards}); the others stand on another level — catwalks, galleries, the upper storey of the inspection building — that is one navigation region with a place the route visits. The navigation grid has no climbing or dropping, so no guard is posted on an isolated deck or machine top; those vantage points are held by turrets.`);
    L.push('');
  }

  // ── 5. flight spots ──
  L.push('## 5. 飛行が必要な昇降箇所 / Mandatory climbs that need flight');
  L.push('');
  L.push(`A normal jump reaches ${num(PLAYER.jumpSpeed ** 2 / (2 * 18))} m. For each declared spot the validator checks: (a) blocking the \`cut\` box disconnects the exit`);
  L.push('(every route crosses it), (b) a jump-only closure from everything on the near side cannot get beyond the cut, (c) height and');
  L.push('6 × 6 m standing areas at both ends, (d) the real Sim flies it with every generator × legs combination, (e) the smallest climb');
  L.push('that crosses the cut. "Declared climb" is the recommended take-off (the floor in front of the opening); the **smallest climb**');
  L.push(`is measured, not declared: the lowest continuous rise above any resting place before the cut — deck, catwalk, machine top — that gets across (0.5 m resolution). It must be ≥ ${LIMITS.flightMin} m.`);
  L.push('');
  L.push(
    ...table(
      ['ID', 'Sector', 'From (take-off)', 'To (landing)', 'Declared climb', '(e) Smallest climb', 'Horizontal', 'Cut box', '(a) cut', '(b) needs flight', '(d) EN used: weakest 90 / default 120', 'Note'],
      stage.flightSpots.map((f) => {
        const m = spots.find((s) => s.id === f.id);
        const runs = fsim.find((s) => s.id === f.id)?.runs ?? [];
        const weak = runs.find((r) => r.generator === 'recovery' && r.legs === 'quadruped');
        const def = runs.find((r) => r.generator === 'balanced' && r.legs === 'biped');
        const en = (r: FlightRun | undefined): string => (!r ? 'not run' : r.ok ? `${n1(r.enUsed)} EN, ${num(r.seconds)} s` : `FAILED: ${r.reason}`);
        return [f.id, secName(f.sectorId), pt(f.from), pt(f.to), `${num(f.height)} m`, m && m.minClimb !== null ? `${num(m.minClimb)} m` : '–', m ? `${n1(m.horizontal)} m` : '–', bx(f.cut), m ? (m.isCut ? 'yes' : 'NO') : '–', m ? (m.needsFlight ? 'yes' : 'NO') : '–', `${en(weak)} / ${en(def)}${runs.length ? ` (${runs.filter((r) => r.ok).length}/${runs.length} combinations land)` : ''}`, f.note ?? ''];
      }),
    ),
  );
  L.push('');
  L.push(`Closest pair of from / to points of two different spots: ${num(v6.minSeparation as number, 1)} m (required ≥ ${LIMITS.flightSeparation} m). The cut boxes are pairwise disjoint and the climbs come strictly one after the other (${((v6.order ?? []) as string[]).join(' < ') || '–'}): no opening is counted twice. EN is regenerated only on the ground; smallest max EN ${GENERATOR_PARTS.recovery.maxEn}.`);
  L.push('');
  if (weakWalk?.climbs?.length) {
    const declared = (to: V3): string => stage.flightSpots.find((f) => Math.hypot(f.to.x - to.x, f.to.y - to.y, f.to.z - to.z) < 1)?.id ?? '';
    L.push(`Every climb the walkthrough bot (V14) had to fly on the recommended route — ${weakWalk.climbs.length} in total. Climbs that are on the route but are not`);
    L.push('declared flight spots are listed too: they are real mandatory climbs, but the conservative jump-only closure of check (b) cannot');
    L.push('certify them (the closure ignores that height is lost when dropping, so a climb below an earlier, higher floor never passes it).');
    L.push('');
    L.push(
      ...table(
        ['Route waypoint', 'Sector of the landing', 'Take-off', 'Landing', 'Height', 'Horizontal', 'EN used: weakest / default', 'Flight time: weakest / default', 'Declared spot'],
        weakWalk.climbs.map((c, i) => {
          const d = defWalk?.climbs?.[i];
          return [`#${c.waypoint}`, secName(stage.route[c.waypoint]?.sectorId ?? ''), pt(c.from), pt(c.to), `${n1(c.height)} m`, `${n1(c.horizontal)} m`, `${n1(c.enUsed)} / ${d ? n1(d.enUsed) : '–'}`, `${num(c.seconds)} s / ${d ? `${num(d.seconds)} s` : '–'}`, declared(c.to) || 'not declared'];
        }),
      ),
    );
    L.push('');
  }

  // ── 6. branches ──
  L.push('## 6. 分岐 / Branches (split and rejoin)');
  L.push('');
  L.push(`Each alternative is a real route from → via → to that stays ≥ ${LIMITS.branchAvoid} m away from the other via point. On top of that the validator`);
  L.push('requires **structure**: the 2 m slab through each via point closes one passage; with either passage closed the rejoin point is still');
  L.push('reachable, with both closed it is not (two separate passages, no third way — an open floor or a hole in the separating wall fails).');
  L.push('And a **tactical difference**, measured on each alternative\'s own section (the samples farther than');
  L.push(`${LIMITS.branchExclusive} m from the other alternative; the stretches at the split and the rejoin point are shared): the shorter alternative must be seen by`);
  L.push('more enemies, by more of them at once, and have at least twice the firing lines per metre (enemies at their initial positions,');
  L.push('all barriers open).');
  L.push('');
  L.push(
    ...table(
      ['ID', 'From', 'To', 'Alternative', 'Via', 'Length', 'Own section', 'Enemies with a firing line onto it', 'Max at once', 'Firing lines per metre', 'Separate passages', 'Description'],
      stage.branches.flatMap((b) => {
        const m = brs.find((q) => q.id === b.id);
        const sep = m?.separation ? (m.separation.ok ? `yes (slabs ⟂ ${m.separation.axisA} / ⟂ ${m.separation.axisB})` : `NO: ${m.separation.reason}`) : '–';
        const row = (name: string, via: V3, alt: BranchAlt | null | undefined, own: Expo | null | undefined, len: number | undefined, note: string): string[] => [
          b.id,
          pt(b.from),
          pt(b.to),
          name,
          pt(via),
          alt ? `${n1(alt.length)} m` : 'none',
          len !== undefined ? `${len} m` : '–',
          own ? `${own.enemies}${own.ids.length ? `: ${own.ids.join(' ')}` : ''}` : '–',
          own ? String(own.maxSimultaneous) : '–',
          own ? num(own.mean) : '–',
          sep,
          note,
        ];
        return [row('A', b.viaA, m?.A, m?.ownA, m?.ownLengthA, b.noteA), row('B', b.viaB, m?.B, m?.ownB, m?.ownLengthB, b.noteB)];
      }),
    ),
  );
  L.push('');

  // ── 7. loops ──
  L.push('## 7. 環状経路 / Local loops');
  L.push('');
  L.push(`Closed circuits whose consecutive waypoints are connected and which stay connected when a ball of ${LIMITS.loopBall} m around any one waypoint is blocked.`);
  L.push(`Structure: the plan polygon of the circuit must enclose ≥ ${LIMITS.loopHole} m² that cannot be walked on at the circuit's level (a solid core, or the void`);
  L.push(`between catwalks), these must be ≥ ${LIMITS.loopHoleShare * 100} % of everything it encloses, and no two non-adjacent waypoints may be joined by a straight walk —`);
  L.push('waypoints on an open floor, or a wide round about a crate, are not a loop.');
  L.push('');
  L.push(
    ...table(
      ['ID', 'Waypoints', 'Perimeter', 'Encloses', 'of which not walkable', 'Description'],
      stage.loops.map((l) => {
        const m = lps.find((q) => q.id === l.id);
        return [l.id, l.points.map(pt).join(' → '), m && m.perimeter !== null ? `${n1(m.perimeter)} m` : '–', m && m.enclosed !== undefined ? `${m.enclosed} m²` : '–', m && m.hole !== undefined ? `${m.hole} m²${m.enclosed ? ` (${num((100 * m.hole) / m.enclosed, 0)} %)` : ''}` : '–', l.note];
      }),
    ),
  );
  L.push('');

  // ── 8. route ──
  L.push('## 8. 攻略経路 / Recommended route');
  L.push('');
  let cum = 0;
  const rows: string[][] = stage.route.map((w, i) => {
    if (i > 0) {
      const p = stage.route[i - 1].position;
      cum += Math.hypot(w.position.x - p.x, w.position.y - p.y, w.position.z - p.z);
    }
    const t = weakWalk?.arrivals?.[i];
    const t2 = defWalk?.arrivals?.[i];
    return [String(i), secName(w.sectorId), num(w.position.x), num(w.position.y), num(w.position.z), n1(cum), typeof t === 'number' ? n1(t) : '–', typeof t2 === 'number' ? n1(t2) : '–', w.note ?? ''];
  });
  const segs = (v14.routeSegments ?? null) as { level: number; climbs: number; drops: number; problems: string[] } | null;
  L.push(`${stage.route.length} waypoints (player hit-box centres standing on the floor); waypoints without a note are corner points. The polyline can be`);
  L.push('followed **exactly as drawn**: a level segment is a straight walk (the real box sweeps freely over continuous floor), a climb');
  L.push('rises straight up at its lower waypoint and flies level to the landing, a drop walks level off the edge and falls at the lower');
  L.push(`waypoint${segs ? ` — checked for all ${segs.level} level segments, ${segs.climbs} climbs and ${segs.drops} drops (V14${segs.problems.length ? `, ${segs.problems.length} PROBLEMS` : ''})` : ''}. "Polyline" is the cumulative straight-line length (${n1(cum)} m in total); the`);
  L.push('measured shortest-route length is in §9 (V3). "t" is the simulated time at which the walkthrough bot (V14) reached the waypoint');
  L.push('with the weakest / the default loadout, walking only (no glide, no quick boost) and without fighting.');
  L.push('');
  L.push(...table(['#', 'Sector', 'x', 'y', 'z', 'Polyline m', 't weakest s', 't default s', 'Note'], rows, '--rrrrrr-'));
  L.push('');
  if (walk.length) {
    L.push('Walkthrough with the real simulation (V14): keyboard-level input only (W, mouse yaw, Space), real collision, gravity, EN and flight;');
    L.push('HP is refilled every tick and "shooting" is replaced by destroying the next control turret as soon as the standing player has a');
    L.push('clear line of ≤ 120 m from centre and muzzle. It proves that the route is physically passable, not that the fights are winnable.');
    L.push('');
    L.push(
      ...table(
        ['Route / loadout', 'Result', 'Simulated time', 'Distance travelled', 'Waypoints', 'Flights (max / total EN)', 'Lowest EN', 'Waiting for EN', 'Re-plans', 'Sectors entered'],
        walk.map((r) => [`${r.main === false ? '' : 'recommended route, '}${r.name}`, r.ok ? 'cleared' : `FAILED: ${r.reason}`, `${n1(r.seconds)} s`, `${n1(r.distance)} m`, `${r.waypointsReached}/${r.waypoints}`, `${r.flights} (${n1(r.maxFlightEn)} / ${n1(r.flightEn)})`, n1(r.minEn), `${n1(r.enWaitSeconds)} s`, String(r.replans ?? 0), `${r.visitedSectors.length}: ${r.visitedSectors.join(' ')}`]),
      ),
    );
    L.push('');
  }
  if (detour.length) {
    L.push('### 8.1 迂回経路 / Detour route (the B side of every branch)');
    L.push('');
    L.push('The same sortie through the covered / longer alternative of all four branches: the parts gallery S18, the lower storey of the');
    L.push('inspection building, the side tunnel and the service gallery S19. The control turrets T06 and T14 stand in their halls: T06 is shot');
    L.push('from the balcony opening of the vestibule, for T14 the route steps out of the entry vestibule and returns. Played by the walkthrough bot with the weakest loadout (V14); only the');
    L.push(`stretches that differ from the recommended route are listed (# = index in the ${detour.length}-waypoint detour route, see \`DETOUR_KEYS\` in src/stage/route.ts).`);
    L.push('');
    const main = new Set(stage.route.map((w) => `${w.position.x},${w.position.y},${w.position.z}`));
    const own = detour.map((w) => !main.has(`${w.position.x},${w.position.y},${w.position.z}`));
    const drows: string[][] = [];
    detour.forEach((w, i) => {
      // the detour's own waypoints plus the shared waypoint before and after each stretch
      if (!own[i] && !own[i - 1] && !own[i + 1]) return;
      const t = detourWalk?.arrivals?.[i];
      drows.push([String(i), secName(w.sectorId), num(w.position.x), num(w.position.y), num(w.position.z), typeof t === 'number' ? n1(t) : '–', w.note ?? '']);
    });
    L.push(...table(['#', 'Sector', 'x', 'y', 'z', 't weakest s', 'Note'], drows, '--rrrr-'));
    L.push('');
    if (detourWalk?.climbs?.length) {
      L.push(`Climbs flown on the detour route: ${detourWalk.climbs.map((c) => `#${c.waypoint} +${n1(c.height)} m (${n1(c.enUsed)} EN)`).join(', ')}.`);
      L.push('');
    }
  }

  // ── 8.2 route defence ──
  const dsec = (v15.sectors ?? []) as Array<{ id: string; length: number; uncovered: number; assigned: number; seeing: number; ids: string[] }>;
  if (dsec.length) {
    L.push('### 8.2 経路上の敵の射線 / Enemy firing lines along the route (V15)');
    L.push('');
    L.push('The route as drawn, sampled every metre; an enemy "has a firing line" when the sample is within its range and its muzzle has an');
    L.push('unobstructed line to the player\'s centre (enemies at their initial positions, all barriers open — guards will move, so this is a');
    L.push(`static picture). Outside the start sector no stretch longer than ${LIMITS.routeGap} m may be without a firing line.`);
    L.push('');
    L.push(
      ...table(
        ['Sector', 'Route in the sector (m)', 'Without a firing line (m)', 'Enemies stationed', 'Enemies with a line onto the route there', 'Which'],
        dsec.map((r) => [secName(r.id), String(r.length), String(r.uncovered), String(r.assigned), String(r.seeing), r.ids.join(' ')]),
        '-rrrr-',
      ),
    );
    L.push('');
    L.push(`Longest stretch without a firing line: **${v15.longestGap ?? '–'} m**${gaps.length ? ` (stretches ≥ 20 m: ${gaps.map((q) => `${q.length} m in ${q.sectors.join('/')}`).join(', ')})` : ' (no stretch of 20 m or more)'}. Under ≥ 1 firing line: ${num(((v15.coveredShare as number) ?? 0) * 100, 0)} % of the route outside the start sector; under ≥ 2: ${num(((v15.share2 as number) ?? 0) * 100, 0)} %; under ≥ 4: ${num(((v15.share4 as number) ?? 0) * 100, 0)} %; most at one point: ${v15.maxSimultaneous ?? '–'}.${((v15.neverSeeRoute ?? []) as string[]).length ? ` Enemies that do not see the route from where they start: ${((v15.neverSeeRoute ?? []) as string[]).join(' ')}.` : ''}`);
    L.push('');
  }

  // ── 8.3 combat ──
  if (combatRuns.length) {
    L.push('### 8.3 戦闘ありの実走 / Combat walkthrough (V16)');
    L.push('');
    L.push('The same bot, but **without cheats**: HP is real and nothing is destroyed for free. It follows the recommended route and fights with');
    L.push('the real weapons and the real FCS against the real enemy AI: target = the next control turret when it can be engaged, otherwise the');
    L.push('nearest enemy that currently has a firing line on it; mouse-look puts the camera centre on the target; beam while EN ≥ 60 (down to');
    L.push('16), otherwise machine gun once locked; while fighting it stands on its floor and strafes left / right, reversing every 0.35–0.65 s.');
    L.push('It never glides, quick-boosts, takes cover or fights in the air — it has perfect aim and reactions but no tactics: a floor for what a');
    L.push('player can do, not a model of a first-time player. The simulation is deterministic for a seed (enemy aim jitter, AI choices).');
    L.push('');
    L.push(
      ...table(
        ['Run', 'Result', 'Time (fighting)', 'Final HP', 'Damage taken', 'Enemy shots fired', 'Enemies destroyed', 'Shots MG / beam / missile', 'HP when B1 … B6 opened'],
        combatRuns.map((r) => [
          `${r.name}${r.required ? '' : ' (informative)'}`,
          r.ok ? 'cleared' : `FAILED: ${r.reason}`,
          `${n1(r.seconds)} s (${n1(r.fightSeconds)} s)`,
          `${Math.round(r.hpEnd)} / ${PLAYER.maxHp}`,
          String(Math.round(r.damageTaken)),
          String(r.enemyShots),
          `${r.kills.length} / ${stage.enemies.length}`,
          `${r.shots.machinegun} / ${r.shots.beam} / ${r.shots.missile}`,
          r.hpAtBarrier.map((b) => String(Math.round(b.hp))).join(' · ') || '–',
        ]),
      ),
    );
    L.push('');
    const first = combatRuns[0];
    if (first) {
      L.push(`Damage taken per sector in the first run: ${stage.sectors.filter((q) => first.damageBySector[q.id]).map((q) => `${q.id} ${Math.round(first.damageBySector[q.id])}`).join(' · ') || '–'}. Order of kills: ${first.kills.join(' ')}.`);
      L.push('');
    }
  }

  // ── 9. validation ──
  L.push('## 9. 検証結果 / Measured validation results');
  L.push('');
  const grid = rep.grid as { cells?: number[]; cellSize?: number[]; reachableStrictCells?: number; reachableLooseCells?: number; standingCells?: number };
  if (grid.cells) {
    L.push(`Voxel model: ${grid.cells.join(' × ')} cells of ${grid.cellSize!.join(' × ')} m over the stage bounds. A cell is free when the player's box (${2 * PLAYER.half.x} × ${2 * PLAYER.half.y} × ${2 * PLAYER.half.z} m) centred`);
    L.push('on it overlaps no solid (STRICT, used for "possible" claims) or when any point of the cell is a legal player centre (LOOSE, used for');
    L.push(`"impossible / unavoidable" claims). Reachable with all barriers open: ${grid.reachableStrictCells} strict / ${grid.reachableLooseCells} loose cells, ${grid.standingCells} m² of standing floor.`);
    L.push('Free-flight reachability ignores gravity and EN, so it over-estimates what a player can do: lower bounds and "must cross" results derived from it are safe.');
    L.push('');
  }
  L.push('### 9.1 最短経路 / Shortest route (V3)');
  L.push('');
  L.push(
    ...table(
      ['Quantity', 'Value', 'Meaning'],
      [
        ['Lgrid', `${n1(v3.lgrid as number)} m`, 'shortest 26-neighbour grid path start → exit zone through STRICT-free cells, every barrier and the gate open (free flight)'],
        ['LgridLoose', `${n1(v3.lgridLoose as number)} m`, 'same on the LOOSE (over-approximated) free space'],
        ['Proven lower bound', `**${n1(v3.lowerBoundProven as number)} m**`, `octagonal hop count ${v3.hopCount} − 1 on the LOOSE grid; holds for every continuous path of the player's centre, whatever the movement ability`],
        ['Voxel-model lower bound', `${n1(v3.lowerBoundVoxel as number)} m`, '(LgridLoose − 2.5) / 1.128 (worst-case ratio of the grid metric to the Euclidean metric)'],
        ['Lower bound used', `**${n1(lower)} m ≥ ${LIMITS.routeMin} m**`, 'max of the two bounds'],
        ['Explicit feasible route', `${n1(v3.feasibleRouteLength as number)} m`, `string-pulled polyline, every segment swept with the real collision World${v3.feasibleRouteValid ? '' : ' — NOT VALID'} (upper bound of the free-flight optimum)`],
        ['Walked route (V14)', weakWalk ? `${n1(weakWalk.distance)} m` : 'not run', 'distance really travelled by the walkthrough bot along the recommended route (gravity, EN, real physics)'],
      ],
    ),
  );
  L.push('');
  L.push(`The true shortest route (even with unlimited flight) therefore lies between ${n1(lower)} m and ${n1(v3.feasibleRouteLength as number)} m; a real sortie is longer because the player has to walk, drop and climb.`);
  L.push('');
  const fr = (v3.feasibleRoute ?? []) as number[][];
  if (fr.length) {
    L.push(`<details><summary>Explicit feasible free-flight route: ${fr.length} points (x, y, z)</summary>`);
    L.push('');
    L.push('```');
    for (let i = 0; i < fr.length; i += 4) L.push(fr.slice(i, i + 4).map((p) => `(${p.map((v) => num(v)).join(', ')})`).join(' → ') + (i + 4 < fr.length ? ' →' : ''));
    L.push('```');
    L.push('');
    L.push('</details>');
    L.push('');
  }
  if (bands.length) {
    L.push('### 9.2 階層 / Altitude bands (V9)');
    L.push('');
    L.push(...table(['Floor height (m)', ...bands.map((b) => num(b.height))], [['Standing area within ±1 m (m²)', ...bands.map((b) => String(b.area))]]));
    L.push('');
  }
  L.push('### 9.3 全チェックの出力 / Full validator output');
  L.push('');
  for (const c of rep.checks) {
    L.push(`**${c.id} — ${c.status === 'pass' ? 'PASS' : c.status === 'fail' ? 'FAIL' : 'NOT RUN'}** — ${c.title}`);
    L.push('');
    L.push('```');
    for (const l of c.lines) L.push(l);
    for (const w of c.warnings) L.push(`warning: ${w}`);
    L.push('```');
    L.push('');
  }

  // ── 10. limits ──
  L.push('## 10. 検証の限界 / What these checks do not show');
  L.push('');
  L.push('- V3–V8 are free-flight statements (gravity and EN ignored). They bound the real game from the safe side; the real-physics evidence is V6d (every declared climb, all generator × legs combinations), V14 (both routes, walked) and V16 (the recommended route, fought).');
  L.push('- V14 does not fight (HP refilled, control turrets destroyed on sight): it shows that the routes are passable. V16 fights without cheats, but with a bot: perfect aim and reactions, no glide / quick boost / cover. It shows that a sortie is survivable with the real enemy AI as it is now; it does not predict how long a first-time player needs (the bot takes about 5 minutes, walking), and its result changes when the enemy AI or the weapons change.');
  L.push('- V5 "not visible before its turn", V11, V15 and the exposure numbers of §6 are dense samplings of lines of sight from the initial enemy positions; moving guards are not modelled.');
  L.push('- V2 guard mobility uses the game\'s NavGrid, which has no climbing or dropping: a guard on a walkway (crane deck, catwalks, galleries) stays on that level. Such walkways are connected to a place the route visits, so these guards can still close in on a player who is up there and move to regain a firing line on one who is not.');
  L.push('- The firing slits of the galleries S18 / S19, the roof trusses and the turret masts were placed by measurement (V7, V11), not by play-testing with a human.');
  L.push('');
  return L.join('\n');
}

async function main(): Promise<number> {
  const args = proc.argv.slice(2);
  let json: string | null = null;
  let out = 'docs/STAGE.md';
  let saveJson: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') json = args[++i] ?? null;
    else if (a === '--out') out = args[++i] ?? out;
    else if (a === '--save-json') saveJson = args[++i] ?? null;
    else {
      console.error(`unknown argument: ${a}`);
      return 2;
    }
  }
  const fsName = 'node:fs';
  const fs = (await import(/* @vite-ignore */ fsName)) as NodeFs;
  const stage = getFactoryStage();
  let rep: StageReport;
  if (json) {
    rep = JSON.parse(fs.readFileSync(json, 'utf8')) as StageReport;
    const g = rep.grid as { solids?: number; decor?: number };
    if (rep.stageId !== stage.id || g.solids !== stage.solids.length || g.decor !== stage.decor.length) {
      console.error(`[stageReport] ${json} does not belong to the current stage (stage ${rep.stageId}, ${g.solids} solids, ${g.decor} decor; now ${stage.id}, ${stage.solids.length}, ${stage.decor.length}) — run the validator again`);
      return 2;
    }
  } else {
    console.error('[stageReport] running the stage validation (about a minute) …');
    rep = analyzeStage(stage, { extraRoutes: [{ name: DETOUR_NAME, route: getFactoryDetourRoute() }], log: (s) => console.error(`[stageReport] ${s}`) });
  }
  const mkdirFor = (file: string): void => {
    const dir = file.replace(/[\\/][^\\/]*$/, '');
    if (dir && dir !== file) fs.mkdirSync(dir, { recursive: true });
  };
  if (saveJson) {
    mkdirFor(saveJson);
    fs.writeFileSync(saveJson, JSON.stringify(rep, null, 2));
  }
  mkdirFor(out);
  fs.writeFileSync(out, build(stage, rep, getFactoryDetourRoute()));
  const failed = rep.checks.filter((c) => c.status === 'fail').map((c) => c.id);
  const skipped = rep.checks.filter((c) => c.status === 'skipped').map((c) => c.id);
  const result = rep.result ?? (rep.pass ? 'PASS' : 'FAIL');
  console.error(`[stageReport] ${out} written — validation ${result}${failed.length ? ` (failed: ${failed.join(', ')})` : ''}${skipped.length ? ` (not run: ${skipped.join(', ')})` : ''}`);
  return result === 'PASS' ? 0 : result === 'INCOMPLETE' ? 3 : 1;
}

main().then(
  (code) => {
    proc.exitCode = code;
  },
  (e) => {
    console.error(e);
    proc.exitCode = 2;
  },
);
