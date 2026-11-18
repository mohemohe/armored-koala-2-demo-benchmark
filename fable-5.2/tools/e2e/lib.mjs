/**
 * Shared helpers for the AK2 end-to-end scripts (playwright-core, headless Chromium via tools/browser.mjs).
 *
 * The scripts drive the game only the way a player (or an evaluator) can: real keyboard / mouse input
 * injected by the browser, DOM clicks on the real buttons, and the read-only `window.__AK2__.getSnapshot()`.
 * Nothing here needs — or may rely on — a debug hook in the page.
 *
 * Base URL
 *   AK2_URL=http://127.0.0.1:5173/ node tools/e2e/<script>.mjs        (or:  … <script>.mjs --url=http://…/)
 *   Default: http://127.0.0.1:5173/ (npm run dev). The harness page is <base>dev/app-test.html.
 *
 * Time
 *   WebGL runs on SwiftShader here: a few frames per second, and the simulation advances at most 0.25 s per
 *   rendered frame, i.e. the game may run in slow motion. NEVER reason in wall-clock time: use
 *   `waitSimSeconds`, `holdKey` (simulation seconds) and compare `snapshot.elapsedSeconds`. Key holds are
 *   quantised to rendered frames (the press and the release each take effect at the next frame), so allow
 *   a tolerance of about two frames (≤ 0.5 s of simulation time) on anything timed by these helpers. What
 *   happens INSIDE the simulation is exact whatever the frame rate (e.g. shots 0.10 s apart).
 *
 * Why 'playing' is slow in this browser
 *   Headless Chromium has no real cursor. While the pointer is locked its browser process keeps trying to
 *   re-centre one and synthesises mouse-move events in a tight loop (about 10 000 per second, all with zero
 *   movement — the game ignores them). That alone keeps two CPU cores busy and makes every frame of the
 *   playing state several times slower than a garage frame, whatever the viewport size. Nothing in the page
 *   can prevent it and it does not happen in a normal browser. Paused / result screens are not affected.
 *   The flood also costs memory in the browser's own processes (hundreds of MB per minute of 'playing' when
 *   frames are slow; the page's JS heap stays flat). Therefore: run ONE pointer-locked browser at a time on
 *   a machine, keep the playing time of one page to a few minutes, and open a fresh page (openGame) per
 *   scenario. On an overloaded machine two such browsers side by side can grind to a halt.
 *
 * Mouse under pointer lock
 *   Headless Chromium emulates the pointer lock: an injected pointer event at viewport position Q arrives
 *   in the page as a move by +Q followed by an "echo" of −Q, a button event as a lone echo — under load up
 *   to a few seconds late. The game's input layer recognises this (pixel-exact) pattern and turns it back
 *   into relative motion; it needs the echo of the lock click plus one more echo to be sure. The helpers
 *   here hide all of that: `sortie` / `resume` / `restart` wait for the echo of their click and then press
 *   and release the RIGHT mouse button once (no function in the game; its echo completes the detection),
 *   and `lookBy` returns only after its events have arrived.
 *   `lookBy(page, dx, dy)` moves the injected pointer by (dx, dy) from its last position — real, trusted
 *   mouse events — but the pointer must stay inside the viewport, so one sortie can only turn by about
 *   ± one viewport width in total with it. `syntheticLook` dispatches script-made `mousemove` events with
 *   movementX / movementY instead (not trusted events, unlimited range); use it only where the range
 *   matters and say so in the report.
 *
 * Scripted pointer lock + virtual frame clock (openGame({ scripted: { lock: true, clock: true } }))
 *   For races that a real browser decides within milliseconds (a lock answer that arrives late, two requests
 *   in flight, the second click of a double click) the Pointer Lock API of the test page can be replaced by a
 *   scripted one whose answers the test controls (`lockMode`), and the timestamps requestAnimationFrame hands
 *   to the page by a virtual clock that only advances when told to (`clockFreeze` / `clockAdvance`), which
 *   makes simulation time exact: N frames of S ms are N·S ms of game time whatever the real frame rate.
 *   Both are injected with context.addInitScript into the TEST's browser context only; nothing of it is in
 *   the shipped page. With the scripted lock the pointer is not really captured: input still consists of
 *   real, trusted keyboard / mouse events, and there is no mouse-move flood and no emulated-lock echo.
 *
 * Typical script
 *   import { launch, openGame, sortie, holdKey, snap, Checks, urlFor } from './lib.mjs';
 *   const browser = await launch();
 *   const checks = new Checks('my-scenario');
 *   const game = await openGame(browser, { width: 960, height: 540 });
 *   await sortie(game.page, { legs: 'quadruped' });
 *   await holdKey(game.page, 'KeyW', 1.0);
 *   const s = await snap(game.page);
 *   checks.check('moved forward', s.player.position[2] < 90, s.player.position);
 *   checks.noPageErrors(game);
 *   await browser.close();
 *   process.exit(checks.finish());
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { launchBrowser } from '../browser.mjs';

// ───────────────────────────── configuration ─────────────────────────────
function argValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

/** Base URL of the game (always ends with '/'). */
export const BASE_URL = (() => {
  let u = argValue('url') || process.env.AK2_URL || 'http://127.0.0.1:5173/';
  if (!u.endsWith('/')) u += '/';
  return u;
})();

