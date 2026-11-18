/**
 * 実ステージの警備30体の総当たり: 「射線を得て交戦 → プレイヤーが遮蔽の向こうへ逃げる → 警戒中の5秒間に0.5秒を超えて立ち止まらない」
 * (SPEC §2.3 「通路があるのに障害物へ押し付き続ける挙動は不可」 / 遮蔽後0.50秒以内に動き出す)。
 *
 * 監査テスト (audit-enemies-state) とは別の総当たり:
 *   警備ごと(単独で置く) x 交戦位置(方位・距離の異なる最大 POSITIONS 地点) x 逃げ先(遮蔽の向こうの地点を方位ごとに最大 ESCAPES 個 + 遠方へ消える)。
 *   プレイヤーは 24 m/s で逃げ先へ走る。射線を失った瞬間から5秒間、警戒中(alert かつ射線なし)に確認位置まで 4 m 超あって
 *   歩いて到達できる(止まった時点の現在位置から、その時点の確認位置への nav の経路がある)のに水平速度 0.3 m/s 未満で
 *   0.5 秒を超えて止まった試行を失敗とする (確認位置が壁に密着した位置などで歩いて立てない場合は失敗にしない: 参考値だけ集計)。
 * 実際の Game を tick 実行するだけで、AI の内部は「観測の補助」(確認位置・到達可否)にしか使わない。
 */
import { afterAll, describe, expect, it } from 'vitest';
import { ENEMIES, PLAYER, SIM } from '../src/config';
import { getEnemyAI } from '../src/sim/enemies';
import { Game } from '../src/sim/game';
import { getNav } from '../src/sim/nav';
import { buildStage } from '../src/stage';
import { ARENA_CLEAR } from '../src/stage/blueprint';
import type { EnemyState, StageDef, V3 } from '../src/sim/types';

const DT = SIM.DT;
const PH = PLAYER.HALF.y;
const REACT = ENEMIES.guard.reactSeconds;
/** 1つの警備あたりの交戦位置数 / 位置あたりの遮蔽の向こうの逃げ先数(方位ごとに1つ)。環境変数 AK2_NAV_POSITIONS / AK2_NAV_ESCAPES で増やして探索できる */
const POSITIONS = Number(process.env.AK2_NAV_POSITIONS ?? 12);
const ESCAPES = Number(process.env.AK2_NAV_ESCAPES ?? 6);
const RUN_SPEED = 24;
const OBSERVE_SECONDS = 5;

const REAL: StageDef = buildStage();
const GUARDS = REAL.enemies.filter((e) => e.kind === 'guard');

const hspeed = (v: V3): number => Math.hypot(v.x, v.z);

function teleport(g: Game, p: V3): void {
  const pl = g.state.player;
  pl.pos = { ...p };
  pl.prevPos = { ...p };
  pl.vel = { x: 0, y: 0, z: 0 };
}

function isoGame(sp: StageDef['enemies'][number]): Game {
  const g = new Game({ stage: { ...REAL, enemies: [sp] } });
  g.sortie();
  g.state.player.hp = 1e9;
  return g;
}

function muzzleOf(e: EnemyState): V3 {
  return { x: e.pos.x, y: e.pos.y + 0.4, z: e.pos.z };
}

/** 交戦位置の候補: 警備の周囲で、プレイヤーが立てる(足場・空間あり)射線の通る接地位置 (中心座標)。方位が60度以上離れたものを優先して n 個 */
function engagePositions(g: Game, e: EnemyState, n: number): V3[] {
  const nav = getNav(g.world, REAL);
  const m = muzzleOf(e);
  const all: { pos: V3; az: number }[] = [];
  for (let r = 20; r <= 72; r += 4) {
    for (let a = 0; a < 36; a++) {
      const az = ((a + (r % 8 === 0 ? 0.5 : 0)) / 36) * Math.PI * 2;
      const x = e.pos.x + Math.cos(az) * r;
      const z = e.pos.z + Math.sin(az) * r;
      for (const refY of [e.pos.y, e.pos.y - 6, e.pos.y - 12]) {
        const feet = nav.floorBelow(x, z, refY, 4);
        if (feet === null) continue;
        const pos = { x, y: feet + PH, z };
        if (g.world.overlapAABB(pos, { x: 0.8, y: 1.5, z: 0.8 }, 0.05)) continue;
        if (g.world.segmentBlocked(m, pos) || g.world.sweepSphere(m, pos, 0.2)) continue;
        all.push({ pos, az });
        break;
      }
    }
  }
  const picked: { pos: V3; az: number }[] = [];
  // 方位の分散を優先し (60度以上離す)、足りなければ間隔を緩める
  for (const minSep of [Math.PI / 3, Math.PI / 6, 0]) {
    for (const c of all) {
      if (picked.length >= n) break;
      if (picked.includes(c)) continue;
      if (picked.some((p) => Math.abs(Math.atan2(Math.sin(c.az - p.az), Math.cos(c.az - p.az))) < minSep)) continue;
      picked.push(c);
    }
  }
  return picked.map((p) => p.pos);
}

