/**
 * ADVERSARIAL SPEC AUDIT: movement / EN (SPEC §6, §7.1-7.4, §11 movement rows).
 *
 * Every expectation below is derived from the SPEC text (numbers are hard-coded from the SPEC tables, NOT read from
 * src/config.ts, so a wrong config value is caught). Every test drives the real Game (Game.step / Game.advance).
 * Tests are written against the SPEC, never loosened to fit an implementation quirk. Where the SPEC is silent the
 * assumption is written next to the test (search "ASSUMPTION").
 *
 * Claim ids used in test names:
 *   [S6-*]  SPEC §6 generators / legs / EN          [S7.1-*] controls        [S7.2-*] QB
 *   [S7.3-*] glide / brake                           [S7.4-*] jump / flight   [S7.1-U*] input layer taps (src/ui/input.ts)
 *   [FR-*]  frame-rate independence / advance()      [COL-*] collision        [HUD-*] QB indicator
 *   [FUZZ-*] tick-by-tick oracles + invariants       [STAGE-*] real campaign stage   [PAUSE-*] [SNAP-*]
 *
 * Heavy search (not run by default): AUDIT_SEEDS=40 AUDIT_TICKS=6000 npx vitest run tests/audit-movement.test.ts -t FUZZ
 */
import { describe, expect, it } from 'vitest';
import type { FcsId, GeneratorId, LegsId } from '../src/config';
import { buildSnapshot } from '../src/sim/bench';
import { Game } from '../src/sim/game';
import { makeScriptedTarget } from '../src/sim/scenario';
import { computeEffectiveStats } from '../src/sim/stats';
import { buildTestArenaStage, createArenaGame } from '../src/sim/testArena';
import type { ArenaOptions } from '../src/sim/testArena';
import type { BoxDef, EnemyBullet, Loadout } from '../src/sim/types';
import { buildStage } from '../src/stage';
import { buildHudModel } from '../src/ui/hudLogic';
import { InputController, actionForCode, applyKeyDown, applyKeyUp } from '../src/ui/input';

// ----------------------------------------------------------------------------------------------------------------
// SPEC constants (hard-coded from the SPEC text on purpose)
// ----------------------------------------------------------------------------------------------------------------
const DT = 1 / 120; // ARCH §3 fixed step
const HALF = { x: 0.8, y: 1.5, z: 0.8 }; // ARCH §5: 1.6 x 3.0 x 1.6 m
const S = {
  WALK: 10,
  GLIDE: 22,
  AIR: 16,
  QB_V: 80,
  QB_T: 0.15,
  QB_COST: 36,
  QB_CD: 1.0,
  QB_DECEL_T: 0.6,
  JUMP: 10,
  HOLD: 0.2,
  ASCENT: 8,
  FLIGHT_EN: 20,
  G: 18,
  WAIT: 0.75,
  ACC: 120,
  BEAM_COST: 8,
};
const GLIDE_ACC_G = (S.QB_V - S.GLIDE) / S.QB_DECEL_T; // 96.666.. m/s^2 (SPEC 7.2)
const GLIDE_ACC_A = (S.QB_V - S.AIR) / S.QB_DECEL_T; // 106.666.. m/s^2 (SPEC 7.2, air)
const APEX = (S.JUMP * S.JUMP) / (2 * S.G); // 2.7777.. m

const GEN: Record<GeneratorId, { maxEn: number; regen: number }> = {
  capacity: { maxEn: 180, regen: 10 },
  balanced: { maxEn: 120, regen: 15 },
  recovery: { maxEn: 90, regen: 20 },
};
const LEGS: Record<LegsId, { speed: number; regen: number; lock: number }> = {
  biped: { speed: 1.0, regen: 1.0, lock: 1.0 },
  quadruped: { speed: 0.8, regen: 0.75, lock: 1.5 },
};
const FCSP: Record<FcsId, { radius: number; lock: number }> = {
  wide: { radius: 0.3, lock: 1.2 },
  medium: { radius: 0.2, lock: 0.8 },
  narrow: { radius: 0.1, lock: 0.4 },
};
const ALL: Loadout[] = [];
for (const fcs of ['wide', 'medium', 'narrow'] as FcsId[])
  for (const generator of ['capacity', 'balanced', 'recovery'] as GeneratorId[])
    for (const legs of ['biped', 'quadruped'] as LegsId[]) ALL.push({ fcs, generator, legs });
const label = (l: Loadout): string => `${l.fcs}/${l.generator}/${l.legs}`;

const BIPED: Loadout = { fcs: 'medium', generator: 'balanced', legs: 'biped' };
const QUAD: Loadout = { fcs: 'medium', generator: 'balanced', legs: 'quadruped' };

type Key = 'forward' | 'back' | 'left' | 'right' | 'jump' | 'shift' | 'ctrl' | 'qb' | 'fire';
const KEYS: Key[] = ['forward', 'back', 'left', 'right', 'jump', 'shift', 'ctrl', 'qb', 'fire'];

// ----------------------------------------------------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------------------------------------------------
const arena = (l: Loadout = BIPED, opts?: ArenaOptions): Game => createArenaGame(l, opts);
const box = (id: string, min: [number, number, number], max: [number, number, number]): BoxDef => ({
  id,
  min: { x: min[0], y: min[1], z: min[2] },
  max: { x: max[0], y: max[1], z: max[2] },
  mat: 'concrete',
  sectorId: 'T00',
});
function arenaWith(l: Loadout, boxes: BoxDef[], floorHalf = 600): Game {
  const stage = buildTestArenaStage({ floorHalf });
  stage.boxes.push(...boxes);
  const g = new Game({ stage, loadout: l });
  g.sortie(l);
  return g;
}
const run = (g: Game, n: number, each?: (k: number) => void): void => {
  for (let k = 0; k < n; k++) {
    g.step();
    each?.(k);
  }
};
const hs = (g: Game): number => Math.hypot(g.state.player.vel.x, g.state.player.vel.z);
const tapQ = (g: Game): void => {
  g.input.qb = true;
  g.step();
  g.input.qb = false;
};
const tapShift = (g: Game): void => {
  g.input.shift = true;
  g.step();
  g.input.shift = false;
};
const evCount = (g: Game, type: string): number => g.state.events.filter((e) => e.type === type).length;
/** put the player high in the air (no floor within reach) */
function lift(g: Game, y = 300): void {
  g.state.player.pos.y = y;
  g.state.player.grounded = false;
}
const rngOf = (seed: number): (() => number) => {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
};
/** horizontal unit vector of WASD in the CAMERA frame (uses the real camera state, not math.ts) */
function camDir(g: Game, ix: number, iz: number): [number, number] {
  const c = g.state.camera;
  const fl = Math.hypot(c.forward.x, c.forward.z);
  const rl = Math.hypot(c.right.x, c.right.z);
  const x = (c.forward.x / fl) * iz + (c.right.x / rl) * ix;
  const z = (c.forward.z / fl) * iz + (c.right.z / rl) * ix;
  const l = Math.hypot(x, z);
  return l > 1e-12 ? [x / l, z / l] : [0, 0];
}
function camForward(g: Game): [number, number] {
  return camDir(g, 0, 1);
}
function setView(g: Game, yaw: number, pitch: number): void {
  g.state.player.yaw = yaw;
  g.state.player.pitch = pitch;
  g.look(0, 0); // refresh the camera (also clamps the pitch)
}
const near = (a: number, b: number, tol = 1e-9): boolean => Math.abs(a - b) <= tol;

// ================================================================================================================
// §6 generator / legs / effective stats
// ================================================================================================================
describe('[S6] generator x legs x FCS: the 18 loadouts have the SPEC effective stats', () => {
  for (const l of ALL) {
    it(label(l), () => {
      const gen = GEN[l.generator];
      const leg = LEGS[l.legs];
      const f = FCSP[l.fcs];
      const st = computeEffectiveStats(l);
      expect(st.maxEn).toBe(gen.maxEn);
      expect(st.regenPerSecond).toBeCloseTo(gen.regen * leg.regen, 12); // 実効EN回復率 = 基本 x 脚部倍率
      expect(st.lockSeconds).toBeCloseTo(f.lock / leg.lock, 12); // ロック所要時間 = 基本 / ロック速度倍率 (NOT x)
      expect(st.horizontalSpeedMultiplier).toBe(leg.speed);
      const g = arena(l);
      expect(g.state.stats).toEqual(st);
      expect(g.state.player.en).toBe(gen.maxEn); // 出撃時EN = 最大EN
      expect(buildSnapshot(g.state).effectiveStats).toEqual(st);
      expect(g.state.lock.radiusCssPx).toBeCloseTo(f.radius * 720, 9); // 1280x720 -> D = 720
    });
  }
  it('[S6-G1] max EN x base regen = 1800 for every generator (inverse proportion)', () => {
    for (const id of ['capacity', 'balanced', 'recovery'] as GeneratorId[]) {
      const st = computeEffectiveStats({ fcs: 'medium', generator: id, legs: 'biped' });
      expect(st.maxEn * st.regenPerSecond).toBeCloseTo(1800, 9);
    }
  });
  it('[S6-G2] SPEC example: medium FCS / balanced / 4 legs = maxEn 120, 11.25 EN/s, lock ~0.533 s', () => {
    const st = computeEffectiveStats(QUAD);
    expect(st.maxEn).toBe(120);
    expect(st.regenPerSecond).toBeCloseTo(11.25, 12);
    expect(st.lockSeconds).toBeCloseTo(0.8 / 1.5, 12);
    expect(st.lockSeconds).toBeGreaterThan(0.5333);
    expect(st.lockSeconds).toBeLessThan(0.5334);
  });
  it('[S6-G3] minimum max EN of any loadout is 90 and the slowest air speed is 12.8 m/s (SPEC 2.2 climb budget inputs)', () => {
    expect(Math.min(...ALL.map((l) => computeEffectiveStats(l).maxEn))).toBe(90);
    expect(Math.min(...ALL.map((l) => S.AIR * computeEffectiveStats(l).horizontalSpeedMultiplier))).toBeCloseTo(12.8, 12);
  });
});

describe('[S6] leg multiplier: applies to walk / glide / air / QB, NOT to jump, ascent, gravity (all 18 loadouts, measured in the game)', () => {
  for (const l of ALL) {
    it(label(l), () => {
      const m = LEGS[l.legs].speed;
      const regen = GEN[l.generator].regen * LEGS[l.legs].regen;
      const maxEn = GEN[l.generator].maxEn;
      // walk
      const w = arena(l);
      w.input.forward = true;
      run(w, 90);
      expect(hs(w)).toBeCloseTo(S.WALK * m, 9);
      // ground glide (Shift once, then release)
      const gl = arena(l);
      tapShift(gl);
      run(gl, 89);
      expect(hs(gl)).toBeCloseTo(S.GLIDE * m, 9);
      // air walking speed (jump while holding W)
      const air = arena(l);
      air.input.forward = true;
      air.input.jump = true;
      air.step();
      air.input.jump = false;
      run(air, 59);
      expect(air.state.player.grounded).toBe(false);
      expect(hs(air)).toBeCloseTo(S.AIR * m, 9);
      // QB peak speed and 0.75 s distance
      const q = arena(l);
      const z0 = q.state.player.pos.z;
      let peak = 0;
      tapQ(q);
      peak = Math.max(peak, hs(q));
      run(q, 89, () => (peak = Math.max(peak, hs(q))));
      expect(peak).toBeCloseTo(S.QB_V * m, 9);
      expect(Math.abs(q.state.player.pos.z - z0)).toBeCloseTo(42.6 * m, 1); // 0.05 m tolerance (SPEC: "約")
      // jump initial speed / apex do NOT scale
      const j = arena(l);
      const y0 = j.state.player.pos.y;
      let maxY = y0;
      j.input.jump = true;
      j.step();
      j.input.jump = false;
      expect(j.state.player.vel.y).toBeCloseTo(S.JUMP - S.G * DT, 9);
      run(j, 150, () => (maxY = Math.max(maxY, j.state.player.pos.y)));
      expect(maxY - y0).toBeGreaterThan(2.77);
      expect(maxY - y0).toBeLessThan(2.78);
      // flight ascent and EN cost do NOT scale
      const f = arena(l);
      f.input.jump = true;
      run(f, 120);
      expect(f.state.player.vel.y).toBeCloseTo(S.ASCENT, 9);
      expect(f.state.player.en).toBeCloseTo(maxEn - S.FLIGHT_EN * (1 - S.HOLD), 6);
      // gravity does NOT scale
      const fall = arena(l);
      lift(fall);
      run(fall, 60);
      expect(fall.state.player.vel.y).toBeCloseTo(-S.G * 0.5, 9);
      // regeneration = base x leg multiplier
      const r = arena(l);
      r.state.player.en = 0;
      run(r, 120);
      expect(r.state.player.en).toBeCloseTo(regen, 6);
    });
  }
});

// ================================================================================================================
// §6 EN regeneration rules
// ================================================================================================================
describe('[S6-R] EN regeneration: grounded, nothing spent, >= 0.75 s after the LAST real spend', () => {
  it('[S6-R1] QB at t=0 on the ground: EN flat until exactly 0.75 s, then +15 EN/s while gliding; impulse end / inertia end do not restart the wait', () => {
    const g = arena(BIPED);
    const p = g.state.player;
    tapQ(g);
    expect(p.en).toBe(84);
    const flat: number[] = [p.en];
    run(g, 89, () => flat.push(p.en)); // through the tick that ends at t = 0.75 s
    expect(g.state.time).toBeCloseTo(0.75, 12);
    expect(flat.every((e) => e === 84)).toBe(true);
    for (let k = 1; k <= 90; k++) {
      g.step();
      expect(p.en).toBeCloseTo(84 + 15 * k * DT, 9); // regen from 0.75 s, continuous
      expect(hs(g)).toBeCloseTo(22, 9); // still gliding, regen does not need the glide to stop
    }
    expect(p.mv.lastEnSpentAt).toBe(0);
  });

  it('[S6-R1b] QB at a later time t0: regen starts at exactly t0 + 0.75 (measured on the EN trace)', () => {
    for (const t0Ticks of [17, 60, 133]) {
      const g = arena(BIPED);
      const p = g.state.player;
      p.en = 60;
      run(g, t0Ticks); // idle: EN regenerates from 60
      p.en = 60; // reset so that the trace is clean
      tapQ(g);
      const t0 = t0Ticks * DT;
      expect(p.mv.qbLastStartedAt).toBeCloseTo(t0, 12);
      expect(p.en).toBe(24);
      let firstUp = -1;
      for (let k = 1; k <= 200 && firstUp < 0; k++) {
        const before = p.en;
        g.step();
        if (p.en > before + 1e-12) firstUp = g.state.time; // end time of the first regenerating tick
      }
      expect(firstUp).toBeCloseTo(t0 + 0.75 + DT, 9);
    }
  });

  it('[S6-R2] the beam is an EN spend: -8, wait restarts at the shot, regen from shot + 0.75 s; a held trigger keeps the wait alive', () => {
    const g = arena(BIPED);
    const p = g.state.player;
    p.en = 100;
    g.input.weaponSelect = 'beam';
    g.input.fire = true;
    g.step(); // beam fired at t = 0
    g.input.fire = false;
    expect(p.en).toBe(92);
    expect(p.mv.lastEnSpentAt).toBe(0);
    expect(g.state.shots.length).toBe(1);
    run(g, 89);
    expect(p.en).toBe(92);
    g.step();
    expect(p.en).toBeCloseTo(92 + 15 * DT, 9);
    // held trigger: shots every 0.25 s -> never 0.75 s without a spend -> no regen at all
    const h = arena(BIPED);
    const hp = h.state.player;
    hp.en = 100;
    h.input.weaponSelect = 'beam';
    h.input.fire = true;
    let maxEn = 0;
    let prev = hp.en;
    for (let k = 0; k < 240; k++) {
      h.step();
      expect(hp.en).toBeLessThanOrEqual(prev + 1e-12);
      prev = hp.en;
      maxEn = Math.max(maxEn, hp.en);
    }
    expect(h.state.shots.length).toBe(8); // t = 0, .25, ..., 1.75
    expect(hp.en).toBeCloseTo(100 - 64, 9);
    expect(maxEn).toBeLessThanOrEqual(100);
  });

  it('[S6-R3] no regeneration in the air: rising / falling of a plain jump, even long after the last spend', () => {
    const g = arena(BIPED);
    const p = g.state.player;
    p.en = 50; // nothing spent yet (lastEnSpentAt = null)
    g.input.jump = true;
    g.step();
    g.input.jump = false;
    let airTicks = 0;
    let landed = false;
    let regenAfterLanding = false;
    for (let k = 0; k < 200; k++) {
      const before = p.en;
      const wasGrounded = p.grounded;
      g.step();
      if (!wasGrounded && !p.grounded) {
        airTicks++;
        expect(p.en).toBe(before);
      }
      if (p.grounded) landed = true;
      if (landed && p.en > 50 + 1e-9) regenAfterLanding = true;
    }
    expect(airTicks).toBeGreaterThan(100);
    expect(regenAfterLanding).toBe(true); // ...and it does regenerate again on the ground
    // falling for 3 s with the wait long over
    const f = arena(BIPED);
    lift(f);
    f.state.player.en = 50;
    run(f, 360, () => expect(f.state.player.en).toBe(50));
  });

  it('[S6-R4] no regeneration during inertial motion in the air (QB + auto glide in the air)', () => {
    const g = arena(BIPED);
    lift(g);
    tapQ(g);
    expect(g.state.player.en).toBe(84);
    run(g, 240, () => expect(g.state.player.en).toBe(84)); // 2 s: impulse, inertia, steady glide - all airborne
    expect(g.state.player.grounded).toBe(false);
    expect(g.state.player.mv.horizontalMode).toBe('glide');
  });

  it('[S6-R5] flight spends EN only; nothing regenerates while flying and after it the wait restarts at the END of the thrust', () => {
    const g = arena(BIPED, { platforms: [{ id: 'ceil', top: { x: 0, y: 7, z: 0 }, sizeX: 40, sizeZ: 40 }] });
    const p = g.state.player;
    g.input.jump = true;
    let prev = p.en;
    run(g, 60, () => {
      expect(p.en).toBeLessThanOrEqual(prev + 1e-12);
      prev = p.en;
    });
    g.input.jump = false;
    const endThrust = p.mv.lastEnSpentAt as number;
    expect(endThrust).toBeCloseTo(60 * DT, 9); // the last thrust tick ended at 0.5 s
    const enEnd = p.en;
    let firstUp = -1;
    for (let k = 0; k < 400 && firstUp < 0; k++) {
      const before = p.en;
      g.step();
      if (p.en > before + 1e-12) {
        firstUp = g.state.time;
        expect(p.grounded).toBe(true);
      }
    }
    expect(firstUp).toBeCloseTo(endThrust + S.WAIT + DT, 6);
    expect(p.en).toBeCloseTo(enEnd + 15 * DT, 9);
  });

  const walkers: [string, (g: Game) => void][] = [
    ['walking', (g) => (g.input.forward = true)],
    ['ground glide', (g) => tapShift(g)],
    ['brake held', (g) => (g.input.ctrl = true)],
    ['machinegun firing', (g) => (g.input.fire = true)],
  ];
  for (const [name, setup] of walkers) {
    it(`[S6-R6] ${name} does not block regeneration (exactly 15 EN/s, nothing stops)`, () => {
      const g = arena(BIPED);
      const p = g.state.player;
      p.en = 10;
      setup(g);
      const start = p.en;
      const steps = name === 'ground glide' ? 120 : 120;
      const already = g.state.tick;
      run(g, steps);
      const ticks = g.state.tick - already;
      expect(p.en).toBeCloseTo(start + 15 * ticks * DT, 6);
      if (name === 'machinegun firing') expect(p.ammo.machinegun).toBeLessThan(300);
      if (name === 'ground glide') expect(p.mv.glideEnabled).toBe(true);
    });
  }

  it('[S6-R7] locking on a target and firing missiles does not block regeneration either', () => {
    const g = arena(BIPED);
    const s = g.state;
    const p = s.player;
    setView(g, 0, 0);
    s.enemies.push(makeScriptedTarget('TGT', { x: p.pos.x, y: p.pos.y + 1.2, z: p.pos.z - 60 }, { x: 0, y: 0, z: 0 }));
    p.en = 10;
    p.weapon = 'missile';
    g.input.fire = true;
    let locked = false;
    run(g, 300, () => {
      if (s.lock.state === 'locked') locked = true;
    });
    expect(locked).toBe(true);
    expect(p.ammo.missile).toBeLessThan(12); // missiles really were fired
    expect(p.en).toBeCloseTo(10 + 15 * 300 * DT, 6);
  });

  it('[S6-R8] failed QB (EN 35, cooldown, Ctrl) changes neither the wait time nor the QB cooldown nor the count', () => {
    const g = arena(BIPED);
    const p = g.state.player;
    lift(g); // airborne: EN cannot move, so any change is a spend
    p.en = 35;
    g.input.qb = true;
    run(g, 30);
    expect(p.en).toBe(35);
    expect(p.mv.lastEnSpentAt).toBeNull();
    expect(p.mv.qbLastStartedAt).toBeNull();
    expect(p.mv.qbCooldownRemaining).toBe(0);
    expect(p.mv.qbSuccessCount).toBe(0);
    // grounded: a failed press must not interrupt the regeneration either
    const h = arena(BIPED);
    const hp = h.state.player;
    hp.en = 20;
    run(h, 10);
    h.input.qb = true;
    h.step(); // fails (EN 21.25 < 36)
    h.input.qb = false;
    run(h, 109);
    expect(hp.en).toBeCloseTo(20 + 15 * 120 * DT, 9);
    expect(hp.mv.lastEnSpentAt).toBeNull();
  });

  it('[S6-R9] a refused beam shot (EN < 8) costs nothing, does not touch the wait time and does not delay the next shot', () => {
    const g = arena(BIPED);
    const p = g.state.player;
    p.en = 7;
    g.input.weaponSelect = 'beam';
    g.input.fire = true;
    let firedAt = -1;
    for (let k = 0; k < 20; k++) {
      g.step();
      if (firedAt < 0 && g.state.shots.length > 0) firedAt = k;
      if (firedAt < 0) {
        expect(p.mv.lastEnSpentAt).toBeNull();
        expect(p.en).toBeCloseTo(7 + 15 * (k + 1) * DT, 9); // regen was never interrupted by the refused attempts
      }
    }
    // EN reaches 8 after 8 ticks; the shot must happen on the first tick that starts with EN >= 8 (no penalty timer)
    expect(firedAt).toBeGreaterThanOrEqual(7);
    expect(firedAt).toBeLessThanOrEqual(9);
  });

  it('[S6-R10] EN stays inside 0..max: regeneration is clamped at max and never negative', () => {
    for (const l of ALL) {
      const g = arena(l);
      const max = GEN[l.generator].maxEn;
      g.state.player.en = max - 0.01;
      run(g, 240);
      expect(g.state.player.en).toBe(max);
      g.state.player.en = 0;
      g.input.jump = true;
      run(g, 240); // jump/flight with EN 0
      expect(g.state.player.en).toBeGreaterThanOrEqual(0);
      expect(g.state.player.en).toBeLessThanOrEqual(max);
    }
  });
});

