/**
 * Shared data contracts of the AK2 simulation. See docs/ARCHITECTURE.md for the conventions
 * (coordinates, time stepping, module responsibilities) that go with these types.
 *
 * Rules:
 *  - Positions/velocities are world space, metres and seconds, +Y up.
 *  - `pos` of the player and of every enemy is the CENTRE OF ITS HIT VOLUME (当たり判定中心).
 *  - The simulation must not import three.js.
 */
import type { V3 } from '../core/vec';

// ───────────────────────────── loadout ─────────────────────────────
export type Weapon = 'machinegun' | 'beam' | 'missile';
export type FcsId = 'wide' | 'medium' | 'narrow';
export type GeneratorId = 'capacity' | 'balanced' | 'recovery';
export type LegsId = 'biped' | 'quadruped';
export interface Loadout {
  fcs: FcsId;
  generator: GeneratorId;
  legs: LegsId;
}

// ───────────────────────────── stage definition ─────────────────────────────
/** Axis-aligned box. All stage collision is made of these (no rotated or sloped geometry). */
export interface Box {
  min: V3;
  max: V3;
}

/** Visual material tag of a solid. Every solid is opaque to movement, bullets, beams and line of sight. */
export type SolidMaterial =
  | 'floor' // concrete slab floors
  | 'wall' // structural walls
  | 'roof' // ceilings / roof slabs
  | 'concrete' // generic concrete blocks, pillars, ramps' substitutes
  | 'metal' // steel plates, frames, generic machinery housings
  | 'rust' // corroded steel
  | 'hazard' // yellow/black striped edges, barrier frames
  | 'catwalk' // elevated walkways / platforms (drawn as opaque checker plate)
  | 'machine' // production machinery bodies
  | 'container' // shipping containers / crates
  | 'pipe' // large collidable pipes / ducts / tanks
  | 'dark'; // out-of-bounds filler

export interface SolidDef extends Box {
  material: SolidMaterial;
  /** Sector the solid visually belongs to (optional, used for culling/grouping only). */
  sectorId?: string;
  /** Free-form note for humans/debugging. */
  tag?: string;
}

/** Non-colliding visual detail. Must never visually block an opening that the player can pass through. */
export interface DecorDef extends Box {
  shape: 'box' | 'cylinder-x' | 'cylinder-y' | 'cylinder-z';
  material: SolidMaterial | 'light-warm' | 'light-red' | 'light-amber' | 'light-cyan' | 'glass';
  /** Emissive lamps may blink (warning lights). */
  blink?: boolean;
  sectorId?: string;
}

/**
 * Flat wayfinding marking on a wall or floor: stencilled text / chevrons, a plain rectangle or a hazard band.
 * Render-only — paint or an illuminated sign face without thickness: no collision, not part of the decor.
 */
export interface MarkingDef {
  /** Centre of the marking on its surface. */
  position: V3;
  /** Outward normal of the surface it lies on (the side it is seen from). */
  facing: 'x+' | 'x-' | 'y+' | 'z+' | 'z-';
  /** Floor markings ('y+') only: the horizontal direction the top of the marking points to (default 'z-'). */
  top?: 'x+' | 'x-' | 'z+' | 'z-';
  /**
   * Characters of the 5×7 stencil font (A–Z, 0–9, '-', '+', '/', '.') plus the chevrons '^' '<' '>' and a
   * lower-case 'v' (down); ' ' is a gap.
   * Omit for a plain rectangle of `width` × `height`.
   */
  text?: string;
  /** Overall size in metres (text is scaled to fit inside, keeping its proportions). */
  width: number;
  height: number;
  /** 'yellow' / 'white' / 'hazard' / 'dark' are paint (lit like the surface below); 'glow-*' are illuminated faces. */
  style: 'yellow' | 'white' | 'hazard' | 'dark' | 'glow-amber' | 'glow-red' | 'glow-green' | 'glow-cyan';
  /**
   * Illuminated markings only: the marking pulses brighter in a running sequence (direction cue). The value is
   * its phase 0..1 within the sequence (markings of one sequence use increasing phases along the direction).
   */
  chase?: number;
  /** Shown only while this barrier (BarrierDef.id) or the final gate is still closed. */
  untilBarrierOpen?: string;
  /** Shown only once this barrier (BarrierDef.id) or the final gate has opened. */
  afterBarrierOpen?: string;
  sectorId?: string;
}

