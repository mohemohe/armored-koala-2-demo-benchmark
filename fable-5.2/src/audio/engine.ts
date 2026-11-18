/**
 * AudioEngine — procedural WebAudio sound for AK2, driven by simulation events and state.
 *
 * Optional polish with zero risk for the game: every public method is a no-op that never throws when
 * WebAudio is missing, the context is suspended / closed, or the simulation object is incomplete.
 * Nothing is created before unlock() (autoplay policy), nothing is fetched (all sounds are synthesised),
 * and the engine only ever READS the simulation — it has no way to change it.
 *
 * Wiring (see docs in src/audio/index.ts):
 *   click "sortie" / "resume" → unlock()            (inside the user gesture)
 *   every playing frame       → handleEvents(sim.drainEvents(), sim)
 *   every frame, any state    → update(sim, realDt, state === 'playing')
 *   re-sortie / garage        → stopAll()
 */
import { PLAYER } from '../config';
import type { SimEvent } from '../sim/types';
import { createCueState, dispatchEvent, type AudioSimView, type CueState } from './cues';
import { Mixer, VOICE_CAP, type GameMode, type MixerStats } from './mixer';
import { CATEGORIES, type SoundId } from './sounds';

export type UiSound = 'click' | 'sortie' | 'pause' | 'resume' | 'error';

export interface AudioEngineOptions {
  /**
   * Use this context instead of creating a live AudioContext at unlock(). An OfflineAudioContext makes the
   * engine render the very same graphs offline (dev/audio.ts measures the mix that way).
   */
  context?: BaseAudioContext;
  /** Factory for the live context (tests). Default: `new AudioContext({ latencyHint: 'interactive' })`. */
  createContext?: () => BaseAudioContext | null;
  /** Where the master output goes (default: the context's destination). For measurement taps. */
  destination?: AudioNode;
  /** Initial master volume 0…1 (default DEFAULT_VOLUME). */
  volume?: number;
  muted?: boolean;
}

export interface AudioDebugInfo extends MixerStats {
  /** 'idle' before unlock(), 'unavailable' when WebAudio is missing, otherwise the context state. */
  state: string;
  activeVoices: number;
  voiceCap: number;
  /** Exceptions swallowed by the public methods (0 in a healthy run) and the last one. */
  errors: number;
  lastError: string | null;
}

/** Moderate default: 0.7 on the squared volume taper is about -6 dB below full scale. */
export const DEFAULT_VOLUME = 0.7;
/** HP fraction below which the low-HP warning repeats, and the faster rate when it gets critical. */
const LOW_HP = 0.3;
const CRITICAL_HP = 0.15;
const LOW_HP_PERIOD = 1.8;
const CRITICAL_HP_PERIOD = 1.15;
/** A brake only sounds when the mech is actually moving. */
const BRAKE_MIN_SPEED = 4;
/** How many enemy telegraphs / enemy shots of ONE frame are voiced (the nearest ones). */
const SAME_FRAME_TELEGRAPHS = 4;
const SAME_FRAME_SHOTS = 4;
/** A UI sound requested while the context is still resuming is played if it starts within this time. */
const PENDING_UI_MS = 700;

const UI_SOUNDS: Record<UiSound, SoundId> = {
  click: 'ui-click',
  sortie: 'ui-sortie',
  pause: 'ui-pause',
  resume: 'ui-resume',
  error: 'ui-error',
};

const EMPTY_CATEGORIES = Object.fromEntries(Object.keys(CATEGORIES).map((c) => [c, { started: 0, dropped: 0, stolen: 0 }])) as MixerStats['byCategory'];

type ContextCtor = new (options?: AudioContextOptions) => AudioContext;

function defaultContext(): BaseAudioContext | null {
  const g = globalThis as unknown as { AudioContext?: ContextCtor; webkitAudioContext?: ContextCtor };
  const Ctor = g.AudioContext ?? g.webkitAudioContext;
  if (typeof Ctor !== 'function') return null;
  return new Ctor({ latencyHint: 'interactive' });
}

