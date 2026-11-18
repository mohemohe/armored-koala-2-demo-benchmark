/**
 * Enemy AI — guard robots and fixed turrets (docs/SPEC.md §2.1, §2.3, §9, §10, §11).
 *
 * Everything runs the real simulation: a real Sim on small test stages (makeTestStage + makeGuard /
 * makeTurret), the real player (kept still or driven through sim.input), the real projectiles and hit
 * tests. Nothing of the code under test is mocked. Shot times are read from enemy.lastShotAt (exact
 * simulation time of the sub-step that spawned the bullet), telegraph times from enemy.telegraphStartAt.
 * Measured numbers are printed with the prefix "[enemies]"
 * (`npx vitest run tests/enemies.test.ts --silent=false`).
 */
import { describe, expect, it } from 'vitest';
import { CAMERA, ENEMIES, ENEMY_AI, PLAYER, TICK } from '../src/config';
import { Rng } from '../src/core/rng';
import { clone, distance, v3, yawFromDir, type V3 } from '../src/core/vec';
import { solveLinearIntercept } from '../src/sim/ballistics';
import { ENEMY_TUNING, enemiesNextEventTime, enemyMuzzle, getEnemyAi, moveEnemies, telegraphProgress, updateEnemies } from '../src/sim/enemies';
import { Sim } from '../src/sim/sim';
import { buildSnapshot } from '../src/sim/snapshot';
import type { Box, EnemyDef, EnemyState, Projectile, SimEvent, SolidDef, StageDef } from '../src/sim/types';
import { makeGuard, makeTarget, makeTestStage, makeTurret } from '../src/stage/testStages';

// ───────────────────────────── helpers ─────────────────────────────

const GUARD = ENEMIES.guard;
const TURRET = ENEMIES.turret;
const DEG = Math.PI / 180;
const BIG_HP = 1e9;
/** Player hit-box centre when standing on the test floor. */
const STAND_Y = PLAYER.half.y + 0.001;
const AGENT_HALF = v3(GUARD.radius - 1e-6, GUARD.radius - 1e-6, GUARD.radius - 1e-6);

const log = (...args: unknown[]): void => console.log('[enemies]', ...args);

const solid = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): SolidDef => ({
  min: v3(x0, y0, z0),
  max: v3(x1, y1, z1),
  material: 'wall',
});

interface MkOpts {
  enemies?: EnemyDef[];
  solids?: SolidDef[];
  start?: V3;
  yaw?: number;
  seed?: number;
  floorSize?: number;
  edit?: (stage: StageDef) => void;
}
function mk(o: MkOpts = {}): Sim {
  const stage = makeTestStage({
    floorSize: o.floorSize ?? 300,
    enemies: o.enemies,
    solids: o.solids,
    start: o.start,
    yaw: o.yaw,
  });
  if (o.edit) o.edit(stage);
  return new Sim(stage, { seed: o.seed ?? 12345 });
}

interface Shot {
  /** Exact simulation time of the shot. */
  t: number;
  id: string;
  kind: 'guard' | 'turret';
  muzzle: V3;
  dir: V3;
  /** End of the tick that contained the shot, and the player's state then. */
  tickEnd: number;
  pPos: V3;
  pVel: V3;
}
interface Tele {
  id: string;
  tickEnd: number;
  duration: number;
  /** enemy.telegraphStartAt / burstStartAt at the end of the tick that emitted the event. */
  startAt: number | null;
  burstAt: number | null;
}
interface Dmg {
  tickEnd: number;
  amount: number;
  from: string | null;
}
type Outcome = 'flying' | 'player' | 'world' | 'expired';
interface Bullet {
  id: number;
  owner: string;
  spawnTime: number;
  origin: V3;
  v0: V3;
  outcome: Outcome;
  end: V3 | null;
}

/** Steps a Sim tick by tick and records what the enemies did. */
class Rec {
  shots: Shot[] = [];
  teles: Tele[] = [];
  dmg: Dmg[] = [];
  alerted: Array<{ tickEnd: number; id: string }> = [];
  bullets = new Map<number, Bullet>();
  private live = new Map<number, Projectile>();
  /** Largest deviation of a live enemy bullet from origin + v0·age, and of its velocity from v0. */
  maxPathError = 0;
  maxVelError = 0;
  lastEvents: SimEvent[] = [];

  constructor(readonly sim: Sim) {}

  tick(): SimEvent[] {
    const sim = this.sim;
    sim.tick();
    const evs = sim.drainEvents();
    this.lastEvents = evs;
    for (const ev of evs) {
      if (ev.type === 'enemy-shot') {
        const e = sim.enemyById.get(ev.enemyId) as EnemyState;
        this.shots.push({
          t: e.lastShotAt as number,
          id: ev.enemyId,
          kind: ev.kind,
          muzzle: clone(ev.muzzle),
          dir: clone(ev.dir),
          tickEnd: sim.time,
          pPos: clone(sim.player.pos),
          pVel: clone(sim.player.vel),
        });
      } else if (ev.type === 'enemy-telegraph') {
        const e = sim.enemyById.get(ev.enemyId) as EnemyState;
        this.teles.push({ id: ev.enemyId, tickEnd: sim.time, duration: ev.duration, startAt: e.telegraphStartAt, burstAt: e.burstStartAt });
      } else if (ev.type === 'player-damaged') {
        this.dmg.push({ tickEnd: sim.time, amount: ev.amount, from: ev.fromEnemyId });
      } else if (ev.type === 'enemy-alerted') {
        this.alerted.push({ tickEnd: sim.time, id: ev.enemyId });
      }
    }
    for (const p of sim.projectiles) {
      if (p.kind !== 'enemy' || this.live.has(p.id)) continue;
      this.live.set(p.id, p);
      this.bullets.set(p.id, {
        id: p.id,
        owner: p.ownerEnemyId ?? '?',
        spawnTime: p.spawnTime,
        origin: clone(p.origin),
        v0: clone(p.v0),
        outcome: 'flying',
        end: null,
      });
    }
    for (const [id, p] of this.live) {
      const b = this.bullets.get(id) as Bullet;
      if (p.alive) {
        // Straight flight: position = origin + v0·age, velocity = v0 (no gravity, no guidance).
        const age = sim.time - p.spawnTime;
        const ex = p.origin.x + p.v0.x * age;
        const ey = p.origin.y + p.v0.y * age;
        const ez = p.origin.z + p.v0.z * age;
        this.maxPathError = Math.max(this.maxPathError, Math.hypot(p.pos.x - ex, p.pos.y - ey, p.pos.z - ez));
        this.maxVelError = Math.max(this.maxVelError, Math.hypot(p.vel.x - p.v0.x, p.vel.y - p.v0.y, p.vel.z - p.v0.z));
        continue;
      }
      this.live.delete(id);
      b.end = clone(p.pos);
      b.outcome = 'expired';
      for (const ev of evs) {
        if (ev.type === 'projectile-hit' && ev.kind === 'enemy' && ev.pos.x === p.pos.x && ev.pos.y === p.pos.y && ev.pos.z === p.pos.z) {
          b.outcome = ev.target === 'player' ? 'player' : 'world';
        }
      }
    }
    return evs;
  }

  /** Runs whole ticks until `seconds` have passed (or the sortie ended); `each` runs after every tick. */
  run(seconds: number, each?: () => void): void {
    const n = Math.round(seconds / TICK);
    for (let i = 0; i < n && this.sim.status === 'playing'; i++) {
      this.tick();
      if (each) each();
    }
  }

  /** Runs until `cond` holds (checked after every tick); fails after `maxSeconds`. */
  until(cond: () => boolean, maxSeconds: number, each?: () => void): void {
    const n = Math.round(maxSeconds / TICK);
    for (let i = 0; i < n && this.sim.status === 'playing'; i++) {
      this.tick();
      if (each) each();
      if (cond()) return;
    }
    throw new Error(`condition not reached within ${maxSeconds} s (t = ${this.sim.time})`);
  }

  shotsOf(id: string): Shot[] {
    return this.shots.filter((s) => s.id === id);
  }
  telesOf(id: string): Tele[] {
    return this.teles.filter((s) => s.id === id);
  }
}

/** Groups shot times into bursts: a new burst begins when the gap exceeds 1.5 × the in-burst interval. */
function bursts(times: number[], interval: number): number[][] {
  const out: number[][] = [];
  for (const t of times) {
    const cur = out[out.length - 1];
    if (cur && t - cur[cur.length - 1] < interval * 1.5) cur.push(t);
    else out.push([t]);
  }
  return out;
}

const angleBetween = (a: V3, b: V3): number => {
  const cx = a.y * b.z - a.z * b.y;
  const cy = a.z * b.x - a.x * b.z;
  const cz = a.x * b.y - a.y * b.x;
  return Math.atan2(Math.hypot(cx, cy, cz), a.x * b.x + a.y * b.y + a.z * b.z);
};

/** Ground truth of "valid line of sight" straight from the world (range from the centre, ray from the muzzle). */
function losTruth(sim: Sim, e: EnemyState): boolean {
  const m = enemyMuzzle(e, v3());
  return distance(e.pos, sim.player.pos) <= ENEMIES[e.kind].range && !sim.world.segmentBlocked(m, sim.player.pos);
}

/** The lead direction the spec asks for, computed independently from the state at the shot. */
function idealLead(muzzle: V3, pPos: V3, pVel: V3, speed: number): V3 {
  const sol = solveLinearIntercept(muzzle, pPos, pVel, speed, ENEMY_AI.maxPredictSeconds);
  if (sol) return sol.dir;
  const lead = Math.min(ENEMY_AI.maxPredictSeconds, distance(muzzle, pPos) / speed);
  const a = v3(pPos.x + pVel.x * lead - muzzle.x, pPos.y + pVel.y * lead - muzzle.y, pPos.z + pVel.z * lead - muzzle.z);
  const l = Math.hypot(a.x, a.y, a.z);
  return v3(a.x / l, a.y / l, a.z / l);
}

/** Player state at the exact shot time, extrapolated back from the end of the tick (constant velocity). */
function playerAtShot(s: Shot): V3 {
  const dt = s.tickEnd - s.t;
  return v3(s.pPos.x - s.pVel.x * dt, s.pPos.y - s.pVel.y * dt, s.pPos.z - s.pVel.z * dt);
}

/** Slab test: does the segment a→b pass through the interior of `box`? */
function segmentHitsBox(a: V3, b: V3, box: Box): boolean {
  let t0 = 0;
  let t1 = 1;
  for (const k of ['x', 'y', 'z'] as const) {
    const d = b[k] - a[k];
    if (Math.abs(d) < 1e-12) {
      if (a[k] <= box.min[k] || a[k] >= box.max[k]) return false;
      continue;
    }
    let u0 = (box.min[k] - a[k]) / d;
    let u1 = (box.max[k] - a[k]) / d;
    if (u0 > u1) [u0, u1] = [u1, u0];
    t0 = Math.max(t0, u0);
    t1 = Math.min(t1, u1);
    if (t0 >= t1) return false;
  }
  return true;
}

function expectFiniteState(sim: Sim): void {
  for (const e of sim.enemies) {
    const nums = [e.pos.x, e.pos.y, e.pos.z, e.prevPos.x, e.prevPos.y, e.prevPos.z, e.vel.x, e.vel.y, e.vel.z, e.yaw, e.aimDir.x, e.aimDir.y, e.aimDir.z, e.hp];
    for (const v of nums) if (!Number.isFinite(v)) throw new Error(`non-finite enemy state in ${e.id}`);
    const al = Math.hypot(e.aimDir.x, e.aimDir.y, e.aimDir.z);
    if (Math.abs(al - 1) > 1e-6) throw new Error(`aimDir of ${e.id} is not unit (${al})`);
    for (const v of [e.lastKnownAt, e.losLostAt, e.burstStartAt, e.telegraphStartAt, e.lastShotAt]) {
      if (v !== null && !Number.isFinite(v)) throw new Error(`non-finite time in ${e.id}`);
    }
    if (Number.isNaN(e.nextBurstReadyAt) || e.nextBurstReadyAt === Infinity) throw new Error(`bad nextBurstReadyAt in ${e.id}`);
    if (e.lastKnownPlayerPos) {
      const k = e.lastKnownPlayerPos;
      if (!Number.isFinite(k.x + k.y + k.z)) throw new Error(`non-finite memory in ${e.id}`);
    }
  }
}

const speedXZ = (e: EnemyState): number => Math.hypot(e.vel.x, e.vel.z);

/** Motion statistics of one guard, read from its position and its reported velocity every tick. */
class Motion {
  /** Ticks on which the velocity pointed the other way than on the previous moving tick. */
  reversals = 0;
  /** Shortest time between two reversals. */
  minGap = Infinity;
  /** Longest run of reversals on consecutive ticks. */
  longestRun = 0;
  path = 0;
  still = 0;
  ticks = 0;
  xMin = Infinity;
  xMax = -Infinity;
  zMin = Infinity;
  zMax = -Infinity;
  /** 60 Hz reader: frames that report more than 5 m/s while the position moved less than 0.5 m/s. */
  ghostFrames = 0;
  /** 1 s windows (checked every 0.25 s) with at least 4 m of path inside a box of less than 1.5 m. */
  shuffleWindows = 0;
  /** Ticks on which the reported speed differed from the displacement of the tick. */
  velMismatch = 0;
  private lastV: V3 | null = null;
  private lastRevAt = -Infinity;
  private run = 0;
  private prev: V3;
  private frame: V3;
  private win: V3[] = [];
  constructor(
    readonly sim: Sim,
    readonly e: EnemyState,
  ) {
    this.prev = clone(e.pos);
    this.frame = clone(e.pos);
  }
  sample(): void {
    const e = this.e;
    const v = e.vel;
    const sp = Math.hypot(v.x, v.z);
    this.ticks++;
    // The reported velocity is the real displacement of the hit-sphere centre (over the last sub-step of the
    // tick: on a tick that was cut by an event and changed course in between, the two may differ a little).
    const step = Math.hypot(e.pos.x - this.prev.x, e.pos.z - this.prev.z);
    if (Math.abs(step / TICK - sp) > 1e-3) this.velMismatch++;
    this.path += step;
    if (sp < 0.01) this.still++;
    let rev = false;
    if (sp > 0.5) {
      const l = this.lastV;
      if (l && l.x * v.x + l.z * v.z < -0.5 * sp * Math.hypot(l.x, l.z)) {
        rev = true;
        this.reversals++;
        this.minGap = Math.min(this.minGap, this.sim.time - this.lastRevAt);
        this.lastRevAt = this.sim.time;
      }
      this.lastV = clone(v);
    }
    this.run = rev ? this.run + 1 : 0;
    this.longestRun = Math.max(this.longestRun, this.run);
    this.xMin = Math.min(this.xMin, e.pos.x);
    this.xMax = Math.max(this.xMax, e.pos.x);
    this.zMin = Math.min(this.zMin, e.pos.z);
    this.zMax = Math.max(this.zMax, e.pos.z);
    if (this.ticks % 2 === 0) {
      const seen = Math.hypot(e.pos.x - this.frame.x, e.pos.z - this.frame.z) / (2 * TICK);
      if (sp > 5 && seen < 0.5) this.ghostFrames++;
      this.frame = clone(e.pos);
    }
    this.win.push(clone(e.pos));
    if (this.win.length > 120) this.win.shift();
    if (this.win.length === 120 && this.ticks % 30 === 0) {
      let pl = 0;
      let x0 = Infinity;
      let x1 = -Infinity;
      let z0 = Infinity;
      let z1 = -Infinity;
      for (let k = 0; k < 120; k++) {
        const q = this.win[k];
        if (k > 0) pl += Math.hypot(q.x - this.win[k - 1].x, q.z - this.win[k - 1].z);
        x0 = Math.min(x0, q.x);
        x1 = Math.max(x1, q.x);
        z0 = Math.min(z0, q.z);
        z1 = Math.max(z1, q.z);
      }
      if (pl >= 4 && Math.hypot(x1 - x0, z1 - z0) < 1.5) this.shuffleWindows++;
    }
    this.prev = clone(e.pos);
  }
}

/** Smallest gap between the hit spheres of `g` and any other living enemy, minus the margin the guards keep. */
const clearance = (sim: Sim, g: EnemyState): number => {
  let min = Infinity;
  for (const o of sim.enemies) {
    if (o === g || !o.alive) continue;
    min = Math.min(min, distance(g.pos, o.pos) - g.radius - o.radius - ENEMY_TUNING.separationMargin);
  }
  return min;
};

// ───────────────────────────── attack timing ─────────────────────────────

describe('attack timing (§2.3 table)', () => {
  const cases = [
    { name: 'guard', cfg: GUARD, def: () => makeGuard('E1', 0, -40) },
    { name: 'turret', cfg: TURRET, def: () => makeTurret('E1', 0, -40) },
  ] as const;

  for (const c of cases) {
    it(`${c.name}: first burst exactly ${c.cfg.firstShotDelay} s after the first line of sight, telegraph ${c.cfg.telegraph} s before, bursts of ${c.cfg.burstCount} every ${c.cfg.burstPeriod} s`, () => {
      const sim = mk({ enemies: [c.def()] });
      sim.player.hp = BIG_HP;
      const e = sim.enemies[0];
      const rec = new Rec(sim);
      let firstLosTickEnd: number | null = null;
      rec.run(12, () => {
        if (firstLosTickEnd === null && e.hasLos) firstLosTickEnd = sim.time;
        expectFiniteState(sim);
      });
      const tSight = getEnemyAi(e).firstSightAt as number;
      // The enemy has a clear line from the very start: it is noticed by the first perception (1/120 s).
      expect(firstLosTickEnd).toBeCloseTo(TICK, 12);
      expect(tSight).toBeCloseTo(TICK, 12);

      const shots = rec.shotsOf('E1').map((s) => s.t);
      const first = shots[0];
      expect(Math.abs(first - (tSight + c.cfg.firstShotDelay))).toBeLessThanOrEqual(1e-6);
      // Never more than 0.05 s late, even measured from the true start of the exposure (t = 0).
      expect(first - (0 + c.cfg.firstShotDelay)).toBeLessThanOrEqual(ENEMY_AI.maxDecisionDelay);
      expect(first - (tSight + c.cfg.firstShotDelay)).toBeGreaterThanOrEqual(-1e-9);

      const groups = bursts(shots, c.cfg.burstInterval);
      // 10 s of continuous line of sight after the first burst.
      const within = groups.filter((g) => g[0] <= first + 10 + 1e-9);
      expect(within.length).toBe(Math.floor(10 / c.cfg.burstPeriod + 1e-9) + 1);
      let maxStartErr = 0;
      let maxGapErr = 0;
      for (let k = 0; k < within.length; k++) {
        const g = within[k];
        expect(g.length).toBe(c.cfg.burstCount);
        maxStartErr = Math.max(maxStartErr, Math.abs(g[0] - (first + k * c.cfg.burstPeriod)));
        if (k > 0) expect(Math.abs(g[0] - within[k - 1][0] - c.cfg.burstPeriod)).toBeLessThanOrEqual(1e-9);
        for (let j = 1; j < g.length; j++) {
          const err = Math.abs(g[j] - g[j - 1] - c.cfg.burstInterval);
          maxGapErr = Math.max(maxGapErr, err);
          expect(err).toBeLessThanOrEqual(1e-9);
        }
      }
      expect(maxStartErr).toBeLessThanOrEqual(1e-9);

      // One telegraph per burst, starting exactly `telegraph` seconds before it and inside the period.
      const teles = rec.telesOf('E1');
      expect(teles.length).toBeGreaterThanOrEqual(within.length);
      for (let k = 0; k < within.length; k++) {
        const tl = teles[k];
        expect(tl.burstAt).not.toBeNull();
        expect(tl.startAt).not.toBeNull();
        expect(Math.abs((tl.burstAt as number) - within[k][0])).toBeLessThanOrEqual(1e-9);
        expect(Math.abs((tl.burstAt as number) - (tl.startAt as number) - c.cfg.telegraph)).toBeLessThanOrEqual(1e-9);
        expect(Math.abs(tl.duration - c.cfg.telegraph)).toBeLessThanOrEqual(1e-9);
        // The event was emitted by the tick that contains the start of the window.
        expect(tl.startAt as number).toBeGreaterThan(tl.tickEnd - TICK - 1e-9);
        expect(tl.startAt as number).toBeLessThanOrEqual(tl.tickEnd + 1e-9);
      }
      // telegraphProgress(): 0 outside the window, rising to 1 at the burst start.
      const w0 = teles[1].startAt as number;
      const w1 = teles[1].burstAt as number;
      const probeEnemy = { ...e, telegraphStartAt: w0, burstStartAt: w1 };
      expect(telegraphProgress(probeEnemy, w0 - 0.01)).toBe(0);
      expect(telegraphProgress(probeEnemy, w0 + (w1 - w0) / 2)).toBeCloseTo(0.5, 9);
      expect(telegraphProgress(probeEnemy, w1)).toBe(1);
      expect(telegraphProgress({ ...e, telegraphStartAt: null, burstStartAt: null }, w0)).toBe(0);
      // Counters count real bullets only.
      expect(e.shotsFired).toBe(shots.length);
      expect(e.lastShotAt).toBe(shots[shots.length - 1]);
      expect(rec.bullets.size).toBe(shots.length);
      log(
        `${c.name}: first LOS ${tSight.toFixed(6)} s, first shot ${first.toFixed(6)} s (delay ${(first - tSight).toFixed(9)} s), ` +
          `telegraph ${(within[0][0] - (teles[0].startAt as number)).toFixed(9)} s before, ${within.length} bursts in 10 s, ` +
          `max burst-start error ${maxStartErr.toExponential(2)} s, max in-burst gap error ${maxGapErr.toExponential(2)} s`,
      );
    });
  }

  it('an enemy BEHIND the player (outside the camera view) attacks exactly like one in front', () => {
    for (const c of cases) {
      const make = (z: number): { sim: Sim; rec: Rec } => {
        const def = c.name === 'guard' ? makeGuard('E1', 0, z) : makeTurret('E1', 0, z);
        const sim = mk({ enemies: [def] });
        const rec = new Rec(sim);
        rec.run(6);
        return { sim, rec };
      };
      const front = make(-40);
      const back = make(40);
      // yaw 0 looks along -Z: the enemy at z = +40 is behind the player and behind the camera.
      const cam = back.sim.camera;
      const e = back.sim.enemies[0];
      const ahead = (e.pos.x - cam.pos.x) * cam.forward.x + (e.pos.y - cam.pos.y) * cam.forward.y + (e.pos.z - cam.pos.z) * cam.forward.z;
      expect(ahead).toBeLessThan(0);
      const tf = front.rec.shotsOf('E1').map((s) => s.t);
      const tb = back.rec.shotsOf('E1').map((s) => s.t);
      expect(tb.length).toBeGreaterThan(4);
      expect(tb).toEqual(tf);
      expect(back.rec.dmg.length).toBeGreaterThan(0);
      expect(back.sim.player.hp).toBeLessThan(PLAYER.maxHp);
      expect(back.rec.dmg.every((d) => d.amount === c.cfg.damage && d.from === 'E1')).toBe(true);
      log(`${c.name} behind the player: ${tb.length} shots in 6 s (same times as in front), player HP ${back.sim.player.hp}`);
    }
  });

  it('never looks at the camera, the facing or who shot first: turning the view changes nothing', () => {
    const run = (turn: boolean): number[] => {
      const sim = mk({ enemies: [makeTurret('E1', 30, -30), makeGuard('E2', -35, 20)] });
      sim.player.hp = BIG_HP;
      const rec = new Rec(sim);
      rec.run(5, () => {
        if (turn) sim.applyLook(0.07, 0.01);
      });
      return rec.shots.map((s) => s.t);
    };
    const a = run(false);
    const b = run(true);
    expect(a.length).toBeGreaterThan(8);
    expect(b).toEqual(a);
  });
});

