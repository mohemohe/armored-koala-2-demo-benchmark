/**
 * Player movement / EN / quick boost / glide / brake / jump / flight (docs/SPEC.md §6, §7, §9, §11).
 *
 * Everything here drives the real Sim (real World collision, real scheduler) on the flat isolated test
 * stage; nothing of the code under test is mocked. Measured distances and timings are printed with the
 * prefix "[player]" so that they can be quoted in the project report. (Some vitest reporters hide the
 * console output of passing tests: run `npx vitest run tests/player.test.ts --silent=false` to see it.)
 */
import { describe, expect, it } from 'vitest';
import { GLIDE_ACCEL_AIR, GLIDE_ACCEL_GROUND, GRAVITY, PLAYER, TICK, TIME_EPS } from '../src/config';
import { Rng } from '../src/core/rng';
import { clone, v3, type V3 } from '../src/core/vec';
import {
  applyPlayerInputEdges,
  computeMuzzle,
  playerNextEventTime,
  qbBlockReason,
  qbCooldownRemaining,
  updatePlayer,
} from '../src/sim/player';
import { Sim } from '../src/sim/sim';
import type { EnemyDef, GeneratorId, LegsId, SimEvent, SolidDef } from '../src/sim/types';
import { SKIN } from '../src/sim/world';
import { makeGuard, makeTestStage } from '../src/stage/testStages';

// ───────────────────────────── helpers ─────────────────────────────

interface MkOpts {
  legs?: LegsId;
  generator?: GeneratorId;
  solids?: SolidDef[];
  start?: V3;
  yaw?: number;
  enemies?: EnemyDef[];
  floorSize?: number;
}

function mk(o: MkOpts = {}): Sim {
  return new Sim(makeTestStage({ solids: o.solids, start: o.start, yaw: o.yaw, enemies: o.enemies, floorSize: o.floorSize }), {
    loadout: { fcs: 'medium', generator: o.generator ?? 'balanced', legs: o.legs ?? 'biped' },
  });
}

const solid = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): SolidDef => ({
  min: v3(x0, y0, z0),
  max: v3(x1, y1, z1),
  material: 'wall',
});

const LEGS: Array<{ legs: LegsId; mult: number }> = [
  { legs: 'biped', mult: 1.0 },
  { legs: 'quadruped', mult: 0.8 },
];

const hspeed = (sim: Sim): number => Math.hypot(sim.player.vel.x, sim.player.vel.z);
const hdist = (a: V3, b: V3): number => Math.hypot(a.x - b.x, a.z - b.z);
const tickAt = (seconds: number): number => Math.round(seconds / TICK);

/** Runs whole ticks until the sim reaches `seconds` (a multiple of 1/120), calling `each` after every tick. */
function runUntil(sim: Sim, seconds: number, each?: () => void): void {
  const target = tickAt(seconds);
  while (sim.tickIndex < target) {
    sim.tick();
    each?.();
  }
}

function near(actual: number, expected: number, eps: number): void {
  expect(Number.isFinite(actual)).toBe(true);
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(eps);
}

function ofType<T extends SimEvent['type']>(events: SimEvent[], type: T): Array<Extract<SimEvent, { type: T }>> {
  return events.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type);
}

function report(label: string, data: Record<string, unknown>): void {
  // Raw values (no rounding): these lines are what the project report quotes.
  const parts = Object.entries(data).map(([k, v]) => `${k}=${String(v)}`);
  console.log(`[player] ${label}: ${parts.join(', ')}`);
}

/** Closed-form distance of an unobstructed QB `t` seconds after the press (SPEC §7.2). */
function qbDistance(t: number, legs = 1, air = false): number {
  const v0 = PLAYER.qbSpeed * legs;
  const vT = (air ? PLAYER.airSpeed : PLAYER.glideSpeed) * legs;
  const a = (air ? GLIDE_ACCEL_AIR : GLIDE_ACCEL_GROUND) * legs;
  const ti = PLAYER.qbImpulseSeconds;
  if (t <= ti) return v0 * t;
  const s = Math.min(t - ti, PLAYER.qbDecelSeconds);
  let d = v0 * ti + v0 * s - 0.5 * a * s * s;
  if (t > ti + PLAYER.qbDecelSeconds) d += vT * (t - ti - PLAYER.qbDecelSeconds);
  return d;
}

/** Puts the mech into a steady forward glide (Shift once, no other input) and returns the sim. */
function steadyGlide(o: MkOpts = {}): Sim {
  const sim = mk(o);
  sim.input.glideTogglePressed = true;
  runUntil(sim, 1.0);
  expect(sim.player.horizontalMode).toBe('glide');
  near(hspeed(sim), PLAYER.glideSpeed * sim.stats.horizontalSpeedMultiplier, 1e-12);
  sim.drainEvents();
  return sim;
}

// ───────────────────────────── 0. basics ─────────────────────────────

describe('player basics', () => {
  it('spawns grounded and does not move at all without input (position and muzzle stay exact)', () => {
    const sim = mk();
    const p = sim.player;
    const spawn = clone(p.pos);
    const muzzle0 = clone(p.muzzle);
    expect(p.grounded).toBe(true);
    expect(p.verticalMode).toBe('grounded');
    expect(p.horizontalMode).toBe('walk');
    expect(p.en).toBe(120);
    runUntil(sim, 1.0, () => {
      expect(p.pos).toEqual(spawn);
      expect(p.prevPos).toEqual(spawn);
      expect(p.muzzle).toEqual(muzzle0);
    });
    expect(spawn.y).toBe(PLAYER.half.y + 0.001);
    expect(p.grounded).toBe(true);
    expect(p.vel).toEqual({ x: 0, y: 0, z: 0 });
    expect(p.en).toBe(120);
    expect(p.muzzle).toEqual(computeMuzzle(p.pos, p.yaw, v3()));
    expect(playerNextEventTime(sim)).toBe(Infinity);
    expect(qbBlockReason(sim)).toBeNull();
    expect(qbCooldownRemaining(sim)).toBe(0);
  });

  it('a start point in mid-air begins airborne and falls', () => {
    const sim = mk({ start: v3(0, 30, 0) });
    expect(sim.player.grounded).toBe(false);
    expect(sim.player.verticalMode).toBe('falling');
    runUntil(sim, 1.0);
    near(sim.player.pos.y, 30 - 0.5 * GRAVITY, 1e-9);
    near(sim.player.vel.y, -GRAVITY, 1e-9);
  });
});

// ───────────────────────────── 1. single press ─────────────────────────────

describe('QB is a single-shot action (SPEC §7.2, §11 単発入力)', () => {
  it('Q pressed once and held for 5 s gives exactly one QB costing exactly 36 EN', () => {
    const sim = mk();
    const p = sim.player;
    const start = clone(p.pos);
    // Q goes down once and stays down: the input layer delivers exactly one edge.
    sim.input.qbPressed = true;
    let enAt075 = NaN;
    let minEn = Infinity;
    runUntil(sim, 5.0, () => {
      minEn = Math.min(minEn, p.en);
      if (sim.tickIndex <= tickAt(0.75)) expect(p.en).toBe(84);
      if (sim.tickIndex === tickAt(0.75)) enAt075 = p.en;
      expect(sim.input.qbPressed).toBe(false);
    });
    const events = sim.drainEvents();
    expect(p.qbSuccessfulCount).toBe(1);
    expect(ofType(events, 'qb')).toHaveLength(1);
    expect(ofType(events, 'qb-rejected')).toHaveLength(0);
    expect(p.qbLastStartedAt).toBe(0);
    expect(enAt075).toBe(84);
    expect(minEn).toBe(84);
    // 84 + 15 EN/s from t = 0.75 s reaches the 120 cap at 3.15 s.
    expect(p.en).toBe(120);
    near(hdist(p.pos, start), qbDistance(5.0), 1e-6);
    report('Q held 5 s', {
      qbCount: p.qbSuccessfulCount,
      enBefore: 120,
      enAt0_75s: enAt075,
      enMin: minEn,
      enAt5s: p.en,
      distanceAt5s: hdist(p.pos, start),
    });
  });

  it('a press 0.5 s later fails on the cooldown, a press at 1.0 s succeeds', () => {
    const sim = mk();
    const p = sim.player;
    sim.input.qbPressed = true;
    runUntil(sim, 0.5);
    sim.drainEvents();

    sim.input.qbPressed = true; // t = 0.5 s
    sim.tick();
    let ev = sim.drainEvents();
    expect(ofType(ev, 'qb')).toHaveLength(0);
    expect(ofType(ev, 'qb-rejected').map((e) => e.reason)).toEqual(['cooldown']);
    expect(p.qbSuccessfulCount).toBe(1);
    expect(p.qbLastStartedAt).toBe(0);
    expect(p.lastEnSpentAt).toBe(0);
    expect(p.en).toBe(84);

    runUntil(sim, 1.0 - TICK);
    near(qbCooldownRemaining(sim), TICK, 1e-9);
    expect(qbBlockReason(sim)).toBe('cooldown');
    sim.input.qbPressed = true; // t = 119/120 s: still too early
    sim.tick();
    ev = sim.drainEvents();
    expect(ofType(ev, 'qb-rejected').map((e) => e.reason)).toEqual(['cooldown']);
    expect(p.qbSuccessfulCount).toBe(1);

    near(sim.time, 1.0, 1e-12);
    expect(qbCooldownRemaining(sim)).toBe(0);
    expect(qbBlockReason(sim)).toBeNull();
    const enBefore = p.en; // 84 + 15 * 0.25
    near(enBefore, 87.75, 1e-9);
    sim.input.qbPressed = true; // t = 1.0 s
    sim.tick();
    ev = sim.drainEvents();
    expect(ofType(ev, 'qb')).toHaveLength(1);
    expect(p.qbSuccessfulCount).toBe(2);
    near(p.qbLastStartedAt ?? NaN, 1.0, 1e-12);
    near(p.en, enBefore - 36, 1e-9);
    expect(p.horizontalMode).toBe('quickboost');
    near(hspeed(sim), 80, 1e-12); // set, not added to the 22 m/s glide
    report('QB cooldown', { rejectedAt: '0.5 s and 0.99167 s (cooldown)', acceptedAt: p.qbLastStartedAt, enAfterSecondQb: p.en });
  });
});

// ───────────────────────────── 2. release, inertia, auto glide, distances ─────────────────────────────

describe('QB impulse, inertia and automatic glide with every key released (SPEC §7.2, §11 入力解放・移動量)', () => {
  for (const { legs, mult } of LEGS) {
    it(`${legs}: 0.15 s impulse, 0.60 s decay to the glide speed, ${(42.6 * mult).toFixed(2)} m in 0.75 s`, () => {
      const sim = mk({ legs });
      const p = sim.player;
      const start = clone(p.pos);
      sim.input.qbPressed = true;
      sim.tick();
      // Every key is up from here on (Q released right after the press, no WASD, no Shift).
      expect(sim.input).toEqual({
        moveX: 0,
        moveZ: 0,
        jump: false,
        brake: false,
        fire: false,
        qbPressed: false,
        glideTogglePressed: false,
        jumpPressed: false,
        weaponSelect: null,
      });
      const modes: string[] = [p.horizontalMode];
      let distImpulse = NaN;
      const check = (): void => {
        const t = sim.tickIndex * TICK;
        if (modes[modes.length - 1] !== p.horizontalMode) modes.push(p.horizontalMode);
        near(hdist(p.pos, start), qbDistance(t, mult), 1e-9);
        if (sim.tickIndex < tickAt(0.15)) {
          expect(p.horizontalMode).toBe('quickboost');
          near(hspeed(sim), 80 * mult, 1e-12);
          near(p.qbImpulseRemaining, 0.15 - t, 1e-9);
        } else {
          expect(p.horizontalMode).toBe('glide');
          expect(p.glideEnabled).toBe(true);
          expect(p.qbImpulseRemaining).toBe(0);
          const s = Math.min(t - 0.15, 0.6);
          near(hspeed(sim), (80 - ((80 - 22) / 0.6) * s) * mult, 1e-9);
        }
        if (sim.tickIndex === tickAt(0.15)) distImpulse = hdist(p.pos, start);
      };
      check();
      runUntil(sim, 0.75, check);
      const dist075 = hdist(p.pos, start);
      const speed075 = hspeed(sim);
      expect(modes).toEqual(['quickboost', 'glide']);
      near(distImpulse, 12 * mult, 1e-9);
      near(dist075, 42.6 * mult, 1e-6);
      near(speed075, 22 * mult, 1e-12);
      expect(p.desiredDir).toEqual({ x: 0, z: -1 });
      expect(p.vel.x).toBe(0);
      expect(p.vel.y).toBe(0);

      // … and the glide simply continues with no input at all.
      runUntil(sim, 3.0, check);
      expect(p.glideEnabled).toBe(true);
      near(hdist(p.pos, start), (42.6 + 22 * 2.25) * mult, 1e-6);
      const ev = sim.drainEvents();
      expect(ofType(ev, 'glide')).toEqual([{ type: 'glide', enabled: true, auto: true }]);
      expect(ofType(ev, 'qb')).toEqual([{ type: 'qb', dir: { x: 0, z: -1 }, airborne: false }]);
      report(`QB ${legs}, all keys released`, {
        distanceAt0_15s: distImpulse,
        distanceAt0_75s: dist075,
        speedAt0_75s: speed075,
        modes: modes.join('>'),
        en: p.en,
      });
    });
  }

  it('steady glide covers 16.5 m (biped) / 13.2 m (quadruped) in the same 0.75 s', () => {
    for (const { legs, mult } of LEGS) {
      const sim = steadyGlide({ legs });
      const from = clone(sim.player.pos);
      runUntil(sim, 1.75);
      const d = hdist(sim.player.pos, from);
      near(d, 16.5 * mult, 1e-9);
      report(`steady glide ${legs}`, { distanceIn0_75s: d });
    }
  });

  it('the QB direction follows WASD through the camera yaw, else the camera forward; speed is set, never stacked', () => {
    // yaw = +90°: forward = -X, right = -Z.
    const sim = mk({ yaw: Math.PI / 2 });
    const p = sim.player;
    sim.input.moveX = 1; // D
    sim.input.qbPressed = true;
    sim.tick();
    near(p.qbDir.x, 0, 1e-12);
    near(p.qbDir.z, -1, 1e-12);
    near(hspeed(sim), 80, 1e-9);
    sim.input.moveX = 0;
    runUntil(sim, 1.0);
    // Diagonal input is normalised: W + A at yaw 90° → (-1, +1)/√2.
    sim.input.moveZ = 1;
    sim.input.moveX = -1;
    sim.input.qbPressed = true;
    sim.tick();
    near(p.qbDir.x, -Math.SQRT1_2, 1e-12);
    near(p.qbDir.z, Math.SQRT1_2, 1e-12);
    near(hspeed(sim), 80, 1e-9);
    expect(p.qbSuccessfulCount).toBe(2);
  });
});

// ───────────────────────────── 3. frame-rate independence ─────────────────────────────

