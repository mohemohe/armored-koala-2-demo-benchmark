/**
 * Route guidance (src/sim/guide.ts) — docs/SPEC.md §2.1 "制御砲台と次の進行方向を識別できるように", §8 "次の目標".
 *
 * Part 1 uses a small hand-made stage (corridor, a side room with the control turret behind a screen, a ledge
 * with a barrier, a drop, a final gate) to pin down the rules one by one.
 * Part 2 uses the shipped factory stage: the complete walkthrough of the recommended route played by the bot of
 * tools/stageAnalysis.ts with the REAL simulation (weakest and default loadout), sampled positions all over the
 * stage in every objective state, the detour side of every branch, and the proof that guidance has no influence
 * on gameplay.
 *
 * "harness:" marks the places where a test writes plain state (player.pos, grounded) or calls a public Sim
 * method (damageEnemy) to set up a situation. Measured numbers are printed with the prefix "[guide]".
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_LOADOUT, PLAYER, TICK } from '../src/config';
import { v3, type V3 } from '../src/core/vec';
import { createGuideState, describeGuide, getRouteHint, updateGuide, type RouteHint } from '../src/sim/guide';
import { Sim } from '../src/sim/sim';
import { buildSnapshot } from '../src/sim/snapshot';
import type { Box, Loadout, SolidDef, StageDef } from '../src/sim/types';
import { getFactoryDetourRoute, getFactoryStage } from '../src/stage/factory';
import { makeTestStage, makeTurret } from '../src/stage/testStages';
import { StageAnalyzer, WEAKEST_LOADOUT, runWalkthrough } from '../tools/stageAnalysis';

// ───────────────────────────── helpers ─────────────────────────────
const dist = (a: V3, b: V3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const fmt = (p: V3): string => `(${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)})`;

/** Cumulative length of a route measured as drawn: level legs straight, climbs / drops as rise + run. */
function drawnCum(route: StageDef['route']): number[] {
  const cum = [0];
  for (let i = 0; i + 1 < route.length; i++) {
    const a = route[i].position;
    const b = route[i + 1].position;
    const dy = Math.abs(b.y - a.y);
    const hd = Math.hypot(b.x - a.x, b.z - a.z);
    cum.push(cum[i] + (dy > 0.5 ? hd + dy : Math.hypot(hd, dy)));
  }
  return cum;
}

/**
 * Route metres of a hint. `index` is the waypoint the hint stands on, or — for a point inside a leg — the end of
 * that leg in the direction of travel (the leg before `index` going forward, the leg after it going back).
 */
function hintMeters(route: StageDef['route'], cum: number[], h: RouteHint): number {
  const d = dist(h.position, route[h.index].position);
  if (d < 1e-9) return cum[h.index];
  return distanceToLeg(route, h.index, h.position) < 1e-6 ? cum[h.index] - d : cum[h.index] + d;
}

/** Distance from a hint to the route (its waypoint, or one of the two legs that meet there). */
function hintOffRoute(route: StageDef['route'], h: RouteHint): number {
  const before = distanceToLeg(route, h.index, h.position);
  return h.index + 1 < route.length ? Math.min(before, distanceToLeg(route, h.index + 1, h.position)) : before;
}

/** Distance from a point to the leg (index - 1 → index) of the route, or to waypoint `index`. */
function distanceToLeg(route: StageDef['route'], index: number, p: V3): number {
  const b = route[index].position;
  if (index === 0) return dist(p, b);
  const a = route[index - 1].position;
  const ux = b.x - a.x;
  const uy = b.y - a.y;
  const uz = b.z - a.z;
  const uu = ux * ux + uy * uy + uz * uz;
  const t = uu > 0 ? Math.min(1, Math.max(0, ((p.x - a.x) * ux + (p.y - a.y) * uy + (p.z - a.z) * uz) / uu)) : 0;
  return Math.hypot(p.x - a.x - ux * t, p.y - a.y - uy * t, p.z - a.z - uz * t);
}

function segmentHitsBox(a: V3, b: V3, box: Box): boolean {
  let t0 = 0;
  let t1 = 1;
  for (const k of ['x', 'y', 'z'] as const) {
    const d = b[k] - a[k];
    if (Math.abs(d) < 1e-12) {
      if (a[k] <= box.min[k] || a[k] >= box.max[k]) return false;
      continue;
    }
    const u0 = (box.min[k] - a[k]) / d;
    const u1 = (box.max[k] - a[k]) / d;
    t0 = Math.max(t0, Math.min(u0, u1));
    t1 = Math.min(t1, Math.max(u0, u1));
    if (t0 >= t1) return false;
  }
  return true;
}

/** harness: puts the player somewhere (a jump in position: the guide starts a fresh search). */
function place(sim: Sim, p: V3, grounded = true): RouteHint | null {
  sim.player.pos.x = p.x;
  sim.player.pos.y = p.y;
  sim.player.pos.z = p.z;
  sim.player.grounded = grounded;
  sim.currentSectorId = sim.world.sectorAt(p);
  updateGuide(sim);
  updateGuide(sim);
  return getRouteHint(sim);
}

/** harness: slides the player in a straight line in 0.5 m steps, six guide updates per step (10 m/s at 120 Hz). */
function glideTo(sim: Sim, to: V3, grounded = true, each?: (h: RouteHint) => void): void {
  const from = { ...sim.player.pos };
  const n = Math.max(1, Math.ceil(dist(from, to) / 0.5));
  for (let i = 1; i <= n; i++) {
    sim.player.pos.x = from.x + ((to.x - from.x) * i) / n;
    sim.player.pos.y = from.y + ((to.y - from.y) * i) / n;
    sim.player.pos.z = from.z + ((to.z - from.z) * i) / n;
    sim.player.grounded = grounded;
    sim.currentSectorId = sim.world.sectorAt(sim.player.pos) ?? sim.currentSectorId;
    for (let k = 0; k < 6; k++) updateGuide(sim);
    const h = getRouteHint(sim);
    if (h && each) each(h);
  }
}

function kill(sim: Sim, id: string): void {
  const e = sim.enemyById.get(id);
  if (!e) throw new Error('no enemy ' + id);
  sim.damageEnemy(e, e.hp + 1); // harness: the real objective code opens the barrier
}

// ───────────────────────────── part 1: a small stage ─────────────────────────────
/**
 * Corridor along +X (z -10 … 10). A door in its north wall (x 36 … 44) leads into a room; the control turret T1
 * stands in that room behind a screen, so it can only be seen from deep inside the room: the route makes an
 * out-and-back spur (waypoints 1 → 2 → 3). Further east an 8 m ledge (climb), barrier B1 on the ledge, a drop,
 * the final gate and the exit zone.
 */
