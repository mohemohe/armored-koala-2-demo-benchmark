/**
 * Shared data contracts for the headless simulation, renderer, HUD and bench snapshot.
 * This file is FROZEN during parallel implementation. Module-private bookkeeping goes in the
 * `internal` bags (typed locally via a cast helper) instead of editing these interfaces.
 */
import type { V2, V3 } from './math';
import type { EnemyKind, FcsId, GeneratorId, LegsId, WeaponId } from '../config';
import type { Rng } from './rng';

export type { V2, V3, EnemyKind, FcsId, GeneratorId, LegsId, WeaponId };

export type GameMode = 'garage' | 'playing' | 'paused' | 'cleared' | 'failed';
export type SolutionStatus = 'inactive' | 'solved' | 'no_solution';

export interface Loadout {
  fcs: FcsId;
  generator: GeneratorId;
  legs: LegsId;
}

export interface EffectiveStats {
  maxEn: number;
  regenPerSecond: number;
  lockSeconds: number;
  horizontalSpeedMultiplier: number;
}

// ---------------------------------------------------------------------------
// Input (level-based). The sim does its own edge detection so that key repeat / held keys
// can never re-trigger QB, jump or glide toggles (SPEC §7.2).
// ---------------------------------------------------------------------------
export interface InputState {
  forward: boolean; // W
  back: boolean; // S
  left: boolean; // A
  right: boolean; // D
  jump: boolean; // Space (level)
  shift: boolean; // Shift (level; rising edge toggles glide)
  ctrl: boolean; // Left Ctrl (level; brake)
  qb: boolean; // Q (level; rising edge => QB attempt)
  fire: boolean; // mouse left (level)
  /** one-shot weapon switch request (1/2/3). Consumed (set to null) by the sim on the next tick */
  weaponSelect: WeaponId | null;
}

export const emptyInput = (): InputState => ({
  forward: false,
  back: false,
  left: false,
  right: false,
  jump: false,
  shift: false,
  ctrl: false,
  qb: false,
  fire: false,
  weaponSelect: null,
});

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------
export interface MovementState {
  horizontalMode: 'walk' | 'glide' | 'quickboost';
  verticalMode: 'grounded' | 'rising' | 'flying' | 'falling';
  glideEnabled: boolean;
  /** direction derived from the current input (unit) or {x:0,z:0}. Reported in the snapshot */
  desiredDir: V2;
  /** saved glide direction (unit), kept when input is released */
  glideDir: V2;
  qbSuccessCount: number;
  qbLastStartedAt: number | null;
  /** seconds of QB thrust remaining (0 when not boosting) */
  qbImpulseRemaining: number;
  qbDir: V2;
  /** derived each tick: max(0, qbLastStartedAt + cooldown - time), 0 if never used */
  qbCooldownRemaining: number;
  lastEnSpentAt: number | null;
  /** previous-tick input levels used for edge detection */
  prevInput: { qb: boolean; shift: boolean; jump: boolean };
  /** continuous seconds the jump key has been held (0 when released) */
  jumpHeldSeconds: number;
  /** true when flight thrust was applied during the last integrated tick (renderer: thruster fx) */
  thrusting: boolean;
  /** true while the brake (left Ctrl) is deciding the horizontal target */
  braking: boolean;
}

export interface PlayerState {
  /** center of the hit/collision box (PLAYER.HALF) */
  pos: V3;
  /** position at the start of the last integrated tick (for swept enemy-bullet checks) */
  prevPos: V3;
  /** actual world velocity [m/s] (horizontal + vertical) */
  vel: V3;
  /** aim/camera angles (see math.ts yaw convention). Mouse look edits these */
  yaw: number;
  pitch: number;
  /** visual body yaw (renderer smooths it toward movement/aim) */
  bodyYaw: number;
  grounded: boolean;
  hp: number;
  en: number;
  weapon: WeaponId;
  ammo: { machinegun: number; missile: number };
  /** game time at which each weapon may fire again (kept across weapon switches) */
  nextFireAt: Record<WeaponId, number>;
  mv: MovementState;
  /** leg animation phase accumulator (renderer) */
  walkPhase: number;
  internal: Record<string, unknown>;
}

