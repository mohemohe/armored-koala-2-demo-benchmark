/**
 * App — wires the simulation, the renderer, the HUD, the garage, the menus and the input layer into the
 * playable game (docs/SPEC.md §1, §2.1, §8, §9, §10).
 *
 * State machine (the names are the `state` of the §10 snapshot):
 *
 *     garage ──sortie──▶ playing ◀──resume──▶ paused ──re-sortie──▶ playing
 *        ▲                  │                    │
 *        │                  ▼                    │
 *        └──────────── cleared | failed ◀────────┘ (re-sortie with the same loadout | back to the garage)
 *
 * Rules the whole file is built around
 *  - The simulation is the only owner of game time and game logic. The app decides WHETHER the
 *    simulation advances (only in state 'playing'), never HOW. Pausing = not calling `sim.advance()`.
 *  - 'playing' is entered only from an explicit user action (button click / key activation) and only after
 *    the pointer lock has really been acquired. If the lock is refused, an explanation and a retry
 *    control are shown and the simulation does not advance by a single tick.
 *  - Nothing changes while a lock request is waiting for its answer: the screen the button belongs to
 *    stays as it is, and a sortie / re-sortie is prepared only at the moment the lock is there. A refused
 *    request therefore leaves the previous state (garage, paused or finished sortie) untouched.
 *  - The pointer is captured only while playing or while such a request is pending. A lock that arrives
 *    in any other situation (an answer that comes after its request timed out or was abandoned) is given
 *    back at once, so the cursor is never held over a menu.
 *  - Everything is created exactly once: one Sim, one GameRenderer, one Hud, one GarageUi, one Menus,
 *    one InputManager, one set of DOM listeners and one requestAnimationFrame chain for the lifetime of
 *    the app. A re-sortie only resets state (`sim.reset` → `renderer.resetForSortie` → `hud.reset`).
 *  - The app exposes no way to change the game state from outside: `getSnapshot()` is a read-only copy.
 *  - Sound (src/audio) is an output only: the engine reads the simulation and its events and can change
 *    nothing. No AudioContext exists before the first click on a start / resume button (`audio.unlock()` runs
 *    inside that click). Game sound exists only in state 'playing': every other state is told to the engine at
 *    the transition itself (not at the next frame — a hidden tab has no frames), so nothing keeps sounding
 *    behind a menu. Without WebAudio the game simply runs silent.
 */
import './app.css';
import { AudioEngine, type UiSound } from './audio';
import { DEFAULT_LOADOUT, DEFAULT_SEED } from './config';
import type { V3 } from './core/vec';
import { InputManager } from './input/input';
import { GameRenderer } from './render/renderer';
import { Sim } from './sim/sim';
import { buildSnapshot } from './sim/snapshot';
import type { AppState, Loadout, Snapshot, StageDef } from './sim/types';
import { GarageUi } from './ui/garage';
import { audioStatusText } from './ui/help';
import { Hud } from './ui/hud';
import { Menus, type ResultInfo } from './ui/menus';

export interface AppOptions {
  /** Element that becomes the game display area (the page decides its size; the shipped page: the whole window). */
  root: HTMLElement;
  /** Stage to play (the shipped page passes the factory; a dev harness may pass a small test stage). */
  stage: StageDef;
  /** Gameplay random seed (unsigned 32 bit), re-applied on every sortie. */
  seed: number;
}

/** Longest real frame time used for purely visual animation in the hangar. */
const GARAGE_MAX_DT = 0.1;
/** While nothing moves (paused / result) the frozen scene is redrawn on demand and at this interval (s). */
const FROZEN_REFRESH_SECONDS = 0.5;
/** Appended to the garage notice when the pointer lock could not be acquired (unless the reason already says how to retry). */
const RETRY_HINT_SORTIE = ' もう一度「出撃」を押してください。';
/** How long the sound on / off toast stays on screen after the M key (ms, real time; display only). */
const TOAST_MS = 1800;
/** Where the mute choice is remembered between visits (optional: the game works without storage). */
const MUTE_STORAGE_KEY = 'ak2.audio.muted';
/**
 * What the HUD (src/ui/hud.ts) shows along the top of the display area. The sound toast stays clear of these:
 * the two top panels and the top-centre block (gate banner + event messages, which stack about 8 em deep for
 * a few seconds after the last control turret). Looked up by class name; a block that does not exist is skipped.
 */
