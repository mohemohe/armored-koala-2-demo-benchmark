/**
 * §4.6 の必須命中試験を Game 全体（FCS ロック → 射撃 → 弾体 → 衝突 → enemyHit）で実行する。
 *
 * 銃口 m=(0,20,0)、p=m+r に半径 0.5 m の 'target' 敵（等速 v）。各条件 20 回、独立に Game を生成して 1 発ずつ撃つ。
 * カメラは毎フレーム標的中心を向く（右肩越し TPS カメラなので機体ヨーは π から僅かにずれる）。
 * 「発射時刻の実際の銃口が (0,20,0)」になるよう、出撃位置とヨーを不動点反復で較正してから本試験を行う
 * （移動中の試験では移動量も含めて較正する）。標的の初期位置は m + r − v·tFire とし、発射時に p = m + r になるようにする。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_LOADOUT, SIM, WEAPONS, computeEffectiveStats } from '../src/params';
import { Game } from '../src/sim/game';
import { add, addScaled, copy, distance, length, scale, sub } from '../src/sim/vec';
import type { FireSolution, InputFrame, ShotRecord, Snapshot, Vec3, Weapon } from '../src/types';
import { emptyInput } from '../src/types';
import { makeRangeStage } from './helpers/testStage';

const VIEW = { width: 1280, height: 720 };
const FRAME = 1 / 60;
const M0: Vec3 = [0, 20, 0];
const TARGET_ID = 'target';
const TRIALS = 20;
const LOCK_SECONDS = computeEffectiveStats(DEFAULT_LOADOUT).lockSeconds;

type Movement = 'none' | 'glide' | 'fly' | 'qb';

interface Case {
  id: string;
  r: Vec3;
  v: Vec3;
}

/** §4.6 の表 A01〜A13 */
const CASES: Case[] = [
  { id: 'A01', r: [0, 0, 20], v: [0, 0, 0] },
  { id: 'A02', r: [0, 0, 60], v: [0, 0, 0] },
  { id: 'A03', r: [0, 0, 100], v: [0, 0, 0] },
  { id: 'A04', r: [0, 0, 120], v: [0, 0, 0] },
  { id: 'A05', r: [0, 0, 100], v: [8, 0, 0] },
  { id: 'A06', r: [0, 0, 100], v: [-8, 0, 0] },
  { id: 'A07', r: [0, 0, 100], v: [0, 0, 8] },
  { id: 'A08', r: [0, 0, 100], v: [0, 0, -8] },
  { id: 'A09', r: [0, 16, 100], v: [6, 0, 0] },
  { id: 'A10', r: [0, -16, 100], v: [-6, 0, 0] },
  { id: 'A11', r: [0, 0, 100], v: [6, 3, 0] },
  { id: 'A12', r: [0, 0, 100], v: [6, -3, 0] },
  { id: 'A13', r: [0, 0, 120], v: [6, 3, 4] },
];

interface TrialOptions {
  r: Vec3;
  v: Vec3;
  weapon: Weapon;
  seed: number;
  movement: Movement;
  /** 出撃時のヨーと「銃口位置」パラメーター（makeRangeStage に渡す。較正で調整する） */
  yaw: number;
  muzzleParam: Vec3;
  targetStart: Vec3;
  qbPressAt: number | null;
  /** 発射後にこの秒数だけ追跡する */
  followSeconds: number;
  /** 較正用: このフレーム開始時の銃口とヨーを記録する */
  probeFrame: number;
}

interface TrialResult {
  hits: number;
  shot: ShotRecord | null;
  solutionAtFire: FireSolution | null;
  movementAtFire: Snapshot['player']['movement'] | null;
  velocityAtFire: Vec3 | null;
  lockedAt: number | null;
  tFire: number | null;
  frameAtFire: number | null;
  muzzleAtProbe: Vec3 | null;
  yawAtProbe: number | null;
  tAtProbe: number | null;
  state: string;
}

