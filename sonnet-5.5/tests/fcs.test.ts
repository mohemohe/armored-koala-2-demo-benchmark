/**
 * SPEC §5 FCS lock, verified on the real Game (Game.step -> updateFcs / revalidateLock). Targets are scripted radius-0.5 dummies
 * (EnemyState.scripted) so the enemy AI never interferes; positions are chosen through the real camera projection.
 */
import { describe, expect, it } from 'vitest';
import { FCS_PARTS, LEGS_PARTS, SIM } from '../src/config';
import type { FcsId, LegsId } from '../src/config';
import { playerMuzzlePosition, updateCamera } from '../src/sim/camera';
import { damageEnemy } from '../src/sim/combat';
import { isLockCandidate, refreshFireSolution, revalidateLock } from '../src/sim/fcs';
import { Game } from '../src/sim/game';
import { addScaled, distance, dot, sub } from '../src/sim/math';
import { projectToScreen } from '../src/sim/project';
import { makeScriptedTarget } from '../src/sim/scenario';
import { buildTestArenaStage } from '../src/sim/testArena';
import type { BoxDef, EnemyState, GameState, Loadout, V3, WeaponId } from '../src/sim/types';
import { buildSnapshot } from '../src/sim/bench';
import { computeFireSolution } from '../src/sim/weapons';

const DT = SIM.DT;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const box = (id: string, min: V3, max: V3): BoxDef => ({ id, min, max, mat: 'metal', sectorId: 'T00' });

interface Opts {
  loadout?: Loadout;
  w?: number;
  h?: number;
  boxes?: BoxDef[];
}

/** playing Game on the flat arena; the player stands at the origin looking along -Z with a level camera */
function makeGame(o: Opts = {}): Game {
  const stage = buildTestArenaStage();
  stage.boxes.push(...(o.boxes ?? []));
  const loadout = o.loadout ?? { fcs: 'medium', generator: 'balanced', legs: 'biped' };
  const g = new Game({ stage, loadout, viewportW: o.w ?? 1280, viewportH: o.h ?? 720 });
  g.sortie(loadout);
  g.state.player.pitch = 0;
  updateCamera(g.state, g.world);
  return g;
}

/** world point that projects to screen offset (sx, sy) [css px from the center, +y down] at camera depth `depth` */
function atScreen(g: Game, sx: number, sy: number, depth: number): V3 {
  const cam = g.state.camera;
  const scale = cam.viewportH / 2 / Math.tan((cam.fovYDeg * Math.PI) / 360);
  const p = addScaled(addScaled(addScaled(cam.pos, cam.forward, depth), cam.right, (sx / scale) * depth), cam.up, (-sy / scale) * depth);
  const sp = projectToScreen(cam, p);
  expect(sp.x).toBeCloseTo(sx, 6);
  expect(sp.y).toBeCloseTo(sy, 6);
  return p;
}

let idSeq = 0;
function addTarget(g: Game, pos: V3, opts: { id?: string; vel?: V3; radius?: number } = {}): EnemyState {
  const e = makeScriptedTarget(opts.id ?? `D${String(++idSeq).padStart(2, '0')}`, pos, opts.vel ?? { x: 0, y: 0, z: 0 }, opts.radius);
  g.state.enemies.push(e);
  return e;
}

function run(g: Game, ticks: number): void {
  for (let i = 0; i < ticks; i++) g.step();
}

/** move a scripted dummy instantly (test-side teleport: velocity stays 0) */
function teleport(e: EnemyState, p: V3): void {
  e.pos = { ...p };
  e.prevPos = { ...p };
}

const lockTicksOf = (g: Game): number => Math.ceil(g.state.stats.lockSeconds / DT - 1e-9);
const radiusOf = (fcs: FcsId, w: number, h: number): number => FCS_PARTS[fcs].radiusRatio * Math.min(w, h);
const state = (g: Game): GameState => g.state;

