/**
 * audit-ui: 実ブラウザ (Playwright + Chrome for Testing, SwiftShader) 監査の共通基盤。
 * - 配信: 監査用 vite 設定 (tests/audit-ui/vite.config.ts) で build -> vite preview を 127.0.0.1:5230 で起動 (終了時に必ず停止)
 * - 時間: Playwright の fake clock を pause し、clock.fastForward(ms) で rAF を 1 回だけ進める (ms がそのフレームの dt)。
 *   時間依存の判定はすべてゲーム内時間 (snapshot.elapsedSeconds) で行い、実時間の sleep に頼らない。
 * - 入力: 実キーボード/実マウスイベント。出撃ボタンは実クリックからポインターロックを取得する。
 * - 外部通信: すべてのリクエストを記録し、127.0.0.1:5230 以外へのものは abort する (外部URLへ出ようとしたことを検出する)。
 */
import { chromium } from 'playwright';
import type { Browser, BrowserContext, CDPSession, Page } from 'playwright';
import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Snapshot } from '../../src/sim/bench';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const PORT = 5230;
export const ORIGIN = `http://127.0.0.1:${PORT}`;
/** スクリーンショットの出力先 (.gitignore 済み。納品物の docs/ には書かない) */
export const SHOT_DIR = join(ROOT, 'test-results/audit-ui');
export const DIST = join(ROOT, 'node_modules/.cache/audit-ui/dist');
/** Chrome for Testing の実行ファイル。環境変数 CHROME_PATH で指定する (無ければ macOS の Playwright 既定のキャッシュ) */
export const CHROME =
  process.env.CHROME_PATH ??
  join(homedir(), 'Library/Caches/ms-playwright/chromium-1224/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
export const CHROME_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------------------------------
// 結果の記録
// ---------------------------------------------------------------------------------------------------------------------
export type Status = 'pass' | 'fail' | 'info' | 'unverified';
export interface Check {
  id: string;
  title: string;
  status: Status;
  detail: string;
}
export const checks: Check[] = [];
export const images: { path: string; note: string }[] = [];

export function rec(id: string, title: string, status: Status, detail: string): void {
  checks.push({ id, title, status, detail });
  console.log(`[${status.toUpperCase().padEnd(10)}] ${id} ${title}${detail ? ' :: ' + detail : ''}`);
}
export function ok(id: string, title: string, cond: boolean, detail: string): boolean {
  rec(id, title, cond ? 'pass' : 'fail', detail);
  return cond;
}
export const f = (n: number | null | undefined, d = 3): string => (n === null || n === undefined || !Number.isFinite(n) ? String(n) : n.toFixed(d));

// ---------------------------------------------------------------------------------------------------------------------
// 配信サーバー
// ---------------------------------------------------------------------------------------------------------------------
let serverProc: ChildProcess | null = null;

export async function startServer(): Promise<void> {
  const vite = join(ROOT, 'node_modules/vite/bin/vite.js');
  execFileSync(process.execPath, [vite, 'build', '--config', 'tests/audit-ui/vite.config.ts'], { cwd: ROOT, stdio: 'pipe' });
  mkdirSync(DIST, { recursive: true });
  const proc = spawn(process.execPath, [vite, 'preview', '--outDir', DIST, '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: ROOT,
    stdio: 'pipe',
    detached: true,
  });
  serverProc = proc;
  let out = '';
  proc.stdout?.on('data', (d: Buffer) => (out += d.toString()));
  proc.stderr?.on('data', (d: Buffer) => (out += d.toString()));
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(ORIGIN + '/');
      if (r.ok) return;
    } catch {
      /* まだ起動していない */
    }
    if (proc.exitCode !== null) throw new Error(`vite preview exited: ${out}`);
    await sleep(200);
  }
  stopServer();
  throw new Error(`vite preview did not start: ${out}`);
}

