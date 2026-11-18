/**
 * Weapons の単体試験（偽の Player を使用）: 射撃間隔と時刻分割、弾・EN の消費、拒否、ShotRecord の内容（§4.1、§10）。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_LOADOUT, FCS, WEAPONS } from '../src/params';
import { solveLinearLead, solveMachinegunLead } from '../src/sim/ballistics';
import { SimCamera } from '../src/sim/camera';
import { createCollisionWorld } from '../src/sim/collision';
import { Fcs } from '../src/sim/fcs';
import { Player } from '../src/sim/player';
import { Projectiles } from '../src/sim/projectiles';
import { length, normalize, scale, sub } from '../src/sim/vec';
import { Weapons, type FireContext } from '../src/sim/weapons';
import type { CollisionWorld, InputFrame, ShotRecord, SimEvent, TargetInfo, Vec3, Weapon } from '../src/types';
import { emptyInput } from '../src/types';

const H = 1 / 120;
const MUZZLE: Vec3 = [0, 20, 0];
const MG = WEAPONS.machinegun;

interface FakePlayer {
  weapon: Weapon;
  ammo: { machinegun: number; missile: number };
  en: number;
  alive: boolean;
  yaw: number;
  pos: Vec3;
  spendEn(amount: number, time: number): boolean;
  getMuzzlePosition(): Vec3;
  lastEnSpentAt: number | null;
}

function fakePlayer(over: Partial<FakePlayer> = {}): FakePlayer {
  const p: FakePlayer = {
    weapon: 'machinegun',
    ammo: { machinegun: MG.ammo, missile: WEAPONS.missile.ammo },
    en: 120,
    alive: true,
    yaw: Math.PI,
    pos: [0.95, 17.95, 0.9],
    lastEnSpentAt: null,
    spendEn(amount: number, time: number): boolean {
      if (this.en < amount) return false;
      this.en -= amount;
      this.lastEnSpentAt = time;
      return true;
    },
    getMuzzlePosition(): Vec3 {
      return [...MUZZLE] as Vec3;
    },
    ...over,
  };
  return p;
}

function asPlayer(p: FakePlayer): Player {
  return p as unknown as Player;
}

interface Rig {
  weapons: Weapons;
  player: FakePlayer;
  fcs: Fcs;
  camera: SimCamera;
  world: CollisionWorld;
  targets: TargetInfo[];
  projectiles: Projectiles;
  freeAimPoint: Vec3;
  events: SimEvent[];
  damage: { id: string; amount: number; point: Vec3; weapon: Weapon }[];
  shotSeq: number;
  ctx(time: number): FireContext;
}

function makeRig(opts: { targets?: TargetInfo[]; player?: Partial<FakePlayer>; world?: CollisionWorld } = {}): Rig {
  const camera = new SimCamera();
  camera.setViewport(1280, 720);
  camera.position = [0, 20, -8];
  camera.lookAt([0, 20, 100]);
  const rig: Rig = {
    weapons: new Weapons(),
    player: fakePlayer(opts.player),
    fcs: new Fcs('medium', FCS.kinds.medium.lockSeconds),
    camera,
    world: opts.world ?? createCollisionWorld(),
    targets: opts.targets ?? [],
    projectiles: new Projectiles(),
    freeAimPoint: [0, 20, 100],
    events: [],
    damage: [],
    shotSeq: 0,
    ctx(time: number): FireContext {
      return {
        time,
        player: asPlayer(rig.player),
        fcs: rig.fcs,
        camera: rig.camera,
        world: rig.world,
        targets: rig.targets,
        projectiles: rig.projectiles,
        freeAimPoint: rig.freeAimPoint,
        events: rig.events,
        damageEnemy: (id, amount, point, weapon) => rig.damage.push({ id, amount, point: [...point] as Vec3, weapon }),
        nextShotId: () => ++rig.shotSeq,
      };
    },
  };
  return rig;
}

function target(id: string, center: Vec3, velocity: Vec3 = [0, 0, 0]): TargetInfo {
  return { id, alive: true, center: [...center] as Vec3, velocity: [...velocity] as Vec3, radius: 0.5 };
}

/** FCS をロック完了まで進める */
function lockOn(rig: Rig, time = 0): void {
  rig.camera.lookAt(rig.targets[0].center);
  const steps = Math.round(rig.fcs.lockSeconds / H) + 1;
  for (let i = 0; i < steps; i++) {
    rig.fcs.update(H, { time, camera: rig.camera, muzzle: rig.player.getMuzzlePosition(), targets: rig.targets, world: rig.world });
  }
  expect(rig.fcs.state).toBe('locked');
}

