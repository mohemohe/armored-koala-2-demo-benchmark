/**
 * Mixer: master chain, voice management and loop layers on top of a BaseAudioContext.
 *
 *   voices ─┬─ game bus (silenced by a pause) ─ high-pass 24 Hz ─ compressor ─ trim ─┐
 *           └─ ui bus (menus, result jingles) ─────────────────────────── ui trim ─┴─ soft clipper ─ volume ─ out
 *
 * The compressor glues busy moments of the fight together. Menu sounds and result jingles go around it (the
 * fight never ducks them, and they are not affected by the compressor's start-up dip right after unlock()).
 * The wave-shaper at the end is a memoryless soft clipper whose output can never exceed CEILING, whatever
 * the browser's compressor does (hard guarantee against clipping).
 *
 * The same class drives the live AudioContext of the game and an OfflineAudioContext (measurements).
 */
import { NoiseBank, Patch, makeRandom, type Ctx } from './patch';
import { CATEGORIES, LOOPS, SOUNDS, SOUND_IDS, type Category, type LoopId, type LoopVoice, type SoundArgs, type SoundDef, type SoundId } from './sounds';
import { OPEN_CUTOFF, place, type Listener, type Placement } from './spatial';

/** Maximum simultaneously active voices (one-shots + the running loop layers). */
export const VOICE_CAP = 24;
/** Voices in their few-millisecond fade-out after being stolen / stopped (not counted as active). */
const FADING_CAP = 24;
/** Scheduling head start so a voice never begins in the past of the audio thread. */
const LOOKAHEAD = 0.004;
/**
 * Sustained-fire sounds (SoundDef.rhythm): up to RHYTHM_SNAP seconds of lag the interval is shortened by
 * RHYTHM_CREEP (0.5 %: half a millisecond for the machine gun) per shot, beyond it by RHYTHM_CATCHUP (15 %).
 */
const RHYTHM_SNAP = 0.04;
const RHYTHM_CREEP = 0.005;
const RHYTHM_CATCHUP = 0.15;
/** A voice whose level would be below this (-50 dB) is not created at all. */
const AUDIBLE_FLOOR = 0.003;
/** Time constant and total length of the fade applied to a stolen / stopped voice. */
const KILL_TAU = 0.004;
const KILL_SECONDS = 0.025;
/** Pause: the game bus ramps to zero within this time and every game voice is stopped right after. */
export const PAUSE_FADE_SECONDS = 0.04;
const PAUSE_STOP_SECONDS = 0.055;
/** A loop layer that has been silent this long is torn down (rebuilt on demand). */
const LOOP_IDLE_SECONDS = 0.4;

/** Absolute output ceiling of the soft clipper (before the master volume, which is <= 1). */
export const CEILING = 0.95;
/** The clipper is exactly linear below this level. */
export const CLIP_KNEE = 0.6;
const CLIP_RANGE = 4;
const CLIP_POINTS = 2049;

export const COMPRESSOR = { threshold: -12, knee: 8, ratio: 8, attack: 0.003, release: 0.16 } as const;
/** Gain after the compressor (on top of cancelling its built-in make-up gain). */
export const POST_GAIN = 1.5;

const dbToLin = (db: number): number => Math.pow(10, db / 20);
const linToDb = (x: number): number => 20 * Math.log10(x);

/**
 * Make-up gain a DynamicsCompressorNode applies by itself for the given static curve: (1 / curve(1))^0.6,
 * the "full range" rule of the Web Audio specification. Cancelled by the trim gain so that quiet signals
 * pass the master chain at POST_GAIN exactly (verified offline by dev/audio.ts).
 */
