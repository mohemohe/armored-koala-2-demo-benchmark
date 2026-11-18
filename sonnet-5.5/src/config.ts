/**
 * AK2 DEMO - single source of truth for every gameplay parameter.
 * (SPEC §9: 主要パラメーターは一か所に集約し、UI専用の架空の数値を作らない)
 * Units: 1 world unit = 1 m, Y is up, seconds, radians unless the name says Deg.
 */

export const DEFAULT_SEED = 20260908;

export const SIM = {
  /** fixed simulation step (SPEC §9: 1/120 s or finer) */
  DT: 1 / 120,
  /** real-time seconds of simulation we are willing to catch up in one rendered frame */
  MAX_FRAME_SECONDS: 0.25,
  /** ticks per second (informational) */
  HZ: 120,
} as const;

export const GRAVITY = 18; // m/s² downward, players + machinegun

// ---------------------------------------------------------------------------
// Loadout parts (SPEC §3, §5, §6)
// ---------------------------------------------------------------------------
export type FcsId = 'wide' | 'medium' | 'narrow';
export type GeneratorId = 'capacity' | 'balanced' | 'recovery';
export type LegsId = 'biped' | 'quadruped';

export const FCS_PARTS: Record<FcsId, { name: string; radiusRatio: number; baseLockSeconds: number; pros: string; cons: string }> = {
  wide: {
    name: '広範囲FCS',
    radiusRatio: 0.3,
    baseLockSeconds: 1.2,
    pros: 'ロック領域が最大(半径0.30D)。素早く動く敵も取得しやすい',
    cons: 'ロック所要時間が最も長い(1.20秒)',
  },
  medium: {
    name: '中範囲FCS',
    radiusRatio: 0.2,
    baseLockSeconds: 0.8,
    pros: '領域(0.20D)と所要時間(0.80秒)のバランスが良い',
    cons: '突出した長所がない',
  },
  narrow: {
    name: '狭範囲FCS',
    radiusRatio: 0.1,
    baseLockSeconds: 0.4,
    pros: 'ロック所要時間が最短(0.40秒)',
    cons: 'ロック領域が最小(半径0.10D)。中央に敵を合わせ続ける必要がある',
  },
};

export const GENERATOR_PARTS: Record<GeneratorId, { name: string; maxEn: number; baseRegen: number; pros: string; cons: string }> = {
  capacity: {
    name: '大容量ジェネレーター',
    maxEn: 180,
    baseRegen: 10,
    pros: '最大ENが最大(180)。QBと飛行を長く使える',
    cons: '基本EN回復率が最低(10 EN/秒)',
  },
  balanced: {
    name: '均衡ジェネレーター',
    maxEn: 120,
    baseRegen: 15,
    pros: '容量(120)と回復(15 EN/秒)のバランスが良い',
    cons: '突出した長所がない',
  },
  recovery: {
    name: '高回復ジェネレーター',
    maxEn: 90,
    baseRegen: 20,
    pros: '基本EN回復率が最大(20 EN/秒)',
    cons: '最大ENが最小(90)',
  },
};

export const LEGS_PARTS: Record<
  LegsId,
  { name: string; speedMult: number; regenMult: number; lockSpeedMult: number; legCount: number; pros: string; cons: string }
> = {
  biped: {
    name: '2脚',
    speedMult: 1.0,
    regenMult: 1.0,
    lockSpeedMult: 1.0,
    legCount: 2,
    pros: '水平移動速度が最速。EN回復率が標準',
    cons: 'ロック速度は標準',
  },
  quadruped: {
    name: '4脚',
    speedMult: 0.8,
    regenMult: 0.75,
    lockSpeedMult: 1.5,
    legCount: 4,
    pros: 'ロック速度が1.5倍(所要時間は1/1.5)',
    cons: '水平移動速度0.80倍、EN回復率0.75倍',
  },
};

export const DEFAULT_LOADOUT = { fcs: 'medium', generator: 'balanced', legs: 'biped' } as const;

// ---------------------------------------------------------------------------
// Player (SPEC §3, §6, §7)
// ---------------------------------------------------------------------------
export const PLAYER = {
  MAX_HP: 1000,
  /** hit/collision box half extents; player.pos is the CENTER of this box */
  HALF: { x: 0.8, y: 1.5, z: 0.8 },
  WALK_SPEED: 10,
  GLIDE_SPEED_GROUND: 22,
  /** steady horizontal speed in the air (non-flight, flight, glide) */
  AIR_SPEED: 16,
  /** walk/brake horizontal accel limit [m/s²] (× legs speed multiplier) */
  WALK_ACCEL: 120,
  JUMP_SPEED: 10,
  FLIGHT_HOLD_SECONDS: 0.2,
  FLIGHT_ASCENT: 8,
  FLIGHT_EN_PER_SEC: 20,
  EN_REGEN_DELAY: 0.75,
  QB: {
    SPEED: 80,
    DURATION: 0.15,
    COST: 36,
    COOLDOWN: 1.0,
    /** time in which the post-boost speed falls to the steady glide speed */
    DECEL_SECONDS: 0.6,
  },
  /** muzzle offset in the yaw frame (right, up, forward) from player center. Independent of pitch/aim (SPEC §4.2) */
  MUZZLE_OFFSET: { right: 1.05, up: 0.75, forward: 1.25 },
  /** fall below this Y => failure (SPEC §9) */
  KILL_Y: -80,
} as const;

