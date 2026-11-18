#!/usr/bin/env node
/**
 * Browser-side verification record for docs/SPEC.md §11 ("完了前の確認"): every item is driven through the
 * built page with real keyboard / mouse input and observed only through window.__AK2__.getSnapshot(), the
 * DOM and screenshots. For each item the script prints the input sequence, the simulation times, positions
 * and EN values it measured, the value the SPEC text predicts for exactly that input, and PASS / FAIL.
 *
 *   node tools/e2e/serve.mjs --port=5230 &
 *   AK2_URL=http://127.0.0.1:5230/ node tools/e2e/spec-verify.mjs --only=<group> --out=<dir>
 *   node tools/e2e/spec-verify.mjs --merge --out=<dir>          # rows-*.json → results.json
 *
 * Section groups (run ONE group per process; each opens its own pages, one browser at a time):
 *   S    S1  stage facts of the shipped page (19 sectors, 45 enemies …) + L1 garage: all 18 builds
 *   M1   single press: Q held 5 s with auto-repeat (shipped page, the browser's own pointer lock, real clock)
 *   M2q  release: quadruped Q tap, per-tick impulse, 3 s of key-less glide (shipped page, start dock)
 *   M3   0.75 s distance + walk / glide speed + flight EN rate + regeneration slope at 30 / 60 / 120 / 144 Hz
 *        virtual frames, biped and quadruped (shipped page, start dock)   [--legs=biped|quadruped --hz=30,60]
 *   M4   glide switched on at EN 0, regeneration 0.75 s after the last spend while gliding (shipped page)
 *   M5   EN boundary 35 / 36 for the quick boost (shipped page)
 *   M6   simultaneous QB + beam + flight ledger, glide free (shipped page)
 *   FC   mini stage: F4 lock times (6 builds) + L1 values in play [part 1]; F1 machine gun vs a turret, F2 beam
 *        and missile, F3 firing while gliding / flying / boosting, six control turrets, M2 biped, gate → exit →
 *        cleared, re-sortie = first sortie [part 2]; lock loss, weapon switch [part 3]      [--fc=1,2,3]
 *   PM   mini stage: fall → failed, yard fight (moving guards, missile lead, hits from outside the view),
 *        HP 0 → failed, re-sortie resets
 *   EP   shipped page: E1 enemy attack timing of guard G01 (out of view, lost line of sight, pursuit) and F1
 *        machine gun vs the moving guards it calls [part 1]; a fresh sortie through the checkpoint corridor to
 *        control turret T01 → barrier B1, HUD 1/6, turret timing [part 2]                    [--ep=1,2]
 *   U1   pause by Esc / pointer-lock loss / blur / hidden tab, resume, held Q, resume click; lock failure
 *   R1   resize while playing and paused; lock circle in the snapshot, in the DOM and in the pixels
 *
 * Viewports: 800×450 (`--size=`) for the garage, the menus and most sections; 320×180 (`--small=`) while the
 * many-frame runs of M3 play (software rendering; the simulation does not depend on the size); 1280×720 and
 * 1920×1080 in R1 and for the screenshots (`<out>/shots/`).
 *
 * Which pointer lock / clock a section uses is stated in every row (`where`):
 *   browser-real-lock      headless Chromium's own (emulated) Pointer Lock, real frame times
 *   browser-scripted-lock  test-side scripted Pointer Lock API + virtual frame clock of lib.mjs (injected with
 *                          addInitScript into the test's browser context; nothing of it is in the page).
 *                          Simulation time is then exact: a frame of k ticks is k / 120 s of game time.
 * Input is always real, trusted keyboard / mouse input. Nothing here reads src/: the expected values are the
 * numbers of docs/SPEC.md written out below (the muzzle offset alone is a design constant of src/config.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import * as L from './lib.mjs';

// ───────────────────────────── arguments ─────────────────────────────
const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const flag = (name) => process.argv.includes(`--${name}`);
const OUT = arg('out') || process.env.AK2_VERIFY_OUT || null;
const ONLY = arg('only') ? arg('only').split(',').map((s) => s.trim()) : null;
const want = (id) => !ONLY || ONLY.includes(id);
const [GW, GH] = (arg('size') || '800x450').split('x').map(Number); // viewport for the garage, the menus and most sections
const [SW, SH] = (arg('small') || '320x180').split('x').map(Number); // viewport while the many-frame runs play (M3): rendering only

// ───────────────────────────── numbers of docs/SPEC.md (written out; independent of src/config.ts) ─────────────────────────────
const TICK = 1 / 120;
const TICK_MS = 1000 / 120;
const SPEC = {
  walk: 10, glide: 22, air: 16, qb: 80, qbImpulse: 0.15, qbDecel: 0.6, qbCost: 36, qbCooldown: 1.0,
  walkAccel: 120, jump: 10, flyClimb: 8, flyEn: 20, flyHold: 0.2, regenDelay: 0.75, gravity: 18,
  mg: { dmg: 12, interval: 0.1, ammo: 300, speed: 100, life: 2 },
  beam: { dmg: 40, interval: 0.25, en: 8, range: 120 },
  missile: { dmg: 180, interval: 1.0, ammo: 12, speed: 45, life: 4, turnDeg: 120 },
  guard: { hp: 120, range: 90, first: 0.5, dmg: 18, speed: 70, burst: 3, gap: 0.12, period: 1.2, tele: 0.15 },
  turret: { hp: 240, range: 120, first: 0.7, dmg: 40, speed: 60, burst: 2, gap: 0.25, period: 1.6, tele: 0.35 },
  aiDelay: 0.05, memory: 8, reacquire: 0.5, fcsRange: 120,
};
const GEN = { capacity: [180, 10], balanced: [120, 15], recovery: [90, 20] };
const FCS = { wide: [0.3, 1.2], medium: [0.2, 0.8], narrow: [0.1, 0.4] };
const LEGS = { biped: [1.0, 1.0, 1.0], quadruped: [0.8, 0.75, 1.5] }; // speed, regen, lock speed
const SENS = 0.0022; // rad per CSS px (README §3; not a SPEC number)
const MUZZLE = { right: 0.9, up: 0.75, forward: 0.85 }; // src/config.ts PLAYER.muzzleLocal (design constant)
const expectedStats = (l) => ({
  maxEn: GEN[l.generator][0],
  regenPerSecond: GEN[l.generator][1] * LEGS[l.legs][1],
  lockSeconds: FCS[l.fcs][1] / LEGS[l.legs][2],
  horizontalSpeedMultiplier: LEGS[l.legs][0],
});
/** Flat-ground quick boost of SPEC §7.2 with no input after the press: speed and distance τ seconds after the start. */
function qbModel(tau, m, steady = SPEC.glide) {
  const v0 = SPEC.qb * m;
  const v1 = steady * m;
  const a = (v0 - v1) / SPEC.qbDecel;
  if (tau <= SPEC.qbImpulse) return { v: v0, x: v0 * tau };
  const u = Math.min(tau, SPEC.qbImpulse + SPEC.qbDecel) - SPEC.qbImpulse;
  const x1 = v0 * SPEC.qbImpulse + v0 * u - 0.5 * a * u * u;
  if (tau <= SPEC.qbImpulse + SPEC.qbDecel) return { v: v0 - a * u, x: x1 };
  return { v: v1, x: x1 + v1 * (tau - SPEC.qbImpulse - SPEC.qbDecel) };
}

// ───────────────────────────── vectors + my own fire-control solvers (SPEC §4.3 / §4.4) ─────────────────────────────
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => mul(a, 1 / len(a));
const angleBetween = (a, b) => Math.atan2(len(cross(a, b)), dot(a, b));
const hdist = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);
const speedH = (s) => Math.hypot(s.player.velocity[0], s.player.velocity[2]);
const r6 = (v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v);
const r3 = (v) => (typeof v === 'number' ? Math.round(v * 1e3) / 1e3 : v);
const v3s = (v, d = 3) => (v ? '(' + v.map((x) => x.toFixed(d)).join(', ') + ')' : 'null');

/**
 * Machine gun, SPEC §4.3: smallest t in (0, 2] with |r + v t − ½ g t²|² − s² t² = 0, g = (0, −18, 0), s = 100.
 * Own implementation: the quartic is scanned on a fine grid for the first sign change or the first minimum that
 * touches zero, then refined by bisection (sign change) or golden section (tangent root).
 */
function solveMachineGun(m, p, v) {
  const s = SPEC.mg.speed;
  const r = sub(p, m);
  const a = [0, 0.5 * SPEC.gravity, 0]; // −½ g
  const w = (t) => add(add(r, mul(v, t)), mul(a, t * t));
  const f = (t) => dot(w(t), w(t)) - s * s * t * t;
  const N = 20000;
  let t = null;
  let prev = f(0);
  if (prev <= 0) return null; // muzzle inside the target centre: not a case of these tests
  for (let i = 1; i <= N && t === null; i++) {
    const ti = (SPEC.mg.life * i) / N;
    const fi = f(ti);
    if (fi <= 0) {
      let lo = (SPEC.mg.life * (i - 1)) / N;
      let hi = ti;
      for (let k = 0; k < 200 && hi - lo > 1e-16; k++) {
        const mid = 0.5 * (lo + hi);
        if (f(mid) > 0) lo = mid;
        else hi = mid;
      }
      t = 0.5 * (lo + hi);
    }
    prev = fi;
  }
  if (t === null) return null;
  // Newton polish on the quartic
  for (let k = 0; k < 4; k++) {
    const h = 1e-6;
    const d = (f(t + h) - f(t - h)) / (2 * h);
    if (d !== 0) {
      const tn = t - f(t) / d;
      if (tn > 0 && tn <= SPEC.mg.life && Math.abs(tn - t) < 1e-6) t = tn;
    }
  }
  const dir = mul(w(t), 1 / (s * t));
  return { t, dir, intercept: add(p, mul(v, t)), aimPoint: add(add(p, mul(v, t)), mul(a, t * t)) };
}
/** Missile, SPEC §4.4: smallest positive root of (v·v − 45²) t² + 2 (r·v) t + r·r = 0 in (0, 4]; else aim at p. */
function solveMissile(m, p, v) {
  const s = SPEC.missile.speed;
  const r = sub(p, m);
  const A = dot(v, v) - s * s;
  const B = 2 * dot(r, v);
  const C = dot(r, r);
  const roots = [];
  if (Math.abs(A) < 1e-12) {
    if (Math.abs(B) > 1e-12) roots.push(-C / B);
  } else {
    const disc = B * B - 4 * A * C;
    if (disc >= 0) {
      const q = Math.sqrt(disc);
      roots.push((-B - q) / (2 * A), (-B + q) / (2 * A));
    }
  }
  const ok = roots.filter((t) => t > 0 && t <= SPEC.missile.life).sort((x, y) => x - y);
  if (ok.length === 0) return { t: null, dir: unit(r) };
  return { t: ok[0], dir: unit(add(r, mul(v, ok[0]))) };
}
/** Checks one machine-gun shot record against my own solution. */
function checkMgRecord(rec) {
  const sol = solveMachineGun(rec.muzzlePosition, rec.targetPositionAtFire, rec.targetVelocityAtFire);
  const v0 = rec.initialVelocity;
  const speed = len(v0);
  const out = { id: rec.id, t: rec.firedAtSeconds, target: rec.targetId, speed, speedErr: Math.abs(speed - SPEC.mg.speed) };
  out.accOk = rec.accelerationAtFire[0] === 0 && rec.accelerationAtFire[1] === -SPEC.gravity && rec.accelerationAtFire[2] === 0;
  out.dirVsV0 = angleBetween(rec.launchDirection, v0);
  if (!sol) return { ...out, solved: false };
  out.solved = true;
  out.myT = sol.t;
  out.tErr = Math.abs(sol.t - rec.predictedFlightSeconds);
  out.angleErr = angleBetween(sol.dir, rec.launchDirection);
  // residual of the REAL shot: bullet (recorded muzzle, recorded initial velocity, gravity) vs constant-velocity
  // target at the recorded arrival time
  const tt = rec.predictedFlightSeconds;
  const bullet = add(add(rec.muzzlePosition, mul(v0, tt)), [0, -0.5 * SPEC.gravity * tt * tt, 0]);
  const target = add(rec.targetPositionAtFire, mul(rec.targetVelocityAtFire, tt));
  out.residual = len(sub(bullet, target));
  out.interceptErr = len(sub(rec.predictedInterceptPosition, target));
  out.range = len(sub(rec.targetPositionAtFire, rec.muzzlePosition));
  out.targetSpeed = len(rec.targetVelocityAtFire);
  return out;
}
/** Muzzle offset in world space for a body yaw (yaw 0 looks along −Z, mouse right = negative yaw). */
function muzzleOffset(yaw) {
  const f = [-Math.sin(yaw), 0, -Math.cos(yaw)];
  const rt = [Math.cos(yaw), 0, -Math.sin(yaw)];
  return [rt[0] * MUZZLE.right + f[0] * MUZZLE.forward, MUZZLE.up, rt[2] * MUZZLE.right + f[2] * MUZZLE.forward];
}

// ───────────────────────────── record ─────────────────────────────
const rows = [];
const notes = [];
const defects = [];
const T0 = Date.now();
const lap = (text) => console.log(`      [${((Date.now() - T0) / 1000).toFixed(0)} s] ${text}`);
const compact = (v) => {
  if (typeof v === 'string') return v;
  let text;
  try {
    // 6 decimals; tiny non-zero values (residuals, angle errors) keep their magnitude instead of becoming 0
    text = JSON.stringify(v, (_k, x) => (typeof x === 'number' && !Number.isInteger(x) ? (Math.abs(x) < 1e-6 ? Number(x.toExponential(2)) : Math.round(x * 1e6) / 1e6) : x));
  } catch {
    text = String(v);
  }
  return text;
};
/** One measured item: printed at once and kept for results.json. */
function row(id, o) {
  const r = {
    id,
    check: o.check,
    where: o.where,
    specRef: o.specRef ?? '',
    input: compact(o.input ?? ''),
    measured: compact(o.measured),
    expected: compact(o.expected),
    pass: !!o.pass,
    at: new Date().toISOString(),
  };
  rows.push(r);
  console.log(`${r.where === 'not-measured' ? 'N/M ' : r.pass ? 'PASS' : 'FAIL'}  [${id}] ${r.check}   <${r.where}>`);
  if (r.input) console.log(`        input    : ${r.input}`);
  console.log(`        measured : ${r.measured}`);
  console.log(`        expected : ${r.expected}`);
  save(); // after every row: a run that is interrupted later keeps what it measured
  return r.pass;
}
function note(text, data) {
  notes.push({ text, data: data === undefined ? null : data, at: new Date().toISOString() });
  console.log('NOTE  ' + text + (data !== undefined ? '   ' + compact(data) : ''));
}
function defect(d) {
  defects.push(d);
  console.log('DEFECT  ' + compact(d));
}
async function section(id, where, fn) {
  console.log(`\n────────── ${id} ──────────`);
  try {
    await fn();
  } catch (err) {
    row(id + '.exception', { check: `${id}: section ran to its end`, where, measured: String(err && err.stack ? err.stack : err).split('\n').slice(0, 4).join(' | '), expected: 'no exception', pass: false });
  }
  lap(id + ' done');
}
function save() {
  if (!OUT) return;
  fs.mkdirSync(OUT, { recursive: true });
  const key = (ONLY ? ONLY.join('+') : 'all') + (arg('legs') ? '-' + arg('legs') : '') + (arg('hz') ? '-' + arg('hz').replace(/,/g, '_') : '') + (arg('tag') ? '-' + arg('tag') : '');
  fs.writeFileSync(path.join(OUT, `rows-${key}.json`), JSON.stringify({ url: L.BASE_URL, group: key, finishedAt: new Date().toISOString(), rows, notes, defects }, null, 1));
}
const SHOTS = OUT ? path.join(OUT, 'shots') : null;

// ───────────────────────────── page helpers ─────────────────────────────
const SCRIPTED = { lock: true, clock: true };
const WHERE_S = 'browser-scripted-lock';
const WHERE_R = 'browser-real-lock';

/** Test-side probes (page.evaluate; nothing in the shipped page): trusted mouse moves and key events seen by the page. */
function installProbes(page) {
  return L.evaluate(page, () => {
    if (window.__sv) return true;
    const sv = (window.__sv = { moves: [], keys: { down: 0, repeat: 0, up: 0 }, left: false });
    window.addEventListener('mousemove', (e) => {
      if (e.isTrusted) sv.moves.push([e.movementX, e.movementY]);
    }, true);
    window.addEventListener('mousedown', (e) => {
      if (e.isTrusted && e.button === 0) sv.left = true;
    }, true);
    window.addEventListener('mouseup', (e) => {
      if (e.isTrusted && e.button === 0) sv.left = false;
    }, true);
    window.addEventListener('keydown', (e) => {
      if (!e.isTrusted) return;
      sv.keys.down++;
      if (e.repeat) sv.keys.repeat++;
    }, true);
    window.addEventListener('keyup', (e) => {
      if (e.isTrusted) sv.keys.up++;
    }, true);
    return true;
  });
}
async function openScripted(browser, o = {}) {
  const game = await L.openGame(browser, { width: GW, height: GH, ...o, scripted: SCRIPTED });
  await L.clockFreeze(game.page);
  await installProbes(game.page);
  game.yaw = 0;
  game.pitch = 0;
  return game;
}
/**
 * Virtual clock: runs exactly `frames` rendered frames of `ticksPerFrame` simulation ticks (k / 120 s) each and
 * returns the snapshot taken right after the last of them (same page task order as the game's own frame).
 */
function run(page, frames, ticksPerFrame) {
  if (frames <= 0) return L.snap(page);
  return L.evaluate(
    page,
    ([n, stepMs]) =>
      new Promise((resolve) => {
        const c = window.__e2e.clock;
        c.step = stepMs;
        c.budget = n;
        const poll = () => (c.budget === 0 ? resolve(window.__AK2__.getSnapshot()) : setTimeout(poll, 2));
        setTimeout(poll, 2);
      }),
    [frames, ticksPerFrame * TICK_MS],
  );
}
/** Runs `n` ticks in frames of at most `maxPerFrame` ticks (≤ 30 = the 0.25 s frame cap of the game). */
async function runTicks(page, n, maxPerFrame = 30) {
  n = Math.round(n);
  let s = null;
  const full = Math.floor(n / maxPerFrame);
  if (full > 0) s = await run(page, full, maxPerFrame);
  const rest = n - full * maxPerFrame;
  if (rest > 0) s = await run(page, 1, rest);
  return s ?? L.snap(page);
}
const ticksOf = (seconds) => Math.round(seconds * 120);
/** Runs until the simulation clock shows `t` (a whole tick); returns the snapshot. */
async function runTo(page, t, maxPerFrame = 30) {
  const now = (await L.snap(page)).elapsedSeconds;
  const n = Math.round((t - now) * 120);
  if (n < 0) throw new Error(`runTo: target ${t} is in the past (now ${now})`);
  return runTicks(page, n, maxPerFrame);
}
/** Runs frames of `k` ticks until `pred(snapshot)` or `maxFrames`; returns { s, frames, hit }. */
async function runUntil(page, k, pred, maxFrames = 400, each = null) {
  let s = await L.snap(page);
  for (let i = 0; i < maxFrames; i++) {
    if (pred(s)) return { s, frames: i, hit: true };
    s = await run(page, 1, k);
    if (each) await each(s);
    if (s.state !== 'playing') return { s, frames: i + 1, hit: pred(s) };
  }
  return { s, frames: maxFrames, hit: pred(s) };
}
/**
 * Viewport while a section plays ([w, h]) or null = leave it alone. Sections with many factory / mini-stage
 * frames set it to the small size: only the rendering cost changes (the simulation, and the lock circle as a
 * fraction of the picture, do not depend on it). Buttons are always clicked at the garage size.
 */
let playSize = null;
/** Real click on a start / resume / restart button under the scripted lock, then 'playing'. */
async function into(page, act) {
  if (playSize) await viewport(page, GW, GH);
  await L.clickAct(page, act);
  const s = await L.waitForState(page, 'playing');
  if (playSize) {
    await viewport(page, playSize[0], playSize[1]);
    // The pointer still is where the button was — outside the smaller viewport, where a button press would not
    // reach the page. Bring it inside with two mouse movements that cancel (+400 px, −400 px: the view is
    // unchanged; no simulation tick runs in between, the clock stands still).
    const g = { page, yaw: 0, pitch: 0 };
    await turn(g, 400, 0);
    await turn(g, -400, 0);
  }
  return s;
}
async function escPause(page) {
  if (playSize) await viewport(page, GW, GH);
  await page.keyboard.press('Escape');
  return L.waitForState(page, 'paused');
}
/** Switches the viewport (only the rendering cost changes; the lock circle stays factor × min(w, h)). */
async function viewport(page, w, h) {
  const vp = page.viewportSize();
  if (vp.width === w && vp.height === h) return;
  await page.setViewportSize({ width: w, height: h });
  await L.waitFrames(page, 2);
}
/** Scripted lock: pause menu → 同じ構成で再出撃 → playing at t = 0 (keys released first by the caller). */
async function resortie(game) {
  await viewport(game.page, GW, GH);
  await escPause(game.page);
  const s = await into(game.page, 'restart');
  game.yaw = 0;
  game.pitch = 0;
  return s;
}
/**
 * Mouse look under the scripted lock with ONE real, trusted mousemove of exactly (dx, dy) CSS px.
 * The pointer is not captured there, so it must end inside the viewport; a pointer position outside the
 * viewport produces no event, and the next event reports the movement from there. So: park the pointer
 * outside (silent), then move in by (dx, dy). The probe confirms that exactly this one movement arrived.
 * While a mouse button is down the browser delivers the moves outside the viewport too (drag capture), so a
 * held trigger is released for the movement and pressed again before the next frame: the game reads the
 * button once per frame and sees it held throughout.
 */
