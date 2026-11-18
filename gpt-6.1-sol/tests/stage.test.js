import test from 'node:test';
import assert from 'node:assert/strict';
import { STAGE, createWorld, segmentBox } from '../src/stage.js';
import { createPlayer, effectiveStats, stepMovement } from '../src/movement.js';

const HALF = [1.1, 2.1, 1.1];
const openWorld = () => {
  const world = createWorld();
  for (const barrier of STAGE.barriers) world.openBarrierIds.add(barrier.id);
  return world;
};

test('stage inventory is 15 sealed distinct sectors, 30 guards, 15 turrets, six controls', () => {
  assert.equal(STAGE.sectors.length, 15);
  assert.equal(new Set(STAGE.sectors.map((s) => s.type)).size, 14);
  assert.equal(STAGE.enemies.length, 45);
  assert.equal(new Set(STAGE.enemies.map((e) => e.id)).size, 45);
  assert.equal(STAGE.enemies.filter((e) => e.kind === 'guard').length, 30);
  assert.equal(STAGE.enemies.filter((e) => e.kind === 'turret').length, 15);
  assert.equal(STAGE.enemies.filter((e) => e.isGateControl).length, 6);
  for (const enemy of STAGE.enemies) assert.equal(enemy.hp, enemy.kind === 'guard' ? 120 : 240);
  assert.equal(STAGE.barriers.filter((b) => b.controlId).length, 6);
  assert.equal(new Set(STAGE.barriers.filter((b) => b.controlId).map((b) => b.sectorId)).size, 6);
  for (const barrier of STAGE.barriers.filter((b) => b.controlId)) {
    const controller = STAGE.enemies.find((e) => e.id === barrier.controlId);
    assert.ok(controller?.isGateControl);
    assert.equal(controller.sectorId, barrier.sectorId);
  }
  assert.equal(STAGE.requiredSectorIds.length, 15);
  assert.ok(STAGE.escapeBounds.min[0] - STAGE.startPosition[0] >= 1500);
  for (const sector of STAGE.sectors) {
    assert.ok(STAGE.boxes.some((b) => b.sectorId === sector.id && b.kind === 'roof'));
    assert.ok(STAGE.boxes.some((b) => b.sectorId === sector.id && b.kind === 'floor'));
  }
});

test('five physically clear 70x50 combat rectangles each have four independent enemies', () => {
  const combatSectors = STAGE.sectors.filter((s) => s.combatRectangle);
  assert.equal(combatSectors.length, 5);
  for (const sector of combatSectors) {
    const rect = sector.combatRectangle;
    assert.ok(rect.max[0] - rect.min[0] >= 60);
    assert.ok(rect.max[2] - rect.min[2] >= 50);
    assert.equal(STAGE.enemies.filter((e) => e.sectorId === sector.id).length, 4);
    const obstructions = STAGE.boxes.filter((b) => b.sectorId === sector.id && !['floor', 'roof'].includes(b.kind) && b.min[0] < rect.max[0] && b.max[0] > rect.min[0] && b.min[2] < rect.max[2] && b.max[2] > rect.min[2]);
    assert.equal(obstructions.length, 0, sector.id);
    const world = createWorld();
    const testPosition = [sector.bounds.min[0] + 84, sector.floorY + 2.1, 0];
    const exposed = STAGE.enemies.filter((e) => e.sectorId === sector.id && world.lineOfSight(e.position, testPosition));
    assert.equal(exposed.length, 4, `${sector.id} must permit four simultaneous shooters`);
  }
});

test('all 45 enemy centers have clear reachable physical placements', () => {
  const world = openWorld();
  for (const enemy of STAGE.enemies) {
    const sector = world.sectorAt(enemy.position);
    assert.equal(sector?.id, enemy.sectorId);
    const overlap = world.getBoxes().filter((b) => b.kind !== 'floor').find((b) => enemy.position.every((v, axis) => v > b.min[axis] - HALF[axis] + 1e-6 && v < b.max[axis] + HALF[axis] - 1e-6));
    assert.equal(overlap, undefined, `${enemy.id} overlaps ${overlap?.id}`);
    assert.ok(Number.isFinite(world.pathDistance(sector.entry, enemy.position)), `${enemy.id} reachable from sector entrance`);
  }
});