describe('QB distance does not depend on the frame rate (SPEC §9)', () => {
  function feed(label: string, frames: number[]): { d075: number; d2: number } {
    const sim = mk();
    const p = sim.player;
    const start = clone(p.pos);
    sim.input.qbPressed = true;
    let fed = 0;
    let d075 = NaN;
    for (const dt of frames) {
      sim.advance(dt);
      fed += dt;
      // At every frame the position equals the closed form for the simulated time.
      near(hdist(p.pos, start), qbDistance(sim.tickIndex * TICK), 1e-6);
      near(sim.time, sim.tickIndex * TICK, 1e-12);
      expect(Math.abs(fed - sim.time)).toBeLessThanOrEqual(TICK + 1e-9);
      if (Math.abs(fed - 0.75) < 1e-9) {
        expect(sim.tickIndex).toBe(90);
        d075 = hdist(p.pos, start);
      }
    }
    expect(sim.tickIndex).toBe(240);
    expect(p.qbSuccessfulCount).toBe(1);
    const d2 = hdist(p.pos, start);
    report(`QB at ${label}`, { frames: frames.length, distanceAt0_75s: d075, distanceAt2s: d2, en: p.en });
    return { d075, d2 };
  }

  /** `n` equal frames up to 0.75 s (the last one shortened if needed), then equal frames up to 2.0 s. */
  function steady(dt: number): number[] {
    const out: number[] = [];
    let t = 0;
    for (const end of [0.75, 2.0]) {
      while (end - t > 1e-9) {
        const step = Math.min(dt, end - t);
        out.push(step);
        t += step;
      }
    }
    return out;
  }

  function irregular(seed: number): number[] {
    const rng = new Rng(seed);
    const out: number[] = [];
    let t = 0;
    for (const end of [0.75, 2.0]) {
      while (end - t > 1e-9) {
        // 1 ms … 60 ms frames, including ones shorter than a tick and long hitches.
        const step = Math.min(0.001 + rng.next() * rng.next() * 0.059, end - t);
        out.push(step);
        t += step;
      }
    }
    return out;
  }

  it('30, 60, 120, 240, 10 fps and irregular frame times give the same distances within 1e-6', () => {
    const runs = [
      feed('30 fps', steady(1 / 30)),
      feed('60 fps', steady(1 / 60)),
      feed('120 fps', steady(1 / 120)),
      feed('240 fps', steady(1 / 240)),
      feed('10 fps', steady(1 / 10)),
      feed('irregular A', irregular(7)),
      feed('irregular B', irregular(20260908)),
    ];
    for (const r of runs) {
      near(r.d075, 42.6, 1e-6);
      near(r.d2, 42.6 + 22 * 1.25, 1e-6);
      near(r.d075, runs[2].d075, 1e-6);
      near(r.d2, runs[2].d2, 1e-6);
    }
  });

  it('direct sub-steps of arbitrary length (not aligned to the impulse end) integrate the same distance', () => {
    for (const { legs, mult } of LEGS) {
      const sim = mk({ legs });
      const p = sim.player;
      const start = clone(p.pos);
      const rng = new Rng(99);
      sim.input.qbPressed = true;
      let steps = 0;
      while (0.75 - sim.time > 1e-12) {
        const h = Math.min(0.0003 + rng.next() * (TICK - 0.0003), 0.75 - sim.time);
        applyPlayerInputEdges(sim);
        updatePlayer(sim, h, 0);
        sim.time += h;
        steps++;
      }
      near(hdist(p.pos, start), 42.6 * mult, 1e-9);
      near(hspeed(sim), 22 * mult, 1e-9);
      expect(p.horizontalMode).toBe('glide');
      expect(p.qbSuccessfulCount).toBe(1);
      report(`QB ${legs}, ${steps} random sub-steps`, { distanceAt0_75s: hdist(p.pos, start) });
    }
  });
});

// ───────────────────────────── 4. glide and EN regeneration ─────────────────────────────

describe('glide is free and never blocks EN recovery on the ground (SPEC §6, §7.3, §11 グライドのEN)', () => {
  it('after a QB that empties the tank the glide continues at EN 0 and EN recovers from exactly 0.75 s', () => {
    const sim = mk();
    const p = sim.player;
    const start = clone(p.pos);
    p.en = 36;
    sim.input.qbPressed = true;
    let firstRegenTick = -1;
    runUntil(sim, 3.0, () => {
      const t = sim.tickIndex * TICK;
      if (t <= 0.75 + 1e-9) expect(p.en).toBe(0);
      else near(p.en, 15 * (t - 0.75), 1e-9);
      if (firstRegenTick < 0 && p.en > 0) firstRegenTick = sim.tickIndex;
      expect(p.grounded).toBe(true);
      if (t >= 0.15 - 1e-9) {
        expect(p.horizontalMode).toBe('glide');
        expect(p.glideEnabled).toBe(true);
      }
      near(hdist(p.pos, start), qbDistance(t), 1e-9);
    });
    expect(firstRegenTick).toBe(tickAt(0.75) + 1);
    expect(p.lastEnSpentAt).toBe(0); // the QB start, never re-armed by the impulse end or the decay
    near(hspeed(sim), 22, 1e-12);
    report('glide at EN 0 after QB', {
      enUntil0_75s: 0,
      firstRegenAt: firstRegenTick * TICK,
      enAt3s: p.en,
      speed: hspeed(sim),
      distanceAt3s: hdist(p.pos, start),
    });
  });

  it('the glide can be switched on and steered with EN 0', () => {
    const sim = mk();
    const p = sim.player;
    p.en = 36;
    sim.input.qbPressed = true;
    sim.tick(); // EN 0 from t = 0
    expect(p.en).toBe(0);
    sim.input.brake = true; // stop completely
    runUntil(sim, 1.0);
    sim.input.brake = false;
    expect(hspeed(sim)).toBe(0);
    expect(p.glideEnabled).toBe(false);
    p.en = 0; // (recovered a little meanwhile) – empty the tank again without recording a spend
    const from = clone(p.pos);
    sim.input.glideTogglePressed = true;
    sim.input.moveX = 1;
    runUntil(sim, 2.0);
    expect(p.glideEnabled).toBe(true);
    expect(p.horizontalMode).toBe('glide');
    near(p.vel.x, 22, 1e-12);
    // 22 m/s reached after 22/(58/0.6) s: distance = 22·1 − 22²/(2·96.67)
    near(hdist(p.pos, from), 22 - (22 * 22) / (2 * GLIDE_ACCEL_GROUND), 1e-9);
    near(p.en, 15, 1e-9); // recovering all the while
  });

  it('EN never recovers in the air (rising, inertia, airborne glide, falling) and resumes after landing', () => {
    // Dropped from 60 m: about 2.5 s of air time, far beyond the 0.75 s delay.
    const sim = mk({ start: v3(0, 60, 0) });
    const p = sim.player;
    sim.input.qbPressed = true;
    let airTicks = 0;
    let landedAt = -1;
    runUntil(sim, 5.0, () => {
      if (landedAt < 0) {
        if (p.grounded) landedAt = sim.tickIndex;
        else {
          airTicks++;
          expect(p.en).toBe(84);
        }
      }
    });
    expect(airTicks * TICK).toBeGreaterThan(2.0);
    expect(landedAt).toBeGreaterThan(0);
    // After the landing the delay is long over: recovery from the first fully grounded sub-step.
    near(p.en, Math.min(120, 84 + 15 * (5.0 - landedAt * TICK)), 1e-9);
    expect(p.glideEnabled).toBe(true);
    near(hspeed(sim), 22, 1e-12);
    report('no EN recovery in the air', { airSeconds: airTicks * TICK, enWhileAirborne: 84, landedAt: landedAt * TICK, enAt5s: p.en });

    // A plain jump with a partly filled tank: constant while airborne, recovering on the ground.
    const s2 = mk();
    s2.player.en = 50;
    s2.input.jumpPressed = true;
    let prev = 50;
    let sawAir = 0;
    runUntil(s2, 2.0, () => {
      if (!s2.player.grounded) {
        sawAir++;
        expect(s2.player.en).toBe(prev);
      }
      prev = s2.player.en;
    });
    expect(sawAir).toBeGreaterThan(100);
    expect(s2.player.en).toBeGreaterThan(50);
  });
});

// ───────────────────────────── 5. EN boundary ─────────────────────────────

describe('QB EN boundary (SPEC §6, §7.2, §11 残量境界)', () => {
  it('EN 35: rejected, nothing changes, and the press is never queued', () => {
    const sim = mk();
    const p = sim.player;
    const start = clone(p.pos);
    p.en = 35;
    sim.input.qbPressed = true;
    applyPlayerInputEdges(sim); // the press alone, before any time passes
    expect(sim.input.qbPressed).toBe(false);
    expect(p.en).toBe(35);
    expect(p.qbSuccessfulCount).toBe(0);
    expect(p.qbLastStartedAt).toBeNull();
    expect(p.lastEnSpentAt).toBeNull();
    expect(p.qbImpulseRemaining).toBe(0);
    expect(p.horizontalMode).toBe('walk');
    expect(p.glideEnabled).toBe(false);
    expect(p.vel).toEqual({ x: 0, y: 0, z: 0 });
    expect(ofType(sim.drainEvents(), 'qb-rejected').map((e) => e.reason)).toEqual(['no-en']);
    expect(qbBlockReason(sim)).toBe('no-en');

    // EN recovers past 36 (no recovery delay was armed) — the old press must not fire.
    runUntil(sim, 3.0);
    near(p.en, 35 + 15 * 3, 1e-9);
    expect(p.qbSuccessfulCount).toBe(0);
    expect(ofType(sim.drainEvents(), 'qb')).toHaveLength(0);
    expect(hdist(p.pos, start)).toBe(0);
    expect(p.glideEnabled).toBe(false);

    // No cooldown was started either: a fresh press works at once.
    sim.input.qbPressed = true;
    sim.tick();
    expect(p.qbSuccessfulCount).toBe(1);
    report('QB at EN 35', { result: 'rejected (no-en)', enAfterPress: 35, qbCount: 0, cooldownStarted: false, firedLater: false });
  });

  it('just below 36 is still rejected', () => {
    const sim = mk();
    sim.player.en = 36 - 1e-6;
    sim.input.qbPressed = true;
    applyPlayerInputEdges(sim);
    expect(sim.player.qbSuccessfulCount).toBe(0);
    expect(sim.player.en).toBe(36 - 1e-6);
  });

  it('EN 36: exactly one QB leaving EN 0; inertia and automatic glide continue', () => {
    const sim = mk();
    const p = sim.player;
    const start = clone(p.pos);
    p.en = 36;
    sim.input.qbPressed = true;
    applyPlayerInputEdges(sim);
    expect(p.en).toBe(0);
    expect(p.qbSuccessfulCount).toBe(1);
    expect(p.horizontalMode).toBe('quickboost');
    runUntil(sim, 0.75);
    expect(p.en).toBe(0);
    near(hdist(p.pos, start), 42.6, 1e-6);
    near(hspeed(sim), 22, 1e-12);
    expect(p.horizontalMode).toBe('glide');
    const d075 = hdist(p.pos, start);
    runUntil(sim, 2.0);
    expect(p.qbSuccessfulCount).toBe(1);
    expect(p.glideEnabled).toBe(true);
    near(hdist(p.pos, start), 42.6 + 22 * 1.25, 1e-6);
    report('QB at EN 36', { qbCount: 1, enAfterPress: 0, distanceAt0_75s: d075, speedAt0_75s: 22, distanceAt2s: hdist(p.pos, start) });
  });
});

// ───────────────────────────── 5b. EN ledger exactness ─────────────────────────────

