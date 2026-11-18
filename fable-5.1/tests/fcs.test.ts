/**
 * FCS のロック条件・進捗・対象選択（§5）と computeFireSolution（§4.3/§4.4、§10 の status 意味論）の単体試験。
 */
import { describe, expect, it } from 'vitest';
import { FCS, SIM, WEAPONS, computeEffectiveStats, lockRadiusCssPx } from '../src/params';
import { solveLinearLead, solveMachinegunLead } from '../src/sim/ballistics';
import { SimCamera } from '../src/sim/camera';
import { createCollisionWorld } from '../src/sim/collision';
import { Fcs, computeFireSolution, type FcsContext } from '../src/sim/fcs';
import { addScaled, length, normalize, scale, sub } from '../src/sim/vec';
import type { CollisionWorld, TargetInfo, Vec3 } from '../src/types';

const H = 1 / 120;
const MUZZLE: Vec3 = [0, 20, 0];

function makeCamera(w = 1280, h = 720): SimCamera {
  const c = new SimCamera();
  c.setViewport(w, h);
  c.position = [0, 20, 0];
  c.lookAt([0, 20, 100]); // +Z を向く
  return c;
}

function target(id: string, center: Vec3, extra: Partial<TargetInfo> = {}): TargetInfo {
  return { id, alive: true, center: [...center] as Vec3, velocity: [0, 0, 0], radius: 1.3, ...extra };
}

function makeCtx(camera: SimCamera, targets: TargetInfo[], opts: { muzzle?: Vec3; world?: CollisionWorld; time?: number } = {}): FcsContext {
  return { time: opts.time ?? 0, camera, muzzle: opts.muzzle ?? MUZZLE, targets, world: opts.world ?? createCollisionWorld() };
}

function stepN(fcs: Fcs, ctx: FcsContext, n: number, h = H): void {
  for (let i = 0; i < n; i++) fcs.update(h, ctx);
}

/** medium FCS・2 脚のロック所要時間（0.8 s）に必要な 1/120 刻みの回数 */
const MEDIUM_STEPS = Math.round(FCS.kinds.medium.lockSeconds / H);

describe('Fcs: ロック円の半径', () => {
  it('radius = factor × min(w, h)、リサイズ後も一致する', () => {
    const cam = makeCamera(1280, 720);
    for (const kind of ['wide', 'medium', 'narrow'] as const) {
      const fcs = new Fcs(kind, FCS.kinds[kind].lockSeconds);
      expect(fcs.radiusCssPx(cam)).toBeCloseTo(FCS.kinds[kind].radiusFactor * 720, 12);
      expect(fcs.radiusCssPx(cam)).toBe(lockRadiusCssPx(kind, 1280, 720));
    }
    cam.setViewport(1920, 1080);
    const fcs = new Fcs('medium', FCS.kinds.medium.lockSeconds);
    expect(fcs.radiusCssPx(cam)).toBeCloseTo(0.2 * 1080, 12);
    cam.setViewport(2000, 900);
    expect(fcs.radiusCssPx(cam)).toBeCloseTo(0.2 * 900, 12);
  });
});

