/**
 * Mini test stage of the app harness (dev/app-test.html). Pure data: no DOM, no three.js, so Node tools can
 * build it too. It uses the same Sim / AI / weapons / collision code as the factory; only the geometry and
 * the placements differ. An end-to-end script can reach every app state on it by really playing
 * (keyboard / mouse only) in well under a minute:
 *
 *   fell       hold S: the floor ends 8 m behind the start and the mech drops below killY (−15 m).
 *   destroyed  hold A: a 16 m tunnel leads west into a yard with two guards and two turrets (real AI).
 *              They cannot see the start room or the corridor through the tunnel.
 *   cleared    six control turrets (real AI) stand in a line straight ahead, each behind the barrier the
 *              previous one opens. The low wall in front of the start hides the mech's hit-box centre from
 *              them while its gun (0.9 m to the right) and the camera (above) see past / over it, so they can
 *              be locked and destroyed from the start position. Then walk around the wall (D, then W) down
 *              the corridor, through the final gate, into the exit zone.
 *
 * Layout (top view, +X right, −Z up; floor at y = 0, walls 10 m high, no roof):
 *
 *        z=-160 ┌────────────┐
 *               │ exit zone  │   z ∈ [-158, -132]
 *        z=-125 ├═══ GATE ═══┤
 *               │  C06 … C02 │   control turret Cn at z = -21 - 17·(n-1), barrier Bn 4.5 m behind it
 *               ├════ B1 ════┤   z = -25.5
 *               │    C01     │   z = -21
 *   ┌────────┐  │▄▄▄▄▄▄      │   cover wall (3 m high) x ∈ [-8, 0.45], z = -3
 *   │  yard  ╞══╡     ◆      │   ◆ start (0, 0) looking −Z;  tunnel x ∈ [-25, -9], z ∈ [-2, 2]
 *   │G T  T G│  └── edge ────┘   z = +8, nothing beyond (fall)
 *   └────────┘
 */
import { ENEMIES, PLAYER } from '../src/config';
import type { BarrierDef, DecorDef, EnemyDef, SolidDef, SolidMaterial, StageDef } from '../src/sim/types';

const WALL_H = 10;
const CONTROL_COUNT = 6;
const controlZ = (n: number): number => -21 - 17 * (n - 1);