describe('EN thresholds decide exactly in natural play (SPEC §6, §7.2, §11 残量境界)', () => {
  // Regeneration and the flight drain must not pile up rounding errors: at the instant the tank should hold
  // exactly 36 (8) EN it holds exactly 36 (8), so a QB (beam shot) requested then is not refused for a tick.
  const GENERATORS: Array<{ generator: GeneratorId; maxEn: number; regen: number }> = [
    { generator: 'capacity', maxEn: 180, regen: 10 },
    { generator: 'balanced', maxEn: 120, regen: 15 },
    { generator: 'recovery', maxEn: 90, regen: 20 },
  ];
  const REGEN_MULT: Record<LegsId, number> = { biped: 1, quadruped: 0.75 };
  /** Integer EN unit of the reference below: 1/96 EN. Every per-tick amount (rate / 120) is a whole number of them. */
  const U = 96;

  for (const { generator, maxEn, regen } of GENERATORS) {
    for (const { legs } of LEGS) {
      it(`${generator} + ${legs}: with Q pressed on every tick each QB starts on the very tick the tank reaches 36`, () => {
        const sim = mk({ generator, legs, floorSize: 12000 });
        const p = sim.player;
        const perTick = (regen * REGEN_MULT[legs] * U) / 120;
        expect(Number.isInteger(perTick)).toBe(true);
        // Exact integer reference written from SPEC §6 / §7.2 (ground only): a press at tick i (time i/120)
        // starts a QB iff >= 1.00 s (120 ticks) since the last start and EN >= 36; EN recovers during a tick
        // that begins >= 0.75 s (90 ticks) after the last QB.
        let units = maxEn * U;
        let lastQb = -Infinity;
        let count = 0;
        let startedAtExactly36 = 0;
        let refusedBelow36 = 0;
        for (let i = 0; i < 40 * 120; i++) {
          sim.input.qbPressed = true;
          if (i - lastQb >= 120) {
            if (units >= 36 * U) {
              if (units === 36 * U) startedAtExactly36++;
              units -= 36 * U;
              lastQb = i;
              count++;
            } else refusedBelow36++;
          }
          if (i >= lastQb + 90 && units < maxEn * U) units = Math.min(maxEn * U, units + perTick);
          sim.tick();
          expect(p.qbSuccessfulCount).toBe(count);
          near(p.en, units / U, 1e-12);
          if (units % U === 0) expect(p.en).toBe(units / U); // whole EN amounts are exact
        }
        expect(p.grounded).toBe(true);
        expect(startedAtExactly36).toBeGreaterThanOrEqual(3);
        expect(refusedBelow36).toBeGreaterThan(100); // the ticks just before were refused: the threshold is strict
        report(`Q on every tick, ${generator} + ${legs}`, { seconds: 40, qbStarted: count, startedAtExactly36EN: startedAtExactly36, refusedBelow36EN: refusedBelow36 });
      });
    }
  }

  it('recovery + biped: QBs at t = 0 and 1.000 s, then Q at t = 2.400 s where EN = 90 − 36 + 5 − 36 + 20·0.65 = 36', () => {
    const sim = mk({ generator: 'recovery', floorSize: 4000 });
    const p = sim.player;
    sim.input.qbPressed = true;
    runUntil(sim, 1.0);
    expect(p.en).toBe(59);
    sim.input.qbPressed = true;
    runUntil(sim, 2.4 - TICK);
    expect(p.qbSuccessfulCount).toBe(2);
    // one tick early: 36 − 1/6 EN → refused, and the refusal changes nothing
    sim.input.qbPressed = true;
    sim.tick();
    expect(p.qbSuccessfulCount).toBe(2);
    expect(ofType(sim.drainEvents(), 'qb-rejected').map((e) => e.reason)).toEqual(['no-en']);
    expect(p.en).toBe(36);
    expect(qbBlockReason(sim)).toBeNull();
    // t = 2.400 s
    sim.input.qbPressed = true;
    sim.tick();
    expect(p.qbSuccessfulCount).toBe(3);
    near(p.qbLastStartedAt ?? NaN, 2.4, 1e-12);
    expect(p.en).toBe(0);
    expect(ofType(sim.drainEvents(), 'qb-rejected')).toHaveLength(0);
    report('QB at the instant EN returns to 36', { generator: 'recovery', pressAt: 2.4, enAtPress: 36, started: true });
  });

  it('a beam shot due at the instant the tank returns to exactly 8 EN is fired, one tick earlier it is refused', () => {
    for (const early of [false, true]) {
      const sim = mk(); // balanced + biped: 15 EN/s = 0.125 EN per tick
      const p = sim.player;
      sim.input.weaponSelect = 'beam';
      sim.input.jumpPressed = true;
      sim.input.jump = true;
      let guard = 0;
      while (p.en > 0 && guard++ < 2000) sim.tick(); // fly until the tank is empty
      expect(p.en).toBe(0);
      expect(sim.tickIndex).toBe(tickAt(0.2 + 120 / 20));
      near(p.lastEnSpentAt ?? NaN, 6.2, 1e-12);
      sim.input.jump = false;
      while (!p.grounded && guard++ < 4000) sim.tick();
      expect(p.grounded).toBe(true);
      expect(p.en).toBe(0);
      sim.drainEvents();
      const n = early ? 62 : 63;
      for (let i = 1; i <= n; i++) {
        sim.tick();
        expect(p.en).toBe(i * 0.125);
      }
      sim.input.fire = true;
      sim.tick();
      if (early) {
        // 7.875 EN at the end of this tick: refused, nothing is consumed and no timer moves
        expect(p.en).toBe(7.875);
        expect(sim.shots).toHaveLength(0);
        expect(ofType(sim.drainEvents(), 'fire-rejected')).toEqual([{ type: 'fire-rejected', weapon: 'beam', reason: 'no-en' }]);
        near(p.lastEnSpentAt ?? NaN, 6.2, 1e-12);
        sim.tick();
      }
      // The tank reaches exactly 8.000 at the end of this tick and the shot due then is paid from it.
      const ev = sim.drainEvents();
      expect(ofType(ev, 'fire-rejected')).toHaveLength(0);
      expect(ofType(ev, 'player-shot')).toHaveLength(1);
      expect(sim.shots).toHaveLength(1);
      expect(sim.shots[0].firedAt).toBe(sim.time);
      expect(p.en).toBe(0);
      expect(p.lastEnSpentAt).toBe(sim.time);
      if (!early) report('beam at the instant EN returns to 8', { landedEmptyAt: sim.time - 64 * TICK, firedAt: sim.time, enAfter: p.en });
    }
  });

  it('the flight drain is exact too: after 504 thrust ticks the tank holds exactly 36 EN and a QB in the air starts', () => {
    const sim = mk({ floorSize: 4000 });
    const p = sim.player;
    sim.input.jumpPressed = true;
    sim.input.jump = true;
    runUntil(sim, 0.2);
    expect(p.en).toBe(120);
    for (let k = 1; k <= 504; k++) {
      sim.tick();
      expect(p.flying).toBe(true);
      near(p.en, 120 - k / 6, 1e-12);
      if (k % 6 === 0) expect(p.en).toBe(120 - k / 6);
    }
    expect(p.en).toBe(36);
    near(p.lastEnSpentAt ?? NaN, 0.2 + 504 * TICK, 1e-12);
    sim.input.qbPressed = true;
    sim.tick();
    expect(p.qbSuccessfulCount).toBe(1);
    expect(p.en).toBe(0);
    expect(p.flying).toBe(false); // QB first: nothing is left for the thrust of this tick
    expect(ofType(sim.drainEvents(), 'qb-rejected')).toHaveLength(0);
    expect(p.grounded).toBe(false);
  });

  it('EN does not depend on how enemy events cut the ticks into sub-steps', () => {
    // Twin runs with the same keys; in `b` a guard fires 3-round bursts 0.12 s apart (= 14.4 ticks), which
    // ends sub-steps in the middle of ticks all the time. Regeneration and flight drain must not notice.
    const a = mk({ generator: 'recovery', floorSize: 4000 });
    const b = mk({ generator: 'recovery', floorSize: 4000, enemies: [makeGuard('G1', 6, -45)] });
    const drive = (sim: Sim, i: number): void => {
      // three QBs (away from the guard, back, away again), each stopped with the brake so that the mech
      // stays inside the guard's 90 m range; then a jump with Space held (flight) and a release in the air
      sim.input.moveZ = i >= 120 && i < 400 ? 1 : -1;
      if (i === 0 || i === 120 || i === 400) sim.input.qbPressed = true;
      sim.input.brake = (i >= 60 && i < 110) || (i >= 180 && i < 230) || (i >= 460 && i < 510);
      if (i === 700) sim.input.jumpPressed = true;
      sim.input.jump = i >= 700 && i < 1000;
    };
    let offTickShots = 0;
    let lastShot: number | null = null;
    let regenTicks = 0;
    let thrustTicks = 0;
    for (let i = 0; i < 1010; i++) {
      drive(a, i);
      drive(b, i);
      const en = a.player.en;
      a.tick();
      b.tick();
      expect(b.status).toBe('playing');
      expect(b.player.en).toBe(a.player.en); // bit for bit
      expect(b.player.grounded).toBe(a.player.grounded);
      expect(b.player.lastEnSpentAt).toBe(a.player.lastEnSpentAt);
      if (a.player.en > en) regenTicks++;
      if (a.player.flying) thrustTicks++;
      const shot = b.enemies[0].lastShotAt;
      if (shot !== null && shot !== lastShot) {
        lastShot = shot;
        const ticks = shot / TICK;
        if (Math.abs(ticks - Math.round(ticks)) > 1e-3) offTickShots++;
      }
    }
    expect(offTickShots).toBeGreaterThan(5); // the cuts really happened
    expect(regenTicks).toBeGreaterThan(300);
    expect(thrustTicks).toBeGreaterThan(200);
    expect(a.player.grounded).toBe(false); // (a landing may be registered at a cut; the comparison ends before one)
  });
});

// ───────────────────────────── 5b'. exact-arithmetic reference ─────────────────────────────

describe('EN and the vertical state against an exact rational reference (SPEC §6, §7.4)', () => {
  // The reference below is written from the SPEC text with BigInt fractions — no rounding anywhere — and
  // mirrors the sub-step structure of the scheduler on a flat floor: QB presses, jump / Space hold /
  // flight (incl. the tank running dry inside a tick), beam shots, regeneration, landings. Random keys with
  // long stretches of "Q on every tick" / "beam trigger held" make every recovery cross the 36 / 8 EN
  // thresholds. Decisions must agree on every tick; EN must be the exact value (to the last few ulps).
  const gcd = (a: bigint, b: bigint): bigint => {
    if (a < 0n) a = -a;
    if (b < 0n) b = -b;
    while (b) [a, b] = [b, a % b];
    return a;
  };
  class Q {
    readonly n: bigint;
    readonly d: bigint;
    constructor(n: bigint, d = 1n) {
      if (d < 0n) {
        n = -n;
        d = -d;
      }
      const g = gcd(n, d);
      this.n = g > 1n ? n / g : n;
      this.d = g > 1n ? d / g : d;
    }
    add(o: Q): Q {
      return new Q(this.n * o.d + o.n * this.d, this.d * o.d);
    }
    sub(o: Q): Q {
      return new Q(this.n * o.d - o.n * this.d, this.d * o.d);
    }
    mul(o: Q): Q {
      return new Q(this.n * o.n, this.d * o.d);
    }
    div(o: Q): Q {
      return new Q(this.n * o.d, this.d * o.n);
    }
    cmp(o: Q): number {
      const l = this.n * o.d;
      const r = o.n * this.d;
      return l < r ? -1 : l > r ? 1 : 0;
    }
    num(): number {
      const s = 1n << 80n;
      return Number((this.n * s) / this.d) / Number(s);
    }
  }
  const q = (n: number, d = 1): Q => new Q(BigInt(n), BigInt(d));
  const lt = (a: Q, b: Q): boolean => a.cmp(b) < 0;
  const le = (a: Q, b: Q): boolean => a.cmp(b) <= 0;
  const eq = (a: Q, b: Q): boolean => a.cmp(b) === 0;
  const least = (a: Q, b: Q): Q => (le(a, b) ? a : b);
  const ZERO = q(0);
  const K = {
    qb: q(36),
    beam: q(8),
    fly: q(20),
    hold: q(1, 5),
    regenDelay: q(3, 4),
    cooldown: q(1),
    beamInterval: q(1, 4),
    gravity: q(18),
    jump: q(10),
    climb: q(8),
    skin: q(1, 10000),
    contact: q(1, 1000000),
  };
  interface Keys {
    jump: boolean;
    jumpPressed: boolean;
    qb: boolean;
    fire: boolean;
    brake: boolean;
  }
  class Reference {
    t = ZERO;
    tick = 0;
    y = q(1, 1000); // feet above the floor (the spawn point is 1 mm up)
    vy = ZERO;
    grounded = true;
    en: Q;
    lastSpent: Q | null = null;
    qbLast: Q | null = null;
    qbCount = 0;
    hold: Q | null = null;
    beamNext = ZERO;
    shots = 0;
    qbAtExactly36 = 0;
    beamAtExactly8 = 0;
    constructor(
      readonly maxEn: Q,
      readonly regen: Q,
    ) {
      this.en = maxEn;
    }
    private trackHold(k: Keys, t: Q, pressed: boolean): void {
      if (!k.jump) this.hold = null;
      else if (pressed || !this.hold) this.hold = t;
    }
    private segment(k: Keys, ts: Q, te: Q, reserve: Q): void {
      const h = te.sub(ts);
      this.trackHold(k, ts, false);
      const groundedAtStart = this.grounded;
      let thrust = ZERO;
      if (this.grounded) this.vy = ZERO;
      else {
        let dy: Q;
        if (k.jump && this.hold && le(this.hold.add(K.hold), ts)) {
          const available = this.en.sub(reserve);
          if (lt(ZERO, available)) {
            const full = K.fly.mul(h);
            thrust = le(full, available) ? h : available.div(K.fly);
            this.en = this.en.sub(le(full, available) ? full : available);
          }
        }
        if (lt(ZERO, thrust)) {
          const rest = h.sub(thrust);
          dy = K.climb.mul(h).sub(q(9).mul(rest).mul(rest));
          this.vy = K.climb.sub(K.gravity.mul(rest));
          this.lastSpent = ts.add(thrust);
        } else {
          dy = this.vy.mul(h).sub(q(9).mul(h).mul(h));
          this.vy = this.vy.sub(K.gravity.mul(h));
        }
        const yEnd = this.y.add(dy);
        if (lt(dy, ZERO) && le(yEnd, ZERO)) {
          this.y = least(this.y, K.skin); // swept contact: put down SKIN above the floor
          this.vy = ZERO;
          this.grounded = true;
        } else if (le(this.vy, ZERO) && le(yEnd, K.skin.add(K.contact))) {
          this.y = yEnd; // ended inside the landing gap
          this.vy = ZERO;
          this.grounded = true;
        } else this.y = yEnd;
      }
      const regenAllowed = !this.lastSpent || le(this.lastSpent.add(K.regenDelay), ts);
      if (groundedAtStart && this.grounded && eq(thrust, ZERO) && lt(this.en, this.maxEn) && regenAllowed) {
        this.en = least(this.maxEn, this.en.add(this.regen.mul(h)));
      }
    }
    step(k: Keys): void {
      const tickEnd = q(this.tick + 1, 120);
      let first = true;
      while (lt(this.t, tickEnd)) {
        const t0 = this.t;
        // the scheduler ends the sub-step at the earliest strictly-future event
        let t1 = tickEnd;
        const consider = (e: Q | null): void => {
          if (e && lt(t0, e) && lt(e, t1)) t1 = e;
        };
        if (k.jump && this.hold && !this.grounded) consider(this.hold.add(K.hold));
        if (this.lastSpent && lt(this.en, this.maxEn)) consider(this.lastSpent.add(K.regenDelay));
        if (k.fire) consider(this.beamNext);
        // edges at t0: QB first (36 EN at the press), then the jump
        if (first && k.qb && !k.brake && (!this.qbLast || le(K.cooldown, t0.sub(this.qbLast))) && le(K.qb, this.en)) {
          if (eq(this.en, K.qb)) this.qbAtExactly36++;
          this.en = this.en.sub(K.qb);
          this.lastSpent = t0;
          this.qbLast = t0;
          this.qbCount++;
        }
        this.trackHold(k, t0, first && k.jumpPressed);
        if (first && k.jumpPressed && this.grounded) {
          this.vy = K.jump;
          this.grounded = false;
        }
        first = false;
        // a beam shot due at t1 keeps its 8 EN out of reach of the thrust (QB → beam → flight)
        const reserve = k.fire && le(this.beamNext, t1) && le(K.beam, this.en) ? K.beam : ZERO;
        let ts = t0;
        while (lt(ts, t1)) {
          let te = t1;
          const cut = (e: Q | null): void => {
            if (e && lt(ts, e) && lt(e, te)) te = e;
          };
          if (k.jump && this.hold && !this.grounded) cut(this.hold.add(K.hold));
          if (this.lastSpent && lt(this.en, this.maxEn)) cut(this.lastSpent.add(K.regenDelay));
          this.segment(k, ts, te, reserve);
          ts = te;
        }
        this.t = t1;
        if (k.fire && le(this.beamNext, t1) && le(K.beam, this.en)) {
          if (eq(this.en, K.beam)) this.beamAtExactly8++;
          this.en = this.en.sub(K.beam);
          this.lastSpent = t1;
          this.beamNext = t1.add(K.beamInterval);
          this.shots++;
        }
      }
      this.tick++;
    }
  }

  const CASES: Array<{ generator: GeneratorId; legs: LegsId; maxEn: number; regen: [number, number]; seed: number }> = [
    { generator: 'capacity', legs: 'biped', maxEn: 180, regen: [10, 1], seed: 11 },
    { generator: 'capacity', legs: 'quadruped', maxEn: 180, regen: [15, 2], seed: 12 },
    { generator: 'balanced', legs: 'biped', maxEn: 120, regen: [15, 1], seed: 13 },
    { generator: 'balanced', legs: 'quadruped', maxEn: 120, regen: [45, 4], seed: 14 },
    { generator: 'recovery', legs: 'biped', maxEn: 90, regen: [20, 1], seed: 15 },
    { generator: 'recovery', legs: 'quadruped', maxEn: 90, regen: [15, 1], seed: 16 },
  ];
  it('six generator / legs combinations, 60 s of random QB / flight / beam input each', () => {
    let qbTies = 0;
    let beamTies = 0;
    for (const c of CASES) {
      const sim = mk({ generator: c.generator, legs: c.legs, floorSize: 400000 });
      const p = sim.player;
      const ref = new Reference(q(c.maxEn), q(c.regen[0], c.regen[1]));
      near(sim.stats.regenPerSecond, c.regen[0] / c.regen[1], 0);
      const rng = new Rng(c.seed * 104729);
      const k: Keys = { jump: false, jumpPressed: false, qb: false, fire: false, brake: false };
      sim.input.weaponSelect = 'beam';
      // Phases of 2–10 s: Q on every tick / beam trigger held / both / neither; short and long Space holds on top.
      let mode = 0;
      let phaseLeft = 0;
      let holdLeft = 0;
      let landings = 0;
      for (let i = 0; i < 60 * 120; i++) {
        if (phaseLeft-- <= 0) {
          const r = rng.next();
          mode = r < 0.4 ? 1 : r < 0.7 ? 2 : r < 0.85 ? 3 : 0;
          phaseLeft = 240 + Math.floor(rng.next() * 960);
        }
        k.jumpPressed = false;
        if (k.jump) {
          if (holdLeft-- <= 0) k.jump = false;
          else if (rng.next() < 0.01) k.jumpPressed = true; // released and pressed again between two frames
        } else if (rng.next() < 0.003) {
          k.jump = true;
          k.jumpPressed = true;
          holdLeft = rng.next() < 0.6 ? 2 + Math.floor(rng.next() * 30) : 30 + Math.floor(rng.next() * 120);
        }
        k.qb = mode === 1 || mode === 3 || rng.next() < 0.01;
        k.fire = i > 0 && (mode === 2 || mode === 3);
        if (rng.next() < 0.002) k.brake = !k.brake;
        if (k.brake && rng.next() < 0.05) k.brake = false;
        sim.input.jump = k.jump;
        sim.input.brake = k.brake;
        sim.input.fire = k.fire;
        if (k.jumpPressed) sim.input.jumpPressed = true;
        if (k.qb) sim.input.qbPressed = true;
        const wasGrounded = p.grounded;
        sim.tick();
        ref.step(k);
        if (p.grounded && !wasGrounded) landings++;
        const where = `${c.generator} + ${c.legs}, tick ${i}`;
        expect(p.qbSuccessfulCount, where).toBe(ref.qbCount);
        expect(sim.nextShotId - 1, where).toBe(ref.shots);
        expect(p.grounded, where).toBe(ref.grounded);
        const en = ref.en.num();
        expect(Math.abs(p.en - en), where).toBeLessThanOrEqual(1e-12);
        if (ref.en.d === 1n) expect(p.en, where).toBe(en); // whole EN amounts are exact
        expect(Math.abs(p.pos.y - PLAYER.half.y - ref.y.num()), where).toBeLessThanOrEqual(1e-9);
        expect(Math.abs(p.vel.y - ref.vy.num()), where).toBeLessThanOrEqual(1e-9);
      }
      // the run really exercised what it is meant to check
      expect(ref.qbCount).toBeGreaterThanOrEqual(4);
      expect(ref.shots).toBeGreaterThanOrEqual(4);
      expect(landings).toBeGreaterThanOrEqual(5);
      qbTies += ref.qbAtExactly36;
      beamTies += ref.beamAtExactly8;
      report(`exact reference, ${c.generator} + ${c.legs}`, { ticks: 7200, qb: ref.qbCount, qbAtExactly36EN: ref.qbAtExactly36, beamShots: ref.shots, beamAtExactly8EN: ref.beamAtExactly8, landings });
    }
    // decisions taken exactly on the threshold: QBs started with exactly 36 EN, beam shots fired with exactly 8 EN
    expect(qbTies).toBeGreaterThanOrEqual(10);
    expect(beamTies).toBeGreaterThanOrEqual(20);
  });
});

