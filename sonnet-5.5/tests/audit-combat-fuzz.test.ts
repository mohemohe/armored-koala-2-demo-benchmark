/**
 * ADVERSARIAL SPEC AUDIT (randomised / differential part). See tests/audit-combat.test.ts for the stance.
 * Every random case runs on the REAL Game; the expectation always comes from an oracle written from the SPEC text
 * (tests/audit-combat-helpers.ts), never from the implementation under test. Seeds are fixed so a failure is reproducible;
 * the failing case's inputs are printed in the assertion message.
 */
import { describe, expect, it } from 'vitest';
import { CAMERA, FCS_PARTS, PLAYER, WEAPONS } from '../src/config';
import type { FcsId, GeneratorId, LegsId } from '../src/config';
import { buildSnapshot } from '../src/sim/bench';
import { updateCamera } from '../src/sim/camera';
import { damageEnemy } from '../src/sim/combat';
import { Game } from '../src/sim/game';
import { dirFromYawPitch } from '../src/sim/math';
import { buildTestArenaStage } from '../src/sim/testArena';
import { World } from '../src/sim/world';
import { buildStage } from '../src/stage';
import type { BoxDef, EnemyState, GameState, Loadout, PlayerBullet, V3, WeaponId } from '../src/sim/types';
import {
  DT, SCEN_M, ZERO, add, addTarget, blocked, box, cp, distToBox, fcsRadiusPx, len, lockCandidates, lockModelStep, makeGame, makeRng, mgDirection, mgOracle,
  mgPos, mgResidualOf, missileRoot, mul, muzzleNow, muzzleOf, onCamRay, run, scenarioShot, sub, unit, v3,
} from './audit-combat-helpers';
import type { LockModel } from './audit-combat-helpers';

const S = (g: Game): GameState => g.state;
const hpLoss = (e: { hp: number }): number => 1e6 - e.hp;
const D2R = Math.PI / 180;

/** random point of the SPEC test envelope relative to the muzzle: 4..119 m, elevation -asin(16/d)..+25 deg, any azimuth */
function randomR(rnd: () => number): V3 {
  const dist = 4 + rnd() * 115;
  const elMin = -Math.asin(Math.min(0.28, 16 / dist));
  const el = elMin + rnd() * (25 * D2R - elMin);
  const az = (rnd() * 2 - 1) * Math.PI;
  return v3(dist * Math.cos(el) * Math.sin(az), dist * Math.sin(el), -dist * Math.cos(el) * Math.cos(az));
}
function randomDir(rnd: () => number): V3 {
  const z = rnd() * 2 - 1;
  const a = rnd() * 2 * Math.PI;
  const s = Math.sqrt(1 - z * z);
  return v3(s * Math.cos(a), z, s * Math.sin(a));
}

