/**
 * ARMORED KOALA 2 DEMO: ブラウザ実機の総合検証 (Playwright 1.63 + 同梱外の Chrome for Testing + SwiftShader)。
 *
 *   npx tsx tools/e2e.ts                # 全項目を実行し、表とJSONを出力して docs/E2E.md に書き出す
 *   npx tsx tools/e2e.ts --only=1,2     # 一部だけ実行 (docs/E2E.md は書き換えない。--write を付けると書く)
 *
 * dist は node_modules/.cache/ak2-e2e/dist へ vite build し、vite preview を 127.0.0.1:5210 (E2E_PORT) で配信する。終了時に必ず止める。
 * E2E_URL を指定すると build/preview を行わず、そのURLを使う。スクリーンショットは test-results/e2e/e2e-*.png (.gitignore 済み)。
 * 詳しい方針 (fake clock でフレームを進める理由、ポインターロックの取り方) は tools/e2e/lib.ts の冒頭を参照。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { checks, images, launchBrowser, ROOT, startServer, state, stopServer } from './e2e/lib';
import type { Check, Status } from './e2e/lib';
import { section1, section2 } from './e2e/s12';
import { section3 } from './e2e/s3';
import { section45 } from './e2e/s45';
import { section6 } from './e2e/s6';
import { section7, section8, section9 } from './e2e/s789';
import type { Browser } from 'playwright';

type Runner = (browser: Browser, base: string) => Promise<void>;
const SECTIONS: { key: string; title: string; run: Runner }[] = [
  { key: '1', title: '起動と格納庫', run: section1 },
  { key: '2', title: '出撃とポインターロック', run: section2 },
  { key: '3', title: '実キー入力', run: section3 },
  { key: '45', title: '一時停止 / 失敗・結果 / 再出撃', run: section45 },
  { key: '6', title: 'リサイズ', run: section6 },
  { key: '7', title: 'AK2_BENCH', run: section7 },
  { key: '8', title: '実プレイ画面の見た目 (HUD)', run: section8 },
  { key: '9', title: '性能', run: section9 },
];

const args = process.argv.slice(2);
const onlyArg = args.find((a) => a.startsWith('--only='));
const only = onlyArg ? new Set(onlyArg.slice(7).split(',')) : null;
const forceWrite = args.includes('--write');

const ICON: Record<Status, string> = { pass: 'PASS', fail: 'FAIL', synthetic: 'SYNTH', unverified: 'UNVERIFIED', info: 'INFO' };

/** docs/E2E.md の実測・詳細の最大文字数 (標準出力とキャッシュのJSONには全文が出る。文書は要点だけにして肥大を避ける) */
const DETAIL_MAX = 320;

function table(list: Check[], clip = false): string {
  const esc = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const cut = (s: string): string => (clip && s.length > DETAIL_MAX ? `${s.slice(0, DETAIL_MAX)}…` : s);
  const lines = ['| ID | 結果 | 項目 | 実測・詳細 |', '|---|---|---|---|'];
  for (const c of list) lines.push(`| ${c.id} | ${ICON[c.status]} | ${esc(clip && c.title.length > 200 ? `${c.title.slice(0, 200)}…` : c.title)} | ${esc(cut(c.detail))} |`);
  return lines.join('\n');
}

