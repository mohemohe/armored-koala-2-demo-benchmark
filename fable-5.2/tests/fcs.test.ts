/**
 * FCS: lock state machine and fire-control solution (docs/SPEC.md §0, §4 complete, §5, §9, §10, §11).
 *
 * Everything here drives the REAL game code: a real Sim on an isolated stage, the normal lock process
 * (sim.tick → updateLock), the normal trigger (sim.input.fire → processPlayerFire), the real projectiles and
 * the real swept collision. Nothing of the code under test is mocked, no hit is declared by the test, and no
 * projectile is spawned by hand. Expected numbers come from the spec text or from independent arithmetic.
 *
 * §4.6 firing-range protocol
 *   makeTestStage({ floorSize: 10, floorY: 17.25 }) with the mech standing at (0.9, 19.25, −0.85), yaw = π
 *   → muzzle exactly (0, 20, 0). A passive r = 0.5 m target is placed at m + r − v·tFire and moves with the
 *   constant velocity v, so that at the firing instant tFire its centre is m + r. The trigger is pressed one
 *   tick before tFire (never earlier: an unlocked machine gun would free-fire). Each shot uses a freshly
 *   constructed (= reset) Sim; loadout, fire time and viewport vary between the 20 repetitions of a case.
 *
 * Measured numbers are printed with the prefix "[fcs]".
 */
import { afterAll, describe, expect, it } from 'vitest';
import {
  CAMERA,
  FCS_PARTS,
  FCS_RANGE,
  GENERATOR_PARTS,
  LEGS_PARTS,
  TICK,
  WEAPONS,
  computeEffectiveStats,
} from '../src/config';
import { add, addScaled, clone, distance, dot, isFiniteV3, length, normalize, scale, sub, v3, type V3 } from '../src/core/vec';
import { solveGravityIntercept, solveLinearIntercept } from '../src/sim/ballistics';
import { projectToViewport, type ScreenPoint } from '../src/sim/camera';
import {
  FCS_RANGE_TOLERANCE,
  computeFireSolution,
  computeFreeAim,
  inactiveSolution,
  lockCandidateDistancePx,
  lockRadiusCssPx,
  revalidateLock,
} from '../src/sim/fcs';
import { Sim } from '../src/sim/sim';
import { buildSnapshot } from '../src/sim/snapshot';
import type {
  EnemyDef,
  EnemyState,
  FcsId,
  FireSolution,
  GeneratorId,
  LegsId,
  Loadout,
  Projectile,
  ShotRecord,
  SolidDef,
  Viewport,
  Weapon,
} from '../src/sim/types';
import { makeTarget, makeTestStage } from '../src/stage/testStages';

// ───────────────────────────── shared helpers ─────────────────────────────

const MG = WEAPONS.machinegun;
const BEAM = WEAPONS.beam;
const MSL = WEAPONS.missile;
const DEG = Math.PI / 180;

const FCS_IDS: FcsId[] = ['wide', 'medium', 'narrow'];
const GEN_IDS: GeneratorId[] = ['capacity', 'balanced', 'recovery'];
const LEG_IDS: LegsId[] = ['biped', 'quadruped'];
/** All 3 × 3 × 2 = 18 loadouts. */
const ALL_LOADOUTS: Loadout[] = [];
for (const fcs of FCS_IDS) for (const legs of LEG_IDS) for (const generator of GEN_IDS) ALL_LOADOUTS.push({ fcs, generator, legs });

const loadoutName = (l: Loadout): string => `${l.fcs}/${l.generator}/${l.legs}`;
/** Lock time in whole ticks (every one of the 18 lock times is an exact multiple of 1/120 s). */
const lockTicksOf = (l: Loadout): number => Math.round(computeEffectiveStats(l).lockSeconds / TICK);

const maxAbsDiff = (a: V3, b: V3): number => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.z - b.z));
const angleBetween = (a: V3, b: V3): number => {
  const la = length(a);
  const lb = length(b);
  const c = dot(a, b) / (la * lb);
  // atan2 form: accurate for tiny angles (acos is not)
  const cr = v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
  return Math.atan2(length(cr) / (la * lb), c);
};

/** Every number reachable from the FCS / shot state must be finite (or null). */
function expectFiniteState(sim: Sim): void {
  const check = (v: unknown, path: string): void => {
    if (v === null || v === undefined) return;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new Error(`non-finite number at ${path}: ${v}`);
      return;
    }
    if (typeof v === 'object') for (const [k, x] of Object.entries(v as Record<string, unknown>)) check(x, `${path}.${k}`);
  };
  check(sim.lock, 'lock');
  check(sim.fireControl, 'fireControl');
  check(sim.aim, 'aim');
  check(sim.shots, 'shots');
  for (const p of sim.projectiles) {
    check(p.pos, 'projectile.pos');
    check(p.vel, 'projectile.vel');
    check(p.v0, 'projectile.v0');
  }
}

/** The fields of an 'inactive' fire-control value (SPEC §10): only status and weapon are set. */
function expectInactive(fc: FireSolution, weapon: Weapon): void {
  expect(fc).toEqual(inactiveSolution(weapon));
}

interface FlyResult {
  /** sim.time at the end of the tick in which the target first lost HP (null = never). */
  hitTime: number | null;
  hitPos: V3 | null;
  damageEvents: number;
  expired: boolean;
  worldHits: number;
}

/** Runs `seconds` of whole ticks and reports what happened to `target`. */
function flyOut(sim: Sim, target: EnemyState, seconds: number, each?: () => void): FlyResult {
  const res: FlyResult = { hitTime: null, hitPos: null, damageEvents: 0, expired: false, worldHits: 0 };
  const n = Math.round(seconds / TICK);
  for (let i = 0; i < n; i++) {
    sim.tick();
    for (const e of sim.drainEvents()) {
      if (e.type === 'enemy-damaged' && e.enemyId === target.id) {
        res.damageEvents++;
        if (res.hitTime == null) res.hitTime = sim.time;
      } else if (e.type === 'projectile-hit') {
        if (e.target === 'enemy' && e.enemyId === target.id && !res.hitPos) res.hitPos = clone(e.pos);
        if (e.target === 'world') res.worldHits++;
      } else if (e.type === 'projectile-expired') {
        res.expired = true;
      }
    }
    if (each) each();
  }
  return res;
}

// ───────────────────────────── §4.6 firing range ─────────────────────────────

/** §4.6: muzzle of the firing range. */
const M: V3 = v3(0, 20, 0);
const RANGE_START: V3 = v3(0.9, 19.25, -0.85);
const TARGET_RADIUS = 0.5;
const TARGET_HP = 1e9;

interface RangeCase {
  id: string;
  r: V3;
  v: V3;
}
const A = (id: string, r: [number, number, number], v: [number, number, number]): RangeCase => ({
  id,
  r: v3(r[0], r[1], r[2]),
  v: v3(v[0], v[1], v[2]),
});
/** SPEC §4.6 table, verbatim. */
const CASES: RangeCase[] = [
  A('A01', [0, 0, 20], [0, 0, 0]),
  A('A02', [0, 0, 60], [0, 0, 0]),
  A('A03', [0, 0, 100], [0, 0, 0]),
  A('A04', [0, 0, 120], [0, 0, 0]),
  A('A05', [0, 0, 100], [8, 0, 0]),
  A('A06', [0, 0, 100], [-8, 0, 0]),
  A('A07', [0, 0, 100], [0, 0, 8]),
  A('A08', [0, 0, 100], [0, 0, -8]),
  A('A09', [0, 16, 100], [6, 0, 0]),
  A('A10', [0, -16, 100], [-6, 0, 0]),
  A('A11', [0, 0, 100], [6, 3, 0]),
  A('A12', [0, 0, 100], [6, -3, 0]),
  A('A13', [0, 0, 120], [6, 3, 4]),
];
const caseById = (id: string): RangeCase => {
  const c = CASES.find((x) => x.id === id);
  if (!c) throw new Error(id);
  return c;
};

/** SPEC §4.6 reference values (from the formulas, not measured). */
const REFERENCE: Record<string, { t: number; v0?: [number, number, number] }> = {
  A03: { t: 1.004108529, v0: [0, 9.036976765, 99.590828147] },
  A05: { t: 1.007391236, v0: [8, 9.066521121, 99.266299391] },
  A13: { t: 1.266137996 },
};

/** Extra ticks between the completion of the lock and the shot, one per repetition (0 = at completion). */
const EXTRA_TICKS = [0, 1, 2, 3, 5, 8, 13, 21, 4, 7, 11, 17, 0, 6, 9, 15, 19, 23, 2, 10];
const VIEWPORTS: Viewport[] = [
  { width: 1280, height: 720 },
  { width: 1920, height: 1080 },
  { width: 1024, height: 768 },
  { width: 1600, height: 900 },
];

interface RangeOpts {
  weapon?: Weapon;
  viewport?: Viewport;
  radius?: number;
  hp?: number;
}
interface RangeSetup {
  sim: Sim;
  target: EnemyState;
  /** The shot happens at the end of tick number nFire (1-based), i.e. at tFire = nFire / 120 s. */
  nFire: number;
  tFire: number;
  /** m + r */
  pFire: V3;
  /**
   * Lock state at the start of the firing tick (filled in by fireSingle). 'acquiring' = the shot leaves in the
   * very sub-step in which the lock completes; 'locked' = the lock was complete before.
   */
  lockBeforeFire: Sim['lock']['state'];
}

/**
 * Camera pitch that looks at where the target will be when the shot is fired. Only the pitch is used: the
 * muzzle does not depend on it, and the yaw stays exactly π so that the muzzle stays exactly at (0, 20, 0).
 */
function rangePitch(c: RangeCase): number {
  const pFire = add(M, c.r);
  const pivot = v3(RANGE_START.x, RANGE_START.y + CAMERA.pivotUp, RANGE_START.z);
  return Math.atan2(pFire.y - pivot.y, Math.hypot(pFire.x - pivot.x, pFire.z - pivot.z));
}

/**
 * Builds the range for one shot: the target starts at m + r − v·tFire so that it is at m + r at tFire.
 *
 * tFire lies `extraTicks` ticks after the instant the lock completes (0 = the shot leaves in the very sub-step
 * in which the lock completes). The lock is first judged at t = 0, with the camera still level: a target that
 * is inside the circle of that first view is acquired there and complete after lockTicks ticks; any other
 * target is acquired at the end of the first tick, once the pitch input below has turned the camera to it,
 * and complete after 1 + lockTicks ticks.
 */
function rangeSetup(c: RangeCase, loadout: Loadout, extraTicks: number, opts: RangeOpts = {}): RangeSetup {
  const pFire = add(M, c.r);
  const build = (acquiredAtTick: 0 | 1): RangeSetup => {
    const nFire = acquiredAtTick + lockTicksOf(loadout) + extraTicks;
    const tFire = nFire * TICK;
    const p0 = addScaled(pFire, c.v, -tFire);
    const stage = makeTestStage({
      floorSize: 10,
      floorY: 17.25,
      start: clone(RANGE_START),
      yaw: Math.PI,
      enemies: [makeTarget('TGT', p0, c.v, opts.radius ?? TARGET_RADIUS, opts.hp ?? TARGET_HP)],
    });
    const sim = new Sim(stage, { loadout, viewport: opts.viewport });
    const acquiredAtStart = sim.lock.targetId === 'TGT';
    sim.applyLook(0, rangePitch(c));
    if (opts.weapon && opts.weapon !== sim.player.weapon) sim.input.weaponSelect = opts.weapon;
    return { sim, target: sim.enemies[0], nFire, tFire, pFire, lockBeforeFire: acquiredAtStart ? 'acquiring' : 'none' };
  };
  const fromStart = build(0);
  return fromStart.lockBeforeFire === 'acquiring' ? fromStart : build(1);
}

/** Lets the normal lock process run, pulls the trigger one tick before tFire, returns the single shot. */
function fireSingle(s: RangeSetup): ShotRecord {
  const { sim, nFire } = s;
  for (let i = 0; i < nFire - 1; i++) sim.tick();
  expect(sim.shots.length).toBe(0);
  s.lockBeforeFire = sim.lock.state;
  sim.input.fire = true;
  sim.tick();
  sim.input.fire = false;
  expect(sim.time).toBeCloseTo(s.tFire, 12);
  expect(sim.shots.length).toBe(1);
  return sim.shots[0];
}

function expectRangeMuzzle(sim: Sim): void {
  const m = sim.player.muzzle;
  expect(Math.abs(m.x - M.x)).toBeLessThan(1e-12);
  expect(m.y).toBe(M.y);
  expect(Math.abs(m.z - M.z)).toBeLessThan(1e-12);
}

/** |bullet(t) − target(t)| at the adopted time, recomputed from what the shot record says was really fired. */
function recordResidual(rec: ShotRecord): number {
  const t = rec.flightSeconds as number;
  const v0 = rec.initialVelocity as V3;
  const p = rec.targetPosAtFire as V3;
  const v = rec.targetVelAtFire as V3;
  const a = rec.accelerationAtFire;
  const bullet = v3(
    rec.muzzle.x + v0.x * t + 0.5 * a.x * t * t,
    rec.muzzle.y + v0.y * t + 0.5 * a.y * t * t,
    rec.muzzle.z + v0.z * t + 0.5 * a.z * t * t,
  );
  return distance(bullet, addScaled(p, v, t));
}

describe('firing range geometry', () => {
  it('the mech at (0.9, 19.25, −0.85), yaw π stands still with its muzzle exactly at (0, 20, 0)', () => {
    const s = rangeSetup(caseById('A05'), ALL_LOADOUTS[0], 0);
    expect(s.sim.player.grounded).toBe(true);
    expectRangeMuzzle(s.sim);
    s.sim.runFor(3);
    expect(s.sim.player.pos).toEqual(RANGE_START);
    expect(s.sim.player.vel).toEqual(v3(0, 0, 0));
    expectRangeMuzzle(s.sim);
    expect(s.sim.status).toBe('playing');
  });
});

