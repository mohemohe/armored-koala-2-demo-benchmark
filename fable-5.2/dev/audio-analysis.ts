/**
 * Signal measurements for the audio harness (dev/audio.ts) — pure functions on sample arrays, no DOM.
 * Not part of the game bundle.
 */

export interface Metrics {
  /** Largest absolute sample over all channels. */
  peak: number;
  /** RMS over the active span (mono mix), linear and in dBFS. */
  rms: number;
  rmsDb: number;
  /** Mean of the mono mix over the whole render (DC offset). */
  dc: number;
  /** First / last time the signal is above -50 dB relative to its peak, and the span between them. */
  start: number;
  end: number;
  duration: number;
  /** Spectral centroid of the active span (Hz), and of its first / second half (pitch contour). */
  centroid: number;
  centroidA: number;
  centroidB: number;
  /** Octave band holding the most energy, and the frequency of the strongest FFT bin. */
  band: string;
  peakFreq: number;
  /** Channel balance: 20·log10(rmsRight / rmsLeft); 0 for mono / centred. */
  balanceDb: number;
  /** Energy above 200 Hz relative to the total, in dB (0 = everything; small speakers reproduce only that part). */
  above200Db: number;
  /**
   * Loudness proxy in dB: A-weighted RMS of the active span, minus 10·log10(0.2 s / duration) for sounds
   * shorter than 0.2 s (the ear integrates over roughly that time). Only meaningful for comparing sounds.
   */
  loudnessDb: number;
}

/** A-weighting as a power factor (IEC 61672). */
export function aWeight(f: number): number {
  const f2 = f * f;
  const ra = (12194 * 12194 * f2 * f2) / ((f2 + 20.6 * 20.6) * Math.sqrt((f2 + 107.7 * 107.7) * (f2 + 737.9 * 737.9)) * (f2 + 12194 * 12194));
  return ra * ra * 1.5849; // +2.0 dB
}

const FFT_SIZE = 2048;

/** In-place iterative radix-2 FFT. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

/** Power spectrum (FFT_SIZE / 2 bins) of data[from, to), Hann windows with 75 % overlap, summed. */
export function powerSpectrum(data: Float32Array, from: number, to: number): Float64Array {
  const n = FFT_SIZE;
  const out = new Float64Array(n / 2);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const hop = n / 4;
  const win = new Float64Array(n);
  for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  // start half a window early so that a short sound is fully covered by overlapping windows
  for (let pos = from - n / 2; pos < to; pos += hop) {
    let any = false;
    for (let i = 0; i < n; i++) {
      const k = pos + i;
      const v = k >= from && k < to && k >= 0 && k < data.length ? data[k] : 0;
      if (v !== 0) any = true;
      re[i] = v * win[i];
      im[i] = 0;
    }
    if (!any) continue;
    fft(re, im);
    for (let i = 0; i < n / 2; i++) out[i] += re[i] * re[i] + im[i] * im[i];
  }
  return out;
}

const OCTAVES: Array<[string, number, number]> = [
  ['<125 Hz', 0, 125],
  ['125-250 Hz', 125, 250],
  ['250-500 Hz', 250, 500],
  ['0.5-1 kHz', 500, 1000],
  ['1-2 kHz', 1000, 2000],
  ['2-4 kHz', 2000, 4000],
  ['4-8 kHz', 4000, 8000],
  ['>8 kHz', 8000, 1e9],
];

function centroidOf(spec: Float64Array, sampleRate: number): number {
  let num = 0;
  let den = 0;
  const binHz = sampleRate / FFT_SIZE;
  for (let i = 1; i < spec.length; i++) {
    num += i * binHz * spec[i];
    den += spec[i];
  }
  return den > 0 ? num / den : 0;
}

/** Mono mix of the channels. */
export function monoMix(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const n = channels[0].length;
  const out = new Float32Array(n);
  for (const c of channels) for (let i = 0; i < n; i++) out[i] += c[i] / channels.length;
  return out;
}

