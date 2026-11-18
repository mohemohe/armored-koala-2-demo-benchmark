/**
 * Player weapons: switching, exact fire intervals, ammo / EN accounting, refusals, shot records, free fire
 * and the EN priority order (docs/SPEC.md §3, §4.1, §4.2, §4.5, §6, §9, §10).
 *
 * Everything drives the real Sim through its inputs (sim.input, sim.applyLook, sim.tick / runFor / advance)
 * on isolated test stages; the weapons, the FCS, the projectiles and the collision code are the shipped
 * ones and nothing is mocked. Where a test needs a particular resource level it sets `player.en` /
 * `player.nextFireAt` before the tick — plain state, not a replacement of the code under test.
 * Measured numbers are printed with the prefix "[weapons]".
 */
import { describe, expect, it } from 'vitest';
import { RECENT_SHOTS_MAX, TICK, WEAPONS } from '../src/config';
import { clone, distance, length, normalize, sub, v3, type V3 } from '../src/core/vec';
import { computeFreeAim } from '../src/sim/fcs';
import { Sim } from '../src/sim/sim';
import type { EnemyDef, Loadout, ShotRecord, SimEvent, SolidDef, Weapon } from '../src/sim/types';
import {
  FIRE_REJECT_EVENT_INTERVAL,
  applyWeaponSwitch,
  beamEnReserve,
  processPlayerFire,
  weaponsNextEventTime,
} from '../src/sim/weapons';
import { makeTarget, makeTestStage } from '../src/stage/testStages';

// ───────────────────────────── helpers ─────────────────────────────

const MG = WEAPONS.machinegun;
const BEAM = WEAPONS.beam;
const MSL = WEAPONS.missile;

interface MkOpts {
  enemies?: EnemyDef[];
  solids?: SolidDef[];
  loadout?: Loadout;
}
/** Flat test floor, mech at the origin looking along −Z (yaw 0). */
function mk(o: MkOpts = {}): Sim {
  return new Sim(makeTestStage({ enemies: o.enemies, solids: o.solids }), { loadout: o.loadout });
}
/** Muzzle and camera of that mech (identical for every loadout; read from a real Sim). */
const BASE = (() => {
  const sim = mk();
  sim.tick();
  return { muzzle: clone(sim.player.muzzle), camera: clone(sim.camera.pos) };
})();
/** A point `d` metres straight ahead of the muzzle (−Z), optionally `right` metres to the side. */
const ahead = (d: number, right = 0): V3 => v3(BASE.muzzle.x + right, BASE.muzzle.y, BASE.muzzle.z - d);
/** A point on the camera-centre ray, `depth` metres in front of the camera. */
const onCrosshair = (depth: number): V3 => v3(BASE.camera.x, BASE.camera.y, BASE.camera.z - depth);

const maxAbsDiff = (a: V3, b: V3): number => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.z - b.z));

type Ev<T extends SimEvent['type']> = Extract<SimEvent, { type: T }>;
interface Stamped {
  time: number;
  e: SimEvent;
}
function ofType<T extends SimEvent['type']>(evs: Stamped[], type: T): Array<{ time: number; e: Ev<T> }> {
  return evs.filter((s): s is { time: number; e: Ev<T> } => s.e.type === type);
}
/** Runs `n` whole ticks, collecting the events of each tick. */
function runTicks(sim: Sim, n: number, into: Stamped[] = [], each?: () => void): Stamped[] {
  for (let i = 0; i < n && sim.status === 'playing'; i++) {
    sim.tick();
    for (const e of sim.drainEvents()) into.push({ time: sim.time, e });
    if (each) each();
  }
  return into;
}
const ticksOf = (seconds: number): number => Math.round(seconds / TICK);
const select = (sim: Sim, w: Weapon): void => {
  sim.input.weaponSelect = w;
};
const times = (shots: ShotRecord[]): number[] => shots.map((s) => s.firedAt);

/** Everything a refused shot must leave alone. */
function resources(sim: Sim): unknown {
  const p = sim.player;
  return {
    en: p.en,
    ammo: { ...p.ammo },
    nextFireAt: { ...p.nextFireAt },
    lastEnSpentAt: p.lastEnSpentAt,
    shots: sim.shots.length,
    nextShotId: sim.nextShotId,
    projectiles: sim.projectiles.length,
  };
}

// ───────────────────────────── weapon table ─────────────────────────────

describe('weapon parameters (SPEC §4.1) come from the one config table', () => {
  it('damage / interval / ammo / EN cost / speed / life / lock requirement', () => {
    expect([MG.damage, MG.interval, MG.ammo, MG.enCost, MG.speed, MG.gravity, MG.lifeSeconds, MG.requiresLock]).toEqual([
      12, 0.1, 300, 0, 100, 18, 2, false,
    ]);
    expect([BEAM.damage, BEAM.interval, BEAM.enCost, BEAM.range, BEAM.requiresLock]).toEqual([40, 0.25, 8, 120, false]);
    expect([MSL.damage, MSL.interval, MSL.ammo, MSL.enCost, MSL.speed, MSL.turnRateDeg, MSL.lifeSeconds, MSL.requiresLock]).toEqual([
      180, 1.0, 12, 0, 45, 120, 4, true,
    ]);
    const sim = mk();
    expect(sim.player.weapon).toBe('machinegun');
    expect(sim.player.ammo).toEqual({ machinegun: 300, missile: 12 });
    expect(sim.player.nextFireAt).toEqual({ machinegun: 0, beam: 0, missile: 0 });
  });
});

// ───────────────────────────── switching ─────────────────────────────

describe('weapon switching', () => {
  it('1 / 2 / 3 select the weapon as an edge; nothing else changes; re-selecting is a no-op', () => {
    const sim = mk({ enemies: [makeTarget('T', ahead(50))] });
    sim.runFor(0.4); // lock half acquired
    const lockBefore = { ...sim.lock };
    const evs: Stamped[] = [];
    for (const w of ['beam', 'missile', 'machinegun', 'missile'] as Weapon[]) {
      const before = resources(sim);
      select(sim, w);
      runTicks(sim, 1, evs);
      expect(sim.player.weapon).toBe(w);
      expect(sim.input.weaponSelect).toBeNull();
      expect(resources(sim)).toEqual(before); // no ammo, EN or timer was touched; switching is free
    }
    expect(ofType(evs, 'weapon-switched').map((s) => s.e.weapon)).toEqual(['beam', 'missile', 'machinegun', 'missile']);
    expect(sim.lock.targetId).toBe(lockBefore.targetId);
    expect(sim.lock.progress).toBeCloseTo(lockBefore.progress + (4 * TICK) / sim.stats.lockSeconds, 9);

    const again: Stamped[] = [];
    select(sim, 'missile'); // already selected
    runTicks(sim, 1, again);
    expect(ofType(again, 'weapon-switched').length).toBe(0);
    expect(sim.player.weapon).toBe('missile');

    // direct call: consumes the edge even when nothing changes; garbage is ignored
    sim.input.weaponSelect = 'railgun' as unknown as Weapon;
    applyWeaponSwitch(sim);
    expect(sim.input.weaponSelect).toBeNull();
    expect(sim.player.weapon).toBe('missile');
  });
});

