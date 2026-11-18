/**
 * ARMORED KOALA 2 — 全モジュール共有の型定義（契約）。
 * シミュレーション（src/sim）、ステージ（src/stage）、描画（src/render）、UI（src/ui）は
 * ここで定義された型だけを介して連携する。
 */

export type Vec3 = [number, number, number];
export type Vec2 = [number, number];

export type Weapon = 'machinegun' | 'beam' | 'missile';
export type FcsKind = 'wide' | 'medium' | 'narrow';
export type GeneratorKind = 'capacity' | 'balanced' | 'recovery';
export type LegsKind = 'biped' | 'quadruped';

export interface Loadout {
  fcs: FcsKind;
  generator: GeneratorKind;
  legs: LegsKind;
}

export type GameState = 'garage' | 'playing' | 'paused' | 'cleared' | 'failed';
export type SolutionStatus = 'inactive' | 'solved' | 'no_solution';
export type HorizontalMode = 'walk' | 'glide' | 'quickboost';
export type VerticalMode = 'grounded' | 'rising' | 'flying' | 'falling';
export type LockState = 'none' | 'acquiring' | 'locked';
/** 'target' は §4.6 の試験用標的（等速移動・非攻撃）。本編ステージには置かない */
export type EnemyKind = 'guard' | 'turret' | 'target';

// ---------------------------------------------------------------------------
// 衝突
// ---------------------------------------------------------------------------

export interface AABB {
  min: Vec3;
  max: Vec3;
}

export interface RayHit {
  /** raycast: 原点からの距離 [m]。sweepSphere: 区間 a→b 上の割合 [0,1] */
  t: number;
  point: Vec3;
  /** 接触面の法線（軸に平行な単位ベクトル） */
  normal: Vec3;
  colliderId: number;
  tag?: string;
}

export interface MoveResult {
  /** 移動後の中心位置 */
  position: Vec3;
  hitNegX: boolean;
  hitPosX: boolean;
  /** 下向き移動で床に接触した（着地） */
  hitNegY: boolean;
  /** 上向き移動で天井に接触した */
  hitPosY: boolean;
  hitNegZ: boolean;
  hitPosZ: boolean;
}

export interface ColliderEntry {
  id: number;
  box: AABB;
  tag?: string;
}

/**
 * 静的AABB群からなる衝突ワールド。隔壁・ゲートは add/remove で開閉する。
 * すべての問い合わせは「ステージ遮蔽物」だけを対象とし、敵やプレイヤーは含まない。
 */
export interface CollisionWorld {
  addCollider(box: AABB, tag?: string): number;
  removeCollider(id: number): void;
  hasCollider(id: number): boolean;
  colliders(): readonly ColliderEntry[];
  /** 原点から単位方向 dir へ最大 maxDist [m] のレイ。最初の衝突を返す */
  raycast(origin: Vec3, dir: Vec3, maxDist: number): RayHit | null;
  /** 線分 a→b が何らかの遮蔽物と交差するか（LOS判定） */
  segmentBlocked(a: Vec3, b: Vec3): boolean;
  /**
   * 半径 radius の球を a→b へ掃引したときの最初の衝突（AABB を radius だけ拡張した近似）。
   * t は a→b 上の割合 [0,1]。開始時点で既に重なっていれば t=0 を返す。
   */
  sweepSphere(a: Vec3, b: Vec3, radius: number): RayHit | null;
  /**
   * 軸整列ボックス（中心 center、半径 halfExtents）を delta だけ移動させる。
   * Y → X → Z の順に各軸で掃引し、接触面で停止する（すり抜けなし）。
   */
  moveBox(center: Vec3, halfExtents: Vec3, delta: Vec3): MoveResult;
  /** ボックスが遮蔽物と重なっているか */
  boxOverlaps(center: Vec3, halfExtents: Vec3): boolean;
  /** 全体の境界（ナビ生成に使用） */
  bounds(): AABB;
}

// ---------------------------------------------------------------------------
// 入力
// ---------------------------------------------------------------------------

/**
 * 1描画フレーム分の入力。edge(*Pressed) は「離された状態から押された瞬間」だけ true になり、
 * OSのキーリピートでは true にならない。Game.advance() の先頭で一度だけ消費される。
 */
