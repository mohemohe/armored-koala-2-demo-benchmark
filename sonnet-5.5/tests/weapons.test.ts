/**
 * SPEC §4 weapon behaviour on the real Game: ammo / EN accounting, refusals, fire intervals across weapon switches,
 * muzzle-vs-camera occlusion, lock-vs-trajectory occlusion, MG ammo total, the recentPlayerShots ring, no_solution,
 * beam range/first-hit, missile guidance rules and the swept projectile collision. Targets are scripted dummies (no AI).
 */
import { describe, expect, it } from 'vitest';
import { CAMERA, LIMITS, PLAYER, SIM, WEAPONS } from '../src/config';
import { buildSnapshot } from '../src/sim/bench';
import { computeAimPoint, freeFireDirection, playerMuzzlePosition, updateCamera } from '../src/sim/camera';
import { damageEnemy } from '../src/sim/combat';
import { Game } from '../src/sim/game';
import { firstSphereContact } from '../src/sim/projectiles';
import { makeScriptedTarget } from '../src/sim/scenario';
import { buildTestArenaStage } from '../src/sim/testArena';
import type { BoxDef, EnemyState, GameEvent, GameState, Loadout, Missile, PlayerBullet, V3 } from '../src/sim/types';

const DT = SIM.DT;
const v3 = (x: number, y: number, z: number): V3 => ({ x, y, z });
const sub = (a: V3, b: V3): V3 => v3(a.x - b.x, a.y - b.y, a.z - b.z);
const len = (a: V3): number => Math.hypot(a.x, a.y, a.z);
const dot = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const unit = (a: V3): V3 => {
  const l = len(a);
  return v3(a.x / l, a.y / l, a.z / l);
};
const angle = (a: V3, b: V3): number => Math.acos(Math.max(-1, Math.min(1, dot(unit(a), unit(b)))));
const box = (id: string, min: V3, max: V3): BoxDef => ({ id, min, max, mat: 'metal', sectorId: 'T00' });

interface Opts {
  loadout?: Loadout;
  boxes?: BoxDef[];
  /** boxes that exist but start disabled (switched on later through IWorld.setBoxEnabled) */
  pitch?: number;
}

/** playing Game on the flat arena; player at the origin facing -Z with a level camera (camera (1.4, 2.7, 8.5), muzzle (1.05, 2.25, -1.25)) */
function makeGame(o: Opts = {}): Game {
  const stage = buildTestArenaStage();
  stage.boxes.push(...(o.boxes ?? []));
  const loadout = o.loadout ?? { fcs: 'medium', generator: 'balanced', legs: 'biped' };
  const g = new Game({ stage, loadout });
  g.sortie(loadout);
  g.state.player.pitch = o.pitch ?? 0;
  updateCamera(g.state, g.world);
  return g;
}

const S = (g: Game): GameState => g.state;
let idSeq = 0;
function addTarget(g: Game, pos: V3, vel: V3 = v3(0, 0, 0), id?: string, radius?: number): EnemyState {
  const e = makeScriptedTarget(id ?? `D${String(++idSeq).padStart(2, '0')}`, pos, vel, radius);
  g.state.enemies.push(e);
  return e;
}
const run = (g: Game, n: number): void => {
  for (let i = 0; i < n; i++) g.step();
};
/** target on the camera's center line: it projects to the exact screen center (camera x = 1.4, y = 2.7) */
const onAxis = (z: number): V3 => v3(1.4, 2.7, z);
const lockTicks = (g: Game): number => Math.ceil(S(g).stats.lockSeconds / DT - 1e-9);
/** step until the FCS lock is complete (target must be a valid candidate) */
function lockOn(g: Game): void {
  run(g, lockTicks(g) + 2);
  expect(S(g).lock.state).toBe('locked');
}
const evs = <T extends GameEvent['type']>(g: Game, type: T): Extract<GameEvent, { type: T }>[] =>
  S(g).events.filter((e): e is Extract<GameEvent, { type: T }> => e.type === type);
const clearEvents = (g: Game): void => {
  g.drainEvents();
};
/** one tick with the trigger held */
function pull(g: Game, ticks = 1): void {
  g.input.fire = true;
  run(g, ticks);
  g.input.fire = false;
}
function select(g: Game, w: 'machinegun' | 'beam' | 'missile'): void {
  g.input.weaponSelect = w;
}