async function turn(game, dx, dy) {
  dx = Math.round(dx);
  dy = Math.round(dy);
  if (dx === 0 && dy === 0) return;
  const page = game.page;
  if (await L.evaluate(page, () => window.__sv.left)) {
    await page.mouse.up();
    try {
      await turn(game, dx, dy);
    } finally {
      await page.mouse.down();
    }
    return;
  }
  const { width: W, height: H } = page.viewportSize();
  if (Math.abs(dx) < 16 && Math.abs(dy) < 16) {
    // too small to come in from outside in one event: two events whose sum is (dx, dy)
    await turn(game, 300, 0);
    await turn(game, dx - 300, dy);
    return;
  }
  let rx;
  let ry;
  if (Math.abs(dx) >= 16) {
    rx = dx > 0 ? Math.max(4, Math.min(W - 4, dx - 14)) : Math.min(W - 4, Math.max(4, W + dx + 14));
    ry = Math.round(Math.max(4, Math.min(H - 4, H / 2 + (dy > 0 ? Math.min(dy, H / 2 - 6) : Math.max(dy, -H / 2 + 6)) / 2)));
  } else {
    ry = dy > 0 ? Math.max(4, Math.min(H - 4, dy - 14)) : Math.min(H - 4, Math.max(4, H + dy + 14));
    rx = Math.round(W / 2);
  }
  const qx = rx - dx;
  const qy = ry - dy;
  const before = await L.evaluate(page, () => window.__sv.moves.length);
  await page.mouse.move(qx, qy); // outside the viewport: no event
  await page.mouse.move(rx, ry); // one event with movement (dx, dy)
  await page.waitForFunction((n) => window.__sv.moves.length > n, before, { timeout: 15000, polling: 20 }).catch(() => {});
  const got = await L.evaluate(page, (n) => window.__sv.moves.slice(n), before);
  const sx = got.reduce((a, m) => a + m[0], 0);
  const sy = got.reduce((a, m) => a + m[1], 0);
  if (sx !== dx || sy !== dy) throw new Error(`turn(${dx}, ${dy}): the page saw ${JSON.stringify(got)}`);
  game.yaw -= dx * SENS;
  game.pitch -= dy * SENS;
}
/** Turns the view so that the world point `target` is at the screen centre (pivot = hit-box centre + 2.9 m, README §3 / config CAMERA). */
async function aimAt(game, s, target, pivotUp = 2.9) {
  const p = s.player.position;
  const d = [target[0] - p[0], target[1] - (p[1] + pivotUp), target[2] - p[2]];
  const yaw = Math.atan2(-d[0], -d[2]);
  const pitch = Math.atan2(d[1], Math.hypot(d[0], d[2]));
  let dyaw = yaw - game.yaw;
  dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
  await turn(game, -dyaw / SENS, -(pitch - game.pitch) / SENS);
}
/** Text of the HUD blocks (DOM, as displayed). */
function hudText(page) {
  return L.evaluate(page, () => {
    const t = (sel) => {
      const e = document.querySelector(sel);
      if (!e) return null;
      const st = getComputedStyle(e);
      if (st.display === 'none' || st.visibility === 'hidden') return null;
      return (e.innerText ?? e.textContent ?? '').replace(/\s+/g, ' ').trim();
    };
    return {
      topLeft: t('.hud-top-left'),
      topRight: t('.hud-top-right'),
      topCenter: t('.hud-top-center'),
      left: t('.hud-left'),
      right: t('.hud-right'),
      bottom: t('.hud-bottom'),
      lock: t('.hud-locklabel'),
      notice: t('.hud-notice'),
    };
  });
}
/** Screenshot at 1280×720 (the viewport is switched for the shot and restored); returns the file path or null. */
async function shot(game, name, size = [1280, 720]) {
  if (!SHOTS) return null;
  const page = game.page;
  const vp = page.viewportSize();
  fs.mkdirSync(SHOTS, { recursive: true });
  const file = path.join(SHOTS, name + '.png');
  const change = vp.width !== size[0] || vp.height !== size[1];
  if (change) {
    await page.setViewportSize({ width: size[0], height: size[1] });
    await L.waitFrames(page, 3);
  }
  await page.screenshot({ path: file, timeout: L.TIMEOUT });
  if (change) {
    await page.setViewportSize(vp);
    await L.waitFrames(page, 3);
  }
  console.log('      screenshot ' + file);
  return file;
}
const enemyOf = (s, id) => s.enemies.find((e) => e.id === id);
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** First differing paths of two JSON values (for a readable FAIL message). */
function diffPaths(a, b, prefix = '', out = []) {
  if (out.length >= 8) return out;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
    if (!Object.is(a, b) && JSON.stringify(a) !== JSON.stringify(b)) out.push(`${prefix}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
    return out;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) diffPaths(a[k], b[k], prefix ? prefix + '.' + k : k, out);
  return out;
}

// ═════════════════════════════ sections ═════════════════════════════
const browser = flag('merge') ? null : await L.launch();

async function S1() {
  const where = WHERE_S;
  playSize = null;
  const game = await openScripted(browser);
  const page = game.page;
  const g = await L.snap(page);
  const kinds = { guard: g.enemies.filter((e) => e.kind === 'guard').length, turret: g.enemies.filter((e) => e.kind === 'turret').length };
  const ids = g.enemies.map((e) => e.id);
  const controls = g.enemies.filter((e) => e.isGateControl);
  row('S1.counts', {
    check: 'stage facts in the snapshot of the shipped page (garage, before any sortie)',
    where,
    specRef: '§2.1 §2.2 §10',
    input: 'page load → getSnapshot()',
    measured: { sectorCount: g.stage.sectorCount, totalEnemies: g.stage.totalEnemies, enemies: g.enemies.length, ...kinds, uniqueIds: new Set(ids).size, gateControls: controls.map((e) => `${e.id}@${e.sectorId}`), controlsRequired: g.objective.controlsRequired, guardHp: [...new Set(g.enemies.filter((e) => e.kind === 'guard').map((e) => e.hp))], turretHp: [...new Set(g.enemies.filter((e) => e.kind === 'turret').map((e) => e.hp))], sectorsWithEnemies: new Set(g.enemies.map((e) => e.sectorId)).size },
    expected: 'sectorCount ≥ 15 (README: 19), 45 enemies with 45 unique ids = 30 guards (HP 120) + 15 turrets (HP 240), 6 gate controls (all turrets, different sectors), controlsRequired 6',
    pass: g.stage.sectorCount >= 15 && g.stage.totalEnemies === 45 && g.enemies.length === 45 && kinds.guard === 30 && kinds.turret === 15 && new Set(ids).size === 45 && controls.length === 6 && controls.every((e) => e.kind === 'turret') && new Set(controls.map((e) => e.sectorId)).size === 6 && g.objective.controlsRequired === 6 && g.enemies.every((e) => e.hp === (e.kind === 'guard' ? 120 : 240) && e.alive),
  });

  // ── L1 garage: all 18 builds ──
  const table = [];
  const bad = [];
  let cur = { ...g.loadout };
  const D = Math.min(GW, GH);
  for (const legs of ['biped', 'quadruped'])
    for (const generator of ['capacity', 'balanced', 'recovery'])
      for (const fcs of ['wide', 'medium', 'narrow']) {
        const next = { fcs, generator, legs };
        const diff = {};
        for (const k of ['fcs', 'generator', 'legs']) if (next[k] !== cur[k]) diff[k] = next[k];
        const s = await L.selectLoadout(page, diff);
        cur = next;
        const e = expectedStats(next);
        const panel = await L.evaluate(page, () => (document.querySelector('.gar-stats')?.innerText ?? '').replace(/\s+/g, ' ').trim());
        const shown = panel.includes(String(e.maxEn)) && panel.includes(e.regenPerSecond.toFixed(2)) && panel.includes(e.lockSeconds.toFixed(3));
        const ok = sameJson(s.loadout, next) && ['maxEn', 'regenPerSecond', 'lockSeconds', 'horizontalSpeedMultiplier'].every((k) => Math.abs(s.effectiveStats[k] - e[k]) < 1e-12) && s.player.en === e.maxEn && Math.abs(s.lock.radiusCssPx - FCS[fcs][0] * D) < 1e-9 && shown;
        table.push(`${fcs}/${generator}/${legs}: EN ${s.player.en}/${s.effectiveStats.maxEn} regen ${r6(s.effectiveStats.regenPerSecond)} lock ${r6(s.effectiveStats.lockSeconds)} ×${s.effectiveStats.horizontalSpeedMultiplier} r ${r6(s.lock.radiusCssPx)}px panel:${shown ? 'ok' : 'MISSING'}`);
        if (!ok) bad.push({ next, got: s.loadout, stats: s.effectiveStats, en: s.player.en, radius: s.lock.radiusCssPx, panel });
      }
  for (const line of table) console.log('        ' + line);
  row('L1.garage18', {
    check: 'garage: every one of the 18 builds selected with real clicks → snapshot loadout, effectiveStats, EN = max EN, lock radius; the stats panel shows max EN, regeneration and lock time',
    where,
    specRef: '§3 §5 §6',
    input: `18 × clicks on the part buttons at ${GW}×${GH}`,
    measured: bad.length ? bad.slice(0, 3) : `18/18 as expected (rows printed above); e.g. ${table[13]}`,
    expected: 'max EN 180/120/90, regen 10/15/20 × (1 | 0.75), lock 1.2/0.8/0.4 ÷ (1 | 1.5), speed × (1 | 0.8), radius 0.30/0.20/0.10 × min(w, h)',
    pass: bad.length === 0 && table.length === 18,
  });
  const product = Object.values(GEN).map(([a, b]) => a * b);
  note('L1: max EN × base regeneration of the three generators (SPEC §6: all 1800)', product);

  // ── S1: ids identical after a sortie and after a re-sortie ──
  await L.selectLoadout(page, { fcs: 'medium', generator: 'balanced', legs: 'biped' });
  const s1 = await into(page, 'sortie');
  await runTicks(page, 30);
  const again = await resortie(game);
  const stable = sameJson(ids, s1.enemies.map((e) => e.id)) && sameJson(ids, again.enemies.map((e) => e.id));
  const samePlaces = sameJson(s1.enemies.map((e) => [e.id, e.kind, e.isGateControl, e.sectorId, e.position, e.hp]), again.enemies.map((e) => [e.id, e.kind, e.isGateControl, e.sectorId, e.position, e.hp]));
  row('S1.ids', {
    check: 'enemy ids are the same list in the garage, in the first sortie and after a re-sortie; kinds, sectors, positions, HP too',
    where,
    specRef: '§10 (IDは…再出撃時にも同じ敵へ同じID)',
    input: '出撃 → 0.25 s → Esc → 同じ構成で再出撃',
    measured: { sameIds: stable, sameKindSectorPositionHp: samePlaces, first: ids.slice(0, 3), last: ids.slice(-3), t: [s1.elapsedSeconds, again.elapsedSeconds] },
    expected: 'identical',
    pass: stable && samePlaces && again.elapsedSeconds === 0,
  });
  row('S1.pageErrors', { check: 'S: no console error / uncaught exception', where, measured: game.errors.slice(0, 3), expected: [], pass: game.errors.length === 0 });
  await game.close();
}

// ───────────────────────────── M1 ─────────────────────────────
async function M1() {
  const where = WHERE_R;
  const game = await L.openGame(browser, { width: GW, height: GH });
  const page = game.page;
  await installProbes(page);
  const first = await L.sortie(page); // default build: medium / balanced / biped
  const locked = await L.evaluate(page, () => (document.pointerLockElement ? document.pointerLockElement.tagName : null));
  const before = await L.snap(page);
  const keys0 = await L.evaluate(page, () => ({ ...window.__sv.keys }));
  const samples = [];
  await L.keyDown(page, 'KeyQ');
  let s = await L.waitForSnapshot(page, (x) => x.player.movement.qbSuccessfulCount >= 1 || x.state !== 'playing', null, { label: 'QB' });
  const t0 = s.player.movement.qbLastStartedAtSeconds;
  const p0 = before.player.position;
  let repeats = 0;
  while (s.state === 'playing' && s.elapsedSeconds < t0 + 5.0) {
    samples.push(s);
    await L.autoRepeat(page, 'KeyQ', 2, 25);
    repeats += 2;
    s = await L.snap(page);
  }
  samples.push(s);
  await L.keyUp(page, 'KeyQ');
  const keys1 = await L.evaluate(page, () => ({ ...window.__sv.keys }));
  const regen = 15;
  console.log('        t−t0     EN        expected  count  mode        speed    z        grounded  hp');
  let worst = 0;
  let flatOk = true;
  const seen = new Set();
  for (const x of samples) {
    if (seen.has(x.elapsedSeconds)) continue;
    seen.add(x.elapsedSeconds);
    const tau = x.elapsedSeconds - t0;
    const exp = Math.min(120, 120 - 36 + regen * Math.max(0, tau - 0.75));
    worst = Math.max(worst, Math.abs(x.player.en - exp));
    if (tau <= 0.75 + 1e-9 && x.player.en !== 84) flatOk = false;
    console.log(`        ${tau.toFixed(4)}  ${x.player.en.toFixed(4).padStart(8)}  ${exp.toFixed(4).padStart(8)}  ${x.player.movement.qbSuccessfulCount}      ${x.player.movement.horizontalMode.padEnd(10)}  ${speedH(x).toFixed(3).padStart(6)}  ${x.player.position[2].toFixed(3).padStart(7)}  ${x.player.grounded}  ${x.player.hp}`);
  }
  const held = s.elapsedSeconds - t0;
  const counts = [...new Set(samples.map((x) => x.player.movement.qbSuccessfulCount))];
  const early = samples.filter((x) => x.elapsedSeconds - t0 <= 0.75 + 1e-9);
  row('M1.count', {
    check: 'Q held for 5 s with keyboard auto-repeat → exactly one quick boost',
    where,
    specRef: '§7.2 §11 単発入力',
    input: `default build, start dock; keydown Q, then ${repeats} auto-repeat keydown events (the page saw ${keys1.repeat - keys0.repeat} keydown with repeat = true) over ${held.toFixed(3)} s of simulation time, then keyup; pointer lock held by ${locked}`,
    measured: { qbSuccessfulCount: s.player.movement.qbSuccessfulCount, countsSeen: counts, qbLastStartedAtSeconds: t0, heldSimSeconds: r6(held), samples: seen.size, state: s.state },
    expected: 'qbSuccessfulCount = 1 in every sample, held ≥ 5 s',
    pass: s.player.movement.qbSuccessfulCount === 1 && counts.length === 1 && counts[0] === 1 && held >= 5 - 1e-9 && keys1.repeat - keys0.repeat >= 10 && locked === 'CANVAS' && s.state === 'playing',
  });
  row('M1.en', {
    check: 'the boost costs exactly 36 EN once; afterwards only the regeneration that starts 0.75 s later changes EN',
    where,
    specRef: '§6 §7.2 §11 単発入力',
    input: 'same run',
    measured: { enBefore: before.player.en, enAtSamplesUpTo0_75s: early.map((x) => [r6(x.elapsedSeconds - t0), x.player.en]), enAtEnd: s.player.en, maxAbsDeviationFromModel: worst, groundedInEverySample: samples.every((x) => x.player.grounded), lastEnSpentAtSeconds: s.player.movement.lastEnSpentAtSeconds },
    expected: `EN(t) = min(120, 120 − 36 + 15·max(0, t − t0 − 0.75)): 84 up to t0 + 0.75 s, then +15 EN/s; lastEnSpentAtSeconds = t0 = ${t0}`,
    pass: before.player.en === 120 && early.length >= 1 && flatOk && worst < 1e-6 && s.player.movement.lastEnSpentAtSeconds === t0,
  });
  const last = samples.at(-1);
  note('M1: where the 5 s ended (the lane of the start dock is 60 m; the boost + glide of 5 s needs 136 m, so the mech ends against a wall)', { start: p0, end: last.player.position, sector: last.stage.currentSectorId, hp: last.player.hp, enemiesThatFired: last.enemies.filter((e) => e.shotsFired > 0).map((e) => `${e.id}:${e.shotsFired}`), firstSnapshotT: first.elapsedSeconds });
  row('M1.pageErrors', { check: 'M1: no console error / uncaught exception', where, measured: game.errors.slice(0, 3), expected: [], pass: game.errors.length === 0 });
  await game.close();
}

// ───────────────────────────── M2 (quadruped, shipped page) ─────────────────────────────
/** Shared by M2q (factory) and FC (mini stage): Q tap with everything released, per-tick impulse, glide for `glideSeconds`. */
async function releaseRun(game, id, legs, where, place, tailSeconds = 3.0) {
  const page = game.page;
  const m = LEGS[legs][0];
  const a = await L.snap(page);
  const t0 = a.elapsedSeconds;
  const p0 = a.player.position;
  await L.keyDown(page, 'KeyQ');
  const trace = [];
  let s = await run(page, 1, 1);
  await L.keyUp(page, 'KeyQ'); // released after one tick: nothing is held from here on
  trace.push(s);
  for (let i = 0; i < 23; i++) trace.push((s = await run(page, 1, 1))); // τ = 2/120 … 24/120 = 0.2 s, every tick
  for (let i = 0; i < 11; i++) trace.push((s = await run(page, 1, 6))); // τ = 0.25 … 0.75 s
  const tailFrames = Math.round(tailSeconds / 0.25);
  for (let i = 0; i < tailFrames; i++) trace.push((s = await run(page, 1, 30))); // then every 0.25 s
  const started = trace[0].player.movement.qbLastStartedAtSeconds;
  console.log('        τ        mode        speed      model v   dist       model x    impulseLeft  EN      glide  grounded');
  let worstV = 0;
  let worstX = 0;
  const modes = [];
  for (const x of trace) {
    const tau = x.elapsedSeconds - t0;
    const mod = qbModel(tau, m);
    const d = hdist(x.player.position, p0);
    worstV = Math.max(worstV, Math.abs(speedH(x) - mod.v));
    worstX = Math.max(worstX, Math.abs(d - mod.x));
    if (modes.at(-1) !== x.player.movement.horizontalMode) modes.push(x.player.movement.horizontalMode);
    console.log(`        ${tau.toFixed(4)}  ${x.player.movement.horizontalMode.padEnd(10)}  ${speedH(x).toFixed(4).padStart(8)}  ${mod.v.toFixed(4).padStart(8)}  ${d.toFixed(4).padStart(9)}  ${mod.x.toFixed(4).padStart(9)}  ${x.player.movement.qbImpulseRemainingSeconds.toFixed(4)}       ${x.player.en.toFixed(2)}  ${x.player.movement.glideEnabled}  ${x.player.grounded}`);
  }
  const at = (tau) => trace.find((x) => Math.abs(x.elapsedSeconds - t0 - tau) < 1e-9);
  const impulse = trace.filter((x) => x.elapsedSeconds - t0 < SPEC.qbImpulse - 1e-9);
  const endImpulse = at(0.15);
  const at075 = at(0.75);
  const tail = trace.filter((x) => x.elapsedSeconds - t0 >= 0.75 - 1e-9);
  const glideSpan = tail.at(-1).elapsedSeconds - tail[0].elapsedSeconds;
  row(id + '.impulse', {
    check: `${legs}: short Q tap, all keys released → ${SPEC.qbImpulse} s at ${80 * m} m/s (every tick sampled)`,
    where,
    specRef: '§7.2 §11 入力解放',
    input: `${place}; keydown Q at t0 = ${t0}, 1 tick, keyup Q; no key or button held afterwards`,
    measured: { qbStartedAt: started, impulseTicks: impulse.length, speedMinMax: [Math.min(...impulse.map(speedH)), Math.max(...impulse.map(speedH))], modesDuringImpulse: [...new Set(impulse.map((x) => x.player.movement.horizontalMode))], atEnd: { tau: 0.15, speed: speedH(endImpulse), dist: hdist(endImpulse.player.position, p0), mode: endImpulse.player.movement.horizontalMode, impulseLeft: endImpulse.player.movement.qbImpulseRemainingSeconds } },
    expected: `17 samples inside the impulse, all 'quickboost' at ${80 * m} m/s; at τ = 0.15 s: ${12 * m} m travelled, impulse over`,
    pass: started === t0 && impulse.length === 17 && impulse.every((x) => x.player.movement.horizontalMode === 'quickboost' && Math.abs(speedH(x) - 80 * m) < 1e-9) && Math.abs(hdist(endImpulse.player.position, p0) - 12 * m) < 1e-6 && endImpulse.player.movement.qbImpulseRemainingSeconds < 1e-9,
  });
  row(id + '.inertia', {
    check: `${legs}: deceleration over 0.60 s to the glide speed, then glide with no key held for ${glideSpan.toFixed(2)} s; mode sequence`,
    where,
    specRef: '§7.2 §11 入力解放',
    input: 'same run; samples every tick to 0.2 s, every 0.05 s to 0.75 s, every 0.25 s afterwards',
    measured: { modeSequence: modes, at075: { speed: speedH(at075), dist: hdist(at075.player.position, p0) }, maxSpeedDeviationFromModel: worstV, maxDistanceDeviationFromModel: worstX, tailSpeeds: [...new Set(tail.map((x) => r6(speedH(x))))], glideEnabledInTail: tail.every((x) => x.player.movement.glideEnabled), tailSeconds: r6(glideSpan), endDist: hdist(tail.at(-1).player.position, p0), groundedThroughout: trace.every((x) => x.player.grounded) },
    expected: `quickboost → glide; v(τ) = ${80 * m} − ${r6((58 / 0.6) * m)}·(τ − 0.15) down to ${22 * m} m/s at 0.75 s (${r6(42.6 * m)} m), then ${22 * m} m/s for ≥ 3 s: ${r6(42.6 * m + 22 * m * glideSpan)} m at the end`,
    pass: sameJson(modes, ['quickboost', 'glide']) && worstV < 1e-6 && worstX < 1e-6 && glideSpan >= 3 - 1e-9 && tail.every((x) => x.player.movement.glideEnabled && x.player.movement.horizontalMode === 'glide' && Math.abs(speedH(x) - 22 * m) < 1e-9),
  });
  return { t0, p0, trace };
}
async function M2q() {
  const where = WHERE_S;
  const game = await openScripted(browser);
  const page = game.page;
  await L.selectLoadout(page, { legs: 'quadruped' });
  await into(page, 'sortie');
  // walk backwards to the back of the dock so that 34.08 + 3 × 17.6 = 86.9 m of straight floor lie ahead
  await L.keyDown(page, 'KeyS');
  await runTicks(page, 150);
  await L.keyUp(page, 'KeyS');
  const b = await runTicks(page, 30);
  note('M2q: start of the run (after walking backwards into the back wall of the dock)', { position: b.player.position, speed: speedH(b), t: b.elapsedSeconds });
  const r = await releaseRun(game, 'M2q', 'quadruped', where, `shipped page, start dock, from z = ${b.player.position[2].toFixed(2)} looking −Z`);
  const end = r.trace.at(-1);
  note('M2q: end of the run', { position: end.player.position, sector: end.stage.currentSectorId, hp: end.player.hp, enemiesWithLos: end.enemies.filter((e) => e.hasLineOfSight).map((e) => e.id) });
  row('M2q.pageErrors', { check: 'M2q: no console error / uncaught exception', where, measured: game.errors.slice(0, 3), expected: [], pass: game.errors.length === 0 });
  await game.close();
}

// ───────────────────────────── M3 ─────────────────────────────
async function M3() {
  const where = WHERE_S;
  playSize = null;
  const legsList = arg('legs') ? arg('legs').split(',') : ['biped', 'quadruped'];
  const hzList = arg('hz') ? arg('hz').split(',').map(Number) : [30, 60, 120, 144];
  const game = await openScripted(browser);
  const page = game.page;
  const summary = [];
  for (const legs of legsList) {
    const m = LEGS[legs][0];
    const regen = 15 * LEGS[legs][1];
    await L.selectLoadout(page, { fcs: 'medium', generator: 'balanced', legs });
    let s = await into(page, 'sortie');
    for (const hz of hzList) {
      const stepMs = 1000 / hz;
      const stepF = (frames) => runMs(page, frames, stepMs);
      if (s.elapsedSeconds !== 0) s = await resortie(game);
      await viewport(page, SW, SH);
      const start = s.player.position;
      const t0 = s.elapsedSeconds;
      // ── quick boost: tap Q, sample at 0.75 s ──
      await L.keyDown(page, 'KeyQ');
      s = await stepF(1);
      await L.keyUp(page, 'KeyQ');
      let frames = 1;
      const n075 = Math.floor(0.75 * hz + 1e-9); // whole frames inside 0.75 s
      s = await stepF(n075 - 1);
      frames += n075 - 1;
      let partial = null;
      if (Math.abs(n075 / hz - 0.75) > 1e-9) {
        // 0.75 s is not a whole number of frames at this rate (30 Hz: 22.5): report the last whole frame against
        // the model, then ONE shorter frame up to 0.75 s exactly
        const tau = s.elapsedSeconds - t0;
        partial = { tau, dist: hdist(s.player.position, start), model: qbModel(tau, m).x };
        s = await runMs(page, 1, (0.75 - n075 / hz) * 1000);
      }
      const a = s;
      const tauA = a.elapsedSeconds - t0;
      const dist = hdist(a.player.position, start);
      // ── glide speed and regeneration slope over the next 0.5 s (no key held) ──
      s = await stepF(Math.round(0.5 * hz));
      const b = s;
      const dtG = b.elapsedSeconds - a.elapsedSeconds;
      const glideSpeed = hdist(b.player.position, a.player.position) / dtG;
      const regenSlope = (b.player.en - a.player.en) / dtG;
      // ── brake to a stop ──
      await L.keyDown(page, 'ControlLeft');
      s = await stepF(Math.ceil(0.3 * hz));
      await L.keyUp(page, 'ControlLeft');
      const stopped = s;
      // ── walk (S = backwards, towards the start) ──
      await L.keyDown(page, 'KeyS');
      s = await stepF(Math.ceil(0.2 * hz));
      const w1 = s;
      s = await stepF(Math.round(0.3 * hz));
      const w2 = s;
      await L.keyUp(page, 'KeyS');
      const walkSpeed = hdist(w2.player.position, w1.player.position) / (w2.elapsedSeconds - w1.elapsedSeconds);
      s = await stepF(Math.ceil(0.15 * hz));
      const still = s;
      // ── flight: hold Space ──
      const tj = s.elapsedSeconds;
      await L.keyDown(page, 'Space');
      s = await stepF(Math.ceil(0.3 * hz));
      const f1 = s;
      s = await stepF(Math.round(0.3 * hz));
      const f2 = s;
      await L.keyUp(page, 'Space');
      const flyRate = (f1.player.en - f2.player.en) / (f2.elapsedSeconds - f1.elapsedSeconds);
      const climb = (f2.player.position[1] - f1.player.position[1]) / (f2.elapsedSeconds - f1.elapsedSeconds);
      // EN ledger of the whole run at f2: 120 − 36 + regen·(tj − t0 − 0.75) [grounded, capped] − 20·(t − tj − 0.20)
      const enAtJump = Math.min(120, 84 + regen * (tj - t0 - 0.75));
      const enModel = enAtJump - SPEC.flyEn * (f2.elapsedSeconds - tj - SPEC.flyHold);
      const rec = {
        legs, hz,
        qbStartedAt: a.player.movement.qbLastStartedAtSeconds, tauA, dist, distModel: qbModel(tauA, m).x, speedAt075: speedH(a), modeAt075: a.player.movement.horizontalMode,
        enAt075: a.player.en, partial, glideSpeed, regenSlope, stoppedSpeed: speedH(stopped), walkSpeed, walkVelocity: speedH(w2), stillSpeed: speedH(still),
        flyRate, climb, flyModes: [f1.player.movement.verticalMode, f2.player.movement.verticalMode], enAtF2: f2.player.en, enModelAtF2: enModel, count: f2.player.movement.qbSuccessfulCount, frames: null, simSeconds: f2.elapsedSeconds,
      };
      summary.push(rec);
      const okDist = Math.abs(tauA - 0.75) < 1e-9 && Math.abs(dist - 42.6 * m) < 1e-6;
      row(`M3.${legs}.${hz}Hz.distance`, {
        check: `${legs}, ${hz} Hz frames: displacement 0.75 s after the quick-boost start on the flat lane of the start dock`,
        where,
        specRef: '§7.2 §9 §11 移動量',
        input: `Q tap at t0 = ${t0} (released after the first frame), nothing held; ${n075} frames of 1/${hz} s${partial ? ` + one frame of ${(0.75 - n075 / hz).toFixed(6)} s (0.75 s is ${0.75 * hz} frames at this rate)` : ''}; start ${v3s(start)}`,
        measured: { tau: tauA, displacement: dist, deviation: dist - 42.6 * m, speed: speedH(a), mode: a.player.movement.horizontalMode, en: a.player.en, ...(partial ? { atLastWholeFrame: { tau: r6(partial.tau), displacement: partial.dist, model: partial.model } } : {}) },
        expected: `${r6(42.6 * m)} m (80·0.15 + (80 + 22)/2·0.60 = 42.6, × ${m}); speed ${22 * m} m/s, mode glide, EN 84`,
        pass: okDist && Math.abs(speedH(a) - 22 * m) < 1e-9 && a.player.movement.horizontalMode === 'glide' && a.player.en === 84 && a.player.movement.qbLastStartedAtSeconds === t0 && (!partial || Math.abs(partial.dist - partial.model) < 1e-6),
      });
      row(`M3.${legs}.${hz}Hz.rates`, {
        check: `${legs}, ${hz} Hz frames: glide speed, regeneration slope, walk speed, flight EN rate and climb`,
        where,
        specRef: '§6 §7.1 §9',
        input: `after the boost: 0.5 s key-less glide; Left Ctrl ${Math.ceil(0.3 * hz)} frames; S held (walk) ${Math.ceil(0.2 * hz)} + ${Math.round(0.3 * hz)} frames; Space held from t = ${r6(tj)} for ${Math.ceil(0.3 * hz)} + ${Math.round(0.3 * hz)} frames`,
        measured: { glideSpeed, regenSlope, walkSpeed, walkVelocityReading: speedH(w2), speedAfterBrake: speedH(stopped), flightEnPerSecond: flyRate, climbSpeed: climb, verticalModes: rec.flyModes, enAtEnd: f2.player.en, enLedgerModel: enModel },
        expected: `glide ${22 * m} m/s; regeneration ${regen} EN/s (from 0.75 s after the boost, while gliding); walk ${10 * m} m/s; brake → 0; flight 20 EN/s and 8 m/s climb (not scaled by the legs); EN at the end = min(120, 84 + ${regen}·(t_jump − t0 − 0.75)) − 20·(t − t_jump − 0.20)`,
        pass: Math.abs(glideSpeed - 22 * m) < 1e-6 && Math.abs(regenSlope - regen) < 1e-6 && Math.abs(walkSpeed - 10 * m) < 1e-6 && speedH(stopped) < 1e-9 && Math.abs(flyRate - 20) < 1e-6 && Math.abs(climb - 8) < 1e-6 && rec.flyModes.every((v) => v === 'flying') && Math.abs(f2.player.en - enModel) < 1e-6 && f2.player.movement.qbSuccessfulCount === 1,
      });
      lap(`M3 ${legs} ${hz} Hz`);
    }
    // back to the garage for the other legs
    await viewport(page, GW, GH);
    await escPause(page);
    await L.toGarage(page);
  }
  // frame-rate independence: the same numbers at every rate
  for (const legs of legsList) {
    const set = summary.filter((r) => r.legs === legs);
    if (set.length < 2) continue;
    const spread = (k) => Math.max(...set.map((r) => r[k])) - Math.min(...set.map((r) => r[k]));
    const keys = ['dist', 'glideSpeed', 'regenSlope', 'walkSpeed', 'flyRate', 'climb'];
    const spreads = Object.fromEntries(keys.map((k) => [k, spread(k)]));
    row(`M3.${legs}.independence`, {
      check: `${legs}: the same distance, speeds and EN rates at ${set.map((r) => r.hz).join(' / ')} Hz virtual frames`,
      where,
      specRef: '§9 (描画が30、60、120fps…同じ時間に対する速度や資源消費が実質的に変わってはいけません)',
      input: 'the runs above (one fresh sortie per rate)',
      measured: { perRate: set.map((r) => ({ hz: r.hz, dist075: r6(r.dist), glide: r6(r.glideSpeed), regen: r6(r.regenSlope), walk: r6(r.walkSpeed), flightEn: r6(r.flyRate), climb: r6(r.climb) })), maxSpread: spreads },
      expected: 'spread ≤ 1e-6 for every quantity',
      pass: Object.values(spreads).every((v) => v < 1e-6),
    });
  }
  row('M3.pageErrors', { check: 'M3: no console error / uncaught exception', where, measured: game.errors.slice(0, 3), expected: [], pass: game.errors.length === 0 });
  await game.close();
}
/** Virtual clock: `frames` frames of `stepMs` each (any frame rate); returns the snapshot after the last one. */
function runMs(page, frames, stepMs) {
  return run(page, frames, stepMs / TICK_MS);
}

// ───────────────────────────── M4 ─────────────────────────────
/** Holds the trigger with the beam for `n` frames of 0.25 s (one beam shot per frame); returns the snapshot. */
async function beamBurst(page, n) {
  await L.tapKey(page, 'Digit2', 20);
  await page.mouse.down();
  const s = await run(page, n, 30);
  return s;
}
async function M4() {
  const where = WHERE_S;
  const game = await openScripted(browser);
  const page = game.page;
  const first = await into(page, 'sortie'); // medium / balanced / biped: 120 EN = 15 beam shots
  let s = await beamBurst(page, 15);
  const beams = s.recentPlayerShots.filter((x) => x.weapon === 'beam');
  const ts = beams.at(-1).firedAtSeconds;
  // one more frame with the trigger still held at EN 0: nothing fires, nothing is spent
  const dry = await run(page, 1, 30);
  const hudDry = await hudText(page);
  await page.mouse.up();
  row('M4.drain', {
    check: 'EN brought to exactly 0 in play: 15 beam shots of 8 EN; a 16th pull at EN 0 fires nothing and does not restart the regeneration wait',
    where,
    specRef: '§4.1 §6',
    input: `default build (120 EN); key 2, left button held for 15 frames of 0.25 s, then one more frame`,
    measured: { beamShots: beams.length, firstAt: beams[0].firedAtSeconds, lastAt: ts, gaps: [...new Set(beams.slice(1).map((x, i) => r6(x.firedAtSeconds - beams[i].firedAtSeconds)))], en: s.player.en, afterDryFrame: { shots: dry.recentPlayerShots.length, en: dry.player.en, lastEnSpentAtSeconds: dry.player.movement.lastEnSpentAtSeconds, t: dry.elapsedSeconds }, hudNotice: hudDry.notice, hudLeft: hudDry.left },
    expected: '15 shots 0.25 s apart, EN 120 − 15·8 = 0; dry frame: still 15 records, EN 0, lastEnSpentAtSeconds = time of the 15th shot; HUD says EN不足',
    pass: first.player.en === 120 && beams.length === 15 && s.player.en === 0 && dry.recentPlayerShots.length === 15 && dry.player.en === 0 && dry.player.movement.lastEnSpentAtSeconds === ts && /EN不足/.test((hudDry.notice ?? '') + (hudDry.left ?? '')),
  });
  // glide switched on at EN 0
  const tShift = dry.elapsedSeconds;
  const p0 = dry.player.position;
  await L.tapKey(page, 'ShiftLeft', 20);
  const samples = [];
  s = await runTo(page, ts + 0.75); // regeneration may start here
  samples.push(s);
  s = await run(page, 1, 1);
  samples.push(s);
  for (let i = 0; i < 4; i++) samples.push((s = await runTo(page, ts + 0.75 + 0.25 * (i + 1))));
  console.log('        t − t_lastSpend   EN        model     mode   speed    glide  grounded');
  let worst = 0;
  for (const x of samples) {
    const tau = x.elapsedSeconds - ts;
    const model = 15 * Math.max(0, tau - 0.75);
    worst = Math.max(worst, Math.abs(x.player.en - model));
    console.log(`        ${tau.toFixed(4)}            ${x.player.en.toFixed(4).padStart(7)}  ${model.toFixed(4).padStart(7)}  ${x.player.movement.horizontalMode}  ${speedH(x).toFixed(3)}  ${x.player.movement.glideEnabled}  ${x.player.grounded}`);
  }
  const at075 = samples[0];
  const end = samples.at(-1);
  row('M4.glideAtZero', {
    check: 'glide switched on with Shift at EN 0 works (22 m/s) and costs nothing; on the ground EN regenerates from 0.75 s after the last spend while the mech keeps gliding',
    where,
    specRef: '§0 §6 §7.3 §11 グライドのEN',
    input: `Shift tap at t = ${r6(tShift)} (EN 0, standing, glide off); no other key; last EN spend (15th beam) at ${r6(ts)}`,
    measured: { at075: { en: at075.player.en, speed: speedH(at075), mode: at075.player.movement.horizontalMode, glideEnabled: at075.player.movement.glideEnabled }, oneTickLater: { en: samples[1].player.en }, at175: { en: end.player.en, speed: speedH(end), mode: end.player.movement.horizontalMode, grounded: end.player.grounded }, slope: (end.player.en - at075.player.en) / (end.elapsedSeconds - at075.elapsedSeconds), maxDeviationFromModel: worst, glided: hdist(end.player.position, p0), lastEnSpentAtSeconds: end.player.movement.lastEnSpentAtSeconds },
    expected: 'EN 0 up to t_lastSpend + 0.75 s, then 15 EN/s (0.125 after one tick, 15.0 after 1 s) with horizontalMode glide at 22 m/s, grounded',
    pass: at075.player.en === 0 && Math.abs(samples[1].player.en - 0.125) < 1e-9 && worst < 1e-6 && samples.every((x) => x.player.movement.glideEnabled && x.player.movement.horizontalMode === 'glide' && x.player.grounded) && Math.abs(speedH(at075) - 22) < 1e-9 && Math.abs(speedH(end) - 22) < 1e-9 && end.player.movement.lastEnSpentAtSeconds === ts,
  });
  row('M4.pageErrors', { check: 'M4: no console error / uncaught exception', where, measured: game.errors.slice(0, 3), expected: [], pass: game.errors.length === 0 });
  await game.close();
}

// ───────────────────────────── M5 ─────────────────────────────
async function M5() {
  const where = WHERE_S;
  const game = await openScripted(browser);
  const page = game.page;
  await L.selectLoadout(page, { generator: 'capacity' }); // 180 EN, 10 EN/s (biped)
  // ── A: exactly 36 by spending: 180 − 18·8 ──
  let s = await into(page, 'sortie');
  s = await beamBurst(page, 18);
  await page.mouse.up();
  const beamsA = s.recentPlayerShots.filter((x) => x.weapon === 'beam');
  const en36 = s.player.en;
  const tA = s.elapsedSeconds;
  const pA = s.player.position;
  await L.keyDown(page, 'KeyQ');
  const a1 = await run(page, 1, 1);
  await L.keyUp(page, 'KeyQ');
  const a015 = await runTo(page, tA + 0.15);
  const a075 = await runTo(page, tA + 0.75);
  const a100 = await runTo(page, tA + 1.0);
  const a125 = await runTo(page, tA + 1.25);
  row('M5.accept36', {
    check: 'EN exactly 36 (180 − 18 beam shots × 8) → Q accepted once → EN 0; inertia and the automatic glide continue at EN 0',
    where,
    specRef: '§6 §7.2 §11 残量境界',
    input: `capacity / biped; key 2, 18 beam shots (18 frames of 0.25 s), button released; Q tap at t = ${r6(tA)}`,
    measured: { beamShots: beamsA.length, enBeforeQ: en36, afterOneTick: { count: a1.player.movement.qbSuccessfulCount, en: a1.player.en, startedAt: a1.player.movement.qbLastStartedAtSeconds, mode: a1.player.movement.horizontalMode, speed: speedH(a1) }, at015: { dist: hdist(a015.player.position, pA), speed: speedH(a015) }, at075: { dist: hdist(a075.player.position, pA), speed: speedH(a075), mode: a075.player.movement.horizontalMode, en: a075.player.en }, at100: { en: a100.player.en }, at125: { dist: hdist(a125.player.position, pA), speed: speedH(a125), mode: a125.player.movement.horizontalMode, glideEnabled: a125.player.movement.glideEnabled, en: a125.player.en } },
    expected: 'EN 36 → count 1, EN 0 at once; 12 m at 0.15 s; 42.6 m and 22 m/s (glide) at 0.75 s with EN still 0; EN 2.5 at 1.0 s and 5.0 at 1.25 s (10 EN/s from 0.75 s after the boost); 53.6 m at 1.25 s',
    pass: beamsA.length === 18 && en36 === 36 && a1.player.movement.qbSuccessfulCount === 1 && a1.player.en === 0 && a1.player.movement.qbLastStartedAtSeconds === tA && Math.abs(hdist(a015.player.position, pA) - 12) < 1e-6 && Math.abs(hdist(a075.player.position, pA) - 42.6) < 1e-6 && Math.abs(speedH(a075) - 22) < 1e-9 && a075.player.en === 0 && Math.abs(a100.player.en - 2.5) < 1e-9 && Math.abs(a125.player.en - 5) < 1e-9 && Math.abs(hdist(a125.player.position, pA) - 53.6) < 1e-6 && a125.player.movement.horizontalMode === 'glide' && a125.player.movement.glideEnabled,
  });

  // ── B1: 35 by regeneration: 19 shots → 28, +0.7 s of regeneration; Q held across 36 ──
  s = await resortie(game);
  s = await beamBurst(page, 19);
  await page.mouse.up();
  const beamsB = s.recentPlayerShots.filter((x) => x.weapon === 'beam');
  const tsB = beamsB.at(-1).firedAtSeconds;
  const r0 = tsB + 0.75; // regeneration starts
  const b35 = await runTo(page, r0 + 0.7);
  await L.keyDown(page, 'KeyQ');
  const b1 = await run(page, 1, 1);
  const held = [b1];
  for (let i = 0; i < 4; i++) {
    await L.autoRepeat(page, 'KeyQ', 1, 10);
    held.push(await run(page, 1, 6)); // Q stays down while EN passes 36 (36.0 is reached 12 ticks after 35.0)
  }
  await L.keyUp(page, 'KeyQ');
  const bEnd = held.at(-1);
  row('M5.refuse35', {
    check: 'EN exactly 35 → Q refused: no boost, no EN spent, no re-use wait started, regeneration wait not restarted; the refused press is not kept for later (Q stays down while EN regenerates past 36)',
    where,
    specRef: '§6 §7.2 §11 残量境界',
    input: `capacity / biped; 19 beam shots → 28 EN (last at ${r6(tsB)}); wait until 0.75 + 0.70 s after it; keydown Q at t = ${r6(b35.elapsedSeconds)} and hold it for ${held.length - 1} more samples with auto-repeat`,
    measured: { enAtPress: b35.player.en, afterOneTick: { count: b1.player.movement.qbSuccessfulCount, en: b1.player.en, startedAt: b1.player.movement.qbLastStartedAtSeconds, cooldown: b1.player.movement.qbCooldownRemainingSeconds, lastEnSpentAtSeconds: b1.player.movement.lastEnSpentAtSeconds, speed: speedH(b1), mode: b1.player.movement.horizontalMode }, whileHeld: held.map((x) => [r6(x.elapsedSeconds - b35.elapsedSeconds), r6(x.player.en), x.player.movement.qbSuccessfulCount]) },
    expected: `EN 35 at the press; one tick later count 0, EN 35 + 10/120 = 35.083333 (regeneration goes on), qbLastStartedAtSeconds null, cooldown 0, lastEnSpentAtSeconds = ${r6(tsB)}; still count 0 when EN is above 36 with Q held`,
    pass: beamsB.length === 19 && b35.player.en === 35 && b1.player.movement.qbSuccessfulCount === 0 && Math.abs(b1.player.en - (35 + 10 / 120)) < 1e-9 && b1.player.movement.qbLastStartedAtSeconds === null && b1.player.movement.qbCooldownRemainingSeconds === 0 && b1.player.movement.lastEnSpentAtSeconds === tsB && speedH(b1) === 0 && bEnd.player.en > 36 && held.every((x) => x.player.movement.qbSuccessfulCount === 0),
  });
  await L.keyDown(page, 'KeyQ');
  const b2 = await run(page, 1, 1);
  await L.keyUp(page, 'KeyQ');
  row('M5.repress', {
    check: 'after the refused press: Q released and pressed again with EN ≥ 36 → accepted (the refusal was the EN, not a stuck key)',
    where,
    specRef: '§7.2',
    input: `keyup Q, keydown Q at t = ${r6(bEnd.elapsedSeconds)} with EN ${r6(bEnd.player.en)}`,
    measured: { count: b2.player.movement.qbSuccessfulCount, en: b2.player.en, startedAt: b2.player.movement.qbLastStartedAtSeconds },
    expected: `count 1, EN ${r6(bEnd.player.en)} − 36 = ${r6(bEnd.player.en - 36)}, started at ${r6(bEnd.elapsedSeconds)}`,
    pass: b2.player.movement.qbSuccessfulCount === 1 && Math.abs(b2.player.en - (bEnd.player.en - 36)) < 1e-9 && b2.player.movement.qbLastStartedAtSeconds === bEnd.elapsedSeconds,
  });

  // ── B2: one tick before regeneration reaches 36 → refused; at exactly 36.0 → accepted ──
  s = await resortie(game);
  s = await beamBurst(page, 19);
  await page.mouse.up();
  const tsC = s.recentPlayerShots.filter((x) => x.weapon === 'beam').at(-1).firedAtSeconds;
  const c0 = await runTo(page, tsC + 0.75 + 0.8 - TICK);
  await L.keyDown(page, 'KeyQ');
  const c1 = await run(page, 1, 1);
  await L.keyUp(page, 'KeyQ');
  await L.keyDown(page, 'KeyQ');
  const c2 = await run(page, 1, 1);
  await L.keyUp(page, 'KeyQ');
  row('M5.oneTickBefore36', {
    check: 'Q pressed one tick before the regeneration reaches 36 → refused; released and pressed again one tick later at exactly 36.0 → accepted, EN 0',
    where,
    specRef: '§6 §7.2 §11 残量境界',
    input: `capacity / biped; 19 beam shots → 28 EN; keydown Q at t = ${r6(c0.elapsedSeconds)} (0.75 + 0.8 s − 1 tick after the last shot), 1 tick, keyup, keydown, 1 tick`,
    measured: { firstPress: { enAtPress: c0.player.en, countAfter: c1.player.movement.qbSuccessfulCount, enAfter: c1.player.en, cooldown: c1.player.movement.qbCooldownRemainingSeconds }, secondPress: { enAtPress: c1.player.en, countAfter: c2.player.movement.qbSuccessfulCount, enAfter: c2.player.en, startedAt: c2.player.movement.qbLastStartedAtSeconds } },
    expected: 'first press at EN 36 − 10/120 = 35.916667: count 0, EN 36.0 one tick later, cooldown 0; second press at EN 36.0 exactly: count 1, EN 0',
    pass: Math.abs(c0.player.en - (36 - 10 / 120)) < 1e-9 && c1.player.movement.qbSuccessfulCount === 0 && c1.player.en === 36 && c1.player.movement.qbCooldownRemainingSeconds === 0 && c2.player.movement.qbSuccessfulCount === 1 && c2.player.en === 0 && c2.player.movement.qbLastStartedAtSeconds === c1.elapsedSeconds,
  });
  row('M5.pageErrors', { check: 'M5: no console error / uncaught exception', where, measured: game.errors.slice(0, 3), expected: [], pass: game.errors.length === 0 });
  await game.close();
}

// ───────────────────────────── M6 ─────────────────────────────
async function M6() {
  const where = WHERE_S;
  const game = await openScripted(browser);
  const page = game.page;
  await L.selectLoadout(page, { generator: 'capacity' });
  let s = await into(page, 'sortie');
  await L.tapKey(page, 'Digit2', 20);
  // glide is free
  await L.tapKey(page, 'ShiftLeft', 20);
  const g = [];
  for (let i = 0; i < 5; i++) g.push((s = await run(page, 1, 12)));
  row('M6.glideFree', {
    check: 'glide switched on with Shift and held for 0.5 s costs no EN',
    where,
    specRef: '§0 §7.3 §11 同時操作',
    input: 'capacity / biped (180 EN), start dock; Shift tap, no other key, 5 samples of 0.1 s',
    measured: { en: g.map((x) => x.player.en), speed: g.map((x) => r3(speedH(x))), mode: g.at(-1).player.movement.horizontalMode, lastEnSpentAtSeconds: g.at(-1).player.movement.lastEnSpentAtSeconds },
    expected: 'EN 180 in every sample, speed → 22 m/s, mode glide, lastEnSpentAtSeconds null',
    pass: g.every((x) => x.player.en === 180) && Math.abs(speedH(g.at(-1)) - 22) < 1e-9 && g.at(-1).player.movement.horizontalMode === 'glide' && g.at(-1).player.movement.lastEnSpentAtSeconds === null,
  });
  // simultaneous: Q + Space + trigger (beam) in the same frame
  const T = s.elapsedSeconds;
  const P = s.player.position;
  await L.keyDown(page, 'KeyQ');
  await L.keyDown(page, 'Space');
  await page.mouse.down();
  const trace = [];
  for (let i = 0; i < 12; i++) trace.push((s = await run(page, 1, 6))); // 0.6 s in steps of 0.05 s
  await L.keyUp(page, 'KeyQ');
  await L.keyUp(page, 'Space');
  await page.mouse.up();
  const tRelease = s.elapsedSeconds;
  const ledger = (x, tEnd = null) => {
    const nQb = x.player.movement.qbSuccessfulCount;
    const nBeam = x.recentPlayerShots.filter((r) => r.weapon === 'beam' && r.firedAtSeconds <= x.elapsedSeconds).length;
    const fly = Math.max(0, Math.min(x.elapsedSeconds, tEnd ?? Infinity) - (T + SPEC.flyHold));
    return { nQb, nBeam, fly, en: 180 - 36 * nQb - 8 * nBeam - 20 * fly };
  };
  console.log('        t − T    EN        ledger    nQB nBeam flight s  vMode    hMode       y');
  let worst = 0;
  for (const x of trace) {
    const l = ledger(x);
    worst = Math.max(worst, Math.abs(x.player.en - l.en));
    console.log(`        ${(x.elapsedSeconds - T).toFixed(3)}    ${x.player.en.toFixed(4).padStart(8)}  ${l.en.toFixed(4).padStart(8)}  ${l.nQb}   ${l.nBeam}     ${l.fly.toFixed(3)}     ${x.player.movement.verticalMode.padEnd(8)} ${x.player.movement.horizontalMode.padEnd(10)}  ${x.player.position[1].toFixed(3)}`);
  }
  const lastL = ledger(s);
  const beamTimes = s.recentPlayerShots.filter((r) => r.weapon === 'beam').map((r) => r6(r.firedAtSeconds - T));
  row('M6.ledger', {
    check: 'Q + Space + trigger (beam) pressed in the same frame while gliding: QB 36, each beam 8 and flight 20 EN/s from 0.20 s after the Space press are paid from the same tank; the glide adds nothing',
    where,
    specRef: '§6 §7.4 §11 同時操作',
    input: `at T = ${r6(T)} (gliding at 22 m/s, EN 180): keydown Q, keydown Space, left button down; held for 0.6 s (12 samples of 0.05 s); then all released`,
    measured: { qbStartedAt: s.player.movement.qbLastStartedAtSeconds, beamShotsAtTMinus: beamTimes, flightSeconds: lastL.fly, enAtRelease: s.player.en, ledgerAtRelease: lastL.en, maxDeviationOver12Samples: worst, verticalModes: [...new Set(trace.map((x) => x.player.movement.verticalMode))], height: s.player.position[1] - P[1], glideEnabled: s.player.movement.glideEnabled },
    expected: `EN(t) = 180 − 36·nQB − 8·nBeam(t) − 20·max(0, t − T − 0.20); at release with 1 boost, ${lastL.nBeam} beam shots and 0.40 s of flight: ${lastL.en}`,
    pass: worst < 1e-6 && lastL.nQb === 1 && lastL.nBeam === 3 && Math.abs(lastL.fly - 0.4) < 1e-9 && s.player.movement.qbLastStartedAtSeconds === T && trace.some((x) => x.player.movement.verticalMode === 'flying'),
  });
  note('M6: height reached in the 0.6 s (the mech touched a structure of the dock above the lane at the end; thrust and its EN cost go on)', { yTrace: trace.map((x) => r3(x.player.position[1])) });

  // ── M6b: 44 EN, Q + Space + beam together: QB 36 → beam 8 → nothing left for the flight ──
  s = await resortie(game);
  s = await beamBurst(page, 17); // 180 − 136 = 44 (the trigger stays down)
  const en44 = s.player.en;
  const Tb = s.elapsedSeconds;
  await L.keyDown(page, 'KeyQ');
  await L.keyDown(page, 'Space');
  const tb = [];
  for (let i = 0; i < 10; i++) tb.push((s = await run(page, 1, 6)));
  await L.keyUp(page, 'KeyQ');
  await L.keyUp(page, 'Space');
  await page.mouse.up();
  const beamsB = s.recentPlayerShots.filter((r) => r.weapon === 'beam');
  const afterQ = beamsB.filter((r) => r.firedAtSeconds >= Tb);
  const peak = Math.max(...tb.map((x) => x.player.position[1])) - P[1];
  row('M6.priority', {
    check: '44 EN left, Q + Space pressed with the trigger held: the boost takes 36, the next beam shot the last 8, the flight gets nothing (no thrust, plain jump arc) and EN never goes below 0',
    where,
    specRef: '§6 (QBの開始費用、ビームの発射費用、飛行の連続消費の順)',
    input: `capacity / biped; 17 beam shots → 44 EN, trigger kept down; at T = ${r6(Tb)} keydown Q + keydown Space, held 0.5 s`,
    measured: { enBefore: en44, qbCount: s.player.movement.qbSuccessfulCount, beamShotsAfterQ: afterQ.map((r) => r6(r.firedAtSeconds - Tb)), enTrace: tb.map((x) => x.player.en), minEn: Math.min(...tb.map((x) => x.player.en)), verticalModes: [...new Set(tb.map((x) => x.player.movement.verticalMode))], peakHeightSeen: peak, totalBeamShots: beamsB.length },
    expected: 'EN 44 → 8 (boost) → 0 (one more beam shot) and 0 from then on; exactly 1 beam shot after the Q press (18 in total); verticalMode never flying; height below the 2.78 m of a plain jump',
    pass: en44 === 44 && s.player.movement.qbSuccessfulCount === 1 && afterQ.length === 1 && beamsB.length === 18 && tb.at(-1).player.en === 0 && Math.min(...tb.map((x) => x.player.en)) >= 0 && !tb.some((x) => x.player.movement.verticalMode === 'flying') && peak <= 2.78 + 1e-6,
  });
  // ── no regeneration in the air: one beam shot, then a plain jump that lasts longer than the 0.75 s wait ──
  await L.keyDown(page, 'ControlLeft');
  s = (await runUntil(page, 12, (y) => y.player.grounded && speedH(y) === 0 && y.player.en >= 20, 200)).s;
  await L.keyUp(page, 'ControlLeft');
  await page.mouse.down();
  await L.keyDown(page, 'Space');
  const j0 = await run(page, 1, 1);
  await page.mouse.up();
  await L.keyUp(page, 'Space');
  const tbJ = j0.recentPlayerShots.at(-1).firedAtSeconds;
  const enJ = j0.player.en;
  const jt = [j0];
  for (let i = 0; i < 34; i++) jt.push(await run(page, 1, 6));
  const airLate = jt.filter((y) => !y.player.grounded && y.elapsedSeconds - tbJ >= 0.75 - 1e-9);
  const ground = jt.filter((y) => y.player.grounded && y.elapsedSeconds > tbJ + 0.75);
  const gSlope = ground.length >= 2 ? (ground.at(-1).player.en - ground[1].player.en) / (ground.at(-1).elapsedSeconds - ground[1].elapsedSeconds) : null;
  console.log('        t − t_shot  EN        grounded  vMode     y');
  for (const y of jt.filter((_, i) => i % 2 === 0)) console.log(`        ${(y.elapsedSeconds - tbJ).toFixed(3).padStart(7)}     ${y.player.en.toFixed(4).padStart(8)}  ${String(y.player.grounded).padEnd(5)}     ${y.player.movement.verticalMode.padEnd(8)}  ${y.player.position[1].toFixed(3)}`);
  row('M6.airNoRegen', {
    check: 'a beam shot followed by a plain jump (1.11 s in the air): no regeneration while airborne although 0.75 s have passed since the last spend; it starts on the ground at the build\'s rate',
    where,
    specRef: '§6 (空中では…回復しません)',
    input: `standing; one click (beam, 8 EN) and a Space tap in the same tick at t = ${r6(tbJ - TICK)}; nothing held afterwards; sampled every 0.05 s for 1.7 s`,
    measured: { enAfterShot: enJ, lastEnSpentAtSeconds: jt.at(-1).player.movement.lastEnSpentAtSeconds, airborneSamplesAtOrAfter075s: airLate.map((y) => [r3(y.elapsedSeconds - tbJ), y.player.en]), firstGroundedSample: ground.length ? r3(ground[0].elapsedSeconds - tbJ) : null, verticalModes: [...new Set(jt.map((y) => y.player.movement.verticalMode))], groundSlope: gSlope, enAtEnd: jt.at(-1).player.en },
    expected: `EN stays ${enJ} in every airborne sample (the jump lasts 2·10/18 = 1.11 s, never 'flying'); once grounded +10 EN/s`,
    pass: airLate.length >= 4 && airLate.every((y) => y.player.en === enJ) && !jt.some((y) => y.player.movement.verticalMode === 'flying') && gSlope !== null && Math.abs(gSlope - 10) < 1e-6 && jt.at(-1).player.movement.lastEnSpentAtSeconds === tbJ,
  });
  row('M6.pageErrors', { check: 'M6: no console error / uncaught exception', where, measured: game.errors.slice(0, 3), expected: [], pass: game.errors.length === 0 });
  await game.close();
}

// ───────────────────────────── shot bookkeeping ─────────────────────────────
/** Collects every shot record seen in the snapshots (the game keeps only the last 32). */
class ShotLog {
  constructor() {
    this.byId = new Map();
    this.at = new Map(); // shot id → snapshot taken at the firing instant (elapsedSeconds === firedAtSeconds)
  }
  see(s) {
    for (const r of s.recentPlayerShots) {
      if (!this.byId.has(r.id)) this.byId.set(r.id, r);
      if (r.firedAtSeconds === s.elapsedSeconds && !this.at.has(r.id)) this.at.set(r.id, s);
    }
    return s;
  }
  since(id) {
    return [...this.byId.values()].filter((r) => r.id > id).sort((a, b) => a.id - b.id);
  }
  get lastId() {
    return Math.max(0, ...this.byId.keys());
  }
}
/** Summary of a list of solved machine-gun records against my own solver. */
function summariseMg(records) {
  const checks = records.map(checkMgRecord);
  const max = (k) => Math.max(0, ...checks.map((c) => c[k] ?? 0));
  return {
    n: checks.length,
    allSolvedByMe: checks.every((c) => c.solved),
    maxAngleErrRad: max('angleErr'),
    maxSpeedErr: max('speedErr'),
    maxResidualM: max('residual'),
    maxFlightTimeErr: max('tErr'),
    maxInterceptErr: max('interceptErr'),
    maxDirVsV0: max('dirVsV0'),
    accAll: checks.every((c) => c.accOk),
    ranges: [Math.min(...checks.map((c) => c.range ?? Infinity)), Math.max(...checks.map((c) => c.range ?? 0))],
    targetSpeeds: [Math.min(...checks.map((c) => c.targetSpeed ?? Infinity)), Math.max(...checks.map((c) => c.targetSpeed ?? 0))],
    flight: [Math.min(...checks.map((c) => c.myT ?? Infinity)), Math.max(...checks.map((c) => c.myT ?? 0))],
    checks,
  };
}
const mgOk = (m) => m.n > 0 && m.allSolvedByMe && m.maxAngleErrRad < 1e-9 && m.maxSpeedErr <= 1e-3 && m.maxResidualM <= 0.01 && m.maxFlightTimeErr < 1e-9 && m.accAll && m.maxDirVsV0 < 1e-9;
const mgBrief = (m) => ({ shots: m.n, maxAngleErrRad: m.maxAngleErrRad, maxSpeedErr: m.maxSpeedErr, maxResidualM: m.maxResidualM, maxFlightTimeErr: m.maxFlightTimeErr, rangeM: m.ranges.map(r3), targetSpeed: m.targetSpeeds.map(r3), flightS: m.flight.map(r3), acceleration: m.accAll ? '(0,−18,0) in all' : 'DIFFERS' });
function printMg(m, log) {
  console.log('        id   t        target  range    |v_t|   my t       Δt        angle err   |v0|−100    residual   mech speed  hMode       vMode');
  for (const c of m.checks) {
    const at = log.at.get(c.id);
    console.log(`        ${String(c.id).padStart(3)}  ${c.t.toFixed(4).padStart(7)}  ${String(c.target).padEnd(6)}  ${(c.range ?? 0).toFixed(2).padStart(6)}  ${(c.targetSpeed ?? 0).toFixed(2).padStart(5)}  ${(c.myT ?? 0).toFixed(6)}  ${(c.tErr ?? 0).toExponential(1)}  ${(c.angleErr ?? 0).toExponential(2)}  ${(c.speed - 100).toExponential(1).padStart(9)}  ${(c.residual ?? 0).toExponential(1)}  ${at ? Math.hypot(...at.player.velocity).toFixed(2).padStart(6) : '     –'}      ${at ? at.player.movement.horizontalMode.padEnd(10) : '–'}  ${at ? at.player.movement.verticalMode : '–'}`);
  }
}
/** Muzzle of a shot vs the mech position of the snapshot taken at the firing instant (yaw known from the mouse input). */
function muzzleCheck(log, records, yaw) {
  const off = muzzleOffset(yaw);
  const out = [];
  for (const r of records) {
    const at = log.at.get(r.id);
    if (!at) continue;
    const d = sub(r.muzzlePosition, at.player.position);
    out.push({ id: r.id, err: len(sub(d, off)), mechSpeed: len(at.player.velocity), hMode: at.player.movement.horizontalMode, vMode: at.player.movement.verticalMode, v0: len(r.initialVelocity ?? [0, 0, 0]) });
  }
  return out;
}

// ───────────────────────────── FC: mini stage ─────────────────────────────
async function FC() {
  const where = WHERE_S;
  playSize = [SW, SH];
  const game = await openScripted(browser, { path: L.HARNESS_PATH });
  const page = game.page;
  const g0 = await L.snap(page);
  const posOf = (s, id) => enemyOf(s, id).position;
  note('FC: mini stage of dev/app-test.html (the real App on a small stage)', { enemies: g0.enemies.map((e) => `${e.id}:${e.kind}${e.isGateControl ? '*' : ''}`), sectorCount: g0.stage.sectorCount, start: g0.player.position });

  // ═══ part 1: lock time per FCS × legs, and a distinguishing value of each part in play (L1) ═══
  if ((arg('fc') ? arg('fc').split(',') : ['1', '2', '3']).includes('1')) {
    const builds = [
      { fcs: 'wide', generator: 'capacity', legs: 'biped' },
      { fcs: 'medium', generator: 'balanced', legs: 'biped' },
      { fcs: 'narrow', generator: 'recovery', legs: 'biped' },
      { fcs: 'wide', generator: 'recovery', legs: 'quadruped' },
      { fcs: 'medium', generator: 'capacity', legs: 'quadruped' },
      { fcs: 'narrow', generator: 'balanced', legs: 'quadruped' },
    ];
    for (const b of builds) {
      const e = expectedStats(b);
      const name = `${b.fcs}/${b.generator}/${b.legs}`;
      await L.selectLoadout(page, b);
      let s = await into(page, 'sortie');
      game.yaw = game.pitch = 0;
      const s0 = s;
      let aimed = false;
      if (s.lock.targetId !== 'C01') {
        s = await run(page, 1, 1);
        if (s.lock.targetId !== 'C01') {
          // the target is outside this build's circle at the start view: put it on the centre line
          await aimAt(game, s, posOf(s, 'C01'));
          aimed = true;
          for (let i = 0; i < 4 && s.lock.targetId !== 'C01'; i++) s = await run(page, 1, 1);
        }
      }
      const a = s; // first sample with the target selected
      const nL = ticksOf(e.lockSeconds);
      const mid = await runTicks(page, Math.floor(nL / 2) - Math.round(a.lock.progress * nL));
      const slopeL = (mid.elapsedSeconds - a.elapsedSeconds) / (mid.lock.progress - a.lock.progress); // seconds per unit progress
      const tStart = a.elapsedSeconds - a.lock.progress * slopeL; // when the progress was 0
      const before = await runTo(page, Math.round((tStart + e.lockSeconds) * 120 - 1) / 120);
      const at = await run(page, 1, 1);
      const measured = at.elapsedSeconds - tStart;
      row(`F4.lockTime.${b.fcs}.${b.legs}`, {
        check: `lock time of ${name}: control turret C01 inside the circle, never left`,
        where,
        specRef: '§5 §6',
        input: `mini stage, start position${aimed ? ', view turned onto C01 with the mouse' : ' (no input)'}; lock radius ${r6(at.lock.radiusCssPx)} px at ${page.viewportSize().width}×${page.viewportSize().height}`,
        measured: { acquiringSince: r6(tStart), stateAtT0: s0.lock.state, mid: { t: r6(mid.elapsedSeconds), progress: r6(mid.lock.progress) }, secondsPerUnitProgress: slopeL, oneTickBefore: { t: r6(before.elapsedSeconds), state: before.lock.state, progress: r6(before.lock.progress), fireControl: before.fireControl.status }, atCompletion: { t: r6(at.elapsedSeconds), state: at.lock.state, progress: at.lock.progress, target: at.lock.targetId, fireControl: at.fireControl.status }, lockSeconds: measured, snapshotLockSeconds: at.effectiveStats.lockSeconds },
        expected: `${r6(e.lockSeconds)} s (${FCS[b.fcs][1]} ÷ ${LEGS[b.legs][2]}): 'acquiring' with progress ${r6(1 - TICK / e.lockSeconds)} one tick before, 'locked' with progress 1 and a solved fire-control value at the tick itself; inactive before`,
        pass: Math.abs(measured - e.lockSeconds) < 1e-9 && Math.abs(slopeL - e.lockSeconds) < 1e-9 && before.lock.state === 'acquiring' && before.fireControl.status === 'inactive' && before.fireControl.targetId === null && at.lock.state === 'locked' && at.lock.progress === 1 && at.lock.targetId === 'C01' && at.fireControl.status === 'solved' && Math.abs(at.lock.radiusCssPx - FCS[b.fcs][0] * Math.min(page.viewportSize().width, page.viewportSize().height)) < 1e-9,
      });
      // regeneration slope after two beam shots (16 EN), then walking speed
      await L.tapKey(page, 'Digit2', 20);
      await page.mouse.down();
      s = await run(page, 2, 30);
      await page.mouse.up();
      const beams = s.recentPlayerShots.filter((x) => x.weapon === 'beam');
      const tb = beams.at(-1).firedAtSeconds;
      const r1 = await runTo(page, Math.round((tb + 0.75) * 120) / 120);
      const r2 = await runTicks(page, 60);
      const slope = (r2.player.en - r1.player.en) / (r2.elapsedSeconds - r1.elapsedSeconds);
      await L.keyDown(page, 'KeyD');
      const w1 = await runTicks(page, 24);
      const w2 = await runTicks(page, 36);
      await L.keyUp(page, 'KeyD');
      const walk = hdist(w2.player.position, w1.player.position) / (w2.elapsedSeconds - w1.elapsedSeconds);
      row(`L1.play.${b.fcs}.${b.generator}.${b.legs}`, {
        check: `build ${name} in play: max EN, regeneration slope, walking speed (lock time: row F4.lockTime.${b.fcs}.${b.legs})`,
        where,
        specRef: '§3 §6',
        input: 'mini stage; 2 beam shots (key 2, button held 0.5 s), wait 0.75 s, 0.5 s of regeneration; D held 0.2 s + 0.3 s',
        measured: { enAtSortie: s0.player.en, beamShots: beams.length, enAfterShots: r1.player.en, regenSlope: slope, walkSpeed: walk, loadout: s0.loadout },
        expected: `EN ${e.maxEn} at the sortie, ${e.maxEn - 16} after two shots, +${e.regenPerSecond} EN/s; walking ${10 * e.horizontalSpeedMultiplier} m/s`,
        pass: sameJson(s0.loadout, b) && s0.player.en === e.maxEn && beams.length === 2 && r1.player.en === e.maxEn - 16 && Math.abs(slope - e.regenPerSecond) < 1e-6 && Math.abs(walk - 10 * e.horizontalSpeedMultiplier) < 1e-6,
      });
      await escPause(page);
      await L.toGarage(page);
      lap('FC lock ' + name);
    }
  }

  const parts = arg('fc') ? arg('fc').split(',') : ['1', '2', '3'];
  // ═══ part 2: one long sortie with wide / balanced / biped ═══
  const part2 = async () => {
  const log = new ShotLog();
  const build = { fcs: 'wide', generator: 'balanced', legs: 'biped' };
  await L.selectLoadout(page, build);
  let s = await into(page, 'sortie');
  game.yaw = game.pitch = 0;
  const first0 = s; // the whole snapshot at t = 0 of this sortie (compared with the re-sortie at the end)
  // ── F2a: missile without a completed lock ──
  await L.tapKey(page, 'Digit3', 20);
  await page.mouse.down();
  s = await run(page, 1, 30);
  const hudRefuse = await hudText(page);
  await shot(game, 'FC-missile-refused-1280x720');
  const refused = s;
  await page.mouse.up();
  await L.tapKey(page, 'Digit1', 20);
  row('F2.missileNeedsLock', {
    check: 'missile trigger held while the lock is still being acquired: nothing is launched, no record, ammunition unchanged, the HUD says why',
    where,
    specRef: '§4.1 §8 §11 他の武器のFCS',
    input: 'mini stage, wide / balanced / biped; t = 0: key 3, left button held for 0.25 s (lock on C01 needs 1.2 s)',
    measured: { t: refused.elapsedSeconds, lock: refused.lock, weapon: refused.player.weapon, shotRecords: refused.recentPlayerShots.length, missiles: refused.player.ammo.missile, fireControl: refused.fireControl.status, hudNotice: hudRefuse.notice, hudLockLabel: hudRefuse.lock },
    expected: "lock 'acquiring', 0 shot records, 12 missiles, fireControl inactive; HUD: ロック未完了 — ミサイル発射不可",
    pass: refused.lock.state === 'acquiring' && refused.player.weapon === 'missile' && refused.recentPlayerShots.length === 0 && refused.player.ammo.missile === 12 && refused.fireControl.status === 'inactive' && /ミサイル発射不可/.test((hudRefuse.notice ?? '') + (hudRefuse.lock ?? '')),
  });
  // ── F1: 20 machine-gun shots at the locked control turret C01 ──
  s = (await runUntil(page, 6, (x) => x.lock.state === 'locked', 60)).s;
  const fc0 = s.fireControl;
  const mySol = solveMachineGun(fc0.muzzlePosition, fc0.targetPosition, fc0.targetVelocity);
  row('F1.fireControlValue', {
    check: 'fire-control value shown while locked (machine gun): launch direction, flight time, intercept and aim point equal my own solution of §4.3',
    where,
    specRef: '§4.3 §10',
    input: `lock on C01 complete at t = ${r6(s.elapsedSeconds)}; no shot fired yet`,
    measured: { status: fc0.status, weapon: fc0.weapon, target: fc0.targetId, evaluatedAt: fc0.evaluatedAtSeconds, snapshotT: s.elapsedSeconds, flight: fc0.predictedFlightSeconds, myFlight: mySol.t, angleErrRad: angleBetween(fc0.launchDirection, mySol.dir), interceptErr: len(sub(fc0.predictedInterceptPosition, mySol.intercept)), aimPointErr: len(sub(fc0.aimPoint, mySol.aimPoint)), aimPointAboveIntercept: fc0.aimPoint[1] - fc0.predictedInterceptPosition[1], residual: fc0.residualMeters, muzzleMinusPlayer: sub(fc0.muzzlePosition, s.player.position).map(r6), targetVelocity: fc0.targetVelocity },
    expected: `solved, target C01, evaluated at the snapshot time; t = ${r6(mySol.t)} s; aim point ½·18·t² = ${r6(9 * mySol.t * mySol.t)} m above the predicted hit point; residual ≤ 0.01 m; muzzle = mech + (0.9, 0.75, −0.85); turret velocity (0,0,0)`,
    pass: fc0.status === 'solved' && fc0.targetId === 'C01' && fc0.evaluatedAtSeconds === s.elapsedSeconds && Math.abs(fc0.predictedFlightSeconds - mySol.t) < 1e-9 && angleBetween(fc0.launchDirection, mySol.dir) < 1e-9 && len(sub(fc0.aimPoint, mySol.aimPoint)) < 1e-6 && Math.abs(fc0.aimPoint[1] - fc0.predictedInterceptPosition[1] - 9 * mySol.t * mySol.t) < 1e-9 && fc0.residualMeters <= 0.01 && len(sub(sub(fc0.muzzlePosition, s.player.position), muzzleOffset(0))) < 1e-9 && len(fc0.targetVelocity) === 0,
  });
  await shot(game, 'FC-locked-C01-1280x720');
  await page.mouse.down();
  const hpTrace = [];
  const f1 = [log.see(await run(page, 1, 1))];
  for (let i = 0; i < 19; i++) f1.push(log.see(await run(page, 1, 12)));
  await page.mouse.up();
  for (let i = 0; i < 6; i++) f1.push(log.see(await run(page, 1, 12)));
  for (const x of f1) hpTrace.push([r6(x.elapsedSeconds), enemyOf(x, 'C01').hp]);
  s = f1.at(-1);
  const recs1 = log.since(0).filter((r) => r.weapon === 'machinegun');
  const m1 = summariseMg(recs1.filter((r) => r.solutionStatus === 'solved'));
  printMg(m1, log);
  const hits1 = (240 - enemyOf(s, 'C01').hp) / 12;
  const steps1 = hpTrace.slice(1).map((h, i) => hpTrace[i][1] - h[1]).filter((d) => d !== 0);
  const gaps1 = recs1.slice(1).map((r, i) => r6(r.firedAtSeconds - recs1[i].firedAtSeconds));
  row('F1.turret.solver', {
    check: 'machine gun, 20 shots at the locked control turret C01 (mini stage): every record equals my own solution of §4.3',
    where,
    specRef: '§4.3 §10 §11 マシンガンのFCS',
    input: 'left button held for 1 tick + 19 frames of 0.1 s (one shot per frame), standing at the start position',
    measured: { records: recs1.length, solved: m1.n, targets: [...new Set(recs1.map((r) => r.targetId))], cadence: [...new Set(gaps1)], ...mgBrief(m1), ammo: s.player.ammo.machinegun },
    expected: '20 records, all solved on C01, 0.10 s apart; launch direction = mine (angle error < 1e-9 rad); |v0| = 100 ± 0.001 m/s; acceleration (0, −18, 0); residual ≤ 0.01 m; ammunition 280',
    pass: recs1.length === 20 && m1.n === 20 && recs1.every((r) => r.targetId === 'C01') && gaps1.every((g) => Math.abs(g - 0.1) < 1e-9) && mgOk(m1) && s.player.ammo.machinegun === 280,
  });
  row('F1.turret.hits', {
    check: 'those 20 bullets really hit: C01 loses 12 HP per bullet and is destroyed by the 20th',
    where,
    specRef: '§4.1 §4.5 §11',
    input: 'same 20 shots; turret HP sampled every 0.1 s',
    measured: { hits: hits1, hpSteps: steps1, hpTrace: hpTrace.filter((h, i) => i === 0 || h[1] !== hpTrace[i - 1][1]), alive: enemyOf(s, 'C01').alive },
    expected: '20 hits of 12 (HP 240 → 0), alive = false',
    pass: hits1 === 20 && enemyOf(s, 'C01').alive === false && steps1.every((d) => d % 12 === 0 && d > 0),
  });
  const dead = f1.find((x) => !enemyOf(x, 'C01').alive);
  const hud1 = await hudText(page);
  await shot(game, 'FC-C01-destroyed-1280x720');
  row('F4.lost.destroyed', {
    check: 'the locked target is destroyed → lock and fire-control value are dropped at once; the next target starts from 0',
    where,
    specRef: '§5 §10',
    input: 'first snapshot in which C01 is not alive (0.1 s sampling)',
    measured: { t: dead.elapsedSeconds, lock: dead.lock, fireControl: { status: dead.fireControl.status, targetId: dead.fireControl.targetId, muzzlePosition: dead.fireControl.muzzlePosition, launchDirection: dead.fireControl.launchDirection, residualMeters: dead.fireControl.residualMeters } },
    expected: "lock target ≠ C01 (none, or C02 'acquiring' with progress < 0.1 s / 1.2 s); fireControl inactive with nulls",
    pass: dead.lock.targetId !== 'C01' && dead.lock.state !== 'locked' && dead.lock.progress <= 0.1 / 1.2 + 1e-9 && dead.fireControl.status === 'inactive' && dead.fireControl.targetId === null && dead.fireControl.muzzlePosition === null && dead.fireControl.launchDirection === null && dead.fireControl.residualMeters === null,
  });
  row('P1.mini.firstBarrier', {
    check: 'mini stage: control turret C01 destroyed → controlsDestroyed 1, barrier B1 open, gate still closed; HUD shows it',
    where,
    specRef: '§2.1 §8',
    input: 'state 0.6 s after the 20th shot',
    measured: { objective: s.objective, hudTopRight: hud1.topRight, hudTopCenter: hud1.topCenter },
    expected: 'controlsDestroyed 1, openBarrierIds ["B1"], gateOpen false; HUD 1/6',
    pass: s.objective.controlsDestroyed === 1 && sameJson(s.objective.openBarrierIds, ['B1']) && s.objective.gateOpen === false && /1\s*\/\s*6/.test(hud1.topRight ?? ''),
  });

  // ── F2b: beam at the locked turret C02 ──
  s = (await runUntil(page, 6, (x) => x.lock.state === 'locked' && x.lock.targetId === 'C02', 80)).s;
  await L.tapKey(page, 'Digit2', 20);
  const bBefore = s;
  await page.mouse.down();
  const bAfter = log.see(await run(page, 1, 1));
  await page.mouse.up();
  const beamRec = bAfter.recentPlayerShots.at(-1);
  const beamDir = unit(sub(beamRec.targetPositionAtFire ?? [0, 0, 1], beamRec.muzzlePosition));
  const fcB = bAfter.fireControl;
  row('F2.beam', {
    check: 'beam at the locked turret C02: aimed at the current centre, hit in the firing update (flight 0), 40 HP, 8 EN',
    where,
    specRef: '§4.1 §4.4 §11 他の武器のFCS',
    input: `key 2, one click (button down for 1 tick) at t = ${r6(bBefore.elapsedSeconds)}; C02 is ${r3(len(sub(posOf(bBefore, 'C02'), bBefore.player.position)))} m away`,
    measured: { record: { weapon: beamRec.weapon, target: beamRec.targetId, status: beamRec.solutionStatus, firedAt: beamRec.firedAtSeconds, flight: beamRec.predictedFlightSeconds, initialVelocity: beamRec.initialVelocity, acceleration: beamRec.accelerationAtFire, angleToMyDirRad: angleBetween(beamRec.launchDirection, beamDir), interceptMinusTarget: len(sub(beamRec.predictedInterceptPosition ?? [0, 0, 0], beamRec.targetPositionAtFire ?? [9, 9, 9])) }, snapshotT: bAfter.elapsedSeconds, hp: [enemyOf(bBefore, 'C02').hp, enemyOf(bAfter, 'C02').hp], en: [bBefore.player.en, bAfter.player.en], fireControl: { weapon: fcB.weapon, status: fcB.status, flight: fcB.predictedFlightSeconds, residual: fcB.residualMeters }, mgAmmo: bAfter.player.ammo.machinegun },
    expected: 'record: beam, C02, solved, flight 0, initialVelocity null, acceleration (0,0,0), direction = normalize(p − m); HP 240 → 200 in the same snapshot as the shot; EN −8; fireControl flight 0, residual 0',
    pass: beamRec.weapon === 'beam' && beamRec.targetId === 'C02' && beamRec.solutionStatus === 'solved' && beamRec.firedAtSeconds === bAfter.elapsedSeconds && beamRec.predictedFlightSeconds === 0 && beamRec.initialVelocity === null && sameJson(beamRec.accelerationAtFire, [0, 0, 0]) && angleBetween(beamRec.launchDirection, beamDir) < 1e-9 && enemyOf(bBefore, 'C02').hp === 240 && enemyOf(bAfter, 'C02').hp === 200 && Math.abs(bBefore.player.en - bAfter.player.en - 8) < 1e-9 && fcB.weapon === 'beam' && fcB.status === 'solved' && fcB.predictedFlightSeconds === 0 && fcB.residualMeters === 0,
  });
  // ── F2c: missile with a completed lock (static target: the lead direction is the direct line) ──
  await L.tapKey(page, 'Digit3', 20);
  await page.mouse.down();
  const mAfter = log.see(await run(page, 1, 1));
  await page.mouse.up();
  const mRec = mAfter.recentPlayerShots.at(-1);
  const mSol = solveMissile(mRec.muzzlePosition, mRec.targetPositionAtFire ?? [0, 0, 0], mRec.targetVelocityAtFire ?? [0, 0, 0]);
  let hitAt = null;
  let prevT = mAfter.elapsedSeconds;
  let x = mAfter;
  for (let i = 0; i < 60 && hitAt === null; i++) {
    x = log.see(await run(page, 1, 3));
    if (enemyOf(x, 'C02').hp < 200) hitAt = [prevT, x.elapsedSeconds];
    prevT = x.elapsedSeconds;
  }
  row('F2.missile.static', {
    check: 'missile with a completed lock on the turret C02: launched, 45 m/s along my §4.4 direction, hits for 180',
    where,
    specRef: '§4.1 §4.4 §11 他の武器のFCS',
    input: `key 3, one click at t = ${r6(mRec.firedAtSeconds)}`,
    measured: { record: { weapon: mRec.weapon, target: mRec.targetId, status: mRec.solutionStatus, speed: len(mRec.initialVelocity ?? [0, 0, 0]), acceleration: mRec.accelerationAtFire, angleToMyDirRad: angleBetween(mRec.launchDirection, mSol.dir), flight: mRec.predictedFlightSeconds, myFlight: mSol.t }, missiles: mAfter.player.ammo.missile, hpAfter: enemyOf(x, 'C02').hp, hitBetween: hitAt ? hitAt.map((t) => r6(t - mRec.firedAtSeconds)) : null },
    expected: `record: missile, C02, solved, |v0| = 45, acceleration (0,0,0), direction and flight time = mine (${r6(mSol.t)} s to the centre); 11 missiles left; HP 200 → 20 about (range − 1.4 m)/45 s after launch`,
    pass: mRec.weapon === 'missile' && mRec.targetId === 'C02' && mRec.solutionStatus === 'solved' && Math.abs(len(mRec.initialVelocity) - 45) < 1e-9 && sameJson(mRec.accelerationAtFire, [0, 0, 0]) && angleBetween(mRec.launchDirection, mSol.dir) < 1e-9 && Math.abs(mRec.predictedFlightSeconds - mSol.t) < 1e-9 && mAfter.player.ammo.missile === 11 && enemyOf(x, 'C02').hp === 20 && hitAt !== null && hitAt[0] - mRec.firedAtSeconds <= mSol.t && hitAt[1] - mRec.firedAtSeconds >= mSol.t - 0.1,
  });
  // finish C02 with the machine gun
  await L.tapKey(page, 'Digit1', 20);
  await page.mouse.down();
  s = (await runUntil(page, 12, (y) => !enemyOf(y, 'C02').alive, 40, (y) => log.see(y))).s;
  await page.mouse.up();

  // ── F3: firing while gliding / flying / boosting, target C03 (static) ──
  await L.keyDown(page, 'KeyD');
  s = (await runUntil(page, 6, (y) => y.player.position[0] >= 3.6, 40, (y) => log.see(y))).s;
  await L.keyUp(page, 'KeyD');
  s = (await runUntil(page, 6, (y) => y.lock.state === 'locked' && speedH(y) === 0, 80, (y) => log.see(y))).s;
  const f3 = {};
  const hpOf = (y) => Object.fromEntries(y.enemies.filter((e) => e.isGateControl).map((e) => [e.id, e.hp]));
  const hp3a = hpOf(s);
  // glide
  let mark = log.lastId;
  await page.mouse.down();
  await L.tapKey(page, 'ShiftLeft', 20);
  log.see(await run(page, 1, 1));
  for (let i = 0; i < 6; i++) log.see(await run(page, 1, 12));
  await page.mouse.up();
  f3.glide = log.since(mark);
  await L.keyDown(page, 'ControlLeft');
  for (let i = 0; i < 4; i++) log.see(await run(page, 1, 12));
  await L.keyUp(page, 'ControlLeft');
  s = (await runUntil(page, 6, (y) => y.lock.state === 'locked' && speedH(y) === 0, 80, (y) => log.see(y))).s;
  // flight
  mark = log.lastId;
  await page.mouse.down();
  await L.keyDown(page, 'Space');
  log.see(await run(page, 1, 1));
  for (let i = 0; i < 7; i++) log.see(await run(page, 1, 12));
  await page.mouse.up();
  await L.keyUp(page, 'Space');
  f3.flight = log.since(mark);
  s = (await runUntil(page, 12, (y) => y.player.grounded, 60, (y) => log.see(y))).s;
  // back towards the start for the boost run
  await L.keyDown(page, 'KeyS');
  s = (await runUntil(page, 6, (y) => y.player.position[2] >= 4.5, 200, (y) => log.see(y))).s;
  await L.keyUp(page, 'KeyS');
  s = (await runUntil(page, 6, (y) => y.lock.state === 'locked' && speedH(y) === 0 && y.player.en >= 36, 120, (y) => log.see(y))).s;
  mark = log.lastId;
  await page.mouse.down();
  await L.keyDown(page, 'KeyQ');
  log.see(await run(page, 1, 1));
  await L.keyUp(page, 'KeyQ');
  for (let i = 0; i < 3; i++) log.see(await run(page, 1, 12));
  await page.mouse.up();
  f3.qb = log.since(mark);
  await L.keyDown(page, 'ControlLeft');
  for (let i = 0; i < 8; i++) log.see(await run(page, 1, 12));
  await L.keyUp(page, 'ControlLeft');
  for (let i = 0; i < 6; i++) s = log.see(await run(page, 1, 12)); // let the last bullets land
  const hp3b = hpOf(s);
  const f3solved = [...f3.glide, ...f3.flight, ...f3.qb].filter((r) => r.weapon === 'machinegun' && r.solutionStatus === 'solved');
  const f3hits = Object.keys(hp3a).reduce((n, id) => n + (hp3a[id] - hp3b[id]) / 12, 0);
  for (const [name, wantMode] of [['glide', (c) => c.hMode === 'glide' && c.mechSpeed > 1], ['flight', (c) => c.vMode === 'flying'], ['qb', (c) => c.hMode === 'quickboost']]) {
    const recs = f3[name].filter((r) => r.weapon === 'machinegun' && r.solutionStatus === 'solved');
    const m = summariseMg(recs);
    printMg(m, log);
    const mz = muzzleCheck(log, recs, game.yaw);
    const inMode = mz.filter(wantMode);
    row(`F3.${name}`, {
      check: `machine gun fired while ${name === 'qb' ? 'boosting (quick-boost impulse and the inertia after it)' : name === 'flight' ? 'jumping / flying (Space held)' : 'gliding'}: muzzle = mech position of that instant + muzzle offset; |v0| = 100 with nothing of the mech's velocity; direction = my solution`,
      where,
      specRef: '§4.1 §4.2 §11 移動しながらの射撃',
      input: name === 'glide' ? 'locked on a control turret; left button down + Shift tap, 1 tick + 6 frames of 0.1 s' : name === 'flight' ? 'left button down + Space held, 1 tick + 7 frames of 0.1 s' : 'left button down + Q tap, 1 tick + 3 frames of 0.1 s',
      measured: { ...mgBrief(m), targets: [...new Set(recs.map((r) => r.targetId))], shotsWithSnapshotAtFiringInstant: mz.length, maxMuzzleOffsetErrM: Math.max(0, ...mz.map((c) => c.err)), mechSpeedAtShots: mz.map((c) => r3(c.mechSpeed)), modesAtShots: mz.map((c) => `${c.hMode}/${c.vMode}`), shotsInTheNamedState: inMode.length },
      expected: `every record: muzzle − mech position = (0.9, 0.75, −0.85) (yaw 0) to 1e-9 m at the firing instant, |v0| = 100 ± 0.001, direction = mine (< 1e-9 rad), residual ≤ 0.01 m; at least ${name === 'qb' ? 2 : 3} shots in the named state`,
      pass: mgOk(m) && mz.length === recs.length && mz.every((c) => c.err < 1e-9) && inMode.length >= (name === 'qb' ? 2 : 3),
    });
  }
  row('F3.hits', {
    check: 'the bullets fired while moving hit their (static) targets',
    where,
    specRef: '§4.5 §11 移動しながらの射撃',
    input: 'the three runs above',
    measured: { solvedShots: f3solved.length, hpBefore: hp3a, hpAfter: hp3b, hits: f3hits },
    expected: 'hits = solved shots (12 HP each)',
    pass: f3solved.length > 0 && f3hits === f3solved.length,
  });

  // ── P1 (mini): the remaining control turrets, barriers in order, final gate ──
  const events = [];
  let lastN = s.objective.controlsDestroyed;
  const onObjective = (y) => {
    log.see(y);
    if (y.objective.controlsDestroyed !== lastN) {
      lastN = y.objective.controlsDestroyed;
      events.push({ t: r6(y.elapsedSeconds), n: lastN, open: [...y.objective.openBarrierIds], gateOpen: y.objective.gateOpen });
    }
  };
  // finish the turret the F3 shots were fired at, then go back behind the cover wall of the start room (the
  // control turrets are real turrets: 2 × 40 HP every 1.6 s for as long as they see the mech)
  await page.mouse.down();
  s = (await runUntil(page, 6, (y) => y.objective.controlsDestroyed >= 3, 80, onObjective)).s;
  await page.mouse.up();
  await L.keyDown(page, 'KeyS');
  s = (await runUntil(page, 6, (y) => y.player.position[2] >= -0.3, 200, onObjective)).s;
  await L.keyUp(page, 'KeyS');
  await L.keyDown(page, 'KeyA');
  s = (await runUntil(page, 3, (y) => y.player.position[0] <= 0.2, 80, onObjective)).s;
  await L.keyUp(page, 'KeyA');
  note('FC: back behind the cover wall after the moving-fire runs', { position: s.player.position.map(r3), hp: s.player.hp, t: r6(s.elapsedSeconds), controlsDestroyed: s.objective.controlsDestroyed });
  await page.mouse.down();
  s = (
    await runUntil(page, 30, (y) => y.objective.controlsDestroyed >= 6, 360, onObjective)
  ).s;
  await page.mouse.up();
  const hud6 = await hudText(page);
  await shot(game, 'FC-gate-open-1280x720');
  const allMg = summariseMg(log.since(0).filter((r) => r.weapon === 'machinegun' && r.solutionStatus === 'solved'));
  row('P1.mini.controls', {
    check: 'mini stage: the six control turrets destroyed one after the other; each opens its own barrier; the gate opens with the sixth and not before',
    where,
    specRef: '§2.1 §11 進行',
    input: 'machine-gun trigger held (0.25 s frames) until controlsDestroyed = 6',
    measured: { events, objective: s.objective, controlsAlive: s.enemies.filter((e) => e.isGateControl && e.alive).map((e) => e.id), hudTopRight: hud6.topRight, hudTopCenter: hud6.topCenter, hp: s.player.hp, t: s.elapsedSeconds },
    expected: 'openBarrierIds grows B1 … B6 in order, one per destroyed control turret; gateOpen false up to 5, true at 6; HUD 6/6 and the gate reported open',
    pass: s.objective.controlsDestroyed === 6 && sameJson(s.objective.openBarrierIds, ['B1', 'B2', 'B3', 'B4', 'B5', 'B6']) && s.objective.gateOpen === true && events.length >= 4 && events.every((e) => e.open.length === e.n && sameJson(e.open, ['B1', 'B2', 'B3', 'B4', 'B5', 'B6'].slice(0, e.n)) && e.gateOpen === (e.n === 6)) && /6\s*\/\s*6/.test(hud6.topRight ?? ''),
  });
  row('F1.mini.allSolvedShots', {
    check: 'every FCS-corrected machine-gun record of this sortie (all six turrets, standing and moving) against my solver',
    where,
    specRef: '§4.3 §10',
    input: 'all machine-gun records with solutionStatus solved collected during the sortie',
    measured: mgBrief(allMg),
    expected: 'angle error < 1e-9 rad, |v0| = 100 ± 0.001, residual ≤ 0.01 m, acceleration (0, −18, 0)',
    pass: mgOk(allMg),
  });

  // ── M2 (biped): Q tap, nothing held, 3 s of glide on the now free corridor ──
  await L.keyDown(page, 'KeyD');
  s = (await runUntil(page, 6, (y) => y.player.position[0] >= 3.6, 60)).s;
  await L.keyUp(page, 'KeyD');
  await L.keyDown(page, 'KeyS');
  s = (await runUntil(page, 6, (y) => y.player.position[2] >= 4.5, 300)).s;
  await L.keyUp(page, 'KeyS');
  await L.keyDown(page, 'ControlLeft');
  s = (await runUntil(page, 12, (y) => speedH(y) === 0 && y.player.en >= 120 && !y.player.movement.glideEnabled, 160)).s;
  await L.keyUp(page, 'ControlLeft');
  s = await run(page, 1, 12);
  note('M2b: start of the run', { position: s.player.position, en: s.player.en, glideEnabled: s.player.movement.glideEnabled, t: s.elapsedSeconds });
  const rr = await releaseRun(game, 'M2b', 'biped', where, `mini stage after the six control turrets (corridor free for 130 m), from z = ${s.player.position[2].toFixed(2)} looking −Z`);
  // ── P1 (mini): through the open gate into the exit zone ──
  const endRun = rr.trace.at(-1);
  const cl = await runUntil(page, 6, (y) => y.state !== 'playing', 200);
  s = cl.s;
  await L.waitFrames(page, 3);
  const ui = await L.evaluate(page, () => ({ title: document.querySelector('.res-title')?.textContent ?? null, sub: document.querySelector('.res-sub')?.textContent ?? null, pips: document.querySelectorAll('.res-pips i.on').length, locked: document.pointerLockElement !== null, restart: !!document.querySelector('[data-act="restart"]'), garage: !!document.querySelector('[data-act="garage"]') }));
  await shot(game, 'FC-cleared-1280x720');
  const frozenA = await L.snap(page);
  await run(page, 4, 30);
  const frozenB = await L.snap(page);
  row('P1.mini.cleared', {
    check: "mini stage: with all six destroyed the mech glides through the open gate into the exit zone → 'cleared'; result screen; nothing advances afterwards",
    where,
    specRef: '§2.1 §9 §11 進行',
    input: `no key held (the glide of the M2 run continues from z = ${endRun.player.position[2].toFixed(1)}); after the result 4 more frames of 0.25 s`,
    measured: { state: s.state, position: s.player.position, hp: s.player.hp, t: s.elapsedSeconds, sector: s.stage.currentSectorId, visited: s.stage.visitedSectorIds, result: ui, frozen: sameJson(frozenA, frozenB) },
    expected: "state 'cleared' inside the exit zone (z ≤ −132), HP > 0; MISSION CLEAR with re-sortie and garage buttons, pointer released; snapshot unchanged by further frames",
    pass: s.state === 'cleared' && s.player.position[2] <= -132 + 1.3 && s.player.hp > 0 && ui.title === 'MISSION CLEAR' && ui.pips === 6 && !ui.locked && ui.restart && ui.garage && sameJson(frozenA, frozenB),
  });
  // ── §9: re-sortie = the first sortie ──
  const again = await into(page, 'restart');
  game.yaw = game.pitch = 0;
  const d = diffPaths(first0, again);
  row('P1.mini.resortieAfterClear', {
    check: 're-sortie after the clear: the whole snapshot at t = 0 is identical to the t = 0 snapshot of the first sortie (position, velocity, HP, EN, ammunition, 10 enemies, barriers, gate, lock, shots, timers, sectors)',
    where,
    specRef: '§9 再出撃',
    input: 'result screen → 同じ構成で再出撃 (real click)',
    measured: { identical: d.length === 0, differences: d, t: again.elapsedSeconds, en: again.player.en, ammo: again.player.ammo, objective: again.objective, shots: again.recentPlayerShots.length, enemiesAlive: again.enemies.filter((e) => e.alive).length },
    expected: 'identical JSON (every field)',
    pass: d.length === 0 && again.elapsedSeconds === 0 && again.state === 'playing',
  });
  await escPause(page);
  await L.toGarage(page);

  };
  // ═══ part 3: lock loss (medium / balanced / biped) ═══
  const part3 = async () => {
  let s;
  await L.selectLoadout(page, { fcs: 'medium', generator: 'balanced', legs: 'biped' });
  s = await into(page, 'sortie');
  game.yaw = game.pitch = 0;
  s = (await runUntil(page, 6, (y) => y.lock.state === 'locked', 60)).s;
  // weapon switch keeps target and progress
  await L.tapKey(page, 'Digit2', 20);
  const sw2 = await run(page, 1, 1);
  await L.tapKey(page, 'Digit3', 20);
  const sw3 = await run(page, 1, 1);
  await L.tapKey(page, 'Digit1', 20);
  const sw1 = await run(page, 1, 1);
  const mslSol = solveMissile(sw3.fireControl.muzzlePosition, sw3.fireControl.targetPosition, sw3.fireControl.targetVelocity);
  row('F4.weaponSwitchKeepsLock', {
    check: 'switching weapons with a completed lock keeps target and progress; the fire-control value follows the weapon at once',
    where,
    specRef: '§4.2 §5',
    input: 'locked on C01; keys 2, 3, 1 one tick apart',
    measured: [sw2, sw3, sw1].map((y) => ({ weapon: y.player.weapon, lock: y.lock.state, target: y.lock.targetId, progress: y.lock.progress, fc: y.fireControl.status, fcWeapon: y.fireControl.weapon, flight: r6(y.fireControl.predictedFlightSeconds) })),
    expected: `locked / C01 / progress 1 throughout; beam: flight 0; missile: flight = range/45 = ${r6(mslSol.t)}; machine gun: gravity solution`,
    pass: [sw2, sw3, sw1].every((y) => y.lock.state === 'locked' && y.lock.targetId === 'C01' && y.lock.progress === 1 && y.fireControl.status === 'solved') && sw2.fireControl.weapon === 'beam' && sw2.fireControl.predictedFlightSeconds === 0 && sw3.fireControl.weapon === 'missile' && Math.abs(sw3.fireControl.predictedFlightSeconds - mslSol.t) < 1e-9 && sw1.fireControl.weapon === 'machinegun',
  });
  // (i) the target leaves the circle
  await turn(game, 300, 0);
  const out1 = await run(page, 1, 1);
  await turn(game, -300, 0);
  const back1 = await run(page, 1, 1); // the target is inside again: progress 0 at this tick
  const back2 = await runTicks(page, 48); // 0.4 s later
  const back2b = await runTicks(page, 47); // one tick before 0.8 s
  const back3 = await run(page, 1, 1); // 0.8 s after it came back
  const inactiveNulls = (fc) => fc.status === 'inactive' && ['targetId', 'evaluatedAtSeconds', 'muzzlePosition', 'targetPosition', 'targetVelocity', 'launchDirection', 'predictedFlightSeconds', 'predictedInterceptPosition', 'aimPoint', 'residualMeters'].every((k) => fc[k] === null);
  row('F4.lost.leftCircle', {
    check: 'the view is turned so that the locked target leaves the circle → lock and fire-control value dropped in the next update; turning back starts again from 0',
    where,
    specRef: '§5 §10',
    input: `locked on C01 (medium FCS, radius ${r6(back3.lock.radiusCssPx)} px at ${page.viewportSize().width}×${page.viewportSize().height}); mouse 300 px right (0.66 rad), 1 tick; 300 px left, 1 tick (t_back), then samples 0.4 s, 0.8 s − 1 tick and 0.8 s after t_back`,
    measured: { afterTurnAway: { lock: out1.lock, fcInactiveWithNulls: inactiveNulls(out1.fireControl) }, atTBack: { t: r6(back1.elapsedSeconds), state: back1.lock.state, target: back1.lock.targetId, progress: r6(back1.lock.progress) }, after0_4s: { state: back2.lock.state, progress: r6(back2.lock.progress) }, oneTickBefore0_8s: { state: back2b.lock.state, progress: r6(back2b.lock.progress), fireControl: back2b.fireControl.status }, after0_8s: { t: r6(back3.elapsedSeconds), state: back3.lock.state, progress: back3.lock.progress, fireControl: back3.fireControl.status } },
    expected: "away: state 'none', target null, progress 0, fireControl inactive with every field null; back: 'acquiring' C01 from progress 0 (nothing carried over), 0.5 after 0.4 s, still acquiring one tick before 0.8 s, 'locked' and solved exactly 0.8 s after it came back",
    pass: out1.lock.state === 'none' && out1.lock.targetId === null && out1.lock.progress === 0 && inactiveNulls(out1.fireControl) && back1.lock.state === 'acquiring' && back1.lock.targetId === 'C01' && back1.lock.progress === 0 && Math.abs(back2.lock.progress - 0.5) < 1e-9 && back2.lock.state === 'acquiring' && back2b.lock.state === 'acquiring' && back2b.fireControl.status === 'inactive' && back3.lock.state === 'locked' && back3.fireControl.status === 'solved',
  });
  // (ii) the target goes behind cover for the gun (the camera still sees it over the 3 m wall)
  s = (await runUntil(page, 6, (y) => y.lock.state === 'locked', 60)).s;
  await L.keyDown(page, 'KeyA');
  const cov = [s];
  for (let i = 0; i < 24 && cov.at(-1).lock.state === 'locked'; i++) cov.push(await run(page, 1, 1));
  await L.keyUp(page, 'KeyA');
  const lost = cov.at(-1);
  const prev = cov.at(-2);
  // my own geometry: segment muzzle → target centre against the cover wall box x −8..0.45, y 0..3, z −3.5..−2.5 (dev/app-test-stage.ts)
  const blocked = (y) => {
    const m = add(y.player.position, muzzleOffset(0));
    const t = posOf(y, 'C01');
    for (let i = 0; i <= 2000; i++) {
      const u = i / 2000;
      const p = add(m, mul(sub(t, m), u));
      if (p[0] >= -8 && p[0] <= 0.45 && p[1] >= 0 && p[1] <= 3 && p[2] >= -3.5 && p[2] <= -2.5) return true;
    }
    return false;
  };
  row('F4.lost.cover', {
    check: 'the mech steps sideways until the wall is between its muzzle and the target centre (the camera still sees the target over the wall) → lock and fire-control value dropped',
    where,
    specRef: '§5 (カメラおよび銃口の双方から)',
    input: 'locked on C01; A held, sampled every tick',
    measured: { ticks: cov.length - 1, lastLocked: { x: r6(prev.player.position[0]), muzzleLineBlockedByMyGeometry: blocked(prev), lock: prev.lock.state }, firstLost: { x: r6(lost.player.position[0]), muzzleLineBlockedByMyGeometry: blocked(lost), lock: lost.lock, fcInactiveWithNulls: inactiveNulls(lost.fireControl) } },
    expected: 'still locked while my segment test muzzle → target is clear; lost in the first sample in which it crosses the wall (x of the mech ≈ −0.38)',
    pass: lost.lock.state !== 'locked' && lost.lock.progress === 0 && lost.lock.targetId === null && inactiveNulls(lost.fireControl) && blocked(lost) && !blocked(prev),
  });
  };
  if (parts.includes('2')) await part2();
  if (parts.includes('3')) await part3();
  note('F4: "target beyond 120 m" cannot be produced on the mini stage (longest sight line 113 m) and was not reached on the factory stage in the browser; see notVerified');
  row('FC.pageErrors', { check: 'FC: no console error / uncaught exception', where, measured: game.errors.slice(0, 3), expected: [], pass: game.errors.length === 0 });
  await game.close();
}