// ───────────────────────────── intervals ─────────────────────────────

describe('fire intervals are exact and belong to each weapon', () => {
  it('machine gun: a held trigger fires every 0.10 s exactly (10 shots in the first second)', () => {
    const sim = mk();
    sim.input.fire = true;
    sim.runFor(1.0);
    const t = times(sim.shots);
    expect(t.length).toBe(10);
    expect(t[0]).toBeCloseTo(TICK, 12); // first sub-step after the press
    t.forEach((x, k) => expect(x - t[0]).toBeCloseTo(k * 0.1, 12));
    expect(sim.player.ammo.machinegun).toBe(290);
    expect(sim.player.nextFireAt.machinegun).toBeCloseTo(t[9] + 0.1, 12);
    expect(sim.shots.every((s) => s.weapon === 'machinegun' && s.solutionStatus === 'inactive')).toBe(true);
  });

  it('machine gun: shot times that do not fall on the 1/120 s grid are still exact (sub-step cut at the shot)', () => {
    const sim = mk();
    sim.player.nextFireAt.machinegun = 0.0457; // 5.48 ticks
    sim.input.fire = true;
    const seen: Array<{ time: number; age: number; err: number }> = [];
    runTicks(sim, 120, [], () => {
      // right after the tick that contained a shot: the new bullet has flown only for the rest of the tick
      const rec = sim.shots[sim.shots.length - 1];
      if (!rec || seen.some((s) => s.time === rec.firedAt)) return;
      const b = sim.projectiles[sim.projectiles.length - 1];
      const age = sim.time - rec.firedAt;
      const v0 = rec.initialVelocity as V3;
      const want = v3(rec.muzzle.x + v0.x * age, rec.muzzle.y + v0.y * age - 9 * age * age, rec.muzzle.z + v0.z * age);
      seen.push({ time: rec.firedAt, age, err: distance(b.pos, want) });
    });
    const t = times(sim.shots);
    expect(t.length).toBe(10);
    expect(t[0]).toBe(0.0457);
    t.forEach((x, k) => expect(x).toBeCloseTo(0.0457 + k * 0.1, 12));
    for (let k = 1; k < t.length; k++) expect(t[k] - t[k - 1]).toBeCloseTo(0.1, 12);
    expect(seen.length).toBe(10);
    for (const s of seen) {
      expect(s.age).toBeGreaterThan(0);
      expect(s.age).toBeLessThan(TICK); // spawned inside the tick, at the exact time
      expect(s.err).toBeLessThan(1e-9); // advanced by the remaining part of the tick only, not a whole frame
    }
  });

  it('beam: every 0.25 s exactly; missile: every 1.00 s exactly, starting when the lock completes', () => {
    const beam = mk();
    select(beam, 'beam');
    beam.input.fire = true;
    beam.runFor(2.0);
    const tb = times(beam.shots);
    expect(tb.length).toBe(8);
    tb.forEach((x, k) => expect(x - tb[0]).toBeCloseTo(k * 0.25, 12));
    expect(tb[0]).toBeCloseTo(TICK, 12);
    expect(beam.player.en).toBe(120 - 8 * 8);

    const msl = mk({ enemies: [makeTarget('T', ahead(50))] });
    select(msl, 'missile');
    msl.input.fire = true;
    msl.runFor(5.0);
    const tm = times(msl.shots);
    expect(tm.length).toBe(5);
    // the instant the lock is complete: the target is in the circle from t = 0, so lockSeconds after the start
    expect(tm[0]).toBeCloseTo(msl.stats.lockSeconds, 12);
    tm.forEach((x, k) => expect(x - tm[0]).toBeCloseTo(k * 1.0, 12));
    expect(msl.player.ammo.missile).toBe(12 - 5);
    expect(msl.shots.every((s) => s.weapon === 'missile' && s.solutionStatus === 'solved' && s.targetId === 'T')).toBe(true);
  });

  it('the shot schedule does not depend on the frame rate (30 / 60 / 120 fps give identical records)', () => {
    const run = (fps: number): ShotRecord[] => {
      const sim = mk({ enemies: [makeTarget('T', ahead(70, -6), v3(4, 0, 0))] });
      sim.input.fire = true; // free fire first, FCS fire once the lock is complete
      for (let f = 0; f < fps * 2; f++) sim.advance(1 / fps);
      return JSON.parse(JSON.stringify(sim.shots)) as ShotRecord[];
    };
    const a = run(30);
    const b = run(60);
    const c = run(120);
    const n = Math.min(a.length, b.length, c.length);
    expect(n).toBeGreaterThanOrEqual(19);
    // compare by id (each list holds the newest ≤ 32 shots)
    const byId = (l: ShotRecord[]): Map<number, ShotRecord> => new Map(l.map((s) => [s.id, s]));
    const [ma, mb, mc] = [byId(a), byId(b), byId(c)];
    let compared = 0;
    for (const [id, rec] of ma) {
      const rb = mb.get(id);
      const rc = mc.get(id);
      if (!rb || !rc) continue;
      expect(rb).toEqual(rec);
      expect(rc).toEqual(rec);
      compared++;
    }
    expect(compared).toBeGreaterThanOrEqual(19);
    expect(a.some((s) => s.solutionStatus === 'inactive')).toBe(true);
    expect(a.some((s) => s.solutionStatus === 'solved')).toBe(true);
  });

  it('each weapon keeps its own next-fire time across switches (no reset, no shortcut)', () => {
    const sim = mk();
    sim.input.fire = true;
    const evs: Stamped[] = [];
    runTicks(sim, 3, evs); // MG at tick 1
    expect(sim.shots.length).toBe(1);
    select(sim, 'beam');
    runTicks(sim, 1, evs); // beam at tick 4 (its own timer was free)
    expect(sim.shots.length).toBe(2);
    const afterBeam = { ...sim.player.nextFireAt };
    expect(afterBeam.machinegun).toBeCloseTo(TICK + 0.1, 12);
    expect(afterBeam.beam).toBeCloseTo(4 * TICK + 0.25, 12);
    expect(afterBeam.missile).toBe(0);

    select(sim, 'machinegun'); // back while the MG is still inside its 0.10 s
    runTicks(sim, 8, evs); // ticks 5..12
    expect(sim.shots.length).toBe(2); // the switch did not make it ready earlier
    expect(sim.player.nextFireAt).toEqual(afterBeam); // and did not touch any timer
    runTicks(sim, 1, evs); // tick 13 = TICK + 0.10 s
    expect(sim.shots.length).toBe(3);

    select(sim, 'beam'); // back to the beam before its 0.25 s are over
    runTicks(sim, 20, evs); // ticks 14..33
    expect(sim.shots.length).toBe(3);
    runTicks(sim, 1, evs); // tick 34 = 4 ticks + 0.25 s
    expect(sim.shots.length).toBe(4);

    expect(sim.shots.map((s) => s.weapon)).toEqual(['machinegun', 'beam', 'machinegun', 'beam']);
    const t = times(sim.shots);
    expect(t[0]).toBeCloseTo(TICK, 12);
    expect(t[1]).toBeCloseTo(4 * TICK, 12);
    expect(t[2]).toBeCloseTo(TICK + 0.1, 12);
    expect(t[3]).toBeCloseTo(4 * TICK + 0.25, 12);
    expect(sim.player.ammo.machinegun).toBe(298);
    expect(sim.player.en).toBe(120 - 16);
  });

  it('missile interval survives switching away and back', () => {
    const sim = mk({ enemies: [makeTarget('T', ahead(50))] });
    select(sim, 'missile');
    sim.input.fire = true;
    sim.runFor(1.0);
    expect(sim.shots.length).toBe(1);
    const t0 = sim.shots[0].firedAt;
    select(sim, 'machinegun');
    sim.runFor(0.3); // fires bullets meanwhile
    const mgShots = sim.shots.length - 1;
    expect(mgShots).toBeGreaterThanOrEqual(3);
    select(sim, 'missile');
    sim.runFor(0.4); // t ≈ t0 + 0.9: still inside the missile's 1.00 s
    expect(sim.shots.filter((s) => s.weapon === 'missile').length).toBe(1);
    expect(sim.player.nextFireAt.missile).toBeCloseTo(t0 + 1.0, 12);
    sim.runFor(0.2);
    const missiles = sim.shots.filter((s) => s.weapon === 'missile');
    expect(missiles.length).toBe(2);
    expect(missiles[1].firedAt).toBeCloseTo(t0 + 1.0, 12);
    expect(sim.player.ammo.missile).toBe(10);
  });

  it('weaponsNextEventTime: the next due shot while the trigger is held, strictly in the future', () => {
    const sim = mk();
    expect(weaponsNextEventTime(sim)).toBe(Infinity); // trigger up, nothing being acquired
    sim.input.fire = true;
    expect(weaponsNextEventTime(sim)).toBe(Infinity); // due now: handled at the end of the current sub-step
    sim.tick();
    expect(weaponsNextEventTime(sim)).toBe(sim.player.nextFireAt.machinegun);
    expect(weaponsNextEventTime(sim)).toBeGreaterThan(sim.time);
    sim.input.weaponSelect = 'beam'; // pending switch: the beam's time counts
    expect(weaponsNextEventTime(sim)).toBe(Infinity);
    sim.input.weaponSelect = null;
    sim.input.fire = false;
    expect(weaponsNextEventTime(sim)).toBe(Infinity);
  });
});

