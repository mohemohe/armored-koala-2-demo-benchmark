/**
 * Projectiles and the hitscan beam (docs/SPEC.md §2.3, §4.1, §4.3–§4.5, §9).
 *
 * Everything drives the real code: projectiles are spawned with the real spawn functions into a real Sim
 * on the isolated test stage and stepped with sim.tick / sim.runFor / sim.advance (or, where a test needs
 * exact control over the sub-step partition, with the real moveEnemies + advanceProjectiles pair in the
 * order sim.substep uses). Nothing of the code under test is mocked. Expected hit times come from
 * independent brute-force references on the closed-form trajectories. Measured numbers are printed with
 * the prefix "[projectiles]" (`npx vitest run tests/projectiles.test.ts --silent=false`).
 */
import { describe, expect, it } from 'vitest';
import { ENEMIES, GRAVITY, PLAYER, TICK, WEAPONS } from '../src/config';
import { Rng } from '../src/core/rng';
import { add, clone, cross, distance, dot, length, normalize, scale, sub, v3, type V3 } from '../src/core/vec';
import { solveGravityIntercept, solveLinearIntercept } from '../src/sim/ballistics';
import { moveEnemies } from '../src/sim/enemies';
import {
  advanceProjectiles,
  castBeam,
  spawnEnemyBullet,
  spawnMachinegunBullet,
  spawnMissile,
} from '../src/sim/projectiles';
import { Sim } from '../src/sim/sim';
import type { EnemyDef, EnemyState, Projectile, SimEvent, SolidDef } from '../src/sim/types';
import { makeTarget, makeTestStage } from '../src/stage/testStages';

// ───────────────────────────── helpers ─────────────────────────────

const MG = WEAPONS.machinegun;
const MSL = WEAPONS.missile;
const TURN = (MSL.turnRateDeg * Math.PI) / 180;
/** §4.6 muzzle. */
const M: V3 = v3(0, 20, 0);
const BIG_HP = 1e9;

interface MkOpts {
  enemies?: EnemyDef[];
  solids?: SolidDef[];
  start?: V3;
}
function mk(o: MkOpts = {}): Sim {
  return new Sim(makeTestStage({ enemies: o.enemies, solids: o.solids, start: o.start }));
}

const solid = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): SolidDef => ({
  min: v3(x0, y0, z0),
  max: v3(x1, y1, z1),
  material: 'wall',
});

/** A passive (no AI, never attacks) enemy of a real kind, used as the owner of enemy bullets. */
const passive = (id: string, kind: 'guard' | 'turret', position: V3, radius?: number): EnemyDef => ({
  id,
  kind,
  sectorId: 'T00',
  position: { ...position },
  isGateControl: false,
  test: radius != null ? { passive: true, hp: BIG_HP, radius } : { passive: true, hp: BIG_HP },
});

interface Stamped {
  /** sim.tickIndex / sim.time after the tick that produced the event. */
  tick: number;
  time: number;
  e: SimEvent;
}
type Ev<T extends SimEvent['type']> = Extract<SimEvent, { type: T }>;
function ofType<T extends SimEvent['type']>(evs: Stamped[], type: T): Array<Stamped & { e: Ev<T> }> {
  return evs.filter((s): s is Stamped & { e: Ev<T> } => s.e.type === type);
}

/** Runs `n` whole ticks, collecting the events of each tick. */
function runTicks(sim: Sim, n: number, each?: () => void, into: Stamped[] = []): Stamped[] {
  for (let i = 0; i < n && sim.status === 'playing'; i++) {
    sim.tick();
    for (const e of sim.drainEvents()) into.push({ tick: sim.tickIndex, time: sim.time, e });
    if (each) each();
  }
  return into;
}

/** Steps 3–5 of sim.substep (enemy motion, projectiles, time) for one sub-step of length h — exact sub-step control. */
function stepDirect(sim: Sim, h: number): SimEvent[] {
  const t0 = sim.time;
  const t1 = t0 + h;
  moveEnemies(sim, h);
  advanceProjectiles(sim, t0, t1);
  sim.time = t1;
  return sim.drainEvents();
}

const mgPos = (m: V3, v0: V3, a: number): V3 => v3(m.x + v0.x * a, m.y + v0.y * a - 0.5 * GRAVITY * a * a, m.z + v0.z * a);
const linPos = (m: V3, v: V3, a: number): V3 => v3(m.x + v.x * a, m.y + v.y * a, m.z + v.z * a);
const angleBetween = (a: V3, b: V3): number => Math.atan2(length(cross(a, b)), dot(a, b));
const finiteV = (a: V3): boolean => Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z);

/**
 * Independent reference: first time in [0, life] at which a machine-gun bullet (closed-form parabola) is
 * within `r` of a centre moving at constant velocity (-1 when never), and the minimum distance over the
 * whole life. Brute force on the closed forms: the distance is sampled every `dt`, every sampled local
 * minimum is refined by golden-section search (so a graze between two samples is not missed), and the
 * first crossing of `r` is located by bisection.
 */
function refMgContact(
  m: V3,
  v0: V3,
  c0: V3,
  cv: V3,
  r: number,
  life: number = MG.lifeSeconds,
  dt: number = 1e-4,
): { t: number; minDist: number } {
  const dist = (t: number): number =>
    Math.hypot(
      m.x + v0.x * t - (c0.x + cv.x * t),
      m.y + v0.y * t - 0.5 * GRAVITY * t * t - (c0.y + cv.y * t),
      m.z + v0.z * t - (c0.z + cv.z * t),
    );
  /** first t in [lo, hi] with dist <= r, given dist(lo) > r >= dist(hi) and a single crossing in between */
  const crossing = (lo: number, hi: number): number => {
    for (let k = 0; k < 80; k++) {
      const mid = 0.5 * (lo + hi);
      if (dist(mid) <= r) hi = mid;
      else lo = mid;
    }
    return hi;
  };
  const GOLD = (Math.sqrt(5) - 1) / 2;
  const argmin = (a: number, b: number): number => {
    let x1 = b - GOLD * (b - a);
    let x2 = a + GOLD * (b - a);
    let f1 = dist(x1);
    let f2 = dist(x2);
    for (let k = 0; k < 90; k++) {
      if (f1 <= f2) {
        b = x2;
        x2 = x1;
        f2 = f1;
        x1 = b - GOLD * (b - a);
        f1 = dist(x1);
      } else {
        a = x1;
        x1 = x2;
        f1 = f2;
        x2 = a + GOLD * (b - a);
        f2 = dist(x2);
      }
    }
    return 0.5 * (a + b);
  };

  let minDist = dist(0);
  if (minDist <= r) return { t: 0, minDist };
  const n = Math.max(2, Math.ceil(life / dt));
  const step = life / n;
  let tHit = -1;
  let d2 = Number.POSITIVE_INFINITY; // dist two samples back
  let d1 = minDist; // dist one sample back
  for (let i = 1; i <= n; i++) {
    const t = i === n ? life : i * step;
    const d = dist(t);
    if (d < minDist) minDist = d;
    if (tHit < 0 && d <= r) tHit = crossing(t - step, t); // the previous sample was still outside
    if (i >= 2 && d1 <= d2 && d1 <= d) {
      // local minimum somewhere in [t − 2·step, t]
      const tm = argmin(t - 2 * step, t);
      const dm = dist(tm);
      if (dm < minDist) minDist = dm;
      if (tHit < 0 && dm <= r) tHit = crossing(t - 2 * step, tm); // grazed between two samples
    }
    d2 = d1;
    d1 = d;
  }
  return { t: tHit, minDist };
}

/** Fires one MG bullet in a fresh sim at a constant-velocity target and reports what really happened. */
function fireMgAt(
  v0: V3,
  targetPos: V3,
  targetVel: V3,
  opts: { muzzle?: V3; radius?: number; seconds?: number; solids?: SolidDef[] } = {},
): { sim: Sim; target: EnemyState; events: Stamped[]; bullet: Projectile; hitTime: number | null; hitPos: V3 | null } {
  const muzzle = opts.muzzle ?? M;
  const sim = mk({ enemies: [makeTarget('T1', targetPos, targetVel, opts.radius ?? 0.5)], solids: opts.solids });
  const target = sim.enemies[0];
  const bullet = spawnMachinegunBullet(sim, muzzle, v0);
  const events = runTicks(sim, Math.round((opts.seconds ?? 2.5) / TICK));
  const hit = ofType(events, 'projectile-hit').find((s) => s.e.target === 'enemy');
  // time of impact recovered from the hit point (z is linear in the bullet's age)
  const hitTime = hit ? (hit.e.pos.z - muzzle.z) / v0.z : null;
  return { sim, target, events, bullet, hitTime, hitPos: hit ? hit.e.pos : null };
}

// ───────────────────────────── machine-gun bullets ─────────────────────────────

describe('machine-gun bullet: spawn and closed-form flight (§4.1, §4.3)', () => {
  it('is pushed alive at the muzzle with exactly the given world velocity (speed 100, no inheritance)', () => {
    const sim = mk();
    sim.runFor(0.1);
    // a moving mech must not leak its velocity into the bullet
    sim.player.vel.x = 55;
    sim.player.vel.z = -30;
    const sol = solveGravityIntercept(M, v3(0, 20, 100), v3(8, 0, 0), MG.speed, MG.gravity, MG.lifeSeconds)!;
    const v0 = scale(sol.dir, MG.speed);
    const idBefore = sim.nextProjectileId;
    const p = spawnMachinegunBullet(sim, M, v0);
    expect(sim.projectiles).toEqual([p]);
    expect(p.id).toBe(idBefore);
    expect(sim.nextProjectileId).toBe(idBefore + 1);
    expect(p.kind).toBe('mg');
    expect(p.alive).toBe(true);
    expect(p.spawnTime).toBe(sim.time);
    expect(p.lifeSeconds).toBe(2);
    expect(p.damage).toBe(12);
    expect(p.origin).toEqual(M);
    expect(p.pos).toEqual(M);
    expect(p.prevPos).toEqual(M);
    expect(p.v0).toEqual(v0); // bit-identical: nothing added, nothing renormalised
    expect(p.vel).toEqual(v0);
    expect(Math.abs(length(p.v0) - 100)).toBeLessThan(1e-12);
    // the spawn functions copy their arguments
    expect(p.origin).not.toBe(M);
    expect(p.v0).not.toBe(v0);
    const q = spawnMachinegunBullet(sim, M, v0);
    expect(q.id).toBe(p.id + 1);
    expect(sim.projectiles).toEqual([p, q]);
  });

  it('follows origin + v0·a + ½·g·a² within 1e-9 at every tick and is removed at exactly 2 s', () => {
    const sim = mk();
    sim.runFor(37 * TICK); // spawn at a non-zero time
    const muzzle = v3(-3, 60, 2);
    const v0 = scale(normalize(v3(3, 20, 97)), 100);
    const p = spawnMachinegunBullet(sim, muzzle, v0);
    const t0 = sim.time;
    let worst = 0;
    let worstVel = 0;
    const events: Stamped[] = [];
    for (let k = 1; k <= 239; k++) {
      runTicks(sim, 1, undefined, events);
      const a = sim.time - t0;
      expect(p.alive).toBe(true);
      worst = Math.max(worst, distance(p.pos, mgPos(muzzle, v0, a)));
      worstVel = Math.max(worstVel, distance(p.vel, v3(v0.x, v0.y - GRAVITY * a, v0.z)));
    }
    expect(worst).toBeLessThan(1e-9);
    expect(worstVel).toBeLessThan(1e-9);
    expect(events.length).toBe(0);
    expect(sim.projectiles.length).toBe(1);
    // the tick that reaches the life end removes it — at the closed-form position of age 2 exactly
    runTicks(sim, 1, undefined, events);
    expect(sim.projectiles.length).toBe(0);
    expect(p.alive).toBe(false);
    const expired = ofType(events, 'projectile-expired');
    expect(expired.length).toBe(1);
    expect(expired[0].e.kind).toBe('mg');
    expect(distance(expired[0].e.pos, mgPos(muzzle, v0, 2))).toBeLessThan(1e-9);
    expect(ofType(events, 'projectile-hit').length).toBe(0);
    console.log(`[projectiles] MG closed form: worst position error over 239 ticks ${worst.toExponential(2)} m`);
  });

  it('is not advanced by the sub-step that spawned it; the first move covers exactly one tick', () => {
    const sim = mk({ enemies: [passive('G', 'guard', v3(300, 1.3, 300))] });
    sim.runFor(0.25);
    const t = sim.time;
    const v0 = v3(0, 9.036976765, 99.590828147);
    const mg = spawnMachinegunBullet(sim, M, v0);
    const msl = spawnMissile(sim, v3(5, 20, 0), v3(0, 0, 1), 'nobody');
    const eb = spawnEnemyBullet(sim, sim.enemies[0], v3(-5, 30, 0), v3(0, 0, 1));
    // a sub-step that ends at (or before) the spawn time must leave them at the muzzle
    advanceProjectiles(sim, t - TICK, t);
    advanceProjectiles(sim, t - 2 * TICK, t - TICK);
    expect(mg.pos).toEqual(M);
    expect(mg.prevPos).toEqual(M);
    expect(msl.pos).toEqual(v3(5, 20, 0));
    expect(eb.pos).toEqual(v3(-5, 30, 0));
    expect(sim.projectiles.length).toBe(3);
    expect(sim.drainEvents().length).toBe(0);
    // an empty interval moves nothing and expires nothing
    advanceProjectiles(sim, t, t);
    advanceProjectiles(sim, t + 10, t + 10);
    expect(mg.pos).toEqual(M);
    expect(sim.projectiles.length).toBe(3);
    sim.tick();
    const a = sim.time - t;
    expect(a).toBeCloseTo(TICK, 14);
    expect(distance(mg.pos, mgPos(M, v0, a))).toBeLessThan(1e-12);
    expect(distance(mg.pos, mgPos(M, v0, 2 * a))).toBeGreaterThan(0.5); // not one step ahead
    expect(distance(msl.pos, v3(5, 20, 45 * a))).toBeLessThan(1e-12);
    expect(distance(eb.pos, v3(-5, 30, 70 * a))).toBeLessThan(1e-12);
  });

  it('a bullet spawned between two sub-steps of one tick only flies the remaining part', () => {
    // sub-steps [0, 0.003] and [0.003, 1/120]; the bullet is spawned at 0.003
    const sim = mk();
    stepDirect(sim, 0.003);
    const v0 = v3(0, 0, 100);
    const p = spawnMachinegunBullet(sim, M, v0);
    expect(p.spawnTime).toBe(0.003);
    stepDirect(sim, TICK - 0.003);
    expect(distance(p.pos, mgPos(M, v0, TICK - 0.003))).toBeLessThan(1e-12);
    expect(p.prevPos).toEqual(M);
  });

  it('a sub-step that began before the spawn time only covers the part after it — for the targets too', () => {
    // sub-step [t − 4 ms, t + 4 ms] with the bullet spawned at t: it flies 4 ms, and a target crossing at
    // 300 m/s must be evaluated on its second half only (c(t) … c(t + 4 ms)), not on the whole sub-step
    const v0 = v3(0, 0, 100);
    const run = (xStart: number): { sim: Sim; p: Projectile; events: SimEvent[] } => {
      const sim = mk({ enemies: [makeTarget('T1', v3(0, 20, 0.2), v3(300, 0, 0))] });
      sim.runFor(0.1);
      const t = sim.time;
      const p = spawnMachinegunBullet(sim, M, v0);
      sim.enemies[0].pos.x = xStart; // centre at the start of the sub-step (t − 4 ms)
      moveEnemies(sim, 0.008);
      advanceProjectiles(sim, t - 0.004, t + 0.004);
      return { sim, p, events: sim.drainEvents() };
    };
    // at t the centre is at x = 0.7 and moving away: never closer than 0.73 m to the bullet → miss
    // (over the whole sub-step it would have swept right across the muzzle)
    const miss = run(-0.5);
    expect(miss.sim.enemies[0].pos.x).toBeCloseTo(1.9, 12);
    expect(miss.p.alive).toBe(true);
    expect(miss.sim.enemies[0].hp).toBe(BIG_HP);
    expect(distance(miss.p.pos, mgPos(M, v0, 0.004))).toBeLessThan(1e-12);
    expect(miss.p.prevPos).toEqual(M);
    // at t the centre is at x = −0.5 and sweeps across during the bullet's 4 ms → hit, at the reference time
    const hit = run(-1.7);
    expect(hit.sim.enemies[0].hp).toBe(BIG_HP - 12);
    const ref = refMgContact(M, v0, v3(-0.5, 20, 0.2), v3(300, 0, 0), 0.5, 0.004, 1e-7);
    expect(ref.t).toBeGreaterThan(0);
    const e = hit.events.find((x): x is Ev<'projectile-hit'> => x.type === 'projectile-hit')!;
    // (the 4 ms chord is at most g·h²/8 = 3.6e-5 m off the parabola)
    expect(distance(e.pos, mgPos(M, v0, ref.t))).toBeLessThan(5e-5);
  });

  it('a non-finite launch state never enters the simulation', () => {
    const sim = mk({ enemies: [passive('G', 'guard', v3(300, 1.3, 300))] });
    const a = spawnMachinegunBullet(sim, M, v3(Number.NaN, 0, 100));
    const b = spawnMissile(sim, M, v3(0, 0, 0), 'x');
    const c = spawnMissile(sim, v3(0, Number.POSITIVE_INFINITY, 0), v3(0, 0, 1), 'x');
    const d = spawnEnemyBullet(sim, sim.enemies[0], M, v3(Number.NaN, Number.NaN, Number.NaN));
    const e = spawnEnemyBullet(sim, sim.enemies[0], M, v3(0, 0, 0));
    for (const p of [a, b, c, d, e]) {
      expect(p.alive).toBe(false);
      expect(finiteV(p.pos) && finiteV(p.vel) && finiteV(p.origin) && finiteV(p.v0) && finiteV(p.prevPos)).toBe(true);
    }
    expect(sim.projectiles.length).toBe(0);
    sim.runFor(0.1);
    expect(sim.drainEvents().filter((e) => e.type.startsWith('projectile')).length).toBe(0);
  });
});

