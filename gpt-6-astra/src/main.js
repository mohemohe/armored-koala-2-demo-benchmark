import * as THREE from 'three';
import './style.css';
import { DEFAULT_LOADOUT, effectiveStats } from './config.js';
import { createPlayer, prepareMovement, updateMovement } from './movement.js';
import { createStage } from './stage.js';
import { createCombat } from './combat.js';
import { createGarageScene } from './presentation.js';
import { createUI } from './ui.js';
import { GameRenderer } from './renderer.js';
import { InputController } from './input.js';

const canvas = document.querySelector('#game-canvas');
const seedInput = new URLSearchParams(location.search).get('seed');
const seedNumber = seedInput === null ? 20260908 : Number(seedInput);
const seed = Number.isInteger(seedNumber) && seedNumber >= 0 && seedNumber <= 4294967295 ? seedNumber >>> 0 : 20260908;
const FIXED_DT = 1 / 120;
let state = 'garage', loadout = { ...DEFAULT_LOADOUT }, stats = effectiveStats(loadout);
let elapsed = 0, yaw = 0, pitch = -0.06, accumulator = 0, lastFrame = performance.now(), frameCounter = 0, fps = 60;
let width = window.innerWidth, height = window.innerHeight, pendingLock = false;
let combat, player, world, garageScene, renderer;
let visited = new Set();
const inputController = new InputController();
const ui = createUI(document.querySelector('#ui-root'), {
  setLoadout(key, value) {
    if (state !== 'garage') return;
    loadout = { ...loadout, [key]: value }; stats = effectiveStats(loadout);
    ui.renderGarage(loadout, stats);
  },
  deploy: () => requestPlay(true), resume: () => requestPlay(false), retry: () => requestPlay(true), garage: returnToGarage,
});

try {
  renderer = new GameRenderer(canvas);
  garageScene = createGarageScene();
  world = createStage(); world.seed = seed;
  resetMission();
  resize(); ui.renderGarage(loadout, stats); ui.showState('garage', {});
  requestAnimationFrame(frame);
} catch (error) {
  console.error(error);
  document.querySelector('#ui-root').innerHTML = `<main style="padding:60px;color:#ede9dc;font:18px monospace"><h1>ARMORED KOALA 2</h1><p>3Dの初期化に失敗しました。WebGL 2 が有効なデスクトップブラウザで再読み込みしてください。</p><pre>${String(error).replace(/[<>&]/g, '')}</pre><button onclick="location.reload()">RETRY</button></main>`;
}

function resetMission() {
  stats = effectiveStats(loadout);
  elapsed = 0; yaw = 0; pitch = -0.06; accumulator = 0; visited = new Set();
  clearInput(); world.reset();
  player = createPlayer(loadout, world.spawn.clone()); player.yaw = yaw;
  player.previousPosition = player.position.clone();
  combat = createCombat(world, loadout);
  renderer.setWorld(world, combat, loadout);
  renderer.updateCamera(player, yaw, pitch);
  const sector = world.sectorAt(player.position); if (sector) visited.add(sector.id);
}
async function requestPlay(restart) {
  if (pendingLock || state === 'playing') return;
  if (restart) resetMission();
  pendingLock = true;
  try {
    if (typeof canvas.requestPointerLock !== 'function') throw new Error('このブラウザでは Pointer Lock API を利用できません。');
    await canvas.requestPointerLock();
    // Some browsers return void and dispatch pointerlockchange asynchronously.
    if (pendingLock && document.pointerLockElement === canvas) enterPlay();
  } catch (error) { pointerFailure(error); }
}
function enterPlay() {
  pendingLock = false;
  clearInput(); state = 'playing'; accumulator = 0; lastFrame = performance.now();
  ui.showState(state, {});
}
function pointerFailure(error) {
  pendingLock = false;
  if (state !== 'cleared' && state !== 'failed') state = 'paused';
  clearInput(); accumulator = 0;
  const message = typeof canvas.requestPointerLock !== 'function'
    ? 'このブラウザはマウスの取得に対応していません。Pointer Lock 対応のデスクトップブラウザでこのURLを開いてください。'
    : 'マウスの取得が許可されませんでした。「再開」で再試行してください。内蔵ブラウザで拒否される場合は、外部ブラウザでこのURLを開いてください。';
  ui.showState(state, { ...resultData(), pointerLockError: message, reason: message });
}
function pause(reason = '') {
  if (state !== 'playing') return;
  state = 'paused'; accumulator = 0; clearInput();
  if (document.pointerLockElement === canvas) document.exitPointerLock();
  ui.showState(state, { ...resultData(), reason });
}
function returnToGarage() {
  pendingLock = false; state = 'garage'; accumulator = 0; clearInput();
  if (document.pointerLockElement === canvas) document.exitPointerLock();
  ui.renderGarage(loadout, stats); ui.showState('garage', {});
}
function clearInput() {
  inputController.clear();
}
function resultData() { return { elapsed, elapsedSeconds: elapsed, objective: objective(), player, enemies: combat?.enemies || [], seed }; }
function objective() {
  const count = combat?.enemies.filter(e => e.isGateControl && !e.alive).length || 0;
  return { controlsDestroyed: count, controlsRequired: 6, openBarrierIds: world?.barriers.filter(b => b.open).map(b => b.id) || [], gateOpen: count === 6 };
}

