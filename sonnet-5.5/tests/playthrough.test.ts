/**
 * 通し走破 (SPEC §2.2, §11): 実際の Game (実ステージ buildStage()) の tick 実行と、実際のプレイヤー物理 (WASD / Shift / Ctrl / Q / Space の入力) だけで、
 * スタートから脱出領域まで走り切れることを確認する。テレポートや状態の書き換えで移動しない。
 *
 * テストが書き換えるのは次だけ (tools/playthrough.ts の先頭コメントも参照):
 *   - 視点 (Game.look() 経由の player.yaw)
 *   - 敵の排除: damageEnemy(state, enemy, 1e9, 'machinegun') (隔壁とゲートの開放は objective.ts の updateProgress が行う)
 *   - 「敵あり」の走破だけ: player.hp = 1e9 (被弾を無効化する。敵の攻撃そのものは実際に飛んでくる)
 *   - ゲート試験だけ: 隔壁 B6 の箱を world.setBoxEnabled(.., false) で無効にする (6/6 未満でゲートが閉じたまま S15 の最終ゲートまで歩いて着くため。
 *     プレイヤーの位置・速度ではない)
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { GENERATOR_PARTS, LEGS_PARTS, PLAYER } from '../src/config';
import type { StageDef } from '../src/sim/types';
import { buildStage } from '../src/stage';
import { CLIMB_SPECS } from '../src/stage/blueprint';
import { validateStage } from '../src/stage/validate';
import { BEST_LOADOUT, WORST_LOADOUT, allLoadouts, getGroundPlan, idealGlideSeconds, loadoutKey, runPlaythrough } from '../tools/playthrough';
import type { BotOptions, RunResult } from '../tools/playthrough';

let stage: StageDef;
let shortest = NaN;
const cache = new Map<string, RunResult>();
function run(o: Omit<BotOptions, 'stage'>): RunResult {
  const key = `${loadoutKey(o.loadout)}|${o.enemies}|${o.useQB ? 'qb' : ''}|${o.qbReserve ?? ''}|${o.qbStopMargin ?? ''}|${o.ramTest ? 'ram' : ''}|${o.gateProbe ? 'gate' : ''}`;
  let r = cache.get(key);
  if (!r) {
    r = runPlaythrough({ ...o, stage });
    cache.set(key, r);
  }
  return r;
}

/** 走破の共通の合格条件 (a)(b)(c)(e) */
function expectCleanClear(r: RunResult, label: string): void {
  expect(r.failure, `${label}: ${r.failure}`).toBeNull();
  // (a) 実際に mode === 'cleared' (endReason 'escaped')
  expect(r.mode, label).toBe('cleared');
  expect(r.endReason, label).toBe('escaped');
  expect(r.cleared, label).toBe(true);
  expect(r.snapshot.state, `${label}: snapshot.state`).toBe('cleared');
  expect(r.snapshot.hasNonFinite, `${label}: snapshot has NaN/Infinity`).toBe(false);
  // 6つの制御砲台の破壊 → 対応する隔壁 → 最終ゲート
  expect(r.controlsDestroyed, label).toBe(6);
  expect(r.snapshot.controlsDestroyed, label).toBe(6);
  expect(r.snapshot.openBarrierIds.slice().sort(), label).toEqual(['B1', 'B2', 'B3', 'B4', 'B5', 'B6']);
  expect(r.gateOpen, label).toBe(true);
  expect(r.gateOpenTick, label).not.toBeNull();
  // ゲートが開いてから脱出領域に入り、その tick のうちにクリアになる
  expect(r.escapeEnteredTick as number, label).toBeGreaterThanOrEqual(r.gateOpenTick as number);
  expect(r.clearedTick, label).toBe(r.escapeEnteredTick);
  // (b) 実際に通過した区画 (snapshot.stage.visitedSectorIds) が 12 以上
  const visited = r.snapshot.visitedSectorIds;
  expect(new Set(visited).size, label).toBe(visited.length);
  expect(visited.length, `${label}: visited ${visited.join(',')}`).toBeGreaterThanOrEqual(12);
  expect(visited.slice(0, 1), label).toEqual(['S01']);
  expect(visited, label).toContain('S16');
  expect(r.snapshot.sectorCount, label).toBeGreaterThanOrEqual(15);
  // (c) 実際の走行距離 (軌跡の累積長) は最短経路以上で、規模の下限 1500 m 以上
  expect(r.pathLength, label).toBeGreaterThanOrEqual(1500);
  expect(r.pathLength / shortest, `${label}: path ${r.pathLength} / shortest ${shortest}`).toBeGreaterThanOrEqual(1);
  expect(r.pathLength / shortest, label).toBeLessThan(1.25);
  // (e) NaN / めり込み / コースアウトが無い。瞬間移動が無い (1 tick の移動は QB の 80 m/s = 0.667 m 程度が上限。落下との合成で僅かに超えうるので 0.7 m)
  expect(r.anomalies, `${label}: ${r.anomalies.overlapFirst}`).toEqual({ nonFinite: 0, overlap: 0, killY: 0, overlapFirst: null });
  expect(r.maxStepDistance, label).toBeLessThanOrEqual(0.7);
  // プレイヤーの位置・速度・EN・接地状態は Game.step() だけが更新した (ボットの操作の間に外から書き換えられていない)
  expect(r.externalWrites, label).toBe(0);
  // 詰まっていない
  expect(r.stuck, label).toEqual([]);
  // (d) 8か所の飛行昇降: 全て成功し、ENは最大ENの範囲で、実際の飛行(上昇推進)を使っている
  const maxEn = GENERATOR_PARTS[r.loadout.generator].maxEn;
  expect(r.climbs.map((c) => c.id), label).toEqual(CLIMB_SPECS.map((c) => c.id));
  for (const c of r.climbs) {
    expect(c.ok, `${label} ${c.id}: ${c.failure}`).toBe(true);
    expect(c.height, `${label} ${c.id}`).toBeGreaterThanOrEqual(6);
    expect(c.height, `${label} ${c.id}`).toBeLessThanOrEqual(16);
    expect(c.enUsed, `${label} ${c.id}`).toBeGreaterThan(20);
    expect(c.enUsed, `${label} ${c.id}`).toBeLessThanOrEqual(maxEn);
    expect(c.enMin, `${label} ${c.id}`).toBeGreaterThanOrEqual(0);
    expect(c.flightSeconds, `${label} ${c.id}`).toBeGreaterThan(1);
    expect(c.flightSeconds, `${label} ${c.id}`).toBeLessThan(maxEn / PLAYER.FLIGHT_EN_PER_SEC);
    expect(c.climbSeconds, `${label} ${c.id}`).toBeLessThan(8);
    expect(c.landDistance, `${label} ${c.id}`).toBeLessThan(6);
  }
  // (h) ゲーム内時間: QB の最高速度でも届かない下限 (経路長/80) より長く、現実的な上限より短い
  expect(r.gameSeconds, label).toBeGreaterThan(shortest / PLAYER.QB.SPEED);
  expect(r.gameSeconds, label).toBeLessThan(400);
}

