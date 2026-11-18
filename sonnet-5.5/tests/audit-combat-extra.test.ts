/**
 * ADVERSARIAL SPEC AUDIT, part 3 (gap fill). See tests/audit-combat.test.ts for the stance and tests/audit-combat-helpers.ts for the
 * SPEC-derived oracles. Everything here runs on the real Game; expectations come from the SPEC text, never from the implementation.
 *
 *  1. SPEC §4.6 literal geometry of the separated tests (m = (0,20,0), p = m + r, v, radius 0.5) and the moving-player variants
 *     ("自機のグライド・飛行・QB中の試験ではA05の発射時rとvを使用し、自機速度は弾へ継承せず、実際の銃口位置から発射する")
 *  2. double roots / time-bound boundary of the §4.3 solver, tangent case of the §4.4 quadratic
 *  3. §5 lock geometry: D = min(w, h), circle edge +-0.5 px, behind the camera, camera-only / muzzle-only occlusion, ties, no switching,
 *     restart from 0, lock time bounds
 *  4. ammo exhaustion, refusal side effects, EN order QB -> beam -> flight
 *  5. blockers (enemy in front of the locked target, corpses), missile straight flight / no gravity / last-interval contact / remaining-life cap
 *  6. §4.5 "放物線が梁に当たれば止まる" with the straight lines clear; no switching to another arc
 *  7. §10 fireControl details (aim point on the initial ray, residual, missile no_solution)
 *  8. combat "chaos" on the real 45-enemy stage: per-tick invariants (independent shot-instant capture, HP accounting, no tunnelling, missile
 *     speed / turn rate, lock vs the SPEC §5 model, HUD solution == shot solution)
 *  9. differential batteries: missile always hits a solvable constant-velocity target, missile vs thin walls, free-fire beam vs an independent
 *     ray/box + ray/sphere oracle on the real stage, Game.advance(NaN) regression
 * 10. own weapons never hurt the player
 *
 * How the three audit-combat*.test.ts files were validated: 49 single-fault mutants of the combat module (a scratch copy of src with ONE deliberate
 * SPEC violation each: radius from h only, guidance ignoring the remaining life, no camera / muzzle line of sight in the lock, machinegun inheriting the
 * player's velocity, reversed tie-break, no last-interval check, 1.2 s solver cap, refusing an unsolved shot, progress kept, range from the camera,
 * missing beam EN check, no tangent handling, doubled turn rate, timers reset by a switch, doubled gravity, piercing beam, ring dropping the newest ...):
 * 47 are killed. The 2 survivors are equivalent or convention-only (a beam tie between a wall and an enemy sphere at the exact same distance, and a
 * lock drop done in revalidateLock instead of the same tick's updateFcs).
 */
import { appendFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FCS_PARTS, PLAYER, WEAPONS } from '../src/config';
import type { FcsId, LegsId } from '../src/config';
import { buildSnapshot } from '../src/sim/bench';
import { playerMuzzlePosition, updateCamera } from '../src/sim/camera';
import { damageEnemy } from '../src/sim/combat';
import { Game } from '../src/sim/game';
import { createScenarioGame } from '../src/sim/scenario';
import { buildStage } from '../src/stage';
import type { EnemyState, GameEvent, GameState, Loadout, Missile, PlayerBullet, V3, WeaponId } from '../src/sim/types';
import {
  DT, SCEN_M, ZERO, add, addTarget, angleBetween, blocked, box, cp, distToBox, fcsRadiusPx, len, lockCandidates, lockModelStep, lockOn, lockTicks, makeGame, makeRng,
  mgDirection, mgOracle, mgPos, mgResidualOf, missileRoot, mul, muzzleNow, muzzleOf, onCamRay, pull, raySphereT, run, scenarioShot, sub, teleport, unit, v3,
} from './audit-combat-helpers';
import type { LockModel } from './audit-combat-helpers';

const S = (g: Game): GameState => g.state;
const hpLoss = (e: { hp: number }): number => 1e6 - e.hp;
const evs = <T extends GameEvent['type']>(g: Game, type: T): Extract<GameEvent, { type: T }>[] =>
  S(g).events.filter((e): e is Extract<GameEvent, { type: T }> => e.type === type);
const D2R = Math.PI / 180;
const shot = scenarioShot;
const stageOnce = buildStage();
/** optional trace for the audit report (AUDIT_LOG=<file>) */
const trace = (...a: unknown[]): void => {
  if (process.env.AUDIT_LOG) appendFileSync(process.env.AUDIT_LOG, a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n');
};

// =====================================================================================================================
describe('1a. §4.6 literal geometry: the separated tests really put m = (0,20,0), p = m + r, v = v and a radius-0.5 target at the shot instant', () => {
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
    it(`${c.id}: the recorded muzzle / target position / target velocity of every one of the 20 shots equal the SPEC's m, m + r, v (the target is a radius-0.5 test target)`, () => {
      for (let d = 0; d < 20; d++) {
        const sc = createScenarioGame({ r: c.r, v: c.v, delayTicks: d });
        const g = sc.game;
        run(g, sc.fireTick);
        expect(S(g).lock.state, `${c.id} delay ${d}`).toBe('locked');
        const tgt = S(g).enemies.find((e) => e.id === sc.targetId)!;
        expect(tgt.hitRadius).toBe(0.5);
        g.input.fire = true;
        g.step();
        g.input.fire = false;
        const rec = S(g).shots[0];
        const tag = `${c.id} delay ${d}`;
        expect(len(sub(rec.muzzlePosition, SCEN_M)), tag).toBeLessThan(1e-9);
        expect(len(sub(rec.targetPositionAtFire as V3, add(SCEN_M, c.r))), tag).toBeLessThan(1e-9);
        expect(len(sub(rec.targetVelocityAtFire as V3, c.v)), tag).toBeLessThan(1e-12);
        // the shot really happened through the normal FCS lock: 1 round, ring of 1
        expect(rec.targetId, tag).toBe(sc.targetId);
        expect(S(g).shots.length, tag).toBe(1);
      }
    });
  }
});

// =====================================================================================================================
describe('1b. moving player (walk / glide / flight / QB): A05 r and v at the shot instant, launched from the ACTUAL muzzle of that instant, no player velocity in the round', () => {
  type Mode = 'walk' | 'glide' | 'flight' | 'qb';
  const R = v3(0, 0, 100);
  const V = v3(8, 0, 0);
  /** the plan is applied before tick `tick`; the player retreats (S) while facing the target so that it stays inside the 120 m lock range */
  function applyPlan(g: Game, mode: Mode, tick: number, fireTick: number): void {
    const inp = g.input;
    inp.back = true;
    inp.shift = mode === 'glide' && tick === 0;
    inp.jump = mode === 'flight' && tick >= 40;
    inp.qb = mode === 'qb' && tick === fireTick - 3;
  }
  function freshGame(_mode: Mode, loadout: Loadout): Game {
    return makeGame({ loadout, yaw: Math.PI });
  }
  function movingShot(mode: Mode, delay: number, loadout: Loadout): { g: Game; rec: GameState['shots'][number]; tgt: GameState['enemies'][number]; speed: number } {
    const fireTick = 98 + delay;
    // dry run: the player's own trajectory does not depend on the target, so the muzzle at the shot instant can be read in advance
    const dry = freshGame(mode, loadout);
    for (let k = 0; k < fireTick; k++) {
      applyPlan(dry, mode, k, fireTick);
      dry.step();
    }
    const mFire = muzzleNow(S(dry));
    const g = freshGame(mode, loadout);
    const p0 = add(add(mFire, R), mul(V, -(fireTick * DT)));
    const tgt = addTarget(g, p0, V, 'TGT');
    for (let k = 0; k < fireTick; k++) {
      applyPlan(g, mode, k, fireTick);
      g.step();
    }
    expect(S(g).lock.state, `${mode} lock complete before the shot`).toBe('locked');
    applyPlan(g, mode, fireTick, fireTick);
    const speed = Math.hypot(S(g).player.vel.x, S(g).player.vel.y, S(g).player.vel.z);
    if (mode === 'flight') expect(S(g).player.mv.verticalMode).toBe('flying');
    if (mode === 'qb') expect(S(g).player.mv.horizontalMode).toBe('quickboost');
    if (mode === 'glide') expect(S(g).player.mv.horizontalMode).toBe('glide');
    g.input.fire = true;
    g.step();
    g.input.fire = false;
    return { g, rec: S(g).shots[0], tgt, speed };
  }
  const loadouts: Loadout[] = [
    { fcs: 'medium', generator: 'balanced', legs: 'biped' },
    { fcs: 'wide', generator: 'capacity', legs: 'quadruped' },
  ];
  for (const mode of ['walk', 'glide', 'flight', 'qb'] as Mode[]) {
    for (const loadout of loadouts) {
      it(`${mode} / ${loadout.fcs} ${loadout.legs}: 20 shots at A05 (r, v) hit 20/20; muzzle = the moving body's muzzle at that instant; |v0| = 100 in the world frame`, () => {
        let hits = 0;
        let sawFast = 0;
        for (let d = 0; d < 20; d++) {
          const { g, rec, tgt, speed } = movingShot(mode, d, loadout);
          const tag = `${mode} delay ${d}`;
          if (mode === 'qb') expect(speed, tag).toBeGreaterThan(50);
          if (mode === 'glide') expect(speed, tag).toBeGreaterThan(15);
          if (mode === 'walk') expect(speed, tag).toBeGreaterThan(7);
          if (speed > 7) sawFast++;
          const s = S(g);
          expect(rec.solutionStatus, tag).toBe('solved');
          expect(rec.targetId, tag).toBe('TGT');
          const m = rec.muzzlePosition;
          expect(len(sub(rec.targetPositionAtFire as V3, add(m, R))), tag).toBeLessThan(1e-9);
          expect(len(sub(rec.targetVelocityAtFire as V3, V)), tag).toBeLessThan(1e-12); // the WORLD velocity of the target: the player's speed is never subtracted
          const v0 = rec.initialVelocity as V3;
          expect(Math.abs(len(v0) - 100), tag).toBeLessThanOrEqual(0.001);
          expect(len(sub(v0, mul(rec.launchDirection, 100))), tag).toBeLessThan(1e-9);
          const o = mgOracle(m, rec.targetPositionAtFire as V3, V);
          expect(o.t, tag).not.toBeNull();
          expect(Math.abs((rec.predictedFlightSeconds as number) - (o.t as number)), tag).toBeLessThan(1e-7);
          expect(len(sub(rec.launchDirection, mgDirection(m, rec.targetPositionAtFire as V3, V, o.t as number))), tag).toBeLessThan(1e-7);
          expect(mgResidualOf(m, v0, rec.targetPositionAtFire as V3, V, rec.predictedFlightSeconds as number), tag).toBeLessThanOrEqual(0.01);
          // the real bullet: pure analytic flight from the muzzle, independent of what the player does afterwards
          const b = s.bullets[0] as PlayerBullet;
          expect(len(sub(b.origin, m)), tag).toBe(0);
          expect(len(sub(b.v0, v0)), tag).toBe(0);
          let dev = 0;
          for (let k = 0; k < 200 && b.alive; k++) {
            dev = Math.max(dev, len(sub(b.pos, mgPos(m, v0, b.age))));
            g.step();
          }
          expect(dev, tag).toBeLessThan(1e-9);
          run(g, 60);
          if (hpLoss(tgt) === 12) hits++;
          expect(hpLoss(tgt), tag).toBe(12);
        }
        expect(hits).toBe(20);
        expect(sawFast).toBe(20);
      });
    }
  }

  it('the muzzle of a moving shot is the yaw-frame offset from the body position AT the shot instant, not from the previous / next tick', () => {
    const g = freshGame('glide', loadouts[0]);
    for (let k = 0; k < 40; k++) {
      applyPlan(g, 'glide', k, 200);
      g.step();
    }
    const posT = cp(S(g).player.pos);
    const yawT = S(g).player.yaw;
    g.input.fire = true;
    g.step();
    g.input.fire = false;
    const rec = S(g).shots[0];
    expect(len(sub(rec.muzzlePosition, muzzleOf(posT, yawT)))).toBeLessThan(1e-12);
    expect(len(sub(S(g).player.pos, posT))).toBeGreaterThan(0.1); // the body did move during that tick: the record is the instant BEFORE it
    expect(len(sub(rec.muzzlePosition, playerMuzzlePosition(S(g).player)))).toBeGreaterThan(0.05);
  });
});

