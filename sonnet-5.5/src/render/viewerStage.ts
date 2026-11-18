/**
 * Dev-only stages for the render viewer (viewer.html). NOT used by the game itself.
 *  - buildDemoStage(): a factory hall with the props every material / shape needs to be judged by eye
 *  - buildStressStage(): thousands of boxes over a large area to measure draw calls / triangles
 */
import { mulberry32 } from './geo';
import type { BoxDef, EnemySpawn, MaterialKey, StageDef } from '../sim/types';

interface Builder {
  boxes: BoxDef[];
  decor: BoxDef[];
  add(id: string, min: [number, number, number], max: [number, number, number], mat: MaterialKey, extra?: Partial<BoxDef>): void;
  dec(id: string, min: [number, number, number], max: [number, number, number], mat: MaterialKey, extra?: Partial<BoxDef>): void;
}

function builder(): Builder {
  const boxes: BoxDef[] = [];
  const decor: BoxDef[] = [];
  const mk = (id: string, min: [number, number, number], max: [number, number, number], mat: MaterialKey, extra: Partial<BoxDef>): BoxDef => ({
    id,
    min: { x: min[0], y: min[1], z: min[2] },
    max: { x: max[0], y: max[1], z: max[2] },
    mat,
    sectorId: 'S01',
    ...extra,
  });
  return {
    boxes,
    decor,
    add: (id, min, max, mat, extra = {}) => void boxes.push(mk(id, min, max, mat, extra)),
    dec: (id, min, max, mat, extra = {}) => void decor.push(mk(id, min, max, mat, extra)),
  };
}