function runTrial(o: TrialOptions): TrialResult {
  const stage = makeRangeStage({
    muzzle: o.muzzleParam,
    yaw: o.yaw,
    targets: [{ id: TARGET_ID, center: o.targetStart, velocity: o.v }],
    floorSize: o.movement === 'none' ? 4 : 400,
  });
  const game = new Game({ stage, loadout: DEFAULT_LOADOUT, seed: o.seed, viewport: VIEW, buildNav: false });
  game.launch();
  const res: TrialResult = {
    hits: 0,
    shot: null,
    solutionAtFire: null,
    movementAtFire: null,
    velocityAtFire: null,
    lockedAt: null,
    tFire: null,
    frameAtFire: null,
    muzzleAtProbe: null,
    yawAtProbe: null,
    tAtProbe: null,
    state: game.state,
  };
  let frame = 0;
  let fired = false;
  let qbPressed = false;
  let endAt = Infinity;
  while (game.state === 'playing' && game.time < endAt) {
    const info = game.targetInfo(TARGET_ID);
    if (!info) throw new Error('target missing');
    game.camera.lookAt(info.center);
    const input: InputFrame = { ...emptyInput() };
    if (frame === 0 && o.weapon !== 'machinegun') input.weaponSelect = o.weapon;
    if (o.movement === 'glide') {
      if (frame === 0) input.shiftPressed = true;
      input.moveRight = 1;
    } else if (o.movement === 'fly') {
      if (frame === 0) input.spacePressed = true;
      input.spaceDown = true;
    } else if (o.movement === 'qb' && o.qbPressAt !== null && !qbPressed && game.time >= o.qbPressAt - 1e-9) {
      input.qbPressed = true;
      qbPressed = true;
    }
    if (frame === o.probeFrame) {
      res.muzzleAtProbe = game.player.getMuzzlePosition();
      res.yawAtProbe = game.player.yaw;
      res.tAtProbe = game.time;
    }
    const snap = game.getSnapshot();
    if (res.lockedAt === null && snap.lock.state === 'locked' && snap.lock.targetId === TARGET_ID) res.lockedAt = game.time;
    if (!fired && snap.lock.state === 'locked' && snap.lock.targetId === TARGET_ID) {
      // この advance の先頭（時刻 game.time）で発射される
      input.fireDown = true;
      fired = true;
      res.tFire = game.time;
      res.frameAtFire = frame;
      res.solutionAtFire = snap.fireControl;
      res.movementAtFire = snap.player.movement;
      res.velocityAtFire = snap.player.velocity;
      endAt = game.time + o.followSeconds;
    } else if (!fired && game.time > LOCK_SECONDS + 0.5) {
      // ロックしないまま時間切れ（較正パスでは起こり得る）
      endAt = game.time;
    }
    game.setInput(input);
    game.advance(FRAME);
    for (const e of game.drainEvents()) {
      if (e.type === 'enemyHit' && e.enemyId === TARGET_ID) res.hits++;
    }
    frame++;
    if (frame > 2000) break;
  }
  const shots = game.getSnapshot().recentPlayerShots;
  res.shot = shots.length > 0 ? shots[0] : null;
  res.state = game.state;
  return res;
}

interface Calibration {
  yaw: number;
  muzzleParam: Vec3;
  tFire: number;
  frame: number;
  qbPressAt: number | null;
  passes: number;
  error: number;
}

/** 発射フレームと発射時刻（ロック所要時間から決まる）を A03 静止条件で測る */
function probeFireFrame(): { frame: number; tFire: number } {
  const c = CASES[2];
  const res = runTrial({
    r: c.r,
    v: c.v,
    weapon: 'machinegun',
    seed: 1,
    movement: 'none',
    yaw: Math.PI,
    muzzleParam: M0,
    targetStart: add(M0, c.r),
    qbPressAt: null,
    followSeconds: 0.1,
    probeFrame: -1,
  });
  if (res.frameAtFire === null || res.tFire === null) throw new Error('probe: lock never completed');
  return { frame: res.frameAtFire, tFire: res.tFire };
}

/**
 * 発射時刻の実際の銃口が M0 になるよう、出撃ヨーと位置を不動点反復で較正する。
 * 較正パスではロックの成否に依らず、発射予定フレーム開始時の銃口とヨーを読む。
 */
