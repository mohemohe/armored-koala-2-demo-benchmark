/**
 * プレイヤー移動・EN 管理の試験（仕様 §6, §7, §11 の移動関連行）。
 * Game.advance と同じ手順（最大刻み 1/120、nextEventTime で分割、フレーム先頭でエッジ入力）で
 * Player を直接駆動する。床は y=0 を上面とする大きな AABB 1 枚。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_LOADOUT, GENERATORS, LEGS, PLAYER, SIM, WEAPONS, computeEffectiveStats } from '../src/params';
import { CONTACT_MARGIN, createCollisionWorld } from '../src/sim/collision';
import { Player } from '../src/sim/player';
import { forwardFromYaw, rightFromYaw } from '../src/sim/vec';
import type { AABB, CollisionWorld, InputFrame, Loadout, SimEvent, Vec3 } from '../src/types';
import { emptyInput } from '../src/types';

const FLOOR: AABB = { min: [-500, -2, -500], max: [500, 0, 500] };

function makeWorld(extra: AABB[] = []): CollisionWorld {
  const w = createCollisionWorld();
  w.addCollider(FLOOR, 'floor');
  for (const b of extra) w.addCollider(b, 'wall');
  return w;
}

/** Game.advance を模した駆動ハーネス */
class Sim {
  readonly p: Player;
  readonly world: CollisionWorld;
  time = 0;
  events: SimEvent[] = [];
  yaw = 0;
  /** 押下状態（フレームをまたいで保持する入力） */
  held: Partial<InputFrame> = {};

  constructor(loadout: Loadout = DEFAULT_LOADOUT, world: CollisionWorld = makeWorld(), spawn: Vec3 = [0, 0, 0]) {
    this.p = new Player(loadout);
    this.world = world;
    this.p.reset(spawn, 0);
  }

  /** 1 描画フレーム。edges はこのフレームだけの押下エッジ。between はエッジ処理後・積分前に呼ぶ（ビーム消費の模擬） */
  frame(dt: number, edges: Partial<InputFrame> = {}, between?: (time: number) => void): void {
    const input: InputFrame = { ...emptyInput(), ...this.held, ...edges };
    this.p.applyEdgeInput(input, this.yaw, this.time, this.events);
    if (between) between(this.time);
    const stepInput: InputFrame = { ...input, qbPressed: false, shiftPressed: false, spacePressed: false, weaponSelect: null };
    let remaining = dt;
    let guard = 0;
    while (remaining > 1e-9 && guard++ < 100000) {
      let h = Math.min(remaining, SIM.maxStep);
      const next = this.p.nextEventTime(this.time, stepInput);
      if (next !== null && next > this.time + 1e-9 && next < this.time + h) h = next - this.time;
      this.p.integrate(h, this.time, stepInput, this.yaw, this.world, this.events);
      this.time += h;
      remaining -= h;
    }
  }

  /** 時刻 t まで frameDt のフレームで進める（最後のフレームは端数） */
  advanceTo(t: number, frameDt = 1 / 120): void {
    let guard = 0;
    while (this.time < t - 1e-9 && guard++ < 1000000) {
      this.frame(Math.min(frameDt, t - this.time));
    }
  }

  speed(): number {
    return Math.hypot(this.p.vel[0], this.p.vel[2]);
  }

  drain(): SimEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }
}

const distXZ = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[2] - b[2]);
const QUAD: Loadout = { ...DEFAULT_LOADOUT, legs: 'quadruped' };
const MAX_EN = GENERATORS.balanced.maxEn;
const REGEN = GENERATORS.balanced.regen;
const QB_COST = PLAYER.qb.cost;

