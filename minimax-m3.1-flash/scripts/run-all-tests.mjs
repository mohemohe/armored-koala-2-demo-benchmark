/**
 * Runs every verification harness against a local server.
 *   node scripts/run-all-tests.mjs [baseUrl]
 */
import { spawn } from 'child_process';

const base = process.argv[2] ?? 'http://127.0.0.1:4173/';
const steps = [
  ['stage validator', 'node', ['/tmp/opencode/scheck.mjs']],
  ['ballistics unit test', 'node', ['/tmp/opencode/bcheck.mjs']],
  ['FCS accuracy trials', 'node', ['scripts/browse.mjs', base + 'tests/index.html', '/tmp/opencode/trials.png', '() => window.__TRIALS__']],
  ['gameplay / energy', 'node', ['scripts/gameplay-test.mjs', base, '/tmp/opencode']],
  ['combat behaviour', 'node', ['scripts/combat-test.mjs', base, '/tmp/opencode']],
  ['objective chain', 'node', ['scripts/objective-test.mjs', base, '/tmp/opencode']],
  ['flight ascent', 'node', ['scripts/shaft-test.mjs', base, '/tmp/opencode']]
];

let failed = 0;
for (const [name, cmd, args] of steps) {
  console.log(`\n================ ${name} ================`);
  const code = await new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: 'inherit' });
    p.on('close', (c) => resolve(c ?? 1));
  });
  if (code !== 0) {
    failed++;
    console.log(`!! ${name} FAILED (exit ${code})`);
  }
}
console.log(failed === 0 ? '\nALL SUITES PASSED' : `\n${failed} SUITE(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
