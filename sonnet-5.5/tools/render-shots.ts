/**
 * Dev tool: screenshots of the render viewer (viewer.html) through Playwright + software WebGL2.
 *   npx tsx tools/render-shots.ts [outDir] [shotName...]
 * Needs a running dev server (default http://127.0.0.1:5220; override with VIEWER_URL). Start one WITHOUT hot reload
 * (other people's edits would reload the page under Playwright), e.g. with a config that sets server.hmr = false:
 *   npx vite --config <cfg> where cfg = { root: '<project>', server: { host: '127.0.0.1', port: 5220, strictPort: true, hmr: false } }
 * Screens are saved to test-results/render-shots by default (gitignored). Prints scene stats (draw calls / triangles) per shot.
 *
 * Measurement modes (same viewer, same renderer; all numbers come from renderer.info / performance.now on the software GL):
 *   npx tsx tools/render-shots.ts --bench [wp,wp,...]   per main-route waypoint: draw calls / triangles / frame time with sector culling
 *                                                        OFF vs ON (interleaved, min of N frames), plus the draw-call split by owner
 *   npx tsx tools/render-shots.ts --leak [n]             n x (hangar round trip + re-sortie) and 5 x setStage: renderer.info.memory must not grow
 *   npx tsx tools/render-shots.ts --tex                  time to paint every procedural texture + the derived roughness maps, texture bytes
 *   npx tsx tools/render-shots.ts --dpr [outDir]         resize / devicePixelRatio: buffer size, pixel ratio, camera aspect after window-size and DPR changes (+ screenshots)
 *   env: SHOT_W / SHOT_H (viewport, default 1280x720; --bench defaults to 640x360), BENCH_N (frames per sample, default 3)
 */
import { chromium } from 'playwright';
import type { Page } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.VIEWER_URL ?? 'http://127.0.0.1:5220';
const CHROME =
  process.env.CHROME_PATH ?? join(homedir(), 'Library/Caches/ms-playwright/chromium-1224/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');

interface Shot {
  name: string;
  scene: string;
  extra?: Record<string, string>;
  /** frames to render before the screenshot */
  frames: number;
  dt?: number;
  w?: number;
  h?: number;
  /** also save `<name>-crop.png`: [x, y, w, h] in fractions of the viewport (e.g. a far enemy) */
  crop?: [number, number, number, number];
}