/** Directory for screenshots (`--shots=<dir>` or AK2_SHOTS; null = screenshots are skipped). */
export const SHOT_DIR = argValue('shots') || process.env.AK2_SHOTS || null;

/** Default wall-clock timeout (ms) for anything that waits on the page. Generous: software rendering. */
export const TIMEOUT = Number(argValue('timeout') || process.env.AK2_TIMEOUT || 180000);

/** URL of a page of the game: urlFor() = the shipped page, urlFor('dev/app-test.html', { seed: 5 }) … */
export function urlFor(pagePath = '', query = null) {
  let u = BASE_URL + pagePath.replace(/^\//, '');
  if (query && Object.keys(query).length > 0) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) q.set(k, String(v));
    u += (u.includes('?') ? '&' : '?') + q.toString();
  }
  return u;
}

export const HARNESS_PATH = 'dev/app-test.html';
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ───────────────────────────── browser / page ─────────────────────────────
/** Launches headless Chromium (SwiftShader WebGL). Close it with `browser.close()`. */
export function launch(extraArgs = []) {
  return launchBrowser(extraArgs);
}

/**
 * Opens a game page in its OWN browser context and waits until the garage is on screen.
 *
 * @param {import('playwright-core').Browser} browser
 * @param {object}   [o]
 * @param {string}   [o.path]        page path below the base URL ('' = shipped page, HARNESS_PATH = mini stage)
 * @param {object}   [o.query]       URL query, e.g. { seed: 123 }
 * @param {number}   [o.width]       viewport width  (default 960 — the UI scales down proportionally to 800×450)
 * @param {number}   [o.height]      viewport height (default 540)
 * @param {Function|string} [o.initScript]  test-side script injected before the page's own scripts
 *                                   (e.g. to make requestPointerLock fail). Never part of the shipped code.
 * @param {{lock?: boolean, clock?: boolean}} [o.scripted]  test-side scripted pointer lock and / or virtual
 *                                   frame clock (see "Scripted pointer lock + virtual frame clock" above)
 * @param {boolean}  [o.waitReady]   wait for the garage (default true); false returns right after `load`
 * @returns {Promise<{ page, context, errors: string[], warnings: string[], requests: string[], url: string, close(): Promise<void> }>}
 *   `errors` collects console errors, uncaught page errors and failed requests for the whole session,
 *   `requests` every URL the page asked for.
 */
export async function openGame(browser, o = {}) {
  const width = o.width ?? 960;
  const height = o.height ?? 540;
  const context = await browser.newContext({ viewport: { width, height } });
  if (o.scripted) await context.addInitScript(scriptedPageInit, { lock: !!o.scripted.lock, clock: !!o.scripted.clock });
  if (o.initScript) await context.addInitScript(o.initScript);
  const page = await context.newPage();
  const errors = [];
  const warnings = [];
  const requests = [];
  page.on('request', (r) => requests.push(r.url()));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console.error: ' + m.text());
    else if (m.type() === 'warning') warnings.push('console.warn: ' + m.text());
  });
  page.on('pageerror', (e) => errors.push('pageerror: ' + (e && e.message ? e.message : String(e))));
  page.on('requestfailed', (r) => {
    const reason = r.failure()?.errorText ?? '';
    // (requests cut off by a navigation of the test itself are not failures of the page)
    if (!reason.includes('ERR_ABORTED')) errors.push('requestfailed: ' + r.url() + ' ' + reason);
  });
  page.setDefaultTimeout(TIMEOUT);
  const url = urlFor(o.path ?? '', o.query ?? null);
  await page.goto(url, { waitUntil: 'load', timeout: TIMEOUT });
  const game = { page, context, errors, warnings, requests, url, close: () => context.close() };
  if (o.waitReady !== false) await waitReady(page);
  return game;
}

/** Waits until start-up has finished and the garage UI (the sortie button) is visible. */
export async function waitReady(page, timeout = TIMEOUT) {
  await page.waitForFunction(() => typeof window.__AK2__ === 'object' && typeof window.__AK2__.getSnapshot === 'function', null, { timeout });
  await page.locator('[data-act="sortie"]').waitFor({ state: 'visible', timeout });
}

// ───────────────────────────── snapshot ─────────────────────────────
/**
 * page.evaluate with a wall-clock limit: a page whose main thread is stuck (see "Why 'playing' is slow")
 * makes the script fail with a clear message instead of hanging forever.
 */
export function evaluate(page, fn, arg, timeout = TIMEOUT) {
  let timer;
  const limit = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`page did not answer within ${timeout} ms (main thread stuck?)`)), timeout);
  });
  return Promise.race([page.evaluate(fn, arg), limit]).finally(() => clearTimeout(timer));
}

/** The SPEC §10 snapshot (a plain JSON copy). */
export function snap(page) {
  return evaluate(page, () => window.__AK2__.getSnapshot());
}

