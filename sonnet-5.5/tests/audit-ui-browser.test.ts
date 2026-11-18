/**
 * audit-ui (実ブラウザ版の再現テスト): Playwright + Chrome for Testing (SwiftShader) で本番の画面を描いて確かめる項目のうち、
 * 「確定した違反」を vitest から再現できるようにしたもの。tests/audit-ui.test.ts (Node だけで走る) とは別ファイル。
 *
 *  - 監査用の vite 設定 (tests/audit-ui/vite.config.ts) で build -> vite preview を 127.0.0.1:5230 に立て、終了時に必ず止める
 *  - Chrome for Testing が無い環境では skip する (ブラウザーが無いと確認できないため)。実行ファイルは環境変数 CHROME_PATH、
 *    未指定なら macOS の Playwright 既定 (~/Library/Caches/ms-playwright/chromium-1224/...) を見る。skip の理由は標準出力に出す
 *  - 画像の出力先は test-results/audit-ui/ (.gitignore 済み)
 *  - 実行: npx vitest run tests/audit-ui-browser.test.ts   (build + 起動を含み 1〜2 分)
 */
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { measureHead } from './audit-ui/headMeasure';
import { CHROME, launchBrowser, startServer, stopServer } from './audit-ui/lib';

const HAS_CHROME = existsSync(CHROME);
if (!HAS_CHROME) {
  console.log(`[skip] audit-ui-browser: Chrome for Testing が見つからないためブラウザ必須テストを skip します (CHROME_PATH で実行ファイルを指定できます。探した場所: ${CHROME})`);
}

describe.skipIf(!HAS_CHROME)('§3 格納庫 (実ブラウザ)', () => {
  it(
    'E01 「格納庫では頭部を正面から確認できる」: 1280×720 以上の各表示サイズで、起動直後の頭部 (左右の大きな丸い耳・黒い鼻) が画面内にあり、左右のパネルに 10% 超は隠れない',
    async () => {
      await startServer();
      const browser = await launchBrowser();
      try {
        const bad: string[] = [];
        // 1280×720 (基準)・1920×1080・1280×1024 (5:4 モニター)・1600×1200 (4:3)
        for (const [w, h] of [[1280, 720], [1920, 1080], [1280, 1024], [1600, 1200]] as const) {
          const m = await measureHead(browser, w, h);
          if (!m.inside || m.covered > 0.1) {
            bad.push(`${w}x${h}: 頭部 x=${Math.round(m.head.l)}..${Math.round(m.head.r)} y=${Math.round(m.head.t)}..${Math.round(m.head.b)} 画面内=${m.inside} パネルに覆われる割合=${(m.covered * 100).toFixed(1)}%`);
          }
        }
        expect(bad, '頭部がパネルに隠れる表示サイズ (画像: test-results/audit-ui/hd-1280x1024.png)').toEqual([]);
      } finally {
        await browser.close();
        stopServer();
      }
    },
    300000,
  );
});