const TOAST_AVOID_SELECTORS = ['.hud-top-center', '.hud-top-left', '.hud-top-right'] as const;

function loadMuted(): boolean {
  try {
    return window.localStorage.getItem(MUTE_STORAGE_KEY) === '1';
  } catch {
    return false; // storage blocked or unavailable: start with sound on
  }
}

function saveMuted(muted: boolean): void {
  try {
    window.localStorage.setItem(MUTE_STORAGE_KEY, muted ? '1' : '0');
  } catch {
    /* storage blocked or unavailable: the choice lasts for this page only */
  }
}

const MSG_WEBGL =
  'WebGL2 を初期化できなかったため、ゲームを開始できません。\n' +
  'ブラウザーのハードウェアアクセラレーションを有効にするか、WebGL2 に対応した最新のデスクトップ用ブラウザーでお試しください。';
const MSG_CONTEXT_LOST =
  '描画コンテキスト（WebGL）が失われました。ゲームは一時停止しています。\n' +
  '自動で復帰しない場合は、ページを再読み込みしてください。';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, parent?: HTMLElement, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

/**
 * Runs `fn` once after the browser had the chance to paint (so a status text set just before is really
 * on screen while the next blocking step runs). Falls back to a timer in a background tab, where
 * animation frames do not fire.
 */
function afterPaint(fn: () => void): void {
  let done = false;
  const run = (): void => {
    if (done) return;
    done = true;
    fn();
  };
  requestAnimationFrame(() => setTimeout(run, 0));
  setTimeout(run, 300);
}

export class App {
  /** Seed used for every sortie of this page (URL query `seed`). */
  readonly seed: number;

  private readonly root: HTMLElement;
  private readonly stage: StageDef;
  private readonly canvas: HTMLCanvasElement;
  private readonly shellMsg: HTMLDivElement;
  private readonly shellTitle: HTMLElement;
  private readonly shellStatus: HTMLElement;
  private readonly shellBar: HTMLElement;
  private readonly shellDetail: HTMLElement;

  private readonly sim: Sim;
  private readonly hud: Hud;
  private readonly garage: GarageUi;
  private readonly menus: Menus;
  private readonly input: InputManager;
  /** Procedural sound. Creates nothing until unlock() is called from a click; never throws. */
  private readonly audio: AudioEngine;
  /** "音声 ON [M]" / "音声 OFF [M]" shown for a moment after the M key (own element above every layer). */
  private readonly toast: HTMLDivElement;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  /** The toast is on screen (until its timer hides it): its place is re-checked every frame. */
  private toastOn = false;
  /** Pixels the toast is currently moved down from its CSS position (CSS variable --ak2-toast-shift). */
  private toastShift = 0;
  /** The HUD blocks of TOAST_AVOID_SELECTORS (looked up once, on the first toast). */
  private toastAvoid: HTMLElement[] | null = null;
  private readonly hudLayer: HTMLDivElement;
  /** The M key is down (a held key toggles once, with or without `event.repeat`). */
  private muteKeyDown = false;
  private renderer: GameRenderer | null = null;

  private state: AppState = 'garage';
  /** Loadout of the current / last sortie (the only thing that survives a re-sortie). */
  private loadout: Loadout = { ...DEFAULT_LOADOUT };
  /** True once the renderer exists and the frame loop runs. */
  private ready = false;
  private fatal = false;
  private disposed = false;

  // frame loop (exactly one chain: started once in finishInit(), stopped only by dispose())
  private rafId = 0;
  private loopStarted = false;
  /** Timestamp (ms) of the previous frame; null = the next frame uses realDt 0 (start, resume, state change). */
  private lastFrameMs: number | null = null;
  private frozenDirty = true;
  private frozenAge = 0;

  // display area (CSS px) and device pixel ratio last handed to sim / renderer / hud
  private viewW = 0;
  private viewH = 0;
  private viewDpr = 0;
  private previewRect: { x: number; y: number; width: number; height: number } | null = null;

  // pointer-lock requests: only the newest one may change the state
  private lockSeq = 0;
  /** True from a button's lock request until its answer (lock, refusal or timeout) or its cancellation. */
  private lockPending = false;
  /** What the retry button of the pointer-lock error panel repeats: the refused resume or the refused re-sortie. */
  private retryAction: 'resume' | 'restart' = 'resume';

