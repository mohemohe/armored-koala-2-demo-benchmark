/**
 * Player movement / EN / QB / glide / flight (SPEC §6, §7; SPEC §11 checklist (a)-(n)).
 * Every test drives the real Game (Game.step / Game.advance) on the obstacle-free arena.
 */
import { describe, expect, it } from 'vitest';
import { FCS_PARTS, GENERATOR_PARTS, GLIDE_ACCEL_AIR, GLIDE_ACCEL_GROUND, LEGS_PARTS, PLAYER, SIM } from '../src/config';
import type { FcsId, GeneratorId, LegsId } from '../src/config';
import { buildSnapshot } from '../src/sim/bench';
import { Game } from '../src/sim/game';
import { forwardFromYaw, rightFromYaw } from '../src/sim/math';
import { playerBeginTick, playerIntegrate } from '../src/sim/player';
import { buildTestArenaStage, createArenaGame } from '../src/sim/testArena';
import type { BoxDef, InputState, Loadout } from '../src/sim/types';

const DT = SIM.DT;
const BIPED: Loadout = { fcs: 'medium', generator: 'balanced', legs: 'biped' };
const QUAD: Loadout = { ...BIPED, legs: 'quadruped' };
const STAND_Y = PLAYER.HALF.y; // spawn height (feet on the arena floor)
const GLIDE_DECEL = GLIDE_ACCEL_GROUND; // (80-22)/0.6

type BoolKey = 'forward' | 'back' | 'left' | 'right' | 'jump' | 'shift' | 'ctrl' | 'qb' | 'fire';
const hspeed = (g: Game): number => Math.hypot(g.state.player.vel.x, g.state.player.vel.z);
const run = (g: Game, n: number, each?: (k: number) => void): void => {
  for (let k = 0; k < n; k++) {
    g.step();
    each?.(k);
  }
};
const evCount = (g: Game, type: string): number => g.state.events.filter((e) => e.type === type).length;
const box = (id: string, min: [number, number, number], max: [number, number, number]): BoxDef => ({
  id,
  min: { x: min[0], y: min[1], z: min[2] },
  max: { x: max[0], y: max[1], z: max[2] },
  mat: 'concrete',
  sectorId: 'T00',
});
/** arena floor + extra solid boxes, driven by the real Game */
function arenaWith(loadout: Loadout, boxes: BoxDef[]): Game {
  const stage = buildTestArenaStage();
  stage.boxes.push(...boxes);
  const g = new Game({ stage, loadout });
  g.sortie(loadout);
  return g;
}

// ============================================================================
describe('(a) Q is a single-shot action', () => {
  it('holding Q for 5 s gives exactly one QB and spends exactly 36 EN', () => {
    const g = createArenaGame(BIPED);
    const p = g.state.player;
    g.input.qb = true;
    let enMin = Infinity;
    run(g, 600, () => {
      enMin = Math.min(enMin, p.en);
    });
    expect(p.mv.qbSuccessCount).toBe(1);
    expect(evCount(g, 'qb')).toBe(1);
    expect(enMin).toBe(120 - 36); // never below 84: no second spend
    expect(p.mv.qbLastStartedAt).toBe(0);
    expect(p.mv.lastEnSpentAt).toBe(0);
    expect(p.en).toBe(120); // back to max only through regeneration
  });

  it('a re-press inside the 1.00 s cooldown fails without side effects; from 1.00 s it works', () => {
    const g = createArenaGame(BIPED);
    const p = g.state.player;
    g.input.qb = true;
    g.step(); // tick 0: QB #1
    expect(p.mv.qbCooldownRemaining).toBeCloseTo(1 - DT, 9);
    g.input.qb = false;
    run(g, 59);
    g.input.qb = true; // t = 0.5 s: cooldown running
    g.step();
    g.input.qb = false;
    expect(p.mv.qbSuccessCount).toBe(1);
    expect(p.mv.qbLastStartedAt).toBe(0);
    expect(p.mv.lastEnSpentAt).toBe(0);
    expect(p.en).toBe(84);
    run(g, 57); // tick index 118 next
    g.input.qb = true; // t = 0.98333 s (1/120 s too early)
    g.step();
    g.input.qb = false;
    g.step();
    expect(p.mv.qbSuccessCount).toBe(1);
    expect(p.mv.qbLastStartedAt).toBe(0);
    expect(g.state.tick).toBe(120);
    g.input.qb = true; // t = 1.00 s exactly: allowed (1e-9 tolerance)
    g.step();
    expect(p.mv.qbSuccessCount).toBe(2);
    expect(p.mv.qbLastStartedAt).toBeCloseTo(1.0, 9);
    expect(p.en).toBeCloseTo(84 + 15 * 0.25 - 36, 9); // regen from 0.75 s, then -36
  });
});

// ============================================================================
describe('(b) a 1-tick Q press followed by all keys released', () => {
  it('impulse -> inertial deceleration -> automatic glide at 22 m/s, direction kept, never stops', () => {
    const g = createArenaGame(BIPED);
    const p = g.state.player;
    const z0 = p.pos.z;
    g.input.qb = true;
    g.step();
    g.input.qb = false; // every key is released from here on
    const speeds: number[] = [hspeed(g)];
    for (let k = 2; k <= 300; k++) {
      g.step();
      speeds.push(hspeed(g));
      expect(Math.abs(p.vel.x)).toBeLessThan(1e-9); // direction kept (camera forward = -Z)
      expect(p.vel.z).toBeLessThan(0);
      // desiredDir = where the horizontal system is heading (changed interpretation, audit-movement F2): with every key released
      // it is the held QB direction (camera forward = -Z) through the impulse, the inertial deceleration and the steady glide
      expect(p.mv.desiredDir.x).toBeCloseTo(0, 12);
      expect(p.mv.desiredDir.z).toBeCloseTo(-1, 12);
      if (k < 18) {
        expect(p.mv.horizontalMode).toBe('quickboost');
        expect(p.mv.qbImpulseRemaining).toBeGreaterThan(0);
      }
      if (k === 18) {
        // impulse just ended: glide is ON and the velocity vector is carried over
        expect(p.mv.qbImpulseRemaining).toBe(0);
        expect(p.mv.horizontalMode).toBe('glide');
        expect(p.mv.glideEnabled).toBe(true);
        expect(p.mv.glideDir.z).toBeCloseTo(-1, 12);
      }
      if (k <= 18) expect(speeds[k - 1]).toBeCloseTo(80, 9); // held, not accelerated
      if (k > 18 && k <= 90) {
        const drop = speeds[k - 2] - speeds[k - 1];
        expect(drop).toBeCloseTo(GLIDE_DECEL * DT, 9); // smooth: (80-22)/0.6 per second
        expect(p.mv.horizontalMode).toBe('glide');
      }
      if (k >= 90) expect(speeds[k - 1]).toBeCloseTo(22, 9); // settles at 22 and does not stop
      expect(p.mv.glideEnabled).toBe(k >= 18);
    }
    expect(p.pos.z - z0).toBeCloseTo(-(12.0 + 30.6 + 22 * (300 * DT - 0.75)), 6);
    expect(p.mv.qbSuccessCount).toBe(1);
  });
});