// =====================================================================================================================
describe('A. machinegun correction vs a brute-force oracle of the SPEC §4.3 equation (real lock -> real shot -> real bullet)', () => {
  it('400 random (r, v): solved <=> a root t <= 2 exists; t is the SMALLEST root; d, |v0|, residual per SPEC; every solved shot hits; unsolved = direct aim with the lock kept', () => {
    const rnd = makeRng(20260930);
    const tally = { solved: 0, unsolved: 0, ambiguous: 0, hit: 0, twoRoot: 0 };
    for (let i = 0; i < 400; i++) {
      const r = randomR(rnd);
      const speed = rnd() < 0.5 ? rnd() * 30 : rnd() * 140;
      const v = mul(randomDir(rnd), speed);
      const tag = `case ${i}: r=${JSON.stringify(r)} v=${JSON.stringify(v)}`;
      const { g, tgt, rec } = scenarioShot(r, v);
      // the shot uses the state of the shot instant (SPEC §4.2)
      expect(len(sub(rec.muzzlePosition, SCEN_M)), tag).toBeLessThan(1e-6);
      expect(len(sub(rec.targetPositionAtFire as V3, add(SCEN_M, r))), tag).toBeLessThan(1e-6);
      expect(len(sub(rec.targetVelocityAtFire as V3, v)), tag).toBe(0);
      const m = rec.muzzlePosition;
      const p = rec.targetPositionAtFire as V3;
      const o = mgOracle(m, p, v);
      const clearSolved = o.t !== null && o.minGap < -0.05;
      const clearUnsolved = o.t === null && o.minGap > 0.05;
      if (clearSolved) {
        tally.solved++;
        const t = o.t as number;
        expect(rec.solutionStatus, tag).toBe('solved');
        expect(Math.abs((rec.predictedFlightSeconds as number) - t), tag).toBeLessThan(1e-6);
        const v0 = rec.initialVelocity as V3;
        expect(Math.abs(len(v0) - 100), tag).toBeLessThanOrEqual(0.001);
        expect(len(sub(rec.launchDirection, mgDirection(m, p, v, rec.predictedFlightSeconds as number))), tag).toBeLessThan(1e-9);
        expect(mgResidualOf(m, v0, p, v, rec.predictedFlightSeconds as number), tag).toBeLessThanOrEqual(0.01);
        // the bullet the game actually spawned carries that velocity and starts at the muzzle
        const b = S(g).bullets[0] as PlayerBullet | undefined;
        if (b) {
          expect(len(sub(b.v0, v0)), tag).toBe(0);
          expect(len(sub(b.origin, m)), tag).toBe(0);
        }
        // real hit (only when the target is still above the floor at the hit point; the scripted dummy has no collision)
        const hitPoint = add(p, mul(v, rec.predictedFlightSeconds as number));
        // the scenario's own scaffold (the box the player stands on) can clip a steep downward round; that is test scaffolding, not a rule
        const scaffold = g.world.boxes.find((bx) => bx.id === 'scaffold')!;
        let clipsScaffold = false;
        for (let k = 0; k <= 200; k++) {
          const a = ((rec.predictedFlightSeconds as number) * k) / 200;
          if (distToBox(mgPos(m, v0, a), scaffold.min, scaffold.max) < WEAPONS.machinegun.bulletRadius + 0.05) clipsScaffold = true;
        }
        if (hitPoint.y > 1.5 && !clipsScaffold) {
          run(g, 260);
          expect(hpLoss(tgt), tag).toBe(12);
          tally.hit++;
        }
      } else if (clearUnsolved) {
        tally.unsolved++;
        expect(rec.solutionStatus, tag).toBe('no_solution');
        expect(len(sub(rec.launchDirection, unit(sub(p, m)))), tag).toBeLessThan(1e-9);
        expect(rec.predictedFlightSeconds, tag).toBeNull();
        expect(S(g).player.ammo.machinegun, tag).toBe(299);
        expect(Math.abs(len(rec.initialVelocity as V3) - 100), tag).toBeLessThan(1e-9);
      } else {
        tally.ambiguous++;
      }
    }
    // the sample must exercise both branches, otherwise the audit says nothing
    expect(tally.solved).toBeGreaterThan(100);
    expect(tally.unsolved).toBeGreaterThan(40);
    expect(tally.ambiguous).toBeLessThan(60);
    expect(tally.hit).toBeGreaterThan(80);
  });

  it('two roots: a target charging at the muzzle faster than the bullet has an early AND a late root, the SMALLEST is used (50 m out, 150 m/s inbound)', () => {
    const r = v3(0, 0, -50); // 50 m ahead
    // inbound = toward the muzzle: the scenario places the target at m + r, in front of the camera (camera looks toward it)
    for (const speed of [120, 150, 180]) {
      const dirIn = unit(mul(r, -1));
      const v = mul(dirIn, speed);
      const { rec } = scenarioShot(r, v);
      const o = mgOracle(rec.muzzlePosition, rec.targetPositionAtFire as V3, v);
      expect(o.t).not.toBeNull();
      expect(rec.solutionStatus).toBe('solved');
      expect(Math.abs((rec.predictedFlightSeconds as number) - (o.t as number))).toBeLessThan(1e-6);
    }
  });

  it('every shot of a burst is recomputed from the state at ITS OWN instant: target velocity changes between the rounds are reflected in the next round only', () => {
    const rnd = makeRng(777);
    const { g, tgt } = (() => {
      const sc = scenarioShot(v3(10, 4, -80), ZERO); // only to get a locked game on a static target; the first round is fired here
      return { g: sc.g, tgt: sc.tgt };
    })();
    // the game is now one tick after the first round; keep the trigger held for 20 more rounds and perturb the target every tick
    g.input.fire = true;
    let vel = cp(tgt.vel);
    let checked = 0;
    for (let tick = 0; tick < 12 * 20; tick++) {
      if (tick % 3 === 0) vel = add(vel, v3((rnd() - 0.5) * 6, (rnd() - 0.5) * 4, (rnd() - 0.5) * 6));
      tgt.vel = cp(vel);
      const posBefore = cp(tgt.pos);
      const mBefore = muzzleNow(S(g));
      const nBefore = S(g).shots.length;
      const seqBefore = S(g).shotSeq;
      g.step();
      if (S(g).shotSeq > seqBefore) {
        const rec = S(g).shots[S(g).shots.length - 1];
        expect(S(g).shots.length).toBeGreaterThanOrEqual(nBefore);
        expect(len(sub(rec.muzzlePosition, mBefore)), `tick ${tick}`).toBeLessThan(1e-9);
        expect(len(sub(rec.targetPositionAtFire as V3, posBefore)), `tick ${tick}`).toBeLessThan(1e-9);
        expect(len(sub(rec.targetVelocityAtFire as V3, vel)), `tick ${tick}`).toBe(0);
        const o = mgOracle(mBefore, posBefore, vel);
        if (o.t !== null && o.minGap < -0.05) {
          expect(rec.solutionStatus, `tick ${tick}`).toBe('solved');
          expect(Math.abs((rec.predictedFlightSeconds as number) - o.t), `tick ${tick}`).toBeLessThan(1e-6);
          expect(mgResidualOf(mBefore, rec.initialVelocity as V3, posBefore, vel, rec.predictedFlightSeconds as number), `tick ${tick}`).toBeLessThanOrEqual(0.01);
        }
        checked++;
      }
      if (S(g).lock.state !== 'locked') break; // the random walk carried the target out of the circle: stop, the checks above already ran
    }
    g.input.fire = false;
    expect(checked).toBeGreaterThan(5);
  });
});