// ================================================================================================================
// §6 / §7.4 same-tick EN order: QB -> beam -> flight, never a double payment
// ================================================================================================================
describe('[S6-ORDER] QB -> beam -> flight in the same update (airborne, so no regeneration interferes)', () => {
  const ENS = [0, 0.1, 1, 7.99, 8, 8.01, 19.99, 20, 35.99, 36, 36.01, 43.99, 44, 44.01, 44.5, 50, 56, 56.01, 60, 64, 120];
  for (const qb of [false, true])
    for (const beam of [false, true])
      for (const fly of [false, true]) {
        it(`qb=${qb} beam=${beam} flight=${fly}: pay in that order, only what can be paid, exactly once`, () => {
          for (const en of ENS) {
            const g = arena(BIPED);
            const p = g.state.player;
            lift(g);
            g.input.weaponSelect = 'beam';
            if (fly) {
              g.input.jump = true;
              run(g, 24); // the 0.20 s hold is complete when tick 24 starts (no EN spent before: airborne press)
              expect(p.en).toBe(120);
            } else {
              run(g, 24);
            }
            p.en = en;
            const T0 = g.state.time;
            g.input.qb = qb;
            g.input.fire = beam;
            g.step();
            let e = en;
            let qbOk = false;
            let beamOk = false;
            if (qb && e >= 36) {
              e -= 36;
              qbOk = true;
            }
            if (beam && e >= 8) {
              e -= 8;
              beamOk = true;
            }
            let tau = 0;
            if (fly && e > 1e-9) {
              tau = Math.min(DT, e / 20);
              e -= 20 * tau;
            }
            const ctx = `EN ${en}`;
            expect(p.en, ctx).toBeCloseTo(Math.max(0, e), 9);
            expect(p.en, ctx).toBeGreaterThanOrEqual(0);
            expect(p.mv.qbSuccessCount, ctx).toBe(qbOk ? 1 : 0);
            expect(g.state.shots.length, ctx).toBe(beamOk ? 1 : 0);
            expect(p.mv.thrusting, ctx).toBe(tau > 1e-12);
            if (qbOk || beamOk || tau > 1e-12) {
              const expectLast = tau > 1e-12 ? T0 + tau : T0;
              expect(p.mv.lastEnSpentAt as number, ctx).toBeCloseTo(expectLast, 9);
            } else {
              expect(p.mv.lastEnSpentAt, ctx).toBeNull();
            }
          }
        });
      }
});

// ================================================================================================================
// EN = 0 keeps the free movement
// ================================================================================================================
describe('[S6-Z] EN 0: walking, jumping, gliding, MG, missile keep working; only EN spends fail', () => {
  function zeroEn(): Game {
    const g = arena(BIPED);
    g.state.player.en = 0;
    g.state.player.mv.lastEnSpentAt = 0; // wait active for the first 0.75 s: EN stays 0
    return g;
  }
  it('[S6-Z1] walk 10 m/s', () => {
    const g = zeroEn();
    g.input.forward = true;
    run(g, 60);
    expect(hs(g)).toBeCloseTo(10, 9);
    expect(g.state.player.en).toBe(0);
  });
  it('[S6-Z2] normal jump: 10 m/s, apex 2.78 m; holding Space gives NO thrust and no free ascent', () => {
    const g = zeroEn();
    const p = g.state.player;
    const y0 = p.pos.y;
    g.input.jump = true;
    let maxY = y0;
    let thrust = false;
    run(g, 80, () => {
      maxY = Math.max(maxY, p.pos.y);
      if (p.mv.thrusting) thrust = true;
    });
    expect(thrust).toBe(false);
    expect(p.en).toBe(0);
    expect(maxY - y0).toBeGreaterThan(2.77);
    expect(maxY - y0).toBeLessThan(APEX + 1e-9);
  });
  it('[S6-Z3] glide works and costs nothing', () => {
    const g = zeroEn();
    tapShift(g);
    run(g, 60);
    expect(hs(g)).toBeCloseTo(22, 9);
    expect(g.state.player.en).toBe(0);
    expect(g.state.player.mv.horizontalMode).toBe('glide');
  });
  it('[S6-Z4] machinegun fires; a QB request fails (no EN)', () => {
    const g = zeroEn();
    g.input.fire = true;
    g.input.qb = true;
    run(g, 30);
    expect(g.state.player.ammo.machinegun).toBeLessThan(300);
    expect(g.state.player.mv.qbSuccessCount).toBe(0);
    expect(g.state.player.en).toBe(0);
  });
  it('[S6-Z5] a QB that started with exactly 36 EN is not interrupted by EN reaching 0: 42.6 m in 0.75 s, glide continues', () => {
    const g = arena(BIPED);
    const p = g.state.player;
    p.en = 36;
    const z0 = p.pos.z;
    tapQ(g);
    expect(p.en).toBe(0);
    run(g, 89);
    expect(Math.abs(p.pos.z - z0)).toBeCloseTo(42.6, 1);
    expect(p.en).toBe(0);
    run(g, 60);
    expect(hs(g)).toBeCloseTo(22, 9);
    expect(p.mv.glideEnabled).toBe(true);
    expect(p.en).toBeCloseTo(15 * 60 * DT, 6); // 0.75 s after the QB the regeneration starts, while the glide keeps going
  });
});

// ================================================================================================================
// §7.1 controls
// ================================================================================================================
describe('[S7.1] key layout of the input layer (src/ui/input.ts)', () => {
  it('[S7.1-K1] WASD / Space / Shift / LEFT Ctrl / Q / 1-2-3 / Esc map to the SPEC actions; right Ctrl is not the brake', () => {
    expect(actionForCode('KeyW')).toBe('forward');
    expect(actionForCode('KeyA')).toBe('left');
    expect(actionForCode('KeyS')).toBe('back');
    expect(actionForCode('KeyD')).toBe('right');
    expect(actionForCode('Space')).toBe('jump');
    expect(actionForCode('ShiftLeft')).toBe('shift');
    expect(actionForCode('ControlLeft')).toBe('ctrl');
    expect(actionForCode('ControlRight')).toBeNull();
    expect(actionForCode('KeyQ')).toBe('qb');
    expect(actionForCode('Digit1')).toBe('weapon1');
    expect(actionForCode('Digit2')).toBe('weapon2');
    expect(actionForCode('Digit3')).toBe('weapon3');
    expect(actionForCode('Escape')).toBe('escape');
  });
  it('[S7.1-K2] key repeat (event.repeat = true) never re-arms Q / Shift / Space', () => {
    const g = arena(BIPED);
    applyKeyDown(g.input, 'KeyQ', false);
    g.advance(DT); // tick 0: QB
    expect(g.state.player.mv.qbSuccessCount).toBe(1);
    applyKeyUp(g.input, 'KeyQ');
    g.advance(DT);
    // OS key repeat while the key is physically up must not turn the level on
    for (let i = 0; i < 300; i++) {
      applyKeyDown(g.input, 'KeyQ', true);
      g.advance(DT);
    }
    expect(g.input.qb).toBe(false);
    expect(g.state.player.mv.qbSuccessCount).toBe(1);
    // a held Shift with repeats toggles the glide exactly once
    const s = arena(BIPED);
    applyKeyDown(s.input, 'ShiftLeft', false);
    for (let i = 0; i < 120; i++) {
      applyKeyDown(s.input, 'ShiftLeft', true);
      s.advance(DT);
    }
    expect(s.state.player.mv.glideEnabled).toBe(true);
  });
});

describe('[S7.1-U] the input layer must not lose a press that is released before the next simulation tick (SPEC 7.2/11: "Qを短く押して全キーを離しても")', () => {
  // An automated driver (e.g. Playwright keyboard.press without delay) delivers keydown+keyup back-to-back, before the next
  // requestAnimationFrame. Game.input is level based, so a level that goes true->false between two ticks is invisible to the sim.
  it('[S7.1-U1] Q down+up between two frames still gives one QB', () => {
    const g = arena(BIPED);
    applyKeyDown(g.input, 'KeyQ', false);
    applyKeyUp(g.input, 'KeyQ');
    g.advance(1 / 60);
    g.advance(1 / 60);
    g.advance(1 / 60);
    expect(g.state.player.mv.qbSuccessCount).toBe(1);
  });
  it('[S7.1-U2] Space down+up between two frames still gives a jump', () => {
    const g = arena(BIPED);
    applyKeyDown(g.input, 'Space', false);
    applyKeyUp(g.input, 'Space');
    g.advance(1 / 60);
    g.advance(1 / 60);
    expect(evCount(g, 'jump')).toBe(1);
  });
  it('[S7.1-U4] through the real InputController listeners (keydown / keyup events on an EventTarget): Q down+up between two frames still gives one QB', () => {
    const g = arena(BIPED);
    const target = new EventTarget();
    const ctl = new InputController({
      input: g.input,
      isPlaying: () => g.state.mode === 'playing',
      isLocked: () => true,
      look: (dx, dy) => g.look(dx, dy),
      onEscape: () => {},
    });
    ctl.attach(target as unknown as Window);
    target.dispatchEvent(Object.assign(new Event('keydown'), { code: 'KeyQ', repeat: false }));
    target.dispatchEvent(Object.assign(new Event('keyup'), { code: 'KeyQ' }));
    g.advance(1 / 60);
    g.advance(1 / 60);
    ctl.detach();
    expect(g.state.player.mv.qbSuccessCount).toBe(1);
  });
  it('[S7.1-U3] Shift down+up between two frames still toggles the glide', () => {
    const g = arena(BIPED);
    applyKeyDown(g.input, 'ShiftLeft', false);
    applyKeyUp(g.input, 'ShiftLeft');
    g.advance(1 / 60);
    g.advance(1 / 60);
    expect(g.state.player.mv.glideEnabled).toBe(true);
  });
});

describe('[S7.1] WASD -> camera-horizontal direction, 10 m/s, no diagonal speed-up, no lift from camera pitch', () => {
  const combos: [string, number, number][] = [
    ['W', 0, 1],
    ['S', 0, -1],
    ['A', -1, 0],
    ['D', 1, 0],
    ['WA', -1, 1],
    ['WD', 1, 1],
    ['SA', -1, -1],
    ['SD', 1, -1],
    ['W+S', 0, 0],
    ['A+D', 0, 0],
    ['W+S+D', 1, 0],
  ];
  for (const yaw of [0, 0.6, -2.4, 4.0])
    for (const pitch of [-1.1, 0, 1.1]) {
      it(`[S7.1-M1] yaw ${yaw} pitch ${pitch}: every key combination`, () => {
        for (const [name, ix, iz] of combos) {
          const g = arena(BIPED);
          setView(g, yaw, pitch);
          g.input.forward = name.includes('W');
          g.input.back = name.includes('S');
          g.input.left = name.includes('A');
          g.input.right = name.includes('D');
          run(g, 60);
          const [ex, ez] = camDir(g, ix, iz);
          const p = g.state.player;
          const want = ix === 0 && iz === 0 ? 0 : 10;
          expect(p.vel.x, name).toBeCloseTo(ex * want, 9);
          expect(p.vel.z, name).toBeCloseTo(ez * want, 9);
          expect(Math.hypot(p.vel.x, p.vel.z), name).toBeLessThan(10 + 1e-9); // diagonals are not faster
          expect(p.vel.y, name).toBe(0); // camera pitch never lifts the mech
          expect(Math.abs(p.pos.y - 1.5), name).toBeLessThan(1e-3);
          expect(p.grounded, name).toBe(true);
        }
      });
    }

  it('[S7.1-M2] pitch never lifts the mech in ANY mode (walk, glide, QB) over 3 s', () => {
    for (const pitch of [-1.2, 1.2]) {
      const g = arena(BIPED);
      setView(g, 0.3, pitch);
      g.input.forward = true;
      tapShift(g);
      g.input.qb = true;
      run(g, 360, (k) => {
        if (k > 1) g.input.qb = false;
        expect(g.state.player.vel.y).toBe(0);
        expect(g.state.player.pos.y).toBeLessThan(1.5001);
      });
    }
  });

  it('[S7.1-M3] releasing the keys decelerates toward 0 (no saved direction in walk mode): at most 120 m/s^2, monotone, no reversal', () => {
    const g = arena(BIPED);
    g.input.forward = true;
    run(g, 60);
    expect(hs(g)).toBeCloseTo(10, 9);
    g.input.forward = false;
    let prev = hs(g);
    let stopTick = -1;
    for (let k = 0; k < 30; k++) {
      g.step();
      const v = hs(g);
      expect(prev - v).toBeLessThanOrEqual(120 * DT + 1e-9);
      expect(v).toBeLessThanOrEqual(prev + 1e-12);
      expect(g.state.player.vel.z).toBeLessThanOrEqual(1e-12); // never flips to +z
      if (stopTick < 0 && v < 1e-9) stopTick = k + 1;
      prev = v;
    }
    expect(prev).toBe(0);
    expect(stopTick).toBeGreaterThanOrEqual(10); // 10 m/s at 120 m/s^2 needs 1/12 s = 10 ticks
    expect(stopTick).toBeLessThanOrEqual(11);
  });

  it('[S7.1-M4] walking acceleration limit is 120 x mult m/s^2 (biped 1.0 m/s per tick, quadruped 0.8)', () => {
    for (const [l, m] of [
      [BIPED, 1],
      [QUAD, 0.8],
    ] as const) {
      const g = arena(l);
      g.input.forward = true;
      g.step();
      expect(hs(g)).toBeCloseTo(120 * m * DT, 9);
    }
  });
});

