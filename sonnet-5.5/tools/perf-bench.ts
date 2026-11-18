/**
 * perf-bench: 実ステージ (buildStage()) 上の実際の Game の処理時間・メモリ・World クエリ数の計測 (Node, ヘッドレス)。
 *
 *   npx tsx tools/perf-bench.ts                 全項目を計測して表を表示
 *   npx tsx tools/perf-bench.ts --md docs/PLAYTHROUGH.md   docs/PLAYTHROUGH.md の性能の節 (<!-- BEGIN:perf --> .. <!-- END:perf -->) を更新
 *   npx tsx tools/perf-bench.ts --quick         試行回数を減らして短時間で確認
 *   npx tsx tools/perf-bench.ts --startup cold|warm [--trials N]   出撃直後の tick だけを計る (warmup なし / あり)。1 プロセス 1 構成で使う
 *        (試行 1 は JIT が冷えたプロセスの最初の出撃、以降は同じプロセスの再出撃。修正前後の比較は同じコマンドを両方のツリーで実行する)
 *   npx tsx tools/perf-bench.ts --nav [--trials N]   経路探索のスパイクだけを計る (全警備警戒の最悪条件 + ボット走破。--md は使わない)
 *
 * 計測項目 (1 tick = 1/120 s。予算は約 8.33 ms。描画1フレーム(60fps)で 2 tick 前後、閾値は 1 tick 4 ms):
 *   (i)   buildStage() の時間
 *   (ii)  new Game() と sortie() の時間、nav の構築: Game.warmup() (出撃前) と、warmup なし (遅延構築: 敵の初回 AI tick から flood-fill 完了まで)
 *   (iii) 戦闘区画 (S02/S05/S12/S13) の中央にプレイヤーを置き、その区画の敵が全員交戦している 1 tick の処理時間 (平均・p50・p99・最大)
 *         + 全警備ロボット警戒 (遠隔から追跡) + ボットの実走 (敵45体が生きている通し走破) の tick 時間
 *   (iv)  敵弾・MG弾・ミサイルを多数飛ばしたときの tick 時間
 *   (v)   60 s (7200 tick) 連続実行後の heapUsed の増加 (gc 後)
 *   (vi)  再出撃 10 回の時間とメモリ
 *   (vii) World のクエリ数 / tick と、tick の内訳 (どの処理が時間を食っているか)
 *
 * プレイヤーを戦闘区画に置く・弾を注入するのは「負荷の計測」のための状態書き換えで、走破テスト (tools/playthrough.ts) の禁止事項とは別。
 */
import os from 'node:os';
import { resolve } from 'node:path';
import { PerformanceObserver, performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import v8 from 'node:v8';
import vm from 'node:vm';
import { ENEMIES, PLAYER, SIM } from '../src/config';
import { updateCamera } from '../src/sim/camera';
import { enemyDecisionStep, enemyIntegrate, getEnemyAI, stepEnemyBullets } from '../src/sim/enemies';
import { updateFcs } from '../src/sim/fcs';
import { Game } from '../src/sim/game';
import { clone } from '../src/sim/math';
import { getNav } from '../src/sim/nav';
import type { Nav } from '../src/sim/nav';
import { updateProgress } from '../src/sim/objective';
import { playerBeginTick, playerIntegrate } from '../src/sim/player';
import { stepPlayerProjectiles } from '../src/sim/projectiles';
import type { EnemyBullet, GameState, Missile, PlayerBullet, StageDef, V3 } from '../src/sim/types';
import { playerFireStep, requestWeaponSwitch } from '../src/sim/weapons';
import { World } from '../src/sim/world';
import { buildStage } from '../src/stage';
import { ARENA_CLEAR } from '../src/stage/blueprint';
import { BEST_LOADOUT, WORST_LOADOUT, replaceSection, runPlaythrough } from './playthrough';

// ---------------------------------------------------------------------------------------------------------------------
// 統計・メモリ
// ---------------------------------------------------------------------------------------------------------------------
export interface Stat {
  n: number;
  min: number;
  mean: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
  /** 4 ms を超えた tick の割合 */
  over4: number;
  /** 8.33 ms(120Hz予算)を超えた tick の割合 */
  overBudget: number;
}
export function statOf(samples: ArrayLike<number>): Stat {
  const a = Array.from(samples).sort((x, y) => x - y);
  const n = a.length;
  const at = (q: number): number => a[Math.min(n - 1, Math.floor(q * n))];
  let sum = 0;
  let o4 = 0;
  let ob = 0;
  for (const v of a) {
    sum += v;
    if (v > 4) o4++;
    if (v > 1000 / SIM.HZ) ob++;
  }
  return { n, min: a[0], mean: sum / n, p50: at(0.5), p90: at(0.9), p99: at(0.99), max: a[n - 1], over4: o4 / n, overBudget: ob / n };
}

let gcFn: (() => void) | null = null;
function gc(): void {
  if (gcFn === null) {
    try {
      v8.setFlagsFromString('--expose-gc');
      gcFn = vm.runInNewContext('gc') as () => void;
    } catch {
      gcFn = () => {};
    }
  }
  gcFn();
  gcFn();
}
const heapMB = (): number => {
  gc();
  gc();
  return process.memoryUsage().heapUsed / 1048576;
};

// ---- GC の観測: 遅い tick が GC の停止と重なっているかを見る (GC のエントリは非同期に届く: 計測ループの後で await settleGc() する)
interface GcSpan {
  start: number;
  end: number;
}
const gcSpans: GcSpan[] = [];
const gcObserver = new PerformanceObserver((list) => {
  for (const e of list.getEntries()) gcSpans.push({ start: e.startTime, end: e.startTime + e.duration });
});
gcObserver.observe({ entryTypes: ['gc'] });
async function settleGc(): Promise<GcSpan[]> {
  await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setImmediate(r));
  return gcSpans.splice(0);
}
export interface TickSeries {
  ms: Float64Array;
  start: Float64Array;
}
export interface SpikeInfo {
  /** 4 ms を超えた tick の数 / そのうち GC の停止と重なっていた数 */
  over4: number;
  over4Gc: number;
  /** GC と重なっていない tick だけの最大 [ms] (OS のスケジューリングの揺れを含む) */
  maxNonGc: number;
  p99NonGc: number;
}
function spikeInfo(series: TickSeries, gcs: GcSpan[]): SpikeInfo {
  const nonGc: number[] = [];
  let over4 = 0;
  let over4Gc = 0;
  let gi = 0;
  for (let i = 0; i < series.ms.length; i++) {
    const a = series.start[i];
    const b = a + series.ms[i];
    while (gi < gcs.length && gcs[gi].end < a) gi++;
    let hit = false;
    for (let k = gi; k < gcs.length && gcs[k].start <= b; k++) if (gcs[k].end >= a) hit = true;
    if (series.ms[i] > 4) {
      over4++;
      if (hit) over4Gc++;
    }
    if (!hit) nonGc.push(series.ms[i]);
  }
  const st = statOf(nonGc.length ? nonGc : [0]);
  return { over4, over4Gc, maxNonGc: st.max, p99NonGc: st.p99 };
}

const f = (n: number, d = 3): string => (Number.isFinite(n) ? n.toFixed(d) : String(n));

// ---------------------------------------------------------------------------------------------------------------------
// 状態を固定してtickを計測するための補助
// ---------------------------------------------------------------------------------------------------------------------
interface Arena {
  id: string;
  /** 'center': ARENA_CLEAR の中心 / 'cross': その区画で最も多くの敵に射線が通る立ち位置 (区画の主床の上, 2 m 格子) */
  kind: 'center' | 'cross';
  label: string;
  center: V3;
  /** 立ち位置に射線が通る (射程内の) その区画の敵の数 */
  los: number;
}
function arenas(stage: StageDef): Arena[] {
  return ['S02', 'S05', 'S12', 'S13'].map((id) => {
    const r = ARENA_CLEAR[id];
    const sec = stage.sectors.find((s) => s.id === id);
    if (!r || !sec) throw new Error(`no arena ${id}`);
    return { id, kind: 'center', label: `${id} 中央`, center: { x: (r.x0 + r.x1) / 2, y: sec.floorY + PLAYER.HALF.y, z: (r.z0 + r.z1) / 2 }, los: 0 };
  });
}

/** 区画 id の敵のうち、主床の立ち位置 p に射程内で射線が通る数が最大の p (同数なら arena 中央に近いもの) */
function crossfirePoint(stage: StageDef, id: string, near: V3): { p: V3; los: number } {
  const world = new World(stage.boxes);
  const sec = stage.sectors.find((x) => x.id === id) as StageDef['sectors'][number];
  const es = stage.enemies.filter((e) => e.sectorId === id);
  const range = (k: string): number => ENEMIES[k as 'guard' | 'turret'].sensorRange;
  let best = { p: near, los: -1, d: Infinity };
  for (let x = sec.bounds.min.x + 4; x <= sec.bounds.max.x - 4; x += 2)
    for (let z = sec.bounds.min.z + 4; z <= sec.bounds.max.z - 4; z += 2) {
      const p = { x, y: sec.floorY + PLAYER.HALF.y, z };
      if (world.overlapAABB(p, PLAYER.HALF)) continue;
      const fl = world.raycast(p, { x: 0, y: -1, z: 0 }, 3);
      if (!fl || Math.abs(fl.point.y - sec.floorY) > 0.05) continue;
      let n = 0;
      for (const e of es) {
        const m = { x: e.pos.x, y: e.pos.y + 0.4, z: e.pos.z };
        if (Math.hypot(m.x - p.x, m.y - p.y, m.z - p.z) <= range(e.kind) && !world.segmentBlocked(m, p)) n++;
      }
      const d = Math.hypot(p.x - near.x, p.z - near.z);
      if (n > best.los || (n === best.los && d < best.d)) best = { p, los: n, d };
    }
  return { p: best.p, los: best.los };
}
function arenaScenarios(stage: StageDef): Arena[] {
  const centers = arenas(stage);
  const cross = centers.map((a): Arena => {
    const { p, los } = crossfirePoint(stage, a.id, a.center);
    return { id: a.id, kind: 'cross', label: `${a.id} 最大クロスファイア`, center: p, los };
  });
  return [...centers, ...cross];
}

