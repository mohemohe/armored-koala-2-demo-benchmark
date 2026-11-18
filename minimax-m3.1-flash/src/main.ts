import './style.css';
import { Game, type GameState } from './game/game';
import { Garage, type GarageChoice } from './ui/garage';

const canvas = document.getElementById('viewport') as HTMLCanvasElement;
const uiRoot = document.getElementById('ui-root') as HTMLDivElement;

const game = new Game(canvas, uiRoot);

/* ------------------------------------------------------------------ */
/* help panel                                                          */
/* ------------------------------------------------------------------ */

const help = document.createElement('div');
help.id = 'help-panel';
help.className = 'hidden';
help.innerHTML = `
  <h2>AK2 CONTROLS</h2>
  <div style="color:var(--ak2-dim);font-size:12px">
    Keep the target hit-box inside the central FCS circle and the fire control system compensates
    lead angle and bullet drop automatically - the crosshair never has to be placed on the corrected
    marker by hand. EN may be 0 and gliding still works.
  </div>
  <h3>MOVEMENT</h3>
  <table>
    <tr><td><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></td><td>Camera relative movement (diagonal input does not raise the speed).</td></tr>
    <tr><td><kbd>Space</kbd></td><td>On ground: jump (10 m/s initial). Hold 0.20 s: flight (16 m/s horizontal, 8 m/s climb, 20 EN/s).</td></tr>
    <tr><td><kbd>Shift</kbd></td><td>Toggle glide manually. Costs 0 EN and keeps running after release.</td></tr>
    <tr><td><kbd>Ctrl</kbd></td><td>Brake. Cancels the glide and decelerates the horizontal velocity to zero.</td></tr>
    <tr><td><kbd>Q</kbd></td><td>Quick boost. One shot, 36 EN paid at once, 0.15 s burn, then it falls back into an automatic glide (glide itself is free).</td></tr>
  </table>
  <h3>COMBAT</h3>
  <table>
    <tr><td><kbd>LMB</kbd></td><td>Fire (hold for automatic fire). 1: machinegun / 2: beam / 3: hand missile.</td></tr>
    <tr><td>Machinegun</td><td>12 damage / 0.10 s / 300 rounds / gravity. Locked fire corrects lead and gravity together.</td></tr>
    <tr><td>Beam</td><td>40 damage / 0.25 s / 8 EN per shot / instant 120 m line hit at the current position.</td></tr>
    <tr><td>Hand missile</td><td>180 damage / 1.00 s / 12 rounds / requires a lock. 45 m/s, 120 deg/s turn rate.</td></tr>
    <tr><td><kbd>Esc</kbd></td><td>Pause (releases the pointer lock and clears the input state).</td></tr>
  </table>
  <h3>OBJECTIVE</h3>
  <div style="font-size:12px">
    Destroy the six control turrets to open their barriers. All six open the final evacuation gate.
    Reach the evacuation zone to clear the sortie. HP reaching 0 or falling out of the plant is a failure.
    There is no natural HP regeneration and no ammunition resupply.
  </div>
  <div style="text-align:right;margin-top:14px"><button class="btn" id="help-close">CLOSE</button></div>
`;
uiRoot.appendChild(help);
(help.querySelector('#help-close') as HTMLButtonElement).addEventListener('click', () => help.classList.add('hidden'));

/* ------------------------------------------------------------------ */
/* pause / result overlays                                             */
/* ------------------------------------------------------------------ */

const overlay = document.createElement('div');
overlay.className = 'overlay hidden';
overlay.innerHTML = `
  <div class="overlay-inner" style="max-width:760px">
    <h1 class="title" id="ov-title">PAUSED</h1>
    <div class="subtitle" id="ov-sub">AK2 - MISSION SUSPENDED</div>
    <div id="ov-body" style="font-size:13px;line-height:1.7"></div>
    <div style="margin-top:18px">
      <button class="btn" id="ov-resume">RESUME</button>
      <button class="btn ghost" id="ov-help">CONTROLS</button>
      <button class="btn ghost" id="ov-garage">BACK TO HANGAR</button>
    </div>
    <div class="err" id="ov-err" style="margin-top:8px"></div>
  </div>
`;
uiRoot.appendChild(overlay);

const ovTitle = overlay.querySelector('#ov-title') as HTMLElement;
const ovSub = overlay.querySelector('#ov-sub') as HTMLElement;
const ovBody = overlay.querySelector('#ov-body') as HTMLElement;
const ovErr = overlay.querySelector('#ov-err') as HTMLElement;
const ovResume = overlay.querySelector('#ov-resume') as HTMLButtonElement;

