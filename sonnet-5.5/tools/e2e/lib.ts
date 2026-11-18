/**
 * e2e 共通基盤: 配信サーバー(vite build -> vite preview)、Playwright セッション、結果記録、視点・移動のドライバー。
 *
 * 時間の扱い: ソフトウェア描画 (SwiftShader) はマシン負荷で fps が 0.2〜30 と大きく変わる。実時間の sleep に頼らないため、
 * 既定では Playwright の fake clock (page.clock) を pause し、page.clock.fastForward(ms) で「rAF を1回だけ、フレーム間隔 ms で」
 * 進める (stepped モード)。ゲーム側は rAF の timestamp 差を dt として使うので、ms がそのまま1フレームの dt になる。
 * 時間依存の判定は全て snapshot.elapsedSeconds (ゲーム内時間) で行う。入力 (キー/マウス/クリック) は本物のイベント。
 */
import { chromium } from 'playwright';
import type { Browser, BrowserContext, CDPSession, Page } from 'playwright';
import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAMERA } from '../../src/config';
import type { Snapshot } from '../../src/sim/bench';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const PORT = Number(process.env.E2E_PORT ?? 5210);
/** スクリーンショットの出力先 (.gitignore 済み。納品物の docs/ には書かない) */
export const SHOT_DIR = join(ROOT, 'test-results/e2e');
export const DIST = join(ROOT, 'node_modules/.cache/ak2-e2e/dist');
export const CHROME =
  process.env.CHROME_PATH ?? join(homedir(), 'Library/Caches/ms-playwright/chromium-1224/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
export const CHROME_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------------------------------
// 結果の記録
// ---------------------------------------------------------------------------------------------------------------------
/** pass: 実機で確認 / fail: 不具合 / synthetic: 本物のイベントを作れず合成イベントで確認 / unverified: 確認できず / info: 参考値 */
export type Status = 'pass' | 'fail' | 'synthetic' | 'unverified' | 'info';
export interface Check {
  section: number;
  id: string;
  title: string;
  status: Status;
  detail: string;
  data?: unknown;
}
export const checks: Check[] = [];
export const images: { path: string; note: string }[] = [];
export const state = { section: 0 };

export function rec(id: string, title: string, status: Status, detail: string, data?: unknown): void {
  checks.push({ section: state.section, id, title, status, detail, data });
  const tag = status.toUpperCase().padEnd(10);
  console.log(`[${tag}] ${id} ${title}${detail ? ' :: ' + detail : ''}`);
}
export function ok(id: string, title: string, cond: boolean, detail: string, data?: unknown): boolean {
  rec(id, title, cond ? 'pass' : 'fail', detail, data);
  return cond;
}
export const near = (a: number, b: number, tol: number): boolean => Number.isFinite(a) && Math.abs(a - b) <= tol;
export const f = (n: number | null | undefined, d = 3): string => (n === null || n === undefined || !Number.isFinite(n) ? String(n) : n.toFixed(d));
export const hspeed = (s: Snapshot): number => Math.hypot(s.player.velocity[0], s.player.velocity[2]);
export const jsonEq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------------------------------------------------------------
// 配信サーバー
// ---------------------------------------------------------------------------------------------------------------------
export interface Server {
  url: string;
  stop(): void;
}
let serverProc: ChildProcess | null = null;

export async function startServer(): Promise<Server> {
  if (process.env.E2E_URL) return { url: process.env.E2E_URL, stop: () => {} };
  const vite = join(ROOT, 'node_modules/vite/bin/vite.js');
  // 他担当の変更で一時的にビルドが壊れることがあるので数回やり直す
  let lastErr: unknown = null;
  for (let i = 0; i < 4; i++) {
    try {
      execFileSync(process.execPath, [vite, 'build', '--outDir', DIST, '--emptyOutDir'], { cwd: ROOT, stdio: 'pipe' });
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      await sleep(3000);
    }
  }
  if (lastErr) throw new Error(`vite build failed: ${String((lastErr as { stderr?: Buffer }).stderr ?? lastErr)}`);
  mkdirSync(DIST, { recursive: true });
  await spawnPreview();
  return { url: `http://127.0.0.1:${PORT}`, stop: stopServer };
}

/** vite preview を起動して応答するまで待つ (dist は build 済み) */
async function spawnPreview(): Promise<void> {
  const vite = join(ROOT, 'node_modules/vite/bin/vite.js');
  const proc = spawn(process.execPath, [vite, 'preview', '--outDir', DIST, '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: ROOT,
    stdio: 'pipe',
    detached: true,
  });
  serverProc = proc;
  let out = '';
  proc.stdout?.on('data', (d: Buffer) => (out += d.toString()));
  proc.stderr?.on('data', (d: Buffer) => (out += d.toString()));
  const url = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(url + '/');
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

/**
 * 配信サーバーが外部要因 (他の作業の pkill 等) で落ちていたら、build 済みの dist で起動し直す。
 * E2E_URL 指定 (外部サーバー) のときは何もしない。
 */
export async function ensureServer(base: string): Promise<void> {
  if (process.env.E2E_URL) return;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(base + '/');
      if (r.ok) return;
    } catch {
      /* 落ちている */
    }
    console.log(`[server    ] ${base} が応答しないため vite preview を起動し直します (${i + 1}回目)`);
    stopServer();
    await sleep(500);
    await spawnPreview().catch((e) => console.log(`[server    ] 再起動失敗: ${String(e)}`));
  }
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
  type: string;
  text: string;
}
/** スクリーンショット(ReadPixels)のときだけ SwiftShader が出す GL ドライバーの警告。アプリのログではない */
export const GL_DRIVER_NOISE = /GL Driver Message|GPU stall due to ReadPixels/;