/** プレイヤーを固定して(静止した標的として)1 tick 進める */
function pinnedStep(game: Game, at: V3): void {
  const p = game.state.player;
  p.hp = 1e9;
  p.pos = { ...at };
  p.vel = { x: 0, y: 0, z: 0 };
  game.step();
}

/** Game.warmup があれば (修正後のツリー) それを出撃前に呼ぶ。なければ何もしない (修正前のツリーでも同じ計測ができる) */
function warmupOf(g: Game): number | null {
  const w = (g as unknown as { warmup?: (maxWork?: number) => boolean }).warmup;
  if (typeof w !== 'function') return null;
  const t = performance.now();
  w.call(g);
  return performance.now() - t;
}

/** runBench の既定: シナリオの Game を出撃前に warmup するか (BenchOptions.warmup) */
let warmDefault = true;
/** warm = true: アプリと同じ経路 (出撃前に Game.warmup())。false: warmup なし (従来の遅延構築) */
function newGame(stage: StageDef, loadout = BEST_LOADOUT, warm = warmDefault): Game {
  const g = new Game({ stage, loadout });
  if (warm) warmupOf(g);
  g.sortie(loadout);
  return g;
}

/** nav の flood-fill が終わるまで (プレイヤーを固定して) 進める。戻り値: 掛かった tick 数と時間 */
function warmNav(game: Game, at: V3, maxTicks = 6000): { ticks: number; ms: number; cells: number; maxTickMs: number } {
  const t0 = performance.now();
  let ticks = 0;
  let maxTickMs = 0;
  const one = (): void => {
    const t = performance.now();
    pinnedStep(game, at);
    ticks++;
    if (ticks > 1) maxTickMs = Math.max(maxTickMs, performance.now() - t);
  };
  one(); // 最初の tick で nav が作られる (その時間は含めない: 別に計る)
  while (getNav(game.world, game.stage).stats().queued > 0 && ticks < maxTicks) one();
  return { ticks, ms: performance.now() - t0, cells: getNav(game.world, game.stage).stats().cells, maxTickMs };
}

/** nav の探索 1 回 (findPath 1 回 / PathJob 1 個の全 step の合計) または 1 step の時間 [ms] と、その間のノード展開数 */
interface NavCall {
  ms: number;
  exp: number;
}
interface NavProbe {
  /** 前回リセットしてからの nav の探索の合計時間 [ms] (呼び出し側が 0 に戻す) */
  tickMs: number;
  /** 探索 1 回ごと (修正前: findPath の呼び出し / 修正後: 完了した PathJob) */
  searches: NavCall[];
  /** 1 回の呼び出しごと (修正前: findPath の呼び出し / 修正後: job.step の呼び出し。これが 1 tick に載る探索の最小単位) */
  steps: NavCall[];
  restore(): void;
}
interface JobLike {
  step(budget: number): boolean;
}
/**
 * nav.findPath / pathLength と (あれば) beginPath の job.step の所要時間を測る。pathLength は内部で findPath を呼ぶので、
 * いちばん外側の呼び出しだけを数える。修正前のツリー (beginPath がない) でも同じ計測ができる。
 */
function probeNav(nav: Nav): NavProbe {
  const na = nav as unknown as Record<string, (...a: unknown[]) => unknown>;
  const p: NavProbe = { tickMs: 0, searches: [], steps: [], restore: () => {} };
  const orig: Record<string, (...a: unknown[]) => unknown> = {};
  let depth = 0;
  for (const k of ['findPath', 'pathLength']) {
    orig[k] = na[k];
    const fn = na[k].bind(nav);
    na[k] = (...args: unknown[]) => {
      const outer = depth === 0;
      depth++;
      const e0 = nav.stats().expansions;
      const t = performance.now();
      const r = fn(...args);
      const ms = performance.now() - t;
      depth--;
      if (outer) {
        p.tickMs += ms;
        if (k === 'findPath') {
          const rec = { ms, exp: nav.stats().expansions - e0 };
          p.searches.push(rec);
          p.steps.push(rec);
        }
      }
      return r;
    };
  }
  if (typeof na.beginPath === 'function') {
    orig.beginPath = na.beginPath;
    const bp = na.beginPath.bind(nav);
    na.beginPath = (...args: unknown[]) => {
      const job = bp(...args) as JobLike;
      const step = job.step.bind(job);
      let ms = 0;
      let exp = 0;
      job.step = (budget: number) => {
        const e0 = nav.stats().expansions;
        const t = performance.now();
        const done = step(budget);
        const d = performance.now() - t;
        const de = nav.stats().expansions - e0;
        p.tickMs += d;
        p.steps.push({ ms: d, exp: de });
        ms += d;
        exp += de;
        if (done) p.searches.push({ ms, exp });
        return done;
      };
      return job;
    };
  }
  p.restore = () => {
    for (const k of Object.keys(orig)) na[k] = orig[k];
  };
  return p;
}

/**
 * 出撃直後の tick の計測: 新しい Game で n 回 (warm = 出撃前に Game.warmup())。出撃後 240 tick (2 秒) を、プレイヤーを開始位置に固定して進める。
 * 修正前のツリー (Game.warmup がない) では warm = true でも warmup は呼ばれず、warmupMs は null になる。
 */
function startupTrials(stage: StageDef, warm: boolean, n: number): Startup {
  const first: number[] = [];
  const afterMax: number[] = [];
  const warmMs: number[] = [];
  let afterOver4 = 0;
  for (let i = 0; i < n; i++) {
    const g = new Game({ stage, loadout: BEST_LOADOUT });
    if (warm) {
      const ms = warmupOf(g);
      if (ms !== null) warmMs.push(ms);
    }
    g.sortie(BEST_LOADOUT);
    let t = performance.now();
    pinnedStep(g, stage.playerStart.pos);
    first.push(performance.now() - t);
    let mx = 0;
    for (let k = 1; k < 240; k++) {
      t = performance.now();
      pinnedStep(g, stage.playerStart.pos);
      const d = performance.now() - t;
      mx = Math.max(mx, d);
      if (d > 4) afterOver4++;
      if ((k & 1) === 1) g.drainEvents();
    }
    afterMax.push(mx);
    if (first[first.length - 1] > 4) afterOver4++;
  }
  // warmup を 1024 単位に分けた呼び出し (アプリが格納庫の空き時間に行う分け方)
  let slices: Startup['slices'] = null;
  if (warm && warmMs.length > 0) {
    const g = new Game({ stage, loadout: BEST_LOADOUT });
    const w = (g as unknown as { warmup: (maxWork?: number) => boolean }).warmup.bind(g);
    let maxMs = 0;
    let totalMs = 0;
    let calls = 0;
    for (let done = false; !done; calls++) {
      const t = performance.now();
      done = w(1024);
      const d = performance.now() - t;
      maxMs = Math.max(maxMs, d);
      totalMs += d;
    }
    slices = { maxMs, calls, totalMs };
  }
  return { firstTick: statOf(first), firstOfProcess: first[0], after: statOf(afterMax), afterOver4, firstRaw: first, afterMaxRaw: afterMax, warmupMs: warmMs.length > 0 ? statOf(warmMs) : null, slices };
}

/** state の中身を1 tick 分の処理ごとに時間を測りながら進める (Game.step と同じ順序。互換性は checkReplica で確認する) */
const PARTS = ['weapon-switch', 'player-begin', 'player-fire', 'enemy-decision', 'player-integrate', 'enemy-integrate', 'player-projectiles', 'enemy-bullets', 'post(camera+fcs+progress)'] as const;
function profiledStep(game: Game, acc: Float64Array): void {
  const s = game.state;
  const w = game.world;
  if (s.mode !== 'playing') return;
  let t = performance.now();
  const lap = (i: number): void => {
    const n = performance.now();
    acc[i] += n - t;
    t = n;
  };
  requestWeaponSwitch(s);
  lap(0);
  playerBeginTick(s);
  lap(1);
  playerFireStep(s, w);
  lap(2);
  enemyDecisionStep(s, w);
  lap(3);
  s.player.prevPos = clone(s.player.pos);
  for (const e of s.enemies) e.prevPos = clone(e.pos);
  playerIntegrate(s, w);
  lap(4);
  enemyIntegrate(s, w);
  lap(5);
  stepPlayerProjectiles(s, w);
  lap(6);
  stepEnemyBullets(s, w);
  lap(7);
  s.tick += 1;
  s.time = s.tick * SIM.DT;
  for (const e of s.enemies) if (e.hitFlash > 0) e.hitFlash = Math.max(0, e.hitFlash - SIM.DT);
  updateCamera(s, w);
  updateFcs(s, w, SIM.DT);
  updateProgress(s);
  lap(8);
}