/** ground glide accel limit [m/s²] = (80-22)/0.6 (× legs speed multiplier) */
export const GLIDE_ACCEL_GROUND = (PLAYER.QB.SPEED - PLAYER.GLIDE_SPEED_GROUND) / PLAYER.QB.DECEL_SECONDS;
/** air glide accel limit [m/s²] = (80-16)/0.6 (× legs speed multiplier) */
export const GLIDE_ACCEL_AIR = (PLAYER.QB.SPEED - PLAYER.AIR_SPEED) / PLAYER.QB.DECEL_SECONDS;

// ---------------------------------------------------------------------------
// Camera (TPS)
// ---------------------------------------------------------------------------
export const CAMERA = {
  FOV_Y_DEG: 70,
  NEAR: 0.3,
  FAR: 1500,
  /** pivot above player center */
  PIVOT_UP: 1.2,
  DISTANCE: 8.5,
  /** camera shifted to the right so the mech appears left of the crosshair */
  SHOULDER: 1.4,
  PITCH_MIN: (-70 * Math.PI) / 180,
  PITCH_MAX: (70 * Math.PI) / 180,
  /** radians per CSS pixel of mouse movement */
  SENSITIVITY: 0.0022,
  /** wall clearance for the camera sphere */
  COLLISION_MARGIN: 0.35,
  /** free-fire aim ray length when nothing is hit */
  AIM_RANGE: 500,
} as const;

// ---------------------------------------------------------------------------
// Player weapons (SPEC §4)
// ---------------------------------------------------------------------------
export type WeaponId = 'machinegun' | 'beam' | 'missile';
export const WEAPON_ORDER: WeaponId[] = ['machinegun', 'beam', 'missile'];

export const WEAPONS = {
  machinegun: {
    name: 'マシンガン',
    damage: 12,
    interval: 0.1,
    totalAmmo: 300,
    enCost: 0,
    muzzleSpeed: 100,
    gravity: GRAVITY,
    lifetime: 2,
    bulletRadius: 0.06,
    needsLock: false,
  },
  beam: {
    name: 'ビーム',
    damage: 40,
    interval: 0.25,
    enCost: 8,
    range: 120,
    needsLock: false,
    visibleSeconds: 0.12,
  },
  missile: {
    name: 'ハンドミサイル',
    damage: 180,
    interval: 1.0,
    totalAmmo: 12,
    enCost: 0,
    speed: 45,
    turnRateDeg: 120,
    lifetime: 4,
    radius: 0.25,
    needsLock: true,
  },
} as const;

export const FCS = {
  /** lock/candidate range measured from the muzzle to the target hit-center [m] */
  RANGE: 120,
  /** max prediction time used by the PLAYER machinegun solver (SPEC §4.3) */
  MG_MAX_T: 2,
  MISSILE_MAX_T: 4,
  /** solver acceptance thresholds (SPEC §4.3) */
  MAX_RESIDUAL_M: 0.01,
  MAX_SPEED_ERR: 0.001,
} as const;

// ---------------------------------------------------------------------------
// Enemies (SPEC §2.1, §2.3)
// ---------------------------------------------------------------------------
export type EnemyKind = 'guard' | 'turret';

export const ENEMIES = {
  guard: {
    name: '警備ロボット',
    hp: 120,
    count: 30,
    sensorRange: 90,
    firstAttackDelay: 0.5,
    damage: 18,
    bulletSpeed: 70,
    burstShots: 3,
    burstShotInterval: 0.12,
    burstPeriod: 1.2,
    telegraph: 0.15,
    bulletLife: 2,
    hitRadius: 1.2,
    /** hit-center height above its standing floor */
    centerHeight: 1.5,
    approachSpeed: 8, // when > 55 m
    strafeSpeed: 6, // 25..55 m
    retreatMaxSpeed: 8, // < 15 m
    farDist: 55,
    midDist: 25,
    nearDist: 15,
    shareRadius: 60,
    memorySeconds: 8,
    reactSeconds: 0.5,
    bulletRadius: 0.2,
  },
  turret: {
    name: '固定砲台',
    hp: 240,
    count: 15,
    controlCount: 6,
    sensorRange: 120,
    firstAttackDelay: 0.7,
    damage: 40,
    bulletSpeed: 60,
    burstShots: 2,
    burstShotInterval: 0.25,
    burstPeriod: 1.6,
    telegraph: 0.35,
    bulletLife: 3,
    hitRadius: 1.4,
    centerHeight: 1.6,
    bulletRadius: 0.25,
  },
  /** max enemy prediction horizon [s] (SPEC §2.3) */
  MAX_PREDICT_T: 1.2,
  /** max random aim deviation [deg] (SPEC §2.3) */
  MAX_AIM_JITTER_DEG: 0.5,
  /** AI decision delay must stay <= 0.05 s */
  MAX_AI_LATENCY: 0.05,
  TOTAL: 45,
} as const;

// ---------------------------------------------------------------------------
// Test dummy target (SPEC §4.5/§4.6: radius 0.5 m test target; NOT used in the campaign)
// ---------------------------------------------------------------------------
export const TEST_TARGET_RADIUS = 0.5;

// ---------------------------------------------------------------------------
// Stage-level
// ---------------------------------------------------------------------------
export const STAGE = {
  SECTOR_MIN: 15,
  ROUTE_MIN_METERS: 1500,
  CONTROLS_REQUIRED: 6,
} as const;

/** ring-buffer sizes */
export const LIMITS = {
  RECENT_SHOTS: 32,
  EVENTS: 1024,
  DAMAGE_INDICATORS: 16,
} as const;