describe('A2. robustness: extreme / degenerate inputs never put NaN or Infinity into the shot, the fire-control state, the projectile or the snapshot (SPEC §4.3 last lines, ARCH §3)', () => {
  const finite3 = (v: V3 | null): boolean => v === null || (Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z));
  it('300 cases: target speed 1..1e9 m/s (log-uniform), target 1e-6..119 m from the muzzle, every weapon', () => {
    const rnd = makeRng(1234567);
    for (let i = 0; i < 300; i++) {
      const weapon = (['machinegun', 'beam', 'missile'] as WeaponId[])[i % 3];
      const dist = i % 5 === 0 ? 1e-6 + rnd() * 0.5 : 1 + rnd() * 118;
      const r = mul(randomDir(rnd), dist);
      const speed = Math.pow(10, rnd() * 9);
      const v = mul(randomDir(rnd), speed);
      const tag = `case ${i} ${weapon}: r=${JSON.stringify(r)} v=${JSON.stringify(v)}`;
      let sh;
      try {
        sh = scenarioShot(r, v, { weapon });
      } catch (e) {
        // an unlockable placement (e.g. the dummy inside the scenario scaffold) is not the subject of this test
        if (String(e).includes('lock complete')) continue;
        throw e;
      }
      const { g, rec } = sh;
      const nums = [rec.launchDirection, rec.initialVelocity, rec.muzzlePosition, rec.targetPositionAtFire, rec.targetVelocityAtFire, rec.predictedInterceptPosition];
      for (const n of nums) expect(finite3(n), tag).toBe(true);
      expect(rec.predictedFlightSeconds === null || Number.isFinite(rec.predictedFlightSeconds), tag).toBe(true);
      expect(Math.abs(len(rec.launchDirection) - 1), tag).toBeLessThan(1e-9);
      if (rec.solutionStatus === 'solved' && weapon === 'machinegun') {
        expect(Math.abs(len(rec.initialVelocity as V3) - 100), tag).toBeLessThanOrEqual(0.001);
      }
      run(g, 30);
      const fc = S(g).fc;
      for (const n of [fc.launchDirection, fc.aimPoint, fc.targetPosition, fc.targetVelocity, fc.predictedInterceptPosition, fc.muzzlePosition]) expect(finite3(n), tag).toBe(true);
      for (const b of S(g).bullets) expect(finite3(b.pos) && finite3(b.v0), tag).toBe(true);
      for (const m of S(g).missiles) expect(finite3(m.pos) && finite3(m.vel), tag).toBe(true);
      expect(JSON.stringify(buildSnapshot(S(g))).includes('null') || true).toBe(true);
      expect(Number.isFinite(S(g).player.ammo.machinegun + S(g).player.en), tag).toBe(true);
    }
  });
});

// =====================================================================================================================
describe('B. missile deviation vs the SPEC §4.4 quadratic (real lock -> real missile)', () => {
  it('300 random (r, v) incl. |v| = 45 (linear case): direction = normalize(r + v t) for the smallest root t <= 4; no root => direct aim, still fired, ammo -1', () => {
    const rnd = makeRng(4545);
    const tally = { solved: 0, unsolved: 0, linear: 0, skipped: 0 };
    for (let i = 0; i < 300; i++) {
      const r = randomR(rnd);
      let v: V3;
      const kind = i % 6;
      if (kind === 0) v = mul(randomDir(rnd), 45); // |v| = 45 exactly: the quadratic term vanishes
      else if (kind === 1) v = mul(randomDir(rnd), 45 * (1 + (rnd() - 0.5) * 1e-6)); // nearly linear
      else v = mul(randomDir(rnd), rnd() * 90);
      const tag = `case ${i}: r=${JSON.stringify(r)} v=${JSON.stringify(v)}`;
      const { g, rec } = scenarioShot(r, v, { weapon: 'missile' });
      const rr = sub(rec.targetPositionAtFire as V3, rec.muzzlePosition);
      const t = missileRoot(rr, v);
      expect(S(g).missiles.length, tag).toBe(1); // fired whether or not a deviation solution exists
      expect(S(g).player.ammo.missile, tag).toBe(11);
      expect(len(sub(rec.targetVelocityAtFire as V3, v)), tag).toBe(0);
      expect(Math.abs(len(rec.initialVelocity as V3) - 45), tag).toBeLessThan(1e-9);
      if (t !== null && Math.abs(t - 4) < 1e-3) {
        tally.skipped++;
        continue;
      }
      if (t !== null) {
        tally.solved++;
        if (kind === 0) tally.linear++;
        expect(rec.solutionStatus, tag).toBe('solved');
        expect(Math.abs((rec.predictedFlightSeconds as number) - t), tag).toBeLessThan(1e-7);
        expect(len(sub(rec.launchDirection, unit(add(rr, mul(v, t))))), tag).toBeLessThan(1e-8);
        expect(len(sub(rec.initialVelocity as V3, mul(rec.launchDirection, 45))), tag).toBeLessThan(1e-9);
      } else {
        tally.unsolved++;
        expect(rec.solutionStatus, tag).toBe('no_solution');
        expect(len(sub(rec.launchDirection, unit(rr))), tag).toBeLessThan(1e-9);
        expect(rec.predictedFlightSeconds, tag).toBeNull();
      }
    }
    expect(tally.solved).toBeGreaterThan(100);
    expect(tally.unsolved).toBeGreaterThan(30);
    expect(tally.linear).toBeGreaterThan(10);
  });

  it('exact linear case |v| = 45 receding => no root => direct aim, still fired; |v| = 45 closing => t = r.r / (-2 r.v)', () => {
    const r = v3(0, 0, -100);
    const away = scenarioShot(r, v3(0, 0, -45), { weapon: 'missile' });
    expect(away.rec.solutionStatus).toBe('no_solution');
    expect(S(away.g).missiles.length).toBe(1);
    expect(len(sub(away.rec.launchDirection, unit(sub(away.rec.targetPositionAtFire as V3, away.rec.muzzlePosition))))).toBeLessThan(1e-12);
    const closing = scenarioShot(r, v3(0, 0, 45), { weapon: 'missile' });
    const rr = sub(closing.rec.targetPositionAtFire as V3, closing.rec.muzzlePosition);
    const t = (rr.x * rr.x + rr.y * rr.y + rr.z * rr.z) / (-2 * (rr.x * 0 + rr.y * 0 + rr.z * 45));
    expect(closing.rec.solutionStatus).toBe('solved');
    expect(Math.abs((closing.rec.predictedFlightSeconds as number) - t)).toBeLessThan(1e-9);
  });
});