// ============================================================================
describe('(c) QB travel distance over 0.75 s (measured with the real tick loop)', () => {
  const cases: { name: string; loadout: Loadout; mult: number }[] = [
    { name: 'biped', loadout: BIPED, mult: 1 },
    { name: 'quadruped', loadout: QUAD, mult: 0.8 },
  ];
  for (const c of cases) {
    it(`${c.name}: 12.0 m during the impulse, 42.6 m (34.08 m for 4 legs) after 0.75 s`, () => {
      const g = createArenaGame(c.loadout);
      const p = g.state.player;
      const start = { ...p.pos };
      g.input.qb = true;
      g.step();
      g.input.qb = false;
      run(g, 17);
      expect(g.state.time).toBeCloseTo(0.15, 9);
      expect(Math.hypot(p.pos.x - start.x, p.pos.z - start.z)).toBeCloseTo(12.0 * c.mult, 6);
      run(g, 72);
      expect(g.state.time).toBeCloseTo(0.75, 9);
      const dist = Math.hypot(p.pos.x - start.x, p.pos.z - start.z);
      expect(Math.abs(dist - 42.6 * c.mult)).toBeLessThan(0.05);
      expect(dist).toBeCloseTo(42.6 * c.mult, 6); // exact for this integrator
      expect(p.pos.y).toBeCloseTo(start.y, 3); // stays on the ground
      expect(hspeed(g)).toBeCloseTo(22 * c.mult, 9);
    });
  }
  it('the closed form of SPEC §7.2: 12.0 + (80+22)/2*0.6 = 42.6 and steady glide would only cover 16.5', () => {
    expect(80 * 0.15 + ((80 + 22) / 2) * 0.6).toBeCloseTo(42.6, 12);
    expect(22 * 0.75).toBeCloseTo(16.5, 12);
  });
  it('QB speed is SET to 80*mult (never added) even when already gliding the same way at 22 m/s', () => {
    const g = createArenaGame(BIPED);
    const p = g.state.player;
    g.input.shift = true;
    run(g, 60); // glide forward at 22
    g.input.shift = false;
    expect(hspeed(g)).toBeCloseTo(22, 9);
    g.input.qb = true;
    g.step();
    expect(hspeed(g)).toBeCloseTo(80, 9);
    expect(p.vel.y).toBe(0);
  });
  it('QB direction follows WASD in the camera yaw frame (camera forward without input)', () => {
    const g = createArenaGame(BIPED);
    g.state.player.yaw = 0.7;
    g.input.qb = true;
    g.input.forward = true;
    g.input.right = true;
    g.step();
    const f = forwardFromYaw(0.7);
    const r = rightFromYaw(0.7);
    const l = Math.SQRT2;
    expect(g.state.player.vel.x).toBeCloseTo(((f.x + r.x) / l) * 80, 9);
    expect(g.state.player.vel.z).toBeCloseTo(((f.z + r.z) / l) * 80, 9);
    const g2 = createArenaGame(BIPED);
    g2.state.player.yaw = Math.PI / 2; // camera forward = -X
    g2.input.qb = true;
    g2.step();
    expect(g2.state.player.vel.x).toBeCloseTo(-80, 9);
    expect(g2.state.player.vel.z).toBeCloseTo(0, 9);
  });
});

// ============================================================================
describe('(d) EN boundary of QB', () => {
  it('EN 35 (airborne, no regen): no QB, EN / cooldown / count unchanged, never reserved; EN 36 works then EN 0 keeps inertia + glide', () => {
    const g = createArenaGame(BIPED);
    const p = g.state.player;
    p.pos.y = 300;
    p.grounded = false;
    p.en = 35;
    g.input.qb = true;
    run(g, 60);
    expect(p.mv.qbSuccessCount).toBe(0);
    expect(p.mv.qbLastStartedAt).toBeNull();
    expect(p.mv.lastEnSpentAt).toBeNull();
    expect(p.mv.qbCooldownRemaining).toBe(0);
    expect(p.mv.horizontalMode).toBe('walk');
    expect(p.en).toBe(35);
    expect(hspeed(g)).toBe(0);
    // EN becomes sufficient while Q is still held: NOT reserved
    p.en = 36;
    run(g, 30);
    expect(p.mv.qbSuccessCount).toBe(0);
    expect(p.en).toBe(36);
    // release and press again: success, exactly 36 spent
    g.input.qb = false;
    g.step();
    g.input.qb = true;
    g.step();
    expect(p.mv.qbSuccessCount).toBe(1);
    expect(p.en).toBe(0);
    g.input.qb = false;
    // EN is 0 now: impulse, inertia and glide are NOT interrupted
    const gliding: number[] = [];
    run(g, 100, () => gliding.push(hspeed(g)));
    expect(p.en).toBe(0);
    expect(gliding[16]).toBeCloseTo(80, 9); // still inside the impulse (17 ticks in)
    expect(p.mv.glideEnabled).toBe(true);
    expect(p.mv.horizontalMode).toBe('glide');
    expect(gliding[99]).toBeCloseTo(16, 9); // decelerated to the AIR glide speed
    expect(Math.min(...gliding)).toBeGreaterThan(15.999);
  });

  it('EN 35 on the ground: EN regenerates past 36 while Q stays held, still no QB; a new press then succeeds', () => {
    const g = createArenaGame(BIPED);
    const p = g.state.player;
    p.en = 35;
    g.input.qb = true;
    run(g, 60);
    expect(p.en).toBeGreaterThan(36);
    expect(p.mv.qbSuccessCount).toBe(0);
    expect(p.mv.qbLastStartedAt).toBeNull();
    g.input.qb = false;
    g.step();
    const before = p.en;
    g.input.qb = true;
    g.step();
    expect(p.mv.qbSuccessCount).toBe(1);
    expect(p.en).toBeCloseTo(before - 36, 9);
  });

  it('EN 36 exactly succeeds once and leaves EN 0 with the wait time restarted at the QB time', () => {
    const g = createArenaGame(BIPED);
    const p = g.state.player;
    p.en = 36;
    g.input.qb = true;
    g.step();
    expect(p.mv.qbSuccessCount).toBe(1);
    expect(p.en).toBe(0);
    expect(p.mv.lastEnSpentAt).toBe(0);
  });
});

// ============================================================================
describe('(e) glide costs 0 EN; ground regen starts 0.75 s after the QB time', () => {
  it('QB at t=0: EN stays 84 until exactly 0.75 s, then regenerates at 15/s while gliding at 22 m/s', () => {
    const g = createArenaGame(BIPED);
    const p = g.state.player;
    g.input.qb = true;
    g.step();
    g.input.qb = false;
    for (let n = 2; n <= 89; n++) {
      g.step();
      expect(p.en).toBe(84);
    }
    g.step(); // tick 90: time 0.75 s reached, the whole tick is still inside the wait
    expect(g.state.time).toBeCloseTo(0.75, 9);
    expect(p.en).toBe(84);
    g.step(); // first regenerating tick [0.75, 0.75+dt]
    expect(p.en).toBeCloseTo(84 + 15 * DT, 9);
    run(g, 119);
    expect(g.state.time).toBeCloseTo(1.75, 9);
    expect(p.en).toBeCloseTo(84 + 15 * (1.75 - 0.75), 7); // exactly 15 EN/s since 0.75 s
    expect(hspeed(g)).toBeCloseTo(22, 9); // glide keeps going the whole time
    expect(p.mv.horizontalMode).toBe('glide');
    expect(p.mv.lastEnSpentAt).toBe(0); // not re-set by the end of the impulse / inertia
    expect(p.grounded).toBe(true);
  });

  it('glide works at EN 0 and the EN stays 0 during the wait, then regenerates while the glide continues', () => {
    const g = createArenaGame(BIPED);
    const p = g.state.player;
    p.en = 0;
    p.mv.lastEnSpentAt = 0; // spent at t = 0
    g.input.shift = true;
    g.step();
    g.input.shift = false;
    expect(p.mv.glideEnabled).toBe(true);
    run(g, 88);
    expect(hspeed(g)).toBeCloseTo(22, 9);
    expect(p.en).toBe(0);
    run(g, 60);
    expect(p.en).toBeGreaterThan(0.5);
    expect(hspeed(g)).toBeCloseTo(22, 9);
    expect(p.mv.glideEnabled).toBe(true);
  });

  it('a wait that ends in the middle of a tick regenerates only the part after it (partial-tick accuracy)', () => {
    const g = createArenaGame(BIPED);
    const p = g.state.player;
    p.en = 0;
    p.mv.lastEnSpentAt = 0.003; // regen may start at 0.753 s
    run(g, 91); // ticks [0, 0.75833]: only [0.753, 0.758333] counts
    expect(p.en).toBeCloseTo(15 * (91 * DT - 0.753), 9);
  });
});