interface Row {
  id: string;
  shots: number;
  hits: number;
  maxResidual: number;
  flight: number;
  maxSpeedErr: number;
  maxPosErr: number;
  loadouts: number;
}

describe('§4.6 machine gun A01–A13: lead + gravity compensation through the normal lock, real bullets', () => {
  const rows: Row[] = [];

  afterAll(() => {
    const lines = [
      '[fcs] §4.6 machine gun — normal lock → real bullet → real swept collision (target radius 0.5 m)',
      '[fcs] case | shots | hits | max residual [m] | flight time [s] | max ||v0|-100| [m/s] | max |p_fire-(m+r)| [m] | loadouts',
    ];
    for (const r of rows) {
      lines.push(
        `[fcs] ${r.id}  |  ${String(r.shots).padStart(2)}   |  ${String(r.hits).padStart(2)}  |   ${r.maxResidual.toExponential(3)}    |  ${r.flight.toFixed(9)}    |      ${r.maxSpeedErr.toExponential(2)}        |       ${r.maxPosErr.toExponential(2)}        |  ${r.loadouts}`,
      );
    }
    const shots = rows.reduce((a, r) => a + r.shots, 0);
    const hits = rows.reduce((a, r) => a + r.hits, 0);
    lines.push(`[fcs] total ${hits}/${shots} hits, max residual ${Math.max(...rows.map((r) => r.maxResidual)).toExponential(3)} m`);
    console.log(lines.join('\n'));
  });

  CASES.forEach((c, ci) => {
    it(`${c.id}: r=(${c.r.x},${c.r.y},${c.r.z}) v=(${c.v.x},${c.v.y},${c.v.z}) → 20 single shots, 20 hits, residual ≤ 0.01 m`, () => {
      const row: Row = { id: c.id, shots: 0, hits: 0, maxResidual: 0, flight: 0, maxSpeedErr: 0, maxPosErr: 0, loadouts: 0 };
      const used = new Set<string>();
      for (let rep = 0; rep < 20; rep++) {
        const loadout = ALL_LOADOUTS[(rep + ci * 7) % ALL_LOADOUTS.length];
        used.add(loadoutName(loadout));
        const s = rangeSetup(c, loadout, EXTRA_TICKS[rep], { viewport: VIEWPORTS[rep % VIEWPORTS.length] });
        const { sim, target } = s;
        const label = `${c.id} rep ${rep} ${loadoutName(loadout)}`;

        const rec = fireSingle(s);
        row.shots++;

        // ── the shot was taken through a completed lock, from the same-time state ──
        // (with no extra ticks it leaves in the very sub-step in which the lock completes)
        expect(s.lockBeforeFire, label).toBe(EXTRA_TICKS[rep] === 0 ? 'acquiring' : 'locked');
        expect(sim.lock.state, label).toBe('locked');
        expect(sim.lock.targetId, label).toBe('TGT');
        expectRangeMuzzle(sim);
        expect(rec.weapon).toBe('machinegun');
        expect(rec.solutionStatus, label).toBe('solved');
        expect(rec.targetId).toBe('TGT');
        expect(rec.firedAt).toBeCloseTo(sim.time, 12);
        expect(maxAbsDiff(rec.muzzle, M)).toBeLessThan(1e-12);
        const posErr = maxAbsDiff(rec.targetPosAtFire as V3, s.pFire);
        expect(posErr, label).toBeLessThan(1e-6);
        row.maxPosErr = Math.max(row.maxPosErr, posErr);
        expect(rec.targetPosAtFire).toEqual(target.pos); // the target's state at this very instant
        expect(rec.targetVelAtFire).toEqual(c.v);
        expect(rec.accelerationAtFire).toEqual(v3(0, -18, 0));
        expect(sim.player.ammo.machinegun).toBe(MG.ammo - 1);

        // ── what was fired: 100 m/s along the solution of §4.3, nothing else ──
        const v0 = rec.initialVelocity as V3;
        const speedErr = Math.abs(length(v0) - 100);
        expect(speedErr, label).toBeLessThanOrEqual(1e-3);
        row.maxSpeedErr = Math.max(row.maxSpeedErr, speedErr);
        expect(maxAbsDiff(v0, scale(rec.launchDir, 100))).toBeLessThan(1e-12);
        const bullet = sim.projectiles[sim.projectiles.length - 1];
        expect(bullet.kind).toBe('mg');
        expect(bullet.v0).toEqual(v0); // the record holds the vector really given to the projectile
        expect(bullet.origin).toEqual(rec.muzzle);
        expect(bullet.pos).toEqual(rec.muzzle); // age 0: not advanced by the sub-step that spawned it

        // independent re-computation from the recorded same-time state
        const ref = solveGravityIntercept(rec.muzzle, rec.targetPosAtFire as V3, rec.targetVelAtFire as V3, 100, 18, 2);
        expect(ref, label).not.toBeNull();
        if (!ref) continue;
        expect(maxAbsDiff(rec.launchDir, ref.dir)).toBeLessThan(1e-12);
        expect(rec.flightSeconds).toBeCloseTo(ref.t, 12);
        expect(maxAbsDiff(rec.intercept as V3, ref.intercept)).toBeLessThan(1e-9);
        // d = (r + v t − ½ g t²)/(s t) with the spec's formula, written out
        const t = rec.flightSeconds as number;
        const rr = sub(rec.targetPosAtFire as V3, rec.muzzle);
        const d = v3((rr.x + c.v.x * t) / (100 * t), (rr.y + c.v.y * t + 9 * t * t) / (100 * t), (rr.z + c.v.z * t) / (100 * t));
        expect(maxAbsDiff(rec.launchDir, d)).toBeLessThan(1e-9);
        expect(t).toBeGreaterThan(0);
        expect(t).toBeLessThanOrEqual(2);

        // residual: bullet vs constant-velocity target at the adopted time
        const residual = recordResidual(rec);
        expect(residual, label).toBeLessThanOrEqual(0.01);
        const fc = sim.fireControl; // the solution the game used at this instant
        expect(fc.status).toBe('solved');
        expect(fc.evaluatedAt).toBe(rec.firedAt); // evaluated at the firing instant itself
        expect(fc.launchDir).toEqual(rec.launchDir);
        expect(fc.residual as number).toBeLessThanOrEqual(0.01);
        // aim point = p + v t − ½ g t² lies above the predicted hit point p + v t by 9 t²
        expect((fc.aimPoint as V3).y - (fc.intercept as V3).y).toBeCloseTo(9 * t * t, 9);
        row.maxResidual = Math.max(row.maxResidual, residual, fc.residual as number);
        row.flight = t;

        // spec reference values
        const refv = REFERENCE[c.id];
        if (refv) {
          expect(Math.abs(t - refv.t) / refv.t, label).toBeLessThan(1e-6);
          if (refv.v0) {
            const want = v3(refv.v0[0], refv.v0[1], refv.v0[2]);
            expect(Math.abs(v0.x - want.x)).toBeLessThan(1e-6 * Math.max(1, Math.abs(want.x)));
            expect(Math.abs(v0.y - want.y)).toBeLessThan(1e-6 * Math.max(1, Math.abs(want.y)));
            expect(Math.abs(v0.z - want.z)).toBeLessThan(1e-6 * Math.max(1, Math.abs(want.z)));
          }
        }

        // ── the real bullet really hits, exactly once, before its life ends ──
        const out = flyOut(sim, target, 2.25);
        expect(out.hitTime, label).not.toBeNull();
        if (out.hitTime == null) continue;
        row.hits++;
        expect(out.damageEvents, label).toBe(1);
        expect(TARGET_HP - target.hp).toBe(MG.damage);
        expect(out.expired).toBe(false);
        expect(sim.projectiles.length).toBe(0);
        const dt = out.hitTime - s.tFire;
        expect(dt).toBeLessThan(MG.lifeSeconds);
        // first contact with the 0.5 m sphere happens a little before the centre would be reached
        expect(dt).toBeLessThanOrEqual(t + TICK + 1e-9);
        expect(dt).toBeGreaterThan(t - 0.007);
        expect(distance(out.hitPos as V3, rec.intercept as V3)).toBeLessThan(TARGET_RADIUS + 0.06);
        expectFiniteState(sim);
      }
      row.loadouts = used.size;
      rows.push(row);
      expect(used.size).toBe(18); // precision must not depend on FCS / generator / legs
      expect(row.hits).toBe(20);
      expect(row.maxResidual).toBeLessThanOrEqual(0.01);
    });
  });

  it('A01–A13 again with a 1 cm target: the real trajectory passes within 0.01 m of the predicted centre', () => {
    let hits = 0;
    CASES.forEach((c, ci) => {
      const s = rangeSetup(c, ALL_LOADOUTS[(ci * 5) % 18], 3, { radius: 0.01 });
      const rec = fireSingle(s);
      expect(rec.solutionStatus).toBe('solved');
      const out = flyOut(s.sim, s.target, 2.1);
      expect(out.hitTime, c.id).not.toBeNull();
      expect(TARGET_HP - s.target.hp).toBe(MG.damage);
      hits++;
    });
    console.log(`[fcs] 1 cm-radius target: ${hits}/13 hits (A01–A13)`);
  });

  it('a re-sortie (sim.reset) clears lock, solution and history and reproduces the same shot bit for bit', () => {
    const s = rangeSetup(caseById('A11'), { fcs: 'narrow', generator: 'recovery', legs: 'quadruped' }, 4);
    const first = JSON.parse(JSON.stringify(fireSingle(s))) as ShotRecord;
    expect(s.sim.lock.state).toBe('locked'); // the first sortie did complete a lock
    expect(s.sim.lock.progress).toBe(1);
    const out1 = flyOut(s.sim, s.target, 2.1);
    expect(out1.hitTime).not.toBeNull();

    s.sim.reset();
    expect(s.sim.time).toBe(0);
    expect(s.sim.shots).toEqual([]);
    expect(s.sim.nextShotId).toBe(1);
    // Nothing of the old lock survives: no progress, no held time, no solution. The target stands inside the
    // circle at the first instant of the new sortie, so a NEW acquisition begins there, from zero.
    expect(s.sim.lock.state).toBe('acquiring');
    expect(s.sim.lock.targetId).toBe('TGT');
    expect(s.sim.lock.progress).toBe(0);
    expect(s.sim.lock.heldSeconds).toBe(0);
    expectInactive(s.sim.fireControl, 'machinegun');
    expect(s.sim.projectiles.length).toBe(0);
    const s2: RangeSetup = { ...s, target: s.sim.enemies[0] };
    expect(s.sim.player.pitch).toBe(0);
    s.sim.applyLook(0, rangePitch(caseById('A11'))); // the same inputs as the first sortie
    const second = fireSingle(s2);
    expect(JSON.parse(JSON.stringify(second))).toEqual(first);
    const out2 = flyOut(s.sim, s2.target, 2.1);
    expect(out2.hitTime).toBe(out1.hitTime);

    // a completed lock that is still held at the instant of the re-sortie is wiped just the same
    s.sim.reset();
    s.sim.applyLook(0, rangePitch(caseById('A11')));
    for (let i = 0; i < s.nFire; i++) s.sim.tick();
    expect(s.sim.lock.state).toBe('locked');
    expect(s.sim.fireControl.status).toBe('solved');
    s.sim.reset();
    expect(s.sim.lock.state).toBe('acquiring');
    expect(s.sim.lock.progress).toBe(0);
    expect(s.sim.lock.heldSeconds).toBe(0);
    expectInactive(s.sim.fireControl, 'machinegun');
  });

  it('a held trigger re-solves every bullet of a burst from the state at its own firing instant (A05, 10/10 hits)', () => {
    const c = caseById('A05');
    const s = rangeSetup(c, { fcs: 'medium', generator: 'balanced', legs: 'biped' }, 2);
    const { sim, target } = s;
    for (let i = 0; i < s.nFire - 1; i++) sim.tick();
    sim.input.fire = true;
    for (let i = 0; i < 109; i++) sim.tick(); // shots at tFire + k·0.1, k = 0..9
    sim.input.fire = false;
    expect(sim.shots.length).toBe(10);
    sim.shots.forEach((rec, k) => {
      expect(rec.solutionStatus).toBe('solved');
      expect(rec.firedAt).toBeCloseTo(s.tFire + k * MG.interval, 12);
      // the target has moved on: every record holds its own same-time position
      expect((rec.targetPosAtFire as V3).x).toBeCloseTo(c.v.x * k * MG.interval, 9);
      const ref = solveGravityIntercept(rec.muzzle, rec.targetPosAtFire as V3, rec.targetVelAtFire as V3, 100, 18, 2);
      expect(ref).not.toBeNull();
      if (ref) expect(maxAbsDiff(rec.launchDir, ref.dir)).toBeLessThan(1e-12);
      expect(recordResidual(rec)).toBeLessThanOrEqual(0.01);
      if (k > 0) expect(maxAbsDiff(rec.launchDir, sim.shots[k - 1].launchDir)).toBeGreaterThan(1e-4);
    });
    const out = flyOut(sim, target, 2.3);
    expect(out.damageEvents).toBe(10);
    expect(TARGET_HP - target.hp).toBe(10 * MG.damage);
    expect(sim.projectiles.length).toBe(0);
  });
});

// ───────────────────────────── beam ─────────────────────────────

