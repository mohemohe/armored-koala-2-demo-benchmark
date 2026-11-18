/**
 * FCS（Flight Control System）: ロック対象の取得・進捗と、武器ごとの射撃解（§4.3/§4.4/§5）。
 * Three.js / DOM に依存しない。
 */
import { FCS, WEAPONS, lockRadiusCssPx } from '../params';
import type { CollisionWorld, FcsKind, FireSolution, LockState, TargetInfo, Vec3, Weapon } from '../types';
import { solveLinearLead, solveMachinegunLead } from './ballistics';
import type { SimCamera } from './camera';
import { addScaled, copy, distance, normalize, sub } from './vec';

export interface FcsContext {
  time: number;
  camera: SimCamera;
  muzzle: Vec3;
  targets: TargetInfo[];
  world: CollisionWorld;
}

/**
 * 距離・画面距離の境界（「以内」）を数値誤差に対して安定に扱うための許容値。
 * §4.6 の A04/A13 は銃口からちょうど 120 m に標的を置くため、丸め誤差で境界を外れないようにする。
 * 仕様の数値ではなく、浮動小数点の丸め幅を吸収する目的のみ。
 */
const RANGE_TOLERANCE_METERS = 1e-6;
const RADIUS_TOLERANCE_PX = 1e-6;
/** 進捗が 1 に到達したとみなす許容値（h/lockSeconds の累積丸め誤差を吸収） */
const PROGRESS_EPS = 1e-9;
/** 画面中心距離の同値判定（同距離は ID 昇順） */
const CENTER_DISTANCE_TIE_PX = 1e-6;

export class Fcs {
  readonly kind: FcsKind;
  lockSeconds: number;
  state: LockState = 'none';
  targetId: string | null = null;
  /** 0..1 */
  progress = 0;

  constructor(kind: FcsKind, lockSeconds: number) {
    this.kind = kind;
    this.lockSeconds = lockSeconds;
  }

  reset(): void {
    this.state = 'none';
    this.targetId = null;
    this.progress = 0;
  }

  /** ロック円の半径 [CSS px] */
  radiusCssPx(camera: SimCamera): number {
    return lockRadiusCssPx(this.kind, camera.viewportWidth, camera.viewportHeight);
  }

  /** 候補条件（§5）: 生存、銃口から 120 m 以内、カメラ前方、画面中心から半径以内、カメラ・銃口の双方から遮蔽なし */
  private isCandidate(t: TargetInfo, ctx: FcsContext, radiusPx: number): boolean {
    if (!t.alive) return false;
    if (distance(ctx.muzzle, t.center) > FCS.range + RANGE_TOLERANCE_METERS) return false;
    const sp = ctx.camera.project(t.center);
    if (!sp.inFront) return false;
    if (ctx.camera.distanceFromCenter(sp) > radiusPx + RADIUS_TOLERANCE_PX) return false;
    if (ctx.world.segmentBlocked(ctx.camera.position, t.center)) return false;
    if (ctx.world.segmentBlocked(ctx.muzzle, t.center)) return false;
    return true;
  }

  private drop(): void {
    this.state = 'none';
    this.targetId = null;
    this.progress = 0;
  }

  /**
   * 候補条件を再評価し、同じ対象が条件を満たし続けていれば progress += h/lockSeconds。
   * 失効したら即座に破棄（次の対象は 0 から）。h=0 では現在の対象の再検証のみ行う。
   */
  update(h: number, ctx: FcsContext): void {
    const radiusPx = this.radiusCssPx(ctx.camera);

    // 現在の対象の再検証
    if (this.targetId !== null) {
      let current: TargetInfo | null = null;
      for (const t of ctx.targets) {
        if (t.id === this.targetId) {
          current = t;
          break;
        }
      }
      if (current === null || !this.isCandidate(current, ctx, radiusPx)) {
        this.drop();
      }
    }

    if (!(h > 0)) return; // 検証のみ

    // 未選択なら中心に最も近い候補（同距離は ID 昇順）
    if (this.targetId === null) {
      let best: TargetInfo | null = null;
      let bestDist = Infinity;
      for (const t of ctx.targets) {
        if (!this.isCandidate(t, ctx, radiusPx)) continue;
        const d = ctx.camera.distanceFromCenter(ctx.camera.project(t.center));
        if (best === null || d < bestDist - CENTER_DISTANCE_TIE_PX || (Math.abs(d - bestDist) <= CENTER_DISTANCE_TIE_PX && t.id < best.id)) {
          best = t;
          bestDist = d;
        }
      }
      if (best === null) {
        this.drop();
        return;
      }
      this.targetId = best.id;
      this.progress = 0;
    }

    // 進捗
    const lockSeconds = this.lockSeconds > 0 ? this.lockSeconds : 0;
    let p = lockSeconds > 0 ? this.progress + h / lockSeconds : 1;
    if (p >= 1 - PROGRESS_EPS) p = 1;
    this.progress = p;
    this.state = p >= 1 ? 'locked' : 'acquiring';
  }

