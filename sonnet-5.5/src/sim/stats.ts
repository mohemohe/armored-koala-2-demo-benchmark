import { FCS_PARTS, GENERATOR_PARTS, LEGS_PARTS } from '../config';
import type { EffectiveStats, Loadout } from './types';

/** SPEC §5/§6: effective max EN, regen, lock time and speed multiplier after leg modifiers. */
export function computeEffectiveStats(loadout: Loadout): EffectiveStats {
  const gen = GENERATOR_PARTS[loadout.generator];
  const legs = LEGS_PARTS[loadout.legs];
  const fcs = FCS_PARTS[loadout.fcs];
  return {
    maxEn: gen.maxEn,
    regenPerSecond: gen.baseRegen * legs.regenMult,
    // lock SPEED multiplier: time = base / mult (NOT base * mult)
    lockSeconds: fcs.baseLockSeconds / legs.lockSpeedMult,
    horizontalSpeedMultiplier: legs.speedMult,
  };
}

/** FCS circle radius in CSS px: ratio * D where D = min(viewport width, viewport height) (SPEC §5) */
export function lockRadiusCssPx(loadout: Loadout, viewportW: number, viewportH: number): number {
  return FCS_PARTS[loadout.fcs].radiusRatio * Math.min(viewportW, viewportH);
}
