// AK2 主要パラメーター定義。ゲームロジック・HUD・格納庫表示は全てここを参照する。

export const VERSION = 'AK2-1.1-candidate' as const;
export const DEFAULT_SEED = 20260908;

/** シミュレーションの固定更新幅（秒）。1/120秒。 */
export const SIM_DT = 1 / 120;
/** 1描画フレームで処理する最大ステップ数（これを超える分は破棄し、まとめ加算しない） */
export const MAX_STEPS_PER_FRAME = 30;

export type FcsId = 'wide' | 'medium' | 'narrow';
export type GeneratorId = 'capacity' | 'balanced' | 'recovery';
export type LegsId = 'biped' | 'quadruped';
export type WeaponId = 'machinegun' | 'beam' | 'missile';

export interface Loadout {
  fcs: FcsId;
  generator: GeneratorId;
  legs: LegsId;
}

export const DEFAULT_LOADOUT: Loadout = { fcs: 'medium', generator: 'balanced', legs: 'biped' };
export const DEFAULT_WEAPON: WeaponId = 'machinegun';

export interface FcsSpec {
  id: FcsId;
  name: string;
  /** ロック領域の半径 = radiusFactor × min(幅, 高さ) */
  radiusFactor: number;
  /** 2脚でのロック所要時間（秒） */
  baseLockSeconds: number;
  pros: string;
  cons: string;
}

export const FCS: Record<FcsId, FcsSpec> = {
  wide: {
    id: 'wide',
    name: '広範囲FCS "KR-WIDE"',
    radiusFactor: 0.3,
    baseLockSeconds: 1.2,
    pros: 'ロック円が大きく（0.30D）、画面端寄りの敵も捕捉できる',
    cons: 'ロック所要時間が長い（1.20秒）',
  },
  medium: {
    id: 'medium',
    name: '中範囲FCS "KR-MID"',
    radiusFactor: 0.2,
    baseLockSeconds: 0.8,
    pros: '範囲（0.20D）と速度（0.80秒）の均衡が取れている',
    cons: '突出した長所がない',
  },
  narrow: {
    id: 'narrow',
    name: '狭範囲FCS "KR-PIN"',
    radiusFactor: 0.1,
    baseLockSeconds: 0.4,
    pros: 'ロックが非常に速い（0.40秒）',
    cons: 'ロック円が小さく（0.10D）、正確な照準が必要',
  },
};

export interface GeneratorSpec {
  id: GeneratorId;
  name: string;
  maxEn: number;
  regenPerSecond: number;
  pros: string;
  cons: string;
}

export const GENERATORS: Record<GeneratorId, GeneratorSpec> = {
  capacity: {
    id: 'capacity',
    name: '大容量ジェネレーター "EUCA-180"',
    maxEn: 180,
    regenPerSecond: 10,
    pros: '最大EN 180。QBや飛行を連続で使える',
    cons: '回復が遅い（10 EN/秒）',
  },
  balanced: {
    id: 'balanced',
    name: '均衡ジェネレーター "EUCA-120"',
    maxEn: 120,
    regenPerSecond: 15,
    pros: '容量と回復の均衡（120 EN / 15 EN/秒）',
    cons: '突出した長所がない',
  },
  recovery: {
    id: 'recovery',
    name: '高回復ジェネレーター "EUCA-90R"',
    maxEn: 90,
    regenPerSecond: 20,
    pros: '回復が速い（20 EN/秒）',
    cons: '最大EN 90。連続使用に弱い',
  },
};

export interface LegsSpec {
  id: LegsId;
  name: string;
  horizontalSpeedMultiplier: number;
  regenMultiplier: number;
  lockSpeedMultiplier: number;
  pros: string;
  cons: string;
}

export const LEGS: Record<LegsId, LegsSpec> = {
  biped: {
    id: 'biped',
    name: '2脚 "GUM-LEG"',
    horizontalSpeedMultiplier: 1.0,
    regenMultiplier: 1.0,
    lockSpeedMultiplier: 1.0,
    pros: '水平移動速度・EN回復率が標準（×1.00）',
    cons: 'ロック速度は標準（×1.00）',
  },
  quadruped: {
    id: 'quadruped',
    name: '4脚 "EUCALYPT-QX"',
    horizontalSpeedMultiplier: 0.8,
    regenMultiplier: 0.75,
    lockSpeedMultiplier: 1.5,
    pros: '安定した姿勢でロック速度×1.50',
    cons: '水平移動速度×0.80、EN回復率×0.75',
  },
};

export interface EffectiveStats {
  maxEn: number;
  regenPerSecond: number;
  lockSeconds: number;
  horizontalSpeedMultiplier: number;
  lockRadiusFactor: number;
}

export function computeEffectiveStats(l: Loadout): EffectiveStats {
  const f = FCS[l.fcs];
  const g = GENERATORS[l.generator];
  const legs = LEGS[l.legs];
  return {
    maxEn: g.maxEn,
    regenPerSecond: g.regenPerSecond * legs.regenMultiplier,
    lockSeconds: f.baseLockSeconds / legs.lockSpeedMultiplier,
    horizontalSpeedMultiplier: legs.horizontalSpeedMultiplier,
    lockRadiusFactor: f.radiusFactor,
  };
}