export type SectorKind =
  | 'dock' // sheltered entry
  | 'yard' // open plaza / material yard
  | 'factory' // machine-filled production hall
  | 'multilevel' // hall with stacked floors / mezzanines
  | 'corridor' // narrow connector / pipe gallery
  | 'shaft' // vertical shaft
  | 'warehouse' // rack / container storage
  | 'tunnel' // underground conveyor tunnel
  | 'plant' // power / cooling plant
  | 'road' // perimeter haul road
  | 'gate'; // final gate + exit

export interface SectorDef {
  id: string; // e.g. "S01"
  name: string; // Japanese display name, e.g. "搬入口"
  nameEn: string;
  kind: SectorKind;
  /** One or more boxes; a point belongs to the sector if it is inside any of them. Sectors must not overlap. */
  bounds: Box[];
  /** True for the >= 60 m x 50 m combat arenas. */
  combatArena?: boolean;
}

export interface BarrierDef {
  id: string; // e.g. "B1"
  name: string;
  /** Solid while closed; removed from collision/LOS/navigation when the control turret dies. */
  box: Box;
  /** Enemy id (a turret with isGateControl = true) whose destruction opens this barrier. */
  controlEnemyId: string;
  fromSectorId: string;
  toSectorId: string;
}

export interface FinalGateDef {
  id: string; // "GATE"
  name: string;
  /** Solid until all control turrets are destroyed. */
  box: Box;
}

export interface EnemyDef {
  id: string; // stable unique id, e.g. "G01".."G30", "T01".."T15"
  kind: 'guard' | 'turret';
  sectorId: string;
  /** Initial hit-sphere centre. */
  position: V3;
  /** Initial facing (visual only). */
  yaw?: number;
  isGateControl: boolean;
  /** For control turrets: the barrier they open. */
  barrierId?: string;
  /**
   * Isolated-test overrides (firing range targets). NEVER used by the shipped stage.
   * A passive enemy has no AI and never attacks; `velocity` makes it move at constant velocity.
   */
  test?: { radius?: number; hp?: number; passive?: boolean; velocity?: V3 };
}

export interface StageDef {
  id: string;
  name: string;
  /** Overall bounds of all geometry (for spatial grids). */
  bounds: Box;
  /** Falling below this Y is an unrecoverable fall (mission failed). */
  killY: number;
  sectors: SectorDef[];
  solids: SolidDef[];
  decor: DecorDef[];
  /** Painted / illuminated wayfinding markings (optional, render-only). */
  markings?: MarkingDef[];
  barriers: BarrierDef[];
  finalGate: FinalGateDef;
  /** Entering this box alive (after the final gate opened) clears the mission. */
  exitZone: Box;
  /** Player spawn: hit-box centre and camera/body yaw. */
  playerStart: { position: V3; yaw: number };
  enemies: EnemyDef[];
  /** Documentation of the sector graph (also used by the stage report). */
  connections: Array<{
    a: string;
    b: string;
    kind: 'open' | 'door' | 'climb' | 'drop' | 'barrier' | 'gate';
    barrierId?: string;
    note?: string;
  }>;
  /** Recommended route (documentation + objective guidance). */
  route: Array<{ sectorId: string; position: V3; note?: string }>;
  /**
   * Mandatory climbs that need flight (verified by tools/validateStage.ts).
   * from / to: player hit-box centres standing on the lower take-off surface and on the upper landing surface.
   * cut: a box spanning the WHOLE passage cross-section at the top of the climb — every start→exit route
   * must pass through it (the validator blocks it and expects the exit to become unreachable).
   */
  flightSpots: Array<{ id: string; sectorId: string; from: V3; to: V3; height: number; cut: Box; note?: string }>;
  /**
   * Branch-and-rejoin structures: the route splits at `from` and rejoins at `to`; `viaA` / `viaB` are
   * points (player hit-box centres) in the middle of the two genuinely different alternatives.
   */
  branches: Array<{ id: string; from: V3; to: V3; viaA: V3; viaB: V3; noteA: string; noteB: string }>;
  /**
   * Local circuits: >= 3 waypoints (player hit-box centres) of a closed loop that returns to its first
   * point without retracing the same passage.
   */
  loops: Array<{ id: string; points: V3[]; note: string }>;
}

// ───────────────────────────── input ─────────────────────────────
/**
 * Input as seen by the simulation. Level fields mirror currently held keys; edge fields are set to
 * true/non-null by the input layer (or a test) exactly once per physical press and are consumed
 * (cleared) by the simulation at the start of the next sub-step, whether or not the action succeeds.
 */
