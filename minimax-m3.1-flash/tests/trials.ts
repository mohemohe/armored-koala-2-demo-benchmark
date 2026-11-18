import { runAllTrials, type TrialResult } from '../src/game/fcsTrials';

const out = document.getElementById('out') as HTMLDivElement;

function row(r: TrialResult): string {
  const ok = r.hits === r.shots && r.maxResidualMeters <= 0.01 && (r.maxSpeedError <= 0.001 || r.weapon !== 'machinegun');
  return `<tr><td>${r.id}</td><td>[${r.r.join(',')}]</td><td>[${r.v.join(',')}]</td><td>${r.fcs}/${r.legs}</td><td>${
    r.shots
  }</td><td class="${r.hits === r.shots ? 'pass' : 'fail'}">${r.hits}</td><td>${r.maxResidualMeters.toExponential(2)}</td><td>${r.maxSpeedError.toExponential(
    2
  )}</td><td>${r.predictedSeconds === null ? '-' : r.predictedSeconds.toFixed(6)}</td><td class="${ok ? 'pass' : 'fail'}">${
    ok ? 'PASS' : 'FAIL'
  }</td></tr>`;
}

function table(title: string, results: TrialResult[]): string {
  return `<h2>${title}</h2>
  <table><tr><th>id</th><th>r</th><th>v</th><th>fcs/legs</th><th>shots</th><th>hits</th><th>max residual (m)</th><th>speed err (m/s)</th><th>t (s)</th><th>result</th></tr>
  ${results.map(row).join('')}</table>`;
}

const t0 = performance.now();
const all = runAllTrials();
const ms = performance.now() - t0;

out.innerHTML =
  table('MACHINEGUN — 20 shots per condition', all.machinegun) +
  table('BEAM — 20 shots per condition', all.beam) +
  table('MISSILE — 20 shots per condition', all.missile) +
  table('FCS / LEG VARIANTS (accuracy must be identical)', all.fcsVariants) +
  table('SELF MOTION (glide / fly / QB — player speed must not be inherited)', all.movingSelf) +
  `<p>total ${ms.toFixed(0)} ms</p>`;

const summary = {
  machinegun: all.machinegun.map((r) => ({ id: r.id, hits: r.hits, shots: r.shots, residual: r.maxResidualMeters, t: r.predictedSeconds })),
  beam: all.beam.map((r) => ({ id: r.id, hits: r.hits, shots: r.shots })),
  missile: all.missile.map((r) => ({ id: r.id, hits: r.hits, shots: r.shots })),
  variants: all.fcsVariants.map((r) => ({ id: r.id, fcs: r.fcs, legs: r.legs, hits: r.hits, shots: r.shots, residual: r.maxResidualMeters })),
  movingSelf: all.movingSelf.map((r) => ({ id: r.id, vel: r.selfVelocity, hits: r.hits, shots: r.shots, residual: r.maxResidualMeters })),
  ms
};
(window as unknown as { __TRIALS__: unknown }).__TRIALS__ = summary;
console.log(JSON.stringify(summary, null, 2));