// =====================================================================================================================
describe('2. solver boundaries (SPEC §4.3 "接する重根と時間上限の境界も扱ってください" / §4.4 "0 < t <= 4")', () => {
  /** min over t in (0, 2] of |w| - s t (scan + golden-section refinement); < 0 <=> a root exists */
  function mgMinGap(r: V3, v: V3): number {
    const N = 20000;
    let bestI = 1;
    let best = Infinity;
    for (let i = 1; i <= N; i++) {
      const gp = gapAt(r, v, (2 * i) / N);
      if (gp < best) {
        best = gp;
        bestI = i;
      }
    }
    let lo = (2 * Math.max(1, bestI - 1)) / N;
    let hi = (2 * Math.min(N, bestI + 1)) / N;
    const phi = (Math.sqrt(5) - 1) / 2;
    let c = hi - phi * (hi - lo);
    let d = lo + phi * (hi - lo);
    for (let k = 0; k < 120; k++) {
      if (gapAt(r, v, c) < gapAt(r, v, d)) hi = d;
      else lo = c;
      c = hi - phi * (hi - lo);
      d = lo + phi * (hi - lo);
    }
    return Math.min(best, gapAt(r, v, 0.5 * (lo + hi)));
  }
  const gapAt = (r: V3, v: V3, t: number): number => {
    const wx = r.x + v.x * t;
    const wy = r.y + v.y * t + 9 * t * t;
    const wz = r.z + v.z * t;
    return Math.sqrt(wx * wx + wy * wy + wz * wz) - 100 * t;
  };

  /** exact double root at t*: F(t*) = 0 and F'(t*) = 0 for r = (0, ry, -rz), v = (0, 0, -vz) (target receding along the camera axis) */
  function doubleRoot(ts: number, ry: number): { r: V3; v: V3 } | null {
    const wy = ry + 9 * ts * ts;
    if (Math.abs(wy) >= 100 * ts) return null;
    const wz = Math.sqrt(1e4 * ts * ts - wy * wy);
    const vz = (1e4 * ts - 18 * ts * wy) / wz;
    const rz = wz - vz * ts;
    if (!(rz > 3) || !(rz < 119) || vz <= 0) return null;
    return { r: v3(0, ry, -rz), v: v3(0, 0, -vz) };
  }

  it('exact double roots (the bullet path touches the target path once, minimum miss 0) get a corrected shot: solved at t*, residual <= 0.01, the real bullet hits', () => {
    let used = 0;
    for (const ts of [0.5, 0.8, 1.1, 1.5, 1.8, 1.95]) {
      for (const ry of [-14, -6, 0, 6, 14]) {
        const c = doubleRoot(ts, ry);
        if (!c) continue;
        // the touching point must be the FIRST contact of the two curves for this to be a "smallest positive root" case
        let firstTouch = Infinity;
        for (let i = 1; i <= 200000; i++) {
          const t = (2 * i) / 200000;
          if (Math.abs(gapAt(c.r, c.v, t)) < 1e-6) {
            firstTouch = t;
            break;
          }
        }
        if (Math.abs(firstTouch - ts) > 2e-3) continue; // an earlier crossing exists (t* is then not the smallest root): not this test's subject
        const tag = `t*=${ts} ry=${ry} r=${JSON.stringify(c.r)} v=${JSON.stringify(c.v)}`;
        let first;
        try {
          first = shot(c.r, c.v);
        } catch (e) {
          if (String(e).includes('lock complete')) continue; // a placement the camera cannot see (e.g. steeply below a 3 m distance) is not this test's subject
          throw e;
        }
        used++;
        const { g, tgt, rec } = first;
        trace('doubleRoot', tag, rec.solutionStatus, rec.predictedFlightSeconds);
        expect(rec.solutionStatus, tag).toBe('solved');
        expect(Math.abs((rec.predictedFlightSeconds as number) - ts), tag).toBeLessThan(2e-3);
        expect(mgResidualOf(rec.muzzlePosition, rec.initialVelocity as V3, rec.targetPositionAtFire as V3, c.v, rec.predictedFlightSeconds as number), tag).toBeLessThanOrEqual(0.01);
        expect(Math.abs(len(rec.initialVelocity as V3) - 100), tag).toBeLessThanOrEqual(0.001);
        run(g, 260);
        expect(hpLoss(tgt), tag).toBe(12);
        // 0.5 m/s more recession and the minimum miss is far above 0.01 m (or the roots moved past the time limit): no valid solution
        const v2 = v3(c.v.x, c.v.y, c.v.z - 0.5);
        const out = shot(c.r, v2);
        if (out.rec.solutionStatus === 'solved') {
          expect(mgResidualOf(out.rec.muzzlePosition, out.rec.initialVelocity as V3, out.rec.targetPositionAtFire as V3, v2, out.rec.predictedFlightSeconds as number), tag).toBeLessThanOrEqual(0.01);
        } else {
          expect(out.rec.solutionStatus, tag).toBe('no_solution');
          expect(S(out.g).lock.state, tag).toBe('locked');
        }
      }
    }
    expect(used).toBeGreaterThanOrEqual(6);
  });

  it('the 2 s limit is inclusive to the last bit that matters: recession speed vStar -/+ 1e-7 flips solved <-> no_solution, both with the lock kept', () => {
    const r = v3(0, 0, -100);
    let lo = 10;
    let hi = 95;
    for (let i = 0; i < 100; i++) {
      const mid = 0.5 * (lo + hi);
      if (mgOracle(SCEN_M, add(SCEN_M, v3(0, 0, 100)), v3(0, 0, mid)).t !== null) lo = mid;
      else hi = mid;
    }
    const vStar = 0.5 * (lo + hi);
    const inside = shot(r, v3(0, 0, -(vStar - 1e-7)));
    expect(inside.rec.solutionStatus).toBe('solved');
    expect(inside.rec.predictedFlightSeconds as number).toBeGreaterThan(2 - 1e-4);
    expect(inside.rec.predictedFlightSeconds as number).toBeLessThanOrEqual(2 + 1e-9);
    const outside = shot(r, v3(0, 0, -(vStar + 1e-4)));
    expect(outside.rec.solutionStatus).toBe('no_solution');
    expect(S(outside.g).lock.state).toBe('locked');
  });

  it('missile: the 4 s limit is inclusive (target 100 m away receding at exactly 20 m/s: t = 4 s), 20.01 m/s has its root at 4.0016 s -> no solution, still fired at the current position', () => {
    const r = v3(0, 0, -100);
    const at = shot(r, v3(0, 0, -20), { weapon: 'missile' });
    expect(at.rec.solutionStatus).toBe('solved');
    expect(Math.abs((at.rec.predictedFlightSeconds as number) - 4)).toBeLessThan(1e-9);
    const under = shot(r, v3(0, 0, -19.99), { weapon: 'missile' });
    expect(under.rec.solutionStatus).toBe('solved');
    expect(Math.abs((under.rec.predictedFlightSeconds as number) - 100 / (45 - 19.99))).toBeLessThan(1e-9);
    const over = shot(r, v3(0, 0, -20.01), { weapon: 'missile' });
    expect(over.rec.solutionStatus).toBe('no_solution');
    expect(S(over.g).missiles.length).toBe(1);
    expect(S(over.g).player.ammo.missile).toBe(11);
    expect(len(sub(over.rec.launchDirection, unit(sub(over.rec.targetPositionAtFire as V3, over.rec.muzzlePosition))))).toBeLessThan(1e-12);
  });

  it('missile: tangent case of the quadratic (target 2x faster than the missile on the critical bearing): exactly one root t = -(r.v)/(v.v - 45^2), solved', () => {
    const c = -Math.sqrt(1 - (45 * 45) / (90 * 90)); // cos(angle between r and v) at which the discriminant is 0
    const rho = 100;
    const s = Math.sqrt(1 - c * c);
    // muzzle frame (z axis is where the scenario's camera looks): v along +x
    const r = v3(rho * c, 0, -rho * s);
    const v = v3(90, 0, 0);
    const a = 90 * 90 - 45 * 45;
    const tStar = -(r.x * v.x) / a;
    const { rec, g } = shot(r, v, { weapon: 'missile' });
    expect(rec.solutionStatus).toBe('solved');
    expect(Math.abs((rec.predictedFlightSeconds as number) - tStar)).toBeLessThan(1e-6);
    const rr = sub(rec.targetPositionAtFire as V3, rec.muzzlePosition);
    expect(len(sub(rec.launchDirection, unit(add(rr, mul(v, tStar)))))).toBeLessThan(1e-6);
    expect(S(g).missiles.length).toBe(1);
  });
});

