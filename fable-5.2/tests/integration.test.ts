/**
 * Whole-simulation integration tests (docs/SPEC.md §2.1, §6, §7, §9, §10, §11).
 *
 * Everything here drives the real, complete Sim — player, weapons, FCS, projectiles, enemy AI, navigation,
 * collision, objective logic and the snapshot API together — through its public inputs (sim.input,
 * sim.applyLook, sim.advance / tick / runFor) on small purpose-built stages, and on the shipped factory
 * stage when src/stage/factory.ts provides the real 45-enemy stage. Nothing is mocked.
 *
 * Where a test needs a particular resource level or situation it sets plain state (player.en, player.hp,
 * player.pos) or calls a public Sim method (damageEnemy, reset) before the tick under test; every such
 * place is marked "harness:". The code under test is never replaced.
 * Measured numbers are printed with the prefix "[integration]".
 */
import { describe, expect, it } from 'vitest';
import {
  CAMERA,
  DEFAULT_LOADOUT,
  DEFAULT_SEED,
  ENEMIES,
  MAX_FRAME_DT,
  PLAYER,
  TICK,
  computeEffectiveStats,
} from '../src/config';
import { Rng, parseSeed } from '../src/core/rng';
import { v3, yawFromDir, type V3 } from '../src/core/vec';
import { spawnEnemyBullet } from '../src/sim/projectiles';
import { Sim, createInputState } from '../src/sim/sim';
import { buildSnapshot } from '../src/sim/snapshot';
import type {
  EnemyDef,
  FcsId,
  GeneratorId,
  LegsId,
  Loadout,
  SimEvent,
  Snapshot,
  SolidDef,
  StageDef,
  Weapon,
} from '../src/sim/types';
import { getFactoryStage } from '../src/stage/factory';
import { makeGuard, makeTarget, makeTestStage, makeTurret } from '../src/stage/testStages';

// ───────────────────────────── helpers ─────────────────────────────

const ticksOf = (seconds: number): number => Math.round(seconds / TICK);
const pad2 = (n: number): string => String(n).padStart(2, '0');
/** Y of the camera-centre ray of a mech standing on a floor at y = 0 and looking level. */
const EYE_Y = PLAYER.half.y + 0.001 + CAMERA.pivotUp;
const STAND_Y = PLAYER.half.y + 0.001;

/** Turns the camera so that its centre ray passes through `target` (the ray always passes through the boom pivot). */
function lookAt(sim: Sim, target: V3): void {
  const p = sim.player;
  const dx = target.x - p.pos.x;
  const dy = target.y - (p.pos.y + CAMERA.pivotUp);
  const dz = target.z - p.pos.z;
  let dYaw = yawFromDir(dx, dz) - p.yaw;
  dYaw -= 2 * Math.PI * Math.round(dYaw / (2 * Math.PI));
  sim.applyLook(dYaw, Math.atan2(dy, Math.hypot(dx, dz)) - p.pitch);
}

/** Sets the absolute view direction. */
function face(sim: Sim, yaw: number, pitch = 0): void {
  let dYaw = yaw - sim.player.yaw;
  dYaw -= 2 * Math.PI * Math.round(dYaw / (2 * Math.PI));
  sim.applyLook(dYaw, pitch - sim.player.pitch);
}

function releaseAll(sim: Sim): void {
  Object.assign(sim.input, createInputState());
}

/** Runs `n` ticks, keeping the crosshair on enemy `trackId` (when given) before every tick. */
function run(sim: Sim, n: number, trackId?: string, each?: () => void): void {
  for (let k = 0; k < n && sim.status === 'playing'; k++) {
    if (trackId) lookAt(sim, sim.enemyById.get(trackId)!.pos);
    sim.tick();
    if (each) each();
  }
}

/** Selects the missile, tracks enemy `id` and holds the trigger until it is destroyed. Returns the ticks used. */
function killWithMissiles(sim: Sim, id: string, maxSeconds = 12): number {
  const e = sim.enemyById.get(id)!;
  sim.input.weaponSelect = 'missile';
  sim.input.fire = true;
  let n = 0;
  while (e.alive && sim.status === 'playing' && n < ticksOf(maxSeconds)) {
    lookAt(sim, e.pos);
    sim.tick();
    n++;
  }
  sim.input.fire = false;
  return n;
}

/**
 * Walks (W held, camera turned towards the goal every tick) until the mech is within `tol` of (x, z), the
 * time is up or the sortie ended. Returns true when the goal was reached.
 */
function walkTo(sim: Sim, x: number, z: number, maxSeconds: number, tol = 0.4): boolean {
  const p = sim.player;
  let reached = false;
  for (let n = 0; n < ticksOf(maxSeconds) && sim.status === 'playing'; n++) {
    if (Math.hypot(x - p.pos.x, z - p.pos.z) <= tol) {
      reached = true;
      break;
    }
    face(sim, yawFromDir(x - p.pos.x, z - p.pos.z));
    sim.input.moveZ = 1;
    sim.tick();
  }
  sim.input.moveZ = 0;
  return reached;
}

interface Stamped {
  time: number;
  tick: number;
  e: SimEvent;
}
type Ev<T extends SimEvent['type']> = Extract<SimEvent, { type: T }>;
function ofType<T extends SimEvent['type']>(evs: Stamped[], type: T): Array<Stamped & { e: Ev<T> }> {
  return evs.filter((s): s is Stamped & { e: Ev<T> } => s.e.type === type);
}
function drainInto(sim: Sim, into: Stamped[]): void {
  for (const e of sim.drainEvents()) into.push({ time: sim.time, tick: sim.tickIndex, e });
}

/**
 * Every piece of simulation state as one string. Non-finite numbers stay distinguishable ("#NaN",
 * "#-Infinity" …). `withAccumulator = false` leaves out the sub-tick real-time remainder, which is not
 * simulation state (it depends on how the frame times happened to fall).
 */
function fingerprint(sim: Sim, withAccumulator = true): string {
  const rep = (_k: string, v: unknown): unknown => (typeof v === 'number' && !Number.isFinite(v) ? `#${String(v)}` : v);
  const ids = [...sim.stage.barriers.map((b) => b.id), sim.stage.finalGate.id];
  return JSON.stringify(
    {
      time: sim.time,
      tickIndex: sim.tickIndex,
      accumulator: withAccumulator ? sim.accumulator : 0,
      status: sim.status,
      failReason: sim.failReason,
      seed: sim.seed,
      rng: (sim.rng as unknown as { s: number }).s,
      loadout: sim.loadout,
      stats: sim.stats,
      viewport: sim.viewport,
      input: sim.input,
      player: sim.player,
      camera: sim.camera,
      enemies: sim.enemies.map((e) => ({ ...e, def: e.def.id })),
      projectiles: sim.projectiles,
      nextProjectileId: sim.nextProjectileId,
      lock: sim.lock,
      fireControl: sim.fireControl,
      aim: sim.aim,
      shots: sim.shots,
      nextShotId: sim.nextShotId,
      objective: sim.objective,
      controlsRequired: sim.controlsRequired,
      currentSectorId: sim.currentSectorId,
      visitedSectorIds: sim.visitedSectorIds,
      events: sim.events,
      barriers: ids.map((id) => [id, sim.world.isBarrierOpen(id), sim.nav.isBarrierOpen(id)]),
    },
    rep,
  );
}