export interface InputFrame {
  /** W=+1, S=-1（カメラ水平前方基準） */
  moveForward: number;
  /** D=+1, A=-1 */
  moveRight: number;
  /** Q 押下エッジ（QB要求） */
  qbPressed: boolean;
  /** Shift 押下エッジ（グライド切り替え） */
  shiftPressed: boolean;
  /** Space 押下エッジ */
  spacePressed: boolean;
  /** Space 押下中 */
  spaceDown: boolean;
  /** 左Ctrl 押下中（ブレーキ） */
  ctrlDown: boolean;
  /** マウス左ボタン押下中（射撃） */
  fireDown: boolean;
  /** 1/2/3 押下エッジ */
  weaponSelect: Weapon | null;
  /** マウス移動量 [px]（このフレームの累計） */
  lookDeltaX: number;
  lookDeltaY: number;
}

export function emptyInput(): InputFrame {
  return {
    moveForward: 0,
    moveRight: 0,
    qbPressed: false,
    shiftPressed: false,
    spacePressed: false,
    spaceDown: false,
    ctrlDown: false,
    fireDown: false,
    weaponSelect: null,
    lookDeltaX: 0,
    lookDeltaY: 0,
  };
}

// ---------------------------------------------------------------------------
// ステージ定義（データ）
// ---------------------------------------------------------------------------

/** 空間構成の種類（仕様 §2.2「6種類以上」） */
export type SectorKind =
  | 'yard' // 広場・資材ヤード
  | 'factory' // 設備のある製造室
  | 'multilevel' // 上下層
  | 'corridor' // 狭い連絡路
  | 'shaft' // 縦坑
  | 'warehouse' // 倉庫
  | 'piping' // 配管区画
  | 'power' // 動力・冷却設備
  | 'gate'; // 搬入口・搬出ゲート

export interface SectorDef {
  id: string;
  name: string;
  kind: SectorKind;
  /** 区画の範囲（複数AABBの和集合）。プレイヤーの当たり判定中心がこの中にあれば「その区画にいる」 */
  bounds: AABB[];
  description?: string;
}

/** 描画側でマテリアルへ対応付けるキー */
export type MaterialKey =
  | 'concrete'
  | 'concreteDark'
  | 'floorPlate'
  | 'steel'
  | 'steelDark'
  | 'rust'
  | 'grate'
  | 'catwalk'
  | 'machine'
  | 'machineDark'
  | 'pipe'
  | 'pipeRust'
  | 'hazard'
  | 'barrier'
  | 'gate'
  | 'brick'
  | 'crate'
  | 'container'
  | 'glassBroken'
  | 'lampRed'
  | 'lampAmber'
  | 'lampGreen'
  | 'lampWhite'
  | 'controlSign'
  | 'exitSign';

/** 衝突あり・描画ありの直方体 */
export interface SolidDef {
  box: AABB;
  material: MaterialKey;
  sectorId?: string;
  label?: string;
}

/** 衝突なし・描画のみの装飾 */
export interface DecorDef {
  kind: 'box' | 'cylinder' | 'lamp' | 'arrow' | 'label';
  /** box: AABB。cylinder: 中心 position + radius + height + axis。lamp: position。arrow: position + yaw。label: position + text */
  box?: AABB;
  position?: Vec3;
  radius?: number;
  height?: number;
  axis?: 'x' | 'y' | 'z';
  yaw?: number;
  material?: MaterialKey;
  /** 発光色（0xRRGGBB） */
  emissive?: number;
  text?: string;
  sectorId?: string;
}

export interface BarrierDef {
  id: string;
  /** 閉鎖中の衝突ボックス（見た目と一致させる） */
  box: AABB;
  /** この隔壁を制御する固定砲台の ID */
  controlTurretId: string;
  fromSectorId: string;
  toSectorId: string;
  label?: string;
}

export interface GateDef {
  id: string;
  box: AABB;
  label?: string;
}

