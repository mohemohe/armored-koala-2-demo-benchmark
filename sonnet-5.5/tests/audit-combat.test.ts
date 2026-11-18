/**
 * ADVERSARIAL SPEC AUDIT: SPEC §4 (weapons, FCS correction, beam, missile, occlusion / collision / accuracy, §4.6 tests),
 * §5 (FCS lock) and the §10 fireControl / recentPlayerShots / lock semantics.
 *
 * Stance: "the implementation violates the SPEC". Every clause is turned into an executable check on the REAL Game
 * (Game.step -> playerFireStep -> projectiles -> swept collision -> damageEnemy, updateFcs, buildSnapshot). Oracles are written
 * from the SPEC text in tests/audit-combat-helpers.ts and share no code with the implementation. Tests are never loosened to fit
 * the implementation; a failing test is a finding. Tests named "[AMBIGUITY]" pin the SPEC-preferred reading of a clause that can
 * be read two ways (they were written with it.fails: they passed while the implementation deviated and had to start failing once
 * it was fixed). The only one, the thin wall between body and muzzle, is fixed (playerFireStep stops the shot at that wall), so it
 * is now a plain it().
 *
 * The randomised / differential audits live in tests/audit-combat-fuzz.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { CAMERA, ENEMIES, FCS, FCS_PARTS, GENERATOR_PARTS, GRAVITY, LEGS_PARTS, LIMITS, WEAPONS } from '../src/config';
import type { GeneratorId, LegsId } from '../src/config';
import { buildSnapshot } from '../src/sim/bench';
import { playerMuzzlePosition, updateCamera } from '../src/sim/camera';
import { damageEnemy } from '../src/sim/combat';
import { Game } from '../src/sim/game';
import { computeEffectiveStats } from '../src/sim/stats';
import { createScenarioGame } from '../src/sim/scenario';
import { buildTestArenaStage } from '../src/sim/testArena';
import type { EnemySpawn, GameEvent, GameState, Loadout, Missile, PlayerBullet, V3 } from '../src/sim/types';
import {
  DT, SCEN_M, ZERO, add, addTarget, angleBetween, blocked, box, cp, len, lockOn, lockTicks, makeGame, mgDirection, mgF, mgGap, mgOracle,
  mgPos, mgResidualOf, missileRoot, mul, muzzleNow, onCamRay, pull, raySphereT, run, scenarioShot, sub, teleport, unit, v3,
} from './audit-combat-helpers';

const S = (g: Game): GameState => g.state;
const evs = <T extends GameEvent['type']>(g: Game, type: T): Extract<GameEvent, { type: T }>[] =>
  S(g).events.filter((e): e is Extract<GameEvent, { type: T }> => e.type === type);
const clearEvents = (g: Game): void => void g.drainEvents();
const select = (g: Game, w: 'machinegun' | 'beam' | 'missile'): void => {
  g.input.weaponSelect = w;
};
const hpLoss = (e: { hp: number }): number => 1e6 - e.hp;

// =====================================================================================================================
describe('0. SPEC numbers in config.ts (a silent change here would invalidate every other test)', () => {
  it('§4.1 weapon table', () => {
    const mg = WEAPONS.machinegun;
    expect([mg.damage, mg.interval, mg.totalAmmo, mg.enCost, mg.muzzleSpeed, mg.gravity, mg.lifetime, mg.needsLock]).toEqual([12, 0.1, 300, 0, 100, 18, 2, false]);
    const bm = WEAPONS.beam;
    expect([bm.damage, bm.interval, bm.enCost, bm.range, bm.needsLock]).toEqual([40, 0.25, 8, 120, false]);
    const ms = WEAPONS.missile;
    expect([ms.damage, ms.interval, ms.totalAmmo, ms.enCost, ms.speed, ms.turnRateDeg, ms.lifetime, ms.needsLock]).toEqual([180, 1, 12, 0, 45, 120, 4, true]);
    expect(GRAVITY).toBe(18);
  });
  it('§4.3 / §4.4 solver limits: player FCS uses 2 s (machinegun) / 4 s (missile), NOT the enemy 1.20 s cap; residual 0.01, speed error 0.001', () => {
    expect(FCS.MG_MAX_T).toBe(2);
    expect(FCS.MISSILE_MAX_T).toBe(4);
    expect(ENEMIES.MAX_PREDICT_T).toBe(1.2);
    expect(FCS.MAX_RESIDUAL_M).toBe(0.01);
    expect(FCS.MAX_SPEED_ERR).toBe(0.001);
    expect(FCS.RANGE).toBe(120);
  });
  it('§5 / §6 FCS circle ratios, lock times and leg lock-speed multipliers', () => {
    expect(FCS_PARTS.wide.radiusRatio).toBe(0.3);
    expect(FCS_PARTS.medium.radiusRatio).toBe(0.2);
    expect(FCS_PARTS.narrow.radiusRatio).toBe(0.1);
    expect([FCS_PARTS.wide.baseLockSeconds, FCS_PARTS.medium.baseLockSeconds, FCS_PARTS.narrow.baseLockSeconds]).toEqual([1.2, 0.8, 0.4]);
    expect([LEGS_PARTS.biped.lockSpeedMult, LEGS_PARTS.quadruped.lockSpeedMult]).toEqual([1, 1.5]);
    // lock speed = 1 / lock time: radius is inversely related to lock speed (0.1D fastest, 0.3D slowest)
    expect(FCS_PARTS.narrow.baseLockSeconds).toBeLessThan(FCS_PARTS.medium.baseLockSeconds);
    expect(FCS_PARTS.medium.baseLockSeconds).toBeLessThan(FCS_PARTS.wide.baseLockSeconds);
    expect(computeEffectiveStats({ fcs: 'medium', generator: 'balanced', legs: 'quadruped' }).lockSeconds).toBeCloseTo(0.8 / 1.5, 12);
    expect(GENERATOR_PARTS.balanced.maxEn).toBe(120);
    expect(LIMITS.RECENT_SHOTS).toBe(32);
    expect(CAMERA.AIM_RANGE).toBeGreaterThan(120);
  });
});

// =====================================================================================================================
describe('1. machinegun (§4.1 / §4.3 last paragraph)', () => {
  it('cadence: a round every 12 ticks (0.10 s) while the trigger is held; the ammo falls by exactly the number of rounds', () => {
    const g = makeGame();
    run(g, 5);
    const t0 = S(g).time;
    g.input.fire = true;
    run(g, 360); // 3.0 s
    g.input.fire = false;
    expect(S(g).shotSeq).toBe(30);
    expect(S(g).player.ammo.machinegun).toBe(300 - 30);
    for (const [k, s] of S(g).shots.entries()) expect(s.firedAtSeconds - t0, `shot ${k}`).toBeCloseTo(k * 0.1, 9);
    expect(S(g).player.en).toBe(S(g).stats.maxEn); // machinegun costs no EN
    expect(S(g).player.mv.lastEnSpentAt).toBeNull();
  });

  it('free fire while quick-boosting: |v0| = 100 in the WORLD frame (no inherited player velocity), launched from the muzzle toward the camera-center point, no gravity compensation', () => {
    const g = makeGame({ pitch: -0.05, yaw: 0.7 });
    run(g, 6);
    const cam = cp(S(g).camera.pos);
    const fwd = cp(S(g).camera.forward);
    const m = muzzleNow(S(g));
    // camera-center ray meets the arena floor (top y = 0): that is the free-fire aim point (SPEC §4.5)
    const tHit = -cam.y / fwd.y;
    const aim = add(cam, mul(fwd, tHit));
    expect(aim.y).toBeCloseTo(0, 6);
    g.input.forward = true;
    g.input.qb = true; // QB starts in the shot tick: player speed 80 m/s
    g.input.fire = true;
    g.step();
    g.input.qb = false;
    g.input.fire = false;
    const rec = S(g).shots[0];
    expect(Math.hypot(S(g).player.vel.x, S(g).player.vel.z)).toBeGreaterThan(50); // it really moves fast
    expect(len(sub(rec.muzzlePosition, m))).toBeLessThan(1e-9); // the muzzle at the shot instant, before the tick's movement
    expect(len(sub(rec.launchDirection, unit(sub(aim, m))))).toBeLessThan(1e-6);
    const v0 = rec.initialVelocity as V3;
    expect(Math.abs(len(v0) - 100)).toBeLessThan(1e-9);
    expect(len(sub(v0, mul(rec.launchDirection, 100)))).toBeLessThan(1e-9);
    expect(rec.solutionStatus).toBe('inactive');
    // flight = m + v0 a + 0.5 g a^2 only (no homing / no player velocity / no gravity double counting)
    const b = S(g).bullets[0] as PlayerBullet;
    let dev = 0;
    for (let i = 0; i < 25 && b.alive; i++) {
      dev = Math.max(dev, len(sub(b.pos, mgPos(rec.muzzlePosition, v0, b.age))));
      g.step();
    }
    expect(dev).toBeLessThan(1e-9);
  });

  const lifetimeCase = (ageCenter: number) => {
    const g = makeGame({ pitch: 0.35 });
    run(g, 5);
    pull(g, 1);
    const rec = S(g).shots[0];
    const v0 = rec.initialVelocity as V3;
    const b = S(g).bullets[0] as PlayerBullet;
    const tgt = addTarget(g, mgPos(rec.muzzlePosition, v0, ageCenter));
    expect(S(g).lock.state).toBe('none'); // > 120 m away: the FCS ignores it (free fire)
    let ticks = 1; // the spawn tick already advanced the bullet by one dt
    while (b.alive && ticks < 400) {
      g.step();
      ticks++;
    }
    return { g, b, tgt, ticks };
  };
  it('the LAST interval before the 2 s lifetime end is collision-checked before the bullet is deleted (target reachable only in that interval)', () => {
    // contact starts about 0.0058 s before the centre passes: contact age ~1.9932 > 1.99167 = start of the last tick
    const { b, tgt, ticks } = lifetimeCase(1.999);
    expect(hpLoss(tgt)).toBe(12);
    expect(b.age).toBeGreaterThan(1.9917);
    expect(ticks).toBeLessThanOrEqual(240);
  });
  it('a bullet that never touches anything lives exactly 2 s = 240 ticks, then it is gone; a target only reachable after 2 s is not hit', () => {
    const { g, b, tgt, ticks } = lifetimeCase(2.03);
    expect(hpLoss(tgt)).toBe(0);
    expect(ticks).toBe(240);
    expect(b.age).toBeCloseTo(2, 9);
    expect(S(g).bullets.length).toBe(0);
  });
});

// =====================================================================================================================
describe('2. beam (§4.1 / §4.4)', () => {
  /** free-fire beam at a radius-0.5 target on the camera-center ray whose ENTRY point lies `entry` m from the muzzle */
  function beamAtEntry(entry: number): { hit: boolean; entryActual: number } {
    const g = makeGame({ weapon: 'beam' });
    run(g, 3);
    const cam = S(g).camera;
    const m = muzzleNow(S(g));
    const R = 0.5;
    const entryFor = (D: number): number => {
      const center = onCamRay(g, D);
      const aim = add(cam.pos, mul(cam.forward, D - R)); // the camera-center ray meets the sphere here (free fire aim point)
      return raySphereT(m, unit(sub(aim, m)), center, R) as number;
    };
    let lo = 60;
    let hi = 200;
    for (let i = 0; i < 100; i++) {
      const mid = 0.5 * (lo + hi);
      if (entryFor(mid) < entry) lo = mid;
      else hi = mid;
    }
    const D = 0.5 * (lo + hi);
    const t = addTarget(g, onCamRay(g, D));
    pull(g, 1); // tick 0 of the lock: nobody is locked, the beam is a free-fire beam
    return { hit: hpLoss(t) === 40, entryActual: entryFor(D) };
  }
  it('range is 120 m from the muzzle to the FIRST contact: an entry point at 119.9 m is hit (40), one at 120.1 m is not', () => {
    const near = beamAtEntry(119.9);
    expect(near.entryActual).toBeCloseTo(119.9, 6);
    expect(near.hit).toBe(true);
    const far = beamAtEntry(120.1);
    expect(far.entryActual).toBeCloseTo(120.1, 6);
    expect(far.hit).toBe(false);
  });

  it('one shot damages one enemy once, even where two enemy spheres overlap on the ray (40 in total)', () => {
    const g = makeGame({ weapon: 'beam' });
    run(g, 3);
    const a = addTarget(g, onCamRay(g, 40), ZERO, 'A');
    const b = addTarget(g, add(onCamRay(g, 40.4), v3(0, 0.1, 0)), ZERO, 'B'); // overlapping sphere behind / beside
    clearEvents(g);
    pull(g, 1);
    expect(hpLoss(a) + hpLoss(b)).toBe(40);
    expect(evs(g, 'beamFire').length).toBe(1);
    expect(evs(g, 'hit').filter((e) => e.on === 'enemy').length).toBe(1);
  });

  it('EN < 8: no beam, and NOTHING changes (EN, EN-spent time, next-fire time, shot record, ids); the wait is not started, so the beam fires on the first tick EN reaches 8', () => {
    const g = makeGame({ weapon: 'beam' });
    run(g, 3);
    const s = S(g);
    s.player.en = 7.5;
    s.player.mv.lastEnSpentAt = s.time; // no regeneration while we look
    const before = JSON.stringify({ en: s.player.en, spent: s.player.mv.lastEnSpentAt, next: s.player.nextFireAt, seq: s.shotSeq, id: s.nextProjectileId, shots: s.shots });
    clearEvents(g);
    pull(g, 30);
    expect(JSON.stringify({ en: s.player.en, spent: s.player.mv.lastEnSpentAt, next: s.player.nextFireAt, seq: s.shotSeq, id: s.nextProjectileId, shots: s.shots })).toBe(before);
    expect(evs(g, 'beamFire').length).toBe(0);
    s.player.en = 8;
    const t = s.time;
    pull(g, 1);
    expect(s.shots.length).toBe(1);
    expect(s.shots[0].firedAtSeconds).toBeCloseTo(t, 12); // immediately: the refusals did not push the timer
    expect(s.player.en).toBe(0);
    expect(s.player.mv.lastEnSpentAt).toBeCloseTo(t, 12);
    expect(s.player.nextFireAt.beam).toBeCloseTo(t + 0.25, 12);
  });

  const legsFor = (l: LegsId): number => LEGS_PARTS[l].regenMult;
  for (const gen of ['capacity', 'balanced', 'recovery'] as GeneratorId[]) {
    for (const legs of ['biped', 'quadruped'] as LegsId[]) {
      it(`EN exactly 8 is enough: ${gen}/${legs} regenerates from 0 and the beam fires on the tick where EN reaches 8 (thresholds carry 1e-9 tolerance, ARCH §3)`, () => {
        const loadout: Loadout = { fcs: 'medium', generator: gen, legs };
        const g = makeGame({ loadout, weapon: 'beam' });
        run(g, 3);
        const s = S(g);
        const regenPerTick = (GENERATOR_PARTS[gen].baseRegen * legsFor(legs)) / 120;
        s.player.en = 0;
        s.player.mv.lastEnSpentAt = s.time - 10; // long ago, grounded: regenerates at once
        const expectedTick = Math.ceil(8 / regenPerTick - 1e-6); // exact arithmetic: EN = k * regenPerTick after k ticks, fire needs >= 8
        g.input.fire = true;
        let first = -1;
        for (let i = 0; i < 400 && first < 0; i++) {
          const n = s.shots.length;
          g.step();
          if (s.shots.length > n) first = i;
        }
        g.input.fire = false;
        expect(first).toBe(expectedTick);
      });
    }
  }
});