// ============================================================================
describe('(f) QB in the air', () => {
  it('vertical motion is untouched; the horizontal speed falls to the AIR glide speed at (80-16)/0.6; landing returns to 22', () => {
    const control = createArenaGame(BIPED);
    const g = createArenaGame(BIPED);
    const p = g.state.player;
    const c = control.state.player;
    for (const game of [g, control]) {
      game.input.jump = true;
      game.step(); // tick 0: jump
      game.input.jump = false;
      game.step(); // tick 1
    }
    const vyBefore = p.vel.y;
    g.input.qb = true;
    g.step(); // tick 2: QB in the air
    control.step();
    g.input.qb = false;
    expect(p.vel.y).toBeCloseTo(vyBefore - 18 * DT, 12); // only gravity, the QB did not touch vy
    expect(hspeed(g)).toBeCloseTo(80, 9);
    expect(p.mv.horizontalMode).toBe('quickboost');
    expect(p.grounded).toBe(false);
    const airSpeeds: number[] = [];
    let landedTick = -1;
    for (let k = 3; k <= 260; k++) {
      g.step();
      control.step();
      expect(p.pos.y).toBeCloseTo(c.pos.y, 12); // identical vertical trajectory with and without the QB
      expect(p.vel.y).toBeCloseTo(c.vel.y, 12);
      if (!p.grounded) airSpeeds.push(hspeed(g));
      else if (landedTick < 0) landedTick = g.state.tick;
      if (g.state.tick === 20) expect(p.mv.horizontalMode).toBe('glide'); // impulse over (18 ticks from tick 2)
      if (g.state.tick === 60) expect(hspeed(g)).toBeCloseTo(80 - GLIDE_ACCEL_AIR * 40 * DT, 9); // 106.67 m/s²
      if (g.state.tick === 92) expect(hspeed(g)).toBeCloseTo(16, 9);
    }
    expect(landedTick).toBeGreaterThan(120);
    expect(airSpeeds.at(-1)!).toBeCloseTo(16, 9); // steady air glide speed
    expect(Math.min(...airSpeeds)).toBeGreaterThan(15.999);
    // after landing: glide stays ON and moves to the ground speed 22
    expect(p.grounded).toBe(true);
    expect(p.mv.glideEnabled).toBe(true);
    expect(hspeed(g)).toBeCloseTo(22, 9);
    expect(g.state.player.hp).toBe(PLAYER.MAX_HP); // no invulnerability needed / no side effects
  });

  it('4 legs: air glide speed 16*0.8 with the (80-16)/0.6*0.8 limit', () => {
    const g = createArenaGame(QUAD);
    g.input.jump = true;
    g.step();
    g.input.jump = false;
    g.step();
    g.input.qb = true;
    g.step();
    g.input.qb = false;
    run(g, 17); // impulse (18 ticks) is over now, tick 20
    expect(hspeed(g)).toBeCloseTo(64, 9);
    g.step();
    expect(hspeed(g)).toBeCloseTo(64 - GLIDE_ACCEL_AIR * 0.8 * DT, 9);
    run(g, 71);
    expect(g.state.player.grounded).toBe(false);
    expect(hspeed(g)).toBeCloseTo(12.8, 9);
  });
});

// ============================================================================
describe('(g) collisions', () => {
  it('QB into a wall stops short of 42.6 m, removes the into-wall velocity and never pushes through or rebounds', () => {
    const g = arenaWith(BIPED, [box('wall', [-100, 0, -22], [100, 30, -20])]);
    const p = g.state.player;
    g.input.qb = true;
    g.step();
    g.input.qb = false;
    let maxSpeed = 0;
    let minZ = 0;
    let maxVz = -Infinity;
    run(g, 240, () => {
      maxSpeed = Math.max(maxSpeed, hspeed(g));
      minZ = Math.min(minZ, p.pos.z);
      maxVz = Math.max(maxVz, p.vel.z);
    });
    const wallFace = -20 + PLAYER.HALF.z;
    expect(minZ).toBeGreaterThan(wallFace - 1e-3); // never inside the wall
    expect(p.pos.z).toBeLessThan(wallFace + 0.01);
    expect(Math.abs(p.pos.z)).toBeLessThan(42.6);
    expect(Math.abs(p.vel.z)).toBeLessThan(1e-9); // into-wall component removed and not re-granted for 2 s
    expect(maxVz).toBeLessThan(1e-9); // no bounce
    expect(maxSpeed).toBeLessThanOrEqual(80 + 1e-9); // no speed gained from the contact
  });

  it('a diagonal QB slides along the wall (parallel component kept, perpendicular removed)', () => {
    const g = arenaWith(BIPED, [box('wall', [-400, 0, -22], [400, 30, -20])]);
    const p = g.state.player;
    g.input.qb = true;
    g.input.forward = true;
    g.input.left = true; // toward -X and -Z
    g.step();
    g.input.qb = false;
    g.input.forward = false;
    g.input.left = false;
    run(g, 120);
    expect(p.pos.z).toBeGreaterThan(-20 + PLAYER.HALF.z - 1e-3);
    expect(p.pos.x).toBeLessThan(-30); // kept sliding sideways
    expect(p.vel.x).toBeLessThan(-1);
    expect(Math.abs(p.vel.z)).toBeLessThan(1e-9);
  });

  it('a wall thinner than one tick of QB travel (0.1 m vs 0.67 m) is not tunnelled', () => {
    const g = arenaWith(BIPED, [box('thin', [-100, 0, -31], [100, 30, -30.9])]);
    const p = g.state.player;
    g.input.qb = true;
    g.step();
    g.input.qb = false;
    let minZ = 0;
    run(g, 240, () => {
      minZ = Math.min(minZ, p.pos.z);
    });
    expect(minZ).toBeGreaterThan(-30.9 + PLAYER.HALF.z - 1e-3);
    expect(p.pos.z).toBeGreaterThan(-30.9 + PLAYER.HALF.z - 1e-3);
  });

  it('pressing into walls from many random positions and angles never penetrates (contact robustness)', () => {
    let seed = 0x1234abcd;
    const rnd = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let trial = 0; trial < 120; trial++) {
      const g = arenaWith(trial % 2 ? BIPED : QUAD, [
        box('wall-n', [-1000, 0, -52], [1000, 30, -50]),
        box('wall-e', [50, 0, -1000], [52, 30, 1000]),
      ]);
      const p = g.state.player;
      p.pos.x = (rnd() - 0.5) * 30 + rnd() * 1e-3;
      p.pos.z = (rnd() - 0.5) * 30 + rnd() * 1e-3;
      p.yaw = rnd() * Math.PI * 2;
      g.input.forward = true;
      if (rnd() < 0.5) g.input.right = true;
      if (rnd() < 0.5) g.input.shift = true;
      for (let k = 0; k < 500; k++) {
        if (k % 90 === 0 && rnd() < 0.6) g.input.qb = true;
        else g.input.qb = false;
        if (k === 250) p.yaw = rnd() * Math.PI * 2; // change the pressing angle mid-run
        g.step();
        if (p.pos.z < -50 + PLAYER.HALF.z - 1e-3 || p.pos.x > 50 - PLAYER.HALF.x + 1e-3) {
          throw new Error(`penetrated wall in trial ${trial} tick ${k}: (${p.pos.x}, ${p.pos.z})`);
        }
        expect(g.world.overlapAABB(p.pos, PLAYER.HALF, 1e-3)).toBe(false);
      }
    }
  });

  it('a low ceiling zeroes the vertical velocity (jump and flight) without penetration', () => {
    const g = createArenaGame(BIPED, { platforms: [{ id: 'ceil', top: { x: 0, y: 7, z: 0 }, sizeX: 40, sizeZ: 40 }] }); // slab y 5..7
    const p = g.state.player;
    g.input.jump = true;
    g.step();
    g.input.jump = false;
    let maxY = -Infinity;
    let hitVy = NaN;
    run(g, 200, () => {
      if (p.pos.y > maxY) maxY = p.pos.y;
      if (p.pos.y > 5 - PLAYER.HALF.y && Number.isNaN(hitVy)) hitVy = p.vel.y; // the contact tick
    });
    expect(maxY).toBeLessThan(5 - PLAYER.HALF.y + 1e-3);
    expect(maxY).toBeGreaterThan(5 - PLAYER.HALF.y - 1e-3); // it really reached the ceiling
    expect(hitVy).toBe(0);
    expect(p.grounded).toBe(true);
    // flight pinned against the ceiling never enters it
    g.input.jump = true;
    run(g, 120, () => {
      expect(p.pos.y).toBeLessThan(5 - PLAYER.HALF.y + 1e-3);
    });
  });

  it('flying up onto a raised platform and landing on it (scaffold landing)', () => {
    const g = createArenaGame(BIPED, { platforms: [{ id: 'step', top: { x: 6, y: 6, z: 0 }, sizeX: 6, sizeZ: 6 }] });
    const p = g.state.player;
    p.yaw = -Math.PI / 2; // camera forward = +X
    g.input.jump = true;
    run(g, 132); // 1.1 s: fly up past the 6 m step (feet above 8 m)
    g.input.jump = false;
    g.input.forward = true;
    run(g, 30);
    g.input.forward = false;
    for (let k = 0; k < 600 && !p.grounded; k++) g.step();
    expect(p.grounded).toBe(true);
    expect(p.pos.y).toBeCloseTo(6 + PLAYER.HALF.y, 3); // standing on the raised platform
    expect(p.pos.x).toBeGreaterThan(3);
    expect(p.pos.x).toBeLessThan(9);
    expect(evCount(g, 'land')).toBeGreaterThanOrEqual(1);
    // regeneration works on the platform (the 0.75 s wait ended in the air)
    const en = p.en;
    expect(en).toBeLessThan(120);
    run(g, 120);
    expect(p.en).toBeGreaterThan(en + 10);
  });

  it('standing still for 5 s keeps the player grounded and stable (no sinking, no bouncing, no land event)', () => {
    const g = createArenaGame(BIPED);
    const p = g.state.player;
    run(g, 600);
    expect(p.grounded).toBe(true);
    expect(p.vel.y).toBe(0);
    expect(Math.abs(p.pos.y - STAND_Y)).toBeLessThan(1e-3);
    expect(p.mv.verticalMode).toBe('grounded');
    expect(evCount(g, 'land')).toBe(0);
    expect(p.pos.x).toBe(0);
    expect(p.pos.z).toBe(0);
  });
});