// ───────────────────────────── PM: mini stage, failures and the yard fight ─────────────────────────────
async function PM() {
  const where = WHERE_S;
  playSize = [SW, SH];
  const game = await openScripted(browser, { path: L.HARNESS_PATH });
  const page = game.page;
  const build = { fcs: 'wide', generator: 'recovery', legs: 'quadruped' };
  await L.selectLoadout(page, build);
  let s = await into(page, 'sortie');
  const first0 = s;
  const resultUi = () => L.evaluate(page, () => ({ title: document.querySelector('.res-title')?.textContent ?? null, sub: document.querySelector('.res-sub')?.textContent ?? null, locked: document.pointerLockElement !== null, restart: !!document.querySelector('[data-act="restart"]'), garage: !!document.querySelector('[data-act="garage"]') }));
  // ── fall ──
  await L.keyDown(page, 'KeyS');
  const fell = (await runUntil(page, 30, (y) => y.state !== 'playing', 60)).s;
  await L.keyUp(page, 'KeyS');
  await L.waitFrames(page, 3);
  const uiFell = await resultUi();
  await shot(game, 'PM-failed-fell-1280x720');
  const fa = await L.snap(page);
  await run(page, 4, 30);
  const fb = await L.snap(page);
  row('P1.mini.fell', {
    check: "mini stage: walking backwards off the floor → falls out of the stage → 'failed'; result screen; nothing advances",
    where,
    specRef: '§9 §11 進行',
    input: 'S held from the start (the floor ends 8 m behind it)',
    measured: { state: fell.state, y: fell.player.position[1], hp: fell.player.hp, t: fell.elapsedSeconds, result: uiFell, frozen: sameJson(fa, fb) },
    expected: "state 'failed' below the stage (killY −15), HP still 1000; MISSION FAILED / ステージ外へ落下 with re-sortie and garage buttons; snapshot unchanged by further frames",
    pass: fell.state === 'failed' && fell.player.position[1] < -15 && fell.player.hp === 1000 && uiFell.title === 'MISSION FAILED' && /落下/.test(uiFell.sub ?? '') && uiFell.restart && uiFell.garage && !uiFell.locked && sameJson(fa, fb),
  });
  await L.keyUp(page, 'KeyS');
  s = await into(page, 'restart');
  let d = diffPaths(first0, s);
  row('P1.mini.resortieAfterFall', {
    check: 're-sortie after the fall: whole t = 0 snapshot identical to the first sortie',
    where,
    specRef: '§9 再出撃',
    input: 'result screen → 同じ構成で再出撃',
    measured: { identical: d.length === 0, differences: d },
    expected: 'identical JSON',
    pass: d.length === 0,
  });
  // ── a closed barrier is solid: touching it clears nothing ──
  await L.keyDown(page, 'KeyD');
  await runTicks(page, 48);
  await L.keyUp(page, 'KeyD');
  await L.keyDown(page, 'KeyW');
  const wall = await runTicks(page, 480);
  const wall2 = await runTicks(page, 60);
  await L.keyUp(page, 'KeyW');
  row('P1.mini.closedBarrier', {
    check: 'walking into the closed barrier B1 for 0.5 s more: the mech is stopped in front of it, nothing opens, no clear',
    where,
    specRef: '§2.1 (未開放ゲートへの接触だけでクリア扱いにしてはいけません)',
    input: 'D 0.4 s (around the cover wall), W held 4.5 s (barrier B1 at z −26…−25)',
    measured: { z: [wall.player.position[2], wall2.player.position[2]], x: wall2.player.position[0], state: wall2.state, objective: wall2.objective, hp: wall2.player.hp, sector: wall2.stage.currentSectorId },
    expected: 'z stays at −25 + 1.3 = −23.7 (± skin), state playing, 0 controls, no barrier open',
    pass: wall2.state === 'playing' && Math.abs(wall2.player.position[2] - -23.7) < 0.02 && Math.abs(wall.player.position[2] - wall2.player.position[2]) < 1e-9 && wall2.objective.controlsDestroyed === 0 && wall2.objective.openBarrierIds.length === 0 && !wall2.objective.gateOpen,
  });
  // re-sortie from the pause menu
  s = await resortie(game);
  d = diffPaths(first0, s);
  row('P1.mini.resortieFromPause', {
    check: 're-sortie from the pause menu in the middle of a fight (HP lost, position changed): whole t = 0 snapshot identical to the first sortie',
    where,
    specRef: '§9 再出撃',
    input: 'Esc → 同じ構成で再出撃',
    measured: { identical: d.length === 0, differences: d, hpBefore: wall2.player.hp },
    expected: 'identical JSON',
    pass: d.length === 0,
  });

  // ── yard fight: four enemies, moving guards ──
  const log = new ShotLog();
  const yard = ['G01', 'G02', 'T01', 'T02'];
  const losAt = {}; // id → [last sample without, first sample with line of sight]
  const shotsAt = Object.fromEntries(yard.map((id) => [id, []]));
  const hpLog = [];
  let prevS = s;
  const watch = (y) => {
    log.see(y);
    for (const id of yard) {
      const e = enemyOf(y, id);
      const p = enemyOf(prevS, id);
      if (e.hasLineOfSight && !losAt[id]) losAt[id] = [prevS.elapsedSeconds, y.elapsedSeconds];
      if (e.shotsFired > p.shotsFired) shotsAt[id].push({ n: e.shotsFired, t: e.lastShotAtSeconds, added: e.shotsFired - p.shotsFired });
    }
    if (y.player.hp !== prevS.player.hp) hpLog.push([r6(y.elapsedSeconds), y.player.hp]);
    prevS = y;
  };
  await L.keyDown(page, 'KeyA');
  await runUntil(page, 12, (y) => y.player.position[0] <= -18, 100, watch);
  s = (await runUntil(page, 3, (y) => y.player.position[0] <= -31 || yard.every((id) => losAt[id]), 200, watch)).s;
  await L.keyUp(page, 'KeyA');
  const exposedAt = Math.min(...Object.values(losAt).map((v) => v[1]));
  note('PM: reached the yard', { position: s.player.position, t: s.elapsedSeconds, lineOfSightFirstSeen: losAt });
  // phase 1: one missile at the nearer guard
  await L.tapKey(page, 'Digit3', 20);
  const guardsAlive = () => ['G01', 'G02'].filter((id) => enemyOf(prevS, id).alive);
  const nearest = () => guardsAlive().sort((a, b) => len(sub(enemyOf(prevS, a).position, prevS.player.position)) - len(sub(enemyOf(prevS, b).position, prevS.player.position)))[0];
  let target = nearest();
  let missile = null;
  let missileHit = null;
  let phase = 'missile';
  let down = false;
  const mgTargets = {};
  const offView = [];
  const FOV_H = Math.atan(Math.tan((30 * Math.PI) / 180) * (GW / GH)); // half horizontal field of view (60° vertical, README)
  for (let i = 0; i < 400 && prevS.state === 'playing'; i++) {
    if (target && !enemyOf(prevS, target).alive) target = nearest();
    if (target) await aimAt(game, prevS, enemyOf(prevS, target).position);
    const lockedOn = prevS.lock.state === 'locked' && prevS.lock.targetId === target;
    if (phase === 'missile') {
      if (lockedOn && !missile) {
        const pre = prevS;
        await page.mouse.down();
        watch(await run(page, 1, 1));
        await page.mouse.up();
        missile = prevS.recentPlayerShots.filter((r) => r.weapon === 'missile').at(-1) ?? null;
        if (missile) missile.hpAtLaunch = enemyOf(pre, missile.targetId).hp;
        continue;
      }
      if (missile) {
        const e = enemyOf(prevS, missile.targetId);
        if (e.hp < missile.hpAtLaunch && !missileHit) missileHit = { t: prevS.elapsedSeconds, hp: e.hp, alive: e.alive };
        if (missileHit || prevS.elapsedSeconds - missile.firedAtSeconds > 4.2) {
          phase = 'mg';
          await L.tapKey(page, 'Digit1', 20);
          target = nearest();
          continue;
        }
      }
      watch(await run(page, 1, 3));
    } else {
      if (lockedOn && !down) {
        await page.mouse.down();
        down = true;
      } else if (!lockedOn && down) {
        await page.mouse.up();
        down = false;
      }
      watch(await run(page, 1, 12));
      if (!target) break;
    }
    // enemies that fired in this sample while outside the camera's horizontal field of view
    for (const id of yard) {
      const e = enemyOf(prevS, id);
      const rel = sub(e.position, prevS.player.position);
      let a = Math.atan2(-rel[0], -rel[2]) - game.yaw;
      a = Math.atan2(Math.sin(a), Math.cos(a));
      if (Math.abs(a) > FOV_H + 0.1 && shotsAt[id].length && shotsAt[id].at(-1).t > prevS.elapsedSeconds - 0.11) offView.push({ id, t: r6(shotsAt[id].at(-1).t), angleDeg: Math.round((a * 180) / Math.PI) });
    }
  }
  if (down) await page.mouse.up();
  const afterGuards = prevS;
  // stand still until destroyed
  if (prevS.state === 'playing') await runUntil(page, 12, (y) => y.state !== 'playing', 400, watch);
  s = prevS;
  await L.waitFrames(page, 3);
  const uiDead = await resultUi();
  await shot(game, 'PM-failed-destroyed-1280x720');
  // analysis
  const mgRecs = log.since(0).filter((r) => r.weapon === 'machinegun' && r.solutionStatus === 'solved');
  const mg = summariseMg(mgRecs);
  printMg(mg, log);
  const guardHits = ['G01', 'G02'].map((id) => ({ id, hp: enemyOf(s, id).hp, alive: enemyOf(s, id).alive, solvedShotsAtIt: mgRecs.filter((r) => r.targetId === id).length }));
  if (missile) {
    const sol = solveMissile(missile.muzzlePosition, missile.targetPositionAtFire, missile.targetVelocityAtFire);
    row('F2.missile.moving', {
      check: 'missile at a moving guard: initial direction = my linear intercept for 45 m/s (§4.4), |v0| = 45; the guard is hit',
      where,
      specRef: '§4.4 §11 他の武器のFCS',
      input: `mini-stage yard under fire; view kept on guard ${missile.targetId} with the mouse; one click when the lock completed (t = ${r6(missile.firedAtSeconds)})`,
      measured: { target: missile.targetId, status: missile.solutionStatus, targetVelocity: missile.targetVelocityAtFire.map(r3), targetSpeed: len(missile.targetVelocityAtFire), range: len(sub(missile.targetPositionAtFire, missile.muzzlePosition)), speed: len(missile.initialVelocity), acceleration: missile.accelerationAtFire, angleToMyDirRad: angleBetween(missile.launchDirection, sol.dir), angleToDirectLineRad: angleBetween(missile.launchDirection, unit(sub(missile.targetPositionAtFire, missile.muzzlePosition))), flight: missile.predictedFlightSeconds, myFlight: sol.t, hpAtLaunch: missile.hpAtLaunch, hit: missileHit && { secondsAfterLaunch: r6(missileHit.t - missile.firedAtSeconds), hp: missileHit.hp, alive: missileHit.alive } },
      expected: 'direction = normalize(r + v·t) with my smallest positive root t of (v·v − 45²)t² + 2(r·v)t + r·r = 0 (angle < 1e-9 rad), flight time = t, |v0| = 45, acceleration (0,0,0); guard HP drops by 180 (to 0) around t after launch',
      pass: missile.solutionStatus === 'solved' && Math.abs(len(missile.initialVelocity) - 45) < 1e-9 && sameJson(missile.accelerationAtFire, [0, 0, 0]) && sol.t !== null && angleBetween(missile.launchDirection, sol.dir) < 1e-9 && Math.abs(missile.predictedFlightSeconds - sol.t) < 1e-9 && !!missileHit,
    });
  } else {
    row('F2.missile.moving', { check: 'missile at a moving guard', where, specRef: '§4.4', measured: 'no missile was launched (no completed lock on a guard before the mech was destroyed)', expected: 'one missile record', pass: false });
  }
  row('F1.guard.solver', {
    check: 'machine gun at moving guards in the mini-stage yard: every FCS-corrected record equals my own lead + gravity solution',
    where,
    specRef: '§4.3 §10 §11 マシンガンのFCS',
    input: 'view kept on the guard with the mouse (one aim correction per 0.1 s), trigger held only while locked',
    measured: { ...mgBrief(mg), guards: guardHits, movingTargetRecords: mg.checks.filter((c) => c.targetSpeed > 0.5).length },
    expected: 'angle error < 1e-9 rad, |v0| = 100 ± 0.001, residual ≤ 0.01 m, acceleration (0, −18, 0); target velocities ≠ 0',
    pass: mgOk(mg) && mg.checks.filter((c) => c.targetSpeed > 0.5).length >= 1,
  });
  const firstShots = yard.map((id) => {
    const e = enemyOf(s, id);
    const k = e.kind === 'guard' ? SPEC.guard : SPEC.turret;
    const times = shotsAt[id].map((x) => x.t);
    const first = times[0] ?? null;
    return { id, kind: e.kind, losBetween: losAt[id] ? losAt[id].map(r6) : null, firstShotAt: first, delayBetween: first !== null && losAt[id] ? [r6(first - losAt[id][1]), r6(first - losAt[id][0])] : null, expected: k.first, shots: e.shotsFired };
  });
  row('E1.mini.firstShots', {
    check: 'mini-stage yard: each of the four enemies opens fire by its own timer after first seeing the mech (2 guards 0.50 s, 2 turrets 0.70 s; AI delay ≤ 0.05 s)',
    where,
    specRef: '§2.3 §11 敵の攻撃',
    input: 'A held through the tunnel into the yard; line of sight sampled every 0.025 s',
    measured: firstShots,
    expected: 'for every enemy the interval [first shot − first sample with line of sight, first shot − last sample without] overlaps [first, first + 0.05] s; all four fire',
    pass: firstShots.every((f) => f.delayBetween && f.delayBetween[1] >= f.expected - 1e-9 && f.delayBetween[0] <= f.expected + SPEC.aiDelay + 1e-9 && f.shots > 0),
  });
  row('E1.mini.simultaneous', {
    check: 'the four enemies attack independently and at the same time; shots also come from enemies outside the camera view; the standing mech is destroyed',
    where,
    specRef: '§2.3 (一度に1体だけ…禁止、カメラ外の敵も…攻撃)',
    input: 'same fight',
    measured: { shotsFired: Object.fromEntries(yard.map((id) => [id, enemyOf(s, id).shotsFired])), firedWhileOutsideTheView: offView.slice(0, 6), outsideCount: offView.length, exposedAt: r6(exposedAt), destroyedAt: r6(s.elapsedSeconds), secondsFromExposure: r6(s.elapsedSeconds - exposedAt), hpTrace: hpLog.slice(0, 12), hpAfterGuardPhase: afterGuards.player.hp },
    expected: 'all four have shotsFired > 0; some shots fired from more than half the horizontal field of view off the view axis',
    pass: yard.every((id) => enemyOf(s, id).shotsFired > 0) && offView.length > 0,
  });
  const da = await L.snap(page);
  await run(page, 4, 30);
  const db = await L.snap(page);
  row('P1.mini.destroyed', {
    check: "mini stage: HP reaches 0 under real enemy fire → 'failed'; result screen; nothing advances",
    where,
    specRef: '§9 §11 進行',
    input: 'standing in the yard after the guard phase',
    measured: { state: s.state, hp: s.player.hp, t: s.elapsedSeconds, result: uiDead, frozen: sameJson(da, db), hpSteps: [...new Set(hpLog.slice(1).map((h, i) => hpLog[i][1] - h[1]))].sort((a, b) => a - b) },
    expected: "state 'failed', HP 0; MISSION FAILED / 機体大破; HP only ever drops by sums of 18 (guard) and 40 (turret)",
    pass: s.state === 'failed' && s.player.hp === 0 && uiDead.title === 'MISSION FAILED' && /大破/.test(uiDead.sub ?? '') && sameJson(da, db),
  });
  s = await into(page, 'restart');
  game.yaw = game.pitch = 0;
  d = diffPaths(first0, s);
  row('P1.mini.resortieAfterDestroyed', {
    check: 're-sortie after being destroyed (enemies killed, missile and bullets used, alert enemies): whole t = 0 snapshot identical to the first sortie',
    where,
    specRef: '§9 再出撃',
    input: 'result screen → 同じ構成で再出撃',
    measured: { identical: d.length === 0, differences: d, ammo: s.player.ammo, enemiesAlive: s.enemies.filter((e) => e.alive).length, alert: s.enemies.filter((e) => e.alert).length },
    expected: 'identical JSON',
    pass: d.length === 0,
  });
  // ── standing still in the yard, never firing: time from the first line of sight to HP 0 ──
  {
    let p = s;
    let firstLos = null;
    const seeLos = (y) => {
      if (!firstLos && yard.some((id) => enemyOf(y, id).hasLineOfSight)) firstLos = [p.elapsedSeconds, y.elapsedSeconds];
      p = y;
    };
    await L.keyDown(page, 'KeyA');
    await runUntil(page, 12, (y) => y.player.position[0] <= -18, 100, seeLos);
    s = (await runUntil(page, 3, (y) => y.player.position[0] <= -31, 200, seeLos)).s;
    await L.keyUp(page, 'KeyA');
    const stoodAt = s.player.position.map(r3);
    const dists = Object.fromEntries(yard.map((id) => [id, r3(len(sub(enemyOf(s, id).position, s.player.position)))]));
    s = (await runUntil(page, 12, (y) => y.state !== 'playing', 400, seeLos)).s;
    row('E1.mini.exposure', {
      check: 'mini-stage yard, mech standing still and never firing: destroyed by ordinary enemy fire within 15 s of the first line of sight (2 guards + 2 turrets here — one turret more than the §2.3 test condition, which is measured headless)',
      where,
      specRef: '§2.3 §11 露出時の危険性',
      input: 'fresh sortie; A held through the tunnel to x = −31, then no input at all',
      measured: { firstLineOfSightBetween: firstLos && firstLos.map(r6), stoodAt, initialDistances: dists, destroyedAt: r6(s.elapsedSeconds), secondsFromFirstSight: firstLos && r6(s.elapsedSeconds - firstLos[0]), state: s.state, hp: s.player.hp, shotsFired: Object.fromEntries(yard.map((id) => [id, enemyOf(s, id).shotsFired])), playerShots: s.recentPlayerShots.length },
      expected: "state 'failed' with HP 0 in ≤ 15 s; all four enemies fired; no shot of the mech",
      pass: s.state === 'failed' && s.player.hp === 0 && !!firstLos && s.elapsedSeconds - firstLos[0] <= 15 && yard.every((id) => enemyOf(s, id).shotsFired > 0) && s.recentPlayerShots.length === 0,
    });
  }
  row('PM.pageErrors', { check: 'PM: no console error / uncaught exception', where, measured: game.errors.slice(0, 3), expected: [], pass: game.errors.length === 0 });
  await game.close();
}