// =====================================================================================================================
describe('3. missile (§4.1 / §4.4)', () => {
  /** state that a refusal must leave untouched */
  const spent = (g: Game): string => {
    const s = S(g);
    return JSON.stringify({
      ammo: s.player.ammo, en: s.player.en, spent: s.player.mv.lastEnSpentAt, next: s.player.nextFireAt, shots: s.shots, seq: s.shotSeq,
      pid: s.nextProjectileId, missiles: s.missiles.length, bullets: s.bullets.length,
    });
  };
  const wall = box('wall', v3(-30, 0, -20), v3(30, 40, -18));

  const cases: { name: string; setup: (g: Game) => void }[] = [
    { name: 'no target at all', setup: () => undefined },
    {
      name: 'lock still acquiring',
      setup: (g) => {
        addTarget(g, onCamRay(g, 40));
        run(g, 20);
        expect(S(g).lock.state).toBe('acquiring');
      },
    },
    {
      name: 'lock complete, then the target is destroyed before the shot tick',
      setup: (g) => {
        const t = addTarget(g, onCamRay(g, 40));
        lockOn(g);
        damageEnemy(S(g), t, 1e9, 'beam');
      },
    },
    {
      name: 'lock complete, then a wall appears between the muzzle and the target (target expired)',
      setup: (g) => {
        addTarget(g, v3(1.4, 2.7, -60));
        g.world.setBoxEnabled(g.world.indexOfBox('wall'), false);
        lockOn(g);
        g.world.setBoxEnabled(g.world.indexOfBox('wall'), true);
      },
    },
    {
      name: 'lock complete, then the target is beyond 120 m from the muzzle',
      setup: (g) => {
        const t = addTarget(g, onCamRay(g, 60));
        lockOn(g);
        teleport(t, onCamRay(g, 140));
      },
    },
  ];
  for (const c of cases) {
    it(`refused (no missile, no ammo, no EN, no timer, no record): ${c.name}`, () => {
      const g = makeGame({ weapon: 'missile', boxes: [wall] });
      g.world.setBoxEnabled(g.world.indexOfBox('wall'), false); // switched on only by the case that needs it
      c.setup(g);
      const before = spent(g);
      clearEvents(g);
      pull(g, 1);
      expect(spent(g)).toBe(before);
      expect(S(g).notices.noLockAt).not.toBeNull();
      expect(S(g).missiles.length).toBe(0);
    });
  }
  it('with a valid lock but 0 missiles left the shot is refused and nothing else changes', () => {
    const g = makeGame({ weapon: 'missile' });
    addTarget(g, onCamRay(g, 40));
    lockOn(g);
    S(g).player.ammo.missile = 0;
    const before = spent(g);
    pull(g, 3);
    expect(spent(g)).toBe(before);
    expect(S(g).notices.noAmmoAt).not.toBeNull();
  });
  it('a refusal does not start the 1 s wait: once the lock is complete the very first tick fires (next-fire time still 0)', () => {
    const g = makeGame({ weapon: 'missile' });
    const t = addTarget(g, onCamRay(g, 40));
    g.input.fire = true; // held during the whole acquisition: every tick is a refusal
    run(g, lockTicks(g) + 1);
    expect(S(g).shots.length).toBe(0);
    expect(S(g).player.nextFireAt.missile).toBe(0);
    g.step();
    expect(S(g).lock.state).toBe('locked');
    expect(S(g).shots.length).toBe(1);
    expect(S(g).shots[0].firedAtSeconds).toBeCloseTo(S(g).time - DT, 9);
    expect(S(g).shots[0].targetId).toBe(t.id);
  });

  it('damage goes to the enemy the missile actually hits: a blocker on the flight path takes the 180, the locked target takes nothing and the target id is kept until impact', () => {
    const g = makeGame({ weapon: 'missile' });
    const target = addTarget(g, v3(1.4, 2.7, -60), ZERO, 'A_T');
    const m = playerMuzzlePosition(S(g).player);
    const mid = add(m, mul(sub(target.pos, m), 0.5));
    const blocker = addTarget(g, mid, ZERO, 'B_B', 1.0);
    lockOn(g);
    expect(S(g).lock.targetId).toBe('A_T');
    pull(g, 1);
    const ms = S(g).missiles[0] as Missile;
    expect(ms.targetId).toBe('A_T');
    run(g, 200);
    expect(hpLoss(blocker)).toBe(180);
    expect(hpLoss(target)).toBe(0);
    expect(S(g).missiles.length).toBe(0);
  });

  it('life is 4 s: a missile that cannot catch its (faster) target flies exactly 480 ticks at 45 m/s, then expires with an explosion, no damage', () => {
    const g = makeGame({ weapon: 'missile' });
    const t = addTarget(g, onCamRay(g, 40));
    lockOn(g);
    t.vel = v3(0, 0, -60);
    clearEvents(g);
    pull(g, 1);
    const ms = S(g).missiles[0] as Missile;
    let ticks = 1;
    while (ms.alive && ticks < 700) {
      expect(len(ms.vel)).toBeCloseTo(45, 9);
      g.step();
      ticks++;
    }
    expect(ticks).toBe(480);
    expect(ms.age).toBeCloseTo(4, 9);
    expect(hpLoss(t)).toBe(0);
    expect(evs(g, 'explosion').length).toBe(1);
    expect(S(g).missiles.length).toBe(0);
  });

  it('the target id survives the target leaving the FCS circle AND the 120 m range: the missile keeps steering at exactly 120 deg/s toward the target it can still see', () => {
    const g = makeGame({ weapon: 'missile' });
    const t = addTarget(g, onCamRay(g, 60));
    lockOn(g);
    pull(g, 1);
    const ms = S(g).missiles[0] as Missile;
    run(g, 5);
    // far off to the side (outside the FCS circle) and beyond 120 m from the muzzle, but in the open: the missile sees it
    teleport(t, v3(-90, 2.7, -100));
    g.step();
    expect(S(g).lock.state).toBe('none'); // the player's FCS dropped it ...
    expect(ms.targetId).toBe(t.id); // ... the missile did not
    let prev = unit(ms.vel);
    const errBefore = angleBetween(prev, unit(sub(t.pos, ms.pos)));
    for (let i = 0; i < 12; i++) {
      g.step();
      const cur = unit(ms.vel);
      expect(angleBetween(prev, cur) * (180 / Math.PI)).toBeCloseTo(1, 6); // 120 deg/s at dt = 1/120: saturated toward the visible target
      expect(ms.lastSeenAt).toBeCloseTo(S(g).time - DT, 9); // observation refreshed each tick (it sees the target)
      prev = cur;
    }
    // the turn is toward the target's real position: the heading error shrank
    expect(angleBetween(unit(ms.vel), unit(sub(t.pos, ms.pos)))).toBeLessThan(errBefore);
  });

  it('a missile that lost sight of its target (wall) extrapolates the LAST observation at constant velocity; when the wall disappears the observation is refreshed with the real position', () => {
    const screen = box('screen', v3(30, 0, -14), v3(70, 10, -12));
    const g = makeGame({ boxes: [screen] });
    const tgt = addTarget(g, v3(50, 1.5, -30), v3(0, 8, 0), 'T');
    const m: Missile = {
      id: S(g).nextProjectileId++, pos: v3(50, 12, 0), prevPos: v3(50, 12, 0), vel: v3(45, 0, 0), age: 0, life: WEAPONS.missile.lifetime,
      damage: 180, targetId: 'T', lastSeenPos: v3(50, 1.5, -30), lastSeenVel: ZERO, lastSeenAt: S(g).time, alive: true,
    };
    S(g).missiles.push(m);
    run(g, 20);
    expect(blocked(g, m.pos, tgt.pos)).toBe(true);
    expect(m.lastSeenAt).toBe(0); // still occluded: the hidden real position (moving up at 8 m/s) was never read
    expect(len(sub(m.lastSeenPos, v3(50, 1.5, -30)))).toBe(0);
    g.world.setBoxEnabled(g.world.indexOfBox('screen'), false);
    g.step();
    expect(m.lastSeenAt).toBeCloseTo(S(g).time - DT, 9);
    // observation = target position at the tick start (before the tick's own integration) and its actual velocity
    expect(len(sub(m.lastSeenPos, v3(50, 1.5 + 8 * (S(g).time - DT), -30)))).toBeLessThan(1e-9);
    expect(len(sub(m.lastSeenVel, v3(0, 8, 0)))).toBeLessThan(1e-12);
  });
});