// ============================================================================
describe('(h) speeds', () => {
  const groups: { name: string; loadout: Loadout; mult: number }[] = [
    { name: 'biped', loadout: BIPED, mult: 1 },
    { name: 'quadruped', loadout: QUAD, mult: 0.8 },
  ];
  for (const c of groups) {
    it(`${c.name}: walk ${10 * c.mult}, ground glide ${22 * c.mult}, air ${16 * c.mult} m/s`, () => {
      // walk
      const w = createArenaGame(c.loadout);
      w.input.forward = true;
      w.step();
      expect(hspeed(w)).toBeCloseTo(120 * c.mult * DT, 9); // accel limit 120*mult m/s²
      run(w, 119);
      expect(hspeed(w)).toBeCloseTo(10 * c.mult, 9);
      // glide
      const gl = createArenaGame(c.loadout);
      gl.input.shift = true;
      gl.step();
      expect(hspeed(gl)).toBeCloseTo(GLIDE_ACCEL_GROUND * c.mult * DT, 9); // glide accel limit
      gl.input.shift = false;
      run(gl, 119);
      expect(hspeed(gl)).toBeCloseTo(22 * c.mult, 9);
      // air (short jump while holding forward, no flight)
      const air = createArenaGame(c.loadout);
      air.input.forward = true;
      air.input.jump = true;
      air.step();
      air.input.jump = false;
      run(air, 59);
      expect(air.state.player.grounded).toBe(false);
      expect(hspeed(air)).toBeCloseTo(16 * c.mult, 9);
    });
  }

  it('diagonal input does not speed up; direction follows the camera yaw; camera pitch never lifts the mech', () => {
    const g = createArenaGame(BIPED);
    const p = g.state.player;
    g.input.forward = true;
    g.input.right = true;
    run(g, 60);
    expect(hspeed(g)).toBeCloseTo(10, 9);
    expect(p.vel.x).toBeCloseTo(10 / Math.SQRT2, 9);
    expect(p.vel.z).toBeCloseTo(-10 / Math.SQRT2, 9);
    expect(p.mv.desiredDir.x).toBeCloseTo(1 / Math.SQRT2, 12);
    expect(p.mv.desiredDir.z).toBeCloseTo(-1 / Math.SQRT2, 12);

    for (const pitch of [1.2, -1.2]) {
      const q = createArenaGame(BIPED);
      q.state.player.pitch = pitch;
      q.input.forward = true;
      run(q, 120);
      expect(Math.abs(q.state.player.pos.y - STAND_Y)).toBeLessThan(1e-3);
      expect(q.state.player.vel.y).toBe(0);
      expect(hspeed(q)).toBeCloseTo(10, 9);
    }
    const y = createArenaGame(BIPED);
    y.state.player.yaw = Math.PI / 2; // forward = -X
    y.input.forward = true;
    run(y, 60);
    expect(y.state.player.vel.x).toBeCloseTo(-10, 9);
    expect(y.state.player.vel.z).toBeCloseTo(0, 9);
  });

  it('releasing the keys decelerates a walk toward 0 at 120 m/s² (walk never keeps a saved direction)', () => {
    const g = createArenaGame(BIPED);
    g.input.forward = true;
    run(g, 30);
    g.input.forward = false;
    g.step();
    expect(hspeed(g)).toBeCloseTo(10 - 120 * DT, 9);
    run(g, 20);
    expect(hspeed(g)).toBe(0);
  });
});

// ============================================================================
describe('(i) brake (left Ctrl) and glide toggle (Shift)', () => {
  it('Shift toggles glide on the rising edge only (holding / key repeat does not toggle) and glide keeps its direction when the camera turns', () => {
    const g = createArenaGame(BIPED);
    const p = g.state.player;
    g.input.forward = true;
    g.input.shift = true;
    g.step();
    g.input.forward = false; // all released except Shift, which stays down for 3 s
    run(g, 360);
    expect(p.mv.glideEnabled).toBe(true); // a held Shift toggled exactly once
    expect(hspeed(g)).toBeCloseTo(22, 9);
    expect(p.vel.x).toBeCloseTo(0, 9);
    expect(p.vel.z).toBeCloseTo(-22, 9);
    // turn the camera only: the saved direction is not rotated automatically
    p.yaw += 1.0;
    run(g, 30);
    expect(p.vel.x).toBeCloseTo(0, 9);
    expect(p.vel.z).toBeCloseTo(-22, 9);
    // WASD sets a new glide direction (in the new camera frame); speed changes only at the accel limit
    g.input.shift = false;
    g.input.right = true;
    g.step();
    const r = rightFromYaw(p.yaw);
    expect(p.mv.glideDir.x).toBeCloseTo(r.x, 12);
    expect(p.mv.glideDir.z).toBeCloseTo(r.z, 12);
    expect(hspeed(g)).toBeLessThan(22.0001);
    const dv = Math.hypot(p.vel.x - 0, p.vel.z - -22);
    expect(dv).toBeCloseTo(GLIDE_ACCEL_GROUND * DT, 9); // not an instant reversal / turn
    run(g, 60);
    expect(p.vel.x).toBeCloseTo(r.x * 22, 9);
    expect(p.vel.z).toBeCloseTo(r.z * 22, 9);
  });

  it('Shift ON without input accelerates toward the camera forward; Shift again turns glide OFF and decelerates (speed not wiped)', () => {
    const g = createArenaGame(BIPED);
    const p = g.state.player;
    p.yaw = 0.4;
    g.input.shift = true;
    g.step();
    g.input.shift = false;
    run(g, 60);
    const f = forwardFromYaw(0.4);
    expect(p.vel.x).toBeCloseTo(f.x * 22, 9);
    expect(p.vel.z).toBeCloseTo(f.z * 22, 9);
    g.input.shift = true; // OFF
    g.step();
    g.input.shift = false;
    expect(p.mv.glideEnabled).toBe(false);
    expect(p.mv.horizontalMode).toBe('walk');
    expect(hspeed(g)).toBeCloseTo(22 - 120 * DT, 9); // decelerating at 120, not zeroed
    expect(hspeed(g)).toBeGreaterThan(20);
    run(g, 21);
    expect(hspeed(g)).toBeLessThan(1e-9);
  });

  it('Ctrl: glide OFF, walk mode, brake to 0 at 120 m/s^2 with priority over WASD; releasing lets WASD move again', () => {
    const g = createArenaGame(BIPED);
    const p = g.state.player;
    g.input.shift = true;
    run(g, 60);
    g.input.shift = false;
    g.input.ctrl = true;
    g.input.forward = true; // WASD must lose against the brake
    g.step();
    expect(p.mv.glideEnabled).toBe(false);
    expect(p.mv.horizontalMode).toBe('walk');
    expect(p.mv.braking).toBe(true);
    expect(hspeed(g)).toBeCloseTo(22 - 120 * DT, 9); // not instantly 0
    run(g, 21);
    expect(hspeed(g)).toBeLessThan(1e-9);
    run(g, 30);
    expect(hspeed(g)).toBe(0);
    g.input.ctrl = false;
    run(g, 30);
    expect(p.mv.braking).toBe(false);
    expect(hspeed(g)).toBeCloseTo(10, 9);
  });

  it('while Ctrl is down a new QB request fails, spends nothing and is NOT reserved for when Ctrl is released', () => {
    const g = createArenaGame(BIPED);
    const p = g.state.player;
    g.input.ctrl = true;
    g.input.qb = true;
    run(g, 30);
    expect(p.mv.qbSuccessCount).toBe(0);
    expect(p.mv.lastEnSpentAt).toBeNull();
    expect(p.en).toBe(120);
    g.input.ctrl = false; // Q is still held: still nothing
    run(g, 30);
    expect(p.mv.qbSuccessCount).toBe(0);
    g.input.qb = false;
    g.step();
    g.input.qb = true;
    g.step();
    expect(p.mv.qbSuccessCount).toBe(1);
  });

  it('during the 0.15 s impulse Ctrl and Shift change nothing; the brake bites right after the auto-glide starts', () => {
    const g = createArenaGame(BIPED);
    const p = g.state.player;
    g.input.qb = true;
    g.step();
    g.input.qb = false;
    run(g, 2);
    g.input.ctrl = true;
    g.input.shift = true; // Shift edge inside the impulse: ignored (and not remembered)
    run(g, 1);
    g.input.shift = false;
    for (let n = 5; n <= 18; n++) {
      g.step();
      expect(hspeed(g)).toBeCloseTo(80, 9);
      expect(p.mv.braking).toBe(false);
      expect(p.mv.glideEnabled).toBe(n >= 18); // the Shift edge at tick 4 did not toggle anything; auto glide only at the end
      if (n < 18) expect(p.mv.horizontalMode).toBe('quickboost');
    }
    expect(g.state.tick).toBe(18);
    expect(p.mv.horizontalMode).toBe('glide'); // auto glide at the end of the impulse
    expect(p.mv.glideEnabled).toBe(true);
    g.step(); // Ctrl (still down) takes over
    expect(p.mv.braking).toBe(true);
    expect(p.mv.glideEnabled).toBe(false);
    expect(hspeed(g)).toBeCloseTo(80 - 120 * DT, 9);
    // second run: Shift only inside the impulse must not switch the auto glide off afterwards
    const g2 = createArenaGame(BIPED);
    g2.input.qb = true;
    g2.step();
    g2.input.qb = false;
    run(g2, 4);
    g2.input.shift = true;
    g2.step();
    g2.input.shift = false;
    run(g2, 200);
    expect(g2.state.player.mv.glideEnabled).toBe(true);
    expect(hspeed(g2)).toBeCloseTo(22, 9);
    // third run: glide already ON before the QB; a Shift edge inside the impulse must not switch it OFF mid-impulse
    const g3 = createArenaGame(BIPED);
    g3.input.shift = true;
    g3.step();
    g3.input.shift = false;
    g3.step();
    expect(g3.state.player.mv.glideEnabled).toBe(true);
    g3.input.qb = true;
    g3.step();
    g3.input.qb = false;
    g3.input.shift = true;
    g3.step(); // edge inside the impulse
    g3.input.shift = false;
    for (let k = 0; k < 14; k++) {
      g3.step();
      expect(g3.state.player.mv.glideEnabled).toBe(true);
      expect(g3.state.player.mv.horizontalMode).toBe('quickboost');
    }
  });
});