const nowMs = (): number => (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now());

export class AudioEngine {
  private mixer: Mixer | null = null;
  private readonly createContext: () => BaseAudioContext | null;
  private readonly destination: AudioNode | undefined;
  private ownsContext = false;
  private unavailable = false;
  private disposed = false;
  private volumeValue: number;
  private mutedValue: boolean;
  private readonly cue: CueState = createCueState();
  private readonly nearest: number[] = new Array<number>(Math.max(SAME_FRAME_TELEGRAPHS, SAME_FRAME_SHOTS)).fill(Infinity);
  private errors = 0;
  private lastError: string | null = null;

  // state trackers for sounds that have no event (lock, brake, HP / EN warnings)
  private synced = false;
  private lastTime = 0;
  private wasLocked = false;
  private lockTarget: string | null = null;
  private wasBraking = false;
  private lastEn = 0;
  private hpTimer = 0;

  private pendingUi: UiSound | null = null;
  private pendingUiAt = 0;
  private readonly onStateChange = (): void => {
    try {
      this.flushPendingUi();
    } catch (err) {
      this.note(err);
    }
  };

  /** Creates nothing audible and never throws. */
  constructor(opts: AudioEngineOptions = {}) {
    const v = opts && typeof opts.volume === 'number' && Number.isFinite(opts.volume) ? opts.volume : DEFAULT_VOLUME;
    this.volumeValue = Math.min(1, Math.max(0, v));
    this.mutedValue = !!(opts && opts.muted);
    this.createContext = opts && typeof opts.createContext === 'function' ? opts.createContext : defaultContext;
    this.destination = opts ? opts.destination : undefined;
    if (opts && opts.context) {
      try {
        this.attach(opts.context);
      } catch (err) {
        this.note(err);
      }
    }
  }

  private note(err: unknown): void {
    this.errors++;
    this.lastError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }

  private attach(ctx: BaseAudioContext): Mixer {
    const mixer = new Mixer(ctx, { volume: this.volumeValue, muted: this.mutedValue, destination: this.destination });
    this.mixer = mixer;
    if (typeof ctx.addEventListener === 'function') ctx.addEventListener('statechange', this.onStateChange);
    return mixer;
  }

  // ───────────────────────────── life cycle ─────────────────────────────