describe('§4.6 beam: the same 13 placements are hit at the firing instant, aimed at the current position', () => {
  const combos: Loadout[] = [];
  for (const fcs of FCS_IDS) for (const legs of LEG_IDS) combos.push({ fcs, legs, generator: GEN_IDS[combos.length % 3] });

  it('A01–A13 × 6 loadouts: hp −40 in the firing sub-step, launchDir = normalize(p − m), t = 0, residual 0', () => {
    let shots = 0;
    let hits = 0;
    CASES.forEach((c, ci) => {
      combos.forEach((loadout, li) => {
        const s = rangeSetup(c, loadout, EXTRA_TICKS[(ci + li * 3) % 20], { weapon: 'beam' });
        const { sim, target } = s;
        const label = `${c.id} ${loadoutName(loadout)}`;
        for (let i = 0; i < s.nFire - 1; i++) sim.tick();
        expect(sim.player.weapon).toBe('beam');
        expect(sim.lock.targetId, label).toBe('TGT'); // switching weapons did not touch the lock
        const en0 = sim.player.en;
        expect(target.hp).toBe(TARGET_HP);
        sim.drainEvents();
        sim.input.fire = true;
        sim.tick();
        sim.input.fire = false;
        shots++;
        const events = sim.drainEvents();

        // damage in the same sub-step, exactly once
        expect(sim.lock.state, label).toBe('locked');
        expect(TARGET_HP - target.hp, label).toBe(BEAM.damage);
        if (TARGET_HP - target.hp === BEAM.damage) hits++;
        expect(events.filter((e) => e.type === 'enemy-damaged').length).toBe(1);
        expect(sim.player.en).toBe(en0 - BEAM.enCost);
        expect(sim.shots.length).toBe(1);
        const rec = sim.shots[0];
        expect(sim.player.lastEnSpentAt).toBe(rec.firedAt);
        expect(rec.weapon).toBe('beam');
        expect(rec.solutionStatus).toBe('solved');
        expect(rec.targetId).toBe('TGT');
        expect(rec.firedAt).toBeCloseTo(s.tFire, 12);
        expect(maxAbsDiff(rec.targetPosAtFire as V3, s.pFire)).toBeLessThan(1e-6);
        expect(rec.targetVelAtFire).toEqual(c.v);
        // direction: straight at the CURRENT centre — no lead, no elevation
        const direct = normalize(sub(rec.targetPosAtFire as V3, rec.muzzle));
        expect(maxAbsDiff(rec.launchDir, direct)).toBeLessThan(1e-12);
        expect(maxAbsDiff(rec.launchDir, normalize(c.r))).toBeLessThan(1e-9);
        expect(rec.flightSeconds).toBe(0);
        expect(rec.intercept).toEqual(rec.targetPosAtFire);
        expect(rec.initialVelocity).toBeNull();
        expect(rec.accelerationAtFire).toEqual(v3(0, 0, 0));

        const fc = sim.fireControl;
        expect(fc.status).toBe('solved');
        expect(fc.weapon).toBe('beam');
        expect(fc.flightSeconds).toBe(0);
        expect(fc.residual).toBe(0);
        expect(fc.aimPoint).toEqual(fc.targetPos);
        expect(fc.intercept).toEqual(fc.targetPos);

        const beam = events.find((e) => e.type === 'beam');
        expect(beam).toBeDefined();
        if (beam && beam.type === 'beam') {
          expect(beam.hit).toBe('enemy');
          expect(beam.enemyId).toBe('TGT');
          expect(maxAbsDiff(beam.from, M)).toBeLessThan(1e-12);
          // the ray goes through the centre: it enters the sphere exactly one radius before it
          expect(distance(beam.to, target.pos)).toBeCloseTo(TARGET_RADIUS, 9);
          expect(distance(beam.from, beam.to)).toBeCloseTo(length(c.r) - TARGET_RADIUS, 6);
        }
        // the machine-gun aim for the same instant is a different direction whenever the target moves
        if (length(c.v) > 0) {
          const mg = computeFireSolution(sim, 'machinegun');
          expect(maxAbsDiff(mg.launchDir as V3, rec.launchDir)).toBeGreaterThan(0.01);
        }
        // nothing else was hurt afterwards
        sim.runFor(0.2);
        expect(TARGET_HP - target.hp).toBe(BEAM.damage);
        expectFiniteState(sim);
      });
    });
    console.log(`[fcs] beam: ${hits}/${shots} instant hits (13 placements × 6 loadouts), residual 0, flight time 0`);
    expect(hits).toBe(shots);
    expect(shots).toBe(78);
  });
});

// ───────────────────────────── missile ─────────────────────────────

describe('§4.6 missile A05 / A06 / A07: 45 m/s lead direction, turn-rate limited guidance, hit within life', () => {
  const TURN = MSL.turnRateDeg * DEG;

  function launch(c: RangeCase, loadout: Loadout, extra: number): { s: RangeSetup; rec: ShotRecord; missile: Projectile } {
    const s = rangeSetup(c, loadout, extra, { weapon: 'missile' });
    const rec = fireSingle(s);
    const missile = s.sim.projectiles[s.sim.projectiles.length - 1];
    return { s, rec, missile };
  }

  it('initial direction = solveLinearIntercept(m, p, v, 45, 4); speed 45; heading rate ≤ 120°/s; every missile hits', () => {
    const lines: string[] = ['[fcs] missile | loadout | lead time [s] | hit after [s] | max heading rate [deg/s]'];
    let shots = 0;
    let hits = 0;
    for (const id of ['A05', 'A06', 'A07']) {
      const c = caseById(id);
      for (let li = 0; li < 6; li++) {
        const loadout = ALL_LOADOUTS[(li * 3 + CASES.indexOf(c)) % 18];
        const { s, rec, missile } = launch(c, loadout, EXTRA_TICKS[li * 2]);
        const { sim, target } = s;
        shots++;
        expect(rec.weapon).toBe('missile');
        expect(rec.solutionStatus).toBe('solved');
        expect(rec.targetId).toBe('TGT');
        expect(maxAbsDiff(rec.muzzle, M)).toBeLessThan(1e-12);
        expect(maxAbsDiff(rec.targetPosAtFire as V3, s.pFire)).toBeLessThan(1e-6);
        expect(rec.targetVelAtFire).toEqual(c.v);
        expect(rec.accelerationAtFire).toEqual(v3(0, 0, 0));
        expect(sim.player.ammo.missile).toBe(MSL.ammo - 1);

        const lead = solveLinearIntercept(rec.muzzle, rec.targetPosAtFire as V3, rec.targetVelAtFire as V3, 45, 4);
        expect(lead).not.toBeNull();
        if (!lead) continue;
        expect(maxAbsDiff(rec.launchDir, lead.dir)).toBeLessThan(1e-12);
        expect(rec.flightSeconds).toBeCloseTo(lead.t, 12);
        expect(maxAbsDiff(rec.intercept as V3, lead.intercept)).toBeLessThan(1e-9);
        // the spec's quadratic, written out: (v·v − 45²) t² + 2 (r·v) t + r·r = 0
        const rr = sub(rec.targetPosAtFire as V3, rec.muzzle);
        const t = lead.t;
        expect((dot(c.v, c.v) - 45 * 45) * t * t + 2 * dot(rr, c.v) * t + dot(rr, rr)).toBeCloseTo(0, 6);
        expect(maxAbsDiff(rec.launchDir, normalize(addScaled(rr, c.v, t)))).toBeLessThan(1e-12);
        // no gravity compensation, and not the machine-gun or beam direction
        expect(maxAbsDiff(rec.launchDir, normalize(rr))).toBeGreaterThan(id === 'A07' ? -1 : 0.05);
        const v0 = rec.initialVelocity as V3;
        expect(Math.abs(length(v0) - 45)).toBeLessThan(1e-9);
        expect(maxAbsDiff(v0, scale(rec.launchDir, 45))).toBeLessThan(1e-9);
        expect(missile.kind).toBe('missile');
        expect(missile.targetId).toBe('TGT');
        expect(missile.v0).toEqual(v0);
        expect(missile.origin).toEqual(rec.muzzle);
        const fc = sim.fireControl;
        expect(fc.status).toBe('solved');
        expect(fc.aimPoint).toEqual(fc.intercept); // the missile's aim point is its lead point
        expect(fc.residual as number).toBeLessThan(1e-9);

        let prev = clone(missile.vel);
        let maxRate = 0;
        const out = flyOut(sim, target, 4.1, () => {
          if (!missile.alive) return;
          expect(Math.abs(length(missile.vel) - 45)).toBeLessThan(1e-9);
          const rate = angleBetween(prev, missile.vel) / TICK;
          maxRate = Math.max(maxRate, rate);
          prev = clone(missile.vel);
          expect(missile.targetId).toBe('TGT'); // kept even after the player's lock is gone
        });
        expect(maxRate).toBeLessThanOrEqual(TURN + 1e-6);
        expect(out.hitTime, `${id} ${loadoutName(loadout)}`).not.toBeNull();
        if (out.hitTime == null) continue;
        hits++;
        expect(out.damageEvents).toBe(1);
        expect(TARGET_HP - target.hp).toBe(MSL.damage);
        const dt = out.hitTime - s.tFire;
        expect(dt).toBeLessThan(MSL.lifeSeconds);
        expect(Math.abs(dt - t)).toBeLessThan(0.03);
        expect(sim.projectiles.length).toBe(0);
        lines.push(
          `[fcs] ${id}     | ${loadoutName(loadout).padEnd(27)} | ${t.toFixed(6)} | ${dt.toFixed(6)} | ${(maxRate / DEG).toExponential(2)}`,
        );
      }
    }
    lines.push(`[fcs] missile: ${hits}/${shots} hits`);
    console.log(lines.join('\n'));
    expect(hits).toBe(shots);
  });

  it('a target that turns after launch is followed at no more than 120°/s (and the limit is really reached)', () => {
    const c = caseById('A05');
    const { s, missile } = launch(c, { fcs: 'medium', generator: 'balanced', legs: 'biped' }, 1);
    const { sim, target } = s;
    target.scriptedVel = v3(0, 30, 0); // abrupt change of course right after the launch
    let prev = clone(missile.vel);
    let maxRate = 0;
    flyOut(sim, target, 4.1, () => {
      if (!missile.alive) return;
      expect(Math.abs(length(missile.vel) - 45)).toBeLessThan(1e-9);
      maxRate = Math.max(maxRate, angleBetween(prev, missile.vel) / TICK);
      prev = clone(missile.vel);
    });
    console.log(`[fcs] missile vs turning target: max heading rate ${(maxRate / DEG).toFixed(6)} deg/s (limit 120)`);
    expect(maxRate).toBeLessThanOrEqual(TURN + 1e-6);
    expect(maxRate).toBeGreaterThan(TURN * 0.999);
  });
});

// ───────────────────────────── moving shooter ─────────────────────────────

interface MoveScenario {
  name: string;
  /** Sets the inputs before tick `tick` (0-based); the trigger is handled by the harness. */
  drive(sim: Sim, tick: number, nFire: number): void;
  /** Player state at the firing instant. */
  verify(sim: Sim): void;
}

const SCENARIOS: MoveScenario[] = [
  {
    name: 'glide',
    drive(sim, tick) {
      if (tick === 0) {
        sim.input.moveX = -1; // yaw = π: "left" is world +X
        sim.input.glideTogglePressed = true;
      } else if (tick === 1) {
        sim.input.moveX = 0; // the glide keeps its direction without any key
      }
    },
    verify(sim) {
      const p = sim.player;
      expect(p.horizontalMode).toBe('glide');
      expect(p.glideEnabled).toBe(true);
      expect(p.grounded).toBe(true);
      expect(p.vel.x).toBeCloseTo(sim.stats.glideSpeed, 9);
      expect(Math.abs(p.vel.z)).toBeLessThan(1e-9);
      expect(p.en).toBe(sim.stats.maxEn); // glide costs nothing
    },
  },
  {
    name: 'flight',
    drive(sim, tick) {
      if (tick === 0) {
        sim.input.jumpPressed = true;
        sim.input.jump = true; // held: thrusters after 0.20 s
        sim.input.moveX = -1;
      }
    },
    verify(sim) {
      const p = sim.player;
      expect(p.verticalMode).toBe('flying');
      expect(p.grounded).toBe(false);
      expect(p.vel.y).toBeCloseTo(8, 9);
      expect(p.vel.x).toBeCloseTo(sim.stats.airSpeed, 6);
      expect(p.en).toBeLessThan(sim.stats.maxEn);
    },
  },
  {
    name: 'quick boost impulse',
    drive(sim, tick, nFire) {
      if (tick === nFire - 9) {
        sim.input.moveX = -1;
        sim.input.qbPressed = true; // the shot falls 0.075 s into the 0.15 s impulse
      }
    },
    verify(sim) {
      const p = sim.player;
      expect(p.horizontalMode).toBe('quickboost');
      expect(p.qbSuccessfulCount).toBe(1);
      expect(p.qbImpulseRemaining).toBeCloseTo(0.075, 9);
      expect(p.vel.x).toBeCloseTo(sim.stats.qbSpeed, 9);
      expect(p.en).toBe(sim.stats.maxEn - 36);
    },
  },
];