/**
 * Game.advance と同じ手順（固定刻み＋ nextFireTime による分割、境界での tryFire）でトリガー押下を模擬する。
 * frameDt は 1/120 の整数倍でない値も使い、分割が必要になるようにする。
 */
function runHeld(rig: Rig, seconds: number, frameDt: number, input: InputFrame = { ...emptyInput(), fireDown: true }): { shots: ShotRecord[]; time: number } {
  const shots: ShotRecord[] = [];
  let time = 0;
  const player = asPlayer(rig.player);
  const due = (): void => {
    if (input.fireDown && rig.player.alive) {
      const w = rig.player.weapon;
      if (time + 1e-9 >= rig.weapons.nextFireAt[w]) {
        const rec = rig.weapons.tryFire(rig.ctx(time));
        if (rec) shots.push(rec);
      }
    }
  };
  const frames = Math.round(seconds / frameDt);
  for (let f = 0; f < frames; f++) {
    let remaining = frameDt;
    let guard = 0;
    while (remaining > 1e-9 && guard++ < 10000) {
      due();
      let h = Math.min(remaining, H);
      const next = rig.weapons.nextFireTime(player, input, time);
      if (next !== null && next > time + 1e-9 && next < time + h) h = next - time;
      time += h;
      remaining -= h;
    }
    due();
  }
  return { shots, time };
}

describe('Weapons: nextFireTime', () => {
  it('押下中は max(time, nextFireAt)、非押下・死亡・確実に不成立なら null', () => {
    const rig = makeRig();
    const player = asPlayer(rig.player);
    const held: InputFrame = { ...emptyInput(), fireDown: true };
    expect(rig.weapons.nextFireTime(player, emptyInput(), 0)).toBeNull();
    expect(rig.weapons.nextFireTime(player, held, 0)).toBe(0);
    rig.weapons.nextFireAt.machinegun = 0.1;
    expect(rig.weapons.nextFireTime(player, held, 0.05)).toBe(0.1);
    expect(rig.weapons.nextFireTime(player, held, 0.2)).toBe(0.2);
    rig.player.alive = false;
    expect(rig.weapons.nextFireTime(player, held, 0.2)).toBeNull();
    rig.player.alive = true;
    rig.player.ammo.machinegun = 0;
    expect(rig.weapons.nextFireTime(player, held, 0.2)).toBeNull();
    rig.player.weapon = 'beam';
    rig.player.en = WEAPONS.beam.enCost - 0.001;
    expect(rig.weapons.nextFireTime(player, held, 0.2)).toBeNull();
    rig.player.en = WEAPONS.beam.enCost;
    expect(rig.weapons.nextFireTime(player, held, 0.2)).toBe(0.2);
    rig.player.weapon = 'missile';
    rig.player.ammo.missile = 0;
    expect(rig.weapons.nextFireTime(player, held, 0.2)).toBeNull();
    rig.player.ammo.missile = 1;
    rig.weapons.nextFireAt.missile = 1.5;
    expect(rig.weapons.nextFireTime(player, held, 0.2)).toBe(1.5);
  });
});