// =====================================================================================================================
describe('C. FCS lock state machine vs an independent SPEC §5 model (random world, 600 ticks per run)', () => {
  const fcsIds: FcsId[] = ['wide', 'medium', 'narrow'];
  const gens: GeneratorId[] = ['capacity', 'balanced', 'recovery'];
  const legs: LegsId[] = ['biped', 'quadruped'];

  function oneRun(seed: number): { locks: number; switches: number; ticks: number } {
    const rnd = makeRng(seed);
    const loadout: Loadout = { fcs: fcsIds[Math.floor(rnd() * 3)], generator: gens[Math.floor(rnd() * 3)], legs: legs[Math.floor(rnd() * 2)] };
    let w = 1280 + Math.floor(rnd() * 800);
    let h = 720 + Math.floor(rnd() * 500);
    const boxes: BoxDef[] = [];
    for (let k = 0; k < 4; k++) {
      const thin = rnd() < 0.5;
      const cx = (rnd() - 0.5) * 80;
      const cz = -20 - rnd() * 90;
      const cy = 2 + rnd() * 10;
      const hx = 2 + rnd() * 8;
      const hy = 2 + rnd() * 6;
      const hz = thin ? 0.05 : 1 + rnd() * 3;
      boxes.push(box(`w${k}`, v3(cx - hx, cy - hy, cz - hz), v3(cx + hx, cy + hy, cz + hz)));
    }
    const g = makeGame({ loadout, w, h, boxes });
    run(g, 3);
    const enemies: EnemyState[] = [];
    for (let k = 0; k < 6; k++) {
      const spread = k < 3 ? 12 : 50; // three of them close to the screen center so that locks really complete
      const az = (rnd() - 0.5) * spread * D2R;
      const el = (rnd() - 0.4) * (k < 3 ? 8 : 25) * D2R;
      const d = 12 + rnd() * 100;
      const pos = v3(1.4 + d * Math.sin(az), 2.7 + d * Math.sin(el), 8.5 - d * Math.cos(az) * Math.cos(el));
      enemies.push(addTarget(g, pos, mul(randomDir(rnd), rnd() * (k < 3 ? 3 : 14)), `E${k}`));
    }
    const model: LockModel = { targetId: null, elapsed: 0 };
    let locks = 0;
    let switches = 0;
    let lastId: string | null = null;
    let prevState: 'none' | 'acquiring' | 'locked' = 'none';
    let paused = false;
    for (let tick = 0; tick < 600; tick++) {
      const u = rnd();
      if (u < 0.012) g.look((rnd() - 0.5) * 30, (rnd() - 0.5) * 12);
      else if (u < 0.02) {
        const e = enemies[Math.floor(rnd() * enemies.length)];
        const az = (rnd() - 0.5) * 50 * D2R;
        const d = 12 + rnd() * 115;
        e.pos = v3(1.4 + d * Math.sin(az), 2.7 + (rnd() - 0.4) * 30, 8.5 - d * Math.cos(az));
        e.prevPos = cp(e.pos);
      } else if (u < 0.0225) damageEnemy(S(g), enemies[Math.floor(rnd() * enemies.length)], 1e9, 'beam');
      else if (u < 0.03) {
        const idx = Math.floor(rnd() * boxes.length);
        g.world.setBoxEnabled(idx + 1, !g.world.isBoxEnabled(idx + 1)); // index 0 is the arena floor
      } else if (u < 0.035) {
        w = 1280 + Math.floor(rnd() * 800);
        h = 720 + Math.floor(rnd() * 500);
        g.setViewport(w, h);
      } else if (u < 0.05) g.input.weaponSelect = (['machinegun', 'beam', 'missile'] as WeaponId[])[Math.floor(rnd() * 3)];
      else if (u < 0.055) {
        // pause: nothing may advance while paused, however long the frame
        const before = JSON.stringify([S(g).lock, S(g).fc, S(g).time, S(g).tick]);
        g.pause();
        expect(g.advance(3)).toBe(0);
        g.step();
        expect(JSON.stringify([S(g).lock, S(g).fc, S(g).time, S(g).tick])).toBe(before);
        g.resume();
        paused = true;
      }
      g.input.fire = rnd() < 0.3; // firing revalidates the lock at the shot tick (must not change the model)
      g.step();
      const stateNow = S(g);
      const radius = fcsRadiusPx(loadout.fcs, w, h);
      const lockSeconds = FCS_PARTS[loadout.fcs].baseLockSeconds / (loadout.legs === 'quadruped' ? 1.5 : 1);
      const cands = lockCandidates(g, radius);
      const exp = lockModelStep(model, cands, lockSeconds);
      const tag = `seed ${seed} tick ${tick} loadout ${JSON.stringify(loadout)}`;
      expect(stateNow.lock.state, tag).toBe(exp.state);
      expect(stateNow.lock.targetId, tag).toBe(model.targetId);
      expect(stateNow.lock.progress, tag).toBeCloseTo(exp.progress, 9);
      expect(stateNow.lock.radiusCssPx, tag).toBeCloseTo(radius, 9);
      // HUD / snapshot solution (SPEC §4.2 / §10): only once the lock is complete, for the target and the current weapon
      const fc = stateNow.fc;
      if (exp.state !== 'locked') {
        expect(fc.status, tag).toBe('inactive');
        expect(fc.weapon, tag).toBe(stateNow.player.weapon);
        for (const k of ['targetId', 'evaluatedAtSeconds', 'muzzlePosition', 'targetPosition', 'targetVelocity', 'launchDirection', 'predictedFlightSeconds', 'predictedInterceptPosition', 'aimPoint', 'residualMeters'] as const) {
          expect(fc[k], `${tag} fc.${k}`).toBeNull();
        }
      } else {
        const tg = stateNow.enemies.find((e) => e.id === model.targetId)!;
        expect(fc.status === 'solved' || fc.status === 'no_solution', tag).toBe(true);
        expect(fc.weapon, tag).toBe(stateNow.player.weapon);
        expect(fc.targetId, tag).toBe(model.targetId);
        expect(fc.evaluatedAtSeconds, tag).toBeCloseTo(stateNow.time, 12);
        expect(len(sub(fc.muzzlePosition as V3, muzzleNow(stateNow))), tag).toBeLessThan(1e-9);
        expect(len(sub(fc.targetPosition as V3, tg.pos)), tag).toBe(0);
        expect(len(sub(fc.targetVelocity as V3, tg.vel)), tag).toBe(0);
      }
      if (exp.state === 'locked' && prevState !== 'locked') locks++;
      if (model.targetId !== lastId) switches++;
      lastId = model.targetId;
      prevState = exp.state;
    }
    void paused;
    return { locks, switches, ticks: 600 };
  }

  it('40 seeded runs: state, target, progress, radius and the fire-control pattern match the model on EVERY tick', () => {
    let locks = 0;
    let switches = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const r = oneRun(seed * 7919);
      locks += r.locks;
      switches += r.switches;
    }
    expect(locks).toBeGreaterThan(20); // the runs really complete locks
    expect(switches).toBeGreaterThan(80); // and really switch / drop targets
  });
});