/** 交戦位置 from から見て遮蔽の向こう(警備の初期の銃口から射線が通らない)にある立てる位置。方位ごとに1つ、最大 n 個 */
function hiddenTargets(g: Game, e: EnemyState, from: V3, n: number): V3[] {
  const nav = getNav(g.world, REAL);
  const m = muzzleOf(e);
  const out: V3[] = [];
  for (let k = 0; k < n; k++) {
    const az = ((k + 0.37) / n) * Math.PI * 2;
    let found: V3 | null = null;
    for (const r of [8, 12, 17, 24, 32]) {
      const x = from.x + Math.cos(az) * r;
      const z = from.z + Math.sin(az) * r;
      const feet = nav.floorBelow(x, z, from.y - PH, 4);
      if (feet === null) continue;
      const pos = { x, y: feet + PH, z };
      if (g.world.overlapAABB(pos, { x: 0.8, y: 1.5, z: 0.8 }, 0.05)) continue;
      if (!g.world.segmentBlocked(m, pos)) continue; // 見えてしまう位置は遮蔽の向こうではない
      found = pos;
      break;
    }
    if (found) out.push(found);
  }
  return out;
}

interface Result {
  engaged: boolean;
  observed: boolean;
  /** 射線を失った直後の確認位置へ歩いて到達できた (nav の経路がある) */
  reachable: boolean;
  /** 到達可能な確認位置へ向かうべきなのに止まった最長秒数 (失敗の判定に使う) */
  worst: number;
  /** 上のうち、確認位置まで4m以内での停止 (到着) を含めた最長秒数 (参考) */
  worstIncludingArrival: number;
  /** 確認位置が(その時点で)歩いて到達できない場合の最長停止秒数 (参考: 失敗にはしない) */
  worstUnreachable: number;
  /** worstUnreachable の停止位置と確認位置までの距離 */
  unreachableAt: string;
  at: string;
  lost: boolean;
}