export function buildMiniStage(): StageDef {
  const solids: SolidDef[] = [];
  const decor: DecorDef[] = [];
  const S = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, material: SolidMaterial, sectorId: string): void => {
    solids.push({ min: { x: x0, y: y0, z: z0 }, max: { x: x1, y: y1, z: z1 }, material, sectorId });
  };
  const lamp = (x: number, z: number, sectorId: string, material: DecorDef['material'] = 'light-warm'): void => {
    decor.push({ shape: 'box', material, min: { x: x - 1.5, y: WALL_H - 0.5, z: z - 0.4 }, max: { x: x + 1.5, y: WALL_H - 0.2, z: z + 0.4 }, sectorId });
  };

  // ── floors (1 m slabs, top at y = 0) ──
  S(-9, -1, -161, 9, 0, 8, 'floor', 'M02'); // start room + corridor + exit; ends at z = +8 (drop)
  S(-25, -1, -3, -9, 0, 3, 'catwalk', 'M04'); // tunnel
  S(-96, -1, -46, -25, 0, 46, 'concrete', 'M04'); // yard

  // ── corridor walls ──
  S(8, 0, -161, 9, WALL_H, 8, 'wall', 'M02'); // east
  S(-9, 0, -161, -8, WALL_H, -2, 'wall', 'M02'); // west, north of the tunnel door
  S(-9, 0, 2, -8, WALL_H, 8, 'wall', 'M01'); // west, south of the tunnel door
  S(-9, 0, -161, 9, WALL_H, -160, 'wall', 'M03'); // north end
  // ── cover wall in front of the start (hides the hit-box centre, not the gun) ──
  S(-8, 0, -3.5, 0.45, 3, -2.5, 'hazard', 'M01');
  // ── tunnel walls ──
  S(-25, 0, -3, -9, WALL_H, -2, 'rust', 'M04');
  S(-25, 0, 2, -9, WALL_H, 3, 'rust', 'M04');
  // ── yard walls ──
  S(-25, 0, -46, -24, WALL_H, -2, 'wall', 'M04');
  S(-25, 0, 2, -24, WALL_H, 46, 'wall', 'M04');
  S(-96, 0, -46, -95, WALL_H, 46, 'wall', 'M04');
  S(-95, 0, -46, -25, WALL_H, -45, 'wall', 'M04');
  S(-95, 0, 45, -25, WALL_H, 46, 'wall', 'M04');
  // a little cover in the yard (does not hide the guards from the tunnel mouth)
  S(-48, 0, -1.5, -45, 2.6, 1.5, 'container', 'M04');

  // ── lamps ──
  lamp(0, 2, 'M01');
  for (let z = -15; z > -160; z -= 24) lamp(0, z, 'M02');
  lamp(-17, 0, 'M04', 'light-amber');
  for (const x of [-45, -75]) for (const z of [-25, 25]) lamp(x, z, 'M04');

  // ── control turrets + barriers ──
  const enemies: EnemyDef[] = [];
  const barriers: BarrierDef[] = [];
  for (let n = 1; n <= CONTROL_COUNT; n++) {
    const z = controlZ(n);
    const zb = z - 4.5;
    enemies.push({
      id: 'C0' + n,
      kind: 'turret',
      sectorId: 'M02',
      position: { x: 0, y: ENEMIES.turret.centerHeight, z },
      yaw: Math.PI,
      isGateControl: true,
      barrierId: 'B' + n,
    });
    barriers.push({
      id: 'B' + n,
      name: '隔壁 B' + n,
      box: { min: { x: -8, y: 0, z: zb - 0.5 }, max: { x: 8, y: WALL_H, z: zb + 0.5 } },
      controlEnemyId: 'C0' + n,
      fromSectorId: 'M02',
      toSectorId: n === CONTROL_COUNT ? 'M03' : 'M02',
    });
  }
  // ── hostile yard: two guards and two turrets, 35–45 m from the tunnel mouth ──
  enemies.push(
    { id: 'G01', kind: 'guard', sectorId: 'M04', position: { x: -60, y: ENEMIES.guard.centerHeight, z: 25 }, isGateControl: false },
    { id: 'G02', kind: 'guard', sectorId: 'M04', position: { x: -60, y: ENEMIES.guard.centerHeight, z: -25 }, isGateControl: false },
    { id: 'T01', kind: 'turret', sectorId: 'M04', position: { x: -68, y: ENEMIES.turret.centerHeight, z: 20 }, isGateControl: false },
    { id: 'T02', kind: 'turret', sectorId: 'M04', position: { x: -68, y: ENEMIES.turret.centerHeight, z: -20 }, isGateControl: false },
  );

  const sectorBox = (x0: number, z0: number, x1: number, z1: number) => ({ min: { x: x0, y: -20, z: z0 }, max: { x: x1, y: 60, z: z1 } });
  return {
    id: 'app-test',
    name: 'アプリ試験用ミニステージ',
    bounds: { min: { x: -100, y: -30, z: -165 }, max: { x: 15, y: 60, z: 20 } },
    killY: -15,
    sectors: [
      { id: 'M01', name: '始動区画', nameEn: 'Start room', kind: 'dock', bounds: [sectorBox(-9, -3, 9, 14)] },
      { id: 'M02', name: '隔壁通路', nameEn: 'Barrier corridor', kind: 'corridor', bounds: [sectorBox(-9, -126, 9, -3)] },
      { id: 'M03', name: '搬出口', nameEn: 'Exit', kind: 'gate', bounds: [sectorBox(-9, -161, 9, -126)] },
      { id: 'M04', name: '警備ヤード', nameEn: 'Guard yard', kind: 'yard', bounds: [sectorBox(-96, -46, -9, 46)] },
    ],
    solids,
    decor,
    barriers,
    finalGate: { id: 'GATE', name: '最終搬出ゲート', box: { min: { x: -8, y: 0, z: -125.5 }, max: { x: 8, y: WALL_H, z: -124.5 } } },
    exitZone: { min: { x: -8, y: 0, z: -158 }, max: { x: 8, y: WALL_H, z: -132 } },
    playerStart: { position: { x: 0, y: PLAYER.half.y + 0.001, z: 0 }, yaw: 0 },
    enemies,
    connections: [
      { a: 'M01', b: 'M02', kind: 'open' },
      { a: 'M01', b: 'M04', kind: 'door' },
      { a: 'M02', b: 'M03', kind: 'gate' },
    ],
    route: [
      { sectorId: 'M01', position: { x: 4, y: 2, z: 0 } },
      { sectorId: 'M02', position: { x: 4, y: 2, z: -60 } },
      { sectorId: 'M03', position: { x: 4, y: 2, z: -140 } },
    ],
    flightSpots: [],
    branches: [],
    loops: [],
  };
}
