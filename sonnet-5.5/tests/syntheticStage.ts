/**
 * Small synthetic stage used ONLY to test the stage validator (tests/stage-validator.test.ts).
 * It is a deliberately simple but real box stage: a chain of rooms with wall openings, a few side rooms that
 * create cycles, high wall openings that need flight, barriers with control turrets, a final gate.
 * (Not the campaign stage: that one lives in src/stage.)
 */
import type {
  BarrierDef,
  BoxDef,
  BranchDef,
  ClimbDef,
  EnemySpawn,
  MaterialKey,
  PortalDef,
  RouteDef,
  SectorDef,
  SectorKind,
  StageDef,
  V3,
} from '../src/sim/types';

export interface SynthOptions {
  /** number of chain sectors (default 16) */
  chain?: number;
  /** sector length along x (default 110) */
  len?: number;
  /** chain indices `a` where a side room spans chain sectors a and a+1 (default [3, 7, 11]) */
  cycles?: number[];
  /** height of the high wall openings / ledges (default 12) */
  climbHeight?: number;
  /** number of high transitions (default 6) */
  climbCount?: number;
}

const ROOM_H = 32; // ceiling underside
const WALL = 2;
const DEPTH = 90;
const SIDE_DEPTH = 90;
const OPEN_W = 8;
const OPEN_H = 7;

const pad = (n: number): string => String(n).padStart(2, '0');
const v = (x: number, y: number, z: number): V3 => ({ x, y, z });

const KINDS: SectorKind[] = ['dock', 'yard', 'factory', 'multilevel', 'corridor', 'shaft', 'warehouse', 'pipe', 'yard', 'factory', 'warehouse', 'pipe', 'multilevel', 'factory', 'yard', 'gate'];
const KIND_JA: Record<SectorKind, string> = {
  dock: '搬入口',
  yard: '広場',
  factory: '製造室',
  multilevel: '上下層',
  corridor: '連絡路',
  shaft: '縦坑',
  warehouse: '倉庫',
  pipe: '配管区画',
  gate: '搬出ゲート',
};

interface Hole {
  center: number;
  width: number;
  bottom: number;
  top: number;
}

/** a wall slab split around its holes */
function wall(
  out: BoxDef[],
  prefix: string,
  sectorId: string,
  axis: 'x' | 'z',
  a0: number,
  a1: number,
  c0: number,
  c1: number,
  y0: number,
  y1: number,
  holes: Hole[],
  mat: MaterialKey = 'concrete',
): void {
  const mk = (id: string, s0: number, s1: number, yy0: number, yy1: number): void => {
    if (s1 - s0 < 1e-6 || yy1 - yy0 < 1e-6) return;
    const min = axis === 'x' ? v(s0, yy0, c0) : v(c0, yy0, s0);
    const max = axis === 'x' ? v(s1, yy1, c1) : v(c1, yy1, s1);
    out.push({ id, min, max, mat, sectorId });
  };
  const sorted = [...holes].sort((p, q) => p.center - q.center);
  let cursor = a0;
  let n = 0;
  for (const h of sorted) {
    const hs = h.center - h.width / 2;
    const he = h.center + h.width / 2;
    mk(`${prefix}-${n++}`, cursor, hs, y0, y1);
    mk(`${prefix}-${n++}`, hs, he, y0, h.bottom);
    mk(`${prefix}-${n++}`, hs, he, h.top, y1);
    cursor = he;
  }
  mk(`${prefix}-${n++}`, cursor, a1, y0, y1);
}

