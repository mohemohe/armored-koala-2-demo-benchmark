import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://127.0.0.1:4173/';
const shotDir = process.argv[3] ?? '/tmp/opencode';

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.on('pageerror', (e) => console.log('[err]', e.message));

await page.goto(base + '?test=shaft', { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);
await page.click('#btn-start');
await page.waitForTimeout(800);

// brake + fly straight up through the opening of transfer shaft A
await page.evaluate(() => {
  const key = (code, type) => window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true }));
  key('ControlLeft', 'keydown');
  key('Space', 'keydown');
});

let maxY = 0;
let minEn = 120;
let steered = false;
for (let i = 0; i < 26; i++) {
  await page.waitForTimeout(700);
  const st = await page.evaluate(() => {
    const s = window.__AK2__.getSnapshot();
    return {
      y: s.player.position[1],
      x: s.player.position[0],
      grounded: s.player.grounded,
      vm: s.player.movement.verticalMode,
      en: s.player.en
    };
  });
  maxY = Math.max(maxY, st.y);
  minEn = Math.min(minEn, st.en);
  if (!steered && st.y > 13) {
    // leave the brake and steer onto the landing deck
    await page.evaluate(() => {
      const key = (code, type) => window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true }));
      key('ControlLeft', 'keyup');
      key('KeyD', 'keydown');
    });
    steered = true;
  }
  if (steered && st.grounded && st.y > 10) break;
}
const final = await page.evaluate(() => {
  const s = window.__AK2__.getSnapshot();
  return { y: s.player.position[1], x: s.player.position[0], grounded: s.player.grounded, sector: s.stage.currentSectorId };
});

const ok = final.y > 11 && final.grounded && maxY > 13 && minEn < 100;
console.log(
  `${ok ? 'PASS' : 'FAIL'}  flight ascent reaches the upper deck of the transfer shaft  ` +
    `maxY=${maxY.toFixed(2)} final=(${final.x.toFixed(1)}, ${final.y.toFixed(2)}) grounded=${final.grounded} ` +
    `minEN=${minEn.toFixed(1)} sector=${final.sector}`
);
await page.screenshot({ path: `${shotDir}/shaft.png` });
await browser.close();
process.exit(ok ? 0 : 1);
