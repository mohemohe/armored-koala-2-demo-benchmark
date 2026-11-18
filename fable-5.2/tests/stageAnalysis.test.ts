/**
 * Unit tests of the stage analysis primitives (tools/stageAnalysis.ts) on small synthetic stages whose
 * properties are known by construction. The real stage is validated in tests/stage.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { ENEMIES } from '../src/config';
import type { V3 } from '../src/core/vec';
import type { Box, EnemyDef, SectorDef, SolidDef, StageDef } from '../src/sim/types';
import { World } from '../src/sim/world';
import {
  CHAMFER_RATIO,
  HX,
  HY,
  HZ,
  StageAnalyzer,
  VoxelGrid,
  analyzeStage,
  cubeCovered,
  formatReport,
  MOVEMENT_LOADOUTS,
  WEAKEST_LOADOUT,
  estimateClimbEn,
  flyClimb,
  playerMovementImplemented,
  playerMovementStatus,
  runWalkthrough,
  simulateFlightSpot,
  type FlightDriver,
} from '../tools/stageAnalysis';

// ───────────────────────────── helpers ─────────────────────────────
const bx = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Box => ({ min: { x: x0, y: y0, z: z0 }, max: { x: x1, y: y1, z: z1 } });
const pt = (x: number, y: number, z: number): V3 => ({ x, y, z });
const solid = (b: Box, material: SolidDef['material'] = 'concrete'): SolidDef => ({ ...b, material });

/** a minus h as disjoint axis-aligned pieces. */
function subtract(a: Box, h: Box): Box[] {
  if (h.min.x >= a.max.x || h.max.x <= a.min.x || h.min.y >= a.max.y || h.max.y <= a.min.y || h.min.z >= a.max.z || h.max.z <= a.min.z) return [a];
  const out: Box[] = [];
  const cur = { min: { ...a.min }, max: { ...a.max } };
  for (const ax of ['x', 'y', 'z'] as const) {
    if (h.min[ax] > cur.min[ax]) {
      const p = { min: { ...cur.min }, max: { ...cur.max } };
      p.max[ax] = h.min[ax];
      out.push(p);
      cur.min[ax] = h.min[ax];
    }
    if (h.max[ax] < cur.max[ax]) {
      const p = { min: { ...cur.min }, max: { ...cur.max } };
      p.min[ax] = h.max[ax];
      out.push(p);
      cur.max[ax] = h.max[ax];
    }
  }
  return out;
}

/** Watertight building: one solid block (rooms' bounding box + `wall` m) with the rooms carved out. */
function carve(rooms: Box[], wall = 2, holes: Box[] = []): SolidDef[] {
  const block = bx(
    Math.min(...rooms.map((r) => r.min.x)) - wall,
    Math.min(...rooms.map((r) => r.min.y)) - wall,
    Math.min(...rooms.map((r) => r.min.z)) - wall,
    Math.max(...rooms.map((r) => r.max.x)) + wall,
    Math.max(...rooms.map((r) => r.max.y)) + wall,
    Math.max(...rooms.map((r) => r.max.z)) + wall,
  );
  let pieces: Box[] = [block];
  for (const r of [...rooms, ...holes]) pieces = pieces.flatMap((p) => subtract(p, r));
  return pieces.map((p) => solid(p, 'wall'));
}

const sector = (id: string, kind: SectorDef['kind'], bounds: Box, combatArena = false): SectorDef => ({ id, name: id, nameEn: id, kind, bounds: [bounds], combatArena });
const turret = (id: string, sectorId: string, x: number, floorY: number, z: number, barrierId?: string): EnemyDef => ({
  id,
  kind: 'turret',
  sectorId,
  position: pt(x, floorY + ENEMIES.turret.centerHeight, z),
  isGateControl: !!barrierId,
  barrierId,
});

function makeStage(solids: SolidDef[], o: Partial<StageDef> & { start: V3; yaw?: number; exit: Box }): StageDef {
  let lo = pt(Infinity, Infinity, Infinity);
  let hi = pt(-Infinity, -Infinity, -Infinity);
  for (const s of solids) {
    lo = pt(Math.min(lo.x, s.min.x), Math.min(lo.y, s.min.y), Math.min(lo.z, s.min.z));
    hi = pt(Math.max(hi.x, s.max.x), Math.max(hi.y, s.max.y), Math.max(hi.z, s.max.z));
  }
  const bounds = bx(lo.x - 4, lo.y - 4, lo.z - 4, hi.x + 4, hi.y + 4, hi.z + 4);
  return {
    id: 'synthetic',
    name: 'synthetic',
    bounds,
    killY: bounds.min.y - 10,
    sectors: [],
    solids,
    decor: [],
    barriers: [],
    finalGate: { id: 'GATE', name: 'gate', box: bx(lo.x - 3, lo.y - 3, lo.z - 3, lo.x - 2.5, lo.y - 2.5, lo.z - 2.5) },
    exitZone: o.exit,
    playerStart: { position: o.start, yaw: o.yaw ?? 0 },
    enemies: [],
    connections: [],
    route: [],
    flightSpots: [],
    branches: [],
    loops: [],
    ...o,
  } as StageDef;
}

const quiet = { flightSim: false } as const;

/**
 * Reference model of the documented player physics (SPEC §7.4 / ARCHITECTURE §4, weakest loadout): jump 10 m/s,
 * gravity 18 m/s², flight = Space held >= 0.20 s while airborne → climb 8 m/s at 20 EN/s, air speed 12.8 m/s,
 * walk accel 96 m/s², swept collisions through the real World. Only used to exercise the flight controller
 * while src/sim/player.ts is not available; it is NOT the game's simulation.
 */
class RefPlayer implements FlightDriver {
  pos: V3;
  vel = pt(0, 0, 0);
  grounded = true;
  en = 90;
  yaw = 0;
  time = 0;
  ended: string | null = null;
  private moveZ = 0;
  private held = false;
  private pressed = false;
  private heldSince: number | null = null;
  private readonly half = { x: HX, y: HY, z: HZ };
  constructor(private readonly world: World, start: V3) {
    this.pos = pt(start.x, start.y + 1e-3, start.z);
  }
  setInput(moveZ: number, held: boolean, pressed: boolean): void {
    this.moveZ = moveZ;
    this.held = held;
    this.pressed = pressed;
  }
  look(d: number): void {
    this.yaw += d;
  }
  tick(): void {
    const h = 1 / 120;
    if (this.pressed) {
      if (this.grounded) {
        this.vel.y = 10;
        this.grounded = false;
      }
      this.heldSince = this.time;
    }
    this.pressed = false;
    if (!this.held) this.heldSince = null;
    const sp = (this.grounded ? 8 : 12.8) * this.moveZ;
    let dvx = -Math.sin(this.yaw) * sp - this.vel.x;
    let dvz = -Math.cos(this.yaw) * sp - this.vel.z;
    const dv = Math.hypot(dvx, dvz);
    if (dv > 96 * h) {
      dvx *= (96 * h) / dv;
      dvz *= (96 * h) / dv;
    }
    this.vel.x += dvx;
    this.vel.z += dvz;
    let dy = 0;
    if (!this.grounded) {
      if (this.heldSince !== null && this.time - this.heldSince >= 0.2 - 1e-9 && this.en > 0) {
        this.vel.y = 8;
        this.en = Math.max(0, this.en - 20 * h);
        dy = 8 * h;
      } else {
        dy = this.vel.y * h - 9 * h * h;
        this.vel.y -= 18 * h;
      }
    }
    const res = this.world.moveBox(this.pos, this.half, pt(this.vel.x * h, dy, this.vel.z * h));
    if (res.nx) this.vel.x = 0;
    if (res.nz) this.vel.z = 0;
    if (res.ny > 0) {
      this.grounded = true;
      this.vel.y = 0;
    } else if (res.ny < 0 && this.vel.y > 0) {
      this.vel.y = 0;
    } else if (this.grounded && !(this.world.probeGround(this.pos, this.half, 0.05) <= 0.01)) {
      this.grounded = false;
    }
    this.time += h;
    if (this.pos.y < -200) this.ended = 'fell';
  }
}

