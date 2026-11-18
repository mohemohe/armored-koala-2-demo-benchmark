/**
 * アプリ制御: 格納庫 -> 出撃 -> プレイ中 -> 一時停止 -> クリア/失敗 -> 再出撃/格納庫。
 * ループ(requestAnimationFrame)とイベントリスナーは start() で一度だけ登録する (再出撃で増えない)。
 */
import { Game } from '../sim/game';
import { GameRenderer } from '../render/renderer';
import { buildStage } from '../stage';
import type { Loadout } from '../sim/types';
import { HelpModal } from './controlsHelp';
import { Garage } from './garage';
import { Hud } from './hud';
import { buildResultModel } from './hudLogic';
import { InputController } from './input';
import { Screens } from './screens';
import type { LockContext } from './screens';

export interface AppElements {
  canvas: HTMLCanvasElement;
  hud: HTMLElement;
  garage: HTMLElement;
  screens: HTMLElement;
}

/** 起動時間の計測用 (tools/startup-bench.ts が読む performance.mark。計測だけの機能なので失敗しても無視する) */
const mark = (name: string): void => {
  try {
    performance.mark(name);
  } catch {
    /* 計測だけの機能 */
  }
};

/** ポインターロック要求から結果が返らないときに失敗表示へ切り替えるまでの時間 [ms] */
const LOCK_TIMEOUT_MS = 4000;

/** 敵の経路探索グリッドの事前構築 (Game.warmup): 1 回のタイマーで働く時間 [ms] と、次のタイマーまでの間隔 [ms]。合計は ~100 ms の仕事 */
const NAV_WARM_SLICE_MS = 4;
const NAV_WARM_GAP_MS = 12;
/** ...1 回の warmup() 呼び出しの仕事量 (ほぼ探索グリッドのノード数) */
const NAV_WARM_WORK = 1024;

export class App {
  readonly game: Game;
  /** 描画は最初の 1 フレームを描いて読み込み中の表示を画面に出した後に作る (ensureRenderer)。それまでは null */
  private renderer: GameRenderer | null = null;
  private hud!: Hud;
  private garage!: Garage;
  private screens!: Screens;
  private help!: HelpModal;
  private input!: InputController;
  private canvas: HTMLCanvasElement;

  private ac: AbortController | null = null;
  private raf = 0;
  private lastT: number | null = null;
  private lastMode = '';
  private pending: LockContext | null = null;
  private pendingTimer = 0;
  private lastFailed: LockContext | null = null;
  private failed = false;
  private renderTimer = 0;
  private warmTimer = 0;
  private navTimer = 0;
  /** 格納庫の描画を終えたフレーム数 (2 に達した = 最初の 1 枚が画面に出た。読み込み中の表示を消す) */
  private hangarFrames = 0;

  constructor(
    els: AppElements,
    private seed: number,
  ) {
    this.canvas = els.canvas;
    mark('ak2:app-start');
    const stage = buildStage();
    this.game = new Game({ stage, seed, viewportW: window.innerWidth, viewportH: window.innerHeight });
    mark('ak2:game');
    this.screens = new Screens(els.screens, {
      onResume: () => this.requestLock('resume'),
      onPauseToGarage: () => this.toGarage(),
      onHelp: () => this.help.open(),
      onRetrySortie: () => this.requestLock('retry'),
      onResultToGarage: () => this.toGarage(),
      onLockRetry: () => this.requestLock(this.lastFailed ?? 'sortie'),
      onLockCancel: () => {
        this.screens.hideLockError();
        this.garage.setPending(false);
      },
    });
    this.help = new HelpModal(els.screens);
    this.hud = new Hud(els.hud);
    this.garage = new Garage(els.garage, {
      loadout: this.game.getLoadout(),
      onChange: (l) => this.onLoadoutChange(l),
      onSortie: () => this.requestLock('sortie'),
      onHelp: () => this.help.open(),
    });
    this.input = new InputController({
      input: this.game.input,
      isPlaying: () => this.game.state.mode === 'playing',
      isLocked: () => document.pointerLockElement === this.canvas,
      look: (dx, dy) => this.game.look(dx, dy),
      onEscape: () => this.pauseGame('Escキーが押されました'),
    });
    this.showGarage();
    mark('ak2:app-ready');
  }

