/**
 * route-probe: ステージ設計の調整用の簡易プローブ (厳密な検証は src/stage/validate.ts)。
 *   npx tsx tools/route-probe.ts                 スタート→脱出領域の最短経路長 / 通過区画 / 分岐別長さ / 昇降と経路の距離
 *   npx tsx tools/route-probe.ts --step 1        格子1m (既定2m)
 *   npx tsx tools/route-probe.ts --emit          src/stage/routes.ts を生成 (mainRoute と分岐の折れ線)
 *   npx tsx tools/route-probe.ts --barriers      隔壁を1つだけ閉じたとき脱出領域に着けないこと + 外周が閉じていること
 *
 * 方法: プレイヤーAABB(1.6x3.0x1.6 + 横0.05m余裕)の配置空間を3Dボクセル化し(箱をAABB分だけ膨らませて格子に描画)、26近傍A*
 * (対角移動は通過する立方体の角が全て空きであること) → 実際の World.sweepAABB で検証する taut-string 平滑化。
 * 平滑化後の長さは「実行可能な経路」の長さ(=真の最短の上界)。飛行・落下は自由(垂直移動にENの制約は掛けない)。全隔壁は開放。
 * 関数(probeStage / barrierCuts / perimeterLeak)は tests/stage-blueprint.test.ts からも使う。
 */
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { PLAYER } from '../src/config';
import { World } from '../src/sim/world';
import type { StageDef, V3 } from '../src/sim/types';
import { buildStage } from '../src/stage';
import { BRANCH_SPECS } from '../src/stage/blueprint';
import type { RouteLeg } from '../src/stage/blueprint';