export interface CameraState {
  pos: V3;
  /** orthonormal basis, camera looks along `forward` */
  forward: V3;
  right: V3;
  up: V3;
  fovYDeg: number;
  near: number;
  far: number;
  /** game viewport in CSS px */
  viewportW: number;
  viewportH: number;
}

// ---------------------------------------------------------------------------
// FCS
// ---------------------------------------------------------------------------
export interface LockState {
  state: 'none' | 'acquiring' | 'locked';
  targetId: string | null;
  /** 0..1 */
  progress: number;
  /** seconds the same target has been continuously valid */
  elapsed: number;
  radiusCssPx: number;
}

export interface FireControlState {
  status: SolutionStatus;
  weapon: WeaponId;
  targetId: string | null;
  evaluatedAtSeconds: number | null;
  muzzlePosition: V3 | null;
  targetPosition: V3 | null;
  targetVelocity: V3 | null;
  launchDirection: V3 | null;
  predictedFlightSeconds: number | null;
  predictedInterceptPosition: V3 | null;
  aimPoint: V3 | null;
  residualMeters: number | null;
}

export const inactiveFireControl = (weapon: WeaponId): FireControlState => ({
  status: 'inactive',
  weapon,
  targetId: null,
  evaluatedAtSeconds: null,
  muzzlePosition: null,
  targetPosition: null,
  targetVelocity: null,
  launchDirection: null,
  predictedFlightSeconds: null,
  predictedInterceptPosition: null,
  aimPoint: null,
  residualMeters: null,
});

export interface ShotRecord {
  id: number;
  firedAtSeconds: number;
  weapon: WeaponId;
  targetId: string | null;
  solutionStatus: SolutionStatus;
  muzzlePosition: V3;
  targetPositionAtFire: V3 | null;
  targetVelocityAtFire: V3 | null;
  launchDirection: V3;
  initialVelocity: V3 | null;
  accelerationAtFire: V3;
  predictedFlightSeconds: number | null;
  predictedInterceptPosition: V3 | null;
}

// ---------------------------------------------------------------------------
// Enemies and projectiles
// ---------------------------------------------------------------------------
export interface EnemyState {
  id: string; // G01..G30, T01..T15
  kind: EnemyKind;
  isGateControl: boolean;
  /** 0..5 for control turrets, else null */
  controlIndex: number | null;
  barrierId: string | null;
  sectorId: string;
  /** hit-box (sphere) center */
  pos: V3;
  /** position at the start of the last integrated tick */
  prevPos: V3;
  /** actual velocity of the hit-box center [m/s] */
  vel: V3;
  yaw: number;
  hitRadius: number;
  maxHp: number;
  hp: number;
  alive: boolean;
  alert: boolean;
  hasLineOfSight: boolean;
  shotsFired: number;
  lastShotAt: number | null;
  /** 0 when idle, else 0..1 progress of the visual pre-fire telegraph (renderer) */
  telegraph: number;
  /** seconds of hit flash remaining (renderer) */
  hitFlash: number;
  /** true for scenario test dummies: no AI, no firing, constant velocity */
  scripted: boolean;
  /** module-private AI bookkeeping (enemies.ts) */
  internal: Record<string, unknown>;
}

export interface PlayerBullet {
  id: number;
  pos: V3;
  prevPos: V3;
  origin: V3;
  /** initial velocity v0 (world) */
  v0: V3;
  age: number;
  damage: number;
  alive: boolean;
}

export interface Missile {
  id: number;
  pos: V3;
  prevPos: V3;
  /** current velocity (|vel| = 45) */
  vel: V3;
  age: number;
  life: number;
  damage: number;
  targetId: string;
  /** last observation of the target (position & velocity) and when it was made */
  lastSeenPos: V3;
  lastSeenVel: V3;
  lastSeenAt: number;
  alive: boolean;
}

export interface EnemyBullet {
  id: number;
  ownerId: string;
  kind: EnemyKind;
  pos: V3;
  prevPos: V3;
  vel: V3;
  age: number;
  maxLife: number;
  damage: number;
  radius: number;
  alive: boolean;
}