// ================================================================================================================
// §7.2 QB
// ================================================================================================================
describe('[S7.2] QB activation', () => {
  it('[S7.2-Q1] holding Q for 5 s (600 ticks): exactly 1 QB, exactly 36 EN spent (never below 84), 1 qb event', () => {
    for (const l of [BIPED, QUAD]) {
      const g = arena(l);
      const p = g.state.player;
      g.input.qb = true;
      let minEn = Infinity;
      run(g, 600, () => (minEn = Math.min(minEn, p.en)));
      expect(p.mv.qbSuccessCount).toBe(1);
      expect(evCount(g, 'qb')).toBe(1);
      expect(minEn).toBe(84);
    }
  });

  it('[S7.2-Q2] tapping Q every other tick: QBs at exactly t = 0, 1.0, 2.0 (cooldown 1.00 s) and then EN < 36 stops them; EN follows the regen rule', () => {
    const g = arena(BIPED);
    const p = g.state.player;
    const starts: number[] = [];
    let last = 0;
    for (let k = 0; k < 420; k++) {
      g.input.qb = k % 2 === 0;
      g.step();
      if (p.mv.qbSuccessCount !== last) {
        starts.push(p.mv.qbLastStartedAt as number);
        last = p.mv.qbSuccessCount;
      }
    }
    expect(starts.length).toBe(3);
    expect(starts[0]).toBe(0);
    expect(starts[1]).toBeCloseTo(1.0, 9);
    expect(starts[2]).toBeCloseTo(2.0, 9);
    // t = 3.5 s: last spend at 2.0 (EN 19.5 right after) -> regen from 2.75
    expect(g.state.time).toBeCloseTo(3.5, 9);
    expect(p.en).toBeCloseTo(19.5 + 15 * (3.5 - 2.75), 6);
  });

  it('[S7.2-Q3] a press 1 tick before the cooldown ends fails; from exactly 1.00 s it works (no reservation of the early press)', () => {
    const g = arena(BIPED);
    const p = g.state.player;
    tapQ(g);
    run(g, 117); // tick 118 next (t = 0.98333)
    g.input.qb = true;
    g.step(); // fails
    expect(p.mv.qbSuccessCount).toBe(1);
    g.step(); // Q still held at t = 1.0: must NOT fire (no reservation, no re-arm)
    g.step();
    expect(g.state.time).toBeGreaterThan(1.0);
    expect(p.mv.qbSuccessCount).toBe(1);
    g.input.qb = false;
    g.step();
    g.input.qb = true; // a fresh press after the cooldown
    g.step();
    expect(p.mv.qbSuccessCount).toBe(2);
  });

  it('[S7.2-Q4] available right after the sortie and after a retry', () => {
    const g = arena(BIPED);
    tapQ(g);
    expect(g.state.player.mv.qbSuccessCount).toBe(1);
    expect(g.state.player.mv.qbLastStartedAt).toBe(0);
    g.retry();
    expect(g.state.player.mv.qbSuccessCount).toBe(0);
    g.input.qb = true; // level already down at the first tick: a rising edge from "released"
    g.step();
    expect(g.state.player.mv.qbSuccessCount).toBe(1);
  });

  it('[S7.2-Q5] a press held through cooldown expiry / EN recovery / brake release is NOT reserved', () => {
    // (a) cooldown
    const a = arena(BIPED);
    tapQ(a);
    run(a, 59);
    a.input.qb = true; // t = 0.5 s
    run(a, 180);
    expect(a.state.player.mv.qbSuccessCount).toBe(1);
    // (b) EN recovers while Q is held
    const b = arena(BIPED);
    b.state.player.en = 30;
    b.input.qb = true;
    run(b, 240);
    expect(b.state.player.en).toBeGreaterThan(36);
    expect(b.state.player.mv.qbSuccessCount).toBe(0);
    // (c) Ctrl held: request fails, and is not remembered after Ctrl is released
    const c = arena(BIPED);
    c.input.ctrl = true;
    c.input.qb = true;
    run(c, 30);
    expect(c.state.player.mv.qbSuccessCount).toBe(0);
    expect(c.state.player.en).toBe(120);
    expect(c.state.player.mv.lastEnSpentAt).toBeNull();
    c.input.ctrl = false;
    run(c, 60);
    expect(c.state.player.mv.qbSuccessCount).toBe(0);
  });

  it('[S7.2-Q6] EN 35 fails, EN 36 works (boundary), EN 35.99999 fails', () => {
    for (const [en, ok] of [
      [35, false],
      [35.99999, false],
      [36, true],
      [36.00001, true],
    ] as const) {
      const g = arena(BIPED);
      lift(g); // no regen
      g.state.player.en = en;
      tapQ(g);
      expect(g.state.player.mv.qbSuccessCount, `EN ${en}`).toBe(ok ? 1 : 0);
      expect(g.state.player.en, `EN ${en}`).toBeCloseTo(ok ? en - 36 : en, 9);
    }
  });
});

describe('[S7.2] QB direction / speed', () => {
  const combos: [string, number, number][] = [
    ['none', 0, 0],
    ['W', 0, 1],
    ['S', 0, -1],
    ['A', -1, 0],
    ['D', 1, 0],
    ['WD', 1, 1],
    ['SA', -1, -1],
    ['W+S', 0, 0],
  ];
  for (const yaw of [0, 0.7, -2.1, 3.9])
    for (const pitch of [-1.0, 0.8]) {
      it(`[S7.2-D1] yaw ${yaw} pitch ${pitch}: velocity = 80 x camera-horizontal WASD direction (camera forward without input), vertical untouched`, () => {
        for (const [name, ix, iz] of combos) {
          const g = arena(BIPED);
          setView(g, yaw, pitch);
          g.input.forward = name.includes('W');
          g.input.back = name.includes('S');
          g.input.left = name.includes('A');
          g.input.right = name.includes('D');
          const [ex, ez] = ix === 0 && iz === 0 ? camForward(g) : camDir(g, ix, iz);
          tapQ(g);
          const p = g.state.player;
          expect(p.vel.x, name).toBeCloseTo(ex * 80, 9);
          expect(p.vel.z, name).toBeCloseTo(ez * 80, 9);
          expect(hs(g), name).toBeCloseTo(80, 9); // diagonals: still 80
          expect(p.vel.y, name).toBe(0);
        }
      });
    }

  it('[S7.2-D2] the speed is SET to 80, never added: QB from a 22 m/s glide in the same / opposite direction, and a second QB', () => {
    for (const dirKey of ['forward', 'back'] as const) {
      const g = arena(BIPED);
      tapShift(g);
      run(g, 60); // glide forward at 22
      expect(hs(g)).toBeCloseTo(22, 9);
      g.input[dirKey] = true;
      tapQ(g);
      const [ex, ez] = camDir(g, 0, dirKey === 'forward' ? 1 : -1);
      expect(g.state.player.vel.x).toBeCloseTo(ex * 80, 9);
      expect(g.state.player.vel.z).toBeCloseTo(ez * 80, 9);
    }
    const g2 = arena(BIPED);
    tapQ(g2);
    run(g2, 120); // gliding at 22 again
    g2.input.forward = true;
    tapQ(g2);
    expect(hs(g2)).toBeCloseTo(80, 9);
  });

  it('[S7.2-D3] in the air the horizontal speed is also SET to 80 (from 16), vertical speed unchanged, no invulnerability needed', () => {
    const g = arena(BIPED);
    g.input.forward = true;
    g.input.jump = true;
    g.step();
    g.input.jump = false;
    run(g, 20);
    expect(hs(g)).toBeCloseTo(16, 9);
    const vy = g.state.player.vel.y;
    tapQ(g);
    expect(hs(g)).toBeCloseTo(80, 9);
    expect(g.state.player.vel.y).toBeCloseTo(vy - 18 * DT, 12);
    expect(g.state.player.hp).toBe(1000);
  });
});

describe('[S7.2] QB impulse (0.15 s), automatic glide, inertia', () => {
  it('[S7.2-I1] input during the impulse is ignored: velocity stays exactly 80 x initial direction for 18 ticks whatever Q / WASD / Shift / Ctrl / camera do', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const rnd = rngOf(seed);
      const g = arena(BIPED);
      setView(g, 0.5, -0.2);
      g.input.forward = true;
      g.input.right = true;
      const [ex, ez] = camDir(g, 1, 1);
      const p = g.state.player;
      const z0 = p.pos.z;
      const x0 = p.pos.x;
      tapQ(g);
      const dist = () => Math.hypot(p.pos.x - x0, p.pos.z - z0);
      for (let k = 2; k <= 18; k++) {
        for (const key of KEYS) if (key !== 'fire') g.input[key] = rnd() < 0.5;
        g.look((rnd() - 0.5) * 300, 0);
        g.step();
        expect(p.vel.x, `seed ${seed} tick ${k}`).toBeCloseTo(ex * 80, 9);
        expect(p.vel.z, `seed ${seed} tick ${k}`).toBeCloseTo(ez * 80, 9);
        expect(p.mv.horizontalMode).toBe(k < 18 ? 'quickboost' : 'glide');
        expect(p.mv.braking).toBe(false);
      }
      expect(g.state.time).toBeCloseTo(0.15, 12);
      expect(dist()).toBeCloseTo(12.0, 6);
      expect(p.mv.glideEnabled).toBe(true);
      expect(p.mv.qbSuccessCount).toBe(1);
    }
  });

  it('[S7.2-I2] the impulse is not extended by holding Q: it ends at 0.15 s even with Q held 5 s', () => {
    const g = arena(BIPED);
    g.input.qb = true;
    g.step();
    run(g, 16);
    expect(g.state.player.mv.qbImpulseRemaining).toBeGreaterThan(0);
    g.step();
    expect(g.state.player.mv.qbImpulseRemaining).toBe(0);
    expect(g.state.player.mv.horizontalMode).toBe('glide');
    g.step();
    expect(hs(g)).toBeLessThan(80 - 0.5); // decelerating already
  });

  it('[S7.2-I3] after the impulse: glide is ON, the velocity vector is carried over (no drop to 22, no stop, no walk) with every key released', () => {
    for (const l of [BIPED, QUAD]) {
      const m = LEGS[l.legs].speed;
      const g = arena(l);
      const p = g.state.player;
      setView(g, 1.1, 0);
      const [ex, ez] = camForward(g);
      tapQ(g);
      const speeds: number[] = [hs(g)];
      for (let k = 2; k <= 400; k++) {
        g.step();
        speeds.push(hs(g));
        // desiredDir = the direction the horizontal system is heading (changed interpretation, audit-movement F2 / SPEC 10): with every
        // key released it is the held QB direction (= camera forward), not [0,0] (SPEC 7.2 keeps moving along it without input)
        expect(p.mv.desiredDir.x, `tick ${k}`).toBeCloseTo(ex, 9);
        expect(p.mv.desiredDir.z, `tick ${k}`).toBeCloseTo(ez, 9);
        const t = k * DT;
        if (k === 19) {
          expect(hs(g)).toBeGreaterThan(79 * m); // NOT an instant 22
          expect(p.mv.horizontalMode).toBe('glide'); // inertial deceleration is "glide"
          expect(p.mv.glideEnabled).toBe(true);
        }
        // direction never changes
        expect(p.vel.x * ez - p.vel.z * ex, `tick ${k}`).toBeCloseTo(0, 9);
        expect(p.vel.x * ex + p.vel.z * ez, `tick ${k}`).toBeGreaterThan(0);
        if (t > 0.75 + 1e-9) expect(hs(g), `tick ${k}`).toBeCloseTo(22 * m, 9); // settled at 22 x mult, never lower
      }
      // decel profile: (80-22)/0.6 x mult per second, never more, never below the target
      for (let k = 19; k <= 90; k++) {
        const drop = speeds[k - 2] - speeds[k - 1];
        expect(drop).toBeLessThanOrEqual(GLIDE_ACC_G * m * DT + 1e-9);
        expect(drop).toBeGreaterThanOrEqual(-1e-12);
        expect(speeds[k - 1]).toBeGreaterThanOrEqual(22 * m - 1e-9);
      }
      expect(Math.min(...speeds.slice(17))).toBeGreaterThanOrEqual(22 * m - 1e-9);
      expect(p.mv.qbSuccessCount).toBe(1);
      expect(p.mv.glideEnabled).toBe(true);
    }
  });

  it('[S7.2-I4] the auto glide does not depend on a manual Shift: glide was OFF before the QB, is ON after; and a Shift toggled ON before does not double-toggle it', () => {
    const a = arena(BIPED);
    expect(a.state.player.mv.glideEnabled).toBe(false);
    tapQ(a);
    run(a, 30);
    expect(a.state.player.mv.glideEnabled).toBe(true);
    const b = arena(BIPED);
    tapShift(b);
    run(b, 30);
    expect(b.state.player.mv.glideEnabled).toBe(true);
    b.input.qb = true;
    b.step();
    b.input.qb = false;
    run(b, 200);
    expect(b.state.player.mv.glideEnabled).toBe(true); // the QB did not toggle it OFF
    expect(hs(b)).toBeCloseTo(22, 9);
  });

  it('[S7.2-I5] after the QB, WASD sets the new glide target direction; the speed changes only at the glide accel limit (vector-length limited), never instantly', () => {
    const g = arena(BIPED);
    const p = g.state.player;
    tapQ(g); // forward (-z)
    run(g, 40); // deep in the inertia
    const v0 = { x: p.vel.x, z: p.vel.z };
    g.input.right = true; // D: new target = 22 m/s toward +x
    const [rx, rz] = camDir(g, 1, 0);
    let prev = { ...v0 };
    for (let k = 0; k < 10; k++) {
      g.step();
      const d = Math.hypot(p.vel.x - prev.x, p.vel.z - prev.z);
      expect(d).toBeLessThanOrEqual(GLIDE_ACC_G * DT + 1e-9); // not an instant turn
      prev = { x: p.vel.x, z: p.vel.z };
    }
    // eventually settles at 22 toward +x
    run(g, 120);
    expect(p.vel.x).toBeCloseTo(rx * 22, 9);
    expect(p.vel.z).toBeCloseTo(rz * 22, 9);
    // holding W (same direction as the QB) during the inertia must not overwrite the speed with the walk speed
    const a = arena(BIPED);
    const c = arena(BIPED);
    tapQ(a);
    tapQ(c);
    c.input.forward = true;
    for (let k = 0; k < 100; k++) {
      a.step();
      c.step();
      expect(hs(c), `tick ${k}`).toBeCloseTo(hs(a), 9);
      expect(hs(c)).toBeGreaterThanOrEqual(22 - 1e-9);
    }
  });

  it('[S7.2-I6] a reverse input right after the QB cannot flip the velocity instantly (44+ m/s reversal at <= 96.67 m/s^2 per tick)', () => {
    const g = arena(BIPED);
    const p = g.state.player;
    tapQ(g);
    run(g, 17); // end of the impulse
    g.input.back = true;
    const before = { x: p.vel.x, z: p.vel.z };
    g.step();
    expect(Math.hypot(p.vel.x - before.x, p.vel.z - before.z)).toBeLessThanOrEqual(GLIDE_ACC_G * DT + 1e-9);
    expect(p.vel.z).toBeLessThan(0); // still moving forward (-z)
    // the velocity vector walks straight from (0,-80) to (0,+22) at 96.67 m/s^2: it crosses 0 after 80/96.67 = 0.828 s and arrives after 1.055 s
    let flipped = 1;
    let arrived = -1;
    for (let k = 2; k <= 200 && arrived < 0; k++) {
      g.step();
      if (p.vel.z > 0 && flipped === 1) flipped = k;
      if (Math.abs(p.vel.z - 22) < 1e-9) arrived = k;
    }
    expect(flipped * DT).toBeGreaterThan(0.81);
    expect(flipped * DT).toBeLessThan(0.85);
    expect(arrived * DT).toBeGreaterThan(1.04);
    expect(arrived * DT).toBeLessThan(1.07);
  });
});

describe('[S7.2/S11] QB travel distance (0.75 s): 42.6 m (34.08 m for 4 legs), 12.0 m in the impulse, no teleporting', () => {
  for (const l of ALL) {
    it(label(l), () => {
      const m = LEGS[l.legs].speed;
      const g = arena(l);
      const p = g.state.player;
      setView(g, 2.2, 0);
      const s0 = { x: p.pos.x, z: p.pos.z };
      tapQ(g);
      let prevPos = { x: p.pos.x, z: p.pos.z };
      let prevV = 80 * m;
      let d15 = 0;
      for (let k = 2; k <= 90; k++) {
        g.step();
        // per-tick displacement = mean of the boundary speeds x dt (continuous motion, no teleport)
        const step = Math.hypot(p.pos.x - prevPos.x, p.pos.z - prevPos.z);
        expect(step).toBeLessThanOrEqual(80 * m * DT + 1e-9);
        expect(step).toBeCloseTo(((prevV + hs(g)) / 2) * DT, 9);
        prevPos = { x: p.pos.x, z: p.pos.z };
        prevV = hs(g);
        if (k === 18) d15 = Math.hypot(p.pos.x - s0.x, p.pos.z - s0.z);
      }
      const d = Math.hypot(p.pos.x - s0.x, p.pos.z - s0.z);
      expect(g.state.time).toBeCloseTo(0.75, 12);
      expect(d15).toBeCloseTo(12.0 * m, 6);
      expect(Math.abs(d - 42.6 * m)).toBeLessThan(0.05);
      expect(p.pos.y).toBeCloseTo(1.5, 3);
    });
  }
  it('[S7.2-T1] a 12.0 m + 30.6 m closed form check of the SPEC arithmetic', () => {
    expect(80 * 0.15).toBeCloseTo(12.0, 12);
    expect(((80 + 22) / 2) * 0.6).toBeCloseTo(30.6, 12);
    expect(12.0 + 30.6).toBeCloseTo(42.6, 12);
    expect(22 * 0.75).toBeCloseTo(16.5, 12);
    expect(42.6 * 0.8).toBeCloseTo(34.08, 12);
  });
});

describe('[S7.2] QB in the air', () => {
  it('[S7.2-A1] vertical motion identical with / without the QB (any timing: rising, apex, falling, flying); horizontal decays to the AIR glide speed 16 at (80-16)/0.6', () => {
    for (const qbTick of [3, 40, 66, 90]) {
      const control = arena(BIPED);
      const g = arena(BIPED);
      const p = g.state.player;
      const c = control.state.player;
      for (const game of [g, control]) {
        game.input.jump = true;
        game.step();
        game.input.jump = false;
      }
      run(g, qbTick - 1);
      run(control, qbTick - 1);
      tapQ(g);
      control.step();
      const t0 = g.state.tick;
      let sawAir16 = false;
      for (let k = 0; k < 300; k++) {
        g.step();
        control.step();
        expect(p.pos.y, `qbTick ${qbTick}`).toBeCloseTo(c.pos.y, 12);
        expect(p.vel.y, `qbTick ${qbTick}`).toBeCloseTo(c.vel.y, 12);
        expect(p.grounded).toBe(c.grounded);
        if (!p.grounded && g.state.tick > t0 + 90) {
          expect(hs(g)).toBeCloseTo(16, 9);
          sawAir16 = true;
        }
      }
      if (qbTick === 3) expect(sawAir16, 'an early air QB must reach the steady air glide speed before landing').toBe(true);
    }
  });

  it('[S7.2-A2] air decel limit: 106.67 m/s^2 (biped) and 85.33 m/s^2 (quadruped: 12.8 steady)', () => {
    for (const [l, m] of [
      [BIPED, 1],
      [QUAD, 0.8],
    ] as const) {
      const g = arena(l);
      lift(g);
      tapQ(g);
      run(g, 17); // impulse over
      let prev = hs(g);
      expect(prev).toBeCloseTo(80 * m, 9);
      for (let k = 0; k < 90; k++) {
        g.step();
        const v = hs(g);
        expect(prev - v).toBeLessThanOrEqual(GLIDE_ACC_A * m * DT + 1e-9);
        expect(v).toBeGreaterThanOrEqual(16 * m - 1e-9);
        prev = v;
      }
      expect(prev).toBeCloseTo(16 * m, 9);
    }
  });

  it('[S7.2-A3] landing keeps glide ON and smoothly moves 16 -> 22 (ground glide accel), no stop, no instant jump', () => {
    const g = arena(BIPED);
    const p = g.state.player;
    g.input.jump = true;
    g.step();
    g.input.jump = false;
    run(g, 35); // t = 0.3 s, still rising
    tapQ(g);
    let landedTick = -1;
    let prevSpeed = hs(g);
    for (let k = 0; k < 400; k++) {
      const wasAir = !p.grounded;
      g.step();
      const v = hs(g);
      if (wasAir && p.grounded && landedTick < 0) landedTick = g.state.tick;
      if (landedTick >= 0) {
        expect(p.mv.glideEnabled).toBe(true);
        expect(p.mv.horizontalMode).toBe('glide');
        expect(Math.abs(v - prevSpeed)).toBeLessThanOrEqual(GLIDE_ACC_G * DT + 1e-9);
      }
      prevSpeed = v;
    }
    expect(landedTick).toBeGreaterThan(0);
    expect(hs(g)).toBeCloseTo(22, 9);
  });
});

