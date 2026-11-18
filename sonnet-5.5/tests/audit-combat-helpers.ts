/**
 * Shared helpers for the adversarial SPEC audit of §4 (weapons / FCS correction / beam / missile / occlusion) and §5 (FCS lock).
 *
 * Rules of this audit:
 *  - every claim is checked on the REAL Game (Game.step -> updateFcs / playerFireStep / stepPlayerProjectiles / damageEnemy);
 *  - the oracles below are written from the SPEC text only and share NO code with src/sim/{ballistics,fcs,weapons,projectiles}.ts:
 *    the machinegun intercept is a brute-force scan of the SPEC §4.3 equation, the missile intercept is the SPEC §4.4 quadratic,
 *    LOS is a slab test written here, the lock candidate test is re-derived from SPEC §5.
 *  - a test is never loosened to match the implementation.
 */
import { expect } from 'vitest';
import { FCS_PARTS, PLAYER, SIM } from '../src/config';
import type { FcsId } from '../src/config';
import { updateCamera } from '../src/sim/camera';
import { Game } from '../src/sim/game';
import { createScenarioGame, makeScriptedTarget } from '../src/sim/scenario';
import type { Scenario } from '../src/sim/scenario';
import { buildTestArenaStage } from '../src/sim/testArena';
import type { BoxDef, EnemyState, GameState, Loadout, ShotRecord, V3, WeaponId } from '../src/sim/types';

export const DT = SIM.DT;
export const v3 = (x: number, y: number, z: number): V3 => ({ x, y, z });
export const ZERO: V3 = v3(0, 0, 0);
export const add = (a: V3, b: V3): V3 => v3(a.x + b.x, a.y + b.y, a.z + b.z);
export const sub = (a: V3, b: V3): V3 => v3(a.x - b.x, a.y - b.y, a.z - b.z);
export const mul = (a: V3, k: number): V3 => v3(a.x * k, a.y * k, a.z * k);
export const dot = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const len = (a: V3): number => Math.sqrt(dot(a, a));
export const unit = (a: V3): V3 => mul(a, 1 / len(a));
export const cp = (a: V3): V3 => v3(a.x, a.y, a.z);
export const angleBetween = (a: V3, b: V3): number => Math.acos(Math.max(-1, Math.min(1, dot(a, b) / (len(a) * len(b)))));
export const box = (id: string, min: V3, max: V3): BoxDef => ({ id, min, max, mat: 'metal', sectorId: 'T00' });

/** deterministic PRNG for the randomised audits (mulberry32; NOT the game's rng) */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// games
// ---------------------------------------------------------------------------------------------------------------------
export interface GameOpts {
  loadout?: Loadout;
  w?: number;
  h?: number;
  boxes?: BoxDef[];
  pitch?: number;
  yaw?: number;
  weapon?: WeaponId;
}

export const DEFAULT_LOADOUT: Loadout = { fcs: 'medium', generator: 'balanced', legs: 'biped' };

/** playing Game on the flat arena; the player stands at the origin (yaw 0 => facing -Z) with a level camera by default */
export function makeGame(o: GameOpts = {}): Game {
  const stage = buildTestArenaStage();
  stage.boxes.push(...(o.boxes ?? []));
  const loadout = o.loadout ?? DEFAULT_LOADOUT;
  const g = new Game({ stage, loadout, viewportW: o.w ?? 1280, viewportH: o.h ?? 720 });
  g.sortie(loadout);
  g.state.player.pitch = o.pitch ?? 0;
  g.state.player.yaw = o.yaw ?? 0;
  if (o.weapon) g.state.player.weapon = o.weapon;
  updateCamera(g.state, g.world);
  return g;
}

