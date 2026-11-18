// Entry point: app state machine, input capture, fixed-step loop.

import { PARAMS, effectiveStats } from './core/params.js';
import { buildStage } from './core/stageDef.js';
import { Game } from './core/game.js';
import { Renderer } from './render/scene.js';
import { Hud } from './ui/hud.js';

const SIM_DT = PARAMS.simDt;
const WEAPONS = PARAMS.weaponOrder;

const $ = id => document.getElementById(id);
const overlays = { title: $('title'), garage: $('garage'), pause: $('pause'), result: $('result') };
const hudEl = $('hud');

const stage = buildStage();
const renderer = new Renderer($('app'));
renderer.setStage(stage);
const hud = new Hud(document.body);

let mode = 'title';           // title | garage | playing | pause | result
let game = null;
let view = null;
let accumulator = 0;
let lastT = performance.now();
let loadout = { fcs: 'medium', generator: 'balanced', legs: 'biped' };
let camYawGlobal = 0;

// ---------- input ----------
const keys = new Set();
const mouse = { dx: 0, dy: 0, fire: false };
let spaceHeldFor = 0;
let spaceEdge = false, qbEdge = false, shiftEdge = false;
const edgeQueue = { space: false, qb: false, shift: false };

window.addEventListener('keydown', e => {
  if (e.repeat) return;
  keys.add(e.code);
  if (e.code === 'Space') { edgeQueue.space = true; e.preventDefault(); }
  if (e.code === 'KeyQ') edgeQueue.qb = true;
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') edgeQueue.shift = true;
  if (e.code === 'Escape' && (mode === 'playing' || mode === 'pause')) togglePause();
  if (mode === 'playing' && game) {
    if (e.code === 'Digit1') game.player.weapon = 'machinegun';
    if (e.code === 'Digit2') game.player.weapon = 'beam';
    if (e.code === 'Digit3') game.player.weapon = 'missile';
  }
});
window.addEventListener('keyup', e => keys.delete(e.code));
window.addEventListener('mousedown', e => { if (e.button === 0) mouse.fire = true; });
window.addEventListener('mouseup', e => { if (e.button === 0) mouse.fire = false; });
document.addEventListener('mousemove', e => {
  if (document.pointerLockElement) { mouse.dx += e.movementX; mouse.dy += e.movementY; }
});
document.addEventListener('pointerlockchange', () => {
  if (!document.pointerLockElement && mode === 'playing') setPause(true);
});
window.addEventListener('resize', () => renderer.resize());

function buildInput(view, dt) {
  // WASD -> camera-relative wish direction (camera yaw only, XZ plane)
  const y = renderer.camYaw;
  const f = [Math.sin(y), Math.cos(y)], r = [Math.cos(y), -Math.sin(y)];
  let mx = 0, mz = 0;
  if (keys.has('KeyW')) { mx += f[0]; mz += f[1]; }
  if (keys.has('KeyS')) { mx -= f[0]; mz -= f[1]; }
  if (keys.has('KeyD')) { mx += r[0]; mz += r[1]; }
  if (keys.has('KeyA')) { mx -= r[0]; mz -= r[1]; }
  const move = (mx !== 0 || mz !== 0) ? [mx, mz] : null;
  spaceHeldFor = keys.has('Space') ? spaceHeldFor + dt : 0;
  spaceEdge = edgeQueue.space; qbEdge = edgeQueue.qb; shiftEdge = edgeQueue.shift;
  edgeQueue.space = edgeQueue.qb = edgeQueue.shift = false;
  return {
    move, camForwardXZ: f,
    spaceEdge, spaceHeld: keys.has('Space'), spaceHeldFor,
    qbEdge, shiftEdge,
    brakeHeld: keys.has('KeyC') || keys.has('ControlLeft'),
    fireHeld: mouse.fire,
    view,
  };
}

// ---------- state transitions ----------
function show(name) {
  for (const k in overlays) overlays[k].classList.toggle('visible', k === name);
  hudEl.style.display = name === null ? 'block' : 'none';
}

function startGame() {
  game = new Game(stage, { ...loadout }, (Math.random() * 0xffffffff) >>> 0);
  window.__ak2 = { game, renderer, stage };
  renderer.setPlayerModel(loadout.legs);
  renderer.syncEnemies(game.enemies);
  accumulator = 0;
  mode = 'playing';
  show(null);
  renderer.renderer.domElement.requestPointerLock?.();
  hud.setMessage('MISSION START — DESTROY CONTROL TURRETS');
}

function setPause(on) {
  if (on && mode === 'playing') {
    mode = 'pause'; show('pause');
    document.exitPointerLock?.();
  } else if (!on && mode === 'pause') {
    mode = 'playing'; show(null);
    renderer.renderer.domElement.requestPointerLock?.();
  }
}
function togglePause() { setPause(mode === 'playing'); }