export function buildSyntheticStage(opts: SynthOptions = {}): StageDef {
  const chain = opts.chain ?? 16;
  const L = opts.len ?? 110;
  const cycles = opts.cycles ?? [3, 7, 11];
  const CH = opts.climbHeight ?? 12;
  const climbCount = opts.climbCount ?? 6;

  const boxes: BoxDef[] = [];
  const sectors: SectorDef[] = [];
  const portals: PortalDef[] = [];
  const barriers: BarrierDef[] = [];
  const enemies: EnemySpawn[] = [];
  const climbs: ClimbDef[] = [];

  const sid = (i: number): string => `S${pad(i + 1)}`;
  const sideId = (j: number): string => `S${pad(chain + j + 1)}`;
  const zT = (i: number): number => (i % 2 === 0 ? 14 : 76);
  const isHigh = (i: number): boolean => i % 2 === 0 && i / 2 < climbCount;
  const holeY = (i: number): [number, number] => (isHigh(i) ? [CH, CH + OPEN_H] : [0, OPEN_H]);
  const barrierAt = new Map<number, string>();
  for (let k = 0; k < 6; k++) barrierAt.set(2 * (k + 1), `B${k + 1}`);
  barrierAt.set(chain - 2, 'GATE');

  // ---- chain sectors
  for (let i = 0; i < chain; i++) {
    const x0 = i * L;
    const x1 = x0 + L;
    const id = sid(i);
    const kind: SectorKind = i === chain - 1 ? 'gate' : KINDS[i % (KINDS.length - 1)];
    const combat = [2, 4, 5, 7, 9, 11].includes(i);
    sectors.push({
      id,
      name: `${KIND_JA[kind]}${pad(i + 1)}`,
      kind,
      bounds: { min: v(x0, -2, 0), max: v(x1, ROOM_H + 2, DEPTH) },
      floorY: 0,
      ceilingY: ROOM_H,
      combat,
      note: `synthetic chain sector ${i}`,
    });
    boxes.push({ id: `${id}-floor`, min: v(x0, -2, 0), max: v(x1, 0, DEPTH), mat: 'floorTile', sectorId: id });
    boxes.push({ id: `${id}-ceil`, min: v(x0, ROOM_H, 0), max: v(x1, ROOM_H + 2, DEPTH), mat: 'roof', sectorId: id });
    const westHoles: Hole[] = [];
    if (i > 0) {
      const [b, t] = holeY(i - 1);
      westHoles.push({ center: zT(i - 1), width: OPEN_W, bottom: b, top: t });
    }
    const eastHoles: Hole[] = [];
    if (i < chain - 1) {
      const [b, t] = holeY(i);
      eastHoles.push({ center: zT(i), width: OPEN_W, bottom: b, top: t });
    }
    wall(boxes, `${id}-w`, id, 'z', 0, DEPTH, x0, x0 + WALL, 0, ROOM_H, westHoles);
    wall(boxes, `${id}-e`, id, 'z', 0, DEPTH, x1 - WALL, x1, 0, ROOM_H, eastHoles);
    wall(boxes, `${id}-s`, id, 'x', x0, x1, 0, WALL, 0, ROOM_H, []);
    const northHoles: Hole[] = [];
    cycles.forEach((a) => {
      if (i === a) northHoles.push({ center: a * L + 55, width: OPEN_W, bottom: 0, top: OPEN_H });
      if (i === a + 1) northHoles.push({ center: (a + 1) * L + 55, width: OPEN_W, bottom: 0, top: OPEN_H });
    });
    wall(boxes, `${id}-n`, id, 'x', x0, x1, DEPTH - WALL, DEPTH, 0, ROOM_H, northHoles);
    // low crates by the side walls (cover); keeps the middle of the room open
    for (const zc of [11, 79]) {
      boxes.push({ id: `${id}-crate-${zc}`, min: v(x0 + 30, 0, zc - 5), max: v(x0 + 40, 5, zc + 5), mat: 'crate', sectorId: id });
    }
    // ledge (landing platform) behind every high opening
    if (i > 0 && isHigh(i - 1)) {
      const xb = x0;
      boxes.push({ id: `${id}-ledge`, min: v(xb + WALL, CH - 2, zT(i - 1) - 9), max: v(xb + 18, CH, zT(i - 1) + 9), mat: 'metal', sectorId: id });
    }
    // mezzanine (third altitude band)
    if (i === 3) {
      boxes.push({ id: `${id}-mezz`, min: v(x0 + 40, 22, 30), max: v(x0 + 70, 24, 60), mat: 'grating', sectorId: id });
    }
  }

  // ---- side rooms (create cycles)
  cycles.forEach((a, j) => {
    const id = sideId(j);
    const x0 = a * L;
    const x1 = (a + 2) * L;
    const z0 = DEPTH;
    const z1 = DEPTH + SIDE_DEPTH;
    const kind: SectorKind = (['corridor', 'pipe', 'warehouse'] as SectorKind[])[j % 3];
    sectors.push({
      id,
      name: `${KIND_JA[kind]}側室${pad(j + 1)}`,
      kind,
      bounds: { min: v(x0, -2, z0), max: v(x1, ROOM_H + 2, z1) },
      floorY: 0,
      ceilingY: ROOM_H,
      combat: false,
      note: `synthetic side room ${j}`,
    });
    boxes.push({ id: `${id}-floor`, min: v(x0, -2, z0), max: v(x1, 0, z1), mat: 'floorTile', sectorId: id });
    boxes.push({ id: `${id}-ceil`, min: v(x0, ROOM_H, z0), max: v(x1, ROOM_H + 2, z1), mat: 'roof', sectorId: id });
    wall(boxes, `${id}-w`, id, 'z', z0, z1, x0, x0 + WALL, 0, ROOM_H, []);
    wall(boxes, `${id}-e`, id, 'z', z0, z1, x1 - WALL, x1, 0, ROOM_H, []);
    wall(boxes, `${id}-n`, id, 'x', x0, x1, z1 - WALL, z1, 0, ROOM_H, []);
    wall(boxes, `${id}-s`, id, 'x', x0, x1, z0, z0 + WALL, 0, ROOM_H, [
      { center: a * L + 55, width: OPEN_W, bottom: 0, top: OPEN_H },
      { center: (a + 1) * L + 55, width: OPEN_W, bottom: 0, top: OPEN_H },
    ]);
    portals.push({ id: `PX${j}a`, a: sid(a), b: id, center: v(a * L + 55, OPEN_H / 2, DEPTH), width: OPEN_W, height: OPEN_H, kind: 'door', barrierId: null });
    portals.push({ id: `PX${j}b`, a: sid(a + 1), b: id, center: v((a + 1) * L + 55, OPEN_H / 2, DEPTH), width: OPEN_W, height: OPEN_H, kind: 'door', barrierId: null });
  });

  // ---- chain portals, barriers, climbs
  for (let i = 0; i < chain - 1; i++) {
    const x1 = (i + 1) * L;
    const [b, t] = holeY(i);
    const barrierId = barrierAt.get(i) ?? null;
    portals.push({
      id: `P${i}`,
      a: sid(i),
      b: sid(i + 1),
      center: v(x1, (b + t) / 2, zT(i)),
      width: OPEN_W,
      height: OPEN_H,
      kind: isHigh(i) ? 'tunnel' : 'door',
      barrierId,
    });
    if (barrierId) {
      const isGate = barrierId === 'GATE';
      boxes.push({
        id: `${barrierId}-box`,
        min: v(x1 - 1, b, zT(i) - OPEN_W / 2),
        max: v(x1 + 1, t, zT(i) + OPEN_W / 2),
        mat: isGate ? 'gate' : 'barrier',
        sectorId: sid(i),
        barrierId,
      });
    }
    if (isHigh(i)) {
      const k = climbs.length + 1;
      climbs.push({
        id: `C${k}`,
        sectorId: sid(i),
        from: v(x1 - 6, 0, zT(i)),
        to: v(x1 + 10, CH, zT(i)),
        heightMeters: CH,
        note: `synthetic climb ${k}`,
      });
    }
  }

  // ---- enemies: one turret per sector 1..15 (first slot) + guards, 45 in total
  const counts = [0, 1, 5, 2, 5, 5, 2, 5, 2, 5, 2, 5, 2, 2, 1, 1];
  let g = 0;
  let tcount = 0;
  const slots: [number, number][] = [
    [64, 20],
    [80, 46],
    [96, 20],
    [64, 72],
    [96, 72],
  ];
  const controlSector = new Map<number, number>();
  for (let k = 0; k < 6; k++) controlSector.set(2 * k + 1, k);
  const barrierControl = new Map<string, string>();
  for (let i = 0; i < Math.min(chain, counts.length); i++) {
    for (let e = 0; e < counts[i]; e++) {
      const [dx, z] = slots[e];
      const x = i * L + dx;
      if (e === 0) {
        tcount++;
        const ctl = controlSector.get(i);
        const id = `T${pad(tcount)}`;
        enemies.push({
          id,
          kind: 'turret',
          sectorId: sid(i),
          pos: v(x, 1.6, z),
          yaw: Math.PI / 2,
          isGateControl: ctl !== undefined,
          controlIndex: ctl ?? null,
          barrierId: ctl !== undefined ? `B${ctl + 1}` : null,
        });
        if (ctl !== undefined) barrierControl.set(`B${ctl + 1}`, id);
      } else {
        g++;
        enemies.push({
          id: `G${pad(g)}`,
          kind: 'guard',
          sectorId: sid(i),
          pos: v(x, 1.5, z),
          yaw: Math.PI / 2,
          isGateControl: false,
          controlIndex: null,
          barrierId: null,
        });
      }
    }
  }

  // ---- barrier defs
  for (const [i, bid] of barrierAt) {
    if (i >= chain - 1) continue;
    const x1 = (i + 1) * L;
    const [bb, tt] = holeY(i);
    barriers.push({
      id: bid,
      boxIds: [`${bid}-box`],
      controlEnemyId: bid === 'GATE' ? null : barrierControl.get(bid) ?? null,
      isFinal: bid === 'GATE',
      label: bid === 'GATE' ? '最終搬出ゲート' : `${bid} 隔壁`,
      pos: v(x1, (bb + tt) / 2, zT(i)),
    });
  }
  barriers.sort((p, q) => (p.id === 'GATE' ? 1 : q.id === 'GATE' ? -1 : p.id.localeCompare(q.id)));

  // ---- routes
  const mainPts: V3[] = [v(12, 1.5, 30)];
  for (let i = 0; i < chain - 1; i++) {
    const [b, t] = holeY(i);
    mainPts.push(v((i + 1) * L, (b + t) / 2 + (isHigh(i) ? 0.5 : 0), zT(i)));
  }
  const escapeX0 = (chain - 1) * L;
  mainPts.push(v(escapeX0 + 92, 3, 46));
  const mainRoute: RouteDef = { id: 'main', kind: 'main', note: 'synthetic main route', points: mainPts, sectorIds: sectors.slice(0, chain).map((s) => s.id) };

  const len = (pts: V3[]): number => {
    let l = 0;
    for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y, pts[i].z - pts[i - 1].z);
    return l;
  };
  const branches: BranchDef[] = [];
  const loops: RouteDef[] = [];
  cycles.forEach((a, j) => {
    const p0 = v(a * L + 55, 1.5, 45);
    const p1 = v((a + 1) * L + 55, 1.5, 45);
    const [, tHigh] = holeY(a);
    const direct = [p0, v((a + 1) * L, isHigh(a) ? tHigh - 3.5 : 3.5, zT(a)), p1];
    const around = [
      p0,
      v(a * L + 55, 3.5, DEPTH),
      v(a * L + 55, 1.5, DEPTH + 20),
      v((a + 1) * L + 55, 1.5, DEPTH + 20),
      v((a + 1) * L + 55, 3.5, DEPTH),
      p1,
    ];
    branches.push({
      id: `BR${j + 1}`,
      splitSectorId: sid(a),
      mergeSectorId: sid(a + 1),
      routes: [
        { id: `BR${j + 1}-direct`, note: '直進', sectorIds: [sid(a), sid(a + 1)], points: direct, lengthMeters: len(direct) },
        { id: `BR${j + 1}-around`, note: '側室経由', sectorIds: [sid(a), sideId(j), sid(a + 1)], points: around, lengthMeters: len(around) },
      ],
    });
    if (j < 3) {
      loops.push({
        id: `LOOP${j + 1}`,
        kind: 'loop',
        note: '側室を回る環状',
        points: [...direct, ...[...around].reverse().slice(1)],
        sectorIds: [sid(a), sid(a + 1), sideId(j)],
      });
    }
  });

  const stage: StageDef = {
    name: 'synthetic-validator-stage',
    boxes,
    sectors,
    portals,
    barriers,
    enemies,
    playerStart: { pos: v(12, 1.5, 30), yaw: -Math.PI / 2 },
    escapeZone: { min: v(escapeX0 + 80, 0.2, 4), max: v(escapeX0 + 104, 8, 86) },
    mainRoute,
    branches,
    loops,
    climbs,
    killY: -50,
  };
  return stage;
}

/** deep copy so that a test can mutate the stage freely */
export function cloneStage(stage: StageDef): StageDef {
  return JSON.parse(JSON.stringify(stage)) as StageDef;
}