// ───────────────────────────── voxel model ─────────────────────────────
describe('voxel model', () => {
  it('derives the 26-neighbour / Euclidean worst-case ratio', () => {
    expect(CHAMFER_RATIO).toBeCloseTo(1.12806, 4);
    // numeric check of the closed form: max over directions of a + (√2-1) b + (√3-√2) c
    let worst = 0;
    for (let i = 0; i <= 200; i++) for (let j = 0; j <= i; j++) {
      const a = 1;
      const b = i / 200;
      const c = j / 200;
      worst = Math.max(worst, (a + (Math.SQRT2 - 1) * b + (Math.sqrt(3) - Math.SQRT2) * c) / Math.hypot(a, b, c));
    }
    expect(worst).toBeLessThanOrEqual(CHAMFER_RATIO + 1e-9);
    expect(worst).toBeGreaterThan(CHAMFER_RATIO - 1e-3);
  });

  it('cubeCovered is exact for unions of boxes', () => {
    const two = Float64Array.from([-5, -5, -5, 0.6, 5, 5, 0.4, -5, -5, 5, 5, 5]);
    expect(cubeCovered(0, 1, 0, 1, 0, 1, two, 2)).toBe(true); // covered by the union only
    const gap = Float64Array.from([-5, -5, -5, 0.4, 5, 5, 0.6, -5, -5, 5, 5, 5]);
    expect(cubeCovered(0, 1, 0, 1, 0, 1, gap, 2)).toBe(false); // sliver 0.4..0.6 is free
    const corner = Float64Array.from([-5, -5, -5, 0.9, 5, 0.9, -5, -5, -5, 5, 0.5, 5]);
    expect(cubeCovered(0, 1, 0, 1, 0, 1, corner, 2)).toBe(false); // the far corner stays free
    expect(cubeCovered(0, 1, 0, 0.5, 0, 1, corner, 2)).toBe(false); // touching the open top face is not covered
    expect(cubeCovered(0, 1, 0, 0.4, 0, 1, corner, 2)).toBe(true);
  });

  it('STRICT cells agree with World.overlapsBox and LOOSE cells contain them', () => {
    const solids = [
      ...carve([bx(0, 0, 0, 40, 12, 30)]),
      solid(bx(7.3, 0, 4.1, 12.9, 3.7, 9.6)),
      solid(bx(20, 0, 10, 23.5, 6.25, 22)),
      solid(bx(28.2, 5.1, 3, 36, 5.9, 27.4)),
      solid(bx(15, 8.4, 0, 16, 12, 30)),
    ];
    const stage = makeStage(solids, { start: pt(3, 2, 3), exit: bx(36, 0, 26, 40, 6, 30) });
    const world = new World(stage);
    world.setBarrierOpen('GATE', true); // the base masks hold the permanent solids only
    const g = new VoxelGrid(stage);
    const half = { x: HX, y: HY, z: HZ };
    let free = 0;
    for (let c = 0; c < g.n; c++) {
      if (g.baseS[c] === 2) continue;
      const hit = world.overlapsBox(g.center(c), half);
      expect(g.baseS[c] === 0, `cell ${JSON.stringify(g.center(c))}`).toBe(!hit);
      if (g.baseS[c] === 0) {
        free++;
        expect(g.baseL[c]).toBe(0);
      }
    }
    expect(free).toBeGreaterThan(5000);
    // every LOOSE-free cell really contains a legal player position (probe a fine lattice of the cube)
    let checked = 0;
    for (let c = 0; c < g.n; c += 7) {
      if (g.baseL[c] !== 0 || g.baseS[c] === 0) continue;
      const p = g.center(c);
      let found = false;
      for (let i = 0; i <= 10 && !found; i++) for (let j = 0; j <= 10 && !found; j++) for (let k = 0; k <= 10 && !found; k++) {
        if (!world.overlapsBox(pt(p.x - 0.5 + i / 10, p.y - 0.25 + j / 20, p.z - 0.5 + k / 10), half)) found = true;
      }
      expect(found, `loose cell ${JSON.stringify(p)}`).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(50);
    // …and conversely every legal player position lies in a LOOSE-free cell (the superset property)
    let seed = 12345;
    const rnd = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    let legal = 0;
    for (let i = 0; i < 40000; i++) {
      const p = pt(-1 + rnd() * 42, -1 + rnd() * 14, -1 + rnd() * 32);
      if (world.overlapsBox(p, half)) continue;
      legal++;
      expect(g.baseL[g.cellOf(p)], `position ${JSON.stringify(p)}`).toBe(0);
    }
    expect(legal).toBeGreaterThan(5000);
  });

  it('LOOSE cells keep a passage that is too narrow to contain a cell centre, and close a slit the box cannot pass', () => {
    // two halls joined by a doorway; width 3.1 m placed off-grid → centre positions only in z ∈ [11.55, 12.05]
    const build = (z0: number, z1: number): StageAnalyzer => {
      const solids = carve([bx(0, 0, 0, 20, 8, 24), bx(22, 0, 0, 42, 8, 24), bx(20, 0, z0, 22, 8, z1)]);
      return new StageAnalyzer(makeStage(solids, { start: pt(5, 2, 12), exit: bx(36, 0, 0, 42, 8, 24) }), quiet);
    };
    const narrow = build(10.25, 13.35);
    expect(narrow.exitCellsS.some((c) => narrow.RS[c] !== 0)).toBe(false); // the strict grid misses the door
    expect(narrow.exitCellsL.some((c) => narrow.RL[c] !== 0)).toBe(true); // the loose grid does not
    const slit = build(11, 13.4); // 2.4 m < 2.6 m: nobody passes
    expect(slit.exitCellsL.some((c) => slit.RL[c] !== 0)).toBe(false);
    const wide = build(8, 16);
    expect(wide.exitCellsS.some((c) => wide.RS[c] !== 0)).toBe(true);
  });
});

// ───────────────────────────── V13 enclosure ─────────────────────────────
describe('enclosure (V13)', () => {
  it('accepts a closed hall and detects a hole in a wall', () => {
    const closed = makeStage(carve([bx(0, 0, 0, 40, 10, 30)]), { start: pt(5, 2, 5), exit: bx(34, 0, 24, 40, 6, 30) });
    const a = new StageAnalyzer(closed, quiet).checkGeometry();
    expect(a.data.leakCells).toBe(0);
    expect(a.status).toBe('pass');
    // a 6 x 6 m hole through the east wall to the outside
    const holed = makeStage(carve([bx(0, 0, 0, 40, 10, 30)], 2, [bx(40, 2, 10, 46, 8, 16)]), { start: pt(5, 2, 5), exit: bx(34, 0, 24, 40, 6, 30) });
    const b = new StageAnalyzer(holed, quiet).checkGeometry();
    expect(b.data.leakCells as number).toBeGreaterThan(0);
    expect(b.status).toBe('fail');
  });

  it('flags decor inside the player volume but not thin high lamps', () => {
    const st = makeStage(carve([bx(0, 0, 0, 40, 14, 30)]), { start: pt(5, 2, 5), exit: bx(34, 0, 24, 40, 6, 30) });
    st.decor = [{ ...bx(20, 12, 10, 22, 12.2, 12), shape: 'box', material: 'light-warm' }];
    expect(new StageAnalyzer(st, quiet).checkGeometry().data.decorIntrusions).toBe(0);
    st.decor = [{ ...bx(20, 1, 10, 22, 3, 12), shape: 'box', material: 'metal' }];
    expect(new StageAnalyzer(st, quiet).checkGeometry().data.decorIntrusions).toBe(1);
  });

  it('thin decor in the flight volume must hang from the ceiling or be clamped to a wall', () => {
    const hall = (): StageDef => makeStage(carve([bx(0, 0, 0, 40, 30, 30)]), { start: pt(5, 2, 5), exit: bx(34, 0, 24, 40, 6, 30) });
    // 20 m cable in the middle of the hall (0.16 m thick, ends 10 m above the floor): free-hanging
    const cable = hall();
    cable.decor = [{ ...bx(19.92, 10, 14.92, 20.08, 30, 15.08), shape: 'cylinder-y', material: 'metal' }];
    const r = new StageAnalyzer(cable, quiet).checkGeometry();
    expect(r.status).toBe('fail');
    expect(r.problems.join('\n')).toContain('free-hanging');
    // the same cable clamped to the west wall, and a 3 m beacon cable under the roof, are fine
    const mounted = hall();
    mounted.decor = [
      { ...bx(0.25, 10, 14.92, 0.41, 30, 15.08), shape: 'cylinder-y', material: 'metal' },
      { ...bx(19.92, 27, 14.92, 20.08, 30, 15.08), shape: 'cylinder-y', material: 'metal' },
    ];
    const r2 = new StageAnalyzer(mounted, quiet).checkGeometry();
    expect(r2.problems).toEqual([]);
    expect(r2.data.thinDecorInside).toBe(2);
  });

  it('finds visible coplanar overlapping faces (z-fighting) and ignores abutting or hidden ones', () => {
    const hall = bx(0, 0, 0, 40, 14, 30);
    const base = (extra: SolidDef[]): string[] => new StageAnalyzer(makeStage([...carve([hall]), ...extra], { start: pt(5, 2, 5), exit: bx(34, 0, 24, 40, 6, 30) }), quiet).coplanarFaces();
    expect(base([])).toEqual([]);
    // two interpenetrating rubble blocks sharing the plane x = 20
    const z = base([solid(bx(20, 0, 10, 23, 1.2, 13)), solid(bx(20, 0, 11, 22, 0.8, 14), 'rust')]);
    expect(z.length).toBe(1);
    expect(z[0]).toContain('x = 20');
    // abutting blocks with flush tops share no face area; a block flush against the wall is hidden by the wall
    expect(base([solid(bx(20, 0, 10, 23, 1.2, 13)), solid(bx(23, 0, 10, 26, 1.2, 13), 'rust')])).toEqual([]);
    expect(base([solid(bx(0, 0, 10, 3, 2, 13)), solid(bx(0, 0, 11, 2, 1, 14), 'rust')])).toEqual([]);
    const ck = new StageAnalyzer(makeStage([...carve([hall]), solid(bx(20, 0, 10, 23, 1.2, 13)), solid(bx(20, 0, 11, 22, 0.8, 14), 'rust')], { start: pt(5, 2, 5), exit: bx(34, 0, 24, 40, 6, 30) }), quiet).checkGeometry();
    expect(ck.status).toBe('fail');
    expect(ck.data.coplanarFaces).toBe(1);
  });
});

// ───────────────────────────── V3 shortest path ─────────────────────────────
describe('shortest route (V3)', () => {
  it('brackets the analytic shortest path of an L-shaped corridor', () => {
    // leg 1: x 0..60, z 0..10; leg 2: x 50..60, z 10..70. Player-centre space is shrunk by 1.3 m, so the
    // shortest path bends at the inner corner (51.3, 8.7) and then runs straight along +z to z = 60.
    const solids = carve([bx(0, 0, 0, 60, 6, 10), bx(50, 0, 10, 60, 6, 70)]);
    const stage = makeStage(solids, { start: pt(3, 2, 5), exit: bx(50, 0, 60, 60, 6, 70) });
    const analytic = Math.hypot(51.3 - 3, 8.7 - 5) + (60 - 8.7);
    const r = new StageAnalyzer(stage, quiet).checkRoute();
    const d = r.data as Record<string, number>;
    expect(d.lowerBoundProven).toBeLessThanOrEqual(analytic);
    expect(d.lowerBoundVoxel).toBeLessThanOrEqual(analytic);
    expect(d.lowerBound).toBeGreaterThan(analytic * 0.93);
    expect(d.feasibleRouteValid).toBe(true);
    expect(d.feasibleRouteLength).toBeGreaterThanOrEqual(analytic - 1e-6);
    expect(d.feasibleRouteLength).toBeLessThan(analytic + 2);
    expect(d.lgrid).toBeGreaterThanOrEqual(analytic - 1);
    expect(d.lgrid).toBeLessThanOrEqual(analytic * CHAMFER_RATIO + 2);
    expect(r.status).toBe('fail'); // far below 1500 m
  });

  it('the proven hop bound never exceeds the straight-line distance in an open hall', () => {
    const solids = carve([bx(0, 0, 0, 120, 30, 90)]);
    for (const [ex, ez, ey] of [[110, 80, 0], [110, 8, 0], [60, 80, 18], [100, 40, 20]] as const) {
      const exit = bx(ex, ey, ez, ex + 6, ey + 6, ez + 6);
      const start = pt(4.2, 2, 3.7);
      const stage = makeStage(solids, { start, exit });
      const d = new StageAnalyzer(stage, quiet).checkRoute().data as Record<string, number>;
      // distance from the start to the closest legal point of the exit zone
      const tx = Math.max(exit.min.x, Math.min(start.x, exit.max.x));
      const ty = Math.max(Math.max(exit.min.y, 2), Math.min(start.y, exit.max.y));
      const tz = Math.max(exit.min.z, Math.min(start.z, exit.max.z));
      const straight = Math.hypot(tx - start.x, ty - start.y, tz - start.z);
      expect(d.lowerBoundProven).toBeLessThanOrEqual(straight);
      expect(d.lowerBoundVoxel).toBeLessThanOrEqual(straight);
      expect(d.feasibleRouteLength).toBeGreaterThanOrEqual(straight - 1e-6);
      expect(d.lowerBoundProven).toBeGreaterThan(straight * 0.7 - 3);
    }
  });
});

// ───────────────────────────── V4 / V5 ─────────────────────────────
describe('mandatory sectors and barriers (V4, V5)', () => {
  // chain R1 – R2 – R3 – R5 along x, side room R4 north of R2
  const R1 = bx(0, 0, 0, 30, 8, 20);
  const R2 = bx(32, 0, 0, 62, 8, 20);
  const R3 = bx(64, 0, 0, 94, 8, 20);
  const R5 = bx(96, 0, 0, 126, 8, 20);
  const R4 = bx(32, 0, 22, 62, 8, 42);
  const D12 = bx(30, 0, 5, 32, 6, 15);
  const D23 = bx(62, 0, 5, 64, 6, 15);
  const D35 = bx(94, 0, 5, 96, 6, 15);
  const D24 = bx(42, 0, 20, 52, 6, 22);
  const base = (extraRooms: Box[] = []): StageDef => {
    const st = makeStage(carve([R1, R2, R3, R5, R4, D12, D23, D35, D24, ...extraRooms]), { start: pt(5, 2, 10), exit: bx(118, 0, 0, 126, 8, 20) });
    st.sectors = [sector('S1', 'dock', R1), sector('S2', 'yard', R2), sector('S3', 'factory', R3), sector('S4', 'warehouse', R4), sector('S5', 'gate', R5)];
    return st;
  };

  it('finds the chain sectors mandatory and the side room optional', () => {
    const r = new StageAnalyzer(base(), quiet).checkMandatorySectors();
    expect(r.data.mandatory).toEqual(['S1', 'S2', 'S3', 'S5']);
    expect(r.data.optional).toEqual(['S4']);
  });

  it('a bypass corridor makes a sector optional', () => {
    // corridor from R1 to R3 that goes around R2 (south side)
    const bypass = [bx(10, 0, -12, 80, 6, -4), bx(10, 0, -4, 20, 6, 0), bx(70, 0, -4, 80, 6, 0)];
    const r = new StageAnalyzer(base(bypass), quiet).checkMandatorySectors();
    expect(r.data.mandatory).toEqual(['S1', 'S3', 'S5']);
  });

  const progression = (b2: Box, extraRooms: Box[] = []): StageDef => {
    const st = base(extraRooms);
    st.barriers = [
      { id: 'B1', name: 'B1', box: D12, controlEnemyId: 'T1', fromSectorId: 'S1', toSectorId: 'S2' },
      { id: 'B2', name: 'B2', box: b2, controlEnemyId: 'T2', fromSectorId: 'S2', toSectorId: 'S3' },
    ];
    st.finalGate = { id: 'GATE', name: 'gate', box: D35 };
    st.enemies = [turret('T1', 'S1', 20, 0, 4, 'B1'), turret('T2', 'S2', 36, 0, 17, 'B2')];
    return st;
  };

  it('accepts barriers that fill their doorway and enforces the order of the control turrets', () => {
    const r = new StageAnalyzer(progression(D23), quiet).checkProgression();
    expect(r.problems).toEqual([]);
    expect(r.status).toBe('pass');
  });

  it('rejects a barrier that leaves a passable gap', () => {
    const r = new StageAnalyzer(progression(bx(62, 0, 5, 64, 6, 9)), quiet).checkProgression();
    expect(r.status).toBe('fail');
    expect(r.problems.join('\n')).toContain('NOT a cut: B2');
  });

  it('accepts a barrier that leaves a gap the player box cannot pass (2 m)', () => {
    const r = new StageAnalyzer(progression(bx(62, 0, 5, 64, 6, 13)), quiet).checkProgression();
    expect(r.problems).toEqual([]);
  });

  it('detects a control turret that can be shot through a window before its turn', () => {
    // a 1 m window in the R1/R2 wall far from T2 (z = 17): no line from R1 through it reaches the turret
    const r = new StageAnalyzer(progression(D23, [bx(30, 1, 1.5, 32, 2.5, 2.5)]), quiet).checkProgression();
    expect(r.problems).toEqual([]);
    // the same window right in front of T2: it can be shot from R1 while B1 is still closed
    const st = progression(D23, [bx(30, 1, 16.5, 32, 2.5, 17.5)]);
    const r2 = new StageAnalyzer(st, quiet).checkProgression();
    expect(r2.status).toBe('fail');
    expect(r2.problems.join('\n')).toContain('next control turret T2 is NOT attackable');
  });

  it('requires the exit to lie beyond the final gate', () => {
    const st = progression(D23);
    st.finalGate = { id: 'GATE', name: 'gate', box: bx(100, 0, 2, 101, 2, 3) };
    const r = new StageAnalyzer(st, quiet).checkProgression();
    expect(r.problems.join('\n')).toContain('final gate');
  });
});

// ───────────────────────────── V6 flight ─────────────────────────────
describe('no-flight closure and flight spots (V6)', () => {
  /** Hall A (floor 0) and hall B (floor `h`) side by side; returns whether B can be reached by jumping. */
  const ledge = (hA: number, hB: number, steps: SolidDef[] = []): boolean => {
    const top = Math.max(hA, hB) + 12;
    const solids = [...carve([bx(0, hA, 0, 20, top, 12), bx(20, hB, 0, 40, top, 12)]), ...steps];
    const stage = makeStage(solids, { start: pt(4, hA + 2, 6), exit: bx(34, hB, 0, 40, hB + 6, 12) });
    const an = new StageAnalyzer(stage, quiet);
    const g = an.grid;
    const seeds = new Uint8Array(g.n);
    for (let c = 0; c < g.n; c++) if (g.X(g.ix(c)) < 12 && g.Y(g.iy(c)) < hA + 3) seeds[c] = 1; // resting cells on A's floor
    const cap = new Uint16Array(g.n);
    g.noFlightClosure(an.maskL(), seeds, cap, 2.8);
    return cap[g.cellOf(pt(30, hB + 2, 6))] !== 0;
  };

  it('a 2.5 m step is passable without flight, a 3.5 m ledge is not', () => {
    expect(ledge(0, 2.5)).toBe(true);
    expect(ledge(0, 2)).toBe(true);
    expect(ledge(0, 3.5)).toBe(false);
    expect(ledge(0, 4)).toBe(false);
    expect(ledge(0, 8)).toBe(false);
  });

  it('a drop of any height is passable', () => {
    expect(ledge(3, 0)).toBe(true);
    expect(ledge(30, 0)).toBe(true);
  });

  it('a chain of 2.5 m steps is passable, a chain with one 3.5 m riser is not', () => {
    const stairs = (heights: number[]): SolidDef[] => heights.map((h, i) => solid(bx(8 + i * 4, 0, 0, 12 + i * 4, h, 12)));
    expect(ledge(0, 10, stairs([2.5, 5, 7.5]))).toBe(true);
    expect(ledge(0, 10, stairs([2.5, 5, 6]))).toBe(false); // last riser 4 m
    expect(ledge(0, 11, stairs([2.5, 5, 7.5]))).toBe(false); // last riser 3.5 m
  });

  // hall A (floor 0), hall B (floor +8) joined by a doorway at +8
  const A = bx(0, 0, 0, 30, 22, 20);
  const Bh = bx(32, 8, 0, 62, 22, 20);
  const door = bx(30, 8, 5, 32, 14, 15);
  const spotStage = (extra: SolidDef[] = [], cut: Box = bx(30, 8, 3, 32, 16, 17)): StageDef => {
    const st = makeStage([...carve([A, Bh, door]), ...extra], { start: pt(5, 2, 10), exit: bx(54, 8, 0, 62, 16, 20) });
    st.flightSpots = [{ id: 'F1', sectorId: 'S1', from: pt(20, 2, 10), to: pt(38, 10, 10), height: 8, cut }];
    return st;
  };

  it('accepts a genuine 8 m climb through a mandatory opening', () => {
    const r = new StageAnalyzer(spotStage(), quiet).checkFlightSpots();
    const s = (r.data.spots as Array<Record<string, unknown>>)[0];
    expect(s.problems).toEqual([]);
    expect(s.isCut).toBe(true);
    expect(s.needsFlight).toBe(true);
  });

  it('rejects the climb when crates form a jumpable staircase', () => {
    const crates = [solid(bx(18, 0, 5, 22, 2.5, 15)), solid(bx(22, 0, 5, 26, 5, 15)), solid(bx(26, 0, 5, 30, 7.5, 15))];
    const r = new StageAnalyzer(spotStage(crates), quiet).checkFlightSpots();
    const s = (r.data.spots as Array<Record<string, unknown>>)[0];
    expect(s.isCut).toBe(true);
    expect(s.needsFlight).toBe(false);
    expect(r.status).toBe('fail');
  });

  it('a high crate that can only be reached by flying does not count as a staircase … but a perch level with the landing does', () => {
    // 4 m crate next to the wall: still 4 m below the opening → flight needed
    const r = new StageAnalyzer(spotStage([solid(bx(26, 0, 5, 30, 4, 15))]), quiet).checkFlightSpots();
    expect((r.data.spots as Array<Record<string, unknown>>)[0].needsFlight).toBe(true);
    // 7 m crate far away from the cut (outside the landing lip): from its top the opening is 1 m up
    const r2 = new StageAnalyzer(spotStage([solid(bx(10, 0, 5, 27, 7, 15))]), quiet).checkFlightSpots();
    expect((r2.data.spots as Array<Record<string, unknown>>)[0].needsFlight).toBe(false);
  });

  it('measures the smallest climb that crosses the cut and rejects one below 6 m', () => {
    // genuine: nothing higher than the floor → the smallest crossing climb is the full 8 m
    const g0 = (new StageAnalyzer(spotStage(), quiet).checkFlightSpots().data.spots as Array<{ minClimb: number; problems: string[] }>)[0];
    expect(g0.minClimb).toBe(8);
    // a 2 m crate far from the landing: 6 m riser left → still accepted, measured as 6 m
    const g1 = (new StageAnalyzer(spotStage([solid(bx(10, 0, 5, 16, 2, 15))]), quiet).checkFlightSpots().data.spots as Array<{ minClimb: number; problems: string[] }>)[0];
    expect(g1.problems).toEqual([]);
    expect(g1.minClimb).toBe(6);
    // a 3 m crate: flight is still required (5 m > jump apex), but the climb is shorter than 6 m → rejected
    const r = new StageAnalyzer(spotStage([solid(bx(10, 0, 5, 16, 3, 15))]), quiet).checkFlightSpots();
    const g2 = (r.data.spots as Array<{ minClimb: number; needsFlight: boolean; problems: string[] }>)[0];
    expect(g2.needsFlight).toBe(true);
    expect(g2.problems.join('\n')).toContain('(e) the cut can be crossed with a climb of less than 6 m');
    expect(r.status).toBe('fail');
  });

  it('counts an opening only once: duplicate, overlapping or straddling cuts are rejected', () => {
    // hall A (0) → B (+8, 60 m long) → C (+16): two genuine climbs one after the other
    const C = bx(94, 16, 0, 124, 30, 20);
    const door2 = bx(92, 16, 5, 94, 22, 15);
    const two = (): StageDef => {
      const st = makeStage(carve([bx(0, 0, 0, 30, 30, 20), bx(32, 8, 0, 92, 30, 20), door, C, door2]), { start: pt(5, 2, 10), exit: bx(116, 16, 0, 124, 24, 20) });
      st.flightSpots = [
        { id: 'F1', sectorId: 'S1', from: pt(20, 2, 10), to: pt(38, 10, 10), height: 8, cut: bx(30, 8, 3, 32, 16, 17) },
        { id: 'F2', sectorId: 'S1', from: pt(82, 10, 10), to: pt(100, 18, 10), height: 8, cut: bx(92, 16, 3, 94, 24, 17) },
      ];
      return st;
    };
    const ok = new StageAnalyzer(two(), quiet).checkFlightSpots();
    expect(ok.problems.filter((q) => !q.includes('declared flight spots'))).toEqual([]);
    expect(ok.data.order).toEqual(['F1', 'F2']);
    // the first opening declared a second time 21 m further along the same landing
    const dup = two();
    dup.flightSpots[1] = { id: 'F1dup', sectorId: 'S1', from: pt(20, 2, 10), to: pt(59, 10, 10), height: 8, cut: bx(30, 8, 3, 32, 16, 17) };
    const bad = new StageAnalyzer(dup, quiet).checkFlightSpots().problems.join('\n');
    expect(bad).toContain('cut boxes are pairwise disjoint');
    expect(bad).toContain('F1/F1dup');
    // a spot whose take-off lies before and whose landing lies beyond another spot's cut
    const straddle = two();
    straddle.flightSpots[1] = { id: 'F2', sectorId: 'S1', from: pt(20, 2, 16), to: pt(100, 18, 10), height: 16, cut: bx(92, 16, 3, 94, 24, 17) };
    expect(new StageAnalyzer(straddle, quiet).checkFlightSpots().problems.join('\n')).toContain('different sides');
  });

  it('rejects a cut that does not span the passage, and a second route around it', () => {
    const r = new StageAnalyzer(spotStage([], bx(30, 8, 3, 32, 16, 9)), quiet).checkFlightSpots();
    expect((r.data.spots as Array<Record<string, unknown>>)[0].isCut).toBe(false);
    // second doorway at floor level elsewhere → the cut is no longer mandatory
    const st = spotStage();
    st.solids = [...carve([A, Bh, door, bx(30, 8, 17, 32, 14, 20)])];
    const r2 = new StageAnalyzer(st, quiet).checkFlightSpots();
    expect((r2.data.spots as Array<Record<string, unknown>>)[0].isCut).toBe(false);
  });

  it('checks the declared height and the standing areas', () => {
    const st = spotStage();
    st.flightSpots[0].height = 9;
    expect(new StageAnalyzer(st, quiet).checkFlightSpots().problems.join('\n')).toContain('declared height');
    const st2 = spotStage();
    st2.flightSpots[0].from = pt(20, 3, 10);
    expect(new StageAnalyzer(st2, quiet).checkFlightSpots().problems.join('\n')).toContain("'from'");
  });

  it('the flight controller climbs a ledge in a reference model of the documented physics', () => {
    const st = spotStage();
    const an = new StageAnalyzer(st, quiet);
    const spot = st.flightSpots[0];
    const plan = an.flightPlan(spot.from, spot.to)!;
    expect(plan.length).toBeGreaterThanOrEqual(2);
    const world = new World(st);
    world.setBarrierOpen('GATE', true);
    const ref = new RefPlayer(world, spot.from);
    for (let i = 0; i < 30; i++) ref.tick();
    const res = flyClimb(ref, spot.to, plan, 12.8);
    expect(res.reason).toBe('landed');
    expect(res.ok).toBe(true);
    expect(Math.abs(res.landed.y - spot.to.y)).toBeLessThan(0.05);
    // 8 m climb: (8 + 0.7 - 1.64) / 8 s of thrust = 17.7 EN, plus hovering over 18 m of horizontal travel
    expect(res.enUsed).toBeGreaterThan(17);
    expect(res.enUsed).toBeLessThan(60);
    // a 40 m climb cannot be flown with EN 90 (4.5 s x 8 m/s = 36 m)
    const tall = makeStage(carve([bx(0, 0, 0, 30, 60, 20), bx(32, 40, 0, 62, 60, 20), bx(30, 40, 5, 32, 46, 15)]), { start: pt(5, 2, 10), exit: bx(54, 40, 0, 62, 48, 20) });
    const w2 = new World(tall);
    w2.setBarrierOpen('GATE', true);
    const ref2 = new RefPlayer(w2, pt(20, 2, 10));
    for (let i = 0; i < 30; i++) ref2.tick();
    const res2 = flyClimb(ref2, pt(38, 42, 10), [pt(20, 2, 10), pt(38, 42, 10)], 12.8);
    expect(res2.ok).toBe(false);
    expect(res2.enLeft).toBe(0);
  });

  it('flies the climb with the real simulation when player.ts is implemented', (ctx) => {
    if (!playerMovementImplemented()) {
      ctx.skip('src/sim/player.ts is still a stub — flight simulation not run');
      return;
    }
    const st = spotStage();
    const an = new StageAnalyzer(st, {});
    const plan = an.flightPlan(st.flightSpots[0].from, st.flightSpots[0].to);
    const res = simulateFlightSpot(st, st.flightSpots[0], plan ?? undefined);
    expect(res.reason).toBe('landed');
    expect(res.ok).toBe(true);
    expect(res.enLeft).toBeGreaterThan(0);
    expect(res.enUsed).toBeGreaterThan(10);
    // a 40 m climb is impossible with EN 90 (4.5 s x 8 m/s = 36 m)
    const tall = makeStage(carve([bx(0, 0, 0, 30, 60, 20), bx(32, 40, 0, 62, 60, 20), bx(30, 40, 5, 32, 46, 15)]), { start: pt(5, 2, 10), exit: bx(54, 40, 0, 62, 48, 20) });
    const res2 = simulateFlightSpot(tall, { from: pt(20, 2, 10), to: pt(38, 42, 10) });
    expect(res2.ok).toBe(false);
  });
});

// ───────────────────────────── V6d / V14 real simulation ─────────────────────────────
describe('ground planning and the walkthrough bot (V6d, V14)', () => {
  // hall A (floor 0) and hall B (floor +8) joined by a doorway at +8 that barrier B1 closes; T1 opens it
  const A = bx(0, 0, 0, 30, 22, 20);
  const Bh = bx(32, 8, 0, 62, 22, 20);
  const door = bx(30, 8, 5, 32, 14, 15);
  const walkStage = (extra: SolidDef[] = [], turretAt: [number, number] = [26, 3]): StageDef => {
    const st = makeStage([...carve([A, Bh, door]), ...extra], { start: pt(5, 2, 10), exit: bx(54, 8, 0, 62, 16, 20) });
    st.sectors = [sector('S1', 'dock', bx(0, -2, -2, 31, 24, 22)), sector('S2', 'gate', bx(31, 6, -2, 64, 24, 22))];
    st.barriers = [{ id: 'B1', name: 'B1', box: door, controlEnemyId: 'T1', fromSectorId: 'S1', toSectorId: 'S2' }];
    st.enemies = [turret('T1', 'S1', turretAt[0], 0, turretAt[1], 'B1')];
    st.flightSpots = [{ id: 'F1', sectorId: 'S1', from: pt(20, 2, 10), to: pt(38, 10, 10), height: 8, cut: bx(30, 8, 3, 32, 16, 17) }];
    st.route = [
      { sectorId: 'S1', position: pt(5, 2, 10) },
      { sectorId: 'S1', position: pt(20, 2, 10) },
      { sectorId: 'S2', position: pt(38, 10, 10) },
      { sectorId: 'S2', position: pt(58, 10, 10) },
    ];
    return st;
  };

  it('estimates the EN of a climb from the documented flight numbers', () => {
    // 8 m: jump + 0.2 s hold lift 1.64 m, the remaining 6.86 m (to 0.5 m above the landing) at 8 m/s cost 17.15 EN
    expect(estimateClimbEn(8, 10, 12.8)).toBeCloseTo(((8 + 0.5 - 1.64) / 8) * 20, 6);
    expect(estimateClimbEn(14, 14, 12.8)).toBeCloseTo(((14 + 0.5 - 1.64) / 8) * 20, 6);
    // a long horizontal leg adds hover time
    expect(estimateClimbEn(8, 60, 12.8)).toBeGreaterThan(estimateClimbEn(8, 10, 12.8) + 20);
    expect(MOVEMENT_LOADOUTS.length).toBe(6);
    expect(new Set(MOVEMENT_LOADOUTS.map((l) => `${l.generator}+${l.legs}`)).size).toBe(6);
  });

  it('plans a walkable path around an obstacle and refuses a walled-off target', () => {
    // 4 m high block across the middle of hall A, leaving 5 m gaps at both side walls
    const an = new StageAnalyzer(walkStage([solid(bx(12, 0, 5, 15, 4, 15))]), quiet);
    const from = pt(5, 2, 10);
    const to = pt(24, 2, 10);
    const plan = an.groundPlan(from, to)!;
    expect(plan).not.toBeNull();
    let len = 0;
    an.setWorld([]);
    for (let i = 1; i < plan.length; i++) {
      len += Math.hypot(plan[i].x - plan[i - 1].x, plan[i].z - plan[i - 1].z);
      expect(an.sweepFree(plan[i - 1], plan[i])).toBe(true);
      expect(plan[i].y).toBe(2);
    }
    expect(len).toBeGreaterThan(20.5); // the straight line (19 m) is blocked
    expect(len).toBeLessThan(26);
    expect(plan[0]).toEqual(from);
    expect(plan[plan.length - 1]).toEqual(to);
    // different floor levels are not a ground plan
    expect(an.groundPlan(from, pt(38, 10, 10))).toBeNull();
    // full-width wall: no path
    const an2 = new StageAnalyzer(walkStage([solid(bx(12, 0, 0, 15, 22, 20))]), quiet);
    expect(an2.groundPlan(from, to)).toBeNull();
  });

  it('keeps a ground plan away from the edge of a pit', () => {
    // pit (hole in the floor) between the two points; the direct line crosses it
    const pit = bx(12, -6, 6, 18, 0, 14);
    const st = makeStage(carve([A, pit]), { start: pt(5, 2, 10), exit: bx(24, 0, 0, 30, 8, 20) });
    const an = new StageAnalyzer(st, quiet);
    const plan = an.groundPlan(pt(5, 2, 10), pt(25, 2, 10))!;
    expect(plan).not.toBeNull();
    // the player's centre keeps at least 0.4 m of floor between itself and the edge (the box may overhang)
    let len = 0;
    for (let i = 0; i < plan.length; i++) {
      const q = plan[i];
      const nearPit = q.x > 12 - 0.4 && q.x < 18 + 0.4 && q.z > 6 - 0.4 && q.z < 14 + 0.4;
      expect(nearPit, `(${q.x}, ${q.z}) is at the edge of the pit`).toBe(false);
      if (i > 0) len += Math.hypot(q.x - plan[i - 1].x, q.z - plan[i - 1].z);
    }
    expect(len).toBeGreaterThan(20.3); // around the pit, not across it (straight line: 20 m)
    expect(len).toBeLessThan(26);
  });

  it('plays a route with a drop, a climb, a barrier and the exit; reports why a broken route fails', (ctx) => {
    if (!playerMovementImplemented()) {
      ctx.skip('src/sim/player.ts is still a stub — walkthrough not run');
      return;
    }
    const st = walkStage();
    const an = new StageAnalyzer(st, {});
    for (const lo of [WEAKEST_LOADOUT, MOVEMENT_LOADOUTS[3]]) {
      const r = runWalkthrough(an, lo);
      expect(r.reason).toBe('cleared');
      expect(r.ok).toBe(true);
      expect(r.status).toBe('cleared');
      expect(r.controls.map((c) => c.id)).toEqual(['T1']);
      expect(r.climbs.length).toBe(1);
      expect(r.climbs[0].height).toBeCloseTo(8, 1);
      expect(r.climbs[0].enUsed).toBeGreaterThan(15);
      expect(r.climbs[0].enUsed).toBeLessThan(40);
      expect(r.flights).toBe(1);
      expect(r.waypointsReached).toBe(4);
      expect(r.distance).toBeGreaterThan(50);
      expect(r.distance).toBeLessThan(80);
      expect(r.visitedSectors).toEqual(['S1', 'S2']);
    }
    // the check itself: only the size thresholds of the real stage (>= 12 sectors, >= 1500 m) are missed here
    const ck = an.checkWalkthrough();
    expect(ck.problems.filter((q) => !q.includes('sectors entered') && !q.includes('distance travelled'))).toEqual([]);
    expect(ck.problems.length).toBe(4);
    expect((ck.data.runs as unknown[]).length).toBe(2);

    // control turret sealed in a closet in the corner of hall A: the barrier never opens, the climb cannot land
    const hidden = walkStage([solid(bx(22, 0, 0, 23, 22, 7)), solid(bx(23, 0, 7, 30, 22, 8))], [27, 3]);
    const r2 = runWalkthrough(new StageAnalyzer(hidden, {}), WEAKEST_LOADOUT);
    expect(r2.ok).toBe(false);
    expect(r2.controls).toEqual([]);
    expect(r2.reason).toContain('climb');

    // a waypoint behind a wall without any opening
    const walled = walkStage([solid(bx(12, 0, 0, 15, 22, 20))]);
    const r3 = runWalkthrough(new StageAnalyzer(walled, {}), WEAKEST_LOADOUT);
    expect(r3.ok).toBe(false);
    expect(r3.reason).toContain('no walkable ground path');

    // a waypoint declared in the wrong sector / floating in the air is a documentation error
    const wrong = walkStage();
    wrong.route[1] = { sectorId: 'S2', position: pt(20, 2, 10) };
    wrong.route[3] = { sectorId: 'S2', position: pt(58, 11, 10) };
    const ck2 = new StageAnalyzer(wrong, quiet).checkWalkthrough();
    expect(ck2.status).toBe('fail');
    expect(ck2.problems.join('\n')).toContain('declared S2');
    expect(ck2.problems.join('\n')).toContain('not a standing position');
  });

  it('a climb beyond the EN budget of the weakest loadout fails the walkthrough', (ctx) => {
    if (!playerMovementImplemented()) {
      ctx.skip('src/sim/player.ts is still a stub — walkthrough not run');
      return;
    }
    // 40 m ledge: EN 90 gives 4.5 s x 8 m/s = 36 m of thrust
    const tall = makeStage(carve([bx(0, 0, 0, 30, 60, 20), bx(32, 40, 0, 62, 60, 20), bx(30, 40, 5, 32, 46, 15)]), { start: pt(5, 2, 10), exit: bx(54, 40, 0, 62, 48, 20) });
    tall.enemies = [turret('T1', 'S1', 26, 0, 3, 'B1')];
    tall.barriers = [{ id: 'B1', name: 'B1', box: bx(30, 40, 5, 32, 46, 15), controlEnemyId: 'T1', fromSectorId: 'S1', toSectorId: 'S2' }];
    tall.route = [
      { sectorId: 'S1', position: pt(5, 2, 10) },
      { sectorId: 'S1', position: pt(20, 2, 10) },
      { sectorId: 'S2', position: pt(38, 42, 10) },
      { sectorId: 'S2', position: pt(58, 42, 10) },
    ];
    const r = runWalkthrough(new StageAnalyzer(tall, {}), WEAKEST_LOADOUT);
    expect(r.ok).toBe(false);
    expect(r.controls.map((c) => c.id)).toEqual(['T1']);
    expect(r.reason).toContain('climb of 40 m');
  });
});

// ───────────────────────────── V7 / V8 ─────────────────────────────
describe('branches and loops (V7, V8)', () => {
  // square ring corridor, 15 m wide: outer 0..75, inner block 15..60
  const ringRooms = [bx(0, 0, 0, 75, 8, 15), bx(0, 0, 60, 75, 8, 75), bx(0, 0, 15, 15, 8, 60), bx(60, 0, 15, 75, 8, 60)];
  const W = pt(7.5, 2, 37.5);
  const E = pt(67.5, 2, 37.5);
  const S = pt(37.5, 2, 7.5);
  const N = pt(37.5, 2, 67.5);
  const ring = (rooms: Box[] = ringRooms): StageDef => makeStage(carve(rooms), { start: pt(5, 2, 5), exit: bx(60, 0, 60, 75, 8, 75) });
  // two turrets in the south corridor: they see the south side of the ring only
  const southGuns = (): EnemyDef[] => [turret('T1', 'S', 22, 0, 3), turret('T2', 'S', 52, 0, 3)];
  // the same floor plan without the inner block: one open hall
  const openHall = (): StageDef => makeStage(carve([bx(0, 0, 0, 75, 8, 75)]), { start: pt(5, 2, 5), exit: bx(60, 0, 60, 75, 8, 75) });

  it('accepts a ring as a loop and rejects waypoints along a dead-end corridor', () => {
    const st = ring();
    st.loops = [
      { id: 'ring', points: [W, S, E, N], note: '' },
      { id: 'line', points: [pt(7.5, 2, 20), pt(7.5, 2, 37.5), pt(7.5, 2, 55)], note: '' },
    ];
    const r = new StageAnalyzer(st, quiet).checkLoops();
    const loops = r.data.loops as Array<{ id: string; perimeter: number; hole: number; problems: string[] }>;
    expect(loops[0].problems).toEqual([]);
    expect(loops[0].perimeter).toBeGreaterThan(170);
    expect(loops[0].perimeter).toBeLessThan(260);
    // the ring goes around the 45 x 45 m inner block (player-centre space: about 47.6 x 47.6 m)
    expect(loops[0].hole).toBeGreaterThan(1800);
    expect(loops[0].hole).toBeLessThan(2500);
    // three waypoints in a row along the west corridor survive the ball test (the ring leads around), but the
    // "circuit" through them goes up and down the same corridor: it encloses nothing
    expect(loops[1].problems.join('\n')).toContain('does not go around anything');
    // on a U-shaped corridor (north side removed) W, S, E are a dead end
    const u = ring([ringRooms[0], ringRooms[2], ringRooms[3]]);
    u.loops = [{ id: 'u', points: [W, S, E], note: '' }];
    const r2 = new StageAnalyzer(u, quiet).checkLoops();
    expect((r2.data.loops as Array<{ problems: string[] }>)[0].problems.join('\n')).toContain('disconnects');
  });

  it('rejects loops that are too short or too long', () => {
    const st = ring();
    st.loops = [{ id: 'tiny', points: [pt(5, 2, 5), pt(10, 2, 5), pt(10, 2, 10)], note: '' }];
    const r = new StageAnalyzer(st, quiet).checkLoops();
    expect((r.data.loops as Array<{ problems: string[] }>)[0].problems.join('\n')).toMatch(/perimeter|within 8 m/);
  });

  it('rejects loops declared on a bare open floor (the review case: 2 "loops" in an empty hall)', () => {
    const st = openHall();
    st.loops = [
      { id: 'L1', points: [W, S, E, N], note: '' },
      { id: 'L2', points: [pt(10, 2, 10), pt(40, 2, 10), pt(25, 2, 40)], note: '' },
    ];
    const r = new StageAnalyzer(st, quiet).checkLoops();
    expect(r.status).toBe('fail');
    const loops = r.data.loops as Array<{ hole: number; problems: string[] }>;
    // connected, right perimeter, survives every ball — and still not a circuit around anything
    expect(loops[0].hole).toBe(0);
    expect(loops[0].problems.join('\n')).toContain('does not go around anything');
    expect(loops[0].problems.join('\n')).toContain('joined by a straight walk');
    expect(loops[1].hole).toBe(0);
    expect(loops[1].problems.join('\n')).toContain('does not go around anything');
    // the same four waypoints are a genuine loop as soon as the 45 x 45 m core stands between them
    const cored = ring();
    cored.loops = [{ id: 'ring', points: [W, S, E, N], note: '' }];
    expect((new StageAnalyzer(cored, quiet).checkLoops().data.loops as Array<{ problems: string[] }>)[0].problems).toEqual([]);
    // … but not when the "core" is a 6 m high wall in the middle of the hall: 30 x 2 m of the 3000 m² the round encloses
    const wall = openHall();
    wall.solids.push(solid(bx(22.5, 0, 36.5, 52.5, 6, 38.5)));
    wall.loops = [{ id: 'wide', points: [pt(7.5, 2, 37.5), pt(37.5, 2, 7.5), pt(67.5, 2, 37.5), pt(37.5, 2, 67.5)], note: '' }];
    const lw = (new StageAnalyzer(wall, quiet).checkLoops().data.loops as Array<{ hole: number; enclosed: number; problems: string[] }>)[0];
    expect(lw.hole).toBeGreaterThanOrEqual(50);
    expect(lw.hole / lw.enclosed).toBeLessThan(0.25);
    expect(lw.problems.join('\n')).toContain('a wide round on open floor');
  });

  it('accepts the two sides of a ring as a branch and reports their lengths', () => {
    const st = ring();
    st.enemies = southGuns();
    st.branches = [{ id: 'BR', from: W, to: E, viaA: S, viaB: N, noteA: 'south', noteB: 'north' }];
    const r = new StageAnalyzer(st, quiet).checkBranches();
    const b = (r.data.branches as Array<{ A: { length: number; retrace: number }; B: { length: number }; ownA: { enemies: number; mean: number }; ownB: { enemies: number }; separation: { ok: boolean; axisA: string }; problems: string[] }>)[0];
    expect(b.problems).toEqual([]);
    // W → S → E through the corridor corners: about 2 x (30 + 30) m on the centre line, a little less cut diagonally
    expect(b.A.length).toBeGreaterThan(85);
    expect(b.A.length).toBeLessThan(125);
    expect(Math.abs(b.A.length - b.B.length)).toBeLessThan(3);
    expect(b.A.retrace).toBeLessThan(0.2);
    expect(b.separation.ok).toBe(true);
    expect(b.separation.axisA).toBe('x');
    expect(b.ownA.enemies).toBe(2);
    expect(b.ownA.mean).toBeGreaterThan(0.5);
    expect(b.ownB.enemies).toBe(0);
  });

  it('requires a measured tactical difference between the alternatives', () => {
    // no enemies at all: two passages, but neither is "short and exposed"
    const st = ring();
    st.branches = [{ id: 'BR', from: W, to: E, viaA: S, viaB: N, noteA: '', noteB: '' }];
    const r = new StageAnalyzer(st, quiet).checkBranches();
    expect(r.status).toBe('fail');
    expect(r.problems.join('\n')).toContain('no clear tactical difference');
    // the guns on the LONGER side: A is made shorter by declaring the rejoin point in the south-east corner
    const st2 = ring();
    st2.enemies = [turret('T1', 'S', 22, 0, 72), turret('T2', 'S', 52, 0, 72)];
    st2.branches = [{ id: 'BR', from: W, to: pt(67.5, 2, 20), viaA: S, viaB: N, noteA: '', noteB: '' }];
    const r2 = new StageAnalyzer(st2, quiet).checkBranches();
    expect(r2.problems.join('\n')).toContain('the shorter one must be clearly the more exposed');
  });

  it('rejects a branch whose second alternative does not exist or is a dead-end detour', () => {
    const u = ring([ringRooms[0], ringRooms[2], ringRooms[3]]); // no north side
    u.branches = [{ id: 'BR', from: W, to: E, viaA: S, viaB: pt(7.5, 2, 55), noteA: '', noteB: '' }];
    const r = new StageAnalyzer(u, quiet).checkBranches();
    expect(r.status).toBe('fail');
    const b = (r.data.branches as Array<{ B: unknown; problems: string[] }>)[0];
    // going to the dead end of the west arm and back retraces itself (and the way on needs viaA's corridor)
    expect(b.problems.length).toBeGreaterThan(0);
  });

  it('rejects branches declared on a bare open floor (the review case: 3 "branches" in an empty hall)', () => {
    const st = openHall();
    st.enemies = southGuns();
    st.branches = [
      { id: 'B1', from: W, to: E, viaA: S, viaB: N, noteA: '', noteB: '' },
      { id: 'B2', from: pt(10, 2, 10), to: pt(65, 2, 65), viaA: pt(55, 2, 15), viaB: pt(15, 2, 55), noteA: '', noteB: '' },
      { id: 'B3', from: S, to: N, viaA: W, viaB: E, noteA: '', noteB: '' },
    ];
    const r = new StageAnalyzer(st, quiet).checkBranches();
    expect(r.status).toBe('fail');
    const brs = r.data.branches as Array<{ A: { length: number }; B: { length: number }; separation: { ok: boolean }; problems: string[] }>;
    for (const b of brs) {
      // both alternatives exist, are long enough and avoid the other via point — the old criteria all hold …
      expect(b.A.length).toBeGreaterThan(40);
      expect(b.B.length).toBeGreaterThan(40);
      // … but nothing separates them
      expect(b.separation.ok).toBe(false);
      expect(b.problems.join('\n')).toContain('not separate passages');
    }
  });

  it('rejects a branch when the wall between its alternatives is opened (walls-removed mutation)', () => {
    // a 6 m wide passage through the inner block right between the two via points
    const holed = ring([...ringRooms, bx(34.5, 0, 15, 40.5, 8, 60)]);
    holed.enemies = southGuns();
    holed.branches = [{ id: 'BR', from: W, to: E, viaA: S, viaB: N, noteA: '', noteB: '' }];
    const r = new StageAnalyzer(holed, quiet).checkBranches();
    expect(r.status).toBe('fail');
    expect(r.problems.join('\n')).toContain('not separate passages');
    // a slit the mech cannot pass (2 m) leaves the passages separate, although the guns now see through it
    const slit = ring([...ringRooms, bx(36.5, 0, 15, 38.5, 3, 60)]);
    slit.enemies = southGuns();
    slit.branches = [{ id: 'BR', from: W, to: E, viaA: S, viaB: N, noteA: '', noteB: '' }];
    const b = (new StageAnalyzer(slit, quiet).checkBranches().data.branches as Array<{ separation: { ok: boolean } }>)[0];
    expect(b.separation.ok).toBe(true);
    // via points that are not in the two passages of the split (both in the south corridor) are rejected as well
    const same = ring();
    same.enemies = southGuns();
    same.branches = [{ id: 'BR', from: W, to: E, viaA: pt(25, 2, 7.5), viaB: pt(50, 2, 7.5), noteA: '', noteB: '' }];
    expect(new StageAnalyzer(same, quiet).checkBranches().status).toBe('fail');
  });
});

// ───────────────────────────── V9 / V10 / V11 ─────────────────────────────
describe('levels, arenas and multi-directional fire (V9, V10, V11)', () => {
  it('counts stacked floors as altitude bands', () => {
    const hall = bx(0, 0, 0, 40, 30, 40);
    const slab = (y: number): SolidDef => solid(bx(0, y - 1, 0, 40, y, 30), 'catwalk');
    const three = makeStage([...carve([hall]), slab(10), slab(20)], { start: pt(5, 2, 35), exit: bx(30, 0, 30, 40, 8, 40) });
    const r = new StageAnalyzer(three, quiet).checkLevels();
    expect((r.data.bands as unknown[]).length).toBe(3);
    expect(r.data.stackedArea as number).toBeGreaterThan(900);
    expect(r.status).toBe('pass');
    const two = makeStage([...carve([hall]), slab(10)], { start: pt(5, 2, 35), exit: bx(30, 0, 30, 40, 8, 40) });
    const r2 = new StageAnalyzer(two, quiet).checkLevels();
    expect((r2.data.bands as unknown[]).length).toBe(2);
    expect(r2.status).toBe('fail');
    // floors only 3 m apart are one band
    const close = makeStage([...carve([hall]), solid(bx(0, 0, 0, 40, 3, 20))], { start: pt(5, 2, 35), exit: bx(30, 0, 30, 40, 8, 40) });
    expect((new StageAnalyzer(close, quiet).checkLevels().data.bands as unknown[]).length).toBe(1);
  });

  const hallStage = (w: number, d: number, enemies: EnemyDef[] = [], extra: SolidDef[] = []): StageDef => {
    const hall = bx(0, 0, 0, w, 12, d);
    const st = makeStage([...carve([hall]), ...extra], { start: pt(4, 2, 4), exit: bx(w - 6, 0, d - 6, w, 6, d) });
    st.sectors = [sector('A1', 'factory', hall, true)];
    st.enemies = enemies;
    return st;
  };

  it('measures the main floor of an arena', () => {
    const big = new StageAnalyzer(hallStage(70, 60), quiet).checkArenas();
    const a = (big.data.arenas as Array<{ long: number; short: number; fill: number; ok: boolean }>)[0];
    expect(a.long).toBeGreaterThanOrEqual(67);
    expect(a.long).toBeLessThanOrEqual(68);
    expect(a.short).toBeGreaterThanOrEqual(57);
    expect(a.fill).toBeGreaterThan(0.99);
    expect(a.ok).toBe(true);
    const small = new StageAnalyzer(hallStage(60, 50), quiet).checkArenas();
    expect((small.data.arenas as Array<{ ok: boolean }>)[0].ok).toBe(false); // centre span is only 57.4 x 47.4 m
    // a hall cut into strips by long walls has a low fill
    const walls = [8, 16, 24, 32, 40, 48].map((z) => solid(bx(6, 0, z, 70, 12, z + 4)));
    const strips = new StageAnalyzer(hallStage(70, 60, [], walls), quiet).checkArenas();
    expect((strips.data.arenas as Array<{ ok: boolean; fill: number }>)[0].ok).toBe(false);
  });

  it('measures coverage by >= 4 enemies from >= 90 degrees', () => {
    const around = [turret('T1', 'A1', 35, 0, 4), turret('T2', 'A1', 35, 0, 56), turret('T3', 'A1', 4, 0, 30), turret('T4', 'A1', 66, 0, 30)];
    const r = new StageAnalyzer(hallStage(70, 60, around), quiet).checkMultiDirectional();
    const a = (r.data.arenas as Array<{ coveredFraction: number; ok: boolean }>)[0];
    expect(a.coveredFraction).toBeGreaterThan(0.95);
    expect(a.ok).toBe(true);
    // the same four in one corner: bearings span < 90° almost everywhere
    const corner = [turret('T1', 'A1', 4, 0, 4), turret('T2', 'A1', 7, 0, 4), turret('T3', 'A1', 4, 0, 7), turret('T4', 'A1', 7, 0, 7)];
    const r2 = new StageAnalyzer(hallStage(70, 60, corner), quiet).checkMultiDirectional();
    expect((r2.data.arenas as Array<{ coveredFraction: number; ok: boolean }>)[0].coveredFraction).toBeLessThan(0.05);
    // a wall hides two of them from half of the hall
    const wall = [solid(bx(30, 0, 8, 32, 12, 52))];
    const r3 = new StageAnalyzer(hallStage(70, 60, around, wall), quiet).checkMultiDirectional();
    const c = (r3.data.arenas as Array<{ coveredFraction: number }>)[0].coveredFraction;
    expect(c).toBeLessThan(a.coveredFraction - 0.3);
    // three enemies are never enough
    const r4 = new StageAnalyzer(hallStage(70, 60, around.slice(0, 3)), quiet).checkMultiDirectional();
    expect((r4.data.arenas as Array<{ ok: boolean }>)[0].ok).toBe(false);
  });
});

// ───────────────────────────── V2 / V12 ─────────────────────────────
describe('enemy placement and start (V2, V12)', () => {
  const dock = bx(0, 0, 0, 80, 8, 20);
  const yard = bx(82, 0, 0, 140, 8, 40);
  const doorway = bx(80, 0, 12, 82, 6, 18);
  const st0 = (): StageDef => {
    const st = makeStage(carve([dock, yard, doorway]), { start: pt(5, 2, 6), yaw: -Math.PI / 2, exit: bx(132, 0, 32, 140, 8, 40) });
    st.sectors = [sector('S1', 'dock', dock), sector('S2', 'yard', yard)];
    return st;
  };

  it('accepts a sheltered start with a free 60 m lane', () => {
    const st = st0();
    st.solids.push(solid(bx(86, 0, 8, 88, 8, 22))); // screen wall in front of the doorway
    st.enemies = [turret('T1', 'S2', 120, 0, 15)]; // cannot see the doorway
    const r = new StageAnalyzer(st, quiet).checkStart();
    expect(r.problems).toEqual([]);
    expect(r.data.laneFree).toBeCloseTo(60, 6);
  });

  it('rejects a start that an enemy can see, a blocked lane and a lane over a pit', () => {
    const seen = st0();
    seen.enemies = [turret('T1', 'S1', 70, 0, 10)];
    expect(new StageAnalyzer(seen, quiet).checkStart().data.exposedTo).toEqual(['T1']);
    const through = st0();
    through.enemies = [turret('T1', 'S2', 100, 0, 15)]; // looks through the doorway into the dock
    expect(new StageAnalyzer(through, quiet).checkStart().data.exposedTo).toEqual(['T1']);
    const crate = st0();
    crate.solids.push(solid(bx(40, 0, 4, 42, 3, 8)));
    const r = new StageAnalyzer(crate, quiet).checkStart();
    expect(r.data.laneFree as number).toBeLessThan(40);
    expect(r.status).toBe('fail');
    const pit = makeStage(carve([dock, bx(30, -6, 2, 36, 0, 10)]), { start: pt(5, 2, 6), yaw: -Math.PI / 2, exit: bx(72, 0, 12, 80, 8, 20) });
    pit.sectors = [sector('S1', 'dock', dock)];
    const r2 = new StageAnalyzer(pit, quiet).checkStart();
    expect(r2.data.laneFloor as number).toBeLessThan(30);
    expect(r2.status).toBe('fail');
  });

  it('checks enemy placement: floating, embedded, unreachable and cramped enemies', () => {
    const st = st0();
    const guard = (id: string, x: number, y: number, z: number): EnemyDef => ({ id, kind: 'guard', sectorId: 'S2', position: pt(x, y, z), isGateControl: false });
    st.solids.push(solid(bx(100, 0, 20, 104, 4, 24)), ...[0, 1, 2, 3].map((i) => solid(bx(126 + (i % 2) * 6, 0, 2 + (i >> 1) * 6, 127 + (i % 2) * 6, 3, 9 + (i >> 1) * 6))));
    st.solids.push(solid(bx(126, 0, 2, 133, 3, 3)), solid(bx(126, 0, 8, 133, 3, 9)));
    st.enemies = [
      guard('G-ok', 110, ENEMIES.guard.centerHeight, 10),
      guard('G-float', 112, 3, 30),
      guard('G-wall', 103, ENEMIES.guard.centerHeight, 22),
      guard('G-pen', 129.5, ENEMIES.guard.centerHeight, 5.5),
      turret('T-top', 'S2', 102, 4, 22),
      turret('T-out', 'S1', 120, 0, 30),
    ];
    const r = new StageAnalyzer(st, quiet).checkEnemies();
    const bad = (r.data.problems as string[]).join('\n');
    expect(bad).not.toContain('G-ok');
    expect(bad).not.toContain('T-top');
    expect(bad).toContain('G-float');
    expect(bad).toContain('G-wall: hit sphere overlaps a solid');
    expect(bad).toContain('G-pen: only');
    expect(bad).toContain('T-out: position');
    expect(r.data.notAttackable).toEqual([]);
    // an enemy sealed inside a closed chamber cannot be attacked
    const sealed = makeStage(carve([dock, bx(90, 0, 0, 100, 8, 10)]), { start: pt(5, 2, 6), exit: bx(72, 0, 12, 80, 8, 20) });
    sealed.sectors = [sector('S1', 'dock', dock), sector('S2', 'yard', bx(90, 0, 0, 100, 8, 10))];
    sealed.enemies = [turret('T-sealed', 'S2', 95, 0, 5)];
    expect(new StageAnalyzer(sealed, quiet).checkEnemies().data.notAttackable).toEqual(['T-sealed']);
  });
});

// ───────────────────────────── V1 kinds of space ─────────────────────────────
describe('kinds of space are measured, not declared (V1)', () => {
  const room = (kind: SectorDef['kind'], w: number, h: number, d: number, extra: SolidDef[] = [], floorY = 0): { an: StageAnalyzer; ok: boolean; cls: string } => {
    const b = bx(0, floorY, 0, w, floorY + h, d);
    const st = makeStage([...carve([b]), ...extra], { start: pt(4, floorY + 2, 4), exit: bx(w - 6, floorY, d - 6, w, floorY + 4, d) });
    st.sectors = [sector('S1', kind, bx(-2, floorY - 2, -2, w + 2, floorY + h + 2, d + 2))];
    const an = new StageAnalyzer(st, quiet);
    const rule = an.kindRule(0, an.sectorShape(0));
    return { an, ok: rule.ok, cls: rule.cls };
  };

  it('measures the shape of a room', () => {
    const { an } = room('yard', 70, 20, 60);
    const sh = an.sectorShape(0);
    expect(sh.spanX).toBeCloseTo(70, 0);
    expect(sh.spanZ).toBeCloseTo(60, 0);
    expect(sh.openSquare).toBeCloseTo(60, 0);
    expect(sh.height).toBeCloseTo(20, 0);
    expect(sh.bands).toBe(1);
    expect(sh.tallFraction).toBe(0);
    expect(sh.tallRows).toBe(0);
  });

  it('a label does not make a kind: the same empty hall is a yard and nothing else', () => {
    expect(room('yard', 70, 20, 60).ok).toBe(true);
    for (const kind of ['corridor', 'road', 'shaft', 'tunnel', 'multilevel', 'factory', 'plant', 'warehouse'] as const) {
      expect(room(kind, 70, 20, 60).ok, kind).toBe(false);
    }
  });

  it('recognises the geometric classes', () => {
    expect(room('corridor', 90, 8, 12)).toMatchObject({ ok: true, cls: 'narrow passage' });
    expect(room('corridor', 90, 8, 30).ok).toBe(false); // 30 m wide
    expect(room('road', 240, 10, 26)).toMatchObject({ ok: true, cls: 'narrow passage' });
    expect(room('shaft', 30, 60, 30)).toMatchObject({ ok: true, cls: 'vertical shaft' });
    expect(room('shaft', 40, 30, 50).ok).toBe(false); // wider than it is tall (the reviewed S06)
    expect(room('tunnel', 120, 9, 20, [], -12)).toMatchObject({ ok: true, cls: 'underground tunnel' });
    expect(room('tunnel', 120, 9, 20).ok).toBe(false); // not below ground level
    // machines taller than the mech on >= 10 % of the floor
    const machines = [0, 1, 2, 3, 4, 5].map((i) => solid(bx(10 + (i % 3) * 20, 0, 10 + Math.floor(i / 3) * 25, 20 + (i % 3) * 20, 6, 20 + Math.floor(i / 3) * 25), 'machine'));
    expect(room('factory', 70, 20, 60, machines)).toMatchObject({ ok: true, cls: 'equipment hall' });
    expect(room('yard', 70, 20, 60, machines).ok).toBe(false);
    // low crates (3 m) are not equipment taller than the mech
    const crates = machines.map((m) => solid({ min: m.min, max: { ...m.max, y: 3 } }, 'container'));
    expect(room('factory', 70, 20, 60, crates).ok).toBe(false);
    expect(room('yard', 70, 20, 60, crates).ok).toBe(true);
    // a second floor over 30 x 40 m
    const deck = [solid(bx(0, 9, 0, 30, 10, 40), 'catwalk')];
    expect(room('multilevel', 70, 24, 60, deck)).toMatchObject({ ok: true, cls: 'stacked floors' });
    expect(room('yard', 70, 24, 60, deck).ok).toBe(false);
    // a plant needs equipment AND service walkways above the floor
    expect(room('plant', 70, 24, 60, [...machines, ...deck]).ok).toBe(true);
    expect(room('plant', 70, 24, 60, machines).ok).toBe(false);
    // three 12 m rack rows
    const racks = [15, 30, 45].map((z) => solid(bx(15, 0, z - 2, 55, 12, z + 2), 'metal'));
    expect(room('warehouse', 70, 20, 60, racks)).toMatchObject({ ok: true, cls: 'rack warehouse' });
    expect(room('warehouse', 70, 20, 60, racks.slice(0, 2)).ok).toBe(false);
  });
});

// ───────────────────────────── V2 mobility ─────────────────────────────
describe('guard mobility on the game NavGrid (V2)', () => {
  const hall = bx(0, 0, 0, 80, 14, 60);
  const guard = (id: string, x: number, floorY: number, z: number): EnemyDef => ({ id, kind: 'guard', sectorId: 'S1', position: pt(x, floorY + ENEMIES.guard.centerHeight, z), isGateControl: false });
  const st0 = (): StageDef => {
    // 20 x 14 m deck 5 m above the floor in the north-east corner
    const st = makeStage([...carve([hall]), solid(bx(56, 0, 42, 76, 5, 56), 'concrete')], { start: pt(5, 2, 5), exit: bx(72, 0, 0, 80, 6, 8) });
    st.sectors = [sector('S1', 'yard', bx(-2, -2, -2, 82, 16, 62), true)];
    st.route = [
      { sectorId: 'S1', position: pt(5, 2, 5) },
      { sectorId: 'S1', position: pt(74, 2, 5) },
    ];
    return st;
  };

  it('a guard on the floor can walk to the route, a guard on an isolated deck cannot', () => {
    const st = st0();
    st.enemies = [guard('G-floor', 40, 0, 30), guard('G-deck', 66, 5, 49)];
    const m = new StageAnalyzer(st, quiet).guardMobility();
    expect(m.get('G-floor')).toMatchObject({ onRoute: true, onMainFloor: true, mobile: true });
    expect(m.get('G-floor')!.area).toBeGreaterThan(3500);
    // the deck is 280 m² and no waypoint lies on it
    expect(m.get('G-deck')).toMatchObject({ onRoute: false, onMainFloor: false, mobile: false });
    expect(m.get('G-deck')!.area).toBeGreaterThan(150);
    expect(m.get('G-deck')!.area).toBeLessThan(300);
  });

  it('V2 fails when too many guards are confined, or an arena has no guard on its floor', () => {
    const st = st0();
    st.enemies = [guard('G1', 62, 5, 46), guard('G2', 70, 5, 52)];
    const r = new StageAnalyzer(st, quiet).checkEnemies();
    const bad = r.problems.join('\n');
    expect(bad).toContain('guards that can walk to the route');
    expect(bad).toContain('G1 ');
    expect(bad).toContain('every combat arena has a mobile guard on its main floor');
    // one of them on the floor: the arena is covered, one of two guards is still confined
    st.enemies = [guard('G1', 40, 0, 30), guard('G2', 70, 5, 52)];
    const bad2 = new StageAnalyzer(st, quiet).checkEnemies().problems.join('\n');
    expect(bad2).not.toContain('every combat arena');
    expect(bad2).toContain('confined: G2');
  });
});

// ───────────────────────────── V14 as drawn / V15 / V16 / skips ─────────────────────────────
describe('recorded route, route defence, combat run and skipped checks (V14, V15, V16)', () => {
  // hall A (floor 0) and hall B (floor +8) joined by a doorway at +8 that barrier B1 closes; T1 opens it
  const A = bx(0, 0, 0, 30, 22, 20);
  const Bh = bx(32, 8, 0, 62, 22, 20);
  const door = bx(30, 8, 5, 32, 14, 15);
  const stage = (extra: SolidDef[] = []): StageDef => {
    const st = makeStage([...carve([A, Bh, door]), ...extra], { start: pt(5, 2, 10), exit: bx(54, 8, 0, 62, 16, 20) });
    st.sectors = [sector('S1', 'dock', bx(0, -2, -2, 31, 24, 22)), sector('S2', 'gate', bx(31, 6, -2, 64, 24, 22))];
    st.barriers = [{ id: 'B1', name: 'B1', box: door, controlEnemyId: 'T1', fromSectorId: 'S1', toSectorId: 'S2' }];
    st.enemies = [turret('T1', 'S1', 26, 0, 3, 'B1')];
    st.route = [
      { sectorId: 'S1', position: pt(5, 2, 10) },
      { sectorId: 'S1', position: pt(20, 2, 10) },
      { sectorId: 'S2', position: pt(38, 10, 10) },
      { sectorId: 'S2', position: pt(58, 10, 10) },
    ];
    return st;
  };

  it('accepts a route that can be followed as drawn and names the segments that cannot', () => {
    const ok = new StageAnalyzer(stage(), quiet).routeSegmentProblems(stage().route);
    expect(ok).toMatchObject({ level: 2, climbs: 1, drops: 0, problems: [] });
    // a crate on the first straight: the waypoints are still fine, the line between them is not
    const crate = stage([solid(bx(11, 0, 8, 14, 3, 12))]);
    const r1 = new StageAnalyzer(crate, quiet).routeSegmentProblems(crate.route);
    expect(r1.problems.length).toBe(1);
    expect(r1.problems[0]).toContain('#0');
    expect(r1.problems[0]).toContain('blocked');
    // a pit under the first straight: free sweep, no floor
    const pit = makeStage(carve([A, Bh, door, bx(10, -6, 7, 15, 0, 13)]), { start: pt(5, 2, 10), exit: bx(54, 8, 0, 62, 16, 20) });
    pit.route = stage().route;
    const r2 = new StageAnalyzer(pit, quiet).routeSegmentProblems(pit.route);
    expect(r2.problems.length).toBe(1);
    expect(r2.problems[0]).toContain('no continuous floor');
    // a climb drawn from too far back flies into the wall above the doorway … with the take-off under a beam
    const beam = stage([solid(bx(18, 6, 0, 22, 8, 20))]);
    const r3 = new StageAnalyzer(beam, quiet).routeSegmentProblems(beam.route);
    expect(r3.problems.join('\n')).toContain('climb blocked');
    // the refiner inserts the corner points around the crate
    const an = new StageAnalyzer(crate, quiet);
    const ref = an.refineRoute(crate.route);
    expect(ref.problems).toEqual([]);
    const via = ref.vias['5,2,10>20,2,10'];
    expect(via.length).toBeGreaterThanOrEqual(1);
    const fixed = [crate.route[0], ...via.map(([x, y, z]) => ({ sectorId: 'S1', position: pt(x, y, z) })), ...crate.route.slice(1)];
    expect(an.routeSegmentProblems(fixed).problems).toEqual([]);
    // and V14 reports the broken route even when the simulation is switched off
    const ck = new StageAnalyzer(crate, quiet).checkWalkthrough();
    expect(ck.status).toBe('fail');
    expect(ck.problems.join('\n')).toContain('can be followed as drawn');
  });

  it('measures the firing lines along the route', () => {
    // T1 stands in the corner of hall A and sees all of it; nothing sees hall B
    const r = new StageAnalyzer(stage(), quiet).checkRouteDefence();
    const d = r.data as { sectors: Array<{ id: string; length: number; uncovered: number; seeing: number }>; longestGap: number; coveredShare: number };
    const s2 = d.sectors.find((q) => q.id === 'S2')!;
    expect(s2.seeing).toBe(0);
    expect(s2.uncovered).toBe(s2.length);
    expect(r.problems.join('\n')).toContain('none in S2');
    expect(d.longestGap).toBeGreaterThan(20);
    // a second turret at the far end of hall B covers it
    const st = stage();
    st.enemies.push(turret('T2', 'S2', 58, 8, 3));
    const r2 = new StageAnalyzer(st, quiet).checkRouteDefence();
    expect(r2.problems.filter((q) => q.includes('firing line onto the route'))).toEqual([]);
    expect((r2.data as { longestGap: number }).longestGap).toBeLessThan(20);
    expect(r2.data.neverSeeRoute).toEqual([]);
  });

  it('the combat run destroys the control turret with real fire and reports HP', (ctx) => {
    if (!playerMovementImplemented()) {
      ctx.skip('src/sim/player.ts is still a stub — combat run not possible');
      return;
    }
    const st = stage();
    const an = new StageAnalyzer(st, {});
    const r = runWalkthrough(an, WEAKEST_LOADOUT, 300, st.route, { combat: true });
    const c = r.combat!;
    if (c.enemyShots === 0) {
      ctx.skip('src/sim/enemies.ts does not attack yet — nothing to verify');
      return;
    }
    expect(r.reason).toBe('cleared');
    expect(c.kills).toEqual(['T1']);
    expect(c.hpAtBarrier.map((b) => b.barrierId)).toEqual(['B1']);
    expect(r.controls.map((q) => q.id)).toEqual(['T1']);
    expect(c.shots.machinegun + c.shots.beam + c.shots.missile).toBeGreaterThan(0);
    expect(c.hpEnd).toBeLessThanOrEqual(1000);
    expect(c.hpEnd).toBe(1000 - c.damageTaken);
    // same seed, same run
    const again = runWalkthrough(new StageAnalyzer(st, {}), WEAKEST_LOADOUT, 300, st.route, { combat: true });
    expect(again.combat!.hpEnd).toBe(c.hpEnd);
    expect(again.seconds).toBe(r.seconds);
    // nothing is destroyed for free: a control turret the bot cannot see keeps its barrier closed
    const hidden = stage([solid(bx(22, 0, 0, 23, 22, 7)), solid(bx(23, 0, 7, 30, 22, 8))]);
    const r2 = runWalkthrough(new StageAnalyzer(hidden, {}), WEAKEST_LOADOUT, 300, hidden.route, { combat: true });
    expect(r2.ok).toBe(false);
    expect(r2.combat!.kills).toEqual([]);
  });

  it('a run with skipped checks is INCOMPLETE, never PASS', () => {
    const st = makeStage(carve([bx(0, 0, 0, 40, 10, 30)]), { start: pt(5, 2, 5), exit: bx(34, 0, 24, 40, 6, 30) });
    const done = analyzeStage(st, { only: ['V13'] });
    expect(done.result).toBe('PASS');
    expect(done.pass).toBe(true);
    const skipped = analyzeStage(st, { only: ['V13', 'V6d', 'V16'], flightSim: false });
    expect(skipped.checks.map((c) => `${c.id} ${c.status}`)).toEqual(['V6d skipped', 'V13 pass', 'V16 skipped']);
    expect(skipped.result).toBe('INCOMPLETE');
    expect(skipped.pass).toBe(false);
    expect(formatReport(skipped)).toContain('RESULT: INCOMPLETE');
    const allowed = analyzeStage(st, { only: ['V13', 'V6d', 'V16'], flightSim: false, allowSkips: true });
    expect(allowed.result).toBe('PASS');
    // a failed check wins over a skipped one
    const failed = analyzeStage(st, { only: ['V3', 'V6d'], flightSim: false });
    expect(failed.result).toBe('FAIL');
    // the probe distinguishes a moving player from a stub and from a simulation that throws
    expect(['ok', 'stub', 'error']).toContain(playerMovementStatus().state);
    expect(playerMovementImplemented()).toBe(playerMovementStatus().state === 'ok');
  });
});
