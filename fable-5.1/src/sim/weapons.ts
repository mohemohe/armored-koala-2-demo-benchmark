/**
 * 射撃: トリガー押下中の発射時刻の決定と、発射時刻での射撃解の再計算・弾体生成（§4.1〜§4.4、§9、§10）。
 * 発射直前に FCS を再検証し、その時刻の銃口位置・対象位置・速度から解を求める。
 * 自機速度は弾体へ加算しない。拒否時は nextFireAt を更新しない。武器切り替えで nextFireAt はリセットしない。
 * Three.js / DOM に依存しない。
 */
import { WEAPONS } from '../params';
import type { CollisionWorld, FireDenialReason, InputFrame, ShotRecord, SimEvent, TargetInfo, Vec3, Weapon } from '../types';
import type { SimCamera } from './camera';
import { computeFireSolution } from './fcs';
import type { Fcs } from './fcs';
import type { Player } from './player';
import type { Projectiles } from './projectiles';
import { copy, normalize, scale, sub } from './vec';

export interface FireContext {
  time: number;
  player: Player;
  fcs: Fcs;
  camera: SimCamera;
  world: CollisionWorld;
  targets: TargetInfo[];
  projectiles: Projectiles;
  freeAimPoint: Vec3;
  events: SimEvent[];
  damageEnemy(id: string, amount: number, point: Vec3, weapon: Weapon): void;
  nextShotId(): number;
}

/** 同じ武器・同じ理由の fireDenied イベントの最短間隔 [s]（HUD 表示の連打防止。仕様値ではない） */
const DENIAL_EVENT_INTERVAL_SECONDS = 0.5;

/** 発射時刻の比較許容値（Game.processDueEvents と同じ 1e-9） */
const TIME_EPS = 1e-9;

/** EN 残量の比較許容値。Player.spendEn の EN_EPS（1e-9）と同じ値で判定し、nextFireTime と tryFire の可否を一致させる */
const EN_EPS = 1e-9;

const ZERO: Vec3 = [0, 0, 0];

export class Weapons {
  nextFireAt: Record<Weapon, number> = { machinegun: 0, beam: 0, missile: 0 };
  lastDenial: { weapon: Weapon; reason: FireDenialReason; time: number } | null = null;
  /** 最後に発行した fireDenied イベント（武器・理由・時刻） */
  private lastDenialEvent: { weapon: Weapon; reason: FireDenialReason; time: number } | null = null;

  reset(): void {
    this.nextFireAt = { machinegun: 0, beam: 0, missile: 0 };
    this.lastDenial = null;
    this.lastDenialEvent = null;
  }

  /**
   * トリガー押下中に次に発射を試みる時刻（≥ time）。押下していない・死亡・確実に不成立（弾 0 / EN 不足）なら null。
   */
  nextFireTime(player: Player, input: InputFrame, time: number): number | null {
    if (!input.fireDown || !player.alive) return null;
    const w = player.weapon;
    if (w === 'machinegun' && player.ammo.machinegun <= 0) return null;
    if (w === 'missile' && player.ammo.missile <= 0) return null;
    if (w === 'beam' && player.en < WEAPONS.beam.enCost - EN_EPS) return null;
    const next = this.nextFireAt[w];
    return next > time + TIME_EPS ? next : time;
  }

  /**
   * 拒否を記録し、fireDenied イベントを発行する。HUD が最後のイベントの武器・理由を表示するため、
   * 武器か理由が直前のイベントと異なれば即座に発行し、同じ武器・同じ理由の連続は 0.5 秒に 1 回に抑える。
   */
  private deny(ctx: FireContext, weapon: Weapon, reason: FireDenialReason): null {
    this.lastDenial = { weapon, reason, time: ctx.time };
    const last = this.lastDenialEvent;
    if (last === null || last.weapon !== weapon || last.reason !== reason || ctx.time - last.time >= DENIAL_EVENT_INTERVAL_SECONDS - TIME_EPS) {
      this.lastDenialEvent = { weapon, reason, time: ctx.time };
      ctx.events.push({ type: 'fireDenied', weapon, reason });
    }
    return null;
  }

  /** 自由射撃の方向: 銃口からカメラ中央の照準点へ（照準点が銃口と一致する退化時はカメラ前方） */
  private freeDirection(ctx: FireContext, muzzle: Vec3): Vec3 {
    const d = normalize(sub(ctx.freeAimPoint, muzzle));
    if (d[0] === 0 && d[1] === 0 && d[2] === 0) return ctx.camera.forward();
    return d;
  }

  /**
   * time に発射を試みる。成立すれば ShotRecord（events にも push）。拒否なら null。
   */
  tryFire(ctx: FireContext): ShotRecord | null {
    const player = ctx.player;
    const weapon = player.weapon;
    if (!player.alive) return null;
    const muzzle = player.getMuzzlePosition();

    // ロック条件をその時刻で再検証（検証のみ、進捗は進めない）
    ctx.fcs.update(0, { time: ctx.time, camera: ctx.camera, muzzle, targets: ctx.targets, world: ctx.world });
    const target = ctx.fcs.lockedTarget(ctx.targets);

    if (weapon === 'machinegun') return this.fireMachinegun(ctx, muzzle, target);
    if (weapon === 'beam') return this.fireBeam(ctx, muzzle, target);
    return this.fireMissile(ctx, muzzle, target);
  }