export function analyse(channels: Float32Array[], sampleRate: number): Metrics {
  const mono = monoMix(channels);
  const n = mono.length;
  let peak = 0;
  for (const c of channels) for (let i = 0; i < n; i++) if (Math.abs(c[i]) > peak) peak = Math.abs(c[i]);
  let monoPeak = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += mono[i];
    if (Math.abs(mono[i]) > monoPeak) monoPeak = Math.abs(mono[i]);
  }
  const dc = n > 0 ? sum / n : 0;
  const thr = Math.max(monoPeak * 0.00316, 1e-5);
  let first = -1;
  let last = -1;
  for (let i = 0; i < n; i++) {
    if (Math.abs(mono[i]) > thr) {
      if (first < 0) first = i;
      last = i;
    }
  }
  const empty: Metrics = {
    peak,
    rms: 0,
    rmsDb: -Infinity,
    dc,
    start: 0,
    end: 0,
    duration: 0,
    centroid: 0,
    centroidA: 0,
    centroidB: 0,
    band: '-',
    peakFreq: 0,
    balanceDb: 0,
    above200Db: 0,
    loudnessDb: -Infinity,
  };
  if (first < 0) return empty;
  let sq = 0;
  for (let i = first; i <= last; i++) sq += mono[i] * mono[i];
  const rms = Math.sqrt(sq / (last - first + 1));
  const mid = (first + last + 1) >> 1;
  const spec = powerSpectrum(mono, first, last + 1);
  const binHz = sampleRate / FFT_SIZE;
  let best = 0;
  for (let i = 1; i < spec.length; i++) if (spec[i] > spec[best]) best = i;
  let band = '-';
  let bandEnergy = -1;
  for (const [name, lo, hi] of OCTAVES) {
    let e = 0;
    for (let i = 1; i < spec.length; i++) {
      const f = i * binHz;
      if (f >= lo && f < hi) e += spec[i];
    }
    if (e > bandEnergy) {
      bandEnergy = e;
      band = name;
    }
  }
  let total = 0;
  let upper = 0;
  let weighted = 0;
  for (let i = 1; i < spec.length; i++) {
    total += spec[i];
    if (i * binHz >= 200) upper += spec[i];
    weighted += spec[i] * aWeight(i * binHz);
  }
  const seconds = (last + 1 - first) / sampleRate;
  const loudnessDb = total > 0 && weighted > 0 ? 20 * Math.log10(rms) + 10 * Math.log10(weighted / total) + Math.min(0, 10 * Math.log10(seconds / 0.2)) : -Infinity;
  const above200Db = total > 0 && upper > 0 ? 10 * Math.log10(upper / total) : -99;
  let balanceDb = 0;
  if (channels.length >= 2) {
    let l = 0;
    let r = 0;
    for (let i = first; i <= last; i++) {
      l += channels[0][i] * channels[0][i];
      r += channels[1][i] * channels[1][i];
    }
    balanceDb = l > 0 && r > 0 ? 10 * Math.log10(r / l) : r > l ? 99 : l > r ? -99 : 0;
  }
  return {
    peak,
    rms,
    rmsDb: 20 * Math.log10(rms),
    dc,
    start: first / sampleRate,
    end: (last + 1) / sampleRate,
    duration: (last + 1 - first) / sampleRate,
    centroid: centroidOf(spec, sampleRate),
    centroidA: centroidOf(powerSpectrum(mono, first, mid), sampleRate),
    centroidB: centroidOf(powerSpectrum(mono, mid, last + 1), sampleRate),
    band,
    peakFreq: best * binHz,
    balanceDb,
    above200Db,
    loudnessDb,
  };
}

/** Energy in third-octave bands from 40 Hz to 16 kHz (27 bands) over the active span. */
export function thirdOctaves(mono: Float32Array, sampleRate: number): Float64Array {
  const spec = powerSpectrum(mono, 0, mono.length);
  const binHz = sampleRate / FFT_SIZE;
  const out = new Float64Array(27);
  for (let b = 0; b < out.length; b++) {
    const fc = 40 * Math.pow(2, b / 3);
    const lo = fc / Math.pow(2, 1 / 6);
    const hi = fc * Math.pow(2, 1 / 6);
    for (let i = 1; i < spec.length; i++) {
      const f = i * binHz;
      if (f >= lo && f < hi) out[b] += spec[i];
    }
  }
  return out;
}

/** RMS envelope in 4 ms hops, starting at the first audible sample, normalised to its maximum. */
export function envelope(mono: Float32Array, sampleRate: number): Float64Array {
  let peak = 0;
  for (let i = 0; i < mono.length; i++) if (Math.abs(mono[i]) > peak) peak = Math.abs(mono[i]);
  const thr = Math.max(peak * 0.00316, 1e-5);
  let first = 0;
  while (first < mono.length && Math.abs(mono[first]) <= thr) first++;
  const hop = Math.max(1, Math.round(sampleRate * 0.004));
  const frames = Math.max(1, Math.ceil((mono.length - first) / hop));
  const out = new Float64Array(frames);
  let max = 0;
  for (let f = 0; f < frames; f++) {
    let sq = 0;
    for (let i = 0; i < hop; i++) {
      const v = mono[first + f * hop + i] ?? 0;
      sq += v * v;
    }
    out[f] = Math.sqrt(sq / hop);
    if (out[f] > max) max = out[f];
  }
  if (max > 0) for (let f = 0; f < frames; f++) out[f] /= max;
  return out;
}