// ───────────────────────────── walls, occlusion, memory ─────────────────────────────

describe('walls and line of sight', () => {
  it('a wall blocks perception and bullets: no alert, no shot, HP unchanged over 20 s', () => {
    const wall = solid(-40, 0, -21, 40, 12, -20);
    const sim = mk({ enemies: [makeGuard('G1', -5, -40), makeTurret('T1', 5, -40)], solids: [wall] });
    const rec = new Rec(sim);
    const g = sim.enemyById.get('G1') as EnemyState;
    const t = sim.enemyById.get('T1') as EnemyState;
    const g0 = clone(g.pos);
    // Both are well inside their range: only the wall stops them.
    expect(distance(g.pos, sim.player.pos)).toBeLessThan(GUARD.range);
    expect(distance(t.pos, sim.player.pos)).toBeLessThan(TURRET.range);
    rec.run(20, () => {
      expect(g.hasLos).toBe(false);
      expect(t.hasLos).toBe(false);
      expect(sim.projectiles.length).toBe(0);
    });
    expect(sim.time).toBeCloseTo(20, 9);
    expect(sim.player.hp).toBe(PLAYER.maxHp);
    expect(rec.shots.length).toBe(0);
    expect(rec.teles.length).toBe(0);
    expect(rec.alerted.length).toBe(0);
    expect(g.alert || t.alert).toBe(false);
    expect(g.shotsFired + t.shotsFired).toBe(0);
    expect(g.lastShotAt).toBeNull();
    expect(g.pos).toEqual(g0);
    expect(getEnemyAi(g).mode).toBe('idle');
    expect(enemiesNextEventTime(sim)).toBe(Infinity);
  });

  it('bullets led at a player who walks behind a wall stop at the wall; nothing passes it, no damage while hidden', () => {
    const wall = solid(6, 0, -8, 40, 12, -7);
    const sim = mk({ enemies: [makeTurret('T1', 0, -40)], solids: [wall] });
    const T = sim.enemies[0];
    const rec = new Rec(sim);
    const hpLog: Array<{ t: number; hp: number; los: boolean }> = [];
    let lostAt = -1;
    const each = (): void => {
      // Perception equals the geometric truth at every tick.
      expect(T.hasLos).toBe(losTruth(sim, T));
      if (T.losLostAt !== null) lostAt = T.losLostAt;
      for (const p of sim.projectiles) {
        if (p.kind === 'enemy') expect(segmentHitsBox(p.prevPos, p.pos, wall)).toBe(false);
      }
      hpLog.push({ t: sim.time, hp: sim.player.hp, los: T.hasLos });
    };
    rec.run(2.2, each); // exposed, standing still
    sim.input.moveX = 1; // walk +x (yaw 0: right = +X) behind the wall
    rec.run(2.6, each);
    sim.input.moveX = 0;
    rec.run(8, each);

    expect(sim.player.pos.x).toBeGreaterThan(20);
    expect(T.hasLos).toBe(false);
    const all = [...rec.bullets.values()];
    expect(all.length).toBe(rec.shots.length);
    expect(all.every((b) => b.outcome !== 'flying')).toBe(true);
    const stopped = all.filter((b) => b.outcome === 'world' && b.end !== null && Math.abs(b.end.z - wall.min.z) < 1e-6 && b.end.x >= wall.min.x);
    expect(stopped.length).toBeGreaterThanOrEqual(1);
    for (const b of all) {
      // The whole flown path stays out of the wall's interior; hits on the player had a clear path.
      expect(segmentHitsBox(b.origin, b.end as V3, wall)).toBe(false);
    }
    // After the last line of sight no bullet can be under way for longer than its life (3 s).
    expect(lostAt).toBeGreaterThan(2.2);
    const hpAfter = hpLog.filter((h) => h.t > lostAt + TURRET.bulletLife);
    expect(hpAfter.length).toBeGreaterThan(100);
    expect(new Set(hpAfter.map((h) => h.hp)).size).toBe(1);
    // No shot was fired without a line of sight.
    for (const s of rec.shots) expect(s.t).toBeLessThanOrEqual(lostAt);
    const hits = all.filter((b) => b.outcome === 'player').length;
    expect(PLAYER.maxHp - sim.player.hp).toBe(hits * TURRET.damage);
    log(`wall: ${all.length} bullets, ${hits} hit the exposed player, ${stopped.length} stopped by the wall face, HP ${sim.player.hp} constant after LOS loss at ${lostAt.toFixed(3)} s`);
  });
});

describe('occlusion: the weapon timer survives a short loss of sight', () => {
  /** Turret 40 m in front, a pillar that hides the player's centre for x in about (3.53, 7.5) on the line z = 0. */
  const pillar = solid(3, 0, -8, 6, 10, -6);
  const setup = (): { sim: Sim; T: EnemyState; rec: Rec } => {
    const sim = mk({ enemies: [makeTurret('T1', 0, -40)], solids: [pillar], start: v3(2.5, STAND_Y, 0) });
    sim.player.hp = BIG_HP;
    return { sim, T: sim.enemies[0], rec: new Rec(sim) };
  };

  it('a burst that falls due while hidden is not fired; on re-exposure the next burst starts at max(ready, t + telegraph), not after a new 0.7 s', () => {
    const { sim, T, rec } = setup();
    rec.until(() => T.shotsFired === 2 && T.burstStartAt !== null, 3);
    const tSight = getEnemyAi(T).firstSightAt as number;
    const b1 = T.burstStartAt as number;
    expect(b1).toBeCloseTo(tSight + TURRET.firstShotDelay + TURRET.burstPeriod, 9);
    rec.until(() => sim.time >= b1 - 0.25, 3);
    sim.input.moveX = 1; // into the pillar's shadow just before the burst is due
    rec.until(() => !T.hasLos, 1);
    const lostAt = T.losLostAt as number;
    const known = clone(T.lastKnownPlayerPos as V3);
    expect(lostAt).toBeLessThan(b1);
    // The announced burst is cancelled, the ready time is kept.
    expect(T.burstStartAt).toBeNull();
    expect(T.telegraphStartAt).toBeNull();
    expect(T.nextBurstReadyAt).toBeCloseTo(b1, 12);
    let hiddenTicks = 0;
    rec.until(
      () => T.hasLos,
      1,
      () => {
        if (T.hasLos) return;
        hiddenTicks++;
        expect(T.alert).toBe(true);
        expect(T.shotsFired).toBe(2);
        expect(T.burstStartAt).toBeNull();
        expect(T.nextBurstReadyAt).toBeCloseTo(b1, 12);
        // The memory is the last position that was seen, not the hidden current one.
        expect(T.lastKnownPlayerPos).toEqual(known);
        expect(T.hasLos).toBe(losTruth(sim, T));
      },
    );
    sim.input.moveX = 0;
    const reAt = getEnemyAi(T).losSince as number;
    expect(reAt).toBeGreaterThan(b1); // the burst time passed while hidden
    expect(reAt - lostAt).toBeLessThan(1);
    expect(hiddenTicks).toBeGreaterThan(10);
    expect(Math.abs(sim.player.pos.x - known.x)).toBeGreaterThan(2);
    const expected = Math.max(b1, reAt + TURRET.telegraph);
    expect(T.burstStartAt).toBeCloseTo(expected, 12);
    expect(T.telegraphStartAt).toBeCloseTo(expected - TURRET.telegraph, 12);
    // The telegraph of the resumed burst starts at the re-exposure.
    const tele = rec.telesOf('T1').pop() as Tele;
    expect(tele.tickEnd).toBeCloseTo(sim.time, 12);
    expect(tele.duration).toBeCloseTo(TURRET.telegraph, 9);
    rec.until(() => T.shotsFired === 3, 2);
    const next = T.lastShotAt as number;
    expect(Math.abs(next - expected)).toBeLessThanOrEqual(1e-9);
    expect(next - reAt).toBeLessThan(TURRET.firstShotDelay - 0.3); // 0.35 s, not a fresh 0.70 s
    expect(getEnemyAi(T).firstSightAt).toBe(tSight); // still the same engagement
    // From there on the normal period.
    rec.until(() => T.shotsFired === 5, 3);
    expect(Math.abs((T.lastShotAt as number) - (next + TURRET.burstPeriod))).toBeLessThanOrEqual(1e-9);
    log(
      `occlusion A (turret): burst due ${b1.toFixed(4)} s, hidden ${lostAt.toFixed(4)}–${reAt.toFixed(4)} s (${(reAt - lostAt).toFixed(3)} s), ` +
        `no shot while hidden, next burst ${next.toFixed(4)} s = re-exposure + ${(next - reAt).toFixed(4)} s`,
    );
  });

  it('a short occlusion between two bursts does not delay the next one (ready time kept exactly)', () => {
    const { sim, T, rec } = setup();
    rec.until(() => T.shotsFired === 4, 4);
    const b1 = (T.lastShotAt as number) - TURRET.burstInterval;
    const ready = T.nextBurstReadyAt;
    expect(ready).toBeCloseTo(b1 + TURRET.burstPeriod, 12);
    sim.input.moveX = 1;
    rec.until(() => !T.hasLos, 1);
    const lostAt = T.losLostAt as number;
    expect(T.burstStartAt).toBeNull();
    rec.until(() => T.hasLos, 1, () => expect(T.shotsFired).toBe(4));
    sim.input.moveX = 0;
    const reAt = getEnemyAi(T).losSince as number;
    expect(reAt + TURRET.telegraph).toBeLessThan(ready);
    expect(T.burstStartAt).toBeCloseTo(ready, 12);
    rec.until(() => T.shotsFired === 5, 2);
    expect(Math.abs((T.lastShotAt as number) - (b1 + TURRET.burstPeriod))).toBeLessThanOrEqual(1e-9);
    log(`occlusion B (turret): hidden ${lostAt.toFixed(4)}–${reAt.toFixed(4)} s, next burst at ${(T.lastShotAt as number).toFixed(4)} s = previous start + ${TURRET.burstPeriod} s`);
  });

  it('a shot of a running burst that falls due while hidden is skipped and never counted', () => {
    const { sim, T, rec } = setup();
    rec.until(() => T.shotsFired === 3, 4); // first shot of the second burst
    const b1 = T.lastShotAt as number;
    expect(T.burstShotsDone).toBe(1);
    sim.input.moveX = 1;
    rec.until(() => !T.hasLos, 1);
    const lostAt = T.losLostAt as number;
    expect(lostAt).toBeGreaterThan(b1);
    expect(lostAt).toBeLessThan(b1 + TURRET.burstInterval);
    // Still running: the second shot is attempted at its time.
    expect(T.burstStartAt).toBeCloseTo(b1, 12);
    const shotsBefore = rec.shots.length;
    rec.until(() => sim.time >= b1 + TURRET.burstInterval + 2 * TICK, 1);
    expect(T.hasLos).toBe(false);
    expect(T.shotsFired).toBe(3);
    expect(rec.shots.length).toBe(shotsBefore);
    expect(T.burstStartAt).toBeNull(); // the burst is over, nothing is scheduled while hidden
    expect(T.lastShotAt).toBe(b1);
    rec.until(() => T.hasLos, 1);
    sim.input.moveX = 0;
    const reAt = getEnemyAi(T).losSince as number;
    const expected = Math.max(b1 + TURRET.burstPeriod, reAt + TURRET.telegraph);
    expect(T.burstStartAt).toBeCloseTo(expected, 12);
    rec.until(() => T.shotsFired === 4, 2);
    expect(Math.abs((T.lastShotAt as number) - expected)).toBeLessThanOrEqual(1e-9);
    const g = bursts(rec.shotsOf('T1').map((s) => s.t), TURRET.burstInterval);
    expect(g[1].length).toBe(1);
    log(`occlusion C (turret): burst at ${b1.toFixed(4)} s fired 1 of 2 shots (hidden from ${lostAt.toFixed(4)} s), next burst ${expected.toFixed(4)} s`);
  });

  it('hiding during the very first delay neither restarts it nor shortens it: first burst at max(first sight + 0.7 s, re-exposure + telegraph)', () => {
    // Thin pillar: the centre is hidden for x in about (3.53, 4.75) — roughly 0.12 s at walking speed.
    const sim = mk({ enemies: [makeTurret('T1', 0, -40)], solids: [solid(3, 0, -8, 3.8, 10, -6)], start: v3(2.9, STAND_Y, 0) });
    sim.player.hp = BIG_HP;
    const T = sim.enemies[0];
    const rec = new Rec(sim);
    sim.input.moveX = 1;
    rec.tick();
    const tSight = getEnemyAi(T).firstSightAt as number;
    expect(tSight).toBeCloseTo(TICK, 12);
    expect(T.burstStartAt).toBeCloseTo(tSight + TURRET.firstShotDelay, 12);
    rec.until(() => !T.hasLos, 0.5);
    const lostAt = T.losLostAt as number;
    expect(T.burstStartAt).toBeNull(); // cancelled …
    expect(T.nextBurstReadyAt).toBeCloseTo(tSight + TURRET.firstShotDelay, 12); // … but the weapon timer keeps running
    rec.until(() => T.hasLos, 0.5);
    const reAt = getEnemyAi(T).losSince as number;
    expect(reAt + TURRET.telegraph).toBeLessThan(tSight + TURRET.firstShotDelay);
    expect(T.burstStartAt).toBeCloseTo(tSight + TURRET.firstShotDelay, 12);
    expect(getEnemyAi(T).firstSightAt).toBe(tSight);
    rec.until(() => T.shotsFired === 1, 1);
    expect(Math.abs((T.lastShotAt as number) - (tSight + TURRET.firstShotDelay))).toBeLessThanOrEqual(1e-9);
    log(`occlusion during the first delay: seen ${tSight.toFixed(4)} s, hidden ${lostAt.toFixed(4)}–${reAt.toFixed(4)} s, first shot ${(T.lastShotAt as number).toFixed(4)} s (= first sight + ${TURRET.firstShotDelay} s)`);
  });

  it('guard: stepping behind a pillar and out again resumes after the telegraph, without a new 0.5 s delay', () => {
    // The guard is boxed in by low kerbs (it cannot strafe), so the geometry stays put.
    const sim = mk({
      enemies: [makeGuard('G1', 0, -40)],
      solids: [pillar, solid(-8, 0, -44, -2, 1, -36), solid(2, 0, -44, 8, 1, -36), solid(-8, 0, -50, 8, 1, -43), solid(-8, 0, -37, 8, 1, -30)],
      start: v3(2.5, STAND_Y, 0),
    });
    sim.player.hp = BIG_HP;
    const G1 = sim.enemies[0];
    const rec = new Rec(sim);
    rec.until(() => G1.shotsFired === 3 && G1.burstStartAt !== null, 3);
    const tSight = getEnemyAi(G1).firstSightAt as number;
    const b1 = G1.burstStartAt as number;
    rec.until(() => sim.time >= b1 - 0.2, 3);
    sim.input.moveX = 1;
    rec.until(() => !G1.hasLos, 1);
    const lostAt = G1.losLostAt as number;
    expect(lostAt).toBeLessThan(b1);
    rec.until(() => G1.hasLos, 1, () => expect(G1.shotsFired).toBe(3));
    sim.input.moveX = 0;
    const reAt = getEnemyAi(G1).losSince as number;
    expect(reAt - lostAt).toBeLessThan(1);
    const expected = Math.max(b1, reAt + GUARD.telegraph);
    expect(G1.burstStartAt).toBeCloseTo(expected, 12);
    rec.until(() => G1.shotsFired === 4, 2);
    const next = G1.lastShotAt as number;
    expect(Math.abs(next - expected)).toBeLessThanOrEqual(1e-9);
    expect(next - reAt).toBeLessThan(GUARD.firstShotDelay - 0.2);
    expect(getEnemyAi(G1).firstSightAt).toBe(tSight);
    log(`occlusion (guard): hidden ${lostAt.toFixed(4)}–${reAt.toFixed(4)} s, burst due ${b1.toFixed(4)} s, resumed ${next.toFixed(4)} s = re-exposure + ${(next - reAt).toFixed(4)} s`);
  });
});

describe('memory (8 s)', () => {
  it('turret: stays alert with the last seen position for 8 s, then forgets; the next sighting is a first sighting again', () => {
    const wall = solid(6, 0, -8, 40, 12, -7);
    const sim = mk({ enemies: [makeTurret('T1', 0, -40)], solids: [wall] });
    sim.player.hp = BIG_HP;
    const T = sim.enemies[0];
    const rec = new Rec(sim);
    rec.run(2);
    const firstSight = getEnemyAi(T).firstSightAt as number;
    sim.input.moveX = 1;
    rec.until(() => !T.hasLos, 2);
    const lostAt = T.losLostAt as number;
    const knownAt = T.lastKnownAt as number;
    const known = clone(T.lastKnownPlayerPos as V3);
    expect(lostAt - knownAt).toBeLessThanOrEqual(TICK + 1e-9);
    rec.run(1.2); // deeper behind the wall
    sim.input.moveX = 0;
    const expiry = knownAt + ENEMY_AI.memorySeconds;
    let lastAlertAt = -1;
    let firstCalmAt = -1;
    const shotsAtLoss = T.shotsFired;
    rec.until(
      () => sim.time > expiry + 0.5,
      10,
      () => {
        expect(T.hasLos).toBe(false);
        if (T.alert) {
          lastAlertAt = sim.time;
          expect(T.lastKnownPlayerPos).toEqual(known);
          expect(T.lastKnownAt).toBe(knownAt);
          expect(T.losLostAt).toBe(lostAt);
        } else if (firstCalmAt < 0) {
          firstCalmAt = sim.time;
        }
      },
    );
    // Alert right up to the expiry, calm from the tick that contains it.
    expect(lastAlertAt).toBeGreaterThan(expiry - TICK - 1e-9);
    expect(lastAlertAt).toBeLessThan(expiry + 1e-9);
    expect(firstCalmAt).toBeLessThanOrEqual(expiry + TICK + 1e-9);
    expect(T.alert).toBe(false);
    expect(T.lastKnownPlayerPos).toBeNull();
    expect(T.lastKnownAt).toBeNull();
    expect(T.burstStartAt).toBeNull();
    expect(T.shotsFired).toBe(shotsAtLoss);
    // Out again: the initial delay applies again.
    sim.input.moveX = -1;
    rec.until(() => T.hasLos, 4);
    sim.input.moveX = 0;
    const second = getEnemyAi(T).firstSightAt as number;
    expect(second).toBeGreaterThan(expiry);
    expect(second).not.toBe(firstSight);
    expect(T.burstStartAt).toBeCloseTo(second + TURRET.firstShotDelay, 12);
    rec.until(() => T.shotsFired === shotsAtLoss + 1, 2);
    expect(Math.abs((T.lastShotAt as number) - (second + TURRET.firstShotDelay))).toBeLessThanOrEqual(1e-6);
    const tele = rec.telesOf('T1').pop() as Tele;
    expect(Math.abs((tele.burstAt as number) - (tele.startAt as number) - TURRET.telegraph)).toBeLessThanOrEqual(1e-9);
    log(
      `memory (turret): last seen ${knownAt.toFixed(4)} s, alert until ${lastAlertAt.toFixed(4)} s, calm at ${firstCalmAt.toFixed(4)} s ` +
        `(expiry ${expiry.toFixed(4)} s); re-sighted ${second.toFixed(4)} s, first shot ${(T.lastShotAt as number).toFixed(4)} s (+${((T.lastShotAt as number) - second).toFixed(6)} s)`,
    );
  });

  it('guard: walks to the reachable spot nearest the last known position, searches there, and goes idle when the memory expires', () => {
    // The player stands on a 6 m high mesa. Walking back from its edge hides it from everything on the ground.
    const mesa = solid(-25, 0, -30, 25, 6, 30);
    const sim = mk({ enemies: [makeGuard('G1', 0, 73)], solids: [mesa], start: v3(0, 6 + STAND_Y, 28) });
    sim.player.hp = BIG_HP;
    const G1 = sim.enemies[0];
    const rec = new Rec(sim);
    rec.run(1.5);
    expect(G1.hasLos).toBe(true);
    expect(G1.shotsFired).toBeGreaterThan(0);
    sim.input.moveZ = 1; // forward = -Z: away from the edge
    rec.until(() => !G1.hasLos, 4);
    const lostAt = G1.losLostAt as number;
    const knownAt = G1.lastKnownAt as number;
    const known = clone(G1.lastKnownPlayerPos as V3);
    rec.run(0.8);
    sim.input.moveZ = 0;
    const expiry = knownAt + ENEMY_AI.memorySeconds;
    const modes = new Set<string>();
    let prevMode = '';
    let searchSpeedMax = 0;
    let searchDist = 0;
    let closest = Infinity;
    rec.until(
      () => !G1.alert,
      9,
      () => {
        if (!G1.alert) return;
        expect(G1.hasLos).toBe(false);
        expect(G1.hasLos).toBe(losTruth(sim, G1));
        expect(G1.lastKnownPlayerPos).toEqual(known);
        const mode = getEnemyAi(G1).mode;
        const before = prevMode;
        prevMode = mode;
        modes.add(mode);
        closest = Math.min(closest, Math.hypot(G1.pos.x - known.x, G1.pos.z - known.z));
        // (the velocity of a tick belongs to the decision taken before it)
        if (mode === 'search' && before === 'search') {
          searchSpeedMax = Math.max(searchSpeedMax, speedXZ(G1));
          searchDist += speedXZ(G1) * TICK;
        }
        expect(sim.world.overlapsBox(G1.pos, AGENT_HALF)).toBe(false);
        expect(G1.pos.y).toBeCloseTo(GUARD.centerHeight, 9); // never climbs the mesa
      },
    );
    expect(sim.time).toBeGreaterThan(expiry - 1e-9);
    expect(sim.time).toBeLessThanOrEqual(expiry + TICK + 1e-9);
    expect(modes.has('chase')).toBe(true);
    expect(modes.has('search')).toBe(true);
    expect(searchDist).toBeGreaterThan(3);
    expect(searchSpeedMax).toBeLessThanOrEqual(ENEMY_TUNING.searchSpeed + 1e-6);
    expect(G1.lastKnownPlayerPos).toBeNull();
    const shots = G1.shotsFired;
    const idleAt = sim.time;
    rec.run(2, () => {
      expect(G1.alert).toBe(false);
      expect(speedXZ(G1)).toBe(0);
      expect(getEnemyAi(G1).mode).toBe('idle');
    });
    expect(G1.shotsFired).toBe(shots);
    log(
      `memory (guard): LOS lost ${lostAt.toFixed(3)} s, came within ${closest.toFixed(2)} m (horizontal) of the last known position, ` +
        `searched ${searchDist.toFixed(1)} m, idle at ${idleAt.toFixed(3)} s (expiry ${expiry.toFixed(3)} s); modes: ${[...modes].join(', ')}`,
    );
  });
});