function runTrial(sp: StageDef['enemies'][number], from: V3, to: V3 | 'vanish'): Result {
  const g = isoGame(sp);
  const s = g.state;
  const e = s.enemies[0];
  const nav = getNav(g.world, REAL);
  const res: Result = { engaged: false, observed: false, reachable: false, worst: 0, worstIncludingArrival: 0, worstUnreachable: 0, unreachableAt: '', at: '', lost: false };
  teleport(g, from);
  for (let i = 0; i < 120; i++) {
    g.step();
    g.drainEvents();
  }
  if (!e.hasLineOfSight) return res;
  res.engaged = true;
  const ai = getEnemyAI(e)!;
  // 逃走: 逃げ先へ RUN_SPEED で走り続ける (遠方へ消える場合は即座に)。射線を失った最初のtickから観測を始める
  let cur: V3 = { ...from };
  let lostTick = -1;
  let still = 0;
  let stillAll = 0;
  let episodeReach: boolean | null = null;
  const maxRun = Math.ceil(3 / DT);
  for (let i = 0; i < maxRun + OBSERVE_SECONDS / DT + 2; i++) {
    if (to === 'vanish') cur = { x: 700, y: 25.5, z: 400 };
    else {
      const dx = to.x - cur.x;
      const dz = to.z - cur.z;
      const dy = to.y - cur.y;
      const d = Math.hypot(dx, dy, dz);
      const step = RUN_SPEED * DT;
      cur = d <= step ? { ...to } : { x: cur.x + (dx / d) * step, y: cur.y + (dy / d) * step, z: cur.z + (dz / d) * step };
    }
    teleport(g, cur);
    g.step();
    g.drainEvents();
    if (lostTick < 0) {
      if (!e.hasLineOfSight) {
        lostTick = i;
        res.lost = true;
        const lk = ai.lastKnownPos;
        res.reachable = lk ? nav.pathLength({ x: e.pos.x, y: ai.floorY, z: e.pos.z }, { x: lk.x, y: lk.y - PH, z: lk.z }) !== null : false;
      } else if (i >= maxRun) break; // 3秒走っても射線が切れなかった
      continue;
    }
    if (i - lostTick > OBSERVE_SECONDS / DT) break;
    res.observed = true;
    const lk = ai.lastKnownPos;
    const far = lk ? Math.hypot(lk.x - e.pos.x, lk.z - e.pos.z) > 4 : false;
    const standing = !e.hasLineOfSight && e.alert && hspeed(e.vel) < 0.3;
    if (standing) {
      stillAll++;
      if (far) still++;
      else still = 0;
    } else {
      stillAll = 0;
      still = 0; // 動いている / 射線を取り直した (交戦中の動きは別の試験の対象)
      episodeReach = null;
    }
    // 停止が0.5秒を超えた時点で、その時点の確認位置へ(現在位置から)歩いて到達できるかを1度だけ調べる
    if (standing && lk && episodeReach === null && Math.max(still, stillAll) * DT > REACT + 1e-9) {
      episodeReach = nav.pathLength({ x: e.pos.x, y: ai.floorY, z: e.pos.z }, { x: lk.x, y: lk.y - PH, z: lk.z }) !== null;
    }
    if (episodeReach === true) {
      if (stillAll * DT > res.worstIncludingArrival) res.worstIncludingArrival = stillAll * DT;
      if (still * DT > res.worst) {
        res.worst = still * DT;
        res.at = `(${e.pos.x.toFixed(1)}, ${e.pos.y.toFixed(1)}, ${e.pos.z.toFixed(1)}) t+${((i - lostTick) * DT).toFixed(2)}s`;
      }
    } else if (episodeReach === false && far && still * DT > res.worstUnreachable) {
      res.worstUnreachable = still * DT;
      res.unreachableAt = `(${e.pos.x.toFixed(1)}, ${e.pos.y.toFixed(1)}, ${e.pos.z.toFixed(1)}) 確認位置まで ${Math.hypot((lk as V3).x - e.pos.x, (lk as V3).z - e.pos.z).toFixed(1)}m`;
    }
  }
  return res;
}

interface Summary {
  trials: number;
  engaged: number;
  observed: number;
  reachableObserved: number;
  failures: number;
  arrivalStalls: number;
  unreachableStalls: number;
}
const total: Summary = { trials: 0, engaged: 0, observed: 0, reachableObserved: 0, failures: 0, arrivalStalls: 0, unreachableStalls: 0 };
const fmtTarget = (to: V3 | 'vanish'): string => (to === 'vanish' ? 'vanish' : `(${to.x.toFixed(0)},${to.z.toFixed(0)})`);

/** 警備 chunk の全試行を実行して集計する */
function bruteForce(chunk: StageDef['enemies']): { summary: Summary; failures: string[]; unreachableNotes: string[]; unobserved: string[] } {
  const summary: Summary = { trials: 0, engaged: 0, observed: 0, reachableObserved: 0, failures: 0, arrivalStalls: 0, unreachableStalls: 0 };
  const failures: string[] = [];
  const unreachableNotes: string[] = [];
  const observedPerGuard = new Map<string, number>();
  for (const sp of chunk) {
    const g0 = isoGame(sp);
    const e0 = g0.state.enemies[0];
    for (const from of engagePositions(g0, e0, POSITIONS)) {
      const targets: (V3 | 'vanish')[] = [...hiddenTargets(g0, e0, from, ESCAPES), 'vanish'];
      for (const to of targets) {
        summary.trials++;
        const r = runTrial(sp, from, to);
        if (!r.engaged) continue;
        summary.engaged++;
        if (!r.observed) continue;
        summary.observed++;
        observedPerGuard.set(sp.id, (observedPerGuard.get(sp.id) ?? 0) + 1);
        if (r.reachable) summary.reachableObserved++;
        if (r.worstIncludingArrival > REACT + 1e-9) summary.arrivalStalls++;
        if (r.worstUnreachable > REACT + 1e-9) {
          summary.unreachableStalls++;
          unreachableNotes.push(`${sp.id} 交戦(${from.x.toFixed(0)},${from.z.toFixed(0)}) 逃げ先${fmtTarget(to)}: ${r.worstUnreachable.toFixed(2)}秒 @${r.unreachableAt}`);
        }
        if (r.worst > REACT + 1e-9) {
          summary.failures++;
          failures.push(`${sp.id} 交戦(${from.x.toFixed(0)},${from.y.toFixed(1)},${from.z.toFixed(0)}) 逃げ先${fmtTarget(to)}: ${r.worst.toFixed(2)}秒停止 @${r.at}`);
        }
      }
    }
  }
  for (const k of Object.keys(summary) as (keyof Summary)[]) total[k] += summary[k];
  return { summary, failures, unreachableNotes, unobserved: chunk.filter((g) => !observedPerGuard.has(g.id)).map((g) => g.id) };
}