  /**
   * Creates the AudioContext on the first call and resumes it when it is suspended. Call it inside a user
   * gesture (the sortie / resume click). Safe to call any number of times.
   */
  unlock(): void {
    if (this.disposed) return;
    try {
      let m = this.mixer;
      if (!m) {
        if (this.unavailable) return;
        const ctx = this.createContext();
        if (!ctx) {
          this.unavailable = true;
          return;
        }
        try {
          m = this.attach(ctx);
        } catch (err) {
          // a context without a working graph is of no use: give it back
          const closing = typeof (ctx as AudioContext).close === 'function' ? (ctx as AudioContext).close() : null;
          if (closing && typeof closing.catch === 'function') closing.catch(() => undefined);
          throw err;
        }
        this.ownsContext = true;
        m.warm();
      }
      if (m.offline) return;
      const ctx = m.ctx as AudioContext;
      if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
        const p = ctx.resume();
        if (p && typeof p.then === 'function') p.then(this.onStateChange, () => undefined);
      }
    } catch (err) {
      this.note(err);
    }
  }

  get muted(): boolean {
    return this.mutedValue;
  }

  setMuted(muted: boolean): void {
    this.mutedValue = !!muted;
    try {
      this.mixer?.setMuted(this.mutedValue);
    } catch (err) {
      this.note(err);
    }
  }

  /** Master volume 0…1 (squared taper: 0.5 is about -12 dB). */
  get volume(): number {
    return this.volumeValue;
  }

  setVolume(v: number): void {
    if (typeof v !== 'number' || !Number.isFinite(v)) return;
    this.volumeValue = Math.min(1, Math.max(0, v));
    try {
      this.mixer?.setVolume(this.volumeValue);
    } catch (err) {
      this.note(err);
    }
  }

  /** Voices that are sounding or scheduled (one-shots + running loop layers). Never above VOICE_CAP. */
  get activeVoices(): number {
    try {
      return this.mixer ? this.mixer.activeVoices : 0;
    } catch (err) {
      this.note(err);
      return 0;
    }
  }

  /** Kills every voice within a few milliseconds and forgets all tracked state (re-sortie, back to the garage). */
  stopAll(): void {
    this.synced = false;
    this.hpTimer = 0;
    this.pendingUi = null;
    this.cue.mgShots = 0;
    try {
      this.mixer?.stopAll();
    } catch (err) {
      this.note(err);
    }
  }

  /** Releases every node and closes the context this engine created. The engine is silent afterwards. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const m = this.mixer;
    this.mixer = null;
    this.pendingUi = null;
    if (!m) return;
    try {
      const ctx = m.ctx;
      if (typeof ctx.removeEventListener === 'function') ctx.removeEventListener('statechange', this.onStateChange);
      m.dispose();
      if (this.ownsContext && !m.offline && ctx.state !== 'closed') {
        const p = (ctx as AudioContext).close();
        if (p && typeof p.catch === 'function') p.catch(() => undefined);
      }
    } catch (err) {
      this.note(err);
    }
  }

  // ───────────────────────────── per frame ─────────────────────────────

  /** One-shot sounds for the events of this frame (call it only while the fight is running). */
  handleEvents(events: readonly SimEvent[], sim: AudioSimView | null | undefined): void {
    const m = this.mixer;
    if (!m || !events || !(events.length > 0)) return;
    try {
      if (!m.canPlay) return;
      // events mean the simulation is running, even if update() has not said so yet this frame
      if (m.gameMode === 'paused') m.setGameMode('active');
      this.listen(m, sim);
    } catch (err) {
      this.note(err);
      return;
    }
    // When many enemies warn or fire in the very same frame (the mech leaves cover in front of a whole
    // group), only a few of those sounds can start at once: keep the nearest ones.
    let telegraphCut = Infinity;
    let shotCut = Infinity;
    try {
      telegraphCut = this.nearestCut(events, 'enemy-telegraph', SAME_FRAME_TELEGRAPHS, sim, m);
      shotCut = this.nearestCut(events, 'enemy-shot', SAME_FRAME_SHOTS, sim, m);
    } catch (err) {
      this.note(err);
    }
    for (let i = 0; i < events.length; i++) {
      try {
        const e = events[i];
        if (!e || typeof e.type !== 'string') continue;
        if (e.type === 'enemy-telegraph' && telegraphCut < Infinity && this.eventDistanceSq(e, sim, m) > telegraphCut) continue;
        if (e.type === 'enemy-shot' && shotCut < Infinity && this.eventDistanceSq(e, sim, m) > shotCut) continue;
        dispatchEvent(e, sim, m, this.cue);
      } catch (err) {
        this.note(err);
      }
    }
  }

  /** Squared distance from the listener to the source of an enemy telegraph / shot (0 when unknown). */
  private eventDistanceSq(e: SimEvent, sim: AudioSimView | null | undefined, m: Mixer): number {
    let p: { x: number; y: number; z: number } | null | undefined = null;
    if (e.type === 'enemy-shot') p = e.muzzle;
    else if (e.type === 'enemy-telegraph') p = sim?.enemyById?.get(e.enemyId)?.pos;
    const l = m.listener;
    if (!p || !l.valid) return 0;
    const dx = p.x - l.x;
    const dy = p.y - l.y;
    const dz = p.z - l.z;
    const d = dx * dx + dy * dy + dz * dz;
    return Number.isFinite(d) ? d : 0;
  }

  /**
   * If the batch holds more than `keep` events of `type`: the squared distance of the keep-th nearest one
   * (events farther away are skipped). Infinity when nothing has to be cut. No allocation.
   */
  private nearestCut(events: readonly SimEvent[], type: SimEvent['type'], keep: number, sim: AudioSimView | null | undefined, m: Mixer): number {
    let count = 0;
    for (let i = 0; i < events.length; i++) if (events[i] && events[i].type === type) count++;
    if (count <= keep) return Infinity;
    const best = this.nearest;
    for (let k = 0; k < keep; k++) best[k] = Infinity;
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (!e || e.type !== type) continue;
      let d = this.eventDistanceSq(e, sim, m);
      // insertion into the ascending list of the `keep` smallest distances
      for (let k = 0; k < keep; k++) {
        if (d < best[k]) {
          const t = best[k];
          best[k] = d;
          d = t;
        }
      }
    }
    return best[keep - 1];
  }

  /**
   * Continuous layers and state-driven cues. Call it every frame in every app state:
   *  - playing = true                      → glide / flight loops follow the mech, lock / brake / HP / EN cues
   *  - playing = false, sortie still open  → pause: all game sound is silent within 150 ms (menu sounds are not)
   *  - playing = false, sortie over        → loops fade out, the last sounds and the result jingle ring out
   */
  update(sim: AudioSimView | null | undefined, realDt: number, playing: boolean): void {
    const m = this.mixer;
    if (!m) return;
    try {
      const status = sim ? sim.status : undefined;
      const running = !!playing && !!sim && (status === undefined || status === 'playing');
      const mode: GameMode = running ? 'active' : status === 'cleared' || status === 'failed' ? 'ended' : 'paused';
      m.setGameMode(mode);
      if (running && sim) {
        this.listen(m, sim);
        this.track(m, sim, typeof realDt === 'number' && realDt > 0 && Number.isFinite(realDt) ? Math.min(realDt, 0.25) : 0);
      } else {
        m.setLoop('glide', 0, 0);
        m.setLoop('thrust', 0, 0);
      }
      m.reap();
    } catch (err) {
      this.note(err);
    }
  }

  /** Menu sounds. Not affected by the pause; needs unlock() to have happened. */
  playUi(kind: UiSound): void {
    const m = this.mixer;
    const id = UI_SOUNDS[kind];
    if (!m || !id) return;
    try {
      if (!m.offline && m.ctx.state === 'suspended' && !this.mutedValue) {
        // unlock() was called in this very gesture and the context is still starting: play it when it runs
        this.pendingUi = kind;
        this.pendingUiAt = nowMs();
        return;
      }
      m.play(id);
    } catch (err) {
      this.note(err);
    }
  }

  private flushPendingUi(): void {
    const kind = this.pendingUi;
    const m = this.mixer;
    if (!kind || !m || m.ctx.state !== 'running') return;
    this.pendingUi = null;
    if (nowMs() - this.pendingUiAt <= PENDING_UI_MS) m.play(UI_SOUNDS[kind]);
  }

  // ───────────────────────────── internals ─────────────────────────────

  /** World sounds are placed relative to the camera (position + yaw); the player pose is the fallback. */
  private listen(m: Mixer, sim: AudioSimView | null | undefined): void {
    if (!sim) return;
    const cam = sim.camera;
    if (cam && cam.pos && typeof cam.yaw === 'number') {
      m.setListener(cam.pos.x, cam.pos.y, cam.pos.z, cam.yaw);
      return;
    }
    const p = sim.player;
    if (p && p.pos && typeof p.yaw === 'number') m.setListener(p.pos.x, p.pos.y, p.pos.z, p.yaw);
  }

  private track(m: Mixer, sim: AudioSimView, dt: number): void {
    const p = sim.player;
    if (!p) {
      m.setLoop('glide', 0, 0);
      m.setLoop('thrust', 0, 0);
      return;
    }
    // ── loops ──
    const vx = p.vel ? p.vel.x : 0;
    const vz = p.vel ? p.vel.z : 0;
    let speed = Math.hypot(vx, vz);
    if (!Number.isFinite(speed)) speed = 0;
    const gliding = p.horizontalMode === 'glide' || p.horizontalMode === 'quickboost';
    m.setLoop('glide', gliding ? 0.22 + 0.78 * Math.min(1, speed / 26) : 0, speed / PLAYER.qbSpeed);
    m.setLoop('thrust', p.flying ? 1 : 0, 0.5);

    // ── cues derived from state changes ──
    const time = typeof sim.time === 'number' ? sim.time : 0;
    const lock = sim.lock;
    const locked = !!lock && lock.state === 'locked';
    const braking = !!p.braking;
    const en = typeof p.en === 'number' ? p.en : 0;
    const hp = typeof p.hp === 'number' ? p.hp : PLAYER.maxHp;

    // first frame after construction / stopAll(), or the simulation went back in time: adopt, do not announce
    if (this.synced && time >= this.lastTime) {
      if (locked && !this.wasLocked) {
        m.play('lock-on');
      } else if (!locked && this.wasLocked) {
        // a lock that ends because the target blew up needs no "lost" cue
        const target = this.lockTarget !== null ? sim.enemyById?.get(this.lockTarget) : undefined;
        if (!target || target.alive !== false) m.play('lock-lost');
      }
      if (braking && !this.wasBraking && speed > BRAKE_MIN_SPEED) {
        const o = this.cue.opts;
        o.pos = null;
        o.delay = 0;
        o.variant = 0;
        o.duration = 0;
        o.intensity = Math.min(1, speed / 40);
        o.gain = 0.5 + 0.5 * o.intensity;
        m.play('brake', o);
      }
      if (en < PLAYER.qbCost && this.lastEn >= PLAYER.qbCost) m.play('en-low');
    }
    this.synced = true;
    this.lastTime = time;
    this.wasLocked = locked;
    if (locked && lock) this.lockTarget = lock.targetId ?? null;
    this.wasBraking = braking;
    this.lastEn = en;

    // ── low-HP warning: a soft two-note figure, repeated slowly while HP < 30 % ──
    const frac = hp / PLAYER.maxHp;
    if (hp > 0 && frac < LOW_HP) {
      this.hpTimer -= dt;
      if (this.hpTimer <= 0) {
        m.play('low-hp');
        this.hpTimer = frac < CRITICAL_HP ? CRITICAL_HP_PERIOD : LOW_HP_PERIOD;
      }
    } else {
      this.hpTimer = 0;
    }
  }

  // ───────────────────────────── tools ─────────────────────────────

  /** Read-only diagnostics for the dev harness and tests. */
  getDebugInfo(): AudioDebugInfo {
    const m = this.mixer;
    const s = m ? m.stats : null;
    return {
      state: this.disposed ? 'disposed' : m ? (m.offline ? 'offline' : m.ctx.state) : this.unavailable ? 'unavailable' : 'idle',
      activeVoices: this.activeVoices,
      voiceCap: VOICE_CAP,
      started: s ? s.started : 0,
      dropped: s ? s.dropped : 0,
      stolen: s ? s.stolen : 0,
      liveNodes: s ? s.liveNodes : 0,
      peakVoices: s ? s.peakVoices : 0,
      peakNodes: s ? s.peakNodes : 0,
      byCategory: s ? s.byCategory : EMPTY_CATEGORIES,
      errors: this.errors,
      lastError: this.lastError,
    };
  }

  /** The mixer (null before unlock()). For the dev harness: auditioning single sounds, level meters. */
  getMixer(): Mixer | null {
    return this.mixer;
  }
}