// ---------------------------------------------------------------------------
describe('ammo / EN are spent only when a shot is actually fired', () => {
  it('machinegun: 1 round per shot, one shot every 0.1 s while held, nothing without the trigger', () => {
    const g = makeGame();
    run(g, 30);
    expect(S(g).player.ammo.machinegun).toBe(300);
    expect(S(g).shots.length).toBe(0);
    pull(g, 120); // 1.0 s held: shots at 0.0, 0.1 ... 0.9 s after the press
    expect(S(g).player.ammo.machinegun).toBe(290);
    expect(S(g).shots.length).toBe(10);
    for (let i = 1; i < 10; i++) {
      expect(S(g).shots[i].firedAtSeconds - S(g).shots[i - 1].firedAtSeconds).toBeCloseTo(WEAPONS.machinegun.interval, 9);
    }
    // MG spends no EN
    expect(S(g).player.en).toBe(S(g).stats.maxEn);
    expect(S(g).player.mv.lastEnSpentAt).toBeNull();
  });

  it('a new bullet advances exactly one tick in its spawn tick (no extra frame) from the MUZZLE', () => {
    const g = makeGame();
    run(g, 5);
    const m = playerMuzzlePosition(S(g).player);
    pull(g, 1);
    const b = S(g).bullets[0];
    expect(b.age).toBeCloseTo(DT, 12);
    expect(len(sub(b.origin, m))).toBeLessThan(1e-12);
    const expected = v3(m.x + b.v0.x * DT, m.y + b.v0.y * DT - 0.5 * 18 * DT * DT, m.z + b.v0.z * DT);
    expect(len(sub(b.pos, expected))).toBeLessThan(1e-9);
    // the player's own velocity is never added: v0 has speed 100 exactly
    expect(len(b.v0)).toBeCloseTo(100, 9);
  });

  it('beam: 8 EN per shot, interval 0.25 s, EN recorded as spent at the shot time', () => {
    const g = makeGame();
    select(g, 'beam');
    run(g, 10);
    pull(g, 108); // shots at 0, 0.25, 0.5, 0.75 s
    expect(S(g).shots.length).toBe(4);
    expect(S(g).player.en).toBeCloseTo(S(g).stats.maxEn - 32, 9);
    expect(S(g).player.mv.lastEnSpentAt).toBeCloseTo(S(g).shots[3].firedAtSeconds, 12);
    expect(S(g).player.ammo.machinegun).toBe(300); // no ammo spent
    for (let i = 1; i < 4; i++) expect(S(g).shots[i].firedAtSeconds - S(g).shots[i - 1].firedAtSeconds).toBeCloseTo(0.25, 9);
  });

  it('beam with EN < 8 does not fire: EN, next-fire time, EN-spent time and shots are unchanged; a notice is raised', () => {
    const g = makeGame();
    select(g, 'beam');
    run(g, 2);
    const s = S(g);
    s.player.en = 7.999;
    s.player.mv.lastEnSpentAt = s.time; // no regeneration during this test
    const next = s.player.nextFireAt.beam;
    clearEvents(g);
    pull(g, 20);
    expect(S(g).player.en).toBe(7.999);
    expect(S(g).player.nextFireAt.beam).toBe(next);
    expect(S(g).player.mv.lastEnSpentAt).toBeCloseTo(2 * DT, 12);
    expect(S(g).shots.length).toBe(0);
    expect(evs(g, 'beamFire').length).toBe(0);
    expect(S(g).notices.noEnAt).not.toBeNull();
    expect(evs(g, 'notice').filter((e) => e.kind === 'noEn').length).toBe(1); // once per refusal streak, not per tick
    // exactly 8 EN is enough, and pays everything
    S(g).player.en = 8;
    S(g).player.mv.lastEnSpentAt = S(g).time;
    pull(g, 1);
    expect(S(g).shots.length).toBe(1);
    expect(S(g).player.en).toBe(0);
  });

  it('missile without a completed lock is refused: no missile, no ammo spent, no timer change, noLock notice', () => {
    const g = makeGame();
    select(g, 'missile');
    run(g, 2);
    clearEvents(g);
    pull(g, 10); // no target at all
    expect(S(g).missiles.length).toBe(0);
    expect(S(g).player.ammo.missile).toBe(12);
    expect(S(g).player.nextFireAt.missile).toBe(0);
    expect(S(g).shots.length).toBe(0);
    expect(S(g).notices.noLockAt).not.toBeNull();
    expect(evs(g, 'notice').filter((e) => e.kind === 'noLock').length).toBe(1);
    // acquiring (not yet complete) is refused too
    const g2 = makeGame();
    select(g2, 'missile');
    addTarget(g2, onAxis(-50));
    run(g2, 20);
    expect(S(g2).lock.state).toBe('acquiring');
    pull(g2, 5);
    expect(S(g2).missiles.length).toBe(0);
    expect(S(g2).player.ammo.missile).toBe(12);
    expect(S(g2).shots.length).toBe(0);
  });

  it('missile with a completed lock fires; a lock that has become invalid by the shot tick is refused (stale lock never used)', () => {
    const g = makeGame();
    select(g, 'missile');
    const t = addTarget(g, onAxis(-50));
    lockOn(g);
    pull(g, 1);
    expect(S(g).missiles.length).toBe(1);
    expect(S(g).player.ammo.missile).toBe(11);
    expect(S(g).player.nextFireAt.missile).toBeCloseTo(S(g).shots[0].firedAtSeconds + 1, 12);
    const ms = S(g).missiles[0];
    expect(ms.targetId).toBe(t.id);
    expect(ms.lastSeenAt).toBeCloseTo(S(g).shots[0].firedAtSeconds, 12);
    expect(len(sub(ms.lastSeenPos, t.pos))).toBeLessThan(1e-9);
    expect(len(ms.vel)).toBeCloseTo(45, 9);
    // spawn tick advances the missile by exactly dt * 45
    expect(len(sub(ms.pos, S(g).shots[0].muzzlePosition))).toBeCloseTo(45 * DT, 6);
    expect(S(g).shots[0].initialVelocity).not.toBeNull();

    // stale-lock refusal: lock complete, then the target leaves the circle BEFORE the shot tick
    const g2 = makeGame();
    select(g2, 'missile');
    const t2 = addTarget(g2, onAxis(-50));
    lockOn(g2);
    t2.pos = v3(60, 2.7, -50);
    t2.prevPos = { ...t2.pos };
    pull(g2, 1);
    expect(S(g2).missiles.length).toBe(0);
    expect(S(g2).player.ammo.missile).toBe(12);
    expect(S(g2).lock.state).toBe('none');
    expect(S(g2).notices.noLockAt).not.toBeNull();
  });

  it('missile: 12 rounds in total, then a noAmmo refusal (interval 1.0 s)', () => {
    const g = makeGame();
    select(g, 'missile');
    addTarget(g, onAxis(-40));
    lockOn(g);
    pull(g, 12 * 120 + 30);
    expect(S(g).player.ammo.missile).toBe(0);
    expect(S(g).shots.filter((s) => s.weapon === 'missile').length).toBe(12);
    expect(S(g).notices.noAmmoAt).not.toBeNull();
    expect(S(g).missiles.length <= 1).toBe(true);
    for (let i = 1; i < 12; i++) expect(S(g).shots[i].firedAtSeconds - S(g).shots[i - 1].firedAtSeconds).toBeCloseTo(1, 9);
  });

  it('machinegun: exactly 300 rounds in total; empty -> no bullet, noAmmo; the beam still works', () => {
    const g = makeGame();
    pull(g, 3600 + 60);
    expect(S(g).player.ammo.machinegun).toBe(0);
    expect(S(g).shotSeq).toBe(300);
    expect(S(g).nextProjectileId - 1).toBe(300);
    expect(S(g).notices.noAmmoAt).not.toBeNull();
    expect(evs(g, 'notice').filter((e) => e.kind === 'noAmmo').length).toBeGreaterThanOrEqual(1);
    const seq = S(g).shotSeq;
    pull(g, 30);
    expect(S(g).shotSeq).toBe(seq);
    expect(S(g).player.ammo.machinegun).toBe(0);
    select(g, 'beam');
    pull(g, 1);
    expect(S(g).shotSeq).toBe(seq + 1);
  });
});

// ---------------------------------------------------------------------------
describe('fire interval survives weapon switches', () => {
  it('each weapon keeps its own next-fire time; switching neither resets nor grants an early shot', () => {
    const g = makeGame();
    g.input.fire = true;
    const plan: Record<number, 'machinegun' | 'beam' | 'missile'> = { 3: 'beam', 5: 'machinegun', 20: 'beam' };
    for (let tick = 0; tick < 40; tick++) {
      if (plan[tick]) select(g, plan[tick]);
      g.step();
    }
    g.input.fire = false;
    const log = S(g).shots.map((s) => `${s.weapon}@${Math.round(s.firedAtSeconds / DT)}`);
    // mg 0 | switch to beam at 3 -> beam ready at once | back to mg at 5: mg not ready until 12 | beam again at 20: not ready until 33
    expect(log).toEqual(['machinegun@0', 'beam@3', 'machinegun@12', 'beam@33']);
    // amounts follow the shots only
    expect(S(g).player.ammo.machinegun).toBe(298);
    expect(S(g).player.en).toBeCloseTo(S(g).stats.maxEn - 16, 9);
  });

  it('a weapon switch does not spend EN / ammo and does not reset the lock', () => {
    const g = makeGame();
    addTarget(g, onAxis(-50));
    lockOn(g);
    const en = S(g).player.en;
    for (const w of ['beam', 'missile', 'machinegun'] as const) {
      select(g, w);
      g.step();
      expect(S(g).player.weapon).toBe(w);
      expect(S(g).player.en).toBe(en);
      expect(S(g).lock.state).toBe('locked');
    }
    expect(S(g).player.ammo).toEqual({ machinegun: 300, missile: 12 });
  });
});