let idSeq = 0;
export function addTarget(g: Game, pos: V3, vel: V3 = ZERO, id?: string, radius?: number): EnemyState {
  const e = makeScriptedTarget(id ?? `D${String(++idSeq).padStart(3, '0')}`, pos, vel, radius);
  g.state.enemies.push(e);
  return e;
}
export const run = (g: Game, n: number): void => {
  for (let i = 0; i < n; i++) g.step();
};
/** the point on the camera's center ray `depth` m in front of the camera (projects to the exact screen center) */
export const onCamRay = (g: Game, depth: number): V3 => add(g.state.camera.pos, mul(g.state.camera.forward, depth));
export const lockTicks = (g: Game): number => Math.ceil(g.state.stats.lockSeconds / DT - 1e-9);
/** step until the FCS lock is complete; the caller has placed a valid candidate */
export function lockOn(g: Game): void {
  run(g, lockTicks(g) + 2);
  expect(g.state.lock.state).toBe('locked');
}
/** one tick with the trigger held, then released */
export function pull(g: Game, ticks = 1): void {
  g.input.fire = true;
  run(g, ticks);
  g.input.fire = false;
}
export const teleport = (e: EnemyState, p: V3): void => {
  e.pos = cp(p);
  e.prevPos = cp(p);
};

/** SPEC yaw convention (math.ts): forward = (-sin yaw, 0, -cos yaw), right = (cos yaw, 0, -sin yaw) */
export function muzzleOf(pos: V3, yaw: number): V3 {
  const o = PLAYER.MUZZLE_OFFSET;
  return v3(
    pos.x + Math.cos(yaw) * o.right - Math.sin(yaw) * o.forward,
    pos.y + o.up,
    pos.z - Math.sin(yaw) * o.right - Math.cos(yaw) * o.forward,
  );
}
export const muzzleNow = (s: GameState): V3 => muzzleOf(s.player.pos, s.player.yaw);

// ---------------------------------------------------------------------------------------------------------------------
// independent geometry
// ---------------------------------------------------------------------------------------------------------------------
/** closed segment a->b vs AABB (slab method), written independently of World */
export function segHitsBox(a: V3, b: V3, mn: V3, mx: V3): boolean {
  let t0 = 0;
  let t1 = 1;
  const A = [a.x, a.y, a.z];
  const D = [b.x - a.x, b.y - a.y, b.z - a.z];
  const L = [mn.x, mn.y, mn.z];
  const H = [mx.x, mx.y, mx.z];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(D[i]) < 1e-15) {
      if (A[i] < L[i] || A[i] > H[i]) return false;
      continue;
    }
    let s1 = (L[i] - A[i]) / D[i];
    let s2 = (H[i] - A[i]) / D[i];
    if (s1 > s2) [s1, s2] = [s2, s1];
    if (s1 > t0) t0 = s1;
    if (s2 < t1) t1 = s2;
    if (t0 > t1) return false;
  }
  return true;
}
/** any ENABLED box of the game's world hits the closed segment */
export function blocked(g: Game, a: V3, b: V3): boolean {
  const boxes = g.world.boxes;
  for (let i = 0; i < boxes.length; i++) {
    if (!g.world.isBoxEnabled(i)) continue;
    if (segHitsBox(a, b, boxes[i].min, boxes[i].max)) return true;
  }
  return false;
}
/** distance from point p to the AABB */
export function distToBox(p: V3, mn: V3, mx: V3): number {
  const dx = Math.max(mn.x - p.x, 0, p.x - mx.x);
  const dy = Math.max(mn.y - p.y, 0, p.y - mx.y);
  const dz = Math.max(mn.z - p.z, 0, p.z - mx.z);
  return Math.hypot(dx, dy, dz);
}
/** distance from ray origin o along unit dir d to the sphere surface, or null (0 when inside) */
export function raySphereT(o: V3, d: V3, c: V3, r: number): number | null {
  const oc = sub(o, c);
  const cc = dot(oc, oc) - r * r;
  if (cc <= 0) return 0;
  const b = dot(oc, d);
  if (b >= 0) return null;
  const disc = b * b - cc;
  if (disc < 0) return null;
  return -b - Math.sqrt(disc);
}