// =====================================================================================================================
describe('3. FCS lock geometry and state machine (SPEC §5)', () => {
  const focal = (g: Game): number => S(g).camera.viewportH / 2 / Math.tan((S(g).camera.fovYDeg * Math.PI) / 360);
  /** world point that projects to the screen offset (xPx right, yPx DOWN) from the viewport centre at camera depth `depth` */
  function atScreen(g: Game, xPx: number, yPx: number, depth: number): V3 {
    const c = S(g).camera;
    const F = focal(g);
    return add(add(add(c.pos, mul(c.forward, depth)), mul(c.right, (xPx / F) * depth)), mul(c.up, (-yPx / F) * depth));
  }
  const lockOf = (g: Game): { state: string; id: string | null; progress: number } => ({ state: S(g).lock.state, id: S(g).lock.targetId, progress: S(g).lock.progress });

  const viewports: [number, number][] = [
    [1280, 720], [1920, 1080], [2560, 1440], [1280, 1400], [1500, 1500], [1300, 2000],
  ];
  for (const fcs of ['wide', 'medium', 'narrow'] as FcsId[]) {
    for (const [w, h] of viewports) {
      it(`circle radius = ${FCS_PARTS[fcs].radiusRatio} * min(w, h) for ${fcs} at ${w}x${h}: the drawn radius (lock.radiusCssPx, snapshot) and the judged circle are the same number (edge +-0.5 px)`, () => {
        const g = makeGame({ loadout: { fcs, generator: 'balanced', legs: 'biped' }, w, h });
        const R = FCS_PARTS[fcs].radiusRatio * Math.min(w, h);
        expect(S(g).lock.radiusCssPx).toBeCloseTo(R, 9); // right after the sortie, before any tick
        expect(buildSnapshot(S(g)).lock.radiusCssPx).toBeCloseTo(R, 9);
        expect(fcsRadiusPx(fcs, w, h)).toBeCloseTo(R, 12);
        run(g, 2);
        const t = addTarget(g, v3(0, 0, 0), ZERO, 'T');
        // (the arena floor blocks everything below the camera line, so only the upper half circle can be probed)
        for (const deg of [0, 180, 200, 235, 270, 305, 340]) {
          const a = deg * D2R;
          teleport(t, atScreen(g, Math.cos(a) * (R - 0.5), Math.sin(a) * (R - 0.5), 50));
          g.step();
          expect(S(g).lock.targetId, `inside ${deg} deg`).toBe('T');
          teleport(t, atScreen(g, Math.cos(a) * (R + 0.5), Math.sin(a) * (R + 0.5), 50));
          g.step();
          expect(lockOf(g), `outside ${deg} deg`).toMatchObject({ state: 'none', id: null, progress: 0 });
        }
        expect(S(g).lock.radiusCssPx).toBeCloseTo(R, 9);
      });
    }
  }

  it('resize follows at once: the same world point that was inside the circle at 1920x1080 is outside at 1280x1500 (D = 1280 is the smaller side), the snapshot radius changes with it', () => {
    const g = makeGame({ loadout: { fcs: 'medium', generator: 'balanced', legs: 'biped' }, w: 1920, h: 1080 });
    run(g, 2);
    const R0 = 0.2 * 1080;
    const t = addTarget(g, atScreen(g, R0 - 1, 0, 50), ZERO, 'T');
    g.step();
    expect(S(g).lock.targetId).toBe('T');
    g.setViewport(1280, 1500);
    expect(buildSnapshot(S(g)).lock.radiusCssPx).toBeCloseTo(0.2 * 1280, 9); // before the next tick
    g.step();
    expect(lockOf(g)).toMatchObject({ state: 'none', id: null, progress: 0 }); // 1 - tan-space radius shrank from 0.280 to 0.239
    teleport(t, atScreen(g, 0.2 * 1280 - 1, 0, 50));
    g.step();
    expect(S(g).lock.targetId).toBe('T');
    // and back to landscape 1920x1080: a point at 250 px (outside 216 at the old size, inside 256 at 1280 wide... ) is judged by the current D only
    g.setViewport(1920, 1080);
    g.step();
    teleport(t, atScreen(g, 0.2 * 1080 + 1, 0, 50));
    g.step();
    expect(lockOf(g).state).toBe('none');
  });

  it('a target behind the camera whose mirror image would sit at the screen centre is never acquired (also not while the player looks the other way)', () => {
    const g = makeGame();
    run(g, 2);
    const c = S(g).camera;
    addTarget(g, add(c.pos, mul(c.forward, -20)), ZERO, 'B');
    run(g, 200);
    expect(lockOf(g)).toMatchObject({ state: 'none', id: null });
  });

  const PILLAR = 0.1;
  const pillarAt = (id: string, p: V3): ReturnType<typeof box> => box(id, sub(p, v3(PILLAR, PILLAR, PILLAR)), add(p, v3(PILLAR, PILLAR, PILLAR)));
  it('a pillar that blocks ONLY the camera -> target segment (the muzzle sees the target): no lock (SPEC: both the camera and the muzzle must have a clear line)', () => {
    const probe = makeGame();
    run(probe, 2);
    const cam = cp(S(probe).camera.pos);
    const fwd = cp(S(probe).camera.forward);
    const T = add(cam, mul(fwd, 60));
    const g = makeGame({ boxes: [pillarAt('pil', add(cam, mul(fwd, 20)))] });
    run(g, 2);
    addTarget(g, T, ZERO, 'T');
    expect(len(sub(S(g).camera.pos, cam))).toBeLessThan(1e-12);
    expect(blocked(g, cam, T)).toBe(true);
    expect(blocked(g, muzzleNow(S(g)), T)).toBe(false);
    run(g, 200);
    expect(lockOf(g)).toMatchObject({ state: 'none', id: null });
    g.world.setBoxEnabled(g.world.indexOfBox('pil'), false);
    g.step();
    expect(S(g).lock.targetId).toBe('T');
  });
  it('a pillar that blocks ONLY the muzzle -> target segment (the camera sees the target): no lock, and a valid lock that becomes muzzle-blocked is dropped at once with progress 0 afterwards', () => {
    const probe = makeGame();
    run(probe, 2);
    const cam = cp(S(probe).camera.pos);
    const fwd = cp(S(probe).camera.forward);
    const m = muzzleNow(S(probe));
    const T = add(cam, mul(fwd, 60));
    const q = add(m, mul(sub(T, m), 0.3));
    const g = makeGame({ boxes: [pillarAt('pil', q)] });
    g.world.setBoxEnabled(g.world.indexOfBox('pil'), false);
    run(g, 2);
    addTarget(g, T, ZERO, 'T');
    lockOn(g);
    g.world.setBoxEnabled(g.world.indexOfBox('pil'), true);
    expect(blocked(g, cam, T)).toBe(false);
    expect(blocked(g, muzzleNow(S(g)), T)).toBe(true);
    g.step();
    expect(lockOf(g)).toMatchObject({ state: 'none', id: null, progress: 0 });
    expect(S(g).fc.status).toBe('inactive');
    run(g, 100);
    expect(lockOf(g)).toMatchObject({ state: 'none', id: null });
    g.world.setBoxEnabled(g.world.indexOfBox('pil'), false);
    g.step();
    expect(lockOf(g)).toMatchObject({ state: 'acquiring', id: 'T', progress: 0 }); // starts from zero, the old progress is gone
  });

  it('tie-break: two candidates at the same distance from the centre -> the lower id, in either array order; a strictly nearer one wins over the lower id', () => {
    for (const order of [0, 1]) {
      const g = makeGame();
      run(g, 2);
      const pB = atScreen(g, 80, 0, 50);
      const pA = atScreen(g, -80, 0, 50);
      if (order === 0) {
        addTarget(g, pB, ZERO, 'B');
        addTarget(g, pA, ZERO, 'A');
      } else {
        addTarget(g, pA, ZERO, 'A');
        addTarget(g, pB, ZERO, 'B');
      }
      g.step();
      expect(S(g).lock.targetId, `order ${order}`).toBe('A');
    }
    const g = makeGame();
    run(g, 2);
    addTarget(g, atScreen(g, 100, 0, 50), ZERO, 'A');
    addTarget(g, atScreen(g, 40, -30, 70), ZERO, 'B');
    g.step();
    expect(S(g).lock.targetId).toBe('B');
    // ids of the real campaign are zero padded (G01..G30, T01..T15), so the plain string order is the numeric order
    const g2 = makeGame();
    run(g2, 2);
    addTarget(g2, atScreen(g2, 60, 0, 50), ZERO, 'G10');
    addTarget(g2, atScreen(g2, -60, 0, 50), ZERO, 'G09');
    g2.step();
    expect(S(g2).lock.targetId).toBe('G09');
  });

  it('a selected target is kept while it stays valid, even when another candidate sits exactly at the centre; when it becomes invalid the other one starts from progress 0 in the same tick', () => {
    const g = makeGame();
    run(g, 2);
    const a = addTarget(g, atScreen(g, 100, 0, 50), ZERO, 'B');
    g.step();
    expect(S(g).lock.targetId).toBe('B');
    run(g, 60);
    const before = S(g).lock.progress;
    expect(before).toBeGreaterThan(0.5);
    addTarget(g, atScreen(g, 0, 0, 40), ZERO, 'A'); // exactly at the centre, lower id
    run(g, 20);
    expect(S(g).lock.targetId).toBe('B'); // no switching
    expect(S(g).lock.progress).toBeGreaterThan(before);
    teleport(a, v3(0, 500, 0)); // B invalid (out of the circle / out of range)
    g.step();
    expect(lockOf(g)).toMatchObject({ state: 'acquiring', id: 'A', progress: 0 });
    // ... and A needs its own full lock time, not the remainder of B's
    let ticks = 0;
    while (S(g).lock.state !== 'locked' && ticks < 200) {
      g.step();
      ticks++;
    }
    expect(ticks).toBe(lockTicks(g));
  });

  it('a target that leaves the circle for ONE tick and returns starts over from zero (no resume, no grace time), also after the lock was complete', () => {
    const g = makeGame();
    run(g, 2);
    const t = addTarget(g, atScreen(g, 10, 5, 50), ZERO, 'T');
    lockOn(g);
    const home = cp(t.pos);
    teleport(t, atScreen(g, 0.2 * 720 + 30, 0, 50));
    g.step();
    expect(lockOf(g)).toMatchObject({ state: 'none', id: null, progress: 0 });
    teleport(t, home);
    g.step();
    expect(lockOf(g)).toMatchObject({ state: 'acquiring', id: 'T', progress: 0 });
    let ticks = 0;
    while (S(g).lock.state !== 'locked' && ticks < 300) {
      g.step();
      ticks++;
      if (S(g).lock.state === 'acquiring') expect(S(g).lock.progress).toBeCloseTo((ticks * DT) / S(g).stats.lockSeconds, 9);
    }
    expect(ticks).toBe(lockTicks(g));
  });

  const fcsIds: FcsId[] = ['wide', 'medium', 'narrow'];
  const legsIds: LegsId[] = ['biped', 'quadruped'];
  for (const fcs of fcsIds) {
    for (const legs of legsIds) {
      it(`lock time ${fcs}/${legs}: complete after exactly the effective time (base ${FCS_PARTS[fcs].baseLockSeconds} s ${legs === 'quadruped' ? '/ 1.5' : ''}) of continuous validity, never earlier, at most one tick later`, () => {
        const g = makeGame({ loadout: { fcs, generator: 'balanced', legs } });
        run(g, 5);
        const want = FCS_PARTS[fcs].baseLockSeconds / (legs === 'quadruped' ? 1.5 : 1);
        expect(S(g).stats.lockSeconds).toBeCloseTo(want, 12);
        addTarget(g, atScreen(g, 5, -5, 60), ZERO, 'T');
        g.step(); // the target is first seen at the end of this tick: the validity clock starts here
        const t0 = S(g).time;
        expect(S(g).lock.state).toBe('acquiring');
        let n = 0;
        while (S(g).lock.state !== 'locked' && n < 400) {
          g.step();
          n++;
        }
        const took = S(g).time - t0;
        expect(took).toBeGreaterThanOrEqual(want - 1e-9);
        expect(took).toBeLessThan(want + DT * 1.0001);
        expect(S(g).lock.progress).toBe(1);
      });
    }
  }

  it('range: measured from the MUZZLE (not the camera): 119.99 m is a candidate, 120.01 m is not, and a target 125 m from the camera but < 120 m from the muzzle is locked', () => {
    const at = (muzzleDist: number): { g: Game; id: string | null } => {
      const g = makeGame();
      run(g, 2);
      const m = muzzleNow(S(g));
      // on the camera centre ray, at the depth whose muzzle distance is `muzzleDist`
      let lo = 20;
      let hi = 200;
      for (let i = 0; i < 100; i++) {
        const mid = 0.5 * (lo + hi);
        if (len(sub(onCamRay(g, mid), m)) < muzzleDist) lo = mid;
        else hi = mid;
      }
      addTarget(g, onCamRay(g, 0.5 * (lo + hi)), ZERO, 'T');
      g.step();
      return { g, id: S(g).lock.targetId };
    };
    expect(at(119.99).id).toBe('T');
    expect(at(120.01).id).toBeNull();
    const far = at(115);
    expect(far.id).toBe('T');
    expect(len(sub(S(far.g).enemies[0].pos, S(far.g).camera.pos))).toBeGreaterThan(120); // farther than 120 m from the camera, still valid
  });
});