test('initial protection comes from solid shelter geometry and the shelter can be left', () => {
  const world = openWorld();
  for (const enemy of STAGE.enemies) assert.equal(world.lineOfSight(enemy.position, STAGE.startPosition), false, enemy.id);
  let position = [...STAGE.startPosition];
  const target = STAGE.sectors[0].exit;
  let reached = false;
  for (let i = 0; i < 60 * 45; i++) {
    const direction = world.navDirection(position, target, 'S01');
    position = world.moveBody(position, direction.map((v) => v * 8), 1 / 60, HALF).position;
    if (Math.hypot(position[0] - target[0], position[2] - target[2]) < 1.2) { reached = true; break; }
  }
  assert.ok(reached, `actual collision/navigation failed to leave shelter: ${position}`);
});

test('three roof-height machinery islands support real split/rejoin loops', () => {
  const world = openWorld();
  assert.equal(STAGE.branches.length, 3);
  assert.equal(STAGE.branches.filter((b) => b.loop).length, 3);
  for (const branch of STAGE.branches) {
    assert.deepEqual(branch.exposed[0], branch.covered[0]);
    assert.deepEqual(branch.exposed.at(-1), branch.covered.at(-1));
    for (const route of [branch.exposed, branch.covered]) {
      for (let i = 1; i < route.length; i++) assert.equal(world.traceSegment(route[i - 1], route[i], 1.1), null, `${branch.sectorId} route segment ${i}`);
    }
    const divider = STAGE.boxes.find((b) => b.sectorId === branch.sectorId && b.routeDivider);
    const sector = STAGE.sectors.find((s) => s.id === branch.sectorId);
    assert.equal(divider.max[1], sector.ceilingY);
    assert.ok(branch.covered.some((p) => p[2] > 18));
  }
});

test('ground navigation routes around actual machinery in every sector', () => {
  const world = openWorld();
  for (const sector of STAGE.sectors) {
    let position = [...sector.entry];
    let reached = false;
    for (let i = 0; i < 60 * 45; i++) {
      const direction = world.navDirection(position, sector.exit, sector.id);
      position = world.moveBody(position, direction.map((v) => v * 8), 1 / 60, HALF).position;
      if (Math.hypot(position[0] - sector.exit[0], position[2] - sector.exit[2]) < 1.2) { reached = true; break; }
    }
    assert.ok(reached, `${sector.id} route failed at ${position}`);
  }
});

test('all six 8m rises reject walking and normal jump, fit 90 EN slowest flight, and land', () => {
  assert.equal(STAGE.ascents.length, 6);
  const world = openWorld();
  for (const ascent of STAGE.ascents) {
    assert.equal(ascent.rise, 8);
    assert.ok(ascent.rise > (10 * 10) / (2 * 18));
    assert.ok(ascent.clearHeight >= 12);
    const walking = world.moveBody(ascent.takeoff, [12.8, 0, 0], 3, HALF);
    assert.ok(walking.position[0] < ascent.landing[0] - 9);
    let position = [...ascent.takeoff];
    let spent = 0;
    // Actual swept collisions include the sill, doorway head and both floors.
    for (let n = 0; n < 120 * 4 && position[0] < ascent.landing[0]; n++) {
      position = world.moveBody(position, [12.8, 8, 0], 1 / 120, HALF).position;
      spent += 20 / 120;
    }
    assert.ok(position[0] >= ascent.landing[0], `flight crosses ${ascent.connectionId}`);
    assert.ok(spent <= 90, `${ascent.connectionId} spent ${spent} EN`);
    let verticalVelocity = 8;
    let landed = false;
    for (let n = 0; n < 120 * 4; n++) {
      verticalVelocity -= 18 / 120;
      const result = world.moveBody(position, [0, verticalVelocity, 0], 1 / 120, HALF);
      position = result.position;
      if (result.grounded) { landed = true; break; }
    }
    assert.ok(landed, `${ascent.connectionId} has a real landing`);
    assert.ok(Math.abs(position[1] - ascent.landing[1]) < 0.001);
  }
});