// ---------------------------------------------------------------------------------------------------------------------
// SPEC §4.3 machinegun intercept: brute-force oracle
// ---------------------------------------------------------------------------------------------------------------------
const S_MG = 100;
const G_MG = 18;
/** |r + v t - 0.5 g t^2|^2 - s^2 t^2  (g = (0,-18,0), so -0.5 g t^2 = +9 t^2 in y) */
export function mgF(r: V3, v: V3, t: number): number {
  const wx = r.x + v.x * t;
  const wy = r.y + v.y * t + 0.5 * G_MG * t * t;
  const wz = r.z + v.z * t;
  return wx * wx + wy * wy + wz * wz - S_MG * S_MG * t * t;
}
/** miss distance |w| - s t (same sign as F) */
export function mgGap(r: V3, v: V3, t: number): number {
  const wx = r.x + v.x * t;
  const wy = r.y + v.y * t + 0.5 * G_MG * t * t;
  const wz = r.z + v.z * t;
  return Math.sqrt(wx * wx + wy * wy + wz * wz) - S_MG * t;
}
export interface MgOracle {
  /** smallest positive root <= 2 found by a 4e-5 s scan + bisection, or null */
  t: number | null;
  /** min over the scan of |w| - s t (a target that is clearly reachable has minGap << 0) */
  minGap: number;
}
export function mgOracle(m: V3, p: V3, v: V3, maxT = 2): MgOracle {
  const r = sub(p, m);
  const N = 50000;
  let prevT = 0;
  let prevGap = mgGap(r, v, 0);
  let minGap = prevGap;
  let t: number | null = null;
  for (let i = 1; i <= N; i++) {
    const ti = (maxT * i) / N;
    const gi = mgGap(r, v, ti);
    if (gi < minGap) minGap = gi;
    if (t === null && prevGap > 0 && gi <= 0) {
      let lo = prevT;
      let hi = ti;
      for (let k = 0; k < 80; k++) {
        const mid = 0.5 * (lo + hi);
        if (mgGap(r, v, mid) > 0) lo = mid;
        else hi = mid;
      }
      t = 0.5 * (lo + hi);
    }
    prevT = ti;
    prevGap = gi;
  }
  return { t, minGap };
}
/** SPEC §4.3: d = (r + v t - 0.5 g t^2) / (s t) */
export function mgDirection(m: V3, p: V3, v: V3, t: number): V3 {
  const r = sub(p, m);
  return v3((r.x + v.x * t) / (S_MG * t), (r.y + v.y * t + 0.5 * G_MG * t * t) / (S_MG * t), (r.z + v.z * t) / (S_MG * t));
}
/** SPEC §4.3 residual: |m + v0 t + 0.5 g t^2 - (p + v t)| */
export function mgResidualOf(m: V3, v0: V3, p: V3, v: V3, t: number): number {
  const b = v3(m.x + v0.x * t, m.y + v0.y * t - 0.5 * G_MG * t * t, m.z + v0.z * t);
  return len(sub(b, add(p, mul(v, t))));
}
/** analytic bullet position m + v0 a + 0.5 g a^2 */
export const mgPos = (m: V3, v0: V3, a: number): V3 => v3(m.x + v0.x * a, m.y + v0.y * a - 0.5 * G_MG * a * a, m.z + v0.z * a);

// ---------------------------------------------------------------------------------------------------------------------
// SPEC §4.4 missile intercept
// ---------------------------------------------------------------------------------------------------------------------
/** smallest positive real root t in (0, maxT] of (v.v - 45^2) t^2 + 2 (r.v) t + r.r = 0, or null */
export function missileRoot(r: V3, v: V3, maxT = 4): number | null {
  const a = dot(v, v) - 45 * 45;
  const hb = dot(r, v);
  const c = dot(r, r);
  const roots: number[] = [];
  if (Math.abs(a) < 1e-9) {
    if (hb !== 0) roots.push(-c / (2 * hb));
  } else {
    const disc = hb * hb - a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      roots.push((-hb - sq) / a, (-hb + sq) / a);
    }
  }
  const ok = roots.filter((x) => x > 0 && x <= maxT).sort((x, y) => x - y);
  return ok.length ? ok[0] : null;
}

