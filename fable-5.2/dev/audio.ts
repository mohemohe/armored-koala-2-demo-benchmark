/**
 * Audition page and measurement harness for src/audio (dev only, not part of the game bundle).
 *
 *   /dev/audio.html
 *
 * For humans with speakers: one button per sound, the menu sounds, every SimEvent through the real event
 * mapping, sliders for the state update() reads (glide speed, flight, HP, EN, lock, camera yaw), a real-Sim
 * fight driven by an autopilot and a synthetic heavy fight.
 *
 * For machines: window.__audio renders the very same graphs in an OfflineAudioContext and measures them
 * (level, duration, DC, spectrum, stereo balance, pairwise differences, pause behaviour, the 60 s stress mix)
 * and runs the stress / real-Sim fights against the live AudioContext. Driven by a playwright script:
 *
 *   table()             every sound: dry peak, peak after the master chain, duration, DC, centroid, contour, band
 *   pairs()             sounds that must be told apart: spectral / envelope / duration differences
 *   spatial()           pan, distance attenuation and "behind" filtering from the camera pose
 *   master()            unity gain of the master chain at low level, hard ceiling when overloaded, volume, mute
 *   loops()             glide loop vs speed, thrust loop, silence when not gliding, click-free fades
 *   pause()             everything silent within 150 ms of a pause, menu sound still audible, resume works
 *   rhythm()            sustained machine-gun / beam fire: onset intervals in the rendered audio
 *   burst()             15 enemies firing in the same frame + machine gun + explosions + damage
 *   stressOffline(s)    the synthetic heavy fight through the engine, rendered offline: peak / RMS / clipping
 *   stressRealtime(s)   the same events against the live engine in real time: voices, nodes, errors
 *   fightOffline(mode)  a real Sim fight rendered offline;  fightRealtime(mode, s)  the same live
 */
import { EVENT_SOUNDS, type AudioSimView } from '../src/audio/cues';
import { AudioEngine, type UiSound } from '../src/audio/engine';
import { CEILING, CLIP_KNEE, COMPRESSOR, Mixer, POST_GAIN, VOICE_CAP, compressorMakeup, type PlayOptions } from '../src/audio/mixer';
import { NoiseBank, Patch, makeRandom } from '../src/audio/patch';
import { CATEGORIES, SOUNDS, SOUND_IDS, type SoundId } from '../src/audio/sounds';
import { PLAYER } from '../src/config';
import type { SimEvent } from '../src/sim/types';
import { analyse, difference, levelBetween, maxStep, monoMix, type Difference, type Metrics } from './audio-analysis';
import { RealFight, SyntheticFight, sampleEvents, sampleView, type FightMode } from './audio-scenarios';

const SR = 48000;
/** Offline engine runs are stepped in 16 ms frames (6 render quanta), like a 62.5 fps game loop. */
const STEP_FRAMES = 768;
const STEP = STEP_FRAMES / SR;

// ═══════════════════════════ design expectations ═══════════════════════════
//
// Written before the first measurement. Changed afterwards, for the reasons given:
//  - qb: the "falling" contour was dropped. Its band-pass does sweep down, but the body kick sits in the first
//    half, so "centroid of the 2nd half vs the 1st" is not a pitch contour for this sound.
//  - land: range moved from 50-600 to 100-700 Hz together with the patch (the first version was nearly
//    all below 100 Hz — inaudible on small speakers). The same reasoning added the `rumble` flag / the
//    "share above 200 Hz" check and made several patches (hit-world, jump, damage, explosions …) brighter.
//  - lock-on was two RISING pips at 1.2-1.7 kHz (expected 1200-2400 Hz, rising). pairs() showed it far too
//    close to the guard telegraph (spectral cosine 0.94, same contour). Redesigned: two pips on one pitch,
//    880 Hz; lock-lost moved down with it (700 → 420 Hz).

interface Design {
  /** Expected range of the spectral centroid in Hz. */
  centroid: [number, number];
  /** Expected pitch contour: centroid of the second half vs the first half. */
  contour?: 'rising' | 'falling';
  /** Deliberately bass-heavy (explosions, heavy machinery): a larger share below 200 Hz is accepted. */
  rumble?: boolean;
}

const DESIGN: Record<SoundId, Design> = {
  mg: { centroid: [700, 2600] },
  beam: { centroid: [1000, 3500], contour: 'falling' },
  'missile-launch': { centroid: [500, 2000], contour: 'rising' },
  'reject-nolock': { centroid: [150, 900] },
  'reject-noen': { centroid: [150, 900], contour: 'falling' },
  'reject-noammo': { centroid: [150, 1200] },
  switch: { centroid: [500, 3000] },
  qb: { centroid: [500, 2500] },
  'qb-reject': { centroid: [80, 600], rumble: true },
  jump: { centroid: [300, 1800], contour: 'rising' },
  land: { centroid: [100, 700], rumble: true },
  brake: { centroid: [300, 1200], contour: 'falling' },
  'glide-on': { centroid: [150, 1000], contour: 'rising' },
  'glide-off': { centroid: [150, 1000], contour: 'falling' },
  'hit-enemy': { centroid: [1800, 4500] },
  'hit-world': { centroid: [150, 900] },
  'beam-hit-enemy': { centroid: [1800, 4500] },
  'beam-hit-world': { centroid: [900, 3000] },
  'bullet-world': { centroid: [900, 2600] },
  'explode-missile': { centroid: [100, 900], rumble: true },
  'explode-guard': { centroid: [100, 900], rumble: true },
  'explode-turret': { centroid: [100, 900], rumble: true },
  'explode-control': { centroid: [100, 900], rumble: true },
  'telegraph-guard': { centroid: [1100, 2600], contour: 'rising' },
  'telegraph-turret': { centroid: [350, 1500], contour: 'rising' },
  'shot-guard': { centroid: [600, 2800], contour: 'falling' },
  'shot-turret': { centroid: [120, 900], contour: 'falling', rumble: true },
  alert: { centroid: [450, 1600], contour: 'falling' },
  damage: { centroid: [300, 1500] },
  'low-hp': { centroid: [400, 700], contour: 'falling' },
  'en-low': { centroid: [200, 500], contour: 'falling' },
  'lock-on': { centroid: [800, 1300] },
  'lock-lost': { centroid: [400, 900], contour: 'falling' },
  'barrier-open': { centroid: [100, 900], rumble: true },
  'gate-open': { centroid: [100, 800], rumble: true },
  cleared: { centroid: [450, 1400] },
  failed: { centroid: [100, 500], contour: 'falling', rumble: true },
  'ui-click': { centroid: [850, 2000] },
  'ui-sortie': { centroid: [300, 1400] },
  'ui-pause': { centroid: [450, 800], contour: 'falling' },
  'ui-resume': { centroid: [450, 800], contour: 'rising' },
  'ui-error': { centroid: [120, 500] },
};

// ═══════════════════════════ offline rendering ═══════════════════════════

interface Rendered {
  channels: Float32Array[];
  sampleRate: number;
  played: boolean;
}

interface RenderOptions extends PlayOptions {
  listener?: { x: number; y: number; z: number; yaw: number };
  seed?: number;
  volume?: number;
}

/**
 * A DynamicsCompressorNode starts its life with a short gain dip (Chromium: about 150 ms until its detector
 * has settled). Single sounds are therefore rendered this long after the start of the context, which is the
 * situation in the game (the context exists long before the first shot).
 */
const SETTLE = 0.3;

/** One sound through the real mixer (voice chain + master chain) at master volume 1. */
async function renderSound(id: SoundId, o: RenderOptions = {}): Promise<Rendered> {
  const def = SOUNDS[id];
  const ctx = new OfflineAudioContext(2, Math.ceil((def.maxSeconds + SETTLE + 0.4) * SR), SR);
  const mixer = new Mixer(ctx, { volume: o.volume ?? 1, seed: o.seed });
  if (o.listener) mixer.setListener(o.listener.x, o.listener.y, o.listener.z, o.listener.yaw);
  const played = mixer.play(id, { ...o, delay: SETTLE });
  const buf = await ctx.startRendering();
  return { channels: [buf.getChannelData(0), buf.getChannelData(1)], sampleRate: SR, played };
}

