import { defineConfig } from 'vitest/config';

// No external network access at runtime: everything is bundled from local files.
//
// allowedHosts: the game must be reachable under whatever name the evaluation environment gives the
// machine (`npm run dev -- --host 0.0.0.0 --port 5173` behind a container service name, a forwarded
// workspace URL, …). Vite otherwise answers "403 Blocked request. This host is not allowed" for every Host
// header that is not localhost or an IP address. The servers only hand out this project's own files.
export default defineConfig({
  base: './',
  server: { host: '0.0.0.0', port: 5173, strictPort: false, allowedHosts: true },
  preview: { host: '0.0.0.0', port: 4173, allowedHosts: true },
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 2000 },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120000,
  },
});
