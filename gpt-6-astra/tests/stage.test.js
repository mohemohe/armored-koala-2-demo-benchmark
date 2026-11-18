import test from 'node:test';
import assert from 'node:assert/strict';
import { Matrix4, Vector3 } from 'three';
import { createStage } from '../src/stage.js';
import { ENEMY_STATS, PHYSICS, FCS, GENERATORS, LEGS, effectiveStats } from '../src/config.js';
import { createPlayer, prepareMovement, updateMovement } from '../src/movement.js';

const vector = (value) => value.isVector3 ? value.clone() : new Vector3(...value);
const openAllGates = (world) => world.updateControls(world.enemySpawns.map((spawn) => ({ ...spawn, alive: false, hp: 0 })));
const advance = (world, player, stats, input, time) => {
  prepareMovement(player, input, stats, time);
  updateMovement(player, input, stats, time, PHYSICS.fixedStep, world);
};

test('the playable factory contains the required distinct sectors and actual enemy population', () => {
  const world = createStage();
  try {
    assert.ok(world.sectors.length >= 15);
    assert.equal(new Set(world.sectors.map((sector) => sector.id)).size, world.sectors.length);
    assert.ok(new Set(world.sectors.map((sector) => sector.type)).size >= 6);
    assert.equal(world.enemySpawns.length, 45);
    assert.equal(new Set(world.enemySpawns.map((enemy) => enemy.id)).size, 45);
    assert.equal(world.enemySpawns.filter((enemy) => enemy.kind === 'guard').length, 30);
    assert.equal(world.enemySpawns.filter((enemy) => enemy.kind === 'turret').length, 15);
    const controls = world.enemySpawns.filter((enemy) => enemy.isGateControl);
    assert.equal(controls.length, 6);
    assert.ok(controls.every((enemy) => enemy.kind === 'turret'));
    assert.equal(new Set(controls.map((enemy) => enemy.sectorId)).size, 6);
    for (const enemy of world.enemySpawns) {
      const position = vector(enemy.position);
      const sector = world.sectors.find((candidate) => candidate.id === enemy.sectorId);
      assert.ok(sector, `${enemy.id} has a real sector`);
      assert.equal(world.sectorAt(position)?.id, enemy.sectorId, `${enemy.id} physically lies in its recorded sector`);
      assert.equal(world.raycast(position, position.clone().add(new Vector3(0.001, 0, 0))), null,
        `${enemy.id} center is not embedded inside solid geometry`);
      const radius = ENEMY_STATS[enemy.kind].radius;
      for (const collider of world.colliders.filter((candidate) => candidate.active)) {
        const nearest = position.clone().clamp(collider.min, collider.max);
        assert.ok(nearest.distanceTo(position) >= radius - 1e-6, `${enemy.id} has complete collision-sphere clearance at ${collider.name}`);
      }
      const roomEntry = new Vector3(0, sector.floorY + 2, sector.startZ + 7);
      assert.ok(Number.isFinite(world.pathDistance(roomEntry, position)), `${enemy.id} is reachable from its room entry over navigable cells`);
      assert.ok(Number.isFinite(position.x + position.y + position.z));
    }
  } finally { world.dispose(); }
});

test('all room transitions have physically clear full-height portals after controls die', () => {
  const world = createStage();
  try {
    openAllGates(world);
    assert.equal(world.connections.length, world.sectors.length - 1);
    const reached = new Set([world.sectors[0].id]);
    for (const connection of world.connections) {
      assert.ok(reached.has(connection.from), 'facility rooms form a connected sequential route');
      reached.add(connection.to);
      const [x, y, z] = connection.position;
      const position = new Vector3(x, y + 0.1, z - 5);
      world.moveBody(position, new Vector3(0, 0, 10), 1, PHYSICS.playerRadius, PHYSICS.playerHeight);
      assert.ok(Math.abs(position.z - (z + 5)) < 0.01, `${connection.from} -> ${connection.to} has a body-clear opening`);
    }
    assert.equal(reached.size, world.sectors.length);
  } finally { world.dispose(); }
});