describe('実ステージの警備30体 x 交戦位置 x 逃げ先 の総当たり: 射線を失った後の5秒間に立ち止まらない', () => {
  // 警備を10体ずつ3つの it に分ける (1つの it が長くなりすぎないように)
  for (let i = 0; i < GUARDS.length; i += 10) {
    const chunk = GUARDS.slice(i, i + 10);
    it(`警備 ${chunk[0].id}..${chunk[chunk.length - 1].id} (${chunk.length}体): 失敗ゼロ、全員が観測された`, () => {
      const r = bruteForce(chunk);
      const s = r.summary;
      console.info(
        `[nav-stuck-real ${chunk[0].id}..${chunk[chunk.length - 1].id}] trials ${s.trials}, engaged ${s.engaged}, observed ${s.observed} (last-known reachable at loss: ${s.reachableObserved}), failures ${s.failures}; info: stalls that include arrival ${s.arrivalStalls}, stalls with an unreachable last-known ${s.unreachableStalls}` +
          `${r.failures.length > 0 ? `\n${r.failures.join('\n')}` : ''}${process.env.AK2_NAV_VERBOSE ? `\n[unreachable last-known stalls]\n${r.unreachableNotes.join('\n')}` : ''}`,
      );
      expect(r.failures, '到達可能な確認位置へ向かうべきなのに0.5秒を超えて止まった試行').toEqual([]);
      expect(r.unobserved, '1度も観測できなかった警備 (交戦位置が見つからない)').toEqual([]);
      expect(s.observed).toBeGreaterThanOrEqual(Math.min(150, POSITIONS * chunk.length));
      expect(s.reachableObserved).toBeGreaterThanOrEqual(Math.min(100, POSITIONS * chunk.length / 2));
    });
  }

  it('G28 (床の継ぎ目に沿う経路で止まっていた警備): 監査で再現した位置 (250, 436) に立ち、遠方へ消えても、床の縁に張り付かず動き続ける', () => {
    const sp = REAL.enemies.find((e) => e.id === 'G28')!;
    const g0 = isoGame(sp);
    const feet = getNav(g0.world, REAL).floorBelow(250, 436, 24, 4);
    expect(feet).toBe(24);
    const r = runTrial(sp, { x: 250, y: (feet as number) + PH, z: 436 }, 'vanish');
    expect(r.engaged).toBe(true);
    expect(r.observed).toBe(true);
    expect(r.reachable).toBe(true);
    expect(r.worst).toBeLessThanOrEqual(REACT + 1e-9);
    expect(r.worstIncludingArrival).toBeLessThanOrEqual(REACT + 1e-9);
  });

  afterAll(() => {
    console.info(
      `[nav-stuck-real total] guards ${GUARDS.length} x positions<=${POSITIONS} x escapes<=${ESCAPES}+vanish: trials ${total.trials}, engaged ${total.engaged}, observed ${total.observed} (last-known reachable at loss: ${total.reachableObserved}), failures ${total.failures}; info: stalls that include arrival ${total.arrivalStalls}, stalls with an unreachable last-known ${total.unreachableStalls}`,
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Game.warmup on the real stage (30 guards, ~110 000 nav nodes): the game must not notice whether it ran
// ---------------------------------------------------------------------------------------------------------------------
describe('実ステージの Game.warmup: 有無・分け方で出撃後の進行が完全に同一 (決定性)', () => {
  const S12 = ARENA_CLEAR.S12;
  const sec12 = REAL.sectors.find((s) => s.id === 'S12')!;
  const AT: V3 = { x: (S12.x0 + S12.x1) / 2, y: sec12.floorY + PH, z: (S12.z0 + S12.z1) / 2 };

  /** state without world / stage, AI internals (path, memory, timers) included */
  function signature(g: Game): string {
    const s = g.state;
    return JSON.stringify({
      tick: s.tick,
      rng: s.rng.getState(),
      hp: s.player.hp,
      damageTaken: s.damageTaken,
      enemies: s.enemies.map((e) => ({ id: e.id, pos: e.pos, vel: e.vel, yaw: e.yaw, alive: e.alive, alert: e.alert, los: e.hasLineOfSight, shots: e.shotsFired, telegraph: e.telegraph, ai: e.internal.ai })),
      bullets: s.enemyBullets.map((b) => [b.id, b.pos, b.vel, b.age]),
    });
  }
  function pin(g: Game): void {
    const p = g.state.player;
    p.hp = 1e9;
    p.pos = { ...AT };
    p.prevPos = { ...AT };
    p.vel = { x: 0, y: 0, z: 0 };
  }
  /** the player stands in S12 and the whole stage is alerted every second (the worst case for the planner: 30 big searches at once) */
  function playAlerted(g: Game, ticks: number): string[] {
    const sigs: string[] = [];
    for (let t = 0; t < ticks; t++) {
      if (t % 120 === 0) {
        for (const e of g.state.enemies) {
          const ai = getEnemyAI(e);
          if (e.kind !== 'guard' || !ai) continue;
          e.alert = true;
          ai.lastKnownPos = { ...AT };
          ai.lastSeenAt = g.state.time;
        }
      }
      pin(g);
      g.step();
      g.drainEvents();
      if (t % 30 === 0) sigs.push(signature(g));
    }
    sigs.push(signature(g));
    return sigs;
  }
  /** the player just stands in S12 (natural alerting: whoever sees him) */
  function playNatural(g: Game, ticks: number): string[] {
    const sigs: string[] = [];
    for (let t = 0; t < ticks; t++) {
      pin(g);
      g.step();
      g.drainEvents();
      if (t % 30 === 0) sigs.push(signature(g));
    }
    sigs.push(signature(g));
    return sigs;
  }
  function game(warm: 'none' | 'once' | 'sliced'): Game {
    const g = new Game({ stage: REAL });
    if (warm === 'once') expect(g.warmup()).toBe(true);
    else if (warm === 'sliced') while (!g.warmup(5000)) { /* idle-time slices */ }
    g.sortie();
    return g;
  }

  it('全警備を警戒させ続ける (1 tick の探索量の上限に当たり続ける最悪条件): warmup なし / 一括 / 分割で 1500 tick が同一', () => {
    const gc = game('none');
    const cold = playAlerted(gc, 1500);
    const once = playAlerted(game('once'), 1500);
    const sliced = playAlerted(game('sliced'), 1500);
    expect(cold.length).toBe(51);
    expect(once).toEqual(cold);
    expect(sliced).toEqual(cold);
    // guards really went after the player (not a trivial equality of idle guards)
    const moved = gc.state.enemies.filter((e) => e.kind === 'guard' && Math.hypot(e.pos.x - (getEnemyAI(e)?.home.x ?? e.pos.x), e.pos.z - (getEnemyAI(e)?.home.z ?? e.pos.z)) > 15);
    expect(moved.length).toBeGreaterThanOrEqual(5);
    expect(gc.state.enemies.some((e) => (getEnemyAI(e)?.path?.length ?? 0) > 2)).toBe(true);
  });

  it('警戒の自然な発生 (S12 に立つだけ): warmup の有無で 2400 tick が同一。実際に交戦している', () => {
    const gc = game('none');
    const cold = playNatural(gc, 2400);
    const gw = game('sliced');
    const warm = playNatural(gw, 2400);
    expect(warm).toEqual(cold);
    expect(gc.state.enemies.reduce((n, e) => n + e.shotsFired, 0)).toBeGreaterThan(20);
    expect(gc.state.enemies.filter((e) => e.alert).length).toBeGreaterThanOrEqual(3);
  });

  it('warmup 後は出撃直後の tick でも nav の flood-fill が残っていない (最初の tick から 1.6 秒間の 256 ノード/tick が要らない)', () => {
    const g = new Game({ stage: REAL });
    expect(g.warmup()).toBe(true);
    const nav = getNav(g.world, REAL);
    const cells = nav.stats().cells;
    expect(cells).toBeGreaterThan(50000);
    expect(nav.stats().queued).toBe(0);
    g.sortie();
    for (let t = 0; t < 30; t++) {
      pin(g);
      g.step();
    }
    expect(nav.stats().queued).toBe(0);
    expect(nav.stats().cells).toBeLessThan(cells * 1.02); // (a search may touch a few nodes next to the flooded region)
  });
});