/** The bare patch × its level, without placement and without the master chain (mono). */
async function renderDry(id: SoundId, o: RenderOptions = {}): Promise<Rendered> {
  const def = SOUNDS[id];
  const ctx = new OfflineAudioContext(1, Math.ceil((def.maxSeconds + 0.4) * SR), SR);
  const out = ctx.createGain();
  out.gain.value = def.gain * (o.gain ?? 1);
  out.connect(ctx.destination);
  const patch = new Patch(ctx, new NoiseBank(ctx), 0.004, out, makeRandom(o.seed ?? 0x5eed1234));
  patch.finish(def.build(patch, { variant: o.variant ?? 0, intensity: o.intensity ?? 1, duration: o.duration ?? 0 }));
  const buf = await ctx.startRendering();
  return { channels: [buf.getChannelData(0)], sampleRate: SR, played: true };
}

interface EngineRun {
  /** Final output (after the master chain, volume 1) and the bus sum before the compressor. */
  out: Float32Array[];
  pre: Float32Array[];
  engine: AudioEngine;
  maxVoices: number;
  maxNodes: number;
  frames: number;
}

/**
 * Runs the REAL AudioEngine on an OfflineAudioContext: the render is suspended every 16 ms, `step(i, t)` is
 * called (handleEvents / update, exactly like a frame of the game) and the render resumes.
 */
async function runEngineOffline(seconds: number, step: (engine: AudioEngine, frame: number, time: number) => void): Promise<EngineRun> {
  const frames = Math.max(2, Math.floor(seconds / STEP));
  const ctx = new OfflineAudioContext(4, frames * STEP_FRAMES, SR);
  ctx.destination.channelInterpretation = 'discrete';
  const merger = ctx.createChannelMerger(4);
  merger.connect(ctx.destination);
  const stereo = (): GainNode => {
    const g = ctx.createGain();
    g.channelCount = 2;
    g.channelCountMode = 'explicit';
    g.channelInterpretation = 'speakers';
    return g;
  };
  const outTap = stereo();
  const outSplit = ctx.createChannelSplitter(2);
  outTap.connect(outSplit);
  outSplit.connect(merger, 0, 0);
  outSplit.connect(merger, 1, 1);
  const engine = new AudioEngine({ context: ctx, volume: 1, destination: outTap });
  const mixer = engine.getMixer();
  if (!mixer) throw new Error('offline engine has no mixer: ' + engine.getDebugInfo().lastError);
  const preTap = stereo();
  const preSplit = ctx.createChannelSplitter(2);
  mixer.preMaster.connect(preTap);
  preTap.connect(preSplit);
  preSplit.connect(merger, 0, 2);
  preSplit.connect(merger, 1, 3);

  let maxVoices = 0;
  let maxNodes = 0;
  const run = (i: number): void => {
    step(engine, i, i * STEP);
    const info = engine.getDebugInfo();
    if (info.activeVoices > maxVoices) maxVoices = info.activeVoices;
    if (info.liveNodes > maxNodes) maxNodes = info.liveNodes;
  };
  let failure: unknown = null;
  for (let i = 1; i < frames; i++) {
    void ctx.suspend(i * STEP).then(() => {
      try {
        run(i);
      } catch (err) {
        failure = failure ?? err;
      }
      void ctx.resume();
    });
  }
  run(0);
  const buf = await ctx.startRendering();
  if (failure) throw failure;
  return {
    out: [buf.getChannelData(0), buf.getChannelData(1)],
    pre: [buf.getChannelData(2), buf.getChannelData(3)],
    engine,
    maxVoices,
    maxNodes,
    frames,
  };
}

// ═══════════════════════════ measurements ═══════════════════════════

const r = (x: number, digits = 3): number => (Number.isFinite(x) ? Number(x.toFixed(digits)) : x);

interface TableRow {
  sound: string;
  category: string;
  designedMaxS: number;
  durationS: number;
  dryPeak: number;
  peak: number;
  rmsDb: number;
  loudDb: number;
  dryLoudDb: number;
  dcOffset: number;
  centroidHz: number;
  designHz: string;
  contour: string;
  designContour: string;
  band: string;
  peakHz: number;
  above200HzDb: number;
  ok: boolean;
  problems: string;
}

const CASES: Array<{ id: SoundId; label?: string; o?: RenderOptions }> = [
  ...SOUND_IDS.map((id) => ({ id })),
  { id: 'qb', label: 'qb (airborne)', o: { variant: 1 } },
  { id: 'switch', label: 'switch (slot 2)', o: { variant: 1 } },
  { id: 'switch', label: 'switch (slot 3)', o: { variant: 2 } },
  { id: 'land', label: 'land (soft, 20 %)', o: { intensity: 0.2, gain: 0.44 } },
  { id: 'brake', label: 'brake (slow)', o: { intensity: 0.2, gain: 0.6 } },
  { id: 'damage', label: 'damage (guard bullet)', o: { intensity: 0, gain: 0.8 } },
  { id: 'telegraph-guard', label: 'telegraph-guard (cut to 0.08 s)', o: { duration: 0.08 } },
  { id: 'telegraph-turret', label: 'telegraph-turret (cut to 0.15 s)', o: { duration: 0.15 } },
];

function contourOf(m: Metrics): string {
  if (m.centroidA <= 0 || m.centroidB <= 0) return 'flat';
  const ratio = m.centroidB / m.centroidA;
  return ratio > 1.08 ? 'rising' : ratio < 0.92 ? 'falling' : 'flat';
}

async function table(): Promise<TableRow[]> {
  const rows: TableRow[] = [];
  for (const c of CASES) {
    const def = SOUNDS[c.id];
    const wet = await renderSound(c.id, c.o);
    const dry = await renderDry(c.id, c.o);
    const m = analyse(wet.channels, SR);
    const d = analyse(dry.channels, SR);
    const design = DESIGN[c.id];
    const contour = contourOf(m);
    const problems: string[] = [];
    if (!wet.played) problems.push('refused by the mixer');
    if (!(m.peak > 0.01)) problems.push('silent');
    if (!(m.peak <= CEILING)) problems.push('peak above the ceiling');
    if (!(m.duration <= def.maxSeconds + 0.01)) problems.push(`longer than designed (${def.maxSeconds} s)`);
    if (!(m.duration >= 0.02)) problems.push('too short');
    if (!(Math.abs(m.dc) < 0.002)) problems.push('DC offset');
    if (m.centroid < design.centroid[0] || m.centroid > design.centroid[1]) problems.push('centroid outside the design range');
    if (design.contour && contour !== design.contour) problems.push(`contour ${contour}, designed ${design.contour}`);
    // every sound must keep a usable part above 200 Hz (small speakers reproduce nothing below)
    if (m.above200Db < (design.rumble ? -14 : -9)) problems.push('almost only bass (< 200 Hz)');
    rows.push({
      sound: c.label ?? c.id,
      category: def.category,
      designedMaxS: def.maxSeconds,
      durationS: r(m.duration),
      dryPeak: r(d.peak),
      peak: r(m.peak),
      rmsDb: r(m.rmsDb, 1),
      loudDb: r(m.loudnessDb, 1),
      dryLoudDb: r(d.loudnessDb, 1),
      dcOffset: r(m.dc, 5),
      centroidHz: Math.round(m.centroid),
      designHz: `${design.centroid[0]}-${design.centroid[1]}`,
      contour: `${contour} (${Math.round(m.centroidA)}→${Math.round(m.centroidB)})`,
      designContour: design.contour ?? '-',
      band: m.band,
      peakHz: Math.round(m.peakFreq),
      above200HzDb: r(m.above200Db, 1),
      ok: problems.length === 0,
      problems: problems.join('; '),
    });
  }
  return rows;
}