// ============================================================================
describe('(j) jump and flight', () => {
  it('jump: 10 m/s from the ground on the press edge, apex 2.78 m, lands back, jump/land events', () => {
    const g = createArenaGame(BIPED);
    const p = g.state.player;
    const y0 = p.pos.y;
    g.input.jump = true;
    g.step();
    g.input.jump = false;
    expect(p.grounded).toBe(false);
    expect(p.vel.y).toBeCloseTo(10 - 18 * DT, 12);
    expect(p.mv.verticalMode).toBe('rising');
    let maxY = y0;
    let sawFalling = false;
    run(g, 200, () => {
      maxY = Math.max(maxY, p.pos.y);
      if (p.mv.verticalMode === 'falling') sawFalling = true;
    });
    expect(maxY - y0).toBeGreaterThan(2.77);
    expect(maxY - y0).toBeLessThan(10 ** 2 / (2 * 18) + 1e-3); // 2.7778 m
    expect(sawFalling).toBe(true);
    expect(p.grounded).toBe(true);
    expect(p.pos.y).toBeCloseTo(y0, 3);
    expect(evCount(g, 'jump')).toBe(1);
    expect(evCount(g, 'land')).toBe(1);
    const land = g.state.events.find((e) => e.type === 'land');
    expect(land && land.type === 'land' ? land.impactSpeed : 0).toBeGreaterThan(9.8);
  });

  it('a jump key held while airborne / a re-press in the air never adds another 10 m/s; 0.2 s of hold is required before flight', () => {
    const g = createArenaGame(BIPED);
    const p = g.state.player;
    g.input.jump = true;
    g.step(); // tick 0: jump
    g.input.jump = false;
    run(g, 19); // tick 20
    g.input.jump = true; // press again in the air
    for (let k = 20; k < 44; k++) {
      g.step();
      const t = (k + 1) * DT;
      expect(p.vel.y).toBeCloseTo(10 - 18 * t, 9); // pure gravity, no second jump, no thrust for 0.2 s
      expect(p.mv.thrusting).toBe(false);
    }
    expect(evCount(g, 'jump')).toBe(1);
    g.step(); // tick 44: 0.20 s after the press -> flight
    expect(p.mv.thrusting).toBe(true);
    expect(p.mv.verticalMode).toBe('flying');
    expect(p.vel.y).toBeCloseTo(8, 9);
    expect(p.en).toBeCloseTo(120 - 20 * DT, 9);
  });

  it('holding Space: jump for 0.2 s, then flight (vy = 8, 20 EN/s), EN drain and lastEnSpentAt follow the thrust', () => {
    const g = createArenaGame(BIPED);
    const p = g.state.player;
    const y0 = p.pos.y;
    g.input.jump = true;
    for (let n = 1; n <= 24; n++) {
      g.step();
      expect(p.en).toBe(120); // no EN during the plain jump phase
      expect(p.mv.thrusting).toBe(false);
    }
    for (let n = 25; n <= 120; n++) {
      g.step();
      expect(p.vel.y).toBeCloseTo(8, 9);
      expect(p.en).toBeCloseTo(120 - 20 * DT * (n - 24), 9);
      expect(p.mv.verticalMode).toBe('flying');
      expect(p.mv.thrusting).toBe(true);
      expect(p.mv.lastEnSpentAt).toBeCloseTo(n * DT, 9);
      expect(p.grounded).toBe(false);
    }
    // y(1.0 s) = jump part (1.64 m at 0.2 s) + 8 m/s for 0.8 s
    expect(p.pos.y - y0).toBeCloseTo(1.64 + 8 * 0.8, 3);
    // release: current vy is carried into gravity motion
    g.input.jump = false;
    g.step();
    expect(p.vel.y).toBeCloseTo(8 - 18 * DT, 9);
    expect(p.mv.thrusting).toBe(false);
    expect(p.mv.verticalMode).toBe('rising');
  });

  it('flight stops when EN runs out: remaining EN buys exactly that many seconds, the rest is gravity (no free ascent)', () => {
    const g = createArenaGame(BIPED);
    const p = g.state.player;
    const y0 = p.pos.y;
    p.en = 10; // 0.5 s of thrust
    g.input.jump = true;
    let maxY = y0;
    let thrustTicks = 0;
    run(g, 200, () => {
      // 1.67 s: past the apex (1.14 s) and before landing (~2.05 s)
      maxY = Math.max(maxY, p.pos.y);
      if (p.mv.thrusting) thrustTicks += 1;
      expect(p.en).toBeGreaterThanOrEqual(0);
      expect(p.grounded).toBe(false);
    });
    expect(p.en).toBe(0);
    expect(thrustTicks).toBe(60);
    // 1.64 (jump) + 8*0.5 (thrust) + 8^2/36 (ballistic after EN out)
    expect(maxY - y0).toBeCloseTo(1.64 + 4 + 64 / 36, 1);
    // at t = 0.9 s the flight is over and vy follows gravity from 8 m/s at t = 0.7 s
    const g2 = createArenaGame(BIPED);
    g2.state.player.en = 10;
    g2.input.jump = true;
    run(g2, 108);
    expect(g2.state.player.vel.y).toBeCloseTo(8 - 18 * (0.9 - 0.7), 6);
  });

  it('EN 0: normal jump still works, holding Space gives no thrust and no extra height', () => {
    const g = createArenaGame(BIPED);
    const p = g.state.player;
    const y0 = p.pos.y;
    p.en = 0;
    g.input.jump = true;
    let maxY = y0;
    run(g, 130, () => {
      maxY = Math.max(maxY, p.pos.y);
      expect(p.mv.thrusting).toBe(false);
      expect(p.en).toBe(0);
    });
    expect(maxY - y0).toBeGreaterThan(2.77);
    expect(maxY - y0).toBeLessThan(2.7778 + 1e-3);
  });

  it('a partial tick of EN buys only the affordable part of the tick; lastEnSpentAt = end of the thrust', () => {
    const g = createArenaGame(BIPED);
    const p = g.state.player;
    p.en = 0.1; // 0.005 s of thrust
    g.input.jump = true;
    run(g, 24); // tick 24 next (t = 0.2 s)
    g.step();
    expect(p.en).toBe(0);
    expect(p.mv.lastEnSpentAt).toBeCloseTo(0.2 + 0.005, 9);
    expect(p.mv.thrusting).toBe(true);
    expect(p.vel.y).toBeCloseTo(8 - 18 * (DT - 0.005), 9);
    g.step();
    expect(p.mv.thrusting).toBe(false);
    expect(p.en).toBe(0);
  });

  it('flight is horizontally free: WASD moves at the 16 m/s air speed while thrusting', () => {
    const g = createArenaGame(BIPED);
    g.input.jump = true;
    g.input.forward = true;
    run(g, 60);
    expect(g.state.player.mv.thrusting).toBe(true);
    expect(hspeed(g)).toBeCloseTo(16, 9);
  });
});

