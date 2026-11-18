/**
 * ARMORED KOALA 2 (AK2) — central parameter table.
 * Every number the HUD shows is derived from here; the HUD never invents values.
 */

export const VERSION = 'AK2-1.2-candidate';
export const DEFAULT_SEED = 20260908;

export const SIM_STEP = 1 / 120; // fixed simulation step (seconds)
export const MAX_FRAME_TIME = 0.25;

export type FcsId = 'wide' | 'medium' | 'narrow';
export type GeneratorId = 'capacity' | 'balanced' | 'recovery';
export type LegId = 'biped' | 'quadruped';
export type WeaponId = 'machinegun' | 'beam' | 'missile';

export interface FcsSpec {
  id: FcsId;
  label: string;
  /** lock circle radius as a fraction of D = min(viewportW, viewportH) */
  radiusFactor: number;
  /** base lock acquisition time in seconds (2 legs) */
  baseLockSeconds: number;
  pros: string;
  cons: string;
}

export interface GeneratorSpec {
  id: GeneratorId;
  label: string;
  maxEn: number;
  regenPerSecond: number;
  pros: string;
  cons: string;
}

export interface LegSpec {
  id: LegId;
  label: string;
  speedMultiplier: number;
  regenMultiplier: number;
  lockSpeedMultiplier: number;
  legCount: number;
  pros: string;
  cons: string;
}

export const FCS_LIST: FcsSpec[] = [
  {
    id: 'wide',
    label: 'Wide FCS',
    radiusFactor: 0.3,
    baseLockSeconds: 1.2,
    pros: 'Largest lock circle (30% of the short screen edge). Acquires distant or fast targets sooner.',
    cons: 'Slowest lock (1.20 s). Costly while strafing.'
  },
  {
    id: 'medium',
    label: 'Medium FCS',
    radiusFactor: 0.2,
    baseLockSeconds: 0.8,
    pros: 'Balanced capture radius and lock speed. Good all-round choice.',
    cons: 'Smaller circle than Wide; distant targets can be missed.'
  },
  {
    id: 'narrow',
    label: 'Narrow FCS',
    radiusFactor: 0.1,
    baseLockSeconds: 0.4,
    pros: 'Fastest lock (0.40 s). Best for precision shots.',
    cons: 'Circle is only 10% of the short screen edge; tight tracking required.'
  }
];

export const GENERATOR_LIST: GeneratorSpec[] = [
  {
    id: 'capacity',
    label: 'High-Capacity Generator',
    maxEn: 180,
    regenPerSecond: 10,
    pros: 'Max EN 180. Keeps flight and beam chains running.',
    cons: 'Slowest recharge (10 EN/s); slow to recover after a drain.'
  },
  {
    id: 'balanced',
    label: 'Balanced Generator',
    maxEn: 120,
    regenPerSecond: 15,
    pros: '15 EN/s recharge. Keeps a standard engagement sustainable.',
    cons: 'Max EN 120. Sustained high-cost bursts are hard.'
  },
  {
    id: 'recovery',
    label: 'High-Recovery Generator',
    maxEn: 90,
    regenPerSecond: 20,
    pros: '20 EN/s recharge. Re-deploys immediately after landing.',
    cons: 'Max EN 90 only. Tight for repeated flight or beam use.'
  }
];

export const LEG_LIST: LegSpec[] = [
  {
    id: 'biped',
    label: 'Biped (2 legs)',
    speedMultiplier: 1.0,
    regenMultiplier: 1.0,
    lockSpeedMultiplier: 1.0,
    legCount: 2,
    pros: 'All movement at 100%. Highest ground speed.',
    cons: 'No leg bonus: recharge and lock speed stay at base values.'
  },
  {
    id: 'quadruped',
    label: 'Quadruped (4 legs)',
    speedMultiplier: 0.8,
    regenMultiplier: 0.75,
    lockSpeedMultiplier: 1.5,
    legCount: 4,
    pros: 'Lock speed x1.50 (effective lock time is divided by 1.5).',
    cons: 'Move speed 80%, recharge 75%. Weaker over long distances.'
  }
];

