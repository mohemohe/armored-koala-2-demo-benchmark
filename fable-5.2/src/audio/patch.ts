/**
 * Low-level building blocks of the procedural sound engine: noise buffers and the per-voice graph builder.
 *
 * Everything here targets a BaseAudioContext, so the very same graph code runs in the live AudioContext of
 * the game and in an OfflineAudioContext (dev/audio.ts renders every sound offline and measures it).
 * No audio files, no samples: oscillators, generated noise, filters and envelopes only.
 */

export type Ctx = BaseAudioContext;
export type NoiseKind = 'white' | 'pink' | 'brown' | 'crackle';

/**
 * Small deterministic PRNG (xorshift32) for sound variation — never the gameplay stream. The state lives in
 * a typed array: a plain closure variable would be boxed as a heap number on every call.
 */
export function makeRandom(seed: number): () => number {
  const state = new Uint32Array(1);
  state[0] = seed >>> 0 || 0x9e3779b9;
  return () => {
    let s = state[0];
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    state[0] = s;
    return (s >>> 0) / 4294967296;
  };
}

const NOISE_SECONDS = 2;
/** Length of the tail that is cross-faded into the head so a looping buffer has no seam. */
const SEAM_SECONDS = 0.05;

/** Fills `out` with white noise in [-1, 1). The generator is inlined: this loop runs for seconds of audio. */
function fillWhite(out: Float32Array, seed: number): void {
  let s = seed | 0 || 0x9e3779b9;
  for (let i = 0; i < out.length; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    out[i] = (s >>> 0) / 2147483648 - 1;
  }
}

/** Fills `out` (length n + seam) with raw noise of the given colour. */
function generateRaw(kind: NoiseKind, out: Float32Array, sampleRate: number, seed: number): void {
  const n = out.length;
  fillWhite(out, seed);
  if (kind === 'white') return;
  if (kind === 'pink') {
    // Paul Kellet's economy pink filter (-3 dB / octave within about 0.5 dB).
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    for (let i = 0; i < n; i++) {
      const w = out[i];
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      out[i] = b0 + b1 + b2 + w * 0.1848;
    }
    return;
  }
  if (kind === 'brown') {
    // Leaky integrator (-6 dB / octave above ~25 Hz), independent of the sample rate.
    const leak = Math.exp((-2 * Math.PI * 25) / sampleRate);
    let acc = 0;
    for (let i = 0; i < n; i++) {
      acc = acc * leak + out[i];
      out[i] = acc;
    }
    return;
  }
  // 'crackle': sparse random ticks (about 45 per second), each a sub-millisecond decaying spike.
  const density = 45 / sampleRate;
  const decay = Math.exp(-1 / (0.0004 * sampleRate));
  let level = 0;
  let s = (seed ^ 0x2545f491) | 0 || 1;
  for (let i = 0; i < n; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    const u = (s >>> 0) / 4294967296;
    // u < density starts a tick; the same number (rescaled to 0…1) gives its size and sign
    if (u < density) {
      const v = u / density;
      level = (v < 0.5 ? -1 : 1) * (0.35 + 0.65 * Math.abs(2 * v - 1));
    }
    out[i] = level * (0.6 + 0.4 * out[i]);
    level *= decay;
  }
}

/** RMS level every noise buffer is normalised to (the peak stays below 1 for all colours). */
const NOISE_RMS: Record<NoiseKind, number> = { white: 0.4, pink: 0.25, brown: 0.3, crackle: 0.12 };
const NOISE_SEED: Record<NoiseKind, number> = { white: 0x1234abcd, pink: 0x51f15eed, brown: 0x0badcafe, crackle: 0x7ac0beef };

