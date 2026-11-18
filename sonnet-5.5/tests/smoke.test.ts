import { describe, expect, it } from 'vitest';
import { createArenaGame } from '../src/sim/testArena';
import { buildSnapshot } from '../src/sim/bench';
import { computeEffectiveStats } from '../src/sim/stats';

describe('skeleton smoke', () => {
  it('boots a flat arena game and ticks', () => {
    const g = createArenaGame();
    for (let i = 0; i < 120; i++) g.step();
    expect(g.state.tick).toBe(120);
    expect(g.state.time).toBeCloseTo(1, 9);
    const snap = buildSnapshot(g.state);
    expect(snap.version).toBe('AK2-1.2-candidate');
    expect(JSON.stringify(snap)).not.toContain('NaN');
  });
  it('effective stats follow SPEC §6 examples', () => {
    const s = computeEffectiveStats({ fcs: 'medium', generator: 'balanced', legs: 'quadruped' });
    expect(s.maxEn).toBe(120);
    expect(s.regenPerSecond).toBeCloseTo(11.25, 9);
    expect(s.lockSeconds).toBeCloseTo(0.8 / 1.5, 9);
  });
  it('world raycast/sweep basics', () => {
    const g = createArenaGame();
    const hit = g.world.raycast({ x: 0, y: 5, z: 0 }, { x: 0, y: -1, z: 0 }, 100);
    expect(hit?.t).toBeCloseTo(5, 6);
    const sw = g.world.sweepAABB({ x: 0, y: 1.5, z: 0 }, { x: 0.8, y: 1.5, z: 0.8 }, { x: 0, y: -2, z: 0 });
    expect(sw?.t).toBeCloseTo(0, 6);
  });
});