  /**
   * 3D 描画 (WebGL の初期化・格納庫・シェーダーのコンパイル) は数秒かかることがあるので、コンストラクターでは作らない。
   * 最初のフレームで「読み込み中」の表示 (index.html の #boot-loading) を先に画面に出し、その後のタスクで作る。
   * 出撃などで先に必要になったときはここで同期的に作る。WebGL を初期化できないときは失敗画面を出して例外を投げる。
   */
  private ensureRenderer(): GameRenderer {
    if (this.renderer) return this.renderer;
    window.clearTimeout(this.renderTimer);
    try {
      const r = new GameRenderer(this.canvas);
      mark('ak2:renderer');
      this.renderer = r;
      // 先に格納庫 (シェーダーのコンパイルを GPU 側で進めておき、その間に描画バッファをウィンドウの大きさへ合わせる)
      r.showHangar(this.game.getLoadout());
      mark('ak2:hangar');
      this.applyResize();
      return r;
    } catch (e) {
      this.failed = true;
      this.renderer = null;
      document.getElementById('boot-loading')?.remove();
      this.screens.showFatal(`3D描画(WebGL)を初期化できませんでした。ブラウザーのハードウェアアクセラレーション設定を確認してください。(${e instanceof Error ? e.message : String(e)})`);
      throw e;
    }
  }

  /**
   * 格納庫の最初の 1 枚が画面に出た後で、ステージの 3D (メッシュ・テクスチャ・シェーダー) を出撃前に作っておく。
   * 格納庫の表示を遅らせないよう、メッシュの生成とシェーダーのコンパイルは別のタスクに分ける。出撃が先に来たら描画側が同期的に作る。
   */
  private warmStage(): void {
    window.clearTimeout(this.warmTimer);
    this.warmTimer = window.setTimeout(() => {
      const r = this.renderer;
      if (!r || this.game.state.mode !== 'garage') return;
      r.setStage(this.game.state.stage, false);
      this.warmTimer = window.setTimeout(() => {
        if (this.renderer === r) r.compileStage();
      }, 250);
    }, 250);
  }

  /**
   * 警備ロボットの経路探索グリッドを出撃前に作っておく (出撃後の最初の tick と、その後の約 1.6 秒の引っかかりをなくす)。
   * 格納庫の描画を止めないよう、数 ms ずつ別のタスクに分ける。出撃が先に来たら beginPlay が残りを同期的に済ませる。
   */
  private warmNav(): void {
    window.clearTimeout(this.navTimer);
    const slice = (): void => {
      const t0 = performance.now();
      let done = false;
      while (!done && performance.now() - t0 < NAV_WARM_SLICE_MS) done = this.game.warmup(NAV_WARM_WORK);
      if (done) mark('ak2:nav-warm');
      else this.navTimer = window.setTimeout(slice, NAV_WARM_GAP_MS);
    };
    this.navTimer = window.setTimeout(slice, NAV_WARM_GAP_MS);
  }