interface PairRow extends Record<keyof Difference, number> {
  a: string;
  b: string;
  why: string;
  contourA: string;
  contourB: string;
  distinct: boolean;
  expectedDistinct: boolean;
  ok: boolean;
}

const PAIRS: Array<[SoundId, SoundId, string]> = [
  ['mg', 'beam', 'player weapons'],
  ['mg', 'missile-launch', 'player weapons'],
  ['beam', 'missile-launch', 'player weapons'],
  ['telegraph-guard', 'telegraph-turret', 'which enemy is about to fire'],
  ['shot-guard', 'shot-turret', 'which enemy fired'],
  ['telegraph-guard', 'shot-guard', 'warning vs shot'],
  ['telegraph-turret', 'shot-turret', 'warning vs shot'],
  ['mg', 'shot-guard', 'own fire vs enemy fire'],
  ['mg', 'shot-turret', 'own fire vs enemy fire'],
  ['beam', 'shot-guard', 'own fire vs enemy fire'],
  ['hit-enemy', 'hit-world', 'hit vs miss'],
  ['hit-enemy', 'damage', 'dealing vs taking damage'],
  ['hit-enemy', 'bullet-world', 'own hit vs near miss'],
  ['beam-hit-enemy', 'beam-hit-world', 'hit vs miss'],
  ['explode-guard', 'explode-control', 'ordinary kill vs control turret'],
  ['explode-missile', 'explode-control', 'missile impact vs control turret'],
  ['lock-on', 'lock-lost', 'lock state'],
  ['lock-on', 'telegraph-guard', 'own lock vs enemy warning'],
  ['lock-on', 'hit-enemy', 'lock vs hit'],
  ['lock-on', 'reject-nolock', 'lock complete vs "no lock"'],
  ['lock-on', 'telegraph-turret', 'own lock vs enemy warning'],
  ['lock-on', 'ui-click', 'lock vs menu'],
  ['alert', 'telegraph-turret', 'noticed vs about to fire'],
  ['reject-nolock', 'reject-noen', 'why the shot was refused'],
  ['reject-nolock', 'reject-noammo', 'why the shot was refused'],
  ['reject-noen', 'reject-noammo', 'why the shot was refused'],
  ['qb', 'qb-reject', 'boost vs refused boost'],
  ['qb', 'jump', 'movement'],
  ['jump', 'land', 'movement'],
  ['glide-on', 'glide-off', 'glide toggle'],
  ['low-hp', 'en-low', 'which resource is low'],
  ['low-hp', 'lock-on', 'warning vs confirmation'],
  ['barrier-open', 'gate-open', 'progress'],
  ['cleared', 'failed', 'outcome'],
  ['ui-pause', 'ui-resume', 'menu'],
  ['ui-click', 'ui-error', 'menu'],
];

async function pairs(): Promise<PairRow[]> {
  const cache = new Map<string, { mono: Float32Array; m: Metrics }>();
  const get = async (id: SoundId, seed: number): Promise<{ mono: Float32Array; m: Metrics }> => {
    const key = id + ':' + seed;
    let v = cache.get(key);
    if (!v) {
      const wet = await renderSound(id, { seed });
      v = { mono: monoMix(wet.channels), m: analyse(wet.channels, SR) };
      cache.set(key, v);
    }
    return v;
  };
  const rows: PairRow[] = [];
  const compare = async (a: SoundId, b: SoundId, why: string, seedB: number, expectedDistinct: boolean): Promise<void> => {
    const A = await get(a, 0x5eed1234);
    const B = await get(b, seedB);
    const d = difference(A.mono, B.mono, SR, A.m, B.m);
    const ca = contourOf(A.m);
    const cb = contourOf(B.m);
    const distinct = d.spectralDb >= 6 || d.centroidRatio >= 1.4 || d.durationRatio >= 1.8 || (ca !== cb && ca !== 'flat' && cb !== 'flat');
    rows.push({
      a,
      b: a === b ? b + ' (another take)' : b,
      why,
      spectralCosine: r(d.spectralCosine),
      spectralDb: r(d.spectralDb, 1),
      envelopeCorr: r(d.envelopeCorr),
      centroidRatio: r(d.centroidRatio, 2),
      durationRatio: r(d.durationRatio, 2),
      waveCorr: r(d.waveCorr),
      contourA: ca,
      contourB: cb,
      distinct,
      expectedDistinct,
      ok: distinct === expectedDistinct,
    });
  };
  for (const [a, b, why] of PAIRS) await compare(a, b, why, 0x5eed1234, true);
  // control group: two takes of the SAME sound (different random variation) must NOT count as distinct
  for (const id of ['mg', 'shot-guard', 'shot-turret', 'telegraph-guard', 'telegraph-turret', 'hit-enemy', 'explode-guard'] as SoundId[]) {
    await compare(id, id, 'same sound, other variation (control)', 0x0badf00d, false);
  }
  return rows;
}

interface SpatialRow {
  sound: string;
  where: string;
  balanceDb: number;
  peak: number;
  levelDb: number;
  centroidHz: number;
}

async function spatial(): Promise<{ rows: SpatialRow[]; checks: Record<string, boolean> }> {
  const rows: SpatialRow[] = [];
  const places: Array<[string, { x: number; y: number; z: number }, number]> = [
    ['ahead 30 m', { x: 0, y: 0, z: -30 }, 0],
    ['right 30 m', { x: 30, y: 0, z: 0 }, 0],
    ['left 30 m', { x: -30, y: 0, z: 0 }, 0],
    ['behind 30 m', { x: 0, y: 0, z: 30 }, 0],
    ['ahead-right 45°, 30 m', { x: 21.2, y: 0, z: -21.2 }, 0],
    ['ahead 10 m', { x: 0, y: 0, z: -10 }, 0],
    ['ahead 60 m', { x: 0, y: 0, z: -60 }, 0],
    ['ahead 90 m', { x: 0, y: 0, z: -90 }, 0],
    ['ahead 120 m', { x: 0, y: 0, z: -120 }, 0],
    ['ahead 220 m', { x: 0, y: 0, z: -220 }, 0],
    ['-Z 30 m, camera yaw +90° (looking -X)', { x: 0, y: 0, z: -30 }, Math.PI / 2],
    ['-Z 30 m, camera yaw -90° (looking +X)', { x: 0, y: 0, z: -30 }, -Math.PI / 2],
  ];
  const by: Record<string, Record<string, SpatialRow>> = {};
  for (const id of ['telegraph-guard', 'telegraph-turret', 'shot-guard', 'shot-turret', 'damage', 'explode-guard', 'hit-enemy'] as SoundId[]) {
    by[id] = {};
    for (const [where, pos, yaw] of places) {
      const wet = await renderSound(id, { pos, listener: { x: 0, y: 0, z: 0, yaw } });
      const m = analyse(wet.channels, SR);
      const row = { sound: id, where, balanceDb: r(m.balanceDb, 1), peak: r(m.peak), levelDb: r(m.rmsDb, 1), centroidHz: Math.round(m.centroid) };
      rows.push(row);
      by[id][where] = row;
    }
  }
  const t = by['telegraph-guard'];
  const s = by['shot-turret'];
  const checks: Record<string, boolean> = {
    'right source is louder on the right channel': t['right 30 m'].balanceDb > 6,
    'left source is louder on the left channel': t['left 30 m'].balanceDb < -6,
    'source ahead is centred': Math.abs(t['ahead 30 m'].balanceDb) < 0.2,
    'source behind is centred': Math.abs(s['behind 30 m'].balanceDb) < 0.2 && Math.abs(t['behind 30 m'].balanceDb) < 0.2,
    'bright sources behind are duller (hit tick, guard shot)': by['hit-enemy']['behind 30 m'].centroidHz < by['hit-enemy']['ahead 30 m'].centroidHz * 0.9 && by['shot-guard']['behind 30 m'].centroidHz < by['shot-guard']['ahead 30 m'].centroidHz * 0.95,
    'a telegraph behind the camera is not quieter than one ahead': t['behind 30 m'].peak >= t['ahead 30 m'].peak * 0.9 && by['telegraph-turret']['behind 30 m'].peak >= by['telegraph-turret']['ahead 30 m'].peak * 0.9,
    'camera yaw +90°: a -Z source moves to the right': t['-Z 30 m, camera yaw +90° (looking -X)'].balanceDb > 6,
    'camera yaw -90°: a -Z source moves to the left': t['-Z 30 m, camera yaw -90° (looking +X)'].balanceDb < -6,
    'enemy shots get quieter with distance': s['ahead 10 m'].peak > s['ahead 60 m'].peak && s['ahead 60 m'].peak > s['ahead 120 m'].peak,
    'enemy shots are inaudible far outside the fight (220 m)': s['ahead 220 m'].peak === 0,
    'a telegraph at the maximum turret range (120 m) is still clearly audible': by['telegraph-turret']['ahead 120 m'].peak > 0.08,
    'damage is panned but not attenuated': by.damage['right 30 m'].balanceDb > 6 && Math.abs(by.damage['ahead 120 m'].peak - by.damage['ahead 10 m'].peak) < 0.05,
    'no channel is ever silent for a warning (both ears)': rows.filter((x) => x.sound.startsWith('telegraph') && x.peak > 0).every((x) => Math.abs(x.balanceDb) < 30),
  };
  return { rows, checks };
}