// ───────────────────────────── guard movement ─────────────────────────────

describe('guard movement', () => {
  /** Unit XZ bearing from the guard to the player. */
  const bearing = (sim: Sim, e: EnemyState): { x: number; z: number; d: number } => {
    const dx = sim.player.pos.x - e.pos.x;
    const dz = sim.player.pos.z - e.pos.z;
    const d = Math.hypot(dx, dz);
    return { x: dx / d, z: dz / d, d };
  };

  it('beyond 55 m it approaches at 8 m/s (measured), within 55 m it strafes at 6 m/s; out of range it does nothing', () => {
    const sim = mk({ enemies: [makeGuard('G1', 0, -80), makeGuard('G2', 0, 100)] });
    sim.player.hp = BIG_HP;
    const G1 = sim.enemyById.get('G1') as EnemyState;
    const G2 = sim.enemyById.get('G2') as EnemyState;
    const rec = new Rec(sim);
    rec.tick(); // first perception
    expect(G1.hasLos).toBe(true);
    expect(getEnemyAi(G1).mode).toBe('approach');
    const p0 = clone(G1.pos);
    const t0 = sim.time;
    let minSpeed = Infinity;
    let maxSpeed = 0;
    let minClosing = Infinity;
    rec.run(2, () => {
      const b = bearing(sim, G1);
      const sp = speedXZ(G1);
      minSpeed = Math.min(minSpeed, sp);
      maxSpeed = Math.max(maxSpeed, sp);
      minClosing = Math.min(minClosing, G1.vel.x * b.x + G1.vel.z * b.z);
      expect(getEnemyAi(G1).mode).toBe('approach');
      expect(G1.vel.y).toBe(0);
    });
    const walked = Math.hypot(G1.pos.x - p0.x, G1.pos.z - p0.z);
    const measured = walked / (sim.time - t0);
    expect(Math.abs(measured - GUARD.approachSpeed)).toBeLessThanOrEqual(1e-6);
    expect(Math.abs(minSpeed - GUARD.approachSpeed)).toBeLessThanOrEqual(1e-6);
    expect(Math.abs(maxSpeed - GUARD.approachSpeed)).toBeLessThanOrEqual(1e-6);
    expect(minClosing).toBeGreaterThan(GUARD.approachSpeed - 1e-6); // straight at the player
    expect(G1.shotsFired).toBeGreaterThan(0); // it attacks while closing in

    rec.until(() => getEnemyAi(G1).mode === 'strafe', 3);
    const dSwitch = distance(G1.pos, sim.player.pos);
    expect(dSwitch).toBeLessThanOrEqual(GUARD.approachBeyond);
    expect(dSwitch).toBeGreaterThan(GUARD.approachBeyond - GUARD.approachSpeed * TICK - 1e-6);
    rec.tick();
    let sMin = Infinity;
    let sMax = 0;
    let maxCos = 0;
    rec.run(4, () => {
      const b = bearing(sim, G1);
      const sp = speedXZ(G1);
      sMin = Math.min(sMin, sp);
      sMax = Math.max(sMax, sp);
      maxCos = Math.max(maxCos, Math.abs(G1.vel.x * b.x + G1.vel.z * b.z) / sp);
      expect(getEnemyAi(G1).mode).toBe('strafe');
    });
    expect(Math.abs(sMin - GUARD.strafeSpeed)).toBeLessThan(1e-3);
    expect(Math.abs(sMax - GUARD.strafeSpeed)).toBeLessThan(1e-3);
    expect(maxCos).toBeLessThan(0.01);
    expect(Math.abs(distance(G1.pos, sim.player.pos) - dSwitch)).toBeLessThan(0.01);

    // 100 m away: beyond the 90 m range — no perception, no movement, no shot.
    expect(G2.alert).toBe(false);
    expect(G2.hasLos).toBe(false);
    expect(G2.shotsFired).toBe(0);
    expect(G2.pos).toEqual(v3(0, GUARD.centerHeight, 100));
    log(
      `approach: ${walked.toFixed(6)} m in 2 s, measured speed ${measured.toFixed(9)} m/s (vel field ${minSpeed.toFixed(9)}–${maxSpeed.toFixed(9)}); ` +
        `switch to strafe at ${dSwitch.toFixed(3)} m; strafe speed ${sMin.toFixed(6)}–${sMax.toFixed(6)} m/s, max |cos(vel, line of sight)| ${maxCos.toExponential(2)}`,
    );
  });

  it('25–55 m: strafes at ~6 m/s perpendicular to the line of sight while attacking and changes side now and then', () => {
    const sim = mk({ enemies: [makeGuard('G1', 0, -40)], seed: 77 });
    sim.player.hp = BIG_HP;
    const G1 = sim.enemies[0];
    const rec = new Rec(sim);
    rec.tick();
    rec.tick();
    let path = 0;
    let prev = clone(G1.pos);
    let flips = 0;
    let side = 0;
    let offSpeed = 0;
    let ticks = 0;
    let cosSum = 0;
    let dMin = Infinity;
    let dMax = 0;
    rec.run(30, () => {
      const b = bearing(sim, G1);
      const sp = speedXZ(G1);
      ticks++;
      if (Math.abs(sp - GUARD.strafeSpeed) > 0.05) offSpeed++;
      if (sp > 0) cosSum += Math.abs(G1.vel.x * b.x + G1.vel.z * b.z) / sp;
      const s = Math.sign(b.x * G1.vel.z - b.z * G1.vel.x);
      if (s !== 0 && side !== 0 && s !== side) flips++;
      if (s !== 0) side = s;
      path += Math.hypot(G1.pos.x - prev.x, G1.pos.z - prev.z);
      prev = clone(G1.pos);
      const d = distance(G1.pos, sim.player.pos);
      dMin = Math.min(dMin, d);
      dMax = Math.max(dMax, d);
      expect(G1.hasLos).toBe(true);
    });
    expect(offSpeed / ticks).toBeLessThan(0.01);
    expect(cosSum / ticks).toBeLessThan(0.01);
    expect(Math.abs(path / 30 - GUARD.strafeSpeed)).toBeLessThan(0.05);
    expect(flips).toBeGreaterThanOrEqual(3);
    expect(dMin).toBeGreaterThan(39.9);
    expect(dMax).toBeLessThan(40.1);
    // Attacking the whole time: one burst of 3 every 1.2 s.
    expect(G1.shotsFired).toBeGreaterThanOrEqual(3 * Math.floor((30 - GUARD.firstShotDelay) / GUARD.burstPeriod));
    log(`strafe: ${path.toFixed(2)} m in 30 s (${(path / 30).toFixed(4)} m/s), mean |cos| ${(cosSum / ticks).toExponential(2)}, ${flips} side changes, distance ${dMin.toFixed(3)}–${dMax.toFixed(3)} m, ${G1.shotsFired} shots`);
  });

  it('strafing reverses before it would lose the line of sight (window between two walls) and keeps firing at full rate', () => {
    // Two walls leave a gap of 4 m at z = -30..-29: the guard sees the player only for |x| < about 2.7.
    const sim = mk({ enemies: [makeGuard('G1', 0, -40)], solids: [solid(-40, 0, -30, -2, 8, -29), solid(2, 0, -30, 40, 8, -29)], seed: 3 });
    sim.player.hp = BIG_HP;
    const G1 = sim.enemies[0];
    const rec = new Rec(sim);
    rec.tick();
    let xMin = Infinity;
    let xMax = -Infinity;
    let path = 0;
    let prev = clone(G1.pos);
    let flips = 0;
    let side = 0;
    let lastFlip = Number.NaN;
    let minGap = Infinity;
    let offSpeed = 0;
    rec.run(20, () => {
      expect(G1.hasLos).toBe(true);
      xMin = Math.min(xMin, G1.pos.x);
      xMax = Math.max(xMax, G1.pos.x);
      path += Math.hypot(G1.pos.x - prev.x, G1.pos.z - prev.z);
      prev = clone(G1.pos);
      const sp = speedXZ(G1);
      // It either runs at the strafe speed or stands at the end of a leg — never anything in between.
      if (sp > 0.01 && Math.abs(sp - GUARD.strafeSpeed) > 0.05) offSpeed++;
      const s = Math.sign(G1.vel.x);
      if (s !== 0 && side !== 0 && s !== side) {
        flips++;
        if (lastFlip === lastFlip) minGap = Math.min(minGap, sim.time - lastFlip);
        lastFlip = sim.time;
      }
      if (s !== 0) side = s;
    });
    expect(xMin).toBeGreaterThan(-2.7);
    expect(xMax).toBeLessThan(2.7);
    expect(xMax - xMin).toBeGreaterThan(4); // it uses the window instead of freezing
    // The window is shorter than a full leg (9 m): the guard runs across it (≈ 0.75 s), stands at the end for the
    // rest of strafeMinLegSeconds and runs back — a turn every 1.5 s, not every 0.75 s (review finding: a guard
    // that flips its velocity faster than a bullet flies cannot be hit by any constant-velocity lead).
    expect(minGap).toBeGreaterThanOrEqual(ENEMY_TUNING.strafeMinLegSeconds - 1e-6);
    expect(flips).toBeGreaterThanOrEqual(Math.floor(20 / ENEMY_TUNING.strafeMinLegSeconds) - 2);
    expect(path).toBeGreaterThan(50);
    expect(offSpeed).toBeLessThanOrEqual(2 * flips + 2);
    expect(G1.shotsFired).toBe(3 * (Math.floor((20 - GUARD.firstShotDelay) / GUARD.burstPeriod) + 1));
    log(`LOS-keeping strafe: x stayed in [${xMin.toFixed(2)}, ${xMax.toFixed(2)}] (window ±2.7 m), ${flips} reversals (never closer than ${minGap.toFixed(2)} s apart), ${path.toFixed(1)} m walked in 20 s, line of sight never lost, ${G1.shotsFired} shots`);
  });

  it('below 15 m it backs off at 8 m/s, between 15 and 25 m it keeps opening the range, then it strafes', () => {
    const sim = mk({ enemies: [makeGuard('G1', 0, -10)] });
    sim.player.hp = BIG_HP;
    const G1 = sim.enemies[0];
    const rec = new Rec(sim);
    rec.tick();
    expect(getEnemyAi(G1).mode).toBe('retreat');
    const t0 = sim.time;
    let t15 = -1;
    let t25 = -1;
    let retreatMinAway = Infinity;
    let adjustMinAway = Infinity;
    let adjustSpeedMin = Infinity;
    let adjustSpeedMax = 0;
    let maxSpeed = 0;
    let prevD = distance(G1.pos, sim.player.pos);
    let prevMode = getEnemyAi(G1).mode;
    rec.until(
      () => t25 >= 0,
      8,
      () => {
        const b = bearing(sim, G1);
        const d = distance(G1.pos, sim.player.pos);
        const sp = speedXZ(G1);
        const away = -(G1.vel.x * b.x + G1.vel.z * b.z);
        maxSpeed = Math.max(maxSpeed, sp);
        // (the velocity of a tick belongs to the decision taken at the end of the previous tick)
        if (prevMode === 'retreat') {
          expect(Math.abs(sp - GUARD.retreatSpeed)).toBeLessThanOrEqual(1e-6);
          retreatMinAway = Math.min(retreatMinAway, away);
        } else if (prevMode === 'adjust') {
          adjustMinAway = Math.min(adjustMinAway, away);
          adjustSpeedMin = Math.min(adjustSpeedMin, sp);
          adjustSpeedMax = Math.max(adjustSpeedMax, sp);
        }
        expect(d).toBeGreaterThan(prevD - 1e-9);
        prevD = d;
        prevMode = getEnemyAi(G1).mode;
        if (t15 < 0 && d >= GUARD.retreatBelow) t15 = sim.time;
        if (t25 < 0 && d >= GUARD.strafeMin) t25 = sim.time;
      },
    );
    expect(retreatMinAway).toBeGreaterThan(GUARD.retreatSpeed - 0.01); // straight away from the player
    expect(t15 - t0).toBeLessThanOrEqual((GUARD.retreatBelow - 10) / GUARD.retreatSpeed + 0.05);
    expect(adjustMinAway).toBeGreaterThan(3);
    expect(adjustSpeedMin).toBeGreaterThan(ENEMY_TUNING.adjustSpeed - 1e-6);
    expect(adjustSpeedMax).toBeLessThanOrEqual(GUARD.retreatSpeed + 1e-6);
    expect(maxSpeed).toBeLessThanOrEqual(GUARD.retreatSpeed + 1e-6);
    rec.run(0.1);
    expect(getEnemyAi(G1).mode).toBe('strafe');
    expect(G1.shotsFired).toBeGreaterThan(0);
    log(
      `retreat: 10 m → 15 m in ${(t15 - t0).toFixed(3)} s (radial ${retreatMinAway.toFixed(3)} m/s), 15 → 25 m in ${(t25 - t15).toFixed(3)} s ` +
        `(speed ${adjustSpeedMin.toFixed(3)}–${adjustSpeedMax.toFixed(3)} m/s, radial ≥ ${adjustMinAway.toFixed(3)} m/s), then strafe`,
    );
  });

  it('a cornered guard (wall behind) still gets away from a close player instead of pressing into the wall', () => {
    // Wall right behind the guard: the straight retreat is not walkable, a side bearing is.
    const sim = mk({ enemies: [makeGuard('G1', 0, -10)], solids: [solid(-30, 0, -13.5, 30, 6, -12.5)] });
    sim.player.hp = BIG_HP;
    const G1 = sim.enemies[0];
    const rec = new Rec(sim);
    let still = 0;
    rec.until(
      () => distance(G1.pos, sim.player.pos) >= GUARD.retreatBelow,
      4,
      () => {
        if (speedXZ(G1) < 1) still++;
        expect(sim.world.overlapsBox(G1.pos, AGENT_HALF)).toBe(false);
      },
    );
    expect(still).toBeLessThanOrEqual(3);
    log(`cornered retreat: out of the 15 m zone after ${sim.time.toFixed(3)} s, ${still} ticks slower than 1 m/s`);
  });

  it('a guard placed just outside the walkable area first steps onto it (collision-checked), then behaves normally', () => {
    // 5 cm between the guard's box and the wall: it fits, but the 1 m lattice has no walkable hull there.
    const sim = mk({ enemies: [makeGuard('G1', -1.25, -40)], solids: [solid(0, 0, -50, 1, 6, -30)], start: v3(-12, STAND_Y, 0) });
    sim.player.hp = BIG_HP;
    const G1 = sim.enemies[0];
    expect(sim.world.overlapsBox(G1.pos, AGENT_HALF)).toBe(false);
    expect(sim.nav.isWalkable(G1.pos)).toBe(false);
    const rec = new Rec(sim);
    let onGridAt = -1;
    rec.run(6, () => {
      expect(sim.world.overlapsBox(G1.pos, AGENT_HALF)).toBe(false);
      if (onGridAt < 0 && sim.nav.isWalkable(G1.pos)) onGridAt = sim.time;
      if (onGridAt >= 0) expect(sim.nav.isWalkable(G1.pos)).toBe(true);
      expectFiniteState(sim);
    });
    expect(onGridAt).toBeGreaterThan(0);
    expect(onGridAt).toBeLessThan(0.2);
    expect(getEnemyAi(G1).mode).toBe('strafe');
    expect(G1.shotsFired).toBeGreaterThan(9);
    log(`off-grid spawn: on the walkable area after ${onGridAt.toFixed(4)} s, then ${getEnemyAi(G1).mode}`);
  });

  it('a guard on a platform never walks off the ledge, with or without a route to the player', () => {
    const top = 5;
    const sim = mk({ enemies: [makeGuard('G1', 0, -40, top)], solids: [solid(-6, 0, -46, 6, top, -34)] });
    sim.player.hp = BIG_HP;
    const G1 = sim.enemies[0];
    const rec = new Rec(sim);
    let path = 0;
    let prev = clone(G1.pos);
    const each = (): void => {
      expect(G1.pos.y).toBe(top + GUARD.centerHeight);
      expect(Math.abs(G1.pos.x)).toBeLessThanOrEqual(6);
      expect(G1.pos.z).toBeGreaterThanOrEqual(-46);
      expect(G1.pos.z).toBeLessThanOrEqual(-34);
      expect(sim.nav.isWalkable(G1.pos)).toBe(true);
      path += Math.hypot(G1.pos.x - prev.x, G1.pos.z - prev.z);
      prev = clone(G1.pos);
    };
    rec.run(12, each);
    expect(G1.hasLos).toBe(true);
    expect(path).toBeGreaterThan(30); // it does strafe up there
    const shots = G1.shotsFired;
    expect(shots).toBeGreaterThan(20);
    // Walk away to more than 55 m: it would approach, but there is no way down.
    sim.input.moveZ = -1;
    rec.until(() => distance(G1.pos, sim.player.pos) > 60, 6, each);
    sim.input.moveZ = 0;
    rec.run(6, each);
    expect(G1.shotsFired).toBeGreaterThan(shots);
    log(`ledge: guard stayed on the 12 m × 12 m platform for ${sim.time.toFixed(1)} s, walked ${path.toFixed(1)} m on it, ${G1.shotsFired} shots`);
  });

  it('after losing sight it starts moving within 0.5 s, walks around the wall and regains the line of sight', () => {
    const wall = solid(-15, 0, -11, 15, 8, -10);
    const sim = mk({ enemies: [makeGuard('G1', 0, -45)], solids: [wall], start: v3(20, STAND_Y, -5) });
    sim.player.hp = BIG_HP;
    const G1 = sim.enemies[0];
    const rec = new Rec(sim);
    const safe = (): void => {
      expect(sim.world.overlapsBox(G1.pos, AGENT_HALF)).toBe(false);
      expect(G1.hasLos).toBe(losTruth(sim, G1));
    };
    rec.run(1, safe);
    expect(G1.hasLos).toBe(true);
    sim.input.moveX = -1; // behind the wall
    rec.until(() => !G1.hasLos, 2, safe);
    const lostAt = G1.losLostAt as number;
    const known = clone(G1.lastKnownPlayerPos as V3);
    const shotsAtLoss = G1.shotsFired;
    let firstMoveAt = -1;
    let chaseTicks = 0;
    let fastTicks = 0;
    let maxKnownError = 0;
    rec.until(
      () => G1.hasLos,
      ENEMY_AI.memorySeconds,
      () => {
        safe();
        if (sim.player.pos.x <= 0) sim.input.moveX = 0;
        if (G1.hasLos) return;
        if (firstMoveAt < 0 && speedXZ(G1) > 1) firstMoveAt = sim.time;
        chaseTicks++;
        if (Math.abs(speedXZ(G1) - GUARD.approachSpeed) < 1e-6) fastTicks++;
        // It keeps heading for where it last saw the player, not for where the player is now.
        expect(G1.lastKnownPlayerPos).toEqual(known);
        maxKnownError = Math.max(maxKnownError, Math.abs(known.x - sim.player.pos.x));
        expect(getEnemyAi(G1).mode).toBe('chase');
        expect(G1.alert).toBe(true);
      },
    );
    const reAt = getEnemyAi(G1).losSince as number;
    expect(firstMoveAt - lostAt).toBeLessThanOrEqual(ENEMY_AI.reacquireStartSeconds);
    expect(fastTicks / chaseTicks).toBeGreaterThan(0.95); // no grinding against the wall
    expect(maxKnownError).toBeGreaterThan(10);
    expect(G1.shotsFired).toBeGreaterThanOrEqual(shotsAtLoss); // (a running burst may have ended at the loss)
    const hp = sim.player.hp;
    rec.run(2, safe);
    expect(G1.shotsFired).toBeGreaterThan(shotsAtLoss);
    expect(sim.player.hp).toBeLessThan(hp);
    log(
      `re-acquire: LOS lost ${lostAt.toFixed(3)} s, moving after ${(firstMoveAt - lostAt).toFixed(4)} s, ${((fastTicks / chaseTicks) * 100).toFixed(1)}% of the chase at 8 m/s, ` +
        `LOS regained ${reAt.toFixed(3)} s (${(reAt - lostAt).toFixed(2)} s later) at (${G1.pos.x.toFixed(1)}, ${G1.pos.z.toFixed(1)}); memory stayed at x = ${known.x.toFixed(2)} while the player went to x = ${sim.player.pos.x.toFixed(2)}`,
    );
  });

  it('no route to the last known position (other side of a gap): it still moves within 0.5 s, to a spot overlooking it, and never leaves its floor', () => {
    // Main floor 100 m × 100 m; the player stands on a separate slab beyond a 10 m gap, 45 m from the edge.
    const sim = mk({
      floorSize: 100,
      enemies: [makeGuard('G1', 0, -20)],
      solids: [{ ...solid(-30, -1, -130, 30, 0, -60), material: 'floor' }, solid(5, 0, -92, 25, 8, -91)],
      start: v3(0, STAND_Y, -95),
    });
    sim.player.hp = BIG_HP;
    const G1 = sim.enemies[0];
    const rec = new Rec(sim);
    const onFloor = (): void => {
      expect(Math.abs(G1.pos.x)).toBeLessThanOrEqual(50);
      expect(Math.abs(G1.pos.z)).toBeLessThanOrEqual(50);
      expect(G1.pos.y).toBe(GUARD.centerHeight);
      expect(sim.nav.isWalkable(G1.pos)).toBe(true);
      expect(G1.hasLos).toBe(losTruth(sim, G1));
    };
    // 75 m away with a clear line and no way over: it closes in on its own floor (the edge is 45 m from the
    // player) at 8 m/s until it is within 55 m, and only then strafes. (SPEC §2.3: beyond 55 m it approaches.)
    rec.tick();
    expect(G1.hasLos).toBe(true);
    expect(sim.nav.findPath(G1.pos, sim.player.pos, 30)).toBeNull();
    const d0 = distance(G1.pos, sim.player.pos);
    expect(d0).toBeGreaterThan(74);
    const tA = sim.time;
    rec.until(
      () => getEnemyAi(G1).mode === 'strafe',
      4,
      () => {
        onFloor();
        if (getEnemyAi(G1).mode === 'approach') expect(Math.abs(speedXZ(G1) - GUARD.approachSpeed)).toBeLessThan(1e-6);
      },
    );
    const dA = distance(G1.pos, sim.player.pos);
    expect(dA).toBeLessThanOrEqual(GUARD.approachBeyond);
    expect(dA).toBeGreaterThan(GUARD.approachBeyond - GUARD.approachSpeed * TICK - 1e-6);
    // straight at the player the whole way: (d0 − 55) metres at 8 m/s
    const approachSeconds = sim.time - tA;
    expect(approachSeconds).toBeLessThan((d0 - GUARD.approachBeyond) / GUARD.approachSpeed + 0.05);
    expect(sim.nav.findPath(G1.pos, sim.player.pos, 30)).toBeNull();
    rec.run(2, onFloor);
    expect(G1.hasLos).toBe(true);
    expect(getEnemyAi(G1).mode).toBe('strafe');
    expect(G1.shotsFired).toBeGreaterThan(0);
    sim.input.moveX = 1; // behind the wall on the far slab
    rec.until(() => !G1.hasLos, 3, onFloor);
    const lostAt = G1.losLostAt as number;
    const knownAt = G1.lastKnownAt as number;
    const known = clone(G1.lastKnownPlayerPos as V3);
    const from = clone(G1.pos);
    let firstMoveAt = -1;
    const modes = new Set<string>();
    let far = 0;
    rec.until(
      () => !G1.alert,
      9,
      () => {
        onFloor();
        if (sim.player.pos.x >= 15) sim.input.moveX = 0;
        if (!G1.alert) return;
        expect(G1.hasLos).toBe(false);
        expect(G1.lastKnownPlayerPos).toEqual(known);
        if (firstMoveAt < 0 && speedXZ(G1) > 1) firstMoveAt = sim.time;
        modes.add(getEnemyAi(G1).mode);
        far = Math.max(far, Math.hypot(G1.pos.x - from.x, G1.pos.z - from.z));
      },
    );
    expect(firstMoveAt - lostAt).toBeLessThanOrEqual(ENEMY_AI.reacquireStartSeconds);
    expect(far).toBeGreaterThan(3);
    expect(modes.has('chase')).toBe(true);
    expect(sim.time).toBeLessThanOrEqual(knownAt + ENEMY_AI.memorySeconds + TICK + 1e-9);
    rec.run(1, () => {
      onFloor();
      expect(speedXZ(G1)).toBe(0);
    });
    log(
      `no route: approached from ${d0.toFixed(1)} m to ${dA.toFixed(2)} m in ${approachSeconds.toFixed(2)} s on its own floor; LOS lost ${lostAt.toFixed(3)} s, moving after ${(firstMoveAt - lostAt).toFixed(4)} s, ` +
        `went up to ${far.toFixed(1)} m from where it stood (modes ${[...modes].join(', ')}), stayed on its floor, idle at ${(sim.time - 1).toFixed(3)} s`,
    );
  });

  it('closed barriers block sight and movement; the opened barrier is a doorway for bullets and guards', () => {
    const door: Box = { min: v3(-3, 0, -20.5), max: v3(3, 8, -19.5) };
    const control: EnemyDef = { ...makeTurret('TC', 60, 60), isGateControl: true, barrierId: 'B1' };
    const sim = mk({
      enemies: [makeGuard('G1', 0, -40), control],
      solids: [solid(-45, 0, -20.5, -3, 8, -19.5), solid(3, 0, -20.5, 45, 8, -19.5), solid(50, 0, 50, 56, 8, 56)],
      edit: (stage) => {
        stage.barriers.push({ id: 'B1', name: 'B1', box: door, controlEnemyId: 'TC', fromSectorId: 'T00', toSectorId: 'T00' });
      },
    });
    sim.player.hp = BIG_HP;
    const G1 = sim.enemyById.get('G1') as EnemyState;
    const TC = sim.enemyById.get('TC') as EnemyState;
    const rec = new Rec(sim);
    const safe = (): void => {
      expect(sim.world.overlapsBox(G1.pos, AGENT_HALF)).toBe(false);
    };
    rec.run(3, safe);
    expect(G1.alert).toBe(false);
    expect(G1.shotsFired).toBe(0);
    expect(TC.hasLos).toBe(false); // hidden behind its own block
    // Destroying the control turret opens the barrier (world + nav).
    sim.damageEnemy(TC, 1e9);
    expect(sim.world.isBarrierOpen('B1')).toBe(true);
    expect(sim.nav.isBarrierOpen('B1')).toBe(true);
    rec.tick();
    expect(G1.hasLos).toBe(true);
    const tSight = getEnemyAi(G1).firstSightAt as number;
    rec.until(() => G1.shotsFired === 1, 1, safe);
    expect(Math.abs((G1.lastShotAt as number) - (tSight + GUARD.firstShotDelay))).toBeLessThanOrEqual(1e-6);
    rec.run(1.5, safe);
    expect(rec.dmg.some((d) => d.from === 'G1')).toBe(true);
    // Hide close to the south face of the wall, far to the side: from the north that spot can only be seen
    // from inside the doorway, so the guard has to come to (and into) the opening.
    let inDoorAt = -1;
    let inDoorX = Number.NaN;
    let lostCount = 0;
    let seeing = true;
    const watch = (): void => {
      safe();
      if (seeing && !G1.hasLos) lostCount++;
      seeing = G1.hasLos;
      const inDoor = G1.pos.z + GUARD.radius > door.min.z && G1.pos.z - GUARD.radius < door.max.z;
      if (inDoor) {
        // Where the closed barrier stood: only possible because it is open, and only inside the opening.
        expect(Math.abs(G1.pos.x)).toBeLessThanOrEqual(3 - GUARD.radius + 1e-6);
        if (inDoorAt < 0) {
          inDoorAt = sim.time;
          inDoorX = G1.pos.x;
        }
      }
    };
    sim.input.moveZ = 1;
    rec.until(() => sim.player.pos.z <= -17, 3, watch);
    sim.input.moveZ = 0;
    sim.input.moveX = 1;
    rec.until(() => sim.player.pos.x >= 30, 5, watch);
    sim.input.moveX = 0;
    if (!(inDoorAt > 0 && G1.hasLos)) rec.until(() => inDoorAt > 0 && G1.hasLos, ENEMY_AI.memorySeconds, watch);
    expect(lostCount).toBeGreaterThanOrEqual(1);
    expect(inDoorAt).toBeGreaterThan(0);
    expect(TC.alive).toBe(false);
    expect(TC.shotsFired).toBe(0);
    log(`barrier: guard saw the player ${tSight.toFixed(3)} s (right after the barrier opened); chasing, it stood in the doorway at ${inDoorAt.toFixed(3)} s (x = ${inDoorX.toFixed(2)}) and regained sight at ${sim.time.toFixed(3)} s`);
  });

  it('guards never enter solids or each other in a long fight around obstacles (5 guards + 1 turret, moving player)', () => {
    const solids = [
      solid(-12, 0, -22, -8, 6, -18),
      solid(8, 0, -22, 12, 6, -18),
      solid(-30, 0, -2, -18, 6, 2),
      solid(18, 0, -2, 30, 6, 2),
      solid(-4, 0, 16, 4, 6, 20),
      solid(-25, 0, -40, 25, 1, -39), // kerb: stops guards, not bullets at muzzle height
      solid(-2, 0, -32, 2, 6, -28),
    ];
    const sim = mk({
      enemies: [makeGuard('G1', -20, -30), makeGuard('G2', 20, -30), makeGuard('G3', 0, -50), makeGuard('G4', -35, 15), makeGuard('G5', 35, 15), makeTurret('T1', 0, 35)],
      solids,
      seed: 4711,
    });
    sim.player.hp = BIG_HP;
    const rec = new Rec(sim);
    const guards = sim.enemies.filter((e) => e.kind === 'guard');
    const walked = new Map<string, number>(guards.map((g) => [g.id, 0]));
    const prev = new Map<string, V3>(guards.map((g) => [g.id, clone(g.pos)]));
    const modes = new Map<string, number>();
    let minPair = Infinity;
    let maxSpeed = 0;
    let losLosses = 0;
    const hadLos = new Map<string, boolean>();
    // The player walks a fixed zig-zag through the obstacles.
    const legs: Array<[number, number]> = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [0, -1], [1, -1], [-1, 0], [0, 1], [1, 0], [-1, -1]];
    const seconds = 60;
    const n = Math.round(seconds / TICK);
    for (let i = 0; i < n; i++) {
      const leg = legs[Math.floor((i * TICK) / 2.5) % legs.length];
      sim.input.moveX = leg[0];
      sim.input.moveZ = leg[1];
      rec.tick();
      expectFiniteState(sim);
      for (const g of guards) {
        expect(sim.world.overlapsBox(g.pos, AGENT_HALF)).toBe(false);
        expect(sim.nav.isWalkable(g.pos)).toBe(true);
        expect(g.pos.y).toBe(GUARD.centerHeight);
        const sp = speedXZ(g);
        maxSpeed = Math.max(maxSpeed, sp);
        const p = prev.get(g.id) as V3;
        walked.set(g.id, (walked.get(g.id) as number) + Math.hypot(g.pos.x - p.x, g.pos.z - p.z));
        p.x = g.pos.x;
        p.z = g.pos.z;
        const mode = getEnemyAi(g).mode;
        modes.set(mode, (modes.get(mode) ?? 0) + 1);
      }
      for (const e of sim.enemies) {
        expect(e.hasLos).toBe(losTruth(sim, e));
        if (hadLos.get(e.id) && !e.hasLos) losLosses++;
        hadLos.set(e.id, e.hasLos);
      }
      for (let a = 0; a < sim.enemies.length; a++) {
        for (let b = a + 1; b < sim.enemies.length; b++) {
          const ea = sim.enemies[a];
          const eb = sim.enemies[b];
          const d = distance(ea.pos, eb.pos);
          minPair = Math.min(minPair, d - ea.radius - eb.radius);
        }
      }
    }
    expect(minPair).toBeGreaterThanOrEqual(0);
    expect(maxSpeed).toBeLessThanOrEqual(GUARD.approachSpeed + 1e-6);
    for (const g of guards) expect(walked.get(g.id) as number).toBeGreaterThan(60);
    expect(losLosses).toBeGreaterThan(5);
    // The attack schedule holds for everybody the whole time: never more than one burst per period.
    for (const e of sim.enemies) {
      const cfg = ENEMIES[e.kind];
      const times = rec.shotsOf(e.id).map((s) => s.t);
      expect(times.length).toBeGreaterThan(10);
      for (let i = 0; i + cfg.burstCount < times.length; i++) {
        expect(times[i + cfg.burstCount] - times[i]).toBeGreaterThanOrEqual(cfg.burstPeriod - 1e-9);
      }
      for (let i = 1; i < times.length; i++) {
        const gap = times[i] - times[i - 1];
        // Either the next shot(s) of the same burst or a later burst.
        const steps = gap / cfg.burstInterval;
        const sameBurst = Math.abs(steps - Math.round(steps)) < 1e-6 && Math.round(steps) < cfg.burstCount;
        expect(sameBurst || gap >= cfg.burstPeriod - (cfg.burstCount - 1) * cfg.burstInterval - 1e-9).toBe(true);
      }
    }
    expect(rec.maxPathError).toBeLessThan(1e-9);
    log(
      `long fight (60 s): min clearance between two enemy spheres ${minPair.toFixed(3)} m, max guard speed ${maxSpeed.toFixed(6)} m/s, ` +
        `walked ${guards.map((g) => `${g.id} ${(walked.get(g.id) as number).toFixed(0)} m`).join(', ')}, ${losLosses} LOS losses, ${rec.shots.length} shots, ` +
        `mode ticks ${[...modes].map(([m, c]) => `${m} ${c}`).join(', ')}`,
    );
  });
});

