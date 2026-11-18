// ステージ規模・構造の検証とレポート出力（npm run verify:stage）
// - 開口グラフによる最短経路の下限（各区画内を直線で結ぶため、実際の最短経路以下の値）
// - 分岐・環状経路・必須昇降箇所・広い戦闘区画・敵配置・射線
// - 全18構成でのオートパイロット走破（実際の衝突・EN・飛行で推奨経路を通過できるか）
import { writeFileSync, mkdirSync } from 'node:fs';
import { ENEMY, FCS, GENERATORS, LEGS, PLAYER, computeEffectiveStats, type FcsId, type GeneratorId, type LegsId, type Loadout } from '../src/config';
import { Game, EMPTY_INPUT, type StepInput } from '../src/sim/game';
import { buildStage } from '../src/stage/build';
import { BARRIERS, BRANCHES, ENEMIES, ESCAPE_ZONE, FLIGHT_ASCENTS, PORTALS, ROUTE, SECTORS, START } from '../src/stage/layout';
import type { AABB } from '../src/stage/types';
import type { V3 } from '../src/math';

const out: string[] = [];
const log = (s = '') => {
  out.push(s);
  console.log(s);
};
let failures = 0;
const check = (ok: boolean, msg: string) => {
  log(`${ok ? '  [OK]  ' : '  [NG]  '}${msg}`);
  if (!ok) failures++;
};

function boxDist(a: AABB, b: AABB): number {
  let s = 0;
  for (let i = 0; i < 3; i++) {
    const g = Math.max(0, a.min[i] - b.max[i], b.min[i] - a.max[i]);
    s += g * g;
  }
  return Math.sqrt(s);
}

const stage = buildStage();
log('# AK2 ステージ検証レポート');
log('');
log(`生成日時: ${new Date().toISOString()}`);
log(`衝突箱数: ${stage.boxes.length} / 隔壁: ${stage.barriers.length}`);
log('');

// ---------------------------------------------------------------- 区画
log('## 1. 区画');
log('');
log('| ID | 名称 | 空間構成 | x0..x1 | z0..z1 | 床..天井 | 水平寸法 |');
log('| --- | --- | --- | --- | --- | --- | --- |');
for (const s of SECTORS) {
  log(`| ${s.id} | ${s.name} | ${s.spaceType} | ${s.x0}..${s.x1} | ${s.z0}..${s.z1} | ${s.floor}..${s.ceil} | ${s.x1 - s.x0}×${s.z1 - s.z0} |`);
}
log('');
check(SECTORS.length >= 15, `区画数 ${SECTORS.length} ≥ 15`);
// 内部空間の重なりがないこと
let overlap = 0;
for (let i = 0; i < SECTORS.length; i++)
  for (let j = i + 1; j < SECTORS.length; j++) {
    const a = SECTORS[i],
      b = SECTORS[j];
    if (a.x0 < b.x1 + 2 - 1e-6 && b.x0 < a.x1 + 2 - 1e-6 && a.z0 < b.z1 + 2 - 1e-6 && b.z0 < a.z1 + 2 - 1e-6 && a.floor - 1 < b.ceil + 1 && b.floor - 1 < a.ceil + 1) {
      // 壁厚を含めて重なるのは隣接のみ許容（内部空間どうしの重なりは不可）
      if (a.x0 < b.x1 && b.x0 < a.x1 && a.z0 < b.z1 && b.z0 < a.z1 && a.floor < b.ceil && b.floor < a.ceil) {
        overlap++;
        log(`  内部空間の重なり: ${a.id} / ${b.id}`);
      }
    }
  }