ovResume.addEventListener('click', () => {
  ovErr.textContent = '';
  game.resume();
});
(overlay.querySelector('#ov-help') as HTMLButtonElement).addEventListener('click', () => help.classList.remove('hidden'));
(overlay.querySelector('#ov-garage') as HTMLButtonElement).addEventListener('click', () => {
  game.setState('garage');
});

/* ------------------------------------------------------------------ */
/* garage                                                              */
/* ------------------------------------------------------------------ */

const garage = new Garage(uiRoot, {
  onChange(choice: GarageChoice) {
    game.setLoadout(choice);
  },
  onStart() {
    game.startRun();
  },
  onShowHelp() {
    help.classList.remove('hidden');
  }
});

/* ------------------------------------------------------------------ */
/* state wiring                                                        */
/* ------------------------------------------------------------------ */

function refreshOverlay(state: GameState) {
  overlay.classList.toggle('hidden', state === 'playing' || state === 'garage');
  garage.show(state === 'garage');
  if (state === 'paused') {
    ovTitle.textContent = 'PAUSED';
    ovTitle.className = 'title';
    ovSub.textContent = 'AK2 - MISSION SUSPENDED';
    const snap = game.getSnapshot();
    ovBody.innerHTML = `
      <div>Elapsed <b>${snap.elapsedSeconds.toFixed(1)} s</b></div>
      <div>Current sector <b>${snap.stage.currentSectorId ?? '-'}</b> / sectors visited <b>${snap.stage.visitedSectorIds.length}</b></div>
      <div>Destroyed <b>${snap.enemies.filter((e) => !e.alive).length} / ${snap.enemies.length}</b></div>
      <div>Control turrets <b>${snap.objective.controlsDestroyed}/${snap.objective.controlsRequired}</b> - evac gate ${snap.objective.gateOpen ? 'OPEN' : 'CLOSED'}</div>
      <div style="color:var(--ak2-dim);margin-top:8px">Press RESUME to continue - the pointer lock has to be re-acquired.</div>
    `;
    ovResume.textContent = 'RESUME';
  }
}

game.onStateChange = (s) => {
  refreshOverlay(s);
  if (s === 'playing') {
    overlay.classList.add('hidden');
    help.classList.add('hidden');
  }
};
game.onResult = (cleared, stats) => {
  ovTitle.textContent = cleared ? 'EVACUATED' : 'MISSION FAILED';
  ovTitle.className = 'result-big ' + (cleared ? 'win' : 'lose');
  ovSub.textContent = cleared ? 'AK2 - EVACUATION COMPLETE' : 'AK2 - MISSION FAILED';
  const snap = game.getSnapshot();
  ovBody.innerHTML = `
    <div>${stats}</div>
    <div>Sectors visited <b>${snap.stage.visitedSectorIds.length}</b> / ${snap.stage.sectorCount}</div>
    <div>Destroyed <b>${snap.enemies.filter((e) => !e.alive).length}</b> / ${snap.enemies.length}</div>
  `;
  ovResume.textContent = 'RE-SORTIE (SAME LOADOUT)';
  ovErr.textContent = '';
  overlay.classList.remove('hidden');
  garage.show(false);
};
ovResume.addEventListener('click', () => {
  ovErr.textContent = '';
  if (game.state === 'cleared' || game.state === 'failed') {
    game.startRun();
  } else {
    game.resume();
  }
});

/* ------------------------------------------------------------------ */
/* global events                                                       */
/* ------------------------------------------------------------------ */

window.addEventListener('resize', () => game.resize());
window.addEventListener('blur', () => {
  if (game.state === 'playing') game.pause();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && game.state === 'playing') game.pause();
});
document.addEventListener('pointerlockchange', () => {
  if (!document.pointerLockElement && game.state === 'playing') game.pause();
});
canvas.addEventListener('mousedown', () => {
  if (game.state === 'paused') return;
  if (game.state === 'playing' && !document.pointerLockElement) {
    game.input.requestPointerLock();
  }
});

/* ------------------------------------------------------------------ */
/* snapshot API                                                        */
/* ------------------------------------------------------------------ */

declare global {
  interface Window {
    __AK2__: {
      getSnapshot(): unknown;
    };
  }
}
window.__AK2__ = {
  getSnapshot: () => game.getSnapshot()
};

/* ------------------------------------------------------------------ */
/* main loop                                                           */
/* ------------------------------------------------------------------ */

function loop(t: number) {
  requestAnimationFrame(loop);
  game.frame(t);
  game.render();
}
requestAnimationFrame(loop);

refreshOverlay('garage');
