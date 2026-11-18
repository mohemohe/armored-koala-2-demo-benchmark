import './style.css';
import { Game } from './game.js';
import { GameRenderer } from './render.js';
import { STAGE } from './stage.js';
import { effectiveStats, FCS } from './config.js';

const $ = id => document.getElementById(id);
const show = (id, visible) => $(id)?.classList.toggle('hidden', !visible);
const put = (id, text) => { const element = $(id); if (element) element.textContent = text; };
const rawSeed = new URLSearchParams(location.search).get('seed');
const seed = rawSeed !== null && /^\d+$/.test(rawSeed) && Number(rawSeed) <= 4294967295 ? Number(rawSeed) >>> 0 : 20260908;
const canvas = $('game-canvas');
let renderer;
try { renderer = new GameRenderer(canvas, STAGE); }
catch (error) { document.body.innerHTML = `<div style="padding:4rem;color:#e8efdf;background:#14221f;font-family:monospace"><h1>AK2 / GRAPHICS UNAVAILABLE</h1><p>WebGL を有効にして再読み込みしてください。</p><p>${String(error.message).replaceAll('<','&lt;')}</p></div>`; throw error; }
const game = new Game({ seed, cameraProvider: g => renderer.getCameraInfo(g), muzzleProvider: g => renderer.getMuzzle(g) });
renderer.setLoadout(game.loadout);
Object.defineProperty(window, 'AK2_BENCH', { value: Object.freeze({ getSnapshot: () => game.snapshot() }), writable: false, configurable: false });