export interface InputState {
  /** D minus A: +1 = right. */
  moveX: number;
  /** W minus S: +1 = forward. */
  moveZ: number;
  /** Space held. */
  jump: boolean;
  /** Left Ctrl held. */
  brake: boolean;
  /** Left mouse button held. */
  fire: boolean;
  /** Edge: Q went from released to pressed. */
  qbPressed: boolean;
  /** Edge: Shift went from released to pressed. */
  glideTogglePressed: boolean;
  /** Edge: Space went from released to pressed. */
  jumpPressed: boolean;
  /** Edge: 1/2/3 pressed. */
  weaponSelect: Weapon | null;
}

// ───────────────────────────── player ─────────────────────────────
export type HorizontalMode = 'walk' | 'glide' | 'quickboost';
export type VerticalMode = 'grounded' | 'rising' | 'flying' | 'falling';

export interface PlayerState {
  /** Hit-box centre at the current simulation time. */
  pos: V3;
  /** Hit-box centre at the start of the last sub-step (for swept projectile tests). */
  prevPos: V3;
  /** Actual velocity (after collision response). */
  vel: V3;
  grounded: boolean;
  hp: number;
  en: number;
  /** Camera / body orientation. See core/vec.ts for the convention. */
  yaw: number;
  pitch: number;

  weapon: Weapon;
  ammo: { machinegun: number; missile: number };
  /** Earliest simulation time each weapon may fire again. Kept across weapon switches. */
  nextFireAt: Record<Weapon, number>;

  horizontalMode: HorizontalMode;
  verticalMode: VerticalMode;
  glideEnabled: boolean;
  /** Unit XZ direction the glide / walk / QB currently wants to go; (0,0) when there is none. */
  desiredDir: { x: number; z: number };
  /** Stored glide direction (unit XZ) — kept when input is released; not rotated by camera turns. */
  glideDir: { x: number; z: number };
  qbDir: { x: number; z: number };
  qbImpulseRemaining: number;
  qbSuccessfulCount: number;
  qbLastStartedAt: number | null;
  /** Time of the last actual EN expenditure (QB start, beam shot, end of a flight thrust interval). */
  lastEnSpentAt: number | null;
  /** Simulation time at which Space was pressed and has been held since; null when not held. */
  jumpHeldSince: number | null;
  /** True while thrusters were actually firing during the last sub-step (flight). */
  flying: boolean;
  /** True while the brake (Left Ctrl) is being applied. */
  braking: boolean;

  /** World-space muzzle position at the current simulation time. */
  muzzle: V3;
}

// ───────────────────────────── camera ─────────────────────────────
export interface CameraState {
  pos: V3;
  /** Orthonormal basis. forward = view direction. */
  forward: V3;
  right: V3;
  up: V3;
  yaw: number;
  pitch: number;
  /** Vertical field of view in radians. */
  fovY: number;
  /** Viewport width / height. */
  aspect: number;
}

export interface Viewport {
  /** CSS pixels of the game display area. */
  width: number;
  height: number;
}

// ───────────────────────────── enemies ─────────────────────────────
export interface EnemyState {
  def: EnemyDef;
  id: string;
  index: number;
  kind: 'guard' | 'turret';
  isGateControl: boolean;
  /**
   * Sector the enemy is in: the placement sector (`def.sectorId`) at the start of a sortie; a guard that walks
   * out of that sector's bounds takes the id of the sector it entered (enemies.ts). Turrets never change it.
   */
  sectorId: string;
  /** Hit-sphere centre now / at the start of the last sub-step. */
  pos: V3;
  prevPos: V3;
  /** Actual velocity of the hit-sphere centre over the last sub-step (0 for turrets). */
  vel: V3;
  radius: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  destroyedAt: number | null;
  /** Facing yaw and current barrel direction (visuals). */
  yaw: number;
  aimDir: V3;

  /** True while the enemy is aware of the player (seeing, remembering, or told by an ally). */
  alert: boolean;
  /** True when the player is within range and the muzzle has an unobstructed line to the player's centre. */
  hasLos: boolean;
  /** Last player position this enemy saw or was told about (never the hidden current position). */
  lastKnownPlayerPos: V3 | null;
  /** Time the memory was last refreshed (own sighting or shared report). */
  lastKnownAt: number | null;
  /** Time line of sight was most recently lost (null while visible / never seen). */
  losLostAt: number | null;

