import { chromium } from 'playwright';

const url = process.argv[2] ?? 'http://127.0.0.1:4173/';
const shotDir = process.argv[3] ?? '/tmp/opencode';

const browser = await chromium.launch({
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[console.error]', m.text());
});

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

const snap = () => page.evaluate(() => window.__AK2__.getSnapshot());
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail ?? ''}`);
};
const inPage = (fn, arg) => page.evaluate(fn, arg);
const keyDown = (code) => page.keyboard.down(code);
const keyUp = (code) => page.keyboard.up(code);

/** restarts the sortie so every measurement starts from the same state */
async function restart() {
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await page.click('#btn-start');
  await page.waitForTimeout(600);
}

await page.click('#btn-start');
await page.waitForTimeout(500);
let s = await snap();
check('sortie starts', s.state === 'playing', `state=${s.state}`);
check(
  'the player starts in the intake dock',
  s.stage.currentSectorId === 'intake',
  `sector=${s.stage.currentSectorId} pos=${s.player.position.map((v) => v.toFixed(1)).join(',')}`
);
check('the player starts untouched', s.player.hp === 1000 && s.player.en === 120, `hp=${s.player.hp} en=${s.player.en}`);

/* ------------------------------------------------------------------ */
/* A. QB travel distance                                               */
/* ------------------------------------------------------------------ */
const dist = await inPage(async () => {
  const api = window.__AK2__;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const key = (code, type) => window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true, cancelable: true }));
  const s0 = api.getSnapshot();
  key('KeyQ', 'keydown');
  key('KeyQ', 'keyup');
  // sample (simTime, distance) and interpolate the distance at exactly 0.75 s
  const samples = [];
  let travelled = 0;
  let prev = api.getSnapshot().player.position;
  let elapsed = 0;
  let enAfterQb = null;
  while (elapsed < 0.8) {
    await sleep(8);
    const cur = api.getSnapshot();
    const p = cur.player.position;
    travelled += Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]);
    prev = p;
    elapsed = cur.elapsedSeconds - s0.elapsedSeconds;
    samples.push([elapsed, travelled]);
    if (enAfterQb === null && elapsed > 0.2) enAfterQb = cur.player.en;
  }
  // linear interpolation to 0.75 s
  let at075 = travelled;
  for (let i = 1; i < samples.length; i++) {
    const [t0, d0] = samples[i - 1];
    const [t1, d1] = samples[i];
    if (t1 >= 0.75 && t0 <= 0.75) {
      const f = (0.75 - t0) / Math.max(1e-6, t1 - t0);
      at075 = d0 + (d1 - d0) * f;
      break;
    }
  }
  const fin = api.getSnapshot();
  return {
    travelled: at075,
    raw: travelled,
    elapsed,
    enAfterQb,
    mode: fin.player.movement.horizontalMode,
    en: fin.player.en,
    count: fin.player.movement.qbSuccessfulCount
  };
});
check(
  'biped QB covers ~42.6 m in 0.75 s',
  Math.abs(dist.travelled - 42.6) < 1.5,
  `travelled=${dist.travelled.toFixed(2)} m over ${dist.elapsed.toFixed(3)} s (the window includes the glide tail)`
);
check('QB falls back into a glide', dist.mode === 'glide', `horizontalMode=${dist.mode}`);
check(
  'QB consumed 36 EN once',
  dist.enAfterQb !== null && Math.abs(120 - dist.enAfterQb - 36) < 0.6 && dist.count === 1,
  `en=${dist.enAfterQb?.toFixed(2)} count=${dist.count}`
);

/* ------------------------------------------------------------------ */
/* B. holding Q must not retrigger                                     */
/* ------------------------------------------------------------------ */
await restart();
const held = await inPage(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyQ', bubbles: true }));
  await sleep(5000);
  window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyQ', bubbles: true }));
  return window.__AK2__.getSnapshot();
});
check(
  'holding Q for 5 s performs exactly one QB',
  held.player.movement.qbSuccessfulCount === 1,
  `count=${held.player.movement.qbSuccessfulCount} en=${held.player.en.toFixed(1)}`
);

/* ------------------------------------------------------------------ */
/* C. glide: free, 22 m/s, keeps running without input                 */
/* ------------------------------------------------------------------ */
await restart();
const glide = await inPage(async () => {
  const api = window.__AK2__;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const key = (code, type) => window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true, cancelable: true }));
  const en0 = api.getSnapshot().player.en;
  key('ShiftLeft', 'keydown');
  key('ShiftLeft', 'keyup');
  await sleep(900);
  const p0 = api.getSnapshot().player.position;
  const mid = api.getSnapshot();
  await sleep(700);
  const p1 = api.getSnapshot().player.position;
  const fin = api.getSnapshot();
  const dist = Math.hypot(p1[0] - p0[0], p1[2] - p0[2]);
  return {
    en0,
    en1: fin.player.en,
    glideEnabled: fin.player.movement.glideEnabled,
    mode: fin.player.movement.horizontalMode,
    speed: Math.hypot(mid.player.velocity[0], mid.player.velocity[2]),
    dist,
    elapsed: fin.elapsedSeconds - mid.elapsedSeconds
  };
});
check('the glide engages with Shift', glide.glideEnabled && glide.mode === 'glide', JSON.stringify(glide));
check('the glide reaches 22 m/s', Math.abs(glide.speed - 22) < 1.5, `speed=${glide.speed.toFixed(2)} m/s`);
check('the glide keeps moving without input', glide.dist > 8, `${glide.dist.toFixed(1)} m`);
check('the glide costs no EN', Math.abs(glide.en1 - glide.en0) < 0.6, `en ${glide.en0.toFixed(1)} -> ${glide.en1.toFixed(1)}`);

/* ------------------------------------------------------------------ */
/* D. brake stops the glide                                            */
/* ------------------------------------------------------------------ */
const brake = await inPage(async () => {
  const api = window.__AK2__;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const key = (code, type) => window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true, cancelable: true }));
  key('ControlLeft', 'keydown');
  await sleep(1200);
  const mid = api.getSnapshot();
  await sleep(600);
  const fin = api.getSnapshot();
  key('ControlLeft', 'keyup');
  return {
    mode: mid.player.movement.horizontalMode,
    glide: mid.player.movement.glideEnabled,
    speed: Math.hypot(fin.player.velocity[0], fin.player.velocity[2])
  };
});
check('the brake cancels the glide', !brake.glide && brake.mode === 'walk', JSON.stringify(brake));
check('the brake brings the speed to zero', brake.speed < 0.6, `speed=${brake.speed.toFixed(3)}`);

/* ------------------------------------------------------------------ */
/* E. beam consumes EN, EN boundary refuses the QB                      */
/* ------------------------------------------------------------------ */
await restart();
const energy = await inPage(async () => {
  const api = window.__AK2__;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const key = (code, type) => window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true, cancelable: true }));
  const canvas = document.getElementById('viewport');
  key('Digit2', 'keydown');
  key('Digit2', 'keyup');
  await sleep(120);
  canvas.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
  let en = api.getSnapshot().player.en;
  let guard = 0;
  while (en >= 36 && guard < 300) {
    await sleep(50);
    en = api.getSnapshot().player.en;
    guard++;
  }
  window.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
  const before = api.getSnapshot();
  const countBefore = before.player.movement.qbSuccessfulCount;
  key('KeyQ', 'keydown');
  key('KeyQ', 'keyup');
  await sleep(250);
  const after = api.getSnapshot();
  key('ShiftLeft', 'keydown');
  key('ShiftLeft', 'keyup');
  await sleep(150);
  const enBeforeGlide = api.getSnapshot().player.en;
  const p0 = api.getSnapshot().player.position;
  await sleep(700);
  const p1 = api.getSnapshot().player.position;
  const fin = api.getSnapshot();
  return {
    enBeforeQb: before.player.en,
    countBefore,
    countAfter: after.player.movement.qbSuccessfulCount,
    glideEnabled: fin.player.movement.glideEnabled,
    moved: Math.hypot(p1[0] - p0[0], p1[2] - p0[2]),
    enBeforeGlide,
    enAfterGlide: fin.player.en
  };
});
check(
  'the beam drains the energy',
  energy.enBeforeQb < 36,
  `en=${energy.enBeforeQb.toFixed(1)}`
);
check(
  'the QB is refused below 36 EN',
  energy.countAfter === energy.countBefore,
  `qbCount ${energy.countBefore} -> ${energy.countAfter}`
);
check(
  'the glide still works with almost no energy',
  energy.glideEnabled && energy.moved > 5,
  `moved=${energy.moved.toFixed(1)} m`
);

/* ------------------------------------------------------------------ */
/* F. snapshot integrity                                               */
/* ------------------------------------------------------------------ */
const shape = await page.evaluate(() => {
  const s = window.__AK2__.getSnapshot();
  return {
    version: s.version,
    enemies: s.enemies.length,
    controlsRequired: s.objective.controlsRequired,
    totalEnemies: s.stage.totalEnemies,
    sectorCount: s.stage.sectorCount,
    keys: Object.keys(s).sort()
  };
});
check(
  'the snapshot exposes the documented structure',
  shape.version === 'AK2-1.2-candidate' &&
    shape.enemies === 45 &&
    shape.controlsRequired === 6 &&
    shape.totalEnemies === 45 &&
    shape.sectorCount >= 15,
  JSON.stringify(shape.keys)
);

const copyTest = await page.evaluate(() => {
  const s = window.__AK2__.getSnapshot();
  s.player.position[0] = 9999;
  s.enemies.length = 0;
  const s2 = window.__AK2__.getSnapshot();
  return { pos: s2.player.position[0], enemies: s2.enemies.length };
});
check('the snapshot returns copies', copyTest.pos !== 9999 && copyTest.enemies === 45, JSON.stringify(copyTest));

await page.screenshot({ path: `${shotDir}/gameplay.png` });
console.log(`screenshot -> ${shotDir}/gameplay.png`);
const failed = results.filter((r) => !r.ok);
console.log(failed.length === 0 ? 'ALL GAMEPLAY CHECKS PASSED' : `${failed.length} CHECKS FAILED`);
await browser.close();
process.exit(failed.length === 0 ? 0 : 1);