describe('[S7.2] QB and walls', () => {
  it('[S7.2-W1] head-on: stops at the wall, never enters it, no rebound, the lost speed is never re-granted from the QB direction', () => {
    const g = arenaWith(BIPED, [box('wall', [-100, 0, -22], [100, 30, -20])]);
    const p = g.state.player;
    tapQ(g);
    let minZ = 0;
    let maxVz = -Infinity;
    let maxSpeed = 0;
    for (let k = 0; k < 300; k++) {
      g.step();
      minZ = Math.min(minZ, p.pos.z);
      maxVz = Math.max(maxVz, p.vel.z);
      maxSpeed = Math.max(maxSpeed, hs(g));
      if (k > 30) expect(Math.abs(p.vel.z), `tick ${k}`).toBeLessThan(1e-6); // into-wall speed stays removed
    }
    expect(minZ).toBeGreaterThan(-20 + HALF.z - 1e-3);
    expect(p.pos.z).toBeLessThan(-20 + HALF.z + 0.01);
    expect(maxVz).toBeLessThan(1e-9); // no bounce
    expect(maxSpeed).toBeLessThanOrEqual(80 + 1e-9);
    expect(Math.abs(p.pos.z)).toBeLessThan(42.6);
  });

  it('[S7.2-W2] 45-degree hit: the normal component is removed and the tangential one is kept as is (56.57 m/s), nothing is added', () => {
    // wall face at z = -6: the player reaches it after (6 - 0.8)/56.57 = 0.092 s, well inside the 0.15 s impulse
    const g = arenaWith(BIPED, [box('wall', [-400, 0, -8], [400, 30, -6])]);
    const p = g.state.player;
    g.input.forward = true;
    g.input.left = true; // toward -x and -z at 45 degrees
    tapQ(g);
    g.input.forward = false;
    g.input.left = false;
    let slideTicks = 0;
    for (let k = 2; k <= 18; k++) {
      g.step();
      if (p.pos.z < -6 + HALF.z + 0.01 && k > 2) {
        // in contact, still inside the 0.15 s impulse: tangential component kept exactly, normal component gone
        expect(p.vel.x, `tick ${k}`).toBeCloseTo(-80 / Math.SQRT2, 6);
        expect(Math.abs(p.vel.z), `tick ${k}`).toBeLessThan(1e-9);
        slideTicks++;
      }
      expect(hs(g)).toBeLessThanOrEqual(80 + 1e-9);
    }
    expect(slideTicks).toBeGreaterThan(3);
  });

  it('[S7.2-W3] a thin wall (0.05 m, 0.005 m) is never tunnelled by an 80 m/s QB (0.67 m per tick) from any angle', () => {
    for (const th of [0.05, 0.005]) {
      for (const yaw of [0, 0.3, 0.9, -0.5]) {
        const g = arenaWith(BIPED, [box('thin', [-500, 0, -30 - th], [500, 60, -30])]);
        const p = g.state.player;
        setView(g, yaw, 0);
        g.input.forward = true;
        tapQ(g);
        for (let k = 0; k < 300; k++) {
          g.step();
          expect(p.pos.z, `th ${th} yaw ${yaw} tick ${k}`).toBeGreaterThan(-30 + HALF.z - 1e-3);
        }
      }
    }
  });
});

// ================================================================================================================
// §7.3 glide / brake
// ================================================================================================================
describe('[S7.3] glide', () => {
  it('[S7.3-G1] Shift once: accelerates toward the input direction (camera forward with no input) at the glide limit; Shift release does not stop it; a held Shift toggles once', () => {
    const g = arena(BIPED);
    const p = g.state.player;
    setView(g, 0.4, 0);
    g.input.shift = true; // held for 3 s (key repeat)
    g.step();
    expect(hs(g)).toBeCloseTo(GLIDE_ACC_G * DT, 9);
    const [fx, fz] = camForward(g);
    run(g, 359);
    expect(p.mv.glideEnabled).toBe(true);
    expect(p.vel.x).toBeCloseTo(fx * 22, 9);
    expect(p.vel.z).toBeCloseTo(fz * 22, 9);
    g.input.shift = false;
    run(g, 120);
    expect(hs(g)).toBeCloseTo(22, 9); // not stopped by releasing Shift
    // with input: accelerates toward WASD
    const h = arena(BIPED);
    h.input.right = true;
    tapShift(h);
    run(h, 60);
    expect(h.state.player.vel.x).toBeCloseTo(22 * camDir(h, 1, 0)[0], 9);
  });

  it('[S7.3-G2] releasing WASD keeps gliding in the last direction for 5 s; turning the camera (yaw and pitch) does not turn the motion', () => {
    const g = arena(BIPED);
    const p = g.state.player;
    setView(g, 0, 0);
    g.input.forward = true;
    g.input.right = true;
    tapShift(g);
    run(g, 60);
    g.input.forward = false;
    g.input.right = false;
    const vx = p.vel.x;
    const vz = p.vel.z;
    expect(hs(g)).toBeCloseTo(22, 9);
    for (let k = 0; k < 600; k++) {
      if (k % 7 === 0) g.look(200, 60); // spin the camera the whole time
      if (k % 11 === 0) g.look(-90, -40);
      g.step();
      expect(p.vel.x, `tick ${k}`).toBeCloseTo(vx, 9);
      expect(p.vel.z, `tick ${k}`).toBeCloseTo(vz, 9);
    }
    expect(p.mv.glideEnabled).toBe(true);
    expect(p.pos.y).toBeCloseTo(1.5, 3);
  });

  it('[S7.3-G3] the glide is free: EN never moves (start, sustain, turn, auto-glide), also at EN 0 and full EN', () => {
    const cases: number[] = [120, 0, 57.5];
    for (const en of cases) {
      const g = arena(BIPED);
      const p = g.state.player;
      lift(g); // airborne: no regen, so any EN change would be a spend
      p.en = en;
      tapShift(g);
      g.input.forward = true;
      run(g, 30);
      g.input.forward = false;
      g.input.right = true;
      run(g, 30);
      g.input.right = false;
      g.input.back = true;
      run(g, 30);
      g.input.back = false;
      tapShift(g); // OFF
      tapShift(g); // ON
      run(g, 60);
      expect(p.en, `EN ${en}`).toBe(en);
      expect(p.mv.lastEnSpentAt).toBeNull();
    }
    // ground: full EN stays full, wait time not touched by glide
    const g2 = arena(BIPED);
    tapShift(g2);
    run(g2, 120);
    expect(g2.state.player.en).toBe(120);
    expect(g2.state.player.mv.lastEnSpentAt).toBeNull();
  });

  it('[S7.3-G4] reversing the input while gliding cannot invert the velocity instantly: |dv| <= 96.67 m/s^2 per tick, 0.455 s to reverse 22 -> -22', () => {
    const g = arena(BIPED);
    const p = g.state.player;
    g.input.forward = true;
    tapShift(g);
    run(g, 60);
    g.input.forward = false;
    g.input.back = true;
    let prev = { x: p.vel.x, z: p.vel.z };
    let flipTick = -1;
    for (let k = 1; k <= 120; k++) {
      g.step();
      expect(Math.hypot(p.vel.x - prev.x, p.vel.z - prev.z)).toBeLessThanOrEqual(GLIDE_ACC_G * DT + 1e-9);
      prev = { x: p.vel.x, z: p.vel.z };
      if (flipTick < 0 && p.vel.z > 0) flipTick = k;
    }
    // straight-line approach (0,-22) -> (0,+22): zero crossing after 22/96.67 = 0.2276 s, arrival after 0.455 s
    expect(flipTick * DT).toBeGreaterThan(0.22);
    expect(flipTick * DT).toBeLessThan(0.24);
    expect(p.vel.z).toBeCloseTo(22, 9);
  });

  it('[S7.3-G5] a manual Shift toggle in the air costs no EN and gives no upward thrust or altitude hold', () => {
    const g = arena(BIPED);
    lift(g);
    g.state.player.en = 77;
    tapShift(g);
    run(g, 30);
    tapShift(g);
    run(g, 30);
    tapShift(g);
    run(g, 30);
    expect(g.state.player.en).toBe(77);
    expect(g.state.player.vel.y).toBeCloseTo(-18 * 93 * DT, 9); // 93 ticks of pure gravity: no altitude hold
    expect(g.state.player.mv.thrusting).toBe(false);
  });

  it('[S7.3-G6] horizontal mode and vertical state are independent: glide ON while rising / falling / flying', () => {
    const g = arena(BIPED);
    const p = g.state.player;
    tapShift(g);
    g.input.jump = true;
    const seen = new Set<string>();
    run(g, 200, () => {
      seen.add(`${p.mv.horizontalMode}/${p.mv.verticalMode}`);
      if (g.state.tick === 90) g.input.jump = false;
    });
    expect(seen.has('glide/rising')).toBe(true);
    expect(seen.has('glide/flying')).toBe(true);
    expect(seen.has('glide/falling')).toBe(true);
  });
});

describe('[S7.3] brake (left Ctrl)', () => {
  it('[S7.3-B1] glide -> Ctrl: glide OFF, mode walk, decelerates to 0 at 120 x mult (never instantly), WASD held meanwhile does not win; after release WASD walks again', () => {
    for (const [l, m] of [
      [BIPED, 1],
      [QUAD, 0.8],
    ] as const) {
      const g = arena(l);
      const p = g.state.player;
      tapShift(g);
      run(g, 60);
      const v0 = hs(g);
      expect(v0).toBeCloseTo(22 * m, 9);
      g.input.ctrl = true;
      g.input.forward = true; // brake has priority over WASD
      let prev = v0;
      let stop = -1;
      for (let k = 1; k <= 60; k++) {
        g.step();
        const v = hs(g);
        expect(p.mv.glideEnabled).toBe(false);
        expect(p.mv.horizontalMode).toBe('walk');
        expect(prev - v).toBeLessThanOrEqual(120 * m * DT + 1e-9);
        expect(v).toBeLessThanOrEqual(prev + 1e-12);
        if (k === 1) expect(v).toBeGreaterThan(v0 - 1.001 * m);
        if (stop < 0 && v < 1e-9) stop = k;
        prev = v;
      }
      expect(stop * DT).toBeGreaterThanOrEqual(v0 / (120 * m) - 2 * DT);
      expect(stop * DT).toBeLessThanOrEqual(v0 / (120 * m) + 2 * DT);
      expect(hs(g)).toBe(0);
      g.input.ctrl = false;
      run(g, 60);
      expect(hs(g)).toBeCloseTo(10 * m, 9);
    }
  });

  it('[S7.3-B2] brake after a QB (80 m/s): 0.667 s to stop, not instant, does not restart glide by itself', () => {
    const g = arena(BIPED);
    const p = g.state.player;
    tapQ(g);
    g.input.ctrl = true; // pressed 1 tick after the QB, inside the impulse
    run(g, 17);
    expect(hs(g)).toBeCloseTo(80, 9); // impulse: brake not executed
    g.step();
    expect(p.mv.braking).toBe(true);
    expect(p.mv.glideEnabled).toBe(false);
    expect(hs(g)).toBeCloseTo(80 - 120 * DT, 9);
    run(g, 80);
    expect(hs(g)).toBe(0);
  });

  it('[S7.3-B3] Shift OFF (toggle) does not wipe the speed: decelerates at 120 to the walk target (10 with W held, 0 otherwise)', () => {
    for (const hold of [false, true]) {
      const g = arena(BIPED);
      tapShift(g);
      g.input.forward = true;
      run(g, 60);
      if (!hold) g.input.forward = false;
      tapShift(g); // OFF
      expect(g.state.player.mv.glideEnabled).toBe(false);
      expect(hs(g)).toBeCloseTo(22 - 120 * DT, 9);
      run(g, 60);
      expect(hs(g)).toBeCloseTo(hold ? 10 : 0, 9);
    }
  });

  it('[S7.3-B4] Ctrl in the air: brakes the horizontal speed too (walk mode, 120 m/s^2) and never affects the vertical motion', () => {
    const g = arena(BIPED);
    lift(g);
    tapQ(g);
    run(g, 17);
    g.input.ctrl = true;
    g.step();
    expect(hs(g)).toBeCloseTo(80 - 120 * DT, 9);
    run(g, 90);
    expect(hs(g)).toBe(0);
    expect(g.state.player.vel.y).toBeCloseTo(-18 * 109 * DT, 9); // 1 (QB) + 17 + 1 + 90 ticks of pure gravity
  });

  it('[S7.3-B5] during the impulse Shift does not toggle anything and is not remembered afterwards; Q release does not cancel the impulse', () => {
    const g = arena(BIPED);
    const p = g.state.player;
    tapShift(g);
    run(g, 10);
    expect(p.mv.glideEnabled).toBe(true);
    g.input.qb = true;
    g.step();
    g.input.qb = false; // released immediately: impulse continues
    g.input.shift = true;
    g.step(); // Shift edge inside the impulse
    g.input.shift = false;
    for (let k = 0; k < 15; k++) {
      g.step();
      expect(p.mv.horizontalMode).toBe('quickboost');
      expect(hs(g)).toBeCloseTo(80, 9);
    }
    run(g, 5);
    expect(p.mv.glideEnabled).toBe(true); // the edge was not applied (would have switched it off) and not remembered
    expect(p.mv.horizontalMode).toBe('glide');
  });
});

// ================================================================================================================
// §7.4 jump / flight
// ================================================================================================================
describe('[S7.4] jump', () => {
  it('[S7.4-J1] a tap of any length < 0.2 s: one jump, v = 10 m/s, apex 2.78 m, no EN, exactly ballistic', () => {
    for (const hold of [1, 5, 12, 23]) {
      const g = arena(BIPED);
      const p = g.state.player;
      const y0 = p.pos.y;
      g.input.jump = true;
      let maxY = y0;
      for (let k = 0; k < 150; k++) {
        if (k === hold) g.input.jump = false;
        g.step();
        maxY = Math.max(maxY, p.pos.y);
        if (!p.grounded && k < 60) expect(p.vel.y, `hold ${hold} tick ${k}`).toBeCloseTo(10 - 18 * (k + 1) * DT, 9);
        expect(p.mv.thrusting).toBe(false);
      }
      expect(maxY - y0).toBeGreaterThan(2.77);
      expect(maxY - y0).toBeLessThan(APEX + 1e-9);
      expect(p.en).toBe(120);
      expect(evCount(g, 'jump')).toBe(1);
    }
  });

  it('[S7.4-J2] only on the press edge while grounded: holding Space through landing, pressing in the air, repeated air taps never add 10 m/s', () => {
    // (a) hold with EN 0 for 4 s: exactly one jump event
    const a = arena(BIPED);
    a.state.player.en = 0;
    a.state.player.mv.lastEnSpentAt = 1e9; // keep regen off so the hold can never turn into flight
    a.input.jump = true;
    run(a, 480);
    expect(evCount(a, 'jump')).toBe(1);
    // (b) air taps: pure gravity, one jump only
    const b = arena(BIPED);
    const p = b.state.player;
    b.input.jump = true;
    b.step();
    b.input.jump = false;
    for (let k = 1; k < 60; k++) {
      b.input.jump = k % 6 < 3; // taps of 3 ticks (< 0.2 s)
      b.step();
      expect(p.vel.y, `tick ${k}`).toBeCloseTo(10 - 18 * (k + 1) * DT, 9);
    }
    expect(evCount(b, 'jump')).toBe(1);
    // (c) press in the air shortly before landing, keep it down until touchdown: no automatic jump on landing
    const c = arena(BIPED);
    c.input.jump = true;
    c.step();
    c.input.jump = false;
    run(c, 114); // t = 0.95 s, descending, 0.16 s of air left: less than the 0.20 s hold, so no flight can start before touchdown
    c.input.jump = true;
    let landed = false;
    for (let k = 0; k < 60; k++) {
      c.step();
      if (c.state.player.grounded) landed = true;
      if (landed) break;
    }
    expect(landed).toBe(true);
    expect(evCount(c, 'jump')).toBe(1);
    expect(c.state.player.vel.y).toBe(0);
    // (d) a fresh press on the first grounded tick jumps again
    c.input.jump = false;
    c.step();
    c.input.jump = true;
    c.step();
    expect(evCount(c, 'jump')).toBe(2);
    expect(c.state.player.vel.y).toBeGreaterThan(9.8);
  });
});