// ───────────────────────────── review regressions: movement ─────────────────────────────

describe('guard movement around other enemies, on other levels and in narrow views (review findings)', () => {
  it('strafing head-on into a standing enemy beside the edge of the walkable area: it stops, it does not tremble (120 Hz reversal)', () => {
    // Player at the origin, the guard 40.45 m east of it: it strafes north / south on that circle. The wall
    // at x = 42 ends the walkable area at x = 40.5, 5 cm beside the guard. Standing enemies 3.3 m to the
    // north and to the south: whichever way it strafes it meets one head-on after half a metre, with no room
    // to step aside. (Before the fix: a side-step every tick, alternately to either side — a guard that
    // "ran" 6 m/s on the spot, its velocity reversing 120 times a second.)
    for (const seed of [1, 2, 3]) {
      const sim = mk({
        enemies: [makeGuard('G1', 40.45, 0), makeTarget('X1', v3(40.4, GUARD.centerHeight, -3.3), v3(), GUARD.radius), makeTarget('X2', v3(40.4, GUARD.centerHeight, 3.3), v3(), GUARD.radius)],
        solids: [solid(42, 0, -60, 43, 8, 60)],
        seed,
      });
      sim.player.hp = BIG_HP;
      const G1 = sim.enemies[0];
      const rec = new Rec(sim);
      const m = new Motion(sim, G1);
      let minClear = Infinity;
      rec.run(20, () => {
        m.sample();
        minClear = Math.min(minClear, clearance(sim, G1));
        expect(G1.hasLos).toBe(true);
        expect(sim.nav.isWalkable(G1.pos)).toBe(true);
      });
      expect(m.longestRun).toBeLessThanOrEqual(1);
      expect(m.reversals).toBeLessThanOrEqual(2);
      expect(m.ghostFrames).toBe(0);
      expect(m.shuffleWindows).toBe(0);
      expect(m.velMismatch).toBe(0);
      expect(m.path).toBeLessThan(2); // 1 m of room between the two: nothing to strafe in
      expect(minClear).toBeGreaterThanOrEqual(-1e-9);
      expect(getEnemyAi(G1).oscCount).toBe(0); // the direction watch never had to step in
      expect(G1.shotsFired).toBe(3 * (Math.floor((20 - GUARD.firstShotDelay) / GUARD.burstPeriod) + 1)); // firing on schedule
      if (seed === 1) log(`head-on at the edge: ${m.reversals} reversals in 20 s, ${m.path.toFixed(2)} m walked, min clearance ${minClear.toExponential(1)} m, ${G1.shotsFired} shots`);
    }
  });

  it('strafing next to one standing enemy: it turns before it, sweeps the free side and never comes nearer than the separation distance', () => {
    const sim = mk({
      enemies: [makeGuard('G1', 40.45, 0), makeTarget('X1', v3(40.4, GUARD.centerHeight, -3.3), v3(), GUARD.radius)],
      solids: [solid(42, 0, -60, 43, 8, 60)],
      seed: 9,
    });
    sim.player.hp = BIG_HP;
    const G1 = sim.enemies[0];
    const rec = new Rec(sim);
    const m = new Motion(sim, G1);
    let minClear = Infinity;
    rec.run(30, () => {
      m.sample();
      minClear = Math.min(minClear, clearance(sim, G1));
      expect(G1.hasLos).toBe(true);
    });
    expect(minClear).toBeGreaterThanOrEqual(-1e-9);
    expect(m.longestRun).toBeLessThanOrEqual(1);
    expect(m.reversals).toBeGreaterThanOrEqual(4);
    expect(m.minGap).toBeGreaterThanOrEqual(0.4);
    expect(m.ghostFrames).toBeLessThanOrEqual(m.reversals); // only the frame of a turn itself
    expect(m.shuffleWindows).toBe(0);
    expect(m.path / 30).toBeGreaterThan(GUARD.strafeSpeed * 0.95);
    expect(m.zMax - m.zMin).toBeGreaterThan(8);
    expect(getEnemyAi(G1).oscCount).toBe(0);
    log(`beside one enemy: ${m.reversals} turns in 30 s (never closer than ${m.minGap.toFixed(2)} s apart), ${m.path.toFixed(1)} m walked over z ${m.zMin.toFixed(1)} … ${m.zMax.toFixed(1)}, min clearance ${minClear.toExponential(1)} m`);
  });

  it('a chasing guard whose way is blocked by a standing enemy goes round through the other door; with one door it waits, then looks around — never trembling', () => {
    // Wall across the floor at z = −20 with a door at x = 0 (6 m wide) in which an enemy stands, and (first
    // stage) a second door at x = 20. The guard north of the wall sees the player through the first door;
    // the player then steps aside behind the wall. The way to the last known position is the blocked door.
    const stageWith = (secondDoor: boolean): Sim =>
      mk({
        enemies: [makeGuard('C', 0, -45), makeTarget('X', v3(0, GUARD.centerHeight, -20), v3(), GUARD.radius)],
        solids: secondDoor
          ? [solid(-100, 0, -21, -3, 8, -19), solid(3, 0, -21, 17, 8, -19), solid(23, 0, -21, 100, 8, -19)]
          : [solid(-100, 0, -21, -3, 8, -19), solid(3, 0, -21, 100, 8, -19)],
        start: v3(0, STAND_Y, -10),
        floorSize: 220,
      });
    const hide = (sim: Sim, rec: Rec, C: EnemyState, each: () => void): void => {
      rec.run(1, each);
      expect(C.hasLos).toBe(true);
      sim.input.moveX = 1;
      rec.until(() => sim.player.pos.x >= 40, 6, each);
      sim.input.moveX = 0;
    };
    {
      const sim = stageWith(true);
      sim.player.hp = BIG_HP;
      const C = sim.enemyById.get('C') as EnemyState;
      const rec = new Rec(sim);
      const m = new Motion(sim, C);
      let minClear = Infinity;
      let lostAt = -1;
      let heldUpAt = -1;
      const each = (): void => {
        m.sample();
        minClear = Math.min(minClear, clearance(sim, C));
        expect(sim.world.overlapsBox(C.pos, AGENT_HALF)).toBe(false);
        expect(C.hasLos).toBe(losTruth(sim, C));
        if (lostAt < 0 && C.losLostAt !== null) lostAt = C.losLostAt;
        if (heldUpAt < 0 && lostAt >= 0 && speedXZ(C) === 0) heldUpAt = sim.time;
      };
      hide(sim, rec, C, each);
      expect(lostAt).toBeGreaterThan(0);
      // (Before the fix it "ran" 8 m/s on the spot in front of the blocked door until the memory ran out.)
      if (!(heldUpAt > 0 && C.hasLos)) rec.until(() => heldUpAt > 0 && C.hasLos, 6, each);
      // It was held up at the first door, went east along the wall and sees the player through the second one.
      expect(heldUpAt).toBeGreaterThan(lostAt);
      expect(C.pos.x).toBeGreaterThan(10);
      expect(C.pos.z).toBeLessThan(-20);
      expect(sim.time - heldUpAt).toBeLessThan(ENEMY_TUNING.pathStuckSeconds + 0.1 + 20 / GUARD.approachSpeed);
      expect(minClear).toBeGreaterThanOrEqual(-1e-9);
      expect(m.longestRun).toBeLessThanOrEqual(1);
      expect(m.reversals).toBeLessThanOrEqual(3);
      expect(m.shuffleWindows).toBe(0);
      expect(m.ghostFrames).toBeLessThanOrEqual(m.reversals);
      expect(getEnemyAi(C).oscCount).toBe(0);
      const shots = C.shotsFired;
      rec.run(2, each);
      expect(C.shotsFired).toBeGreaterThan(shots);
      log(`blocked door: sight lost at ${lostAt.toFixed(2)} s, held up at the door at ${heldUpAt.toFixed(2)} s; C went round towards the second door and saw the player again ${(sim.time - 2 - heldUpAt).toFixed(2)} s later from (${C.pos.x.toFixed(1)}, ${C.pos.z.toFixed(1)}); min clearance ${minClear.toExponential(1)} m, ${m.reversals} turns`);
    }
    {
      const sim = stageWith(false);
      sim.player.hp = BIG_HP;
      const C = sim.enemyById.get('C') as EnemyState;
      const rec = new Rec(sim);
      const m = new Motion(sim, C);
      let minClear = Infinity;
      const modes = new Set<string>();
      let waited = 0;
      let lost = false;
      const each = (): void => {
        m.sample();
        minClear = Math.min(minClear, clearance(sim, C));
        expect(C.pos.z).toBeLessThan(-21); // it never squeezes past the enemy in the door
        expect(sim.world.overlapsBox(C.pos, AGENT_HALF)).toBe(false);
        if (!lost) return;
        modes.add(getEnemyAi(C).mode);
        if (getEnemyAi(C).mode === 'chase' && speedXZ(C) === 0) waited++;
      };
      hide(sim, rec, C, each);
      lost = !C.hasLos;
      expect(lost).toBe(true);
      rec.run(6, each);
      expect(minClear).toBeGreaterThanOrEqual(-1e-9);
      expect(m.longestRun).toBeLessThanOrEqual(1);
      expect(m.shuffleWindows).toBe(0);
      expect(m.ghostFrames).toBeLessThanOrEqual(m.reversals);
      expect(getEnemyAi(C).oscCount).toBe(0);
      expect(waited * TICK).toBeLessThan(ENEMY_TUNING.blockedGiveUp + 1); // it queues with zero velocity for a moment …
      expect(modes.has('search')).toBe(true); // … and then looks around instead of pressing on
      log(`single door: C waited ${(waited * TICK).toFixed(2)} s behind the enemy in the door, then searched (modes ${[...modes].join(', ')}), ${m.reversals} turns, min clearance ${minClear.toExponential(1)} m`);
    }
  });

  it('a guard never walks through a living turret: the approach leads round it at full speed; a destroyed turret is no obstacle', () => {
    const run = (kill: boolean): { minDist: number; seconds: number; slow: number; maxOff: number; minSpeed: number } => {
      const sim = mk({ enemies: [makeGuard('G1', 0, -85), makeTurret('T1', 0, -70)] });
      sim.player.hp = BIG_HP;
      const G1 = sim.enemyById.get('G1') as EnemyState;
      const T1 = sim.enemyById.get('T1') as EnemyState;
      if (kill) sim.damageEnemy(T1, 1e9);
      const rec = new Rec(sim);
      let minDist = Infinity;
      let slow = 0;
      let maxOff = 0;
      let minSpeed = Infinity;
      rec.tick();
      rec.tick();
      const m = new Motion(sim, G1);
      const t0 = sim.time;
      rec.until(
        () => getEnemyAi(G1).mode === 'strafe',
        6,
        () => {
          m.sample();
          minDist = Math.min(minDist, distance(G1.pos, T1.pos));
          maxOff = Math.max(maxOff, Math.abs(G1.pos.x));
          if (getEnemyAi(G1).mode !== 'approach') return;
          minSpeed = Math.min(minSpeed, speedXZ(G1));
          if (speedXZ(G1) < GUARD.approachSpeed - 1e-6) slow++;
        },
      );
      expect(m.reversals).toBe(0);
      expect(m.velMismatch).toBeLessThanOrEqual(4); // corners of the path, the switch to the strafe
      expect(getEnemyAi(G1).oscCount).toBe(0);
      return { minDist, seconds: sim.time - t0, slow, maxOff, minSpeed };
    };
    const keep = GUARD.radius + TURRET.radius + ENEMY_TUNING.separationMargin;
    const alive = run(false);
    const dead = run(true);
    expect(alive.minDist).toBeGreaterThanOrEqual(keep - 1e-9);
    expect(alive.maxOff).toBeGreaterThan(keep - 0.5); // it went round
    expect(alive.slow).toBeLessThanOrEqual(3); // without stopping at the turret (a tick that turns a corner is a chord)
    expect(alive.minSpeed).toBeGreaterThan(GUARD.approachSpeed - 0.2);
    expect(alive.seconds).toBeLessThan(30 / GUARD.approachSpeed + 0.5);
    expect(dead.maxOff).toBeLessThan(1e-6); // straight through where the turret was
    expect(dead.minDist).toBeLessThan(1);
    expect(dead.seconds).toBeLessThanOrEqual(alive.seconds);
    log(`turret in the way: passed it at ${alive.minDist.toFixed(3)} m (keep-out ${keep.toFixed(1)} m), ${alive.seconds.toFixed(3)} s to 55 m vs ${dead.seconds.toFixed(3)} s with the turret destroyed, ${alive.slow} slow ticks`);
  });

  it('seeing the player beyond 55 m from a gallery with no way down: it approaches at 8 m/s along the gallery, then strafes (SPEC §2.3)', () => {
    // Platform 4 m high, 20 m wide, from z = −110 to z = −50: no walkable route to the ground where the player stands.
    const sim = mk({ enemies: [makeGuard('G1', 0, -88, 4)], solids: [solid(-10, 0, -110, 10, 4, -50)] });
    sim.player.hp = BIG_HP;
    const G1 = sim.enemies[0];
    const rec = new Rec(sim);
    const onGallery = (): void => {
      expect(G1.pos.y).toBe(4 + GUARD.centerHeight);
      expect(sim.nav.isWalkable(G1.pos)).toBe(true);
      expect(G1.hasLos).toBe(losTruth(sim, G1));
    };
    rec.tick();
    expect(G1.hasLos).toBe(true);
    expect(sim.nav.findPath(G1.pos, sim.player.pos, 30)).toBeNull(); // no route to the player's floor
    const d0 = distance(G1.pos, sim.player.pos);
    expect(d0).toBeGreaterThan(88);
    const t0 = sim.time;
    let minClosing = Infinity;
    rec.until(
      () => getEnemyAi(G1).mode === 'strafe',
      6,
      () => {
        onGallery();
        expect(G1.hasLos).toBe(true);
        expect(Math.abs(speedXZ(G1) - GUARD.approachSpeed)).toBeLessThan(1e-6);
        if (getEnemyAi(G1).mode !== 'strafe') expect(getEnemyAi(G1).mode).toBe('approach');
        const dx = sim.player.pos.x - G1.pos.x;
        const dz = sim.player.pos.z - G1.pos.z;
        minClosing = Math.min(minClosing, (G1.vel.x * dx + G1.vel.z * dz) / Math.hypot(dx, dz));
      },
    );
    const dSwitch = distance(G1.pos, sim.player.pos);
    const seconds = sim.time - t0;
    expect(minClosing).toBeGreaterThan(GUARD.approachSpeed * 0.99); // straight at the player
    expect(dSwitch).toBeLessThanOrEqual(GUARD.approachBeyond);
    expect(dSwitch).toBeGreaterThan(GUARD.approachBeyond - GUARD.approachSpeed * TICK - 1e-6);
    expect(seconds).toBeLessThan((d0 - GUARD.approachBeyond) / GUARD.approachSpeed + 0.1);
    expect(G1.shotsFired).toBeGreaterThan(0); // attacking while it closes in
    const shots = G1.shotsFired;
    const m = new Motion(sim, G1);
    rec.run(8, () => {
      onGallery();
      m.sample();
      expect(getEnemyAi(G1).mode).toBe('strafe');
      expect(distance(G1.pos, sim.player.pos)).toBeLessThanOrEqual(GUARD.approachBeyond + 0.05);
    });
    expect(m.path / 8).toBeGreaterThan(GUARD.strafeSpeed * 0.9);
    expect(m.shuffleWindows).toBe(0);
    expect(G1.shotsFired).toBeGreaterThan(shots + 15);
    log(`gallery approach: ${d0.toFixed(1)} m → ${dSwitch.toFixed(2)} m in ${seconds.toFixed(2)} s at 8 m/s (radial ≥ ${minClosing.toFixed(3)} m/s), then strafing ${m.path.toFixed(1)} m in 8 s`);
  });

  it('a gallery that ends beyond 55 m: it runs to the nearest spot that still sees the player and only then strafes out there', () => {
    // The platform ends 62 m from the player: nothing on it is within 55 m.
    const sim = mk({ enemies: [makeGuard('G1', 0, -88, 4)], solids: [solid(-10, 0, -110, 10, 4, -62)] });
    sim.player.hp = BIG_HP;
    const G1 = sim.enemies[0];
    const rec = new Rec(sim);
    rec.tick();
    expect(G1.hasLos).toBe(true);
    const d0 = distance(G1.pos, sim.player.pos);
    const t0 = sim.time;
    let slow = 0;
    rec.until(() => getEnemyAi(G1).mode === 'strafe', 5, () => {
      expect(G1.hasLos).toBe(true);
      if (Math.abs(speedXZ(G1) - GUARD.approachSpeed) > 1e-6) slow++; // only the last step, which ends on the spot
      expect(sim.nav.isWalkable(G1.pos)).toBe(true);
    });
    expect(slow).toBeLessThanOrEqual(1);
    const d1 = distance(G1.pos, sim.player.pos);
    // The walkable edge is 1.2 m (agent radius, rounded to the 1 m lattice: 1.5 m) inside the platform edge.
    expect(d1).toBeLessThan(64.5);
    expect(d1).toBeGreaterThan(GUARD.approachBeyond);
    expect(sim.time - t0).toBeLessThan((d0 - d1) / GUARD.approachSpeed + 0.3);
    let dMax = 0;
    let moved = 0;
    let prev = clone(G1.pos);
    rec.run(6, () => {
      expect(G1.hasLos).toBe(true);
      expect(getEnemyAi(G1).mode).toBe('strafe'); // nothing nearer to go to: no hopping between approach and strafe
      expect(sim.nav.isWalkable(G1.pos)).toBe(true);
      dMax = Math.max(dMax, distance(G1.pos, sim.player.pos));
      moved += Math.hypot(G1.pos.x - prev.x, G1.pos.z - prev.z);
      prev = clone(G1.pos);
    });
    expect(dMax).toBeLessThan(d1 + 0.5);
    expect(moved).toBeGreaterThan(20);
    log(`short gallery: ${d0.toFixed(1)} m → ${d1.toFixed(2)} m (edge of its floor) in ${(sim.time - 6 - t0).toFixed(2)} s, then strafing ${moved.toFixed(1)} m in 6 s at ≤ ${dMax.toFixed(2)} m`);
  });

  it('told a position on a floor it cannot reach, a guard walks to the nearest spot of its own floor with a view of it — it does not stand for the whole alert', () => {
    // Gallery 6 m high along x (z −60 … −50). The player stands on the ground below its west part. A on the
    // gallery sees it. B, 58 m east of A on the same gallery, is told; a 14 m wall in front of the east part
    // hides the ground from everything east of x ≈ 4.7 — 25 m from B, more than any "nearby spot".
    const sim = mk({
      enemies: [makeGuard('A', -28, -55, 6), makeGuard('B', 30, -55, 6)],
      solids: [solid(-45, 0, -60, 45, 6, -50), solid(0, 0, -48, 45, 14, -47)],
      start: v3(-30, STAND_Y, 0),
    });
    sim.player.hp = BIG_HP;
    const A = sim.enemyById.get('A') as EnemyState;
    const B = sim.enemyById.get('B') as EnemyState;
    const rec = new Rec(sim);
    const onGallery = (): void => {
      for (const g of [A, B]) {
        expect(g.pos.y).toBe(6 + GUARD.centerHeight);
        expect(sim.nav.isWalkable(g.pos)).toBe(true);
        expect(g.hasLos).toBe(losTruth(sim, g));
      }
    };
    rec.tick();
    onGallery();
    expect(A.hasLos).toBe(true);
    expect(B.hasLos).toBe(false);
    expect(B.alert).toBe(true); // told at once
    expect(sim.nav.findPath(B.pos, sim.player.pos, 30)).toBeNull(); // no route to that floor
    const toldAt = sim.time;
    const b0 = clone(B.pos);
    let firstMoveAt = -1;
    let stood = 0;
    rec.until(
      () => B.hasLos,
      8,
      () => {
        onGallery();
        if (B.hasLos) return;
        if (firstMoveAt < 0 && speedXZ(B) > 1) firstMoveAt = sim.time;
        if (speedXZ(B) < 0.05) stood++;
        expect(B.shotsFired).toBe(0); // no shot without its own line of sight
        expect(B.burstStartAt).toBeNull();
      },
    );
    const sight = getEnemyAi(B).firstSightAt as number;
    expect(firstMoveAt - toldAt).toBeLessThanOrEqual(ENEMY_AI.reacquireStartSeconds);
    expect(stood * TICK).toBeLessThan(0.2);
    expect(B.pos.x).toBeLessThan(10); // where the line to the player clears the end of the wall
    expect(Math.hypot(B.pos.x - b0.x, B.pos.z - b0.z)).toBeGreaterThan(22);
    expect(sight - toldAt).toBeLessThan(28 / GUARD.approachSpeed + 0.5); // the direct way along the gallery at 8 m/s
    const sightX = B.pos.x;
    const walked = Math.hypot(B.pos.x - b0.x, B.pos.z - b0.z);
    rec.until(() => B.shotsFired === 1, 1, onGallery);
    const firstShot = (B.lastShotAt as number) - sight;
    expect(Math.abs(firstShot - GUARD.firstShotDelay)).toBeLessThanOrEqual(1e-6);
    // It then closes in along the gallery like any guard that sees the player beyond 55 m.
    rec.until(() => distance(B.pos, sim.player.pos) <= GUARD.approachBeyond, 6, onGallery);
    log(
      `told, no route: B moving ${(firstMoveAt - toldAt).toFixed(4)} s after the report, own line of sight after ${(sight - toldAt).toFixed(2)} s at x = ${sightX.toFixed(1)} ` +
        `(${walked.toFixed(1)} m along the gallery), first shot +${firstShot.toFixed(4)} s, within 55 m at ${sim.time.toFixed(2)} s`,
    );
  });

  it('a view through a narrow gap: it stands and fires instead of shuffling on the spot; through a wide gap it sweeps the whole window', () => {
    // Wall 20 m in front of the guard (40 m from the player) with a gap of the given width.
    const runGap = (w: number): { m: Motion; shots: number } => {
      const sim = mk({ enemies: [makeGuard('G1', 0, -40)], solids: [solid(-100, 0, -21, -w / 2, 12, -19), solid(w / 2, 0, -21, 100, 12, -19)], seed: 5 });
      sim.player.hp = BIG_HP;
      const G1 = sim.enemies[0];
      const rec = new Rec(sim);
      rec.run(2);
      const m = new Motion(sim, G1);
      rec.run(20, () => {
        m.sample();
        expect(G1.hasLos).toBe(true);
        expect(getEnemyAi(G1).mode).toBe('strafe');
      });
      expect(getEnemyAi(G1).oscCount).toBe(0);
      return { m, shots: G1.shotsFired };
    };
    const fullRate = 3 * (Math.floor((22 - GUARD.firstShotDelay) / GUARD.burstPeriod) + 1);
    const lines: string[] = [];
    for (const w of [0.6, 1, 1.5]) {
      // (before the fix a 1.5 m gap gave 102 reversals in 20 s inside 1.2 m: 6 m/s on the spot)
      const { m, shots } = runGap(w);
      expect(m.reversals).toBe(0);
      expect(m.path).toBe(0);
      expect(shots).toBe(fullRate);
      lines.push(`${w} m gap: stands, ${shots} shots`);
    }
    for (const w of [2, 3, 6]) {
      const { m, shots } = runGap(w);
      const sweep = m.xMax - m.xMin;
      expect(m.shuffleWindows).toBe(0);
      expect(m.longestRun).toBeLessThanOrEqual(1);
      // A leg lasts at least strafeMinLegSeconds: a window shorter than 9 m is crossed at 6 m/s, then the guard
      // stands at its end for the rest of that time (before: a turn every 0.4 – 0.9 s, 6 m/s without a pause).
      expect(m.minGap).toBeGreaterThanOrEqual(ENEMY_TUNING.strafeMinLegSeconds - 1e-6);
      expect(m.reversals).toBeGreaterThanOrEqual(Math.floor(20 / Math.max(ENEMY_TUNING.strafeMinLegSeconds, sweep / GUARD.strafeSpeed)) - 2);
      expect(sweep).toBeGreaterThanOrEqual(ENEMY_TUNING.strafeMinSpan - 2 * ENEMY_TUNING.strafeLookAhead - 0.3);
      expect(sweep).toBeGreaterThan(w === 2 ? 2.4 : w === 3 ? 4.2 : 9.5);
      // It keeps using the whole window: the path is (about) one sweep per leg.
      expect(m.path).toBeGreaterThan(sweep * (m.reversals - 1));
      expect(shots).toBe(fullRate);
      lines.push(`${w} m gap: sweeps ${sweep.toFixed(2)} m, ${m.reversals} turns (≥ ${m.minGap.toFixed(2)} s apart), ${m.path.toFixed(1)} m walked, ${shots} shots`);
    }
    log(`narrow views — ${lines.join('; ')}`);
  });

  it('snapshot enemies[].sectorId follows the guard: it reports the sector the guard is in, a re-sortie restores the placement', () => {
    // Two sectors side by side: W (x < 0) and E (x ≥ 0), overlapping by 2 m around x = 0.
    const twoSectors = (stage: StageDef): void => {
      const b = stage.sectors[0].bounds[0];
      stage.sectors = [
        { ...stage.sectors[0], id: 'W', name: '西', nameEn: 'West', bounds: [{ min: v3(b.min.x, b.min.y, b.min.z), max: v3(1, b.max.y, b.max.z) }] },
        { ...stage.sectors[0], id: 'E', name: '東', nameEn: 'East', bounds: [{ min: v3(-1, b.min.y, b.min.z), max: v3(b.max.x, b.max.y, b.max.z) }] },
      ];
      for (const e of stage.enemies) e.sectorId = e.position.x < 0 ? 'W' : 'E';
    };
    const sim = mk({ enemies: [makeGuard('G1', -70, 0), makeTurret('T1', -75, 20)], start: v3(10, STAND_Y, 0), edit: twoSectors });
    sim.player.hp = BIG_HP;
    const G1 = sim.enemyById.get('G1') as EnemyState;
    const sector = (id: string): string => buildSnapshot(sim, 'playing').enemies.find((e) => e.id === id)!.sectorId;
    expect(sector('G1')).toBe('W');
    expect(sector('T1')).toBe('W');
    expect(sim.currentSectorId).toBe('E');
    const rec = new Rec(sim);
    // 80 m away: it approaches (towards +x), stops at 55 m — still in W.
    rec.until(() => getEnemyAi(G1).mode === 'strafe', 5, () => expect(sector('G1')).toBe('W'));
    // The player backs off to the east: the guard follows across the boundary.
    sim.input.moveX = 1;
    let enteredAt = Number.NaN;
    rec.until(
      () => sector('G1') === 'E',
      12,
      () => {
        // inside the overlap it keeps the sector it came from; it changes only once it has left W
        if (G1.pos.x <= 1) expect(sector('G1')).toBe('W');
        else if (Number.isNaN(enteredAt)) enteredAt = G1.pos.x;
      },
    );
    sim.input.moveX = 0;
    expect(enteredAt).toBeGreaterThan(1);
    expect(enteredAt).toBeLessThan(1 + GUARD.approachSpeed * TICK + 1e-9);
    expect(sim.world.sectorAt(G1.pos)).not.toBeNull();
    expect(sector('T1')).toBe('W'); // turrets do not move
    // A destroyed guard keeps the sector it died in; the re-sortie puts everything back.
    rec.run(1);
    expect(G1.pos.x).toBeGreaterThan(1);
    sim.damageEnemy(G1, 1e9);
    rec.run(0.5);
    expect(sector('G1')).toBe('E');
    sim.reset();
    expect(sector('G1')).toBe('W');
    expect(sim.enemyById.get('G1')!.pos).toEqual(v3(-70, GUARD.centerHeight, 0));
    log(`sector tracking: G1 placed in W, reported E from x = ${enteredAt.toFixed(3)} on (bounds overlap up to x = 1), W again after the re-sortie`);
  });
});