check(overlap === 0, '区画の内部空間が互いに重ならない（壁で分離）');
const big = SECTORS.filter((s) => Math.min(s.x1 - s.x0, s.z1 - s.z0) >= 50 && Math.max(s.x1 - s.x0, s.z1 - s.z0) >= 60);
check(big.length >= 5, `60m×50m以上の広い区画 ${big.length} 箇所（${big.map((s) => s.id).join(', ')}）`);
const types = new Set(SECTORS.map((s) => s.spaceType));
check(types.size >= 6, `空間構成の種類 ${types.size} 種（${[...types].join('、')}）`);
const bands = new Set(SECTORS.map((s) => (s.floor < 0 ? '地下' : s.floor < 10 ? '地上' : s.floor < 20 ? '中層' : '上層')));
check(bands.size >= 3, `高度帯 ${bands.size} 層（${[...bands].join('、')}）。S13(床-14)の真上にS14(床0)、S06は中二階(26)と下階(12)`);

// ---------------------------------------------------------------- 接続
log('');
log('## 2. 接続（開口）と隔壁');
log('');
log('| 開口 | 区画A | 区画B | 箱 min | 箱 max | 隔壁 |');
log('| --- | --- | --- | --- | --- | --- |');
for (const p of PORTALS) log(`| ${p.id} | ${p.a} | ${p.b} | ${p.box.min.join(',')} | ${p.box.max.join(',')} | ${p.barrierId ?? ''} |`);
log('');
for (const b of BARRIERS) {
  const ctrl = b.controlId ? ENEMIES.find((e) => e.id === b.controlId) : null;
  log(`- ${b.id}: ${b.label}（開口 ${b.portalId}、制御: ${b.controlId ?? '制御砲台6体全て'}${ctrl ? `＠${ctrl.sectorId} (${ctrl.pos.join(', ')})` : ''}）`);
}
log('');

// ---------------------------------------------------------------- 下限最短経路
interface Node {
  id: string;
  box: AABB;
  sector: string;
}
const nodes: Node[] = [];
const startBox: AABB = { min: [...START.pos] as V3, max: [START.pos[0], START.pos[1] + 0.01, START.pos[2]] };
nodes.push({ id: 'START', box: startBox, sector: 'S01' });
for (const p of PORTALS) nodes.push({ id: p.id, box: p.box, sector: `${p.a}|${p.b}` });
for (const s of SECTORS) for (const ip of s.internalPortals ?? []) nodes.push({ id: ip.id, box: ip.box, sector: s.id });
nodes.push({ id: 'ESCAPE', box: ESCAPE_ZONE, sector: 'S19' });

// 各ゾーン（区画またはその内部ゾーン）に属する開口
interface Zone {
  id: string;
  sector: string;
  box: AABB;
  members: number[];
}
const zones: Zone[] = [];
for (const s of SECTORS) {
  const sBox: AABB = { min: [s.x0, s.floor, s.z0], max: [s.x1, s.ceil, s.z1] };
  const zs = s.zones ?? [{ id: s.id, box: sBox }];
  for (const z of zs) zones.push({ id: z.id, sector: s.id, box: z.box, members: [] });
}
nodes.forEach((n, i) => {
  for (const z of zones) {
    let belongs = false;
    if (n.id === 'START') belongs = z.sector === 'S01';
    else if (n.id === 'ESCAPE') belongs = z.sector === 'S19';
    else {
      const p = PORTALS.find((q) => q.id === n.id);
      if (p) belongs = (p.a === z.sector || p.b === z.sector) && boxDist(p.box, z.box) <= 2.01;
      else {
        const s = SECTORS.find((q) => q.id === z.sector)!;
        const ip = (s.internalPortals ?? []).find((q) => q.id === n.id);
        belongs = !!ip && (ip.a === z.id || ip.b === z.id);
      }
    }
    if (belongs) z.members.push(i);
  }
});
// Dijkstra
const adj: { to: number; w: number; zone: string }[][] = nodes.map(() => []);
for (const z of zones) {
  for (const a of z.members)
    for (const b of z.members) {
      if (a === b) continue;
      adj[a].push({ to: b, w: boxDist(nodes[a].box, nodes[b].box), zone: z.id });
    }
}
function dijkstra(src: number, dst: number, banned: Set<string> = new Set()) {
  const dist = nodes.map(() => Infinity);
  const prev: { n: number; zone: string }[] = nodes.map(() => ({ n: -1, zone: '' }));
  const done = nodes.map(() => false);
  dist[src] = 0;
  for (;;) {
    let u = -1;
    for (let i = 0; i < nodes.length; i++) if (!done[i] && (u < 0 || dist[i] < dist[u])) u = i;
    if (u < 0 || dist[u] === Infinity) break;
    done[u] = true;
    if (u === dst) break;
    for (const e of adj[u]) {
      const zs = SECTORS.find((s) => s.id === zones.find((z) => z.id === e.zone)!.sector)!.id;
      if (banned.has(zs)) continue;
      if (dist[u] + e.w < dist[e.to]) {
        dist[e.to] = dist[u] + e.w;
        prev[e.to] = { n: u, zone: e.zone };
      }
    }
  }
  const path: string[] = [];
  const zseq: string[] = [];
  let c = dst;
  while (c >= 0) {
    path.push(nodes[c].id);
    if (prev[c].n >= 0) zseq.push(prev[c].zone);
    c = prev[c].n;
  }
  return { d: dist[dst], path: path.reverse(), zones: zseq.reverse() };
}
const sIdx = 0,
  eIdx = nodes.length - 1;