// ───────────────────────────── EP: shipped page — guard G01, control turret T01 ─────────────────────────────
/** Groups shot times into bursts (a gap of more than `split` seconds starts a new burst). */
function bursts(times, split = 0.5) {
  const out = [];
  for (const t of times) {
    if (out.length && t - out.at(-1).at(-1) < split) out.at(-1).push(t);
    else out.push([t]);
  }
  return out;
}
async function EP() {
  const where = WHERE_S;
  playSize = [SW, SH];
  const game = await openScripted(browser);
  const page = game.page;
  const parts = arg('ep') ? arg('ep').split(',') : ['1', '2'];
  let s = await into(page, 'sortie'); // default build: medium / balanced / biped
  // per-sortie observation state
  let log;
  let enemyShots; // id → [{ t, n }]
  let edges; // line-of-sight / alert changes
  let hpLog;
  let track; // G01 samples
  let prevS;
  const reset = (y) => {
    log = new ShotLog();
    enemyShots = {};
    edges = [];
    hpLog = [[y.elapsedSeconds, y.player.hp]];
    track = [];
    prevS = y;
  };
  reset(s);
  const watch = (y) => {
    log.see(y);
    y.enemies.forEach((e, i) => {
      const p = prevS.enemies[i];
      if (e.shotsFired > p.shotsFired) (enemyShots[e.id] ??= []).push({ t: e.lastShotAtSeconds, n: e.shotsFired, added: e.shotsFired - p.shotsFired });
      if (e.hasLineOfSight !== p.hasLineOfSight) edges.push({ id: e.id, what: 'los', value: e.hasLineOfSight, between: [prevS.elapsedSeconds, y.elapsedSeconds], playerAt: y.player.position.map(r3), enemyAt: e.position.map(r3) });
      if (e.alert !== p.alert) edges.push({ id: e.id, what: 'alert', value: e.alert, between: [prevS.elapsedSeconds, y.elapsedSeconds] });
    });
    if (y.player.hp !== prevS.player.hp) hpLog.push([y.elapsedSeconds, y.player.hp]);
    const g = enemyOf(y, 'G01');
    track.push({ t: y.elapsedSeconds, pos: g.position, vel: g.velocity, los: g.hasLineOfSight, alert: g.alert, hp: g.hp, alive: g.alive, player: y.player.position });
    prevS = y;
    return y;
  };
  const view = (y, id) => {
    // angle between the camera axis (yaw tracked from my own mouse input) and the direction to the enemy, in the horizontal plane
    const rel = sub(enemyOf(y, id).position, y.player.position);
    let a = Math.atan2(-rel[0], -rel[2]) - game.yaw;
    a = Math.atan2(Math.sin(a), Math.cos(a));
    return a;
  };
  const halfFovH = (w, h) => Math.atan(Math.tan((30 * Math.PI) / 180) * (w / h));
  let down = false;
  /**
   * Keeps the view on enemy `id` and the trigger down while locked on it, until it is destroyed (or `maxFrames`).
   * Gives up after `patience` samples in a row in which the lock is not on it although the view is (no line from
   * the camera or the muzzle). Returns { lockAt, outcome: 'destroyed' | 'nolock' | 'timeout' | 'over' }.
   */
  const engage = async (id, k, maxFrames, patience = 24) => {
    let lockAt = null;
    let noLock = 0;
    let outcome = 'timeout';
    for (let i = 0; i < maxFrames; i++) {
      if (prevS.state !== 'playing') {
        outcome = 'over';
        break;
      }
      const e = enemyOf(prevS, id);
      if (!e.alive) {
        outcome = 'destroyed';
        break;
      }
      const lockedOn = prevS.lock.state === 'locked' && prevS.lock.targetId === id;
      if (lockedOn && lockAt === null) lockAt = prevS.elapsedSeconds;
      noLock = prevS.lock.targetId === id ? 0 : noLock + 1;
      if (noLock > patience) {
        outcome = 'nolock';
        break;
      }
      if (lockedOn && !down) {
        await page.mouse.down();
        down = true;
      } else if (!lockedOn && down) {
        await page.mouse.up();
        down = false;
      }
      await aimAt(game, prevS, e.position); // the view follows the target (one mouse movement per sample)
      watch(await run(page, 1, k));
    }
    if (down) {
      await page.mouse.up();
      down = false;
    }
    if (outcome === 'timeout' && !enemyOf(prevS, id).alive) outcome = 'destroyed';
    return { lockAt, outcome };
  };

  const part1 = async () => {
  // ── E1a: walk out of the dock into the checkpoint corridor; G01 first sees the mech; the view never turns ──
  await L.keyDown(page, 'KeyW');
  await runUntil(page, 30, (y) => y.player.position[2] <= 25, 40, watch);
  await runUntil(page, 6, (y) => y.player.position[2] <= 15.5, 40, watch);
  s = (await runUntil(page, 2, (y) => enemyOf(y, 'G01').hasLineOfSight || y.player.position[2] <= 4.5, 200, watch)).s;
  await L.keyUp(page, 'KeyW');
  const los1 = edges.find((e) => e.id === 'G01' && e.what === 'los' && e.value);
  note('EP: G01 first has a line of sight', { edge: los1, player: s.player.position, g01: enemyOf(s, 'G01').position, range: los1 ? r3(len(sub(enemyOf(s, 'G01').position, s.player.position))) : null });
  if (!los1) throw new Error('G01 never got a line of sight on the way into the corridor');
  // stand still for 3.3 s (the mech stops within 0.1 s); sample every 0.05 s so that every shot time is caught
  for (let i = 0; i < 66; i++) watch(await run(page, 1, 6));
  s = prevS;
  const gShots = (enemyShots.G01 ?? []).map((x) => x.t);
  const gB = bursts(gShots);
  const firstDelay = gShots.length ? [gShots[0] - los1.between[1], gShots[0] - los1.between[0]] : null;
  const intra = gB.flatMap((b) => b.slice(1).map((t, i) => r6(t - b[i])));
  const periods = gB.slice(1).map((b, i) => r6(b[0] - gB[i][0]));
  console.log('        G01 shot times: ' + gShots.map((t) => t.toFixed(4)).join(' '));
  console.log('        player HP: ' + hpLog.map((h) => `${h[0].toFixed(3)}:${h[1]}`).join(' '));
  row('E1.guard.firstShot', {
    check: 'factory, guard G01: first shot 0.50 s after it first has a line of sight (AI delay ≤ 0.05 s)',
    where,
    specRef: '§2.3 §11 敵の攻撃',
    input: 'default build; W held from the start (z 90) through the dock door into the checkpoint corridor, view never turned; W released when G01 sees the mech',
    measured: { lineOfSightBetween: los1.between.map(r6), playerAt: los1.playerAt, g01At: los1.enemyAt, firstShotAt: gShots[0] ?? null, delayBetween: firstDelay && firstDelay.map(r6) },
    expected: `delay in [0.50, 0.55] s; my sampling brackets the line-of-sight instant within ${r6(los1.between[1] - los1.between[0])} s`,
    pass: !!firstDelay && firstDelay[1] >= SPEC.guard.first - 1e-9 && firstDelay[0] <= SPEC.guard.first + SPEC.aiDelay + 1e-9,
  });
  const fullBursts = gB.slice(0, -1); // the last one may be cut off by the end of the observation
  row('E1.guard.bursts', {
    check: 'factory, guard G01: bursts of 3 shots 0.12 s apart, a burst every 1.20 s, while the line of sight lasts',
    where,
    specRef: '§2.3 §11 敵の攻撃',
    input: 'mech standing still in the corridor for 3.3 s; shotsFired / lastShotAtSeconds sampled every 0.05 s',
    measured: { shots: gShots.length, burstSizes: gB.map((b) => b.length), gapsInsideBursts: [...new Set(intra)], burstStartToStart: periods, lostSightDuring: edges.filter((e) => e.id === 'G01' && e.what === 'los' && !e.value).map((e) => e.between.map(r6)) },
    expected: 'every complete burst has 3 shots; gaps 0.12 s; starts 1.20 s apart',
    pass: fullBursts.length >= 2 && fullBursts.every((b) => b.length === 3) && intra.every((g) => Math.abs(g - SPEC.guard.gap) < 1e-6) && periods.every((p) => Math.abs(p - SPEC.guard.period) < 1e-6),
  });
  const angle = view(s, 'G01');
  const dmg = hpLog.slice(1).map((h, i) => hpLog[i][1] - h[1]);
  const othersFired = Object.keys(enemyShots).filter((id) => id !== 'G01');
  const hudHit = await hudText(page);
  const hitShown = await L.evaluate(page, () => [...document.querySelectorAll('.hud-hit, .hud-hit-g, .hud-dmg')].map((e) => ({ cls: e.getAttribute('class'), opacity: getComputedStyle(e).opacity, display: getComputedStyle(e).display })).slice(0, 8));
  await shot(game, 'EP-hit-from-outside-view-1280x720');
  row('E1.guard.outsideView', {
    check: 'factory: G01 attacks and hits while it is outside the camera view (the mech never looked at it and never fired)',
    where,
    specRef: '§2.3 (カメラ外の敵も…攻撃) §11 敵の攻撃',
    input: 'same 3.3 s; camera yaw 0 (looking −Z), no mouse movement and no shot since the sortie',
    measured: { angleFromViewAxisDeg: r3((angle * 180) / Math.PI), halfHorizontalFovDeg: r3((halfFovH(1280, 720) * 180) / Math.PI), g01: enemyOf(s, 'G01').position.map(r3), player: s.player.position.map(r3), playerShots: s.recentPlayerShots.length, hpLossSteps: dmg, hp: s.player.hp, otherEnemiesThatFired: othersFired, alertEnemies: s.enemies.filter((e) => e.alert).map((e) => e.id), hitIndicatorElements: hitShown },
    expected: '|angle| > half horizontal field of view (60° vertical → 45.7° at 16:9); HP lost in steps of 18 (one guard bullet each); no shot of mine; nobody else fired',
    pass: Math.abs(angle) > halfFovH(1280, 720) + 0.05 && dmg.length >= 3 && dmg.every((d) => d > 0 && d % 18 === 0) && s.recentPlayerShots.length === 0 && othersFired.length === 0,
  });
  // lead: the mech stood still, so every bullet aimed at the present position should hit; then strafe to see the bullets follow the motion
  // ── E1b: break the line of sight (back into the dock) and watch the pursuit ──
  const beforeBreak = edges.length;
  await L.keyDown(page, 'KeyS');
  s = (await runUntil(page, 3, (y) => !enemyOf(y, 'G01').hasLineOfSight || y.player.position[2] >= 40, 300, watch)).s;
  const lostEdge = edges.slice(beforeBreak).find((e) => e.id === 'G01' && e.what === 'los' && !e.value);
  const tLost = lostEdge ? lostEdge.between[1] : s.elapsedSeconds;
  const lastSeen = s.player.position.slice();
  const gAtLoss = enemyOf(s, 'G01').position.slice();
  // keep backing off to z ≈ 34 (well inside the dock, facing the door), then wait
  s = (await runUntil(page, 6, (y) => y.player.position[2] >= 34, 100, watch)).s;
  await L.keyUp(page, 'KeyS');
  const shotsAtLoss = enemyOf(s, 'G01').shotsFired;
  let regained = null;
  let lockOnG = null;
  const mark = log.lastId;
  // wait (facing the dock door, no input) until G01 has its line of sight again
  for (let i = 0; i < 300 && prevS.state === 'playing' && !regained && prevS.elapsedSeconds - tLost <= 14; i++) {
    const g = enemyOf(prevS, 'G01');
    if (g.hasLineOfSight) regained = { t: prevS.elapsedSeconds, g: g.position.map(r3), player: prevS.player.position.map(r3) };
    else watch(await run(page, 1, 6));
  }
  // fight: the view follows whichever guard sees the mech (the locked one first), trigger down only while locked on it
  const seeing = (y) => y.enemies.filter((e) => e.kind === 'guard' && e.alive && e.hasLineOfSight);
  let idle = 0;
  let tgt = null;
  const fightHp = prevS.player.hp;
  for (let i = 0; i < 420 && prevS.state === 'playing' && idle < 50; i++) {
    const c = seeing(prevS);
    if (!c.length) {
      idle++;
      tgt = null;
    } else {
      idle = 0;
      if (!tgt || !c.some((e) => e.id === tgt)) {
        const lockedC = c.find((e) => e.id === prevS.lock.targetId);
        tgt = (lockedC ?? c.sort((x, y) => len(sub(x.position, prevS.player.position)) - len(sub(y.position, prevS.player.position)))[0]).id;
      }
      await aimAt(game, prevS, enemyOf(prevS, tgt).position);
    }
    const lockedOn = tgt !== null && prevS.lock.state === 'locked' && prevS.lock.targetId === tgt;
    if (lockedOn && lockOnG === null) lockOnG = prevS.elapsedSeconds;
    if (lockedOn && !down) {
      await page.mouse.down();
      down = true;
    } else if (!lockedOn && down) {
      await page.mouse.up();
      down = false;
    }
    watch(await run(page, 1, 6));
  }
  if (down) {
    await page.mouse.up();
    down = false;
  }
  if (prevS.state === 'playing') for (let i = 0; i < 6; i++) watch(await run(page, 1, 12));
  s = prevS;
  const after = track.filter((x) => x.t > tLost - 1e-9 && x.t <= tLost + 8 + 1e-9);
  const moving = after.find((x) => Math.hypot(x.vel[0], x.vel[2]) > 0.5);
  const dist0 = hdist(gAtLoss, lastSeen);
  const closest = after.reduce((m, x) => Math.min(m, hdist(x.pos, lastSeen)), Infinity);
  const speeds = after.map((x) => Math.hypot(x.vel[0], x.vel[2]));
  console.log('        G01 after losing sight (t − tLost, x, z, speed, los): ' + after.filter((_, i) => i % 6 === 0).map((x) => `[${(x.t - tLost).toFixed(2)} ${x.pos[0].toFixed(1)} ${x.pos[2].toFixed(1)} ${Math.hypot(x.vel[0], x.vel[2]).toFixed(1)} ${x.los ? 'L' : '-'}]`).join(' '));
  row('E1.guard.pursuit', {
    check: 'factory, guard G01 after the mech broke the line of sight (back into the dock): stays alert, starts moving within 0.50 s, comes after the mech along the corridor and gets its line of sight back',
    where,
    specRef: '§2.3 §11 敵の攻撃',
    input: `S held until G01 lost sight (t = ${r6(tLost)}), on to z = 34, then standing still facing the dock door`,
    measured: { lostBetween: lostEdge ? lostEdge.between.map(r6) : null, playerLastSeenAt: lastSeen.map(r3), g01AtLoss: gAtLoss.map(r3), movingFrom: moving ? r6(moving.t - tLost) : null, maxSpeed: r3(Math.max(0, ...speeds)), distanceToLastSeenPosition: { atLoss: r3(dist0), closest: r3(closest) }, alertThroughout: after.every((x) => x.alert), shotsWhileNoSight: after.filter((x) => !x.los).length ? 'see E1.guard.noBlindFire' : null, lineOfSightAgain: regained && { secondsAfterLoss: r6(regained.t - tLost), g01: regained.g, player: regained.player } },
    expected: 'alert stays true; speed > 0 within 0.50 s (+ 0.05 s sampling); it gets closer to the last seen position (speed ≤ 8 m/s) and has a line of sight again within the 8 s it remembers',
    pass: !!lostEdge && !!moving && moving.t - tLost <= SPEC.reacquire + 0.05 + 1e-9 && closest < dist0 - 5 && Math.max(...speeds) <= 8 + 1e-6 && after.every((x) => x.alert) && !!regained && regained.t - tLost <= SPEC.memory + 1e-9,
  });
  const blind = (enemyShots.G01 ?? []).filter((x) => x.t > tLost + 1e-9 && (!regained || x.t < regained.t - 0.2));
  row('E1.guard.noBlindFire', {
    check: 'while G01 has no line of sight it fires nothing',
    where,
    specRef: '§2.3 (射線を失った発は発射しません)',
    input: 'same; from the loss of sight to 0.2 s before it is regained',
    measured: { shotsInThatWindow: blind.length, shotsFiredAtLoss: shotsAtLoss, window: [r6(tLost), regained ? r6(regained.t - 0.2) : null] },
    expected: '0 shots',
    pass: blind.length === 0,
  });
  // ── F1: machine gun at the moving guards ──
  const gRecs = log.since(mark).filter((r) => r.weapon === 'machinegun' && r.solutionStatus === 'solved');
  const mg = summariseMg(gRecs);
  printMg(mg, log);
  const free = log.since(mark).filter((r) => r.solutionStatus !== 'solved').length;
  const perGuard = [...new Set(gRecs.map((r) => r.targetId))].map((id) => ({ id, solvedShots: gRecs.filter((r) => r.targetId === id).length, hits: (120 - enemyOf(s, id).hp) / 12, hp: enemyOf(s, id).hp, alive: enemyOf(s, id).alive }));
  const totalHits = perGuard.reduce((n, g) => n + g.hits, 0);
  row('F1.factory.guard.solver', {
    check: 'factory, machine gun at moving guards (G01 and the guards it called): every FCS-corrected record equals my own lead + gravity solution of §4.3',
    where,
    specRef: '§4.3 §10 §11 マシンガンのFCS',
    input: `the guards came into view at the dock door; first lock complete at t = ${lockOnG === null ? '–' : r6(lockOnG)}; view kept on the target with the mouse (one movement per 0.05 s), trigger held only while locked on it`,
    measured: { ...mgBrief(mg), targets: perGuard.map((g) => `${g.id}:${g.solvedShots}`), movingTargetRecords: mg.checks.filter((c) => c.targetSpeed > 0.5).length, freeFireRecords: free },
    expected: '≥ 20 records; angle error < 1e-9 rad, |v0| = 100 ± 0.001 m/s, acceleration (0, −18, 0), residual ≤ 0.01 m; target velocity ≠ 0 in the records',
    pass: mg.n >= 20 && mgOk(mg) && mg.checks.filter((c) => c.targetSpeed > 0.5).length >= 10,
  });
  row('F1.factory.guard.hits', {
    check: 'factory, moving guards: hits counted from their HP (12 per bullet); no forced hits',
    where,
    specRef: '§4.1 §4.5 §11 物理の保持',
    input: 'same shots; a guard that changes its velocity after the shot can be missed (correct behaviour, §4.5)',
    measured: { perGuard, solvedShots: gRecs.length, hits: totalHits, missedOrStillInFlight: gRecs.length - totalHits, playerHp: [fightHp, s.player.hp], state: s.state },
    expected: 'every guard: HP = 120 − 12 × hits, destroyed after 10 hits; hits ≤ shots',
    pass: perGuard.length >= 1 && perGuard.every((g) => Number.isInteger(g.hits) && g.hits <= g.solvedShots + free && (g.alive || g.hits === 10)) && totalHits >= 10,
  });
  note('EP part 1: every enemy that fired during this sortie', Object.fromEntries(Object.entries(enemyShots).map(([id, v]) => [id, v.length ? v.at(-1).n : 0])));
  note('EP part 1: alert enemies at the end', prevS.enemies.filter((e) => e.alert).map((e) => `${e.id}@${e.position.map((v) => Math.round(v)).join(',')}`));
  note('EP part 1: player HP trace (t, HP)', hpLog.map((h) => [r3(h[0]), h[1]]));
  };

  const part2 = async () => {
  // ── P1: a fresh sortie to control turret T01; guards that see the mech on the way are shot with the beam ──
  if (prevS.elapsedSeconds !== 0) {
    s = prevS.state === 'playing' ? await resortie(game) : await into(page, 'restart');
    game.yaw = game.pitch = 0;
    reset(s);
  }
  await L.tapKey(page, 'Digit2', 20);
  const ignoreUntil = {}; // guard id → simulation time until which it is not engaged (it sees the mech, the mech cannot lock it)
  const seeing = (y) => y.enemies.filter((e) => e.kind === 'guard' && e.alive && e.hasLineOfSight && !(ignoreUntil[e.id] > y.elapsedSeconds));
  const beamed = [];
  const clearThreats = async () => {
    for (let n = 0; n < 12 && prevS.state === 'playing' && seeing(prevS).length; n++) {
      const t = seeing(prevS).sort((x, y) => len(sub(x.position, prevS.player.position)) - len(sub(y.position, prevS.player.position)))[0];
      const t0 = prevS.elapsedSeconds;
      const r = await engage(t.id, 6, 120);
      if (r.outcome !== 'destroyed') ignoreUntil[t.id] = prevS.elapsedSeconds + 2;
      beamed.push({ id: t.id, from: r3(t0), to: r3(prevS.elapsedSeconds), outcome: r.outcome, range: r3(len(sub(t.position, prevS.player.position))) });
      lap(`EP part 2: guard ${t.id} ${r.outcome} at t = ${prevS.elapsedSeconds.toFixed(2)}, mech at ${v3s(prevS.player.position, 1)}, HP ${prevS.player.hp}`);
    }
    await turn(game, game.yaw / SENS, game.pitch / SENS); // back to yaw 0: W / A / S / D = −Z / −X / +Z / +X
  };
  /** Walks with `key` until `done`; whenever a guard sees the mech it stops, fights, turns back and goes on. */
  const go = async (key, done, far) => {
    for (let attempt = 0; attempt < 10 && prevS.state === 'playing'; attempt++) {
      await L.keyDown(page, key);
      let interrupted = false;
      for (let i = 0; i < 400 && !done(prevS) && prevS.state === 'playing'; i++) {
        if (seeing(prevS).length) {
          interrupted = true;
          break;
        }
        const before = prevS.player.position;
        watch(await run(page, 1, far(prevS) ? 12 : 3));
        if (i > 3 && hdist(before, prevS.player.position) < 1e-6) {
          await L.keyUp(page, key);
          throw new Error(`go(${key}): the mech is blocked at ${v3s(prevS.player.position, 2)}`);
        }
      }
      await L.keyUp(page, key);
      watch(await run(page, 1, 12));
      if (!interrupted) {
        lap(`EP part 2: ${key} done at t = ${prevS.elapsedSeconds.toFixed(2)}, mech at ${v3s(prevS.player.position, 2)}, HP ${prevS.player.hp}`);
        return;
      }
      await clearThreats();
    }
    if (prevS.state !== 'playing') throw new Error(`the sortie ended on the way (state ${prevS.state}, HP ${prevS.player.hp}, t = ${prevS.elapsedSeconds})`);
  };
  const far = (target, axis) => (y) => Math.abs(y.player.position[axis] - target) > 3.5;
  await go('KeyW', (y) => y.player.position[2] <= 8.6, far(8.6, 2));
  await go('KeyD', (y) => y.player.position[0] >= 49, far(49, 0));
  // between the second container (z 9…14: the mech must be at z ≤ 7.7) and the third (z 2…6: z ≥ 7.3): one-tick frames,
  // released 0.42 m (the stopping distance from 10 m/s) before z = 7.5
  await L.keyDown(page, 'KeyW');
  for (let i = 0; i < 60 && prevS.player.position[2] > 7.95 && prevS.state === 'playing'; i++) watch(await run(page, 1, 1));
  await L.keyUp(page, 'KeyW');
  watch(await run(page, 1, 12));
  await go('KeyD', (y) => y.player.position[0] >= 84, far(84, 0));
  s = prevS;
  note('EP part 2: in front of the yard door', { position: s.player.position.map(r3), hp: s.player.hp, t: r6(s.elapsedSeconds), guardsShotWithTheBeam: beamed, en: r3(s.player.en), alert: s.enemies.filter((e) => e.alert).map((e) => e.id) });
  await L.tapKey(page, 'Digit1', 20);
  const preYard = edges.length;
  await L.keyDown(page, 'KeyS');
  for (let i = 0; i < 80 && prevS.player.position[2] < 18.9 && prevS.state === 'playing'; i++) watch(await run(page, 1, 3));
  await L.keyUp(page, 'KeyS');
  if (prevS.player.position[2] < 18.4) throw new Error(`the yard door was not reached: ${v3s(prevS.player.position, 2)}`);
  watch(await run(page, 1, 6));
  s = prevS;
  await aimAt(game, s, enemyOf(s, 'T01').position);
  const mark2 = log.lastId;
  const hpT0 = enemyOf(s, 'T01').hp;
  down = false;
  let lockT = null;
  const tHp = [[s.elapsedSeconds, hpT0]];
  for (let i = 0; i < 260 && prevS.state === 'playing' && enemyOf(prevS, 'T01').alive; i++) {
    const lockedOn = prevS.lock.state === 'locked' && prevS.lock.targetId === 'T01';
    if (lockedOn && lockT === null) lockT = prevS.elapsedSeconds;
    if (lockedOn && !down) {
      await page.mouse.down();
      down = true;
    } else if (!lockedOn && down) {
      await page.mouse.up();
      down = false;
    }
    watch(await run(page, 1, 6));
    tHp.push([prevS.elapsedSeconds, enemyOf(prevS, 'T01').hp]);
  }
  if (down) await page.mouse.up();
  const tDead = prevS.elapsedSeconds;
  for (let i = 0; i < 4; i++) watch(await run(page, 1, 6));
  s = prevS;
  const hudP = await hudText(page);
  await shot(game, 'EP-T01-destroyed-B1-open-1280x720');
  const tRecs = log.since(mark2).filter((r) => r.weapon === 'machinegun' && r.solutionStatus === 'solved' && r.targetId === 'T01');
  const mt = summariseMg(tRecs);
  printMg(mt, log);
  row('F1.factory.turret.solver', {
    check: 'factory, machine gun at control turret T01 on its mast (≈ 60 m away, 22 m higher): every FCS-corrected record equals my own solution of §4.3',
    where,
    specRef: '§4.3 §10 §11 マシンガンのFCS',
    input: `standing in the yard door at ${v3s(s.player.position, 1)}; view turned onto T01 with one mouse movement; lock complete at t = ${lockT === null ? '–' : r6(lockT)}; trigger held while locked`,
    measured: { ...mgBrief(mt), freeFireRecords: log.since(mark2).filter((r) => r.solutionStatus !== 'solved').length },
    expected: '≥ 20 records; angle error < 1e-9 rad, |v0| = 100 ± 0.001 m/s, acceleration (0, −18, 0), residual ≤ 0.01 m',
    pass: mt.n >= 20 && mgOk(mt),
  });
  const tEnd = enemyOf(s, 'T01');
  // physics kept: each bullet arrives after its own ballistic flight time (not at once), launched ABOVE the direct line
  const arrivals = tRecs.map((r) => r.firedAtSeconds + r.predictedFlightSeconds).sort((x, y) => x - y);
  const hitBrackets = [];
  for (let i = 1; i < tHp.length; i++) {
    const k = (tHp[i - 1][1] - tHp[i][1]) / 12;
    for (let j = 0; j < k; j++) hitBrackets.push([tHp[i - 1][0], tHp[i][0]]);
  }
  const matched = hitBrackets.map((b, i) => ({ hit: i + 1, between: b.map(r3), centreArrival: r3(arrivals[i]), ok: arrivals[i] !== undefined && b[0] < arrivals[i] + 1e-9 && b[1] >= arrivals[i] - 0.03 }));
  const elev = tRecs.map((r) => Math.asin(r.launchDirection[1]) - Math.asin(unit(sub(r.targetPositionAtFire, r.muzzlePosition))[1]));
  row('F1.factory.turret.ballistic', {
    check: 'factory, T01: the bullets are real projectiles on a parabola — launched above the direct line, and each HP step comes one ballistic flight time after its shot (not at once, no homing needed for a static target)',
    where,
    specRef: '§4.3 §11 物理の保持',
    input: 'same shots; turret HP sampled every 0.05 s; arrival of shot k at the centre = firedAt + my flight time (the surface is reached ≤ 0.014 s earlier)',
    measured: { launchElevationAboveDirectLineDeg: [r3((Math.min(...elev) * 180) / Math.PI), r3((Math.max(...elev) * 180) / Math.PI)], flightSeconds: mt.flight.map(r3), hitsMatched: matched.filter((m) => m.ok).length, hits: matched.length, firstThree: matched.slice(0, 3), mismatches: matched.filter((m) => !m.ok).slice(0, 3) },
    expected: 'elevation above the direct line > 0 (≈ atan(½·18·t²/range)); the k-th HP step falls in the sample interval that contains the predicted arrival of the k-th shot',
    pass: matched.length >= 20 && matched.every((m) => m.ok) && Math.min(...elev) > 0,
  });
  row('F1.factory.turret.hits', {
    check: 'factory, T01: 20 hits of 12 destroy it (HP 240)',
    where,
    specRef: '§2.1 §4.1',
    input: 'same shots',
    measured: { solvedShots: tRecs.length, hpBefore: hpT0, hpAfter: tEnd.hp, alive: tEnd.alive, hits: (hpT0 - tEnd.hp) / 12, bulletsInFlightWhenItDied: tRecs.length - (hpT0 - tEnd.hp) / 12, destroyedAt: r6(tDead) },
    expected: 'HP 240 → 0 in steps of 12 = 20 hits; the shots beyond 20 were still in flight when it died',
    pass: hpT0 === 240 && tEnd.hp === 0 && !tEnd.alive && tRecs.length >= 20,
  });
  row('P1.factory.T01', {
    check: 'REAL factory: control turret T01 destroyed by real play → controlsDestroyed 1, barrier B1 open, gate closed; the HUD shows 1/6 and the barrier as open',
    where,
    specRef: '§2.1 §8 §11 進行',
    input: 'route: dock → checkpoint corridor (W, D, W, D) → yard door (S) → T01',
    measured: { objective: s.objective, t01Alive: tEnd.alive, hudTopRight: hudP.topRight, hudTopCenter: hudP.topCenter, hudTopLeft: hudP.topLeft, visited: s.stage.visitedSectorIds, playerHp: s.player.hp, t: s.elapsedSeconds, enemiesDestroyed: s.enemies.filter((e) => !e.alive).map((e) => e.id) },
    expected: 'controlsDestroyed 1, openBarrierIds ["B1"], gateOpen false; HUD text contains 1/6',
    pass: s.objective.controlsDestroyed === 1 && sameJson(s.objective.openBarrierIds, ['B1']) && !s.objective.gateOpen && /1\s*\/\s*6/.test(hudP.topRight ?? ''),
  });
  // turret timing seen from the yard door
  const yardEdges = edges.slice(preYard);
  const turretRows = [];
  for (const id of ['T01', 'T02']) {
    const e0 = yardEdges.find((e) => e.id === id && e.what === 'los' && e.value);
    const times = (enemyShots[id] ?? []).map((x) => x.t);
    const b = bursts(times, 0.8);
    turretRows.push({ id, lineOfSightBetween: e0 ? e0.between.map(r6) : null, firstShotAt: times[0] ?? null, delayBetween: e0 && times.length ? [r6(times[0] - e0.between[1]), r6(times[0] - e0.between[0])] : null, burstSizes: b.map((x) => x.length), gaps: [...new Set(b.flatMap((x) => x.slice(1).map((t, i) => r6(t - x[i]))))], periods: b.slice(1).map((x, i) => r6(x[0] - b[i][0])), lostSight: yardEdges.filter((e) => e.id === id && e.what === 'los' && !e.value).length });
  }
  const t1 = turretRows[0];
  row('E1.turret.timing', {
    check: 'factory, turret T01 seen from the yard door: first shot 0.70 s after its first line of sight, bursts of 2 shots 0.25 s apart every 1.60 s',
    where,
    specRef: '§2.3 §11 敵の攻撃',
    input: 'S held from the corridor into the yard door; shotsFired / lastShotAtSeconds sampled every 0.025–0.05 s until T01 is destroyed',
    measured: turretRows,
    expected: 'T01: delay in [0.70, 0.75] s; complete bursts of 2; gap 0.25 s; period 1.60 s (as long as its line of sight lasts)',
    pass: !!t1.delayBetween && t1.delayBetween[1] >= SPEC.turret.first - 1e-9 && t1.delayBetween[0] <= SPEC.turret.first + SPEC.aiDelay + 1e-9 && t1.gaps.every((g) => Math.abs(g - SPEC.turret.gap) < 1e-6) && (t1.lostSight > 0 || t1.periods.every((p) => Math.abs(p - SPEC.turret.period) < 1e-6)) && t1.burstSizes.slice(0, -1).every((n) => n === 2 || t1.lostSight > 0),
  });
  note('EP part 2: every enemy that fired during this sortie', Object.fromEntries(Object.entries(enemyShots).map(([id, v]) => [id, v.length ? v.at(-1).n : 0])));
  note('EP part 2: player HP trace (t, HP)', hpLog.map((h) => [r3(h[0]), h[1]]));
  };
  if (parts.includes('1')) await part1();
  if (parts.includes('2')) await part2();
  row('EP.pageErrors', { check: 'EP: no console error / uncaught exception', where, measured: game.errors.slice(0, 3), expected: [], pass: game.errors.length === 0 });
  await game.close();
}

