/**
 * Enemy AI / attack / bullet tests (SPEC §2.1, §2.3).
 * Everything runs through the real Game (tick order, player, world, rng) on small hand-made stages; only the geometry and the
 * spawn lists are custom. Nothing here reimplements the AI: assertions read the state / events the game produces.
 */
import { describe, expect, it } from 'vitest';
import { ENEMIES, PLAYER, SIM } from '../src/config';
import { solveConstantSpeedIntercept } from '../src/sim/ballistics';
import { damageEnemy } from '../src/sim/combat';
import { PLAN_WORK_PER_TICK, getEnemyAI, stepEnemyBullets } from '../src/sim/enemies';
import { Game } from '../src/sim/game';
import { NAV, getNav } from '../src/sim/nav';
import { Rng } from '../src/sim/rng';
import { buildTestArenaStage } from '../src/sim/testArena';
import { World } from '../src/sim/world';
import type { BoxDef, EnemyBullet, EnemySpawn, GameState, V3 } from '../src/sim/types';

const DT = SIM.DT;
const GUARD = ENEMIES.guard;
const TURRET = ENEMIES.turret;
const PLAYER_Y = PLAYER.HALF.y; // player center height on a y = 0 floor
const RAD2DEG = 180 / Math.PI;
/** distance at which a guard counts as being back at its post */
const HOME_TOL = 0.7;
// ---------------------------------------------------------------------------------------------------------------------
// scene helpers
// ---------------------------------------------------------------------------------------------------------------------
let boxSeq = 0;
function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, extra: Partial<BoxDef> = {}): BoxDef {
  return { id: `tb${boxSeq++}`, min: { x: x0, y: y0, z: z0 }, max: { x: x1, y: y1, z: z1 }, mat: 'concrete', sectorId: 'T00', ...extra };
}
/** a wall that a test switches on/off while running; barrierId makes the nav track its enabled state like a real barrier */
function switchable(id: string, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): BoxDef {
  return box(x0, y0, z0, x1, y1, z1, { id, barrierId: 'TESTBLK' });
}
function spawn(kind: 'guard' | 'turret', id: string, x: number, z: number): EnemySpawn {
  return {
    id, kind, sectorId: 'T00', pos: { x, y: ENEMIES[kind].centerHeight, z }, yaw: 0,
    isGateControl: false, controlIndex: null, barrierId: null,
  };
}

interface Scene {
  enemies: EnemySpawn[];
  boxes?: BoxDef[];
  player?: { x: number; z: number };
  yaw?: number;
  hp?: number;
  floorHalf?: number;
}
function makeGame(sc: Scene): Game {
  const stage = buildTestArenaStage({ floorHalf: sc.floorHalf ?? 400 });
  stage.boxes.push(...(sc.boxes ?? []));
  stage.enemies = sc.enemies;
  const p = sc.player ?? { x: 0, z: 0 };
  stage.playerStart = { pos: { x: p.x, y: PLAYER_Y, z: p.z }, yaw: sc.yaw ?? 0 };
  const g = new Game({ stage });
  g.sortie();
  g.state.player.hp = sc.hp ?? 1e9; // tests that are not about damage keep the player alive (nothing else is special-cased)
  return g;
}
const setEnabled = (g: Game, id: string, on: boolean): void => g.world.setBoxEnabled(g.world.indexOfBox(id), on);
const enemy = (g: Game, id: string) => g.state.enemies.find((e) => e.id === id)!;
const hspeed = (v: V3): number => Math.hypot(v.x, v.z);

const dotv = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const lenv = (a: V3): number => Math.hypot(a.x, a.y, a.z);
const subv = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
function angleDeg(a: V3, b: V3): number {
  const c = dotv(a, b) / (lenv(a) * lenv(b));
  return Math.acos(Math.min(1, Math.max(-1, c))) * RAD2DEG;
}

interface FireRec {
  time: number;
  id: string;
  origin: V3;
  dir: V3;
  /** player pos / vel at the START of the tick in which the shot was fired (= the values the AI saw) */
  player: { pos: V3; vel: V3 };
  /** enemy.hasLineOfSight after that tick */
  los: boolean;
}

class Rec {
  fires: FireRec[] = [];
  telegraphs: { time: number; id: string }[] = [];
  playerHits: { time: number; damage: number }[] = [];
  worldHits: { time: number; pos: V3 }[] = [];
  constructor(readonly g: Game) {}