// ---------------------------------------------------------------------------
describe('muzzle-based shooting (SPEC §4.5): the camera may see what the muzzle cannot', () => {
  // low slab: between the muzzle line (y 2.25..2.7) and below the camera ray (y 2.7)
  const slab = box('slab', v3(0, 2.1, -10), v3(3, 2.5, -8));

  it('free-fire machinegun aims at the camera-center point but is stopped by the slab in front of the muzzle', () => {
    const g = makeGame({ boxes: [slab] });
    const t = addTarget(g, onAxis(-40));
    const cam = S(g).camera;
    const m = playerMuzzlePosition(S(g).player);
    expect(g.world.segmentBlocked(cam.pos, t.pos)).toBe(false); // camera sees the enemy ...
    expect(g.world.segmentBlocked(m, t.pos)).toBe(true); // ... the muzzle does not
    run(g, 150);
    expect(S(g).lock.state).toBe('none'); // no lock through the slab
    clearEvents(g);
    const mShot = playerMuzzlePosition(S(g).player);
    pull(g, 1);
    const rec = S(g).shots[0];
    expect(rec.solutionStatus).toBe('inactive');
    expect(rec.targetId).toBeNull();
    expect(rec.targetPositionAtFire).toBeNull();
    expect(rec.targetVelocityAtFire).toBeNull();
    expect(rec.predictedFlightSeconds).toBeNull();
    expect(rec.predictedInterceptPosition).toBeNull();
    // launched from the muzzle toward the point where the camera ray meets the enemy (front surface at z = -39.5)
    const aim = v3(1.4, 2.7, -39.5);
    expect(len(sub(rec.launchDirection, unit(sub(aim, rec.muzzlePosition))))).toBeLessThan(1e-5); // (camera rests 4e-5 m lower on the floor)
    expect(len(sub(rec.muzzlePosition, mShot))).toBeLessThan(1e-12); // the muzzle at the shot time, not the camera
    expect(len(rec.initialVelocity as V3)).toBeCloseTo(100, 9);
    run(g, 60);
    const hits = evs(g, 'hit');
    expect(hits.length).toBe(1);
    expect(hits[0].on).toBe('world');
    expect(hits[0].pos.z).toBeGreaterThan(-8.5); // stopped at the slab face z = -8, not at the enemy
    expect(hits[0].pos.z).toBeLessThan(-7.5);
    expect(t.hp).toBe(1e6);
    // the beam is stopped by the same slab
    select(g, 'beam');
    clearEvents(g);
    pull(g, 1);
    const bf = evs(g, 'beamFire')[0];
    expect(bf.hit).toBe('world');
    expect(bf.end.z).toBeCloseTo(-8, 3);
    expect(t.hp).toBe(1e6);
  });

  it('a wall right in front of the muzzle (muzzle inside it) swallows the shot at once; the shot never starts on the far side', () => {
    const wall = box('front', v3(-10, 0, -2.2), v3(10, 10, -1.0)); // muzzle z = -1.25 is inside
    const g = makeGame({ boxes: [wall] });
    const t = addTarget(g, onAxis(-40));
    run(g, 5);
    clearEvents(g);
    pull(g, 1);
    expect(S(g).bullets.length).toBe(0); // dead in its spawn tick
    const hits = evs(g, 'hit');
    expect(hits.length).toBe(1);
    expect(hits[0].on).toBe('world');
    expect(S(g).shots.length).toBe(1);
    expect(t.hp).toBe(1e6);
    select(g, 'beam');
    clearEvents(g);
    pull(g, 1);
    expect(evs(g, 'beamFire')[0].hit).toBe('world');
    expect(t.hp).toBe(1e6);
  });
});