function calibrate(r: Vec3, v: Vec3, weapon: Weapon, movement: Movement, probe: { frame: number; tFire: number }): Calibration {
  let yaw = Math.PI;
  let muzzleParam = copy(M0);
  const qbPressAt = movement === 'qb' ? probe.tFire - 0.05 : null;
  const targetStart = addScaled(add(M0, r), v, -probe.tFire);
  let err = Infinity;
  for (let pass = 1; pass <= 20; pass++) {
    const res = runTrial({ r, v, weapon, seed: 1, movement, yaw, muzzleParam, targetStart, qbPressAt, followSeconds: 0, probeFrame: probe.frame });
    if (res.muzzleAtProbe === null || res.yawAtProbe === null) throw new Error('calibration: probe frame not reached');
    const e = sub(res.muzzleAtProbe, M0);
    err = length(e);
    if (err < 1e-9) return { yaw, muzzleParam, tFire: probe.tFire, frame: probe.frame, qbPressAt, passes: pass, error: err };
    muzzleParam = sub(muzzleParam, e);
    yaw = res.yawAtProbe;
  }
  throw new Error(`calibration did not converge (error ${err})`);
}

function fmt(v: Vec3): string {
  return `(${v.map((x) => Number(x.toFixed(3))).join(',')})`;
}

interface ConditionSummary {
  hits: number;
  residual: number;
  flight: number | null;
  speed: number | null;
}

/** 1 条件 20 試行。共通の検証を行い、要約を返す */
function runCondition(label: string, c: Case, weapon: Weapon, movement: Movement, probe: { frame: number; tFire: number }, followSeconds: number): ConditionSummary {
  const cal = calibrate(c.r, c.v, weapon, movement, probe);
  const targetStart = addScaled(add(M0, c.r), c.v, -cal.tFire);
  const expectedP = add(M0, c.r);
  let hits = 0;
  let maxResidual = 0;
  let flight: number | null = null;
  let speed: number | null = null;
  for (let i = 0; i < TRIALS; i++) {
    const res = runTrial({
      r: c.r,
      v: c.v,
      weapon,
      seed: 1000 + i,
      movement,
      yaw: cal.yaw,
      muzzleParam: cal.muzzleParam,
      targetStart,
      qbPressAt: cal.qbPressAt,
      followSeconds,
      probeFrame: -1,
    });
    expect(res.state).toBe('playing');
    // ロックは lockSeconds + 0.1 以内に完了
    expect(res.lockedAt).not.toBeNull();
    expect(res.lockedAt!).toBeLessThanOrEqual(LOCK_SECONDS + 0.1);
    expect(res.tFire).not.toBeNull();
    const shot = res.shot!;
    expect(shot).not.toBeNull();
    expect(shot.weapon).toBe(weapon);
    expect(shot.targetId).toBe(TARGET_ID);
    expect(shot.firedAtSeconds).toBe(res.tFire);
    // 銃口は (0,20,0)、標的は m+r（1e-6 以内）
    expect(distance(shot.muzzlePosition, M0)).toBeLessThan(1e-6);
    expect(distance(shot.targetPositionAtFire!, expectedP)).toBeLessThan(1e-6);
    expect(distance(shot.targetVelocityAtFire!, c.v)).toBeLessThan(1e-9);
    // 射撃解
    const sol = res.solutionAtFire!;
    expect(sol.status).toBe('solved');
    expect(shot.solutionStatus).toBe('solved');
    expect(sol.targetId).toBe(TARGET_ID);
    expect(sol.residualMeters!).toBeLessThanOrEqual(0.01);
    expect(distance(sol.launchDirection!, shot.launchDirection)).toBeLessThan(1e-12);
    maxResidual = Math.max(maxResidual, sol.residualMeters!);
    flight = shot.predictedFlightSeconds;
    if (weapon === 'machinegun') {
      expect(Math.abs(length(shot.initialVelocity!) - WEAPONS.machinegun.speed)).toBeLessThan(0.001);
      expect(distance(shot.initialVelocity!, scale(shot.launchDirection, WEAPONS.machinegun.speed))).toBeLessThan(1e-9);
      expect(shot.accelerationAtFire).toEqual(WEAPONS.machinegun.gravity);
      speed = length(shot.initialVelocity!);
    } else if (weapon === 'missile') {
      expect(Math.abs(length(shot.initialVelocity!) - WEAPONS.missile.speed)).toBeLessThan(0.001);
      expect(distance(shot.initialVelocity!, scale(shot.launchDirection, WEAPONS.missile.speed))).toBeLessThan(1e-9);
      expect(shot.accelerationAtFire).toEqual([0, 0, 0]);
      speed = length(shot.initialVelocity!);
    } else {
      expect(shot.initialVelocity).toBeNull();
      expect(shot.accelerationAtFire).toEqual([0, 0, 0]);
      expect(shot.predictedFlightSeconds).toBe(0);
    }
    // 移動中の試験: 自機速度を弾に加算しない（v0 は 100·d そのもの）
    if (movement !== 'none') {
      const mv = res.movementAtFire!;
      const pv = res.velocityAtFire!;
      if (movement === 'glide') {
        expect(mv.horizontalMode).toBe('glide');
        expect(mv.glideEnabled).toBe(true);
        expect(Math.hypot(pv[0], pv[2])).toBeGreaterThan(10);
      } else if (movement === 'fly') {
        expect(mv.verticalMode).toBe('flying');
        expect(pv[1]).toBeGreaterThan(0);
      } else {
        expect(mv.horizontalMode).toBe('quickboost');
        expect(mv.qbImpulseRemainingSeconds).toBeGreaterThan(0);
        expect(mv.qbSuccessfulCount).toBe(1);
        expect(Math.hypot(pv[0], pv[2])).toBeGreaterThan(60);
      }
      const v0 = scale(shot.launchDirection, WEAPONS.machinegun.speed);
      expect(distance(shot.initialVelocity!, v0)).toBeLessThan(1e-9);
      // 自機速度を足した値 v0 + pv とは |pv| だけ離れている（= 加算していない）
      expect(length(pv)).toBeGreaterThan(5);
      expect(distance(shot.initialVelocity!, add(v0, pv))).toBeCloseTo(length(pv), 9);
    }
    if (res.hits >= 1) hits++;
  }
  console.log(
    `[fcsHit] ${label} r=${fmt(c.r)} v=${fmt(c.v)}: hits ${hits}/${TRIALS}, ` +
      `tFire=${cal.tFire.toFixed(4)}s, flight=${flight === null ? 'null' : flight.toFixed(6)}s, ` +
      `residual<=${maxResidual.toExponential(2)}m, |v0|=${speed === null ? 'null' : speed.toFixed(6)}, ` +
      `calib passes=${cal.passes} (muzzle err ${cal.error.toExponential(1)} m)`,
  );
  return { hits, residual: maxResidual, flight, speed };
}