// ───────────────────────────── 5c. landing ─────────────────────────────

describe('a landing is registered in the segment that brings the mech down to its resting height (SPEC §7.4, §10)', () => {
  it('a fall that ends inside the 0.1 mm gap a landing leaves above the floor has landed; Space on that tick jumps', () => {
    // 60 ticks of free fall cover exactly 2.25 m: the sweep ends 0.05 mm above the floor — closer than the
    // SKIN gap at which a landing rests, where the collision sweep reports no contact.
    const sim = mk({ start: v3(0, PLAYER.half.y + 2.25 + 0.5 * SKIN, 0) });
    const p = sim.player;
    runUntil(sim, 0.5 - TICK, () => expect(p.grounded).toBe(false));
    sim.tick();
    expect(p.grounded).toBe(true);
    expect(p.verticalMode).toBe('grounded');
    expect(p.vel.y).toBe(0);
    const feet = p.pos.y - PLAYER.half.y;
    expect(feet).toBeGreaterThan(0);
    expect(feet).toBeLessThanOrEqual(SKIN);
    const land = ofType(sim.drainEvents(), 'land');
    expect(land).toHaveLength(1);
    near(land[0].speed, 9, 1e-9);
    // Space pressed now is a press on the ground: it jumps at once (and, held, flies 0.20 s later).
    sim.input.jumpPressed = true;
    sim.input.jump = true;
    sim.tick();
    expect(ofType(sim.drainEvents(), 'jump')).toHaveLength(1);
    expect(p.grounded).toBe(false);
    near(p.vel.y, 10 - 18 * TICK, 1e-12);
    runUntil(sim, 0.5 + 0.2 + TICK);
    expect(p.flying).toBe(true);
    report('fall ending inside the landing gap', { startHeightAboveFloor: 2.25 + 0.5 * SKIN, landedAt: 0.5, feetAboveFloor: feet, landSpeed: land[0].speed });
  });

  it('drop heights in steps of 5 µm around the gap, on the floor and on a platform: never airborne at or below the resting height', () => {
    for (const top of [0, 10]) {
      const solids = top > 0 ? [solid(-8, 0, -8, 8, top, 8)] : [];
      for (let k = 0; k <= 40; k++) {
        // after 60 ticks of free fall the feet are k/20 · SKIN above the surface
        const sim = mk({ solids, start: v3(0, top + PLAYER.half.y + 2.25 + (k / 20) * SKIN, 0) });
        const p = sim.player;
        let landedTick = -1;
        for (let i = 1; i <= 62; i++) {
          sim.tick();
          if (landedTick < 0 && p.grounded) landedTick = i;
          const gap = p.pos.y - PLAYER.half.y - top;
          expect(gap).toBeGreaterThanOrEqual(0);
          if (p.grounded) expect(gap).toBeLessThanOrEqual(SKIN + 1e-9);
          else if (p.vel.y <= 0) expect(gap).toBeGreaterThan(SKIN);
        }
        // within the gap (k <= 20) the fall is over at tick 60, above it one tick later
        expect(landedTick).toBe(k <= 20 ? 60 : 61);
        expect(ofType(sim.drainEvents(), 'land')).toHaveLength(1);
      }
    }
  });
});

// ───────────────────────────── 6. glide ─────────────────────────────

describe('glide (SPEC §7.1, §7.3)', () => {
  it('one Shift press switches it on, it stays on with nothing held, the next press switches it off', () => {
    const sim = mk();
    const p = sim.player;
    const start = clone(p.pos);
    sim.input.glideTogglePressed = true;
    sim.tick();
    expect(sim.input.glideTogglePressed).toBe(false);
    expect(p.glideEnabled).toBe(true);
    expect(p.horizontalMode).toBe('glide');
    expect(p.glideDir).toEqual({ x: 0, z: -1 }); // no input → camera forward
    near(hspeed(sim), GLIDE_ACCEL_GROUND * TICK, 1e-12); // accelerating, not teleported to 22
    let prevSpeed = hspeed(sim);
    runUntil(sim, 3.0, () => {
      const t = sim.tickIndex * TICK;
      expect(p.glideEnabled).toBe(true);
      near(hspeed(sim), Math.min(22, GLIDE_ACCEL_GROUND * t), 1e-9);
      expect(hspeed(sim) - prevSpeed).toBeLessThanOrEqual(GLIDE_ACCEL_GROUND * TICK + 1e-9);
      prevSpeed = hspeed(sim);
    });
    const tAcc = 22 / GLIDE_ACCEL_GROUND;
    near(hdist(p.pos, start), 22 * 3 - 0.5 * 22 * tAcc, 1e-9);
    expect(ofType(sim.drainEvents(), 'glide')).toEqual([{ type: 'glide', enabled: true, auto: false }]);

    sim.input.glideTogglePressed = true; // second press
    sim.tick();
    expect(p.glideEnabled).toBe(false);
    expect(p.horizontalMode).toBe('walk');
    near(hspeed(sim), 21, 1e-12); // not stopped at once: walk deceleration 120 m/s²
    runUntil(sim, 3.5);
    expect(hspeed(sim)).toBe(0);
    expect(ofType(sim.drainEvents(), 'glide')).toEqual([{ type: 'glide', enabled: false, auto: false }]);
  });

  it('keeps its direction after WASD is released; a camera turn alone does not rotate it', () => {
    const sim = mk();
    const p = sim.player;
    sim.input.moveX = 1; // D
    sim.input.glideTogglePressed = true;
    runUntil(sim, 1.0);
    expect(p.glideDir).toEqual({ x: 1, z: 0 });
    near(p.vel.x, 22, 1e-12);
    sim.input.moveX = 0;
    runUntil(sim, 2.0);
    expect(p.glideDir).toEqual({ x: 1, z: 0 });
    expect(p.desiredDir).toEqual({ x: 1, z: 0 });
    near(p.vel.x, 22, 1e-12);
    near(p.vel.z, 0, 1e-12);

    const x0 = p.pos.x;
    const z0 = p.pos.z;
    for (let i = 0; i < 120; i++) {
      sim.applyLook(0.02, 0.004); // turn 2.4 rad left and look up, nothing else
      sim.tick();
      expect(p.glideDir).toEqual({ x: 1, z: 0 });
      near(p.vel.x, 22, 1e-12);
      near(p.vel.z, 0, 1e-12);
    }
    near(p.yaw, 2.4, 1e-9);
    near(p.pos.x - x0, 22, 1e-9);
    near(p.pos.z - z0, 0, 1e-9);
    report('glide direction', { afterReleasingWASD: '(1,0)', afterCameraTurnOf: '2.4 rad', dir: `(${p.glideDir.x},${p.glideDir.z})`, speed: hspeed(sim) });
  });

  it('WASD re-aims it, but the velocity only changes at (80−22)/0.60 m/s² — no instant reversal', () => {
    for (const { legs, mult } of LEGS) {
      const sim = mk({ legs });
      const p = sim.player;
      sim.input.moveX = 1;
      sim.input.glideTogglePressed = true;
      runUntil(sim, 1.0);
      sim.input.moveX = -1; // A: straight reversal
      const limit = GLIDE_ACCEL_GROUND * mult;
      let prev = { x: p.vel.x, z: p.vel.z };
      let reversedAt = -1;
      const t0 = sim.tickIndex;
      runUntil(sim, 2.0, () => {
        const t = (sim.tickIndex - t0) * TICK;
        near(p.vel.x, Math.max(-22 * mult, 22 * mult - limit * t), 1e-9);
        expect(Math.hypot(p.vel.x - prev.x, p.vel.z - prev.z)).toBeLessThanOrEqual(limit * TICK + 1e-9);
        prev = { x: p.vel.x, z: p.vel.z };
        if (reversedAt < 0 && Math.abs(p.vel.x + 22 * mult) < 1e-9) reversedAt = sim.tickIndex - t0;
        expect(p.glideDir).toEqual({ x: -1, z: 0 });
      });
      // 44·mult / (96.67·mult) = 0.4552 s → first whole tick at 55/120 s
      expect(reversedAt).toBe(Math.ceil((44 / GLIDE_ACCEL_GROUND) / TICK - 1e-9));
      // Turn 90°: W while gliding along -X.
      sim.input.moveX = 0;
      sim.input.moveZ = 1;
      sim.tick();
      expect(p.vel.x).toBeLessThan(-20 * mult); // still mostly along the old direction
      runUntil(sim, 3.0);
      near(p.vel.x, 0, 1e-9);
      near(p.vel.z, -22 * mult, 1e-9);
      if (legs === 'biped') report('glide reversal', { accelLimit: limit, secondsToReverse: reversedAt * TICK });
    }
  });

  it('costs 0 EN: 10 s of gliding, on a full and on a recovering tank, in the air and on the ground', () => {
    // Full tank: never below 120.
    const a = mk();
    a.input.glideTogglePressed = true;
    const startA = clone(a.player.pos);
    runUntil(a, 10.0, () => expect(a.player.en).toBe(120));
    near(hdist(a.player.pos, startA), 22 * 10 - 0.5 * 22 * (22 / GLIDE_ACCEL_GROUND), 1e-6);
    expect(a.player.lastEnSpentAt).toBeNull();

    // Partly filled tank: exactly the same EN curve as a mech standing still.
    const g = mk();
    const still = mk();
    g.player.en = 20;
    still.player.en = 20;
    g.input.glideTogglePressed = true;
    g.input.moveX = 1;
    for (let i = 0; i < 1200; i++) {
      if (i === 300) g.input.moveX = -1; // steer around while gliding
      if (i === 600) g.input.moveZ = 1;
      g.tick();
      still.tick();
      expect(g.player.en).toBe(still.player.en);
    }
    expect(g.player.en).toBe(120);
    expect(g.player.glideEnabled).toBe(true);

    // In the air: toggling and gliding costs nothing and gives no lift.
    const air = mk({ start: v3(0, 60, 0) });
    air.input.glideTogglePressed = true;
    runUntil(air, 2.0, () => expect(air.player.en).toBe(120));
    near(air.player.pos.y, 60 - 0.5 * GRAVITY * 4, 1e-9); // pure free fall
    near(hspeed(air), 16, 1e-12); // airborne steady speed
    report('glide EN cost', { secondsGliding: 10, enStart: 120, enMin: 120, distance: hdist(a.player.pos, startA) });
  });
});

// ───────────────────────────── 7. brake ─────────────────────────────