async function master(): Promise<Record<string, number | boolean>> {
  // 1. low level: both paths are linear with gain POST_GAIN (game bus: the compressor's own make-up gain is
  //    cancelled by the trim; menu bus: goes around the compressor)
  const quiet = await renderSound('low-hp', { gain: 0.02 });
  const quietDry = await renderDry('low-hp', { gain: 0.02 });
  const lowGain = analyse(quiet.channels, SR).rms / analyse(quietDry.channels, SR).rms;
  const uiGain = analyse((await renderSound('ui-pause', { gain: 0.02 })).channels, SR).rms / analyse((await renderDry('ui-pause', { gain: 0.02 })).channels, SR).rms;
  // 2. overload: every sound at once, each 8x too loud
  const ctx = new OfflineAudioContext(2, SR * 3, SR);
  const mixer = new Mixer(ctx, { volume: 1 });
  let started = 0;
  for (const id of SOUND_IDS) if (mixer.play(id, { gain: 8, delay: SETTLE })) started++;
  const hot = await ctx.startRendering();
  const hotPeak = analyse([hot.getChannelData(0), hot.getChannelData(1)], SR).peak;
  // 3. volume and mute
  const full = analyse((await renderSound('explode-guard')).channels, SR).peak;
  const half = analyse((await renderSound('explode-guard', { volume: 0.5 })).channels, SR).peak;
  const mutedCtx = new OfflineAudioContext(2, SR, SR);
  const mutedMixer = new Mixer(mutedCtx, { volume: 1, muted: true });
  const mutedPlayed = mutedMixer.play('explode-guard', { delay: SETTLE });
  const mutedPeak = analyse([(await mutedCtx.startRendering()).getChannelData(0)], SR).peak;
  // 4. the start-up dip of the compressor: the same quiet sounds at the very start of a context
  const startGain = async (id: SoundId): Promise<number> => {
    const c = new OfflineAudioContext(2, SR, SR);
    new Mixer(c, { volume: 1 }).play(id, { gain: 0.02 });
    const b = await c.startRendering();
    return analyse([b.getChannelData(0), b.getChannelData(1)], SR).rms / analyse((await renderDry(id, { gain: 0.02 })).channels, SR).rms;
  };
  const earlyGain = await startGain('low-hp');
  const earlyUiGain = await startGain('ui-pause');
  return {
    compressorMakeupPredicted: r(compressorMakeup(COMPRESSOR.threshold, COMPRESSOR.knee, COMPRESSOR.ratio), 4),
    lowLevelGainGameBus: r(lowGain, 4),
    lowLevelGainMenuBus: r(uiGain, 4),
    lowLevelGainDesigned: POST_GAIN,
    lowLevelGainOk: Math.abs(lowGain / POST_GAIN - 1) < 0.03 && Math.abs(uiGain / POST_GAIN - 1) < 0.01,
    gameBusGainInTheFirst400msOfAContext: r(earlyGain, 3),
    menuBusGainInTheFirst200msOfAContext: r(earlyUiGain, 3),
    menuBusHasNoStartUpDip: Math.abs(earlyUiGain / POST_GAIN - 1) < 0.01,
    overloadVoices: started,
    overloadPeak: r(hotPeak, 4),
    ceiling: CEILING,
    overloadOk: hotPeak <= CEILING && hotPeak > 0.8,
    volumeHalfRatio: r(half / full, 4),
    volumeOk: Math.abs(half / full - 0.25) < 0.01,
    mutedPlayed,
    mutedPeak,
    mutedOk: !mutedPlayed && mutedPeak === 0,
  };
}

function simView(): {
  time: number;
  status: string;
  camera: { pos: { x: number; y: number; z: number }; yaw: number };
  player: { pos: { x: number; y: number; z: number }; vel: { x: number; y: number; z: number }; yaw: number; hp: number; en: number; horizontalMode: string; flying: boolean; braking: boolean };
  lock: { state: string; targetId: string | null };
  enemyById: Map<string, { pos: { x: number; y: number; z: number }; kind: string; alive: boolean }>;
} {
  const v = sampleView();
  return {
    time: 1,
    status: 'playing',
    camera: { pos: { x: 0, y: 6.5, z: 9.5 }, yaw: 0 },
    player: { pos: { x: 0, y: 2, z: 0 }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, hp: PLAYER.maxHp, en: 120, horizontalMode: 'walk', flying: false, braking: false },
    lock: { state: 'none', targetId: null },
    enemyById: v.enemyById as Map<string, { pos: { x: number; y: number; z: number }; kind: string; alive: boolean }>,
  };
}

async function loops(): Promise<{ segments: Array<Record<string, number | string>>; checks: Record<string, boolean> }> {
  // script (seconds): walk | glide 5 | glide 22 | glide 50 | boost 80 | walk | fly | glide+fly | walk
  const script: Array<[number, string, number, boolean, string]> = [
    [1, 'walk', 10, false, 'walking 10 m/s (no glide)'],
    [2, 'glide', 5, false, 'glide 5 m/s'],
    [2, 'glide', 22, false, 'glide 22 m/s'],
    [2, 'glide', 50, false, 'glide 50 m/s'],
    [2, 'quickboost', 80, false, 'quick boost 80 m/s'],
    [2, 'walk', 0, false, 'stopped (after the fade)'],
    [2, 'walk', 0, true, 'flying (thrust)'],
    [2, 'glide', 16, true, 'flying + air glide 16 m/s'],
    [2, 'walk', 0, false, 'stopped (after the fade)'],
  ];
  const total = script.reduce((a, s) => a + s[0], 0);
  const view = simView();
  const run = await runEngineOffline(total, (engine, _i, t) => {
    let acc = 0;
    for (const [len, mode, speed, flying] of script) {
      acc += len;
      if (t < acc) {
        view.player.horizontalMode = mode;
        view.player.vel.x = speed;
        view.player.flying = flying;
        break;
      }
    }
    view.time = 1 + t;
    engine.update(view, STEP, true);
  });
  const mono = monoMix(run.out);
  const segments: Array<Record<string, number | string>> = [];
  let acc = 0;
  const stat: Array<{ rms: number; centroid: number; step: number; edgeStep: number; peak: number }> = [];
  for (const [len, , , , label] of script) {
    // steady part: skip the first 0.7 s of each segment (fades)
    const from = acc + 0.7;
    const to = acc + len - 0.05;
    const lv = levelBetween(mono, SR, from, to);
    const seg = mono.subarray(Math.floor(from * SR), Math.floor(to * SR));
    const m = analyse([seg], SR);
    const step = maxStep(mono, SR, from, to);
    const edgeStep = maxStep(mono, SR, acc - 0.02, acc + 0.7);
    stat.push({ rms: lv.rms, centroid: m.centroid, step, edgeStep, peak: lv.peak });
    segments.push({
      segment: label,
      from: r(acc, 1),
      rmsDb: lv.rms > 0 ? r(20 * Math.log10(lv.rms), 1) : '-inf',
      peak: r(lv.peak, 4),
      centroidHz: Math.round(m.centroid),
      maxSampleStepSteady: r(step, 4),
      maxSampleStepAtTransition: r(edgeStep, 4),
    });
    acc += len;
  }
  const worstSteady = Math.max(...stat.map((s) => s.step));
  const info = run.engine.getDebugInfo();
  return {
    segments,
    checks: {
      'silent while walking (not gliding)': stat[0].peak === 0,
      'glide level rises with speed (5 < 22 m/s)': stat[1].rms < stat[2].rms,
      'glide brightness rises with speed (5 < 22 < 50 < 80 m/s)': stat[1].centroid < stat[2].centroid && stat[2].centroid < stat[3].centroid && stat[3].centroid < stat[4].centroid,
      'exactly silent again after the glide stops': stat[5].peak === 0,
      'thrust loop audible while flying': stat[6].rms > 0.01,
      'thrust + glide together louder than thrust alone': stat[7].rms > stat[6].rms,
      'exactly silent after flight ends': stat[8].peak === 0,
      'no click at any fade (largest sample step at a transition <= largest in steady sound)': stat.every((s) => s.edgeStep <= worstSteady * 1.05),
      'loops stay in the background (peak < 0.25, RMS < -22 dBFS)': stat.every((s) => s.peak < 0.25 && s.rms < 0.079),
      'no engine error': info.errors === 0,
      'all loop nodes released at the end': info.liveNodes === 0 && info.activeVoices === 0,
    },
  };
}

