#!/usr/bin/env node
/**
 * Delivery checks (SPEC §1, §10, §11): what an evaluator does before the game is even on screen.
 * No browser is needed: the real npm scripts are started and asked over HTTP, and the files are read.
 *
 *   node tools/e2e/delivery.mjs --port=5190 [--only=q,r,s,t] [--keep=<dir>]
 *
 * Sections:
 *   q  `npm run dev -- --host 0.0.0.0 --port <port> --strictPort` answers 200 whatever name the machine is
 *      reached under (Host header: IP, localhost, a container / workspace host name), for the page and for
 *      a module; the page declares an inline icon
 *   r  `npm run build` (type check + bundle; output redirected to a temporary directory, the repository's
 *      dist/ is not touched): only index.html + one script + one style sheet, no reference to another
 *      origin, none of the dev-harness globals in the bundle; `vite preview` of that build answers 200 for
 *      the same Host headers
 *   s  README.md: start-up commands, controls, stage, the §4.6 verification section, verified / unverified
 *      items and known issues are present
 *   t  the shipped page loads nothing from dev/ (the harness pages are separate documents)
 *
 * The port must be free. Needs `npm` on PATH (on this machine: run through `x`, see tools/e2e/README.md).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Checks } from './lib.mjs';

const arg = (name, fallback = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const only = arg('only') ? new Set(arg('only').split(',')) : null;
const want = (id) => !only || only.has(id);
const port = Number(arg('port', '5190'));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = path.resolve(arg('keep', fs.mkdtempSync(path.join(os.tmpdir(), 'ak2-delivery-'))));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Host headers an evaluator's browser may send: the server must not care. */
const HOSTS = [`127.0.0.1:${port}`, `localhost:${port}`, `10.20.30.40:${port}`, 'evaluator.example.com', `ak2-game.internal:${port}`, 'abc123-5173.preview.example.app'];

