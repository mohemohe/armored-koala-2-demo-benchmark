/**
 * SPEC §4.6 (end), §4.1, §4.2, §6, §9, §11 "移動しながらの射撃" on the REAL Game (src/sim/game.ts tick loop).
 * Firing while the player glides, flies, quick-boosts (impulse) and coasts after a QB, with the FCS lock completed by the
 * normal FCS processing, the real fire solution, the real projectile / beam / missile update and the real swept hit test.
 *
 * Two-phase method (no test-side aiming, trajectory or hit code exists in this file):
 *   1) DRY RUN: the very same input sequence is run on a Game WITHOUT a target. The trace records, for every tick, the player
 *      state, the actual muzzle position and the camera. From it we read the muzzle m at the shot tick F.
 *   2) MAIN RUN: a scripted radius-0.5 target is placed so that at the shot tick F it is at p = m + r with velocity v
 *      (SPEC §4.6 A05: r = (0,0,100), v = (+-8,0,0); missile A05/A06/A07). Then the identical inputs are replayed, the FCS
 *      completes the lock by itself while the player moves, and the shot is fired at tick F. The main run must reproduce the
 *      dry run bit for bit (player, camera): the shot / lock / correction never steer the player or the camera (SPEC §4.2).
 * The camera yaw / pitch are chosen (fixed for the whole run) so the target stays inside the FCS circle; this only decides
 * whether the lock is possible, it does not touch the aim of the shot.
 *
 * Independent oracles used here (they CHECK the game, they never feed it): the yaw-frame muzzle offset, the SPEC §4.3
 * equations (direction, residual, smallest root scan), the SPEC §4.4 quadratic, the analytic parabola m + v0 a + g a^2 / 2,
 * the contact geometry of the hit (bullet/missile centre exactly radius-sum away from the MOVING target centre) and, for
 * the lock, a small independent state machine (valid -> acquiring -> locked after the lock time, invalid -> none).
 *
 * Sections: 1 machinegun (20 single shots per condition, A05 / A06) - 1b all 18 loadouts - 2a beam - 2b missile -
 * 3a weapon switch in the shot tick - 3b continuous fire - 3c/3d lock expiry, no_solution - 4 EN priority QB -> beam -> flight -
 * 5 no steering of camera / player, muzzle = yaw + position only - 6 spawn-tick consistency - 7 render-rate independence
 * (Game.advance 1/30, 1/60, 1/144 s) - 8 seeded random input plans.
 * The per-condition report table (shots / hits / residuals) is printed once at the end: run with `--reporter=verbose`.
 *
 * Known finding recorded here (not a physics error): Game.look() updates the camera but does not refresh state.fc, so when the
 * mouse moves between the last tick and a shot the HUD solution lags the (always recomputed) shot by that look step
 * (measured <= 6e-5 rad). Conditions that contain mouse movement therefore allow that bounded lag for the HUD comparison only.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { FCS, GRAVITY, PLAYER, SIM, TEST_TARGET_RADIUS, WEAPONS } from '../src/config';
import type { WeaponId } from '../src/config';
import { solveMachinegun } from '../src/sim/ballistics';
import { freeFireDirection, playerMuzzlePosition, updateCamera } from '../src/sim/camera';
import { Game } from '../src/sim/game';
import { projectToScreen } from '../src/sim/project';
import { earliestLockedFireTick, makeScriptedTarget } from '../src/sim/scenario';
import { computeEffectiveStats, lockRadiusCssPx } from '../src/sim/stats';
import { buildTestArenaStage } from '../src/sim/testArena';
import type { BoxDef, CameraState, EnemyState, FireControlState, GameEvent, Loadout, ShotRecord, V3 } from '../src/sim/types';

// ---------------------------------------------------------------------------
// independent helpers
// ---------------------------------------------------------------------------
const v3 = (x: number, y: number, z: number): V3 => ({ x, y, z });
const add = (a: V3, b: V3): V3 => v3(a.x + b.x, a.y + b.y, a.z + b.z);
const sub = (a: V3, b: V3): V3 => v3(a.x - b.x, a.y - b.y, a.z - b.z);
const mul = (a: V3, k: number): V3 => v3(a.x * k, a.y * k, a.z * k);
const addS = (a: V3, b: V3, k: number): V3 => v3(a.x + b.x * k, a.y + b.y * k, a.z + b.z * k);
const dot = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const len = (a: V3): number => Math.sqrt(dot(a, a));
const unit = (a: V3): V3 => mul(a, 1 / len(a));
const cp = (a: V3): V3 => v3(a.x, a.y, a.z);
const angleBetween = (a: V3, b: V3): number => Math.acos(Math.max(-1, Math.min(1, dot(a, b) / (len(a) * len(b)))));
const hlen = (a: V3): number => Math.hypot(a.x, a.z);
const range = <T>(n: number, f: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => f(i));
const box = (id: string, min: V3, max: V3): BoxDef => ({ id, min, max, mat: 'metal', sectorId: 'T00' });

const DT = SIM.DT;
const S = WEAPONS.machinegun.muzzleSpeed; // 100 m/s
const G = GRAVITY; // 18 m/s^2
const TGT = 'TGT';
const TARGET_HP = 1e6; // makeScriptedTarget
/** yaw = pi -> the camera looks along +Z, so a target at m + (0,0,100) is straight ahead */
const YAW0 = Math.PI;

const BIPED: Loadout = { fcs: 'medium', generator: 'balanced', legs: 'biped' };
const WIDE: Loadout = { ...BIPED, fcs: 'wide' };
const QUAD: Loadout = { ...BIPED, legs: 'quadruped' };
const QUAD_WIDE: Loadout = { ...QUAD, fcs: 'wide' };
const NARROW: Loadout = { ...BIPED, fcs: 'narrow' };
/** 180 EN so that flight + QB + repeated beam shots never run the tank empty inside one run */
const WIDE_CAP: Loadout = { fcs: 'wide', generator: 'capacity', legs: 'biped' };
const earliest = (lo: Loadout): number => earliestLockedFireTick(computeEffectiveStats(lo).lockSeconds);

/** SPEC §4.6 A05 / A06 / A07 (relative position r is the same for all three) */
const R_A05 = v3(0, 0, 100);
const VEL = { A05: v3(8, 0, 0), A06: v3(-8, 0, 0), A07: v3(0, 0, 8) } as const;
type VelKey = keyof typeof VEL;

/** independent muzzle: yaw-frame offset (right, up, forward) with the math.ts yaw convention. Pitch never enters. */
function muzzleOf(pos: V3, yaw: number): V3 {
  const o = PLAYER.MUZZLE_OFFSET;
  return v3(
    pos.x + Math.cos(yaw) * o.right - Math.sin(yaw) * o.forward,
    pos.y + o.up,
    pos.z - Math.sin(yaw) * o.right - Math.cos(yaw) * o.forward,
  );
}

/** SPEC §4.3 residual: |m + v0 t + g t^2/2 - (p + v t)| */
function mgResidual(m: V3, v0: V3, p: V3, v: V3, t: number): number {
  const bullet = v3(m.x + v0.x * t, m.y + v0.y * t - 0.5 * G * t * t, m.z + v0.z * t);
  return len(sub(bullet, addS(p, v, t)));
}
/** SPEC §4.3: w(t) = r + v t - g t^2 / 2 (g = (0,-G,0)) */
function mgW(r: V3, v: V3, t: number): V3 {
  return v3(r.x + v.x * t, r.y + v.y * t + 0.5 * G * t * t, r.z + v.z * t);
}
/** no root of |w(t)|^2 - s^2 t^2 exists in (0, tSol): the solution is the SMALLEST positive one (grid scan) */
function noEarlierRoot(r: V3, v: V3, tSol: number): boolean {
  const N = 2000;
  for (let i = 1; i < N; i++) {
    const t = (tSol * i) / N;
    const w = mgW(r, v, t);
    if (dot(w, w) - S * S * t * t <= 0) return false;
  }
  return true;
}
/** SPEC §4.4: smallest positive root of (v.v - 45^2) t^2 + 2 (r.v) t + r.r = 0 */
function missileIntercept(r: V3, v: V3): number {
  const a = dot(v, v) - 45 * 45;
  const b = 2 * dot(r, v);
  const c = dot(r, r);
  if (Math.abs(a) < 1e-12) return -c / b;
  const disc = b * b - 4 * a * c;
  const roots = [(-b - Math.sqrt(disc)) / (2 * a), (-b + Math.sqrt(disc)) / (2 * a)].filter((x) => x > 0);
  return Math.min(...roots);
}

// ---------------------------------------------------------------------------
// rig: Game on the obstacle-free arena, scripted inputs, per-tick samples
// ---------------------------------------------------------------------------
type KeyName = 'forward' | 'back' | 'left' | 'right' | 'jump' | 'shift' | 'ctrl' | 'qb';
type Levels = Partial<Record<KeyName, boolean>>;
interface KeyEvent {
  tick: number;
  set: Levels;
}
const K = (tick: number, set: Levels): KeyEvent => ({ tick, set });

function levelsAt(events: KeyEvent[], tick: number): Record<KeyName, boolean> {
  const l: Record<KeyName, boolean> = { forward: false, back: false, left: false, right: false, jump: false, shift: false, ctrl: false, qb: false };
  for (const e of events) if (e.tick <= tick) Object.assign(l, e.set);
  return l;
}

interface LookEvent {
  tick: number;
  dx: number;
  dy: number;
}
interface Script {
  keys: KeyEvent[];
  /** trigger level as a function of the tick index */
  fire?: (tick: number) => boolean;
  select?: { tick: number; weapon: WeaponId }[];
  /** mouse movement (CSS px) applied through Game.look() before the tick */
  look?: LookEvent[];
}

interface RigOptions {
  loadout: Loadout;
  yaw: number;
  pitch: number;
  weapon?: WeaponId;
  boxes?: BoxDef[];
  /** initial EN (a fixture set at sortie); default: the generator's maximum */
  en?: number;
}

/** playing Game on the flat arena, player at (0, 1.5, 0) standing on the floor with the given camera angles */
function makeGame(o: RigOptions): Game {
  const stage = buildTestArenaStage({ start: { pos: { x: 0, y: PLAYER.HALF.y, z: 0 }, yaw: o.yaw } });
  stage.boxes.push(...(o.boxes ?? []));
  const g = new Game({ stage, loadout: o.loadout });
  g.sortie(o.loadout);
  g.state.player.yaw = o.yaw;
  g.state.player.pitch = o.pitch;
  g.state.player.weapon = o.weapon ?? 'machinegun';
  if (o.en !== undefined) g.state.player.en = o.en;
  updateCamera(g.state, g.world);
  return g;
}

function applyInputs(g: Game, sc: Script, tick: number): void {
  Object.assign(g.input, levelsAt(sc.keys, tick));
  g.input.fire = sc.fire ? sc.fire(tick) : false;
  for (const s of sc.select ?? []) if (s.tick === tick) g.input.weaponSelect = s.weapon;
  for (const l of sc.look ?? []) if (l.tick === tick) g.look(l.dx, l.dy);
}

const copyCam = (c: CameraState): CameraState => ({ ...c, pos: cp(c.pos), forward: cp(c.forward), right: cp(c.right), up: cp(c.up) });

