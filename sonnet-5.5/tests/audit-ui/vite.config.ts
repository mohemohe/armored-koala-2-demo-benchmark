/**
 * audit-ui 専用の vite 設定 (本番の vite.config.ts は変更しない)。
 * 本番と同じ index.html に加えて、監査用ハーネス (tests/audit-ui/harness.html) も同じ dist に出力する。
 * 使い方: npx vite build --config tests/audit-ui/vite.config.ts  ->  node_modules/.cache/audit-ui/dist
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');

export default defineConfig({
  root,
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
    outDir: resolve(root, 'node_modules/.cache/audit-ui/dist'),
    emptyOutDir: true,
    rolldownOptions: {
      input: {
        index: resolve(root, 'index.html'),
        harness: resolve(root, 'tests/audit-ui/harness.html'),
      },
    },
  },
});