// ---------------------------------------------------------------------------
// A wall on the segment body centre -> muzzle. The muzzle is a fixed yaw-frame offset (1.25 m forward, 1.05 m right) while the body
// half-width is 0.8 m, so a wall thinner than the offset pressed against the body ends up BEHIND the muzzle. SPEC §4.5: the shot
// starts at the muzzle and must not pass a wall in front of it / the launch point is never moved to the far side. Adopted reading
// (sim-fix): the wall is the first collision, whether or not the lock corrects the shot. The shot still counts as fired.
// ---------------------------------------------------------------------------
describe('a wall between the body centre and the muzzle stops the shot (SPEC §4.5, §4.2)', () => {
  /** yaw-frame rectangle (right r0..r1, forward f0..f1, height y0..y1) as a world AABB for yaw a multiple of 90 degrees */
  const localBox = (id: string, yaw: number, r: [number, number], f: [number, number], y: [number, number]): BoxDef => {
    const fw = { x: -Math.sin(yaw), z: -Math.cos(yaw) };
    const rt = { x: Math.cos(yaw), z: -Math.sin(yaw) };
    const pt = (rr: number, ff: number): [number, number] => [rr * rt.x + ff * fw.x, rr * rt.z + ff * fw.z];
    const a = pt(r[0], f[0]);
    const b = pt(r[1], f[1]);
    return box(id, v3(Math.min(a[0], b[0]), y[0], Math.min(a[1], b[1])), v3(Math.max(a[0], b[0]), y[1], Math.max(a[1], b[1])));
  };
  const gameWith = (boxes: BoxDef[], weapon: 'machinegun' | 'beam' | 'missile', yaw = 0): Game => {
    const g = makeGame({ boxes });
    g.state.player.weapon = weapon;
    g.state.player.yaw = yaw;
    updateCamera(g.state, g.world);
    return g;
  };
  /** target on the camera center line (camera and muzzle both see it past a small plate) */
  const targetAhead = (g: Game): EnemyState => {
    const cam = S(g).camera;
    return addTarget(g, v3(cam.pos.x + cam.forward.x * 48, cam.pos.y + cam.forward.y * 48, cam.pos.z + cam.forward.z * 48));
  };
  const hpLoss = (t: EnemyState): number => 1e6 - t.hp;
  const beamEnd = (g: Game): Extract<GameEvent, { type: 'beamFire' }> => evs(g, 'beamFire')[0];

  // small plates: the camera and the muzzle still see the target beside them (lock possible), yet the plate sits between body and muzzle
  const frontPlate = (yaw: number): BoxDef => localBox('plate', yaw, [-0.5, 1.2], [0.8, 1.1], [0, 10]); // 0.30 m thick, pressed on the front
  const sidePlate = (yaw: number): BoxDef => localBox('plate', yaw, [0.8, 0.95], [-1.5, 1.5], [0, 10]); // 0.15 m thick, pressed on the right

  for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    for (const [name, plate] of [['front', frontPlate], ['right side', sidePlate]] as const) {
      it(`beam, yaw ${((yaw * 180) / Math.PI).toFixed(0)}: a thin ${name} wall ends the beam at the wall (hit=world), nobody behind it is hurt, EN / timer / record are spent normally`, () => {
        const g = gameWith([plate(yaw)], 'beam', yaw);
        const t = targetAhead(g);
        run(g, 5);
        const en0 = S(g).player.en;
        const m = playerMuzzlePosition(S(g).player);
        const c = { ...S(g).player.pos };
        clearEvents(g);
        pull(g, 1);
        const bf = beamEnd(g);
        expect(bf.hit).toBe('world');
        expect(bf.targetId).toBeNull();
        expect(len(sub(bf.origin, m))).toBeLessThan(1e-12); // launch point = the real muzzle, never moved
        // the end lies on the body -> muzzle segment (before the muzzle), i.e. inside the 1.8 m offset
        const toEnd = sub(bf.end, c);
        const toMuzzle = sub(m, c);
        expect(len(toEnd)).toBeLessThan(len(toMuzzle));
        expect(len(sub(unit(toEnd), unit(toMuzzle)))).toBeLessThan(1e-9); // same direction (acos would only resolve ~1e-8)
        expect(hpLoss(t)).toBe(0);
        const hit = evs(g, 'hit');
        expect(hit.length).toBe(1);
        expect(hit[0].on).toBe('world');
        expect(hit[0].weapon).toBe('beam');
        expect(len(sub(hit[0].pos, bf.end))).toBeLessThan(1e-12);
        expect(S(g).player.mv.lastEnSpentAt).toBe(S(g).shots[0].firedAtSeconds); // the beam's 8 EN is paid at the shot instant ...
        expect(en0 - S(g).player.en).toBeCloseTo(8, 9); // ... even though the beam stopped at the wall (no regen inside the 0.75 s delay)
        expect(S(g).shots.length).toBe(1);
        expect(S(g).shots[0].weapon).toBe('beam');
        expect(len(sub(S(g).shots[0].muzzlePosition, m))).toBeLessThan(1e-12);
        expect(S(g).player.nextFireAt.beam).toBeCloseTo(S(g).shots[0].firedAtSeconds + 0.25, 12);
      });
    }
  }

  it('machinegun (free fire) behind a thin wall: no bullet is spawned, the round is spent, one world hit at the wall, the shot is recorded', () => {
    for (const plate of [frontPlate(0), sidePlate(0)]) {
      const g = gameWith([plate], 'machinegun');
      const t = targetAhead(g);
      run(g, 5);
      const c = { ...S(g).player.pos };
      const m = playerMuzzlePosition(S(g).player);
      clearEvents(g);
      pull(g, 1);
      expect(S(g).bullets.length).toBe(0);
      expect(S(g).nextProjectileId).toBe(1); // no projectile id consumed either
      expect(S(g).player.ammo.machinegun).toBe(299);
      const hits = evs(g, 'hit');
      expect(hits.length).toBe(1);
      expect(hits[0].on).toBe('world');
      expect(hits[0].weapon).toBe('machinegun');
      expect(len(sub(hits[0].pos, c))).toBeLessThan(len(sub(m, c))); // on the body -> muzzle segment
      expect(evs(g, 'mgFire').length).toBe(1);
      expect(S(g).shots.length).toBe(1);
      expect(S(g).shots[0].weapon).toBe('machinegun');
      expect(S(g).shots[0].initialVelocity).not.toBeNull();
      expect(len(S(g).shots[0].initialVelocity as V3)).toBeCloseTo(100, 9);
      expect(S(g).shots[0].accelerationAtFire).toEqual({ x: 0, y: -18, z: 0 });
      run(g, 130);
      expect(hpLoss(t)).toBe(0);
      expect(evs(g, 'hit').length).toBe(1); // nothing flew on beyond the wall
    }
  });

  it('a lock-corrected machinegun shot is stopped as well (solution solved and recorded, no bullet, the target behind is untouched)', () => {
    for (const plate of [frontPlate(0), sidePlate(0)]) {
      const g = gameWith([plate], 'machinegun');
      const t = targetAhead(g);
      lockOn(g);
      expect(S(g).fc.status).toBe('solved');
      clearEvents(g);
      pull(g, 1);
      const rec = S(g).shots[0];
      expect(rec.solutionStatus).toBe('solved');
      expect(rec.targetId).toBe(t.id);
      expect(rec.initialVelocity).not.toBeNull();
      expect(S(g).bullets.length).toBe(0);
      expect(S(g).player.ammo.machinegun).toBe(299);
      expect(evs(g, 'hit').filter((e) => e.on === 'world').length).toBe(1);
      run(g, 150);
      expect(hpLoss(t)).toBe(0);
      expect(S(g).lock.state).toBe('locked'); // the lock itself is not affected by this rule
    }
  });

  it('a lock-corrected beam is stopped (no damage); missile: a shot is consumed, no missile flies, hit + explosion at the wall', () => {
    for (const plate of [frontPlate(0), sidePlate(0)]) {
      const gb = gameWith([plate], 'beam');
      const tb = targetAhead(gb);
      lockOn(gb);
      clearEvents(gb);
      pull(gb, 1);
      expect(beamEnd(gb).hit).toBe('world');
      expect(S(gb).shots[0].solutionStatus).toBe('solved');
      expect(hpLoss(tb)).toBe(0);

      const gm = gameWith([plate], 'missile');
      const tm = targetAhead(gm);
      lockOn(gm);
      clearEvents(gm);
      const c = { ...S(gm).player.pos };
      const m = playerMuzzlePosition(S(gm).player);
      pull(gm, 1);
      expect(S(gm).missiles.length).toBe(0);
      expect(S(gm).player.ammo.missile).toBe(11); // the fired missile is counted
      expect(S(gm).shots.length).toBe(1);
      expect(S(gm).shots[0].weapon).toBe('missile');
      expect(S(gm).shots[0].targetId).toBe(tm.id);
      expect(S(gm).shots[0].initialVelocity).not.toBeNull();
      expect(evs(gm, 'missileFire').length).toBe(1);
      const hits = evs(gm, 'hit');
      expect(hits.length).toBe(1);
      expect(hits[0].on).toBe('world');
      expect(hits[0].weapon).toBe('missile');
      expect(len(sub(hits[0].pos, c))).toBeLessThan(len(sub(m, c)));
      const ex = evs(gm, 'explosion');
      expect(ex.length).toBe(1);
      expect(len(sub(ex[0].pos, hits[0].pos))).toBeLessThan(1e-12);
      run(gm, 300);
      expect(hpLoss(tm)).toBe(0);
      expect(S(gm).missiles.length).toBe(0);
      expect(S(gm).player.hp).toBe(1000); // own weapons never hurt the player
      expect(S(gm).player.nextFireAt.missile).toBeCloseTo(S(gm).shots[0].firedAtSeconds + 1, 12);
    }
  });

  it('every following shot of a held trigger is stopped too (fire interval kept), and letting go of the wall makes the very next shot fly', () => {
    const g = gameWith([frontPlate(0)], 'machinegun');
    const t = targetAhead(g);
    run(g, 5);
    pull(g, 60); // 0.5 s held: 5 shots
    expect(S(g).shots.length).toBe(5);
    expect(S(g).bullets.length).toBe(0);
    expect(S(g).player.ammo.machinegun).toBe(295);
    expect(evs(g, 'hit').length).toBe(5);
    expect(hpLoss(t)).toBe(0);
    // step away from the plate (it is only 1.7 m wide): the muzzle no longer has a wall behind it
    S(g).player.pos.x -= 3;
    S(g).player.prevPos.x -= 3;
    clearEvents(g);
    run(g, 20);
    pull(g, 1);
    const b = S(g).bullets[0];
    expect(b).toBeDefined();
    expect(len(sub(b.origin, playerMuzzlePosition(S(g).player)))).toBeLessThan(1e-9);
  });

  it('the same wall pressed on the body but LOW (a rail below the muzzle line) does not stop anything: shots fly, beam hits the target', () => {
    // 0.3 m thick rail, 1.1 m high, pressed on the front and on the right: the body-centre -> muzzle segment stays above y = 1.5
    const rail = box('rail', v3(-10, 0, -1.1), v3(10, 1.1, -0.8));
    const railRight = box('railR', v3(0.8, 0, -10), v3(1.1, 1.1, 10));
    const g = gameWith([rail, railRight], 'beam');
    const t = targetAhead(g);
    run(g, 5);
    clearEvents(g);
    pull(g, 1);
    const bf = beamEnd(g);
    expect(bf.hit).toBe('enemy');
    expect(bf.targetId).toBe(t.id);
    expect(hpLoss(t)).toBe(40);
    const gm = gameWith([rail, railRight], 'machinegun');
    run(gm, 5);
    pull(gm, 1);
    expect(S(gm).bullets.length).toBe(1);
  });

  it('a thin wall on the LEFT of the body does not matter (the muzzle is on the right); a thin wall beyond the muzzle is hit by the round itself, not at the body', () => {
    const left = box('left', v3(-1.1, 0, -30), v3(-0.8, 10, 30));
    const g = gameWith([left], 'beam');
    const t = targetAhead(g);
    run(g, 5);
    pull(g, 1);
    expect(beamEnd(g).hit).toBe('enemy');
    expect(hpLoss(t)).toBe(40);
    // 0.3 m plate just beyond the muzzle (forward 1.4..1.7 > 1.25): the segment is clear, the beam is stopped by the plate ahead of the muzzle
    const ahead = localBox('ahead', 0, [-0.5, 1.6], [1.4, 1.7], [0, 10]);
    const g2 = gameWith([ahead], 'beam');
    run(g2, 5);
    const m = playerMuzzlePosition(S(g2).player);
    pull(g2, 1);
    const bf = beamEnd(g2);
    expect(bf.hit).toBe('world');
    expect(len(sub(bf.end, m))).toBeGreaterThan(0.1); // stopped ahead of the muzzle, not on the body -> muzzle segment
    expect(bf.end.z).toBeCloseTo(-1.4, 6);
  });

  it('a thick wall pressed on the body still swallows the shot (now reported on the wall face instead of inside it)', () => {
    const wall = box('front', v3(-10, 0, -2.8), v3(10, 10, -0.8)); // 2 m thick, the muzzle is inside it
    const g = gameWith([wall], 'beam');
    const t = targetAhead(g);
    run(g, 5);
    const c = { ...S(g).player.pos };
    clearEvents(g);
    pull(g, 1);
    const bf = beamEnd(g);
    expect(bf.hit).toBe('world');
    expect(bf.end.z).toBeCloseTo(-0.8, 3); // the face of the wall (the segment enters it there)
    expect(len(sub(bf.end, c))).toBeLessThan(1.8);
    expect(hpLoss(t)).toBe(0);
    select(g, 'machinegun');
    clearEvents(g);
    run(g, 20);
    pull(g, 1);
    expect(S(g).bullets.length).toBe(0);
    expect(evs(g, 'hit')[0].pos.z).toBeCloseTo(-0.8, 3);
  });

  it('a refused shot (no ammo) still changes nothing: the wall rule only applies to shots that are actually fired', () => {
    const g = gameWith([frontPlate(0)], 'machinegun');
    targetAhead(g);
    run(g, 5);
    S(g).player.ammo.machinegun = 0;
    clearEvents(g);
    pull(g, 3);
    expect(S(g).shots.length).toBe(0);
    expect(evs(g, 'hit').length).toBe(0);
    expect(evs(g, 'mgFire').length).toBe(0);
    expect(S(g).player.ammo.machinegun).toBe(0);
  });
});