// ───────────────────────────── alert sharing ─────────────────────────────

describe('alert sharing with the allies within 60 m of walkable path (guards and turrets)', () => {
  /**
   * The player stands on a 6 m mesa, 10 m in from its +Z edge: visible from the ground far out in +Z (A),
   * hidden from everything close to the mesa walls and from the sides.
   *   A  (10, 60)   sees the player
   *   B  (35, 20)   47 m of free floor from A, the mesa hides the player from it (35.6 m away, in range)
   *   C  (-60, -20) hidden by the mesa, 106 m from A
   *   D  (10, 80)   20 m from A as the crow flies, but behind a 140 m wall: > 60 m of path
   *   TB (40, 14)   turret next to B: 55 m from A, free floor between them
   *   TC (-54, -20) turret next to C: far beyond 60 m
   *   TD (16, 80)   turret next to D: 21 m from A as the crow flies, behind the same wall
   */
  const build = (): Sim =>
    mk({
      enemies: [
        makeGuard('A', 10, 60),
        makeGuard('B', 35, 20),
        makeGuard('C', -60, -20),
        makeGuard('D', 10, 80),
        makeTurret('TB', 40, 14),
        makeTurret('TC', -54, -20),
        makeTurret('TD', 16, 80),
      ],
      solids: [solid(-25, 0, -30, 25, 6, 30), solid(-60, 0, 70, 80, 8, 71)],
      start: v3(0, 6 + STAND_Y, 20),
    });

  it('reaches a guard 47 m and a turret 55 m away by path, not those 106 m away, not those behind a wall without a passage within 60 m', () => {
    const sim = build();
    sim.player.hp = BIG_HP;
    const A = sim.enemyById.get('A') as EnemyState;
    const B = sim.enemyById.get('B') as EnemyState;
    const C = sim.enemyById.get('C') as EnemyState;
    const D = sim.enemyById.get('D') as EnemyState;
    const TB = sim.enemyById.get('TB') as EnemyState;
    const TC = sim.enemyById.get('TC') as EnemyState;
    const TD = sim.enemyById.get('TD') as EnemyState;
    expect(distance(A.pos, TB.pos)).toBeLessThan(ENEMY_AI.shareDistance);
    expect(distance(A.pos, TD.pos)).toBeLessThan(25);
    expect(losTruth(sim, TC) || losTruth(sim, TD)).toBe(false);
    // Path distances on the real NavGrid at the start.
    const dAB = sim.nav.pathDistance(A.pos, B.pos, 1000);
    const dAC = sim.nav.pathDistance(A.pos, C.pos, 1000);
    const dAD = sim.nav.pathDistance(A.pos, D.pos, 1000);
    expect(dAB).toBeGreaterThan(40);
    expect(dAB).toBeLessThan(ENEMY_AI.shareDistance);
    expect(dAC).toBeGreaterThan(100);
    expect(distance(A.pos, D.pos)).toBeLessThan(25);
    expect(dAD).toBeGreaterThan(ENEMY_AI.shareDistance);
    expect(losTruth(sim, A)).toBe(true);
    expect(losTruth(sim, B) || losTruth(sim, C) || losTruth(sim, D) || losTruth(sim, TB)).toBe(false);
    expect(distance(B.pos, sim.player.pos)).toBeLessThan(GUARD.range); // only the mesa hides the player from B

    const rec = new Rec(sim);
    rec.tick();
    // Shared at the very acquisition.
    expect(A.hasLos).toBe(true);
    expect(B.alert).toBe(true);
    expect(B.hasLos).toBe(false);
    expect(B.lastKnownPlayerPos).toEqual(sim.player.pos);
    expect(B.lastKnownAt).toBe(sim.time);
    expect(B.losLostAt).toBeNull(); // it never saw the player itself
    // The turret next to B is an ally within 60 m of passage too ("味方"): it is told in the same instant.
    expect(TB.alert).toBe(true);
    expect(TB.hasLos).toBe(false);
    expect(TB.lastKnownPlayerPos).toEqual(sim.player.pos);
    expect(TB.lastKnownAt).toBe(sim.time);
    expect(rec.alerted.map((a) => a.id).sort()).toEqual(['A', 'B', 'TB']);
    const b0 = clone(B.pos);
    let maxGap = 0;
    let lastRefresh = B.lastKnownAt as number;
    let bMoved = 0;
    let prev = clone(B.pos);
    rec.run(7, () => {
      if (B.lastKnownAt !== lastRefresh) {
        if (A.hasLos) maxGap = Math.max(maxGap, (B.lastKnownAt as number) - lastRefresh);
        lastRefresh = B.lastKnownAt as number;
      }
      bMoved += Math.hypot(B.pos.x - prev.x, B.pos.z - prev.z);
      prev = clone(B.pos);
      // The receiver knows a position but has no line of sight of its own: it never shoots.
      expect(B.hasLos).toBe(false);
      expect(losTruth(sim, B)).toBe(false);
      expect(B.shotsFired).toBe(0);
      expect(B.burstStartAt).toBeNull();
      expect(B.telegraphStartAt).toBeNull();
      // The told turret knows the position and turns its barrel there, but it cannot shoot through the mesa.
      expect(TB.alert).toBe(true);
      expect(TB.hasLos).toBe(false);
      expect(TB.shotsFired).toBe(0);
      expect(TB.burstStartAt).toBeNull();
      expect(TB.telegraphStartAt).toBeNull();
      const m = enemyMuzzle(TB, v3());
      const k = TB.lastKnownPlayerPos as V3;
      expect(angleBetween(TB.aimDir, v3(k.x - m.x, k.y - m.y, k.z - m.z))).toBeLessThan(1e-6);
      // Unrelated enemies learn nothing, guards and turrets alike.
      for (const e of [C, D, TC, TD]) {
        expect(e.alert).toBe(false);
        expect(e.lastKnownPlayerPos).toBeNull();
      }
      expect(sim.world.overlapsBox(B.pos, AGENT_HALF)).toBe(false);
    });
    expect(maxGap).toBeLessThanOrEqual(ENEMY_TUNING.shareInterval + TICK + 1e-9);
    expect(bMoved).toBeGreaterThan(20); // it walks towards the reported position
    expect(Math.hypot(B.pos.x - b0.x, B.pos.z - b0.z)).toBeGreaterThan(10);
    expect(C.pos).toEqual(v3(-60, GUARD.centerHeight, -20));
    expect(D.pos).toEqual(v3(10, GUARD.centerHeight, 80));
    expect(A.shotsFired).toBeGreaterThan(0);
    expect(rec.shots.every((s) => s.id === 'A')).toBe(true);
    expect(rec.dmg.every((d) => d.from === 'A')).toBe(true);
    log(
      `sharing: path A→B ${dAB.toFixed(1)} m (shared), A→C ${dAC.toFixed(1)} m (not shared), A→D ${dAD.toFixed(1)} m of path / ${distance(A.pos, D.pos).toFixed(1)} m straight (not shared); ` +
        `B refreshed every ≤ ${maxGap.toFixed(3)} s, walked ${bMoved.toFixed(1)} m without a line of sight, fired ${B.shotsFired} shots; modes B ${getEnemyAi(B).mode}`,
    );
  });

  it('a shared alert expires 8 s after the last report, and the receiver’s first own sighting still gets the full initial delay', () => {
    // A sees the player through a gap; B is told, walks round the wall and then sees the player itself.
    const sim = mk({
      enemies: [makeGuard('A', 0, -40), makeGuard('B', 30, -30)],
      solids: [solid(8, 0, -22, 60, 8, -21)],
    });
    sim.player.hp = BIG_HP;
    const A = sim.enemyById.get('A') as EnemyState;
    const B = sim.enemyById.get('B') as EnemyState;
    const rec = new Rec(sim);
    rec.tick();
    expect(A.hasLos).toBe(true);
    expect(B.hasLos).toBe(false);
    expect(B.alert).toBe(true);
    expect(getEnemyAi(B).firstSightAt).toBeNull();
    rec.until(() => B.hasLos, ENEMY_AI.memorySeconds, () => {
      if (!B.hasLos) expect(B.shotsFired).toBe(0);
    });
    const sight = getEnemyAi(B).firstSightAt as number;
    expect(sight).toBeCloseTo(sim.time, 9);
    expect(B.burstStartAt).toBeCloseTo(sight + GUARD.firstShotDelay, 12);
    rec.until(() => B.shotsFired === 1, 1);
    expect(Math.abs((B.lastShotAt as number) - (sight + GUARD.firstShotDelay))).toBeLessThanOrEqual(1e-6);
    log(`shared-then-seen: B told at ${TICK.toFixed(4)} s, own line of sight at ${sight.toFixed(4)} s, first shot ${(B.lastShotAt as number).toFixed(4)} s (+${((B.lastShotAt as number) - sight).toFixed(6)} s)`);

    // Kill the informer while the player is hidden from B: B forgets 8 s after the last report it got.
    const sim2 = build();
    sim2.player.hp = BIG_HP;
    const A2 = sim2.enemyById.get('A') as EnemyState;
    const B2 = sim2.enemyById.get('B') as EnemyState;
    const rec2 = new Rec(sim2);
    rec2.run(1);
    expect(B2.alert).toBe(true);
    const last = B2.lastKnownAt as number;
    sim2.damageEnemy(A2, 1e9);
    expect(A2.alive).toBe(false);
    rec2.until(() => !B2.alert, 9, () => {
      expect(B2.shotsFired).toBe(0);
      if (B2.alert) expect(B2.lastKnownAt).toBe(last);
    });
    expect(sim2.time).toBeGreaterThan(last + ENEMY_AI.memorySeconds - 1e-9);
    expect(sim2.time).toBeLessThanOrEqual(last + ENEMY_AI.memorySeconds + TICK + 1e-9);
    expect(B2.lastKnownPlayerPos).toBeNull();
    rec2.run(1, () => expect(speedXZ(B2)).toBe(0));
    log(`shared alert: last report ${last.toFixed(4)} s, receiver calm at ${(sim2.time - 1).toFixed(4)} s`);
  });

  it('a told turret never fires through the wall, gets the full 0.70 s on its first own sighting, and forgets 8 s after the last report', () => {
    // A sees the player through the 16 m gap in the wall; turret T (31 m from A) is hidden behind the wall;
    // turret P stands on a 3 m pedestal on A's floor (22 m from A), hidden too; turret U stands on a 9 m
    // tower with a 16 m × 16 m deck of its own that no passage leads to.
    const mkStage = (): Sim =>
      mk({
        enemies: [makeGuard('A', 0, -40), makeTurret('T', 30, -30), makeTurret('U', 30, -44, 9), makeTurret('P', -20, -50, 3)],
        solids: [solid(8, 0, -22, 60, 12, -21), solid(-60, 0, -22, -8, 12, -21), solid(22, 0, -52, 38, 9, -36), solid(-22, 0, -52, -18, 3, -48)],
      });
    const sim = mkStage();
    sim.player.hp = BIG_HP;
    const A = sim.enemyById.get('A') as EnemyState;
    const T = sim.enemyById.get('T') as EnemyState;
    const U = sim.enemyById.get('U') as EnemyState;
    const P = sim.enemyById.get('P') as EnemyState;
    expect(losTruth(sim, T) || losTruth(sim, U) || losTruth(sim, P)).toBe(false);
    const rec = new Rec(sim);
    rec.tick();
    expect(A.hasLos).toBe(true);
    expect(T.alert).toBe(true);
    expect(T.lastKnownPlayerPos).toEqual(sim.player.pos);
    expect(getEnemyAi(T).firstSightAt).toBeNull();
    // The pedestal turret stands in A's room: reached from the floor around its pedestal, it is told as well.
    expect(sim.nav.nearestWalkable(P.pos, 2)).toBeNull(); // nothing to stand on within its keep-out sphere
    expect(P.alert).toBe(true);
    expect(P.lastKnownPlayerPos).toEqual(sim.player.pos);
    // U is 32 m from A as well, but no passage leads up the tower: not connected, not told.
    expect(distance(A.pos, U.pos)).toBeLessThan(ENEMY_AI.shareDistance);
    expect(U.alert).toBe(false);
    // The player walks west until the turret sees it past the end of the wall.
    sim.input.moveX = -1;
    rec.until(() => T.hasLos, 8, () => {
      if (!U.hasLos && getEnemyAi(U).firstSightAt === null) expect(U.alert).toBe(false);
      expect(P.hasLos).toBe(false);
      expect(P.shotsFired).toBe(0);
      expect(P.burstStartAt).toBeNull();
      if (!T.hasLos) {
        expect(T.alert).toBe(true);
        expect(T.shotsFired).toBe(0);
        expect(T.burstStartAt).toBeNull();
      }
    });
    sim.input.moveX = 0;
    const sight = getEnemyAi(T).firstSightAt as number;
    expect(sight).toBeCloseTo(sim.time, 9);
    expect(T.burstStartAt).toBeCloseTo(sight + TURRET.firstShotDelay, 12);
    rec.until(() => T.shotsFired === 1, 1);
    expect(Math.abs((T.lastShotAt as number) - (sight + TURRET.firstShotDelay))).toBeLessThanOrEqual(1e-6);

    // The informer dies while the turret has no line of sight: it forgets 8 s after the last report.
    const sim2 = mkStage();
    sim2.player.hp = BIG_HP;
    const A2 = sim2.enemyById.get('A') as EnemyState;
    const T2 = sim2.enemyById.get('T') as EnemyState;
    const rec2 = new Rec(sim2);
    rec2.run(1);
    expect(T2.alert).toBe(true);
    const last = T2.lastKnownAt as number;
    expect(sim2.time - last).toBeLessThanOrEqual(ENEMY_TUNING.shareInterval + TICK + 1e-9);
    sim2.damageEnemy(A2, 1e9);
    rec2.until(() => !T2.alert, 9, () => {
      expect(T2.shotsFired).toBe(0);
      if (T2.alert) expect(T2.lastKnownAt).toBe(last);
    });
    expect(sim2.time).toBeGreaterThan(last + ENEMY_AI.memorySeconds - 1e-9);
    expect(sim2.time).toBeLessThanOrEqual(last + ENEMY_AI.memorySeconds + TICK + 1e-9);
    expect(T2.lastKnownPlayerPos).toBeNull();
    log(`turret sharing: floor turret and pedestal turret told at ${TICK.toFixed(4)} s, own line of sight (floor turret) at ${sight.toFixed(4)} s, first shot +${((T.lastShotAt as number) - sight).toFixed(6)} s; tower turret never told; calm ${(sim2.time - last).toFixed(3)} s after the last report`);
  });
});