/** GET http://127.0.0.1:<port><urlPath> with an arbitrary Host header → { status, body }. */
function get(urlPath, host) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET', headers: { Host: host, Accept: '*/*' }, timeout: 20000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => resolve({ status: 0, body: String(err.message) }));
    req.end();
  });
}

/** Starts a process (own process group so that the whole tree can be stopped) and collects its output. */
function start(command, args) {
  const child = spawn(command, args, { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  const proc = { child, output: '', exited: null };
  child.stdout.on('data', (d) => (proc.output += d));
  child.stderr.on('data', (d) => (proc.output += d));
  child.on('error', (err) => {
    proc.output += '\n[spawn error] ' + err.message;
    proc.exited = -1;
  });
  child.on('exit', (code) => (proc.exited = code ?? -1));
  return proc;
}
async function stop(proc) {
  if (proc.exited !== null) return;
  try {
    process.kill(-proc.child.pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
  for (let i = 0; i < 50 && proc.exited === null; i++) await sleep(100);
  if (proc.exited === null) {
    try {
      process.kill(-proc.child.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}
/** Runs a command to completion → { code, output }. */
function run(command, args) {
  return new Promise((resolve) => {
    const proc = start(command, args);
    proc.child.on('exit', (code) => resolve({ code: code ?? -1, output: proc.output }));
    proc.child.on('error', (err) => resolve({ code: -1, output: proc.output + String(err.message) }));
  });
}
/** Waits until the server answers on the port (any status) or the process dies. */
async function waitUp(proc, seconds = 90) {
  for (let i = 0; i < seconds * 4; i++) {
    if (proc.exited !== null) return false;
    const r = await get('/', `127.0.0.1:${port}`);
    if (r.status !== 0) return true;
    await sleep(250);
  }
  return false;
}
const tail = (text, n = 6) => text.trim().split('\n').slice(-n).join(' | ').slice(-600);

async function checkHosts(checks, label, paths) {
  for (const [what, urlPath, marker] of paths) {
    const results = [];
    for (const host of HOSTS) {
      const r = await get(urlPath, host);
      results.push({ host, status: r.status, ok: r.status === 200 && r.body.includes(marker), body: r.status === 200 ? undefined : r.body.slice(0, 120) });
    }
    checks.check(`${label}: ${what} answers 200 for every Host header (IP, localhost, host names)`, results.every((r) => r.ok), results.map((r) => (r.ok ? `${r.host} 200` : r)));
  }
}

const checks = new Checks('delivery');
const running = [];
const stopAll = async () => {
  for (const p of running) await stop(p);
};
process.on('SIGINT', () => stopAll().finally(() => process.exit(130)));
process.on('SIGTERM', () => stopAll().finally(() => process.exit(143)));

try {
  // ═══════════════════════════ q. npm run dev ═══════════════════════════
  if (want('q'))
    await checks.section('q. npm run dev -- --host 0.0.0.0 --port <port>', async () => {
      const dev = start('npm', ['run', 'dev', '--', '--host', '0.0.0.0', '--port', String(port), '--strictPort']);
      running.push(dev);
      const up = await waitUp(dev);
      checks.check(`q: the dev server starts on port ${port}`, up, tail(dev.output));
      if (up) {
        await checkHosts(checks, 'q[dev]', [
          ['the page', '/', 'ARMORED KOALA 2 DEMO'],
          ['the entry module', '/src/main.ts', 'exposeSnapshotApi'],
        ]);
        const page = await get('/', `127.0.0.1:${port}`);
        checks.check('q[dev]: the page declares an inline icon (no /favicon.ico request by browsers)', /<link rel="icon"[^>]*href="data:image\/svg\+xml,/.test(page.body), (page.body.match(/<link rel="icon"[^>]{0,80}/) ?? [null])[0]);
        const blocked = /Blocked request|not allowed/i.test(dev.output);
        checks.check('q[dev]: the server log reports no blocked request', !blocked, blocked ? tail(dev.output) : undefined);
      }
      await stop(dev);
    });

  // ═══════════════════════════ r. npm run build + preview ═══════════════════════════
  if (want('r'))
    await checks.section('r. npm run build and vite preview', async () => {
      // The real build script (tsc --noEmit && vite build); the extra arguments reach `vite build` and only
      // redirect the output so that the repository's dist/ stays as it is.
      const build = await run('npm', ['run', 'build', '--', '--outDir', outDir, '--emptyOutDir']);
      checks.check('r: `npm run build` (type check + bundle) exits with 0', build.code === 0, build.code === 0 ? tail(build.output, 3) : tail(build.output, 12));
      if (build.code !== 0) return;
      const files = [];
      const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) walk(p);
          else files.push(path.relative(outDir, p));
        }
      };
      walk(outDir);
      const js = files.filter((f) => f.endsWith('.js'));
      const css = files.filter((f) => f.endsWith('.css'));
      checks.check('r: the build is index.html + one script + one style sheet (no dev page, no other asset)', files.length === 3 && files.includes('index.html') && js.length === 1 && css.length === 1, files);
      const text = Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(outDir, f), 'utf8')]));
      // references to another origin: anything with a scheme and a host that is not an XML namespace
      const foreign = [];
      for (const [f, t] of Object.entries(text)) {
        for (const m of t.matchAll(/\b(?:https?:|wss?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}[^\s"'`)<>]*/gi)) {
          if (/^(?:https?:)?\/\/www\.w3\.org\/(?:2000\/svg|1999\/xlink|1999\/xhtml|1998\/Math\/MathML|XML\/1998\/namespace|2000\/xmlns\/)/.test(m[0])) continue;
          foreign.push(f + ': ' + m[0].slice(0, 80));
        }
      }
      checks.check('r: the build references no other origin (only XML namespace identifiers)', foreign.length === 0, foreign.slice(0, 5));
      // globals the dev harness pages define for their own test scripts must not be in the shipped bundle
      const devDir = path.join(root, 'dev');
      const names = new Set();
      for (const f of fs.readdirSync(devDir)) {
        if (!/\.(ts|html)$/.test(f)) continue;
        for (const m of fs.readFileSync(path.join(devDir, f), 'utf8').matchAll(/\b__[A-Za-z][A-Za-z0-9]*\b/g)) names.add(m[0]);
      }
      names.delete('__AK2__');
      const bundle = Object.values(text).join('\n');
      const leaked = [...names].filter((n) => new RegExp('\\b' + n + '\\b').test(bundle));
      checks.check('r: none of the dev-harness globals is in the build', leaked.length === 0, { harnessNames: [...names].sort(), leaked });
      checks.check('r: the build publishes window.__AK2__ and declares the inline icon', bundle.includes('__AK2__') && /<link rel="icon"[^>]*href="data:image\/svg\+xml,/.test(text['index.html']), undefined);

      const preview = start('npx', ['vite', 'preview', '--outDir', outDir, '--host', '0.0.0.0', '--port', String(port), '--strictPort']);
      running.push(preview);
      const up = await waitUp(preview);
      checks.check(`r: vite preview serves the build on port ${port}`, up, tail(preview.output));
      if (up) {
        await checkHosts(checks, 'r[preview]', [
          ['the page', '/', 'ARMORED KOALA 2 DEMO'],
          ['the script', '/' + js[0].split(path.sep).join('/'), '__AK2__'],
        ]);
      }
      await stop(preview);
    });

  // ═══════════════════════════ s. README ═══════════════════════════
  if (want('s'))
    await checks.section('s. README.md', async () => {
      const file = path.join(root, 'README.md');
      const exists = fs.existsSync(file);
      checks.check('s: README.md exists in the project root', exists, file);
      if (!exists) return;
      const t = fs.readFileSync(file, 'utf8');
      const need = [
        ['start-up: npm ci', /npm ci/],
        ['start-up: npm run build', /npm run build/],
        ['start-up: npm run dev -- --host 0.0.0.0 --port 5173', /npm run dev -- --host 0\.0\.0\.0 --port 5173/],
        ['controls (操作方法)', /^#+ .*操作/m],
        ['stage layout (ステージ構成)', /^#+ .*ステージ/m],
        ['verification section (検証)', /^#+ .*検証/m],
        ['§4.6 conditions A01–A13', /A01/],
        ['shots fired / hits (発射数・命中数)', /発射数[\s\S]*命中数|命中数[\s\S]*発射数/],
        ['solution residual (残差)', /残差/],
        ['items not done (未実施)', /未実施/],
        ['verified items (確認した項目)', /確認した項目|確認済み/],
        ['unverified items (未確認項目)', /未確認/],
        ['known issues (既知の問題)', /既知の問題/],
        ['read-only API and the dev harness pages', /__AK2__[\s\S]*dev\//],
        ['seed query', /seed/],
      ];
      const missing = need.filter(([, re]) => !re.test(t)).map(([label]) => label);
      checks.check('s: README has start-up, controls, stage, §4.6 verification (conditions, shots, hits, residual, not done), verified / unverified items, known issues', missing.length === 0, missing.length ? { missing } : { bytes: t.length });
    });

  // ═══════════════════════════ t. the shipped page and dev/ ═══════════════════════════
  if (want('t'))
    await checks.section('t. the shipped page loads nothing from dev/', async () => {
      const offenders = [];
      const scan = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) scan(p);
          else if (/\.(ts|css)$/.test(e.name)) {
            const t = fs.readFileSync(p, 'utf8');
            if (/from\s+['"][^'"]*\/dev\/|import\(\s*['"][^'"]*\/dev\//.test(t)) offenders.push(path.relative(root, p));
          }
        }
      };
      scan(path.join(root, 'src'));
      const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
      const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
      checks.check('t: index.html loads only /src/main.ts; nothing under src/ imports from dev/', offenders.length === 0 && scripts.length === 1 && scripts[0] === '/src/main.ts', { scripts, offenders });
      // window assignments in the shipped sources: only the read-only API (defined in src/app.ts)
      const assigns = [];
      const scanAssign = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) scanAssign(p);
          else if (e.name.endsWith('.ts')) {
            const lines = fs.readFileSync(p, 'utf8').split('\n');
            lines.forEach((line, i) => {
              if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
              if (/\b(window|globalThis|self)\s*(\.\s*[A-Za-z_$][\w$]*|\[[^\]]+\])\s*=[^=]/.test(line) || /Object\.defineProperty\(\s*(window|globalThis|self|target)\b/.test(line)) assigns.push(`${path.relative(root, p)}:${i + 1}: ${line.trim().slice(0, 110)}`);
            });
          }
        }
      };
      scanAssign(path.join(root, 'src'));
      const unexpected = assigns.filter((a) => !(a.startsWith('src/app.ts:') && a.includes("'__AK2__'")));
      checks.check("t: the only global the shipped sources define is window.__AK2__ (src/app.ts, Object.defineProperty, frozen)", unexpected.length === 0 && assigns.some((a) => a.includes("'__AK2__'")), { assigns, unexpected });
    });
} catch (err) {
  checks.check('script completed without exception', false, String(err && err.stack ? err.stack : err));
} finally {
  await stopAll();
  if (!arg('keep')) fs.rmSync(outDir, { recursive: true, force: true });
}
process.exit(checks.finish());
