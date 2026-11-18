#!/usr/bin/env node
/**
 * Regression checks for defects found in review of the application layer (src/app.ts and its neighbours).
 * Each section reproduces one finding the way it was demonstrated and fails if it comes back.
 *
 *   AK2_URL=http://127.0.0.1:5190/ node tools/e2e/app-regress.mjs [--only=k,l,…] [--shots=<dir>]
 *
 * Sections (each opens its own page):
 *   k  a pointer lock nobody is waiting for (answer after the request timed out, or with no request at all)
 *      is released again: the cursor is never left captured over a menu
 *   l  the window while a lock request is pending: an old answer does not take the lock away from a newer
 *      request; the sortie uses the build the garage shows; a re-sortie changes nothing until the lock is
 *      there (result screen and snapshot stay consistent); retry after a refused re-sortie / resume
 *   m  double click on 出撃 / 再開 / 再出撃: the second click is not a shot; a held press and the next press fire
 *   n  re-sortie resets the mech's animation state (no glide stance / thruster flames at time 0)
 *   o  HUD centre: the reticle is never covered by the route marker (painted on top, the tag keeps clear)
 *   p  page icon: an inline icon is declared, so no browser asks the server for /favicon.ico
 *   y  displays faster than 120 Hz (frames of 1/240 s and 1/360 s of game time, most of which run no
 *      simulation tick): a click, a Q / Space / Shift / 1-2-3 / Left Ctrl tap that is over before the next
 *      tick is not lost and not doubled; a held trigger keeps the 0.10 s cadence
 *
 * k, l, m, n and y use the test-side scripted Pointer Lock API and virtual frame clock of lib.mjs (see its
 * header): these races need a lock latency / click timing a headless browser does not produce by itself.
 * All input is real (trusted) keyboard / mouse input; everything is observed through the DOM, screenshots
 * and the read-only window.__AK2__.getSnapshot().
 */
