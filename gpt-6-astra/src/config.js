// All gameplay values live here; menus, the simulator, and diagnostics share them.
export const FCS = Object.freeze({
  wide: { name: '広範囲 FCS', radius: 0.30, lockSeconds: 1.20, description: '広い取得範囲 / ロックは低速' },
  medium: { name: '中範囲 FCS', radius: 0.20, lockSeconds: 0.80, description: '取得範囲とロック速度の均衡型' },
  narrow: { name: '狭範囲 FCS', radius: 0.10, lockSeconds: 0.40, description: '高速ロック / 対象を狭い円内に保持' },
});

export const GENERATORS = Object.freeze({
  capacity: { name: '大容量', maxEn: 180, regenPerSecond: 10, description: '長い飛行と連続消費に強い / 回復は低速' },
  balanced: { name: '均衡', maxEn: 120, regenPerSecond: 15, description: '容量と回復速度の均衡型' },
  recovery: { name: '高回復', maxEn: 90, regenPerSecond: 20, description: '接地中に素早く回復 / 容量は小さい' },
});

export const LEGS = Object.freeze({
  biped: { name: '2脚', speedMultiplier: 1, regenMultiplier: 1, lockSpeedMultiplier: 1, description: '高い機動力とEN回復率 / 標準ロック速度' },
  quadruped: { name: '4脚', speedMultiplier: 0.8, regenMultiplier: 0.75, lockSpeedMultiplier: 1.5, description: 'ロック速度1.5倍 / 移動80%・EN回復75%' },
});

export const WEAPONS = Object.freeze({
  machinegun: { name: 'マシンガン', damage: 12, interval: 0.10, ammo: 300, cost: 0, speed: 100, gravity: 18, lifetime: 2, range: 120 },
  beam: { name: 'ビーム', damage: 40, interval: 0.25, ammo: null, cost: 8, speed: 0, gravity: 0, lifetime: 0, range: 120 },
  missile: { name: 'ハンドミサイル', damage: 180, interval: 1, ammo: 12, cost: 0, speed: 45, gravity: 0, lifetime: 4, range: 120, turnRate: Math.PI * 2 / 3 },
});

export const ENEMY_STATS = Object.freeze({
  guard: { hp: 120, range: 90, initialDelay: 0.50, damage: 18, speed: 70, burstShots: 3, burstInterval: 0.12, burstPeriod: 1.20, telegraph: 0.15, lifetime: 2, radius: 1.45, movementSpeed: 8, strafeSpeed: 6, memorySeconds: 8, alertShareRange: 60, maxLeadSeconds: 1.2 },
  turret: { hp: 240, range: 120, initialDelay: 0.70, damage: 40, speed: 60, burstShots: 2, burstInterval: 0.25, burstPeriod: 1.60, telegraph: 0.35, lifetime: 3, radius: 1.75, movementSpeed: 0, strafeSpeed: 0, memorySeconds: 8, alertShareRange: 60, maxLeadSeconds: 1.2 },
});

export const DEFAULT_LOADOUT = Object.freeze({ fcs: 'medium', generator: 'balanced', legs: 'biped' });
export const PHYSICS = Object.freeze({
  maxHp: 1000, playerRadius: 1.15, playerHeight: 4.5, collisionCenterHeight: 2.2,
  walkSpeed: 10, glideSpeed: 22, airSpeed: 16, quickboostSpeed: 80,
  quickboostCost: 36, quickboostDuration: 0.15, quickboostCooldown: 1,
  glideTransitionSeconds: 0.60, walkAcceleration: 120,
  jumpSpeed: 10, flightSpeed: 8, gravity: 18, flightCostPerSecond: 20,
  flightHoldSeconds: 0.20, regenDelaySeconds: 0.75, fixedStep: 1 / 120,
});

export function effectiveStats(loadout = DEFAULT_LOADOUT) {
  const fcs = FCS[loadout.fcs];
  const generator = GENERATORS[loadout.generator];
  const legs = LEGS[loadout.legs];
  if (!fcs || !generator || !legs) throw new Error('Invalid loadout');
  return {
    maxEn: generator.maxEn,
    regenPerSecond: generator.regenPerSecond * legs.regenMultiplier,
    lockSeconds: fcs.lockSeconds / legs.lockSpeedMultiplier,
    horizontalSpeedMultiplier: legs.speedMultiplier,
    fcsRadius: fcs.radius,
  };
}
