import { defineConfig } from 'vite';

export default defineConfig({
  server: { watch: { usePolling: true, interval: 250 } },
  build: { rollupOptions: { output: { manualChunks: { three: ['three'] } } } },
});