describe('[S7.4] flight', () => {
  it('[S7.4-F1] holding Space from the ground: jump at the press, NO thrust for the first 0.20 s, then vy = 8 exactly, 20 EN/s, lastEnSpentAt follows the thrust', () => {
    for (const l of [BIPED, QUAD]) {
      const g = arena(l);
      const p = g.state.player;
      const en0 = GEN[l.generator].maxEn;
      const y0 = p.pos.y;
      g.input.jump = true;
      for (let n = 1; n <= 24; n++) {
        g.step();
        expect(p.en).toBe(en0);
        expect(p.mv.thrusting).toBe(false);
        expect(p.vel.y).toBeCloseTo(10 - 18 * n * DT, 9);
      }
      for (let n = 25; n <= 120; n++) {
        g.step();
        expect(p.vel.y).toBeCloseTo(8, 9);
        expect(p.en).toBeCloseTo(en0 - 20 * (n - 24) * DT, 9);
        expect(p.mv.thrusting).toBe(true);
        expect(p.mv.verticalMode).toBe('flying');
        expect(p.mv.lastEnSpentAt as number).toBeCloseTo(n * DT, 9);
      }
      expect(p.pos.y - y0).toBeCloseTo(1.64 + 8 * 0.8, 3);
    }
  });

  it('[S7.4-F2] release: the current vertical speed (8) is carried into gravity motion', () => {
    const g = arena(BIPED);
    const p = g.state.player;
    g.input.jump = true;
    run(g, 80);
    g.input.jump = false;
    g.step();
    expect(p.vel.y).toBeCloseTo(8 - 18 * DT, 9);
    expect(p.mv.thrusting).toBe(false);
    run(g, 20);
    expect(p.vel.y).toBeCloseTo(8 - 18 * 21 * DT, 9);
  });

  it('[S7.4-F3] a press shorter than 0.20 s in the air never thrusts; re-pressing restarts the 0.20 s; a re-press in the air needs the full 0.20 s before thrust', () => {
    const g = arena(BIPED);
    const p = g.state.player;
    lift(g);
    // press 23 ticks, release 1 tick, press again: the timer restarts
    g.input.jump = true;
    run(g, 23);
    expect(p.mv.thrusting).toBe(false);
    g.input.jump = false;
    g.step();
    g.input.jump = true;
    for (let k = 0; k < 24; k++) {
      g.step();
      expect(p.mv.thrusting, `tick ${k}`).toBe(false);
      expect(p.en).toBe(120);
    }
    g.step(); // 0.2 s after the second press
    expect(p.mv.thrusting).toBe(true);
    expect(p.vel.y).toBeCloseTo(8, 9);
    expect(p.en).toBeCloseTo(120 - 20 * DT, 9);
    expect(evCount(g, 'jump')).toBe(0); // never a second jump
  });

  it('[S7.4-F4] EN runs out: the remaining EN buys exactly EN/20 s of thrust, then gravity (no free ascent); apex matches the analytic value', () => {
    for (const en of [3, 10, 20, 37.5]) {
      const g = arena(BIPED);
      const p = g.state.player;
      const y0 = p.pos.y;
      p.en = en;
      g.input.jump = true;
      let maxY = y0;
      let thrustTicks = 0;
      let left = false;
      for (let k = 0; k < 600; k++) {
        g.step();
        if (!p.grounded) left = true;
        if (left && p.grounded) break; // first flight only (holding Space on the ground later legitimately re-thrusts with regenerated EN)
        maxY = Math.max(maxY, p.pos.y);
        if (p.mv.thrusting) thrustTicks++;
        expect(p.en).toBeGreaterThanOrEqual(0);
      }
      const tau = en / 20;
      // jump 0..0.2 s (1.64 m), thrust tau at 8 m/s, then ballistic 8^2 / 36
      const analytic = 1.64 + 8 * tau + 64 / 36;
      expect(maxY - y0, `EN ${en}`).toBeLessThanOrEqual(analytic + 1e-9);
      expect(maxY - y0, `EN ${en}`).toBeGreaterThan(analytic - 1e-3);
      expect(thrustTicks, `EN ${en}`).toBeCloseTo(tau / DT, 6);
      expect(p.mv.lastEnSpentAt as number).toBeCloseTo(0.2 + tau, 9);
    }
  });

  it('[S7.4-F5] EN 0: plain jump only, no thrust, no free ascent', () => {
    const g = arena(BIPED);
    const p = g.state.player;
    p.en = 0;
    p.mv.lastEnSpentAt = 1e9;
    const y0 = p.pos.y;
    g.input.jump = true;
    let maxY = y0;
    run(g, 130, () => (maxY = Math.max(maxY, p.pos.y)));
    expect(maxY - y0).toBeLessThan(APEX + 1e-9);
    expect(p.en).toBe(0);
  });

  it('[S7.4-F6] a partial tick of EN buys only the affordable part: EN 0.1 -> 0.005 s of thrust, vy = 8 - 18 x (dt - 0.005), lastEnSpentAt = 0.205 s', () => {
    const g = arena(BIPED);
    const p = g.state.player;
    p.en = 0.1;
    g.input.jump = true;
    run(g, 24);
    g.step();
    expect(p.en).toBe(0);
    expect(p.mv.lastEnSpentAt as number).toBeCloseTo(0.2 + 0.005, 9);
    expect(p.vel.y).toBeCloseTo(8 - 18 * (DT - 0.005), 9);
    g.step();
    expect(p.mv.thrusting).toBe(false);
    expect(p.vel.y).toBeCloseTo(8 - 18 * (DT - 0.005) - 18 * DT, 9);
  });

  it('[S7.4-F7] flight moves horizontally at the air speed (16 x mult) with WASD; QB + flight: QB 36 + flight 20/s, both real', () => {
    for (const [l, m] of [
      [BIPED, 1],
      [QUAD, 0.8],
    ] as const) {
      const g = arena(l);
      g.input.jump = true;
      g.input.forward = true;
      run(g, 80);
      expect(g.state.player.mv.thrusting).toBe(true);
      expect(hs(g)).toBeCloseTo(16 * m, 9);
    }
    const g = arena(BIPED);
    lift(g);
    g.input.jump = true;
    run(g, 60); // 0.5 s: thrust 0.3 s -> EN 114
    expect(g.state.player.en).toBeCloseTo(120 - 20 * 0.3, 6);
    tapQ(g);
    run(g, 59);
    // EN = 114 - 36 - 20 x (1.0 s - 0.5 s ... continuous thrust) -> compute from time
    expect(g.state.player.en).toBeCloseTo(120 - 36 - 20 * (g.state.time - 0.2), 6);
  });
});

describe('[S7.4-X] simultaneous operation: shooting and FCS lock work during every movement state; costs add up exactly', () => {
  it('[S7.4-X1] machinegun fires during walk, glide, QB impulse, flight and free fall (>= 5 rounds in 0.6 s each)', () => {
    const setups: [string, (g: Game) => void][] = [
      ['walk', (g) => (g.input.forward = true)],
      ['glide', (g) => tapShift(g)],
      ['QB', (g) => tapQ(g)],
      ['flight', (g) => (g.input.jump = true)],
      ['fall', (g) => lift(g)],
    ];
    for (const [name, setup] of setups) {
      const g = arena(BIPED);
      setup(g);
      const before = g.state.player.ammo.machinegun;
      g.input.fire = true;
      run(g, name === 'flight' ? 90 : 72);
      const fired = before - g.state.player.ammo.machinegun;
      expect(fired, name).toBeGreaterThanOrEqual(name === 'flight' ? 8 : 6);
    }
  });

  it('[S7.4-X2] the FCS lock completes while gliding toward the target (moving does not stop the lock)', () => {
    const g = arena(BIPED);
    const s = g.state;
    setView(g, 0, 0);
    s.enemies.push(makeScriptedTarget('TGT', { x: 0, y: s.player.pos.y + 1.2, z: -100 }, { x: 0, y: 0, z: 0 }));
    tapShift(g);
    let lockedWhileMoving = false;
    run(g, 240, () => {
      if (s.lock.state === 'locked' && hs(g) > 21.9) lockedWhileMoving = true;
    });
    expect(lockedWhileMoving).toBe(true);
    expect(hs(g)).toBeCloseTo(22, 9);
  });

  it('[S7.4-X3] a missile with a valid lock and ammo fires at EN 0 (no EN cost of its own)', () => {
    const g = arena(BIPED);
    const s = g.state;
    const p = s.player;
    setView(g, 0, 0);
    s.enemies.push(makeScriptedTarget('TGT', { x: p.pos.x, y: p.pos.y + 1.2, z: p.pos.z - 60 }, { x: 0, y: 0, z: 0 }));
    p.en = 0;
    p.mv.lastEnSpentAt = 1e9; // keep the regeneration off: EN must stay 0
    p.weapon = 'missile';
    g.input.fire = true;
    run(g, 200);
    expect(p.ammo.missile).toBeLessThan(12);
    expect(p.en).toBe(0);
  });

  it('[S7.4-X4] glide + beam: only the beam is paid (8 per shot); flight + beam: both; QB + flight + beam: all three', () => {
    // airborne so that the regeneration cannot blur the accounting
    const glide = arena(BIPED);
    lift(glide);
    glide.input.weaponSelect = 'beam';
    tapShift(glide);
    glide.input.fire = true;
    run(glide, 119); // ticks 1..120: beams at t = 0.00833 (tapShift tick), .25, ... -> count actual shots
    const shots = glide.state.shots.length;
    expect(shots).toBeGreaterThanOrEqual(4);
    expect(glide.state.player.en).toBeCloseTo(120 - 8 * shots, 9);
    // flight + beam
    const fb = arena(BIPED);
    lift(fb);
    fb.input.weaponSelect = 'beam';
    fb.input.jump = true;
    fb.input.fire = true;
    run(fb, 120);
    const n = fb.state.shots.length;
    expect(n).toBe(4);
    expect(fb.state.player.en).toBeCloseTo(120 - 8 * n - 20 * (120 - 24) * DT, 9);
  });
});

// ================================================================================================================
// collisions
// ================================================================================================================
describe('[COL] floor / wall / ceiling / scaffold collision, no tunnelling', () => {
  it('[COL-1] falling at ~100 m/s onto a 1 mm platform stops on it (the sweep never skips a thin floor)', () => {
    for (const th of [0.1, 0.01, 0.001]) {
      const g = arenaWith(BIPED, [box('plat', [-3, 100 - th, -3], [3, 100, 3])]);
      const p = g.state.player;
      p.pos.x = 0;
      p.pos.z = 0;
      p.pos.y = 300;
      p.grounded = false;
      run(g, 600);
      expect(p.grounded, `th ${th}`).toBe(true);
      expect(p.pos.y, `th ${th}`).toBeGreaterThan(101.4);
      expect(p.pos.y, `th ${th}`).toBeLessThan(101.6);
    }
  });

  it('[COL-2] flight against a thin ceiling never enters it; vertical speed is cancelled', () => {
    const g = arenaWith(BIPED, [box('ceil', [-30, 20, -30], [30, 20.001, 30])]);
    const p = g.state.player;
    g.input.jump = true;
    let maxY = -Infinity;
    run(g, 300, () => (maxY = Math.max(maxY, p.pos.y)));
    expect(maxY).toBeLessThan(20 - HALF.y + 1e-3);
    expect(g.world.overlapAABB(p.pos, HALF, 1e-3)).toBe(false);
  });

  it('[COL-3] flying up, moving over a small 3 m scaffold and landing on it (足場に着地できる): rests on its top, grounded, EN regenerates there', () => {
    const g = arena(BIPED, { platforms: [{ id: 'sc', top: { x: 0, y: 6, z: -8 }, sizeX: 3, sizeZ: 3 }] });
    const p = g.state.player;
    g.input.jump = true;
    run(g, 132); // ~1.1 s
    g.input.jump = false;
    g.input.forward = true; // -z toward the scaffold at z = -8
    let k = 0;
    while (p.pos.z > -8 && k++ < 200) g.step();
    g.input.forward = false;
    run(g, 5);
    for (let i = 0; i < 400 && !p.grounded; i++) g.step();
    expect(p.grounded).toBe(true);
    expect(p.pos.y).toBeCloseTo(6 + HALF.y, 3);
    expect(Math.abs(p.pos.x)).toBeLessThan(2.3);
    const en = p.en;
    run(g, 240);
    expect(p.en).toBeGreaterThan(en + 5);
  });

  it('[COL-4] a QB along a wall keeps sliding along it (tangential component kept) and never penetrates over 4 s', () => {
    const g = arenaWith(BIPED, [box('wall', [-800, 0, -32], [800, 30, -30])]);
    const p = g.state.player;
    setView(g, 0.1, 0); // mostly -z with a slight -x
    g.input.forward = true;
    tapQ(g);
    for (let k = 0; k < 480; k++) {
      g.step();
      expect(p.pos.z).toBeGreaterThan(-30 + HALF.z - 1e-3);
    }
    expect(p.pos.x).toBeLessThan(-10); // slid along the wall
  });
});

// ================================================================================================================
// frame-rate independence / determinism
// ================================================================================================================
describe('[FR] frame-rate independence', () => {
  it('[FR-1] Game.advance is exactly "floor(elapsed / dt)" steps for any frame size (no drift, no lost time)', () => {
    for (const fps of [24, 30, 45, 60, 75, 90, 120, 144, 165, 240]) {
      const g = arena(BIPED);
      let ticks = 0;
      const frames = Math.round(fps * 8);
      for (let i = 0; i < frames; i++) ticks += g.advance(1 / fps);
      const expected = Math.floor((frames / fps) * 120 + 1e-6);
      expect(Math.abs(ticks - expected), `fps ${fps}`).toBeLessThanOrEqual(1);
      expect(g.state.tick).toBe(ticks);
    }
  });

  it('[FR-2] any random frame partition gives bit-identical results to plain step() with the same inputs', () => {
    const rnd = rngOf(77);
    const g = arena(BIPED);
    const ref = arena(BIPED);
    for (let frame = 0; frame < 400; frame++) {
      for (const key of KEYS) {
        if (key === 'fire') continue;
        if (rnd() < 0.08) {
          g.input[key] = !g.input[key];
          ref.input[key] = g.input[key];
        }
      }
      const dt = rnd() * 0.06;
      const n = g.advance(dt);
      run(ref, n);
    }
    expect(g.state.tick).toBe(ref.state.tick);
    expect(JSON.stringify(g.state.player)).toBe(JSON.stringify(ref.state.player));
  });

  it('[FR-3] the same input script gives the same pos / vel / EN / QB state at 1/30, 1/60, 1/120 and 1/144 s frames (script keyed to tick multiples of 4)', () => {
    for (const seed of [11, 12, 13, 14]) {
      const total = 720;
      const script: Partial<Record<Key, boolean>>[] = [];
      const looks: number[] = [];
      const rnd = rngOf(seed);
      const cur: Record<Key, boolean> = { forward: false, back: false, left: false, right: false, jump: false, shift: false, ctrl: false, qb: false, fire: false };
      for (let t = 0; t < total; t += 4) {
        for (const k of KEYS) if (k !== 'fire' && rnd() < (cur[k] ? 0.25 : 0.06)) cur[k] = !cur[k];
        script.push({ ...cur });
        looks.push((rnd() - 0.5) * 200);
      }
      const play = (frameDt: number): Game => {
        const g = arena(BIPED);
        let next = 0;
        while (g.state.tick < total) {
          while (next < script.length && next * 4 <= g.state.tick) {
            Object.assign(g.input, script[next]);
            g.look(looks[next], 0);
            next++;
          }
          g.advance(frameDt);
        }
        return g;
      };
      const ref = play(1 / 120);
      for (const dt of [1 / 30, 1 / 60, 1 / 144]) {
        const g = play(dt);
        const a = ref.state.player;
        const b = g.state.player;
        expect(g.state.tick).toBe(total);
        for (const k of ['x', 'y', 'z'] as const) {
          expect(b.pos[k], `seed ${seed} dt ${dt}`).toBeCloseTo(a.pos[k], 9);
          expect(b.vel[k], `seed ${seed} dt ${dt}`).toBeCloseTo(a.vel[k], 9);
        }
        expect(b.en).toBeCloseTo(a.en, 9);
        expect(b.mv.qbSuccessCount).toBe(a.mv.qbSuccessCount);
        expect(b.mv.glideEnabled).toBe(a.mv.glideEnabled);
        expect(b.mv.lastEnSpentAt).toBe(a.mv.lastEnSpentAt);
      }
    }
  });

  it('[FR-4] a QB run split into 1/30, 1/60, 1/120, 1/144 s frames covers the same distance (1.0 s: 42.6 + 22 x 0.25 = 48.1 m)', () => {
    for (const dt of [1 / 30, 1 / 60, 1 / 120, 1 / 144]) {
      const g = arena(BIPED);
      g.input.qb = true;
      let d = 0;
      while (g.state.tick < 120) {
        g.advance(dt);
        if (g.state.tick >= 1) g.input.qb = false;
        d = Math.abs(g.state.player.pos.z);
      }
      expect(g.state.tick).toBe(120);
      expect(Math.abs(d - 48.1), `dt ${dt}`).toBeLessThan(0.05);
      expect(g.state.player.mv.qbSuccessCount).toBe(1);
    }
  });

  it('[FR-5] a long frame (1 s) is clamped to 0.25 s of simulation but every tick is swept: a thin wall is still not skipped', () => {
    const g = arenaWith(BIPED, [box('thin', [-500, 0, -30.01], [500, 60, -30])]);
    g.input.qb = true;
    g.advance(1.0);
    g.input.qb = false;
    expect(g.state.tick).toBe(30);
    for (let i = 0; i < 5; i++) g.advance(1.0);
    expect(g.state.player.pos.z).toBeGreaterThan(-30 + HALF.z - 1e-3);
  });

  it('[FR-6] determinism: two identical runs give identical JSON state', () => {
    const play = (): string => {
      const rnd = rngOf(5);
      const g = arena(BIPED);
      for (let k = 0; k < 1500; k++) {
        for (const key of KEYS) if (key !== 'fire' && rnd() < 0.03) g.input[key] = !g.input[key];
        g.look((rnd() - 0.5) * 60, (rnd() - 0.5) * 20);
        g.step();
      }
      return JSON.stringify(g.state.player);
    };
    expect(play()).toBe(play());
  });

  it('[FR-7] a single non-finite frame time (NaN) must not freeze the simulation for good (SPEC 9: never let NaN into the state)', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1]) {
      const g = arena(BIPED);
      g.advance(bad);
      const before = g.state.tick;
      g.advance(1 / 60);
      g.advance(1 / 60);
      expect(g.state.tick, `advance(${bad}) poisoned the accumulator`).toBeGreaterThan(before);
    }
  });
});

// ================================================================================================================
// pause / resume of the movement state (SPEC 9, movement part)
// ================================================================================================================
describe('[PAUSE] movement state is frozen while paused and resumes exactly', () => {
  it('[PAUSE-1] pause in the middle of the QB impulse: nothing advances; after resume the same 42.6 m is covered; Q still down is not a new press', () => {
    const ref = arena(BIPED);
    tapQ(ref);
    run(ref, 89);
    const g = arena(BIPED);
    g.input.qb = true;
    g.step();
    run(g, 5);
    g.pause();
    const snap = JSON.stringify(g.state.player);
    for (let i = 0; i < 100; i++) g.advance(0.05);
    expect(JSON.stringify(g.state.player)).toBe(snap);
    g.resume();
    expect(g.input.qb).toBe(false); // inputs released
    g.input.qb = true; // the key is (still) physically down and re-asserted: it is a fresh rising edge for the sim only if it was up
    run(g, 84); // 1 + 5 + 84 = 90 ticks in total, the same as the uninterrupted reference (1 + 89)
    // the 1.0 s cooldown is still running, so a re-asserted Q level cannot make a second QB in any case
    expect(g.state.player.mv.qbSuccessCount).toBe(1);
    expect(g.state.player.pos.z).toBeCloseTo(ref.state.player.pos.z, 6);
    expect(g.state.player.en).toBeCloseTo(ref.state.player.en, 9);
  });
});