describe('§4.6 moving shooter (A05 r and v at the firing instant): latest muzzle, no inherited mech velocity', () => {
  const c = caseById('A05');
  const want = v3(8, 9.066521121, 99.266299391); // SPEC reference initial velocity of A05

  function run(sc: MoveScenario, loadout: Loadout, nFire: number, enemies: EnemyDef[]): Sim {
    const sim = new Sim(makeTestStage({ yaw: Math.PI, enemies }), { loadout });
    for (let tick = 0; tick < nFire; tick++) {
      sc.drive(sim, tick, nFire);
      if (tick === nFire - 1) sim.input.fire = true;
      sim.tick();
    }
    return sim;
  }

  for (const sc of SCENARIOS) {
    it(`${sc.name}: the bullet leaves the actual muzzle with exactly the A05 velocity and hits (all FCS × legs)`, () => {
      const lines: string[] = [];
      let shots = 0;
      let hits = 0;
      for (const fcs of FCS_IDS) {
        for (const legs of LEG_IDS) {
          const loadout: Loadout = { fcs, legs, generator: GEN_IDS[shots % 3] };
          const label = `${sc.name} ${loadoutName(loadout)}`;
          const nFire = 1 + lockTicksOf(loadout) + 12;
          const tFire = nFire * TICK;

          // pass 1: no target — learn where the muzzle is at the firing instant
          const probe = run(sc, loadout, nFire, []);
          const mFire = clone(probe.player.muzzle);
          sc.verify(probe);

          // pass 2: the same inputs with the target placed so that r and v are A05's at tFire
          const pFire = add(mFire, c.r);
          const sim = run(sc, loadout, nFire, [makeTarget('TGT', addScaled(pFire, c.v, -tFire), c.v)]);
          sim.clearInput();
          const target = sim.enemies[0];
          shots++;
          expect(sim.time).toBeCloseTo(tFire, 12);
          sc.verify(sim);
          const playerVel = clone(sim.player.vel);
          expect(length(playerVel)).toBeGreaterThan(8); // the mech really is moving
          // the passive target did not influence the mech (sub-steps are cut differently once a lock is
          // running, hence rounding-level differences only)
          expect(maxAbsDiff(sim.player.muzzle, mFire)).toBeLessThan(1e-9);
          expect(sim.lock.state, label).toBe('locked');

          expect(sim.shots.length).toBe(1);
          const rec = sim.shots[0];
          expect(rec.solutionStatus, label).toBe('solved');
          expect(rec.firedAt).toBeCloseTo(sim.time, 12);
          // fired from the muzzle of this very instant (not from where the mech was a sub-step ago)
          expect(rec.muzzle).toEqual(sim.player.muzzle);
          expect(distance(rec.muzzle, add(sim.player.prevPos, sub(mFire, sim.player.pos)))).toBeGreaterThan(0.05);
          // r and v at the firing instant are A05's
          expect(maxAbsDiff(sub(rec.targetPosAtFire as V3, rec.muzzle), c.r)).toBeLessThan(1e-6);
          expect(maxAbsDiff(rec.targetVelAtFire as V3, c.v)).toBeLessThan(1e-12);

          // world-frame muzzle velocity: |v0| = 100 and equal to the A05 solution — the mech velocity is
          // neither added to the bullet nor subtracted in the aim computation
          const v0 = rec.initialVelocity as V3;
          expect(Math.abs(length(v0) - 100)).toBeLessThanOrEqual(1e-3);
          expect(Math.abs(v0.x - want.x)).toBeLessThan(1e-6 * want.x);
          expect(Math.abs(v0.y - want.y)).toBeLessThan(1e-6 * want.y);
          expect(Math.abs(v0.z - want.z)).toBeLessThan(1e-6 * want.z);
          const ref = solveGravityIntercept(rec.muzzle, rec.targetPosAtFire as V3, rec.targetVelAtFire as V3, 100, 18, 2);
          expect(ref).not.toBeNull();
          if (ref) expect(maxAbsDiff(v0, scale(ref.dir, 100))).toBeLessThan(1e-10);
          expect(recordResidual(rec)).toBeLessThanOrEqual(0.01);
          // the velocity the bullet would have with the mech velocity added is clearly something else
          expect(maxAbsDiff(v0, add(scale(rec.launchDir, 100), playerVel))).toBeGreaterThan(7.9);

          const bullet = sim.projectiles[sim.projectiles.length - 1];
          expect(bullet.kind).toBe('mg');
          expect(bullet.origin).toEqual(rec.muzzle);
          expect(bullet.pos).toEqual(rec.muzzle);
          expect(bullet.v0).toEqual(v0);
          // one tick later it is where the closed form says — not carried along with the mech
          sim.tick();
          const expected = v3(
            rec.muzzle.x + v0.x * TICK,
            rec.muzzle.y + v0.y * TICK - 9 * TICK * TICK,
            rec.muzzle.z + v0.z * TICK,
          );
          expect(maxAbsDiff(bullet.pos, expected)).toBeLessThan(1e-9);

          const out = flyOut(sim, target, 2.2);
          expect(out.hitTime, label).not.toBeNull();
          if (out.hitTime == null) continue;
          hits++;
          expect(out.damageEvents).toBe(1);
          expect(TARGET_HP - target.hp).toBe(MG.damage);
          expect(out.hitTime - tFire).toBeLessThan(MG.lifeSeconds);
          lines.push(
            `[fcs] ${sc.name.padEnd(19)} | ${loadoutName(loadout).padEnd(27)} | mech v=(${playerVel.x.toFixed(2)}, ${playerVel.y.toFixed(2)}, ${playerVel.z.toFixed(2)}) | |v0|-100=${(length(v0) - 100).toExponential(1)} | residual ${recordResidual(rec).toExponential(2)} | hit after ${(out.hitTime - tFire).toFixed(4)} s`,
          );
        }
      }
      lines.push(`[fcs] moving shooter / ${sc.name}: ${hits}/${shots} hits`);
      console.log(lines.join('\n'));
      expect(hits).toBe(shots);
      expect(shots).toBe(6);
    });
  }
});

// ───────────────────────────── physics is kept ─────────────────────────────

describe('physics kept: a compensated bullet is still a plain parabola, never guided', () => {
  const closedForm = (rec: ShotRecord, age: number): V3 => {
    const v0 = rec.initialVelocity as V3;
    return v3(rec.muzzle.x + v0.x * age, rec.muzzle.y + v0.y * age - 9 * age * age, rec.muzzle.z + v0.z * age);
  };

  it('the bullet follows m + v0·a + ½·g·a² at every tick until it hits a constant-velocity target', () => {
    for (const id of ['A05', 'A10', 'A13']) {
      const s = rangeSetup(caseById(id), { fcs: 'wide', generator: 'capacity', legs: 'biped' }, 6);
      const rec = fireSingle(s);
      const bullet = s.sim.projectiles[0];
      const v0 = clone(bullet.v0);
      let maxDev = 0;
      let samples = 0;
      const out = flyOut(s.sim, s.target, 2.1, () => {
        if (!bullet.alive) return;
        const age = s.sim.time - rec.firedAt;
        maxDev = Math.max(maxDev, distance(bullet.pos, closedForm(rec, age)));
        expect(maxAbsDiff(bullet.vel, v3(v0.x, v0.y - 18 * age, v0.z))).toBeLessThan(1e-12);
        expect(bullet.v0).toEqual(v0);
        samples++;
      });
      expect(samples).toBeGreaterThan(100);
      expect(maxDev).toBeLessThan(1e-9);
      expect(out.hitTime).not.toBeNull();
      console.log(`[fcs] parabola ${id}: ${samples} ticks, max |pos − closed form| = ${maxDev.toExponential(2)} m`);
    }
  });

  it('a target that changes course after the shot is missed: the bullet flies on to the predicted point and expires', () => {
    const c = caseById('A05');
    const s = rangeSetup(c, { fcs: 'medium', generator: 'balanced', legs: 'biped' }, 5);
    const { sim, target } = s;
    const rec = fireSingle(s);
    const bullet = sim.projectiles[0];
    target.scriptedVel = v3(-8, 0, 0); // abrupt reversal right after the shot
    let maxDev = 0;
    let closest = Infinity;
    const out = flyOut(sim, target, 2.2, () => {
      if (!bullet.alive) return;
      const age = sim.time - rec.firedAt;
      maxDev = Math.max(maxDev, distance(bullet.pos, closedForm(rec, age)));
      closest = Math.min(closest, distance(bullet.pos, target.pos));
    });
    expect(maxDev).toBeLessThan(1e-9); // not bent towards the target
    expect(out.hitTime).toBeNull(); // no forced hit
    expect(target.hp).toBe(TARGET_HP);
    expect(out.expired).toBe(true); // removed at the end of its 2 s life
    expect(sim.projectiles.length).toBe(0);
    expect(closest).toBeGreaterThan(10);
    // it went exactly where the solution said the target would have been
    const t = rec.flightSeconds as number;
    expect(distance(closedForm(rec, t), rec.intercept as V3)).toBeLessThanOrEqual(0.01);
    console.log(`[fcs] no homing: closest approach to the turned target ${closest.toFixed(2)} m, bullet expired`);
  });

  it('losing the lock after the shot neither bends nor removes the bullet (it still hits the predicted point)', () => {
    const c = caseById('A06');
    const s = rangeSetup(c, { fcs: 'narrow', generator: 'balanced', legs: 'biped' }, 3);
    const { sim, target } = s;
    const rec = fireSingle(s);
    const bullet = sim.projectiles[0];
    sim.applyLook(0, 0.6); // look away (pitch only: the range muzzle stays put)
    sim.tick();
    expect(sim.lock.state).toBe('none');
    expectInactive(sim.fireControl, 'machinegun');
    let maxDev = 0;
    const out = flyOut(sim, target, 2.1, () => {
      if (bullet.alive) maxDev = Math.max(maxDev, distance(bullet.pos, closedForm(rec, sim.time - rec.firedAt)));
    });
    expect(maxDev).toBeLessThan(1e-9);
    expect(out.hitTime).not.toBeNull();
    expect(TARGET_HP - target.hp).toBe(MG.damage);
  });

  it('a beam at the line of sight stops the compensated parabola: the bullet is not lifted over it', () => {
    // A03 (100 m, static). The lock only needs the straight line to the current centre (y = 20); the
    // parabola rises 2.27 m above it at mid-range, where a slab hangs between y = 21.6 m and 26 m.
    const c = caseById('A03');
    const tFire = (1 + lockTicksOf({ fcs: 'medium', generator: 'balanced', legs: 'biped' }) + 2) * TICK;
    const slab: SolidDef = { min: v3(-10, 21.6, 49), max: v3(10, 26, 51), material: 'metal' };
    const stage = makeTestStage({
      floorSize: 10,
      floorY: 17.25,
      start: clone(RANGE_START),
      yaw: Math.PI,
      solids: [slab],
      enemies: [makeTarget('TGT', add(M, c.r), c.v)],
    });
    const sim = new Sim(stage);
    const target = sim.enemies[0];
    sim.applyLook(0, Math.atan2(20 - 22.15, 100.85));
    sim.runFor(tFire - TICK);
    expect(sim.lock.state).toBe('locked'); // straight line camera/muzzle → centre is free
    expect(sim.world.segmentBlocked(sim.player.muzzle, target.pos)).toBe(false);
    sim.input.fire = true;
    sim.tick();
    sim.input.fire = false;
    const rec = sim.shots[0];
    expect(rec.solutionStatus).toBe('solved'); // the status does not know about the obstacle
    const out = flyOut(sim, target, 2.1);
    expect(out.hitTime).toBeNull();
    expect(out.worldHits).toBe(1); // stopped by the slab
    expect(out.expired).toBe(false);
    expect(target.hp).toBe(TARGET_HP);
    expect(sim.projectiles.length).toBe(0);
  });
});

// ───────────────────────────── no solution ─────────────────────────────

describe('no in-lifetime solution: the lock stays, status = no_solution, direct aim', () => {
  // 119 m away and receding at 60 m/s at the firing instant: the 100 m/s bullet would need ≈ 3 s (> 2 s).
  const c: RangeCase = { id: 'NS', r: v3(0, 0, 119), v: v3(0, 0, 60) };
  const loadout: Loadout = { fcs: 'narrow', generator: 'balanced', legs: 'biped' };

  it('machine gun: fires straight at the current centre, consumes one round, keeps the lock', () => {
    const s = rangeSetup(c, loadout, 0);
    const { sim, target } = s;
    const rec = fireSingle(s);
    expect(solveGravityIntercept(M, s.pFire, c.v, 100, 18, 2)).toBeNull(); // really no root within the life

    expect(sim.lock.state).toBe('locked');
    expect(sim.lock.progress).toBe(1);
    expect(sim.lock.targetId).toBe('TGT');
    expect(rec.solutionStatus).toBe('no_solution');
    expect(rec.targetId).toBe('TGT');
    expect(maxAbsDiff(rec.targetPosAtFire as V3, s.pFire)).toBeLessThan(1e-6);
    expect(rec.targetVelAtFire).toEqual(c.v);
    expect(rec.flightSeconds).toBeNull();
    expect(rec.intercept).toBeNull();
    const direct = normalize(sub(rec.targetPosAtFire as V3, rec.muzzle));
    expect(maxAbsDiff(rec.launchDir, direct)).toBeLessThan(1e-12);
    expect(maxAbsDiff(rec.initialVelocity as V3, scale(direct, 100))).toBeLessThan(1e-12);
    expect(Math.abs(length(rec.initialVelocity as V3) - 100)).toBeLessThanOrEqual(1e-3); // no speed-up
    expect(rec.accelerationAtFire).toEqual(v3(0, -18, 0)); // gravity unchanged
    expect(sim.player.ammo.machinegun).toBe(MG.ammo - 1);
    expect(sim.projectiles.length).toBe(1);
    expect(sim.projectiles[0].lifeSeconds).toBe(2); // life not extended

    const fc = sim.fireControl;
    expect(fc.status).toBe('no_solution');
    expect(fc.weapon).toBe('machinegun');
    expect(fc.targetId).toBe('TGT');
    expect(fc.evaluatedAt).toBe(rec.firedAt);
    expect(fc.muzzle).toEqual(sim.player.muzzle);
    expect(fc.targetPos).toEqual(target.pos);
    expect(fc.targetVel).toEqual(c.v);
    expect(fc.launchDir).toEqual(rec.launchDir);
    expect(fc.aimPoint).toEqual(target.pos);
    expect(fc.flightSeconds).toBeNull();
    expect(fc.intercept).toBeNull();
    expect(fc.residual).toBeNull();
    expect(sim.aim.mode).toBe('fcs');
    expect(sim.aim.dir).toEqual(rec.launchDir);

    // 119.5 m and 120 m: still a valid target without a solution; beyond 120 m everything is dropped
    sim.tick();
    expect(sim.lock.state).toBe('locked');
    expect(sim.fireControl.status).toBe('no_solution');
    sim.tick();
    expect(distance(sim.player.muzzle, target.pos)).toBeCloseTo(120, 9);
    expect(sim.lock.state).toBe('locked');
    sim.tick();
    expect(sim.lock.state).toBe('none');
    expect(sim.lock.progress).toBe(0);
    expectInactive(sim.fireControl, 'machinegun');
    expect(sim.aim.mode).toBe('free');

    // the bullet is a normal bullet: it cannot catch the target and expires after 2 s
    const out = flyOut(sim, target, 2.1);
    expect(out.hitTime).toBeNull();
    expect(out.expired).toBe(true);
    expectFiniteState(sim);
  });

  it('missile: a locked target without a 45 m/s lead solution is still launched at, towards its current position', () => {
    const s = rangeSetup(c, loadout, 0, { weapon: 'missile' });
    const { sim } = s;
    const rec = fireSingle(s);
    expect(solveLinearIntercept(M, s.pFire, c.v, 45, 4)).toBeNull();
    expect(rec.weapon).toBe('missile');
    expect(rec.solutionStatus).toBe('no_solution');
    expect(maxAbsDiff(rec.launchDir, normalize(sub(rec.targetPosAtFire as V3, rec.muzzle)))).toBeLessThan(1e-12);
    expect(Math.abs(length(rec.initialVelocity as V3) - 45)).toBeLessThan(1e-9);
    expect(rec.flightSeconds).toBeNull();
    expect(rec.intercept).toBeNull();
    expect(sim.player.ammo.missile).toBe(MSL.ammo - 1);
    expect(sim.projectiles.length).toBe(1);
    expect(sim.projectiles[0].targetId).toBe('TGT');
    expect(sim.fireControl.status).toBe('no_solution');
    expect(sim.lock.state).toBe('locked');
  });

  it('beam: always solved for a locked target (flight time 0), even where the other weapons have no solution', () => {
    const s = rangeSetup(c, loadout, 0, { weapon: 'beam' });
    const rec = fireSingle(s);
    expect(rec.solutionStatus).toBe('solved');
    expect(rec.flightSeconds).toBe(0);
    expect(TARGET_HP - s.target.hp).toBe(BEAM.damage);
  });
});