// ---------------------------------------------------------------------------------------------------------------------
// SPEC §4.6 scenario shots (real Game; the target is placed by the scenario, then given an arbitrary actual velocity)
// ---------------------------------------------------------------------------------------------------------------------
export const SCEN_M: V3 = v3(0, 20, 0);
export interface ShotRun {
  sc: Scenario;
  g: Game;
  tgt: EnemyState;
  rec: ShotRecord;
  fcBefore: ReturnType<typeof snapFc>;
}
export const snapFc = (fc: GameState['fc']): GameState['fc'] => JSON.parse(JSON.stringify(fc)) as GameState['fc'];

/**
 * SPEC §4.6 style single shot. The target is created STATIONARY at m + r, the normal FCS completes the lock, and in the shot tick the
 * target's actual velocity is set to `v` (its velocity is the one the scripted target really moves with afterwards). Then fire once.
 */
export function scenarioShot(r: V3, v: V3, o: { weapon?: WeaponId; loadout?: Loadout; delayTicks?: number; targetRadius?: number } = {}): ShotRun {
  const sc = createScenarioGame({ r, v: ZERO, weapon: o.weapon, loadout: o.loadout, delayTicks: o.delayTicks ?? 0 });
  const g = sc.game;
  run(g, sc.fireTick);
  expect(g.state.lock.state, `lock complete before the shot (r=${JSON.stringify(r)})`).toBe('locked');
  const tgt = g.state.enemies.find((e) => e.id === sc.targetId)!;
  if (o.targetRadius !== undefined) tgt.hitRadius = o.targetRadius;
  tgt.vel = cp(v);
  const fcBefore = snapFc(g.state.fc);
  g.input.fire = true;
  g.step();
  g.input.fire = false;
  expect(g.state.shots.length).toBe(1);
  return { sc, g, tgt, rec: g.state.shots[0], fcBefore };
}

// ---------------------------------------------------------------------------------------------------------------------
// SPEC §5 lock oracle
// ---------------------------------------------------------------------------------------------------------------------
export function fcsRadiusPx(fcs: FcsId, w: number, h: number): number {
  return FCS_PARTS[fcs].radiusRatio * Math.min(w, h);
}
/** SPEC §5 candidate test re-derived from the text; returns id -> distance from the screen center [css px] */
export function lockCandidates(g: Game, radiusPx: number): Map<string, number> {
  const s = g.state;
  const cam = s.camera;
  const m = muzzleNow(s);
  const F = cam.viewportH / 2 / Math.tan((cam.fovYDeg * Math.PI) / 360);
  const out = new Map<string, number>();
  for (const e of s.enemies) {
    if (!e.alive) continue;
    if (len(sub(e.pos, m)) > 120 + 1e-6) continue;
    const d = sub(e.pos, cam.pos);
    const depth = dot(d, cam.forward);
    if (!(depth > 1e-6)) continue;
    const x = (dot(d, cam.right) / depth) * F;
    const y = -(dot(d, cam.up) / depth) * F;
    const px = Math.hypot(x, y);
    if (!(px <= radiusPx + 1e-9)) continue;
    if (blocked(g, cam.pos, e.pos) || blocked(g, m, e.pos)) continue;
    out.set(e.id, px);
  }
  return out;
}
export interface LockModel {
  targetId: string | null;
  elapsed: number;
}
/** advance the SPEC §5 state machine by one tick and return the expected public lock fields */
export function lockModelStep(model: LockModel, cands: Map<string, number>, lockSeconds: number): { state: 'none' | 'acquiring' | 'locked'; progress: number } {
  if (model.targetId !== null && cands.has(model.targetId)) {
    model.elapsed += DT;
  } else {
    model.targetId = null;
    model.elapsed = 0;
    let best: string | null = null;
    let bestD = Infinity;
    for (const [id, d] of cands) {
      if (d < bestD - 1e-9 || (Math.abs(d - bestD) <= 1e-9 && best !== null && id < best)) {
        best = id;
        bestD = d;
      }
    }
    model.targetId = best;
  }
  if (model.targetId === null) return { state: 'none', progress: 0 };
  if (model.elapsed >= lockSeconds - 1e-9) return { state: 'locked', progress: 1 };
  return { state: 'acquiring', progress: model.elapsed / lockSeconds };
}