describe('machine-gun bullet: hits (§4.5, §4.6 reference values)', () => {
  it('A03: the spec launch velocity hits the 0.5 m target once, slightly before the centre-arrival time', () => {
    const v0 = v3(0, 9.036976765, 99.590828147);
    expect(Math.abs(length(v0) - 100)).toBeLessThan(1e-6);
    const r = fireMgAt(v0, v3(0, 20, 100), v3());
    const ref = refMgContact(M, v0, v3(0, 20, 100), v3(), 0.5);
    expect(ref.t).toBeGreaterThan(0);
    expect(r.hitTime).not.toBeNull();
    const centreArrival = 1.004108529;
    expect(r.hitTime!).toBeLessThan(centreArrival);
    expect(r.hitTime!).toBeGreaterThan(centreArrival - 0.0055);
    expect(Math.abs(r.hitTime! - ref.t)).toBeLessThan(5e-6);
    // damage exactly once
    expect(r.target.hp).toBe(BIG_HP - 12);
    const dmg = ofType(r.events, 'enemy-damaged');
    expect(dmg.length).toBe(1);
    expect(dmg[0].e.amount).toBe(12);
    expect(dmg[0].e.enemyId).toBe('T1');
    const hits = ofType(r.events, 'projectile-hit');
    expect(hits.length).toBe(1);
    expect(hits[0].e).toMatchObject({ kind: 'mg', target: 'enemy', enemyId: 'T1' });
    // the hit point lies on the target's sphere, and the hit is reported by the tick that contains it
    expect(Math.abs(distance(r.hitPos!, v3(0, 20, 100)) - 0.5)).toBeLessThan(1e-9);
    expect(hits[0].time).toBeGreaterThanOrEqual(r.hitTime! - 1e-9);
    expect(hits[0].time - TICK).toBeLessThan(r.hitTime!);
    expect(r.bullet.alive).toBe(false);
    expect(r.sim.projectiles.length).toBe(0);
    expect(ofType(r.events, 'projectile-expired').length).toBe(0);
    console.log(
      `[projectiles] A03: first contact at ${r.hitTime!.toFixed(9)} s (reference ${ref.t.toFixed(9)} s, centre arrival ${centreArrival} s)`,
    );
  });

  it('A05: the spec launch velocity hits the target moving (8,0,0) once, slightly before the centre-arrival time', () => {
    const v0 = v3(8, 9.066521121, 99.266299391);
    expect(Math.abs(length(v0) - 100)).toBeLessThan(1e-6);
    const r = fireMgAt(v0, v3(0, 20, 100), v3(8, 0, 0));
    const ref = refMgContact(M, v0, v3(0, 20, 100), v3(8, 0, 0), 0.5);
    const centreArrival = 1.007391236;
    expect(r.hitTime).not.toBeNull();
    expect(r.hitTime!).toBeLessThan(centreArrival);
    expect(r.hitTime!).toBeGreaterThan(centreArrival - 0.0055);
    expect(Math.abs(r.hitTime! - ref.t)).toBeLessThan(5e-6);
    expect(r.target.hp).toBe(BIG_HP - 12);
    expect(ofType(r.events, 'enemy-damaged').length).toBe(1);
    // on the sphere of the target where it was at the moment of contact
    const centreAtHit = v3(8 * r.hitTime!, 20, 100);
    expect(Math.abs(distance(r.hitPos!, centreAtHit) - 0.5)).toBeLessThan(1e-4);
    expect(r.sim.projectiles.length).toBe(0);
    console.log(
      `[projectiles] A05: first contact at ${r.hitTime!.toFixed(9)} s (reference ${ref.t.toFixed(9)} s, centre arrival ${centreArrival} s)`,
    );
  });

  it('A05 with a bullet aimed at the current position (no lead, no elevation) misses: bullets are not guided', () => {
    const r = fireMgAt(v3(0, 0, 100), v3(0, 20, 100), v3(8, 0, 0));
    expect(r.hitTime).toBeNull();
    expect(r.target.hp).toBe(BIG_HP);
    expect(ofType(r.events, 'enemy-damaged').length).toBe(0);
    // it flew its unguided parabola 0.4 m past the target's path … (closest approach, by the reference)
    const ref = refMgContact(M, v3(0, 0, 100), v3(0, 20, 100), v3(8, 0, 0), 0.5);
    expect(ref.t).toBe(-1);
    expect(ref.minDist).toBeGreaterThan(5);
    // … and on into the floor: y = 20 − 9 t² = 0 at t = √(20/9)
    const hits = ofType(r.events, 'projectile-hit');
    expect(hits.length).toBe(1);
    expect(hits[0].e.target).toBe('world');
    expect(Math.abs(hits[0].e.pos.y)).toBeLessThan(1e-9);
    expect(Math.abs(hits[0].e.pos.z - 100 * Math.sqrt(20 / 9))).toBeLessThan(1e-3);
    expect(hits[0].e.pos.x).toBe(0);
  });

  const A: Array<{ id: string; r: V3; v: V3 }> = [
    { id: 'A01', r: v3(0, 0, 20), v: v3() },
    { id: 'A02', r: v3(0, 0, 60), v: v3() },
    { id: 'A03', r: v3(0, 0, 100), v: v3() },
    { id: 'A04', r: v3(0, 0, 120), v: v3() },
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
  it('A01–A13: a bullet launched with the §4.3 solution really hits the moving 0.5 m target, once', () => {
    const rows: string[] = [];
    for (const c of A) {
      const p0 = add(M, c.r);
      const sol = solveGravityIntercept(M, p0, c.v, MG.speed, MG.gravity, MG.lifeSeconds);
      expect(sol, c.id).not.toBeNull();
      const v0 = scale(sol!.dir, MG.speed);
      const r = fireMgAt(v0, p0, c.v);
      expect(r.hitTime, c.id).not.toBeNull();
      expect(r.target.hp, c.id).toBe(BIG_HP - 12);
      expect(ofType(r.events, 'enemy-damaged').length, c.id).toBe(1);
      // first contact with the sphere precedes the centre-arrival time by about r / closing speed
      expect(r.hitTime!, c.id).toBeLessThan(sol!.t);
      expect(r.hitTime!, c.id).toBeGreaterThan(sol!.t - 0.007);
      const ref = refMgContact(M, v0, p0, c.v, 0.5);
      expect(Math.abs(r.hitTime! - ref.t), c.id).toBeLessThan(5e-6);
      rows.push(`${c.id} t=${sol!.t.toFixed(6)} contact=${r.hitTime!.toFixed(6)}`);
    }
    console.log(`[projectiles] A01–A13 single shots, all hit: ${rows.join(' | ')}`);
  });

  it('frame-rate independence: 30 / 60 / 120 fps frames give the identical hit', () => {
    const run = (fps: number): { hitPos: V3; hp: number; ticks: number; time: number } => {
      const sim = mk({ enemies: [makeTarget('T1', v3(0, 20, 100), v3(8, 0, 0))] });
      spawnMachinegunBullet(sim, M, v3(8, 9.066521121, 99.266299391));
      let hitPos: V3 | null = null;
      const frames = Math.round(1.5 * fps);
      for (let i = 0; i < frames; i++) {
        sim.advance(1 / fps);
        for (const e of sim.drainEvents()) if (e.type === 'projectile-hit' && e.target === 'enemy') hitPos = e.pos;
      }
      expect(hitPos).not.toBeNull();
      return { hitPos: hitPos!, hp: sim.enemies[0].hp, ticks: sim.tickIndex, time: sim.time };
    };
    const a = run(30);
    const b = run(60);
    const c = run(120);
    expect(a.ticks).toBe(180);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(a.hp).toBe(BIG_HP - 12);
    console.log(`[projectiles] A05 hit time at 30/60/120 fps: ${(a.hitPos.z / 99.266299391).toFixed(9)} s (bit-identical)`);
  });

  it('sub-step partition independence: 1/120, 1/360 and irregular sub-steps agree on the hit', () => {
    const v0 = v3(8, 9.066521121, 99.266299391);
    const run = (steps: (i: number) => number): { time: number; pos: V3 } => {
      const sim = mk({ enemies: [makeTarget('T1', v3(0, 20, 100), v3(8, 0, 0))] });
      spawnMachinegunBullet(sim, M, v0);
      for (let i = 0; sim.time < 1.5; i++) {
        for (const e of stepDirect(sim, steps(i))) {
          if (e.type === 'projectile-hit' && e.target === 'enemy') return { time: e.pos.z / v0.z, pos: e.pos };
        }
      }
      throw new Error('no hit');
    };
    const base = run(() => TICK);
    const fine = run(() => TICK / 3);
    const irregular = run((i) => [0.0031, 0.0071, 0.0002, 0.0083, 0.00005][i % 5]);
    for (const other of [fine, irregular]) {
      // the only difference is the chord approximation of the parabola (≤ 1.6e-4 m)
      expect(Math.abs(other.time - base.time)).toBeLessThan(5e-6);
      expect(distance(other.pos, base.pos)).toBeLessThan(1e-3);
    }
  });
});

describe('machine-gun bullet: continuous collision with moving targets (§4.5)', () => {
  it('head-on at 300 m/s relative speed: hit although no tick-end position is inside the target', () => {
    // target flies towards the muzzle at 200 m/s; relative travel per tick is 2.5 m, the target is 1 m wide
    const vel = v3(0, 0, -200);
    // the bullet is inside the sphere for only 1/300 s; choose the range so that this window lies strictly
    // between two tick boundaries (an end-point-only test at the tick ends would then see nothing)
    let p0 = v3();
    let v0 = v3();
    let sol = solveGravityIntercept(M, v3(0, 20, 150), vel, MG.speed, MG.gravity, MG.lifeSeconds)!;
    let naive = true;
    for (let range = 150; range < 152.5 && naive; range += 0.25) {
      p0 = v3(0, 20, range);
      sol = solveGravityIntercept(M, p0, vel, MG.speed, MG.gravity, MG.lifeSeconds)!;
      expect(sol).not.toBeNull();
      v0 = scale(sol.dir, MG.speed);
      naive = false;
      for (let k = 0; k <= 240; k++) {
        if (distance(mgPos(M, v0, k * TICK), linPos(p0, vel, k * TICK)) <= 0.5) naive = true;
      }
    }
    expect(naive).toBe(false);
    const r = fireMgAt(v0, p0, vel);
    expect(r.target.hp).toBe(BIG_HP - 12);
    const ref = refMgContact(M, v0, p0, vel, 0.5);
    expect(Math.abs(r.hitTime! - ref.t)).toBeLessThan(5e-6);
    expect(r.hitTime!).toBeLessThan(sol.t);
    console.log(`[projectiles] 300 m/s head-on: contact at ${r.hitTime!.toFixed(6)} s (reference ${ref.t.toFixed(6)} s)`);
  });

  it('target crossing the trajectory at 300 m/s: hit exactly when the geometry says so', () => {
    const muzzle = v3(0, 50, 0);
    const v0 = v3(0, 0, 100);
    const cv = v3(300, 0, 0);
    const tc = 0.5037; // crossing time, deliberately not on a tick boundary
    const at = mgPos(muzzle, v0, tc);
    // vertical offset of the target centre from the bullet at the crossing time → miss distance
    const cases: Array<{ dy: number; hit: boolean }> = [
      { dy: 0, hit: true },
      { dy: 0.45, hit: true },
      { dy: -0.47, hit: true },
      { dy: 0.55, hit: false },
      { dy: -0.6, hit: false },
      { dy: 2.0, hit: false },
    ];
    for (const c of cases) {
      const centreAtTc = v3(at.x, at.y + c.dy, at.z);
      const c0 = linPos(centreAtTc, cv, -tc);
      const ref = refMgContact(muzzle, v0, c0, cv, 0.5);
      expect(ref.t >= 0, `reference dy=${c.dy}`).toBe(c.hit);
      const r = fireMgAt(v0, c0, cv, { muzzle });
      expect(r.target.hp, `dy=${c.dy}`).toBe(c.hit ? BIG_HP - 12 : BIG_HP);
      expect(ofType(r.events, 'enemy-damaged').length, `dy=${c.dy}`).toBe(c.hit ? 1 : 0);
      if (c.hit) expect(Math.abs(r.hitTime! - ref.t), `dy=${c.dy}`).toBeLessThan(5e-6);
    }
    // crossing a little early / late: 1.2 m of lateral lead is still a hit, 2.4 m is not
    const early = fireMgAt(v0, linPos(v3(at.x + 1.2, at.y, at.z), cv, -tc), cv, { muzzle });
    expect(refMgContact(muzzle, v0, linPos(v3(at.x + 1.2, at.y, at.z), cv, -tc), cv, 0.5).t).toBeGreaterThan(0);
    expect(early.target.hp).toBe(BIG_HP - 12);
    const late = fireMgAt(v0, linPos(v3(at.x - 2.4, at.y, at.z), cv, -tc), cv, { muzzle });
    expect(refMgContact(muzzle, v0, linPos(v3(at.x - 2.4, at.y, at.z), cv, -tc), cv, 0.5).t).toBe(-1);
    expect(late.target.hp).toBe(BIG_HP);
  });

  it('randomised fast crossings (150–320 m/s target speed) agree with the brute-force reference', () => {
    const rng = new Rng(4242);
    let hits = 0;
    let misses = 0;
    let skipped = 0;
    let worstDt = 0;
    for (let n = 0; n < 160; n++) {
      const muzzle = v3(rng.range(-5, 5), 200 + rng.range(-5, 5), rng.range(-5, 5));
      const v0 = scale(normalize(v3(rng.range(-0.3, 0.3), rng.range(-0.2, 0.3), 1)), 100);
      const tc = rng.range(0.15, 1.85);
      const speed = rng.range(150, 320);
      const cv = scale(normalize(v3(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1))), speed);
      const off = scale(normalize(v3(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1))), rng.range(0, 1.3));
      const c0 = linPos(add(mgPos(muzzle, v0, tc), off), cv, -tc);
      const ref = refMgContact(muzzle, v0, c0, cv, 0.5);
      if (Math.abs(ref.minDist - 0.5) < 2e-3) {
        skipped++; // too close to tangential to call
        continue;
      }
      const sim = mk({ enemies: [makeTarget('T1', c0, cv)] });
      spawnMachinegunBullet(sim, muzzle, v0);
      const events = runTicks(sim, 241);
      const hit = ofType(events, 'projectile-hit');
      expect(ofType(events, 'projectile-hit').filter((s) => s.e.target === 'world').length).toBe(0);
      if (ref.t >= 0) {
        hits++;
        expect(hit.length, `case ${n}`).toBe(1);
        expect(sim.enemies[0].hp, `case ${n}`).toBe(BIG_HP - 12);
        // reported by the tick containing the reference contact time, at the reference position
        expect(hit[0].time, `case ${n}`).toBeGreaterThanOrEqual(ref.t - 1e-5);
        expect(hit[0].time - TICK, `case ${n}`).toBeLessThanOrEqual(ref.t + 1e-5);
        expect(distance(hit[0].e.pos, mgPos(muzzle, v0, ref.t)), `case ${n}`).toBeLessThan(2e-3);
        const tHit = (hit[0].e.pos.z - muzzle.z) / v0.z;
        worstDt = Math.max(worstDt, Math.abs(tHit - ref.t));
      } else {
        misses++;
        expect(hit.length, `case ${n}`).toBe(0);
        expect(sim.enemies[0].hp, `case ${n}`).toBe(BIG_HP);
      }
      expect(sim.projectiles.length).toBe(0);
    }
    expect(hits).toBeGreaterThan(25);
    expect(misses).toBeGreaterThan(25);
    console.log(
      `[projectiles] random fast crossings: ${hits} hits, ${misses} misses, ${skipped} tangential skipped — all as the reference; worst contact-time error ${worstDt.toExponential(2)} s`,
    );
  });

  it('a bullet spawned inside a target hits it at the muzzle on its first sub-step', () => {
    const sim = mk({ enemies: [makeTarget('T1', v3(0.2, 20.1, 0.1))] });
    spawnMachinegunBullet(sim, M, v3(0, 0, 100));
    const events = runTicks(sim, 1);
    const hits = ofType(events, 'projectile-hit');
    expect(hits.length).toBe(1);
    expect(hits[0].e.pos).toEqual(M);
    expect(sim.enemies[0].hp).toBe(BIG_HP - 12);
    expect(sim.projectiles.length).toBe(0);
  });

  it('only the first target on the path is damaged; destroyed targets no longer stop bullets', () => {
    // every bullet flies the same parabola through (0, 20, 40); FAR sits on that parabola 20 m further on
    const v0 = scale(solveGravityIntercept(M, v3(0, 20, 40), v3(), 100, 18, 2)!.dir, 100);
    const sim = mk({
      enemies: [
        makeTarget('FAR', mgPos(M, v0, 60 / v0.z), v3(), 0.5),
        makeTarget('NEAR', v3(0, 20, 40), v3(), 0.5, 20),
        makeTarget('SAME', v3(0, 20, 40), v3(), 0.5), // coincides with NEAR: the lower index wins the tie
      ],
    });
    const [far, near, same] = sim.enemies;
    const shoot = (): Stamped[] => {
      spawnMachinegunBullet(sim, M, v0);
      return runTicks(sim, 120);
    };
    let ev = shoot();
    expect(near.hp).toBe(8);
    expect(same.hp).toBe(BIG_HP);
    expect(far.hp).toBe(BIG_HP);
    expect(ofType(ev, 'enemy-damaged').length).toBe(1);
    ev = shoot(); // kills NEAR (hp 8 → 0)
    expect(near.alive).toBe(false);
    expect(ofType(ev, 'enemy-destroyed').length).toBe(1);
    expect(same.hp).toBe(BIG_HP);
    ev = shoot(); // NEAR is dead: now SAME takes it
    expect(same.hp).toBe(BIG_HP - 12);
    expect(far.hp).toBe(BIG_HP);
    same.alive = false;
    ev = shoot(); // both dead: the bullet reaches FAR
    expect(far.hp).toBe(BIG_HP - 12);
    expect(ofType(ev, 'projectile-hit').length).toBe(1);
    expect(sim.projectiles.length).toBe(0);
  });

  it('contacts of one sub-step are applied in time order, not list order', () => {
    // A (first in the list) and B both reach the 12-hp target within the same sub-step, B earlier.
    const centre = v3(0, 20, 50);
    const solA = solveGravityIntercept(M, centre, v3(), 100, 18, 2)!;
    const vA = scale(solA.dir, 100);
    const tA = refMgContact(M, vA, centre, v3(), 0.5).t;
    const stepOfA = Math.floor(tA / TICK); // A touches the sphere during sub-step [stepOfA, stepOfA + 1]·TICK
    const fracA = tA / TICK - stepOfA;
    expect(fracA).toBeGreaterThan(0.3);
    // B drops straight down onto the target; spawn it so that it touches at 40 % of A's fraction
    const spawnStepB = 36;
    const wantB = (stepOfA + 0.4 * fracA) * TICK - spawnStepB * TICK; // B's age at contact
    const mB = v3(0, 20.5 + 100 * wantB + 9 * wantB * wantB, 50);
    const vB = v3(0, -100, 0);
    const tB = spawnStepB * TICK + refMgContact(mB, vB, centre, v3(), 0.5).t;
    expect(tB).toBeLessThan(tA);
    expect(Math.floor(tB / TICK)).toBe(stepOfA);

    // optional thin plate inside the far part of A's chord of that sub-step, beside B's vertical path
    const zContactA = vA.z * tA;
    const zEndA = vA.z * (stepOfA + 1) * TICK;
    const zPlate = 0.5 * (zContactA + zEndA);
    expect(zPlate - zContactA).toBeGreaterThan(0.1);
    expect(zPlate + 0.05).toBeLessThan(50 - 1e-3);

    const scenario = (withPlate: boolean): { sim: Sim; a: Projectile; b: Projectile; hits: Array<Ev<'projectile-hit'>>; events: SimEvent[] } => {
      const sim = mk({
        enemies: [makeTarget('T1', centre, v3(), 0.5, 12)],
        solids: withPlate ? [solid(-1, 19, zPlate, 1, 20.3, zPlate + 0.05)] : [],
      });
      const a = spawnMachinegunBullet(sim, M, vA);
      let b: Projectile | null = null;
      const events: SimEvent[] = [];
      for (let k = 0; k <= stepOfA; k++) {
        if (k === spawnStepB) b = spawnMachinegunBullet(sim, mB, vB);
        const ev = stepDirect(sim, TICK);
        if (k < stepOfA) expect(ev.filter((e) => e.type === 'projectile-hit').length).toBe(0); // nothing before that sub-step
        events.push(...ev);
      }
      const hits = events.filter((e): e is Ev<'projectile-hit'> => e.type === 'projectile-hit');
      return { sim, a, b: b!, hits, events };
    };

    const open = scenario(false);
    expect(open.hits.length).toBe(1);
    expect(distance(open.hits[0].pos, v3(0, 20.5, 50))).toBeLessThan(1e-6); // B's contact (top of the sphere) won …
    expect(open.b.alive).toBe(false);
    expect(open.a.alive).toBe(true); // … although A comes first in the list; A flew on through the wreck
    expect(open.sim.projectiles).toEqual([open.a]);
    expect(open.sim.enemies[0].alive).toBe(false);
    expect(open.sim.enemies[0].hp).toBe(0);
    expect(open.events.filter((e) => e.type === 'enemy-damaged').length).toBe(1);
    expect(distance(open.a.pos, mgPos(M, vA, open.sim.time))).toBeLessThan(1e-9);

    // with the plate: after losing its target A is re-tested and stopped by the plate in the same sub-step
    const plate = scenario(true);
    expect(plate.hits.length).toBe(2);
    expect(plate.hits[0]).toMatchObject({ target: 'enemy', enemyId: 'T1' });
    expect(distance(plate.hits[0].pos, v3(0, 20.5, 50))).toBeLessThan(1e-6);
    expect(plate.hits[1]).toMatchObject({ target: 'world', enemyId: null });
    expect(Math.abs(plate.hits[1].pos.z - zPlate)).toBeLessThan(1e-9);
    expect(plate.a.alive).toBe(false);
    expect(plate.sim.projectiles.length).toBe(0);
    expect(plate.events.filter((e) => e.type === 'enemy-damaged').length).toBe(1);
  });
});