const CLEAR = 0.05;
const HALF: V3 = { x: PLAYER.HALF.x + CLEAR, y: PLAYER.HALF.y, z: PLAYER.HALF.z + CLEAR };
const v3 = (x: number, y: number, z: number): V3 => ({ x, y, z });
const dist = (a: V3, b: V3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const polyLen = (p: V3[]): number => p.reduce((s, q, i) => (i ? s + dist(p[i - 1], q) : 0), 0);

// ---------------------------------------------------------------------------------------------------------------------
// 格子
// ---------------------------------------------------------------------------------------------------------------------
class Grid {
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly n: number;
  readonly blocked: Uint8Array;
  constructor(readonly ox: number, readonly oy: number, readonly oz: number, readonly h: number, ext: V3) {
    this.nx = Math.ceil(ext.x / h) + 1;
    this.ny = Math.ceil(ext.y / h) + 1;
    this.nz = Math.ceil(ext.z / h) + 1;
    this.n = this.nx * this.ny * this.nz;
    this.blocked = new Uint8Array(this.n);
  }
  idx(i: number, j: number, k: number): number { return (k * this.ny + j) * this.nx + i; }
  inb(i: number, j: number, k: number): boolean { return i >= 0 && j >= 0 && k >= 0 && i < this.nx && j < this.ny && k < this.nz; }
  pos(n: number): V3 {
    const i = n % this.nx;
    const j = Math.floor(n / this.nx) % this.ny;
    const k = Math.floor(n / (this.nx * this.ny));
    return v3(this.ox + i * this.h, this.oy + j * this.h, this.oz + k * this.h);
  }
  near(p: V3): number {
    return this.idx(Math.round((p.x - this.ox) / this.h), Math.round((p.y - this.oy) / this.h), Math.round((p.z - this.oz) / this.h));
  }
  /** 箱を(プレイヤー半寸法ぶん)膨らませて格子に描画 */
  paint(min: V3, max: V3, val: number): void {
    const lo = [min.x - HALF.x, min.y - HALF.y, min.z - HALF.z];
    const hi = [max.x + HALF.x, max.y + HALF.y, max.z + HALF.z];
    const o = [this.ox, this.oy, this.oz];
    const nn = [this.nx, this.ny, this.nz];
    const r: number[][] = [];
    for (let a = 0; a < 3; a++) {
      const i0 = Math.max(0, Math.floor((lo[a] - o[a]) / this.h));
      const i1 = Math.min(nn[a] - 1, Math.ceil((hi[a] - o[a]) / this.h));
      const list: number[] = [];
      for (let i = i0; i <= i1; i++) {
        const c = o[a] + i * this.h;
        if (c > lo[a] + 1e-7 && c < hi[a] - 1e-7) list.push(i);
      }
      r.push(list);
    }
    for (const k of r[2]) for (const j of r[1]) for (const i of r[0]) this.blocked[this.idx(i, j, k)] = val;
  }
}

function buildGrid(stage: StageDef, world: World, step: number): Grid {
  let mn = v3(Infinity, Infinity, Infinity);
  let mx = v3(-Infinity, -Infinity, -Infinity);
  for (const s of stage.sectors) {
    mn = v3(Math.min(mn.x, s.bounds.min.x), Math.min(mn.y, s.bounds.min.y), Math.min(mn.z, s.bounds.min.z));
    mx = v3(Math.max(mx.x, s.bounds.max.x), Math.max(mx.y, s.bounds.max.y), Math.max(mx.z, s.bounds.max.z));
  }
  // 格子の外縁は少し余らせる(外周の漏れを検出するため)。y は 床+1.5 が格子点になるよう -14.5 起点
  const pad = 4;
  const g = new Grid(mn.x - pad, -14.5 - Math.ceil((14.5 + mn.y) / step) * step, mn.z - pad, step, v3(mx.x - mn.x + 2 * pad, mx.y - mn.y + 2 * pad, mx.z - mn.z + 2 * pad));
  stage.boxes.forEach((b, i) => {
    if (world.isBoxEnabled(i)) g.paint(b.min, b.max, 1);
  });
  return g;
}

// ---------------------------------------------------------------------------------------------------------------------
// A* (26近傍, 二分ヒープ)
// ---------------------------------------------------------------------------------------------------------------------
class Heap {
  private k = new Float64Array(1 << 16);
  private v = new Int32Array(1 << 16);
  size = 0;
  push(key: number, val: number): void {
    if (this.size === this.k.length) {
      const k2 = new Float64Array(this.size * 2);
      k2.set(this.k);
      this.k = k2;
      const v2 = new Int32Array(this.size * 2);
      v2.set(this.v);
      this.v = v2;
    }
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.k[p] <= key) break;
      this.k[i] = this.k[p];
      this.v[i] = this.v[p];
      i = p;
    }
    this.k[i] = key;
    this.v[i] = val;
  }
  pop(): number {
    const top = this.v[0];
    const key = this.k[--this.size];
    const val = this.v[this.size];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.size) break;
      if (c + 1 < this.size && this.k[c + 1] < this.k[c]) c++;
      if (this.k[c] >= key) break;
      this.k[i] = this.k[c];
      this.v[i] = this.v[c];
      i = c;
    }
    this.k[i] = key;
    this.v[i] = val;
    return top;
  }
}

const OFFS: { d: [number, number, number]; cost: number }[] = [];
for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy || dz) OFFS.push({ d: [dx, dy, dz], cost: Math.hypot(dx, dy, dz) });

function astar(g: Grid, start: number, isGoal: (n: number) => boolean, hfun: (p: V3) => number, allow?: (p: V3) => boolean): number[] | null {
  const gs = new Float32Array(g.n).fill(Infinity);
  const par = new Int32Array(g.n).fill(-1);
  const closed = new Uint8Array(g.n);
  const heap = new Heap();
  gs[start] = 0;
  heap.push(hfun(g.pos(start)), start);
  while (heap.size) {
    const n = heap.pop();
    if (closed[n]) continue;
    closed[n] = 1;
    if (isGoal(n)) {
      const out: number[] = [];
      for (let c = n; c >= 0; c = par[c]) out.push(c);
      return out.reverse();
    }
    const i = n % g.nx;
    const j = Math.floor(n / g.nx) % g.ny;
    const k = Math.floor(n / (g.nx * g.ny));
    for (const o of OFFS) {
      const ii = i + o.d[0], jj = j + o.d[1], kk = k + o.d[2];
      if (!g.inb(ii, jj, kk)) continue;
      const m = g.idx(ii, jj, kk);
      if (g.blocked[m] || closed[m]) continue;
      if (allow && !allow(g.pos(m))) continue;
      if ((o.d[0] !== 0 ? 1 : 0) + (o.d[1] !== 0 ? 1 : 0) + (o.d[2] !== 0 ? 1 : 0) > 1) {
        let ok = true;
        for (let sx = 0; sx <= 1 && ok; sx++) for (let sy = 0; sy <= 1 && ok; sy++) for (let sz = 0; sz <= 1 && ok; sz++) {
          if (!(sx | sy | sz)) continue;
          if (g.blocked[g.idx(i + sx * o.d[0], j + sy * o.d[1], k + sz * o.d[2])]) ok = false;
        }
        if (!ok) continue;
      }
      const ng = gs[n] + o.cost * g.h;
      if (ng < gs[m]) {
        gs[m] = ng;
        par[m] = n;
        heap.push(ng + hfun(g.pos(m)), m);
      }
    }
  }
  return null;
}