async function pause(): Promise<Record<string, number | boolean | string | null>> {
  const view = simView();
  view.player.horizontalMode = 'glide';
  view.player.vel.x = 40;
  view.player.flying = true;
  const PAUSE_AT = 0.608; // frame 38
  const UI_AT = 1.008; // frame 63
  const RESUME_AT = 1.504; // frame 94
  const run = await runEngineOffline(2.2, (engine, _i, t) => {
    view.time = 1 + t;
    if (Math.abs(t - 0.096) < 1e-6) {
      engine.handleEvents(
        [
          { type: 'barrier-opened', barrierId: 'B1', controlEnemyId: 'T01' },
          { type: 'enemy-destroyed', enemyId: 'T01', kind: 'turret', pos: { x: 0, y: 2, z: -30 }, isGateControl: true },
          { type: 'player-shot', weapon: 'missile', muzzle: { x: 0, y: 0, z: 0 }, dir: { x: 0, y: 0, z: -1 }, projectileId: 1, locked: true },
          { type: 'gate-opened' },
        ],
        view,
      );
    }
    const paused = t >= PAUSE_AT - 1e-6 && t < RESUME_AT - 1e-6;
    if (Math.abs(t - UI_AT) < 1e-6) engine.playUi('pause');
    if (Math.abs(t - RESUME_AT) < 1e-6) engine.handleEvents([{ type: 'jump' }], view);
    engine.update(view, STEP, !paused);
  });
  const mono = monoMix(run.out);
  const before = levelBetween(mono, SR, 0.3, PAUSE_AT);
  const at150 = levelBetween(mono, SR, PAUSE_AT + 0.15, UI_AT);
  const at100 = levelBetween(mono, SR, PAUSE_AT + 0.1, PAUSE_AT + 0.15);
  const uiPart = levelBetween(mono, SR, UI_AT, UI_AT + 0.3);
  const resumed = levelBetween(mono, SR, RESUME_AT + 0.05, RESUME_AT + 0.5);
  // when is the output last non-zero after the pause?
  let lastNonZero = PAUSE_AT;
  for (let i = Math.floor(PAUSE_AT * SR); i < Math.floor(UI_AT * SR); i++) if (mono[i] !== 0) lastNonZero = i / SR;
  const stepBefore = maxStep(mono, SR, 0.3, PAUSE_AT);
  const stepFade = maxStep(mono, SR, PAUSE_AT, PAUSE_AT + 0.15);
  const info = run.engine.getDebugInfo();
  return {
    peakBeforePause: r(before.peak),
    rmsBeforePause: r(before.rms),
    peak100to150msAfterPause: at100.peak,
    peakFrom150msAfterPause: at150.peak,
    silentAfterMs: r((lastNonZero - PAUSE_AT) * 1000, 1),
    silentWithin150ms: at150.peak === 0 && lastNonZero - PAUSE_AT <= 0.15,
    maxSampleStepBeforePause: r(stepBefore, 4),
    maxSampleStepDuringFade: r(stepFade, 4),
    fadeHasNoClick: stepFade <= stepBefore * 1.05,
    menuSoundAudibleWhilePaused: uiPart.peak > 0.02,
    audibleAfterResume: resumed.peak > 0.02,
    errors: info.errors,
    lastError: info.lastError,
  };
}

interface MixStats {
  seconds: number;
  peak: number;
  rmsDb: number;
  crestDb: number;
  preMasterPeak: number;
  preMasterRmsDb: number;
  /** Share of samples above the linear range of the soft clipper (it is bending the waveform there). */
  shareAboveKnee: number;
  shareAbove090: number;
  samplesAtCeiling: number;
  dcOffset: number;
  loudestSecondRmsDb: number;
  quietestSecondRmsDb: number;
  maxVoices: number;
  voiceCap: number;
  maxLiveNodes: number;
  started: number;
  dropped: number;
  stolen: number;
  errors: number;
  lastError: string | null;
  finalVoices: number;
  finalNodes: number;
  /** "started/dropped/stolen" per category. */
  categories: Record<string, string>;
}

function mixStats(run: EngineRun, fightSeconds = Infinity): MixStats {
  const n = run.out[0].length;
  let peak = 0;
  let sq = 0;
  let sum = 0;
  let above = 0;
  let above90 = 0;
  let atCeil = 0;
  for (const c of run.out) {
    for (let i = 0; i < n; i++) {
      const a = Math.abs(c[i]);
      if (a > peak) peak = a;
      if (a > CLIP_KNEE) above++;
      if (a > 0.9) above90++;
      if (a >= CEILING) atCeil++;
      sq += a * a;
      sum += c[i];
    }
  }
  const rms = Math.sqrt(sq / (2 * n));
  let prePeak = 0;
  let preSq = 0;
  for (const c of run.pre) {
    for (let i = 0; i < n; i++) {
      const a = Math.abs(c[i]);
      if (a > prePeak) prePeak = a;
      preSq += a * a;
    }
  }
  const mono = monoMix(run.out);
  let loud = -Infinity;
  let quiet = Infinity;
  for (let s = 1; s + 1 <= Math.min(n / SR, fightSeconds); s++) {
    const lv = levelBetween(mono, SR, s, s + 1).rms;
    if (lv > loud) loud = lv;
    if (lv < quiet) quiet = lv;
  }
  const info = run.engine.getDebugInfo();
  const db = (x: number): number => r(20 * Math.log10(x), 1);
  return {
    seconds: r(n / SR, 2),
    peak: r(peak, 4),
    rmsDb: db(rms),
    crestDb: r(20 * Math.log10(peak / rms), 1),
    preMasterPeak: r(prePeak, 3),
    preMasterRmsDb: db(Math.sqrt(preSq / (2 * n))),
    shareAboveKnee: r(above / (2 * n), 6),
    shareAbove090: r(above90 / (2 * n), 6),
    samplesAtCeiling: atCeil,
    dcOffset: r(sum / (2 * n), 6),
    loudestSecondRmsDb: db(loud),
    quietestSecondRmsDb: db(quiet),
    maxVoices: run.maxVoices,
    voiceCap: VOICE_CAP,
    maxLiveNodes: run.maxNodes,
    started: info.started,
    dropped: info.dropped,
    stolen: info.stolen,
    errors: info.errors,
    lastError: info.lastError,
    finalVoices: info.activeVoices,
    finalNodes: info.liveNodes,
    categories: Object.fromEntries(Object.entries(info.byCategory).map(([k, v]) => [k, `${v.started}/${v.dropped}/${v.stolen}`])),
  };
}

