/**
 * The sound bank: every sound of the game as a small synthesis patch (original designs, no samples).
 *
 * A patch builds its graph into a `Patch` (see patch.ts) and returns its duration in seconds. The mixer
 * adds level, stereo placement, voice limiting and the master chain. Design goal: function first — each
 * family has its own register / timbre / contour so the fight can be read by ear:
 *
 *   player machine gun   broadband crack + falling thump, 90 ms          (noise, no pitch)
 *   player beam          FM zap falling 1.7 kHz → 0.5 kHz, 240 ms         (clearly pitched)
 *   enemy telegraph      RISING chirp — guard: clean, 1–2 kHz, 0.13 s; turret: buzzing, 0.25–0.76 kHz, 0.32 s
 *   enemy shot           FALLING bolt — guard: thin square 820 → 300 Hz; turret: heavy saw 300 → 70 Hz
 *   hit confirmation     two inharmonic high partials (metallic tick)
 *   damage taken         low clang + noise, heavier for turret shells
 *   lock                 two clean pips on one pitch, 880 Hz (acquired) / one falling pip (lost)
 *   rejected actions     dull low ticks (never bright): no lock = two pips, no EN = one falling tone,
 *                        no ammo = dry click
 */
import { WEAPONS } from '../config';
import type { Patch } from './patch';
import type { Rolloff } from './spatial';

export type Category =
  | 'ui'
  | 'jingle'
  | 'progress'
  | 'status'
  | 'weapon'
  | 'damage'
  | 'move'
  | 'explosion'
  | 'telegraph'
  | 'enemyshot'
  | 'impact'
  | 'alert';

export interface CategoryDef {
  /** Higher wins when the voice cap forces a choice. */
  priority: number;
  /** Maximum simultaneous voices of the category. */
  max: number;
  /** 'game' voices are silenced by a pause; 'ui' voices (menu sounds, result jingles) are not. */
  bus: 'game' | 'ui';
}

export const CATEGORIES: Record<Category, CategoryDef> = {
  ui: { priority: 100, max: 3, bus: 'ui' },
  jingle: { priority: 95, max: 2, bus: 'ui' },
  progress: { priority: 90, max: 3, bus: 'game' },
  status: { priority: 85, max: 3, bus: 'game' },
  weapon: { priority: 80, max: 6, bus: 'game' },
  damage: { priority: 75, max: 3, bus: 'game' },
  move: { priority: 70, max: 4, bus: 'game' },
  explosion: { priority: 65, max: 4, bus: 'game' },
  telegraph: { priority: 60, max: 5, bus: 'game' },
  enemyshot: { priority: 50, max: 7, bus: 'game' },
  impact: { priority: 40, max: 6, bus: 'game' },
  alert: { priority: 30, max: 2, bus: 'game' },
};

export interface SoundArgs {
  /** Free integer selector (weapon index, alternating barrel, …). */
  variant: number;
  /** 0…1 strength (landing speed, damage amount, …). */
  intensity: number;
  /** Requested length in seconds for sounds that follow a game timer (telegraphs); 0 = nominal. */
  duration: number;
}

export interface SoundDef {
  category: Category;
  /** Linear level of the voice (the patch itself peaks around 1). */
  gain: number;
  /** Designed upper bound of the duration in seconds (verified offline by dev/audio.ts). */
  maxSeconds: number;
  /** Minimum time between two starts of this sound. */
  minInterval: number;
  /** A start may be postponed by up to this long to honour minInterval; later than that it is dropped. */
  maxDelay: number;
  /**
   * Sustained-fire sound whose minInterval is the weapon's fire interval. Shot events reach the engine
   * quantised to video frames; a shot that arrives a little "early" is placed one interval (minus half a
   * percent) after the previous one, so held fire keeps an even rhythm on the audio clock whatever the frame
   * rate. After a frame hitch the mixer shortens the interval more until the sound has caught up.
   */
  rhythm?: boolean;
  /** Stereo placement / distance law for sounds that have a world position (undefined = centred). */
  rolloff?: Rolloff;
  /** Builds the graph; returns the duration in seconds. */
  build(p: Patch, a: SoundArgs): number;
}

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
/** Duration requested by the game, limited to what the patch supports. */
const fit = (requested: number, lo: number, nominal: number): number =>
  requested > 0 && Number.isFinite(requested) ? clamp(requested, lo, nominal) : nominal;

// ───────────────────────────── shared sub-patches ─────────────────────────────

/** One enveloped oscillator note routed to the voice output. Returns its end time. */
function note(
  p: Patch,
  type: OscillatorType,
  freq: number,
  at: number,
  peak: number,
  attack: number,
  decay: number,
  glideTo = 0,
  glideTime = 0,
): number {
  const end = at + attack + decay + 0.01;
  const o = p.osc(type, freq, at, end);
  if (glideTo > 0) p.glide(o.frequency, at, freq, glideTo, glideTime > 0 ? glideTime : decay);
  const g = p.gain();
  p.perc(g.gain, at, peak, attack, decay);
  p.chain(o, g);
  return end;
}