export function stopServer(): void {
  const p = serverProc;
  serverProc = null;
  if (!p || p.pid === undefined) return;
  try {
    process.kill(-p.pid, 'SIGTERM'); // プロセスグループごと止めてポートを残さない
  } catch {
    try {
      p.kill('SIGTERM');
    } catch {
      /* 既に終了 */
    }
  }
}

export async function launchBrowser(): Promise<Browser> {
  return chromium.launch({ headless: true, executablePath: CHROME, args: CHROME_ARGS });
}

// ---------------------------------------------------------------------------------------------------------------------
// セッション
// ---------------------------------------------------------------------------------------------------------------------
export interface LogEntry {
  kind: 'console' | 'pageerror' | 'requestfailed' | 'http';
  text: string;
}
/** スクリーンショット (ReadPixels) のときだけ SwiftShader が出す GL ドライバーの警告。アプリのログではない */
export const GL_DRIVER_NOISE = /GL Driver Message|GPU stall due to ReadPixels/;

export interface OpenOpts {
  w?: number;
  h?: number;
  dpr?: number;
  path?: string;
  query?: string;
  /** false: Emulation.setFocusEmulationEnabled を送らない (ポインターロックが取れない状況を作る) */
  focus?: boolean;
  /** false: 実時間の rAF で動かす */
  stepped?: boolean;
}

export class Sess {
  logs: LogEntry[] = [];
  /** ページが発行した全リクエストの URL (data: を除く) */
  requests: string[] = [];
  /** 外部 (127.0.0.1:5230 以外) へのリクエスト。abort する */
  external: string[] = [];
  mx = 0;
  my = 0;