  private readonly whenReady: Promise<boolean>;
  private resolveReady: (ok: boolean) => void = () => {};

  constructor(opts: AppOptions) {
    this.root = opts.root;
    this.stage = opts.stage;
    this.seed = Number.isFinite(opts.seed) ? opts.seed >>> 0 : DEFAULT_SEED;
    this.whenReady = new Promise<boolean>((resolve) => {
      this.resolveReady = resolve;
    });

    // ───────── DOM: canvas, HUD layer, UI layer, loading indication ─────────
    const root = this.root;
    root.classList.add('ak2-root');
    if (getComputedStyle(root).position === 'static') root.style.position = 'relative';
    this.canvas = el('canvas', 'ak2-canvas', root);
    this.canvas.setAttribute('aria-label', 'ARMORED KOALA 2 DEMO ゲーム画面');
    const hudLayer = el('div', 'ak2-layer', root);
    this.hudLayer = hudLayer;
    const uiLayer = el('div', 'ak2-layer', root);
    this.toast = el('div', 'ak2-toast', root);
    this.toast.setAttribute('role', 'status');
    this.toast.setAttribute('aria-live', 'polite');
    this.shellMsg = el('div', 'ak2-shell-msg', root);
    this.shellMsg.setAttribute('role', 'status');
    this.shellTitle = el('div', 'title', this.shellMsg, 'ARMORED KOALA 2 DEMO');
    this.shellStatus = el('div', 'status', this.shellMsg, '読み込み中… LOADING');
    this.shellBar = el('i', '', el('div', 'bar', this.shellMsg));
    this.shellDetail = el('div', 'detail', this.shellMsg);
    // the static boot message of index.html is replaced by the identical-looking element above
    for (const boot of Array.from(root.querySelectorAll('[data-ak2-boot]'))) boot.remove();

    // ───────── simulation (built once; every sortie only resets it) ─────────
    const size = this.measure();
    this.sim = new Sim(this.stage, { loadout: this.loadout, seed: this.seed, viewport: { width: size.w, height: size.h } });

    // ───────── HUD, garage, menus, input (each created exactly once) ─────────
    this.hud = new Hud(hudLayer);
    this.hud.setVisible(false);
    this.garage = new GarageUi(uiLayer, {
      initial: this.loadout,
      onChange: (loadout) => this.onGarageChange(loadout),
      onSortie: () => this.onSortie(),
    });
    this.menus = new Menus(uiLayer, {
      onResume: () => this.onResume(),
      onRestart: () => this.onRestart(),
      onGarage: () => this.onGarage(),
    });
    this.input = new InputManager(this.canvas);
    // Registers the key / mouse listeners and the one beforeunload confirmation that is active while
    // playing (Left Ctrl is the brake, so Ctrl+W is a hazard). Inactive until a sortie starts.
    this.input.attach();
    this.input.setActive(false);
    // Sound: only the mute choice exists so far (the AudioContext is created by the first start click).
    this.audio = new AudioEngine({ muted: loadMuted() });
    this.garage.setAudioMuted(this.audio.muted);
    this.menus.setAudioMuted(this.audio.muted);

    // ───────── app-level listeners (registered once, removed only by dispose()) ─────────
    window.addEventListener('resize', this.onResize);
    window.addEventListener('blur', this.onBlur);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    document.addEventListener('visibilitychange', this.onVisibility);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    this.canvas.addEventListener('webglcontextlost', this.onContextLost);
    this.canvas.addEventListener('webglcontextrestored', this.onContextRestored);

    this.applySize(true);
    // Build the renderer after the loading indication had a chance to be painted.
    afterPaint(() => this.initRenderer());
  }

  // ═══════════════════════════ public surface ═══════════════════════════

  /** Current application state ('garage' from construction until the first sortie). */
  get appState(): AppState {
    return this.state;
  }

  /**
   * The SPEC §10 snapshot: a fresh, read-only copy of the current state. In the garage it reports the
   * loadout selected there. Never changes anything.
   */
  getSnapshot(): Snapshot {
    return buildSnapshot(this.sim, this.state, this.state === 'garage' ? this.garage.getLoadout() : undefined);
  }

  /**
   * Resolves once start-up has finished: true when the renderer was built and the garage is on screen,
   * false when WebGL could not be initialised (a message is shown instead).
   */
  whenLoaded(): Promise<boolean> {
    return this.whenReady;
  }

