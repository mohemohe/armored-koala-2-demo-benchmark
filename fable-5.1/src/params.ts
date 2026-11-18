/**
 * ARMORED KOALA 2 — 全ゲームパラメーターの唯一の定義場所。
 * HUD・格納庫・ベンチAPI・シミュレーションは必ずここを参照する。
 * 仕様書: docs/SPEC.md
 */
import type { FcsKind, GeneratorKind, LegsKind, Loadout, Vec3, Weapon } from './types';

export const SNAPSHOT_VERSION = 'AK2-1.2-candidate' as const;
export const DEFAULT_SEED = 20260908;

/** シミュレーション刻み */
export const SIM = {
  /** 最大更新幅 [s]（仕様: 1/120秒以下） */
  maxStep: 1 / 120,
  /** 1フレームで処理する実時間の上限 [s]（それ以上は切り捨て、まとめて加算しない） */
  maxFrameSeconds: 0.25,
} as const;

/** プレイヤー機体 */
export const PLAYER = {
  maxHp: 1000,
  /** 通常移動の基準速度 [m/s]（脚部倍率適用） */
  walkSpeed: 10,
  /** 地上グライド速度 [m/s]（脚部倍率適用） */
  glideGroundSpeed: 22,
  /** 空中の定常水平速度 [m/s]（脚部倍率適用。飛行中・非飛行中共通） */
  airSpeed: 16,
  /** ジャンプ初速 [m/s]（脚部倍率なし） */
  jumpSpeed: 10,
  /** 飛行の上昇速度 [m/s]（脚部倍率なし） */
  flightRiseSpeed: 8,
  /** 飛行のEN消費 [EN/s] */
  flightEnPerSecond: 20,
  /** 飛行へ移行するためのSpace押下時間 [s] */
  flightHoldSeconds: 0.2,
  /** 重力加速度 [m/s²]（下向き） */
  gravity: 18,
  /** 通常移動・ブレーキの水平加減速上限 [m/s²]（脚部倍率適用） */
  walkAccel: 120,
  /** EN回復までの待ち時間 [s]（最後の実際のEN消費から） */
  enRegenDelaySeconds: 0.75,
  qb: {
    /** QB初速 [m/s]（脚部倍率適用） */
    speed: 80,
    /** 噴射時間 [s] */
    impulseSeconds: 0.15,
    /** 発動時のEN消費 */
    cost: 36,
    /** 前のQB開始から次の発動までの最短間隔 [s] */
    cooldownSeconds: 1.0,
    /** 噴射後、グライド速度へ減速する時間 [s]（速度変化上限の算出に使用） */
    decelSeconds: 0.6,
  },
  /** 当たり判定（AABB）: 足元原点からの半径。中心は pos + hitCenterOffset */
  halfExtents: [0.8, 1.5, 0.8] as Vec3,
  hitCenterOffset: [0, 1.5, 0] as Vec3,
  /** 銃口位置: 機体ヨー回転後のローカルオフセット（足元原点、右手武器）。前方は -Z */
  muzzleOffset: [0.95, 2.05, -0.9] as Vec3,
  /** カメラ注視点（足元原点からの高さ） */
  cameraPivotOffset: [0, 2.3, 0] as Vec3,
  /** この高度より下へ落下したら失敗 */
  fallKillY: -60,
} as const;

/** 武器 */
export const WEAPONS = {
  machinegun: {
    damage: 12,
    interval: 0.1,
    ammo: 300,
    enCost: 0,
    /** ワールド座標系の初速 [m/s] */
    speed: 100,
    /** 弾体の重力加速度 [m/s²] */
    gravity: [0, -18, 0] as Vec3,
    lifetime: 2,
    /** 弾体半径 [m] */
    radius: 0.08,
    /** 補正解の到達時間上限 [s] */
    solveMaxTime: 2,
    /** 採用時刻における弾体と等速予測対象中心の距離の上限 [m]（§4.3） */
    maxResidualMeters: 0.01,
    /** 重力軌道を線分で近似するときの曲線からの最大ずれ [m]（§4.5） */
    maxChordDeviationMeters: 0.01,
  },
  beam: {
    damage: 40,
    interval: 0.25,
    enCost: 8,
    range: 120,
  },
  missile: {
    damage: 180,
    interval: 1.0,
    ammo: 12,
    speed: 45,
    /** 旋回速度上限 [deg/s] */
    turnRateDeg: 120,
    lifetime: 4,
    radius: 0.25,
    /** 偏差解の到達時間上限 [s]（発射時。飛行中は残り寿命） */
    solveMaxTime: 4,
  },
} as const;