export interface EnemyDef {
  id: string;
  kind: EnemyKind;
  /** 足元位置（床の上面） */
  position: Vec3;
  yaw: number;
  sectorId: string;
  /** 隔壁制御砲台か（固定砲台のみ true になり得る） */
  isGateControl: boolean;
  /** isGateControl のとき、対応する隔壁 ID */
  controlsBarrierId?: string;
  /** kind='target' のみ: 等速移動速度 */
  velocity?: Vec3;
  /** 警備ロボットの待機時の巡回点（任意） */
  patrol?: Vec3[];
}

export interface LightDef {
  position: Vec3;
  color: number;
  intensity: number;
  distance: number;
  sectorId?: string;
}

export interface RouteWaypoint {
  position: Vec3;
  sectorId: string;
  note?: string;
}

export interface FlightPointDef {
  id: string;
  sectorId: string;
  /** 離陸する足場（接地してEN回復できる） */
  from: Vec3;
  /** 着地する足場 */
  to: Vec3;
  /** 高低差 [m]（6〜16） */
  heightDiff: number;
  note?: string;
}

export interface BranchDef {
  id: string;
  /** 分岐点と再合流点の区画 */
  splitSectorId: string;
  mergeSectorId: string;
  /** 各経路が通る区画列と特徴 */
  routes: { sectorIds: string[]; description: string }[];
}

export interface LoopDef {
  id: string;
  /** 環状に並ぶ区画列（先頭に戻る） */
  sectorIds: string[];
  description: string;
}

export interface StageData {
  id: string;
  name: string;
  start: { position: Vec3; yaw: number; sectorId: string };
  /** 最終ゲート開放後、ここに入るとクリア */
  exitZone: AABB;
  /** これより下に落下したら失敗 */
  killY: number;
  sectors: SectorDef[];
  solids: SolidDef[];
  decor: DecorDef[];
  lights: LightDef[];
  barriers: BarrierDef[];
  gate: GateDef;
  enemies: EnemyDef[];
  /** 正規攻略経路（記録用） */
  route: RouteWaypoint[];
  /** 必須の飛行昇降箇所（6か所以上） */
  flightPoints: FlightPointDef[];
  branches: BranchDef[];
  loops: LoopDef[];
  /** 60m×50m 以上の戦闘区画 ID（5以上） */
  arenaSectorIds: string[];
  /** 4体以上が独立に射線を取り得る区画とその敵 ID（5以上） */
  crossfireSectors: { sectorId: string; enemyIds: string[] }[];
  /** 区画ごとの「次の目標」説明（HUD 用）。キーは区画 ID */
  objectiveHints: Record<string, string>;
  /** 警備ロボットのナビ生成に使う床面高さの候補（任意） */
  navFloorLevels?: number[];
}

// ---------------------------------------------------------------------------
// 対象・当たり判定
// ---------------------------------------------------------------------------

/** FCS のロック候補・照準対象としての敵情報（同一シミュレーション時刻の値） */
export interface TargetInfo {
  id: string;
  alive: boolean;
  /** 当たり判定中心 */
  center: Vec3;
  /** 当たり判定中心の実際の速度 [m/s] */
  velocity: Vec3;
  radius: number;
}

/** 弾体との掃引衝突用（同一更新区間の前後位置） */
export interface HittableSphere {
  id: string;
  prevCenter: Vec3;
  center: Vec3;
  radius: number;
  alive: boolean;
}

export interface HittableBox {
  prevCenter: Vec3;
  center: Vec3;
  halfExtents: Vec3;
}

// ---------------------------------------------------------------------------
// 射撃管制
// ---------------------------------------------------------------------------

export interface FireSolution {
  status: SolutionStatus;
  weapon: Weapon;
  targetId: string | null;
  evaluatedAtSeconds: number | null;
  muzzlePosition: Vec3 | null;
  targetPosition: Vec3 | null;
  targetVelocity: Vec3 | null;
  launchDirection: Vec3 | null;
  predictedFlightSeconds: number | null;
  predictedInterceptPosition: Vec3 | null;
  aimPoint: Vec3 | null;
  residualMeters: number | null;
}