export function buildDemoStage(): StageDef {
  const b = builder();
  const rnd = mulberry32(7);
  // floor slabs: mixed materials
  b.add('floor', [-70, -2, -70], [70, 0, 70], 'concrete');
  b.add('tile', [-24, 0, 6], [24, 0.06, 40], 'floorTile');
  b.add('lane1', [-3, 0, -66], [3, 0.05, 30], 'hazard');
  b.add('grate1', [26, 0, -30], [46, 0.1, -6], 'grating');
  b.add('rustpad', [-46, 0, -20], [-26, 0.08, 0], 'rust');
  // walls + ceiling
  b.add('wallN', [-72, 0, -72], [72, 24, -70], 'concreteDark');
  b.add('wallS', [-72, 0, 70], [72, 24, 72], 'concrete');
  b.add('wallW', [-72, 0, -70], [-70, 24, 70], 'concrete');
  b.add('wallE', [70, 0, -70], [72, 24, 70], 'metal');
  b.add('roof', [-72, 24, -72], [72, 26, 72], 'roof');
  // a divider wall with a barrier opening (z ~ -40)
  b.add('divL', [-70, 0, -42], [-9, 24, -38], 'concreteDark');
  b.add('divR', [9, 0, -42], [70, 24, -38], 'concreteDark');
  b.add('divTop', [-9, 15, -42], [9, 24, -38], 'concreteDark');
  b.add('B1a', [-9, 0, -41], [9, 15, -39], 'barrier', { barrierId: 'B1', emissive: 0.6 });
  b.add('B1frame', [-9.6, 0, -42.2], [-9, 15.4, -37.8], 'hazard');
  b.add('B1frameR', [9, 0, -42.2], [9.6, 15.4, -37.8], 'hazard');
  // gate at the far east
  b.add('gateWall', [50, 0, 20], [70, 24, 22], 'concrete');
  b.add('GATE1', [52, 0, 20], [68, 12, 22], 'gate', { barrierId: 'GATE', emissive: 0.4 });
  // columns and beams
  for (const x of [-48, -24, 24, 48]) for (const z of [-20, 20]) {
    b.add(`col${x}_${z}`, [x - 1.6, 0, z - 1.6], [x + 1.6, 24, z + 1.6], 'concrete');
    b.add(`colbase${x}_${z}`, [x - 2, 0, z - 2], [x + 2, 1.2, z + 2], 'hazard');
  }
  for (let x = -60; x <= 60; x += 20) b.add(`beam${x}`, [x - 0.5, 20, -70], [x + 0.5, 22, 70], 'metalDark');
  for (let z = -60; z <= 60; z += 20) b.add(`girder${z}`, [-70, 21.4, z - 0.6], [70, 22.6, z + 0.6], 'metal');
  // hanging light panels
  for (let x = -50; x <= 50; x += 25) for (let z = -50; z <= 50; z += 25) b.add(`lp${x}_${z}`, [x - 3, 19, z - 1.2], [x + 3, 19.4, z + 1.2], 'lightPanel', { emissive: 1 });
  // raised catwalk platform (grating) with rails
  b.add('cat', [-66, 5.6, 44], [66, 6, 52], 'grating');
  b.add('catRailA', [-66, 6, 44], [66, 7.2, 44.25], 'metalDark');
  b.add('catRailB', [-66, 6, 51.75], [66, 7.2, 52], 'metalDark');
  b.add('catSupport1', [-40, 0, 46], [-38, 5.6, 50], 'metal');
  b.add('catSupport2', [0, 0, 46], [2, 5.6, 50], 'metal');
  b.add('catSupport3', [40, 0, 46], [42, 5.6, 50], 'metal');
  // stairs-like platform blocks (cover)
  for (let i = 0; i < 5; i++) b.add(`step${i}`, [-56 + i * 4, 0, 30], [-52 + i * 4, 1 + i * 1.1, 40], i % 2 ? 'metal' : 'metalDark');
  // machines + tanks + pipes
  b.add('mach1', [-44, 0, -60], [-30, 7, -50], 'machine', { emissive: 0.3 });
  b.add('mach2', [-28, 0, -62], [-14, 5, -54], 'machine');
  b.add('mach3', [14, 0, -62], [30, 9, -50], 'machine', { emissive: 0.25 });
  b.add('tank1', [36, 0, -66], [46, 14, -56], 'metal', { shape: 'cylY' });
  b.add('tank2', [48, 0, -66], [58, 12, -56], 'rust', { shape: 'cylY' });
  b.add('pipeA', [-70, 9, -30], [-12, 10.6, -28.4], 'pipe', { shape: 'cylX' });
  b.add('pipeB', [-12, 9, -66], [-10.4, 10.6, -30], 'pipe', { shape: 'cylZ' });
  b.add('pipeC', [-70, 12, -20], [70, 13.2, -18.8], 'pipe', { shape: 'cylX' });
  b.add('pipeD', [60, 0, 0], [62, 18, 2], 'pipe', { shape: 'cylY' });
  b.add('pipeE', [-70, 14.5, 10], [70, 15.5, 11], 'pipe', { shape: 'cylX' });
  // crates
  for (let i = 0; i < 18; i++) {
    const x = -55 + rnd() * 110;
    const z = 12 + rnd() * 26;
    const w = 3 + rnd() * 3;
    const h = 2.5 + rnd() * 2.5;
    const d = 5 + rnd() * 4;
    if (Math.abs(x) < 6) continue;
    b.add(`crate${i}`, [x - w, 0, z - d / 2], [x + w, h, z + d / 2], 'crate');
    if (rnd() < 0.5) b.add(`crateTop${i}`, [x - w * 0.8, h, z - d * 0.4], [x + w * 0.8, h + h * 0.8, z + d * 0.4], 'crate');
  }
  // glass control room
  b.add('cr_base', [36, 0, 30], [56, 4, 48], 'metalDark');
  b.add('cr_glass', [36, 4, 30], [56, 9, 31], 'glass');
  b.add('cr_roof', [36, 9, 30], [56, 10, 48], 'metal');
  // decor: signs, cable trays, small lamps (no collision)
  b.dec('signA', [-9.4, 8, -37.7], [9.4, 12, -37.6], 'hazard');
  b.dec('signB', [-69.9, 6, -10], [-69.7, 9, 10], 'hazard');
  for (let x = -64; x <= 64; x += 16) b.dec(`lamp${x}`, [x - 0.3, 17, -69.8], [x + 0.3, 18, -69.4], 'lightPanel', { emissive: 1 });
  for (let z = -60; z <= 60; z += 24) b.dec(`tray${z}`, [69.2, 8, z - 6], [69.9, 8.5, z + 6], 'metalDark');

  const enemies: EnemySpawn[] = [];
  const g = (i: number, x: number, z: number, yaw: number): void =>
    void enemies.push({ id: `G${String(i).padStart(2, '0')}`, kind: 'guard', sectorId: 'S01', pos: { x, y: 1.5, z }, yaw, isGateControl: false, controlIndex: null, barrierId: null });
  g(1, -10, -10, 0);
  g(2, 6, -14, 0.4);
  g(3, 18, 4, -2.2);
  g(4, -24, 10, 1.4);
  g(5, 34, -24, 3.1);
  g(6, -36, 24, -0.6);
  enemies.push({ id: 'T01', kind: 'turret', sectorId: 'S01', pos: { x: -20, y: 1.6, z: -34 }, yaw: 0, isGateControl: true, controlIndex: 0, barrierId: 'B1' });
  enemies.push({ id: 'T02', kind: 'turret', sectorId: 'S01', pos: { x: 22, y: 1.6, z: -34 }, yaw: 0.3, isGateControl: false, controlIndex: null, barrierId: null });

  return {
    name: 'viewer-demo',
    boxes: b.boxes,
    decor: b.decor,
    sectors: [
      { id: 'S01', name: 'デモ区画A', kind: 'factory', bounds: { min: { x: -72, y: -2, z: -37 }, max: { x: 72, y: 26, z: 72 } }, floorY: 0, ceilingY: 24, combat: true, note: 'viewer' },
      { id: 'S02', name: 'デモ区画B', kind: 'corridor', bounds: { min: { x: -72, y: -2, z: -72 }, max: { x: 72, y: 26, z: -43 } }, floorY: 0, ceilingY: 24, combat: false, note: 'viewer' },
    ],
    portals: [{ id: 'P1', a: 'S01', b: 'S02', center: { x: 0, y: 7.5, z: -40 }, width: 18, height: 15, kind: 'door', barrierId: 'B1' }],
    barriers: [
      { id: 'B1', boxIds: ['B1a'], controlEnemyId: 'T01', isFinal: false, label: 'デモ隔壁', pos: { x: 0, y: 7.5, z: -40 } },
      { id: 'GATE', boxIds: ['GATE1'], controlEnemyId: null, isFinal: true, label: '搬出ゲート', pos: { x: 60, y: 6, z: 21 } },
    ],
    enemies,
    playerStart: { pos: { x: 0, y: 1.5, z: 40 }, yaw: 0 },
    escapeZone: { min: { x: 52, y: 0, z: 22 }, max: { x: 68, y: 12, z: 40 } },
    mainRoute: { id: 'main', kind: 'main', note: '', points: [], sectorIds: ['S01', 'S02'] },
    branches: [],
    loops: [],
    climbs: [],
    killY: -80,
  };
}