describe('§4.6 必須命中試験（Game 経由: ロック → 射撃 → 弾体 → 衝突）', () => {
  const probe = probeFireFrame();
  console.log(`[fcsHit] lockSeconds=${LOCK_SECONDS}, fire frame=${probe.frame}, tFire=${probe.tFire}`);

  it('発射フレームはロック所要時間どおり', () => {
    expect(probe.tFire).toBeGreaterThanOrEqual(LOCK_SECONDS - 1e-9);
    expect(probe.tFire).toBeLessThanOrEqual(LOCK_SECONDS + FRAME + 1e-9);
  });

  describe('マシンガン A01〜A13: 各 20/20 命中、残差 0.01 m 以下、|v0|=100±0.001', () => {
    for (const c of CASES) {
      it(`${c.id} r=${fmt(c.r)} v=${fmt(c.v)}`, () => {
        const s = runCondition(`MG ${c.id}`, c, 'machinegun', 'none', probe, WEAPONS.machinegun.lifetime + 0.5);
        expect(s.hits).toBe(TRIALS);
        expect(s.residual).toBeLessThanOrEqual(0.01);
        if (c.id === 'A03') expect(s.flight!).toBeCloseTo(1.004108529, 6);
        if (c.id === 'A05') expect(s.flight!).toBeCloseTo(1.007391236, 6);
        if (c.id === 'A13') {
          expect(s.flight!).toBeCloseTo(1.266137996, 6);
          expect(s.flight!).toBeGreaterThan(1.2);
        }
      });
    }
  });

  describe('ビーム A01〜A13: 発射時の現在位置へ 20/20 命中', () => {
    for (const c of CASES) {
      it(`${c.id} r=${fmt(c.r)} v=${fmt(c.v)}`, () => {
        const s = runCondition(`Beam ${c.id}`, c, 'beam', 'none', probe, 0.1);
        expect(s.hits).toBe(TRIALS);
        expect(s.residual).toBe(0);
      });
    }
  });

  describe('ミサイル A05・A06・A07: 偏差初期方向＋旋回上限で 4 s 以内に 20/20 命中', () => {
    for (const c of CASES.filter((x) => x.id === 'A05' || x.id === 'A06' || x.id === 'A07')) {
      it(`${c.id} r=${fmt(c.r)} v=${fmt(c.v)}`, () => {
        const s = runCondition(`Missile ${c.id}`, c, 'missile', 'none', probe, WEAPONS.missile.lifetime + 0.1);
        expect(s.hits).toBe(TRIALS);
        expect(s.flight!).toBeGreaterThan(0);
        expect(s.flight!).toBeLessThanOrEqual(WEAPONS.missile.solveMaxTime);
      });
    }
  });

  describe('移動中のマシンガン射撃（A05 の r, v）: 実際の銃口から発射し、自機速度を弾へ加算しない', () => {
    const a05 = CASES[4];
    for (const movement of ['glide', 'fly', 'qb'] as const) {
      it(`${movement}: 20/20 命中、v0 = 100·d`, () => {
        const s = runCondition(`MG A05 while ${movement}`, a05, 'machinegun', movement, probe, WEAPONS.machinegun.lifetime + 0.5);
        expect(s.hits).toBe(TRIALS);
        expect(Math.abs(s.speed! - WEAPONS.machinegun.speed)).toBeLessThan(0.001);
      });
    }
  });
});