// ───────────────────────────── lock state machine ─────────────────────────────

/** Flat test floor, mech at the origin looking along −Z (yaw 0). */
function lockSim(enemies: EnemyDef[], opts: { loadout?: Loadout; solids?: SolidDef[]; viewport?: Viewport } = {}): Sim {
  return new Sim(makeTestStage({ enemies, solids: opts.solids }), { loadout: opts.loadout, viewport: opts.viewport });
}
/** Muzzle and camera of that mech (identical for every loadout; read from a real Sim). */
const BASE = (() => {
  const sim = lockSim([]);
  sim.tick();
  return { muzzle: clone(sim.player.muzzle), camera: clone(sim.camera.pos) };
})();
/** A point in front of the mech: `right` / `up` metres off the muzzle, `ahead` metres along −Z from it. */
const ahead = (ahead_: number, right = 0, up = 0): V3 => v3(BASE.muzzle.x + right, BASE.muzzle.y + up, BASE.muzzle.z - ahead_);

function pxFromCentre(sim: Sim, p: V3): number {
  const sp: ScreenPoint = { x: 0, y: 0, depth: 0 };
  projectToViewport(sim.camera, sim.viewport, p, sp);
  return Math.hypot(sp.x - sim.viewport.width / 2, sp.y - sim.viewport.height / 2);
}

describe('lock: time, radius and viewport', () => {
  it('the mech used by these tests has the documented muzzle and camera', () => {
    expect(maxAbsDiff(BASE.muzzle, v3(0.9, 2.751, -0.85))).toBeLessThan(1e-12);
    expect(maxAbsDiff(BASE.camera, v3(0, 4.901, 9.5))).toBeLessThan(1e-12);
  });

  it('progress runs 0 → 1 in exactly lockSeconds for all 18 loadouts (4 legs medium ≈ 0.5333 s)', () => {
    const lines: string[] = ['[fcs] lock time | loadout | spec [s] | measured [s] | radius factor'];
    for (const loadout of ALL_LOADOUTS) {
      const want = FCS_PARTS[loadout.fcs].lockSeconds / LEGS_PARTS[loadout.legs].lockSpeedMult;
      const sim = lockSim([makeTarget('T', ahead(50))], { loadout });
      expect(sim.stats.lockSeconds).toBeCloseTo(want, 12);
      expect(sim.stats.maxEn).toBe(GENERATOR_PARTS[loadout.generator].maxEn);
      const n = lockTicksOf(loadout);
      expect(n * TICK).toBeCloseTo(want, 12);

      // The target satisfies every condition from the first instant of the sortie: it is picked at t = 0 with
      // progress 0, and the time it has continuously qualified is counted from there (SPEC §5).
      expect(sim.time).toBe(0);
      const tAcquired = sim.time;
      expect(sim.lock.state).toBe('acquiring');
      expect(sim.lock.targetId).toBe('T');
      expect(sim.lock.progress).toBe(0);
      expect(sim.lock.heldSeconds).toBe(0);
      expectInactive(sim.fireControl, 'machinegun');
      let prev = 0;
      for (let k = 1; k < n; k++) {
        sim.tick();
        expect(sim.lock.state).toBe('acquiring');
        expect(sim.lock.progress).toBeGreaterThan(prev);
        expect(sim.lock.progress).toBeCloseTo(k / n, 9);
        expect(sim.lock.progress).toBeLessThan(1);
        expectInactive(sim.fireControl, 'machinegun'); // never "solved" before the lock is complete
        prev = sim.lock.progress;
      }
      sim.tick();
      expect(sim.lock.state).toBe('locked');
      expect(sim.lock.progress).toBe(1);
      const measured = sim.time - tAcquired;
      expect(measured).toBeCloseTo(want, 12);
      expect(sim.time).toBeCloseTo(want, 12); // = seconds since the sortie began, not one tick more
      expect(sim.fireControl.status).toBe('solved');
      sim.runFor(1);
      expect(sim.lock.state).toBe('locked');
      expect(sim.lock.progress).toBe(1);
      lines.push(
        `[fcs] ${loadoutName(loadout).padEnd(27)} | ${want.toFixed(6)} | ${measured.toFixed(6)} | ${FCS_PARTS[loadout.fcs].radiusFactor}`,
      );
    }
    console.log(lines.join('\n'));
    const quadMedium = computeEffectiveStats({ fcs: 'medium', generator: 'balanced', legs: 'quadruped' }).lockSeconds;
    expect(quadMedium).toBeCloseTo(0.8 / 1.5, 12);
    expect(quadMedium).toBeCloseTo(0.5333, 4);
  });

  it('lock radius × lock speed is the same for the three FCS parts (inverse proportionality)', () => {
    const k = FCS_IDS.map((id) => FCS_PARTS[id].radiusFactor / FCS_PARTS[id].lockSeconds);
    expect(k[0]).toBeCloseTo(k[1], 12);
    expect(k[1]).toBeCloseTo(k[2], 12);
    expect(FCS_IDS.map((id) => FCS_PARTS[id].radiusFactor)).toEqual([0.3, 0.2, 0.1]);
    expect(FCS_IDS.map((id) => FCS_PARTS[id].lockSeconds)).toEqual([1.2, 0.8, 0.4]);
  });

  it('a lock time that is not a multiple of the tick still completes exactly on time (event-aligned sub-step)', () => {
    const sim = lockSim([makeTarget('T', ahead(50))]);
    sim.stats.lockSeconds = 0.123; // 14.76 ticks
    sim.input.weaponSelect = 'missile';
    sim.input.fire = true; // the missile leaves at the instant the lock completes
    sim.runFor(0.5);
    expect(sim.shots.length).toBe(1);
    expect(sim.shots[0].firedAt).toBeCloseTo(0.123, 12); // in the circle from t = 0 → complete at 0.123 s
    expect(sim.lock.state).toBe('locked');
  });

  it('the lock is judged at t = 0: in the circle from the first instant → locked exactly lockSeconds after the sortie began', () => {
    const lines: string[] = ['[fcs] lock from t = 0 | FCS/legs | spec [s] | missile leaves at [s] (tick-by-tick / 30 / 60 / 144 fps)'];
    for (const fcs of FCS_IDS) {
      for (const legs of LEG_IDS) {
        const loadout: Loadout = { fcs, generator: 'balanced', legs };
        const want = FCS_PARTS[fcs].lockSeconds / LEGS_PARTS[legs].lockSpeedMult;
        const measured: number[] = [];
        for (const fps of [120, 30, 60, 144]) {
          const sim = lockSim([makeTarget('T', ahead(60))], { loadout });
          // the very first state of the sortie already carries the acquisition, with nothing counted yet
          const snap0 = buildSnapshot(sim, 'playing');
          expect(snap0.elapsedSeconds).toBe(0);
          expect(snap0.lock).toEqual({ state: 'acquiring', targetId: 'T', progress: 0, radiusCssPx: FCS_PARTS[fcs].radiusFactor * 720 });
          expect(sim.lock.heldSeconds).toBe(0);
          expect(snap0.fireControl.status).toBe('inactive');
          sim.input.weaponSelect = 'missile';
          sim.input.fire = true; // refused until the lock is complete, launched at that very instant
          const frames = Math.ceil((want + 0.2) * fps);
          for (let f = 0; f < frames; f++) sim.advance(1 / fps);
          expect(sim.shots.length, `${fcs}/${legs} ${fps} fps`).toBe(1);
          expect(sim.shots[0].firedAt, `${fcs}/${legs} ${fps} fps`).toBeCloseTo(want, 12); // not want + 1/120
          measured.push(sim.shots[0].firedAt);
        }
        lines.push(`[fcs] ${`${fcs}/${legs}`.padEnd(16)} | ${want.toFixed(6)} | ${measured.map((m) => m.toFixed(6)).join(' / ')}`);
      }
    }
    console.log(lines.join('\n'));

    // Nothing qualifies at t = 0 → no target, no progress. The acquisition then starts at the end of the
    // sub-step in which the target is first seen inside the circle, and still takes the full lock time.
    const sim = lockSim([makeTarget('T', ahead(50, 13.5))]); // just outside the 144 px circle
    expect(sim.lock).toEqual({ state: 'none', targetId: null, progress: 0, heldSeconds: 0, radiusCssPx: 144 });
    sim.runFor(0.25);
    expect(sim.lock.state).toBe('none');
    sim.applyLook(-Math.atan2(13.5, 50), 0); // turn right, towards it
    sim.tick();
    const tSeen = sim.time;
    expect(sim.lock.state).toBe('acquiring');
    expect(sim.lock.progress).toBe(0);
    sim.runFor(sim.stats.lockSeconds - TICK);
    expect(sim.lock.state).toBe('acquiring');
    sim.tick();
    expect(sim.lock.state).toBe('locked');
    expect(sim.time - tSeen).toBeCloseTo(sim.stats.lockSeconds, 12);
  });

  it('radius = factor × min(width, height) in CSS px and follows sim.setViewport', () => {
    const sizes: Array<[number, number]> = [
      [1280, 720],
      [1920, 1080],
      [800, 600],
      [600, 1000],
      [1000, 1000],
      [2560, 1080],
    ];
    for (const fcs of FCS_IDS) {
      const sim = lockSim([], { loadout: { fcs, generator: 'balanced', legs: 'biped' } });
      const f = FCS_PARTS[fcs].radiusFactor;
      expect(sim.lock.radiusCssPx).toBe(f * 720);
      for (const [w, h] of sizes) {
        sim.setViewport(w, h);
        expect(sim.lock.radiusCssPx).toBe(f * Math.min(w, h));
        expect(lockRadiusCssPx(sim)).toBe(f * Math.min(w, h));
        sim.tick();
        expect(sim.lock.radiusCssPx).toBe(f * Math.min(w, h));
      }
      // even a viewport changed behind the sim's back is picked up by the next update
      sim.viewport = { width: 1111, height: 333 };
      sim.tick();
      expect(sim.lock.radiusCssPx).toBe(f * 333);
    }
    const constructed = lockSim([], { viewport: { width: 1024, height: 768 }, loadout: { fcs: 'wide', generator: 'balanced', legs: 'biped' } });
    expect(constructed.lock.radiusCssPx).toBe(0.3 * 768);
  });

  it('the judged circle is the displayed circle: a target is a candidate exactly when its projected centre is inside', () => {
    // 12.9 m off the camera axis at 60 m depth: ≈135 px from the centre on 1280×720 (radius 144),
    // ≈188 px on 600×1000 (radius 120)
    const sim = lockSim([makeTarget('T', ahead(50, 12))]);
    const t = sim.enemies[0];
    sim.tick();
    const d720 = pxFromCentre(sim, t.pos);
    expect(d720).toBeLessThan(sim.lock.radiusCssPx);
    expect(lockCandidateDistancePx(sim, t)).toBeCloseTo(d720, 9);
    expect(sim.lock.targetId).toBe('T');
    sim.runFor(0.4);
    expect(sim.lock.progress).toBeGreaterThan(0.4);

    // The resize itself re-judges the lock against the new circle: no tick is needed (and none runs here).
    const tResize = sim.time;
    sim.setViewport(600, 1000);
    expect(sim.time).toBe(tResize);
    expect(sim.lock.radiusCssPx).toBe(120);
    expect(pxFromCentre(sim, t.pos)).toBeGreaterThan(120);
    expect(lockCandidateDistancePx(sim, t)).toBe(-1);
    expect(sim.lock.state).toBe('none'); // dropped at once by the resize
    expect(sim.lock.targetId).toBeNull();
    expect(sim.lock.progress).toBe(0);
    sim.tick();
    expect(sim.lock.state).toBe('none');
    expect(sim.lock.progress).toBe(0);

    const tBack = sim.time;
    sim.setViewport(1280, 720);
    expect(sim.time).toBe(tBack);
    expect(sim.lock.state).toBe('acquiring'); // inside the displayed circle again: a new acquisition …
    expect(sim.lock.targetId).toBe('T');
    expect(sim.lock.progress).toBe(0); // … from zero
    expect(sim.lock.heldSeconds).toBe(0);
    sim.tick();
    expect(sim.lock.progress).toBeCloseTo(TICK / sim.stats.lockSeconds, 12); // only simulated time counts
    sim.runFor(sim.stats.lockSeconds - TICK);
    expect(sim.lock.state).toBe('locked');
    expect(sim.time - tBack).toBeCloseTo(sim.stats.lockSeconds, 12); // exactly lockSeconds after the resize
  });

  /**
   * A point that projects `px` CSS pixels right of the centre of a 720 px high display, `depth` metres in
   * front of the camera of the standing mech (the pixel offset scales with the display height only).
   */
  const rightOfCentre = (px: number, depth = 70): V3 =>
    v3(BASE.camera.x + (px / 360) * Math.tan((CAMERA.fovYDeg * DEG) / 2) * depth, BASE.camera.y, BASE.camera.z - depth);
  /** Everything a paused game must not change (the lock and the fire-control value are checked separately). */
  const frozenState = (sim: Sim): string =>
    JSON.stringify({
      time: sim.time,
      tickIndex: sim.tickIndex,
      status: sim.status,
      player: sim.player,
      enemies: sim.enemies,
      projectiles: sim.projectiles,
      shots: sim.shots,
      nextShotId: sim.nextShotId,
      events: sim.events.length,
    });

  it('a resize while no tick runs (paused app) never leaves a lock on a target outside the displayed circle', () => {
    // 130 px from the centre: inside R = 144 px on 1280×720, outside R = 120 px on 600×720 (medium FCS).
    const sim = lockSim([makeTarget('T', rightOfCentre(130))]);
    const t = sim.enemies[0];
    sim.runFor(1);
    expect(pxFromCentre(sim, t.pos)).toBeCloseTo(130, 6);
    expect(sim.lock.state).toBe('locked');
    expect(sim.fireControl.status).toBe('solved');
    expect(sim.aim.mode).toBe('fcs');

    // ── paused from here on: nothing calls tick() / advance() ──
    const before = frozenState(sim);
    sim.setViewport(600, 720);
    let snap = buildSnapshot(sim, 'paused');
    expect(pxFromCentre(sim, t.pos)).toBeCloseTo(130, 6); // still 130 px: now outside the 120 px circle
    expect(snap.lock).toEqual({ state: 'none', targetId: null, progress: 0, radiusCssPx: 120 });
    expect(sim.lock.heldSeconds).toBe(0);
    expectInactive(sim.fireControl, 'machinegun'); // the solution of the dropped target went with it
    expect(snap.fireControl.status).toBe('inactive');
    expect(snap.fireControl.targetId).toBeNull();
    expect(snap.fireControl.launchDirection).toBeNull();
    expect(snap.fireControl.aimPoint).toBeNull();
    expect(sim.aim.mode).toBe('free');
    expect(frozenState(sim)).toBe(before); // no time, no motion, no shot, no event

    // Back inside the displayed circle, still paused: a NEW acquisition from zero — and however often the
    // window is resized, a paused game never advances it.
    sim.setViewport(1280, 720);
    for (let i = 0; i < 25; i++) {
      sim.setViewport(1279 - i, 720);
      sim.setViewport(1280, 720);
    }
    snap = buildSnapshot(sim, 'paused');
    expect(snap.lock).toEqual({ state: 'acquiring', targetId: 'T', progress: 0, radiusCssPx: 144 });
    expect(sim.lock.heldSeconds).toBe(0);
    expectInactive(sim.fireControl, 'machinegun');
    expect(frozenState(sim)).toBe(before);

    // ── resumed: the whole lock time is required again, counted in simulated time only ──
    const tResume = sim.time;
    sim.runFor(sim.stats.lockSeconds - TICK);
    expect(sim.lock.state).toBe('acquiring');
    sim.tick();
    expect(sim.lock.state).toBe('locked');
    expect(sim.time - tResume).toBeCloseTo(0.8, 12);

    // A resize that keeps the target inside the circle leaves a completed lock and its solution untouched
    // (no new lock time, no time passing) …
    const held = sim.lock.heldSeconds;
    const solution = JSON.stringify(sim.fireControl);
    const playing = frozenState(sim);
    for (const [w, h] of [[1280, 600], [1920, 1080], [1000, 1000], [3000, 640]] as Array<[number, number]>) {
      sim.setViewport(w, h);
      expect(sim.lock.radiusCssPx).toBe(0.2 * Math.min(w, h));
      expect(pxFromCentre(sim, t.pos), `${w}x${h}`).toBeLessThan(sim.lock.radiusCssPx);
      expect(sim.lock.state, `${w}x${h}`).toBe('locked');
      expect(sim.lock.targetId).toBe('T');
      expect(sim.lock.progress).toBe(1);
      expect(sim.lock.heldSeconds).toBe(held);
      expect(JSON.stringify(sim.fireControl)).toBe(solution);
      expect(frozenState(sim)).toBe(playing);
    }
    // … and a portrait window, in which the same point is 130 × 3000 / 720 ≈ 542 px out, drops it at once.
    sim.setViewport(640, 3000);
    expect(pxFromCentre(sim, t.pos)).toBeGreaterThan(540);
    expect(buildSnapshot(sim, 'paused').lock).toEqual({ state: 'none', targetId: null, progress: 0, radiusCssPx: 128 });
    expectInactive(sim.fireControl, 'machinegun');
  });

  it('a finished sortie stays frozen: a resize after the result only changes the displayed radius', () => {
    const sim = lockSim([makeTarget('T', rightOfCentre(130))]);
    sim.runFor(1);
    expect(sim.lock.state).toBe('locked');
    sim.damagePlayer(sim.player.hp, v3(0, 0, 0), null);
    sim.tick();
    expect(sim.status).toBe('failed');
    const lock = { ...sim.lock };
    const solution = JSON.stringify(sim.fireControl);
    expect(lock.state).toBe('locked');
    sim.setViewport(600, 720);
    expect(sim.lock).toEqual({ ...lock, radiusCssPx: 120 });
    expect(JSON.stringify(sim.fireControl)).toBe(solution);
  });
});