// ---------------------------------------------------------------------------
describe('FCS circle radius = ratio * D, D = min(viewport w, h)', () => {
  const ratios: [FcsId, number][] = [['wide', 0.3], ['medium', 0.2], ['narrow', 0.1]];
  const viewports: [number, number][] = [[1280, 720], [1920, 1080], [1000, 1200], [2560, 1080]];
  for (const [fcs, ratio] of ratios) {
    it(`${fcs}: ${ratio} D for every viewport, at creation, after a tick and after setViewport`, () => {
      for (const [w, h] of viewports) {
        const g = makeGame({ loadout: { fcs, generator: 'balanced', legs: 'biped' }, w, h });
        const d = Math.min(w, h);
        expect(state(g).lock.radiusCssPx).toBeCloseTo(ratio * d, 9);
        g.step();
        expect(state(g).lock.radiusCssPx).toBeCloseTo(ratio * d, 9);
      }
      const g = makeGame({ loadout: { fcs, generator: 'balanced', legs: 'biped' } });
      g.setViewport(1600, 900);
      expect(state(g).lock.radiusCssPx).toBeCloseTo(ratio * 900, 9);
      g.step();
      expect(state(g).lock.radiusCssPx).toBeCloseTo(ratio * 900, 9);
      g.setViewport(700, 1300);
      g.step();
      expect(state(g).lock.radiusCssPx).toBeCloseTo(ratio * 700, 9);
    });
  }
  it('the tested circle equals the drawn circle: a target 3 px inside locks, 3 px outside does not (all FCS, several angles)', () => {
    for (const fcs of ['wide', 'medium', 'narrow'] as FcsId[]) {
      const loadout: Loadout = { fcs, generator: 'balanced', legs: 'biped' };
      for (const ang of [0.05, 0.7, 1.6, 2.5, 3.1]) {
        // upper half-plane only (the arena floor would hide points far below the horizon)
        const R = state(makeGame({ loadout })).lock.radiusCssPx;
        const g = makeGame({ loadout });
        const inside = addTarget(g, atScreen(g, Math.cos(ang) * (R - 3), -Math.sin(ang) * (R - 3), 60));
        expect(isLockCandidate(state(g), g.world, inside)).toBe(true);
        g.step();
        expect(state(g).lock.state).toBe('acquiring');
        const g2 = makeGame({ loadout });
        const outside = addTarget(g2, atScreen(g2, Math.cos(ang) * (R + 3), -Math.sin(ang) * (R + 3), 60));
        expect(isLockCandidate(state(g2), g2.world, outside)).toBe(false);
        g2.step();
        expect(state(g2).lock.state).toBe('none');
      }
    }
  });
});

// ---------------------------------------------------------------------------
describe('lock time = base / leg lock-speed multiplier (2 legs 1.2/0.8/0.4 s, 4 legs / 1.5)', () => {
  const combos: [FcsId, LegsId, number][] = [
    ['wide', 'biped', 1.2],
    ['medium', 'biped', 0.8],
    ['narrow', 'biped', 0.4],
    ['wide', 'quadruped', 1.2 / 1.5],
    ['medium', 'quadruped', 0.8 / 1.5],
    ['narrow', 'quadruped', 0.4 / 1.5],
  ];
  for (const [fcs, legs, seconds] of combos) {
    it(`${fcs} / ${legs}: locks after ${seconds.toFixed(4)} s of continuous validity`, () => {
      const g = makeGame({ loadout: { fcs, generator: 'balanced', legs } });
      expect(state(g).stats.lockSeconds).toBeCloseTo(seconds, 12);
      expect(state(g).stats.lockSeconds).toBeCloseTo(FCS_PARTS[fcs].baseLockSeconds / LEGS_PARTS[legs].lockSpeedMult, 12);
      const t = addTarget(g, atScreen(g, 0, 0, 40));
      expect(state(g).lock.state).toBe('none'); // nothing happens before the first tick
      g.step();
      expect(state(g).lock.state).toBe('acquiring');
      expect(state(g).lock.targetId).toBe(t.id);
      expect(state(g).lock.progress).toBe(0); // first valid sample: 0 s of continuous validity
      const acquiredAt = state(g).time;
      let lockedAt = -1;
      let prev = 0;
      for (let i = 0; i < 400; i++) {
        g.step();
        const lk = state(g).lock;
        expect(lk.progress).toBeGreaterThanOrEqual(prev);
        prev = lk.progress;
        if (lk.state === 'locked') {
          lockedAt = state(g).time;
          break;
        }
        expect(lk.state).toBe('acquiring');
        expect(lk.progress).toBeCloseTo((state(g).time - acquiredAt) / seconds, 9); // progress display = elapsed / lockSeconds
      }
      expect(lockedAt).toBeGreaterThan(0);
      const took = lockedAt - acquiredAt;
      expect(took).toBeGreaterThanOrEqual(seconds - 1e-9); // never earlier than the spec time
      expect(took).toBeLessThan(seconds + DT); // and within one tick of it
      expect(state(g).lock.progress).toBe(1);
      expect(state(g).lock.targetId).toBe(t.id);
    });
  }
});

