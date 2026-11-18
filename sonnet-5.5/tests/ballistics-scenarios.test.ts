/**
 * SPEC §4.6 separated firing tests A01-A13, run through the REAL Game (FCS lock -> computeFireSolution -> projectile spawn ->
 * swept collision -> damageEnemy). Nothing here re-implements aiming or hit detection: the only test-side maths are the
 * independent oracles (residual, analytic parabola, missile intercept quadratic) used to CHECK the game's numbers.
 *
 * Scope: stationary player only. Shooting while gliding / flying / quick-boosting is verified in the later integration stage.
 * The scripted target is moved by enemyIntegrate (enemy agent); no test-side position updates are used.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { FCS, GRAVITY, SIM, TEST_TARGET_RADIUS, WEAPONS } from '../src/config';
import type { FcsId, GeneratorId, LegsId } from '../src/config';
import { solveMachinegun } from '../src/sim/ballistics';
import { createScenarioGame, SCENARIO_MUZZLE } from '../src/sim/scenario';
import type { Scenario, ScenarioSpec } from '../src/sim/scenario';
import { computeEffectiveStats } from '../src/sim/stats';
import type { FireControlState, GameEvent, Loadout, ShotRecord, V3 } from '../src/sim/types';

// ---------------------------------------------------------------------------
// independent helpers (no code shared with the solver / projectile code)
// ---------------------------------------------------------------------------
const v3 = (x: number, y: number, z: number): V3 => ({ x, y, z });
const add = (a: V3, b: V3): V3 => v3(a.x + b.x, a.y + b.y, a.z + b.z);
const sub = (a: V3, b: V3): V3 => v3(a.x - b.x, a.y - b.y, a.z - b.z);
const mul = (a: V3, k: number): V3 => v3(a.x * k, a.y * k, a.z * k);
const dot = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const len = (a: V3): number => Math.sqrt(dot(a, a));
const unit = (a: V3): V3 => mul(a, 1 / len(a));
const angleBetween = (a: V3, b: V3): number => Math.acos(Math.max(-1, Math.min(1, dot(a, b) / (len(a) * len(b)))));
const DT = SIM.DT;
const DELAYS = Array.from({ length: 20 }, (_, i) => i); // lock-complete -> shot gap, 0..19 ticks (20 shots per condition)

/** SPEC §4.6 table: r relative to the muzzle m = (0,20,0), v target velocity */
const A_CASES: { id: string; r: V3; v: V3 }[] = [
  { id: 'A01', r: v3(0, 0, 20), v: v3(0, 0, 0) },
  { id: 'A02', r: v3(0, 0, 60), v: v3(0, 0, 0) },
  { id: 'A03', r: v3(0, 0, 100), v: v3(0, 0, 0) },
  { id: 'A04', r: v3(0, 0, 120), v: v3(0, 0, 0) },
  { id: 'A05', r: v3(0, 0, 100), v: v3(8, 0, 0) },
  { id: 'A06', r: v3(0, 0, 100), v: v3(-8, 0, 0) },
  { id: 'A07', r: v3(0, 0, 100), v: v3(0, 0, 8) },
  { id: 'A08', r: v3(0, 0, 100), v: v3(0, 0, -8) },
  { id: 'A09', r: v3(0, 16, 100), v: v3(6, 0, 0) },
  { id: 'A10', r: v3(0, -16, 100), v: v3(-6, 0, 0) },
  { id: 'A11', r: v3(0, 0, 100), v: v3(6, 3, 0) },
  { id: 'A12', r: v3(0, 0, 100), v: v3(6, -3, 0) },
  { id: 'A13', r: v3(0, 0, 120), v: v3(6, 3, 4) },
];
const A05 = A_CASES[4];
const A06 = A_CASES[5];
const A07 = A_CASES[6];

/** SPEC §4.6 reference values (derived from the equations, not measured in the game) */
const REF = {
  A03: { t: 1.004108529, v0: v3(0, 9.036976765, 99.590828147) },
  A05: { t: 1.007391236, v0: v3(8, 9.066521121, 99.266299391) },
  A13: { t: 1.266137996 },
};

