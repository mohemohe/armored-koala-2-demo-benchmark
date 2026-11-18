#!/usr/bin/env node
/**
 * Application smoke test: the wiring of simulation, renderer, HUD, garage, menus and input (src/app.ts),
 * driven through a real (headless) browser with real keyboard / mouse input and the read-only snapshot.
 *
 *   AK2_URL=http://127.0.0.1:5173/ node tools/e2e/app-smoke.mjs [--only=a,b,…] [--shots=<dir>] [--size=800x450]
 *                                                               [--triggers=pointerlock,escape,blur,visibility]
 *
 * Sections (each opens its own page, so they can be run individually with --only):
 *   a  page load: loading indication, window.__AK2__ (frozen, one member, copies), version, seed query
 *   b  garage: all 18 builds in the snapshot; sortie click → pointer lock → playing; the click fires no shot
 *   c  controls: W moves, mouse turns the view, left button fires, 1/2/3 switch weapons, Q = one quick boost
 *   d  pause by pointer-lock loss / Esc / window blur / hidden tab: everything frozen; resume without a jump
 *   e  Q held across pause → resume: no quick boost until released and pressed again
 *   f  pointer-lock failure: explanation + retry, never 'playing', simulation time does not advance
 *   g  mini-stage harness (dev/app-test.html): fell / destroyed / cleared by really playing, result screen,
 *      re-sortie and garage with a complete reset
 *   h  five sortie → garage cycles: no duplicated listeners / frame loops / DOM nodes; unload guard
 *   i  resize in garage / playing / paused: lock circle = factor × min(w, h) in the snapshot and on screen
 *   j  WebGL unavailable: readable message, no uncaught error
 *   s  screenshots at 1280×720 (needs --shots=<dir>): garage, help, playing, paused, pause help
 *
 * Sections a–f, h–j and s run on the shipped page (factory stage), g on the harness page (same App class).
 * Simulation-time based throughout (see lib.mjs): the playing state runs in slow motion in this browser.
 */
import * as L from './lib.mjs';

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const only = arg('only') ? new Set(arg('only').split(',')) : null;
const want = (id) => !only || only.has(id);
const [W, H] = (arg('size') || '800x450').split('x').map(Number);

// ───────── numbers of docs/SPEC.md, written out here on purpose (independent of src/config.ts) ─────────
const VERSION = 'AK2-1.2-candidate';
const DEFAULT_SEED = 20260908;
const GEN = { capacity: [180, 10], balanced: [120, 15], recovery: [90, 20] };
const FCS = { wide: [0.3, 1.2], medium: [0.2, 0.8], narrow: [0.1, 0.4] };
const LEGS = { biped: [1.0, 1.0, 1.0], quadruped: [0.8, 0.75, 1.5] };
const SENS = 0.0022; // rad per CSS px of mouse movement
const expectedStats = (l) => ({
  maxEn: GEN[l.generator][0],
  regenPerSecond: GEN[l.generator][1] * LEGS[l.legs][1],
  lockSeconds: FCS[l.fcs][1] / LEGS[l.legs][2],
  horizontalSpeedMultiplier: LEGS[l.legs][0],
});
const sameLoadout = (a, b) => a.fcs === b.fcs && a.generator === b.generator && a.legs === b.legs;
const statsEqual = (a, e) => Object.keys(e).every((k) => L.near(a[k], e[k], 1e-9));

/** Body yaw from a shot's muzzle position: muzzle − centre = right·0.9 + up·0.75 + forward·0.85. */
function yawFromMuzzle(muzzle, centre) {
  const ox = muzzle[0] - centre[0];
  const oz = muzzle[2] - centre[2];
  return Math.atan2(-0.85 * ox - 0.9 * oz, 0.9 * ox - 0.85 * oz);
}
const angDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const speedH = (s) => Math.hypot(s.player.velocity[0], s.player.velocity[2]);
const lockedElement = (page) => page.evaluate(() => (document.pointerLockElement ? document.pointerLockElement.tagName : null));
const uiState = (page) =>
  page.evaluate(() => {
    const vis = (sel) => {
      const e = document.querySelector(sel);
      return !!e && getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0;
    };
    const text = (sel) => {
      const e = document.querySelector(sel);
      return e ? e.textContent.trim() : null;
    };
    return {
      garage: vis('[data-ui="garage"]'),
      menus: vis('[data-ui="menus"]'),
      pause: vis('.menu-pause'),
      result: vis('.menu-result'),
      plerr: vis('.menu-plerr'),
      hud: vis('.ak2-hud'),
      loading: vis('.ak2-shell-msg'),
      notice: vis('.gar-notice') ? text('.gar-notice') : null,
      resultTitle: text('.res-title'),
      resultSub: text('.res-sub'),
      plerrReason: text('.plerr-reason'),
    };
  });

/** One tap of the fire button: returns the snapshot after the shot(s) of this tap were recorded. */
async function tapFire(page, simSeconds = 0.05) {
  const before = (await L.snap(page)).recentPlayerShots.at(-1)?.id ?? 0;
  await L.mouseDown(page);
  await L.waitForSnapshot(page, (s, id) => (s.recentPlayerShots.at(-1)?.id ?? 0) > id || s.state !== 'playing', before, { label: 'a shot' });
  if (simSeconds > 0.05) await L.waitSimSeconds(page, simSeconds);
  await L.mouseUp(page);
  await L.waitFrames(page, 2);
  return L.snap(page);
}

const browser = await L.launch();
const checks = new L.Checks('app-smoke');
const t0 = Date.now();
const lap = (text) => console.log(`      [${((Date.now() - t0) / 1000).toFixed(0)} s] ${text}`);