// ───────────────────────────── aim ─────────────────────────────

describe('predictive aim', () => {
  const checkDeviation = (shots: Shot[]): { max: number; min: number } => {
    let max = 0;
    let min = Infinity;
    for (const s of shots) {
      const ideal = idealLead(s.muzzle, playerAtShot(s), s.pVel, ENEMIES[s.kind].bulletSpeed);
      const dev = angleBetween(ideal, s.dir);
      max = Math.max(max, dev);
      min = Math.min(min, dev);
      expect(dev).toBeLessThanOrEqual(ENEMY_AI.aimJitterDeg * DEG + 1e-9);
      expect(Math.abs(Math.hypot(s.dir.x, s.dir.y, s.dir.z) - 1)).toBeLessThan(1e-12);
    }
    return { max, min };
  };

  it('a stationary player is hit by every bullet (guard 40 m, turrets 45 m and 100 m); deviation ≤ 0.5°', () => {
    const sim = mk({ enemies: [makeGuard('G1', 0, -40), makeTurret('T1', 45, 0), makeTurret('T2', -100, 0)] });
    sim.player.hp = BIG_HP;
    const rec = new Rec(sim);
    rec.run(12);
    const cut = sim.time - 2.5; // everything fired before this has landed
    const done = [...rec.bullets.values()].filter((b) => b.spawnTime <= cut);
    for (const id of ['G1', 'T1', 'T2']) {
      const mine = done.filter((b) => b.owner === id);
      const hits = mine.filter((b) => b.outcome === 'player').length;
      expect(mine.length).toBeGreaterThan(8);
      expect(hits).toBe(mine.length);
      log(`stationary target: ${id} ${hits}/${mine.length} bullets hit`);
    }
    const dev = checkDeviation(rec.shots);
    // The spread is really random (not a fixed offset, not zero) and bounded.
    expect(dev.max).toBeGreaterThan(0.25 * DEG);
    expect(dev.min).toBeLessThan(0.2 * DEG);
    // T2 is beyond 60 m/s × 1.2 s: no intercept within the cap → direct aim (lead time capped), still hits.
    const far = rec.shotsOf('T2')[0];
    expect(solveLinearIntercept(far.muzzle, far.pPos, far.pVel, TURRET.bulletSpeed, ENEMY_AI.maxPredictSeconds)).toBeNull();
    // Bullets fly straight at constant velocity.
    expect(rec.maxPathError).toBeLessThan(1e-9);
    expect(rec.maxVelError).toBe(0);
    for (const b of rec.bullets.values()) {
      const cfg = b.owner === 'G1' ? GUARD : TURRET;
      expect(Math.abs(Math.hypot(b.v0.x, b.v0.y, b.v0.z) - cfg.bulletSpeed)).toBeLessThan(1e-9);
    }
    log(`aim deviation over ${rec.shots.length} shots: ${(dev.min / DEG).toFixed(4)}°–${(dev.max / DEG).toFixed(4)}° (limit ${ENEMY_AI.aimJitterDeg}°)`);
  });

  for (const kind of ['turret', 'guard'] as const) {
    it(`a player walking sideways at 10 m/s, 40 m from a ${kind}, is hit by most bullets (lead from position + velocity)`, () => {
      const def = kind === 'turret' ? makeTurret('E1', 0, -40) : makeGuard('E1', 0, -40);
      const sim = mk({ enemies: [def] });
      sim.player.hp = BIG_HP;
      const rec = new Rec(sim);
      sim.input.moveX = 1;
      rec.run(0.3);
      expect(Math.hypot(sim.player.vel.x, sim.player.vel.z)).toBeCloseTo(10, 9);
      rec.run(4.7);
      const fired = [...rec.bullets.values()];
      rec.run(2.5); // keep walking until those bullets have landed
      const hits = fired.filter((b) => b.outcome === 'player').length;
      expect(fired.length).toBeGreaterThanOrEqual(kind === 'turret' ? 6 : 9);
      expect(fired.every((b) => b.outcome !== 'flying')).toBe(true);
      expect(hits / fired.length).toBeGreaterThanOrEqual(0.8);
      // Every shot was aimed at the intercept point of the walking player (not at the current position).
      const shots = rec.shots.filter((s) => s.t <= 5);
      const dev = checkDeviation(shots);
      for (const s of shots) {
        const direct = v3(s.pPos.x - s.muzzle.x, s.pPos.y - s.muzzle.y, s.pPos.z - s.muzzle.z);
        expect(angleBetween(direct, s.dir)).toBeGreaterThan(3 * DEG);
      }
      log(`walking target (${kind}): ${hits}/${fired.length} bullets hit, max deviation from the ideal lead ${(dev.max / DEG).toFixed(4)}°`);
    });
  }

  it('no homing: a player who reverses direction after each burst is missed by every bullet', () => {
    const sim = mk({ enemies: [makeTurret('T1', 0, -40)] });
    const T = sim.enemies[0];
    const rec = new Rec(sim);
    sim.input.moveX = 1;
    let handled = 0;
    let xMin = Infinity;
    let xMax = -Infinity;
    rec.run(16, () => {
      // Reverse as soon as the second (last) shot of a burst is out.
      if (T.shotsFired > handled && T.shotsFired % TURRET.burstCount === 0) {
        handled = T.shotsFired;
        sim.input.moveX = -sim.input.moveX;
      }
      xMin = Math.min(xMin, sim.player.pos.x);
      xMax = Math.max(xMax, sim.player.pos.x);
      expect(T.hasLos).toBe(true);
    });
    const all = [...rec.bullets.values()].filter((b) => b.outcome !== 'flying');
    expect(all.length).toBeGreaterThanOrEqual(16);
    expect(all.filter((b) => b.outcome === 'player').length).toBe(0);
    expect(sim.player.hp).toBe(PLAYER.maxHp);
    expect(rec.dmg.length).toBe(0);
    // The player stayed in front of the turret the whole time (it just kept changing direction).
    expect(xMax - xMin).toBeLessThan(40);
    // They were aimed properly (at the lead point of the motion at the time) and flew dead straight.
    checkDeviation(rec.shots);
    expect(rec.maxPathError).toBeLessThan(1e-9);
    expect(rec.maxVelError).toBe(0);
    log(`direction change after each burst: 0/${all.length} bullets hit, HP ${sim.player.hp}`);
  });
});

// ───────────────────────────── aggressiveness ─────────────────────────────

describe('aggressiveness (§2.3, §11 露出時の危険性)', () => {
  const trio = (): EnemyDef[] => [makeGuard('G1', -30, -30), makeGuard('G2', 40, 10), makeTurret('T1', 5, 45)];

  it('MANDATORY: two guards + one turret at 35–50 m destroy a stationary 1000 HP player within 15 s of the first line of sight', () => {
    const results: string[] = [];
    for (const seed of [1, 2, 3, 20260908, 4242]) {
      const sim = mk({ enemies: trio(), seed });
      expect(sim.player.hp).toBe(1000);
      const rec = new Rec(sim);
      let dMin = Infinity;
      let dMax = 0;
      const p0 = clone(sim.player.pos);
      for (let i = 0; i < 20 * 120 && sim.status === 'playing'; i++) {
        rec.tick();
        for (const e of sim.enemies) {
          const d = distance(e.pos, sim.player.pos);
          dMin = Math.min(dMin, d);
          dMax = Math.max(dMax, d);
          expect(e.hasLos).toBe(true);
        }
      }
      expect(sim.status).toBe('failed');
      expect(sim.failReason).toBe('destroyed');
      const firstLos = Math.min(...sim.enemies.map((e) => getEnemyAi(e).firstSightAt as number));
      const ttk = sim.time - firstLos;
      expect(ttk).toBeLessThanOrEqual(15);
      // The player never moved and every enemy stayed between 35 and 50 m.
      expect(sim.player.pos).toEqual(p0);
      expect(dMin).toBeGreaterThanOrEqual(35);
      expect(dMax).toBeLessThanOrEqual(50);
      // The HP went down only through bullets that reached the hit box: 18 per guard bullet, 40 per turret bullet.
      const total = rec.dmg.reduce((s, d) => s + d.amount, 0);
      expect(total).toBeGreaterThanOrEqual(1000);
      for (const d of rec.dmg) expect(d.amount).toBe(d.from === 'T1' ? TURRET.damage : GUARD.damage);
      const landed = [...rec.bullets.values()].filter((b) => b.outcome === 'player').length;
      expect(landed).toBe(rec.dmg.length);
      expect(rec.dmg.length).toBeLessThanOrEqual(rec.shots.length);
      results.push(`seed ${seed}: ${ttk.toFixed(3)} s (${rec.shots.length} shots, ${rec.dmg.length} hits, distances ${dMin.toFixed(1)}–${dMax.toFixed(1)} m)`);
    }
    log(`lethality (HP 1000, stationary, 2 guards + 1 turret): destroyed after ${results.join('; ')}`);
  });

  it('all three attack at the same time: shots of different enemies fall into the same 0.2 s window', () => {
    const sim = mk({ enemies: trio() });
    sim.player.hp = BIG_HP;
    const rec = new Rec(sim);
    rec.run(6);
    const ids = ['G1', 'G2', 'T1'];
    let windows = 0;
    for (const s of rec.shots) {
      const inWindow = new Set(rec.shots.filter((o) => o.t >= s.t && o.t < s.t + 0.2).map((o) => o.id));
      if (ids.every((id) => inWindow.has(id))) windows++;
    }
    expect(windows).toBeGreaterThan(0);
    for (const a of ids) {
      for (const b of ids) {
        if (a >= b) continue;
        const overlap = rec.shotsOf(a).some((sa) => rec.shotsOf(b).some((sb) => Math.abs(sa.t - sb.t) < 0.2));
        expect(overlap).toBe(true);
      }
    }
    // Both guards fire at the very same instants.
    expect(rec.shotsOf('G1').map((s) => s.t)).toEqual(rec.shotsOf('G2').map((s) => s.t));
    log(`independence: ${windows} 0.2 s windows contain shots of all three enemies in 6 s; G1 and G2 fire at identical times`);
  });

  it('every enemy keeps its own timers: the schedule of each is the same alone, in a group of six, and at any player HP', () => {
    const defs: EnemyDef[] = [makeGuard('G1', -30, -30), makeGuard('G2', 40, 10), makeTurret('T1', 5, 45), makeTurret('T2', -45, 5), makeGuard('G3', 0, 70), makeTurret('T3', 80, -60)];
    const times = (enemies: EnemyDef[], hp: number, seconds: number): Map<string, number[]> => {
      const sim = mk({ enemies });
      sim.player.hp = hp;
      const rec = new Rec(sim);
      rec.run(seconds);
      return new Map(enemies.map((d) => [d.id, rec.shotsOf(d.id).map((s) => s.t)]));
    };
    const group = times(defs, BIG_HP, 8);
    for (const d of defs) {
      const alone = times([d], BIG_HP, 8).get(d.id) as number[];
      expect(alone.length).toBeGreaterThanOrEqual(8);
      expect(group.get(d.id)).toEqual(alone);
    }
    // No easing off against a weak player: same shots at 60 HP (until it dies) as at full health.
    const sim = mk({ enemies: defs });
    sim.player.hp = 60;
    const rec = new Rec(sim);
    rec.run(8);
    expect(sim.status).toBe('failed');
    const all = [...group.entries()].flatMap(([id, ts]) => ts.map((t) => ({ id, t }))).filter((s) => s.t <= sim.time + 1e-9);
    const low = rec.shots.map((s) => ({ id: s.id, t: s.t }));
    const key = (s: { id: string; t: number }): string => `${s.t.toFixed(9)}:${s.id}`;
    expect(low.map(key).sort()).toEqual(all.map(key).sort());
    log(`independent timers: 6 enemies, each fires at exactly the times it fires alone (${[...group].map(([id, ts]) => `${id} ${ts.length}`).join(', ')} shots in 8 s); 60 HP player destroyed at ${sim.time.toFixed(3)} s with the identical schedule`);
  });

  it('enemies do not damage each other: bullets pass through an enemy standing in the line of fire', () => {
    const sim = mk({ enemies: [makeTurret('T1', 0, -60), makeTurret('T2', 0, -30), makeGuard('G1', 0, 45), makeGuard('G2', 0, 25)] });
    sim.player.hp = BIG_HP;
    const rec = new Rec(sim);
    rec.run(10);
    for (const e of sim.enemies) {
      expect(e.hp).toBe(e.maxHp);
      expect(e.alive).toBe(true);
    }
    // The enemies in the back row still hit the player through their comrades.
    expect(rec.dmg.filter((d) => d.from === 'T1').length).toBeGreaterThan(5);
    expect(rec.dmg.filter((d) => d.from === 'G1').length).toBeGreaterThan(5);
    expect(rec.lastEvents.some((e) => e.type === 'enemy-damaged')).toBe(false);
    log(`friendly fire: T1 hit the player ${rec.dmg.filter((d) => d.from === 'T1').length}× through T2, all enemy HP unchanged`);
  });
});

