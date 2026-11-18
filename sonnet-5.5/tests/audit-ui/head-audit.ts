/**
 * audit-ui 実ブラウザ監査 (1c/3): 格納庫で「頭部を正面から確認できる」(SPEC §3) が、1280×720 以上の様々な表示サイズで成り立つか。
 * 測定は headMeasure.ts (tests/audit-ui-browser.test.ts と共有)。画像は test-results/audit-ui/hd-*.png。
 * 実行: npx tsx tests/audit-ui/head-audit.ts
 */
import { measureHead } from './headMeasure';
import { checks, f, launchBrowser, ok, rec, startServer, stopServer } from './lib';

const SIZES: [number, number][] = [
  [1280, 720],
  [1366, 768],
  [1440, 900],
  [1600, 900],
  [1920, 1080],
  [2560, 1440],
  [1280, 800],
  [1280, 960],
  [1280, 1024],
  [1600, 1200],
  [1500, 720],
  [2560, 1080],
  [3840, 2160],
];

async function main(): Promise<void> {
  await startServer();
  const browser = await launchBrowser();
  try {
    const rows: string[] = [];
    const bad: string[] = [];
    for (const [w, h] of SIZES) {
      const m = await measureHead(browser, w, h, `hd-${w}x${h}`);
      const line = `${w}x${h}: 頭部 x=${f(m.head.l, 0)}..${f(m.head.r, 0)} y=${f(m.head.t, 0)}..${f(m.head.b, 0)} (幅 ${f(m.head.r - m.head.l, 0)} 高 ${f(m.head.b - m.head.t, 0)}) 画面内=${m.inside} パネルに覆われる割合=${f(m.covered * 100, 1)}%`;
      rows.push(line);
      console.log(line);
      if (!m.inside || m.covered > 0.1) bad.push(line);
    }
    rec('HD-all', `頭部の見え方 (${SIZES.length} サイズ)`, 'info', rows.join(' | '));
    ok('HD', '1280×720 以上の全サイズで、起動直後の格納庫で頭部 (耳・鼻を含む) が画面内に収まり、パネルに 10% 超は覆われない', bad.length === 0, bad.join(' | '));
  } finally {
    await browser.close();
    stopServer();
  }
  const fails = checks.filter((c) => c.status === 'fail');
  console.log(`\n== head-audit: ${checks.length} checks, ${fails.length} fail ==`);
  for (const c of fails) console.log(`FAIL ${c.id} ${c.title} :: ${c.detail}`);
}

main().catch((e) => {
  console.error(e);
  stopServer();
  process.exit(1);
});