/** Snapshot together with the page's own clock (ms) at the same instant. */
export function snapTimed(page) {
  return evaluate(page, () => ({ now: performance.now(), snapshot: window.__AK2__.getSnapshot() }));
}

/**
 * Polls the snapshot inside the page (once per animation frame) until `predicate(snapshot, arg)` is truthy
 * and returns that snapshot. `predicate` runs IN THE PAGE: it must be self-contained (use `arg` for data).
 */
export async function waitForSnapshot(page, predicate, arg = null, { timeout = TIMEOUT, label = 'condition' } = {}) {
  const fn = `(arg) => { const s = window.__AK2__.getSnapshot(); return (${predicate.toString()})(s, arg) ? s : false; }`;
  try {
    const handle = await page.waitForFunction(new Function('return ' + fn)(), arg, { timeout, polling: 'raf' });
    return await handle.jsonValue();
  } catch (err) {
    let last = null;
    try {
      last = await snap(page);
    } catch {
      /* page gone */
    }
    const where = last ? ` (state=${last.state}, t=${last.elapsedSeconds.toFixed(3)}, hp=${last.player.hp})` : '';
    throw new Error(`waitForSnapshot: "${label}" not reached within ${timeout} ms${where}: ${err.message.split('\n')[0]}`);
  }
}

/** Waits until the app state equals `state` (or is one of `state` when an array is given). */
export function waitForState(page, state, opts = {}) {
  const states = Array.isArray(state) ? state : [state];
  return waitForSnapshot(page, (s, wanted) => wanted.includes(s.state), states, { label: 'state ' + states.join('|'), ...opts });
}

/**
 * Waits until `seconds` of SIMULATION time have passed (snapshot.elapsedSeconds) and returns the snapshot.
 * Stops early (returning the snapshot) if the game leaves 'playing' — check `.state` when that matters.
 */
export async function waitSimSeconds(page, seconds, opts = {}) {
  const start = (await snap(page)).elapsedSeconds;
  return waitForSnapshot(page, (s, target) => s.elapsedSeconds >= target - 1e-9 || s.state !== 'playing', start + seconds, {
    label: `sim +${seconds}s`,
    ...opts,
  });
}

/** Waits until the simulation clock reaches the absolute time `t` (or the game leaves 'playing'). */
export function waitSimTime(page, t, opts = {}) {
  return waitForSnapshot(page, (s, target) => s.elapsedSeconds >= target - 1e-9 || s.state !== 'playing', t, { label: `sim t>=${t}`, ...opts });
}

/** Waits for `n` rendered animation frames of the page. */
export function waitFrames(page, n = 2) {
  return evaluate(
    page,
    (count) =>
      new Promise((resolve) => {
        let left = count;
        const step = () => (--left <= 0 ? resolve(true) : requestAnimationFrame(step));
        requestAnimationFrame(step);
      }),
    n,
  );
}

/**
 * Test-side frame recorder (injected with page.evaluate; nothing in the shipped page): records, once per
 * animation frame, the frame timestamp (ms, the value requestAnimationFrame hands to its callbacks), the app
 * state and snapshot.elapsedSeconds. Start it, do something, then read it with stopFrameTrace().
 */