/** A burst of filtered noise routed to the voice output. Returns its end time. */
function burst(
  p: Patch,
  kind: 'white' | 'pink' | 'brown' | 'crackle',
  filterType: BiquadFilterType,
  freq: number,
  q: number,
  at: number,
  peak: number,
  attack: number,
  decay: number,
  glideTo = 0,
  glideTime = 0,
): number {
  const end = at + attack + decay + 0.01;
  const n = p.noise(kind, at, end);
  const f = p.filter(filterType, freq, q);
  if (glideTo > 0) p.glide(f.frequency, at, freq, glideTo, glideTime > 0 ? glideTime : decay);
  const g = p.gain();
  p.perc(g.gain, at, peak, attack, decay);
  p.chain(n, f, g);
  return end;
}

/** Struck-metal cluster: inharmonic sine partials with individual decays. */
function clank(p: Patch, at: number, base: number, level: number, length: number): void {
  const ratios = [1, 1.68, 2.53, 3.57, 5.27];
  for (let i = 0; i < ratios.length; i++) {
    note(p, 'sine', base * ratios[i], at, (level * (1 - i * 0.16)) / 2.2, 0.001, length / (1 + i * 0.7));
  }
  burst(p, 'white', 'bandpass', base * 10, 0.8, at, level * 0.45, 0.001, 0.025);
}

/** Explosion of `size` (0.5 small … 1.3 large): filtered noise body, falling sub, crack, optional debris. */
function boom(p: Patch, size: number): number {
  const dur = 0.4 + 0.7 * size;
  const k = p.vary(0.06);
  burst(p, 'pink', 'lowpass', (2600 + 900 * size) * k, 0.6, 0, 2.2, 0.004, dur - 0.03, 170, dur * 0.5);
  const f0 = (105 / Math.sqrt(size)) * k;
  note(p, 'sine', f0, 0, 0.55, 0.003, 0.25 + 0.3 * size, 34, 0.2 + 0.1 * size);
  burst(p, 'white', 'bandpass', 2300 * k, 0.6, 0, 0.9, 0.001, 0.035);
  if (size >= 0.85) burst(p, 'crackle', 'highpass', 1800, 0.7, 0.05, 1.6 * size, 0.03, dur - 0.15);
  return dur;
}

/** Soft sine pip with a hint of the octave (status / UI tones). */
function pip(p: Patch, freq: number, at: number, peak: number, decay: number, glideTo = 0): number {
  note(p, 'sine', freq * 2, at, peak * 0.14, 0.004, decay * 0.6, glideTo * 2, decay);
  return note(p, 'sine', freq, at, peak, 0.004, decay, glideTo, decay);
}

// ───────────────────────────── the bank ─────────────────────────────

const def = (d: SoundDef): SoundDef => d;