/** Path of the first leaf at which two JSON documents differ (for readable failure messages). */
function firstDiff(aJson: string, bJson: string): string {
  const walk = (a: unknown, b: unknown, path: string): string | null => {
    if (a === b) return null;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return `${path}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`;
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      const d = walk((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
      if (d) return d;
    }
    return null;
  };
  return walk(JSON.parse(aJson), JSON.parse(bJson), '$') ?? 'identical';
}

/** Index of the first position at which two string lists differ, with the leaf that differs; null when equal. */
function firstMismatch(a: string[], b: string[]): string | null {
  const n = Math.min(a.length, b.length);
  for (let k = 0; k < n; k++) if (a[k] !== b[k]) return `entry ${k}: ${firstDiff(a[k], b[k])}`;
  return a.length === b.length ? null : `lengths ${a.length} ≠ ${b.length}`;
}

/**
 * The only non-finite numbers the simulation state may contain are documented "never / not yet" sentinels
 * of the enemy scheduler (public: nextBurstReadyAt = −∞ before the first sighting; private AI clocks).
 * Returns every other non-finite number found anywhere in the state.
 */
const SENTINEL = /^\$\.enemies\.\d+\.(nextBurstReadyAt|ai\.(alertUntil|nextShareAt|plannedAt|planOkAt|strafeSwitchAt|dirCheckAt|navY|searchRepickAt))$/;
function nonFiniteState(sim: Sim): string[] {
  const out: string[] = [];
  const walk = (v: unknown, path: string): void => {
    if (typeof v === 'string') {
      if (v.startsWith('#') && !SENTINEL.test(path)) out.push(`${path} = ${v.slice(1)}`);
      return;
    }
    if (typeof v !== 'object' || v === null) return;
    for (const [k, c] of Object.entries(v)) walk(c, `${path}.${k}`);
  };
  walk(JSON.parse(fingerprint(sim)), '$');
  return out;
}

/** Non-finite numbers / undefined values in a snapshot (must always be empty). */
function snapshotDirt(s: Snapshot): string[] {
  const out: string[] = [];
  const walk = (v: unknown, path: string): void => {
    if (v === undefined) out.push(`${path} undefined`);
    else if (typeof v === 'number' && !Number.isFinite(v)) out.push(`${path} = ${v}`);
    else if (typeof v === 'object' && v !== null) for (const [k, c] of Object.entries(v)) walk(c, `${path}.${k}`);
  };
  walk(s, 'snapshot');
  return out;
}

const ALL_LOADOUTS: Loadout[] = [];
for (const fcs of ['wide', 'medium', 'narrow'] as FcsId[]) {
  for (const generator of ['capacity', 'balanced', 'recovery'] as GeneratorId[]) {
    for (const legs of ['biped', 'quadruped'] as LegsId[]) ALL_LOADOUTS.push({ fcs, generator, legs });
  }
}

let factoryStage: StageDef | null = null;
let factoryNote = '';
try {
  const s = getFactoryStage();
  if (s.enemies.length === 45) factoryStage = s;
  else factoryNote = `src/stage/factory.ts currently places ${s.enemies.length} enemies (not the real 45-enemy stage)`;
} catch (err) {
  factoryNote = `getFactoryStage() threw: ${String(err)}`;
}
if (!factoryStage) console.log(`[integration] factory-stage checks SKIPPED — ${factoryNote}`);

// ───────────────────────────── stages ─────────────────────────────

/**
 * Progression stage: a walled lane (no roof, walls 24 m high) along −Z.
 *
 *   room 1  z ∈ (−40, 39)     start at (0, 20), sheltered from control turret T1 by a cover block
 *   B1      z ∈ [−41, −40]    barrier across the lane, opened by T1 (room 1)
 *   room 2  z ∈ (−120, −41)   control turret T2 behind a long cover wall (the lane itself is not exposed to it),
 *                             passive target X1 at the far end of the lane
 *   B2      x ∈ [12, 13]      side door of room 2 into a closed yard where guard G1 stands; opened by T2
 *   GATE    z ∈ [−121, −120]  final gate: opens when T1 AND T2 are destroyed
 *   exit    z ∈ [−160, −130]  exit zone behind the gate
 */
function progressionStage(): StageDef {
  const H = 24;
  const solids: SolidDef[] = [
    { min: v3(-60, -1, -200), max: v3(60, 0, 40), material: 'floor', tag: 'slab' },
    { min: v3(-13, 0, -200), max: v3(-12, H, 40), material: 'wall', tag: 'left wall' },
    { min: v3(12, 0, -60), max: v3(13, H, 40), material: 'wall', tag: 'right wall, north part' },
    { min: v3(12, 0, -200), max: v3(13, H, -70), material: 'wall', tag: 'right wall, south part' },
    { min: v3(-13, 0, 39), max: v3(13, H, 40), material: 'wall', tag: 'back wall' },
    { min: v3(-13, 0, -200), max: v3(13, H, -199), material: 'wall', tag: 'end wall' },
    // the yard behind B2 is closed on all other sides
    { min: v3(13, 0, -90), max: v3(40, H, -89), material: 'wall', tag: 'yard south' },
    { min: v3(13, 0, -41), max: v3(40, H, -40), material: 'wall', tag: 'yard north' },
    { min: v3(39, 0, -89), max: v3(40, H, -41), material: 'wall', tag: 'yard east' },
    { min: v3(2, 0, -5), max: v3(10, 6, -3), material: 'container', tag: 'cover between the start and T1' },
    { min: v3(-5, 0, -112), max: v3(-4, 6, -46), material: 'concrete', tag: 'cover between the lane and T2' },
  ];
  const control = (id: string, x: number, z: number, sectorId: string, barrierId: string): EnemyDef => ({
    id,
    kind: 'turret',
    sectorId,
    position: v3(x, ENEMIES.turret.centerHeight, z),
    isGateControl: true,
    barrierId,
  });
  const guard = makeGuard('G1', 26, -65);
  guard.sectorId = 'M2';
  const x1 = makeTarget('X1', v3(0, 5, -112), v3(), 0.5, 1e9);
  x1.sectorId = 'M2';
  return {
    id: 'progression',
    name: 'progression test stage',
    bounds: { min: v3(-100, -60, -260), max: v3(100, 100, 100) },
    killY: -40,
    sectors: [
      { id: 'M1', name: '第1室', nameEn: 'Room 1', kind: 'dock', bounds: [{ min: v3(-13, -5, -40.5), max: v3(13, 80, 40) }] },
      { id: 'M2', name: '第2室', nameEn: 'Room 2', kind: 'factory', bounds: [{ min: v3(-13, -5, -120.5), max: v3(40, 80, -40.5) }] },
      { id: 'M3', name: '搬出口', nameEn: 'Exit', kind: 'gate', bounds: [{ min: v3(-13, -5, -200), max: v3(13, 80, -120.5) }] },
    ],
    solids,
    decor: [],
    barriers: [
      { id: 'B1', name: '隔壁1', box: { min: v3(-12, 0, -41), max: v3(12, H, -40) }, controlEnemyId: 'T1', fromSectorId: 'M1', toSectorId: 'M2' },
      { id: 'B2', name: '隔壁2', box: { min: v3(12, 0, -70), max: v3(13, H, -60) }, controlEnemyId: 'T2', fromSectorId: 'M2', toSectorId: 'M2' },
    ],
    finalGate: { id: 'GATE', name: '最終搬出ゲート', box: { min: v3(-12, 0, -121), max: v3(12, H, -120) } },
    exitZone: { min: v3(-12, 0, -160), max: v3(12, 40, -130) },
    playerStart: { position: v3(0, STAND_Y, 20), yaw: 0 },
    enemies: [control('T1', 6, -25, 'M1', 'B1'), control('T2', -8, -60, 'M2', 'B2'), guard, x1],
    connections: [
      { a: 'M1', b: 'M2', kind: 'barrier', barrierId: 'B1' },
      { a: 'M2', b: 'M3', kind: 'gate' },
    ],
    route: [],
    flightSpots: [],
    branches: [],
    loops: [],
  };
}

/** Open arena for the scripted fight used by the determinism / frame-rate / pause tests. */
function arenaStage(): StageDef {
  return makeTestStage({
    floorSize: 400,
    enemies: [
      makeGuard('G1', -30, -75),
      makeTurret('T1', 38, -90),
      makeTarget('M1', v3(-12, 8, -60), v3(3, 0, -1), 0.5, 1e9),
      makeTarget('M2', v3(20, 5, -45), v3(-2, 0.5, 0), 0.5, 200),
    ],
    solids: [
      { min: v3(-9, 0, -32), max: v3(-5, 5, -30), material: 'concrete' },
      { min: v3(14, 0, -20), max: v3(16, 4, -12), material: 'machine' },
      { min: v3(-40, 6, -10), max: v3(-25, 7, 5), material: 'catwalk' },
    ],
  });
}

/**
 * The arena fight as a function of the script frame (30 per second = every 4 ticks): movement, three quick
 * boosts, glide toggles, brake, a flight and a hop, all three weapons at moving targets with the camera
 * tracking them — while a guard and a turret shoot back.
 */
function arenaScript(sim: Sim, f: number): void {
  const inp = sim.input;
  const at = (sec: number): boolean => f === Math.round(sec * 30);
  if (at(0)) {
    inp.fire = true;
    inp.moveZ = 1;
  }
  if (at(0.5)) inp.qbPressed = true;
  if (at(1.5)) inp.glideTogglePressed = true;
  if (at(2.0)) {
    inp.moveZ = 0;
    inp.moveX = 1;
  }
  if (at(2.5)) {
    inp.jump = true;
    inp.jumpPressed = true;
  }
  if (at(4.0)) inp.jump = false;
  if (at(4.2)) inp.weaponSelect = 'beam';
  if (at(5.0)) inp.qbPressed = true;
  if (at(6.0)) inp.weaponSelect = 'missile';
  if (at(6.5)) inp.brake = true;
  if (at(7.0)) {
    inp.brake = false;
    inp.glideTogglePressed = true;
  }
  if (at(8.0)) {
    inp.weaponSelect = 'machinegun';
    inp.moveX = 0;
    inp.moveZ = -1;
  }
  if (at(9.0)) {
    inp.jump = true;
    inp.jumpPressed = true;
  }
  if (at(9.1)) inp.jump = false;
  if (at(10.0)) inp.qbPressed = true;
  if (at(11.0)) inp.fire = false;
  const target = sim.enemyById.get(f < 8 * 30 ? 'M1' : 'M2')!;
  if (target.alive) lookAt(sim, target.pos);
  else sim.applyLook(0.01 * Math.sin(f * 0.37), 0.003 * Math.cos(f * 0.21));
}
const ARENA_FRAMES = 12 * 30;

type Script = (sim: Sim, frame: number) => void;

/**
 * Plays `frames` script frames. The script is applied at exact multiples of 4 ticks (identical simulation
 * times in every run); in between, real time is fed to sim.advance() in the slices produced by `nextDt`
 * (a slice is shortened only so that it does not run past the next script frame).
 * `onFrame(f)` is called at every script-frame boundary after frame f − 1 was simulated.
 */
function playFrames(sim: Sim, script: Script, frames: number, nextDt: () => number, onFrame: (f: number) => void): { calls: number; maxTicksPerCall: number } {
  let f = 0;
  let calls = 0;
  let maxTicksPerCall = 0;
  script(sim, 0);
  while (f < frames && sim.status === 'playing') {
    const boundary = (f + 1) * 4;
    const need = (boundary - sim.tickIndex) * TICK - sim.accumulator;
    let dt = nextDt();
    if (!(dt < need - 1e-13)) dt = need;
    const ran = sim.advance(dt);
    calls++;
    if (ran > maxTicksPerCall) maxTicksPerCall = ran;
    if (sim.tickIndex === boundary) {
      f++;
      onFrame(f);
      if (f < frames && sim.status === 'playing') script(sim, f);
    }
  }
  return { calls, maxTicksPerCall };
}

/** Tick-by-tick reference run of a script: one snapshot (JSON) after every tick. */
function playTicks(sim: Sim, script: Script, frames: number, perTick: (k: number) => void): void {
  for (let k = 0; k < frames * 4 && sim.status === 'playing'; k++) {
    if (k % 4 === 0) script(sim, k / 4);
    sim.tick();
    perTick(k + 1);
  }
}

// ───────────────────────────── static rules ─────────────────────────────

describe('headless, deterministic core (docs/ARCHITECTURE.md §2)', () => {
  it('src/sim, src/core and the test stages use no three.js, no wall clock and no Math.random', () => {
    const sources = import.meta.glob(['../src/sim/*.ts', '../src/core/*.ts', '../src/stage/testStages.ts'], {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>;
    const files = Object.keys(sources);
    expect(files.length).toBeGreaterThanOrEqual(15);
    expect(files.some((f) => f.endsWith('/sim/snapshot.ts'))).toBe(true);
    const banned: Array<[string, RegExp]> = [
      ['three.js import', /from\s+['"]three/],
      ['Math.random', /Math\s*\.\s*random/],
      ['Date', /\bDate\s*[.(]|\bnew\s+Date\b/],
      ['performance', /\bperformance\s*\./],
      ['timers', /\b(setTimeout|setInterval|requestAnimationFrame)\s*\(/],
      ['browser globals', /\b(window|document|navigator)\s*\./],
    ];
    const hits: string[] = [];
    for (const [file, text] of Object.entries(sources)) {
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      for (const [name, re] of banned) if (re.test(code)) hits.push(`${file}: ${name}`);
    }
    expect(hits).toEqual([]);
  });
});

describe('seeded gameplay randomness (SPEC §9)', () => {
  it('the seed of the URL query: an unsigned 32-bit integer, otherwise 20260908', () => {
    expect(DEFAULT_SEED).toBe(20260908);
    const d = DEFAULT_SEED;
    expect(parseSeed('0', d)).toBe(0);
    expect(parseSeed('1', d)).toBe(1);
    expect(parseSeed('20260908', d)).toBe(20260908);
    expect(parseSeed('4294967295', d)).toBe(4294967295);
    expect(parseSeed('0000000042', d)).toBe(42);
    expect(parseSeed(' 77 ', d)).toBe(77);
    for (const bad of [null, undefined, '', ' ', '4294967296', '99999999999', '-1', '+5', '1.5', '1e3', '0x10', 'abc', '12abc', 'NaN', 'Infinity']) {
      expect(parseSeed(bad, d), `seed "${String(bad)}"`).toBe(20260908);
    }
    expect(parseSeed(undefined, 5)).toBe(5);
  });

  it('one stream per sortie: re-created from the seed by every reset, never shared with anything else', () => {
    const a = new Rng(123);
    const b = new Rng(123);
    const c = new Rng(124);
    const seqA = Array.from({ length: 1000 }, () => a.next());
    const seqB = Array.from({ length: 1000 }, () => b.next());
    const seqC = Array.from({ length: 1000 }, () => c.next());
    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(seqC);
    expect(seqA.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(new Set(seqA).size).toBeGreaterThan(990);
    const mean = seqA.reduce((n, x) => n + x, 0) / seqA.length;
    expect(mean).toBeGreaterThan(0.45);
    expect(mean).toBeLessThan(0.55);
    const r = new Rng(9);
    for (let k = 0; k < 500; k++) {
      const i = r.int(7);
      const x = r.range(-2, 3);
      const sgn = r.sign();
      expect(Number.isInteger(i) && i >= 0 && i < 7).toBe(true);
      expect(x >= -2 && x < 3).toBe(true);
      expect(sgn === 1 || sgn === -1).toBe(true);
    }
    // the simulation's stream is exactly Rng(seed), again after every reset, and (seed >>> 0) for odd inputs
    const sim = new Sim(makeTestStage({ enemies: [makeTurret('T1', 0, -50)] }), { seed: 123 });
    expect(sim.rng.next()).toBe(seqA[0]);
    sim.runFor(3); // the turret fires: the stream is consumed
    expect(sim.enemies[0].shotsFired).toBeGreaterThan(0);
    sim.reset();
    expect(sim.rng.next()).toBe(seqA[0]);
    sim.reset(undefined, 124);
    expect(sim.rng.next()).toBe(seqC[0]);
    expect(new Sim(makeTestStage()).seed).toBe(20260908);
    expect(new Sim(makeTestStage(), { seed: -1 }).seed).toBe(4294967295);
    expect(new Sim(makeTestStage(), { seed: 2 ** 32 + 5 }).seed).toBe(5);
  });
});

// ───────────────────────────── pause ─────────────────────────────

function pauseStage(): StageDef {
  return makeTestStage({
    enemies: [makeTurret('T1', 22, -62), makeGuard('G1', -25, -50), makeTarget('M1', v3(0, EYE_Y + 2, -70), v3(3, 0, 0), 0.5, 1e9)],
  });
}
/** Missiles at M1 from the start, Space held from 1.2 s (jump → flight), quick boost at 1.5 s. */
function pauseScript(sim: Sim, k: number): void {
  if (k === 0) {
    sim.input.weaponSelect = 'missile';
    sim.input.fire = true;
  }
  if (k === ticksOf(1.2)) {
    sim.input.jump = true;
    sim.input.jumpPressed = true;
  }
  if (k === ticksOf(1.5)) sim.input.qbPressed = true;
  lookAt(sim, sim.enemyById.get('M1')!.pos);
}
const PAUSE_AT = ticksOf(1.6);

describe('pause = the app stops calling advance (SPEC §9)', () => {
  it('nothing moves while paused — time, EN, cooldowns, projectiles, enemy timers, lock, missile memory — and nothing is caught up afterwards', async () => {
    const sim = new Sim(pauseStage());
    const twin = new Sim(pauseStage());
    for (let k = 0; k < PAUSE_AT; k++) {
      pauseScript(sim, k);
      pauseScript(twin, k);
      sim.tick();
      twin.tick();
    }
    // the moment of the pause is a busy one
    const p = sim.player;
    const missile = sim.projectiles.find((q) => q.kind === 'missile');
    const enemyBullets = sim.projectiles.filter((q) => q.kind === 'enemy');
    expect(missile).toBeDefined();
    expect(missile!.obsTime).not.toBeNull();
    expect(enemyBullets.length).toBeGreaterThan(0);
    expect(p.qbImpulseRemaining).toBeGreaterThan(0);
    expect(p.qbImpulseRemaining).toBeLessThan(PLAYER.qbImpulseSeconds);
    expect(p.flying).toBe(true);
    expect(p.en).toBeLessThan(120 - 36);
    expect(sim.lock.state).toBe('locked');
    expect(sim.fireControl.status).toBe('solved');
    expect(p.nextFireAt.missile).toBeGreaterThan(sim.time);
    expect(sim.enemies.some((e) => e.telegraphStartAt !== null || e.burstStartAt !== null)).toBe(true);
    expect(sim.enemies.filter((e) => e.alert && e.lastKnownAt !== null).length).toBe(2);
    expect(sim.events.length).toBeGreaterThan(0);

    const frozen = fingerprint(sim);
    const snap = JSON.stringify(buildSnapshot(sim, 'paused'));
    const obsAge = sim.time - (missile!.obsTime as number);
    const t0 = sim.time;

    // ── paused: real time passes, the HUD keeps asking for snapshots, degenerate frame times arrive ──
    await new Promise((resolve) => setTimeout(resolve, 60));
    for (let i = 0; i < 200; i++) buildSnapshot(sim, 'paused');
    expect(sim.advance(0)).toBe(0);
    expect(sim.advance(-3)).toBe(0);
    expect(sim.advance(Number.NaN)).toBe(0);
    expect(fingerprint(sim)).toBe(frozen);
    expect(JSON.stringify(buildSnapshot(sim, 'paused'))).toBe(snap);
    expect(sim.time).toBe(t0);
    expect(sim.time - (missile!.obsTime as number)).toBe(obsAge);
    const s = buildSnapshot(sim, 'paused');
    expect(s.state).toBe('paused');
    expect(s.elapsedSeconds).toBe(PAUSE_AT * TICK);
    expect(s.player.movement.qbImpulseRemainingSeconds).toBeCloseTo(0.15 - (PAUSE_AT - ticksOf(1.5)) * TICK, 12);
    expect(s.player.movement.qbCooldownRemainingSeconds).toBeCloseTo(1 - (PAUSE_AT - ticksOf(1.5)) * TICK, 12);

    // ── resume: one 60 fps frame is two ticks, not "two ticks plus the pause" ──
    pauseScript(sim, PAUSE_AT);
    pauseScript(twin, PAUSE_AT);
    expect(sim.advance(1 / 60)).toBe(2);
    twin.tick();
    twin.tick();
    expect(sim.time).toBeCloseTo(t0 + 2 * TICK, 12);
    expect(fingerprint(sim)).toBe(fingerprint(twin));
    // the whole rest of the fight is the fight of a game that was never paused
    for (let k = PAUSE_AT + 2; k < ticksOf(6); k++) {
      pauseScript(sim, k);
      pauseScript(twin, k);
      sim.tick();
      twin.tick();
      if (k % 30 === 0) expect(fingerprint(sim)).toBe(fingerprint(twin));
    }
    expect(fingerprint(sim)).toBe(fingerprint(twin));
    expect(sim.enemies.reduce((n, e) => n + e.shotsFired, 0)).toBeGreaterThan(10);
  });

  it('a pause in every single frame gap changes nothing either (60 pauses with snapshots in between)', () => {
    const paused = new Sim(pauseStage());
    const straight = new Sim(pauseStage());
    for (let k = 0; k < ticksOf(4); k++) {
      pauseScript(paused, k);
      pauseScript(straight, k);
      paused.advance(TICK);
      straight.advance(TICK);
      if (k % 8 === 0) {
        const f = fingerprint(paused);
        buildSnapshot(paused, 'paused');
        paused.advance(0);
        expect(fingerprint(paused)).toBe(f);
      }
    }
    expect(fingerprint(paused)).toBe(fingerprint(straight));
  });

  it('one advance() never simulates more than MAX_FRAME_DT, whatever frame time it is handed', () => {
    expect(MAX_FRAME_DT).toBe(0.25);
    const sim = new Sim(pauseStage());
    run(sim, 30);
    for (const dt of [600, 3600 * 8, Number.POSITIVE_INFINITY, 1e12, 0.26]) {
      const before = sim.tickIndex;
      const ran = sim.advance(dt);
      expect(ran).toBe(30);
      expect(sim.tickIndex - before).toBe(30);
      expect(sim.accumulator).toBeLessThan(TICK);
    }
    expect(sim.time).toBeCloseTo((30 + 5 * 30) * TICK, 12);
  });

  it('clearInput() at the pause releases every key and drops pending presses — exactly like letting go of everything', () => {
    const sim = new Sim(pauseStage());
    const twin = new Sim(pauseStage());
    for (let k = 0; k < PAUSE_AT; k++) {
      pauseScript(sim, k);
      pauseScript(twin, k);
      sim.tick();
      twin.tick();
    }
    sim.drainEvents();
    twin.drainEvents();
    const before = { time: sim.time, en: sim.player.en, hp: sim.player.hp, qb: sim.player.qbSuccessfulCount, impulse: sim.player.qbImpulseRemaining, vel: { ...sim.player.vel }, shots: sim.shots.length };
    // Q, Shift, Space and a weapon key were hit in the very frame of the Esc
    sim.input.qbPressed = true;
    sim.input.glideTogglePressed = true;
    sim.input.jumpPressed = true;
    sim.input.weaponSelect = 'beam';
    sim.clearInput();
    expect(sim.input).toEqual(createInputState());
    expect({ time: sim.time, en: sim.player.en, hp: sim.player.hp, qb: sim.player.qbSuccessfulCount, impulse: sim.player.qbImpulseRemaining, vel: { ...sim.player.vel }, shots: sim.shots.length }).toEqual(before);
    releaseAll(twin); // the twin's pilot simply lets go of everything at the same instant, without pausing

    // resume (Q may still be physically down: without a NEW press edge the simulation starts no boost)
    const evs: Stamped[] = [];
    for (let k = 0; k < ticksOf(3); k++) {
      sim.advance(TICK);
      twin.advance(TICK);
      drainInto(sim, evs);
      expect(sim.player.pos).toEqual(twin.player.pos);
    }
    twin.drainEvents();
    expect(fingerprint(sim)).toBe(fingerprint(twin));
    expect(sim.player.qbSuccessfulCount).toBe(1); // the boost that was running finished; no new one started
    expect(sim.player.weapon).toBe('missile'); // the pending weapon key was dropped
    expect(ofType(evs, 'qb').length).toBe(0);
    expect(ofType(evs, 'jump').length).toBe(0);
    expect(ofType(evs, 'player-shot').length).toBe(0);
    // the running impulse and its inertia were not cancelled by the pause: auto-glide with the inherited velocity
    expect(ofType(evs, 'glide').some((g) => g.e.enabled && g.e.auto)).toBe(true);
    expect(sim.player.glideEnabled).toBe(true);
  });

  it('after the sortie ended (failed / cleared) advance() does nothing', () => {
    const sim = new Sim(makeTestStage({ floorSize: 30 }));
    sim.input.moveZ = 1;
    sim.runFor(12);
    expect(sim.status).toBe('failed');
    const frozen = fingerprint(sim);
    expect(sim.advance(1 / 60)).toBe(0);
    expect(sim.runFor(1)).toBe(0);
    sim.tick();
    sim.applyLook(0.3, 0.1);
    expect(fingerprint(sim)).toBe(frozen);
    // only a re-sortie brings it back — as a completely fresh sortie
    sim.reset();
    expect(sim.status).toBe('playing');
    expect(fingerprint(sim)).toBe(fingerprint(new Sim(makeTestStage({ floorSize: 30 }))));
    expect(sim.advance(1 / 60)).toBe(2);
  });
});

// ───────────────────────────── re-sortie ─────────────────────────────

/**
 * A messy sortie on the progression stage as a function of the tick: side-step out of the shelter, destroy
 * control turret T1 with missiles (B1 opens), boost and glide through the opened barrier into room 2 while
 * switching through beam and machine gun at the passive target X1.
 */
function messyScript(sim: Sim, k: number): void {
  const inp = sim.input;
  const t1 = sim.enemyById.get('T1')!;
  const p = sim.player;
  if (k === 0) {
    inp.weaponSelect = 'missile';
    inp.fire = true;
    inp.moveX = -1;
  }
  if (k === ticksOf(0.7)) inp.moveX = 0;
  if (t1.alive) {
    lookAt(sim, t1.pos);
    return;
  }
  // T1 is gone: down the lane
  const lane = sim.enemyById.get('X1')!;
  lookAt(sim, lane.pos);
  inp.moveX = 0;
  inp.moveZ = 1;
  if (p.qbSuccessfulCount === 0 && p.pos.z < 15) inp.qbPressed = true;
  if (p.pos.z < -20 && p.weapon === 'missile') inp.weaponSelect = 'beam';
  if (p.pos.z < -55 && p.weapon === 'beam') inp.weaponSelect = 'machinegun';
}
/** The messy sortie ends in the middle of room 2 (z < −75): gliding, locked on X1, bullets in the air. */
const MESSY_END_Z = -75;
const MESSY_MAX_TICKS = ticksOf(25);
/** Plays the messy sortie to its end; returns the number of ticks. */
function playMessy(sim: Sim, perTick?: (k: number) => void): number {
  let k = 0;
  while (k < MESSY_MAX_TICKS && sim.status === 'playing' && sim.player.pos.z >= MESSY_END_Z) {
    messyScript(sim, k);
    sim.tick();
    k++;
    if (perTick) perTick(k);
  }
  return k;
}

describe('re-sortie: Sim.reset() (SPEC §9)', () => {
  it('after a messy fight everything is back to the initial state; only the loadout is kept; EN = its maximum', () => {
    const loadout: Loadout = { fcs: 'narrow', generator: 'recovery', legs: 'quadruped' };
    const stage = progressionStage();
    const sim = new Sim(stage, { loadout, seed: 77 });
    const pristine = fingerprint(sim);
    const first = buildSnapshot(sim, 'playing');
    const evs: Stamped[] = [];
    // the HUD drained the events until the turret fell; what happened since is still queued
    const ticks = playMessy(sim, () => {
      if (sim.enemyById.get('T1')!.alive || sim.objective.openBarrierIds.length === 0 || sim.player.pos.z > 0) drainInto(sim, evs);
    });
    sim.advance(0.004); // a sub-tick remainder of real time is pending as well
    expect(sim.status).toBe('playing');
    expect(ticks).toBeLessThan(MESSY_MAX_TICKS);

    // ── it really is a mess ──
    const p = sim.player;
    const dirty = buildSnapshot(sim, 'playing');
    expect(p.hp).toBeLessThan(1000);
    expect(p.ammo.missile).toBeLessThan(12);
    expect(p.ammo.machinegun).toBeLessThan(300);
    expect(sim.shots.some((s) => s.weapon === 'beam')).toBe(true);
    expect(p.en).toBeLessThan(90);
    expect(p.qbSuccessfulCount).toBe(1);
    expect(p.qbLastStartedAt).not.toBeNull();
    expect(p.lastEnSpentAt).not.toBeNull();
    expect(p.glideEnabled).toBe(true);
    expect(Math.hypot(p.vel.x, p.vel.z)).toBeGreaterThan(0);
    expect(p.pos.z).toBeLessThan(-41); // beyond the opened barrier
    expect(Object.values(p.nextFireAt).every((t) => t > 0)).toBe(true);
    expect(sim.enemyById.get('T1')!.alive).toBe(false);
    expect(sim.objective).toEqual({ controlsDestroyed: 1, controlsRequired: 2, openBarrierIds: ['B1'], gateOpen: false });
    expect(sim.world.isBarrierOpen('B1')).toBe(true);
    expect(sim.nav.isBarrierOpen('B1')).toBe(true);
    expect(sim.visitedSectorIds).toEqual(['M1', 'M2']);
    expect(sim.projectiles.length).toBeGreaterThan(0);
    expect(sim.nextProjectileId).toBeGreaterThan(10);
    expect(sim.lock.state).toBe('locked');
    expect(sim.lock.targetId).toBe('X1');
    expect(sim.fireControl.status).toBe('solved');
    expect(sim.shots.length).toBeGreaterThan(10);
    expect(sim.nextShotId).toBeGreaterThan(10);
    expect(sim.events.length).toBeGreaterThan(0);
    expect(sim.input.fire).toBe(true);
    expect(sim.accumulator).toBeGreaterThan(0);
    expect(sim.time).toBeGreaterThan(4);
    expect(sim.enemyById.get('T1')!.shotsFired).toBeGreaterThan(0);
    expect(ofType(evs, 'barrier-opened').map((s) => s.e.barrierId)).toEqual(['B1']);
    expect((sim.rng as unknown as { s: number }).s).not.toBe(77);
    console.log(
      `[integration] before reset: t=${sim.time.toFixed(3)} s, hp ${p.hp}, en ${p.en.toFixed(2)}, ammo ${p.ammo.machinegun}/${p.ammo.missile}, ` +
        `${sim.shots.length} shot records (next id ${sim.nextShotId}), ${sim.projectiles.length} projectiles, lock ${sim.lock.state}:${sim.lock.targetId}, pos z ${p.pos.z.toFixed(1)}`,
    );

    // ── re-sortie with the same loadout ──
    sim.reset();
    expect(sim.loadout).toEqual(loadout);
    expect(sim.seed).toBe(77);
    const s = buildSnapshot(sim, 'playing');
    expect(s).toEqual(first);
    expect(s).not.toEqual(dirty);
    expect(s.player.en).toBe(90);
    expect(s.effectiveStats).toEqual({ maxEn: 90, regenPerSecond: 15, lockSeconds: 0.4 / 1.5, horizontalSpeedMultiplier: 0.8 });
    // the list of §9, item by item
    expect(sim.player.pos).toEqual(stage.playerStart.position);
    expect(sim.player.vel).toEqual({ x: 0, y: 0, z: 0 });
    expect(sim.player.hp).toBe(1000);
    expect(sim.player.ammo).toEqual({ machinegun: 300, missile: 12 });
    expect(sim.player.weapon).toBe('machinegun');
    expect(sim.player.nextFireAt).toEqual({ machinegun: 0, beam: 0, missile: 0 });
    expect(sim.player.glideEnabled).toBe(false);
    expect(sim.player.horizontalMode).toBe('walk');
    expect(sim.player.qbSuccessfulCount).toBe(0);
    expect(sim.player.qbLastStartedAt).toBeNull();
    expect(sim.player.qbImpulseRemaining).toBe(0);
    expect(sim.player.lastEnSpentAt).toBeNull();
    expect(sim.player.jumpHeldSince).toBeNull();
    expect(sim.enemies.map((e) => e.id)).toEqual(['T1', 'T2', 'G1', 'X1']);
    for (const e of sim.enemies) {
      expect(e.alive).toBe(true);
      expect(e.hp).toBe(e.maxHp);
      expect(e.pos).toEqual(e.def.position);
      expect(e.vel).toEqual({ x: 0, y: 0, z: 0 });
      expect([e.alert, e.hasLos, e.lastKnownPlayerPos, e.lastKnownAt, e.losLostAt]).toEqual([false, false, null, null, null]);
      expect([e.burstStartAt, e.burstShotsDone, e.telegraphStartAt, e.shotsFired, e.lastShotAt, e.destroyedAt]).toEqual([null, 0, null, 0, null, null]);
    }
    expect(sim.objective).toEqual({ controlsDestroyed: 0, controlsRequired: 2, openBarrierIds: [], gateOpen: false });
    for (const id of ['B1', 'B2', 'GATE']) {
      expect(sim.world.isBarrierOpen(id)).toBe(false);
      expect(sim.nav.isBarrierOpen(id)).toBe(false);
    }
    expect(sim.projectiles).toEqual([]);
    expect(sim.nextProjectileId).toBe(1);
    expect(sim.lock).toMatchObject({ state: 'none', targetId: null, progress: 0, heldSeconds: 0 });
    expect(sim.fireControl.status).toBe('inactive');
    expect(sim.shots).toEqual([]);
    expect(sim.nextShotId).toBe(1);
    expect(sim.input).toEqual(createInputState());
    expect(sim.events).toEqual([]);
    expect([sim.time, sim.tickIndex, sim.accumulator, sim.status, sim.failReason]).toEqual([0, 0, 0, 'playing', null]);
    expect([sim.currentSectorId, sim.visitedSectorIds]).toEqual(['M1', ['M1']]);
    // … and as a whole: indistinguishable from the first sortie and from a brand-new simulation
    expect(firstDiff(fingerprint(sim), pristine)).toBe('identical');
    expect(firstDiff(fingerprint(sim), fingerprint(new Sim(progressionStage(), { loadout, seed: 77 })))).toBe('identical');

    // the barrier is solid again: the lane ends at B1
    sim.input.moveZ = 1;
    sim.runFor(8);
    expect(sim.player.pos.z).toBeGreaterThan(-40 + PLAYER.half.z - 0.01);
    expect(sim.player.pos.z).toBeLessThan(-38);
    expect(sim.currentSectorId).toBe('M1');
    // shot and projectile numbering start over
    sim.input.moveZ = 0;
    sim.input.fire = true;
    sim.tick();
    expect(sim.shots.map((r) => r.id)).toEqual([1]);
    expect(buildSnapshot(sim, 'playing').recentPlayerShots.map((r) => r.id)).toEqual([1]);
  });

  it('the same seed and the same inputs replay the sortie snapshot for snapshot — after a reset and in a fresh simulation', () => {
    const play = (sim: Sim): string[] => {
      const out: string[] = [];
      playMessy(sim, () => out.push(JSON.stringify(buildSnapshot(sim, 'playing'))));
      out.push(fingerprint(sim));
      return out;
    };
    const sim = new Sim(progressionStage(), { seed: 2024 });
    const a = play(sim);
    sim.reset();
    const b = play(sim);
    const c = play(new Sim(progressionStage(), { seed: 2024 }));
    expect(a.length).toBeGreaterThan(ticksOf(4));
    expect(a.length).toBeLessThan(MESSY_MAX_TICKS);
    expect(firstMismatch(a, b)).toBeNull();
    expect(firstMismatch(a, c)).toBeNull();
    // a sortie with another loadout in between leaves no trace either
    sim.reset({ fcs: 'wide', generator: 'capacity', legs: 'quadruped' });
    play(sim);
    sim.reset(DEFAULT_LOADOUT);
    expect(firstMismatch(a, play(sim))).toBeNull();
    const last = JSON.parse(a[a.length - 2]) as Snapshot;
    expect(last.objective.openBarrierIds).toContain('B1');
    expect(last.recentPlayerShots.length).toBeGreaterThan(10);
    expect(new Set(last.recentPlayerShots.map((r) => r.weapon)).size).toBe(3);
    expect(last.enemies.reduce((n, e) => n + e.shotsFired, 0)).toBeGreaterThan(0);
    console.log(`[integration] messy sortie: ${a.length - 1} ticks replayed identically 4 times (reset, fresh simulation, after a sortie with another loadout)`);
  });

  it('the arena fight (guard AI, strafing, random jitter, all weapons) is reproducible tick by tick as well', () => {
    const play = (sim: Sim): string[] => {
      const out: string[] = [];
      playTicks(sim, arenaScript, ARENA_FRAMES, () => out.push(JSON.stringify(buildSnapshot(sim, 'playing'))));
      out.push(fingerprint(sim));
      return out;
    };
    const sim = new Sim(arenaStage());
    const a = play(sim);
    sim.reset();
    expect(firstMismatch(a, play(sim))).toBeNull();
    expect(firstMismatch(a, play(new Sim(arenaStage())))).toBeNull();
    const last = JSON.parse(a[a.length - 2]) as Snapshot;
    const weapons = new Set(last.recentPlayerShots.map((s) => s.weapon));
    console.log(
      `[integration] arena fight: ${a.length - 1} ticks, final hp ${last.player.hp}, en ${last.player.en.toFixed(2)}, QB ${last.player.movement.qbSuccessfulCount}, ` +
        `ammo ${last.player.ammo.machinegun}/${last.player.ammo.missile}, enemy shots ${last.enemies.map((e) => `${e.id}:${e.shotsFired}`).join(' ')}, shot weapons in the last 32: ${[...weapons].join(',')}`,
    );
    expect(last.player.movement.qbSuccessfulCount).toBe(3);
    expect(last.player.ammo.missile).toBeLessThan(12);
    expect(last.player.ammo.machinegun).toBeLessThan(300);
    expect(last.enemies.find((e) => e.id === 'G1')!.shotsFired).toBeGreaterThan(0);
    expect(last.enemies.find((e) => e.id === 'T1')!.shotsFired).toBeGreaterThan(0);
  });

  it('repeated re-sorties do not grow anything', () => {
    const sim = new Sim(progressionStage());
    const sizes = (): unknown => ({
      boxes: sim.world.boxes.length,
      grid: sim.world.getGridInfo(),
      nav: sim.nav.getInfo(),
      enemies: sim.enemies.length,
      byId: sim.enemyById.size,
      projectiles: sim.projectiles.length,
      shots: sim.shots.length,
      events: sim.events.length,
      visited: sim.visitedSectorIds.length,
      open: sim.objective.openBarrierIds.length,
      nextShotId: sim.nextShotId,
      nextProjectileId: sim.nextProjectileId,
      inputKeys: Object.keys(sim.input).length,
      snapshotBytes: JSON.stringify(buildSnapshot(sim, 'playing')).length,
    });
    const initial = sizes();
    const pristine = fingerprint(sim);
    let peakProjectiles = 0;
    for (let round = 0; round < 40; round++) {
      // sorties of 0.5 … 8 s: broken off in the shelter, in the duel, in the boost, in the glide, mid-burst
      const n = 60 + ((round * 97) % 900);
      for (let k = 0; k < n && sim.status === 'playing'; k++) {
        messyScript(sim, k);
        sim.tick();
        if (sim.projectiles.length > peakProjectiles) peakProjectiles = sim.projectiles.length;
      }
      sim.reset();
      expect(sizes()).toEqual(initial);
    }
    expect(fingerprint(sim)).toBe(pristine);
    expect(peakProjectiles).toBeGreaterThan(0);
    // two resets in a row, and a reset right after a reset, are harmless
    sim.reset();
    sim.reset();
    expect(fingerprint(sim)).toBe(pristine);
  });

  it('a different seed changes the enemy aim jitter and nothing else (turrets); the default seed is 20260908', () => {
    const stage = (): StageDef => makeTestStage({ enemies: [makeTurret('T1', -30, -60), makeTurret('T2', 25, -80), makeTurret('T3', 60, 20)] });
    const record = (seed?: number) => {
      const sim = new Sim(stage(), seed === undefined ? {} : { seed });
      const shots: Array<{ time: number; id: string; muzzle: V3; dir: V3 }> = [];
      const kin: string[] = [];
      sim.input.moveX = 1;
      for (let k = 0; k < ticksOf(8) && sim.status === 'playing'; k++) {
        if (k === 240) sim.input.qbPressed = true;
        if (k === 480) sim.input.moveX = -1;
        sim.tick();
        for (const e of sim.drainEvents()) if (e.type === 'enemy-shot') shots.push({ time: sim.time, id: e.enemyId, muzzle: e.muzzle, dir: e.dir });
        kin.push(JSON.stringify([sim.player.pos, sim.player.vel, sim.player.en, sim.enemies.map((e) => [e.shotsFired, e.lastShotAt, e.burstStartAt, e.nextBurstReadyAt])]));
      }
      return { sim, shots, kin };
    };
    const a = record(1);
    const a2 = record(1);
    const b = record(2);
    const d = record();
    expect(d.sim.seed).toBe(20260908);
    expect(a.shots.length).toBeGreaterThan(20);
    expect(JSON.stringify(a.shots)).toBe(JSON.stringify(a2.shots));
    expect(fingerprint(a.sim)).toBe(fingerprint(a2.sim));
    // same schedule, same muzzles, same pilot — only the directions differ, each by less than 2 × 0.5°
    expect(b.shots.map((s) => [s.time, s.id, s.muzzle])).toEqual(a.shots.map((s) => [s.time, s.id, s.muzzle]));
    expect(d.shots.map((s) => [s.time, s.id, s.muzzle])).toEqual(a.shots.map((s) => [s.time, s.id, s.muzzle]));
    expect(b.kin).toEqual(a.kin);
    let differing = 0;
    let maxAngle = 0;
    for (let k = 0; k < a.shots.length; k++) {
      const u = a.shots[k].dir;
      const w = b.shots[k].dir;
      const cos = Math.min(1, u.x * w.x + u.y * w.y + u.z * w.z);
      const angle = (Math.acos(cos) * 180) / Math.PI;
      if (angle > maxAngle) maxAngle = angle;
      if (angle > 1e-9) differing++;
    }
    expect(differing).toBeGreaterThan(a.shots.length * 0.9);
    expect(maxAngle).toBeLessThanOrEqual(1.0 + 1e-9);
    console.log(`[integration] seeds 1 vs 2: ${a.shots.length} turret shots at identical times, ${differing} directions differ, largest angle between them ${maxAngle.toFixed(4)}°`);
  });

  it('guards draw their strafe decisions from the same seeded stream: reproducible per seed, different between seeds', () => {
    const stage = (): StageDef => makeTestStage({ enemies: [makeGuard('G1', -20, -40), makeGuard('G2', 22, -45), makeGuard('G3', 0, -50)] });
    const track = (seed: number): string => {
      const sim = new Sim(stage(), { seed });
      const out: string[] = [];
      for (let k = 0; k < ticksOf(6) && sim.status === 'playing'; k++) {
        sim.tick();
        if (k % 12 === 0) out.push(JSON.stringify(sim.enemies.map((e) => [e.pos.x, e.pos.z, e.shotsFired])));
      }
      return out.join('\n');
    };
    expect(track(5)).toBe(track(5));
    expect(track(6)).toBe(track(6));
    expect(track(5)).not.toBe(track(6));
  });
});

// ───────────────────────────── frame-rate independence ─────────────────────────────

describe('frame-rate independence (SPEC §9)', () => {
  it('the scripted arena fight gives identical snapshots at equal times for 30 / 60 / 120 fps and irregular frames', () => {
    const record = (nextDt: () => number): { frames: string[]; state: string[]; calls: number; maxTicksPerCall: number } => {
      const sim = new Sim(arenaStage());
      const frames: string[] = [];
      const state: string[] = [];
      const info = playFrames(sim, arenaScript, ARENA_FRAMES, nextDt, () => {
        frames.push(JSON.stringify(buildSnapshot(sim, 'playing')));
        state.push(fingerprint(sim, false));
      });
      return { frames, state, ...info };
    };
    const r120 = record(() => 1 / 120);
    const r60 = record(() => 1 / 60);
    const r30 = record(() => 1 / 30);
    const r144 = record(() => 1 / 144);
    const rnd = new Rng(31337);
    const irregular = record(() => (rnd.next() < 0.1 ? rnd.range(0.0005, 0.004) : rnd.range(0.004, 0.045)));
    expect(r120.frames.length).toBe(ARENA_FRAMES);
    expect([r120.calls, r60.calls, r30.calls]).toEqual([ARENA_FRAMES * 4, ARENA_FRAMES * 2, ARENA_FRAMES]);
    expect([r120.maxTicksPerCall, r60.maxTicksPerCall, r30.maxTicksPerCall]).toEqual([1, 2, 4]);
    expect(irregular.calls).toBeGreaterThan(ARENA_FRAMES);
    for (const [name, r] of [['60', r60], ['30', r30], ['144', r144], ['irregular', irregular]] as const) {
      expect(firstMismatch(r120.frames, r.frames), `${name} fps snapshots`).toBeNull();
      expect(firstMismatch(r120.state, r.state), `${name} fps full state`).toBeNull();
    }
    // … and they are the snapshots of the plain tick-by-tick run
    const ref: string[] = [];
    const sim = new Sim(arenaStage());
    playTicks(sim, arenaScript, ARENA_FRAMES, (k) => {
      if (k % 4 === 0) ref.push(JSON.stringify(buildSnapshot(sim, 'playing')));
    });
    expect(firstMismatch(ref, r30.frames)).toBeNull();
    const end = JSON.parse(ref[ref.length - 1]) as Snapshot;
    expect(end.elapsedSeconds).toBe(ARENA_FRAMES * 4 * TICK);
    console.log(
      `[integration] frame-rate runs: advance() calls 120fps ${r120.calls}, 60fps ${r60.calls}, 30fps ${r30.calls}, 144fps ${r144.calls}, irregular ${irregular.calls}; ` +
        `all ${ARENA_FRAMES} compared frames identical; end state hp ${end.player.hp}, en ${end.player.en.toFixed(3)}, pos [${end.player.position.map((c) => c.toFixed(3)).join(', ')}]`,
    );
  });

  it('free-running frames of any length (hitches included) land on the tick-by-tick trajectory at every frame end', () => {
    // Inputs given once at t = 0 and then held: boost towards the enemies, jump + flight until the EN is gone,
    // trigger held at a moving target, while a guard and a turret attack. Frame boundaries fall wherever the
    // frame times put them.
    const start = (sim: Sim): void => {
      lookAt(sim, sim.enemyById.get('M1')!.pos);
      sim.input.fire = true;
      sim.input.moveZ = 1;
      sim.input.qbPressed = true;
      sim.input.jump = true;
      sim.input.jumpPressed = true;
    };
    const ref: string[] = [];
    {
      const sim = new Sim(arenaStage());
      start(sim);
      ref.push(fingerprint(sim, false));
      let solvedTicks = 0;
      let flyingTicks = 0;
      while (sim.tickIndex < ticksOf(9) && sim.status === 'playing') {
        sim.tick();
        ref.push(fingerprint(sim, false));
        if (sim.fireControl.status === 'solved') solvedTicks++;
        if (sim.player.flying) flyingTicks++;
      }
      expect(sim.player.qbSuccessfulCount).toBe(1);
      expect(sim.shots.length).toBe(32);
      expect(solvedTicks).toBeGreaterThan(10);
      expect(flyingTicks).toBeGreaterThan(120);
      expect(sim.enemies.reduce((n, e) => n + e.shotsFired, 0)).toBeGreaterThan(10);
      expect(sim.player.hp).toBeLessThan(1000);
      console.log(
        `[integration] free-running reference: ${ref.length - 1} ticks, status ${sim.status}, hp ${sim.player.hp}, en ${sim.player.en.toFixed(2)}, ` +
          `enemy shots ${sim.enemies.reduce((n, e) => n + e.shotsFired, 0)}, player shot records up to id ${sim.nextShotId - 1}`,
      );
    }
    const rnd = new Rng(99);
    const patterns: Array<[string, () => number]> = [
      ['30 fps', () => 1 / 30],
      ['60 fps', () => 1 / 60],
      ['75 fps', () => 1 / 75],
      ['120 fps', () => 1 / 120],
      ['144 fps', () => 1 / 144],
      ['240 fps', () => 1 / 240],
      ['irregular 20–300 fps with hitches', () => (rnd.next() < 0.03 ? rnd.range(0.1, 0.6) : rnd.range(0.0033, 0.05))],
    ];
    for (const [name, nextDt] of patterns) {
      const sim = new Sim(arenaStage());
      start(sim);
      let compared = 0;
      let bad: string | null = null;
      let fed = 0;
      while (sim.tickIndex < ticksOf(9) - 30 && sim.status === 'playing') {
        const dt = nextDt();
        fed += Math.min(dt, MAX_FRAME_DT);
        sim.advance(dt);
        if (fingerprint(sim, false) !== ref[sim.tickIndex] && bad === null) bad = `tick ${sim.tickIndex}: ${firstDiff(ref[sim.tickIndex], fingerprint(sim, false))}`;
        compared++;
        // simulated time = real time fed (capped per frame) minus the pending sub-tick remainder
        if (Math.abs(sim.time + sim.accumulator - fed) > 1e-9 && bad === null) bad = `time bookkeeping off at tick ${sim.tickIndex}`;
      }
      expect(bad, name).toBeNull();
      expect(compared).toBeGreaterThan(100);
    }
  });

  it('a boost pressed "whenever the frame happens to come" still follows the same distance and EN curves (both leg types)', () => {
    const rnd = new Rng(5);
    const patterns: Array<[string, () => number]> = [
      ['30 fps', () => 1 / 30],
      ['60 fps', () => 1 / 60],
      ['120 fps', () => 1 / 120],
      ['144 fps', () => 1 / 144],
      ['irregular', () => rnd.range(0.004, 0.04)],
    ];
    for (const legs of ['biped', 'quadruped'] as LegsId[]) {
      const m = legs === 'biped' ? 1 : 0.8;
      const regen = 15 * (legs === 'biped' ? 1 : 0.75);
      const a = ((80 - 22) / 0.6) * m;
      const distanceAt = (tau: number): number => {
        if (tau <= 0.15) return 80 * m * tau;
        if (tau <= 0.75) return 12 * m + 80 * m * (tau - 0.15) - 0.5 * a * (tau - 0.15) ** 2;
        return 42.6 * m + 22 * m * (tau - 0.75);
      };
      const enAt = (tau: number): number => Math.min(120, tau <= 0.75 ? 84 : 84 + regen * (tau - 0.75));
      const starts: number[] = [];
      for (const [name, nextDt] of patterns) {
        const sim = new Sim(makeTestStage(), { loadout: { fcs: 'medium', generator: 'balanced', legs } });
        let worstPos = 0;
        let worstEn = 0;
        let samples = 0;
        let z0 = 0;
        while (sim.time < 4.5) {
          if (sim.time >= 0.5 && sim.player.qbSuccessfulCount === 0) {
            sim.input.qbPressed = true; // pressed at the first frame at or after t = 0.5 s; nothing else is ever held
            z0 = sim.player.pos.z;
          }
          sim.advance(nextDt());
          const t0 = sim.player.qbLastStartedAt;
          if (t0 === null) continue;
          const tau = sim.time - t0;
          worstPos = Math.max(worstPos, Math.abs(z0 - sim.player.pos.z - distanceAt(tau)));
          worstEn = Math.max(worstEn, Math.abs(sim.player.en - enAt(tau)));
          samples++;
        }
        expect(sim.player.qbSuccessfulCount, name).toBe(1);
        expect(worstPos, `${legs} ${name}: distance curve`).toBeLessThan(1e-8);
        expect(worstEn, `${legs} ${name}: EN curve`).toBeLessThan(1e-8);
        expect(samples).toBeGreaterThan(50);
        expect(Math.hypot(sim.player.vel.x, sim.player.vel.z)).toBeCloseTo(22 * m, 9); // still gliding, nothing held
        starts.push(sim.player.qbLastStartedAt as number);
      }
      // the press itself is sampled per frame: it starts within one frame after 0.5 s, never earlier
      for (const t of starts) {
        expect(t).toBeGreaterThanOrEqual(0.5 - 1e-9);
        expect(t).toBeLessThan(0.5 + 0.045);
      }
      expect(distanceAt(0.75)).toBeCloseTo(legs === 'biped' ? 42.6 : 34.08, 12);
    }
  });
});

// ───────────────────────────── progression, clear, failure ─────────────────────────────

describe('progression: barriers, control turrets, final gate, exit (SPEC §2.1)', () => {
  it('waiting, walking into a barrier and pressing against the closed gate never clear; each control turret opens its own barrier; the gate needs both; entering the exit zone alive clears', () => {
    const sim = new Sim(progressionStage());
    const evs: Stamped[] = [];
    const drain = (): void => drainInto(sim, evs);
    const p = sim.player;

    // 1. waiting at the sheltered start: nothing happens (no clear by time, no damage before any input)
    run(sim, ticksOf(6), undefined, drain);
    expect(sim.status).toBe('playing');
    expect(p.hp).toBe(1000);
    expect(sim.enemies.every((e) => !e.hasLos && !e.alert)).toBe(true);
    expect(sim.objective).toEqual({ controlsDestroyed: 0, controlsRequired: 2, openBarrierIds: [], gateOpen: false });

    // 2. the lane ends at the closed barrier B1 (pressing against it for seconds changes nothing)
    sim.input.moveZ = 1;
    run(sim, ticksOf(8), undefined, drain);
    sim.input.moveZ = 0;
    const atB1 = p.pos.z;
    expect(atB1).toBeGreaterThanOrEqual(-40 + PLAYER.half.z);
    expect(atB1).toBeLessThan(-40 + PLAYER.half.z + 0.01);
    expect(Math.abs(p.vel.z)).toBe(0);
    expect(sim.status).toBe('playing');
    expect(sim.currentSectorId).toBe('M1');
    expect(sim.world.isBarrierOpen('B1')).toBe(false);
    // closed barriers block shots and sight as well: the passive target behind B1 can not be locked
    lookAt(sim, sim.enemyById.get('X1')!.pos);
    run(sim, ticksOf(1), undefined, drain);
    expect(sim.lock.targetId).toBeNull();

    // 3. destroying control turret T1 opens B1 — and only B1
    const hpBefore = p.hp;
    const used = killWithMissiles(sim, 'T1');
    drain();
    expect(sim.enemyById.get('T1')!.alive).toBe(false);
    expect(p.ammo.missile).toBe(10); // 2 × 180 ≥ 240
    expect(ofType(evs, 'barrier-opened').map((s) => [s.e.barrierId, s.e.controlEnemyId])).toEqual([['B1', 'T1']]);
    expect(ofType(evs, 'gate-opened').length).toBe(0);
    expect(sim.objective).toEqual({ controlsDestroyed: 1, controlsRequired: 2, openBarrierIds: ['B1'], gateOpen: false });
    expect([sim.world.isBarrierOpen('B1'), sim.world.isBarrierOpen('B2'), sim.world.isBarrierOpen('GATE')]).toEqual([true, false, false]);
    expect([sim.nav.isBarrierOpen('B1'), sim.nav.isBarrierOpen('B2'), sim.nav.isBarrierOpen('GATE')]).toEqual([true, false, false]);
    expect(sim.getObjectiveTarget()).toMatchObject({ kind: 'control', id: 'T2' });
    console.log(`[integration] T1 destroyed ${(used * TICK).toFixed(2)} s after the first missile order; damage taken at the barrier so far ${1000 - p.hp} (${hpBefore - p.hp} during the duel)`);

    // 4. now the lane continues: through B1 into room 2, up to the closed final gate
    face(sim, 0);
    sim.input.moveZ = 1;
    run(sim, ticksOf(9), undefined, drain);
    expect(p.pos.z).toBeLessThan(-41 - PLAYER.half.z);
    expect(sim.visitedSectorIds).toEqual(['M1', 'M2']);
    const atGate = p.pos.z;
    expect(atGate).toBeGreaterThanOrEqual(-120 + PLAYER.half.z);
    expect(atGate).toBeLessThan(-120 + PLAYER.half.z + 0.01);
    // touching the closed gate, and waiting there, is not a clear
    run(sim, ticksOf(3), undefined, drain);
    sim.input.moveZ = 0;
    run(sim, ticksOf(2), undefined, drain);
    expect(sim.status).toBe('playing');
    expect(p.pos.z).toBe(atGate);
    expect(sim.objective.gateOpen).toBe(false);
    expect(ofType(evs, 'cleared').length).toBe(0);
    expect(buildSnapshot(sim, 'playing').objective).toEqual({ controlsDestroyed: 1, controlsRequired: 2, openBarrierIds: ['B1'], gateOpen: false });

    // 5. the second control turret: step out of the cover, destroy it → B2 and the final gate open
    expect(walkTo(sim, -8, -116, 4)).toBe(true);
    killWithMissiles(sim, 'T2');
    drain();
    expect(sim.status).toBe('playing');
    expect(sim.enemyById.get('T2')!.alive).toBe(false);
    expect(ofType(evs, 'barrier-opened').map((s) => s.e.barrierId)).toEqual(['B1', 'B2']);
    expect(ofType(evs, 'gate-opened').length).toBe(1);
    expect(ofType(evs, 'gate-opened')[0].tick).toBe(ofType(evs, 'barrier-opened')[1].tick);
    expect(sim.objective).toEqual({ controlsDestroyed: 2, controlsRequired: 2, openBarrierIds: ['B1', 'B2'], gateOpen: true });
    expect(['B1', 'B2', 'GATE'].map((id) => sim.world.isBarrierOpen(id) && sim.nav.isBarrierOpen(id))).toEqual([true, true, true]);
    expect(sim.getObjectiveTarget().kind).toBe('exit');
    expect(ofType(evs, 'cleared').length).toBe(0); // an open gate alone is not a clear either

    // 6. through the gate into the exit zone
    expect(walkTo(sim, 0, -118, 4)).toBe(true);
    face(sim, 0);
    sim.input.moveZ = 1;
    let lastOutside = p.pos.z;
    for (let k = 0; k < ticksOf(4) && sim.status === 'playing'; k++) {
      lastOutside = p.pos.z;
      sim.tick();
      drain();
    }
    drain();
    expect(sim.status).toBe('cleared');
    expect(sim.failReason).toBeNull();
    expect(p.hp).toBeGreaterThan(0);
    expect(lastOutside).toBeGreaterThan(-130); // the tick before, the centre was still outside the zone
    expect(p.pos.z).toBeLessThanOrEqual(-130);
    expect(p.pos.z).toBeGreaterThan(-130 - 10 * TICK - 1e-9); // cleared in the very update in which it entered
    expect(ofType(evs, 'cleared').length).toBe(1);
    expect(ofType(evs, 'failed').length).toBe(0);
    expect(sim.visitedSectorIds).toEqual(['M1', 'M2', 'M3']);
    const s = buildSnapshot(sim, 'cleared');
    expect(s.state).toBe('cleared');
    expect(s.objective).toEqual({ controlsDestroyed: 2, controlsRequired: 2, openBarrierIds: ['B1', 'B2'], gateOpen: true });
    expect(s.stage).toEqual({ sectorCount: 3, currentSectorId: 'M3', visitedSectorIds: ['M1', 'M2', 'M3'], totalEnemies: 4 });
    expect(s.enemies.map((e) => [e.id, e.alive])).toEqual([['T1', false], ['T2', false], ['G1', true], ['X1', true]]);
    console.log(`[integration] progression run cleared at t=${sim.time.toFixed(2)} s with hp ${p.hp}; G1 (alive, 39 enemies need not die) fired ${sim.enemyById.get('G1')!.shotsFired} shots`);
    // the fight is over: nothing advances any more
    const frozen = fingerprint(sim);
    expect(sim.advance(0.1)).toBe(0);
    expect(fingerprint(sim)).toBe(frozen);
  });

  it('an opened barrier also opens the way for the guards (navigation follows the objective state)', () => {
    const sim = new Sim(progressionStage());
    const yard = v3(26, ENEMIES.guard.centerHeight, -65);
    const room2 = v3(0, ENEMIES.guard.centerHeight, -80);
    const room1 = v3(0, ENEMIES.guard.centerHeight, 0);
    const exit = v3(0, ENEMIES.guard.centerHeight, -150);
    expect([sim.nav.connected(yard, room2), sim.nav.connected(room2, room1), sim.nav.connected(room2, exit)]).toEqual([false, false, false]);
    sim.damageEnemy(sim.enemyById.get('T1')!, 240); // harness: the control turrets are destroyed without a fight
    sim.tick();
    expect([sim.nav.connected(yard, room2), sim.nav.connected(room2, room1), sim.nav.connected(room2, exit)]).toEqual([false, true, false]);
    sim.damageEnemy(sim.enemyById.get('T2')!, 240);
    sim.tick();
    expect([sim.nav.connected(yard, room2), sim.nav.connected(room2, room1), sim.nav.connected(room2, exit)]).toEqual([true, true, true]);
    // the guard in the yard is hit and comes out through the opened door B2 towards the player in room 1
    const g = sim.enemyById.get('G1')!;
    expect(g.pos.x).toBeGreaterThan(13);
    sim.player.hp = 1e6; // harness: this check is about the guard's route, not about the duel
    expect(walkTo(sim, 0, -65, 12)).toBe(true); // in front of the open door: the guard sees the mech
    run(sim, ticksOf(1));
    expect(g.alert).toBe(true);
    face(sim, 0);
    sim.input.moveZ = -1; // back off north along the lane, out of its sight: it has to come through the door
    let minX = g.pos.x;
    for (let k = 0; k < ticksOf(10) && g.alive && sim.status === 'playing'; k++) {
      if (sim.player.pos.z > -45) sim.input.moveZ = 0;
      sim.tick();
      if (g.pos.x < minX) minX = g.pos.x;
    }
    console.log(`[integration] guard G1 after B2 opened: smallest x reached ${minX.toFixed(2)} (door plane x = 12..13), alert ${g.alert}`);
    expect(minX).toBeLessThan(12 - ENEMIES.guard.radius);
    sim.reset();
    expect([sim.nav.connected(yard, room2), sim.nav.connected(room2, room1), sim.nav.connected(room2, exit)]).toEqual([false, false, false]);
  });

  it('being inside the exit zone while the gate is closed is not a clear; with the gate open it is, at once', () => {
    const sim = new Sim(progressionStage());
    const inside = v3(0, STAND_Y, -145);
    Object.assign(sim.player.pos, inside); // harness: placed behind the closed gate (as after a sequence break)
    run(sim, ticksOf(3));
    expect(sim.status).toBe('playing');
    expect(sim.currentSectorId).toBe('M3');
    sim.damageEnemy(sim.enemyById.get('T1')!, 1e4); // harness
    run(sim, ticksOf(1));
    expect(sim.status).toBe('playing'); // one of two controls: the gate stays shut, still no clear
    expect(sim.objective.gateOpen).toBe(false);
    sim.damageEnemy(sim.enemyById.get('T2')!, 1e4); // harness
    expect(sim.objective.gateOpen).toBe(true);
    sim.tick();
    expect(sim.status).toBe('cleared');
  });
});

describe('failure (SPEC §2.1, §2.3, §9)', () => {
  it('HP ≤ 0: two guards and a turret at 35–50 m destroy a stationary 1000-HP mech within 15 s by ordinary fire', () => {
    const sim = new Sim(makeTestStage({ enemies: [makeGuard('G1', -25, -30), makeGuard('G2', 28, -32), makeTurret('T1', 0, -48)] }));
    for (const e of sim.enemies) {
      const d = Math.hypot(e.pos.x, e.pos.y - sim.player.pos.y, e.pos.z);
      expect(d).toBeGreaterThanOrEqual(35);
      expect(d).toBeLessThanOrEqual(50);
    }
    const evs: Stamped[] = [];
    let hpPrev = sim.player.hp;
    let unexplained = 0;
    while (sim.status === 'playing' && sim.time < 20) {
      sim.tick();
      const before = evs.length;
      drainInto(sim, evs);
      const dmg = evs.slice(before).reduce((n, s) => n + (s.e.type === 'player-damaged' ? s.e.amount : 0), 0);
      if (hpPrev - sim.player.hp !== Math.min(dmg, hpPrev)) unexplained++; // HP only ever drops by bullets that arrived
      hpPrev = sim.player.hp;
    }
    expect(sim.status).toBe('failed');
    expect(sim.failReason).toBe('destroyed');
    expect(sim.player.hp).toBe(0);
    expect(unexplained).toBe(0);
    expect(sim.time).toBeLessThanOrEqual(15);
    const failed = ofType(evs, 'failed');
    expect(failed.length).toBe(1);
    expect(failed[0].e.reason).toBe('destroyed');
    expect(ofType(evs, 'cleared').length).toBe(0);
    const hits = ofType(evs, 'player-damaged');
    expect(new Set(hits.map((h) => h.e.fromEnemyId))).toEqual(new Set(['G1', 'G2', 'T1'])); // all three attack on their own
    expect(hits.every((h) => h.e.amount === 18 || h.e.amount === 40)).toBe(true);
    // shotsFired counts exactly the bullets that were really created (the pilot never fired: every projectile is theirs)
    const fired = sim.enemies.reduce((n, e) => n + e.shotsFired, 0);
    expect(fired).toBe(sim.nextProjectileId - 1);
    expect(fired).toBe(ofType(evs, 'enemy-shot').length);
    expect(hits.length).toBeLessThanOrEqual(fired);
    const s = buildSnapshot(sim, 'failed');
    expect(s.state).toBe('failed');
    expect(s.player.hp).toBe(0);
    console.log(`[integration] stationary mech destroyed at t=${sim.time.toFixed(3)} s by ${hits.length} hits (${sim.enemies.map((e) => `${e.id}: ${e.shotsFired} shots`).join(', ')})`);
    const frozen = fingerprint(sim);
    expect(sim.advance(1)).toBe(0);
    expect(fingerprint(sim)).toBe(frozen);
  });

  it('falling out of the stage: failed with reason "fell" when the centre drops below killY — no EN regeneration, no rescue', () => {
    const sim = new Sim(makeTestStage({ floorSize: 30 }));
    expect(sim.stage.killY).toBe(-40);
    sim.input.qbPressed = true;
    const evs: Stamped[] = [];
    let leftGroundAt: number | null = null;
    let enWhenLeaving = 0;
    let lastAbove = 0;
    while (sim.status === 'playing' && sim.time < 10) {
      lastAbove = sim.player.pos.y;
      sim.tick();
      drainInto(sim, evs);
      if (leftGroundAt === null && !sim.player.grounded) {
        leftGroundAt = sim.time;
        enWhenLeaving = sim.player.en;
      }
      if (leftGroundAt !== null) expect(sim.player.en).toBe(enWhenLeaving); // never regenerates in the air
    }
    expect(sim.status).toBe('failed');
    expect(sim.failReason).toBe('fell');
    expect(leftGroundAt).not.toBeNull();
    expect(lastAbove).toBeGreaterThanOrEqual(-40);
    expect(sim.player.pos.y).toBeLessThan(-40);
    expect(sim.player.hp).toBe(1000);
    expect(ofType(evs, 'failed').map((s) => s.e.reason)).toEqual(['fell']);
    // free fall from the slab edge: 42 m below the standing height at 18 m/s² ≈ 2.16 s
    const fallTime = sim.time - (leftGroundAt as number);
    expect(fallTime).toBeGreaterThan(Math.sqrt((2 * 42) / 18) - 0.02);
    expect(fallTime).toBeLessThan(Math.sqrt((2 * 42) / 18) + 0.02);
    console.log(`[integration] fell: left the slab at t=${(leftGroundAt as number).toFixed(3)} s, failed at t=${sim.time.toFixed(3)} s (y=${sim.player.pos.y.toFixed(2)})`);
    expect(buildSnapshot(sim, 'failed').player.position[1]).toBe(sim.player.pos.y);
  });

  /** A flat stage whose exit zone lies straight ahead; the single control turret is far out of every range. */
  const exitAhead = (zone: { min: V3; max: V3 }, floorSize = 800): StageDef => {
    const control = makeTurret('C1', 0, 320);
    control.isGateControl = true;
    return { ...makeTestStage({ floorSize, enemies: [control, makeTurret('T9', 300, 300)] }), exitZone: zone };
  };

  it('failure has priority: HP reaching 0 in the very update in which the exit zone is entered is a failure, not a clear', () => {
    const zone = { min: v3(-10, 0, -40), max: v3(10, 20, -20) };
    const prepare = (): Sim => {
      const sim = new Sim(exitAhead(zone));
      sim.damageEnemy(sim.enemyById.get('C1')!, 240); // harness: the gate is open
      sim.input.moveZ = 1;
      return sim;
    };
    // reference: how many ticks until the walk into the zone clears the sortie
    const ref = prepare();
    let n = 0;
    while (ref.status === 'playing' && n < 2000) {
      ref.tick();
      n++;
    }
    expect(ref.status).toBe('cleared');
    expect(ref.player.pos.z).toBeLessThanOrEqual(-20);

    /** Same walk; one tick before the clear an enemy bullet is placed 0.2 m in front of the hull, flying at it. */
    const withBullet = (hp: number): { sim: Sim; evs: Stamped[] } => {
      const sim = prepare();
      for (let k = 0; k < n - 1; k++) sim.tick();
      expect(sim.status).toBe('playing');
      expect(sim.player.pos.z).toBeGreaterThan(-20); // not in the zone yet
      sim.drainEvents();
      sim.player.hp = hp; // harness
      const p = sim.player.pos;
      const bullet = spawnEnemyBullet(sim, sim.enemyById.get('T9')!, v3(p.x, p.y, p.z - PLAYER.half.z - 0.2), v3(0, 0, 1));
      expect(bullet.alive).toBe(true);
      expect(bullet.damage).toBe(40);
      sim.tick();
      const evs: Stamped[] = [];
      drainInto(sim, evs);
      return { sim, evs };
    };
    const dead = withBullet(40);
    expect(dead.sim.player.pos.z).toBeLessThanOrEqual(-20); // it did enter the zone in this update …
    expect(dead.sim.player.hp).toBe(0); // … and was hit in the same update
    expect(ofType(dead.evs, 'player-damaged').length).toBe(1);
    expect(dead.sim.status).toBe('failed');
    expect(dead.sim.failReason).toBe('destroyed');
    expect(ofType(dead.evs, 'failed').length).toBe(1);
    expect(ofType(dead.evs, 'cleared').length).toBe(0);
    // control: the same hit survived with 1 HP is a clear ("alive" is all it takes)
    const alive = withBullet(41);
    expect(alive.sim.player.hp).toBe(1);
    expect(alive.sim.status).toBe('cleared');
    expect(ofType(alive.evs, 'cleared').length).toBe(1);
    expect(ofType(alive.evs, 'failed').length).toBe(0);
  });

  it('failure has priority: an exit zone that can only be reached below killY never clears', () => {
    // The zone lies under the edge of a small slab, entirely below killY (−40): being in it always means having fallen.
    const zone = { min: v3(-200, -80, -200), max: v3(200, -40, 200) };
    const sim = new Sim(exitAhead(zone, 30));
    sim.damageEnemy(sim.enemyById.get('C1')!, 240); // harness: the gate is open
    expect(sim.objective.gateOpen).toBe(true);
    sim.input.moveZ = 1;
    const evs: Stamped[] = [];
    while (sim.status === 'playing' && sim.time < 12) {
      sim.tick();
      drainInto(sim, evs);
    }
    expect(sim.status).toBe('failed');
    expect(sim.failReason).toBe('fell');
    expect(ofType(evs, 'cleared').length).toBe(0);
    // had the failure check not come first, this very position would have cleared the sortie (gate open, inside the zone)
    const p = sim.player.pos;
    expect(p.y).toBeLessThan(sim.stage.killY);
    expect(p.x >= zone.min.x && p.x <= zone.max.x && p.y >= zone.min.y && p.y <= zone.max.y && p.z >= zone.min.z && p.z <= zone.max.z).toBe(true);
  });
});

// ───────────────────────────── EN ─────────────────────────────

describe('EN: one tank, QB → beam → flight in the same update (SPEC §6)', () => {
  const h = TICK;
  /**
   * The mech is in thrust flight (Space held since t = 0), the beam is selected and ready. Then, in ONE
   * update: Q is pressed, the trigger is pulled and Space is still held, with exactly `en` in the tank.
   */
  const oneUpdate = (en: number) => {
    const sim = new Sim(makeTestStage());
    sim.input.weaponSelect = 'beam';
    sim.input.jump = true;
    sim.input.jumpPressed = true;
    sim.runFor(0.5);
    const p = sim.player;
    expect(p.flying).toBe(true);
    expect(p.vel.y).toBe(8);
    expect(p.weapon).toBe('beam');
    p.en = en; // harness: the tank level under test
    sim.drainEvents();
    const y0 = p.pos.y;
    sim.input.qbPressed = true;
    sim.input.fire = true;
    sim.tick();
    const evs: Stamped[] = [];
    drainInto(sim, evs);
    return {
      sim,
      evs,
      en: p.en,
      qb: p.qbSuccessfulCount,
      beams: sim.shots.filter((s) => s.weapon === 'beam').length,
      dy: p.pos.y - y0,
      vy: p.vel.y,
      flying: p.flying,
      speed: Math.hypot(p.vel.x, p.vel.z),
    };
  };
  const full = { dy: 8 * h, vy: 8 };
  const none = { dy: 8 * h - 9 * h * h, vy: 8 - 18 * h };
  const partial = (tau: number) => ({ dy: 8 * tau + 8 * (h - tau) - 9 * (h - tau) ** 2, vy: 8 - 18 * (h - tau) });

  it('enough for everything: 36 + 8 + 20·h are paid once each', () => {
    const r = oneUpdate(100);
    expect([r.qb, r.beams, r.flying]).toEqual([1, 1, true]);
    expect(r.en).toBeCloseTo(100 - 36 - 8 - 20 * h, 10);
    expect(r.dy).toBeCloseTo(full.dy, 10);
    expect(r.vy).toBe(8);
    expect(r.speed).toBeCloseTo(80, 9); // the boost is a horizontal affair; the climb is untouched
    expect(ofType(r.evs, 'qb')[0].e.airborne).toBe(true);
    expect(r.sim.player.lastEnSpentAt).toBe(r.sim.time);
  });

  it('44.1 EN: boost, beam, and only the 0.1 EN that is left buys thrust (5 ms of it) — the tank ends at exactly 0', () => {
    const r = oneUpdate(44.1);
    expect([r.qb, r.beams, r.flying]).toEqual([1, 1, true]);
    expect(r.en).toBeCloseTo(0, 10);
    expect(r.en).toBeGreaterThanOrEqual(0);
    const want = partial(0.1 / 20);
    expect(r.dy).toBeCloseTo(want.dy, 10);
    expect(r.vy).toBeCloseTo(want.vy, 10);
    expect(r.dy).toBeLessThan(full.dy); // no free climb for the unpaid part of the update
  });

  it('44.0 EN: boost and beam succeed, nothing is left for the thrusters', () => {
    const r = oneUpdate(44);
    expect([r.qb, r.beams, r.flying]).toEqual([1, 1, false]);
    expect(r.en).toBe(0);
    expect(r.dy).toBeCloseTo(none.dy, 10);
    expect(r.vy).toBeCloseTo(none.vy, 10);
    expect(ofType(r.evs, 'fire-rejected').length).toBe(0);
  });

  it('43.9 EN: the boost leaves 7.9 — the beam fails (and costs nothing), the thrusters take their share', () => {
    const r = oneUpdate(43.9);
    expect([r.qb, r.beams, r.flying]).toEqual([1, 0, true]);
    expect(r.en).toBeCloseTo(43.9 - 36 - 20 * h, 10);
    expect(ofType(r.evs, 'fire-rejected').map((s) => [s.e.weapon, s.e.reason])).toEqual([['beam', 'no-en']]);
    expect(r.sim.player.nextFireAt.beam).toBe(0); // a refused shot starts no interval
    expect(r.dy).toBeCloseTo(full.dy, 10);
  });

  it('35.9 EN: the boost fails (no cost, no cooldown, not queued); beam and thrust are paid', () => {
    const r = oneUpdate(35.9);
    expect([r.qb, r.beams, r.flying]).toEqual([0, 1, true]);
    expect(r.en).toBeCloseTo(35.9 - 8 - 20 * h, 10);
    expect(ofType(r.evs, 'qb-rejected').map((s) => s.e.reason)).toEqual(['no-en']);
    expect(r.sim.player.qbLastStartedAt).toBeNull();
    expect(r.speed).toBe(0);
    // the failed press is not remembered: with a full tank later, no boost starts by itself
    r.sim.player.en = 120; // harness
    r.sim.input.fire = false;
    r.sim.runFor(1);
    expect(r.sim.player.qbSuccessfulCount).toBe(0);
  });

  it('8.05 EN: only the beam and 2.5 ms of thrust; 5 EN: only thrust; 0 EN: nothing, and never below zero', () => {
    let r = oneUpdate(8.05);
    expect([r.qb, r.beams, r.flying]).toEqual([0, 1, true]);
    expect(r.en).toBeCloseTo(0, 10);
    expect(r.en).toBeGreaterThanOrEqual(0);
    expect(r.dy).toBeCloseTo(partial(0.05 / 20).dy, 10);

    r = oneUpdate(5);
    expect([r.qb, r.beams, r.flying]).toEqual([0, 0, true]);
    expect(r.en).toBeCloseTo(5 - 20 * h, 10);
    expect(ofType(r.evs, 'fire-rejected').map((s) => s.e.reason)).toEqual(['no-en']);
    expect(ofType(r.evs, 'qb-rejected').map((s) => s.e.reason)).toEqual(['no-en']);

    r = oneUpdate(0);
    expect([r.qb, r.beams, r.flying]).toEqual([0, 0, false]);
    expect(r.en).toBe(0);
    expect(r.dy).toBeCloseTo(none.dy, 10);
    expect(r.sim.player.lastEnSpentAt).toBeLessThan(r.sim.time); // nothing was spent in this update
  });

  it('over a whole fight the tank never leaves [0, max] and every drop is explained by 36 / 8 / 20·t', () => {
    const sim = new Sim(arenaStage(), { loadout: { fcs: 'medium', generator: 'recovery', legs: 'biped' } });
    let prevEn = sim.player.en;
    let prevQb = 0;
    let prevBeams = 0;
    let beams = 0;
    let worst = 0;
    let minEn = prevEn;
    let rises = 0;
    playTicks(sim, (s, f) => {
      arenaScript(s, f);
      if (f === Math.round(4.2 * 30)) s.input.jump = true; // keep Space down through the beam phase as well
      if (f === Math.round(4.2 * 30)) s.input.jumpPressed = true;
    }, ARENA_FRAMES, () => {
      const p = sim.player;
      for (const e of sim.drainEvents()) if (e.type === 'player-shot' && e.weapon === 'beam') beams++;
      const spent = prevEn - p.en;
      const qbCost = 36 * (p.qbSuccessfulCount - prevQb);
      const beamCost = 8 * (beams - prevBeams);
      const flight = spent - qbCost - beamCost; // what is left must be thrust (0 … 20·h) or regeneration (≤ 0)
      if (flight > 20 * TICK + 1e-9) worst = Math.max(worst, flight);
      if (flight < -20 * TICK - 1e-9) worst = Math.max(worst, -flight);
      if (p.en > prevEn) {
        rises++;
        if (!p.grounded) worst = Math.max(worst, 1000); // regeneration in the air
      }
      if (p.en < minEn) minEn = p.en;
      if (p.en < 0 || p.en > 90) worst = Math.max(worst, 2000);
      prevEn = p.en;
      prevQb = p.qbSuccessfulCount;
      prevBeams = beams;
    });
    expect(worst).toBe(0);
    expect(beams).toBeGreaterThan(0);
    expect(rises).toBeGreaterThan(0);
    expect(minEn).toBeGreaterThanOrEqual(0);
    console.log(`[integration] EN audit over the arena fight (90 EN generator): ${sim.player.qbSuccessfulCount} boosts, ${beams} beam shots, lowest level ${minEn.toFixed(3)}`);
  });
});

// ───────────────────────────── weapons ─────────────────────────────

describe('weapon switching keeps ammunition, EN, per-weapon timers and the lock (SPEC §3, §4.1, §5)', () => {
  it('the three weapons keep their own next-fire times across switches; nothing is refilled or reset', () => {
    const sim = new Sim(makeTestStage({ enemies: [makeTarget('X', v3(0, EYE_Y, -60))] }));
    const p = sim.player;
    const evs: Stamped[] = [];
    const step = (n = 1): void => run(sim, n, 'X', () => drainInto(sim, evs));
    const shotTimes = (w: Weapon): number[] => ofType(evs, 'player-shot').filter((s) => s.e.weapon === w).map((s) => s.time);

    // lock progress is not disturbed by switching every tick
    step(ticksOf(0.3));
    const progress = sim.lock.progress;
    for (let k = 0; k < 30; k++) {
      sim.input.weaponSelect = (['beam', 'missile', 'machinegun'] as Weapon[])[k % 3];
      step();
    }
    expect(sim.lock.targetId).toBe('X');
    expect(sim.lock.progress).toBeCloseTo(progress + (30 * TICK) / 0.8, 9);
    expect([p.ammo.machinegun, p.ammo.missile, p.en]).toEqual([300, 12, 120]);
    expect(p.nextFireAt).toEqual({ machinegun: 0, beam: 0, missile: 0 });
    step(ticksOf(0.6));
    expect(sim.lock.state).toBe('locked');
    const lockedSince = sim.lock.heldSeconds;

    // machine gun at tA; beam one tick later (its own timer is free); back to the machine gun at once:
    // the gun's 0.10 s interval is still running and ends exactly 0.10 s after tA
    expect(p.weapon).toBe('machinegun');
    sim.input.fire = true;
    step();
    const tA = shotTimes('machinegun')[0];
    expect(tA).toBe(sim.time);
    sim.input.weaponSelect = 'beam';
    step();
    expect(shotTimes('beam').length).toBe(1);
    expect(shotTimes('beam')[0]).toBeCloseTo(tA + TICK, 12);
    expect(p.en).toBe(112);
    sim.input.weaponSelect = 'machinegun';
    step(ticksOf(0.1));
    expect(shotTimes('machinegun').length).toBe(2);
    expect(shotTimes('machinegun')[1]).toBeCloseTo(tA + 0.1, 12);
    expect(p.nextFireAt.beam).toBeCloseTo(tA + TICK + 0.25, 12);

    // missile at tM; a detour over the other two weapons does not shorten its 1.00 s interval
    sim.input.weaponSelect = 'missile';
    step();
    const tM = shotTimes('missile')[0];
    expect(tM).toBe(sim.time);
    expect(p.ammo.missile).toBe(11);
    sim.input.weaponSelect = 'machinegun';
    step(ticksOf(0.3));
    sim.input.weaponSelect = 'beam';
    step(ticksOf(0.3));
    sim.input.weaponSelect = 'missile';
    step(ticksOf(0.3));
    expect(shotTimes('missile').length).toBe(1);
    expect(p.nextFireAt.missile).toBeCloseTo(tM + 1, 12);
    step(ticksOf(0.2));
    expect(shotTimes('missile').length).toBe(2);
    expect(shotTimes('missile')[1]).toBeCloseTo(tM + 1, 12);
    sim.input.fire = false;

    // bookkeeping: exactly what was fired is gone, nothing came back with a switch
    const mg = shotTimes('machinegun').length;
    const beams = shotTimes('beam').length;
    expect(p.ammo.machinegun).toBe(300 - mg);
    expect(p.ammo.missile).toBe(10);
    expect(beams).toBeGreaterThanOrEqual(2);
    for (const w of ['machinegun', 'beam'] as Weapon[]) {
      const t = shotTimes(w);
      const gap = w === 'machinegun' ? 0.1 : 0.25;
      for (let k = 1; k < t.length; k++) expect(t[k] - t[k - 1]).toBeGreaterThanOrEqual(gap - 1e-9);
    }
    // the lock was held through all of it and never had to be re-acquired
    expect(sim.lock.state).toBe('locked');
    expect(sim.lock.heldSeconds).toBeGreaterThan(lockedSince + 1.2);
    expect(sim.shots.every((s) => s.solutionStatus === 'solved' && s.targetId === 'X')).toBe(true);
    console.log(`[integration] switching test: ${mg} MG, ${beams} beam, 2 missile shots; MG pair ${(shotTimes('machinegun')[1] - tA).toFixed(6)} s apart, missile pair ${(shotTimes('missile')[1] - tM).toFixed(6)} s apart`);
  });
});

// ───────────────────────────── 18 loadouts ─────────────────────────────

describe('all 18 loadouts: the effective stats are what the simulation really does (SPEC §5, §6)', () => {
  it('max EN, regeneration, lock time, speed multiplier — reported and measured', () => {
    const sim = new Sim(makeTestStage({ enemies: [makeTarget('X', v3(0, EYE_Y, -60))] }));
    const rows: string[] = [];
    expect(ALL_LOADOUTS.length).toBe(18);
    for (const lo of ALL_LOADOUTS) {
      // the numbers of the SPEC tables, not of config.ts
      const maxEn = { capacity: 180, balanced: 120, recovery: 90 }[lo.generator];
      const regen = { capacity: 10, balanced: 15, recovery: 20 }[lo.generator] * (lo.legs === 'quadruped' ? 0.75 : 1);
      const lockSeconds = { wide: 1.2, medium: 0.8, narrow: 0.4 }[lo.fcs] / (lo.legs === 'quadruped' ? 1.5 : 1);
      const mult = lo.legs === 'quadruped' ? 0.8 : 1;
      const radius = { wide: 0.3, medium: 0.2, narrow: 0.1 }[lo.fcs] * 720;

      sim.reset(lo);
      const s = buildSnapshot(sim, 'playing');
      expect(s.loadout).toEqual(lo);
      expect(s.effectiveStats.maxEn).toBe(maxEn);
      expect(s.effectiveStats.regenPerSecond).toBeCloseTo(regen, 12);
      expect(s.effectiveStats.lockSeconds).toBeCloseTo(lockSeconds, 12);
      expect(s.effectiveStats.horizontalSpeedMultiplier).toBe(mult);
      expect(s.effectiveStats.maxEn * { capacity: 10, balanced: 15, recovery: 20 }[lo.generator]).toBe(1800);
      expect(s.player.en).toBe(maxEn);
      expect(s.lock.radiusCssPx).toBeCloseTo(radius, 9);
      expect(computeEffectiveStats(lo)).toMatchObject({ maxEn, horizontalSpeedMultiplier: mult });

      // measured lock time: the target sits on the crosshair from the first instant of the sortie
      expect(s.lock).toMatchObject({ state: 'acquiring', targetId: 'X', progress: 0 }); // judged at t = 0
      let lockedAt = -1;
      for (let k = 1; k <= ticksOf(1.4) && lockedAt < 0; k++) {
        sim.tick();
        if (sim.lock.state === 'locked') lockedAt = k;
      }
      const lockMeasured = lockedAt * TICK; // seconds since the sortie began (the acquisition starts at t = 0)
      expect(lockMeasured).toBeGreaterThanOrEqual(lockSeconds - 1e-9);
      expect(lockMeasured).toBeLessThan(lockSeconds + 1e-9);

      // measured boost: distance in 0.75 s, cost, then regeneration rate and glide speed with nothing held
      sim.reset(lo);
      const z0 = sim.player.pos.z;
      sim.input.qbPressed = true;
      sim.runFor(0.75);
      const dist = z0 - sim.player.pos.z;
      expect(dist).toBeCloseTo(42.6 * mult, 9);
      expect(sim.player.en).toBeCloseTo(maxEn - 36, 9);
      sim.runFor(1);
      const regenMeasured = sim.player.en - (maxEn - 36);
      expect(regenMeasured).toBeCloseTo(regen, 9);
      expect(Math.hypot(sim.player.vel.x, sim.player.vel.z)).toBeCloseTo(22 * mult, 9);
      // walking speed after braking to a halt
      sim.input.brake = true;
      sim.runFor(0.5);
      sim.input.brake = false;
      sim.input.moveZ = 1;
      sim.runFor(0.5);
      const walk = Math.hypot(sim.player.vel.x, sim.player.vel.z);
      expect(walk).toBeCloseTo(10 * mult, 9);
      sim.input.moveZ = 0;
      rows.push(
        `${lo.fcs}/${lo.generator}/${lo.legs}: maxEN ${maxEn}, regen ${regenMeasured.toFixed(4)}/s, lock ${lockMeasured.toFixed(4)} s (spec ${lockSeconds.toFixed(4)}), ` +
          `QB 0.75 s ${dist.toFixed(4)} m, glide ${(22 * mult).toFixed(1)}, walk ${walk.toFixed(2)} m/s, circle ${s.lock.radiusCssPx.toFixed(0)} px`,
      );
    }
    console.log(`[integration] 18 loadouts, measured in the simulation:\n  ${rows.join('\n  ')}`);
    // SPEC §6 example
    sim.reset({ fcs: 'medium', generator: 'balanced', legs: 'quadruped' });
    const ex = buildSnapshot(sim, 'playing').effectiveStats;
    expect([ex.maxEn, ex.regenPerSecond, ex.horizontalSpeedMultiplier]).toEqual([120, 11.25, 0.8]);
    expect(ex.lockSeconds).toBeCloseTo(0.5333, 4);
  });
});

// ───────────────────────────── §11 rows that need no screen ─────────────────────────────

describe('SPEC §11 checklist on the integrated simulation', () => {
  it('single press: one boost, 36 EN, no repeat while the edge is not given again; a held "Q" level does not exist for the sim', () => {
    const sim = new Sim(makeTestStage());
    sim.input.qbPressed = true;
    const evs: Stamped[] = [];
    let minEn = 120;
    run(sim, ticksOf(5), undefined, () => {
      drainInto(sim, evs);
      if (sim.player.en < minEn) minEn = sim.player.en;
    });
    expect(sim.player.qbSuccessfulCount).toBe(1);
    expect(ofType(evs, 'qb').length).toBe(1);
    expect(minEn).toBe(84);
    expect(sim.input.qbPressed).toBe(false); // the edge was consumed by the first update
  });

  it('press and let go of everything: impulse, inertia and automatic glide go on; glide costs nothing and does not block regeneration', () => {
    const sim = new Sim(makeTestStage());
    sim.input.moveZ = 1;
    sim.input.qbPressed = true;
    sim.tick();
    releaseAll(sim); // Q, W — everything is released after 1/120 s
    const speed = (): number => Math.hypot(sim.player.vel.x, sim.player.vel.z);
    const z0 = sim.player.pos.z + 80 * TICK;
    run(sim, ticksOf(0.15) - 2); // t = 0.15 s − 1 tick
    expect(speed()).toBeCloseTo(80, 9);
    expect(buildSnapshot(sim, 'playing').player.movement.horizontalMode).toBe('quickboost');
    run(sim, 1); // t = 0.15 s: the impulse is over, the velocity is inherited as it is
    expect(buildSnapshot(sim, 'playing').player.movement).toMatchObject({ horizontalMode: 'glide', glideEnabled: true, qbImpulseRemainingSeconds: 0 });
    expect(speed()).toBeCloseTo(80, 9);
    expect(z0 - sim.player.pos.z).toBeCloseTo(12, 9);
    run(sim, ticksOf(0.3));
    expect(speed()).toBeCloseTo(80 - (58 / 0.6) * 0.3, 9); // half-way down the 0.60 s ramp: 51 m/s
    run(sim, ticksOf(0.3));
    expect(speed()).toBeCloseTo(22, 9);
    expect(z0 - sim.player.pos.z).toBeCloseTo(42.6, 9);
    expect(sim.player.en).toBe(84); // 0.75 s after the press: regeneration starts now …
    run(sim, ticksOf(2));
    expect(speed()).toBeCloseTo(22, 9); // … while the glide simply continues with no key held
    expect(sim.player.en).toBeCloseTo(84 + 15 * 2, 9);
    expect(z0 - sim.player.pos.z).toBeCloseTo(42.6 + 22 * 2, 9);
    expect(sim.player.glideEnabled).toBe(true);
  });

  it('EN boundary: 35 → no boost; 36 → one boost down to exactly 0, inertia and glide continue at 0 EN', () => {
    const sim = new Sim(makeTestStage());
    sim.player.en = 35; // harness
    sim.player.lastEnSpentAt = 0;
    sim.input.qbPressed = true;
    sim.tick();
    expect(sim.player.qbSuccessfulCount).toBe(0);
    expect(sim.player.en).toBe(35);
    expect(sim.player.qbLastStartedAt).toBeNull();

    sim.reset();
    sim.player.en = 36; // harness
    sim.player.lastEnSpentAt = 0;
    sim.input.qbPressed = true;
    sim.tick();
    expect(sim.player.qbSuccessfulCount).toBe(1);
    expect(sim.player.en).toBe(0);
    const z0 = sim.player.pos.z + 80 * TICK;
    run(sim, ticksOf(0.75) - 1);
    expect(sim.player.en).toBe(0); // nothing came back yet
    expect(z0 - sim.player.pos.z).toBeCloseTo(42.6, 9);
    expect(Math.hypot(sim.player.vel.x, sim.player.vel.z)).toBeCloseTo(22, 9);
    // glide can also be switched on and steered at 0 EN (air: no regeneration, so the tank stays empty)
    sim.reset();
    sim.input.jump = true;
    sim.input.jumpPressed = true;
    sim.tick();
    sim.input.jump = false;
    sim.player.en = 0; // harness
    sim.player.lastEnSpentAt = sim.time;
    sim.input.glideTogglePressed = true;
    run(sim, ticksOf(0.6));
    expect(sim.player.grounded).toBe(false);
    expect(sim.player.glideEnabled).toBe(true);
    expect(sim.player.en).toBe(0);
    expect(Math.hypot(sim.player.vel.x, sim.player.vel.z)).toBeGreaterThan(15); // towards the 16 m/s air speed
  });
});

// ───────────────────────────── soak ─────────────────────────────

function soakStage(): StageDef {
  const enemies: EnemyDef[] = [];
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * 2 * Math.PI;
    enemies.push(makeGuard(`G${pad2(i + 1)}`, Math.round(Math.cos(a) * (40 + (i % 3) * 12)), Math.round(Math.sin(a) * (40 + (i % 3) * 12))));
  }
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * 2 * Math.PI + 0.3;
    enemies.push(makeTurret(`T${pad2(i + 1)}`, Math.round(Math.cos(a) * 85), Math.round(Math.sin(a) * 85)));
  }
  const solids: SolidDef[] = [
    { min: v3(-22, 0, -30), max: v3(-12, 6, -28), material: 'concrete' },
    { min: v3(10, 0, -24), max: v3(18, 5, -22), material: 'container' },
    { min: v3(-3, 0, 12), max: v3(3, 3, 14), material: 'machine' },
    { min: v3(-40, 8, -20), max: v3(-20, 9, 0), material: 'catwalk' },
    { min: v3(30, 0, 30), max: v3(34, 10, 50), material: 'wall' },
    { min: v3(-60, 0, 40), max: v3(-30, 4, 44), material: 'pipe' },
  ];
  return makeTestStage({ floorSize: 260, enemies, solids });
}

/** Random pilot: everything a player can do, re-rolled every 6 ticks; tracks a living enemy most of the time. */
function chaos(sim: Sim, rnd: Rng, k: number, st: { trackId: string | null; trackUntil: number; jumpUntil: number; near?: number }): void {
  const inp = sim.input;
  const weapons: Weapon[] = ['machinegun', 'beam', 'missile'];
  if (k % 6 === 0) {
    const r = rnd.next();
    if (r < 0.18) {
      inp.moveX = rnd.int(3) - 1;
      inp.moveZ = rnd.int(3) - 1;
    } else if (r < 0.24) inp.qbPressed = true;
    else if (r < 0.27) inp.glideTogglePressed = true;
    else if (r < 0.29) {
      if (!inp.jump) {
        inp.jump = true;
        inp.jumpPressed = true;
        st.jumpUntil = k + 6 + rnd.int(rnd.next() < 0.7 ? 20 : 240);
      }
    } else if (r < 0.31) inp.brake = !inp.brake;
    else if (r < 0.38) inp.weaponSelect = weapons[rnd.int(3)];
    else if (r < 0.44) inp.fire = rnd.next() < 0.85;
    if (inp.brake && rnd.next() < 0.3) inp.brake = false;
    const pp = sim.player.pos;
    if (st.near === undefined && Math.hypot(pp.x, pp.z) > 80 && rnd.next() < 0.8) {
      // far from the middle of the slab: usually head back (camera-relative keys for a world direction)
      const yaw = sim.player.yaw;
      const fwd = pp.x * Math.sin(yaw) + pp.z * Math.cos(yaw);
      const right = -pp.x * Math.cos(yaw) + pp.z * Math.sin(yaw);
      inp.moveZ = Math.abs(fwd) > 5 ? Math.sign(fwd) : 0;
      inp.moveX = Math.abs(right) > 5 ? Math.sign(right) : 0;
      inp.brake = false;
    }
  }
  if (inp.jump && k >= st.jumpUntil) inp.jump = false;
  if (k >= st.trackUntil) {
    const pp = sim.player.pos;
    const near = st.near;
    const alive = sim.enemies.filter((e) => e.alive && (near === undefined || Math.hypot(e.pos.x - pp.x, e.pos.y - pp.y, e.pos.z - pp.z) < near));
    st.trackId = alive.length > 0 && rnd.next() < 0.8 ? alive[rnd.int(alive.length)].id : null;
    st.trackUntil = k + 60 + rnd.int(300);
  }
  const tracked = st.trackId ? sim.enemyById.get(st.trackId) : undefined;
  if (tracked && tracked.alive) lookAt(sim, tracked.pos);
  else sim.applyLook(rnd.range(-0.04, 0.04), rnd.range(-0.015, 0.015));
}

describe('soak: 5 minutes of chaotic play against 10 guards and 5 turrets', () => {
  it('no NaN, no exception, bounded projectiles and events, exact time keeping', () => {
    const sim = new Sim(soakStage(), { seed: 4711 });
    const rnd = new Rng(20260908);
    const st = { trackId: null as string | null, trackUntil: 0, jumpUntil: -1 };
    const total = ticksOf(300);
    // every projectile has a life time, so the number in flight is bounded by the fire rates:
    // guards 10 × 3 per 1.2 s × 2 s, turrets 5 × 2 per 1.6 s × 3 s, machine gun 10/s × 2 s, missiles 1/s × 4 s (+1 each for the boundary)
    const bound = Math.ceil(10 * (3 / 1.2) * 2) + Math.ceil(5 * (2 / 1.6) * 3) + (20 + 1) + (4 + 1) + 15;
    const problems: string[] = [];
    const note = (m: string): void => {
      if (problems.length < 20) problems.push(`t=${sim.time.toFixed(3)} (sortie ${sorties}): ${m}`);
    };
    let sorties = 1;
    let sortieStart = 0;
    let maxProjectiles = 0;
    let maxEventsPerFrame = 0;
    let totalEvents = 0;
    let kills = 0;
    let refills = 0;
    let deaths = 0;
    let falls = 0;
    let playerShots = 0;
    let enemyShots = 0;
    let damageTaken = 0;
    let qb = 0;
    let longest = 0;
    let airborneTicks = 0;
    let flyingTicks = 0;
    let glideTicks = 0;
    let regenTicks = 0;
    let lastEn = sim.player.en;
    const started = Date.now();
    for (let k = 0; k < total; k++) {
      chaos(sim, rnd, k - sortieStart, st);
      sim.tick();
      if (sim.projectiles.length > maxProjectiles) maxProjectiles = sim.projectiles.length;
      if (sim.time !== sim.tickIndex * TICK && sim.status === 'playing') note('time is not tickIndex × TICK');
      if (!sim.player.grounded) airborneTicks++;
      if (sim.player.flying) flyingTicks++;
      if (sim.player.horizontalMode === 'glide') glideTicks++;
      if (sim.player.en > lastEn) regenTicks++;
      lastEn = sim.player.en;
      // the renderer drains the events once per 60 fps frame
      if (k % 2 === 1) {
        const evs = sim.drainEvents();
        totalEvents += evs.length;
        if (evs.length > maxEventsPerFrame) maxEventsPerFrame = evs.length;
        for (const e of evs) {
          if (e.type === 'enemy-destroyed') kills++;
          else if (e.type === 'player-shot') playerShots++;
          else if (e.type === 'enemy-shot') enemyShots++;
          else if (e.type === 'player-damaged') damageTaken += e.amount;
          else if (e.type === 'qb') qb++;
        }
      }
      const dirt = snapshotDirt(buildSnapshot(sim, sim.status));
      if (dirt.length) note(`snapshot: ${dirt[0]}`);
      if (k % 60 === 0) {
        const bad = nonFiniteState(sim);
        if (bad.length) note(`state: ${bad.slice(0, 3).join(', ')}`);
        const p = sim.player;
        if (p.en < 0 || p.en > sim.stats.maxEn || p.hp < 0) note(`en ${p.en} hp ${p.hp}`);
        if (sim.shots.length > 32) note(`${sim.shots.length} shot records`);
        for (const q of sim.projectiles) if (!q.alive || sim.time - q.spawnTime > q.lifeSeconds + 1e-9) note(`stale projectile ${q.kind} #${q.id}`);
      }
      // harness: the pilot is patched up and re-armed so that one sortie can last; a fall or an empty
      // battlefield (or 100 s) ends it with a normal re-sortie
      if (sim.status === 'playing' && sim.player.hp < 300) {
        sim.player.hp = 1000;
        refills++;
      }
      if (sim.player.ammo.machinegun === 0) sim.player.ammo.machinegun = 300;
      if (sim.player.ammo.missile === 0) sim.player.ammo.missile = 12;
      const age = k + 1 - sortieStart;
      if (sim.status !== 'playing' || age >= ticksOf(100) || sim.enemies.every((e) => !e.alive)) {
        if (sim.status === 'failed' && sim.failReason === 'fell') falls++;
        else if (sim.status === 'failed') deaths++;
        if (age > longest) longest = age;
        sim.reset(ALL_LOADOUTS[sorties % ALL_LOADOUTS.length]);
        sorties++;
        sortieStart = k + 1;
        st.trackUntil = 0;
        st.jumpUntil = -1;
        lastEn = sim.player.en;
        if (sim.projectiles.length !== 0 || sim.events.length !== 0 || sim.shots.length !== 0) note('re-sortie left something behind');
      }
    }
    const ms = Date.now() - started;
    console.log(
      `[integration] soak: ${total} ticks (300 s) in ${ms} ms (${Math.round((total / ms) * 1000)} ticks/s); sorties ${sorties} (longest ${(longest * TICK).toFixed(1)} s, falls ${falls}, deaths ${deaths}); ` +
        `max projectiles in flight ${maxProjectiles} (bound ${bound}); events ${totalEvents} total, max ${maxEventsPerFrame} per 60 fps frame; ` +
        `player shots ${playerShots}, enemy shots ${enemyShots}, damage taken ${damageTaken} (${refills} harness HP refills), kills ${kills}, boosts ${qb}; ` +
        `ticks airborne ${airborneTicks}, thrusting ${flyingTicks}, gliding ${glideTicks}, regenerating ${regenTicks}`,
    );
    expect(problems).toEqual([]);
    expect(maxProjectiles).toBeLessThanOrEqual(bound);
    expect(maxProjectiles).toBeGreaterThan(10);
    expect(maxEventsPerFrame).toBeLessThan(200);
    expect(sim.events.length).toBeLessThan(200);
    expect(enemyShots).toBeGreaterThan(1000);
    expect(playerShots).toBeGreaterThan(500);
    expect(kills).toBeGreaterThan(10);
    expect(qb).toBeGreaterThan(20);
    expect(longest).toBeGreaterThanOrEqual(ticksOf(30));
  }, 900_000);

  it('a consumer that never drains can not grow the event queue without bound', () => {
    const sim = new Sim(soakStage(), { seed: 1 });
    const rnd = new Rng(3);
    // this pilot never aims at anybody (so the enemies live and keep firing) and is patched up / re-armed by the harness
    const st = { trackId: null as string | null, trackUntil: Number.POSITIVE_INFINITY, jumpUntil: -1 };
    let maxEvents = 0;
    let produced = 0;
    let dropped = 0;
    for (let k = 0; k < ticksOf(150) && sim.status === 'playing'; k++) {
      chaos(sim, rnd, k, st);
      const before = sim.events.length;
      sim.tick();
      if (sim.events.length >= before) produced += sim.events.length - before;
      else dropped++;
      if (sim.events.length > maxEvents) maxEvents = sim.events.length;
      if (sim.player.hp < 300) sim.player.hp = 1000; // harness
      if (sim.player.ammo.machinegun === 0) sim.player.ammo.machinegun = 300; // harness
    }
    console.log(`[integration] undrained event queue after ${sim.time.toFixed(1)} s: peak ${maxEvents} entries, more than ${produced} produced, oldest half dropped ${dropped} times`);
    expect(produced).toBeGreaterThan(4500);
    expect(dropped).toBeGreaterThan(0);
    expect(maxEvents).toBeLessThanOrEqual(4200);
    expect(sim.events.length).toBeGreaterThan(1000); // the newest events are kept
    expect(sim.projectiles.length).toBeLessThan(120);
  }, 900_000);
});

describe('robustness: garbage from outside never reaches the state', () => {
  it('a non-finite viewport size is ignored (the last valid size, the camera aspect and the lock circle stay finite)', () => {
    const sim = new Sim(makeTestStage({ enemies: [makeTarget('X', v3(0, EYE_Y, -50))] }), { viewport: { width: Number.NaN, height: 600 } });
    expect(sim.viewport).toEqual({ width: 1280, height: 600 });
    expect(sim.lock.radiusCssPx).toBeCloseTo(120, 9);
    sim.setViewport(1920, 1080);
    expect(sim.viewport).toEqual({ width: 1920, height: 1080 });
    for (const [w, h] of [[Number.NaN, Number.NaN], [Number.POSITIVE_INFINITY, 500], [800, Number.NEGATIVE_INFINITY], [Number.NaN, 700]] as Array<[number, number]>) {
      sim.setViewport(w, h);
      expect(Number.isFinite(sim.viewport.width) && Number.isFinite(sim.viewport.height)).toBe(true);
      expect(Number.isFinite(sim.camera.aspect)).toBe(true);
      expect(Number.isFinite(sim.lock.radiusCssPx)).toBe(true);
    }
    expect(sim.viewport).toEqual({ width: 800, height: 700 }); // each axis keeps its last finite value
    sim.setViewport(0, -5); // a collapsed layout: clamped to 1 px, never 0 (no division by zero in the aspect)
    expect(sim.viewport).toEqual({ width: 1, height: 1 });
    sim.setViewport(1280, 720);
    run(sim, ticksOf(1), 'X');
    expect(sim.lock.state).toBe('locked'); // and the FCS works as if nothing had happened
    expect(buildSnapshot(sim, 'playing').lock.radiusCssPx).toBeCloseTo(144, 9);
  });

  it('30 s with NaN / ±Infinity / wrong types in every input field, in the look deltas, the viewport and the frame time', () => {
    const garbage: unknown[] = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1e308, -1e308, 5, -3, 0.5, 'x', null, undefined, {}, true];
    const stage = makeTestStage({
      floorSize: 200,
      enemies: [makeGuard('G1', -20, -40), makeGuard('G2', 25, -35), makeTurret('T1', 0, -70), makeTarget('P', v3(5, 6, -30), v3(1, 0, 0), 0.5, 500)],
      solids: [{ min: v3(-5, 0, -20), max: v3(5, 4, -18), material: 'wall' }],
    });
    const sim = new Sim(stage);
    const rnd = new Rng(1);
    const keys = ['moveX', 'moveZ', 'jump', 'brake', 'fire', 'qbPressed', 'glideTogglePressed', 'jumpPressed', 'weaponSelect'];
    const problems: string[] = [];
    let sorties = 1;
    let shots = 0;
    let qb = 0;
    for (let k = 0; k < ticksOf(30); k++) {
      const inp = sim.input as unknown as Record<string, unknown>;
      if (k % 3 === 0) {
        for (const key of keys) {
          if (rnd.next() < 0.25) inp[key] = garbage[rnd.int(garbage.length)];
          else if (rnd.next() < 0.3) inp[key] = key === 'weaponSelect' ? (['machinegun', 'beam', 'missile', null] as unknown[])[rnd.int(4)] : key.startsWith('move') ? rnd.int(3) - 1 : rnd.next() < 0.5;
        }
      }
      const r = rnd.next();
      if (r < 0.05) sim.applyLook(garbage[rnd.int(5)] as number, garbage[rnd.int(5)] as number);
      else sim.applyLook(rnd.range(-0.2, 0.2), rnd.range(-0.1, 0.1));
      if (r > 0.99) sim.setViewport(garbage[rnd.int(8)] as number, garbage[rnd.int(8)] as number);
      else if (r > 0.98) sim.setViewport(1280, 720);
      else if (r > 0.97) sim.advance(garbage[rnd.int(8)] as number);
      const shotsBefore = sim.nextShotId;
      const qbBefore = sim.player.qbSuccessfulCount;
      sim.tick(); // must not throw
      shots += sim.nextShotId - shotsBefore;
      qb += sim.player.qbSuccessfulCount - qbBefore;
      const dirt = snapshotDirt(buildSnapshot(sim, sim.status));
      if (dirt.length && problems.length < 10) problems.push(`t=${sim.time.toFixed(3)} snapshot: ${dirt[0]}`);
      if (k % 10 === 0) {
        const bad = nonFiniteState(sim).filter((x) => !x.startsWith('$.input.')); // the input record itself is the garbage
        if (bad.length && problems.length < 10) problems.push(`t=${sim.time.toFixed(3)} state: ${bad.slice(0, 3).join(', ')}`);
      }
      if (!['machinegun', 'beam', 'missile'].includes(sim.player.weapon) && problems.length < 10) problems.push(`weapon ${String(sim.player.weapon)}`);
      if (sim.status !== 'playing') {
        sim.reset();
        sorties++;
      }
      if (sim.events.length > 1000) sim.drainEvents();
    }
    console.log(`[integration] hostile-input run: ${sorties} sorties, ${shots} player shots, ${qb} boosts, no exception`);
    expect(problems).toEqual([]);
    expect(shots).toBeGreaterThan(10); // the simulation kept reacting to the valid part of the input
    expect(qb).toBeGreaterThan(0);
  });
});

// ───────────────────────────── the shipped stage ─────────────────────────────

describe.skipIf(!factoryStage)('the shipped factory stage in the real Sim', () => {
  const stage = factoryStage as StageDef;

  it('sortie start: 45 enemies, 6 control turrets, sheltered spawn (no damage, no line of sight, for 8 idle seconds)', () => {
    const t0 = Date.now();
    const sim = new Sim(stage);
    const built = Date.now() - t0;
    const s = buildSnapshot(sim, 'playing');
    expect(s.enemies.length).toBe(45);
    expect(s.objective.controlsRequired).toBe(6);
    expect(s.stage.totalEnemies).toBe(45);
    expect(sim.stage.barriers.length).toBe(6);
    expect(sim.player.grounded).toBe(true);
    expect(sim.currentSectorId).not.toBeNull();
    const t1 = Date.now();
    let sawLos = false;
    run(sim, ticksOf(8), undefined, () => {
      if (sim.enemies.some((e) => e.hasLos)) sawLos = true;
    });
    const ran = Date.now() - t1;
    expect(sim.status).toBe('playing');
    expect(sim.player.hp).toBe(1000);
    expect(sawLos).toBe(false);
    expect(sim.enemies.every((e) => e.alive && e.shotsFired === 0)).toBe(true);
    expect(Math.hypot(sim.player.pos.x - stage.playerStart.position.x, sim.player.pos.z - stage.playerStart.position.z)).toBe(0);
    expect(Math.abs(sim.player.pos.y - stage.playerStart.position.y)).toBeLessThan(0.01);
    expect(nonFiniteState(sim)).toEqual([]);
    console.log(`[integration] factory stage: Sim built in ${built} ms (${sim.world.boxes.length} collision boxes, ${sim.nav.getInfo().nodes} nav nodes); 8 idle seconds simulated in ${ran} ms`);
  });

  it('each control turret opens exactly its own barrier; the final gate opens with the sixth; then — and only then — the exit zone clears', () => {
    const sim = new Sim(stage);
    const controls = sim.enemies.filter((e) => e.isGateControl);
    expect(controls.length).toBe(6);
    expect(controls.every((e) => e.kind === 'turret' && e.maxHp === 240)).toBe(true);
    expect(new Set(controls.map((e) => e.sectorId)).size).toBe(6);
    expect(new Set(sim.stage.barriers.map((b) => b.controlEnemyId))).toEqual(new Set(controls.map((e) => e.id)));
    const z = stage.exitZone;
    const exitCentre = v3((z.min.x + z.max.x) / 2, (z.min.y + z.max.y) / 2, (z.min.z + z.max.z) / 2);
    const evs: Stamped[] = [];
    const openNow = (): string[] => sim.stage.barriers.filter((b) => sim.world.isBarrierOpen(b.id)).map((b) => b.id);
    expect(openNow()).toEqual([]);
    expect(sim.world.isBarrierOpen(stage.finalGate.id)).toBe(false);
    const expectedOpen: string[] = [];
    sim.stage.barriers.forEach((b, k) => {
      const e = sim.enemyById.get(b.controlEnemyId)!;
      expect(sim.getObjectiveTarget()).toMatchObject({ kind: 'control', id: e.id });
      sim.damageEnemy(e, 239); // harness: damage without a fight; 239 of 240 HP is not enough
      expect(e.alive).toBe(true);
      expect(openNow()).toEqual(expectedOpen);
      sim.damageEnemy(e, 1);
      expect(e.alive).toBe(false);
      expectedOpen.push(b.id);
      sim.tick();
      drainInto(sim, evs);
      expect(openNow()).toEqual(expectedOpen);
      expect(sim.stage.barriers.filter((q) => sim.nav.isBarrierOpen(q.id)).map((q) => q.id)).toEqual(expectedOpen);
      expect(sim.objective.controlsDestroyed).toBe(k + 1);
      expect(sim.objective.gateOpen).toBe(k === 5);
      expect(sim.world.isBarrierOpen(stage.finalGate.id)).toBe(k === 5);
      expect(sim.status).toBe('playing');
      if (k === 4) {
        // five of six: standing in the exit zone is not a clear
        const keep = { ...sim.player.pos };
        Object.assign(sim.player.pos, exitCentre); // harness
        sim.tick();
        expect(sim.status).toBe('playing');
        Object.assign(sim.player.pos, keep);
        sim.tick();
        drainInto(sim, evs);
      }
    });
    expect(ofType(evs, 'barrier-opened').map((s) => s.e.barrierId)).toEqual(sim.stage.barriers.map((b) => b.id));
    expect(ofType(evs, 'gate-opened').length).toBe(1);
    expect(ofType(evs, 'cleared').length).toBe(0);
    expect(sim.getObjectiveTarget().kind).toBe('exit');
    expect(sim.enemies.filter((e) => e.alive).length).toBe(39); // the other 39 need not be destroyed
    const s = buildSnapshot(sim, 'playing');
    expect(s.objective).toEqual({ controlsDestroyed: 6, controlsRequired: 6, openBarrierIds: sim.stage.barriers.map((b) => b.id), gateOpen: true });
    Object.assign(sim.player.pos, exitCentre); // harness
    sim.tick();
    expect(sim.status).toBe('cleared');

    // re-sortie: all six barriers and the gate are shut again, all 45 enemies are back under the same ids
    const ids = sim.enemies.map((e) => e.id);
    sim.reset();
    expect(openNow()).toEqual([]);
    expect(sim.world.isBarrierOpen(stage.finalGate.id)).toBe(false);
    expect(sim.nav.isBarrierOpen(stage.finalGate.id)).toBe(false);
    expect(sim.enemies.map((e) => e.id)).toEqual(ids);
    expect(sim.enemies.every((e) => e.alive && e.hp === e.maxHp)).toBe(true);
    expect(firstDiff(fingerprint(sim), fingerprint(new Sim(stage)))).toBe('identical');
  });

  it('20 s of chaotic fighting at the hottest spot of the route: deterministic, frame-rate independent, finite; re-sortie restores the start', () => {
    // harness: the pilot is dropped at the route waypoint with the most enemies within 60 m and is patched
    // up when the armour runs low, so that the fight (real AI, real navigation grid) lasts 20 s
    const within60 = (r: { position: V3 }): number =>
      stage.enemies.filter((e) => Math.hypot(e.position.x - r.position.x, e.position.y - r.position.y, e.position.z - r.position.z) < 60).length;
    let drop = stage.route[0];
    for (const r of stage.route) if (within60(r) > within60(drop)) drop = r;
    expect(within60(drop)).toBeGreaterThanOrEqual(3);
    const begin = (sim: Sim): { rnd: Rng; st: { trackId: string | null; trackUntil: number; jumpUntil: number; near: number } } => {
      Object.assign(sim.player.pos, drop.position);
      return { rnd: new Rng(8086), st: { trackId: null, trackUntil: 0, jumpUntil: -1, near: 115 } };
    };
    const patch = (sim: Sim): void => {
      if (sim.status === 'playing' && sim.player.hp < 300) sim.player.hp = 1000;
    };
    /** One script frame = 2 ticks (60 Hz): the pilot acts on what it sees at the frame start. */
    const play = (sim: Sim, frames: number, perFrame?: () => void): string[] => {
      const { rnd, st } = begin(sim);
      const out: string[] = [];
      for (let f = 0; f < frames && sim.status === 'playing'; f++) {
        chaos(sim, rnd, f * 2, st);
        const boundary = (f + 1) * 2;
        while (sim.tickIndex < boundary && sim.status === 'playing') sim.advance((boundary - sim.tickIndex) * TICK - sim.accumulator);
        patch(sim);
        out.push(JSON.stringify(buildSnapshot(sim, sim.status)));
        if (perFrame) perFrame();
      }
      return out;
    };
    const frames = 20 * 60;
    const sim = new Sim(stage);
    const pristine = fingerprint(sim);
    const problems: string[] = [];
    let maxProjectiles = 0;
    const t0 = Date.now();
    const a = play(sim, frames, () => {
      if (sim.projectiles.length > maxProjectiles) maxProjectiles = sim.projectiles.length;
      if (sim.tickIndex % 120 === 0) {
        const bad = nonFiniteState(sim);
        if (bad.length && problems.length < 10) problems.push(`t=${sim.time.toFixed(2)}: ${bad.slice(0, 3).join(', ')}`);
      }
      const dirt = snapshotDirt(buildSnapshot(sim, sim.status));
      if (dirt.length && problems.length < 10) problems.push(`t=${sim.time.toFixed(2)}: ${dirt[0]}`);
    });
    const ms = Date.now() - t0;
    expect(problems).toEqual([]);
    expect(nonFiniteState(sim)).toEqual([]);
    const endA = fingerprint(sim, false);
    const last = JSON.parse(a[a.length - 1]) as Snapshot;
    const enemyShots = last.enemies.reduce((n, e) => n + e.shotsFired, 0);
    console.log(
      `[integration] factory fight from (${drop.position.x}, ${drop.position.y}, ${drop.position.z}) in ${drop.sectorId} (${within60(drop)} enemies within 60 m): ${a.length} frames (${last.elapsedSeconds.toFixed(2)} s) in ${ms} ms; status ${sim.status}, sector ${last.stage.currentSectorId}, ` +
        `visited ${last.stage.visitedSectorIds.join('>')}, QB ${last.player.movement.qbSuccessfulCount}, enemy shots ${enemyShots}, alert enemies ${last.enemies.filter((e) => e.alert).length}, ` +
        `destroyed ${last.enemies.filter((e) => !e.alive).map((e) => e.id).join(',') || 'none'}, max projectiles ${maxProjectiles}, last shot id ${sim.nextShotId - 1}`,
    );
    expect(enemyShots).toBeGreaterThan(10); // it really was a fight
    expect(sim.nextShotId).toBeGreaterThan(10);
    sim.reset();
    expect(firstDiff(fingerprint(sim), pristine)).toBe('identical');
    const b = play(sim, frames);
    expect(firstMismatch(a, b)).toBeNull();
    expect(fingerprint(sim, false)).toBe(endA);
    // the same play with every tick fed separately (120 fps) on a fresh simulation
    const fresh = new Sim(stage);
    const { rnd, st } = begin(fresh);
    const c: string[] = [];
    for (let f = 0; f < frames && fresh.status === 'playing'; f++) {
      chaos(fresh, rnd, f * 2, st);
      fresh.advance(TICK);
      fresh.advance(TICK);
      patch(fresh);
      c.push(JSON.stringify(buildSnapshot(fresh, fresh.status)));
    }
    expect(firstMismatch(a, c)).toBeNull();
  }, 900_000);
});