/** thousands of boxes: worst case for the chunk merger / culling */
export function buildStressStage(count = 4000): StageDef {
  const base = buildDemoStage();
  const rnd = mulberry32(99);
  const mats: MaterialKey[] = ['concrete', 'concreteDark', 'metal', 'metalDark', 'rust', 'hazard', 'grating', 'pipe', 'crate', 'machine', 'floorTile', 'lightPanel'];
  const boxes: BoxDef[] = [...base.boxes];
  boxes.push({ id: 'bigfloor', min: { x: -400, y: -2, z: -400 }, max: { x: 400, y: 0, z: 400 }, mat: 'concrete', sectorId: 'S01' });
  for (let i = 0; i < count; i++) {
    const x = -380 + rnd() * 760;
    const z = -380 + rnd() * 760;
    const w = 1 + rnd() * 8;
    const d = 1 + rnd() * 8;
    const h = 1 + rnd() * 14;
    const y = rnd() < 0.3 ? rnd() * 14 : 0;
    const mat = mats[Math.floor(rnd() * mats.length)];
    const shape = rnd() < 0.12 ? (['cylX', 'cylY', 'cylZ'] as const)[Math.floor(rnd() * 3)] : undefined;
    boxes.push({ id: `r${i}`, min: { x, y, z }, max: { x: x + w, y: y + h, z: z + d }, mat, sectorId: 'S01', shape, emissive: mat === 'lightPanel' ? 1 : undefined });
  }
  return { ...base, name: 'viewer-stress', boxes };
}