describe('machine-gun bullet: stage collision and life end (§4.5, §9)', () => {
  it('stops at a thin 0.5 m wall wherever the wall falls inside the step, never reaching the target behind', () => {
    for (const wallZ of [30, 30.13, 30.31, 30.47, 30.62, 30.79, 55.02, 71.4]) {
      const v0 = v3(0, 0, 100);
      const r = fireMgAt(v0, v3(0, 19, wallZ + 3), v3(), {
        solids: [solid(-5, 0, wallZ, 5, 40, wallZ + 0.5)],
      });
      expect(r.target.hp, `wall ${wallZ}`).toBe(BIG_HP);
      const hits = ofType(r.events, 'projectile-hit');
      expect(hits.length, `wall ${wallZ}`).toBe(1);
      expect(hits[0].e).toMatchObject({ kind: 'mg', target: 'world', enemyId: null });
      expect(Math.abs(hits[0].e.pos.z - wallZ), `wall ${wallZ}`).toBeLessThan(1e-9);
      const a = wallZ / 100;
      expect(Math.abs(hits[0].e.pos.y - (20 - 9 * a * a)), `wall ${wallZ}`).toBeLessThan(2e-4);
      expect(hits[0].e.pos.x).toBe(0);
      // reported by the tick in which the wall was reached
      expect(hits[0].time).toBeGreaterThanOrEqual(a - 1e-9);
      expect(hits[0].time - TICK).toBeLessThan(a);
      expect(r.sim.projectiles.length).toBe(0);
      expect(ofType(r.events, 'projectile-expired').length).toBe(0);
    }
  });

  it('stops at floors, ceilings and thin plates hit at a shallow angle', () => {
    // floor of the test stage (top face y = 0)
    let sim = mk();
    spawnMachinegunBullet(sim, M, v3(0, -60, 80));
    let hits = ofType(runTicks(sim, 240), 'projectile-hit');
    expect(hits.length).toBe(1);
    expect(hits[0].e.target).toBe('world');
    expect(Math.abs(hits[0].e.pos.y)).toBeLessThan(1e-9);
    const tFloor = (-60 + Math.sqrt(3600 + 720)) / 18;
    expect(Math.abs(hits[0].e.pos.z - 80 * tFloor)).toBeLessThan(1e-3);
    expect(sim.projectiles.length).toBe(0);

    // a 0.2 m ceiling plate above the lofted bullet
    sim = mk({ solids: [solid(-10, 26, 20, 10, 26.2, 90)] });
    spawnMachinegunBullet(sim, M, v3(0, 30, 95.39392014169457)); // rises to y = 45 without the plate
    hits = ofType(runTicks(sim, 240), 'projectile-hit');
    expect(hits.length).toBe(1);
    expect(hits[0].e.target).toBe('world');
    expect(Math.abs(hits[0].e.pos.y - 26)).toBeLessThan(1e-9);

    // a 0.05 m plate grazed at ~1.5°: the falling bullet must land on its top face, not pass through
    sim = mk({ solids: [solid(-10, 19.0, 20, 10, 19.05, 80)] });
    spawnMachinegunBullet(sim, M, v3(0, 0, 100));
    hits = ofType(runTicks(sim, 240), 'projectile-hit');
    expect(hits.length).toBe(1);
    expect(Math.abs(hits[0].e.pos.y - 19.05)).toBeLessThan(1e-9);
    const tPlate = Math.sqrt(0.95 / 9);
    expect(Math.abs(hits[0].e.pos.z - 100 * tPlate)).toBeLessThan(0.02);
  });

  it('is removed at the life end: nothing beyond 2 s of flight is ever hit', () => {
    const muzzle = v3(0, 100, 0);
    const v0 = v3(0, 0, 100);
    const end = mgPos(muzzle, v0, 2); // (0, 64, 200)
    expect(end).toEqual(v3(0, 64, 200));
    const u = normalize(v3(0, -36, 100)); // direction of flight at the life end

    // targets centred just beyond / just before the 2 s point along the trajectory
    const beyond = fireMgAt(v0, add(end, scale(u, 0.55)), v3(), { muzzle });
    expect(beyond.target.hp).toBe(BIG_HP);
    const expired = ofType(beyond.events, 'projectile-expired');
    expect(expired.length).toBe(1);
    expect(distance(expired[0].e.pos, end)).toBeLessThan(1e-9);
    expect(expired[0].tick).toBe(240);
    expect(ofType(beyond.events, 'projectile-hit').length).toBe(0);
    expect(beyond.sim.projectiles.length).toBe(0);

    const within = fireMgAt(v0, add(end, scale(u, 0.45)), v3(), { muzzle });
    expect(within.target.hp).toBe(BIG_HP - 12); // touched during the last interval
    expect(ofType(within.events, 'projectile-expired').length).toBe(0);
    expect(within.hitTime!).toBeGreaterThan(2 - TICK);
    expect(within.hitTime!).toBeLessThan(2);

    // a target moving up into the end point, arriving 0.03 s after the life end, is not hit either
    const lateArrival = fireMgAt(v0, v3(0, 64 - 2.03 * 30, 200), v3(0, 30, 0), { muzzle });
    expect(refMgContact(muzzle, v0, v3(0, 64 - 2.03 * 30, 200), v3(0, 30, 0), 0.5).t).toBe(-1);
    expect(lateArrival.target.hp).toBe(BIG_HP);
    // … while arriving 0.01 s late means the sphere already overlaps the end point at 2 s: hit
    const justInTime = fireMgAt(v0, v3(0, 64 - 2.01 * 30, 200), v3(0, 30, 0), { muzzle });
    expect(justInTime.target.hp).toBe(BIG_HP - 12);

    // a target sitting exactly on the extended parabola at age 2.02 s: reached only by a longer-lived bullet
    const onPath = mgPos(muzzle, v0, 2.02);
    expect(refMgContact(muzzle, v0, onPath, v3(), 0.5, 2.1).t).toBeGreaterThan(2);
    expect(refMgContact(muzzle, v0, onPath, v3(), 0.5).t).toBe(-1);
    const farther = fireMgAt(v0, onPath, v3(), { muzzle });
    expect(farther.target.hp).toBe(BIG_HP);
    expect(ofType(farther.events, 'projectile-expired').length).toBe(1);

    // walls: 5 cm beyond the end point → untouched; 5 cm before → hit
    const wallBeyond = fireMgAt(v0, v3(50, 5, 0), v3(), { muzzle, solids: [solid(-5, 40, 200.05, 5, 90, 200.55)] });
    expect(ofType(wallBeyond.events, 'projectile-hit').length).toBe(0);
    expect(ofType(wallBeyond.events, 'projectile-expired').length).toBe(1);
    const wallBefore = fireMgAt(v0, v3(50, 5, 0), v3(), { muzzle, solids: [solid(-5, 40, 199.95, 5, 90, 200.45)] });
    const wh = ofType(wallBefore.events, 'projectile-hit');
    expect(wh.length).toBe(1);
    expect(Math.abs(wh[0].e.pos.z - 199.95)).toBeLessThan(1e-9);
    expect(ofType(wallBefore.events, 'projectile-expired').length).toBe(0);
  });

  it('clamps the last interval to the life end when it falls inside a sub-step', () => {
    const muzzle = v3(0, 100, 0);
    const v0 = v3(0, 0, 100);
    const end = v3(0, 64, 200);
    const u = normalize(v3(0, -36, 100));
    const run = (targetOffset: number, h: number): { hp: number; events: SimEvent[]; sim: Sim; steps: number } => {
      const sim = mk({ enemies: [makeTarget('T1', add(end, scale(u, targetOffset)))] });
      spawnMachinegunBullet(sim, muzzle, v0);
      const events: SimEvent[] = [];
      let steps = 0;
      while (sim.projectiles.length > 0 && steps < 1000) {
        events.push(...stepDirect(sim, h));
        steps++;
      }
      return { hp: sim.enemies[0].hp, events, sim, steps };
    };
    for (const h of [0.007, 0.0083, 0.0031]) {
      const miss = run(0.55, h);
      expect(miss.hp).toBe(BIG_HP);
      // removed by the first sub-step that reaches 2 s, at the position of age exactly 2
      expect(miss.steps).toBe(Math.ceil(2 / h - 1e-9));
      const ex = miss.events.filter((e): e is Ev<'projectile-expired'> => e.type === 'projectile-expired');
      expect(ex.length).toBe(1);
      expect(distance(ex[0].pos, end)).toBeLessThan(1e-9);
      const hit = run(0.45, h);
      expect(hit.hp).toBe(BIG_HP - 12);
      expect(hit.events.filter((e) => e.type === 'projectile-expired').length).toBe(0);
    }
  });

  it('in the clamped last interval a fast target is evaluated up to the life end only', () => {
    // sub-steps of 7 ms: the last one is [1.995, 2.002], the bullet lives until 2.000. A target rising at
    // 300 m/s reaches the bullet's end point shortly AFTER the life end, but inside that sub-step.
    const muzzle = v3(0, 100, 0);
    const v0 = v3(0, 0, 100);
    const end = v3(0, 64, 200);
    const cv = v3(0, 300, 0);
    const run = (arrival: number): { hp: number; expired: number; ref: number } => {
      const c0 = linPos(end, cv, -arrival);
      const sim = mk({ enemies: [makeTarget('T1', c0, cv)] });
      spawnMachinegunBullet(sim, muzzle, v0);
      let expired = 0;
      for (let k = 0; k < 286; k++) expired += stepDirect(sim, 0.007).filter((e) => e.type === 'projectile-expired').length;
      expect(sim.projectiles.length).toBe(0);
      return { hp: sim.enemies[0].hp, expired, ref: refMgContact(muzzle, v0, c0, cv, 0.5).t };
    };
    // centre 0.57 m short of the end point at 2.000 s → no contact within the life
    const late = run(2.0019);
    expect(late.ref).toBe(-1);
    expect(late.hp).toBe(BIG_HP);
    expect(late.expired).toBe(1);
    // centre 0.36 m short at 2.000 s → the sphere already covers the end point → hit
    const inTime = run(2.0012);
    expect(inTime.ref).toBeGreaterThan(1.995);
    expect(inTime.hp).toBe(BIG_HP - 12);
    expect(inTime.expired).toBe(0);
  });

  it('cluttered box field: every bullet stops where its parabola first enters a solid', () => {
    const rng = new Rng(777);
    const solids: SolidDef[] = [];
    for (let i = 0; i < 90; i++) {
      // thin plates and chunky blocks
      const thinAxis = rng.int(4);
      const sx = thinAxis === 0 ? rng.range(0.15, 0.6) : rng.range(2, 14);
      const sy = thinAxis === 1 ? rng.range(0.15, 0.6) : rng.range(2, 14);
      const sz = thinAxis === 2 ? rng.range(0.15, 0.6) : rng.range(2, 14);
      const x = rng.range(-110, 110);
      const y = rng.range(0, 40);
      const z = rng.range(-110, 110);
      solids.push(solid(x, y, z, x + sx, y + sy, z + sz));
    }
    const sim = mk({ solids, start: v3(380, 2.001, 380) });
    const world = sim.world;
    const shots: Array<{ p: Projectile; m: V3; v0: V3 }> = [];
    while (shots.length < 120) {
      const m = v3(rng.range(-100, 100), rng.range(2, 45), rng.range(-100, 100));
      if (world.overlapsBox(m, v3(0.05, 0.05, 0.05))) continue; // muzzles are never inside a solid
      const v0 = scale(normalize(v3(rng.range(-1, 1), rng.range(-0.35, 0.45), rng.range(-1, 1))), 100);
      shots.push({ p: spawnMachinegunBullet(sim, m, v0), m, v0 });
    }
    const events = runTicks(sim, 241, () => {
      for (const s of shots) {
        if (!s.p.alive) continue;
        // a surviving bullet's last chord is free of solids
        expect(world.segmentBlocked(s.p.prevPos, s.p.pos)).toBe(false);
      }
    });
    expect(sim.projectiles.length).toBe(0);
    let stopped = 0;
    let worst = 0;
    for (const s of shots) {
      // reference: march the closed form in 0.5 ms chords (≤ 6e-7 m off the curve)
      const dt = 5e-4;
      let expected: V3 | null = null;
      let a = clone(s.m);
      for (let i = 1; i <= 4000 && !expected; i++) {
        const b = mgPos(s.m, s.v0, i * dt);
        const d = sub(b, a);
        const hit = world.raycast(a, d, 1);
        if (hit) expected = clone(hit.point);
        a = b;
      }
      if (expected) {
        stopped++;
        worst = Math.max(worst, distance(s.p.pos, expected));
        expect(distance(s.p.pos, expected)).toBeLessThan(0.02);
      } else {
        expect(distance(s.p.pos, mgPos(s.m, s.v0, 2))).toBeLessThan(1e-9);
      }
    }
    expect(ofType(events, 'projectile-hit').length).toBe(stopped);
    expect(ofType(events, 'projectile-expired').length).toBe(shots.length - stopped);
    expect(stopped).toBeGreaterThan(60);
    console.log(
      `[projectiles] box field: ${stopped}/${shots.length} MG bullets stopped by solids, worst distance to the reference entry point ${worst.toExponential(2)} m`,
    );
  });
});

