/**
 * 格納庫の表示ロジック(DOM非依存)。実効値は sim/stats.ts の computeEffectiveStats と config.ts から算出する。
 */
import { FCS_PARTS, GENERATOR_PARTS, LEGS_PARTS, PLAYER } from '../config';
import type { FcsId, GeneratorId, LegsId } from '../config';
import { computeEffectiveStats } from '../sim/stats';
import type { Loadout } from '../sim/types';

export const FCS_IDS = Object.keys(FCS_PARTS) as FcsId[];
export const GENERATOR_IDS = Object.keys(GENERATOR_PARTS) as GeneratorId[];
export const LEGS_IDS = Object.keys(LEGS_PARTS) as LegsId[];

/** 小数2桁までで末尾の0を落とす */
export const fmtNum = (n: number, digits = 2): string => String(Number(n.toFixed(digits)));

export interface PartCard {
  id: string;
  name: string;
  /** 数値の要約 (config の値そのもの) */
  spec: string;
  pros: string;
  cons: string;
}

export function fcsCards(): PartCard[] {
  return FCS_IDS.map((id) => {
    const p = FCS_PARTS[id];
    return {
      id,
      name: p.name,
      spec: `領域 半径${fmtNum(p.radiusRatio)}D / ロック ${fmtNum(p.baseLockSeconds)}秒(2脚)`,
      pros: p.pros,
      cons: p.cons,
    };
  });
}

export function generatorCards(): PartCard[] {
  return GENERATOR_IDS.map((id) => {
    const p = GENERATOR_PARTS[id];
    return { id, name: p.name, spec: `最大EN ${p.maxEn} / 基本回復 ${fmtNum(p.baseRegen)} EN/秒`, pros: p.pros, cons: p.cons };
  });
}

export function legsCards(): PartCard[] {
  return LEGS_IDS.map((id) => {
    const p = LEGS_PARTS[id];
    return {
      id,
      name: p.name,
      spec: `速度×${fmtNum(p.speedMult)} / EN回復×${fmtNum(p.regenMult)} / ロック速度×${fmtNum(p.lockSpeedMult)}`,
      pros: p.pros,
      cons: p.cons,
    };
  });
}

export interface GarageSummary {
  fcsName: string;
  generatorName: string;
  legsName: string;
  legCount: number;
  /** 脚部補正適用後の実効値 */
  maxEn: number;
  regenPerSecond: number;
  lockSeconds: number;
  lockRadiusRatio: number;
  speedMult: number;
  speeds: { walk: number; glide: number; air: number; qb: number };
}

export function garageSummary(loadout: Loadout): GarageSummary {
  const eff = computeEffectiveStats(loadout);
  const m = eff.horizontalSpeedMultiplier;
  return {
    fcsName: FCS_PARTS[loadout.fcs].name,
    generatorName: GENERATOR_PARTS[loadout.generator].name,
    legsName: LEGS_PARTS[loadout.legs].name,
    legCount: LEGS_PARTS[loadout.legs].legCount,
    maxEn: eff.maxEn,
    regenPerSecond: eff.regenPerSecond,
    lockSeconds: eff.lockSeconds,
    lockRadiusRatio: FCS_PARTS[loadout.fcs].radiusRatio,
    speedMult: m,
    speeds: {
      walk: PLAYER.WALK_SPEED * m,
      glide: PLAYER.GLIDE_SPEED_GROUND * m,
      air: PLAYER.AIR_SPEED * m,
      qb: PLAYER.QB.SPEED * m,
    },
  };
}