// ───────────────────────────── determinism ─────────────────────────────

describe('determinism (seeded)', () => {
  const run = (seed: number): { shots: Shot[]; pos: V3[]; hp: number } => {
    const sim = mk({
      enemies: [makeGuard('G1', -30, -30), makeGuard('G2', 40, 10), makeTurret('T1', 5, 45), makeGuard('G3', 20, -60)],
      solids: [solid(-12, 0, -22, -8, 6, -18), solid(10, 0, -30, 14, 6, -26)],
      seed,
    });
    sim.player.hp = BIG_HP;
    const rec = new Rec(sim);
    rec.run(1.5);
    sim.input.moveX = 1;
    rec.run(3);
    sim.input.moveX = -1;
    sim.input.moveZ = 1;
    rec.run(3);
    sim.input.moveX = 0;
    sim.input.moveZ = 0;
    rec.run(2.5);
    return { shots: rec.shots, pos: sim.enemies.map((e) => clone(e.pos)), hp: sim.player.hp };
  };

  it('the same seed reproduces the identical shot log and enemy positions', () => {
    const a = run(99);
    const b = run(99);
    expect(a.shots.length).toBeGreaterThan(60);
    expect(b.shots).toEqual(a.shots);
    expect(b.pos).toEqual(a.pos);
    expect(b.hp).toBe(a.hp);
  });

  it('another seed changes only the random parts: a turret fires at the same times from the same muzzle, within the jitter cone', () => {
    const turretOnly = (seed: number): Shot[] => {
      const sim = mk({ enemies: [makeTurret('T1', 5, 45), makeTurret('T2', -50, -20)], seed });
      sim.player.hp = BIG_HP;
      const rec = new Rec(sim);
      rec.run(10);
      return rec.shots;
    };
    const a = turretOnly(1);
    const b = turretOnly(2);
    expect(a.length).toBe(b.length);
    expect(a.length).toBeGreaterThanOrEqual(24);
    let differing = 0;
    let maxAngle = 0;
    for (let i = 0; i < a.length; i++) {
      expect(b[i].t).toBe(a[i].t);
      expect(b[i].id).toBe(a[i].id);
      expect(b[i].muzzle).toEqual(a[i].muzzle);
      const ang = angleBetween(a[i].dir, b[i].dir);
      maxAngle = Math.max(maxAngle, ang);
      expect(ang).toBeLessThanOrEqual(2 * ENEMY_AI.aimJitterDeg * DEG + 1e-9);
      if (ang > 1e-6) differing++;
    }
    expect(differing).toBeGreaterThan(a.length * 0.9);
    // With guards the seed also picks strafe sides, but never the attack times.
    const g1 = run(1).shots.filter((s) => s.t < 1.5).map((s) => `${s.t.toFixed(9)}:${s.id}`);
    const g2 = run(2).shots.filter((s) => s.t < 1.5).map((s) => `${s.t.toFixed(9)}:${s.id}`);
    expect(g1.length).toBeGreaterThan(5);
    expect(g2).toEqual(g1);
    log(`seeds 1 vs 2 (turrets): ${a.length} shots at identical times, ${differing} directions differ, by at most ${(maxAngle / DEG).toFixed(4)}°`);
  });
});

// ───────────────────────────── being hit, dying, passive targets, re-sortie ─────────────────────────────