/** The synthetic heavy fight through the real engine, rendered offline. */
async function stressOffline(seconds = 60, guards = 10, turrets = 5): Promise<MixStats & { events: Record<string, number> }> {
  const fight = new SyntheticFight({ guards, turrets });
  const tail = 4;
  const run = await runEngineOffline(seconds + tail, (engine, _i, t) => {
    if (t < seconds) {
      engine.handleEvents(fight.step(STEP), fight.view);
      engine.update(fight.view, STEP, true);
    } else {
      // the fight is over: loops fade, the remaining voices ring out, then the count must be 0
      fight.view.status = 'cleared';
      engine.update(fight.view, STEP, false);
    }
  });
  return { ...mixStats(run, seconds), events: fight.counts };
}

/**
 * Rhythm of sustained fire. The weapon fires on its exact interval in simulation time, but the events reach
 * the engine once per 16 ms frame. Measures the onsets actually present in the rendered audio.
 */
async function rhythm(): Promise<Array<Record<string, number | string | boolean>>> {
  const rows: Array<Record<string, number | string | boolean>> = [];
  for (const [weapon, interval] of [
    ['machinegun', 0.1],
    ['beam', 0.25],
  ] as const) {
    const seconds = 4;
    let next = 0.35;
    const frameIntervals: number[] = [];
    const shotTimes: number[] = [];
    let lastFrameTime = -1;
    const run = await runEngineOffline(seconds, (engine, _i, t) => {
      const events: SimEvent[] = [];
      while (next <= t && next < seconds - 0.4) {
        events.push({ type: 'player-shot', weapon, muzzle: { x: 0, y: 0, z: 0 }, dir: { x: 0, y: 0, z: -1 }, projectileId: null, locked: false });
        shotTimes.push(next);
        next += interval;
        if (lastFrameTime >= 0) frameIntervals.push(t - lastFrameTime);
        lastFrameTime = t;
      }
      engine.handleEvents(events, null);
      engine.update(simView(), STEP, true);
    });
    const mono = monoMix(run.out);
    const pre = monoMix(run.pre);
    let peak = 0;
    for (let i = 0; i < mono.length; i++) if (Math.abs(mono[i]) > peak) peak = Math.abs(mono[i]);
    // onsets: the first sample above 15 % of the peak after at least 30 % of the interval below that level
    const onsets: number[] = [];
    let lastLoud = -1e9;
    for (let i = 0; i < mono.length; i++) {
      if (Math.abs(mono[i]) > 0.15 * peak) {
        if (i - lastLoud > interval * 0.3 * SR) onsets.push(i / SR);
        lastLoud = i;
      }
    }
    const gaps = onsets.slice(1).map((o, i) => o - onsets[i]);
    const steady = gaps.slice(3); // after the first shots the grid has settled
    const stat = (xs: number[]): { mean: number; sd: number; min: number; max: number } => {
      const mean = xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
      const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / Math.max(1, xs.length));
      return { mean, sd, min: Math.min(...xs), max: Math.max(...xs) };
    };
    const g = stat(steady);
    const f = stat(frameIntervals.slice(3));
    const from = 0.4;
    const to = seconds - 0.5;
    const post = levelBetween(mono, SR, from, to);
    const dry = levelBetween(pre, SR, from, to);
    rows.push({
      weapon,
      shots: onsets.length,
      fireIntervalMs: interval * 1000,
      eventIntervalMsAsDelivered: `${r(f.min * 1000, 1)}…${r(f.max * 1000, 1)}`,
      audioIntervalMsMean: r(g.mean * 1000, 2),
      audioIntervalMsMin: r(g.min * 1000, 2),
      audioIntervalMsMax: r(g.max * 1000, 2),
      audioIntervalSdMs: r(g.sd * 1000, 3),
      // (the grid creeps by 0.5 % per shot and the onset of a noise burst scatters by a fraction of a millisecond)
      evenRhythm: g.max - g.min < 0.006 && Math.abs(g.mean - interval) < 0.0005,
      // sound onset minus the simulation time of the shot, in the settled part (includes the 16 ms frame
      // quantisation of the events and the 6 ms look-ahead of the compressor)
      lagMsMean: r(stat(onsets.slice(4).map((o, k) => o - shotTimes[k + 4])).mean * 1000, 1),
      lagMsMax: r(stat(onsets.slice(4).map((o, k) => o - shotTimes[k + 4])).max * 1000, 1),
      peak: r(post.peak, 3),
      rmsDb: r(20 * Math.log10(post.rms), 1),
      gainVsDryDb: r(20 * Math.log10(post.rms / dry.rms), 2),
      notCompressed: Math.abs(post.rms / dry.rms / POST_GAIN - 1) < 0.06,
      errors: run.engine.getDebugInfo().errors,
    });
  }
  return rows;
}

/** Worst single frame: 15 enemies telegraph and fire in the SAME frame while everything else happens too. */
async function burst(): Promise<MixStats> {
  const fight = new SyntheticFight();
  const view = fight.view;
  const enemies = [...view.enemyById.values()];
  const run = await runEngineOffline(6.5, (engine, i) => {
    const events: SimEvent[] = [];
    if (i % 12 === 6 && i < 190) {
      // every 192 ms: all 15 enemies at once + own fire + kills + damage + boost
      for (const e of enemies) {
        events.push({ type: 'enemy-telegraph', enemyId: e.id, duration: e.kind === 'guard' ? 0.15 : 0.35 });
        events.push({ type: 'enemy-shot', enemyId: e.id, kind: e.kind, muzzle: { ...e.pos }, dir: { x: 0, y: 0, z: 1 } });
      }
      events.push({ type: 'player-shot', weapon: 'machinegun', muzzle: { x: 0, y: 0, z: 0 }, dir: { x: 0, y: 0, z: -1 }, projectileId: i, locked: true });
      events.push({ type: 'player-shot', weapon: 'missile', muzzle: { x: 0, y: 0, z: 0 }, dir: { x: 0, y: 0, z: -1 }, projectileId: i, locked: true });
      events.push({ type: 'projectile-hit', kind: 'missile', pos: { x: 0, y: 2, z: -15 }, target: 'enemy', enemyId: 'G01' });
      events.push({ type: 'enemy-destroyed', enemyId: 'T11', kind: 'turret', pos: { x: 5, y: 2, z: -12 }, isGateControl: true });
      events.push({ type: 'enemy-destroyed', enemyId: 'G01', kind: 'guard', pos: { x: -5, y: 2, z: -10 }, isGateControl: false });
      events.push({ type: 'player-damaged', amount: 40, sourcePos: { x: 30, y: 2, z: 0 }, fromEnemyId: 'T11' });
      events.push({ type: 'player-damaged', amount: 18, sourcePos: { x: -30, y: 2, z: 0 }, fromEnemyId: 'G01' });
      events.push({ type: 'qb', dir: { x: 1, z: 0 }, airborne: false });
      events.push({ type: 'barrier-opened', barrierId: 'B1', controlEnemyId: 'T11' });
    }
    view.time = 1 + i * STEP;
    view.player.horizontalMode = 'quickboost';
    view.player.vel.x = 80;
    view.player.flying = true;
    if (i < 190) {
      engine.handleEvents(events, view);
      engine.update(view, STEP, true);
    } else {
      view.status = 'cleared';
      engine.update(view, STEP, false);
    }
  });
  return mixStats(run);
}