export const SOUNDS = {
  // ── player weapons ──
  /** Machine gun: 90 ms, no sustained pitch; alternating ±6 % colour keeps 10 shots/s from buzzing. */
  mg: def({
    category: 'weapon',
    gain: 0.205,
    maxSeconds: 0.11,
    minInterval: WEAPONS.machinegun.interval,
    maxDelay: 0.25,
    rhythm: true,
    build(p, a) {
      const k = p.vary(0.035) * ((a.variant & 1) === 1 ? 0.94 : 1);
      const n = p.noise('white');
      const bp = p.filter('bandpass', 1500 * k, 0.7);
      const lp = p.filter('lowpass', 4200, 0.5);
      const ng = p.gain();
      p.perc(ng.gain, 0, 2.4, 0.001, 0.05);
      p.chain(n, bp, lp, ng);
      note(p, 'triangle', 200 * k, 0, 0.45, 0.001, 0.07, 82 * k, 0.05);
      return 0.09;
    },
  }),
  /** Beam: FM zap with a clear falling pitch. */
  beam: def({
    category: 'weapon',
    gain: 0.27,
    maxSeconds: 0.27,
    minInterval: WEAPONS.beam.interval,
    maxDelay: 0.3,
    rhythm: true,
    build(p) {
      const k = p.vary(0.02);
      const car = p.osc('sine', 1700 * k);
      p.glide(car.frequency, 0, 1700 * k, 540 * k, 0.17);
      const mod = p.osc('sine', 3417 * k);
      p.glide(mod.frequency, 0, 3417 * k, 1085 * k, 0.17);
      const depth = p.gain(1100);
      p.glide(depth.gain, 0, 1100, 120, 0.2);
      p.series(mod, depth).connect(car.frequency);
      const cg = p.gain();
      p.perc(cg.gain, 0, 0.8, 0.003, 0.22);
      p.chain(car, cg);
      const saw = p.osc('sawtooth', 850 * k);
      p.glide(saw.frequency, 0, 850 * k, 270 * k, 0.17);
      const bp = p.filter('bandpass', 1700 * k, 3);
      p.glide(bp.frequency, 0, 1700 * k, 600 * k, 0.17);
      const sg = p.gain();
      p.perc(sg.gain, 0, 0.6, 0.004, 0.2);
      p.chain(saw, bp, sg);
      burst(p, 'white', 'highpass', 3200, 0.7, 0, 0.22, 0.001, 0.05);
      return 0.24;
    },
  }),
  /** Missile launch: low kick, then a whoosh that rises as the missile leaves. */
  'missile-launch': def({
    category: 'weapon',
    gain: 0.4,
    maxSeconds: 0.62,
    minInterval: 0.2,
    maxDelay: 0.3,
    build(p) {
      const k = p.vary(0.04);
      note(p, 'sine', 150 * k, 0, 0.6, 0.002, 0.11, 58, 0.07);
      const n = p.noise('pink');
      const bp = p.filter('bandpass', 480 * k, 1.3);
      p.glide(bp.frequency, 0, 480 * k, 2300 * k, 0.45);
      const ng = p.gain();
      p.hold(ng.gain, 0, 3.0, 0.5, 0.03, 0.3, 0.22);
      p.chain(n, bp, ng);
      const saw = p.osc('sawtooth', 92 * k);
      p.glide(saw.frequency, 0, 92 * k, 150 * k, 0.4);
      const lp = p.filter('lowpass', 620, 0.8);
      const sg = p.gain();
      p.hold(sg.gain, 0, 0.3, 0.05, 0.02, 0.3, 0.2);
      p.chain(saw, lp, sg);
      return 0.57;
    },
  }),
  /** Fire refused, three dull variants: no lock (two 440 Hz pips), no EN (one falling tone), no ammo (dry click). */
  'reject-nolock': def({
    category: 'weapon',
    gain: 0.32,
    maxSeconds: 0.16,
    minInterval: 0.2,
    maxDelay: 0,
    build(p) {
      const lp = p.filter('lowpass', 1300, 0.7);
      lp.connect(p.out);
      for (let i = 0; i < 2; i++) {
        const at = i * 0.07;
        const o = p.osc('triangle', 440, at, at + 0.06);
        const g = p.gain();
        p.perc(g.gain, at, 0.9, 0.002, 0.045);
        o.connect(g);
        g.connect(lp);
      }
      return 0.14;
    },
  }),
  'reject-noen': def({
    category: 'weapon',
    gain: 0.3,
    maxSeconds: 0.16,
    minInterval: 0.2,
    maxDelay: 0,
    build(p) {
      const o = p.osc('triangle', 290);
      p.glide(o.frequency, 0, 290, 140, 0.09);
      const lp = p.filter('lowpass', 600, 0.7);
      const g = p.gain();
      p.perc(g.gain, 0, 0.9, 0.003, 0.14);
      p.chain(o, lp, g);
      return 0.155;
    },
  }),
  'reject-noammo': def({
    category: 'weapon',
    gain: 0.44,
    maxSeconds: 0.12,
    minInterval: 0.2,
    maxDelay: 0,
    build(p) {
      burst(p, 'white', 'bandpass', 1150, 1.5, 0, 1.8, 0.001, 0.014);
      note(p, 'triangle', 230, 0.012, 0.8, 0.002, 0.05);
      return 0.09;
    },
  }),
  /** Weapon switch: latch click + a blip whose pitch names the slot (1 low, 2 mid, 3 high). */
  switch: def({
    category: 'weapon',
    gain: 0.29,
    maxSeconds: 0.12,
    minInterval: 0.05,
    maxDelay: 0,
    build(p, a) {
      burst(p, 'white', 'bandpass', 2900, 2, 0, 0.7, 0.001, 0.012);
      const f = [520, 700, 930][clamp(Math.round(a.variant), 0, 2)];
      note(p, 'triangle', f, 0.022, 0.8, 0.002, 0.055);
      return 0.1;
    },
  }),

  // ── movement ──
  /** Quick boost: hard noise blast sweeping down + body kick. */
  qb: def({
    category: 'move',
    gain: 0.55,
    maxSeconds: 0.5,
    minInterval: 0.15,
    maxDelay: 0,
    build(p, a) {
      const air = a.variant === 1 ? 1.18 : 1;
      burst(p, 'white', 'bandpass', 2600 * air, 0.9, 0, 1.0, 0.004, 0.42, 380, 0.3);
      note(p, 'sine', 128, 0, a.variant === 1 ? 0.3 : 0.5, 0.002, 0.2, 46, 0.12);
      burst(p, 'pink', 'highpass', 4000, 0.7, 0, 0.5, 0.002, 0.09);
      return 0.45;
    },
  }),
  'qb-reject': def({
    category: 'move',
    gain: 0.34,
    maxSeconds: 0.12,
    minInterval: 0.12,
    maxDelay: 0,
    build(p) {
      burst(p, 'pink', 'bandpass', 600, 0.8, 0, 2.2, 0.002, 0.06);
      const o = p.osc('square', 150);
      const lp = p.filter('lowpass', 900, 0.7);
      const g = p.gain();
      p.perc(g.gain, 0, 0.6, 0.002, 0.06);
      p.chain(o, lp, g);
      return 0.09;
    },
  }),
  jump: def({
    category: 'move',
    gain: 0.38,
    maxSeconds: 0.26,
    minInterval: 0.1,
    maxDelay: 0,
    build(p) {
      note(p, 'sine', 92, 0, 0.45, 0.003, 0.13, 210, 0.09);
      burst(p, 'pink', 'bandpass', 700, 1.2, 0, 3.2, 0.006, 0.2, 1900, 0.15);
      return 0.23;
    },
  }),
  /** Landing thud: level, depth and length follow the vertical impact speed (intensity 0…1). */
  land: def({
    category: 'move',
    gain: 0.3,
    maxSeconds: 0.34,
    minInterval: 0.08,
    maxDelay: 0,
    build(p, a) {
      const k = clamp(a.intensity, 0, 1);
      note(p, 'sine', 96 - 26 * k, 0, 0.6, 0.002, 0.13 + 0.12 * k, 40, 0.09);
      burst(p, 'pink', 'lowpass', 520 + 900 * k, 0.7, 0, 2.4, 0.002, 0.07 + 0.05 * k);
      // foot plates: two inharmonic partials, more of them for a hard landing
      note(p, 'sine', 510, 0.004, 0.1 + 0.14 * k, 0.001, 0.05);
      note(p, 'sine', 793, 0.004, 0.07 + 0.1 * k, 0.001, 0.035);
      return 0.18 + 0.13 * k;
    },
  }),
  /** Brake: retro-thruster hiss falling in pitch (intensity = how fast the mech was going). */
  brake: def({
    category: 'move',
    gain: 0.6,
    maxSeconds: 0.36,
    minInterval: 0.25,
    maxDelay: 0,
    build(p, a) {
      const k = clamp(a.intensity, 0.2, 1);
      const d = 0.16 + 0.16 * k;
      burst(p, 'pink', 'bandpass', 1150, 2.2, 0, 1.6, 0.008, d, 320, d * 0.8);
      const o = p.osc('sawtooth', 170);
      p.glide(o.frequency, 0, 170, 58, d * 0.8);
      const lp = p.filter('lowpass', 480, 0.7);
      const g = p.gain();
      p.perc(g.gain, 0, 0.3, 0.006, d);
      p.chain(o, lp, g);
      return d + 0.03;
    },
  }),
  /** Manual glide toggle: short turbine blip up (on) / down (off). */
  'glide-on': def({
    category: 'move',
    gain: 0.2,
    maxSeconds: 0.16,
    minInterval: 0.08,
    maxDelay: 0,
    build(p) {
      const o = p.osc('sawtooth', 110);
      p.glide(o.frequency, 0, 110, 235, 0.1);
      const lp = p.filter('lowpass', 1300, 1);
      const g = p.gain();
      p.perc(g.gain, 0, 0.9, 0.012, 0.11);
      p.chain(o, lp, g);
      return 0.14;
    },
  }),
  'glide-off': def({
    category: 'move',
    gain: 0.2,
    maxSeconds: 0.16,
    minInterval: 0.08,
    maxDelay: 0,
    build(p) {
      const o = p.osc('sawtooth', 220);
      p.glide(o.frequency, 0, 220, 96, 0.1);
      const lp = p.filter('lowpass', 1000, 1);
      const g = p.gain();
      p.perc(g.gain, 0, 0.9, 0.006, 0.11);
      p.chain(o, lp, g);
      return 0.14;
    },
  }),

  // ── impacts and explosions ──
  /** Player bullet on an enemy: bright metallic tick (hit confirmation). */
  'hit-enemy': def({
    category: 'impact',
    gain: 0.21,
    maxSeconds: 0.11,
    minInterval: 0.035,
    maxDelay: 0.08,
    rolloff: 'feedback',
    build(p) {
      const k = p.vary(0.07);
      note(p, 'sine', 1850 * k, 0, 0.6, 0.0006, 0.06);
      note(p, 'sine', 2790 * k, 0, 0.35, 0.0006, 0.04);
      burst(p, 'white', 'highpass', 2500, 0.7, 0, 0.55, 0.0005, 0.014);
      return 0.08;
    },
  }),
  /** Player bullet on the stage: dull thud. */
  'hit-world': def({
    category: 'impact',
    gain: 0.36,
    maxSeconds: 0.1,
    minInterval: 0.045,
    maxDelay: 0.05,
    rolloff: 'world',
    build(p) {
      const k = p.vary(0.1);
      burst(p, 'pink', 'bandpass', 520 * k, 1, 0, 3.0, 0.001, 0.045);
      note(p, 'sine', 240 * k, 0, 0.4, 0.001, 0.03, 120, 0.02);
      return 0.07;
    },
  }),
  /** Beam on an enemy: short sizzle with a pitched sting. */
  'beam-hit-enemy': def({
    category: 'impact',
    gain: 0.27,
    maxSeconds: 0.16,
    minInterval: 0.08,
    maxDelay: 0.05,
    rolloff: 'feedback',
    build(p) {
      const k = p.vary(0.04);
      burst(p, 'white', 'bandpass', 4200, 1.2, 0, 0.9, 0.001, 0.1, 1500, 0.08);
      note(p, 'sine', 2350 * k, 0, 0.45, 0.001, 0.09, 1500 * k, 0.07);
      return 0.13;
    },
  }),
  'beam-hit-world': def({
    category: 'impact',
    gain: 0.24,
    maxSeconds: 0.13,
    minInterval: 0.08,
    maxDelay: 0.05,
    rolloff: 'world',
    build(p) {
      burst(p, 'pink', 'bandpass', 1900, 1.4, 0, 3.0, 0.001, 0.08, 600, 0.07);
      return 0.1;
    },
  }),
  /** Enemy bullet on the stage: a small tick, only audible near the listener (near miss). */
  'bullet-world': def({
    category: 'impact',
    gain: 0.42,
    maxSeconds: 0.08,
    minInterval: 0.05,
    maxDelay: 0,
    rolloff: 'near',
    build(p) {
      const k = p.vary(0.15);
      burst(p, 'white', 'bandpass', 1900 * k, 1.4, 0, 1.2, 0.0006, 0.03);
      note(p, 'sine', 300 * k, 0, 0.35, 0.001, 0.025, 150, 0.02);
      return 0.055;
    },
  }),
  /** Missile detonation (on anything): small explosion. */
  'explode-missile': def({
    category: 'explosion',
    gain: 0.36,
    maxSeconds: 0.85,
    minInterval: 0.05,
    maxDelay: 0.12,
    rolloff: 'event',
    build: (p) => boom(p, 0.55),
  }),
  'explode-guard': def({
    category: 'explosion',
    gain: 0.38,
    maxSeconds: 1.0,
    minInterval: 0.05,
    maxDelay: 0.12,
    rolloff: 'event',
    build: (p) => boom(p, 0.75),
  }),
  'explode-turret': def({
    category: 'explosion',
    gain: 0.4,
    maxSeconds: 1.15,
    minInterval: 0.05,
    maxDelay: 0.12,
    rolloff: 'event',
    build: (p) => boom(p, 0.95),
  }),
  /** Control turret: the biggest explosion, with a second, deeper report and a machine whine winding down. */
  'explode-control': def({
    category: 'explosion',
    gain: 0.38,
    maxSeconds: 1.75,
    minInterval: 0.05,
    maxDelay: 0.12,
    rolloff: 'event',
    build(p) {
      const d = boom(p, 1.3);
      note(p, 'sine', 62, 0.16, 0.5, 0.004, 0.55, 30, 0.4);
      burst(p, 'pink', 'lowpass', 1100, 0.6, 0.16, 1.2, 0.006, 0.5, 140, 0.35);
      // the control machinery dies: a saw whine falling three octaves
      const o = p.osc('sawtooth', 620, 0.05, 1.62);
      p.glide(o.frequency, 0.05, 620, 75, 1.4);
      const lp = p.filter('lowpass', 1500, 2);
      p.glide(lp.frequency, 0.05, 1500, 300, 1.4);
      const g = p.gain();
      p.hold(g.gain, 0.05, 0.4, 0.3, 0.03, 1.1, 0.4);
      p.chain(o, lp, g);
      return Math.max(d, 1.63);
    },
  }),

  // ── enemies ──
  /** Guard telegraph: clean chirp rising one octave from about 1 kHz; ends as the burst starts. */
  'telegraph-guard': def({
    category: 'telegraph',
    gain: 0.125,
    maxSeconds: 0.17,
    minInterval: 0.012,
    maxDelay: 0.04,
    rolloff: 'warning',
    build(p, a) {
      const d = fit(a.duration, 0.07, 0.14);
      const k = p.vary(0.03);
      const env = p.gain();
      p.hold(env.gain, 0, 0.55, 1.0, 0.005, d - 0.027, 0.022);
      env.connect(p.out);
      const o = p.osc('triangle', 980 * k);
      p.glide(o.frequency, 0, 980 * k, 1960 * k, d * 0.9);
      o.connect(env);
      const sq = p.osc('square', 980 * k);
      p.glide(sq.frequency, 0, 980 * k, 1960 * k, d * 0.9);
      const lp = p.filter('lowpass', 4200, 0.7);
      const sg = p.gain(0.2);
      p.series(sq, sg, lp).connect(env);
      return d + 0.005;
    },
  }),
  /** Turret telegraph: buzzing charge-up rising 250 → 760 Hz with a 27 Hz flutter and a crescendo. */
  'telegraph-turret': def({
    category: 'telegraph',
    gain: 0.245,
    maxSeconds: 0.36,
    minInterval: 0.012,
    maxDelay: 0.04,
    rolloff: 'warning',
    build(p, a) {
      const d = fit(a.duration, 0.12, 0.33);
      const k = p.vary(0.03);
      const env = p.gain();
      p.hold(env.gain, 0, 0.4, 1.0, 0.012, d - 0.042, 0.03);
      env.connect(p.out);
      const trem = p.gain(0.62);
      trem.connect(env);
      const lfo = p.osc('sine', 27);
      const lfoDepth = p.gain(0.3);
      p.series(lfo, lfoDepth).connect(trem.gain);
      const saw = p.osc('sawtooth', 250 * k);
      p.glide(saw.frequency, 0, 250 * k, 760 * k, d * 0.92);
      const lp = p.filter('lowpass', 800 * k, 4);
      p.glide(lp.frequency, 0, 800 * k, 2600 * k, d * 0.92);
      p.series(saw, lp).connect(trem);
      const sub = p.osc('sine', 125 * k);
      p.glide(sub.frequency, 0, 125 * k, 380 * k, d * 0.92);
      const subGain = p.gain(0.5);
      p.series(sub, subGain).connect(trem);
      return d + 0.005;
    },
  }),
  /** Guard shot: thin falling bolt. */
  'shot-guard': def({
    category: 'enemyshot',
    gain: 0.26,
    maxSeconds: 0.12,
    minInterval: 0.02,
    maxDelay: 0.07,
    rolloff: 'world',
    build(p) {
      const k = p.vary(0.07);
      const o = p.osc('square', 820 * k);
      p.glide(o.frequency, 0, 820 * k, 300 * k, 0.06);
      const lp = p.filter('lowpass', 3200, 0.7);
      const g = p.gain();
      p.perc(g.gain, 0, 0.75, 0.001, 0.075);
      p.chain(o, lp, g);
      burst(p, 'white', 'bandpass', 3800, 1, 0, 0.5, 0.0006, 0.016);
      return 0.09;
    },
  }),
  /** Turret shot: heavy falling report with a sub kick. */
  'shot-turret': def({
    category: 'enemyshot',
    gain: 0.36,
    maxSeconds: 0.24,
    minInterval: 0.02,
    maxDelay: 0.07,
    rolloff: 'world',
    build(p) {
      const k = p.vary(0.06);
      const o = p.osc('sawtooth', 300 * k);
      p.glide(o.frequency, 0, 300 * k, 70 * k, 0.13);
      const lp = p.filter('lowpass', 1400, 1.5);
      const g = p.gain();
      p.perc(g.gain, 0, 0.8, 0.002, 0.17);
      p.chain(o, lp, g);
      burst(p, 'pink', 'lowpass', 1800, 0.7, 0, 1.3, 0.001, 0.06);
      note(p, 'sine', 82 * k, 0, 0.6, 0.002, 0.13, 44, 0.1);
      return 0.2;
    },
  }),
  /** An enemy noticed the player: short falling growl from its direction. */
  alert: def({
    category: 'alert',
    gain: 0.16,
    maxSeconds: 0.17,
    minInterval: 0.3,
    maxDelay: 0,
    rolloff: 'world',
    build(p) {
      const o = p.osc('sawtooth', 740);
      p.glide(o.frequency, 0, 740, 370, 0.12);
      const lp = p.filter('lowpass', 1500, 1.2);
      const trem = p.gain(0.6);
      const lfo = p.osc('square', 41);
      const depth = p.gain(0.35);
      p.series(lfo, depth).connect(trem.gain);
      const g = p.gain();
      p.hold(g.gain, 0, 0.9, 0.6, 0.006, 0.09, 0.04);
      p.chain(o, lp, trem, g);
      return 0.145;
    },
  }),

  // ── player state ──
  /** Damage taken: armour clang + crunch; intensity 0 (guard bullet) … 1 (turret shell) makes it heavier. */
  damage: def({
    category: 'damage',
    gain: 0.5,
    maxSeconds: 0.32,
    minInterval: 0.05,
    maxDelay: 0.04,
    rolloff: 'pan',
    build(p, a) {
      const h = clamp(a.intensity, 0, 1);
      const k = p.vary(0.05) * (1 - 0.22 * h);
      burst(p, 'white', 'bandpass', 1050 * k, 0.8, 0, 1.5, 0.001, 0.07 + 0.03 * h);
      const partials = [318, 487, 771, 1153];
      for (let i = 0; i < partials.length; i++) {
        note(p, 'sine', partials[i] * k, 0, 0.36 - i * 0.06, 0.001, (0.2 + 0.08 * h) / (1 + i * 0.6));
      }
      note(p, 'sine', 112 * k, 0, 0.25 + 0.2 * h, 0.002, 0.1 + 0.05 * h, 48, 0.08);
      return 0.22 + 0.09 * h;
    },
  }),
  /** Low-HP warning: two soft falling notes; the engine repeats it slowly while HP < 30 %. */
  'low-hp': def({
    category: 'status',
    gain: 0.15,
    maxSeconds: 0.52,
    minInterval: 0.8,
    maxDelay: 0,
    build(p) {
      pip(p, 494, 0, 0.9, 0.2);
      return pip(p, 415, 0.21, 0.9, 0.26);
    },
  }),
  /** EN dropped below the quick-boost cost: one soft falling tone. */
  'en-low': def({
    category: 'status',
    gain: 0.15,
    maxSeconds: 0.2,
    minInterval: 2.5,
    maxDelay: 0,
    build(p) {
      return pip(p, 330, 0, 0.9, 0.16, 196);
    },
  }),
  /**
   * Lock acquired: two clean pips on ONE pitch (880 Hz). Deliberately not rising and an octave below the
   * guard telegraph, so the player's own confirmation cannot be taken for an enemy warning.
   */
  'lock-on': def({
    category: 'status',
    gain: 0.22,
    maxSeconds: 0.15,
    minInterval: 0.1,
    maxDelay: 0,
    build(p) {
      note(p, 'triangle', 880, 0, 0.3, 0.002, 0.04);
      note(p, 'triangle', 880, 0.065, 0.3, 0.002, 0.055);
      pip(p, 880, 0, 0.7, 0.04);
      return pip(p, 880, 0.065, 0.7, 0.055);
    },
  }),
  /** Lock lost: one falling pip. */
  'lock-lost': def({
    category: 'status',
    gain: 0.15,
    maxSeconds: 0.13,
    minInterval: 0.1,
    maxDelay: 0,
    build(p) {
      return pip(p, 700, 0, 0.9, 0.09, 420);
    },
  }),

  // ── progress ──
  /** Barrier opened: clank, servo run-up, end stop. */
  'barrier-open': def({
    category: 'progress',
    gain: 0.46,
    maxSeconds: 1.35,
    minInterval: 0.3,
    maxDelay: 0.4,
    build(p) {
      clank(p, 0, 173, 1.0, 0.5);
      const o = p.osc('sawtooth', 62, 0.12, 1.08);
      p.glide(o.frequency, 0.12, 62, 124, 0.85);
      const lp = p.filter('lowpass', 420, 2);
      const g = p.gain();
      p.hold(g.gain, 0.12, 0.5, 0.5, 0.06, 0.78, 0.08);
      p.chain(o, lp, g);
      burst(p, 'pink', 'bandpass', 900, 1.2, 0.12, 0.5, 0.06, 0.85, 1500, 0.8);
      note(p, 'sine', 118, 1.03, 0.9, 0.002, 0.16, 52, 0.1);
      burst(p, 'brown', 'lowpass', 700, 0.7, 1.03, 0.8, 0.002, 0.07);
      return 1.25;
    },
  }),
  /** Final gate opened: long rumble, slow servo, four rising notes, closing clank. */
  'gate-open': def({
    category: 'progress',
    gain: 0.44,
    maxSeconds: 2.75,
    minInterval: 1,
    maxDelay: 0,
    build(p) {
      const n = p.noise('brown', 0, 2.5);
      const lp = p.filter('lowpass', 240, 0.7);
      const ng = p.gain();
      p.hold(ng.gain, 0, 1.0, 0.8, 0.35, 1.5, 0.6);
      p.chain(n, lp, ng);
      const o = p.osc('sawtooth', 49, 0, 2.1);
      p.glide(o.frequency, 0, 49, 98, 1.9);
      const lp2 = p.filter('lowpass', 340, 1.5);
      const og = p.gain();
      p.hold(og.gain, 0, 0.4, 0.4, 0.1, 1.8, 0.15);
      p.chain(o, lp2, og);
      const notes = [293.66, 440, 587.33, 739.99];
      for (let i = 0; i < notes.length; i++) {
        const last = i === notes.length - 1;
        note(p, 'triangle', notes[i], 0.15 + i * 0.36, 0.34, 0.012, last ? 1.1 : 0.55);
        note(p, 'sine', notes[i] * 2, 0.15 + i * 0.36, 0.08, 0.012, last ? 0.8 : 0.35);
      }
      clank(p, 2.05, 131, 0.9, 0.55);
      return 2.65;
    },
  }),
  /** Mission cleared: rising four-note figure into a held open chord. */
  cleared: def({
    category: 'jingle',
    gain: 0.34,
    maxSeconds: 2.5,
    minInterval: 1,
    maxDelay: 0,
    build(p) {
      const lp = p.filter('lowpass', 3200, 0.5);
      lp.connect(p.out);
      const tone = (f: number, at: number, peak: number, decay: number): void => {
        const end = at + decay + 0.03;
        const o = p.osc('triangle', f, at, end);
        const o2 = p.osc('sine', f * 2.003, at, end);
        const g = p.gain();
        const g2 = p.gain(0.3);
        p.perc(g.gain, at, peak, 0.012, decay);
        o.connect(g);
        p.series(o2, g2).connect(g);
        g.connect(lp);
      };
      const run = [392, 493.88, 587.33, 783.99];
      for (let i = 0; i < run.length; i++) tone(run[i], i * 0.13, 0.4, 0.4);
      const chord = [392, 587.33, 783.99, 987.77];
      for (let i = 0; i < chord.length; i++) tone(chord[i], 0.58, 0.24, 1.75);
      return 2.4;
    },
  }),
  /** Mission failed: two detuned saws sinking a fourth while the filter closes. */
  failed: def({
    category: 'jingle',
    gain: 0.3,
    maxSeconds: 2.1,
    minInterval: 1,
    maxDelay: 0,
    build(p) {
      const lp = p.filter('lowpass', 950, 1.2);
      p.glide(lp.frequency, 0, 950, 190, 1.6);
      const g = p.gain();
      p.hold(g.gain, 0, 0.8, 0.45, 0.03, 1.3, 0.6);
      p.chain(lp, g);
      const a = p.osc('sawtooth', 196);
      p.glide(a.frequency, 0.25, 196, 130.81, 1.2);
      const b = p.osc('sawtooth', 197.6);
      p.glide(b.frequency, 0.25, 197.6, 131.5, 1.2);
      const mix = p.gain(0.5);
      a.connect(mix);
      b.connect(mix);
      mix.connect(lp);
      const sub = p.osc('sine', 98);
      p.glide(sub.frequency, 0.25, 98, 65.4, 1.2);
      const sg = p.gain();
      p.hold(sg.gain, 0, 0.5, 0.3, 0.03, 1.3, 0.6);
      p.chain(sub, sg);
      return 1.98;
    },
  }),

  // ── menus ──
  'ui-click': def({
    category: 'ui',
    gain: 0.16,
    maxSeconds: 0.07,
    minInterval: 0.03,
    maxDelay: 0,
    build(p) {
      burst(p, 'white', 'highpass', 3000, 0.7, 0, 0.25, 0.0005, 0.008);
      return pip(p, 1175, 0, 0.9, 0.035);
    },
  }),
  /** Sortie: power-up sweep into a two-note confirmation. */
  'ui-sortie': def({
    category: 'ui',
    gain: 0.225,
    maxSeconds: 0.9,
    minInterval: 0.3,
    maxDelay: 0,
    build(p) {
      const o = p.osc('sawtooth', 110, 0, 0.5);
      p.glide(o.frequency, 0, 110, 440, 0.4);
      const lp = p.filter('lowpass', 300, 1.5);
      p.glide(lp.frequency, 0, 300, 2400, 0.4);
      const g = p.gain();
      p.hold(g.gain, 0, 0.25, 0.6, 0.02, 0.38, 0.08);
      p.chain(o, lp, g);
      pip(p, 659.25, 0.42, 0.55, 0.3);
      return pip(p, 987.77, 0.5, 0.5, 0.35);
    },
  }),
  'ui-pause': def({
    category: 'ui',
    gain: 0.18,
    maxSeconds: 0.24,
    minInterval: 0.1,
    maxDelay: 0,
    build(p) {
      pip(p, 660, 0, 0.9, 0.07);
      return pip(p, 440, 0.08, 0.9, 0.1);
    },
  }),
  'ui-resume': def({
    category: 'ui',
    gain: 0.18,
    maxSeconds: 0.24,
    minInterval: 0.1,
    maxDelay: 0,
    build(p) {
      pip(p, 440, 0, 0.9, 0.07);
      return pip(p, 660, 0.08, 0.9, 0.1);
    },
  }),
  'ui-error': def({
    category: 'ui',
    gain: 0.16,
    maxSeconds: 0.3,
    minInterval: 0.2,
    maxDelay: 0,
    build(p) {
      const lp = p.filter('lowpass', 620, 0.7);
      lp.connect(p.out);
      for (let i = 0; i < 2; i++) {
        const at = i * 0.12;
        const o = p.osc('square', 185, at, at + 0.1);
        const g = p.gain();
        p.hold(g.gain, at, 0.8, 0.6, 0.004, 0.06, 0.025);
        o.connect(g);
        g.connect(lp);
      }
      return 0.24;
    },
  }),
} satisfies Record<string, SoundDef>;