/** FCS */
export const FCS = {
  /** ロック可能距離（銃口から）[m] */
  range: 120,
  kinds: {
    wide: { radiusFactor: 0.3, lockSeconds: 1.2, label: '広範囲' },
    medium: { radiusFactor: 0.2, lockSeconds: 0.8, label: '中範囲' },
    narrow: { radiusFactor: 0.1, lockSeconds: 0.4, label: '狭範囲' },
  } as Record<FcsKind, { radiusFactor: number; lockSeconds: number; label: string }>,
} as const;

/** ジェネレーター */
export const GENERATORS: Record<GeneratorKind, { maxEn: number; regen: number; label: string }> = {
  capacity: { maxEn: 180, regen: 10, label: '大容量' },
  balanced: { maxEn: 120, regen: 15, label: '均衡' },
  recovery: { maxEn: 90, regen: 20, label: '高回復' },
};

/** 脚部 */
export const LEGS: Record<LegsKind, { speedMul: number; regenMul: number; lockSpeedMul: number; label: string }> = {
  biped: { speedMul: 1.0, regenMul: 1.0, lockSpeedMul: 1.0, label: '2脚' },
  quadruped: { speedMul: 0.8, regenMul: 0.75, lockSpeedMul: 1.5, label: '4脚' },
};

export const DEFAULT_LOADOUT: Loadout = { fcs: 'medium', generator: 'balanced', legs: 'biped' };
export const DEFAULT_WEAPON: Weapon = 'machinegun';

/** 敵 */
export const ENEMIES = {
  guard: {
    hp: 120,
    detectRange: 90,
    firstShotDelay: 0.5,
    damage: 18,
    bulletSpeed: 70,
    burstCount: 3,
    burstInterval: 0.12,
    burstPeriod: 1.2,
    telegraphSeconds: 0.15,
    bulletLifetime: 2,
    approachSpeed: 8,
    strafeSpeed: 6,
    retreatSpeed: 8,
    /** これより遠ければ接近 */
    farDistance: 55,
    /** 25〜55mで側方移動 */
    strafeDistance: 25,
    /** これより近ければ後退 */
    retreatDistance: 15,
    memorySeconds: 8,
    /** 遮蔽後、移動を開始するまでの上限 [s] */
    reactAfterOcclusion: 0.5,
    /** 最後の確認位置を共有する経路距離 [m] */
    shareRange: 60,
    /** 当たり判定球の半径と中心（足元原点） */
    radius: 1.3,
    centerOffset: [0, 1.4, 0] as Vec3,
    /** 移動衝突用AABB半径 */
    halfExtents: [0.9, 1.4, 0.9] as Vec3,
    /** 銃口（足元原点、機体ヨー回転後）。前方は -Z */
    muzzleOffset: [0.7, 1.7, -1.5] as Vec3,
    aimSpreadDeg: 0.5,
    leadMaxSeconds: 1.2,
    gravity: 18,
  },
  turret: {
    hp: 240,
    detectRange: 120,
    firstShotDelay: 0.7,
    damage: 40,
    bulletSpeed: 60,
    burstCount: 2,
    burstInterval: 0.25,
    burstPeriod: 1.6,
    telegraphSeconds: 0.35,
    bulletLifetime: 3,
    memorySeconds: 8,
    radius: 1.6,
    centerOffset: [0, 1.5, 0] as Vec3,
    halfExtents: [1.4, 1.5, 1.4] as Vec3,
    /** 砲塔の回転中心（足元原点）と砲身長 */
    gunPivotOffset: [0, 2.0, 0] as Vec3,
    gunLength: 1.6,
    aimSpreadDeg: 0.5,
    leadMaxSeconds: 1.2,
  },
  /** 試験用標的（等速移動・非攻撃）。本編ステージでは使用しない */
  target: {
    hp: 1e9,
    radius: 0.5,
    centerOffset: [0, 0, 0] as Vec3,
  },
  /** 敵弾の半径 [m] */
  bulletRadius: 0.2,
} as const;