  /** Attack scheduling (all absolute simulation times). */
  /** Earliest time the next burst may start (= previous burst start + period). */
  nextBurstReadyAt: number;
  /** Start time of the scheduled or running burst; null when none is scheduled. */
  burstStartAt: number | null;
  /** Shots of the current burst already attempted (fired or skipped for lack of LOS). */
  burstShotsDone: number;
  /** Telegraph window of the upcoming burst [telegraphStartAt, burstStartAt); null when none. */
  telegraphStartAt: number | null;
  shotsFired: number;
  lastShotAt: number | null;

  /** True for isolated-test targets: no AI, no attacks. */
  passive: boolean;
  /** Constant scripted velocity for isolated-test targets (null for real enemies). */
  scriptedVel: V3 | null;
  /** Module-private navigation / behaviour state owned by enemies.ts. */
  ai: Record<string, unknown>;
}

// ───────────────────────────── projectiles ─────────────────────────────
export type ProjectileKind = 'mg' | 'missile' | 'enemy';

export interface Projectile {
  id: number;
  kind: ProjectileKind;
  alive: boolean;
  spawnTime: number;
  lifeSeconds: number;
  damage: number;
  /** Launch state. For 'mg' the trajectory is the closed form origin + v0*a + 0.5*g*a² (a = age). */
  origin: V3;
  v0: V3;
  /** Kinematics at the current simulation time / at the start of the last sub-step. */
  pos: V3;
  prevPos: V3;
  vel: V3;
  /** Enemy bullets: id and kind of the shooter. */
  ownerEnemyId?: string;
  ownerKind?: 'guard' | 'turret';
  /** Missiles: locked target and the missile's own last observation of it. */
  targetId?: string | null;
  obsPos?: V3 | null;
  obsVel?: V3 | null;
  obsTime?: number | null;
}

// ───────────────────────────── FCS ─────────────────────────────
export type LockPhase = 'none' | 'acquiring' | 'locked';
export interface LockState {
  state: LockPhase;
  targetId: string | null;
  /** 0..1 */
  progress: number;
  /** Continuous time the current target has satisfied the lock conditions. */
  heldSeconds: number;
  /** Radius of the lock circle in CSS pixels (factor × min(viewport width, height)). */
  radiusCssPx: number;
}

export type SolutionStatus = 'inactive' | 'solved' | 'no_solution';

/** The fire-control solution actually used by the game and the HUD (docs/SPEC.md §4, §10). */
export interface FireSolution {
  status: SolutionStatus;
  weapon: Weapon;
  targetId: string | null;
  evaluatedAt: number | null;
  muzzle: V3 | null;
  targetPos: V3 | null;
  targetVel: V3 | null;
  /** Unit launch direction actually used when firing. */
  launchDir: V3 | null;
  flightSeconds: number | null;
  /** p + v*t */
  intercept: V3 | null;
  /** Point on the initial muzzle line (MG: p + v*t - 0.5*g*t²; beam: p; missile: p + v*t; no solution: p). */
  aimPoint: V3 | null;
  residual: number | null;
}

/** Where the weapon currently points (used by the renderer for the gun/arm and by free fire). */
export interface AimState {
  mode: 'free' | 'fcs';
  /** Unit direction from the muzzle. */
  dir: V3;
  /** Free fire: the camera-centre aim point; FCS: the solution aim point. */
  point: V3;
}

export interface ShotRecord {
  id: number;
  firedAt: number;
  weapon: Weapon;
  targetId: string | null;
  solutionStatus: SolutionStatus;
  muzzle: V3;
  targetPosAtFire: V3 | null;
  targetVelAtFire: V3 | null;
  launchDir: V3;
  /** Velocity really assigned to the projectile; null for the beam. */
  initialVelocity: V3 | null;
  accelerationAtFire: V3;
  flightSeconds: number | null;
  intercept: V3 | null;
}

// ───────────────────────────── objective ─────────────────────────────
export interface ObjectiveState {
  controlsDestroyed: number;
  controlsRequired: number;
  openBarrierIds: string[];
  gateOpen: boolean;
}

export type SimStatus = 'playing' | 'cleared' | 'failed';
export type FailReason = 'destroyed' | 'fell' | null;

/** What the HUD should point the player at next. */
export interface ObjectiveTarget {
  kind: 'control' | 'exit';
  /** Enemy id for 'control'. */
  id: string | null;
  position: V3;
  /** Short Japanese instruction, e.g. "制御砲台 T03 を破壊せよ（動力棟）". */
  label: string;
}