/** profiledStep が Game.step と同じ結果になること (同じ入力・同じシードで 600 tick 後の状態が一致) */
function checkReplica(stage: StageDef, at: V3): boolean {
  const a = newGame(stage);
  const b = newGame(stage);
  const acc = new Float64Array(PARTS.length);
  for (let i = 0; i < 600; i++) {
    for (const g of [a, b]) {
      g.state.player.hp = 1e9;
      g.state.player.pos = { ...at };
      g.state.player.vel = { x: 0, y: 0, z: 0 };
    }
    a.step();
    profiledStep(b, acc);
  }
  const sig = (g: Game): string =>
    JSON.stringify({
      tick: g.state.tick,
      hp: g.state.damageTaken,
      e: g.state.enemies.map((e) => [e.pos.x, e.pos.y, e.pos.z, e.shotsFired, e.alert, e.hasLineOfSight]),
      eb: g.state.enemyBullets.length,
    });
  return sig(a) === sig(b);
}

// ---------------------------------------------------------------------------------------------------------------------
// 弾の注入 (弾数を増やしたときの1 tick あたりの処理時間の計測用)
// ---------------------------------------------------------------------------------------------------------------------
function makeRng(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (x + 0x6d2b79f5) >>> 0;
    let t = x;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function injectEnemyBullets(s: GameState, n: number, around: V3, rnd: () => number): void {
  while (s.enemyBullets.length < n) {
    const a = rnd() * Math.PI * 2;
    const r = 15 + rnd() * 60;
    const pos = { x: around.x + Math.cos(a) * r, y: around.y + (rnd() - 0.5) * 8, z: around.z + Math.sin(a) * r };
    // プレイヤーへ向けて撃つ(ただし当たり判定の外を通る向きにずらして、寿命いっぱい飛ばす)
    const dx = around.x - pos.x + (rnd() - 0.5) * 30;
    const dz = around.z - pos.z + (rnd() - 0.5) * 30;
    const dy = (rnd() - 0.5) * 6;
    const l = Math.hypot(dx, dy, dz) || 1;
    const sp = 60 + rnd() * 10;
    const b: EnemyBullet = {
      id: s.nextProjectileId++,
      ownerId: 'G01',
      kind: 'guard',
      pos,
      prevPos: { ...pos },
      vel: { x: (dx / l) * sp, y: (dy / l) * sp, z: (dz / l) * sp },
      age: 0,
      maxLife: 2,
      damage: 0,
      radius: 0.2,
      alive: true,
    };
    s.enemyBullets.push(b);
  }
}
function injectMgBullets(s: GameState, n: number, from: V3, rnd: () => number): void {
  while (s.bullets.length < n) {
    const a = rnd() * Math.PI * 2;
    const v0 = { x: Math.cos(a) * 100, y: (rnd() - 0.3) * 30, z: Math.sin(a) * 100 };
    const b: PlayerBullet = { id: s.nextProjectileId++, pos: { ...from }, prevPos: { ...from }, origin: { ...from }, v0, age: 0, damage: 12, alive: true };
    s.bullets.push(b);
  }
}
function injectMissiles(s: GameState, n: number, from: V3, rnd: () => number): void {
  const targets = s.enemies.filter((e) => e.alive);
  while (s.missiles.length < n && targets.length > 0) {
    const t = targets[Math.floor(rnd() * targets.length)];
    const a = rnd() * Math.PI * 2;
    const m: Missile = {
      id: s.nextProjectileId++,
      pos: { ...from },
      prevPos: { ...from },
      vel: { x: Math.cos(a) * 45, y: 0, z: Math.sin(a) * 45 },
      age: 0,
      life: 4,
      damage: 180,
      targetId: t.id,
      lastSeenPos: { ...t.pos },
      lastSeenVel: { x: 0, y: 0, z: 0 },
      lastSeenAt: s.time,
      alive: true,
    };
    s.missiles.push(m);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// 計測
// ---------------------------------------------------------------------------------------------------------------------
export interface BenchOptions {
  quick?: boolean;
  log?: (s: string) => void;
  /** false: 出撃前の Game.warmup() を呼ばない (従来の遅延構築)。既定は呼ぶ (アプリと同じ) */
  warmup?: boolean;
  /** 'nav': 経路探索のスパイクの計測 (全警備警戒 + ボット走破) だけを行う */
  only?: 'nav';
}

interface Scenario {
  /** 全試行の tick を合算した統計 (OS のスケジューリングの揺れ・GC を含む生の値) */
  stat: Stat;
  spikes: SpikeInfo;
  /**
   * 同じ入力・同じシードの決定的な試行を複数回行い、tick ごとに試行間の最小を取った統計。
   * 同じ tick は毎回同じ仕事をするので、最小は OS の揺れ・GC を除いた「その tick の処理コスト」に近い
   * (試行が 1 回だけのときは stat と同じ)。
   */
  stable: Stat;
  passes: number;
}

/** 出撃直後の tick (warmup なし = 遅延構築 / あり = アプリと同じ出撃前の Game.warmup) */
export interface Startup {
  /** 出撃後の最初の tick [ms] (試行間の統計) と、最初の試行 (このプロセスで最初の出撃: JIT が冷えている) の値 */
  firstTick: Stat;
  firstOfProcess: number;
  /** 出撃後 2..240 番目の tick の最大 [ms] (試行ごとの最大の統計) と、4 ms を超えた tick の数 (全試行の合計) */
  after: Stat;
  afterOver4: number;
  /** 試行ごとの生の値 (最初の tick / 2..240 番目の tick の最大) */
  firstRaw: number[];
  afterMaxRaw: number[];
  /** Game.warmup() の所要 [ms] (一括) の統計。warmup なしは null (Game.warmup がない修正前のツリーも null) */
  warmupMs: Stat | null;
  /** 出撃前の warmup を 1024 単位の呼び出しに分けたときの 1 呼び出しの最大 [ms] / 呼び出し回数 / 合計 [ms] */
  slices: { maxMs: number; calls: number; totalMs: number } | null;
}

export interface PerfReport {
  env: { node: string; cpu: string; cores: number; loadavg: number[]; date: string };
  buildStage: { firstMs: number; stat: Stat };
  gameInit: { newGame: Stat; sortie: Stat; navWarm: { ticks: number; ms: number; cells: number; maxTickMs: number }; cold: Startup; warm: Startup | null };
  replicaOk: boolean;
  arenas: (Scenario & { id: string; kind: 'center' | 'cross'; label: string; center: V3; posLos: number; enemiesInLos: number; enemiesAlert: number; bulletsMax: number; parts: number[]; partsMax: number[]; shots: number })[];
  allAlert: Scenario & {
    alertGuards: number;
    parts: number[];
    nav: {
      queriesPerTick: number;
      expansionsPerTick: number;
      /** 探索の回数と 1 回の所要時間 (修正前: findPath の呼び出し / 修正後: 完了した PathJob の全 step の合計) */
      findPathCalls: number;
      findPathMsMean: number;
      findPathMsP99: number;
      findPathMsMax: number;
      findPathExpMax: number;
      /** 1 回の呼び出し (修正前: findPath / 修正後: job.step) の回数と所要時間: 1 tick に載る探索の最小単位 */
      stepCalls: number;
      stepMsP99: number;
      stepMsMax: number;
      /** 1 tick に占める nav の探索時間 (その tick の全呼び出しの合計) */
      tickNavMsP99: number;
      tickNavMsMax: number;
      /** 計画の待ち時間 [tick]: 経路を要求してから受け取るまで (n = 計画の回数)。取れなければ null */
      latencyTicks: { n: number; p50: number; p90: number; max: number } | null;
    };
    /** 4 ms を超えた tick (最初の試行) の数と、そのうち nav の探索が tick 時間の半分以上だったものの数 */
    over4First: number;
    over4DueToPath: number;
    pathMsPerTickMean: number;
  };
  botAlive: Scenario & {
    firstTickMs: number;
    bySector: { id: string; n: number; mean: number; p99: number; max: number }[];
    spikeByPart: { part: string; count: number }[];
    over4First: number;
    over4Path: number;
    slowest: { ms: number; sector: string | null; tick: number; part: string; partMs: number; pathMs: number }[];
  };
  bullets: (Scenario & { label: string; enemyBullets: number; mg: number; missiles: number })[];
  natural: Scenario & { label: string; enemyBulletsMax: number; enemyBulletsMean: number; mgMax: number };
  leak: { seconds: number; ticks: number; samples: { t: number; heapMB: number }[]; slopeMBPerMin: number; growthMB: number; entities: { bullets: number; enemyBullets: number; events: number } };
  resortie: { n: number; ms: number[]; heapMB: number[]; ticksAfter: number };
  queries: { label: string; perTick: Record<string, number>; total: number; nav: { queriesPerTick: number; expansionsPerTick: number } }[];
  flags: string[];
}

function timeTicks(game: Game, n: number, at: V3, pre?: (i: number) => void): TickSeries {
  const ms = new Float64Array(n);
  const start = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (pre) pre(i);
    const p = game.state.player;
    p.hp = 1e9;
    p.pos = { ...at };
    p.vel = { x: 0, y: 0, z: 0 };
    const t = performance.now();
    game.step();
    const e = performance.now();
    start[i] = t;
    ms[i] = e - t;
    if ((i & 1) === 1) game.drainEvents();
  }
  return { ms, start };
}

/** 計測: series を集計し、GC との重なりを付ける */
function scenarioOf(series: TickSeries[], gcs: GcSpan[]): Scenario {
  const all: number[] = [];
  let over4 = 0;
  let over4Gc = 0;
  let maxNonGc = 0;
  let p99NonGc = 0;
  for (const s of series) {
    for (const v of s.ms) all.push(v);
  }
  for (const s of series) {
    const sp = spikeInfo(s, gcs);
    over4 += sp.over4;
    over4Gc += sp.over4Gc;
    maxNonGc = Math.max(maxNonGc, sp.maxNonGc);
    p99NonGc = Math.max(p99NonGc, sp.p99NonGc);
  }
  return { stat: statOf(all), spikes: { over4, over4Gc, maxNonGc, p99NonGc }, stable: stableOf(series), passes: series.length };
}

/** 試行ごとの「tick x 処理」の時間 (Float64Array(n * PARTS.length)) から、tick ごとに試行間の最小を取った平均と最大 [ms/tick] */
function stableParts(passes: Float64Array[], n: number): { mean: number[]; max: number[] } {
  const k = PARTS.length;
  const mean = new Array<number>(k).fill(0);
  const max = new Array<number>(k).fill(0);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < k; j++) {
      let m = Infinity;
      for (const ps of passes) m = Math.min(m, ps[i * k + j]);
      mean[j] += m / n;
      if (m > max[j]) max[j] = m;
    }
  return { mean, max };
}

function stableOf(series: TickSeries[]): Stat {
  const n = series[0].ms.length;
  if (series.length < 2 || series.some((x) => x.ms.length !== n)) return statOf(series[0].ms);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let m = Infinity;
    for (const x of series) if (x.ms[i] < m) m = x.ms[i];
    out[i] = m;
  }
  return statOf(out);
}