function smallStage(): StageDef {
  const st = makeTestStage({ floorSize: 600, start: v3(0, 2.001, 0), yaw: -Math.PI / 2 });
  const wall = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): SolidDef => ({ min: v3(x0, y0, z0), max: v3(x1, y1, z1), material: 'wall' });
  st.solids.push(
    wall(-20, 0, 10, 160, 30, 12), // south wall
    wall(-20, 0, -12, 36, 30, -10), // north wall, west of the door
    wall(44, 0, -12, 160, 30, -10), // north wall, east of the door
    wall(44, 0, -16, 90, 30, -15), // screen: hides the turret from the door
    wall(-22, 0, -12, -20, 30, 12), // west end
    { min: v3(88, 0, -10), max: v3(108, 8, 10), material: 'concrete' }, // the ledge
  );
  const far = st.sectors[0].bounds[0];
  st.sectors = [
    { id: 'A', name: '通路', nameEn: 'Corridor', kind: 'corridor', bounds: [{ min: v3(far.min.x, far.min.y, far.min.z), max: v3(86, far.max.y, far.max.z) }] },
    { id: 'B', name: '段丘', nameEn: 'Ledge', kind: 'factory', bounds: [{ min: v3(86.001, far.min.y, far.min.z), max: v3(110, far.max.y, far.max.z) }] },
    { id: 'C', name: '出口', nameEn: 'Exit', kind: 'gate', bounds: [{ min: v3(110.001, far.min.y, far.min.z), max: v3(far.max.x, far.max.y, far.max.z) }] },
  ];
  st.enemies = [{ ...makeTurret('T1', 70, -22), sectorId: 'A', isGateControl: true, barrierId: 'B1', test: { passive: true } }];
  st.barriers = [{ id: 'B1', name: '隔壁', box: { min: v3(98, 8, -10), max: v3(100, 16, 10) }, controlEnemyId: 'T1', fromSectorId: 'B', toSectorId: 'B' }];
  st.finalGate = { id: 'GATE', name: 'gate', box: { min: v3(124, 0, -10), max: v3(126, 10, 10) } };
  st.exitZone = { min: v3(132, 0, -10), max: v3(150, 12, 10) };
  st.connections = [
    { a: 'A', b: 'B', kind: 'climb' },
    { a: 'B', b: 'C', kind: 'drop' },
  ];
  const w = (sectorId: string, x: number, y: number, z: number, note?: string): StageDef['route'][number] => (note ? { sectorId, position: v3(x, y, z), note } : { sectorId, position: v3(x, y, z) });
  st.route = [
    w('A', 0, 2, 0, 'start'),
    w('A', 40, 2, 0, 'door'),
    w('A', 40, 2, -24, 'room: shoot T1'),
    w('A', 40, 2, 0),
    w('A', 80, 2, 0, 'take-off'),
    w('B', 94, 10, 0, 'landing'),
    w('B', 104, 10, 0),
    w('C', 116, 2, 0, 'floor'),
    w('C', 140, 2, 0, 'exit'),
  ];
  return st;
}