export function startFrameTrace(page, maxFrames = 4000) {
  return evaluate(page, (max) => {
    const trace = { frames: [], on: true };
    window.__e2eFrameTrace = trace;
    const step = (ts) => {
      if (!trace.on) return;
      const s = window.__AK2__.getSnapshot();
      trace.frames.push([ts, s.state, s.elapsedSeconds]);
      if (trace.frames.length < max) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, maxFrames);
}

/** Stops the recorder and returns [{ ts, state, t }] (ts in ms, t = elapsedSeconds). */
export async function stopFrameTrace(page) {
  const frames = await evaluate(page, () => {
    const trace = window.__e2eFrameTrace;
    if (!trace) return [];
    trace.on = false;
    delete window.__e2eFrameTrace;
    return trace.frames;
  });
  return frames.map(([ts, state, t]) => ({ ts, state, t }));
}

/**
 * Largest amount (s) by which the simulation clock ran AHEAD of real time between two consecutive recorded
 * frames: max over frames of Δt_sim − max(Δt_frame, previous Δt_frame). With one frame loop that feeds real
 * frame times it never exceeds one tick (1/120 s); a duplicated loop or a time jump after a pause shows up
 * as a larger value. (Frames longer than 0.25 s are capped by the simulation and cannot exceed either.)
 */
export function maxSimLead(frames) {
  let worst = -Infinity;
  for (let i = 2; i < frames.length; i++) {
    const dSim = frames[i].t - frames[i - 1].t;
    const d1 = (frames[i].ts - frames[i - 1].ts) / 1000;
    const d0 = (frames[i - 1].ts - frames[i - 2].ts) / 1000;
    if (dSim < 0) continue; // a re-sortie reset the clock
    worst = Math.max(worst, dSim - Math.max(d1, d0));
  }
  return worst;
}

/**
 * Looks at every pause → resume transition in a frame trace: `before` is the simulation time of the last
 * 'paused' frame, `first` that of the first 'playing' frame after it. The first rendered frame after a
 * resume must feed 0 s to the simulation, i.e. `first === before` exactly — time spent paused must not leak
 * into the simulation (it would show up as up to +0.25 s here; later frames cannot tell, because a normal
 * slow frame advances the simulation by 0.25 s as well).
 */
export function resumeSteps(frames) {
  const steps = [];
  for (let i = 1; i < frames.length; i++) {
    if (frames[i].state === 'playing' && frames[i - 1].state === 'paused') steps.push({ before: frames[i - 1].t, first: frames[i].t, added: frames[i].t - frames[i - 1].t });
  }
  return steps;
}

// ───────────────────────────── scripted pointer lock + virtual frame clock (test-side) ─────────────────────────────
/**
 * Runs IN THE PAGE before its own scripts (context.addInitScript). Test-side only.
 *   window.__e2e.lock   scripted Pointer Lock API: { mode: 'ok' | 'reject' | 'never', delay (ms), calls, exits,
 *                       log: ["<ms> <event> [<app state>]"], set(elementOrNull) }
 *   window.__e2e.clock  virtual requestAnimationFrame timestamps: { now, step (ms per rendered frame),
 *                       budget (frames left to advance; Infinity = free running), frames (real frames seen) }
 */
function scriptedPageInit(opts) {
  const E = (window.__e2e = { lock: null, clock: null });
  const appState = () => {
    try {
      return window.__AK2__ ? window.__AK2__.getSnapshot().state : '?';
    } catch {
      return '?';
    }
  };

  if (opts.clock) {
    const clock = (E.clock = { now: 1000, step: 1000 / 60, budget: Infinity, frames: 0, lastReal: -1 });
    const realRaf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) =>
      realRaf((ts) => {
        if (ts !== clock.lastReal) {
          // first callback of a new rendered frame: this is where virtual time moves
          clock.lastReal = ts;
          clock.frames++;
          if (clock.budget > 0) {
            clock.now += clock.step;
            clock.budget--;
          }
        }
        cb(clock.now);
      });
  }

  if (opts.lock) {
    let element = null;
    const lock = (E.lock = { mode: 'ok', delay: 0, calls: 0, exits: 0, log: [] });
    const note = (text) => lock.log.push(Math.round(performance.now()) + ' ' + text + ' [' + appState() + ']');
    lock.set = (next) => {
      if (element === next) return;
      element = next;
      note(next ? 'LOCKED' : 'released');
      document.dispatchEvent(new Event('pointerlockchange'));
    };
    Object.defineProperty(Document.prototype, 'pointerLockElement', { configurable: true, get: () => element });
    Element.prototype.requestPointerLock = function () {
      const target = this;
      const { mode, delay } = lock;
      lock.calls++;
      note('request(' + mode + ',' + delay + ')');
      return new Promise((resolve, reject) => {
        if (mode === 'never') return;
        setTimeout(() => {
          if (mode === 'reject') {
            note('refused');
            document.dispatchEvent(new Event('pointerlockerror'));
            reject(new DOMException('refused by the test', 'NotAllowedError'));
          } else {
            lock.set(target);
            resolve();
          }
        }, delay);
      });
    };
    Document.prototype.exitPointerLock = function () {
      lock.exits++;
      note('exitPointerLock');
      setTimeout(() => lock.set(null), 0); // like the real API: reported asynchronously
    };
  }
}

/** Scripted lock: how the NEXT requestPointerLock calls are answered ('ok' | 'reject' | 'never', after `delayMs`). */
export function lockMode(page, mode, delayMs = 0) {
  return evaluate(page, ([m, d]) => Object.assign(window.__e2e.lock, { mode: m, delay: d }) && true, [mode, delayMs]);
}

/** Scripted lock: { locked, calls, exits, log } (log = timeline of requests / answers / releases with the app state). */
export function lockInfo(page) {
  return evaluate(page, () => ({ locked: document.pointerLockElement !== null, calls: window.__e2e.lock.calls, exits: window.__e2e.lock.exits, log: window.__e2e.lock.log.slice() }));
}

/** Scripted lock: the browser takes the lock away (what Esc does in a real browser). */
export function lockLose(page) {
  return evaluate(page, () => window.__e2e.lock.set(null));
}

/** Waits for `n` REAL rendered frames (virtual time moves only if the clock has a budget). */
export async function realFrames(page, n = 2) {
  const start = await evaluate(page, () => window.__e2e.clock.frames);
  await page.waitForFunction(([s, k]) => window.__e2e.clock.frames >= s + k, [start, n], { polling: 20, timeout: TIMEOUT });
}

/** Virtual clock: stop it (frames keep rendering with a frame time of 0) and let the stop take effect. */
export async function clockFreeze(page) {
  await evaluate(page, () => {
    window.__e2e.clock.budget = 0;
  });
  await realFrames(page, 2);
}

/** Virtual clock: run exactly `frames` rendered frames of `stepMs` each, then stop again. */
export async function clockAdvance(page, frames, stepMs) {
  await evaluate(
    page,
    ([n, s]) => {
      window.__e2e.clock.step = s;
      window.__e2e.clock.budget = n;
    },
    [frames, stepMs],
  );
  await page.waitForFunction(() => window.__e2e.clock.budget === 0, null, { polling: 20, timeout: TIMEOUT });
  await realFrames(page, 2); // the frame that used up the budget has been simulated and drawn
}

/** Virtual clock: free running with `stepMs` per rendered frame. */
export function clockRun(page, stepMs = 1000 / 60) {
  return evaluate(
    page,
    (s) => {
      window.__e2e.clock.step = s;
      window.__e2e.clock.budget = Infinity;
    },
    stepMs,
  );
}

// ───────────────────────────── pointer bookkeeping ─────────────────────────────
/** Last position of the injected pointer per page (needed for relative moves under the emulated lock). */
const pointers = new WeakMap();

function pointerOf(page) {
  let p = pointers.get(page);
  if (!p) {
    const vp = page.viewportSize() ?? { width: 960, height: 540 };
    p = { x: Math.round(vp.width / 2), y: Math.round(vp.height / 2) };
    pointers.set(page, p);
  }
  return p;
}

/** Moves the injected pointer to an absolute viewport position (real mouse events). */
export async function pointerTo(page, x, y, steps = 1) {
  await page.mouse.move(x, y, { steps });
  pointers.set(page, { x, y });
}

/**
 * Test-side counter of the real (trusted) mouse-move events with non-zero movement that reached the page.
 * Installed on demand with page.evaluate (it is gone after a reload); nothing of it is in the shipped page.
 */
function pointerProbe(page) {
  return evaluate(page, () => {
    let p = window.__e2ePointer;
    if (!p) {
      p = window.__e2ePointer = { moves: 0, last: null };
      window.addEventListener(
        'mousemove',
        (e) => {
          if (!e.isTrusted || (e.movementX === 0 && e.movementY === 0)) return;
          p.moves++;
          p.last = [e.movementX, e.movementY];
        },
        true,
      );
    }
    return { moves: p.moves, last: p.last, locked: document.pointerLockElement !== null };
  });
}

/** Waits (bounded) until `count` non-zero mouse moves have reached the page; returns false on timeout. */
function waitPointerMoves(page, count, timeout = 15000) {
  return page.waitForFunction((n) => window.__e2ePointer && window.__e2ePointer.moves >= n, count, { timeout, polling: 30 }).then(
    () => true,
    () => false,
  );
}

/**
 * After a click that acquired the pointer lock at `hit`: waits for the echo of that click and then presses
 * and releases the right mouse button (no function in the game), whose echoes let the game's input layer
 * finish recognising the emulated lock. See "Mouse under pointer lock" at the top of this file.
 */
async function settlePointerLock(page, hit) {
  // (a scripted lock does not capture the pointer: no echo to wait for)
  if (await evaluate(page, () => !!(window.__e2e && window.__e2e.lock))) return;
  const echo = [-Math.floor(hit.x), -Math.floor(hit.y)];
  await page
    .waitForFunction(([x, y]) => window.__e2ePointer && window.__e2ePointer.last && window.__e2ePointer.last[0] === x && window.__e2ePointer.last[1] === y, echo, { timeout: 15000, polling: 30 })
    .catch(() => {});
  const before = await pointerProbe(page);
  if (!before.locked) return;
  await page.mouse.down({ button: 'right' });
  await waitPointerMoves(page, before.moves + 1);
  await page.mouse.up({ button: 'right' });
  await waitPointerMoves(page, before.moves + 2);
}

/**
 * Real click (trusted mouse move / down / up) on the centre of the first element matching `selector`.
 * Waits until the element is visible, scrolls it into view, and refuses to click when it is disabled or
 * covered by something else. Remembers where the pointer ended up and returns that point.
 */
export async function click(page, selector, { timeout = TIMEOUT } = {}) {
  const loc = page.locator(selector).first();
  await loc.waitFor({ state: 'visible', timeout });
  const hit = await loc.evaluate((element) => {
    element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const r = element.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const top = document.elementFromPoint(x, y);
    return {
      x,
      y,
      ok: !!top && (top === element || element.contains(top)),
      disabled: element.disabled === true,
      top: top ? top.tagName.toLowerCase() + (top.className ? '.' + String(top.className).split(' ')[0] : '') : null,
    };
  });
  if (!hit.ok || hit.disabled) throw new Error(`click: "${selector}" is ${hit.disabled ? 'disabled' : 'covered by ' + hit.top}`);
  await page.mouse.move(hit.x, hit.y);
  await page.mouse.down();
  await page.mouse.up();
  const point = { x: hit.x, y: hit.y };
  pointers.set(page, point);
  return point;
}

/** Clicks a UI button by its `data-act` (sortie, help, help-close, resume, restart, garage). */
export function clickAct(page, act, opts) {
  return click(page, `[data-act="${act}"]`, opts);
}

/** True if a button with this `data-act` is currently on screen. */
export function actVisible(page, act) {
  return page.locator(`[data-act="${act}"]`).first().isVisible();
}

// ───────────────────────────── garage / sortie ─────────────────────────────
/** Selects parts in the garage: any of { fcs, generator, legs } (ids of SPEC §10). */
export async function selectLoadout(page, loadout = {}) {
  for (const group of ['fcs', 'generator', 'legs']) {
    const id = loadout[group];
    if (id) await click(page, `button[data-group="${group}"][data-id="${id}"]`);
  }
  return snap(page);
}

/** Clicks a button that starts / continues the game and waits for 'playing' with a settled pointer lock. */
async function clickIntoGame(page, act, opts = {}) {
  await pointerProbe(page);
  const hit = await clickAct(page, act);
  const first = await waitForState(page, 'playing', opts);
  await settlePointerLock(page, hit);
  return first;
}

/**
 * Garage → playing: optionally selects a loadout, clicks "出撃" (a real click, which also acquires the
 * pointer lock) and waits for state 'playing'. Returns the FIRST snapshot seen in 'playing' (the helper
 * itself returns a little later, see settlePointerLock).
 */
export async function sortie(page, loadout = null, opts = {}) {
  if (loadout) await selectLoadout(page, loadout);
  return clickIntoGame(page, 'sortie', opts);
}

/** Pause menu (or the retry button of the pointer-lock error panel) → playing ("再開" / "再試行"). */
export function resume(page, opts = {}) {
  return clickIntoGame(page, 'resume', opts);
}

/** Pause menu / result screen → playing with a fresh sortie ("同じ構成で再出撃"). */
export function restart(page, opts = {}) {
  return clickIntoGame(page, 'restart', opts);
}

/** Pause menu / result screen → garage ("格納庫へ戻る"). */
export async function toGarage(page, opts = {}) {
  await clickAct(page, 'garage');
  const s = await waitForState(page, 'garage', opts);
  await page.locator('[data-act="sortie"]').waitFor({ state: 'visible', timeout: opts.timeout ?? TIMEOUT });
  return s;
}

/**
 * playing → paused through one of the four triggers of SPEC §9.
 *   'pointerlock'  document.exitPointerLock() — the same pointerlockchange a real Esc produces
 *   'escape'       a real Escape key press (headless delivers the keydown; a real browser consumes it and
 *                  reports the lock loss instead)
 *   'blur'         a script-dispatched `blur` event on window (simulated: headless windows have no focus changes)
 *   'visibility'   document.visibilityState overridden to 'hidden' on this document + a script-dispatched
 *                  `visibilitychange` (simulated); the override is removed again right afterwards
 */
export async function pauseBy(page, how = 'pointerlock', opts = {}) {
  if (how === 'pointerlock') await evaluate(page, () => document.exitPointerLock());
  else if (how === 'escape') await page.keyboard.press('Escape');
  else if (how === 'blur') await evaluate(page, () => window.dispatchEvent(new Event('blur')));
  else if (how === 'visibility') {
    await evaluate(page, () => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
      delete document.visibilityState;
      delete document.hidden;
      document.dispatchEvent(new Event('visibilitychange'));
    });
  } else throw new Error('pauseBy: unknown trigger ' + how);
  return waitForState(page, 'paused', opts);
}