export async function runBench(stageArg: StageDef | null, opt: BenchOptions = {}): Promise<PerfReport> {
  let stage: StageDef = stageArg ?? (undefined as unknown as StageDef);
  const log = opt.log ?? ((s: string) => console.log(s));
  const q = !!opt.quick;
  warmDefault = opt.warmup !== false;
  const navOnly = opt.only === 'nav';
  const flags: string[] = [];
  const cpus = os.cpus();
  const rep = {} as PerfReport;
  rep.env = { node: process.version, cpu: cpus[0]?.model ?? '?', cores: cpus.length, loadavg: os.loadavg().map((x) => Math.round(x * 10) / 10), date: new Date().toISOString() };

  // (i) buildStage
  {
    log('(i) buildStage()');
    const times: number[] = [];
    let first = 0;
    for (let i = 0; i < (q ? 4 : 12); i++) {
      const t = performance.now();
      const built = buildStage();
      const dt = performance.now() - t;
      if (!stage) stage = built;
      if (i === 0) first = dt;
      else times.push(dt);
    }
    rep.buildStage = { firstMs: first, stat: statOf(times) };
  }

  // (ii) new Game / sortie / nav
  const ar = arenas(stage);
  const scen = navOnly ? [] : arenaScenarios(stage);
  if (!navOnly) {
    log('(ii) new Game() / sortie() / nav');
    const ng: number[] = [];
    const so: number[] = [];
    for (let i = 0; i < (q ? 4 : 10); i++) {
      let t = performance.now();
      const g = new Game({ stage, loadout: BEST_LOADOUT });
      ng.push(performance.now() - t);
      t = performance.now();
      g.sortie(BEST_LOADOUT);
      so.push(performance.now() - t);
    }
    // 出撃直後 (プレイヤーは開始位置) の最初の tick と、その後 2 秒: warmup なし (nav の生成と全敵の AI 初期化を含む) / あり。新しい Game で 5 回ずつ
    const cold = startupTrials(stage, false, 5);
    const warm = startupTrials(stage, true, 5);
    const g = newGame(stage, BEST_LOADOUT, false);
    const navWarm = warmNav(g, stage.playerStart.pos);
    rep.gameInit = { newGame: statOf(ng), sortie: statOf(so), navWarm, cold, warm: warm.warmupMs === null ? null : warm };
  }

  log('  replica check (profiledStep == Game.step)');
  rep.replicaOk = checkReplica(stage, ar[2].center);
  if (!rep.replicaOk) flags.push('profiledStep が Game.step と一致しない (内訳の数値は参考値)');

  // (iii) arenas
  rep.arenas = [];
  for (const a of scen) {
    log(`(iii) arena ${a.label}`);
    const series: TickSeries[] = [];
    const gcAll: GcSpan[] = [];
    let losMax = 0;
    let alertMax = 0;
    let bulletsMax = 0;
    let shots = 0;
    const partPasses: Float64Array[] = [];
    const NP = 1200;
    const passes = q ? 1 : 3;
    for (let pass = 0; pass < passes; pass++) {
      const g = newGame(stage);
      warmNav(g, a.center);
      for (let i = 0; i < (q ? 480 : 960); i++) pinnedStep(g, a.center); // 全員が警戒・交戦に入るまで
      const shots0 = g.state.enemies.reduce((n, e) => n + e.shotsFired, 0);
      await settleGc();
      series.push(
        timeTicks(g, q ? 1200 : 3000, a.center, () => {
          losMax = Math.max(losMax, g.state.enemies.filter((e) => e.hasLineOfSight).length);
          alertMax = Math.max(alertMax, g.state.enemies.filter((e) => e.alert).length);
          bulletsMax = Math.max(bulletsMax, g.state.enemyBullets.length);
        }),
      );
      gcAll.push(...(await settleGc()));
      shots += g.state.enemies.reduce((n, e) => n + e.shotsFired, 0) - shots0;
      // 内訳 (同じ状態からさらに 1200 tick)
      const pt = new Float64Array(NP * PARTS.length);
      for (let i = 0; i < NP; i++) {
        const p = g.state.player;
        p.hp = 1e9;
        p.pos = { ...a.center };
        p.vel = { x: 0, y: 0, z: 0 };
        const one = new Float64Array(PARTS.length);
        profiledStep(g, one);
        pt.set(one, i * PARTS.length);
        if ((i & 1) === 1) g.drainEvents();
      }
      partPasses.push(pt);
    }
    const sp = stableParts(partPasses, NP);
    const parts = sp.mean;
    const partsMax = sp.max;
    const sc = scenarioOf(series, gcAll);
    rep.arenas.push({ id: a.id, kind: a.kind, label: a.label, center: a.center, posLos: a.los, ...sc, enemiesInLos: losMax, enemiesAlert: alertMax, bulletsMax, parts, partsMax, shots });
    if (sc.stable.p99 > 4) flags.push(`${a.label}: p99 ${f(sc.stable.p99)} ms (> 4 ms)`);
    if (sc.stable.max > 4) flags.push(`${a.label}: 1 tick の最大 ${f(sc.stable.max)} ms (> 4 ms。生の最大 ${f(sc.stat.max)} ms)`);
  }

  // (iii-b) all guards alert
  {
    log('(iii) all guards alert (chasing from afar)');
    const at = ar[2].center;
    const passes = q ? 1 : 3;
    const n = q ? 1200 : 3600;
    const seriesAll: TickSeries[] = [];
    const gcAlert: GcSpan[] = [];
    let first: { pathMs: Float64Array; searches: NavCall[]; steps: NavCall[]; navQ: number; navE: number; alertGuards: number; latency: number[] } | null = null;
    const partPassesAlert: Float64Array[] = [];
    const NPA = 1200;
    for (let pass = 0; pass < passes; pass++) {
      const g = newGame(stage);
      warmNav(g, at);
      const alertAll = (): void => {
        const st = g.state;
        for (const e of st.enemies) {
          if (e.kind !== 'guard' || !e.alive) continue;
          const ai = getEnemyAI(e);
          if (!ai) continue;
          e.alert = true;
          ai.lastKnownPos = { ...at };
          ai.lastSeenAt = st.time;
        }
      };
      // nav の探索 (findPath / pathLength / 修正後の beginPath の job.step) の所要時間を tick ごとに集める (AI が nav 越しに呼ぶ)
      const nav = getNav(g.world, g.stage);
      const probe = probeNav(nav);
      const s0 = nav.stats();
      const pathMs = new Float64Array(n);
      // 計画の待ち時間: 経路を要求してから (ai.pathAt が変わる) 受け取るまで (ai.nextPlanAt が変わる) の tick 数。AI の内部の観測だけに使う
      const watch = new Map<unknown, { pathAt: number; nextPlanAt: number; since: number | null }>();
      const latency: number[] = [];
      const observeLatency = (i: number): void => {
        for (const e of g.state.enemies) {
          const ai = e.kind === 'guard' ? getEnemyAI(e) : undefined;
          if (!ai) continue;
          let w = watch.get(ai);
          if (!w) watch.set(ai, (w = { pathAt: ai.pathAt, nextPlanAt: ai.nextPlanAt, since: null }));
          if (ai.pathAt !== w.pathAt && w.since === null) w.since = i;
          if (ai.nextPlanAt !== w.nextPlanAt && ai.nextPlanAt > g.state.time && w.since !== null) {
            latency.push(i - w.since);
            w.since = null;
          }
          w.pathAt = ai.pathAt;
          w.nextPlanAt = ai.nextPlanAt;
        }
      };
      await settleGc();
      const series = timeTicks(g, n, at, (i) => {
        if (i % 60 === 0) alertAll();
        if (i > 0) {
          pathMs[i - 1] = probe.tickMs;
          observeLatency(i);
        }
        probe.tickMs = 0;
      });
      pathMs[n - 1] = probe.tickMs;
      gcAlert.push(...(await settleGc()));
      const s1 = nav.stats();
      probe.restore();
      seriesAll.push(series);
      // 内訳 (同じ状態からさらに 1200 tick)
      const pt = new Float64Array(NPA * PARTS.length);
      for (let i = 0; i < NPA; i++) {
        if (i % 60 === 0) alertAll();
        const p = g.state.player;
        p.hp = 1e9;
        p.pos = { ...at };
        p.vel = { x: 0, y: 0, z: 0 };
        const one = new Float64Array(PARTS.length);
        profiledStep(g, one);
        pt.set(one, i * PARTS.length);
        if ((i & 1) === 1) g.drainEvents();
      }
      partPassesAlert.push(pt);
      if (pass === 0) {
        const alertGuards = g.state.enemies.filter((e) => e.kind === 'guard' && e.alert).length;
        first = { pathMs, searches: probe.searches, steps: probe.steps, navQ: (s1.queries - s0.queries) / n, navE: (s1.expansions - s0.expansions) / n, alertGuards, latency };
      }
    }
    const f0 = first as NonNullable<typeof first>;
    const sc = scenarioOf(seriesAll, gcAlert);
    // 4 ms を超えた tick (最初の試行) のうち nav の探索が半分以上を占めたもの
    let over4Path = 0;
    let over4First = 0;
    for (let i = 0; i < n; i++)
      if (seriesAll[0].ms[i] > 4) {
        over4First++;
        if (f0.pathMs[i] >= seriesAll[0].ms[i] * 0.5) over4Path++;
      }
    const pc = statOf(f0.searches.map((c) => c.ms).concat(f0.searches.length ? [] : [0]));
    const ps = statOf(f0.steps.map((c) => c.ms).concat(f0.steps.length ? [] : [0]));
    const pt = statOf(f0.pathMs);
    rep.allAlert = {
      ...sc,
      alertGuards: f0.alertGuards,
      parts: stableParts(partPassesAlert, NPA).mean,
      nav: {
        queriesPerTick: f0.navQ,
        expansionsPerTick: f0.navE,
        findPathCalls: f0.searches.length,
        findPathMsMean: pc.mean,
        findPathMsP99: pc.p99,
        findPathMsMax: pc.max,
        findPathExpMax: f0.searches.reduce((mx, c) => Math.max(mx, c.exp), 0),
        stepMsMax: ps.max,
        stepMsP99: ps.p99,
        tickNavMsP99: pt.p99,
        tickNavMsMax: pt.max,
        stepCalls: f0.steps.length,
        latencyTicks: f0.latency.length > 0 ? { n: f0.latency.length, p50: statOf(f0.latency).p50, p90: statOf(f0.latency).p90, max: statOf(f0.latency).max } : null,
      },
      over4DueToPath: over4Path,
      over4First,
      pathMsPerTickMean: f0.pathMs.reduce((x, y) => x + y, 0) / n,
    };
    if (sc.stable.p99 > 4) flags.push(`全警備ロボット警戒 (人為的な最悪条件): p99 ${f(sc.stable.p99)} ms (> 4 ms。生の p99 ${f(sc.stat.p99)} ms)。4ms超の tick ${over4First} 個のうち ${over4Path} 個は nav の探索が tick 時間の半分以上を占めた`);
    if (sc.stable.max > 4) flags.push(`全警備ロボット警戒 (人為的な最悪条件): 1 tick の最大 ${f(sc.stable.max)} ms (> 4 ms。生の最大 ${f(sc.stat.max)} ms)。nav の探索 1 回の最大 ${f(pc.max)} ms (${rep.allAlert.nav.findPathExpMax} ノード展開)、1 tick に占める探索時間の最大 ${f(pt.max)} ms`);
  }

  // (iii-c) bot playthrough with every enemy alive
  {
    log('(iii) bot playthrough, 45 enemies alive');
    const passes = q ? 1 : 3;
    const seriesAll: TickSeries[] = [];
    const gcBot: GcSpan[] = [];
    interface BotPass {
      ms: number[];
      sectors: (string | null)[];
      ticks: number[];
      partsList: Float64Array[];
      pathList: number[];
    }
    const runs: BotPass[] = [];
    let cleared = true;
    let failure: string | null = null;
    for (let pass = 0; pass < passes; pass++) {
      const cur: BotPass = { ms: [], sectors: [], ticks: [], partsList: [], pathList: [] };
      const starts: number[] = [];
      let probe: NavProbe | null = null;
      let warmupMs = 0;
      await settleGc();
      const r = runPlaythrough({
        loadout: WORST_LOADOUT,
        enemies: 'alive',
        stage,
        // Game.step と同じ順序の複製で、処理ごとの時間と nav 探索の時間を取る (複製は checkReplica で Game.step と一致を確認済み)
        stepFn: (g) => {
          if (probe === null) {
            // アプリと同じく、最初の tick の前に Game.warmup() を済ませる (runPlaythrough は sortie 直後に最初の stepFn を呼ぶ。warmup は状態に触れない)。
            // 最初の tick の時間から warmup の分は引く。修正前のツリーでは warmup はなく、何もしない
            if (opt.warmup !== false) warmupMs = warmupOf(g) ?? 0;
            probe = probeNav(getNav(g.world, g.stage));
          }
          const one = new Float64Array(PARTS.length);
          profiledStep(g, one);
          cur.partsList.push(one);
          cur.pathList.push(probe.tickMs);
          probe.tickMs = 0;
        },
        tickTimer: (t, st) => {
          const ms = cur.ms.length === 0 ? t - warmupMs : t;
          cur.ms.push(ms);
          starts.push(performance.now() - ms);
          cur.sectors.push(st.progress.currentSectorId);
          cur.ticks.push(st.tick);
        },
      });
      (probe as NavProbe | null)?.restore();
      gcBot.push(...(await settleGc()));
      cleared &&= r.cleared;
      if (!r.cleared) failure = r.failure;
      runs.push(cur);
      // 最初の tick は nav の生成を含むので別に扱う
      seriesAll.push({ ms: Float64Array.from(cur.ms.slice(1)), start: Float64Array.from(starts.slice(1)) });
    }
    const sc = scenarioOf(seriesAll, gcBot);
    // tick ごとに、試行間で最小だった試行 (= 揺れの少ない試行) の値を使って、遅い tick の内訳を出す
    const nTicks = Math.min(...runs.map((r0) => r0.ms.length));
    const best: number[] = [];
    for (let i = 0; i < nTicks; i++) {
      let bi = 0;
      for (let k = 1; k < runs.length; k++) if (runs[k].ms[i] < runs[bi].ms[i]) bi = k;
      best.push(bi);
    }
    const stableMs = (i: number): number => runs[best[i]].ms[i];
    const dominant = (i: number): number => {
      const pr = runs[best[i]].partsList[i];
      let k = 0;
      for (let j = 1; j < pr.length; j++) if (pr[j] > pr[k]) k = j;
      return k;
    };
    const byPart = new Map<string, number>();
    let over4Path = 0;
    let over4Count = 0;
    const bySector = new Map<string, number[]>();
    for (let i = 1; i < nTicks; i++) {
      const sid = runs[0].sectors[i] ?? '-';
      let arr = bySector.get(sid);
      if (!arr) bySector.set(sid, (arr = []));
      arr.push(stableMs(i));
      if (stableMs(i) > 4) {
        over4Count++;
        const k = dominant(i);
        byPart.set(PARTS[k], (byPart.get(PARTS[k]) ?? 0) + 1);
        if (runs[best[i]].pathList[i] >= stableMs(i) * 0.5) over4Path++;
      }
    }
    const slowest = Array.from({ length: Math.max(0, nTicks - 1) }, (_, i) => i + 1)
      .sort((x, y) => stableMs(y) - stableMs(x))
      .slice(0, 8)
      .map((i) => {
        const k = dominant(i);
        return { ms: stableMs(i), sector: runs[0].sectors[i], tick: runs[0].ticks[i], part: PARTS[k], partMs: runs[best[i]].partsList[i][k], pathMs: runs[best[i]].pathList[i] };
      });
    rep.botAlive = {
      ...sc,
      firstTickMs: runs[0].ms[0],
      bySector: [...bySector.entries()]
        .sort((a2, b2) => a2[0].localeCompare(b2[0]))
        .map(([id, arr]) => {
          const st2 = statOf(arr);
          return { id, n: st2.n, mean: st2.mean, p99: st2.p99, max: st2.max };
        }),
      spikeByPart: [...byPart.entries()].map(([part, count]) => ({ part, count })),
      over4First: over4Count,
      over4Path,
      slowest,
    };
    if (!cleared) flags.push(`ボット走破(敵あり)が失敗: ${failure}`);
    if (sc.stable.p99 > 4) flags.push(`ボット走破(敵45体): p99 ${f(sc.stable.p99)} ms (> 4 ms)`);
    if (sc.stable.max > 4) flags.push(`ボット走破(敵45体): 1 tick の最大 ${f(sc.stable.max)} ms (> 4 ms。生の最大 ${f(sc.stat.max)} ms) @ ${slowest[0]?.sector} (${slowest[0]?.part} ${f(slowest[0]?.partMs ?? 0)} ms、うち nav 探索 ${f(slowest[0]?.pathMs ?? 0)} ms)。4ms超 ${over4Count} tick のうち nav 探索が半分以上 ${over4Path}`);
  }

  if (navOnly) {
    rep.flags = flags;
    return rep;
  }

  // (iv) many bullets
  {
    log('(iv) many projectiles');
    rep.bullets = [];
    const at = ar[2].center;
    const muzzle = { x: at.x, y: at.y + 0.75, z: at.z };
    const cases: { label: string; eb: number; mg: number; ms: number }[] = [
      { label: '基準 (弾の注入なし)', eb: 0, mg: 0, ms: 0 },
      { label: '敵弾 100', eb: 100, mg: 0, ms: 0 },
      { label: '敵弾 300', eb: 300, mg: 0, ms: 0 },
      { label: '敵弾 1000', eb: 1000, mg: 0, ms: 0 },
      { label: 'MG弾 20 (実際の最大: 10発/秒 x 寿命2秒)', eb: 0, mg: 20, ms: 0 },
      { label: 'MG弾 200', eb: 0, mg: 200, ms: 0 },
      { label: 'ミサイル 4 (実際の最大: 1発/秒 x 寿命4秒)', eb: 0, mg: 0, ms: 4 },
      { label: 'ミサイル 50', eb: 0, mg: 0, ms: 50 },
      { label: '敵弾 300 + MG弾 200 + ミサイル 50', eb: 300, mg: 200, ms: 50 },
    ];
    for (const c of cases) {
      const seriesAll: TickSeries[] = [];
      const gcs: GcSpan[] = [];
      let counts = { eb: 0, mg: 0, ms: 0 };
      for (let pass = 0; pass < (q ? 1 : 3); pass++) {
        const g = newGame(stage);
        warmNav(g, at);
        const rnd = makeRng(12345);
        for (let i = 0; i < 480; i++) pinnedStep(g, at);
        await settleGc();
        seriesAll.push(
          timeTicks(g, q ? 240 : 720, at, () => {
            // 寿命で消えた分を補充して、常に指定数が飛んでいる状態にする
            injectEnemyBullets(g.state, c.eb, at, rnd);
            injectMgBullets(g.state, c.mg, muzzle, rnd);
            injectMissiles(g.state, c.ms, muzzle, rnd);
          }),
        );
        gcs.push(...(await settleGc()));
        counts = { eb: g.state.enemyBullets.length, mg: g.state.bullets.length, ms: g.state.missiles.length };
      }
      const sc = scenarioOf(seriesAll, gcs);
      rep.bullets.push({ label: c.label, enemyBullets: counts.eb, mg: counts.mg, missiles: counts.ms, ...sc });
      if (sc.stable.max > 4) flags.push(`${c.label}: 1 tick の最大 ${f(sc.stable.max)} ms (> 4 ms。生の最大 ${f(sc.stat.max)} ms)`);
    }
  }

  // (iv-b) natural counts: player fires the MG constantly in S12 (free fire), all enemies engaged
  {
    log('(iv) natural projectile counts (MG held down)');
    const a = ar[2];
    let ebMax = 0;
    let ebSum = 0;
    let mgMax = 0;
    const n = q ? 1200 : 3000;
    const seriesAll: TickSeries[] = [];
    const gcs: GcSpan[] = [];
    for (let pass = 0; pass < (q ? 1 : 3); pass++) {
      const g = newGame(stage);
      warmNav(g, a.center);
      for (let i = 0; i < 480; i++) pinnedStep(g, a.center);
      await settleGc();
      seriesAll.push(
        timeTicks(g, n, a.center, () => {
          g.input.fire = g.state.player.ammo.machinegun > 0;
          if (pass === 0) {
            ebMax = Math.max(ebMax, g.state.enemyBullets.length);
            ebSum += g.state.enemyBullets.length;
            mgMax = Math.max(mgMax, g.state.bullets.length);
          }
        }),
      );
      gcs.push(...(await settleGc()));
      g.input.fire = false;
    }
    rep.natural = { label: 'S12 中央、MG連射(自由射撃)、敵6体が交戦', enemyBulletsMax: ebMax, enemyBulletsMean: ebSum / n, mgMax, ...scenarioOf(seriesAll, gcs) };
  }

  // (v) leak: 60 s = 7200 ticks
  {
    log('(v) 60 s continuous run (leak check)');
    const a = ar[2];
    const g = newGame(stage);
    warmNav(g, a.center);
    for (let i = 0; i < 480; i++) pinnedStep(g, a.center);
    const total = q ? 1440 : 7200;
    heapMB(); // 前のシナリオの残りを回収
    const samples: { t: number; heapMB: number }[] = [{ t: 0, heapMB: heapMB() }];
    let peakEvents = 0;
    for (let i = 1; i <= total; i++) {
      pinnedStep(g, a.center);
      if ((i & 1) === 0) g.drainEvents();
      peakEvents = Math.max(peakEvents, g.state.events.length);
      if (i % (total / 6) === 0) samples.push({ t: i / SIM.HZ, heapMB: heapMB() });
    }
    const xs = samples.map((s) => s.t);
    const ys = samples.map((s) => s.heapMB);
    const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
    const my = ys.reduce((s, v) => s + v, 0) / ys.length;
    const slope = xs.reduce((s, v, i) => s + (v - mx) * (ys[i] - my), 0) / xs.reduce((s, v) => s + (v - mx) ** 2, 0);
    rep.leak = {
      seconds: total / SIM.HZ,
      ticks: total,
      samples,
      slopeMBPerMin: slope * 60,
      growthMB: samples[samples.length - 1].heapMB - samples[0].heapMB,
      entities: { bullets: g.state.bullets.length, enemyBullets: g.state.enemyBullets.length, events: peakEvents },
    };
    if (rep.leak.growthMB > 5) flags.push(`${rep.leak.seconds} 秒連続実行で heapUsed が ${f(rep.leak.growthMB, 1)} MB 増加 (gc 後)`);
  }

  // (vi) 10 re-sorties
  {
    log('(vi) 10 re-sorties');
    const g = newGame(stage);
    warmNav(g, ar[0].center);
    const ms: number[] = [];
    heapMB();
    const heap: number[] = [heapMB()];
    const after = q ? 120 : 240;
    for (let i = 0; i < 10; i++) {
      const t = performance.now();
      g.sortie(BEST_LOADOUT);
      ms.push(performance.now() - t);
      for (let k = 0; k < after; k++) pinnedStep(g, ar[i % ar.length].center);
      heap.push(heapMB());
    }
    rep.resortie = { n: 10, ms, heapMB: heap, ticksAfter: after };
    if (heap[heap.length - 1] - heap[0] > 5) flags.push(`再出撃10回で heapUsed が ${f(heap[heap.length - 1] - heap[0], 1)} MB 増加`);
  }

  // (vii) world queries per tick
  rep.queries = [];
  for (const scenario of [{ label: '出撃直後 (敵は未警戒)', at: stage.playerStart.pos, warm: 120 }, ...scen.filter((a) => a.kind === 'cross').map((a) => ({ label: `${a.label} (交戦中)`, at: a.center, warm: 960 }))]) {
    log(`(vii) world queries: ${scenario.label}`);
    const g = newGame(stage);
    warmNav(g, scenario.at);
    for (let i = 0; i < scenario.warm; i++) pinnedStep(g, scenario.at);
    const w = g.world as World;
    const counts: Record<string, number> = { raycast: 0, segmentBlocked: 0, sweepSphere: 0, sweepAABB: 0, overlapAABB: 0, pointInSolid: 0 };
    const target = w as unknown as Record<string, (...a: unknown[]) => unknown>;
    const originals: Record<string, (...a: unknown[]) => unknown> = {};
    for (const k of Object.keys(counts)) {
      originals[k] = target[k].bind(w);
      target[k] = (...args: unknown[]) => {
        counts[k]++;
        return originals[k](...args);
      };
    }
    const nav = getNav(g.world, g.stage);
    const s0 = nav.stats();
    const n = q ? 240 : 720;
    for (let i = 0; i < n; i++) pinnedStep(g, scenario.at);
    const s1 = nav.stats();
    for (const k of Object.keys(counts)) target[k] = originals[k];
    const perTick: Record<string, number> = {};
    let total = 0;
    for (const k of Object.keys(counts)) {
      perTick[k] = counts[k] / n;
      total += perTick[k];
    }
    rep.queries.push({ label: scenario.label, perTick, total, nav: { queriesPerTick: (s1.queries - s0.queries) / n, expansionsPerTick: (s1.expansions - s0.expansions) / n } });
  }

  rep.flags = flags;
  return rep;
}

