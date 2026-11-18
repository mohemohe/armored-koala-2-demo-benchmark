/**
 * Node-side unit test for the ballistic solver (pure math, no renderer).
 * Run with:  node scripts/run-ballistics-test.mjs
 */
import { solveMachinegun, solveConstantSpeedLead } from '../src/core/ballistics.ts';

const G = 18;
const S = 100;

const cases = [
  { id: 'A01', r: [0, 0, 20], v: [0, 0, 0] },
  { id: 'A02', r: [0, 0, 60], v: [0, 0, 0] },
  { id: 'A03', r: [0, 0, 100], v: [0, 0, 0] },
  { id: 'A04', r: [0, 0, 120], v: [0, 0, 0] },
  { id: 'A05', r: [0, 0, 100], v: [8, 0, 0] },
  { id: 'A06', r: [0, 0, 100], v: [-8, 0, 0] },
  { id: 'A07', r: [0, 0, 100], v: [0, 0, 8] },
  { id: 'A08', r: [0, 0, 100], v: [0, 0, -8] },
  { id: 'A09', r: [0, 16, 100], v: [6, 0, 0] },
  { id: 'A10', r: [0, -16, 100], v: [-6, 0, 0] },
  { id: 'A11', r: [0, 0, 100], v: [6, 3, 0] },
  { id: 'A12', r: [0, 0, 100], v: [6, -3, 0] },
  { id: 'A13', r: [0, 0, 120], v: [6, 3, 4] }
];

const muzzle = { x: 0, y: 20, z: 0 };
let failures = 0;

for (const c of cases) {
  const p = { x: muzzle.x + c.r[0], y: muzzle.y + c.r[1], z: muzzle.z + c.r[2] };
  const v = { x: c.v[0], y: c.v[1], z: c.v[2] };
  const sol = solveMachinegun(muzzle, p, v, S, G, 2);
  if (!sol) {
    console.log(`${c.id}: NO SOLUTION`);
    failures++;
    continue;
  }
  const sp = Math.hypot(sol.velocity.x, sol.velocity.y, sol.velocity.z);
  const ok = Math.abs(sp - S) <= 0.001 && sol.residual <= 0.01;
  if (!ok) failures++;
  console.log(
    `${c.id}: t=${sol.t.toFixed(9)} v0=(${sol.velocity.x.toFixed(9)}, ${sol.velocity.y.toFixed(9)}, ${sol.velocity.z.toFixed(9)})` +
      ` |v0|=${sp.toFixed(9)} residual=${sol.residual.toExponential(3)} speedErr=${sol.speedError.toExponential(3)} ${ok ? 'OK' : 'FAIL'}`
  );
}

// reference values from the specification
const refA03 = solveMachinegun(muzzle, { x: 0, y: 20, z: 100 }, { x: 0, y: 0, z: 0 }, S, G, 2);
console.log('\nreference A03 expect t=1.004108529 v0=(0, 9.036976765, 99.590828147)');
console.log(`  got t=${refA03?.t} v0=(${refA03?.velocity.x}, ${refA03?.velocity.y}, ${refA03?.velocity.z})`);
const refA05 = solveMachinegun(muzzle, { x: 0, y: 20, z: 100 }, { x: 8, y: 0, z: 0 }, S, G, 2);
console.log('reference A05 expect t=1.007391236 v0=(8, 9.066521121, 99.266299391)');
console.log(`  got t=${refA05?.t} v0=(${refA05?.velocity.x}, ${refA05?.velocity.y}, ${refA05?.velocity.z})`);
const refA13 = solveMachinegun(muzzle, { x: 0, y: 20, z: 120 }, { x: 6, y: 3, z: 4 }, S, G, 2);
console.log('reference A13 expect t=1.266137996');
console.log(`  got t=${refA13?.t}`);

// missile lead: A05 r=(0,0,100) v=(8,0,0) speed 45
const t45 = solveConstantSpeedLead({ x: 0, y: 0, z: 100 }, { x: 8, y: 0, z: 0 }, 45, 4);
console.log(`\nmissile A05 lead t=${t45}`);

console.log(failures === 0 ? '\nALL BALLISTICS CASES PASSED' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