test('the recorded walkthrough sweeps through all 17 sectors and reaches the real escape volume', (t) => {
  const world = createStage();
  try {
    openAllGates(world);
    assert.deepEqual(world.routePoints[0], world.spawn.toArray());
    const visited = new Set();
    let routeLength = 0;
    for (let index = 1; index < world.routePoints.length; index++) {
      const position = vector(world.routePoints[index - 1]);
      const target = vector(world.routePoints[index]);
      const displacement = target.clone().sub(position);
      routeLength += displacement.length();
      const subdivisions = Math.max(1, Math.ceil(displacement.length() / 4));
      for (let step = 0; step < subdivisions; step++) {
        world.moveBody(position, displacement.clone(), 1 / subdivisions, PHYSICS.playerRadius, PHYSICS.playerHeight);
        const sector = world.sectorAt(position);
        assert.ok(sector, `walkthrough segment ${index} remains inside a real sector`);
        visited.add(sector.id);
      }
      assert.ok(position.distanceTo(target) < 0.01,
        `walkthrough segment ${index}: ${world.routePoints[index - 1]} -> ${world.routePoints[index]} stops at ${position.toArray()}`);
    }
    assert.equal(visited.size, 17);
    assert.equal(world.isEscape(vector(world.routePoints.at(-1))), true);
    assert.ok(world.routePoints.at(-1)[2] > world.finalGate.position[2]);
    t.diagnostic(`Collision-verified walkthrough length ${routeLength.toFixed(3)}m through ${visited.size} sectors; not claimed as the shortest path.`);
  } finally { world.dispose(); }
});

test('guard navigation physically rounds every machine core within eight seconds without becoming stuck', (t) => {
  const world = createStage();
  try {
    openAllGates(world);
    for (const branch of world.branches) {
      const position = vector(branch.split).add(new Vector3(0, 2, 0));
      const target = vector(branch.join).add(new Vector3(0, 2, 0));
      assert.ok(world.raycast(position, target), 'the navigation trial starts with an occluded target');
      let distanceTravelled = 0;
      let longestStall = 0;
      let stalled = 0;
      let elapsed = 0;
      for (let step = 0; step < 960 && position.distanceTo(target) > 0.2; step++) {
        const direction = world.navigationDirection(position, target, ENEMY_STATS.guard.radius);
        const speed = Math.min(ENEMY_STATS.guard.movementSpeed, position.distanceTo(target) / PHYSICS.fixedStep);
        const feet = position.clone().add(new Vector3(0, -2, 0));
        world.moveBody(feet, direction.multiplyScalar(speed), PHYSICS.fixedStep, ENEMY_STATS.guard.radius, 4);
        const next = feet.add(new Vector3(0, 2, 0));
        const travelled = position.distanceTo(next);
        distanceTravelled += travelled;
        stalled = travelled < 0.0001 ? stalled + 1 : 0;
        longestStall = Math.max(longestStall, stalled);
        position.copy(next);
        elapsed += PHYSICS.fixedStep;
      }
      assert.ok(longestStall < 60, `${branch.id} does not stall for half a second`);
      assert.ok(position.distanceTo(target) <= 0.2,
        `${branch.id} guard reaches rejoin within 8s; stopped at ${position.toArray()}, ${position.distanceTo(target).toFixed(3)}m away`);
      t.diagnostic(`${branch.id}: actual guard movement ${distanceTravelled.toFixed(3)}m in ${elapsed.toFixed(3)}s around solid core.`);
    }
  } finally { world.dispose(); }
});