describe('damage hook, death, passive targets, time', () => {
  it('perception never depends on who fired first: an enemy hit from beyond its range (clear line) is alert but learns no position; in range it attacks with the normal initial delay', () => {
    // Guard 105 m away (range 90 m), turret 130 m away (range 120 m), nothing in between.
    const sim = mk({ enemies: [makeGuard('G1', 0, -105), makeTurret('T1', 40, -124)] });
    sim.player.hp = BIG_HP;
    const G1 = sim.enemyById.get('G1') as EnemyState;
    const T1 = sim.enemyById.get('T1') as EnemyState;
    const rec = new Rec(sim);
    rec.run(2);
    expect(G1.alert || T1.alert).toBe(false);
    expect(G1.pos.z).toBe(-105);
    expect(sim.world.segmentBlocked(enemyMuzzle(G1, v3()), sim.player.pos)).toBe(false); // plain view, only too far
    sim.damageEnemy(G1, 10);
    sim.damageEnemy(T1, 10);
    const hitAt = sim.time;
    expect(G1.hp).toBe(GUARD.hp - 10);
    for (const e of [G1, T1]) {
      // It knows it is under fire, but not from where: the player's position comes from perception only.
      expect(e.alert).toBe(true);
      expect(e.hasLos).toBe(false);
      expect(e.lastKnownPlayerPos).toBeNull();
      expect(e.lastKnownAt).toBeNull();
      expect(e.burstStartAt).toBeNull();
    }
    const post = clone(G1.pos);
    let walked = 0;
    let prev = clone(G1.pos);
    let closest = Infinity;
    rec.until(
      () => !G1.alert && !T1.alert,
      9,
      () => {
        walked += Math.hypot(G1.pos.x - prev.x, G1.pos.z - prev.z);
        prev = clone(G1.pos);
        closest = Math.min(closest, distance(G1.pos, sim.player.pos));
        expect(G1.hasLos || T1.hasLos).toBe(false);
        expect(G1.lastKnownPlayerPos).toBeNull();
        expect(T1.lastKnownPlayerPos).toBeNull();
        expect(getEnemyAi(G1).mode === 'search' || !G1.alert).toBe(true);
        // It looks around its post; it does not run at the player it cannot perceive.
        expect(Math.hypot(G1.pos.x - post.x, G1.pos.z - post.z)).toBeLessThan(ENEMY_TUNING.searchRadius + 1.5);
      },
    );
    expect(sim.time).toBeGreaterThan(hitAt + ENEMY_AI.memorySeconds - 1e-9);
    expect(sim.time).toBeLessThanOrEqual(hitAt + ENEMY_AI.memorySeconds + TICK + 1e-9);
    expect(walked).toBeGreaterThan(10);
    expect(closest).toBeGreaterThan(GUARD.range);
    expect(rec.shots.length).toBe(0);
    expect(T1.pos).toEqual(v3(40, TURRET.centerHeight, -124));
    expect(rec.alerted.map((a) => a.id).sort()).toEqual(['G1', 'T1']);

    // A second hit while it is alert without a position keeps it alert for 8 s from that hit.
    sim.damageEnemy(G1, 10);
    const first = sim.time;
    rec.run(5);
    sim.damageEnemy(G1, 10);
    const second = sim.time;
    rec.until(() => !G1.alert, 9, () => expect(G1.lastKnownPlayerPos).toBeNull());
    expect(second - first).toBeCloseTo(5, 6);
    expect(sim.time).toBeGreaterThan(second + ENEMY_AI.memorySeconds - 1e-9);
    expect(sim.time).toBeLessThanOrEqual(second + ENEMY_AI.memorySeconds + TICK + 1e-9);

    // The player walks into range: now it is perceived — first sighting, full initial delay, then the attack.
    sim.input.moveZ = 1;
    rec.until(() => G1.hasLos, 6, () => {
      if (!G1.hasLos) expect(G1.shotsFired).toBe(0);
    });
    sim.input.moveZ = 0;
    const sight = getEnemyAi(G1).firstSightAt as number;
    expect(sight).toBeCloseTo(sim.time, 9);
    expect(distance(G1.pos, sim.player.pos)).toBeLessThanOrEqual(GUARD.range);
    expect(distance(G1.pos, sim.player.pos)).toBeGreaterThan(GUARD.range - 0.2);
    expect(G1.lastKnownPlayerPos).toEqual(sim.player.pos);
    rec.until(() => G1.shotsFired === 1, 1);
    expect(Math.abs((G1.lastShotAt as number) - (sight + GUARD.firstShotDelay))).toBeLessThanOrEqual(1e-6);
    log(
      `hit from 105 m / 130 m (out of range, plain view): alert without a position, guard searched ${walked.toFixed(1)} m around its post (never nearer than ${closest.toFixed(1)} m), calm 8 s after the hit; ` +
        `player in range at ${sight.toFixed(3)} s, first shot +${((G1.lastShotAt as number) - sight).toFixed(6)} s`,
    );
  });

  it('an enemy hit without a clear line becomes alert but learns no position, never fires, and calms down after 8 s', () => {
    const sim = mk({ enemies: [makeGuard('G1', 0, -40), makeTurret('T1', 10, -40)], solids: [solid(-60, 0, -21, 60, 12, -20)] });
    const G1 = sim.enemyById.get('G1') as EnemyState;
    const T1 = sim.enemyById.get('T1') as EnemyState;
    const rec = new Rec(sim);
    rec.run(1);
    sim.damageEnemy(G1, 5);
    sim.damageEnemy(T1, 5);
    const at = sim.time;
    for (const e of [G1, T1]) {
      expect(e.alert).toBe(true);
      expect(e.lastKnownPlayerPos).toBeNull();
      expect(e.lastKnownAt).toBeNull();
      expect(e.hasLos).toBe(false);
    }
    let walked = 0;
    let prev = clone(G1.pos);
    rec.until(
      () => !G1.alert && !T1.alert,
      9,
      () => {
        walked += Math.hypot(G1.pos.x - prev.x, G1.pos.z - prev.z);
        prev = clone(G1.pos);
        expect(G1.lastKnownPlayerPos).toBeNull();
        expect(T1.lastKnownPlayerPos).toBeNull();
        expect(G1.pos.z).toBeLessThan(-21 - GUARD.radius + 1e-6); // stays on its side of the wall
        expect(sim.world.overlapsBox(G1.pos, AGENT_HALF)).toBe(false);
        expect(Math.hypot(G1.pos.x, G1.pos.z + 40)).toBeLessThan(ENEMY_TUNING.searchRadius + 1.5);
      },
    );
    expect(sim.time).toBeGreaterThan(at + ENEMY_AI.memorySeconds - 1e-9);
    expect(sim.time).toBeLessThanOrEqual(at + ENEMY_AI.memorySeconds + TICK + 1e-9);
    expect(walked).toBeGreaterThan(10); // it looks around where it stands
    expect(rec.shots.length).toBe(0);
    expect(sim.player.hp).toBe(PLAYER.maxHp);
    expect(T1.pos).toEqual(v3(10, TURRET.centerHeight, -40));
    log(`hit behind a wall: alert without a position, guard searched ${walked.toFixed(1)} m around its post, calm after ${(sim.time - at).toFixed(3)} s, 0 shots`);
  });

  it('a destroyed enemy stops at once: no velocity, no perception, no telegraph, no shot — also in the middle of a burst', () => {
    const sim = mk({ enemies: [makeGuard('G1', 0, -40), makeTurret('T1', 30, 30)] });
    sim.player.hp = BIG_HP;
    const G1 = sim.enemyById.get('G1') as EnemyState;
    const T1 = sim.enemyById.get('T1') as EnemyState;
    const rec = new Rec(sim);
    // Each is destroyed right after the first shot of its first burst (the next one is due 0.12 / 0.25 s later).
    rec.until(() => G1.shotsFired === 1, 2);
    expect(G1.burstStartAt).not.toBeNull();
    expect(G1.burstShotsDone).toBe(1);
    sim.damageEnemy(G1, 1e9);
    rec.until(() => T1.shotsFired === 1, 2);
    expect(T1.burstShotsDone).toBe(1);
    sim.damageEnemy(T1, 1e9);
    const shots = rec.shots.length;
    const teles = rec.teles.length;
    const gPos = clone(G1.pos);
    expect(enemiesNextEventTime(sim)).toBe(Infinity);
    rec.run(5, () => {
      for (const e of [G1, T1]) {
        expect(e.alive).toBe(false);
        expect(e.hasLos).toBe(false);
        expect(e.alert).toBe(false);
        expect(e.vel).toEqual(v3(0, 0, 0));
        expect(e.burstStartAt).toBeNull();
        expect(e.telegraphStartAt).toBeNull();
      }
    });
    expect(G1.pos).toEqual(gPos);
    expect(rec.shots.length).toBe(shots);
    expect(rec.teles.length).toBe(teles);
    expect(G1.shotsFired).toBe(1);
    expect(T1.shotsFired).toBe(1);
    expect(sim.projectiles.length).toBe(0);
    expect(G1.destroyedAt).not.toBeNull();
  });

  it('passive test targets have no AI: they never perceive, alert or attack, and scripted ones keep their constant velocity', () => {
    const passiveGuard: EnemyDef = { ...makeGuard('PG', 0, -20), test: { passive: true } };
    const sim = mk({ enemies: [makeTarget('P1', v3(0, 5, -30), v3(3, 0.5, -2)), makeTarget('P2', v3(10, 2, -30)), passiveGuard] });
    const rec = new Rec(sim);
    rec.run(3);
    sim.damageEnemy(sim.enemies[1], 10);
    sim.damageEnemy(sim.enemies[2], 10);
    rec.run(1);
    const P1 = sim.enemies[0];
    expect(P1.pos.x).toBeCloseTo(3 * 4, 9);
    expect(P1.pos.y).toBeCloseTo(5 + 0.5 * 4, 9);
    expect(P1.pos.z).toBeCloseTo(-30 - 2 * 4, 9);
    expect(P1.vel).toEqual(v3(3, 0.5, -2));
    expect(sim.enemies[1].pos).toEqual(v3(10, 2, -30));
    expect(sim.enemies[1].vel).toEqual(v3(0, 0, 0));
    expect(sim.enemies[2].pos).toEqual(v3(0, GUARD.centerHeight, -20));
    for (const e of sim.enemies) {
      expect(e.alert).toBe(false);
      expect(e.hasLos).toBe(false);
      expect(e.shotsFired).toBe(0);
      expect(e.lastKnownPlayerPos).toBeNull();
    }
    expect(rec.shots.length + rec.teles.length + rec.alerted.length).toBe(0);
    expect(sim.player.hp).toBe(PLAYER.maxHp);
    expect(enemiesNextEventTime(sim)).toBe(Infinity);
  });

  it('frame rate and pauses do not change anything: 30 / 60 / 120 fps frames and a paused stretch give the identical shot log', () => {
    const runFrames = (frame: number, pause: boolean): Array<{ id: string; t: number; dir: V3 }> => {
      const sim = mk({ enemies: [makeGuard('G1', -30, -30), makeGuard('G2', 40, 10), makeTurret('T1', 5, 45)] });
      sim.player.hp = BIG_HP;
      const out: Array<{ id: string; t: number; dir: V3 }> = [];
      const collect = (): void => {
        for (const ev of sim.drainEvents()) if (ev.type === 'enemy-shot') out.push({ id: ev.enemyId, t: 0, dir: clone(ev.dir) });
      };
      const frames = Math.round(6 / frame);
      for (let i = 0; i < frames; i++) {
        sim.advance(frame);
        collect();
        if (pause && i === Math.floor(frames / 3)) {
          // "Paused": nobody calls advance(). Time, timers and enemies stand still.
          const before = JSON.stringify(sim.enemies.map((e) => [e.pos, e.burstStartAt, e.telegraphStartAt, e.nextBurstReadyAt, e.lastKnownAt, e.shotsFired]));
          const t = sim.time;
          expect(sim.advance(0)).toBe(0);
          expect(sim.time).toBe(t);
          expect(JSON.stringify(sim.enemies.map((e) => [e.pos, e.burstStartAt, e.telegraphStartAt, e.nextBurstReadyAt, e.lastKnownAt, e.shotsFired]))).toBe(before);
        }
      }
      expect(sim.time).toBeCloseTo(6, 6);
      return out;
    };
    const a = runFrames(1 / 120, false);
    const b = runFrames(1 / 60, false);
    const c = runFrames(1 / 30, true);
    expect(a.length).toBeGreaterThan(30);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it('a re-sortie resets every alert, memory and attack timer, and replays identically', () => {
    const sim = mk({ enemies: [makeGuard('G1', -30, -30), makeTurret('T1', 5, 45)], seed: 5 });
    sim.player.hp = BIG_HP;
    const first = new Rec(sim);
    first.run(5);
    const log1 = first.shots.map((s) => ({ ...s }));
    expect(log1.length).toBeGreaterThan(10);
    sim.reset();
    for (const e of sim.enemies) {
      expect(e.alert).toBe(false);
      expect(e.hasLos).toBe(false);
      expect(e.shotsFired).toBe(0);
      expect(e.lastShotAt).toBeNull();
      expect(e.lastKnownPlayerPos).toBeNull();
      expect(e.burstStartAt).toBeNull();
      expect(e.telegraphStartAt).toBeNull();
      expect(e.nextBurstReadyAt).toBe(-Infinity);
      expect(getEnemyAi(e).firstSightAt).toBeNull();
      expect(getEnemyAi(e).mode).toBe('idle');
    }
    expect(sim.enemies[0].pos).toEqual(v3(-30, GUARD.centerHeight, -30));
    expect(sim.projectiles.length).toBe(0);
    sim.player.hp = BIG_HP;
    const second = new Rec(sim);
    second.run(5);
    expect(second.shots).toEqual(log1);
  });

  it('updateEnemies / enemiesNextEventTime report only strictly future events and never produce NaN', () => {
    const sim = mk({ enemies: [makeGuard('G1', -30, -30), makeTurret('T1', 5, 45)] });
    sim.player.hp = BIG_HP;
    const rec = new Rec(sim);
    let events = 0;
    for (let i = 0; i < 600; i++) {
      rec.tick();
      const next = enemiesNextEventTime(sim);
      expect(Number.isNaN(next)).toBe(false);
      expect(next).toBeGreaterThan(sim.time);
      if (next !== Infinity) events++;
      expectFiniteState(sim);
    }
    expect(events).toBe(600); // with a line of sight there is always a next telegraph or shot
    // Calling the update again at the same instant changes nothing (no double shots).
    const shots = sim.enemies.map((e) => e.shotsFired);
    const n = sim.projectiles.length;
    updateEnemies(sim, 0);
    expect(sim.enemies.map((e) => e.shotsFired)).toEqual(shots);
    expect(sim.projectiles.length).toBe(n);
    // enemy.vel is the actual displacement of the hit-sphere centre divided by the step (any step length).
    for (const h of [TICK, 0.003, 1e-6]) {
      moveEnemies(sim, h);
      for (const e of sim.enemies) {
        expect(e.vel.x * h).toBeCloseTo(e.pos.x - e.prevPos.x, 12);
        expect(e.vel.y * h).toBeCloseTo(e.pos.y - e.prevPos.y, 12);
        expect(e.vel.z * h).toBeCloseTo(e.pos.z - e.prevPos.z, 12);
        expect(Math.hypot(e.vel.x, e.vel.z)).toBeLessThanOrEqual(GUARD.approachSpeed + 1e-6);
        if (e.kind === 'turret') expect(e.vel).toEqual(v3(0, 0, 0));
      }
    }
    const G1 = sim.enemies[0];
    expect(Math.hypot(G1.vel.x, G1.vel.z)).toBeCloseTo(GUARD.strafeSpeed, 3);
    // A zero-length or invalid step moves nothing and leaves no NaN behind.
    const before = clone(G1.pos);
    moveEnemies(sim, 0);
    moveEnemies(sim, Number.NaN);
    expect(G1.pos).toEqual(before);
    expectFiniteState(sim);
  });
});

// ───────────────────────────── stress ─────────────────────────────

describe('stress: a wildly moving player (walk, glide, quick boost, jump, flight)', () => {
  it('60 s of random inputs: perception stays exact, schedules hold, nobody enters a solid or another enemy, no NaN', () => {
    const solids = [
      solid(-14, 0, -24, -8, 7, -18),
      solid(8, 0, -24, 14, 7, -18),
      solid(-32, 0, -3, -20, 7, 3),
      solid(20, 0, -3, 32, 7, 3),
      solid(-5, 0, 18, 5, 7, 24),
      solid(-40, 0, 40, 40, 9, 42),
      solid(-3, 0, -45, 3, 4, -39),
      solid(40, 0, -30, 42, 9, 30),
    ];
    const sim = mk({
      enemies: [
        makeGuard('G1', -25, -35),
        makeGuard('G2', 25, -35),
        makeGuard('G3', 0, -60),
        makeGuard('G4', -45, 10),
        makeGuard('G5', 30, 30),
        makeGuard('G6', -10, 55),
        makeTurret('T1', 0, 33),
        makeTurret('T2', -60, -50),
        makeTurret('T3', 60, -55),
      ],
      solids,
      seed: 31337,
    });
    sim.player.hp = BIG_HP;
    const rec = new Rec(sim);
    const rnd = new Rng(2024); // input script only — not the gameplay stream
    let minPair = Infinity;
    let maxSpeed = 0;
    let qb = 0;
    let airTicks = 0;
    const n = 60 * 120;
    for (let i = 0; i < n; i++) {
      if (i % 30 === 0) {
        sim.input.moveX = rnd.int(3) - 1;
        sim.input.moveZ = rnd.int(3) - 1;
        sim.input.jump = rnd.next() < 0.12;
        if (sim.input.jump) sim.input.jumpPressed = true;
        if (rnd.next() < 0.2) sim.input.glideTogglePressed = true;
        if (rnd.next() < 0.3) sim.input.qbPressed = true;
        sim.input.brake = rnd.next() < 0.05;
        sim.applyLook(rnd.range(-1, 1), rnd.range(-0.2, 0.2));
      }
      // Keep the player inside the arena (the floor is 300 m wide).
      if (Math.abs(sim.player.pos.x) > 110 || Math.abs(sim.player.pos.z) > 110) {
        sim.player.pos.x = 0;
        sim.player.pos.z = 0;
        sim.player.pos.y = STAND_Y;
        sim.player.vel.x = sim.player.vel.y = sim.player.vel.z = 0;
      }
      rec.tick();
      if (!sim.player.grounded) airTicks++;
      for (const ev of rec.lastEvents) if (ev.type === 'qb') qb++;
      expectFiniteState(sim);
      for (const e of sim.enemies) {
        expect(e.hasLos).toBe(losTruth(sim, e));
        if (e.kind !== 'guard') {
          expect(e.vel).toEqual(v3(0, 0, 0));
          continue;
        }
        expect(sim.world.overlapsBox(e.pos, AGENT_HALF)).toBe(false);
        expect(e.pos.y).toBe(GUARD.centerHeight);
        maxSpeed = Math.max(maxSpeed, speedXZ(e));
      }
      for (let a = 0; a < sim.enemies.length; a++) {
        for (let b = a + 1; b < sim.enemies.length; b++) {
          const ea = sim.enemies[a];
          const eb = sim.enemies[b];
          minPair = Math.min(minPair, distance(ea.pos, eb.pos) - ea.radius - eb.radius);
        }
      }
    }
    expect(sim.status).toBe('playing');
    expect(qb).toBeGreaterThan(8);
    expect(airTicks).toBeGreaterThan(300);
    expect(minPair).toBeGreaterThanOrEqual(0);
    expect(maxSpeed).toBeLessThanOrEqual(GUARD.approachSpeed + 1e-6);
    let total = 0;
    for (const e of sim.enemies) {
      const cfg = ENEMIES[e.kind];
      const times = rec.shotsOf(e.id).map((s) => s.t);
      total += times.length;
      for (let i = 0; i + cfg.burstCount < times.length; i++) {
        expect(times[i + cfg.burstCount] - times[i]).toBeGreaterThanOrEqual(cfg.burstPeriod - 1e-9);
      }
    }
    expect(total).toBeGreaterThan(300);
    expect(rec.maxPathError).toBeLessThan(1e-9);
    expect(rec.maxVelError).toBe(0);
    // Dodging works: a good part of the bullets misses a player who keeps changing velocity.
    const landed = [...rec.bullets.values()].filter((b) => b.outcome === 'player').length;
    const resolved = [...rec.bullets.values()].filter((b) => b.outcome !== 'flying').length;
    expect(landed).toBeLessThan(resolved);
    log(`stress: ${total} shots, ${landed}/${resolved} hit the erratic player (${qb} quick boosts, ${(airTicks / 120).toFixed(1)} s airborne), min clearance ${minPair.toFixed(3)} m, max guard speed ${maxSpeed.toFixed(6)} m/s`);
  });
});

// ───────────────────────────── the shipped stage ─────────────────────────────

describe('factory stage (30 guards + 15 turrets)', () => {
  it('the AI runs on the real stage from places along the route: state stays valid, guards stay out of solids and of each other, and it is cheap', async () => {
    let base: StageDef;
    try {
      base = (await import('../src/stage/factory')).getFactoryStage();
    } catch (err) {
      // The stage belongs to another module; without it this integration check cannot run.
      log(`factory stage not available — integration check skipped (${String(err)})`);
      return;
    }
    const guardsOnGrid = (sim: Sim): number => sim.enemies.filter((e) => e.kind === 'guard' && sim.nav.isWalkable(e.pos)).length;
    let ticks = 0;
    let ms = 0;
    let shots = 0;
    let alerted = 0;
    let moved = 0;
    let minPair = Infinity;
    const lines: string[] = [];
    const step = Math.max(1, Math.floor(base.route.length / 9));
    for (let k = 0; k < base.route.length; k += step) {
      const wp = base.route[k];
      const sim = new Sim({ ...base, playerStart: { position: { ...wp.position }, yaw: 0 } }, { seed: 7 + k });
      sim.player.hp = BIG_HP;
      if (k === 0) lines.push(`${sim.enemies.length} enemies, ${guardsOnGrid(sim)}/${sim.enemies.filter((e) => e.kind === 'guard').length} guards start on the NavGrid`);
      const guards = sim.enemies.filter((e) => e.kind === 'guard');
      const t0 = performance.now();
      const n = 8 * 120;
      for (let i = 0; i < n && sim.status === 'playing'; i++) {
        // Walk about a little so that lines of sight come and go.
        const leg = Math.floor(i / 180) % 4;
        sim.input.moveX = leg === 0 ? 1 : leg === 2 ? -1 : 0;
        sim.input.moveZ = leg === 1 ? 1 : leg === 3 ? -1 : 0;
        sim.tick();
        sim.drainEvents();
        ticks++;
        if (i % 4 !== 0) continue;
        expectFiniteState(sim);
        for (const g of guards) {
          if (!g.alive) continue;
          // (a guard that has not left its post stands where the stage put it — that is the stage's business)
          if (distance(g.pos, g.def.position) > 1e-9) expect(sim.world.overlapsBox(g.pos, AGENT_HALF)).toBe(false);
          expect(Math.hypot(g.vel.x, g.vel.z)).toBeLessThanOrEqual(GUARD.approachSpeed + 1e-6);
        }
        for (let a = 0; a < sim.enemies.length; a++) {
          for (let b = a + 1; b < sim.enemies.length; b++) {
            const ea = sim.enemies[a];
            const eb = sim.enemies[b];
            if (Math.abs(ea.pos.x - eb.pos.x) > 6 || Math.abs(ea.pos.z - eb.pos.z) > 6) continue;
            minPair = Math.min(minPair, distance(ea.pos, eb.pos) - ea.radius - eb.radius);
          }
        }
        for (const e of sim.enemies) {
          // Whoever fires has (or had a moment ago) a real line of sight; whoever is unaware does not move.
          if (!e.alert && e.kind === 'guard') expect(Math.hypot(e.vel.x, e.vel.z)).toBe(0);
          if (e.hasLos) expect(distance(e.pos, sim.player.pos)).toBeLessThanOrEqual(ENEMIES[e.kind].range + 1e-9);
          expect(e.hasLos).toBe(losTruth(sim, e));
        }
      }
      ms += performance.now() - t0;
      const s = sim.enemies.reduce((sum, e) => sum + e.shotsFired, 0);
      const al = sim.enemies.filter((e) => e.alert || e.shotsFired > 0).length;
      const mv = guards.filter((g) => distance(g.pos, g.def.position) > 1).length;
      shots += s;
      alerted += al;
      moved += mv;
      lines.push(`wp ${k} ${wp.sectorId}: ${al} aware, ${s} shots, ${mv} guards moved`);
    }
    // Same seed, same inputs → the same fight, also with all 45 enemies on the real stage.
    const replay = (): string => {
      const wp = base.route[Math.min(step, base.route.length - 1)];
      const sim = new Sim({ ...base, playerStart: { position: { ...wp.position }, yaw: 0 } }, { seed: 99 });
      sim.player.hp = BIG_HP;
      sim.input.moveX = 1;
      sim.runFor(2);
      sim.input.moveX = -1;
      sim.input.moveZ = 1;
      sim.runFor(3);
      return JSON.stringify(sim.enemies.map((e) => [e.pos, e.vel, e.alert, e.hasLos, e.shotsFired, e.lastShotAt, e.lastKnownPlayerPos, e.burstStartAt, e.yaw]));
    };
    expect(replay()).toBe(replay());
    const perTick = ms / ticks;
    expect(minPair).toBeGreaterThanOrEqual(0);
    expect(shots).toBeGreaterThan(0);
    expect(perTick).toBeLessThan(4); // whole Sim tick incl. the AI; the budget at 120 Hz is 8.3 ms
    log(`factory: ${lines.join('; ')}; whole-sim cost ${perTick.toFixed(3)} ms per tick over ${ticks} ticks, closest pair clearance ${minPair === Infinity ? 'n/a' : minPair.toFixed(3) + ' m'}, ${alerted} aware, ${moved} moved`);
  });

  const loadFactory = async (): Promise<StageDef | null> => {
    try {
      return (await import('../src/stage/factory')).getFactoryStage();
    } catch (err) {
      log(`factory stage not available — check skipped (${String(err)})`);
      return null;
    }
  };
  /** The real stage with the player standing at route point `k`; the first `open` barriers are opened by destroying their control turrets. */
  const parkedAt = (base: StageDef, k: number, seed: number, open = 0): Sim => {
    const wp = base.route[k];
    const sim = new Sim({ ...base, playerStart: { position: { x: wp.position.x, y: wp.position.y + 0.001, z: wp.position.z }, yaw: 0 } }, { seed });
    for (const b of base.barriers.slice(0, open)) sim.damageEnemy(sim.enemyById.get(b.controlEnemyId) as EnemyState, 1e9);
    sim.player.hp = BIG_HP;
    return sim;
  };

  it('first fight of the game (player in the entry corridor): no guard trembles against another one; reported velocities are real', async () => {
    // Review finding: with the default seed G02 stood 2.83 m from G01 in the S02/S03 doorway and reversed its
    // velocity every tick for 47 s ("6 m/s" on the spot); with seed 1 G01 did. Route point 5 = (54.5, 2, 7.5).
    const base = await loadFactory();
    if (!base || base.route.length < 6) return;
    const lines: string[] = [];
    for (const seed of [20260908, 1]) {
      const sim = parkedAt(base, 5, seed);
      const guards = sim.enemies.filter((e) => e.kind === 'guard');
      const motion = new Map<string, Motion>(guards.map((g) => [g.id, new Motion(sim, g)]));
      let minClear = Infinity;
      let seeing = 0;
      const n = 40 * 120;
      for (let i = 0; i < n; i++) {
        sim.tick();
        sim.drainEvents();
        for (const g of guards) {
          (motion.get(g.id) as Motion).sample();
          if (!g.alert) continue;
          if (g.hasLos) seeing++;
          if (i % 4 === 0) minClear = Math.min(minClear, clearance(sim, g));
        }
      }
      expect(seeing).toBeGreaterThan(120 * 20); // it is a fight: guards see the player most of the time
      let worst = 0;
      let turns = 0;
      for (const g of guards) {
        const m = motion.get(g.id) as Motion;
        expect(m.longestRun, `${g.id} consecutive reversals`).toBeLessThanOrEqual(1);
        expect(m.minGap, `${g.id} shortest time between two turns`).toBeGreaterThanOrEqual(0.2);
        expect(m.shuffleWindows, `${g.id} shuffling on the spot`).toBe(0);
        expect(m.ghostFrames, `${g.id} speed reported without displacement`).toBeLessThanOrEqual(m.reversals + 2);
        expect(getEnemyAi(g).oscCount, `${g.id} direction watch`).toBe(0);
        worst = Math.max(worst, m.reversals);
        turns += m.reversals;
      }
      expect(worst).toBeLessThan(40 * 2.5); // (before: 5598 in 60 s)
      expect(minClear).toBeGreaterThanOrEqual(-1e-9);
      lines.push(`seed ${seed}: ${turns} turns of all guards in 40 s (most by one guard: ${worst}), min clearance ${minClear.toFixed(3)} m`);
    }
    log(`factory, entry corridor: ${lines.join('; ')}`);
  });

  it('a strafing guard keeps each leg for 1.5 s: the first guard of the game can be hit with the FCS-locked machine gun from the dock door, and no guard along the route flips within a second', async () => {
    // Review finding (browser, default seed): standing at (20, 2, 7.8) in S02, lock complete on G01 at 52 m,
    // trigger held: 2 hits in ≈ 27 rounds. G01 saw the player through the gap between two crates and swept a
    // 3.3 m line every 0.55 s, while a machine-gun bullet needs 0.53 s for that distance — every lead was
    // computed for a velocity that had flipped before the bullet arrived. Headless before the fix: 19 hits of
    // 200 FCS-corrected rounds, 39 reversals in 21.5 s. The physics is untouched (no forced hit): the guard
    // now stands out the rest of a short leg at its end.
    const base = await loadFactory();
    if (!base) return;
    const lookAt = (sim: Sim, target: V3): void => {
      const p = sim.player;
      const dx = target.x - p.pos.x;
      const dy = target.y - (p.pos.y + CAMERA.pivotUp);
      const dz = target.z - p.pos.z;
      let dYaw = yawFromDir(dx, dz) - p.yaw;
      dYaw -= 2 * Math.PI * Math.round(dYaw / (2 * Math.PI));
      sim.applyLook(dYaw, Math.atan2(dy, Math.hypot(dx, dz)) - p.pitch);
    };
    {
      const sim = new Sim({ ...base, playerStart: { position: v3(20, 2.001, 7.8), yaw: -Math.PI / 2 } }, { seed: 20260908 });
      const G01 = sim.enemyById.get('G01') as EnemyState;
      if (!G01) return;
      sim.player.hp = BIG_HP;
      G01.hp = BIG_HP; // the hit counter must not end with its destruction (the AI never reads its HP)
      const m = new Motion(sim, G01);
      let shots = 0;
      let hits = 0;
      let locked = 0;
      let moving = 0;
      const n = 23 * 120;
      const d0 = distance(G01.pos, sim.player.pos);
      for (let i = 0; i < n; i++) {
        // The player keeps the reticle on the guard (camera only) and holds the trigger while the lock is complete.
        lookAt(sim, G01.pos);
        const isLocked = sim.lock.state === 'locked' && sim.lock.targetId === 'G01';
        sim.input.fire = i >= 3 * 120 && i < n - 180 && isLocked;
        sim.tick();
        m.sample();
        if (isLocked) locked++;
        if (speedXZ(G01) > 0.5) moving++;
        expect(getEnemyAi(G01).mode).toBe('strafe');
        for (const ev of sim.drainEvents()) {
          if (ev.type === 'player-shot' && ev.weapon === 'machinegun' && ev.locked) shots++;
          if (ev.type === 'enemy-damaged' && ev.enemyId === 'G01') hits++;
        }
      }
      expect(shots).toBeGreaterThan(100);
      expect(hits / shots).toBeGreaterThan(0.3); // (before: 0.095)
      expect(m.minGap).toBeGreaterThanOrEqual(ENEMY_TUNING.strafeMinLegSeconds - 1e-6); // (before: 0.35 s)
      expect(m.reversals).toBeGreaterThanOrEqual(8); // it still uses the room it has: lateral movement, not a statue
      expect(m.shuffleWindows).toBe(0);
      expect(getEnemyAi(G01).oscCount).toBe(0);
      // Attacking on schedule the whole time.
      expect(G01.shotsFired).toBeGreaterThanOrEqual(3 * Math.floor((23 - GUARD.firstShotDelay - 0.1) / GUARD.burstPeriod));
      log(
        `factory, G01 from the dock door (${d0.toFixed(1)} m, default seed): FCS-locked machine gun ${hits}/${shots} hits = ${((100 * hits) / shots).toFixed(1)} % (before the fix 19/200 = 9.5 %), ` +
          `locked ${((100 * locked) / n).toFixed(0)} % of the time; G01 ${m.reversals} turns in 23 s, never closer than ${m.minGap.toFixed(2)} s apart (before 0.35 s), moving ${((100 * moving) / n).toFixed(0)} % of the time, ${G01.shotsFired} shots`,
      );
    }
    // Along the route (every 6th point, the barriers behind the player open): while a guard is strafing, two
    // reversals are never closer than strafeMinLegSeconds. (Back-off below 25 m and a new strafe after a change
    // of mode are other decisions and are not counted.)
    const num = (id: string): number => Number(id.slice(1));
    let legs = 0;
    let shortest = Infinity;
    let strafing = 0;
    for (let k = 2; k < base.route.length; k += 6) {
      const open = base.barriers.filter((b) => num(b.toSectorId) <= num(base.route[k].sectorId)).length;
      const sim = parkedAt(base, k, 20260908, open);
      const guards = sim.enemies.filter((e) => e.kind === 'guard');
      const lastV = new Map<string, { x: number; z: number }>();
      const lastRev = new Map<string, number>();
      for (let i = 0; i < 14 * 120; i++) {
        sim.tick();
        sim.drainEvents();
        for (const g of guards) {
          if (!g.alive || !g.hasLos || getEnemyAi(g).mode !== 'strafe') {
            // Not strafing: the next strafe starts a new count.
            lastV.delete(g.id);
            lastRev.delete(g.id);
            continue;
          }
          strafing++;
          const sp = speedXZ(g);
          if (sp < 0.5) continue;
          const l = lastV.get(g.id);
          if (l && l.x * g.vel.x + l.z * g.vel.z < -0.5 * sp * Math.hypot(l.x, l.z)) {
            const prev = lastRev.get(g.id);
            if (prev !== undefined) {
              legs++;
              shortest = Math.min(shortest, sim.time - prev);
              expect(sim.time - prev, `${g.id} at route point ${k}, t = ${sim.time.toFixed(2)} s`).toBeGreaterThanOrEqual(ENEMY_TUNING.strafeMinLegSeconds - 1e-6);
            }
            lastRev.set(g.id, sim.time);
          }
          lastV.set(g.id, { x: g.vel.x, z: g.vel.z });
        }
      }
    }
    expect(legs).toBeGreaterThan(50);
    log(`factory, ${Math.ceil((base.route.length - 2) / 6)} route points × 14 s: ${legs} strafe legs between two reversals, shortest ${shortest.toFixed(2)} s (${(strafing * TICK).toFixed(0)} guard-seconds of strafing)`);
  });

  it('guards on a gallery above the player close in along the gallery and go to look at a reported position (no strafing at 88 m, no standing for the whole alert)', async () => {
    // Review findings: with the barriers B1–B5 open and the player on the lower floor of S14, G24 (on the 0 m
    // gallery, no walkable way down) strafed at 88.9 m for 20 s although the gallery reaches to 48 m from the
    // player (route point 85), and stood for 28 s when G23 / G25 reported the player (route point 83).
    const base = await loadFactory();
    if (!base || base.route.length < 86 || base.barriers.length < 5) return;
    {
      const sim = parkedAt(base, 85, 20260908, 5);
      sim.runFor(0.1);
      const far = sim.enemies.filter((e) => e.kind === 'guard' && e.hasLos && distance(e.pos, sim.player.pos) > GUARD.approachBeyond + 5 && sim.nav.findPath(e.pos, sim.player.pos, 30) === null);
      if (far.length === 0) log('factory, route point 85: no guard sees the player beyond 60 m without a route any more — the stage changed, nothing to check');
      for (const g of far) {
        const d0 = distance(g.pos, sim.player.pos);
        const m = new Motion(sim, g);
        let best = d0;
        let seen = 0;
        for (let i = 0; i < 15 * 120; i++) {
          sim.tick();
          sim.drainEvents();
          m.sample();
          expect(sim.nav.isWalkable(g.pos)).toBe(true);
          if (g.hasLos) {
            seen++;
            best = Math.min(best, distance(g.pos, sim.player.pos));
          }
        }
        // It came (much) nearer and ends up in the 55 m band or as near as its floor lets it see the player.
        expect(best, `${g.id} from ${d0.toFixed(1)} m`).toBeLessThan(Math.max(GUARD.approachBeyond + 0.1, d0 - 15));
        expect(g.hasLos).toBe(true);
        expect(seen).toBeGreaterThan(15 * 120 * 0.6);
        expect(m.longestRun).toBeLessThanOrEqual(1);
        expect(getEnemyAi(g).oscCount).toBe(0);
        log(`factory, route point 85: ${g.id} saw the player at ${d0.toFixed(1)} m with no route down → ${distance(g.pos, sim.player.pos).toFixed(1)} m after 15 s (nearest ${best.toFixed(1)} m), ${g.shotsFired} shots, mode ${getEnemyAi(g).mode}`);
      }
    }
    {
      const sim = parkedAt(base, 83, 20260908, 5);
      const guards = sim.enemies.filter((e) => e.kind === 'guard');
      /** Guards that are told (alert without ever having seen the player) and have no route to the reported floor. */
      const told = new Map<string, { at: number; from: V3; stood: number; noLos: number; sawAt: number }>();
      for (let i = 0; i < 20 * 120; i++) {
        sim.tick();
        sim.drainEvents();
        for (const g of guards) {
          let r = told.get(g.id);
          if (!r) {
            if (!(g.alert && !g.hasLos && getEnemyAi(g).firstSightAt === null && g.lastKnownPlayerPos && sim.nav.findPath(g.pos, g.lastKnownPlayerPos, 30) === null)) continue;
            r = { at: sim.time, from: clone(g.pos), stood: 0, noLos: 0, sawAt: -1 };
            told.set(g.id, r);
          }
          if (g.hasLos && r.sawAt < 0) r.sawAt = sim.time;
          if (r.sawAt >= 0 || !g.alert) continue;
          r.noLos++;
          if (speedXZ(g) < 0.05) r.stood++;
          expect(g.shotsFired).toBe(0);
        }
      }
      if (told.size === 0) log('factory, route point 83: no guard is told about a position it has no route to any more — the stage changed, nothing to check');
      for (const [id, r] of told) {
        const g = sim.enemyById.get(id) as EnemyState;
        // It moved (before the fix: 0.00 m in 28 s) and did not spend the alert standing.
        expect(distance(g.pos, r.from), `${id} moved`).toBeGreaterThan(5);
        expect(r.stood * TICK, `${id} standing while alert without a line of sight`).toBeLessThan(1.5);
        log(`factory, route point 83: ${id} told at ${r.at.toFixed(2)} s with no route to the position → walked ${distance(g.pos, r.from).toFixed(1)} m, stood ${(r.stood * TICK).toFixed(2)} s of ${(r.noLos * TICK).toFixed(2)} s without a line of sight, ${r.sawAt >= 0 ? `own line of sight at ${r.sawAt.toFixed(2)} s, ${g.shotsFired} shots` : 'no line of sight within 20 s'}`);
      }
    }
  });
});