/** A real Sim fight (autopilot through sim.input) through the engine, rendered offline. */
async function fightOffline(mode: FightMode, maxSeconds = 40): Promise<MixStats & { status: string; simSeconds: number; endedAtSeconds: number; events: Record<string, number>; unhandled: string[]; neverSeen: string[] }> {
  const fight = new RealFight(mode);
  let endedAt = -1;
  const run = await runEngineOffline(maxSeconds, (engine, _i, t) => {
    if (!fight.finished) {
      const events = fight.step(STEP);
      engine.handleEvents(events, fight.sim);
      engine.update(fight.sim, STEP, !fight.finished);
      if (fight.finished) endedAt = t;
    } else {
      engine.update(fight.sim, STEP, false);
    }
  });
  const types = Object.keys(EVENT_SOUNDS);
  return {
    ...mixStats(run),
    status: fight.sim.status,
    simSeconds: r(fight.sim.time, 2),
    events: fight.counts,
    unhandled: Object.keys(fight.counts).filter((t) => !types.includes(t)),
    neverSeen: types.filter((t) => !fight.counts[t]),
    endedAtSeconds: r(endedAt, 2),
  };
}

// ═══════════════════════════ the live engine and the page ═══════════════════════════

const engine = new AudioEngine();
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const num = (id: string): number => Number(($(id) as HTMLInputElement).value);
const checked = (id: string): boolean => ($(id) as HTMLInputElement).checked;

const view = simView();
let analyser: AnalyserNode | null = null;
let scope: Float32Array<ArrayBuffer> | null = null;
let livePeak = 0;
let liveSilentFrames = 0;
let runPeak = 0;

interface Runner {
  label: string;
  step(dt: number): { events: SimEvent[]; sim: AudioSimView; playing: boolean; done: boolean };
}
let runner: Runner | null = null;
let runStats = { frames: 0, maxVoices: 0, maxNodes: 0, events: 0, engineMs: 0, engineMsMax: 0 };

function attachMeter(): void {
  const mixer = engine.getMixer();
  if (!mixer || analyser) return;
  const ctx = mixer.ctx;
  analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  mixer.output.connect(analyser);
  scope = new Float32Array(analyser.fftSize);
}

function sourcePosition(): { x: number; y: number; z: number } | null {
  if (!checked('spatial')) return null;
  // azimuth is relative to the camera: 0° ahead, +90° to the right
  const yaw = view.camera.yaw;
  const az = (num('azimuth') * Math.PI) / 180;
  const d = num('distance');
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const right = Math.sin(az) * d;
  const front = Math.cos(az) * d;
  return { x: view.camera.pos.x + right * c - front * s, y: view.camera.pos.y, z: view.camera.pos.z - right * s - front * c };
}

function playOptions(): PlayOptions {
  return { pos: sourcePosition(), intensity: num('intensity'), variant: num('variant') };
}

function readState(): void {
  view.camera.yaw = (num('yaw') * Math.PI) / 180;
  view.player.yaw = view.camera.yaw;
  view.player.horizontalMode = checked('glide') ? 'glide' : 'walk';
  view.player.vel.x = num('speed');
  view.player.flying = checked('flying');
  view.player.braking = checked('braking');
  view.player.hp = num('hp');
  view.player.en = num('en');
  view.lock.state = checked('locked') ? 'locked' : 'none';
  view.lock.targetId = checked('locked') ? 'G01' : null;
  const app = ($('app-state') as HTMLSelectElement).value;
  view.status = app === 'ended' ? 'cleared' : 'playing';
}

let lastFrame = performance.now();
function frame(): void {
  const now = performance.now();
  const dt = Math.min(0.25, (now - lastFrame) / 1000);
  lastFrame = now;
  if (runner) {
    const s = runner.step(dt);
    const t0 = performance.now();
    engine.handleEvents(s.events, s.sim);
    engine.update(s.sim, dt, s.playing);
    const spent = performance.now() - t0;
    runStats.engineMs += spent;
    if (spent > runStats.engineMsMax) runStats.engineMsMax = spent;
    runStats.frames++;
    runStats.events += s.events.length;
    if (s.done) runner = null;
  } else {
    readState();
    view.time += dt;
    engine.update(view, dt, ($('app-state') as HTMLSelectElement).value === 'playing');
  }
  const info = engine.getDebugInfo();
  if (info.activeVoices > runStats.maxVoices) runStats.maxVoices = info.activeVoices;
  if (info.liveNodes > runStats.maxNodes) runStats.maxNodes = info.liveNodes;
  if (analyser && scope) {
    analyser.getFloatTimeDomainData(scope);
    let pk = 0;
    for (let i = 0; i < scope.length; i++) if (Math.abs(scope[i]) > pk) pk = Math.abs(scope[i]);
    livePeak = Math.max(pk, livePeak * 0.9);
    if (pk > runPeak) runPeak = pk;
    if (pk === 0) liveSilentFrames++;
    else liveSilentFrames = 0;
  }
  drawStatus(info);
}

function drawStatus(info: ReturnType<AudioEngine['getDebugInfo']>): void {
  const status = $('status');
  const text = `context ${info.state}   voices ${String(info.activeVoices).padStart(2)} / cap ${info.voiceCap}   live nodes ${String(info.liveNodes).padStart(3)}   started ${info.started}  dropped ${info.dropped}  stolen ${info.stolen}   errors ${info.errors}${info.lastError ? ' (' + info.lastError + ')' : ''}${runner ? '   ▶ ' + runner.label : ''}`;
  if (status.firstChild && status.firstChild.nodeType === Node.TEXT_NODE) status.firstChild.textContent = text;
  const canvas = $<HTMLCanvasElement>('meter');
  const g = canvas.getContext('2d');
  if (!g) return;
  g.fillStyle = '#0a0d10';
  g.fillRect(0, 0, canvas.width, canvas.height);
  const w = Math.min(1, livePeak) * canvas.width;
  g.fillStyle = livePeak > 0.9 ? '#e0563f' : livePeak > CLIP_KNEE ? '#e0b23f' : '#4fb37a';
  g.fillRect(0, 0, w, canvas.height);
  g.fillStyle = '#566472';
  g.fillRect(CLIP_KNEE * canvas.width, 0, 1, canvas.height);
  g.fillRect(CEILING * canvas.width, 0, 1, canvas.height);
}

function button(parent: HTMLElement, label: string, note: string, onClick: () => void): void {
  const b = document.createElement('button');
  b.textContent = label;
  if (note) {
    const s = document.createElement('small');
    s.textContent = note;
    b.appendChild(s);
  }
  b.addEventListener('click', () => {
    engine.unlock();
    attachMeter();
    onClick();
  });
  parent.appendChild(b);
}