// =====================================================================================================================
describe('4. ammunition / EN accounting of refusals (SPEC §4.1, §6)', () => {
  it('300 machinegun rounds are the whole sortie (no reload, no refill): exactly 300 records, the 301st press is refused without any side effect; the other weapons still work', () => {
    const g = makeGame({ loadout: { fcs: 'wide', generator: 'capacity', legs: 'biped' } });
    run(g, 3);
    g.input.fire = true;
    run(g, 12 * 300 + 5);
    expect(S(g).shotSeq).toBe(300);
    expect(S(g).player.ammo.machinegun).toBe(0);
    expect(S(g).shots.length).toBe(32);
    const next = S(g).player.nextFireAt.machinegun;
    const idSeq = S(g).nextProjectileId;
    run(g, 600); // 5 s more with the trigger held
    g.input.fire = false;
    expect(S(g).shotSeq).toBe(300);
    expect(S(g).player.ammo.machinegun).toBe(0);
    expect(S(g).player.nextFireAt.machinegun).toBe(next);
    expect(S(g).nextProjectileId).toBe(idSeq);
    expect(S(g).bullets.length).toBe(0);
    expect(S(g).notices.noAmmoAt).not.toBeNull();
    // beam still fires, ammo of the other weapon untouched
    g.input.weaponSelect = 'beam';
    pull(g, 1);
    expect(S(g).shotSeq).toBe(301);
    expect(S(g).shots[S(g).shots.length - 1].weapon).toBe('beam');
    expect(S(g).player.ammo.missile).toBe(12);
  });

  const enCase = (en: number): Game => {
    const g = makeGame({ weapon: 'beam' });
    run(g, 3);
    S(g).player.en = en;
    S(g).player.mv.lastEnSpentAt = S(g).time; // regeneration is blocked for 0.75 s: the numbers below are exact
    g.input.qb = true;
    g.input.fire = true;
    g.step();
    g.input.qb = false;
    g.input.fire = false;
    return g;
  };
  it('QB (36) is paid before the beam (8) from the same EN: 44 EN -> both succeed (EN 0); 43 EN -> QB succeeds, the beam is refused and changes nothing (EN 7, no timer, no record)', () => {
    const both = enCase(44);
    expect(S(both).player.mv.qbSuccessCount).toBe(1);
    expect(S(both).shotSeq).toBe(1);
    expect(S(both).player.en).toBe(0);
    const one = enCase(43);
    expect(S(one).player.mv.qbSuccessCount).toBe(1);
    expect(S(one).shotSeq).toBe(0);
    expect(S(one).shots.length).toBe(0);
    expect(S(one).player.en).toBe(7);
    expect(S(one).player.nextFireAt.beam).toBe(0);
    expect(S(one).player.mv.lastEnSpentAt).toBeCloseTo(S(one).time - DT, 12); // the QB start time, not the refused beam
    expect(S(one).notices.noEnAt).not.toBeNull();
  });
  it('35 EN: the QB is not established (no EN, no count) and the beam is (EN 27): failed requests are not charged twice or queued', () => {
    const g = enCase(35);
    expect(S(g).player.mv.qbSuccessCount).toBe(0);
    expect(S(g).shotSeq).toBe(1);
    expect(S(g).player.en).toBeCloseTo(27, 12);
  });
});

// =====================================================================================================================
describe('5. what a round can hit: blockers, corpses, splash, missile flight (SPEC §4.1, §4.4, §4.5)', () => {
  it('a live enemy in front of the locked target takes the beam (40, once) and the machinegun round; the locked target behind takes nothing', () => {
    for (const weapon of ['beam', 'machinegun'] as const) {
      const g = makeGame({ weapon });
      run(g, 2);
      const a = addTarget(g, onCamRay(g, 60), ZERO, 'A');
      const b = addTarget(g, onCamRay(g, 30), ZERO, 'B', 1.5);
      lockOn(g);
      expect(S(g).lock.targetId).toBe('A'); // both at the centre: the lower id
      pull(g, 1);
      run(g, 100);
      expect(hpLoss(a), weapon).toBe(0);
      expect(hpLoss(b), weapon).toBe(weapon === 'beam' ? 40 : 12);
    }
  });

  it('a destroyed enemy is not an obstacle and not a lock candidate: all three weapons pass through the corpse and damage the enemy behind it', () => {
    for (const weapon of ['beam', 'machinegun', 'missile'] as const) {
      const g = makeGame({ weapon });
      run(g, 2);
      const corpse = addTarget(g, onCamRay(g, 30), ZERO, 'A0', 1.5); // lower id AND nearer the centre than the live one
      damageEnemy(S(g), corpse, 1e9, 'beam');
      expect(corpse.alive).toBe(false);
      const live = addTarget(g, onCamRay(g, 60), ZERO, 'B0');
      lockOn(g);
      expect(S(g).lock.targetId, weapon).toBe('B0');
      pull(g, 1);
      run(g, 200);
      expect(hpLoss(live), weapon).toBe(weapon === 'beam' ? 40 : weapon === 'machinegun' ? 12 : 180);
      expect(corpse.hp, weapon).toBe(0);
    }
  });

  it('missile damage goes only to the enemy that is hit: a neighbour 0.7 m from the target surface takes nothing', () => {
    const g = makeGame({ weapon: 'missile' });
    run(g, 2);
    const a = addTarget(g, onCamRay(g, 60), ZERO, 'A');
    const n = addTarget(g, add(onCamRay(g, 60), v3(0, 1.2, 0)), ZERO, 'N');
    lockOn(g);
    expect(S(g).lock.targetId).toBe('A');
    pull(g, 1);
    run(g, 200);
    expect(hpLoss(a)).toBe(180);
    expect(hpLoss(n)).toBe(0);
    expect(S(g).missiles.length).toBe(0);
  });

  it('after the target dies the missile flies straight at 45 m/s (no turn, no gravity drop, no re-targeting to the enemy next to its path) until its 4 s are over', () => {
    const g = makeGame({ weapon: 'missile' });
    run(g, 2);
    const a = addTarget(g, onCamRay(g, 60), ZERO, 'A');
    lockOn(g);
    pull(g, 1);
    const ms = S(g).missiles[0] as Missile;
    run(g, 3);
    damageEnemy(S(g), a, 1e9, 'beam');
    const decoy = addTarget(g, add(ms.pos, add(mul(unit(ms.vel), 15), v3(0, 0, 0))), ZERO, 'DECOY', 0.5);
    // lateral offset: perpendicular to the flight direction (horizontal), 4 m, i.e. clearly off the path but nearer than anything else
    const h0 = unit(ms.vel);
    const side = unit(v3(-h0.z, 0, h0.x));
    teleport(decoy, add(ms.pos, add(mul(h0, 15), mul(side, 4))));
    const pos0 = cp(ms.pos);
    const age0 = ms.age;
    let n = 0;
    while (ms.alive && n < 1000) {
      g.step();
      n++;
      if (!ms.alive) break;
      expect(angleBetween(unit(ms.vel), h0), `tick ${n}`).toBeLessThan(1e-9);
      expect(Math.abs(len(ms.vel) - 45), `tick ${n}`).toBeLessThan(1e-9);
      expect(len(sub(ms.pos, add(pos0, mul(h0, 45 * n * DT)))), `tick ${n}`).toBeLessThan(1e-9);
    }
    expect(ms.age).toBeCloseTo(4, 9);
    expect(age0 + n * DT).toBeGreaterThan(3.99);
    expect(decoy.hp).toBe(1e6);
    expect(S(g).missiles.length).toBe(0);
  });

  const lastIntervalMissile = (ahead: number): { hp: number; ev: number; g: Game } => {
    const g = makeGame({ weapon: 'missile' });
    run(g, 2);
    const a = addTarget(g, onCamRay(g, 60), ZERO, 'A');
    lockOn(g);
    pull(g, 1);
    const ms = S(g).missiles[0] as Missile;
    damageEnemy(S(g), a, 1e9, 'beam'); // no guidance from now on: straight flight
    const m = S(g).shots[0].muzzlePosition;
    const d = S(g).shots[0].launchDirection;
    const c = addTarget(g, add(m, mul(d, ahead)), ZERO, 'C', 0.5);
    let n = 1;
    while (ms.alive && n < 1000) {
      g.step();
      n++;
    }
    return { hp: hpLoss(c), ev: evs(g, 'hit').filter((e) => e.on === 'enemy' && e.weapon === 'missile').length, g };
  };
  it('the last interval before the 4 s expiry is collision-checked: an enemy first touched at age 3.994 is hit, one first touched at age 4.01 is not', () => {
    const inside = lastIntervalMissile(45 * 4 + 0.5); // contact at path length 179.75 = age 3.9944 (the last tick spans 3.99167 .. 4.0)
    expect(inside.hp).toBe(180);
    expect(inside.ev).toBe(1);
    const outside = lastIntervalMissile(45 * 4 + 1.2); // contact at 180.45 = age 4.010
    expect(outside.hp).toBe(0);
    expect(outside.ev).toBe(0);
  });

  describe('guidance: the intercept used after launch is capped by the REMAINING life (§4.4)', () => {
    /** a missile heading -z at (0,30,0), a target 40 m ahead running sideways at 30 m/s: the intercept needs t = 1.1926 s. returns the heading change of one tick */
    const oneTick = (age: number): { turnDeg: number; towardX: number } => {
      const g = makeGame();
      run(g, 2);
      const t = addTarget(g, v3(0, 30, -40), v3(30, 0, 0), 'T');
      const m: Missile = {
        id: S(g).nextProjectileId++, pos: v3(0, 30, 0), prevPos: v3(0, 30, 0), vel: v3(0, 0, -45), age, life: WEAPONS.missile.lifetime, damage: 180, targetId: 'T',
        lastSeenPos: cp(t.pos), lastSeenVel: v3(30, 0, 0), lastSeenAt: S(g).time, alive: true,
      };
      S(g).missiles.push(m);
      g.step();
      const h = unit(m.vel);
      return { turnDeg: angleBetween(h, v3(0, 0, -1)) / D2R, towardX: h.x };
    };
    it('remaining 4.0 / 1.5 / 1.2 s (> 1.1926 s needed): the missile turns (by the 120 deg/s limit = 1 deg per tick) toward the LEAD point', () => {
      for (const age of [0, 2.5, 2.8]) {
        const r = oneTick(age);
        expect(r.turnDeg, `age ${age}`).toBeCloseTo(1, 6);
        expect(r.towardX, `age ${age}`).toBeGreaterThan(0);
      }
    });
    it('remaining 1.19 / 0.5 s (< 1.1926 s needed): no solution within the life -> it aims at the target\'s CURRENT position (straight ahead here) and does not lead', () => {
      for (const age of [2.81, 3.5]) {
        const r = oneTick(age);
        expect(r.turnDeg, `age ${age}`).toBeLessThan(1e-6);
      }
    });
  });

  it('the missile keeps steering when only the PLAYER has lost sight of the target (wall between player and target) but the missile still sees it; it hits', () => {
    const wall = box('w', v3(-60, 0, -30), v3(60, 60, -29.5));
    const g = makeGame({ weapon: 'missile', boxes: [wall] });
    g.world.setBoxEnabled(g.world.indexOfBox('w'), false);
    run(g, 2);
    const a = addTarget(g, onCamRay(g, 90), ZERO, 'A');
    lockOn(g);
    pull(g, 1);
    const ms = S(g).missiles[0] as Missile;
    while (ms.pos.z > -40) g.step(); // past the wall plane (z = -30)
    g.world.setBoxEnabled(g.world.indexOfBox('w'), true);
    g.step();
    expect(blocked(g, muzzleNow(S(g)), a.pos)).toBe(true);
    expect(S(g).lock.state).toBe('none'); // the player lost it ...
    expect(ms.targetId).toBe('A'); // ... the missile did not
    let lastSeen = ms.lastSeenAt;
    for (let i = 0; i < 10; i++) {
      g.step();
      expect(ms.lastSeenAt).toBeGreaterThan(lastSeen);
      lastSeen = ms.lastSeenAt;
    }
    run(g, 200);
    expect(hpLoss(a)).toBe(180);
  });

  it('a round is advanced by exactly one dt in the tick it is created (no extra frame), for the machinegun and the missile', () => {
    const g = makeGame();
    pull(g, 1);
    const b = S(g).bullets[0] as PlayerBullet;
    expect(b.age).toBeCloseTo(DT, 15);
    expect(len(sub(b.pos, mgPos(b.origin, b.v0, DT)))).toBeLessThan(1e-12);
    const g2 = makeGame({ weapon: 'missile' });
    run(g2, 2);
    addTarget(g2, onCamRay(g2, 60), ZERO, 'A');
    lockOn(g2);
    pull(g2, 1);
    const m = S(g2).missiles[0] as Missile;
    expect(m.age).toBeCloseTo(DT, 15);
    expect(len(sub(m.pos, add(S(g2).shots[0].muzzlePosition, mul(S(g2).shots[0].launchDirection, 45 * DT))))).toBeLessThan(1e-9);
  });

  it('the state of the rounds does not depend on the frame length: 30 / 60 / 144 fps and 0.25 s frames give the bit-identical projectiles and hit results at the same tick', () => {
    const build = (): Game => {
      const g = makeGame({ weapon: 'machinegun' });
      run(g, 2);
      const t = addTarget(g, onCamRay(g, 70), v3(2, 0, -1), 'T');
      t.hp = t.maxHp = 1e9;
      return g;
    };
    const key = (g: Game): string => JSON.stringify({ b: S(g).bullets, m: S(g).missiles, s: S(g).shots, e: S(g).enemies.map((e) => [e.pos, e.hp]), l: S(g).lock, tick: S(g).tick });
    for (const frame of [1 / 30, 1 / 60, 1 / 144, 0.25]) {
      const g = build();
      g.input.fire = true;
      let guard = 0;
      while (S(g).tick < 500 && guard++ < 100000) g.advance(frame);
      const ref = build();
      ref.input.fire = true;
      while (S(ref).tick < S(g).tick) ref.step();
      expect(key(g), `frame ${frame}`).toBe(key(ref));
    }
  });
});