const lb = dijkstra(sIdx, eIdx);
log('## 3. 最短経路の下限（開口グラフ）');
log('');
log('各区画（内壁で分割された区画は内部ゾーン）の中を、開口の箱どうしの最短直線距離で結んだグラフ上の最短路。');
log('区画は床・壁・天井で密閉され開口以外から出入りできないため、実際に実行可能な最短経路はこの値以上になる。');
log('');
log(`- 下限距離: **${lb.d.toFixed(1)} m**`);
log(`- 経由する開口: ${lb.path.join(' → ')}`);
const secSeq: string[] = [];
for (const z of lb.zones) {
  const s = zones.find((q) => q.id === z)!.sector;
  if (secSeq[secSeq.length - 1] !== s) secSeq.push(s);
}
log(`- 通過区画（${new Set(secSeq).size}区画）: ${secSeq.join(' → ')}`);
check(lb.d >= 1500, `スタートから脱出領域までの最短距離の下限 ${lb.d.toFixed(1)} m ≥ 1500 m`);
check(new Set(secSeq).size >= 12, `最短経路が物理的に通過する異なる区画 ${new Set(secSeq).size} ≥ 12`);

// 区画グラフ：全経路で通過区画数の最小値
const sAdj = new Map<string, string[]>();
for (const s of SECTORS) sAdj.set(s.id, []);
for (const p of PORTALS) {
  sAdj.get(p.a)!.push(p.b);
  sAdj.get(p.b)!.push(p.a);
}
{
  const q: [string, number][] = [['S01', 1]];
  const seen = new Set(['S01']);
  let minCount = -1;
  while (q.length) {
    const [u, c] = q.shift()!;
    if (u === 'S19') {
      minCount = c;
      break;
    }
    for (const v of sAdj.get(u)!) if (!seen.has(v)) {
      seen.add(v);
      q.push([v, c + 1]);
    }
  }
  check(minCount >= 12, `区画グラフ上、どの経路を選んでも通過する区画数の最小値 ${minCount} ≥ 12`);
}

// 分岐：各分岐の短経路・長経路それぞれを禁止した場合の下限
log('');
log('## 4. 分岐と環状経路');
log('');
for (const br of BRANCHES) {
  const viaShort = dijkstra(sIdx, eIdx, new Set([br.long]));
  const viaLong = dijkstra(sIdx, eIdx, new Set([br.short]));
  log(`- 分岐${br.id}: ${br.from} → {短:${br.short} / 長:${br.long}} → ${br.to}。${br.note}`);
  log(`  - 短経路を使う全体下限 ${viaShort.d.toFixed(1)} m / 長経路を使う全体下限 ${viaLong.d.toFixed(1)} m（差 ${(viaLong.d - viaShort.d).toFixed(1)} m）`);
  const okS = sAdj.get(br.from)!.includes(br.short) && sAdj.get(br.short)!.includes(br.to);
  const okL = sAdj.get(br.from)!.includes(br.long) && sAdj.get(br.long)!.includes(br.to);
  check(okS && okL && viaLong.d > viaShort.d, `分岐${br.id} は ${br.from} で分かれ ${br.to} で再合流し、長経路の方が長い`);
  log(`  - 環状経路: ${br.from} → ${br.short} → ${br.to} → ${br.long} → ${br.from}（同じ通路の往復ではない）`);
}
check(BRANCHES.length >= 3, `分岐 ${BRANCHES.length} 箇所 ≥ 3、環状経路 ${BRANCHES.length} 箇所 ≥ 2`);