describe('lock: candidate conditions', () => {
  const medium: Loadout = { fcs: 'medium', generator: 'balanced', legs: 'biped' };

  /** Runs 2 s and reports whether the single enemy was ever picked. */
  function everTargeted(sim: Sim): boolean {
    let seen = false;
    for (let i = 0; i < 240; i++) {
      sim.tick();
      if (sim.lock.targetId != null || sim.lock.state !== 'none' || sim.lock.progress !== 0) seen = true;
    }
    return seen;
  }

  it('control: a visible target inside the circle and inside 120 m is acquired and locked', () => {
    const sim = lockSim([makeTarget('T', ahead(50))], { loadout: medium });
    sim.tick();
    expect(lockCandidateDistancePx(sim, sim.enemies[0])).toBeGreaterThanOrEqual(0);
    sim.runFor(1);
    expect(sim.lock.state).toBe('locked');
  });

  it('outside the circle → never a candidate', () => {
    const sim = lockSim([makeTarget('T', ahead(50, 13.5))], { loadout: medium });
    sim.tick();
    expect(pxFromCentre(sim, sim.enemies[0].pos)).toBeGreaterThan(144);
    expect(pxFromCentre(sim, sim.enemies[0].pos)).toBeLessThan(160); // just outside
    expect(lockCandidateDistancePx(sim, sim.enemies[0])).toBe(-1);
    expect(everTargeted(sim)).toBe(false);
  });

  it('behind the camera → never a candidate (even though it is close and unobstructed)', () => {
    const sim = lockSim([makeTarget('T', v3(BASE.camera.x, BASE.camera.y, BASE.camera.z + 30))], { loadout: medium });
    sim.tick();
    const t = sim.enemies[0];
    expect(distance(sim.player.muzzle, t.pos)).toBeLessThan(FCS_RANGE);
    expect(sim.world.segmentBlocked(sim.camera.pos, t.pos)).toBe(false);
    expect(lockCandidateDistancePx(sim, t)).toBe(-1);
    expect(everTargeted(sim)).toBe(false);
  });

  it('range is measured from the muzzle: 120 m is inside, beyond 120 m is not', () => {
    for (const [dist, ok] of [
      [119.5, true],
      [120, true],
      [120.001, false],
      [120.5, false],
      [150, false],
    ] as Array<[number, boolean]>) {
      const sim = lockSim([makeTarget('T', ahead(dist))], { loadout: medium });
      sim.tick();
      const t = sim.enemies[0];
      expect(distance(sim.player.muzzle, t.pos)).toBeCloseTo(dist, 9);
      expect(pxFromCentre(sim, t.pos)).toBeLessThan(40); // well inside the circle
      expect(lockCandidateDistancePx(sim, t) >= 0, `dist ${dist}`).toBe(ok);
      expect(everTargeted(sim), `dist ${dist}`).toBe(ok);
    }
    expect(FCS_RANGE).toBe(120);
    // more than 130 m from the camera but less than 120 m from the muzzle: the muzzle distance decides
    const sim = lockSim([makeTarget('T', v3(BASE.camera.x, BASE.camera.y, BASE.camera.z - 130.2))], { loadout: medium });
    sim.tick();
    const t = sim.enemies[0];
    expect(distance(sim.player.muzzle, t.pos)).toBeLessThan(120);
    expect(distance(sim.camera.pos, t.pos)).toBeGreaterThan(130);
    expect(lockCandidateDistancePx(sim, t)).toBeGreaterThanOrEqual(0);
  });

  it('the 120 m limit is exact to a nanometre: nothing beyond the rounding guard is ever acquired', () => {
    // The guard of the inclusive limit is one nanometre (it used to be a micrometre, which let targets up to
    // 120.000001 m be locked). Static targets on the muzzle axis, wide FCS, 1.5 s (> the 1.2 s lock time).
    expect(FCS_RANGE_TOLERANCE).toBe(1e-9);
    const wide: Loadout = { fcs: 'wide', generator: 'balanced', legs: 'biped' };
    const placements: Array<[number, boolean]> = [
      [-1e-6, true],
      [-1e-9, true],
      [0, true],
      [2e-9, false], // two nanometres too far
      [1e-8, false],
      [5e-7, false],
      [9.9e-7, false],
      [1.1e-6, false],
      [1e-5, false],
    ];
    for (const [beyond, ok] of placements) {
      const sim = lockSim([makeTarget('T', ahead(120 + beyond))], { loadout: wide });
      const t = sim.enemies[0];
      const d = distance(sim.player.muzzle, t.pos);
      expect(Math.abs(d - (120 + beyond)), `placement ${beyond}`).toBeLessThan(1e-12); // the placement itself is exact enough
      if (beyond !== 0) expect(d > 120, `placement ${beyond}`).toBe(beyond > 0);
      expect(lockCandidateDistancePx(sim, t) >= 0, `120 m ${beyond >= 0 ? '+' : '−'} ${Math.abs(beyond)} m`).toBe(ok);
      sim.runFor(1.5);
      expect(distance(sim.player.muzzle, t.pos)).toBe(d); // neither the mech nor the target moved
      expect(sim.lock.state, `120 m ${beyond >= 0 ? '+' : '−'} ${Math.abs(beyond)} m`).toBe(ok ? 'locked' : 'none');
      expect(sim.lock.targetId).toBe(ok ? 'T' : null);
      expect(sim.fireControl.status).toBe(ok ? 'solved' : 'inactive');
      // … and the missile, which needs the lock, is refused for the target that is out of range
      sim.input.weaponSelect = 'missile';
      sim.input.fire = true;
      sim.runFor(0.1);
      expect(sim.shots.length, `missile at 120 m + ${beyond} m`).toBe(ok ? 1 : 0);
      expect(sim.player.ammo.missile).toBe(ok ? MSL.ammo - 1 : MSL.ammo);
    }
  });

  it('a target that is at exactly 120 m when the shot is due keeps its lock whichever way its accumulated position was rounded', () => {
    // Why the limit has a rounding guard at all. The target recedes along the line of fire and is, in exact
    // arithmetic, at |r| = 120 m at the firing instant (as in SPEC §4.6 A04 / A13) and 6 cm beyond it one tick
    // later. Its real position is the sum of a few hundred rounded steps `pos += vel·h`, so the distance the
    // simulation holds at that instant differs from 120 by rounding noise — here always to the far side.
    const c: RangeCase = { id: 'R120', r: v3(0, 0, 120), v: v3(0, 0, 7.3) };
    let shots = 0;
    let hits = 0;
    let beyond = 0;
    let maxNoise = 0;
    for (let rep = 0; rep < 12; rep++) {
      const loadout = ALL_LOADOUTS[(rep * 5) % ALL_LOADOUTS.length];
      const s = rangeSetup(c, loadout, EXTRA_TICKS[rep]);
      const { sim, target } = s;
      const label = `R120 rep ${rep} ${loadoutName(loadout)}`;
      const rec = fireSingle(s);
      shots++;
      const noise = distance(rec.muzzle, rec.targetPosAtFire as V3) - 120;
      if (noise > 0) beyond++;
      maxNoise = Math.max(maxNoise, Math.abs(noise));
      expect(Math.abs(noise), label).toBeLessThan(FCS_RANGE_TOLERANCE / 10); // rounding noise only, far below the guard
      expect(sim.lock.state, label).toBe('locked');
      expect(rec.solutionStatus, label).toBe('solved');
      expect(rec.targetId).toBe('TGT');
      expect(recordResidual(rec)).toBeLessThanOrEqual(0.01);

      // one tick later the target really is out of range: lock and solution are dropped at once
      let first = true;
      const out = flyOut(sim, target, 2.25, () => {
        if (!first) return;
        first = false;
        expect(distance(sim.player.muzzle, target.pos), label).toBeGreaterThan(120.05);
        expect(sim.lock.state, label).toBe('none');
        expect(sim.lock.progress).toBe(0);
        expectInactive(sim.fireControl, 'machinegun');
      });
      // the bullet that was fired with the compensated solution still hits (it is not guided)
      expect(out.hitTime, label).not.toBeNull();
      if (out.hitTime != null) hits++;
      expect(out.damageEvents).toBe(1);
    }
    console.log(
      `[fcs] 120 m boundary: ${hits}/${shots} hits; accumulated position beyond 120 m in ${beyond}/${shots} shots, max |range − 120| = ${maxNoise.toExponential(2)} m (guard ${FCS_RANGE_TOLERANCE} m)`,
    );
    expect(hits).toBe(shots);
    // Without a guard every one of these locks would have been lost in the sub-step of the shot.
    expect(beyond).toBeGreaterThan(0);
  });

  it('a wall between the camera and the centre blocks the lock even if the muzzle sees the target', () => {
    const high: SolidDef = { min: v3(-6, 3.6, -5.2), max: v3(6, 9, -5), material: 'wall' };
    const sim = lockSim([makeTarget('T', ahead(50))], { loadout: medium, solids: [high] });
    sim.tick();
    const t = sim.enemies[0];
    expect(sim.world.segmentBlocked(sim.camera.pos, t.pos)).toBe(true);
    expect(sim.world.segmentBlocked(sim.player.muzzle, t.pos)).toBe(false);
    expect(lockCandidateDistancePx(sim, t)).toBe(-1);
    expect(everTargeted(sim)).toBe(false);
  });

  it('a wall between the muzzle and the centre blocks the lock even if the camera sees the target', () => {
    const low: SolidDef = { min: v3(-6, 0, -5.2), max: v3(6, 3.2, -5), material: 'wall' };
    const sim = lockSim([makeTarget('T', ahead(50))], { loadout: medium, solids: [low] });
    sim.tick();
    const t = sim.enemies[0];
    expect(sim.world.segmentBlocked(sim.camera.pos, t.pos)).toBe(false);
    expect(sim.world.segmentBlocked(sim.player.muzzle, t.pos)).toBe(true);
    expect(lockCandidateDistancePx(sim, t)).toBe(-1);
    expect(everTargeted(sim)).toBe(false);
  });

  it('a full wall blocks it, and a destroyed enemy is not a candidate', () => {
    const wall: SolidDef = { min: v3(-6, 0, -5.2), max: v3(6, 9, -5), material: 'wall' };
    const sim = lockSim([makeTarget('T', ahead(50))], { loadout: medium, solids: [wall] });
    expect(everTargeted(sim)).toBe(false);

    const sim2 = lockSim([makeTarget('T', ahead(50))], { loadout: medium });
    sim2.damageEnemy(sim2.enemies[0], sim2.enemies[0].hp);
    expect(sim2.enemies[0].alive).toBe(false);
    expect(lockCandidateDistancePx(sim2, sim2.enemies[0])).toBe(-1);
    expect(everTargeted(sim2)).toBe(false);
  });
});

