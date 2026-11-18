/** Sector tracking, control-turret -> barrier opening, final gate, clear / fail detection. */
import { pushEvent } from './combat';
import type { GameState } from './types';

function inside(p: { x: number; y: number; z: number }, b: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }): boolean {
  return p.x >= b.min.x && p.x <= b.max.x && p.y >= b.min.y && p.y <= b.max.y && p.z >= b.min.z && p.z <= b.max.z;
}

export function initProgress(state: GameState): void {
  state.progress.currentSectorId = null;
  state.progress.visitedSectorIds = [];
  trackSector(state);
}

function trackSector(state: GameState): void {
  const p = state.player.pos;
  for (const s of state.stage.sectors) {
    if (inside(p, s.bounds)) {
      if (state.progress.currentSectorId !== s.id) {
        state.progress.currentSectorId = s.id;
        if (!state.progress.visitedSectorIds.includes(s.id)) {
          state.progress.visitedSectorIds.push(s.id);
          pushEvent(state, { type: 'sector', time: state.time, sectorId: s.id });
        }
      }
      return;
    }
  }
}

function setBarrierBoxes(state: GameState, barrierId: string, enabled: boolean): void {
  const b = state.stage.barriers.find((x) => x.id === barrierId);
  if (!b) return;
  for (const id of b.boxIds) {
    const i = state.world.indexOfBox(id);
    if (i >= 0) state.world.setBoxEnabled(i, enabled);
  }
}

/** Called at the end of every tick (state at T+dt). May switch mode to 'cleared' / 'failed'. */
export function updateProgress(state: GameState): void {
  trackSector(state);

  let destroyed = 0;
  for (const b of state.stage.barriers) {
    if (b.isFinal || b.controlEnemyId === null) continue;
    const e = state.enemies.find((x) => x.id === b.controlEnemyId);
    if (e && !e.alive) {
      destroyed += 1;
      if (!state.objective.openBarrierIds.includes(b.id)) {
        state.objective.openBarrierIds.push(b.id);
        setBarrierBoxes(state, b.id, false);
        pushEvent(state, { type: 'barrierOpen', time: state.time, barrierId: b.id });
      }
    }
  }
  state.objective.controlsDestroyed = destroyed;
  if (destroyed >= 6 && !state.objective.gateOpen) {
    state.objective.gateOpen = true;
    for (const b of state.stage.barriers) if (b.isFinal) setBarrierBoxes(state, b.id, false);
    pushEvent(state, { type: 'gateOpen', time: state.time });
  }

  // failure has priority over clear when both happen in the same update
  const p = state.player;
  if (p.hp <= 0) {
    state.mode = 'failed';
    state.endReason = 'hp';
  } else if (p.pos.y < state.stage.killY) {
    state.mode = 'failed';
    state.endReason = 'fall';
  } else if (state.objective.gateOpen && inside(p.pos, state.stage.escapeZone)) {
    state.mode = 'cleared';
    state.endReason = 'escaped';
  }
}
