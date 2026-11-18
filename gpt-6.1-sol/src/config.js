// All gameplay and garage values share these definitions. One unit is one metre.
export const CONFIG = Object.freeze({
  version: 'AK2-1.2-candidate',
  defaultSeed: 20260908,
  defaultLoadout: Object.freeze({ fcs: 'medium', generator: 'balanced', legs: 'biped' }),
  maxHp: 1000,
  simulationStep: 1 / 120,
  gravity: 18,
  walkSpeed: 10,
  glideSpeed: 22,
  airSpeed: 16,
  qbSpeed: 80,
  qbCost: 36,
  qbImpulseSeconds: 0.15,
  qbCooldownSeconds: 1,
  groundGlideAcceleration: (80 - 22) / 0.60,
  airGlideAcceleration: (80 - 16) / 0.60,
  walkAcceleration: 120,
  jumpSpeed: 10,
  flightSpeed: 8,
  flightEnPerSecond: 20,
  flightHoldSeconds: 0.20,
  regenDelaySeconds: 0.75,
  playerHalfExtents: Object.freeze([1.1, 2.1, 1.1]),
  lockRange: 120,
});

export const FCS = Object.freeze({
  wide: Object.freeze({ name: '広範囲', radiusRatio: 0.30, lockSeconds: 1.20, description: '広い取得円・ロックに時間が必要' }),
  medium: Object.freeze({ name: '中範囲', radiusRatio: 0.20, lockSeconds: 0.80, description: '取得円とロック時間の均衡' }),
  narrow: Object.freeze({ name: '狭範囲', radiusRatio: 0.10, lockSeconds: 0.40, description: '素早いロック・狭い取得円' }),
});

export const GENERATORS = Object.freeze({
  capacity: Object.freeze({ name: '大容量', maxEn: 180, regenPerSecond: 10, description: '長い飛行が可能・回復は遅い' }),
  balanced: Object.freeze({ name: '均衡', maxEn: 120, regenPerSecond: 15, description: '容量と回復の均衡' }),
  recovery: Object.freeze({ name: '高回復', maxEn: 90, regenPerSecond: 20, description: '素早い回復・容量は小さい' }),
});

export const LEGS = Object.freeze({
  biped: Object.freeze({ name: '2脚', horizontalSpeedMultiplier: 1, regenMultiplier: 1, lockSpeedMultiplier: 1, description: '高速移動・標準ロック' }),
  quadruped: Object.freeze({ name: '4脚', horizontalSpeedMultiplier: 0.80, regenMultiplier: 0.75, lockSpeedMultiplier: 1.50, description: 'ロック1.5倍・移動と回復は低下' }),
});

export const WEAPONS = Object.freeze({
  machinegun: Object.freeze({ name: 'マシンガン', damage: 12, interval: 0.10, ammo: 300, enCost: 0, speed: 100, gravity: 18, lifetime: 2, range: 200, requiresLock: false, turnRateRad: 0 }),
  beam: Object.freeze({ name: 'ビーム', damage: 40, interval: 0.25, ammo: null, enCost: 8, speed: null, gravity: 0, lifetime: 0, range: 120, requiresLock: false, turnRateRad: 0 }),
  missile: Object.freeze({ name: 'ハンドミサイル', damage: 180, interval: 1, ammo: 12, enCost: 0, speed: 45, gravity: 0, lifetime: 4, range: 180, requiresLock: true, turnRateRad: 120 * Math.PI / 180 }),
});

export function effectiveStats(loadout = CONFIG.defaultLoadout) {
  const generator = GENERATORS[loadout.generator];
  const legs = LEGS[loadout.legs];
  const fcs = FCS[loadout.fcs];
  if (!generator || !legs || !fcs) throw new Error('Invalid AK2 loadout');
  return {
    maxEn: generator.maxEn,
    regenPerSecond: generator.regenPerSecond * legs.regenMultiplier,
    lockSeconds: fcs.lockSeconds / legs.lockSpeedMultiplier,
    horizontalSpeedMultiplier: legs.horizontalSpeedMultiplier,
    walkSpeed: CONFIG.walkSpeed * legs.horizontalSpeedMultiplier,
    glideSpeed: CONFIG.glideSpeed * legs.horizontalSpeedMultiplier,
    airSpeed: CONFIG.airSpeed * legs.horizontalSpeedMultiplier,
    qbSpeed: CONFIG.qbSpeed * legs.horizontalSpeedMultiplier,
  };
}
