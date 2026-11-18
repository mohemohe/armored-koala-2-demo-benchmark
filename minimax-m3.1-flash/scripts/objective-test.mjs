import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://127.0.0.1:4173/';
const shotDir = process.argv[3] ?? '/tmp/opencode';

const browser = await chromium.launch({
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
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
/* 1. barrier opens when the control turret dies                        */
/* ------------------------------------------------------------------ */
await page.goto(base + '?test=barrier', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await page.click('#btn-start');
await page.waitForTimeout(600);

const barrier = await page.evaluate(async () => {
  const api = window.__AK2__;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const canvas = document.getElementById('viewport');
  const before = api.getSnapshot();
  // wait for the lock on the control turret, then destroy it
  let locked = false;
  for (let i = 0; i < 40; i++) {
    await sleep(100);
    const s = api.getSnapshot();
    if (s.lock.state === 'locked' && s.lock.targetId === 'E-TUR-01') {
      locked = true;
      break;
    }
  }
  canvas.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
  let guard = 0;
  let dead = false;
  while (guard < 200) {
    await sleep(100);
    const s = api.getSnapshot();
    const t = s.enemies.find((e) => e.id === 'E-TUR-01');
    if (t && !t.alive) {
      dead = true;
      break;
    }
    guard++;
  }
  window.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
  const after = api.getSnapshot();
  return {
    locked,
    dead,
    controls: after.objective.controlsDestroyed,
    openBarriers: after.objective.openBarrierIds,
    gateOpen: after.objective.gateOpen,
    turretHp: after.enemies.find((e) => e.id === 'E-TUR-01')?.hp
  };
});
check('the control turret can be locked and destroyed', barrier.locked && barrier.dead, JSON.stringify(barrier));
check(
  'destroying a control turret opens its barrier',
  barrier.controls === 1 && barrier.openBarriers.includes('BR1'),
  `controls=${barrier.controls} open=${JSON.stringify(barrier.openBarriers)}`
);
check('the final gate stays closed until all six are destroyed', !barrier.gateOpen, `gateOpen=${barrier.gateOpen}`);

/* ------------------------------------------------------------------ */
/* 2. all six control turrets -> final gate -> clear                    */
/* ------------------------------------------------------------------ */
await page.goto(base + '?test=clear', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await page.click('#btn-start');
await page.waitForTimeout(600);
const clear = await page.evaluate(async () => {
  const api = window.__AK2__;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const canvas = document.getElementById('viewport');
  canvas.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
  let guard = 0;
  let s = api.getSnapshot();
  while (guard < 260 && s.objective.controlsDestroyed < 6) {
    await sleep(100);
    s = api.getSnapshot();
    guard++;
  }
  window.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
  await sleep(600);
  const fin = api.getSnapshot();
  return {
    controls: fin.objective.controlsDestroyed,
    openBarriers: fin.objective.openBarrierIds,
    gateOpen: fin.objective.gateOpen,
    state: fin.state,
    sector: fin.stage.currentSectorId
  };
});
check(
  'all six control turrets open the final evacuation gate',
  clear.controls === 6 && clear.openBarriers.length === 6 && clear.gateOpen,
  JSON.stringify(clear)
);
check('reaching the evacuation zone clears the sortie', clear.state === 'cleared', `state=${clear.state} sector=${clear.sector}`);
await page.screenshot({ path: `${shotDir}/clear.png` });

/* ------------------------------------------------------------------ */
/* 3. re-sortie resets barriers, hostiles, ammunition and the clock      */
/* ------------------------------------------------------------------ */
await page.click('#ov-resume');
await page.waitForTimeout(1200);
const restart = await snap();
check(
  'the re-sortie resets the objective state',
  restart.state === 'playing' &&
    restart.objective.controlsDestroyed === 0 &&
    restart.objective.openBarrierIds.length === 0 &&
    restart.objective.gateOpen === false,
  JSON.stringify(restart.objective)
);
check(
  'the re-sortie restores every hostile and the player',
  restart.enemies.every((e) => e.alive && e.hp > 0) &&
    restart.player.hp === 1000 &&
    restart.player.en === restart.effectiveStats.maxEn &&
    restart.player.ammo.machinegun === 300 &&
    restart.player.ammo.missile === 12,
  `hp=${restart.player.hp} en=${restart.player.en} ammo=${restart.player.ammo.machinegun}/${restart.player.ammo.missile} alive=${restart.enemies.filter((e) => e.alive).length}`
);
check(
  'the re-sortie resets the clock and the movement state',
  restart.elapsedSeconds < 2 &&
    restart.player.movement.qbSuccessfulCount === 0 &&
    restart.player.movement.glideEnabled === false &&
    (restart.lock.state === 'none' || restart.lock.state === 'acquiring'),
  `elapsed=${restart.elapsedSeconds.toFixed(2)} qb=${restart.player.movement.qbSuccessfulCount} lock=${restart.lock.state}`
);

const failed = results.filter((r) => !r.ok);
console.log(failed.length === 0 ? 'ALL OBJECTIVE CHECKS PASSED' : `${failed.length} CHECKS FAILED`);
await browser.close();
process.exit(failed.length === 0 ? 0 : 1);