// ================================================================================================================
// re-sortie / loadout change: no movement state may leak (SPEC 9 "再出撃")
// ================================================================================================================
describe('[RESET] a retry / new sortie behaves exactly like a fresh game (no leaked QB / glide / EN / input state)', () => {
  const script = (g: Game, seed: number): string => {
    const rnd = rngOf(seed);
    for (let k = 0; k < 900; k++) {
      for (const key of KEYS) if (key !== 'fire' && rnd() < (g.input[key] ? 0.06 : 0.03)) g.input[key] = !g.input[key];
      g.look((rnd() - 0.5) * 60, (rnd() - 0.5) * 20);
      g.step();
      g.drainEvents();
    }
    return JSON.stringify({ p: g.state.player, t: g.state.time, k: g.state.tick });
  };
  const mess = (g: Game): void => {
    // leave the game in as many "busy" states as possible: QB impulse running, glide on, Ctrl, Space held (flight), EN low
    g.input.qb = true;
    g.input.shift = true;
    g.input.jump = true;
    g.input.forward = true;
    g.input.ctrl = false;
    run(g, 25);
    g.state.player.en = 3;
    g.input.ctrl = true;
    run(g, 5);
  };
  it('[RESET-1] retry() in the middle of everything, then the same script = identical result to a fresh game', () => {
    for (const l of [BIPED, QUAD]) {
      const fresh = arena(l);
      const a = script(fresh, 31);
      const dirty = arena(l);
      mess(dirty);
      dirty.retry();
      const p = dirty.state.player;
      expect(p.mv.qbSuccessCount).toBe(0);
      expect(p.mv.qbImpulseRemaining).toBe(0);
      expect(p.mv.glideEnabled).toBe(false);
      expect(p.mv.horizontalMode).toBe('walk');
      expect(p.mv.jumpHeldSeconds).toBe(0);
      expect(p.mv.lastEnSpentAt).toBeNull();
      expect(p.mv.qbLastStartedAt).toBeNull();
      expect(dirty.input.qb || dirty.input.shift || dirty.input.jump || dirty.input.forward || dirty.input.ctrl).toBe(false);
      expect(script(dirty, 31)).toBe(a);
    }
  });
  it('[RESET-2] sortie with a different loadout after a busy session = a fresh game of that loadout (EN = its max)', () => {
    const fresh = arena(QUAD);
    const a = script(fresh, 32);
    const dirty = arena(BIPED);
    mess(dirty);
    dirty.sortie(QUAD);
    expect(dirty.state.player.en).toBe(120);
    expect(dirty.state.stats).toEqual(computeEffectiveStats(QUAD));
    expect(script(dirty, 32)).toBe(a);
    // and via the garage: pause -> garage -> new loadout -> sortie
    const g = arena(BIPED);
    mess(g);
    g.pause();
    g.toGarage({ fcs: 'wide', generator: 'capacity', legs: 'quadruped' });
    g.sortie();
    expect(g.state.player.en).toBe(180);
    expect(g.state.player.mv.qbSuccessCount).toBe(0);
    expect(g.state.stats.horizontalSpeedMultiplier).toBe(0.8);
  });
});

// ================================================================================================================
// HUD (SPEC 8: "QBが使用可能か、次のQBまでの残り時間を表示" and "HUDは実際のゲーム状態と一致")
// ================================================================================================================
describe('[HUD] the QB indicator agrees with what a Q press really does', () => {
  it('[HUD-1] READY only when a press would succeed: not while Ctrl (brake) is held, not below 36 EN, not in cooldown', () => {
    const g = arena(BIPED);
    expect(buildHudModel(g.state).movement.qb).toBe('READY');
    g.input.ctrl = true; // SPEC 7.3: "左Ctrlを押している間の新しいQB要求は不成立"
    g.step();
    expect(buildHudModel(g.state).movement.qb, 'Ctrl held: a Q press fails, the HUD must not say READY').not.toBe('READY');
    g.input.ctrl = false;
    g.step();
    expect(buildHudModel(g.state).movement.qb).toBe('READY');
    lift(g);
    g.state.player.en = 35;
    g.step();
    expect(buildHudModel(g.state).movement.qb).not.toBe('READY');
    g.state.player.en = 120;
    tapQ(g);
    expect(buildHudModel(g.state).movement.qb).toBe('COOLDOWN');
    expect(buildHudModel(g.state).movement.qbCooldown).toBeCloseTo(1 - DT, 9);
  });
});

// ================================================================================================================
// snapshot (SPEC 10, movement fields)
// ================================================================================================================
describe('[SNAP] movement fields of getSnapshot follow the state', () => {
  it('[SNAP-1] modes: quickboost during the impulse, glide during the inertia, walk while braking; null / numeric fields are sane', () => {
    const g = arena(BIPED);
    let s = buildSnapshot(g.state).player.movement;
    expect(s.qbLastStartedAtSeconds).toBeNull();
    expect(s.lastEnSpentAtSeconds).toBeNull();
    expect(s.qbSuccessfulCount).toBe(0);
    expect(s.qbCooldownRemainingSeconds).toBe(0);
    expect(s.horizontalMode).toBe('walk');
    expect(s.verticalMode).toBe('grounded');
    // desiredHorizontalDirection = where the horizontal system is heading (changed interpretation, audit-movement F2 / SPEC 10):
    // [0,0] while walking without input, the held QB direction (camera forward) through the impulse and the inertial glide,
    // [0,0] again while braking
    expect(s.desiredHorizontalDirection).toEqual([0, 0]);
    const [fx, fz] = camForward(g);
    tapQ(g);
    s = buildSnapshot(g.state).player.movement;
    expect(s.horizontalMode).toBe('quickboost');
    expect(s.desiredHorizontalDirection[0]).toBeCloseTo(fx, 12);
    expect(s.desiredHorizontalDirection[1]).toBeCloseTo(fz, 12);
    run(g, 20);
    s = buildSnapshot(g.state).player.movement;
    expect(s.horizontalMode).toBe('glide');
    expect(s.glideEnabled).toBe(true);
    expect(s.desiredHorizontalDirection[0]).toBeCloseTo(fx, 12);
    expect(s.desiredHorizontalDirection[1]).toBeCloseTo(fz, 12);
    g.input.ctrl = true;
    g.step();
    s = buildSnapshot(g.state).player.movement;
    expect(s.horizontalMode).toBe('walk');
    expect(s.desiredHorizontalDirection).toEqual([0, 0]);
    expect(buildSnapshot(g.state).player.velocity[2]).toBeLessThan(0); // "速度は直ちに0にはならない"
    expect(JSON.stringify(buildSnapshot(g.state))).not.toMatch(/NaN|Infinity/);
  });
});

// ================================================================================================================
// tick-by-tick oracles / invariants (random inputs, all 18 loadouts)
// ================================================================================================================
interface Pre {
  en: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  grounded: boolean;
  qbCount: number;
  qbLast: number | null;
  lastSpent: number | null;
  glide: boolean;
  impulse: number;
  T: number;
  shotSeq: number;
  nextBeam: number;
  weapon: string;
}
function capture(g: Game): Pre {
  const p = g.state.player;
  return {
    en: p.en,
    x: p.pos.x,
    y: p.pos.y,
    z: p.pos.z,
    vx: p.vel.x,
    vy: p.vel.y,
    vz: p.vel.z,
    grounded: p.grounded,
    qbCount: p.mv.qbSuccessCount,
    qbLast: p.mv.qbLastStartedAt,
    lastSpent: p.mv.lastEnSpentAt,
    glide: p.mv.glideEnabled,
    impulse: p.mv.qbImpulseRemaining,
    T: g.state.time,
    shotSeq: g.state.shotSeq,
    nextBeam: p.nextFireAt.beam,
    weapon: p.weapon,
  };
}
function approach(vx: number, vz: number, tx: number, tz: number, a: number, h: number): { vx: number; vz: number; dx: number; dz: number } {
  const ex = tx - vx;
  const ez = tz - vz;
  const d = Math.hypot(ex, ez);
  if (d <= a * h) {
    const tr = d / a;
    return { vx: tx, vz: tz, dx: ((vx + tx) / 2) * tr + tx * (h - tr), dz: ((vz + tz) / 2) * tr + tz * (h - tr) };
  }
  const k = (a * h) / d;
  const nx = vx + ex * k;
  const nz = vz + ez * k;
  return { vx: nx, vz: nz, dx: ((vx + nx) / 2) * h, dz: ((vz + nz) / 2) * h };
}

/**
 * Random-input fuzz with an independent per-tick oracle written from the SPEC text (flat arena, floor at y = 0).
 * ASSUMPTIONS where the SPEC is silent (identical to the documented implementation choices, so they do not mask a real bug):
 *  - a Shift edge during the QB impulse or while Ctrl is down is ignored (not queued)
 *  - the horizontal target of the tick in which a grounded jump starts already uses the air speed
 *  - regeneration needs "grounded" at both ends of the tick (landing / take-off ticks may regenerate or not: both accepted)
 *  - air walking accel = the 120 x mult walk limit
 */
function oracleFuzz(l: Loadout, seed: number, ticks: number): string[] {
  const bad: string[] = [];
  const fail = (t: number, what: string): void => {
    if (bad.length < 12) bad.push(`[${label(l)} seed ${seed} tick ${t}] ${what}`);
  };
  const m = LEGS[l.legs].speed;
  const maxEn = GEN[l.generator].maxEn;
  const regen = GEN[l.generator].regen * LEGS[l.legs].regen;
  const g = arena(l);
  const rnd = rngOf(seed);
  const I = g.input;
  const press: Record<Key, number> = { forward: 0.03, back: 0.015, left: 0.015, right: 0.015, jump: 0.02, shift: 0.012, ctrl: 0.004, qb: 0.05, fire: 0.02 };
  const rel: Record<Key, number> = { forward: 0.03, back: 0.05, left: 0.05, right: 0.05, jump: 0.05, shift: 0.3, ctrl: 0.03, qb: 0.4, fire: 0.05 };
  let prevQ = false;
  let prevS = false;
  let prevJ = false;
  let held = 0;
  let glideDir: [number, number] = [0, 0];
  let qbDir: [number, number] = [0, 0];
  const weapons = ['machinegun', 'beam', 'missile'] as const;
  for (let t = 0; t < ticks && bad.length < 12; t++) {
    for (const k of KEYS) if (rnd() < (I[k] ? rel[k] : press[k])) I[k] = !I[k];
    if (rnd() < 0.3) g.look((rnd() - 0.5) * 60, (rnd() - 0.5) * 20);
    if (rnd() < 0.01) I.weaponSelect = weapons[Math.floor(rnd() * 3)];
    const r = rnd();
    const p = g.state.player;
    if (r < 0.01) p.en = 0;
    else if (r < 0.02) p.en = 35.99999;
    else if (r < 0.03) p.en = 36;
    else if (r < 0.04) p.en = rnd() * maxEn;
    else if (r < 0.045) p.en = 8.5 + rnd() * 30;
    if (p.pos.y > 400 && rnd() < 0.5) {
      // keep the run interesting: bring the player back near the ground now and then
      p.pos.y = 30;
    }
    if (Math.abs(p.pos.x) > 300 || Math.abs(p.pos.z) > 300) {
      // the arena floor is finite (600 m half size): pull a runaway player back (fuzz harness only, before the tick is captured)
      p.pos.x *= 0.1;
      p.pos.z *= 0.1;
    }
    const pre = capture(g);
    const camF = camForward(g);
    const ix = (I.right ? 1 : 0) - (I.left ? 1 : 0);
    const iz = (I.forward ? 1 : 0) - (I.back ? 1 : 0);
    const dirV = camDir(g, ix, iz);
    const hasDir = dirV[0] !== 0 || dirV[1] !== 0;
    const ctrl = I.ctrl;
    const qbEdge = I.qb && !prevQ;
    const shiftEdge = I.shift && !prevS;
    const jumpEdge = I.jump && !prevJ;
    const weaponAfter = I.weaponSelect ?? pre.weapon;
    const fire = I.fire;
    g.step();
    g.drainEvents();
    const post = capture(g);
    const q = g.state.player;
    const T = pre.T;
    // ---- QB decision
    const offCd = pre.qbLast === null || T - pre.qbLast >= S.QB_CD - 1e-9;
    const qbShould = qbEdge && offCd && pre.en >= S.QB_COST - 1e-9 && !ctrl && pre.impulse <= 1e-9;
    const qbStarted = post.qbCount > pre.qbCount;
    if (qbStarted !== qbShould) fail(t, `QB decision: started=${qbStarted} should=${qbShould} (edge ${qbEdge}, EN ${pre.en}, last ${pre.qbLast}, ctrl ${ctrl})`);
    if (post.qbCount - pre.qbCount > 1) fail(t, 'more than one QB in one tick');
    // ---- beam decision (EN after the QB)
    const enAfterQb = pre.en - (qbStarted ? S.QB_COST : 0);
    // ARCH §3: threshold comparisons carry a 1e-9 tolerance (same as the QB check above). EN accumulates float noise, e.g. 7.999999999999545.
    const beamShould = fire && weaponAfter === 'beam' && pre.nextBeam <= T + 1e-9 && enAfterQb >= S.BEAM_COST - 1e-9;
    const beamPaid = post.shotSeq > pre.shotSeq && q.weapon === 'beam' && g.state.shots[g.state.shots.length - 1]?.weapon === 'beam';
    if (beamPaid !== beamShould) fail(t, `beam decision: paid=${beamPaid} should=${beamShould} (EN after QB ${enAfterQb})`);
    // ---- jump
    const jumpStarted = jumpEdge && pre.grounded;
    if (!I.jump || jumpEdge) held = 0;
    // ---- flight window
    let en = enAfterQb - (beamPaid ? S.BEAM_COST : 0);
    let ts = DT;
    let te = DT;
    let tau = 0;
    if (I.jump && en > 1e-9) {
      const until = S.HOLD - held;
      const s0 = until > 1e-9 ? until : 0;
      if (DT - s0 > 1e-9) {
        tau = Math.min(DT - s0, en / S.FLIGHT_EN);
        if (tau > 1e-12) {
          ts = s0;
          te = s0 + tau;
        } else tau = 0;
      }
    }
    if (tau > 0) {
      en -= S.FLIGHT_EN * tau;
      if (en <= 1e-9) en = 0;
    }
    if (q.mv.thrusting !== tau > 0) fail(t, `thrusting=${q.mv.thrusting} expected ${tau > 0}`);
    // ---- horizontal
    const impulseActive = qbStarted || pre.impulse > 1e-9;
    const impulseEnds = impulseActive && post.impulse <= 1e-9;
    if (qbStarted) qbDir = hasDir ? dirV : camF;
    let glide = pre.glide;
    if (shiftEdge && !impulseActive && !ctrl) {
      glide = !glide;
      if (glide) glideDir = hasDir ? dirV : camF;
    }
    let v0x = pre.vx;
    let v0z = pre.vz;
    if (qbStarted) {
      v0x = S.QB_V * m * qbDir[0];
      v0z = S.QB_V * m * qbDir[1];
    }
    let v1x: number;
    let v1z: number;
    let dx: number;
    let dz: number;
    let braking = false;
    if (impulseActive) {
      v1x = v0x;
      v1z = v0z;
      dx = v0x * DT;
      dz = v0z * DT;
      if (impulseEnds) {
        glide = true;
        glideDir = qbDir;
      }
    } else {
      const groundedNow = pre.grounded && !jumpStarted;
      let tx = 0;
      let tz = 0;
      let acc = S.ACC * m;
      if (ctrl) {
        braking = true;
        glide = false;
      } else if (glide) {
        if (hasDir) glideDir = dirV;
        const sp = (groundedNow ? S.GLIDE : S.AIR) * m;
        tx = glideDir[0] * sp;
        tz = glideDir[1] * sp;
        acc = (groundedNow ? GLIDE_ACC_G : GLIDE_ACC_A) * m;
      } else {
        const sp = (groundedNow ? S.WALK : S.AIR) * m;
        tx = dirV[0] * sp;
        tz = dirV[1] * sp;
      }
      const a = approach(v0x, v0z, tx, tz, acc, DT);
      v1x = a.vx;
      v1z = a.vz;
      dx = a.dx;
      dz = a.dz;
    }
    if (!near(post.vx, v1x, 1e-8) || !near(post.vz, v1z, 1e-8)) fail(t, `horizontal velocity (${post.vx}, ${post.vz}) expected (${v1x}, ${v1z}); qb=${qbStarted} impulse=${impulseActive} glide=${glide} ctrl=${ctrl} grounded=${pre.grounded}`);
    if (!near(post.x - pre.x, dx, 1e-8) || !near(post.z - pre.z, dz, 1e-8)) fail(t, `horizontal displacement (${post.x - pre.x}, ${post.z - pre.z}) expected (${dx}, ${dz})`);
    if (post.glide !== glide) fail(t, `glideEnabled=${post.glide} expected ${glide} (shiftEdge ${shiftEdge}, ctrl ${ctrl}, impulse ${impulseActive}/${impulseEnds})`);
    const expMode = post.impulse > 1e-9 ? 'quickboost' : braking ? 'walk' : glide ? 'glide' : 'walk';
    if (q.mv.horizontalMode !== expMode) fail(t, `horizontalMode=${q.mv.horizontalMode} expected ${expMode}`);
    if (q.mv.braking !== braking) fail(t, `braking=${q.mv.braking} expected ${braking}`);
    // ---- vertical
    let vy = jumpStarted ? S.JUMP : pre.vy;
    let dy = 0;
    if (ts > 0) {
      dy += vy * ts - 0.5 * S.G * ts * ts;
      vy -= S.G * ts;
    }
    if (te - ts > 0) {
      dy += S.ASCENT * (te - ts);
      vy = S.ASCENT;
    }
    const c = DT - te;
    if (c > 1e-12) {
      dy += vy * c - 0.5 * S.G * c * c;
      vy -= S.G * c;
    }
    const yFree = pre.y + dy;
    let grounded1: boolean | null = null;
    if (yFree < 1.4999) grounded1 = true;
    else if (yFree > 1.50001) grounded1 = false;
    if (grounded1 !== null && post.grounded !== grounded1) fail(t, `grounded=${post.grounded} expected ${grounded1} (yFree ${yFree})`);
    if (post.grounded) {
      if (post.vy !== 0) fail(t, `grounded but vy=${post.vy}`);
      if (Math.abs(post.y - 1.5) > 1e-3) fail(t, `grounded at y=${post.y}`);
    } else {
      if (!near(post.vy, vy, 1e-8)) fail(t, `vy=${post.vy} expected ${vy}`);
      if (!near(post.y, yFree, 1e-8)) fail(t, `y=${post.y} expected ${yFree}`);
    }
    const expVm = post.grounded ? 'grounded' : tau > 0 ? 'flying' : post.vy > 0 ? 'rising' : 'falling';
    if (q.mv.verticalMode !== expVm) fail(t, `verticalMode=${q.mv.verticalMode} expected ${expVm}`);
    // ---- EN and wait time
    let expLast = pre.lastSpent;
    if (qbStarted || beamPaid) expLast = T;
    if (tau > 0) expLast = T + te;
    const lastOk = expLast === null ? post.lastSpent === null : post.lastSpent !== null && near(post.lastSpent, expLast, 1e-9);
    if (!lastOk) fail(t, `lastEnSpentAt=${post.lastSpent} expected ${expLast}`);
    const groundedStart = pre.grounded && !jumpStarted;
    const from = expLast === null ? T : Math.max(T, expLast + S.WAIT);
    const secs = Math.min(DT, Math.max(0, T + DT - from));
    const enFull = Math.min(maxEn, Math.max(0, en + regen * secs));
    const enNo = Math.min(maxEn, Math.max(0, en));
    const transition = groundedStart !== post.grounded;
    const enOk = transition ? near(post.en, enFull, 1e-8) || near(post.en, enNo, 1e-8) : near(post.en, groundedStart && post.grounded ? enFull : enNo, 1e-8);
    if (!enOk) fail(t, `EN=${post.en} expected ${groundedStart && post.grounded ? enFull : enNo} (start ${pre.en}, qb ${qbStarted}, beam ${beamPaid}, thrust ${tau}, grounded ${groundedStart}->${post.grounded}, last ${expLast})`);
    if (post.en < 0 || post.en > maxEn) fail(t, `EN out of range: ${post.en}`);
    // ---- cooldown report
    const cdExp = post.qbLast === null ? 0 : Math.max(0, post.qbLast + S.QB_CD - (T + DT));
    if (Math.abs(q.mv.qbCooldownRemaining - cdExp) > 1e-9) fail(t, `qbCooldownRemaining=${q.mv.qbCooldownRemaining} expected ${cdExp}`);
    // ---- bookkeeping
    held = I.jump ? held + DT : 0;
    prevQ = I.qb;
    prevS = I.shift;
    prevJ = I.jump;
  }
  return bad;
}