test('three substantial physical branches rejoin around floor-to-roof obstacles and form real loops', () => {
  const world = createStage();
  try {
    openAllGates(world);
    assert.ok(world.branches.length >= 3);
    assert.ok(world.branches.filter((branch) => branch.loop).length >= 2);
    for (const branch of world.branches) {
      const lengths = [];
      for (const route of [branch.exposed, branch.covered]) {
        assert.deepEqual(route[0], branch.split);
        assert.deepEqual(route.at(-1), branch.join);
        let length = 0;
        for (let index = 1; index < route.length; index++) {
          const position = vector(route[index - 1]);
          const target = vector(route[index]);
          const velocity = target.clone().sub(position);
          length += velocity.length();
          world.moveBody(position, velocity, 1, PHYSICS.playerRadius, PHYSICS.playerHeight);
          assert.ok(position.distanceTo(target) < 0.01, `${branch.id} path segment ${index} has body clearance`);
        }
        lengths.push(length);
      }
      assert.ok(lengths[0] >= 60, `${branch.id} is a substantial route, not decorative duplicate doors`);
      assert.ok(lengths[1] - lengths[0] >= 20, `${branch.id} offers a measurably longer covered route`);
      const split = vector(branch.split).add(new Vector3(0, 2.2, 0));
      const join = vector(branch.join).add(new Vector3(0, 2.2, 0));
      assert.ok(world.raycast(split, join), 'the two routes physically split around blocking architecture');
      const sector = world.sectors.find((candidate) => candidate.id === branch.sectorId);
      assert.equal(branch.island.max[1], sector.roofY, 'flight cannot bypass the route split over its core');
    }
  } finally { world.dispose(); }
});

test('five or more measured combat courts are clear at 60m by 50m and provide four independent enemy sightlines', () => {
  const world = createStage();
  try {
    const arenas = world.sectors.filter((sector) => sector.arena);
    assert.ok(arenas.length >= 5);
    for (const sector of arenas) {
      const arena = sector.arena;
      assert.ok(arena.max[0] - arena.min[0] >= 60);
      assert.ok(arena.max[2] - arena.min[2] >= 50);
      const minimum = vector(arena.min).add(new Vector3(0, 0.01, 0));
      const maximum = vector(arena.max);
      maximum.y = sector.floorY + PHYSICS.playerHeight;
      const solidsInCourt = world.colliders.filter((collider) => collider.active
        && collider.min.x < maximum.x && collider.max.x > minimum.x
        && collider.min.y < maximum.y && collider.max.y > minimum.y
        && collider.min.z < maximum.z && collider.max.z > minimum.z);
      assert.deepEqual(solidsInCourt.map((collider) => collider.name), [], `${sector.id} measured court is genuinely clear at player height`);
      const engagement = vector(arena.engagementPoint);
      const enemiesWithSight = world.enemySpawns.filter((enemy) => enemy.sectorId === sector.id
        && vector(enemy.position).distanceTo(engagement) <= ENEMY_STATS[enemy.kind].range
        && world.lineOfSight(vector(enemy.position), engagement));
      assert.ok(enemiesWithSight.length >= 4, `${sector.id} exposes the engagement position to ${enemiesWithSight.length} enemies`);
      assert.ok(enemiesWithSight.some((enemy) => enemy.position[0] < -10));
      assert.ok(enemiesWithSight.some((enemy) => enemy.position[0] > 10));
    }
  } finally { world.dispose(); }
});