// ---------------------------------------------------------------------------------------------------------------------
// 表示 / Markdown
// ---------------------------------------------------------------------------------------------------------------------
const row = (cells: (string | number)[]): string => `| ${cells.join(' | ')} |`;
const scRow = (label: string, s: Scenario): string =>
  row([label, f(s.stat.mean), f(s.stat.p99), f(s.stat.max), f(s.stable.mean), f(s.stable.p50), f(s.stable.p99), f(s.stable.max), `${f(s.stable.over4 * 100, 2)}%`, `${s.passes} x ${s.stable.n}`]);
const STAT_HEAD = [
  row(['項目', '生: 平均 [ms]', '生: p99 [ms]', '生: 最大 [ms]', '処理コスト: 平均 [ms]', '処理コスト: p50 [ms]', '処理コスト: p99 [ms]', '処理コスト: 最大 [ms]', '処理コスト: 4ms超', '試行数 x tick数']),
  row(['---', '---', '---', '---', '---', '---', '---', '---', '---', '---']),
];

export function reportMarkdown(r: PerfReport): string {
  const L: string[] = [];
  L.push(`計測環境: Node ${r.env.node} / ${r.env.cpu} x${r.env.cores} / loadavg(1,5,15分)=${r.env.loadavg.join(',')} / ${r.env.date}`);
  L.push('');
  L.push(
    '他のプロセスと並行して実行しているため、絶対値は参考値 (負荷が高いほど平均も最大も悪化する)。1 tick の時間は 2 通りで示す。' +
      '**生**: 全試行の tick を合算した値 (OS のスケジューリングの揺れ・V8 の GC 停止を含む)。' +
      '**処理コスト**: 同じ入力・同じシードの決定的な試行を 3 回行い、同じ tick ごとに試行間の最小を取った値 (同じ tick は毎回同じ仕事をするので、揺れ・GC を除いたその tick の処理コストに近い。試行が 1 回の項目は生と同じ)。' +
      '4 ms 超の判定と「閾値を超えた箇所」は処理コストで行う。');
  L.push('');
  L.push('### (i)(ii) 初期化');
  L.push('');
  L.push(row(['項目', '平均 [ms]', '最小 [ms]', '最大 [ms]', '回数']));
  L.push(row(['---', '---', '---', '---', '---']));
  L.push(row([`buildStage() (初回は JIT 込みで ${f(r.buildStage.firstMs, 1)} ms)`, f(r.buildStage.stat.mean, 1), f(r.buildStage.stat.min, 1), f(r.buildStage.stat.max, 1), r.buildStage.stat.n]));
  L.push(row(['new Game() (World の BVH 構築を含む)', f(r.gameInit.newGame.mean, 1), f(r.gameInit.newGame.min, 1), f(r.gameInit.newGame.max, 1), r.gameInit.newGame.n]));
  L.push(row(['sortie()', f(r.gameInit.sortie.mean, 2), f(r.gameInit.sortie.min, 2), f(r.gameInit.sortie.max, 2), r.gameInit.sortie.n]));
  L.push('');
  const su = (x: Startup): string => `最小 ${f(x.firstTick.min, 1)} / 平均 ${f(x.firstTick.mean, 1)} / 最大 ${f(x.firstTick.max, 1)} ms (このプロセスの最初の出撃 ${f(x.firstOfProcess, 1)} ms)、その後 2 秒 (239 tick) の 1 tick の最大は試行ごとに ${f(x.after.min, 1)}〜${f(x.after.max, 1)} ms (4 ms 超 ${x.afterOver4} tick / 5 試行)`;
  L.push(
    'nav (警備ロボットの経路探索グリッド) は **Game.warmup() で出撃前に作る** (アプリは格納庫の空き時間に数 ms ずつ分けて実行し、出撃が先に来たら残りをその場で済ませる)。' +
      'warmup なし (ヘッドレスの Game・従来) は最初の敵 AI tick で作られ、その後 1 tick あたり 256 セルずつ flood-fill する。',
  );
  L.push('');
  if (r.gameInit.warm !== null && r.gameInit.warm.warmupMs !== null) {
    const w = r.gameInit.warm;
    L.push(
      `- **warmup あり**: warmup の所要 平均 ${f(w.warmupMs?.mean ?? NaN, 0)} ms (最小 ${f(w.warmupMs?.min ?? NaN, 0)} / 最大 ${f(w.warmupMs?.max ?? NaN, 0)}、一括)、` +
        `1024 ノード単位に分けると 1 呼び出しの最大 ${f(w.slices?.maxMs ?? NaN, 1)} ms x ${w.slices?.calls ?? '-'} 回 (合計 ${f(w.slices?.totalMs ?? NaN, 0)} ms)。出撃後の最初の tick は ${su(w)}。`,
    );
  }
  L.push(
    `- **warmup なし**: 出撃後の最初の tick は ${su(r.gameInit.cold)} (nav の生成と全敵の AI の初期化を含む)。` +
      `flood-fill が完了するまで ${r.gameInit.navWarm.ticks} tick (${f(r.gameInit.navWarm.ticks / SIM.HZ, 1)} 秒) / 合計 ${f(r.gameInit.navWarm.ms, 0)} ms / ${r.gameInit.navWarm.cells} セル (その間の 1 tick の最大 ${f(r.gameInit.navWarm.maxTickMs, 1)} ms)。`,
  );
  L.push('');
  L.push('### (iii) 戦闘中の 1 tick あたりの処理時間');
  L.push('');
  L.push(`120Hz の 1 tick の予算は ${f(1000 / SIM.HZ, 2)} ms (実際は 1 フレームで 2 tick 前後)。プレイヤーを各戦闘区画の中央 (ARENA_CLEAR の中心) と、その区画で最も多くの敵に射線が通る位置 (区画の主床を 2 m 格子で探索。「最大クロスファイア」) に静止させ、Game.warmup() の後に出撃し、8 秒の warm-up の後に計測 (3 回の試行を合算)。`);
  L.push('');
  L.push(...STAT_HEAD);
  for (const a of r.arenas) L.push(scRow(`${a.label} (${a.kind === 'cross' ? `位置 (${f(a.center.x, 0)}, ${f(a.center.z, 0)}) ` : ''}射線あり最大 ${a.enemiesInLos} 体 / 警戒最大 ${a.enemiesAlert} 体 / 敵弾最大 ${a.bulletsMax})`, a));
  L.push(scRow(`全警備ロボット警戒 (人為的な最悪条件: 30体が遠隔から追跡, 警戒中 ${r.allAlert.alertGuards} 体)`, r.allAlert));
  L.push(scRow('ボット通し走破 (敵45体が生きて攻撃, 4脚+高回復。最初の tick を除く)', r.botAlive));
  L.push('');
  L.push(`ボット通し走破の最初の tick は ${f(r.botAlive.firstTickMs, 1)} ms (1 試行。揺れを含む。出撃前の Game.warmup() の分は含めない)。`);
  L.push('');
  L.push('ボット通し走破の区画別 (その区画にいる間の tick。処理コスト = 試行間の最小):');
  L.push('');
  L.push(row(['区画', 'tick数', '平均 [ms]', 'p99 [ms]', '最大 [ms]']));
  L.push(row(['---', '---', '---', '---', '---']));
  for (const b of r.botAlive.bySector) L.push(row([b.id, b.n, f(b.mean), f(b.p99), f(b.max)]));
  L.push('');
  L.push('ボット通し走破で最も遅かった tick (処理コスト。処理の内訳つき):');
  L.push('');
  L.push(row(['tick', '区画', 'tick 時間 [ms]', '最大の処理', 'その処理 [ms]', 'nav 探索 (findPath 等) [ms]']));
  L.push(row(['---', '---', '---', '---', '---', '---']));
  for (const w of r.botAlive.slowest) L.push(row([w.tick, w.sector ?? '-', f(w.ms), w.part, f(w.partMs), f(w.pathMs)]));
  L.push('');
  L.push(
    `処理コスト (試行間の最小) で 4 ms を超えた tick は ${r.botAlive.over4First} 個 (全 ${r.botAlive.stable.n} tick 中)。最大の処理の内訳: ${r.botAlive.spikeByPart.map((x) => `${x.part} ${x.count}`).join(' / ') || 'なし'}。` +
      `nav 探索が tick 時間の半分以上を占めたもの ${r.botAlive.over4Path} 個。`,
  );
  L.push('');
  L.push('### 全警備ロボット警戒での nav 探索');
  L.push('');
  const nv = r.allAlert.nav;
  L.push(
    `30 体全員が警戒し、プレイヤー位置(S12中央)への経路を探し続ける状態 (敵 AI が 1 tick に使う探索量の上限は PLAN_WORK_PER_TICK ノード展開分で、超える探索は次の tick に持ち越す。1 回の探索は最大 15000 ノード展開)。` +
      `探索は ${nv.findPathCalls} 回、1回の平均 ${f(nv.findPathMsMean)} ms / p99 ${f(nv.findPathMsP99)} ms / 最大 ${f(nv.findPathMsMax)} ms (最大 ${nv.findPathExpMax} ノード展開、複数 tick にまたがる探索は全 step の合計)。` +
      `1 回の呼び出し (findPath / job.step) は ${nv.stepCalls} 回で p99 ${f(nv.stepMsP99)} ms / 最大 ${f(nv.stepMsMax)} ms。` +
      `1 tick あたり平均 ${f(nv.queriesPerTick, 2)} 回の探索・${f(nv.expansionsPerTick, 0)} ノード展開、1 tick に占める探索時間は平均 ${f(r.allAlert.pathMsPerTickMean)} ms / p99 ${f(nv.tickNavMsP99)} ms / 最大 ${f(nv.tickNavMsMax)} ms (生)。` +
      `最初の試行 (生) で 4ms を超えた ${r.allAlert.over4First} tick のうち ${r.allAlert.over4DueToPath} tick は nav の探索が tick 時間の半分以上を占めていた。` +
      (nv.latencyTicks ? `経路を要求してから受け取るまで (${nv.latencyTicks.n} 回) は p50 ${nv.latencyTicks.p50} / p90 ${nv.latencyTicks.p90} / 最大 ${nv.latencyTicks.max} tick (その間、ガードは前の経路か自前の操舵で動く)。` : ''),
  );
  L.push('');
  L.push('### tick の内訳 (Game.step と同じ順序で処理ごとに計時した [ms/tick]。処理コスト: tick ごとに 3 試行の最小。最大は最悪の 1 tick)');
  L.push('');
  const crossArenas = r.arenas.filter((a) => a.kind === 'cross');
  L.push(row(['処理', ...crossArenas.map((a) => `${a.id} 平均`), '全警戒 平均', ...crossArenas.map((a) => `${a.id} 最大`)]));
  L.push(row(['---', ...crossArenas.map(() => '---'), '---', ...crossArenas.map(() => '---')]));
  PARTS.forEach((name, i) => L.push(row([name, ...crossArenas.map((a) => f(a.parts[i], 4)), f(r.allAlert.parts[i], 4), ...crossArenas.map((a) => f(a.partsMax[i], 3))])));
  L.push('');
  L.push(`内訳の計時は Game.step() の複製 (profiledStep) で行い、同じ入力・シードの Game.step() と 600 tick 後の状態が一致することを確認した: ${r.replicaOk ? '一致' : '**不一致**'}。`);
  L.push('');
  L.push('### (iv) 弾が多いときの tick 時間');
  L.push('');
  L.push(`実ゲームで同時に飛ぶ弾数の最大 (${r.natural.label}): 敵弾 ${r.natural.enemyBulletsMax} (平均 ${f(r.natural.enemyBulletsMean, 1)}) / MG弾 ${r.natural.mgMax}。それを超える数は、弾を state に注入して 1 tick あたりの処理時間を測った (弾は寿命で消えるたびに補充。当たらない向きに飛ばす)。`);
  L.push('');
  L.push(row(['条件', '実際に飛んでいた 敵弾/MG/ミサイル', '生: 平均 [ms]', '生: 最大 [ms]', '処理コスト: 平均 [ms]', '処理コスト: p50 [ms]', '処理コスト: p99 [ms]', '処理コスト: 最大 [ms]', '試行数 x tick数']));
  L.push(row(['---', '---', '---', '---', '---', '---', '---', '---', '---']));
  const bRow = (label: string, counts: string, s: Scenario): string => row([label, counts, f(s.stat.mean), f(s.stat.max), f(s.stable.mean), f(s.stable.p50), f(s.stable.p99), f(s.stable.max), `${s.passes} x ${s.stable.n}`]);
  L.push(bRow(r.natural.label + ' (自然発生)', `${r.natural.enemyBulletsMax} / ${r.natural.mgMax} / -`, r.natural));
  for (const b of r.bullets) L.push(bRow(b.label, `${b.enemyBullets} / ${b.mg} / ${b.missiles}`, b));
  L.push('');
  L.push('### (v) 連続実行後のメモリ');
  L.push('');
  L.push(`S12 中央にプレイヤーを固定し、敵が攻撃し続ける状態で ${r.leak.seconds} 秒 (${r.leak.ticks} tick) 連続実行。heapUsed は gc を 2 回呼んだ後の値。`);
  L.push('');
  L.push(row(['経過 [s]', 'heapUsed [MB]']));
  L.push(row(['---', '---']));
  for (const s of r.leak.samples) L.push(row([f(s.t, 0), f(s.heapMB, 2)]));
  L.push('');
  L.push(`増加量 ${f(r.leak.growthMB, 2)} MB / 最小二乗の傾き ${f(r.leak.slopeMBPerMin, 2)} MB/分。終了時に残っている弾: 敵弾 ${r.leak.entities.enemyBullets} / MG弾 ${r.leak.entities.bullets}、events キューの最大長 ${r.leak.entities.events}。`);
  L.push('');
  L.push('### (vi) 再出撃 10 回');
  L.push('');
  L.push(row(['回', 'sortie() [ms]', `${r.resortie.ticksAfter} tick 後の heapUsed [MB]`]));
  L.push(row(['---', '---', '---']));
  L.push(row(['(開始前)', '-', f(r.resortie.heapMB[0], 2)]));
  for (let i = 0; i < r.resortie.n; i++) L.push(row([i + 1, f(r.resortie.ms[i], 2), f(r.resortie.heapMB[i + 1], 2)]));
  L.push('');
  L.push('### (vii) World のクエリ数 / tick');
  L.push('');
  L.push(row(['場面', 'raycast', 'segmentBlocked', 'sweepSphere', 'sweepAABB', 'overlapAABB', 'pointInSolid', '合計', 'nav 探索クエリ', 'nav 展開ノード']));
  L.push(row(['---', '---', '---', '---', '---', '---', '---', '---', '---', '---']));
  for (const q of r.queries)
    L.push(row([q.label, f(q.perTick.raycast, 1), f(q.perTick.segmentBlocked, 1), f(q.perTick.sweepSphere, 1), f(q.perTick.sweepAABB, 1), f(q.perTick.overlapAABB, 1), f(q.perTick.pointInSolid, 1), f(q.total, 1), f(q.nav.queriesPerTick, 2), f(q.nav.expansionsPerTick, 0)]));
  L.push('');
  L.push('### 閾値を超えた箇所');
  L.push('');
  if (r.flags.length === 0) L.push('なし (1 tick が 4 ms を超えた場面、連続実行でのメモリ増加、再出撃での増加はいずれも検出されなかった)。');
  else for (const x of r.flags) L.push(`- ${x}`);
  L.push('');
  return L.join('\n');
}