// ============================================================================
describe('(k) EN stays within 0..max in every loadout, under random input', () => {
  const fcsIds = Object.keys(FCS_PARTS) as FcsId[];
  const genIds = Object.keys(GENERATOR_PARTS) as GeneratorId[];
  const legIds = Object.keys(LEGS_PARTS) as LegsId[];
  const keys: BoolKey[] = ['forward', 'back', 'left', 'right', 'jump', 'shift', 'ctrl', 'qb'];
  /** per-tick probability of pressing an idle key / releasing a held key (short taps and long holds both occur) */
  const pressP: Record<string, number> = { forward: 0.02, back: 0.01, left: 0.01, right: 0.01, jump: 0.012, shift: 0.008, ctrl: 0.003, qb: 0.04 };
  const releaseP: Record<string, number> = { forward: 0.03, back: 0.05, left: 0.05, right: 0.05, jump: 0.05, shift: 0.3, ctrl: 0.03, qb: 0.5 };
  let cfgIndex = 0;
  for (const fcs of fcsIds)
    for (const generator of genIds)
      for (const legs of legIds) {
        const cfgSeed = (0x9e3779b9 ^ Math.imul(++cfgIndex, 0x85ebca6b)) >>> 0; // a different random script per loadout
        it(`${fcs}/${generator}/${legs}`, () => {
          const loadout: Loadout = { fcs, generator, legs };
          const g = arenaWith(loadout, [
            box('wall-n', [-60, 0, -62], [60, 40, -60]),
            box('wall-e', [60, 0, -60], [62, 40, 60]),
            box('ceil', [-30, 7, -30], [30, 9, 30]),
            box('pillar', [10, 0, 10], [14, 30, 14]),
          ]);
          const p = g.state.player;
          const inp = g.input as unknown as Record<BoolKey, boolean>;
          const maxEn = GENERATOR_PARTS[generator].maxEn;
          const mult = LEGS_PARTS[legs].speedMult;
          let seed = cfgSeed;
          const rnd = (): number => {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            return seed / 4294967296;
          };
          let qbEvents = 0;
          for (let k = 0; k < 3600; k++) {
            for (const key of keys) if (rnd() < (inp[key] ? releaseP[key] : pressP[key])) inp[key] = !inp[key];
            p.yaw += (rnd() - 0.5) * 0.3;
            p.pitch = Math.max(-1.2, Math.min(1.2, p.pitch + (rnd() - 0.5) * 0.2));
            const r = rnd();
            if (r < 0.01) p.en = 0;
            else if (r < 0.02) p.en = 35.9999999;
            else if (r < 0.03) p.en = 36;
            else if (r < 0.04) p.en = rnd() * maxEn;
            const enBefore = p.en;
            const groundedBefore = p.grounded;
            g.step();
            expect(p.en).toBeGreaterThanOrEqual(0);
            expect(p.en).toBeLessThanOrEqual(maxEn);
            if (!groundedBefore || !p.grounded) expect(p.en).toBeLessThanOrEqual(enBefore + 1e-12); // never regenerates in the air
            for (const v of [p.pos.x, p.pos.y, p.pos.z, p.vel.x, p.vel.y, p.vel.z, p.walkPhase, p.mv.qbCooldownRemaining]) expect(Number.isFinite(v)).toBe(true);
            expect(hspeed(g)).toBeLessThanOrEqual(80 * mult + 1e-6);
            expect(p.mv.qbImpulseRemaining).toBeGreaterThanOrEqual(0);
            expect(p.mv.qbImpulseRemaining).toBeLessThanOrEqual(0.15 + 1e-12);
            expect(p.mv.qbCooldownRemaining).toBeGreaterThanOrEqual(0);
            expect(p.mv.qbCooldownRemaining).toBeLessThanOrEqual(1);
            expect(g.world.overlapAABB(p.pos, PLAYER.HALF, 1e-3)).toBe(false); // never inside solids
            qbEvents += g.drainEvents().filter((e) => e.type === 'qb').length; // drain like the renderer does (ring buffer)
          }
          expect(p.mv.qbSuccessCount).toBe(qbEvents);
          expect(JSON.stringify(buildSnapshot(g.state))).not.toMatch(/NaN|Infinity/);
        });
      }
});

// ============================================================================
describe('(l) result is independent of the frame split (Game.advance with 1/30, 1/60, 1/120, 1/144 s)', () => {
  type Patch = Partial<Record<BoolKey, boolean>>;
  const script: [number, Patch][] = [
    [0, { forward: true, jump: true }],
    [12, { jump: false, qb: true }],
    [24, { qb: false, shift: true }],
    [36, { shift: false, right: true }],
    [60, { ctrl: true }],
    [96, { ctrl: false }],
    [120, { jump: true }],
    [240, { jump: false, left: true, right: false, forward: false }],
    [300, { qb: true }],
    [312, { qb: false }],
    [360, { shift: true }],
    [372, { shift: false }],
    [480, { back: true, left: false }],
    [540, { ctrl: true }],
  ];
  const TOTAL = 720;
  function play(frameDt: number): Game {
    const g = createArenaGame(BIPED);
    let next = 0;
    while (g.state.tick < TOTAL) {
      while (next < script.length && script[next][0] <= g.state.tick) {
        Object.assign(g.input, script[next][1]);
        next++;
      }
      g.advance(frameDt);
    }
    return g;
  }
  it('same pos / vel / EN / QB bookkeeping for every split', () => {
    const ref = play(1 / 120);
    expect(ref.state.tick).toBe(TOTAL);
    expect(ref.state.player.mv.qbSuccessCount).toBe(2);
    for (const dt of [1 / 30, 1 / 60, 1 / 144]) {
      const g = play(dt);
      const a = ref.state.player;
      const b = g.state.player;
      expect(g.state.tick).toBe(TOTAL);
      for (const key of ['x', 'y', 'z'] as const) {
        expect(b.pos[key]).toBeCloseTo(a.pos[key], 9);
        expect(b.vel[key]).toBeCloseTo(a.vel[key], 9);
      }
      expect(b.en).toBeCloseTo(a.en, 9);
      expect(b.mv.qbSuccessCount).toBe(a.mv.qbSuccessCount);
      expect(b.mv.lastEnSpentAt).toBe(a.mv.lastEnSpentAt);
      expect(b.mv.horizontalMode).toBe(a.mv.horizontalMode);
      expect(b.grounded).toBe(a.grounded);
    }
  });
  it('the QB travel distance is the same whichever way the frames are cut (1.0 s: 42.6 + 22*0.25 = 48.1 m)', () => {
    for (const dt of [1 / 30, 1 / 60, 1 / 120, 1 / 144]) {
      const g = createArenaGame(BIPED);
      g.input.qb = true;
      while (g.state.tick < 120) {
        g.advance(dt);
        if (g.state.tick >= 1) g.input.qb = false; // released after the first executed tick
      }
      expect(g.state.tick).toBe(120);
      expect(g.state.player.mv.qbSuccessCount).toBe(1);
      expect(Math.abs(g.state.player.pos.z + 48.1)).toBeLessThan(0.05);
      expect(g.state.player.pos.z).toBeCloseTo(-48.1, 6);
    }
  });
});