// =====================================================================================================================
describe('6. the corrected parabola is an ordinary projectile (SPEC §4.5 "放物線が梁に当たれば止まる")', () => {
  it('straight lines camera->target and muzzle->target are clear, the corrected arc climbs into a beam: the round is stopped by the beam, the lock and the solution stay, and no other arc is chosen', () => {
    const slab = box('slab', v3(-10, 4.0, -70), v3(10, 6.0, -40));
    const make = (withSlab: boolean): { g: Game; t: ReturnType<typeof addTarget> } => {
      const g = makeGame({ boxes: withSlab ? [slab] : [] });
      run(g, 2);
      const m = muzzleNow(S(g));
      const t = addTarget(g, add(m, v3(0, 0, -100)), ZERO, 'T');
      return { g, t };
    };
    const { g, t } = make(true);
    const m = muzzleNow(S(g));
    lockOn(g);
    expect(blocked(g, S(g).camera.pos, t.pos)).toBe(false);
    expect(blocked(g, m, t.pos)).toBe(false);
    expect(S(g).fc.status).toBe('solved');
    const o = mgOracle(m, t.pos, ZERO);
    const dir = mgDirection(m, t.pos, ZERO, o.t as number);
    const v0 = mul(dir, 100);
    let closest = Infinity;
    for (let k = 0; k <= 400; k++) closest = Math.min(closest, distToBox(mgPos(m, v0, ((o.t as number) * k) / 400), slab.min, slab.max));
    expect(closest).toBe(0); // distToBox is 0 inside the volume: the arc passes THROUGH the beam, the scene is meaningful
    g.input.fire = true;
    run(g, 12 * 5 + 1); // a burst of 6 rounds
    g.input.fire = false;
    run(g, 200);
    expect(hpLoss(t)).toBe(0);
    expect(S(g).shots.length).toBe(6);
    for (const r of S(g).shots) {
      expect(r.solutionStatus).toBe('solved'); // the lock never dropped, the status is not confused with "the arc is blocked"
      expect(len(sub(r.launchDirection, dir))).toBeLessThan(1e-9); // always the smallest-root (low) arc
      expect(r.predictedFlightSeconds as number).toBeCloseTo(o.t as number, 9);
    }
    const worldHits = evs(g, 'hit').filter((e) => e.on === 'world');
    expect(worldHits.length).toBe(6);
    for (const h of worldHits) {
      expect(h.pos.z).toBeGreaterThan(-70 - 1e-6);
      expect(h.pos.z).toBeLessThan(-40 + 0.1);
      expect(h.pos.y).toBeGreaterThan(3.9);
    }
    expect(S(g).lock.state).toBe('locked'); // and the lock survived it all
    // control: the same shot without the beam hits
    const c = make(false);
    lockOn(c.g);
    c.g.input.fire = true;
    run(c.g, 12 * 5 + 1);
    c.g.input.fire = false;
    run(c.g, 200);
    expect(hpLoss(c.t)).toBe(72);
  });
});