// ───────────────────────────── missiles ─────────────────────────────

describe('missile (§4.1, §4.4)', () => {
  it('spawns at exactly 45 m/s along the given direction with its target id and launch observation', () => {
    const sim = mk({ enemies: [makeTarget('T1', v3(0, 20, 100), v3(8, 0, 0))] });
    sim.runFor(0.05);
    const target = sim.enemies[0];
    const p = spawnMissile(sim, M, v3(0.3, 0.1, 2), 'T1'); // not unit length on purpose
    expect(sim.projectiles).toEqual([p]);
    expect(p.kind).toBe('missile');
    expect(p.alive).toBe(true);
    expect(p.damage).toBe(180);
    expect(p.lifeSeconds).toBe(4);
    expect(p.spawnTime).toBe(sim.time);
    expect(p.targetId).toBe('T1');
    expect(Math.abs(length(p.vel) - 45)).toBeLessThan(1e-12);
    expect(angleBetween(p.vel, v3(0.3, 0.1, 2))).toBeLessThan(1e-12);
    expect(p.v0).toEqual(p.vel);
    expect(p.pos).toEqual(M);
    expect(p.obsPos).toEqual(target.pos);
    expect(p.obsVel).toEqual(target.vel);
    expect(p.obsTime).toBe(sim.time);
    expect(p.obsPos).not.toBe(target.pos);
  });

  const leadCases: Array<{ id: string; v: V3 }> = [
    { id: 'A05', v: v3(8, 0, 0) },
    { id: 'A06', v: v3(-8, 0, 0) },
    { id: 'A07', v: v3(0, 0, 8) },
    { id: 'A08', v: v3(0, 0, -8) },
  ];
  for (const c of leadCases) {
    it(`${c.id}: launched along the lead direction it hits the target moving (${c.v.x},${c.v.y},${c.v.z}) at 100 m`, () => {
      const p0 = v3(0, 20, 100);
      const sim = mk({ enemies: [makeTarget('T1', p0, c.v)] });
      const target = sim.enemies[0];
      const sol = solveLinearIntercept(M, p0, c.v, MSL.speed, MSL.lifeSeconds)!;
      expect(sol).not.toBeNull();
      const p = spawnMissile(sim, M, sol.dir, 'T1');
      let prevVel = clone(p.vel);
      let prevPos = clone(p.pos);
      let worstSpeed = 0;
      let worstTurn = 0;
      let totalTurn = 0;
      const events = runTicks(sim, 480, () => {
        if (!p.alive) return;
        worstSpeed = Math.max(worstSpeed, Math.abs(length(p.vel) - 45));
        const turn = angleBetween(prevVel, p.vel);
        worstTurn = Math.max(worstTurn, turn);
        totalTurn += turn;
        // distance flown in the tick is 45·TICK (never more)
        const flown = distance(p.pos, prevPos);
        expect(flown).toBeLessThanOrEqual(45 * TICK + 1e-9);
        expect(flown).toBeGreaterThan(45 * TICK * (1 - 1e-6));
        prevVel = clone(p.vel);
        prevPos = clone(p.pos);
      });
      expect(worstSpeed).toBeLessThan(1e-9);
      expect(worstTurn).toBeLessThanOrEqual(TURN * TICK + 1e-9);
      expect(totalTurn).toBeLessThan(1e-6); // already on the collision course: no steering needed
      expect(target.hp).toBe(BIG_HP - 180);
      const dmg = ofType(events, 'enemy-damaged');
      expect(dmg.length).toBe(1);
      expect(dmg[0].e.amount).toBe(180);
      const hits = ofType(events, 'projectile-hit');
      expect(hits.length).toBe(1);
      expect(hits[0].e).toMatchObject({ kind: 'missile', target: 'enemy', enemyId: 'T1' });
      // contact with the 0.5 m sphere shortly before the centre-arrival time of the launch solution
      expect(hits[0].time - TICK).toBeLessThan(sol.t);
      expect(hits[0].time).toBeGreaterThan(sol.t - 0.03);
      expect(p.targetId).toBe('T1');
      expect(sim.projectiles.length).toBe(0);
      console.log(
        `[projectiles] missile ${c.id}: lead solution ${sol.t.toFixed(6)} s, hit reported at ${hits[0].time.toFixed(6)} s, |speed−45| ≤ ${worstSpeed.toExponential(1)}`,
      );
    });
  }

  it('launched 35° off the lead direction it turns at no more than 120°/s and still hits', () => {
    const p0 = v3(0, 20, 100);
    const vel = v3(8, 0, 0);
    const sim = mk({ enemies: [makeTarget('T1', p0, vel)] });
    const lead = solveLinearIntercept(M, p0, vel, 45, 4)!.dir;
    const off = (35 * Math.PI) / 180;
    // rotate the lead direction about +Y by 35° (towards -X) and tilt it up a little
    const dir = normalize(v3(lead.x * Math.cos(off) - lead.z * Math.sin(off), 0.15, lead.x * Math.sin(off) + lead.z * Math.cos(off)));
    const p = spawnMissile(sim, M, dir, 'T1');
    let prevVel = clone(p.vel);
    const turns: number[] = [];
    let worstSpeed = 0;
    const events = runTicks(sim, 480, () => {
      if (!p.alive) return;
      turns.push(angleBetween(prevVel, p.vel));
      worstSpeed = Math.max(worstSpeed, Math.abs(length(p.vel) - 45));
      prevVel = clone(p.vel);
    });
    expect(sim.enemies[0].hp).toBe(BIG_HP - 180);
    expect(ofType(events, 'enemy-damaged').length).toBe(1);
    expect(worstSpeed).toBeLessThan(1e-9);
    // per tick and over every 1 s window the heading change stays within the limit
    const perTick = Math.max(...turns);
    expect(perTick).toBeLessThanOrEqual(TURN * TICK + 1e-9);
    expect(perTick).toBeGreaterThan(TURN * TICK - 1e-9); // the limit was actually reached while correcting
    let worstWindow = 0;
    for (let i = 0; i + 120 <= turns.length; i++) {
      let s = 0;
      for (let k = 0; k < 120; k++) s += turns[i + k];
      worstWindow = Math.max(worstWindow, s);
    }
    expect(worstWindow).toBeLessThanOrEqual(TURN + 1e-7);
    // it did not snap: the correction of ≥ 35° took at least 35/120 s
    const saturated = turns.filter((t) => t > TURN * TICK - 1e-9).length;
    expect(saturated).toBeGreaterThanOrEqual(Math.floor((35 / 120) * 120));
    console.log(
      `[projectiles] missile 35° off: max turn/tick ${((perTick * 180) / Math.PI).toFixed(6)}° (limit 1°), max over 1 s ${((worstWindow * 180) / Math.PI).toFixed(3)}°, saturated ticks ${saturated}`,
    );
  });

  it('follows the guidance law every sub-step: lead of the current target state, bounded turn, speed 45', () => {
    // direct sub-step control; expectations are computed from the true target state at the interval start
    const scenarios: Array<{ name: string; p0: V3; v: V3; dir: V3; h: number }> = [
      { name: 'lead, 90° off', p0: v3(0, 20, 100), v: v3(8, 0, 0), dir: v3(1, 0, 0), h: TICK },
      { name: 'receding faster than the missile (no solution → current position)', p0: v3(10, 30, 60), v: v3(0, 0, 60), dir: v3(0, 1, 0), h: TICK },
      { name: 'solution beyond the remaining life (→ current position)', p0: v3(0, 20, 170), v: v3(20, 0, 0), dir: v3(0, 0, 1), h: TICK },
      { name: 'irregular sub-steps', p0: v3(-20, 35, 90), v: v3(6, -3, 4), dir: v3(1, 0.2, 0.3), h: 0.0037 },
    ];
    for (const s of scenarios) {
      const sim = mk({ enemies: [makeTarget('T1', s.p0, s.v)] });
      const target = sim.enemies[0];
      const p = spawnMissile(sim, M, s.dir, 'T1');
      let fallback = 0;
      let solved = 0;
      let steps = 0;
      while (p.alive && steps < 2000) {
        const t0 = sim.time;
        const before = clone(p.vel);
        const posBefore = clone(p.pos);
        const tposBefore = clone(target.pos);
        const remaining = p.spawnTime + 4 - t0;
        const sol = solveLinearIntercept(posBefore, tposBefore, s.v, 45, remaining);
        const desired = sol ? sol.dir : normalize(sub(tposBefore, posBefore));
        if (sol) solved++;
        else fallback++;
        stepDirect(sim, s.h);
        steps++;
        if (!p.alive) break; // hit or expired: pos is the hit / end point
        const maxTurn = TURN * s.h;
        expect(angleBetween(before, p.vel), s.name).toBeLessThanOrEqual(maxTurn + 1e-9);
        expect(Math.abs(angleBetween(p.vel, desired) - Math.max(0, angleBetween(before, desired) - maxTurn)), s.name).toBeLessThan(1e-9);
        expect(Math.abs(length(p.vel) - 45), s.name).toBeLessThan(1e-9);
        // straight move along the NEW heading
        expect(distance(p.pos, linPos(posBefore, p.vel, s.h)), s.name).toBeLessThan(1e-9);
        expect(p.prevPos, s.name).toEqual(posBefore);
        // the observation is the target state at the interval start
        expect(p.obsPos, s.name).toEqual(tposBefore);
        expect(p.obsVel, s.name).toEqual(s.v);
        expect(p.obsTime, s.name).toBe(t0);
      }
      if (s.name.startsWith('lead') || s.name.startsWith('irregular')) {
        expect(target.hp, s.name).toBe(BIG_HP - 180);
        expect(fallback, s.name).toBe(0);
      } else {
        expect(fallback, s.name).toBeGreaterThan(100);
        expect(target.hp, s.name).toBe(BIG_HP); // could not be caught: expired
        expect(Math.abs(sim.time - 4), s.name).toBeLessThan(1e-9);
      }
      expect(sim.projectiles.length, s.name).toBe(0);
      console.log(`[projectiles] guidance law "${s.name}": ${steps} sub-steps, ${solved} lead / ${fallback} direct`);
    }
  });

  it('misses a target inside its turning circle (needs more than 120°/s) and expires after 4 s', () => {
    // turning radius 45 / (120° in rad) = 21.49 m; the target sits 10 m to the side, 2 m ahead
    const tp = v3(10, 20, 2);
    const sim = mk({ enemies: [makeTarget('T1', tp)] });
    const p = spawnMissile(sim, M, v3(0, 0, 1), 'T1');
    let prevVel = clone(p.vel);
    let total = 0;
    let minTurn = Infinity;
    let maxTurn = 0;
    let minDist = Infinity;
    let worstSpeed = 0;
    const events = runTicks(sim, 480, () => {
      if (!p.alive) return;
      const turn = angleBetween(prevVel, p.vel);
      total += turn;
      minTurn = Math.min(minTurn, turn);
      maxTurn = Math.max(maxTurn, turn);
      minDist = Math.min(minDist, distance(p.pos, tp));
      worstSpeed = Math.max(worstSpeed, Math.abs(length(p.vel) - 45));
      prevVel = clone(p.vel);
    });
    expect(sim.enemies[0].hp).toBe(BIG_HP);
    expect(ofType(events, 'projectile-hit').length).toBe(0);
    const expired = ofType(events, 'projectile-expired');
    expect(expired.length).toBe(1);
    expect(expired[0].e.kind).toBe('missile');
    expect(expired[0].tick).toBe(480);
    expect(sim.projectiles.length).toBe(0);
    // it turned as hard as allowed the whole time — exactly 1° per tick, never more
    expect(maxTurn).toBeLessThanOrEqual(TURN * TICK + 1e-9);
    expect(minTurn).toBeGreaterThan(TURN * TICK - 1e-9);
    expect(worstSpeed).toBeLessThan(1e-9);
    expect(minDist).toBeGreaterThan(9);
    expect(Math.abs(expired[0].e.pos.y - 20)).toBeLessThan(1e-9);
    console.log(
      `[projectiles] missile vs target inside the turning circle: total turn ${((total * 180) / Math.PI).toFixed(3)}° in 479 measured ticks, closest approach ${minDist.toFixed(2)} m, no hit`,
    );
  });

  it('flies its full 4 s / 180 m when nothing is hit and is then removed', () => {
    const sim = mk({ enemies: [makeTarget('T1', v3(0, 20, 300))] });
    const dir = normalize(v3(0.2, 0.3, 1));
    const p = spawnMissile(sim, M, dir, 'ghost'); // unknown target id: flies straight
    const events = runTicks(sim, 479);
    expect(p.alive).toBe(true);
    expect(events.length).toBe(0);
    runTicks(sim, 1, undefined, events);
    expect(p.alive).toBe(false);
    expect(sim.projectiles.length).toBe(0);
    const expired = ofType(events, 'projectile-expired');
    expect(expired.length).toBe(1);
    expect(distance(expired[0].e.pos, linPos(M, dir, 180))).toBeLessThan(1e-9);
    expect(p.targetId).toBe('ghost');

    // life end inside a sub-step (7 ms steps): still exactly 4 s / 180 m, removed by the step that reaches it
    const sim2 = mk();
    const q = spawnMissile(sim2, M, dir, 'ghost');
    let steps = 0;
    let end: V3 | null = null;
    while (sim2.projectiles.length > 0 && steps < 1000) {
      for (const e of stepDirect(sim2, 0.007)) if (e.type === 'projectile-expired') end = e.pos;
      steps++;
    }
    expect(steps).toBe(Math.ceil(4 / 0.007));
    expect(q.alive).toBe(false);
    expect(distance(end!, linPos(M, dir, 180))).toBeLessThan(1e-9);
  });

  it('keeps flying straight after its target died and never retargets', () => {
    const sim = mk({
      enemies: [
        makeTarget('T1', v3(40, 20, 80), v3(0, 0, 0), 0.5, 100),
        makeTarget('DECOY', v3(-12, 20, 60), v3(3, 0, 0)), // alive, close to the path, never the target
      ],
    });
    const [target, decoy] = sim.enemies;
    const p = spawnMissile(sim, M, v3(0, 0, 1), 'T1');
    runTicks(sim, 30); // 0.25 s of turning towards T1
    expect(angleBetween(p.vel, v3(0, 0, 1))).toBeGreaterThan(0.4); // it was steering (≈ 30° − …)
    sim.damageEnemy(target, 1000);
    expect(target.alive).toBe(false);
    const velAtDeath = clone(p.vel);
    const posAtDeath = clone(p.pos);
    const tDeath = sim.time;
    let worstLine = 0;
    const events = runTicks(sim, 480 - 30, () => {
      if (!p.alive) return;
      expect(p.vel).toEqual(velAtDeath); // bit-identical heading: no steering at all
      worstLine = Math.max(worstLine, distance(p.pos, linPos(posAtDeath, velAtDeath, sim.time - tDeath)));
      expect(p.targetId).toBe('T1');
    });
    expect(worstLine).toBeLessThan(1e-9);
    expect(decoy.hp).toBe(BIG_HP);
    expect(ofType(events, 'projectile-hit').length).toBe(0);
    const expired = ofType(events, 'projectile-expired');
    expect(expired.length).toBe(1);
    expect(distance(expired[0].e.pos, linPos(posAtDeath, velAtDeath, 4 - tDeath))).toBeLessThan(1e-9);
    expect(p.targetId).toBe('T1');
    expect(sim.projectiles.length).toBe(0);
  });

  it('a direct hit damages whichever enemy is actually hit (and only that one)', () => {
    const sim = mk({
      enemies: [makeTarget('T1', v3(0, 20, 100)), makeTarget('BLOCK', v3(0, 20.2, 40), v3(), 0.5)],
    });
    const [target, block] = sim.enemies;
    const p = spawnMissile(sim, M, v3(0, 0, 1), 'T1');
    const events = runTicks(sim, 480);
    expect(block.hp).toBe(BIG_HP - 180);
    expect(target.hp).toBe(BIG_HP);
    const hits = ofType(events, 'projectile-hit');
    expect(hits.length).toBe(1);
    expect(hits[0].e.enemyId).toBe('BLOCK');
    expect(ofType(events, 'enemy-damaged').length).toBe(1);
    expect(p.targetId).toBe('T1');
    expect(sim.projectiles.length).toBe(0);
  });

  it('a door closes between missile and target: it keeps steering by the extrapolated last observation and hits the door', () => {
    interface Run {
      hit: Ev<'projectile-hit'> | null;
      p: Projectile;
      target: EnemyState;
      sim: Sim;
      xAt60: number;
      xExpected: number;
    }
    const run = (doorCloses: boolean): Run => {
      // a closable wall (a barrier box, like the factory's bulkheads) across the whole range at z = 60
      const stage = makeTestStage({ enemies: [makeTarget('T1', v3(0, 20, 100), v3(8, 0, 0))] });
      stage.barriers.push({
        id: 'DOOR',
        name: 'test door',
        box: { min: v3(-80, 0, 60), max: v3(80, 60, 60.5) },
        controlEnemyId: 'none',
        fromSectorId: 'T00',
        toSectorId: 'T00',
      });
      const sim = new Sim(stage);
      sim.world.setBarrierOpen('DOOR', true);
      const target = sim.enemies[0];
      sim.runFor(0.1); // the target is moving, enemy.vel is its actual velocity
      const lead = solveLinearIntercept(M, target.pos, target.vel, 45, 4)!;
      const p = spawnMissile(sim, M, lead.dir, 'T1');
      expect(p.obsPos).toEqual(target.pos); // seen at launch
      expect(p.obsVel).toEqual(v3(8, 0, 0));
      let hit: Ev<'projectile-hit'> | null = null;
      let xAt60 = Number.NaN;
      let frozen: { pos: V3; vel: V3; time: number } | null = null;
      let tick = 0;
      const events = runTicks(sim, 480, () => {
        tick++;
        if (p.alive && Number.isNaN(xAt60) && p.pos.z >= 60) xAt60 = p.pos.x - ((p.pos.z - 60) * p.vel.x) / p.vel.z;
        if (tick === 12) {
          // 0.1 s after the launch: still observing every sub-step
          expect(p.obsTime!).toBeGreaterThan(sim.time - TICK - 1e-9);
          if (doorCloses) {
            sim.world.setBarrierOpen('DOOR', false);
            frozen = { pos: clone(p.obsPos!), vel: clone(p.obsVel!), time: p.obsTime! };
          }
          // … and now the target reverses: with the door closed the missile cannot know
          target.scriptedVel = v3(-8, 0, 0);
        }
        if (frozen && tick > 12 && p.alive) {
          expect(p.obsTime).toBe(frozen.time);
          expect(p.obsPos).toEqual(frozen.pos);
          expect(p.obsVel).toEqual(frozen.vel);
        }
      });
      for (const s of ofType(events, 'projectile-hit')) hit = s.e;
      // straight along the launch lead: where the launch direction meets the plane z = 60
      return { hit, p, target, sim, xAt60, xExpected: (60 * lead.dir.x) / lead.dir.z };
    };

    const hidden = run(true);
    expect(hidden.hit).not.toBeNull();
    expect(hidden.hit!.target).toBe('world');
    expect(hidden.hit!.kind).toBe('missile');
    expect(Math.abs(hidden.hit!.pos.z - 60)).toBeLessThan(1e-9); // stopped on the door face, not behind it
    expect(hidden.xExpected).toBeGreaterThan(10); // towards where the target was heading when last seen (+X)
    expect(Math.abs(hidden.hit!.pos.x - hidden.xExpected)).toBeLessThan(1e-6);
    expect(Math.abs(hidden.hit!.pos.y - 20)).toBeLessThan(1e-9);
    expect(hidden.target.hp).toBe(BIG_HP);
    expect(hidden.target.pos.x).toBeLessThan(-7); // the real target went the other way
    expect(hidden.sim.projectiles.length).toBe(0);
    expect(hidden.p.targetId).toBe('T1');

    // control: with the door left open the same missile sees the reversal, curves the other way and hits
    const open = run(false);
    expect(open.target.hp).toBe(BIG_HP - 180);
    expect(open.xAt60).toBeLessThan(hidden.xExpected - 8);
    console.log(
      `[projectiles] door closed after 0.1 s: door hit at x=${hidden.hit!.pos.x.toFixed(6)} (lead of the last observation: ${hidden.xExpected.toFixed(6)}); ` +
        `control with the door open crosses z=60 at x=${open.xAt60.toFixed(3)} and hits`,
    );
  });

  it('a target hidden at launch is never peeked at: no observation, no steering, the wall is hit', () => {
    const sim = mk({
      enemies: [makeTarget('T1', v3(0, 20, 100), v3(8, 0, 0))],
      solids: [solid(-80, 0, 60, 80, 60, 60.5)],
    });
    const target = sim.enemies[0];
    sim.runFor(0.1);
    const dir = normalize(v3(0.1, 0, 1));
    const p = spawnMissile(sim, M, dir, 'T1');
    expect(p.obsPos).toBeNull();
    expect(p.obsVel).toBeNull();
    expect(p.obsTime).toBeNull();
    const v = clone(p.vel);
    const events = runTicks(sim, 480, () => {
      if (!p.alive) return;
      expect(p.vel).toEqual(v); // bit-identical: it never turned towards the hidden target
      expect(p.obsPos).toBeNull();
      expect(p.obsTime).toBeNull();
    });
    const hits = ofType(events, 'projectile-hit');
    expect(hits.length).toBe(1);
    expect(hits[0].e.target).toBe('world');
    expect(Math.abs(hits[0].e.pos.z - 60)).toBeLessThan(1e-9);
    expect(Math.abs(hits[0].e.pos.x - 6)).toBeLessThan(1e-9);
    expect(target.hp).toBe(BIG_HP);
    expect(p.targetId).toBe('T1');
    expect(sim.projectiles.length).toBe(0);
  });

  it('partial occlusion: observation freezes while hidden, the aim is extrapolated, and it resumes when visible again', () => {
    // pillar between the missile and where the target drifts; sub-steps driven directly for exact bookkeeping
    const sim = mk({
      enemies: [makeTarget('T1', v3(0, 20, 100), v3(0, 0, 0))],
      solids: [solid(3, 0, 69, 9, 60, 71)],
    });
    const target = sim.enemies[0];
    const p = spawnMissile(sim, M, v3(0, 0, 1), 'T1');
    const h = TICK;
    let obs = { pos: clone(target.pos), vel: clone(target.vel), time: 0 };
    let hiddenSteps = 0;
    let reobserved = 0;
    let wasHidden = false;
    let maxBeliefError = 0;
    let truthDiffers = 0;
    let steps = 0;
    while (p.alive && steps < 600) {
      const t0 = sim.time;
      if (steps === 60) target.scriptedVel = v3(30, 0, 0); // seen: starts drifting right at 30 m/s
      const trueVel = clone(target.scriptedVel!);
      const visible = !sim.world.segmentBlocked(p.pos, target.pos);
      if (visible) {
        obs = { pos: clone(target.pos), vel: trueVel, time: t0 };
        if (wasHidden) reobserved++;
        wasHidden = false;
      } else {
        if (!wasHidden) target.scriptedVel = v3(0, 0, 0); // stops the moment it is hidden: the missile cannot know
        hiddenSteps++;
        wasHidden = true;
      }
      const aim = linPos(obs.pos, obs.vel, t0 - obs.time);
      maxBeliefError = Math.max(maxBeliefError, distance(aim, target.pos));
      const before = clone(p.vel);
      const posBefore = clone(p.pos);
      const sol = solveLinearIntercept(posBefore, aim, obs.vel, 45, p.spawnTime + 4 - t0);
      const desired = sol ? sol.dir : normalize(sub(aim, posBefore));
      // what steering by the TRUE hidden state would have asked for
      const cheat = solveLinearIntercept(posBefore, target.pos, target.scriptedVel!, 45, p.spawnTime + 4 - t0);
      const cheatDir = cheat ? cheat.dir : normalize(sub(target.pos, posBefore));
      stepDirect(sim, h);
      steps++;
      if (!p.alive) break;
      expect(p.obsTime).toBe(obs.time);
      expect(p.obsPos).toEqual(obs.pos);
      expect(p.obsVel).toEqual(obs.vel);
      const maxTurn = TURN * h;
      // the heading moved towards the BELIEVED lead direction, as far as the turn limit allows …
      expect(Math.abs(angleBetween(p.vel, desired) - Math.max(0, angleBetween(before, desired) - maxTurn))).toBeLessThan(1e-9);
      if (!visible && angleBetween(desired, cheatDir) > 0.02) {
        // … which is measurably not what steering by the true hidden state would have produced
        const cheatError = Math.abs(angleBetween(p.vel, cheatDir) - Math.max(0, angleBetween(before, cheatDir) - maxTurn));
        if (cheatError > 1e-4) truthDiffers++;
      }
    }
    expect(hiddenSteps).toBeGreaterThanOrEqual(5);
    expect(reobserved).toBeGreaterThanOrEqual(1);
    expect(maxBeliefError).toBeGreaterThan(1);
    expect(truthDiffers).toBeGreaterThanOrEqual(3);
    expect(p.targetId).toBe('T1');
    console.log(
      `[projectiles] partial occlusion: ${hiddenSteps} hidden sub-steps (${truthDiffers} where truth and belief ask for different turns), ${reobserved} re-observation(s), belief up to ${maxBeliefError.toFixed(2)} m from the truth, target hp lost ${BIG_HP - target.hp}`,
    );
  });

  it('prefers the collision with floors / ceilings over reaching a hidden target', () => {
    // target below the floor slab of the test stage: the line of sight is blocked from the start
    const sim = mk({ enemies: [makeTarget('T1', v3(0, -6, 50))] });
    const p = spawnMissile(sim, M, normalize(v3(0, -26, 50)), 'T1');
    const events = runTicks(sim, 480);
    const hits = ofType(events, 'projectile-hit');
    expect(hits.length).toBe(1);
    expect(hits[0].e.target).toBe('world');
    expect(Math.abs(hits[0].e.pos.y)).toBeLessThan(1e-9);
    expect(sim.enemies[0].hp).toBe(BIG_HP);
    expect(p.alive).toBe(false);
    expect(sim.projectiles.length).toBe(0);
  });

  it('frame-rate independence: 30 / 60 / 120 fps give the identical missile hit', () => {
    const run = (fps: number): { hit: V3; hp: number; ticks: number } => {
      const sim = mk({ enemies: [makeTarget('T1', v3(0, 20, 100), v3(8, 0, 0))] });
      spawnMissile(sim, M, v3(0.5, 0.2, 1), 'T1'); // off the lead: it has to steer
      let hit: V3 | null = null;
      for (let i = 0; i < Math.round(3.5 * fps); i++) {
        sim.advance(1 / fps);
        for (const e of sim.drainEvents()) if (e.type === 'projectile-hit') hit = e.pos;
      }
      expect(hit).not.toBeNull();
      return { hit: hit!, hp: sim.enemies[0].hp, ticks: sim.tickIndex };
    };
    const a = run(30);
    expect(a.hp).toBe(BIG_HP - 180);
    expect(run(60)).toEqual(a);
    expect(run(120)).toEqual(a);
  });
});