describe('Weapons: マシンガン', () => {
  it('押下中は 0.1 s ごとに発射し（1 s で 10 発、分割込み）、1 発ごとに弾を 1 消費する', () => {
    const rig = makeRig();
    // 1/120 の整数倍でないフレーム長で分割を必要にする
    const { shots } = runHeld(rig, 1.0, 0.0173);
    const within = shots.filter((s) => s.firedAtSeconds < 1.0 - 1e-9);
    expect(within).toHaveLength(10);
    for (let i = 0; i < 10; i++) {
      expect(Math.abs(within[i].firedAtSeconds - i * MG.interval)).toBeLessThan(1e-9);
      expect(within[i].id).toBe(i + 1);
      expect(within[i].weapon).toBe('machinegun');
    }
    expect(rig.player.ammo.machinegun).toBe(MG.ammo - shots.length);
    expect(rig.projectiles.mgBullets).toHaveLength(shots.length);
    expect(rig.events.filter((e) => e.type === 'mgFire')).toHaveLength(shots.length);
    expect(rig.player.en).toBe(120); // EN は消費しない
  });

  it('1/60 固定フレームでも 1 s で 10 発（描画頻度非依存）', () => {
    const a = runHeld(makeRig(), 1.0, 1 / 60).shots.filter((s) => s.firedAtSeconds < 1 - 1e-9);
    const b = runHeld(makeRig(), 1.0, 1 / 30).shots.filter((s) => s.firedAtSeconds < 1 - 1e-9);
    const c = runHeld(makeRig(), 1.0, 1 / 120).shots.filter((s) => s.firedAtSeconds < 1 - 1e-9);
    expect(a).toHaveLength(10);
    expect(b).toHaveLength(10);
    expect(c).toHaveLength(10);
    for (let i = 0; i < 10; i++) {
      expect(Math.abs(a[i].firedAtSeconds - b[i].firedAtSeconds)).toBeLessThan(1e-9);
      expect(Math.abs(a[i].firedAtSeconds - c[i].firedAtSeconds)).toBeLessThan(1e-9);
    }
  });

  it('弾 0 は noAmmo で拒否（nextFireAt 不変、弾体なし、fireDenied は 0.5 s に 1 回）', () => {
    const rig = makeRig({ player: { ammo: { machinegun: 0, missile: 12 } } });
    rig.weapons.nextFireAt.machinegun = 0.3;
    expect(rig.weapons.tryFire(rig.ctx(0.5))).toBeNull();
    expect(rig.weapons.lastDenial).toEqual({ weapon: 'machinegun', reason: 'noAmmo', time: 0.5 });
    expect(rig.weapons.nextFireAt.machinegun).toBe(0.3);
    expect(rig.projectiles.mgBullets).toHaveLength(0);
    expect(rig.player.ammo.machinegun).toBe(0);
    expect(rig.events.filter((e) => e.type === 'fireDenied')).toHaveLength(1);
    expect(rig.weapons.tryFire(rig.ctx(0.6))).toBeNull();
    expect(rig.weapons.tryFire(rig.ctx(0.99))).toBeNull();
    expect(rig.events.filter((e) => e.type === 'fireDenied')).toHaveLength(1);
    expect(rig.weapons.lastDenial?.time).toBe(0.99);
    expect(rig.weapons.tryFire(rig.ctx(1.0))).toBeNull();
    const denied = rig.events.filter((e) => e.type === 'fireDenied');
    expect(denied).toHaveLength(2);
    expect(denied[1]).toEqual({ type: 'fireDenied', weapon: 'machinegun', reason: 'noAmmo' });
    // 押下を続けても発射時刻分割の対象にならない
    expect(rig.weapons.nextFireTime(asPlayer(rig.player), { ...emptyInput(), fireDown: true }, 1.0)).toBeNull();
  });

  it('最後の 1 発は撃てる', () => {
    const rig = makeRig({ player: { ammo: { machinegun: 1, missile: 12 } } });
    expect(rig.weapons.tryFire(rig.ctx(0))).not.toBeNull();
    expect(rig.player.ammo.machinegun).toBe(0);
    expect(rig.weapons.tryFire(rig.ctx(0.1))).toBeNull();
    expect(rig.weapons.lastDenial?.reason).toBe('noAmmo');
  });

  it('ロック完了＋解あり: ShotRecord は solved、v0 = 100·d、加速度 (0,-18,0)、対象の位置・速度を記録', () => {
    const t = target('e', [0, 20, 100], [8, 0, 0]);
    const rig = makeRig({ targets: [t] });
    lockOn(rig);
    const rec = rig.weapons.tryFire(rig.ctx(1.234))!;
    expect(rec).not.toBeNull();
    expect(rec.id).toBe(1);
    expect(rec.firedAtSeconds).toBe(1.234);
    expect(rec.weapon).toBe('machinegun');
    expect(rec.targetId).toBe('e');
    expect(rec.solutionStatus).toBe('solved');
    expect(rec.muzzlePosition).toEqual(MUZZLE);
    expect(rec.targetPositionAtFire).toEqual([0, 20, 100]);
    expect(rec.targetVelocityAtFire).toEqual([8, 0, 0]);
    expect(rec.accelerationAtFire).toEqual([0, -18, 0]);
    expect(rec.accelerationAtFire).toEqual(MG.gravity);
    const ref = solveMachinegunLead(sub(t.center, MUZZLE), t.velocity, MG.speed, MG.gravity, MG.solveMaxTime)!;
    expect(rec.launchDirection).toEqual(ref.direction);
    expect(rec.initialVelocity).toEqual(scale(rec.launchDirection, MG.speed));
    expect(Math.abs(length(rec.initialVelocity!) - MG.speed)).toBeLessThan(0.001);
    expect(rec.initialVelocity![1]).toBeCloseTo(9.066521121, 6);
    expect(rec.predictedFlightSeconds).toBeCloseTo(1.007391236, 6);
    expect(rec.predictedInterceptPosition![0]).toBeCloseTo(8 * rec.predictedFlightSeconds!, 12);
    // 弾体には同じ v0 が設定されている（自機速度を加算しない）
    expect(rig.projectiles.mgBullets).toHaveLength(1);
    expect(rig.projectiles.mgBullets[0].v0).toEqual(rec.initialVelocity);
    expect(rig.projectiles.mgBullets[0].origin).toEqual(MUZZLE);
    expect(rig.projectiles.mgBullets[0].firedAt).toBe(1.234);
    expect(rig.weapons.nextFireAt.machinegun).toBeCloseTo(1.234 + MG.interval, 12);
    const ev = rig.events.find((e) => e.type === 'mgFire');
    expect(ev).toBeDefined();
    if (ev && ev.type === 'mgFire') {
      expect(ev.muzzle).toEqual(MUZZLE);
      expect(ev.direction).toEqual(rec.launchDirection);
    }
    // レコードは発射瞬間のコピー: 対象を動かしても変わらない
    t.center[0] = 999;
    expect(rec.targetPositionAtFire![0]).toBe(0);
  });

  it('未ロック: 自由射撃（inactive、対象・予測値は null、方向は照準点−銃口）', () => {
    const rig = makeRig({ targets: [target('e', [0, 20, 100])] });
    rig.freeAimPoint = [30, 25, 90];
    expect(rig.fcs.state).toBe('none');
    const rec = rig.weapons.tryFire(rig.ctx(0))!;
    expect(rec.solutionStatus).toBe('inactive');
    expect(rec.targetId).toBeNull();
    expect(rec.targetPositionAtFire).toBeNull();
    expect(rec.targetVelocityAtFire).toBeNull();
    expect(rec.predictedFlightSeconds).toBeNull();
    expect(rec.predictedInterceptPosition).toBeNull();
    expect(rec.launchDirection).toEqual(normalize(sub([30, 25, 90], MUZZLE)));
    expect(rec.initialVelocity).toEqual(scale(rec.launchDirection, MG.speed));
    expect(rec.accelerationAtFire).toEqual([0, -18, 0]);
  });

  it('ロック取得中（未完了）も自由射撃', () => {
    const rig = makeRig({ targets: [target('e', [0, 20, 100])] });
    rig.camera.lookAt([0, 20, 100]);
    for (let i = 0; i < 10; i++) rig.fcs.update(H, { time: 0, camera: rig.camera, muzzle: MUZZLE, targets: rig.targets, world: rig.world });
    expect(rig.fcs.state).toBe('acquiring');
    const rec = rig.weapons.tryFire(rig.ctx(0))!;
    expect(rec.solutionStatus).toBe('inactive');
    expect(rec.targetId).toBeNull();
  });

  it('ロック完了＋解なし: 現在位置へ直接照準して発射し、弾を消費する（no_solution）', () => {
    // 100 m 先を 60 m/s で遠ざかる対象: 2 s 以内に追いつけない
    const t = target('e', [0, 20, 100], [0, 0, 60]);
    expect(solveMachinegunLead(sub(t.center, MUZZLE), t.velocity, MG.speed, MG.gravity, MG.solveMaxTime)).toBeNull();
    const rig = makeRig({ targets: [t] });
    lockOn(rig);
    const rec = rig.weapons.tryFire(rig.ctx(0))!;
    expect(rec).not.toBeNull();
    expect(rec.solutionStatus).toBe('no_solution');
    expect(rec.targetId).toBe('e');
    expect(rec.targetPositionAtFire).toEqual([0, 20, 100]);
    expect(rec.launchDirection).toEqual(normalize(sub(t.center, MUZZLE)));
    expect(rec.initialVelocity).toEqual(scale(rec.launchDirection, MG.speed));
    expect(rec.predictedFlightSeconds).toBeNull();
    expect(rec.predictedInterceptPosition).toBeNull();
    expect(rig.player.ammo.machinegun).toBe(MG.ammo - 1);
    expect(rig.fcs.state).toBe('locked'); // ロックは保持
  });

  it('発射時にロックを再検証する: 対象が円外へ出ていれば自由射撃になる', () => {
    const t = target('e', [0, 20, 100]);
    const rig = makeRig({ targets: [t] });
    lockOn(rig);
    // 対象が横へ大きく移動（円外）。fcs.update は呼ばれていないので state はまだ locked
    t.center[0] = 60;
    expect(rig.fcs.state).toBe('locked');
    const rec = rig.weapons.tryFire(rig.ctx(0))!;
    expect(rig.fcs.state).toBe('none');
    expect(rec.solutionStatus).toBe('inactive');
    expect(rec.targetId).toBeNull();
  });

  it('死亡中は発射しない', () => {
    const rig = makeRig({ player: { alive: false } });
    expect(rig.weapons.tryFire(rig.ctx(0))).toBeNull();
    expect(rig.player.ammo.machinegun).toBe(MG.ammo);
  });
});