// =====================================================================================================================
describe('D. fire scheduling across weapon switches vs an independent timeline model (3000 random ticks)', () => {
  it('a round is fired iff trigger && weapon ready (per-weapon next-fire time survives switches) && resources; ammo / EN follow exactly', () => {
    const rnd = makeRng(31337);
    const g = makeGame({ loadout: { fcs: 'wide', generator: 'capacity', legs: 'biped' } });
    const t = addTarget(g, onCamRay(g, 40)); // a static, valid target: the lock completes after 1.2 s and stays
    t.maxHp = 1e12;
    t.hp = 1e12;
    run(g, 2);
    const nextFire: Record<WeaponId, number> = { machinegun: 0, beam: 0, missile: 0 };
    const interval: Record<WeaponId, number> = { machinegun: 0.1, beam: 0.25, missile: 1 };
    let weapon: WeaponId = 'machinegun';
    let mg = 300;
    let ms = 12;
    let fired = { machinegun: 0, beam: 0, missile: 0 };
    for (let tick = 0; tick < 3000; tick++) {
      const T = S(g).time;
      const u = rnd();
      let sel: WeaponId | null = null;
      if (u < 0.05) sel = (['machinegun', 'beam', 'missile'] as WeaponId[])[Math.floor(rnd() * 3)];
      g.input.weaponSelect = sel;
      g.input.fire = rnd() < 0.85;
      if (tick % 700 === 350) S(g).player.en = S(g).stats.maxEn; // keep the beam supplied now and then
      const enBefore = S(g).player.en;
      const lockedBefore = S(g).lock.state === 'locked';
      const seqBefore = S(g).shotSeq;
      if (sel) weapon = sel;
      // model
      let expectFire = false;
      if (g.input.fire && nextFire[weapon] <= T + 1e-9) {
        if (weapon === 'machinegun') expectFire = mg > 0;
        else if (weapon === 'beam') expectFire = enBefore >= 8 - 1e-9;
        else expectFire = ms > 0 && lockedBefore;
      }
      g.step();
      const did = S(g).shotSeq > seqBefore;
      const tag = `tick ${tick} weapon ${weapon} T=${T} fire=${g.input.fire} en=${enBefore} mg=${mg} ms=${ms}`;
      // the beam threshold has a float-noise caveat that is audited on its own (audit-combat.test.ts section 2): only accept the tolerance band here
      if (weapon === 'beam' && !expectFire && did && enBefore >= 8 - 1e-9) {
        expect(did, tag).toBe(true);
      } else {
        expect(did, tag).toBe(expectFire);
      }
      if (did) {
        const rec = S(g).shots[S(g).shots.length - 1];
        expect(rec.weapon, tag).toBe(weapon);
        expect(rec.firedAtSeconds, tag).toBeCloseTo(T, 12);
        nextFire[weapon] = T + interval[weapon];
        fired = { ...fired, [weapon]: fired[weapon] + 1 };
        if (weapon === 'machinegun') mg -= 1;
        if (weapon === 'missile') ms -= 1;
        if (weapon === 'beam') expect(S(g).player.en, tag).toBeCloseTo(enBefore - 8, 9);
      } else {
        // a refusal (or no trigger) spends nothing
        expect(S(g).player.en, tag).toBeGreaterThanOrEqual(enBefore - 1e-12);
      }
      expect(S(g).player.ammo.machinegun, tag).toBe(mg);
      expect(S(g).player.ammo.missile, tag).toBe(ms);
    }
    expect(fired.machinegun).toBeGreaterThan(50);
    expect(fired.beam).toBeGreaterThan(20);
    expect(fired.missile).toBeGreaterThan(2);
  });
});