// ───────────────────────────── U1: pause, resume, pointer lock ─────────────────────────────
async function U1() {
  const where = WHERE_R;
  const lockedTag = (page) => L.evaluate(page, () => (document.pointerLockElement ? document.pointerLockElement.tagName : null));
  const menu = (page) =>
    L.evaluate(page, () => {
      const vis = (sel) => {
        const e = document.querySelector(sel);
        return !!e && getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0;
      };
      return { pause: vis('.menu-pause'), plerr: vis('.menu-plerr'), hud: vis('.ak2-hud'), garage: vis('[data-ui="garage"]'), notice: vis('.gar-notice') ? document.querySelector('.gar-notice').textContent.trim() : null, reason: vis('.plerr-reason') ? document.querySelector('.plerr-reason').textContent.trim() : null };
    });
  let game = await L.openGame(browser, { width: GW, height: GH });
  let page = game.page;
  await installProbes(page);
  const freeBefore = await lockedTag(page);
  const first = await L.sortie(page);
  const tag = await lockedTag(page);
  const later = await L.waitSimSeconds(page, 0.5);
  row('U1.sortieClick', {
    check: 'the click on 出撃 acquires the pointer lock (browser\'s own Pointer Lock API) and is not a shot',
    where,
    specRef: '§9',
    input: 'real click on the 出撃 button, then 0.5 s of simulation time',
    measured: { lockBefore: freeBefore, lockAfter: tag, state: first.state, shots: later.recentPlayerShots.length, ammo: later.player.ammo, en: later.player.en },
    expected: 'pointerLockElement null → CANVAS, state playing, 0 shot records, ammunition 300 / 12',
    pass: freeBefore === null && tag === 'CANVAS' && first.state === 'playing' && later.recentPlayerShots.length === 0 && later.player.ammo.machinegun === 300 && later.player.ammo.missile === 12,
  });
  const kinds = {
    escape: 'Escape key (real key event; headless delivers the keydown)',
    pointerlock: 'pointer-lock loss (document.exitPointerLock() → the real pointerlockchange)',
    blur: 'window blur (script-dispatched blur event: SIMULATED, a headless window has no focus changes)',
    visibility: 'hidden tab (visibilityState overridden + script-dispatched visibilitychange: SIMULATED)',
  };
  for (const how of Object.keys(kinds)) {
    const z = (await L.snap(page)).player.position[2];
    const walkKey = z - 40 >= 95 - z ? 'KeyW' : 'KeyS';
    await L.keyDown(page, walkKey);
    await L.waitSimSeconds(page, 0.4);
    await L.mouseDown(page);
    await L.waitSimSeconds(page, 0.3);
    await L.startFrameTrace(page);
    const moving = await L.snap(page);
    const paused = await L.pauseBy(page, how);
    await L.mouseUp(page);
    const A = await L.snap(page);
    const wall0 = Date.now();
    await L.sleep(2300);
    await L.waitFrames(page, 3);
    const B = await L.snap(page);
    const wall = (Date.now() - wall0) / 1000;
    const ui = await menu(page);
    const d = diffPaths(A, B);
    row(`U1.pause.${how}`, {
      check: `pause by ${kinds[how]}: state 'paused', menu shown, pointer released, and the whole snapshot identical after ${wall.toFixed(1)} s of real time`,
      where,
      specRef: '§9 §11',
      input: `${walkKey} held (walking) + left button held (firing) in the start dock, then the trigger; the walk key stays physically down`,
      measured: { state: paused.state, menu: ui.pause, pointerLock: await lockedTag(page), movingSpeed: r3(speedH(moving)), shotsBefore: moving.recentPlayerShots.length, t: [A.elapsedSeconds, B.elapsedSeconds], realSeconds: r3(wall), identical: d.length === 0, differences: d, en: A.player.en, velocity: A.player.velocity.map(r3) },
      expected: 'paused; every field of the snapshot unchanged (time, position, velocity, EN, enemies, shots, lock, cooldowns)',
      pass: paused.state === 'paused' && ui.pause && (await lockedTag(page)) === null && speedH(moving) > 5 && moving.recentPlayerShots.length > 0 && d.length === 0 && wall >= 2,
    });
    const lastShot = B.recentPlayerShots.at(-1).id;
    const ammo = B.player.ammo.machinegun;
    const resumed = await L.resume(page);
    await L.waitSimSeconds(page, 0.4);
    const r1 = await L.snap(page);
    const r2 = await L.waitSimSeconds(page, 0.5);
    const frames = await L.stopFrameTrace(page);
    const steps = L.resumeSteps(frames);
    const lead = L.maxSimLead(frames);
    const pausedFrames = frames.filter((f) => f.state === 'paused');
    row(`U1.resume.${how}`, {
      check: `resume after ${how}: the first rendered frame is at exactly the paused time (the ${wall.toFixed(1)} s spent paused are not simulated); the resume click fires nothing; the key held since before the pause does nothing until released`,
      where,
      specRef: '§9 §11',
      input: 'real click on 再開; frame recorder (test-side) over pause and resume; 0.9 s of simulation time afterwards',
      measured: { resumeSteps: steps, pausedAt: B.elapsedSeconds, pausedFrames: pausedFrames.length, simTimeOverPausedFrames: [...new Set(pausedFrames.map((f) => f.t))], maxSimLeadSeconds: lead, firstSeenPlayingAt: resumed.elapsedSeconds, lock: await lockedTag(page), lastShotId: [lastShot, r2.recentPlayerShots.at(-1).id], ammo: [ammo, r2.player.ammo.machinegun], movedWithHeldKey: len(sub(r2.player.position, r1.player.position)), speed: speedH(r2) },
      expected: 'one pause → resume step with added = 0 s at the paused time; simulation never ahead of real frame time by more than one tick; no new shot; position unchanged while the stale key is down',
      pass: steps.length === 1 && steps[0].added === 0 && steps[0].first === B.elapsedSeconds && pausedFrames.every((f) => f.t === B.elapsedSeconds) && lead <= TICK + 1e-6 && (await lockedTag(page)) === 'CANVAS' && r2.recentPlayerShots.at(-1).id === lastShot && r2.player.ammo.machinegun === ammo && len(sub(r2.player.position, r1.player.position)) < 1e-6,
    });
    await L.keyUp(page, walkKey);
    await L.waitSimSeconds(page, 0.3);
    lap('U1 ' + how);
  }
  // ── Q held at the resume ──
  await L.waitSimSeconds(page, 1.2);
  let s = await L.pauseBy(page, 'pointerlock');
  const c0 = s.player.movement.qbSuccessfulCount;
  const en0 = s.player.en;
  await L.keyDown(page, 'KeyQ');
  await L.sleep(300);
  await L.resume(page);
  await L.autoRepeat(page, 'KeyQ', 6, 40);
  s = await L.waitSimSeconds(page, 1.0);
  const heldCount = s.player.movement.qbSuccessfulCount;
  const heldEn = s.player.en;
  await L.keyUp(page, 'KeyQ');
  const zz = s.player.position[2];
  const dirKey = zz - 40 >= 95 - zz ? null : 'KeyS'; // boost towards the roomier side of the dock
  if (dirKey) await L.keyDown(page, dirKey);
  await L.tapKey(page, 'KeyQ');
  s = await L.waitForSnapshot(page, (x, c) => x.player.movement.qbSuccessfulCount > c || x.state !== 'playing', c0, { label: 'QB after release', timeout: 60000 }).catch(() => L.snap(page));
  if (dirKey) await L.keyUp(page, dirKey);
  row('U1.qHeldAtResume', {
    check: 'Q pressed during the pause and still down at the resume is not a quick boost; released and pressed again it is',
    where,
    specRef: '§9 (復帰時にQが既に押されていても新しい押下として処理せず)',
    input: 'pause (pointer-lock loss); keydown Q while paused; 再開; 6 auto-repeat keydowns; 1.0 s; keyup Q; Q tap',
    measured: { countBefore: c0, countWhileHeld: heldCount, en: [en0, heldEn], countAfterRepress: s.player.movement.qbSuccessfulCount },
    expected: `count ${c0} while held (EN not reduced), ${c0 + 1} after the new press`,
    pass: heldCount === c0 && heldEn >= en0 - 1e-9 && s.player.movement.qbSuccessfulCount === c0 + 1,
  });
  await L.holdKey(page, 'ControlLeft', 0.8);
  // ── a real tab switch (attempt) ──
  {
    await L.evaluate(page, () => {
      const ev = (window.__svEv = []);
      for (const [target, type] of [[window, 'blur'], [window, 'focus'], [document, 'visibilitychange'], [document, 'pointerlockchange']]) target.addEventListener(type, (e) => ev.push({ type, trusted: e.isTrusted, visibility: document.visibilityState, hasFocus: document.hasFocus(), state: window.__AK2__.getSnapshot().state }), true);
    });
    const cdp = await page.context().newCDPSession(page);
    let detail = '';
    try {
      await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    } catch (e) {
      detail = 'setFocusEmulationEnabled: ' + String(e.message).split('\n')[0];
    }
    const other = await page.context().newPage();
    await other.goto('about:blank');
    await other.bringToFront();
    await L.sleep(1500);
    const seen = await L.evaluate(page, () => ({ events: window.__svEv.slice(), state: window.__AK2__.getSnapshot().state, visibility: document.visibilityState, hasFocus: document.hasFocus() }));
    await page.bringToFront();
    await other.close();
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    await cdp.detach().catch(() => {});
    const realEvents = seen.events.filter((e) => e.trusted && (e.type === 'blur' || e.type === 'visibilitychange'));
    note('U1: attempt at a REAL focus loss (second tab brought to the front, focus emulation switched off through CDP)', { ...seen, detail });
    row('U1.realTabSwitch', {
      check: 'a second tab brought to the front (real browser events, not script-dispatched): the game pauses',
      where: realEvents.length ? where : 'not-measured',
      specRef: '§9',
      input: 'CDP Emulation.setFocusEmulationEnabled(false); context.newPage(); bringToFront()',
      measured: { trustedEvents: seen.events.filter((e) => e.trusted).map((e) => `${e.type}(${e.visibility}, focus ${e.hasFocus}) → ${e.state}`), stateAfter: seen.state },
      expected: realEvents.length ? "state 'paused' after a trusted blur / visibilitychange" : 'headless Chromium delivered no trusted blur / visibilitychange here: NOT MEASURED (kept apart from the results by --merge)',
      pass: realEvents.length ? seen.state === 'paused' : false,
    });
    if ((await L.snap(page)).state === 'paused') await L.resume(page);
  }
  const end = await L.snap(page);
  row('U1.pageErrors', { check: 'U1 (pause): no console error / uncaught exception; still playing unharmed in the dock', where, measured: { errors: game.errors.slice(0, 3), state: end.state, hp: end.player.hp }, expected: 'no errors, playing, HP 1000', pass: game.errors.length === 0 && end.state === 'playing' && end.player.hp === 1000 });
  await game.close();

  // ── pointer-lock failure (test-side fault injection: requestPointerLock answers as the test says) ──
  const faultInit = () => {
    const proto = Element.prototype;
    const original = proto.requestPointerLock;
    window.__svLock = { mode: 'reject', calls: 0 };
    proto.requestPointerLock = function (...args) {
      window.__svLock.calls++;
      if (window.__svLock.mode === 'ok') return original.apply(this, args);
      return Promise.reject(new DOMException('refused by the test', 'NotAllowedError'));
    };
  };
  game = await L.openGame(browser, { width: GW, height: GH, initScript: faultInit });
  page = game.page;
  await L.clickAct(page, 'sortie');
  await page.waitForFunction(() => !!document.querySelector('.gar-notice:not(.is-off)') && document.querySelector('.gar-notice:not(.is-off)').textContent.trim().length > 0, null, { timeout: 30000 }).catch(() => {});
  await L.sleep(1200);
  let ui = await menu(page);
  s = await L.snap(page);
  const sortieVisible = await L.actVisible(page, 'sortie');
  await L.screenshot(page, 'U1-lock-refused-garage-800x450', { dir: SHOTS });
  row('U1.lockRefused.sortie', {
    check: 'pointer lock refused at the sortie: an explanation and the way to retry are shown; the sortie does not start (no combat without control)',
    where: WHERE_R,
    specRef: '§9',
    input: 'test-side: requestPointerLock rejects (NotAllowedError); real click on 出撃; 1.2 s',
    measured: { state: s.state, t: s.elapsedSeconds, notice: ui.notice, hud: ui.hud, garage: ui.garage, sortieButton: sortieVisible, calls: await L.evaluate(page, () => window.__svLock.calls) },
    expected: "state 'garage', time 0, HUD hidden, a notice that names the refusal and says to press the button again; the button is still there",
    pass: s.state === 'garage' && s.elapsedSeconds === 0 && !ui.hud && ui.garage && !!ui.notice && ui.notice.length > 10 && sortieVisible,
  });
  await L.evaluate(page, () => (window.__svLock.mode = 'ok'));
  const started = await L.sortie(page);
  ui = await menu(page);
  row('U1.lockRefused.retry', {
    check: 'retry (出撃 again) with a working lock: the sortie starts from time 0',
    where: WHERE_R,
    specRef: '§9',
    input: 'test-side: requestPointerLock works again; real click on 出撃',
    measured: { state: started.state, t: started.elapsedSeconds, lock: await lockedTag(page), garage: ui.garage, hud: ui.hud },
    expected: 'playing, pointer locked to the canvas, t ≤ one frame (0.25 s)',
    pass: started.state === 'playing' && started.elapsedSeconds <= 0.2501 && (await lockedTag(page)) === 'CANVAS' && !ui.garage && ui.hud,
  });
  await L.waitSimSeconds(page, 0.5);
  const paused = await L.pauseBy(page, 'pointerlock');
  await L.evaluate(page, () => (window.__svLock.mode = 'reject'));
  await L.clickAct(page, 'resume');
  await page.locator('.menu-plerr').waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
  const A = await L.snap(page);
  await L.sleep(1500);
  const B = await L.snap(page);
  ui = await menu(page);
  const retryBtn = await L.actVisible(page, 'resume');
  await L.screenshot(page, 'U1-lock-refused-resume-800x450', { dir: SHOTS });
  row('U1.lockRefused.resume', {
    check: 'pointer lock refused at 再開: error panel with the reason and a retry button; the game stays paused and nothing advances',
    where: WHERE_R,
    specRef: '§9',
    input: 'pause; test-side: requestPointerLock rejects; real click on 再開; 1.5 s',
    measured: { state: B.state, panel: ui.plerr, reason: ui.reason, retryButton: retryBtn, t: [paused.elapsedSeconds, A.elapsedSeconds, B.elapsedSeconds], identical: sameJson(A, B) },
    expected: "error panel, state 'paused', same simulation time, identical snapshots",
    pass: B.state === 'paused' && ui.plerr && !!ui.reason && retryBtn && B.elapsedSeconds === paused.elapsedSeconds && sameJson(A, B),
  });
  await L.evaluate(page, () => (window.__svLock.mode = 'ok'));
  const resumed = await L.resume(page);
  row('U1.lockRefused.resumeRetry', {
    check: 'retry on the error panel with a working lock: play continues from the paused time',
    where: WHERE_R,
    specRef: '§9',
    input: 'real click on the retry button',
    measured: { state: resumed.state, pausedAt: paused.elapsedSeconds, firstSeenPlayingAt: resumed.elapsedSeconds, lock: await lockedTag(page) },
    expected: 'playing; time continues without a jump (≤ one frame of 0.25 s after the paused time)',
    pass: resumed.state === 'playing' && resumed.elapsedSeconds >= paused.elapsedSeconds && resumed.elapsedSeconds - paused.elapsedSeconds <= 0.2501 && (await lockedTag(page)) === 'CANVAS',
  });
  row('U1.lock.pageErrors', { check: 'U1 (lock failure): no console error / uncaught exception (the rejections are handled)', where: WHERE_R, measured: game.errors.slice(0, 3), expected: [], pass: game.errors.length === 0 });
  await game.close();
}