/** 目標 */
export const OBJECTIVE = {
  controlsRequired: 6 as const,
  totalEnemies: 45 as const,
  guards: 30,
  turrets: 15,
} as const;

/** カメラ */
export const CAMERA = {
  fovYDeg: 70,
  /** 注視点からの距離 [m] */
  distance: 8.5,
  /** 注視点からの上方向オフセット [m] */
  height: 1.6,
  /** 右肩越しの横オフセット [m] */
  shoulder: 1.4,
  near: 0.1,
  far: 900,
  /** 壁からの押し戻し余裕 [m] */
  collisionMargin: 0.35,
  /** マウス感度 [rad/px] */
  sensitivity: 0.0022,
  minPitch: -1.2,
  maxPitch: 1.2,
  /** 自由射撃の照準レイ最大距離 [m] */
  freeAimDistance: 1000,
} as const;

/** ステージ共通 */
export const STAGE = {
  /** 敵の同一区画/隣接判定に使う余裕 */
  sectorMargin: 0.5,
} as const;

/** 診断 */
export const DIAG = {
  recentShots: 32,
} as const;

export interface EffectiveStats {
  maxEn: number;
  regenPerSecond: number;
  lockSeconds: number;
  horizontalSpeedMultiplier: number;
  lockRadiusFactor: number;
}

/** 構成から実効値を計算する（格納庫表示とゲームロジックで共用） */
export function computeEffectiveStats(loadout: Loadout): EffectiveStats {
  const gen = GENERATORS[loadout.generator];
  const legs = LEGS[loadout.legs];
  const fcs = FCS.kinds[loadout.fcs];
  return {
    maxEn: gen.maxEn,
    regenPerSecond: gen.regen * legs.regenMul,
    lockSeconds: fcs.lockSeconds / legs.lockSpeedMul,
    horizontalSpeedMultiplier: legs.speedMul,
    lockRadiusFactor: fcs.radiusFactor,
  };
}

/** ロック円の半径 [CSS px]。D = min(幅, 高さ) */
export function lockRadiusCssPx(fcs: FcsKind, viewportWidth: number, viewportHeight: number): number {
  const d = Math.min(viewportWidth, viewportHeight);
  return FCS.kinds[fcs].radiusFactor * d;
}

/** 格納庫の説明文（長所・短所） */
export const PART_DESCRIPTIONS = {
  fcs: {
    wide: { pros: 'ロック円が最も広く（半径0.30D）、対象を捉えやすい', cons: 'ロック所要時間が最長（2脚1.20秒）' },
    medium: { pros: 'ロック円と所要時間の均衡（半径0.20D、2脚0.80秒）', cons: '突出した性能はない' },
    narrow: { pros: 'ロック所要時間が最短（2脚0.40秒）', cons: 'ロック円が狭く（半径0.10D）、対象を中央付近に保つ必要がある' },
  },
  generator: {
    capacity: { pros: '最大EN180。連続飛行とQBの余裕が大きい', cons: '回復率10 EN/秒と低く、消費後の立て直しが遅い' },
    balanced: { pros: '最大EN120・回復15 EN/秒の均衡型', cons: '容量も回復も中庸' },
    recovery: { pros: '回復率20 EN/秒。短い消費を繰り返す運用に強い', cons: '最大EN90。QB2回で枯渇し、長い飛行に不向き' },
  },
  legs: {
    biped: { pros: '水平移動速度が最速（倍率1.00）。EN回復倍率1.00', cons: 'ロック速度倍率1.00で、4脚より照準完了が遅い' },
    quadruped: { pros: 'ロック速度1.50倍（所要時間が約2/3）', cons: '水平移動速度0.80倍、EN回復0.75倍' },
  },
} as const;