describe('brake (SPEC §7.3)', () => {
  for (const { legs, mult } of LEGS) {
    it(`${legs}: Left Ctrl switches the glide off and decelerates at ${120 * mult} m/s², not instantly`, () => {
      const sim = steadyGlide({ legs });
      const p = sim.player;
      const from = clone(p.pos);
      const v0 = 22 * mult;
      const a = 120 * mult;
      sim.input.brake = true;
      sim.tick();
      expect(p.glideEnabled).toBe(false);
      expect(p.horizontalMode).toBe('walk');
      expect(p.braking).toBe(true);
      expect(p.desiredDir).toEqual({ x: 0, z: 0 });
      near(hspeed(sim), v0 - a * TICK, 1e-12);
      expect(hspeed(sim)).toBeGreaterThan(0.9 * v0);
      let stoppedTick = -1;
      const t0 = sim.tickIndex - 1;
      runUntil(sim, 2.0, () => {
        const t = (sim.tickIndex - t0) * TICK;
        near(hspeed(sim), Math.max(0, v0 - a * t), 1e-9);
        if (stoppedTick < 0 && hspeed(sim) === 0) stoppedTick = sim.tickIndex - t0;
        expect(p.horizontalMode).toBe('walk');
        expect(p.glideEnabled).toBe(false);
      });
      expect(stoppedTick).toBe(Math.ceil(v0 / a / TICK - 1e-9));
      const d = hdist(p.pos, from);
      near(d, (v0 * v0) / (2 * a), 1e-9);
      expect(ofType(sim.drainEvents(), 'glide')).toEqual([{ type: 'glide', enabled: false, auto: false }]);
      // Releasing the brake does not bring the glide back.
      sim.input.brake = false;
      runUntil(sim, 2.5);
      expect(p.glideEnabled).toBe(false);
      expect(p.braking).toBe(false);
      expect(hspeed(sim)).toBe(0);
      report(`brake from glide, ${legs}`, { decel: a, secondsToStop: stoppedTick * TICK, stopDistance: d });
    });
  }

  it('has priority over WASD and over Shift while held', () => {
    const sim = mk();
    const p = sim.player;
    sim.input.moveZ = 1;
    runUntil(sim, 0.5);
    near(hspeed(sim), 10, 1e-12);
    sim.input.brake = true; // W still held
    sim.tick();
    near(hspeed(sim), 9, 1e-12);
    runUntil(sim, 1.0);
    expect(hspeed(sim)).toBe(0);
    const at = clone(p.pos);
    sim.drainEvents();
    sim.input.glideTogglePressed = true; // Shift while braking: the glide stays off
    runUntil(sim, 2.0);
    expect(p.glideEnabled).toBe(false);
    expect(ofType(sim.drainEvents(), 'glide')).toHaveLength(0); // not even switched on for an instant
    expect(hdist(p.pos, at)).toBe(0);
    expect(p.braking).toBe(true);
    expect(p.desiredDir).toEqual({ x: 0, z: 0 });
    sim.input.brake = false;
    runUntil(sim, 2.5);
    near(hspeed(sim), 10, 1e-12); // W takes over again
    expect(p.horizontalMode).toBe('walk');
  });

  it('a QB requested while braking is rejected: no EN, no cooldown, not queued', () => {
    const sim = steadyGlide();
    const p = sim.player;
    sim.input.brake = true;
    sim.input.qbPressed = true;
    sim.tick();
    expect(ofType(sim.drainEvents(), 'qb-rejected').map((e) => e.reason)).toEqual(['brake']);
    expect(p.qbSuccessfulCount).toBe(0);
    expect(p.en).toBe(120);
    expect(p.qbLastStartedAt).toBeNull();
    expect(p.lastEnSpentAt).toBeNull();
    runUntil(sim, 1.5);
    sim.input.brake = false;
    runUntil(sim, 3.0);
    expect(p.qbSuccessfulCount).toBe(0);
    expect(hspeed(sim)).toBe(0);
    expect(ofType(sim.drainEvents(), 'qb')).toHaveLength(0);
  });

  it('brake and Shift are not executed during the 0.15 s impulse; the brake applies right after it', () => {
    const sim = mk();
    const p = sim.player;
    const start = clone(p.pos);
    sim.input.qbPressed = true;
    runUntil(sim, 0.05);
    sim.input.brake = true;
    sim.input.glideTogglePressed = true;
    sim.input.moveZ = -1; // S: steering is ignored as well
    runUntil(sim, 0.15 - TICK, () => {
      expect(p.horizontalMode).toBe('quickboost');
      expect(p.braking).toBe(false);
      near(hspeed(sim), 80, 1e-12);
      expect(p.vel.z).toBeLessThan(0);
    });
    expect(sim.input.glideTogglePressed).toBe(false); // consumed, without effect
    sim.tick(); // t = 0.15: impulse over, automatic glide
    near(hdist(p.pos, start), 12, 1e-9);
    expect(p.horizontalMode).toBe('glide');
    expect(p.glideEnabled).toBe(true);
    near(hspeed(sim), 80, 1e-12);
    sim.tick(); // the held brake now takes over
    expect(p.horizontalMode).toBe('walk');
    expect(p.glideEnabled).toBe(false);
    expect(p.braking).toBe(true);
    near(hspeed(sim), 79, 1e-12);
    runUntil(sim, 1.5);
    expect(hspeed(sim)).toBe(0);
    near(hdist(p.pos, start), 12 + (80 * 80) / 240, 1e-9);
    const glide = ofType(sim.drainEvents(), 'glide');
    expect(glide).toEqual([
      { type: 'glide', enabled: true, auto: true },
      { type: 'glide', enabled: false, auto: false },
    ]);
    report('brake held during QB', { impulseDistance: 12, speedAtImpulseEnd: 80, totalDistance: hdist(p.pos, start) });
  });

  it('Shift alone during the impulse changes nothing and is not remembered', () => {
    // (a) glide off before the QB, (b) glide already on before the QB
    for (const glideBefore of [false, true]) {
      const sim = glideBefore ? steadyGlide() : mk();
      const p = sim.player;
      const t0 = sim.tickIndex;
      sim.input.qbPressed = true;
      sim.tick();
      for (let i = 1; i < 18; i++) {
        if (i === 4 || i === 9) sim.input.glideTogglePressed = true; // Shift pressed twice during the impulse
        sim.tick();
        expect(sim.input.glideTogglePressed).toBe(false);
        if (i < 17) {
          expect(p.horizontalMode).toBe('quickboost');
          expect(p.glideEnabled).toBe(glideBefore); // untouched until the impulse ends
        }
        near(hspeed(sim), 80, 1e-12);
      }
      expect(sim.tickIndex - t0).toBe(18);
      expect(p.horizontalMode).toBe('glide');
      expect(p.glideEnabled).toBe(true);
      for (let i = 0; i < 120; i++) {
        sim.tick();
        expect(p.glideEnabled).toBe(true); // the presses were dropped, not queued
        expect(p.horizontalMode).toBe('glide');
      }
      near(hspeed(sim), 22, 1e-12);
      expect(ofType(sim.drainEvents(), 'glide')).toEqual([{ type: 'glide', enabled: true, auto: true }]);
    }
  });
});

// ───────────────────────────── 8. walk ─────────────────────────────

describe('walk (SPEC §7.1)', () => {
  for (const { legs, mult } of LEGS) {
    it(`${legs}: ${10 * mult} m/s, diagonals are not faster, stops after release`, () => {
      const sim = mk({ legs });
      const p = sim.player;
      const start = clone(p.pos);
      const v = 10 * mult;
      const a = 120 * mult;
      sim.input.moveZ = 1;
      sim.tick();
      near(hspeed(sim), a * TICK, 1e-12);
      runUntil(sim, 2.0, () => expect(hspeed(sim)).toBeLessThanOrEqual(v + 1e-12));
      near(hspeed(sim), v, 1e-12);
      expect(p.vel.z).toBeLessThan(0);
      near(hdist(p.pos, start), v * 2 - (v * v) / (2 * a), 1e-9);
      expect(p.horizontalMode).toBe('walk');
      expect(p.desiredDir).toEqual({ x: 0, z: -1 });
      expect(p.en).toBe(120);

      sim.input.moveX = 1; // W + D
      runUntil(sim, 3.0, () => expect(hspeed(sim)).toBeLessThanOrEqual(v + 1e-9));
      near(hspeed(sim), v, 1e-12);
      near(p.vel.x, v * Math.SQRT1_2, 1e-12);
      near(p.vel.z, -v * Math.SQRT1_2, 1e-12);
      near(Math.hypot(p.desiredDir.x, p.desiredDir.z), 1, 1e-12);

      sim.input.moveX = 0;
      sim.input.moveZ = 0;
      sim.tick();
      near(hspeed(sim), v - a * TICK, 1e-12); // decelerating, not frozen
      runUntil(sim, 3.5);
      expect(hspeed(sim)).toBe(0);
      expect(p.desiredDir).toEqual({ x: 0, z: 0 });
      const rest = clone(p.pos);
      runUntil(sim, 4.5);
      expect(p.pos).toEqual(rest);
      if (legs === 'biped') report('walk', { speed: v, diagonalSpeed: v, distanceIn2s: v * 2 - (v * v) / (2 * a) });
    });
  }

  it('WASD is relative to the camera yaw and the pitch never lifts the mech', () => {
    const sim = mk();
    const p = sim.player;
    runUntil(sim, 0.1);
    const y0 = p.pos.y;
    sim.applyLook(Math.PI / 2, 5); // face -X, pitch clamped at +80°
    expect(p.pitch).toBeGreaterThan(1.39);
    sim.input.moveZ = 1;
    runUntil(sim, 2.0, () => {
      expect(p.pos.y).toBe(y0);
      expect(p.vel.y).toBe(0);
      expect(p.grounded).toBe(true);
    });
    near(p.vel.x, -10, 1e-12);
    near(p.vel.z, 0, 1e-12);
    near(hspeed(sim), 10, 1e-12); // full horizontal speed although the camera looks almost straight up
    sim.applyLook(0, -10); // look down
    sim.input.glideTogglePressed = true;
    runUntil(sim, 4.0, () => {
      expect(p.pos.y).toBe(y0);
      expect(p.vel.y).toBe(0);
    });
    near(hspeed(sim), 22, 1e-12);
    sim.input.qbPressed = true;
    runUntil(sim, 4.5, () => expect(p.pos.y).toBe(y0));
    expect(p.qbSuccessfulCount).toBe(1);
  });
});

// ───────────────────────────── 9. jump and flight ─────────────────────────────