/** Zero-mean, seamless-looping, level-normalised noise of `seconds` at `sampleRate` (pure, testable). */
export function generateNoise(kind: NoiseKind, sampleRate: number, seconds = NOISE_SECONDS): Float32Array {
  const n = Math.max(16, Math.floor(seconds * sampleRate));
  const seam = Math.min(n >> 1, Math.max(1, Math.floor(SEAM_SECONDS * sampleRate)));
  const raw = new Float32Array(n + seam);
  generateRaw(kind, raw, sampleRate, NOISE_SEED[kind]);
  // The head is a cross-fade from the continuation of the tail into the head itself: sample n-1 is followed
  // (after the loop wraps) by something that starts as raw[n] — no discontinuity for any colour.
  const out = raw.subarray(0, n);
  for (let i = 0; i < seam; i++) {
    const a = i / seam;
    out[i] = raw[i] * a + raw[n + i] * (1 - a);
  }
  let mean = 0;
  for (let i = 0; i < n; i++) mean += out[i];
  mean /= n;
  let sq = 0;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    out[i] -= mean;
    sq += out[i] * out[i];
    const a = Math.abs(out[i]);
    if (a > peak) peak = a;
  }
  const rms = Math.sqrt(sq / n);
  let k = rms > 1e-9 ? NOISE_RMS[kind] / rms : 0;
  if (peak * k > 0.98) k = 0.98 / peak;
  for (let i = 0; i < n; i++) out[i] *= k;
  return out;
}

/** Lazily generated noise buffers of one context (shared by all its voices). */
export class NoiseBank {
  private readonly buffers: Partial<Record<NoiseKind, AudioBuffer>> = {};
  constructor(private readonly ctx: Ctx) {}

  get(kind: NoiseKind): AudioBuffer {
    let b = this.buffers[kind];
    if (!b) {
      const data = generateNoise(kind, this.ctx.sampleRate);
      b = this.ctx.createBuffer(1, data.length, this.ctx.sampleRate);
      b.getChannelData(0).set(data);
      this.buffers[kind] = b;
    }
    return b;
  }

  /** Generates every colour now (called once at unlock so the first shot does not pay for it). */
  warm(): void {
    this.get('white');
    this.get('pink');
    this.get('brown');
    this.get('crackle');
  }
}

/** A value that is safe to hand to an AudioParam / exponential ramp. */
const pos = (v: number, min = 1e-4): number => (Number.isFinite(v) && v > min ? v : min);

/**
 * Builder for one voice (a one-shot sound or a loop layer). It creates nodes, remembers every one of them
 * (so the owner can disconnect the lot when the voice ends) and starts / stops the sources.
 *
 * Times given to the helper methods are RELATIVE to `t` (the start of the voice) unless stated otherwise.
 */
export class Patch {
  readonly nodes: AudioNode[] = [];
  readonly sources: AudioScheduledSourceNode[] = [];
  /** Sources without an explicit stop time; finish() stops them at the end of the voice. */
  private readonly open: AudioScheduledSourceNode[] = [];
  /** The source that stops last and the absolute time at which it does (valid after finish()). */
  tail: AudioScheduledSourceNode | null = null;
  end = 0;

  constructor(
    readonly ctx: Ctx,
    private readonly noiseBank: NoiseBank,
    /** Absolute context time at which the voice starts. */
    readonly t: number,
    /** Everything audible must end up here. */
    readonly out: AudioNode,
    /** Variation source (uniform 0..1). */
    readonly rnd: () => number,
  ) {}

  /** Random factor in [1 - spread, 1 + spread]. */
  vary(spread: number): number {
    return 1 + (this.rnd() * 2 - 1) * spread;
  }

  private track<T extends AudioNode>(n: T): T {
    this.nodes.push(n);
    return n;
  }

  private schedule(src: AudioScheduledSourceNode, start: number, stop: number, offset = -1): void {
    const at = this.t + Math.max(0, start);
    if (offset >= 0) (src as AudioBufferSourceNode).start(at, offset);
    else src.start(at);
    if (stop >= 0) {
      const end = this.t + Math.max(start + 0.001, stop);
      src.stop(end);
      if (end > this.end) {
        this.end = end;
        this.tail = src;
      }
    } else {
      this.open.push(src);
    }
    this.sources.push(src);
  }

  /** Oscillator running from `start` to `stop` (default: the whole voice). */
  osc(type: OscillatorType, freq: number, start = 0, stop = -1): OscillatorNode {
    const o = this.track(this.ctx.createOscillator());
    o.type = type;
    o.frequency.value = pos(freq, 1);
    this.schedule(o, start, stop);
    return o;
  }