// ---------------------------------------------------------------------------
// Events (sim -> renderer/HUD). Renderer drains `state.events` every frame.
// ---------------------------------------------------------------------------
export type GameEvent =
  | { type: 'mgFire'; time: number; origin: V3; dir: V3 }
  | { type: 'beamFire'; time: number; origin: V3; end: V3; hit: 'none' | 'world' | 'enemy'; targetId: string | null }
  | { type: 'missileFire'; time: number; origin: V3; dir: V3 }
  | { type: 'hit'; time: number; pos: V3; normal: V3; on: 'world' | 'enemy' | 'player'; weapon: WeaponId | 'enemy' }
  | { type: 'explosion'; time: number; pos: V3; size: number }
  | { type: 'enemyDown'; time: number; id: string; kind: EnemyKind; pos: V3 }
  | { type: 'enemyTelegraph'; time: number; id: string }
  | { type: 'enemyFire'; time: number; id: string; kind: EnemyKind; origin: V3; dir: V3 }
  | { type: 'playerHit'; time: number; damage: number; fromPos: V3; dirToSource: V3 }
  | { type: 'qb'; time: number; pos: V3; dir: V3 }
  | { type: 'jump'; time: number; pos: V3 }
  | { type: 'land'; time: number; pos: V3; impactSpeed: number }
  | { type: 'barrierOpen'; time: number; barrierId: string }
  | { type: 'gateOpen'; time: number }
  | { type: 'notice'; time: number; kind: 'noLock' | 'noEn' | 'noAmmo' | 'lockAcquired' | 'lockLost' | 'noSolution'; weapon: WeaponId }
  | { type: 'sector'; time: number; sectorId: string }
  | { type: 'custom'; time: number; name: string; data?: unknown };

export interface DamageIndicator {
  time: number;
  /** unit world-space direction from the player toward the shooter */
  dirToSource: V3;
  damage: number;
}

// ---------------------------------------------------------------------------
// World / stage contracts
// ---------------------------------------------------------------------------
export interface AABB {
  min: V3;
  max: V3;
}

export type MaterialKey =
  | 'concrete'
  | 'concreteDark'
  | 'metal'
  | 'metalDark'
  | 'rust'
  | 'hazard'
  | 'grating'
  | 'pipe'
  | 'crate'
  | 'machine'
  | 'glass'
  | 'barrier'
  | 'gate'
  | 'floorTile'
  | 'roof'
  | 'lightPanel';

export interface BoxDef extends AABB {
  id: string;
  mat: MaterialKey;
  sectorId: string;
  /** when set, the box belongs to that barrier/gate and is disabled (removed) when it opens */
  barrierId?: string;
  /** visual-only shape hint; collision is ALWAYS the AABB */
  shape?: 'box' | 'cylX' | 'cylY' | 'cylZ';
  /** emissive strength for lights/warning panels (0..1). purely visual */
  emissive?: number;
}

export interface RayHit {
  /** distance along the (unit) ray direction */
  t: number;
  point: V3;
  normal: V3;
  boxIndex: number;
}

export interface SweepHit {
  /** fraction 0..1 of `delta` travelled before first contact */
  t: number;
  normal: V3;
  boxIndex: number;
}

export interface IWorld {
  readonly boxes: readonly BoxDef[];
  setBoxEnabled(index: number, enabled: boolean): void;
  isBoxEnabled(index: number): boolean;
  indexOfBox(id: string): number;
  /** first ENABLED box hit by the ray o + t*d (d must be unit), 0 <= t <= maxDist */
  raycast(origin: V3, dir: V3, maxDist: number): RayHit | null;
  /** true when any enabled box intersects the closed segment a→b */
  segmentBlocked(a: V3, b: V3): boolean;
  /** first hit of a sphere of `radius` swept along a→b */
  sweepSphere(a: V3, b: V3, radius: number): RayHit | null;
  /** sweep an AABB (center, half extents) along delta. t=fraction travelled. Touching is not a hit for motion away/parallel */
  sweepAABB(center: V3, half: V3, delta: V3): SweepHit | null;
  /** true if the AABB overlaps any enabled box by more than `margin` (default 1e-4) on every axis */
  overlapAABB(center: V3, half: V3, margin?: number): boolean;
  pointInSolid(p: V3): boolean;
}

export type SectorKind =
  | 'dock' // 搬入口
  | 'yard' // 広場
  | 'factory' // 設備のある製造室
  | 'multilevel' // 上下層
  | 'corridor' // 狭い連絡路
  | 'shaft' // 縦坑
  | 'warehouse' // 倉庫
  | 'pipe' // 配管区画
  | 'gate'; // 搬出ゲート

