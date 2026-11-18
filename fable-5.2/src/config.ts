/**
 * ARMORED KOALA 2 DEMO — single source of truth for every gameplay parameter.
 *
 * The simulation, the HUD, the garage UI and the tests all import from here.
 * Never duplicate these numbers elsewhere (docs/SPEC.md §9: "主要パラメーターは一か所に集約").
 *
 * Units: metres, seconds, radians (unless a name says Deg). World up = +Y.
 */
import type { FcsId, GeneratorId, LegsId, Loadout, Weapon } from './sim/types';

export const VERSION = 'AK2-1.2-candidate' as const;
export const DEFAULT_SEED = 20260908;

/** Fixed simulation tick. Sub-steps inside a tick are additionally cut at exact event times. */
export const TICK_HZ = 120;
export const TICK = 1 / TICK_HZ;
/** Longest real frame time fed into the simulation in one call (prevents a spiral of death). */
export const MAX_FRAME_DT = 0.25;
/** Tolerance used when comparing simulation times. */
export const TIME_EPS = 1e-9;

/** Gravity magnitude (m/s²), applied along -Y to the player and to machine-gun bullets. */
export const GRAVITY = 18;

export const PLAYER = {
  maxHp: 1000,
  /** Half extents of the player's axis-aligned hit/collision box. `player.pos` is its centre. */
  half: { x: 1.3, y: 2.0, z: 1.3 },
  /** Horizontal speeds (m/s) before the legs multiplier. */
  walkSpeed: 10,
  glideSpeed: 22,
  airSpeed: 16,
  /** Horizontal accel/decel limit for walk + brake (m/s²) before the legs multiplier. */
  walkAccel: 120,
  /** Quick boost. */
  qbSpeed: 80,
  qbImpulseSeconds: 0.15,
  qbCost: 36,
  qbCooldownSeconds: 1.0,
  /** Time to decay from qbSpeed to the steady glide/air speed; defines the glide accel limit. */
  qbDecelSeconds: 0.6,
  /** Vertical (not affected by the legs multiplier). */
  jumpSpeed: 10,
  flyClimbSpeed: 8,
  flyEnPerSecond: 20,
  flyHoldSeconds: 0.2,
  /** EN regeneration starts this long after the last actual EN expenditure (and only while grounded). */
  enRegenDelaySeconds: 0.75,
  /**
   * Muzzle position relative to the hit-box centre in the body frame (body yaw = camera yaw).
   * It does NOT depend on the aim direction (the weapon pivots about its muzzle), and it always lies
   * inside the collision box footprint (hypot(right, forward) < half.x) so it can never poke through a wall.
   */
  muzzleLocal: { right: 0.9, up: 0.75, forward: 0.85 },
} as const;

/** Glide acceleration limits (m/s² before legs multiplier): (80-22)/0.60 on the ground, (80-16)/0.60 in the air. */
export const GLIDE_ACCEL_GROUND = (PLAYER.qbSpeed - PLAYER.glideSpeed) / PLAYER.qbDecelSeconds;
export const GLIDE_ACCEL_AIR = (PLAYER.qbSpeed - PLAYER.airSpeed) / PLAYER.qbDecelSeconds;

export const WEAPON_ORDER: readonly Weapon[] = ['machinegun', 'beam', 'missile'];

export const WEAPONS = {
  machinegun: {
    label: 'マシンガン',
    short: 'MG',
    damage: 12,
    interval: 0.1,
    ammo: 300,
    enCost: 0,
    speed: 100,
    /** Bullets feel GRAVITY downward. */
    gravity: GRAVITY,
    lifeSeconds: 2,
    requiresLock: false,
  },
  beam: {
    label: 'ビーム',
    short: 'BEAM',
    damage: 40,
    interval: 0.25,
    /** Unlimited ammo. */
    ammo: Number.POSITIVE_INFINITY,
    enCost: 8,
    range: 120,
    requiresLock: false,
  },
  missile: {
    label: 'ハンドミサイル',
    short: 'MSL',
    damage: 180,
    interval: 1.0,
    ammo: 12,
    enCost: 0,
    speed: 45,
    turnRateDeg: 120,
    lifeSeconds: 4,
    requiresLock: true,
  },
} as const;

/** FCS = "Flight Control System" in this project (target acquisition + fire control). */
export const FCS_RANGE = 120;
export const FCS_PARTS: Record<FcsId, { label: string; radiusFactor: number; lockSeconds: number; pros: string; cons: string }> = {
  wide: {
    label: '広範囲FCS',
    radiusFactor: 0.3,
    lockSeconds: 1.2,
    pros: 'ロック領域が最大(半径0.30D)。高速移動中や乱戦でも対象を捕捉し続けやすい',
    cons: 'ロック所要時間が最長(1.20秒)。撃ち始めが遅い',
  },
  medium: {
    label: '中範囲FCS',
    radiusFactor: 0.2,
    lockSeconds: 0.8,
    pros: '領域(半径0.20D)と所要時間(0.80秒)の均衡型。扱いやすい',
    cons: '捕捉範囲・速度とも突出しない',
  },
  narrow: {
    label: '狭範囲FCS',
    radiusFactor: 0.1,
    lockSeconds: 0.4,
    pros: 'ロック所要時間が最短(0.40秒)。即応射撃とミサイル連携に強い',
    cons: 'ロック領域が最小(半径0.10D)。正確な照準保持が必要',
  },
};