describe('Fcs: 取得と進捗', () => {
  it('中央の候補はちょうど lockSeconds でロック完了する（進捗が h/lockSeconds ずつ増える）', () => {
    const cam = makeCamera();
    const fcs = new Fcs('medium', FCS.kinds.medium.lockSeconds);
    const ctx = makeCtx(cam, [target('a', [0, 20, 50])]);
    expect(fcs.state).toBe('none');
    expect(fcs.progress).toBe(0);
    for (let i = 1; i < MEDIUM_STEPS; i++) {
      fcs.update(H, ctx);
      expect(fcs.state).toBe('acquiring');
      expect(fcs.targetId).toBe('a');
      expect(fcs.progress).toBeCloseTo(i / MEDIUM_STEPS, 9);
      expect(fcs.progress).toBeLessThan(1);
    }
    fcs.update(H, ctx);
    expect(fcs.state).toBe('locked');
    expect(fcs.progress).toBe(1);
    expect(fcs.lockedTarget(ctx.targets)?.id).toBe('a');
    // 以降も 1 にクランプ
    stepN(fcs, ctx, 10);
    expect(fcs.progress).toBe(1);
    expect(fcs.state).toBe('locked');
  });

  it('lockSeconds はコンストラクタの値を使う（中範囲＋4脚 = 0.533 s → 64 刻み）', () => {
    const stats = computeEffectiveStats({ fcs: 'medium', generator: 'balanced', legs: 'quadruped' });
    expect(stats.lockSeconds).toBeCloseTo(0.8 / 1.5, 12);
    const cam = makeCamera();
    const fcs = new Fcs('medium', stats.lockSeconds);
    expect(fcs.lockSeconds).toBe(stats.lockSeconds);
    const ctx = makeCtx(cam, [target('a', [0, 20, 50])]);
    const steps = Math.round(stats.lockSeconds / H);
    expect(steps).toBe(64);
    stepN(fcs, ctx, steps - 1);
    expect(fcs.state).toBe('acquiring');
    fcs.update(H, ctx);
    expect(fcs.state).toBe('locked');
    expect(fcs.progress).toBe(1);
  });

  it('円の外の対象は取得しない', () => {
    const cam = makeCamera();
    const fcs = new Fcs('medium', FCS.kinds.medium.lockSeconds);
    // 深度 50 m で横 20 m: 約 206 px（半径 144 px の外）
    const ctx = makeCtx(cam, [target('a', [20, 20, 50])]);
    const sp = cam.project([20, 20, 50]);
    expect(cam.distanceFromCenter(sp)).toBeGreaterThan(fcs.radiusCssPx(cam));
    stepN(fcs, ctx, 300);
    expect(fcs.state).toBe('none');
    expect(fcs.targetId).toBeNull();
    expect(fcs.progress).toBe(0);
    // 横 5 m（約 51 px）は円内
    const ctx2 = makeCtx(cam, [target('a', [5, 20, 50])]);
    fcs.update(H, ctx2);
    expect(fcs.targetId).toBe('a');
  });

  it('カメラ背後・銃口から 120 m 超は候補にならない', () => {
    const cam = makeCamera();
    const fcs = new Fcs('medium', FCS.kinds.medium.lockSeconds);
    stepN(fcs, makeCtx(cam, [target('behind', [0, 20, -50])]), 50);
    expect(fcs.state).toBe('none');

    stepN(fcs, makeCtx(cam, [target('far', [0, 20, FCS.range + 1])]), 50);
    expect(fcs.state).toBe('none');

    fcs.update(H, makeCtx(cam, [target('near', [0, 20, FCS.range - 0.1])]));
    expect(fcs.targetId).toBe('near');
    fcs.reset();

    // 距離は銃口基準: カメラから 125 m でも銃口から 115 m なら候補
    fcs.update(H, makeCtx(cam, [target('m', [0, 20, 125])], { muzzle: [0, 20, 10] }));
    expect(fcs.targetId).toBe('m');
    fcs.reset();
    // カメラから 115 m でも銃口から 125 m なら不可
    fcs.update(H, makeCtx(cam, [target('m', [0, 20, 115])], { muzzle: [0, 20, -10] }));
    expect(fcs.targetId).toBeNull();
  });

  it('壁越しは候補にならない（カメラ遮蔽と銃口遮蔽を別々に）', () => {
    const cam = makeCamera();
    const muzzle: Vec3 = [2, 18, 3];
    const center: Vec3 = [0, 20, 50];

    // 遮蔽なし: 取得できる（前提確認）
    {
      const fcs = new Fcs('medium', FCS.kinds.medium.lockSeconds);
      fcs.update(H, makeCtx(cam, [target('a', center)], { muzzle }));
      expect(fcs.targetId).toBe('a');
    }
    // カメラ→対象だけを遮る小さな壁
    {
      const world = createCollisionWorld();
      world.addCollider({ min: [-0.5, 19.5, 1], max: [0.5, 20.5, 1.2] });
      expect(world.segmentBlocked(cam.position, center)).toBe(true);
      expect(world.segmentBlocked(muzzle, center)).toBe(false);
      const fcs = new Fcs('medium', FCS.kinds.medium.lockSeconds);
      stepN(fcs, makeCtx(cam, [target('a', center)], { muzzle, world }), 200);
      expect(fcs.state).toBe('none');
      expect(fcs.targetId).toBeNull();
    }
    // 銃口→対象だけを遮る小さな壁
    {
      const world = createCollisionWorld();
      world.addCollider({ min: [1.5, 17.5, 4], max: [2.5, 18.5, 4.2] });
      expect(world.segmentBlocked(cam.position, center)).toBe(false);
      expect(world.segmentBlocked(muzzle, center)).toBe(true);
      const fcs = new Fcs('medium', FCS.kinds.medium.lockSeconds);
      stepN(fcs, makeCtx(cam, [target('a', center)], { muzzle, world }), 200);
      expect(fcs.state).toBe('none');
      expect(fcs.targetId).toBeNull();
    }
  });

  it('最初の選択は画面中心に最も近い候補、同距離は ID 昇順', () => {
    const cam = makeCamera();
    const fcs = new Fcs('medium', FCS.kinds.medium.lockSeconds);
    fcs.update(H, makeCtx(cam, [target('far', [5, 20, 50]), target('near', [1, 20, 50])]));
    expect(fcs.targetId).toBe('near');
    fcs.reset();
    // 同距離（同一位置）: ID 昇順で 'a'
    fcs.update(H, makeCtx(cam, [target('b', [2, 20, 50]), target('a', [2, 20, 50])]));
    expect(fcs.targetId).toBe('a');
    fcs.reset();
    fcs.update(H, makeCtx(cam, [target('a', [2, 20, 50]), target('b', [2, 20, 50])]));
    expect(fcs.targetId).toBe('a');
  });

  it('選択中の対象は、別の敵が中央に近づいても変更しない', () => {
    const cam = makeCamera();
    const fcs = new Fcs('medium', FCS.kinds.medium.lockSeconds);
    const a = target('a', [5, 20, 50]);
    stepN(fcs, makeCtx(cam, [a]), 10);
    expect(fcs.targetId).toBe('a');
    const p10 = fcs.progress;
    const b = target('b', [0, 20, 50]);
    stepN(fcs, makeCtx(cam, [a, b]), 10);
    expect(fcs.targetId).toBe('a');
    expect(fcs.progress).toBeCloseTo(p10 + (10 * H) / FCS.kinds.medium.lockSeconds, 9);
    stepN(fcs, makeCtx(cam, [a, b]), MEDIUM_STEPS);
    expect(fcs.state).toBe('locked');
    expect(fcs.targetId).toBe('a');
  });

  it('対象が円から出たら即座に破棄し、次の対象は 0 から始める', () => {
    const cam = makeCamera();
    const fcs = new Fcs('medium', FCS.kinds.medium.lockSeconds);
    const a = target('a', [5, 20, 50]);
    stepN(fcs, makeCtx(cam, [a]), 50);
    expect(fcs.targetId).toBe('a');
    expect(fcs.progress).toBeGreaterThan(0.5);
    // a が円外へ、b が中央に存在
    const aOut = target('a', [20, 20, 50]);
    const b = target('b', [0, 20, 50]);
    fcs.update(H, makeCtx(cam, [aOut, b]));
    expect(fcs.targetId).toBe('b');
    expect(fcs.state).toBe('acquiring');
    expect(fcs.progress).toBeLessThanOrEqual(H / FCS.kinds.medium.lockSeconds + 1e-12);
    // 他に候補がなければ none / 0 / null
    fcs.update(H, makeCtx(cam, [target('b', [20, 20, 50])]));
    expect(fcs.state).toBe('none');
    expect(fcs.targetId).toBeNull();
    expect(fcs.progress).toBe(0);
  });

  it('ロック完了後でも失効すれば即座に破棄する（円外・遮蔽・距離・破壊）', () => {
    const cam = makeCamera();
    const lockIt = (): Fcs => {
      const fcs = new Fcs('medium', FCS.kinds.medium.lockSeconds);
      stepN(fcs, makeCtx(cam, [target('a', [0, 20, 50])]), MEDIUM_STEPS);
      expect(fcs.state).toBe('locked');
      return fcs;
    };
    // 円外
    let fcs = lockIt();
    fcs.update(H, makeCtx(cam, [target('a', [20, 20, 50])]));
    expect(fcs.state).toBe('none');
    expect(fcs.progress).toBe(0);
    expect(fcs.targetId).toBeNull();
    // 遮蔽
    fcs = lockIt();
    const world = createCollisionWorld();
    world.addCollider({ min: [-10, 0, 20], max: [10, 40, 21] });
    fcs.update(H, makeCtx(cam, [target('a', [0, 20, 50])], { world }));
    expect(fcs.state).toBe('none');
    // 距離
    fcs = lockIt();
    fcs.update(H, makeCtx(cam, [target('a', [0, 20, FCS.range + 5])]));
    expect(fcs.state).toBe('none');
    // 破壊
    fcs = lockIt();
    fcs.update(H, makeCtx(cam, [target('a', [0, 20, 50], { alive: false })]));
    expect(fcs.state).toBe('none');
    expect(fcs.lockedTarget([target('a', [0, 20, 50], { alive: false })])).toBeNull();
    // 対象が配列から消えた
    fcs = lockIt();
    fcs.update(H, makeCtx(cam, []));
    expect(fcs.state).toBe('none');
  });

  it('update(0) は検証のみで進捗を進めない（失効の検出はする）', () => {
    const cam = makeCamera();
    const fcs = new Fcs('medium', FCS.kinds.medium.lockSeconds);
    const ctx = makeCtx(cam, [target('a', [0, 20, 50])]);
    stepN(fcs, ctx, 30);
    const p = fcs.progress;
    for (let i = 0; i < 100; i++) fcs.update(0, ctx);
    expect(fcs.progress).toBe(p);
    expect(fcs.state).toBe('acquiring');
    expect(fcs.targetId).toBe('a');
    // 未選択時の update(0) は新規取得しない
    const fresh = new Fcs('medium', FCS.kinds.medium.lockSeconds);
    fresh.update(0, ctx);
    expect(fresh.targetId).toBeNull();
    expect(fresh.state).toBe('none');
    // 失効は update(0) でも検出
    fcs.update(0, makeCtx(cam, [target('a', [20, 20, 50])]));
    expect(fcs.state).toBe('none');
    expect(fcs.targetId).toBeNull();
  });

  it('lockedTarget はロック完了かつ生存のときだけ返す', () => {
    const cam = makeCamera();
    const fcs = new Fcs('narrow', FCS.kinds.narrow.lockSeconds);
    const targets = [target('a', [0, 20, 50])];
    fcs.update(H, makeCtx(cam, targets));
    expect(fcs.state).toBe('acquiring');
    expect(fcs.lockedTarget(targets)).toBeNull();
    stepN(fcs, makeCtx(cam, targets), Math.round(FCS.kinds.narrow.lockSeconds / H));
    expect(fcs.state).toBe('locked');
    expect(fcs.lockedTarget(targets)?.id).toBe('a');
    expect(fcs.lockedTarget([target('a', [0, 20, 50], { alive: false })])).toBeNull();
    expect(fcs.lockedTarget([])).toBeNull();
  });

  it('reset で全て初期化', () => {
    const cam = makeCamera();
    const fcs = new Fcs('medium', FCS.kinds.medium.lockSeconds);
    stepN(fcs, makeCtx(cam, [target('a', [0, 20, 50])]), MEDIUM_STEPS);
    fcs.reset();
    expect(fcs.state).toBe('none');
    expect(fcs.targetId).toBeNull();
    expect(fcs.progress).toBe(0);
  });
});