// ============================================================================
describe('(m) EN priority QB -> beam -> flight, no double payment', () => {
  /** put a flying player at tick 24 with the given EN (airborne: no regen interferes) */
  function flightAt24(en: number): Game {
    const g = createArenaGame(BIPED);
    g.input.jump = true;
    run(g, 24);
    g.state.player.en = en;
    return g;
  }

  it('QB + flight in the same tick: 36 for the QB first, then only what is left is thrust; total = 36 + 20*t, never negative', () => {
    const g = flightAt24(37); // 1 EN left after the QB = 0.05 s of thrust = 6 ticks
    const p = g.state.player;
    g.input.qb = true;
    g.step();
    g.input.qb = false;
    expect(p.mv.qbSuccessCount).toBe(1);
    expect(p.en).toBeCloseTo(37 - 36 - 20 * DT, 9); // paid once each
    expect(p.mv.thrusting).toBe(true);
    let thrustTicks = 1;
    run(g, 30, () => {
      if (p.mv.thrusting) thrustTicks += 1;
      expect(p.en).toBeGreaterThanOrEqual(0);
    });
    expect(thrustTicks).toBe(6);
    expect(p.en).toBe(0);
    expect(p.mv.lastEnSpentAt).toBeCloseTo(0.2 + 0.05, 9);
  });

  it('unaffordable QB fails alone; the flight still gets the EN', () => {
    const g = flightAt24(30);
    const p = g.state.player;
    g.input.qb = true;
    g.step();
    expect(p.mv.qbSuccessCount).toBe(0);
    expect(p.mv.qbLastStartedAt).toBeNull();
    expect(p.en).toBeCloseTo(30 - 20 * DT, 9);
    expect(p.mv.thrusting).toBe(true);
  });

  it('the thrust uses only the EN that is left after QB and beam have been paid (beam simulated by an explicit payment)', () => {
    const g = flightAt24(50);
    const s = g.state;
    const p = s.player;
    g.input.qb = true;
    playerBeginTick(s); // QB: 50 -> 14
    expect(p.en).toBe(14);
    p.en -= 8; // stand-in for playerFireStep's beam payment (A2b)
    p.mv.lastEnSpentAt = s.time;
    playerIntegrate(s, g.world); // flight gets only the remaining 6
    expect(p.en).toBeCloseTo(6 - 20 * DT, 9);
    expect(p.mv.thrusting).toBe(true);
    // 4 EN left after QB (40 - 36) and a beam that cannot be paid: flight takes the 4
    const g2 = flightAt24(40);
    g2.input.qb = true;
    playerBeginTick(g2.state);
    expect(g2.state.player.en).toBe(4);
    playerIntegrate(g2.state, g2.world);
    expect(g2.state.player.en).toBeCloseTo(4 - 20 * DT, 9);
  });

  // The real beam is implemented by the combat agent (weapons.ts). Only run when it is in place.
  const beamImplemented = ((): boolean => {
    try {
      const g = createArenaGame(BIPED);
      g.state.player.weapon = 'beam';
      g.input.fire = true;
      g.step();
      return g.state.player.en < 120 - 1e-9;
    } catch {
      return false;
    }
  })();
  it.runIf(beamImplemented)('real Game: QB (36) then beam (8) then flight in one tick', () => {
    const g = flightAt24(60);
    const p = g.state.player;
    p.weapon = 'beam';
    g.input.qb = true;
    g.input.fire = true;
    g.step();
    expect(p.en).toBeCloseTo(60 - 36 - 8 - 20 * DT, 9);
    expect(p.mv.qbSuccessCount).toBe(1);
    expect(g.state.shots.length).toBe(1);
  });
  it.runIf(beamImplemented)('real Game: EN 44 pays QB and beam, leaving no EN for flight in that tick', () => {
    const g = flightAt24(44);
    const p = g.state.player;
    p.weapon = 'beam';
    g.input.qb = true;
    g.input.fire = true;
    g.step();
    expect(p.en).toBe(0);
    expect(p.mv.thrusting).toBe(false);
    expect(p.mv.qbSuccessCount).toBe(1);
    expect(g.state.shots.length).toBe(1);
  });
});

// ============================================================================
describe('(n) EN regeneration rate = generator base x legs multiplier', () => {
  const genIds = Object.keys(GENERATOR_PARTS) as GeneratorId[];
  const legIds = Object.keys(LEGS_PARTS) as LegsId[];
  for (const generator of genIds)
    for (const legs of legIds) {
      it(`${generator}/${legs}`, () => {
        const g = createArenaGame({ fcs: 'medium', generator, legs });
        const p = g.state.player;
        const rate = GENERATOR_PARTS[generator].baseRegen * LEGS_PARTS[legs].regenMult;
        expect(g.state.stats.regenPerSecond).toBeCloseTo(rate, 12);
        p.en = 0;
        run(g, 120); // 1 s on the ground, nothing spent
        expect(p.en).toBeCloseTo(rate, 6);
        run(g, 12000);
        expect(p.en).toBe(GENERATOR_PARTS[generator].maxEn); // clamped to max
      });
    }
  it('balanced generator: 4 legs 11.25 EN/s, 2 legs 15 EN/s', () => {
    const q = createArenaGame(QUAD);
    const b = createArenaGame(BIPED);
    q.state.player.en = 0;
    b.state.player.en = 0;
    run(q, 120);
    run(b, 120);
    expect(q.state.player.en).toBeCloseTo(11.25, 6);
    expect(b.state.player.en).toBeCloseTo(15, 6);
  });
  it('regen after a flight starts 0.75 s after the end of the thrust, and never in the air', () => {
    // A low ceiling keeps the fall short so the player is back on the ground BEFORE the 0.75 s wait ends.
    const g = createArenaGame(BIPED, { platforms: [{ id: 'ceil', top: { x: 0, y: 7, z: 0 }, sizeX: 40, sizeZ: 40 }] });
    const p = g.state.player;
    g.input.jump = true;
    run(g, 60); // jump, then flight pinned under the ceiling until t = 0.5 s
    g.input.jump = false;
    expect(p.mv.lastEnSpentAt).toBeCloseTo(0.5, 9);
    const enAfterThrust = p.en;
    expect(enAfterThrust).toBeCloseTo(120 - 20 * 0.3, 6);
    let prev = p.en;
    let firstRegenTime = -1;
    let landedAt = -1;
    for (let k = 0; k < 400 && firstRegenTime < 0; k++) {
      g.step();
      if (p.grounded && landedAt < 0) landedAt = g.state.time;
      if (p.en > prev + 1e-12) firstRegenTime = g.state.time;
      prev = p.en;
    }
    expect(landedAt).toBeGreaterThan(0.5);
    expect(landedAt).toBeLessThan(1.25 - 0.1); // grounded well before the wait ends
    expect(firstRegenTime).toBeCloseTo(0.5 + 0.75 + DT, 6); // first regenerating tick is [1.25, 1.25+dt]
    expect(p.en).toBeCloseTo(enAfterThrust + 15 * DT, 9);
  });
});

// ============================================================================
describe('snapshot consistency (mv.* describe the state at the END of the tick)', () => {
  it('qbCooldownRemaining / qbImpulseRemaining / lastEnSpentAt are reported at time + dt', () => {
    const g = createArenaGame(BIPED);
    g.input.qb = true;
    g.step();
    g.input.qb = false;
    const s = buildSnapshot(g.state).player.movement;
    expect(g.state.time).toBeCloseTo(DT, 12);
    expect(s.qbSuccessfulCount).toBe(1);
    expect(s.qbLastStartedAtSeconds).toBe(0);
    expect(s.lastEnSpentAtSeconds).toBe(0);
    expect(s.qbCooldownRemainingSeconds).toBeCloseTo(1 - DT, 9);
    expect(s.qbImpulseRemainingSeconds).toBeCloseTo(0.15 - DT, 9);
    expect(s.horizontalMode).toBe('quickboost');
    expect(s.verticalMode).toBe('grounded');
    // no WASD, but the QB heads along the camera forward (-Z): the desired direction is the QB direction, not [0,0]
    // (changed interpretation, audit-movement F2)
    expect(s.desiredHorizontalDirection[0]).toBeCloseTo(0, 12);
    expect(s.desiredHorizontalDirection[1]).toBeCloseTo(-1, 12);
    run(g, 119);
    expect(buildSnapshot(g.state).player.movement.qbCooldownRemainingSeconds).toBe(0);
  });
  it('desiredHorizontalDirection is the WASD direction in camera yaw frame, or [0,0] while walking without input', () => {
    const g = createArenaGame(BIPED);
    g.input.back = true;
    g.step();
    expect(buildSnapshot(g.state).player.movement.desiredHorizontalDirection[1]).toBeCloseTo(1, 12);
    g.input.back = false;
    g.step();
    expect(buildSnapshot(g.state).player.movement.desiredHorizontalDirection).toEqual([0, 0]);
  });
});