// ───────────────────────────── keyboard ─────────────────────────────
/** Key codes are KeyboardEvent.code values: 'KeyW', 'KeyQ', 'Space', 'ShiftLeft', 'ControlLeft', 'Digit1' … */
export function keyDown(page, code) {
  return page.keyboard.down(code);
}
export function keyUp(page, code) {
  return page.keyboard.up(code);
}

/** Short press and release (wall-clock hold; edges are latched by the game until its next frame). */
export async function tapKey(page, code, holdMs = 60) {
  await page.keyboard.down(code);
  await sleep(holdMs);
  await page.keyboard.up(code);
}

/** Holds one key (or several: pass an array) for `simSeconds` of simulation time. Returns the snapshot at release. */
export async function holdKey(page, code, simSeconds, opts = {}) {
  const codes = Array.isArray(code) ? code : [code];
  for (const c of codes) await page.keyboard.down(c);
  try {
    return await waitSimSeconds(page, simSeconds, opts);
  } finally {
    for (const c of codes.reverse()) await page.keyboard.up(c);
  }
}

/** Sends `n` extra keydown events for a key that is already down (OS auto-repeat: `repeat: true`). */
export async function autoRepeat(page, code, n = 5, gapMs = 40) {
  for (let i = 0; i < n; i++) {
    await page.keyboard.down(code);
    await sleep(gapMs);
  }
}