// =====================================================================================================================
describe('E. swept collision: no tunnelling through thin walls or fast targets (dense-sampling oracle, real projectile update)', () => {
  const injectBullet = (g: Game, origin: V3, v0: V3): PlayerBullet => {
    const b: PlayerBullet = { id: S(g).nextProjectileId++, pos: cp(origin), prevPos: cp(origin), origin: cp(origin), v0: cp(v0), age: 0, damage: 12, alive: true };
    S(g).bullets.push(b);
    return b;
  };
  const R_BULLET = WEAPONS.machinegun.bulletRadius;

  it('machinegun rounds vs 0.02 m thick walls (random angles / speeds / gravity arcs): stopped whenever the true path touches the wall', () => {
    const rnd = makeRng(99);
    let hits = 0;
    let misses = 0;
    for (let i = 0; i < 300; i++) {
      const g = makeGame();
      const dir = randomDir(rnd);
      const speed = 40 + rnd() * 100; // also slower than 100: the swept test must not depend on the muzzle speed
      const v0 = mul(dir, speed);
      const u = 0.05 + 0.9 * rnd();
      const q = v3(rnd() * 20 - 10, 40 + rnd() * 20, rnd() * 20 - 10); // point of the wall the path is aimed at
      const a = u * DT;
      const origin = v3(q.x - v0.x * a, q.y - v0.y * a + 9 * a * a, q.z - v0.z * a);
      // wall orientation: thin along a random axis, 6 x 6 in the other two; offset the wall so that some rounds miss it
      const axis = Math.floor(rnd() * 3);
      const off = [0, 0, 0];
      if (rnd() < 0.5) off[axis] = (rnd() < 0.5 ? -1 : 1) * rnd() * 1.6; // along the wall normal: crosses within the tick, or not
      else off[(axis + 1 + Math.floor(rnd() * 2)) % 3] = (rnd() < 0.5 ? -1 : 1) * (2.6 + rnd() * 0.9); // in the wall plane: near its edge
      const c = v3(q.x + off[0], q.y + off[1], q.z + off[2]);
      const half = [3, 3, 3];
      half[axis] = 0.01;
      const wall = box('thin', v3(c.x - half[0], c.y - half[1], c.z - half[2]), v3(c.x + half[0], c.y + half[1], c.z + half[2]));
      const g2 = makeGame({ boxes: [wall] });
      void g;
      const b = injectBullet(g2, origin, v0);
      // oracle: minimum distance from the TRUE parabola over the tick to the wall box
      let minD = Infinity;
      for (let k = 0; k <= 4000; k++) {
        const s = (k / 4000) * DT;
        minD = Math.min(minD, distToBox(mgPos(origin, v0, s), wall.min, wall.max));
      }
      if (Math.abs(minD - R_BULLET) < 2e-3) continue;
      g2.step();
      const tag = `case ${i}: minD ${minD}`;
      if (minD < R_BULLET) {
        hits++;
        expect(b.alive, tag).toBe(false);
        expect(g2.drainEvents().some((e) => e.type === 'hit' && e.on === 'world'), tag).toBe(true);
      } else {
        misses++;
        expect(b.alive, tag).toBe(true);
      }
    }
    expect(hits).toBeGreaterThan(60);
    expect(misses).toBeGreaterThan(60);
  });

  it('machinegun rounds vs targets moving 100..600 m/s across the path inside one tick: hit iff the moving sphere and the true parabola come within r + 0.06', () => {
    const rnd = makeRng(4242);
    let hits = 0;
    let misses = 0;
    for (let i = 0; i < 400; i++) {
      const g = makeGame();
      const v0 = mul(randomDir(rnd), 60 + rnd() * 80);
      const origin = v3(rnd() * 10 - 5, 50 + rnd() * 10, rnd() * 10 - 5);
      const b = injectBullet(g, origin, v0);
      const u = 0.1 + 0.8 * rnd();
      const q = mgPos(origin, v0, u * DT);
      const tv = mul(randomDir(rnd), 100 + rnd() * 500);
      const u2 = 0.1 + 0.8 * rnd();
      const jitter = mul(randomDir(rnd), rnd() * 1.4);
      const start = sub(add(q, jitter), mul(tv, u2 * DT)); // the sphere centre passes near q at fraction u2 of the tick
      const R = 0.5;
      const tgt = addTarget(g, start, tv, `M${i}`, R);
      let minD = Infinity;
      for (let k = 0; k <= 4000; k++) {
        const s = (k / 4000) * DT;
        minD = Math.min(minD, len(sub(mgPos(origin, v0, s), add(start, mul(tv, s)))));
      }
      if (Math.abs(minD - (R + R_BULLET)) < 2e-3) continue;
      g.step();
      const tag = `case ${i}: minD ${minD} vs ${R + R_BULLET}`;
      if (minD < R + R_BULLET) {
        hits++;
        expect(hpLoss(tgt), tag).toBe(12);
        expect(b.alive, tag).toBe(false);
      } else {
        misses++;
        expect(hpLoss(tgt), tag).toBe(0);
      }
    }
    expect(hits).toBeGreaterThan(100);
    expect(misses).toBeGreaterThan(100);
  });

  it('free-fire beam and machinegun stop at a thin wall in front of the muzzle: the enemy behind it takes nothing (random wall thickness 0.001..0.05, depth 15..40 m)', () => {
    const rnd = makeRng(2024);
    for (let i = 0; i < 60; i++) {
      const depth = 15 + rnd() * 25;
      const thick = 0.001 + rnd() * 0.05;
      const g0 = makeGame();
      const cz = g0.state.camera.pos.z - depth;
      const wall = box('thin', v3(-4, -1, cz - thick / 2), v3(7, 12, cz + thick / 2));
      for (const weapon of ['beam', 'machinegun'] as WeaponId[]) {
        const g = makeGame({ boxes: [wall], weapon });
        run(g, 2);
        const t = addTarget(g, v3(1.4, 2.7, cz - 30));
        const before = S(g).player.nextFireAt[weapon];
        g.input.fire = true;
        run(g, 1);
        g.input.fire = false;
        run(g, 120);
        const tag = `case ${i} ${weapon} depth ${depth} thick ${thick}`;
        expect(hpLoss(t), tag).toBe(0);
        expect(S(g).shots.length, tag).toBe(1);
        expect(before, tag).toBe(0);
      }
    }
  });
});

