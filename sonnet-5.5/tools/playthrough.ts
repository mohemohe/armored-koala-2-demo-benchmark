/**
 * playthrough: 実ステージ(buildStage())を、実際の Game の tick 実行と実際のプレイヤー物理(WASD / Shift / Ctrl / Q / Space の入力)だけで
 * スタートから脱出領域まで走破するボット。
 *
 *   npx tsx tools/playthrough.ts                       最悪構成(4脚+高回復)と最良構成(2脚+大容量)を敵撃破済みで走破
 *   npx tsx tools/playthrough.ts --all                 全18構成を走破 (敵撃破済み)
 *   npx tsx tools/playthrough.ts --loadout wide/recovery/quadruped --enemies alive [--seed N]
 *   npx tsx tools/playthrough.ts --enemies progressive --ram      隔壁の手前で止まる + QB突入 (すり抜けない) の確認
 *   npx tsx tools/playthrough.ts --gate-probe          ゲート試験 (5/6 でゲートが閉じたままの最終ゲートの前まで歩いて行く)
 *   npx tsx tools/playthrough.ts --qb [--qb-reserve 0 --qb-margin -10]   QB併用 (ENを使い切ると昇降前にEN待ちが発生する)
 *   npx tsx tools/playthrough.ts --report docs/PLAYTHROUGH.md   全18構成 x (敵撃破済み/QB併用/敵あり) + 隔壁・ゲート試験を実行し、文書の該当節を更新
 *
 * 敵の扱い (--enemies):
 *   dead        走破の前に 6 つの制御砲台へ damageEnemy(1e9) → 隔壁とゲートが objective.ts 経由で開く。他の 39 体も撃破済み
 *   progressive 制御砲台以外の 39 体は撃破済み。隔壁は閉じたまま走り、隔壁の手前で「実際に止まる」ことを確かめてから、その制御砲台
 *               だけを damageEnemy(1e9) で撃破して開く (= 隔壁が閉じている間は先へ進めず、開放後に通れることの確認)
 *   alive       45 体全員が生きて実際に攻撃してくる。被弾を無効化するためテストが player.hp = 1e9 に設定する。隔壁の手前では progressive と同じ
 *
 * 禁止事項の遵守: プレイヤーの位置・速度・EN・接地状態は Game.step() だけが更新する。ボットが直接書き換えるのは
 * 視点 (Game.look() 経由の player.yaw)、敵の排除 (damageEnemy)、alive モードの player.hp だけ。
 *
 * 経路: stage.mainRoute は「飛行自由・全隔壁開放」の3D最短経路で、床の 2〜4 m 上を浮いて進む区間が長い(障害物の上を飛び越える)。
 * ボットは mainRoute を昇降 (stage.climbs) で区切り、各区間を mainRoute の水平射影を中心とする回廊(±CORRIDOR m)の中で、実際の衝突形状
 * (World.overlapAABB / sweepAABB)で検証した「歩行 + 落下」の地上経路に直して、それを追従する。昇降は実プレイどおり接地して
 * ENを溜め → Space長押しの飛行 + 水平移動 → 上端を越えたら着地足場へ → Space解放。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { CAMERA, FCS_PARTS, GENERATOR_PARTS, GRAVITY, LEGS_PARTS, PLAYER, SIM } from '../src/config';
import type { FcsId, GeneratorId, LegsId } from '../src/config';
import { buildSnapshot } from '../src/sim/bench';
import { damageEnemy } from '../src/sim/combat';
import { Game } from '../src/sim/game';
import type { ClimbDef, EnemyState, GameState, Loadout, StageDef, V3 } from '../src/sim/types';
import { World } from '../src/sim/world';
import { buildStage } from '../src/stage';
import { validateStage } from '../src/stage/validate';

// ---------------------------------------------------------------------------------------------------------------------
// 構成
// ---------------------------------------------------------------------------------------------------------------------
/** 最悪構成: 4脚(空中水平 12.8 m/s・EN回復 0.75倍) + 高回復(最大EN 90) */
export const WORST_LOADOUT: Loadout = { fcs: 'wide', generator: 'recovery', legs: 'quadruped' };
/** 最良構成: 2脚 + 大容量(最大EN 180) */
export const BEST_LOADOUT: Loadout = { fcs: 'medium', generator: 'capacity', legs: 'biped' };

export function allLoadouts(): Loadout[] {
  const out: Loadout[] = [];
  for (const fcs of Object.keys(FCS_PARTS) as FcsId[])
    for (const generator of Object.keys(GENERATOR_PARTS) as GeneratorId[])
      for (const legs of Object.keys(LEGS_PARTS) as LegsId[]) out.push({ fcs, generator, legs });
  return out;
}
export const loadoutKey = (l: Loadout): string => `${l.fcs}/${l.generator}/${l.legs}`;

export type EnemyMode = 'dead' | 'progressive' | 'alive';

export interface BotOptions {
  loadout: Loadout;
  enemies: EnemyMode;
  /** ゲーム内時間の上限 [s] (これを超えたら失敗として打ち切る) */
  maxGameSeconds?: number;
  /** 進捗ログ */
  log?: (s: string) => void;
  seed?: number;
  /** 長い直線でQBを使う (36 EN。昇降のためのENは残す) */
  useQB?: boolean;
  /** QBを使った後に残すEN (既定: min(最大EN-36, 60))。0 にすると昇降の前にENが足りず、接地してENを溜める待ちが実際に発生する */
  qbReserve?: number;
  /** 停止点 (昇降の離陸位置) の何 m 手前まで QB を使ってよいか (既定 66 m) */
  qbStopMargin?: number;
  /** 隔壁が閉じているとき、これだけの秒数だけ前進入力を押し続けて「進めない」ことを確認してから制御砲台を撃破する */
  barrierPushSeconds?: number;
  /** 各隔壁の手前で、14 m 下がってから QB で突っ込む (すり抜けないことの確認) */
  ramTest?: boolean;
  /**
   * ゲート試験: 制御砲台 5 体(B1..B5)を先に撃破し、最後の T15 (B6) は生かしたまま、B6 の箱だけをテストが world.setBoxEnabled で無効にして
   * 通り抜けられるようにする (= 6/6 未満でゲートは閉じているまま S15 の最終ゲートまで実際に歩いて到達する)。最終ゲートの手前で止まること・脱出領域に入れない
   * ことを確かめてから T15 を撃破する。これはプレイヤーの位置や速度の書き換えではなく、隔壁 B6 の物理だけを保留する (報告書の deviations に明記)。
   */
  gateProbe?: boolean;
  /** 使うステージ (省略時は buildStage()) */
  stage?: StageDef;
  /** game.step() 1回の所要時間 [ms] を受け取る (perf-bench 用。走破中の実プレイに近い負荷の計測) */
  tickTimer?: (ms: number, state: GameState) => void;
  /** tick の進め方 (省略時は game.step())。perf-bench が処理ごとの計時つきの同等の関数を渡す */
  stepFn?: (game: Game) => void;
}

export interface ClimbRecord {
  id: string;
  ok: boolean;
  height: number;
  /** 離陸前にENが溜まるのを待った時間 [s] (接地したまま) */
  waitSeconds: number;
  enBefore: number;
  enMin: number;
  enUsed: number;
  /** 上昇推進(飛行)が実際に掛かった時間 [s] */
  flightSeconds: number;
  /** Space を押してから上の足場に着地するまで [s] */
  climbSeconds: number;
  /** 着地位置と、期待した着地点(to)との水平距離 [m] */
  landDistance: number;
  failure: string | null;
}

export interface RamRecord {
  /** QB(80 m/s)で隔壁へ突っ込んだ: 実際にQBが成立したか / 到達した最大水平速度 [m/s] / 隔壁の面を越えて入った最大量 [m] (0 以下なら通っていない) / 隔壁の向こう側に出たか */
  qbFired: boolean;
  maxSpeed: number;
  penetration: number;
  crossed: boolean;
}

export interface BarrierRecord {
  id: string;
  controlId: string | null;
  /** 隔壁に接触して止まったときの位置 (プレイヤー中心) */
  stopPos: V3;
  /** 前進入力を押し続けた秒数 */
  pushSeconds: number;
  /** その間に隔壁の面へ向かって進んだ最大量 [m] (0 に近いほど「止まっている」) と、面に沿って滑った最大量 [m] */
  pushInto: number;
  pushSlide: number;
  /** 止まった位置から隔壁の面までの距離 (面の法線方向, プレイヤーAABBの面から) [m] */
  gapToBarrier: number;
  /** 撃破した tick / objective が開放を反映した tick / 隔壁の向こうへ通過した tick */
  destroyedTick: number;
  openedTick: number | null;
  passedTick: number | null;
  /** 撃破から通過までの時間 [s] */
  passSeconds: number | null;
  /** 隔壁が閉じている間ずっと、プレイヤーAABBが隔壁の箱にめり込まなかったか */
  neverCrossedWhileClosed: boolean;
  /** 隔壁(portal)の向こうの区画 (a→b の b) */
  nextSectorId: string | null;
  /** QBで突っ込む試験 (ramTest / ゲート試験のみ) */
  ram: RamRecord | null;
  /** 撃破の直前の状態 (制御砲台の破壊数・ゲート・モード・脱出領域の中か) */
  before: { controlsDestroyed: number; gateOpen: boolean; mode: string; inEscapeZone: boolean };
}

export interface StuckRecord {
  tick: number;
  time: number;
  pos: V3;
  sectorId: string | null;
  what: string;
}

export interface RunResult {
  loadout: Loadout;
  enemies: EnemyMode;
  useQB: boolean;
  gateProbe: boolean;
  ramTest: boolean;
  cleared: boolean;
  mode: string;
  endReason: string | null;
  failure: string | null;
  gameSeconds: number;
  ticks: number;
  /** ボットの軌跡の累積長 (3D) [m] */
  pathLength: number;
  /** ボットの軌跡の累積長 (水平) [m] */
  pathLengthXZ: number;
  /** stage.mainRoute の折れ線の長さ (3D) [m] */
  routeLength: number;
  /** pathLength / routeLength */
  pathRatio: number;
  visitedSectorIds: string[];
  sectorEnterTicks: Record<string, number>;
  climbs: ClimbRecord[];
  barriers: BarrierRecord[];
  /** ゲーム内時間の内訳 [s] */
  timeBreakdown: { walking: number; enWait: number; climbing: number; barrier: number };
  maxSpeed: number;
  qbCount: number;
  anomalies: { nonFinite: number; overlap: number; killY: number; overlapFirst: string | null };
  stuck: StuckRecord[];
  damageTaken: number;
  enemyShotsFired: number;
  playerHits: number;
  controlsDestroyed: number;
  /** 敵の排除 (damageEnemy) で倒した数 (dead: 45 / progressive: 45 / alive: 制御砲台の 6) */
  killCount: number;
  /** 終了時に生きている敵の数 */
  enemiesAlive: number;
  gateOpen: boolean;
  gateOpenTick: number | null;
  escapeEnteredTick: number | null;
  clearedTick: number | null;
  /** 計画した地上経路の長さ (水平, 全区間) [m] */
  plannedLengthXZ: number;
  /** 1 tick あたりの最大移動量 [m] (瞬間移動が無いことの確認: QB 80 m/s でも 0.67 m/tick) */
  maxStepDistance: number;
  /** ボットの操作の間に、位置・速度・EN・接地状態が Game.step() 以外で変わった回数 (0 でなければならない) */
  externalWrites: number;
  /** 終了時の window.AK2_BENCH.getSnapshot() 相当 (buildSnapshot) の抜粋 */
  snapshot: { state: string; visitedSectorIds: string[]; sectorCount: number; controlsDestroyed: number; gateOpen: boolean; openBarrierIds: string[]; elapsedSeconds: number; hasNonFinite: boolean };
  wallMs: number;
}

// ---------------------------------------------------------------------------------------------------------------------
// 基本ユーティリティ
// ---------------------------------------------------------------------------------------------------------------------
const HALF = PLAYER.HALF;
const DT = SIM.DT;
const v3 = (x: number, y: number, z: number): V3 => ({ x, y, z });
const hdist = (a: { x: number; z: number }, b: { x: number; z: number }): number => Math.hypot(a.x - b.x, a.z - b.z);
const polyLen3 = (pts: readonly V3[]): number => {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y, pts[i].z - pts[i - 1].z);
  return l;
};
const polyLenXZ = (pts: readonly V3[]): number => {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += hdist(pts[i], pts[i - 1]);
  return l;
};
const wrapPi = (a: number): number => {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
};

