import { defineConfig } from 'vitest/config';

// PORT 環境変数があればそれを使う（プレビュー用の自動割り当て）。既定は仕様どおり 5173。
const port = Number(process.env.PORT) || 5173;

export default defineConfig({
  base: './',
  server: {
    host: '0.0.0.0',
    port,
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 120000,
    hookTimeout: 120000,
  },
});