/** 到達可能セルの塗りつぶし(BFS, 6近傍) */
function flood(g: Grid, start: number): Uint8Array {
  const seen = new Uint8Array(g.n);
  const stack: number[] = [start];
  seen[start] = 1;
  while (stack.length) {
    const n = stack.pop() as number;
    const i = n % g.nx;
    const j = Math.floor(n / g.nx) % g.ny;
    const k = Math.floor(n / (g.nx * g.ny));
    for (const [di, dj, dk] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const ii = i + di, jj = j + dj, kk = k + dk;
      if (!g.inb(ii, jj, kk)) continue;
      const m = g.idx(ii, jj, kk);
      if (g.blocked[m] || seen[m]) continue;
      seen[m] = 1;
      stack.push(m);
    }
  }
  return seen;
}

// ---------------------------------------------------------------------------------------------------------------------
// 平滑化 (実際の sweepAABB で検証)
// ---------------------------------------------------------------------------------------------------------------------
function makeFree(world: World): (a: V3, b: V3) => boolean {
  return (a, b) => !world.sweepAABB(a, HALF, v3(b.x - a.x, b.y - a.y, b.z - a.z));
}

function smooth(pts: V3[], free: (a: V3, b: V3) => boolean): V3[] {
  const out: V3[] = [pts[0]];
  let i = 0;
  while (i < pts.length - 1) {
    let j = pts.length - 1;
    while (j > i + 1 && !free(pts[i], pts[j])) j--;
    out.push(pts[j]);
    i = j;
  }
  // 収束するまで(頂点を1つ飛ばせるなら飛ばす)
  let changed = true;
  while (changed) {
    changed = false;
    for (let k = 1; k < out.length - 1; k++) {
      if (free(out[k - 1], out[k + 1])) {
        out.splice(k, 1);
        changed = true;
        k--;
      }
    }
  }
  return out;
}

interface RouteResult { points: V3[]; gridLength: number; length: number }

function shortest(g: Grid, free: (a: V3, b: V3) => boolean, a: V3, goal: V3 | ((n: number) => boolean), goalPoint?: (p: V3) => number, allow?: (p: V3) => boolean): RouteResult | null {
  const s = g.near(a);
  if (g.blocked[s]) throw new Error(`start ${JSON.stringify(a)} is blocked`);
  let isGoal: (n: number) => boolean;
  let hfun: (p: V3) => number;
  if (typeof goal === 'function') {
    isGoal = goal;
    hfun = goalPoint as (p: V3) => number;
  } else {
    const t = g.near(goal);
    if (g.blocked[t]) throw new Error(`goal ${JSON.stringify(goal)} is blocked`);
    isGoal = (n) => n === t;
    hfun = (p) => dist(p, goal);
  }
  const path = astar(g, s, isGoal, hfun, allow);
  if (!path) return null;
  const raw = path.map((n) => g.pos(n));
  const gridLength = polyLen(raw);
  const pts = smooth(raw, free);
  return { points: pts, gridLength, length: polyLen(pts) };
}