// ---------------------------------------------------------------- 昇降箇所
log('');
log('## 5. 必須の飛行昇降箇所');
log('');
const jumpMax = (PLAYER.jumpVelocity * PLAYER.jumpVelocity) / (2 * PLAYER.gravity);
log(`通常ジャンプの最高到達高さ: ${jumpMax.toFixed(2)} m`);
const branchSectors = new Set(BRANCHES.flatMap((b) => [b.short, b.long]));
for (const a of FLIGHT_ASCENTS) {
  const h = a.to - a.from;
  check(h >= 6 && h <= 16 && h > jumpMax && !branchSectors.has(a.sectorId), `${a.id} ${a.sectorId} 高さ ${a.from}→${a.to}（${h} m）: ${a.note}`);
}
check(FLIGHT_ASCENTS.length >= 6, `必須経路上の飛行昇降箇所 ${FLIGHT_ASCENTS.length} 箇所 ≥ 6（分岐外の区画に配置し、全経路で必須）`);

// ---------------------------------------------------------------- 敵
log('');
log('## 6. 敵配置');
log('');
const game = new Game();
const guards = ENEMIES.filter((e) => e.kind === 'guard');
const turrets = ENEMIES.filter((e) => e.kind === 'turret');
check(guards.length === 30 && turrets.length === 15, `警備ロボット ${guards.length} 体 / 固定砲台 ${turrets.length} 体（合計 ${ENEMIES.length}）`);
check(new Set(ENEMIES.map((e) => e.id)).size === ENEMIES.length, '全敵に固有ID');
const controls = ENEMIES.filter((e) => e.isGateControl);
check(controls.length === 6 && controls.every((c) => c.kind === 'turret'), '制御砲台 6 体（全て固定砲台の内数）');
check(new Set(controls.map((c) => c.sectorId)).size === 6, `制御砲台は全て別区画（${controls.map((c) => `${c.id}@${c.sectorId}`).join(', ')}）`);
log('');
log('| ID | 種別 | 区画 | 位置 | HP | 制御 |');
log('| --- | --- | --- | --- | --- | --- |');
for (const e of ENEMIES) log(`| ${e.id} | ${e.kind === 'guard' ? '警備ロボット' : '固定砲台'} | ${e.sectorId} | ${e.pos.join(', ')} | ${ENEMY[e.kind].hp} | ${e.barrierId ?? ''} |`);
log('');
// 配置の妥当性
let badPlace = 0;
for (const e of game.enemies.enemies) {
  const s = SECTORS.find((q) => q.id === e.def.sectorId)!;
  const inside = e.pos[0] > s.x0 && e.pos[0] < s.x1 && e.pos[2] > s.z0 && e.pos[2] < s.z1 && e.pos[1] >= s.floor - 0.01 && e.pos[1] < s.ceil;
  const hw = e.kind === 'guard' ? 0.9 : 1.0;
  const hh = e.kind === 'guard' ? 2.6 : 2.4;
  const clear = !game.world.overlapsAny([e.pos[0] - hw, e.pos[1] + 0.02, e.pos[2] - hw], [e.pos[0] + hw, e.pos[1] + hh, e.pos[2] + hw]);
  const support = game.world.hasSupport(e.pos, 0.5, 0.05);
  let navOk = true;
  if (e.kind === 'guard') {
    const n = game.nav.nearest(e.pos, 4, 1);
    navOk = n >= 0;
    if (navOk) {
      // 同一成分のノード数（移動できる領域の広さ）
      const comp = game.nav.nodes[n].comp;
      const count = game.nav.nodes.filter((q) => q.comp === comp).length;
      navOk = count >= 30;
    }
  }
  if (!(inside && clear && support && navOk)) {
    badPlace++;
    log(`  配置不良: ${e.id} inside=${inside} clear=${clear} support=${support} nav=${navOk}`);
  }
}
check(badPlace === 0, '全敵が自区画内の到達可能な床・台座上にあり、埋まっていない（警備は移動可能な通路網上）');