export interface SectorDef {
  id: string; // 'S01'..
  name: string;
  kind: SectorKind;
  /** 3D volume. Sectors must not overlap each other. Player-sector detection uses this AABB */
  bounds: AABB;
  /** main walkable floor top height */
  floorY: number;
  ceilingY: number;
  /** counted as a combat zone (>=60x50 m effective area) */
  combat: boolean;
  note: string;
}

export interface PortalDef {
  id: string;
  a: string;
  b: string;
  /** opening center and clear size */
  center: V3;
  width: number;
  height: number;
  kind: 'door' | 'shaft' | 'tunnel' | 'catwalk' | 'hatch';
  /** barrier id that closes this portal until its control turret dies (null = always open) */
  barrierId: string | null;
}

export interface BarrierDef {
  id: string; // 'B1'..'B6', 'GATE'
  boxIds: string[];
  /** id of the control turret that opens it; null for the final gate */
  controlEnemyId: string | null;
  isFinal: boolean;
  /** human readable direction hint shown in the HUD, e.g. "圧延棟東の隔壁" */
  label: string;
  /** world position for HUD/beacon */
  pos: V3;
}

export interface EnemySpawn {
  id: string;
  kind: EnemyKind;
  sectorId: string;
  /** hit-box center */
  pos: V3;
  yaw: number;
  isGateControl: boolean;
  controlIndex: number | null;
  barrierId: string | null;
  /** optional idle patrol waypoints (guards) */
  patrol?: V3[];
}

export interface RouteDef {
  id: string;
  kind: 'main' | 'branch' | 'loop';
  note: string;
  /** polyline of world-space points the player could follow */
  points: V3[];
  sectorIds: string[];
}

export interface BranchDef {
  id: string;
  splitSectorId: string;
  mergeSectorId: string;
  routes: { id: string; note: string; sectorIds: string[]; points: V3[]; lengthMeters: number }[];
}

export interface ClimbDef {
  id: string;
  sectorId: string;
  /** center of the standing platform below and the landing platform above (top surfaces) */
  from: V3;
  to: V3;
  heightMeters: number;
  note: string;
}

export interface StageDef {
  name: string;
  boxes: BoxDef[];
  sectors: SectorDef[];
  portals: PortalDef[];
  barriers: BarrierDef[];
  enemies: EnemySpawn[];
  playerStart: { pos: V3; yaw: number };
  /** entering this volume after the final gate opens clears the stage */
  escapeZone: AABB;
  /** documented shortest route start→escape (waypoints) */
  mainRoute: RouteDef;
  branches: BranchDef[];
  loops: RouteDef[];
  climbs: ClimbDef[];
  killY: number;
  /** Optional visual-only decoration boxes (no collision), must not intrude into traversable space */
  decor?: BoxDef[];
}

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------
export interface ObjectiveState {
  controlsDestroyed: number;
  openBarrierIds: string[];
  gateOpen: boolean;
}

export interface StageProgress {
  currentSectorId: string | null;
  visitedSectorIds: string[];
}

export interface Notices {
  noLockAt: number | null;
  noEnAt: number | null;
  noAmmoAt: number | null;
  noSolutionAt: number | null;
}

export interface GameState {
  mode: GameMode;
  seed: number;
  /** elapsed game seconds (= tick * SIM.DT) */
  time: number;
  tick: number;
  loadout: Loadout;
  stats: EffectiveStats;
  input: InputState;
  player: PlayerState;
  camera: CameraState;
  lock: LockState;
  fc: FireControlState;
  /** last <=32 shots, oldest first */
  shots: ShotRecord[];
  shotSeq: number;
  enemies: EnemyState[];
  bullets: PlayerBullet[];
  missiles: Missile[];
  enemyBullets: EnemyBullet[];
  events: GameEvent[];
  damageIndicators: DamageIndicator[];
  objective: ObjectiveState;
  progress: StageProgress;
  notices: Notices;
  /** the last result reason when cleared/failed */
  endReason: 'hp' | 'fall' | 'escaped' | null;
  killCount: number;
  /** total damage the player took (stats for the result screen) */
  damageTaken: number;
  /** id counters for projectiles */
  nextProjectileId: number;
  rng: Rng;
  world: IWorld;
  stage: StageDef;
}

export interface AttackerScratch {
  [k: string]: unknown;
}