// ───────────────────────────── R1: resize; lock circle in snapshot, DOM and pixels ─────────────────────────────
async function R1() {
  const where = WHERE_S;
  playSize = null;
  const game = await L.openGame(browser, { width: 1280, height: 720, scripted: SCRIPTED });
  const page = game.page;
  await L.clockFreeze(page);
  await installProbes(page);
  /** HUD blocks and whether they lie inside the window. */
  const panels = () =>
    L.evaluate(page, () => {
      const out = [];
      for (const sel of ['.hud-top-left', '.hud-top-right', '.hud-top-center', '.hud-left', '.hud-right', '.hud-bottom', '.hud-panel']) {
        for (const e of document.querySelectorAll(sel)) {
          const st = getComputedStyle(e);
          const r = e.getBoundingClientRect();
          if (st.display === 'none' || st.visibility === 'hidden' || r.width === 0 || r.height === 0) continue;
          out.push({ sel, l: r.left, t: r.top, r: r.right, b: r.bottom, inside: r.left >= -0.5 && r.top >= -0.5 && r.right <= window.innerWidth + 0.5 && r.bottom <= window.innerHeight + 0.5 });
        }
      }
      return out;
    });
  /** Radius of the drawn lock ring from the pixels: screenshot with and without the ring element, radial mean of the changed pixels. */
  const ringPixels = async (w, h, expected) => {
    await L.waitFrames(page, 3);
    const a = L.decodePng(await page.screenshot({ timeout: L.TIMEOUT }));
    await L.evaluate(page, () => {
      for (const e of document.querySelectorAll('.hud-lock-ring')) e.style.visibility = 'hidden';
    });
    await L.waitFrames(page, 3);
    const b = L.decodePng(await page.screenshot({ timeout: L.TIMEOUT }));
    await L.evaluate(page, () => {
      for (const e of document.querySelectorAll('.hud-lock-ring')) e.style.visibility = '';
    });
    const cx = w / 2;
    const cy = h / 2;
    let n = 0;
    let sum = 0;
    let min = Infinity;
    let max = 0;
    let far = 0;
    const band = 14;
    for (let y = 0; y < a.height; y++) {
      for (let x = 0; x < a.width; x++) {
        const i = (y * a.width + x) * a.channels;
        const j = (y * b.width + x) * b.channels;
        const diff = Math.abs(a.data[i] - b.data[j]) + Math.abs(a.data[i + 1] - b.data[j + 1]) + Math.abs(a.data[i + 2] - b.data[j + 2]);
        if (diff <= 24) continue;
        const r = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        if (Math.abs(r - expected) > band) {
          far++;
          continue;
        }
        n++;
        sum += r;
        min = Math.min(min, r);
        max = Math.max(max, r);
      }
    }
    return { changedPixels: n, meanRadius: n ? sum / n : null, minRadius: n ? min : null, maxRadius: n ? max : null, changedElsewhere: far };
  };
  const measure = async (id, label, w, h, factor, withPixels) => {
    await page.setViewportSize({ width: w, height: h });
    await L.waitFrames(page, 3);
    const s = await L.snap(page);
    const d = await L.measureDisplay(page);
    const p = await panels();
    const want = factor * Math.min(w, h);
    const px = withPixels ? await ringPixels(w, h, want) : null;
    const canvasOk = d.canvasRect.x === 0 && d.canvasRect.y === 0 && d.canvasRect.width === w && d.canvasRect.height === h && d.canvasBuffer.width === w * d.window.dpr && d.canvasBuffer.height === h * d.window.dpr && !d.scrollable;
    const ringOk = !!d.ring && Math.abs(d.ring.radiusX - want) < 0.01 && Math.abs(d.ring.radiusY - want) < 0.01 && Math.abs(d.ring.centreX - w / 2) < 0.01 && Math.abs(d.ring.centreY - h / 2) < 0.01;
    const outside = p.filter((q) => !q.inside);
    row(id, {
      check: `${label} ${w}×${h}: lock radius = ${factor} × min(w, h) in the snapshot and in the drawn circle${withPixels ? ' (DOM and pixels)' : ' (DOM)'}; canvas fills the window; HUD blocks inside the window`,
      where,
      specRef: '§1 §5 §8',
      input: `setViewportSize(${w}, ${h}) while ${s.state}`,
      measured: { state: s.state, snapshotRadius: s.lock.radiusCssPx, domRing: d.ring && { radiusX: r3(d.ring.radiusX), radiusY: r3(d.ring.radiusY), centre: [r3(d.ring.centreX), r3(d.ring.centreY)] }, pixels: px && { changedPixels: px.changedPixels, meanRadius: r3(px.meanRadius), min: r3(px.minRadius), max: r3(px.maxRadius) }, canvas: d.canvasRect, buffer: d.canvasBuffer, scrollable: d.scrollable, hudBlocks: p.length, hudBlocksOutside: outside.map((q) => `${q.sel} [${Math.round(q.l)},${Math.round(q.t)},${Math.round(q.r)},${Math.round(q.b)}]`) },
      expected: `radius ${r6(want)} px, centre (${w / 2}, ${h / 2})${withPixels ? '; ring pixels at that radius ± 1 px' : ''}; canvas 0,0,${w},${h}; no HUD block outside`,
      pass: Math.abs(s.lock.radiusCssPx - want) < 1e-9 && canvasOk && ringOk && outside.length === 0 && p.length >= 5 && (!px || (px.changedPixels > want && Math.abs(px.meanRadius - want) <= 1)),
    });
  };
  let n = 0;
  for (const fcs of ['wide', 'medium', 'narrow']) {
    await page.setViewportSize({ width: 1280, height: 720 });
    await L.selectLoadout(page, { fcs });
    await into(page, 'sortie');
    await run(page, 2, 2);
    const f = FCS[fcs][0];
    await measure(`F4.radius.${fcs}.1280x720`, `${fcs} FCS, playing,`, 1280, 720, f, true);
    await measure(`F4.radius.${fcs}.1920x1080`, `${fcs} FCS, playing,`, 1920, 1080, f, fcs === 'medium');
    if (fcs === 'medium') {
      await measure('R1.playing.1000x720', 'live resize, medium FCS, playing,', 1000, 720, f, true);
      await measure('R1.playing.1280x720', 'live resize back, medium FCS, playing,', 1280, 720, f, false);
      const still = await run(page, 2, 2);
      row('R1.playing.alive', { check: 'after the resizes the game still runs with the pointer locked', where, specRef: '§1', input: '2 frames', measured: { state: still.state, t: still.elapsedSeconds, locked: await L.evaluate(page, () => document.pointerLockElement !== null) }, expected: 'playing, time advancing', pass: still.state === 'playing' && still.elapsedSeconds > 0 });
      await escPause(page);
      await measure('R1.paused.1920x1080', 'medium FCS, paused,', 1920, 1080, f, false);
      await measure('R1.paused.1000x720', 'medium FCS, paused,', 1000, 720, f, false);
      await measure('R1.paused.1280x720', 'medium FCS, paused,', 1280, 720, f, false);
      const menuIn = await L.evaluate(page, () => {
        const r = document.querySelector('.menu-pause').getBoundingClientRect();
        return r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight;
      });
      const resumed = await into(page, 'resume');
      row('R1.paused.resume', { check: 'pause menu inside the window after the resizes; resume works', where, specRef: '§1 §9', input: '再開 after resizing while paused', measured: { menuInside: menuIn, state: resumed.state }, expected: 'inside, playing', pass: menuIn && resumed.state === 'playing' });
    }
    await page.setViewportSize({ width: 1280, height: 720 });
    await L.waitFrames(page, 2);
    await escPause(page);
    await L.toGarage(page);
    lap('R1 ' + fcs);
    n++;
  }
  row('R1.pageErrors', { check: 'R1: no console error / uncaught exception', where, measured: game.errors.slice(0, 3), expected: [], pass: game.errors.length === 0 && n === 3 });
  await game.close();
}