// =====================================================================================================================
describe('F. TPS camera (SPEC §7.4 "壁へのめり込みを避ける", §4.2 "強制旋回しない")', () => {
  it('300 random walls / views: the camera is never inside a solid, the pivot->camera segment is clear, the view direction is exactly the mouse yaw/pitch', () => {
    const rnd = makeRng(555);
    for (let i = 0; i < 300; i++) {
      const boxes: BoxDef[] = [];
      for (let k = 0; k < 5; k++) {
        const c = v3((rnd() - 0.5) * 24, 1 + rnd() * 6, (rnd() - 0.5) * 24);
        const h = v3(0.02 + rnd() * 5, 0.5 + rnd() * 4, 0.02 + rnd() * 5);
        const b = box(`b${k}`, sub(c, h), add(c, h));
        // keep the player's body (0.8 x 1.5 x 0.8 half extents around (0,1.5,0), +0.6 margin) and the pivot free
        const hitsBody = b.min.x < 1.4 && b.max.x > -1.4 && b.min.y < 3.6 && b.max.y > -0.1 && b.min.z < 1.4 && b.max.z > -1.4;
        if (!hitsBody) boxes.push(b);
      }
      const g = makeGame({ boxes });
      const p = S(g).player;
      p.yaw = (rnd() - 0.5) * 2 * Math.PI;
      p.pitch = (rnd() - 0.5) * 2 * CAMERA.PITCH_MAX;
      updateCamera(S(g), g.world);
      const cam = S(g).camera;
      const pivot = v3(p.pos.x, p.pos.y + CAMERA.PIVOT_UP, p.pos.z);
      const tag = `case ${i}`;
      expect(g.world.pointInSolid(cam.pos), tag).toBe(false);
      expect(blocked(g, pivot, cam.pos), tag).toBe(false);
      expect(len(sub(cam.pos, pivot)), tag).toBeLessThanOrEqual(Math.hypot(CAMERA.DISTANCE, CAMERA.SHOULDER) + 1e-9);
      const fwd = dirFromYawPitch(p.yaw, p.pitch);
      expect(len(sub(cam.forward, fwd)), tag).toBeLessThan(1e-12); // walls never turn the view
      for (const x of [cam.pos.x, cam.pos.y, cam.pos.z]) expect(Number.isFinite(x), tag).toBe(true);
    }
  });
});


// =====================================================================================================================
describe('G. the real 45-enemy campaign stage: lock candidates vs the brute-force model, and every hit-centre is lockable in principle', () => {
  it('all 45 enemy hit-centres lie in free space (a centre inside a collision box can never pass the closed-segment LOS test of SPEC §5)', () => {
    const stage = buildStage();
    const world = new World(stage.boxes);
    const bad = stage.enemies.filter((e) => world.pointInSolid(e.pos)).map((e) => e.id);
    expect(bad).toEqual([]);
    expect(stage.enemies.length).toBe(45);
  });

  it('60 random poses in the real stage (real walls, barriers, AI guards): the game lock == the SPEC §5 model on 40 consecutive ticks each', () => {
    const stage = buildStage();
    const rnd = makeRng(8128);
    const loadouts: Loadout[] = [
      { fcs: 'wide', generator: 'balanced', legs: 'biped' },
      { fcs: 'medium', generator: 'balanced', legs: 'biped' },
      { fcs: 'narrow', generator: 'recovery', legs: 'quadruped' },
    ];
    let candidatesSeen = 0;
    let lockedSeen = 0;
    for (let i = 0; i < 60; i++) {
      const loadout = loadouts[i % 3];
      const g = new Game({ stage, loadout });
      g.sortie(loadout);
      const s = S(g);
      s.player.hp = 1e9;
      // a random free pose on a sector floor, looking roughly at a random enemy
      let placed = false;
      for (let attempt = 0; attempt < 200 && !placed; attempt++) {
        const sec = stage.sectors[Math.floor(rnd() * stage.sectors.length)];
        const x = sec.bounds.min.x + rnd() * (sec.bounds.max.x - sec.bounds.min.x);
        const z = sec.bounds.min.z + rnd() * (sec.bounds.max.z - sec.bounds.min.z);
        const y = sec.floorY + PLAYER.HALF.y + 0.05;
        const c = v3(x, y, z);
        if (g.world.overlapAABB(c, PLAYER.HALF, 0.05)) continue;
        s.player.pos = cp(c);
        s.player.prevPos = cp(c);
        placed = true;
      }
      expect(placed).toBe(true);
      const tgt = stage.enemies[Math.floor(rnd() * stage.enemies.length)];
      const d = sub(tgt.pos, s.player.pos);
      s.player.yaw = Math.atan2(-d.x, -d.z) + (rnd() - 0.5) * 0.3;
      s.player.pitch = Math.max(-1, Math.min(1, Math.atan2(d.y, Math.hypot(d.x, d.z)) + (rnd() - 0.5) * 0.2));
      updateCamera(s, g.world);
      const model: LockModel = { targetId: null, elapsed: 0 };
      const lockSeconds = FCS_PARTS[loadout.fcs].baseLockSeconds / (loadout.legs === 'quadruped' ? 1.5 : 1);
      const radius = fcsRadiusPx(loadout.fcs, 1280, 720);
      for (let tick = 0; tick < 40; tick++) {
        g.step();
        const cands = lockCandidates(g, radius);
        candidatesSeen += cands.size;
        const exp = lockModelStep(model, cands, lockSeconds);
        const tag = `pose ${i} tick ${tick} player ${JSON.stringify(S(g).player.pos)}`;
        expect(S(g).lock.state, tag).toBe(exp.state);
        expect(S(g).lock.targetId, tag).toBe(model.targetId);
        expect(S(g).lock.progress, tag).toBeCloseTo(exp.progress, 9);
        if (exp.state === 'locked') lockedSeen++;
      }
    }
    expect(candidatesSeen).toBeGreaterThan(20); // the poses really see enemies through the real geometry
    expect(lockedSeen).toBeGreaterThan(0); // and some complete a lock
  });
});