describe('playthrough: real Game on buildStage() driven only by inputs', () => {
  beforeAll(() => {
    stage = buildStage();
    getGroundPlan(stage); // 地上経路の計画 (約1.5秒。ステージごとに1回)
    const rep = validateStage(stage, { runClimbBot: false });
    expect(rep.route.found).toBe(true);
    shortest = rep.route.length;
  });

  it('the bot has a collision-checked ground plan for every walk step, split at the 8 flight climbs', () => {
    const { plan } = getGroundPlan(stage);
    const walks = plan.filter((s) => s.kind === 'walk');
    const climbs = plan.filter((s) => s.kind === 'climb');
    expect(climbs.length).toBe(stage.climbs.length);
    expect(walks.length).toBe(stage.climbs.length + 1);
    for (const w of walks) {
      if (w.kind !== 'walk') continue;
      expect(w.path, `no ground path ${JSON.stringify(w.from)} -> ${JSON.stringify(w.to)}`).not.toBeNull();
      expect((w.path ?? []).length).toBeGreaterThanOrEqual(2);
    }
    expect(shortest, 'verified shortest feasible route (SPEC §2.2: >= 1500 m)').toBeGreaterThanOrEqual(1500);
  });

  it('(a)-(e),(h) worst loadout (quadruped + recovery: max EN 90, air 12.8 m/s) and best loadout (biped + capacity) clear the stage with every enemy destroyed', () => {
    for (const lo of [WORST_LOADOUT, BEST_LOADOUT]) {
      const r = run({ loadout: lo, enemies: 'dead' });
      const label = loadoutKey(lo);
      expectCleanClear(r, label);
      // 走破の前に 6 つの制御砲台を damageEnemy で撃破 → 隔壁とゲートが開いた状態で出発し、全45体が撃破済み
      expect(r.killCount, label).toBe(45);
      expect(r.enemiesAlive, label).toBe(0);
      expect(r.qbCount, `${label}: the plain run does not use QB`).toBe(0);
      expect(r.timeBreakdown.enWait, `${label}: EN was never short before a climb`).toBe(0);
    }
    const worst = run({ loadout: WORST_LOADOUT, enemies: 'dead' });
    const best = run({ loadout: BEST_LOADOUT, enemies: 'dead' });
    // 4脚は 0.8 倍の速さ: 同じ経路に掛かる時間は 2脚より長い。空中 12.8 m/s でも全昇降を通過
    expect(worst.gameSeconds).toBeGreaterThan(best.gameSeconds);
    expect(worst.maxSpeed).toBeLessThanOrEqual(PLAYER.QB.SPEED * LEGS_PARTS.quadruped.speedMult + 1e-6 + 40); // 落下の速度を含む
    // (h) 理想走行 (グライドだけ・停止無し) との差: 隔壁や詰まりの待ちが無いので、実測は理想の 1.0〜1.3 倍
    for (const r of [worst, best]) {
      const ideal = idealGlideSeconds(r);
      expect(r.gameSeconds / ideal, loadoutKey(r.loadout)).toBeGreaterThan(0.99);
      expect(r.gameSeconds / ideal, loadoutKey(r.loadout)).toBeLessThan(1.3);
    }
  });

  it('(a) all 18 loadouts clear the stage (enemies destroyed) with identical, in-range flight climbs', () => {
    const results = allLoadouts().map((lo) => run({ loadout: lo, enemies: 'dead' }));
    expect(results.length).toBe(18);
    for (const r of results) expectCleanClear(r, loadoutKey(r.loadout));
    // 昇降のEN消費は構成に依らず(ENは足りている)同じ: 高低差 12 m は 28 EN、14 m は 33 EN
    for (const r of results) {
      const by = Object.fromEntries(r.climbs.map((c) => [c.id, c]));
      for (const id of ['C1', 'C2', 'C3', 'C5', 'C6', 'C7', 'C8']) expect(by[id].enUsed, `${loadoutKey(r.loadout)} ${id}`).toBeCloseTo(28, 0);
      expect(by.C4.enUsed, `${loadoutKey(r.loadout)} C4`).toBeCloseTo(33, 0);
    }
  });

  it('(f) closed barriers stop the bot in front of them (walking and QB ram), and it passes each one only after its control turret is destroyed', () => {
    for (const lo of [WORST_LOADOUT, BEST_LOADOUT]) {
      const r = run({ loadout: lo, enemies: 'progressive', ramTest: true });
      const label = `${loadoutKey(lo)} progressive`;
      expectCleanClear(r, label);
      expect(r.killCount, label).toBe(45); // 39 体は最初から撃破済み + 制御砲台 6 体 (隔壁の手前で 1 体ずつ)
      expect(r.barriers.map((b) => b.id), label).toEqual(['B1', 'B2', 'B3', 'B4', 'B5', 'B6']);
      const mult = LEGS_PARTS[lo.legs].speedMult;
      r.barriers.forEach((b, i) => {
        const tag = `${label} ${b.id}`;
        // 手前で止まる: 前進入力を 1.5 秒押し続けても隔壁の面から動かない / めり込まない
        expect(b.pushSeconds, tag).toBeGreaterThanOrEqual(1.4);
        expect(b.pushInto, tag).toBeLessThan(1e-3);
        expect(b.gapToBarrier, tag).toBeGreaterThan(-1e-3);
        expect(b.gapToBarrier, tag).toBeLessThan(0.05);
        expect(b.neverCrossedWhileClosed, tag).toBe(true);
        // QB (80 m/s x 脚倍率) で突っ込んでも掃引衝突ですり抜けない
        expect(b.ram, tag).not.toBeNull();
        expect(b.ram?.qbFired, tag).toBe(true);
        expect(b.ram?.maxSpeed as number, tag).toBeGreaterThan(0.6 * PLAYER.QB.SPEED * mult);
        expect(b.ram?.penetration as number, tag).toBeLessThan(1e-3);
        expect(b.ram?.crossed, tag).toBe(false);
        // 撃破の直前は、それまでの制御砲台だけが壊れていて、ゲートは閉じている
        expect(b.before.controlsDestroyed, tag).toBe(i);
        expect(b.before.gateOpen, tag).toBe(false);
        expect(b.before.mode, tag).toBe('playing');
        // 開放は objective.ts が撃破の同 tick 〜次 tick に反映し、その後で通過し、向こうの区画へ入るのは開放の後
        expect(b.openedTick, tag).not.toBeNull();
        expect((b.openedTick as number) - b.destroyedTick, tag).toBeLessThanOrEqual(2);
        expect(b.passedTick, tag).not.toBeNull();
        expect(b.passSeconds as number, tag).toBeLessThan(4);
        const enter = r.sectorEnterTicks[b.nextSectorId as string];
        expect(enter, `${tag}: entered ${b.nextSectorId}`).toBeGreaterThanOrEqual(b.openedTick as number);
      });
      // 最後の隔壁 (B6) の撃破 = 6/6 でゲートも同時に開く
      const last = r.barriers[5];
      expect(r.gateOpenTick).toBe(last.openedTick);
    }
  });

  it('(g) the final gate stays closed at 5/6: the bot cannot enter the escape zone until the 6th control turret dies', () => {
    for (const lo of [WORST_LOADOUT, BEST_LOADOUT]) {
      const r = run({ loadout: lo, enemies: 'progressive', gateProbe: true });
      const label = `${loadoutKey(lo)} gate probe`;
      expectCleanClear(r, label);
      // B1..B5 は通常どおり通過済み (B6 の箱だけテストが無効にした)。最終ゲートだけが隔壁として止めた
      expect(r.barriers.map((b) => b.id), label).toEqual(['GATE']);
      const g = r.barriers[0];
      expect(g.controlId, label).toBe('T15');
      expect(g.before, label).toEqual({ controlsDestroyed: 5, gateOpen: false, mode: 'playing', inEscapeZone: false });
      expect(g.pushInto, label).toBeLessThan(1e-3);
      expect(g.gapToBarrier, label).toBeGreaterThan(-1e-3);
      expect(g.neverCrossedWhileClosed, label).toBe(true);
      expect(g.ram?.qbFired, label).toBe(true);
      expect(g.ram?.penetration as number, label).toBeLessThan(1e-3);
      expect(g.ram?.crossed, label).toBe(false);
      // 順序: ゲートの前で止まる → T15 撃破 → ゲート開放 → 脱出領域に入る → クリア。閉じている間は脱出領域に一度も入っていない
      expect(r.gateOpenTick as number, label).toBeGreaterThanOrEqual(g.destroyedTick);
      expect(r.escapeEnteredTick as number, label).toBeGreaterThan(r.gateOpenTick as number);
      expect(r.clearedTick, label).toBe(r.escapeEnteredTick);
      expect(r.sectorEnterTicks.S16 as number, label).toBeGreaterThanOrEqual(r.gateOpenTick as number);
      // escapeZone はゲートの向こう側 (最終ゲートより東)
      const gate = stage.barriers.find((b) => b.isFinal);
      expect(stage.escapeZone.min.x, label).toBeGreaterThan((gate?.pos.x ?? Infinity) + 1);
    }
  });

  it('(B) with all 45 enemies alive and attacking (player HP forced to 1e9 by the test) the bot still passes: never stuck, never falls, and is really being shot', () => {
    for (const lo of [WORST_LOADOUT, BEST_LOADOUT]) {
      const r = run({ loadout: lo, enemies: 'alive' });
      const label = `${loadoutKey(lo)} alive`;
      expectCleanClear(r, label);
      // 敵は生きている (制御砲台の 6 体だけを隔壁の手前で撃破)
      expect(r.killCount, label).toBe(6);
      expect(r.enemiesAlive, label).toBe(39);
      // 実際に敵の攻撃が飛んできて被弾している (AI・弾体・当たり判定が機能している)
      expect(r.enemyShotsFired, label).toBeGreaterThan(100);
      expect(r.playerHits, label).toBeGreaterThan(20);
      expect(r.damageTaken, label).toBeGreaterThan(300);
      expect(r.barriers.map((b) => b.id), label).toEqual(['B1', 'B2', 'B3', 'B4', 'B5', 'B6']);
      for (const b of r.barriers) {
        expect(b.pushInto, `${label} ${b.id}`).toBeLessThan(1e-3);
        expect(b.neverCrossedWhileClosed, `${label} ${b.id}`).toBe(true);
      }
    }
  });

  it('(h) QB-assisted run: QB is used (single 36 EN presses), EN is still enough for every climb, and it is faster than the plain glide run', () => {
    for (const lo of [WORST_LOADOUT, BEST_LOADOUT]) {
      const plain = run({ loadout: lo, enemies: 'dead' });
      const fast = run({ loadout: lo, enemies: 'dead', useQB: true });
      const label = `${loadoutKey(lo)} +QB`;
      expectCleanClear(fast, label);
      expect(fast.qbCount, label).toBeGreaterThan(5);
      expect(fast.gameSeconds, label).toBeLessThan(plain.gameSeconds - 5);
      expect(fast.gameSeconds, label).toBeGreaterThan(shortest / PLAYER.QB.SPEED);
    }
  });

  it('EN shortage before a climb is handled the way a player would: stop on the launch spot and wait for the EN to recharge (greedy QB run)', () => {
    const r = run({ loadout: WORST_LOADOUT, enemies: 'dead', useQB: true, qbReserve: 0, qbStopMargin: -10 });
    const label = 'greedy QB';
    expectCleanClear(r, label);
    expect(r.qbCount).toBeGreaterThan(10);
    expect(r.timeBreakdown.enWait, `${label}: some climb had to wait for EN`).toBeGreaterThan(0.5);
    for (const c of r.climbs) {
      // 待った後のENは、必要量 (飛行に要る分 + 余裕) 以上
      expect(c.enBefore, `${label} ${c.id}`).toBeGreaterThanOrEqual(Math.min(GENERATOR_PARTS.recovery.maxEn, 20 * (c.height / PLAYER.FLIGHT_ASCENT + 0.5) + 20) - 1e-6);
      expect(c.ok, `${label} ${c.id}`).toBe(true);
    }
  });

  it('other seeds change the enemies\' random aim but not the result', () => {
    for (const seed of [1, 4294967295]) {
      const r = runPlaythrough({ loadout: WORST_LOADOUT, enemies: 'alive', stage, seed });
      expectCleanClear(r, `alive seed ${seed}`);
      expect(r.playerHits).toBeGreaterThan(20);
    }
  });
});