// ═════════════════════════════ main ═════════════════════════════
const GROUPS = { S: [S1, WHERE_S], M1: [M1, WHERE_R], M2q: [M2q, WHERE_S], M3: [M3, WHERE_S], M4: [M4, WHERE_S], M5: [M5, WHERE_S], M6: [M6, WHERE_S], FC: [FC, WHERE_S], PM: [PM, WHERE_S], EP: [EP, WHERE_S], U1: [U1, WHERE_R], R1: [R1, WHERE_S] };

if (flag('merge')) {
  if (!OUT) throw new Error('--merge needs --out=<dir>');
  const files = fs.readdirSync(OUT).filter((f) => /^rows-.*\.json$/.test(f)).sort();
  const byId = new Map();
  const allNotes = [];
  const allDefects = [];
  for (const f of files) {
    const j = JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8'));
    for (const r of j.rows) if (!byId.has(r.id) || byId.get(r.id).at < r.at) byId.set(r.id, { ...r, group: j.group });
    for (const n of j.notes) allNotes.push({ ...n, group: j.group });
    for (const d of j.defects) allDefects.push({ ...d, group: j.group });
  }
  // rows a section could not measure in this browser are kept apart: they are neither a pass nor a failure
  const merged = [...byId.values()].filter((r) => r.where !== 'not-measured');
  const notMeasured = [...byId.values()].filter((r) => r.where === 'not-measured');
  const result = { generatedAt: new Date().toISOString(), files, passed: merged.filter((r) => r.pass).length, failed: merged.filter((r) => !r.pass).length, rows: merged, notMeasured, notes: allNotes, defects: allDefects };
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(result, null, 1));
  console.log(`merged ${files.length} files → ${path.join(OUT, 'results.json')}: ${result.passed} passed, ${result.failed} failed`);
  for (const r of merged) if (!r.pass) console.log('  FAILED ' + r.id + '  ' + r.check);
  process.exit(result.failed === 0 ? 0 : 1);
}

console.log(`=== spec-verify — ${L.BASE_URL} — groups: ${ONLY ? ONLY.join(', ') : 'all'} — ${new Date().toISOString()} ===`);
try {
  for (const [id, [fn, where]] of Object.entries(GROUPS)) if (want(id)) await section(id, where, fn);
} finally {
  await browser.close().catch(() => {});
  save();
}
const measured = rows.filter((r) => r.where !== 'not-measured');
const failed = measured.filter((r) => !r.pass);
console.log(`\n=== spec-verify: ${measured.length - failed.length} passed, ${failed.length} failed, ${rows.length - measured.length} not measured (${rows.length} rows) in ${((Date.now() - T0) / 1000).toFixed(0)} s ===`);
for (const r of failed) console.log('  FAILED [' + r.id + '] ' + r.check);
process.exit(failed.length === 0 ? 0 : 1);
