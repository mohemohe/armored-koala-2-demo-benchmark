/**
 * Validates the shipped stage (src/stage/factory.ts) against docs/SPEC.md §2.2 with the independent voxel
 * analysis of tools/stageAnalysis.ts (checks V1–V13 and V15, all derived from the real collision boxes) and
 * with the real simulation (V6d: every declared climb with every generator x legs combination; V14: the
 * recommended route and the detour route played from the start into the exit zone; V16: a fighting bot
 * against the real enemy AI).
 * Same analysis as `npx tsx tools/validateStage.ts`; one test per check so that failures are itemised.
 * No check may be skipped: a simulation check that does not run fails its test.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { CAMERA, CONTROLS_REQUIRED, PLAYER, TOTAL_ENEMIES } from '../src/config';
import { v3, yawFromDir, type V3 } from '../src/core/vec';
import { computeCameraRig, createCameraState } from '../src/sim/camera';
import { Sim } from '../src/sim/sim';
import { World } from '../src/sim/world';
import { buildFactoryStage, getFactoryDetourRoute, getFactoryStage } from '../src/stage/factory';
import { StageAnalyzer, analyzeStage, formatReport, type CheckResult, type StageReport } from '../tools/stageAnalysis';

const CHECKS: Array<[string, string]> = [
  ['V1', '>= 15 disjoint sectors with >= 150 m² of reachable floor each, >= 6 geometrically measured kinds'],
  ['V2', '30 guards + 15 turrets in >= 15 sectors, 6 control turrets in 6 sectors, all placed legally, attackable, guards mobile'],
  ['V3', 'shortest start → exit route (free flight, all barriers open): proven lower bound >= 1500 m'],
  ['V4', '>= 12 sectors that every route must cross'],
  ['V5', 'barriers and gate are true cuts; control turrets attackable in order only'],
  ['V6', '>= 6 separate mandatory climbs of 6–16 m that need flight (smallest crossing climb >= 6 m, disjoint nested cuts)'],
  ['V7', '>= 3 branch-and-rejoin structures: separate passages with a measured tactical difference'],
  ['V8', '>= 2 local circuits around something'],
  ['V9', '>= 3 altitude bands with stacked floors'],
  ['V10', '>= 5 arenas of >= 60 x 50 m'],
  ['V11', '>= 5 arenas under fire from >= 4 enemies over >= 90°'],
  ['V12', 'sheltered start with a free 60 m quick-boost lane'],
  ['V13', 'geometry inside bounds, enclosed, decor clear of the player volume, no coplanar faces, box budget'],
  ['V15', 'route defence: no stretch > 100 m without an enemy firing line'],
];

describe('factory stage definition', () => {
  it('is built deterministically and cached', () => {
    const a = buildFactoryStage();
    const b = buildFactoryStage();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(getFactoryStage()).toBe(getFactoryStage());
    expect(a.enemies.length).toBe(TOTAL_ENEMIES);
    expect(a.enemies.filter((e) => e.isGateControl).length).toBe(CONTROLS_REQUIRED);
    expect(a.enemies.map((e) => e.id)).toEqual([...a.enemies.map((e) => e.id)].sort());
    // every coordinate is a finite number
    for (const s of [...a.solids, ...a.decor]) {
      for (const v of [s.min.x, s.min.y, s.min.z, s.max.x, s.max.y, s.max.z]) expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('the game simulation starts on it: player at rest in the start sector, every barrier closed, nobody hurt', () => {
    const stage = getFactoryStage();
    const t0 = performance.now();
    const sim = new Sim(stage);
    const buildMs = performance.now() - t0;
    expect(buildMs).toBeLessThan(5000); // World + NavGrid of the whole factory (about 0.15 s on the dev machine)
    expect(sim.enemies.length).toBe(TOTAL_ENEMIES);
    expect(sim.controlsRequired).toBe(CONTROLS_REQUIRED);
    for (const b of stage.barriers) expect(sim.world.isBarrierOpen(b.id)).toBe(false);
    expect(sim.world.isBarrierOpen(stage.finalGate.id)).toBe(false);
    sim.runFor(3); // an idle player at the start is never hit: no enemy has a line of sight into the dock
    expect(sim.status).toBe('playing');
    expect(sim.player.grounded).toBe(true);
    expect(sim.player.pos.y).toBeCloseTo(PLAYER.half.y, 2);
    expect(sim.player.hp).toBe(PLAYER.maxHp);
    expect(sim.currentSectorId).toBe('S01');
    expect(sim.objective.gateOpen).toBe(false);
    expect(sim.getObjectiveTarget().id).toBe(stage.barriers[0].controlEnemyId);
    // every guard stands on the navigation grid the enemy AI will use
    for (const e of sim.enemies) if (e.kind === 'guard') expect(sim.nav.isWalkable(e.pos), e.id).toBe(true);
  });
});

describe('factory stage (SPEC §2.2)', () => {
  let report: StageReport;
  const get = (id: string): CheckResult | undefined => report.checks.find((c) => c.id === id);

  beforeAll(() => {
    report = analyzeStage(getFactoryStage(), { extraRoutes: [{ name: 'detour (B side of every branch)', route: getFactoryDetourRoute() }] });
    console.log(formatReport(report));
  }, 600_000);

  it('builds the voxel model', () => {
    expect(get('V0')?.problems ?? []).toEqual([]);
  });

  for (const [id, what] of CHECKS) {
    it(`${id}: ${what}`, () => {
      const c = get(id);
      expect(c, `check ${id} did not run`).toBeDefined();
      expect(c!.problems).toEqual([]);
      expect(c!.status).toBe('pass');
    });
  }

  it('no check was skipped: the validation is complete', () => {
    expect(report.checks.filter((c) => c.status === 'skipped').map((c) => c.id)).toEqual([]);
    expect(report.checks.map((c) => c.id)).toEqual(['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V6d', 'V7', 'V8', 'V9', 'V10', 'V11', 'V12', 'V13', 'V14', 'V15', 'V16']);
    expect(report.result).toBe('PASS');
    expect(report.pass).toBe(true);
  });

  it('V6d: every flight spot is flown by the real Sim with all 6 generator x legs combinations (weakest: EN 90, quadruped)', () => {
    const c = get('V6d');
    expect(c, 'check V6d did not run').toBeDefined();
    expect(c!.problems).toEqual([]);
    expect(c!.status).toBe('pass');
    const spots = c!.data.spots as Array<{ id: string; runs: Array<{ ok: boolean; enUsed: number; maxEn: number }> }>;
    expect(spots.length).toBeGreaterThanOrEqual(6);
    for (const s of spots) {
      expect(s.runs.length, s.id).toBe(6);
      for (const r of s.runs) {
        expect(r.ok, s.id).toBe(true);
        // a climb must leave a comfortable EN reserve even with the smallest generator
        expect(r.enUsed, s.id).toBeLessThanOrEqual(0.6 * r.maxEn);
      }
    }
  });

  it('V14: the real Sim plays the recommended route from the start into the exit zone (weakest and default loadout)', () => {
    const c = get('V14');
    expect(c, 'check V14 did not run').toBeDefined();
    expect(c!.problems).toEqual([]);
    expect(c!.status).toBe('pass');
    const runs = c!.data.runs as Array<{ name: string; ok: boolean; status: string; distance: number; replans: number; controls: Array<{ id: string }>; visitedSectors: string[] }>;
    expect(runs.length).toBe(3); // weakest + default on the recommended route, weakest on the detour route
    for (const r of runs) {
      expect(r.ok, r.name).toBe(true);
      expect(r.status).toBe('cleared');
      expect(r.controls.length).toBe(6);
      expect(r.distance).toBeGreaterThanOrEqual(1500);
      expect(r.visitedSectors.length).toBeGreaterThanOrEqual(12);
    }
    // the detour takes the optional sectors too: every sector of the stage is entered with real physics
    expect([...runs[2].visitedSectors].sort()).toEqual(getFactoryStage().sectors.map((s) => s.id).sort());
    // the recorded coordinates can be followed exactly as drawn
    expect((c!.data.routeSegments as { problems: string[] }).problems).toEqual([]);
  });

  it('V16: a fighting bot clears the route against the real enemy AI without cheats (default loadout, three seeds)', () => {
    const c = get('V16');
    expect(c, 'check V16 did not run').toBeDefined();
    expect(c!.problems).toEqual([]);
    expect(c!.status).toBe('pass');
    const runs = c!.data.runs as Array<{ name: string; required: boolean; ok: boolean; hpEnd: number; kills: string[]; enemyShots: number; hpAtBarrier: unknown[] }>;
    const required = runs.filter((r) => r.required);
    expect(required.length).toBe(3);
    for (const r of required) {
      expect(r.ok, r.name).toBe(true);
      expect(r.hpEnd, r.name).toBeGreaterThan(0);
      expect(r.hpAtBarrier.length).toBe(6);
      // the enemies really fought back, and the bot really shot its way through
      expect(r.enemyShots).toBeGreaterThan(50);
      expect(r.kills.length).toBeGreaterThanOrEqual(6);
    }
  });

  it('the numbers behind the review findings: enemies in >= 15 sectors, mobile guards, 6 m climbs, separate branches', () => {
    const v2 = get('V2')!.data as { sectorsWithEnemies: number; guardMobility: Record<string, { mobile: boolean; onMainFloor: boolean; area: number }> };
    expect(v2.sectorsWithEnemies).toBeGreaterThanOrEqual(15);
    const mob = Object.values(v2.guardMobility);
    expect(mob.length).toBe(30);
    expect(mob.filter((m) => m.mobile).length).toBeGreaterThanOrEqual(24);
    expect(mob.filter((m) => m.onMainFloor).length).toBeGreaterThanOrEqual(20);
    const spots = get('V6')!.data.spots as Array<{ id: string; minClimb: number; isCut: boolean; needsFlight: boolean }>;
    expect(spots.length).toBeGreaterThanOrEqual(6);
    for (const s of spots) {
      expect(s.isCut && s.needsFlight, s.id).toBe(true);
      expect(s.minClimb, s.id).toBeGreaterThanOrEqual(6);
    }
    const brs = get('V7')!.data.branches as Array<{ id: string; separation: { ok: boolean }; ownA: { mean: number }; ownB: { mean: number } }>;
    expect(brs.filter((b) => b.separation.ok).length).toBeGreaterThanOrEqual(3);
    const loops = get('V8')!.data.loops as Array<{ id: string; hole: number }>;
    expect(loops.filter((l) => l.hole >= 50).length).toBeGreaterThanOrEqual(2);
    const v1 = get('V1')!.data as { classes: Array<{ class: string }> };
    expect(v1.classes.length).toBeGreaterThanOrEqual(6);
    const v15 = get('V15')!.data as { longestGap: number; coveredShare: number };
    expect(v15.longestGap).toBeLessThanOrEqual(100);
    expect(v15.coveredShare).toBeGreaterThanOrEqual(0.6);
  });

  it('V7 and V8 are structural: without the gallery walls and the tunnel cores the same declarations fail', () => {
    // the review's mutation: the walls that separate the galleries S18 / S19 from their halls and the two
    // cores of the conveyor tunnel are removed; every declared via point and waypoint stays where it is
    const base = getFactoryStage();
    const drop = new Set(['gallery-wall', 'gallery-buttress', 'tunnel-core']);
    const mutated = { ...base, solids: base.solids.filter((q) => !drop.has(q.tag ?? '')) };
    expect(base.solids.length - mutated.solids.length).toBeGreaterThanOrEqual(18);
    const an = new StageAnalyzer(mutated, { flightSim: false });
    const v7 = an.checkBranches();
    expect(v7.status).toBe('fail');
    const brs = v7.data.branches as Array<{ id: string; separation: { ok: boolean }; problems: string[] }>;
    for (const id of ['BR1', 'BR3', 'BR4']) {
      const b = brs.find((q) => q.id === id)!;
      expect(b.separation.ok, id).toBe(false);
      expect(b.problems.join('\n'), id).toContain('not separate passages');
    }
    const v8 = an.checkLoops();
    expect(v8.status).toBe('fail');
    const loops = v8.data.loops as Array<{ id: string; problems: string[] }>;
    for (const id of ['LP3', 'LP4']) expect(loops.find((q) => q.id === id)!.problems.join('\n'), id).toContain('does not go around anything');
  }, 120_000);

  it('reports a consistent bracket for the shortest route', () => {
    const d = get('V3')!.data as Record<string, number | boolean>;
    expect(d.feasibleRouteValid).toBe(true);
    expect(d.lowerBound as number).toBeLessThanOrEqual(d.feasibleRouteLength as number);
    expect(d.lowerBoundProven as number).toBeLessThanOrEqual(d.feasibleRouteLength as number);
  });
});

describe('chase camera along the recommended route (SPEC §3: the mech stays visible while playing)', () => {
  /**
   * Of 18 sample points spread over the mech (6 heights from the feet to above the head × 3 across), how many
   * the chase camera — the real computeCameraRig — sees when the player stands at `pos` and aims at `target`.
   */
  const visiblePoints = (world: World, pos: V3, target: V3): number => {
    const dx = target.x - pos.x;
    const dy = target.y - (pos.y + CAMERA.pivotUp);
    const dz = target.z - pos.z;
    const cam = computeCameraRig(world, pos, yawFromDir(dx, dz), Math.atan2(dy, Math.hypot(dx, dz)), 16 / 9, createCameraState());
    let n = 0;
    for (const h of [-1.6, -0.8, 0, 0.8, 1.6, 2.3]) {
      for (const s of [-1, 0, 1]) if (!world.segmentBlocked(cam.pos, v3(pos.x + cam.right.x * s, pos.y + h, pos.z + cam.right.z * s))) n++;
    }
    return n;
  };

  it('at the six firing waypoints, aiming at the control turret, nothing stands between the camera and the mech', () => {
    // Review finding: at the T04 waypoint (then (324, 6, 62.5), 2.5 m north of a 5 m relay cabinet) the camera
    // looked over the cabinet top and the cabinet hid the whole mech (1 of 18 points; 0 pixels in the browser).
    const stage = getFactoryStage();
    const world = new World(stage);
    const lines: string[] = [];
    let found = 0;
    stage.route.forEach((wp, i) => {
      const m = /制御砲台(T\d+)\(/.exec(wp.note ?? '');
      if (!m) return;
      const e = stage.enemies.find((q) => q.id === m[1]);
      expect(e, `${m[1]} named by waypoint #${i}`).toBeDefined();
      if (!e) return;
      found++;
      const n = visiblePoints(world, v3(wp.position.x, wp.position.y + 0.001, wp.position.z), e.position);
      lines.push(`#${i} ${e.id} ${n}/18`);
      expect(n, `waypoint #${i} (${wp.position.x}, ${wp.position.y}, ${wp.position.z}) aiming at ${e.id}`).toBeGreaterThanOrEqual(15);
    });
    expect(found).toBe(CONTROLS_REQUIRED);
    console.log(`[stage] mech sample points seen by the chase camera at the firing waypoints: ${lines.join(' · ')}`);
  });

  it('looking along the route from every waypoint the mech is in view (one known exception, measured)', () => {
    // The camera rig only tests the line pivot → camera (it is part of the simulation's lock test and is not
    // changed here). Where the camera ends up on a higher floor than the mech, the edge of that floor can hide
    // the mech: after the drop from the B1 ledge into the mill (waypoint (194, 6, 84), looking at the next
    // waypoint) — documented in README 既知の問題. No other waypoint may join it unnoticed.
    const stage = getFactoryStage();
    const world = new World(stage);
    const hidden: string[] = [];
    let min = 18;
    let n = 0;
    for (let i = 0; i + 1 < stage.route.length; i++) {
      const a = stage.route[i].position;
      const b = stage.route[i + 1].position;
      if (Math.hypot(b.x - a.x, b.z - a.z) < 0.5) continue;
      n++;
      const seen = visiblePoints(world, v3(a.x, a.y + 0.001, a.z), b);
      if (seen < 6) hidden.push(`#${i} (${a.x}, ${a.y}, ${a.z}): ${seen}/18`);
      else min = Math.min(min, seen);
    }
    console.log(`[stage] chase camera at ${n} waypoints looking at the next one: fewer than 6 of 18 mech points at ${hidden.join(', ') || 'none'}; otherwise at least ${min}/18`);
    expect(hidden.length).toBeLessThanOrEqual(1);
    for (const h of hidden) expect(h).toContain('(194, 6, 84)');
  });
});