const SHOTS: Shot[] = [
  { name: 'hangar-biped-front', scene: 'hangar-biped', frames: 20 },
  { name: 'hangar-biped-turn', scene: 'hangar-biped', frames: 80, dt: 0.1 },
  { name: 'hangar-biped-back', scene: 'hangar-biped', frames: 115, dt: 0.1 },
  { name: 'hangar-quad-front', scene: 'hangar-quad', frames: 20 },
  { name: 'hangar-quad-turn', scene: 'hangar-quad', frames: 85, dt: 0.1 },
  { name: 'play-idle-biped', scene: 'play', frames: 30 },
  { name: 'play-idle-quad', scene: 'play', extra: { legs: 'quad' }, frames: 30 },
  { name: 'play-walk', scene: 'play', extra: { mode: 'walk' }, frames: 40 },
  { name: 'play-glide', scene: 'play', extra: { mode: 'glide' }, frames: 40 },
  { name: 'play-qb', scene: 'play', extra: { mode: 'qb' }, frames: 8 },
  { name: 'play-qb-glide', scene: 'play', extra: { mode: 'qbglide' }, frames: 24 },
  { name: 'play-fly', scene: 'play', extra: { mode: 'fly' }, frames: 40 },
  { name: 'play-fall-quad', scene: 'play', extra: { mode: 'fall', legs: 'quad' }, frames: 40 },
  { name: 'play-beam-aim', scene: 'play', extra: { weapon: 'beam', pitch: '0.25', yaw: '0.5' }, frames: 30 },
  { name: 'play-missile-lock', scene: 'play', extra: { weapon: 'missile', lock: '1' }, frames: 30 },
  { name: 'mech-front', scene: 'play', extra: { cam: 'front', dist: '7', yaw: '0.05' }, frames: 30 },
  { name: 'mech-side', scene: 'play', extra: { cam: 'side', dist: '7' }, frames: 30 },
  { name: 'mech-backr', scene: 'play', extra: { cam: 'backr', dist: '7' }, frames: 30 },
  { name: 'mech-walk-front', scene: 'play', extra: { cam: 'front', dist: '7', mode: 'walk' }, frames: 32 },
  { name: 'mech-quad-front', scene: 'play', extra: { cam: 'front', dist: '7', legs: 'quad' }, frames: 30 },
  { name: 'mech-quad-walk-side', scene: 'play', extra: { cam: 'side', dist: '8', legs: 'quad', mode: 'walk' }, frames: 34 },
  { name: 'mech-beam-front', scene: 'play', extra: { cam: 'front', dist: '7', weapon: 'beam', pitch: '0.3' }, frames: 30 },
  { name: 'mech-missile-front', scene: 'play', extra: { cam: 'front', dist: '7', weapon: 'missile', pitch: '-0.1' }, frames: 30 },
  // ---- round 2: weapon / muzzle alignment for every weapon x lock state (free / solved / no_solution) x viewpoint
  { name: 'aim-mg-free-side', scene: 'play', extra: { cam: 'side', dist: '6', pitch: '0.05' }, frames: 30 },
  { name: 'aim-mg-solved-front', scene: 'play', extra: { cam: 'front', dist: '7', lock: '1' }, frames: 30 },
  { name: 'aim-mg-solved-side', scene: 'play', extra: { cam: 'side', dist: '6', lock: '1' }, frames: 30 },
  { name: 'aim-mg-nosol-backr', scene: 'play', extra: { cam: 'backr', dist: '6', lock: 'nosol' }, frames: 30 },
  { name: 'aim-beam-solved-side', scene: 'play', extra: { cam: 'side', dist: '6', lock: '1', weapon: 'beam' }, frames: 30 },
  { name: 'aim-beam-nosol-front', scene: 'play', extra: { cam: 'front', dist: '7', lock: 'nosol', weapon: 'beam' }, frames: 30 },
  { name: 'aim-missile-solved-backr', scene: 'play', extra: { cam: 'backr', dist: '6', lock: '1', weapon: 'missile' }, frames: 30 },
  { name: 'aim-missile-nosol-side', scene: 'play', extra: { cam: 'side', dist: '6', lock: 'nosol', weapon: 'missile' }, frames: 30 },
  { name: 'aim-quad-mg-solved-side', scene: 'play', extra: { cam: 'side', dist: '7', lock: '1', legs: 'quad' }, frames: 30 },
  { name: 'enemies-closeup', scene: 'enemies', frames: 50 },
  { name: 'enemies-turret', scene: 'enemies', extra: { cx: '10', cy: '2.6', cz: '26', tx: '10.5' }, frames: 50 },
  { name: 'enemy-far', scene: 'enemy-far', frames: 20 },
  { name: 'fx-mg', scene: 'fx', extra: { kind: 'mg' }, frames: 40 },
  { name: 'fx-mg-side', scene: 'fx', extra: { kind: 'mg', cam: 'side' }, frames: 26 },
  { name: 'fx-missile-close', scene: 'fx', extra: { kind: 'missile', cam: 'side', cx: '5', cy: '2.6', cz: '37', tx: '0', tz: '27', fov: '55' }, frames: 70 },
  { name: 'fx-beam-side', scene: 'fx', extra: { kind: 'beam', cam: 'side' }, frames: 32 },
  { name: 'fx-missile-side', scene: 'fx', extra: { kind: 'missile', cam: 'side' }, frames: 78 },
  { name: 'fx-enemy-side', scene: 'fx', extra: { kind: 'enemy', cam: 'side', cx: '8', cy: '3', cz: '38', tx: '-1', tz: '20' }, frames: 44 },
  { name: 'fx-explosion-side', scene: 'fx', extra: { kind: 'explosion', cam: 'side', cx: '10', cy: '3', cz: '32', tx: '0', tz: '20' }, frames: 10 },
  { name: 'fx-qb-side', scene: 'fx', extra: { kind: 'qb', cam: 'side', cx: '7', cy: '2.4', cz: '40', tx: '0', tz: '34' }, frames: 4 },
  { name: 'fx-beam', scene: 'fx', extra: { kind: 'beam' }, frames: 4 },
  { name: 'fx-missile', scene: 'fx', extra: { kind: 'missile' }, frames: 50 },
  { name: 'fx-enemy-bullets', scene: 'fx', extra: { kind: 'enemy' }, frames: 40 },
  { name: 'fx-explosion', scene: 'fx', extra: { kind: 'explosion' }, frames: 12 },
  { name: 'fx-qb', scene: 'fx', extra: { kind: 'qb' }, frames: 5 },
  { name: 'barrier-closed', scene: 'barrier', frames: 10 },
  { name: 'barrier-opening', scene: 'barrier', frames: 40 },
  { name: 'barrier-open', scene: 'barrier', frames: 75, dt: 1 / 30 },
  { name: 'real-start', scene: 'real', extra: { at: 'start' }, frames: 6 },
  { name: 'real-s02', scene: 'real', extra: { at: 'S02', yaw: '1.2' }, frames: 6 },
  { name: 'real-s03', scene: 'real', extra: { at: 'S03', yaw: '0.5' }, frames: 6 },
  { name: 'real-s05', scene: 'real', extra: { at: 'S05', yaw: '0.5' }, frames: 6 },
  { name: 'real-s12', scene: 'real', extra: { at: 'S12', yaw: '2.0' }, frames: 6 },
  { name: 'real-barrier-open', scene: 'real', extra: { at: '300,1.5,100', yaw: '-1.5708', open: '1' }, frames: 20 },
  { name: 'real-barrier-closed', scene: 'real', extra: { at: '300,1.5,100', yaw: '-1.5708' }, frames: 20 },
  // ---- round 2: the real campaign stage from the documented main route (wp = waypoint index), enemies at ~120 m
  { name: 'r2-wp00', scene: 'route', extra: { wp: '0' }, frames: 6 },
  { name: 'r2-wp03', scene: 'route', extra: { wp: '3' }, frames: 6 },
  { name: 'r2-wp06', scene: 'route', extra: { wp: '6' }, frames: 6 },
  { name: 'r2-wp09', scene: 'route', extra: { wp: '9' }, frames: 6 },
  { name: 'r2-wp14', scene: 'route', extra: { wp: '14' }, frames: 6 },
  { name: 'r2-wp20', scene: 'route', extra: { wp: '20' }, frames: 6 },
  { name: 'r2-wp28', scene: 'route', extra: { wp: '28' }, frames: 6 },
  { name: 'r2-wp33', scene: 'route', extra: { wp: '33' }, frames: 6 },
  { name: 'r2-wp37', scene: 'route', extra: { wp: '37' }, frames: 6 },
  { name: 'r2-wp42', scene: 'route', extra: { wp: '42' }, frames: 6 },
  { name: 'r2-far-G12', crop: [0.55, 0.36, 0.25, 0.3], scene: 'real', extra: { at: '402,13.5,92', look: 'G12' }, frames: 6 },
  { name: 'r2-far-T03', crop: [0.55, 0.36, 0.25, 0.3], scene: 'real', extra: { at: '232,1.5,92', look: 'T03' }, frames: 6 },
  { name: 'r2-far-T05', crop: [0.55, 0.36, 0.25, 0.3], scene: 'real', extra: { at: '402,13.5,102', look: 'T05' }, frames: 6 },
  { name: 'r2-far-G03', crop: [0.55, 0.36, 0.25, 0.3], scene: 'real', extra: { at: '172,1.5,12', look: 'G03' }, frames: 6 },
  { name: 'r2-far-T07', crop: [0.55, 0.36, 0.25, 0.3], scene: 'real', extra: { at: '562,13.5,122', look: 'T07' }, frames: 6 },
  { name: 'r2-far-G24', crop: [0.55, 0.36, 0.25, 0.3], scene: 'real', extra: { at: '122,1.5,302', look: 'G24' }, frames: 6 },
  { name: 'r2-barrier-closed-far', scene: 'real', extra: { at: '248,1.5,48', lookat: '327.7,4,100' }, frames: 12 },
  { name: 'r2-barrier-open-far', scene: 'real', extra: { at: '248,1.5,48', lookat: '327.7,4,100', open: '1' }, frames: 40 },
  { name: 'r2-barrier-closed', scene: 'route', extra: { wp: '8' }, frames: 12 },
  { name: 'r2-barrier-open', scene: 'route', extra: { wp: '8', open: '1' }, frames: 30 },
  // ---- round 2: an explosion 3 m / 6 m in front of the camera must fade out instead of whiting out the view (additive sprites)
  { name: 'r2-explosion-close3', scene: 'fx', extra: { kind: 'explosion', close: '3' }, frames: 9 },
  { name: 'r2-explosion-close6', scene: 'fx', extra: { kind: 'explosion', close: '6' }, frames: 9 },
  { name: 'r2-explosion-far', scene: 'fx', extra: { kind: 'explosion' }, frames: 9 },
  { name: 'stage-overview', scene: 'overview', frames: 10 },
  { name: 'stage-high', scene: 'stage', extra: { cam: 'high' }, frames: 10 },
  { name: 'stage-cat', scene: 'stage', extra: { cam: 'cat' }, frames: 10 },
  { name: 'stage-gate', scene: 'stage', extra: { cam: 'gate' }, frames: 10 },
];

