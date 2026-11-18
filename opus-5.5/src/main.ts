// エントリーポイント：状態遷移（格納庫/プレイ中/一時停止/クリア/失敗）、ポインターロック、メインループ。
import './style.css';
import { CAMERA, DEFAULT_LOADOUT, DEFAULT_SEED, type Loadout } from './config';
import { InputManager } from './input';
import { GameRenderer } from './render/renderer';
import { parseSeed } from './rng';
import { Game, type GameState, type Snapshot } from './sim/game';
import { FixedStepper } from './sim/loop';
import { Hud } from './ui/hud';
import { Screens } from './ui/screens';

declare global {
  interface Window {
    __AK2__: { getSnapshot: () => Snapshot };
  }
}

const canvas = document.getElementById('view') as HTMLCanvasElement;
const seed = parseSeed(window.location.search, DEFAULT_SEED);

// シミュレーションは同期的に構築し、評価用インターフェースを読み込み直後から利用可能にする
const game = new Game({ seed });
game.setLoadout(DEFAULT_LOADOUT);
// 評価用の読み取り専用インターフェース（毎回コピーを返す）
Object.defineProperty(window, '__AK2__', {
  value: Object.freeze({ getSnapshot: () => game.getSnapshot() }),
  writable: false,
  configurable: false,
});

// 描画側の構築は読み込み表示を一度描画してから行う
requestAnimationFrame(() => setTimeout(boot, 0));

function boot() {
  const renderer = new GameRenderer(canvas, game);
  const input = new InputManager();
  input.attach(canvas);
  const hud = new Hud();
  const screens = new Screens(DEFAULT_LOADOUT, seed);
  const stepper = new FixedStepper();

  let pending: 'sortie' | 'resume' | null = null;
  let firingVisual = false;

  const resize = () => {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    renderer.resize(w, h);
    game.viewport = { w, h };
    if (game.state === 'garage') screens.updateStats();
  };
  window.addEventListener('resize', resize);
  resize();

  screens.onLoadoutChange = (l: Loadout) => {
    game.setLoadout(l);
    renderer.setLegs(l.legs);
  };

  const isLocked = () => document.pointerLockElement === canvas;

  function requestLock(action: 'sortie' | 'resume') {
    pending = action;
    screens.hideLockFail();
    screens.setPending(true);
    try {
      const r = canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      if (r && typeof (r as Promise<void>).catch === 'function') {
        (r as Promise<void>).catch((err: unknown) => onLockError(err instanceof Error ? err.message : String(err)));
      }
    } catch (err) {
      onLockError(err instanceof Error ? err.message : String(err));
    }
  }

  function onLockError(msg: string) {
    if (!pending) return;
    screens.setPending(false);
    screens.showLockFail(`ポインターロックの取得に失敗しました（${msg || '理由不明'}）。`);
  }

  function beginPlaying() {
    const action = pending;
    pending = null;
    screens.setPending(false);
    if (action === 'sortie') {
      const l = screens.getLoadout();
      renderer.setLegs(l.legs);
      game.sortie(l);
      renderer.resetForSortie();
      hud.reset();
    } else if (action === 'resume') {
      if (game.state !== 'paused') return;
      game.state = 'playing';
    } else return;
    input.clearAll();
    input.enabled = true;
    stepper.reset();
    screens.hideAll();
    hud.root.classList.remove('hidden');
  }

  function pause() {
    if (game.state !== 'playing') return;
    game.state = 'paused';
    input.enabled = false;
    input.clearAll();
    stepper.reset();
    screens.showPause();
    if (isLocked()) document.exitPointerLock();
  }

  function endMission() {
    input.enabled = false;
    input.clearAll();
    if (isLocked()) document.exitPointerLock();
    screens.showResult(game);
  }

  function toGarage() {
    game.toGarage();
    input.enabled = false;
    input.clearAll();
    hud.root.classList.add('hidden');
    renderer.effects.clear();
    screens.showGarage();
    if (isLocked()) document.exitPointerLock();
  }

  document.addEventListener('pointerlockchange', () => {
    if (isLocked()) {
      if (pending) beginPlaying();
    } else if (game.state === 'playing') {
      pause();
    }
  });
  document.addEventListener('pointerlockerror', () => onLockError('pointerlockerror'));
  input.onEscape = () => pause();
  window.addEventListener('blur', () => pause());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pause();
  });
  window.addEventListener('beforeunload', (e) => {
    // 左Ctrl＋W などによる誤ったタブ終了を防ぐ
    if (game.state === 'playing' || game.state === 'paused') {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  document.getElementById('btn-sortie')!.addEventListener('click', () => requestLock('sortie'));
  document.getElementById('btn-resume')!.addEventListener('click', () => requestLock('resume'));
  document.getElementById('btn-restart')!.addEventListener('click', () => requestLock('sortie'));
  document.getElementById('btn-retry')!.addEventListener('click', () => requestLock('sortie'));
  document.getElementById('btn-garage')!.addEventListener('click', toGarage);
  document.getElementById('btn-result-garage')!.addEventListener('click', toGarage);
  document.getElementById('btn-lock-retry')!.addEventListener('click', () => requestLock(pending ?? (game.state === 'paused' ? 'resume' : 'sortie')));
  document.getElementById('btn-lock-cancel')!.addEventListener('click', () => {
    pending = null;
    screens.setPending(false);
    screens.hideLockFail();
  });

  document.getElementById('loading')!.classList.add('hidden');

  // ---- メインループ（1つだけ。再出撃でも増えない）
  let last = performance.now();
  const frame = (t: number) => {
    const realDt = Math.max(0, (t - last) / 1000);
    last = t;
    const frameDt = Math.min(realDt, 0.1);
    if (game.state === 'playing') {
      const [mx, my] = input.takeMouse();
      game.setLook(game.yaw - mx * CAMERA.mouseSensitivity, game.pitch - my * CAMERA.mouseSensitivity);
      const n = stepper.advance(realDt);
      for (let i = 0; i < n && game.state === 'playing'; i++) game.step(input.stepInput());
      if (n === 0) game.computeAim();
      firingVisual = input.fireHeld;
      renderer.handleEvents(game.events);
      hud.handleEvents(game.events, game);
      game.events = [];
      const after = game.state as GameState;
      if (after === 'cleared' || after === 'failed') endMission();
    }
    if (game.state === 'garage') {
      renderer.renderGarage(frameDt);
    } else {
      const paused = game.state !== 'playing';
      renderer.renderGame(frameDt, paused, firingVisual && !paused);
      hud.update(game, paused ? 0 : frameDt, firingVisual);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