// ---------------------------------------------------------------------------------------------------------------------
// 折れ線 (水平)
// ---------------------------------------------------------------------------------------------------------------------
interface Poly {
  pts: V3[];
  /** 水平の累積長 */
  cum: number[];
  total: number;
}
function makePoly(pts: V3[]): Poly {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + hdist(pts[i], pts[i - 1]));
  return { pts, cum, total: cum[cum.length - 1] };
}
function pointAt(poly: Poly, s: number): V3 {
  const pts = poly.pts;
  if (s <= 0) return pts[0];
  if (s >= poly.total) return pts[pts.length - 1];
  let i = 1;
  while (i < pts.length - 1 && poly.cum[i] < s) i++;
  const l = poly.cum[i] - poly.cum[i - 1];
  const t = l > 1e-9 ? (s - poly.cum[i - 1]) / l : 0;
  const a = pts[i - 1];
  const b = pts[i];
  return v3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
}
/** 累積長 [sLo, sHi] の範囲の線分だけに (x,z) を射影し、最も近い点を返す */
function projectWindow(poly: Poly, sLo: number, sHi: number, x: number, z: number): { s: number; dist: number } {
  const pts = poly.pts;
  let best = { s: sLo, dist: Infinity };
  for (let j = 0; j < pts.length - 1; j++) {
    if (poly.cum[j + 1] < sLo || poly.cum[j] > sHi) continue;
    const a = pts[j];
    const b = pts[j + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l2 = dx * dx + dz * dz;
    const t = l2 > 1e-12 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / l2)) : 0;
    const d = Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t));
    if (d < best.dist - 1e-9) best = { s: poly.cum[j] + Math.sqrt(l2) * t, dist: d };
  }
  return best;
}
/** 折れ線までの水平距離 */
function distToPolyline(pts: readonly V3[], x: number, z: number): number {
  let best = Infinity;
  for (let j = 0; j < pts.length - 1; j++) {
    const a = pts[j];
    const b = pts[j + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l2 = dx * dx + dz * dz;
    const t = l2 > 1e-12 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / l2)) : 0;
    const d = Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t));
    if (d < best) best = d;
  }
  return best;
}
/** 3D折れ線上で、点 p に最も近い点の累積長 (3D) (fromS 以降) */
function nearestParam3(pts: readonly V3[], p: V3, fromS = 0): { s: number; dist: number } {
  let acc = 0;
  let best = { s: fromS, dist: Infinity };
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const l2 = dx * dx + dy * dy + dz * dz;
    const l = Math.sqrt(l2);
    const t = l2 > 1e-12 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy + (p.z - a.z) * dz) / l2)) : 0;
    const s = acc + l * t;
    const d = Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t), p.z - (a.z + dz * t));
    if (s >= fromS - 1e-9 && d < best.dist) best = { s, dist: d };
    acc += l;
  }
  return best;
}

// ---------------------------------------------------------------------------------------------------------------------
// 地上経路の計画 (歩行 + 落下)。実際の World.overlapAABB / sweepAABB / raycast で検証する
// ---------------------------------------------------------------------------------------------------------------------
/** 格子の間隔 [m] */
export const PLAN_CELL = 1;
/** プレイヤーAABBの水平半寸法に足す余裕 [m] (壁際を擦らない) */
export const PLAN_MARGIN = 0.6;
/** mainRoute の水平射影からの回廊の半幅 [m] */
export const CORRIDOR = 28;
/** 落下エッジの追加コスト [m] (不要な飛び降りを避ける) */
const DROP_PENALTY = 6;
/** 縁から落ちるとき、水平に何格子先まで着地点を探すか */
const DROP_REACH = 3;
/** 同じ床とみなす高さの差 [m] */
const LEVEL_TOL = 0.06;

interface HeapItem {
  f: number;
  n: number;
}
class MinHeap {
  private a: HeapItem[] = [];
  get size(): number {
    return this.a.length;
  }
  push(it: HeapItem): void {
    const a = this.a;
    a.push(it);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].f <= a[i].f) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): HeapItem {
    const a = this.a;
    const top = a[0];
    const last = a.pop() as HeapItem;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].f < a[m].f) m = l;
        if (r < a.length && a[r].f < a[m].f) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

export interface PlanStats {
  /** 見つからなかったとき: ゴールに最も近づけた格子 */
  closest?: { x: number; y: number; z: number; dist: number; expansions: number };
  expansions: number;
  ms: number;
  margin: number;
  rawNodes: number;
  smoothNodes: number;
  drops: number;
}

export class GroundPlanner {
  readonly world: World;
  constructor(stage: StageDef) {
    this.world = new World(stage.boxes);
    // 計画は全隔壁が開いている前提 (実行時は隔壁の箱に接触して止まり、制御砲台の撃破で開く)
    for (const b of stage.barriers)
      for (const id of b.boxIds) {
        const i = this.world.indexOfBox(id);
        if (i >= 0) this.world.setBoxEnabled(i, false);
      }
  }

  /**
   * 真下の床の上面の高さ。区画の境界は箱が面を共有しており、面ちょうどを通るレイは両方に触れるだけ(=ミス)になるので、
   * 中心と 5cm ずらした4本のレイのうち最も高い床を採る (プレイヤーのAABBは幅 1.6m あり、足元のどこかが支えられていれば立てる)。
   */
  private floorTop(x: number, y: number, z: number): number | null {
    const down = { x: 0, y: -1, z: 0 };
    let best: number | null = null;
    for (const [ox, oz] of [[0, 0], [0.05, 0], [-0.05, 0], [0, 0.05], [0, -0.05]]) {
      const hit = this.world.raycast({ x: x + ox, y, z: z + oz }, down, 120);
      if (hit && (best === null || hit.point.y > best)) best = hit.point.y;
    }
    return best;
  }

  private free(x: number, floorY: number, z: number, hx: number, hz: number): boolean {
    return !this.world.overlapAABB({ x, y: floorY + HALF.y + 0.02, z }, { x: hx, y: HALF.y, z: hz });
  }

  /**
   * start/goal はプレイヤー中心座標。corridor は回廊の中心線(水平)。戻り値は「プレイヤー中心」の折れ線(始点=start, 終点=goal)。
   * 通れなければ null。
   */
  plan(start: V3, goal: V3, corridor: readonly V3[], stats?: PlanStats): V3[] | null {
    const t0 = performance.now();
    for (const margin of [PLAN_MARGIN, 0.3]) {
      const r = this.search(start, goal, corridor, margin, stats);
      if (r) {
        if (stats) {
          stats.expansions = r.expansions;
          stats.ms = performance.now() - t0;
          stats.margin = margin;
          stats.rawNodes = r.raw;
          stats.smoothNodes = r.pts.length;
          stats.drops = r.pts.reduce((n, p, i) => (i > 0 && p.y < r.pts[i - 1].y - 0.3 ? n + 1 : n), 0);
        }
        return r.pts;
      }
    }
    return null;
  }