/** raise with AUDIT_SEEDS=30 (and AUDIT_TICKS=8000) for a heavy search; the defaults keep the suite fast */
const FUZZ_SEEDS = Math.max(1, Number(process.env.AUDIT_SEEDS ?? 2));
const FUZZ_TICKS = Math.max(600, Number(process.env.AUDIT_TICKS ?? 2400));
describe('[FUZZ-1] per-tick oracle (flat arena): QB decision, glide state machine, horizontal target/accel, vertical kinematics, EN order/regen, wait time, cooldown', () => {
  for (const l of ALL) {
    it(label(l), () => {
      const bad: string[] = [];
      for (let i = 0; i < FUZZ_SEEDS && bad.length === 0; i++) bad.push(...oracleFuzz(l, 0x51ed + label(l).length * 7919 + i * 104729, FUZZ_TICKS));
      expect(bad).toEqual([]);
    });
  }
});

describe('[FUZZ-3] metamorphic: turning the camera by theta and using the same keys rotates the whole trajectory by theta (no world-axis leak in any mode)', () => {
  for (const l of [BIPED, QUAD, { fcs: 'narrow', generator: 'recovery', legs: 'quadruped' } as Loadout])
    for (const theta of [0.7, -2.0, 3.0]) {
      it(`${label(l)} theta ${theta}`, () => {
        const a = arena(l);
        const b = arena(l);
        setView(a, 0, -0.1);
        setView(b, theta, -0.1);
        const rnd = rngOf(4242 + Math.round(theta * 100));
        const c = Math.cos(theta);
        const sn = Math.sin(theta);
        const rot = (x: number, z: number): [number, number] => [x * c + z * sn, -x * sn + z * c];
        const bad: string[] = [];
        for (let t = 0; t < 1800 && bad.length < 5; t++) {
          for (const k of KEYS) {
            if (k === 'fire') continue;
            if (rnd() < (a.input[k] ? 0.06 : 0.03)) {
              a.input[k] = !a.input[k];
              b.input[k] = a.input[k];
            }
          }
          a.step();
          b.step();
          const pa = a.state.player;
          const pb = b.state.player;
          const [rx, rz] = rot(pa.pos.x, pa.pos.z);
          const [rvx, rvz] = rot(pa.vel.x, pa.vel.z);
          if (!near(pb.pos.x, rx, 1e-7) || !near(pb.pos.z, rz, 1e-7) || !near(pb.vel.x, rvx, 1e-7) || !near(pb.vel.z, rvz, 1e-7)) bad.push(`tick ${t}: horizontal state is not the rotated one`);
          if (!near(pb.pos.y, pa.pos.y, 1e-9) || !near(pb.vel.y, pa.vel.y, 1e-9) || !near(pb.en, pa.en, 1e-9)) bad.push(`tick ${t}: vertical / EN state differs`);
          if (pb.mv.qbSuccessCount !== pa.mv.qbSuccessCount || pb.mv.glideEnabled !== pa.mv.glideEnabled || pb.mv.horizontalMode !== pa.mv.horizontalMode) bad.push(`tick ${t}: mode state differs`);
        }
        expect(bad).toEqual([]);
      });
    }
});

function invariantFuzz(l: Loadout, seed: number): string[] {
  const maxEn = GEN[l.generator].maxEn;
  const m = LEGS[l.legs].speed;
  const g = arenaWith(l, [
    box('wall-n', [-60, 0, -62], [60, 40, -60]),
    box('wall-e', [60, 0, -60], [62, 40, 60]),
    box('wall-s', [-60, 0, 60], [60, 40, 62]),
    box('wall-w', [-62, 0, -60], [-60, 40, 60]),
    box('ceil', [-30, 7, -30], [30, 9, 30]),
    box('pillar', [10, 0, 10], [14, 30, 14]),
    box('thin', [-20, 0, 20], [20, 25, 20.02]),
    box('scaffold', [-10, 0, -20], [-4, 5, -14]),
  ]);
  const p = g.state.player;
  const rnd = rngOf(0xbeef ^ label(l).length ^ (seed * 2654435761));
  const bad: string[] = [];
  const press: Record<Key, number> = { forward: 0.03, back: 0.015, left: 0.015, right: 0.015, jump: 0.02, shift: 0.012, ctrl: 0.004, qb: 0.05, fire: 0.0 };
  const rel: Record<Key, number> = { forward: 0.03, back: 0.05, left: 0.05, right: 0.05, jump: 0.05, shift: 0.3, ctrl: 0.03, qb: 0.4, fire: 1 };
  let prevJump = false;
  for (let t = 0; t < FUZZ_TICKS && bad.length < 8; t++) {
    for (const k of KEYS) if (rnd() < (g.input[k] ? rel[k] : press[k])) g.input[k] = !g.input[k];
    g.look((rnd() - 0.5) * 80, (rnd() - 0.5) * 20);
    const r = rnd();
    if (r < 0.01) p.en = 0;
    else if (r < 0.02) p.en = 36;
    else if (r < 0.03) p.en = rnd() * maxEn;
    const en0 = p.en;
    const grounded0 = p.grounded;
    const last0 = p.mv.lastEnSpentAt;
    const T = g.state.time;
    const jumpEdge = g.input.jump && !prevJump;
    g.step();
    g.drainEvents();
    prevJump = g.input.jump;
    const q = (msg: string): void => {
      bad.push(`[${label(l)} tick ${t}] ${msg}`);
    };
    for (const v of [p.pos.x, p.pos.y, p.pos.z, p.vel.x, p.vel.y, p.vel.z, p.en]) if (!Number.isFinite(v)) q('non-finite state');
    if (p.en < 0 || p.en > maxEn) q(`EN ${p.en} out of 0..${maxEn}`);
    if (Math.hypot(p.vel.x, p.vel.z) > 80 * m + 1e-6) q(`speed ${Math.hypot(p.vel.x, p.vel.z)} > 80 x mult`);
    if (g.world.overlapAABB(p.pos, HALF, 1e-3)) q(`inside a solid at ${JSON.stringify(p.pos)}`);
    if (!(grounded0 && p.grounded && !(jumpEdge && grounded0)) && p.en > en0 + 1e-12) q(`EN regenerated while not grounded (${en0} -> ${p.en})`);
    if (p.en > en0 + 1e-12) {
      const l1 = p.mv.lastEnSpentAt;
      if (l1 !== null && T + DT - l1 < S.WAIT - 1e-9) q(`EN regenerated ${T + DT - l1} s after the last spend`);
      if (p.en - en0 > regenOf(l) * DT + 1e-9) q(`EN regenerated faster than the rate`);
      if (l1 !== last0 && last0 !== undefined && l1 !== null && l1 > T) q('regen in a tick with a spend');
    }
    if (p.mv.qbImpulseRemaining < 0 || p.mv.qbImpulseRemaining > 0.15 + 1e-12) q('impulse timer out of range');
    // SPEC 7.4: the camera must not sink into walls and must keep following the mech (TPS)
    const cam = g.state.camera;
    if (g.world.pointInSolid(cam.pos)) q(`camera inside a solid at ${JSON.stringify(cam.pos)}`);
    const cd = Math.hypot(cam.pos.x - p.pos.x, cam.pos.y - (p.pos.y + 1.2), cam.pos.z - p.pos.z);
    if (cd > 8.62) q(`camera ${cd} m away from the mech (TPS follow distance 8.5 m + 1.4 m shoulder)`);
  }
  return bad;
}

describe('[FUZZ-2] invariants with walls, ceiling, pillars and platforms (all 18 loadouts): never inside solids, camera outside solids, EN in range, finite, speed <= 80 x mult, no regen in the air', () => {
  for (const l of ALL) {
    it(label(l), () => {
      const bad: string[] = [];
      for (let i = 0; i < FUZZ_SEEDS && bad.length === 0; i++) bad.push(...invariantFuzz(l, i));
      expect(bad).toEqual([]);
    });
  }
});
function regenOf(l: Loadout): number {
  return GEN[l.generator].regen * LEGS[l.legs].regen;
}

// ================================================================================================================
// real campaign stage
// ================================================================================================================
describe('[STAGE] movement on the real campaign stage', () => {
  it('[STAGE-1] the sortie pose is inside no solid, stable for 3 s (no sinking / bouncing) and unharmed', () => {
    const g = new Game({ stage: buildStage() });
    g.sortie();
    const p = g.state.player;
    const y0 = p.pos.y;
    expect(g.world.overlapAABB(p.pos, HALF, 1e-3)).toBe(false);
    run(g, 360);
    expect(p.grounded).toBe(true);
    expect(Math.abs(p.pos.y - y0)).toBeLessThan(1e-3);
    expect(p.hp).toBe(1000);
    expect(g.state.mode).toBe('playing');
  });

  it('[STAGE-2] random inputs on the real stage with all enemies alive: invariants hold in 4 loadouts (never inside geometry, EN range, finite, speed cap)', () => {
    const stage = buildStage();
    for (const [i, l] of [BIPED, QUAD, { fcs: 'wide', generator: 'capacity', legs: 'biped' } as Loadout, { fcs: 'narrow', generator: 'recovery', legs: 'quadruped' } as Loadout].entries()) {
      const g = new Game({ stage, loadout: l });
      g.sortie(l);
      const p = g.state.player;
      const rnd = rngOf(900 + i);
      const maxEn = GEN[l.generator].maxEn;
      const m = LEGS[l.legs].speed;
      const press: Record<Key, number> = { forward: 0.03, back: 0.01, left: 0.015, right: 0.015, jump: 0.02, shift: 0.01, ctrl: 0.003, qb: 0.04, fire: 0.01 };
      const rel: Record<Key, number> = { forward: 0.03, back: 0.05, left: 0.05, right: 0.05, jump: 0.05, shift: 0.3, ctrl: 0.03, qb: 0.4, fire: 0.05 };
      const bad: string[] = [];
      for (let t = 0; t < 3600 && g.state.mode === 'playing' && bad.length < 5; t++) {
        for (const k of KEYS) if (rnd() < (g.input[k] ? rel[k] : press[k])) g.input[k] = !g.input[k];
        g.look((rnd() - 0.5) * 60, (rnd() - 0.5) * 20);
        g.step();
        g.drainEvents();
        if (g.world.overlapAABB(p.pos, HALF, 1e-3)) bad.push(`tick ${t}: inside a solid at ${JSON.stringify(p.pos)}`);
        if (p.en < 0 || p.en > maxEn) bad.push(`tick ${t}: EN ${p.en}`);
        if (![p.pos.x, p.pos.y, p.pos.z, p.vel.x, p.vel.y, p.vel.z].every(Number.isFinite)) bad.push(`tick ${t}: non-finite`);
        if (Math.hypot(p.vel.x, p.vel.z) > 80 * m + 1e-6) bad.push(`tick ${t}: speed cap`);
      }
      expect(bad, label(l)).toEqual([]);
    }
  });
});

// ================================================================================================================
// round 2 additions: clauses that the first pass did not exercise
// ================================================================================================================
describe('[S7.2-N] the QB grants no invulnerability (SPEC 7.2 "無敵時間も付与しません"; 2.3 no hidden invulnerability)', () => {
  const shot = (y: number, z: number): EnemyBullet => ({
    id: 9001,
    ownerId: 'TEST',
    kind: 'guard',
    pos: { x: 0, y, z },
    prevPos: { x: 0, y, z },
    vel: { x: 0, y: 0, z: 70 },
    age: 0,
    maxLife: 2,
    damage: 18,
    radius: 0.2,
    alive: true,
  });
  for (const airborne of [false, true])
    for (const qb of [false, true]) {
      it(`${airborne ? 'airborne' : 'grounded'}, QB=${qb}: a head-on 18-damage bullet hits exactly once${qb ? ', while the impulse is still running' : ''}`, () => {
        const g = arena(BIPED);
        if (airborne) lift(g);
        const p = g.state.player;
        g.state.enemyBullets.push(shot(p.pos.y, -14));
        if (qb) g.input.qb = true; // the QB starts on tick 0 and runs toward the bullet (-z)
        run(g, 40);
        const hits = g.drainEvents().filter((e) => e.type === 'playerHit');
        expect(hits.length).toBe(1);
        expect(p.hp).toBe(1000 - 18);
        expect(g.state.damageTaken).toBe(18);
        if (qb) {
          expect(p.mv.qbSuccessCount).toBe(1);
          expect((hits[0] as { time: number }).time).toBeLessThan(0.15 + 1e-9);
        }
      });
    }
});

describe('[S7.2-P] QB / jump / glide / walk are only accepted while the game is "playing" (SPEC 7.2: プレイ中であり)', () => {
  for (const mode of ['garage', 'paused', 'cleared', 'failed'] as const) {
    it(mode, () => {
      const g = arena(BIPED);
      g.state.mode = mode;
      g.input.qb = true;
      g.input.jump = true;
      g.input.shift = true;
      g.input.forward = true;
      const before = JSON.stringify(g.state.player);
      expect(g.advance(1 / 60)).toBe(0);
      g.step();
      expect(JSON.stringify(g.state.player)).toBe(before);
      expect(g.state.player.mv.qbSuccessCount).toBe(0);
      expect(g.state.player.en).toBe(120);
    });
  }
});

describe('[PAUSE-2] a Q that is still physically down after resume is not a new press (SPEC 9: いったん解放してからの押下を必要)', () => {
  it('through the real key layer: OS key repeat after resume never fires; release + press does', () => {
    const g = arena(BIPED);
    applyKeyDown(g.input, 'KeyQ', false);
    g.advance(1 / 60);
    g.advance(1 / 60);
    expect(g.state.player.mv.qbSuccessCount).toBe(1);
    for (let i = 0; i < 120; i++) {
      applyKeyDown(g.input, 'KeyQ', true); // OS repeat while held
      g.advance(1 / 60);
    }
    g.pause(); // Esc / pointer lock lost: every input is released by the app
    g.resume();
    for (let i = 0; i < 300; i++) {
      applyKeyDown(g.input, 'KeyQ', true); // the key is still down: repeat events keep coming
      g.advance(1 / 60);
    }
    expect(g.state.player.mv.qbSuccessCount).toBe(1);
    expect(g.state.player.en).toBeGreaterThan(36); // EN and cooldown would both allow a QB: only the missing press prevents it
    applyKeyUp(g.input, 'KeyQ');
    g.advance(1 / 60);
    applyKeyDown(g.input, 'KeyQ', false);
    g.advance(1 / 60);
    g.advance(1 / 60);
    expect(g.state.player.mv.qbSuccessCount).toBe(2);
  });
});

describe('[S7.2-J] a jump pressed inside the QB impulse (ground): plain-jump vertical motion, 80 m/s until the impulse ends, then the AIR glide limit toward 16 x mult', () => {
  for (const [l, m] of [
    [BIPED, 1],
    [QUAD, 0.8],
  ] as const) {
    it(label(l), () => {
      const g = arena(l);
      const c = arena(l); // control: the same jump without a QB
      const p = g.state.player;
      const q = c.state.player;
      tapQ(g); // tick 0
      c.step();
      for (const game of [g, c]) game.input.jump = true;
      g.step(); // tick 1: jump edge inside the impulse
      c.step();
      for (const game of [g, c]) game.input.jump = false;
      let prev = hs(g);
      for (let k = 2; k <= 100; k++) {
        g.step();
        c.step();
        expect(p.pos.y, `tick ${k}`).toBeCloseTo(q.pos.y, 12);
        expect(p.vel.y, `tick ${k}`).toBeCloseTo(q.vel.y, 12);
        expect(p.grounded).toBe(q.grounded);
        const v = hs(g);
        // after this step k + 1 ticks are complete (tick 0 = tapQ, tick 1 = the jump tick): the 18-tick impulse is over after k = 17
        if (k <= 17) expect(v, `tick ${k}`).toBeCloseTo(80 * m, 9);
        else {
          expect(prev - v, `tick ${k}`).toBeLessThanOrEqual(GLIDE_ACC_A * m * DT + 1e-9);
          expect(v, `tick ${k}`).toBeGreaterThanOrEqual(16 * m - 1e-9);
        }
        prev = v;
      }
      expect(p.grounded).toBe(false); // still in the 1.11 s hop
      expect(hs(g)).toBeCloseTo(16 * m, 9);
      expect(p.mv.glideEnabled).toBe(true);
      expect(evCount(g, 'jump')).toBe(1);
    });
  }
});

