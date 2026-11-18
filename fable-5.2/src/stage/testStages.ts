/**
 * Small obstacle-free stages for isolated tests (QB / EN runs, the §4.6 firing range, the enemy
 * lethality check). They use exactly the same Sim, weapons, projectiles, AI and collision code as the
 * shipped factory stage — only the geometry and the placements differ. Never used by the game itself.
 */
import { ENEMIES, PLAYER } from '../config';
import { v3, type V3 } from '../core/vec';
import type { EnemyDef, SolidDef, StageDef } from '../sim/types';

export interface TestStageOptions {
  /** Edge length of the square floor slab centred on the origin (default 800 m). */
  floorSize?: number;
  /** Y of the floor surface (default 0). */
  floorY?: number;
  /** Extra solids. */
  solids?: SolidDef[];
  enemies?: EnemyDef[];
  /** Player hit-box centre at start (default: standing on the floor at the origin). */
  start?: V3;
  /** Player yaw at start (default 0 = looking along -Z). */
  yaw?: number;
}

/** A flat slab with one sector, no barriers and an unreachable exit. */
export function makeTestStage(opts: TestStageOptions = {}): StageDef {
  const size = opts.floorSize ?? 800;
  const y = opts.floorY ?? 0;
  const h = size / 2;
  const far = h + 500;
  return {
    id: 'test',
    name: 'isolated test stage',
    bounds: { min: v3(-far, y - 50, -far), max: v3(far, y + 400, far) },
    killY: y - 40,
    sectors: [
      {
        id: 'T00',
        name: '試験場',
        nameEn: 'Test range',
        kind: 'yard',
        bounds: [{ min: v3(-far, y - 30, -far), max: v3(far, y + 400, far) }],
      },
    ],
    solids: [{ min: v3(-h, y - 1, -h), max: v3(h, y, h), material: 'floor', tag: 'test floor' }, ...(opts.solids ?? [])],
    decor: [],
    barriers: [],
    finalGate: { id: 'GATE', name: 'test gate', box: { min: v3(far - 2, y, far - 2), max: v3(far - 1, y + 1, far - 1) } },
    exitZone: { min: v3(far - 1, y + 300, far - 1), max: v3(far, y + 301, far) },
    playerStart: { position: opts.start ?? v3(0, y + PLAYER.half.y + 0.001, 0), yaw: opts.yaw ?? 0 },
    enemies: opts.enemies ?? [],
    connections: [],
    route: [],
    flightSpots: [],
    branches: [],
    loops: [],
  };
}

/** A passive spherical firing-range target (no AI, never attacks) with optional constant velocity. */
export function makeTarget(id: string, position: V3, velocity: V3 = v3(), radius = 0.5, hp = 1e9): EnemyDef {
  return {
    id,
    kind: 'turret',
    sectorId: 'T00',
    position: { ...position },
    isGateControl: false,
    test: { radius, hp, passive: true, velocity: { ...velocity } },
  };
}

/** A real (AI-driven) guard standing on the floor at (x, z). */
export function makeGuard(id: string, x: number, z: number, floorY = 0): EnemyDef {
  return {
    id,
    kind: 'guard',
    sectorId: 'T00',
    position: v3(x, floorY + ENEMIES.guard.centerHeight, z),
    isGateControl: false,
  };
}

/** A real (AI-driven) turret standing on the floor at (x, z). */
export function makeTurret(id: string, x: number, z: number, floorY = 0): EnemyDef {
  return {
    id,
    kind: 'turret',
    sectorId: 'T00',
    position: v3(x, floorY + ENEMIES.turret.centerHeight, z),
    isGateControl: false,
  };
}