describe('jump and flight (SPEC §7.4)', () => {
  it('a short Space press is a ballistic jump (apex 100/36 m); no second jump in the air', () => {
    for (const { legs } of LEGS) {
      const sim = mk({ legs });
      const p = sim.player;
      const y0 = p.pos.y;
      sim.input.jumpPressed = true; // pressed and released within the frame
      let apex = 0;
      let landedTick = -1;
      runUntil(sim, 2.0, () => {
        const t = sim.tickIndex * TICK;
        if (sim.tickIndex === tickAt(0.3)) {
          sim.input.jumpPressed = true; // second press in mid-air
        }
        if (sim.tickIndex === tickAt(0.6)) sim.input.jumpPressed = true;
        if (landedTick < 0 && p.grounded) landedTick = sim.tickIndex;
        if (landedTick < 0) {
          near(p.pos.y - y0, 10 * t - 9 * t * t, 1e-9);
          near(p.vel.y, 10 - 18 * t, 1e-9);
          expect(p.verticalMode).toBe(p.vel.y > 0 ? 'rising' : 'falling');
          expect(p.jumpHeldSince).toBeNull();
        }
        apex = Math.max(apex, p.pos.y - y0);
      });
      const ev = sim.drainEvents();
      expect(ofType(ev, 'jump')).toHaveLength(1);
      const land = ofType(ev, 'land');
      expect(land).toHaveLength(1);
      expect(land[0].speed).toBeGreaterThan(9.9);
      expect(land[0].speed).toBeLessThan(10.2);
      near(apex, 100 / 36, 1e-3);
      expect(apex).toBeLessThanOrEqual(100 / 36 + 1e-12);
      // y0 + 10t − 9t² returns to the floor at t = 10/9 s
      expect(landedTick).toBe(Math.ceil(10 / 9 / TICK));
      expect(p.grounded).toBe(true);
      near(p.pos.y, PLAYER.half.y + SKIN, 1e-9);
      expect(p.en).toBe(120);
      report(`jump ${legs}`, { apexSampled: apex, apexExact: 100 / 36, landedAt: landedTick * TICK, landSpeed: land[0].speed });
    }
  });

  it('Space without a press edge never jumps; the hold is tracked and cleared', () => {
    const sim = mk();
    const p = sim.player;
    sim.input.jump = true; // level only
    runUntil(sim, 1.0, () => {
      expect(p.grounded).toBe(true);
      expect(p.jumpHeldSince).toBe(0);
    });
    expect(ofType(sim.drainEvents(), 'jump')).toHaveLength(0);
    sim.input.jump = false;
    sim.tick();
    expect(p.jumpHeldSince).toBeNull();
    sim.input.jump = true;
    sim.input.jumpPressed = true;
    sim.tick();
    near(p.jumpHeldSince ?? NaN, 1.0 + TICK, 1e-12);
    expect(p.grounded).toBe(false);
    sim.clearInput(); // pause / focus loss
    expect(p.jumpHeldSince).toBeNull();
    sim.tick();
    expect(p.jumpHeldSince).toBeNull();
  });

  it('a press edge while Space reads "held" on the ground (released and re-pressed between frames) jumps and can fly', () => {
    const sim = mk();
    const p = sim.player;
    sim.input.jump = true; // level without a press edge on the ground: no jump, nothing happens
    runUntil(sim, 0.5);
    expect(p.grounded).toBe(true);
    sim.input.jumpPressed = true; // the level never dropped, but there was a real new press
    sim.tick();
    expect(p.grounded).toBe(false);
    near(p.jumpHeldSince ?? NaN, 0.5, 1e-12);
    runUntil(sim, 0.7, () => expect(p.flying).toBe(false));
    sim.tick();
    expect(p.flying).toBe(true);
    expect(p.vel.y).toBe(8);
    expect(ofType(sim.drainEvents(), 'jump')).toHaveLength(1);
  });

  it('thrust sets the vertical speed to exactly +8 m/s whatever it was (arrests a fall, never adds to a faster climb)', () => {
    const sim = mk({ start: v3(0, 80, 0) });
    const p = sim.player;
    runUntil(sim, 1.0);
    near(p.vel.y, -18, 1e-9);
    sim.input.jump = true;
    sim.input.jumpPressed = true; // pressed in mid-air: no jump, the 0.20 s count starts
    runUntil(sim, 1.2, () => expect(p.flying).toBe(false));
    near(p.vel.y, -21.6, 1e-9);
    const y = p.pos.y;
    sim.tick();
    expect(p.flying).toBe(true);
    expect(p.vel.y).toBe(8);
    near(p.pos.y - y, 8 * TICK, 1e-12);
    near(p.en, 120 - 20 * TICK, 1e-12);
    p.vel.y = 15; // an artificial faster climb is not kept either
    sim.tick();
    expect(p.vel.y).toBe(8);
    expect(ofType(sim.drainEvents(), 'jump')).toHaveLength(0);
  });

  for (const { legs, mult } of LEGS) {
    it(`${legs}: holding Space 0.20 s starts flight at +8 m/s for 20 EN/s; air speed ${16 * mult} m/s`, () => {
      const sim = mk({ legs });
      const p = sim.player;
      const start = clone(p.pos);
      sim.input.jumpPressed = true;
      sim.input.jump = true;
      sim.input.moveZ = 1;
      sim.tick();
      expect(playerNextEventTime(sim)).toBe(0.2);
      const check = (): void => {
        const t = sim.tickIndex * TICK;
        if (t <= 0.2 + 1e-9) {
          // ordinary jump until the threshold
          near(p.pos.y - start.y, 10 * t - 9 * t * t, 1e-9);
          near(p.vel.y, 10 - 18 * t, 1e-9);
          expect(p.flying).toBe(false);
          expect(p.verticalMode).toBe('rising');
          expect(p.en).toBe(120);
        } else {
          near(p.pos.y - start.y, 1.64 + 8 * (t - 0.2), 1e-9);
          expect(p.vel.y).toBe(8);
          expect(p.flying).toBe(true);
          expect(p.verticalMode).toBe('flying');
          near(p.en, 120 - 20 * (t - 0.2), 1e-9);
          near(p.lastEnSpentAt ?? NaN, t, 1e-9);
        }
        expect(hspeed(sim)).toBeLessThanOrEqual(16 * mult + 1e-12);
        near(hspeed(sim), Math.min(16 * mult, 120 * mult * t), 1e-9);
      };
      check();
      runUntil(sim, 1.2, check);
      near(p.en, 100, 1e-9);
      near(hspeed(sim), 16 * mult, 1e-12);
      expect(p.horizontalMode).toBe('walk');
      expect(p.grounded).toBe(false);
      report(`flight ${legs}`, {
        flightStartsAt: 0.2,
        climbSpeed: p.vel.y,
        heightAt1_2s: p.pos.y - start.y,
        enAt1_2s: p.en,
        airSpeed: hspeed(sim),
      });

      // Releasing Space: gravity from the current vertical velocity, no more EN.
      sim.input.jump = false;
      const tRel = sim.tickIndex * TICK;
      const yRel = p.pos.y;
      runUntil(sim, 1.6, () => {
        const s = sim.tickIndex * TICK - tRel;
        near(p.vel.y, 8 - 18 * s, 1e-9);
        near(p.pos.y - yRel, 8 * s - 9 * s * s, 1e-9);
        expect(p.flying).toBe(false);
        near(p.en, 100, 1e-9);
        expect(p.verticalMode).toBe(p.vel.y > 0 ? 'rising' : 'falling');
      });
    });
  }

  it('re-pressing Space in the air needs another full 0.20 s and never adds a jump', () => {
    const sim = mk();
    const p = sim.player;
    sim.input.jumpPressed = true;
    sim.input.jump = true;
    runUntil(sim, 1.0);
    expect(p.flying).toBe(true);
    sim.input.jump = false; // release at 1.0
    runUntil(sim, 1.1);
    near(p.vel.y, 8 - 18 * 0.1, 1e-9);
    const en = p.en;
    near(en, 120 - 20 * 0.8, 1e-9);
    sim.input.jump = true; // press again at 1.1
    sim.input.jumpPressed = true;
    runUntil(sim, 1.3, () => {
      const s = sim.tickIndex * TICK - 1.0;
      near(p.vel.y, 8 - 18 * s, 1e-9); // still ballistic: no +10, no thrust
      expect(p.flying).toBe(false);
      expect(p.en).toBe(en);
    });
    near(p.jumpHeldSince ?? NaN, 1.1, 1e-12);
    sim.tick();
    expect(p.flying).toBe(true);
    expect(p.vel.y).toBe(8);
    runUntil(sim, 1.5);
    near(p.en, en - 20 * 0.2, 1e-9);
    expect(ofType(sim.drainEvents(), 'jump')).toHaveLength(1);
    report('Space re-pressed in the air', { releasedAt: 1.0, pressedAt: 1.1, thrustResumesAt: 1.3, enAt1_5s: p.en });

    // Released and pressed again between two frames (the level never reads "up"): the count restarts too.
    sim.input.jumpPressed = true;
    const tTap = sim.tickIndex * TICK;
    const enTap = p.en;
    runUntil(sim, tTap + 0.2, () => {
      const s = sim.tickIndex * TICK - tTap;
      expect(p.flying).toBe(false);
      near(p.vel.y, 8 - 18 * s, 1e-9);
      expect(p.en).toBe(enTap);
    });
    near(p.jumpHeldSince ?? NaN, tTap, 1e-12);
    sim.tick();
    expect(p.flying).toBe(true);
    expect(p.vel.y).toBe(8);
    expect(ofType(sim.drainEvents(), 'jump')).toHaveLength(0);
  });

  it('EN running out stops the thrust inside the sub-step; gravity continues from 8 m/s; no free climb', () => {
    const sim = mk();
    const p = sim.player;
    const y0 = p.pos.y;
    p.en = 10.1; // 0.505 s of thrust: ends at t = 0.705 s, in the middle of a tick
    sim.input.jumpPressed = true;
    sim.input.jump = true;
    const tOut = 0.2 + 10.1 / 20;
    const yOut = 1.64 + 8 * (tOut - 0.2);
    let apex = 0;
    let landedTick = -1;
    runUntil(sim, 3.0, () => {
      const t = sim.tickIndex * TICK;
      if (landedTick < 0 && p.grounded) landedTick = sim.tickIndex;
      if (landedTick < 0) {
        if (t > 0.2 + 1e-9 && t < tOut) {
          expect(p.vel.y).toBe(8);
          near(p.en, 10.1 - 20 * (t - 0.2), 1e-9);
        } else if (t > tOut) {
          const s = t - tOut;
          near(p.vel.y, 8 - 18 * s, 1e-9);
          near(p.pos.y - y0, yOut + 8 * s - 9 * s * s, 1e-9);
          expect(p.en).toBe(0);
          // thrusters report "firing" only for the sub-step that contained the last paid 5 ms
          expect(p.flying).toBe(sim.tickIndex === Math.ceil(tOut / TICK));
          near(p.lastEnSpentAt ?? NaN, tOut, 1e-9);
        }
        apex = Math.max(apex, p.pos.y - y0);
      } else {
        // Landed with Space still down: stays put, no new jump, no thrust on the ground, EN recovers.
        expect(p.grounded).toBe(true);
        expect(p.flying).toBe(false);
      }
    });
    const apexExact = yOut + 64 / 36;
    expect(apex).toBeLessThanOrEqual(apexExact + 1e-9);
    near(apex, apexExact, 1e-3);
    expect(landedTick).toBeGreaterThan(0);
    expect(p.en).toBeGreaterThan(0);
    expect(ofType(sim.drainEvents(), 'jump')).toHaveLength(1);
    report('flight until EN 0', { enStart: 10.1, thrustEndsAt: tOut, lastEnSpentAt: p.lastEnSpentAt, apexSampled: apex, apexExact, landedAt: landedTick * TICK });

    // Leaving the ground takes a new press (jump); 0.20 s later the flight starts again.
    sim.input.jump = false;
    sim.tick();
    sim.input.jump = true;
    sim.input.jumpPressed = true;
    const tPress = sim.tickIndex * TICK;
    runUntil(sim, tPress + 0.2 + 2 * TICK);
    expect(p.flying).toBe(true);
    expect(p.vel.y).toBe(8);
  });

  it('a Space hold stays valid through a landing: no jump and no thrust on the ground, flight as soon as the mech is airborne', () => {
    // Platform top at y = 10. The mech drops onto it from 0.6 m; Space is pressed 0.108 s before the
    // touch-down (in the air: no jump) and then never released.
    const sim = mk({ solids: [solid(-5, 0, -20, 5, 10, 20)], start: v3(0, 12.6, 0) });
    const p = sim.player;
    runUntil(sim, 0.15);
    expect(p.grounded).toBe(false);
    sim.input.jump = true;
    sim.input.jumpPressed = true;
    let landedTick = -1;
    runUntil(sim, 1.25, () => {
      if (landedTick < 0 && p.grounded) landedTick = sim.tickIndex;
      // neither in the last 0.108 s of the fall (hold < 0.20 s) nor standing on the platform (hold > 0.20 s)
      expect(p.flying).toBe(false);
      expect(p.en).toBe(120);
      if (landedTick >= 0) {
        expect(p.grounded).toBe(true); // a held Space never lifts a standing mech: no jump, no take-off
        expect(p.vel.y).toBe(0);
      }
    });
    expect(landedTick).toBe(Math.ceil(Math.sqrt(0.6 / 9) / TICK));
    near(p.pos.y, 12 + SKIN, 1e-9);
    near(p.jumpHeldSince ?? NaN, 0.15, 1e-12);
    expect(playerNextEventTime(sim)).toBe(Infinity); // a standing mech has no flight threshold to wait for
    expect(ofType(sim.drainEvents(), 'jump')).toHaveLength(0);

    // Space is still down (for more than a second by now). Walking off the edge: the hold is >= 0.20 s old
    // and the mech is airborne, so the thrusters fire from the first airborne tick — 20 EN/s, +8 m/s.
    sim.input.moveZ = 1;
    let leftTick = -1;
    let yLeft = NaN;
    runUntil(sim, 4.5, () => {
      if (leftTick < 0) {
        expect(p.flying).toBe(false);
        expect(p.en).toBe(120);
        if (!p.grounded) {
          leftTick = sim.tickIndex; // the tick in which the feet lost the platform (still moved as grounded)
          yLeft = p.pos.y;
        }
        return;
      }
      const n = sim.tickIndex - leftTick;
      expect(p.flying).toBe(true);
      expect(p.verticalMode).toBe('flying');
      expect(p.vel.y).toBe(8);
      near(p.en, 120 - (20 * n) / 120, 1e-12);
      near(p.pos.y - yLeft, 8 * n * TICK, 1e-9);
    });
    expect(leftTick).toBeGreaterThan(tickAt(1.25));
    expect(sim.tickIndex - leftTick).toBeGreaterThan(60);
    expect(ofType(sim.drainEvents(), 'jump')).toHaveLength(0);
    report('Space held through a landing, then off the edge', {
      pressedAt: 0.15,
      landedAt: landedTick * TICK,
      leftPlatformAt: leftTick * TICK,
      thrustFromTick: leftTick + 1,
      enAt4_5s: p.en,
    });

    // Released: gravity from +8 m/s. Pressed again in the air: another full 0.20 s before the thrust.
    sim.input.jump = false;
    sim.tick();
    expect(p.flying).toBe(false);
    near(p.vel.y, 8 - 18 * TICK, 1e-12);
    sim.input.jump = true;
    sim.input.jumpPressed = true;
    const tPress = sim.tickIndex * TICK;
    runUntil(sim, tPress + 0.2);
    expect(p.flying).toBe(false);
    sim.tick();
    expect(p.flying).toBe(true);
    expect(p.vel.y).toBe(8);
  });

  it('a Space level that was never a press on the ground (no jump) also flies once the mech walks off an edge', () => {
    const sim = mk({ solids: [solid(-5, 0, -5, 5, 10, 5)], start: v3(0, 12.001, 0) });
    const p = sim.player;
    sim.input.jump = true; // held without a press edge: no jump
    sim.input.moveZ = 1;
    let leftTick = -1;
    runUntil(sim, 1.5, () => {
      if (leftTick < 0) {
        expect(p.flying).toBe(false);
        expect(p.en).toBe(120);
        if (!p.grounded) leftTick = sim.tickIndex;
        return;
      }
      expect(p.flying).toBe(true);
      expect(p.vel.y).toBe(8);
      near(p.en, 120 - (20 * (sim.tickIndex - leftTick)) / 120, 1e-12);
    });
    expect(leftTick).toBeGreaterThan(tickAt(0.2)); // the hold was older than 0.20 s when the floor ended
    expect(sim.tickIndex).toBeGreaterThan(leftTick + 30);
    expect(ofType(sim.drainEvents(), 'jump')).toHaveLength(0);
  });

  it('landing with an empty tank and Space still down: the mech stays down and recovers; flight needs a new jump', () => {
    const sim = mk({ generator: 'recovery' });
    const p = sim.player;
    sim.input.jumpPressed = true;
    sim.input.jump = true; // never released in this test until the very end
    let emptyTick = -1;
    let landedTick = -1;
    let prevEn = p.en;
    runUntil(sim, 14.0, () => {
      if (emptyTick < 0 && p.en === 0) emptyTick = sim.tickIndex;
      if (emptyTick >= 0 && landedTick < 0 && p.grounded) landedTick = sim.tickIndex;
      if (landedTick >= 0) {
        expect(p.grounded).toBe(true);
        expect(p.flying).toBe(false);
        expect(p.vel.y).toBe(0);
        expect(p.en).toBeGreaterThanOrEqual(prevEn); // recovering (never spent) while Space is held
      }
      prevEn = p.en;
    });
    expect(emptyTick).toBe(tickAt(0.2 + 90 / 20));
    expect(landedTick).toBeGreaterThan(emptyTick);
    expect(p.en).toBe(90); // full again, Space still down
    expect(ofType(sim.drainEvents(), 'jump')).toHaveLength(1);
    // a new press: jump, and 0.20 s later flight
    sim.input.jumpPressed = true;
    const tPress = sim.tickIndex * TICK;
    sim.tick();
    expect(p.grounded).toBe(false);
    runUntil(sim, tPress + 0.2 + TICK);
    expect(p.flying).toBe(true);
    expect(ofType(sim.drainEvents(), 'jump')).toHaveLength(1);
  });

  it('feathering Space obeys every rule: 0.20 s per press before any thrust, 20 EN/s for the thrust time, gravity in between', () => {
    // Accepted consequence of SPEC §7.1 / §7.4 taken literally (thrust = +8 m/s at once, a release keeps the
    // vertical velocity): short re-presses climb far more cheaply than continuous flight. This test pins
    // the rules themselves — no thrust tick is free and none comes before its 0.20 s — and prints the numbers.
    const sim = mk({ generator: 'recovery' });
    const p = sim.player;
    const y0 = p.pos.y;
    let pressTick = 0; // tick at whose start the current hold began
    let thrustTicks = 0;
    let presses = 0;
    for (let i = 0; i < 10 * 120; i++) {
      const phase = i % 26; // 25 ticks down (0.20 s wait + 1 thrust tick), 1 tick up
      if (phase === 0) {
        sim.input.jump = true;
        sim.input.jumpPressed = true;
        pressTick = i;
        presses++;
      } else if (phase === 25) sim.input.jump = false;
      const en = p.en;
      const vy = p.vel.y;
      const airborneBefore = !p.grounded;
      sim.tick();
      if (p.flying) {
        thrustTicks++;
        expect(sim.input.jump).toBe(true);
        expect(i - pressTick).toBeGreaterThanOrEqual(24); // the hold was 0.20 s old when this tick began
        near(en - p.en, 20 * TICK, 1e-12); // paid in full
        expect(p.vel.y).toBe(8);
      } else {
        expect(p.en).toBe(en); // nothing spent, nothing recovered in the air
        if (airborneBefore) near(p.vel.y, vy - GRAVITY * TICK, 1e-12); // pure gravity from the inherited velocity
      }
      if (i > 0) expect(p.grounded).toBe(false);
    }
    expect(ofType(sim.drainEvents(), 'jump')).toHaveLength(1); // only the first press was on the ground
    expect(thrustTicks).toBe(presses - 1); // one paid tick per completed 0.20 s hold (the last hold is still young)
    near(90 - p.en, 20 * thrustTicks * TICK, 1e-9);
    report('feathered Space, 10 s (recovery generator)', {
      presses,
      thrustSeconds: thrustTicks * TICK,
      enUsed: 90 - p.en,
      heightGained: p.pos.y - y0,
      continuousFlightFor10s: 'not affordable (90 EN = 4.5 s = 36 m)',
    });
  });

  it('thrusting into a ceiling stops the climb (and keeps paying), releasing drops the mech', () => {
    const sim = mk({ solids: [solid(-20, 9, -20, 20, 10, 20)] });
    const p = sim.player;
    sim.input.jumpPressed = true;
    sim.input.jump = true;
    runUntil(sim, 2.0, () => expect(p.pos.y + PLAYER.half.y).toBeLessThan(9));
    near(p.pos.y, 9 - PLAYER.half.y - SKIN, 1e-9);
    expect(p.vel.y).toBe(0);
    expect(p.grounded).toBe(false);
    expect(p.flying).toBe(true);
    near(p.en, 120 - 20 * 1.8, 1e-9);
    sim.input.jump = false;
    runUntil(sim, 3.5);
    expect(p.grounded).toBe(true);
    near(p.pos.y, PLAYER.half.y + SKIN, 1e-9);
  });
});