export interface ShotRecord {
  id: number;
  firedAtSeconds: number;
  weapon: Weapon;
  targetId: string | null;
  solutionStatus: SolutionStatus;
  muzzlePosition: Vec3;
  targetPositionAtFire: Vec3 | null;
  targetVelocityAtFire: Vec3 | null;
  launchDirection: Vec3;
  initialVelocity: Vec3 | null;
  accelerationAtFire: Vec3;
  predictedFlightSeconds: number | null;
  predictedInterceptPosition: Vec3 | null;
}

export type FireDenialReason = 'noAmmo' | 'noEn' | 'noLock';

// ---------------------------------------------------------------------------
// スナップショット（§10）
// ---------------------------------------------------------------------------

export interface Snapshot {
  version: 'AK2-1.2-candidate';
  seed: number;
  state: GameState;
  elapsedSeconds: number;
  loadout: Loadout;
  player: {
    position: Vec3;
    velocity: Vec3;
    grounded: boolean;
    hp: number;
    en: number;
    weapon: Weapon;
    ammo: { machinegun: number; missile: number };
    movement: {
      horizontalMode: HorizontalMode;
      verticalMode: VerticalMode;
      glideEnabled: boolean;
      desiredHorizontalDirection: Vec2;
      qbSuccessfulCount: number;
      qbLastStartedAtSeconds: number | null;
      qbImpulseRemainingSeconds: number;
      qbCooldownRemainingSeconds: number;
      lastEnSpentAtSeconds: number | null;
    };
  };
  effectiveStats: {
    maxEn: number;
    regenPerSecond: number;
    lockSeconds: number;
    horizontalSpeedMultiplier: number;
  };
  lock: {
    state: LockState;
    targetId: string | null;
    progress: number;
    radiusCssPx: number;
  };
  fireControl: FireSolution;
  recentPlayerShots: ShotRecord[];
  enemies: Array<{
    id: string;
    kind: 'guard' | 'turret';
    isGateControl: boolean;
    sectorId: string;
    position: Vec3;
    velocity: Vec3;
    hp: number;
    alive: boolean;
    alert: boolean;
    hasLineOfSight: boolean;
    shotsFired: number;
    lastShotAtSeconds: number | null;
  }>;
  objective: {
    controlsDestroyed: number;
    controlsRequired: 6;
    openBarrierIds: string[];
    gateOpen: boolean;
  };
  stage: {
    sectorCount: number;
    currentSectorId: string | null;
    visitedSectorIds: string[];
    totalEnemies: 45;
  };
}

// ---------------------------------------------------------------------------
// シミュレーション → 描画/HUD へのイベント
// ---------------------------------------------------------------------------

export type SimEvent =
  | { type: 'mgFire'; muzzle: Vec3; direction: Vec3 }
  | { type: 'beamFire'; from: Vec3; to: Vec3; hitEnemyId: string | null }
  | { type: 'missileFire'; muzzle: Vec3; direction: Vec3 }
  | { type: 'enemyHit'; enemyId: string; point: Vec3; weapon: Weapon }
  | { type: 'worldHit'; point: Vec3; normal: Vec3; source: 'machinegun' | 'missile' | 'enemy' }
  | { type: 'missileExpired'; point: Vec3 }
  | { type: 'playerHit'; point: Vec3; fromDirection: Vec3; damage: number }
  | { type: 'enemyDestroyed'; enemyId: string; kind: 'guard' | 'turret'; position: Vec3 }
  | { type: 'enemyFire'; enemyId: string; muzzle: Vec3; direction: Vec3 }
  | { type: 'enemyTelegraph'; enemyId: string }
  | { type: 'qbStart'; position: Vec3; direction: Vec3 }
  | { type: 'jump'; position: Vec3 }
  | { type: 'landed'; position: Vec3 }
  | { type: 'barrierOpened'; barrierId: string }
  | { type: 'gateOpened' }
  | { type: 'fireDenied'; weapon: Weapon; reason: FireDenialReason }
  | { type: 'cleared' }
  | { type: 'failed'; reason: 'hp' | 'fall' };

// ---------------------------------------------------------------------------
// 描画側が読むビュー（シミュレーションの公開状態）
// ---------------------------------------------------------------------------

