/**
 * 試験用の小さなステージ（射撃試験場・敵AI試験場）。
 * 本編の照準・弾体・命中処理をそのまま使うため、StageData だけを差し替える。
 */
import { PLAYER } from '../../src/params';
import type { AABB, EnemyDef, SolidDef, StageData, Vec3 } from '../../src/types';
import { rotateY, sub } from '../../src/sim/vec';

export interface RangeTarget {
  id: string;
  /** 当たり判定中心（kind='target' は centerOffset が 0 なので足元位置＝中心） */
  center: Vec3;
  velocity: Vec3;
}

export interface RangeStageOptions {
  /** プレイヤーの銃口位置（既定 (0,20,0)） */
  muzzle?: Vec3;
  /** プレイヤーの機体ヨー（既定 π: 前方 +Z） */
  yaw?: number;
  targets?: RangeTarget[];
  /** 足元の床の一辺 [m]（既定 4）。0 なら床なし */
  floorSize?: number;
  extraSolids?: SolidDef[];
  extraEnemies?: EnemyDef[];
  killY?: number;
}

export function box(min: Vec3, max: Vec3): AABB {
  return { min: [...min] as Vec3, max: [...max] as Vec3 };
}

/** 銃口位置から足元位置を逆算する */
export function playerFeetForMuzzle(muzzle: Vec3, yaw: number): Vec3 {
  return sub(muzzle, rotateY(PLAYER.muzzleOffset, yaw));
}

export function makeRangeStage(opts: RangeStageOptions = {}): StageData {
  const muzzle = opts.muzzle ?? [0, 20, 0];
  const yaw = opts.yaw ?? Math.PI;
  const feet = playerFeetForMuzzle(muzzle, yaw);
  const floorSize = opts.floorSize ?? 4;
  const solids: SolidDef[] = [];
  if (floorSize > 0) {
    const h = floorSize / 2;
    solids.push({
      box: box([feet[0] - h, feet[1] - 1, feet[2] - h], [feet[0] + h, feet[1], feet[2] + h]),
      material: 'floorPlate',
      label: 'range-floor',
    });
  }
  if (opts.extraSolids) solids.push(...opts.extraSolids);
  const enemies: EnemyDef[] = (opts.targets ?? []).map((t) => ({
    id: t.id,
    kind: 'target',
    position: [...t.center] as Vec3,
    yaw: 0,
    sectorId: 'range',
    isGateControl: false,
    velocity: [...t.velocity] as Vec3,
  }));
  if (opts.extraEnemies) enemies.push(...opts.extraEnemies);
  const sectorBounds = box([-2000, -2000, -2000], [2000, 2000, 2000]);
  return {
    id: 'range',
    name: 'Test Range',
    start: { position: feet, yaw, sectorId: 'range' },
    exitZone: box([5000, 5000, 5000], [5001, 5001, 5001]),
    killY: opts.killY ?? -1000,
    sectors: [{ id: 'range', name: '試験場', kind: 'yard', bounds: [sectorBounds] }],
    solids,
    decor: [],
    lights: [],
    barriers: [],
    gate: { id: 'gate', box: box([5000, 0, 5000], [5001, 1, 5001]) },
    enemies,
    route: [],
    flightPoints: [],
    branches: [],
    loops: [],
    arenaSectorIds: [],
    crossfireSectors: [],
    objectiveHints: { range: '試験' },
  };
}

/** 平坦な大きい床だけのステージ（移動試験・敵AI試験用）。床上面 y=0 */
export function makeFlatStage(opts: { size?: number; enemies?: EnemyDef[]; extraSolids?: SolidDef[]; start?: Vec3; yaw?: number } = {}): StageData {
  const size = opts.size ?? 600;
  const h = size / 2;
  const solids: SolidDef[] = [{ box: box([-h, -2, -h], [h, 0, h]), material: 'floorPlate', label: 'flat-floor' }];
  if (opts.extraSolids) solids.push(...opts.extraSolids);
  return {
    id: 'flat',
    name: 'Flat Test',
    start: { position: opts.start ?? [0, 0, 0], yaw: opts.yaw ?? 0, sectorId: 'flat' },
    exitZone: box([5000, 5000, 5000], [5001, 5001, 5001]),
    killY: -100,
    sectors: [{ id: 'flat', name: '平地', kind: 'yard', bounds: [box([-h, -10, -h], [h, 200, h])] }],
    solids,
    decor: [],
    lights: [],
    barriers: [],
    gate: { id: 'gate', box: box([5000, 0, 5000], [5001, 1, 5001]) },
    enemies: opts.enemies ?? [],
    route: [],
    flightPoints: [],
    branches: [],
    loops: [],
    arenaSectorIds: [],
    crossfireSectors: [],
    objectiveHints: { flat: '試験' },
  };
}