// =====================================================================================================================
describe('4. fire-control solution semantics (§4.3, §5 last paragraph, §10 fireControl)', () => {
  it('no solution: the lock is KEPT, aim is direct, the round is spent, the snapshot has the SPEC field pattern; the solution comes back without a new lock when the target slows', () => {
    const { g, tgt, rec } = scenarioShot(v3(0, 0, 90), v3(0, 0, 150)); // receding faster than the bullet
    expect(rec.solutionStatus).toBe('no_solution');
    expect(S(g).player.ammo.machinegun).toBe(299);
    expect(rec.predictedFlightSeconds).toBeNull();
    expect(rec.predictedInterceptPosition).toBeNull();
    const snap = buildSnapshot(S(g));
    expect(snap.lock.state).toBe('locked');
    expect(snap.lock.targetId).toBe('TGT');
    expect(snap.lock.progress).toBe(1);
    const fc = snap.fireControl;
    expect(fc.status).toBe('no_solution');
    expect(fc.weapon).toBe('machinegun');
    expect(fc.targetId).toBe('TGT');
    expect(fc.evaluatedAtSeconds).toBeCloseTo(S(g).time, 12);
    expect(fc.muzzlePosition).not.toBeNull();
    expect(fc.targetPosition).not.toBeNull();
    expect(fc.predictedFlightSeconds).toBeNull();
    expect(fc.predictedInterceptPosition).toBeNull();
    expect(fc.residualMeters).toBeNull();
    const m = v3(...(fc.muzzlePosition as [number, number, number]));
    const p = v3(...(fc.targetPosition as [number, number, number]));
    expect(len(sub(v3(...(fc.launchDirection as [number, number, number])), unit(sub(p, m))))).toBeLessThan(1e-9); // direct aim
    expect(len(sub(v3(...(fc.aimPoint as [number, number, number])), p))).toBeLessThan(1e-9);
    // the target slows down: solvable again, same lock, no new acquisition
    tgt.vel = ZERO;
    g.step();
    expect(S(g).fc.status).toBe('solved');
    expect(S(g).lock.state).toBe('locked');
    expect(S(g).lock.targetId).toBe('TGT');
    expect(S(g).lock.progress).toBe(1);
  });

  it('the solution time limit is 2 s inclusive: raising the recession speed across the boundary flips solved -> no_solution exactly there (real shot)', () => {
    // find vz* (receding speed) at which the smallest root is exactly t = 2, with an independent bisection on the SPEC equation
    const r = v3(0, 0, 100);
    const m = SCEN_M;
    const tOf = (vz: number): number | null => mgOracle(m, add(m, r), v3(0, 0, vz)).t;
    let lo = 10;
    let hi = 95;
    for (let i = 0; i < 60; i++) {
      const mid = 0.5 * (lo + hi);
      const t = tOf(mid);
      if (t !== null) lo = mid;
      else hi = mid;
    }
    const vStar = 0.5 * (lo + hi);
    const below = scenarioShot(r, v3(0, 0, vStar - 0.02));
    expect(below.rec.solutionStatus).toBe('solved');
    expect(below.rec.predictedFlightSeconds as number).toBeGreaterThan(1.99);
    expect(below.rec.predictedFlightSeconds as number).toBeLessThanOrEqual(2 + 1e-9);
    expect(hpLoss(below.tgt) === 0).toBe(true); // (it takes ~2 s to arrive: not yet)
    run(below.g, 260);
    expect(hpLoss(below.tgt)).toBe(12); // the 2 s solution is a real hit of the real bullet
    const above = scenarioShot(r, v3(0, 0, vStar + 0.02));
    expect(above.rec.solutionStatus).toBe('no_solution');
    expect(S(above.g).lock.state).toBe('locked');
  });

  it('a hit-point beyond 120 m / outside the current FCS circle does not cancel the correction at the shot; the real bullet hits', () => {
    // target 117 m away receding at 35 m/s: predicted hit ~ 160 m (> 120 m) but the target is a valid lock candidate now
    const run1 = scenarioShot(v3(0, 0, 117), v3(0, 0, 35));
    expect(run1.rec.solutionStatus).toBe('solved');
    const hitDist = len(sub(run1.rec.predictedInterceptPosition as V3, run1.rec.muzzlePosition));
    expect(hitDist).toBeGreaterThan(120);
    run(run1.g, 300);
    expect(hpLoss(run1.tgt)).toBe(12);
  });

  it('muzzle and target centre (almost) coincide: finite numbers, no NaN/Infinity, the round overlaps and hits at once (no fabricated correction)', () => {
    for (const dist of [0, 1e-7, 1e-5, 5e-5, 2e-4, 0.05, 0.3]) {
      const g = makeGame();
      run(g, 3);
      const m = muzzleNow(S(g));
      const t = addTarget(g, add(m, v3(dist, 0, 0)));
      lockOn(g);
      const before = S(g).player.ammo.machinegun;
      pull(g, 1);
      const rec = S(g).shots[0];
      const nums = [rec.launchDirection.x, rec.launchDirection.y, rec.launchDirection.z, ...Object.values(rec.initialVelocity as V3)];
      for (const x of nums) expect(Number.isFinite(x), `dist ${dist}`).toBe(true);
      expect(Math.abs(len(rec.initialVelocity as V3) - 100), `dist ${dist}`).toBeLessThan(1e-9);
      expect(hpLoss(t), `dist ${dist}`).toBe(12);
      expect(S(g).player.ammo.machinegun).toBe(before - 1);
      expect(S(g).bullets.length).toBe(0);
    }
  });

  it('a corrected round is a real parabola: after the launch nothing bends it (target course change, lock loss, weapon switch) and gravity is not applied twice', () => {
    const { g, tgt, rec } = scenarioShot(v3(0, 0, 100), v3(8, 0, 0));
    const b = S(g).bullets[0] as PlayerBullet;
    const v0 = rec.initialVelocity as V3;
    let dev = 0;
    for (let i = 0; i < 40 && b.alive; i++) {
      if (i === 5) tgt.vel = v3(-30, 5, 10);
      if (i === 8) select(g, 'beam');
      if (i === 12) teleport(tgt, v3(500, 500, 500)); // lock lost
      dev = Math.max(dev, len(sub(b.pos, mgPos(rec.muzzlePosition, v0, b.age))));
      g.step();
    }
    expect(dev).toBeLessThan(1e-9);
    // and the launch itself follows the SPEC formula for m, p, v at the shot time (independent of the solver)
    const t = rec.predictedFlightSeconds as number;
    const d = mgDirection(rec.muzzlePosition, rec.targetPositionAtFire as V3, rec.targetVelocityAtFire as V3, t);
    expect(len(sub(d, rec.launchDirection))).toBeLessThan(1e-9);
    expect(mgResidualOf(rec.muzzlePosition, v0, rec.targetPositionAtFire as V3, rec.targetVelocityAtFire as V3, t)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(mgF(sub(rec.targetPositionAtFire as V3, rec.muzzlePosition), rec.targetVelocityAtFire as V3, t))).toBeLessThan(1e-6);
    expect(Math.abs(mgGap(sub(rec.targetPositionAtFire as V3, rec.muzzlePosition), rec.targetVelocityAtFire as V3, t))).toBeLessThan(1e-9);
  });
});