describe('Weapons: ビーム', () => {
  it('spendEn で 8 EN を消費し、ロック対象の現在位置へ即時命中（initialVelocity null、加速度 0）', () => {
    const t = target('e', [0, 20, 100], [8, 0, 0]);
    const rig = makeRig({ targets: [t], player: { weapon: 'beam' } });
    lockOn(rig);
    const rec = rig.weapons.tryFire(rig.ctx(0.4))!;
    expect(rec).not.toBeNull();
    expect(rig.player.en).toBe(120 - WEAPONS.beam.enCost);
    expect(rig.player.lastEnSpentAt).toBe(0.4);
    expect(rec.weapon).toBe('beam');
    expect(rec.solutionStatus).toBe('solved');
    expect(rec.targetId).toBe('e');
    expect(rec.launchDirection).toEqual(normalize(sub(t.center, MUZZLE)));
    expect(rec.initialVelocity).toBeNull();
    expect(rec.accelerationAtFire).toEqual([0, 0, 0]);
    expect(rec.predictedFlightSeconds).toBe(0);
    expect(rec.predictedInterceptPosition).toEqual([0, 20, 100]);
    expect(rec.targetVelocityAtFire).toEqual([8, 0, 0]);
    expect(rig.weapons.nextFireAt.beam).toBeCloseTo(0.4 + WEAPONS.beam.interval, 12);
    // 現在位置に命中し 40 ダメージ
    expect(rig.damage).toHaveLength(1);
    expect(rig.damage[0]).toMatchObject({ id: 'e', amount: WEAPONS.beam.damage, weapon: 'beam' });
    expect(rig.damage[0].point[2]).toBeCloseTo(100 - 0.5, 6);
    const ev = rig.events.find((e) => e.type === 'beamFire');
    expect(ev).toBeDefined();
    if (ev && ev.type === 'beamFire') {
      expect(ev.from).toEqual(MUZZLE);
      expect(ev.hitEnemyId).toBe('e');
      expect(ev.to[2]).toBeCloseTo(99.5, 6);
    }
    expect(rig.projectiles.mgBullets).toHaveLength(0);
    expect(rig.projectiles.missiles).toHaveLength(0);
  });

  it('EN 8 未満は noEn で拒否（EN・nextFireAt 不変）。ちょうど 8 なら発射', () => {
    const rig = makeRig({ player: { weapon: 'beam', en: 7.999 } });
    rig.weapons.nextFireAt.beam = 0.25;
    expect(rig.weapons.tryFire(rig.ctx(0.5))).toBeNull();
    expect(rig.weapons.lastDenial).toEqual({ weapon: 'beam', reason: 'noEn', time: 0.5 });
    expect(rig.player.en).toBe(7.999);
    expect(rig.player.lastEnSpentAt).toBeNull();
    expect(rig.weapons.nextFireAt.beam).toBe(0.25);
    expect(rig.events.filter((e) => e.type === 'fireDenied')).toHaveLength(1);
    expect(rig.damage).toHaveLength(0);
    rig.player.en = WEAPONS.beam.enCost;
    const rec = rig.weapons.tryFire(rig.ctx(0.6));
    expect(rec).not.toBeNull();
    expect(rig.player.en).toBe(0);
    expect(rec!.solutionStatus).toBe('inactive'); // 未ロックの自由射撃
    expect(rec!.targetId).toBeNull();
  });

  it('自由射撃のビームは壁で止まり、その先の敵にダメージを与えない', () => {
    const world = createCollisionWorld();
    world.addCollider({ min: [-50, 0, 40], max: [50, 40, 41] }, 'wall');
    const rig = makeRig({ world, targets: [target('e', [0, 20, 100])], player: { weapon: 'beam' } });
    const rec = rig.weapons.tryFire(rig.ctx(0))!;
    expect(rec).not.toBeNull();
    expect(rig.damage).toHaveLength(0);
    const ev = rig.events.find((e) => e.type === 'beamFire');
    if (ev && ev.type === 'beamFire') {
      expect(ev.hitEnemyId).toBeNull();
      expect(ev.to[2]).toBeCloseTo(40, 6);
    }
  });

  it('押下中は 0.25 s ごとに発射し、EN が尽きると拒否する', () => {
    const rig = makeRig({ player: { weapon: 'beam', en: 20 } });
    const { shots } = runHeld(rig, 1.0, 0.0173);
    // 20 EN → 2 発（0, 0.25）。以降は noEn
    expect(shots).toHaveLength(2);
    expect(shots[0].firedAtSeconds).toBe(0);
    expect(Math.abs(shots[1].firedAtSeconds - WEAPONS.beam.interval)).toBeLessThan(1e-9);
    expect(rig.player.en).toBe(4);
    expect(rig.weapons.lastDenial?.reason).toBe('noEn');
  });
});