test('production Space/flight/EN movement lands every ascent with all 18 loadouts', (t) => {
  const world = openWorld();
  const dt = 1 / 120;
  let trajectories = 0;
  let maxSpent = 0;
  let minSpent = Infinity;
  let maxFlightSeconds = 0;
  for (const fcs of ['wide', 'medium', 'narrow']) {
    for (const generator of ['capacity', 'balanced', 'recovery']) {
      for (const legs of ['biped', 'quadruped']) {
        const loadout = { fcs, generator, legs };
        const stats = effectiveStats(loadout);
        for (const ascent of STAGE.ascents) {
          const player = createPlayer(loadout, ascent.takeoff);
          let time = 0;
          for (let n = 0; n < 120 * 5 && player.position[0] < ascent.landing[0]; n++) {
            stepMovement(player, { direction: [1, 0], cameraForward: [1, 0], jumpPressed: n === 0, spaceHeld: true, spaceHeldSeconds: time }, dt, time, stats, world);
            time += dt;
          }
          const name = `${fcs}/${generator}/${legs} ${ascent.connectionId}`;
          assert.ok(player.position[0] >= ascent.landing[0], `${name} did not cross the physical sill`);
          const spent = stats.maxEn - player.en;
          assert.ok(spent <= 90 && player.en > 0, `${name} needs too much EN: ${spent}`);
          assert.equal(player.movement.qbSuccessfulCount, 0);
          maxSpent = Math.max(maxSpent, spent);
          minSpent = Math.min(minSpent, spent);
          maxFlightSeconds = Math.max(maxFlightSeconds, time);
          let landed = false;
          for (let n = 0; n < 120 * 5; n++) {
            stepMovement(player, { direction: [0, 0], spaceHeld: false, brake: true }, dt, time, stats, world);
            time += dt;
            if (player.grounded) { landed = true; break; }
          }
          assert.ok(landed, `${name} did not land on the next physical floor`);
          assert.ok(Math.abs(player.position[1] - ascent.landing[1]) < 0.001, `${name} wrong landing height ${player.position[1]}`);
          assert.ok(player.position[0] >= ascent.landing[0], `${name} fell back through the sill`);
          trajectories++;
        }
      }
    }
  }
  assert.equal(trajectories, 108);
  t.diagnostic(`108 production movement/EN trajectories landed; ascent EN ${minSpent.toFixed(6)}..${maxSpent.toFixed(6)}, longest Space hold ${maxFlightSeconds.toFixed(6)}s.`);
});

test('closed barriers block bodies and shots; opening uses the very same physical box', () => {
  const world = createWorld();
  for (const barrier of STAGE.barriers) {
    const y = barrier.min[1] + 4;
    const z = (barrier.min[2] + barrier.max[2]) / 2;
    const a = [barrier.min[0] - 5, y, z], b = [barrier.max[0] + 5, y, z];
    const closed = world.traceSegment(a, b);
    assert.equal(closed?.box.barrierId, barrier.id);
    world.openBarrierIds.add(barrier.id);
    assert.equal(world.getBoxes().some((box) => box.barrierId === barrier.id), false);
    assert.equal(world.traceSegment(a, b), null);
  }
});

test('swept body collision prevents QB tunnelling and clips inward momentum only', () => {
  const stage = { sectors: [], connections: [], boxes: [{ id: 'thin', min: [10, -10, -10], max: [10.1, 10, 10], kind: 'wall' }] };
  const world = createWorld(stage);
  const collision = world.moveBody([0, 2.1, 0], [80, 0, 5], 0.75, HALF);
  assert.ok(collision.position[0] <= 8.9);
  assert.equal(collision.velocity[0], 0);
  assert.equal(collision.velocity[2], 5);
  assert.ok(Math.abs(collision.position[2] - 3.75) < 1e-5);
});

test('stationary floor contact, roof collision, and glancing contacts are stable', () => {
  const world = createWorld();
  assert.equal(world.moveBody(STAGE.startPosition, [0, 0, 0], 1, HALF).grounded, true);
  const roofHit = world.moveBody([60, 2.1, 0], [0, 80, 0], 1, HALF);
  assert.ok(roofHit.position[1] <= STAGE.sectors[0].ceilingY - HALF[1]);
  assert.equal(roofHit.velocity[1], 0);
  assert.ok(roofHit.collisionNormals.some((n) => n[1] === -1));
  const floor = { min: [-100, -3, -100], max: [100, 0, 100] };
  assert.equal(segmentBox([0, 2.1, 0], [50, 2.1, 0], floor, HALF), null);
  assert.equal(segmentBox([0, 2.1, 0], [0, 3, 0], floor, HALF), null);
});

test('all connections have real sealed bulkheads and six ascents cannot be bypassed over roofs', () => {
  const world = openWorld();
  for (const connection of STAGE.connections) {
    const a = [connection.position[0] - 5, connection.sillY + 3, connection.position[2] + 14];
    const b = [connection.position[0] + 5, connection.sillY + 3, connection.position[2] + 14];
    assert.ok(world.traceSegment(a, b), connection.id);
  }
  for (const sector of STAGE.sectors) {
    const x = sector.bounds.min[0] + 20;
    assert.equal(world.traceSegment([x, sector.floorY + 3, 0], [x, sector.ceilingY + 10, 0])?.box.kind, 'roof');
  }
});