// 制御砲台は隔壁より手前の到達可能な足場から射線と射程（120m）を確保できる
{
  let okAll = true;
  for (const c of game.enemies.enemies.filter((e) => e.def.isGateControl)) {
    const s = SECTORS.find((q) => q.id === c.def.sectorId)!;
    const cc = c.center();
    let spots = 0;
    let best = Infinity;
    for (let x = s.x0 + 2; x < s.x1 - 1; x += 3)
      for (let z = s.z0 + 2; z < s.z1 - 1; z += 3) {
        // 区画内の全ての足場の高さ（床・台・足場）
        const tops: number[] = [];
        game.world.queryAABB([x - 0.05, s.floor - 0.5, z - 0.05], [x + 0.05, s.ceil - 3, z + 0.05], (b) => {
          if (b.max[1] >= s.floor - 0.01 && b.max[1] < s.ceil - 3) tops.push(b.max[1]);
        });
        for (const y of tops) {
          if (game.world.overlapsAny([x - 0.9, y + 0.02, z - 0.9], [x + 0.9, y + 3, z + 0.9])) continue;
          const m: V3 = [x, y + 2.05, z];
          const d = Math.hypot(cc[0] - m[0], cc[1] - m[1], cc[2] - m[2]);
          if (d > 120) continue;
          if (!game.world.segmentBlocked(m, cc)) {
            spots++;
            best = Math.min(best, d);
          }
        }
      }
    log(`  - 制御砲台 ${c.id}（${c.def.sectorId}、隔壁${c.def.barrierId}）: 射線と射程を確保できる足場 ${spots} 点（最短 ${best.toFixed(1)} m）`);
    if (spots < 10) okAll = false;
  }
  check(okAll, '全制御砲台が自区画内の多数の足場から攻撃可能（射線あり・120m以内）');
}

// 開始地点の遮蔽
{
  const p = game.player;
  let seen = 0;
  for (const e of game.enemies.enemies) {
    const c = e.center();
    const pc: V3 = [START.pos[0], START.pos[1] + 1.5, START.pos[2]];
    const up: V3 = [START.pos[0], START.pos[1] + 2.7, START.pos[2]];
    const d = Math.hypot(pc[0] - c[0], pc[1] - c[1], pc[2] - c[2]);
    if (d > e.spec.range) continue;
    for (const t of [pc, up]) {
      const m = game.enemies.muzzleOf(e, t);
      if (!game.world.segmentBlocked(m, t)) {
        seen++;
        log(`  開始地点が見える敵: ${e.id}`);
        break;
      }
    }
  }
  void p;
  check(seen === 0, '開始地点はどの敵からも射線が通らない（遮蔽された出撃地点）');
}

