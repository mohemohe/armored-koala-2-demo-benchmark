/**
 * 起動時間の計測: ページ読み込み -> 格納庫の最初のフレームが描かれるまで (実時間・ソフトウェア GL・ヘッドレス)。
 *
 *   npx tsx tools/startup-bench.ts [--n=5] [--port=5250] [--dist=<dir> ...] [--nobuild] [--shot=<png>] [--w=1280 --h=720]
 *
 *   --dist=<dir>  計測する dist (複数指定可。指定した順に交互 (A,B,A,B...) に n 回ずつ計測する)。省略時は現在のソースを
 *                 node_modules/.cache/ak2-startup/dist-current へ vite build する。--dist=label=<dir> でラベルを付けられる。
 *   --nobuild     省略時の build をしない (dist-current が既にあるとき)。
 *   --reuse-browser  計測ごとにブラウザーを起動し直さない (既定は計測ごとに起動し直す: 前の計測の GPU プロセスの影響を避けるため)。
 *   --shot=<png>  各 dist の最初の 1 回の、格納庫が描かれた直後のスクリーンショットを <png> の拡張子の前にラベルを付けて保存する (例: --shot=test-results/startup.png。test-results/ は .gitignore 済み。docs/ には書かない)。
 *
 * 計測値 (ms、ナビゲーション開始 = performance.now() の 0 からの値):
 *   ready   格納庫の最初の 1 枚が画面に出た時刻。読み込み中の表示 (#boot-loading) がある版は app が残す mark ak2:hangar-visible、
 *           無い版は window.AK2_BENCH が現れた後 rAF が 2 回回った時刻。目標 2500ms 以内。
 *   fcp     First Contentful Paint (index.html の「読み込み中」表示が画面に出た時刻。旧版は重い初期化の後まで出なかった)。
 *   script  index の JS が届いた時刻 (resource の responseEnd)。
 *   ak2:*   アプリが performance.mark で残す区間 (app-start / game / app-ready / renderer (WebGL と環境マップ) / hangar (格納庫の生成とシェーダーのコンパイル開始) / hangar-visible)。
 * 各 dist について中央値・最小・最大を出す。マシン負荷 (loadavg) も出す (他の作業と並行しているとき fps・時間は大きく変わる)。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { cpus, homedir, loadavg } from 'node:os';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME =
  process.env.CHROME_PATH ?? join(homedir(), 'Library/Caches/ms-playwright/chromium-1224/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

const argv = process.argv.slice(2);
const arg = (k: string, d: string): string => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const N = Number(arg('n', '5'));
const PORT = Number(arg('port', '5250'));
const W = Number(arg('w', '1280'));
const H = Number(arg('h', '720'));
const SHOT = arg('shot', '');
const noBuild = argv.includes('--nobuild');
const fresh = !argv.includes('--reuse-browser');
const CACHE = join(ROOT, 'node_modules/.cache/ak2-startup');

interface Target {
  label: string;
  dist: string;
}
const targets: Target[] = argv
  .filter((a) => a.startsWith('--dist='))
  .map((a) => {
    const v = a.slice(7);
    const eq = v.indexOf('=');
    return eq > 0 ? { label: v.slice(0, eq), dist: resolve(ROOT, v.slice(eq + 1)) } : { label: v.split('/').pop() ?? v, dist: resolve(ROOT, v) };
  });

const median = (a: number[]): number => {
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

let server: Server | null = null;
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };
/** 全 dist を 1 つの静的サーバー (127.0.0.1:PORT/<label>/) で配信する。dist は base './' なので接頭辞つきでも動く */
async function serve(): Promise<void> {
  const byLabel = new Map(targets.map((t) => [t.label, t.dist]));
  server = createServer((req, res) => {
    const u = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const m = /^\/([^/]+)(\/.*)?$/.exec(u);
    const dist = m ? byLabel.get(m[1]) : undefined;
    if (!m || !dist) {
      res.writeHead(404).end();
      return;
    }
    let rel = m[2] ?? '/';
    if (rel.endsWith('/')) rel += 'index.html';
    const file = join(dist, normalize(rel));
    if (!file.startsWith(dist) || !existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(readFileSync(file));
  });
  await new Promise<void>((r) => server!.listen(PORT, '127.0.0.1', r));
}
function stop(): void {
  server?.close();
  server = null;
}

interface Run {
  ready: number;
  fcp: number;
  script: number;
  marks: Record<string, number>;
}

async function main(): Promise<void> {
  if (targets.length === 0) {
    const dist = join(CACHE, 'dist-current');
    if (!noBuild) {
      mkdirSync(CACHE, { recursive: true });
      execFileSync(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist, '--emptyOutDir'], { cwd: ROOT, stdio: 'pipe' });
    }
    targets.push({ label: 'current', dist });
  }
  let browser = await chromium.launch({ headless: true, executablePath: CHROME, args: ARGS });
  const results = new Map<string, Run[]>();
  try {
    // 交互 (A,B,A,B...) に計測して、時間帯によるマシン負荷の差を打ち消す
    await serve();
    for (const t of targets) results.set(t.label, []);
    for (let i = 0; i < N; i++) {
      for (const t of targets) {
        const url = `http://127.0.0.1:${PORT}/${t.label}`;
        if (fresh && (i > 0 || t !== targets[0])) {
          // 前の計測の GPU プロセス (ソフトウェア GL の後始末・キャッシュ) の影響を受けないよう、計測ごとにブラウザーを起動し直す
          await browser.close().catch(() => {});
          browser = await chromium.launch({ headless: true, executablePath: CHROME, args: ARGS });
        }
        const ctx = await browser.newContext({ viewport: { width: W, height: H } });
        const page = await ctx.newPage();
        await page.addInitScript(() => {
          const w = window as unknown as { __fcp?: number; __name?: unknown };
          w.__name = w.__name || ((fn: unknown) => fn); // tsx (esbuild keepNames) が page.evaluate の関数に差し込む __name のシム
          new PerformanceObserver((list) => {
            for (const e of list.getEntries()) {
              if (e.name === 'first-contentful-paint') {
                w.__fcp = e.startTime;
              }
            }
          }).observe({ type: 'paint', buffered: true });
        });
        await page.goto(url + '/', { waitUntil: 'load', timeout: 240000 });
        await page.waitForFunction(() => (window as unknown as { AK2_BENCH?: unknown }).AK2_BENCH !== undefined, undefined, { timeout: 240000 });
        const r = await page.evaluate(
          () =>
            new Promise<Run>((res) => {
              const w = window as unknown as { __fcp?: number };
              // 読み込み中の表示 (#boot-loading) がある版は、アプリが格納庫の最初の 1 枚が画面に出たときに残す mark を待つ。無い版 (旧) は rAF 2 回
              const hasBoot = document.getElementById('boot-loading') !== null;
              let frames = 0;
              const poll = (): void => {
                frames++;
                const m = performance.getEntriesByName('ak2:hangar-visible')[0];
                if (hasBoot ? m !== undefined : frames >= 2) {
                  const done = (): void => {
                    const js = (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).find((e) => e.name.endsWith('.js'));
                    const marks: Record<string, number> = {};
                    for (const mk of performance.getEntriesByType('mark')) if (mk.name.startsWith('ak2:')) marks[mk.name] = Math.round(mk.startTime);
                    res({ ready: m ? m.startTime : performance.now(), fcp: w.__fcp ?? NaN, script: js ? js.responseEnd : NaN, marks });
                  };
                  const t0 = performance.now();
                  const waitFcp = (): void => (w.__fcp !== undefined || performance.now() - t0 > 3000 ? done() : void setTimeout(waitFcp, 50));
                  waitFcp();
                } else requestAnimationFrame(poll);
              };
              requestAnimationFrame(poll);
            }),
        );
        results.get(t.label)!.push(r);
        console.log(
          `[${t.label} #${i + 1}] ready=${r.ready.toFixed(0)}ms fcp=${r.fcp.toFixed(0)}ms script=${r.script.toFixed(0)}ms marks=${JSON.stringify(r.marks)} loadavg1=${loadavg()[0].toFixed(0)}`,
        );
        if (SHOT && i === 0) {
          const p = SHOT.replace(/(\.png)?$/, `-${t.label}.png`);
          mkdirSync(dirname(resolve(ROOT, p)), { recursive: true });
          await page.screenshot({ path: resolve(ROOT, p), timeout: 120000 });
          console.log(`[${t.label}] screenshot ${p}`);
        }
        await ctx.close();
      }
    }
  } finally {
    await browser.close().catch(() => {});
    stop();
  }
  console.log(`\n# startup-bench ${W}x${H} n=${N} cpus=${cpus().length} loadavg(1/5/15)=${loadavg().map((x) => x.toFixed(0)).join('/')}`);
  for (const [label, runs] of results) {
    const rd = runs.map((r) => r.ready);
    const fc = runs.map((r) => r.fcp);
    console.log(
      `${label}: ready median=${median(rd).toFixed(0)}ms min=${Math.min(...rd).toFixed(0)} max=${Math.max(...rd).toFixed(0)} (n=${runs.length}) | fcp median=${median(fc).toFixed(0)}ms | all=${rd.map((x) => x.toFixed(0)).join(',')}`,
    );
  }
}

process.on('SIGINT', () => {
  stop();
  process.exit(130);
});
main().catch((e) => {
  console.error(e);
  stop();
  process.exit(1);
});