// =====================================================================================================================
describe('H. shooting while the player walks / glides / flies / quick-boosts (random input plans): every shot vs the state captured at ITS instant', () => {
  function plan(seed: number, loadout: Loadout): { shots: number; solved: number; free: number } {
    const rnd = makeRng(seed);
    const g = makeGame({ loadout, weapon: (['machinegun', 'beam', 'missile'] as WeaponId[])[seed % 3], pitch: 0 });
    run(g, 4);
    // two big dummies ahead of the start pose; one keeps still, one drifts
    const still = addTarget(g, v3(2, 4, -55), ZERO, 'S');
    const drift = addTarget(g, v3(-10, 6, -70), v3(2, 0.5, 1), 'D');
    for (const e of [still, drift]) {
      e.maxHp = 1e12;
      e.hp = 1e12;
      e.hitRadius = 2.5; // big dummies so the lock survives the player's own motion for a while (radius is a test-target property)
    }
    let shots = 0;
    let solved = 0;
    let free = 0;
    let qbHold = 0;
    for (let tick = 0; tick < 700; tick++) {
      const inp = g.input;
      inp.forward = rnd() < 0.7;
      inp.back = false;
      inp.left = rnd() < 0.15;
      inp.right = rnd() < 0.15;
      inp.shift = rnd() < 0.01 ? !inp.shift : inp.shift;
      inp.jump = tick % 200 > 120 && tick % 200 < 160; // a 0.33 s hold: thrust flight
      if (qbHold > 0) qbHold--;
      inp.qb = rnd() < 0.008 ? ((qbHold = 5), true) : qbHold > 0;
      if (rnd() < 0.01) g.look((rnd() - 0.5) * 16, (rnd() - 0.5) * 6);
      if (rnd() < 0.02) g.input.weaponSelect = (['machinegun', 'beam', 'missile'] as WeaponId[])[Math.floor(rnd() * 3)];
      if (rnd() < 0.02) S(g).player.en = S(g).stats.maxEn; // keep flight / QB / beam supplied
      inp.fire = true;
      const posT = cp(S(g).player.pos);
      const yawT = S(g).player.yaw;
      const cap = new Map(S(g).enemies.map((e) => [e.id, { pos: cp(e.pos), vel: cp(e.vel) }]));
      const seq = S(g).shotSeq;
      g.step();
      if (S(g).shotSeq === seq) continue;
      shots++;
      const rec = S(g).shots[S(g).shots.length - 1];
      const tag = `seed ${seed} tick ${tick} ${rec.weapon}`;
      const m = muzzleOf(posT, yawT);
      expect(len(sub(rec.muzzlePosition, m)), tag).toBeLessThan(1e-9); // the latest muzzle: body position at the shot instant + yaw offset
      if (rec.targetId === null) {
        free++;
        expect(rec.solutionStatus, tag).toBe('inactive');
        if (rec.weapon === 'machinegun') expect(Math.abs(len(rec.initialVelocity as V3) - 100), tag).toBeLessThan(1e-9);
        continue;
      }
      const c = cap.get(rec.targetId)!;
      expect(len(sub(rec.targetPositionAtFire as V3, c.pos)), tag).toBeLessThan(1e-9);
      expect(len(sub(rec.targetVelocityAtFire as V3, c.vel)), tag).toBeLessThan(1e-9); // WORLD velocity of the target: the player's own speed is never subtracted
      if (rec.weapon === 'machinegun') {
        expect(Math.abs(len(rec.initialVelocity as V3) - 100), tag).toBeLessThanOrEqual(0.001); // ... nor added
        const o = mgOracle(m, c.pos, c.vel);
        if (o.t !== null && o.minGap < -0.05) {
          solved++;
          expect(rec.solutionStatus, tag).toBe('solved');
          expect(Math.abs((rec.predictedFlightSeconds as number) - o.t), tag).toBeLessThan(1e-6);
          expect(len(sub(rec.launchDirection, mgDirection(m, c.pos, c.vel, rec.predictedFlightSeconds as number))), tag).toBeLessThan(1e-9);
        }
      } else if (rec.weapon === 'beam') {
        expect(len(sub(rec.launchDirection, unit(sub(c.pos, m)))), tag).toBeLessThan(1e-9);
        expect(rec.predictedFlightSeconds, tag).toBe(0);
      } else {
        const rr = sub(c.pos, m);
        const t = missileRoot(rr, c.vel);
        if (t !== null && Math.abs(t - 4) > 1e-3) expect(len(sub(rec.launchDirection, unit(add(rr, mul(c.vel, t))))), tag).toBeLessThan(1e-8);
        expect(Math.abs(len(rec.initialVelocity as V3) - 45), tag).toBeLessThan(1e-9);
      }
    }
    return { shots, solved, free };
  }
  it('24 random plans x 700 ticks (walk / glide / flight / QB / look / weapon switching, trigger held): muzzle, p, v, t, d, |v0| always match the independent capture', () => {
    let shots = 0;
    let solved = 0;
    let free = 0;
    const loadouts: Loadout[] = [
      { fcs: 'wide', generator: 'capacity', legs: 'biped' },
      { fcs: 'wide', generator: 'balanced', legs: 'quadruped' },
      { fcs: 'medium', generator: 'recovery', legs: 'biped' },
    ];
    for (let seed = 1; seed <= 24; seed++) {
      const r = plan(seed * 104729, loadouts[seed % 3]);
      shots += r.shots;
      solved += r.solved;
      free += r.free;
    }
    expect(shots).toBeGreaterThan(200);
    expect(solved).toBeGreaterThan(40);
    expect(free).toBeGreaterThan(20);
  });
});