/** --nav の出力: 経路探索のスパイクに関係する数値だけを短くまとめる */
function navSummary(r: PerfReport): string {
  const L: string[] = [];
  const st = (x: Stat): string => `平均 ${f(x.mean)} / p50 ${f(x.p50)} / p99 ${f(x.p99)} / 最大 ${f(x.max)} ms, 4ms超 ${f(x.over4 * 100, 2)}% (${Math.round(x.over4 * x.n)} tick), 8.33ms超 ${Math.round(x.overBudget * x.n)} tick`;
  const nv = r.allAlert.nav;
  L.push(`== 全警備ロボット警戒 (警戒中 ${r.allAlert.alertGuards} 体, ${r.allAlert.passes} 試行 x ${r.allAlert.stable.n} tick)`);
  L.push(`  処理コスト (試行間の最小): ${st(r.allAlert.stable)}`);
  L.push(`  生 (揺れ・GC を含む)     : ${st(r.allAlert.stat)}`);
  L.push(`  生の 4ms 超 ${r.allAlert.spikes.over4} tick のうち GC と重なったもの ${r.allAlert.spikes.over4Gc}; GC と重ならない tick の p99 ${f(r.allAlert.spikes.p99NonGc)} / 最大 ${f(r.allAlert.spikes.maxNonGc)} ms`);
  L.push(`  探索 ${nv.findPathCalls} 回: 1回 平均 ${f(nv.findPathMsMean)} / p99 ${f(nv.findPathMsP99)} / 最大 ${f(nv.findPathMsMax)} ms (最大 ${nv.findPathExpMax} 展開)`);
  L.push(`  1 呼び出し (findPath / job.step) ${nv.stepCalls} 回: p99 ${f(nv.stepMsP99)} / 最大 ${f(nv.stepMsMax)} ms`);
  L.push(`  1 tick に占める探索時間 (最初の試行, 生): 平均 ${f(r.allAlert.pathMsPerTickMean)} / p99 ${f(nv.tickNavMsP99)} / 最大 ${f(nv.tickNavMsMax)} ms; 4ms 超の tick ${r.allAlert.over4First} 個のうち探索が半分以上 ${r.allAlert.over4DueToPath} 個`);
  L.push(`  1 tick あたり ${f(nv.queriesPerTick, 2)} 探索 / ${f(nv.expansionsPerTick, 0)} 展開; 計画の待ち時間 ${nv.latencyTicks ? `n ${nv.latencyTicks.n}, p50 ${nv.latencyTicks.p50}, p90 ${nv.latencyTicks.p90}, 最大 ${nv.latencyTicks.max} tick` : '-'}`);
  L.push(`== ボット通し走破 (敵 45 体, ${r.botAlive.passes} 試行 x ${r.botAlive.stable.n} tick; 最初の tick ${f(r.botAlive.firstTickMs, 2)} ms は除く)`);
  L.push(`  処理コスト (試行間の最小): ${st(r.botAlive.stable)}`);
  L.push(`  生 (揺れ・GC を含む)     : ${st(r.botAlive.stat)}`);
  L.push(`  生の 4ms 超 ${r.botAlive.spikes.over4} tick のうち GC と重なったもの ${r.botAlive.spikes.over4Gc}; GC と重ならない tick の p99 ${f(r.botAlive.spikes.p99NonGc)} / 最大 ${f(r.botAlive.spikes.maxNonGc)} ms`);
  L.push(`  4ms 超の tick (処理コスト) ${r.botAlive.over4First} 個 (うち探索が半分以上 ${r.botAlive.over4Path}); 遅い tick: ${r.botAlive.slowest.slice(0, 6).map((w) => `${w.tick}@${w.sector ?? '-'} ${f(w.ms)}ms(${w.part} ${f(w.partMs)}, nav ${f(w.pathMs)})`).join(' / ')}`);
  for (const x of r.flags) L.push(`  flag: ${x}`);
  return L.join('\n');
}