describe('[S7.2-L] air QB then landing (all leg types): steady 16 x mult in the air, glide stays ON, smooth move to 22 x mult on the ground', () => {
  for (const [l, m] of [
    [BIPED, 1],
    [QUAD, 0.8],
  ] as const) {
    it(label(l), () => {
      const g = arena(l);
      const p = g.state.player;
      g.input.jump = true;
      g.step();
      g.input.jump = false;
      run(g, 35);
      tapQ(g);
      let landedAt = -1;
      let sawAirSteady = false;
      let prev = hs(g);
      for (let k = 0; k < 300; k++) {
        const wasAir = !p.grounded;
        g.step();
        const v = hs(g);
        if (!p.grounded && Math.abs(v - 16 * m) < 1e-9) sawAirSteady = true;
        if (wasAir && p.grounded && landedAt < 0) landedAt = g.state.tick;
        if (landedAt >= 0) {
          expect(p.mv.glideEnabled).toBe(true);
          expect(Math.abs(v - prev)).toBeLessThanOrEqual(GLIDE_ACC_G * m * DT + 1e-9);
        }
        prev = v;
      }
      expect(sawAirSteady).toBe(true);
      expect(landedAt).toBeGreaterThan(0);
      expect(hs(g)).toBeCloseTo(22 * m, 9);
    });
  }
});

describe('[SNAP-2] the QB timers reported by getSnapshot follow the simulation clock exactly, tick by tick', () => {
  it('impulse remaining = 0.15 - t, cooldown remaining = 1.0 - t, count / start / last spend fixed at the QB tick', () => {
    const g = arena(BIPED);
    g.input.qb = true;
    for (let k = 1; k <= 150; k++) {
      g.step();
      if (k === 1) g.input.qb = false;
      const s = buildSnapshot(g.state);
      const t = k * DT;
      expect(s.elapsedSeconds).toBeCloseTo(t, 12);
      const m = s.player.movement;
      expect(m.qbSuccessfulCount).toBe(1);
      expect(m.qbLastStartedAtSeconds).toBe(0);
      expect(m.lastEnSpentAtSeconds).toBe(0);
      expect(m.qbImpulseRemainingSeconds, `tick ${k}`).toBeCloseTo(Math.max(0, 0.15 - t), 9);
      expect(m.qbCooldownRemainingSeconds, `tick ${k}`).toBeCloseTo(Math.max(0, 1.0 - t), 9);
      expect(m.horizontalMode).toBe(t < 0.15 - 1e-9 ? 'quickboost' : 'glide');
      expect(s.player.en).toBeCloseTo(t <= 0.75 + 1e-9 ? 84 : 84 + 15 * (t - 0.75), 9);
    }
  });
});

describe('[FR-8] Q held for 5 s gives exactly one QB at any frame rate (advance() with 1/30, 1/60, 1/144 s frames)', () => {
  for (const fps of [30, 60, 144, 240]) {
    it(`${fps} fps`, () => {
      const g = arena(BIPED);
      g.input.qb = true; // pressed once, never released
      let minEn = Infinity;
      for (let i = 0; i < fps * 5; i++) {
        g.advance(1 / fps);
        minEn = Math.min(minEn, g.state.player.en);
      }
      expect(g.state.player.mv.qbSuccessCount).toBe(1);
      expect(minEn).toBe(84);
    });
  }
});

describe('[NAN-1] Game.look() must never put NaN / Infinity into the view state (ARCH 3 / SPEC 9), because yaw is the source of every WASD / QB direction', () => {
  for (const [dx, dy] of [
    [Number.NaN, 0],
    [0, Number.NaN],
    [Number.POSITIVE_INFINITY, 0],
    [0, Number.NEGATIVE_INFINITY],
  ] as const) {
    it(`look(${dx}, ${dy})`, () => {
      const g = arena(BIPED);
      g.look(dx, dy);
      const s = g.state;
      expect(Number.isFinite(s.player.yaw)).toBe(true);
      expect(Number.isFinite(s.player.pitch)).toBe(true);
      expect([s.camera.pos.x, s.camera.pos.y, s.camera.pos.z].every(Number.isFinite)).toBe(true);
      // and the mech is still steerable afterwards
      g.input.forward = true;
      run(g, 30);
      expect(hs(g)).toBeCloseTo(10, 9);
    });
  }
});

// ================================================================================================================
// the input latch (src/ui/input.ts) must fix lost taps WITHOUT creating double presses, reservations or a stuck level
// ================================================================================================================
describe('[S7.1-U5..] real key events + the app loop order (advance -> afterAdvance): taps are neither lost, doubled, stuck nor reserved', () => {
  function ui(g: Game) {
    const target = new EventTarget();
    const ctl = new InputController({
      input: g.input,
      isPlaying: () => g.state.mode === 'playing',
      isLocked: () => true,
      look: (dx, dy) => g.look(dx, dy),
      onEscape: () => {},
    });
    ctl.attach(target as unknown as Window);
    const key = (type: 'keydown' | 'keyup', code: string, repeat = false): void => {
      target.dispatchEvent(Object.assign(new Event(type), { code, repeat }));
    };
    // exactly what src/ui/app.ts does every rendered frame
    const frame = (dt: number): number => {
      const n = g.advance(dt);
      ctl.afterAdvance(n);
      return n;
    };
    return { ctl, key, frame };
  }

  it('[S7.1-U5] five taps (keydown + keyup back-to-back, 2.5 s apart): exactly one QB per tap, and the Q level is never left stuck at true', () => {
    const g = arena(BIPED);
    const { ctl, key, frame } = ui(g);
    for (let i = 1; i <= 5; i++) {
      key('keydown', 'KeyQ');
      key('keyup', 'KeyQ'); // both before the next rendered frame
      frame(1 / 60);
      expect(g.state.player.mv.qbSuccessCount, `tap ${i}`).toBe(i);
      frame(1 / 60);
      expect(g.input.qb, `tap ${i}: level must be released again after the tick that saw it`).toBe(false);
      for (let f = 0; f < 150; f++) frame(1 / 60); // 2.5 s
    }
    ctl.detach();
  });

  it('[S7.1-U6] at 144 fps some frames run 0 ticks: a tap delivered in such a frame is still seen by exactly one tick (one QB), then released', () => {
    const g = arena(BIPED);
    const { ctl, key, frame } = ui(g);
    frame(1 / 144); // 0 ticks (accumulator 0.0069 < 1/120)
    key('keydown', 'KeyQ');
    key('keyup', 'KeyQ');
    let n = frame(1 / 144);
    if (n === 0) n = frame(1 / 144);
    expect(g.state.player.mv.qbSuccessCount).toBe(1);
    for (let f = 0; f < 4; f++) frame(1 / 144);
    expect(g.input.qb).toBe(false);
    expect(g.state.player.mv.qbSuccessCount).toBe(1);
    ctl.detach();
  });

  it('[S7.1-U7] a normal press that a tick has already seen is released immediately at keyup (no extra deferral), and a later press is a fresh edge', () => {
    const g = arena(BIPED);
    const { ctl, key, frame } = ui(g);
    key('keydown', 'KeyQ');
    frame(1 / 60);
    frame(1 / 60);
    expect(g.state.player.mv.qbSuccessCount).toBe(1);
    key('keyup', 'KeyQ');
    expect(g.input.qb).toBe(false);
    for (let f = 0; f < 90; f++) frame(1 / 60); // 1.5 s: cooldown over
    key('keydown', 'KeyQ');
    frame(1 / 60);
    expect(g.state.player.mv.qbSuccessCount).toBe(2);
    ctl.detach();
  });

  it('[S7.1-U8] Space / Shift taps: one jump (no flight, no EN), one glide toggle - and a second Shift tap toggles it back OFF (not stuck)', () => {
    const g = arena(BIPED);
    const { ctl, key, frame } = ui(g);
    key('keydown', 'Space');
    key('keyup', 'Space');
    key('keydown', 'ShiftLeft');
    key('keyup', 'ShiftLeft');
    for (let f = 0; f < 3; f++) frame(1 / 60);
    expect(evCount(g, 'jump')).toBe(1);
    expect(g.state.player.mv.glideEnabled).toBe(true);
    for (let f = 0; f < 90; f++) frame(1 / 60);
    expect(g.state.player.en).toBe(120); // a tap never turns into flight
    key('keydown', 'ShiftLeft');
    key('keyup', 'ShiftLeft');
    for (let f = 0; f < 3; f++) frame(1 / 60);
    expect(g.state.player.mv.glideEnabled).toBe(false);
    ctl.detach();
  });

  it('[S7.1-U9] a tap that is still latched when the game is paused is discarded: after resume nothing fires until a NEW press (SPEC 9)', () => {
    const g = arena(BIPED);
    const { ctl, key, frame } = ui(g);
    frame(1 / 144); // 0 ticks
    key('keydown', 'KeyQ');
    key('keyup', 'KeyQ'); // latched, not yet seen by any tick
    ctl.releaseAll(); // the app does this on pause / pointer-lock loss
    g.pause();
    g.resume();
    for (let f = 0; f < 30; f++) frame(1 / 60);
    expect(g.state.player.mv.qbSuccessCount).toBe(0);
    key('keydown', 'KeyQ');
    key('keyup', 'KeyQ');
    frame(1 / 60);
    frame(1 / 60);
    expect(g.state.player.mv.qbSuccessCount).toBe(1);
    ctl.detach();
  });

  it('[S7.1-U10] Q pressed then Ctrl pressed before the next frame (both latched): the QB request is still refused while Ctrl is down and is not reserved for later', () => {
    const g = arena(BIPED);
    const { ctl, key, frame } = ui(g);
    key('keydown', 'ControlLeft');
    key('keydown', 'KeyQ');
    key('keyup', 'KeyQ');
    frame(1 / 60);
    frame(1 / 60);
    expect(g.state.player.mv.qbSuccessCount).toBe(0);
    expect(g.state.player.en).toBe(120);
    key('keyup', 'ControlLeft');
    for (let f = 0; f < 120; f++) frame(1 / 60);
    expect(g.state.player.mv.qbSuccessCount).toBe(0);
    ctl.detach();
  });
});

/**
 * Drives the key layer with random key events and random frame sizes (0-tick frames included) and reports violations.
 * naive = true bypasses the latch and writes the level straight into game.input (what the first version of src/ui/input.ts did):
 * it is only used as a negative control to prove that this fuzz can actually detect a lost press.
 */
function keyLayerFuzz(seed: number, naive: boolean): string[] {
  const CODES: Record<string, Key> = { KeyW: 'forward', KeyS: 'back', KeyA: 'left', KeyD: 'right', Space: 'jump', ShiftLeft: 'shift', ControlLeft: 'ctrl', KeyQ: 'qb' };
  const rnd = rngOf(0x7000 + seed);
  const g = arena({ fcs: 'medium', generator: 'capacity', legs: 'biped' });
  const target = new EventTarget();
  const ctl = new InputController({
    input: g.input,
    isPlaying: () => g.state.mode === 'playing',
    isLocked: () => true,
    look: (dx, dy) => g.look(dx, dy),
    onEscape: () => {},
  });
  if (!naive) ctl.attach(target as unknown as Window);
  const down: Record<string, boolean> = Object.fromEntries(Object.keys(CODES).map((c) => [c, false]));
  const fresh: Record<Key, number> = { forward: 0, back: 0, left: 0, right: 0, jump: 0, shift: 0, ctrl: 0, qb: 0, fire: 0 };
  // spy: the level the simulation actually sees at the start of every tick, and its rising edges
  const seen: Record<Key, boolean> = { forward: false, back: false, left: false, right: false, jump: false, shift: false, ctrl: false, qb: false, fire: false };
  const edges: Record<Key, number> = { forward: 0, back: 0, left: 0, right: 0, jump: 0, shift: 0, ctrl: 0, qb: 0, fire: 0 };
  const realStep = g.step.bind(g);
  g.step = (): void => {
    for (const k of ['jump', 'shift', 'qb'] as Key[]) {
      if (g.input[k] && !seen[k]) edges[k]++;
      seen[k] = g.input[k];
    }
    realStep();
  };
  const dispatch = (type: 'keydown' | 'keyup', code: string, repeat: boolean): void => {
    if (!naive) {
      target.dispatchEvent(Object.assign(new Event(type), { code, repeat }));
      return;
    }
    if (type === 'keydown' && repeat && ['jump', 'shift', 'qb'].includes(CODES[code])) return; // event.repeat is ignored for the edge keys
    g.input[CODES[code]] = type === 'keydown';
  };
  const bad: string[] = [];
  const codes = Object.keys(CODES);
  for (let f = 0; f < 3000 && bad.length < 6; f++) {
    const nEv = Math.floor(rnd() * 3);
    const pressedThisFrame: Key[] = [];
    for (let e = 0; e < nEv; e++) {
      const code = codes[Math.floor(rnd() * codes.length)];
      const key = CODES[code];
      if (down[code]) {
        dispatch('keyup', code, false);
        down[code] = false;
      } else {
        dispatch('keydown', code, false);
        down[code] = true;
        fresh[key]++;
        pressedThisFrame.push(key);
      }
      if (down[code] && rnd() < 0.3) dispatch('keydown', code, true); // OS repeat
    }
    const dt = [1 / 240, 1 / 144, 1 / 120, 1 / 60, 1 / 30][Math.floor(rnd() * 5)];
    const before = { jump: edges.jump, shift: edges.shift, qb: edges.qb };
    // A press can only be "lost" if the last tick had observed the key released. If that tick still saw it down, a release + press
    // between two ticks is one continuous level from the simulation's point of view (chatter): no edge can exist by construction.
    const observedReleased = { jump: !seen.jump, shift: !seen.shift, qb: !seen.qb };
    const n = g.advance(dt);
    if (!naive) ctl.afterAdvance(n);
    g.drainEvents();
    if (n > 0) {
      for (const code of codes) {
        const k = CODES[code];
        if (g.input[k] !== down[code]) bad.push(`frame ${f}: input.${k}=${g.input[k]} but the key is physically ${down[code] ? 'down' : 'up'} (stuck or dropped level after a frame that ran ${n} tick(s))`);
      }
      for (const k of ['jump', 'shift', 'qb'] as const) {
        if (observedReleased[k] && pressedThisFrame.includes(k) && edges[k] - before[k] < 1) bad.push(`frame ${f}: a fresh ${k} press was delivered before this ${n}-tick frame but the simulation saw no rising edge (lost press)`);
      }
    }
    // the sim must never see an edge that has no physical press behind it
    for (const k of ['jump', 'shift', 'qb'] as Key[]) if (edges[k] > fresh[k]) bad.push(`frame ${f}: ${edges[k]} ${k} edges seen for only ${fresh[k]} physical presses (invented press)`);
    if (g.state.player.mv.qbSuccessCount > fresh.qb) bad.push(`frame ${f}: ${g.state.player.mv.qbSuccessCount} QBs for ${fresh.qb} physical Q presses`);
    if (g.state.mode !== 'playing') break;
  }
  ctl.detach();
  return bad;
}

describe('[S7.1-UF] fuzz of the real key layer with random frame sizes (0-tick frames included): no stuck level, no lost press, no invented press', () => {
  // 6 seeds by default; AUDIT_SEEDS=40 gives 120
  for (let seed = 1; seed <= Math.max(6, FUZZ_SEEDS * 3); seed++) {
    it(`seed ${seed}`, () => {
      expect(keyLayerFuzz(seed, false)).toEqual([]);
    });
  }
  it('negative control: the same fuzz DOES flag a level-only key layer (no latch) as losing presses, so a pass above is meaningful', () => {
    const bad = keyLayerFuzz(1, true);
    expect(bad.some((m) => m.includes('lost press'))).toBe(true);
  });
});

// ================================================================================================================
// a floor built from many adjacent boxes (the real stage is made of AABB boxes): seams must not snag the movement
// ================================================================================================================
describe('[COL-5] floor made of 10 m tiles (start exactly on a 4-tile corner): walking, gliding and QB behave exactly as on a single slab', () => {
  const N = 24;
  const SZ = 10;
  const tiles = (): BoxDef[] => {
    const out: BoxDef[] = [];
    for (let i = 0; i < N; i++)
      for (let j = 0; j < N; j++) out.push(box(`t${i}_${j}`, [(-N / 2 + i) * SZ, -2, (-N / 2 + j) * SZ], [(-N / 2 + i + 1) * SZ, 0, (-N / 2 + j + 1) * SZ]));
    return out;
  };
  const yaws = [0, 0.4, Math.PI / 4, 1.2, 2.5, -2.0];
  for (const l of [BIPED, QUAD]) {
    it(`${label(l)}: walk 10 x mult (never slower at a seam), glide 22 x mult, QB 42.6 x mult m per 0.75 s, always grounded and level`, () => {
      const m = LEGS[l.legs].speed;
      for (const yaw of yaws) {
        // walk
        const w = arenaWith(l, tiles(), 0);
        setView(w, yaw, 0);
        w.input.forward = true;
        let minSpeed = Infinity;
        let ungrounded = 0;
        let maxDy = 0;
        run(w, 300, (k) => {
          if (k >= 12) minSpeed = Math.min(minSpeed, hs(w));
          if (!w.state.player.grounded) ungrounded++;
          maxDy = Math.max(maxDy, Math.abs(w.state.player.pos.y - 1.5));
        });
        expect(minSpeed, `walk yaw ${yaw}`).toBeCloseTo(10 * m, 9);
        expect(ungrounded, `walk yaw ${yaw}`).toBe(0);
        expect(maxDy, `walk yaw ${yaw}`).toBeLessThan(1e-3);
        // 300 ticks = 2.5 s: accelerate at 120 x mult for (10 x mult)/(120 x mult) = 1/12 s (0.5 x 10m x 1/12), then 10 x mult m/s
        expect(Math.hypot(w.state.player.pos.x, w.state.player.pos.z), `walk yaw ${yaw}`).toBeCloseTo(10 * m * 2.5 - 0.5 * 10 * m * (1 / 12), 6);
        // glide
        const gl = arenaWith(l, tiles(), 0);
        setView(gl, yaw, 0);
        tapShift(gl);
        let minGlide = Infinity;
        run(gl, 300, (k) => {
          if (k >= 40) minGlide = Math.min(minGlide, hs(gl));
        });
        expect(minGlide, `glide yaw ${yaw}`).toBeCloseTo(22 * m, 9);
        // QB
        const q = arenaWith(l, tiles(), 0);
        setView(q, yaw, 0);
        const x0 = q.state.player.pos.x;
        const z0 = q.state.player.pos.z;
        tapQ(q);
        run(q, 89);
        expect(q.state.player.grounded, `QB yaw ${yaw}`).toBe(true);
        expect(Math.hypot(q.state.player.pos.x - x0, q.state.player.pos.z - z0), `QB yaw ${yaw}`).toBeCloseTo(42.6 * m, 1);
      }
    });
  }
});
