import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { FactoryStage, MAIN_ROUTE } from '../src/stage.js';
import { pointInsideBox, hasLineOfSight } from '../src/collision.js';
import { CONTROL_TURRETS } from '../src/config.js';

function openAll(stage) { for (const b of stage.barriers.values()) { b.open = true; b.collider.active = false; } }

test('continuous factory has 21 sectors, 30 guards, 15 turrets and six distributed controls', () => {
  const stage = new FactoryStage(new THREE.Scene());
  assert.equal(stage.sectors.length, 21); assert.equal(MAIN_ROUTE.length, 18);
  assert.equal(stage.enemySpawns.filter(e => e.kind === 'guard').length, 30);
  assert.equal(stage.enemySpawns.filter(e => e.kind === 'turret').length, 15);
  assert.deepEqual(stage.enemySpawns.filter(e => e.isGateControl).map(e => e.id), CONTROL_TURRETS);
  assert.equal(new Set(stage.enemySpawns.map(e => e.id)).size, 45);
  for (const e of stage.enemySpawns) {
    const s = stage.sectorMap.get(e.sectorId);
    assert.ok(e.position[0] > s.minX && e.position[0] < s.maxX && e.position[2] > s.minZ && e.position[2] < s.maxZ, e.id);
    const blocking = stage.colliders.some(b => b.active && pointInsideBox(new THREE.Vector3(...e.position), b, -0.05));
    assert.equal(blocking, false, `${e.id} spawn intersects geometry`);
  }
  assert.ok(stage.barriers.has('FINAL'));
});

test('six mandatory 8–16m ascents fit the minimum EN/flight envelope and three floor bands', () => {
  const stage = new FactoryStage(new THREE.Scene()); let ascents = 0;
  for (let i = 0; i < 17; i++) {
    const a = stage.sectorMap.get(MAIN_ROUTE[i]), b = stage.sectorMap.get(MAIN_ROUTE[i + 1]);
    if (b.floorY > a.floorY) { ascents++; const rise = b.floorY - a.floorY; assert.ok(rise >= 6 && rise <= 16); assert.ok(rise / 8 * 20 < 90); }
  }
  assert.equal(ascents, 6);
  assert.deepEqual([...new Set(MAIN_ROUTE.map(id => stage.sectorMap.get(id).floorY))].sort((a, b) => a - b), [0, 8, 16]);
  assert.ok(stage.shortestPathMeters >= 1500);
  assert.equal(stage.connections.filter(c => c.branch !== undefined).length, 6); // three two-legged rejoining branches
});

test('final gate opens a real corridor from S17 into the escape volume', () => {
  const stage = new FactoryStage(new THREE.Scene()); openAll(stage);
  const start = new THREE.Vector3(500, 18.2, 240), door = new THREE.Vector3(540, 18.2, 240), entry = new THREE.Vector3(580, 18.2, 240);
  assert.ok(hasLineOfSight(start, door, stage.colliders));
  assert.ok(hasLineOfSight(door, entry, stage.colliders));
  assert.ok(stage.isInsideEscape(entry));
});

test('main doors and raised landings are physically open after their barriers', () => {
  const stage = new FactoryStage(new THREE.Scene()); openAll(stage);
  for (let i = 0; i < 17; i++) {
    const a = stage.sectorMap.get(MAIN_ROUTE[i]), b = stage.sectorMap.get(MAIN_ROUTE[i + 1]);
    const pa = new THREE.Vector3(a.center[0], a.floorY + 2.2, a.center[2]);
    const pb = new THREE.Vector3(b.center[0], b.floorY + 2.2, b.center[2]);
    let doorA, doorB;
    if (a.center[2] === b.center[2]) {
      doorA = new THREE.Vector3(a.center[0] < b.center[0] ? a.maxX : a.minX, a.floorY + 2.2, a.center[2]);
      doorB = new THREE.Vector3(a.center[0] < b.center[0] ? b.minX : b.maxX, b.floorY + 2.2, b.center[2]);
    } else {
      doorA = new THREE.Vector3(a.center[0], a.floorY + 2.2, a.center[2] < b.center[2] ? a.maxZ : a.minZ);
      doorB = new THREE.Vector3(b.center[0], b.floorY + 2.2, a.center[2] < b.center[2] ? b.minZ : b.maxZ);
    }
    assert.ok(hasLineOfSight(pa, doorA, stage.colliders), `${a.id} inner portal`);
    assert.ok(hasLineOfSight(doorB, pb, stage.colliders), `${b.id} inner portal`);
    if (a.floorY === b.floorY) assert.ok(hasLineOfSight(doorA, doorB, stage.colliders), `${a.id}-${b.id} corridor`);
    else {
      // Flight occurs inside the corridor, then crosses the raised landing horizontally.
      const highDoor = a.floorY < b.floorY ? doorB : doorA;
      const lowDoor = a.floorY < b.floorY ? doorA : doorB;
      const lift = lowDoor.clone().lerp(highDoor, 0.35); const high = lift.clone(); high.y = highDoor.y;
      assert.ok(hasLineOfSight(lift, high, stage.colliders), `${a.id}-${b.id} lift`);
      assert.ok(hasLineOfSight(high, highDoor, stage.colliders), `${a.id}-${b.id} upper landing`);
    }
  }
});