/** --startup: 出撃直後の tick だけを、プロセスの最初の出撃から数える (1 プロセス 1 構成) */
function startupMain(mode: string, trials: number): void {
  const stage = buildStage();
  const warm = mode === 'warm';
  const r = startupTrials(stage, warm, trials);
  const v = (a: number[]): string => a.map((x) => f(x, 2)).join(' ');
  console.log(`startup ${mode} (${os.cpus()[0]?.model ?? '?'}, loadavg ${os.loadavg().map((x) => Math.round(x * 10) / 10).join(',')}, node ${process.version})`);
  console.log(`  出撃後の最初の tick [ms] (試行順): ${v(r.firstRaw)}   最小 ${f(r.firstTick.min, 2)} / 平均 ${f(r.firstTick.mean, 2)} / 最大 ${f(r.firstTick.max, 2)}`);
  console.log(`  その後 239 tick の最大 [ms] (試行順): ${v(r.afterMaxRaw)}   4 ms 超の tick 数 (最初の tick を含む全試行) ${r.afterOver4}`);
  if (warm) {
    if (r.warmupMs === null) console.log('  (この tree には Game.warmup がない)');
    else console.log(`  warmup [ms] (一括) 最小 ${f(r.warmupMs.min, 1)} / 平均 ${f(r.warmupMs.mean, 1)} / 最大 ${f(r.warmupMs.max, 1)}; 1024 単位: 1 呼び出しの最大 ${f(r.slices?.maxMs ?? NaN, 2)} ms x ${r.slices?.calls} 回, 合計 ${f(r.slices?.totalMs ?? NaN, 1)} ms`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const quick = args.includes('--quick');
  const si = args.indexOf('--startup');
  if (si >= 0) {
    const ti = args.indexOf('--trials');
    startupMain(args[si + 1] ?? 'cold', ti >= 0 ? Number(args[ti + 1]) : 5);
    return;
  }
  if (args.includes('--nav')) {
    const rep = await runBench(null, { quick, only: 'nav', warmup: !args.includes('--no-warmup') });
    console.log(navSummary(rep));
    return;
  }
  const mdIdx = args.indexOf('--md');
  const rep = await runBench(null, { quick });
  const md = reportMarkdown(rep);
  console.log(md);
  if (mdIdx >= 0) {
    replaceSection(args[mdIdx + 1], 'perf', md);
    console.log(`wrote perf section to ${args[mdIdx + 1]}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