// ───────────────────────────── mouse ─────────────────────────────
/**
 * Turns the view with REAL mouse movement: moves the injected pointer by (dx, dy) CSS px from its last
 * position (dx > 0 turns right, dy > 0 looks down; 0.0022 rad per px) and waits until the game has seen it.
 * Use whole pixels. Throws if the pointer would leave the viewport — see the note at the top of this file.
 */
export async function lookBy(page, dx, dy) {
  const p = pointerOf(page);
  const vp = page.viewportSize() ?? { width: 960, height: 540 };
  const x = p.x + dx;
  const y = p.y + dy;
  if (x < 1 || y < 1 || x > vp.width - 1 || y > vp.height - 1) {
    throw new Error(`lookBy: pointer would leave the viewport (${x}, ${y}); use smaller moves or syntheticLook()`);
  }
  const before = await pointerProbe(page);
  await pointerTo(page, x, y, 1);
  if (before.locked) await waitPointerMoves(page, before.moves + 2); // the jump and its echo
  await waitFrames(page, 2);
}

/** Turns the view with script-dispatched mousemove events (NOT trusted input; unlimited range). */
export async function syntheticLook(page, dx, dy, steps = 4) {
  await evaluate(
    page,
    ([mx, my, n]) => {
      const c = document.querySelector('canvas');
      for (let i = 0; i < n; i++) c.dispatchEvent(new MouseEvent('mousemove', { movementX: mx / n, movementY: my / n, bubbles: true }));
    },
    [dx, dy, steps],
  );
}