function endGame(result) {
  mode = 'result';
  const t = $('resultTitle'), s2 = $('resultSub');
  if (result === 'cleared') {
    t.textContent = 'MISSION CLEAR'; t.className = 'clear';
    s2.textContent = `Escaped in ${game.now.toFixed(1)}s — the factory is behind you.`;
  } else {
    t.textContent = 'UNIT LOST'; t.className = 'fail';
    s2.textContent = `Destroyed at ${game.now.toFixed(1)}s. Redeploy and try another route.`;
  }
  document.exitPointerLock?.();
  setTimeout(() => { if (mode === 'result') show('result'); }, 600);
}

// ---------- garage ----------
function buildGarage() {
  const cols = { fcs: $('colFcs'), generator: $('colGen'), legs: $('colLegs') };
  const sets = { fcs: PARAMS.fcs, generator: PARAMS.generators, legs: PARAMS.legs };
  cols.fcs.innerHTML = cols.generator.innerHTML = cols.legs.innerHTML = '';
  for (const group of ['fcs', 'generator', 'legs']) {
    for (const key of Object.keys(sets[group])) {
      if (key === 'lockRange') continue;
      const spec = sets[group][key];
      const d = document.createElement('div');
      d.className = 'part' + (loadout[group] === key ? ' sel' : '');
      d.innerHTML = `<b>${spec.name}</b><span>+ ${spec.pros}</span><br><span>− ${spec.cons}</span>`;
      d.onclick = () => { loadout[group] = key; buildGarage(); };
      cols[group].appendChild(d);
    }
  }
  const st = effectiveStats(loadout);
  $('statsLine').textContent =
    `EN ${st.maxEn} · REGEN ${st.regenPerSecond.toFixed(1)}/s · LOCK ${st.lockSeconds.toFixed(2)}s · SPEED ×${st.horizontalSpeedMultiplier}`;
}

// ---------- buttons ----------
$('btnStart').onclick = () => { mode = 'garage'; buildGarage(); show('garage'); };
$('btnDeploy').onclick = () => startGame();
$('btnResume').onclick = () => setPause(false);
$('btnRetry').onclick = () => startGame();
$('btnQuit').onclick = () => { mode = 'garage'; buildGarage(); show('garage'); };
$('btnAgain').onclick = () => startGame();
$('btnGarage2').onclick = () => { mode = 'garage'; buildGarage(); show('garage'); };
renderer.renderer.domElement.addEventListener('click', () => {
  if (mode === 'playing' && !document.pointerLockElement) {
    renderer.renderer.domElement.requestPointerLock?.();
  }
});

// ---------- event -> HUD/effects ----------
function consumeEvents() {
  for (const ev of game.events) {
    switch (ev.type) {
      case 'barrierOpen': hud.setMessage(`BARRIER OPEN — ${ev.label}`, '#7dff8a'); break;
      case 'gateOpen': hud.setMessage('FINAL GATE OPEN — ESCAPE!', '#7dff8a'); break;
      case 'fcsUnlock': hud.setMessage('FCS MODULE ACQUIRED — LOCK-ON ONLINE', '#9fe8ff'); break;
      case 'enemyDown': renderer.effects.explosion(ev.at, true); break;
      case 'impact': renderer.effects.impact(ev.at); break;
      case 'explosion': renderer.effects.explosion(ev.at, ev.big); break;
      case 'shot': renderer.muzzleFlash = 0.05; break;
      case 'deny': break; // HUD deny line reads from game state
      case 'playerHit': break;
    }
  }
  game.events.length = 0;
}

// ---------- main loop ----------
renderer.resize();
show('title');

function frame(now) {
  requestAnimationFrame(frame);
  let dt = (now - lastT) / 1000;
  lastT = now;
  if (dt > PARAMS.maxFrameDt) dt = PARAMS.maxFrameDt;

  if (mode === 'playing' && game) {
    // camera first (produces the view used by sim + HUD)
    view = renderer.updateCamera(game.player, stage.world, dt, mouse);
    mouse.dx = mouse.dy = 0;
    camYawGlobal = renderer.camYaw;
    const input = buildInput(view, dt);
    game.player.yaw = renderer.camYaw;
    accumulator += dt;
    let steps = 0;
    while (accumulator >= SIM_DT && steps < 24) {
      const stepInput = steps === 0 ? input : { ...input, spaceEdge: false, qbEdge: false, shiftEdge: false, spaceHeldFor: input.spaceHeldFor };
      game.step(stepInput);
      accumulator -= SIM_DT; steps++;
      if (game.state !== 'playing') break;
    }
    consumeEvents();
    renderer.updatePlayer(game.player, dt);
    renderer.syncEnemies(game.enemies);
    renderer.projView.update(game.projectiles);
    renderer.effects.update(dt);
    hud.update(game, view, camYawGlobal, dt);
    for (const id in renderer.barrierMeshes) {
      const b = game.stage.barriers.find(x => x.id === id);
      renderer.barrierMeshes[id].visible = b && !b.open;
    }
    if (game.state !== 'playing') endGame(game.state);
  } else {
    mouse.dx = mouse.dy = 0;
  }
  renderer.render();
}
requestAnimationFrame(frame);