export function compressorMakeup(thresholdDb: number, kneeDb: number, ratio: number): number {
  const linearThreshold = dbToLin(thresholdDb);
  const kneeCurve = (x: number, k: number): number =>
    x < linearThreshold ? x : linearThreshold + (1 - Math.exp(-k * (x - linearThreshold))) / k;
  const slopeAt = (x: number, k: number): number => {
    if (x < linearThreshold) return 1;
    const x2 = x * 1.001;
    return (linToDb(kneeCurve(x2, k)) - linToDb(kneeCurve(x, k))) / (linToDb(x2) - linToDb(x));
  };
  const desired = 1 / ratio;
  const kneeThresholdDb = thresholdDb + kneeDb;
  const kneeThreshold = dbToLin(kneeThresholdDb);
  let minK = 0.1;
  let maxK = 10000;
  let k = 5;
  for (let i = 0; i < 15; i++) {
    if (slopeAt(kneeThreshold, k) < desired) maxK = k;
    else minK = k;
    k = Math.sqrt(minK * maxK);
  }
  const yKneeDb = linToDb(kneeCurve(kneeThreshold, k));
  const full = 1 < kneeThreshold ? kneeCurve(1, k) : dbToLin(yKneeDb + desired * (0 - kneeThresholdDb));
  return Math.pow(1 / full, 0.6);
}

/** Soft-clip transfer function: identity up to CLIP_KNEE, then a tanh shoulder that approaches CEILING. */
export function softClip(x: number): number {
  const a = Math.abs(x);
  if (a <= CLIP_KNEE) return x;
  const span = CEILING - CLIP_KNEE;
  const y = CLIP_KNEE + span * Math.tanh((a - CLIP_KNEE) / span);
  return x < 0 ? -y : y;
}

export interface PlayOptions {
  /** World position (used only by sounds that have a distance law). */
  pos?: { x: number; y: number; z: number } | null;
  /** Extra linear level factor (default 1). */
  gain?: number;
  /** Start this many seconds from now. */
  delay?: number;
  variant?: number;
  intensity?: number;
  duration?: number;
}

export interface MixerStats {
  /** Voices started / refused (throttle, cap, inaudible, paused) / cut short to make room. */
  started: number;
  dropped: number;
  stolen: number;
  /** AudioNodes currently connected by voices and loops (returns to 0 when everything has ended). */
  liveNodes: number;
  /** Highest number of simultaneously active voices seen so far. */
  peakVoices: number;
  peakNodes: number;
  /** started / dropped / stolen per category (diagnostics for the mix). */
  byCategory: Record<Category, { started: number; dropped: number; stolen: number }>;
}

function categoryCounters(): MixerStats['byCategory'] {
  const out = {} as MixerStats['byCategory'];
  for (const c of Object.keys(CATEGORIES) as Category[]) out[c] = { started: 0, dropped: 0, stolen: 0 };
  return out;
}

interface Voice {
  id: SoundId;
  category: Category;
  priority: number;
  ui: boolean;
  start: number;
  end: number;
  /** Linear level (definition × options × distance) — the "quietest" criterion of voice stealing. */
  level: number;
  out: GainNode;
  nodes: AudioNode[];
  sources: AudioScheduledSourceNode[];
  tail: AudioScheduledSourceNode | null;
  released: boolean;
}

interface Loop {
  id: LoopId;
  out: GainNode | null;
  nodes: AudioNode[];
  sources: AudioScheduledSourceNode[];
  voice: LoopVoice | null;
  /** Last values handed to the audio thread. */
  level: number;
  x: number;
  silentSince: number;
}

export type GameMode = 'active' | 'ended' | 'paused';

export class Mixer {
  readonly ctx: Ctx;
  /** True for an OfflineAudioContext (its state is 'suspended' while it is being driven step by step). */
  readonly offline: boolean;
  readonly stats: MixerStats = { started: 0, dropped: 0, stolen: 0, liveNodes: 0, peakVoices: 0, peakNodes: 0, byCategory: categoryCounters() };
  readonly listener: Listener = { x: 0, y: 0, z: 0, yaw: 0, valid: false };

  private readonly noise: NoiseBank;
  private readonly rnd: () => number;
  private readonly gameBus: GainNode;
  private readonly uiBus: GainNode;
  private readonly master: GainNode;
  private readonly preMasterNode: AudioNode;
  private readonly chain: AudioNode[];
  /** StereoPannerNode is missing in a few old browsers: world sounds then play centred. */
  private readonly canPan: boolean;
  private readonly voices: Voice[] = [];
  private readonly fading: Voice[] = [];
  private readonly loops: Record<LoopId, Loop>;
  private readonly lastStart: Record<string, number> = {};
  private readonly placement: Placement = { pan: 0, gain: 1, cutoff: OPEN_CUTOFF, distance: 0 };
  private readonly args: SoundArgs = { variant: 0, intensity: 1, duration: 0 };
  private volume: number;
  private muted: boolean;
  private mode: GameMode = 'active';
  private disposed = false;