const keys = new Set(), blockedUntilRelease = new Set();
let edges = { qbPressed: false, glidePressed: false, jumpPressed: false }, fireHeld = false, spaceStartedAt = null;
let previousFrame = performance.now(), accumulator = 0, pendingReset = false;
let lastSoundShot = 0, audioContext = null;
function clearInput() {
  for (const key of keys) blockedUntilRelease.add(key);
  keys.clear();
  edges = { qbPressed: false, glidePressed: false, jumpPressed: false };
  fireHeld = false;
  spaceStartedAt = null;
}
function playSound(kind) {
  if (!audioContext || audioContext.state !== 'running') return;
  const oscillator = audioContext.createOscillator(), gain = audioContext.createGain();
  oscillator.type = kind === 'beam' ? 'sine' : kind === 'missile' ? 'sawtooth' : 'triangle';
  const now = audioContext.currentTime;
  oscillator.frequency.setValueAtTime(kind === 'beam' ? 850 : kind === 'missile' ? 180 : 140, now);
  oscillator.frequency.exponentialRampToValueAtTime(45, now + .13);
  gain.gain.setValueAtTime(.065, now);
  gain.gain.exponentialRampToValueAtTime(.0001, now + .14);
  oscillator.connect(gain).connect(audioContext.destination);
  oscillator.start(now); oscillator.stop(now + .15);
}
function openAudio() {
  try { audioContext ??= new (window.AudioContext || window.webkitAudioContext)(); audioContext.resume(); } catch { /* Audio is optional. */ }
}
function syncScreens() {
  show('garage', game.state === 'garage');
  show('hud', game.state !== 'garage');
  show('pause-screen', game.state === 'paused');
  show('result-screen', game.state === 'cleared' || game.state === 'failed');
  document.body.dataset.state = game.state;
  if (game.state === 'cleared' || game.state === 'failed') {
    put('result-title', game.state === 'cleared' ? 'EXTRACTION COMPLETE' : 'SIGNAL LOST');
    put('result-detail', `${game.state === 'cleared' ? '工場からの脱出に成功しました。' : '機体が停止しました。構成と経路を見直し、再出撃してください。'}  ${formatTime(game.elapsedSeconds)} / 制御砲台 ${game.objective.controlsDestroyed}/6 / 撃破 ${game.enemies.filter(e => !e.alive).length}/45`);
  }
}
function pause() {
  if (game.state !== 'playing') return;
  game.state = 'paused'; clearInput(); accumulator = 0;
  if (document.pointerLockElement) document.exitPointerLock();
  syncScreens();
}
function garage() {
  if (document.pointerLockElement) document.exitPointerLock();
  show('pointer-lock-error', false);
  clearInput(); game.state = 'garage'; game.reset(); pendingReset = false;
  renderer.setLoadout(game.loadout); updateGarage(); syncScreens();
}
async function requestPlay(reset) {
  if (reset) { game.reset(); lastSoundShot = 0; pendingReset = true; renderer.setLoadout(game.loadout); }
  clearInput();
  put('pointer-lock-error', '');
  show('pointer-lock-error', false);
  openAudio();
  try {
    if (!canvas.requestPointerLock) throw new Error('Pointer Lock unavailable');
    await canvas.requestPointerLock();
    if (document.pointerLockElement !== canvas) {
      game.state = 'paused'; syncScreens();
    }
  } catch (error) {
    console.warn('AK2 Pointer Lock:', error?.name ?? 'Error', error?.message ?? 'Unavailable');
    game.state = 'paused'; pendingReset = false; syncScreens();
    put('pointer-lock-error', 'ポインターロックを取得できませんでした。画面をクリックして「再開」を選び、ブラウザーの許可を確認してください。');
    show('pointer-lock-error', true);
  }
}
$('launch')?.addEventListener('click', () => requestPlay(true));
$('resume')?.addEventListener('click', () => requestPlay(false));
$('restart')?.addEventListener('click', () => requestPlay(true));
$('retry')?.addEventListener('click', () => requestPlay(true));
$('garage-return')?.addEventListener('click', garage);
$('return')?.addEventListener('click', garage);
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement === canvas) {
    game.state = 'playing'; pendingReset = false; clearInput(); previousFrame = performance.now(); accumulator = 0; syncScreens();
  } else pause();
});
document.addEventListener('pointerlockerror', () => {
  if (game.state === 'garage') game.state = 'paused';
  pause(); syncScreens(); put('pointer-lock-error', 'ポインターロックを許可して「再開」を押してください。');
  show('pointer-lock-error', true);
});
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
window.addEventListener('blur', pause);
window.addEventListener('keydown', event => {
  const code = event.code;
  if (['Space','ShiftLeft','ShiftRight','ControlLeft','KeyQ','KeyW','KeyA','KeyS','KeyD','Digit1','Digit2','Digit3','Escape'].includes(code)) event.preventDefault();
  if (code === 'Escape') { show('help-panel', false); show('mission-panel', false); pause(); return; }
  if (game.state !== 'playing' || event.repeat || keys.has(code) || blockedUntilRelease.has(code)) return;
  keys.add(code);
  if (code === 'KeyQ' && !keys.has('ControlLeft')) edges.qbPressed = true;
  if ((code === 'ShiftLeft' || code === 'ShiftRight') && game.player.movement.qbImpulseRemainingSeconds <= 0) edges.glidePressed = true;
  if (code === 'Space') { edges.jumpPressed = true; spaceStartedAt = game.elapsedSeconds; }
  const weapon = { Digit1: 'machinegun', Digit2: 'beam', Digit3: 'missile' }[code];
  if (weapon) game.switchWeapon(weapon);
});
window.addEventListener('keyup', event => { keys.delete(event.code); blockedUntilRelease.delete(event.code); if (event.code === 'Space') spaceStartedAt = null; });
window.addEventListener('mousemove', event => {
  if (game.state !== 'playing' || document.pointerLockElement !== canvas) return;
  game.yaw += event.movementX * .0023;
  game.pitch = Math.max(-1.22, Math.min(1.10, game.pitch - event.movementY * .0023));
});
canvas.addEventListener('mousedown', event => { if (event.button === 0 && game.state === 'playing' && document.pointerLockElement === canvas) fireHeld = true; });
window.addEventListener('mouseup', event => { if (event.button === 0) fireHeld = false; });
canvas.addEventListener('contextmenu', event => event.preventDefault());
document.querySelectorAll('[data-weapon]').forEach(button => button.addEventListener('click', () => { if (game.state === 'playing') game.switchWeapon(button.dataset.weapon); }));
document.querySelectorAll('[data-part]').forEach(button => button.addEventListener('click', () => {
  if (game.state !== 'garage') return;
  game.loadout[button.dataset.part] = button.dataset.value;
  game.reset(); renderer.setLoadout(game.loadout); updateGarage();
}));
function togglePanel(id) { show(id, $(id)?.classList.contains('hidden')); }
$('help-toggle')?.addEventListener('click', () => togglePanel('help-panel'));
$('help-close')?.addEventListener('click', () => show('help-panel', false));
$('pause-help')?.addEventListener('click', () => show('help-panel', true));
$('mission-toggle')?.addEventListener('click', () => togglePanel('mission-panel'));
$('mission-close')?.addEventListener('click', () => show('mission-panel', false));
$('garage-tab')?.addEventListener('click', () => { show('mission-panel', false); show('help-panel', false); });
function updateGarage() {
  const stats = effectiveStats(game.loadout);
  document.querySelectorAll('[data-part]').forEach(button => {
    const active = game.loadout[button.dataset.part] === button.dataset.value;
    button.classList.toggle('selected', active); button.setAttribute('aria-pressed', String(active));
  });
  put('stat-en', stats.maxEn); put('stat-regen', stats.regenPerSecond.toFixed(2));
  put('stat-lock', stats.lockSeconds.toFixed(3)); put('stat-speed', (10 * stats.horizontalSpeedMultiplier).toFixed(1));
  put('stats-glide', (22 * stats.horizontalSpeedMultiplier).toFixed(1));
  put('garage-leg-name', game.loadout.legs === 'biped' ? 'BIPED / 02' : 'QUADRUPED / 04');
}
function formatTime(time) { return `${String(Math.floor(time / 60)).padStart(2,'0')}:${String(Math.floor(time % 60)).padStart(2,'0')}`; }
function marker(id, point, label, camera) {
  const element = $(id); if (!element) return;
  if (!point) { element.classList.add('hidden'); return; }
  const projected = camera.project(point);
  const margin = 35;
  element.style.left = `${Math.max(margin, Math.min(camera.width - margin, projected.x))}px`;
  element.style.top = `${Math.max(100, Math.min(camera.height - 80, projected.y))}px`;
  element.classList.toggle('offscreen', projected.depth <= 0 || projected.x < 0 || projected.y < 0 || projected.x > camera.width || projected.y > camera.height);
  element.classList.remove('hidden');
  element.dataset.label = label;
  const span = element.querySelector(id === 'objective-marker' ? 'small' : 'span'); if (span) span.textContent = label;
}
function updateHud() {
  if (game.state === 'garage') return;
  const p = game.player, movement = p.movement, camera = game.cameraInfo();
  const sector = STAGE.sectors.find(s => s.id === game.currentSectorId);
  put('sector-name', sector?.name ?? 'EXTRACTION BAY'); put('sector-id', game.currentSectorId ?? 'EXIT');
  put('mission-time', formatTime(game.elapsedSeconds));
  put('controls-count', `${game.objective.controlsDestroyed} / 6`);
  const nextControl = game.enemies.find(e => e.isGateControl && e.alive);
  const nextSector = STAGE.sectors.find(s => s.id === nextControl?.sectorId);
  put('objective-text', nextControl ? `制御砲台 ${nextControl.id} を破壊 / ${nextSector?.name ?? nextControl.sectorId}` : '搬出ゲート開放 / 脱出領域へ進め');
  const name = { machinegun: '01 / MACHINE GUN', beam: '02 / PULSE BEAM', missile: '03 / HAND MISSILE' }[p.weapon];
  put('weapon-name', name); put('ammo', p.weapon === 'beam' ? '∞' : String(p.ammo[p.weapon]).padStart(3,'0'));
  put('weapon-cost', p.weapon === 'beam' ? 'UNLIMITED / 8 EN PER SHOT' : p.weapon === 'machinegun' ? '12 DMG / ROUND' : '180 DMG / ROUND');
  document.querySelectorAll('[data-weapon]').forEach(button => button.classList.toggle('selected', button.dataset.weapon === p.weapon));
  put('en-value', p.en.toFixed(0)); put('en-max', game.stats.maxEn);
  if ($('en-fill')) $('en-fill').style.width = `${100 * p.en / game.stats.maxEn}%`;
  put('hp-value', Math.ceil(p.hp));
  if ($('hp-fill')) $('hp-fill').style.width = `${p.hp / 10}%`;
  put('movement-mode', `${movement.horizontalMode.toUpperCase()} / ${movement.verticalMode.toUpperCase()}`);
  const qb = movement.qbCooldownRemainingSeconds;
  put('qb-status', qb > .001 ? `QB ${qb.toFixed(2)}s` : keys.has('ControlLeft') ? 'QB / BRAKE ACTIVE' : p.en < 36 ? 'QB / EN < 36' : 'QB READY / 36 EN');
  put('speed-value', `${Math.hypot(p.velocity[0], p.velocity[2]).toFixed(1)} m/s`);
  put('lock-status', game.lock.state === 'locked' ? 'LOCK COMPLETE' : game.lock.state === 'acquiring' ? `ACQUIRING ${Math.floor(game.lock.progress * 100)}%` : 'SEARCHING');
  if ($('lock-progress')) $('lock-progress').style.width = `${game.lock.progress * 100}%`;
  if ($('fcs-circle')) { $('fcs-circle').style.width = `${game.lock.radiusCssPx * 2}px`; $('fcs-circle').style.height = `${game.lock.radiusCssPx * 2}px`; $('fcs-circle').dataset.lock = game.lock.state; }
  const target = game.enemies.find(e => e.id === game.lock.targetId);
  marker('target-marker', target?.alive ? target.position : null, target ? `${target.id} / HP ${target.hp}` : '', camera);
  marker('aim-marker', game.fireControl.aimPoint, game.fireControl.status === 'solved' ? 'FCS CORRECTED' : 'NO SOLUTION', camera);
  $('aim-marker')?.classList.toggle('no-solution', game.fireControl.status === 'no_solution');
  $('target-marker')?.classList.toggle('locked', game.lock.state === 'locked');
  let waypoint = nextControl?.sectorId === sector?.id ? nextControl.position : sector?.exit ?? [2425,18.1,0];
  if (sector?.shelter && p.position[0] < sector.shelter.max[0] + 3 && p.position[2] < sector.shelter.max[2] + 3) waypoint = sector.shelter.exit;
  marker('objective-marker', waypoint, nextControl?.sectorId === sector?.id ? `CONTROL / ${nextControl.id}` : 'NEXT SECTOR →', camera);
  put('target-info', game.fireControl.status === 'solved' ? `AUTO LEAD + ${p.weapon === 'machinegun' ? 'GRAVITY' : p.weapon === 'beam' ? 'INSTANT' : 'GUIDANCE'}` : game.fireControl.status === 'no_solution' ? '補正解なし / DIRECT AIM' : '対象をFCS円内に保持');
  put('event-message', game.messageUntil > game.elapsedSeconds ? game.message : '');
  if ($('damage-direction')) { show('damage-direction', game.damageUntil > game.elapsedSeconds); $('damage-direction').style.transform = `translate(-50%, -50%) rotate(${-(game.damageAngle ?? 0) + Math.PI / 2}rad)`; }
  drawRadar();
}
function drawRadar() {
  const radar = $('radar'); if (!radar) return;
  const ctx = radar.getContext('2d'), width = radar.width, height = radar.height;
  ctx.clearRect(0,0,width,height);
  const sector = STAGE.sectors.find(s => s.id === game.currentSectorId);
  if (!sector) return;
  const min = sector.bounds.min, max = sector.bounds.max, pad = 13;
  const scale = Math.min((width-2*pad)/(max[0]-min[0]),(height-2*pad)/(max[2]-min[2]));
  const project = point => [pad+(point[0]-min[0])*scale,pad+(point[2]-min[2])*scale];
  ctx.strokeStyle='#77998b'; ctx.lineWidth=1; ctx.strokeRect(pad,pad,(max[0]-min[0])*scale,(max[2]-min[2])*scale);
  ctx.fillStyle='#425b50';
  for(const box of game.world.getBoxes()) if(box.sectorId===sector.id && ['machine','machinery','equipment','cover','barrier'].includes(box.kind)) { const a=project(box.min),b=project(box.max);ctx.fillRect(a[0],a[1],b[0]-a[0],b[1]-a[1]); }
  for(const enemy of game.enemies) if(enemy.alive && enemy.sectorId===sector.id) { const [x,y]=project(enemy.position);ctx.fillStyle=enemy.isGateControl?'#ffc977':'#ed785f';ctx.fillRect(x-2.5,y-2.5,5,5); }
  const [x,y]=project(game.player.position);ctx.fillStyle='#c9efda';ctx.beginPath();ctx.arc(x,y,3,0,Math.PI*2);ctx.fill();
  ctx.strokeStyle='#c9efda';ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x+Math.cos(game.yaw)*9,y+Math.sin(game.yaw)*9);ctx.stroke();
}
function resize() {
  renderer.resize(window.innerWidth, window.innerHeight);
  game.lock.radiusCssPx = Math.min(window.innerWidth, window.innerHeight) * FCS[game.loadout.fcs].radiusRatio;
  if (game.state === 'playing' || game.state === 'garage') game.refreshFireControl();
}
window.addEventListener('resize', resize);
function frame(now) {
  const elapsed = Math.max(0,(now - previousFrame) / 1000); previousFrame = now;
  if (game.state === 'playing') {
    const forward = [Math.cos(game.yaw), Math.sin(game.yaw)], right = [-forward[1], forward[0]];
    const up = Number(keys.has('KeyW')) - Number(keys.has('KeyS')), sideways = Number(keys.has('KeyD')) - Number(keys.has('KeyA'));
    const direction = [forward[0]*up+right[0]*sideways,forward[1]*up+right[1]*sideways];
    game.advance(elapsed, { ...edges, direction, cameraForward: forward, brake: keys.has('ControlLeft'), spaceHeld: keys.has('Space'), spaceHeldSeconds: spaceStartedAt === null ? 0 : game.elapsedSeconds - spaceStartedAt, fireHeld });
    edges = { qbPressed:false,glidePressed:false,jumpPressed:false };
    if (game.shotId !== lastSoundShot) { lastSoundShot = game.shotId; playSound(game.player.weapon); }
    if (game.state !== 'playing') { clearInput(); if(document.pointerLockElement) document.exitPointerLock(); syncScreens(); }
  }
  renderer.render(game, elapsed);
  updateHud();
  requestAnimationFrame(frame);
}
updateGarage(); syncScreens(); resize(); requestAnimationFrame(frame);