try {
  // ═══════════════════════════ a. page load ═══════════════════════════
  if (want('a'))
    await checks.section('a. page load, read-only API, version, seed', async () => {
      const game = await L.openGame(browser, { width: W, height: H, waitReady: false });
      const page = game.page;
      const atLoad = await page.evaluate(() => {
        const api = window.__AK2__;
        const s = api && typeof api.getSnapshot === 'function' ? api.getSnapshot() : null;
        const msg = document.querySelector('.ak2-shell-msg');
        return {
          type: typeof api,
          frozen: !!api && Object.isFrozen(api),
          keys: api ? Object.getOwnPropertyNames(api) : null,
          state: s && s.state,
          version: s && s.version,
          seed: s && s.seed,
          elapsed: s && s.elapsedSeconds,
          topKeys: s && Object.keys(s),
          enemies: s && s.enemies.length,
          title: document.title,
          lang: document.documentElement.lang,
          loadingShown: !!msg && getComputedStyle(msg).display !== 'none',
          loadingText: msg ? msg.textContent : null,
          garageShown: !!document.querySelector('[data-act="sortie"]'),
        };
      });
      checks.check('a: window.__AK2__ exists right after the load event', atLoad.type === 'object' && atLoad.state != null, atLoad.type);
      checks.check('a: __AK2__ is frozen with exactly one member getSnapshot', atLoad.frozen && JSON.stringify(atLoad.keys) === '["getSnapshot"]', atLoad.keys);
      checks.check("a: state 'garage' before the first sortie, elapsedSeconds 0", atLoad.state === 'garage' && atLoad.elapsed === 0, { state: atLoad.state, t: atLoad.elapsed });
      checks.check(`a: version ${VERSION}`, atLoad.version === VERSION, atLoad.version);
      checks.check(`a: default seed ${DEFAULT_SEED}`, atLoad.seed === DEFAULT_SEED, atLoad.seed);
      const wantKeys = ['version', 'seed', 'state', 'elapsedSeconds', 'loadout', 'player', 'effectiveStats', 'lock', 'fireControl', 'recentPlayerShots', 'enemies', 'objective', 'stage'];
      checks.check('a: snapshot has the SPEC §10 top-level members', wantKeys.every((k) => atLoad.topKeys.includes(k)) && atLoad.topKeys.length === wantKeys.length, atLoad.topKeys);
      checks.check('a: 45 enemies in the snapshot', atLoad.enemies === 45, atLoad.enemies);
      checks.check('a: title and lang', atLoad.title === 'ARMORED KOALA 2 DEMO' && atLoad.lang === 'ja', { title: atLoad.title, lang: atLoad.lang });
      checks.check('a: a loading indication is on screen while the renderer is built', atLoad.loadingShown && !atLoad.garageShown, atLoad.loadingText);

      const tamper = await page.evaluate(() => {
        const before = window.__AK2__;
        const fn = before.getSnapshot;
        let threw = 0;
        for (const f of [() => (window.__AK2__ = {}), () => (window.__AK2__.cheat = 1), () => (window.__AK2__.getSnapshot = () => 0), () => delete window.__AK2__]) {
          try {
            f();
          } catch {
            threw++;
          }
        }
        return { same: window.__AK2__ === before && window.__AK2__.getSnapshot === fn, keys: Object.getOwnPropertyNames(window.__AK2__), threw };
      });
      checks.check('a: __AK2__ cannot be replaced, extended or deleted', tamper.same && tamper.keys.length === 1, tamper);
      const copy = await page.evaluate(() => {
        const a = window.__AK2__.getSnapshot();
        a.player.hp = 1;
        a.player.position[0] = 999;
        a.enemies.length = 0;
        a.loadout.fcs = 'narrow';
        a.state = 'cleared';
        const b = window.__AK2__.getSnapshot();
        return { hp: b.player.hp, x: b.player.position[0], enemies: b.enemies.length, fcs: b.loadout.fcs, state: b.state, distinct: a !== b };
      });
      checks.check('a: snapshots are copies (editing one changes nothing)', copy.hp === 1000 && copy.x !== 999 && copy.enemies === 45 && copy.fcs === 'medium' && copy.state === 'garage' && copy.distinct, copy);

      await L.waitReady(page);
      lap('garage ready');
      const ui = await uiState(page);
      checks.check('a: after start-up the garage is shown, loading indication and HUD are hidden', ui.garage && !ui.loading && !ui.hud && !ui.menus, ui);
      const s = await L.snap(page);
      checks.check("a: still state 'garage' at time 0 with the default build", s.state === 'garage' && s.elapsedSeconds === 0 && sameLoadout(s.loadout, { fcs: 'medium', generator: 'balanced', legs: 'biped' }), { state: s.state, loadout: s.loadout });

      // globals added by the page = exactly __AK2__ (compared with an empty document of the same browser)
      const names = await page.evaluate(() => Object.getOwnPropertyNames(window));
      const blank = await game.context.newPage();
      await blank.route('**/__e2e_blank__', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="ja"><head><title>blank</title></head><body></body></html>' }));
      await blank.goto(L.BASE_URL + '__e2e_blank__');
      const base = new Set(await blank.evaluate(() => Object.getOwnPropertyNames(window)));
      await blank.close();
      const added = names.filter((n) => !base.has(n) && !/^\d+$/.test(n));
      checks.check('a: the page adds no global other than __AK2__', added.length === 1 && added[0] === '__AK2__', added);
      const origin = new URL(L.BASE_URL).origin;
      const foreign = game.requests.filter((u) => !u.startsWith(origin) && !u.startsWith('data:') && !u.startsWith('blob:'));
      checks.check('a: no request leaves the origin (no external resources)', foreign.length === 0, { requests: game.requests.length, foreign: foreign.slice(0, 3) });
      const disp = await L.measureDisplay(page);
      checks.check('a: canvas fills the window, no scrollbars', disp.canvasRect.x === 0 && disp.canvasRect.y === 0 && disp.canvasRect.width === W && disp.canvasRect.height === H && !disp.scrollable, disp.canvasRect);

      // seed query (the API is there at load, so the garage does not have to be awaited)
      const seeds = [
        ['123', 123],
        ['0', 0],
        ['4294967295', 4294967295],
        ['4294967296', DEFAULT_SEED],
        ['-1', DEFAULT_SEED],
        ['abc', DEFAULT_SEED],
        ['1.5', DEFAULT_SEED],
        ['', DEFAULT_SEED],
        ['12 34', DEFAULT_SEED],
        ['0x10', DEFAULT_SEED],
      ];
      const got = [];
      for (const [value] of seeds) {
        await page.goto(L.urlFor('', { seed: value }), { waitUntil: 'load', timeout: L.TIMEOUT });
        got.push(await page.evaluate(() => window.__AK2__.getSnapshot().seed));
      }
      checks.check('a: ?seed=123 → 123', got[0] === 123, got[0]);
      checks.check('a: ?seed=0 and ?seed=4294967295 are accepted', got[1] === 0 && got[2] === 4294967295, got.slice(1, 3));
      checks.check(
        'a: invalid seeds (4294967296, -1, abc, 1.5, empty, "12 34", 0x10) → default',
        got.slice(3).every((v) => v === DEFAULT_SEED),
        got.slice(3),
      );
      checks.noPageErrors(game, 'a: no console errors / uncaught exceptions');
      await game.close();
    });

  // ═══════════════════════════ b + c. garage, sortie, controls ═══════════════════════════
  if (want('b') || want('c'))
    await checks.section('b/c. garage → sortie → controls', async () => {
      const game = await L.openGame(browser, { width: W, height: H });
      const page = game.page;
      const D = Math.min(W, H);

      // ── b: every build shows up in the snapshot ──
      let cur = { fcs: 'medium', generator: 'balanced', legs: 'biped' };
      const bad = [];
      const samples = [];
      let n = 0;
      for (const legs of ['biped', 'quadruped'])
        for (const generator of ['balanced', 'capacity', 'recovery'])
          for (const fcs of ['medium', 'wide', 'narrow']) {
            const next = { fcs, generator, legs };
            const diff = {};
            for (const k of ['fcs', 'generator', 'legs']) if (next[k] !== cur[k]) diff[k] = next[k];
            const s = await L.selectLoadout(page, diff);
            cur = next;
            n++;
            const e = expectedStats(next);
            const ok =
              s.state === 'garage' &&
              s.elapsedSeconds === 0 &&
              sameLoadout(s.loadout, next) &&
              statsEqual(s.effectiveStats, e) &&
              s.player.en === e.maxEn &&
              s.player.hp === 1000 &&
              L.near(s.lock.radiusCssPx, FCS[fcs][0] * D, 1e-9);
            if (!ok) bad.push({ next, loadout: s.loadout, stats: s.effectiveStats, en: s.player.en, r: s.lock.radiusCssPx });
            if (n === 1 || n === 14 || n === 18) samples.push({ build: `${fcs}/${generator}/${legs}`, ...s.effectiveStats, en: s.player.en, lockRadiusPx: s.lock.radiusCssPx });
          }
      checks.check('b: all 18 builds: snapshot loadout, effectiveStats, player.en = max EN, lock radius = factor × min(w,h)', n === 18 && bad.length === 0, bad.length ? bad.slice(0, 2) : samples);
      const medQuad = await L.selectLoadout(page, { fcs: 'medium', generator: 'balanced', legs: 'quadruped' });
      checks.check('b: medium / balanced / quadruped → 120 EN, 11.25 EN/s, 0.5333 s lock, ×0.80', statsEqual(medQuad.effectiveStats, { maxEn: 120, regenPerSecond: 11.25, lockSeconds: 0.8 / 1.5, horizontalSpeedMultiplier: 0.8 }), medQuad.effectiveStats);

      // ── b: sortie ──
      const build = { fcs: 'wide', generator: 'capacity', legs: 'biped' };
      await L.selectLoadout(page, build);
      const first = await L.sortie(page);
      lap('playing');
      checks.check("b: sortie click → state 'playing'", first.state === 'playing', first.state);
      checks.check('b: pointer lock is held by the game canvas', (await lockedElement(page)) === 'CANVAS', await lockedElement(page));
      checks.check('b: the sortie uses the selected build (wide / capacity / biped, EN 180)', sameLoadout(first.loadout, build) && statsEqual(first.effectiveStats, expectedStats(build)) && first.player.en === 180, { loadout: first.loadout, en: first.player.en });
      let ui = await uiState(page);
      checks.check('b: HUD visible, garage and menus gone while playing', ui.hud && !ui.garage && !ui.menus, ui);
      const later = await L.waitSimSeconds(page, 0.5);
      checks.check('b: elapsedSeconds grows while playing', later.elapsedSeconds >= first.elapsedSeconds + 0.5, { first: first.elapsedSeconds, later: later.elapsedSeconds });
      checks.check('b: the sortie click fired no shot (no shot record, ammo 300 / 12, EN full)', later.recentPlayerShots.length === 0 && later.player.ammo.machinegun === 300 && later.player.ammo.missile === 12 && later.player.en === 180, { shots: later.recentPlayerShots.length, ammo: later.player.ammo, en: later.player.en });
      checks.check('b: start state: HP 1000, machine gun, grounded, 45 enemies alive, gate closed', later.player.hp === 1000 && later.player.weapon === 'machinegun' && later.player.grounded && later.enemies.every((e) => e.alive) && !later.objective.gateOpen && later.objective.controlsDestroyed === 0, { hp: later.player.hp, weapon: later.player.weapon });

      if (want('c')) {
        // ── c: W ──
        const p0 = await L.snap(page);
        await L.holdKey(page, 'KeyW', 1.0);
        const p1 = await L.waitSimSeconds(page, 0.4);
        const dz = p1.player.position[2] - p0.player.position[2];
        const dx = p1.player.position[0] - p0.player.position[0];
        checks.check('c: W held ≈1 s → the mech walks forward (−Z) and stops after release', dz < -5 && Math.abs(dx) < 0.3 && speedH(p1) < 0.01, { dz, dx, speedAfter: speedH(p1), simSeconds: p1.elapsedSeconds - p0.elapsedSeconds });

        // ── c: left button, free fire ──
        const a = await tapFire(page);
        const shotA = a.recentPlayerShots.at(-1);
        const yawA = yawFromMuzzle(shotA.muzzlePosition, a.player.position);
        checks.check('c: left button fires (shot recorded, ammo decreases by the number of shots)', a.recentPlayerShots.length >= 1 && a.player.ammo.machinegun === 300 - shotA.id, { shots: a.recentPlayerShots.length, lastId: shotA.id, ammo: a.player.ammo.machinegun });
        checks.check('c: the view did not swing at the sortie click / first shot (yaw still 0)', Math.abs(yawA) < 1e-6, { yaw: yawA, launchDirection: shotA.launchDirection });
        const v0 = shotA.initialVelocity;
        checks.check('c: MG shot record: free fire (inactive, no target), |v0| = 100 m/s, gravity (0,−18,0)', shotA.weapon === 'machinegun' && shotA.solutionStatus === 'inactive' && shotA.targetId === null && L.near(Math.hypot(v0[0], v0[1], v0[2]), 100, 1e-3) && L.vecNear(shotA.accelerationAtFire, [0, -18, 0], 1e-12), { speed: Math.hypot(v0[0], v0[1], v0[2]), acc: shotA.accelerationAtFire });

        // ── c: mouse look (real injected pointer movement under the emulated lock) ──
        await L.lookBy(page, 100, 0);
        const b = await tapFire(page);
        const shotB = b.recentPlayerShots.at(-1);
        const yawB = yawFromMuzzle(shotB.muzzlePosition, b.player.position);
        checks.check('c: mouse 100 px right → yaw −0.22 rad (0.0022 rad/px)', L.near(angDiff(yawB, yawA), -100 * SENS, 2e-3), { dyaw: angDiff(yawB, yawA), expected: -100 * SENS });
        await L.lookBy(page, 0, -60);
        const c = await tapFire(page);
        const shotC = c.recentPlayerShots.at(-1);
        checks.check('c: mouse 60 px up → the free-fire direction points higher, yaw unchanged', shotC.launchDirection[1] > shotB.launchDirection[1] + 0.08 && L.near(angDiff(yawFromMuzzle(shotC.muzzlePosition, c.player.position), yawB), 0, 1e-6), { dirY: [shotB.launchDirection[1], shotC.launchDirection[1]] });
        await L.lookBy(page, -100, 60);

        // ── c: held trigger = weapon cadence ──
        const beforeBurst = (await L.snap(page)).recentPlayerShots.at(-1).id;
        await L.fireFor(page, 0.6);
        await L.waitFrames(page, 2);
        const d = await L.snap(page);
        const burst = d.recentPlayerShots.filter((s) => s.id > beforeBurst);
        const gaps = burst.slice(1).map((s, i) => s.firedAtSeconds - burst[i].firedAtSeconds);
        const yawD = yawFromMuzzle(burst.at(-1).muzzlePosition, d.player.position);
        checks.check('c: trigger held → one shot every 0.10 s of simulation time', burst.length >= 6 && gaps.every((g) => L.near(g, 0.1, 1e-6)), { shots: burst.length, gaps: gaps.slice(0, 4) });
        checks.check('c: ammo = 300 − shots fired; firing does not move the view; mouse moved back → yaw 0 again', d.player.ammo.machinegun === 300 - burst.at(-1).id && L.near(yawD, yawA, 1e-6), { ammo: d.player.ammo.machinegun, lastId: burst.at(-1).id, yaw: yawD });

        // ── c: weapon keys ──
        await L.tapKey(page, 'Digit2');
        await L.waitFrames(page, 2);
        const w2 = await L.snap(page);
        const enBefore = w2.player.en;
        const e2 = await tapFire(page, 0.3);
        const beams = e2.recentPlayerShots.filter((s) => s.weapon === 'beam');
        const lastBeam = beams.at(-1);
        const regenAllowance = 10 * Math.max(0, e2.elapsedSeconds - lastBeam.firedAtSeconds - 0.75) + 1e-6;
        checks.check('c: 2 → beam; each beam shot costs 8 EN, no projectile velocity, MG ammo untouched', w2.player.weapon === 'beam' && beams.length >= 1 && lastBeam.initialVelocity === null && L.vecNear(lastBeam.accelerationAtFire, [0, 0, 0], 0) && e2.player.en >= enBefore - 8 * beams.length - 1e-6 && e2.player.en <= enBefore - 8 * beams.length + regenAllowance && e2.player.ammo.machinegun === d.player.ammo.machinegun && e2.player.movement.lastEnSpentAtSeconds === lastBeam.firedAtSeconds, { beams: beams.length, enBefore, en: e2.player.en });
        await L.tapKey(page, 'Digit3');
        await L.waitFrames(page, 2);
        const w3 = await L.snap(page);
        const shotsBefore = w3.recentPlayerShots.at(-1).id;
        await L.fireFor(page, 0.4);
        await L.waitFrames(page, 2);
        const e3 = await L.snap(page);
        checks.check('c: 3 → missile; without a lock the trigger fires nothing and uses no ammo', w3.player.weapon === 'missile' && e3.lock.state !== 'locked' && e3.recentPlayerShots.at(-1).id === shotsBefore && e3.player.ammo.missile === 12, { weapon: w3.player.weapon, lock: e3.lock.state, missiles: e3.player.ammo.missile });
        await L.tapKey(page, 'Digit1');
        await L.waitFrames(page, 2);
        const w1 = await L.snap(page);
        checks.check('c: 1 → machine gun; switching kept ammo', w1.player.weapon === 'machinegun' && w1.player.ammo.machinegun === d.player.ammo.machinegun && w1.player.ammo.missile === 12, { weapon: w1.player.weapon, ammo: w1.player.ammo });

        // ── c: quick boost = one press, one boost; then automatic glide; Left Ctrl brakes ──
        const q0 = await L.waitSimSeconds(page, 1.0); // let the beam's EN regenerate a little, any cooldown pass
        await L.tapKey(page, 'KeyQ');
        const q1 = await L.waitForSnapshot(page, (s) => s.player.movement.qbSuccessfulCount >= 1 || s.state !== 'playing', null, { label: 'QB' });
        const q2 = await L.waitSimSeconds(page, 0.5);
        checks.check('c: Q tap → exactly one quick boost, 36 EN paid once', q2.player.movement.qbSuccessfulCount === 1 && q1.player.movement.qbLastStartedAtSeconds !== null && q2.player.en <= q0.player.en + 10 * (q1.player.movement.qbLastStartedAtSeconds - q0.elapsedSeconds) - 36 + 1e-6 && q2.player.en >= q0.player.en - 36 - 1e-6, { count: q2.player.movement.qbSuccessfulCount, enBefore: q0.player.en, enAfter: q2.player.en });
        checks.check('c: after the boost the mech keeps gliding with no key held (glide on, mode glide, still moving)', q2.player.movement.glideEnabled && q2.player.movement.horizontalMode === 'glide' && speedH(q2) > 20, { mode: q2.player.movement.horizontalMode, speed: speedH(q2) });
        await L.holdKey(page, 'ControlLeft', 0.8);
        const q3 = await L.snap(page);
        checks.check('c: Left Ctrl → glide off, the mech stops', !q3.player.movement.glideEnabled && speedH(q3) < 0.01, { glide: q3.player.movement.glideEnabled, speed: speedH(q3) });
        // Q held for > 2 s with OS auto-repeat: still only one more boost
        await L.waitSimSeconds(page, 0.5);
        await L.keyDown(page, 'KeyS'); // this boost goes backwards, back into the start dock
        await L.keyDown(page, 'KeyQ');
        await L.waitForSnapshot(page, (x) => x.player.movement.qbSuccessfulCount >= 2 || x.state !== 'playing', null, { label: 'second QB' });
        await L.keyUp(page, 'KeyS');
        const holdStart = (await L.snap(page)).elapsedSeconds;
        while ((await L.snap(page)).elapsedSeconds < holdStart + 2.3) await L.autoRepeat(page, 'KeyQ', 3, 30);
        await L.keyUp(page, 'KeyQ');
        const q4 = await L.snap(page);
        checks.check('c: Q held > 2 s with auto-repeat → one more boost only', q4.player.movement.qbSuccessfulCount === 2 && q4.state === 'playing', { count: q4.player.movement.qbSuccessfulCount, heldSim: q4.elapsedSeconds - holdStart, z: q4.player.position[2] });
        await L.holdKey(page, 'ControlLeft', 0.8);
        checks.check('c: still alive and undetected (HP 1000) at the end', q4.player.hp === 1000, { hp: q4.player.hp, sector: q4.stage.currentSectorId });
      }
      checks.noPageErrors(game, 'b/c: no console errors / uncaught exceptions');
      await game.close();
    });

  // ═══════════════════════════ d + e. pause / resume ═══════════════════════════
  if (want('d') || want('e'))
    await checks.section('d/e. pause and resume', async () => {
      const game = await L.openGame(browser, { width: W, height: H });
      const page = game.page;
      await L.sortie(page);
      lap('playing');
      const kinds = {
        pointerlock: 'document.exitPointerLock() (real pointer-lock loss)',
        escape: 'Escape key (real key event)',
        blur: 'window blur (dispatched event)',
        visibility: 'hidden tab (visibilityState override + dispatched event)',
      };
      const triggers = arg('triggers') ? arg('triggers').split(',') : Object.keys(kinds);
      if (want('d'))
        for (const [index, how] of triggers.entries()) {
          // something must be in motion when the pause hits: walking, firing, bullets in flight.
          // The mech has to stay inside the sheltered start dock (start z = 90, back wall at z = 100, 60 m of
          // free lane ahead) however long the steps take on a slow machine: walk towards the middle of it.
          // (every step of this script costs up to one rendered frame = 0.25 s of walking, so on a slow machine
          //  one trigger can take the mech 30 m: go where there is more room — W towards z = 40, S towards z = 98.5)
          const zNow = (await L.snap(page)).player.position[2];
          const walkKey = zNow - 40 >= 98.5 - zNow ? 'KeyW' : 'KeyS';
          checks.note(`d[${how}]: trigger ${index + 1}, walking with ${walkKey} from z = ${zNow.toFixed(1)}`);
          await L.keyDown(page, walkKey);
          await L.waitSimSeconds(page, 0.4);
          await L.mouseDown(page);
          await L.waitSimSeconds(page, 0.3);
          await L.startFrameTrace(page);
          const moving = await L.snap(page);
          const paused = await L.pauseBy(page, how);
          await L.mouseUp(page); // the player lets go of the button; the walk key stays physically down
          const A = await L.snap(page);
          await L.sleep(2300);
          await L.waitFrames(page, 3); // (on a very slow machine 2.3 s can be a single frame: see at least three)
          const B = await L.snap(page);
          const ui = await uiState(page);
          checks.check(`d[${how}]: ${kinds[how]} → state 'paused', pause menu shown, pointer lock released`, paused.state === 'paused' && ui.pause && (await lockedElement(page)) === null && (await L.actVisible(page, 'resume')), { state: paused.state, menu: ui.pause });
          checks.check(`d[${how}]: the mech was moving and firing when paused`, speedH(moving) > 5 && moving.recentPlayerShots.length > 0, { speed: speedH(moving), shots: moving.recentPlayerShots.length });
          checks.check(`d[${how}]: whole snapshot identical after 2.3 s of real time (time, positions, EN, enemies, shots frozen)`, JSON.stringify(A) === JSON.stringify(B), { t: [A.elapsedSeconds, B.elapsedSeconds], pos: A.player.position, en: A.player.en });
          const shotsAtPause = B.recentPlayerShots.at(-1).id;
          const ammoAtPause = B.player.ammo.machinegun;
          const resumed = await L.resume(page);
          checks.check(`d[${how}]: resume click → 'playing' with the pointer locked again, menu gone`, resumed.state === 'playing' && (await lockedElement(page)) === 'CANVAS' && !(await uiState(page)).menus, { state: resumed.state });
          // (`resumed` is the first snapshot THIS SCRIPT saw in 'playing': on a fast machine a few frames have
          //  already run by then, so it only bounds the time from above; the frame-exact check follows below)
          checks.check(`d[${how}]: no jump at the resume: the first snapshot seen in 'playing' is at most one frame (0.25 s) after the paused time`, resumed.elapsedSeconds >= B.elapsedSeconds && resumed.elapsedSeconds - B.elapsedSeconds <= 0.2501, { paused: B.elapsedSeconds, resumed: resumed.elapsedSeconds });
          // the walk key is still physically held: it must not count until released and pressed again
          if (how === 'blur' || how === 'visibility') await L.autoRepeat(page, walkKey, 3, 30);
          await L.waitSimSeconds(page, 0.4);
          const r1 = await L.snap(page);
          const r2 = await L.waitSimSeconds(page, 0.5);
          checks.check(`d[${how}]: the resume click fired no shot`, r2.recentPlayerShots.at(-1).id === shotsAtPause && r2.player.ammo.machinegun === ammoAtPause, { lastId: r2.recentPlayerShots.at(-1).id, ammo: r2.player.ammo.machinegun });
          checks.check(`d[${how}]: ${walkKey} still held from before the pause is ignored after resume`, dist3(r1.player.position, r2.player.position) < 1e-6 && speedH(r2) < 1e-6, { moved: dist3(r1.player.position, r2.player.position) });
          await L.keyUp(page, walkKey);
          await L.keyDown(page, walkKey);
          const r3 = await L.waitSimSeconds(page, 0.5);
          await L.keyUp(page, walkKey);
          // (walking again: at walking speed, or — if the dock wall was reached within these 0.5 s — at least moved)
          checks.check(`d[${how}]: released and pressed again → ${walkKey} works`, speedH(r3) > 9 || dist3(r2.player.position, r3.player.position) > 2, { speed: speedH(r3), moved: dist3(r2.player.position, r3.player.position), z: r3.player.position[2] });
          {
            const frames = await L.stopFrameTrace(page);
            const playingFrames = frames.filter((f) => f.state === 'playing');
            const pausedFrames = frames.filter((f) => f.state === 'paused');
            const avg = (playingFrames.at(-1).ts - playingFrames[0].ts - (pausedFrames.at(-1).ts - pausedFrames[0].ts)) / Math.max(1, playingFrames.length - 1);
            const lead = L.maxSimLead(frames);
            const steps = L.resumeSteps(frames);
            checks.check(`d[${how}]: the first rendered frame after the resume is at exactly the paused time and adds 0 s (time spent paused never reaches the simulation)`, steps.length === 1 && steps[0].added === 0 && steps[0].before === B.elapsedSeconds && steps[0].first === B.elapsedSeconds, { steps, pausedAt: B.elapsedSeconds });
            checks.check(`d[${how}]: simulation time is constant over every paused frame; per frame it never advances more than the real frame time (+1 tick)`, pausedFrames.length >= 2 && pausedFrames.every((f) => f.t === pausedFrames[0].t) && lead <= 1 / 120 + 1e-6, { pausedFrames: pausedFrames.length, t: pausedFrames[0].t, pausedRealSeconds: (pausedFrames.at(-1).ts - pausedFrames[0].ts) / 1000, maxLeadSeconds: lead, avgPlayingFrameMs: avg });
          }
          await L.waitSimSeconds(page, 0.3);
          lap(`pause via ${how} done`);
        }

      if (want('e')) {
        // e1: Q pressed while paused and still down at resume
        await L.waitSimSeconds(page, 1.2);
        let s = await L.pauseBy(page, 'pointerlock');
        const count0 = s.player.movement.qbSuccessfulCount;
        const en0 = s.player.en;
        await L.keyDown(page, 'KeyQ');
        await L.sleep(300);
        const resumed = await L.resume(page);
        await L.autoRepeat(page, 'KeyQ', 6, 40);
        s = await L.waitSimSeconds(page, 1.0);
        checks.check('e: Q pressed during the pause and still down at resume → no quick boost', s.player.movement.qbSuccessfulCount === count0 && s.player.en >= en0 - 1e-9 && speedH(s) < 1e-6, { count: [count0, s.player.movement.qbSuccessfulCount], en: [en0, s.player.en], resumedAt: resumed.elapsedSeconds });
        await L.keyUp(page, 'KeyQ');
        await L.keyDown(page, 'KeyS'); // boost backwards: towards the back wall of the dock, away from the enemies
        await L.tapKey(page, 'KeyQ');
        s = await L.waitForSnapshot(page, (x, c) => x.player.movement.qbSuccessfulCount > c || x.state !== 'playing', count0, { label: 'QB after release' });
        await L.keyUp(page, 'KeyS');
        const afterBoost = await L.waitSimSeconds(page, 0.3);
        checks.check('e: released and pressed again → exactly one quick boost', afterBoost.player.movement.qbSuccessfulCount === count0 + 1, { count: afterBoost.player.movement.qbSuccessfulCount });
        // e2: Q held from before the pause (it already boosted once) and across pause + resume
        await L.holdKey(page, 'ControlLeft', 0.8);
        await L.waitSimSeconds(page, 1.2);
        const c1 = (await L.snap(page)).player.movement.qbSuccessfulCount;
        await L.keyDown(page, 'KeyS');
        await L.keyDown(page, 'KeyQ');
        await L.waitForSnapshot(page, (x, c) => x.player.movement.qbSuccessfulCount > c || x.state !== 'playing', c1, { label: 'QB' });
        await L.keyUp(page, 'KeyS');
        await L.pauseBy(page, 'pointerlock');
        await L.sleep(300);
        await L.resume(page);
        await L.autoRepeat(page, 'KeyQ', 6, 40);
        s = await L.waitSimSeconds(page, 1.6); // longer than the 1 s re-use time
        checks.check('e: Q held since before the pause → still exactly the one boost after resume (re-use time passed)', s.player.movement.qbSuccessfulCount === c1 + 1, { count: [c1, s.player.movement.qbSuccessfulCount] });
        await L.keyUp(page, 'KeyQ');
        await L.holdKey(page, 'ControlLeft', 0.8);
      }
      const end = await L.snap(page);
      checks.check('d/e: sortie still running normally at the end (undetected in the start dock, HP 1000)', end.state === 'playing' && end.player.hp === 1000, { state: end.state, hp: end.player.hp, t: end.elapsedSeconds, z: end.player.position[2], sector: end.stage.currentSectorId });
      checks.noPageErrors(game, 'd/e: no console errors / uncaught exceptions');
      await game.close();
    });

  // ═══════════════════════════ f. pointer-lock failure ═══════════════════════════
  if (want('f'))
    await checks.section('f. pointer-lock failure', async () => {
      // Test-side fault injection (never part of the shipped page): requestPointerLock misbehaves on demand.
      const faultInit = () => {
        const proto = Element.prototype;
        const original = proto.requestPointerLock;
        window.__e2eLockMode = 'reject';
        window.__e2eLockCalls = 0;
        Object.defineProperty(proto, 'requestPointerLock', {
          configurable: true,
          get() {
            const mode = window.__e2eLockMode;
            if (mode === 'unsupported') return undefined;
            return function (...args) {
              window.__e2eLockCalls++;
              if (mode === 'ok') return original.apply(this, args);
              if (mode === 'throw') throw new DOMException('blocked by the test', 'SecurityError');
              if (mode === 'hang') return undefined; // old API shape and no event ever fires
              if (mode === 'error-event') {
                setTimeout(() => document.dispatchEvent(new Event('pointerlockerror')), 30);
                return undefined;
              }
              return Promise.reject(new DOMException('blocked by the test', 'NotAllowedError'));
            };
          },
        });
      };
      const setMode = (page, mode) => page.evaluate((m) => (window.__e2eLockMode = m), mode);
      const game = await L.openGame(browser, { width: W, height: H, initScript: faultInit });
      const page = game.page;

      // f1: sortie from the garage
      const expectText = { reject: '許可しませんでした', throw: '許可しませんでした', 'error-event': '許可しませんでした', unsupported: '対応していません', hang: '応答がありません' };
      for (const mode of Object.keys(expectText)) {
        await setMode(page, mode);
        await L.clickAct(page, 'sortie');
        await page.waitForFunction((t) => (document.querySelector('.gar-notice:not(.is-off)')?.textContent ?? '').includes(t), expectText[mode], { timeout: 30000 }).catch(() => {});
        await L.sleep(1200);
        const ui = await uiState(page);
        const s = await L.snap(page);
        checks.check(`f[garage/${mode}]: explanation shown, sortie button still there, state 'garage', time 0, HUD hidden`, !!ui.notice && ui.notice.includes(expectText[mode]) && ui.notice.includes('もう一度') && ui.garage && !ui.hud && s.state === 'garage' && s.elapsedSeconds === 0 && (await L.actVisible(page, 'sortie')) && (await lockedElement(page)) === null, { notice: ui.notice, state: s.state, t: s.elapsedSeconds });
      }
      await setMode(page, 'ok');
      const first = await L.sortie(page);
      const ui1 = await uiState(page);
      checks.check('f: retry (sortie button again) with a working lock → playing from time 0, notice gone', first.state === 'playing' && first.elapsedSeconds <= 0.2501 && !ui1.garage && ui1.hud, { t: first.elapsedSeconds });

      // f2: resume refused
      await L.waitSimSeconds(page, 0.6);
      const paused = await L.pauseBy(page, 'pointerlock');
      await setMode(page, 'reject');
      await L.clickAct(page, 'resume');
      await page.locator('.menu-plerr').waitFor({ state: 'visible', timeout: 30000 });
      const A = await L.snap(page);
      await L.sleep(1500);
      const B = await L.snap(page);
      let ui = await uiState(page);
      checks.check("f[resume]: lock refused → error panel with reason and retry button, state stays 'paused'", ui.plerr && !!ui.plerrReason && ui.plerrReason.includes('許可しませんでした') && (await L.actVisible(page, 'resume')) && (await L.actVisible(page, 'garage')) && B.state === 'paused', { reason: ui.plerrReason, state: B.state });
      checks.check('f[resume]: nothing advances while the error is shown', JSON.stringify(A) === JSON.stringify(B) && B.elapsedSeconds === paused.elapsedSeconds, { t: [paused.elapsedSeconds, A.elapsedSeconds, B.elapsedSeconds] });
      await L.clickAct(page, 'resume'); // retry, still refused
      await L.sleep(800);
      ui = await uiState(page);
      const C = await L.snap(page);
      checks.check('f[resume]: retry refused again → still the error panel, still paused, same time', ui.plerr && C.state === 'paused' && C.elapsedSeconds === paused.elapsedSeconds, { state: C.state, t: C.elapsedSeconds });
      await setMode(page, 'ok');
      const resumed = await L.resume(page);
      checks.check('f[resume]: retry with a working lock → playing, time continues without a jump', resumed.state === 'playing' && resumed.elapsedSeconds >= paused.elapsedSeconds && resumed.elapsedSeconds - paused.elapsedSeconds <= 0.2501 && !(await uiState(page)).menus, { paused: paused.elapsedSeconds, resumed: resumed.elapsedSeconds });

      // f3: re-sortie refused (from the pause menu): nothing changes until the lock is there; the retry is the re-sortie
      const walked = await L.holdKey(page, 'KeyW', 0.5);
      const pausedR = await L.pauseBy(page, 'pointerlock');
      await setMode(page, 'reject');
      await L.clickAct(page, 'restart');
      await page.locator('.menu-plerr').waitFor({ state: 'visible', timeout: 30000 });
      await L.sleep(1200);
      const R = await L.snap(page);
      checks.check("f[re-sortie]: lock refused → error panel; the paused sortie is untouched (still 'paused' at its own time and position, nothing reset)", (await uiState(page)).plerr && R.state === 'paused' && R.elapsedSeconds === pausedR.elapsedSeconds && pausedR.elapsedSeconds >= walked.elapsedSeconds && R.elapsedSeconds > 0 && JSON.stringify(R) === JSON.stringify(pausedR), { state: R.state, t: [pausedR.elapsedSeconds, R.elapsedSeconds], pos: R.player.position });
      await setMode(page, 'ok');
      const again = await L.resume(page);
      checks.check('f[re-sortie]: retry → the re-sortie: playing from time 0 with HP 1000 at the start position, no shot record', again.state === 'playing' && again.elapsedSeconds <= 0.2501 && again.player.hp === 1000 && again.recentPlayerShots.length === 0 && L.vecNear(again.player.position, first.player.position, 0.01), { t: again.elapsedSeconds, pos: again.player.position });

      // f4: from the error panel back to the garage
      await L.waitSimSeconds(page, 0.3);
      await L.pauseBy(page, 'pointerlock');
      await setMode(page, 'reject');
      await L.clickAct(page, 'resume');
      await page.locator('.menu-plerr').waitFor({ state: 'visible', timeout: 30000 });
      const g = await L.toGarage(page);
      ui = await uiState(page);
      checks.check('f: error panel → "格納庫へ戻る" → garage (time 0, HUD hidden, no stale notice)', g.state === 'garage' && g.elapsedSeconds === 0 && ui.garage && !ui.hud && !ui.menus && ui.notice === null, { state: g.state, ui });
      const calls = await page.evaluate(() => window.__e2eLockCalls);
      checks.note('f: requestPointerLock calls seen by the injected wrapper', calls);
      checks.noPageErrors(game, 'f: no console errors / uncaught exceptions (rejections are handled)');
      await game.close();
    });

  // ═══════════════════════════ g. mini stage: failed / cleared / re-sortie / garage ═══════════════════════════
  if (want('g'))
    await checks.section('g. mini-stage harness: fell, destroyed, cleared, re-sortie, garage', async () => {
      let game = await L.openGame(browser, { width: W, height: H, path: L.HARNESS_PATH });
      let page = game.page;
      const garage0 = await L.snap(page);
      const ids = garage0.enemies.map((e) => e.id);
      const start = garage0.player.position;
      checks.check('g: harness = real App on the mini stage (10 enemies, 6 control turrets, garage, version)', garage0.state === 'garage' && garage0.version === VERSION && ids.length === 10 && garage0.enemies.filter((e) => e.isGateControl).length === 6, { ids });

      /** Everything SPEC §9 lists for a re-sortie, checked on the first snapshots of the new sortie. */
      const checkFresh = (label, s, loadout) => {
        const e = expectedStats(loadout);
        const problems = [];
        if (s.elapsedSeconds > 0.2501) problems.push('time ' + s.elapsedSeconds);
        if (s.player.hp !== 1000) problems.push('hp ' + s.player.hp);
        if (s.player.en !== e.maxEn) problems.push('en ' + s.player.en);
        if (!sameLoadout(s.loadout, loadout)) problems.push('loadout ' + JSON.stringify(s.loadout));
        if (!statsEqual(s.effectiveStats, e)) problems.push('stats');
        if (s.player.ammo.machinegun !== 300 || s.player.ammo.missile !== 12) problems.push('ammo ' + JSON.stringify(s.player.ammo));
        if (s.player.weapon !== 'machinegun') problems.push('weapon ' + s.player.weapon);
        if (!L.vecNear(s.player.position, start, 1e-6)) problems.push('position ' + JSON.stringify(s.player.position));
        if (!L.vecNear(s.player.velocity, [0, 0, 0], 1e-9)) problems.push('velocity');
        const m = s.player.movement;
        if (m.qbSuccessfulCount !== 0 || m.qbLastStartedAtSeconds !== null || m.qbImpulseRemainingSeconds !== 0 || m.qbCooldownRemainingSeconds !== 0) problems.push('qb ' + JSON.stringify(m));
        if (m.glideEnabled || m.horizontalMode !== 'walk' || m.lastEnSpentAtSeconds !== null) problems.push('movement ' + JSON.stringify(m));
        if (s.recentPlayerShots.length !== 0) problems.push('shots ' + s.recentPlayerShots.length);
        if (JSON.stringify(s.enemies.map((x) => x.id)) !== JSON.stringify(ids)) problems.push('enemy ids');
        for (const [i, x] of s.enemies.entries()) {
          const g0 = garage0.enemies[i];
          if (!x.alive || x.hp !== g0.hp || x.shotsFired !== 0 || x.lastShotAtSeconds !== null || x.alert || !L.vecNear(x.position, g0.position, 1e-9)) problems.push('enemy ' + x.id);
        }
        if (s.objective.controlsDestroyed !== 0 || s.objective.openBarrierIds.length !== 0 || s.objective.gateOpen) problems.push('objective ' + JSON.stringify(s.objective));
        if (JSON.stringify(s.stage.visitedSectorIds) !== '["M01"]' || s.stage.currentSectorId !== 'M01') problems.push('sectors ' + JSON.stringify(s.stage));
        if (s.lock.state === 'locked' || s.fireControl.status !== 'inactive') problems.push('lock ' + s.lock.state);
        checks.check(`${label}: full reset (time 0, HP 1000, EN max, ammo, position, QB, shots, all 10 enemies alive with the same ids, barriers and gate closed, sectors, lock)`, problems.length === 0, problems.length ? problems : { t: s.elapsedSeconds, en: s.player.en, enemies: s.enemies.length });
      };

      // ── g1: fall off the stage ──
      const buildA = { fcs: 'wide', generator: 'recovery', legs: 'quadruped' };
      let s = await L.sortie(page, buildA);
      checkFresh('g[first sortie]', s, buildA);
      await L.keyDown(page, 'KeyS');
      const fell = await L.waitForState(page, ['failed', 'cleared']);
      await L.keyUp(page, 'KeyS');
      let ui = await uiState(page);
      checks.check("g[fell]: walking backwards off the floor → state 'failed', below killY, HP untouched", fell.state === 'failed' && fell.player.position[1] < -15 && fell.player.hp === 1000, { state: fell.state, y: fell.player.position[1], t: fell.elapsedSeconds });
      checks.check('g[fell]: result screen "MISSION FAILED / ステージ外へ落下" with re-sortie and garage buttons, pointer lock released', ui.result && ui.resultTitle === 'MISSION FAILED' && ui.resultSub.includes('ステージ外へ落下') && (await L.actVisible(page, 'restart')) && (await L.actVisible(page, 'garage')) && (await lockedElement(page)) === null, { title: ui.resultTitle, sub: ui.resultSub });
      const resText = await page.evaluate(() => [...document.querySelectorAll('.menu-result .res-cell')].map((c) => c.textContent.replace(/\s+/g, ' ').trim()));
      const mm = Math.floor(fell.elapsedSeconds / 60);
      const ss = fell.elapsedSeconds - mm * 60;
      const timeText = String(mm).padStart(2, '0') + ':' + String(Math.floor(ss)).padStart(2, '0') + '.' + Math.floor((Math.floor(fell.elapsedSeconds * 10) / 10 - Math.floor(fell.elapsedSeconds)) * 10 + 1e-6);
      checks.check('g[fell]: result shows elapsed time, HP 1000, controls 0/6, enemies 0/10 and the build', resText.some((t) => t.includes(timeText)) && resText.some((t) => t.includes('1000/ 1000') || t.includes('1000 / 1000')) && resText.some((t) => /0\s*\/ 6/.test(t)) && resText.some((t) => /0\s*\/ 10/.test(t)) && resText.some((t) => t.includes('4脚')), { timeText, resText });
      const f1 = await L.snap(page);
      await L.sleep(1500);
      const f2 = await L.snap(page);
      checks.check('g[fell]: nothing advances after the failure', JSON.stringify(f1) === JSON.stringify(f2), { t: [f1.elapsedSeconds, f2.elapsedSeconds] });
      await L.screenshot(page, 'failed-fell-' + W + 'x' + H);

      // ── g2: re-sortie with the same build ──
      s = await L.restart(page);
      ui = await uiState(page);
      checks.check('g[re-sortie]: "同じ構成で再出撃" → playing, pointer locked, result gone', s.state === 'playing' && !ui.menus && ui.hud && (await lockedElement(page)) === 'CANVAS', { state: s.state });
      checkFresh('g[re-sortie after fell]', s, buildA);
      const still = await L.waitSimSeconds(page, 0.5);
      checks.check('g[re-sortie]: S held at the failure / the restart click do not act (mech stands still, no shot)', L.vecNear(still.player.position, start, 1e-6) && still.recentPlayerShots.length === 0, { pos: still.player.position });

      // ── g3: destroyed by the yard enemies ──
      await L.keyDown(page, 'KeyA');
      await L.waitForSnapshot(page, (x) => x.player.position[0] < -30 || x.state !== 'playing', null, { label: 'reach the yard' });
      await L.keyUp(page, 'KeyA');
      const exposed = await L.snap(page);
      const dead = await L.waitForState(page, ['failed', 'cleared']);
      ui = await uiState(page);
      const shooters = dead.enemies.filter((e) => e.shotsFired > 0).map((e) => `${e.id}:${e.shotsFired}`);
      checks.check("g[destroyed]: standing in the yard → HP 0 → state 'failed'", dead.state === 'failed' && dead.player.hp === 0, { state: dead.state, hp: dead.player.hp, exposedAt: exposed.elapsedSeconds, diedAt: dead.elapsedSeconds });
      checks.check('g[destroyed]: killed by real enemy fire within 15 s of exposure (2 guards + 2 turrets shot)', shooters.length === 4 && dead.elapsedSeconds - exposed.elapsedSeconds < 15, { shooters, seconds: dead.elapsedSeconds - exposed.elapsedSeconds });
      checks.check('g[destroyed]: result screen "MISSION FAILED / 機体大破"', ui.result && ui.resultTitle === 'MISSION FAILED' && ui.resultSub.includes('機体大破'), { title: ui.resultTitle, sub: ui.resultSub });
      await L.screenshot(page, 'failed-destroyed-' + W + 'x' + H);

      // ── g4: back to the garage, other build ──
      let g = await L.toGarage(page);
      ui = await uiState(page);
      checks.check('g[garage]: "格納庫へ戻る" → garage shown, HUD and menus hidden, selection kept', g.state === 'garage' && ui.garage && !ui.hud && !ui.menus && sameLoadout(g.loadout, buildA), { state: g.state, loadout: g.loadout });
      checks.check('g[garage]: simulation back in the fresh state (time 0, HP 1000, EN 90, enemies alive, nobody fired)', g.elapsedSeconds === 0 && g.player.hp === 1000 && g.player.en === 90 && g.enemies.every((e) => e.alive && e.shotsFired === 0) && L.vecNear(g.player.position, start, 1e-6), { t: g.elapsedSeconds, hp: g.player.hp, en: g.player.en });
      const buildB = { fcs: 'medium', generator: 'balanced', legs: 'biped' };
      s = await L.sortie(page, buildB);
      checkFresh('g[sortie with another build]', s, buildB);
      checks.noPageErrors(game, 'g (failures): no console errors / uncaught exceptions');
      await game.close();

      // ── g5: clear the stage (fresh page): hold the trigger from the cover until all six control turrets are gone ──
      game = await L.openGame(browser, { width: W, height: H, path: L.HARNESS_PATH });
      page = game.page;
      s = await L.sortie(page, buildB);
      checkFresh('g[clear run, fresh page]', s, buildB);
      await L.startFrameTrace(page);
      await L.mouseDown(page);
      const done = await L.waitForSnapshot(page, (x) => x.objective.controlsDestroyed >= 6 || x.state !== 'playing', null, { label: '6 control turrets', timeout: 600000 });
      await L.mouseUp(page);
      const lockedShots = done.recentPlayerShots.filter((x) => x.solutionStatus === 'solved').length;
      checks.check('g[clear]: six control turrets destroyed with the machine gun from the start position', done.state === 'playing' && done.objective.controlsDestroyed === 6 && done.enemies.filter((e) => e.isGateControl).every((e) => !e.alive && e.hp === 0), { t: done.elapsedSeconds, ammo: done.player.ammo.machinegun, fcsCorrectedShotsInLast32: lockedShots });
      checks.check('g[clear]: barriers B1–B6 open in order, final gate open', JSON.stringify(done.objective.openBarrierIds) === '["B1","B2","B3","B4","B5","B6"]' && done.objective.gateOpen, done.objective);
      checks.note('g[clear]: HP after the turret phase (control turrets are real turrets; the cover wall hides the hit-box centre)', { hp: done.player.hp, controlShots: done.enemies.filter((e) => e.isGateControl).map((e) => e.shotsFired) });
      // pause / resume in the middle (fast frames here: the no-jump check is meaningful)
      const midPause = await L.pauseBy(page, 'pointerlock');
      await L.sleep(1500);
      const midResume = await L.resume(page);
      await L.waitSimSeconds(page, 0.3);
      const frames = await L.stopFrameTrace(page);
      const playingFrames = frames.filter((f) => f.state === 'playing');
      const lead = L.maxSimLead(frames);
      const frameMs = playingFrames.slice(1).map((f, i) => f.ts - playingFrames[i].ts).filter((d) => d < 1400);
      frameMs.sort((a, b) => a - b);
      const resumeStep = L.resumeSteps(frames);
      checks.check('g[pause]: the first rendered frame after the resume is at exactly the paused time and adds 0 s', resumeStep.length === 1 && resumeStep[0].added === 0 && resumeStep[0].before === midPause.elapsedSeconds && resumeStep[0].first === midPause.elapsedSeconds, { resumeStep, pausedAt: midPause.elapsedSeconds });
      // (midResume is the first snapshot this script saw in 'playing' — a few fast frames may already have run)
      checks.check('g[pause]: per frame the simulation never runs ahead of real time (≤ 1 tick), also across pause → resume', lead <= 1 / 120 + 1e-6 && midResume.elapsedSeconds >= midPause.elapsedSeconds && midResume.elapsedSeconds - midPause.elapsedSeconds <= 0.2501, { maxLeadSeconds: lead, frames: frames.length, medianPlayingFrameMs: frameMs[Math.floor(frameMs.length / 2)], pausedAt: midPause.elapsedSeconds, firstSeenPlayingAt: midResume.elapsedSeconds });
      // walk around the cover wall and glide down the corridor to the exit
      await L.holdKey(page, 'KeyD', 0.3);
      await L.keyDown(page, 'KeyW');
      await L.tapKey(page, 'ShiftLeft');
      const cleared = await L.waitForState(page, ['cleared', 'failed'], { timeout: 600000 });
      await L.keyUp(page, 'KeyW');
      ui = await uiState(page);
      checks.check("g[clear]: through the open gate into the exit zone → state 'cleared'", cleared.state === 'cleared' && cleared.player.position[2] <= -132 && cleared.player.hp > 0, { state: cleared.state, z: cleared.player.position[2], hp: cleared.player.hp, t: cleared.elapsedSeconds, visited: cleared.stage.visitedSectorIds });
      checks.check('g[clear]: result screen "MISSION CLEAR / 脱出成功", 6/6 controls, pointer lock released', ui.result && ui.resultTitle === 'MISSION CLEAR' && ui.resultSub.includes('脱出成功') && (await lockedElement(page)) === null && (await page.evaluate(() => document.querySelectorAll('.res-pips i.on').length)) === 6, { title: ui.resultTitle, sub: ui.resultSub });
      const c1 = await L.snap(page);
      await L.sleep(1500);
      const c2 = await L.snap(page);
      checks.check('g[clear]: nothing advances after the clear', JSON.stringify(c1) === JSON.stringify(c2), { t: [c1.elapsedSeconds, c2.elapsedSeconds] });
      await L.screenshot(page, 'cleared-' + W + 'x' + H);
      if (L.SHOT_DIR) {
        await page.setViewportSize({ width: 1280, height: 720 });
        await L.waitFrames(page, 3);
        await L.screenshot(page, 'cleared-1280x720');
        await page.setViewportSize({ width: W, height: H });
        await L.waitFrames(page, 3);
      }

      // ── g6: re-sortie after a clear: barriers, gate and enemies are back ──
      s = await L.restart(page);
      checkFresh('g[re-sortie after clear]', s, buildB);
      const walk = await L.holdKey(page, 'KeyW', 0.5);
      checks.check('g[re-sortie after clear]: the cover wall is solid again and the game runs (W walks into it and stops at z ≈ −1.2)', walk.state === 'playing' && walk.player.position[2] < -0.5 && walk.player.position[2] > -1.3, { z: walk.player.position[2] });

      // ── g7: re-sortie from the pause menu, then garage from the pause menu ──
      await L.pauseBy(page, 'pointerlock');
      s = await L.restart(page);
      checkFresh('g[re-sortie from the pause menu]', s, buildB);
      await L.waitSimSeconds(page, 0.3);
      await L.pauseBy(page, 'escape');
      g = await L.toGarage(page);
      checks.check('g[garage from the pause menu]: garage at time 0 with the fresh state', g.state === 'garage' && g.elapsedSeconds === 0 && g.player.hp === 1000 && g.enemies.every((e) => e.alive), { state: g.state, t: g.elapsedSeconds });

      checks.noPageErrors(game, 'g (clear): no console errors / uncaught exceptions');
      await game.close();

      if (L.SHOT_DIR) {
        // failed screens at 1280×720 for the visual check (fresh page)
        game = await L.openGame(browser, { width: 1280, height: 720, path: L.HARNESS_PATH });
        page = game.page;
        await L.sortie(page);
        await L.keyDown(page, 'KeyS');
        await L.waitForState(page, ['failed', 'cleared']);
        await L.keyUp(page, 'KeyS');
        await L.waitFrames(page, 3);
        await L.screenshot(page, 'failed-fell-1280x720');
        await L.restart(page);
        await L.keyDown(page, 'KeyA');
        await L.waitForSnapshot(page, (x) => x.player.position[0] < -30 || x.state !== 'playing', null, { label: 'reach the yard' });
        await L.keyUp(page, 'KeyA');
        await L.waitSimSeconds(page, 1.5);
        await L.screenshot(page, 'combat-yard-1280x720');
        await L.waitForState(page, ['failed', 'cleared']);
        await L.waitFrames(page, 3);
        await L.screenshot(page, 'failed-destroyed-1280x720');
        await game.close();
      }
    });

  // ═══════════════════════════ h. repeated sorties: nothing duplicates ═══════════════════════════
  if (want('h'))
    await checks.section('h. five sortie → garage cycles', async () => {
      // Test-side instrumentation (not in the shipped page): counts requestAnimationFrame registrations.
      const rafProbe = () => {
        const orig = window.requestAnimationFrame.bind(window);
        const probe = { n: 0, orig };
        window.__e2eRaf = probe;
        window.requestAnimationFrame = (cb) => {
          probe.n++;
          return orig(cb);
        };
      };
      /** requestAnimationFrame registrations made by the page per rendered frame (1 = exactly one loop). */
      const rafPerFrame = (page, frames = 12) =>
        page.evaluate(
          (count) =>
            new Promise((resolve) => {
              const probe = window.__e2eRaf;
              let left = count;
              let n0 = 0;
              const step = () => {
                if (left === count) n0 = probe.n; // start counting at a frame boundary
                if (left-- === 0) resolve((probe.n - n0) / count);
                else probe.orig(step);
              };
              probe.orig(step);
            }),
          frames,
        );
      const game = await L.openGame(browser, { width: W, height: H, initScript: rafProbe });
      const page = game.page;
      const rafGarage0 = await rafPerFrame(page);
      const counts = [];
      for (let cycle = 1; cycle <= 5; cycle++) {
        await L.sortie(page);
        await L.holdKey(page, 'KeyW', 0.3);
        await L.fireFor(page, 0.3);
        await L.pauseBy(page, cycle % 2 ? 'pointerlock' : 'escape');
        if (cycle === 3) {
          await L.restart(page); // a re-sortie in between as well
          await L.waitSimSeconds(page, 0.3);
          await L.pauseBy(page, 'pointerlock');
        }
        await L.toGarage(page);
        await L.waitFrames(page, 3);
        if (cycle === 1 || cycle === 5) counts.push(await L.resourceCounts(page));
        lap(`cycle ${cycle} done`);
      }
      const [c1, c5] = counts;
      checks.check('h: one canvas, same number of DOM elements in the garage after cycle 1 and cycle 5', c1.canvases === 1 && c5.canvases === 1 && c1.elements === c5.elements && c1.styleSheets === c5.styleSheets, { cycle1: c1, cycle5: c5 });
      checks.check('h: number of JS event listeners in the page did not grow', c5.jsEventListeners <= c1.jsEventListeners, { cycle1: c1.jsEventListeners, cycle5: c5.jsEventListeners });
      checks.check('h: total DOM nodes (incl. detached) did not grow', c5.domNodes <= c1.domNodes + 5, { cycle1: c1.domNodes, cycle5: c5.domNodes });
      checks.note('h: JS heap after forced GC (MB)', { cycle1: c1.heapUsedMB, cycle5: c5.heapUsedMB });
      const rafGarage5 = await rafPerFrame(page);

      // sixth sortie: one physical press = one action, one frame loop
      const s0 = await L.sortie(page);
      checks.check('h: sixth sortie starts fresh (time 0, HP 1000, EN 120, ammo 300 / 12, no shots)', s0.elapsedSeconds <= 0.2501 && s0.player.hp === 1000 && s0.player.en === 120 && s0.player.ammo.machinegun === 300 && s0.recentPlayerShots.length === 0 && s0.player.movement.qbSuccessfulCount === 0, { t: s0.elapsedSeconds });
      await L.startFrameTrace(page);
      await L.keyDown(page, 'KeyS'); // backwards, so the boost ends at the dock's back wall
      await L.tapKey(page, 'KeyQ');
      const q = await L.waitForSnapshot(page, (x) => x.player.movement.qbSuccessfulCount >= 1 || x.state !== 'playing', null, { label: 'QB' });
      await L.keyUp(page, 'KeyS');
      const q2 = await L.waitSimSeconds(page, 1.3);
      checks.check('h: one physical Q press → exactly one quick boost (36 EN once)', q2.player.movement.qbSuccessfulCount === 1 && q2.player.en >= 120 - 36 - 1e-9 && q2.player.en <= 120 - 36 + 15 * Math.max(0, q2.elapsedSeconds - q.player.movement.qbLastStartedAtSeconds - 0.75) + 1e-6, { count: q2.player.movement.qbSuccessfulCount, en: q2.player.en });
      await L.holdKey(page, 'ControlLeft', 0.8);
      await L.fireFor(page, 1.0);
      await L.waitFrames(page, 2);
      const f = await L.snap(page);
      const gaps = f.recentPlayerShots.slice(1).map((x, i) => x.firedAtSeconds - f.recentPlayerShots[i].firedAtSeconds);
      checks.check('h: one held click → machine-gun cadence of exactly 0.10 s, ammo = 300 − shots', f.recentPlayerShots.length >= 10 && gaps.every((g) => L.near(g, 0.1, 1e-6)) && f.player.ammo.machinegun === 300 - f.recentPlayerShots.at(-1).id, { shots: f.recentPlayerShots.at(-1).id, ammo: f.player.ammo.machinegun });
      const frames = await L.stopFrameTrace(page);
      const lead = L.maxSimLead(frames);
      const simSpan = frames.at(-1).t - frames[0].t;
      const wallSpan = (frames.at(-1).ts - frames[0].ts) / 1000;
      checks.check('h: simulation time never runs ahead of real time', lead <= 1 / 120 + 1e-6 && simSpan <= wallSpan + 0.26, { maxLeadSeconds: lead, simSeconds: simSpan, realSeconds: wallSpan, frames: frames.length });
      const rafPlaying = await rafPerFrame(page, 6);
      await L.pauseBy(page, 'pointerlock');
      const rafPaused = await rafPerFrame(page);
      await L.resume(page);
      checks.check('h: exactly one requestAnimationFrame registration per frame — one loop — in the garage (before / after 5 cycles), playing and paused', rafGarage0 === 1 && rafGarage5 === 1 && rafPlaying === 1 && rafPaused === 1, { garageAtStart: rafGarage0, garageAfter5Cycles: rafGarage5, playing: rafPlaying, paused: rafPaused });

      // beforeunload guard: only while playing; and it does not trap an automated reload
      const guard = async () => page.evaluate(() => {
        const e = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(e);
        return e.defaultPrevented;
      });
      const whilePlaying = await guard();
      await L.pauseBy(page, 'pointerlock');
      const whilePaused = await guard();
      await L.resume(page);
      checks.check('h: leaving the page asks for confirmation while playing (Ctrl+W hazard), not while paused', whilePlaying === true && whilePaused === false, { whilePlaying, whilePaused });
      await page.reload({ waitUntil: 'load', timeout: L.TIMEOUT });
      const reloaded = await L.snap(page);
      checks.check('h: reloading in the middle of a sortie works and starts over in the garage', reloaded.state === 'garage' && reloaded.elapsedSeconds === 0, { state: reloaded.state });
      checks.noPageErrors(game, 'h: no console errors / uncaught exceptions');
      await game.close();
    });

  // ═══════════════════════════ i. resize ═══════════════════════════
  if (want('i'))
    await checks.section('i. resize in every state', async () => {
      const sizes = [
        [1280, 720],
        [1920, 1080],
        [1000, 900],
        [900, 1000],
        [1280, 720],
      ];
      const game = await L.openGame(browser, { width: 1280, height: 720 });
      const page = game.page;
      const fcs = 'wide';
      const factor = FCS[fcs][0];
      await L.selectLoadout(page, { fcs });
      const measure = async (label, w, h, expectHud) => {
        await page.setViewportSize({ width: w, height: h });
        await L.waitFrames(page, 3);
        const s = await L.snap(page);
        const d = await L.measureDisplay(page);
        const want = factor * Math.min(w, h);
        const canvasOk = d.canvasRect.x === 0 && d.canvasRect.y === 0 && d.canvasRect.width === w && d.canvasRect.height === h && d.canvasBuffer.width === w * d.window.dpr && d.canvasBuffer.height === h * d.window.dpr && !d.scrollable;
        const ringOk = expectHud ? !!d.ring && L.near(d.ring.radiusX, want, 0.01) && L.near(d.ring.radiusY, want, 0.01) && L.near(d.ring.centreX, w / 2, 0.01) && L.near(d.ring.centreY, h / 2, 0.01) : !d.hudVisible;
        checks.check(`i[${label} ${w}×${h}]: snapshot radius = ${factor} × min(w,h) = ${want}; canvas fills the window; ${expectHud ? 'HUD circle on screen matches' : 'HUD hidden'}`, L.near(s.lock.radiusCssPx, want, 1e-9) && canvasOk && ringOk && s.state === label, { radius: s.lock.radiusCssPx, canvas: d.canvasRect, buffer: d.canvasBuffer, ring: d.ring });
        return d;
      };
      for (const [w, h] of sizes) {
        await measure('garage', w, h, false);
        const inside = await page.evaluate(() => {
          const r = document.querySelector('[data-act="sortie"]').getBoundingClientRect();
          return r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight;
        });
        checks.check(`i[garage ${w}×${h}]: sortie button inside the window`, inside);
      }
      lap('garage sizes done');
      await L.sortie(page);
      for (const [w, h] of sizes) await measure('playing', w, h, true);
      lap('playing sizes done');
      const still = await L.snap(page);
      checks.check('i: still playing with the pointer locked after the resizes', still.state === 'playing' && (await lockedElement(page)) === 'CANVAS', { state: still.state });
      await L.pauseBy(page, 'pointerlock');
      for (const [w, h] of sizes) await measure('paused', w, h, true);
      const menuOk = await page.evaluate(() => {
        const r = document.querySelector('.menu-pause').getBoundingClientRect();
        return r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight;
      });
      checks.check('i: pause menu inside the window after the resizes', menuOk);
      // device pixel ratio 2 (emulated): drawing buffer doubles, CSS sizes and the lock circle stay
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 2, mobile: false });
      await L.waitFrames(page, 3);
      const d2 = await L.measureDisplay(page);
      const s2 = await L.snap(page);
      checks.check('i: devicePixelRatio 2 → drawing buffer 2560×1440, CSS size and lock circle unchanged', d2.window.dpr === 2 && d2.canvasBuffer.width === 2560 && d2.canvasBuffer.height === 1440 && d2.canvasRect.width === 1280 && L.near(s2.lock.radiusCssPx, factor * 720, 1e-9) && L.near(d2.ring.radiusX, factor * 720, 0.01), { dpr: d2.window.dpr, buffer: d2.canvasBuffer, radius: s2.lock.radiusCssPx, ring: d2.ring });
      await cdp.send('Emulation.clearDeviceMetricsOverride');
      await cdp.detach();
      await page.setViewportSize({ width: 1280, height: 720 });
      const resumed = await L.resume(page);
      checks.check('i: resume works after resizing while paused', resumed.state === 'playing');
      // an odd, small size must not break anything
      await page.setViewportSize({ width: 517, height: 333 });
      await L.waitFrames(page, 3);
      const tiny = await L.snap(page);
      const dt = await L.measureDisplay(page);
      checks.check('i: odd small size 517×333 keeps running (radius 0.3 × 333, canvas fills the window)', tiny.state === 'playing' && L.near(tiny.lock.radiusCssPx, factor * 333, 1e-9) && dt.canvasRect.width === 517 && dt.canvasRect.height === 333 && L.near(dt.ring.radiusX, factor * 333, 0.01), { radius: tiny.lock.radiusCssPx, ring: dt.ring });
      checks.noPageErrors(game, 'i: no console errors / uncaught exceptions');
      await game.close();
    });

  // ═══════════════════════════ j. no WebGL ═══════════════════════════
  if (want('j'))
    await checks.section('j. WebGL unavailable', async () => {
      const noWebgl = () => {
        const original = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
          return /webgl/i.test(String(type)) ? null : original.call(this, type, ...rest);
        };
      };
      const game = await L.openGame(browser, { width: W, height: H, initScript: noWebgl, waitReady: false });
      const page = game.page;
      await page.locator('.ak2-shell-msg.is-fatal').waitFor({ state: 'visible', timeout: 60000 });
      const text = await page.locator('.ak2-shell-msg').textContent();
      const s = await L.snap(page);
      const ui = await uiState(page);
      checks.check('j: a readable message is shown instead of a blank page', /WebGL/.test(text) && text.length > 40 && !ui.garage, text.slice(0, 120));
      checks.check("j: the snapshot API still answers (state 'garage', time 0)", s.state === 'garage' && s.elapsedSeconds === 0, { state: s.state });
      const uncaught = game.errors.filter((e) => e.startsWith('pageerror'));
      checks.check('j: no uncaught exception (the library logs the failed context creation to the console)', uncaught.length === 0, { uncaught, consoleErrors: game.errors.length });
      await L.screenshot(page, 'no-webgl-' + W + 'x' + H);
      await game.close();
    });

  // ═══════════════════════════ s. screenshots at 1280×720 ═══════════════════════════
  if (want('s') && L.SHOT_DIR)
    await checks.section('s. screenshots 1280×720', async () => {
      const game = await L.openGame(browser, { width: 1280, height: 720, waitReady: false });
      const page = game.page;
      await L.screenshot(page, 'loading-1280x720');
      await L.waitReady(page);
      await L.waitFrames(page, 3);
      await L.screenshot(page, 'garage-1280x720');
      await L.selectLoadout(page, { fcs: 'narrow', generator: 'recovery', legs: 'quadruped' });
      await L.waitFrames(page, 3);
      await L.screenshot(page, 'garage-quadruped-1280x720');
      await L.clickAct(page, 'help');
      await L.waitFrames(page, 2);
      await L.screenshot(page, 'garage-help-1280x720');
      await L.clickAct(page, 'help-close');
      await L.selectLoadout(page, { fcs: 'medium', generator: 'balanced', legs: 'biped' });
      await L.sortie(page);
      await L.waitSimSeconds(page, 0.5);
      await L.screenshot(page, 'playing-start-1280x720');
      await L.holdKey(page, 'KeyW', 2.5);
      await L.tapKey(page, 'KeyQ');
      await L.mouseDown(page);
      await L.waitSimSeconds(page, 0.3);
      await L.screenshot(page, 'playing-qb-fire-1280x720');
      await L.mouseUp(page);
      await L.pauseBy(page, 'pointerlock');
      await L.waitFrames(page, 3);
      await L.screenshot(page, 'paused-1280x720');
      await L.click(page, '.menu-pause [data-act="help"]');
      await L.waitFrames(page, 2);
      await L.screenshot(page, 'paused-help-1280x720');
      checks.check('s: screenshots written', true, L.SHOT_DIR);
      checks.noPageErrors(game, 's: no console errors / uncaught exceptions');
      await game.close();
    });
} finally {
  await browser.close();
}
console.log(`total ${((Date.now() - t0) / 1000).toFixed(0)} s`);
process.exit(checks.finish());
