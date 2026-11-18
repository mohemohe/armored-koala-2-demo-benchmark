/**
 * Obstacle-free arenas for movement / ballistics tests and scenarios (SPEC §4.6: "遮蔽物のない試験環境").
 * The campaign stage lives in src/stage. Nothing here weakens the real AI, weapons or hit detection.
 */
import { Game } from './game';
import type { GameOptions } from './game';
import type { BoxDef, Loadout, StageDef, V3 } from './types';

export interface ArenaOptions {
  /** platforms the player may stand on: top-surface center + size (x,z) */
  platforms?: { id: string; top: V3; sizeX: number; sizeZ: number }[];
  /** flat floor half-size (m) at y=0; set 0 for no floor */
  floorHalf?: number;
  start?: { pos: V3; yaw: number };
}

export function buildTestArenaStage(opts: ArenaOptions = {}): StageDef {
  const floorHalf = opts.floorHalf ?? 600;
  const boxes: BoxDef[] = [];
  if (floorHalf > 0) {
    boxes.push({
      id: 'arena-floor',
      min: { x: -floorHalf, y: -2, z: -floorHalf },
      max: { x: floorHalf, y: 0, z: floorHalf },
      mat: 'concrete',
      sectorId: 'T00',
    });
  }
  for (const p of opts.platforms ?? []) {
    boxes.push({
      id: p.id,
      min: { x: p.top.x - p.sizeX / 2, y: p.top.y - 2, z: p.top.z - p.sizeZ / 2 },
      max: { x: p.top.x + p.sizeX / 2, y: p.top.y, z: p.top.z + p.sizeZ / 2 },
      mat: 'metal',
      sectorId: 'T00',
    });
  }
  const start = opts.start ?? { pos: { x: 0, y: 1.5, z: 0 }, yaw: 0 };
  return {
    name: 'test-arena',
    boxes,
    sectors: [
      {
        id: 'T00',
        name: 'Test arena',
        kind: 'yard',
        bounds: { min: { x: -2000, y: -200, z: -2000 }, max: { x: 2000, y: 400, z: 2000 } },
        floorY: 0,
        ceilingY: 400,
        combat: false,
        note: 'test only',
      },
    ],
    portals: [],
    barriers: [],
    enemies: [],
    playerStart: start,
    escapeZone: { min: { x: 1e6, y: 1e6, z: 1e6 }, max: { x: 1e6 + 1, y: 1e6 + 1, z: 1e6 + 1 } },
    mainRoute: { id: 'test', kind: 'main', note: 'test', points: [], sectorIds: ['T00'] },
    branches: [],
    loops: [],
    climbs: [],
    killY: -500,
  };
}

/** Game on a flat arena, already sortied (mode 'playing'). */
export function createArenaGame(loadout?: Loadout, arena: ArenaOptions = {}, extra: Partial<GameOptions> = {}): Game {
  const game = new Game({ stage: buildTestArenaStage(arena), loadout, ...extra });
  game.sortie(loadout);
  return game;
}