// ───────────────────────────── 10. simultaneous actions ─────────────────────────────

describe('QB in the air, QB + flight, EN priority (SPEC §6, §7.2, §7.4, §11 同時操作)', () => {
  it('a QB in the air leaves the vertical motion untouched and decays towards 16 m/s', () => {
    for (const { legs, mult } of LEGS) {
      const a = mk({ legs }); // jumps and quick-boosts at 0.3 s
      const b = mk({ legs }); // only jumps
      a.input.jumpPressed = true;
      b.input.jumpPressed = true;
      runUntil(a, 0.3);
      runUntil(b, 0.3);
      const from = clone(a.player.pos);
      const vyBefore = a.player.vel.y;
      a.input.qbPressed = true;
      applyPlayerInputEdges(a);
      expect(a.player.vel.y).toBe(vyBefore); // the press itself does not touch vy
      near(hspeed(a), 80 * mult, 1e-12);
      expect(ofType(a.drainEvents(), 'qb')).toEqual([{ type: 'qb', dir: { x: 0, z: -1 }, airborne: true }]);
      let d075 = NaN;
      for (let i = 1; i <= tickAt(0.75); i++) {
        a.tick();
        b.tick();
        const t = i * TICK;
        expect(a.player.grounded).toBe(false);
        near(a.player.pos.y, b.player.pos.y, 1e-12);
        near(a.player.vel.y, b.player.vel.y, 1e-12);
        near(hdist(a.player.pos, from), qbDistance(t, mult, true), 1e-9);
        expect(a.player.horizontalMode).toBe(t < 0.15 - 1e-9 ? 'quickboost' : 'glide');
        d075 = hdist(a.player.pos, from);
      }
      near(d075, (12 + 0.5 * (80 + 16) * 0.6) * mult, 1e-6);
      near(hspeed(a), 16 * mult, 1e-12);
      expect(a.player.en).toBe(84);
      // After the landing: still gliding, speeding up smoothly from 16 to 22 (× legs).
      let prev = hspeed(a);
      runUntil(a, 2.0, () => {
        const s = hspeed(a);
        expect(s - prev).toBeLessThanOrEqual(GLIDE_ACCEL_GROUND * mult * TICK + 1e-9);
        expect(s).toBeGreaterThanOrEqual(prev - 1e-12);
        prev = s;
      });
      expect(a.player.grounded).toBe(true);
      expect(a.player.glideEnabled).toBe(true);
      near(hspeed(a), 22 * mult, 1e-12);
      report(`QB in the air, ${legs}`, { distanceAt0_75s: d075, speedAt0_75s: 16 * mult, verticalDeviationFromPlainJump: 0, speedAfterLanding: hspeed(a) });
    }
  });

  it('QB + flight pay 36 + 20·t from the same tank; the QB does not interrupt the climb', () => {
    const sim = mk();
    const p = sim.player;
    const y0 = p.pos.y;
    sim.input.jumpPressed = true;
    sim.input.jump = true;
    runUntil(sim, 0.5);
    near(p.en, 120 - 20 * 0.3, 1e-9);
    sim.input.qbPressed = true;
    runUntil(sim, 1.0, () => {
      expect(p.vel.y).toBe(8);
      expect(p.flying).toBe(true);
    });
    near(p.en, 120 - 36 - 20 * 0.8, 1e-9);
    near(p.pos.y - y0, 1.64 + 8 * 0.8, 1e-9);
    expect(p.qbSuccessfulCount).toBe(1);
    expect(p.horizontalMode).toBe('glide');
    expect(p.verticalMode).toBe('flying');
    report('QB + flight', { enAt1s: p.en, expected: 120 - 36 - 20 * 0.8, heightAt1s: p.pos.y - y0 });
  });

  it('flight never spends more than is left: QB first, then a due beam (reserve), then thrust', () => {
    const sim = mk();
    const p = sim.player;
    sim.input.jumpPressed = true;
    sim.input.jump = true;
    runUntil(sim, 0.5);
    expect(p.flying).toBe(true);

    // 8.05 EN with a beam shot (8 EN) due at the end of the sub-step: only 0.05 EN = 2.5 ms of thrust.
    p.en = 8.05;
    let y = p.pos.y;
    applyPlayerInputEdges(sim);
    updatePlayer(sim, TICK, 8);
    near(p.en, 8, 1e-12);
    expect(p.flying).toBe(true);
    const thrust = 0.05 / 20;
    near(p.lastEnSpentAt ?? NaN, sim.time + thrust, 1e-12);
    const rest = TICK - thrust;
    near(p.vel.y, 8 - 18 * rest, 1e-12);
    near(p.pos.y - y, 8 * TICK - 9 * rest * rest, 1e-12);
    sim.time += TICK;

    // Nothing left above the reserve: no thrust at all, the 8 EN stay for the beam.
    y = p.pos.y;
    const vy = p.vel.y;
    applyPlayerInputEdges(sim);
    updatePlayer(sim, TICK, 8);
    expect(p.en).toBe(8);
    expect(p.flying).toBe(false);
    near(p.vel.y, vy - 18 * TICK, 1e-12);
    near(p.pos.y - y, vy * TICK - 9 * TICK * TICK, 1e-12);
    sim.time += TICK;

    // Without a reserve the same 8 EN pay for thrust again.
    applyPlayerInputEdges(sim);
    updatePlayer(sim, TICK, 0);
    expect(p.flying).toBe(true);
    near(p.en, 8 - 20 * TICK, 1e-12);
    expect(p.vel.y).toBe(8);
    sim.time += TICK;

    // QB + beam + flight requested together with 44 EN: QB takes 36, the beam's 8 are kept, flight gets 0.
    p.en = 44;
    sim.input.qbPressed = true;
    applyPlayerInputEdges(sim);
    expect(p.en).toBe(8);
    updatePlayer(sim, TICK, 8);
    expect(p.en).toBe(8);
    expect(p.flying).toBe(false);
    expect(p.qbSuccessfulCount).toBe(1);
    sim.time += TICK;

    // 0 EN: thrust is impossible, the tank never goes negative, the QB's motion carries on.
    p.en = 0;
    applyPlayerInputEdges(sim);
    updatePlayer(sim, TICK, 0);
    expect(p.en).toBe(0);
    expect(p.flying).toBe(false);
    near(hspeed(sim), 80, 1e-12);
    report('EN priority', { en8_05_reserve8: 'thrust 2.5 ms → EN 8', en8_reserve8: 'no thrust', qbPlusReserveWith44: 'QB paid, EN 8 kept, no thrust' });
  });
});

// ───────────────────────────── 11. collisions ─────────────────────────────

describe('walls, platforms and edges (SPEC §7.2, §7.4)', () => {
  // A 0.5 m thick wall whose near face is 5 m in front of the mech's front face (z = -1.3).
  const wall = solid(-30, 0, -6.8, 30, 14, -6.3);
  const zStop = -6.3 + PLAYER.half.z + SKIN;

  it('a QB at 80 m/s into a 0.5 m wall 5 m ahead stops at the wall; the lost speed never returns', () => {
    for (const frame of [TICK, 0.25]) {
      const sim = mk({ solids: [wall] });
      const p = sim.player;
      sim.input.qbPressed = true;
      let contactTick = -1;
      const check = (): void => {
        expect(p.pos.z).toBeGreaterThanOrEqual(zStop - 1e-9);
        expect(sim.world.overlapsBox(p.pos, PLAYER.half)).toBe(false);
        if (contactTick < 0 && p.vel.z === 0) contactTick = sim.tickIndex;
        if (contactTick >= 0) {
          expect(p.vel.z).toBe(0);
          expect(p.vel.x).toBe(0);
          near(p.pos.z, zStop, 1e-9);
        }
      };
      if (frame === TICK) runUntil(sim, 2.5, check);
      else {
        for (let i = 0; i < 10; i++) {
          sim.advance(frame);
          check();
        }
      }
      near(p.pos.z, zStop, 1e-9);
      expect(p.pos.x).toBe(0);
      expect(p.qbSuccessfulCount).toBe(1);
      near(p.en, 84 + 15 * (2.5 - 0.75), 1e-9); // only the QB was paid; pushing against the wall is free and recovery runs
      expect(p.horizontalMode).toBe('glide');
      if (frame === TICK) {
        // 4.9999 m at 80 m/s: contact inside the 8th tick, long before the impulse ends.
        expect(contactTick).toBe(Math.ceil((5 - SKIN) / 80 / TICK));
        report('QB into a wall 5 m ahead', {
          wallThickness: 0.5,
          travelPerTickAt80: 80 * TICK,
          stoppedAtZ: p.pos.z,
          travelled: -p.pos.z,
          contactAt: contactTick * TICK,
          speedAfter: hspeed(sim),
        });
        // Not stuck: backing away works.
        sim.input.moveZ = -1;
        runUntil(sim, 3.5);
        expect(p.pos.z).toBeGreaterThan(zStop + 5);
      }
    }
  });

  it('a diagonal QB keeps only the component along the wall, during and after the impulse', () => {
    const sim = mk({ solids: [wall] });
    const p = sim.player;
    sim.input.moveZ = 1;
    sim.input.moveX = 1;
    sim.input.qbPressed = true;
    sim.tick();
    sim.input.moveZ = 0;
    sim.input.moveX = 0;
    const vx = 80 * Math.SQRT1_2;
    runUntil(sim, 0.15, () => {
      near(p.vel.x, vx, 1e-9);
      expect(p.pos.z).toBeGreaterThanOrEqual(zStop - 1e-9);
    });
    expect(p.vel.z).toBe(0);
    near(p.pos.x, vx * 0.15, 1e-9);
    expect(p.glideDir).toEqual({ x: 1, z: 0 }); // direction of the velocity that is actually left
    runUntil(sim, 1.5, () => {
      expect(p.vel.z).toBe(0);
      near(p.pos.z, zStop, 1e-9);
      expect(hspeed(sim)).toBeLessThanOrEqual(vx + 1e-9);
    });
    near(p.vel.x, 22, 1e-12);
  });

  it('speed lost on a short wall is not handed back from the QB direction once the wall ends', () => {
    // The wall face is 2 m ahead and ends at x = 3: a diagonal QB hits it, slides along it and runs past its
    // end at about 0.076 s — well inside the 0.15 s impulse.
    const sim = mk({ solids: [solid(-30, 0, -3.8, 3, 14, -3.3)] });
    const p = sim.player;
    const zWall = -3.3 + PLAYER.half.z + SKIN;
    const vx = 80 * Math.SQRT1_2;
    sim.input.moveZ = 1;
    sim.input.moveX = 1;
    sim.input.qbPressed = true;
    sim.tick();
    sim.input.moveZ = 0;
    sim.input.moveX = 0;
    let contactTick = -1;
    let pastEndTick = -1;
    const check = (): void => {
      expect(sim.world.overlapsBox(p.pos, PLAYER.half)).toBe(false);
      if (contactTick < 0 && p.vel.z === 0) contactTick = sim.tickIndex;
      if (pastEndTick < 0 && p.pos.x - PLAYER.half.x > 3) pastEndTick = sim.tickIndex;
      if (contactTick >= 0) {
        expect(p.vel.z).toBe(0); // never re-added, with or without the wall beside the mech
        near(p.pos.z, zWall, 1e-9);
      }
    };
    check();
    runUntil(sim, 0.15, () => {
      check();
      near(p.vel.x, vx, 1e-9);
    });
    expect(contactTick).toBeGreaterThan(0);
    expect(pastEndTick).toBeGreaterThan(contactTick);
    expect(pastEndTick).toBeLessThan(tickAt(0.15) - 4); // several impulse ticks in the open after the wall
    near(p.pos.x, vx * 0.15, 1e-9);
    expect(p.horizontalMode).toBe('glide');
    expect(p.glideDir).toEqual({ x: 1, z: 0 });
    runUntil(sim, 1.5, check);
    near(p.vel.x, 22, 1e-12);
    report('diagonal QB past a short wall', {
      contactAt: contactTick * TICK,
      wallEndPassedAt: pastEndTick * TICK,
      vzAfterContact: p.vel.z,
      zDriftAfterWallEnd: p.pos.z - zWall,
      xAt0_15s: vx * 0.15,
    });
  });

  it('flies up onto a 10 m platform and lands on it', () => {
    const sim = mk({ solids: [solid(-8, 0, -40, 8, 10, -15)] });
    const p = sim.player;
    sim.input.jumpPressed = true;
    sim.input.jump = true;
    sim.input.moveZ = 1;
    let blockedTicks = 0;
    while (sim.time < 8 && !(p.pos.y - PLAYER.half.y > 10.3 && p.pos.z < -17.5)) {
      sim.tick();
      expect(sim.world.overlapsBox(p.pos, PLAYER.half)).toBe(false);
      if (p.vel.z === 0 && p.pos.z < -13) blockedTicks++;
    }
    const tOver = sim.time;
    expect(tOver).toBeLessThan(4);
    expect(blockedTicks).toBeGreaterThan(10); // it really had to climb the face first
    const enUsed = 120 - p.en;
    near(enUsed, 20 * (tOver - 0.2), 1e-6);
    sim.input.jump = false;
    sim.input.moveZ = 0;
    sim.input.brake = true;
    sim.drainEvents();
    while (sim.time < 12 && !p.grounded) sim.tick();
    expect(p.grounded).toBe(true);
    near(p.pos.y, 10 + PLAYER.half.y + SKIN, 1e-9);
    expect(p.pos.z).toBeLessThan(-15 - PLAYER.half.z);
    expect(p.verticalMode).toBe('grounded');
    expect(ofType(sim.drainEvents(), 'land')).toHaveLength(1);
    const tLand = sim.time;
    runUntil(sim, tLand + 2, () => {
      expect(p.grounded).toBe(true);
      near(p.pos.y, 10 + PLAYER.half.y + SKIN, 1e-9);
    });
    expect(p.en).toBeGreaterThan(120 - enUsed); // recovering on the platform
    report('flight onto a 10 m platform', { abovePlatformAt: tOver, enUsed, landedAt: tLand, standingY: p.pos.y, z: p.pos.z });
  });

  it('walking off an edge starts a fall; landing 10 m below', () => {
    const sim = mk({ solids: [solid(-5, 0, -5, 5, 10, 5)], start: v3(0, 12.001, 0) });
    const p = sim.player;
    expect(p.grounded).toBe(true);
    sim.input.moveZ = 1;
    let leftTick = -1;
    let leftZ = NaN;
    let landTick = -1;
    runUntil(sim, 4.0, () => {
      if (leftTick < 0) {
        if (!p.grounded) {
          leftTick = sim.tickIndex;
          leftZ = p.pos.z;
        } else {
          expect(p.pos.y).toBe(12.001); // a grounded mech is never moved vertically
        }
      } else if (landTick < 0) {
        if (p.grounded) landTick = sim.tickIndex;
        else {
          expect(p.verticalMode).toBe('falling');
          expect(p.vel.y).toBeLessThanOrEqual(0);
          expect(p.en).toBe(120);
        }
      }
    });
    // The footprint (half 1.3) leaves the ledge edge at z = -5 when the centre passes -6.3.
    expect(leftZ).toBeLessThan(-6.3);
    expect(leftZ).toBeGreaterThan(-6.3 - 10 * TICK - 1e-9);
    expect(landTick).toBeGreaterThan(leftTick);
    const fallSeconds = (landTick - leftTick) * TICK;
    near(fallSeconds, Math.sqrt((2 * 10) / GRAVITY), 2 * TICK);
    near(p.pos.y, PLAYER.half.y + SKIN, 1e-9);
    const ev = sim.drainEvents();
    expect(ofType(ev, 'jump')).toHaveLength(0);
    const land = ofType(ev, 'land');
    expect(land).toHaveLength(1);
    near(land[0].speed, Math.sqrt(2 * GRAVITY * 10), 0.2);
    report('walking off a 10 m ledge', { leftGroundAtZ: leftZ, fallSeconds, landSpeed: land[0].speed });
  });
});