// ---------------------------------------------------------------------------
// run helpers: press fire for exactly one tick at the scenario's shot tick, keep stepping the real game
// ---------------------------------------------------------------------------
const snapshotFc = (fc: FireControlState): FireControlState => JSON.parse(JSON.stringify(fc)) as FireControlState;

interface LockedShot {
  sc: Scenario;
  fcBefore: FireControlState;
  record: ShotRecord;
}

/** run to the shot tick, assert the FCS lock is complete on the scripted target, then fire once */
function lockAndFire(spec: ScenarioSpec): LockedShot {
  const sc = createScenarioGame(spec);
  const g = sc.game;
  for (let i = 0; i < sc.fireTick; i++) g.step();
  expect(g.state.tick).toBe(sc.fireTick);
  expect(g.state.lock.state).toBe('locked');
  expect(g.state.lock.targetId).toBe(sc.targetId);
  const fcBefore = snapshotFc(g.state.fc);
  g.input.fire = true;
  g.step();
  g.input.fire = false;
  expect(g.state.shots.length).toBe(1);
  return { sc, fcBefore, record: g.state.shots[0] };
}

const events = (sc: Scenario): GameEvent[] => sc.game.state.events;

interface MgRun {
  hit: boolean;
  hpLoss: number;
  record: ShotRecord;
  fcBefore: FireControlState;
  /** residual recomputed from the ShotRecord with the spec formulas (independent of the solver) */
  oracleResidual: number;
  speed: number;
  hitAge: number | null;
  enemyHitEvents: number;
  /** max |bullet.pos - (m + v0 a + g a^2/2)| over the whole flight */
  pathDeviation: number;
  finalBulletsAlive: number;
}

/** independent residual: |m + v0 t + g t^2/2 - (p + v t)| at the record's predicted time */
function oracleResidual(rec: ShotRecord): number {
  const t = rec.predictedFlightSeconds as number;
  const bullet = add(add(rec.muzzlePosition, mul(rec.initialVelocity as V3, t)), v3(0, -0.5 * GRAVITY * t * t, 0));
  const target = add(rec.targetPositionAtFire as V3, mul(rec.targetVelocityAtFire as V3, t));
  return len(sub(bullet, target));
}

function runMg(spec: ScenarioSpec, hook?: (sc: Scenario, bulletAge: number) => void): MgRun {
  const { sc, fcBefore, record } = lockAndFire(spec);
  const g = sc.game;
  const tgt = g.state.enemies.find((e) => e.id === sc.targetId)!;
  const bullet = g.state.bullets[0];
  expect(bullet).toBeDefined();
  let pathDeviation = 0;
  let guard = 0;
  while (g.state.bullets.length > 0 && guard++ < 400) {
    if (hook) hook(sc, bullet.age);
    g.step();
    if (bullet.alive) {
      const a = bullet.age;
      const expected = add(add(bullet.origin, mul(bullet.v0, a)), v3(0, -0.5 * GRAVITY * a * a, 0));
      pathDeviation = Math.max(pathDeviation, len(sub(bullet.pos, expected)));
    }
  }
  const hpLoss = 1e6 - tgt.hp;
  const enemyHitEvents = events(sc).filter((e) => e.type === 'hit' && e.on === 'enemy').length;
  return {
    hit: hpLoss > 0,
    hpLoss,
    record,
    fcBefore,
    oracleResidual: record.predictedFlightSeconds === null ? NaN : oracleResidual(record),
    speed: record.initialVelocity ? len(record.initialVelocity) : NaN,
    hitAge: hpLoss > 0 ? bullet.age : null,
    enemyHitEvents,
    pathDeviation,
    finalBulletsAlive: g.state.bullets.length,
  };
}

// ---------------------------------------------------------------------------
// results table for the report (printed once at the end)
// ---------------------------------------------------------------------------
const table: string[] = [];
afterAll(() => {
  // eslint-disable-next-line no-console
  console.log(['', 'ballistics-scenarios summary (real Game, stationary player)', ...table].join('\n'));
});