function buildPage(): void {
  // sounds, grouped by category
  const sounds = $('sounds');
  for (const cat of Object.keys(CATEGORIES)) {
    const ids = SOUND_IDS.filter((id) => SOUNDS[id].category === cat && CATEGORIES[SOUNDS[id].category].bus === 'game');
    if (ids.length === 0) continue;
    const g = document.createElement('div');
    g.className = 'group';
    const name = document.createElement('span');
    name.textContent = cat;
    g.appendChild(name);
    for (const id of ids) {
      button(g, id, SOUNDS[id].rolloff ? '◎' : '', () => {
        const mixer = engine.getMixer();
        if (!mixer) return;
        mixer.setListener(view.camera.pos.x, view.camera.pos.y, view.camera.pos.z, view.camera.yaw);
        if (mixer.gameMode === 'paused') mixer.setGameMode('active');
        mixer.play(id, playOptions());
      });
    }
    sounds.appendChild(g);
  }
  const hint = document.createElement('p');
  hint.className = 'note';
  hint.textContent = '◎ = world sound: uses the position sliders (azimuth relative to the camera, distance). The result jingles are under MENU / EVENTS.';
  sounds.appendChild(hint);

  const ui = $('ui-sounds');
  for (const kind of ['click', 'sortie', 'pause', 'resume', 'error'] as UiSound[]) button(ui, `playUi('${kind}')`, '', () => engine.playUi(kind));

  const events = $('events');
  const samples = sampleEvents();
  for (const type of Object.keys(samples) as Array<SimEvent['type']>) {
    const g = document.createElement('div');
    g.className = 'group';
    const name = document.createElement('span');
    name.textContent = type;
    name.style.width = '130px';
    name.title = EVENT_SOUNDS[type];
    g.appendChild(name);
    samples[type].forEach((e, i) => {
      const { type: _t, ...rest } = e as SimEvent & Record<string, unknown>;
      const brief = Object.entries(rest)
        .filter(([, v]) => typeof v !== 'object' || v === null)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(' ');
      button(g, brief || `#${i + 1}`, '', () => engine.handleEvents([e], { ...view, status: 'playing' }));
    });
    if (EVENT_SOUNDS[type].startsWith('silent')) {
      const s = document.createElement('small');
      s.textContent = ' ' + EVENT_SOUNDS[type];
      s.style.color = '#7f8d99';
      g.appendChild(s);
    }
    events.appendChild(g);
  }

  // sliders
  for (const id of ['volume', 'intensity', 'variant', 'azimuth', 'distance', 'speed', 'hp', 'en', 'yaw']) {
    const input = $(id) as HTMLInputElement;
    const out = $(id + '-out');
    const show = (): void => {
      out.textContent = input.value;
    };
    input.addEventListener('input', show);
    show();
  }
  const volume = $('volume') as HTMLInputElement;
  volume.value = String(engine.volume);
  $('volume-out').textContent = volume.value;
  volume.addEventListener('input', () => engine.setVolume(Number(volume.value)));
  $('muted').addEventListener('change', () => engine.setMuted(checked('muted')));
  $('unlock').addEventListener('click', () => {
    engine.unlock();
    attachMeter();
    engine.playUi('click');
  });
  $('stop').addEventListener('click', () => {
    runner = null;
    engine.stopAll();
  });

  // fights
  const info = $('fight-info');
  const start = (rn: Runner): void => {
    engine.unlock();
    attachMeter();
    engine.stopAll();
    runStats = { frames: 0, maxVoices: 0, maxNodes: 0, events: 0, engineMs: 0, engineMsMax: 0 };
    runner = rn;
    info.textContent = rn.label;
  };
  $('fight-win').addEventListener('click', () => start(realRunner('win', 60)));
  $('fight-lose').addEventListener('click', () => start(realRunner('lose', 60)));
  $('fight-heavy').addEventListener('click', () => start(syntheticRunner(60)));
  $('fight-stop').addEventListener('click', () => {
    runner = null;
    engine.stopAll();
    info.textContent = 'stopped';
  });

  const report = $('report');
  const show = (title: string, rows: Array<Record<string, unknown>>): string => {
    if (rows.length === 0) return title + '\n(nothing)\n';
    const keys = Object.keys(rows[0]);
    const width = keys.map((k) => Math.max(k.length, ...rows.map((row) => String(row[k]).length)));
    const line = (cells: string[]): string => cells.map((c, i) => c.padEnd(width[i])).join('  ');
    return [title, line(keys), ...rows.map((row) => line(keys.map((k) => String(row[k]))))].join('\n') + '\n';
  };
  $('measure').addEventListener('click', () => {
    report.textContent = 'rendering …';
    void (async () => {
      const t = await table();
      const p = await pairs();
      report.textContent = show('EVERY SOUND (offline render through the master chain, volume 1)', t as unknown as Array<Record<string, unknown>>) + '\n' + show('PAIRS THAT MUST DIFFER', p as unknown as Array<Record<string, unknown>>);
    })();
  });
  $('measure-mix').addEventListener('click', () => {
    report.textContent = 'rendering 64 s offline …';
    void stressOffline(60).then((s) => {
      report.textContent = JSON.stringify(s, null, 1);
    });
  });
}

function realRunner(mode: FightMode, maxSeconds: number): Runner {
  const fight = new RealFight(mode);
  let after = 0;
  let clock = 0;
  return {
    label: `real Sim fight (${mode})`,
    step(dt) {
      clock += dt;
      if (!fight.finished && clock < maxSeconds) {
        const events = fight.step(dt, false);
        return { events, sim: fight.sim, playing: !fight.finished, done: false };
      }
      // result: let the last sounds and the jingle ring out for a few seconds, then hand the page back
      after += dt;
      $('fight-info').textContent = `${fight.sim.status} after ${fight.sim.time.toFixed(1)} s — events: ${Object.keys(fight.counts).length} types`;
      const stillPlaying = !fight.finished; // time limit reached: behave like a pause
      return { events: [], sim: fight.sim, playing: false, done: after > (stillPlaying ? 0.3 : 3.5) };
    },
  };
}

function syntheticRunner(seconds: number): Runner {
  const fight = new SyntheticFight();
  let after = 0;
  return {
    label: `synthetic heavy fight (${seconds} s)`,
    step(dt) {
      if (fight.time < seconds) return { events: fight.step(dt), sim: fight.view, playing: true, done: false };
      // over: loops fade, the last voices ring out
      after += dt;
      fight.view.status = 'cleared';
      return { events: [], sim: fight.view, playing: false, done: after > 4 };
    },
  };
}

/** Runs a runner against the LIVE engine in real time and reports what happened. */
async function runLive(rn: Runner, settleSeconds = 3): Promise<Record<string, unknown>> {
  engine.unlock();
  attachMeter();
  engine.stopAll();
  const before = engine.getDebugInfo();
  runStats = { frames: 0, maxVoices: 0, maxNodes: 0, events: 0, engineMs: 0, engineMsMax: 0 };
  runPeak = 0;
  const t0 = performance.now();
  const ctxT0 = engine.getMixer()?.ctx.currentTime ?? 0;
  runner = rn;
  await new Promise<void>((resolve) => {
    const poll = setInterval(() => {
      if (!runner) {
        clearInterval(poll);
        resolve();
      }
    }, 50);
  });
  const fightSeconds = (performance.now() - t0) / 1000;
  const atEnd = engine.getDebugInfo();
  await new Promise((resolve) => setTimeout(resolve, settleSeconds * 1000));
  const after = engine.getDebugInfo();
  const ctx = engine.getMixer()?.ctx;
  return {
    label: rn.label,
    contextState: after.state,
    sampleRate: ctx?.sampleRate,
    wallSeconds: r(fightSeconds, 2),
    audioClockSeconds: r((ctx?.currentTime ?? 0) - ctxT0 - settleSeconds, 2),
    frames: runStats.frames,
    events: runStats.events,
    // main-thread time spent inside handleEvents() + update()
    engineMsPerFrameMean: r(runStats.engineMs / Math.max(1, runStats.frames), 3),
    engineMsPerFrameMax: r(runStats.engineMsMax, 2),
    engineMsPerSecondOfFight: r(runStats.engineMs / Math.max(0.001, fightSeconds), 1),
    started: after.started - before.started,
    dropped: after.dropped - before.dropped,
    stolen: after.stolen - before.stolen,
    maxVoices: runStats.maxVoices,
    voiceCap: VOICE_CAP,
    maxLiveNodes: runStats.maxNodes,
    voicesAtEnd: atEnd.activeVoices,
    voicesAfterSettle: after.activeVoices,
    liveNodesAfterSettle: after.liveNodes,
    outputPeakSeen: r(runPeak, 3),
    errors: after.errors - before.errors,
    lastError: after.lastError,
  };
}

buildPage();
setInterval(frame, 1000 / 60);

const api = {
  engine,
  /** For scripted checks of the autoplay / unlock behaviour with a second, independent engine. */
  AudioEngine,
  sampleEvents,
  sampleView,
  table,
  pairs,
  spatial,
  master,
  loops,
  pause,
  rhythm,
  burst,
  stressOffline,
  fightOffline,
  stressRealtime: (seconds = 60) => runLive(syntheticRunner(seconds)),
  fightRealtime: (mode: FightMode = 'lose', seconds = 30) => runLive(realRunner(mode, seconds)),
  eventSounds: EVENT_SOUNDS,
  info: () => engine.getDebugInfo(),
  silentFrames: () => liveSilentFrames,
};
(window as unknown as { __audio: typeof api }).__audio = api;
