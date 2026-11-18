export const VERSION = 'AK2-1.2-candidate';
export const FIXED_DT = 1 / 120;
export const GRAVITY = -18;

export const WEAPONS = Object.freeze({
  machinegun: { name: 'マシンガン', damage: 12, interval: 0.10, ammo: 300, en: 0, speed: 100, life: 2, gravity: -18, range: 200 },
  beam: { name: 'ビーム', damage: 40, interval: 0.25, ammo: Infinity, en: 8, speed: Infinity, life: 0, gravity: 0, range: 120 },
  missile: { name: 'ハンドミサイル', damage: 180, interval: 1.00, ammo: 12, en: 0, speed: 45, life: 4, gravity: 0, turnRate: 120 * Math.PI / 180, range: 180 },
});

export const FCS = Object.freeze({
  wide: { name: '広範囲', radius: 0.30, lockSeconds: 1.20, merit: '照準円が最大で捕捉しやすい', demerit: 'ロック完了は最も遅い' },
  medium: { name: '中範囲', radius: 0.20, lockSeconds: 0.80, merit: '捕捉範囲と速度のバランス', demerit: '特化型より際立った長所はない' },
  narrow: { name: '狭範囲', radius: 0.10, lockSeconds: 0.40, merit: '最短でロック完了', demerit: '照準円が小さく精密な追従が必要' },
});

export const GENERATORS = Object.freeze({
  capacity: { name: '大容量', maxEn: 180, regen: 10, merit: 'QB・飛行を長く運用可能', demerit: 'EN回復は最も遅い' },
  balanced: { name: '均衡', maxEn: 120, regen: 15, merit: '容量と回復のバランス', demerit: '極端な運用では特化型に劣る' },
  recovery: { name: '高回復', maxEn: 90, regen: 20, merit: '接地回復が最速', demerit: '最大ENが少なく連続推進は短い' },
});

export const LEGS = Object.freeze({
  biped: { name: '2脚', speed: 1.00, regen: 1.00, lock: 1.00, merit: '最高速度と標準EN回復', demerit: 'ロック速度補正なし' },
  quadruped: { name: '4脚', speed: 0.80, regen: 0.75, lock: 1.50, merit: 'ロック時間が2/3に短縮', demerit: '全水平速度-20%、回復-25%' },
});

export const PLAYER = Object.freeze({
  maxHp: 1000,
  radius: 1.05,
  height: 4.4,
  walkSpeed: 10,
  groundGlideSpeed: 22,
  airSpeed: 16,
  jumpSpeed: 10,
  flyRiseSpeed: 8,
  flyEnPerSecond: 20,
  flyHoldSeconds: 0.20,
  qbSpeed: 80,
  qbCost: 36,
  qbImpulse: 0.15,
  qbCooldown: 1.0,
  qbDecelerationSeconds: 0.60,
  walkAcceleration: 120,
  regenDelay: 0.75,
});

export const ENEMY = Object.freeze({
  guard: { hp: 120, range: 90, initialDelay: 0.50, damage: 18, speed: 70, burst: 3, shotInterval: 0.12, cycle: 1.20, telegraph: 0.15, life: 2 },
  turret: { hp: 240, range: 120, initialDelay: 0.70, damage: 40, speed: 60, burst: 2, shotInterval: 0.25, cycle: 1.60, telegraph: 0.35, life: 3 },
});

export const DEFAULT_LOADOUT = Object.freeze({ fcs: 'medium', generator: 'balanced', legs: 'biped' });
export const CONTROL_TURRETS = Object.freeze(['T01', 'T04', 'T07', 'T10', 'T13', 'T15']);
export const BARRIER_FOR_CONTROL = Object.freeze({ T01: 'B0', T04: 'B1', T07: 'B2', T10: 'B3', T13: 'B4', T15: 'B5' });
export const DEFAULT_SEED = 20260908;

export function effectiveStats(loadout) {
  const fcs = FCS[loadout.fcs];
  const generator = GENERATORS[loadout.generator];
  const legs = LEGS[loadout.legs];
  return {
    maxEn: generator.maxEn,
    regenPerSecond: generator.regen * legs.regen,
    lockSeconds: fcs.lockSeconds / legs.lock,
    horizontalSpeedMultiplier: legs.speed,
  };
}