// ---------------------------------------------------------------------------
describe('lock candidates (SPEC §5)', () => {
  it('a centered, visible, in-range target is acquired', () => {
    const g = makeGame();
    const t = addTarget(g, atScreen(g, 0, 0, 40));
    expect(isLockCandidate(state(g), g.world, t)).toBe(true);
    g.step();
    expect(state(g).lock.targetId).toBe(t.id);
  });

  it('a target behind the camera is never acquired (projection is not in front)', () => {
    const g = makeGame();
    const cam = state(g).camera;
    const behind = addTarget(g, addScaled(cam.pos, cam.forward, -15));
    expect(projectToScreen(cam, behind.pos).inFront).toBe(false);
    run(g, 200);
    expect(state(g).lock.state).toBe('none');
    expect(isLockCandidate(state(g), g.world, behind)).toBe(false);
  });

  it('a target behind the player, further behind the camera, is not acquired either', () => {
    const g = makeGame();
    addTarget(g, { x: 1.4, y: 2.7, z: 60 });
    run(g, 200);
    expect(state(g).lock.state).toBe('none');
  });

  it('a target behind a wall is not acquired (camera AND muzzle both blocked)', () => {
    const wall = box('wall', { x: -50, y: 0, z: -21 }, { x: 50, y: 60, z: -19 });
    const g = makeGame({ boxes: [wall] });
    const t = addTarget(g, atScreen(g, 0, 0, 60));
    const s = state(g);
    expect(g.world.segmentBlocked(s.camera.pos, t.pos)).toBe(true);
    expect(g.world.segmentBlocked(playerMuzzlePosition(s.player), t.pos)).toBe(true);
    run(g, 200);
    expect(state(g).lock.state).toBe('none');
    expect(state(g).lock.targetId).toBeNull();
  });

  it('LOS is required from BOTH the camera and the muzzle', () => {
    // camera sees the target but a low slab blocks the muzzle (muzzle y 2.25, camera y 2.7)
    const lowSlab = box('low', { x: 0, y: 2.0, z: -12 }, { x: 3, y: 2.5, z: -10 });
    const g1 = makeGame({ boxes: [lowSlab] });
    const t1 = addTarget(g1, { x: 1.4, y: 2.7, z: -40 });
    const s1 = state(g1);
    expect(g1.world.segmentBlocked(s1.camera.pos, t1.pos)).toBe(false);
    expect(g1.world.segmentBlocked(playerMuzzlePosition(s1.player), t1.pos)).toBe(true);
    run(g1, 200);
    expect(state(g1).lock.state).toBe('none');
    expect(isLockCandidate(state(g1), g1.world, t1)).toBe(false);

    // muzzle sees the target but a slab at camera height blocks the camera ray
    const highSlab = box('high', { x: 1.0, y: 2.6, z: -12 }, { x: 1.8, y: 3.0, z: -10 });
    const g2 = makeGame({ boxes: [highSlab] });
    const t2 = addTarget(g2, { x: 1.4, y: 2.7, z: -40 });
    const s2 = state(g2);
    expect(g2.world.segmentBlocked(s2.camera.pos, t2.pos)).toBe(true);
    expect(g2.world.segmentBlocked(playerMuzzlePosition(s2.player), t2.pos)).toBe(false);
    run(g2, 200);
    expect(state(g2).lock.state).toBe('none');

    // control: no slab -> locks
    const g3 = makeGame();
    addTarget(g3, { x: 1.4, y: 2.7, z: -40 });
    run(g3, 200);
    expect(state(g3).lock.state).toBe('locked');
  });

  it('range: 120 m from the MUZZLE (121 m is not acquired, 119 m is)', () => {
    const at = (dist: number): V3 => {
      // point on the camera center ray whose muzzle distance is `dist`
      const g = makeGame();
      const cam = state(g).camera;
      const m = playerMuzzlePosition(state(g).player);
      const rel = sub(cam.pos, m);
      // |rel + f s|^2 = dist^2 -> s^2 + 2 (rel.f) s + |rel|^2 - dist^2 = 0
      const b = dot(rel, cam.forward);
      const c = dot(rel, rel) - dist * dist;
      const s = -b + Math.sqrt(b * b - c);
      return addScaled(cam.pos, cam.forward, s);
    };
    for (const [dist, expected] of [[119, true], [119.999, true], [120.5, false], [121, false], [150, false]] as [number, boolean][]) {
      const g = makeGame();
      const t = addTarget(g, at(dist));
      expect(distance(playerMuzzlePosition(state(g).player), t.pos)).toBeCloseTo(dist, 6);
      expect(isLockCandidate(state(g), g.world, t)).toBe(expected);
      run(g, 5);
      expect(state(g).lock.state === 'none').toBe(!expected);
    }
  });

  it('range tolerance is the 1e-9 of docs/ARCH.md §3: 120 m + 5e-10 is still in range, 120 m + 1e-7 (inside the old 1e-6 slack) is not', () => {
    const at = (dist: number): V3 => {
      const g = makeGame();
      const cam = state(g).camera;
      const m = playerMuzzlePosition(state(g).player);
      const rel = sub(cam.pos, m);
      const b = dot(rel, cam.forward);
      const c = dot(rel, rel) - dist * dist;
      return addScaled(cam.pos, cam.forward, -b + Math.sqrt(b * b - c));
    };
    for (const [dist, expected] of [[120 - 1e-7, true], [120, true], [120 + 5e-10, true], [120 + 1e-7, false], [120 + 5e-7, false]] as [number, boolean][]) {
      const g = makeGame();
      const t = addTarget(g, at(dist));
      expect(Math.abs(distance(playerMuzzlePosition(state(g).player), t.pos) - dist), `built at ${dist}`).toBeLessThan(2e-11);
      // no tick in between: the first tick settles the player onto the floor (~1e-5 m) which would move a borderline target
      expect(isLockCandidate(state(g), g.world, t), `${dist - 120}`).toBe(expected);
    }
  });

  it('a destroyed target is not acquired; destroying the locked target drops the lock at once', () => {
    const g = makeGame();
    const dead = addTarget(g, atScreen(g, 0, 0, 40));
    damageEnemy(state(g), dead, 1e9, 'beam');
    expect(dead.alive).toBe(false);
    run(g, 150);
    expect(state(g).lock.state).toBe('none');

    const g2 = makeGame();
    const t = addTarget(g2, atScreen(g2, 0, 0, 40));
    run(g2, lockTicksOf(g2) + 3);
    expect(state(g2).lock.state).toBe('locked');
    damageEnemy(state(g2), t, 1e9, 'beam');
    g2.step();
    expect(state(g2).lock.state).toBe('none');
    expect(state(g2).lock.targetId).toBeNull();
    expect(state(g2).lock.progress).toBe(0);
    expect(state(g2).fc.status).toBe('inactive');
  });
});

