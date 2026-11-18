import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GameRenderer } from '../src/render.js';

function cameraHarness(boxes = []) {
  return {
    stage: { boxes }, width: 1280, height: 720,
    camera: new THREE.PerspectiveCamera(60, 1280 / 720, .1, 650),
    setGameCamera: GameRenderer.prototype.setGameCamera,
  };
}

test('TPS camera stays on the player side of a wall closer than the old minimum distance', () => {
  const render = cameraHarness([{ min: [-1, -3, -55], max: [0, 32, 55], kind: 'wall' }]);
  const game = { state: 'playing', yaw: 0, pitch: 0, player: { position: [1.1, 2.1, 0] }, objective: { openBarrierIds: [] } };
  render.setGameCamera(game);
  assert.ok(render.camera.position.x > .3, `camera inside wall: ${render.camera.position.toArray()}`);
  assert.ok(render.camera.position.x <= game.player.position[0]);
});

test('current camera projects a forward point to the viewport center and rejects a behind point by depth', () => {
  const render = cameraHarness();
  const game = { state: 'playing', yaw: .7, pitch: -.15, player: { position: [62, 10.1, -12] }, objective: { openBarrierIds: [] } };
  const info = GameRenderer.prototype.getCameraInfo.call(render, game);
  const ahead = info.position.map((n, i) => n + info.forward[i] * 60);
  const projected = info.project(ahead);
  assert.ok(Math.abs(projected.x - 640) < 1e-7);
  assert.ok(Math.abs(projected.y - 360) < 1e-7);
  assert.ok(Math.abs(projected.depth - 60) < 1e-7);
  assert.ok(info.project(info.position.map((n, i) => n - info.forward[i] * 20)).depth < 0);
  game.player.position = [117, 18.1, 22];
  const latest = GameRenderer.prototype.getCameraInfo.call(render, game);
  assert.notDeepEqual(latest.position, info.position);
  assert.equal(latest.width, 1280); assert.equal(latest.height, 720);
});