export type SoundId = keyof typeof SOUNDS;
export const SOUND_IDS = Object.keys(SOUNDS) as SoundId[];

// ───────────────────────────── continuous layers ─────────────────────────────

export type LoopId = 'glide' | 'thrust';

export interface LoopVoice {
  /** Moves the timbre towards `x` (0…1) at context time `now`; called a few times per second at most. */
  tune(x: number, now: number): void;
}

export interface LoopDef {
  /** Level of the layer at full strength. */
  gain: number;
  /** Builds the running graph into the patch (sources are started, never stopped by the patch). */
  build(p: Patch): LoopVoice;
}

const TUNE_TAU = 0.07;

export const LOOPS: Record<LoopId, LoopDef> = {
  /**
   * Glide: hovering thrusters. Band-passed air noise + a low turbine tone (root and fifth); both rise with
   * the horizontal speed (x = speed / quick-boost speed).
   */
  glide: {
    gain: 0.09,
    build(p) {
      const n = p.noise('pink');
      const bp = p.filter('bandpass', 600, 0.9);
      const ng = p.gain(1.5);
      p.chain(n, bp, ng);
      const lfo = p.osc('sine', 6.3);
      const depth = p.gain(0.22);
      p.series(lfo, depth).connect(ng.gain);
      const o = p.osc('sawtooth', 52);
      const lp = p.filter('lowpass', 260, 0.8);
      const og = p.gain(0.5);
      p.chain(o, lp, og);
      const o2 = p.osc('triangle', 78);
      const og2 = p.gain(0.22);
      p.chain(o2, og2);
      return {
        tune(x, now) {
          const u = x < 0 ? 0 : x > 1 ? 1 : x;
          const f = 50 + 62 * Math.pow(u, 0.6);
          bp.frequency.setTargetAtTime(520 + 1700 * Math.sqrt(u), now, TUNE_TAU);
          o.frequency.setTargetAtTime(f, now, TUNE_TAU);
          o2.frequency.setTargetAtTime(f * 1.5, now, TUNE_TAU);
          lp.frequency.setTargetAtTime(220 + 260 * u, now, TUNE_TAU);
        },
      };
    },
  },
  /** Flight thrust: low roar with a 21 Hz flutter and a faint hiss; x is unused (constant climb speed). */
  thrust: {
    gain: 0.085,
    build(p) {
      const n = p.noise('brown');
      const lp = p.filter('lowpass', 900, 0.7);
      const ng = p.gain(1.0);
      p.chain(n, lp, ng);
      const lfo = p.osc('sine', 21);
      const depth = p.gain(0.3);
      p.series(lfo, depth).connect(ng.gain);
      const o = p.osc('sawtooth', 66);
      const lp2 = p.filter('lowpass', 210, 1.2);
      const og = p.gain(0.45);
      p.chain(o, lp2, og);
      const h = p.noise('white');
      const hp = p.filter('highpass', 5000, 0.7);
      const hg = p.gain(0.07);
      p.chain(h, hp, hg);
      return {
        tune(x, now) {
          const u = x < 0 ? 0 : x > 1 ? 1 : x;
          lp.frequency.setTargetAtTime(800 + 500 * u, now, TUNE_TAU);
        },
      };
    },
  },
};