// ---------------------------------------------------------------------------
// machinegun: A01-A13, 20 single shots each
// ---------------------------------------------------------------------------
describe('machinegun A01-A13 (real Game, FCS lock -> real bullet -> swept hit)', () => {
  for (const c of A_CASES) {
    it(`${c.id}: 20 single shots (lock->shot gap 0..19 ticks) all hit, residual <= 0.01 m`, () => {
      const runs = DELAYS.map((d) => runMg({ r: c.r, v: c.v, delayTicks: d }));
      const hits = runs.filter((r) => r.hit).length;
      const maxRes = Math.max(...runs.map((r) => r.oracleResidual));
      const maxSolverRes = Math.max(...runs.map((r) => r.record && (r.fcBefore.residualMeters as number)));
      const minT = Math.min(...runs.map((r) => r.record.predictedFlightSeconds as number));
      const maxT = Math.max(...runs.map((r) => r.record.predictedFlightSeconds as number));
      const maxSpeedErr = Math.max(...runs.map((r) => Math.abs(r.speed - WEAPONS.machinegun.muzzleSpeed)));
      const maxDev = Math.max(...runs.map((r) => r.pathDeviation));
      table.push(
        `MG ${c.id}: shots=20 hits=${hits} maxResidual(oracle)=${maxRes.toExponential(2)} maxResidual(fc)=${maxSolverRes.toExponential(2)} ` +
          `t=[${minT.toFixed(9)}, ${maxT.toFixed(9)}] maxSpeedErr=${maxSpeedErr.toExponential(1)} maxPathDeviation=${maxDev.toExponential(1)}`,
      );

      for (const [i, r] of runs.entries()) {
        const tag = `${c.id} delay=${i}`;
        // real hit through the bullet sweep: exactly one enemy hit event, exactly 12 damage
        expect(r.hpLoss, tag).toBe(WEAPONS.machinegun.damage);
        expect(r.enemyHitEvents, tag).toBe(1);
        expect(r.finalBulletsAlive, tag).toBe(0);
        // the shot was a corrected shot on a locked target
        expect(r.record.solutionStatus, tag).toBe('solved');
        expect(r.record.targetId, tag).toBe('TGT');
        expect(r.record.weapon).toBe('machinegun');
        // the state at the shot matches SPEC §4.6: m = (0,20,0), p = m + r, v as given
        expect(len(sub(r.record.muzzlePosition, SCENARIO_MUZZLE)), tag).toBeLessThan(1e-9);
        expect(len(sub(r.record.targetPositionAtFire as V3, add(SCENARIO_MUZZLE, c.r))), tag).toBeLessThan(1e-9);
        expect(len(sub(r.record.targetVelocityAtFire as V3, c.v)), tag).toBeLessThan(1e-12);
        // SPEC §4.3: |v0| = 100 +- 0.001, projectile-vs-predicted-target distance <= 0.01 m
        expect(Math.abs(r.speed - 100), tag).toBeLessThanOrEqual(0.001);
        expect(r.oracleResidual, tag).toBeLessThanOrEqual(FCS.MAX_RESIDUAL_M);
        expect(r.fcBefore.residualMeters as number, tag).toBeLessThanOrEqual(FCS.MAX_RESIDUAL_M);
        // HUD (state.fc) had the same solution the shot then used (one shared computeFireSolution)
        expect(r.fcBefore.status).toBe('solved');
        expect(len(sub(r.fcBefore.launchDirection as V3, r.record.launchDirection)), tag).toBeLessThan(1e-12);
        expect(r.fcBefore.predictedFlightSeconds as number).toBeCloseTo(r.record.predictedFlightSeconds as number, 12);
        expect(r.fcBefore.evaluatedAtSeconds as number).toBeCloseTo(r.record.firedAtSeconds, 12);
        // a corrected aim point is ABOVE the predicted hit point (gravity), the launch direction is the aim-point direction
        expect((r.fcBefore.aimPoint as V3).y).toBeGreaterThan((r.fcBefore.predictedInterceptPosition as V3).y);
        // the bullet flew the exact analytic parabola (no homing, no gravity cancellation)
        expect(r.pathDeviation, tag).toBeLessThan(1e-9);
        // first contact happens before the centre-arrival time (the target has radius 0.5)
        expect(r.hitAge as number, tag).toBeLessThanOrEqual((r.record.predictedFlightSeconds as number) + 1e-9);
        expect(r.hitAge as number, tag).toBeGreaterThan((r.record.predictedFlightSeconds as number) - 0.1);
        expect(r.record.accelerationAtFire).toEqual({ x: 0, y: -18, z: 0 });
      }
      expect(hits).toBe(20);
      expect(maxRes).toBeLessThanOrEqual(0.01);
    });
  }

  it('A03 / A05 / A13 reproduce the SPEC reference numbers through the real shot', () => {
    const a03 = runMg({ r: A_CASES[2].r, v: A_CASES[2].v });
    expect(a03.record.predictedFlightSeconds as number).toBeCloseTo(REF.A03.t, 8);
    expect(len(sub(a03.record.initialVelocity as V3, REF.A03.v0))).toBeLessThan(1e-6);
    const a05 = runMg({ r: A05.r, v: A05.v });
    expect(a05.record.predictedFlightSeconds as number).toBeCloseTo(REF.A05.t, 8);
    expect(len(sub(a05.record.initialVelocity as V3, REF.A05.v0))).toBeLessThan(1e-6);
    const a13 = runMg({ r: A_CASES[12].r, v: A_CASES[12].v });
    expect(a13.record.predictedFlightSeconds as number).toBeCloseTo(REF.A13.t, 8);
    // A13's solution needs more than the 1.20 s enemy prediction cap: the player FCS does not reuse that cap
    expect(a13.record.predictedFlightSeconds as number).toBeGreaterThan(1.2);
    expect(a13.hit).toBe(true);
    table.push(
      `MG reference: A03 t=${(a03.record.predictedFlightSeconds as number).toFixed(9)} (ref ${REF.A03.t}), ` +
        `A05 t=${(a05.record.predictedFlightSeconds as number).toFixed(9)} (ref ${REF.A05.t}), ` +
        `A13 t=${(a13.record.predictedFlightSeconds as number).toFixed(9)} (ref ${REF.A13.t})`,
    );
  });

  it('the corrected shot is NOT a straight aim at the target: launch elevation exceeds the geometric elevation (gravity compensation)', () => {
    const run = runMg({ r: A_CASES[2].r, v: A_CASES[2].v });
    const rec = run.record;
    const direct = unit(sub(rec.targetPositionAtFire as V3, rec.muzzlePosition));
    expect(rec.launchDirection.y).toBeGreaterThan(direct.y + 0.05);
    // and the launch direction is the aim-point direction of the SPEC formula
    const aim = run.fcBefore.aimPoint as V3;
    expect(angleBetween(sub(aim, rec.muzzlePosition), rec.launchDirection)).toBeLessThan(1e-9);
  });

  it('the bullet is a free projectile: a target that changes course after the shot is missed (no homing, no forced hit)', () => {
    for (const [name, c, newVel] of [
      ['A03 target starts moving sideways', A_CASES[2], v3(6, 0, 0)],
      ['A05 target reverses', A05, v3(-8, 0, 0)],
      ['A09 target jumps upward', A_CASES[8], v3(6, 12, 0)],
    ] as const) {
      let switched = false;
      const run = runMg({ r: c.r, v: c.v }, (sc, age) => {
        if (!switched && age >= 0.3 - 1e-9) {
          sc.game.state.enemies.find((e) => e.id === sc.targetId)!.vel = { ...newVel };
          switched = true;
        }
      });
      expect(switched, name).toBe(true);
      expect(run.hit, name).toBe(false);
      expect(run.enemyHitEvents, name).toBe(0);
      expect(run.pathDeviation, name).toBeLessThan(1e-9); // the bullet still followed the launch-time parabola
    }
  });

  it('control: without the course change the very same runs hit (the miss above is caused by the maneuver)', () => {
    for (const c of [A_CASES[2], A05, A_CASES[8]]) expect(runMg({ r: c.r, v: c.v }).hit).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FCS parts / legs give the same correction accuracy (SPEC §4.2)
// ---------------------------------------------------------------------------
describe('correction accuracy is identical for all 18 loadouts (A05, 20 shots each)', () => {
  const fcsIds: FcsId[] = ['wide', 'medium', 'narrow'];
  const gens: GeneratorId[] = ['capacity', 'balanced', 'recovery'];
  const legs: LegsId[] = ['biped', 'quadruped'];
  const loadouts: Loadout[] = [];
  for (const f of fcsIds) for (const gg of gens) for (const l of legs) loadouts.push({ fcs: f, generator: gg, legs: l });

  it('every loadout: 20/20 hits, residual <= 0.01, same predicted time to 1e-9', () => {
    let total = 0;
    let hits = 0;
    let maxRes = 0;
    for (const lo of loadouts) {
      const ts: number[] = [];
      for (const d of DELAYS) {
        const run = runMg({ r: A05.r, v: A05.v, delayTicks: d, loadout: lo });
        total += 1;
        if (run.hit) hits += 1;
        maxRes = Math.max(maxRes, run.oracleResidual);
        ts.push(run.record.predictedFlightSeconds as number);
        expect(run.hpLoss, `${lo.fcs}/${lo.generator}/${lo.legs} delay ${d}`).toBe(12);
      }
      expect(Math.max(...ts) - Math.min(...ts)).toBeLessThan(1e-9);
      expect(ts[0]).toBeCloseTo(REF.A05.t, 8);
    }
    table.push(`MG A05 x 18 loadouts: shots=${total} hits=${hits} maxResidual(oracle)=${maxRes.toExponential(2)}`);
    expect(hits).toBe(total);
    expect(maxRes).toBeLessThanOrEqual(0.01);
  });
});

// ---------------------------------------------------------------------------
// beam: same positions/velocities, hits the CURRENT position at the shot
// ---------------------------------------------------------------------------
describe('beam A01-A13 (lock complete -> instant hit on the current position)', () => {
  for (const c of A_CASES) {
    it(`${c.id}: 20 shots, 40 damage once each, direction = normalize(p - m), t = 0, residual 0`, () => {
      let hits = 0;
      let maxAngle = 0;
      let mgAim: V3 | null = null;
      for (const d of DELAYS) {
        const { sc, fcBefore, record } = lockAndFire({ r: c.r, v: c.v, delayTicks: d, weapon: 'beam' });
        const g = sc.game;
        const tgt = g.state.enemies.find((e) => e.id === sc.targetId)!;
        const p = add(SCENARIO_MUZZLE, c.r);
        const tag = `${c.id} delay=${d}`;
        // beam pays 8 EN, once; damage 40, once
        expect(1e6 - tgt.hp, tag).toBe(40);
        if (1e6 - tgt.hp === 40) hits += 1;
        expect(g.state.player.en, tag).toBeCloseTo(computeEffectiveStats(g.state.loadout).maxEn - 8, 9);
        expect(g.state.player.mv.lastEnSpentAt, tag).toBeCloseTo(record.firedAtSeconds, 12);
        const ev = events(sc).filter((e) => e.type === 'beamFire');
        expect(ev.length, tag).toBe(1);
        const bf = ev[0] as Extract<GameEvent, { type: 'beamFire' }>;
        expect(bf.hit, tag).toBe('enemy');
        expect(bf.targetId, tag).toBe('TGT');
        // the beam entered the target sphere on the ray toward the CURRENT centre (surface point 0.5 m short of the centre)
        expect(len(sub(bf.end, p)), tag).toBeCloseTo(TEST_TARGET_RADIUS, 6);
        // record + fc: current position, t = 0, residual 0, no projectile velocity
        expect(record.solutionStatus).toBe('solved');
        expect(record.predictedFlightSeconds).toBe(0);
        expect(record.initialVelocity).toBeNull();
        expect(record.accelerationAtFire).toEqual({ x: 0, y: 0, z: 0 });
        expect(len(sub(record.predictedInterceptPosition as V3, p)), tag).toBeLessThan(1e-9);
        const direct = unit(sub(p, record.muzzlePosition));
        maxAngle = Math.max(maxAngle, angleBetween(direct, record.launchDirection));
        expect(len(sub(record.launchDirection, direct)), tag).toBeLessThan(1e-12);
        expect(fcBefore.residualMeters).toBe(0);
        expect(fcBefore.predictedFlightSeconds).toBe(0);
        expect(len(sub(fcBefore.aimPoint as V3, p)), tag).toBeLessThan(1e-9);
        expect(g.state.bullets.length).toBe(0);
        // the machinegun-style future/upward aim would be a different direction
        if (mgAim === null) {
          const s = solveMachinegun(record.muzzlePosition, p, c.v);
          mgAim = s ? s.direction : null;
          if (s) expect(angleBetween(s.direction, record.launchDirection)).toBeGreaterThan(1e-4);
        }
      }
      table.push(`Beam ${c.id}: shots=20 hits=${hits} maxDirectionError=${maxAngle.toExponential(1)} rad`);
      expect(hits).toBe(20);
    });
  }

  it('control: shooting the machinegun-corrected direction with the beam would MISS the moving/far targets (why the beam must not reuse it)', () => {
    const misses: string[] = [];
    for (const c of A_CASES) {
      const m = SCENARIO_MUZZLE;
      const p = add(m, c.r);
      const s = solveMachinegun(m, p, c.v)!;
      // distance from the target centre to the ray m + d*s: perpendicular miss of the corrected direction
      const rel = sub(p, m);
      const along = dot(rel, s.direction);
      const perp = len(sub(rel, mul(s.direction, along)));
      if (perp > TEST_TARGET_RADIUS) misses.push(c.id);
    }
    // A01 is only ~0.35 m off; the rest are far outside the 0.5 m sphere
    expect(misses.length).toBeGreaterThanOrEqual(12);
  });
});

// ---------------------------------------------------------------------------
// missile
// ---------------------------------------------------------------------------
/** smallest positive root of (v.v - 45^2) t^2 + 2 (r.v) t + r.r = 0 (SPEC §4.4) */
function missileIntercept(r: V3, v: V3): number {
  const a = dot(v, v) - 45 * 45;
  const b = 2 * dot(r, v);
  const c = dot(r, r);
  if (Math.abs(a) < 1e-12) return -c / b;
  const disc = b * b - 4 * a * c;
  const roots = [(-b - Math.sqrt(disc)) / (2 * a), (-b + Math.sqrt(disc)) / (2 * a)].filter((x) => x > 0);
  return Math.min(...roots);
}

describe('missile A05 / A06 / A07 (real missile, limited guidance)', () => {
  const MAX_TURN = (WEAPONS.missile.turnRateDeg * Math.PI) / 180 * DT; // 1 degree per tick

  for (const c of [A05, A06, A07]) {
    it(`${c.id}: 20 shots hit for 180 damage, initial direction = normalize(r + v t), turn <= 120 deg/s, speed 45`, () => {
      const tExpected = missileIntercept(c.r, c.v);
      let hits = 0;
      let maxTurnSeen = 0;
      let maxSpeedErr = 0;
      let maxAngleErr = 0;
      for (const d of DELAYS) {
        const { sc, fcBefore, record } = lockAndFire({ r: c.r, v: c.v, delayTicks: d, weapon: 'missile' });
        const g = sc.game;
        const tgt = g.state.enemies.find((e) => e.id === sc.targetId)!;
        const tag = `${c.id} delay=${d}`;
        expect(g.state.player.ammo.missile, tag).toBe(WEAPONS.missile.totalAmmo - 1);
        expect(g.state.missiles.length, tag).toBe(1);
        const ms = g.state.missiles[0];
        expect(ms.targetId).toBe('TGT');
        // initial direction: normalize(r + v t) with t from the SPEC quadratic; velocity = 45 * direction (world frame, no player velocity)
        const r = sub(add(SCENARIO_MUZZLE, c.r), record.muzzlePosition);
        const dirExpected = unit(add(r, mul(c.v, tExpected)));
        maxAngleErr = Math.max(maxAngleErr, angleBetween(dirExpected, record.launchDirection));
        expect(len(sub(record.launchDirection, dirExpected)), tag).toBeLessThan(1e-9);
        expect(record.predictedFlightSeconds as number, tag).toBeCloseTo(tExpected, 9);
        expect(len(record.initialVelocity as V3), tag).toBeCloseTo(45, 9);
        expect(record.accelerationAtFire).toEqual({ x: 0, y: 0, z: 0 });
        expect(record.solutionStatus).toBe('solved');
        expect(fcBefore.status).toBe('solved');
        // fly it
        let prevDir = unit(ms.vel);
        let guard = 0;
        while (ms.alive && guard++ < 600) {
          g.step();
          const speed = len(ms.vel);
          maxSpeedErr = Math.max(maxSpeedErr, Math.abs(speed - 45));
          const dirNow = unit(ms.vel);
          const turn = angleBetween(prevDir, dirNow);
          maxTurnSeen = Math.max(maxTurnSeen, turn);
          expect(turn, tag).toBeLessThanOrEqual(MAX_TURN + 1e-9);
          prevDir = dirNow;
        }
        const dmg = 1e6 - tgt.hp;
        expect(dmg, tag).toBe(WEAPONS.missile.damage);
        if (dmg === WEAPONS.missile.damage) hits += 1;
        // it hit near the predicted time (sphere contact is earlier than the centre arrival), never past life
        expect(ms.age, tag).toBeLessThanOrEqual(tExpected + 1e-6);
        expect(ms.age, tag).toBeGreaterThan(tExpected - 0.1);
      }
      table.push(
        `Missile ${c.id}: shots=20 hits=${hits} tIntercept=${tExpected.toFixed(6)} maxDirErrVsSpec=${maxAngleErr.toExponential(1)} rad ` +
          `maxTurnPerTick=${((maxTurnSeen * 180) / Math.PI).toFixed(6)} deg (limit 1) maxSpeedErr=${maxSpeedErr.toExponential(1)}`,
      );
      expect(hits).toBe(20);
    });
  }

  it('a target that jerks sideways after launch can be missed: the turn limit (saturating at 1 deg/tick) is real', () => {
    const { sc } = lockAndFire({ r: v3(0, 0, 100), v: v3(0, 0, 0), weapon: 'missile' });
    const g = sc.game;
    const tgt = g.state.enemies.find((e) => e.id === sc.targetId)!;
    const ms = g.state.missiles[0];
    let prevDir = unit(ms.vel);
    let maxTurn = 0;
    let jerked = false;
    let guard = 0;
    while (ms.alive && guard++ < 600) {
      // once the missile is ~30 m from the target the target bolts sideways at 100 m/s (faster than the missile can follow)
      if (!jerked && len(sub(tgt.pos, ms.pos)) < 30) {
        tgt.vel = v3(100, 0, 0);
        jerked = true;
      }
      g.step();
      const dirNow = unit(ms.vel);
      maxTurn = Math.max(maxTurn, angleBetween(prevDir, dirNow));
      prevDir = dirNow;
    }
    expect(jerked).toBe(true);
    expect(tgt.hp).toBe(1e6); // missed
    expect(maxTurn).toBeLessThanOrEqual(MAX_TURN + 1e-9);
    expect(maxTurn).toBeGreaterThan(MAX_TURN - 1e-9); // the limit was actually reached
    expect(ms.age).toBeGreaterThan(WEAPONS.missile.lifetime - 1e-6); // flew out its 4 s life
    table.push(`Missile jerk test: missed=true maxTurnPerTick=${((maxTurn * 180) / Math.PI).toFixed(6)} deg`);
  });
});