describe('lock occlusion and trajectory occlusion are separate (SPEC §4.5)', () => {
  // the straight lines camera->target and muzzle->target are clear, the corrected parabola climbs into this beam
  const beam = box('beam', v3(-3, 3.9, -51), v3(5, 5.5, -49));

  it('the locked, corrected shot is stopped by the beam; gravity is not removed, no other solution is used', () => {
    const g = makeGame({ boxes: [beam] });
    const t = addTarget(g, onAxis(-100));
    const s = S(g);
    const m = playerMuzzlePosition(s.player);
    expect(g.world.segmentBlocked(s.camera.pos, t.pos)).toBe(false);
    expect(g.world.segmentBlocked(m, t.pos)).toBe(false);
    lockOn(g);
    expect(S(g).fc.status).toBe('solved');
    const fcDir = { ...(S(g).fc.launchDirection as V3) };
    clearEvents(g);
    pull(g, 1);
    const rec = S(g).shots[0];
    expect(rec.solutionStatus).toBe('solved');
    const b = S(g).bullets[0] as PlayerBullet;
    run(g, 200);
    expect(b.alive).toBe(false);
    const hit = evs(g, 'hit')[0];
    expect(hit.on).toBe('world');
    expect(hit.pos.z).toBeGreaterThan(-49.2); // stopped at the beam's near face (z = -49) + bullet radius
    expect(hit.pos.z).toBeLessThan(-48.5);
    expect(hit.pos.y).toBeGreaterThan(3.9);
    expect(t.hp).toBe(1e6);
    // the shot direction is exactly what the solver gives with no beam in the world: no high-arc switch, no gravity change
    const g2 = makeGame();
    addTarget(g2, onAxis(-100));
    lockOn(g2);
    pull(g2, 1);
    expect(len(sub(rec.launchDirection, S(g2).shots[0].launchDirection))).toBeLessThan(1e-12);
    expect(len(sub(rec.launchDirection, fcDir))).toBeLessThan(1e-3); // (HUD value one tick earlier, target static)
    // and without the beam that very shot reaches the target
    run(g2, 200);
    expect(S(g2).enemies[0].hp).toBe(1e6 - 12);
  });
});