describe('Weapons: ミサイル', () => {
  it('未ロックは noLock で拒否（弾を消費せず、弾体も ShotRecord も生成しない）', () => {
    const rig = makeRig({ targets: [target('e', [0, 20, 100])], player: { weapon: 'missile' } });
    expect(rig.fcs.state).toBe('none');
    expect(rig.weapons.tryFire(rig.ctx(0))).toBeNull();
    expect(rig.weapons.lastDenial).toEqual({ weapon: 'missile', reason: 'noLock', time: 0 });
    expect(rig.player.ammo.missile).toBe(WEAPONS.missile.ammo);
    expect(rig.projectiles.missiles).toHaveLength(0);
    expect(rig.weapons.nextFireAt.missile).toBe(0);
    expect(rig.events.filter((e) => e.type === 'fireDenied')).toHaveLength(1);
    // 取得中も拒否
    rig.camera.lookAt([0, 20, 100]);
    for (let i = 0; i < 10; i++) rig.fcs.update(H, { time: 0, camera: rig.camera, muzzle: MUZZLE, targets: rig.targets, world: rig.world });
    expect(rig.fcs.state).toBe('acquiring');
    expect(rig.weapons.tryFire(rig.ctx(0.1))).toBeNull();
    expect(rig.weapons.lastDenial?.reason).toBe('noLock');
    expect(rig.player.ammo.missile).toBe(WEAPONS.missile.ammo);
  });

  it('ロック完了なら偏差方向へ発射（v0 = 45·d、加速度 0、予測時刻は等速解）', () => {
    const t = target('e', [0, 20, 100], [8, 0, 0]);
    const rig = makeRig({ targets: [t], player: { weapon: 'missile' } });
    lockOn(rig);
    const rec = rig.weapons.tryFire(rig.ctx(2))!;
    expect(rec).not.toBeNull();
    expect(rec.weapon).toBe('missile');
    expect(rec.targetId).toBe('e');
    expect(rec.solutionStatus).toBe('solved');
    const ref = solveLinearLead(sub(t.center, MUZZLE), t.velocity, WEAPONS.missile.speed, WEAPONS.missile.solveMaxTime)!;
    expect(rec.launchDirection).toEqual(ref.direction);
    expect(rec.initialVelocity).toEqual(scale(ref.direction, WEAPONS.missile.speed));
    expect(rec.accelerationAtFire).toEqual([0, 0, 0]);
    expect(rec.predictedFlightSeconds).toBe(ref.t);
    expect(rec.targetPositionAtFire).toEqual([0, 20, 100]);
    expect(rec.targetVelocityAtFire).toEqual([8, 0, 0]);
    expect(rig.player.ammo.missile).toBe(WEAPONS.missile.ammo - 1);
    expect(rig.projectiles.missiles).toHaveLength(1);
    expect(rig.projectiles.missiles[0].targetId).toBe('e');
    expect(rig.projectiles.missiles[0].dir).toEqual(ref.direction);
    expect(rig.projectiles.missiles[0].firedAt).toBe(2);
    expect(rig.weapons.nextFireAt.missile).toBeCloseTo(2 + WEAPONS.missile.interval, 12);
    const ev = rig.events.find((e) => e.type === 'missileFire');
    expect(ev).toBeDefined();
    if (ev && ev.type === 'missileFire') expect(ev.direction).toEqual(ref.direction);
  });

  it('偏差解がなくても現在位置方向へ発射する（no_solution、予測は null）', () => {
    const t = target('e', [0, 20, 100], [0, 0, 50]);
    const rig = makeRig({ targets: [t], player: { weapon: 'missile' } });
    lockOn(rig);
    const rec = rig.weapons.tryFire(rig.ctx(0))!;
    expect(rec).not.toBeNull();
    expect(rec.solutionStatus).toBe('no_solution');
    expect(rec.launchDirection).toEqual(normalize(sub(t.center, MUZZLE)));
    expect(rec.predictedFlightSeconds).toBeNull();
    expect(rec.predictedInterceptPosition).toBeNull();
    expect(rig.player.ammo.missile).toBe(WEAPONS.missile.ammo - 1);
  });

  it('弾 0 は noAmmo（ロック完了でも）', () => {
    const rig = makeRig({ targets: [target('e', [0, 20, 100])], player: { weapon: 'missile', ammo: { machinegun: 300, missile: 0 } } });
    lockOn(rig);
    expect(rig.weapons.tryFire(rig.ctx(0))).toBeNull();
    expect(rig.weapons.lastDenial?.reason).toBe('noAmmo');
    expect(rig.projectiles.missiles).toHaveLength(0);
  });
});