// 複数方向の攻撃：区画内の床点で、独立に射線を取り得る敵の最大数
log('');
log('### 複数方向からの攻撃（各区画の床上の点に対し、射程内で射線が通る敵の数の最大）');
log('');
let multi = 0;
for (const s of SECTORS) {
  const es = game.enemies.enemies.filter((e) => e.def.sectorId === s.id);
  if (es.length < 4) continue;
  let best = 0;
  let bestP: V3 = [0, 0, 0];
  for (let x = s.x0 + 3; x < s.x1; x += 4)
    for (let z = s.z0 + 3; z < s.z1; z += 4) {
      const floor = game.world.groundBelow(x, s.ceil - 3.5, z, 0.9, s.ceil - s.floor);
      if (floor === null) continue;
      const pos: V3 = [x, floor, z];
      if (game.world.overlapsAny([x - 0.9, floor + 0.02, z - 0.9], [x + 0.9, floor + 3, z + 0.9])) continue;
      const pc: V3 = [x, floor + 1.5, z];
      let n = 0;
      for (const e of es) {
        const c = e.center();
        if (Math.hypot(pc[0] - c[0], pc[1] - c[1], pc[2] - c[2]) > e.spec.range) continue;
        const m = game.enemies.muzzleOf(e, pc);
        if (!game.world.segmentBlocked(m, pc)) n++;
      }
      if (n > best) {
        best = n;
        bestP = pos;
      }
    }
  log(`- ${s.id} ${s.name}: 区画内の敵 ${es.length} 体、同時に射線が通る最大 ${best} 体（地点 ${bestP.map((v) => v.toFixed(0)).join(', ')}）`);
  if (best >= 4) multi++;
}
check(multi >= 5, `少なくとも4体が独立に射線を取り得る戦闘区画 ${multi} 箇所 ≥ 5`);

// ---------------------------------------------------------------- 昇降箇所の被射線（参考）
log('');
log('### 必須昇降箇所の周囲（上昇中の空中を含む）で射線が通る敵（参考）');
log('');
for (const a of FLIGHT_ASCENTS) {
  const seen = new Map<string, number>();
  let samples = 0;
  for (let dx = -3; dx <= 3; dx += 3)
    for (let dz = -3; dz <= 3; dz += 3)
      for (let y = a.from; y <= a.to; y += 2) {
        const pc: V3 = [a.base[0] + dx, y + 1.5, a.base[2] + dz];
        if (game.world.overlapsAny([pc[0] - 0.9, y + 0.05, pc[2] - 0.9], [pc[0] + 0.9, y + 3, pc[2] + 0.9])) continue;
        samples++;
        for (const e of game.enemies.enemies) {
          const c = e.center();
          if (Math.hypot(pc[0] - c[0], pc[1] - c[1], pc[2] - c[2]) > e.spec.range) continue;
          if (!game.world.segmentBlocked(game.enemies.muzzleOf(e, pc), pc)) seen.set(e.id, (seen.get(e.id) ?? 0) + 1);
        }
      }
  const list = [...seen.entries()].map(([k, v]) => `${k}${game.enemies.byId(k)!.def.isGateControl ? '(制御)' : ''} ${Math.round((100 * v) / samples)}%`).join('、');
  log(`- ${a.id}（${a.sectorId} ${a.from}→${a.to}m）: ${list || 'なし'}（警備ロボットは初期位置での値。移動して接近する）`);
}

// ---------------------------------------------------------------- 推奨経路
log('');
log('## 7. 推奨攻略経路の座標');
log('');
let routeLen = 0;
for (let i = 0; i < ROUTE.length; i++) {
  const r = ROUTE[i];
  if (i > 0) routeLen += Math.hypot(r.pos[0] - ROUTE[i - 1].pos[0], r.pos[1] - ROUTE[i - 1].pos[1], r.pos[2] - ROUTE[i - 1].pos[2]);
  log(`${i + 1}. ${r.sectorId} (${r.pos.join(', ')})${r.note ? ` — ${r.note}` : ''}`);
}
log('');
log(`推奨経路の折れ線長: ${routeLen.toFixed(1)} m（参考値。規模要件の根拠は3章の下限距離）`);