describe('player movement (§6, §7)', () => {
  it('1. single press: Q held for 5 s yields exactly 1 QB, EN −36 once, regen from t=0.75', () => {
    const sim = new Sim();
    sim.frame(1 / 120, { qbPressed: true });
    expect(sim.p.qbSuccessfulCount).toBe(1);
    expect(sim.p.en).toBeCloseTo(MAX_EN - QB_COST, 9);
    expect(sim.p.lastEnSpentAt).toBe(0);
    expect(sim.drain().some((e) => e.type === 'qbStart')).toBe(true);
    // 以後 Q は押しっぱなし（入力層はエッジを再発行しない → qbPressed=false）
    sim.advanceTo(0.75);
    const enAt075 = sim.p.en;
    expect(enAt075).toBeCloseTo(MAX_EN - QB_COST, 9);
    sim.advanceTo(1.0);
    const enAt1 = sim.p.en;
    expect(enAt1).toBeCloseTo(MAX_EN - QB_COST + 0.25 * REGEN, 6);
    sim.advanceTo(5.0);
    expect(sim.p.qbSuccessfulCount).toBe(1);
    console.log(`[1] EN after press=${MAX_EN - QB_COST}, EN@0.75=${enAt075}, EN@1.0=${enAt1}, EN@5=${sim.p.en}`);
  });

  it('2. input release: impulse → glide 80 m/s at 0.15, 22 m/s at 0.75, still 22 at 5 s in the QB direction', () => {
    const sim = new Sim();
    sim.frame(1 / 120, { qbPressed: true });
    expect(sim.p.horizontalMode).toBe('quickboost');
    expect(sim.speed()).toBeCloseTo(PLAYER.qb.speed, 9);
    sim.advanceTo(0.15);
    expect(sim.p.horizontalMode).toBe('glide');
    expect(sim.p.glideEnabled).toBe(true);
    expect(sim.speed()).toBeCloseTo(PLAYER.qb.speed, 9);
    expect(sim.p.qbImpulseRemaining).toBe(0);
    sim.advanceTo(0.75);
    expect(Math.abs(sim.speed() - PLAYER.glideGroundSpeed)).toBeLessThan(1e-6);
    expect(sim.p.horizontalMode).toBe('glide');
    // QB 方向（カメラ前方 -Z）へ移動し続けている
    expect(sim.p.vel[2]).toBeLessThan(0);
    expect(Math.abs(sim.p.vel[0])).toBeLessThan(1e-9);
    expect(sim.p.desiredDir[0]).toBeCloseTo(0, 9);
    expect(sim.p.desiredDir[1]).toBeCloseTo(-1, 9);
    sim.advanceTo(5.0);
    expect(Math.abs(sim.speed() - PLAYER.glideGroundSpeed)).toBeLessThan(1e-6);
    expect(sim.p.horizontalMode).toBe('glide');
    console.log(`[2] speed@0.15=80 speed@0.75=${sim.speed()} pos@5=${sim.p.pos.map((v) => v.toFixed(3)).join(',')}`);
  });

  it('3. distance over [0, 0.75]: biped ≈ 42.6 m, quadruped ≈ 34.08 m, steady glide 16.5 m; frame-size independent', () => {
    /** フレーム列 dts を循環させて t まで進める（最後は端数）。距離は 0.75 s、EN は 1.0 s で測る */
    const runSeq = (loadout: Loadout, dts: number[]): { dist: number; en: number } => {
      const sim = new Sim(loadout);
      const start: Vec3 = [...sim.p.pos];
      let i = 0;
      const nextDt = (): number => dts[i++ % dts.length];
      sim.frame(Math.min(nextDt(), 0.75), { qbPressed: true });
      while (sim.time < 0.75 - 1e-9) sim.frame(Math.min(nextDt(), 0.75 - sim.time));
      expect(Math.abs(sim.time - 0.75)).toBeLessThan(1e-9);
      const dist = distXZ(sim.p.pos, start);
      while (sim.time < 1.0 - 1e-9) sim.frame(Math.min(nextDt(), 1.0 - sim.time));
      expect(Math.abs(sim.time - 1.0)).toBeLessThan(1e-9);
      return { dist, en: sim.p.en };
    };
    const run = (loadout: Loadout, frameDt: number): number => runSeq(loadout, [frameDt]).dist;
    const biped = run(DEFAULT_LOADOUT, 1 / 120);
    const quad = run(QUAD, 1 / 120);
    expect(Math.abs(biped - 42.6)).toBeLessThan(0.05);
    expect(Math.abs(quad - 34.08)).toBeLessThan(0.05);

    // 定常グライド 0.75 s
    const glide = new Sim();
    glide.p.vel = [0, 0, -PLAYER.glideGroundSpeed];
    const g0: Vec3 = [...glide.p.pos];
    glide.frame(1 / 120, { shiftPressed: true });
    glide.advanceTo(0.75);
    const glideDist = distXZ(glide.p.pos, g0);
    expect(Math.abs(glideDist - 16.5)).toBeLessThan(1e-6);

    // フレームサイズ非依存: 1/120 の整数倍だけでなく、端数の出る不規則な幅と揺らぎのある列でも
    // 距離（0.75 s）と EN（1.0 s: 84 + 0.25×15）が一致すること
    const ref = runSeq(DEFAULT_LOADOUT, [1 / 120]);
    const refQuad = runSeq(QUAD, [1 / 120]);
    expect(ref.en).toBeCloseTo(MAX_EN - QB_COST + 0.25 * REGEN, 9);
    const d30 = run(DEFAULT_LOADOUT, 1 / 30);
    const d60 = run(DEFAULT_LOADOUT, 1 / 60);
    const d120 = biped;
    expect(Math.abs(d30 - d120)).toBeLessThan(1e-6);
    expect(Math.abs(d60 - d120)).toBeLessThan(1e-6);
    const irregular: number[][] = [[0.0137], [0.0071], [1 / 47], [1 / 33], [0.0137, 0.0071, 0.0211, 1 / 47, 1 / 33, 0.004, 0.019]];
    for (const dts of irregular) {
      const r = runSeq(DEFAULT_LOADOUT, dts);
      expect(Math.abs(r.dist - ref.dist)).toBeLessThan(1e-9);
      expect(Math.abs(r.en - ref.en)).toBeLessThan(1e-9);
      const q = runSeq(QUAD, dts);
      expect(Math.abs(q.dist - refQuad.dist)).toBeLessThan(1e-9);
      expect(Math.abs(q.en - refQuad.en)).toBeLessThan(1e-9);
    }
    const q30 = run(QUAD, 1 / 30);
    expect(Math.abs(q30 - quad)).toBeLessThan(1e-6);
    console.log(`[3] biped=${biped} quad=${quad} glide=${glideDist} d30=${d30} d60=${d60} d120=${d120} en@1.0=${ref.en} jitter=${runSeq(DEFAULT_LOADOUT, irregular[4]).dist}`);
  });

  it('4. glide costs 0 EN: works at EN 0, regen continues while gliding on the ground', () => {
    // lastEnSpentAt が null なら即座に回復
    const a = new Sim();
    a.p.en = 0;
    a.frame(1 / 120, { shiftPressed: true });
    expect(a.p.glideEnabled).toBe(true);
    a.advanceTo(1.0);
    expect(Math.abs(a.speed() - PLAYER.glideGroundSpeed)).toBeLessThan(1e-6);
    expect(a.p.horizontalMode).toBe('glide');
    expect(a.p.en).toBeCloseTo(REGEN * 1.0, 6);
    a.advanceTo(5.0);
    expect(Math.abs(a.speed() - PLAYER.glideGroundSpeed)).toBeLessThan(1e-6);
    expect(a.p.en).toBeCloseTo(Math.min(MAX_EN, REGEN * 5), 6);
    const enA5 = a.p.en;

    // 最後の消費が t=0 なら 0.75 秒後から回復
    const b = new Sim();
    expect(b.p.spendEn(MAX_EN, 0)).toBe(true);
    expect(b.p.en).toBe(0);
    b.frame(1 / 120, { shiftPressed: true });
    b.advanceTo(0.75);
    expect(b.p.en).toBeCloseTo(0, 9);
    expect(Math.abs(b.speed() - PLAYER.glideGroundSpeed)).toBeLessThan(1e-6);
    b.advanceTo(1.0);
    expect(b.p.en).toBeCloseTo(0.25 * REGEN, 6);
    expect(b.p.glideEnabled).toBe(true);
    console.log(`[4] glide EN0: speed@5=${a.speed()} en@5=${enA5}; spent@0: en@0.75=0 en@1.0=${b.p.en}`);
  });

  it('5. boundary: EN 35 fails (nothing changes), EN 36 succeeds → EN 0 and inertia/glide continue', () => {
    const fail = new Sim();
    fail.p.en = 35;
    fail.frame(1 / 120, { qbPressed: true }, () => {
      // エッジ処理直後（積分前）: 押下は何も変えていない
      expect(fail.p.en).toBe(35);
      expect(fail.p.qbSuccessfulCount).toBe(0);
      expect(fail.p.horizontalMode).toBe('walk');
    });
    expect(fail.p.qbSuccessfulCount).toBe(0);
    // 消費はなく、接地・未消費なので通常の回復（1 刻み分）だけが乗る
    expect(fail.p.en).toBeCloseTo(35 + REGEN / 120, 9);
    expect(fail.p.lastEnSpentAt).toBeNull();
    expect(fail.p.qbLastStartedAt).toBeNull();
    expect(fail.p.horizontalMode).toBe('walk');
    expect(fail.speed()).toBe(0);
    expect(fail.drain().some((e) => e.type === 'qbStart')).toBe(false);
    // 予約されない: 後で EN が回復しても勝手に発動しない
    fail.p.en = MAX_EN;
    fail.advanceTo(2.0);
    expect(fail.p.qbSuccessfulCount).toBe(0);

    const ok = new Sim();
    ok.p.en = 36;
    ok.frame(1 / 120, { qbPressed: true });
    expect(ok.p.qbSuccessfulCount).toBe(1);
    expect(ok.p.en).toBe(0);
    ok.advanceTo(0.5);
    expect(ok.p.en).toBe(0);
    expect(ok.speed()).toBeGreaterThan(PLAYER.glideGroundSpeed);
    expect(ok.p.horizontalMode).toBe('glide');
    ok.advanceTo(0.75);
    expect(Math.abs(ok.speed() - PLAYER.glideGroundSpeed)).toBeLessThan(1e-6);
    ok.advanceTo(3.0);
    expect(Math.abs(ok.speed() - PLAYER.glideGroundSpeed)).toBeLessThan(1e-6);
    console.log(`[5] EN35: count=${fail.p.qbSuccessfulCount}; EN36: count=${ok.p.qbSuccessfulCount} speed@0.5>22, en@3=${ok.p.en}`);
  });

  it('6. cooldown: presses 0.5 s apart → 1 QB; 1.0 s apart → 2', () => {
    const a = new Sim();
    a.frame(1 / 120, { qbPressed: true });
    a.advanceTo(0.5);
    const enBefore = a.p.en;
    a.frame(1 / 120, { qbPressed: true });
    expect(a.p.qbSuccessfulCount).toBe(1);
    expect(a.p.en).toBeCloseTo(enBefore, 9);
    expect(a.p.qbLastStartedAt).toBe(0);
    expect(a.p.qbCooldownRemaining(0.5)).toBeCloseTo(0.5, 9);

    const b = new Sim();
    b.frame(1 / 120, { qbPressed: true });
    b.advanceTo(1.0);
    expect(b.p.qbCooldownRemaining(b.time)).toBeLessThan(1e-9);
    b.frame(1 / 120, { qbPressed: true });
    expect(b.p.qbSuccessfulCount).toBe(2);
    expect(b.p.qbLastStartedAt).toBeCloseTo(1.0, 9);
    console.log(`[6] 0.5s apart count=${a.p.qbSuccessfulCount}; 1.0s apart count=${b.p.qbSuccessfulCount}`);
  });

  it('7. Ctrl: ignored during impulse, brakes at 120 m/s² afterwards (walk mode, not instant), blocks new QB', () => {
    const sim = new Sim();
    sim.frame(1 / 120, { qbPressed: true });
    sim.advanceTo(0.05);
    sim.held = { ctrlDown: true };
    sim.advanceTo(0.1);
    expect(sim.p.horizontalMode).toBe('quickboost');
    expect(sim.speed()).toBeCloseTo(PLAYER.qb.speed, 9);
    sim.advanceTo(0.15);
    expect(sim.speed()).toBeCloseTo(PLAYER.qb.speed, 9); // 噴射中は無視
    sim.advanceTo(0.25);
    const s025 = sim.speed();
    expect(Math.abs(s025 - (PLAYER.qb.speed - PLAYER.walkAccel * 0.1))).toBeLessThan(1e-6);
    expect(sim.p.horizontalMode).toBe('walk');
    expect(sim.p.glideEnabled).toBe(false);
    expect(s025).toBeGreaterThan(0);
    sim.advanceTo(0.5);
    const s05 = sim.speed();
    expect(Math.abs(s05 - (PLAYER.qb.speed - PLAYER.walkAccel * 0.35))).toBeLessThan(1e-6);
    sim.advanceTo(0.15 + PLAYER.qb.speed / PLAYER.walkAccel + 0.05);
    expect(sim.speed()).toBe(0);
    // Ctrl 押下中は QB 不成立（EN 消費なし）
    sim.advanceTo(2.0);
    const enBefore = sim.p.en;
    expect(enBefore).toBeGreaterThanOrEqual(QB_COST);
    sim.frame(1 / 120, { qbPressed: true });
    expect(sim.p.qbSuccessfulCount).toBe(1);
    expect(sim.p.en).toBeCloseTo(enBefore + REGEN / 120, 6);
    console.log(`[7] speed@0.15=80 speed@0.25=${s025} speed@0.5=${s05} count=${sim.p.qbSuccessfulCount}`);
  });

  it('8. Shift toggles once per edge; Shift OFF decays velocity to the walk target', () => {
    const sim = new Sim();
    sim.frame(1 / 120, { shiftPressed: true });
    expect(sim.p.glideEnabled).toBe(true);
    expect(sim.p.horizontalMode).toBe('glide');
    // 保持しても再トグルしない（エッジのみ）
    sim.advanceTo(0.5);
    expect(sim.p.glideEnabled).toBe(true);
    sim.advanceTo(1.0);
    expect(Math.abs(sim.speed() - PLAYER.glideGroundSpeed)).toBeLessThan(1e-6);
    sim.frame(1 / 120, { shiftPressed: true });
    expect(sim.p.glideEnabled).toBe(false);
    expect(sim.p.horizontalMode).toBe('walk');
    expect(sim.speed()).toBeGreaterThan(PLAYER.glideGroundSpeed - PLAYER.walkAccel / 120 - 1e-6);
    sim.advanceTo(1.05);
    const s = sim.speed();
    expect(Math.abs(s - (PLAYER.glideGroundSpeed - PLAYER.walkAccel * 0.05))).toBeLessThan(1e-6);
    sim.advanceTo(1.5);
    expect(sim.speed()).toBe(0);
    // Shift ON with WASD: desiredDir = input direction
    sim.held = { moveRight: 1 };
    sim.frame(1 / 120, { shiftPressed: true });
    expect(sim.p.glideEnabled).toBe(true);
    expect(sim.p.desiredDir[0]).toBeCloseTo(1, 9);
    expect(sim.p.desiredDir[1]).toBeCloseTo(0, 9);
    console.log(`[8] speed after shift-off 0.05s=${s}`);
  });

  it('9. jump/flight: vy=10 on edge only, thrust after 0.20 s hold at 20 EN/s, exact EN-exhaustion split, no air regen', () => {
    const sim = new Sim();
    sim.p.en = 5;
    sim.held = { spaceDown: true };
    // t=0 のフレームで Space エッジ（reset 直後なので接地は最初の更新で検証されてからジャンプする）
    sim.frame(1 / 120, { spacePressed: true });
    expect(sim.p.vel[1]).toBeCloseTo(PLAYER.jumpSpeed - PLAYER.gravity / 120, 9);
    expect(sim.p.grounded).toBe(false);
    expect(sim.events.some((e) => e.type === 'jump')).toBe(true);
    sim.advanceTo(0.1);
    expect(sim.p.vel[1]).toBeCloseTo(PLAYER.jumpSpeed - PLAYER.gravity * 0.1, 6); // 再加算なし
    expect(sim.p.thrusting).toBe(false);
    expect(sim.p.verticalMode).toBe('rising');
    sim.advanceTo(0.2);
    expect(sim.p.en).toBe(5);
    sim.advanceTo(0.3);
    expect(sim.p.thrusting).toBe(true);
    expect(sim.p.verticalMode).toBe('flying');
    expect(sim.p.vel[1]).toBeCloseTo(PLAYER.flightRiseSpeed, 9);
    expect(sim.p.en).toBeCloseTo(5 - PLAYER.flightEnPerSecond * 0.1, 6);
    // EN 5 → 0.25 s で枯渇
    sim.advanceTo(0.45);
    const enAt045 = sim.p.en;
    expect(enAt045).toBe(0);
    expect(sim.p.thrusting).toBe(false);
    expect(sim.p.vel[1]).toBeCloseTo(PLAYER.flightRiseSpeed, 6); // 引き継ぎ
    const yAt045 = sim.p.pos[1];
    sim.advanceTo(0.5);
    expect(sim.p.vel[1]).toBeCloseTo(PLAYER.flightRiseSpeed - PLAYER.gravity * 0.05, 6);
    expect(sim.p.verticalMode).toBe('rising');
    expect(sim.p.pos[1]).toBeGreaterThan(yAt045);
    // 空中では回復しない
    sim.advanceTo(1.3);
    expect(sim.p.grounded).toBe(false);
    expect(sim.p.en).toBe(0);
    // 着地イベント
    sim.held = {};
    sim.advanceTo(3.0);
    expect(sim.p.grounded).toBe(true);
    expect(sim.p.verticalMode).toBe('grounded');
    expect(sim.p.vel[1]).toBe(0);
    expect(sim.drain().filter((e) => e.type === 'landed').length).toBe(1);
    console.log(`[9] en@0.3=${5 - 2} en@0.45=${enAt045} y@0.45=${yAt045} en after landing+regen@3.0=${sim.p.en}`);

    // 空中での押し直しも 0.20 秒必要
    const air = new Sim(DEFAULT_LOADOUT, makeWorld(), [0, 20, 0]);
    air.frame(1 / 120);
    expect(air.p.grounded).toBe(false);
    air.held = { spaceDown: true };
    air.frame(1 / 120, { spacePressed: true });
    const vyAfter = air.p.vel[1];
    expect(vyAfter).toBeLessThan(0); // 空中ではジャンプしない
    air.advanceTo(0.15);
    expect(air.p.thrusting).toBe(false);
    air.advanceTo(0.25);
    expect(air.p.thrusting).toBe(true);
    // Space を離すと即停止し vy を引き継ぐ
    air.held = {};
    air.frame(1 / 120);
    expect(air.p.thrusting).toBe(false);
    expect(air.p.vel[1]).toBeCloseTo(PLAYER.flightRiseSpeed - PLAYER.gravity / 120, 6);
  });

  it('10. air glide: target 16·legMul, rate (80−16)/0.6·legMul; landing transitions to 22 smoothly', () => {
    const run = (loadout: Loadout) => {
      const legMul = LEGS[loadout.legs].speedMul;
      const sim = new Sim(loadout, makeWorld(), [0, 10, 0]);
      sim.frame(1 / 120); // 最初の更新で空中と判定される（落下開始）
      expect(sim.p.grounded).toBe(false);
      const t0 = sim.time;
      sim.frame(1 / 120, { qbPressed: true });
      sim.advanceTo(t0 + 0.15);
      expect(sim.speed()).toBeCloseTo(PLAYER.qb.speed * legMul, 9);
      sim.advanceTo(t0 + 0.25);
      const airRate = ((PLAYER.qb.speed - PLAYER.airSpeed) / PLAYER.qb.decelSeconds) * legMul;
      const s025 = sim.speed();
      expect(Math.abs(s025 - (PLAYER.qb.speed * legMul - airRate * 0.1))).toBeLessThan(1e-6);
      expect(sim.p.grounded).toBe(false);
      sim.advanceTo(t0 + 0.8);
      expect(sim.p.grounded).toBe(false);
      const s08 = sim.speed();
      expect(Math.abs(s08 - PLAYER.airSpeed * legMul)).toBeLessThan(1e-6);
      // 着地 t0+≈1.054 → 22·legMul へ有限加速度で移行
      const landT = t0 + Math.sqrt((2 * 10) / PLAYER.gravity);
      sim.advanceTo(landT + 0.02);
      expect(sim.p.grounded).toBe(true);
      const sLand = sim.speed();
      expect(sLand).toBeGreaterThan(PLAYER.airSpeed * legMul);
      expect(sLand).toBeLessThan(PLAYER.glideGroundSpeed * legMul);
      expect(sim.p.glideEnabled).toBe(true);
      sim.advanceTo(landT + 0.2);
      expect(Math.abs(sim.speed() - PLAYER.glideGroundSpeed * legMul)).toBeLessThan(1e-6);
      console.log(`[10] ${loadout.legs}: speed@0.25=${s025} speed@0.8=${s08} speed just after landing=${sLand} speed@+0.2=${sim.speed()}`);
    };
    run(DEFAULT_LOADOUT);
    run(QUAD);
  });

  it('11. walls: gliding into a wall stops without bounce; no tunneling at 80 m/s through a 0.2 m wall', () => {
    const wall: AABB = { min: [20, -2, -50], max: [20.2, 10, 50] };
    const sim = new Sim(DEFAULT_LOADOUT, makeWorld([wall]));
    sim.yaw = -Math.PI / 2; // 前方 +X
    sim.frame(1 / 120, { qbPressed: true });
    expect(sim.p.vel[0]).toBeCloseTo(PLAYER.qb.speed, 9);
    let maxX = -Infinity;
    let minVx = Infinity;
    while (sim.time < 1.0) {
      sim.frame(1 / 60);
      maxX = Math.max(maxX, sim.p.pos[0]);
      minVx = Math.min(minVx, sim.p.vel[0]);
    }
    const limit = wall.min[0] - PLAYER.halfExtents[0];
    expect(maxX).toBeLessThanOrEqual(limit);
    expect(sim.p.pos[0]).toBeGreaterThan(limit - 1e-3);
    expect(sim.p.vel[0]).toBe(0);
    expect(minVx).toBeGreaterThanOrEqual(0); // 反発なし
    expect(sim.p.horizontalMode).toBe('glide');
    const xStop = sim.p.pos[0];
    sim.advanceTo(2.0);
    expect(sim.p.pos[0]).toBeCloseTo(xStop, 9);
    expect(sim.world.boxOverlaps(sim.p.getHitCenter(), PLAYER.halfExtents)).toBe(false);
    console.log(`[11] stop x=${xStop} (wall face ${wall.min[0]}, limit ${limit}), vel.x=${sim.p.vel[0]}`);
  });

  it('12. diagonal WASD does not exceed 10 m/s; movement is camera-yaw relative (pitch irrelevant)', () => {
    const sim = new Sim();
    sim.yaw = 0.7;
    sim.held = { moveForward: 1, moveRight: 1 };
    let maxSpeed = 0;
    while (sim.time < 1.0) {
      sim.frame(1 / 120);
      maxSpeed = Math.max(maxSpeed, sim.speed());
    }
    expect(maxSpeed).toBeLessThanOrEqual(PLAYER.walkSpeed + 1e-9);
    expect(sim.speed()).toBeCloseTo(PLAYER.walkSpeed, 9);
    expect(sim.p.vel[1]).toBe(0);
    expect(sim.p.grounded).toBe(true);
    const f = forwardFromYaw(0.7);
    const r = rightFromYaw(0.7);
    const dx = f[0] + r[0];
    const dz = f[2] + r[2];
    const l = Math.hypot(dx, dz);
    expect(sim.p.vel[0]).toBeCloseTo((dx / l) * PLAYER.walkSpeed, 9);
    expect(sim.p.vel[2]).toBeCloseTo((dz / l) * PLAYER.walkSpeed, 9);
    expect(sim.p.horizontalMode).toBe('walk');
    // 4脚: 10 × 0.8
    const q = new Sim(QUAD);
    q.held = { moveForward: 1, moveRight: -1 };
    q.advanceTo(1.0);
    expect(q.speed()).toBeCloseTo(PLAYER.walkSpeed * LEGS.quadruped.speedMul, 9);
    // 入力を離すと地上では 0 へ減速（rate 120）
    sim.held = {};
    const tRelease = sim.time;
    sim.advanceTo(tRelease + 0.05);
    expect(sim.speed()).toBeCloseTo(PLAYER.walkSpeed - PLAYER.walkAccel * 0.05, 6);
    sim.advanceTo(tRelease + 0.2);
    expect(sim.speed()).toBe(0);
    console.log(`[12] max diagonal speed=${maxSpeed}, quad=${q.speed()}`);
  });

  it('13. same-step EN priority: QB cost → beam → flight', () => {
    const setup = (): Sim => {
      const sim = new Sim(DEFAULT_LOADOUT, makeWorld(), [0, 5, 0]);
      sim.frame(1 / 120);
      expect(sim.p.grounded).toBe(false);
      sim.held = { spaceDown: true };
      const tPress = sim.time;
      sim.frame(1 / 120, { spacePressed: true });
      // 押下開始から 0.20 秒後の更新で推進が始まる（この更新は QB/ビームと同じ更新）
      sim.advanceTo(tPress + PLAYER.flightHoldSeconds);
      expect(sim.p.thrusting).toBe(false);
      expect(sim.p.en).toBe(MAX_EN);
      return sim;
    };
    // EN 44: QB(36) 成立 → ビーム(8) 成立 → EN 0 → 飛行推進なし
    const a = setup();
    a.p.en = 44;
    let beamOk: boolean | null = null;
    a.frame(1 / 120, { qbPressed: true }, (t) => {
      expect(a.p.en).toBe(44 - QB_COST);
      beamOk = a.p.spendEn(WEAPONS.beam.enCost, t);
    });
    expect(a.p.qbSuccessfulCount).toBe(1);
    expect(beamOk).toBe(true);
    expect(a.p.en).toBe(0);
    expect(a.p.thrusting).toBe(false);
    a.advanceTo(0.5);
    expect(a.p.en).toBe(0);
    expect(a.p.thrusting).toBe(false);

    // EN 40: QB(36) 成立 → ビーム(8) 不成立（EN 4 のまま）→ 飛行は残り 4 だけ消費
    const b = setup();
    b.p.en = 40;
    let beamOk2: boolean | null = null;
    const t0 = b.time;
    b.frame(1 / 120, { qbPressed: true }, (t) => {
      expect(b.p.en).toBe(40 - QB_COST);
      beamOk2 = b.p.spendEn(WEAPONS.beam.enCost, t);
      expect(b.p.en).toBe(4);
    });
    expect(beamOk2).toBe(false);
    expect(b.p.qbSuccessfulCount).toBe(1);
    expect(b.p.thrusting).toBe(true);
    expect(b.p.en).toBeCloseTo(4 - PLAYER.flightEnPerSecond / 120, 6);
    let minEn = Infinity;
    let thrustEndTime: number | null = null;
    while (b.time < t0 + 0.4) {
      b.frame(1 / 120);
      minEn = Math.min(minEn, b.p.en);
      if (thrustEndTime === null && !b.p.thrusting) thrustEndTime = b.time;
    }
    expect(minEn).toBeGreaterThanOrEqual(0);
    expect(b.p.en).toBe(0);
    expect(b.p.thrusting).toBe(false);
    expect(thrustEndTime).not.toBeNull();
    expect(Math.abs((thrustEndTime as number) - (t0 + 4 / PLAYER.flightEnPerSecond))).toBeLessThan(1e-6);
    console.log(`[13] EN44 → en=${a.p.en}; EN40 → beam denied, thrust ended at +${(thrustEndTime as number) - t0}s, en=${b.p.en}`);
  });

  it('reset restores HP/EN/ammo/weapon/modes/timers', () => {
    const sim = new Sim();
    sim.frame(1 / 120, { qbPressed: true });
    sim.p.takeDamage(300);
    sim.p.ammo.machinegun = 10;
    sim.p.weapon = 'beam';
    sim.advanceTo(0.5);
    sim.p.reset([1, 2, 3], 0.5);
    const p = sim.p;
    expect(p.hp).toBe(PLAYER.maxHp);
    expect(p.en).toBe(computeEffectiveStats(DEFAULT_LOADOUT).maxEn);
    expect(p.ammo).toEqual({ machinegun: WEAPONS.machinegun.ammo, missile: WEAPONS.missile.ammo });
    expect(p.weapon).toBe('machinegun');
    expect(p.pos).toEqual([1, 2, 3]);
    expect(p.vel).toEqual([0, 0, 0]);
    expect(p.yaw).toBe(0.5);
    expect(p.horizontalMode).toBe('walk');
    expect(p.glideEnabled).toBe(false);
    expect(p.qbSuccessfulCount).toBe(0);
    expect(p.qbLastStartedAt).toBeNull();
    expect(p.qbImpulseRemaining).toBe(0);
    expect(p.lastEnSpentAt).toBeNull();
    expect(p.thrusting).toBe(false);
    expect(p.alive).toBe(true);
    // 幾何
    const m = p.getMuzzlePosition();
    const off = PLAYER.muzzleOffset;
    const c = Math.cos(0.5);
    const s = Math.sin(0.5);
    expect(m[0]).toBeCloseTo(1 + off[0] * c + off[2] * s, 9);
    expect(m[1]).toBeCloseTo(2 + off[1], 9);
    expect(m[2]).toBeCloseTo(3 - off[0] * s + off[2] * c, 9);
    expect(p.getHitCenter()).toEqual([1, 2 + PLAYER.hitCenterOffset[1], 3]);
    expect(p.getHitBox().halfExtents).toEqual([...PLAYER.halfExtents]);
  });

  // -------------------------------------------------------------------------
  // レビュー指摘の回帰試験
  // -------------------------------------------------------------------------

  it('R1. landing rests on the actual contact height regardless of impact speed (no 3–5 cm hover)', () => {
    const results: string[] = [];
    for (const y0 of [0.05, 0.3, 0.5, 0.8, 1.0, 2.0, 12.0]) {
      const sim = new Sim(DEFAULT_LOADOUT, makeWorld(), [0, y0, 0]);
      let minY = Infinity;
      while (sim.time < 3.0 - 1e-9) {
        sim.frame(Math.min(1 / 60, 3.0 - sim.time));
        minY = Math.min(minY, sim.p.pos[1]);
      }
      // 接触面（床上面 y=0）から CONTACT_MARGIN 手前に静止する。床にめり込まない
      expect(sim.p.pos[1]).toBeGreaterThanOrEqual(0);
      expect(sim.p.pos[1]).toBeLessThanOrEqual(CONTACT_MARGIN + 1e-12);
      expect(minY).toBeGreaterThanOrEqual(0);
      expect(sim.p.grounded).toBe(true);
      expect(sim.p.verticalMode).toBe('grounded');
      expect(sim.p.vel[1]).toBe(0);
      expect(sim.world.boxOverlaps(sim.p.getHitCenter(), PLAYER.halfExtents)).toBe(false);
      // 床のわずか上（プローブ内）の出現は最初の更新で接地扱い（着地イベントなし）。それ以外は 1 回だけ着地
      const landed = sim.drain().filter((e) => e.type === 'landed').length;
      expect(landed).toBe(y0 <= 0.05 ? 0 : 1);
      results.push(`y0=${y0}→y=${sim.p.pos[1]}`);
    }
    // 接地中の歩行でも高さは変わらない
    const walk = new Sim();
    walk.held = { moveForward: 1 };
    walk.advanceTo(2.0);
    expect(walk.p.pos[1]).toBeGreaterThanOrEqual(0);
    expect(walk.p.pos[1]).toBeLessThanOrEqual(CONTACT_MARGIN + 1e-12);
    console.log(`[R1] ${results.join(' ')} walk y=${walk.p.pos[1]}`);
  });

  it('R2. arrival at the target speed inside an unsplit step is integrated exactly (piecewise-linear velocity)', () => {
    // 分割なしの生の呼び出し列: 到達（t=0.75）が最後の 0.4 s 区間の内部にある
    const p = new Player(DEFAULT_LOADOUT);
    const world = makeWorld();
    p.reset([0, 0, 0], 0);
    const events: SimEvent[] = [];
    const none = emptyInput();
    p.applyEdgeInput({ ...none, qbPressed: true }, 0, 0, events);
    p.integrate(0.15, 0, none, 0, world, events);
    expect(p.pos[2]).toBeCloseTo(-PLAYER.qb.speed * PLAYER.qb.impulseSeconds, 9);
    p.integrate(0.45, 0.15, none, 0, world, events);
    const rate = (PLAYER.qb.speed - PLAYER.glideGroundSpeed) / PLAYER.qb.decelSeconds;
    const v06 = PLAYER.qb.speed - rate * 0.45;
    expect(-p.vel[2]).toBeCloseTo(v06, 9);
    p.integrate(0.4, 0.6, none, 0, world, events);
    expect(-p.vel[2]).toBeCloseTo(PLAYER.glideGroundSpeed, 9);
    // 厳密値: 12 + 30.6 + 22×0.25 = 48.1
    const exact = PLAYER.qb.speed * PLAYER.qb.impulseSeconds + ((PLAYER.qb.speed + PLAYER.glideGroundSpeed) / 2) * PLAYER.qb.decelSeconds + PLAYER.glideGroundSpeed * 0.25;
    expect(-p.pos[2]).toBeCloseTo(exact, 9);
    expect(p.pos[0]).toBeCloseTo(0, 12);

    // 歩行の到達（10 m/s へ 1/12 s）も 1 回の大きな更新で厳密: 1 s で 10 − 10²/240 = 9.5833 m
    const w = new Player(DEFAULT_LOADOUT);
    w.reset([0, 0, 0], 0);
    w.integrate(1.0, 0, { ...none, moveForward: 1 }, 0, world, events);
    expect(-w.pos[2]).toBeCloseTo(PLAYER.walkSpeed - (PLAYER.walkSpeed * PLAYER.walkSpeed) / (2 * PLAYER.walkAccel), 9);
    expect(-w.vel[2]).toBeCloseTo(PLAYER.walkSpeed, 9);
    // 減速も同様（1 回の更新で 10 → 0、距離 10²/240）
    w.integrate(1.0, 1.0, none, 0, world, events);
    expect(Math.hypot(w.vel[0], w.vel[2])).toBe(0);
    expect(-w.pos[2]).toBeCloseTo(PLAYER.walkSpeed - (PLAYER.walkSpeed * PLAYER.walkSpeed) / (2 * PLAYER.walkAccel) + (PLAYER.walkSpeed * PLAYER.walkSpeed) / (2 * PLAYER.walkAccel), 9);
    console.log(`[R2] unsplit QB z=${p.pos[2]} (exact ${-exact}); walk 1s=${-w.pos[2]}`);
  });

  it('R3. thrust never starts from the ground: landing with Space held needs a fresh press; EN-0 hop loop is gone', () => {
    // (a) EN 3、ジャンプ＋押しっぱなし: 推進 0.20〜0.35 s で EN 0、着地後は接地のまま回復する
    const a = new Sim();
    a.p.en = 3;
    a.held = { spaceDown: true };
    a.frame(1 / 120, { spacePressed: true });
    a.advanceTo(0.35);
    expect(a.p.en).toBe(0);
    // 着地まで進める
    while (!a.p.grounded && a.time < 3.0) a.frame(1 / 120);
    const landT = a.time;
    expect(landT).toBeLessThan(2.0);
    expect(a.drain().filter((e) => e.type === 'landed').length).toBe(1);
    // 着地後 Space を押し続けても再離陸せず、推進もしない
    let airborneAfter = 0;
    let thrustAfter = 0;
    while (a.time < 3.0 - 1e-9) {
      a.frame(Math.min(1 / 120, 3.0 - a.time));
      if (!a.p.grounded) airborneAfter++;
      if (a.p.thrusting) thrustAfter++;
    }
    expect(airborneAfter).toBe(0);
    expect(thrustAfter).toBe(0);
    expect(a.p.grounded).toBe(true);
    expect(a.p.verticalMode).toBe('grounded');
    expect(a.drain().some((e) => e.type === 'landed' || e.type === 'jump')).toBe(false);
    // 着地時刻から回復（最後の消費 0.35 + 0.75 < 着地時刻）
    expect(a.p.en).toBeCloseTo(REGEN * (3.0 - landT), 6);
    // Space を押し直せば接地ジャンプ → 0.20 s 後に飛行
    a.frame(1 / 120, { spacePressed: true });
    expect(a.p.grounded).toBe(false);
    expect(a.drain().some((e) => e.type === 'jump')).toBe(true);
    const tPress = a.time - 1 / 120;
    a.advanceTo(tPress + PLAYER.flightHoldSeconds + 1 / 120);
    expect(a.p.thrusting).toBe(true);

    // (b) 床から 0.2 m の空中で押下 → 0.15 s で着地 → 0.20 s 経過しても地上から推進しない
    const b = new Sim(DEFAULT_LOADOUT, makeWorld(), [0, 0.2, 0]);
    b.frame(1 / 120);
    expect(b.p.grounded).toBe(false);
    b.held = { spaceDown: true };
    b.frame(1 / 120, { spacePressed: true });
    b.advanceTo(0.4);
    expect(b.p.grounded).toBe(true);
    expect(b.p.thrusting).toBe(false);
    expect(b.p.verticalMode).toBe('grounded');
    expect(b.p.vel[1]).toBe(0);
    expect(b.p.en).toBe(MAX_EN);
    expect(b.drain().some((e) => e.type === 'jump')).toBe(false);
    // 接地中に Space を押していても nextEventTime は飛行開始を予定しない
    expect(b.p.nextEventTime(b.time, { ...emptyInput(), spaceDown: true })).toBeNull();

    // (c) EN 0 で接地中に Space を押し続けても跳ねず、回復が続く
    const c = new Sim();
    c.p.en = 0;
    c.held = { spaceDown: true };
    c.frame(1 / 120, { spacePressed: true }); // 接地ジャンプ（EN 0 でも可）
    while (!c.p.grounded && c.time < 3.0) c.frame(1 / 120);
    const cLand = c.time;
    let hops = 0;
    while (c.time < cLand + 2.0 - 1e-9) {
      c.frame(1 / 120);
      if (!c.p.grounded) hops++;
    }
    expect(hops).toBe(0);
    expect(c.p.en).toBeCloseTo(REGEN * 2.0, 6);
    console.log(`[R3] landed at ${landT}s, en@3.0=${a.p.en}; air-press near floor: thrusting=${b.p.thrusting}; EN0 hold: hops=${hops} en=${c.p.en}`);
  });

  it('R4. spendEn(0) succeeds without touching the regen timer; NaN/negative are rejected', () => {
    const p = new Player(DEFAULT_LOADOUT);
    p.reset([0, 0, 0], 0);
    p.en = 50;
    expect(p.spendEn(0, 5)).toBe(true);
    expect(p.en).toBe(50);
    expect(p.lastEnSpentAt).toBeNull();
    expect(p.spendEn(Number.NaN, 5)).toBe(false);
    expect(p.spendEn(-1, 5)).toBe(false);
    expect(p.lastEnSpentAt).toBeNull();
    expect(p.en).toBe(50);
    // 費用 0 の呼び出しの後も回復は待たない
    const sim = new Sim();
    sim.p.en = 50;
    sim.frame(1 / 120, {}, (t) => {
      expect(sim.p.spendEn(WEAPONS.machinegun.enCost, t)).toBe(true);
    });
    expect(sim.p.en).toBeCloseTo(50 + REGEN / 120, 9);
    // 実際の消費は待ち時間を設定する
    expect(sim.p.spendEn(WEAPONS.beam.enCost, sim.time)).toBe(true);
    expect(sim.p.lastEnSpentAt).toBe(sim.time);
  });

  it('R5. a Space edge before the first step after reset() jumps only if the spawn is actually on a floor', () => {
    // 空中出現: ジャンプしない
    const air = new Sim(DEFAULT_LOADOUT, makeWorld(), [0, 10, 0]);
    air.held = { spaceDown: true };
    air.frame(1 / 120, { spacePressed: true });
    expect(air.p.vel[1]).toBeCloseTo(-PLAYER.gravity / 120, 9);
    expect(air.p.grounded).toBe(false);
    expect(air.drain().some((e) => e.type === 'jump')).toBe(false);
    // 押下は飛行の押下開始として有効（0.20 s 後に推進）
    air.advanceTo(PLAYER.flightHoldSeconds + 1 / 120);
    expect(air.p.thrusting).toBe(true);

    // 床上出現: 最初の更新で接地を確認してからジャンプ（同じフレーム内）
    const floor = new Sim();
    floor.frame(1 / 120, { spacePressed: true });
    expect(floor.p.vel[1]).toBeCloseTo(PLAYER.jumpSpeed - PLAYER.gravity / 120, 9);
    expect(floor.p.grounded).toBe(false);
    expect(floor.drain().filter((e) => e.type === 'jump').length).toBe(1);

    // reset() 後に何も押さなければ空中出現は落下、床上出現は接地のまま
    const again = new Sim(DEFAULT_LOADOUT, makeWorld(), [0, 3, 0]);
    again.p.reset([0, 3, 0], 0);
    expect(again.p.grounded).toBe(true); // 仕様上の出現は床上（検証前の既定）
    again.frame(1 / 120);
    expect(again.p.grounded).toBe(false);
    expect(again.p.verticalMode).toBe('falling');
  });

  it('R6. non-finite or out-of-range WASD values never produce NaN velocity', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const sim = new Sim();
      sim.held = { moveForward: bad, moveRight: bad };
      sim.advanceTo(0.5);
      expect(Number.isFinite(sim.p.vel[0]) && Number.isFinite(sim.p.vel[1]) && Number.isFinite(sim.p.vel[2])).toBe(true);
      expect(sim.speed()).toBe(0);
      expect(sim.p.pos.every((v) => Number.isFinite(v))).toBe(true);
    }
    // 範囲外の大きさは [-1, 1] に丸められ、速度上限 10 m/s を超えない
    const big = new Sim();
    big.held = { moveForward: 5, moveRight: -7 };
    big.advanceTo(1.0);
    expect(big.speed()).toBeLessThanOrEqual(PLAYER.walkSpeed + 1e-9);
    expect(big.speed()).toBeCloseTo(PLAYER.walkSpeed, 9);
  });

  it('R7. verticalMode is refreshed by applyEdgeInput (jump edge → rising immediately)', () => {
    const sim = new Sim();
    sim.frame(1 / 120); // 接地を検証
    expect(sim.p.verticalMode).toBe('grounded');
    const input: InputFrame = { ...emptyInput(), spaceDown: true, spacePressed: true };
    sim.p.applyEdgeInput(input, 0, sim.time, sim.events);
    expect(sim.p.vel[1]).toBe(PLAYER.jumpSpeed);
    expect(sim.p.grounded).toBe(false);
    expect(sim.p.verticalMode).toBe('rising');
    expect(sim.events.some((e) => e.type === 'jump')).toBe(true);
    // 飛行中に Space を離すエッジ処理でも即座に flying → rising
    sim.held = { spaceDown: true };
    sim.advanceTo(sim.time + PLAYER.flightHoldSeconds + 0.05);
    expect(sim.p.verticalMode).toBe('flying');
    sim.p.applyEdgeInput(emptyInput(), 0, sim.time, sim.events);
    expect(sim.p.thrusting).toBe(false);
    expect(sim.p.verticalMode).toBe('rising');
  });
});