export interface OpenOpts {
  w?: number;
  h?: number;
  /** false: Emulation.setFocusEmulationEnabled を送らない (ポインターロックが取れない状況を作る) */
  focus?: boolean;
  /** false: 実時間の rAF で動かす (fps 計測など) */
  stepped?: boolean;
  query?: string;
}

export class Sess {
  logs: LogEntry[] = [];
  mx = 0;
  my = 0;
  /** 追跡している視点角 (mouse look の適用量から積算)。sortie 直後は PLAYER_START.yaw / pitch -0.1 */
  yaw = Math.PI;
  pitch = -0.1;
  stepped: boolean;

  private constructor(
    public name: string,
    public browser: Browser,
    public ctx: BrowserContext,
    public page: Page,
    public cdp: CDPSession,
    public base: string,
    stepped: boolean,
  ) {
    this.stepped = stepped;
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') this.logs.push({ kind: 'console', type: m.type(), text: m.text() });
    });
    page.on('pageerror', (e) => this.logs.push({ kind: 'pageerror', type: 'error', text: e.message }));
    page.on('requestfailed', (r) => this.logs.push({ kind: 'requestfailed', type: 'error', text: `${r.url()} ${r.failure()?.errorText ?? ''}` }));
    page.on('response', (r) => {
      if (r.status() >= 400) this.logs.push({ kind: 'http', type: 'error', text: `${r.status()} ${r.url()}` });
    });
  }

  static async open(browser: Browser, base: string, name: string, o: OpenOpts = {}): Promise<Sess> {
    const w = o.w ?? 1280;
    const h = o.h ?? 720;
    const stepped = o.stepped ?? true;
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    // 他の作業と並行してマシン負荷が数百になることがある: ロードや操作の待ちを長めに取る
    page.setDefaultNavigationTimeout(240000);
    page.setDefaultTimeout(120000);
    const cdp = await ctx.newCDPSession(page);
    if (o.focus ?? true) await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    if (stepped) await page.clock.install({ time: new Date('2026-01-01T00:00:00') });
    await page.addInitScript(() => {
      const w = window as unknown as Record<string, unknown>;
      // tsx(esbuild keepNames) が page.evaluate の関数に差し込む __name のシム
      w.__name = w.__name || ((fn: unknown) => fn);
      const e2e = { keys: [] as { t: string; c: string; r: boolean }[], events: [] as string[], rafCalls: 0 };
      w.__e2e = e2e;
      window.addEventListener('keydown', (e) => e2e.keys.push({ t: 'kd', c: e.code, r: e.repeat }), true);
      window.addEventListener('keyup', (e) => e2e.keys.push({ t: 'ku', c: e.code, r: false }), true);
      document.addEventListener('pointerlockchange', () => e2e.events.push(document.pointerLockElement ? 'lock' : 'unlock'));
      document.addEventListener('pointerlockerror', () => e2e.events.push('lockerror'));
      window.addEventListener('blur', () => e2e.events.push('blur'));
      const orig = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (cb: FrameRequestCallback): number =>
        orig((ts: number) => {
          e2e.rafCalls++;
          cb(ts);
        });
    });
    const s = new Sess(name, browser, ctx, page, cdp, base, stepped);
    await ensureServer(base);
    await page.goto(`${base}/${o.query ?? ''}`, { waitUntil: 'load' });
    await page.waitForFunction(() => (window as unknown as { AK2_BENCH?: unknown }).AK2_BENCH !== undefined, undefined, { timeout: 240000 });
    if (stepped) await page.clock.pauseAt(new Date('2026-01-01T03:00:00'));
    return s;
  }

  async close(): Promise<void> {
    await this.ctx.close().catch(() => {});
  }

  /** アプリ由来の警告/エラー (GL ドライバー由来を除く) */
  appProblems(): LogEntry[] {
    return this.logs.filter((l) => !GL_DRIVER_NOISE.test(l.text));
  }
  driverNoise(): number {
    return this.logs.filter((l) => GL_DRIVER_NOISE.test(l.text)).length;
  }

  async snap(): Promise<Snapshot> {
    return this.page.evaluate(() => (window as unknown as { AK2_BENCH: { getSnapshot(): Snapshot } }).AK2_BENCH.getSnapshot());
  }

  /** 条件が成り立つまで実時間 50ms 間隔でポーリング (fake clock に依存しない) */
  async waitUntil<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 20000, what = 'condition'): Promise<T> {
    const t0 = Date.now();
    for (;;) {
      const v = await fn();
      if (v) return v as T;
      if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${what}`);
      await sleep(50);
    }
  }
  async waitState(st: Snapshot['state'], timeoutMs = 20000): Promise<Snapshot> {
    return this.waitUntil(async () => {
      const sn = await this.snap();
      return sn.state === st ? sn : null;
    }, timeoutMs, `state=${st}`);
  }

  // ---- フレームの進め方
  /** n フレーム進める。stepped: 各フレームの dt = ms。natural: 実時間で n*ms 待つ */
  async step(n = 1, ms = 16): Promise<void> {
    if (this.stepped) {
      for (let i = 0; i < n; i++) await this.page.clock.fastForward(ms);
    } else {
      await sleep(n * ms);
    }
  }
  /** ゲーム内時間で sec 秒進める (stepped は ms 刻みのフレーム)。戻り値は最後のスナップショット */
  async play(sec: number, ms = 50): Promise<Snapshot> {
    const t0 = (await this.snap()).elapsedSeconds;
    let sn = await this.snap();
    for (let i = 0; i < 100000 && sn.elapsedSeconds < t0 + sec - 1e-9 && sn.state === 'playing'; i++) {
      await this.step(1, ms);
      sn = await this.snap();
    }
    return sn;
  }

  // ---- 入力 (本物のイベント)
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
    // page.click の「stable」待ちは実 rAF を2回待つため、高負荷でソフトウェア描画の fps が 0.2 まで落ちると数十秒かかる。
    // 座標を指定した本物のマウス操作 (move + down + up) なら待たずに済む。
    await this.page.mouse.click(this.mx, this.my);
  }
  /** ポインターロック中のマウス移動。CDP の mouseMoved は前回位置との差が movementX/Y になる (実測) */
  async look(dx: number, dy: number): Promise<void> {
    const rx = Math.round(dx);
    const ry = Math.round(dy);
    if (rx === 0 && ry === 0) return;
    this.mx += rx;
    this.my += ry;
    await this.page.mouse.move(this.mx, this.my);
    this.yaw -= rx * CAMERA.SENSITIVITY;
    this.pitch = Math.max(CAMERA.PITCH_MIN, Math.min(CAMERA.PITCH_MAX, this.pitch - ry * CAMERA.SENSITIVITY));
  }
  /** 視点を目標の yaw / pitch へ回す (mouse look のみ) */
  async aim(yaw: number, pitch?: number): Promise<void> {
    let d = yaw - this.yaw;
    d = Math.atan2(Math.sin(d), Math.cos(d)); // -π..π
    const dx = -d / CAMERA.SENSITIVITY;
    let dy = 0;
    if (pitch !== undefined) dy = -(Math.max(CAMERA.PITCH_MIN, Math.min(CAMERA.PITCH_MAX, pitch)) - this.pitch) / CAMERA.SENSITIVITY;
    await this.look(dx, dy);
  }

  async gotoUrl(query: string): Promise<void> {
    await ensureServer(this.base);
    await this.page.goto(`${this.base}/${query}`, { waitUntil: 'load' });
  }

  // ---- ゲームの進行操作
  /** 格納庫で出撃ボタンを実クリック -> playing まで待つ */
  async sortie(): Promise<Snapshot> {
    await this.click('.gar-buttons .btn-primary');
    const sn = await this.waitState('playing', 30000);
    this.yaw = Math.PI;
    this.pitch = -0.1;
    return sn;
  }
  async shot(name: string, note: string): Promise<string> {
    mkdirSync(SHOT_DIR, { recursive: true });
    const p = join(SHOT_DIR, `e2e-${name}.png`);
    await this.page.screenshot({ path: p, timeout: 120000 });
    images.push({ path: p, note });
    return p;
  }

  /** WASD の keydown から現在の yaw を測る (desiredHorizontalDirection は入力とカメラ yaw だけで決まる) */
  async calibrateYaw(): Promise<number> {
    await this.down('KeyW');
    await this.step(1, 16);
    const d = (await this.snap()).player.movement.desiredHorizontalDirection;
    await this.up('KeyW');
    await this.step(1, 16);
    this.yaw = Math.atan2(-d[0], -d[1]);
    return this.yaw;
  }

  // ---- CDP 計測
  async heapUsedMB(): Promise<number> {
    await this.cdp.send('HeapProfiler.enable').catch(() => {});
    await this.cdp.send('HeapProfiler.collectGarbage');
    const u = await this.cdp.send('Runtime.getHeapUsage');
    return u.usedSize / 1048576;
  }
  async listenerCounts(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const target of ['window', 'document']) {
      const ev = await this.cdp.send('Runtime.evaluate', { expression: target });
      const objectId = ev.result.objectId;
      if (!objectId) continue;
      const r = (await this.cdp.send('DOMDebugger.getEventListeners', { objectId })) as { listeners: { type: string }[] };
      for (const l of r.listeners) out[`${target}:${l.type}`] = (out[`${target}:${l.type}`] ?? 0) + 1;
    }
    return out;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// 移動ドライバー (本物のキー + マウス移動で実ステージを歩く)
// ---------------------------------------------------------------------------------------------------------------------
export interface Pt {
  x: number;
  y: number;
  z: number;
}
export const yawToward = (from: [number, number, number], to: { x: number; z: number }): number => Math.atan2(-(to.x - from[0]), -(to.z - from[2]));
export const dist3 = (a: [number, number, number], b: [number, number, number]): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export interface WalkResult {
  reason: 'until' | 'end' | 'state' | 'timeout';
  snap: Snapshot;
  waypoint: number;
}

/**
 * pts を順に歩く: W を押し続け、毎フレーム (dtMs) 進行方向へ視点を回す。
 * until(snap) が true / 状態が playing でなくなった / 最後の点に着いた / maxSec(ゲーム時間) を超えたら止める (W は押したまま)。
 */
export async function walkPath(
  s: Sess,
  pts: readonly Pt[],
  o: { until?: (sn: Snapshot) => boolean; maxSec: number; dtMs?: number; arrive?: number; start?: number; jumpAssist?: boolean },
): Promise<WalkResult> {
  const dt = o.dtMs ?? 100;
  const arrive = o.arrive ?? 2.5;
  let wp = o.start ?? 1;
  await s.down('KeyW');
  let sn = await s.snap();
  const t0 = sn.elapsedSeconds;
  let stuck = 0;
  let lastPos = sn.player.position;
  for (;;) {
    if (sn.state !== 'playing') return { reason: 'state', snap: sn, waypoint: wp };
    if (o.until?.(sn)) return { reason: 'until', snap: sn, waypoint: wp };
    if (sn.elapsedSeconds - t0 > o.maxSec) return { reason: 'timeout', snap: sn, waypoint: wp };
    const p = sn.player.position;
    while (wp < pts.length && Math.hypot(pts[wp].x - p[0], pts[wp].z - p[2]) < arrive) wp++;
    if (wp >= pts.length) return { reason: 'end', snap: sn, waypoint: wp };
    await s.aim(yawToward(p, pts[wp]));
    // 詰まり検出 (壁に押し付けている)
    stuck = Math.hypot(p[0] - lastPos[0], p[2] - lastPos[2]) < 0.15 * (dt / 100) ? stuck + 1 : 0;
    lastPos = p;
    if (o.jumpAssist && stuck >= 3) {
      await s.down('Space');
      await s.step(1, 16);
      await s.up('Space');
      stuck = 0;
    }
    await s.step(1, dt);
    sn = await s.snap();
  }
}

/** W を離して立ち止まり、状態が playing でなくなる (失敗) まで進める。到達したら true */
export async function standUntilEnd(s: Sess, maxSec: number, dtMs = 200): Promise<Snapshot> {
  await s.up('KeyW');
  let sn = await s.snap();
  const t0 = sn.elapsedSeconds;
  while (sn.state === 'playing' && sn.elapsedSeconds - t0 < maxSec) {
    await s.step(1, dtMs);
    sn = await s.snap();
  }
  return sn;
}