// =====================================================================================================================
describe('7. §10 fireControl snapshot semantics (solved / no_solution field patterns and the values behind them)', () => {
  it('machinegun solved: aimPoint = p + v t - 0.5 g t^2 lies ON the initial ray m + 100 t d and ABOVE the intercept point; residual and t match the independent oracle; all copies agree', () => {
    const g = makeGame();
    run(g, 2);
    addTarget(g, onCamRay(g, 70), v3(2, 1, -3), 'T');
    lockOn(g);
    const snap = buildSnapshot(S(g));
    const fc = snap.fireControl;
    expect(fc.status).toBe('solved');
    const m = v3(...(fc.muzzlePosition as [number, number, number]));
    const p = v3(...(fc.targetPosition as [number, number, number]));
    const v = v3(...(fc.targetVelocity as [number, number, number]));
    const d = v3(...(fc.launchDirection as [number, number, number]));
    const hit = v3(...(fc.predictedInterceptPosition as [number, number, number]));
    const aim = v3(...(fc.aimPoint as [number, number, number]));
    const tt = fc.predictedFlightSeconds as number;
    const o = mgOracle(m, p, v);
    expect(Math.abs(tt - (o.t as number))).toBeLessThan(1e-7);
    expect(len(sub(hit, add(p, mul(v, tt))))).toBeLessThan(1e-9);
    expect(len(sub(aim, add(add(p, mul(v, tt)), v3(0, 9 * tt * tt, 0))))).toBeLessThan(1e-9);
    expect(len(sub(aim, add(m, mul(d, 100 * tt))))).toBeLessThan(1e-7); // the corrected aim point is on the launch ray
    expect(aim.y).toBeGreaterThan(hit.y);
    expect(len(sub(d, mgDirection(m, p, v, tt)))).toBeLessThan(1e-9);
    expect(Math.abs((fc.residualMeters as number) - mgResidualOf(m, mul(d, 100), p, v, tt))).toBeLessThan(1e-9);
    expect(fc.residualMeters as number).toBeLessThanOrEqual(0.01);
    expect(fc.evaluatedAtSeconds).toBeCloseTo(S(g).time, 12);
    expect(snap.lock.targetId).toBe(fc.targetId);
  });

  it('missile without a solution (target receding at 60 m/s): fireControl = no_solution, direct aim at the current position, aimPoint = target, arrival time / intercept / residual are null', () => {
    const { g, rec } = shot(v3(0, 0, -80), v3(0, 0, -60), { weapon: 'missile' });
    expect(rec.solutionStatus).toBe('no_solution');
    const fc = buildSnapshot(S(g)).fireControl;
    expect(S(g).lock.state).toBe('locked');
    expect(fc.status).toBe('no_solution');
    expect(fc.weapon).toBe('missile');
    expect(fc.targetId).toBe('TGT');
    expect(fc.evaluatedAtSeconds).toBeCloseTo(S(g).time, 12);
    const m = v3(...(fc.muzzlePosition as [number, number, number]));
    const p = v3(...(fc.targetPosition as [number, number, number]));
    expect(len(sub(v3(...(fc.launchDirection as [number, number, number])), unit(sub(p, m))))).toBeLessThan(1e-12);
    expect(len(sub(v3(...(fc.aimPoint as [number, number, number])), p))).toBeLessThan(1e-12);
    expect(fc.predictedFlightSeconds).toBeNull();
    expect(fc.predictedInterceptPosition).toBeNull();
    expect(fc.residualMeters).toBeNull();
  });

  it('missile solved: aimPoint = the initial intercept point (p + v t), residual = |missile at t - intercept|, and the missile really leaves along launchDirection with |v| = 45', () => {
    const { g, rec } = shot(v3(0, 0, -90), v3(5, 0, 0), { weapon: 'missile' });
    expect(rec.solutionStatus).toBe('solved');
    const s0 = S(g).missiles[0] as Missile;
    expect(Math.abs(len(rec.initialVelocity as V3) - 45)).toBeLessThan(1e-9);
    expect(len(sub(rec.initialVelocity as V3, mul(rec.launchDirection, 45)))).toBeLessThan(1e-9);
    // the target does not change its velocity, so guidance never has to turn: the live velocity equals the recorded initial velocity
    expect(len(sub(s0.vel, rec.initialVelocity as V3))).toBeLessThan(1e-9);
    const fcRec = rec.predictedInterceptPosition as V3;
    const t = rec.predictedFlightSeconds as number;
    expect(len(sub(fcRec, add(rec.targetPositionAtFire as V3, mul(rec.targetVelocityAtFire as V3, t))))).toBeLessThan(1e-9);
    expect(len(sub(add(rec.muzzlePosition, mul(rec.launchDirection, 45 * t)), fcRec))).toBeLessThan(1e-7);
  });

  it('beam: fireControl = solved with t = 0 and residual 0 for a MOVING target, direction = normalize(p - m) toward the CURRENT position, aimPoint = intercept = p', () => {
    const g = makeGame({ weapon: 'beam' });
    run(g, 2);
    addTarget(g, onCamRay(g, 70), v3(6, 0, -2), 'T');
    lockOn(g);
    const fc = buildSnapshot(S(g)).fireControl;
    const m = v3(...(fc.muzzlePosition as [number, number, number]));
    const p = v3(...(fc.targetPosition as [number, number, number]));
    expect(fc.status).toBe('solved');
    expect(fc.predictedFlightSeconds).toBe(0);
    expect(fc.residualMeters).toBe(0);
    expect(len(sub(v3(...(fc.launchDirection as [number, number, number])), unit(sub(p, m))))).toBeLessThan(1e-12);
    expect(len(sub(v3(...(fc.aimPoint as [number, number, number])), p))).toBeLessThan(1e-12);
    expect(len(sub(v3(...(fc.predictedInterceptPosition as [number, number, number])), p))).toBeLessThan(1e-12);
    expect(len(sub(v3(...(fc.targetVelocity as [number, number, number])), v3(6, 0, -2)))).toBeLessThan(1e-12);
  });
});

// =====================================================================================================================
describe('8. combat chaos on the REAL 45-enemy stage: invariants that must hold on every tick whatever the player and the AI do', () => {
  const D = (a: number): number => a * D2R;

  interface ChaosStats { hudMatches: number; shots: number; mgSolved: number; mgFree: number; beams: number; missiles: number; enemyHits: number; locks: number; damage: number; kills: number }
  function chaos(seed: number): ChaosStats {
    const rnd = makeRng(seed);
    const loadouts: Loadout[] = [
      { fcs: 'medium', generator: 'balanced', legs: 'biped' },
      { fcs: 'wide', generator: 'capacity', legs: 'quadruped' },
      { fcs: 'narrow', generator: 'recovery', legs: 'biped' },
    ];
    const loadout = loadouts[seed % 3];
    const g = new Game({ stage: stageOnce, loadout });
    g.sortie(loadout);
    const s = S(g);
    s.player.hp = 1e9; // enemies shoot back; nothing else is special-cased
    // a free pose 25..70 m from a random enemy with a clear line to it
    const spawn = stageOnce.enemies[Math.floor(rnd() * stageOnce.enemies.length)];
    const sec = stageOnce.sectors.find((x) => x.id === spawn.sectorId)!;
    let placed = false;
    for (let a = 0; a < 2000 && !placed; a++) {
      const ang = rnd() * 2 * Math.PI;
      const dist = 25 + rnd() * 45;
      const c = v3(spawn.pos.x + Math.cos(ang) * dist, sec.floorY + PLAYER.HALF.y + 0.05, spawn.pos.z + Math.sin(ang) * dist);
      if (c.x < sec.bounds.min.x || c.x > sec.bounds.max.x || c.z < sec.bounds.min.z || c.z > sec.bounds.max.z) continue;
      if (g.world.overlapAABB(c, PLAYER.HALF, 0.05)) continue;
      if (blocked(g, add(c, v3(0, 1.2, 0)), spawn.pos)) continue;
      s.player.pos = cp(c);
      s.player.prevPos = cp(c);
      placed = true;
    }
    expect(placed, `seed ${seed}: a free pose near ${spawn.id}`).toBe(true);
    const d0 = sub(spawn.pos, s.player.pos);
    s.player.yaw = Math.atan2(-d0.x, -d0.z) + (rnd() - 0.5) * 0.1;
    s.player.pitch = Math.max(-1, Math.min(1, Math.atan2(d0.y, Math.hypot(d0.x, d0.z))));
    updateCamera(s, g.world);

    const st: ChaosStats = { hudMatches: 0, shots: 0, mgSolved: 0, mgFree: 0, beams: 0, missiles: 0, enemyHits: 0, locks: 0, damage: 0, kills: 0 };
    const model: LockModel = { targetId: null, elapsed: 0 };
    const lockSeconds = FCS_PARTS[loadout.fcs].baseLockSeconds / (loadout.legs === 'quadruped' ? 1.5 : 1);
    const heading = new Map<number, V3>();
    let mgShots = 0;
    let prevLockState: string = 'none';
    for (let tick = 0; tick < 900; tick++) {
      const inp = g.input;
      const u = rnd();
      inp.fire = rnd() < 0.85;
      if (u < 0.03) inp.weaponSelect = (['machinegun', 'machinegun', 'beam', 'missile'] as WeaponId[])[Math.floor(rnd() * 4)];
      inp.forward = rnd() < 0.25;
      inp.back = !inp.forward && rnd() < 0.2;
      inp.left = rnd() < 0.15;
      inp.right = rnd() < 0.15;
      inp.jump = tick % 240 > 150 && tick % 240 < 190;
      inp.qb = rnd() < 0.01;
      inp.shift = rnd() < 0.01 ? !inp.shift : inp.shift;
      let viewChanged = false;
      if (rnd() < 0.05) {
        g.look((rnd() - 0.5) * 14, (rnd() - 0.5) * 5);
        viewChanged = true;
      }
      if (tick % 15 === 0 && rnd() < 0.8) {
        viewChanged = true;
        // a "player" who mostly keeps the nearest visible enemy near the centre of the screen (small random error)
        let best: EnemyState | null = null;
        let bestD = Infinity;
        for (const e of s.enemies) {
          if (!e.alive) continue;
          const dd = len(sub(e.pos, s.player.pos));
          if (dd < bestD && dd < 110 && !blocked(g, playerMuzzlePosition(s.player), e.pos)) {
            best = e;
            bestD = dd;
          }
        }
        if (best) {
          const dv = sub(best.pos, s.camera.pos);
          s.player.yaw = Math.atan2(-dv.x, -dv.z) + (rnd() - 0.5) * D(4);
          s.player.pitch = Math.max(-1, Math.min(1, Math.atan2(dv.y, Math.hypot(dv.x, dv.z)) + (rnd() - 0.5) * D(3)));
          updateCamera(s, g.world);
        }
      }
      if (rnd() < 0.02) s.player.en = s.stats.maxEn;
      if (u > 0.985) s.player.ammo.missile = Math.max(s.player.ammo.missile, 3);
      const posT = cp(s.player.pos);
      const yawT = s.player.yaw;
      const seqT = s.shotSeq;
      const hpT = s.enemies.map((e) => e.hp);
      const caps = new Map(s.enemies.map((e) => [e.id, { pos: cp(e.pos), vel: cp(e.vel), alive: e.alive }]));
      const fcBefore = JSON.parse(JSON.stringify(s.fc)) as GameState['fc'];
      const weaponBefore = s.player.weapon;
      const willSwitch = inp.weaponSelect !== null;
      g.step();
      const events = g.drainEvents();
      const tag = `seed ${seed} tick ${tick}`;
      // ---- new shot records: independent capture of the shot instant
      const fresh = s.shots.filter((r) => r.id > seqT);
      expect(fresh.length, tag).toBeLessThanOrEqual(1); // one weapon, one round per tick
      for (const rec of fresh) {
        st.shots++;
        expect(len(sub(rec.muzzlePosition, muzzleOf(posT, yawT))), tag).toBeLessThan(1e-9);
        if (rec.weapon === 'machinegun') mgShots++;
        if (rec.weapon === 'missile') st.missiles++;
        if (rec.weapon === 'beam') st.beams++;
        if (rec.targetId === null) {
          expect(rec.solutionStatus, tag).toBe('inactive');
          expect(rec.predictedFlightSeconds, tag).toBeNull();
          expect(rec.targetPositionAtFire, tag).toBeNull();
          if (rec.weapon === 'missile') throw new Error(`${tag}: a missile was fired without a lock`);
          if (rec.weapon === 'machinegun') st.mgFree++;
          continue;
        }
        // the HUD solution shown at the end of the previous tick IS the solution of the shot (same shared function, same instant),
        // unless the mouse moved (the muzzle follows yaw) or the weapon was switched in between
        if (!viewChanged && !willSwitch && fcBefore.status !== 'inactive' && fcBefore.weapon === weaponBefore && fcBefore.targetId === rec.targetId) {
          expect(rec.solutionStatus, `${tag} hud/shot status`).toBe(fcBefore.status);
          expect(len(sub(fcBefore.launchDirection as V3, rec.launchDirection)), `${tag} hud/shot direction`).toBeLessThan(1e-9);
          expect(len(sub(fcBefore.muzzlePosition as V3, rec.muzzlePosition)), `${tag} hud/shot muzzle`).toBeLessThan(1e-9);
          expect(fcBefore.predictedFlightSeconds, `${tag} hud/shot t`).toBe(rec.predictedFlightSeconds);
          st.hudMatches++;
        }
        const c = caps.get(rec.targetId)!;
        expect(c.alive, tag).toBe(true);
        expect(len(sub(rec.targetPositionAtFire as V3, c.pos)), tag).toBeLessThan(1e-9);
        expect(len(sub(rec.targetVelocityAtFire as V3, c.vel)), tag).toBeLessThan(1e-9);
        expect(len(sub(rec.muzzlePosition, rec.targetPositionAtFire as V3)), tag).toBeLessThan(120 + 1e-6); // only valid targets are corrected
        const m = rec.muzzlePosition;
        if (rec.weapon === 'machinegun') {
          const o = mgOracle(m, c.pos, c.vel);
          expect(Math.abs(len(rec.initialVelocity as V3) - 100), tag).toBeLessThanOrEqual(0.001);
          if (o.t !== null && o.minGap < -0.05) {
            st.mgSolved++;
            expect(rec.solutionStatus, tag).toBe('solved');
            expect(Math.abs((rec.predictedFlightSeconds as number) - o.t), tag).toBeLessThan(1e-6);
            expect(mgResidualOf(m, rec.initialVelocity as V3, c.pos, c.vel, rec.predictedFlightSeconds as number), tag).toBeLessThanOrEqual(0.01);
          } else if (o.t === null && o.minGap > 0.05) {
            expect(rec.solutionStatus, tag).toBe('no_solution');
          }
        } else if (rec.weapon === 'beam') {
          expect(len(sub(rec.launchDirection, unit(sub(c.pos, m)))), tag).toBeLessThan(1e-9);
        } else {
          const rr = sub(c.pos, m);
          const t = missileRoot(rr, c.vel);
          if (t !== null && Math.abs(t - 4) > 1e-3) expect(len(sub(rec.launchDirection, unit(add(rr, mul(c.vel, t))))), tag).toBeLessThan(1e-8);
        }
      }
      // ---- ring, accounting
      expect(s.shots.length, tag).toBeLessThanOrEqual(32);
      for (let i = 1; i < s.shots.length; i++) {
        expect(s.shots[i].id, tag).toBe(s.shots[i - 1].id + 1);
        expect(s.shots[i].firedAtSeconds, tag).toBeGreaterThan(s.shots[i - 1].firedAtSeconds);
      }
      expect(s.player.ammo.machinegun, tag).toBe(300 - mgShots);
      expect(s.player.ammo.missile, tag).toBeGreaterThanOrEqual(0);
      expect(s.player.en, tag).toBeGreaterThanOrEqual(0);
      expect(s.player.en, tag).toBeLessThanOrEqual(s.stats.maxEn);
      // ---- enemy damage: only player weapon hits reduce HP, by exactly the weapon damage
      let expected = 0;
      for (const ev of events) if (ev.type === 'hit' && ev.on === 'enemy') {
        st.enemyHits++;
        expected += ev.weapon === 'machinegun' ? WEAPONS.machinegun.damage : ev.weapon === 'beam' ? WEAPONS.beam.damage : ev.weapon === 'missile' ? WEAPONS.missile.damage : 0;
      }
      let actual = 0;
      let died = false;
      s.enemies.forEach((e, i) => {
        actual += hpT[i] - e.hp;
        expect(e.hp, tag).toBeLessThanOrEqual(hpT[i]);
        expect(e.hp > 0, `${tag} ${e.id}`).toBe(e.alive);
        if (hpT[i] > 0 && e.hp === 0) {
          died = true;
          st.kills++;
        }
      });
      if (!died) expect(actual, tag).toBe(expected);
      else expect(actual, tag).toBeLessThanOrEqual(expected);
      st.damage += actual;
      // ---- rounds: finite, never inside a solid, exact analytic path, missile speed and turn rate
      for (const b of s.bullets) {
        expect(Number.isFinite(b.pos.x + b.pos.y + b.pos.z), tag).toBe(true);
        expect(g.world.pointInSolid(b.pos), `${tag} bullet ${b.id} inside a solid`).toBe(false);
        expect(len(sub(b.pos, mgPos(b.origin, b.v0, b.age))), tag).toBeLessThan(1e-9);
        expect(Math.abs(len(b.v0) - 100), tag).toBeLessThanOrEqual(0.001);
        // nothing between the two ticks: the analytic arc of this tick never dips into a solid (no tunnelling)
        const a1 = b.age;
        const a0 = Math.max(0, a1 - DT);
        for (let k = 0; k <= 8; k++) expect(g.world.pointInSolid(mgPos(b.origin, b.v0, a0 + ((a1 - a0) * k) / 8)), `${tag} bullet ${b.id} arc sample ${k}`).toBe(false);
      }
      for (const m of s.missiles) {
        expect(Number.isFinite(m.pos.x + m.pos.y + m.pos.z), tag).toBe(true);
        expect(g.world.pointInSolid(m.pos), `${tag} missile ${m.id} inside a solid`).toBe(false);
        expect(Math.abs(len(m.vel) - 45), tag).toBeLessThan(1e-9);
        const h = unit(m.vel);
        const prev = heading.get(m.id);
        if (prev) expect(angleBetween(prev, h) / D2R, `${tag} missile ${m.id} turn`).toBeLessThanOrEqual(120 * DT + 1e-6);
        heading.set(m.id, h);
        expect(m.age, tag).toBeLessThanOrEqual(4 + 1e-9);
        for (let k = 0; k <= 8; k++) expect(g.world.pointInSolid(add(m.prevPos, mul(sub(m.pos, m.prevPos), k / 8))), `${tag} missile ${m.id} path sample ${k}`).toBe(false);
      }
      // ---- the lock equals the independent SPEC §5 model, the HUD solution follows the lock
      const cands = lockCandidates(g, fcsRadiusPx(loadout.fcs, 1280, 720));
      const exp = lockModelStep(model, cands, lockSeconds);
      // (a firing tick may drop an invalid lock earlier: same result as the model since both use the state at the end of the tick)
      expect(s.lock.state, tag).toBe(exp.state);
      expect(s.lock.targetId, tag).toBe(model.targetId);
      expect(s.lock.progress, tag).toBeCloseTo(exp.progress, 9);
      if (s.lock.state === 'locked') {
        expect(s.fc.status === 'solved' || s.fc.status === 'no_solution', tag).toBe(true);
        expect(s.fc.targetId, tag).toBe(s.lock.targetId);
        if (prevLockState !== 'locked') st.locks++;
      } else {
        expect(s.fc.status, tag).toBe('inactive');
      }
      prevLockState = s.lock.state;
      const snap = buildSnapshot(s);
      expect(JSON.stringify(snap).includes('NaN'), tag).toBe(false);
    }
    return st;
  }

  it('12 seeded fights (3 loadouts, 900 ticks each, all weapons, walking / gliding / flying / QB / mouse look, the AI shooting back)', () => {
    const total: ChaosStats = { hudMatches: 0, shots: 0, mgSolved: 0, mgFree: 0, beams: 0, missiles: 0, enemyHits: 0, locks: 0, damage: 0, kills: 0 };
    for (let seed = 1; seed <= 12; seed++) {
      const r = chaos(seed * 6151);
      for (const k of Object.keys(total) as (keyof ChaosStats)[]) total[k] += r[k];
    }
    trace('chaos totals', total);
    expect(total.shots).toBeGreaterThan(400);
    expect(total.mgSolved).toBeGreaterThan(50);
    expect(total.missiles).toBeGreaterThan(3);
    expect(total.enemyHits).toBeGreaterThan(40);
    expect(total.locks).toBeGreaterThan(10);
    expect(total.hudMatches).toBeGreaterThan(20);
    expect(total.damage).toBeGreaterThan(0);
  });
});