describe('lock: selection, stickiness, drop and restart', () => {
  const medium: Loadout = { fcs: 'medium', generator: 'balanced', legs: 'biped' };
  const wide: Loadout = { fcs: 'wide', generator: 'balanced', legs: 'biped' };

  it('picks the candidate nearest to the screen centre, whatever the order or the distance', () => {
    const defs = [makeTarget('A', ahead(30, 6)), makeTarget('B', ahead(90, -5)), makeTarget('C', ahead(60, -0.9))];
    for (const order of [
      [0, 1, 2],
      [2, 1, 0],
      [1, 2, 0],
    ]) {
      const sim = lockSim(order.map((i) => defs[i]), { loadout: wide });
      sim.tick();
      const px = sim.enemies.map((e) => ({ id: e.id, d: lockCandidateDistancePx(sim, e) }));
      for (const p of px) expect(p.d).toBeGreaterThanOrEqual(0);
      const nearest = px.reduce((a, b) => (b.d < a.d ? b : a));
      expect(nearest.id).toBe('C');
      expect(sim.lock.targetId).toBe('C');
    }
  });

  it('equal distance from the centre → stable id order', () => {
    // Both exactly on the camera-centre ray: both project to the exact centre (0 px).
    const onRay = (id: string, depth: number): EnemyDef => makeTarget(id, v3(BASE.camera.x, BASE.camera.y, BASE.camera.z - depth));
    for (const defs of [
      [onRay('B2', 50), onRay('A1', 90)],
      [onRay('A1', 90), onRay('B2', 50)],
      [onRay('T10', 50), onRay('T02', 70), onRay('T07', 90)],
    ]) {
      const sim = lockSim(defs, { loadout: wide });
      sim.tick();
      for (const e of sim.enemies) expect(lockCandidateDistancePx(sim, e)).toBe(0);
      const first = defs.map((d) => d.id).sort()[0];
      expect(sim.lock.targetId).toBe(first);
    }
  });

  it('sticky: another enemy passing closer to the centre does not steal the target', () => {
    const sim = lockSim([makeTarget('M', ahead(50, -12), v3(10, 0, 0)), makeTarget('S', ahead(50, 4))], { loadout: wide });
    const [m, s] = sim.enemies;
    let closerTicks = 0;
    let prevProgress = -1;
    for (let i = 0; i < 264; i++) {
      sim.tick();
      expect(sim.lock.targetId).toBe('S');
      expect(sim.lock.progress).toBeGreaterThanOrEqual(prevProgress);
      prevProgress = sim.lock.progress;
      const dm = lockCandidateDistancePx(sim, m);
      const ds = lockCandidateDistancePx(sim, s);
      expect(ds).toBeGreaterThanOrEqual(0);
      if (dm >= 0 && dm < ds) closerTicks++;
    }
    expect(closerTicks).toBeGreaterThan(60); // M really was the nearer candidate for a long while
    expect(sim.lock.state).toBe('locked');
    expect(sim.fireControl.targetId).toBe('S');
  });

  it('leaving the circle drops target and progress at once; coming back starts from 0 (acquiring and locked)', () => {
    const n = lockTicksOf(medium);
    for (const lockedFirst of [false, true]) {
      const sim = lockSim([makeTarget('T', ahead(50))], { loadout: medium });
      sim.runFor(lockedFirst ? 1.0 : 0.4);
      expect(sim.lock.state).toBe(lockedFirst ? 'locked' : 'acquiring');
      expect(sim.lock.progress).toBeGreaterThan(0.45);
      if (lockedFirst) expect(sim.fireControl.status).toBe('solved');

      sim.applyLook(0.5, 0); // 28.6° to the left: far outside the 13° circle
      sim.tick();
      expect(sim.lock.state).toBe('none');
      expect(sim.lock.targetId).toBeNull();
      expect(sim.lock.progress).toBe(0);
      expect(sim.lock.heldSeconds).toBe(0);
      expectInactive(sim.fireControl, 'machinegun'); // nothing of the old target is kept
      expect(sim.aim.mode).toBe('free');
      sim.runFor(0.3);
      expect(sim.lock.state).toBe('none');

      sim.applyLook(-0.5, 0);
      sim.tick();
      expect(sim.lock.state).toBe('acquiring');
      expect(sim.lock.progress).toBe(0);
      for (let k = 1; k < n; k++) sim.tick();
      expect(sim.lock.state).toBe('acquiring'); // the full lock time is needed again
      expect(sim.lock.progress).toBeCloseTo((n - 1) / n, 9);
      sim.tick();
      expect(sim.lock.state).toBe('locked');
    }
  });

  it('occlusion drops the lock at once; after the target reappears the lock starts from 0', () => {
    const pillar: SolidDef = { min: v3(1, 0, -30), max: v3(3, 12, -29), material: 'metal' };
    const sim = lockSim([makeTarget('T', v3(-6, BASE.muzzle.y, -50), v3(10, 0, 0))], { loadout: medium, solids: [pillar] });
    const t = sim.enemies[0];
    const n = lockTicksOf(medium);
    const visible = (): boolean => !sim.world.segmentBlocked(sim.camera.pos, t.pos) && !sim.world.segmentBlocked(sim.player.muzzle, t.pos);
    let phase: 'first' | 'hidden' | 'second' = 'first';
    let lastProgress = 0;
    let hiddenTicks = 0;
    let reacquiredTick = -1;
    for (let i = 1; i <= 228; i++) {
      sim.tick();
      const vis = visible();
      if (phase === 'first') {
        if (vis) {
          expect(sim.lock.targetId).toBe('T');
          lastProgress = sim.lock.progress;
        } else {
          phase = 'hidden';
        }
      }
      if (phase === 'hidden') {
        if (!vis) {
          hiddenTicks++;
          expect(sim.lock.state).toBe('none');
          expect(sim.lock.targetId).toBeNull();
          expect(sim.lock.progress).toBe(0);
          expectInactive(sim.fireControl, 'machinegun');
        } else {
          phase = 'second';
          reacquiredTick = i;
          expect(sim.lock.state).toBe('acquiring');
          expect(sim.lock.progress).toBe(0); // nothing carried over
        }
      }
      if (phase === 'second' && i === reacquiredTick + n - 1) expect(sim.lock.state).toBe('acquiring');
      if (phase === 'second' && i === reacquiredTick + n) expect(sim.lock.state).toBe('locked');
    }
    expect(lastProgress).toBeGreaterThan(0.8); // it was almost locked when the pillar got in the way
    expect(lastProgress).toBeLessThan(1);
    expect(hiddenTicks).toBeGreaterThan(30);
    expect(phase).toBe('second');
    expect(sim.lock.state).toBe('locked');
  });

  it('exceeding 120 m drops a completed lock at once', () => {
    const loadout: Loadout = { fcs: 'narrow', generator: 'balanced', legs: 'quadruped' };
    const sim = lockSim([makeTarget('T', ahead(110), v3(0, 0, -10))], { loadout });
    const t = sim.enemies[0];
    sim.runFor(0.5);
    expect(sim.lock.state).toBe('locked');
    for (let i = 60; i < 120; i++) {
      sim.tick();
      expect(sim.lock.state).toBe('locked');
    }
    expect(distance(sim.player.muzzle, t.pos)).toBeCloseTo(120, 9); // exactly on the boundary: still valid
    expect(sim.fireControl.status).toBe('solved');
    sim.tick();
    expect(distance(sim.player.muzzle, t.pos)).toBeGreaterThan(120.05);
    expect(sim.lock.state).toBe('none');
    expect(sim.lock.progress).toBe(0);
    expectInactive(sim.fireControl, 'machinegun');
  });

  it('a destroyed target is dropped at once and the next target starts from 0 (no progress inherited)', () => {
    const sim = lockSim([makeTarget('A', ahead(50)), makeTarget('B', ahead(60, 6)), makeTarget('C', ahead(70, -11))], { loadout: medium });
    const [a, b] = sim.enemies;
    const n = lockTicksOf(medium);
    sim.runFor(1.0);
    expect(sim.lock.state).toBe('locked');
    expect(sim.lock.targetId).toBe('A');
    const oldSolution = sim.fireControl;
    expect(oldSolution.targetId).toBe('A');

    sim.damageEnemy(a, a.hp);
    sim.tick();
    expect(sim.lock.targetId).toBe('B'); // nearest remaining candidate
    expect(sim.lock.state).toBe('acquiring');
    expect(sim.lock.progress).toBe(0);
    expect(sim.lock.heldSeconds).toBe(0);
    expectInactive(sim.fireControl, 'machinegun'); // not A's old numbers, not a premature solution for B
    for (let k = 1; k < n; k++) sim.tick();
    expect(sim.lock.state).toBe('acquiring');
    sim.tick();
    expect(sim.lock.state).toBe('locked');
    expect(sim.fireControl.targetId).toBe('B');
    expect(sim.fireControl.targetPos).toEqual(b.pos);
    expect(sim.fireControl.targetPos).not.toEqual(oldSolution.targetPos);
  });

  it('a target destroyed by the beam loses lock and solution in that very sub-step', () => {
    const sim = lockSim([makeTarget('T', ahead(50), v3(), 0.5, 40)], { loadout: medium });
    sim.input.weaponSelect = 'beam';
    sim.runFor(1.0);
    expect(sim.lock.state).toBe('locked');
    sim.input.fire = true;
    sim.tick();
    sim.input.fire = false;
    expect(sim.enemies[0].alive).toBe(false);
    expect(sim.shots.length).toBe(1);
    expect(sim.shots[0].solutionStatus).toBe('solved');
    expect(sim.lock.state).toBe('none');
    expect(sim.lock.targetId).toBeNull();
    expect(sim.lock.progress).toBe(0);
    expectInactive(sim.fireControl, 'beam');
  });

  it('switching weapons never touches target or progress, and needs no new lock time', () => {
    const n = lockTicksOf(medium);
    const sim = lockSim([makeTarget('T', ahead(60, 3), v3(-2, 0, 0))], { loadout: medium });
    const order: Weapon[] = ['beam', 'missile', 'machinegun', 'missile', 'beam', 'machinegun'];
    expect(sim.lock.state).toBe('acquiring'); // in the circle from t = 0
    expect(sim.lock.progress).toBe(0);
    for (let k = 1; k <= n; k++) {
      if (k % 9 === 0) sim.input.weaponSelect = order[(k / 9) % order.length];
      sim.tick();
      expect(sim.input.weaponSelect).toBeNull(); // the edge was consumed
      expect(sim.lock.targetId).toBe('T');
      if (k < n) {
        expect(sim.lock.state).toBe('acquiring');
        expect(sim.lock.progress).toBeCloseTo(k / n, 9);
        expectInactive(sim.fireControl, sim.player.weapon);
      }
    }
    expect(sim.lock.state).toBe('locked'); // at exactly the same tick as without any switching
    expect(sim.player.weapon).not.toBe('machinegun');

    for (const w of ['machinegun', 'beam', 'missile', 'machinegun'] as Weapon[]) {
      sim.input.weaponSelect = w;
      sim.tick();
      expect(sim.player.weapon).toBe(w);
      expect(sim.lock.state).toBe('locked');
      expect(sim.lock.progress).toBe(1);
      const fc = sim.fireControl; // already the new weapon's own solution for this instant
      expect(fc.weapon).toBe(w);
      expect(fc.status).toBe('solved');
      expect(fc.evaluatedAt as number).toBeCloseTo(sim.time, 12);
      expect(fc.targetPos).toEqual(sim.enemies[0].pos);
      if (w === 'beam') {
        expect(fc.flightSeconds).toBe(0);
        expect(fc.aimPoint).toEqual(fc.targetPos);
      } else if (w === 'missile') {
        const lead = solveLinearIntercept(sim.player.muzzle, sim.enemies[0].pos, sim.enemies[0].vel, 45, 4);
        expect(fc.launchDir).toEqual(lead ? lead.dir : null);
      } else {
        const g = solveGravityIntercept(sim.player.muzzle, sim.enemies[0].pos, sim.enemies[0].vel, 100, 18, 2);
        expect(fc.launchDir).toEqual(g ? g.dir : null);
      }
    }
  });

  it('the first shot after a weapon switch uses the new weapon\'s solution of that instant', () => {
    const c = caseById('A05');
    const s = rangeSetup(c, medium, 4);
    const { sim, target } = s;
    for (let i = 0; i < s.nFire - 1; i++) sim.tick();
    expect(sim.fireControl.weapon).toBe('machinegun');
    expect(sim.fireControl.status).toBe('solved');
    sim.input.weaponSelect = 'beam'; // switch and pull the trigger in the same frame
    sim.input.fire = true;
    sim.tick();
    sim.input.fire = false;
    const rec = sim.shots[0];
    expect(rec.weapon).toBe('beam');
    expect(rec.solutionStatus).toBe('solved');
    expect(maxAbsDiff(rec.launchDir, normalize(sub(target.pos, sim.player.muzzle)))).toBeLessThan(1e-12);
    expect(TARGET_HP - target.hp).toBe(BEAM.damage); // not aimed at the machine gun's lead point
    expect(sim.lock.state).toBe('locked');
  });
});