/** プレイヤー機体・移動の基準値（2脚基準。水平値には脚部倍率を乗じる） */
export const PLAYER = {
  maxHp: 1000,
  halfWidth: 0.9,
  height: 3.0,
  /** 当たり判定中心の高さ */
  centerHeight: 1.5,
  walkSpeed: 10,
  walkAccel: 120,
  glideSpeedGround: 22,
  airSpeed: 16,
  jumpVelocity: 10,
  gravity: 18,
  flightHoldSeconds: 0.2,
  flightRiseSpeed: 8,
  /** 飛行推進中に上昇速度8m/sへ近づける加速度 */
  flightRiseAccel: 60,
  flightEnPerSecond: 20,
  qbSpeed: 80,
  qbImpulseSeconds: 0.15,
  qbEnCost: 36,
  qbCooldownSeconds: 1.0,
  /** 噴射後、80→22へ0.60秒で減速 */
  qbDecaySeconds: 0.6,
  enRegenDelay: 0.75,
  fallFailY: -80,
} as const;

/** グライドの速度変化上限（脚部倍率を乗じる前） */
export const GLIDE_RATE_GROUND = (PLAYER.qbSpeed - PLAYER.glideSpeedGround) / PLAYER.qbDecaySeconds; // 96.67
export const GLIDE_RATE_AIR = (PLAYER.qbSpeed - PLAYER.airSpeed) / PLAYER.qbDecaySeconds; // 106.67

export interface WeaponSpec {
  id: WeaponId;
  name: string;
  key: string;
  damage: number;
  interval: number;
  /** 出撃時の総弾数。nullは弾数制限なし */
  ammo: number | null;
  enCost: number;
  gravity: boolean;
  requiresLock: boolean;
}

export const WEAPONS: Record<WeaponId, WeaponSpec> = {
  machinegun: {
    id: 'machinegun',
    name: 'マシンガン "GUM-MG"',
    key: '1',
    damage: 12,
    interval: 0.1,
    ammo: 300,
    enCost: 0,
    gravity: true,
    requiresLock: false,
  },
  beam: {
    id: 'beam',
    name: 'ビームライフル "LEAF-BEAM"',
    key: '2',
    damage: 40,
    interval: 0.25,
    ammo: null,
    enCost: 8,
    gravity: false,
    requiresLock: false,
  },
  missile: {
    id: 'missile',
    name: 'ハンドミサイル "POUCH-HM"',
    key: '3',
    damage: 180,
    interval: 1.0,
    ammo: 12,
    enCost: 0,
    gravity: false,
    requiresLock: true,
  },
};

export const WEAPON_ORDER: WeaponId[] = ['machinegun', 'beam', 'missile'];

export const MG = { speed: 100, gravity: 18, life: 2.0 } as const;
export const BEAM = { range: 120, trailSeconds: 0.18 } as const;
export const MISSILE = { speed: 45, turnRateDeg: 120, life: 4.0, radius: 0.25 } as const;

/** FCS共通 */
export const LOCK = { maxDistance: 120 } as const;

/** カメラ（TPS） */
export const CAMERA = {
  fovDeg: 70,
  near: 0.1,
  far: 900,
  pivotHeight: 2.9,
  offsetRight: 2.2,
  offsetUp: 0.85,
  distance: 7.4,
  minPitch: -1.25,
  maxPitch: 1.1,
  collisionPadding: 0.35,
  mouseSensitivity: 0.0022,
} as const;

/** 武器の銃口オフセット（機体ローカル: 右, 上, 前） */
export const MUZZLE_OFFSET = { right: 1.05, up: 2.05, forward: 1.25 } as const;
/** 胴体中心（銃口までの遮蔽確認の起点） */
export const CHEST_OFFSET = { right: 0.0, up: 2.0, forward: 0.0 } as const;

export type EnemyKind = 'guard' | 'turret';

export interface EnemySpec {
  kind: EnemyKind;
  hp: number;
  range: number;
  firstDelay: number;
  damage: number;
  bulletSpeed: number;
  burstCount: number;
  burstInterval: number;
  burstPeriod: number;
  telegraph: number;
  bulletLife: number;
  hitRadius: number;
}

export const ENEMY: Record<EnemyKind, EnemySpec> = {
  guard: {
    kind: 'guard',
    hp: 120,
    range: 90,
    firstDelay: 0.5,
    damage: 18,
    bulletSpeed: 70,
    burstCount: 3,
    burstInterval: 0.12,
    burstPeriod: 1.2,
    telegraph: 0.15,
    bulletLife: 2,
    hitRadius: 1.25,
  },
  turret: {
    kind: 'turret',
    hp: 240,
    range: 120,
    firstDelay: 0.7,
    damage: 40,
    bulletSpeed: 60,
    burstCount: 2,
    burstInterval: 0.25,
    burstPeriod: 1.6,
    telegraph: 0.35,
    bulletLife: 3,
    hitRadius: 1.5,
  },
};

export const GUARD_AI = {
  approachSpeed: 8,
  strafeSpeed: 6,
  retreatSpeed: 8,
  patrolSpeed: 3.5,
  farDistance: 55,
  midDistance: 25,
  nearDistance: 15,
  memorySeconds: 8,
  pursuitStartDelay: 0.5,
  shareRadius: 60,
  maxLeadSeconds: 1.2,
  aimSpreadDeg: 0.5,
  halfWidth: 0.9,
  height: 2.6,
  hitCenterHeight: 1.45,
  accel: 40,
  repathSeconds: 0.5,
} as const;

export const TURRET = {
  hitCenterOffset: 1.3,
} as const;

export const NAV = {
  spacing: 3,
  maxStep: 0.6,
} as const;

export const BULLET_RADIUS = 0.12;