test('six compulsory rises block normal jumping and are traversable with flight by all 18 loadouts', (t) => {
  const world = createStage();
  try {
    openAllGates(world);
    assert.equal(world.requiredAscents.length, 6);
    assert.ok(new Set(world.sectors.map((sector) => sector.floorY)).size >= 3);
    let minimumRemainingEn = Infinity;
    let maximumFlightSeconds = 0;
    for (const ascent of world.requiredAscents) {
      assert.ok(ascent.rise >= 6 && ascent.rise <= 16);
      const lower = vector(ascent.lower);
      const upper = vector(ascent.upper);
      const stats = effectiveStats();
      const jumper = createPlayer(undefined, lower);
      let jumpApex = jumper.position.y;
      for (let step = 0; step < 240; step++) {
        advance(world, jumper, stats, { forward: 1, yaw: 0, jumpPressed: step === 0 }, step * PHYSICS.fixedStep);
        jumpApex = Math.max(jumpApex, jumper.position.y);
      }
      assert.ok(jumpApex < upper.y, `${ascent.id} cannot be reached by a normal jump`);
      assert.ok(jumper.position.z < (lower.z + upper.z) / 2, `${ascent.id} sill blocks ground passage`);

      for (const fcs of Object.keys(FCS)) for (const generator of Object.keys(GENERATORS)) for (const legs of Object.keys(LEGS)) {
        const loadout = { fcs, generator, legs };
        const flightStats = effectiveStats(loadout);
        const player = createPlayer(loadout, lower);
        let reached = false;
        let leastEn = player.en;
        let flightSeconds = 0;
        for (let step = 0; step < 960; step++) {
          const time = step * PHYSICS.fixedStep;
          if (player.position.z >= upper.z) reached = true;
          const fly = !reached;
          if (fly && time >= PHYSICS.flightHoldSeconds) flightSeconds += PHYSICS.fixedStep;
          advance(world, player, flightStats, {
            forward: !reached && player.position.y >= upper.y + 0.2 ? 1 : 0,
            yaw: 0, jumpPressed: step === 0, spaceHeld: fly, spaceHeldSeconds: fly ? time : 0,
            brake: reached,
          }, time);
          leastEn = Math.min(leastEn, player.en);
          if (reached && player.grounded) break;
        }
        const description = `${ascent.id}/${fcs}/${generator}/${legs}`;
        assert.equal(reached, true, `${description} crosses the actual riser and doorway`);
        assert.equal(player.grounded, true, `${description} lands on a recovery floor`);
        assert.ok(Math.abs(player.position.y - upper.y) < 0.02, `${description} lands at the upper floor height`);
        assert.ok(leastEn > 0, `${description} retains EN after the required flight`);
        minimumRemainingEn = Math.min(minimumRemainingEn, leastEn);
        maximumFlightSeconds = Math.max(maximumFlightSeconds, flightSeconds);
      }
    }
    t.diagnostic(`108 actual movement traversals: max powered flight ${maximumFlightSeconds.toFixed(3)}s; minimum remaining EN ${minimumRemainingEn.toFixed(3)}.`);
  } finally { world.dispose(); }
});

test('every collision box is rendered at its exact physical transform', () => {
  const world = createStage();
  try {
    const batches = new Map();
    for (const collider of world.colliders) {
      if (collider.dynamic) {
        assert.ok(collider.mesh?.visible);
        assert.ok(collider.mesh.position.distanceTo(collider.min.clone().add(collider.max).multiplyScalar(0.5)) < 1e-8);
        assert.ok(collider.mesh.scale.distanceTo(collider.max.clone().sub(collider.min)) < 1e-8);
      } else {
        const key = `${collider.sectorId}:${collider.material}`;
        if (!batches.has(key)) batches.set(key, []);
        batches.get(key).push(collider);
      }
    }
    for (const [key, colliders] of batches) {
      const mesh = world.meshes.children.find((candidate) => candidate.isInstancedMesh && candidate.name === key);
      assert.ok(mesh, `${key} collision group has visible geometry`);
      assert.equal(mesh.count, colliders.length);
      for (let index = 0; index < colliders.length; index++) {
        const collider = colliders[index];
        const matrix = new Matrix4();
        mesh.getMatrixAt(index, matrix);
        const center = new Vector3().setFromMatrixPosition(matrix);
        const size = new Vector3().setFromMatrixScale(matrix);
        assert.ok(center.distanceTo(collider.min.clone().add(collider.max).multiplyScalar(0.5)) < 0.001);
        assert.ok(size.distanceTo(collider.max.clone().sub(collider.min)) < 0.001);
      }
    }
  } finally { world.dispose(); }
});

test('the actual escape volume is at least 1500m from spawn, even on a straight flight shortcut', () => {
  const world = createStage();
  try {
    const closestEscapePoint = world.spawn.clone().clamp(vector(world.escape.min), vector(world.escape.max));
    assert.ok(closestEscapePoint.distanceTo(world.spawn) >= 1500,
      `coordinate lower bound is ${closestEscapePoint.distanceTo(world.spawn)}m`);
    assert.equal(world.isEscape(world.spawn), false);
    assert.equal(world.isEscape(closestEscapePoint), false, 'entering the volume cannot clear before controls die');
  } finally { world.dispose(); }
});

test('spawn is sheltered from every enemy with an initial in-range firing line', () => {
  const world = createStage();
  try {
    const playerCenter = world.spawn.clone().add(new Vector3(0, PHYSICS.collisionCenterHeight, 0));
    for (const enemy of world.enemySpawns) {
      const position = vector(enemy.position);
      if (position.distanceTo(playerCenter) <= ENEMY_STATS[enemy.kind].range) {
        assert.equal(world.lineOfSight(position, playerCenter), false, `${enemy.id} cannot fire immediately into spawn`);
      }
    }
  } finally { world.dispose(); }
});