async function measure(mode: '--bench' | '--leak' | '--tex' | '--dpr', rest: string[]): Promise<void> {
  const W = Number(process.env.SHOT_W ?? (mode === '--bench' ? 640 : mode === '--dpr' ? 960 : 480));
  const H = Number(process.env.SHOT_H ?? (mode === '--bench' ? 360 : mode === '--dpr' ? 540 : 270));
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'],
  });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  page.setDefaultTimeout(1800000);
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('404')) console.log('console error:', m.text().slice(0, 300));
  });
  await page.goto(`${BASE}/viewer.html?w=${W}&h=${H}`, { waitUntil: 'load' });
  await page.waitForFunction(() => (window as unknown as { __viewer?: unknown }).__viewer !== undefined, undefined, { timeout: 180000 });
  const v = 'window.__viewer';
  console.log(`# ${mode} ${W}x${H}  loadavg(1m)=${(await import('node:os')).loadavg()[0].toFixed(0)}  (software GL: timings scale with machine load, counts do not)`);
  if (mode === '--tex') {
    const t = (await page.evaluate(() => (window as any).__viewer.texTimes())) as { total: number; mrTotal: number; each: Record<string, number> };
    console.log(`paint all textures: ${t.total.toFixed(0)} ms, derived roughness/height maps: ${t.mrTotal.toFixed(0)} ms`);
    console.log(Object.entries(t.each).map(([k, x]) => `${k}=${x.toFixed(0)}`).join('  '));
    await page.evaluate(() => (window as any).__viewer.setup('route', { wp: '0' }));
    await page.evaluate(() => (window as any).__viewer.frames(2));
    const st = (await page.evaluate(() => (window as any).__viewer.stats())) as { textures: number; textureBytes: number };
    console.log(`GL textures ${st.textures}, estimated texture memory ${(st.textureBytes / 1048576).toFixed(1)} MB`);
  } else if (mode === '--dpr') {
    const out = rest[0] ?? 'test-results/render-shots/r2';
    mkdirSync(out, { recursive: true });
    await page.evaluate(() => (window as any).__viewer.setup('route', { wp: '3' }));
    const info = async (label: string): Promise<void> => {
      await page.evaluate(() => (window as any).__viewer.frames(2));
      const r = (await page.evaluate(() => ({ b: (window as any).__viewer.renderer().bufferInfo, aspect: (window as any).__viewer.renderer().activeCamera.aspect, dpr: window.devicePixelRatio }))) as { b: Record<string, number>; aspect: number; dpr: number };
      const okAspect = Math.abs(r.aspect - r.b.cssWidth / r.b.cssHeight) < 1e-9;
      const okBuf = Math.abs(r.b.bufferWidth - Math.round(r.b.cssWidth * r.b.dpr)) <= 1 && Math.abs(r.b.bufferHeight - Math.round(r.b.cssHeight * r.b.dpr)) <= 1;
      console.log(`${label.padEnd(34)} css ${r.b.cssWidth}x${r.b.cssHeight}  window.dpr ${r.dpr}  used dpr ${r.b.dpr.toFixed(3)}  buffer ${r.b.bufferWidth}x${r.b.bufferHeight}  aspect ${r.aspect.toFixed(4)} ${okAspect && okBuf ? 'OK' : 'MISMATCH'}`);
    };
    await info('initial');
    for (const [w, h, d] of [[1280, 720, 1], [1024, 768, 1], [1920, 1080, 1], [800, 600, 2], [1920, 1080, 2], [3840, 2160, 1], [1600, 500, 1.5], [1, 1, 1]] as const) {
      await page.evaluate(([a, b, c]) => (window as any).__viewer.renderer().resize(a, b, c), [w, h, d] as const);
      await info(`resize(${w},${h},${d})`);
    }
    await page.evaluate(() => (window as any).__viewer.renderer().resize(960, 540, 1));
    await info('resize(960,540,1)');
    // the browser changes devicePixelRatio by itself (zoom / monitor change): no resize call, the renderer must follow
    const cdp = await page.context().newCDPSession(page);
    for (const dsf of [2, 1.25, 1]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 960, height: 540, deviceScaleFactor: dsf, mobile: false });
      await info(`window devicePixelRatio -> ${dsf}`);
      await page.screenshot({ path: join(out, `resize-dpr-${dsf}.png`), timeout: 120000 });
    }
  } else if (mode === '--leak') {
    const n = Number(rest[0] ?? 10);
    await page.evaluate(() => (window as any).__viewer.setup('route', { wp: '8' }));
    await page.evaluate(() => (window as any).__viewer.frames(4));
    const r0 = await page.evaluate(() => ({ ...(window as any).__viewer.renderer().glResources, sceneObjects: (window as any).__viewer.renderer().sceneObjectCount }));
    console.log('initial (geometries/textures/programs/sceneObjects):', JSON.stringify(r0));
    const cyc = (await page.evaluate((k) => (window as any).__viewer.cycle(k, 2), n)) as Record<string, number>[];
    console.log('after each hangar round trip + re-sortie:', cyc.map((c) => `${c.geometries}/${c.textures}/${c.programs}/${c.sceneObjects}`).join('  '));
    const rs = (await page.evaluate(() => (window as any).__viewer.restage(5))) as Record<string, number>[];
    console.log('after each setStage (rebuild + dispose):', rs.map((c) => `${c.geometries}/${c.textures}/${c.programs}/${c.sceneObjects}`).join('  '));
    // lazily uploaded resources (a chunk / hangar variant that comes into view for the first time) may still appear during the first
    // few round trips; after that every count must stay exactly constant
    const warm = Math.min(3, cyc.length - 1);
    const grewAfter = (list: Record<string, number>[]): boolean => list.slice(warm + 1).some((c) => (['geometries', 'textures', 'programs', 'sceneObjects'] as const).some((k) => c[k] > list[warm][k]));
    const grew = grewAfter(cyc);
    const grew2 = grewAfter(rs);
    console.log(grew || grew2 ? 'LEAK: a resource count kept growing after the warm-up round trips' : `OK: constant after the warm-up (round trips: ${cyc.length}, setStage rebuilds: ${rs.length})`);
  } else {
    const list = (rest[0] ?? '0,3,6,9,14,20,28,33,37,42').split(',');
    const N = Number(process.env.BENCH_N ?? 3);
    console.log('wp   | culling | ms min/med | calls | tris   | stage chunks | sectors | draw calls by owner');
    for (const wp of list) {
      await page.evaluate(([w]) => (window as any).__viewer.setup('route', { wp: w }), [wp]);
      for (let round = 0; round < 2; round++) {
        for (const cull of [false, true]) {
          await page.evaluate((c) => (window as any).__viewer.setCulling(c), cull);
          await page.evaluate(() => (window as any).__viewer.frames(2));
          const b = (await page.evaluate((k) => (window as any).__viewer.bench(k), N)) as { min: number; median: number };
          const st = (await page.evaluate(() => (window as any).__viewer.stats())) as Record<string, any>;
          if (round === 1) console.log(`${wp.padStart(4)} | ${cull ? 'ON     ' : 'off    '} | ${b.min.toFixed(0).padStart(5)}/${b.median.toFixed(0).padStart(5)} | ${String(st.drawCalls).padStart(5)} | ${String(st.triangles).padStart(6)} | ${st.stageChunksVisible}/${st.stageChunks} | ${st.sectorsVisible}/${st.sectorsTotal} | ${JSON.stringify(st.breakdown)}`);
        }
      }
    }
  }
  void v;
  await browser.close();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === '--bench' || args[0] === '--leak' || args[0] === '--tex' || args[0] === '--dpr') return measure(args[0], args.slice(1));
  const out = args[0] && !SHOTS.some((s) => s.name === args[0]) ? args.shift()! : 'test-results/render-shots';
  const only = new Set(args);
  mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'],
  });
  const stats: Record<string, unknown> = {};
  // one page per viewport size: the viewer keeps its renderer, so textures / shaders are built once (much faster than a page per shot)
  const pages = new Map<string, Page>();
  const errors: string[] = [];
  const pageFor = async (W: number, H: number): Promise<Page> => {
    const key = `${W}x${H}`;
    let page = pages.get(key);
    if (page && !page.isClosed()) return page;
    page = await browser.newPage({ viewport: { width: W, height: H } });
    page.setDefaultTimeout(600000);
    page.on('console', (m) => {
      if ((m.type() === 'error' && !m.text().includes('404')) || m.type() === 'warning') if (!m.text().includes('GL Driver Message')) errors.push(`${m.type()}: ${m.text()}`);
    });
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    await page.goto(`${BASE}/viewer.html?w=${W}&h=${H}`, { waitUntil: 'load' });
    await page.waitForFunction(() => (window as unknown as { __viewer?: unknown }).__viewer !== undefined, undefined, { timeout: 120000 });
    pages.set(key, page);
    return page;
  };
  for (const shot of SHOTS) {
    if (only.size && !only.has(shot.name)) continue;
    const W = Number(process.env.SHOT_W ?? shot.w ?? 1280);
    const H = Number(process.env.SHOT_H ?? shot.h ?? 720);
    const page = await pageFor(W, H);
    errors.length = 0;
    await page.evaluate(([scene, extra]) => (window as any).__viewer.setup(scene, extra), [shot.scene, shot.extra ?? {}] as const);
    await page.evaluate(([n, dt]) => (window as any).__viewer.frames(n, dt), [shot.frames, shot.dt ?? 1 / 60] as const);
    const st = (await page.evaluate(() => (window as any).__viewer.stats())) as Record<string, unknown>;
    if (shot.scene === 'play') st.weapon = await page.evaluate(() => (window as any).__viewer.weapon());
    stats[shot.name] = st;
    await page.screenshot({ path: join(out, `${shot.name}.png`), timeout: 120000 });
    if (shot.crop) {
      const [cx, cy, cw, ch] = shot.crop;
      await page.screenshot({ path: join(out, `${shot.name}-crop.png`), timeout: 120000, clip: { x: cx * W, y: cy * H, width: cw * W, height: ch * H } });
    }
    if (errors.length) console.log(`[${shot.name}]`, errors.slice(0, 5).join('\n'));
    console.log(`saved ${shot.name}`, JSON.stringify(st).slice(0, 260));
  }
  writeFileSync(join(out, 'stats.json'), JSON.stringify(stats, null, 1));
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