// ───────────────────────────── enemy bullets ─────────────────────────────

describe('enemy bullets (§2.3)', () => {
  const owners = (): EnemyDef[] => [
    passive('G1', 'guard', v3(300, 1.3, 300)),
    passive('T1', 'turret', v3(300, 1.6, 310)),
  ];

  it('take speed / damage / life from the shooter kind and record origin and owner', () => {
    const sim = mk({ enemies: owners() });
    const [guard, turret] = sim.enemies;
    const m = v3(10, 30, -20);
    const g = spawnEnemyBullet(sim, guard, m, v3(0, 0, 2)); // not unit length on purpose
    const t = spawnEnemyBullet(sim, turret, m, normalize(v3(1, 1, 0)));
    expect(sim.projectiles).toEqual([g, t]);
    expect(g).toMatchObject({ kind: 'enemy', alive: true, damage: 18, lifeSeconds: 2, ownerEnemyId: 'G1', ownerKind: 'guard' });
    expect(t).toMatchObject({ kind: 'enemy', alive: true, damage: 40, lifeSeconds: 3, ownerEnemyId: 'T1', ownerKind: 'turret' });
    expect(g.origin).toEqual(m);
    expect(g.pos).toEqual(m);
    expect(g.vel).toEqual(v3(0, 0, 70));
    expect(Math.abs(length(t.vel) - 60)).toBeLessThan(1e-12);
    expect(ENEMIES.guard.bulletSpeed).toBe(70);
    expect(ENEMIES.turret.bulletSpeed).toBe(60);
  });

  it('fly straight at constant speed (no gravity, no guidance) and expire after exactly 2 s / 3 s', () => {
    const sim = mk({ enemies: owners() });
    const [guard, turret] = sim.enemies;
    const mg = v3(-30, 40, 10);
    const mt = v3(30, 50, -10);
    const dg = normalize(v3(1, 1, 0.5));
    const dt = normalize(v3(-0.3, 1, 1));
    const g = spawnEnemyBullet(sim, guard, mg, dg);
    const t = spawnEnemyBullet(sim, turret, mt, dt);
    const events: Stamped[] = [];
    let worst = 0;
    runTicks(
      sim,
      239,
      () => {
        worst = Math.max(worst, distance(g.pos, linPos(mg, dg, 70 * sim.time)), distance(t.pos, linPos(mt, dt, 60 * sim.time)));
        expect(g.vel).toEqual(g.v0);
        expect(t.vel).toEqual(t.v0);
      },
      events,
    );
    expect(worst).toBeLessThan(1e-9);
    expect(g.alive).toBe(true);
    expect(events.length).toBe(0);
    runTicks(sim, 1, undefined, events); // 2.0 s
    expect(g.alive).toBe(false);
    expect(sim.projectiles).toEqual([t]);
    let expired = ofType(events, 'projectile-expired');
    expect(expired.length).toBe(1);
    expect(expired[0].e.kind).toBe('enemy');
    expect(distance(expired[0].e.pos, linPos(mg, dg, 140))).toBeLessThan(1e-9);
    runTicks(sim, 119, undefined, events); // 3.0 s − 1 tick
    expect(t.alive).toBe(true);
    runTicks(sim, 1, undefined, events);
    expect(t.alive).toBe(false);
    expired = ofType(events, 'projectile-expired');
    expect(expired.length).toBe(2);
    expect(distance(expired[1].e.pos, linPos(mt, dt, 180))).toBeLessThan(1e-9);
    expect(sim.projectiles.length).toBe(0);
    expect(sim.player.hp).toBe(1000);
  });

  it('hit the moving player box exactly once: HP −18 (guard) and −40 (turret)', () => {
    const sim = mk({ enemies: owners() });
    const [guard, turret] = sim.enemies;
    sim.input.moveX = 1; // walk to the right (+X at yaw 0)
    sim.runFor(0.5);
    sim.drainEvents();
    expect(sim.player.vel.x).toBeCloseTo(10, 6);
    const fire = (owner: EnemyState, muzzle: V3): { events: Stamped[]; muzzle: V3 } => {
      const cfg = ENEMIES[owner.kind];
      const sol = solveLinearIntercept(muzzle, sim.player.pos, sim.player.vel, cfg.bulletSpeed, 1.2)!;
      expect(sol).not.toBeNull();
      spawnEnemyBullet(sim, owner, muzzle, sol.dir);
      return { events: runTicks(sim, 240), muzzle };
    };

    const a = fire(guard, v3(sim.player.pos.x + 30, 2.6, -60));
    expect(sim.player.hp).toBe(982);
    let dmg = ofType(a.events, 'player-damaged');
    expect(dmg.length).toBe(1);
    expect(dmg[0].e.amount).toBe(18);
    expect(dmg[0].e.fromEnemyId).toBe('G1');
    expect(dmg[0].e.sourcePos).toEqual(a.muzzle);
    let hits = ofType(a.events, 'projectile-hit');
    expect(hits.length).toBe(1);
    expect(hits[0].e).toMatchObject({ kind: 'enemy', target: 'player', enemyId: null });
    expect(ofType(a.events, 'projectile-expired').length).toBe(0);
    expect(sim.projectiles.length).toBe(0);
    expect(guard.hp).toBe(BIG_HP);

    const b = fire(turret, v3(sim.player.pos.x - 40, 9, 45));
    expect(sim.player.hp).toBe(942);
    dmg = ofType(b.events, 'player-damaged');
    expect(dmg.length).toBe(1);
    expect(dmg[0].e.amount).toBe(40);
    expect(dmg[0].e.fromEnemyId).toBe('T1');
    hits = ofType(b.events, 'projectile-hit');
    expect(hits.length).toBe(1);
    expect(sim.projectiles.length).toBe(0);
    // no further damage afterwards
    runTicks(sim, 240);
    expect(sim.player.hp).toBe(942);
    expect(sim.status).toBe('playing');
  });

  it('the hit point lies on the surface of the moving box at the moment of contact', () => {
    const sim = mk({ enemies: owners() });
    const guard = sim.enemies[0];
    sim.input.moveX = 1;
    sim.runFor(0.5);
    const muzzle = v3(sim.player.pos.x + 5, 2.4, -70);
    const sol = solveLinearIntercept(muzzle, sim.player.pos, sim.player.vel, 70, 1.2)!;
    spawnEnemyBullet(sim, guard, muzzle, sol.dir);
    const startX = sim.player.pos.x;
    const startT = sim.time;
    const events = runTicks(sim, 240);
    const hit = ofType(events, 'projectile-hit')[0];
    expect(hit.e.target).toBe('player');
    // contact time from the straight flight; box centre at that time from the constant walk
    const tc = distance(hit.e.pos, muzzle) / 70;
    const cx = startX + 10 * tc;
    expect(tc).toBeLessThan(sol.t);
    expect(hit.time - startT).toBeGreaterThanOrEqual(tc - 1e-9);
    expect(hit.time - startT - TICK).toBeLessThan(tc);
    // it entered through the -Z face (z = centre − 1.3) and inside the face's extent
    expect(Math.abs(hit.e.pos.z - (sim.player.pos.z - PLAYER.half.z))).toBeLessThan(1e-6);
    expect(Math.abs(hit.e.pos.x - cx)).toBeLessThan(PLAYER.half.x);
    expect(Math.abs(hit.e.pos.y - sim.player.pos.y)).toBeLessThan(PLAYER.half.y);
  });

  it('are straight and unguided: a shot at the current position of a strafing player misses', () => {
    const sim = mk({ enemies: owners() });
    const guard = sim.enemies[0];
    sim.input.moveX = 1;
    sim.runFor(0.5);
    const muzzle = v3(sim.player.pos.x, 2.4, -80);
    const p = spawnEnemyBullet(sim, guard, muzzle, normalize(sub(sim.player.pos, muzzle)));
    const v = clone(p.vel);
    const events = runTicks(sim, 241, () => {
      if (p.alive) expect(p.vel).toEqual(v);
    });
    expect(sim.player.hp).toBe(1000);
    expect(ofType(events, 'player-damaged').length).toBe(0);
    expect(sim.projectiles.length).toBe(0);
  });

  it('clip the corner of the player box between two tick-end positions (continuous test) — and miss just outside', () => {
    const run = (sum: number): { hp: number; sim: Sim; naive: boolean } => {
      const sim = mk({ enemies: owners() });
      sim.runFor(0.1); // settle on the floor
      const c = sim.player.pos;
      // path along x + z = sum (relative to the box centre), direction (-1, 0, +1)/√2
      const start = v3(c.x + sum / 2 + 0.2, c.y, c.z + sum / 2 - 0.2);
      const dir = normalize(v3(-1, 0, 1));
      spawnEnemyBullet(sim, sim.enemies[0], start, dir);
      let naive = false;
      for (let k = 0; k <= 3; k++) {
        const q = linPos(start, dir, 70 * TICK * k);
        if (Math.abs(q.x - c.x) <= 1.3 && Math.abs(q.z - c.z) <= 1.3) naive = true;
      }
      runTicks(sim, 3);
      return { hp: sim.player.hp, sim, naive };
    };
    const clip = run(2.5); // 0.14 m of the path is inside the corner
    expect(clip.naive).toBe(false); // no tick-end position is inside the box
    expect(clip.hp).toBe(982);
    expect(clip.sim.projectiles.length).toBe(0);
    const outside = run(2.7); // passes 0.07 m outside the corner
    expect(outside.hp).toBe(1000);
    expect(outside.sim.projectiles.length).toBe(1);
  });

  it('sweep against the box moving prevPos→pos within the sub-step (relative motion)', () => {
    const sim = mk({ enemies: owners() });
    const guard = sim.enemies[0];
    const pl = sim.player;
    // sub-step [t, t+h]: the box moves 10 m sideways while the bullet crosses its path at mid-step;
    // at both ends of the sub-step the bullet is far outside the box
    const h = TICK;
    const y = pl.pos.y;
    const start = v3(0, y, -70 * h * 0.5);
    spawnEnemyBullet(sim, guard, start, v3(0, 0, 1));
    const t0 = sim.time;
    pl.prevPos.x = -5;
    pl.prevPos.z = 0;
    pl.prevPos.y = y;
    pl.pos.x = 5;
    pl.pos.z = 0;
    advanceProjectiles(sim, t0, t0 + h);
    const events = sim.drainEvents();
    expect(pl.hp).toBe(982);
    const hit = events.find((e): e is Ev<'projectile-hit'> => e.type === 'projectile-hit')!;
    expect(hit.target).toBe('player');
    // first contact: the box sweeps over the bullet, whose line x = 0 is reached by the box's +X face
    // (centre.x + 1.3 = 0 with centre.x = −5 + 10·u) at u = 0.37 of the sub-step
    const u = (5 - 1.3) / 10;
    expect(Math.abs(hit.pos.z - (start.z + 70 * h * u))).toBeLessThan(1e-9);
    expect(sim.projectiles.length).toBe(0);

    // control: the same bullet with the box parked at its end position is a miss
    const sim2 = mk({ enemies: owners() });
    spawnEnemyBullet(sim2, sim2.enemies[0], start, v3(0, 0, 1));
    sim2.player.prevPos.x = 5;
    sim2.player.pos.x = 5;
    advanceProjectiles(sim2, sim2.time, sim2.time + h);
    expect(sim2.player.hp).toBe(1000);
    expect(sim2.projectiles.length).toBe(1);
  });

  it('are blocked by walls (also thin ones) and floors: no damage behind cover', () => {
    for (const wallZ of [-20, -20.21, -20.4, -33.33]) {
      const sim = mk({ enemies: owners(), solids: [solid(-6, 0, wallZ - 0.5, 6, 8, wallZ)] });
      sim.runFor(0.1);
      const muzzle = v3(0, 2.5, -70);
      spawnEnemyBullet(sim, sim.enemies[0], muzzle, normalize(sub(sim.player.pos, muzzle)));
      const events = runTicks(sim, 240);
      expect(sim.player.hp, `wall ${wallZ}`).toBe(1000);
      const hits = ofType(events, 'projectile-hit');
      expect(hits.length).toBe(1);
      expect(hits[0].e).toMatchObject({ kind: 'enemy', target: 'world', enemyId: null });
      expect(Math.abs(hits[0].e.pos.z - (wallZ - 0.5)), `wall ${wallZ}`).toBeLessThan(1e-9);
      expect(ofType(events, 'player-damaged').length).toBe(0);
      expect(sim.projectiles.length).toBe(0);
    }
    // floor: a bullet fired into the ground in front of the player
    const sim = mk({ enemies: owners() });
    sim.runFor(0.1);
    const muzzle = v3(0, 12, -40);
    spawnEnemyBullet(sim, sim.enemies[1], muzzle, normalize(v3(0, -12, 20)));
    const events = runTicks(sim, 360);
    const hits = ofType(events, 'projectile-hit');
    expect(hits.length).toBe(1);
    expect(hits[0].e.target).toBe('world');
    expect(Math.abs(hits[0].e.pos.y)).toBeLessThan(1e-9);
    expect(Math.abs(hits[0].e.pos.z - -20)).toBeLessThan(1e-9);
    expect(sim.player.hp).toBe(1000);
  });

  it('pass through other enemies without any effect', () => {
    const sim = mk({
      enemies: [
        ...owners(),
        makeTarget('MID', v3(0, 2, -30), v3(), 3), // a big sphere right on the line of fire
        makeTarget('MOVING', v3(-4, 2, -15), v3(8, 0, 0), 2, 50), // crosses the line while the bullet passes
      ],
    });
    sim.runFor(0.1);
    const muzzle = v3(0, 2.2, -70);
    const p = spawnEnemyBullet(sim, sim.enemies[0], muzzle, normalize(sub(sim.player.pos, muzzle)));
    let insideMid = false;
    const events = runTicks(sim, 240, () => {
      if (p.alive && distance(p.pos, sim.enemies[2].pos) < 3) insideMid = true;
    });
    expect(insideMid).toBe(true); // it really flew through the sphere
    expect(sim.player.hp).toBe(982);
    expect(ofType(events, 'enemy-damaged').length).toBe(0);
    expect(ofType(events, 'enemy-destroyed').length).toBe(0);
    expect(sim.enemies[2].hp).toBe(BIG_HP);
    expect(sim.enemies[3].hp).toBe(50);
    const hits = ofType(events, 'projectile-hit');
    expect(hits.length).toBe(1);
    expect(hits[0].e.target).toBe('player');
  });

  it('test their last interval before being removed: 139.9 m is a hit, 140.3 m is not', () => {
    const run = (travel: number): { hp: number; events: Stamped[]; sim: Sim } => {
      const sim = mk({ enemies: owners() });
      sim.runFor(0.1);
      const c = sim.player.pos;
      const muzzle = v3(c.x, c.y, c.z - PLAYER.half.z - travel);
      spawnEnemyBullet(sim, sim.enemies[0], muzzle, v3(0, 0, 1));
      const events = runTicks(sim, 245);
      return { hp: sim.player.hp, events, sim };
    };
    const reach = run(139.9);
    expect(reach.hp).toBe(982);
    const hit = ofType(reach.events, 'projectile-hit')[0];
    expect(hit.tick).toBe(12 + 240); // during the very last tick of its life
    expect(ofType(reach.events, 'projectile-expired').length).toBe(0);
    const short = run(140.3);
    expect(short.hp).toBe(1000);
    expect(ofType(short.events, 'projectile-hit').length).toBe(0);
    const ex = ofType(short.events, 'projectile-expired');
    expect(ex.length).toBe(1);
    expect(ex[0].tick).toBe(12 + 240);
    expect(short.sim.projectiles.length).toBe(0);
  });

  it('a bullet spawned inside the player box hits on its first sub-step; player projectiles never hit the player', () => {
    const sim = mk({ enemies: owners() });
    sim.runFor(0.1);
    const c = clone(sim.player.pos);
    // the player's own weapons, fired from inside the box straight through it
    spawnMachinegunBullet(sim, v3(c.x, c.y, c.z + 1), v3(0, 0, -100));
    spawnMissile(sim, v3(c.x + 1, c.y, c.z + 1), v3(-1, 0, -1), 'none');
    runTicks(sim, 30);
    expect(sim.player.hp).toBe(1000);
    spawnEnemyBullet(sim, sim.enemies[0], v3(c.x + 0.5, c.y + 0.5, c.z), v3(1, 0, 0));
    const events = runTicks(sim, 1);
    expect(sim.player.hp).toBe(982);
    expect(ofType(events, 'player-damaged').length).toBe(1);
  });

  it('cluttered box field: every bullet ends exactly where a single long ray says', () => {
    const rng = new Rng(31337);
    const solids: SolidDef[] = [];
    for (let i = 0; i < 90; i++) {
      const thinAxis = rng.int(4);
      const sx = thinAxis === 0 ? rng.range(0.15, 0.6) : rng.range(2, 14);
      const sy = thinAxis === 1 ? rng.range(0.15, 0.6) : rng.range(2, 14);
      const sz = thinAxis === 2 ? rng.range(0.15, 0.6) : rng.range(2, 14);
      const x = rng.range(-110, 110);
      const y = rng.range(0, 40);
      const z = rng.range(-110, 110);
      solids.push(solid(x, y, z, x + sx, y + sy, z + sz));
    }
    const sim = mk({ solids, start: v3(380, 2.001, 380), enemies: [passive('G1', 'guard', v3(390, 1.3, 390)), passive('T1', 'turret', v3(390, 1.6, 380))] });
    const world = sim.world;
    const shots: Array<{ p: Projectile; expected: V3; blocked: boolean }> = [];
    while (shots.length < 160) {
      const owner = sim.enemies[shots.length % 2];
      const cfg = ENEMIES[owner.kind];
      const m = v3(rng.range(-100, 100), rng.range(1, 45), rng.range(-100, 100));
      if (world.overlapsBox(m, v3(0.05, 0.05, 0.05))) continue;
      const dir = normalize(v3(rng.range(-1, 1), rng.range(-0.4, 0.4), rng.range(-1, 1)));
      const reach = cfg.bulletSpeed * cfg.bulletLife;
      const hit = world.raycast(m, dir, reach);
      shots.push({
        p: spawnEnemyBullet(sim, owner, m, dir),
        expected: hit ? clone(hit.point) : linPos(m, dir, reach),
        blocked: !!hit,
      });
    }
    const events = runTicks(sim, 361);
    expect(sim.projectiles.length).toBe(0);
    let worst = 0;
    for (const s of shots) {
      expect(s.p.alive).toBe(false);
      worst = Math.max(worst, distance(s.p.pos, s.expected));
    }
    expect(worst).toBeLessThan(1e-6);
    const blocked = shots.filter((s) => s.blocked).length;
    expect(ofType(events, 'projectile-hit').length).toBe(blocked);
    expect(ofType(events, 'projectile-hit').every((s) => s.e.target === 'world')).toBe(true);
    expect(ofType(events, 'projectile-expired').length).toBe(shots.length - blocked);
    expect(blocked).toBeGreaterThan(60);
    expect(sim.player.hp).toBe(1000);
    console.log(
      `[projectiles] box field: ${blocked}/${shots.length} enemy bullets stopped by solids, worst end-point error vs a single long ray ${worst.toExponential(2)} m`,
    );
  });
});