/** Left mouse button down / up at the current pointer position (real mouse events). */
export function mouseDown(page) {
  return page.mouse.down();
}
export function mouseUp(page) {
  return page.mouse.up();
}

/** Holds the fire button for `simSeconds` of simulation time. Returns the snapshot at release. */
export async function fireFor(page, simSeconds, opts = {}) {
  await page.mouse.down();
  try {
    return await waitSimSeconds(page, simSeconds, opts);
  } finally {
    await page.mouse.up();
  }
}

// ───────────────────────────── page measurements (no hooks: DOM + CDP only) ─────────────────────────────
/** Size / position facts about the display: window, canvas element, drawing buffer, HUD lock ring. */
export function measureDisplay(page) {
  return evaluate(page, () => {
    const canvas = document.querySelector('canvas');
    const cr = canvas.getBoundingClientRect();
    const hud = document.querySelector('.ak2-hud');
    const ring = document.querySelector('.hud-lock-ring');
    let ringInfo = null;
    if (hud && ring && getComputedStyle(hud).display !== 'none') {
      const box = ring.getBBox();
      const ctm = ring.getScreenCTM();
      ringInfo = {
        // centre line of the stroke, in CSS px on screen
        radiusX: (box.width * ctm.a) / 2,
        radiusY: (box.height * ctm.d) / 2,
        centreX: ctm.e + (box.x + box.width / 2) * ctm.a,
        centreY: ctm.f + (box.y + box.height / 2) * ctm.d,
      };
    }
    const de = document.documentElement;
    return {
      window: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
      canvasRect: { x: cr.left, y: cr.top, width: cr.width, height: cr.height },
      canvasBuffer: { width: canvas.width, height: canvas.height },
      hudVisible: !!hud && getComputedStyle(hud).display !== 'none',
      hudRect: hud ? (({ left, top, width, height }) => ({ x: left, y: top, width, height }))(hud.getBoundingClientRect()) : null,
      ring: ringInfo,
      scrollable: de.scrollWidth > de.clientWidth || de.scrollHeight > de.clientHeight,
    };
  });
}

/**
 * Leak indicators that need no hook in the page: DOM node / canvas counts, the number of JS event listeners
 * and the JS heap after a forced garbage collection (Chrome DevTools Protocol).
 */
export async function resourceCounts(page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('HeapProfiler.enable');
    await cdp.send('HeapProfiler.collectGarbage');
    await cdp.send('HeapProfiler.collectGarbage');
    const counters = await cdp.send('Memory.getDOMCounters');
    const heap = await cdp.send('Runtime.getHeapUsage');
    const dom = await evaluate(page, () => ({
      elements: document.getElementsByTagName('*').length,
      canvases: document.querySelectorAll('canvas').length,
      styleSheets: document.styleSheets.length,
    }));
    return {
      ...dom,
      // nodes / listeners of the whole renderer process as counted by the browser (includes detached nodes)
      domNodes: counters.nodes,
      jsEventListeners: counters.jsEventListeners,
      documents: counters.documents,
      heapUsedMB: Math.round((heap.usedSize / 1048576) * 10) / 10,
    };
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/** PNG screenshot through CDP (works while the game keeps rendering). Skipped (returns null) without SHOT_DIR. */
export async function screenshot(page, name, { dir = SHOT_DIR, timeout = TIMEOUT } = {}) {
  if (!dir) return null;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name.endsWith('.png') ? name : name + '.png');
  await page.screenshot({ path: file, timeout });
  return file;
}

// ───────────────────────────── pixels (screenshots decoded in Node; no hook in the page) ─────────────────────────────
/**
 * Decodes a PNG as produced by page.screenshot() (8 bit per channel, RGB or RGBA, not interlaced).
 * @returns {{ width: number, height: number, channels: number, data: Uint8Array }} rows top to bottom
 */
export function decodePng(buffer) {
  const buf = Buffer.from(buffer);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('decodePng: not a PNG');
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat = [];
  for (let off = 8; off < buf.length; ) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const colourType = body[9];
      if (body[8] !== 8 || (colourType !== 2 && colourType !== 6) || body[12] !== 0) throw new Error('decodePng: unsupported PNG format');
      channels = colourType === 6 ? 4 : 3;
    } else if (type === 'IDAT') idat.push(body);
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const data = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? data[dst + i - channels] : 0;
      const b = y > 0 ? data[dst + i - stride] : 0;
      const c = y > 0 && i >= channels ? data[dst + i - stride - channels] : 0;
      let predicted = 0;
      if (filter === 1) predicted = a;
      else if (filter === 2) predicted = b;
      else if (filter === 3) predicted = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        predicted = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      data[dst + i] = (raw[src + i] + predicted) & 255;
    }
  }
  return { width, height, channels, data };
}