// ───────────────────────────── ammo ─────────────────────────────

describe('ammo accounting', () => {
  it('machine gun: exactly 300 rounds for the whole sortie, then refused; switching restores nothing', () => {
    const sim = mk();
    sim.input.fire = true;
    const evs: Stamped[] = [];
    let shotEvents = 0;
    for (let s = 0; s < 31; s++) {
      const chunk = runTicks(sim, 120);
      shotEvents += ofType(chunk, 'player-shot').length;
      for (const c of chunk) if (c.e.type === 'fire-rejected') evs.push(c);
    }
    expect(shotEvents).toBe(300);
    expect(sim.nextShotId).toBe(301);
    expect(sim.player.ammo.machinegun).toBe(0);
    expect(sim.shots[sim.shots.length - 1].id).toBe(300);
    const last = sim.shots[sim.shots.length - 1].firedAt;
    expect(last).toBeCloseTo(TICK + 299 * 0.1, 9);
    expect(sim.player.nextFireAt.machinegun).toBeCloseTo(last + 0.1, 12); // not pushed back by refusals

    // refusals: first when the 301st shot would have been due, then throttled to one per 0.5 s
    const rejects = ofType(evs, 'fire-rejected');
    expect(rejects.every((r) => r.e.weapon === 'machinegun' && r.e.reason === 'no-ammo')).toBe(true);
    expect(rejects[0].time).toBeCloseTo(last + 0.1, 9);
    expect(rejects.length).toBe(Math.floor((31 - (last + 0.1)) / FIRE_REJECT_EVENT_INTERVAL + 1e-9) + 1);
    for (let i = 1; i < rejects.length; i++) expect(rejects[i].time - rejects[i - 1].time).toBeCloseTo(0.5, 9);

    const before = resources(sim);
    sim.runFor(2);
    expect(resources(sim)).toEqual({ ...(before as object), projectiles: 0 });
    expect(sim.projectiles.length).toBe(0); // nothing accumulates

    // switching away and back, or a long wait, restores nothing
    select(sim, 'missile');
    sim.runFor(0.5);
    select(sim, 'beam');
    sim.runFor(0.1);
    select(sim, 'machinegun');
    sim.runFor(3);
    expect(sim.player.ammo).toEqual({ machinegun: 0, missile: 12 });
    expect(sim.nextShotId).toBeGreaterThan(301); // the beam did fire in between
    expect(sim.shots.filter((s) => s.weapon === 'machinegun' && s.id > 300).length).toBe(0);
  });

  it('missile: 12 launches, the 13th is refused with no-ammo; ammo is never restored', () => {
    const sim = mk({ enemies: [makeTarget('T', ahead(50))] });
    const target = sim.enemies[0];
    select(sim, 'missile');
    sim.input.fire = true;
    const evs = runTicks(sim, ticksOf(14));
    expect(sim.player.ammo.missile).toBe(0);
    expect(sim.shots.length).toBe(12);
    expect(sim.shots.map((s) => s.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const t = times(sim.shots);
    t.forEach((x, k) => expect(x - t[0]).toBeCloseTo(k, 9));
    expect(1e9 - target.hp).toBe(12 * MSL.damage); // every one of them reached the static target
    const rejects = ofType(evs, 'fire-rejected').filter((r) => r.time > t[11]);
    expect(rejects.length).toBeGreaterThanOrEqual(2);
    expect(rejects.every((r) => r.e.weapon === 'missile' && r.e.reason === 'no-ammo')).toBe(true);
    expect(rejects[0].time).toBeCloseTo(t[11] + 1.0, 9);
    expect(sim.player.nextFireAt.missile).toBeCloseTo(t[11] + 1.0, 12);
    select(sim, 'machinegun');
    sim.runFor(0.3);
    select(sim, 'missile');
    sim.runFor(1.5);
    expect(sim.player.ammo.missile).toBe(0);
    expect(sim.shots.filter((s) => s.weapon === 'missile').length).toBeLessThanOrEqual(12);
    expect(sim.projectiles.filter((p) => p.kind === 'missile').length).toBe(0);
  });

  it('with EN at 0 the machine gun and a locked missile still fire, and neither touches EN or its regen timer', () => {
    const sim = mk({ enemies: [makeTarget('T', ahead(50))] });
    sim.player.en = 0;
    sim.input.fire = true;
    sim.runFor(1.0);
    expect(sim.shots.length).toBe(10);
    expect(sim.player.lastEnSpentAt).toBeNull(); // firing bullets is not an EN expenditure
    expect(sim.player.en).toBeCloseTo(sim.stats.regenPerSecond * 1.0, 9); // regenerating all the while
    select(sim, 'missile');
    sim.player.en = 0;
    sim.runFor(0.2);
    expect(sim.shots[sim.shots.length - 1].weapon).toBe('missile');
    expect(sim.player.lastEnSpentAt).toBeNull();
    expect(sim.player.en).toBeCloseTo(sim.stats.regenPerSecond * 0.2, 9);
  });
});

// ───────────────────────────── beam EN ─────────────────────────────

describe('beam EN accounting', () => {
  it('8 EN per shot at the instant of the shot; below 8 EN it is refused and no timer moves', () => {
    const loadout: Loadout = { fcs: 'medium', generator: 'recovery', legs: 'biped' }; // 90 EN, 20 EN/s
    const sim = mk({ loadout });
    select(sim, 'beam');
    sim.input.fire = true;
    const evs: Stamped[] = [];
    let seen = 0;
    runTicks(sim, ticksOf(2.7), evs, () => {
      if (sim.shots.length !== seen) {
        seen = sim.shots.length;
        expect(sim.player.en).toBe(90 - 8 * seen); // paid exactly once, in the firing sub-step
        expect(sim.player.lastEnSpentAt).toBe(sim.shots[seen - 1].firedAt);
      }
    });
    expect(sim.shots.length).toBe(11); // 11 × 8 = 88
    expect(sim.player.en).toBe(2);
    const lastShot = sim.shots[10].firedAt;
    expect(lastShot).toBeCloseTo(TICK + 2.5, 12);
    expect(ofType(evs, 'fire-rejected').length).toBe(0);

    // the 12th would be due at lastShot + 0.25 with 2 EN left
    const before = resources(sim);
    runTicks(sim, ticksOf(0.4), evs);
    const rejects = ofType(evs, 'fire-rejected');
    expect(rejects.length).toBe(1);
    expect(rejects[0].e).toEqual({ type: 'fire-rejected', weapon: 'beam', reason: 'no-en' });
    expect(rejects[0].time).toBeCloseTo(lastShot + 0.25, 9);
    expect(resources(sim)).toEqual(before); // EN, ammo, nextFireAt, lastEnSpentAt, records: all unchanged
    expect(sim.player.lastEnSpentAt).toBe(lastShot);
    expect(sim.player.nextFireAt.beam).toBeCloseTo(lastShot + 0.25, 12);

    // regeneration starts 0.75 s after the last REAL expenditure (the refusals did not postpone it) and the
    // held trigger fires again as soon as 8 EN are there: 2 + 20·Δt = 8 → Δt = 0.30 s
    let en = sim.player.en;
    let regenStart: number | null = null;
    let next: number | null = null;
    runTicks(sim, ticksOf(1.0), evs, () => {
      if (regenStart == null && sim.player.en > en) regenStart = sim.time;
      en = sim.player.en;
      if (next == null && sim.shots.length === 12) next = sim.shots[11].firedAt;
    });
    expect(regenStart).not.toBeNull();
    expect(regenStart as unknown as number).toBeCloseTo(lastShot + 0.75 + TICK, 9);
    expect(next).not.toBeNull();
    const nextShot = next as unknown as number;
    expect(nextShot).toBeGreaterThanOrEqual(lastShot + 0.75 + 0.3 - 1e-9);
    expect(nextShot).toBeLessThanOrEqual(lastShot + 0.75 + 0.3 + TICK + 1e-9);
    console.log(
      `[weapons] beam: 11 shots from 90 EN, refusal at +0.25 s, regen from +0.75 s, next shot at +${(nextShot - lastShot).toFixed(4)} s (expected 1.05 … 1.0583)`,
    );
  });

  it('boundary: 7.999 EN refuses, exactly 8 EN fires and leaves 0', () => {
    const sim = mk();
    select(sim, 'beam');
    sim.tick();
    sim.player.en = 7.999;
    sim.player.lastEnSpentAt = sim.time; // keep regeneration out of the picture
    sim.input.fire = true;
    const before = resources(sim);
    const evs = runTicks(sim, 30);
    expect(sim.shots.length).toBe(0);
    expect(resources(sim)).toEqual(before);
    expect(ofType(evs, 'fire-rejected').length).toBe(1); // throttled: one event in 0.25 s
    expect(ofType(evs, 'beam').length).toBe(0);

    sim.player.en = 8;
    const more = runTicks(sim, 1);
    expect(sim.shots.length).toBe(1);
    expect(sim.player.en).toBe(0);
    expect(sim.player.lastEnSpentAt).toBe(sim.shots[0].firedAt);
    expect(ofType(more, 'beam').length).toBe(1);
  });

  it('beamEnReserve: 8 only when trigger held ∧ beam selected ∧ due by t1 ∧ EN ≥ 8', () => {
    const sim = mk();
    const t1 = sim.time + TICK;
    expect(beamEnReserve(sim, t1)).toBe(0); // trigger up, MG selected
    sim.input.fire = true;
    expect(beamEnReserve(sim, t1)).toBe(0); // MG selected
    sim.player.weapon = 'beam';
    expect(beamEnReserve(sim, t1)).toBe(8);
    sim.player.nextFireAt.beam = t1;
    expect(beamEnReserve(sim, t1)).toBe(8); // due exactly at the end of the sub-step
    sim.player.nextFireAt.beam = t1 + 0.001;
    expect(beamEnReserve(sim, t1)).toBe(0); // not due yet
    sim.player.nextFireAt.beam = 0;
    sim.player.en = 7.99;
    expect(beamEnReserve(sim, t1)).toBe(0); // cannot be afforded: nothing is held back from the flight
    sim.player.en = 8;
    expect(beamEnReserve(sim, t1)).toBe(8);
    sim.input.fire = false;
    expect(beamEnReserve(sim, t1)).toBe(0);
  });
});

// ───────────────────────────── EN order ─────────────────────────────

describe('EN order inside one update: QB start → beam shot → flight thrust (SPEC §6)', () => {
  /** Airborne and thrusting, beam selected, at t = 0.5 s; then EN is set and Q + trigger are pressed for one tick. */
  function scenario(en: number, pressQb: boolean): { sim: Sim; evs: Stamped[]; t0: number } {
    const sim = mk();
    select(sim, 'beam');
    sim.input.jumpPressed = true;
    sim.input.jump = true; // held: thrusters from 0.20 s on
    sim.runFor(0.5);
    expect(sim.player.verticalMode).toBe('flying');
    expect(sim.player.vel.y).toBeCloseTo(8, 9);
    expect(sim.player.en).toBeCloseTo(120 - 20 * 0.3, 9);
    sim.drainEvents();
    sim.player.en = en;
    if (pressQb) sim.input.qbPressed = true;
    sim.input.fire = true;
    const t0 = sim.time;
    const evs = runTicks(sim, 1);
    return { sim, evs, t0 };
  }
  const FLIGHT_TICK = 20 * TICK; // EN a whole tick of thrust costs

  it('scarce EN (44.1): QB takes 36, the beam its 8, the flight only the remaining 0.1 → thrust for 0.005 s', () => {
    const { sim, evs, t0 } = scenario(44.1, true);
    const p = sim.player;
    expect(p.qbSuccessfulCount).toBe(1);
    expect(ofType(evs, 'qb').length).toBe(1);
    expect(sim.shots.length).toBe(1);
    expect(sim.shots[0].weapon).toBe('beam');
    expect(sim.shots[0].firedAt).toBeCloseTo(t0 + TICK, 12);
    expect(ofType(evs, 'fire-rejected').length).toBe(0);
    expect(p.en).toBeGreaterThanOrEqual(0);
    expect(p.en).toBeLessThan(1e-9); // 44.1 − 36 − 0.1 − 8 = 0: nothing was spent twice
    // the thrusters only fired for the 0.1 EN left after QB and beam: 0.005 s, then gravity
    const thrust = 0.1 / 20;
    expect(p.vel.y).toBeCloseTo(8 - 18 * (TICK - thrust), 9);
    expect(p.vel.y).toBeLessThan(8 - 0.05);
    expect(p.lastEnSpentAt).toBe(sim.shots[0].firedAt);
    console.log(`[weapons] EN order 44.1: QB ok, beam ok, EN left ${p.en.toExponential(2)}, vy ${p.vel.y.toFixed(6)} (full thrust would be 8)`);
  });

  it('43.9 EN: QB succeeds, the beam cannot be paid (7.9 < 8) and is refused, the flight uses what is left', () => {
    const { sim, evs } = scenario(43.9, true);
    const p = sim.player;
    expect(p.qbSuccessfulCount).toBe(1);
    expect(sim.shots.length).toBe(0);
    expect(ofType(evs, 'fire-rejected').map((r) => r.e.reason)).toEqual(['no-en']);
    expect(p.en).toBeCloseTo(43.9 - 36 - FLIGHT_TICK, 9);
    expect(p.vel.y).toBeCloseTo(8, 9); // full tick of thrust
  });

  it('35.5 EN: the QB is refused and costs nothing; beam (8) and a full tick of flight are paid', () => {
    const { sim, evs } = scenario(35.5, true);
    const p = sim.player;
    expect(p.qbSuccessfulCount).toBe(0);
    expect(ofType(evs, 'qb-rejected').map((r) => r.e.reason)).toEqual(['no-en']);
    expect(sim.shots.length).toBe(1);
    expect(p.en).toBeCloseTo(35.5 - 8 - FLIGHT_TICK, 9);
    expect(p.vel.y).toBeCloseTo(8, 9);
  });

  it('8.05 EN without QB: the beam is served before the flight (thrust for 0.0025 s only), EN ends at 0', () => {
    const { sim } = scenario(8.05, false);
    const p = sim.player;
    expect(sim.shots.length).toBe(1);
    expect(p.en).toBeGreaterThanOrEqual(0);
    expect(p.en).toBeLessThan(1e-9);
    expect(p.vel.y).toBeCloseTo(8 - 18 * (TICK - 0.05 / 20), 9);
  });

  it('plenty of EN (100): all three are paid from the same pool: 36 + 8 + 20·(1/120)', () => {
    const { sim } = scenario(100, true);
    const p = sim.player;
    expect(p.qbSuccessfulCount).toBe(1);
    expect(sim.shots.length).toBe(1);
    expect(p.en).toBeCloseTo(100 - 36 - 8 - FLIGHT_TICK, 9);
    expect(p.vel.y).toBeCloseTo(8, 9);
  });

  it('gliding costs nothing: only the beam is paid while gliding on the ground', () => {
    const sim = mk();
    select(sim, 'beam');
    sim.input.glideTogglePressed = true;
    sim.input.fire = true;
    sim.runFor(1.0);
    expect(sim.player.horizontalMode).toBe('glide');
    expect(sim.shots.length).toBe(4); // TICK, +0.25, +0.5, +0.75
    expect(sim.player.en).toBe(120 - 4 * 8);
  });
});

// ───────────────────────────── missile refusals ─────────────────────────────

describe('missile needs a complete, currently valid lock', () => {
  it('no target: refused (no-lock), nothing spawned, nothing consumed, events throttled to one per 0.5 s', () => {
    const sim = mk();
    select(sim, 'missile');
    sim.input.fire = true;
    sim.tick();
    const before = resources(sim);
    sim.drainEvents();
    const evs = runTicks(sim, ticksOf(2.0) - 1);
    expect(resources(sim)).toEqual(before);
    expect(sim.shots).toEqual([]);
    expect(sim.player.ammo.missile).toBe(12);
    expect(sim.player.nextFireAt.missile).toBe(0);
    expect(sim.projectiles.length).toBe(0);
    const rejects = ofType(evs, 'fire-rejected');
    expect(rejects.every((r) => r.e.weapon === 'missile' && r.e.reason === 'no-lock')).toBe(true);
    // first event at tick 1 (drained above), then at +0.5, +1.0, +1.5 s
    expect(rejects.map((r) => r.time - TICK)).toEqual([0.5, 1.0, 1.5].map((x) => expect.closeTo(x, 9)));

    // releasing and pressing again reports at once
    sim.input.fire = false;
    sim.tick();
    sim.input.fire = true;
    const again = runTicks(sim, 1);
    expect(ofType(again, 'fire-rejected').length).toBe(1);
  });

  it('lock still acquiring: refused; it launches at the very instant the lock completes', () => {
    const sim = mk({ enemies: [makeTarget('T', ahead(50))] });
    select(sim, 'missile');
    sim.input.fire = true;
    const n = ticksOf(sim.stats.lockSeconds);
    expect(sim.lock.state).toBe('acquiring'); // in the circle from t = 0: the acquisition starts there
    expect(sim.lock.progress).toBe(0);
    const evs = runTicks(sim, n - 1); // one tick short of complete
    expect(sim.lock.state).toBe('acquiring');
    expect(sim.lock.progress).toBeGreaterThan(0.98);
    expect(sim.shots.length).toBe(0);
    expect(sim.player.ammo.missile).toBe(12);
    expect(sim.projectiles.length).toBe(0);
    expect(ofType(evs, 'fire-rejected').length).toBe(2); // t = TICK and TICK + 0.5
    expect(ofType(evs, 'fire-rejected').every((r) => r.e.reason === 'no-lock')).toBe(true);
    sim.tick();
    expect(sim.lock.state).toBe('locked');
    expect(sim.shots.length).toBe(1);
    expect(sim.shots[0].firedAt).toBeCloseTo(sim.stats.lockSeconds, 12); // exactly lockSeconds after the sortie began
    expect(sim.player.ammo.missile).toBe(11);
    expect(sim.projectiles.length).toBe(1);
    expect(sim.projectiles[0].targetId).toBe('T');
  });

  it('target invalid at the firing instant: the lock is re-validated — missile refused, MG / beam fall back to free fire', () => {
    for (const weapon of ['missile', 'machinegun', 'beam'] as Weapon[]) {
      const sim = mk({ enemies: [makeTarget('T', ahead(50))] });
      const target = sim.enemies[0];
      select(sim, weapon);
      sim.runFor(1.0);
      expect(sim.lock.state).toBe('locked');
      expect(sim.fireControl.status).toBe('solved');
      const stale = sim.fireControl;
      sim.drainEvents();

      // The target is gone from the FCS area at the instant of the shot (the lock state itself has not
      // been updated yet — exactly what processPlayerFire has to check for itself).
      target.pos.x += 400;
      sim.input.fire = true;
      const before = resources(sim);
      processPlayerFire(sim);
      const evs = sim.drainEvents();

      expect(sim.lock.state).toBe('none');
      expect(sim.lock.targetId).toBeNull();
      expect(sim.lock.progress).toBe(0);
      if (weapon === 'missile') {
        expect(resources(sim)).toEqual(before);
        expect(evs).toEqual([{ type: 'fire-rejected', weapon: 'missile', reason: 'no-lock' }]);
      } else {
        expect(sim.shots.length).toBe(1);
        const rec = sim.shots[0];
        expect(rec.solutionStatus).toBe('inactive'); // none of the old target's numbers were used
        expect(rec.targetId).toBeNull();
        expect(rec.targetPosAtFire).toBeNull();
        expect(rec.targetVelAtFire).toBeNull();
        expect(rec.flightSeconds).toBeNull();
        expect(rec.intercept).toBeNull();
        const point = v3();
        const dir = v3();
        computeFreeAim(sim, point, dir);
        expect(rec.launchDir).toEqual(dir);
        expect(maxAbsDiff(rec.launchDir, stale.launchDir as V3)).toBeGreaterThan(1e-3);
        expect(sim.fireControl.status).toBe('inactive');
      }
    }
  });

  it('nothing fires and nothing switches once the sortie is over', () => {
    const sim = mk({ enemies: [makeTarget('T', ahead(50))] });
    sim.runFor(1.0);
    sim.status = 'failed';
    sim.input.fire = true;
    sim.input.weaponSelect = 'beam';
    const before = resources(sim);
    processPlayerFire(sim);
    applyWeaponSwitch(sim);
    expect(resources(sim)).toEqual(before);
    expect(sim.player.weapon).toBe('machinegun');
    expect(sim.input.weaponSelect).toBeNull(); // the edge is dropped, not kept for later
    expect(sim.drainEvents().filter((e) => e.type === 'player-shot' || e.type === 'weapon-switched')).toEqual([]);
    expect(sim.advance(1)).toBe(0);
    expect(sim.shots.length).toBe(0);
  });

  it('a lock that is complete and valid needs no further waiting after other weapons were used', () => {
    const sim = mk({ enemies: [makeTarget('T', ahead(50))] });
    sim.input.fire = true; // machine gun all along
    sim.runFor(1.5);
    expect(sim.lock.state).toBe('locked');
    select(sim, 'missile');
    sim.tick();
    expect(sim.shots[sim.shots.length - 1].weapon).toBe('missile'); // launched in the very next sub-step
    expect(sim.shots[sim.shots.length - 1].solutionStatus).toBe('solved');
  });
});

// ───────────────────────────── shot records ─────────────────────────────

describe('recentPlayerShots (sim.shots)', () => {
  it('keeps the newest 32, oldest first, ids increasing by 1; records are frozen copies; reset clears them', () => {
    const sim = mk({ enemies: [makeTarget('T', ahead(60, -3), v3(2, 0, 0))] });
    sim.input.fire = true;
    sim.runFor(4.5);
    expect(sim.nextShotId).toBe(46);
    expect(sim.shots.length).toBe(RECENT_SHOTS_MAX);
    expect(RECENT_SHOTS_MAX).toBe(32);
    expect(sim.shots.map((s) => s.id)).toEqual(Array.from({ length: 32 }, (_, i) => 14 + i));
    for (let i = 1; i < sim.shots.length; i++) expect(sim.shots[i].firedAt).toBeGreaterThan(sim.shots[i - 1].firedAt);

    // copies: later movement of the mech / the target / a weapon switch does not edit a record
    const last = sim.shots[sim.shots.length - 1];
    expect(last.muzzle).not.toBe(sim.player.muzzle);
    expect(last.targetPosAtFire).not.toBe(sim.enemies[0].pos);
    expect(last.launchDir).not.toBe(sim.fireControl.launchDir);
    const frozen = JSON.stringify(sim.shots);
    sim.input.fire = false;
    sim.input.moveZ = 1;
    select(sim, 'beam');
    sim.runFor(0.5);
    expect(distance(sim.player.muzzle, last.muzzle)).toBeGreaterThan(1);
    expect(JSON.stringify(sim.shots)).toBe(frozen);

    sim.reset();
    expect(sim.shots).toEqual([]);
    expect(sim.nextShotId).toBe(1);
    expect(sim.player.ammo).toEqual({ machinegun: 300, missile: 12 });
    expect(sim.player.nextFireAt).toEqual({ machinegun: 0, beam: 0, missile: 0 });
    sim.input.fire = true;
    sim.tick();
    expect(sim.shots.map((s) => s.id)).toEqual([1]);
  });

  it('record fields per weapon (SPEC §10): free fire vs. locked fire, velocity really given, acceleration', () => {
    const sim = mk({ enemies: [makeTarget('T', ahead(60), v3(3, 0, 0))] });
    const evs: Stamped[] = [];
    sim.input.fire = true;
    runTicks(sim, 1, evs); // free-fire bullet (lock just acquired)
    sim.input.fire = false;
    runTicks(sim, ticksOf(1.0), evs);
    expect(sim.lock.state).toBe('locked');
    for (const w of ['machinegun', 'beam', 'missile'] as Weapon[]) {
      select(sim, w);
      sim.input.fire = true;
      runTicks(sim, 1, evs);
      sim.input.fire = false;
      runTicks(sim, 2, evs);
    }
    expect(sim.shots.map((s) => [s.id, s.weapon, s.solutionStatus])).toEqual([
      [1, 'machinegun', 'inactive'],
      [2, 'machinegun', 'solved'],
      [3, 'beam', 'solved'],
      [4, 'missile', 'solved'],
    ]);
    const [free, mg, beam, msl] = sim.shots;
    // free fire: no target, no prediction
    expect([free.targetId, free.targetPosAtFire, free.targetVelAtFire, free.flightSeconds, free.intercept]).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(Math.abs(length(free.initialVelocity as V3) - 100)).toBeLessThanOrEqual(1e-3);
    expect(free.accelerationAtFire).toEqual(v3(0, -18, 0));
    // locked machine gun
    expect(mg.targetId).toBe('T');
    expect(mg.targetVelAtFire).toEqual(v3(3, 0, 0));
    expect(Math.abs(length(mg.initialVelocity as V3) - 100)).toBeLessThanOrEqual(1e-3);
    expect(mg.accelerationAtFire).toEqual(v3(0, -18, 0));
    expect(mg.flightSeconds as number).toBeGreaterThan(0);
    expect((mg.launchDir.y * 100 * (mg.flightSeconds as number)) / (9 * (mg.flightSeconds as number) ** 2)).toBeCloseTo(1, 6); // elevation = drop
    // beam
    expect(beam.initialVelocity).toBeNull();
    expect(beam.accelerationAtFire).toEqual(v3(0, 0, 0));
    expect(beam.flightSeconds).toBe(0);
    expect(beam.intercept).toEqual(beam.targetPosAtFire);
    // missile
    expect(Math.abs(length(msl.initialVelocity as V3) - 45)).toBeLessThan(1e-9);
    expect(msl.accelerationAtFire).toEqual(v3(0, 0, 0));
    expect(msl.flightSeconds as number).toBeGreaterThan(0);
    for (const s of sim.shots) expect(length(s.launchDir)).toBeCloseTo(1, 12);

    // events: one player-shot per shot, consistent with the record and the projectile
    const shots = ofType(evs, 'player-shot');
    expect(shots.map((s) => [s.e.weapon, s.e.locked])).toEqual([
      ['machinegun', false],
      ['machinegun', true],
      ['beam', true],
      ['missile', true],
    ]);
    shots.forEach((s, i) => {
      expect(s.e.muzzle).toEqual(sim.shots[i].muzzle);
      expect(s.e.dir).toEqual(sim.shots[i].launchDir);
      expect(s.e.projectileId == null).toBe(s.e.weapon === 'beam');
    });
    const beamEv = ofType(evs, 'beam');
    expect(beamEv.length).toBe(1);
    expect(beamEv[0].e.from).toEqual(beam.muzzle);
    expect(beamEv[0].e.hit).toBe('enemy');
    expect(beamEv[0].e.enemyId).toBe('T');
  });
});

// ───────────────────────────── free fire ─────────────────────────────

describe('free fire (no complete lock): the camera-centre point is aimed at from the muzzle', () => {
  const farWall: SolidDef = { min: v3(-40, 0, -61), max: v3(40, 30, -60), material: 'wall' };
  const crossOnWall = v3(BASE.camera.x, BASE.camera.y, -60);

  it('beam: ends exactly where the crosshair meets the wall; record is inactive with null target fields', () => {
    const sim = mk({ solids: [farWall] });
    select(sim, 'beam');
    sim.tick();
    expect(sim.aim.mode).toBe('free');
    expect(maxAbsDiff(sim.aim.point, crossOnWall)).toBeLessThan(1e-9);
    sim.input.fire = true;
    const evs = runTicks(sim, 1);
    const beam = ofType(evs, 'beam')[0].e;
    expect(beam.hit).toBe('world');
    expect(beam.from).toEqual(sim.player.muzzle);
    expect(maxAbsDiff(beam.to, crossOnWall)).toBeLessThan(1e-6);
    const rec = sim.shots[0];
    expect(rec.solutionStatus).toBe('inactive');
    expect(rec.targetId).toBeNull();
    expect(maxAbsDiff(rec.launchDir, normalize(sub(crossOnWall, rec.muzzle)))).toBeLessThan(1e-9);
    expect(rec.muzzle).toEqual(sim.player.muzzle); // fired from the muzzle, not from the camera
    expect(distance(rec.muzzle, sim.camera.pos)).toBeGreaterThan(5);
    expect(sim.fireControl.status).toBe('inactive');
  });

  it('machine gun: 100 m/s towards that point with no drop compensation — it lands 9·t² below the crosshair', () => {
    const sim = mk({ solids: [farWall] });
    sim.input.fire = true;
    const evs = runTicks(sim, 1);
    sim.input.fire = false;
    const rec = sim.shots[0];
    expect(rec.solutionStatus).toBe('inactive');
    const dir = normalize(sub(crossOnWall, rec.muzzle));
    expect(maxAbsDiff(rec.launchDir, dir)).toBeLessThan(1e-9);
    const v0 = rec.initialVelocity as V3;
    expect(Math.abs(length(v0) - 100)).toBeLessThanOrEqual(1e-3);
    expect(maxAbsDiff(v0, v3(dir.x * 100, dir.y * 100, dir.z * 100))).toBeLessThan(1e-7);
    runTicks(sim, ticksOf(1.0), evs);
    const hit = ofType(evs, 'projectile-hit')[0].e;
    expect(hit.target).toBe('world');
    expect(hit.pos.z).toBeCloseTo(-60, 6);
    const t = (-60 - rec.muzzle.z) / v0.z;
    expect(hit.pos.y).toBeCloseTo(rec.muzzle.y + v0.y * t - 9 * t * t, 3); // plain parabola
    expect(crossOnWall.y - hit.pos.y).toBeCloseTo(9 * t * t, 3); // no automatic elevation
    expect(crossOnWall.y - hit.pos.y).toBeGreaterThan(3);
  });

  it('nothing under the crosshair: the far point of the camera-centre ray (shots run parallel to the view)', () => {
    const sim = mk();
    sim.applyLook(0.3, 0.4); // somewhere into the sky
    sim.tick();
    const point = v3();
    const dir = v3();
    computeFreeAim(sim, point, dir);
    const c = sim.camera;
    // the point lies on the camera-centre ray, hundreds of metres out
    const rel = sub(point, c.pos);
    const along = rel.x * c.forward.x + rel.y * c.forward.y + rel.z * c.forward.z;
    expect(along).toBeGreaterThan(250);
    expect(distance(point, v3(c.pos.x + c.forward.x * along, c.pos.y + c.forward.y * along, c.pos.z + c.forward.z * along))).toBeLessThan(1e-9);
    expect(maxAbsDiff(dir, normalize(sub(point, sim.player.muzzle)))).toBeLessThan(1e-12);
    sim.input.fire = true;
    sim.tick();
    expect(sim.shots[0].launchDir).toEqual(sim.aim.dir);
    expect(sim.aim.mode).toBe('free');
  });

  it('an unlocked enemy under the crosshair is simply what the crosshair hits — no lead, no correction', () => {
    // crossing at 30 m/s: an FCS shot would lead it; the free shot goes to where it is seen right now
    const sim = mk({ enemies: [makeTarget('E', onCrosshair(60), v3(30, 0, 0), 1.2, 1000)] });
    const e = sim.enemies[0];
    sim.input.fire = true;
    const evs = runTicks(sim, 1); // lock only just acquired
    sim.input.fire = false;
    expect(sim.lock.state).toBe('acquiring');
    const rec = sim.shots[0];
    expect(rec.solutionStatus).toBe('inactive');
    expect(rec.targetId).toBeNull();
    // aimed at the surface point of the sphere on the camera ray at the firing instant
    const point = v3();
    const dir = v3();
    computeFreeAim(sim, point, dir);
    expect(rec.launchDir).toEqual(dir);
    expect(distance(point, e.pos)).toBeCloseTo(1.2, 9);
    runTicks(sim, ticksOf(1.0), evs);
    expect(e.hp).toBe(1000); // the target moved on; the uncorrected bullet missed
    expect(ofType(evs, 'enemy-damaged').length).toBe(0);
  });

  it('a wall in front of the muzzle stops the shot even where the camera sees past it', () => {
    const low: SolidDef = { min: v3(-6, 0, -4.2), max: v3(6, 3.4, -4), material: 'wall' };
    for (const weapon of ['beam', 'machinegun'] as Weapon[]) {
      const sim = mk({ solids: [low, farWall], enemies: [makeTarget('E', onCrosshair(49.5), v3(), 1.2, 1000)] });
      const e = sim.enemies[0];
      select(sim, weapon);
      sim.runFor(1.5);
      // the camera sees the enemy over the wall, the muzzle does not → no lock, free fire
      expect(sim.world.segmentBlocked(sim.camera.pos, e.pos)).toBe(false);
      expect(sim.world.segmentBlocked(sim.player.muzzle, e.pos)).toBe(true);
      expect(sim.lock.state).toBe('none');
      // the crosshair is on the enemy
      expect(distance(sim.aim.point, e.pos)).toBeCloseTo(1.2, 9);
      const en0 = sim.player.en;
      sim.drainEvents();
      sim.input.fire = true;
      const evs = runTicks(sim, 1);
      sim.input.fire = false;
      const enAfterShot = sim.player.en;
      runTicks(sim, ticksOf(1.0), evs);
      expect(sim.shots.length).toBe(1);
      expect(sim.shots[0].solutionStatus).toBe('inactive');
      expect(sim.shots[0].muzzle).toEqual(sim.player.muzzle);
      expect(sim.shots[0].muzzle.z).toBeGreaterThan(-4); // the shot started on the near side of the wall
      expect(e.hp).toBe(1000);
      expect(ofType(evs, 'enemy-damaged').length).toBe(0);
      if (weapon === 'beam') {
        const beam = ofType(evs, 'beam')[0].e;
        expect(beam.hit).toBe('world');
        expect(beam.to.z).toBeCloseTo(-4, 9); // stopped by the near face of the low wall
        expect(beam.to.y).toBeLessThan(3.4);
        expect(enAfterShot).toBe(en0 - 8); // the shot happened and was paid for
      } else {
        const hit = ofType(evs, 'projectile-hit')[0].e;
        expect(hit.target).toBe('world');
        expect(hit.pos.z).toBeCloseTo(-4, 6);
        expect(enAfterShot).toBe(en0);
        expect(sim.player.ammo.machinegun).toBe(299);
      }
    }
  });
});

// ───────────────────────────── beam ray ─────────────────────────────

describe('beam: one damage application, first real hit within 120 m', () => {
  it('locked beam aimed at the far target is stopped by a nearer enemy on the ray: only that one loses 40 HP', () => {
    const sim = mk({ enemies: [makeTarget('NEAR', ahead(40), v3(), 0.5, 1000), makeTarget('FAR', ahead(80), v3(), 0.5, 1000)] });
    const [near, far] = sim.enemies;
    select(sim, 'beam');
    sim.runFor(1.0);
    expect(sim.lock.targetId).toBe('FAR'); // nearer to the screen centre
    expect(sim.lock.state).toBe('locked');
    sim.input.fire = true;
    const evs = runTicks(sim, 1);
    expect(sim.shots[0].targetId).toBe('FAR');
    expect(near.hp).toBe(960);
    expect(far.hp).toBe(1000);
    expect(ofType(evs, 'enemy-damaged').length).toBe(1);
    const beam = ofType(evs, 'beam')[0].e;
    expect(beam.enemyId).toBe('NEAR');
    expect(distance(beam.from, beam.to)).toBeCloseTo(39.5, 9);
  });

  it('an enemy beyond 120 m is out of reach: the ray ends after exactly 120 m and nothing is damaged', () => {
    const sim = mk({ enemies: [makeTarget('E', onCrosshair(135), v3(), 0.5, 1000)] });
    const e = sim.enemies[0];
    select(sim, 'beam');
    sim.runFor(1.0);
    expect(distance(sim.player.muzzle, e.pos)).toBeGreaterThan(120.5);
    expect(sim.lock.state).toBe('none'); // out of FCS range
    sim.input.fire = true;
    const evs = runTicks(sim, 1);
    const beam = ofType(evs, 'beam')[0].e;
    expect(beam.hit).toBe('none');
    expect(distance(beam.from, beam.to)).toBeCloseTo(120, 9);
    expect(e.hp).toBe(1000);
    expect(sim.player.en).toBe(120 - 8); // the shot itself happened
  });

  it('a 240 HP target takes exactly six beam shots (no armour, no scaling)', () => {
    const sim = mk({ enemies: [makeTarget('E', ahead(50), v3(), 1.4, 240)] });
    const e = sim.enemies[0];
    select(sim, 'beam');
    sim.runFor(1.0);
    sim.input.fire = true;
    const hp: number[] = [];
    runTicks(sim, ticksOf(1.6), [], () => {
      if (hp[hp.length - 1] !== e.hp) hp.push(e.hp);
    });
    expect(hp).toEqual([200, 160, 120, 80, 40, 0]);
    expect(e.alive).toBe(false);
    // the 6th shot killed it; the 7th (0.25 s later) is a free shot without a target
    const beams = sim.shots.filter((s) => s.weapon === 'beam');
    expect(beams.slice(0, 6).every((s) => s.solutionStatus === 'solved')).toBe(true);
    expect(beams[6].solutionStatus).toBe('inactive');
  });
});