// =====================================================================================================================
describe('9. more differential batteries (real Game vs oracles written from the SPEC text)', () => {
  it('every solvable constant-velocity intercept of the missile (root <= 4 s) is a HIT when nothing is in the way: 150 random (r, v) incl. |v| > 45', () => {
    const rnd = makeRng(9090);
    let solvable = 0;
    let hits = 0;
    for (let i = 0; i < 150; i++) {
      // stay well above the floor and the scenario scaffold: only the upper hemisphere around the muzzle, elevation +5..+35 deg
      const dist = 15 + rnd() * 100;
      const el = (5 + rnd() * 30) * D2R;
      const az = (rnd() * 2 - 1) * 70 * D2R;
      const r = v3(dist * Math.cos(el) * Math.sin(az), dist * Math.sin(el), -dist * Math.cos(el) * Math.cos(az));
      const v = mul(v3(rnd() * 2 - 1, (rnd() * 2 - 1) * 0.3, rnd() * 2 - 1), rnd() * 70);
      let sh;
      try {
        sh = shot(r, v, { weapon: 'missile' });
      } catch (e) {
        if (String(e).includes('lock complete')) continue;
        throw e;
      }
      const t = missileRoot(sub(sh.rec.targetPositionAtFire as V3, sh.rec.muzzlePosition), v);
      if (t === null || t > 3.9) continue;
      // the target must stay above the floor for the whole flight
      if ((sh.rec.targetPositionAtFire as V3).y + v.y * (t + 0.5) < 3) continue;
      solvable++;
      run(sh.g, 500);
      if (hpLoss(sh.tgt) === 180) hits++;
      expect(hpLoss(sh.tgt), `case ${i}: r=${JSON.stringify(r)} v=${JSON.stringify(v)} t=${t}`).toBe(180);
    }
    expect(solvable).toBeGreaterThan(60);
    expect(hits).toBe(solvable);
  });

  it('missile vs 0.02 m thick walls at random angles: stopped whenever the true straight path passes within the missile radius of the wall (no tunnelling at 45 m/s)', () => {
    const rnd = makeRng(4711);
    let hits = 0;
    let misses = 0;
    const R = WEAPONS.missile.radius;
    for (let i = 0; i < 300; i++) {
      const dir = mul(v3(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1), 1);
      if (len(dir) < 0.1) continue;
      const h = unit(dir);
      const u = 0.05 + 0.9 * rnd();
      const q = v3(rnd() * 20 - 10, 40 + rnd() * 20, rnd() * 20 - 10);
      const origin = sub(q, mul(h, 45 * u * DT));
      const axis = Math.floor(rnd() * 3);
      const off = [0, 0, 0];
      if (rnd() < 0.5) off[axis] = (rnd() < 0.5 ? -1 : 1) * rnd() * 0.5;
      else off[(axis + 1 + Math.floor(rnd() * 2)) % 3] = (rnd() < 0.5 ? -1 : 1) * (2.6 + rnd() * 0.9);
      const c = v3(q.x + off[0], q.y + off[1], q.z + off[2]);
      const half = [3, 3, 3];
      half[axis] = 0.01;
      const wall = box('thin', v3(c.x - half[0], c.y - half[1], c.z - half[2]), v3(c.x + half[0], c.y + half[1], c.z + half[2]));
      const g = makeGame({ boxes: [wall] });
      const m: Missile = {
        id: S(g).nextProjectileId++, pos: cp(origin), prevPos: cp(origin), vel: mul(h, 45), age: 0, life: 4, damage: 180, targetId: 'NONE',
        lastSeenPos: cp(origin), lastSeenVel: ZERO, lastSeenAt: 0, alive: true,
      };
      S(g).missiles.push(m);
      let minD = Infinity;
      for (let k = 0; k <= 4000; k++) minD = Math.min(minD, distToBox(add(origin, mul(h, (45 * DT * k) / 4000)), wall.min, wall.max));
      if (Math.abs(minD - R) < 2e-3) continue;
      g.step();
      const tag = `case ${i}: minD ${minD}`;
      if (minD < R) {
        hits++;
        expect(m.alive, tag).toBe(false);
        expect(evs(g, 'hit').some((e) => e.on === 'world' && e.weapon === 'missile'), tag).toBe(true);
      } else {
        misses++;
        expect(m.alive, tag).toBe(true);
      }
    }
    expect(hits).toBeGreaterThan(50);
    expect(misses).toBeGreaterThan(50);
  });

  /** first entry distance of the ray o + t d into the AABB (slab method written here), or null; 0 when the origin is inside */
  function rayBoxT(o: V3, d: V3, mn: V3, mx: V3): number | null {
    let t0 = 0;
    let t1 = Infinity;
    const O = [o.x, o.y, o.z];
    const Dd = [d.x, d.y, d.z];
    const L = [mn.x, mn.y, mn.z];
    const H = [mx.x, mx.y, mx.z];
    for (let i = 0; i < 3; i++) {
      if (Math.abs(Dd[i]) < 1e-14) {
        if (O[i] < L[i] || O[i] > H[i]) return null;
        continue;
      }
      let a = (L[i] - O[i]) / Dd[i];
      let b = (H[i] - O[i]) / Dd[i];
      if (a > b) [a, b] = [b, a];
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
      if (t0 > t1) return null;
    }
    return t0;
  }
  it('free-fire beam in the real stage (random poses, aimed at random enemies or random directions, barriers toggled): the recorded result is exactly the SPEC one - the nearest of {first box, first live enemy sphere} within 120 m, ties to the wall', () => {
    const stage = stageOnce;
    const rnd = makeRng(1717);
    const tally = { world: 0, none: 0, enemy: 0, body: 0 };
    for (let i = 0; i < 400; i++) {
      const g = new Game({ stage });
      g.sortie();
      const s = S(g);
      s.player.hp = 1e9;
      s.player.weapon = 'beam';
      const target = stage.enemies[Math.floor(rnd() * stage.enemies.length)];
      const sec = stage.sectors.find((x) => x.id === target.sectorId)!;
      let ok = false;
      for (let a = 0; a < 400 && !ok; a++) {
        const near = rnd() < 0.6;
        const c = near
          ? v3(target.pos.x + (rnd() * 2 - 1) * 60, sec.floorY + PLAYER.HALF.y + 0.05 + rnd() * 3, target.pos.z + (rnd() * 2 - 1) * 60)
          : v3(sec.bounds.min.x + rnd() * (sec.bounds.max.x - sec.bounds.min.x), sec.floorY + PLAYER.HALF.y + 0.05 + rnd() * 6, sec.bounds.min.z + rnd() * (sec.bounds.max.z - sec.bounds.min.z));
        if (g.world.overlapAABB(c, PLAYER.HALF, 0.05)) continue;
        s.player.pos = cp(c);
        s.player.prevPos = cp(c);
        ok = true;
      }
      if (!ok) continue;
      if (rnd() < 0.3) for (let k = 0; k < g.world.boxes.length; k++) if (g.world.boxes[k].barrierId !== undefined) g.world.setBoxEnabled(k, rnd() < 0.5);
      if (rnd() < 0.6) {
        const dv = sub(target.pos, s.player.pos);
        s.player.yaw = Math.atan2(-dv.x, -dv.z) + (rnd() * 2 - 1) * 0.02;
        s.player.pitch = Math.max(-1.2, Math.min(1.2, Math.atan2(dv.y, Math.hypot(dv.x, dv.z)) + (rnd() * 2 - 1) * 0.02));
      } else {
        s.player.yaw = (rnd() * 2 - 1) * Math.PI;
        s.player.pitch = (rnd() * 2 - 1) * 1.0;
      }
      updateCamera(s, g.world);
      const foes = s.enemies.map((e) => ({ id: e.id, pos: cp(e.pos), r: e.hitRadius, alive: e.alive }));
      const centre0 = cp(s.player.pos); // the body centre at the shot instant (the tick moves the player afterwards)
      g.input.fire = true;
      g.step();
      g.input.fire = false;
      const evt = g.drainEvents().find((e) => e.type === 'beamFire') as Extract<GameEvent, { type: 'beamFire' }> | undefined;
      expect(evt, `case ${i}`).toBeDefined();
      const rec = S(g).shots[0];
      const o = rec.muzzlePosition;
      const d = rec.launchDirection;
      // SPEC §4.5 (reading adopted in the sim-fix phase): a wall on the segment body centre -> muzzle is the FIRST collision of the shot
      // (the launch point is never moved to the far side of a wall thinner than the muzzle offset). Oracle: slab test written here.
      {
        const dm = sub(o, centre0);
        const lm = len(dm);
        const um = mul(dm, 1 / lm);
        let tBody = Infinity;
        for (let k = 0; k < g.world.boxes.length; k++) {
          if (!g.world.isBoxEnabled(k)) continue;
          const t = rayBoxT(centre0, um, g.world.boxes[k].min, g.world.boxes[k].max);
          if (t !== null && t < tBody) tBody = t;
        }
        if (tBody <= lm) {
          tally.body++;
          const eb = evt as Extract<GameEvent, { type: 'beamFire' }>;
          expect(eb.hit, `case ${i}: wall between body and muzzle`).toBe('world');
          expect(eb.targetId, `case ${i}`).toBeNull();
          expect(len(sub(eb.end, add(centre0, mul(um, tBody)))), `case ${i}: the beam ends on that wall`).toBeLessThan(1e-6);
          expect(s.enemies.filter((x, idx) => foes[idx].alive && x.hp < (x.kind === 'guard' ? 120 : 240)).length, `case ${i}: nobody is hurt`).toBe(0);
          continue;
        }
      }
      let tWorld = Infinity;
      for (let k = 0; k < g.world.boxes.length; k++) {
        if (!g.world.isBoxEnabled(k)) continue;
        const t = rayBoxT(o, d, g.world.boxes[k].min, g.world.boxes[k].max);
        if (t !== null && t < tWorld) tWorld = t;
      }
      let tEnemy = Infinity;
      let enemyId: string | null = null;
      for (const f of foes) {
        if (!f.alive) continue;
        const t = raySphereT(o, d, f.pos, f.r);
        if (t !== null && t < tEnemy) {
          tEnemy = t;
          enemyId = f.id;
        }
      }
      const e = evt as Extract<GameEvent, { type: 'beamFire' }>;
      const endDist = len(sub(e.end, o));
      const tag = `case ${i}: world ${tWorld} enemy ${tEnemy}(${enemyId}) -> ${e.hit} ${e.targetId} end ${endDist}`;
      if (tEnemy <= 120 && tEnemy < tWorld) {
        tally.enemy++;
        expect(e.hit, tag).toBe('enemy');
        expect(e.targetId, tag).toBe(enemyId);
        expect(Math.abs(endDist - tEnemy), tag).toBeLessThan(1e-6);
      } else if (tWorld <= 120) {
        tally.world++;
        expect(e.hit, tag).toBe('world');
        expect(Math.abs(endDist - tWorld), tag).toBeLessThan(1e-6);
      } else {
        tally.none++;
        expect(e.hit, tag).toBe('none');
        expect(Math.abs(endDist - 120), tag).toBeLessThan(1e-6);
      }
      // damage bookkeeping: exactly the one enemy, exactly 40
      const lost = s.enemies.filter((x, idx) => x.hp < stage.enemies.length * 0 + (x.kind === 'guard' ? 120 : 240) && foes[idx].alive).map((x) => x.id);
      if (e.hit === 'enemy') expect(lost, tag).toEqual([e.targetId]);
      else expect(lost, tag).toEqual([]);
    }
    trace('beam battery', tally);
    expect(tally.world).toBeGreaterThan(150);
    expect(tally.enemy).toBeGreaterThan(20);
  });

  it('Game.advance() with a non-finite / negative frame time (NaN, Infinity, -1) neither freezes nor corrupts the fire timeline (regression of an earlier audit finding)', () => {
    const g = makeGame();
    run(g, 3);
    g.input.fire = true;
    expect(g.advance(Number.NaN)).toBe(0);
    expect(g.advance(-1)).toBe(0);
    expect(g.advance(1 / 60)).toBe(2);
    expect(g.advance(Number.POSITIVE_INFINITY)).toBeGreaterThan(0); // clamped to MAX_FRAME_SECONDS
    expect(g.advance(1 / 60)).toBe(2); // the accumulator is not poisoned
    g.input.fire = false;
    const t = S(g).shots.map((r) => r.firedAtSeconds);
    for (let i = 1; i < t.length; i++) expect(Math.round((t[i] - t[i - 1]) / DT)).toBe(12);
    expect(Number.isFinite(S(g).time)).toBe(true);
  });
});