  /** Stops the frame loop, removes every listener and frees the renderer. The instance is dead afterwards. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lockSeq++;
    this.lockPending = false;
    if (this.loopStarted) cancelAnimationFrame(this.rafId);
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    document.removeEventListener('visibilitychange', this.onVisibility);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.input.setActive(false);
    this.input.exitPointerLock();
    this.input.detach();
    if (this.toastTimer !== null) clearTimeout(this.toastTimer);
    this.toastTimer = null;
    this.toastOn = false;
    this.toastAvoid = null;
    this.audio.dispose();
    this.garage.dispose();
    this.menus.dispose();
    this.renderer?.dispose();
    this.renderer = null;
    this.ready = false;
    this.resolveReady(false);
    this.root.replaceChildren();
    this.root.classList.remove('ak2-root');
  }

  // ═══════════════════════════ start-up ═══════════════════════════

  private setLoading(text: string, progress: number): void {
    this.shellStatus.textContent = text;
    this.shellBar.style.transform = `scaleX(${Math.min(1, Math.max(0.04, progress)).toFixed(3)})`;
  }

  private showFatal(title: string, message: string, detail: string): void {
    this.shellMsg.classList.remove('is-off');
    this.shellMsg.classList.add('is-fatal');
    this.shellMsg.setAttribute('role', 'alert');
    this.shellTitle.textContent = title;
    this.shellStatus.textContent = message;
    this.shellDetail.textContent = detail;
  }

  /**
   * Builds the renderer in a few blocking steps (texture generation and the stage view take a couple of
   * seconds), letting the loading text repaint in between. The game scene is drawn once behind the
   * loading screen so that shaders and buffers are ready and the sortie click does not hitch.
   */
  private initRenderer(): void {
    if (this.disposed) return;
    const fail = (err: unknown): void => {
      this.fatal = true;
      this.showFatal('WebGL を利用できません', MSG_WEBGL, err instanceof Error ? err.message : String(err));
      this.resolveReady(false);
    };
    let renderer: GameRenderer;
    try {
      renderer = new GameRenderer(this.canvas);
    } catch (err) {
      fail(err);
      return;
    }
    this.renderer = renderer;
    this.applySize(true);
    const steps: Array<[string, () => void]> = [
      ['ステージを構築中… BUILDING STAGE', () => renderer.setStage(this.stage)],
      [
        '描画を準備中… PREPARING RENDERER',
        () => {
          renderer.resetForSortie(this.sim);
          renderer.renderGame(this.sim, 0);
        },
      ],
      ['格納庫を準備中… PREPARING HANGAR', () => renderer.renderGarage(this.garage.getLoadout(), 0, null)],
    ];
    const runStep = (index: number): void => {
      if (this.disposed) return;
      if (index >= steps.length) {
        this.finishInit();
        return;
      }
      const [label, work] = steps[index]!;
      this.setLoading(label, (index + 1) / (steps.length + 1));
      afterPaint(() => {
        if (this.disposed) return;
        try {
          work();
        } catch (err) {
          fail(err);
          return;
        }
        runStep(index + 1);
      });
    };
    runStep(0);
  }

  private finishInit(): void {
    this.ready = true;
    this.shellMsg.classList.add('is-off');
    this.state = 'garage';
    this.garage.show();
    this.previewRect = null;
    this.lastFrameMs = null;
    if (!this.loopStarted) {
      this.loopStarted = true;
      this.rafId = requestAnimationFrame(this.frame);
    }
    this.resolveReady(true);
  }

  // ═══════════════════════════ the one frame loop ═══════════════════════════

  private readonly project = (p: V3, out: { x: number; y: number; depth: number }): boolean => {
    const r = this.renderer;
    return r ? r.projectToCss(p, out) : false;
  };