// ---------------------------------------------------------------- オートパイロット走破
log('');
log('## 8. 全18構成での走破確認（オートパイロット）');
log('');
log('全隔壁を開放した状態（制御砲台破壊後を想定）、敵なしで、実際の移動・衝突・EN・飛行処理を使い推奨経路の点を順に辿る。');
log('上昇が必要な点では地上でENを回復してから飛行する。通常移動（10m/s×脚部倍率）のみで、QB・グライドは使わない。');
log('');
log('| FCS | ジェネレーター | 脚部 | 結果 | 経過時間 | 移動距離 | 最小EN |');
log('| --- | --- | --- | --- | --- | --- | --- |');
function autopilot(loadout: Loadout): { ok: boolean; t: number; dist: number; minEn: number; note: string } {
  const g = new Game({ enemies: [] });
  g.sortie(loadout);
  for (const b of g.barriers) {
    b.open = true;
    b.progress = 1;
    b.wbox.active = false;
  }
  g.gateOpen = true;
  let idx = 1;
  let dist = 0;
  let minEn = Infinity;
  let waiting = false;
  let stuck = 0;
  const maxSteps = 120 * 60 * 12;
  let lastSpace = false;
  for (let s = 0; s < maxSteps && g.state === 'playing'; s++) {
    const p = g.player;
    // 目標点へ近づいたら次へ
    while (idx < ROUTE.length) {
      const t = ROUTE[idx].pos;
      const dxz = Math.hypot(t[0] - p.pos[0], t[2] - p.pos[2]);
      if (dxz < 2.2 && t[1] - p.pos[1] < 1.5) idx++;
      else break;
    }
    if (idx >= ROUTE.length) break;
    const t = ROUTE[idx].pos;
    const yaw = Math.atan2(-(t[0] - p.pos[0]), -(t[2] - p.pos[2]));
    g.setLook(yaw, 0);
    const need = t[1] - p.pos[1];
    const inp: StepInput = { ...EMPTY_INPUT };
    if (need > 2.0) {
      const req = Math.min(g.stats.maxEn, (need / PLAYER.flightRiseSpeed + 0.8) * PLAYER.flightEnPerSecond + 6);
      if (p.grounded && (waiting || p.en < req)) {
        waiting = p.en < req;
      }
      if (!waiting) {
        inp.spaceHeld = true;
        inp.spaceEdge = !lastSpace;
        // 上昇が十分になるまで水平移動は壁で止まる
        inp.moveZ = 1;
      }
    } else {
      waiting = false;
      inp.moveZ = 1;
    }
    lastSpace = inp.spaceHeld;
    const before: V3 = [p.pos[0], p.pos[1], p.pos[2]];
    g.step(inp);
    const d = Math.hypot(p.pos[0] - before[0], p.pos[1] - before[1], p.pos[2] - before[2]);
    dist += d;
    minEn = Math.min(minEn, p.en);
    if (d < 1e-4 && !waiting) stuck++;
    else stuck = 0;
    if (stuck > 120 * 8) return { ok: false, t: g.elapsedSeconds, dist, minEn, note: `停止: 経路点${idx} (${p.pos.map((v) => v.toFixed(1)).join(',')})` };
  }
  return { ok: g.state === 'cleared', t: g.elapsedSeconds, dist, minEn, note: g.state };
}
const fcsIds = Object.keys(FCS) as FcsId[];
const genIds = Object.keys(GENERATORS) as GeneratorId[];
const legIds = Object.keys(LEGS) as LegsId[];
let allOk = true;
let minDist = Infinity;
for (const f of fcsIds)
  for (const gid of genIds)
    for (const l of legIds) {
      const lo = { fcs: f, generator: gid, legs: l };
      const r = autopilot(lo);
      const st = computeEffectiveStats(lo);
      void st;
      if (!r.ok) allOk = false;
      minDist = Math.min(minDist, r.dist);
      log(`| ${f} | ${gid} | ${l} | ${r.ok ? 'クリア' : 'NG ' + r.note} | ${r.t.toFixed(1)} s | ${r.dist.toFixed(1)} m | ${r.minEn.toFixed(1)} |`);
    }
log('');
check(allOk, '全18構成で推奨経路を最後まで走破し、脱出領域に到達（クリア判定）');
log(`（オートパイロットの実移動距離の最小: ${minDist.toFixed(1)} m）`);

log('');
log(failures === 0 ? '## 結果: 全項目 OK' : `## 結果: NG ${failures} 件`);
mkdirSync('docs', { recursive: true });
writeFileSync('docs/stage-report.md', out.join('\n') + '\n');
console.log('\n→ docs/stage-report.md を出力しました');
process.exit(failures === 0 ? 0 : 1);