describe('computeFireSolution', () => {
  const m: Vec3 = [0, 20, 0];
  const g = WEAPONS.machinegun.gravity;

  it('対象なしは inactive（weapon 以外 null）', () => {
    for (const w of ['machinegun', 'beam', 'missile'] as const) {
      const s = computeFireSolution(w, m, null, 1.5);
      expect(s.status).toBe('inactive');
      expect(s.weapon).toBe(w);
      expect(s.targetId).toBeNull();
      expect(s.evaluatedAtSeconds).toBeNull();
      expect(s.muzzlePosition).toBeNull();
      expect(s.targetPosition).toBeNull();
      expect(s.targetVelocity).toBeNull();
      expect(s.launchDirection).toBeNull();
      expect(s.predictedFlightSeconds).toBeNull();
      expect(s.predictedInterceptPosition).toBeNull();
      expect(s.aimPoint).toBeNull();
      expect(s.residualMeters).toBeNull();
    }
  });

  it('machinegun solved: A03 の参考値と一致し、命中点・補正照準点が式どおり', () => {
    const t = target('e', [0, 20, 100]);
    const s = computeFireSolution('machinegun', m, t, 2.5);
    expect(s.status).toBe('solved');
    expect(s.targetId).toBe('e');
    expect(s.evaluatedAtSeconds).toBe(2.5);
    expect(s.muzzlePosition).toEqual(m);
    expect(s.targetPosition).toEqual([0, 20, 100]);
    expect(s.targetVelocity).toEqual([0, 0, 0]);
    expect(s.predictedFlightSeconds!).toBeCloseTo(1.004108529, 6);
    const v0 = scale(s.launchDirection!, WEAPONS.machinegun.speed);
    expect(v0[0]).toBeCloseTo(0, 6);
    expect(v0[1]).toBeCloseTo(9.036976765, 6);
    expect(v0[2]).toBeCloseTo(99.590828147, 6);
    expect(length(s.launchDirection!)).toBeCloseTo(1, 12);
    expect(s.residualMeters!).toBeLessThanOrEqual(0.01);
    const tt = s.predictedFlightSeconds!;
    expect(s.predictedInterceptPosition).toEqual([0, 20, 100]);
    const aim = addScaled([0, 20, 100], g, -0.5 * tt * tt);
    expect(s.aimPoint![0]).toBeCloseTo(aim[0], 12);
    expect(s.aimPoint![1]).toBeCloseTo(aim[1], 12);
    expect(s.aimPoint![2]).toBeCloseTo(aim[2], 12);
    expect(s.aimPoint![1]).toBeGreaterThan(s.predictedInterceptPosition![1]);
  });

  it('machinegun solved: 移動標的（A05）は p+vt を命中点とする', () => {
    const t = target('e', [0, 20, 100], { velocity: [8, 0, 0] });
    const s = computeFireSolution('machinegun', m, t, 0);
    expect(s.status).toBe('solved');
    const tt = s.predictedFlightSeconds!;
    expect(tt).toBeCloseTo(1.007391236, 6);
    expect(s.predictedInterceptPosition![0]).toBeCloseTo(8 * tt, 12);
    const ref = solveMachinegunLead(sub(t.center, m), t.velocity, WEAPONS.machinegun.speed, g, WEAPONS.machinegun.solveMaxTime)!;
    expect(s.launchDirection).toEqual(ref.direction);
  });

  it('machinegun no_solution: 直接照準方向と aimPoint=p、到達時間・命中点・残差は null', () => {
    // 100 m/s の弾では 2 s 以内に届かない距離
    const t = target('e', [0, 20, 300]);
    expect(solveMachinegunLead(sub(t.center, m), t.velocity, WEAPONS.machinegun.speed, g, WEAPONS.machinegun.solveMaxTime)).toBeNull();
    const s = computeFireSolution('machinegun', m, t, 3);
    expect(s.status).toBe('no_solution');
    expect(s.targetId).toBe('e');
    expect(s.evaluatedAtSeconds).toBe(3);
    expect(s.muzzlePosition).toEqual(m);
    expect(s.targetPosition).toEqual([0, 20, 300]);
    expect(s.targetVelocity).toEqual([0, 0, 0]);
    expect(s.launchDirection).toEqual(normalize(sub(t.center, m)));
    expect(s.aimPoint).toEqual([0, 20, 300]);
    expect(s.predictedFlightSeconds).toBeNull();
    expect(s.predictedInterceptPosition).toBeNull();
    expect(s.residualMeters).toBeNull();
  });

  it('beam: 現在位置へ、到達時間 0、残差 0', () => {
    const t = target('e', [10, 25, 80], { velocity: [8, 0, 0] });
    const s = computeFireSolution('beam', m, t, 1);
    expect(s.status).toBe('solved');
    expect(s.launchDirection).toEqual(normalize(sub(t.center, m)));
    expect(s.predictedFlightSeconds).toBe(0);
    expect(s.residualMeters).toBe(0);
    expect(s.predictedInterceptPosition).toEqual([10, 25, 80]);
    expect(s.aimPoint).toEqual([10, 25, 80]);
  });

  it('missile: 45 m/s の等速偏差、解なしは現在位置方向', () => {
    const t = target('e', [0, 20, 100], { velocity: [8, 0, 0] });
    const s = computeFireSolution('missile', m, t, 0);
    expect(s.status).toBe('solved');
    const ref = solveLinearLead([0, 0, 100], [8, 0, 0], WEAPONS.missile.speed, WEAPONS.missile.solveMaxTime)!;
    expect(s.predictedFlightSeconds).toBe(ref.t);
    expect(s.launchDirection).toEqual(ref.direction);
    expect(s.launchDirection).toEqual(normalize(addScaled([0, 0, 100], [8, 0, 0], ref.t)));
    expect(s.predictedInterceptPosition).toEqual(addScaled([0, 20, 100], [8, 0, 0], ref.t));
    expect(s.aimPoint).toEqual(s.predictedInterceptPosition);
    // 45 m/s より速く遠ざかる対象: 解なし
    const away = target('e', [0, 20, 100], { velocity: [0, 0, 50] });
    const n = computeFireSolution('missile', m, away, 0);
    expect(n.status).toBe('no_solution');
    expect(n.launchDirection).toEqual(normalize([0, 0, 100]));
    expect(n.aimPoint).toEqual([0, 20, 100]);
    expect(n.predictedFlightSeconds).toBeNull();
    expect(n.predictedInterceptPosition).toBeNull();
    expect(n.residualMeters).toBeNull();
  });

  it('返り値は入力のコピー（呼び出し側の配列を共有しない）', () => {
    const t = target('e', [0, 20, 100]);
    const s = computeFireSolution('machinegun', m, t, 0);
    expect(s.muzzlePosition).not.toBe(m);
    expect(s.targetPosition).not.toBe(t.center);
    expect(s.targetVelocity).not.toBe(t.velocity);
  });
});