// =====================================================================================================================
describe('5. the correction is applied to what is really launched (§4.2 "実弾はカメラ中央へ出す実装は禁止")', () => {
  for (const weapon of ['machinegun', 'beam', 'missile'] as const) {
    it(`${weapon}: HUD direction (one tick before) = ShotRecord direction = event direction = projectile velocity direction; all leave the muzzle of the shot instant`, () => {
      const { g, rec, fcBefore } = scenarioShot(v3(15, 6, -70), ZERO, { weapon });
      const dir = rec.launchDirection;
      expect(len(sub(fcBefore.launchDirection as V3, dir))).toBeLessThan(1e-9); // static target: HUD == shot (same shared solution)
      expect(fcBefore.weapon).toBe(weapon);
      if (weapon === 'machinegun') {
        const ev = evs(g, 'mgFire')[0];
        expect(len(sub(ev.dir, dir))).toBeLessThan(1e-12);
        expect(len(sub(ev.origin, rec.muzzlePosition))).toBe(0);
        const b = S(g).bullets[0] as PlayerBullet;
        expect(len(sub(unit(b.v0), dir))).toBeLessThan(1e-12);
        expect(len(sub(b.origin, rec.muzzlePosition))).toBe(0);
      } else if (weapon === 'beam') {
        const ev = evs(g, 'beamFire')[0];
        expect(len(sub(ev.origin, rec.muzzlePosition))).toBe(0);
        expect(len(sub(unit(sub(ev.end, ev.origin)), dir))).toBeLessThan(1e-9);
        expect(ev.hit).toBe('enemy');
      } else {
        const ev = evs(g, 'missileFire')[0];
        expect(len(sub(ev.dir, dir))).toBeLessThan(1e-12);
        expect(len(sub(ev.origin, rec.muzzlePosition))).toBe(0);
        const m = S(g).missiles[0] as Missile;
        // one tick of flight has already happened in the spawn tick; guidance may turn it by at most 1 degree
        expect(angleBetween(unit(m.vel), dir)).toBeLessThan((1.0 + 1e-9) * (Math.PI / 180));
      }
    });
  }

  it('the launch never steers the camera or the player: yaw/pitch, camera pose and player velocity are identical with and without a locked corrected shot', () => {
    const snapshot = (fire: boolean): string => {
      const g = makeGame({ pitch: -0.02 });
      addTarget(g, onCamRay(g, 90), v3(0, 0, 0), 'T');
      run(g, lockTicks(g) + 2);
      const before = JSON.stringify({ c: S(g).camera, y: S(g).player.yaw, p: S(g).player.pitch });
      g.input.fire = fire;
      run(g, 30);
      g.input.fire = false;
      expect(S(g).lock.state).toBe('locked');
      return JSON.stringify({ before, c: S(g).camera, y: S(g).player.yaw, p: S(g).player.pitch, v: S(g).player.vel, pos: S(g).player.pos });
    };
    expect(snapshot(true)).toBe(snapshot(false));
  });

  it('correction accuracy is the same for all 18 loadouts: A09, A10 and A13 give the same time of flight to 1e-12 and hit', () => {
    const cases: { id: string; r: V3; v: V3 }[] = [
      { id: 'A09', r: v3(0, 16, -100), v: v3(6, 0, 0) },
      { id: 'A10', r: v3(0, -16, -100), v: v3(-6, 0, 0) },
      { id: 'A13', r: v3(0, 0, -120), v: v3(6, 3, 4) },
    ];
    for (const c of cases) {
      let ref: number | null = null;
      for (const fcs of ['wide', 'medium', 'narrow'] as const) {
        for (const generator of ['capacity', 'balanced', 'recovery'] as const) {
          for (const legs of ['biped', 'quadruped'] as const) {
            const sh = scenarioShot(c.r, c.v, { loadout: { fcs, generator, legs } });
            const tag = `${c.id} ${fcs}/${generator}/${legs}`;
            expect(sh.rec.solutionStatus, tag).toBe('solved');
            const t = sh.rec.predictedFlightSeconds as number;
            if (ref === null) ref = t;
            expect(Math.abs(t - ref), tag).toBeLessThan(1e-12);
            run(sh.g, 200);
            expect(hpLoss(sh.tgt), tag).toBe(12);
          }
        }
      }
    }
  });
});