// ---------------------------------------------------------------------------------------------------------------------
// 経路の指定(分岐のアンカー: プレイヤー中心座標。床+1.5)
// ---------------------------------------------------------------------------------------------------------------------
function chain(stage: StageDef, g: Grid, free: (a: V3, b: V3) => boolean, spec: { start: V3; legs: RouteLeg[] }): V3[] {
  const out: V3[] = [];
  let cur = spec.start;
  for (const leg of spec.legs) {
    const boxes = leg.within.map((id) => stage.sectors.find((s) => s.id === id)!.bounds);
    const allow = (p: V3): boolean => boxes.some((b) => p.x >= b.min.x && p.x <= b.max.x && p.y >= b.min.y && p.y <= b.max.y && p.z >= b.min.z && p.z <= b.max.z);
    const r = shortest(g, free, cur, leg.to, undefined, allow);
    if (!r) throw new Error(`no path ${JSON.stringify(cur)} -> ${JSON.stringify(leg.to)} within ${leg.within.join(',')}`);
    out.push(...(out.length ? r.points.slice(1) : r.points));
    cur = leg.to;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// 公開API
// ---------------------------------------------------------------------------------------------------------------------
const between = (p: V3, b: { min: V3; max: V3 }): boolean => p.x >= b.min.x && p.x <= b.max.x && p.y >= b.min.y && p.y <= b.max.y && p.z >= b.min.z && p.z <= b.max.z;
const sectorAt = (stage: StageDef, p: V3): string => stage.sectors.find((s) => between(p, s.bounds))?.id ?? '-';

export interface ProbeResult {
  step: number;
  cells: number;
  gridLength: number;
  length: number;
  straight: number;
  points: V3[];
  sectors: string[];
  entries: { sectorId: string; at: number }[];
  climbs: { id: string; sectorId: string; height: number; horizontal: number; pathDistance: number }[];
  branches: { id: string; split: string; merge: string; routes: { id: string; length: number; sectors: string[]; points: V3[] }[] }[];
}

/** 全隔壁を開放した World */
function openWorld(stage: StageDef): { world: World; barrierIdx: Map<string, number[]> } {
  const world = new World(stage.boxes);
  const barrierIdx = new Map<string, number[]>();
  for (const b of stage.barriers) barrierIdx.set(b.id, b.boxIds.map((id) => world.indexOfBox(id)));
  for (const idxs of barrierIdx.values()) for (const i of idxs) world.setBoxEnabled(i, false);
  return { world, barrierIdx };
}

function segSegDist(p: V3, q: V3, a: V3, b: V3): number {
  let best = Infinity;
  const na = Math.max(2, Math.ceil(dist(a, b) / 0.25));
  const nq = Math.max(2, Math.ceil(dist(p, q) / 0.25));
  for (let i = 0; i <= na; i++) {
    const s = v3(a.x + ((b.x - a.x) * i) / na, a.y + ((b.y - a.y) * i) / na, a.z + ((b.z - a.z) * i) / na);
    for (let k = 0; k <= nq; k++) {
      const t = v3(p.x + ((q.x - p.x) * k) / nq, p.y + ((q.y - p.y) * k) / nq, p.z + ((q.z - p.z) * k) / nq);
      best = Math.min(best, dist(s, t));
    }
  }
  return best;
}

/** スタート→脱出領域の最短経路(全隔壁開放)、区画通過、昇降と経路の距離、分岐別の長さ */
export function probeStage(stage: StageDef, opts: { step?: number } = {}): ProbeResult {
  const step = opts.step ?? 2;
  const { world } = openWorld(stage);
  const grid = buildGrid(stage, world, step);
  const free = makeFree(world);
  const zone = stage.escapeZone;
  const inZone = (p: V3): boolean => between(p, zone);
  const zoneDist = (p: V3): number => Math.hypot(Math.max(zone.min.x - p.x, 0, p.x - zone.max.x), Math.max(zone.min.y - p.y, 0, p.y - zone.max.y), Math.max(zone.min.z - p.z, 0, p.z - zone.max.z));
  const main = shortest(grid, free, stage.playerStart.pos, (n) => inZone(grid.pos(n)), zoneDist);
  if (!main) throw new Error('route not found (start -> escape zone)');
  const entries: { sectorId: string; at: number }[] = [];
  let acc = 0;
  let prev = '';
  for (let i = 1; i < main.points.length; i++) {
    const a = main.points[i - 1], b = main.points[i];
    const len = dist(a, b);
    const n = Math.max(1, Math.ceil(len));
    for (let q = 0; q < n; q++) {
      const sid = sectorAt(stage, v3(a.x + ((b.x - a.x) * q) / n, a.y + ((b.y - a.y) * q) / n, a.z + ((b.z - a.z) * q) / n));
      if (sid !== prev && sid !== '-') {
        entries.push({ sectorId: sid, at: acc + (len * q) / n });
        prev = sid;
      }
    }
    acc += len;
  }
  const climbs = stage.climbs.map((c) => {
    const a = v3(c.from.x, c.from.y + PLAYER.HALF.y, c.from.z);
    const b = v3(c.to.x, c.to.y + PLAYER.HALF.y, c.to.z);
    let best = Infinity;
    for (let i = 1; i < main.points.length; i++) best = Math.min(best, segSegDist(main.points[i - 1], main.points[i], a, b));
    return { id: c.id, sectorId: c.sectorId, height: c.heightMeters, horizontal: Math.hypot(c.to.x - c.from.x, c.to.z - c.from.z), pathDistance: best };
  });
  const branches = stage.branches.map((b) => ({
    id: b.id,
    split: b.splitSectorId,
    merge: b.mergeSectorId,
    routes: b.routes.map((r) => {
      const pts = chain(stage, grid, free, BRANCH_SPECS[r.id]);
      return { id: r.id, length: polyLen(pts), sectors: sectorsOf(stage, pts), points: pts };
    }),
  }));
  return {
    step: grid.h,
    cells: grid.n,
    gridLength: main.gridLength,
    length: main.length,
    straight: dist(stage.playerStart.pos, main.points[main.points.length - 1]),
    points: main.points,
    sectors: sectorsOf(stage, main.points),
    entries,
    climbs,
    branches,
  };
}

function sectorsOf(stage: StageDef, pts: V3[]): string[] {
  const out: string[] = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const n = Math.max(1, Math.ceil(dist(a, b)));
    for (let q = i === 1 ? 0 : 1; q <= n; q++) {
      const sid = sectorAt(stage, v3(a.x + ((b.x - a.x) * q) / n, a.y + ((b.y - a.y) * q) / n, a.z + ((b.z - a.z) * q) / n));
      if (sid !== '-' && !out.includes(sid)) out.push(sid);
    }
  }
  return out;
}

/** 隔壁を1つだけ閉じた状態(他は開放)でスタートから脱出領域に着けるか。着けなければ隔壁は必須(迂回できない) */
export function barrierCuts(stage: StageDef, step = 2): { id: string; goalReachable: boolean }[] {
  const { world, barrierIdx } = openWorld(stage);
  const out: { id: string; goalReachable: boolean }[] = [];
  for (const [id, idxs] of barrierIdx) {
    for (const i of idxs) world.setBoxEnabled(i, true);
    const g = buildGrid(stage, world, step);
    const seen = flood(g, g.near(stage.playerStart.pos));
    let goal = false;
    for (let n = 0; n < g.n && !goal; n++) if (seen[n] && between(g.pos(n), stage.escapeZone)) goal = true;
    out.push({ id, goalReachable: goal });
    for (const i of idxs) world.setBoxEnabled(i, false);
  }
  return out;
}

/** 全隔壁開放で到達できる自由空間のうち、どの区画boundsにも入らないセル数(0なら外周が閉じている) */
export function perimeterLeak(stage: StageDef, step = 2): { reachable: number; outside: number } {
  const { world } = openWorld(stage);
  const g = buildGrid(stage, world, step);
  const seen = flood(g, g.near(stage.playerStart.pos));
  let reachable = 0;
  let outside = 0;
  for (let n = 0; n < g.n; n++) {
    if (!seen[n]) continue;
    reachable++;
    if (sectorAt(stage, g.pos(n)) === '-') outside++;
  }
  return { reachable, outside };
}

/** routes.ts の中身(--emit) */
export function routesSource(res: ProbeResult): string {
  const r2 = (n: number): string => String(Math.round(n * 100) / 100);
  const fmtPts = (pts: V3[]): string => `[${pts.map((p) => `p(${r2(p.x)}, ${r2(p.y)}, ${r2(p.z)})`).join(', ')}]`;
  let s = `/**\n * GENERATED by \`npx tsx tools/route-probe.ts --emit\` (grid step ${res.step} m) — do not edit by hand.\n * mainRoute = スタート→脱出領域の最短経路(全隔壁開放・飛行可)。分岐は各2経路が同じ始点・終点を共有する。\n */\n`;
  s += `import type { V3 } from '../sim/types';\n\nconst p = (x: number, y: number, z: number): V3 => ({ x, y, z });\n\n`;
  s += `export const ROUTE_MAIN_POINTS: V3[] = ${fmtPts(res.points)};\n\n`;
  s += `export const ROUTE_BRANCH_POINTS: Record<string, V3[]> = {\n`;
  for (const b of res.branches) for (const r of b.routes) s += `  '${r.id}': ${fmtPts(r.points)},\n`;
  s += `};\n`;
  return s;
}

// ---------------------------------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------------------------------
const fmt = (n: number, d = 1): string => n.toFixed(d);

function main(): void {
  const args = process.argv.slice(2);
  const step = Number(args[args.indexOf('--step') + 1]) || 2;
  const t0 = Date.now();
  const stage = buildStage();
  console.log(`stage: ${stage.sectors.length} sectors, ${stage.boxes.length} boxes, ${stage.enemies.length} enemies (player half ${fmt(HALF.x, 2)}/${fmt(HALF.y, 2)}/${fmt(HALF.z, 2)}, all barriers open)`);
  const res = probeStage(stage, { step });
  console.log(`\n== 最短経路 (全隔壁開放・飛行可, 格子 ${res.step} m / ${res.cells} セル) ==`);
  console.log(`  格子A*の長さ ${fmt(res.gridLength)} m / 平滑化(sweepAABB検証済み) ${fmt(res.length)} m  [要件 >= 1500 m, 目標 >= 1800 m]`);
  console.log(`  直線距離(下限) ${fmt(res.straight)} m`);
  console.log(`  通過区画 ${res.sectors.length}: ${res.sectors.join(' -> ')}`);
  console.log(`  区画入場(累積m): ${res.entries.map((e) => `${e.sectorId}@${fmt(e.at, 0)}`).join(' ')}`);
  if (args.includes('--dump')) console.log('  route points: ' + res.points.map((p) => `(${fmt(p.x)},${fmt(p.y)},${fmt(p.z)})`).join(' '));
  console.log('\n== 昇降 (最短経路からの距離 <= 12 m が必要) ==');
  for (const c of res.climbs) console.log(`  ${c.id} ${c.sectorId}: 高さ ${fmt(c.height)} m, from->to 水平 ${fmt(c.horizontal)} m, 経路との距離 ${fmt(c.pathDistance)} m ${c.pathDistance <= 12 ? 'OK' : 'NG'}`);
  console.log('\n== 分岐 (経路長は各区間のA*最短を連結) ==');
  for (const b of res.branches) {
    const ls = b.routes.map((r) => r.length);
    console.log(`  ${b.id} (${b.split}->${b.merge}): ${b.routes.map((r) => `${r.id} ${fmt(r.length)} m [${r.sectors.join('>')}]`).join(' | ')} | 迂回−直行 = ${fmt(ls[1] - ls[0])} m`);
  }
  if (args.includes('--barriers')) {
    console.log('\n== 隔壁(1つだけ閉鎖)・外周 ==');
    for (const r of barrierCuts(stage, step)) console.log(`  ${r.id} だけ閉鎖: 脱出領域に${r.goalReachable ? '到達できる(NG: 迂回路あり)' : '到達できない(OK)'}`);
    const leak = perimeterLeak(stage, step);
    console.log(`  全隔壁開放で到達可能なセル ${leak.reachable}, うち区画boundsの外 ${leak.outside} ${leak.outside === 0 ? '(外周は閉じている)' : '(NG: 外に出られる)'}`);
  }
  if (args.includes('--emit')) {
    writeFileSync(new URL('../src/stage/routes.ts', import.meta.url), routesSource(res));
    console.log('\nwrote src/stage/routes.ts');
  }
  console.log(`\ntotal ${(Date.now() - t0) / 1000} s`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