export const WEAPON_LIST = [
  {
    id: 'machinegun' as WeaponId,
    label: 'Machinegun',
    key: '1',
    damage: 12,
    interval: 0.1,
    ammo: 300,
    enCost: 0,
    gravity: -18,
    speed: 100,
    life: 2,
    requiresLock: false,
    ammoLabel: '300 rounds',
    desc: 'World-space 100 m/s projectile with -18 m/s2 gravity. Locked fire compensates lead AND gravity.'
  },
  {
    id: 'beam' as WeaponId,
    label: 'Beam',
    key: '2',
    damage: 40,
    interval: 0.25,
    ammo: Infinity,
    enCost: 8,
    gravity: 0,
    speed: 0,
    life: 0,
    requiresLock: false,
    ammoLabel: 'UNLIMITED',
    desc: 'Instant 120 m line hit. 8 EN per shot. Always strikes the current position.'
  },
  {
    id: 'missile' as WeaponId,
    label: 'Hand Missile',
    key: '3',
    damage: 180,
    interval: 1.0,
    ammo: 12,
    enCost: 0,
    gravity: 0,
    speed: 45,
    life: 4,
    requiresLock: true,
    ammoLabel: '12 rounds',
    desc: 'Requires a lock. 45 m/s, 120 deg/s turn rate. Fired along the lead solution.'
  }
];

export const PLAYER = {
  maxHp: 1000,
  radius: 0.9,
  height: 2.6,
  eyeHeight: 1.55,
  walkSpeed: 10,
  glideSpeed: 22,
  airSpeed: 16,
  flySpeed: 16,
  flyRiseSpeed: 8,
  flyEnPerSecond: 20,
  jumpSpeed: 10,
  gravity: -18,
  accel: 120, // normal walk / brake acceleration limit (m/s^2)
  glideAccel: (80 - 22) / 0.6, // QB -> glide deceleration limit
  airGlideAccel: (80 - 16) / 0.6,
  qbEnCost: 36,
  qbSpeed: 80,
  qbImpulseSeconds: 0.15,
  qbCooldown: 1.0,
  flightHoldSeconds: 0.2,
  enRegenDelay: 0.75,
  mouseSensitivity: 0.0022,
  pitchMin: -1.35,
  pitchMax: 1.35,
  cameraDistance: 6.4,
  cameraHeight: 2.35,
  cameraPitchOffset: 0.12
};

export const ENEMY = {
  guard: {
    kind: 'guard' as const,
    hp: 120,
    detectRange: 90,
    firstShotDelay: 0.5,
    telegraph: 0.15,
    damage: 18,
    bulletSpeed: 70,
    burstCount: 3,
    burstInterval: 0.12,
    burstCycle: 1.2,
    bulletLife: 2,
    moveSpeed: 8,
    strafeSpeed: 6,
    radius: 0.85,
    height: 2.2,
    alertMemory: 8,
    shareRadius: 60
  },
  turret: {
    kind: 'turret' as const,
    hp: 240,
    detectRange: 120,
    firstShotDelay: 0.7,
    telegraph: 0.35,
    damage: 40,
    bulletSpeed: 60,
    burstCount: 2,
    burstInterval: 0.25,
    burstCycle: 1.6,
    bulletLife: 3,
    moveSpeed: 0,
    strafeSpeed: 0,
    radius: 1.15,
    height: 2.0,
    alertMemory: 8,
    shareRadius: 0
  },
  aimSpreadDegrees: 0.5,
  leadTimeCap: 1.2
};

export const LOCK = {
  maxRange: 120,
  beamRange: 120
};

export const DEFAULT_LOADOUT = {
  fcs: 'medium' as FcsId,
  generator: 'balanced' as GeneratorId,
  legs: 'biped' as LegId,
  weapon: 'machinegun' as WeaponId
};

/** Upper bounds used by the FCS solver. */
export const SOLVER = {
  mgLife: 2.0,
  mgSpeed: 100,
  mgGravity: 18,
  missileSpeed: 45,
  missileLife: 4,
  missileTurnRateDeg: 120,
  beamRange: 120
};