// ---------------------------------------------------------------------------
describe('target selection and persistence', () => {
  it('with no target the candidate closest to the screen center is chosen; equal distance -> lowest id (not array order)', () => {
    const g = makeGame();
    addTarget(g, atScreen(g, 60, 0, 50), { id: 'F01' });
    addTarget(g, atScreen(g, -25, 10, 50), { id: 'N01' });
    addTarget(g, atScreen(g, 0, -80, 50), { id: 'F02' });
    g.step();
    expect(state(g).lock.targetId).toBe('N01');

    const g2 = makeGame();
    addTarget(g2, atScreen(g2, 40, 0, 50), { id: 'G09' });
    addTarget(g2, atScreen(g2, -40, 0, 50), { id: 'G02' });
    addTarget(g2, atScreen(g2, 0, -40, 50), { id: 'G05' });
    g2.step();
    expect(state(g2).lock.targetId).toBe('G02');
  });

  it('a chosen target is kept while it stays valid, even when another enemy comes closer to the center', () => {
    const g = makeGame();
    const a = addTarget(g, atScreen(g, 70, 20, 50), { id: 'A' });
    g.step();
    expect(state(g).lock.targetId).toBe('A');
    const b = addTarget(g, atScreen(g, 0, 0, 50), { id: 'B' }); // dead center from now on
    run(g, 20);
    expect(state(g).lock.targetId).toBe('A');
    expect(state(g).lock.state).toBe('acquiring');
    run(g, lockTicksOf(g) + 5);
    expect(state(g).lock.state).toBe('locked'); // and still locked on A
    expect(state(g).lock.targetId).toBe('A');
    void a;
    void b;
  });

  it('leaving the circle discards target AND progress at once; the next target starts from 0', () => {
    const g = makeGame();
    const a = addTarget(g, atScreen(g, 0, 0, 50), { id: 'A' });
    const b = addTarget(g, atScreen(g, -100, 0, 50), { id: 'B' });
    g.step();
    expect(state(g).lock.targetId).toBe('A');
    run(g, 60);
    const before = state(g).lock.progress;
    expect(before).toBeGreaterThan(0.5);
    // A leaves the circle: on the very next update A is dropped and B (still valid) starts from 0
    teleport(a, atScreen(g, 500, 0, 50));
    g.step();
    expect(state(g).lock.targetId).toBe('B');
    expect(state(g).lock.progress).toBe(0);
    expect(state(g).lock.elapsed).toBe(0);
    expect(state(g).lock.state).toBe('acquiring');
    // A returns: it does NOT get its old progress back and B is kept
    teleport(a, atScreen(g, 0, 0, 50));
    run(g, 10);
    expect(state(g).lock.targetId).toBe('B');
    expect(state(g).lock.elapsed).toBeCloseTo(10 * DT, 9);
    void b;
  });

  it('a completed lock is dropped immediately when the target leaves the circle, and re-acquiring the same target restarts at 0', () => {
    const g = makeGame();
    const a = addTarget(g, atScreen(g, 0, 0, 50), { id: 'A' });
    run(g, lockTicksOf(g) + 3);
    expect(state(g).lock.state).toBe('locked');
    const home = { ...a.pos };
    teleport(a, atScreen(g, 400, 0, 50));
    g.step();
    expect(state(g).lock.state).toBe('none');
    expect(state(g).lock.targetId).toBeNull();
    expect(state(g).lock.progress).toBe(0);
    expect(state(g).fc.status).toBe('inactive');
    expect(state(g).fc.targetId).toBeNull();
    expect(state(g).fc.launchDirection).toBeNull();
    teleport(a, home);
    g.step();
    expect(state(g).lock.state).toBe('acquiring');
    expect(state(g).lock.progress).toBe(0);
    run(g, 10);
    expect(state(g).lock.progress).toBeCloseTo((10 * DT) / state(g).stats.lockSeconds, 9);
  });

  it('leaving range, being occluded, or falling behind the camera also drops the lock immediately', () => {
    const wall = box('wall', { x: -50, y: 0, z: -31 }, { x: 50, y: 60, z: -29 });
    const cases: [string, Opts, (a: EnemyState, g: Game) => void][] = [
      ['out of range', {}, (a, g) => teleport(a, atScreen(g, 0, 0, 200))],
      ['behind the camera', {}, (a, g) => teleport(a, addScaled(state(g).camera.pos, state(g).camera.forward, -20))],
      ['behind a wall', { boxes: [wall] }, (a) => teleport(a, { x: 1.4, y: 2.7, z: -80 })],
    ];
    for (const [name, opts, disturb] of cases) {
      const g = makeGame(opts);
      const a = addTarget(g, atScreen(g, 0, 0, 25), { id: 'A' }); // in front of the wall at z = -30
      run(g, lockTicksOf(g) + 3);
      expect(state(g).lock.state, name).toBe('locked');
      disturb(a, g);
      g.step();
      expect(state(g).lock.state, name).toBe('none');
      expect(state(g).lock.progress, name).toBe(0);
    }
  });

  it('switching weapons does not reset the target or the progress (acquiring and locked)', () => {
    const g = makeGame();
    const t = addTarget(g, atScreen(g, 0, 0, 50));
    run(g, 30);
    const p0 = state(g).lock.elapsed;
    g.input.weaponSelect = 'beam';
    g.step();
    expect(state(g).player.weapon).toBe('beam');
    expect(state(g).lock.targetId).toBe(t.id);
    expect(state(g).lock.elapsed).toBeCloseTo(p0 + DT, 9);
    g.input.weaponSelect = 'missile';
    g.step();
    expect(state(g).lock.elapsed).toBeCloseTo(p0 + 2 * DT, 9);
    g.input.weaponSelect = 'machinegun';
    run(g, lockTicksOf(g));
    expect(state(g).lock.state).toBe('locked');
    for (const w of ['beam', 'missile', 'machinegun', 'beam'] as const) {
      g.input.weaponSelect = w;
      g.step();
      expect(state(g).lock.state).toBe('locked');
      expect(state(g).lock.targetId).toBe(t.id);
      expect(state(g).lock.progress).toBe(1);
      expect(state(g).fc.weapon).toBe(w);
      expect(state(g).fc.status).toBe('solved'); // no second lock time is required after a switch
    }
  });

  it('only the target CENTER counts: a corrected aim point far outside the circle does not break the lock', () => {
    const g = makeGame();
    const R = state(g).lock.radiusCssPx;
    const t = addTarget(g, atScreen(g, 0, -(R - 8), 100)); // near the top rim of the circle at ~100 m
    run(g, 3); // let the player settle on the floor first
    const camBefore = JSON.stringify(state(g).camera);
    run(g, lockTicksOf(g) + 5);
    const s = state(g);
    expect(s.lock.state).toBe('locked');
    expect(s.fc.status).toBe('solved');
    const aim = projectToScreen(s.camera, s.fc.aimPoint as V3);
    const hit = projectToScreen(s.camera, s.fc.predictedInterceptPosition as V3);
    expect(Math.hypot(aim.x, aim.y)).toBeGreaterThan(R); // the corrected aim point is outside the FCS circle
    expect(aim.y).toBeLessThan(hit.y); // and above the predicted hit point (gravity compensation)
    expect(Math.hypot(hit.x, hit.y)).toBeLessThan(R); // the predicted hit point of a static target is the target itself
    expect(JSON.stringify(s.camera)).toBe(camBefore); // the camera is never turned toward the correction
    expect(s.lock.targetId).toBe(t.id);
    run(g, 60);
    expect(state(g).lock.state).toBe('locked');
  });

  it('also a PREDICTED hit point beyond 120 m does not break a valid lock', () => {
    // target ~110 m ahead, then receding at 20 m/s: the intercept lies beyond 120 m while the current position is still valid
    const g = makeGame();
    const t = addTarget(g, atScreen(g, 0, 0, 120));
    run(g, lockTicksOf(g) + 3);
    expect(state(g).lock.state).toBe('locked');
    t.vel = { x: 0, y: 0, z: -20 };
    g.step();
    const m = playerMuzzlePosition(state(g).player);
    expect(distance(m, t.pos)).toBeLessThan(120);
    expect(state(g).lock.state).toBe('locked');
    expect(state(g).fc.status).toBe('solved');
    expect(distance(m, state(g).fc.predictedInterceptPosition as V3)).toBeGreaterThan(120);
  });

  it('resize: the circle follows the viewport, and a target that was inside can fall outside purely because of the resize', () => {
    const g = makeGame({ w: 1280, h: 720 });
    const t = addTarget(g, atScreen(g, 130, 0, 60)); // inside the 144 px circle
    run(g, 5);
    expect(state(g).lock.targetId).toBe(t.id);
    // narrower window: D = 600 -> radius 120 px; the target still projects at 130 px (height unchanged) -> outside
    g.setViewport(600, 720);
    expect(state(g).lock.radiusCssPx).toBeCloseTo(120, 9);
    expect(state(g).camera.viewportW).toBe(600);
    g.step();
    expect(state(g).lock.radiusCssPx).toBeCloseTo(120, 9);
    expect(state(g).lock.state).toBe('none');
    // wider/taller window: radius 216 px and the projection scale grows with the height too
    g.setViewport(1920, 1080);
    g.step();
    expect(state(g).lock.radiusCssPx).toBeCloseTo(0.2 * 1080, 9);
    const sp = projectToScreen(state(g).camera, t.pos);
    expect(Math.hypot(sp.x, sp.y)).toBeLessThan(state(g).lock.radiusCssPx);
    expect(state(g).lock.targetId).toBe(t.id);
  });

  it('the progress display is time-based and pausing does not advance it', () => {
    const g = makeGame();
    addTarget(g, atScreen(g, 0, 0, 40));
    g.step();
    run(g, 48); // 0.4 s of 0.8 s
    expect(state(g).lock.state).toBe('acquiring');
    expect(state(g).lock.progress).toBeCloseTo(0.5, 9);
    expect(state(g).fc.status).toBe('inactive'); // no correction is shown before the lock completes
    expect(state(g).fc.launchDirection).toBeNull();
    expect(state(g).fc.aimPoint).toBeNull();
    g.pause();
    const frozen = JSON.stringify(state(g).lock);
    expect(g.advance(2)).toBe(0);
    g.step(); // paused: no update at all
    expect(JSON.stringify(state(g).lock)).toBe(frozen);
    g.resume();
    run(g, 1);
    expect(state(g).lock.progress).toBeCloseTo(0.5 + DT / 0.8, 9);
  });

  it('revalidateLock does not advance progress, and drops an invalid target immediately', () => {
    const g = makeGame();
    const t = addTarget(g, atScreen(g, 0, 0, 40));
    g.step();
    const s = state(g);
    expect(revalidateLock(s, g.world)).toBe(false); // acquiring is not a lock
    expect(s.lock.progress).toBe(0);
    run(g, lockTicksOf(g) + 1);
    expect(revalidateLock(s, g.world)).toBe(true);
    expect(s.lock.elapsed).toBeGreaterThanOrEqual(state(g).stats.lockSeconds - 1e-9);
    const e = s.lock.elapsed;
    expect(revalidateLock(s, g.world)).toBe(true);
    expect(s.lock.elapsed).toBe(e);
    teleport(t, atScreen(g, 600, 0, 40));
    expect(revalidateLock(s, g.world)).toBe(false);
    expect(s.lock.state).toBe('none');
    expect(s.lock.targetId).toBeNull();
  });

  it('the snapshot exposes the same lock / fire-control state (single source)', () => {
    const g = makeGame();
    const t = addTarget(g, atScreen(g, 10, 10, 60));
    run(g, lockTicksOf(g) + 3);
    const snap = buildSnapshot(state(g));
    expect(snap.lock.state).toBe('locked');
    expect(snap.lock.targetId).toBe(t.id);
    expect(snap.lock.progress).toBe(1);
    expect(snap.lock.radiusCssPx).toBeCloseTo(144, 9);
    expect(snap.fireControl.status).toBe('solved');
    expect(snap.fireControl.targetId).toBe(t.id);
    expect(snap.fireControl.evaluatedAtSeconds).toBeCloseTo(state(g).time, 12);
    expect(snap.fireControl.launchDirection).toEqual([state(g).fc.launchDirection!.x, state(g).fc.launchDirection!.y, state(g).fc.launchDirection!.z]);
  });
});