export interface PlayerView {
  /** 足元位置 */
  position: Vec3;
  velocity: Vec3;
  /** 機体ヨー（カメラヨーと一致） */
  yaw: number;
  /** 腕・武器の実際の射出方向（単位）。補正射撃時は補正方向、自由射撃時は照準点方向 */
  aimDirection: Vec3;
  muzzlePosition: Vec3;
  legs: LegsKind;
  weapon: Weapon;
  grounded: boolean;
  horizontalMode: HorizontalMode;
  verticalMode: VerticalMode;
  glideEnabled: boolean;
  /** QB噴射中 */
  boosting: boolean;
  /** 飛行推進中 */
  thrusting: boolean;
  alive: boolean;
}

export interface EnemyView {
  id: string;
  kind: EnemyKind;
  position: Vec3;
  yaw: number;
  /** 砲身の向き（単位） */
  gunDirection: Vec3;
  alive: boolean;
  /** 予告中（明滅させる） */
  telegraphing: boolean;
  alert: boolean;
  isGateControl: boolean;
  hp: number;
  maxHp: number;
  /** 当たり判定球の中心と半径 */
  center: Vec3;
  radius: number;
}

export interface ProjectileView {
  kind: 'machinegun' | 'missile' | 'enemy';
  position: Vec3;
  /** 進行方向（単位） */
  direction: Vec3;
}

// ---------------------------------------------------------------------------
// HUD ビュー（main が Game から毎フレーム組み立てる）
// ---------------------------------------------------------------------------

export interface ScreenMarker {
  x: number;
  y: number;
  /** 画面内か（画面外なら端の方向表示に使う） */
  onScreen: boolean;
  /** 画面中心からの角度 [rad]（画面外表示用。右=0、上=-π/2） */
  angle: number;
}

export interface HudView {
  state: GameState;
  viewportWidth: number;
  viewportHeight: number;
  elapsedSeconds: number;
  hp: number;
  maxHp: number;
  en: number;
  maxEn: number;
  regenPerSecond: number;
  weapon: Weapon;
  ammo: { machinegun: number; missile: number };
  beamEnCost: number;
  lock: {
    state: LockState;
    targetId: string | null;
    progress: number;
    radiusCssPx: number;
    lockSeconds: number;
  };
  /** 対象の現在位置マーカー */
  targetMarker: ScreenMarker | null;
  /** 補正照準マーカー（ロック完了時のみ非 null） */
  aimMarker: (ScreenMarker & { status: SolutionStatus }) | null;
  fireControl: FireSolution;
  /** 直近の発射拒否（数秒間表示） */
  fireDenied: { weapon: Weapon; reason: FireDenialReason; ageSeconds: number } | null;
  movement: {
    horizontalMode: HorizontalMode;
    verticalMode: VerticalMode;
    glideEnabled: boolean;
    qbReady: boolean;
    qbCooldownRemainingSeconds: number;
    qbImpulseRemainingSeconds: number;
    qbCost: number;
    speed: number;
    /** 脚部の水平移動速度倍率（定常グライド速度の表示に使用） */
    horizontalSpeedMultiplier: number;
  };
  objective: {
    currentSectorId: string | null;
    currentSectorName: string;
    nextObjective: string;
    controlsDestroyed: number;
    controlsRequired: number;
    openBarrierIds: string[];
    /** 直近に開いた隔壁のラベル（数秒表示） */
    recentBarrierLabel: string | null;
    gateOpen: boolean;
    enemiesAlive: number;
    enemiesTotal: number;
  };
  /** 被弾方向（画面中心基準の角度。0=前方、正=時計回り）と経過時間 */
  hitIndicators: { angle: number; ageSeconds: number }[];
  /** 予告中の敵のマーカー */
  telegraphMarkers: ScreenMarker[];
  /** 制御砲台の位置マーカー（識別用） */
  controlTurretMarkers: (ScreenMarker & { id: string; alive: boolean })[];
  /** 最終ゲート/次の隔壁の方向マーカー */
  objectiveMarker: (ScreenMarker & { label: string }) | null;
  /** ポインターロックの取得失敗メッセージ */
  pointerLockError: string | null;
}