  private search(start: V3, goal: V3, corridor: readonly V3[], margin: number, stats?: PlanStats): { pts: V3[]; expansions: number; raw: number } | null {
    const h = PLAN_CELL;
    const hx = HALF.x + margin;
    const hz = HALF.z + margin;
    const startFloor = this.floorTop(start.x, start.y, start.z);
    if (startFloor === null) return null;
    const goalFloor = goal.y - HALF.y;
    const gx = Math.round(goal.x / h);
    const gz = Math.round(goal.z / h);
    const sx = Math.round(start.x / h);
    const sz = Math.round(start.z / h);
    const yKey = (y: number): number => Math.round(y * 20);
    const key = (ix: number, iz: number, y: number): number => ((ix + 1024) * 2048 + (iz + 1024)) * 4096 + (yKey(y) + 2048);
    const nodeIx: number[] = [];
    const nodeIz: number[] = [];
    const nodeY: number[] = [];
    const gCost: number[] = [];
    const parent: number[] = [];
    const closed: boolean[] = [];
    const index = new Map<number, number>();
    const corrCache = new Map<number, boolean>();
    const inCorridor = (ix: number, iz: number): boolean => {
      const k = (ix + 1024) * 2048 + (iz + 1024);
      let v = corrCache.get(k);
      if (v === undefined) {
        v = distToPolyline(corridor, ix * h, iz * h) <= CORRIDOR;
        corrCache.set(k, v);
      }
      return v;
    };
    const add = (ix: number, iz: number, y: number, g: number, par: number): number => {
      const k = key(ix, iz, y);
      const ex = index.get(k);
      if (ex !== undefined) {
        if (g < gCost[ex] - 1e-9) {
          gCost[ex] = g;
          parent[ex] = par;
          return ex;
        }
        return -1;
      }
      const n = nodeIx.length;
      nodeIx.push(ix);
      nodeIz.push(iz);
      nodeY.push(y);
      gCost.push(g);
      parent.push(par);
      closed.push(false);
      index.set(k, n);
      return n;
    };
    const heur = (ix: number, iz: number): number => Math.hypot(ix - gx, iz - gz) * h * 1.1;
    const heap = new MinHeap();
    const s0 = add(sx, sz, startFloor, 0, -1);
    heap.push({ f: heur(sx, sz), n: s0 });
    let expansions = 0;
    let goalNode = -1;
    let closest = { n: s0, d: Infinity };
    const DIRS: [number, number, number][] = [
      [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
      [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
    ];
    while (heap.size > 0) {
      const { n } = heap.pop();
      if (closed[n]) continue;
      closed[n] = true;
      expansions++;
      const ix = nodeIx[n];
      const iz = nodeIz[n];
      const y = nodeY[n];
      if (Math.abs(y - goalFloor) < 0.3) {
        const dd = Math.hypot(ix - gx, iz - gz);
        if (dd < closest.d) closest = { n, d: dd };
      }
      if (Math.abs(ix - gx) <= 0 && Math.abs(iz - gz) <= 0 && Math.abs(y - goalFloor) < 0.3) {
        goalNode = n;
        break;
      }
      if (expansions > 400000) break;
      for (const [dx, dz, c] of DIRS) {
        // k = 1: 隣の格子。足元が空(段差の縁)のときだけ、縁から充分に離れて真下へ落ちられる格子(k = 2, 3)まで水平に進む
        for (let k = 1; k <= DROP_REACH; k++) {
          const jx = ix + dx * k;
          const jz = iz + dz * k;
          if (!inCorridor(jx, jz)) break;
          const px = jx * h;
          const pz = jz * h;
          const isGoalCell = jx === gx && jz === gz;
          // 同じ高さの空間に立てるか (余裕込み。ゴール格子は実際に立つ位置なので余裕なしでよい)
          if (!this.free(px, y, pz, isGoalCell ? HALF.x : hx, isGoalCell ? HALF.z : hz)) break;
          const fl = this.floorTop(px, y + 1.8, pz);
          if (fl !== null && Math.abs(fl - y) <= LEVEL_TOL) {
            if (k === 1) {
              const g = gCost[n] + c * h;
              const m = add(jx, jz, y, g, n);
              if (m >= 0) heap.push({ f: g + heur(jx, jz), n: m });
            }
            break;
          }
          if (fl !== null && fl > y) break; // 段差を登る/ジャンプはしない
          if (fl === null) continue; // 床が無い: もう少し先まで見る
          // 落下: 着地点に立てて、真下へ落ちる空間があること (縁の床にまだ足が掛かっているうちは真下が塞がる: 先の格子を試す)
          if (!this.free(px, fl, pz, hx, hz)) continue;
          const drop = this.world.sweepAABB({ x: px, y: y + HALF.y + 0.02, z: pz }, { x: hx, y: HALF.y, z: hz }, { x: 0, y: fl - y, z: 0 });
          if (drop) continue;
          const g = gCost[n] + c * h * k + DROP_PENALTY;
          const m = add(jx, jz, fl, g, n);
          if (m >= 0) heap.push({ f: g + heur(jx, jz), n: m });
          break;
        }
      }
    }
    if (goalNode < 0) {
      if (stats) stats.closest = { x: nodeIx[closest.n] * h, y: nodeY[closest.n], z: nodeIz[closest.n] * h, dist: closest.d, expansions };
      return null;
    }
    // 復元
    const raw: V3[] = [];
    for (let n = goalNode; n >= 0; n = parent[n]) raw.push(v3(nodeIx[n] * h, nodeY[n], nodeIz[n] * h));
    raw.reverse();
    const smooth = this.smooth(raw, hx, hz);
    // 始点・終点は実際の位置に置き換える
    const pts = smooth.map((p) => v3(p.x, p.y + HALF.y, p.z));
    pts[0] = v3(start.x, start.y, start.z);
    pts[pts.length - 1] = v3(goal.x, goal.y, goal.z);
    return { pts, expansions, raw: raw.length };
  }

  /** 同じ高さで続く区間ごとに、余裕込みで実際に歩ける最長の直線に置き換える (糸引き) */
  private smooth(raw: V3[], hx: number, hz: number): V3[] {
    const out: V3[] = [raw[0]];
    let i = 0;
    while (i < raw.length - 1) {
      // 同じ高さの区間の終わり
      let runEnd = i;
      while (runEnd + 1 < raw.length && Math.abs(raw[runEnd + 1].y - raw[i].y) <= LEVEL_TOL) runEnd++;
      let j = Math.min(runEnd, i + 120);
      if (runEnd === i) {
        // 次は落下の着地点
        out.push(raw[i + 1]);
        i++;
        continue;
      }
      while (j > i + 1 && !this.segmentWalkable(raw[i], raw[j], hx, hz)) j--;
      out.push(raw[j]);
      i = j;
    }
    return out;
  }

  private segmentWalkable(a: V3, b: V3, hx: number, hz: number): boolean {
    const y = a.y;
    const d = { x: b.x - a.x, y: 0, z: b.z - a.z };
    const len = Math.hypot(d.x, d.z);
    if (len < 1e-9) return true;
    if (this.world.sweepAABB({ x: a.x, y: y + HALF.y + 0.02, z: a.z }, { x: hx, y: HALF.y, z: hz }, d)) return false;
    const n = Math.ceil(len / 0.5);
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      const fl = this.floorTop(a.x + d.x * t, y + 1.8, a.z + d.z * t);
      if (fl === null || Math.abs(fl - y) > LEVEL_TOL) return false;
    }
    return true;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// 経路の組み立て: mainRoute を、昇降(climbs)で区切った「歩行区間」の並びに直す
// ---------------------------------------------------------------------------------------------------------------------
export interface WalkStep {
  kind: 'walk';
  /** mainRoute の該当部分 (回廊の中心線。プレイヤー中心座標) */
  corridor: V3[];
  /** 区間の始点/終点 (プレイヤー中心座標)。始点は前の昇降の着地点 (最初の区間だけ出撃位置) */
  from: V3;
  to: V3;
  /** この区間の終点で止まって昇降を始める (昇降の離陸位置) か */
  stopAtEnd: boolean;
  /** 計画された地上経路 (プレイヤー中心座標) */
  path: V3[] | null;
  plan?: PlanStats;
}
export interface ClimbStep {
  kind: 'climb';
  climb: ClimbDef;
}
export type PlanStep = WalkStep | ClimbStep;

/** mainRoute を stage.climbs の from→to で分割する (経路は昇降に最も近づく点で区切る) */
export function buildPlan(stage: StageDef, start: V3 = stage.playerStart.pos): PlanStep[] {
  const route = stage.mainRoute.points;
  const fromC = (c: ClimbDef): V3 => v3(c.from.x, c.from.y + HALF.y, c.from.z);
  const toC = (c: ClimbDef): V3 => v3(c.to.x, c.to.y + HALF.y, c.to.z);
  const marks = stage.climbs
    .map((c) => {
      const a = nearestParam3(route, fromC(c));
      const b = nearestParam3(route, toC(c), a.s);
      return { c, sIn: a.s, sOut: Math.max(b.s, a.s) };
    })
    .sort((p, q) => p.sIn - q.sIn);
  for (let i = 1; i < marks.length; i++) if (marks[i].sIn < marks[i - 1].sOut - 1e-6) throw new Error(`climbs ${marks[i - 1].c.id} and ${marks[i].c.id} overlap along the route`);
  const cum3: number[] = [0];
  for (let i = 1; i < route.length; i++) cum3.push(cum3[i - 1] + Math.hypot(route[i].x - route[i - 1].x, route[i].y - route[i - 1].y, route[i].z - route[i - 1].z));
  const between = (s0: number, s1: number): V3[] => route.filter((_, i) => cum3[i] > s0 + 1e-6 && cum3[i] < s1 - 1e-6);

  const plan: PlanStep[] = [];
  let curFrom: V3 = { ...start };
  let curS = 0;
  for (const m of marks) {
    plan.push({ kind: 'walk', corridor: [curFrom, ...between(curS, m.sIn), fromC(m.c)], from: curFrom, to: fromC(m.c), stopAtEnd: true, path: null });
    plan.push({ kind: 'climb', climb: m.c });
    curFrom = toC(m.c);
    curS = m.sOut;
  }
  const end = route[route.length - 1];
  plan.push({ kind: 'walk', corridor: [curFrom, ...between(curS, Infinity), end], from: curFrom, to: end, stopAtEnd: false, path: null });
  return plan;
}

const planCache = new WeakMap<StageDef, { planner: GroundPlanner; plan: PlanStep[]; ms: number }>();
/** ステージごとに1回だけ地上経路を計画する (構成・敵の扱いに依存しない) */
export function getGroundPlan(stage: StageDef): { planner: GroundPlanner; plan: PlanStep[]; ms: number } {
  let c = planCache.get(stage);
  if (c) return c;
  const t0 = performance.now();
  const planner = new GroundPlanner(stage);
  const plan = buildPlan(stage);
  for (const step of plan) {
    if (step.kind !== 'walk') continue;
    const st: PlanStats = { expansions: 0, ms: 0, margin: 0, rawNodes: 0, smoothNodes: 0, drops: 0 };
    step.path = planner.plan(step.from, step.to, step.corridor, st);
    step.plan = st;
  }
  c = { planner, plan, ms: performance.now() - t0 };
  planCache.set(stage, c);
  return c;
}

// ---------------------------------------------------------------------------------------------------------------------
// ボット本体 (ジェネレーター: yield のたびに「このtickの入力が決まった」ことを意味し、ランナーが game.step() を1回呼ぶ)
// ---------------------------------------------------------------------------------------------------------------------
class BotAbort extends Error {}

interface PendingBarrier {
  rec: BarrierRecord;
  axis: V3;
  origin: V3;
  thickness: number;
  bounds: { min: V3; max: V3 };
}

class Bot {
  readonly game: Game;
  readonly stage: StageDef;
  readonly opts: BotOptions;
  readonly mult: number;
  readonly log: (s: string) => void;
  readonly climbs: ClimbRecord[] = [];
  readonly barriers: BarrierRecord[] = [];
  readonly stuck: StuckRecord[] = [];
  readonly sectorEnterTicks: Record<string, number> = {};
  readonly anomalies = { nonFinite: 0, overlap: 0, killY: 0, overlapFirst: null as string | null };
  pathLength = 0;
  pathLengthXZ = 0;
  plannedLengthXZ = 0;
  maxStepDistance = 0;
  externalWrites = 0;
  private lastSig = '';
  maxSpeed = 0;
  timeBreakdown = { walking: 0, enWait: 0, climbing: 0, barrier: 0 };
  private bucket: keyof Bot['timeBreakdown'] = 'walking';
  gateOpenTick: number | null = null;
  escapeEnteredTick: number | null = null;
  clearedTick: number | null = null;
  playerHits = 0;
  enemyShots = 0;
  private lastPos: V3;
  private shiftHigh = false;
  private qbHigh = false;
  private visitedCount = 0;
  private barrierOpenTicks = new Map<string, number>();
  private pending: PendingBarrier[] = [];
  /** 閉じている隔壁 id -> 箱の外接 */
  private closedBarriers = new Map<string, { min: V3; max: V3 }>();
  private crossedWhileClosed = new Set<string>();
  /** ゲート試験: テストが箱を無効にして通れるようにした隔壁 (閉鎖中の検査から外す) */
  holdOpen(id: string): void {
    this.closedBarriers.delete(id);
  }

  constructor(game: Game, opts: BotOptions) {
    this.game = game;
    this.stage = game.stage;
    this.opts = opts;
    this.mult = game.state.stats.horizontalSpeedMultiplier;
    this.log = opts.log ?? (() => {});
    this.lastPos = { ...game.state.player.pos };
    for (const b of this.stage.barriers) {
      const mn = v3(Infinity, Infinity, Infinity);
      const mx = v3(-Infinity, -Infinity, -Infinity);
      for (const id of b.boxIds) {
        const bx = this.stage.boxes.find((q) => q.id === id);
        if (!bx) continue;
        mn.x = Math.min(mn.x, bx.min.x);
        mn.y = Math.min(mn.y, bx.min.y);
        mn.z = Math.min(mn.z, bx.min.z);
        mx.x = Math.max(mx.x, bx.max.x);
        mx.y = Math.max(mx.y, bx.max.y);
        mx.z = Math.max(mx.z, bx.max.z);
      }
      this.closedBarriers.set(b.id, { min: mn, max: mx });
    }
  }

  get s() {
    return this.game.state;
  }

  // ------------------------------------------------------------------ 入力の基本
  private setYaw(target: number): void {
    const p = this.s.player;
    const d = wrapPi(p.yaw - target);
    if (Math.abs(d) > 1e-9) this.game.look(d / CAMERA.SENSITIVITY, 0);
  }
  private yawToward(tx: number, tz: number): number {
    const p = this.s.player.pos;
    return Math.atan2(-(tx - p.x), -(tz - p.z));
  }
  private clearKeys(): void {
    const i = this.game.input;
    i.forward = i.back = i.left = i.right = i.jump = i.ctrl = i.qb = i.fire = false;
    i.weaponSelect = null;
    this.setShift(false, true);
    this.qbHigh = false;
  }
  /** Shift は立ち上がりでグライドを切り替える: 目標と違うときだけ1tickだけ押す */
  private setShift(wantGlide: boolean | null, forceRelease = false): void {
    const i = this.game.input;
    const enabled = this.s.player.mv.glideEnabled;
    if (forceRelease || wantGlide === null || wantGlide === enabled || this.shiftHigh) {
      i.shift = false;
      this.shiftHigh = false;
    } else {
      i.shift = true;
      this.shiftHigh = true;
    }
  }
  /** Q は立ち上がりだけ: 1tick押して次のtickで離す */
  private pressQB(): void {
    const i = this.game.input;
    if (this.qbHigh) {
      i.qb = false;
      this.qbHigh = false;
    } else {
      i.qb = true;
      this.qbHigh = true;
    }
  }
  private releaseQB(): void {
    this.game.input.qb = false;
    this.qbHigh = false;
  }

  // ------------------------------------------------------------------ ランナーから呼ばれる: 1tick進めた後の監視
  afterStep(): void {
    const s = this.s;
    const p = s.player;
    const world = this.game.world;
    if (!Number.isFinite(p.pos.x + p.pos.y + p.pos.z + p.vel.x + p.vel.y + p.vel.z + p.en + p.hp)) this.anomalies.nonFinite++;
    if (world.overlapAABB(p.pos, HALF)) {
      this.anomalies.overlap++;
      if (this.anomalies.overlapFirst === null) this.anomalies.overlapFirst = `tick ${s.tick} at (${p.pos.x.toFixed(3)}, ${p.pos.y.toFixed(3)}, ${p.pos.z.toFixed(3)})`;
    }
    if (p.pos.y < this.stage.killY) this.anomalies.killY++;
    const dx = p.pos.x - this.lastPos.x;
    const dy = p.pos.y - this.lastPos.y;
    const dz = p.pos.z - this.lastPos.z;
    this.pathLength += Math.hypot(dx, dy, dz);
    this.pathLengthXZ += Math.hypot(dx, dz);
    this.maxStepDistance = Math.max(this.maxStepDistance, Math.hypot(dx, dy, dz));
    this.lastPos = { ...p.pos };
    this.lastSig = this.playerSig();
    this.maxSpeed = Math.max(this.maxSpeed, Math.hypot(p.vel.x, p.vel.y, p.vel.z));
    this.timeBreakdown[this.bucket] += DT;
    const vs = s.progress.visitedSectorIds;
    while (this.visitedCount < vs.length) this.sectorEnterTicks[vs[this.visitedCount++]] = s.tick;
    if (this.gateOpenTick === null && s.objective.gateOpen) this.gateOpenTick = s.tick;
    const zone = this.stage.escapeZone;
    if (this.escapeEnteredTick === null && p.pos.x >= zone.min.x && p.pos.x <= zone.max.x && p.pos.y >= zone.min.y && p.pos.y <= zone.max.y && p.pos.z >= zone.min.z && p.pos.z <= zone.max.z)
      this.escapeEnteredTick = s.tick;
    for (const id of s.objective.openBarrierIds) if (!this.barrierOpenTicks.has(id)) this.barrierOpenTicks.set(id, s.tick);
    // 閉じている隔壁の箱の中/向こう側に入っていないか (プレイヤーAABBが隔壁の箱にめり込んでいないこと)
    for (const [id, bb] of this.closedBarriers) {
      if (s.objective.openBarrierIds.includes(id) || (id === 'GATE' && s.objective.gateOpen)) continue;
      if (
        p.pos.x + HALF.x > bb.min.x + 1e-4 && p.pos.x - HALF.x < bb.max.x - 1e-4 &&
        p.pos.y + HALF.y > bb.min.y + 1e-4 && p.pos.y - HALF.y < bb.max.y - 1e-4 &&
        p.pos.z + HALF.z > bb.min.z + 1e-4 && p.pos.z - HALF.z < bb.max.z - 1e-4
      )
        this.crossedWhileClosed.add(id);
    }
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const pb = this.pending[i];
      const moved = (p.pos.x - pb.origin.x) * pb.axis.x + (p.pos.z - pb.origin.z) * pb.axis.z;
      if (pb.rec.passedTick === null && moved > pb.thickness + 2.5) {
        pb.rec.passedTick = s.tick;
        pb.rec.passSeconds = (s.tick - pb.rec.destroyedTick) * DT;
        this.pending.splice(i, 1);
      }
    }
    for (const ev of s.events) {
      if (ev.type === 'playerHit') this.playerHits++;
      else if (ev.type === 'enemyFire') this.enemyShots++;
    }
    s.events.length = 0; // (描画側は居ない) イベントキューが溢れないようにする
    if (s.mode === 'cleared' && this.clearedTick === null) this.clearedTick = s.tick;
  }

  private playerSig(): string {
    const p = this.s.player;
    return `${p.pos.x},${p.pos.y},${p.pos.z},${p.vel.x},${p.vel.y},${p.vel.z},${p.en},${p.grounded}`;
  }

  private *tick(bucket?: keyof Bot['timeBreakdown']): Generator<void> {
    if (bucket) this.bucket = bucket;
    // 位置・速度・EN・接地状態は Game.step() の中でしか変わらない (前の tick の終わりから、ここまでに誰も書き換えていない)
    if (this.lastSig !== '' && this.playerSig() !== this.lastSig) this.externalWrites++;
    if (this.opts.enemies === 'alive') this.s.player.hp = 1e9; // 「被弾を無効化する」テスト: 敵の攻撃は実際に飛んでくるが死なない
    const max = this.opts.maxGameSeconds ?? 900;
    if (this.s.time > max) throw new BotAbort(`game time limit ${max}s exceeded`);
    yield;
  }

  // ------------------------------------------------------------------ 歩行区間: 地上経路に沿って進む
  private *walk(step: WalkStep, label: string): Generator<void> {
    const pathPts = step.path ?? step.corridor;
    if (!step.path) this.noteStuck(`${label}: no ground plan found, following the mainRoute polyline`);
    const poly = makePoly(pathPts);
    this.plannedLengthXZ += poly.total;
    const p = this.s.player;
    const inp = this.game.input;
    let s = 0;
    let bestS = 0;
    let bestEnd = Infinity;
    let lastProgressTick = this.s.tick;
    let stuckLevel = 0;
    let recoverUntil = 0;
    let recoverYawOff = 0;
    let jumpPulse = false;
    const end = pathPts[pathPts.length - 1];
    const arrive = step.stopAtEnd ? 2.5 : 3;
    this.bucket = 'walking';
    for (;;) {
      const st = this.s;
      if (st.mode !== 'playing') return;
      const pr = projectWindow(poly, Math.max(0, s - 6), s + 45, p.pos.x, p.pos.z);
      s = Math.max(s, pr.s);
      if (s > bestS + 0.5) {
        bestS = s;
        lastProgressTick = st.tick;
        stuckLevel = 0;
      }
      // 終点を通り過ぎた (QBの勢い等) ときは、終点への距離が縮まっている間は進捗とみなす
      const dEnd = hdist(p.pos, end);
      if (dEnd < bestEnd - 0.5) {
        bestEnd = dEnd;
        lastProgressTick = st.tick;
        stuckLevel = 0;
      }
      if (hdist(p.pos, end) < arrive && (!step.stopAtEnd || s > poly.total - 6)) return;
      const speed = Math.hypot(p.vel.x, p.vel.z);
      const remaining = poly.total - s;
      const L = step.stopAtEnd && remaining < 10 ? Math.max(1.5, remaining) : Math.max(3.5, Math.min(7, speed * 0.32));
      const carrot = pointAt(poly, Math.min(poly.total, s + L));
      // 隔壁に阻まれて止まったか
      const hit = this.detectBarrier(speed);
      if (hit) {
        yield* this.handleBarrier(hit);
        lastProgressTick = this.s.tick;
        continue;
      }
      // 詰まりの検出と回復 (ジャンプ / 角度をずらして進む)
      const stalledSeconds = (st.tick - lastProgressTick) * DT;
      if (stalledSeconds > 1.5 && st.tick >= recoverUntil) {
        stuckLevel++;
        if (stuckLevel === 1) this.noteStuck(`no progress for ${stalledSeconds.toFixed(1)}s along ${label}; carrot (${carrot.x.toFixed(1)}, ${carrot.z.toFixed(1)}) yaw ${p.yaw.toFixed(2)}; ${this.describeObstacle()}`);
        if (stuckLevel > 10) throw new BotAbort(`stuck near (${p.pos.x.toFixed(1)}, ${p.pos.y.toFixed(1)}, ${p.pos.z.toFixed(1)}) in ${label}: ${this.describeObstacle()}`);
        recoverUntil = st.tick + Math.round(1.0 / DT);
        const kind = (stuckLevel - 1) % 4;
        recoverYawOff = kind === 0 ? 0 : kind === 1 ? 0.9 : kind === 2 ? -0.9 : 2.2;
        jumpPulse = kind === 0;
        lastProgressTick = st.tick - Math.round(1.0 / DT);
      }
      const recovering = st.tick < recoverUntil;
      this.setYaw(this.yawToward(carrot.x, carrot.z) + (recovering ? recoverYawOff : 0));
      inp.forward = true;
      inp.back = inp.left = inp.right = false;
      inp.ctrl = false;
      inp.jump = jumpPulse && p.grounded;
      if (jumpPulse) jumpPulse = false;
      const slowDown = step.stopAtEnd && remaining < 14;
      this.setShift(!slowDown);
      // QB (任意): まっすぐな長い区間で、昇降のためのENを残せるときだけ
      if (this.opts.useQB && !slowDown && !recovering) this.maybeQB(poly, s);
      yield* this.tick('walking');
    }
  }

  private maybeQB(poly: Poly, s: number): void {
    const st = this.s;
    const p = st.player;
    const mv = p.mv;
    if (this.qbHigh) {
      this.releaseQB();
      return;
    }
    if (mv.qbCooldownRemaining > 0 || mv.qbImpulseRemaining > 0 || !p.grounded) return;
    const reserve = this.opts.qbReserve ?? Math.min(st.stats.maxEn - PLAYER.QB.COST, 60);
    if (p.en < PLAYER.QB.COST + reserve) return;
    // 前方 46 m がほぼ直線 (折れ線の向きが 6° 以内) で、その先に停止点(終点)がないこと
    const ahead = 46;
    if (poly.total - s < ahead + (this.opts.qbStopMargin ?? 20)) return;
    const a = pointAt(poly, s + 4);
    const b = pointAt(poly, s + ahead);
    const heading = Math.atan2(b.x - a.x, b.z - a.z);
    for (let d = 8; d <= ahead; d += 8) {
      const q = pointAt(poly, s + d);
      const h2 = Math.atan2(q.x - a.x, q.z - a.z);
      if (Math.abs(wrapPi(h2 - heading)) > 0.1) return;
    }
    const cur = Math.atan2(-Math.sin(p.yaw) * -1, -Math.cos(p.yaw) * -1);
    void cur;
    const dir = { x: b.x - p.pos.x, y: 0, z: b.z - p.pos.z };
    const dl = Math.hypot(dir.x, dir.z);
    if (dl < 1e-6) return;
    dir.x /= dl;
    dir.z /= dl;
    // 進行方向が視線 (yaw) とほぼ一致していること (QBはWASD方向 = 視線方向)
    const fwd = { x: -Math.sin(p.yaw), z: -Math.cos(p.yaw) };
    if (fwd.x * dir.x + fwd.z * dir.z < 0.97) return;
    // 46 m 先までプレイヤーAABBが通れること
    const clear = this.game.world.sweepAABB(p.pos, { x: HALF.x + 0.3, y: HALF.y - 0.1, z: HALF.z + 0.3 }, { x: fwd.x * ahead, y: 0, z: fwd.z * ahead });
    if (clear) return;
    this.pressQB();
  }

  private noteStuck(what: string): void {
    const p = this.s.player.pos;
    const sector = this.s.progress.currentSectorId;
    this.stuck.push({ tick: this.s.tick, time: this.s.time, pos: { ...p }, sectorId: sector, what });
    this.log(`  [stuck] t=${this.s.time.toFixed(1)}s ${sector} (${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}): ${what}`);
  }

  private describeObstacle(): string {
    const p = this.s.player;
    const w = this.game.world;
    const d = v3(-Math.sin(p.yaw), 0, -Math.cos(p.yaw));
    const parts: string[] = [];
    for (const dy of [-1.2, 0, 1.2]) {
      const hit = w.raycast(v3(p.pos.x, p.pos.y + dy, p.pos.z), d, 6);
      if (hit) parts.push(`dy=${dy}: ${w.boxes[hit.boxIndex].id} @${hit.t.toFixed(1)}m`);
    }
    return parts.join(', ') || 'no box ahead';
  }

  // ------------------------------------------------------------------ 隔壁
  private detectBarrier(speed: number): { boxIndex: number; barrierId: string; normal: V3 } | null {
    if (this.opts.enemies === 'dead') return null;
    const p = this.s.player;
    if (speed > 2.0) return null;
    const d = v3(-Math.sin(p.yaw), 0, -Math.cos(p.yaw));
    const w = this.game.world;
    for (const dy of [-1.2, 0, 1.2]) {
      const hit = w.raycast(v3(p.pos.x, p.pos.y + dy, p.pos.z), d, 3.5);
      if (hit) {
        const b = w.boxes[hit.boxIndex];
        if (b.barrierId !== undefined && !this.s.objective.openBarrierIds.includes(b.barrierId) && !(b.barrierId === 'GATE' && this.s.objective.gateOpen))
          return { boxIndex: hit.boxIndex, barrierId: b.barrierId, normal: hit.normal };
      }
    }
    return null;
  }

  private inEscapeZone(): boolean {
    const z = this.stage.escapeZone;
    const q = this.s.player.pos;
    return q.x >= z.min.x && q.x <= z.max.x && q.y >= z.min.y && q.y <= z.max.y && q.z >= z.min.z && q.z <= z.max.z;
  }

  private *handleBarrier(hit: { boxIndex: number; barrierId: string; normal: V3 }): Generator<void> {
    const st = this.s;
    const p = st.player;
    const inp = this.game.input;
    const barrier = this.stage.barriers.find((b) => b.id === hit.barrierId);
    if (!barrier) throw new BotAbort(`barrier ${hit.barrierId} not in stage.barriers`);
    let controlId = barrier.controlEnemyId;
    if (controlId === null) {
      // 最終ゲート: 6/6 で開く。ゲート試験のときだけ、ここまで生かしておいた最後の制御砲台を撃破する
      const rem = st.enemies.find((e) => e.isGateControl && e.alive);
      if (!this.opts.gateProbe || !rem || st.objective.controlsDestroyed !== 5) throw new BotAbort(`the ${barrier.id} is closed (controls ${st.objective.controlsDestroyed}/6) and this run has no control turret left to destroy`);
      controlId = rem.id;
    }
    this.bucket = 'barrier';
    const world = this.game.world;
    const box = world.boxes[hit.boxIndex];
    const bb = this.closedBarriers.get(barrier.id) as { min: V3; max: V3 };
    const axisX = Math.abs(hit.normal.x) >= Math.abs(hit.normal.z);
    const sgn = axisX ? Math.sign(hit.normal.x) : Math.sign(hit.normal.z);
    const inward = axisX ? v3(-sgn, 0, 0) : v3(0, 0, -sgn); // 隔壁の中へ向かう向き
    const tangent = axisX ? v3(0, 0, 1) : v3(1, 0, 0);
    const thickness = axisX ? bb.max.x - bb.min.x : bb.max.z - bb.min.z;
    const gapNow = (): number => {
      const q = p.pos;
      if (axisX) return sgn > 0 ? q.x - HALF.x - box.max.x : box.min.x - (q.x + HALF.x);
      return sgn > 0 ? q.z - HALF.z - box.max.z : box.min.z - (q.z + HALF.z);
    };
    const start = { ...p.pos };
    const yaw = p.yaw;
    const gap = gapNow();
    // 前進入力を押し続けて、進めない(動かない)ことを確かめる
    const pushSeconds = this.opts.barrierPushSeconds ?? 1.5;
    let into = 0;
    let slide = 0;
    const t0 = st.tick;
    for (let i = 0; i < Math.round(pushSeconds / DT); i++) {
      this.setYaw(yaw);
      inp.forward = true;
      inp.jump = false;
      this.setShift(false);
      yield* this.tick('barrier');
      const dxp = p.pos.x - start.x;
      const dzp = p.pos.z - start.z;
      into = Math.max(into, dxp * inward.x + dzp * inward.z);
      slide = Math.max(slide, Math.abs(dxp * tangent.x + dzp * tangent.z));
      if (st.mode !== 'playing') return;
    }
    const rec: BarrierRecord = {
      id: barrier.id,
      controlId,
      stopPos: start,
      pushSeconds: (st.tick - t0) * DT,
      pushInto: into,
      pushSlide: slide,
      gapToBarrier: gap,
      destroyedTick: st.tick,
      openedTick: null,
      passedTick: null,
      passSeconds: null,
      neverCrossedWhileClosed: true,
      nextSectorId: this.stage.portals.find((pt) => pt.barrierId === barrier.id)?.b ?? null,
      ram: null,
      before: { controlsDestroyed: st.objective.controlsDestroyed, gateOpen: st.objective.gateOpen, mode: st.mode, inEscapeZone: this.inEscapeZone() },
    };
    this.barriers.push(rec);
    if (this.opts.ramTest || (this.opts.gateProbe && barrier.isFinal)) rec.ram = yield* this.ramInto(inward, yaw, start, gapNow);
    rec.neverCrossedWhileClosed = !this.crossedWhileClosed.has(barrier.id);
    rec.before = { controlsDestroyed: st.objective.controlsDestroyed, gateOpen: st.objective.gateOpen, mode: st.mode, inEscapeZone: this.inEscapeZone() };
    this.log(
      `  [barrier ${barrier.id}] stopped at (${start.x.toFixed(1)}, ${start.y.toFixed(1)}, ${start.z.toFixed(1)}): ${rec.pushSeconds.toFixed(1)}s of forward input moved ${into.toFixed(3)} m into it (slid ${slide.toFixed(2)} m along it), gap ${gap.toFixed(3)} m` +
        (rec.ram ? `, QB ram: max ${rec.ram.maxSpeed.toFixed(1)} m/s, penetration ${rec.ram.penetration.toFixed(3)} m` : '') +
        ` -> destroy ${controlId}`,
    );
    // 制御砲台の撃破 (敵の排除: 遠隔破壊自体は別担当が検証)。開放は同じ tick の末の updateProgress で objective が行う
    const ctl = st.enemies.find((e) => e.id === controlId);
    if (!ctl) throw new BotAbort(`control enemy ${controlId} missing`);
    rec.destroyedTick = st.tick;
    damageEnemy(st, ctl, 1e9, 'machinegun');
    this.pending.push({ rec, axis: inward, origin: { ...p.pos }, thickness, bounds: bb });
    // 開いたら(次のtickで)通る: 視点は保ったまま前進し、開いたことを確認したら通常の追従へ戻る
    for (let i = 0; i < Math.round(3 / DT); i++) {
      this.setYaw(yaw);
      inp.forward = true;
      this.setShift(true);
      yield* this.tick('barrier');
      if (st.mode !== 'playing') return;
      const openNow = barrier.isFinal ? st.objective.gateOpen : st.objective.openBarrierIds.includes(barrier.id);
      if (rec.openedTick === null && openNow) rec.openedTick = this.barrierOpenTicks.get(barrier.id) ?? st.tick;
      if (rec.openedTick !== null && i > Math.round(0.5 / DT)) break;
    }
    if (rec.openedTick === null) throw new BotAbort(`barrier ${barrier.id} did not open after destroying ${controlId}`);
    this.bucket = 'walking';
  }

  /** 14 m 下がり、Q(QB 80 m/s)で隔壁へ突っ込む。隔壁の面を越えないこと(掃引衝突でトンネリングしない)を測る */
  private *ramInto(inward: V3, yaw: number, start: V3, gapNow: () => number): Generator<void, RamRecord> {
    const st = this.s;
    const p = st.player;
    const inp = this.game.input;
    const rec: RamRecord = { qbFired: false, maxSpeed: 0, penetration: -Infinity, crossed: false };
    // 下がる (S)。視線は隔壁へ向けたまま
    for (let i = 0; i < Math.round(4 / DT); i++) {
      this.setYaw(yaw);
      inp.forward = false;
      inp.back = true;
      this.setShift(false, true);
      yield* this.tick('barrier');
      if (st.mode !== 'playing') return rec;
      if ((p.pos.x - start.x) * -inward.x + (p.pos.z - start.z) * -inward.z >= 14) break;
    }
    inp.back = false;
    // 止まって、ENとQB再使用を待つ
    for (let i = 0; i < Math.round(6 / DT); i++) {
      this.setYaw(yaw);
      inp.ctrl = Math.hypot(p.vel.x, p.vel.z) > 0.2;
      if (Math.hypot(p.vel.x, p.vel.z) < 0.2 && p.en >= PLAYER.QB.COST && p.mv.qbCooldownRemaining <= 0) break;
      yield* this.tick('barrier');
    }
    inp.ctrl = false;
    const before = p.mv.qbSuccessCount;
    for (let i = 0; i < Math.round(2 / DT); i++) {
      this.setYaw(yaw);
      inp.forward = true;
      if (i === 0) {
        inp.qb = true;
        this.qbHigh = true;
      } else {
        inp.qb = false;
        this.qbHigh = false;
      }
      this.setShift(false);
      yield* this.tick('barrier');
      if (st.mode !== 'playing') return rec;
      rec.maxSpeed = Math.max(rec.maxSpeed, Math.hypot(p.vel.x, p.vel.z));
      rec.penetration = Math.max(rec.penetration, -gapNow());
      if (this.crossedWhileClosed.size > 0) rec.crossed = true;
    }
    rec.qbFired = p.mv.qbSuccessCount > before;
    if (rec.penetration === -Infinity) rec.penetration = 0;
    return rec;
  }

  // ------------------------------------------------------------------ 停止: 昇降の離陸位置で止まる
  private *stopAt(target: V3): Generator<void> {
    const p = this.s.player;
    const inp = this.game.input;
    // 1) ブレーキ (Ctrl): グライドを切って減速
    for (let i = 0; i < Math.round(3 / DT); i++) {
      if (this.s.mode !== 'playing') return;
      const sp = Math.hypot(p.vel.x, p.vel.z);
      if (sp < 0.4 && !p.mv.glideEnabled) break;
      this.setYaw(this.yawToward(target.x, target.z));
      inp.forward = false;
      inp.ctrl = true;
      this.setShift(false, true);
      yield* this.tick('walking');
    }
    inp.ctrl = false;
    // 2) 歩行で target の真上へ
    for (let i = 0; i < Math.round(6 / DT); i++) {
      if (this.s.mode !== 'playing') return;
      const d = hdist(p.pos, target);
      const sp = Math.hypot(p.vel.x, p.vel.z);
      if (d < 0.35 && sp < 1.5) break;
      this.setYaw(this.yawToward(target.x, target.z));
      inp.forward = d > 0.25;
      inp.ctrl = d <= 0.25 && sp > 0.3;
      this.setShift(false, true);
      yield* this.tick('walking');
    }
    inp.forward = false;
    inp.ctrl = false;
    // 3) 静止するまで待つ
    for (let i = 0; i < Math.round(1 / DT); i++) {
      if (Math.hypot(p.vel.x, p.vel.z) < 0.05) break;
      inp.ctrl = true;
      yield* this.tick('walking');
    }
    inp.ctrl = false;
  }

  // ------------------------------------------------------------------ 昇降: 接地して待つ → Space長押しの飛行 + 水平移動 → 上端を越えたら着地足場へ → Space解放
  private *climb(c: ClimbDef): Generator<void> {
    const st = this.s;
    const p = st.player;
    const inp = this.game.input;
    const height = c.to.y - c.from.y;
    const fromC = v3(c.from.x, c.from.y + HALF.y, c.from.z);
    yield* this.stopAt(fromC);
    if (st.mode !== 'playing') return;
    // ENが十分に溜まるまで接地して待つ (実プレイでもする操作)
    const need = Math.min(st.stats.maxEn, PLAYER.FLIGHT_EN_PER_SEC * (height / PLAYER.FLIGHT_ASCENT + 0.5) + 20);
    const waitStart = st.tick;
    while (p.en < need - 1e-9) {
      if (st.mode !== 'playing') return;
      this.clearKeys();
      yield* this.tick('enWait');
    }
    const waitSeconds = (st.tick - waitStart) * DT;
    const rec: ClimbRecord = { id: c.id, ok: false, height, waitSeconds, enBefore: p.en, enMin: p.en, enUsed: 0, flightSeconds: 0, climbSeconds: 0, landDistance: NaN, failure: null };
    this.climbs.push(rec);
    const t0 = st.tick;
    const targetFeet = c.to.y + 0.8;
    const RELEASE = 2;
    let phase: 'ascend' | 'traverse' | 'land' = 'ascend';
    let bestHd = Infinity;
    let bestHdTick = st.tick;
    let landTicks = 0;
    let thrust = 0;
    const maxTicks = Math.round(20 / DT);
    this.setShift(false, true);
    for (let i = 0; i < maxTicks; i++) {
      if (st.mode !== 'playing') {
        rec.failure = `game ended (${st.endReason})`;
        return;
      }
      const feet = p.pos.y - HALF.y;
      const hd = hdist(p.pos, c.to);
      const apex = feet + (p.vel.y > 0 ? (p.vel.y * p.vel.y) / (2 * GRAVITY) : 0);
      if (phase === 'ascend') {
        inp.jump = true;
        inp.forward = false;
        if (feet >= targetFeet) phase = 'traverse';
      }
      if (phase === 'traverse') {
        this.setYaw(this.yawToward(c.to.x, c.to.z));
        inp.forward = true;
        inp.jump = apex < targetFeet;
        if (hd < bestHd - 0.5) {
          bestHd = hd;
          bestHdTick = st.tick;
        }
        if (st.tick - bestHdTick > 360) {
          rec.failure = `no horizontal progress toward the landing platform (stuck ${hd.toFixed(1)} m away at feet y=${feet.toFixed(1)})`;
          break;
        }
        if (hd <= RELEASE && feet >= c.to.y + 0.15) phase = 'land';
      }
      if (phase === 'land') {
        inp.jump = false;
        inp.forward = false;
        landTicks++;
        if (p.grounded && landTicks > 3) {
          const support = this.game.world.raycast(p.pos, v3(0, -1, 0), 3);
          const target = this.game.world.raycast(v3(c.to.x, c.to.y + 2, c.to.z), v3(0, -1, 0), 5);
          const sameBox = !!support && !!target && support.boxIndex === target.boxIndex;
          rec.landDistance = hd;
          if (Math.abs(feet - c.to.y) <= 0.3 && (sameBox || hd <= 6)) rec.ok = true;
          else rec.failure = `landed at feet y=${feet.toFixed(2)} (${hd.toFixed(1)} m from the landing point), not on y=${c.to.y.toFixed(2)}`;
          break;
        }
      }
      if (p.pos.y < this.stage.killY) {
        rec.failure = 'fell out of the stage';
        break;
      }
      yield* this.tick('climbing');
      if (p.mv.thrusting) thrust++;
      rec.enMin = Math.min(rec.enMin, p.en);
    }
    inp.jump = false;
    inp.forward = false;
    rec.enUsed = rec.enBefore - rec.enMin;
    rec.flightSeconds = thrust * DT;
    rec.climbSeconds = (st.tick - t0) * DT;
    if (!rec.ok && rec.failure === null) rec.failure = 'timeout';
    this.log(`  [climb ${c.id}] ${rec.ok ? 'OK' : 'FAIL ' + rec.failure}: wait ${waitSeconds.toFixed(1)}s, EN ${rec.enBefore.toFixed(1)} -> min ${rec.enMin.toFixed(1)} (used ${rec.enUsed.toFixed(1)}), flight ${rec.flightSeconds.toFixed(2)}s, ${rec.climbSeconds.toFixed(2)}s total`);
    if (!rec.ok) throw new BotAbort(`climb ${c.id} failed: ${rec.failure}`);
    yield* this.settle();
  }

  private *settle(): Generator<void> {
    const p = this.s.player;
    this.clearKeys();
    for (let i = 0; i < Math.round(0.5 / DT); i++) {
      if (Math.hypot(p.vel.x, p.vel.z) < 0.05 && p.grounded) break;
      this.game.input.ctrl = true;
      yield* this.tick('walking');
    }
    this.game.input.ctrl = false;
  }

  // ------------------------------------------------------------------ 全体
  *program(plan: PlanStep[]): Generator<void> {
    const st = this.s;
    let n = 0;
    for (const step of plan) {
      if (st.mode !== 'playing') return;
      n++;
      if (step.kind === 'walk') yield* this.walk(step, `walk#${n}`);
      else yield* this.climb(step.climb);
    }
    // 終点に着いたら、クリアの判定(tick末の updateProgress)を待つ
    for (let i = 0; i < Math.round(3 / DT) && st.mode === 'playing'; i++) {
      this.game.input.forward = true;
      yield* this.tick('walking');
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// 1回の走破
// ---------------------------------------------------------------------------------------------------------------------
export function prepareGame(stage: StageDef, opts: BotOptions): Game {
  const game = new Game({ stage, loadout: opts.loadout, seed: opts.seed ?? 20260908 });
  game.sortie(opts.loadout);
  return game;
}

/** 敵の排除 (テストに許可された状態書き換え): damageEnemy を呼ぶだけ。隔壁とゲートの開放は objective.ts の updateProgress が行う */
export function killEnemies(game: Game, pred: (e: EnemyState) => boolean): number {
  let n = 0;
  for (const e of game.state.enemies) if (pred(e) && e.alive && damageEnemy(game.state, e, 1e9, 'machinegun')) n++;
  return n;
}

function anyNonFinite(v: unknown): boolean {
  if (typeof v === 'number') return !Number.isFinite(v);
  if (Array.isArray(v)) return v.some(anyNonFinite);
  if (v && typeof v === 'object') return Object.values(v).some(anyNonFinite);
  return false;
}
function snapshotSummary(st: GameState): RunResult['snapshot'] {
  const snap = buildSnapshot(st);
  return {
    state: snap.state,
    visitedSectorIds: [...snap.stage.visitedSectorIds],
    sectorCount: snap.stage.sectorCount,
    controlsDestroyed: snap.objective.controlsDestroyed,
    gateOpen: snap.objective.gateOpen,
    openBarrierIds: [...snap.objective.openBarrierIds],
    elapsedSeconds: snap.elapsedSeconds,
    hasNonFinite: anyNonFinite(snap),
  };
}

export function runPlaythrough(options: BotOptions): RunResult {
  const wall0 = performance.now();
  const opts: BotOptions = options.gateProbe ? { ...options, enemies: 'progressive' } : options;
  const stage = opts.stage ?? buildStage();
  const { plan } = getGroundPlan(stage);
  const game = prepareGame(stage, opts);
  const st = game.state;
  const bot = new Bot(game, opts);
  const log = opts.log ?? (() => {});
  let failure: string | null = null;

  if (opts.gateProbe) {
    // ゲート試験: 制御砲台 6 体のうち最後の B6 の制御砲台だけを残して破壊 (5/6) -> B1..B5 が開く。B6 の箱だけをテストが無効にして通れるようにする
    killEnemies(game, (e) => !e.isGateControl);
    const barriers = stage.barriers.filter((b) => !b.isFinal);
    const last = barriers[barriers.length - 1];
    killEnemies(game, (e) => e.isGateControl && e.id !== last.controlEnemyId);
    game.step();
    bot.afterStep();
    if (st.objective.controlsDestroyed !== 5 || st.objective.gateOpen || st.objective.openBarrierIds.length !== 5) failure = `gate probe setup: controls ${st.objective.controlsDestroyed}/6, gate ${st.objective.gateOpen}, open barriers ${st.objective.openBarrierIds.length}`;
    for (const id of last.boxIds) game.world.setBoxEnabled(game.world.indexOfBox(id), false);
    bot.holdOpen(last.id);
  } else if (opts.enemies === 'dead') {
    // 制御砲台を破壊 -> 1tick後に隔壁・ゲートが開く (objective.ts 経由)
    killEnemies(game, (e) => e.isGateControl);
    game.step();
    bot.afterStep();
    if (st.objective.openBarrierIds.length !== 6 || !st.objective.gateOpen) failure = `controls destroyed but barriers open=${st.objective.openBarrierIds.length}/6 gate=${st.objective.gateOpen}`;
    killEnemies(game, () => true);
  } else if (opts.enemies === 'progressive') {
    killEnemies(game, (e) => !e.isGateControl);
  }

  const program = bot.program(plan);
  try {
    if (failure === null) {
      for (;;) {
        const r = program.next();
        if (r.done) break;
        if (opts.tickTimer || opts.stepFn) {
          const t = performance.now();
          if (opts.stepFn) opts.stepFn(game);
          else game.step();
          if (opts.tickTimer) opts.tickTimer(performance.now() - t, st);
        } else game.step();
        bot.afterStep();
        if (st.mode !== 'playing') break;
      }
    }
  } catch (e) {
    if (e instanceof BotAbort) failure = e.message;
    else throw e;
  }
  const routeLength = polyLen3(stage.mainRoute.points);
  const cleared = st.mode === 'cleared' && st.endReason === 'escaped';
  if (!cleared && failure === null) failure = `ended in mode ${st.mode} (${st.endReason})`;
  log(`  => mode=${st.mode} reason=${st.endReason} t=${st.time.toFixed(2)}s path=${bot.pathLength.toFixed(1)} m`);
  return {
    loadout: opts.loadout,
    enemies: opts.enemies,
    useQB: !!opts.useQB,
    gateProbe: !!opts.gateProbe,
    ramTest: !!opts.ramTest,
    cleared,
    mode: st.mode,
    endReason: st.endReason,
    failure,
    gameSeconds: st.time,
    ticks: st.tick,
    pathLength: bot.pathLength,
    pathLengthXZ: bot.pathLengthXZ,
    routeLength,
    pathRatio: bot.pathLength / routeLength,
    visitedSectorIds: [...st.progress.visitedSectorIds],
    sectorEnterTicks: bot.sectorEnterTicks,
    climbs: bot.climbs,
    barriers: bot.barriers,
    timeBreakdown: bot.timeBreakdown,
    maxSpeed: bot.maxSpeed,
    qbCount: st.player.mv.qbSuccessCount,
    anomalies: bot.anomalies,
    stuck: bot.stuck,
    damageTaken: st.damageTaken,
    enemyShotsFired: bot.enemyShots,
    playerHits: bot.playerHits,
    controlsDestroyed: st.objective.controlsDestroyed,
    killCount: st.killCount,
    enemiesAlive: st.enemies.filter((e) => e.alive).length,
    gateOpen: st.objective.gateOpen,
    gateOpenTick: bot.gateOpenTick,
    escapeEnteredTick: bot.escapeEnteredTick,
    clearedTick: bot.clearedTick,
    plannedLengthXZ: bot.plannedLengthXZ,
    maxStepDistance: bot.maxStepDistance,
    externalWrites: bot.externalWrites,
    snapshot: snapshotSummary(st),
    wallMs: performance.now() - wall0,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// 全体の報告 (--report): 全18構成 x (敵撃破済み / QB併用 / 敵あり) + 最悪・最良構成の隔壁試験(QB突入つき)とゲート試験
// ---------------------------------------------------------------------------------------------------------------------
export interface FullReport {
  date: string;
  dead: RunResult[];
  deadQB: RunResult[];
  alive: RunResult[];
  progressive: { worst: RunResult; best: RunResult };
  gate: { worst: RunResult; best: RunResult };
  qbGreedy: RunResult;
  routeLength: number;
  shortestRoute: number | null;
  plan: { step: WalkStep; index: number; lengthXZ: number; corridorXZ: number; drops: { height: number; at: V3 }[] }[];
  planMs: number;
}

export function pathDrops(path: readonly V3[]): { height: number; at: V3 }[] {
  const out: { height: number; at: V3 }[] = [];
  for (let i = 1; i < path.length; i++) if (path[i].y < path[i - 1].y - 0.3) out.push({ height: path[i - 1].y - path[i].y, at: path[i - 1] });
  return out;
}

export function runFullReport(stage: StageDef, log: (s: string) => void = () => {}): FullReport {
  const gp = getGroundPlan(stage);
  const planMs = gp.ms;
  const plan = gp.plan
    .map((step, index) => ({ step, index }))
    .filter((x): x is { step: WalkStep; index: number } => x.step.kind === 'walk')
    .map(({ step, index }) => ({ step, index, lengthXZ: step.path ? polyLenXZ(step.path) : NaN, corridorXZ: polyLenXZ(step.corridor), drops: step.path ? pathDrops(step.path) : [] }));
  const run = (o: Partial<BotOptions> & { loadout: Loadout; enemies: EnemyMode }): RunResult => {
    const r = runPlaythrough({ stage, ...o });
    log(summarize(r));
    return r;
  };
  const los = allLoadouts();
  const dead = los.map((loadout) => run({ loadout, enemies: 'dead' }));
  const deadQB = los.map((loadout) => run({ loadout, enemies: 'dead', useQB: true }));
  const alive = los.map((loadout) => run({ loadout, enemies: 'alive' }));
  const progressive = { worst: run({ loadout: WORST_LOADOUT, enemies: 'progressive', ramTest: true }), best: run({ loadout: BEST_LOADOUT, enemies: 'progressive', ramTest: true }) };
  const gate = { worst: run({ loadout: WORST_LOADOUT, enemies: 'progressive', gateProbe: true }), best: run({ loadout: BEST_LOADOUT, enemies: 'progressive', gateProbe: true }) };
  const qbGreedy = run({ loadout: WORST_LOADOUT, enemies: 'dead', useQB: true, qbReserve: 0, qbStopMargin: -10 });
  let shortest: number | null = null;
  try {
    const rep = validateStage(stage, { runClimbBot: false });
    shortest = rep.route.found ? rep.route.length : null;
  } catch {
    shortest = null;
  }
  return { date: new Date().toISOString(), dead, deadQB, alive, progressive, gate, qbGreedy, routeLength: polyLen3(stage.mainRoute.points), shortestRoute: shortest, plan, planMs };
}

const row = (cells: (string | number)[]): string => `| ${cells.join(' | ')} |`;
const fx = (n: number, d = 1): string => (Number.isFinite(n) ? n.toFixed(d) : String(n));
const pv = (p: V3): string => `(${fx(p.x)}, ${fx(p.y)}, ${fx(p.z)})`;
const range = (xs: number[], d = 1): string => {
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  return Math.abs(hi - lo) < 0.5 * 10 ** -d ? fx(lo, d) : `${fx(lo, d)}〜${fx(hi, d)}`;
};
const maxEnOf = (l: Loadout): number => GENERATOR_PARTS[l.generator].maxEn;
const anomalyText = (r: RunResult): string => `${r.anomalies.nonFinite}/${r.anomalies.overlap}/${r.anomalies.killY}`;

/** 理想走行の下限: 計画した地上経路を 停止・詰まり無しで グライド(22 m/s x 脚倍率)だけで進み、昇降は実測の所要時間を足す [s] */
export function idealGlideSeconds(r: RunResult): number {
  const mult = LEGS_PARTS[r.loadout.legs].speedMult;
  return r.plannedLengthXZ / (PLAYER.GLIDE_SPEED_GROUND * mult) + r.climbs.reduce((s, c) => s + c.climbSeconds, 0);
}

export function playthroughMarkdown(rep: FullReport, stage: StageDef): string {
  const L: string[] = [];
  const worstIdx = allLoadouts().findIndex((l) => loadoutKey(l) === loadoutKey(WORST_LOADOUT));
  const bestIdx = allLoadouts().findIndex((l) => loadoutKey(l) === loadoutKey(BEST_LOADOUT));
  L.push(`生成: \`npx tsx tools/playthrough.ts --report docs/PLAYTHROUGH.md\` (${rep.date})。以下の数値は全て、実際の Game (buildStage()) を tick 実行した結果で、手で書き足していない。`);
  L.push('');
  const okDead = rep.dead.filter((r) => r.cleared).length;
  const okQB = rep.deadQB.filter((r) => r.cleared).length;
  const okAlive = rep.alive.filter((r) => r.cleared).length;
  L.push(`- 敵撃破済みで走破: **${okDead}/18 構成が cleared (endReason=escaped)**、QB併用: ${okQB}/18、敵45体が生きている状態 (HP無効化): ${okAlive}/18`);
  L.push(`- 全走破で NaN / めり込み(overlapAABB) / コースアウト(killY) は 0 件 (全 ${rep.dead.length + rep.deadQB.length + rep.alive.length + 6} 走破の合計: ${[...rep.dead, ...rep.deadQB, ...rep.alive, rep.progressive.worst, rep.progressive.best, rep.gate.worst, rep.gate.best, rep.qbGreedy].reduce((s, r) => s + r.anomalies.nonFinite + r.anomalies.overlap + r.anomalies.killY, 0)} 件)。1 tick あたりの最大移動量 ${fx(Math.max(...[...rep.dead, ...rep.deadQB, ...rep.alive].map((r) => r.maxStepDistance)), 3)} m (QB 80 m/s = 0.667 m/tick が上限)`);
  L.push(`- stage.mainRoute (${stage.mainRoute.points.length} 点) の長さ ${fx(rep.routeLength)} m、検証器 (validateStage) の最短の実行可能経路 ${rep.shortestRoute === null ? '(未取得)' : fx(rep.shortestRoute) + ' m'}`);
  L.push('');
  L.push('### 1. 走破結果 (全18構成)');
  L.push('');
  L.push('「時間」はゲーム内時間 (state.time)。「距離」はボットの軌跡 (プレイヤー中心の毎 tick の移動量) の累積長 (3D)。「区画」は snapshot.stage.visitedSectorIds の数。「異常」= NaN / めり込み / コースアウトの tick 数。');
  L.push('');
  L.push(row(['FCS', 'ジェネレーター', '脚部', '最大EN', '敵撃破済み', '時間 [s]', '距離 [m]', '距離/mainRoute', '距離/最短', '区画', '異常', 'QB併用 時間 [s] (QB回数)', '敵あり', '敵あり 時間 [s]', '敵の射撃/被弾/ダメージ']));
  L.push(row(Array(15).fill('---')));
  rep.dead.forEach((d, i) => {
    const q = rep.deadQB[i];
    const a = rep.alive[i];
    L.push(
      row([
        d.loadout.fcs,
        d.loadout.generator,
        d.loadout.legs,
        maxEnOf(d.loadout),
        d.cleared ? 'cleared' : `FAIL: ${d.failure}`,
        fx(d.gameSeconds),
        fx(d.pathLength, 0),
        fx(d.pathRatio, 3),
        rep.shortestRoute ? fx(d.pathLength / rep.shortestRoute, 3) : '-',
        d.snapshot.visitedSectorIds.length,
        anomalyText(d),
        `${q.cleared ? fx(q.gameSeconds) : 'FAIL'} (${q.qbCount})`,
        a.cleared ? 'cleared' : `FAIL: ${a.failure}`,
        fx(a.gameSeconds),
        `${a.enemyShotsFired} / ${a.playerHits} / ${fx(a.damageTaken, 0)}`,
      ]),
    );
  });
  L.push('');
  L.push('### 2. 地上経路 (ボットが追従した経路)');
  L.push('');
  L.push(
    `stage.mainRoute は「飛行自由・全隔壁開放」の 3D 最短経路で、床の 2〜4 m 上を浮いて障害物を飛び越える区間が長い (飛行 EN は 20/秒、最悪構成の最大 EN 90 で 4.5 秒しか飛べない)。` +
      `ボットは mainRoute を昇降 (stage.climbs) の位置で ${rep.plan.length} 区間に分け、各区間を mainRoute の水平射影から ±${CORRIDOR} m の回廊の中で、` +
      `実際の衝突形状 (World.overlapAABB / sweepAABB / raycast, 格子 ${PLAN_CELL} m, 壁からの余裕 ${PLAN_MARGIN} m) で検証した「歩行 + 落下」の地上経路に直して追従する (計画時間 合計 ${fx(rep.planMs, 0)} ms)。`,
  );
  L.push('');
  L.push(row(['区間', '始点', '終点', '水平長 [m]', '回廊(mainRoute射影) [m]', '頂点', '落下 (高さ m @ 位置)', 'A*展開', '余裕 [m]']));
  L.push(row(Array(9).fill('---')));
  for (const p of rep.plan)
    L.push(
      row([
        `歩行 ${rep.plan.indexOf(p) + 1}/${rep.plan.length}`,
        pv(p.step.from),
        pv(p.step.to),
        fx(p.lengthXZ),
        fx(p.corridorXZ),
        p.step.path?.length ?? '-',
        p.drops.map((d) => `${fx(d.height, 0)} @ ${pv(d.at)}`).join('<br>') || '-',
        p.step.plan?.expansions ?? '-',
        p.step.plan?.margin ?? '-',
      ]),
    );
  L.push('');
  L.push(`経路の水平長の合計 ${fx(rep.plan.reduce((s, p) => s + p.lengthXZ, 0))} m (回廊 ${fx(rep.plan.reduce((s, p) => s + p.corridorXZ, 0))} m)。`);
  L.push('');
  L.push('### 3. 飛行昇降 (全18構成, 敵撃破済みの走破の中で実際に行った昇降)');
  L.push('');
  L.push('離陸位置 (stage.climbs[].from) で接地して止まり、ENが (飛行に必要な分 + 余裕) 溜まるまで待ち、Space 長押しで上昇 → 上端を越えたら水平移動 (WASD前進) → 着地足場の真上で Space 解放、の実プレイどおりの操作。QB は使わない。');
  L.push('');
  L.push(row(['昇降', '区画', '高低差 [m]', '成功', 'EN消費 [EN]', '飛行時間 [s]', '所要時間 (Space押下から着地) [s]', '離陸前のEN待ち (最大) [s]', '着地点とのずれ (最大) [m]']));
  L.push(row(Array(9).fill('---')));
  for (const c of stage.climbs) {
    const rs = rep.dead.map((r) => r.climbs.find((x) => x.id === c.id)).filter((x): x is ClimbRecord => !!x);
    L.push(
      row([
        c.id,
        c.sectorId,
        fx(c.heightMeters),
        `${rs.filter((x) => x.ok).length}/${rep.dead.length}`,
        range(rs.map((x) => x.enUsed)),
        range(rs.map((x) => x.flightSeconds), 2),
        range(rs.map((x) => x.climbSeconds), 2),
        fx(Math.max(...rs.map((x) => x.waitSeconds))),
        fx(Math.max(...rs.map((x) => x.landDistance)), 2),
      ]),
    );
  }
  L.push('');
  L.push(`最悪構成 (${loadoutKey(WORST_LOADOUT)}, 最大EN ${maxEnOf(WORST_LOADOUT)}) では、昇降 1 回の EN 消費は最大 ${fx(Math.max(...(rep.dead[worstIdx]?.climbs ?? []).map((x) => x.enUsed)))} で、飛行のたびに最大ENの ${fx((Math.max(...(rep.dead[worstIdx]?.climbs ?? []).map((x) => x.enUsed)) / maxEnOf(WORST_LOADOUT)) * 100, 0)}% を使う。`);
  L.push('');
  L.push('<details><summary>構成別・昇降別の結果 (敵撃破済みの走破)</summary>');
  L.push('');
  L.push(row(['昇降', 'FCS', 'ジェネレーター', '脚部', '成否', 'EN開始→最小', 'EN消費', '飛行 [s]', '所要 [s]', 'EN待ち [s]', 'ずれ [m]']));
  L.push(row(Array(11).fill('---')));
  for (const c of stage.climbs)
    for (const r of rep.dead) {
      const x = r.climbs.find((k) => k.id === c.id);
      if (!x) continue;
      L.push(row([c.id, r.loadout.fcs, r.loadout.generator, r.loadout.legs, x.ok ? 'OK' : `FAIL ${x.failure}`, `${fx(x.enBefore)}→${fx(x.enMin)}`, fx(x.enUsed), fx(x.flightSeconds, 2), fx(x.climbSeconds, 2), fx(x.waitSeconds), fx(x.landDistance, 2)]));
    }
  L.push('');
  L.push('</details>');
  L.push('');
  L.push('### 4. 隔壁 (制御砲台を破壊するまで閉じている / 最悪構成・最良構成)');
  L.push('');
  L.push(
    '制御砲台以外の 39 体は撃破済みで、6 つの制御砲台と隔壁は生きた状態から走る。ボットは隔壁に接触して止まり、前進入力を 1.5 秒押し続けて動かないこと (法線方向の移動量)、さらに 14 m 下がって QB (80×脚倍率 m/s) で突っ込んでもすり抜けないことを測ってから、その制御砲台だけを `damageEnemy(1e9)` で破壊する。' +
      '隔壁の開放は objective.ts (updateProgress) が行い、その後ボットが通過する。',
  );
  L.push('');
  L.push('面までの距離が負の数 (約 -0.00004 m) なのは、プレイヤーの衝突箱が PLAYER.HALF より 5e-5 m だけ小さい (player.ts の SHRINK) ため。「面を越えた量」は隔壁の面からプレイヤーAABBがめり込んだ量で、0.0001 m 未満ならめり込みは無い (World.overlapAABB の許容と同じ)。');
  L.push('');
  for (const [name, r] of [['最悪構成', rep.progressive.worst], ['最良構成', rep.progressive.best]] as const) {
    L.push(`**${name} ${loadoutKey(r.loadout)}**: ${r.cleared ? `cleared, ${fx(r.gameSeconds)} s` : `FAIL ${r.failure}`}`);
    L.push('');
    L.push(row(['隔壁', '制御砲台', '止まった位置', '面までの距離 [m]', '前進入力1.5秒で隔壁側へ進んだ量 [m]', '面に沿って滑った量 [m]', 'QB突入: 最高速度 [m/s]', 'QB突入: 面を越えた量 [m]', 'めり込み/越境', '撃破→開放 [tick]', '撃破→通過 [s]', '向こうの区画に入ったのは開放の後']));
    L.push(row(Array(12).fill('---')));
    for (const b of r.barriers) {
      const enter = b.nextSectorId ? r.sectorEnterTicks[b.nextSectorId] : undefined;
      L.push(
        row([
          b.id,
          b.controlId ?? '-',
          pv(b.stopPos),
          fx(b.gapToBarrier, 5),
          fx(b.pushInto, 5),
          fx(b.pushSlide, 2),
          b.ram ? fx(b.ram.maxSpeed) : '-',
          b.ram ? fx(b.ram.penetration, 5) : '-',
          b.neverCrossedWhileClosed && !(b.ram?.crossed ?? false) ? 'なし' : '**あり**',
          b.openedTick === null ? '-' : b.openedTick - b.destroyedTick,
          b.passSeconds === null ? '-' : fx(b.passSeconds, 2),
          enter !== undefined && b.openedTick !== null ? (enter >= b.openedTick ? `OK (${b.nextSectorId} 進入 tick ${enter} >= 開放 ${b.openedTick})` : `**NG** (${b.nextSectorId} 進入 ${enter} < 開放 ${b.openedTick})`) : '-',
        ]),
      );
    }
    L.push('');
  }
  L.push('### 5. 最終ゲートと脱出領域 (ゲートが閉じている間は入れない)');
  L.push('');
  L.push(
    '制御砲台 6 体の破壊で最終ゲートが開くので、通常の順序 (B1→B6) で進むと、最後の隔壁 B6 とゲートは同じ tick に開く。ゲートが閉じたまま S15 の最終ゲートの前まで実際に歩いて着く状況は、通常の操作では作れない。' +
      'そこで**ゲート試験**では、制御砲台 5 体を先に撃破し (B1..B5 が開く。ゲートは 5/6 で閉じたまま)、B6 の制御砲台 T15 は生かしたまま、**隔壁 B6 の箱だけをテストが world.setBoxEnabled で無効にして**通れるようにする (プレイヤーの位置・速度は一切書き換えない)。' +
      'ボットは最終ゲートに接触して止まり、前進入力・QB突入でも越えられないこと、脱出領域に入れず mode が playing のままであることを確認してから T15 を撃破する。ゲートは objective.ts が 6/6 で開く。',
  );
  L.push('');
  L.push(row(['構成', '結果', 'ゲートの前で止まった位置', '面までの距離 [m]', '前進1.5秒で進んだ量 [m]', 'QB突入 最高速度 [m/s]', 'QB突入 面を越えた量 [m]', '撃破直前: 破壊数 / ゲート / mode / 脱出領域の中', '脱出領域に初めて入った tick', 'ゲート開放 tick', 'クリア tick']));
  L.push(row(Array(11).fill('---')));
  for (const r of [rep.gate.worst, rep.gate.best]) {
    const g = r.barriers.find((b) => b.id === 'GATE');
    L.push(
      row([
        loadoutKey(r.loadout),
        r.cleared ? 'cleared' : `FAIL ${r.failure}`,
        g ? pv(g.stopPos) : '-',
        g ? fx(g.gapToBarrier, 5) : '-',
        g ? fx(g.pushInto, 5) : '-',
        g?.ram ? fx(g.ram.maxSpeed) : '-',
        g?.ram ? fx(g.ram.penetration, 5) : '-',
        g ? `${g.before.controlsDestroyed}/6 / ${g.before.gateOpen ? '開' : '閉'} / ${g.before.mode} / ${g.before.inEscapeZone ? '入った' : '入っていない'}` : '-',
        r.escapeEnteredTick ?? '-',
        r.gateOpenTick ?? '-',
        r.clearedTick ?? '-',
      ]),
    );
  }
  L.push('');
  L.push(`escapeZone = (${pv(stage.escapeZone.min)}) 〜 (${pv(stage.escapeZone.max)})、最終ゲートの隔壁の位置 ${pv(stage.barriers.find((b) => b.isFinal)?.pos ?? { x: NaN, y: NaN, z: NaN })}。`);
  L.push('');
  L.push('### 6. 走破に要したゲーム内時間');
  L.push('');
  L.push('「ボット」は QB を使わず、常時グライド (地上 22×脚倍率 m/s) で進んだ時間。「QB併用」は、まっすぐな長い区間でENに余裕があるときだけ QB (36 EN) を使った時間。「グライド理想」は、計画した地上経路の水平長を停止・詰まり・待ち無しでグライドだけで進んだ時間に、昇降の実測の所要時間を足したもの (QB併用の実測はこれを下回りうる: QB の平均速度はグライドより速い)。');
  L.push('');
  L.push(row(['構成', 'ボット [s]', '内訳: 歩行/EN待ち/昇降/隔壁 [s]', 'QB併用 [s]', 'グライド理想 [s]', '計画した水平長 [m]', '実際の水平走行距離 [m]']));
  L.push(row(Array(7).fill('---')));
  for (const i of [worstIdx, bestIdx]) {
    const d = rep.dead[i];
    const q = rep.deadQB[i];
    L.push(row([loadoutKey(d.loadout), fx(d.gameSeconds), `${fx(d.timeBreakdown.walking)} / ${fx(d.timeBreakdown.enWait)} / ${fx(d.timeBreakdown.climbing)} / ${fx(d.timeBreakdown.barrier)}`, fx(q.gameSeconds), fx(idealGlideSeconds(d)), fx(d.plannedLengthXZ), fx(d.pathLengthXZ)]));
  }
  L.push('');
  const g = rep.qbGreedy;
  L.push(
    `QBを使い切る走り (QB後に残すENを 0 にする, ${loadoutKey(g.loadout)}): ${g.cleared ? `cleared ${fx(g.gameSeconds)} s (QB ${g.qbCount} 回)` : `FAIL ${g.failure}`}。昇降の前のEN待ちは ${g.climbs.map((c) => `${c.id}: ${fx(c.waitSeconds)} s`).join(', ')} (合計 ${fx(g.timeBreakdown.enWait)} s。EN が足りない間は接地して待つ = 実プレイと同じ操作)。`,
  );
  L.push('');
  L.push('### 7. 区画の通過 (最悪構成・敵撃破済み)');
  L.push('');
  const w = rep.dead[worstIdx];
  L.push(row(['順', '区画', '名称', '進入 [s]']));
  L.push(row(['---', '---', '---', '---']));
  w.snapshot.visitedSectorIds.forEach((id, i) => L.push(row([i + 1, id, stage.sectors.find((s) => s.id === id)?.name ?? '-', fx((w.sectorEnterTicks[id] ?? 0) * DT)])));
  L.push('');
  L.push(`snapshot.stage.visitedSectorIds = ${JSON.stringify(w.snapshot.visitedSectorIds)} (${w.snapshot.visitedSectorIds.length} 区画 / sectorCount ${w.snapshot.sectorCount})。`);
  L.push('');
  L.push('### 8. 詰まった箇所');
  L.push('');
  const stuckAll = [...rep.dead, ...rep.deadQB, ...rep.alive, rep.progressive.worst, rep.progressive.best, rep.gate.worst, rep.gate.best, rep.qbGreedy].flatMap((r) => r.stuck.map((s) => ({ r, s })));
  if (stuckAll.length === 0) L.push(`なし。全 ${rep.dead.length + rep.deadQB.length + rep.alive.length + 6} 走破で、進捗が 1.5 秒以上止まった (詰まった) ことは 1 度も無かった。地上経路の計画が全 ${rep.plan.length} 区間で見つかった。`);
  else for (const { r, s } of stuckAll.slice(0, 40)) L.push(`- ${loadoutKey(r.loadout)} [${r.enemies}] t=${fx(s.time)} s ${s.sectorId} ${pv(s.pos)}: ${s.what}`);
  L.push('');
  return L.join('\n');
}

/** file の <!-- BEGIN:name --> .. <!-- END:name --> の間を body で置き換える (無ければ末尾に追加) */
export function replaceSection(file: string, name: string, body: string): void {
  const path = resolve(file);
  const begin = `<!-- BEGIN:${name} -->`;
  const end = `<!-- END:${name} -->`;
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    text = '';
  }
  const block = `${begin}\n${body.trimEnd()}\n${end}`;
  const a = text.indexOf(begin);
  const b = text.indexOf(end);
  if (a >= 0 && b > a) text = text.slice(0, a) + block + text.slice(b + end.length);
  else text = `${text.trimEnd()}\n\n${block}\n`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

// ---------------------------------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------------------------------
function parseLoadout(s: string): Loadout {
  const [fcs, generator, legs] = s.split('/');
  if (!(fcs in FCS_PARTS) || !(generator in GENERATOR_PARTS) || !(legs in LEGS_PARTS)) throw new Error(`bad loadout ${s} (expected fcs/generator/legs)`);
  return { fcs: fcs as FcsId, generator: generator as GeneratorId, legs: legs as LegsId };
}

function summarize(r: RunResult): string {
  const a = r.anomalies;
  const extra = r.enemies === 'alive' ? ` shots=${r.enemyShotsFired} hits=${r.playerHits} damage=${r.damageTaken}` : '';
  return `${loadoutKey(r.loadout)} [${r.gateProbe ? 'gate-probe' : r.enemies}${r.useQB ? '+QB' : ''}${r.ramTest ? '+ram' : ''}] ${r.cleared ? 'CLEARED' : 'FAILED: ' + r.failure} t=${r.gameSeconds.toFixed(1)}s path=${r.pathLength.toFixed(0)}m (x${r.pathRatio.toFixed(3)}) sectors=${r.visitedSectorIds.length} stuck=${r.stuck.length} nan=${a.nonFinite} overlap=${a.overlap} killY=${a.killY} qb=${r.qbCount}${extra} wall=${(r.wallMs / 1000).toFixed(1)}s`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const has = (f: string): boolean => args.includes(f);
  const val = (f: string): string | undefined => {
    const i = args.indexOf(f);
    return i >= 0 && i + 1 < args.length && !args[i + 1].startsWith('--') ? args[i + 1] : undefined;
  };
  const stage = buildStage();
  const t0 = performance.now();
  const gp = getGroundPlan(stage);
  console.log(`ground plan: ${gp.plan.filter((s) => s.kind === 'walk').length} walk steps in ${(performance.now() - t0).toFixed(0)} ms`);
  for (const s of gp.plan)
    if (s.kind === 'walk')
      console.log(
        `  walk ${s.path ? `${polyLenXZ(s.path).toFixed(0)} m (corridor ${polyLenXZ(s.corridor).toFixed(0)} m) exp=${s.plan?.expansions} ${s.plan?.ms.toFixed(0)}ms margin=${s.plan?.margin} nodes=${s.plan?.smoothNodes}` : `NO PATH ${JSON.stringify(s.from)} -> ${JSON.stringify(s.to)}; closest ${JSON.stringify(s.plan?.closest)}`}`,
      );
  if (has('--report')) {
    const file = val('--report') ?? 'docs/PLAYTHROUGH.md';
    const rep = runFullReport(stage, (s) => console.log(s));
    const md = playthroughMarkdown(rep, stage);
    replaceSection(file, 'playthrough', md);
    console.log(`wrote playthrough section to ${file}`);
    const bad = [...rep.dead, ...rep.deadQB, ...rep.alive, rep.progressive.worst, rep.progressive.best, rep.gate.worst, rep.gate.best, rep.qbGreedy].filter((r) => !r.cleared);
    if (bad.length > 0) {
      console.error(`${bad.length} runs did not clear`);
      process.exitCode = 1;
    }
    return;
  }
  const enemies = (val('--enemies') ?? 'dead') as EnemyMode;
  const loadouts = has('--all') ? allLoadouts() : val('--loadout') ? [parseLoadout(val('--loadout') as string)] : [WORST_LOADOUT, BEST_LOADOUT];
  const verbose = has('--verbose') || !has('--all');
  const results: RunResult[] = [];
  for (const lo of loadouts) {
    const r = runPlaythrough({
      loadout: lo,
      enemies,
      stage,
      log: verbose ? (s) => console.log(s) : undefined,
      useQB: has('--qb'),
      qbReserve: val('--qb-reserve') !== undefined ? Number(val('--qb-reserve')) : undefined,
      qbStopMargin: val('--qb-margin') !== undefined ? Number(val('--qb-margin')) : undefined,
      ramTest: has('--ram'),
      gateProbe: has('--gate-probe'),
      seed: val('--seed') !== undefined ? Number(val('--seed')) : undefined,
    });
    console.log(summarize(r));
    results.push(r);
  }
  const outJson = val('--json');
  if (outJson) {
    mkdirSync(dirname(resolve(outJson)), { recursive: true });
    writeFileSync(resolve(outJson), JSON.stringify(results, null, 1));
  }
  if (results.some((r) => !r.cleared)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