test('floor, outer wall and roof physically stop even unusually long high-speed movement', () => {
  const world = createStage();
  try {
    const sector = world.sectorAt(world.spawn);
    assert.ok(sector);
    const floorPosition = world.spawn.clone();
    const falling = new Vector3(0, -500, 0);
    const result = world.moveBody(floorPosition, falling, 1, PHYSICS.playerRadius, PHYSICS.playerHeight);
    assert.equal(result.grounded, true);
    assert.ok(Math.abs(floorPosition.y - world.spawn.y) < 0.01);
    assert.equal(falling.y, 0);

    const wallPosition = world.spawn.clone();
    const boosted = new Vector3(10000, 0, 0);
    world.moveBody(wallPosition, boosted, 1, PHYSICS.playerRadius, PHYSICS.playerHeight);
    assert.ok(wallPosition.x < sector.bounds.max[0], 'a single large delta cannot cross the outer wall');
    assert.equal(boosted.x, 0, 'contact removes only the velocity toward the wall');

    const ceilingPosition = world.spawn.clone();
    const flying = new Vector3(0, 1000, 0);
    world.moveBody(ceilingPosition, flying, 1, PHYSICS.playerRadius, PHYSICS.playerHeight);
    assert.ok(ceilingPosition.y + PHYSICS.playerHeight <= sector.bounds.max[1] + 0.01,
      'flight cannot escape over the facility roof');
    assert.equal(flying.y, 0);
  } finally { world.dispose(); }
});

test('only destroyed controls open their matching gates; six deaths open escape and reset restores all gates', () => {
  const world = createStage();
  try {
    const enemies = world.enemySpawns.map((spawn) => ({ ...spawn, alive: true, hp: ENEMY_STATS[spawn.kind].hp }));
    const controls = enemies.filter((enemy) => enemy.isGateControl);
    world.updateControls(enemies);
    assert.ok(world.barriers.every((barrier) => !barrier.open));
    const gateRay = (gate) => {
      const center = vector(gate.position);
      return world.raycast(center.clone().add(new Vector3(0, 0, -3)), center.clone().add(new Vector3(0, 0, 3)), PHYSICS.playerRadius);
    };
    for (const gate of [...world.barriers, world.finalGate]) {
      assert.equal(gateRay(gate)?.collider.id, gate.collider.id, `${gate.id} physically blocks its doorway`);
    }
    for (const enemy of enemies.filter((candidate) => !candidate.isGateControl)) {
      enemy.alive = false;
      enemy.hp = 0;
    }
    world.updateControls(enemies);
    assert.ok(world.barriers.every((barrier) => !barrier.open), 'ordinary kills cannot substitute for control deaths');
    for (let index = 0; index < controls.length; index++) {
      const control = controls[index];
      control.alive = false;
      control.hp = 0;
      world.updateControls(enemies);
      const gate = world.barriers.find((barrier) => barrier.controlId === control.id);
      assert.ok(gate, `${control.id} operates a real gate`);
      assert.equal(gate.open, true);
      assert.equal(gate.mesh.visible, false);
      assert.equal(gate.collider.active, false);
      assert.equal(gateRay(gate), null, `${gate.id} opening removes actual collision`);
      for (const untouched of controls.slice(index + 1)) {
        assert.equal(world.barriers.find((barrier) => barrier.controlId === untouched.id)?.open, false);
      }
      assert.equal(world.finalGate.open, index === controls.length - 1, 'final gate needs all six real control deaths');
    }
    const escapeCenter = vector(world.escape.min).add(vector(world.escape.max)).multiplyScalar(0.5);
    assert.equal(world.isEscape(escapeCenter), true);
    world.reset();
    assert.ok(world.barriers.every((barrier) => !barrier.open));
    for (const gate of [...world.barriers, world.finalGate]) {
      assert.equal(gate.mesh.visible, true);
      assert.equal(gate.collider.active, true);
      assert.ok(gateRay(gate));
    }
    assert.equal(world.isEscape(escapeCenter), false);
  } finally { world.dispose(); }
});