// ---------------------------------------------------------------------------
describe('recentPlayerShots', () => {
  it('keeps the latest 32 shots oldest-first with sequential ids; refusals add nothing; a respawn resets everything', () => {
    const g = makeGame();
    pull(g, 12 * 40 - 5); // 40 shots
    expect(S(g).shotSeq).toBe(40);
    expect(S(g).shots.length).toBe(LIMITS.RECENT_SHOTS);
    expect(S(g).shots.map((r) => r.id)).toEqual(Array.from({ length: 32 }, (_, i) => 9 + i));
    for (let i = 1; i < 32; i++) expect(S(g).shots[i].firedAtSeconds).toBeGreaterThan(S(g).shots[i - 1].firedAtSeconds);
    // refused shots (missile without a lock) do not add a record or consume an id
    select(g, 'missile');
    const before = JSON.stringify(S(g).shots);
    pull(g, 30);
    expect(JSON.stringify(S(g).shots)).toBe(before);
    expect(S(g).shotSeq).toBe(40);
    // respawn: array and sequence are reset
    g.retry();
    expect(S(g).shots).toEqual([]);
    expect(S(g).shotSeq).toBe(0);
    expect(S(g).bullets.length).toBe(0);
    pull(g, 1);
    expect(S(g).shots.map((r) => r.id)).toEqual([1]);
    // the snapshot copy is what the bench shows
    expect(buildSnapshot(S(g)).recentPlayerShots.map((r) => r.id)).toEqual([1]);
  });

  it('a record is a copy of the shot instant: later target motion / weapon changes never alter it', () => {
    const g = makeGame();
    const t = addTarget(g, onAxis(-60));
    lockOn(g);
    pull(g, 1);
    const frozen = JSON.stringify(S(g).shots[0]);
    expect(S(g).shots[0].targetId).toBe(t.id);
    t.vel = v3(5, 2, 1);
    t.pos = v3(20, 30, -70);
    select(g, 'beam');
    run(g, 60);
    expect(JSON.stringify(S(g).shots[0])).toBe(frozen);
    // snapshot copies are independent of the game state
    const snap = buildSnapshot(S(g));
    snap.recentPlayerShots[0].muzzlePosition[0] = 12345;
    snap.enemies[0].position[0] = 999;
    expect(S(g).shots[0].muzzlePosition.x).not.toBe(12345);
    expect(t.pos.x).toBeCloseTo(22.5, 6); // 20 + 5 m/s * 0.5 s: the dummy kept moving, the copy did not
  });

  it('free-fire shot records: inactive, no target fields, initialVelocity = the velocity given to the bullet; beam initialVelocity null; acceleration by weapon', () => {
    const g = makeGame();
    pull(g, 1);
    const a = S(g).shots[0];
    const b = S(g).bullets[0];
    expect(a.weapon).toBe('machinegun');
    expect(a.solutionStatus).toBe('inactive');
    expect(a.initialVelocity).toEqual(b.v0);
    expect(a.accelerationAtFire).toEqual({ x: 0, y: -18, z: 0 });
    expect(len(sub(a.launchDirection, unit(b.v0)))).toBeLessThan(1e-12);
    select(g, 'beam');
    pull(g, 1);
    const c = S(g).shots[1];
    expect(c.weapon).toBe('beam');
    expect(c.initialVelocity).toBeNull();
    expect(c.solutionStatus).toBe('inactive');
    expect(c.accelerationAtFire).toEqual({ x: 0, y: 0, z: 0 });
    expect(c.predictedFlightSeconds).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('machinegun no_solution (lock kept, direct aim, the round is still spent)', () => {
  it('a target that outruns the bullet: no_solution, direct aim at the current position, lock stays, 1 round spent', () => {
    const g = makeGame();
    const t = addTarget(g, onAxis(-90));
    lockOn(g);
    t.vel = v3(0, 0, -150); // receding faster than 100 m/s: no intercept exists
    const p0 = { ...t.pos };
    clearEvents(g);
    pull(g, 1);
    const s = S(g);
    const rec = s.shots[0];
    const m = rec.muzzlePosition;
    expect(s.player.ammo.machinegun).toBe(299);
    expect(rec.solutionStatus).toBe('no_solution');
    expect(rec.targetId).toBe(t.id);
    expect(len(sub(rec.targetPositionAtFire as V3, p0))).toBeLessThan(1e-12);
    expect(len(sub(rec.targetVelocityAtFire as V3, v3(0, 0, -150)))).toBeLessThan(1e-12);
    expect(len(sub(rec.launchDirection, unit(sub(p0, m))))).toBeLessThan(1e-12); // direct aim at the current center
    expect(rec.predictedFlightSeconds).toBeNull();
    expect(rec.predictedInterceptPosition).toBeNull();
    expect(len(sub(rec.initialVelocity as V3, { x: rec.launchDirection.x * 100, y: rec.launchDirection.y * 100, z: rec.launchDirection.z * 100 }))).toBeLessThan(1e-9);
    expect(s.bullets[0].v0).toEqual(rec.initialVelocity);
    // the lock is kept (the target is still a valid candidate) and the HUD says "no solution" with the direct aim point
    expect(s.lock.state).toBe('locked');
    expect(s.lock.targetId).toBe(t.id);
    expect(s.fc.status).toBe('no_solution');
    expect(s.fc.targetId).toBe(t.id);
    expect(s.fc.predictedFlightSeconds).toBeNull();
    expect(s.fc.predictedInterceptPosition).toBeNull();
    expect(s.fc.residualMeters).toBeNull();
    expect(len(sub(s.fc.aimPoint as V3, t.pos))).toBeLessThan(1e-9);
    expect(s.fc.launchDirection).not.toBeNull();
    expect(s.notices.noSolutionAt).not.toBeNull();
    expect(evs(g, 'notice').some((e) => e.kind === 'noSolution')).toBe(true);
    // an ordinary later shot still spends 1 round each
    pull(g, 12);
    expect(S(g).player.ammo.machinegun).toBe(298);
  });

  it('muzzle exactly on the target center: no NaN/Infinity, the bullet overlaps the target and hits at once (real overlap + collision)', () => {
    const g = makeGame();
    const m = playerMuzzlePosition(S(g).player);
    const t = addTarget(g, m);
    lockOn(g);
    clearEvents(g);
    pull(g, 1);
    const rec = S(g).shots[0];
    for (const x of [rec.launchDirection.x, rec.launchDirection.y, rec.launchDirection.z, ...Object.values(rec.initialVelocity as V3)]) expect(Number.isFinite(x)).toBe(true);
    expect(rec.solutionStatus).toBe('no_solution');
    expect(t.hp).toBe(1e6 - 12);
    expect(S(g).bullets.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('beam', () => {
  it('hits the first thing on the ray only, once, for 40 (a nearer enemy shields the locked one behind it)', () => {
    const g = makeGame();
    select(g, 'beam');
    const far = addTarget(g, onAxis(-60), v3(0, 0, 0), 'A_far'); // lower id -> wins the equal-distance tie and is locked
    const near = addTarget(g, onAxis(-30), v3(0, 0, 0), 'N_near');
    lockOn(g);
    expect(S(g).lock.targetId).toBe('A_far');
    clearEvents(g);
    pull(g, 1);
    expect(near.hp).toBe(1e6 - 40);
    expect(far.hp).toBe(1e6);
    const bf = evs(g, 'beamFire');
    expect(bf.length).toBe(1);
    expect(bf[0].hit).toBe('enemy');
    expect(bf[0].targetId).toBe('N_near');
    expect(S(g).shots[0].targetId).toBe('A_far'); // the shot was aimed at the locked target, the first obstacle took it
  });

  it('range 120 m from the muzzle: an unlocked (free-fire) beam reaches an enemy at 118 m but not one at 125 m', () => {
    const g = makeGame();
    select(g, 'beam');
    const inRange = addTarget(g, onAxis(-119), v3(0, 0, 0), 'A');
    clearEvents(g);
    pull(g, 1); // fired at tick 0: no lock yet -> aimed at the camera-center point
    expect(S(g).shots[0].solutionStatus).toBe('inactive');
    expect(inRange.hp).toBe(1e6 - 40);
    const g2 = makeGame();
    select(g2, 'beam');
    const far = addTarget(g2, onAxis(-127));
    clearEvents(g2);
    pull(g2, 1);
    expect(far.hp).toBe(1e6);
    const bf = evs(g2, 'beamFire')[0];
    expect(bf.hit).toBe('none');
    expect(len(sub(bf.end, bf.origin))).toBeCloseTo(120, 6);
  });
});

// ---------------------------------------------------------------------------
describe('missile rules (SPEC §4.4)', () => {
  it('no intercept root (target faster than 45 m/s and receding): still fires, aimed at the current position (no_solution)', () => {
    const g = makeGame();
    select(g, 'missile');
    const t = addTarget(g, onAxis(-60));
    lockOn(g);
    t.vel = v3(0, 0, -100);
    const p0 = { ...t.pos };
    pull(g, 1);
    const rec = S(g).shots[0];
    expect(S(g).missiles.length).toBe(1);
    expect(S(g).player.ammo.missile).toBe(11);
    expect(rec.solutionStatus).toBe('no_solution');
    expect(len(sub(rec.launchDirection, unit(sub(p0, rec.muzzlePosition))))).toBeLessThan(1e-12);
    expect(rec.predictedFlightSeconds).toBeNull();
    expect(len(rec.initialVelocity as V3)).toBeCloseTo(45, 9);
  });

  it('only the directly hit enemy takes damage (180); a nearby bystander takes none', () => {
    const g = makeGame();
    select(g, 'missile');
    const t = addTarget(g, onAxis(-50), v3(0, 0, 0), 'T');
    const by = addTarget(g, v3(1.4 + 2.2, 2.7, -50), v3(0, 0, 0), 'Z_by');
    lockOn(g);
    expect(S(g).lock.targetId).toBe('T');
    clearEvents(g);
    pull(g, 1);
    run(g, 200);
    expect(t.hp).toBe(1e6 - 180);
    expect(by.hp).toBe(1e6);
    expect(evs(g, 'explosion').length).toBeGreaterThanOrEqual(1);
    expect(S(g).missiles.length).toBe(0);
  });

  it('after the target is destroyed the missile flies straight (speed 45, no turn, no re-targeting) and expires after 4 s', () => {
    const g = makeGame();
    select(g, 'missile');
    const t = addTarget(g, onAxis(-100), v3(0, 0, 0), 'T');
    addTarget(g, v3(1.4 + 4, 2.7, -100), v3(0, 0, 0), 'Z_other'); // another enemy near the path: must not be adopted
    lockOn(g);
    pull(g, 1);
    const ms = S(g).missiles[0] as Missile;
    run(g, 10);
    damageEnemy(S(g), t, 1e9, 'beam');
    const dir0 = unit(ms.vel);
    let maxTurn = 0;
    let guard = 0;
    while (ms.alive && guard++ < 700) {
      const before = unit(ms.vel);
      g.step();
      maxTurn = Math.max(maxTurn, angle(before, unit(ms.vel)));
      expect(len(ms.vel)).toBeCloseTo(45, 9);
    }
    expect(maxTurn).toBeLessThan(1e-9);
    expect(angle(dir0, unit(ms.vel))).toBeLessThan(1e-9);
    expect(ms.age).toBeGreaterThanOrEqual(WEAPONS.missile.lifetime - 1e-9);
    expect(ms.age).toBeLessThanOrEqual(WEAPONS.missile.lifetime + 1e-9);
    expect(S(g).enemies.find((e) => e.id === 'Z_other')!.hp).toBe(1e6);
    expect(S(g).missiles.length).toBe(0);
  });

  /** a missile injected at a chosen pose (real projectile update / collision code) */
  function inject(g: Game, pos: V3, vel: V3, targetId: string, seen?: { pos: V3; vel: V3 }): Missile {
    const s = S(g);
    const m: Missile = {
      id: s.nextProjectileId++,
      pos: { ...pos },
      prevPos: { ...pos },
      vel: { ...vel },
      age: 0,
      life: WEAPONS.missile.lifetime,
      damage: WEAPONS.missile.damage,
      targetId,
      lastSeenPos: { ...(seen?.pos ?? pos) },
      lastSeenVel: { ...(seen?.vel ?? v3(0, 0, 0)) },
      lastSeenAt: s.time,
      alive: true,
    };
    s.missiles.push(m);
    return m;
  }

  it('a wall reached before an enemy in the same tick takes priority (the enemy takes no damage); the reverse order damages the enemy', () => {
    // missile at z = 0.5 moving -Z by 0.375 m per tick, radius 0.25; wall face at z = 0 -> center contact at z = 0.25 (u = 0.667)
    const wall = box('w1', v3(40, 0, -2), v3(60, 10, 0));
    const g = makeGame({ boxes: [wall] });
    const e = addTarget(g, v3(50, 5, -0.5875), v3(0, 0, 0), 'E'); // sphere contact at center z = 0.1625 (u = 0.9)
    const m = inject(g, v3(50, 5, 0.5), v3(0, 0, -45), 'none');
    clearEvents(g);
    g.step();
    expect(m.alive).toBe(false);
    expect(e.hp).toBe(1e6);
    expect(evs(g, 'hit')[0].on).toBe('world');
    expect(m.pos.z).toBeCloseTo(0.25, 6);

    const g2 = makeGame({ boxes: [box('w2', v3(40, 0, -3), v3(60, 10, -1))] });
    const e2 = addTarget(g2, v3(50, 5, 0), v3(0, 0, 0), 'E');
    const m2 = inject(g2, v3(50, 5, 1.0), v3(0, 0, -45), 'none'); // enemy contact at z = 0.75 (u = 0.667), wall at z = -0.75
    g2.step();
    expect(m2.alive).toBe(false);
    expect(e2.hp).toBe(1e6 - 180);
    expect(evs(g2, 'hit')[0].on).toBe('enemy');
  });

  it('occluded from the MISSILE: guidance uses only the last observation (hidden true motion is ignored); visible: it tracks the true motion', () => {
    const wall = box('screen', v3(30, 0, -14), v3(70, 10, -12));
    const flight = (hiddenVel: V3, seenVel: V3, wallOn: boolean): { m: Missile; positions: V3[] } => {
      const g = makeGame({ boxes: [wall] });
      if (!wallOn) g.world.setBoxEnabled(g.world.indexOfBox('screen'), false);
      const t = addTarget(g, v3(50, 1.5, -30), hiddenVel, 'T');
      // missile above the screen wall, flying +X; LOS missile->target is cut by the wall
      const m = inject(g, v3(50, 12, 0), v3(45, 0, 0), t.id, { pos: v3(50, 1.5, -30), vel: seenVel });
      const positions: V3[] = [];
      for (let i = 0; i < 36; i++) {
        g.step();
        positions.push({ ...m.pos });
      }
      expect(m.alive).toBe(true);
      return { m, positions };
    };
    const a = flight(v3(0, 8, 0), v3(0, 0, 0), true);
    const b = flight(v3(0, 0, -8), v3(0, 0, 0), true);
    for (let i = 0; i < 36; i++) expect(len(sub(a.positions[i], b.positions[i]))).toBeLessThan(1e-12); // identical: hidden motion is not read
    expect(a.m.lastSeenAt).toBe(0); // no new observation while occluded
    // the missile did steer toward the (extrapolated) last observation
    expect(a.m.vel.z).toBeLessThan(-1);
    expect(a.m.vel.y).toBeLessThan(-0.1);
    // a different LAST-SEEN velocity gives a different flight (the constant-velocity extrapolation is used)
    const c = flight(v3(0, 8, 0), v3(0, 10, 0), true);
    expect(len(sub(a.positions[35], c.positions[35]))).toBeGreaterThan(1e-3);
    // control: no wall -> the missile observes the target each tick and follows its true motion
    const d = flight(v3(0, 8, 0), v3(0, 0, 0), false);
    const e = flight(v3(0, 0, -8), v3(0, 0, 0), false);
    expect(len(sub(d.positions[35], e.positions[35]))).toBeGreaterThan(1e-3);
    expect(d.m.lastSeenAt).toBeGreaterThan(0.25);
  });
});

// ---------------------------------------------------------------------------
describe('swept projectile collision (SPEC §4.5)', () => {
  /** a machinegun bullet injected at a chosen origin/velocity (real projectile update / collision code) */
  function injectBullet(g: Game, origin: V3, v0: V3, age = 0): PlayerBullet {
    const s = S(g);
    const b: PlayerBullet = { id: s.nextProjectileId++, pos: { ...origin }, prevPos: { ...origin }, origin: { ...origin }, v0: { ...v0 }, age, damage: 12, alive: true };
    s.bullets.push(b);
    return b;
  }

  it('firstSphereContact is exact for a moving sphere (crossing, tangent, overlap, separating)', () => {
    // a point moves +Z by 1 m while a sphere (r 0.5) sweeps x from -1.25 to +1.25 at z = 0.4: compare with a brute-force scan
    const u = firstSphereContact(v3(0, 0, 0), v3(0, 0, 1), v3(-1.25, 0, 0.4), v3(1.25, 0, 0.4), 0.5) as number;
    let brute = -1;
    for (let i = 0; i <= 1_000_000; i++) {
      const w = i / 1_000_000;
      const dx = 0 - (-1.25 + 2.5 * w);
      const dz = w * 1 - 0.4;
      if (dx * dx + dz * dz <= 0.25) {
        brute = w;
        break;
      }
    }
    expect(u).toBeCloseTo(brute, 5);
    expect(firstSphereContact(v3(0, 0, 0), v3(0, 0, 1), v3(3, 0, 0), v3(3, 0, 0), 0.5)).toBeNull();
    expect(firstSphereContact(v3(0, 0, 0), v3(0, 0, 1), v3(0.1, 0, 0.3), v3(0.1, 0, 0.3), 0.5)).toBe(0); // already overlapping at u = 0
    expect(firstSphereContact(v3(0, 0, 2), v3(0, 0, 3), v3(0, 0, 0), v3(0, 0, 0), 0.5)).toBeNull(); // moving away
    expect(firstSphereContact(v3(0, 0, 0), v3(0, 0, 1), v3(0, 0, 5), v3(0, 0, 5), 0.5)).toBeNull(); // out of reach this tick
  });

  it('a target that crosses the bullet line INSIDE the tick but ends the tick off the line is still hit (no end-of-tick check)', () => {
    const g = makeGame();
    // bullet moves +Z 0.833 m in this tick; the sphere (r 0.5 + 0.06) sweeps x from -1.25 to +1.25 (300 m/s) during the same tick
    const b = injectBullet(g, v3(50, 5, 0), v3(0, 0, 100));
    const t = addTarget(g, v3(48.75, 5, 0.4), v3(300, 0, 0));
    g.step();
    expect(b.alive).toBe(false);
    expect(t.hp).toBe(1e6 - 12);
    // at the END of the tick the target is 1.25 m from the bullet line: a fixed-end-position test would have missed
    expect(Math.abs(t.pos.x - 50)).toBeGreaterThan(1.0);
    // control: the same target without the sweep (already past) is missed
    const g2 = makeGame();
    const b2 = injectBullet(g2, v3(50, 5, 0), v3(0, 0, 100));
    const t2 = addTarget(g2, v3(51.25, 5, 0.4), v3(300, 0, 0)); // moves away
    g2.step();
    expect(b2.alive).toBe(true);
    expect(t2.hp).toBe(1e6);
  });

  it('the last interval before the 2 s lifetime is checked before the bullet is removed', () => {
    const g = makeGame();
    // bullet flying +Z; place a target sphere that is reachable only in the very last tick (age 1.99167 .. 2.0)
    const v0 = v3(0, 30, 100);
    const b = injectBullet(g, v3(50, 40, 0), v0, 1.99);
    const age = 1.9958333; // inside the last interval
    const at = v3(50, 40 + v0.y * age - 9 * age * age, v0.z * age);
    const t = addTarget(g, at);
    run(g, 3);
    expect(t.hp).toBe(1e6 - 12);
    expect(b.alive).toBe(false);
    // control: a target beyond the lifetime end (age 2.05) is never hit and the bullet is gone
    const g2 = makeGame();
    const b2 = injectBullet(g2, v3(50, 40, 0), v0, 1.99);
    const age2 = 2.05;
    const t2 = addTarget(g2, v3(50, 40 + v0.y * age2 - 9 * age2 * age2, v0.z * age2));
    run(g2, 6);
    expect(t2.hp).toBe(1e6);
    expect(b2.alive).toBe(false);
    expect(S(g2).bullets.length).toBe(0);
  });

  it('a bullet lives 2 s: it is removed on the last tick, and only then', () => {
    const g = makeGame({ pitch: 0 });
    const b = injectBullet(g, v3(50, 300, 0), v3(0, 0, 100)); // high above everything: only the lifetime ends it
    run(g, 239);
    expect(b.alive).toBe(true);
    run(g, 1);
    expect(b.alive).toBe(false);
    expect(b.age).toBeCloseTo(2, 9);
    expect(S(g).bullets.length).toBe(0);
  });

  it('a bullet stops at a wall before an enemy behind it in the same tick', () => {
    const g = makeGame({ boxes: [box('thin', v3(40, 0, 0.3), v3(60, 10, 0.5))] });
    const b = injectBullet(g, v3(50, 5, 0), v3(0, 0, 100)); // reaches z=0.3 (minus radius) at u ~ 0.29, the enemy sphere later
    const t = addTarget(g, v3(50, 5, 1.2)); // sphere contact at bullet z = 0.64 (u = 0.77) is later than the wall at z = 0.24 (u = 0.29)
    g.step();
    expect(b.alive).toBe(false);
    expect(t.hp).toBe(1e6);
    expect(evs(g, 'hit')[0].on).toBe('world');
  });
});

// ---------------------------------------------------------------------------
describe('stale lock for the free-fire weapons', () => {
  it('machinegun / beam: once the target no longer qualifies at the shot tick, the old correction is NOT used (free fire)', () => {
    for (const w of ['machinegun', 'beam'] as const) {
      const g = makeGame();
      select(g, w);
      const t = addTarget(g, onAxis(-80), v3(0, 0, 0), 'T');
      lockOn(g);
      expect(S(g).fc.status).toBe('solved');
      // the target jumps out of the FCS circle between two ticks; the tick that fires must re-validate and free-fire
      t.pos = v3(70, 2.7, -80);
      t.prevPos = { ...t.pos };
      pull(g, 1);
      const rec = S(g).shots[0];
      expect(rec.solutionStatus, w).toBe('inactive');
      expect(rec.targetId, w).toBeNull();
      expect(rec.targetPositionAtFire, w).toBeNull();
      expect(S(g).lock.state, w).toBe('none');
      expect(S(g).fc.status, w).toBe('inactive');
      // the shot went to the camera-center point, not toward the stale target
      const expected = freeFireDirection(S(g), g.world, rec.muzzlePosition);
      expect(len(sub(rec.launchDirection, expected)), w).toBeLessThan(1e-3);
    }
  });
});

// ---------------------------------------------------------------------------
describe('camera rig and muzzle', () => {
  it('the muzzle is a fixed offset in the yaw frame: independent of view pitch, FCS correction and firing', () => {
    const g = makeGame();
    const p = S(g).player;
    const ref = playerMuzzlePosition(p);
    // yaw = 0: right (1,0,0), forward (0,0,-1)
    expect(len(sub(ref, v3(p.pos.x + PLAYER.MUZZLE_OFFSET.right, p.pos.y + PLAYER.MUZZLE_OFFSET.up, p.pos.z - PLAYER.MUZZLE_OFFSET.forward)))).toBeLessThan(1e-12);
    for (const pitch of [-1.2, -0.4, 0, 0.7, 1.2]) {
      p.pitch = pitch;
      updateCamera(S(g), g.world);
      expect(len(sub(playerMuzzlePosition(p), ref))).toBe(0);
    }
    // a corrected shot (barrel tilts up) does not move the muzzle
    p.pitch = 0;
    updateCamera(S(g), g.world);
    addTarget(g, onAxis(-100));
    lockOn(g);
    const before = playerMuzzlePosition(S(g).player);
    pull(g, 1);
    expect(len(sub(S(g).shots[0].muzzlePosition, before))).toBe(0);
    // yaw rotates the offset with the body
    p.yaw = Math.PI / 2; // facing -X
    const m = playerMuzzlePosition(p);
    expect(m.x).toBeCloseTo(p.pos.x - PLAYER.MUZZLE_OFFSET.forward, 9);
    expect(m.z).toBeCloseTo(p.pos.z - PLAYER.MUZZLE_OFFSET.right, 9);
  });

  it('the camera basis is right-handed (up = right x forward) and orthonormal for every yaw / pitch', () => {
    const g = makeGame();
    const p = S(g).player;
    for (const yaw of [0, 0.5, 2.2, -1.3, 3.1]) {
      for (const pitch of [-1.2, -0.3, 0, 0.6, 1.2]) {
        p.yaw = yaw;
        p.pitch = pitch;
        updateCamera(S(g), g.world);
        const c = S(g).camera;
        const cross = v3(c.right.y * c.forward.z - c.right.z * c.forward.y, c.right.z * c.forward.x - c.right.x * c.forward.z, c.right.x * c.forward.y - c.right.y * c.forward.x);
        expect(len(sub(c.up, cross))).toBeLessThan(1e-12);
        expect(dot(c.right, c.forward)).toBeCloseTo(0, 12);
        expect(dot(c.up, c.forward)).toBeCloseTo(0, 12);
        expect(len(c.forward)).toBeCloseTo(1, 12);
        expect(c.up.y).toBeGreaterThan(0); // never rolls over
      }
    }
  });

  it('the camera stays out of walls: pulled in when a wall is behind the player, and never inside a solid', () => {
    const free = makeGame();
    const cf = S(free).camera.pos;
    const pivot = v3(S(free).player.pos.x, S(free).player.pos.y + CAMERA.PIVOT_UP, S(free).player.pos.z);
    expect(len(sub(cf, pivot))).toBeCloseTo(Math.hypot(CAMERA.DISTANCE, CAMERA.SHOULDER), 6);
    // wall 3 m behind the player (z 3..5): the camera would sit at z = 8.5 in the open
    const g = makeGame({ boxes: [box('back', v3(-20, 0, 3), v3(20, 20, 5))] });
    const c = S(g).camera.pos;
    expect(g.world.pointInSolid(c)).toBe(false);
    expect(c.z).toBeLessThan(3 - CAMERA.COLLISION_MARGIN + 1e-6); // margin kept from the wall face
    expect(len(sub(c, pivot))).toBeLessThan(len(sub(cf, pivot)));
    // a low ceiling right above the pivot must not collapse or trap the camera in the ceiling (flying up into a ceiling)
    const g2 = makeGame({ boxes: [box('ceil', v3(-30, 3.0, -30), v3(30, 5, 30))] });
    S(g2).player.pitch = 0.6; // looking up: the camera goes below the pivot
    updateCamera(S(g2), g2.world);
    for (const pitch of [-1.2, -0.5, 0.3, 0.9, 1.2]) {
      S(g2).player.pitch = pitch;
      updateCamera(S(g2), g2.world);
      const cp = S(g2).camera.pos;
      expect(Number.isFinite(cp.x + cp.y + cp.z)).toBe(true);
      expect(g2.world.pointInSolid(cp)).toBe(false);
    }
  });

  it('computeAimPoint: first hit of the camera-center ray (world or alive enemy); degenerate aim falls back to the camera forward', () => {
    const g = makeGame({ boxes: [box('front', v3(-30, 0, -60), v3(30, 30, -58))] });
    let aim = computeAimPoint(S(g), g.world);
    expect(aim.z).toBeCloseTo(-58, 3); // the wall face, along the level camera ray
    const e = addTarget(g, onAxis(-30));
    aim = computeAimPoint(S(g), g.world);
    expect(aim.z).toBeCloseTo(-29.5, 3); // the enemy's front surface is nearer
    damageEnemy(S(g), e, 1e9, 'beam');
    aim = computeAimPoint(S(g), g.world);
    expect(aim.z).toBeCloseTo(-58, 3); // dead enemies are transparent
    // aim point that is not ahead of the muzzle (wall right behind the muzzle plane): direction = camera forward
    const g2 = makeGame({ boxes: [box('near', v3(-30, 0, -1.0), v3(30, 30, 1.0))] });
    const dir = freeFireDirection(S(g2), g2.world, playerMuzzlePosition(S(g2).player));
    expect(len(sub(dir, S(g2).camera.forward))).toBeLessThan(1e-12);
  });
});
