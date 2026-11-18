import { describe, expect, it } from 'vitest';
import { TICK } from '../src/config';
import { Sim } from '../src/sim/sim';
import { makeTarget, makeTestStage } from '../src/stage/testStages';

describe('sim skeleton', () => {
  it('constructs, ticks and keeps exact time', () => {
    const sim = new Sim(makeTestStage({ enemies: [makeTarget('X1', { x: 0, y: 3, z: -50 }, { x: 1, y: 0, z: 0 })] }));
    expect(sim.status).toBe('playing');
    expect(sim.player.en).toBe(120);
    sim.runFor(1.0);
    expect(sim.tickIndex).toBe(120);
    expect(sim.time).toBeCloseTo(120 * TICK, 12);
    expect(sim.enemies[0].pos.x).toBeCloseTo(1, 9);
    expect(sim.currentSectorId).toBe('T00');
    // advance() caps a long frame and keeps the remainder below one tick
    const before = sim.tickIndex;
    sim.advance(10);
    expect(sim.tickIndex - before).toBe(30);
    expect(sim.accumulator).toBeLessThan(TICK);
  });
});