// ───────────────────────────── events (sim → renderer / HUD / audio) ─────────────────────────────
export type FireRejectReason = 'no-lock' | 'no-en' | 'no-ammo';
export type QbRejectReason = 'no-en' | 'cooldown' | 'brake';

export type SimEvent =
  | { type: 'player-shot'; weapon: Weapon; muzzle: V3; dir: V3; projectileId: number | null; locked: boolean }
  | { type: 'beam'; from: V3; to: V3; hit: 'enemy' | 'world' | 'none'; enemyId: string | null }
  | { type: 'fire-rejected'; weapon: Weapon; reason: FireRejectReason }
  | { type: 'weapon-switched'; weapon: Weapon }
  | { type: 'qb'; dir: { x: number; z: number }; airborne: boolean }
  | { type: 'qb-rejected'; reason: QbRejectReason }
  | { type: 'glide'; enabled: boolean; auto: boolean }
  | { type: 'jump' }
  | { type: 'land'; speed: number }
  | { type: 'projectile-hit'; kind: ProjectileKind; pos: V3; target: 'enemy' | 'player' | 'world'; enemyId: string | null }
  | { type: 'projectile-expired'; kind: ProjectileKind; pos: V3 }
  | { type: 'enemy-telegraph'; enemyId: string; duration: number }
  | { type: 'enemy-shot'; enemyId: string; kind: 'guard' | 'turret'; muzzle: V3; dir: V3 }
  | { type: 'enemy-damaged'; enemyId: string; amount: number; pos: V3 }
  | { type: 'enemy-destroyed'; enemyId: string; kind: 'guard' | 'turret'; pos: V3; isGateControl: boolean }
  | { type: 'enemy-alerted'; enemyId: string }
  | { type: 'player-damaged'; amount: number; sourcePos: V3; fromEnemyId: string | null }
  | { type: 'barrier-opened'; barrierId: string; controlEnemyId: string }
  | { type: 'gate-opened' }
  | { type: 'sector-entered'; sectorId: string }
  | { type: 'cleared' }
  | { type: 'failed'; reason: 'destroyed' | 'fell' };

// ───────────────────────────── snapshot (docs/SPEC.md §10) ─────────────────────────────
export type Vec3Tuple = [number, number, number];
export type AppState = 'garage' | 'playing' | 'paused' | 'cleared' | 'failed';

export interface Snapshot {
  version: 'AK2-1.2-candidate';
  seed: number;
  state: AppState;
  elapsedSeconds: number;
  loadout: Loadout;
  player: {
    position: Vec3Tuple;
    velocity: Vec3Tuple;
    grounded: boolean;
    hp: number;
    en: number;
    weapon: Weapon;
    ammo: { machinegun: number; missile: number };
    movement: {
      horizontalMode: HorizontalMode;
      verticalMode: VerticalMode;
      glideEnabled: boolean;
      desiredHorizontalDirection: [number, number];
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
    state: LockPhase;
    targetId: string | null;
    progress: number;
    radiusCssPx: number;
  };
  fireControl: {
    status: SolutionStatus;
    weapon: Weapon;
    targetId: string | null;
    evaluatedAtSeconds: number | null;
    muzzlePosition: Vec3Tuple | null;
    targetPosition: Vec3Tuple | null;
    targetVelocity: Vec3Tuple | null;
    launchDirection: Vec3Tuple | null;
    predictedFlightSeconds: number | null;
    predictedInterceptPosition: Vec3Tuple | null;
    aimPoint: Vec3Tuple | null;
    residualMeters: number | null;
  };
  recentPlayerShots: Array<{
    id: number;
    firedAtSeconds: number;
    weapon: Weapon;
    targetId: string | null;
    solutionStatus: SolutionStatus;
    muzzlePosition: Vec3Tuple;
    targetPositionAtFire: Vec3Tuple | null;
    targetVelocityAtFire: Vec3Tuple | null;
    launchDirection: Vec3Tuple;
    initialVelocity: Vec3Tuple | null;
    accelerationAtFire: Vec3Tuple;
    predictedFlightSeconds: number | null;
    predictedInterceptPosition: Vec3Tuple | null;
  }>;
  enemies: Array<{
    id: string;
    kind: 'guard' | 'turret';
    isGateControl: boolean;
    sectorId: string;
    position: Vec3Tuple;
    velocity: Vec3Tuple;
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