  private fireMachinegun(ctx: FireContext, muzzle: Vec3, target: TargetInfo | null): ShotRecord | null {
    const player = ctx.player;
    const mg = WEAPONS.machinegun;
    if (player.ammo.machinegun <= 0) return this.deny(ctx, 'machinegun', 'noAmmo');

    const sol = computeFireSolution('machinegun', muzzle, target, ctx.time);
    let direction: Vec3;
    if (sol.status === 'inactive' || !sol.launchDirection) {
      direction = this.freeDirection(ctx, muzzle);
    } else {
      direction = copy(sol.launchDirection);
      if (direction[0] === 0 && direction[1] === 0 && direction[2] === 0) direction = this.freeDirection(ctx, muzzle);
    }
    const v0 = scale(direction, mg.speed);

    ctx.projectiles.spawnMgBullet(muzzle, v0, ctx.time);
    player.ammo.machinegun -= 1;
    this.nextFireAt.machinegun = ctx.time + mg.interval;
    ctx.events.push({ type: 'mgFire', muzzle: copy(muzzle), direction: copy(direction) });

    return {
      id: ctx.nextShotId(),
      firedAtSeconds: ctx.time,
      weapon: 'machinegun',
      targetId: target ? target.id : null,
      solutionStatus: sol.status,
      muzzlePosition: copy(muzzle),
      targetPositionAtFire: target ? copy(target.center) : null,
      targetVelocityAtFire: target ? copy(target.velocity) : null,
      launchDirection: copy(direction),
      initialVelocity: copy(v0),
      accelerationAtFire: copy(mg.gravity),
      predictedFlightSeconds: sol.predictedFlightSeconds,
      predictedInterceptPosition: sol.predictedInterceptPosition ? copy(sol.predictedInterceptPosition) : null,
    };
  }

  private fireBeam(ctx: FireContext, muzzle: Vec3, target: TargetInfo | null): ShotRecord | null {
    const player = ctx.player;
    const beam = WEAPONS.beam;
    // EN 判定は spendEn に委ねる（不足なら何も変えない）
    if (!player.spendEn(beam.enCost, ctx.time)) return this.deny(ctx, 'beam', 'noEn');

    const sol = computeFireSolution('beam', muzzle, target, ctx.time);
    let direction: Vec3;
    if (sol.status === 'inactive' || !sol.launchDirection) {
      direction = this.freeDirection(ctx, muzzle);
    } else {
      direction = copy(sol.launchDirection);
      if (direction[0] === 0 && direction[1] === 0 && direction[2] === 0) direction = this.freeDirection(ctx, muzzle);
    }

    const hit = ctx.projectiles.fireBeam(muzzle, direction, ctx.world, ctx.targets);
    if (hit.hitEnemyId !== null) ctx.damageEnemy(hit.hitEnemyId, beam.damage, hit.point, 'beam');
    this.nextFireAt.beam = ctx.time + beam.interval;
    ctx.events.push({ type: 'beamFire', from: copy(muzzle), to: copy(hit.point), hitEnemyId: hit.hitEnemyId });

    return {
      id: ctx.nextShotId(),
      firedAtSeconds: ctx.time,
      weapon: 'beam',
      targetId: target ? target.id : null,
      solutionStatus: sol.status,
      muzzlePosition: copy(muzzle),
      targetPositionAtFire: target ? copy(target.center) : null,
      targetVelocityAtFire: target ? copy(target.velocity) : null,
      launchDirection: copy(direction),
      initialVelocity: null,
      accelerationAtFire: copy(ZERO),
      predictedFlightSeconds: sol.predictedFlightSeconds,
      predictedInterceptPosition: sol.predictedInterceptPosition ? copy(sol.predictedInterceptPosition) : null,
    };
  }

  private fireMissile(ctx: FireContext, muzzle: Vec3, target: TargetInfo | null): ShotRecord | null {
    const player = ctx.player;
    const ms = WEAPONS.missile;
    if (!target) return this.deny(ctx, 'missile', 'noLock');
    if (player.ammo.missile <= 0) return this.deny(ctx, 'missile', 'noAmmo');

    const sol = computeFireSolution('missile', muzzle, target, ctx.time);
    let direction: Vec3 = sol.launchDirection ? copy(sol.launchDirection) : normalize(sub(target.center, muzzle));
    if (direction[0] === 0 && direction[1] === 0 && direction[2] === 0) direction = this.freeDirection(ctx, muzzle);
    const v0 = scale(direction, ms.speed);

    ctx.projectiles.spawnMissile(muzzle, direction, target.id, ctx.time);
    player.ammo.missile -= 1;
    this.nextFireAt.missile = ctx.time + ms.interval;
    ctx.events.push({ type: 'missileFire', muzzle: copy(muzzle), direction: copy(direction) });

    return {
      id: ctx.nextShotId(),
      firedAtSeconds: ctx.time,
      weapon: 'missile',
      targetId: target.id,
      solutionStatus: sol.status,
      muzzlePosition: copy(muzzle),
      targetPositionAtFire: copy(target.center),
      targetVelocityAtFire: copy(target.velocity),
      launchDirection: copy(direction),
      initialVelocity: copy(v0),
      accelerationAtFire: copy(ZERO),
      predictedFlightSeconds: sol.status === 'solved' ? sol.predictedFlightSeconds : null,
      predictedInterceptPosition: sol.status === 'solved' && sol.predictedInterceptPosition ? copy(sol.predictedInterceptPosition) : null,
    };
  }
}