  private readonly frame = (now: number): void => {
    // Re-armed first: an exception below surfaces in the console but can never kill the loop.
    this.rafId = requestAnimationFrame(this.frame);
    const renderer = this.renderer;
    if (!renderer || this.fatal) return;
    this.applySize(false); // also catches devicePixelRatio changes that fire no resize event

    const t = Number.isFinite(now) ? now : performance.now();
    let realDt = this.lastFrameMs === null ? 0 : (t - this.lastFrameMs) / 1000;
    if (!(realDt > 0)) realDt = 0;
    this.lastFrameMs = t;

    switch (this.state) {
      case 'garage': {
        if (!this.previewRect && this.garage.visible) this.previewRect = this.garage.getPreviewRect();
        renderer.renderGarage(this.garage.getLoadout(), Math.min(realDt, GARAGE_MAX_DT), this.previewRect);
        break;
      }
      case 'playing': {
        // Never run combat without control: a lock that vanished without an event still pauses.
        if (!this.input.pointerLocked || document.visibilityState === 'hidden') {
          this.pause();
          this.drawFrozen(renderer, 0);
          break;
        }
        const sim = this.sim;
        this.input.apply(sim);
        sim.advance(realDt);
        const events = sim.drainEvents();
        this.audio.handleEvents(events, sim);
        renderer.handleEvents(events, sim);
        this.hud.handleEvents(events, sim);
        renderer.renderGame(sim, realDt);
        this.hud.update(sim, this.project, realDt);
        if (sim.status !== 'playing') this.finishSortie();
        break;
      }
      default:
        // paused / cleared / failed: nothing advances; the frozen scene stays on screen behind the menu
        this.drawFrozen(renderer, realDt);
        break;
    }
    // every frame, in every state: loops follow the mech while playing and are silent otherwise
    this.syncAudio(realDt);
    // (after the HUD update of this frame: a HUD message that just appeared pushes the sound toast down)
    if (this.toastOn) this.placeToast();
  };

  // ═══════════════════════════ sound ═══════════════════════════

  /**
   * Tells the audio engine where the game stands: the continuous layers (glide, thrust) and the state cues
   * run only in state 'playing'; paused = all game sound silent; cleared / failed = loops off, the result
   * cue rings out; garage = silent. Called once per frame and at every state change (a change must not wait
   * for a frame: a hidden tab renders none). `realDt` is display time and only paces repeated warnings.
   */
  private syncAudio(realDt: number): void {
    this.audio.update(this.sim, realDt, this.state === 'playing');
  }

  /** M: sound on / off. Works in every state; never creates the AudioContext (that takes a start click). */
  private toggleMute(): void {
    const muted = !this.audio.muted;
    this.audio.setMuted(muted);
    saveMuted(muted);
    this.garage.setAudioMuted(muted);
    this.menus.setAudioMuted(muted);
    if (!muted) this.audio.playUi('click'); // audible confirmation (once sound has been started)
    this.showToast(audioStatusText(muted) + (muted ? ' — ミュート中' : ''));
  }