// =====================================================================================================================
describe('6. free fire, occlusion and collision (§4.2 / §4.5)', () => {
  it('while the lock is still ACQUIRING the machinegun is a free-fire weapon: aimed at the camera-center point, NO deviation or gravity compensation toward the target', () => {
    const g = makeGame();
    const t = addTarget(g, onCamRay(g, 106)); // 106 m from the camera ~ 96 m from the muzzle: gravity drop of a free round is ~9 m there
    run(g, 20);
    expect(S(g).lock.state).toBe('acquiring');
    const cam = S(g).camera;
    const m = muzzleNow(S(g));
    const aim = add(cam.pos, mul(cam.forward, 106 - 0.5)); // front surface of the radius-0.5 dummy on the camera ray
    pull(g, 1);
    const rec = S(g).shots[0];
    expect(rec.solutionStatus).toBe('inactive');
    expect(rec.targetId).toBeNull();
    expect(len(sub(rec.launchDirection, unit(sub(aim, m))))).toBeLessThan(1e-6);
    run(g, 200);
    expect(hpLoss(t)).toBe(0); // the uncorrected round falls short (the SPEC: no automatic correction before the lock completes)
  });

  it('a barrier that opens while a round is in flight lets it through; a barrier that closes in front of it stops it (world state is read at every tick)', () => {
    const gate = box('gate', v3(-10, 0, -40), v3(12, 30, -38));
    const g = makeGame({ boxes: [gate], pitch: 0.012 });
    run(g, 3);
    const t = addTarget(g, v3(1.4, 2.7, -100), ZERO, 'T', 3);
    g.world.setBoxEnabled(g.world.indexOfBox('gate'), false);
    pull(g, 1);
    run(g, 5);
    g.world.setBoxEnabled(g.world.indexOfBox('gate'), true); // closes in front of the round (it is at ~z=-3 .. -8)
    run(g, 200);
    expect(hpLoss(t)).toBe(0);
    expect(evs(g, 'hit').some((e) => e.on === 'world')).toBe(true);
  });

  it('a wall in front of a locked target that appears AFTER the lock but before the shot cancels the lock and the round is free fire (no shot through the new wall with the old correction)', () => {
    const late = box('late', v3(-20, 0, -30), v3(20, 40, -28));
    const g = makeGame({ boxes: [late] });
    g.world.setBoxEnabled(g.world.indexOfBox('late'), false);
    const t = addTarget(g, v3(1.4, 2.7, -80), ZERO, 'T');
    lockOn(g);
    g.world.setBoxEnabled(g.world.indexOfBox('late'), true);
    pull(g, 1);
    expect(S(g).shots[0].solutionStatus).toBe('inactive');
    expect(S(g).lock.state).toBe('none');
    run(g, 100);
    expect(hpLoss(t)).toBe(0);
  });

  it('the muzzle is never moved to the camera or to the far side of the aim point: shot origin is always the yaw-frame muzzle even with a wall between camera and muzzle', () => {
    // wall directly behind the player: the camera is pulled in, the muzzle stays where the offset puts it
    const back = box('back', v3(-20, 0, 2.5), v3(20, 20, 4.5));
    const g = makeGame({ boxes: [back] });
    run(g, 5);
    const m = muzzleNow(S(g));
    pull(g, 1);
    expect(len(sub(S(g).shots[0].muzzlePosition, m))).toBeLessThan(1e-12);
    expect(len(sub(S(g).shots[0].muzzlePosition, S(g).camera.pos))).toBeGreaterThan(1);
  });

  // The muzzle sits 1.25 m in front of / 1.05 m beside the body centre while the body is only 0.8 m half-width: a wall thinner than
  // 0.45 m, pressed against the body, ends up BEHIND the muzzle. SPEC §4.5: "銃口の前に壁があれば、その壁を貫通させてはいけません" /
  // "実際の発射地点を…壁の反対側へ移してはいけません". The implementation used to let the round start on the far side of such a wall;
  // it now treats a wall on the body-centre -> muzzle segment as the first collision (this test was it.fails until that fix, `.fails`
  // removed because the SPEC-preferred reading now holds).
  it('[AMBIGUITY] a thin wall pressed against the body (between body and muzzle) still stops the shot', () => {
    const thin = box('thin', v3(-10, 0, -1.1), v3(10, 10, -0.8));
    const g = makeGame({ boxes: [thin], weapon: 'beam' });
    run(g, 5);
    const t = addTarget(g, v3(1.4, 2.7, -40), ZERO, 'T');
    clearEvents(g);
    pull(g, 1);
    run(g, 5);
    const bf = evs(g, 'beamFire')[0];
    expect(bf.hit).toBe('world'); // preferred reading: the beam is stopped by the wall the muzzle pokes through
    expect(hpLoss(t)).toBe(0);
  });
});

