/**
 * Tests of the stage VALIDATOR itself (src/stage/validate.ts) on synthetic stages:
 *  - a passing synthetic stage passes every required check (real World + real Game physics for the flight climbs),
 *  - every check has a failing variant,
 *  - the route length estimate is compared with analytically known shortest routes.
 * The campaign stage is tested in tests/stage.test.ts.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { PLAYER } from '../src/config';
import { buildTestArenaStage } from '../src/sim/testArena';
import type { BoxDef, StageDef, V3 } from '../src/sim/types';
import { validateStage } from '../src/stage/validate';
import type { StageReport, ValidateOptions } from '../src/stage/validate';
import { buildSyntheticStage, cloneStage } from './syntheticStage';

const FAST: ValidateOptions = { runClimbBot: false, relaxedRoute: false, altRouteGrid: false };
const run = (stage: StageDef, opts: ValidateOptions = FAST): StageReport => validateStage(stage, opts);

function check(rep: StageReport, name: string) {
  const c = rep.checks.find((x) => x.name === name);
  if (!c) throw new Error(`check ${name} not found (have: ${rep.checks.map((x) => x.name).join(', ')})`);
  return c;
}
function expectFail(rep: StageReport, name: string): void {
  const c = check(rep, name);
  expect(c.pass, `${name} should FAIL but passed: ${c.details}`).toBe(false);
}
function expectPass(rep: StageReport, name: string): void {
  const c = check(rep, name);
  expect(c.pass, `${name} should pass: value=${String(c.value)} ${c.details}`).toBe(true);
}
function noInternalErrors(rep: StageReport): void {
  const bad = rep.checks.filter((c) => c.name.startsWith('internal.'));
  expect(bad.map((c) => `${c.name}: ${c.details}`)).toEqual([]);
}

const box = (id: string, min: V3, max: V3, sectorId = 'S01'): BoxDef => ({ id, min, max, mat: 'concrete', sectorId });
const v = (x: number, y: number, z: number): V3 => ({ x, y, z });

/** replace a wall slab x in [x0, x1], z in [0, zMax], y in [0, 32] by pieces around the given holes */
function rebuildWallX(stage: StageDef, prefix: string, sid: string, x0: number, x1: number, zMax: number, holes: { z0: number; z1: number; y0: number; y1: number }[]): void {
  stage.boxes = stage.boxes.filter((b) => !b.id.startsWith(`${prefix}-`));
  let n = 0;
  const add = (z0: number, z1: number, y0: number, y1: number): void => {
    if (z1 - z0 > 1e-6 && y1 - y0 > 1e-6) stage.boxes.push(box(`${prefix}-n${n++}`, v(x0, y0, z0), v(x1, y1, z1), sid));
  };
  let cur = 0;
  for (const h of [...holes].sort((a, b) => a.z0 - b.z0)) {
    add(cur, h.z0, 0, 32);
    add(h.z0, h.z1, 0, h.y0);
    add(h.z0, h.z1, h.y1, 32);
    cur = h.z1;
  }
  add(cur, zMax, 0, 32);
}

