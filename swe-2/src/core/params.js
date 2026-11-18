// ARMORED KOALA 2 DEMO — single source of truth for all game parameters.
// UI must read from here; nothing here is display-only.

export const DEG = Math.PI / 180;

export const PARAMS = {
  simDt: 1 / 120,            // fixed simulation step (seconds)
  maxFrameDt: 0.1,           // clamp for render->sim accumulation

  player: {
    maxHp: 1000,
    halfExtents: { x: 0.5, y: 0.9, z: 0.5 }, // AABB, feet at position.y
    hitRadius: 1.0,
    hitCenterY: 0.95,

    walkSpeed: 10,
    glideSpeed: 22,
    airSpeed: 16,
    qbSpeed: 80,

    jumpVel: 10,
    flyRiseSpeed: 8,
    gravity: 18,             // magnitude, downward

    walkAccel: 120,          // m/s^2 * legMult (also brake decel)
    glideRateGround: (80 - 22) / 0.60, // 96.666... * legMult
    glideRateAir: (80 - 16) / 0.60,    // 106.666... * legMult

    qbCost: 36,
    qbImpulse: 0.15,
    qbCooldown: 1.0,

    flyCost: 20,             // EN per second
    flyHoldTime: 0.20,
    regenDelay: 0.75,

    // muzzle offset in mech local space (feet origin, +Z = facing dir)
    muzzleRight: 0.55,
    muzzleUp: 1.42,
    muzzleFwd: 0.95,

    killY: -30,              // falling below -> fail
  },

  weapons: {
    machinegun: {
      key: 'machinegun', label: 'MACHINE GUN',
      damage: 12, interval: 0.10, ammo: 300, enCost: 0,
      speed: 100, gravity: 18, life: 2.0, lockRequired: false,
    },
    beam: {
      key: 'beam', label: 'BEAM RIFLE',
      damage: 40, interval: 0.25, ammo: Infinity, enCost: 8,
      range: 120, lockRequired: false,
    },
    missile: {
      key: 'missile', label: 'HAND MISSILE',
      damage: 180, interval: 1.00, ammo: 12, enCost: 0,
      speed: 45, turnRate: 120 * DEG, life: 4.0, lockRequired: true,
    },
  },
  weaponOrder: ['machinegun', 'beam', 'missile'],

  fcs: {
    wide:   { key: 'wide',   radiusK: 0.30, lockTime: 1.2,
              name: 'WIDE FCS',   pros: 'Largest lock circle', cons: 'Slowest lock' },
    medium: { key: 'medium', radiusK: 0.20, lockTime: 0.8,
              name: 'MEDIUM FCS', pros: 'Balanced', cons: 'No specialization' },
    narrow: { key: 'narrow', radiusK: 0.10, lockTime: 0.4,
              name: 'NARROW FCS', pros: 'Fastest lock', cons: 'Smallest lock circle' },
    lockRange: 120,
  },

  generators: {
    capacity: { key: 'capacity', maxEn: 180, regen: 10,
      name: 'CAPACITY GEN', pros: 'Max EN 180', cons: 'Slow regen 10/s' },
    balanced: { key: 'balanced', maxEn: 120, regen: 15,
      name: 'BALANCED GEN', pros: 'EN 120 / regen 15/s', cons: 'Middle ground' },
    recovery: { key: 'recovery', maxEn: 90, regen: 20,
      name: 'RECOVERY GEN', pros: 'Fast regen 20/s', cons: 'Max EN only 90' },
  },

  legs: {
    biped:     { key: 'biped',     speed: 1.00, enRegen: 1.00, lockSpeed: 1.00,
      name: 'BIPED',    pros: 'Full speed, full regen', cons: 'Normal lock speed' },
    quadruped: { key: 'quadruped', speed: 0.80, enRegen: 0.75, lockSpeed: 1.50,
      name: 'QUADRUPED', pros: 'Lock 1.5x faster', cons: 'Speed 0.8x, regen 0.75x' },
  },

  enemies: {
    guard: {
      kind: 'guard', hp: 120, range: 90,
      firstDelay: 0.50, damage: 18, bulletSpeed: 70,
      burst: 3, shotInterval: 0.12, period: 1.20, telegraph: 0.15,
      bulletLife: 2, hitRadius: 0.9,
      speedApproach: 8, speedStrafe: 6, speedRetreat: 8,
      approachAbove: 55, strafeMin: 25, retreatBelow: 15,
      walkAnimFreq: 6,
    },
    turret: {
      kind: 'turret', hp: 240, range: 120,
      firstDelay: 0.70, damage: 40, bulletSpeed: 60,
      burst: 2, shotInterval: 0.25, period: 1.60, telegraph: 0.35,
      bulletLife: 3, hitRadius: 1.15,
    },
    // scripted target dummy (test/arena use only; moves at scriptVel, never fires)
    dummy: { kind: 'dummy', hp: 1e9, range: 0, hitRadius: 1.0, bulletSpeed: 0,
      firstDelay: 0, damage: 0, burst: 0, shotInterval: 0, period: 0, telegraph: 0, bulletLife: 0 },
    memoryTime: 8.0,
    lostMoveDelay: 0.50,
    alertShareRange: 60,
    leadMaxTime: 1.20,
    spreadDeg: 0.5,
    stuckCheckInterval: 0.5,
  },

  stage: {
    controlsRequired: 6,
    sectorMin: 15,
  },

  colors: {
    mgTracer: 0xffd080,
    beam: 0x66e0ff,
    missileTrail: 0xff8844,
    enemyBullet: 0xff4040,
    telegraph: 0xff3020,
  },
};

// Effective stats from a loadout {fcs, generator, legs}
export function effectiveStats(loadout) {
  const g = PARAMS.generators[loadout.generator];
  const l = PARAMS.legs[loadout.legs];
  const f = PARAMS.fcs[loadout.fcs];
  return {
    maxEn: g.maxEn,
    regenPerSecond: g.regen * l.enRegen,
    lockSeconds: f.lockTime / l.lockSpeed,
    horizontalSpeedMultiplier: l.speed,
    lockRadiusK: f.radiusK,
  };
}