// =====================================================================================================================
describe('7. recentPlayerShots and the snapshot (§10)', () => {
  it('ring of 32 over mixed weapons: oldest first, gapless ids, per-weapon acceleration / velocity fields, free-fire = inactive with null target fields, refusals add nothing', () => {
    const g = makeGame({ loadout: { fcs: 'wide', generator: 'capacity', legs: 'biped' } });
    g.state.player.en = 180;
    run(g, 3);
    const order: ('machinegun' | 'beam')[] = ['machinegun', 'beam'];
    let n = 0;
    for (let round = 0; n < 45; round++) {
      select(g, order[round % 2]);
      g.input.fire = true;
      run(g, order[round % 2] === 'beam' ? 30 : 12);
      g.input.fire = false;
      n = S(g).shotSeq;
      if (round > 200) break;
    }
    const shots = S(g).shots;
    expect(shots.length).toBe(32);
    const ids = shots.map((s) => s.id);
    expect(ids[31]).toBe(S(g).shotSeq);
    for (let i = 1; i < 32; i++) {
      expect(ids[i]).toBe(ids[i - 1] + 1);
      expect(shots[i].firedAtSeconds).toBeGreaterThan(shots[i - 1].firedAtSeconds);
    }
    for (const r of shots) {
      expect(r.solutionStatus).toBe('inactive');
      expect(r.targetId).toBeNull();
      expect(r.targetPositionAtFire).toBeNull();
      expect(r.targetVelocityAtFire).toBeNull();
      expect(r.predictedFlightSeconds).toBeNull();
      expect(r.predictedInterceptPosition).toBeNull();
      if (r.weapon === 'machinegun') {
        expect(r.accelerationAtFire).toEqual({ x: 0, y: -18, z: 0 });
        expect(r.initialVelocity).not.toBeNull();
      } else {
        expect(r.accelerationAtFire).toEqual({ x: 0, y: 0, z: 0 });
        expect(r.initialVelocity).toBeNull();
      }
    }
    // a refused missile (no lock) and a refused beam (EN 0) add nothing and consume no id
    const seq = S(g).shotSeq;
    S(g).player.en = 0;
    for (const w of ['missile', 'beam'] as const) {
      select(g, w);
      pull(g, 40);
    }
    expect(S(g).shotSeq).toBe(seq);
    expect(S(g).shots.length).toBe(32);
  });

  it('records and the fire-control state own their numbers: mutating the live target / player objects afterwards changes neither', () => {
    const { g, tgt, rec } = scenarioShot(v3(0, 0, -100), v3(8, 0, 0));
    const frozen = JSON.stringify(rec);
    const fcFrozen = JSON.stringify(S(g).fc);
    tgt.pos.x += 100;
    tgt.vel.x += 100;
    S(g).player.pos.y += 5;
    expect(JSON.stringify(S(g).shots[0])).toBe(frozen);
    expect(JSON.stringify(S(g).fc)).toBe(fcFrozen);
  });

  it('getSnapshot is a pure read: it changes nothing, and its arrays are copies', () => {
    const { g } = scenarioShot(v3(3, 2, -60), v3(4, 0, 1));
    const key = (): string =>
      JSON.stringify({ p: S(g).player, l: S(g).lock, f: S(g).fc, s: S(g).shots, e: S(g).enemies, b: S(g).bullets, m: S(g).missiles, o: S(g).objective, t: S(g).time, k: S(g).tick, n: S(g).notices, ev: S(g).events.length, r: S(g).rng.getState() });
    const before = key();
    const a = buildSnapshot(S(g));
    const b = buildSnapshot(S(g));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(key()).toBe(before);
    a.fireControl.launchDirection![0] = 1e9;
    a.recentPlayerShots[0].launchDirection[1] = 1e9;
    a.recentPlayerShots[0].muzzlePosition[2] = 1e9;
    a.enemies[0].position[0] = 1e9;
    a.player.position[1] = 1e9;
    a.objective.openBarrierIds.push('x');
    expect(key()).toBe(before);
  });

  it('before the lock completes fireControl is inactive with every field except status/weapon null; switching weapon while locked keeps the lock and changes only fireControl.weapon (no new lock time)', () => {
    const g = makeGame();
    addTarget(g, onCamRay(g, 50), ZERO, 'T');
    run(g, 30);
    let fc = buildSnapshot(S(g)).fireControl;
    expect(fc.status).toBe('inactive');
    expect(fc.weapon).toBe('machinegun');
    for (const k of ['targetId', 'evaluatedAtSeconds', 'muzzlePosition', 'targetPosition', 'targetVelocity', 'launchDirection', 'predictedFlightSeconds', 'predictedInterceptPosition', 'aimPoint', 'residualMeters'] as const) {
      expect(fc[k], k).toBeNull();
    }
    lockOn(g);
    for (const w of ['beam', 'missile', 'machinegun'] as const) {
      select(g, w);
      g.step();
      const snap = buildSnapshot(S(g));
      expect(snap.lock.state).toBe('locked');
      expect(snap.lock.targetId).toBe('T');
      expect(snap.fireControl.weapon).toBe(w);
      expect(snap.fireControl.status).toBe('solved');
      expect(snap.fireControl.targetId).toBe('T');
      if (w === 'beam') {
        expect(snap.fireControl.predictedFlightSeconds).toBe(0);
        expect(snap.fireControl.residualMeters).toBe(0);
      } else {
        expect(snap.fireControl.predictedFlightSeconds as number).toBeGreaterThan(0);
        expect(snap.fireControl.residualMeters as number).toBeLessThanOrEqual(0.01);
      }
    }
  });

  it('a new target never inherits the previous target\'s position / velocity / solution: A leaves and B is acquired in the same tick -> fireControl is null, then B\'s own values', () => {
    const g = makeGame();
    const a = addTarget(g, onCamRay(g, 50), v3(0, 0, -3), 'A');
    const b = addTarget(g, v3(-40, 2.7, -60), ZERO, 'B'); // 40 m to the left: outside the medium circle at first
    lockOn(g);
    expect(S(g).lock.targetId).toBe('A');
    const aPos = cp(a.pos);
    teleport(a, v3(500, 2.7, -60)); // A out of the circle; B is still outside it too
    g.step();
    expect(S(g).lock.state).toBe('none');
    expect(S(g).fc.status).toBe('inactive');
    expect(S(g).fc.targetPosition).toBeNull();
    // B enters the circle: it starts from progress 0, the old solution is nowhere
    teleport(b, onCamRay(g, 60));
    g.step();
    expect(S(g).lock.targetId).toBe('B');
    expect(S(g).lock.state).toBe('acquiring');
    expect(S(g).lock.progress).toBe(0);
    expect(S(g).fc.status).toBe('inactive');
    lockOn(g);
    expect(S(g).fc.targetId).toBe('B');
    expect(len(sub(S(g).fc.targetPosition as V3, b.pos))).toBe(0);
    expect(len(sub(S(g).fc.targetPosition as V3, aPos))).toBeGreaterThan(1);
    expect(len(sub(S(g).fc.targetVelocity as V3, ZERO))).toBe(0);
  });
});