// ───────────────────────────── beam ─────────────────────────────

describe('castBeam (§4.1, §4.4)', () => {
  const Z = v3(0, 0, 1);

  it('enemy in front of a wall: the enemy is hit at its sphere entry; no damage is applied by the cast', () => {
    const sim = mk({ enemies: [makeTarget('E', v3(0, 20, 50))], solids: [solid(-10, 0, 60, 10, 40, 61)] });
    const r = castBeam(sim, M, Z);
    expect(r.enemy).toBe(sim.enemies[0]);
    expect(r.hitWorld).toBe(false);
    expect(distance(r.end, v3(0, 20, 49.5))).toBeLessThan(1e-12);
    expect(r.distance).toBeCloseTo(49.5, 12);
    expect(sim.enemies[0].hp).toBe(BIG_HP);
    expect(sim.drainEvents().length).toBe(0);
    expect(sim.projectiles.length).toBe(0);
  });

  it('wall in front of an enemy: the wall stops the beam', () => {
    const sim = mk({ enemies: [makeTarget('E', v3(0, 20, 50))], solids: [solid(-10, 0, 30, 10, 40, 31)] });
    const r = castBeam(sim, M, Z);
    expect(r.enemy).toBeNull();
    expect(r.hitWorld).toBe(true);
    expect(distance(r.end, v3(0, 20, 30))).toBeLessThan(1e-12);
    expect(r.distance).toBeCloseTo(30, 12);
    // a wall that cuts through the enemy sphere: whichever surface comes first along the ray
    const sim2 = mk({ enemies: [makeTarget('E', v3(0, 20, 50), v3(), 2)], solids: [solid(-10, 0, 49, 10, 40, 49.2)] });
    expect(castBeam(sim2, M, Z).enemy).toBe(sim2.enemies[0]); // sphere entry 48 < wall 49
    const sim3 = mk({ enemies: [makeTarget('E', v3(0, 20, 50), v3(), 2)], solids: [solid(-10, 0, 47, 10, 40, 47.2)] });
    expect(castBeam(sim3, M, Z).hitWorld).toBe(true); // wall 47 < sphere entry 48
  });

  it('range limit 120 m for enemies and for the stage', () => {
    expect(WEAPONS.beam.range).toBe(120);
    // sphere entry at 120.1 m → out of range
    let sim = mk({ enemies: [makeTarget('E', v3(0, 20, 120.6))] });
    let r = castBeam(sim, M, Z);
    expect(r.enemy).toBeNull();
    expect(r.hitWorld).toBe(false);
    expect(r.end).toEqual(v3(0, 20, 120));
    expect(r.distance).toBe(120);
    // sphere entry at 119.9 m → hit, although the centre is beyond 120 m
    sim = mk({ enemies: [makeTarget('E', v3(0, 20, 120.4))] });
    r = castBeam(sim, M, Z);
    expect(r.enemy).toBe(sim.enemies[0]);
    expect(r.distance).toBeCloseTo(119.9, 9);
    // wall at 121 m → not reached; at 119 m → hit
    sim = mk({ solids: [solid(-10, 0, 121, 10, 40, 122)] });
    r = castBeam(sim, M, Z);
    expect(r.hitWorld).toBe(false);
    expect(r.end).toEqual(v3(0, 20, 120));
    sim = mk({ solids: [solid(-10, 0, 119, 10, 40, 120)] });
    r = castBeam(sim, M, Z);
    expect(r.hitWorld).toBe(true);
    expect(r.distance).toBeCloseTo(119, 12);
    // nothing at all: the beam ends at muzzle + dir·120 in any direction
    sim = mk();
    const d = normalize(v3(0.3, 0.5, -0.8));
    r = castBeam(sim, M, d);
    expect(r.enemy).toBeNull();
    expect(r.hitWorld).toBe(false);
    expect(distance(r.end, linPos(M, d, 120))).toBeLessThan(1e-12);
  });

  it('nearest of several enemies, ignoring dead ones and those off the ray', () => {
    const sim = mk({
      enemies: [
        makeTarget('E80', v3(0, 20, 80)),
        makeTarget('E40', v3(0, 20, 40)),
        makeTarget('E60', v3(0.3, 20, 60)),
        makeTarget('SIDE', v3(0.51, 20, 20)), // 0.51 m off the ray with radius 0.5: missed
        makeTarget('BEHIND', v3(0, 20, -5)),
      ],
    });
    const byId = (id: string): EnemyState => sim.enemyById.get(id)!;
    let r = castBeam(sim, M, Z);
    expect(r.enemy).toBe(byId('E40'));
    expect(r.distance).toBeCloseTo(39.5, 12);
    byId('E40').alive = false;
    r = castBeam(sim, M, Z);
    expect(r.enemy).toBe(byId('E60'));
    expect(r.distance).toBeCloseTo(60 - Math.sqrt(0.25 - 0.09), 12);
    byId('E60').alive = false;
    r = castBeam(sim, M, Z);
    expect(r.enemy).toBe(byId('E80'));
    // grazing: 0.49 m off the ray is a hit
    byId('SIDE').pos.x = 0.49;
    r = castBeam(sim, M, Z);
    expect(r.enemy).toBe(byId('SIDE'));
    for (const e of sim.enemies) expect(e.hp).toBe(BIG_HP);
  });

  it('uses the enemy position at the current time, and the direction from the muzzle', () => {
    const sim = mk({ enemies: [makeTarget('E', v3(0, 20, 100), v3(8, 0, 0))] });
    const e = sim.enemies[0];
    sim.runFor(1);
    expect(e.pos.x).toBeCloseTo(8, 9);
    // aimed at where it was a second ago: miss; at where it is now: hit
    expect(castBeam(sim, M, normalize(sub(v3(0, 20, 100), M))).enemy).toBeNull();
    const r = castBeam(sim, M, normalize(sub(e.pos, M)));
    expect(r.enemy).toBe(e);
    expect(r.distance).toBeCloseTo(distance(M, e.pos) - 0.5, 9);
  });

  it('handles the muzzle inside a sphere, non-unit and degenerate directions', () => {
    const sim = mk({ enemies: [makeTarget('E', v3(0, 20, 0.3)), makeTarget('F', v3(0, 20, 50))] });
    let r = castBeam(sim, M, Z);
    expect(r.enemy).toBe(sim.enemies[0]);
    expect(r.distance).toBe(0);
    expect(r.end).toEqual(M);
    sim.enemies[0].alive = false;
    r = castBeam(sim, M, v3(0, 0, 7)); // not unit length: normalised, the range stays 120 m
    expect(r.enemy).toBe(sim.enemies[1]);
    expect(r.distance).toBeCloseTo(49.5, 12);
    sim.enemies[1].alive = false;
    r = castBeam(sim, M, v3(0, 0, 7));
    expect(distance(r.end, v3(0, 20, 120))).toBeLessThan(1e-12);
    r = castBeam(sim, M, v3(0, 0, 0));
    expect(r).toEqual({ end: M, enemy: null, hitWorld: false, distance: 0 });
    r = castBeam(sim, M, v3(Number.NaN, 0, 1));
    expect(r.enemy).toBeNull();
    expect(finiteV(r.end)).toBe(true);
  });
});

