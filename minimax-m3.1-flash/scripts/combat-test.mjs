import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://127.0.0.1:4173/';
const shotDir = process.argv[3] ?? '/tmp/opencode';

const browser = await chromium.launch({
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[console.error]', m.text());
});

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail ?? ''}`);
};
const snap = () => page.evaluate(() => window.__AK2__.getSnapshot());

/* ------------------------------------------------------------------ */
/* 1. exposure test : 2 guards + 1 turret kill a static 1000 HP player */
/* ------------------------------------------------------------------ */
await page.goto(base + '?test=exposure', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await page.click('#btn-start');
await page.waitForTimeout(600);

const exposure = await page.evaluate(async () => {
  const api = window.__AK2__;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const s0 = api.getSnapshot();
  let firstHitAt = null;
  let elapsed = 0;
  while (elapsed < 16) {
    await sleep(100);
    const s = api.getSnapshot();
    elapsed = s.elapsedSeconds - s0.elapsedSeconds;
    if (s.player.hp < 1000 && firstHitAt === null) firstHitAt = elapsed;
    if (s.player.hp <= 0) break;
  }
  const s = api.getSnapshot();
  const engaged = s.enemies.filter((e) => e.hasLineOfSight);
  return {
    elapsed,
    hp: s.player.hp,
    firstHitAt,
    state: s.state,
    losCount: engaged.length,
    shotsFired: s.enemies.reduce((a, e) => a + e.shotsFired, 0),
    alerted: s.enemies.filter((e) => e.alert).length
  };
});
check(
  'two guards and one turret engage a stationary player',
  exposure.losCount >= 3,
  `enemies with line of sight: ${exposure.losCount}, shots fired: ${exposure.shotsFired}`
);
check(
  'the player takes damage',
  exposure.firstHitAt !== null,
  `first damage after ${exposure.firstHitAt?.toFixed(2)} s`
);
check(
  'the exposed player is destroyed within 15 s',
  exposure.hp <= 0 && exposure.elapsed <= 15.5,
  `hp=${exposure.hp} after ${exposure.elapsed.toFixed(2)} s (state ${exposure.state})`
);

await page.screenshot({ path: `${shotDir}/exposure.png` });

/* ------------------------------------------------------------------ */
/* 2. FCS lock + machinegun hit in the live game                       */
/* ------------------------------------------------------------------ */
await page.goto(base + '?test=exposure', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await page.click('#btn-start');
await page.waitForTimeout(600);

const combat = await page.evaluate(async () => {
  const api = window.__AK2__;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const canvas = document.getElementById('viewport');
  const out = { locked: false, lockProgress: 0, shots: [], damaged: [] };
  // wait for the lock to complete on one of the arena enemies
  for (let i = 0; i < 60; i++) {
    await sleep(100);
    const s = api.getSnapshot();
    out.lockProgress = Math.max(out.lockProgress, s.lock.progress);
    if (s.lock.state === 'locked') {
      out.locked = true;
      out.targetId = s.lock.targetId;
      break;
    }
  }
  const hpBefore = {};
  const s0 = api.getSnapshot();
  for (const e of s0.enemies) hpBefore[e.id] = e.hp;
  // fire the machinegun
  canvas.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
  await sleep(2500);
  window.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
  const s1 = api.getSnapshot();
  out.shots = s1.recentPlayerShots.slice(-6).map((r) => ({
    weapon: r.weapon,
    status: r.solutionStatus,
    t: r.predictedFlightSeconds
  }));
  out.shotCount = s1.recentPlayerShots.length;
  out.solvedShots = s1.recentPlayerShots.filter((r) => r.solutionStatus === 'solved').length;
  out.damaged = s1.enemies.filter((e) => e.hp < (hpBefore[e.id] ?? e.hp)).map((e) => ({ id: e.id, hp: e.hp }));
  out.lockState = s1.lock.state;
  out.fireControlStatus = s1.fireControl.status;
  return out;
});
check('the FCS locks a target in game', combat.locked, `progress ${combat.lockProgress.toFixed(2)}`);
check(
  'locked machinegun shots report a solved solution',
  combat.solvedShots > 0,
  `${combat.solvedShots}/${combat.shotCount} shots solved`
);
check(
  'locked shots damage the locked enemy',
  combat.damaged.length > 0,
  JSON.stringify(combat.damaged)
);

/* ------------------------------------------------------------------ */
/* 3. the missile refuses to fire while the lock is incomplete          */
/* ------------------------------------------------------------------ */
await page.goto(base + '?test=exposure&yaw=3.14159', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await page.click('#btn-start');
const missile = await page.evaluate(async () => {
  const api = window.__AK2__;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const canvas = document.getElementById('viewport');
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit3', bubbles: true }));
  window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Digit3', bubbles: true }));
  const before = api.getSnapshot();
  // fire immediately: the lock cannot be complete yet
  canvas.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
  await sleep(250);
  const during = api.getSnapshot();
  window.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
  return {
    weapon: during.player.weapon,
    lockState: during.lock.state,
    lockProgress: during.lock.progress,
    ammoBefore: before.player.ammo.missile,
    ammoAfter: during.player.ammo.missile,
    shots: during.recentPlayerShots.length
  };
});
check(
  'the missile does not fire while the lock is incomplete',
  missile.ammoBefore === missile.ammoAfter && missile.shots === 0,
  `lock=${missile.lockState} progress=${missile.lockProgress.toFixed(2)} ammo ${missile.ammoBefore} -> ${missile.ammoAfter} shots=${missile.shots}`
);

/* ------------------------------------------------------------------ */
/* 4. the missile fires once the lock is complete                       */
/* ------------------------------------------------------------------ */
await page.goto(base + '?test=exposure', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await page.click('#btn-start');
const missile2 = await page.evaluate(async () => {
  const api = window.__AK2__;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const canvas = document.getElementById('viewport');
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit3', bubbles: true }));
  window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Digit3', bubbles: true }));
  await sleep(150);
  let guard = 0;
  let s = api.getSnapshot();
  while (guard < 60 && s.lock.state !== 'locked') {
    await sleep(100);
    s = api.getSnapshot();
    guard++;
  }
  const ammoBefore = s.player.ammo.missile;
  canvas.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
  await sleep(400);
  window.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
  const after = api.getSnapshot();
  return {
    lock: after.lock.state,
    weapon: after.player.weapon,
    ammoBefore,
    ammoAfter: after.player.ammo.missile,
    shots: after.recentPlayerShots.length,
    statuses: after.recentPlayerShots.map((r) => r.solutionStatus)
  };
});
check(
  'the missile fires once the lock is complete',
  missile2.ammoAfter === missile2.ammoBefore - 1 && missile2.shots > 0,
  `lock=${missile2.lock} ammo ${missile2.ammoBefore} -> ${missile2.ammoAfter} shots=${missile2.shots}`
);

await page.screenshot({ path: `${shotDir}/combat.png` });
const failed = results.filter((r) => !r.ok);
console.log(failed.length === 0 ? 'ALL COMBAT CHECKS PASSED' : `${failed.length} CHECKS FAILED`);
await browser.close();
process.exit(failed.length === 0 ? 0 : 1);