  // ------------------------------------------------------------------ lifecycle
  /** リスナーと rAF ループを一度だけ開始する */
  start(): void {
    if (this.ac || this.failed) return;
    const ac = new AbortController();
    this.ac = ac;
    const sig = { signal: ac.signal } as const;
    this.input.attach(window);
    window.addEventListener('resize', () => this.applyResize(), sig);
    window.addEventListener('blur', () => this.pauseGame('ウィンドウがフォーカスを失いました'), sig);
    window.addEventListener('keydown', (e) => this.onGlobalKey(e), sig);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.pauseGame('タブが非表示になりました');
    }, sig);
    document.addEventListener('pointerlockchange', () => this.onPointerLockChange(), sig);
    document.addEventListener('pointerlockerror', () => this.failLock('pointerlockerror が発生しました'), sig);
    this.raf = requestAnimationFrame(this.frame);
  }

  dispose(): void {
    this.ac?.abort();
    this.ac = null;
    this.input.detach();
    cancelAnimationFrame(this.raf);
    window.clearTimeout(this.pendingTimer);
    window.clearTimeout(this.renderTimer);
    window.clearTimeout(this.warmTimer);
    window.clearTimeout(this.navTimer);
    this.renderer?.dispose();
  }

  // ------------------------------------------------------------------ frame loop
  private frame = (now: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    const dt = this.lastT === null ? 0 : Math.min(Math.max((now - this.lastT) / 1000, 0), 0.25);
    this.lastT = now;
    const ticks = this.game.advance(dt); // playing 以外では何も進まない
    // 1 tick 以上実行されたら、押下が sim に見られた保留中の入力 (keydown と keyup が同じフレーム内に来たキー) を解放する
    this.input.afterAdvance(ticks);
    const s = this.game.state; // 再出撃で置き換わるので毎回参照する
    if (s.mode !== this.lastMode) {
      this.lastMode = s.mode;
      if (s.mode === 'cleared' || s.mode === 'failed') this.showResult();
    }
    const events = this.game.drainEvents();
    if (this.renderer) {
      const drawn = this.renderer.framesDrawn;
      this.renderer.render(s, events, dt);
      if (this.hangarFrames < 2 && this.renderer.framesDrawn > drawn && ++this.hangarFrames === 2) {
        // 1 枚目の描画結果は次のフレームの時点で画面に出ている: 読み込み中の表示を消して、ステージの準備を始める
        document.getElementById('boot-loading')?.remove();
        mark('ak2:hangar-visible');
        this.warmStage();
        this.warmNav();
      }
    } else if (!this.failed && !this.renderTimer) {
      // 最初のフレーム (読み込み中の表示が描かれる) の後のタスクで描画を作る
      this.renderTimer = window.setTimeout(() => {
        try {
          this.ensureRenderer();
        } catch (e) {
          console.error('AK2: renderer init failed', e);
        }
      }, 0);
    }
    if (s.mode === 'playing' || s.mode === 'paused') this.hud.update(s);
  };

  private applyResize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (!(w > 0 && h > 0)) return;
    this.game.setViewport(w, h);
    if (this.renderer) this.renderer.resize(w, h, window.devicePixelRatio || 1);
  }

  // ------------------------------------------------------------------ screens
  private showGarage(): void {
    this.hud.setVisible(false);
    this.screens.hideAll();
    this.garage.setPending(false);
    this.garage.setVisible(true);
  }

  private toGarage(): void {
    this.abortPending();
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    this.input.releaseAll();
    this.game.toGarage();
    this.ensureRenderer().showHangar(this.game.getLoadout());
    this.showGarage();
    this.garage.focusSortie();
  }

  private showResult(): void {
    this.input.releaseAll();
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    this.hud.setVisible(false);
    this.screens.showResult(buildResultModel(this.game.state));
  }

  private onLoadoutChange(l: Loadout): void {
    this.game.setLoadout(l);
    this.renderer?.setHangarLoadout(l); // 描画の準備前なら、準備時に game の構成で格納庫を作る
  }

  private onGlobalKey(e: KeyboardEvent): void {
    if (e.code === 'Escape' && this.help.isOpen) {
      e.preventDefault();
      this.help.close();
    }
  }

  // ------------------------------------------------------------------ pause
  private pauseGame(reason: string): void {
    if (this.game.state.mode !== 'playing') return;
    this.game.pause(); // 入力も全解除される
    this.input.releaseAll();
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    this.hud.setVisible(true);
    this.screens.showPause(reason);
  }

  // ------------------------------------------------------------------ pointer lock
  /** 出撃/再開/再出撃: 明示的なクリックからポインターロックを要求し、成功してから状態を進める */
  private requestLock(ctx: LockContext): void {
    if (this.pending) return;
    this.pending = ctx;
    this.lastFailed = null;
    this.screens.hideLockError();
    this.screens.setPending(true);
    this.garage.setPending(true);
    this.pendingTimer = window.setTimeout(() => this.failLock('一定時間内にロックの結果が返りませんでした'), LOCK_TIMEOUT_MS);
    try {
      const r = this.canvas.requestPointerLock() as Promise<void> | undefined;
      if (r && typeof r.catch === 'function') {
        r.catch((err: unknown) => this.failLock(err instanceof Error ? `${err.name}: ${err.message}` : String(err)));
      }
    } catch (err) {
      this.failLock(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    }
  }

  private abortPending(): void {
    this.pending = null;
    window.clearTimeout(this.pendingTimer);
    this.screens.setPending(false);
    this.garage.setPending(false);
  }

  private failLock(detail: string): void {
    const ctx = this.pending;
    if (!ctx) return;
    this.abortPending();
    this.lastFailed = ctx;
    // 戦闘は進めない: game.sortie()/resume()/retry() は呼ばない
    this.screens.showLockError(ctx, detail);
  }

  private onPointerLockChange(): void {
    const locked = document.pointerLockElement === this.canvas;
    if (locked) {
      const ctx = this.pending;
      if (!ctx) {
        document.exitPointerLock(); // 要求していないロックは保持しない
        return;
      }
      this.abortPending();
      this.beginPlay(ctx);
    } else if (this.game.state.mode === 'playing') {
      this.pauseGame('ポインターロックが解除されました (Esc)');
    }
  }

  private beginPlay(ctx: LockContext): void {
    this.input.onLockAcquired();
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    const mode = this.game.state.mode;
    this.game.warmup(); // 事前構築が済んでいなければここで残りを済ませる (済んでいれば何もしない)
    if (ctx === 'sortie' && mode === 'garage') {
      this.game.sortie(this.garage.getLoadout(), this.seed);
      this.ensureRenderer().showGame();
    } else if (ctx === 'retry' && (mode === 'cleared' || mode === 'failed')) {
      this.game.retry();
      this.ensureRenderer().showGame();
    } else if (ctx === 'resume' && mode === 'paused') {
      this.game.resume();
    } else {
      document.exitPointerLock();
      return;
    }
    this.lastMode = this.game.state.mode; // 次のフレームで即座に失敗しても結果画面が出るように基準を更新
    this.garage.setVisible(false);
    this.screens.hideAll();
    this.hud.setVisible(true);
  }
}