// ───────────────────────────── 12. robustness / consistency ─────────────────────────────

describe('state consistency under random input (no NaN, snapshot-facing fields)', () => {
  const arena: SolidDef[] = [
    solid(-62, 0, -62, -60, 31, 62),
    solid(60, 0, -62, 62, 31, 62),
    solid(-62, 0, -62, 62, 31, -60),
    solid(-62, 0, 60, 62, 31, 62),
    solid(-62, 30, -62, 62, 31, 62), // roof
    solid(-30, 0, -30, -10, 10, -10), // platform
    solid(10, 0, 10, 14, 30, 14), // pillar
    solid(15, 6, -40, 45, 7, -20), // mezzanine slab
    solid(0, 0, 30, 40, 12, 30.5), // thin wall
  ];

  for (const { legs, mult } of LEGS) {
    it(`${legs}: 60 s of random keys, look and garbage keep every invariant`, () => {
      const sim = mk({ legs, generator: legs === 'biped' ? 'recovery' : 'capacity', solids: arena });
      const p = sim.player;
      const inp = sim.input;
      const rng = new Rng(legs === 'biped' ? 4242 : 777);
      const pick = (): number => Math.floor(rng.next() * 3) - 1;
      const maxEn = sim.stats.maxEn;
      const finite = (...xs: number[]): void => {
        for (const x of xs) expect(Number.isFinite(x)).toBe(true);
      };
      let qbEvents = 0;
      let lastQbStart: number | null = null;
      let jumps = 0;
      let lands = 0;
      let flyTicks = 0;
      let rejected = 0;
      const seenModes = new Set<string>();
      const muzzle = v3();
      for (let i = 0; i < 60 * 120; i++) {
        const input = sim.input;
        expect(input).toBe(inp);
        if (rng.next() < 0.03) inp.moveX = pick();
        if (rng.next() < 0.03) inp.moveZ = pick();
        if (rng.next() < 0.012) {
          const want = rng.next() < 0.35;
          if (want && !inp.jump) inp.jumpPressed = true;
          inp.jump = want;
        }
        if (rng.next() < 0.01) inp.brake = rng.next() < 0.3;
        if (rng.next() < 0.02) inp.qbPressed = true;
        if (rng.next() < 0.01) inp.glideTogglePressed = true;
        if (rng.next() < 0.05) sim.applyLook((rng.next() - 0.5) * 2, rng.next() - 0.5);
        if (rng.next() < 0.002) inp.moveX = NaN;
        if (rng.next() < 0.002) inp.moveZ = Infinity;

        const enBefore = p.en;
        const groundedBefore = p.grounded;
        const before = clone(p.pos);
        sim.tick();
        expect(sim.status).toBe('playing');

        for (const e of sim.drainEvents()) {
          if (e.type === 'qb') {
            qbEvents++;
            near(Math.hypot(e.dir.x, e.dir.z), 1, 1e-9);
          } else if (e.type === 'qb-rejected') rejected++;
          else if (e.type === 'jump') jumps++;
          else if (e.type === 'land') {
            lands++;
            finite(e.speed);
            expect(e.speed).toBeGreaterThanOrEqual(0);
          }
        }

        finite(p.pos.x, p.pos.y, p.pos.z, p.prevPos.x, p.prevPos.y, p.prevPos.z, p.vel.x, p.vel.y, p.vel.z);
        finite(p.en, p.yaw, p.pitch, p.muzzle.x, p.muzzle.y, p.muzzle.z, p.qbImpulseRemaining);
        finite(p.desiredDir.x, p.desiredDir.z, p.glideDir.x, p.glideDir.z, p.qbDir.x, p.qbDir.z);

        // EN
        expect(p.en).toBeGreaterThanOrEqual(0);
        expect(p.en).toBeLessThanOrEqual(maxEn);
        if (!groundedBefore || !p.grounded) expect(p.en).toBeLessThanOrEqual(enBefore);
        expect(enBefore - p.en).toBeLessThanOrEqual(36 + 20 * TICK + 1e-9);

        // QB bookkeeping
        expect(p.qbSuccessfulCount).toBe(qbEvents);
        expect(p.qbLastStartedAt === null).toBe(qbEvents === 0);
        if (p.qbLastStartedAt !== null) {
          expect(p.qbLastStartedAt).toBeLessThanOrEqual(sim.time);
          if (lastQbStart !== null && p.qbLastStartedAt !== lastQbStart) {
            expect(p.qbLastStartedAt - lastQbStart).toBeGreaterThanOrEqual(1.0 - 1e-9);
          }
          lastQbStart = p.qbLastStartedAt;
          near(p.qbImpulseRemaining, Math.max(0, p.qbLastStartedAt + 0.15 - sim.time), 1e-9);
          near(qbCooldownRemaining(sim), Math.max(0, p.qbLastStartedAt + 1.0 - sim.time), 1e-9);
        }
        if (p.lastEnSpentAt !== null) expect(p.lastEnSpentAt).toBeLessThanOrEqual(sim.time + 1e-9);
        expect(p.qbImpulseRemaining).toBeGreaterThanOrEqual(0);
        expect(p.qbImpulseRemaining).toBeLessThanOrEqual(0.15);
        expect(p.horizontalMode === 'quickboost').toBe(p.qbImpulseRemaining > 0);

        // modes
        seenModes.add(p.horizontalMode);
        seenModes.add(p.verticalMode);
        if (p.horizontalMode === 'glide') {
          expect(p.glideEnabled).toBe(true);
          expect(p.braking).toBe(false);
          expect(p.desiredDir).toEqual(p.glideDir);
        }
        if (p.horizontalMode === 'walk' && p.qbImpulseRemaining === 0) expect(p.glideEnabled).toBe(false);
        if (p.horizontalMode === 'quickboost') expect(p.desiredDir).toEqual(p.qbDir);
        if (p.braking) {
          expect(p.horizontalMode).toBe('walk');
          expect(p.desiredDir).toEqual({ x: 0, z: 0 });
        }
        const dl = Math.hypot(p.desiredDir.x, p.desiredDir.z);
        expect(Math.abs(dl) < 1e-12 || Math.abs(dl - 1) < 1e-9).toBe(true);
        expect(p.verticalMode === 'grounded').toBe(p.grounded);
        expect(p.verticalMode === 'flying').toBe(p.flying);
        if (p.grounded) expect(p.vel.y).toBe(0);
        if (p.verticalMode === 'rising') expect(p.vel.y).toBeGreaterThan(0);
        if (p.verticalMode === 'falling') expect(p.vel.y).toBeLessThanOrEqual(0);
        // never left "falling" at or below the height a landing leaves the mech at
        if (!p.grounded && p.vel.y <= 0) expect(sim.world.probeGround(p.pos, PLAYER.half, SKIN)).toBe(Infinity);
        if (p.flying) flyTicks++;
        if (!inp.jump) expect(p.jumpHeldSince).toBeNull();
        else expect(p.jumpHeldSince).not.toBeNull();

        // kinematics
        expect(hspeed(sim)).toBeLessThanOrEqual(80 * mult + 1e-9);
        expect(Math.abs(p.vel.y)).toBeLessThan(60);
        expect(hdist(p.pos, before)).toBeLessThanOrEqual(80 * mult * TICK + 1e-9);
        expect(sim.world.overlapsBox(p.pos, PLAYER.half)).toBe(false);
        expect(Math.abs(p.pos.x)).toBeLessThan(60);
        expect(Math.abs(p.pos.z)).toBeLessThan(60);
        expect(p.pos.y).toBeGreaterThan(PLAYER.half.y);
        expect(p.pos.y).toBeLessThan(30 - PLAYER.half.y);
        expect(p.muzzle).toEqual(computeMuzzle(p.pos, p.yaw, muzzle));

        // scheduler contract
        const next = playerNextEventTime(sim);
        expect(next > sim.time + TIME_EPS).toBe(true);

        // edges are always consumed
        expect(inp.qbPressed).toBe(false);
        expect(inp.glideTogglePressed).toBe(false);
        expect(inp.jumpPressed).toBe(false);
      }
      for (const m of ['walk', 'glide', 'quickboost', 'grounded', 'rising', 'flying', 'falling']) {
        expect(seenModes.has(m)).toBe(true);
      }
      expect(qbEvents).toBeGreaterThan(5);
      expect(jumps).toBeGreaterThan(5);
      expect(lands).toBeGreaterThan(5);
      expect(flyTicks).toBeGreaterThan(100);
      report(`random input 60 s, ${legs}`, { qb: qbEvents, qbRejected: rejected, jumps, landings: lands, flightSeconds: flyTicks * TICK });
    });
  }

  it('is deterministic: interleaved twin sims and a re-sortie replay stay bit-identical', () => {
    interface Frame {
      moveX: number;
      moveZ: number;
      jump: boolean;
      jumpPressed: boolean;
      brake: boolean;
      qb: boolean;
      toggle: boolean;
      dYaw: number;
      dPitch: number;
    }
    const rng = new Rng(31337);
    const script: Frame[] = [];
    const cur = { moveX: 0, moveZ: 0, jump: false, brake: false };
    for (let i = 0; i < 20 * 120; i++) {
      const f: Frame = { ...cur, jumpPressed: false, qb: false, toggle: false, dYaw: 0, dPitch: 0 };
      if (rng.next() < 0.03) f.moveX = Math.floor(rng.next() * 3) - 1;
      if (rng.next() < 0.03) f.moveZ = Math.floor(rng.next() * 3) - 1;
      if (rng.next() < 0.012) {
        const want = rng.next() < 0.35;
        f.jumpPressed = want && !cur.jump;
        f.jump = want;
      }
      if (rng.next() < 0.01) f.brake = rng.next() < 0.3;
      f.qb = rng.next() < 0.02;
      f.toggle = rng.next() < 0.01;
      if (rng.next() < 0.05) {
        f.dYaw = (rng.next() - 0.5) * 2;
        f.dPitch = rng.next() - 0.5;
      }
      cur.moveX = f.moveX;
      cur.moveZ = f.moveZ;
      cur.jump = f.jump;
      cur.brake = f.brake;
      script.push(f);
    }
    const apply = (sim: Sim, f: Frame): void => {
      const inp = sim.input;
      inp.moveX = f.moveX;
      inp.moveZ = f.moveZ;
      inp.jump = f.jump;
      inp.brake = f.brake;
      if (f.jumpPressed) inp.jumpPressed = true;
      if (f.qb) inp.qbPressed = true;
      if (f.toggle) inp.glideTogglePressed = true;
      if (f.dYaw !== 0 || f.dPitch !== 0) sim.applyLook(f.dYaw, f.dPitch);
    };
    const a = mk({ legs: 'quadruped', generator: 'recovery', solids: arena });
    const b = mk({ legs: 'quadruped', generator: 'recovery', solids: arena });
    const trace: string[] = [];
    for (const f of script) {
      // interleaved: any state shared between the two simulations would show up as a difference
      apply(a, f);
      a.tick();
      apply(b, f);
      b.tick();
      const sa = JSON.stringify(a.player);
      expect(JSON.stringify(b.player)).toBe(sa);
      trace.push(sa);
    }
    expect(a.player.qbSuccessfulCount).toBeGreaterThan(2);
    // Re-sortie: everything (including the private EN ramp bookkeeping) starts afresh and replays identically.
    a.reset();
    expect(a.player.qbSuccessfulCount).toBe(0);
    expect(a.player.qbLastStartedAt).toBeNull();
    expect(a.player.lastEnSpentAt).toBeNull();
    expect(a.player.glideEnabled).toBe(false);
    expect(a.player.qbImpulseRemaining).toBe(0);
    expect(a.player.en).toBe(a.stats.maxEn);
    script.forEach((f, i) => {
      apply(a, f);
      a.tick();
      if (i % 60 === 59 || i === script.length - 1) expect(JSON.stringify(a.player)).toBe(trace[i]);
    });
  });

  it('presses made while the sortie is not being played are dropped (no QB, no jump, not queued)', () => {
    const sim = mk();
    const p = sim.player;
    sim.status = 'cleared';
    sim.input.qbPressed = true;
    sim.input.jumpPressed = true;
    sim.input.glideTogglePressed = true;
    applyPlayerInputEdges(sim);
    expect(sim.input.qbPressed || sim.input.jumpPressed || sim.input.glideTogglePressed).toBe(false);
    expect(p.qbSuccessfulCount).toBe(0);
    expect(p.en).toBe(120);
    expect(p.grounded).toBe(true);
    expect(p.glideEnabled).toBe(false);
    expect(sim.advance(1)).toBe(0); // a finished sortie does not advance
    sim.status = 'playing';
    runUntil(sim, 1.0);
    expect(p.qbSuccessfulCount).toBe(0);
    expect(p.vel).toEqual({ x: 0, y: 0, z: 0 });
    expect(sim.drainEvents().filter((e) => e.type === 'qb' || e.type === 'jump' || e.type === 'glide')).toHaveLength(0);
  });

  it('reports only strictly future event times: impulse end, flight threshold, regeneration start', () => {
    const sim = mk();
    const p = sim.player;
    expect(playerNextEventTime(sim)).toBe(Infinity);
    sim.input.qbPressed = true;
    sim.tick();
    expect(playerNextEventTime(sim)).toBe(0.15);
    runUntil(sim, 0.15);
    expect(p.qbImpulseRemaining).toBe(0);
    expect(playerNextEventTime(sim)).toBe(0.75); // EN recovery start (EN 84 < 120)
    runUntil(sim, 0.75);
    expect(playerNextEventTime(sim)).toBe(Infinity);
    sim.input.jumpPressed = true;
    sim.input.jump = true;
    sim.tick();
    near(playerNextEventTime(sim), 0.75 + 0.2, 1e-12);
    runUntil(sim, 1.0);
    // flying: the next event is the earliest possible recovery start, 0.75 s after the latest spend
    near(playerNextEventTime(sim), 1.0 + 0.75, 1e-9);
  });

  it('a degenerate step length changes nothing but still refreshes prevPos and the muzzle', () => {
    const sim = steadyGlide();
    const p = sim.player;
    const pos = clone(p.pos);
    const vel = clone(p.vel);
    for (const h of [0, -1, NaN, Infinity]) {
      updatePlayer(sim, h, 0);
      expect(p.pos).toEqual(pos);
      expect(p.vel).toEqual(vel);
      expect(p.prevPos).toEqual(pos);
    }
    expect(p.muzzle).toEqual(computeMuzzle(p.pos, p.yaw, v3()));
  });
});