  /** Looping noise source, started at a random position of the shared buffer. */
  noise(kind: NoiseKind, start = 0, stop = -1, rate = 1): AudioBufferSourceNode {
    const s = this.track(this.ctx.createBufferSource());
    const buf = this.noiseBank.get(kind);
    s.buffer = buf;
    s.loop = true;
    s.playbackRate.value = pos(rate, 0.01);
    this.schedule(s, start, stop, this.rnd() * Math.max(0, buf.duration - 0.01));
    return s;
  }

  gain(value = 0): GainNode {
    const g = this.track(this.ctx.createGain());
    g.gain.value = value;
    return g;
  }

  filter(type: BiquadFilterType, freq: number, q = 0.707): BiquadFilterNode {
    const f = this.track(this.ctx.createBiquadFilter());
    f.type = type;
    f.frequency.value = pos(freq, 10);
    f.Q.value = q;
    return f;
  }

  /** Connects the nodes in series and the last one to the voice output. Returns the first node. */
  chain(...nodes: AudioNode[]): AudioNode {
    for (let i = 0; i + 1 < nodes.length; i++) nodes[i].connect(nodes[i + 1]);
    nodes[nodes.length - 1].connect(this.out);
    return nodes[0];
  }

  /** Connects the nodes in series WITHOUT routing the last one anywhere (modulators, side branches). */
  series(...nodes: AudioNode[]): AudioNode {
    for (let i = 0; i + 1 < nodes.length; i++) nodes[i].connect(nodes[i + 1]);
    return nodes[nodes.length - 1];
  }

  /**
   * Percussive envelope: 0 → peak (linear, `attack` s) → -60 dB (exponential, `decay` s) → exactly 0.
   * Returns the relative time at which the envelope has reached 0.
   */
  perc(param: AudioParam, at: number, peak: number, attack: number, decay: number): number {
    const t0 = this.t + Math.max(0, at);
    const a = Math.max(0.0005, attack);
    const d = Math.max(0.002, decay);
    const pk = pos(peak);
    param.setValueAtTime(0, t0);
    param.linearRampToValueAtTime(pk, t0 + a);
    param.exponentialRampToValueAtTime(pk * 0.001, t0 + a + d);
    param.linearRampToValueAtTime(0, t0 + a + d + 0.003);
    return at + a + d + 0.003;
  }

  /**
   * Sustained envelope: 0 → from (attack) → to (linear over `sustain`) → 0 (linear `release`).
   * Returns the relative end time.
   */
  hold(param: AudioParam, at: number, from: number, to: number, attack: number, sustain: number, release: number): number {
    const t0 = this.t + Math.max(0, at);
    const a = Math.max(0.0005, attack);
    const s = Math.max(0, sustain);
    const r = Math.max(0.002, release);
    param.setValueAtTime(0, t0);
    param.linearRampToValueAtTime(Math.max(0, from), t0 + a);
    param.linearRampToValueAtTime(Math.max(0, to), t0 + a + s);
    param.linearRampToValueAtTime(0, t0 + a + s + r);
    return at + a + s + r;
  }

  /** Exponential glide of a (strictly positive) parameter such as a frequency. */
  glide(param: AudioParam, at: number, from: number, to: number, time: number): void {
    const t0 = this.t + Math.max(0, at);
    param.setValueAtTime(pos(from, 1), t0);
    param.exponentialRampToValueAtTime(pos(to, 1), t0 + Math.max(0.001, time));
  }

  /**
   * Stops every source that has no explicit stop time at `duration` (relative; never before a source with
   * an explicit stop time ends). Afterwards `end` / `tail` describe the end of the whole voice.
   */
  finish(duration: number): void {
    const at = Math.max(this.end, this.t + Math.max(0.005, duration));
    for (const s of this.open) s.stop(at);
    if (this.open.length > 0) this.tail = this.open[0];
    this.end = at;
    this.open.length = 0;
  }
}