// =====================================================================================================================
describe('10. own weapons never hurt the player (SPEC §4.1 "全武器は自機に命中しない")', () => {
  it('machinegun, beam and missile fired at the ground, straight up and at point-blank range (target overlapping the muzzle) never change HP / damageTaken / produce playerHit events', () => {
    const g = makeGame({ loadout: { fcs: 'wide', generator: 'capacity', legs: 'biped' } });
    run(g, 3);
    const hp0 = S(g).player.hp;
    const aimPlans: { pitch: number }[] = [{ pitch: -1.2 }, { pitch: 1.2 }, { pitch: 0 }];
    for (const plan of aimPlans) {
      S(g).player.pitch = plan.pitch;
      updateCamera(S(g), g.world);
      for (const w of ['machinegun', 'beam', 'missile'] as const) {
        g.input.weaponSelect = w;
        S(g).player.en = S(g).stats.maxEn;
        S(g).player.ammo.missile = 12;
        const t = addTarget(g, add(muzzleNow(S(g)), v3(0.4, 0, 0)), ZERO, `P${plan.pitch}${w}`, 0.5); // overlapping the muzzle: missiles can be fired at it
        run(g, 3);
        g.input.fire = true;
        run(g, 130);
        g.input.fire = false;
        damageEnemy(S(g), t, 1e9, 'beam');
      }
    }
    expect(S(g).player.hp).toBe(hp0);
    expect(S(g).damageTaken).toBe(0);
    expect(evs(g, 'playerHit').length).toBe(0);
    expect(S(g).shotSeq).toBeGreaterThan(30);
  });
});