// ───────────────────────────── bookkeeping ─────────────────────────────

describe('lifetime, cleanup and determinism (§9)', () => {
  function volley(sim: Sim, rng: Rng): void {
    const [guard, turret] = sim.enemies;
    const m = v3(rng.range(-20, 20), rng.range(5, 40), rng.range(-20, 20));
    const dir = normalize(v3(rng.range(-1, 1), rng.range(-0.5, 0.5), rng.range(-1, 1)));
    spawnMachinegunBullet(sim, m, scale(dir, 100));
    spawnEnemyBullet(sim, guard, m, dir);
    spawnEnemyBullet(sim, turret, m, scale(dir, -1));
    if (rng.next() < 0.2) spawnMissile(sim, m, dir, rng.next() < 0.5 ? 'MOVER' : 'G1');
  }
  const stage = (): MkOpts => ({
    enemies: [
      passive('G1', 'guard', v3(40, 1.3, 40)),
      passive('T1', 'turret', v3(-40, 1.6, 40)),
      makeTarget('MOVER', v3(0, 15, 60), v3(5, 0, -3), 1.5, 5000),
    ],
    solids: [solid(-60, 0, -40, 60, 30, -39.5), solid(25, 0, -30, 25.4, 20, 30), solid(-30, 18, -30, 30, 18.3, 30)],
  });

  it('sim.projectiles returns to length 0 after everything hit or expired; ids are unique and increasing', () => {
    const sim = mk(stage());
    const rng = new Rng(99);
    const ids = new Set<number>();
    let maxAlive = 0;
    let spawned = 0;
    const events: Stamped[] = [];
    for (let k = 0; k < 600; k++) {
      if (k < 480 && k % 6 === 0) {
        const before = sim.projectiles.length;
        volley(sim, rng);
        spawned += sim.projectiles.length - before;
        for (let i = before; i < sim.projectiles.length; i++) ids.add(sim.projectiles[i].id);
      }
      runTicks(sim, 1, undefined, events);
      maxAlive = Math.max(maxAlive, sim.projectiles.length);
      let lastId = 0;
      for (const p of sim.projectiles) {
        expect(p.alive).toBe(true);
        expect(finiteV(p.pos) && finiteV(p.prevPos) && finiteV(p.vel)).toBe(true);
        expect(p.id).toBeGreaterThan(lastId); // order of the list is kept by the compaction
        lastId = p.id;
        expect(ids.has(p.id)).toBe(true);
        expect(sim.time - p.spawnTime).toBeLessThan(p.lifeSeconds + 1e-9);
      }
    }
    expect(spawned).toBeGreaterThan(240);
    expect(ids.size).toBe(spawned);
    runTicks(sim, 4 * 120 + 1, undefined, events);
    expect(sim.projectiles.length).toBe(0);
    // every projectile ended exactly once: by a hit or by its life end
    const ended = ofType(events, 'projectile-hit').length + ofType(events, 'projectile-expired').length;
    expect(ended).toBe(spawned);
    expect(maxAlive).toBeLessThan(spawned);
    console.log(
      `[projectiles] cleanup: ${spawned} projectiles spawned, at most ${maxAlive} alive at once, 0 left; ` +
        `${ofType(events, 'projectile-hit').length} hits + ${ofType(events, 'projectile-expired').length} expiries`,
    );
  });

  it('is deterministic: the same inputs give the same event stream and final state', () => {
    const run = (): string => {
      const sim = mk(stage());
      const rng = new Rng(5);
      const events: Stamped[] = [];
      for (let k = 0; k < 400; k++) {
        if (k % 5 === 0) volley(sim, rng);
        runTicks(sim, 1, undefined, events);
      }
      return JSON.stringify({ events, projectiles: sim.projectiles, enemies: sim.enemies.map((e) => [e.hp, e.pos]), hp: sim.player.hp });
    };
    const a = run();
    expect(run()).toBe(a);
    expect(a.includes('null')).toBe(true); // sanity: enemyId null fields are serialised …
    expect(a.includes('NaN')).toBe(false);
  });

  it('reset() drops all projectiles and restarts the ids', () => {
    const sim = mk(stage());
    const rng = new Rng(1);
    for (let k = 0; k < 5; k++) volley(sim, rng);
    sim.runFor(0.2);
    expect(sim.projectiles.length).toBeGreaterThan(0);
    sim.reset();
    expect(sim.projectiles.length).toBe(0);
    expect(sim.nextProjectileId).toBe(1);
    const p = spawnMachinegunBullet(sim, M, v3(0, 0, 100));
    expect(p.id).toBe(1);
    expect(p.spawnTime).toBe(0);
    sim.runFor(2);
    expect(sim.projectiles.length).toBe(0);
  });

  it('projectiles marked dead from outside are compacted away without events', () => {
    const sim = mk();
    const a = spawnMachinegunBullet(sim, v3(0, 50, 0), v3(0, 0, 100));
    const b = spawnMachinegunBullet(sim, v3(1, 50, 0), v3(0, 0, 100));
    const c = spawnMachinegunBullet(sim, v3(2, 50, 0), v3(0, 0, 100));
    b.alive = false;
    const events = runTicks(sim, 1);
    expect(sim.projectiles).toEqual([a, c]);
    expect(events.filter((s) => s.e.type.startsWith('projectile')).length).toBe(0);
  });
});
