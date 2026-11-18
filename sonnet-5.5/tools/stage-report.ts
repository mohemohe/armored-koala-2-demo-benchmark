/**
 * Stage validation report tool.  Usage:  npx tsx tools/stage-report.ts [--no-bot] [--no-write] [--out=docs/STAGE.md]
 *   [--stage=<module>#<exportName>]   validate another stage factory instead of src/stage buildStage() (used to preview the report)
 *
 * Runs `validateStage(buildStage())` (real collision world + real player physics for the flight climbs), prints the result and
 * writes docs/STAGE.md (sector table, enemy placement, barriers / control turrets, route coordinates, verification results).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ENEMIES } from '../src/config';
import { buildStage } from '../src/stage';
import type { StageDef, V3 } from '../src/sim/types';
import { validateStage } from '../src/stage/validate';
import type { CheckResult, ClimbResult, StageReport } from '../src/stage/validate';

const args = process.argv.slice(2);
const noBot = args.includes('--no-bot');
const noWrite = args.includes('--no-write');
const outArg = args.find((a) => a.startsWith('--out='));
const stageArg = args.find((a) => a.startsWith('--stage='));
const outPath = resolve(outArg ? outArg.slice('--out='.length) : 'docs/STAGE.md');

const f = (n: number, d = 1): string => (Number.isFinite(n) ? n.toFixed(d) : String(n));
const p3 = (p: V3, d = 1): string => `(${f(p.x, d)}, ${f(p.y, d)}, ${f(p.z, d)})`;
const esc = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const mark = (b: boolean): string => (b ? 'PASS' : 'FAIL');

function table(head: string[], rows: string[][]): string {
  const lines = [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`];
  for (const r of rows) lines.push(`| ${r.map(esc).join(' | ')} |`);
  return lines.join('\n');
}

function checkRows(checks: readonly CheckResult[]): string[][] {
  return checks.map((c) => [`${mark(c.pass)}${c.advisory ? ' (参考)' : ''}`, c.name, c.label, String(c.value), c.threshold, c.details]);
}

function climbSummary(c: ClimbResult): string[] {
  const ok = c.configs.filter((x) => x.success).length;
  const strategies = [...new Set(c.configs.filter((x) => x.strategy).map((x) => x.strategy))].join('/');
  const en = c.configs.map((x) => x.enUsed);
  const fl = c.configs.map((x) => x.flightSeconds);
  const tm = c.configs.map((x) => x.timeSeconds);
  const rng = (a: number[], d = 1): string => (a.length ? `${f(Math.min(...a), d)}〜${f(Math.max(...a), d)}` : '-');
  return [
    c.id,
    c.sectorId,
    p3(c.from),
    p3(c.to),
    f(c.measuredHeight),
    f(c.jumpMaxRise, 2),
    c.onPath ? `${f(c.pathDistance)} m` : c.pathDistance < 0 ? '経路なし' : `離れている(${f(c.pathDistance)} m)`,
    `${ok}/${c.configs.length}`,
    strategies || '-',
    rng(en),
    rng(fl, 2),
    rng(tm, 2),
  ];
}

function markdown(stage: StageDef, rep: StageReport): string {
  const L: string[] = [];
  const push = (s = ''): void => void L.push(s);
  push('# ステージ設計と検証結果');
  push();
  push('このファイルは `npx tsx tools/stage-report.ts` が自動生成する(手で編集しない)。数値は `src/stage/validate.ts` が');
  push('実際の衝突形状(`World`)と実際の移動物理(`Game`/player)から計測したもので、申告値ではない。');
  push();
  push(`- ステージ: ${stage.name}`);
  push(`- 検証結果: **${rep.pass ? '全項目合格' : '不合格あり'}** (必須項目 ${rep.checks.filter((c) => !c.advisory).length} 件中 ${rep.checks.filter((c) => !c.advisory && c.pass).length} 件合格)`);
  push(`- 区画数 ${stage.sectors.length} / 敵 ${stage.enemies.length} 体 (警備 ${stage.enemies.filter((e) => e.kind === 'guard').length}、砲台 ${stage.enemies.filter((e) => e.kind === 'turret').length}) / 隔壁 ${stage.barriers.length} / portal ${stage.portals.length} / 飛行昇降 ${stage.climbs.length}`);
  push(`- 最短の実行可能経路(飛行自由・全隔壁開放、平滑化+sweep検証済みの上界): **${rep.route.found ? `${f(rep.route.length)} m` : '経路なし'}** (要件 1500 m 以上)`);
  push(`- 物理的に通過する区画: ${rep.route.sectors.length} (${rep.route.sectors.join(' → ')})`);
  push();

  push('## 1. 検証結果');
  push();
  push(table(['判定', '項目', '内容', '値', '基準', '詳細'], checkRows(rep.checks)));
  push();
  if (rep.warnings.length) {
    push('警告:');
    for (const w of rep.warnings) push(`- ${esc(w)}`);
    push();
  }

  push('## 2. 区画表');
  push();
  const enemiesBy = new Map<string, number>();
  for (const e of stage.enemies) enemiesBy.set(e.sectorId, (enemiesBy.get(e.sectorId) ?? 0) + 1);
  push(
    table(
      ['ID', '名称', '種別', 'bounds min', 'bounds max', 'サイズ(x,y,z)', '床Y', '天井Y', '戦闘', '敵数', '空き床(最大矩形)', '60x50', '射線を取る敵数(最大)'],
      stage.sectors.map((s) => {
        const a = rep.arenas.find((x) => x.sectorId === s.id);
        const c = rep.combat.find((x) => x.sectorId === s.id);
        const sz = { x: s.bounds.max.x - s.bounds.min.x, y: s.bounds.max.y - s.bounds.min.y, z: s.bounds.max.z - s.bounds.min.z };
        return [
          s.id,
          s.name,
          s.kind,
          p3(s.bounds.min, 0),
          p3(s.bounds.max, 0),
          `${f(sz.x, 0)} x ${f(sz.y, 0)} x ${f(sz.z, 0)}`,
          f(s.floorY),
          f(s.ceilingY),
          s.combat ? '○' : '-',
          String(enemiesBy.get(s.id) ?? 0),
          a?.bestRect ? `${a.bestRect.width} x ${a.bestRect.depth} m` : '-',
          a?.has60x50 ? '○' : '-',
          c ? `${c.bestVisible}/${c.enemies}` : '-',
        ];
      }),
    ),
  );
  push();
  push('高度帯(実際に立てる大きな床面): ' + (rep.layers.map((l) => `y=${f(l.y)}m (${f(l.area, 0)} m²)`).join(', ') || 'なし'));
  push();

  push('## 3. 区画の接続(portal)と実際の開口');
  push();
  push(
    table(
      ['portal', 'a', 'b', '中心', '幅x高', '種別', '隔壁', '実開口(自由空間で検出)'],
      stage.portals.map((p) => {
        const c = rep.connections.find((x) => x.portalId === p.id);
        return [p.id, p.a, p.b, p3(p.center), `${f(p.width)} x ${f(p.height)}`, p.kind, p.barrierId ?? '-', c ? `${c.id} ${p3(c.center)}` : '(対応なし)'];
      }),
    ),
  );
  push();
  const undeclared = rep.connections.filter((c) => c.portalId === null);
  if (undeclared.length) {
    push('宣言のない開口: ' + undeclared.map((c) => `${c.a}<->${c.b} ${p3(c.center)}`).join(', '));
    push();
  }
  push(`区画グラフ上の最少通過区画数: ${rep.minSectorHops.count} (${rep.minSectorHops.sectors.join(' → ')})`);
  push();

  push('## 4. 隔壁と制御砲台');
  push();
  push(
    table(
      ['隔壁', 'ラベル', '制御砲台', '砲台の区画', '砲台位置', '隔壁位置', '最短経路上の通過位置'],
      stage.barriers.map((b) => {
        const e = stage.enemies.find((x) => x.id === b.controlEnemyId);
        const cr = rep.route.barrierCrossings.find((x) => x.barrierId === b.id);
        return [b.id, b.label, b.isFinal ? '(6体全破壊)' : (b.controlEnemyId ?? '-'), e?.sectorId ?? '-', e ? p3(e.pos) : '-', p3(b.pos), cr ? `${f(cr.atMeters)} m ${p3(cr.point)}` : '通らない'];
      }),
    ),
  );
  push();
  push('閉鎖状態の到達性(単独閉鎖: 他の隔壁は全て開放):');
  push();
  push(
    table(
      ['状態', '脱出領域へ到達', '到達できる区画'],
      rep.barrierStates.map((r) => [r.label, r.goalReachable ? `到達可能(検証済み経路 ${f(r.confirmedLength ?? 0)} m) ← 抜け道` : '到達不能', r.reachableSectors.join(', ')]),
    ),
  );
  push();

  push('## 5. 敵配置表');
  push();
  push(
    table(
      ['ID', '種別', 'HP', '区画', '位置(当たり判定中心)', '制御砲台', '隔壁', '配置検査'],
      stage.enemies.map((e) => {
        const row = rep.enemyRows.find((r) => r.id === e.id);
        return [
          e.id,
          e.kind === 'guard' ? '警備ロボット' : '固定砲台',
          String(ENEMIES[e.kind].hp),
          e.sectorId,
          p3(e.pos),
          e.isGateControl ? `制御#${(e.controlIndex ?? 0) + 1}` : '-',
          e.barrierId ?? '-',
          row && row.problems.length ? row.problems.join('; ') : 'OK',
        ];
      }),
    ),
  );
  push();

  push('## 6. 経路座標');
  push();
  push(`スタート ${p3(stage.playerStart.pos)} → 脱出領域 min ${p3(stage.escapeZone.min)} / max ${p3(stage.escapeZone.max)}`);
  push();
  push('### 6.1 検証器が求めた最短経路(プレイヤー中心座標)');
  push();
  if (rep.route.found) {
    push(`長さ ${f(rep.route.length)} m (格子A*の生の長さ ${f(rep.route.gridLength)} m、始点-終点の直線距離 ${f(rep.route.straightLength)} m、` +
      `プレイヤーを 0.4 m 細くした楽観推定 ${rep.route.relaxedLength === null ? '-' : `${f(rep.route.relaxedLength)} m`}、格子 ${f(rep.route.gridStep, 2)} m)`);
    push();
    push('区画への進入(経路の中心が最初にその区画のboundsに入った位置):');
    push();
    push(table(['順', '区画', '経路長(m)'], rep.route.sectorEntries.map((e, i) => [String(i + 1), e.sectorId, f(e.atMeters)])));
    push();
    let acc = 0;
    push(
      table(
        ['#', '座標', '前点からの距離', '累積(m)'],
        rep.route.points.map((p, i) => {
          const d = i === 0 ? 0 : Math.hypot(p.x - rep.route.points[i - 1].x, p.y - rep.route.points[i - 1].y, p.z - rep.route.points[i - 1].z);
          acc += d;
          return [String(i), p3(p, 2), f(d, 2), f(acc, 2)];
        }),
      ),
    );
  } else {
    push(`経路が見つからない: ${rep.route.note}`);
  }
  push();
  push('### 6.2 ステージ定義に記載された経路(mainRoute)');
  push();
  push(`${stage.mainRoute.note} — ${stage.mainRoute.points.length} 点`);
  push();
  push(table(['#', '座標'], stage.mainRoute.points.map((p, i) => [String(i), p3(p, 2)])));
  push();

  push('## 7. 分岐と環状経路');
  push();
  push('実際の自由空間から検出した独立な閉路(2つの経路がそれぞれ 40 m 以上):');
  push();
  push(table(['区画', '開口', '周長(m)', '2経路の長さ(m)'], rep.structures.map((s) => [s.sectors.join(' → '), s.connectionIds.join(', '), f(s.perimeter, 0), `${f(s.arcs[0], 0)} / ${f(s.arcs[1], 0)}`])));
  push();
  push('宣言された分岐(stage.branches):');
  push();
  push(
    table(
      ['分岐', '分岐→合流', '独立経路数(実グラフ)', '経路', '判定'],
      rep.declaredBranches.map((b) => [
        b.id,
        `${b.split} → ${b.merge}`,
        String(b.edgeDisjointPaths),
        b.routes.map((r) => `${r.id}: ${f(r.length)} m [${r.sectors.join('>')}]`).join(' / '),
        b.ok ? 'OK' : [...b.problems, ...b.routes.flatMap((r) => r.problems.map((x) => `${r.id}: ${x}`))].join('; '),
      ]),
    ),
  );
  push();
  push('宣言された環状経路(stage.loops):');
  push();
  push(table(['ID', '長さ(m)', '区画', '判定'], rep.declaredLoops.map((l) => [l.id, f(l.length), l.sectors.join('>'), l.ok ? 'OK' : l.problems.join('; ')])));
  push();

  push('## 8. 飛行昇降');
  push();
  push(
    table(['ID', '区画', '下の足場(from)', '上の足場(to)', '高低差(m)', 'ジャンプ最大上昇(m)', '最短経路との距離', '18構成の成功', '成功した制御', 'EN消費(18構成の最小〜最大)', '飛行時間(s)', '所要時間(s)'], rep.climbs.map(climbSummary)),
  );
  push();
  if (rep.climbs.length && rep.climbs[0].configs.length) {
    push('<details><summary>構成別の結果(実際のGame物理: Space長押し飛行 + 水平移動 + 解放で着地)</summary>');
    push();
    const head = ['昇降', 'FCS', 'ジェネレーター', '脚部', '成否', '制御', 'EN開始→最小', 'EN消費', '飛行(s)', '所要(s)', '失敗理由'];
    const rows: string[][] = [];
    for (const c of rep.climbs) {
      for (const r of c.configs) {
        rows.push([c.id, r.fcs, r.generator, r.legs, r.success ? 'OK' : 'NG', r.strategy ?? '-', `${f(r.enStart, 0)}→${f(r.enMin)}`, f(r.enUsed), f(r.flightSeconds, 2), f(r.timeSeconds, 2), r.failure ?? '']);
      }
    }
    push(table(head, rows));
    push();
    push('</details>');
    push();
  }

  push('## 9. 検証手法と限界');
  push();
  push('- 最短経路: プレイヤーAABB(1.6×3.0×1.6、側方に 2 cm の余裕)の中心が通れる3D格子(設定値 `gridStep`、既定 2 m と 1.5 倍粗い格子の2回)上でA*を行い、経路の全辺を厳密な連続衝突 `sweepAABB` で再検証(失敗辺は禁止して再探索)、');
  push('  さらに見通し判定つきのtaut-string平滑化(最も近い箱の辺に沿った折れ点挿入を含む)で短縮し、短い方を採用する。報告値は実行可能な経路の長さなので **真の最短長の上界** であり、格子・平滑化の局所解により真値より数%長く出ることがある');
  push('  (解析解の分かる合成ステージでは 0.5 % 以内に収まることをテストしている)。逆向きの見積もりとして、プレイヤーを 0.4 m 細くした楽観推定を併記する。');
  push('- 飛行はEN無視・どこでも自由に飛べる最も緩い条件で経路を求めている(EN予算は昇降ボットの実測で別に確認)。');
  push('- 抜け道検査: 各隔壁を単独で閉じた状態(他は開放)で脱出領域へ到達できないこと、全閉鎖状態で最初の隔壁より先の区画へ到達できないことを、格子の連結成分(6近傍)で判定し、到達すると出た場合はsweep検証済み経路で確認する。');
  push('  格子より狭い(自由空間の幅が格子間隔未満の)隙間は格子では見つからないため、隔壁が開口を塞いでいることは別にportalの開口全面をプレイヤー箱でレーン掃引して確認している。');
  push('- 区画グラフ: 区画境界をまたいで隣り合う自由格子点の対をsweepで再検証し、近い対をクラスタ化して1開口とする(多重辺を区別できる)。閉路は多重グラフ上で列挙し、閉路の周長を区画内の実最短経路(区画内に限定したA*)で測る。');
  push('- 昇降ボット: 本物の `Game`(player物理)にステージ自身の箱を渡し、下の足場からSpace長押し飛行 + 水平移動 + 解放で上の足場に着地できるかを全18構成で実行する(QBは使わない)。制御則は単純なもの(垂直優先/斜め同時の2方式)で、失敗した場合は人間なら成功する可能性がある。');
  push('- 「広い戦闘空間」は区画の主床(`floorY`)上で高さ 3 m までに障害物(箱)が無い 1 m 格子セルから最大の軸並行な空き矩形を求めて判定する。');
  push('- 未確認/範囲外: 敵AIの経路探索(nav)がその区画を歩いて移動できるかは検証していない。人間のプレイテストによる所要時間(10〜20分)の確認もしていない。');
  push();
  push('### 計測時間(ms)');
  push();
  push(table(['処理', 'ms'], Object.entries(rep.timingsMs).map(([k, v]) => [k, f(v, 0)])));
  push();
  return L.join('\n');
}

async function loadStage(): Promise<StageDef> {
  if (!stageArg) return buildStage();
  const [file, name = 'buildStage'] = stageArg.slice('--stage='.length).split('#');
  const mod = (await import(pathToFileURL(resolve(file)).href)) as Record<string, () => StageDef>;
  return mod[name]();
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const stage = await loadStage();
  console.log(`stage "${stage.name}": ${stage.sectors.length} sectors, ${stage.boxes.length} boxes, ${stage.enemies.length} enemies`);
  const rep = validateStage(stage, { runClimbBot: !noBot, onProgress: (m) => console.log(`  .. ${m}`) });
  console.log(`\nvalidation finished in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  for (const c of rep.checks) {
    console.log(`${c.pass ? 'PASS' : 'FAIL'}${c.advisory ? ' (advisory)' : ''}  ${c.name.padEnd(28)} ${String(c.value).padEnd(14)} ${c.threshold}`);
    if (!c.pass) console.log(`        -> ${c.details.slice(0, 400)}`);
  }
  if (rep.route.found) {
    console.log(`\nroute ${f(rep.route.length)} m (grid ${f(rep.route.gridLength)} m, relaxed ${rep.route.relaxedLength === null ? '-' : f(rep.route.relaxedLength)} m), sectors ${rep.route.sectors.length}`);
  }
  for (const w of rep.warnings) console.log(`warning: ${w}`);
  console.log(`\nOVERALL: ${rep.pass ? 'PASS' : 'FAIL'}`);
  if (!noWrite) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, markdown(stage, rep), 'utf8');
    console.log(`wrote ${outPath}`);
  }
  process.exitCode = rep.pass ? 0 : 1;
}

void main();