describe('route guidance on a small stage', () => {
  it('analyses the route: barrier crossings in route order, the firing position inside the spur', () => {
    const sim = new Sim(smallStage());
    const d = describeGuide(sim);
    expect(d).not.toBeNull();
    if (!d) return;
    expect(d.waypoints).toBe(9);
    expect(d.gates.map((g) => g.barrierId)).toEqual(['B1', 'GATE']);
    expect(d.gates[0].crossLeg).toBe(5);
    expect(d.gates[0].controlEnemyId).toBe('T1');
    expect(d.gates[1].crossLeg).toBe(7);
    expect(d.gates[1].controlEnemyId).toBeNull();
    expect(d.spurs).toEqual([{ from: 1, apex: 2, to: 3, barrierId: 'B1' }]);
    // the turret is hidden by the screen until z < about -16.5; the firing position lies 3 m further in
    const g = d.gates[0];
    expect(g.fireSeen).toBe(true);
    expect(g.fireLeg).toBe(1);
    expect(g.firePosition.x).toBeCloseTo(40, 6);
    expect(g.firePosition.z).toBeLessThan(-18.5);
    expect(g.firePosition.z).toBeGreaterThan(-22.5);
    const turret = sim.enemyById.get('T1');
    expect(turret).toBeDefined();
    if (turret) expect(sim.world.segmentBlocked(g.firePosition, turret.pos)).toBe(false);
    expect(sim.world.segmentBlocked(v3(40, 2, -12), sim.enemyById.get('T1')?.pos ?? v3())).toBe(true);
    // the open part of the route: start … firing position (turn around) … door … take-off, landing, behind B1
    expect(d.effective.vertices).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(d.effective.goal).toBe(2);
    expect(d.effective.goalPosition).toEqual(g.firePosition);
  });

  it('leads to the firing position while the turret lives, flags the closed barrier and sees the turret from there', () => {
    const sim = new Sim(smallStage());
    const fire = describeGuide(sim)?.gates[0].firePosition ?? v3();
    let h = getRouteHint(sim);
    expect(h).not.toBeNull();
    if (!h) return;
    // at the start: the door 40 m ahead (the room is not in view yet)
    expect(h.index).toBe(1);
    expect(h.position).toEqual(v3(40, 2, 0));
    expect(h.kind).toBe('walk');
    expect(h.distance).toBeCloseTo(40, 1);
    expect(h.blockedByBarrierId).toBeNull();
    expect(h.backtrack).toBe(false);
    expect(h.note).toBe('door');
    expect(h.nextSectorId).toBeNull(); // the goal is in the player's own sector
    expect(h.remainingMeters).toBeCloseTo(40 + Math.abs(fire.z), 1);

    // walk east: the hint is never east of the door (the ledge and the barrier are not offered)
    glideTo(sim, v3(33, 2.001, 0), true, (x) => expect(x.position.x).toBeLessThanOrEqual(40.001));
    // near the door (reached within 5 m) the hint becomes the firing position in the room
    glideTo(sim, v3(38, 2.001, 0));
    h = getRouteHint(sim) as RouteHint;
    expect(h.position).toEqual(fire);
    expect(h.index).toBe(2);
    expect(h.blockedByBarrierId).toBe('B1');
    expect(h.controlEnemyId).toBe('T1');
    expect(h.controlVisible).toBe(false);
    expect(h.note).toBeNull();
    // into the room: the turret comes into view at the firing position
    glideTo(sim, v3(40, 2.001, -11));
    expect((getRouteHint(sim) as RouteHint).controlVisible).toBe(false);
    glideTo(sim, v3(40, 2.001, fire.z));
    h = getRouteHint(sim) as RouteHint;
    expect(h.blockedByBarrierId).toBe('B1');
    expect(h.controlVisible).toBe(true);
    expect(h.distance).toBeLessThan(0.1);
    expect(h.remainingMeters).toBeLessThan(0.1);
    expect(h.backtrack).toBe(false);
  });

  it('leads back to the firing position from in front of the closed barrier (never through it)', () => {
    const sim = new Sim(smallStage());
    const fire = describeGuide(sim)?.gates[0].firePosition ?? v3();
    // harness: the player flew up to the ledge without destroying T1
    let h = place(sim, v3(94, 10.001, 0)) as RouteHint;
    expect(h.backtrack).toBe(true);
    expect(h.position).toEqual(v3(80, 2, 0)); // back down to the take-off
    expect(h.kind).toBe('drop');
    expect(h.rise).toBeCloseTo(-8, 2);
    expect(h.blockedByBarrierId).toBeNull();
    expect(h.remainingMeters).toBeGreaterThan(60);
    // right at the door: still back, not through
    h = place(sim, v3(96.5, 10.001, 0)) as RouteHint;
    expect(h.backtrack).toBe(true);
    expect(h.position.x).toBeLessThan(96.5);
    // back in the corridor: door, then the firing position
    h = place(sim, v3(70, 2.001, 0)) as RouteHint;
    expect(h.backtrack).toBe(true);
    expect(h.position).toEqual(v3(40, 2, 0));
    h = place(sim, v3(41, 2.001, -2)) as RouteHint;
    expect(h.position).toEqual(fire);
    expect(h.blockedByBarrierId).toBe('B1');
  });

  it('after the turret is destroyed the spur is dropped, the hint follows climb and drop, and ends in the exit zone', () => {
    const st = smallStage();
    const sim = new Sim(st);
    place(sim, v3(40, 2.001, -20));
    kill(sim, 'T1');
    expect(sim.objective.gateOpen).toBe(true);
    updateGuide(sim);
    expect(sim.guide.phase).toBe(2);
    expect(describeGuide(sim)?.effective.vertices).toEqual([0, 1, 4, 5, 6, 7, 8]);
    // deep in the room, off the route: the way out through the door
    let h = getRouteHint(sim) as RouteHint;
    expect(h.blockedByBarrierId).toBeNull();
    expect(h.backtrack).toBe(false);
    expect(h.position.z).toBeCloseTo(0, 6);
    expect(h.position.x).toBeGreaterThanOrEqual(40);
    expect(h.position.x).toBeLessThanOrEqual(44);
    expect(h.offRouteMeters).toBeCloseTo(20, 0);
    // a player who never entered the room is not sent into it
    h = place(sim, v3(20, 2.001, 0)) as RouteHint;
    expect(h.position.z).toBe(0);
    expect(h.position.x).toBeGreaterThanOrEqual(40);
    expect(h.nextSectorId).toBe('B');
    // take-off: the landing, 8 m up
    h = place(sim, v3(78, 2.001, 0)) as RouteHint;
    expect(h.position).toEqual(v3(94, 10, 0));
    expect(h.kind).toBe('climb');
    expect(h.rise).toBeCloseTo(8, 2);
    // rising on the spot (in the air the hint is kept): climb until less than 1 m is missing
    glideTo(sim, v3(78, 8.9, 0), false, (x) => {
      expect(x.position).toEqual(v3(94, 10, 0));
      expect(x.kind).toBe('climb');
    });
    glideTo(sim, v3(78, 10.6, 0), false);
    h = getRouteHint(sim) as RouteHint;
    expect(h.position).toEqual(v3(94, 10, 0));
    expect(h.kind).toBe('walk');
    // on the ledge behind the open barrier: the floor 8 m below
    h = place(sim, v3(100, 10.001, 0)) as RouteHint;
    expect(h.position.y).toBe(2);
    expect(h.kind).toBe('drop');
    expect(h.blockedByBarrierId).toBeNull();
    // the last hint is the last waypoint, inside the exit zone
    h = place(sim, v3(118, 2.001, 0)) as RouteHint;
    expect(h.index).toBe(8);
    expect(h.position).toEqual(v3(140, 2, 0));
    const z = st.exitZone;
    expect(h.position.x > z.min.x && h.position.x < z.max.x && h.position.z > z.min.z && h.position.z < z.max.z).toBe(true);
    expect(h.remainingMeters).toBeCloseTo(22, 1);
  });

  it('in the air the climb / drop is judged against the span between the floor last stood on and the current height (review finding: "▼ drop 4 m" while flying above a level route)', () => {
    const st = smallStage();
    const sim = new Sim(st);
    place(sim, v3(40, 2.001, -20));
    kill(sim, 'T1');
    // level corridor, the next point 20 m ahead on the same floor
    let h = place(sim, v3(20, 2.001, 0)) as RouteHint;
    expect(h.position.y).toBe(2);
    expect(h.kind).toBe('walk');
    // jump and fly 4.4 m above the floor, then along the corridor: no drop, no rise (before: 'drop', rise −4.4)
    glideTo(sim, v3(20, 6.4, 0), false, (x) => {
      expect(x.kind).toBe('walk');
      expect(Math.abs(x.rise)).toBeLessThan(0.01);
    });
    glideTo(sim, v3(30, 6.4, 0), false, (x) => {
      expect(x.position.y).toBe(2);
      expect(x.kind).toBe('walk');
      expect(Math.abs(x.rise)).toBeLessThan(0.01);
    });
    // landed again: the plain difference
    h = place(sim, v3(30, 2.001, 0)) as RouteHint;
    expect(h.kind).toBe('walk');
    // a real drop stays a drop while falling: off the ledge (10 m) towards the floor (2 m)
    h = place(sim, v3(104, 10.001, 0)) as RouteHint;
    expect(h.position.y).toBe(2);
    expect(h.kind).toBe('drop');
    expect(h.rise).toBeCloseTo(-8, 1);
    glideTo(sim, v3(111, 6.5, 0), false);
    h = getRouteHint(sim) as RouteHint;
    expect(h.position.y).toBe(2);
    expect(h.kind).toBe('drop');
    expect(h.rise).toBeCloseTo(-4.5, 1); // what is still to fall
    // overshooting a climb: above the landing height nothing is left to climb, and it is no drop either
    h = place(sim, v3(78, 2.001, 0)) as RouteHint;
    expect(h.kind).toBe('climb');
    glideTo(sim, v3(78, 13, 0), false);
    h = getRouteHint(sim) as RouteHint;
    expect(h.position).toEqual(v3(94, 10, 0));
    expect(h.kind).toBe('walk');
    expect(h.rise).toBe(0);
  });

  it('follows a real walk (real physics, real ticks) and is rebuilt by reset()', () => {
    const sim = new Sim(smallStage());
    const first = sim.guide;
    sim.input.moveZ = 1; // W, facing +X
    let prev = -1;
    for (let i = 0; i < 3 * 120; i++) {
      sim.tick();
      const h = getRouteHint(sim) as RouteHint;
      expect(h).not.toBeNull();
      expect(sim.guide.progress).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = sim.guide.progress;
    }
    expect(sim.player.pos.x).toBeGreaterThan(25);
    expect(sim.guide.progress).toBeCloseTo(sim.player.pos.x, 1);
    expect(sim.guide.offRoute).toBeLessThan(0.05);
    kill(sim, 'T1');
    sim.tick();
    expect(sim.guide.phase).toBe(2);
    sim.reset();
    expect(sim.guide).not.toBe(first);
    expect(sim.guide.phase).toBe(0);
    expect(sim.guide.progress).toBe(0);
    expect(sim.guide.enabled).toBe(true);
    const h = getRouteHint(sim) as RouteHint;
    expect(h.index).toBe(1);
    expect(h.distance).toBeCloseTo(40, 1);
    expect(describeGuide(sim)?.effective.vertices).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('can be switched off, and a stage without a route has no hint', () => {
    const sim = new Sim(smallStage());
    sim.guide.enabled = false;
    expect(getRouteHint(sim)).toBeNull();
    const before = sim.guide.progress;
    sim.input.moveZ = 1;
    sim.runFor(1);
    expect(sim.guide.progress).toBe(before);
    sim.guide.enabled = true;
    sim.tick();
    expect(getRouteHint(sim)).not.toBeNull();

    const bare = new Sim(makeTestStage({ floorSize: 200 }));
    expect(getRouteHint(bare)).toBeNull();
    expect(describeGuide(bare)).toBeNull();
    bare.input.moveZ = 1;
    bare.runFor(0.5);
    expect(getRouteHint(bare)).toBeNull();
    expect(createGuideState(bare).hasHint).toBe(false);
  });
});

// ───────────────────────────── part 2: the shipped stage ─────────────────────────────
describe('route guidance on the factory stage', () => {
  const stage = getFactoryStage();
  const route = stage.route;
  const cum = drawnCum(route);
  const total = cum[cum.length - 1];
  let an: StageAnalyzer;
  const originalTick = Sim.prototype.tick;
  let observer: ((sim: Sim) => void) | null = null;

  beforeAll(() => {
    an = new StageAnalyzer(stage, {});
    // observe every tick of the Sim that the walkthrough bot creates (the bot itself is not touched)
    Sim.prototype.tick = function (this: Sim): void {
      originalTick.call(this);
      if (observer) observer(this);
    };
  }, 600000);
  afterAll(() => {
    Sim.prototype.tick = originalTick;
  });

  /** Sector relation used for "plausible": same sector, connected by stage.connections, or consecutive on the route. */
  const related = new Set<string>();
  for (const c of stage.connections) {
    related.add(c.a + '>' + c.b);
    related.add(c.b + '>' + c.a);
  }
  for (let i = 1; i < route.length; i++) {
    related.add(route[i - 1].sectorId + '>' + route[i].sectorId);
    related.add(route[i].sectorId + '>' + route[i - 1].sectorId);
  }
  /** A player up to 2 m past the goal is not yet told to turn back (RouteHint.backtrack): the hint may be that far behind. */
  const PAST_GOAL = 2.05;
  const plausible = (from: string | null, to: string | null): boolean => from === null || to === null || from === to || related.has(from + '>' + to);

  it('finds the six firing positions in barrier order, before their barriers, with the turret in view', () => {
    const sim = new Sim(stage);
    const d = describeGuide(sim);
    expect(d).not.toBeNull();
    if (!d) return;
    expect(d.waypoints).toBe(route.length);
    expect(d.routeMeters).toBeCloseTo(total, 6);
    expect(d.gates.map((g) => g.barrierId)).toEqual([...stage.barriers.map((b) => b.id), stage.finalGate.id]);
    let prevCross = -1;
    for (let k = 0; k < stage.barriers.length; k++) {
      const g = d.gates[k];
      const b = stage.barriers[k];
      expect(g.controlEnemyId).toBe(b.controlEnemyId);
      expect(g.crossLeg).toBeGreaterThan(prevCross);
      expect(g.fireSeen).toBe(true);
      // after the previous barrier, before its own
      expect(g.fireMeters).toBeGreaterThan(prevCross < 0 ? 0 : cum[prevCross + 1]);
      expect(g.fireMeters).toBeLessThanOrEqual(cum[g.crossLeg]);
      // a standable point of the route from which the turret is in view and in range
      expect(sim.world.overlapsBox(g.firePosition, PLAYER.half)).toBe(false);
      expect(sim.world.probeGround(g.firePosition, PLAYER.half, 0.05)).toBeLessThanOrEqual(0.05);
      const e = sim.enemyById.get(b.controlEnemyId);
      expect(e).toBeDefined();
      if (e) {
        expect(sim.world.segmentBlocked(g.firePosition, e.pos)).toBe(false);
        expect(dist(g.firePosition, e.pos)).toBeLessThanOrEqual(110);
      }
      prevCross = g.crossLeg;
    }
    // out-and-back spurs (… A, B, A …), found here independently: on the shipped route the visit to the mill
    // control room (T04 / B2). Each belongs to the first barrier crossed after it.
    const same = (i: number, j: number): boolean => dist(route[i].position, route[j].position) < 0.05;
    const expectedSpurs: Array<{ from: number; apex: number; to: number; barrierId: string | null }> = [];
    for (let j = 1; j + 1 < route.length; j++) {
      if (!same(j - 1, j + 1)) continue;
      let m = 1;
      while (j - m - 1 >= 0 && j + m + 1 < route.length && same(j - m - 1, j + m + 1)) m++;
      const gate = d.gates.find((g) => g.crossLeg >= j + m);
      expectedSpurs.push({ from: j - m, apex: j, to: j + m, barrierId: gate ? gate.barrierId : null });
      j += m;
    }
    expect(d.spurs).toEqual(expectedSpurs);
    expect(d.spurs.length).toBeGreaterThanOrEqual(1);
    expect(d.spurs.some((sp) => route[sp.apex].sectorId === 'S05' && sp.barrierId === 'B2')).toBe(true);
    console.log('[guide] firing positions: ' + d.gates.filter((g) => g.controlEnemyId).map((g) => `${g.controlEnemyId}/${g.barrierId} ${fmt(g.firePosition)} @${g.fireMeters.toFixed(0)}m`).join(', '));
  });

  it('guides the complete real-Sim walkthrough (weakest and default loadout)', () => {
    const gates0 = describeGuide(new Sim(stage))?.gates ?? [];
    const spurs = describeGuide(new Sim(stage))?.spurs ?? [];
    const spurPoints = spurs.flatMap((s) => [route[s.from].position, route[s.apex].position]);
    /** Route metres of the out-and-back spurs between two route positions that are no longer walked (their barrier is open). */
    const cutBetween = (sim: Sim, from: number, to: number): number => {
      let cut = 0;
      for (const s of spurs) {
        if (s.barrierId !== null && !sim.objective.openBarrierIds.includes(s.barrierId)) continue;
        if (cum[s.from] >= from - 1e-6 && cum[s.to] <= to + 1e-6) cut += cum[s.to] - cum[s.from];
      }
      return cut;
    };
    const runs: Array<[string, Loadout]> = [
      ['weakest', WEAKEST_LOADOUT],
      ['default', DEFAULT_LOADOUT],
    ];
    for (const [name, loadout] of runs) {
      const problems: string[] = [];
      const note = (sim: Sim, what: string): void => {
        if (problems.length < 12) problems.push(`${what} at t = ${sim.time.toFixed(2)} s, player ${fmt(sim.player.pos)} in ${sim.currentSectorId}`);
      };
      let ticks = 0;
      let maxProgress = 0;
      let maxRegress = 0;
      let maxRegressAwayFromSpurs = 0;
      let maxOff = 0;
      let maxHintDistance = 0;
      let blockedTicks = 0;
      let climbTicks = 0;
      let dropTicks = 0;
      let lastHint: { index: number; position: V3; blocked: string | null } | null = null;
      let sawExitGoal = false;
      const seen = new Set<string>();
      const cost: number[] = [];
      observer = (sim: Sim): void => {
        if (sim.stage !== stage) return;
        ticks++;
        const h = getRouteHint(sim);
        const p = sim.player.pos;
        const g = sim.guide;
        if (h === null) {
          note(sim, 'no hint');
          return;
        }
        if (![h.distance, h.rise, h.remainingMeters, h.offRouteMeters, h.position.x, h.position.y, h.position.z, g.progress].every(Number.isFinite)) note(sim, 'non-finite hint');
        const hs = hintMeters(route, cum, h);
        // ahead of the player, never back along the route (the bot never passes a firing position)
        if (hs < g.progress - 0.5) note(sim, `hint behind the progress (${hs.toFixed(1)} < ${g.progress.toFixed(1)})`);
        if (h.backtrack) note(sim, 'backtrack');
        if (Math.abs(h.distance - dist(p, h.position)) > 1e-9) note(sim, 'stale distance');
        // the first closed barrier: the hint is on the player's side of it and at most at the firing position
        let closed = null as (typeof gates0)[number] | null;
        for (const gate of gates0) {
          const open = gate.barrierId === stage.finalGate.id ? sim.objective.gateOpen : sim.objective.openBarrierIds.includes(gate.barrierId);
          if (!open) {
            closed = gate;
            break;
          }
        }
        if (closed) {
          if (hs > cum[closed.crossLeg] + 1e-6) note(sim, `hint behind closed ${closed.barrierId}`);
          if (hs > closed.fireMeters + 1e-6) note(sim, `hint past the firing position of ${closed.barrierId}`);
          const box = closed.barrierId === stage.finalGate.id ? stage.finalGate.box : (stage.barriers.find((b) => b.id === closed?.barrierId)?.box as Box);
          if (segmentHitsBox(p, h.position, box)) note(sim, `the line to the hint passes through closed ${closed.barrierId}`);
          const alive = closed.controlEnemyId !== null && sim.enemyById.get(closed.controlEnemyId)?.alive === true;
          if (!alive) note(sim, `closed ${closed.barrierId} without a living control turret`);
          if (Math.abs(h.remainingMeters - (closed.fireMeters - g.progress - cutBetween(sim, g.progress, closed.fireMeters))) > 0.01) note(sim, 'remainingMeters is not the way to the firing position');
        } else {
          sawExitGoal = true;
          if (h.blockedByBarrierId !== null) note(sim, 'blocked although everything is open');
          if (Math.abs(h.remainingMeters - (total - g.progress - cutBetween(sim, g.progress, total))) > 0.01) note(sim, 'remainingMeters is not the way to the exit');
        }
        if (h.blockedByBarrierId !== null) {
          blockedTicks++;
          if (!closed || h.blockedByBarrierId !== closed.barrierId || h.controlEnemyId !== closed.controlEnemyId) note(sim, 'blocked by the wrong barrier');
          else if (dist(h.position, closed.firePosition) > 1e-6) note(sim, 'blocked hint is not the firing position');
        } else if (h.controlVisible || h.controlEnemyId !== null) note(sim, 'control fields without a blocking barrier');
        // a standable point of the route
        const key = `${h.index}|${h.position.x.toFixed(3)}|${h.position.y.toFixed(3)}|${h.position.z.toFixed(3)}`;
        if (!seen.has(key)) {
          seen.add(key);
          if (hintOffRoute(route, h) > 1e-6) note(sim, `hint ${fmt(h.position)} is not on the route`);
          if (sim.world.overlapsBox(h.position, PLAYER.half)) note(sim, `hint ${fmt(h.position)} is inside a solid`);
          if (!(sim.world.probeGround(h.position, PLAYER.half, 0.05) <= 0.05)) note(sim, `hint ${fmt(h.position)} does not rest on a floor`);
        }
        if (h.kind === 'climb') climbTicks++;
        if (h.kind === 'drop') dropTicks++;
        if (h.kind !== (h.rise > 1 ? 'climb' : h.rise < -3 ? 'drop' : 'walk')) note(sim, 'kind does not match rise');
        // progress
        const regress = maxProgress - g.progress;
        if (regress > maxRegress) maxRegress = regress;
        if (regress > maxRegressAwayFromSpurs && spurPoints.every((s) => dist(s, p) > 30)) maxRegressAwayFromSpurs = regress;
        if (g.progress > maxProgress) maxProgress = g.progress;
        if (g.offRoute > maxOff) maxOff = g.offRoute;
        if (h.distance > maxHintDistance) maxHintDistance = h.distance;
        lastHint = { index: h.index, position: { ...h.position }, blocked: h.blockedByBarrierId };
        // cost of one more update in the same state
        const t0 = performance.now();
        updateGuide(sim);
        cost.push(performance.now() - t0);
      };
      const r = runWalkthrough(an, loadout);
      observer = null;
      expect(r.reason).toBe('cleared');
      expect(r.controls.map((c) => c.id)).toEqual(stage.barriers.map((b) => b.controlEnemyId));
      expect(problems).toEqual([]);
      expect(ticks).toBeGreaterThan(20000);
      expect(sawExitGoal).toBe(true);
      // the last hint before the exit zone was entered: the last waypoint, inside the exit zone
      const last = lastHint as { index: number; position: V3; blocked: string | null } | null;
      expect(last).not.toBeNull();
      if (last) {
        expect(last.index).toBe(route.length - 1);
        expect(last.blocked).toBeNull();
        const z = stage.exitZone;
        expect(last.position.x > z.min.x && last.position.x < z.max.x && last.position.y > z.min.y && last.position.y < z.max.y && last.position.z > z.min.z && last.position.z < z.max.z).toBe(true);
      }
      // progress: monotone, except around the control-room spur (the bot still walks in and out of the room)
      // and for the couple of metres the bot walks back after landing beyond a waypoint (measured: 1.9 m on
      // the +30 m scaffold of the exhaust shaft)
      expect(maxRegressAwayFromSpurs).toBeLessThan(3);
      expect(maxRegress).toBeLessThan(6);
      expect(maxProgress).toBeGreaterThan(total - 60);
      // every climb and every drop of the route was announced
      expect(climbTicks).toBeGreaterThan(8 * 60);
      expect(dropTicks).toBeGreaterThan(8 * 20);
      expect(blockedTicks).toBeGreaterThan(6 * 30);
      cost.sort((a, b) => a - b);
      const mean = cost.reduce((a, b) => a + b, 0) / cost.length;
      const q = (f: number): number => cost[Math.min(cost.length - 1, Math.floor(f * cost.length))];
      console.log(
        `[guide] walkthrough ${name}: ${ticks} ticks (${(ticks * TICK).toFixed(0)} s), ${seen.size} distinct hints, max hint distance ${maxHintDistance.toFixed(1)} m, ` +
          `max off-route ${maxOff.toFixed(1)} m, max progress regress ${maxRegress.toFixed(2)} m (away from the spur ${maxRegressAwayFromSpurs.toFixed(2)} m), ` +
          `updateGuide mean ${(mean * 1000).toFixed(2)} µs, p50 ${(q(0.5) * 1000).toFixed(2)}, p99 ${(q(0.99) * 1000).toFixed(1)}, p99.9 ${(q(0.999) * 1000).toFixed(0)}, max ${(q(1) * 1000).toFixed(0)} µs`,
      );
      // generous bounds (shared, loaded machine): one tick is 8333 µs
      expect(mean).toBeLessThan(0.1);
      expect(q(0.99)).toBeLessThan(1);
    }
  }, 1800000);

  it('gives a sane hint from positions all over the stage in every objective state', () => {
    const sim = new Sim(stage);
    const d = describeGuide(sim);
    expect(d).not.toBeNull();
    if (!d) return;
    const world = sim.world;
    // the first objective state (number of open barriers) in which each sector can be entered
    const minPhase: Record<string, number> = {};
    route.forEach((w, i) => {
      if (!(w.sectorId in minPhase)) minPhase[w.sectorId] = Math.min(stage.barriers.length, d.gates.filter((g) => g.crossLeg < i).length);
    });
    for (const sec of stage.sectors) {
      if (sec.id in minPhase) continue;
      // optional sectors: as early as the earliest sector they are connected to
      const linked = stage.connections.filter((c) => c.a === sec.id || c.b === sec.id).map((c) => (c.a === sec.id ? c.b : c.a));
      minPhase[sec.id] = Math.min(...linked.map((id) => minPhase[id] ?? stage.barriers.length));
    }
    expect(Object.keys(minPhase).length).toBe(stage.sectors.length);
    // standing places on every floor of every sector (9 m grid) and a point 5 m above each
    const samples: Array<{ p: V3; sector: string; air: boolean }> = [];
    for (const sec of stage.sectors) {
      for (const b of sec.bounds) {
        for (let x = b.min.x + 2.5; x < b.max.x - 2; x += 9) {
          for (let z = b.min.z + 2.5; z < b.max.z - 2; z += 9) {
            let y = b.max.y - 0.05;
            for (let it = 0; it < 12 && y > b.min.y; it++) {
              const hit = world.raycast({ x, y, z }, { x: 0, y: -1, z: 0 }, y - b.min.y + 0.1);
              if (!hit) break;
              const top = hit.point.y;
              const c = { x, y: top + PLAYER.half.y + 0.001, z };
              if (hit.dist > 0.01 && top > stage.killY + 5 && world.sectorAt(c) === sec.id && !world.overlapsBox(c, PLAYER.half)) {
                samples.push({ p: c, sector: sec.id, air: false });
                const a = { x, y: c.y + 5, z };
                if (!world.overlapsBox(a, PLAYER.half) && world.sectorAt(a) === sec.id) samples.push({ p: a, sector: sec.id, air: true });
              }
              y = Math.min(top, hit.box.min.y) - 0.02;
            }
          }
        }
      }
    }
    const sectorsSampled = new Set(samples.map((s) => s.sector));
    expect(sectorsSampled.size).toBe(stage.sectors.length);
    expect(samples.length).toBeGreaterThan(2000);
    const levels = new Set(samples.map((s) => Math.round(s.p.y / 4)));
    expect(levels.size).toBeGreaterThan(8);

    const problems: string[] = [];
    let checked = 0;
    let direct = 0;
    let worst = 0;
    let worstAt = '';
    let blocked = 0;
    let backtrack = 0;
    const perSector: Record<string, { n: number; direct: number; max: number }> = {};
    for (let phase = 0; phase <= stage.barriers.length; phase++) {
      sim.reset();
      for (let k = 0; k < phase; k++) kill(sim, stage.barriers[k].controlEnemyId);
      const closed = phase < stage.barriers.length ? d.gates[phase] : null;
      for (const s of samples) {
        if (minPhase[s.sector] > phase) continue; // behind a closed barrier in this state
        const h = place(sim, s.p, !s.air);
        checked++;
        const where = `phase ${phase} ${s.sector} ${fmt(s.p)}${s.air ? ' (air)' : ''}`;
        if (h === null) {
          problems.push('no hint: ' + where);
          continue;
        }
        if (![h.distance, h.rise, h.remainingMeters, h.offRouteMeters, h.position.x, h.position.y, h.position.z, sim.guide.progress].every(Number.isFinite)) problems.push('non-finite: ' + where);
        const hs = hintMeters(route, cum, h);
        if (closed && hs > cum[closed.crossLeg] + 1e-6) problems.push(`hint behind closed ${closed.barrierId}: ${where}`);
        if (closed && sim.guide.progress > cum[closed.crossLeg + 1] + 1e-6) problems.push(`progress behind closed ${closed.barrierId}: ${where}`);
        if (hintOffRoute(route, h) > 1e-6) problems.push(`hint off the route: ${where}`);
        if (h.blockedByBarrierId !== null) {
          blocked++;
          if (!closed || h.blockedByBarrierId !== closed.barrierId || dist(h.position, closed.firePosition) > 1e-6) problems.push(`wrong blocking barrier: ${where}`);
        }
        if (h.backtrack) {
          backtrack++;
          if (!closed) problems.push(`backtrack with everything open: ${where}`);
          else if (hs < closed.fireMeters - 1e-6) problems.push(`backtrack hint before the firing position: ${where}`);
        } else if (hs < sim.guide.progress - PAST_GOAL) problems.push(`hint behind the progress: ${where}`);
        const hintSector = world.sectorAt(h.position);
        if (!plausible(s.sector, hintSector)) problems.push(`hint in ${hintSector}: ${where}`);
        if (h.distance > 150) problems.push(`hint ${h.distance.toFixed(0)} m away: ${where}`);
        const rec = (perSector[s.sector] ??= { n: 0, direct: 0, max: 0 });
        rec.n++;
        if (!world.segmentBlocked(s.p, h.position)) {
          direct++;
          rec.direct++;
        }
        if (h.distance > rec.max) rec.max = h.distance;
        if (h.distance > worst) {
          worst = h.distance;
          worstAt = where + ' → ' + fmt(h.position);
        }
      }
    }
    expect(problems.slice(0, 10)).toEqual([]);
    expect(checked).toBeGreaterThan(8000);
    expect(blocked).toBeGreaterThan(0);
    expect(backtrack).toBeGreaterThan(0);
    console.log(
      `[guide] samples: ${samples.length} places (${sectorsSampled.size} sectors, ${levels.size} height bands) × objective states = ${checked} hints; ` +
        `${((100 * direct) / checked).toFixed(0)} % in plain view; ${blocked} at a firing position, ${backtrack} leading back; farthest ${worst.toFixed(0)} m (${worstAt})`,
    );
    console.log(
      '[guide] per sector (in view %, farthest m): ' +
        Object.entries(perSector)
          .sort()
          .map(([id, r]) => `${id} ${((100 * r.direct) / r.n).toFixed(0)}%/${r.max.toFixed(0)}`)
          .join(' '),
    );
  }, 600000);

  it('stays sane on the detour side of every branch (galleries S18 / S19, lower storey of S08, side tunnel of S13)', () => {
    const sim = new Sim(stage);
    const d = describeGuide(sim);
    expect(d).not.toBeNull();
    if (!d) return;
    const world = sim.world;
    const detour = getFactoryDetourRoute();
    // the detour as drawn, in 0.5 m steps (harness: the player is slid along it; turrets die once in view)
    const steps: Array<{ p: V3; air: boolean }> = [];
    const add = (a: V3, b: V3, air: boolean): void => {
      const n = Math.max(1, Math.ceil(dist(a, b) / 0.5));
      for (let i = 1; i <= n; i++) steps.push({ p: { x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n, z: a.z + ((b.z - a.z) * i) / n }, air });
    };
    for (let i = 0; i + 1 < detour.length; i++) {
      const a = detour[i].position;
      const b = detour[i + 1].position;
      const dy = b.y - a.y;
      if (Math.abs(dy) <= 0.5) add(a, b, false);
      else if (dy > 0) {
        const c = { x: a.x, y: b.y, z: a.z };
        add(a, c, true);
        add(c, b, true);
      } else {
        const c = { x: b.x, y: a.y, z: b.z };
        add(a, c, false);
        add(c, b, true);
      }
      steps[steps.length - 1].air = false; // standing on the waypoint
    }
    const visited = new Set<string>();
    const problems: string[] = [];
    let maxOff = 0;
    let offRouteSteps = 0;
    place(sim, detour[0].position);
    for (const s of steps) {
      sim.player.pos.x = s.p.x;
      sim.player.pos.y = s.p.y;
      sim.player.pos.z = s.p.z;
      sim.player.grounded = !s.air;
      const sector = world.sectorAt(s.p);
      if (sector) {
        sim.currentSectorId = sector;
        visited.add(sector);
      }
      const next = stage.barriers.find((b) => sim.enemyById.get(b.controlEnemyId)?.alive);
      const turret = next ? sim.enemyById.get(next.controlEnemyId) : undefined;
      if (turret && !s.air && dist(turret.pos, s.p) <= 110 && !world.segmentBlocked(s.p, turret.pos)) kill(sim, turret.id);
      for (let k = 0; k < 6; k++) updateGuide(sim);
      const h = getRouteHint(sim);
      const where = `${sim.currentSectorId} ${fmt(s.p)}`;
      if (h === null) {
        problems.push('no hint: ' + where);
        continue;
      }
      const hs = hintMeters(route, cum, h);
      const closed = d.gates.find((g) => (g.barrierId === stage.finalGate.id ? !sim.objective.gateOpen : !sim.objective.openBarrierIds.includes(g.barrierId)));
      if (closed && hs > cum[closed.crossLeg] + 1e-6) problems.push(`hint behind closed ${closed.barrierId}: ${where}`);
      if (!h.backtrack && hs < sim.guide.progress - PAST_GOAL) problems.push(`hint behind the progress: ${where}`);
      if (!plausible(sim.currentSectorId, world.sectorAt(h.position))) problems.push(`hint in ${world.sectorAt(h.position)}: ${where}`);
      if (h.distance > 150) problems.push(`hint ${h.distance.toFixed(0)} m away: ${where}`);
      if (sim.guide.offRoute > maxOff) maxOff = sim.guide.offRoute;
      if (sim.guide.offRoute > 12) offRouteSteps++;
    }
    expect(problems.slice(0, 10)).toEqual([]);
    for (const id of ['S18', 'S19', 'S08', 'S13']) expect(visited.has(id)).toBe(true);
    expect(visited.size).toBe(stage.sectors.length);
    // all six turrets were found on the way and the hint ends on the last waypoint
    expect(sim.objective.controlsDestroyed).toBe(stage.barriers.length);
    expect((getRouteHint(sim) as RouteHint).index).toBe(route.length - 1);
    expect(sim.guide.progress).toBeGreaterThan(total - 5);
    expect(offRouteSteps).toBeGreaterThan(500);
    console.log(`[guide] detour route: ${steps.length} steps, ${offRouteSteps} of them more than 12 m off the recommended route (farthest ${maxOff.toFixed(0)} m), ${visited.size} sectors`);
  }, 600000);

  it('has no influence on gameplay: a sortie with guidance off is bit-identical', () => {
    const script = (sim: Sim, i: number, rnd: () => number): void => {
      // deterministic "player": runs down the start lane, turns, jumps, flies, boosts and fires
      const inp = sim.input;
      if (i % 30 === 0) {
        inp.moveZ = rnd() < 0.8 ? 1 : rnd() < 0.5 ? -1 : 0;
        inp.moveX = rnd() < 0.3 ? (rnd() < 0.5 ? -1 : 1) : 0;
        inp.fire = rnd() < 0.5;
        inp.brake = rnd() < 0.05;
        inp.jump = rnd() < 0.3;
        if (inp.jump) inp.jumpPressed = true;
      }
      if (i % 90 === 45) inp.qbPressed = true;
      if (i % 200 === 100) inp.glideTogglePressed = true;
      if (i % 240 === 0) inp.weaponSelect = (['machinegun', 'beam', 'missile'] as const)[Math.floor(rnd() * 3)];
      sim.applyLook((rnd() - 0.5) * 0.02 + (i > 900 && i < 1100 ? -0.008 : 0), (rnd() - 0.5) * 0.005);
    };
    // the second route waypoint inside the sector of the first control turret (the material yard)
    const firstControl = stage.enemies.find((e) => e.id === stage.barriers[0].controlEnemyId);
    const yardIndex = route.findIndex((w) => w.sectorId === firstControl?.sectorId) + 1;
    expect(yardIndex).toBeGreaterThan(1);
    const yardEntrance = route[yardIndex].position;
    const run = (guided: boolean): { prints: string[]; sim: Sim; damage: number; enemyShots: number } => {
      const sim = new Sim(stage, { seed: 4242 });
      sim.guide.enabled = guided;
      // harness: the sortie starts at the entrance of the material yard, in view of its guards and turrets, so
      // that the enemy AI, its random numbers and the projectiles are part of what is compared
      const startAt = yardEntrance;
      sim.player.pos.x = startAt.x;
      sim.player.pos.y = startAt.y + 0.001;
      sim.player.pos.z = startAt.z;
      sim.player.yaw = -Math.PI / 2;
      let seed = 0x1234567;
      const rnd = (): number => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 4294967296;
      };
      const prints: string[] = [];
      for (let i = 0; i < 2400 && sim.status === 'playing'; i++) {
        script(sim, i, rnd);
        if (i === 700) kill(sim, 'T01'); // the objective changes: the guided run rebuilds its polyline
        sim.tick();
        if (i % 40 === 39) {
          prints.push(
            JSON.stringify(buildSnapshot(sim, 'playing')) +
              JSON.stringify(sim.projectiles.map((q) => [q.id, q.kind, q.pos.x, q.pos.y, q.pos.z, q.vel.x, q.vel.y, q.vel.z])) +
              JSON.stringify([sim.player.yaw, sim.player.pitch, sim.player.muzzle, sim.lock, sim.events.length, sim.nextProjectileId, sim.nextShotId]),
          );
        }
      }
      const damage = PLAYER.maxHp - sim.player.hp;
      const enemyShots = sim.enemies.reduce((a, e) => a + e.shotsFired, 0);
      prints.push(String(sim.rng.next()) + '|' + JSON.stringify(sim.drainEvents().map((e) => e.type)));
      return { prints, sim, damage, enemyShots };
    };
    const on = run(true);
    const off = run(false);
    expect(on.prints.length).toBeGreaterThan(20);
    expect(on.prints).toEqual(off.prints);
    // the guided run really did its work, the other one did nothing
    expect(on.sim.guide.ticks).toBeGreaterThan(1000);
    expect(on.sim.guide.phase).toBe(1);
    expect(getRouteHint(on.sim)).not.toBeNull();
    expect(off.sim.guide.ticks).toBeLessThanOrEqual(1);
    expect(getRouteHint(off.sim)).toBeNull();
    // the sortie was not trivial: the player moved and fired, the enemies fired back (random aim jitter) and hit
    expect(dist(on.sim.player.pos, yardEntrance)).toBeGreaterThan(5);
    expect(on.sim.shots.length).toBeGreaterThan(0);
    expect(on.enemyShots).toBeGreaterThan(10);
    expect(on.damage).toBeGreaterThan(0);
    console.log(`[guide] identical with guidance on / off: ${on.prints.length} fingerprints over ${on.sim.tickIndex} ticks, ${on.enemyShots} enemy shots, ${on.damage} damage taken, final status ${on.sim.status}`);
  }, 600000);

  it('reset() starts the guidance again and updates do not allocate', async () => {
    const sim = new Sim(stage);
    const g0 = sim.guide;
    for (const b of stage.barriers.slice(0, 3)) kill(sim, b.controlEnemyId);
    // somewhere behind the third barrier
    const behindThird = (describeGuide(sim)?.gates[2].crossLeg ?? 0) + 2;
    place(sim, route[behindThird].position);
    expect(sim.guide.phase).toBe(3);
    expect(sim.guide.progress).toBeGreaterThan(cum[behindThird] - 1);
    expect(sim.guide.progress).toBeGreaterThan(500);
    sim.reset();
    expect(sim.guide).not.toBe(g0);
    expect(sim.guide.phase).toBe(0);
    expect(sim.guide.progress).toBeLessThan(0.01);
    const h = getRouteHint(sim) as RouteHint;
    expect(h).not.toBeNull();
    expect(h.index).toBe(1);
    expect(h.blockedByBarrierId).toBeNull();
    expect(h.nextSectorId).toBe('S02');
    expect(h.remainingMeters).toBeCloseTo(describeGuide(sim)?.gates[0].fireMeters ?? -1, 6);
    // The same object is updated in place, and updates do not allocate: the player is moved up and down the
    // start lane (numbers only). V8 counts every byte ever allocated on the JS heap; unoptimised code boxes
    // intermediate numbers, so rounds of 100000 updates are measured and the best one counts. Reading the
    // counter costs a few bytes per call; code that really allocates cannot get below 16 bytes per call.
    const position = h.position;
    const moduleName = 'node:v8';
    let stats: (() => Record<string, number>) | null = null;
    try {
      const v8 = (await import(/* @vite-ignore */ moduleName)) as { getHeapStatistics?: () => Record<string, number> };
      if (v8.getHeapStatistics && typeof v8.getHeapStatistics().total_allocated_bytes === 'number') stats = v8.getHeapStatistics;
    } catch {
      stats = null;
    }
    const p = sim.player.pos;
    const CALLS = 100000;
    let dir = -1;
    let best = Infinity;
    let hintEvals = 0;
    for (let round = 0; round < 10 && best >= 4; round++) {
      const before = stats ? stats().total_allocated_bytes : 0;
      const ticks0 = sim.guide.lastHintTick;
      for (let i = 0; i < CALLS; i++) {
        p.z += dir * 0.09;
        if (p.z < 30) dir = 1;
        else if (p.z > 88) dir = -1;
        updateGuide(sim);
      }
      const perCall = stats ? (stats().total_allocated_bytes - before) / CALLS : NaN;
      if (perCall < best) best = perCall;
      hintEvals += Math.round((sim.guide.lastHintTick - ticks0) / 12);
      if (!stats) break;
    }
    expect(getRouteHint(sim)).toBe(h);
    expect((getRouteHint(sim) as RouteHint).position).toBe(position);
    expect(hintEvals).toBeGreaterThan(5000);
    console.log(`[guide] allocations: ${stats ? best.toFixed(2) + ' bytes per updateGuide call (best round of ' + CALLS + ', measurement floor included)' : 'not measured (no V8 heap statistics)'}`);
    if (stats) expect(best).toBeLessThan(8);
  }, 600000);
});