/** the state at the START of tick `tick` (state.tick === tick), after that tick's inputs were applied */
interface Sample {
  tick: number;
  pos: V3;
  vel: V3;
  yaw: number;
  pitch: number;
  muzzle: V3;
  cam: CameraState;
  en: number;
  grounded: boolean;
  hMode: string;
}
function sample(g: Game): Sample {
  const p = g.state.player;
  return {
    tick: g.state.tick,
    pos: cp(p.pos),
    vel: cp(p.vel),
    yaw: p.yaw,
    pitch: p.pitch,
    muzzle: playerMuzzlePosition(p),
    cam: copyCam(g.state.camera),
    en: p.en,
    grounded: p.grounded,
    hMode: p.mv.horizontalMode,
  };
}
/** kinematic equality of two samples (player + camera), exact */
function kinEqual(a: Sample, b: Sample): boolean {
  const same = (x: V3, y: V3): boolean => x.x === y.x && x.y === y.y && x.z === y.z;
  return (
    same(a.pos, b.pos) && same(a.vel, b.vel) && a.yaw === b.yaw && a.pitch === b.pitch && same(a.cam.pos, b.cam.pos) && same(a.cam.forward, b.cam.forward)
  );
}
/** index of the first tick where the two traces differ (-1: identical over the common length) */
function firstMismatch(a: Sample[], b: Sample[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (!kinEqual(a[i], b[i])) return i;
  return -1;
}

function stepOnce(g: Game, sc: Script, trace?: Sample[], beforeStep?: () => void): void {
  applyInputs(g, sc, g.state.tick);
  trace?.push(sample(g));
  beforeStep?.();
  g.step();
}

/** dry run: same inputs, no target, no fire. Sample k = state at the start of tick k (k = 0..n). */
function dryTrace(o: RigOptions, keys: KeyEvent[], n: number, look?: LookEvent[]): Sample[] {
  const g = makeGame(o);
  const sc: Script = { keys, look };
  const tr: Sample[] = [];
  for (let k = 0; k < n; k++) stepOnce(g, sc, tr);
  applyInputs(g, sc, g.state.tick);
  tr.push(sample(g));
  return tr;
}

// ---------------------------------------------------------------------------
// condition = (input sequence, loadout, target r / v, camera angles, dry trace)
// ---------------------------------------------------------------------------
interface Condition {
  id: string;
  loadout: Loadout;
  en?: number;
  boxes?: BoxDef[];
  keys: KeyEvent[];
  look?: LookEvent[];
  r: V3;
  v: V3;
  yaw: number;
  pitch: number;
  dry: Sample[];
  /** smallest FCS-circle margin [px] over the lock window of every shot tick (>= 0 means always inside) */
  minMarginPx: number;
  /** largest muzzle-target distance over the lock window */
  maxRange: number;
}

/** the rig options that reproduce a condition's dry run */
const rigOf = (c: Condition, weapon?: WeaponId): RigOptions => ({ loadout: c.loadout, yaw: c.yaw, pitch: c.pitch, weapon, en: c.en, boxes: c.boxes });

interface CondSpec {
  id: string;
  loadout?: Loadout;
  en?: number;
  boxes?: BoxDef[];
  keys: KeyEvent[];
  look?: LookEvent[];
  Fs: number[];
  r?: V3;
  v: V3;
  /** the target must stay a lock candidate up to this tick (default: the last shot tick) */
  until?: number;
}

const wrapNear = (a: number, ref: number): number => a - 2 * Math.PI * Math.round((a - ref) / (2 * Math.PI));

/** target center at tick k when it is at pF at tick F (constant velocity) */
const targetAt = (pF: V3, v: V3, k: number, F: number): V3 => addS(pF, v, (k - F) * DT);

function makeCondition(s: CondSpec): Condition {
  const loadout = s.loadout ?? BIPED;
  const r = s.r ?? R_A05;
  const Fmax = Math.max(...s.Fs);
  const Fmin = Math.min(...s.Fs);
  const until = s.until ?? Fmax;
  const Fmid = Math.round((Fmin + Fmax) / 2);
  // choose fixed camera angles that keep the target inside the FCS circle for the whole lock window (fixed-point iteration:
  // the trajectory depends on yaw because WASD is relative to it)
  let yaw = YAW0;
  let pitch = 0;
  for (let it = 0; it < 30; it++) {
    const dry = dryTrace({ loadout, yaw, pitch, en: s.en, boxes: s.boxes }, s.keys, until + 1, s.look);
    const pF = add(dry[Fmid].muzzle, r);
    let yMin = Infinity;
    let yMax = -Infinity;
    let pMin = Infinity;
    let pMax = -Infinity;
    for (let k = 1; k <= until; k++) {
      const d = sub(targetAt(pF, s.v, k, Fmid), dry[k].cam.pos);
      // the camera angles drift with the mouse (`look`): measure the target direction relative to the drift so that the START
      // angles are chosen to keep the target centered over the whole window
      const ya = wrapNear(Math.atan2(-d.x, -d.z), yaw) - (wrapNear(dry[k].yaw, yaw) - yaw);
      const pa = Math.asin(d.y / len(d)) - (dry[k].pitch - pitch);
      yMin = Math.min(yMin, ya);
      yMax = Math.max(yMax, ya);
      pMin = Math.min(pMin, pa);
      pMax = Math.max(pMax, pa);
    }
    const ny = (yMin + yMax) / 2;
    const np = (pMin + pMax) / 2;
    const done = Math.abs(ny - yaw) < 1e-10 && Math.abs(np - pitch) < 1e-10;
    yaw = ny;
    pitch = np;
    if (done) break;
  }
  const dry = dryTrace({ loadout, yaw, pitch, en: s.en, boxes: s.boxes }, s.keys, Fmax + 520, s.look);
  // feasibility diagnostics: the target must be a lock candidate (range and circle) at every sample tick 1..until
  const radius = lockRadiusCssPx(loadout, 1280, 720);
  let minMargin = Infinity;
  let maxRange = 0;
  for (const F of s.Fs) {
    const pF = add(dry[F].muzzle, r);
    // ticks 1..F (the lock window of this shot); a burst asks for a longer window through `until`
    for (let k = 1; k <= (s.until !== undefined ? Math.max(F, s.until) : F); k++) {
      const p = targetAt(pF, s.v, k, F);
      const sp = projectToScreen(dry[k].cam, p);
      minMargin = Math.min(minMargin, sp.inFront ? radius - Math.hypot(sp.x, sp.y) : -1e9);
      maxRange = Math.max(maxRange, len(sub(p, dry[k].muzzle)));
    }
  }
  if (!(minMargin >= 0) || !(maxRange <= FCS.RANGE)) {
    throw new Error(`${s.id}: target cannot stay a lock candidate (circle margin ${minMargin.toFixed(1)} px, max range ${maxRange.toFixed(2)} m)`);
  }
  return { id: s.id, loadout, en: s.en, boxes: s.boxes, keys: s.keys, look: s.look, r, v: s.v, yaw, pitch, dry, minMarginPx: minMargin, maxRange };
}

// ---------------------------------------------------------------------------
// one shot on the real Game
// ---------------------------------------------------------------------------
interface Pre {
  tick: number;
  time: number;
  pos: V3;
  vel: V3;
  yaw: number;
  pitch: number;
  muzzle: V3;
  muzzleIndep: V3;
  target: V3;
  targetVel: V3;
  en: number;
  qbCount: number;
  lock: { state: string; targetId: string | null; elapsed: number; progress: number };
  fc: FireControlState;
  camForward: V3;
  ammo: { machinegun: number; missile: number };
  nextFireAt: Record<WeaponId, number>;
  weapon: WeaponId;
}
function snapshotPre(g: Game, tgt: EnemyState): Pre {
  const s = g.state;
  const p = s.player;
  return {
    tick: s.tick,
    time: s.time,
    pos: cp(p.pos),
    vel: cp(p.vel),
    yaw: p.yaw,
    pitch: p.pitch,
    muzzle: playerMuzzlePosition(p),
    muzzleIndep: muzzleOf(p.pos, p.yaw),
    target: cp(tgt.pos),
    targetVel: cp(tgt.vel),
    en: p.en,
    qbCount: p.mv.qbSuccessCount,
    lock: { state: s.lock.state, targetId: s.lock.targetId, elapsed: s.lock.elapsed, progress: s.lock.progress },
    fc: JSON.parse(JSON.stringify(s.fc)) as FireControlState,
    camForward: cp(s.camera.forward),
    ammo: { ...p.ammo },
    nextFireAt: { ...p.nextFireAt },
    weapon: p.weapon,
  };
}

interface LockEntry {
  tick: number;
  state: string;
  targetId: string | null;
  progress: number;
}
const lockOf = (g: Game): LockEntry => ({ tick: g.state.tick, state: g.state.lock.state, targetId: g.state.lock.targetId, progress: g.state.lock.progress });

interface ShotRun {
  c: Condition;
  F: number;
  weapon: WeaponId;
  g: Game;
  sc: Script;
  tgt: EnemyState;
  pre: Pre;
  post: Sample;
  postLock: LockEntry;
  postElapsed: number;
  rec: ShotRecord;
  trace: Sample[];
  lockLog: LockEntry[];
}

/**
 * MAIN RUN up to and including the shot tick F. `weapon` is the weapon that fires; `initialWeapon` (if different) is selected at
 * sortie and the switch to `weapon` is requested in the same tick as the trigger (weapon switch -> first shot).
 */
function runShot(c: Condition, F: number, weapon: WeaponId, opts: { initialWeapon?: WeaponId } = {}): ShotRun {
  const initial = opts.initialWeapon ?? weapon;
  const g = makeGame(rigOf(c, initial));
  const pF = add(c.dry[F].muzzle, c.r);
  g.state.enemies.push(makeScriptedTarget(TGT, targetAt(pF, c.v, 0, F), c.v));
  const tgt = g.state.enemies[0];
  const sc: Script = { keys: c.keys, look: c.look, fire: (t) => t === F, select: initial !== weapon ? [{ tick: F, weapon }] : [] };
  const trace: Sample[] = [];
  const lockLog: LockEntry[] = [];
  while (g.state.tick < F) {
    lockLog.push(lockOf(g));
    stepOnce(g, sc, trace);
  }
  lockLog.push(lockOf(g));
  const holder: { pre: Pre | null } = { pre: null };
  stepOnce(g, sc, trace, () => {
    holder.pre = snapshotPre(g, tgt);
  });
  const shots = g.state.shots;
  expect(shots.length, `${c.id} F=${F}: exactly one shot record`).toBe(1);
  return {
    c,
    F,
    weapon,
    g,
    sc,
    tgt,
    pre: holder.pre!,
    post: sample(g),
    postLock: lockOf(g),
    postElapsed: g.state.lock.elapsed,
    rec: shots[0],
    trace,
    lockLog,
  };
}

function lockViolations(log: LockEntry[], E: number): string[] {
  const out: string[] = [];
  let prev = 0;
  for (const e of log) {
    if (e.tick === 0) continue;
    if (e.targetId !== TGT) out.push(`tick ${e.tick}: target ${String(e.targetId)}`);
    else if (e.tick < E) {
      if (e.state !== 'acquiring') out.push(`tick ${e.tick}: state ${e.state} (expected acquiring)`);
      if (e.progress < prev) out.push(`tick ${e.tick}: progress fell`);
      prev = e.progress;
    } else if (e.state !== 'locked' || e.progress !== 1) out.push(`tick ${e.tick}: ${e.state} ${e.progress} (expected locked 1)`);
  }
  return out;
}

const eventsOf = <T extends GameEvent['type']>(g: Game, type: T): Extract<GameEvent, { type: T }>[] =>
  g.state.events.filter((e): e is Extract<GameEvent, { type: T }> => e.type === type);

interface Metrics {
  hit: boolean;
  /** independent residual [m] (machinegun) or the missile / beam equivalent (miss distance of the aim) */
  residual: number;
  fcResidual: number;
  speedErr: number;
  pathDev: number;
  muzzleErr: number;
  /** angle between the HUD solution (state.fc at the start of the shot tick) and the shot direction [rad] (machinegun only) */
  hudDirDiff?: number;
}

/** what every weapon must satisfy at the shot tick, whatever the player is doing */
function checkCommon(run: ShotRun, minSpeed: number): number {
  const { c, F, pre, rec, weapon } = run;
  const tag = `${c.id} F=${F} ${weapon}`;
  const E = earliest(c.loadout);
  // (two-phase) the state at the shot tick is exactly the SPEC r / v
  const mF = c.dry[F].muzzle;
  expect(len(sub(pre.muzzle, mF)), `${tag}: muzzle equals the dry-run muzzle`).toBe(0);
  expect(len(sub(rec.muzzlePosition, mF)), `${tag}: record muzzle is the dry-run muzzle`).toBe(0);
  const muzzleErr = len(sub(rec.muzzlePosition, pre.muzzleIndep));
  expect(muzzleErr, `${tag}: muzzle = center + yaw-frame offset only (independent formula)`).toBeLessThan(1e-12);
  expect(len(sub(pre.target, add(mF, c.r))), `${tag}: p = m + r at the shot tick`).toBeLessThan(1e-9);
  expect(len(sub(pre.targetVel, c.v)), `${tag}: v at the shot tick`).toBeLessThan(1e-12);
  expect(rec.firedAtSeconds, tag).toBe(pre.time);
  expect(rec.firedAtSeconds, tag).toBe(F * DT);
  expect(rec.weapon, tag).toBe(weapon);
  // the lock was completed by the normal FCS while moving and is complete at the shot tick
  expect(lockViolations(run.lockLog, E), `${tag}: lock history`).toEqual([]);
  expect(pre.lock.state, tag).toBe('locked');
  expect(pre.lock.targetId, tag).toBe(TGT);
  expect(pre.lock.elapsed, tag).toBeGreaterThanOrEqual(computeEffectiveStats(c.loadout).lockSeconds - 1e-9);
  expect(rec.targetId, tag).toBe(TGT);
  expect(len(sub(rec.targetPositionAtFire as V3, pre.target)), `${tag}: record target position`).toBe(0);
  expect(len(sub(rec.targetVelocityAtFire as V3, pre.targetVel)), `${tag}: record target velocity`).toBe(0);
  // the player really moves (before or right after the shot tick: QB starts inside the shot tick for d = 0)
  const speed = Math.max(len(pre.vel), len(run.post.vel));
  expect(speed, `${tag}: the player is moving`).toBeGreaterThanOrEqual(minSpeed);
  // the shot did not touch the player or the camera: the dry run (no target, no fire) is reproduced exactly
  expect(firstMismatch(run.trace, c.dry), `${tag}: player/camera trace equals the dry run`).toBe(-1);
  expect(run.post.yaw, tag).toBe(pre.yaw);
  expect(run.post.pitch, tag).toBe(pre.pitch);
  expect(len(sub(run.post.cam.forward, cp(pre.camForward))), `${tag}: camera did not turn`).toBe(0);
  // the muzzle in the record is the LATEST muzzle (start of the shot tick): it differs from the previous and the next tick
  if (F > 0 && len(c.dry[F - 1].vel) > 5) {
    expect(len(sub(rec.muzzlePosition, c.dry[F - 1].muzzle)), `${tag}: not the previous tick's muzzle`).toBeGreaterThan(0.005);
  }
  if (len(run.post.vel) > 5) expect(len(sub(rec.muzzlePosition, run.post.muzzle)), `${tag}: not the next tick's muzzle`).toBeGreaterThan(0.005);
  // the lock survived the tick and the weapon switch did not reset its progress (SPEC §5)
  expect(run.postLock.state, tag).toBe('locked');
  expect(run.postElapsed, `${tag}: progress continues (no reset)`).toBeCloseTo(pre.lock.elapsed + DT, 9);
  return muzzleErr;
}

// ---------------------------------------------------------------------------
// machinegun
// ---------------------------------------------------------------------------
interface MgFlight {
  hpLoss: number;
  enemyHitEvents: number;
  hitAge: number | null;
  pathDev: number;
  bulletsLeft: number;
  first: { age: number; pos: V3; prevPos: V3; origin: V3; v0: V3 };
  bulletV0: V3;
}

function flyMg(run: ShotRun): MgFlight {
  const { g, sc, tgt } = run;
  const b = g.state.bullets[0];
  expect(g.state.bullets.length, 'one bullet was spawned').toBe(1);
  const first = { age: b.age, pos: cp(b.pos), prevPos: cp(b.prevPos), origin: cp(b.origin), v0: cp(b.v0) };
  let pathDev = 0;
  const dev = (): number => {
    const a = b.age;
    const exp = v3(b.origin.x + b.v0.x * a, b.origin.y + b.v0.y * a - 0.5 * G * a * a, b.origin.z + b.v0.z * a);
    return len(sub(b.pos, exp));
  };
  pathDev = Math.max(pathDev, dev());
  let guard = 0;
  while (g.state.bullets.length > 0 && guard++ < 400) {
    stepOnce(g, sc, run.trace);
    if (b.alive) pathDev = Math.max(pathDev, dev());
  }
  run.trace.push(sample(g));
  const hpLoss = TARGET_HP - tgt.hp;
  return {
    hpLoss,
    enemyHitEvents: g.state.events.filter((e) => e.type === 'hit' && e.on === 'enemy').length,
    hitAge: hpLoss > 0 ? b.age : null,
    pathDev,
    bulletsLeft: g.state.bullets.length,
    first,
    bulletV0: cp(b.v0),
  };
}

function verifyMg(run: ShotRun, minSpeed: number): Metrics {
  const { c, F, pre, rec, g } = run;
  const tag = `${c.id} F=${F} mg`;
  const muzzleErr = checkCommon(run, minSpeed);
  const fl = flyMg(run);
  const m = rec.muzzlePosition;
  const p = rec.targetPositionAtFire as V3;
  const v = rec.targetVelocityAtFire as V3;
  const t = rec.predictedFlightSeconds as number;
  const v0 = rec.initialVelocity as V3;
  expect(rec.solutionStatus, tag).toBe('solved');
  expect(v0, `${tag}: initialVelocity present`).not.toBeNull();
  // SPEC §4.3: |v0| = 100 (+-0.001), the projectile meets the predicted target within 0.01 m
  const speedErr = Math.abs(len(v0) - S);
  expect(speedErr, `${tag}: |v0|`).toBeLessThanOrEqual(0.001);
  const residual = mgResidual(m, v0, p, v, t);
  expect(residual, `${tag}: residual`).toBeLessThanOrEqual(FCS.MAX_RESIDUAL_M);
  // the direction is the SPEC formula d = (r + v t - g t^2 / 2) / (s t) with the ACTUAL muzzle and the target's world velocity:
  // nothing of the player's velocity is added to v0 or subtracted from v
  const r = sub(p, m);
  const dExp = mul(mgW(r, v, t), 1 / (S * t));
  expect(len(sub(v0, mul(dExp, S))), `${tag}: v0 = s d (SPEC direction, no player velocity)`).toBeLessThan(1e-9);
  expect(len(sub(rec.launchDirection, dExp)), `${tag}: launchDirection`).toBeLessThan(1e-9);
  expect(noEarlierRoot(r, v, t), `${tag}: t is the smallest positive root`).toBe(true);
  // the solver called on the record's own inputs reproduces the record (the shot used the actual fire solution)
  const ref = solveMachinegun(m, p, v)!;
  expect(len(sub(ref.velocity, v0)), `${tag}: solveMachinegun agrees`).toBeLessThan(1e-12);
  // HUD == shot (no separate diagnostic computation); the HUD solution had been evaluated at the same instant
  let hudDirDiff = 0;
  if (pre.fc.weapon === 'machinegun') {
    expect(pre.fc.status, tag).toBe('solved');
    // Exact equality, also with the MOUSE moving inside the frame: Game.look() refreshes state.fc (refreshFireSolution) right after
    // updateCamera, so the HUD solution is never staler than the shot (which always recomputes from the newest state). This used to be
    // a documented lag (tolDir 2e-4 rad / tolPos 0.02 m when c.look) until look() refreshed the solution.
    const tolDir = 1e-12;
    const tolPos = 1e-12;
    hudDirDiff = angleBetween(pre.fc.launchDirection as V3, rec.launchDirection);
    expect(hudDirDiff, `${tag}: HUD direction == shot direction`).toBeLessThanOrEqual(tolDir);
    expect(len(sub(pre.fc.muzzlePosition as V3, m)), `${tag}: HUD muzzle == shot muzzle`).toBeLessThanOrEqual(tolPos);
    expect(pre.fc.evaluatedAtSeconds as number, tag).toBeCloseTo(rec.firedAtSeconds, 12);
    expect(pre.fc.residualMeters as number, tag).toBeLessThanOrEqual(FCS.MAX_RESIDUAL_M);
    expect((pre.fc.aimPoint as V3).y, `${tag}: aim point above the intercept (gravity)`).toBeGreaterThan((pre.fc.predictedInterceptPosition as V3).y);
  }
  // the launch direction is not the camera direction (the correction is real and the camera did not follow it)
  expect(angleBetween(rec.launchDirection, pre.camForward), `${tag}: correction differs from the camera axis`).toBeGreaterThan(0.005);
  expect(rec.accelerationAtFire, tag).toEqual({ x: 0, y: -18, z: 0 });
  // world-frame projectile: exactly the analytic parabola, spawn = the latest muzzle, one tick of flight in the spawn tick
  expect(fl.bulletV0, `${tag}: bullet v0 == record`).toEqual(v0);
  expect(len(sub(fl.first.origin, m)), `${tag}: bullet origin == muzzle`).toBe(0);
  expect(len(sub(fl.first.prevPos, m)), `${tag}: prevPos == muzzle`).toBe(0);
  expect(fl.first.age, `${tag}: spawn-tick age is exactly dt`).toBe(DT);
  const first = v3(m.x + v0.x * DT, m.y + v0.y * DT - 0.5 * G * DT * DT, m.z + v0.z * DT);
  expect(len(sub(fl.first.pos, first)), `${tag}: first position = m + v0 a + g a^2/2, a = dt`).toBeLessThan(1e-12);
  expect(fl.pathDev, `${tag}: analytic path`).toBeLessThan(1e-9);
  // the real hit: one enemy hit, exactly 12 damage, the bullet is gone
  expect(fl.hpLoss, `${tag}: damage`).toBe(WEAPONS.machinegun.damage);
  expect(fl.enemyHitEvents, `${tag}: one hit event`).toBe(1);
  expect(fl.bulletsLeft, tag).toBe(0);
  expect(g.state.player.ammo.machinegun, tag).toBe(pre.ammo.machinegun - 1);
  expect(fl.hitAge as number, `${tag}: contact happens before the center arrival`).toBeLessThanOrEqual(t + 1e-9);
  expect(fl.hitAge as number, tag).toBeGreaterThan(t - 0.1);
  // independent contact geometry: at the contact time the bullet centre is exactly (bullet radius + target radius) from the MOVING
  // target centre p + v a (a = bullet age), i.e. a genuine swept contact with the target at that moment (not a fixed end position)
  const hitEv = eventsOf(g, 'hit').find((e) => e.on === 'enemy')!;
  const contactDist = len(sub(hitEv.pos, addS(p, v, fl.hitAge as number)));
  expect(contactDist, `${tag}: contact distance`).toBeCloseTo(WEAPONS.machinegun.bulletRadius + TEST_TARGET_RADIUS, 3);
  expect(firstMismatch(run.trace, c.dry), `${tag}: player/camera trace equals the dry run over the whole flight`).toBe(-1);
  return { hit: fl.hpLoss > 0, residual, fcResidual: pre.fc.residualMeters ?? NaN, speedErr, pathDev: fl.pathDev, muzzleErr, hudDirDiff };
}

// ---------------------------------------------------------------------------
// beam
// ---------------------------------------------------------------------------
function verifyBeam(run: ShotRun, minSpeed: number): Metrics {
  const { c, F, pre, rec, g, tgt } = run;
  const tag = `${c.id} F=${F} beam`;
  const muzzleErr = checkCommon(run, minSpeed);
  const m = rec.muzzlePosition;
  const p = pre.target; // current position at the shot instant
  const ev = eventsOf(g, 'beamFire');
  expect(ev.length, `${tag}: one beam`).toBe(1);
  const bf = ev[0];
  expect(len(sub(bf.origin, m)), `${tag}: beam origin = latest muzzle`).toBe(0);
  expect(bf.hit, tag).toBe('enemy');
  expect(bf.targetId, tag).toBe(TGT);
  // the ray toward the CURRENT centre enters the sphere on the near side: the hit point is 0.5 m short of the centre
  expect(len(sub(bf.end, p)), `${tag}: hit point at radius from the current centre`).toBeCloseTo(TEST_TARGET_RADIUS, 6);
  const dExp = unit(sub(p, m));
  expect(len(sub(rec.launchDirection, dExp)), `${tag}: direction = normalize(p - m)`).toBeLessThan(1e-12);
  expect(rec.solutionStatus, tag).toBe('solved');
  expect(rec.predictedFlightSeconds, tag).toBe(0);
  expect(rec.initialVelocity, tag).toBeNull();
  expect(rec.accelerationAtFire, tag).toEqual({ x: 0, y: 0, z: 0 });
  expect(len(sub(rec.predictedInterceptPosition as V3, p)), `${tag}: predicted point = current position`).toBeLessThan(1e-9);
  expect(TARGET_HP - tgt.hp, `${tag}: 40 damage exactly once`).toBe(WEAPONS.beam.damage);
  expect(g.state.bullets.length, tag).toBe(0);
  // EN: 8 for the beam (+36 when the QB starts in the same tick, + 20 dt of flight when thrust ran): nothing paid twice
  const mv = g.state.player.mv;
  const expectEn = pre.en - WEAPONS.beam.enCost - PLAYER.QB.COST * (mv.qbSuccessCount - pre.qbCount) - (mv.thrusting ? PLAYER.FLIGHT_EN_PER_SEC * DT : 0);
  expect(g.state.player.en, `${tag}: EN`).toBeCloseTo(expectEn, 9);
  expect(g.state.player.nextFireAt.beam, tag).toBeCloseTo(F * DT + WEAPONS.beam.interval, 12);
  // the machinegun-corrected direction would be a different one (the beam must not reuse it)
  const mg = solveMachinegun(m, p, pre.targetVel);
  if (mg) expect(angleBetween(mg.direction, rec.launchDirection), `${tag}: differs from the MG correction`).toBeGreaterThan(1e-4);
  return { hit: TARGET_HP - tgt.hp === WEAPONS.beam.damage, residual: 0, fcResidual: 0, speedErr: 0, pathDev: 0, muzzleErr };
}

// ---------------------------------------------------------------------------
// missile
// ---------------------------------------------------------------------------
const MAX_TURN = (WEAPONS.missile.turnRateDeg * Math.PI) / 180 * DT; // 1 degree per tick

function verifyMissile(run: ShotRun, minSpeed: number): Metrics {
  const { c, F, pre, rec, g, tgt, sc } = run;
  const tag = `${c.id} F=${F} missile`;
  const muzzleErr = checkCommon(run, minSpeed);
  const m = rec.muzzlePosition;
  const p = pre.target;
  const v = pre.targetVel;
  const r = sub(p, m);
  const tExp = missileIntercept(r, v);
  const dExp = unit(add(r, mul(v, tExp)));
  expect(g.state.missiles.length, `${tag}: one missile`).toBe(1);
  const ms = g.state.missiles[0];
  expect(ms.targetId, tag).toBe(TGT);
  expect(g.state.player.ammo.missile, tag).toBe(pre.ammo.missile - 1);
  // SPEC §4.4: initial direction normalize(r + v t), speed 45 in the WORLD frame, no player velocity
  expect(rec.solutionStatus, tag).toBe('solved');
  expect(len(sub(rec.launchDirection, dExp)), `${tag}: direction`).toBeLessThan(1e-9);
  expect(rec.predictedFlightSeconds as number, tag).toBeCloseTo(tExp, 9);
  const v0 = rec.initialVelocity as V3;
  expect(len(v0), `${tag}: |v0| = 45`).toBeCloseTo(45, 9);
  expect(len(sub(v0, mul(dExp, 45))), `${tag}: v0 = 45 * direction`).toBeLessThan(1e-9);
  expect(rec.accelerationAtFire, tag).toEqual({ x: 0, y: 0, z: 0 });
  // spawn tick: age exactly dt, the missile advanced exactly one tick from the latest muzzle
  expect(ms.age, `${tag}: spawn-tick age`).toBe(DT);
  expect(len(sub(ms.prevPos, m)), tag).toBe(0);
  expect(len(sub(ms.pos, addS(m, ms.vel, DT))), `${tag}: first position = m + vel dt`).toBeLessThan(1e-12);
  let prevDir = unit(v0);
  let maxTurn = angleBetween(prevDir, unit(ms.vel));
  let maxSpeedErr = Math.abs(len(ms.vel) - 45);
  prevDir = unit(ms.vel);
  let guard = 0;
  while (ms.alive && guard++ < 700) {
    stepOnce(g, sc, run.trace);
    const dirNow = unit(ms.vel);
    maxTurn = Math.max(maxTurn, angleBetween(prevDir, dirNow));
    maxSpeedErr = Math.max(maxSpeedErr, Math.abs(len(ms.vel) - 45));
    prevDir = dirNow;
  }
  run.trace.push(sample(g));
  expect(maxTurn, `${tag}: turn <= 120 deg/s`).toBeLessThanOrEqual(MAX_TURN + 1e-9);
  expect(maxSpeedErr, `${tag}: speed 45`).toBeLessThan(1e-9);
  expect(TARGET_HP - tgt.hp, `${tag}: 180 damage exactly once`).toBe(WEAPONS.missile.damage);
  expect(ms.age, `${tag}: contact before the center arrival`).toBeLessThanOrEqual(tExp + 1e-6);
  expect(ms.age, tag).toBeGreaterThan(tExp - 0.1);
  expect(g.state.player.nextFireAt.missile, tag).toBeCloseTo(F * DT + WEAPONS.missile.interval, 12);
  const hitEv = eventsOf(g, 'hit').find((e) => e.on === 'enemy' && e.weapon === 'missile')!;
  expect(len(sub(hitEv.pos, addS(p, v, ms.age))), `${tag}: contact distance`).toBeCloseTo(WEAPONS.missile.radius + TEST_TARGET_RADIUS, 6);
  expect(firstMismatch(run.trace, c.dry), `${tag}: player/camera trace equals the dry run over the whole flight`).toBe(-1);
  return { hit: TARGET_HP - tgt.hp === WEAPONS.missile.damage, residual: len(sub(rec.launchDirection, dExp)), fcResidual: NaN, speedErr: maxSpeedErr, pathDev: maxTurn, muzzleErr };
}

function verify(run: ShotRun, minSpeed: number): Metrics {
  if (run.weapon === 'machinegun') return verifyMg(run, minSpeed);
  if (run.weapon === 'beam') return verifyBeam(run, minSpeed);
  return verifyMissile(run, minSpeed);
}

// ---------------------------------------------------------------------------
// input sequences (all key events are rising/falling levels on a tick)
// ---------------------------------------------------------------------------
const glideSideTap = (): KeyEvent[] => [K(20, { shift: true, right: true }), K(21, { shift: false, right: false })]; // then NO input
const glideBackHeld = (): KeyEvent[] => [K(20, { shift: true, back: true }), K(21, { shift: false })]; // S stays held
const flightHold = (): KeyEvent[] => [K(40, { jump: true })];
const qbSide = (q: number): KeyEvent[] => [K(q, { qb: true, right: true }), K(q + 1, { qb: false, right: false })]; // tap, all keys released
const qbBack = (q: number): KeyEvent[] => [K(q, { qb: true, back: true }), K(q + 1, { qb: false, back: false })];
const qbForward = (q: number): KeyEvent[] => [K(q, { qb: true, forward: true }), K(q + 1, { qb: false, forward: false })];

interface Def {
  id: string;
  loadout: Loadout;
  en?: number;
  boxes?: BoxDef[];
  keys: KeyEvent[];
  /** mouse movement during the run (Game.look) */
  look?: LookEvent[];
  Fs: number[];
  minSpeed: number;
  /** what the player is doing at the shot ticks, for the report */
  note: string;
  /** confirms from the dry-run trace that the scenario really contains the situation named in `note` */
  sanity?: (c: Condition) => void;
}
const eB = earliest(BIPED); // 97
const eW = earliest(WIDE); // 145
const eQ = earliest(QUAD); // 65
const DEFS: Def[] = [
  { id: 'glide-side', loadout: BIPED, keys: glideSideTap(), Fs: range(20, (i) => eB + i), minSpeed: 20, note: 'ground glide 22 m/s sideways, all keys released after the tap' },
  { id: 'glide-back', loadout: BIPED, keys: glideBackHeld(), Fs: range(20, (i) => eB + i), minSpeed: 20, note: 'ground glide 22 m/s away from the target, S held' },
  { id: 'glide-accel', loadout: BIPED, keys: [K(eB + 8, { shift: true, right: true }), K(eB + 9, { shift: false, right: false })], Fs: range(20, (i) => eB + 10 + i), minSpeed: 0.5, note: 'glide accelerating (0.8..16 m/s) after the lock is complete' },
  { id: 'glide-forward', loadout: BIPED, keys: [K(20, { shift: true, forward: true }), K(21, { shift: false })], Fs: range(20, (i) => eB + i), minSpeed: 20, note: 'ground glide 22 m/s toward the target, W held' },
  { id: 'walk-side', loadout: BIPED, keys: [K(20, { right: true })], Fs: range(20, (i) => eB + i), minSpeed: 9, note: 'normal walk 10 m/s sideways (no glide)' },
  { id: 'walk-forward', loadout: BIPED, keys: [K(20, { forward: true })], Fs: range(20, (i) => eB + i), minSpeed: 9, note: 'normal walk 10 m/s toward the target' },
  { id: 'brake', loadout: BIPED, keys: [...glideSideTap(), K(eB + 4, { ctrl: true }), K(eB + 60, { ctrl: false })], Fs: range(20, (i) => eB + 5 + i), minSpeed: 1, note: 'left Ctrl brake: glide 22 m/s decelerating at 120 m/s^2 (walk mode)' },
  { id: 'jump-falling', loadout: BIPED, keys: [K(80, { jump: true }), K(90, { jump: false })], Fs: range(20, (i) => 194 + i), minSpeed: 7, note: 'short Space press: ballistic jump, shots while falling (vy about -8..-10 m/s), F = 194..213 (landing at about tick 213)' },
  { id: 'glide-back-narrow', loadout: NARROW, keys: glideBackHeld(), Fs: range(20, (i) => earliest(NARROW) + i), minSpeed: 15, note: 'narrow FCS (0.10 D circle, 0.40 s lock), ground glide away from the target' },
  { id: 'flight-up-narrow', loadout: NARROW, keys: [K(20, { jump: true })], Fs: range(20, (i) => earliest(NARROW) + 30 + i), minSpeed: 7, note: 'narrow FCS, Space held from tick 20: flight rising 8 m/s' },
  {
    id: 'glide-en0',
    loadout: BIPED,
    en: 0,
    keys: [K(0, { jump: true }), K(1, { jump: false }), ...glideSideTap()],
    Fs: range(20, (i) => eB + i),
    minSpeed: 15,
    note: 'EN 0 the whole time (airborne, so no regeneration): air glide 16 m/s costs nothing, machinegun / missile still work',
    sanity: (c) => {
      for (const F of [eB, eB + 19]) {
        expect(c.dry[F].en).toBe(0);
        expect(c.dry[F].grounded).toBe(false);
        expect(hlen(c.dry[F].vel)).toBeCloseTo(16, 6);
      }
    },
  },
  {
    id: 'qb-inertia-air-en0',
    loadout: BIPED,
    en: 28.5, // + 60 ticks of ground regeneration (0.125/tick) = exactly 36 EN when the jump starts at tick 60
    keys: [K(60, { jump: true }), K(70, { jump: false }), ...qbBack(eB)],
    Fs: range(20, (i) => eB + 18 + 3 * i),
    minSpeed: 15,
    note: 'airborne QB paid with EN 36 -> EN 0: the inertia (80 -> 16 m/s) + auto glide continue and all shots are fired at EN 0, F = q+18..q+75',
    sanity: (c) => {
      expect(c.dry[eB].en).toBe(PLAYER.QB.COST);
      for (const F of [eB + 18, eB + 75]) {
        expect(c.dry[F].en).toBe(0);
        expect(c.dry[F].grounded).toBe(false);
        expect(c.dry[F].hMode).toBe('glide');
        expect(hlen(c.dry[F].vel)).toBeGreaterThan(16.5);
      }
    },
  },
  {
    id: 'flight-cutoff',
    loadout: BIPED,
    en: 1, // + 40 ticks of ground regeneration = exactly 6 EN when the jump starts at tick 40: thrust from tick 64, dry at tick 100
    keys: flightHold(),
    Fs: range(20, (i) => eB + i),
    minSpeed: 0.5,
    note: 'EN runs out mid-flight at tick 100: the shots straddle the cut-off (thrust 8 m/s -> gravity, no free ascent)',
    sanity: (c) => {
      expect(c.dry[eB - 1].vel.y).toBe(8); // still thrusting just before the cut-off
      expect(c.dry[eB + 19].en).toBe(0);
      expect(c.dry[eB + 19].vel.y).toBeGreaterThan(5.5);
      expect(c.dry[eB + 19].vel.y).toBeLessThan(6.5); // gravity took over: 8 - 18 * 16 / 120
    },
  },
  { id: 'jump-landing', loadout: BIPED, keys: [K(80, { jump: true }), K(90, { jump: false })], Fs: range(20, (i) => 206 + i), minSpeed: 0, note: 'short jump: shots at F = 206..225 straddle the landing at about tick 213',
    sanity: (c) => {
      expect(c.dry[206].grounded).toBe(false);
      expect(c.dry[225].grounded).toBe(true);
      expect(c.dry[225].vel.y).toBeCloseTo(0, 6);
    } },
  {
    id: 'wall-slide',
    loadout: BIPED,
    boxes: [box('side-wall', v3(6, 0, -5), v3(9, 30, 20))], // short: neither the lock lines nor the bullets pass through it
    keys: [K(20, { shift: true, left: true, forward: true }), K(21, { shift: false })],
    Fs: range(20, (i) => eB + i),
    minSpeed: 10,
    note: 'glide diagonally (left + forward) into a wall on the player\'s left and slide along it (into-wall velocity removed)',
    sanity: (c) => {
      for (const F of [eB, eB + 19]) {
        expect(c.dry[F].pos.x, 'pressed against the wall (x = 6 - 0.8)').toBeCloseTo(6 - PLAYER.HALF.x, 3);
        expect(Math.abs(c.dry[F].vel.x), 'into-wall velocity removed').toBeLessThan(1e-6);
        expect(c.dry[F].vel.z, 'sliding along the wall').toBeGreaterThan(14);
      }
    },
  },
  {
    id: 'glide-side-mouse',
    loadout: BIPED,
    keys: glideSideTap(),
    look: range(140, (i) => ({ tick: 25 + i, dx: 1, dy: 0 })),
    Fs: range(20, (i) => eB + i),
    minSpeed: 20,
    note: 'ground glide sideways while the MOUSE keeps turning the view (0.126 deg per tick, also in the shot tick): the glide direction stays, the muzzle follows yaw',
    sanity: (c) => {
      // the saved glide direction is NOT turned by the view (SPEC 7.1): the world velocity direction is constant while yaw changes
      const a = c.dry[eB + 19];
      const b = c.dry[eB];
      expect(Math.abs(a.yaw - b.yaw), 'the view really turned').toBeGreaterThan(0.04);
      expect(Math.abs(Math.atan2(a.vel.z, a.vel.x) - Math.atan2(b.vel.z, b.vel.x)), 'world glide direction kept').toBeLessThan(1e-9);
    },
  },
  {
    id: 'qb-impulse-side-mouse',
    loadout: BIPED,
    keys: qbSide(eB),
    look: range(60, (i) => ({ tick: eB - 20 + i, dx: -2, dy: 1 })),
    Fs: range(20, (i) => eB + i),
    minSpeed: 79,
    note: 'QB impulse sideways while the mouse swings the view (yaw and pitch) every tick, including the shot tick',
    sanity: (c) => {
      expect(Math.abs(c.dry[eB + 19].yaw - c.dry[eB].yaw)).toBeGreaterThan(0.07);
      expect(Math.abs(c.dry[eB + 19].pitch - c.dry[eB].pitch)).toBeGreaterThan(0.03);
    },
  },
  { id: 'glide-side-quad', loadout: QUAD, keys: glideSideTap(), Fs: range(20, (i) => eQ + i), minSpeed: 17, note: '4 legs, ground glide 17.6 m/s sideways' },
  { id: 'flight-up', loadout: BIPED, keys: flightHold(), Fs: range(20, (i) => eB + i), minSpeed: 7, note: 'Space held: flight, rising 8 m/s' },
  { id: 'flight-start', loadout: BIPED, keys: [K(eB - 19, { jump: true })], Fs: range(20, (i) => eB + i), minSpeed: 4, note: 'Space pressed 19 ticks before the first shot tick: jump, then the 0.20 s hold turns into flight at tick 102 (shots straddle the switch)' },
  { id: 'flight-glide-side', loadout: BIPED, keys: [...glideSideTap(), ...flightHold()], Fs: range(20, (i) => eB + i), minSpeed: 15, note: 'flight + air glide 16 m/s sideways' },
  { id: 'qb-impulse-side', loadout: BIPED, keys: qbSide(eB), Fs: range(20, (i) => eB + i), minSpeed: 79, note: 'QB sideways: d=0..17 impulse (80 m/s), d=18,19 first inertia ticks' },
  { id: 'qb-impulse-back', loadout: BIPED, keys: qbBack(eB), Fs: range(20, (i) => eB + i), minSpeed: 79, note: 'QB away from the target: d=0..17 impulse, d=18,19 first inertia ticks' },
  { id: 'qb-impulse-flight', loadout: BIPED, keys: [...flightHold(), ...qbSide(eB)], Fs: range(20, (i) => eB + i), minSpeed: 79, note: 'QB sideways while flying: d=0..17 impulse, d=18,19 inertia' },
  { id: 'qb-impulse-side-quad', loadout: QUAD, keys: qbSide(eQ), Fs: range(20, (i) => eQ + i), minSpeed: 63, note: '4 legs QB sideways (64 m/s): d=0..17 impulse, d=18,19 inertia' },
  { id: 'qb-inertia-side', loadout: WIDE, keys: qbSide(eW), Fs: range(20, (i) => eW + 18 + 3 * i), minSpeed: 15, note: 'coasting after a sideways QB (glide 80 -> 22 m/s), F = q+18..q+75, wide FCS' },
  { id: 'qb-inertia-back', loadout: BIPED, keys: qbBack(eB), Fs: range(20, (i) => eB + 18 + 3 * i), minSpeed: 15, note: 'coasting after a QB away from the target, F = q+18..q+75' },
  { id: 'qb-inertia-side-quad', loadout: QUAD_WIDE, keys: qbSide(earliest(QUAD_WIDE)), Fs: range(20, (i) => earliest(QUAD_WIDE) + 18 + 3 * i), minSpeed: 12, note: '4 legs (wide FCS) coasting after a sideways QB, F = q+18..q+75' },
];
const DEF = (id: string): Def => {
  const d = DEFS.find((x) => x.id === id);
  if (!d) throw new Error(`unknown def ${id}`);
  return d;
};

const condCache = new Map<string, Condition>();
function getCond(def: Def, vk: VelKey): Condition {
  const key = `${def.id}|${vk}`;
  let c = condCache.get(key);
  if (!c) {
    c = makeCondition({ id: `${def.id}/${vk}`, loadout: def.loadout, en: def.en, boxes: def.boxes, keys: def.keys, look: def.look, Fs: def.Fs, v: VEL[vk] });
    condCache.set(key, c);
  }
  return c;
}

// ---------------------------------------------------------------------------
// report table
// ---------------------------------------------------------------------------
const table: string[] = [];
afterAll(() => {
  // eslint-disable-next-line no-console
  console.log(['', 'moving-fire summary (real Game; single shots from a moving player, lock completed by the normal FCS)', ...table].join('\n'));
});

function summarize(label: string, c: Condition, ms: Metrics[]): void {
  const hits = ms.filter((m) => m.hit).length;
  const fin = (f: (m: Metrics) => number): number => Math.max(...ms.map(f).filter((x) => Number.isFinite(x)), 0);
  table.push(
    `${label} ${c.id}: shots=${ms.length} hits=${hits} maxResidual=${fin((m) => m.residual).toExponential(2)} maxResidual(fc)=${fin((m) => m.fcResidual).toExponential(2)} ` +
      `max||v0|-100|=${fin((m) => m.speedErr).toExponential(1)} maxPathDev=${fin((m) => m.pathDev).toExponential(1)} maxMuzzleErr=${fin((m) => m.muzzleErr).toExponential(1)} maxHudDirDiff=${fin((m) => m.hudDirDiff ?? 0).toExponential(1)}rad ` +
      `minCircleMargin=${c.minMarginPx.toFixed(1)}px maxRange=${c.maxRange.toFixed(1)}m yaw=${((c.yaw * 180) / Math.PI).toFixed(2)}deg pitch=${((c.pitch * 180) / Math.PI).toFixed(2)}deg`,
  );
}

// ===========================================================================
// 1. machinegun: 20 single shots, lock complete, while gliding / flying / QB impulse / QB inertia
// ===========================================================================
describe('1. machinegun A05 / A06 from a moving player (20 single shots each, shot tick staggered)', () => {
  for (const def of DEFS) {
    for (const vk of ['A05', 'A06'] as const) {
      it(`${def.id} x ${vk}: 20/20 hit, |v0| = 100, no player velocity in the bullet, residual <= 0.01 m  [${def.note}]`, () => {
        const c = getCond(def, vk);
        def.sanity?.(c);
        const ms = def.Fs.map((F) => verifyMg(runShot(c, F, 'machinegun'), def.minSpeed));
        summarize('MG', c, ms);
        expect(ms.length).toBe(20);
        expect(ms.filter((m) => m.hit).length).toBe(20);
        expect(Math.max(...ms.map((m) => m.residual))).toBeLessThanOrEqual(0.01);
      });
    }
  }
});

// ===========================================================================
// 2. beam (current position) and missile (A05 / A06 / A07 deviation, turn limit) from a moving player
// ===========================================================================
describe('1b. correction accuracy is the same for all 18 loadouts while moving (machinegun A05 / A06, ground glide away from the target, 20 shots each)', () => {
  const loadouts: Loadout[] = [];
  for (const f of ['wide', 'medium', 'narrow'] as const)
    for (const gg of ['capacity', 'balanced', 'recovery'] as const) for (const l of ['biped', 'quadruped'] as const) loadouts.push({ fcs: f, generator: gg, legs: l });
  it('every loadout: 20/20 hits, residual <= 0.01 m, |v0| = 100', () => {
    let shots = 0;
    let hits = 0;
    let maxRes = 0;
    for (const lo of loadouts) {
      const E = earliest(lo);
      for (const vk of ['A05', 'A06'] as const) {
        const c = makeCondition({ id: `${lo.fcs}/${lo.generator}/${lo.legs}/${vk}`, loadout: lo, keys: glideBackHeld(), Fs: range(20, (i) => E + i), v: VEL[vk] });
        for (const F of range(20, (i) => E + i)) {
          const m = verifyMg(runShot(c, F, 'machinegun'), 1);
          shots++;
          if (m.hit) hits++;
          maxRes = Math.max(maxRes, m.residual);
        }
      }
    }
    table.push(`MG 18 loadouts x A05/A06 while gliding away: shots=${shots} hits=${hits} maxResidual=${maxRes.toExponential(2)}`);
    expect(hits).toBe(shots);
    expect(shots).toBe(18 * 2 * 20);
    expect(maxRes).toBeLessThanOrEqual(0.01);
  });
});

describe('2a. beam from a moving player (hits the CURRENT position, 20 shots each)', () => {
  const ids = ['glide-side', 'glide-back', 'glide-forward', 'walk-side', 'brake', 'jump-falling', 'jump-landing', 'wall-slide', 'glide-side-quad', 'flight-up', 'flight-start', 'flight-glide-side', 'qb-impulse-side', 'qb-impulse-flight', 'qb-inertia-side', 'qb-inertia-back'];
  for (const id of ids) {
    for (const vk of ['A05', 'A06'] as const) {
      it(`${id} x ${vk}: 20/20 beam hits, direction = normalize(p - m) from the latest muzzle, 40 damage once, 8 EN once`, () => {
        const def = DEF(id);
        const c = getCond(def, vk);
        const ms = def.Fs.map((F) => verifyBeam(runShot(c, F, 'beam'), def.minSpeed));
        summarize('Beam', c, ms);
        expect(ms.filter((m) => m.hit).length).toBe(20);
      });
    }
  }
});

describe('2b. missile from a moving player (A05 / A06 / A07: deviation direction, turn limit 120 deg/s, speed 45, 20 shots each)', () => {
  const ids = ['glide-side', 'glide-back', 'glide-forward', 'walk-side', 'brake', 'jump-falling', 'jump-landing', 'wall-slide', 'flight-up', 'flight-start', 'flight-cutoff', 'glide-en0', 'qb-inertia-air-en0', 'qb-impulse-side', 'qb-inertia-back'];
  for (const id of ids) {
    for (const vk of ['A05', 'A06', 'A07'] as const) {
      // geometry: the A05 target drifts toward the short side wall of 'wall-slide'; the slower missile's intercept path (2.3 s) would
      // graze the wall's far end (a real wall hit, not a miss of the correction), so that one combination is not a valid experiment
      if (id === 'wall-slide' && vk === 'A05') continue;
      it(`${id} x ${vk}: 20/20 missile hits for 180, initial direction normalize(r + v t), world speed 45`, () => {
        const def = DEF(id);
        const c = getCond(def, vk);
        const ms = def.Fs.map((F) => verifyMissile(runShot(c, F, 'missile'), def.minSpeed));
        summarize('Missile', c, ms);
        expect(ms.filter((m) => m.hit).length).toBe(20);
      });
    }
  }
});

// ===========================================================================
// 3. lock persistence / expiry, weapon switch, rapid fire
// ===========================================================================
describe('3a. the first shot right after a weapon switch is corrected (lock and progress are kept)', () => {
  const cases: { id: string; from: WeaponId; to: WeaponId; vk: VelKey }[] = [
    { id: 'glide-side', from: 'beam', to: 'machinegun', vk: 'A05' },
    { id: 'qb-inertia-back', from: 'missile', to: 'machinegun', vk: 'A06' },
    { id: 'qb-impulse-side', from: 'machinegun', to: 'beam', vk: 'A05' },
    { id: 'flight-up', from: 'machinegun', to: 'missile', vk: 'A06' },
    { id: 'glide-back', from: 'beam', to: 'missile', vk: 'A07' },
    { id: 'qb-impulse-back', from: 'missile', to: 'beam', vk: 'A06' },
  ];
  for (const cs of cases) {
    it(`${cs.id} x ${cs.vk}: ${cs.from} -> ${cs.to} in the shot tick: 20/20 corrected hits`, () => {
      const def = DEF(cs.id);
      const c = getCond(def, cs.vk);
      const ms = def.Fs.map((F) => {
        const run = runShot(c, F, cs.to, { initialWeapon: cs.from });
        // the switch happened in this very tick, the other weapon's timer was untouched and the new one is set
        expect(run.pre.weapon, 'the previous weapon was selected before the tick').toBe(cs.from);
        expect(run.g.state.player.weapon).toBe(cs.to);
        expect(run.pre.nextFireAt[cs.from], 'switching does not touch the previous weapon timer').toBe(0);
        return verify(run, def.minSpeed);
      });
      summarize(`Switch ${cs.from}->${cs.to}`, c, ms);
      expect(ms.filter((m) => m.hit).length).toBe(20);
    });
  }
});

describe('3b. continuous fire: every round recomputes the solution from the latest muzzle / target values', () => {
  interface BurstShot {
    pre: Pre;
    rec: ShotRecord;
  }
  function burst(def: Def, vk: VelKey, extraKeys: KeyEvent[], F: number, ticks: number): { shots: BurstShot[]; g: Game; tgt: EnemyState; c: Condition } {
    const keys = [...def.keys, ...extraKeys];
    const c = makeCondition({ id: `${def.id}+burst/${vk}`, loadout: def.loadout, en: def.en, boxes: def.boxes, keys, Fs: [F], v: VEL[vk], until: F + ticks });
    const g = makeGame(rigOf(c));
    const pF = add(c.dry[F].muzzle, c.r);
    g.state.enemies.push(makeScriptedTarget(TGT, targetAt(pF, c.v, 0, F), c.v));
    const tgt = g.state.enemies[0];
    const sc: Script = { keys, fire: (t) => t >= F && t < F + ticks };
    const shots: BurstShot[] = [];
    const trace: Sample[] = [];
    while (g.state.tick < F + ticks + 260) {
      const before = g.state.shots.length;
      const holder: { pre: Pre | null } = { pre: null };
      stepOnce(g, sc, trace, () => {
        holder.pre = snapshotPre(g, tgt);
      });
      if (g.state.shots.length > before) shots.push({ pre: holder.pre!, rec: g.state.shots[g.state.shots.length - 1] });
      if (g.state.tick > F + ticks && g.state.bullets.length === 0) break;
    }
    // the burst never steers the player / camera
    expect(firstMismatch(trace, c.dry)).toBe(-1);
    return { shots, g, tgt, c };
  }

  it('glide sideways, trigger held for 0.6 s: 6 rounds, each with its own m / p / v, all hit, no direction reuse', () => {
    const def = DEF('glide-side');
    for (const vk of ['A05', 'A06'] as const) {
      const F = eB;
      const { shots, g, tgt } = burst(def, vk, [], F, 61);
      expect(shots.length, `${vk}: shots`).toBe(6);
      let maxRes = 0;
      for (const [i, s] of shots.entries()) {
        const tag = `${vk} round ${i}`;
        expect(s.rec.firedAtSeconds, tag).toBe((F + 12 * i) * DT);
        expect(s.pre.lock.state, `${tag}: lock complete`).toBe('locked');
        expect(len(sub(s.rec.muzzlePosition, s.pre.muzzleIndep)), `${tag}: latest muzzle`).toBeLessThan(1e-12);
        expect(len(sub(s.rec.targetPositionAtFire as V3, s.pre.target)), tag).toBe(0);
        expect(len(sub(s.rec.targetVelocityAtFire as V3, s.pre.targetVel)), tag).toBe(0);
        expect(s.rec.solutionStatus, tag).toBe('solved');
        const m = s.rec.muzzlePosition;
        const p = s.rec.targetPositionAtFire as V3;
        const v = s.rec.targetVelocityAtFire as V3;
        const t = s.rec.predictedFlightSeconds as number;
        const v0 = s.rec.initialVelocity as V3;
        const res = mgResidual(m, v0, p, v, t);
        maxRes = Math.max(maxRes, res);
        expect(res, tag).toBeLessThanOrEqual(0.01);
        expect(Math.abs(len(v0) - S), tag).toBeLessThanOrEqual(0.001);
        expect(len(sub(v0, mul(mul(mgW(sub(p, m), v, t), 1 / (S * t)), S))), `${tag}: SPEC direction for THIS round's m/p/v`).toBeLessThan(1e-9);
        if (i > 0) {
          const prev = shots[i - 1].rec;
          expect(len(sub(s.rec.muzzlePosition, prev.muzzlePosition)), `${tag}: muzzle moved (player 22 m/s * 0.1 s)`).toBeGreaterThan(1.5);
          expect(angleBetween(s.rec.launchDirection, prev.launchDirection), `${tag}: solution recomputed (direction changed)`).toBeGreaterThan(1e-4);
          expect(len(sub(s.rec.targetPositionAtFire as V3, prev.targetPositionAtFire as V3)), `${tag}: target moved`).toBeGreaterThan(0.5);
        }
      }
      expect(TARGET_HP - tgt.hp, `${vk}: every round hit once`).toBe(6 * WEAPONS.machinegun.damage);
      expect(g.state.player.ammo.machinegun).toBe(300 - 6);
      expect(g.state.bullets.length).toBe(0);
      table.push(`MG burst glide-side/${vk}: shots=6 hits=6 maxResidual=${maxRes.toExponential(2)}`);
    }
  });

  it('a QB starts in the middle of the burst (trigger held): the rounds before and after the QB are each recomputed and all hit', () => {
    const def: Def = { ...DEF('glide-side'), id: 'glide-then-qb', keys: [...glideSideTap(), ...qbForward(eW + 30)], loadout: WIDE };
    for (const vk of ['A05', 'A06'] as const) {
      const F = eW;
      const { shots, g, tgt } = burst(def, vk, [], F, 61);
      expect(shots.length, `${vk}: shots`).toBe(6);
      let maxRes = 0;
      const speeds: number[] = [];
      for (const [i, s] of shots.entries()) {
        const tag = `${vk} round ${i}`;
        expect(s.pre.lock.state, `${tag}: lock kept through the QB`).toBe('locked');
        const m = s.rec.muzzlePosition;
        const p = s.rec.targetPositionAtFire as V3;
        const v = s.rec.targetVelocityAtFire as V3;
        const t = s.rec.predictedFlightSeconds as number;
        const v0 = s.rec.initialVelocity as V3;
        expect(len(sub(m, s.pre.muzzleIndep)), tag).toBeLessThan(1e-12);
        const res = mgResidual(m, v0, p, v, t);
        maxRes = Math.max(maxRes, res);
        expect(res, tag).toBeLessThanOrEqual(0.01);
        expect(Math.abs(len(v0) - S), tag).toBeLessThanOrEqual(0.001);
        speeds.push(hlen(s.pre.vel));
      }
      expect(Math.max(...speeds), 'the QB speed was really present during the burst').toBeGreaterThan(60);
      expect(TARGET_HP - tgt.hp, `${vk}: every round hit`).toBe(6 * WEAPONS.machinegun.damage);
      expect(g.state.player.mv.qbSuccessCount).toBe(1);
      table.push(`MG burst glide+QB/${vk}: shots=6 hits=6 maxResidual=${maxRes.toExponential(2)} maxPlayerSpeedAtShot=${Math.max(...speeds).toFixed(1)}`);
    }
  });
});

describe('3d. no correction solution while moving: the lock is kept, direct aim from the latest muzzle, the round is still spent, nothing is faked', () => {
  const cases: { id: string; weapon: WeaponId; vz: number }[] = [];
  for (const id of ['glide-side', 'qb-impulse-side', 'flight-up']) {
    cases.push({ id, weapon: 'machinegun', vz: 150 }, { id, weapon: 'missile', vz: 60 });
  }
  for (const cs of cases) {
    it(`${cs.id} / ${cs.weapon}: target recedes at ${cs.vz} m/s from the shot tick (faster than the projectile): no_solution, direct aim, lock kept, no forced hit`, () => {
      const def = DEF(cs.id);
      const c = getCond(def, 'A05');
      const F = def.Fs[6];
      const g = makeGame(rigOf(c, cs.weapon));
      const pF = add(c.dry[F].muzzle, c.r);
      g.state.enemies.push(makeScriptedTarget(TGT, targetAt(pF, c.v, 0, F), c.v));
      const tgt = g.state.enemies[0];
      const sc: Script = { keys: c.keys, fire: (t) => t === F };
      const trace: Sample[] = [];
      while (g.state.tick < F) stepOnce(g, sc, trace);
      expect(g.state.lock.state).toBe('locked');
      const holder: { pre: Pre | null } = { pre: null };
      stepOnce(g, sc, trace, () => {
        tgt.vel = v3(0, 0, cs.vz); // the target's ACTUAL velocity at the shot instant
        holder.pre = snapshotPre(g, tgt);
      });
      const pre = holder.pre!;
      const s = g.state;
      const rec = s.shots[0];
      const speed = cs.weapon === 'machinegun' ? S : WEAPONS.missile.speed;
      const direct = unit(sub(pre.target, pre.muzzleIndep));
      expect(rec.solutionStatus, 'no_solution').toBe('no_solution');
      expect(rec.targetId).toBe(TGT);
      expect(len(sub(rec.muzzlePosition, pre.muzzleIndep)), 'latest muzzle').toBeLessThan(1e-12);
      expect(len(sub(rec.targetVelocityAtFire as V3, v3(0, 0, cs.vz))), 'the actual target velocity was used').toBe(0);
      expect(len(sub(rec.launchDirection, direct)), 'direct aim at the CURRENT position').toBeLessThan(1e-12);
      expect(len(sub(rec.initialVelocity as V3, mul(direct, speed))), `${speed} m/s along the direct direction, nothing added`).toBeLessThan(1e-9);
      expect(rec.predictedFlightSeconds).toBeNull();
      expect(rec.predictedInterceptPosition).toBeNull();
      if (cs.weapon === 'machinegun') expect(s.player.ammo.machinegun, 'the round is spent').toBe(pre.ammo.machinegun - 1);
      else {
        expect(s.player.ammo.missile, 'the missile is spent').toBe(pre.ammo.missile - 1);
        expect(s.missiles.length).toBe(1);
      }
      // lock kept, the HUD says no_solution with the direct aim point and no invented numbers
      expect(s.lock.state).toBe('locked');
      expect(s.lock.targetId).toBe(TGT);
      expect(s.fc.status).toBe('no_solution');
      expect(s.fc.predictedFlightSeconds).toBeNull();
      expect(s.fc.predictedInterceptPosition).toBeNull();
      expect(s.fc.residualMeters).toBeNull();
      expect(len(sub(s.fc.aimPoint as V3, tgt.pos)), 'aim point = current target position').toBeLessThan(1e-12);
      // the projectile is not bent toward the receding target and the target is not hit
      const b = s.bullets[0];
      let dev = 0;
      let guard = 0;
      if (cs.weapon === 'machinegun') {
        while (s.bullets.length > 0 && guard++ < 400) {
          stepOnce(g, sc, trace);
          if (b.alive) {
            const a = b.age;
            dev = Math.max(dev, len(sub(b.pos, v3(b.origin.x + b.v0.x * a, b.origin.y + b.v0.y * a - 0.5 * G * a * a, b.origin.z + b.v0.z * a))));
          }
        }
        expect(dev).toBeLessThan(1e-9);
      } else {
        const ms = s.missiles[0];
        while (ms.alive && guard++ < 700) stepOnce(g, sc, trace);
        expect(ms.age, 'flew its whole life or hit the floor, never the receding target').toBeGreaterThan(0);
      }
      expect(tgt.hp, 'no forced hit').toBe(TARGET_HP);
      expect(firstMismatch(trace, c.dry)).toBe(-1);
    });
  }
});

describe('3c. lock expiry while moving: the lock and its solution are discarded at once, no stale correction', () => {
  // wall beside the flight path: the segments camera->target and muzzle->target are cut while the player glides sideways
  const wall = box('wall', v3(-14, 0, 10), v3(-12, 40, 40));
  const target = v3(0, 2.25, 60);
  const keysGlide = (): KeyEvent[] => [K(30, { shift: true, right: true }), K(31, { shift: false, right: false })];
  const lockSeconds = computeEffectiveStats(BIPED).lockSeconds;

  function rig(weapon: WeaponId, boxes: BoxDef[]): Game {
    const g = makeGame({ loadout: BIPED, yaw: YAW0, pitch: 0, weapon, boxes });
    g.state.enemies.push(makeScriptedTarget(TGT, target, v3(0, 0, 0)));
    return g;
  }
  /** independent validity: line of sight camera->center and muzzle->center, 120 m from the muzzle, projection inside the circle */
  function valid(g: Game): boolean {
    const s = g.state;
    const tgt = s.enemies[0];
    const mz = playerMuzzlePosition(s.player);
    if (g.world.segmentBlocked(s.camera.pos, tgt.pos) || g.world.segmentBlocked(mz, tgt.pos)) return false;
    if (len(sub(tgt.pos, mz)) > FCS.RANGE) return false;
    const sp = projectToScreen(s.camera, tgt.pos);
    return sp.inFront && Math.hypot(sp.x, sp.y) <= lockRadiusCssPx(BIPED, 1280, 720);
  }
  /** independent lock state machine for ONE target: the first valid sample selects it (elapsed 0), each further valid tick adds dt */
  class LockOracle {
    since = -1;
    next(tick: number, ok: boolean): 'none' | 'acquiring' | 'locked' {
      if (!ok) {
        this.since = -1;
        return 'none';
      }
      if (this.since < 0) this.since = tick;
      return (tick - this.since) * DT >= lockSeconds - 1e-9 ? 'locked' : 'acquiring';
    }
  }
  interface ScanLog {
    ticks: number;
    firstDrop: number;
    firstReacquire: number;
    lockedAgain: number;
    mismatches: string[];
  }
  /**
   * step `n` ticks; after every tick the FCS lock (state, target, progress, HUD solution) must equal the independent oracle.
   * `onDrop` runs once in the tick the (previously complete) lock was discarded.
   */
  function scan(g: Game, sc: Script, n: number, onDrop?: (tick: number) => void): ScanLog {
    const oracle = new LockOracle();
    const log: ScanLog = { ticks: 0, firstDrop: -1, firstReacquire: -1, lockedAgain: -1, mismatches: [] };
    let wasLocked = false;
    for (let k = 0; k < n; k++) {
      stepOnce(g, sc);
      log.ticks++;
      const tick = g.state.tick;
      const ok = valid(g);
      const exp = oracle.next(tick, ok);
      const lk = g.state.lock;
      const fc = g.state.fc;
      const bad = (msg: string): void => {
        log.mismatches.push(`tick ${tick}: ${msg}`);
      };
      if (lk.state !== exp) bad(`lock ${lk.state}, expected ${exp} (valid=${String(ok)})`);
      if (exp === 'none') {
        if (lk.targetId !== null || lk.progress !== 0 || lk.elapsed !== 0) bad('discarded lock keeps target/progress');
        if (fc.status !== 'inactive' || fc.launchDirection !== null || fc.targetId !== null) bad('discarded lock keeps a solution');
      } else {
        if (lk.targetId !== TGT) bad(`target ${String(lk.targetId)}`);
        const p = Math.min(1, ((tick - oracle.since) * DT) / lockSeconds);
        if (Math.abs(lk.progress - p) > 1e-9) bad(`progress ${lk.progress} expected ${p}`);
        if (exp === 'locked' && fc.status !== 'solved') bad(`fc ${fc.status} while locked`);
        if (exp === 'acquiring' && fc.status !== 'inactive') bad(`fc ${fc.status} before the lock is complete`);
      }
      if (wasLocked && exp === 'none') {
        if (log.firstDrop < 0) {
          log.firstDrop = tick;
          onDrop?.(tick);
        }
      }
      if (log.firstDrop >= 0 && log.firstReacquire < 0 && exp !== 'none') log.firstReacquire = tick;
      if (log.firstReacquire >= 0 && log.lockedAgain < 0 && exp === 'locked') log.lockedAgain = tick;
      wasLocked = exp === 'locked';
    }
    return log;
  }

  it('gliding behind the wall: the lock follows the independent oracle every tick, is discarded in the tick the line of sight breaks, and restarts from 0 when it returns', () => {
    const g = rig('machinegun', [wall]);
    const sc: Script = { keys: keysGlide() };
    const log = scan(g, sc, 420, (tick) => {
      // glide back (A) two ticks after the lock was lost: the line of sight returns
      sc.keys.push(K(tick + 2, { left: true }), K(tick + 3, { left: false }));
    });
    expect(log.mismatches, 'lock == oracle at every tick').toEqual([]);
    expect(log.firstDrop, 'the wall must break a completed lock').toBeGreaterThan(eB);
    expect(log.firstReacquire, 'the line of sight returns').toBeGreaterThan(log.firstDrop);
    expect(log.lockedAgain, 'a whole lock time is needed again').toBe(log.firstReacquire + (eB - 1));
    table.push(
      `Lock expiry (wall, glide 22 m/s): complete lock discarded at tick ${log.firstDrop} (the tick the line of sight broke), ` +
        `target reacquired at tick ${log.firstReacquire} with progress 0, locked again at tick ${log.lockedAgain} (${log.lockedAgain - log.firstReacquire} ticks = lock time); ${log.ticks} ticks compared with the independent lock oracle, mismatches=${log.mismatches.length}`,
    );
  });

  it('QB sideways carries the target out of the FCS circle: the lock is discarded in that very tick (no wall involved) and stays gone while the target is outside', () => {
    const g = rig('machinegun', []);
    const sc: Script = { keys: qbSide(eB) };
    const log = scan(g, sc, 260);
    expect(log.mismatches, 'lock == oracle at every tick').toEqual([]);
    expect(log.firstDrop, 'the target leaves the circle after the QB').toBeGreaterThan(eB);
    expect(log.firstDrop, 'inside the coast phase of the QB').toBeLessThan(eB + 90);
    expect(log.firstReacquire, 'the player keeps gliding away: no reacquisition').toBe(-1);
    table.push(`Lock expiry (QB sideways, target leaves the FCS circle): complete lock discarded at tick ${log.firstDrop} (QB at tick ${eB}); ${log.ticks} ticks compared with the oracle, mismatches=${log.mismatches.length}`);
  });

  for (const scenario of ['wall', 'qb-circle'] as const) {
    it(`${scenario}: the shot in the tick before the discard is corrected, the shot right after it is free (machinegun/beam) or refused (missile, nothing spent)`, () => {
      const boxes = scenario === 'wall' ? [wall] : [];
      const keys = scenario === 'wall' ? keysGlide() : qbSide(eB);
      // probe run: the tick in which the completed lock is discarded
      const probe = rig('machinegun', boxes);
      const probeLog = scan(probe, { keys: [...keys] }, 300);
      const tDrop = probeLog.firstDrop;
      expect(tDrop).toBeGreaterThan(eB);
      for (const weapon of ['machinegun', 'beam', 'missile'] as const) {
        // (a) shot in the last valid tick: still locked, corrected
        {
          const g = rig(weapon, boxes);
          const sc: Script = { keys: [...keys], fire: (t) => t === tDrop - 1 };
          while (g.state.tick < tDrop - 1) stepOnce(g, sc);
          expect(g.state.lock.state, `${weapon}: locked one tick before the discard`).toBe('locked');
          stepOnce(g, sc);
          const rec = g.state.shots[0];
          expect(rec.solutionStatus, `${weapon}: the last valid shot is corrected`).toBe('solved');
          expect(rec.targetId).toBe(TGT);
        }
        // (b) shot in the tick after the discard
        const g = rig(weapon, boxes);
        const sc: Script = { keys: [...keys], fire: (t) => t === tDrop };
        while (g.state.tick < tDrop - 1) stepOnce(g, sc);
        const staleFc = JSON.parse(JSON.stringify(g.state.fc)) as FireControlState;
        expect(staleFc.status, `${weapon}: a solution existed one tick earlier`).toBe('solved');
        stepOnce(g, sc); // tick tDrop-1 -> tDrop: the lock is discarded here
        expect(g.state.tick).toBe(tDrop);
        expect(g.state.lock.state).toBe('none');
        expect(g.state.fc.status).toBe('inactive');
        const ammo0 = { ...g.state.player.ammo };
        const en0 = g.state.player.en;
        const pre = snapshotPre(g, g.state.enemies[0]);
        const free = freeFireDirection(g.state, g.world, playerMuzzlePosition(g.state.player));
        stepOnce(g, sc);
        const s = g.state;
        if (weapon === 'missile') {
          expect(s.shots.length, 'missile without a lock: nothing fired').toBe(0);
          expect(s.missiles.length).toBe(0);
          expect(s.player.ammo.missile, 'no ammo spent').toBe(ammo0.missile);
          expect(s.player.nextFireAt.missile, 'no cooldown started').toBe(0);
          expect(eventsOf(g, 'notice').some((e) => e.kind === 'noLock')).toBe(true);
        } else {
          expect(s.shots.length).toBe(1);
          const rec = s.shots[0];
          expect(rec.solutionStatus, 'free fire').toBe('inactive');
          expect(rec.targetId).toBeNull();
          expect(rec.targetPositionAtFire).toBeNull();
          expect(rec.predictedFlightSeconds).toBeNull();
          expect(len(sub(rec.launchDirection, free)), 'free-fire direction (camera-center aim from the muzzle)').toBeLessThan(1e-12);
          expect(len(sub(rec.muzzlePosition, pre.muzzleIndep))).toBeLessThan(1e-12);
          // the stale corrected direction was NOT reused
          expect(angleBetween(rec.launchDirection, staleFc.launchDirection as V3)).toBeGreaterThan(1e-4);
          if (weapon === 'machinegun') {
            expect(rec.initialVelocity).toEqual(mul(rec.launchDirection, S));
            expect(s.player.ammo.machinegun).toBe(ammo0.machinegun - 1);
          } else {
            expect(s.player.en).toBeCloseTo(en0 - 8, 9);
          }
        }
      }
    });
  }

  it('mouse-look away from the target while moving: the lock is dropped at the shot tick (revalidation), machinegun/beam shoot free, missile refused', () => {
    for (const weapon of ['machinegun', 'beam', 'missile'] as const) {
      const g = rig(weapon, []);
      const E = eB;
      const sc: Script = { keys: keysGlide(), fire: (t) => t === E, look: [{ tick: E, dx: 400, dy: 0 }] };
      while (g.state.tick < E) stepOnce(g, sc); // ticks 0..E-1
      expect(g.state.tick).toBe(E);
      expect(g.state.lock.state).toBe('locked');
      const fcBefore = JSON.parse(JSON.stringify(g.state.fc)) as FireControlState;
      expect(fcBefore.status).toBe('solved');
      expect(hlen(g.state.player.vel), 'gliding').toBeGreaterThan(20);
      // the mouse look + trigger of tick E (the look updates the camera at once, the shot revalidates the lock)
      applyInputs(g, sc, E);
      expect(g.state.player.yaw).not.toBe(YAW0);
      const free = freeFireDirection(g.state, g.world, playerMuzzlePosition(g.state.player));
      g.step();
      const s = g.state;
      expect(s.lock.state, 'the lock was discarded').toBe('none');
      expect(s.lock.targetId).toBeNull();
      expect(s.fc.status).toBe('inactive');
      if (weapon === 'missile') {
        expect(s.missiles.length).toBe(0);
        expect(s.player.ammo.missile).toBe(WEAPONS.missile.totalAmmo);
      } else {
        const rec = s.shots[0];
        expect(rec.solutionStatus).toBe('inactive');
        expect(rec.targetId).toBeNull();
        expect(len(sub(rec.launchDirection, free))).toBeLessThan(1e-12);
        expect(angleBetween(rec.launchDirection, fcBefore.launchDirection as V3), 'not the stale correction').toBeGreaterThan(0.1);
      }
    }
  });
});

// ===========================================================================
// 4. EN priority QB -> beam -> flight in one tick
// ===========================================================================
describe('4. EN priority in one tick: QB, then beam, then flight; only the unaffordable action fails; nothing is paid twice', () => {
  const dt = DT;
  /** airborne, Space held for 30 ticks (flight established: vy = 8), beam selected, Q up. EN is then set to `en` at the tick boundary. */
  function enRig(en: number, opts: { qb: boolean; fire: boolean; jump: boolean }): { g: Game; vyBefore: number } {
    const stage = buildTestArenaStage();
    const g = new Game({ stage, loadout: BIPED });
    g.sortie(BIPED);
    const p = g.state.player;
    p.pos.y = 300;
    p.grounded = false;
    p.weapon = 'beam';
    g.input.jump = true;
    for (let i = 0; i < 30; i++) g.step();
    expect(p.mv.thrusting, 'flight established').toBe(true);
    expect(p.vel.y).toBe(8);
    p.en = en;
    g.input.qb = opts.qb;
    g.input.fire = opts.fire;
    g.input.jump = opts.jump;
    return { g, vyBefore: p.vel.y };
  }
  const cases: { en: number; qb: boolean; beam: boolean; tau: number; note: string }[] = [
    { en: 120, qb: true, beam: true, tau: dt, note: 'all three affordable' },
    { en: 36 + 8 + 20 * dt, qb: true, beam: true, tau: dt, note: 'exactly QB + beam + one full flight tick' },
    { en: 44.05, qb: true, beam: true, tau: 0.05 / 20, note: 'QB + beam paid, only 0.05 EN (0.0025 s) left for flight' },
    { en: 44, qb: true, beam: true, tau: 0, note: 'QB + beam use everything, flight cannot start (no free ascent)' },
    { en: 40, qb: true, beam: false, tau: dt, note: 'QB paid, beam (needs 8 of the 4 left) refused, flight uses the rest' },
    { en: 36, qb: true, beam: false, tau: 0, note: 'QB uses everything: beam refused, no flight' },
    { en: 35, qb: false, beam: true, tau: dt, note: 'EN 35: QB fails, beam succeeds, flight continues' },
    { en: 8.1, qb: false, beam: true, tau: 0.1 / 20, note: 'beam is paid BEFORE flight: 0.1 EN is left for a partial thrust' },
    { en: 8, qb: false, beam: true, tau: 0, note: 'beam uses the last 8 EN, flight cannot run' },
    { en: 7.99, qb: false, beam: false, tau: dt, note: 'beam refused (7.99 < 8), flight uses EN' },
  ];
  for (const cs of cases) {
    it(`EN ${cs.en.toFixed(4)}: ${cs.note}`, () => {
      const { g, vyBefore } = enRig(cs.en, { qb: true, fire: true, jump: true });
      const p = g.state.player;
      const T = g.state.time;
      const nextBeamBefore = p.nextFireAt.beam;
      g.step();
      const paidQb = cs.qb ? PLAYER.QB.COST : 0;
      const paidBeam = cs.beam ? WEAPONS.beam.enCost : 0;
      const paidFlight = PLAYER.FLIGHT_EN_PER_SEC * cs.tau;
      // QB
      expect(p.mv.qbSuccessCount, 'QB count').toBe(cs.qb ? 1 : 0);
      expect(hlen(p.vel), 'horizontal speed').toBeCloseTo(cs.qb ? 80 : 0, 9);
      if (!cs.qb) {
        expect(p.mv.qbLastStartedAt, 'a failed QB keeps no wait time').toBeNull();
        expect(p.mv.qbCooldownRemaining).toBe(0);
        expect(g.state.events.some((e) => e.type === 'qb')).toBe(false);
      }
      // beam
      expect(g.state.shots.length, 'beam shots').toBe(cs.beam ? 1 : 0);
      expect(eventsOf(g, 'beamFire').length).toBe(cs.beam ? 1 : 0);
      if (cs.beam) {
        expect(p.nextFireAt.beam).toBeCloseTo(T + WEAPONS.beam.interval, 12);
      } else {
        expect(p.nextFireAt.beam, 'a refused beam keeps its timer').toBe(nextBeamBefore);
        expect(g.state.notices.noEnAt, 'EN shortage notice').toBe(T);
      }
      // flight: only the affordable part is thrust, the rest is gravity (no free ascent)
      expect(p.mv.thrusting, 'flight thrust').toBe(cs.tau > 0);
      expect(p.vel.y, 'vertical speed: thrust for tau, gravity for the rest').toBeCloseTo(cs.tau > 0 ? 8 - G * (dt - cs.tau) : vyBefore - G * dt, 9);
      // EN: every paid cost exactly once
      expect(cs.en - p.en, 'EN paid = QB + beam + flight').toBeCloseTo(paidQb + paidBeam + paidFlight, 9);
      expect(p.en).toBeGreaterThanOrEqual(0);
      const tail = cs.en - (paidQb + paidBeam);
      if (tail < 20 * dt) expect(p.en, 'EN never negative; remainder consumed').toBe(0);
    });
  }

  it('a beam refused for lack of EN changes neither EN, the wait time nor lastEnSpentAt; the next tick with EN 8 fires at once', () => {
    const stage = buildTestArenaStage();
    const g = new Game({ stage, loadout: BIPED });
    g.sortie(BIPED);
    const p = g.state.player;
    p.pos.y = 300;
    p.grounded = false;
    p.weapon = 'beam';
    p.en = 7.99;
    g.input.fire = true;
    const before = { en: p.en, next: p.nextFireAt.beam, spent: p.mv.lastEnSpentAt };
    expect(before.spent).toBeNull();
    for (let i = 0; i < 20; i++) g.step();
    expect(p.en, 'EN unchanged').toBe(before.en);
    expect(p.nextFireAt.beam, 'wait time unchanged').toBe(before.next);
    expect(p.mv.lastEnSpentAt, 'lastEnSpentAt unchanged').toBe(before.spent);
    expect(g.state.shots.length).toBe(0);
    expect(eventsOf(g, 'beamFire').length).toBe(0);
    p.en = 8;
    const T = g.state.time;
    g.step();
    expect(g.state.shots.length, 'no waiting time was consumed by the refusals').toBe(1);
    expect(g.state.shots[0].firedAtSeconds).toBe(T);
    expect(p.en).toBe(0);
    expect(p.mv.lastEnSpentAt).toBe(T);
  });

  it('moving and shooting: glide is free and never blocks the beam; beam + QB + glide at EN 44 in one tick on the ground', () => {
    const g = makeGame({ loadout: BIPED, yaw: YAW0, pitch: 0, weapon: 'beam' });
    const p = g.state.player;
    const sc: Script = { keys: [K(0, { shift: true, right: true }), K(1, { shift: false, right: false })] };
    for (let i = 0; i < 40; i++) stepOnce(g, sc);
    expect(p.en).toBe(120);
    expect(p.mv.glideEnabled).toBe(true);
    p.en = 44;
    const T = g.state.time;
    g.input.qb = true;
    g.input.right = true;
    g.input.fire = true;
    g.step();
    expect(p.mv.qbSuccessCount).toBe(1);
    expect(g.state.shots.length).toBe(1);
    expect(p.en).toBe(0);
    expect(p.mv.lastEnSpentAt).toBe(T);
    // glide during the following ticks costs nothing and EN stays 0 (no regen inside the 0.75 s wait, no flight)
    g.input.qb = false;
    g.input.fire = false;
    for (let i = 0; i < 60; i++) g.step();
    expect(p.en).toBe(0);
  });
});

// ===========================================================================
// 5. the correction never moves the muzzle, steers the camera or the player
// ===========================================================================
describe('5. correction does not steer the camera / player; the muzzle depends on yaw and position only', () => {
  it('the muzzle is independent of pitch, of the correction and of the weapon (independent yaw-frame formula, several yaw / pitch / positions)', () => {
    const g = makeGame({ loadout: BIPED, yaw: 0.3, pitch: 0 });
    const p = g.state.player;
    for (const yaw of [0, 0.3, 1.1, -2.4, Math.PI, 5.5]) {
      for (const pos of [v3(0, 1.5, 0), v3(13.7, 9.2, -40.1), v3(-250, 77, 311)]) {
        const ms: V3[] = [];
        for (const pitch of [-1.2, -0.4, 0, 0.5, 1.2]) {
          p.yaw = yaw;
          p.pitch = pitch;
          p.pos = cp(pos);
          updateCamera(g.state, g.world);
          ms.push(playerMuzzlePosition(p));
        }
        for (const m of ms) {
          expect(len(sub(m, muzzleOf(pos, yaw)))).toBeLessThan(1e-12);
          expect(len(sub(m, ms[0]))).toBe(0);
        }
      }
    }
  });

  it('QB + flight + glide with a locked, corrected shot every 0.1 s: the player and camera equal the same inputs with no target and no fire (bit for bit)', () => {
    const keys = [...glideSideTap(), K(40, { jump: true }), ...qbForward(eW + 24)];
    const c = makeCondition({ id: 'steer', loadout: WIDE_CAP, keys, Fs: [eW], v: VEL.A05, until: eW + 90 });
    for (const weapon of ['machinegun', 'beam', 'missile'] as const) {
      const g = makeGame(rigOf(c, weapon));
      const pF = add(c.dry[eW].muzzle, c.r);
      g.state.enemies.push(makeScriptedTarget(TGT, targetAt(pF, c.v, 0, eW), c.v));
      const sc: Script = { keys, fire: (t) => t >= eW && t < eW + 90 };
      const trace: Sample[] = [];
      while (g.state.tick < eW + 90) stepOnce(g, sc, trace);
      trace.push(sample(g));
      expect(g.state.shots.length, `${weapon}: it did fire`).toBeGreaterThan(0);
      expect(g.state.shots.some((s) => s.solutionStatus === 'solved'), `${weapon}: corrected shots were fired`).toBe(true);
      expect(firstMismatch(trace, c.dry), `${weapon}: player + camera trace`).toBe(-1);
      // the actual launch directions are not the camera direction: the camera was never turned toward them
      for (const s of g.state.shots) expect(s.muzzlePosition.y).toBeGreaterThan(1);
      expect(g.state.player.yaw).toBe(c.yaw);
      expect(g.state.player.pitch).toBe(c.pitch);
    }
  });

  it('a corrected shot and a free shot at the same tick leave from the same muzzle (only the direction differs)', () => {
    const def = DEF('glide-side');
    const c = getCond(def, 'A05');
    const F = eB + 5;
    const run = runShot(c, F, 'machinegun');
    // same inputs, same tick, no target -> free fire
    const g = makeGame(rigOf(c));
    const sc: Script = { keys: c.keys, fire: (t) => t === F };
    while (g.state.tick <= F) stepOnce(g, sc);
    const free = g.state.shots[0];
    expect(free.solutionStatus).toBe('inactive');
    expect(len(sub(free.muzzlePosition, run.rec.muzzlePosition))).toBe(0);
    expect(angleBetween(free.launchDirection, run.rec.launchDirection), 'the correction changes only the direction').toBeGreaterThan(0.01);
  });
});

// ===========================================================================
// 6. shot time consistency (also covered per shot in section 1/2): explicit first-tick check on every weapon
// ===========================================================================
describe('6. shot-time consistency: a spawned projectile advances exactly dt in its spawn tick', () => {
  it('machinegun: age == dt and position == m + v0 dt + g dt^2 / 2 for gliding, flying and QB shots; every later tick matches the analytic parabola', () => {
    let n = 0;
    for (const id of ['glide-side', 'flight-up', 'qb-impulse-side', 'qb-inertia-back']) {
      const def = DEF(id);
      const c = getCond(def, 'A05');
      for (const F of [def.Fs[0], def.Fs[7], def.Fs[19]]) {
        const run = runShot(c, F, 'machinegun');
        const b = run.g.state.bullets[0];
        const m = run.rec.muzzlePosition;
        const v0 = run.rec.initialVelocity as V3;
        expect(b.age).toBe(DT);
        expect(len(sub(b.pos, v3(m.x + v0.x * DT, m.y + v0.y * DT - 0.5 * G * DT * DT, m.z + v0.z * DT)))).toBeLessThan(1e-12);
        // the player moved during the same tick but the bullet did NOT inherit that motion: its position minus the muzzle is v0 dt + g dt^2/2
        const playerStep = len(sub(run.post.pos, run.pre.pos));
        expect(playerStep).toBeGreaterThan(0.001);
        // advance three more ticks: age = 4 dt and the position stays analytic
        stepOnce(run.g, run.sc, run.trace);
        stepOnce(run.g, run.sc, run.trace);
        stepOnce(run.g, run.sc, run.trace);
        const a = 4 * DT;
        expect(b.age).toBeCloseTo(a, 12);
        expect(len(sub(b.pos, v3(m.x + v0.x * b.age, m.y + v0.y * b.age - 0.5 * G * b.age * b.age, m.z + v0.z * b.age)))).toBeLessThan(1e-12);
        n++;
      }
    }
    expect(n).toBe(12);
  });
});

// ===========================================================================
// 7. render-rate independence: Game.advance with 1/30, 1/60, 1/144 s frames
// ===========================================================================
describe('7. the same input sequence through Game.advance at 1/30, 1/60, 1/144 s per frame gives identical shots and hits', () => {
  /** inputs change only at ticks that are multiples of 20 (1/6 s): a tick boundary for every frame rate */
  const FPS_DEFS: { id: string; loadout: Loadout; keys: KeyEvent[]; Fs: number[]; minSpeed: number }[] = [
    { id: 'glide-side', loadout: BIPED, keys: [K(20, { shift: true, right: true }), K(40, { shift: false, right: false })], Fs: [100, 120, 140], minSpeed: 20 },
    { id: 'flight-glide-side', loadout: BIPED, keys: [K(20, { shift: true, right: true }), K(40, { shift: false, right: false, jump: true })], Fs: [100, 120], minSpeed: 15 },
    { id: 'qb-back', loadout: BIPED, keys: [K(100, { qb: true, back: true }), K(120, { qb: false, back: false })], Fs: [100, 120, 140, 160], minSpeed: 15 },
    { id: 'qb-side-wide', loadout: WIDE, keys: [K(160, { qb: true, right: true }), K(180, { qb: false, right: false })], Fs: [160, 180, 200, 220], minSpeed: 15 },
  ];
  const FRAMES: { name: string; dt: number | null }[] = [
    { name: 'tick', dt: null },
    { name: '1/30', dt: 1 / 30 },
    { name: '1/60', dt: 1 / 60 },
    { name: '1/144', dt: 1 / 144 },
  ];

  function runFrames(c: Condition, F: number, weapon: WeaponId, frameDt: number | null): unknown {
    const g = makeGame(rigOf(c, weapon));
    const pF = add(c.dry[F].muzzle, c.r);
    g.state.enemies.push(makeScriptedTarget(TGT, targetAt(pF, c.v, 0, F), c.v));
    const tgt = g.state.enemies[0];
    const sc: Script = { keys: c.keys, fire: (t) => t === F };
    const total = Math.ceil((F + 360) / 20) * 20;
    if (frameDt === null) {
      while (g.state.tick < total) stepOnce(g, sc);
    } else {
      // a FIXED number of frames covering exactly `total` ticks of time: the accumulator must neither lose nor add a tick
      const frames = Math.round((total * DT) / frameDt);
      expect(Math.abs(frames * frameDt - total * DT), 'frame count covers the run exactly').toBeLessThan(1e-9);
      for (let f = 0; f < frames; f++) {
        applyInputs(g, sc, g.state.tick); // inputs change only at tick boundaries that are frame boundaries
        g.advance(frameDt);
      }
    }
    expect(g.state.tick, 'ticks executed').toBe(total);
    const s = g.state;
    return {
      tick: s.tick,
      shots: JSON.parse(JSON.stringify(s.shots)),
      hp: tgt.hp,
      tgtPos: cp(tgt.pos),
      player: { pos: cp(s.player.pos), vel: cp(s.player.vel), en: s.player.en, qb: s.player.mv.qbSuccessCount, ammo: { ...s.player.ammo }, next: { ...s.player.nextFireAt } },
      hitEvents: s.events.filter((e) => e.type === 'hit' && e.on === 'enemy').length,
      lock: { state: s.lock.state, targetId: s.lock.targetId },
    };
  }

  for (const def of FPS_DEFS) {
    for (const weapon of ['machinegun', 'beam', 'missile'] as const) {
      it(`${def.id} / ${weapon}: shot records, hits, EN, positions identical for tick stepping and 1/30, 1/60, 1/144 frames`, () => {
        const c = makeCondition({ id: `fps-${def.id}`, loadout: def.loadout, keys: def.keys, Fs: def.Fs, v: VEL.A05 });
        let shotsTotal = 0;
        let hitsTotal = 0;
        for (const F of def.Fs) {
          // the run itself must be a real, valid moving shot
          const ref = runShot(c, F, weapon);
          verify(ref, def.minSpeed);
          const results = FRAMES.map((f) => ({ name: f.name, r: runFrames(c, F, weapon, f.dt) as { shots: ShotRecord[]; hp: number; hitEvents: number } }));
          for (const x of results.slice(1)) expect(x.r, `${def.id}/${weapon} F=${F}: ${x.name} vs tick stepping`).toEqual(results[0].r);
          const r0 = results[0].r;
          expect(r0.shots.length).toBe(1);
          expect(TARGET_HP - r0.hp).toBe(weapon === 'machinegun' ? 12 : weapon === 'beam' ? 40 : 180);
          shotsTotal += FRAMES.length;
          hitsTotal += FRAMES.length;
        }
        table.push(`FPS ${def.id}/${weapon}: ${def.Fs.length} shot ticks x 4 frame settings (tick, 1/30, 1/60, 1/144) = ${shotsTotal} runs, all records/hits/EN/positions identical, hits=${hitsTotal}`);
      });
    }
  }
});

// ===========================================================================
// 8. seeded random input plans (no Math.random: a fixed LCG): every feasible moving shot satisfies every invariant above
// ===========================================================================
describe('8. randomized moving shots (seeded): random walk / glide / jump / flight / QB / brake plans, random weapon, loadout, target velocity', () => {
  it('every random plan whose target stays a lock candidate: real lock -> real shot -> real hit, exactly as in the fixed conditions', () => {
    let seed = 20260908;
    const rnd = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const pick = <T,>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)];
    const loadouts = [BIPED, WIDE, QUAD, QUAD_WIDE];
    const weapons: WeaponId[] = ['machinegun', 'machinegun', 'machinegun', 'beam', 'missile'];
    const vks: VelKey[] = ['A05', 'A06', 'A07'];
    const planned = 400;
    let feasible = 0;
    let shots = 0;
    let hits = 0;
    let qbShots = 0;
    let airShots = 0;
    let fastShots = 0;
    const perWeapon: Record<string, { n: number; hit: number }> = { machinegun: { n: 0, hit: 0 }, beam: { n: 0, hit: 0 }, missile: { n: 0, hit: 0 } };
    for (let n = 0; n < planned; n++) {
      const loadout = pick(loadouts);
      const E = earliest(loadout);
      const keys: KeyEvent[] = [];
      const end = E + 45;
      for (let t = 0; t < end; t += 10) {
        keys.push(
          K(t, {
            forward: rnd() < 0.25,
            back: rnd() < 0.2,
            left: rnd() < 0.25,
            right: rnd() < 0.25,
            jump: rnd() < 0.25,
            ctrl: rnd() < 0.08,
          }),
        );
        const tap = (name: 'shift' | 'qb', p: number): void => {
          if (rnd() < p) {
            const at = t + Math.floor(rnd() * 8);
            keys.push(K(at, { [name]: true }), K(at + 1, { [name]: false }));
          }
        };
        tap('shift', 0.15);
        tap('qb', t >= E - 30 ? 0.12 : 0.03);
      }
      keys.sort((a, b) => a.tick - b.tick);
      const Fs = [E + Math.floor(rnd() * 40)];
      const vk = pick(vks);
      const weapon = pick(weapons);
      let c: Condition;
      try {
        c = makeCondition({ id: `fuzz${n}`, loadout, keys, Fs, v: VEL[vk] });
      } catch {
        continue; // the random motion carried the target out of the FCS circle / range: no lock, no shot to verify
      }
      feasible++;
      const run = runShot(c, Fs[0], weapon);
      const m = verify(run, 0);
      shots++;
      perWeapon[weapon].n++;
      if (m.hit) {
        hits++;
        perWeapon[weapon].hit++;
      }
      expect(m.hit, `${c.id} ${weapon}`).toBe(true);
      const sp = Math.max(len(run.pre.vel), len(run.post.vel));
      if (run.g.state.player.mv.qbSuccessCount > 0) qbShots++;
      if (!run.pre.pos || run.pre.pos.y > 2.5) airShots++;
      if (sp > 15) fastShots++;
    }
    expect(feasible, 'enough random plans kept a lock').toBeGreaterThanOrEqual(60);
    expect(hits).toBe(shots);
    table.push(
      `Random plans (seeded LCG): ${planned} plans, ${feasible} kept the target a lock candidate -> shots=${shots} hits=${hits} ` +
        `(mg ${perWeapon.machinegun.hit}/${perWeapon.machinegun.n}, beam ${perWeapon.beam.hit}/${perWeapon.beam.n}, missile ${perWeapon.missile.hit}/${perWeapon.missile.n}); ` +
        `shots after >=1 QB=${qbShots}, airborne (y>2.5)=${airShots}, player speed >15 m/s=${fastShots}`,
    );
  });
});