// ---------------------------------------------------------------------------------------------------------------------
// The passing synthetic stage
// ---------------------------------------------------------------------------------------------------------------------
describe('validator: passing synthetic stage', () => {
  let stage: StageDef;
  let rep: StageReport;
  beforeAll(() => {
    stage = buildSyntheticStage();
    rep = validateStage(stage);
  });

  it('has the expected size (sanity of the fixture itself)', () => {
    expect(stage.sectors.length).toBe(19);
    expect(stage.enemies.length).toBe(45);
    expect(stage.barriers.length).toBe(7);
    expect(stage.climbs.length).toBe(6);
  });

  it('every required check passes and nothing threw', () => {
    noInternalErrors(rep);
    const failing = rep.checks.filter((c) => !c.advisory && !c.pass);
    expect(failing.map((c) => `${c.name}: ${c.details}`)).toEqual([]);
    expect(rep.pass).toBe(true);
    for (const c of rep.checks) {
      expect(typeof c.name).toBe('string');
      expect(typeof c.threshold).toBe('string');
      expect(c.details.length).toBeGreaterThan(0);
    }
  });

  it('route: > 1500 m, sweep-verified, passes >= 12 sectors, ordered', () => {
    expect(rep.route.found).toBe(true);
    expect(rep.route.length).toBeGreaterThan(1500);
    expect(rep.route.length).toBeGreaterThanOrEqual(rep.route.straightLength);
    expect(rep.route.length).toBeLessThanOrEqual(rep.route.gridLength + 1e-6);
    expect(rep.route.sectors.length).toBeGreaterThanOrEqual(12);
    expect(rep.route.sectors[0]).toBe('S01');
    expect(rep.route.sectors[rep.route.sectors.length - 1]).toBe('S16');
    // the optimistic (thinner player) estimate must not exceed the strict one by more than numerical noise
    const relaxed = validateStage(stage, { runClimbBot: false, relaxedRoute: true }).route.relaxedLength;
    expect(relaxed).not.toBeNull();
    expect((relaxed as number) <= rep.route.length + 5).toBe(true);
    expect(rep.route.barrierCrossings.length).toBe(7);
  });

  it('topology: 3 independent qualifying cycles found from the real free space, declared branches/loops valid', () => {
    expect(rep.structures.length).toBe(3);
    for (const s of rep.structures) {
      expect(Math.min(s.arcs[0], s.arcs[1])).toBeGreaterThanOrEqual(40);
      expect(Math.min(s.separation[0], s.separation[1])).toBeGreaterThanOrEqual(0.4);
      expect(s.sectors.length).toBe(3);
    }
    // with every barrier closed only the sectors before the first barrier are reachable
    expect(rep.barrierStates[rep.barrierStates.length - 1].reachableSectors).toEqual(['S01', 'S02', 'S03']);
    expect(rep.declaredBranches.every((b) => b.ok)).toBe(true);
    expect(rep.declaredLoops.every((l) => l.ok)).toBe(true);
    expect(rep.connections.length).toBe(stage.portals.length);
    expect(rep.connections.every((c) => c.portalId !== null)).toBe(true);
  });

  it('every barrier is mandatory (single closed state seals the escape zone)', () => {
    expect(rep.barrierStates.length).toBe(8);
    for (const r of rep.barrierStates) expect(r.goalReachable).toBe(false);
  });

  it('climbs: 6 climbs x 18 loadouts all land, EN stays within the smallest generator', () => {
    expect(rep.climbs.length).toBe(6);
    for (const c of rep.climbs) {
      expect(c.configs.length).toBe(18);
      expect(c.configs.every((x) => x.success), c.configs.filter((x) => !x.success).map((x) => x.failure).join('; ')).toBe(true);
      expect(c.jumpReaches).toBe(false);
      expect(c.jumpMaxRise).toBeLessThan(2.78 + 0.3);
      expect(c.measuredHeight).toBeCloseTo(12, 6);
      expect(c.maxEnUsed).toBeLessThanOrEqual(90);
      expect(c.onPath).toBe(true);
      // all 18 loadouts are really different combinations
      const keys = new Set(c.configs.map((x) => `${x.fcs}/${x.generator}/${x.legs}`));
      expect(keys.size).toBe(18);
    }
  });

  it('is a pure function: two runs on the same stage give identical reports (except timings)', () => {
    const strip = (r: StageReport): string => JSON.stringify({ ...r, timingsMs: null });
    const a = validateStage(stage, { runClimbBot: false, relaxedRoute: false });
    const b = validateStage(stage, { runClimbBot: false, relaxedRoute: false });
    expect(strip(a)).toBe(strip(b));
    // and it never mutates the stage
    expect(JSON.stringify(stage)).toBe(JSON.stringify(buildSyntheticStage()));
  });

  it('report is plain data (JSON serialisable, no NaN/Infinity in numbers)', () => {
    const json = JSON.stringify(rep);
    expect(json).not.toContain('NaN');
    expect(json).not.toContain('Infinity');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Failing variants (one per check family)
// ---------------------------------------------------------------------------------------------------------------------
describe('validator: failing variants', () => {
  it('too few sectors / route too short / too few route sectors', () => {
    const rep = run(buildSyntheticStage({ chain: 11, cycles: [3, 7] }));
    noInternalErrors(rep);
    expectFail(rep, 'sectors.count'); // 11 + 2 side rooms
    expectFail(rep, 'route.length');
    expectFail(rep, 'route.sectors');
    expectFail(rep, 'shortcut.minHops');
    expect(rep.route.length).toBeLessThan(1500);
  });

  it('sector ids / overlaps / variety', () => {
    const dup = cloneStage(buildSyntheticStage());
    dup.sectors[3].id = dup.sectors[2].id;
    expectFail(run(dup), 'sectors.ids');
    const ov = cloneStage(buildSyntheticStage());
    ov.sectors[1].bounds.min.x -= 5;
    expectFail(run(ov), 'sectors.overlap');
    const kinds = cloneStage(buildSyntheticStage());
    for (const s of kinds.sectors) s.kind = s.id < 'S10' ? 'yard' : 'factory';
    expectFail(run(kinds), 'sectors.variety');
  });

  it('enemy counts, ids, control mapping, buried spawns', () => {
    const a = cloneStage(buildSyntheticStage());
    a.enemies.pop();
    expectFail(run(a), 'enemies.count');
    const b = cloneStage(buildSyntheticStage());
    b.enemies[5].id = b.enemies[4].id;
    expectFail(run(b), 'enemies.ids');
    const c = cloneStage(buildSyntheticStage());
    const ctl = c.enemies.find((e) => e.isGateControl) as StageDef['enemies'][number];
    ctl.barrierId = 'B6';
    expectFail(run(c), 'enemies.controls');
    const d = cloneStage(buildSyntheticStage());
    const controls = d.enemies.filter((e) => e.isGateControl);
    controls[1].sectorId = controls[0].sectorId; // controls collapsed into one room
    expectFail(run(d), 'enemies.controls');
    const e = cloneStage(buildSyntheticStage());
    e.enemies[10].pos = v(e.enemies[10].pos.x, -1, e.enemies[10].pos.z); // centre inside the floor slab
    const re = run(e);
    expectFail(re, 'enemies.spawns');
    const f = cloneStage(buildSyntheticStage());
    f.enemies[12].pos = v(f.enemies[12].pos.x, 9, f.enemies[12].pos.z); // floating
    expectFail(run(f), 'enemies.spawns');
  });

  it('start exposed to an enemy / start overlapping a box', () => {
    const a = cloneStage(buildSyntheticStage());
    a.enemies[0].pos = v(60, 1.6, 30);
    a.enemies[0].sectorId = 'S01';
    const ra = run(a);
    expectFail(ra, 'start.safe');
    expect(check(ra, 'start.safe').details).toContain(a.enemies[0].id);
    const b = cloneStage(buildSyntheticStage());
    b.boxes.push(box('blocker', v(10, 0, 28), v(14, 6, 32)));
    expectFail(run(b), 'start.safe');
  });

  it('roof opening and open perimeter', () => {
    const a = cloneStage(buildSyntheticStage());
    a.boxes = a.boxes.filter((b) => b.id !== 'S06-ceil');
    const ra = run(a);
    noInternalErrors(ra);
    expectFail(ra, 'shell.roof');
    expectFail(ra, 'shell.perimeter');
    const b = cloneStage(buildSyntheticStage());
    b.boxes = b.boxes.filter((x) => !x.id.startsWith('S08-s-')); // south wall missing
    expectFail(run(b), 'shell.perimeter');
  });

  it('barrier that does not fill the opening: block check and leak check both fail', () => {
    const a = cloneStage(buildSyntheticStage());
    const bx = a.boxes.find((b) => b.id === 'B3-box') as BoxDef;
    bx.max.z -= 4; // 4 m gap in an 8 m opening
    const ra = run(a);
    expectFail(ra, 'barrier.block');
    expectFail(ra, 'shortcut.barrierLeak');
    const leak = ra.barrierStates.find((r) => r.closed.length === 1 && r.closed[0] === 'B3');
    expect(leak?.goalReachable).toBe(true);
    expect(leak?.confirmedLength).toBeGreaterThan(1500);
  });

  it('a bypass hole around a barrier is detected even when the barrier box itself is perfect', () => {
    const a = cloneStage(buildSyntheticStage());
    // B1 seals the high opening (z 10..18, y 12..19) in the wall between S03 and S04 (x = 330). Cut a second, unbarriered door
    // (z 40..48, y 0..7) through the same wall.
    const holes = [
      { z0: 10, z1: 18, y0: 12, y1: 19 },
      { z0: 40, z1: 48, y0: 0, y1: 7 },
    ];
    rebuildWallX(a, 'S03-e', 'S03', 328, 330, 90, holes);
    rebuildWallX(a, 'S04-w', 'S04', 330, 332, 90, holes);
    const ra = run(a);
    noInternalErrors(ra);
    expectPass(ra, 'barrier.block'); // the barrier itself still seals its own opening ...
    expectFail(ra, 'shortcut.barrierLeak'); // ... but it can be bypassed
    expectFail(ra, 'shortcut.undeclaredOpenings');
    const leak = ra.barrierStates.find((r) => r.closed.length === 1 && r.closed[0] === 'B1');
    expect(leak?.goalReachable).toBe(true);
  });

  it('undeclared opening', () => {
    const a = cloneStage(buildSyntheticStage());
    a.portals = a.portals.filter((p) => p.id !== 'P4');
    const ra = run(a);
    expectFail(ra, 'shortcut.undeclaredOpenings');
    expect(check(ra, 'shortcut.undeclaredOpenings').details).toContain('S05<->S06');
  });

  it('portal dimensions (declared) and passability (real geometry)', () => {
    const a = cloneStage(buildSyntheticStage());
    a.portals[3].width = 4;
    expectFail(run(a), 'portal.dimensions');
    const b = cloneStage(buildSyntheticStage());
    b.portals[3].height = 5.5;
    expectFail(run(b), 'portal.dimensions');
    const c = cloneStage(buildSyntheticStage());
    // P5 (x=660, z=76, low): a pillar leaves only a 1.4 m gap: declared 8x7 but nothing can pass
    c.boxes.push(box('pillar', v(656, 0, 72), v(664, 7, 78.6), 'S06'));
    const rc = run(c);
    expectFail(rc, 'portal.open');
    expect(check(rc, 'portal.open').details).toContain('P5');
    expectFail(rc, 'route.length');
  });

  it('too few branches / loops (side rooms removed)', () => {
    const rep = run(buildSyntheticStage({ cycles: [] }));
    noInternalErrors(rep);
    expectFail(rep, 'topology.branches');
    expectFail(rep, 'topology.loops');
    expect(rep.structures.length).toBe(0);
    // two cycles only: branches (3 required) fail, loops (2 required) pass
    const two = run(buildSyntheticStage({ cycles: [3, 7] }));
    expectFail(two, 'topology.branches');
    expectPass(two, 'topology.loops');
    // a cycle made of two doors between the same two rooms is a "small decoration": each arc is only ~32 m of walking
    const deco = cloneStage(buildSyntheticStage({ cycles: [] }));
    const holes = [
      { z0: 40, z1: 48, y0: 0, y1: 7 },
      { z0: 72, z1: 80, y0: 0, y1: 7 },
    ];
    rebuildWallX(deco, 'S04-e', 'S04', 438, 440, 90, holes);
    rebuildWallX(deco, 'S05-w', 'S05', 440, 442, 90, holes);
    const rd = run(deco);
    noInternalErrors(rd);
    expectFail(rd, 'topology.branches');
    expect(rd.structures.length).toBe(0);
    // two doors 64 m apart: each arc is >= 40 m of walking, but both arcs run side by side along the same wall: still decoration
    const wide = cloneStage(buildSyntheticStage({ cycles: [] }));
    const holes2 = [
      { z0: 12, z1: 20, y0: 0, y1: 7 },
      { z0: 76, z1: 84, y0: 0, y1: 7 },
    ];
    rebuildWallX(wide, 'S04-e', 'S04', 438, 440, 90, holes2);
    rebuildWallX(wide, 'S05-w', 'S05', 440, 442, 90, holes2);
    const rw = run(wide);
    noInternalErrors(rw);
    expectFail(rw, 'topology.branches');
    expect(rw.structures.length).toBe(0);
  });

  it('declared branches / loops that do not match reality', () => {
    const a = cloneStage(buildSyntheticStage());
    a.branches[0].routes[0].lengthMeters += 10;
    const ra = run(a);
    expectFail(ra, 'topology.declaredBranches');
    expect(ra.declaredBranches[0].ok).toBe(false);
    const b = cloneStage(buildSyntheticStage());
    b.branches[1].routes[1].points[2] = v(b.branches[1].routes[1].points[2].x, 1.5, 179); // ends inside the north wall
    expectFail(run(b), 'topology.declaredBranches');
    const c = cloneStage(buildSyntheticStage());
    const lp = c.loops[0];
    lp.points = [...lp.points.slice(0, 3), ...lp.points.slice(0, 2).reverse()]; // out and back on the same path
    lp.points.push(lp.points[0]);
    expectFail(run(c), 'topology.declaredLoops');
    const d = cloneStage(buildSyntheticStage());
    d.branches[2].routes[1].sectorIds = ['S12', 'S13'];
    expectFail(run(d), 'topology.declaredBranches');
    const e = cloneStage(buildSyntheticStage());
    e.branches.pop();
    expectFail(run(e), 'topology.declaredBranches'); // only 2 declared
  });

  it('too few wide arenas (a partition through every chain room)', () => {
    const a = cloneStage(buildSyntheticStage());
    for (let i = 0; i < 16; i++) {
      const x0 = i * 110;
      a.boxes.push(box(`part-${i}`, v(x0 + 2, 0, 44), v(x0 + 96, 12, 46), `S${String(i + 1).padStart(2, '0')}`));
    }
    const ra = run(a);
    noInternalErrors(ra);
    expectFail(ra, 'arena.wide');
    expect(check(ra, 'arena.wide').value).toBe(3); // only the three side rooms remain
  });

  it('crossfire needs 4 enemies of a room to see one point', () => {
    const a = cloneStage(buildSyntheticStage());
    // spread the enemies over the sectors so that none has 4
    a.enemies.forEach((e, i) => (e.sectorId = a.sectors[1 + (i % 15)].id));
    expectFail(run(a), 'combat.crossfire');
    // walls between the enemies and the floor: one full-height wall in every room hides half of them
    const b = cloneStage(buildSyntheticStage());
    for (let i = 0; i < 16; i++) {
      const x0 = i * 110;
      b.boxes.push(box(`hide-${i}`, v(x0 + 62, 0, 2), v(x0 + 64, 32, 60), `S${String(i + 1).padStart(2, '0')}`));
    }
    const rb = run(b);
    noInternalErrors(rb);
    // with the hiding walls fewer floor points see 4+ enemies; the check must still be computed from real line of sight
    expect(check(rb, 'combat.crossfire').value).toBeLessThanOrEqual(check(run(buildSyntheticStage()), 'combat.crossfire').value as number);
  });

  it('altitude layers', () => {
    const a = cloneStage(buildSyntheticStage());
    a.boxes = a.boxes.filter((b) => !b.id.endsWith('-ledge') && !b.id.endsWith('-mezz'));
    expectFail(run(a), 'layers.bands');
  });

  it('unreachable enemy / floor (sealed room)', () => {
    const a = cloneStage(buildSyntheticStage());
    // seal the turret of S05 (index in enemies) inside a closed box room 20 m x 20 m
    const e = a.enemies.find((x) => x.sectorId === 'S05') as StageDef['enemies'][number];
    const c = e.pos;
    const sx = 8;
    a.boxes.push(box('cell-w', v(c.x - sx - 2, 0, c.z - sx), v(c.x - sx, 20, c.z + sx), 'S05'));
    a.boxes.push(box('cell-e', v(c.x + sx, 0, c.z - sx), v(c.x + sx + 2, 20, c.z + sx), 'S05'));
    a.boxes.push(box('cell-n', v(c.x - sx - 2, 0, c.z + sx), v(c.x + sx + 2, 20, c.z + sx + 2), 'S05'));
    a.boxes.push(box('cell-s', v(c.x - sx - 2, 0, c.z - sx - 2), v(c.x + sx + 2, 20, c.z - sx), 'S05'));
    a.boxes.push(box('cell-t', v(c.x - sx - 2, 20, c.z - sx - 2), v(c.x + sx + 2, 22, c.z + sx + 2), 'S05'));
    const ra = run(a);
    expectFail(ra, 'reach.enemies');
    expect(check(ra, 'reach.enemies').details).toContain(e.id);
  });

  it('declared main route that cuts through a wall (advisory)', () => {
    const a = cloneStage(buildSyntheticStage());
    a.mainRoute.points.splice(3, 0, v(400, 3.5, 5));
    const c = check(run(a), 'route.declared');
    expect(c.pass).toBe(false);
    expect(c.advisory).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Flight climbs on tiny stages: real Game physics
// ---------------------------------------------------------------------------------------------------------------------
function climbArena(top: number, to: V3 = v(20, top, 0)): StageDef {
  const stage = buildTestArenaStage({ floorHalf: 70, platforms: [{ id: 'up', top: to, sizeX: 14, sizeZ: 14 }], start: { pos: v(0, 1.5, 0), yaw: 0 } });
  stage.climbs = [{ id: 'C1', sectorId: 'T00', from: v(0, 0, 0), to, heightMeters: top, note: 'test' }];
  return stage;
}

describe('validator: flight climbs (real player physics)', () => {
  it('a 12 m climb needs flight, and all 18 loadouts land on the upper platform', () => {
    const rep = validateStage(climbArena(12), { relaxedRoute: false });
    noInternalErrors(rep);
    const c = rep.climbs[0];
    expect(c.heightOk).toBe(true);
    expect(c.platformsOk).toBe(true);
    expect(c.jumpReaches).toBe(false);
    expect(c.configs.length).toBe(18);
    expect(c.configs.every((x) => x.success), c.configs.map((x) => x.failure).join('; ')).toBe(true);
    expectPass(rep, 'climb.height');
    expectPass(rep, 'climb.needsFlight');
    expectPass(rep, 'climb.flight18');
    // EN was really spent: flight costs 20 EN/s, a 12 m ascent at 8 m/s is >= 1.5 s
    expect(c.maxEnUsed).toBeGreaterThan(22);
    for (const cfg of c.configs) expect(cfg.flightSeconds).toBeGreaterThan(1.3);
  });

  it('a wall between the platforms: straight-up and diagonal bots fail, the path-following bot flies around it', () => {
    const stage = climbArena(12);
    stage.boxes.push(box('screen', v(8, 0, -12), v(10, 40, 12), 'T00')); // 24 m wide, 40 m high wall between from (x=0) and to (x=20)
    const rep = validateStage(stage, { relaxedRoute: false, loadouts: [{ fcs: 'medium', generator: 'recovery', legs: 'quadruped' }, { fcs: 'wide', generator: 'balanced', legs: 'biped' }] });
    noInternalErrors(rep);
    const c = rep.climbs[0];
    expect(c.configs.length).toBe(2);
    expect(c.configs.every((x) => x.success), c.configs.map((x) => x.failure).join('; ')).toBe(true);
    expect(c.configs.every((x) => x.strategy === 'path')).toBe(true);
    expect(c.configs.every((x) => x.enUsed <= 90)).toBe(true);
  });

  it('a 2 m step is reachable by a normal jump: flagged, and outside 6..16 m', () => {
    const rep = validateStage(climbArena(2), { runClimbBot: false, relaxedRoute: false });
    const c = rep.climbs[0];
    expect(c.jumpReaches).toBe(true);
    expect(c.jumpMaxRise).toBeGreaterThan(2.7);
    expect(c.jumpMaxRise).toBeLessThan(3.1);
    expectFail(rep, 'climb.needsFlight');
    expectFail(rep, 'climb.height');
  });

  it('a 5 m step is not reachable by jump but is outside the required 6..16 m range', () => {
    const rep = validateStage(climbArena(5), { runClimbBot: false, relaxedRoute: false });
    expect(rep.climbs[0].jumpReaches).toBe(false);
    expectPass(rep, 'climb.needsFlight');
    expectFail(rep, 'climb.height');
  });

  it('an ascent that costs more EN than the smallest generator is reported as a failure with the EN reason', () => {
    const rep = validateStage(climbArena(45), { relaxedRoute: false });
    const c = rep.climbs[0];
    const fails = c.configs.filter((x) => !x.success);
    expect(fails.length).toBeGreaterThan(0);
    // 45 m at 8 m/s = 5.6 s = 112 EN: 90 EN generators (recovery) cannot do it, 180 EN generators can
    expect(fails.every((x) => x.generator !== 'capacity')).toBe(true);
    expect(fails.some((x) => x.generator === 'recovery')).toBe(true);
    expect(fails[0].failure).toMatch(/EN|timeout|landed/);
    expectFail(rep, 'climb.flight18');
  });

  it('a landing platform under a low ceiling cannot be reached: failure', () => {
    const stage = climbArena(12);
    stage.boxes.push(box('low-ceiling', v(8, 14, -12), v(32, 16, 12), 'T00')); // 2 m above the landing platform: nobody fits
    const rep = validateStage(stage, { relaxedRoute: false });
    const c = rep.climbs[0];
    expect(c.platformsOk).toBe(false); // no room to stand on the upper platform
    expect(c.configs.every((x) => !x.success)).toBe(true);
    expectFail(rep, 'climb.flight18');
    expectFail(rep, 'climb.height');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Route estimate vs analytically known shortest routes
// ---------------------------------------------------------------------------------------------------------------------
function twoRooms(startZ: number, zone: { min: V3; max: V3 }, door = true): StageDef {
  const S = 'M';
  const boxes: BoxDef[] = [
    box('floor', v(-60, -2, -60), v(60, 0, 60), S),
    box('ceil', v(-60, 32, -60), v(60, 34, 60), S),
    box('wall-w', v(-60, 0, -60), v(-58, 32, 60), S),
    box('wall-e', v(58, 0, -60), v(60, 32, 60), S),
    box('wall-s', v(-60, 0, -60), v(60, 32, -58), S),
    box('wall-n', v(-60, 0, 58), v(60, 32, 60), S),
  ];
  if (door) {
    boxes.push(box('div-a', v(0, 0, -58), v(2, 32, -4), S));
    boxes.push(box('div-b', v(0, 0, 4), v(2, 32, 58), S));
  } else {
    boxes.push(box('div', v(0, 0, -58), v(2, 32, 58), S));
  }
  return {
    name: 'two-rooms',
    boxes,
    sectors: [{ id: S, name: 'M', kind: 'yard', bounds: { min: v(-60, -2, -60), max: v(60, 34, 60) }, floorY: 0, ceilingY: 32, combat: false, note: '' }],
    portals: [],
    barriers: [],
    enemies: [],
    playerStart: { pos: v(-30, 1.5, startZ), yaw: 0 },
    escapeZone: zone,
    mainRoute: { id: 'm', kind: 'main', note: '', points: [], sectorIds: [S] },
    branches: [],
    loops: [],
    climbs: [],
    killY: -50,
  };
}

describe('validator: route length accuracy (analytic references)', () => {
  it('straight line through a door: length == start -> nearest zone point', () => {
    const zone = { min: v(28, 0.2, -1), max: v(32, 6, 1) };
    const rep = run(twoRooms(0, zone));
    expect(rep.route.found).toBe(true);
    const expected = 28.01 + 30; // the route ends 1 cm inside the zone
    expect(rep.route.length).toBeGreaterThan(expected - 0.05);
    expect(rep.route.length).toBeLessThan(expected + 0.05);
  });

  it('around the door frame: length matches the exact taut string over the inflated corners', () => {
    // wall x in [0, 2], door z in [-4, 4]; player half x/z = 0.8 (+ 2 cm clearance used by the route)
    const h = PLAYER.HALF.x + 0.02;
    const c1 = v(0 - h, 1.5, 4 - h);
    const c2 = v(2 + h, 1.5, 4 - h);
    const start = v(-30, 1.5, 30);
    const q = v(28.01, 1.5, 28.01);
    const expected = Math.hypot(start.x - c1.x, start.z - c1.z) + (c2.x - c1.x) + Math.hypot(q.x - c2.x, q.z - c2.z);
    const zone = { min: v(28, 0.2, 28), max: v(32, 6, 32) };
    const rep = run(twoRooms(30, zone));
    expect(rep.route.found).toBe(true);
    expect(rep.route.length).toBeGreaterThan(expected - 0.05); // never shorter than the true optimum
    expect(rep.route.length).toBeLessThan(expected + 0.4); // and within 0.4 m (0.5 %)
  });

  it('a route requiring a detour through the door is never shorter than the straight distance', () => {
    const zone = { min: v(28, 0.2, 28), max: v(32, 6, 32) };
    const rep = run(twoRooms(30, zone));
    expect(rep.route.length).toBeGreaterThanOrEqual(rep.route.straightLength);
    expect(rep.route.gridLength).toBeGreaterThanOrEqual(rep.route.length - 1e-6);
  });

  it('no route when the divider has no door', () => {
    const zone = { min: v(28, 0.2, 28), max: v(32, 6, 32) };
    const rep = run(twoRooms(30, zone, false));
    expect(rep.route.found).toBe(false);
    expectFail(rep, 'route.length');
    noInternalErrors(rep);
  });

  it('a route can pass over a low obstacle (free flight) but never through it', () => {
    const zone = { min: v(28, 0.2, -1), max: v(32, 6, 1) };
    const st = twoRooms(0, zone);
    st.boxes.push(box('crate', v(-15, 0, -3), v(-5, 8, 3), 'M')); // 8 m high crate on the straight line
    const rep = run(st);
    expect(rep.route.found).toBe(true);
    expect(rep.route.length).toBeGreaterThan(58.01); // longer than straight
    expect(rep.route.length).toBeLessThan(58.01 + 3); // detour is small
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Robustness on degenerate stages (the stage tool must never crash)
// ---------------------------------------------------------------------------------------------------------------------
describe('validator: degenerate stages', () => {
  it('the flat test arena (no sectors of substance, no enemies) produces a failing report without throwing', () => {
    const rep = validateStage(buildTestArenaStage({ floorHalf: 40 }), { runClimbBot: false, relaxedRoute: false });
    expect(rep.pass).toBe(false);
    noInternalErrors(rep);
    expectFail(rep, 'sectors.count');
    expectFail(rep, 'enemies.count');
    expectFail(rep, 'route.length');
  });

  it('an empty stage', () => {
    const empty: StageDef = { ...buildTestArenaStage({ floorHalf: 0 }), boxes: [] };
    const rep = validateStage(empty, { runClimbBot: false, relaxedRoute: false });
    expect(rep.pass).toBe(false);
    expectFail(rep, 'route.length');
  });
});
