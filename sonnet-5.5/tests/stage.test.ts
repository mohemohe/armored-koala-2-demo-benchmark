/**
 * The campaign stage (src/stage buildStage()) against the stage validator (SPEC §2.1 / §2.2 / §11):
 * every required check must pass, measured on the real collision world and the real player physics.
 * (The validator itself is tested on synthetic stages in tests/stage-validator.test.ts.)
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { buildStage } from '../src/stage';
import type { StageDef } from '../src/sim/types';
import { validateStage } from '../src/stage/validate';
import type { StageReport } from '../src/stage/validate';

describe('campaign stage: buildStage() validation report', () => {
  let stage: StageDef;
  let rep: StageReport;
  beforeAll(() => {
    stage = buildStage();
    rep = validateStage(stage);
  });

  it('no validator crash', () => {
    expect(rep.checks.filter((c) => c.name.startsWith('internal.')).map((c) => `${c.name}: ${c.details}`)).toEqual([]);
  });

  it('every required check passes', () => {
    const failing = rep.checks.filter((c) => !c.advisory && !c.pass).map((c) => `${c.name} = ${String(c.value)} (need ${c.threshold}): ${c.details}`);
    expect(failing).toEqual([]);
    expect(rep.pass).toBe(true);
  });

  it('headline requirements (SPEC §2.2) as numbers', () => {
    expect(stage.sectors.length).toBeGreaterThanOrEqual(15);
    expect(stage.enemies.length).toBe(45);
    expect(rep.route.found).toBe(true);
    expect(rep.route.length).toBeGreaterThanOrEqual(1500);
    expect(rep.route.sectors.length).toBeGreaterThanOrEqual(12);
    expect(rep.structures.length).toBeGreaterThanOrEqual(3);
    expect(rep.climbs.filter((c) => c.onPath && c.heightOk).length).toBeGreaterThanOrEqual(6);
    expect(rep.arenas.filter((a) => a.has60x50).length).toBeGreaterThanOrEqual(5);
    expect(rep.combat.filter((c) => c.qualifies).length).toBeGreaterThanOrEqual(5);
  });

  it('all 18 loadouts complete every flight climb (real player physics)', () => {
    for (const c of rep.climbs) {
      expect(c.configs.length, c.id).toBe(18);
      const bad = c.configs.filter((x) => !x.success).map((x) => `${x.fcs}/${x.generator}/${x.legs}: ${x.failure}`);
      expect(bad, c.id).toEqual([]);
    }
  });
});
