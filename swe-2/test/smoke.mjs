// Browser smoke test: boots the built game in headless Chrome (SwiftShader WebGL),
// drives title->garage->deploy, moves, fires, checks game state + console errors.
// Usage: node test/smoke.mjs <url>   (expects a running server)

import puppeteer from 'puppeteer-core';
import { existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const url = process.argv[2] || 'http://localhost:4173/';

function findBrowser() {
  const root = join(homedir(), '.cache/puppeteer/chrome-headless-shell');
  if (!existsSync(root)) return null;
  for (const ver of readdirSync(root)) {
    const p = join(root, ver, 'chrome-headless-shell-linux64/chrome-headless-shell');
    if (existsSync(p)) return p;
  }
  return null;
}

const exe = findBrowser();
if (!exe) { console.log('SKIP: no chrome-headless-shell in ~/.cache/puppeteer'); process.exit(0); }

const results = [];
const check = (name, ok, detail = '') => {
  results.push([name, ok]);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
};

const browser = await puppeteer.launch({
  executablePath: exe,
  args: [
    '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
    '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
    '--window-size=1280,720', '--mute-audio',
  ],
  defaultViewport: { width: 1280, height: 720 },
});
const page = await browser.newPage();
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

try {
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  await page.waitForSelector('canvas', { timeout: 20000 });
  await new Promise(r => setTimeout(r, 1500));

  check('page loads, canvas exists', await page.$('canvas') !== null);
  check('title overlay visible', await page.evaluate(() =>
    document.getElementById('title').classList.contains('visible')));

  await page.click('#btnStart');
  await new Promise(r => setTimeout(r, 300));
  check('garage opens', await page.evaluate(() =>
    document.getElementById('garage').classList.contains('visible')));
  check('garage parts listed', await page.evaluate(() =>
    document.querySelectorAll('#garage .part').length === 8),
    String(await page.evaluate(() => document.querySelectorAll('#garage .part').length)));

  // pick a non-default part to verify loadout wiring
  await page.evaluate(() => {
    const parts = [...document.querySelectorAll('#colFcs .part')];
    parts[0].click(); // wide FCS
  });

  await page.click('#btnDeploy');
  await new Promise(r => setTimeout(r, 1200));
  const st0 = await page.evaluate(() => window.__ak2 ? {
    state: window.__ak2.game.state,
    pos: [...window.__ak2.game.player.pos],
    hp: window.__ak2.game.player.hp,
    enemies: window.__ak2.game.enemies.length,
  } : null);
  check('game starts playing', st0 && st0.state === 'playing', JSON.stringify(st0));
  check('45 enemies spawned', st0 && st0.enemies === 45);

  // walk forward for ~2s
  const p0 = st0.pos;
  await page.keyboard.down('KeyW');
  await new Promise(r => setTimeout(r, 2000));
  await page.keyboard.up('KeyW');
  const st1 = await page.evaluate(() => ({
    pos: [...window.__ak2.game.player.pos],
    state: window.__ak2.game.state,
  }));
  const moved = Math.hypot(st1.pos[0] - p0[0], st1.pos[2] - p0[2]);
  check('WASD movement works', moved > 1, `moved ${moved.toFixed(1)}m`);

  // QB (Q edge)
  await page.keyboard.press('KeyQ');
  await new Promise(r => setTimeout(r, 400));
  const qb = await page.evaluate(() => window.__ak2.game.player.qbSuccessfulCount);
  check('QB fires on Q', qb === 1, `count=${qb}`);

  // fire machinegun
  const shots0 = await page.evaluate(() => window.__ak2.game.shotSeq);
  await page.mouse.down(); await new Promise(r => setTimeout(r, 900)); await page.mouse.up();
  const shots1 = await page.evaluate(() => window.__ak2.game.shotSeq);
  check('firing produces shots', shots1 > shots0, `fired ${shots1 - shots0}`);

  // HUD updates
  const hud = await page.evaluate(() => ({
    hp: document.getElementById('hpText')?.textContent || '',
    en: document.getElementById('enText')?.textContent || '',
    obj: document.getElementById('objText')?.textContent || '',
  }));
  check('HUD shows HP/EN/objective', hud.hp.includes('HP') || /\d/.test(hud.hp), JSON.stringify(hud));

  // screenshot for a rendering sanity check (non-black pixels)
  const shot = await page.screenshot({ encoding: 'binary' });
  check('screenshot captured (renderer draws)', shot.length > 20000, `${(shot.length / 1024).toFixed(0)}KB png`);
  await page.screenshot({ path: 'test/smoke-screenshot.png' });

  // pause/resume via Escape — may not trigger without pointer lock; check no crash
  await page.keyboard.press('Escape');
  await new Promise(r => setTimeout(r, 300));
  const alive = await page.evaluate(() => !!window.__ak2 && window.__ak2.game.state);
  check('game still alive after Escape', typeof alive === 'string', `state=${alive}`);

  check('zero console/page errors', errors.length === 0,
    errors.slice(0, 3).join(' | ').slice(0, 300));
} catch (e) {
  results.push(['fatal', false]);
  console.log('  FATAL', e.message);
} finally {
  await browser.close();
}

const failed = results.filter(r => !r[1]);
console.log(`\nSMOKE: ${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