// =====================================================================================================================
describe('8. re-sortie, pause and frame rate (§9)', () => {
  it('retry() in the middle of a fight resets every combat state of this module (ammo, timers, shots, projectiles, lock, fire control, notices, ids) and keeps only the loadout', () => {
    const loadout: Loadout = { fcs: 'wide', generator: 'recovery', legs: 'quadruped' };
    const g = makeGame({ loadout });
    const t = addTarget(g, onCamRay(g, 50), ZERO, 'T');
    t.maxHp = 1e12;
    t.hp = 1e12;
    lockOn(g);
    select(g, 'missile');
    pull(g, 1);
    select(g, 'beam');
    pull(g, 1);
    select(g, 'machinegun');
    g.input.fire = true;
    run(g, 60);
    S(g).player.ammo.missile = 0;
    select(g, 'missile');
    run(g, 5); // noAmmo notice
    g.input.fire = false;
    expect(S(g).shotSeq).toBeGreaterThan(5);
    expect(S(g).missiles.length + S(g).bullets.length).toBeGreaterThan(0);
    g.retry();
    const s = S(g);
    expect(s.mode).toBe('playing');
    expect([s.time, s.tick, s.shotSeq, s.nextProjectileId]).toEqual([0, 0, 0, 1]);
    expect(s.player.ammo).toEqual({ machinegun: 300, missile: 12 });
    expect(s.player.nextFireAt).toEqual({ machinegun: 0, beam: 0, missile: 0 });
    expect(s.player.weapon).toBe('machinegun');
    expect(s.player.en).toBe(s.stats.maxEn);
    expect(s.shots).toEqual([]);
    expect([s.bullets.length, s.missiles.length, s.enemyBullets.length]).toEqual([0, 0, 0]);
    expect(s.events.every((e) => e.type === 'sector')).toBe(true); // only the initial sector entry may be queued
    expect(s.lock).toMatchObject({ state: 'none', targetId: null, progress: 0, elapsed: 0 });
    expect(s.fc.status).toBe('inactive');
    expect(s.fc.targetId).toBeNull();
    expect(s.notices).toEqual({ noLockAt: null, noEnAt: null, noAmmoAt: null, noSolutionAt: null });
    expect(s.loadout).toEqual(loadout);
    expect(s.enemies.find((e) => e.id === 'T')).toBeUndefined(); // the scripted dummy belonged to the previous sortie
    expect(g.input.fire).toBe(false);
    // the very first round of the new sortie is shot number 1 at t = 0
    pull(g, 1);
    expect(S(g).shots.map((r) => [r.id, r.firedAtSeconds])).toEqual([[1, 0]]);
    expect(S(g).player.ammo.machinegun).toBe(299);
  });

  it('pause freezes projectiles, missile observation memory, fire timers and lock; a paused run continues bit-identically to an uninterrupted one (no elapsed time is added on resume)', () => {
    const play = (withPause: boolean): string => {
      const { g, tgt } = (() => {
        const sc = scenarioShot(v3(6, 3, -80), v3(2, 0, 1), { weapon: 'missile' });
        return { g: sc.g, tgt: sc.tgt };
      })();
      g.input.weaponSelect = 'machinegun';
      g.input.fire = true;
      run(g, 30);
      if (withPause) {
        const before = JSON.stringify([S(g).bullets, S(g).missiles, S(g).lock, S(g).player.nextFireAt, S(g).time, S(g).shots.length, tgt.pos]);
        g.pause();
        expect(g.advance(10)).toBe(0);
        g.input.fire = true; // a stray trigger level while paused must not fire
        g.step();
        expect(JSON.stringify([S(g).bullets, S(g).missiles, S(g).lock, S(g).player.nextFireAt, S(g).time, S(g).shots.length, tgt.pos])).toBe(before);
        g.resume();
        g.input.fire = true;
      }
      run(g, 60);
      g.input.fire = false;
      run(g, 30);
      return JSON.stringify({ b: S(g).bullets, m: S(g).missiles, s: S(g).shots, l: S(g).lock, f: S(g).fc, p: S(g).player, t: tgt, time: S(g).time, tick: S(g).tick });
    };
    expect(play(true)).toBe(play(false));
  });

  it('render-rate independence: the firing timeline (30, 60, 144 fps, 0.25 s frames) is the same tick-quantised timeline; nothing is fired "extra" by a long frame', () => {
    const timeline = (frame: number): number[] => {
      const g = makeGame();
      run(g, 3);
      const t0 = S(g).time;
      g.input.fire = true;
      let real = 0;
      while (real < 2.0) {
        g.advance(frame);
        real += frame;
      }
      g.input.fire = false;
      return S(g).shots.slice(0, 18).map((r) => Math.round((r.firedAtSeconds - t0) / DT));
    };
    const ref = timeline(1 / 60);
    expect(ref.slice(0, 5)).toEqual([0, 12, 24, 36, 48]);
    for (const f of [1 / 30, 1 / 144, 0.25, 1 / 24]) expect(timeline(f)).toEqual(ref);
  });
});