describe('Weapons: 武器切り替えと reset', () => {
  it('武器切り替えで nextFireAt はリセットされない', () => {
    const rig = makeRig();
    expect(rig.weapons.tryFire(rig.ctx(0))).not.toBeNull();
    expect(rig.weapons.nextFireAt.machinegun).toBeCloseTo(0.1, 12);
    rig.player.weapon = 'beam';
    expect(rig.weapons.tryFire(rig.ctx(0.01))).not.toBeNull();
    expect(rig.weapons.nextFireAt.beam).toBeCloseTo(0.26, 12);
    rig.player.weapon = 'machinegun';
    expect(rig.weapons.nextFireAt.machinegun).toBeCloseTo(0.1, 12);
    const held: InputFrame = { ...emptyInput(), fireDown: true };
    expect(rig.weapons.nextFireTime(asPlayer(rig.player), held, 0.05)).toBeCloseTo(0.1, 12);
    // 切り替え直後の 0.05 s には撃てない（Game は nextFireAt を見て tryFire を呼ばない）
    expect(0.05 + 1e-9 >= rig.weapons.nextFireAt.machinegun).toBe(false);
    rig.player.weapon = 'beam';
    expect(rig.weapons.nextFireTime(asPlayer(rig.player), held, 0.05)).toBeCloseTo(0.26, 12);
  });

  it('reset で nextFireAt と lastDenial を初期化', () => {
    const rig = makeRig({ player: { ammo: { machinegun: 0, missile: 12 } } });
    rig.weapons.tryFire(rig.ctx(0));
    expect(rig.weapons.lastDenial).not.toBeNull();
    rig.weapons.nextFireAt.beam = 5;
    rig.weapons.reset();
    expect(rig.weapons.nextFireAt).toEqual({ machinegun: 0, beam: 0, missile: 0 });
    expect(rig.weapons.lastDenial).toBeNull();
    // reset 後は拒否イベントの間隔もリセットされる（同時刻でも再度発行）
    rig.events.length = 0;
    rig.weapons.tryFire(rig.ctx(0));
    expect(rig.events.filter((e) => e.type === 'fireDenied')).toHaveLength(1);
  });
});