/** Screenshot of the page as decoded pixels (also written to SHOT_DIR/<name>.png when a name and a directory are given). */
export async function capture(page, name = null) {
  const png = await page.screenshot({ timeout: TIMEOUT });
  if (name && SHOT_DIR) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    fs.writeFileSync(path.join(SHOT_DIR, name.endsWith('.png') ? name : name + '.png'), png);
  }
  return decodePng(png);
}

/**
 * Number of pixels inside `rect` ({ x, y, width, height }, image pixels) whose colour differs between the two
 * images by more than `threshold` (sum of |ΔR| + |ΔG| + |ΔB|).
 * `slack` > 0 makes the comparison tolerant of small shifts: a pixel only counts when NO pixel of the other
 * image within `slack` pixels of it has a similar colour (checked in both directions). An idle animation
 * that moves outlines by a pixel or two then counts as (almost) nothing, while something that is in one
 * picture only — a flame, a different pose — still counts in full.
 */
export function countDifferentPixels(a, b, rect, threshold = 90, slack = 0) {
  if (a.width !== b.width || a.height !== b.height) throw new Error('countDifferentPixels: image sizes differ');
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(a.width, Math.ceil(rect.x + rect.width));
  const y1 = Math.min(a.height, Math.ceil(rect.y + rect.height));
  const diff = (p, q, x, y, u, v) => {
    const i = (y * p.width + x) * p.channels;
    const j = (v * q.width + u) * q.channels;
    return Math.abs(p.data[i] - q.data[j]) + Math.abs(p.data[i + 1] - q.data[j + 1]) + Math.abs(p.data[i + 2] - q.data[j + 2]);
  };
  /** true if pixel (x, y) of p has no similar pixel in q within `slack`. */
  const alone = (p, q, x, y) => {
    for (let v = Math.max(0, y - slack); v <= Math.min(q.height - 1, y + slack); v++) {
      for (let u = Math.max(0, x - slack); u <= Math.min(q.width - 1, x + slack); u++) {
        if (diff(p, q, x, y, u, v) <= threshold) return false;
      }
    }
    return true;
  };
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (diff(a, b, x, y, x, y) <= threshold) continue;
      if (slack === 0 || alone(a, b, x, y) || alone(b, a, x, y)) n++;
    }
  }
  return n;
}

// ───────────────────────────── assertions / report ─────────────────────────────
export const near = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;
export const vecNear = (a, b, tol) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => near(v, b[i], tol));
export const yawOfDir = (dx, dz) => Math.atan2(-dx, -dz); // camera/body yaw whose horizontal forward is (dx, dz)

/** Collects named checks, prints PASS / FAIL lines as they come and a summary at the end. */
export class Checks {
  constructor(title) {
    this.title = title;
    this.results = [];
    this.notes = [];
    console.log(`\n=== ${title} — ${BASE_URL} ===`);
  }

  /** Records one check. `detail` (any JSON-able value: the measured numbers) is printed next to it. */
  check(name, ok, detail) {
    const pass = !!ok;
    this.results.push({ name, ok: pass, detail });
    console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (detail !== undefined ? '   ' + compact(detail) : ''));
    return pass;
  }

  /** A measured value or a remark that is not a pass/fail criterion. */
  note(text, detail) {
    this.notes.push({ text, detail });
    console.log('NOTE  ' + text + (detail !== undefined ? '   ' + compact(detail) : ''));
  }

  /** Fails if the session produced console errors, uncaught exceptions or failed requests. */
  noPageErrors(game, label = 'no console errors / uncaught exceptions') {
    return this.check(label, game.errors.length === 0, game.errors.slice(0, 5));
  }

  /** Runs one scenario section; an exception inside becomes a failed check instead of aborting the script. */
  async section(name, fn) {
    console.log(`--- ${name}`);
    try {
      await fn();
    } catch (err) {
      this.check(`${name}: completed without exception`, false, String(err && err.message ? err.message : err).split('\n')[0]);
    }
  }

  get failed() {
    return this.results.filter((r) => !r.ok).length;
  }
  get passed() {
    return this.results.filter((r) => r.ok).length;
  }

  /** Prints the summary and returns the process exit code (0 = everything passed). */
  finish() {
    console.log(`\n=== ${this.title}: ${this.passed} passed, ${this.failed} failed (${this.results.length} checks) ===`);
    for (const r of this.results) if (!r.ok) console.log('  FAILED: ' + r.name + (r.detail !== undefined ? '   ' + compact(r.detail) : ''));
    return this.failed === 0 ? 0 : 1;
  }
}

function compact(value) {
  let text;
  try {
    text = JSON.stringify(value, (_k, v) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1e4) / 1e4 : v));
  } catch {
    text = String(value);
  }
  if (text === undefined) text = String(value);
  return text.length > 600 ? text.slice(0, 600) + '…' : text;
}