export interface Difference {
  /** Cosine similarity of the third-octave energy vectors (1 = identical spectrum shape). */
  spectralCosine: number;
  /** RMS difference of the third-octave levels in dB (each normalised to its own total, floor -50 dB). */
  spectralDb: number;
  /** Correlation of the 4 ms RMS envelopes (onset-aligned, zero padded to the longer one). */
  envelopeCorr: number;
  /** Ratio of the spectral centroids (>= 1). */
  centroidRatio: number;
  /** Ratio of the durations (>= 1). */
  durationRatio: number;
  /** Largest normalised cross-correlation of the waveforms within ±10 ms. */
  waveCorr: number;
}

export function difference(a: Float32Array, b: Float32Array, sampleRate: number, ma: Metrics, mb: Metrics): Difference {
  const ta = thirdOctaves(a, sampleRate);
  const tb = thirdOctaves(b, sampleRate);
  let dot = 0;
  let na = 0;
  let nb = 0;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < ta.length; i++) {
    dot += ta[i] * tb[i];
    na += ta[i] * ta[i];
    nb += tb[i] * tb[i];
    sa += ta[i];
    sb += tb[i];
  }
  let dsq = 0;
  for (let i = 0; i < ta.length; i++) {
    const la = Math.max(-50, 10 * Math.log10(ta[i] / sa + 1e-12));
    const lb = Math.max(-50, 10 * Math.log10(tb[i] / sb + 1e-12));
    dsq += (la - lb) * (la - lb);
  }
  const ea = envelope(a, sampleRate);
  const eb = envelope(b, sampleRate);
  const len = Math.max(ea.length, eb.length);
  let ed = 0;
  let eaa = 0;
  let ebb = 0;
  for (let i = 0; i < len; i++) {
    const x = ea[i] ?? 0;
    const y = eb[i] ?? 0;
    ed += x * y;
    eaa += x * x;
    ebb += y * y;
  }
  // waveform correlation (onset-aligned, searched over ±10 ms)
  const sA = Math.round(ma.start * sampleRate);
  const sB = Math.round(mb.start * sampleRate);
  const span = Math.round(Math.min(ma.duration, mb.duration) * sampleRate);
  const maxLag = Math.round(0.01 * sampleRate);
  let waveCorr = 0;
  let ea2 = 0;
  let eb2 = 0;
  for (let i = 0; i < span; i++) {
    ea2 += a[sA + i] * a[sA + i];
    eb2 += b[sB + i] * b[sB + i];
  }
  if (ea2 > 0 && eb2 > 0) {
    for (let lag = -maxLag; lag <= maxLag; lag += 2) {
      let c = 0;
      for (let i = 0; i < span; i += 2) c += a[sA + i] * (b[sB + i + lag] ?? 0);
      const v = Math.abs((2 * c) / Math.sqrt(ea2 * eb2));
      if (v > waveCorr) waveCorr = v;
    }
  }
  const ratio = (x: number, y: number): number => (x > 0 && y > 0 ? Math.max(x / y, y / x) : Infinity);
  return {
    spectralCosine: na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0,
    spectralDb: Math.sqrt(dsq / ta.length),
    envelopeCorr: eaa > 0 && ebb > 0 ? ed / Math.sqrt(eaa * ebb) : 0,
    centroidRatio: ratio(ma.centroid, mb.centroid),
    durationRatio: ratio(ma.duration, mb.duration),
    waveCorr,
  };
}

/** Largest absolute difference between consecutive samples in [from, to) seconds (click detector). */
export function maxStep(mono: Float32Array, sampleRate: number, from: number, to: number): number {
  const a = Math.max(1, Math.floor(from * sampleRate));
  const b = Math.min(mono.length, Math.ceil(to * sampleRate));
  let m = 0;
  for (let i = a; i < b; i++) {
    const d = Math.abs(mono[i] - mono[i - 1]);
    if (d > m) m = d;
  }
  return m;
}

/** Peak / RMS of [from, to) seconds. */
export function levelBetween(mono: Float32Array, sampleRate: number, from: number, to: number): { peak: number; rms: number } {
  const a = Math.max(0, Math.floor(from * sampleRate));
  const b = Math.min(mono.length, Math.ceil(to * sampleRate));
  let peak = 0;
  let sq = 0;
  for (let i = a; i < b; i++) {
    const v = Math.abs(mono[i]);
    if (v > peak) peak = v;
    sq += v * v;
  }
  return { peak, rms: b > a ? Math.sqrt(sq / (b - a)) : 0 };
}