// ---------------------------------------------------------------------------
// Game.look() moves the yaw-frame muzzle between two ticks: refreshFireSolution keeps state.fc (HUD / snapshot solution) equal to what a
// shot would compute right now, without touching the lock (no progress, no validation, no drop).
// ---------------------------------------------------------------------------
describe('refreshFireSolution / Game.look() keep the HUD solution as fresh as the real shot', () => {
  const lockedGame = (weapon: WeaponId, targetPos?: (g: Game) => V3, vel: V3 = { x: 0, y: 0, z: 0 }): { g: Game; t: EnemyState } => {
    const g = makeGame();
    g.state.player.weapon = weapon;
    const t = addTarget(g, targetPos ? targetPos(g) : atScreen(g, 0, 0, 60), { vel });
    run(g, lockTicksOf(g) + 3);
    expect(state(g).lock.state).toBe('locked');
    expect(state(g).fc.status).toBe('solved');
    expect(state(g).fc.weapon).toBe(weapon);
    return { g, t };
  };
  /** distance between two unit vectors (acos of a dot product cannot resolve differences below ~1e-8 rad) */
  const angle = (a: V3, b: V3): number => distance(a, b);

  for (const weapon of ['machinegun', 'beam', 'missile'] as WeaponId[]) {
    it(`${weapon}: after look() state.fc is the solution of the CURRENT muzzle/target (same computeFireSolution), evaluated at state.time`, () => {
      const { g, t } = lockedGame(weapon, undefined, { x: 3, y: 1, z: -2 });
      const s = state(g);
      const before = JSON.stringify(s.fc);
      const lockBefore = JSON.stringify(s.lock);
      g.look(37, -9); // mouse move inside the frame: yaw and pitch change, no tick runs
      const m = playerMuzzlePosition(s.player);
      expect(JSON.stringify(s.fc), 'the solution changed with the muzzle').not.toBe(before);
      expect(distance(s.fc.muzzlePosition as V3, m)).toBeLessThan(1e-12);
      expect(s.fc.evaluatedAtSeconds).toBe(s.time);
      const ref = computeFireSolution(s, g.world, weapon, t, m);
      expect(ref.status).toBe('solved');
      expect(s.fc.status).toBe('solved');
      expect(angle(s.fc.launchDirection as V3, ref.launchDirection as V3)).toBeLessThan(1e-12);
      expect(distance(s.fc.aimPoint as V3, ref.aimPoint as V3)).toBeLessThan(1e-9);
      expect(s.fc.predictedFlightSeconds).toBeCloseTo(ref.predictedFlightSeconds as number, 12);
      expect(JSON.stringify(s.lock), 'the lock (target, progress, elapsed) is untouched').toBe(lockBefore);
    });
  }

  it('the next shot uses exactly the direction the refreshed HUD solution showed (mouse look right before the trigger)', () => {
    const { g } = lockedGame('machinegun', undefined, { x: 4, y: 0, z: 0 });
    const s = state(g);
    g.look(23, 5);
    const hud = s.fc.launchDirection as V3;
    const hudMuzzle = s.fc.muzzlePosition as V3;
    g.input.fire = true;
    g.step();
    g.input.fire = false;
    expect(s.shots.length).toBe(1);
    expect(angle(s.shots[0].launchDirection, hud)).toBeLessThan(1e-12);
    expect(distance(s.shots[0].muzzlePosition, hudMuzzle)).toBeLessThan(1e-12);
  });

  it('look() before the lock completes leaves state.fc inactive and the progress alone', () => {
    const g = makeGame();
    const t = addTarget(g, atScreen(g, 0, 0, 60));
    run(g, 20);
    const s = state(g);
    expect(s.lock.state).toBe('acquiring');
    const lock = JSON.stringify(s.lock);
    g.look(30, 0);
    expect(s.fc.status).toBe('inactive');
    expect(s.fc.launchDirection).toBeNull();
    expect(s.fc.targetId).toBeNull();
    expect(JSON.stringify(s.lock)).toBe(lock);
    expect(s.lock.targetId).toBe(t.id);
  });

  it('look() does not validate or drop the lock: a target swung out of the circle keeps its (refreshed) solution until the next tick, which then drops both', () => {
    const { g, t } = lockedGame('machinegun');
    const s = state(g);
    g.look(600, 0); // ~1.3 rad: the target is far outside the FCS circle
    expect(s.lock.state).toBe('locked');
    expect(s.lock.targetId).toBe(t.id);
    expect(s.lock.progress).toBe(1);
    expect(s.fc.status).toBe('solved');
    expect(s.fc.targetId).toBe(t.id);
    expect(distance(s.fc.muzzlePosition as V3, playerMuzzlePosition(s.player))).toBeLessThan(1e-12);
    g.step(); // updateFcs (end of tick) is the one that validates
    expect(s.lock.state).toBe('none');
    expect(s.lock.targetId).toBeNull();
    expect(s.fc.status).toBe('inactive');
  });

  it('a destroyed target is not recomputed (refresh needs a lock-complete AND alive target): state.fc is left as it was', () => {
    const { g, t } = lockedGame('machinegun');
    const s = state(g);
    damageEnemy(s, t, 1e9, 'beam');
    expect(t.alive).toBe(false);
    const fc = JSON.stringify(s.fc);
    const lock = JSON.stringify(s.lock);
    g.look(12, 3);
    expect(JSON.stringify(s.fc)).toBe(fc);
    expect(JSON.stringify(s.lock)).toBe(lock);
    g.step();
    expect(s.lock.state).toBe('none');
    expect(s.fc.status).toBe('inactive');
  });

  it('direct calls: no-op without a lock or with a stale id; it never changes lock.progress / elapsed', () => {
    const g = makeGame();
    const s = state(g);
    refreshFireSolution(s, g.world);
    expect(s.fc.status).toBe('inactive');
    const t = addTarget(g, atScreen(g, 0, 0, 60));
    run(g, lockTicksOf(g) + 3);
    expect(s.lock.state).toBe('locked');
    const elapsed = s.lock.elapsed;
    const progress = s.lock.progress;
    refreshFireSolution(s, g.world);
    refreshFireSolution(s, g.world);
    expect(s.lock.elapsed).toBe(elapsed);
    expect(s.lock.progress).toBe(progress);
    s.lock.targetId = 'nobody';
    const fc = JSON.stringify(s.fc);
    refreshFireSolution(s, g.world);
    expect(JSON.stringify(s.fc)).toBe(fc);
    void t;
  });

  it('look() outside of the playing mode changes nothing (unchanged behaviour)', () => {
    const { g } = lockedGame('machinegun');
    g.pause();
    const fc = JSON.stringify(state(g).fc);
    const yaw = state(g).player.yaw;
    g.look(50, 50);
    expect(state(g).player.yaw).toBe(yaw);
    expect(JSON.stringify(state(g).fc)).toBe(fc);
  });
});