describe('回帰（レビュー指摘）: Game 経由のミサイル観測は、ミサイル位置と同じ時刻の対象中心を記録する', () => {
  it('lastObservedPos = 対象の位置(lastObservedAt)（区間終点の中心ではない）、lastObservedAt は最後のサブステップの始点', () => {
    const v: Vec3 = [8, 0, 0];
    const start: Vec3 = [0, 20, 60];
    const stage = makeRangeStage({ targets: [{ id: TARGET_ID, center: start, velocity: v }] });
    const game = new Game({ stage, loadout: DEFAULT_LOADOUT, seed: 7, viewport: VIEW, buildNav: false });
    game.launch();
    let fired = false;
    let checks = 0;
    let hits = 0;
    for (let frame = 0; frame < 600 && game.state === 'playing'; frame++) {
      const info = game.targetInfo(TARGET_ID);
      if (!info) throw new Error('target missing');
      game.camera.lookAt(info.center);
      const input: InputFrame = { ...emptyInput() };
      if (frame === 0) input.weaponSelect = 'missile';
      if (!fired && game.fcs.state === 'locked' && game.fcs.targetId === TARGET_ID) {
        input.fireDown = true;
        fired = true;
      }
      game.setInput(input);
      game.advance(FRAME);
      for (const e of game.drainEvents()) if (e.type === 'enemyHit' && e.enemyId === TARGET_ID) hits++;
      const m = game.projectiles.missiles[0];
      if (m && m.lastObservedAt !== null && m.lastObservedPos) {
        // 試験標的は t=0 から等速直線運動: 位置(t) = start + v·t
        const expected = addScaled(start, v, m.lastObservedAt);
        expect(distance(m.lastObservedPos, expected)).toBeLessThan(1e-6);
        expect(m.lastObservedVel).toEqual(v);
        // 観測時刻はフレーム末尾の時刻ではなく、最後のサブステップの始点（≤ 1/120 s 前）
        expect(m.lastObservedAt).toBeLessThan(game.time);
        expect(m.lastObservedAt).toBeGreaterThanOrEqual(game.time - SIM.maxStep - 1e-9);
        checks++;
      }
      if (fired && game.projectiles.missiles.length === 0) break;
    }
    expect(fired).toBe(true);
    expect(checks).toBeGreaterThan(10);
    expect(hits).toBe(1);
  });
});