  /** state==='locked' かつ対象が生存なら TargetInfo */
  lockedTarget(targets: TargetInfo[]): TargetInfo | null {
    if (this.state !== 'locked' || this.targetId === null) return null;
    for (const t of targets) {
      if (t.id === this.targetId) return t.alive ? t : null;
    }
    return null;
  }
}

function inactiveSolution(weapon: Weapon): FireSolution {
  return {
    status: 'inactive',
    weapon,
    targetId: null,
    evaluatedAtSeconds: null,
    muzzlePosition: null,
    targetPosition: null,
    targetVelocity: null,
    launchDirection: null,
    predictedFlightSeconds: null,
    predictedInterceptPosition: null,
    aimPoint: null,
    residualMeters: null,
  };
}

/** 対象の現在位置への直接照準方向（銃口と中心がほぼ同一なら零ベクトル） */
function directDirection(muzzle: Vec3, center: Vec3): Vec3 {
  return normalize(sub(center, muzzle));
}

/**
 * 武器ごとの射撃解（§4.3 マシンガン、§4.4 ビーム・ミサイル）。
 * target が null なら inactive（weapon 以外 null）。
 */
export function computeFireSolution(weapon: Weapon, muzzle: Vec3, target: TargetInfo | null, time: number): FireSolution {
  if (target === null) return inactiveSolution(weapon);
  const m = copy(muzzle);
  const p = copy(target.center);
  const v = copy(target.velocity);
  const r = sub(p, m);
  const base = {
    weapon,
    targetId: target.id,
    evaluatedAtSeconds: time,
    muzzlePosition: m,
    targetPosition: p,
    targetVelocity: v,
  };

  if (weapon === 'machinegun') {
    const mg = WEAPONS.machinegun;
    const sol = solveMachinegunLead(r, v, mg.speed, mg.gravity, mg.solveMaxTime);
    if (sol) {
      const t = sol.t;
      const intercept = addScaled(p, v, t);
      const aim = addScaled(intercept, mg.gravity, -0.5 * t * t);
      return {
        status: 'solved',
        ...base,
        launchDirection: copy(sol.direction),
        predictedFlightSeconds: t,
        predictedInterceptPosition: intercept,
        aimPoint: aim,
        residualMeters: sol.residualMeters,
      };
    }
    return {
      status: 'no_solution',
      ...base,
      launchDirection: directDirection(m, p),
      predictedFlightSeconds: null,
      predictedInterceptPosition: null,
      aimPoint: copy(p),
      residualMeters: null,
    };
  }

  if (weapon === 'beam') {
    return {
      status: 'solved',
      ...base,
      launchDirection: directDirection(m, p),
      predictedFlightSeconds: 0,
      predictedInterceptPosition: copy(p),
      aimPoint: copy(p),
      residualMeters: 0,
    };
  }

  // missile
  const ms = WEAPONS.missile;
  const sol = solveLinearLead(r, v, ms.speed, ms.solveMaxTime);
  if (sol) {
    const t = sol.t;
    const intercept = addScaled(p, v, t);
    return {
      status: 'solved',
      ...base,
      launchDirection: copy(sol.direction),
      predictedFlightSeconds: t,
      predictedInterceptPosition: intercept,
      aimPoint: copy(intercept),
      residualMeters: sol.residualMeters,
    };
  }
  return {
    status: 'no_solution',
    ...base,
    launchDirection: directDirection(m, p),
    predictedFlightSeconds: null,
    predictedInterceptPosition: null,
    aimPoint: copy(p),
    residualMeters: null,
  };
}