// ============================================================================
// desiredHorizontalDirection = the direction the horizontal movement system is CURRENTLY HEADING (audit-movement F2 / SPEC §10):
// WASD when held; without WASD the held glide/QB direction while gliding (§7.2 keeps moving along the QB direction with every key
// released, §7.3 keeps the glide direction); [0,0] only when walking without input or braking.
// ============================================================================
describe('desiredHorizontalDirection (snapshot) = the direction the horizontal movement is heading', () => {
  const desired = (g: Game): [number, number] => buildSnapshot(g.state).player.movement.desiredHorizontalDirection;
  const expectDir = (g: Game, x: number, z: number, msg = ''): void => {
    const d = desired(g);
    expect(d[0], `${msg} x`).toBeCloseTo(x, 12);
    expect(d[1], `${msg} z`).toBeCloseTo(z, 12);
  };
  const S2 = Math.SQRT1_2;

  it('walking: WASD in the camera yaw frame (diagonals are unit vectors), [0,0] when released', () => {
    const g = createArenaGame(BIPED);
    expectDir(g, 0, 0, 'fresh');
    g.input.forward = true;
    g.input.right = true;
    g.step();
    expectDir(g, S2, -S2, 'W+D');
    g.input.forward = false;
    g.input.right = false;
    run(g, 30);
    expect(g.state.player.mv.glideEnabled).toBe(false);
    expectDir(g, 0, 0, 'walking, released');
  });

  it('WASD follows the camera yaw (yaw = +90 deg: forward is -X)', () => {
    const g = createArenaGame(BIPED);
    g.state.player.yaw = Math.PI / 2;
    g.input.forward = true;
    g.step();
    expectDir(g, -1, 0, 'W at yaw 90');
  });

  it('manual Shift glide with no input: the held glide direction (camera forward at the toggle), also after Shift is released', () => {
    const g = createArenaGame(BIPED);
    g.input.shift = true;
    g.step();
    g.input.shift = false;
    expect(g.state.player.mv.glideEnabled).toBe(true);
    expectDir(g, 0, -1, 'glide toggled without input');
    run(g, 90);
    expectDir(g, 0, -1, 'gliding on');
    // the saved direction is not rotated by a view turn (SPEC §7.1)
    g.look(500, 0);
    g.step();
    expectDir(g, 0, -1, 'after turning the view');
  });

  it('gliding: a new WASD direction becomes the heading and is kept when released (glide toggled with A held = camera left)', () => {
    const g = createArenaGame(BIPED);
    g.input.shift = true;
    g.input.left = true;
    g.step();
    g.input.shift = false;
    expectDir(g, -1, 0, 'glide + A');
    g.input.left = false;
    g.step();
    expectDir(g, -1, 0, 'A released: glideDir kept');
    g.input.back = true;
    g.step();
    expectDir(g, 0, 1, 'S pressed while gliding');
    g.input.back = false;
    run(g, 5);
    expectDir(g, 0, 1, 'S released: glideDir kept');
  });

  for (const legs of ['biped', 'quadruped'] as const) {
    it(`${legs}: QB with a direction keeps reporting the QB direction through the impulse, the inertial glide and the steady glide with every key released`, () => {
      const g = createArenaGame({ ...BIPED, legs });
      g.input.right = true; // Q + D: QB to camera right (+X)
      g.input.qb = true;
      g.step();
      g.input.right = false;
      g.input.qb = false;
      expectDir(g, 1, 0, 'tick 1 (impulse)');
      for (let k = 2; k <= 200; k++) {
        g.step();
        expectDir(g, 1, 0, `tick ${k}`);
      }
      expect(g.state.player.mv.glideEnabled).toBe(true);
    });
  }

  it('the QB impulse ignores WASD changes, so the heading stays the QB direction; afterwards the new WASD is the heading', () => {
    const g = createArenaGame(BIPED);
    g.input.qb = true;
    g.step(); // QB forward (-Z) with no WASD
    g.input.qb = false;
    g.input.right = true; // pressed mid-impulse: the movement does not change
    run(g, 10);
    expect(g.state.player.mv.horizontalMode).toBe('quickboost');
    expectDir(g, 0, -1, 'impulse with D held');
    run(g, 20);
    expect(g.state.player.mv.horizontalMode).toBe('glide');
    expectDir(g, 1, 0, 'after the impulse D is the new glide target');
  });

  it('brake (Ctrl) beats WASD and glide: [0,0]; after the brake (glide off) and no input it stays [0,0]', () => {
    const g = createArenaGame(BIPED);
    g.input.qb = true;
    g.step();
    g.input.qb = false;
    run(g, 20); // impulse over, gliding
    expectDir(g, 0, -1, 'gliding');
    g.input.ctrl = true;
    g.step();
    expect(g.state.player.mv.braking).toBe(true);
    expectDir(g, 0, 0, 'braking');
    g.input.forward = true; // WASD does not matter while the brake has priority
    g.step();
    expectDir(g, 0, 0, 'braking with W held');
    g.input.forward = false;
    g.input.ctrl = false;
    g.step();
    expect(g.state.player.mv.glideEnabled).toBe(false);
    expectDir(g, 0, 0, 'brake released, walking without input');
  });

  it('a Ctrl held during the impulse does not brake it: heading stays the QB direction until the brake takes over', () => {
    const g = createArenaGame(BIPED);
    g.input.qb = true;
    g.step();
    g.input.qb = false;
    g.input.ctrl = true;
    run(g, 5);
    expect(g.state.player.mv.braking).toBe(false);
    expectDir(g, 0, -1, 'impulse with Ctrl held');
    run(g, 20);
    expect(g.state.player.mv.braking).toBe(true);
    expectDir(g, 0, 0, 'brake after the impulse');
  });

  it('the value is always finite and either the zero vector or a unit vector (random inputs, all loadouts, mouse look)', () => {
    let seed = 20260930;
    const rnd = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const keys: BoolKey[] = ['forward', 'back', 'left', 'right', 'jump', 'shift', 'ctrl', 'qb'];
    for (const fcs of Object.keys(FCS_PARTS) as FcsId[]) {
      for (const generator of Object.keys(GENERATOR_PARTS) as GeneratorId[]) {
        for (const legs of Object.keys(LEGS_PARTS) as LegsId[]) {
          const g = createArenaGame({ fcs, generator, legs });
          for (let k = 0; k < 240; k++) {
            if (k % 7 === 0) for (const key of keys) g.input[key] = rnd() < 0.4;
            if (k % 11 === 0) g.look((rnd() - 0.5) * 400, 0);
            g.step();
            const d = desired(g);
            expect(Number.isFinite(d[0]) && Number.isFinite(d[1])).toBe(true);
            const l = Math.hypot(d[0], d[1]);
            expect(l === 0 || Math.abs(l - 1) < 1e-9, `${fcs}/${generator}/${legs} tick ${k}: |d|=${l}`).toBe(true);
          }
        }
      }
    }
  });
});

describe('retry resets the movement state', () => {
  it('a fresh sortie resets every movement field (retry)', () => {
    const g = createArenaGame(BIPED);
    g.input.qb = true;
    g.input.shift = true;
    g.input.jump = true;
    run(g, 40);
    g.retry();
    const p = g.state.player;
    expect(p.mv.qbSuccessCount).toBe(0);
    expect(p.mv.qbLastStartedAt).toBeNull();
    expect(p.mv.glideEnabled).toBe(false);
    expect(p.mv.horizontalMode).toBe('walk');
    expect(p.mv.qbImpulseRemaining).toBe(0);
    expect(p.mv.lastEnSpentAt).toBeNull();
    expect(p.en).toBe(120);
    expect(p.vel).toEqual({ x: 0, y: 0, z: 0 });
    g.input.qb = true; // Q level again after the retry: a fresh press
    g.step();
    expect(p.mv.qbSuccessCount).toBe(1);
  });
});