function summary(): Record<Status, number> {
  const out: Record<Status, number> = { pass: 0, fail: 0, synthetic: 0, unverified: 0, info: 0 };
  for (const c of checks) out[c.status]++;
  return out;
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const load0 = loadavg();
  const server = await startServer();
  let browser = await launchBrowser();
  const version = browser.version();
  console.log(`# e2e: ${server.url}  chromium=${version}  loadavg(1/5/15)=${load0.map((x) => x.toFixed(1)).join('/')}  cpus=${cpus().length}`);
  try {
    for (const s of SECTIONS) {
      if (only && !only.has(s.key)) continue;
      state.section = Number(s.key[0]);
      console.log(`\n=== ${s.key}. ${s.title} ===`);
      const before = checks.length;
      const imagesBefore = images.length;
      const ts = Date.now();
      // ブラウザが外部要因 (他の作業の pkill やメモリ逼迫) で落ちた場合は、そのセクションの途中結果を捨てて起動し直し、最大3回やり直す
      for (let attempt = 1; ; attempt++) {
        try {
          if (!browser.isConnected()) browser = await launchBrowser();
          await s.run(browser, server.url);
          break;
        } catch (e) {
          const msg = e instanceof Error ? `${e.message}\n${(e.stack ?? '').split('\n').slice(1, 4).join('\n')}` : String(e);
          const crashed = /has been closed|Target crashed|browser has disconnected|Browser closed|Connection closed/i.test(msg) || !browser.isConnected();
          if (crashed && attempt < 3) {
            console.log(`[retry     ] section ${s.key}: browser went away (${msg.split('\n')[0]}); relaunching (attempt ${attempt + 1})`);
            checks.length = before;
            images.length = imagesBefore;
            await browser.close().catch(() => {});
            browser = await launchBrowser();
            continue;
          }
          checks.push({ section: Number(s.key[0]), id: `${s.key}.ERR`, title: `セクション ${s.key} が例外で中断`, status: 'fail', detail: msg.replace(/\n/g, ' / ') });
          console.log(`[FAIL      ] ${s.key}.ERR section aborted :: ${msg}`);
          break;
        }
      }
      console.log(`--- section ${s.key}: ${checks.length - before} checks, ${((Date.now() - ts) / 1000).toFixed(0)}s`);
    }
  } finally {
    await browser.close().catch(() => {});
    server.stop();
    stopServer();
  }
  const load1 = loadavg();
  const sum = summary();
  const meta = {
    date: new Date().toISOString(),
    url: server.url,
    chromium: version,
    loadavg: { before: load0.map((x) => Number(x.toFixed(1))), after: load1.map((x) => Number(x.toFixed(1))) },
    cpus: cpus().length,
    seconds: Math.round((Date.now() - t0) / 1000),
    summary: sum,
  };
  console.log('\n' + table(checks));
  const fullJson = JSON.stringify({ meta, checks: checks.map((c) => ({ id: c.id, status: c.status, title: c.title, detail: c.detail })) }, null, 1);
  console.log('\n' + fullJson);
  // 全文のJSONは docs には入れず (肥大化する)、キャッシュに残す
  const cacheJson = join(ROOT, 'node_modules/.cache/ak2-e2e/result.json');
  mkdirSync(dirname(cacheJson), { recursive: true });
  writeFileSync(cacheJson, fullJson);
  console.log(`\nSUMMARY pass=${sum.pass} fail=${sum.fail} synthetic=${sum.synthetic} unverified=${sum.unverified} info=${sum.info}  (${meta.seconds}s)`);

  if (!only || forceWrite) {
    const md: string[] = [];
    md.push('# E2E 結果 (ブラウザ実機の総合検証)', '');
    md.push('`npx tsx tools/e2e.ts` の出力。Playwright 1.63 + Chrome for Testing (headless) + SwiftShader によるソフトウェア描画。手動の値の書き足しはしていない。', '');
    md.push('## 環境', '');
    md.push(`- 実行日時: ${meta.date}`, `- URL: ${meta.url} (vite build -> vite preview)`, `- ブラウザ: ${version}`, `- マシン負荷 (loadavg 1/5/15分) 実行前 ${meta.loadavg.before.join('/')} / 実行後 ${meta.loadavg.after.join('/')}, CPU ${meta.cpus}コア (他の作業と並行して実行しているため、fps の絶対値は参考値)`, `- 所要時間: ${meta.seconds}秒`, '');
    md.push('## 方針 (時間と入力)', '');
    md.push(
      '- SwiftShader の fps はマシン負荷で 0.2〜30 と大きく変わるため、実時間の sleep には頼らず、Playwright の fake clock を停止して `page.clock.fastForward(ms)` で 1フレーム (dt = ms) ずつ進める。時間依存の判定は全て `snapshot.elapsedSeconds` (ゲーム内時間)。fps と実時間比の計測 (9) だけは実時間の rAF で行う。',
      '- 入力は本物のイベント: `page.keyboard` (keydown/keyup。同じキーの2回目の down は `event.repeat=true` になることを確認済み)、`page.mouse` (ポインターロック中の movementX/Y。CDP の mouseMoved は前回位置との差が movement になる)、ボタンは実クリック。',
      '- ポインターロックは context に `Emulation.setFocusEmulationEnabled` を送り、http のページで、実クリックから要求して取得。',
      '- 合成イベントでしか確認できないもの (blur・visibilitychange hidden) は結果を SYNTH として区別する。', '',
    );
    md.push('## 集計', '', `PASS ${sum.pass} / FAIL ${sum.fail} / SYNTH ${sum.synthetic} / UNVERIFIED ${sum.unverified} / INFO ${sum.info}`, '');
    for (const s of SECTIONS) {
      const list = checks.filter((c) => c.id.startsWith(s.key === '45' ? '4.' : `${s.key}.`) || (s.key === '45' && c.id.startsWith('5.')) || c.id.startsWith(`${s.key}.ERR`));
      if (!list.length) continue;
      md.push(`## ${s.key === '45' ? '4-5' : s.key}. ${s.title}`, '', table(list, true), '');
    }
    md.push('## 撮影した画像', '');
    for (const im of images) md.push(`- \`${relative(ROOT, im.path)}\` — ${im.note}`);
    md.push('', '## JSON (要約。全文は標準出力 / node_modules/.cache/ak2-e2e/result.json)', '', '```json', JSON.stringify({ meta, status: Object.fromEntries(checks.map((c) => [c.id, c.status])) }), '```', '');
    const out = join(ROOT, 'docs/E2E.md');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, md.join('\n'));
    console.log(`wrote ${relative(ROOT, out)}`);
  }
  process.exitCode = sum.fail > 0 ? 1 : 0;
}

process.on('SIGINT', () => {
  stopServer();
  process.exit(130);
});
process.on('SIGTERM', () => {
  stopServer();
  process.exit(143);
});
main().catch((e) => {
  console.error(e);
  stopServer();
  process.exit(2);
});