describe('lock is judged by the current centre only — never by the intercept or the aim point', () => {
  it('stays locked and solved while the predicted hit point is outside the circle and beyond 120 m; the shot hits', () => {
    const loadout: Loadout = { fcs: 'wide', generator: 'balanced', legs: 'biped' };
    // 109.15 m ahead, crossing at 45 m/s
    const sim = lockSim([makeTarget('T', ahead(109.15, -38.9), v3(45, 0, 0))], { loadout });
    const t = sim.enemies[0];
    sim.runFor(1.3);
    expect(sim.lock.state).toBe('locked');
    const fc = sim.fireControl;
    expect(fc.status).toBe('solved');
    const radius = sim.lock.radiusCssPx;
    expect(radius).toBe(216);
    expect(pxFromCentre(sim, t.pos)).toBeLessThan(radius); // the target itself is inside
    expect(pxFromCentre(sim, fc.intercept as V3)).toBeGreaterThan(radius * 1.5); // the hit point is not
    expect(pxFromCentre(sim, fc.aimPoint as V3)).toBeGreaterThan(radius * 1.5);
    expect(distance(sim.player.muzzle, t.pos)).toBeLessThan(120);
    expect(distance(sim.player.muzzle, fc.intercept as V3)).toBeGreaterThan(125); // beyond the 120 m range
    expect(fc.flightSeconds as number).toBeGreaterThan(1.2); // longer than the enemy AI's 1.2 s cap
    expect(fc.flightSeconds as number).toBeLessThanOrEqual(2);
    expect(fc.residual as number).toBeLessThanOrEqual(0.01);
    // the camera was never turned towards the correction
    expect(sim.player.yaw).toBe(0);
    expect(sim.player.pitch).toBe(0);

    sim.input.fire = true;
    sim.tick();
    sim.input.fire = false;
    const rec = sim.shots[0];
    expect(rec.solutionStatus).toBe('solved');
    const tFire = sim.time;
    const hp0 = t.hp;
    let lockLostAt: number | null = null;
    const out = flyOut(sim, t, 2.1, () => {
      if (lockLostAt == null && sim.lock.state === 'none') lockLostAt = sim.time;
    });
    expect(lockLostAt).not.toBeNull(); // the target left the circle while the bullet was in flight …
    expect(out.hitTime).not.toBeNull(); // … and the bullet still arrives
    if (out.hitTime != null && lockLostAt != null) expect(out.hitTime).toBeGreaterThan(lockLostAt);
    expect(hp0 - t.hp).toBe(MG.damage);
    console.log(
      `[fcs] intercept outside circle/range: flight ${(rec.flightSeconds as number).toFixed(4)} s, intercept at ${distance(rec.muzzle, rec.intercept as V3).toFixed(1)} m, hit after ${((out.hitTime as number) - tFire).toFixed(4)} s`,
    );
  });
});

describe('fire-control value and aim (SPEC §10 semantics)', () => {
  it('inactive with null fields until the lock is complete; free aim follows the camera centre', () => {
    const sim = lockSim([]);
    expectInactive(sim.fireControl, 'machinegun');
    expect(sim.aim.mode).toBe('free');
    sim.input.weaponSelect = 'missile';
    sim.tick();
    expectInactive(sim.fireControl, 'missile');
    // looking straight ahead over an empty floor: the far aim point on the camera-centre ray
    const point = v3();
    const dir = v3();
    computeFreeAim(sim, point, dir);
    expect(sim.aim.point).toEqual(point);
    expect(sim.aim.dir).toEqual(dir);
    expect(Math.abs(point.x - sim.camera.pos.x)).toBeLessThan(1e-9);
    expect(Math.abs(point.y - sim.camera.pos.y)).toBeLessThan(1e-9);
    expect(length(dir)).toBeCloseTo(1, 12);
    expect(maxAbsDiff(dir, normalize(sub(point, sim.player.muzzle)))).toBeLessThan(1e-12);
    expect(angleBetween(dir, sim.camera.forward)).toBeLessThan(0.6 * DEG);
  });

  it('gun, projectile, beam ray and HUD value are one computation: sim.aim / sim.fireControl equal every shot at its firing instant', () => {
    // §4.2: the renderer turns the weapon to sim.aim.dir and the HUD projects sim.fireControl.aimPoint. Here
    // the mech glides at 22 m/s towards a target that crosses its path; the trigger is held throughout
    // (free fire until the lock completes) and the weapon is switched twice.
    const sim = lockSim([makeTarget('T', ahead(110, -4), v3(2, 0, 0), 0.5, 1e9)], { loadout: { fcs: 'wide', generator: 'capacity', legs: 'biped' } });
    sim.input.glideTogglePressed = true;
    sim.input.fire = true;
    const ticksFor = (seconds: number): number => Math.round(seconds / TICK);
    const seen = { free: 0, machinegun: 0, beam: 0, missile: 0 };
    let known = 0;
    for (let k = 1; k <= ticksFor(3.2); k++) {
      if (k === ticksFor(1.7)) sim.input.weaponSelect = 'beam';
      if (k === ticksFor(2.3)) sim.input.weaponSelect = 'missile';
      sim.tick();
      const events = sim.drainEvents();
      if (sim.shots.length === known) continue;
      expect(sim.shots.length).toBe(known + 1);
      known = sim.shots.length;
      const rec = sim.shots[known - 1];
      const label = `shot ${rec.id} (${rec.weapon}, ${rec.solutionStatus}) at ${rec.firedAt.toFixed(4)} s`;
      expect(rec.firedAt, label).toBeCloseTo(sim.time, 12); // fired at the end of this tick
      expect(rec.muzzle, label).toEqual(sim.player.muzzle); // from the muzzle of the moving mech at that instant

      // what the gun model points along = what was fired
      expect(sim.aim.dir, label).toEqual(rec.launchDir);
      expect(length(sim.aim.dir)).toBeCloseTo(1, 12);
      if (rec.solutionStatus === 'inactive') {
        seen.free++;
        expect(sim.aim.mode, label).toBe('free');
        expectInactive(sim.fireControl, rec.weapon);
      } else {
        seen[rec.weapon]++;
        expect(sim.aim.mode, label).toBe('fcs');
        // what the HUD shows = what was fired
        expect(sim.fireControl.status).toBe(rec.solutionStatus);
        expect(sim.fireControl.evaluatedAt).toBe(rec.firedAt);
        expect(sim.fireControl.launchDir, label).toEqual(rec.launchDir);
        expect(sim.fireControl.targetPos, label).toEqual(rec.targetPosAtFire);
        expect(sim.aim.point, label).toEqual(sim.fireControl.aimPoint);
        // the aim point lies on the initial line of fire from the muzzle
        expect(angleBetween(sub(sim.fireControl.aimPoint as V3, rec.muzzle), rec.launchDir), label).toBeLessThan(1e-9);
      }
      // what really left the muzzle
      if (rec.weapon === 'beam') {
        const beam = events.find((e) => e.type === 'beam');
        expect(beam, label).toBeDefined();
        if (beam && beam.type === 'beam') {
          expect(beam.from).toEqual(rec.muzzle);
          expect(angleBetween(sub(beam.to, beam.from), rec.launchDir), label).toBeLessThan(1e-9);
        }
        expect(rec.initialVelocity).toBeNull();
      } else {
        const proj = sim.projectiles[sim.projectiles.length - 1];
        const speed = rec.weapon === 'machinegun' ? MG.speed : MSL.speed;
        expect(proj.origin, label).toEqual(rec.muzzle);
        expect(proj.v0, label).toEqual(rec.initialVelocity);
        expect(maxAbsDiff(proj.v0, scale(rec.launchDir, speed)), label).toBeLessThan(1e-12);
        expect(Math.abs(length(proj.v0) - speed)).toBeLessThan(1e-9); // no mech velocity in it
      }
    }
    expect(sim.player.glideEnabled).toBe(true);
    expect(length(sim.player.vel)).toBeCloseTo(22, 6);
    expect(seen.free).toBeGreaterThanOrEqual(10); // free fire before the lock was complete
    expect(seen.machinegun).toBeGreaterThanOrEqual(3);
    expect(seen.beam).toBeGreaterThanOrEqual(2);
    expect(seen.missile).toBeGreaterThanOrEqual(1);
    console.log(
      `[fcs] gun = shot = HUD: ${known} shots while gliding (free ${seen.free}, MG ${seen.machinegun}, beam ${seen.beam}, missile ${seen.missile}) — sim.aim.dir and sim.fireControl identical to each shot record`,
    );
  });

  it('refreshFireControl changes nothing but sim.fireControl and sim.aim; solutions are fresh copies', () => {
    const sim = lockSim([makeTarget('T', ahead(60, 2), v3(3, 0, 0))]);
    sim.runFor(1.0);
    const fc = sim.fireControl;
    expect(fc.status).toBe('solved');
    expect(fc.muzzle).not.toBe(sim.player.muzzle);
    expect(fc.targetPos).not.toBe(sim.enemies[0].pos);
    const frozen = JSON.parse(JSON.stringify(fc)) as FireSolution;
    const lockBefore = JSON.stringify(sim.lock);
    const a = computeFireSolution(sim, 'machinegun');
    const b = computeFireSolution(sim, 'machinegun');
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(a).toEqual(fc);
    expect(revalidateLock(sim)).toBe(true); // a valid lock is left exactly as it is
    expect(JSON.stringify(sim.lock)).toBe(lockBefore);
    sim.tick();
    // the previous object was replaced, not edited
    expect(JSON.parse(JSON.stringify(fc))).toEqual(frozen);
    expect(sim.fireControl).not.toBe(fc);
    expect(sim.fireControl.targetPos).not.toEqual(frozen.targetPos);
    expect(sim.aim.mode).toBe('fcs');
    expect(sim.aim.dir).toEqual(sim.fireControl.launchDir);
    expect(sim.aim.point).toEqual(sim.fireControl.aimPoint);
  });

  it('a target whose state is not a finite number is dropped and never solved; no NaN reaches the state', () => {
    const sim = lockSim([makeTarget('T', ahead(50)), makeTarget('U', ahead(70, 5))]);
    const [t, u] = sim.enemies;
    sim.runFor(1.0);
    expect(sim.lock.state).toBe('locked');
    expect(sim.lock.targetId).toBe('T');
    t.pos.x = Number.NaN;
    sim.tick();
    expect(lockCandidateDistancePx(sim, t)).toBe(-1);
    expect(sim.lock.targetId).toBe('U'); // the broken one is skipped, the next candidate starts from 0
    expect(sim.lock.progress).toBe(0);
    expectInactive(sim.fireControl, 'machinegun');
    expectFiniteState(sim);
    sim.runFor(1.0);
    expect(sim.lock.state).toBe('locked');
    u.vel.y = Number.POSITIVE_INFINITY; // a velocity that cannot be used
    const fc = computeFireSolution(sim, 'machinegun');
    expectInactive(fc, 'machinegun');
    sim.input.fire = true;
    sim.tick();
    expect(sim.shots.length).toBe(1);
    expectFiniteState(sim);
  });

  it('muzzle practically at the target centre: no division by zero, the shot is resolved by the real overlap', () => {
    for (const weapon of ['machinegun', 'beam', 'missile'] as Weapon[]) {
      const loadout: Loadout = { fcs: 'wide', generator: 'balanced', legs: 'biped' };
      const sim = lockSim([makeTarget('T', clone(BASE.muzzle), v3(), 0.5, 1000)], { loadout });
      const t = sim.enemies[0];
      if (weapon !== 'machinegun') sim.input.weaponSelect = weapon;
      sim.runFor(1.3);
      expect(distance(sim.player.muzzle, t.pos)).toBeLessThan(1e-9);
      expect(sim.lock.state).toBe('locked');
      const fc = sim.fireControl;
      expect(fc.status).toBe(weapon === 'beam' ? 'solved' : 'no_solution');
      expect(isFiniteV3(fc.launchDir as V3)).toBe(true);
      expect(length(fc.launchDir as V3)).toBeCloseTo(1, 12);
      expect(fc.aimPoint).toEqual(t.pos);
      sim.input.fire = true;
      sim.tick();
      sim.input.fire = false;
      expect(sim.shots.length).toBe(1);
      expectFiniteState(sim);
      sim.runFor(0.1);
      const dmg = weapon === 'machinegun' ? MG.damage : weapon === 'beam' ? BEAM.damage : MSL.damage;
      expect(1000 - t.hp).toBe(dmg); // hit at the muzzle by the normal collision code
      expectFiniteState(sim);
    }
  });
});