describe('Weapons: 回帰（レビュー指摘）', () => {
  it('ビームの nextFireTime は Player.spendEn と同じ許容値（1e-9）で判定し、tryFire の可否と一致する', () => {
    const rig = makeRig();
    const real = new Player(DEFAULT_LOADOUT);
    real.reset([0.95, 17.95, 0.9], Math.PI);
    real.weapon = 'beam';
    const held: InputFrame = { ...emptyInput(), fireDown: true };
    const ctxAt = (t: number): FireContext => ({ ...rig.ctx(t), player: real });

    // EN が 8 − 1e-10（回復の浮動小数点演算で起こり得る）: 発射時刻の分割対象になり、発射も成立する
    rig.weapons.nextFireAt.beam = 0.25;
    real.en = WEAPONS.beam.enCost - 1e-10;
    expect(rig.weapons.nextFireTime(real, held, 0.245)).toBeCloseTo(0.25, 12);
    expect(rig.weapons.tryFire(ctxAt(0.25))).not.toBeNull();
    expect(real.en).toBeCloseTo(0, 6);

    // 許容値を超えて不足なら、分割もされず発射も拒否される
    rig.weapons.nextFireAt.beam = 0.5;
    real.en = WEAPONS.beam.enCost - 1e-6;
    expect(rig.weapons.nextFireTime(real, held, 0.495)).toBeNull();
    expect(rig.weapons.tryFire(ctxAt(0.5))).toBeNull();
    expect(rig.weapons.lastDenial).toEqual({ weapon: 'beam', reason: 'noEn', time: 0.5 });
    expect(real.en).toBe(WEAPONS.beam.enCost - 1e-6);
  });

  it('fireDenied は武器か理由が直前のイベントと異なれば即座に発行し、同じ武器・理由の連続だけ 0.5 s に 1 回', () => {
    const rig = makeRig({ targets: [target('e', [0, 20, 100])], player: { ammo: { machinegun: 0, missile: 0 }, en: 0 } });
    lockOn(rig);
    const denied = (): string[] =>
      rig.events.filter((e) => e.type === 'fireDenied').map((e) => (e.type === 'fireDenied' ? `${e.weapon}:${e.reason}` : ''));
    rig.weapons.tryFire(rig.ctx(0)); // machinegun noAmmo → 発行
    rig.player.weapon = 'missile';
    rig.weapons.tryFire(rig.ctx(0.2)); // missile noAmmo（武器が違う）→ 0.5 s 未満でも発行
    expect(denied()).toEqual(['machinegun:noAmmo', 'missile:noAmmo']);
    rig.weapons.tryFire(rig.ctx(0.3)); // 同じ missile noAmmo → 発行しない
    expect(denied()).toHaveLength(2);
    rig.player.weapon = 'machinegun';
    rig.weapons.tryFire(rig.ctx(0.4)); // machinegun noAmmo（直前は missile）→ 発行
    rig.player.weapon = 'beam';
    rig.weapons.tryFire(rig.ctx(0.45)); // beam noEn（理由が違う）→ 発行
    rig.weapons.tryFire(rig.ctx(0.9)); // 同じ beam noEn、0.45 s → 発行しない
    rig.weapons.tryFire(rig.ctx(0.95)); // 0.5 s 経過 → 発行
    expect(denied()).toEqual(['machinegun:noAmmo', 'missile:noAmmo', 'machinegun:noAmmo', 'beam:noEn', 'beam:noEn']);
    expect(rig.weapons.lastDenial).toEqual({ weapon: 'beam', reason: 'noEn', time: 0.95 });
    // 拒否は弾・EN・nextFireAt を変えない
    expect(rig.player.ammo).toEqual({ machinegun: 0, missile: 0 });
    expect(rig.player.en).toBe(0);
    expect(rig.weapons.nextFireAt).toEqual({ machinegun: 0, beam: 0, missile: 0 });
  });
});