document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement === canvas) {
    if (pendingLock) enterPlay();
    else if (state !== 'playing') document.exitPointerLock();
  } else pause('マウス操作が解除されたため一時停止しました。');
});
document.addEventListener('pointerlockerror', () => pointerFailure(new Error('Pointer lock denied')));
window.addEventListener('blur', () => pause('ウィンドウが非アクティブになりました。'));
document.addEventListener('visibilitychange', () => { if (document.hidden) pause('タブが非表示になりました。'); });
window.addEventListener('keydown', event => {
  if (event.code === 'Escape') { pause(); return; }
  const weapon = inputController.handleKeyDown(event, state, elapsed);
  if (weapon) player.weapon = weapon;
});
window.addEventListener('keyup', event => inputController.handleKeyUp(event));
document.addEventListener('mousemove', event => {
  if (state !== 'playing' || document.pointerLockElement !== canvas) return;
  yaw -= event.movementX * 0.0022;
  pitch = THREE.MathUtils.clamp(pitch - event.movementY * 0.0022, -1.15, 1.2);
});
canvas.addEventListener('mousedown', event => { if (event.button === 0 && state === 'playing' && document.pointerLockElement === canvas) inputController.fireHeld = true; });
window.addEventListener('mouseup', event => { if (event.button === 0) inputController.fireHeld = false; });
canvas.addEventListener('contextmenu', event => event.preventDefault());
window.addEventListener('resize', resize);
function resize() {
  width = window.innerWidth; height = window.innerHeight;
  renderer?.resize(width, height); garageScene?.resize(width, height); ui.resize(width, height);
}
function simulationStep(dt) {
  const input = inputController.movementInput(yaw, elapsed);
  player.yaw = yaw; player.previousPosition.copy(player.position);
  prepareMovement(player, input, stats, elapsed);
  renderer.updateCamera(player, yaw, pitch);
  combat.updateLock(player, renderer.camera, width, height, elapsed, dt);
  combat.fire(player, renderer.camera, elapsed, input.fire);
  updateMovement(player, input, stats, elapsed, dt, world);
  combat.updateEnemies(player, elapsed, dt);
  combat.updateProjectiles(player, elapsed, dt);
  elapsed += dt;
  world.updateControls(combat.enemies);
  renderer.updateCamera(player, yaw, pitch);
  combat.updateLock(player, renderer.camera, width, height, elapsed, 0);
  const sector = world.sectorAt(player.position);
  if (sector) visited.add(sector.id);
  // Death takes priority over escape in the same simulation update.
  if (player.hp <= 0 || player.position.y < -70) endMission('failed');
  else if (objective().gateOpen && world.isEscape(player.position)) endMission('cleared');
}
function endMission(result) {
  state = result; accumulator = 0; clearInput();
  if (document.pointerLockElement === canvas) document.exitPointerLock();
  ui.showState(result, resultData());
}
function frame(now) {
  const wallDt = Math.max(0, (now - lastFrame) / 1000); lastFrame = now;
  if (state === 'playing') {
    // A suspended browser is paused, never fast-forwarded through combat.
    if (wallDt > 0.5) pause('長時間の描画中断を検出したため一時停止しました。');
    else {
      accumulator += wallDt;
      while (accumulator + 1e-10 >= FIXED_DT && state === 'playing') {
        simulationStep(FIXED_DT); accumulator -= FIXED_DT;
      }
    }
  }
  if (state === 'garage') {
    garageScene.update(now / 1000, loadout);
    renderer.renderer.render(garageScene.scene, garageScene.camera);
  } else {
    renderer.sync(player, combat, elapsed, yaw, pitch); renderer.render();
    if (state === 'playing') {
      const data = { ...resultData(), stats, loadout, lock: combat.lock, fireControl: combat.fireControl,
        sector: world.sectorAt(player.position), time: elapsed, width, height, world,
        project: position => renderer.project(position, width, height),
        feedback: combat.feedbackUntil > elapsed ? combat.lastFeedback : player.feedbackUntil > elapsed ? player.lastFeedback : '', fps, cameraYaw: yaw };
      ui.renderHUD(data);
    }
  }
  if (++frameCounter % 30 === 0 && wallDt > 0) fps = Math.round(1 / wallDt);
  requestAnimationFrame(frame);
}

window.AK2_BENCH = Object.freeze({ getSnapshot() {
  if (!player || !combat) return null;
  const combatState = combat.snapshot();
  const snapshot = {
    version: 'AK2-1.2-candidate', seed, state, elapsedSeconds: elapsed, loadout: { ...loadout },
    player: { position: player.position.toArray(), velocity: player.velocity.toArray(), grounded: player.grounded,
      hp: player.hp, en: player.en, weapon: player.weapon, ammo: { ...player.ammo }, movement: { ...player.movement } },
    effectiveStats: { ...stats }, ...combatState, objective: objective(),
    stage: { sectorCount: world.sectors.length, currentSectorId: world.sectorAt(player.position)?.id || null, visitedSectorIds: [...visited], totalEnemies: 45 },
  };
  return JSON.parse(JSON.stringify(snapshot));
} });