  constructor(ctx: Ctx, opts: { volume?: number; muted?: boolean; seed?: number; destination?: AudioNode } = {}) {
    this.ctx = ctx;
    this.offline = typeof (ctx as OfflineAudioContext).startRendering === 'function';
    this.noise = new NoiseBank(ctx);
    this.rnd = makeRandom(opts.seed ?? 0x5eed1234);
    this.volume = opts.volume ?? 1;
    this.muted = opts.muted ?? false;

    this.gameBus = ctx.createGain();
    this.uiBus = ctx.createGain();
    const highpass = ctx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 24;
    highpass.Q.value = 0.707;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = COMPRESSOR.threshold;
    comp.knee.value = COMPRESSOR.knee;
    comp.ratio.value = COMPRESSOR.ratio;
    comp.attack.value = COMPRESSOR.attack;
    comp.release.value = COMPRESSOR.release;
    // trim = POST_GAIN / make-up, and the 1 / CLIP_RANGE scaling that maps ±CLIP_RANGE onto the shaper input
    const trim = ctx.createGain();
    trim.gain.value = POST_GAIN / compressorMakeup(COMPRESSOR.threshold, COMPRESSOR.knee, COMPRESSOR.ratio) / CLIP_RANGE;
    const uiTrim = ctx.createGain();
    uiTrim.gain.value = POST_GAIN / CLIP_RANGE;
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(CLIP_POINTS);
    for (let i = 0; i < CLIP_POINTS; i++) curve[i] = softClip(((i / (CLIP_POINTS - 1)) * 2 - 1) * CLIP_RANGE);
    shaper.curve = curve;
    shaper.oversample = 'none';
    this.master = ctx.createGain();
    this.master.gain.value = this.masterTarget();

    this.gameBus.connect(highpass);
    highpass.connect(comp);
    comp.connect(trim);
    trim.connect(shaper);
    this.uiBus.connect(uiTrim);
    uiTrim.connect(shaper);
    shaper.connect(this.master);
    this.master.connect(opts.destination ?? ctx.destination);
    this.chain = [this.gameBus, this.uiBus, highpass, comp, trim, uiTrim, shaper, this.master];
    this.preMasterNode = highpass;
    this.canPan = typeof ctx.createStereoPanner === 'function';

    const loop = (id: LoopId): Loop => ({ id, out: null, nodes: [], sources: [], voice: null, level: 0, x: 0, silentSince: 0 });
    this.loops = { glide: loop('glide'), thrust: loop('thrust') };
    for (const id of SOUND_IDS) this.lastStart[id] = -1e9;
  }

  // ───────────────────────────── state ─────────────────────────────

  /** True when a sound started now would actually be heard. */
  get canPlay(): boolean {
    if (this.disposed || this.muted) return false;
    return this.offline || this.ctx.state === 'running';
  }

  private get usable(): boolean {
    return !this.disposed && (this.offline || this.ctx.state !== 'closed');
  }

  get now(): number {
    return this.ctx.currentTime;
  }

  /** The last node of the master chain (after the volume). Tools may connect an analyser to it. */
  get output(): AudioNode {
    return this.master;
  }

  /** The game bus before the compressor (measurement tap for tools). */
  get preMaster(): AudioNode {
    return this.preMasterNode;
  }

  get gameMode(): GameMode {
    return this.mode;
  }

  private masterTarget(): number {
    // squared taper: the slider feels even, 0.5 is about -12 dB
    return this.muted ? 0 : this.volume * this.volume;
  }

  setVolume(v: number): void {
    this.volume = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : this.volume;
    this.applyMaster();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyMaster();
    if (muted) for (const id of ['glide', 'thrust'] as const) this.setLoop(id, 0, 0);
  }

  private applyMaster(): void {
    if (!this.usable) return;
    this.master.gain.setTargetAtTime(this.masterTarget(), this.now, 0.012);
  }