  step(): void {
    const s = this.g.state;
    const pre = { pos: { ...s.player.pos }, vel: { ...s.player.vel } };
    this.g.step();
    for (const ev of this.g.drainEvents()) {
      if (ev.type === 'enemyFire') {
        const e = this.g.state.enemies.find((x) => x.id === ev.id)!;
        this.fires.push({ time: ev.time, id: ev.id, origin: ev.origin, dir: ev.dir, player: pre, los: e.hasLineOfSight });
      } else if (ev.type === 'enemyTelegraph') this.telegraphs.push({ time: ev.time, id: ev.id });
      else if (ev.type === 'playerHit') this.playerHits.push({ time: ev.time, damage: ev.damage });
      else if (ev.type === 'hit' && ev.on === 'world') this.worldHits.push({ time: ev.time, pos: ev.pos });
    }
  }
  /** `before(g, T)` runs at the start of each tick (state at T), `after(g)` after it (state at T+dt) */
  run(seconds: number, before?: (g: Game, t: number) => void, after?: (g: Game) => void): void {
    const n = Math.round(seconds / DT);
    for (let i = 0; i < n; i++) {
      before?.(this.g, this.g.state.time);
      this.step();
      after?.(this.g);
    }
  }
  of(id: string): FireRec[] {
    return this.fires.filter((f) => f.id === id);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// (1) first attack, burst, period, telegraph
// ---------------------------------------------------------------------------------------------------------------------
describe('攻撃スケジュール (SPEC §2.3 表)', () => {
  it('警備ロボット: 射線取得0.50秒後に1発目 / バースト内0.12秒 / バースト開始1.20秒周期 / 予告0.15秒は周期に含まれる', () => {
    const g = makeGame({ enemies: [spawn('guard', 'G01', 0, -40)], player: { x: 0, z: 0 } });
    const rec = new Rec(g);
    const tele: { t: number; v: number }[] = [];
    rec.run(4, undefined, (gg) => tele.push({ t: gg.state.time - DT, v: enemy(gg, 'G01').telegraph }));
    const f = rec.fires;
    expect(f.length).toBe(9); // bursts at 0.5, 1.7, 2.9 (the next one starts at 4.1)
    expect(f[0].time).toBeCloseTo(0.5, 6); // t0 = 0 (line of sight from the first tick)
    for (let b = 0; b < 3; b++) {
      const start = 0.5 + b * GUARD.burstPeriod;
      for (let k = 0; k < GUARD.burstShots; k++) {
        const ft = f[b * 3 + k].time;
        const due = start + k * GUARD.burstShotInterval;
        expect(ft).toBeGreaterThanOrEqual(due - 1e-9);
        expect(ft).toBeLessThan(due + DT + 1e-9); // fired on the first tick at/after the scheduled time
      }
    }
    // period counts burst START to burst START (telegraph is inside the period, nothing is appended)
    expect(f[3].time - f[0].time).toBeCloseTo(GUARD.burstPeriod, 6);
    expect(f[6].time - f[3].time).toBeCloseTo(GUARD.burstPeriod, 6);
    // telegraph events sit exactly 0.15 s before each burst start
    expect(rec.telegraphs.map((x) => x.id)).toEqual(['G01', 'G01', 'G01', 'G01']);
    for (let b = 0; b < 3; b++) expect(f[b * 3].time - rec.telegraphs[b].time).toBeCloseTo(GUARD.telegraph, 6);
    // telegraph progress: 0 before the window, rising 0..1 inside it, 0 once the burst runs
    for (const s of tele) {
      if (s.t < 0.35 - 1e-9) expect(s.v).toBe(0);
      else if (s.t < 0.5 - 1e-9) expect(s.v).toBeCloseTo((s.t - 0.35) / GUARD.telegraph, 6);
      else if (s.t < 0.5 + 0.24) expect(s.v).toBe(0);
    }
    const e = enemy(g, 'G01');
    expect(e.shotsFired).toBe(9);
    expect(e.lastShotAt).toBeCloseTo(f[8].time, 9);
  });

  it('固定砲台: 0.70秒後に1発目 / バースト内0.25秒 / 1.60秒周期 / 予告0.35秒 / 移動しない', () => {
    const g = makeGame({ enemies: [spawn('turret', 'T01', 0, -60)], player: { x: 0, z: 0 } });
    const rec = new Rec(g);
    const home = { ...enemy(g, 'T01').pos };
    rec.run(4, undefined, (gg) => {
      const e = enemy(gg, 'T01');
      expect(e.vel).toEqual({ x: 0, y: 0, z: 0 });
      expect(e.pos).toEqual(home);
    });
    const f = rec.fires;
    expect(f.length).toBe(5); // bursts at 0.7, 2.3, 3.9
    expect(f[0].time).toBeCloseTo(0.7, 6);
    expect(f[1].time - f[0].time).toBeCloseTo(TURRET.burstShotInterval, 6);
    expect(f[2].time - f[0].time).toBeCloseTo(TURRET.burstPeriod, 6);
    expect(f[3].time - f[2].time).toBeCloseTo(TURRET.burstShotInterval, 6);
    expect(f[4].time - f[2].time).toBeCloseTo(TURRET.burstPeriod, 6);
    expect(rec.telegraphs.length).toBe(3);
    for (let b = 0; b < 3; b++) expect(f[[0, 2, 4][b]].time - rec.telegraphs[b].time).toBeCloseTo(TURRET.telegraph, 6);
    // bullets: 40 damage at 60 m/s, at most 2 per burst
    const dmg = new Set(rec.playerHits.map((h) => h.damage));
    for (const d of dmg) expect(d).toBe(TURRET.damage);
  });

  it('索敵距離: 銃口からプレイヤー中心まで警備90m / 砲台120m を超えると射線なし', () => {
    const cases: [string, 'guard' | 'turret', number, boolean][] = [
      ['G-in', 'guard', 89.9, true], ['G-out', 'guard', 90.1, false],
      ['T-in', 'turret', 119.9, true], ['T-out', 'turret', 120.1, false],
    ];
    for (const [id, kind, dist, expected] of cases) {
      const g = makeGame({ enemies: [spawn(kind, id, 0, -dist)], player: { x: 0, z: 0 }, floorHalf: 400 });
      g.step();
      expect(enemy(g, id).hasLineOfSight, id).toBe(expected);
      expect(enemy(g, id).alert, id).toBe(expected);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// (2) lead aiming
// ---------------------------------------------------------------------------------------------------------------------
describe('偏差射撃', () => {
  it('静止プレイヤー: 現在位置を狙い(誤差<=0.5度)、全弾が命中する', () => {
    const g = makeGame({ enemies: [spawn('guard', 'G01', 0, -40), spawn('turret', 'T01', 30, -50)], player: { x: 0, z: 0 } });
    const rec = new Rec(g);
    rec.run(5);
    expect(rec.fires.length).toBeGreaterThan(15);
    for (const f of rec.fires) {
      const toPlayer = subv(f.player.pos, f.origin);
      expect(angleDeg(f.dir, toPlayer)).toBeLessThanOrEqual(ENEMIES.MAX_AIM_JITTER_DEG + 1e-6);
      expect(lenv(f.dir)).toBeCloseTo(1, 9);
    }
    // every bullet that had time to arrive hit exactly once
    const arrived = rec.fires.filter((f) => f.time <= 5 - 1.4);
    expect(rec.playerHits.length).toBeGreaterThanOrEqual(arrived.length);
    expect(rec.playerHits.length).toBeLessThanOrEqual(rec.fires.length);
    // the jitter is real (not a fixed offset, not always zero)
    const angles = rec.fires.map((f) => angleDeg(f.dir, subv(f.player.pos, f.origin)));
    expect(new Set(angles.map((a) => a.toFixed(3))).size).toBeGreaterThan(5);
    expect(Math.max(...angles)).toBeGreaterThan(0.05);
  });

  it('等速で横移動するプレイヤー: 弾の到達時点の位置を狙う(定速迎撃解と一致・現在位置狙いではない)・命中する', () => {
    const g = makeGame({ enemies: [spawn('guard', 'G01', 0, -45)], player: { x: -20, z: 0 } });
    g.input.right = true; // real player movement: +x at 10 m/s
    const rec = new Rec(g);
    rec.run(5);
    const late = rec.fires.filter((f) => f.time >= 0.3);
    expect(late.length).toBeGreaterThanOrEqual(12);
    for (const f of late) {
      expect(f.player.vel.x).toBeGreaterThan(9.5);
      const sol = solveConstantSpeedIntercept(f.origin, f.player.pos, f.player.vel, GUARD.bulletSpeed, ENEMIES.MAX_PREDICT_T);
      expect(sol).not.toBeNull();
      expect(angleDeg(f.dir, sol!.direction)).toBeLessThanOrEqual(ENEMIES.MAX_AIM_JITTER_DEG + 1e-6);
      // it is NOT aimed at the position the player has now / had before
      expect(angleDeg(f.dir, subv(f.player.pos, f.origin))).toBeGreaterThan(3);
      // the bullet path passes through the predicted position within the jitter cone
      const flight = sol!.t;
      const end = { x: f.origin.x + f.dir.x * GUARD.bulletSpeed * flight, y: f.origin.y + f.dir.y * GUARD.bulletSpeed * flight, z: f.origin.z + f.dir.z * GUARD.bulletSpeed * flight };
      const predicted = { x: f.player.pos.x + f.player.vel.x * flight, y: f.player.pos.y + f.player.vel.y * flight, z: f.player.pos.z + f.player.vel.z * flight };
      expect(lenv(subv(end, predicted))).toBeLessThanOrEqual(Math.tan((ENEMIES.MAX_AIM_JITTER_DEG * Math.PI) / 180) * GUARD.bulletSpeed * flight + 1e-6);
    }
    // hits: every bullet fired early enough arrived and hit (constant velocity => the prediction is exact up to the jitter)
    const early = rec.fires.filter((f) => f.time <= 4);
    expect(rec.playerHits.length).toBeGreaterThanOrEqual(early.length);
  });

  it('予測時間の上限1.20秒: 迎撃解が無い距離では現在位置を狙い、解がある距離では先読みする', () => {
    // turret at 100 m: 60 m/s * 1.2 s = 72 m cannot reach a sidestepping target -> aim at the current position
    const far = makeGame({ enemies: [spawn('turret', 'T01', 0, -100)], player: { x: -20, z: 0 } });
    far.input.right = true;
    const recFar = new Rec(far);
    recFar.run(4);
    const farShots = recFar.fires.filter((f) => f.time >= 0.9);
    expect(farShots.length).toBeGreaterThanOrEqual(2);
    for (const f of farShots) {
      expect(f.player.vel.x).toBeGreaterThan(9.5);
      expect(solveConstantSpeedIntercept(f.origin, f.player.pos, f.player.vel, TURRET.bulletSpeed, ENEMIES.MAX_PREDICT_T)).toBeNull();
      expect(angleDeg(f.dir, subv(f.player.pos, f.origin))).toBeLessThanOrEqual(ENEMIES.MAX_AIM_JITTER_DEG + 1e-6);
    }
    // turret at 60 m: solution exists -> leads
    const near = makeGame({ enemies: [spawn('turret', 'T01', 0, -60)], player: { x: -20, z: 0 } });
    near.input.right = true;
    const recNear = new Rec(near);
    recNear.run(4);
    const nearShots = recNear.fires.filter((f) => f.time >= 0.9);
    expect(nearShots.length).toBeGreaterThanOrEqual(2);
    for (const f of nearShots) expect(angleDeg(f.dir, subv(f.player.pos, f.origin))).toBeGreaterThan(3);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// (3) occlusion, memory, pursuit
// ---------------------------------------------------------------------------------------------------------------------
describe('遮蔽・記憶・追跡', () => {
  it('壁の陰では撃たず警戒もしない (警備・砲台)', () => {
    const wall = box(-200, 0, -20, 200, 12, -18);
    const g = makeGame({ enemies: [spawn('guard', 'G01', 0, -40), spawn('turret', 'T01', 30, -50)], boxes: [wall], player: { x: 0, z: 0 } });
    const rec = new Rec(g);
    rec.run(5);
    expect(rec.fires.length).toBe(0);
    for (const e of g.state.enemies) {
      expect(e.hasLineOfSight).toBe(false);
      expect(e.alert).toBe(false);
      expect(e.shotsFired).toBe(0);
    }
    expect(g.state.enemyBullets.length).toBe(0);
  });

  it('射線を失うと撃たない / 8秒警戒を保つ / 即座に(0.5秒以内)最後の確認位置へ移動 / 8秒で解除して持ち場へ戻る / 透視しない', () => {
    // a wall wide enough that nothing can walk around it within the memory time
    const wall = switchable('blk', -100, 0, -16, 100, 12, -14);
    const g = makeGame({ enemies: [spawn('guard', 'G01', 0, -30)], boxes: [wall], player: { x: 0, z: 0 } });
    setEnabled(g, 'blk', false);
    const e = enemy(g, 'G01');
    const home = { ...e.pos };
    const lkp0 = { x: 0, y: PLAYER_Y, z: 0 };
    const rec = new Rec(g);
    interface Sample { t: number; los: boolean; alert: boolean; speed: number; mode: string; lkp: V3 | null; goal: V3 | null; pos: V3 }
    const samples: Sample[] = [];
    let teleported = false;
    rec.run(
      24,
      (gg, t) => {
        if (Math.abs(t - 1) < 1e-9) setEnabled(gg, 'blk', true); // cover appears at T = 1 s
        if (t >= 3 && !teleported) {
          // the player slips away behind a second wall; the guard must keep using the LAST CONFIRMED position
          teleported = true;
          gg.state.player.pos = { x: 0, y: PLAYER_Y, z: 40 };
        }
      },
      (gg) => {
        const ai = getEnemyAI(enemy(gg, 'G01'))!;
        const en = enemy(gg, 'G01');
        samples.push({ t: gg.state.time - DT, los: en.hasLineOfSight, alert: en.alert, speed: hspeed(en.vel), mode: ai.mode, lkp: ai.lastKnownPos ? { ...ai.lastKnownPos } : null, goal: ai.pathGoal ? { ...ai.pathGoal } : null, pos: { ...en.pos } });
      },
    );
    const lastLos = Math.max(...samples.filter((s) => s.los).map((s) => s.t));
    expect(lastLos).toBeGreaterThan(0.9);
    expect(lastLos).toBeLessThan(1.05);
    const lost = samples.filter((s) => s.t > lastLos + 1e-9);
    // no shot after the sight line was lost
    for (const f of rec.fires) expect(f.time).toBeLessThanOrEqual(lastLos + 1e-9);
    // alert kept for 8 s after the last confirmation, released right then
    const release = lost.find((s) => !s.alert)!;
    expect(release).toBeDefined();
    expect(release.t).toBeGreaterThanOrEqual(lastLos + 8 - 1e-6);
    expect(release.t).toBeLessThanOrEqual(lastLos + 8 + DT + 1e-6);
    for (const s of lost) if (s.t < release.t) expect(s.alert).toBe(true);
    // it keeps moving (approach speed) from the very first tick: starts within 0.5 s and never stands still while searching
    const searching = lost.filter((s) => s.t < release.t && s.mode === 'search');
    expect(searching.length).toBeGreaterThan(400);
    const firstMove = lost.find((s) => s.speed > 1)!;
    expect(firstMove.t - lastLos).toBeLessThanOrEqual(GUARD.reactSeconds);
    for (const s of searching) expect(s.speed).toBeGreaterThan(GUARD.approachSpeed - 0.1);
    // memory holds the position seen at the last confirmation, not the player's current (hidden) position
    for (const s of lost) {
      if (s.t >= release.t) continue;
      expect(s.lkp).not.toBeNull();
      expect(s.lkp!.x).toBeCloseTo(lkp0.x, 6);
      expect(s.lkp!.z).toBeCloseTo(lkp0.z, 6);
      expect(s.lkp!.y).toBeCloseTo(lkp0.y, 3);
      // the route it is following leads to the remembered position (its feet), never to where the player is now
      if (s.mode === 'search' && s.goal) {
        expect(s.goal.x).toBeCloseTo(lkp0.x, 6);
        expect(s.goal.z).toBeCloseTo(lkp0.z, 6);
      }
    }
    expect(g.state.player.pos.z).toBeCloseTo(40, 6);
    expect(getEnemyAI(e)!.lastKnownPos).toBeNull();
    // after the release it walks back to its post and waits there
    const end = samples[samples.length - 1];
    expect(Math.hypot(end.pos.x - home.x, end.pos.z - home.z)).toBeLessThan(HOME_TOL);
    expect(end.mode).toBe('idle');
  });

  it('壁の端を回り込んで射線を取り直す: 押し付き続けず、壁にめり込まず、取り直してから撃つ', () => {
    // guard sees the player, then a wall drops in between; the way around is ~25 m
    const wall = switchable('blk', -30, 0, -16, 6, 12, -14);
    const g = makeGame({ enemies: [spawn('guard', 'G01', -12, -30)], boxes: [wall], player: { x: -12, z: 0 } });
    setEnabled(g, 'blk', false);
    const rec = new Rec(g);
    const trace: { t: number; x: number; z: number; los: boolean; alert: boolean }[] = [];
    rec.run(
      8,
      (gg, t) => {
        if (Math.abs(t - 1) < 1e-9) setEnabled(gg, 'blk', true);
      },
      (gg) => {
        const en = enemy(gg, 'G01');
        trace.push({ t: gg.state.time, x: en.pos.x, z: en.pos.z, los: en.hasLineOfSight, alert: en.alert });
        // never inside a wall (hit sphere radius as an AABB)
        expect(gg.world.overlapAABB(en.pos, { x: GUARD.hitRadius, y: GUARD.hitRadius, z: GUARD.hitRadius }, 0.01)).toBe(false);
      },
    );
    const lostAt = trace.find((s) => s.t > 1.05 && !s.los)!.t;
    const regained = trace.find((s) => s.t > lostAt && s.los);
    expect(regained, 'sight line re-acquired').toBeDefined();
    expect(regained!.t - lostAt).toBeLessThan(GUARD.memorySeconds);
    // while searching it made real progress in every second (no pressing against the wall)
    for (let t0 = lostAt; t0 + 1 <= regained!.t; t0 += 0.5) {
      const a = trace.find((s) => s.t >= t0)!;
      const b = trace.find((s) => s.t >= t0 + 1)!;
      expect(Math.hypot(b.x - a.x, b.z - a.z), `progress ${t0.toFixed(1)}s`).toBeGreaterThan(4);
    }
    // it fires only after regaining sight
    for (const f of rec.fires.filter((x) => x.time > 1.05)) {
      expect(f.time).toBeGreaterThan(regained!.t - DT);
      expect(f.los).toBe(true);
    }
    expect(rec.fires.some((f) => f.time > regained!.t)).toBe(true);
  });

  it('迷路状の地形(コの字の部屋の裏側から開口部へ): 経路で回り込み、スタックしない', () => {
    // U-shaped room opening to the east; the player is inside, the guard starts behind the closed west side
    const walls = [
      box(-2, 0, -12, 0, 12, 12), // west (closed) side
      box(-2, 0, -12, 24, 12, -10), // north side
      box(-2, 0, 10, 24, 12, 12), // south side
    ];
    const door = switchable('door', -2, 0, -12, 0, 12, 12); // west wall opening used to give the guard first contact
    const g = makeGame({ enemies: [spawn('guard', 'G01', -14, 0)], boxes: [walls[1], walls[2], door], player: { x: 12, z: 0 } });
    setEnabled(g, 'door', false); // west side open at first: sight line through the room
    const rec = new Rec(g);
    const trace: { t: number; x: number; z: number; los: boolean }[] = [];
    let blockedTicks = 0;
    let worst = 0;
    rec.run(
      12,
      (gg, t) => {
        if (Math.abs(t - 0.5) < 1e-9) setEnabled(gg, 'door', true); // the west wall closes
      },
      (gg) => {
        const en = enemy(gg, 'G01');
        trace.push({ t: gg.state.time, x: en.pos.x, z: en.pos.z, los: en.hasLineOfSight });
        const ai = getEnemyAI(en)!;
        const want = Math.hypot(ai.cmdVx, ai.cmdVz);
        if (want > 0.5 && hspeed(en.vel) < want * 0.3) blockedTicks++;
        else blockedTicks = 0;
        worst = Math.max(worst, blockedTicks);
      },
    );
    expect(worst * DT).toBeLessThan(0.6);
    const lostAt = trace.find((s) => s.t > 0.55 && !s.los)!.t;
    const regained = trace.find((s) => s.t > lostAt + 0.1 && s.los);
    expect(regained, 'went around the U and re-acquired the player').toBeDefined();
    expect(regained!.t - lostAt).toBeLessThan(GUARD.memorySeconds);
    // it passed the open east side, not through the wall
    expect(regained!.x).toBeGreaterThan(20);
  });
});

describe('遮蔽中の追跡は最後の確認位置を使う(透視しない)', () => {
  it('遮蔽後にプレイヤーが反対側へ移動しても、警備は確認位置(西)へ向かい、現在位置(東)へは向かわない', () => {
    const wall = switchable('blk', -100, 0, -16, 100, 12, -14);
    const g = makeGame({ enemies: [spawn('guard', 'G01', 0, -30)], boxes: [wall], player: { x: -30, z: 0 } });
    setEnabled(g, 'blk', false);
    const e = enemy(g, 'G01');
    const rec = new Rec(g);
    rec.run(1, undefined, () => expect(e.hasLineOfSight).toBe(true));
    setEnabled(g, 'blk', true); // cover appears
    g.state.player.pos = { x: 30, y: PLAYER_Y, z: 0 }; // and the player relocates far to the east, still hidden
    rec.run(3);
    expect(e.hasLineOfSight).toBe(false);
    expect(e.alert).toBe(true);
    // the sighting was at x = -30 (west): it heads west along the wall (the player is now in the east)
    expect(e.pos.x).toBeLessThan(-8);
    expect(getEnemyAI(e)!.lastKnownPos!.x).toBeCloseTo(-30, 3);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// (4) the attack timer is not re-initialised by an occlusion
// ---------------------------------------------------------------------------------------------------------------------
describe('一瞬の遮蔽でタイマーをやり直さない', () => {
  const blockBetween = (): BoxDef => switchable('blk', -20, 0, -21, 20, 12, -19);

  it('初回待ち時間中の遮蔽(0.3〜0.4秒): 1発目は max(nextBurstAt=0.5, 再露出0.4+予告0.15)=0.55秒 (0.4+0.5 ではない)', () => {
    const g = makeGame({ enemies: [spawn('turret', 'T01', 0, -60), spawn('guard', 'G01', 0, -45)], boxes: [blockBetween()], player: { x: 0, z: 0 } });
    // the blocker sits at z=-20 between both enemies and the player (they never move sideways enough to see around it in 0.1 s)
    setEnabled(g, 'blk', false);
    const rec = new Rec(g);
    rec.run(
      2,
      (gg, t) => {
        if (Math.abs(t - 0.3) < 1e-9) setEnabled(gg, 'blk', true);
        if (Math.abs(t - 0.4) < 1e-9) setEnabled(gg, 'blk', false);
      },
    );
    const gf = rec.of('G01');
    expect(gf[0].time).toBeCloseTo(0.4 + GUARD.telegraph, 6); // 0.55, i.e. exposure + telegraph (> 0.5 held timer)
    expect(gf[0].time).toBeLessThan(0.4 + GUARD.firstAttackDelay - 0.2); // not restarted (would be 0.9)
    // the telegraph window is fully visible after the re-exposure
    const gt = rec.telegraphs.filter((t) => t.id === 'G01')[0];
    expect(gt.time).toBeGreaterThanOrEqual(0.4 - 1e-9);
    expect(gf[0].time - gt.time).toBeGreaterThanOrEqual(GUARD.telegraph - 1e-6);
    // turret: held timer 0.7 is later than exposure + telegraph (0.75)? -> exposure + 0.35 = 0.75
    const tf = rec.of('T01');
    expect(tf[0].time).toBeCloseTo(Math.max(0.7, 0.4 + TURRET.telegraph), 6);
  });

  it('バースト中の遮蔽: 遮蔽中の発は撃たず、再露出後も次バーストは保持された時刻(1.7秒)以降', () => {
    const g = makeGame({ enemies: [spawn('guard', 'G01', 0, -45)], boxes: [blockBetween()], player: { x: 0, z: 0 } });
    setEnabled(g, 'blk', false);
    const rec = new Rec(g);
    rec.run(
      2.2,
      (gg, t) => {
        if (Math.abs(t - 0.55) < 1e-9) setEnabled(gg, 'blk', true); // covers shots 2 and 3 of the first burst (0.62 / 0.74)
        if (Math.abs(t - 0.8) < 1e-9) setEnabled(gg, 'blk', false);
      },
    );
    const f = rec.of('G01');
    expect(f[0].time).toBeCloseTo(0.5, 6);
    for (const x of f) expect(x.time < 0.55 - 1e-9 || x.time >= 0.8 - 1e-9).toBe(true); // nothing fired while covered
    expect(f.length).toBeLessThanOrEqual(1 + 3 + 3);
    const second = f.find((x) => x.time > 0.8)!;
    expect(second.time).toBeCloseTo(0.5 + GUARD.burstPeriod, 6); // 1.7: schedule kept, not re-initialised
    for (const x of f) expect(x.los).toBe(true);
    // every shot that was fired had a valid sight line from the muzzle at that time
    for (const x of f) expect(g.world.segmentBlocked(x.origin, x.player.pos)).toBe(false);
  });

  it('十分に長い遮蔽の後も待ち時間は初回(0.5秒)に戻らず、予告0.15秒だけで再開する', () => {
    const g = makeGame({ enemies: [spawn('turret', 'T01', 0, -60)], boxes: [blockBetween()], player: { x: 0, z: 0 } });
    setEnabled(g, 'blk', false);
    const rec = new Rec(g);
    rec.run(
      6,
      (gg, t) => {
        if (Math.abs(t - 1) < 1e-9) setEnabled(gg, 'blk', true);
        if (Math.abs(t - 4) < 1e-9) setEnabled(gg, 'blk', false);
      },
    );
    const after = rec.of('T01').filter((f) => f.time >= 4);
    expect(after[0].time).toBeCloseTo(4 + TURRET.telegraph, 6);
    expect(rec.telegraphs.filter((t) => t.time >= 4)[0].time).toBeCloseTo(4, 6);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// (5) sharing
// ---------------------------------------------------------------------------------------------------------------------
describe('情報共有 (通路でつながる60m以内の味方警備のみ)', () => {
  it('経路長60m以内の味方だけが最後の確認位置を受け取り、壁越しには撃てない。遠方・隔離された敵は受け取らない', () => {
    // G_A sees the player. G_B: hidden behind a wall, ~30 m by route -> receives. G_C: 70 m away -> no.
    // G_D: 51 m in a straight line but sealed inside a walled room (no route) -> no.
    const hide = box(-40, 0, -16, -12, 12, -14);
    const room = [
      box(30, 0, -62, 70, 12, -60), box(30, 0, -40, 70, 12, -38), box(30, 0, -62, 32, 12, -38), box(68, 0, -62, 70, 12, -38),
    ];
    const g = makeGame({
      enemies: [
        spawn('guard', 'GA', 0, -40),
        spawn('guard', 'GB', -26, -28),
        spawn('guard', 'GC', 0, -115),
        spawn('guard', 'GD', 50, -50),
      ],
      boxes: [hide, ...room],
      player: { x: 0, z: 0 },
    });
    // GB is 28 m from GA and cannot see the player through `hide` (line (-26,-28) -> (0,0) crosses z=-15 at x=-14)
    const rec = new Rec(g);
    const losOf = (id: string) => enemy(g, id).hasLineOfSight;
    g.step();
    expect(losOf('GA')).toBe(true);
    expect(losOf('GB')).toBe(false);
    expect(enemy(g, 'GB').alert).toBe(true); // shared
    const aiB = getEnemyAI(enemy(g, 'GB'))!;
    expect(aiB.lastKnownPos).toEqual({ x: 0, y: PLAYER_Y, z: 0 });
    expect(aiB.lastSeenAt).toBeCloseTo(0, 9);
    expect(enemy(g, 'GC').alert).toBe(false);
    expect(enemy(g, 'GD').alert).toBe(false);
    expect(getEnemyAI(enemy(g, 'GC'))!.lastKnownPos).toBeNull();
    expect(getEnemyAI(enemy(g, 'GD'))!.lastKnownPos).toBeNull();
    // GB must not fire through the wall: every GB shot comes with a clear sight line at its fire time
    rec.run(6);
    for (const f of rec.of('GB')) {
      expect(f.los).toBe(true);
      expect(g.world.segmentBlocked(f.origin, f.player.pos)).toBe(false);
    }
    // GB walked to the sighting (approach speed) instead of standing still, GC / GD never woke up
    expect(enemy(g, 'GC').shotsFired).toBe(0);
    expect(enemy(g, 'GD').shotsFired).toBe(0);
    expect(enemy(g, 'GC').alert).toBe(false);
    expect(enemy(g, 'GD').alert).toBe(false);
  });

  it('共有を受けた警備は移動して射線を取り直す (自分に射線がない間は撃たない)', () => {
    const hide = box(-40, 0, -16, -12, 12, -14);
    const g = makeGame({ enemies: [spawn('guard', 'GA', 0, -40), spawn('guard', 'GB', -26, -28)], boxes: [hide], player: { x: 0, z: 0 } });
    const rec = new Rec(g);
    const b = enemy(g, 'GB');
    let firstLosB = -1;
    const before = { ...b.pos };
    let moved = 0;
    rec.run(6, undefined, (gg) => {
      if (b.hasLineOfSight && firstLosB < 0) firstLosB = gg.state.time;
      if (firstLosB < 0) {
        expect(b.shotsFired).toBe(0);
        moved = Math.max(moved, Math.hypot(b.pos.x - before.x, b.pos.z - before.z));
      }
    });
    expect(firstLosB).toBeGreaterThan(0);
    expect(moved).toBeGreaterThan(1); // it went looking for the player
    expect(b.shotsFired).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// (6) enemy bullets: swept collision
// ---------------------------------------------------------------------------------------------------------------------
describe('敵弾: 掃引衝突', () => {
  function bullet(s: GameState, pos: V3, vel: V3, o: Partial<EnemyBullet> = {}): EnemyBullet {
    const b: EnemyBullet = {
      id: s.nextProjectileId++, ownerId: 'G01', kind: 'guard', pos: { ...pos }, prevPos: { ...pos }, vel: { ...vel },
      age: 0, maxLife: 2, damage: GUARD.damage, radius: GUARD.bulletRadius, alive: true, ...o,
    };
    s.enemyBullets.push(b);
    return b;
  }
  const setPlayer = (s: GameState, prev: V3, cur: V3): void => {
    s.player.prevPos = { ...prev };
    s.player.pos = { ...cur };
  };
  const empty = (): Game => makeGame({ enemies: [], floorHalf: 0, player: { x: 0, z: 100 }, hp: 1000 });

  it('高速でも薄い壁をすり抜けない (壁で止まり、壁側にhitイベント)', () => {
    const g = makeGame({ enemies: [], boxes: [box(10, 0, -5, 10.2, 8, 5)], player: { x: 30, z: 0 }, hp: 1000 });
    const s = g.state;
    const b = bullet(s, { x: 0, y: 3, z: 0 }, { x: 3000, y: 0, z: 0 }); // 25 m per tick
    stepEnemyBullets(s, g.world);
    expect(b.alive).toBe(false);
    expect(s.enemyBullets.length).toBe(0);
    expect(b.pos.x).toBeCloseTo(10 - GUARD.bulletRadius, 6);
    expect(s.player.hp).toBe(1000);
    const ev = s.events.filter((e) => e.type === 'hit');
    expect(ev.length).toBe(1);
    expect(ev[0]).toMatchObject({ type: 'hit', on: 'world', weapon: 'enemy' });
  });

  it('壁が間にあればプレイヤーへは当たらない / 壁の手前のプレイヤーには当たる', () => {
    const g = makeGame({ enemies: [], boxes: [box(10, 0, -5, 12, 8, 5)], player: { x: 0, z: 0 }, hp: 1000 });
    const s = g.state;
    setPlayer(s, { x: 20, y: 1.5, z: 0 }, { x: 20, y: 1.5, z: 0 });
    const b1 = bullet(s, { x: 3, y: 1.5, z: 0 }, { x: 900, y: 0, z: 0 }); // reaches the wall (4 tick worth of range not needed: 7.5 m/tick)
    stepEnemyBullets(s, g.world);
    expect(b1.alive).toBe(false);
    expect(s.player.hp).toBe(1000);
    // player in front of the wall: hit, once
    setPlayer(s, { x: 6, y: 1.5, z: 0 }, { x: 6, y: 1.5, z: 0 });
    const b2 = bullet(s, { x: 0, y: 1.5, z: 0 }, { x: 900, y: 0, z: 0 });
    stepEnemyBullets(s, g.world);
    expect(b2.alive).toBe(false);
    expect(s.player.hp).toBe(1000 - GUARD.damage);
  });

  it('移動するプレイヤーのAABBとの相対運動で判定する (開始位置固定/終了位置固定の判定では取り逃がす/誤命中するケース)', () => {
    // player runs +x at 80 m/s (0.667 m per tick); a 300 m/s bullet crosses its z-extent during the tick
    const g = empty();
    const s = g.state;
    const run = (bx: number): boolean => {
      s.enemyBullets.length = 0;
      s.player.hp = 1000;
      setPlayer(s, { x: 9, y: 1.5, z: 0 }, { x: 9 + 80 * DT, y: 1.5, z: 0 });
      bullet(s, { x: bx, y: 1.5, z: -1.25 }, { x: 0, y: 0, z: 300 });
      stepEnemyBullets(s, g.world);
      return s.player.hp < 1000;
    };
    expect(run(8.3)).toBe(true); // inside the START box only
    expect(run(10.35)).toBe(true); // inside the END box only
    expect(run(7.9)).toBe(false);
    expect(run(10.8)).toBe(false);
  });

  it('掃引判定は細かいサンプリングによる基準判定と一致する (3000ケース・高速プレイヤーと高速弾)', () => {
    const g = empty();
    const s = g.state;
    const rng = new Rng(12345);
    const H = PLAYER.HALF;
    const r = GUARD.bulletRadius;
    let hits = 0;
    let checked = 0;
    for (let i = 0; i < 3000; i++) {
      const prev = { x: rng.range(-3, 3), y: rng.range(1, 3), z: rng.range(-3, 3) };
      const disp = { x: rng.range(-1.2, 1.2), y: rng.range(-0.5, 0.5), z: rng.range(-1.2, 1.2) }; // up to ~ 140 m/s
      const cur = { x: prev.x + disp.x, y: prev.y + disp.y, z: prev.z + disp.z };
      const from = { x: rng.range(-7, 7), y: rng.range(0.5, 4), z: rng.range(-7, 7) };
      const speed = rng.range(70, 900);
      const th = rng.range(0, Math.PI * 2);
      const ph = rng.range(-0.6, 0.6);
      const vel = { x: Math.cos(th) * Math.cos(ph) * speed, y: Math.sin(ph) * speed, z: Math.sin(th) * Math.cos(ph) * speed };
      // reference: dense sampling of both trajectories over the tick
      const N = 6000;
      const overlap = (m: number): boolean => {
        for (let k = 0; k <= N; k++) {
          const t = k / N;
          const bx = from.x + vel.x * DT * t;
          const by = from.y + vel.y * DT * t;
          const bz = from.z + vel.z * DT * t;
          const cx = prev.x + disp.x * t;
          const cy = prev.y + disp.y * t;
          const cz = prev.z + disp.z * t;
          if (Math.abs(bx - cx) <= H.x + r + m && Math.abs(by - cy) <= H.y + r + m && Math.abs(bz - cz) <= H.z + r + m) return true;
        }
        return false;
      };
      const strict = overlap(-0.02); // clearly overlapping
      const loose = overlap(0.02); // clearly not overlapping if false
      if (strict !== loose) continue; // borderline: skip
      s.enemyBullets.length = 0;
      s.player.hp = 1000;
      setPlayer(s, prev, cur);
      bullet(s, from, vel);
      stepEnemyBullets(s, g.world);
      const hit = s.player.hp < 1000;
      expect(hit, `case ${i}`).toBe(strict);
      checked++;
      if (hit) hits++;
    }
    expect(checked).toBeGreaterThan(2500);
    expect(hits).toBeGreaterThan(100);
    expect(hits).toBeLessThan(checked - 100);
  });

  it('1発につきダメージは1回だけ。弾は消え、同じ弾が次のtickで再び当たらない / 2発なら2回', () => {
    const g = empty();
    const s = g.state;
    setPlayer(s, { x: 0, y: 1.5, z: 0 }, { x: 0, y: 1.5, z: 0 });
    const a = bullet(s, { x: -3, y: 1.5, z: 0 }, { x: 70, y: 0, z: 0 });
    for (let i = 0; i < 300; i++) {
      // the bullet flies through the player's box over several ticks
      s.player.prevPos = { ...s.player.pos };
      stepEnemyBullets(s, g.world);
    }
    expect(s.player.hp).toBe(1000 - GUARD.damage);
    expect(a.alive).toBe(false);
    expect(s.enemyBullets.length).toBe(0);
    expect(s.events.filter((e) => e.type === 'playerHit').length).toBe(1);
    expect(s.events.filter((e) => e.type === 'hit' && e.on === 'player' && e.weapon === 'enemy').length).toBe(1);
    // two bullets, two hits
    s.player.hp = 1000;
    bullet(s, { x: 0, y: 1.5, z: 0.5 }, { x: 0, y: 0, z: -1 });
    bullet(s, { x: 0.2, y: 1.5, z: 0.3 }, { x: 0, y: 0, z: -1 });
    stepEnemyBullets(s, g.world);
    expect(s.player.hp).toBe(1000 - 2 * GUARD.damage);
    // damage indicator points to where the shot came from
    const di = s.damageIndicators[s.damageIndicators.length - 1];
    expect(di.damage).toBe(GUARD.damage);
    expect(lenv(di.dirToSource)).toBeCloseTo(1, 9);
  });

  it('敵同士には当たらない (弾は敵を素通りする)', () => {
    const g = makeGame({ enemies: [spawn('guard', 'GX', 20, 0)], player: { x: 200, z: 0 }, hp: 1000 });
    const s = g.state;
    const victim = enemy(g, 'GX');
    victim.alert = false;
    const b = bullet(s, { x: 0, y: victim.pos.y, z: 0 }, { x: 70, y: 0, z: 0 });
    for (let i = 0; i < 120; i++) {
      stepEnemyBullets(s, g.world); // direct: only the bullet stage
      if (!b.alive) break;
    }
    expect(victim.hp).toBe(GUARD.hp);
    expect(b.pos.x).toBeGreaterThan(20 + victim.hitRadius); // flew through the enemy's sphere
  });

  it('寿命の最後の区間まで判定してから消す (期限切れ・届かない弾は無害に削除)', () => {
    const g = empty();
    const s = g.state;
    const P: V3 = { x: 10, y: 1.5, z: 0 };
    const mk = (x: number, extra: Partial<EnemyBullet> = {}): EnemyBullet =>
      bullet(s, { x, y: 1.5, z: 0 }, { x: 60, y: 0, z: 0 }, { kind: 'turret', damage: TURRET.damage, radius: TURRET.bulletRadius, maxLife: 3, age: 3 - 0.004, ...extra });
    // inflated player box starts at x = 10 - 0.8 - 0.25 = 8.95. 0.004 s of life = 0.24 m of reach.
    setPlayer(s, P, P);
    const inReach = mk(8.75); // 0.2 m from the box: reached in the last partial interval
    stepEnemyBullets(s, g.world);
    expect(inReach.alive).toBe(false);
    expect(s.player.hp).toBe(1000 - TURRET.damage);
    s.player.hp = 1000;
    const outOfReach = mk(8.6); // 0.35 m from the box: not reached, but still removed at the end of its life
    stepEnemyBullets(s, g.world);
    expect(s.player.hp).toBe(1000);
    expect(outOfReach.alive).toBe(false);
    expect(s.enemyBullets.length).toBe(0);
    // a bullet whose life is already used up is dropped without effect
    mk(9, { age: 3 });
    stepEnemyBullets(s, g.world);
    expect(s.enemyBullets.length).toBe(0);
    expect(s.player.hp).toBe(1000);
  });

  it('生成直後の弾もそのtickで1dtだけ進む / 直進・重力なし・誘導なし (プレイヤーが動いても軌道は変わらない)', () => {
    const g = makeGame({ enemies: [spawn('turret', 'T01', 0, -60)], player: { x: 0, z: 0 } });
    g.input.right = true; // the player moves the whole time
    let origin: V3 | null = null;
    while (origin === null) {
      g.step();
      for (const ev of g.drainEvents()) if (ev.type === 'enemyFire') origin = ev.origin;
    }
    const b = g.state.enemyBullets[0];
    expect(b.age).toBeCloseTo(DT, 12); // advanced by exactly one tick in the tick it was created
    expect(lenv(subv(b.pos, origin))).toBeCloseTo(TURRET.bulletSpeed * DT, 9);
    const v0 = { ...b.vel };
    expect(lenv(v0)).toBeCloseTo(TURRET.bulletSpeed, 9);
    for (let i = 0; i < 40; i++) {
      g.step();
      g.drainEvents();
      if (!b.alive) break;
      expect(b.vel).toEqual(v0); // no gravity, no homing
      const expected = { x: origin.x + v0.x * b.age, y: origin.y + v0.y * b.age, z: origin.z + v0.z * b.age };
      expect(lenv(subv(b.pos, expected))).toBeLessThan(1e-9);
    }
    expect(b.alive).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// (7) independence
// ---------------------------------------------------------------------------------------------------------------------
describe('全敵が独立して攻撃する', () => {
  it('同時に複数が攻撃 / カメラ外(背後)の敵も攻撃 / プレイヤーが撃たなくても攻撃', () => {
    const g = makeGame({
      enemies: [spawn('guard', 'G01', 0, -40), spawn('guard', 'G02', 40, 40), spawn('guard', 'G03', -40, 40), spawn('turret', 'T01', 0, -70)],
      player: { x: 0, z: 0 },
      yaw: 0, // the camera looks along -Z: G02 / G03 are behind it
    });
    const s = g.state;
    for (const id of ['G02', 'G03']) expect(dotv(subv(enemy(g, id).pos, s.camera.pos), s.camera.forward)).toBeLessThan(0);
    const rec = new Rec(g);
    rec.run(3);
    const ids = new Set(rec.fires.map((f) => f.id));
    expect([...ids].sort()).toEqual(['G01', 'G02', 'G03', 'T01']);
    // at least three enemies fire within the same 0.3 s window (no "one attacker at a time")
    const together = rec.fires.some((f) => new Set(rec.fires.filter((x) => x.time >= f.time && x.time <= f.time + 0.3).map((x) => x.id)).size >= 3);
    expect(together).toBe(true);
    // the player never fired: nothing of the player's was needed to trigger any of it
    expect(s.input.fire).toBe(false);
    expect(s.bullets.length + s.missiles.length).toBe(0);
    expect(s.player.ammo.machinegun).toBe(300);
  });

  it('攻撃タイマーは敵ごとに独立 (射線を得た時刻から各自 0.70秒後に開始)', () => {
    const blk = (id: string, cx: number) => switchable(id, cx - 8, 0, -31, cx + 8, 12, -29);
    const g = makeGame({
      enemies: [spawn('turret', 'T01', 0, -60), spawn('turret', 'T02', 60, -60), spawn('turret', 'T03', -60, -60)],
      boxes: [blk('b1', 0), blk('b2', 30), blk('b3', -30)],
      player: { x: 0, z: 0 },
    });
    setEnabled(g, 'b1', false); // T01 sees the player from the start; T02/T03 are covered by b2/b3
    const rec = new Rec(g);
    rec.run(
      3,
      (gg, t) => {
        if (Math.abs(t - 0.3) < 1e-9) setEnabled(gg, 'b2', false);
        if (Math.abs(t - 1.0) < 1e-9) setEnabled(gg, 'b3', false);
      },
    );
    expect(rec.of('T01')[0].time).toBeCloseTo(0.7, 6);
    expect(rec.of('T02')[0].time).toBeCloseTo(0.3 + TURRET.firstAttackDelay, 6);
    expect(rec.of('T03')[0].time).toBeCloseTo(1.0 + TURRET.firstAttackDelay, 6);
    expect(rec.of('T01')[2].time).toBeCloseTo(0.7 + TURRET.burstPeriod, 6);
    expect(rec.of('T02')[2].time).toBeCloseTo(0.3 + TURRET.firstAttackDelay + TURRET.burstPeriod, 6);
  });

  it('低HPでも攻撃を弱めない (HP1000 と HP1 で発射時刻・方向が同一)', () => {
    const run = (hp: number) => {
      const g = makeGame({ enemies: [spawn('guard', 'G01', 0, -60), spawn('turret', 'T01', 20, -80)], player: { x: 0, z: 0 }, hp });
      const rec = new Rec(g);
      rec.run(1.3);
      return rec.fires.map((f) => ({ time: f.time, id: f.id, dir: f.dir, origin: f.origin }));
    };
    const full = run(1000);
    const low = run(1);
    expect(full.length).toBeGreaterThanOrEqual(4);
    expect(low).toEqual(full);
  });

  it('再出撃(retry)で敵の攻撃タイマー・警戒記憶が初期化され、navキャッシュは再利用される', () => {
    const g = makeGame({ enemies: [spawn('guard', 'G01', 0, -40)], player: { x: 0, z: 0 } });
    const nav1 = getNav(g.world, g.stage);
    const rec = new Rec(g);
    rec.run(3);
    expect(rec.fires.length).toBeGreaterThan(3);
    g.retry();
    g.state.player.hp = 1e9;
    expect(enemy(g, 'G01').shotsFired).toBe(0);
    expect(getEnemyAI(enemy(g, 'G01'))).toBeUndefined();
    const rec2 = new Rec(g);
    rec2.run(1);
    expect(rec2.fires[0].time).toBeCloseTo(0.5, 6); // first attack delay again
    expect(getNav(g.world, g.stage)).toBe(nav1);
  });
});

describe('時間の進み方', () => {
  it('一時停止中は敵のタイマー・弾・警戒記憶が進まず、再開後は停止前の続きから', () => {
    const g = makeGame({ enemies: [spawn('guard', 'G01', 0, -40)], player: { x: 0, z: 0 } });
    const rec = new Rec(g);
    rec.run(0.3);
    g.pause();
    expect(g.advance(10)).toBe(0); // paused: nothing advances however much real time passes
    expect(g.state.time).toBeCloseTo(0.3, 9);
    expect(enemy(g, 'G01').shotsFired).toBe(0);
    g.resume();
    g.state.player.hp = 1e9;
    rec.run(0.6);
    expect(rec.fires[0].time).toBeCloseTo(0.5, 6); // game time, unaffected by the pause
  });

  it('描画フレームレート(30/60/120fps)が違っても敵の発射時刻・方向・移動は同一 (固定1/120秒ステップ)', () => {
    const run = (fps: number) => {
      const g = makeGame({ enemies: [spawn('guard', 'G01', 0, -40), spawn('turret', 'T01', 30, -60)], player: { x: 0, z: 0 } });
      let elapsed = 0;
      const fires: { time: number; id: string; dir: V3 }[] = [];
      while (elapsed < 3 - 1e-9) {
        g.advance(1 / fps);
        elapsed += 1 / fps;
        for (const ev of g.drainEvents()) if (ev.type === 'enemyFire') fires.push({ time: ev.time, id: ev.id, dir: ev.dir });
      }
      return { fires, tick: g.state.tick, pos: { ...enemy(g, 'G01').pos } };
    };
    const a = run(120);
    const b = run(60);
    const c = run(30);
    expect(a.fires.length).toBeGreaterThan(6);
    expect(b.tick).toBe(a.tick);
    expect(c.tick).toBe(a.tick);
    expect(b.fires).toEqual(a.fires);
    expect(c.fires).toEqual(a.fires);
    expect(b.pos).toEqual(a.pos);
    expect(c.pos).toEqual(a.pos);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// (8) aggressiveness
// ---------------------------------------------------------------------------------------------------------------------
describe('積極性試験 (SPEC §2.3 末尾)', () => {
  it('HP1000で静止するプレイヤーは、35〜50mの警備2体+固定砲台1体(遮蔽なし)に攻撃可能から15秒以内に撃破される', () => {
    const g = makeGame({
      enemies: [spawn('guard', 'G01', 35, 0), spawn('guard', 'G02', -35, -35), spawn('turret', 'T01', 0, -45)],
      player: { x: 0, z: 0 },
      hp: PLAYER.MAX_HP,
    });
    const s = g.state;
    const dists = s.enemies.map((e) => Math.hypot(e.pos.x - s.player.pos.x, e.pos.z - s.player.pos.z));
    for (const d of dists) {
      expect(d).toBeGreaterThanOrEqual(35);
      expect(d).toBeLessThanOrEqual(50);
    }
    const rec = new Rec(g);
    let attackableAt = -1;
    let guardHits = 0;
    let turretHits = 0;
    for (let i = 0; i < Math.round(20 / DT) && s.mode === 'playing'; i++) {
      rec.step();
      if (attackableAt < 0 && s.enemies.every((e) => e.hasLineOfSight)) attackableAt = 0; // all three had a clear sight line from tick 0
    }
    guardHits = rec.playerHits.filter((h) => h.damage === GUARD.damage).length;
    turretHits = rec.playerHits.filter((h) => h.damage === TURRET.damage).length;
    expect(attackableAt).toBe(0);
    expect(s.mode).toBe('failed');
    expect(s.endReason).toBe('hp');
    expect(s.player.hp).toBe(0);
    const killTime = s.time; // seconds since they could attack (line of sight from the first tick)
    console.info(`[aggressiveness] player HP 1000 -> 0 at t = ${killTime.toFixed(3)} s (guard hits ${guardHits}, turret hits ${turretHits}, shots ${rec.fires.length})`);
    expect(killTime).toBeLessThanOrEqual(15);
    // the damage came from ordinary enemy bullets only
    expect(s.damageTaken).toBe(guardHits * GUARD.damage + turretHits * TURRET.damage);
    expect(s.damageTaken).toBeGreaterThanOrEqual(PLAYER.MAX_HP);
  });
});

describe('積極性試験: 配置を変えても15秒以内 (seed付き乱数の12配置)', () => {
  it('35〜50mの任意の方位に置いた警備2体+固定砲台1体は、HP1000の静止プレイヤーを全配置で15秒以内に撃破する', () => {
    const rng = new Rng(777);
    const times: number[] = [];
    for (let n = 0; n < 12; n++) {
      const at = (id: string, kind: 'guard' | 'turret'): EnemySpawn => {
        const d = rng.range(35, 50);
        const a = rng.range(0, Math.PI * 2);
        return spawn(kind, id, Math.cos(a) * d, Math.sin(a) * d);
      };
      const g = makeGame({ enemies: [at('G01', 'guard'), at('G02', 'guard'), at('T01', 'turret')], player: { x: 0, z: 0 }, yaw: rng.range(0, 6), hp: PLAYER.MAX_HP });
      const s = g.state;
      for (let i = 0; i < Math.round(20 / DT) && s.mode === 'playing'; i++) {
        g.step();
        g.drainEvents();
      }
      expect(s.mode, `arrangement ${n}`).toBe('failed');
      times.push(s.time);
    }
    console.info(`[aggressiveness x12] kill time min ${Math.min(...times).toFixed(2)} s, max ${Math.max(...times).toFixed(2)} s`);
    expect(Math.max(...times)).toBeLessThanOrEqual(15);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// (9) guard movement speeds, dead / scripted enemies
// ---------------------------------------------------------------------------------------------------------------------
describe('警備ロボットの移動', () => {
  interface Tick { t: number; d: number; speed: number; radial: number; vy: number }
  function trace(dist: number, seconds: number, extra: Partial<Scene> = {}): { g: Game; ticks: Tick[] } {
    const g = makeGame({ enemies: [spawn('guard', 'G01', 0, -dist)], player: { x: 0, z: 0 }, ...extra });
    const e = enemy(g, 'G01');
    const ticks: Tick[] = [];
    const n = Math.round(seconds / DT);
    for (let i = 0; i < n; i++) {
      const p = { ...e.pos };
      g.step();
      g.drainEvents();
      // vel is the velocity actually used for the position update
      expect(Math.abs(e.pos.x - e.prevPos.x - e.vel.x * DT)).toBeLessThan(1e-9);
      expect(Math.abs(e.pos.z - e.prevPos.z - e.vel.z * DT)).toBeLessThan(1e-9);
      const dx = g.state.player.pos.x - p.x;
      const dz = g.state.player.pos.z - p.z;
      const d = Math.hypot(dx, dz);
      ticks.push({ t: g.state.time, d, speed: hspeed(e.vel), radial: (e.vel.x * dx + e.vel.z * dz) / d, vy: e.vel.y });
    }
    return { g, ticks };
  }

  it('距離55m超: 8m/sで接近する', () => {
    const { ticks } = trace(70, 1.5);
    for (const k of ticks) {
      expect(k.speed).toBeCloseTo(GUARD.approachSpeed, 6);
      expect(k.radial).toBeGreaterThan(GUARD.approachSpeed - 1e-6); // straight at the player on open ground
      expect(k.vy).toBe(0);
    }
    expect(ticks[0].d - ticks[ticks.length - 1].d).toBeCloseTo(GUARD.approachSpeed * DT * (ticks.length - 1), 6);
  });

  it('距離25〜55m: 6m/sの側方移動で射線を変え、向きを切り替える', () => {
    const { ticks } = trace(40, 14);
    let flips = 0;
    let lastSign = 0;
    for (const k of ticks) {
      expect(k.speed).toBeCloseTo(GUARD.strafeSpeed, 6);
      expect(k.d).toBeGreaterThanOrEqual(GUARD.midDist);
      expect(k.d).toBeLessThanOrEqual(GUARD.farDist);
      expect(Math.abs(k.radial)).toBeLessThan(GUARD.strafeSpeed * 0.75); // mostly lateral
    }
    // direction of the lateral motion: sample the guard's x velocity sign (player is at the origin, guard on -Z)
    const g2 = makeGame({ enemies: [spawn('guard', 'G01', 0, -40)], player: { x: 0, z: 0 } });
    for (let i = 0; i < 14 * 120; i++) {
      g2.step();
      g2.drainEvents();
      const sx = Math.sign(enemy(g2, 'G01').vel.x);
      if (sx !== 0 && sx !== lastSign) {
        if (lastSign !== 0) flips++;
        lastSign = sx;
      }
    }
    expect(flips).toBeGreaterThanOrEqual(3);
  });

  it('距離15m未満: 8m/sを上限に距離を取る / 15〜25m: 距離を調整(8m/s以下)しながら遠ざかる', () => {
    const near = trace(10, 1);
    const inNear = near.ticks.filter((k) => k.d < GUARD.nearDist);
    expect(inNear.length).toBeGreaterThan(30);
    for (const k of inNear) {
      expect(k.speed).toBeLessThanOrEqual(GUARD.retreatMaxSpeed + 1e-6);
      expect(k.speed).toBeGreaterThan(GUARD.retreatMaxSpeed - 1e-6);
      expect(k.radial).toBeLessThan(0);
    }
    for (const k of near.ticks) expect(k.speed).toBeLessThanOrEqual(GUARD.retreatMaxSpeed + 1e-6);
    expect(near.ticks[near.ticks.length - 1].d).toBeGreaterThan(near.ticks[0].d + 5);
    const mid = trace(20, 1);
    for (const k of mid.ticks) {
      expect(k.speed).toBeLessThanOrEqual(GUARD.retreatMaxSpeed + 1e-6);
      expect(k.speed).toBeGreaterThan(1);
    }
    expect(mid.ticks[mid.ticks.length - 1].d).toBeGreaterThan(mid.ticks[0].d + 1);
  });

  it('死亡した敵は動かず撃たない (既に発射された弾はそのまま飛ぶ)', () => {
    const g = makeGame({ enemies: [spawn('guard', 'G01', 0, -40), spawn('turret', 'T01', 30, -50)], player: { x: 0, z: 0 } });
    const rec = new Rec(g);
    rec.run(0.55);
    expect(rec.of('G01').length).toBeGreaterThan(0);
    const shotsBefore = rec.fires.length;
    const g01 = enemy(g, 'G01');
    const t01 = enemy(g, 'T01');
    expect(damageEnemy(g.state, g01, 1e9, 'machinegun')).toBe(true);
    expect(damageEnemy(g.state, t01, 1e9, 'machinegun')).toBe(true);
    const frozen = { ...g01.pos };
    const inFlight = g.state.enemyBullets.length;
    expect(inFlight).toBeGreaterThan(0);
    rec.run(4);
    expect(rec.fires.length).toBe(shotsBefore);
    expect(g01.pos).toEqual(frozen);
    expect(g01.vel).toEqual({ x: 0, y: 0, z: 0 });
    expect(g01.alert).toBe(false);
    expect(g01.hasLineOfSight).toBe(false);
    expect(g01.telegraph).toBe(0);
    expect(rec.playerHits.length).toBeGreaterThan(0); // the bullets that were already flying still arrive
  });

  it('scripted=true の敵はAI・射撃なしで vel の等速直線運動 (vel = 位置更新に使った速度)', () => {
    const g = makeGame({ enemies: [spawn('guard', 'G01', 0, -40)], player: { x: 0, z: 0 } });
    const e = enemy(g, 'G01');
    e.scripted = true;
    e.vel = { x: 3, y: 0, z: 4 };
    const start = { ...e.pos };
    const rec = new Rec(g);
    rec.run(1);
    expect(rec.fires.length).toBe(0);
    expect(e.shotsFired).toBe(0);
    expect(e.hasLineOfSight).toBe(false);
    expect(e.alert).toBe(false);
    expect(e.vel).toEqual({ x: 3, y: 0, z: 4 });
    expect(e.pos.x - start.x).toBeCloseTo(3, 9);
    expect(e.pos.z - start.z).toBeCloseTo(4, 9);
    expect(e.pos.y).toBe(start.y);
  });
});

describe('警備ロボットの待機・配置・隊列', () => {
  it('巡回経路(patrol)を持つ警備は未警戒の間それを周回し、プレイヤーを見つけたら交戦する', () => {
    const g = makeGame({
      enemies: [{ ...spawn('guard', 'G01', 0, -150), patrol: [{ x: 0, y: GUARD.centerHeight, z: -150 }, { x: 40, y: GUARD.centerHeight, z: -150 }] }],
      player: { x: 0, z: 0 },
    });
    const e = enemy(g, 'G01');
    const rec = new Rec(g);
    let maxX = -Infinity;
    let minAfterPeak = Infinity;
    rec.run(30, undefined, () => {
      maxX = Math.max(maxX, e.pos.x);
      if (maxX > 38) minAfterPeak = Math.min(minAfterPeak, e.pos.x);
      if (hspeed(e.vel) > 0) expect(hspeed(e.vel)).toBeCloseTo(GUARD.strafeSpeed * 0.5, 6);
      expect(e.alert).toBe(false);
    });
    expect(maxX).toBeGreaterThan(38);
    expect(minAfterPeak).toBeLessThan(4);
    expect(rec.fires.length).toBe(0);
    // the player shows up in range: it stops patrolling and fights
    g.state.player.pos = { x: e.pos.x, y: PLAYER_Y, z: e.pos.z + 50 };
    rec.run(2);
    expect(e.alert).toBe(true);
    expect(rec.fires.length).toBeGreaterThan(0);
  });

  it('壁にめり込んだスポーンは、身体が入る最寄りの位置へ寄せられ、その後は普通に動く', () => {
    const wall = box(10, 0, -200, 12, 12, 200);
    const g = makeGame({ enemies: [spawn('guard', 'G01', 9.0, -60)], boxes: [wall], player: { x: 0, z: 0 } }); // 1.0 m from the wall face: closer than the hit radius + clearance
    const e = enemy(g, 'G01');
    const before = { ...e.pos };
    g.step();
    expect(Math.hypot(e.pos.x - before.x, e.pos.z - before.z)).toBeGreaterThan(0.1);
    expect(Math.hypot(e.pos.x - before.x, e.pos.z - before.z)).toBeLessThan(6);
    expect(g.world.overlapAABB(e.pos, { x: GUARD.hitRadius, y: GUARD.hitRadius, z: GUARD.hitRadius }, 0.01)).toBe(false);
    const rec = new Rec(g);
    rec.run(3);
    expect(hspeed(e.vel)).toBeGreaterThan(5); // it walks (approach / strafe)
    expect(getEnemyAI(e)!.movable).toBe(true);
  });

  it('重なった警備同士は押し合って離れ、速度は変わらない(隊列が1点に固まらない)', () => {
    const g = makeGame({ enemies: [spawn('guard', 'G01', 0, -70), spawn('guard', 'G02', 0.4, -70), spawn('guard', 'G03', 0, -70)], player: { x: 0, z: 0 } });
    const a = enemy(g, 'G01');
    const b = enemy(g, 'G02');
    const c = enemy(g, 'G03');
    const rec = new Rec(g);
    rec.run(1.5, undefined, () => {
      for (const e of [a, b, c]) expect(hspeed(e.vel)).toBeCloseTo(GUARD.approachSpeed, 6); // still 8 m/s toward the player
    });
    const dab = Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z);
    const dac = Math.hypot(a.pos.x - c.pos.x, a.pos.z - c.pos.z);
    expect(dab).toBeGreaterThan(1.5);
    expect(dac).toBeGreaterThan(1.5);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// long random-terrain runs
// ---------------------------------------------------------------------------------------------------------------------
describe('ランダム地形での長時間ラン', () => {
  it('数千tickでNaN・壁へのめり込み・スタックが出ない (壁/箱の迷路状地形, 警備10+砲台4)', () => {
    let totalFires = 0;
    let totalGuardTicksMoving = 0;
    let worstBlockedSeconds = 0;
    let worstIdleSearchSeconds = 0;
    let maxSpeed = 0;
    for (const seed of [11, 22, 33]) {
      const rng = new Rng(seed);
      const boxes: BoxDef[] = [];
      for (let i = 0; i < 36; i++) {
        const x = rng.range(-70, 70);
        const z = rng.range(-70, 70);
        if (rng.next() < 0.5) {
          const along = rng.next() < 0.5;
          const len = rng.range(12, 45);
          boxes.push(box(x, 0, z, along ? x + len : x + 2, 10, along ? z + 2 : z + len));
        } else {
          const w = rng.range(3, 9);
          boxes.push(box(x, 0, z, x + w, rng.range(3, 9), z + rng.range(3, 9)));
        }
      }
      const probe = new World([box(-400, -2, -400, 400, 0, 400), ...boxes]);
      const probeNav = getNav(probe);
      const freeSpot = (half: number): { x: number; z: number } => {
        for (let k = 0; k < 500; k++) {
          const x = rng.range(-75, 75);
          const z = rng.range(-75, 75);
          if (probeNav.isFree(x, 0, z, half) && !probe.overlapAABB({ x, y: PLAYER_Y, z }, PLAYER.HALF, 0.05)) return { x, z };
        }
        throw new Error('no free spot');
      };
      const enemies: EnemySpawn[] = [];
      for (let i = 0; i < 10; i++) {
        const p = freeSpot(1.6);
        enemies.push(spawn('guard', `G${String(i + 1).padStart(2, '0')}`, p.x, p.z));
      }
      for (let i = 0; i < 4; i++) {
        const p = freeSpot(1.6);
        enemies.push(spawn('turret', `T${String(i + 1).padStart(2, '0')}`, p.x, p.z));
      }
      const start = freeSpot(1.2);
      const g = makeGame({ enemies, boxes, player: start });
      const s = g.state;
      const nav = getNav(g.world, g.stage);
      const rec = new Rec(g);
      const blocked = new Map<string, number>();
      const idleSearch = new Map<string, number>();
      for (let i = 0; i < 3600; i++) {
        if (i % 360 === 0 && i > 0) {
          const p = freeSpot(1.2); // the player relocates (teleport) every 3 s
          s.player.pos = { x: p.x, y: PLAYER_Y, z: p.z };
          s.player.vel = { x: 0, y: 0, z: 0 };
        }
        rec.step();
        for (const e of s.enemies) {
          expect(Number.isFinite(e.pos.x + e.pos.y + e.pos.z + e.vel.x + e.vel.y + e.vel.z)).toBe(true);
          expect(Number.isFinite(e.telegraph)).toBe(true);
          if (e.kind !== 'guard') continue;
          const ai = getEnemyAI(e)!;
          const sp = hspeed(e.vel);
          maxSpeed = Math.max(maxSpeed, sp);
          expect(Math.abs(e.vel.y)).toBeLessThan(1e-9);
          expect(g.world.overlapAABB(e.pos, { x: GUARD.hitRadius, y: GUARD.hitRadius, z: GUARD.hitRadius }, 0.01), `${e.id} inside a wall at tick ${s.tick}`).toBe(false);
          if (sp > 0.1) totalGuardTicksMoving++;
          // commanded to move but pinned
          const want = Math.hypot(ai.cmdVx, ai.cmdVz);
          const b = want > 0.5 && sp < want * 0.3 ? (blocked.get(e.id) ?? 0) + DT : 0;
          blocked.set(e.id, b);
          worstBlockedSeconds = Math.max(worstBlockedSeconds, b);
          // alert without sight, far from the last sighting, yet standing still although a route exists
          const lk = ai.lastKnownPos;
          if (e.alert && !e.hasLineOfSight && lk && sp < 0.1 && Math.hypot(lk.x - e.pos.x, lk.z - e.pos.z) > 3) {
            const t = (idleSearch.get(e.id) ?? 0) + DT;
            idleSearch.set(e.id, t);
            if (t > 1.5 && Math.abs(t - 1.5) < DT * 1.5) {
              const route = nav.findPath({ x: e.pos.x, y: ai.floorY, z: e.pos.z }, { x: lk.x, y: lk.y - PLAYER_Y, z: lk.z });
              expect(route, `${e.id} stands still at tick ${s.tick} although a route to the last sighting exists`).toBeNull();
            }
            worstIdleSearchSeconds = Math.max(worstIdleSearchSeconds, t);
          } else idleSearch.set(e.id, 0);
        }
        for (const bu of s.enemyBullets) expect(Number.isFinite(bu.pos.x + bu.pos.y + bu.pos.z)).toBe(true);
      }
      // every shot had a valid sight line from the muzzle at its fire time
      for (const f of rec.fires) {
        expect(f.los).toBe(true);
        expect(g.world.segmentBlocked(f.origin, f.player.pos)).toBe(false);
      }
      totalFires += rec.fires.length;
      expect(Number.isFinite(s.player.hp)).toBe(true);
    }
    expect(worstBlockedSeconds).toBeLessThan(0.7);
    expect(maxSpeed).toBeLessThanOrEqual(GUARD.approachSpeed + 1e-6);
    expect(totalFires).toBeGreaterThan(50);
    expect(totalGuardTicksMoving).toBeGreaterThan(1000);
    console.info(`[random terrain] fires ${totalFires}, moving guard-ticks ${totalGuardTicksMoving}, worst pinned ${worstBlockedSeconds.toFixed(3)} s, worst idle-while-searching ${worstIdleSearchSeconds.toFixed(3)} s, max speed ${maxSpeed.toFixed(3)} m/s`);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// path following: floor edges, seams and tight corners (SPEC §2.3 "通路があるのに障害物へ押し付き続ける挙動は不可")
// ---------------------------------------------------------------------------------------------------------------------
describe('経路追従: 床の縁・継ぎ目・角に押し付いて止まらない', () => {
  /** floor A (x -22..0) and two wings B1 / B2 (x 0..8) with a 12 m gap between them; the x = 0 seam and the gap's rim are lattice lines */
  const wingedFloor = (): BoxDef[] => [
    box(-22, -2, 0, 0, 0, 150, { mat: 'grating' }),
    box(0, -2, 0, 8, 0, 60, { mat: 'grating' }),
    box(0, -2, 72, 8, 0, 150, { mat: 'grating' }),
  ];
  const ARRIVE = 1.5;

  it('床が12m途切れる隙間を挟んだ隣の翼にいたプレイヤーを見失っても、継ぎ目/縁に沿う経路を取らず、床の上を回り込んで確認位置に着く (到着まで0.5秒を超えて止まらない)', () => {
    for (const gx of [1, 4, 7]) {
      const g = makeGame({ enemies: [spawn('guard', 'G01', gx, 30)], boxes: wingedFloor(), floorHalf: 0, player: { x: 4, z: 78 } });
      const e = enemy(g, 'G01');
      const nav = getNav(g.world, g.stage);
      const rec = new Rec(g);
      rec.run(1);
      expect(e.hasLineOfSight, `x=${gx}: engaged across the gap`).toBe(true);
      const ai = getEnemyAI(e)!;
      let still = 0;
      let worst = 0;
      let minToLk = Infinity;
      let pathsChecked = 0;
      const n = Math.round(8 / DT);
      for (let i = 0; i < n; i++) {
        g.state.player.pos = { x: 4, y: PLAYER_Y, z: 400 }; // gone for good: the memory holds the sighting across the gap
        g.state.player.prevPos = { ...g.state.player.pos };
        g.state.player.vel = { x: 0, y: 0, z: 0 };
        rec.step();
        expect(nav.floorAt(e.pos.x, e.pos.z, 0), `x=${gx} tick ${i}: the guard is on the floor`).not.toBeNull();
        const lk = ai.lastKnownPos;
        if (!lk || !e.alert) continue;
        const d = Math.hypot(lk.x - e.pos.x, lk.z - e.pos.z);
        minToLk = Math.min(minToLk, d);
        if (d > ARRIVE + 2.5 && hspeed(e.vel) < 0.3) still += DT;
        else still = 0;
        worst = Math.max(worst, still);
        // the route it follows keeps the planner's distance from every rim / seam beside a drop (the last point may be the goal itself)
        if (ai.path && i % 12 === 0) {
          pathsChecked++;
          for (let k = 1; k < ai.path.length - 1; k++) {
            const q = ai.path[k]; // (the first point is the guard's own position: it may stand anywhere on the floor)
            expect(nav.floorAt(q.x, q.z, q.y, NAV.BODY_HALF), `x=${gx}: waypoint (${q.x.toFixed(2)}, ${q.z.toFixed(2)}) of the route keeps clear of the rim`).not.toBeNull();
          }
        }
      }
      expect(pathsChecked).toBeGreaterThan(20);
      expect(worst, `x=${gx}: longest stand-still before reaching the remembered spot`).toBeLessThanOrEqual(GUARD.reactSeconds + 1e-9);
      expect(minToLk, `x=${gx}: it walked around the gap to the remembered position`).toBeLessThanOrEqual(ARRIVE + 0.1);
    }
  });

  it('3.4m幅の通路の入口へ斜めに回り込む巡回: 入口の角を切って壁に押し付かず、通路の奥まで往復できる (どの開始位置でも0.25秒を超えて押し付かない)', () => {
    let worstPinned = 0;
    for (const [sx, sz] of [[86, 44], [90, 56], [94, 48], [98, 44], [118, 48], [124, 56]]) {
      const walls = [box(100, 0, 0, 104.6, 6, 40), box(108, 0, 0, 112, 6, 40)]; // the corridor x 104.6..108 (body 2.7 m): the only lattice column is x = 106
      const g = makeGame({
        enemies: [{ ...spawn('guard', 'G01', sx, sz), patrol: [{ x: sx, y: GUARD.centerHeight, z: sz }, { x: 106.3, y: GUARD.centerHeight, z: 8 }] }],
        boxes: walls,
        player: { x: 0, z: 300 }, // far away on the floor: never seen
      });
      const e = enemy(g, 'G01');
      let pinned = 0;
      let minZ = Infinity;
      const n = Math.round(24 / DT);
      for (let i = 0; i < n; i++) {
        g.step();
        g.drainEvents();
        const ai = getEnemyAI(e)!;
        const want = Math.hypot(ai.cmdVx, ai.cmdVz);
        pinned = want > 0.5 && hspeed(e.vel) < want * 0.3 ? pinned + DT : 0;
        worstPinned = Math.max(worstPinned, pinned);
        minZ = Math.min(minZ, e.pos.z);
        expect(g.world.overlapAABB(e.pos, { x: GUARD.hitRadius, y: GUARD.hitRadius, z: GUARD.hitRadius }, 0.01)).toBe(false);
      }
      expect(minZ, `start (${sx}, ${sz}): it patrols down the corridor`).toBeLessThan(20);
    }
    expect(worstPinned).toBeLessThan(0.25);
  });

  it('確認位置に着いて射線が無いまま警戒が続く間: 見回して(0.3秒)から確認位置の左右へ6m/sで往復し、警戒が切れるまで立ち止まり続けない', () => {
    const g = makeGame({ enemies: [spawn('guard', 'G01', 0, -30)], player: { x: 0, z: 0 } });
    const e = enemy(g, 'G01');
    const rec = new Rec(g);
    rec.run(1);
    expect(e.hasLineOfSight).toBe(true);
    const lkp = { x: 0, z: 0 };
    let arrivedAt: number | null = null;
    let still = 0;
    let worstStill = 0;
    let maxDist = 0;
    let minSide = Infinity;
    let maxSide = -Infinity;
    let movingSpeeds = 0;
    let releasedAt: number | null = null;
    const seen: { sp: number; mode: string }[] = [];
    const n = Math.round(10 / DT);
    for (let i = 0; i < n; i++) {
      g.state.player.pos = { x: 0, y: PLAYER_Y, z: 300 };
      g.state.player.prevPos = { ...g.state.player.pos };
      g.state.player.vel = { x: 0, y: 0, z: 0 };
      rec.step();
      const a = getEnemyAI(e)!;
      if (!e.alert) {
        releasedAt = releasedAt ?? g.state.time;
        continue;
      }
      const d = Math.hypot(e.pos.x - lkp.x, e.pos.z - lkp.z);
      if (arrivedAt === null && d <= 1.5) arrivedAt = g.state.time;
      if (arrivedAt === null || g.state.time < arrivedAt + 3 * DT) continue; // (the arrival tick itself still carries the approach speed)
      const sp = hspeed(e.vel);
      seen.push({ sp, mode: a.mode });
      still = sp < 0.3 ? still + DT : 0;
      worstStill = Math.max(worstStill, still);
      maxDist = Math.max(maxDist, d);
      minSide = Math.min(minSide, e.pos.x);
      maxSide = Math.max(maxSide, e.pos.x);
      if (sp >= 0.3) {
        expect(sp).toBeCloseTo(GUARD.strafeSpeed, 6);
        movingSpeeds++;
      }
    }
    expect(arrivedAt, 'reached the remembered position').not.toBeNull();
    expect(arrivedAt!).toBeLessThan(5);
    expect(releasedAt, 'the memory still runs out after 8 s').not.toBeNull();
    expect(seen.length).toBeGreaterThan(120);
    for (const k of seen) expect(k.mode).toBe('search');
    expect(worstStill).toBeLessThanOrEqual(0.3 + 3 * DT); // looks around, never a freeze
    expect(movingSpeeds).toBeGreaterThan(seen.length * 0.5);
    expect(maxDist).toBeLessThan(5 + 2); // stays around the spot (sweep radius + arrival slack)
    expect(maxSide).toBeGreaterThan(2.5); // sweeps to both sides of the remembered position
    expect(minSide).toBeLessThan(-2.5);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// path planning is spread over ticks (planner) / navigation warm-up (Game.warmup)
// ---------------------------------------------------------------------------------------------------------------------
/** the stage of a Scene, without a Game (makeGame builds the same and sorties at once) */
function sceneStage(sc: Scene): ReturnType<typeof buildTestArenaStage> {
  const stage = buildTestArenaStage({ floorHalf: sc.floorHalf ?? 400 });
  stage.boxes.push(...(sc.boxes ?? []));
  stage.enemies = sc.enemies;
  const p = sc.player ?? { x: 0, z: 0 };
  stage.playerStart = { pos: { x: p.x, y: PLAYER_Y, z: p.z }, yaw: sc.yaw ?? 0 };
  return stage;
}
/** everything a decision can depend on or produce, as a string (state without world / stage, AI internals included) */
function signature(g: Game): string {
  const s = g.state;
  return JSON.stringify({
    mode: s.mode,
    tick: s.tick,
    rng: s.rng.getState(),
    player: { pos: s.player.pos, vel: s.player.vel, hp: s.player.hp },
    enemies: s.enemies.map((e) => ({ id: e.id, pos: e.pos, vel: e.vel, yaw: e.yaw, hp: e.hp, alive: e.alive, alert: e.alert, los: e.hasLineOfSight, shots: e.shotsFired, telegraph: e.telegraph, ai: e.internal.ai })),
    bullets: s.enemyBullets.map((b) => [b.id, b.pos, b.vel, b.age]),
    nextProjectileId: s.nextProjectileId,
    events: s.events.length,
  });
}
/** a guard that plans a path to a spot on an 8 m platform nobody can climb: the search exhausts its cap (15000 expansions) */
const PLATFORM = box(40, 0, -120, 80, 8, -80);
function platformGuard(id: string, x: number, z: number): EnemySpawn {
  return { ...spawn('guard', id, x, z), patrol: [{ x: 60, y: GUARD.centerHeight + 8, z: -100 }] };
}
const GUARD_PLAN = { partial: true, maxExpansions: 15000, weight: 1.25 } as const;

describe('経路計画の分割 (1 tick の作業量の上限)', () => {
  it('小さな探索は要求した tick のうちに終わる (従来と同じ: 最初の tick で経路を持つ)', () => {
    const g = makeGame({
      enemies: [{ ...spawn('guard', 'G01', 0, -100), patrol: [{ x: 40, y: GUARD.centerHeight, z: -100 }, { x: 0, y: GUARD.centerHeight, z: -100 }] }],
      player: { x: 0, z: 0 },
      floorHalf: 300,
    });
    const ai0 = getEnemyAI(enemy(g, 'G01'));
    expect(ai0).toBeUndefined();
    g.step();
    const ai = getEnemyAI(enemy(g, 'G01'))!;
    expect(ai.path).not.toBeNull();
    expect((ai.path as V3[]).length).toBeGreaterThanOrEqual(2);
    const end = (ai.path as V3[])[(ai.path as V3[]).length - 1];
    expect(end.x).toBeCloseTo(40, 3);
    expect(hspeed(enemy(g, 'G01').vel)).toBeGreaterThan(0);
  });

  it('大きな探索 (到達できない台の上への経路: 上限 15000 ノード) は数 tick にまたがる。その間ガードは前の経路 / 自前の操舵で動き、結果は nav.findPath と同じ経路', () => {
    const g = makeGame({ enemies: [platformGuard('G01', 0, -100)], boxes: [PLATFORM], player: { x: 0, z: 400 } });
    const e = enemy(g, 'G01');
    const nav = getNav(g.world, g.stage);
    // what a plain (synchronous) search from the spawn to the waypoint returns
    const spawnFeet = { x: 0, y: 0, z: -100 };
    const goalFeet = { x: 60, y: 8, z: -100 };
    const want = nav.findPath(spawnFeet, goalFeet, GUARD_PLAN)!;
    expect(want.partial).toBe(true);
    const expBefore = nav.stats().expansions;
    g.step();
    const ai = getEnemyAI(e)!;
    const spent1 = nav.stats().expansions - expBefore;
    expect(spent1).toBeLessThanOrEqual(PLAN_WORK_PER_TICK + 1);
    expect(spent1).toBeGreaterThan(PLAN_WORK_PER_TICK * 0.9); // the whole budget went into the search...
    expect(ai.path).toBeNull(); // ...which is not finished: a 15000-node search does not fit in one tick
    expect(hspeed(e.vel)).toBeGreaterThan(0); // the guard does not wait for it: it heads for the waypoint on its own
    let ticks = 1;
    while (ai.path === null && ticks < 30) {
      g.step();
      ticks++;
    }
    expect(ticks).toBeGreaterThanOrEqual(3);
    expect(ticks).toBeLessThanOrEqual(8);
    expect(ai.path).toEqual(want.points);
    expect(getNav(g.world, g.stage)).toBe(nav);
  });

  it('全ガードの計画を合わせても 1 tick の探索量は PLAN_WORK_PER_TICK まで。待たされたガードも順番に経路を受け取る (先着順)', () => {
    const enemies = Array.from({ length: 10 }, (_, i) => platformGuard(`G${String(i + 1).padStart(2, '0')}`, -30 + i * 6, -100));
    const g = makeGame({ enemies, boxes: [PLATFORM], player: { x: 0, z: 400 } });
    const nav = getNav(g.world, g.stage);
    let worst = 0;
    let total = 0;
    const gotPathAt = new Map<string, number>();
    for (let t = 0; t < 400; t++) {
      const before = nav.stats().expansions;
      g.step();
      const spent = nav.stats().expansions - before;
      worst = Math.max(worst, spent);
      total += spent;
      for (const e of g.state.enemies) if (!gotPathAt.has(e.id) && getEnemyAI(e)?.path) gotPathAt.set(e.id, t);
    }
    expect(worst).toBeLessThanOrEqual(PLAN_WORK_PER_TICK + 1);
    expect(total).toBeGreaterThan(PLAN_WORK_PER_TICK * 10); // 10 searches of ~15000: much more than one tick can carry
    expect(gotPathAt.size).toBe(10);
    // first come first served: guard i gets its path no later than guard i + 1
    const order = enemies.map((sp) => gotPathAt.get(sp.id) as number);
    for (let i = 1; i < order.length; i++) expect(order[i]).toBeGreaterThanOrEqual(order[i - 1]);
    expect(order[9]).toBeGreaterThan(order[0]);
  });

  it('待っている探索は、ガードの目標が動いても順番を保つ (速く動く目標を追う警備が列の後ろへ回され続けて、経路を一度も得られない、ということがない)', () => {
    // 60 guards keep the planner busy for good (each asks for a search that covers its region, again every second: 60 x 4 ticks > 120 ticks);
    // GX, last in line, chases a goal that runs 0.5 m every tick (a fast player: more than 6 m in 12 ticks). Sent to the back of the line at
    // every move it would wait for ever
    const platformGuards = Array.from({ length: 60 }, (_, i) => platformGuard(`G${String(i + 1).padStart(2, '0')}`, -60 + (i % 10) * 6, -100 - Math.floor(i / 10) * 6));
    const g = makeGame({ enemies: [...platformGuards, spawn('guard', 'GX', -100, -200)], boxes: [PLATFORM], player: { x: 0, z: 400 } });
    const gx = enemy(g, 'GX');
    let gotPathAt = -1;
    for (let t = 0; t < 900 && gotPathAt < 0; t++) {
      const ai = getEnemyAI(gx);
      if (ai) {
        gx.alert = true;
        ai.lastKnownPos = { x: -100 + t * 0.5, y: PLAYER_Y, z: -200 };
        ai.lastSeenAt = g.state.time;
      }
      g.step();
      if (getEnemyAI(gx)?.path) gotPathAt = t;
    }
    expect(gotPathAt).toBeGreaterThan(100); // it really had to wait for the searches ahead of it...
    expect(gotPathAt).toBeLessThan(900); // ...and then got its own
  });

  it('再出撃 (retry) で待っていた計画は捨てられ、新しい state は最初から同じ進行になる', () => {
    const scene: Scene = { enemies: [platformGuard('G01', 0, -100), platformGuard('G02', 6, -100)], boxes: [PLATFORM], player: { x: 0, z: 400 } };
    const fresh = makeGame(scene);
    const g = makeGame(scene);
    for (let i = 0; i < 2; i++) g.step(); // both guards are waiting for / in the middle of a big search
    g.retry();
    g.state.player.hp = 1e9;
    for (let t = 0; t < 40; t++) {
      fresh.step();
      g.step();
      expect(signature(g), `tick ${t}`).toBe(signature(fresh));
    }
    expect(getEnemyAI(enemy(g, 'G01'))!.path).not.toBeNull();
  });
});

describe('Game.warmup (経路探索グリッドの事前構築)', () => {
  /** guards spread over the arena, patrols, a wall to hide behind, a platform nobody can climb: LOS gained / lost, chases, plans of every size */
  function scene(): Scene {
    const wall = box(-200, 0, -60, 20, 12, -58);
    return {
      enemies: [
        { ...spawn('guard', 'G01', -40, -150), patrol: [{ x: -40, y: GUARD.centerHeight, z: -150 }, { x: 30, y: GUARD.centerHeight, z: -150 }] },
        spawn('guard', 'G02', 30, -120),
        { ...spawn('guard', 'G03', 90, -160), patrol: [{ x: 90, y: GUARD.centerHeight, z: -160 }, { x: 120, y: GUARD.centerHeight, z: -100 }] },
        platformGuard('G04', 10, -100),
        spawn('turret', 'T01', 60, -100),
      ],
      boxes: [wall, PLATFORM],
      player: { x: 0, z: 0 },
      floorHalf: 300,
    };
  }
  /** the same inputs every tick: the player is teleported around (in view, behind the wall, far away), like a script */
  function script(g: Game, tick: number): void {
    const p = g.state.player;
    const at = tick < 200 ? { x: 60, z: -40 } : tick < 420 ? { x: -20, z: -30 } : tick < 640 ? { x: 30, z: -140 } : { x: 100, z: -30 };
    p.hp = 1e9;
    p.pos = { x: at.x, y: PLAYER_Y, z: at.z };
    p.prevPos = { ...p.pos };
    p.vel = { x: 0, y: 0, z: 0 };
  }
  /** runs the script; returns the longest path (waypoints) any guard followed */
  function run(g: Game, ticks: number, sigs: string[]): number {
    let longest = 0;
    for (let t = 0; t < ticks; t++) {
      script(g, g.state.tick);
      g.step();
      g.drainEvents();
      for (const e of g.state.enemies) longest = Math.max(longest, getEnemyAI(e)?.path?.length ?? 0);
      if (t % 25 === 0) sigs.push(signature(g));
    }
    sigs.push(signature(g));
    return longest;
  }

  it('warmup の有無・分け方で結果が変わらない (同じ入力なら全 tick で state が同一: AI 内部・乱数・敵弾を含む)', () => {
    const cold = new Game({ stage: sceneStage(scene()) });
    cold.sortie();
    const coldSigs: string[] = [];
    const longest = run(cold, 900, coldSigs);

    const once = new Game({ stage: sceneStage(scene()) });
    expect(once.warmup()).toBe(true);
    once.sortie();
    const onceSigs: string[] = [];
    run(once, 900, onceSigs);

    const sliced = new Game({ stage: sceneStage(scene()) });
    let calls = 0;
    while (!sliced.warmup(300)) calls++;
    sliced.sortie();
    const slicedSigs: string[] = [];
    run(sliced, 900, slicedSigs);

    expect(calls).toBeGreaterThan(3);
    expect(onceSigs).toEqual(coldSigs);
    expect(slicedSigs).toEqual(coldSigs);
    // something happened (not a trivial equality): they fought, chased around the wall and planned real paths
    const fired = cold.state.enemies.reduce((n, e) => n + e.shotsFired, 0);
    expect(fired).toBeGreaterThan(10);
    expect(longest).toBeGreaterThan(2); // a path around the wall, not just straight lines
  });

  it('warmup は冪等 (2 回目以降は true を返すだけ)、ゲームの状態に触れない、途中の分割呼び出しでも同じ格子になる', () => {
    const sig0 = (g: Game): string => JSON.stringify({ s: signature(g), disabled: g.world.boxes.filter((_, i) => !g.world.isBoxEnabled(i)).length, mode: g.state.mode });
    const a = new Game({ stage: sceneStage(scene()) });
    const before = sig0(a);
    expect(a.warmup(0)).toBe(false); // nothing done: no work allowed
    expect(a.warmup(200)).toBe(false);
    expect(sig0(a)).toBe(before);
    expect(a.warmup()).toBe(true);
    expect(sig0(a)).toBe(before);
    expect(a.state.mode).toBe('garage');
    const nav = getNav(a.world, a.stage);
    const cells = nav.stats().cells;
    expect(cells).toBeGreaterThan(5000);
    expect(nav.stats().queued).toBe(0);
    // idempotent: nothing more is built, however often it is called
    for (let i = 0; i < 3; i++) expect(a.warmup()).toBe(true);
    expect(nav.stats().cells).toBe(cells);
    // the sortie reuses the same grid
    a.sortie();
    expect(getNav(a.world, a.stage)).toBe(nav);
    // the same grid whichever way it is built
    const b = new Game({ stage: sceneStage(scene()) });
    while (!b.warmup(97)) {
      /* many small calls */
    }
    expect(getNav(b.world, b.stage).stats().cells).toBe(cells);
    expect(getNav(b.world, b.stage).stats().columns).toBe(nav.stats().columns);
  });

  it('警備がいないステージでは何もしない (すぐ true)。warmup を呼ばない従来の使い方 (遅延構築) も動く', () => {
    const noGuards = new Game({ stage: sceneStage({ enemies: [spawn('turret', 'T01', 0, -60)], player: { x: 0, z: 0 } }) });
    expect(noGuards.warmup()).toBe(true);
    expect(getNav(noGuards.world, noGuards.stage).stats().cells).toBe(0);
    // lazily built (no warmup): the guard still finds its way around the wall
    const g = makeGame({ enemies: [spawn('guard', 'G01', 0, -80)], boxes: [box(-40, 0, -20, 40, 12, -18)], player: { x: 0, z: 0 }, floorHalf: 200 });
    const e = enemy(g, 'G01');
    for (let t = 0; t < 600; t++) g.step();
    expect(getNav(g.world, g.stage).stats().cells).toBeGreaterThan(1000);
    expect(e.alive).toBe(true);
  });
});