  private constructor(
    public browser: Browser,
    public ctx: BrowserContext,
    public page: Page,
    public cdp: CDPSession,
    public stepped: boolean,
  ) {
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') this.logs.push({ kind: 'console', text: `${m.type()}: ${m.text()}` });
    });
    page.on('pageerror', (e) => this.logs.push({ kind: 'pageerror', text: e.message }));
    page.on('requestfailed', (r) => this.logs.push({ kind: 'requestfailed', text: `${r.url()} ${r.failure()?.errorText ?? ''}` }));
    page.on('response', (r) => {
      if (r.status() >= 400) this.logs.push({ kind: 'http', text: `${r.status()} ${r.url()}` });
    });
  }

  static async open(browser: Browser, o: OpenOpts = {}): Promise<Sess> {
    const w = o.w ?? 1280;
    const h = o.h ?? 720;
    const stepped = o.stepped ?? true;
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: o.dpr ?? 1 });
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    if (o.focus ?? true) await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    const s = new Sess(browser, ctx, page, cdp, stepped);
    await ctx.route('**/*', async (route) => {
      const url = route.request().url();
      if (url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
      s.requests.push(url);
      if (!url.startsWith(ORIGIN + '/')) {
        s.external.push(url);
        return route.abort();
      }
      return route.continue();
    });
    if (stepped) await page.clock.install({ time: new Date('2026-01-01T00:00:00') });
    await page.addInitScript(() => {
      const w = window as unknown as Record<string, unknown>;
      w.__name = w.__name || ((fn: unknown) => fn);
      const e2e = { keys: [] as string[], events: [] as string[] };
      w.__audit = e2e;
      document.addEventListener('pointerlockchange', () => e2e.events.push(document.pointerLockElement ? 'lock' : 'unlock'));
      document.addEventListener('pointerlockerror', () => e2e.events.push('lockerror'));
      window.addEventListener('blur', () => e2e.events.push('blur'));
    });
    await page.goto(`${ORIGIN}/${o.path ?? ''}${o.query ?? ''}`, { waitUntil: 'load', timeout: 240000 });
    await page.waitForFunction(() => (window as unknown as { AK2_BENCH?: unknown }).AK2_BENCH !== undefined, undefined, { timeout: 240000 });
    if (stepped) await page.clock.pauseAt(new Date('2026-01-01T03:00:00'));
    return s;
  }

  async close(): Promise<void> {
    await this.ctx.close().catch(() => {});
  }

  appProblems(): LogEntry[] {
    return this.logs.filter((l) => !GL_DRIVER_NOISE.test(l.text));
  }

  async snap(): Promise<Snapshot> {
    return this.page.evaluate(() => (window as unknown as { AK2_BENCH: { getSnapshot(): Snapshot } }).AK2_BENCH.getSnapshot());
  }

  async waitUntil<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 20000, what = 'condition'): Promise<T> {
    const t0 = Date.now();
    for (;;) {
      const v = await fn();
      if (v) return v as T;
      if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${what}`);
      await sleep(50);
    }
  }
  async waitState(st: Snapshot['state'], timeoutMs = 30000): Promise<Snapshot> {
    return this.waitUntil(async () => {
      const sn = await this.snap();
      return sn.state === st ? sn : null;
    }, timeoutMs, `state=${st}`);
  }

  /** n フレーム進める。stepped: 各フレームの dt = ms */
  async step(n = 1, ms = 16): Promise<void> {
    if (this.stepped) {
      for (let i = 0; i < n; i++) await this.page.clock.fastForward(ms);
    } else {
      await sleep(n * ms);
    }
  }
  /** ゲーム内時間で sec 秒進める。戻り値は最後のスナップショット */
  async play(sec: number, ms = 50): Promise<Snapshot> {
    let sn = await this.snap();
    const t0 = sn.elapsedSeconds;
    for (let i = 0; i < 100000 && sn.elapsedSeconds < t0 + sec - 1e-9 && sn.state === 'playing'; i++) {
      await this.step(1, ms);
      sn = await this.snap();
    }
    return sn;
  }

  async down(code: string): Promise<void> {
    await this.page.keyboard.down(code);
  }
  async up(code: string): Promise<void> {
    await this.page.keyboard.up(code);
  }
  async click(selector: string): Promise<void> {
    const loc = this.page.locator(selector).first();
    const b = await loc.boundingBox();
    if (!b) throw new Error(`no bounding box for ${selector}`);
    this.mx = b.x + b.width / 2;
    this.my = b.y + b.height / 2;
    await this.page.mouse.click(this.mx, this.my);
  }
  /** ポインターロック中のマウス移動 (CDP mouseMoved の差が movementX/Y になる) */
  async look(dx: number, dy: number): Promise<void> {
    const rx = Math.round(dx);
    const ry = Math.round(dy);
    if (rx === 0 && ry === 0) return;
    this.mx += rx;
    this.my += ry;
    await this.page.mouse.move(this.mx, this.my);
  }

  /** 格納庫で出撃ボタンを実クリック -> playing まで待つ */
  async sortie(): Promise<Snapshot> {
    await this.click('.gar-buttons .btn-primary');
    return this.waitState('playing', 30000);
  }

  async shot(name: string, note: string, clip?: { x: number; y: number; width: number; height: number }): Promise<string> {
    mkdirSync(SHOT_DIR, { recursive: true });
    const p = join(SHOT_DIR, `${name}.png`);
    await this.page.screenshot({ path: p, timeout: 120000, ...(clip ? { clip } : {}) });
    images.push({ path: p, note });
    return p;
  }

  /** ハーネス (window.__app) 上で関数を評価する。fn は (app) => 値 */
  async app<T>(fn: (app: import('../../src/ui/app').App) => T): Promise<T> {
    return this.page.evaluate(`(${fn.toString()})(window.__app)`) as Promise<T>;
  }
  /** app<T> に JSON で渡せる引数を 1 つ付けたもの (fn は自己完結の関数であること: 外側の変数は参照できない) */
  async appWith<A, T>(arg: A, fn: (app: import('../../src/ui/app').App, arg: A) => T): Promise<T> {
    return this.page.evaluate(`(${fn.toString()})(window.__app, ${JSON.stringify(arg)})`) as Promise<T>;
  }
}