  /** Short text at the top of the display area (the state is in the words; nothing is conveyed by colour). */
  private showToast(text: string): void {
    this.toast.textContent = text;
    this.toast.classList.add('is-on');
    this.toastOn = true;
    this.placeToast(); // now (a hidden or not yet running page renders no frame), then once per frame
    if (this.toastTimer !== null) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toastTimer = null;
      this.toastOn = false;
      this.toast.classList.remove('is-on'); // (fades out where it is)
    }, TOAST_MS);
  }

  /**
   * Keeps the sound toast off the HUD. Its CSS position (top centre, between the two top HUD panels) is free
   * most of the time, but the HUD's own top-centre block grows into it when the gate banner and the event
   * messages are stacked, and in a narrow window the top panels reach under it. Whenever one of those blocks
   * would be covered, the toast moves to just below it — and back when the block is gone. Display only: it
   * reads the layout of a few elements, and only while the toast is on screen.
   */
  private placeToast(): void {
    const toast = this.toast;
    const t = toast.getBoundingClientRect();
    if (!(t.width > 0 && t.height > 0)) return; // not laid out (the root is not displayed)
    if (this.toastAvoid === null) {
      this.toastAvoid = [];
      for (const selector of TOAST_AVOID_SELECTORS) {
        const block = this.hudLayer.querySelector<HTMLElement>(selector);
        if (block) this.toastAvoid.push(block);
      }
    }
    const gap = 0.2 * t.height;
    const natural = t.top - this.toastShift;
    let top = natural;
    // (moving below one block can bring the toast onto the next one: a few passes settle it)
    for (let pass = 0; pass <= TOAST_AVOID_SELECTORS.length; pass++) {
      let moved = false;
      for (const block of this.toastAvoid) {
        const b = block.getBoundingClientRect();
        if (!(b.width > 0 && b.height > 0)) continue; // hidden HUD, or a block with nothing in it
        if (b.right <= t.left || b.left >= t.right) continue; // beside the toast
        if (b.bottom + gap <= top || b.top >= top + t.height + gap) continue; // clear above / below
        top = b.bottom + gap;
        moved = true;
      }
      if (!moved) break;
    }
    const shift = Math.max(0, Math.round(top - natural));
    if (shift !== this.toastShift) {
      this.toastShift = shift;
      toast.style.setProperty('--ak2-toast-shift', shift + 'px');
    }
  }

  /** Redraws the frozen scene (realDt = 0: no animation advances) when needed and at a low refresh rate. */
  private drawFrozen(renderer: GameRenderer, realDt: number): void {
    this.frozenAge += realDt;
    if (!this.frozenDirty && this.frozenAge < FROZEN_REFRESH_SECONDS) return;
    this.frozenDirty = false;
    this.frozenAge = 0;
    renderer.renderGame(this.sim, 0);
    this.hud.update(this.sim, this.project, 0);
  }

  // ═══════════════════════════ display area ═══════════════════════════

  private measure(): { w: number; h: number; dpr: number } {
    const w = Math.max(1, Math.floor(this.root.clientWidth || window.innerWidth || 1));
    const h = Math.max(1, Math.floor(this.root.clientHeight || window.innerHeight || 1));
    const dpr = Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
    return { w, h, dpr };
  }

  /**
   * Hands the size of the display area (CSS px) to the simulation (camera aspect + lock circle), the
   * renderer and the HUD — the same numbers for all three, in every app state.
   */
  private applySize(force: boolean): void {
    const { w, h, dpr } = this.measure();
    if (!force && w === this.viewW && h === this.viewH && dpr === this.viewDpr) return;
    this.viewW = w;
    this.viewH = h;
    this.viewDpr = dpr;
    this.sim.setViewport(w, h);
    this.hud.resize(w, h);
    this.renderer?.resize(w, h, dpr);
    this.previewRect = null;
    this.frozenDirty = true;
  }

  // ═══════════════════════════ state transitions ═══════════════════════════

  /** sim.reset → renderer.resetForSortie → hud.reset → fresh input. Only `loadout` (and the seed) survive. */
  private prepareSortie(loadout: Loadout): void {
    this.loadout = { fcs: loadout.fcs, generator: loadout.generator, legs: loadout.legs };
    this.input.setActive(false);
    this.audio.stopAll(); // nothing of the previous sortie (or of its result cue) sounds into the new one
    this.sim.reset(this.loadout, this.seed); // (keeps the viewport: the lock circle stays factor × min(w, h))
    this.renderer?.resetForSortie(this.sim);
    this.hud.reset();
    this.frozenDirty = true;
  }

  /**
   * Requests the pointer lock (must be called synchronously from a user gesture). Exactly one of the two
   * callbacks runs later, unless a newer request or a state change superseded this one.
   */
  private acquireLock(onLocked: () => void, onFailed: (message: string) => void): void {
    const seq = ++this.lockSeq;
    this.lockPending = true;
    this.input.requestPointerLock().then(
      () => {
        if (seq !== this.lockSeq || this.disposed) {
          // This request was abandoned. If a newer one is waiting, the lock answers that one as well (its
          // own callback runs right after this) and must stay; otherwise nobody wants it any more.
          this.releaseUnwantedLock();
          return;
        }
        this.lockPending = false;
        onLocked();
      },
      (err: unknown) => {
        if (seq !== this.lockSeq || this.disposed) return;
        this.lockPending = false;
        onFailed(err instanceof Error && err.message ? err.message : 'ポインターロックを取得できませんでした。');
      },
    );
  }

  /**
   * Gives the pointer back if it is captured although the game is not being played and no button is
   * waiting for a lock: the answer to a request that had already timed out or been abandoned, or a lock
   * the app never asked for. Without this the cursor would stay captured over the menu whose retry button
   * the player is supposed to click.
   */
  private releaseUnwantedLock(): void {
    if (this.disposed || (this.state !== 'playing' && !this.lockPending)) this.input.exitPointerLock();
  }

  /**
   * The pointer is locked: the simulation may run. The click / key that led here must not act in the game.
   * @param cue menu sound of the transition ('sortie' for a fresh sortie, 'resume' after a pause)
   */
  private enterPlaying(cue: UiSound): void {
    this.retryAction = 'resume';
    this.garage.hide();
    this.menus.hideAll();
    this.hud.setVisible(true);
    this.sim.clearInput();
    this.input.setActive(true);
    // whatever is physically down right now (the click, a Q still held …) counts only after a release
    this.input.requireRelease();
    this.state = 'playing';
    this.lastFrameMs = null; // the first frame feeds 0 s: time spent in menus never reaches the simulation
    this.syncAudio(0);
    this.audio.playUi(cue);
  }

  /** playing → paused (Esc, pointer-lock loss, window blur, hidden tab). */
  private pause(): void {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.retryAction = 'resume';
    this.input.setActive(false);
    this.sim.clearInput();
    this.input.exitPointerLock();
    this.menus.showPause();
    this.lastFrameMs = null;
    this.frozenDirty = true;
    // Silence the fight now, not at the next frame: a hidden tab renders no frame. Only the short menu
    // blip is heard while paused.
    this.syncAudio(0);
    this.audio.playUi('pause');
  }

  /** sim.status left 'playing': stop updating and show the result. */
  private finishSortie(): void {
    const sim = this.sim;
    const kind = sim.status === 'cleared' ? 'cleared' : 'failed';
    this.state = kind;
    this.input.setActive(false);
    sim.clearInput();
    this.input.exitPointerLock();
    let destroyed = 0;
    for (const e of sim.enemies) if (!e.alive) destroyed++;
    const info: ResultInfo = {
      elapsedSeconds: sim.time,
      hp: sim.player.hp,
      controlsDestroyed: sim.objective.controlsDestroyed,
      enemiesDestroyed: destroyed,
      totalEnemies: sim.enemies.length,
      failReason: kind === 'failed' ? sim.failReason : null,
      loadout: { ...sim.loadout },
    };
    this.menus.showResult(kind, info);
    this.lastFrameMs = null;
    this.frozenDirty = true;
    this.syncAudio(0); // loops off; the result cue (started by the 'cleared' / 'failed' event) rings out
  }

  // ───────── UI callbacks (all of them run inside the user's click / key activation) ─────────

  private onGarageChange(loadout: Loadout): void {
    if (this.state !== 'garage') return;
    // keep the simulation in the freshly reset state of the selected build (the snapshot reports it)
    this.sim.reset(loadout, this.seed);
  }

  /**
   * "出撃". The build is read from the garage when it closes (the lock is there), not when the button was
   * pressed: whatever the player selected while the request was pending is what the garage shows, what
   * the snapshot reported, and therefore what sorties.
   */
  private onSortie(): void {
    if (this.state !== 'garage' || !this.ready || this.fatal || this.lockPending) return;
    this.audio.unlock(); // inside the click: the AudioContext may only be created / resumed by a user gesture
    this.acquireLock(
      () => {
        if (this.state !== 'garage') {
          this.releaseUnwantedLock();
          return;
        }
        this.garage.setNotice(null);
        this.prepareSortie(this.garage.getLoadout());
        this.enterPlaying('sortie');
      },
      (message) => {
        if (this.state !== 'garage') return;
        this.garage.setNotice(message.includes('もう一度') ? message : message + RETRY_HINT_SORTIE);
        this.audio.playUi('error');
      },
    );
  }

  /**
   * "再開" of the pause menu and "再試行" of the pointer-lock error panel. The retry repeats what was
   * refused: the resume of the paused sortie, or the re-sortie.
   */
  private onResume(): void {
    if (this.retryAction === 'restart' && this.menus.current === 'plerror') {
      this.onRestart();
      return;
    }
    if (this.state !== 'paused' || this.fatal || this.lockPending) return;
    this.audio.unlock(); // inside the click (also the retry button of the error panel)
    this.acquireLock(
      () => {
        if (this.state !== 'paused') {
          this.releaseUnwantedLock();
          return;
        }
        this.enterPlaying('resume');
      },
      (message) => {
        if (this.state !== 'paused') return;
        this.retryAction = 'resume';
        this.menus.showPointerLockError(message);
        this.audio.playUi('error');
      },
    );
  }

  /**
   * "同じ構成で再出撃" (pause menu and result screen). Until the pointer lock is there nothing changes: the
   * paused / finished sortie and its screen stay as they are. With the lock the sortie is re-initialised
   * and starts at time 0 in the same step. If the lock is refused, the error panel's retry button repeats
   * the re-sortie.
   */
  private onRestart(): void {
    const from = this.state;
    if ((from !== 'paused' && from !== 'cleared' && from !== 'failed') || this.fatal || this.lockPending) return;
    // inside the click itself — the re-sortie is prepared later, when the pointer lock arrives
    this.audio.unlock();
    this.acquireLock(
      () => {
        if (this.state !== from) {
          this.releaseUnwantedLock();
          return;
        }
        this.prepareSortie(this.loadout);
        this.enterPlaying('sortie');
      },
      (message) => {
        if (this.state !== from) return;
        this.retryAction = 'restart';
        this.menus.showPointerLockError(message);
        this.audio.playUi('error');
      },
    );
  }

  /** "格納庫へ戻る" (pause menu, result screen, pointer-lock error panel). */
  private onGarage(): void {
    if (this.state === 'garage' || this.state === 'playing') return;
    this.lockSeq++; // a lock request still in flight is no longer wanted (its late answer is released)
    this.lockPending = false;
    this.retryAction = 'resume';
    this.input.setActive(false);
    this.input.exitPointerLock();
    this.menus.hideAll();
    this.hud.setVisible(false);
    this.audio.stopAll(); // the hangar is silent: no loop, no ringing result cue
    // back to the freshly reset state of the build selected in the garage
    this.sim.reset(this.garage.getLoadout(), this.seed);
    this.state = 'garage';
    this.garage.setNotice(null);
    this.garage.show();
    this.previewRect = null;
    this.lastFrameMs = null;
    this.syncAudio(0);
  }

  // ───────── DOM listeners (arrow functions: one stable identity, registered once) ─────────

  private readonly onResize = (): void => {
    this.applySize(false);
  };

  private readonly onBlur = (): void => {
    this.muteKeyDown = false; // (the keyup may never arrive)
    this.pause();
  };

  private readonly onVisibility = (): void => {
    if (document.visibilityState === 'hidden') {
      this.muteKeyDown = false; // (the keyup may never arrive)
      this.pause();
    } else this.frozenDirty = true;
  };

  private readonly onPointerLockChange = (): void => {
    if (!this.input.pointerLocked) this.pause(); // (only acts while playing)
    else this.releaseUnwantedLock(); // (only acts when neither playing nor waiting for a lock)
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    // With a real pointer lock the browser consumes Esc and only the lock loss is seen; where the key
    // is delivered it pauses just the same.
    if (e.code === 'Escape' && this.state === 'playing') {
      e.preventDefault();
      this.pause();
      return;
    }
    // M: sound on / off, in every state. One toggle per physical press: auto-repeat (with or without the
    // repeat flag) is ignored, and so is M as part of a browser / system shortcut (Ctrl+M mutes the tab in
    // some browsers — and Left Ctrl is the brake).
    if (e.code === 'KeyM') {
      const first = !this.muteKeyDown && !e.repeat;
      this.muteKeyDown = true;
      if (first && !e.ctrlKey && !e.metaKey && !e.altKey && !this.disposed) this.toggleMute();
    }
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    if (e.code === 'KeyM') this.muteKeyDown = false;
  };

  private readonly onContextLost = (e: Event): void => {
    e.preventDefault(); // allows the browser to restore the context
    this.pause();
    this.showFatal('描画が停止しました', MSG_CONTEXT_LOST, '');
  };

  private readonly onContextRestored = (): void => {
    if (this.fatal) return;
    this.shellMsg.classList.add('is-off');
    this.shellMsg.classList.remove('is-fatal');
    this.frozenDirty = true;
  };
}

/**
 * Publishes the read-only evaluation interface of SPEC §10: `window.__AK2__`, a frozen object whose only
 * member is `getSnapshot()`. It cannot be replaced, extended or used to change the game.
 *
 * `__AK2__` is the only global of the page: the revision marker three.js leaves on `window` when it is
 * loaded unbundled (`__THREE__`, a version string used only to warn about duplicate imports) is removed.
 */
export function exposeSnapshotApi(app: App, target: Window = window): void {
  const api = Object.freeze({ getSnapshot: (): Snapshot => app.getSnapshot() });
  Object.defineProperty(target, '__AK2__', { value: api, writable: false, configurable: false, enumerable: true });
  try {
    delete (target as unknown as { __THREE__?: unknown }).__THREE__;
  } catch {
    /* not configurable in this environment: harmless */
  }
}
