#!/usr/bin/env node
/**
 * Headless-Chromium screenshot / probe helper (playwright-core).
 *
 *   node tools/shot.mjs <url> <out.png> [--size 1280x720] [--wait 1500] [--eval "<js expr>"]
 *                       [--click "<css selector>"]... [--keys "KeyW:500,KeyQ:50"] [--after 500]
 *
 * --wait   ms to wait after load before anything else (default 1500)
 * --click  click a selector (repeatable, executed in order, 300 ms apart)
 * --keys   comma list of code:holdMs pressed sequentially after the clicks
 * --after  ms to wait after clicks/keys before the screenshot (default 500)
 * --eval   JS expression evaluated in the page just before the screenshot; result printed as JSON
 *
 * Console errors and page errors are printed to stderr. Environment:
 *   see tools/browser.mjs (AK2_CHROME_LIBS, FONTCONFIG_FILE)
 */
import { launchBrowser } from './browser.mjs';

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('usage: node tools/shot.mjs <url> <out.png> [--size WxH] [--wait ms] [--click sel] [--keys list] [--after ms] [--eval js]');
  process.exit(2);
}
const [url, out] = args;
let size = [1280, 720];
let wait = 1500;
let after = 500;
let evalJs = null;
const clicks = [];
let keys = [];
for (let i = 2; i < args.length; i++) {
  const a = args[i];
  const v = args[i + 1];
  if (a === '--size') { size = v.split('x').map(Number); i++; }
  else if (a === '--wait') { wait = Number(v); i++; }
  else if (a === '--after') { after = Number(v); i++; }
  else if (a === '--eval') { evalJs = v; i++; }
  else if (a === '--click') { clicks.push(v); i++; }
  else if (a === '--keys') { keys = v.split(',').map((k) => k.split(':')); i++; }
}
const browser = await launchBrowser();
try {
  const page = await browser.newPage({ viewport: { width: size[0], height: size[1] } });
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.error(`[console.${m.type()}]`, m.text()); });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(wait);
  for (const sel of clicks) { await page.click(sel, { timeout: 10000 }); await page.waitForTimeout(300); }
  for (const [code, ms] of keys) { await page.keyboard.down(code); await page.waitForTimeout(Number(ms || 50)); await page.keyboard.up(code); }
  await page.waitForTimeout(after);
  if (evalJs) {
    const r = await page.evaluate(evalJs);
    console.log(JSON.stringify(r, null, 1));
  }
  await page.screenshot({ path: out });
  console.log('saved', out);
} finally {
  await browser.close();
}