import * as L from './lib.mjs';

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const only = arg('only') ? new Set(arg('only').split(',')) : null;
const want = (id) => !only || only.has(id);
const W = 800;
const H = 450;
const SCRIPTED = { lock: true, clock: true };
/** Timeout of the app's own pointer-lock request (src/input/input.ts requestPointerLock). */
const LOCK_TIMEOUT_MS = 2500;

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
      pause: vis('.menu-pause'),
      result: vis('.menu-result'),
      plerr: vis('.menu-plerr'),
      panels: document.querySelectorAll('.menu-panel').length,
      hud: vis('.ak2-hud'),
      notice: vis('.gar-notice') ? text('.gar-notice') : null,
      resultTitle: text('.res-title'),
      plerrReason: text('.plerr-reason'),
      locked: document.pointerLockElement ? document.pointerLockElement.tagName : null,
    };
  });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const centreOf = (page, selector) =>
  page
    .locator(selector)
    .first()
    .evaluate((e) => {
      const r = e.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
/** Waits (wall clock, bounded) until the scripted lock's log contains `count` entries matching `word`. */
const waitLockLog = (page, word, count = 1, timeout = 20000) =>
  page.waitForFunction(([w, n]) => window.__e2e.lock.log.filter((l) => l.includes(w)).length >= n, [word, count], { timeout, polling: 25 }).then(
    () => true,
    () => false,
  );
/** Real click on a button that starts / continues the game, then wait for 'playing' (scripted lock). */
async function into(page, act) {
  await L.clickAct(page, act);
  return L.waitForState(page, 'playing');
}
/** Esc while playing (the scripted lock does not swallow the key) → paused. */
async function esc(page) {
  await page.keyboard.press('Escape');
  return L.waitForState(page, 'paused');
}
const shotsOf = (s) => s.recentPlayerShots.length;

const browser = await L.launch();
const checks = new L.Checks('app-regress');
const t0 = Date.now();
const lap = (text) => console.log(`      [${((Date.now() - t0) / 1000).toFixed(0)} s] ${text}`);

try {
  // ═══════════════════════════ k. a lock nobody is waiting for ═══════════════════════════
  if (want('k'))
    await checks.section('k. pointer lock that arrives when nobody is waiting for it', async () => {
      const game = await L.openGame(browser, { width: W, height: H, scripted: SCRIPTED });
      const page = game.page;
      await L.clockFreeze(page);
      const late = LOCK_TIMEOUT_MS + 1000;

      // k1: sortie — the browser answers one second after the app's request timed out
      await L.lockMode(page, 'ok', late);
      await L.clickAct(page, 'sortie');
      await page.waitForFunction(() => (document.querySelector('.gar-notice:not(.is-off)')?.textContent ?? '').includes('応答がありません'), null, { timeout: 15000 }).catch(() => {});
      const atTimeout = await uiState(page);
      const arrived = await waitLockLog(page, 'LOCKED');
      await L.sleep(400);
      await L.realFrames(page, 2);
      let ui = await uiState(page);
      let s = await L.snap(page);
      let info = await L.lockInfo(page);
      checks.check('k[garage]: the request times out with an explanation and a retry hint; no lock yet', !!atTimeout.notice && atTimeout.notice.includes('応答がありません') && atTimeout.notice.includes('もう一度') && atTimeout.locked === null, atTimeout.notice);
      checks.check('k[garage]: the late lock really arrived afterwards (test precondition)', arrived, info.log);
      checks.check("k[garage]: the late lock is released again — cursor free, state 'garage', time 0, explanation still shown", ui.locked === null && !info.locked && s.state === 'garage' && s.elapsedSeconds === 0 && ui.garage && !ui.hud && !!ui.notice, { locked: ui.locked, state: s.state, t: s.elapsedSeconds, log: info.log });
      await L.lockMode(page, 'ok', 0);
      s = await into(page, 'sortie');
      ui = await uiState(page);
      checks.check('k[garage]: the retry (sortie button) then starts the sortie normally', s.state === 'playing' && s.elapsedSeconds === 0 && ui.locked === 'CANVAS' && !ui.garage && ui.hud, { state: s.state, t: s.elapsedSeconds, locked: ui.locked });

      // k2: resume — same late answer
      await L.clockAdvance(page, 2, 250);
      const paused = await esc(page);
      await L.sleep(300);
      await L.lockMode(page, 'ok', late);
      await L.clickAct(page, 'resume');
      await page.locator('.menu-plerr').waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
      const lockedBefore = (await L.lockInfo(page)).log.filter((l) => l.includes('LOCKED')).length;
      const arrived2 = await waitLockLog(page, 'LOCKED', lockedBefore + 1);
      await L.sleep(400);
      await L.realFrames(page, 2);
      ui = await uiState(page);
      s = await L.snap(page);
      info = await L.lockInfo(page);
      const retryHit = await page.evaluate(() => {
        const b = document.querySelector('.menu-plerr [data-act="resume"]');
        if (!b) return null;
        const r = b.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !!top && (top === b || b.contains(top));
      });
      checks.check('k[resume]: the late lock really arrived after the error panel was shown (test precondition)', arrived2, info.log.slice(-6));
      checks.check("k[resume]: the late lock is released again — cursor free over the error panel with its retry button, still 'paused', time unchanged", ui.locked === null && ui.plerr && retryHit === true && s.state === 'paused' && s.elapsedSeconds === paused.elapsedSeconds, { locked: ui.locked, plerr: ui.plerr, state: s.state, t: [paused.elapsedSeconds, s.elapsedSeconds] });
      await L.lockMode(page, 'ok', 0);
      s = await into(page, 'resume');
      checks.check('k[resume]: the retry then resumes at exactly the paused time', s.state === 'playing' && s.elapsedSeconds === paused.elapsedSeconds && (await uiState(page)).locked === 'CANVAS', { t: s.elapsedSeconds });

      // k3: a lock that appears without any request (nothing the app asked for) is not kept either
      await esc(page);
      await L.sleep(200);
      await page.evaluate(() => window.__e2e.lock.set(document.querySelector('canvas')));
      await L.sleep(400);
      ui = await uiState(page);
      s = await L.snap(page);
      checks.check("k[paused]: an unrequested lock is released; still 'paused' with the pause menu", ui.locked === null && s.state === 'paused' && ui.pause, { locked: ui.locked, state: s.state });
      await L.toGarage(page);
      await page.evaluate(() => window.__e2e.lock.set(document.querySelector('canvas')));
      await L.sleep(400);
      ui = await uiState(page);
      s = await L.snap(page);
      checks.check("k[garage]: an unrequested lock is released; still 'garage'", ui.locked === null && s.state === 'garage' && ui.garage, { locked: ui.locked, state: s.state });
      checks.noPageErrors(game, 'k: no console errors / uncaught exceptions');
      await game.close();
    });

  // ═══════════════════════════ l. the window while a lock request is pending ═══════════════════════════
  if (want('l'))
    await checks.section('l. pending lock requests: stale answers, garage selection, re-sortie', async () => {
      const latency = 2200; // answers arrive inside the app's 2.5 s timeout, late enough for several clicks
      let game = await L.openGame(browser, { width: W, height: H, scripted: SCRIPTED });
      let page = game.page;
      await L.clockFreeze(page);
      // (button positions are taken beforehand: inside the timed part only bare mouse clicks are sent)
      const sortieAt0 = await centreOf(page, '[data-act="sortie"]');
      await into(page, 'sortie');
      await L.clockAdvance(page, 2, 250);

      // l1: 再開 (pending) → 格納庫 → 出撃 (pending): the answer to the abandoned request must not end the new sortie
      let info = null;
      let log1 = [];
      let inFlight = false;
      let exitsBefore = 0;
      for (let attempt = 1; attempt <= 3 && !inFlight; attempt++) {
        await esc(page);
        await L.sleep(500);
        const resumeAt = await centreOf(page, '.menu-pause [data-act="resume"]');
        const garageAt = await centreOf(page, '.menu-pause [data-act="garage"]');
        await L.lockMode(page, 'ok', latency);
        const start = await L.lockInfo(page);
        exitsBefore = start.exits;
        await page.mouse.click(resumeAt.x, resumeAt.y);
        await page.mouse.click(garageAt.x, garageAt.y);
        await page.mouse.click(sortieAt0.x, sortieAt0.y);
        await waitLockLog(page, 'LOCKED', start.log.filter((l) => l.includes('LOCKED')).length + 1);
        await L.sleep(600);
        await L.waitForState(page, 'playing', { timeout: 30000 }).catch(() => {});
        await L.realFrames(page, 3);
        info = await L.lockInfo(page);
        log1 = info.log.slice(start.log.length);
        inFlight = log1.findIndex((l) => l.includes('LOCKED')) >= 2 && log1.slice(0, 2).every((l) => l.includes('request('));
        if (!inFlight) {
          // the machine was too slow for three clicks inside the lock latency: settle and try again
          checks.note(`l[stale]: attempt ${attempt} missed the pending window; retrying`, log1);
          await L.lockMode(page, 'ok', 0);
          await L.sleep(latency + 500);
          const st = (await L.snap(page)).state;
          if (st === 'garage') await into(page, 'sortie');
          else if (st === 'paused') await into(page, 'resume');
        }
      }
      let ui = await uiState(page);
      let s = await L.snap(page);
      checks.check('l[stale]: both requests were in flight before the first answer (test precondition)', inFlight, log1);
      checks.check("l[stale]: the sortie started by the last click runs — 'playing' at time 0 with the lock held, no pause menu, no lock release", s.state === 'playing' && s.elapsedSeconds === 0 && ui.locked === 'CANVAS' && ui.panels === 0 && ui.hud && info.exits === exitsBefore, { state: s.state, t: s.elapsedSeconds, locked: ui.locked, panels: ui.panels, exits: [exitsBefore, info.exits], log: log1 });

      // l2: the garage selection changes while the sortie request is pending
      await L.clockAdvance(page, 2, 250);
      await esc(page);
      await L.toGarage(page);
      // (the first switch to four legs builds that leg model, which takes a while in software rendering:
      //  done here, before the timed part)
      await L.selectLoadout(page, { legs: 'quadruped' });
      await L.realFrames(page, 3);
      let before = null;
      let mid = null;
      let midUi = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        await L.selectLoadout(page, { legs: 'biped' });
        await L.realFrames(page, 3);
        before = (await L.snap(page)).loadout;
        const sortieAt = await centreOf(page, '[data-act="sortie"]');
        const quadAt = await centreOf(page, 'button[data-group="legs"][data-id="quadruped"]');
        await L.lockMode(page, 'ok', 2200); // (inside the app's 2.5 s timeout)
        await page.mouse.click(sortieAt.x, sortieAt.y);
        await page.mouse.click(quadAt.x, quadAt.y);
        [mid, midUi] = await page.evaluate(() => [window.__AK2__.getSnapshot(), !!document.querySelector('[data-ui="garage"]')]);
        s = await L.waitForState(page, 'playing');
        if (mid.state === 'garage' && mid.loadout.legs === 'quadruped') break;
        // the machine was too slow for two clicks inside the lock latency: back to the garage and again
        checks.note(`l[garage]: attempt ${attempt} missed the pending window (state ${mid.state}); retrying`);
        await esc(page);
        await L.lockMode(page, 'ok', 0);
        await L.toGarage(page);
      }
      await L.realFrames(page, 2);
      s = await L.snap(page);
      const garageGone = !(await uiState(page)).garage;
      checks.check("l[garage]: the selection was changed while the request was pending (state 'garage', test precondition)", mid.state === 'garage' && midUi && before.legs === 'biped' && mid.loadout.legs === 'quadruped', { state: mid.state, before, mid: mid.loadout });
      checks.check('l[garage]: the sortie uses the build the garage showed when it closed (loadout, legs multiplier, EN)', same(s.loadout, mid.loadout) && s.loadout.legs === 'quadruped' && s.effectiveStats.horizontalSpeedMultiplier === 0.8 && s.player.en === s.effectiveStats.maxEn && garageGone, { sortie: s.loadout, garage: mid.loadout, speedMultiplier: s.effectiveStats.horizontalSpeedMultiplier });
      await esc(page);
      await L.lockMode(page, 'ok', 0);
      const g = await L.toGarage(page);
      checks.check('l[garage]: back in the garage the selection equals the build of that sortie', same(g.loadout, s.loadout), { garage: g.loadout, sortie: s.loadout });

      // l3: further clicks on the same button while its request is pending do not issue another request
      await L.lockMode(page, 'ok', latency);
      const calls0 = (await L.lockInfo(page)).calls;
      await L.clickAct(page, 'sortie');
      await L.sleep(650); // (a separate click, not the second click of a double click)
      await L.clickAct(page, 'sortie');
      s = await L.waitForState(page, 'playing');
      info = await L.lockInfo(page);
      checks.check('l[pending]: a second 出撃 click while the request is pending issues no second request', info.calls === calls0 + 1 && s.elapsedSeconds === 0, { calls: [calls0, info.calls] });
      checks.noPageErrors(game, 'l (factory): no console errors / uncaught exceptions');
      await game.close();
      lap('l1–l3 done');

      // ── re-sortie on the mini stage: nothing changes until the lock is there ──
      game = await L.openGame(browser, { width: W, height: H, path: L.HARNESS_PATH, scripted: SCRIPTED });
      page = game.page;
      await L.clockFreeze(page);
      const garage0 = await L.snap(page);
      const start = garage0.player.position;
      const fresh = (x) => x.elapsedSeconds === 0 && x.player.hp === 1000 && x.player.en === x.effectiveStats.maxEn && L.vecNear(x.player.position, start, 1e-6) && x.recentPlayerShots.length === 0 && x.enemies.every((e) => e.alive && e.shotsFired === 0) && x.objective.controlsDestroyed === 0;
      const fall = async () => {
        await L.keyDown(page, 'KeyS');
        for (let i = 0; i < 20 && (await L.snap(page)).state === 'playing'; i++) await L.clockAdvance(page, 4, 250);
        await L.keyUp(page, 'KeyS');
        return L.snap(page);
      };
      await L.lockMode(page, 'ok', 0);
      await into(page, 'sortie');
      let failed = await fall();
      ui = await uiState(page);
      checks.check("l[result]: reached 'failed' (fell) with the result screen (test precondition)", failed.state === 'failed' && ui.result && ui.resultTitle === 'MISSION FAILED', { state: failed.state, t: failed.elapsedSeconds, title: ui.resultTitle });

      // l4: 再出撃 on the result screen while the lock is pending
      await L.sleep(500);
      await L.lockMode(page, 'ok', latency);
      await L.clickAct(page, 'restart');
      await L.sleep(350);
      await L.realFrames(page, 2);
      const during = await L.snap(page);
      const duringUi = await uiState(page);
      checks.check("l[result]: while the lock is pending nothing has changed — still 'failed', result screen, identical snapshot", during.state === 'failed' && duringUi.result && duringUi.resultTitle === 'MISSION FAILED' && same(during, failed), { state: during.state, t: during.elapsedSeconds, title: duringUi.resultTitle, result: duringUi.result });
      s = await L.waitForState(page, 'playing');
      ui = await uiState(page);
      checks.check('l[result]: once the lock is there the fresh sortie starts (time 0, HP, EN, position, enemies), result screen gone', fresh(s) && ui.panels === 0 && ui.hud && ui.locked === 'CANVAS', { t: s.elapsedSeconds, hp: s.player.hp, pos: s.player.position, panels: ui.panels });

      // l5: 再出撃 on the result screen, lock refused → explanation + retry; the retry starts the fresh sortie
      failed = await fall();
      await L.sleep(500);
      await L.lockMode(page, 'reject', 30);
      await L.clickAct(page, 'restart');
      await page.locator('.menu-plerr').waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
      await L.realFrames(page, 2);
      let refused = await L.snap(page);
      ui = await uiState(page);
      checks.check("l[result, refused]: explanation with retry and garage buttons; the finished sortie is untouched (still 'failed', identical snapshot)", ui.plerr && ui.panels === 1 && !!ui.plerrReason && (await L.actVisible(page, 'resume')) && (await L.actVisible(page, 'garage')) && refused.state === 'failed' && same(refused, failed), { plerr: ui.plerr, reason: ui.plerrReason, state: refused.state, t: refused.elapsedSeconds });
      await L.clickAct(page, 'resume'); // retry, refused again
      await L.sleep(500);
      refused = await L.snap(page);
      ui = await uiState(page);
      checks.check('l[result, refused]: retry refused again → same explanation, still untouched', ui.plerr && refused.state === 'failed' && same(refused, failed), { state: refused.state });
      await L.lockMode(page, 'ok', 0);
      s = await into(page, 'resume'); // retry
      ui = await uiState(page);
      checks.check('l[result, refused]: retry with a working lock → the fresh sortie (not a continuation of the failed one)', fresh(s) && ui.panels === 0 && ui.locked === 'CANVAS', { t: s.elapsedSeconds, hp: s.player.hp, pos: s.player.position });

      // l6: 再出撃 from the pause menu, lock refused → the paused sortie is untouched; retry = the re-sortie
      await L.keyDown(page, 'KeyD');
      await L.clockAdvance(page, 3, 250);
      await L.keyUp(page, 'KeyD');
      const pausedA = await esc(page);
      await L.sleep(500);
      await L.lockMode(page, 'reject', 30);
      await L.clickAct(page, 'restart');
      await page.locator('.menu-plerr').waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
      refused = await L.snap(page);
      checks.check("l[pause, refused re-sortie]: explanation shown; the paused sortie is untouched ('paused', same time and position)", (await uiState(page)).plerr && refused.state === 'paused' && pausedA.elapsedSeconds > 0.5 && same(refused, pausedA), { t: [pausedA.elapsedSeconds, refused.elapsedSeconds], x: refused.player.position[0] });
      await L.lockMode(page, 'ok', 0);
      s = await into(page, 'resume'); // retry of the re-sortie
      checks.check('l[pause, refused re-sortie]: retry → the fresh sortie the player asked for (time 0, start position)', fresh(s), { t: s.elapsedSeconds, pos: s.player.position });

      // l7: the retry button does not stay a "re-sortie": a later refused 再開 is retried as a resume
      await L.keyDown(page, 'KeyD');
      await L.clockAdvance(page, 3, 250);
      await L.keyUp(page, 'KeyD');
      const pausedB = await esc(page);
      await L.sleep(500);
      await L.lockMode(page, 'reject', 30);
      await L.clickAct(page, 'resume');
      await page.locator('.menu-plerr').waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
      await L.lockMode(page, 'ok', 0);
      s = await into(page, 'resume'); // retry of the resume
      checks.check('l[pause, refused resume]: retry → the paused sortie continues at exactly its time and position (no reset)', s.elapsedSeconds === pausedB.elapsedSeconds && pausedB.elapsedSeconds > 0.5 && L.vecNear(s.player.position, pausedB.player.position, 1e-9), { t: [pausedB.elapsedSeconds, s.elapsedSeconds], x: s.player.position[0] });

      // l8: refused re-sortie → 格納庫 → no stale notice, sortie works
      await esc(page);
      await L.sleep(500);
      await L.lockMode(page, 'reject', 30);
      await L.clickAct(page, 'restart');
      await page.locator('.menu-plerr').waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
      const gg = await L.toGarage(page);
      ui = await uiState(page);
      await L.lockMode(page, 'ok', 0);
      s = await into(page, 'sortie');
      checks.check('l[refused re-sortie → garage]: garage at time 0 without a stale notice; the next sortie is fresh', gg.state === 'garage' && gg.elapsedSeconds === 0 && ui.garage && ui.notice === null && ui.panels === 0 && fresh(s), { garage: gg.state, notice: ui.notice, t: s.elapsedSeconds });
      checks.noPageErrors(game, 'l (mini stage): no console errors / uncaught exceptions');
      await game.close();
    });

  // ═══════════════════════════ m. double click on a start / resume button ═══════════════════════════
  if (want('m'))
    await checks.section('m. double click on 出撃 / 再開 / 再出撃 is not a shot', async () => {
      const game = await L.openGame(browser, { width: W, height: H, scripted: SCRIPTED });
      const page = game.page;
      await L.clockFreeze(page);
      /**
       * First click (detail 1) on the button `act`, wait for 'playing', then the second press of the double
       * click (detail 2) held for `holdFrames` frames of 50 ms game time. Returns the snapshots around it.
       */
      const doubleClick = async (act, holdFrames) => {
        const p = await centreOf(page, `[data-act="${act}"]`);
        await page.mouse.move(p.x, p.y);
        await page.mouse.down({ clickCount: 1 });
        await page.mouse.up({ clickCount: 1 });
        const first = await L.waitForState(page, 'playing');
        await L.realFrames(page, 2);
        const before = await L.snap(page);
        await page.mouse.down({ clickCount: 2 });
        await L.realFrames(page, 2); // the press has been seen by a frame (0 s of game time)
        await L.clockAdvance(page, holdFrames, 50);
        const held = await L.snap(page);
        await page.mouse.up({ clickCount: 2 });
        await L.clockAdvance(page, 2, 50);
        return { first, before, held, after: await L.snap(page) };
      };

      // m1: 出撃
      let r = await doubleClick('sortie', 2);
      checks.check('m[出撃]: the second click of a double click (held 0.1 s of game time) fires nothing', shotsOf(r.after) === 0 && r.after.player.ammo.machinegun === 300 && r.after.state === 'playing', { shots: shotsOf(r.after), ammo: r.after.player.ammo.machinegun, t: r.after.elapsedSeconds });
      // … and the trigger is not dead afterwards: the next press (third click of the series or not) fires at once
      let t = (await L.snap(page)).elapsedSeconds;
      await page.mouse.down({ clickCount: 3 });
      await L.realFrames(page, 2);
      await L.clockAdvance(page, 2, 50);
      await page.mouse.up({ clickCount: 3 });
      await L.clockAdvance(page, 1, 50);
      let s = await L.snap(page);
      checks.check('m[出撃]: the next press fires immediately (first shot within one tick of the press)', shotsOf(s) >= 1 && s.recentPlayerShots[0].firedAtSeconds - t <= 1 / 120 + 1e-9, { shots: shotsOf(s), firstAt: s.recentPlayerShots[0]?.firedAtSeconds, pressedAt: t });

      // m2: 再開
      await esc(page);
      await L.sleep(900);
      let ammo = (await L.snap(page)).player.ammo.machinegun;
      r = await doubleClick('resume', 2);
      checks.check('m[再開]: the second click of a double click fires nothing', r.after.player.ammo.machinegun === ammo && r.after.state === 'playing', { ammo: [ammo, r.after.player.ammo.machinegun] });

      // m3: 再開, then the follow-up press is HELD: that is a trigger pull, it starts firing after 0.2 s
      await esc(page);
      await L.sleep(900);
      ammo = (await L.snap(page)).player.ammo.machinegun;
      const lastId = (await L.snap(page)).recentPlayerShots.at(-1)?.id ?? 0;
      r = await doubleClick('resume', 8);
      const newShots = r.held.recentPlayerShots.filter((x) => x.id > lastId);
      const delay = newShots.length ? newShots[0].firedAtSeconds - r.before.elapsedSeconds : null;
      checks.check('m[再開]: a follow-up press that stays down for 0.4 s is a trigger pull: firing starts 0.2 s after the press', newShots.length >= 2 && delay !== null && delay >= 0.2 - 1e-9 && delay <= 0.2 + 0.05 + 1 / 120 + 1e-9, { shots: newShots.length, firstShotAfterSeconds: delay });

      // m4: 再出撃 from the pause menu
      await esc(page);
      await L.sleep(900);
      r = await doubleClick('restart', 2);
      checks.check('m[再出撃]: the second click of a double click fires nothing (fresh sortie, 300 rounds)', shotsOf(r.after) === 0 && r.after.player.ammo.machinegun === 300 && r.first.elapsedSeconds === 0, { shots: shotsOf(r.after), ammo: r.after.player.ammo.machinegun });

      // m5: a single click on 再開 followed by an ordinary press (detail 1) fires without any delay
      await esc(page);
      await L.sleep(900);
      const id0 = (await L.snap(page)).recentPlayerShots.at(-1)?.id ?? 0;
      const resumed = await into(page, 'resume');
      await L.realFrames(page, 2);
      await page.mouse.down({ clickCount: 1 });
      await L.realFrames(page, 2);
      await L.clockAdvance(page, 3, 50);
      await page.mouse.up({ clickCount: 1 });
      await L.clockAdvance(page, 1, 50);
      s = await L.snap(page);
      const fired = s.recentPlayerShots.filter((x) => x.id > id0);
      checks.check('m[再開]: single click, then an ordinary press: first shot within one tick, 0.10 s cadence', fired.length === 2 && fired[0].firedAtSeconds - resumed.elapsedSeconds <= 1 / 120 + 1e-9 && L.near(fired[1].firedAtSeconds - fired[0].firedAtSeconds, 0.1, 1e-9), fired.map((x) => x.firedAtSeconds));
      checks.noPageErrors(game, 'm: no console errors / uncaught exceptions');
      await game.close();
    });

  // ═══════════════════════════ n. re-sortie resets the mech's animation state ═══════════════════════════
  if (want('n'))
    await checks.section('n. no glide stance / thruster flames carried into a re-sortie', async () => {
      const game = await L.openGame(browser, { width: W, height: H, scripted: SCRIPTED });
      const page = game.page;
      await L.clockFreeze(page);
      // the mech (chase camera) fills the lower middle of the view; the HUD panels are left, right and below
      const region = { x: W * 0.36, y: H * 0.5, width: W * 0.28, height: H * 0.4 };
      const pixels = Math.round(region.width * region.height);
      await into(page, 'sortie');
      await L.realFrames(page, 3);
      const first = await L.capture(page, 'n-first-sortie-t0');
      await L.realFrames(page, 3);
      const firstAgain = await L.capture(page);
      // quick boost forward → glide
      await L.keyDown(page, 'KeyW');
      await page.keyboard.press('KeyQ');
      await L.realFrames(page, 2);
      await L.clockAdvance(page, 4, 250);
      const gliding = await L.snap(page);
      const glideShot = await L.capture(page, 'n-gliding');
      await L.keyUp(page, 'KeyW');
      await esc(page);
      await L.sleep(500);
      const again = await into(page, 'restart');
      await L.realFrames(page, 3);
      const re = await L.capture(page, 'n-resortie-t0');
      // Pixels that have no counterpart within 2 px in the other picture: the idle animation (breathing,
      // ±1 px outlines) does not count, flames or a different stance do.
      const differ = (a, b) => L.countDifferentPixels(a, b, region, 90, 2);
      const allowed = Math.round(pixels * 0.006);
      const noise = differ(first, firstAgain);
      const whileGliding = differ(first, glideShot);
      const afterRestart = differ(first, re);
      checks.check('n: test precondition — the mech was gliding with its thrusters lit before the re-sortie (picture differs clearly)', gliding.player.movement.horizontalMode === 'glide' && whileGliding > pixels * 0.05, { mode: gliding.player.movement.horizontalMode, differentPixels: whileGliding, of: pixels });
      checks.check('n: at time 0 of the re-sortie the mech looks as at time 0 of the first sortie (no flames, idle stance)', again.elapsedSeconds === 0 && noise === 0 && afterRestart <= allowed, { differentPixels: afterRestart, sameFrameNoise: noise, allowed, of: pixels });

      // the same through the garage (the hangar shows the same model)
      await L.keyDown(page, 'KeyW');
      await page.keyboard.press('KeyQ');
      await L.realFrames(page, 2);
      await L.clockAdvance(page, 4, 250);
      await L.keyUp(page, 'KeyW');
      await esc(page);
      await L.sleep(300);
      await L.toGarage(page);
      const s = await into(page, 'sortie');
      await L.realFrames(page, 3);
      const viaGarage = await L.capture(page, 'n-sortie-after-garage-t0');
      const afterGarage = differ(first, viaGarage);
      checks.check('n: the same after glide → garage → sortie', s.elapsedSeconds === 0 && afterGarage <= allowed, { differentPixels: afterGarage, allowed, of: pixels });
      checks.noPageErrors(game, 'n: no console errors / uncaught exceptions');
      await game.close();
    });

  // ═══════════════════════════ o. HUD centre: reticle vs route marker ═══════════════════════════
  if (want('o'))
    await checks.section('o. the centre reticle is not covered by the route marker', async () => {
      const game = await L.openGame(browser, { width: 1280, height: 720, scripted: SCRIPTED });
      const page = game.page;
      await L.clockFreeze(page);
      await into(page, 'sortie');
      await L.realFrames(page, 3);
      const measure = () =>
        page.evaluate(() => {
          const rect = (e) => {
            const r = e.getBoundingClientRect();
            return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height };
          };
          /** Rendered at all (the marker roots are 0 × 0 boxes whose children overflow: size is not asked here). */
          const styled = (e) => {
            for (let n = e; n && n.nodeType === 1; n = n.parentElement) {
              const cs = getComputedStyle(n);
              if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
            }
            return true;
          };
          const shown = (e) => {
            if (!styled(e)) return false;
            const r = e.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          };
          const hud = document.querySelector('.ak2-hud');
          const reticle = document.querySelector('.hud-reticle');
          const markers = document.querySelector('.hud-markers');
          const route = document.querySelector('.hud-mk-route');
          const tag = route.querySelector('.hud-rtag');
          const chev = route.querySelector('.on svg.rt');
          // paint order inside the HUD: later siblings with the same z-index are painted above earlier ones
          const layerOf = (e) => {
            let n = e;
            while (n.parentElement && n.parentElement !== hud) n = n.parentElement;
            return n;
          };
          const order = (layer) => {
            const z = getComputedStyle(layer).zIndex;
            return [z === 'auto' ? 0 : Number(z), Array.prototype.indexOf.call(hud.children, layer)];
          };
          const ro = order(layerOf(reticle));
          const mo = order(layerOf(markers));
          const s = window.__AK2__.getSnapshot();
          const rowEl = document.querySelector('.hud-route');
          return {
            t: s.elapsedSeconds,
            z: s.player.position[2],
            reticle: rect(reticle),
            reticleShown: shown(reticle),
            reticleAbove: ro[0] > mo[0] || (ro[0] === mo[0] && ro[1] > mo[1]),
            routeShown: styled(route),
            routeOpacity: Number(getComputedStyle(route).opacity),
            edge: route.classList.contains('is-edge'),
            tag: shown(tag) ? rect(tag) : null,
            tagText: tag.textContent,
            chevrons: shown(chev) ? rect(chev) : null,
            row: rowEl && shown(rowEl) ? rowEl.textContent : null,
          };
        });
      const overlap = (a, b, pad = 0) => !!a && !!b && a.l < b.r + pad && a.r > b.l - pad && a.t < b.b + pad && a.b > b.t - pad;
      const samples = [await measure()];
      await L.capture(page, 'o-centre-at-sortie-1280x720');
      await L.keyDown(page, 'KeyW');
      for (let i = 0; i < 7; i++) {
        await L.clockAdvance(page, 4, 250);
        samples.push(await measure());
        if (i === 3) await L.capture(page, 'o-centre-walking-1280x720');
      }
      await L.keyUp(page, 'KeyW');
      const first = samples[0];
      const centred = first.reticleShown && Math.abs((first.reticle.l + first.reticle.r) / 2 - 640) <= 1 && Math.abs((first.reticle.t + first.reticle.b) / 2 - 360) <= 1;
      checks.check('o: the reticle is shown at the centre of the display area', centred, first.reticle);
      checks.check('o: the reticle layer is painted above the world-marker layer', samples.every((m) => m.reticleAbove), samples.map((m) => m.reticleAbove));
      const covering = samples.filter((m) => m.routeShown && !m.edge && overlap(m.tag, m.reticle, 2));
      checks.check('o: the text tag of the route marker never overlaps the reticle (sortie start and 7 s of walking towards the waypoint)', covering.length === 0, covering.length ? covering.map((m) => ({ t: m.t, tag: m.tag, reticle: m.reticle, text: m.tagText })) : samples.map((m) => [m.t, m.tagText.trim(), m.tag ? Math.round(m.tag.t) + '–' + Math.round(m.tag.b) : 'hidden']));
      const guided = samples.filter((m) => (m.routeShown && (m.chevrons || m.edge)) || (m.row && m.row.includes('進路')));
      checks.check('o: the next direction stays identifiable in every sample (route chevrons on screen and the 進路 row of the top-left panel)', guided.length === samples.length && samples.filter((m) => m.routeShown && m.chevrons).length >= 4 && samples.every((m) => m.row && m.row.includes('進路')), samples.map((m) => ({ t: m.t, chevrons: !!m.chevrons, opacity: m.routeOpacity, row: m.row })));
      checks.noPageErrors(game, 'o: no console errors / uncaught exceptions');
      await game.close();
    });

  // ═══════════════════════════ p. page icon ═══════════════════════════
  if (want('p'))
    await checks.section('p. inline page icon (no /favicon.ico request)', async () => {
      for (const [label, pagePath] of [
        ['shipped page', ''],
        ['harness page', L.HARNESS_PATH],
      ]) {
        const game = await L.openGame(browser, { width: W, height: H, path: pagePath, waitReady: false });
        const icon = await game.page.evaluate(async () => {
          const link = document.querySelector('link[rel~="icon"]');
          if (!link) return null;
          const href = link.getAttribute('href') ?? '';
          const img = new Image();
          const loaded = await new Promise((resolve) => {
            img.onload = () => resolve(true);
            img.onerror = () => resolve(false);
            img.src = href;
          });
          return { inline: href.startsWith('data:image/'), length: href.length, loaded, width: img.naturalWidth };
        });
        checks.check(`p[${label}]: <link rel="icon"> with an inline data: image that decodes`, !!icon && icon.inline && icon.loaded && icon.width > 0, icon);
        const asked = game.requests.filter((u) => /favicon/i.test(u));
        checks.check(`p[${label}]: no favicon request to the server`, asked.length === 0, asked);
        await game.close();
      }
    });

  // ═══════════════════════════ y. press edges on displays faster than 120 Hz ═══════════════════════════
  if (want('y'))
    await checks.section('y. a tap that is over before the next simulation tick is not lost (240 / 360 Hz frames)', async () => {
      const game = await L.openGame(browser, { width: W, height: H, path: L.HARNESS_PATH, scripted: SCRIPTED });
      const page = game.page;
      await L.clockFreeze(page);
      await into(page, 'sortie');
      await L.realFrames(page, 2);
      // While the clock stands still every rendered frame feeds 0 s: frames WITHOUT a simulation tick, exactly
      // what a 240 / 360 Hz display produces between two ticks. Each tap below is pressed and released in that
      // window (real input events; several tick-less frames see it), then game time runs on in 1/240 s or
      // 1/360 s frames, so the first frame after the tap may run no tick either.
      const ammoOf = (s) => s.player.ammo.machinegun;
      const gap = () => L.clockAdvance(page, 5, 250); // 1.25 s of game time: QB cooldown over, landed, EN back

      for (const hz of [240, 360]) {
        const step = 1000 / hz;
        // ── left button: one click = one shot, at every phase of the frame / tick pattern ──
        const shotsPerClick = [];
        for (let phase = 0; phase < 3; phase++) {
          await L.clockAdvance(page, 30 + phase, step); // ≥ 0.10 s since the previous shot, shifted by one frame each time
          const before = await L.snap(page);
          await page.mouse.down();
          await page.mouse.up();
          await L.realFrames(page, 2);
          const seen = await L.snap(page);
          await L.clockAdvance(page, 36, step); // 0.15 s / 0.10 s of game time
          const after = await L.snap(page);
          shotsPerClick.push({ ticklessFrame: seen.elapsedSeconds === before.elapsedSeconds, shots: ammoOf(before) - ammoOf(after) });
        }
        checks.check(`y[${hz} Hz]: a click released before the next tick fires exactly one shot (3 phases)`, shotsPerClick.every((r) => r.ticklessFrame && r.shots === 1), shotsPerClick);

        // ── Q: exactly one quick boost per press ──
        await gap();
        let before = await L.snap(page);
        await L.tapKey(page, 'KeyQ', 30);
        await L.realFrames(page, 2);
        await L.clockAdvance(page, 60, step);
        let after = await L.snap(page);
        const qb = after.player.movement.qbSuccessfulCount - before.player.movement.qbSuccessfulCount;
        checks.check(`y[${hz} Hz]: a Q tap is exactly one quick boost (count +1, EN −36)`, qb === 1 && L.near(before.player.en - after.player.en, 36, 1e-9), { qb, en: [before.player.en, after.player.en] });
        const boosted = after; // (the quick boost left the automatic glide on)
        await L.tapKey(page, 'ControlLeft', 30);
        await L.realFrames(page, 2);
        await L.clockAdvance(page, 60, step);
        after = await L.snap(page);
        checks.check(`y[${hz} Hz]: a Left Ctrl tap switches the glide off (it was on after the quick boost)`, boosted.player.movement.glideEnabled === true && after.player.movement.glideEnabled === false, { before: boosted.player.movement.glideEnabled, after: after.player.movement.glideEnabled, mode: after.player.movement.horizontalMode });

        // ── Shift: one toggle per press ──
        await L.tapKey(page, 'ShiftLeft', 30);
        await L.realFrames(page, 2);
        await L.clockAdvance(page, 6, step);
        const on = await L.snap(page);
        await L.tapKey(page, 'ShiftLeft', 30);
        await L.realFrames(page, 2);
        await L.clockAdvance(page, 6, step);
        const off = await L.snap(page);
        checks.check(`y[${hz} Hz]: a Shift tap toggles the glide exactly once (on, then off with the next tap)`, on.player.movement.glideEnabled === true && off.player.movement.glideEnabled === false, { afterFirstTap: on.player.movement.glideEnabled, afterSecondTap: off.player.movement.glideEnabled });

        // ── Space: one jump ──
        await gap();
        before = await L.snap(page);
        await L.tapKey(page, 'Space', 30);
        await L.realFrames(page, 2);
        await L.clockAdvance(page, 6, step);
        const up = await L.snap(page);
        await gap();
        after = await L.snap(page);
        checks.check(`y[${hz} Hz]: a Space tap is one normal jump (leaves the ground at ≈ 10 m/s, lands again, no EN used)`, before.player.grounded && !up.player.grounded && up.player.velocity[1] > 9 && after.player.grounded && after.player.en >= before.player.en, { groundedBefore: before.player.grounded, vyAfterTap: up.player.velocity[1], groundedLater: after.player.grounded, en: [before.player.en, after.player.en] });

        // ── 1 / 2 / 3 ──
        const weapons = [];
        for (const code of ['Digit2', 'Digit3', 'Digit1']) {
          await L.tapKey(page, code, 30);
          await L.realFrames(page, 2);
          await L.clockAdvance(page, 3, step);
          weapons.push((await L.snap(page)).player.weapon);
        }
        checks.check(`y[${hz} Hz]: taps on 2 / 3 / 1 select beam / missile / machine gun`, JSON.stringify(weapons) === '["beam","missile","machinegun"]', weapons);

        // ── held trigger: the weapon's cadence, independent of the frame rate ──
        await gap();
        const last = (await L.snap(page)).recentPlayerShots.at(-1)?.id ?? 0;
        await page.mouse.down();
        await L.realFrames(page, 2);
        await L.clockAdvance(page, Math.round(hz * 0.55), step);
        await page.mouse.up();
        await L.clockAdvance(page, 3, step);
        const burst = (await L.snap(page)).recentPlayerShots.filter((x) => x.id > last);
        const gaps = burst.slice(1).map((x, i) => x.firedAtSeconds - burst[i].firedAtSeconds);
        await L.clockAdvance(page, 60, step);
        const later = (await L.snap(page)).recentPlayerShots.filter((x) => x.id > last);
        checks.check(`y[${hz} Hz]: trigger held 0.55 s → 6 shots exactly 0.10 s apart, none after the release`, burst.length === 6 && gaps.every((g) => L.near(g, 0.1, 1e-9)) && later.length === 6, { shots: burst.length, gaps, afterRelease: later.length - burst.length });
        lap(`y: ${hz} Hz`);
      }
      checks.noPageErrors(game, 'y: no console errors / uncaught exceptions');
      await game.close();
    });
} catch (err) {
  checks.check('script completed without exception', false, String(err && err.stack ? err.stack : err));
} finally {
  await browser.close().catch(() => {});
}
lap('done');
process.exit(checks.finish());