  setListener(x: number, y: number, z: number, yaw: number): void {
    const l = this.listener;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) || !Number.isFinite(yaw)) return;
    l.x = x;
    l.y = y;
    l.z = z;
    l.yaw = yaw;
    l.valid = true;
  }

  /**
   * Generates the noise buffers ahead of the first shot — one colour per task, so that the click handler
   * that called unlock() returns at once and no single frame pays for all of them. A sound that needs a
   * buffer earlier simply generates it on the spot.
   */
  warm(): void {
    const kinds = ['white', 'pink', 'brown', 'crackle'] as const;
    let i = 0;
    const step = (): void => {
      if (this.disposed) return;
      try {
        this.noise.get(kinds[i]);
      } catch {
        return; // the context went away: nothing to prepare
      }
      if (++i < kinds.length) setTimeout(step, 0);
    };
    if (typeof setTimeout === 'function') setTimeout(step, 0);
  }

  /**
   * 'active' — the fight runs. 'paused' — the game bus is ramped to silence within PAUSE_FADE_SECONDS, every
   * game voice is stopped and new game sounds are refused. 'ended' — the sortie is over: nothing is cut, the
   * last sounds ring out (the engine fades the loops).
   */
  setGameMode(mode: GameMode): void {
    if (mode === this.mode || !this.usable) return;
    const was = this.mode;
    this.mode = mode;
    const now = this.now;
    const g = this.gameBus.gain;
    if (mode === 'paused') {
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(0, now + PAUSE_FADE_SECONDS);
      for (let i = this.voices.length - 1; i >= 0; i--) {
        const v = this.voices[i];
        if (!v.ui) this.retire(i, now + PAUSE_STOP_SECONDS, false);
      }
      for (const id of ['glide', 'thrust'] as const) this.killLoop(this.loops[id], now + PAUSE_STOP_SECONDS, false);
    } else if (was === 'paused') {
      g.cancelScheduledValues(now);
      g.setValueAtTime(0, now);
      g.linearRampToValueAtTime(1, now + 0.02);
    }
  }

  /** Number of voices that are sounding or scheduled, plus running loop layers. Never above VOICE_CAP. */
  get activeVoices(): number {
    if (this.disposed) return 0;
    this.reap();
    return this.voices.length + this.loopCount();
  }

  private loopCount(): number {
    return (this.loops.glide.out ? 1 : 0) + (this.loops.thrust.out ? 1 : 0);
  }

  // ───────────────────────────── one-shot voices ─────────────────────────────

  /** Starts a sound. Returns false when it was refused (muted, suspended, throttled, voice cap, inaudible). */
  play(id: SoundId, o?: PlayOptions): boolean {
    const def: SoundDef | undefined = SOUNDS[id];
    if (!def || !this.canPlay) return false;
    const cat = CATEGORIES[def.category];
    const ui = cat.bus === 'ui';
    if (!ui && this.mode === 'paused') return this.refuse(def.category);

    const now = this.now;
    const delay = o && o.delay !== undefined && o.delay > 0 && Number.isFinite(o.delay) ? o.delay : 0;
    const wanted = now + LOOKAHEAD + delay;
    let t = wanted;
    // per-sound throttle: identical sounds never start at the same instant (they would add up coherently)
    const earliest = this.lastStart[id] + def.minInterval;
    if (t < earliest) {
      const wait = earliest - wanted;
      if (wait > def.maxDelay) return this.refuse(def.category);
      t = earliest;
      // Sustained fire: the shot goes onto the grid of the fire interval instead of following the jitter of
      // the video frames. The grid creeps forward by a hair per shot (the sound never lags more than it
      // must), and after a frame hitch (lag beyond RHYTHM_SNAP) it catches up faster.
      if (def.rhythm) {
        t -= wait > RHYTHM_SNAP ? Math.min(wait - RHYTHM_SNAP, def.minInterval * RHYTHM_CATCHUP) : Math.min(wait, def.minInterval * RHYTHM_CREEP);
      }
    }

    // level and stereo placement
    let level = def.gain * (o && o.gain !== undefined && Number.isFinite(o.gain) ? Math.max(0, o.gain) : 1);
    let pan = 0;
    let cutoff = OPEN_CUTOFF;
    const p = o ? o.pos : null;
    if (def.rolloff && p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) {
      const pl = place(this.listener, p.x, p.y, p.z, def.rolloff, this.placement);
      level *= pl.gain;
      pan = pl.pan;
      cutoff = pl.cutoff;
    }
    if (!(level >= AUDIBLE_FLOOR)) return this.refuse(def.category);

    this.reap();
    if (!this.makeRoom(def.category, cat.priority, cat.max, level, now)) return this.refuse(def.category);

    // build
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.gain.value = level;
    const patch = new Patch(ctx, this.noise, t, out, this.rnd);
    const nodes = patch.nodes;
    const a = this.args;
    a.variant = o && o.variant !== undefined && Number.isFinite(o.variant) ? o.variant : 0;
    a.intensity = o && o.intensity !== undefined && Number.isFinite(o.intensity) ? o.intensity : 1;
    a.duration = o && o.duration !== undefined && Number.isFinite(o.duration) ? o.duration : 0;
    try {
      patch.finish(def.build(patch, a));
      nodes.push(out);
      let last: AudioNode = out;
      if (cutoff < OPEN_CUTOFF) {
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = cutoff;
        lp.Q.value = 0.5;
        nodes.push(lp);
        last.connect(lp);
        last = lp;
      }
      if (pan !== 0 && this.canPan) {
        const sp = ctx.createStereoPanner();
        sp.pan.value = pan;
        nodes.push(sp);
        last.connect(sp);
        last = sp;
      }
      last.connect(ui ? this.uiBus : this.gameBus);
    } catch (err) {
      // a voice that failed half-way must not leave running sources or connections behind
      for (const src of patch.sources) {
        try {
          src.stop();
        } catch {
          /* never started */
        }
      }
      for (const n of nodes) n.disconnect();
      out.disconnect();
      throw err;
    }

    const voice: Voice = {
      id,
      category: def.category,
      priority: cat.priority,
      ui,
      start: t,
      end: patch.end + 0.02,
      level,
      out,
      nodes,
      sources: patch.sources,
      tail: patch.tail,
      released: false,
    };
    // Backup release for the case that nobody calls update() / play() for a while (hidden tab): the source
    // that stops last frees the voice. reap() normally gets there first; release is idempotent.
    if (patch.tail) patch.tail.onended = () => this.release(voice);
    this.voices.push(voice);
    this.lastStart[id] = t;
    const st = this.stats;
    st.started++;
    st.byCategory[def.category].started++;
    st.liveNodes += nodes.length;
    if (this.voices.length > st.peakVoices) st.peakVoices = this.voices.length;
    if (st.liveNodes > st.peakNodes) st.peakNodes = st.liveNodes;
    return true;
  }

  private refuse(category: Category): boolean {
    this.stats.dropped++;
    this.stats.byCategory[category].dropped++;
    return false;
  }

  /** How much a voice still matters: its level, fading with its age. */
  private weight(v: Voice, now: number): number {
    const span = v.end - v.start;
    const left = now <= v.start ? 1 : span > 0 ? Math.max(0, (v.end - now) / span) : 0;
    return v.level * left * left;
  }

  /**
   * Enforces the per-category limit and the global cap for a new voice of the given priority and level.
   * Steals the least important voice (lowest priority, then quietest / most decayed) — or refuses the new
   * one when everything playing matters more.
   */
  private makeRoom(category: Category, priority: number, max: number, level: number, now: number): boolean {
    const vs = this.voices;
    let count = 0;
    let victim = -1;
    let victimWeight = Infinity;
    for (let i = 0; i < vs.length; i++) {
      if (vs[i].category !== category) continue;
      count++;
      const w = this.weight(vs[i], now);
      if (w < victimWeight) {
        victimWeight = w;
        victim = i;
      }
    }
    if (count >= max) {
      if (victim < 0 || victimWeight > level) return false;
      this.steal(victim, now);
    }
    if (vs.length + this.loopCount() < VOICE_CAP) return true;
    return this.evict(priority, level, now);
  }

  /**
   * Global cap: cuts the least important voice (lowest priority, then quietest / most decayed) for a newcomer
   * of the given priority and level. Returns false when everything that plays matters more.
   */
  private evict(priority: number, level: number, now: number): boolean {
    const vs = this.voices;
    let victim = -1;
    let victimWeight = Infinity;
    let victimPriority = Infinity;
    for (let i = 0; i < vs.length; i++) {
      const v = vs[i];
      const w = this.weight(v, now);
      if (v.priority < victimPriority || (v.priority === victimPriority && w < victimWeight)) {
        victimPriority = v.priority;
        victimWeight = w;
        victim = i;
      }
    }
    if (victim < 0 || victimPriority > priority) return false;
    if (victimPriority === priority && victimWeight > level) return false;
    this.steal(victim, now);
    return true;
  }

  private steal(index: number, now: number): void {
    this.stats.stolen++;
    this.stats.byCategory[this.voices[index].category].stolen++;
    this.retire(index, now + KILL_SECONDS, true);
  }

  /**
   * Takes voice `index` out of the active list and lets it fade out until `stopAt` (it is then disconnected
   * by reap() / onended). `fade` adds a fast per-voice fade (used when the bus itself is not being faded).
   */
  private retire(index: number, stopAt: number, fade: boolean): void {
    const v = this.voices[index];
    this.voices[index] = this.voices[this.voices.length - 1];
    this.voices.pop();
    const now = this.now;
    if (fade) {
      v.out.gain.cancelScheduledValues(now);
      v.out.gain.setTargetAtTime(0, now, KILL_TAU);
    }
    for (const s of v.sources) {
      try {
        s.stop(stopAt);
      } catch {
        /* already ended */
      }
    }
    v.end = stopAt + 0.01;
    if (this.fading.length >= FADING_CAP) {
      // pathological overload: drop the oldest fading voice at once
      const old = this.fading.shift();
      if (old) this.disconnect(old);
    }
    this.fading.push(v);
  }

  private disconnect(v: Voice): void {
    if (v.released) return;
    v.released = true;
    if (v.tail) v.tail.onended = null;
    for (const s of v.sources) {
      try {
        s.stop();
      } catch {
        /* never started or already stopped */
      }
    }
    for (const n of v.nodes) n.disconnect();
    this.stats.liveNodes -= v.nodes.length;
  }

  /** Called from a source's onended: the voice is over, free it wherever it is listed. */
  private release(v: Voice): void {
    if (v.released) return;
    let i = this.voices.indexOf(v);
    if (i >= 0) {
      this.voices[i] = this.voices[this.voices.length - 1];
      this.voices.pop();
    } else {
      i = this.fading.indexOf(v);
      if (i >= 0) this.fading.splice(i, 1);
    }
    this.disconnect(v);
  }

  /** Disconnects every voice whose time is over and idle loop layers. Cheap; called from play() and update(). */
  reap(): void {
    if (this.disposed) return;
    const now = this.now;
    const vs = this.voices;
    for (let i = vs.length - 1; i >= 0; i--) {
      const v = vs[i];
      if (now >= v.end) {
        vs[i] = vs[vs.length - 1];
        vs.pop();
        this.disconnect(v);
      }
    }
    const fs = this.fading;
    for (let i = fs.length - 1; i >= 0; i--) {
      const v = fs[i];
      if (now >= v.end) {
        fs.splice(i, 1);
        this.disconnect(v);
      }
    }
    for (const id of ['glide', 'thrust'] as const) {
      const l = this.loops[id];
      if (l.out && l.level <= 0 && now - l.silentSince >= LOOP_IDLE_SECONDS) this.teardownLoop(l);
    }
  }

  /** Kills every voice and loop within a few milliseconds (re-sortie, back to the garage). */
  stopAll(): void {
    if (this.disposed) return;
    const usable = this.usable;
    const now = usable ? this.now : 0;
    while (this.voices.length > 0) {
      if (usable) this.retire(this.voices.length - 1, now + KILL_SECONDS, true);
      else this.disconnect(this.voices.pop() as Voice);
    }
    for (const id of ['glide', 'thrust'] as const) {
      if (usable) this.killLoop(this.loops[id], now + KILL_SECONDS, true);
      else this.teardownLoop(this.loops[id]);
    }
    if (!usable) while (this.fading.length > 0) this.disconnect(this.fading.pop() as Voice);
    for (const id of SOUND_IDS) this.lastStart[id] = -1e9;
  }

  // ───────────────────────────── loop layers ─────────────────────────────

  /**
   * Sets the level (0…1) and timbre parameter (0…1) of a continuous layer. The layer is built on demand,
   * fades without clicks and is torn down after LOOP_IDLE_SECONDS of silence. Allocation-free while the
   * values do not change.
   */
  setLoop(id: LoopId, level: number, x: number): void {
    const l = this.loops[id];
    if (!l) return;
    let lv = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
    if (!this.canPlay || this.mode === 'paused') lv = 0;
    if (!l.out) {
      if (lv <= 0) return;
      this.buildLoop(l);
    }
    const out = l.out;
    if (!out || !this.usable) return;
    const now = this.now;
    const xv = Number.isFinite(x) ? x : 0;
    if (Math.abs(lv - l.level) > 0.015 || (lv === 0) !== (l.level === 0)) {
      // fade in over ~60 ms, out over ~120 ms (time constants; exponential approach, no clicks)
      out.gain.setTargetAtTime(lv * LOOPS[id].gain, now, lv > l.level ? 0.02 : 0.04);
      if (lv === 0) l.silentSince = now;
      l.level = lv;
    }
    if (Math.abs(xv - l.x) > 0.01 && l.voice && lv > 0) {
      l.voice.tune(xv, now);
      l.x = xv;
    }
  }

  private buildLoop(l: Loop): void {
    // a loop layer counts as a voice: when the mixer is full the least important one-shot gives way
    if (this.voices.length + this.loopCount() >= VOICE_CAP) this.evict(Infinity, Infinity, this.now);
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.gain.value = 0;
    const patch = new Patch(ctx, this.noise, this.now + LOOKAHEAD, out, this.rnd);
    l.voice = LOOPS[l.id].build(patch);
    out.connect(this.gameBus);
    l.out = out;
    l.nodes = patch.nodes;
    l.nodes.push(out);
    l.sources = patch.sources;
    l.level = 0;
    l.x = -1;
    l.silentSince = this.now;
    this.stats.liveNodes += l.nodes.length;
    if (this.stats.liveNodes > this.stats.peakNodes) this.stats.peakNodes = this.stats.liveNodes;
  }

  /** Hands the nodes of a running loop to the fading list (stopped at `stopAt`) and forgets the loop. */
  private killLoop(l: Loop, stopAt: number, fade: boolean): void {
    if (!l.out) return;
    const now = this.now;
    if (fade) {
      l.out.gain.cancelScheduledValues(now);
      l.out.gain.setTargetAtTime(0, now, KILL_TAU);
    }
    for (const s of l.sources) {
      try {
        s.stop(stopAt);
      } catch {
        /* already ended */
      }
    }
    const ghost: Voice = {
      id: 'ui-click',
      category: 'move',
      priority: 0,
      ui: false,
      start: now,
      end: stopAt + 0.01,
      level: 0,
      out: l.out,
      nodes: l.nodes,
      sources: l.sources,
      tail: null,
      released: false,
    };
    if (this.fading.length >= FADING_CAP) {
      const old = this.fading.shift();
      if (old) this.disconnect(old);
    }
    this.fading.push(ghost);
    l.out = null;
    l.nodes = [];
    l.sources = [];
    l.voice = null;
    l.level = 0;
  }

  private teardownLoop(l: Loop): void {
    if (!l.out) return;
    for (const s of l.sources) {
      try {
        s.stop();
      } catch {
        /* already ended */
      }
    }
    for (const n of l.nodes) n.disconnect();
    this.stats.liveNodes -= l.nodes.length;
    l.out = null;
    l.nodes = [];
    l.sources = [];
    l.voice = null;
    l.level = 0;
  }

  // ───────────────────────────── teardown ─────────────────────────────

  dispose(): void {
    if (this.disposed) return;
    while (this.voices.length > 0) this.disconnect(this.voices.pop() as Voice);
    while (this.fading.length > 0) this.disconnect(this.fading.pop() as Voice);
    this.teardownLoop(this.loops.glide);
    this.teardownLoop(this.loops.thrust);
    for (const n of this.chain) n.disconnect();
    this.disposed = true;
  }
}
