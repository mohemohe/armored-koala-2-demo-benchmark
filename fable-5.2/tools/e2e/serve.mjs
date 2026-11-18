#!/usr/bin/env node
/**
 * Stable server for end-to-end runs: builds the shipped page (index.html) AND the mini-stage harness
 * (dev/app-test.html) into a directory outside the repository and serves that build.
 *
 *   node tools/e2e/serve.mjs --port=5190 [--out=<dir>] [--host=127.0.0.1]
 *   AK2_URL=http://127.0.0.1:5190/ node tools/e2e/app-smoke.mjs
 *
 * Why not `npm run dev`: the dev server reloads the page whenever a source file changes, which ruins a
 * browser run while other people are editing. This build is a snapshot of the sources at start time; run
 * the script again to pick up changes. It uses the project's own vite.config.ts and adds nothing to the
 * pages. Stop it with Ctrl+C (or kill the process).
 */
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, preview } from 'vite';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const port = Number(arg('port', '5190'));
const host = arg('host', '127.0.0.1');
const outDir = path.resolve(arg('out', path.join(os.tmpdir(), `ak2-e2e-dist-${port}`)));
const configFile = path.join(root, 'vite.config.ts');

await build({
  root,
  configFile,
  logLevel: 'warn',
  build: {
    outDir,
    emptyOutDir: true,
    rollupOptions: { input: { index: path.join(root, 'index.html'), appTest: path.join(root, 'dev/app-test.html') } },
  },
});
const server = await preview({ root, configFile, logLevel: 'warn', build: { outDir }, preview: { port, strictPort: true, host } });
console.log(`AK2 e2e build: ${outDir}`);
console.log(`serving  http://${host}:${port}/                    (shipped page, factory stage)`);
console.log(`         http://${host}:${port}/dev/app-test.html   (mini-stage harness)`);
const stop = () => server.close().finally(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