describe('Fcs: 回帰（レビュー指摘）ロック完了時刻の粒度', () => {
  it('不規則な刻み（0.0173 s フレームを 1/120 s 以下に分割）でも、ロック完了は lockSeconds 以上かつ lockSeconds + 最大刻み以下', () => {
    const cam = makeCamera();
    const lockSeconds = FCS.kinds.medium.lockSeconds;
    const fcs = new Fcs('medium', lockSeconds);
    const ctx = makeCtx(cam, [target('a', [0, 20, 50])]);
    const frameDt = 0.0173;
    let time = 0;
    let lockedAt: number | null = null;
    for (let f = 0; f < 100 && lockedAt === null; f++) {
      let remaining = frameDt;
      while (remaining > 1e-9 && lockedAt === null) {
        const h = Math.min(remaining, SIM.maxStep);
        fcs.update(h, ctx);
        time += h;
        remaining -= h;
        if (fcs.state === 'locked') lockedAt = time;
      }
    }
    expect(lockedAt).not.toBeNull();
    expect(lockedAt!).toBeGreaterThanOrEqual(lockSeconds - 1e-9);
    expect(lockedAt!).toBeLessThanOrEqual(lockSeconds + SIM.maxStep + 1e-9);
    // 1/120 の整数倍で刻めばちょうど lockSeconds（fcsHit の tFire=0.8000 と同じ）
    const fcs2 = new Fcs('medium', lockSeconds);
    let t2 = 0;
    while (fcs2.state !== 'locked') {
      fcs2.update(H, ctx);
      t2 += H;
    }
    expect(t2).toBeCloseTo(lockSeconds, 9);
  });

  it('対象が切り替わった更新では、新しい対象の進捗はその更新幅 h/lockSeconds ちょうど（前の対象の進捗を引き継がない）', () => {
    const cam = makeCamera();
    const fcs = new Fcs('medium', FCS.kinds.medium.lockSeconds);
    stepN(fcs, makeCtx(cam, [target('a', [5, 20, 50])]), 50);
    expect(fcs.progress).toBeGreaterThan(0.5);
    fcs.update(H, makeCtx(cam, [target('a', [20, 20, 50]), target('b', [0, 20, 50])]));
    expect(fcs.targetId).toBe('b');
    expect(fcs.state).toBe('acquiring');
    expect(fcs.progress).toBeCloseTo(H / FCS.kinds.medium.lockSeconds, 12);
  });
});