// =====================================================================================================================
describe('9. real enemies (HP, damage arithmetic, actual velocities) through the real weapons and FCS', () => {
  const spawn = (kind: 'guard' | 'turret', id: string, pos: V3): EnemySpawn => ({
    id, kind, sectorId: 'T00', pos, yaw: 0, isGateControl: false, controlIndex: null, barrierId: null,
  });
  function enemyGame(spawns: EnemySpawn[], weapon: 'machinegun' | 'beam' | 'missile' = 'machinegun'): Game {
    const stage = buildTestArenaStage({ floorHalf: 400 });
    stage.enemies = spawns;
    stage.playerStart = { pos: v3(0, 1.5, 0), yaw: 0 };
    const g = new Game({ stage });
    g.sortie();
    S(g).player.hp = 1e9; // enemies shoot back; nothing else is special-cased
    S(g).player.pitch = 0;
    S(g).player.weapon = weapon;
    updateCamera(S(g), g.world);
    return g;
  }
  const hpTrace = (g: Game, id: string, ticks: number, fireAfterLock = true): number[] => {
    const e = S(g).enemies.find((x) => x.id === id)!;
    const trace: number[] = [e.hp];
    for (let i = 0; i < ticks; i++) {
      g.input.fire = fireAfterLock && S(g).lock.state === 'locked';
      g.step();
      if (e.hp !== trace[trace.length - 1]) trace.push(e.hp);
    }
    g.input.fire = false;
    return trace;
  };

  it('turret (HP 240, static, hit-centre v = 0): machinegun needs exactly 20 rounds of 12, no armour, dies once; HUD/shot velocity is exactly 0', () => {
    const g = enemyGame([spawn('turret', 'T01', v3(1.4, 1.6, -60))]);
    const trace = hpTrace(g, 'T01', 96 + 12 * 22 + 60);
    expect(trace).toEqual(Array.from({ length: 21 }, (_, i) => 240 - 12 * i));
    const e = S(g).enemies[0];
    expect(e.alive).toBe(false);
    expect(S(g).killCount).toBe(1);
    expect(S(g).lock.state).toBe('none'); // destroyed: lock and solution discarded at once
    expect(S(g).fc.status).toBe('inactive');
    const corrected = S(g).shots.filter((r) => r.solutionStatus === 'solved');
    expect(corrected.length).toBeGreaterThanOrEqual(20);
    for (const r of corrected) expect(r.targetVelocityAtFire).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('guard (HP 120): three beams kill it (40 each, the last one exactly), missile 180 kills a guard in one hit and a turret in two; only the enemy hit takes damage', () => {
    const gb = enemyGame([spawn('guard', 'G01', v3(1.4, 1.5, -100))], 'beam'); // out of its 90 m sensor range: it stays idle
    const beamTrace = hpTrace(gb, 'G01', 96 + 30 * 4);
    expect(beamTrace).toEqual([120, 80, 40, 0]);
    expect(S(gb).enemies[0].alive).toBe(false);
    const gm = enemyGame([spawn('guard', 'G01', v3(1.4, 1.5, -100))], 'missile');
    const guardTrace = hpTrace(gm, 'G01', 96 + 120 + 240);
    expect(guardTrace).toEqual([120, 0]);
    const tm = enemyGame([spawn('turret', 'T01', v3(1.4, 1.6, -60))], 'missile');
    const turretTrace = hpTrace(tm, 'T01', 96 + 240 + 240);
    expect(turretTrace).toEqual([240, 60, 0]);
    // holding the trigger fires again after 1 s, before the first missile lands (flight ~1.3 s): 2 or 3 missiles are spent, never more
    expect(S(tm).player.ammo.missile).toBeGreaterThanOrEqual(9);
    expect(S(tm).player.ammo.missile).toBeLessThanOrEqual(10);
  });

  it('the FCS uses the ACTUAL velocity of a real moving guard (position change per tick), not its AI intention: fc.targetVelocity and every shot record match', () => {
    const g = enemyGame([spawn('guard', 'G01', v3(1.4, 1.5, -66))]);
    const e = S(g).enemies[0];
    let prev = cp(e.pos);
    let checkedFc = 0;
    let checkedShots = 0;
    let moved = 0;
    for (let i = 0; i < 400 && e.alive; i++) {
      const posAtT = cp(e.pos);
      const velEnteringT = mul(sub(posAtT, prev), 1 / DT); // the velocity actually realised over the previous tick
      g.input.fire = S(g).lock.state === 'locked';
      const seq = S(g).shotSeq;
      g.step();
      prev = posAtT;
      const actual = mul(sub(e.pos, posAtT), 1 / DT);
      if (!e.alive) break; // (a kill zeroes vel in the same tick: dead enemies are not FCS targets)
      expect(len(sub(e.vel, actual)), `tick ${i}`).toBeLessThan(1e-9); // enemy.vel IS the realised centre velocity
      if (len(actual) > 1) moved++;
      if (S(g).shotSeq > seq && e.alive) {
        const rec = S(g).shots[S(g).shots.length - 1];
        if (rec.targetId === 'G01') {
          expect(len(sub(rec.targetPositionAtFire as V3, posAtT)), `tick ${i}`).toBeLessThan(1e-9);
          expect(len(sub(rec.targetVelocityAtFire as V3, velEnteringT)), `tick ${i}`).toBeLessThan(1e-9);
          checkedShots++;
        }
      }
      if (S(g).lock.state === 'locked' && S(g).fc.targetId === 'G01') {
        expect(len(sub(S(g).fc.targetVelocity as V3, e.vel)), `tick ${i}`).toBe(0);
        expect(len(sub(S(g).fc.targetPosition as V3, e.pos)), `tick ${i}`).toBe(0);
        checkedFc++;
      }
    }
    g.input.fire = false;
    expect(moved).toBeGreaterThan(100); // the guard really walked
    expect(checkedFc).toBeGreaterThan(20);
    expect(checkedShots).toBeGreaterThan(2);
  });
});

// =====================================================================================================================
describe('10. SPEC §4.6 literal: A01-A13, 20 single shots each, target moving through the normal lock; oracle = brute-force SPEC equation', () => {
  const A: { id: string; r: V3; v: V3 }[] = [
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
  for (const c of A) {
    it(`${c.id}: 20/20 hits, |v0| = 100 +- 0.001, projectile-vs-predicted-target distance <= 0.01 m, smallest root`, () => {
      let hits = 0;
      for (let d = 0; d < 20; d++) {
        const sc = createScenarioGame({ r: c.r, v: c.v, delayTicks: d });
        const g = sc.game;
        run(g, sc.fireTick);
        expect(S(g).lock.state).toBe('locked');
        const tgt = S(g).enemies.find((e) => e.id === sc.targetId)!;
        g.input.fire = true;
        g.step();
        g.input.fire = false;
        const rec = S(g).shots[0];
        const tag = `${c.id} delay ${d}`;
        const o = mgOracle(rec.muzzlePosition, rec.targetPositionAtFire as V3, rec.targetVelocityAtFire as V3);
        expect(o.t, tag).not.toBeNull();
        expect(rec.solutionStatus, tag).toBe('solved');
        expect(Math.abs((rec.predictedFlightSeconds as number) - (o.t as number)), tag).toBeLessThan(1e-7);
        expect(Math.abs(len(rec.initialVelocity as V3) - 100), tag).toBeLessThanOrEqual(0.001);
        expect(mgResidualOf(rec.muzzlePosition, rec.initialVelocity as V3, rec.targetPositionAtFire as V3, rec.targetVelocityAtFire as V3, rec.predictedFlightSeconds as number), tag).toBeLessThanOrEqual(0.01);
        run(g, 260);
        if (hpLoss(tgt) === 12) hits++;
        expect(hpLoss(tgt), tag).toBe(12); // exactly one hit, not two
      }
      expect(hits).toBe(20);
    });
  }

  it('reference numbers of the SPEC: A03 t = 1.004108529 s, v0 = (0, 9.036976765, 99.590828147); A05 t = 1.007391236 s, v0 = (8, 9.066521121, 99.266299391); A13 t = 1.266137996 s', () => {
    const a03 = scenarioShot(A[2].r, A[2].v);
    expect(a03.rec.predictedFlightSeconds as number).toBeCloseTo(1.004108529, 8);
    expect(len(sub(a03.rec.initialVelocity as V3, v3(0, 9.036976765, 99.590828147)))).toBeLessThan(1e-6 * 1.5);
    const a05 = scenarioShot(A[4].r, A[4].v);
    expect(a05.rec.predictedFlightSeconds as number).toBeCloseTo(1.007391236, 8);
    expect(len(sub(a05.rec.initialVelocity as V3, v3(8, 9.066521121, 99.266299391)))).toBeLessThan(1e-6 * 1.5);
    const a13 = scenarioShot(A[12].r, A[12].v);
    expect(a13.rec.predictedFlightSeconds as number).toBeCloseTo(1.266137996, 8);
  });

  it('beam A01-A13 x 20: 40 damage exactly once, direction normalize(p - m), t = 0, residual 0; missile A05/A06/A07 x 20: 180 damage, initial direction normalize(r + v t), never a machinegun solution', () => {
    for (const c of A) {
      for (let d = 0; d < 20; d += 3) {
        const sc = createScenarioGame({ r: c.r, v: c.v, delayTicks: d, weapon: 'beam' });
        const g = sc.game;
        run(g, sc.fireTick);
        const tgt = S(g).enemies.find((e) => e.id === sc.targetId)!;
        g.input.fire = true;
        g.step();
        g.input.fire = false;
        const rec = S(g).shots[0];
        expect(hpLoss(tgt), `${c.id} beam ${d}`).toBe(40);
        expect(rec.predictedFlightSeconds).toBe(0);
        expect(len(sub(rec.launchDirection, unit(sub(rec.targetPositionAtFire as V3, rec.muzzlePosition))))).toBeLessThan(1e-12);
      }
    }
    for (const c of A.slice(4, 7)) {
      for (let d = 0; d < 20; d++) {
        const sc = createScenarioGame({ r: c.r, v: c.v, delayTicks: d, weapon: 'missile' });
        const g = sc.game;
        run(g, sc.fireTick);
        const tgt = S(g).enemies.find((e) => e.id === sc.targetId)!;
        g.input.fire = true;
        g.step();
        g.input.fire = false;
        const rec = S(g).shots[0];
        const rr = sub(rec.targetPositionAtFire as V3, rec.muzzlePosition);
        const t = missileRoot(rr, c.v) as number;
        expect(len(sub(rec.launchDirection, unit(add(rr, mul(c.v, t))))), `${c.id} missile ${d}`).toBeLessThan(1e-9);
        run(g, 400);
        expect(hpLoss(tgt), `${c.id} missile ${d}`).toBe(180);
      }
    }
  });

  it('player weapons use no randomness at all: identical situations give bit-identical shots, and the gameplay RNG state is untouched by 6 s of firing all three weapons', () => {
    const g = makeGame();
    const t = addTarget(g, onCamRay(g, 60), v3(0, 0, 0), 'T');
    t.maxHp = 1e12;
    t.hp = 1e12;
    lockOn(g);
    const rng0 = S(g).rng.getState();
    const dirs: string[] = [];
    for (const w of ['machinegun', 'beam', 'missile'] as const) {
      select(g, w);
      g.input.fire = true;
      run(g, 360);
      g.input.fire = false;
      S(g).player.en = S(g).stats.maxEn;
      dirs.push(...new Set(S(g).shots.filter((r) => r.weapon === w).map((r) => JSON.stringify(r.launchDirection))));
    }
    expect(S(g).rng.getState()).toBe(rng0);
    // static player + static target: every round of a weapon leaves in exactly the same direction (no scatter)
    expect(dirs.length).toBeLessThanOrEqual(3 * 2); // (a few distinct values are allowed only if the muzzle moved: it does not)
    for (const w of ['machinegun', 'beam', 'missile'] as const) {
      expect(new Set(S(g).shots.filter((r) => r.weapon === w).map((r) => JSON.stringify(r.launchDirection))).size).toBe(1);
    }
  });

  it('two projectiles killing the same enemy in the same tick: one kill, one enemyDown event, HP clamped at 0 (never negative)', () => {
    const g = makeGame();
    const e = addTarget(g, v3(50, 60, 0), ZERO, 'K', 1.0);
    e.hp = 20;
    e.maxHp = 20;
    for (let i = 0; i < 3; i++) {
      const o = v3(50, 60, 1.4 + i * 0.1); // all three reach the unit sphere (radius 1 + 0.06) inside this tick
      S(g).bullets.push({ id: S(g).nextProjectileId++, pos: cp(o), prevPos: cp(o), origin: cp(o), v0: v3(0, 0, -100), age: 0, damage: 12, alive: true });
    }
    clearEvents(g);
    g.step();
    expect(e.hp).toBe(0);
    expect(e.alive).toBe(false);
    expect(evs(g, 'enemyDown').length).toBe(1);
  });
});