export const GENERATOR_PARTS: Record<GeneratorId, { label: string; maxEn: number; regen: number; pros: string; cons: string }> = {
  capacity: {
    label: '大容量ジェネレーター',
    maxEn: 180,
    regen: 10,
    pros: '最大EN180。QB連発(最大5回)や長時間飛行、ビーム連射に余裕',
    cons: 'EN回復が最遅(10 EN/秒)。使い切ると立て直しに時間がかかる',
  },
  balanced: {
    label: '均衡ジェネレーター',
    maxEn: 120,
    regen: 15,
    pros: '最大EN120・回復15 EN/秒の標準型',
    cons: '容量・回復とも突出しない',
  },
  recovery: {
    label: '高回復ジェネレーター',
    maxEn: 90,
    regen: 20,
    pros: 'EN回復が最速(20 EN/秒)。小刻みなQBとビームを繰り返せる',
    cons: '最大EN90。連続QBは2回まで、飛行可能時間も最短(4.5秒)',
  },
};

export const LEGS_PARTS: Record<LegsId, { label: string; speedMult: number; regenMult: number; lockSpeedMult: number; pros: string; cons: string }> = {
  biped: {
    label: '2脚',
    speedMult: 1.0,
    regenMult: 1.0,
    lockSpeedMult: 1.0,
    pros: '水平移動速度と EN回復が基準値(×1.00)。機動戦向き',
    cons: 'ロック速度は基準値(×1.00)',
  },
  quadruped: {
    label: '4脚',
    speedMult: 0.8,
    regenMult: 0.75,
    lockSpeedMult: 1.5,
    pros: 'ロック速度×1.50(所要時間は1/1.5)。射撃戦向き',
    cons: '水平移動速度×0.80、EN回復×0.75',
  },
};

export const DEFAULT_LOADOUT: Loadout = { fcs: 'medium', generator: 'balanced', legs: 'biped' };
export const DEFAULT_WEAPON: Weapon = 'machinegun';

export interface EffectiveStats {
  maxEn: number;
  regenPerSecond: number;
  lockSeconds: number;
  horizontalSpeedMultiplier: number;
  lockRadiusFactor: number;
  walkSpeed: number;
  glideSpeed: number;
  airSpeed: number;
  qbSpeed: number;
}

/** Effective stats after applying the legs multipliers. Used by sim, garage and snapshot alike. */
export function computeEffectiveStats(loadout: Loadout): EffectiveStats {
  const f = FCS_PARTS[loadout.fcs];
  const g = GENERATOR_PARTS[loadout.generator];
  const l = LEGS_PARTS[loadout.legs];
  return {
    maxEn: g.maxEn,
    regenPerSecond: g.regen * l.regenMult,
    lockSeconds: f.lockSeconds / l.lockSpeedMult,
    horizontalSpeedMultiplier: l.speedMult,
    lockRadiusFactor: f.radiusFactor,
    walkSpeed: PLAYER.walkSpeed * l.speedMult,
    glideSpeed: PLAYER.glideSpeed * l.speedMult,
    airSpeed: PLAYER.airSpeed * l.speedMult,
    qbSpeed: PLAYER.qbSpeed * l.speedMult,
  };
}

/** Enemy-only weapons and behaviour (docs/SPEC.md §2.3). Never scaled by player HP or score. */
export const ENEMIES = {
  guard: {
    label: '警備ロボット',
    hp: 120,
    /** Hit sphere radius; `enemy.pos` is its centre. */
    radius: 1.2,
    /** Height of the hit-sphere centre above the floor the guard stands on. */
    centerHeight: 1.3,
    /** Muzzle/eye offset above the hit-sphere centre (LOS + bullet origin). */
    muzzleUp: 0.5,
    range: 90,
    firstShotDelay: 0.5,
    damage: 18,
    bulletSpeed: 70,
    burstCount: 3,
    burstInterval: 0.12,
    burstPeriod: 1.2,
    telegraph: 0.15,
    bulletLife: 2,
    /** Movement bands (m) and speeds (m/s). */
    approachBeyond: 55,
    strafeMin: 25,
    retreatBelow: 15,
    approachSpeed: 8,
    strafeSpeed: 6,
    retreatSpeed: 8,
  },
  turret: {
    label: '固定砲台',
    hp: 240,
    radius: 1.4,
    centerHeight: 1.6,
    muzzleUp: 0.5,
    range: 120,
    firstShotDelay: 0.7,
    damage: 40,
    bulletSpeed: 60,
    burstCount: 2,
    burstInterval: 0.25,
    burstPeriod: 1.6,
    telegraph: 0.35,
    bulletLife: 3,
  },
} as const;

export const ENEMY_AI = {
  /** Seconds a lost player position is remembered. */
  memorySeconds: 8,
  /** A guard that lost line of sight must start closing in / flanking within this time. */
  reacquireStartSeconds: 0.5,
  /** Alert sharing: allies (guards and turrets) within this walkable path distance receive the last known position. */
  shareDistance: 60,
  /** Lead prediction cap (enemy AI only — NOT used by the player's FCS). */
  maxPredictSeconds: 1.2,
  /** Maximum random aim deviation (degrees). */
  aimJitterDeg: 0.5,
  /** Upper bound on any AI-induced delay. Perception runs every sub-step, well inside this bound. */
  maxDecisionDelay: 0.05,
} as const;

export const CAMERA = {
  fovYDeg: 60,
  near: 0.2,
  far: 900,
  /** Boom pivot above the player's hit-box centre. */
  pivotUp: 2.9,
  boomLength: 9.5,
  minBoom: 1.0,
  collisionPad: 0.35,
  pitchMin: (-70 * Math.PI) / 180,
  pitchMax: (80 * Math.PI) / 180,
  /** Radians per CSS pixel of mouse movement. */
  mouseSensitivity: 0.0022,
} as const;

/** Number of control turrets that must be destroyed to open the final gate. */
export const CONTROLS_REQUIRED = 6 as const;
export const TOTAL_ENEMIES = 45 as const;
export const RECENT_SHOTS_MAX = 32;
