// Test fixtures: flat-arena stage, input builder, camera view stub.

import { World } from '../src/core/world.js';
import { PARAMS } from '../src/core/params.js';

export function makeArena({ boxes = [], spawns = [], start = [0, 0, 0], yaw = 0 } = {}) {
  const world = new World();
  world.addBox([-220, -1, -220], [220, 0, 220], { kind: 'floor' });
  world.addBox([-221, 0, -221], [221, 40, -220], {});
  world.addBox([-221, 0, 220], [221, 40, 221], {});
  world.addBox([-221, 0, -220], [-220, 40, 220], {});
  world.addBox([220, 0, -220], [221, 40, 220], {});
  for (const b of boxes) world.addBox(b[0], b[1], { kind: 'obstacle' });
  world.finalize();
  return {
    world,
    sectors: [{ id: 'arena', name: 'TEST ARENA', jp: 'T', vols: [{ x0: -140, z0: -140, x1: 140, z1: 140, y0: -1, y1: 40 }] }],
    links: [], spawns, barriers: [], barrierBoxes: {}, adjacency: { arena: [] },
    sectorAt: () => 'arena',
    start: { pos: start.slice(), yaw },
    escapeZone: { min: [999, 0, 999], max: [1000, 1, 1000] },
    climbs: [], boxes: [],
  };
}

// Input packet; view is required by FCS/fire paths.
export function idle(view) {
  return {
    move: null, camForwardXZ: [0, 1],
    spaceEdge: false, spaceHeld: false, spaceHeldFor: 0,
    qbEdge: false, shiftEdge: false, brakeHeld: false,
    fireHeld: false, view,
  };
}

// Camera stub: positioned at player head, looking at `target` (enemy or pos).
// project() returns screen center — the screen-position term of lock validity
// is exercised in-browser; here we isolate the ballistic/LOS terms.
export function targetView(game, target) {
  const head = [game.player.pos[0], game.player.pos[1] + 1.65, game.player.pos[2]];
  const c = target.center ? target.center() : target;
  const d = [c[0] - head[0], c[1] - head[1], c[2] - head[2]];
  const l = Math.hypot(d[0], d[1], d[2]) || 1;
  return {
    camPos: head,
    camForward: [d[0] / l, d[1] / l, d[2] / l],
    widthPx: 1280, heightPx: 720,
    project: () => ({ x: 640, y: 360, behind: false }),
  };
}

export const DT = PARAMS.simDt;

export function steps(game, n, input) {
  for (let i = 0; i < n; i++) game.step(typeof input === 'function' ? input(i) : input);
}

export function drainEvents(game) {
  const ev = game.events.slice();
  game.events.length = 0;
  return ev;
}

export function dist2d(a, b) { return Math.hypot(a[0] - b[0], a[2] - b[2]); }
export function dist3d(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }
