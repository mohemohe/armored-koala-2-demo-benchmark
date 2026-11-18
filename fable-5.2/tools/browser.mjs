/**
 * Shared headless-Chromium launcher for the e2e / screenshot scripts (playwright-core).
 *
 * Environment (both optional):
 *   AK2_CHROME_LIBS   directory with extra shared libraries Chromium needs on minimal machines
 *                     (prepended to LD_LIBRARY_PATH of the browser process only)
 *   FONTCONFIG_FILE   fontconfig file to use (minimal machines without system fonts)
 * WebGL runs on SwiftShader (software), so frame rates are low; use generous timeouts.
 */
import { chromium } from 'playwright-core';

export async function launchBrowser(extraArgs = []) {
  const env = { ...process.env };
  if (process.env.AK2_CHROME_LIBS) {
    env.LD_LIBRARY_PATH = process.env.AK2_CHROME_LIBS + (env.LD_LIBRARY_PATH ? ':' + env.LD_LIBRARY_PATH : '');
  }
  return chromium.launch({
    headless: true,
    env,
    args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', ...extraArgs],
  });
}

/** Opens a page of the given size and forwards console errors / page errors to stderr. */
export async function openPage(browser, url, { width = 1280, height = 720, quiet = false } = {}) {
  const page = await browser.newPage({ viewport: { width, height } });
  if (!quiet) {
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') console.error(`[console.${m.type()}]`, m.text());
    });
    page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  }
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  return page;
}
