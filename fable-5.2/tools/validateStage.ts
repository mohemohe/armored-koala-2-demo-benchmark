/**
 * Stage validator CLI — measures every requirement of docs/SPEC.md §2.2 on the real collision boxes of the
 * shipped stage (see tools/stageAnalysis.ts for the exact definitions V1–V13, V6d and V14).
 *
 *   npx tsx tools/validateStage.ts [--json <file>] [--only V3,V5] [--cell-y 0.5|1] [--no-flight-sim] [--allow-skips] [--quiet]
 *   (npm run validate:stage)
 *
 * --no-flight-sim skips the checks that run the real simulation (V6d: every declared climb with all six
 * generator x legs combinations; V14: the recommended route played from the start into the exit zone; V16: the
 * fighting bot); they are then reported as NOT RUN, never as passed.
 * Prints a readable report, optionally writes the same data as JSON (the input of tools/stageReport.ts, which
 * generates docs/STAGE.md). Exit code: 0 = every check passed, 1 = a check failed, 3 = nothing failed but some
 * checks were not run (RESULT: INCOMPLETE) — unless --allow-skips is given, 2 = usage / internal error.
 */
import { getFactoryDetourRoute, getFactoryStage } from '../src/stage/factory';
import { DETOUR_KEYS, MAIN_KEYS } from '../src/stage/route';
import { StageAnalyzer, analyzeStage, formatReport } from './stageAnalysis';

// The project has no @types/node (dependencies are pinned), so the few Node APIs used here are typed locally.
interface NodeFs {
  mkdirSync(path: string, opts: { recursive: boolean }): void;
  writeFileSync(path: string, data: string): void;
}
interface NodeProcess {
  argv: string[];
  exitCode?: number;
}
const proc = (globalThis as unknown as { process: NodeProcess }).process;

async function main(): Promise<number> {
  const args = proc.argv.slice(2);
  let json: string | null = null;
  let only: string[] | undefined;
  let cellY: number | undefined;
  let flightSim = true;
  let allowSkips = false;
  let quiet = false;
  if (args.includes('--refine-route')) {
    // designer's helper: print the ROUTE_VIAS table of src/stage/route.ts for the current geometry and key waypoints
    const an = new StageAnalyzer(getFactoryStage(), {});
    const vias: Record<string, Array<[number, number, number]>> = {};
    const problems: string[] = [];
    for (const keys of [MAIN_KEYS, DETOUR_KEYS]) {
      const r = an.refineRoute(keys);
      Object.assign(vias, r.vias);
      for (const q of r.problems) if (!problems.includes(q)) problems.push(q);
    }
    console.log('export const ROUTE_VIAS: Record<string, Array<[number, number, number]>> = {');
    for (const [key, pts] of Object.entries(vias)) console.log(`  '${key}': [${pts.map((q) => `[${q.join(', ')}]`).join(', ')}],`);
    console.log('};');
    for (const q of problems) console.error(`[refine-route] PROBLEM ${q}`);
    return problems.length > 0 ? 1 : 0;
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') json = args[++i] ?? null;
    else if (a === '--only') only = (args[++i] ?? '').split(',').map((s: string) => s.trim()).filter(Boolean);
    else if (a === '--cell-y') cellY = Number(args[++i]);
    else if (a === '--no-flight-sim') flightSim = false;
    else if (a === '--allow-skips') allowSkips = true;
    else if (a === '--quiet') quiet = true;
    else {
      console.error(`unknown argument: ${a}`);
      return 2;
    }
  }
  const stage = getFactoryStage();
  const report = analyzeStage(stage, {
    only,
    cellY,
    flightSim,
    allowSkips,
    extraRoutes: [{ name: 'detour (B side of every branch)', route: getFactoryDetourRoute() }],
    log: quiet ? undefined : (s) => console.error(`[validateStage] ${s}`),
  });
  console.log(formatReport(report));
  if (json) {
    const fsName = 'node:fs';
    const fs = (await import(/* @vite-ignore */ fsName)) as NodeFs;
    const dir = json.replace(/[\\/][^\\/]*$/, '');
    if (dir && dir !== json) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(json, JSON.stringify(report, null, 2));
    console.error(`[validateStage] JSON report written to ${json}`);
  }
  return report.result === 'PASS' ? 0 : report.result === 'INCOMPLETE' ? 3 : 1;
}

main().then(
  (code) => {
    proc.exitCode = code;
  },
  (e) => {
    console.error(e);
    proc.exitCode = 2;
  },
);
